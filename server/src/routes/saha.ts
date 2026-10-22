// Saha modülü: direk bazlı ilerleme durumu + saha fotoğrafları.
// Direkler yeniden işlenince (poles tablosu silinip yeniden yazılır) id'ler değişir;
// bu yüzden kayıtlar pole id yerine (project_id, pole_idx) ile tutulur.
import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import QRCode from 'qrcode';
import { pool } from '../db';
import { requireAuth, requireRole, AuthedRequest } from '../auth';
import { POLE_STATUSES, poleNumberFromName, poleProgress } from '../pole-statuses';

const router = Router();

// Saha sayfası iş sahibi + saha ekibi rollerine açık
router.use(requireAuth, requireRole('owner', 'field'));

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

const esc = (s: unknown) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// QR çıktısı: direk başına QR kartlı yazdırılabilir sayfa.
// QR, /saha?proje=<id>&direk=<idx> adresini taşır — telefonla okutulunca
// Saha sayfası ilgili direği açar/odaklar.
router.get('/:id/qr', async (req: Request, res: Response) => {
  const projectId = Number(req.params.id);
  if (!Number.isInteger(projectId) || projectId <= 0) {
    return res.status(400).json({ error: 'Geçerli bir proje seçin.' });
  }
  const proj = await pool.query('SELECT name FROM projects WHERE id = $1', [projectId]);
  if (proj.rowCount === 0) return res.status(404).json({ error: 'Proje bulunamadı.' });
  const poles = await pool.query(
    `SELECT idx, name, meta->>'tower_type' AS tower_type, meta->>'station_text' AS station_text
     FROM poles WHERE project_id = $1 ORDER BY idx`,
    [projectId]
  );
  if (poles.rows.length === 0) return res.status(400).json({ error: 'Bu projede direk yok.' });

  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').trim();
  const base = `${proto}://${host}`;

  const cards: string[] = [];
  for (const p of poles.rows) {
    const url = `${base}/saha?proje=${projectId}&direk=${p.idx}`;
    let svg = '';
    try {
      svg = await QRCode.toString(url, { type: 'svg', margin: 0, width: 128 });
    } catch {
      /* qr üretilemezse boş kalır */
    }
    cards.push(
      `<div class="qrcard"><div class="qr">${svg}</div><div class="qrname">${esc(p.name)}</div>` +
        `<div class="qrmeta">${esc(p.tower_type || '')}${p.station_text ? ' · ' + esc(p.station_text) : ''}</div></div>`
    );
  }

  const html = `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Direk QR — ${esc(proj.rows[0].name)}</title>
<style>
body{font-family:'Segoe UI',system-ui,sans-serif;margin:0;padding:24px;color:#1c2b3a}
h1{font-size:18px;margin:0 0 4px}
.sub{color:#6b7a8c;font-size:12px;margin-bottom:16px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}
.qrcard{border:1px solid #dbe2ea;border-radius:10px;padding:10px;text-align:center;break-inside:avoid;background:#fff}
.qr svg{width:110px;height:110px}
.qrname{font-weight:700;font-size:13px;margin-top:6px}
.qrmeta{font-size:10.5px;color:#6b7a8c;margin-top:2px}
.print-btn{position:fixed;top:16px;right:16px;background:#0d1f3c;color:#fff;border:none;border-radius:8px;padding:10px 18px;font-size:13px;cursor:pointer}
@media print{.print-btn{display:none}body{padding:6mm}}
</style></head><body>
<button class="print-btn" onclick="window.print()">Yazdır</button>
<h1>Direk QR Kartları — ${esc(proj.rows[0].name)}</h1>
<div class="sub">${poles.rows.length} direk · telefonla okutunca Saha sayfasında ilgili direk açılır</div>
<div class="grid">${cards.join('')}</div>
</body></html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// ---------- Saha malzeme talepleri ----------

// Talepler: açık olanlar önce, yeniden eskiye
router.get('/:id/requests', async (req: Request, res: Response) => {
  const projectId = Number(req.params.id);
  if (!Number.isInteger(projectId) || projectId <= 0) {
    return res.status(400).json({ error: 'Geçerli bir proje seçin.' });
  }
  const proj = await pool.query('SELECT 1 FROM projects WHERE id = $1', [projectId]);
  if (proj.rowCount === 0) return res.status(404).json({ error: 'Proje bulunamadı.' });
  const { rows } = await pool.query(
    `SELECT r.*, u.display_name AS requested_by_name, f.display_name AS fulfilled_by_name
     FROM saha_requests r
     LEFT JOIN users u ON u.id = r.requested_by
     LEFT JOIN users f ON f.id = r.fulfilled_by
     WHERE r.project_id = $1
     ORDER BY (r.status = 'open') DESC, r.created_at DESC`,
    [projectId]
  );
  res.json(rows);
});

// Yeni talep
router.post('/:id/requests', async (req: Request, res: Response) => {
  const projectId = Number(req.params.id);
  if (!Number.isInteger(projectId) || projectId <= 0) {
    return res.status(400).json({ error: 'Geçerli bir proje seçin.' });
  }
  const itemName = String(req.body?.item_name || '').trim();
  if (!itemName) return res.status(400).json({ error: 'Malzeme adı zorunludur.' });
  const qty = Number(req.body?.qty);
  if (!(Number.isFinite(qty) && qty > 0)) return res.status(400).json({ error: 'Geçerli bir miktar girin.' });
  const proj = await pool.query('SELECT 1 FROM projects WHERE id = $1', [projectId]);
  if (proj.rowCount === 0) return res.status(404).json({ error: 'Proje bulunamadı.' });

  const uid = (req as AuthedRequest).user?.id ?? null;
  const { rows } = await pool.query(
    `INSERT INTO saha_requests (project_id, item_name, qty, unit, pole_ref, needed_by, note, requested_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, created_at`,
    [
      projectId,
      itemName.slice(0, 200),
      qty,
      String(req.body?.unit || 'adet').slice(0, 20),
      String(req.body?.pole_ref || '').slice(0, 80),
      String(req.body?.needed_by || '').slice(0, 20),
      String(req.body?.note || '').slice(0, 300),
      uid,
    ]
  );
  res.status(201).json(rows[0]);
});

// Talep durumu: fulfilled/cancelled iş sahibi; saha ekibi yalnızca kendi talebini iptal edebilir
router.put('/requests/:id/status', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Geçersiz talep.' });
  const status = String(req.body?.status || '');
  if (!['open', 'fulfilled', 'cancelled'].includes(status)) return res.status(400).json({ error: 'Geçersiz durum.' });
  const r = await pool.query('SELECT * FROM saha_requests WHERE id = $1', [id]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'Talep bulunamadı.' });
  const user = (req as AuthedRequest).user!;
  if (user.role === 'field' && !(status === 'cancelled' && r.rows[0].requested_by === user.id)) {
    return res.status(403).json({ error: 'Saha ekibi yalnızca kendi talebini iptal edebilir.' });
  }
  await pool.query(
    `UPDATE saha_requests SET status = $1,
       fulfilled_by = CASE WHEN $1 = 'fulfilled' THEN $2 ELSE NULL END,
       fulfilled_at = CASE WHEN $1 = 'fulfilled' THEN now() ELSE NULL END
     WHERE id = $3`,
    [status, user.id, id]
  );
  res.json({ id, status });
});

export default router;
