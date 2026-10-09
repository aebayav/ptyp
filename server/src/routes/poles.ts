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

// Direk listesi + güzergah hattı + bağlantı hattı
router.get('/', async (_req: Request, res: Response) => {
  const [poles, meta] = await Promise.all([
    pool.query('SELECT id, name, lat, lon, alt, idx FROM poles ORDER BY idx'),
    pool.query(`SELECT key, value FROM kmz_meta WHERE key IN ('route', 'file_name', 'uploaded_at', 'point_total')`),
  ]);
  const m: Record<string, unknown> = {};
  for (const r of meta.rows) m[r.key] = r.value;
  const poleCoords: [number, number][] = poles.rows.map((p: any) => [p.lat, p.lon]);
  res.json({
    poles: poles.rows,
    route: m.route || null,
    file_name: m.file_name || null,
    uploaded_at: m.uploaded_at || null,
    point_total: m.point_total || poles.rows.length,
    route_km: Array.isArray(m.route) ? routeLengthKm(m.route as [number, number][]) : null,
    connection_km: poleCoords.length >= 2 ? routeLengthKm(poleCoords) : null,
  });
});

// KMZ yükle → parse et → mevcut direkleri değiştir
router.post('/upload', upload.single('file'), async (req: Request, res: Response, next: NextFunction) => {
  try {
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

    // Son yüklenen dosyayı analiz/debug için sakla (yalnızca son dosya)
    try {
      fs.writeFileSync(path.join(UPLOADS_DIR, 'latest.kmz'), req.file.buffer);
    } catch {
      /* disk hatası kritik değil */
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM poles');
      for (let i = 0; i < result.poles.length; i++) {
        const p = result.poles[i];
        await client.query(
          'INSERT INTO poles (name, lat, lon, alt, idx) VALUES ($1, $2, $3, $4, $5)',
          [p.name || `Direk ${i + 1}`, p.lat, p.lon, p.alt, i]
        );
      }
      await client.query(
        `INSERT INTO kmz_meta (key, value) VALUES
           ('route', $1::jsonb), ('file_name', $2::jsonb), ('uploaded_at', $3::jsonb), ('point_total', $4::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [
          JSON.stringify(result.route || []),
          JSON.stringify(req.file.originalname),
          JSON.stringify(new Date().toISOString()),
          JSON.stringify(result.placemarkCount),
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

// Güzergahı temizle
router.delete('/', async (_req: Request, res: Response) => {
  await pool.query('DELETE FROM poles');
  await pool.query(`DELETE FROM kmz_meta WHERE key IN ('route', 'file_name', 'uploaded_at', 'point_total')`);
  res.status(204).end();
});

export default router;
