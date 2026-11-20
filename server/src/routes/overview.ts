import { Router, Request, Response } from 'express';
import { pool } from '../db';
import { requireAuth, requireRole } from '../auth';
import { LATE_TASK_SQL } from '../late-filter';
import { buildPortfolio } from '../portfolio-summary';

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

// Portföy genel bakış: tüm projeleri ilerleme, hakediş ve uyarılarla tek yanıtta toplar.
// Satır sıralaması buildPortfolio içinde: uyarı çok → ilerleme yüksek.
router.get('/overview/portfolio', async (_req: Request, res: Response) => {
  const [projects, weighted, saha, lateTasks, parcels, expiringCerts, openRequests, payments] =
    await Promise.all([
      pool.query('SELECT id, name, type, capacity, employer, end_date FROM projects ORDER BY id'),
      pool.query(
        `SELECT project_id,
                COALESCE(SUM(progress * weight), 0)::float AS num,
                COALESCE(SUM(weight), 0)::float AS den,
                COALESCE(AVG(progress), 0)::float AS avg_progress
         FROM work_groups WHERE project_id IS NOT NULL GROUP BY project_id`
      ),
      // Saha ilerlemesi: overview'daki aşama ağırlıklarıyla (kazı 15 → tamam 100)
      pool.query(
        `SELECT p.project_id,
                COALESCE(SUM(CASE s.status
                        WHEN 'excavation' THEN 15 WHEN 'foundation' THEN 30
                        WHEN 'erection' THEN 50 WHEN 'fittings' THEN 70
                        WHEN 'stringing' THEN 85 WHEN 'completed' THEN 100
                        ELSE 0 END), 0)::float AS num,
                COUNT(p.id)::int AS cnt
         FROM poles p
         LEFT JOIN pole_status s ON s.project_id = p.project_id AND s.pole_idx = p.idx
         WHERE p.project_id IS NOT NULL
         GROUP BY p.project_id`
      ),
      pool.query(
        `SELECT w.project_id, COUNT(*)::int AS c
         FROM tasks t JOIN work_groups w ON w.id = t.work_group_id
         WHERE w.project_id IS NOT NULL AND ${LATE_TASK_SQL}
         GROUP BY w.project_id`
      ),
      pool.query(
        `SELECT project_id, COUNT(*)::int AS c FROM parcels
         WHERE project_id IS NOT NULL AND easement_status = 'izinsiz' GROUP BY project_id`
      ),
      pool.query(
        `SELECT project_id, COUNT(*)::int AS c FROM certifications
         WHERE project_id IS NOT NULL AND expiry_date IS NOT NULL AND expiry_date <= CURRENT_DATE + 30
         GROUP BY project_id`
      ),
      pool.query(
        `SELECT project_id, COUNT(*)::int AS c FROM saha_requests
         WHERE project_id IS NOT NULL AND status = 'open' GROUP BY project_id`
      ),
      pool.query(
        `SELECT pp.project_id, pp.status, COUNT(DISTINCT pp.id)::int AS c,
                COALESCE(SUM(i.current_qty * i.unit_price), 0)::float AS total
         FROM progress_payments pp
         LEFT JOIN progress_payment_items i ON i.payment_id = pp.id
         WHERE pp.project_id IS NOT NULL
         GROUP BY pp.project_id, pp.status`
      ),
    ]);

  res.json(
    buildPortfolio({
      projects: projects.rows,
      weighted: weighted.rows,
      saha: saha.rows,
      lateTasks: lateTasks.rows,
      parcels: parcels.rows,
      expiringCerts: expiringCerts.rows,
      openRequests: openRequests.rows,
      payments: payments.rows,
    })
  );
});

export default router;
