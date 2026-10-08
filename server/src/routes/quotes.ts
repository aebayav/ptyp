import { Router, Request, Response } from 'express';
import { pool } from '../db';
import { AuthedRequest, requireAuth, requireRole } from '../auth';

const router = Router();

const VALID_STATUSES = ['requested', 'received', 'selected'];
const VALID_CURRENCIES = ['TRY', 'USD', 'EUR'];

const QUOTE_SELECT = `
  SELECT q.*, m.name AS material_name, m.code AS material_code, m.unit, m.quantity,
         s.name AS supplier_name
  FROM quotes q
  JOIN materials m ON m.id = q.material_id
  JOIN suppliers s ON s.id = q.supplier_id
`;

// Teklif listesi:
//  - owner: tüm teklifler (karşılaştırma için)
//  - supplier: yalnızca kendi teklifleri (diğer satıcıların fiyatları GİZLİ)
router.get('/', requireAuth, async (req: AuthedRequest, res: Response) => {
  const materialId = req.query.material_id;
  const params: any[] = [];
  let where = '';
  if (req.user!.role === 'supplier') {
    where += ` WHERE q.supplier_id = $${params.push(req.user!.supplier_id ?? -1)}`;
  }
  if (materialId) {
    params.push(Number(materialId));
    where += (where ? ' AND' : ' WHERE') + ` q.material_id = $${params.length}`;
  }
  const order = req.user!.role === 'supplier'
    ? ' ORDER BY q.created_at DESC'
    : ' ORDER BY q.price ASC, q.created_at DESC';
  const { rows } = await pool.query(QUOTE_SELECT + where + order, params);
  res.json(rows);
});

function normalize(body: any) {
  const price = Number(body.price);
  return {
    material_id: Number(body.material_id),
    supplier_id: Number(body.supplier_id),
    price: Number.isFinite(price) ? price : NaN,
    currency: String(body.currency || 'TRY').toUpperCase(),
    delivery_days:
      body.delivery_days === '' || body.delivery_days == null ? null : Number(body.delivery_days),
    validity_date: String(body.validity_date || '').trim(),
    status: String(body.status || 'received'),
    notes: String(body.notes || '').trim(),
  };
}

async function validate(q: any): Promise<string | null> {
  if (!Number.isInteger(q.material_id) || q.material_id <= 0) return 'Geçerli bir malzeme seçin.';
  if (!Number.isInteger(q.supplier_id) || q.supplier_id <= 0) return 'Geçerli bir satıcı seçin.';
  if (!Number.isFinite(q.price) || q.price <= 0) return "Teklif fiyatı 0'dan büyük olmalıdır.";
  if (!VALID_CURRENCIES.includes(q.currency)) return 'Para birimi TRY, USD veya EUR olmalıdır.';
  if (!VALID_STATUSES.includes(q.status)) return 'Geçersiz teklif durumu.';
  const m = await pool.query('SELECT 1 FROM materials WHERE id = $1', [q.material_id]);
  if (m.rowCount === 0) return 'Seçilen malzeme bulunamadı.';
  const s = await pool.query('SELECT 1 FROM suppliers WHERE id = $1', [q.supplier_id]);
  if (s.rowCount === 0) return 'Seçilen satıcı bulunamadı.';
  return null;
}

