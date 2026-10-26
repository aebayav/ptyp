// Hakediş fiyat farkı: TÜİK endeks kayıtları + Pn formülü.
// Pn = İn / İo (cari endeks / baz endeks); Fark = Tutar × (Pn − 1).
// Kamu işlerinde resmi formül endeks ağırlıklarıyla (a,b,c...) çalışır; bu modül
// tek endeksli sade hesabı verir — ağırlıklı hesap endeks kayıtlarının üzerine eklenebilir.
import { Router, Request, Response } from 'express';
import { pool } from '../db';
import { requireAuth, requireRole } from '../auth';

const router = Router();
router.use(requireAuth, requireRole('owner'));

const PERIOD_RE = /^\d{4}-\d{2}$/;

function validPeriod(p: string): boolean {
  if (!PERIOD_RE.test(p)) return false;
  const m = Number(p.slice(5));
  return m >= 1 && m <= 12;
}

// Kayıtlı endeksler
router.get('/', async (req: Request, res: Response) => {
  const pid = Number(req.query.project_id);
  if (!Number.isInteger(pid) || pid <= 0) return res.status(400).json({ error: 'Geçerli bir proje seçin.' });
  const { rows } = await pool.query(
    `SELECT id, period, index_name, value, notes FROM price_indices
     WHERE project_id = $1 ORDER BY period DESC, index_name`,
    [pid]
  );
  res.json(rows);
});

router.post('/', async (req: Request, res: Response) => {
  const pid = Number(req.body?.project_id);
  const period = String(req.body?.period || '').trim();
  const index_name = String(req.body?.index_name || 'TUFE').trim().toUpperCase().slice(0, 20) || 'TUFE';
  const value = Number(req.body?.value);
  const notes = String(req.body?.notes || '').trim().slice(0, 200);
  if (!Number.isInteger(pid) || pid <= 0) return res.status(400).json({ error: 'Geçerli bir proje seçin.' });
  if (!validPeriod(period)) return res.status(400).json({ error: 'Periyot YYYY-AA biçiminde olmalı (ör. 2026-03).' });
  if (!Number.isFinite(value) || value <= 0) return res.status(400).json({ error: 'Endeks değeri pozitif bir sayı olmalı.' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO price_indices (project_id, period, index_name, value, notes)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (project_id, period, index_name) DO UPDATE SET value = EXCLUDED.value, notes = EXCLUDED.notes
       RETURNING *`,
      [pid, period, index_name, value, notes]
    );
    res.status(201).json(rows[0]);
  } catch (e: any) {
    if (e?.code === '23505') return res.status(400).json({ error: 'Bu periyot ve endeks için kayıt zaten var (güncellendi).' });
    throw e;
  }
});

router.delete('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Geçersiz kayıt.' });
  const r = await pool.query('DELETE FROM price_indices WHERE id = $1', [id]);
  if ((r.rowCount ?? 0) === 0) return res.status(404).json({ error: 'Kayıt bulunamadı.' });
  res.status(204).end();
});

// Pn hesabı: GET /api/fiyat-farki/compute?project_id=&index_name=&base=&current=&amount=
router.get('/compute', async (req: Request, res: Response) => {
  const pid = Number(req.query.project_id);
  const indexName = String(req.query.index_name || 'TUFE').toUpperCase();
  const base = String(req.query.base || '');
  const current = String(req.query.current || '');
  const amount = Number(req.query.amount);
  if (!Number.isInteger(pid) || pid <= 0) return res.status(400).json({ error: 'Geçerli bir proje seçin.' });
  if (!validPeriod(base) || !validPeriod(current)) {
    return res.status(400).json({ error: 'Baz ve cari periyot YYYY-AA biçiminde olmalı.' });
  }
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Tutar pozitif bir sayı olmalı.' });

  const { rows } = await pool.query(
    `SELECT period, value FROM price_indices
     WHERE project_id = $1 AND index_name = $2 AND period IN ($3, $4)`,
    [pid, indexName, base, current]
  );
  const b = rows.find((r: any) => r.period === base);
  const c = rows.find((r: any) => r.period === current);
  if (!b || !c) {
    return res.status(400).json({ error: 'Seçilen periyotlar için endeks kaydı bulunamadı. Önce endeks girin.' });
  }
  const baseValue = Number(b.value);
  const currentValue = Number(c.value);
  const pn = currentValue / baseValue;
  const fark = amount * (pn - 1);
  const ratio = fark / amount;
  res.json({
    index_name: indexName,
    base_period: base,
    current_period: current,
    base_value: baseValue,
    current_value: currentValue,
    pn: Math.round(pn * 10000) / 10000,
    amount,
    fark: Math.round(fark * 100) / 100,
    fark_yuzde: Math.round(ratio * 10000) / 100,
  });
});

export default router;
