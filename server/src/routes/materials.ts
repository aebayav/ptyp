import { Router, Request, Response } from 'express';
import { pool } from '../db';

const router = Router();

// Kategori listesi (formlardaki öneriler için)
router.get('/categories', async (_req: Request, res: Response) => {
  const { rows } = await pool.query(
    `SELECT DISTINCT category FROM materials WHERE category != '' ORDER BY category`
  );
  res.json(rows.map((r) => r.category));
});

// Tüm malzemeler (teklif sayısıyla birlikte)
router.get('/', async (_req: Request, res: Response) => {
  const { rows } = await pool.query(`
    SELECT m.*, COUNT(q.id)::int AS quote_count
    FROM materials m
    LEFT JOIN quotes q ON q.material_id = m.id
    GROUP BY m.id
    ORDER BY m.code
  `);
  res.json(rows);
});

async function nextCode(): Promise<string> {
  const { rows } = await pool.query('SELECT COALESCE(MAX(id), 0) AS m FROM materials');
  return 'M-' + String(Number(rows[0].m) + 1).padStart(3, '0');
}

function normalize(body: any) {
  const qty = Number(body.quantity);
  return {
    code: String(body.code || '').trim(),
    name: String(body.name || '').trim(),
    category: String(body.category || '').trim(),
    spec: String(body.spec || '').trim(),
    unit: String(body.unit || 'adet').trim() || 'adet',
    quantity: Number.isFinite(qty) && qty > 0 ? qty : 1,
    target_price:
      body.target_price === '' || body.target_price == null ? null : Number(body.target_price),
    status: String(body.status || 'open').trim() || 'open',
    notes: String(body.notes || '').trim(),
  };
}

async function codeTaken(code: string, excludeId?: number): Promise<boolean> {
  const { rows } = excludeId
    ? await pool.query('SELECT 1 FROM materials WHERE code = $1 AND id != $2', [code, excludeId])
    : await pool.query('SELECT 1 FROM materials WHERE code = $1', [code]);
  return rows.length > 0;
}

// Yeni malzeme
router.post('/', async (req: Request, res: Response) => {
  const m = normalize(req.body || {});
  if (!m.name) return res.status(400).json({ error: 'Malzeme adı zorunludur.' });

  const code = m.code || (await nextCode());
  if (await codeTaken(code)) {
    return res.status(400).json({ error: `"${code}" kodu zaten kullanılıyor. Lütfen farklı bir kod girin.` });
  }

  const { rows } = await pool.query(
    `INSERT INTO materials (code, name, category, spec, unit, quantity, target_price, status, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [code, m.name, m.category, m.spec, m.unit, m.quantity, m.target_price, m.status, m.notes]
  );
  res.status(201).json({ ...rows[0], quote_count: 0 });
});

// Malzeme güncelle
router.put('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const existing = await pool.query('SELECT 1 FROM materials WHERE id = $1', [id]);
  if (existing.rowCount === 0) return res.status(404).json({ error: 'Malzeme bulunamadı.' });

  const m = normalize(req.body || {});
  if (!m.name) return res.status(400).json({ error: 'Malzeme adı zorunludur.' });

  const code = m.code || (await nextCode().then((c) => c));
  const current = await pool.query('SELECT code FROM materials WHERE id = $1', [id]);
  const finalCode = m.code || current.rows[0].code;
  if (m.code && (await codeTaken(code, id))) {
    return res.status(400).json({ error: `"${code}" kodu başka bir malzemede kullanılıyor.` });
  }

  const { rows } = await pool.query(
    `UPDATE materials SET code=$1, name=$2, category=$3, spec=$4, unit=$5, quantity=$6,
            target_price=$7, status=$8, notes=$9 WHERE id=$10 RETURNING *`,
    [finalCode, m.name, m.category, m.spec, m.unit, m.quantity, m.target_price, m.status, m.notes, id]
  );
  const cnt = await pool.query('SELECT COUNT(*)::int AS c FROM quotes WHERE material_id = $1', [id]);
  res.json({ ...rows[0], quote_count: cnt.rows[0].c });
});

// Malzeme sil (teklifleri de silinir)
router.delete('/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const r = await pool.query('DELETE FROM materials WHERE id = $1', [id]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'Malzeme bulunamadı.' });
  res.status(204).end();
});

export default router;