// Yeni teklif:
//  - owner: herhangi bir satıcı için girebilir
//  - supplier: yalnızca KENDİ firması adına, yalnızca "open" malzemelere verir
router.post('/', requireAuth, async (req: AuthedRequest, res: Response) => {
  const q = normalize(req.body || {});
  if (req.user!.role === 'supplier') {
    const sid = req.user!.supplier_id;
    if (!sid) {
      return res.status(403).json({ error: 'Hesabınız bir satıcı firmasına bağlı değil. Yöneticinizle iletişime geçin.' });
    }
    q.supplier_id = sid;
    q.status = 'received';
    const mat = await pool.query('SELECT status FROM materials WHERE id = $1', [q.material_id]);
    if (mat.rowCount === 0) return res.status(400).json({ error: 'Seçilen malzeme bulunamadı.' });
    if (mat.rows[0].status !== 'open') {
      return res.status(400).json({ error: 'Bu malzeme için teklif toplama kapatılmış.' });
    }
  }
  const err = await validate(q);
  if (err) return res.status(400).json({ error: err });

  const { rows } = await pool.query(
    `INSERT INTO quotes (material_id, supplier_id, price, currency, delivery_days, validity_date, status, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [q.material_id, q.supplier_id, q.price, q.currency, q.delivery_days, q.validity_date, q.status, q.notes]
  );
  const created = await pool.query(QUOTE_SELECT + ' WHERE q.id = $1', [rows[0].id]);
  res.status(201).json(created.rows[0]);
});

// Teklif güncelle: supplier yalnızca kendi (seçilmemiş) teklifini düzenleyebilir
router.put('/:id', requireAuth, async (req: AuthedRequest, res: Response) => {
  const id = Number(req.params.id);
  const existing = await pool.query('SELECT * FROM quotes WHERE id = $1', [id]);
  if (existing.rowCount === 0) return res.status(404).json({ error: 'Teklif bulunamadı.' });

  if (req.user!.role === 'supplier') {
    if (existing.rows[0].supplier_id !== req.user!.supplier_id) {
      return res.status(403).json({ error: 'Yalnızca kendi tekliflerinizi düzenleyebilirsiniz.' });
    }
    if (existing.rows[0].status === 'selected') {
      return res.status(400).json({ error: 'Seçilmiş bir teklif değiştirilemez. Yöneticinizle iletişime geçin.' });
    }
  }

  const q = normalize(req.body || {});
  if (req.user!.role === 'supplier') {
    const sid = req.user!.supplier_id;
    if (!sid) {
      return res.status(403).json({ error: 'Hesabınız bir satıcı firmasına bağlı değil. Yöneticinizle iletişime geçin.' });
    }
    q.supplier_id = sid;
    q.status = 'received';
  }
  const err = await validate(q);
  if (err) return res.status(400).json({ error: err });

  await pool.query(
    `UPDATE quotes SET material_id=$1, supplier_id=$2, price=$3, currency=$4, delivery_days=$5,
            validity_date=$6, status=$7, notes=$8, updated_at = now()
     WHERE id=$9`,
    [q.material_id, q.supplier_id, q.price, q.currency, q.delivery_days, q.validity_date, q.status, q.notes, id]
  );
  const updated = await pool.query(QUOTE_SELECT + ' WHERE q.id = $1', [id]);
  res.json(updated.rows[0]);
});

// Teklif sil: supplier yalnızca kendi (seçilmemiş) teklifini silebilir
router.delete('/:id', requireAuth, async (req: AuthedRequest, res: Response) => {
  const id = Number(req.params.id);
  const existing = await pool.query('SELECT * FROM quotes WHERE id = $1', [id]);
  if (existing.rowCount === 0) return res.status(404).json({ error: 'Teklif bulunamadı.' });

  if (req.user!.role === 'supplier') {
    if (existing.rows[0].supplier_id !== req.user!.supplier_id) {
      return res.status(403).json({ error: 'Yalnızca kendi tekliflerinizi silebilirsiniz.' });
    }
    if (existing.rows[0].status === 'selected') {
      return res.status(400).json({ error: 'Seçilmiş bir teklif silinemez. Yöneticinizle iletişime geçin.' });
    }
  }

  const r = await pool.query('DELETE FROM quotes WHERE id = $1', [id]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'Teklif bulunamadı.' });
  res.status(204).end();
});

// Teklifi "seçili" yap (yalnızca owner) — aynı malzemenin diğer seçili teklifleri geri alınır
router.post('/:id/select', requireAuth, requireRole('owner'), async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const quote = await pool.query('SELECT * FROM quotes WHERE id = $1', [id]);
  if (quote.rowCount === 0) return res.status(404).json({ error: 'Teklif bulunamadı.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE quotes SET status = 'selected', updated_at = now() WHERE id = $1`, [id]);
    await client.query(
      `UPDATE quotes SET status = 'received', updated_at = now()
       WHERE material_id = $1 AND id != $2 AND status = 'selected'`,
      [quote.rows[0].material_id, id]
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  res.json({ ok: true, selected_id: id });
});

// "Seçimi kaldır" (yalnızca owner)
router.post('/:id/unselect', requireAuth, requireRole('owner'), async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const r = await pool.query(
    `UPDATE quotes SET status = 'received', updated_at = now() WHERE id = $1`,
    [id]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'Teklif bulunamadı.' });
  res.json({ ok: true });
});

export default router;
