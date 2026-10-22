// Saha modülü: direk bazlı ilerleme durumu + saha fotoğrafları.
// Direkler yeniden işlenince (poles tablosu silinip yeniden yazılır) id'ler değişir;
// bu yüzden kayıtlar pole id yerine (project_id, pole_idx) ile tutulur.
import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { pool } from '../db';
import { requireAuth, requireRole, AuthedRequest } from '../auth';

const router = Router();

// Saha sayfası iş sahibi + saha ekibi rollerine açık
router.use(requireAuth, requireRole('owner', 'field'));

export const POLE_STATUSES: Record<string, { label: string; color: string; progress: number }> = {
  none: { label: 'Başlamadı', color: '#94a3b8', progress: 0 },
  excavation: { label: 'Kazı', color: '#d97706', progress: 15 },
  foundation: { label: 'Temel', color: '#b45309', progress: 30 },
  erection: { label: 'Direk Montajı', color: '#2563eb', progress: 50 },
  fittings: { label: 'Donanım (Askı/Gergi)', color: '#7c3aed', progress: 70 },
  stringing: { label: 'İletken Çekimi', color: '#0891b2', progress: 85 },
  completed: { label: 'Tamamlandı', color: '#16a34a', progress: 100 },
  issue: { label: 'Sorun / Engel', color: '#dc2626', progress: 0 },
};

const PHOTOS_DIR = path.join(__dirname, '..', '..', 'uploads', 'pole-photos');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 8 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype && file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Yalnızca görsel dosyaları yüklenebilir.'));
  },
});

async function projectExists(id: number): Promise<boolean> {
  const r = await pool.query('SELECT 1 FROM projects WHERE id = $1', [id]);
  return (r.rowCount ?? 0) === 1;
}

async function poleExists(projectId: number, idx: number): Promise<boolean> {
  const r = await pool.query('SELECT 1 FROM poles WHERE project_id = $1 AND idx = $2', [projectId, idx]);
  return (r.rowCount ?? 0) === 1;
}

// Projenin direkleri + durumları + fotoğrafları + ilerleme özeti
router.get('/:id', async (req: Request, res: Response) => {
  const projectId = Number(req.params.id);
  if (!Number.isInteger(projectId) || projectId <= 0) {
    return res.status(400).json({ error: 'Geçerli bir proje seçin.' });
  }
  const proj = await pool.query('SELECT name FROM projects WHERE id = $1', [projectId]);
  if (proj.rowCount === 0) return res.status(404).json({ error: 'Proje bulunamadı.' });

  const poles = await pool.query(
    `SELECT p.idx, p.name, p.lat, p.lon,
            p.meta->>'tower_type' AS tower_type,
            p.meta->>'station_text' AS station_text,
            COALESCE(s.status, 'none') AS status,
            s.note, s.updated_at, s.updated_by,
            u.display_name AS updated_by_name
     FROM poles p
     LEFT JOIN pole_status s ON s.project_id = p.project_id AND s.pole_idx = p.idx
     LEFT JOIN users u ON u.id = s.updated_by
     WHERE p.project_id = $1
     ORDER BY p.idx`,
    [projectId]
  );
  const photos = await pool.query(
    'SELECT id, pole_idx, caption, created_at, uploaded_by FROM pole_photos WHERE project_id = $1 ORDER BY created_at',
    [projectId]
  );
  const photoByPole = new Map<number, any[]>();
  for (const ph of photos.rows) {
    if (!photoByPole.has(ph.pole_idx)) photoByPole.set(ph.pole_idx, []);
    photoByPole.get(ph.pole_idx)!.push({
      id: ph.id,
      caption: ph.caption,
      created_at: ph.created_at,
      url: `/api/saha/photos/${ph.id}/file`,
    });
  }

  const counts: Record<string, number> = {};
  let progressSum = 0;
  const out = poles.rows.map((p: any) => {
    const st = POLE_STATUSES[p.status] ? p.status : 'none';
    counts[st] = (counts[st] || 0) + 1;
    progressSum += POLE_STATUSES[st].progress;
    return {
      idx: p.idx,
      name: p.name,
      lat: p.lat,
      lon: p.lon,
      tower_type: p.tower_type || '',
      station_text: p.station_text || '',
      status: st,
      status_label: POLE_STATUSES[st].label,
      note: p.note || '',
      updated_at: p.updated_at,
      updated_by: p.updated_by_name || '',
      photos: photoByPole.get(p.idx) || [],
    };
  });

  res.json({
    project_name: proj.rows[0].name,
    poles: out,
    statuses: POLE_STATUSES,
    summary: {
      status_counts: Object.keys(POLE_STATUSES).map((k) => ({
        status: k,
        label: POLE_STATUSES[k].label,
        color: POLE_STATUSES[k].color,
        count: counts[k] || 0,
      })),
      progress: out.length > 0 ? Math.round((progressSum / out.length) * 10) / 10 : 0,
      pole_count: out.length,
    },
  });
});

