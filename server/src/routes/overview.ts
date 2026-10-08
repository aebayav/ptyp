import { Router, Request, Response } from 'express';
import { pool } from '../db';

const router = Router();

// Genel bakış özeti
router.get('/overview', async (_req: Request, res: Response) => {
  const [m, s, q, rq, wq, bt] = await Promise.all([
    pool.query('SELECT COUNT(*)::int AS c FROM materials'),
    pool.query('SELECT COUNT(*)::int AS c FROM suppliers'),
    pool.query('SELECT COUNT(*)::int AS c FROM quotes'),
    pool.query(`SELECT COUNT(*)::int AS c FROM quotes WHERE status = 'requested'`),
    pool.query(
      'SELECT COUNT(*)::int AS c FROM materials m WHERE NOT EXISTS (SELECT 1 FROM quotes q WHERE q.material_id = m.id)'
    ),
    pool.query('SELECT COALESCE(SUM(x.p), 0) AS t FROM (SELECT MIN(price) AS p FROM quotes GROUP BY material_id) x'),
  ]);
  res.json({
    materials: m.rows[0].c,
    suppliers: s.rows[0].c,
    quotes: q.rows[0].c,
    requested: rq.rows[0].c,
    withoutQuotes: wq.rows[0].c,
    bestTotal: bt.rows[0].t,
  });
});

export default router;
