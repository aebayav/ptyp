// Depo & stok: irsaliye ile giriş, şantiyeye sevk, sarfiyat.
// Kalan stok = giriş − (sevk + sarfiyat). Keşif miktarı ile yan yana karşılaştırma.
import { Router, Request, Response } from 'express';
import { pool } from '../db';
import { requireAuth, requireRole, AuthedRequest } from '../auth';

const router = Router();

// Depo ofis işi — yalnız iş sahibi
router.use(requireAuth, requireRole('owner'));

export const MOVEMENT_TYPES: Record<string, { label: string; sign: number }> = {
  giris: { label: 'Giriş', sign: 1 },
  sevk: { label: 'Sevk', sign: -1 },
  sarfiyat: { label: 'Sarfiyat', sign: -1 },
};

// Stok özeti: malzeme bazında keşif / gelen / harcanan / kalan
router.get('/', async (req: Request, res: Response) => {
  const pid = Number(req.query.project_id);
  if (!Number.isInteger(pid) || pid <= 0) return res.status(400).json({ error: 'Geçerli bir proje seçin.' });

  const [{ rows: matRows }, { rows: movRows }, { rows: kesifRows }] = await Promise.all([
    pool.query('SELECT id, name, code, unit, spec, target_price FROM materials ORDER BY name'),
    pool.query(
      `SELECT material_id,
              SUM(qty) FILTER (WHERE movement_type = 'giris')::float AS total_in,
              SUM(qty) FILTER (WHERE movement_type IN ('sevk','sarfiyat'))::float AS total_out
       FROM stock_movements WHERE project_id = $1 GROUP BY material_id`,
      [pid]
    ),
    pool.query('SELECT item_name, SUM(qty)::float AS qty FROM kesif_items WHERE project_id = $1 GROUP BY item_name', [pid]),
  ]);

  const mov = new Map(movRows.map((r: any) => [r.material_id, r]));
  const norm = (s: string) =>
    s.toLowerCase().replace(/ı/g, 'i').replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ş/g, 's').replace(/ö/g, 'o').replace(/ç/g, 'c').trim();
  const kesifQty = (name: string) => {
    const hit = kesifRows.find((k: any) => norm(k.item_name) === norm(name));
    return hit ? Number(hit.qty) : null;
  };

  const summary = matRows.map((m: any) => {
    const r = mov.get(m.id) || { total_in: 0, total_out: 0 };
    const totalIn = Number(r.total_in) || 0;
    const totalOut = Number(r.total_out) || 0;
    const remaining = totalIn - totalOut;
    return {
      material_id: m.id,
      code: m.code,
      name: m.name,
      unit: m.unit,
      spec: m.spec,
      target_price: m.target_price,
      kesif: kesifQty(m.name),
      total_in: totalIn,
      total_out: totalOut,
      remaining,
    };
  });

  res.json({ summary, kesif_count: kesifRows.length });
});

// Son hareketler
router.get('/movements', async (req: Request, res: Response) => {
  const pid = Number(req.query.project_id);
  if (!Number.isInteger(pid) || pid <= 0) return res.status(400).json({ error: 'Geçerli bir proje seçin.' });
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const { rows } = await pool.query(
    `SELECT sm.*, m.name AS material_name, m.unit AS material_unit, s.name AS supplier_name,
            sr.item_name AS request_item
     FROM stock_movements sm
     JOIN materials m ON m.id = sm.material_id
     LEFT JOIN suppliers s ON s.id = sm.supplier_id
     LEFT JOIN saha_requests sr ON sr.id = sm.saha_request_id
     WHERE sm.project_id = $1
     ORDER BY sm.created_at DESC, sm.id DESC
     LIMIT $2`,
    [pid, limit]
  );
  res.json(rows);
});

// Sevk bağlanabilir saha talepleri
router.get('/requests', async (req: Request, res: Response) => {
  const pid = Number(req.query.project_id);
  if (!Number.isInteger(pid) || pid <= 0) return res.status(400).json({ error: 'Geçerli bir proje seçin.' });
  const { rows } = await pool.query(
    `SELECT id, item_name, qty, unit, pole_ref, status FROM saha_requests
     WHERE project_id = $1 AND status IN ('open','fulfilled')
     ORDER BY id DESC LIMIT 100`,
    [pid]
  );
  res.json(rows);
});

router.post('/movements', async (req: Request, res: Response) => {
  const u = req as AuthedRequest;
  const pid = Number(req.body?.project_id);
  const material_id = Number(req.body?.material_id);
  const mtype = String(req.body?.movement_type || 'giris');
  const qty = Number(req.body?.qty);
  if (!Number.isInteger(pid) || pid <= 0) return res.status(400).json({ error: 'Geçerli bir proje seçin.' });
  if (!Number.isInteger(material_id) || material_id <= 0) return res.status(400).json({ error: 'Malzeme seçin.' });
  if (!MOVEMENT_TYPES[mtype]) return res.status(400).json({ error: 'Geçersiz hareket tipi.' });
  if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ error: 'Miktar pozitif bir sayı olmalı.' });

  const mat = await pool.query('SELECT unit FROM materials WHERE id = $1', [material_id]);
  if ((mat.rowCount ?? 0) === 0) return res.status(404).json({ error: 'Malzeme bulunamadı.' });

  const supplier_id = req.body?.supplier_id === '' || req.body?.supplier_id == null ? null : Number(req.body?.supplier_id);
  const saha_request_id =
    req.body?.saha_request_id === '' || req.body?.saha_request_id == null ? null : Number(req.body?.saha_request_id);

  const { rows } = await pool.query(
    `INSERT INTO stock_movements (project_id, material_id, movement_type, qty, unit, irsaliye_no, supplier_id, saha_request_id, note, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [
      pid,
      material_id,
      mtype,
      qty,
      String(req.body?.unit || mat.rows[0].unit || 'adet').slice(0, 20),
      String(req.body?.irsaliye_no || '').trim().slice(0, 40),
      supplier_id,
      saha_request_id,
      String(req.body?.note || '').trim().slice(0, 300),
      u.user?.id,
    ]
  );
  res.status(201).json(rows[0]);
});

router.delete('/movements/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Geçersiz kayıt.' });
  const r = await pool.query('DELETE FROM stock_movements WHERE id = $1', [id]);
  if ((r.rowCount ?? 0) === 0) return res.status(404).json({ error: 'Kayıt bulunamadı.' });
  res.status(204).end();
});

export default router;