// Direk durumu güncelle (UPSERT)
router.put('/:id/status', async (req: Request, res: Response) => {
  const projectId = Number(req.params.id);
  if (!Number.isInteger(projectId) || projectId <= 0) {
    return res.status(400).json({ error: 'Geçerli bir proje seçin.' });
  }
  const idx = Number(req.body?.pole_idx);
  if (!Number.isInteger(idx) || idx < 0) {
    return res.status(400).json({ error: 'Direk seçilmedi.' });
  }
  const status = String(req.body?.status || 'none');
  if (!POLE_STATUSES[status]) return res.status(400).json({ error: 'Geçersiz durum.' });
  const note = String(req.body?.note || '').slice(0, 500);

  if (!(await projectExists(projectId))) return res.status(404).json({ error: 'Proje bulunamadı.' });
  if (!(await poleExists(projectId, idx))) return res.status(404).json({ error: 'Direk bulunamadı.' });

  const uid = (req as AuthedRequest).user?.id ?? null;
  await pool.query(
    `INSERT INTO pole_status (project_id, pole_idx, status, note, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (project_id, pole_idx) DO UPDATE SET
       status = EXCLUDED.status, note = EXCLUDED.note,
       updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [projectId, idx, status, note, uid]
  );
  res.json({ pole_idx: idx, status, status_label: POLE_STATUSES[status].label, note });
});

// Direğe fotoğraf ekle (çoklu)
router.post('/:id/photos', upload.array('photos', 8), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const projectId = Number(req.params.id);
    if (!Number.isInteger(projectId) || projectId <= 0) {
      return res.status(400).json({ error: 'Geçerli bir proje seçin.' });
    }
    const idx = Number(req.body?.pole_idx);
    if (!Number.isInteger(idx) || idx < 0) return res.status(400).json({ error: 'Direk seçilmedi.' });
    if (!(await projectExists(projectId))) return res.status(404).json({ error: 'Proje bulunamadı.' });
    if (!(await poleExists(projectId, idx))) return res.status(404).json({ error: 'Direk bulunamadı.' });

    const files = (req.files as Express.Multer.File[]) || [];
    if (files.length === 0) return res.status(400).json({ error: 'Fotoğraf seçilmedi.' });

    const dir = path.join(PHOTOS_DIR, String(projectId));
    fs.mkdirSync(dir, { recursive: true });
    const uid = (req as AuthedRequest).user?.id ?? null;
    const caption = String(req.body?.caption || '').slice(0, 200);
    const saved: any[] = [];
    for (const f of files) {
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${path.basename(f.originalname || 'foto').replace(/[^A-Za-z0-9._-]/g, '_')}`;
      fs.writeFileSync(path.join(dir, filename), f.buffer);
      const r = await pool.query(
        `INSERT INTO pole_photos (project_id, pole_idx, filename, caption, uploaded_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, caption, created_at`,
        [projectId, idx, filename, caption, uid]
      );
      saved.push({ id: r.rows[0].id, caption: r.rows[0].caption, created_at: r.rows[0].created_at, url: `/api/saha/photos/${r.rows[0].id}/file` });
    }
    res.status(201).json({ saved });
  } catch (e) {
    next(e);
  }
});

// Fotoğrafı sil (dosya + kayıt)
router.delete('/photos/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Geçersiz fotoğraf.' });
  const r = await pool.query('SELECT project_id, filename FROM pole_photos WHERE id = $1', [id]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'Fotoğraf bulunamadı.' });
  const fpath = path.join(PHOTOS_DIR, String(r.rows[0].project_id), r.rows[0].filename);
  try {
    if (fs.existsSync(fpath)) fs.unlinkSync(fpath);
  } catch {
    /* dosya zaten yok */
  }
  await pool.query('DELETE FROM pole_photos WHERE id = $1', [id]);
  res.status(204).end();
});

// Fotoğraf dosyasını indir (oturumlu)
router.get('/photos/:id/file', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Geçersiz fotoğraf.' });
  const r = await pool.query('SELECT project_id, filename FROM pole_photos WHERE id = $1', [id]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'Fotoğraf bulunamadı.' });
  const fpath = path.join(PHOTOS_DIR, String(r.rows[0].project_id), r.rows[0].filename);
  if (!fs.existsSync(fpath)) return res.status(404).json({ error: 'Dosya diskte bulunamadı.' });
  res.sendFile(fpath);
});

export default router;
