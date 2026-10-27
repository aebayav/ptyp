import { Router, Request, Response } from 'express';
import { pool } from '../db';
import { requireAuth, requireRole } from '../auth';
import { poleNumberFromName, poleStageProgress, SAHA_STAGES } from '../pole-statuses';
import { toDateOrNull } from '../dates';
import { LATE_TASK_SQL } from '../late-filter';
import { buildAutoPlanPreview, syncWorkGroupsFromSaha, AutoPlanOptions } from '../work-plan-generator';

const router = Router();

// İş takibi yalnızca iş sahibine açık (dahili modül)
router.use(requireAuth, requireRole('owner'));

const VALID_STATUSES = ['pending', 'active', 'completed'];
const VALID_SAHA_STAGES = Object.keys(SAHA_STAGES);

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
           COUNT(t.id) FILTER (WHERE ${LATE_TASK_SQL})::int AS late_count
    FROM work_groups w
    LEFT JOIN tasks t ON t.work_group_id = w.id
    ${where}
    GROUP BY w.id
    ORDER BY w.code
  `, params);

  // Saha ilerlemesi: kesimi olan gruplar kendi direk aralığından,
  // olmayanlar projelerinin tamamından; saha_stage varsa o aşamaya göre hesaplanır
  const polesQ = await pool.query(
    `SELECT p.project_id, p.name, COALESCE(s.status, 'none') AS st
     FROM poles p
     LEFT JOIN pole_status s ON s.project_id = p.project_id AND s.pole_idx = p.idx`
  );
  const projPoles: Record<number, { num: number | null; st: string }[]> = {};
  for (const p of polesQ.rows) {
    const num = poleNumberFromName(p.name);
    (projPoles[p.project_id] || (projPoles[p.project_id] = [])).push({ num, st: String(p.st || 'none') });
  }
  for (const g of rows) {
    const allPoles = projPoles[g.project_id] || [];
    const target =
      g.segment_from != null && g.segment_to != null
        ? allPoles.filter((x) => x.num != null && x.num >= g.segment_from && x.num <= g.segment_to)
        : allPoles;
    if (target.length > 0) {
      const sum = target.reduce((acc, x) => acc + poleStageProgress(x.st, g.saha_stage), 0);
      g.saha_progress = Math.round((sum / target.length) * 10) / 10;
    } else {
      g.saha_progress = null;
    }
  }
  res.json(rows);
});

// Otomatik iş planı önizleme (sihirbaz için)
router.get('/auto-preview', async (req: Request, res: Response) => {
  const projectId = Number(req.query.project_id);
  if (!Number.isInteger(projectId) || projectId <= 0) {
    return res.status(400).json({ error: 'Geçerli bir proje seçin.' });
  }
  const opts: AutoPlanOptions = {
    mode: (String(req.query.mode || 'hybrid') as AutoPlanOptions['mode']) || 'hybrid',
    start_date: req.query.start_date ? toDateOrNull(req.query.start_date, 'başlangıç tarihi') : null,
    end_date: req.query.end_date ? toDateOrNull(req.query.end_date, 'bitiş tarihi') : null,
    segment_size: req.query.segment_size ? Number(req.query.segment_size) : 20,
    weight_source: req.query.weight_source === 'kesif' ? 'kesif' : 'template',
    include_phase_tasks: req.query.include_phase_tasks !== 'false',
    include_crossing_tasks: req.query.include_crossing_tasks !== 'false',
    include_parcel_tasks: req.query.include_parcel_tasks !== 'false',
  };
  const preview = await buildAutoPlanPreview(projectId, opts);
  res.json(preview);
});

// Otomatik iş planı oluştur (iş grupları + görevler + saha ilerleme senkronizasyonu)
router.post('/auto-generate', async (req: Request, res: Response) => {
  const projectId = Number(req.body?.project_id);
  if (!Number.isInteger(projectId) || projectId <= 0) {
    return res.status(400).json({ error: 'Geçerli bir proje seçin.' });
  }
  const replaceExisting = req.body?.replace_existing !== false;
  const opts: AutoPlanOptions = {
    mode: (String(req.body?.mode || 'hybrid') as AutoPlanOptions['mode']) || 'hybrid',
    start_date: req.body?.start_date ? toDateOrNull(req.body.start_date, 'başlangıç tarihi') : null,
    end_date: req.body?.end_date ? toDateOrNull(req.body.end_date, 'bitiş tarihi') : null,
    segment_size: req.body?.segment_size ? Number(req.body.segment_size) : 20,
    weight_source: req.body?.weight_source === 'kesif' ? 'kesif' : 'template',
    include_phase_tasks: req.body?.include_phase_tasks !== false,
    include_crossing_tasks: req.body?.include_crossing_tasks !== false,
    include_parcel_tasks: req.body?.include_parcel_tasks !== false,
    replace_existing: replaceExisting,
  };

  const plan = await buildAutoPlanPreview(projectId, opts);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Proje başlangıç/bitiş tarihi boşsa veya sihirbazda seçildiyse güncelle
    await client.query(
      `UPDATE projects
       SET start_date = COALESCE($1, start_date),
           end_date = COALESCE($2, end_date)
       WHERE id = $3`,
      [plan.resolved_dates.start_date, plan.resolved_dates.end_date, projectId]
    );

    if (replaceExisting) {
      await client.query('DELETE FROM work_groups WHERE project_id = $1', [projectId]);
    }

    const groupIdByCode = new Map<string, number>();
    let createdGroups = 0;

    for (const g of plan.groups) {
      let finalCode = g.code;
      if (!replaceExisting) {
        const dup = await client.query('SELECT id FROM work_groups WHERE project_id = $1 AND code = $2', [
          projectId,
          finalCode,
        ]);
        if ((dup.rowCount ?? 0) > 0) {
          groupIdByCode.set(g.code, dup.rows[0].id);
          continue;
        }
      }
      const ins = await client.query(
        `INSERT INTO work_groups
           (code, name, weight, progress, planned_start, planned_end, status, notes, segment_from, segment_to, saha_stage, project_id)
         VALUES ($1,$2,$3,0,$4,$5,'pending',$6,$7,$8,$9,$10)
         RETURNING id`,
        [
          finalCode,
          g.name,
          g.weight,
          g.planned_start,
          g.planned_end,
          g.notes,
          g.segment_from,
          g.segment_to,
          g.saha_stage || '',
          projectId,
        ]
      );
      groupIdByCode.set(g.code, ins.rows[0].id);
      createdGroups++;
    }

    let createdTasks = 0;
    for (const t of plan.tasks) {
      const wgId = groupIdByCode.get(t.group_code);
      if (!wgId) continue;
      await client.query(
        `INSERT INTO tasks (work_group_id, title, description, due_date, status, priority)
         VALUES ($1, $2, $3, $4, 'todo', $5)`,
        [wgId, t.title, t.description, t.due_date, t.priority]
      );
      createdTasks++;
    }

    const syncRes = await syncWorkGroupsFromSaha(projectId, true, client);
    await client.query('COMMIT');

    res.status(201).json({
      created_groups: createdGroups,
      created_tasks: createdTasks,
      synced_groups: syncRes.updated,
    });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
});

// Saha direk durumlarından iş grubu ilerlemelerini (progress + status) senkronize et
router.post('/sync-saha', async (req: Request, res: Response) => {
  const projectId = Number(req.body?.project_id ?? req.query.project_id);
  if (!Number.isInteger(projectId) || projectId <= 0) {
    return res.status(400).json({ error: 'Geçerli bir proje seçin.' });
  }
  const result = await syncWorkGroupsFromSaha(projectId, true);
  res.json(result);
});

async function nextCode(projectId: number): Promise<string> {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM work_groups WHERE project_id = $1', [projectId]);
  let idx = Number(rows[0].c) + 1;
  while (idx < 999) {
    const candidate = 'WG-' + String(idx).padStart(2, '0');
    const dup = await pool.query('SELECT 1 FROM work_groups WHERE project_id = $1 AND code = $2', [projectId, candidate]);
    if (dup.rowCount === 0) return candidate;
    idx++;
  }
  return 'WG-' + Date.now().toString().slice(-4);
}

function normalize(body: any) {
  const weight = Number(body.weight);
  const progress = Number(body.progress);
  const sf = body.segment_from === '' || body.segment_from == null ? null : Number(body.segment_from);
  const st = body.segment_to === '' || body.segment_to == null ? null : Number(body.segment_to);
  const sahaStage = String(body.saha_stage || '').trim();
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
    saha_stage: VALID_SAHA_STAGES.includes(sahaStage) ? sahaStage : '',
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

  const code = g.code || (await nextCode(g.project_id));
  const dup = await pool.query('SELECT 1 FROM work_groups WHERE project_id = $1 AND code = $2', [g.project_id, code]);
  if (dup.rowCount) return res.status(400).json({ error: `"${code}" kodu bu projede zaten kullanılıyor.` });

  const { rows } = await pool.query(
    `INSERT INTO work_groups (code, name, weight, progress, planned_start, planned_end, status, notes, segment_from, segment_to, saha_stage, project_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [code, g.name, g.weight, g.progress, g.planned_start, g.planned_end, g.status, g.notes, g.segment_from, g.segment_to, g.saha_stage, g.project_id]
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
  const dup = await pool.query('SELECT 1 FROM work_groups WHERE project_id = $1 AND code = $2 AND id != $3', [g.project_id, code, id]);
  if (dup.rowCount) return res.status(400).json({ error: `"${code}" kodu başka bir grupta kullanılıyor.` });

  const { rows } = await pool.query(
    `UPDATE work_groups SET code=$1, name=$2, weight=$3, progress=$4, planned_start=$5, planned_end=$6, status=$7, notes=$8,
            segment_from=$9, segment_to=$10, saha_stage=$11, project_id=$12
     WHERE id=$13 RETURNING *`,
    [code, g.name, g.weight, g.progress, g.planned_start, g.planned_end, g.status, g.notes, g.segment_from, g.segment_to, g.saha_stage, g.project_id, id]
  );
  const cnt = await pool.query(
    `SELECT COUNT(*)::int AS c,
            COUNT(*) FILTER (WHERE t.status = 'done')::int AS d,
            COUNT(*) FILTER (WHERE ${LATE_TASK_SQL})::int AS l
     FROM tasks t WHERE t.work_group_id = $1`,
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
