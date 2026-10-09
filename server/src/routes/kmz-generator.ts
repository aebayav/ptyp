// Excel/PDF → otomatik KMZ üretme ve projeye aktarma
import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { pool } from '../db';
import { requireAuth, requireRole } from '../auth';
import { parseExcelCoordinates, parsePdfCoordinates } from '../coord-parser';
import { buildKmz } from '../kmz-builder';
import { routeLengthKm } from '../kmz-parser';
import { importPolesForProject } from '../pole-importer';

const router = Router();

router.use(requireAuth, requireRole('owner'));

const UPLOADS_DIR = path.join(__dirname, '..', '..', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

// Excel/PDF → parse → KMZ üret → (isteğe bağlı) projeye aktar
router.post('/parse', upload.single('file'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Dosya yüklenmedi.' });
    const ext = path.extname(req.file.originalname).toLowerCase();
    if (!['.xlsx', '.xls', '.pdf'].includes(ext)) {
      return res.status(400).json({ error: 'Lütfen Excel (.xlsx/.xls) veya PDF dosyası yükleyin.' });
    }
    const projectId = req.body?.project_id ? Number(req.body.project_id) : null;
    if (projectId != null) {
      const p = await pool.query('SELECT 1 FROM projects WHERE id = $1', [projectId]);
      if (p.rowCount === 0) return res.status(404).json({ error: 'Proje bulunamadı.' });
    }

    let poles;
    try {
      poles = ext === '.pdf'
        ? (await parsePdfCoordinates(req.file.buffer)).poles
        : parseExcelCoordinates(req.file.buffer).poles;
    } catch (e: any) {
      return res.status(400).json({ error: 'Dosya okunamadı: ' + (e.message || 'geçersiz içerik') });
    }

    if (poles.length === 0) {
      return res.status(400).json({
        error: 'Dosyada koordinat bulunamadı. PDF taranmış görüntü olabilir; Excel için enlem/boylam (veya X/Y) sütun başlıkları olmalı.',
      });
    }
    if (poles.length < 2) {
      return res.status(400).json({ error: 'En az 2 direk bulunmalı (güzergah çizgisi için).' });
    }

    // KMZ üret
    const docName = path.basename(req.file.originalname, ext);
    const kmzBuf = buildKmz(poles, docName);
    const kmzFile = `generated-${Date.now()}.kmz`;
    fs.writeFileSync(path.join(UPLOADS_DIR, kmzFile), kmzBuf);

    const poleCoords: [number, number][] = poles.map((p) => [p.lat, p.lon]);
    const connectionKm = routeLengthKm(poleCoords);

    let saved = 0;
    if (projectId != null) {
      const result = await importPolesForProject(projectId, poles, poleCoords, req.file.originalname, poles.length, connectionKm);
      saved = result.saved;
      // Bu dosya asıl yükleme gibi "son KMZ" olarak da saklansın
      try {
        fs.writeFileSync(path.join(UPLOADS_DIR, `latest-p${projectId}.kmz`), kmzBuf);
      } catch { /* kritik değil */ }
    }

    res.json({
      poles: poles.map((p, i) => ({ no: i + 1, name: p.name || `Direk ${i + 1}`, lat: p.lat, lon: p.lon })),
      count: poles.length,
      saved,
      connection_km: connectionKm,
      file_name: req.file.originalname,
      kmz: `/api/kmz-generator/download/${kmzFile}`,
    });
  } catch (e) {
    next(e);
  }
});

// Üretilen KMZ'yi indir
router.get('/download/:file', (req: Request, res: Response) => {
  const file = path.basename(String(req.params.file));
  const p = path.join(UPLOADS_DIR, file);
  if (!file.startsWith('generated-') || !fs.existsSync(p)) {
    return res.status(404).json({ error: 'Dosya bulunamadı.' });
  }
  res.setHeader('Content-Type', 'application/vnd.google-earth.kmz');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file)}`);
  res.sendFile(p);
});

// Mevcut proje güzergahını KMZ olarak indir
router.get('/from-project', async (req: Request, res: Response) => {
  const projectId = Number(req.query.project_id);
  if (!Number.isInteger(projectId) || projectId <= 0) {
    return res.status(400).json({ error: 'Geçerli bir proje seçin (project_id).' });
  }
  const proj = await pool.query('SELECT name FROM projects WHERE id = $1', [projectId]);
  if (proj.rowCount === 0) return res.status(404).json({ error: 'Proje bulunamadı.' });
  const poles = await pool.query(
    'SELECT name, lat, lon FROM poles WHERE project_id = $1 ORDER BY idx',
    [projectId]
  );
  if (poles.rows.length < 2) return res.status(400).json({ error: 'Bu projede güzergah için yeterli direk yok.' });
  const kmzBuf = buildKmz(poles.rows, proj.rows[0].name);
  res.setHeader('Content-Type', 'application/vnd.google-earth.kmz');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename*=UTF-8''${encodeURIComponent('guzergah-' + proj.rows[0].name + '.kmz')}`
  );
  res.send(kmzBuf);
});

export default router;
