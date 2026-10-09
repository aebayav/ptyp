import { Router, Request, Response } from 'express';
import { pool } from '../db';
import { requireAuth, requireRole } from '../auth';

const router = Router();

// İş takibi yalnızca iş sahibine açık (dahili modül)
router.use(requireAuth, requireRole('owner'));

const VALID_STATUSES = ['todo', 'in_progress', 'done'];
const VALID_PRIORITIES = ['low', 'normal', 'high'];

// Tüm görevler (grup ve atanan bilgileriyle) — ?work_group_id= filtresi
router.get('/', async (req: Request, res: Response) => {
  const gid = req.query.work_group_id;
  const params: any[] = [];
  let sql = `
    SELECT t.*, w.name AS group_name, w.code AS group_code,
           u.display_name AS assignee_name, u.username AS assignee_username
    FROM tasks t
    JOIN work_groups w ON w.id = t.work_group_id
    LEFT JOIN users u ON u.id = t.assignee_id
  `;
  if (gid) {
    params.push(Number(gid));
    sql += ` WHERE t.work_group_id = $${params.length}`;
  }
  sql += ' ORDER BY t.due_date ASC, t.priority DESC, t.id DESC';
  const { rows } = await pool.query(sql, params);
  res.json(rows);
});

function normalize(body: any) {
  return {
    work_group_id: Number(body.work_group_id),
    title: String(body.title || '').trim(),
    description: String(body.description || '').trim(),
    assignee_id: body.assignee_id === '' || body.assignee_id == null ? null : Number(body.assignee_id),
    due_date: String(body.due_date || '').trim(),
    status: String(body.status || 'todo'),
    priority: String(body.priority || 'normal'),
  };
}

async function validate(t: any): Promise<string | null> {
  if (!Number.isInteger(t.work_group_id) || t.work_group_id <= 0) return 'Geçerli bir iş grubu seçin.';
  if (!t.title) return 'Görev başlığı zorunludur.';
  if (!VALID_STATUSES.includes(t.status)) return 'Geçersiz görev durumu.';
  if (!VALID_PRIORITIES.includes(t.priority)) return 'Geçersiz öncelik.';
  const g = await pool.query('SELECT 1 FROM work_groups WHERE id = $1', [t.work_group_id]);
  if (g.rowCount === 0) return 'Seçilen iş grubu bulunamadı.';
  if (t.assignee_id != null) {
    const u = await pool.query('SELECT 1 FROM users WHERE id = $1', [t.assignee_id]);
    if (u.rowCount === 0) return 'Seçilen kullanıcı bulunamadı.';
  }
  return null;
}

const TASK_SELECT = `
  SELECT t.*, w.name AS group_name, w.code AS group_code,
         u.display_name AS assignee_name, u.username AS assignee_username
  FROM tasks t
  JOIN work_groups w ON w.id = t.work_group_id
  LEFT JOIN users u ON u.id = t.assignee_id
  WHERE t.id = $1
`;

// Yeni görev
router.post('/', async (req: Request, res: Response) => {
  const t = normalize(req.body || {});
  const err = await validate(t);
  if (err) return res.status(400).json({ error: err });

  const { rows } = await pool.query(
    `INSERT INTO tasks (work_group_id, title, description, assignee_id, due_date, status, priority)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [t.work_group_id, t.title, t.description, t.assignee_id, t.due_date, t.status, t.priority]
  );
  const created = await pool.query(TASK_SELECT, [rows[0].id]);
  res.status(201).json(created.rows[0]);
});

// Görev güncelle
router.put('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const existing = await pool.query('SELECT 1 FROM tasks WHERE id = $1', [id]);
  if (existing.rowCount === 0) return res.status(404).json({ error: 'Görev bulunamadı.' });

  const t = normalize(req.body || {});
  const err = await validate(t);
  if (err) return res.status(400).json({ error: err });

  await pool.query(
    `UPDATE tasks SET work_group_id=$1, title=$2, description=$3, assignee_id=$4, due_date=$5,
            status=$6, priority=$7, updated_at = now()
     WHERE id=$8`,
    [t.work_group_id, t.title, t.description, t.assignee_id, t.due_date, t.status, t.priority, id]
  );
  const updated = await pool.query(TASK_SELECT, [id]);
  res.json(updated.rows[0]);
});

// Görev sil
router.delete('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const r = await pool.query('DELETE FROM tasks WHERE id = $1', [id]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'Görev bulunamadı.' });
  res.status(204).end();
});

export default router;
