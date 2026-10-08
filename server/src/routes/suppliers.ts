import { Router, Request, Response } from 'express';
import { pool } from '../db';
import { requireAuth, requireRole } from '../auth';

const router = Router();

// Satıcı yönetimi yalnızca iş sahibine açık
router.use(requireAuth, requireRole('owner'));

// Tüm satıcılar (teklif sayısıyla)
router.get('/', async (_req: Request, res: Response) => {
  const { rows } = await pool.query(`
    SELECT s.*, COUNT(q.id)::int AS quote_count
    FROM suppliers s
    LEFT JOIN quotes q ON q.supplier_id = s.id
    GROUP BY s.id
    ORDER BY s.name
  `);
  res.json(rows);
});

function normalize(body: any) {
  return {
    name: String(body.name || '').trim(),
    contact_name: String(body.contact_name || '').trim(),
    phone: String(body.phone || '').trim(),
    email: String(body.email || '').trim(),
    address: String(body.address || '').trim(),
    notes: String(body.notes || '').trim(),
  };
}

// Yeni satıcı
router.post('/', async (req: Request, res: Response) => {
  const s = normalize(req.body || {});
  if (!s.name) return res.status(400).json({ error: 'Firma adı zorunludur.' });

  const dup = await pool.query('SELECT 1 FROM suppliers WHERE name = $1', [s.name]);
  if (dup.rowCount) return res.status(400).json({ error: `"${s.name}" zaten kayıtlı.` });

  const { rows } = await pool.query(
    `INSERT INTO suppliers (name, contact_name, phone, email, address, notes)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [s.name, s.contact_name, s.phone, s.email, s.address, s.notes]
  );
  res.status(201).json({ ...rows[0], quote_count: 0 });
});

// Satıcı güncelle
router.put('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const existing = await pool.query('SELECT 1 FROM suppliers WHERE id = $1', [id]);
  if (existing.rowCount === 0) return res.status(404).json({ error: 'Satıcı bulunamadı.' });

  const s = normalize(req.body || {});
  if (!s.name) return res.status(400).json({ error: 'Firma adı zorunludur.' });

  const dup = await pool.query('SELECT 1 FROM suppliers WHERE name = $1 AND id != $2', [s.name, id]);
  if (dup.rowCount) return res.status(400).json({ error: `"${s.name}" zaten kayıtlı.` });

  const { rows } = await pool.query(
    `UPDATE suppliers SET name=$1, contact_name=$2, phone=$3, email=$4, address=$5, notes=$6
     WHERE id=$7 RETURNING *`,
    [s.name, s.contact_name, s.phone, s.email, s.address, s.notes, id]
  );
  const cnt = await pool.query('SELECT COUNT(*)::int AS c FROM quotes WHERE supplier_id = $1', [id]);
  res.json({ ...rows[0], quote_count: cnt.rows[0].c });
});

// Satıcı sil (teklifleri de silinir)
router.delete('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const r = await pool.query('DELETE FROM suppliers WHERE id = $1', [id]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'Satıcı bulunamadı.' });
  res.status(204).end();
});

export default router;
