import { Router, Request, Response } from 'express';
import { pool } from '../db';
import { requireAuth, requireRole } from '../auth';

const router = Router();

// Hakediş yönetimi yalnızca iş sahibine açık (dahili modül)
router.use(requireAuth, requireRole('owner'));

const VALID_STATUSES = ['draft', 'submitted', 'approved', 'paid'];

// 1. Hakedişleri listele
router.get('/', async (req: Request, res: Response) => {
  const pid = req.query.project_id;
  if (!pid) return res.status(400).json({ error: 'Geçerli bir proje seçin.' });

  const { rows } = await pool.query(`
    SELECT p.*,
           COUNT(i.id)::int AS item_count,
           COALESCE(SUM(i.current_qty * i.unit_price), 0) AS total_amount
    FROM progress_payments p
    LEFT JOIN progress_payment_items i ON i.payment_id = p.id
    WHERE p.project_id = $1
    GROUP BY p.id
    ORDER BY p.period_no DESC
  `, [Number(pid)]);
  res.json(rows);
});

// 2. Tek hakediş detayı (kalemleriyle)
router.get('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { rows: paymentRows } = await pool.query('SELECT * FROM progress_payments WHERE id = $1', [id]);
  if (paymentRows.length === 0) return res.status(404).json({ error: 'Hakediş bulunamadı.' });

  const { rows: items } = await pool.query(`
    SELECT i.*, w.name AS work_group_name
    FROM progress_payment_items i
    LEFT JOIN work_groups w ON w.id = i.work_group_id
    WHERE i.payment_id = $1
    ORDER BY i.id ASC
  `, [id]);

  res.json({ ...paymentRows[0], items });
});

// 3. Yeni hakediş
router.post('/', async (req: Request, res: Response) => {
  const { project_id, period_label, notes, items } = req.body;
  if (!project_id) return res.status(400).json({ error: 'Geçerli bir proje seçin.' });
  if (!period_label) return res.status(400).json({ error: 'Dönem adı zorunludur.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: maxRows } = await client.query('SELECT COALESCE(MAX(period_no), 0) AS max_no FROM progress_payments WHERE project_id = $1', [Number(project_id)]);
    const periodNo = Number(maxRows[0].max_no) + 1;

    const { rows: paymentRows } = await client.query(`
      INSERT INTO progress_payments (project_id, period_no, period_label, status, notes)
      VALUES ($1, $2, $3, 'draft', $4)
      RETURNING *
    `, [Number(project_id), periodNo, period_label, notes || '']);

    const payment = paymentRows[0];

    if (Array.isArray(items) && items.length > 0) {
      for (const item of items) {
        await client.query(`
          INSERT INTO progress_payment_items (payment_id, work_group_id, item_name, unit, contract_qty, previous_qty, current_qty, unit_price, notes)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `, [
          payment.id,
          item.work_group_id ? Number(item.work_group_id) : null,
          item.item_name || '',
          item.unit || 'adet',
          Number(item.contract_qty) || 0,
          Number(item.previous_qty) || 0,
          Number(item.current_qty) || 0,
          Number(item.unit_price) || 0,
          item.notes || ''
        ]);
      }
    }

    await client.query('COMMIT');
    res.status(201).json(payment);
  } catch (e: any) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// 4. Hakediş güncelle
router.put('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { period_label, notes, status, items } = req.body;

  if (!VALID_STATUSES.includes(status)) return res.status(400).json({ error: 'Geçersiz hakediş durumu.' });
  if (!period_label) return res.status(400).json({ error: 'Dönem adı zorunludur.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: existing } = await client.query('SELECT status FROM progress_payments WHERE id = $1', [id]);
    if (existing.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Hakediş bulunamadı.' });
    }

    const oldStatus = existing[0].status;

    let submittedAtFragment = '';
    let approvedAtFragment = '';
    const params = [period_label, notes || '', status, id];

    if (status === 'submitted' && oldStatus !== 'submitted') {
      submittedAtFragment = ', submitted_at = now()';
    } else if (status === 'approved' && oldStatus !== 'approved') {
      approvedAtFragment = ', approved_at = now()';
    }

    const { rows: paymentRows } = await client.query(`
      UPDATE progress_payments 
      SET period_label = $1, notes = $2, status = $3 ${submittedAtFragment} ${approvedAtFragment}
      WHERE id = $4
      RETURNING *
    `, params);

    const payment = paymentRows[0];

    if (Array.isArray(items)) {
      await client.query('DELETE FROM progress_payment_items WHERE payment_id = $1', [id]);
      for (const item of items) {
        await client.query(`
          INSERT INTO progress_payment_items (payment_id, work_group_id, item_name, unit, contract_qty, previous_qty, current_qty, unit_price, notes)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `, [
          payment.id,
          item.work_group_id ? Number(item.work_group_id) : null,
          item.item_name || '',
          item.unit || 'adet',
          Number(item.contract_qty) || 0,
          Number(item.previous_qty) || 0,
          Number(item.current_qty) || 0,
          Number(item.unit_price) || 0,
          item.notes || ''
        ]);
      }
    }

    await client.query('COMMIT');
    res.json(payment);
  } catch (e: any) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// 5. Hakediş sil
router.delete('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { rows } = await pool.query('SELECT status FROM progress_payments WHERE id = $1', [id]);
  if (rows.length === 0) return res.status(404).json({ error: 'Hakediş bulunamadı.' });
  if (rows[0].status !== 'draft') return res.status(400).json({ error: 'Sadece taslak durumundaki hakedişler silinebilir.' });

  await pool.query('DELETE FROM progress_payments WHERE id = $1', [id]);
  res.status(204).end();
});

// 6. İş gruplarından doldur
router.post('/:id/populate', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const { rows: paymentRows } = await client.query('SELECT * FROM progress_payments WHERE id = $1', [id]);
    if (paymentRows.length === 0) {
       await client.query('ROLLBACK');
       return res.status(404).json({ error: 'Hakediş bulunamadı.' });
    }
    const payment = paymentRows[0];
    const projectId = payment.project_id;

    const { rows: workGroups } = await client.query('SELECT * FROM work_groups WHERE project_id = $1 ORDER BY code', [projectId]);

    const { rows: prevItems } = await client.query(`
      SELECT i.work_group_id, SUM(i.current_qty) AS cumulative
      FROM progress_payment_items i
      JOIN progress_payments p ON p.id = i.payment_id
      WHERE p.project_id = $1 AND p.period_no < $2
      GROUP BY i.work_group_id
    `, [projectId, payment.period_no]);

    const prevMap = new Map();
    for (const r of prevItems) {
       prevMap.set(r.work_group_id, Number(r.cumulative));
    }

    await client.query('DELETE FROM progress_payment_items WHERE payment_id = $1', [id]);

    for (const wg of workGroups) {
      let unit = 'adet';
      const n = wg.name.toLowerCase();
      if (n.includes('beton') || n.includes('hafriyat') || n.includes('kazı')) unit = 'm³';
      else if (n.includes('demir') || n.includes('çelik') || n.includes('tel')) unit = 'ton';
      else if (n.includes('iletken') || n.includes('kablo')) unit = 'km';
      else if (n.includes('direk')) unit = 'adet';

      const prevQty = prevMap.get(wg.id) || 0;

      await client.query(`
        INSERT INTO progress_payment_items (payment_id, work_group_id, item_name, unit, contract_qty, previous_qty, current_qty, unit_price, notes)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `, [
        id,
        wg.id,
        wg.name,
        unit,
        Number(wg.weight) || 0,
        prevQty,
        0,
        0,
        ''
      ]);
    }

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (e: any) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

export default router;
