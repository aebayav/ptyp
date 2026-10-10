// Excel/PDF/TIFF → otomatik KMZ üretme ve projeye aktarma
import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import * as XLSX from 'xlsx';
import { pool } from '../db';
import { requireAuth, requireRole } from '../auth';
import { parseExcelCoordinates, parsePdfText } from '../coord-parser';
import { detectDocumentKind, analyzePdf, isTiff } from '../document-reader';
import { callOcr, OcrCell } from '../ocr-client';
import { buildKmz } from '../kmz-builder';
import { routeLengthKm } from '../kmz-parser';
import { importPolesForProject } from '../pole-importer';
import { PolePoint } from '../kmz-parser';

const router = Router();

router.use(requireAuth, requireRole('owner'));

const UPLOADS_DIR = path.join(__dirname, '..', '..', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

// OCR satırlarından direkleri çıkar; düşük güvenli satırları işaretle
function polesFromOcr(ocr: { pages: { rows: OcrCell[][] }[] }): {
  poles: PolePoint[];
  uncertain: { row: number; text: string }[];
} {
  const lines: string[] = [];
  const uncertain: { row: number; text: string }[] = [];
  let rowNo = 0;
  for (const page of ocr.pages) {
    for (const row of page.rows) {
      rowNo++;
      const text = row.map((c) => c.text).join(' ').trim();
      if (!text) continue;
      lines.push(text);
      const low = row.filter((c) => c.conf != null && c.conf < 0.55 && !c.fallback);
      if (low.length > 0) uncertain.push({ row: rowNo, text });
    }
  }
  const poles = parsePdfText(lines.join('\n')).poles;
  return { poles, uncertain };
}

// Excel/PDF/TIFF → parse → KMZ üret → (isteğe bağlı) projeye aktar
router.post('/parse', upload.single('file'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Dosya yüklenmedi.' });

    const kind = detectDocumentKind(req.file.originalname);
    if (kind === 'unknown') {
      return res.status(400).json({ error: 'Desteklenen biçimler: Excel (.xlsx/.xls), PDF, TIFF (.tif/.tiff).' });
    }
    // Uzantı hatalı olsa bile TIFF sihirli baytını doğrula
    if (kind !== 'tiff' && isTiff(req.file.buffer)) {
      return res.status(400).json({ error: 'Bu dosya bir TIFF görüntüsü. Doğru uzantıyla (.tif/.tiff) yükleyin.' });
    }

    const projectId = req.body?.project_id ? Number(req.body.project_id) : null;
    if (projectId != null) {
      const p = await pool.query('SELECT 1 FROM projects WHERE id = $1', [projectId]);
      if (p.rowCount === 0) return res.status(404).json({ error: 'Proje bulunamadı.' });
    }

    let poles;
    let source: string = kind;
    let ocrResult: {
      pages: { page: number; preview: string; rows: OcrCell[][] }[];
      uncertain: { row: number; text: string }[];
    } | null = null;

    if (kind === 'excel') {
      try {
        poles = parseExcelCoordinates(req.file.buffer).poles;
      } catch (e: any) {
        return res.status(400).json({ error: 'Excel okunamadı: ' + (e.message || 'geçersiz içerik') });
      }
    } else if (kind === 'pdf') {
      // PDF: önce metin katmanı kontrolü
      let analysis;
      try {
        analysis = await analyzePdf(req.file.buffer);
      } catch (e: any) {
        return res.status(400).json({ error: 'PDF okunamadı: ' + (e.message || 'geçersiz içerik') });
      }
      if (!analysis.hasTextLayer) {
        // Taranmış PDF → OCR servisi
        try {
          const ocr = await callOcr(req.file.buffer, req.file.originalname);
          const { poles: p, uncertain } = polesFromOcr(ocr);
          poles = p;
          ocrResult = { pages: ocr.pages.map((pg) => ({ page: pg.page, preview: pg.preview, rows: pg.rows })), uncertain };
        } catch (e: any) {
          return res.status(503).json({ error: 'Taranmış PDF için OCR servisi kullanılamıyor: ' + e.message });
        }
        source = 'pdf-ocr';
      } else {
        source = 'pdf-text';
        poles = parsePdfText(analysis.text).poles;
      }
    } else {
      // TIFF → OCR servisi
      try {
        const ocr = await callOcr(req.file.buffer, req.file.originalname);
        const { poles: p, uncertain } = polesFromOcr(ocr);
        poles = p;
        ocrResult = { pages: ocr.pages.map((pg) => ({ page: pg.page, preview: pg.preview, rows: pg.rows })), uncertain };
      } catch (e: any) {
        return res.status(503).json({ error: 'TIFF için OCR servisi kullanılamıyor: ' + e.message });
      }
      source = 'tiff-ocr';
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
    const docName = path.basename(req.file.originalname, path.extname(req.file.originalname));
    const kmzBuf = buildKmz(poles, docName);
    const kmzFile = `generated-${Date.now()}.kmz`;
    fs.writeFileSync(path.join(UPLOADS_DIR, kmzFile), kmzBuf);

    const poleCoords: [number, number][] = poles.map((p) => [p.lat, p.lon]);
    const connectionKm = routeLengthKm(poleCoords);

    let saved = 0;
    if (projectId != null) {
      const result = await importPolesForProject(projectId, poles, poleCoords, req.file.originalname, poles.length, connectionKm);
      saved = result.saved;
      try {
        fs.writeFileSync(path.join(UPLOADS_DIR, `latest-p${projectId}.kmz`), kmzBuf);
      } catch { /* kritik değil */ }
    }

    res.json({
      poles: poles.map((p, i) => ({ no: i + 1, name: p.name || `Direk ${i + 1}`, lat: p.lat, lon: p.lon })),
      count: poles.length,
      saved,
      source,
      ocr: ocrResult,
      connection_km: connectionKm,
      file_name: req.file.originalname,
      kmz: `/api/kmz-generator/download/${kmzFile}`,
    });
  } catch (e) {
    next(e);
  }
});

// Düzeltilmiş satırlardan KMZ üret + projeye aktar
router.post('/from-rows', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const projectId = Number(req.body?.project_id);
    if (!Number.isInteger(projectId) || projectId <= 0) {
      return res.status(400).json({ error: 'Geçerli bir proje seçin.' });
    }
    const p = await pool.query('SELECT 1 FROM projects WHERE id = $1', [projectId]);
    if (p.rowCount === 0) return res.status(404).json({ error: 'Proje bulunamadı.' });

    const raw = Array.isArray(req.body?.poles) ? req.body.poles : [];
    const poles: PolePoint[] = [];
    for (const r of raw) {
      const lat = Number(r?.lat);
      const lon = Number(r?.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      if (lat < 36 || lat > 42 || lon < 26 || lon > 45) {
        return res.status(400).json({ error: `Geçersiz koordinat: ${r?.name || ''} (${lat}, ${lon})` });
      }
      poles.push({ name: String(r?.name || '').trim(), lat, lon, alt: null });
    }
    if (poles.length < 2) {
      return res.status(400).json({ error: 'En az 2 geçerli direk satırı gerekli.' });
    }

    const docName = String(req.body?.doc_name || 'belge');
    const kmzBuf = buildKmz(poles, docName);
    const kmzFile = `generated-${Date.now()}.kmz`;
    fs.writeFileSync(path.join(UPLOADS_DIR, kmzFile), kmzBuf);

    const coords: [number, number][] = poles.map((x) => [x.lat, x.lon]);
    const connectionKm = routeLengthKm(coords);
    const result = await importPolesForProject(projectId, poles, coords, `${docName} (düzeltilmiş)`, poles.length, connectionKm);
    try {
      fs.writeFileSync(path.join(UPLOADS_DIR, `latest-p${projectId}.kmz`), kmzBuf);
    } catch { /* kritik değil */ }

    res.json({
      saved: result.saved,
      count: poles.length,
      connection_km: connectionKm,
      kmz: `/api/kmz-generator/download/${kmzFile}`,
    });
  } catch (e) {
    next(e);
  }
});

// Düzeltilmiş satırları Excel (.xlsx) olarak indir
router.post('/export-rows', async (req: Request, res: Response) => {
  const raw = Array.isArray(req.body?.poles) ? req.body.poles : [];
  const rows: (string | number)[][] = [['Sıra', 'Direk', 'Enlem', 'Boylam']];
  raw.forEach((r: any, i: number) => {
    rows.push([i + 1, String(r?.name || ''), Number(r?.lat) || 0, Number(r?.lon) || 0]);
  });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Direkler');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('direkler-duzeltilmis.xlsx')}`);
  res.send(buf);
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
