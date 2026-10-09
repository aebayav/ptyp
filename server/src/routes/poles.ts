import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { pool } from '../db';
import { requireAuth, requireRole } from '../auth';
import { parseKmz, parseKmlText, routeLengthKm } from '../kmz-parser';

const router = Router();

// Güzergah modülü yalnızca iş sahibine açık
router.use(requireAuth, requireRole('owner'));

const UPLOADS_DIR = path.join(__dirname, '..', '..', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

async function projectExists(id: number): Promise<boolean> {
  const r = await pool.query('SELECT 1 FROM projects WHERE id = $1', [id]);
  return r.rowCount === 1;
}

// Projenin direk listesi + güzergah hattı + bağlantı hattı
router.get('/', async (req: Request, res: Response) => {
  const projectId = Number(req.query.project_id);
  if (!Number.isInteger(projectId) || projectId <= 0) {
    return res.status(400).json({ error: 'Geçerli bir proje seçin (project_id).' });
  }
  const proj = await pool.query('SELECT * FROM projects WHERE id = $1', [projectId]);
  if (proj.rowCount === 0) return res.status(404).json({ error: 'Proje bulunamadı.' });

  const poles = await pool.query(
    'SELECT id, name, lat, lon, alt, idx FROM poles WHERE project_id = $1 ORDER BY idx',
    [projectId]
  );
  const p = proj.rows[0];
  const poleCoords: [number, number][] = poles.rows.map((x: any) => [x.lat, x.lon]);
  res.json({
    project_id: projectId,
    poles: poles.rows,
    route: p.route || null,
    file_name: p.file_name || null,
    uploaded_at: p.uploaded_at || null,
    point_total: p.point_total || poles.rows.length,
    route_km: Array.isArray(p.route) ? routeLengthKm(p.route as [number, number][]) : null,
    connection_km: poleCoords.length >= 2 ? routeLengthKm(poleCoords) : null,
  });
});

// KMZ yükle → parse et → seçili projenin mevcut direklerini değiştir
router.post('/upload', upload.single('file'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const projectId = Number(req.body?.project_id);
    if (!Number.isInteger(projectId) || projectId <= 0) {
      return res.status(400).json({ error: 'Geçerli bir proje seçin.' });
    }
    if (!(await projectExists(projectId))) return res.status(404).json({ error: 'Proje bulunamadı.' });
    if (!req.file) return res.status(400).json({ error: 'KMZ dosyası yüklenmedi.' });
    const ext = path.extname(req.file.originalname).toLowerCase();
    if (ext !== '.kmz' && ext !== '.kml') {
      return res.status(400).json({ error: 'Lütfen KMZ (veya KML) dosyası yükleyin.' });
    }

    let result;
    try {
      result = ext === '.kml' ? parseKmlText(req.file.buffer.toString('utf8')) : parseKmz(req.file.buffer);
    } catch (e: any) {
      return res.status(400).json({ error: 'Dosya okunamadı: ' + (e.message || 'geçersiz KMZ/KML') });
    }

    if (result.poles.length === 0) {
      return res.status(400).json({ error: 'Dosyada koordinatlı nokta bulunamadı.' });
    }

    // Son yüklenen dosyayı analiz/debug için sakla (proje başına son dosya)
    try {
      fs.writeFileSync(path.join(UPLOADS_DIR, `latest-p${projectId}.kmz`), req.file.buffer);
    } catch {
      /* disk hatası kritik değil */
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM poles WHERE project_id = $1', [projectId]);
      for (let i = 0; i < result.poles.length; i++) {
        const po = result.poles[i];
        await client.query(
          'INSERT INTO poles (name, lat, lon, alt, idx, project_id) VALUES ($1, $2, $3, $4, $5, $6)',
          [po.name || `Direk ${i + 1}`, po.lat, po.lon, po.alt, i, projectId]
        );
      }
      await client.query(
        `UPDATE projects SET route = $1, file_name = $2, uploaded_at = $3, point_total = $4 WHERE id = $5`,
        [
          JSON.stringify(result.route || []),
          req.file.originalname,
          new Date().toISOString(),
          result.placemarkCount,
          projectId,
        ]
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    const poleCoords: [number, number][] = result.poles.map((p) => [p.lat, p.lon]);
    res.json({
      saved: result.poles.length,
      point_total: result.placemarkCount,
      route_points: result.route ? result.route.length : 0,
      route_km: result.route ? routeLengthKm(result.route) : null,
      connection_km: poleCoords.length >= 2 ? routeLengthKm(poleCoords) : null,
      file_name: req.file.originalname,
    });
  } catch (e) {
    next(e);
  }
});

// Projenin güzergahını temizle
router.delete('/', async (req: Request, res: Response) => {
  const projectId = Number(req.query.project_id);
  if (!Number.isInteger(projectId) || projectId <= 0) {
    return res.status(400).json({ error: 'Geçerli bir proje seçin (project_id).' });
  }
  await pool.query('DELETE FROM poles WHERE project_id = $1', [projectId]);
  await pool.query(
    'UPDATE projects SET route = NULL, file_name = NULL, uploaded_at = NULL, point_total = NULL WHERE id = $1',
    [projectId]
  );
  res.status(204).end();
});

export default router;
