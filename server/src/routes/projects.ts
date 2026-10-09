import { Router, Request, Response } from 'express';
import { pool } from '../db';
import { requireAuth, requireRole } from '../auth';

const router = Router();

// Proje yönetimi yalnızca iş sahibine açık
router.use(requireAuth, requireRole('owner'));

// Proje listesi (direk ve iş grubu sayılarıyla)
router.get('/', async (_req: Request, res: Response) => {
  const { rows } = await pool.query(`
    SELECT p.*,
           (SELECT COUNT(*)::int FROM poles po WHERE po.project_id = p.id) AS pole_count,
           (SELECT COUNT(*)::int FROM work_groups w WHERE w.project_id = p.id) AS group_count
    FROM projects p
    ORDER BY p.id
  `);
  res.json(rows);
});

// Yeni proje (şantiye)
router.post('/', async (req: Request, res: Response) => {
  const name = String(req.body?.name || '').trim();
  const type = String(req.body?.type || 'enh').trim();
  const capacity = String(req.body?.capacity || '').trim();
  const employer = String(req.body?.employer || '').trim();
  const contract_no = String(req.body?.contract_no || '').trim();
  const start_date = String(req.body?.start_date || '').trim();
  const end_date = String(req.body?.end_date || '').trim();

  if (!name) return res.status(400).json({ error: 'Proje adı zorunludur.' });
  
  const validTypes = ['enh', 'tm', 'ges', 'res'];
  if (!validTypes.includes(type)) return res.status(400).json({ error: 'Geçersiz proje tipi.' });

  const dup = await pool.query('SELECT 1 FROM projects WHERE lower(name) = lower($1)', [name]);
  if (dup.rowCount) return res.status(400).json({ error: `"${name}" adında bir proje zaten var.` });
  
  const { rows } = await pool.query(
    'INSERT INTO projects (name, type, capacity, employer, contract_no, start_date, end_date) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
    [name, type, capacity, employer, contract_no, start_date, end_date]
  );
  res.status(201).json({ ...rows[0], pole_count: 0, group_count: 0 });
});

// Proje adı değiştir
router.put('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const name = String(req.body?.name || '').trim();
  const type = String(req.body?.type || 'enh').trim();
  const capacity = String(req.body?.capacity || '').trim();
  const employer = String(req.body?.employer || '').trim();
  const contract_no = String(req.body?.contract_no || '').trim();
  const start_date = String(req.body?.start_date || '').trim();
  const end_date = String(req.body?.end_date || '').trim();

  if (!name) return res.status(400).json({ error: 'Proje adı zorunludur.' });
  
  const validTypes = ['enh', 'tm', 'ges', 'res'];
  if (!validTypes.includes(type)) return res.status(400).json({ error: 'Geçersiz proje tipi.' });

  const existing = await pool.query('SELECT 1 FROM projects WHERE id = $1', [id]);
  if (existing.rowCount === 0) return res.status(404).json({ error: 'Proje bulunamadı.' });
  const dup = await pool.query('SELECT 1 FROM projects WHERE lower(name) = lower($1) AND id != $2', [name, id]);
  if (dup.rowCount) return res.status(400).json({ error: `"${name}" adında bir proje zaten var.` });
  
  const { rows } = await pool.query(
    'UPDATE projects SET name = $1, type = $2, capacity = $3, employer = $4, contract_no = $5, start_date = $6, end_date = $7 WHERE id = $8 RETURNING *',
    [name, type, capacity, employer, contract_no, start_date, end_date, id]
  );
  res.json(rows[0]);
});

// Proje sil (direkleri, iş grupları ve görevleri de silinir)
router.delete('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const remaining = await pool.query('SELECT COUNT(*)::int AS c FROM projects');
  if (remaining.rows[0].c <= 1) {
    return res.status(400).json({ error: 'En az bir proje kalmalıdır.' });
  }
  const r = await pool.query('DELETE FROM projects WHERE id = $1', [id]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'Proje bulunamadı.' });
  res.status(204).end();
});

export default router;
