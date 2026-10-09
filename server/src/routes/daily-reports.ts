import { Router, Request, Response } from 'express';
import { pool } from '../db';
import { requireAuth, requireRole, AuthedRequest } from '../auth';

const router = Router();

// Yalnızca iş sahibine açık
router.use(requireAuth as any, requireRole('owner') as any);

const VALID_WEATHER = ['', 'acik', 'bulutlu', 'yagmurlu', 'firtina', 'kar', 'sisli'];
const VALID_CREW_ROLES = ['muhendis', 'tekniker', 'usta', 'isci', 'taseron', 'diger'];
const VALID_EQUIPMENT_TYPES = ['vinc', 'kepce', 'kamyon', 'jenerator', 'kompressor', 'beton_pompasi', 'diger'];

// List reports for a project
router.get('/', async (req: Request, res: Response) => {
  const pid = req.query.project_id;
  if (!pid) return res.status(400).json({ error: 'Geçerli bir proje seçin (project_id).' });

  const { rows } = await pool.query(`
    SELECT dr.*,
           COALESCE((SELECT SUM(count) FROM daily_report_crew WHERE report_id = dr.id), 0)::int AS total_crew,
           COALESCE((SELECT SUM(count) FROM daily_report_equipment WHERE report_id = dr.id), 0)::int AS total_equipment
    FROM daily_reports dr
    WHERE dr.project_id = $1
    ORDER BY dr.report_date DESC
  `, [Number(pid)]);
  
  res.json(rows);
});

// Get single report with crew and equipment
router.get('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { rows } = await pool.query('SELECT * FROM daily_reports WHERE id = $1', [id]);
  if (rows.length === 0) return res.status(404).json({ error: 'Rapor bulunamadı.' });

  const report = rows[0];
  const crewReq = await pool.query('SELECT * FROM daily_report_crew WHERE report_id = $1 ORDER BY id', [id]);
  const eqReq = await pool.query('SELECT * FROM daily_report_equipment WHERE report_id = $1 ORDER BY id', [id]);

  res.json({
    ...report,
    crew: crewReq.rows,
    equipment: eqReq.rows
  });
});

// Create report
router.post('/', async (req: AuthedRequest, res: Response) => {
  const { project_id, report_date, weather, temperature, work_summary, issues, crew, equipment } = req.body;

  if (!Number.isInteger(project_id) || project_id <= 0) return res.status(400).json({ error: 'Geçerli bir proje seçin.' });
  if (!report_date) return res.status(400).json({ error: 'Tarih zorunludur.' });
  if (weather && !VALID_WEATHER.includes(weather)) return res.status(400).json({ error: 'Geçersiz hava durumu.' });

  const p = await pool.query('SELECT 1 FROM projects WHERE id = $1', [project_id]);
  if (p.rowCount === 0) return res.status(400).json({ error: 'Seçilen proje bulunamadı.' });

  const dup = await pool.query('SELECT 1 FROM daily_reports WHERE project_id = $1 AND report_date = $2', [project_id, report_date]);
  if (dup.rowCount) return res.status(400).json({ error: 'Bu tarih için zaten bir rapor var.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const { rows } = await client.query(
      `INSERT INTO daily_reports (project_id, report_date, weather, temperature, work_summary, issues, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [project_id, report_date, weather || '', Number(temperature) || 0, work_summary || '', issues || '', req.user?.id]
    );
    const reportId = rows[0].id;

    if (Array.isArray(crew)) {
      for (const c of crew) {
        const role = VALID_CREW_ROLES.includes(c.role) ? c.role : 'diger';
        const count = Number(c.count) || 0;
        if (count > 0) {
          await client.query(
            'INSERT INTO daily_report_crew (report_id, role, company, count) VALUES ($1, $2, $3, $4)',
            [reportId, role, c.company || '', count]
          );
        }
      }
    }

    if (Array.isArray(equipment)) {
      for (const e of equipment) {
        const type = VALID_EQUIPMENT_TYPES.includes(e.equipment_type) ? e.equipment_type : 'diger';
        const count = Number(e.count) || 0;
        if (count > 0) {
          await client.query(
            'INSERT INTO daily_report_equipment (report_id, equipment_type, description, count) VALUES ($1, $2, $3, $4)',
            [reportId, type, e.description || '', count]
          );
        }
      }
    }

    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// Update report
router.put('/:id', async (req: AuthedRequest, res: Response) => {
  const id = Number(req.params.id);
  const { report_date, weather, temperature, work_summary, issues, crew, equipment } = req.body;

  const existing = await pool.query('SELECT * FROM daily_reports WHERE id = $1', [id]);
  if (existing.rowCount === 0) return res.status(404).json({ error: 'Rapor bulunamadı.' });
  const project_id = existing.rows[0].project_id;

  if (!report_date) return res.status(400).json({ error: 'Tarih zorunludur.' });
  if (weather && !VALID_WEATHER.includes(weather)) return res.status(400).json({ error: 'Geçersiz hava durumu.' });

  const dup = await pool.query('SELECT 1 FROM daily_reports WHERE project_id = $1 AND report_date = $2 AND id != $3', [project_id, report_date, id]);
  if (dup.rowCount) return res.status(400).json({ error: 'Bu tarih için zaten bir rapor var.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const { rows } = await client.query(
      `UPDATE daily_reports SET report_date = $1, weather = $2, temperature = $3, work_summary = $4, issues = $5
       WHERE id = $6 RETURNING *`,
      [report_date, weather || '', Number(temperature) || 0, work_summary || '', issues || '', id]
    );

    await client.query('DELETE FROM daily_report_crew WHERE report_id = $1', [id]);
    if (Array.isArray(crew)) {
      for (const c of crew) {
        const role = VALID_CREW_ROLES.includes(c.role) ? c.role : 'diger';
        const count = Number(c.count) || 0;
        if (count > 0) {
          await client.query(
            'INSERT INTO daily_report_crew (report_id, role, company, count) VALUES ($1, $2, $3, $4)',
            [id, role, c.company || '', count]
          );
        }
      }
    }

    await client.query('DELETE FROM daily_report_equipment WHERE report_id = $1', [id]);
    if (Array.isArray(equipment)) {
      for (const e of equipment) {
        const type = VALID_EQUIPMENT_TYPES.includes(e.equipment_type) ? e.equipment_type : 'diger';
        const count = Number(e.count) || 0;
        if (count > 0) {
          await client.query(
            'INSERT INTO daily_report_equipment (report_id, equipment_type, description, count) VALUES ($1, $2, $3, $4)',
            [id, type, e.description || '', count]
          );
        }
      }
    }

    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// Delete report
router.delete('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const r = await pool.query('DELETE FROM daily_reports WHERE id = $1', [id]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'Rapor bulunamadı.' });
  res.status(204).end();
});

export default router;
