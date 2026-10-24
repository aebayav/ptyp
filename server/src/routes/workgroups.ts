import { Router, Request, Response } from 'express';
import { pool } from '../db';
import { requireAuth, requireRole } from '../auth';
import { poleNumberFromName, poleProgress } from '../pole-statuses';
import { toDateOrNull } from '../dates';

const router = Router();

// İş takibi yalnızca iş sahibine açık (dahili modül)
router.use(requireAuth, requireRole('owner'));

const VALID_STATUSES = ['pending', 'active', 'completed'];

// İş grupları (görev sayılarıyla) — ?project_id= filtresi
router.get('/', async (req: Request, res: Response) => {
  const pid = req.query.project_id;
  const params: any[] = [];
  let where = '';
  if (pid) {
    params.push(Number(pid));
    where = ` WHERE w.project_id = $${params.length}`;
  }
  const { rows } = await pool.query(`
    SELECT w.*,
           COUNT(t.id)::int AS task_count,
           COUNT(t.id) FILTER (WHERE t.status = 'done')::int AS done_count,
           COUNT(t.id) FILTER (WHERE t.status != 'done' AND t.due_date IS NOT NULL AND t.due_date < CURRENT_DATE)::int AS late_count
    FROM work_groups w
    LEFT JOIN tasks t ON t.work_group_id = w.id
    ${where}
    GROUP BY w.id
    ORDER BY w.code
  `, params);

  // Saha ilerlemesi: kesimi olan gruplar kendi direk aralığından,
  // olmayanlar projelerinin tamamından hesaplanır
  const polesQ = await pool.query(
    `SELECT p.project_id, p.name, COALESCE(s.status, 'none') AS st
     FROM poles p
     LEFT JOIN pole_status s ON s.project_id = p.project_id AND s.pole_idx = p.idx`
  );
  const projAgg: Record<number, { sum: number; cnt: number }> = {};
  const projPoles: Record<number, { num: number; prog: number }[]> = {};
  for (const p of polesQ.rows) {
    const prog = poleProgress(p.st);
    const agg = projAgg[p.project_id] || (projAgg[p.project_id] = { sum: 0, cnt: 0 });
    agg.sum += prog;
    agg.cnt += 1;
    const num = poleNumberFromName(p.name);
    if (num != null) {
      (projPoles[p.project_id] || (projPoles[p.project_id] = [])).push({ num, prog });
    }
  }
  for (const g of rows) {
    if (g.segment_from != null && g.segment_to != null) {
      const list = projPoles[g.project_id] || [];
      const inRange = list.filter((x) => x.num >= g.segment_from && x.num <= g.segment_to);
      g.saha_progress = inRange.length
        ? Math.round((inRange.reduce((s, x) => s + x.prog, 0) / inRange.length) * 10) / 10
        : null;
    } else {
      const agg = projAgg[g.project_id];
      g.saha_progress = agg && agg.cnt > 0 ? Math.round((agg.sum / agg.cnt) * 10) / 10 : null;
    }
  }
  res.json(rows);
});

async function nextCode(): Promise<string> {
  const { rows } = await pool.query('SELECT COALESCE(MAX(id), 0) AS m FROM work_groups');
  return 'WG-' + String(Number(rows[0].m) + 1).padStart(2, '0');
}

function normalize(body: any) {
  const weight = Number(body.weight);
  const progress = Number(body.progress);
  const sf = body.segment_from === '' || body.segment_from == null ? null : Number(body.segment_from);
  const st = body.segment_to === '' || body.segment_to == null ? null : Number(body.segment_to);
  return {
    code: String(body.code || '').trim(),
    name: String(body.name || '').trim(),
    weight: Number.isFinite(weight) ? Math.min(100, Math.max(0, weight)) : 0,
    progress: Number.isFinite(progress) ? Math.min(100, Math.max(0, progress)) : 0,
    planned_start: toDateOrNull(body.planned_start, 'planlanan başlangıç'),
    planned_end: toDateOrNull(body.planned_end, 'planlanan bitiş'),
    status: String(body.status || 'pending'),
    notes: String(body.notes || '').trim(),
    segment_from: sf,
    segment_to: st,
    project_id: Number(body.project_id),
  };
}

async function validate(g: any): Promise<string | null> {
  if (!g.name) return 'İş grubu adı zorunludur.';
  if (!VALID_STATUSES.includes(g.status)) return 'Geçersiz iş grubu durumu.';
  if (!Number.isInteger(g.project_id) || g.project_id <= 0) return 'Geçerli bir proje seçin.';
  const p = await pool.query('SELECT 1 FROM projects WHERE id = $1', [g.project_id]);
  if (p.rowCount === 0) return 'Seçilen proje bulunamadı.';
  const sf = g.segment_from;
  const st = g.segment_to;
  if ((sf == null) !== (st == null)) {
    return 'Direk kesimi için başlangıç VE bitiş direğini birlikte girin.';
  }
  if (sf != null) {
    if (!Number.isInteger(sf) || !Number.isInteger(st) || sf < 1 || st < 1) {
      return 'Direk numaraları 1 veya daha büyük tam sayı olmalıdır.';
    }
    if (sf > st) return 'Başlangıç direği bitiş direğinden büyük olamaz.';
  }
  return null;
}

// Yeni iş grubu
router.post('/', async (req: Request, res: Response) => {
  const g = normalize(req.body || {});
  const err = await validate(g);
  if (err) return res.status(400).json({ error: err });

  const code = g.code || (await nextCode());
  const dup = await pool.query('SELECT 1 FROM work_groups WHERE code = $1', [code]);
  if (dup.rowCount) return res.status(400).json({ error: `"${code}" kodu zaten kullanılıyor.` });

  const { rows } = await pool.query(
    `INSERT INTO work_groups (code, name, weight, progress, planned_start, planned_end, status, notes, segment_from, segment_to, project_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [code, g.name, g.weight, g.progress, g.planned_start, g.planned_end, g.status, g.notes, g.segment_from, g.segment_to, g.project_id]
  );
  res.status(201).json({ ...rows[0], task_count: 0, done_count: 0, late_count: 0 });
});

// İş grubu güncelle
router.put('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const existing = await pool.query('SELECT * FROM work_groups WHERE id = $1', [id]);
  if (existing.rowCount === 0) return res.status(404).json({ error: 'İş grubu bulunamadı.' });

  const g = normalize(req.body || {});
  const err = await validate(g);
  if (err) return res.status(400).json({ error: err });

  const code = g.code || existing.rows[0].code;
  const dup = await pool.query('SELECT 1 FROM work_groups WHERE code = $1 AND id != $2', [code, id]);
  if (dup.rowCount) return res.status(400).json({ error: `"${code}" kodu başka bir grupta kullanılıyor.` });

  const { rows } = await pool.query(
    `UPDATE work_groups SET code=$1, name=$2, weight=$3, progress=$4, planned_start=$5, planned_end=$6, status=$7, notes=$8,
            segment_from=$9, segment_to=$10, project_id=$11
     WHERE id=$12 RETURNING *`,
    [code, g.name, g.weight, g.progress, g.planned_start, g.planned_end, g.status, g.notes, g.segment_from, g.segment_to, g.project_id, id]
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
