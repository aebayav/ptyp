import { Router, Request, Response } from 'express';
import { pool } from '../db';
import { requireAuth, requireRole } from '../auth';

const router = Router();

// İş takibi yalnızca iş sahibine açık (dahili modül)
router.use(requireAuth, requireRole('owner'));

const VALID_STATUSES = ['pending', 'active', 'completed'];

// İş grupları (görev sayılarıyla)
router.get('/', async (_req: Request, res: Response) => {
  const { rows } = await pool.query(`
    SELECT w.*,
           COUNT(t.id)::int AS task_count,
           COUNT(t.id) FILTER (WHERE t.status = 'done')::int AS done_count,
           COUNT(t.id) FILTER (WHERE t.status != 'done' AND t.due_date != '' AND t.due_date < to_char(now(), 'YYYY-MM-DD'))::int AS late_count
    FROM work_groups w
    LEFT JOIN tasks t ON t.work_group_id = w.id
    GROUP BY w.id
    ORDER BY w.code
  `);
  res.json(rows);
});

async function nextCode(): Promise<string> {
  const { rows } = await pool.query('SELECT COALESCE(MAX(id), 0) AS m FROM work_groups');
  return 'WG-' + String(Number(rows[0].m) + 1).padStart(2, '0');
}

function normalize(body: any) {
  const weight = Number(body.weight);
  const progress = Number(body.progress);
  return {
    code: String(body.code || '').trim(),
    name: String(body.name || '').trim(),
    weight: Number.isFinite(weight) ? Math.min(100, Math.max(0, weight)) : 0,
    progress: Number.isFinite(progress) ? Math.min(100, Math.max(0, progress)) : 0,
    planned_start: String(body.planned_start || '').trim(),
    planned_end: String(body.planned_end || '').trim(),
    status: String(body.status || 'pending'),
    notes: String(body.notes || '').trim(),
  };
}

function validate(g: any): string | null {
  if (!g.name) return 'İş grubu adı zorunludur.';
  if (!VALID_STATUSES.includes(g.status)) return 'Geçersiz iş grubu durumu.';
  return null;
}

// Yeni iş grubu
router.post('/', async (req: Request, res: Response) => {
  const g = normalize(req.body || {});
  const err = validate(g);
  if (err) return res.status(400).json({ error: err });

  const code = g.code || (await nextCode());
  const dup = await pool.query('SELECT 1 FROM work_groups WHERE code = $1', [code]);
  if (dup.rowCount) return res.status(400).json({ error: `"${code}" kodu zaten kullanılıyor.` });

  const { rows } = await pool.query(
    `INSERT INTO work_groups (code, name, weight, progress, planned_start, planned_end, status, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [code, g.name, g.weight, g.progress, g.planned_start, g.planned_end, g.status, g.notes]
  );
  res.status(201).json({ ...rows[0], task_count: 0, done_count: 0, late_count: 0 });
});

// İş grubu güncelle
router.put('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const existing = await pool.query('SELECT * FROM work_groups WHERE id = $1', [id]);
  if (existing.rowCount === 0) return res.status(404).json({ error: 'İş grubu bulunamadı.' });

  const g = normalize(req.body || {});
  const err = validate(g);
  if (err) return res.status(400).json({ error: err });

  const code = g.code || existing.rows[0].code;
  const dup = await pool.query('SELECT 1 FROM work_groups WHERE code = $1 AND id != $2', [code, id]);
  if (dup.rowCount) return res.status(400).json({ error: `"${code}" kodu başka bir grupta kullanılıyor.` });

  const { rows } = await pool.query(
    `UPDATE work_groups SET code=$1, name=$2, weight=$3, progress=$4, planned_start=$5, planned_end=$6, status=$7, notes=$8
     WHERE id=$9 RETURNING *`,
    [code, g.name, g.weight, g.progress, g.planned_start, g.planned_end, g.status, g.notes, id]
  );
  const cnt = await pool.query(
    `SELECT COUNT(*)::int AS c,
            COUNT(*) FILTER (WHERE status = 'done')::int AS d,
            COUNT(*) FILTER (WHERE status != 'done' AND due_date != '' AND due_date < to_char(now(), 'YYYY-MM-DD'))::int AS l
     FROM tasks WHERE work_group_id = $1`,
    [id]
  );
  res.json({ ...rows[0], task_count: cnt.rows[0].c, done_count: cnt.rows[0].d, late_count: cnt.rows[0].l });
});

// İş grubu sil (görevleri de silinir)
router.delete('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const r = await pool.query('DELETE FROM work_groups WHERE id = $1', [id]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'İş grubu bulunamadı.' });
  res.status(204).end();
});

export default router;
