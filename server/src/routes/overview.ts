import { Router, Request, Response } from 'express';
import { pool } from '../db';
import { requireAuth, requireRole } from '../auth';
import { LATE_TASK_SQL } from '../late-filter';

const router = Router();

// Genel bakış özeti yalnızca iş sahibine açık (bütçe verileri içerir)
router.use(requireAuth, requireRole('owner'));

router.get('/overview', async (_req: Request, res: Response) => {
  const [m, s, q, rq, wq, bt, prog, late, open, sp, sr, par, cert] = await Promise.all([
    pool.query('SELECT COUNT(*)::int AS c FROM materials'),
    pool.query('SELECT COUNT(*)::int AS c FROM suppliers'),
    pool.query('SELECT COUNT(*)::int AS c FROM quotes'),
    pool.query(`SELECT COUNT(*)::int AS c FROM quotes WHERE status = 'requested'`),
    pool.query(
      'SELECT COUNT(*)::int AS c FROM materials m WHERE NOT EXISTS (SELECT 1 FROM quotes q WHERE q.material_id = m.id)'
    ),
    pool.query('SELECT COALESCE(SUM(x.p), 0) AS t FROM (SELECT MIN(price) AS p FROM quotes GROUP BY material_id) x'),
    pool.query('SELECT COALESCE(SUM(progress * weight), 0) AS num, COALESCE(SUM(weight), 0) AS den FROM work_groups'),
    pool.query(`SELECT COUNT(*)::int AS c FROM tasks t WHERE ${LATE_TASK_SQL}`),
    pool.query(`SELECT COUNT(*)::int AS c FROM tasks WHERE status != 'done'`),
    pool.query(
      `SELECT COALESCE(SUM(CASE s.status
              WHEN 'excavation' THEN 15 WHEN 'foundation' THEN 30
              WHEN 'erection' THEN 50 WHEN 'fittings' THEN 70
              WHEN 'stringing' THEN 85 WHEN 'completed' THEN 100
              ELSE 0 END), 0) AS num,
              COUNT(p.id)::int AS cnt
       FROM poles p
       LEFT JOIN pole_status s ON s.project_id = p.project_id AND s.pole_idx = p.idx`
    ),
    pool.query(`SELECT COUNT(*)::int AS c FROM saha_requests WHERE status = 'open'`),
    pool.query(`SELECT COUNT(*)::int AS c FROM parcels WHERE easement_status = 'izinsiz'`),
    pool.query(`SELECT COUNT(*)::int AS c FROM certifications WHERE expiry_date IS NOT NULL AND expiry_date <= CURRENT_DATE + 30`),
  ]);
  const saha = sp.rows[0];

  const totalWeight = Number(prog.rows[0].den);
  let overallProgress: number;
  if (totalWeight > 0) {
    overallProgress = Math.round((Number(prog.rows[0].num) / totalWeight) * 10) / 10;
  } else {
    const avg = await pool.query('SELECT COALESCE(AVG(progress), 0) AS a FROM work_groups');
    overallProgress = Math.round(Number(avg.rows[0].a) * 10) / 10;
  }

  res.json({
    materials: m.rows[0].c,
    suppliers: s.rows[0].c,
    quotes: q.rows[0].c,
    requested: rq.rows[0].c,
    withoutQuotes: wq.rows[0].c,
    bestTotal: bt.rows[0].t,
    overallProgress,
    lateTasks: late.rows[0].c,
    openTasks: open.rows[0].c,
    sahaProgress: saha.cnt > 0 ? Math.round((Number(saha.num) / saha.cnt) * 10) / 10 : 0,
    sahaPoles: saha.cnt,
    openSahaRequests: sr.rows[0].c,
    unpermittedParcels: par.rows[0].c,
    expiringCerts: cert.rows[0].c,
  });
});

export default router;
