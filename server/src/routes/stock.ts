// Depo & stok: irsaliye ile giriş, şantiyeye sevk, sarfiyat.
// Kalan stok = giriş − (sevk + sarfiyat). Keşif miktarı ile yan yana karşılaştırma.
import { Router, Request, Response } from 'express';
import { pool } from '../db';
import { requireAuth, requireRole, AuthedRequest } from '../auth';
import { generateKesifItems } from './kesif';
import { DtlHeader, DtlRow } from '../dtl-parser';

const router = Router();

// Depo ofis işi — yalnız iş sahibi
router.use(requireAuth, requireRole('owner'));

export const MOVEMENT_TYPES: Record<string, { label: string; sign: number }> = {
  giris: { label: 'Giriş', sign: 1 },
  sevk: { label: 'Sevk', sign: -1 },
  sarfiyat: { label: 'Sarfiyat', sign: -1 },
};

export function normalizeStockMaterialName(s: string): string {
  return String(s || '')
    .toLowerCase()
    .replace(/ı/g, 'i')
    .replace(/i̇/g, 'i')
    .replace(/ğ/g, 'g')
    .replace(/ü/g, 'u')
    .replace(/ş/g, 's')
    .replace(/ö/g, 'o')
    .replace(/ç/g, 'c')
    .replace(/\s*[—–-]\s*temin\s+ve\s+montaj\s*$/i, '')
    .replace(/\s*[—–-]\s*/g, ' - ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isStockableKesifItem(itemName: string, unit: string): boolean {
  const norm = normalizeStockMaterialName(itemName);
  if (!norm) return false;
  if (norm.includes('hat uzunlugu') || norm.includes('guzergah uzunlugu')) return false;
  if (String(unit || '').toLowerCase() === 'km' && norm.includes('uzunlu')) return false;
  return true;
}

export function buildStockSummary(matRows: any[], movRows: any[], kesifRows: any[]) {
  const mov = new Map(movRows.map((r: any) => [Number(r.material_id), r]));
  const kesifQty = (name: string) => {
    const target = normalizeStockMaterialName(name);
    const hit = kesifRows.find((k: any) => normalizeStockMaterialName(k.item_name) === target);
    return hit ? Number(hit.qty) : null;
  };

  return matRows.map((m: any) => {
    const r = mov.get(Number(m.id)) || { total_in: 0, total_out: 0 };
    const totalIn = Number(r.total_in) || 0;
    const totalOut = Number(r.total_out) || 0;
    const remaining = Math.round((totalIn - totalOut) * 1000) / 1000;
    const kesif = kesifQty(m.name);

    let stock_status: 'no_entry' | 'deficit' | 'depleted' | 'critical' | 'sufficient' = 'sufficient';
    if (remaining < 0) {
      stock_status = 'deficit';
    } else if (totalIn === 0 && totalOut === 0) {
      stock_status = 'no_entry';
    } else if (remaining === 0) {
      stock_status = 'depleted';
    } else if (kesif != null && kesif > 0 && remaining < kesif * 0.1) {
      stock_status = 'critical';
    }

    return {
      material_id: m.id,
      code: m.code,
      name: m.name,
      unit: m.unit,
      spec: m.spec,
      target_price: m.target_price,
      kesif,
      total_in: totalIn,
      total_out: totalOut,
      remaining,
      stock_status,
    };
  });
}

async function generateUniqueMaterialCode(): Promise<string> {
  const { rows } = await pool.query('SELECT id, code FROM materials');
  const existingCodes = new Set(rows.map((r: any) => String(r.code || '').toUpperCase()));
  let seq = rows.reduce((max: number, r: any) => Math.max(max, Number(r.id) || 0), 0) + 1;
  while (existingCodes.has(`M-${String(seq).padStart(3, '0')}`)) {
    seq++;
  }
  return `M-${String(seq).padStart(3, '0')}`;
}

async function ensureKesifAndSyncMaterials(projectId: number): Promise<{ added: number }> {
  // 1) Projede kesif_items boşsa ve project_dtl varsa otomatik keşif kalemlerini oluştur
  let kesifRes = await pool.query(
    'SELECT item_name, unit, qty, unit_price, notes FROM kesif_items WHERE project_id = $1 ORDER BY position, id',
    [projectId]
  );
  if (kesifRes.rowCount === 0) {
    const dtlRes = await pool.query('SELECT header, rows FROM project_dtl WHERE project_id = $1', [projectId]);
    const dtlRows: DtlRow[] = Array.isArray(dtlRes.rows[0]?.rows) ? dtlRes.rows[0].rows : [];
    if (dtlRows.length > 0) {
      const header: DtlHeader = dtlRes.rows[0]?.header || {};
      const generated = generateKesifItems(header, dtlRows);
      for (let i = 0; i < generated.length; i++) {
        const it = generated[i];
        await pool.query(
          `INSERT INTO kesif_items (project_id, position, item_name, unit, qty, unit_price, notes)
           VALUES ($1, $2, $3, $4, $5, 0, $6)`,
          [projectId, i, it.item_name, it.unit || 'adet', Number(it.qty) || 0, it.notes || '']
        );
      }
      kesifRes = await pool.query(
        'SELECT item_name, unit, qty, unit_price, notes FROM kesif_items WHERE project_id = $1 ORDER BY position, id',
        [projectId]
      );
    }
  }

  // 2) Keşif kalemlerinden henüz materials tablosunda olmayanları otomatik ekle
  const matRes = await pool.query('SELECT id, name, code FROM materials');
  const existingNorm = new Set(matRes.rows.map((m: any) => normalizeStockMaterialName(m.name)));
  const existingCodes = new Set(matRes.rows.map((m: any) => String(m.code || '').toUpperCase()));
  let nextSeq = matRes.rows.reduce((max: number, r: any) => Math.max(max, Number(r.id) || 0), 0) + 1;

  let added = 0;
  for (const k of kesifRes.rows) {
    if (!isStockableKesifItem(k.item_name, k.unit)) continue;
    const normName = normalizeStockMaterialName(k.item_name);
    if (existingNorm.has(normName)) continue;

    while (existingCodes.has(`M-${String(nextSeq).padStart(3, '0')}`)) {
      nextSeq++;
    }
    const code = `M-${String(nextSeq).padStart(3, '0')}`;
    existingCodes.add(code);
    existingNorm.add(normName);

    const cleanName = String(k.item_name || '')
      .replace(/\s*[—–-]\s*Temin\s+ve\s+Montaj\s*$/i, '')
      .trim();
    const category = cleanName.toLowerCase().includes('direk') || cleanName.toLowerCase().includes('portal')
      ? 'Direk / Çelik'
      : cleanName.toLowerCase().includes('iletken')
      ? 'İletken & Tel'
      : cleanName.toLowerCase().includes('izolat')
      ? 'İzolatör & Hırdavat'
      : 'Keşif Kalemi';

    await pool.query(
      `INSERT INTO materials (code, name, category, spec, unit, quantity, target_price, status, notes)
       VALUES ($1, $2, $3, '', $4, $5, $6, 'open', $7)`,
      [
        code,
        cleanName || k.item_name,
        category,
        String(k.unit || 'adet').slice(0, 20),
        Math.max(1, Number(k.qty) || 1),
        Number(k.unit_price) > 0 ? Number(k.unit_price) : null,
        String(k.notes || '').slice(0, 250),
      ]
    );
    added++;
  }

  return { added };
}

// Stok özeti: malzeme bazında keşif / gelen / harcanan / kalan
router.get('/', async (req: Request, res: Response) => {
  const pid = Number(req.query.project_id);
  if (!Number.isInteger(pid) || pid <= 0) return res.status(400).json({ error: 'Geçerli bir proje seçin.' });

  await ensureKesifAndSyncMaterials(pid);

  const [{ rows: matRows }, { rows: movRows }, { rows: kesifRows }] = await Promise.all([
    pool.query('SELECT id, name, code, unit, spec, target_price, category FROM materials ORDER BY code, name'),
    pool.query(
      `SELECT material_id,
              SUM(qty) FILTER (WHERE movement_type = 'giris')::float AS total_in,
              SUM(qty) FILTER (WHERE movement_type IN ('sevk','sarfiyat'))::float AS total_out
       FROM stock_movements WHERE project_id = $1 GROUP BY material_id`,
      [pid]
    ),
    pool.query('SELECT item_name, SUM(qty)::float AS qty FROM kesif_items WHERE project_id = $1 GROUP BY item_name', [pid]),
  ]);

  const summary = buildStockSummary(matRows, movRows, kesifRows);
  res.json({ summary, materials: matRows, kesif_count: kesifRows.length });
});

// Keşif kalemlerini malzemelere manuel eşitle
router.post('/sync-kesif', async (req: Request, res: Response) => {
  const pid = Number(req.body?.project_id);
  if (!Number.isInteger(pid) || pid <= 0) return res.status(400).json({ error: 'Geçerli bir proje seçin.' });
  const { added } = await ensureKesifAndSyncMaterials(pid);
  const { rows: matRows } = await pool.query('SELECT id, name, code, unit, spec, target_price, category FROM materials ORDER BY code, name');
  res.json({ added, materials: matRows });
});

// Son hareketler
router.get('/movements', async (req: Request, res: Response) => {
  const pid = Number(req.query.project_id);
  if (!Number.isInteger(pid) || pid <= 0) return res.status(400).json({ error: 'Geçerli bir proje seçin.' });
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const { rows } = await pool.query(
    `SELECT sm.*, m.name AS material_name, m.unit AS material_unit, s.name AS supplier_name,
            sr.item_name AS request_item
     FROM stock_movements sm
     JOIN materials m ON m.id = sm.material_id
     LEFT JOIN suppliers s ON s.id = sm.supplier_id
     LEFT JOIN saha_requests sr ON sr.id = sm.saha_request_id
     WHERE sm.project_id = $1
     ORDER BY sm.created_at DESC, sm.id DESC
     LIMIT $2`,
    [pid, limit]
  );
  res.json(rows);
});

// Sevk bağlanabilir saha talepleri
router.get('/requests', async (req: Request, res: Response) => {
  const pid = Number(req.query.project_id);
  if (!Number.isInteger(pid) || pid <= 0) return res.status(400).json({ error: 'Geçerli bir proje seçin.' });
  const { rows } = await pool.query(
    `SELECT id, item_name, qty, unit, pole_ref, status FROM saha_requests
     WHERE project_id = $1 AND status IN ('open','fulfilled')
     ORDER BY id DESC LIMIT 100`,
    [pid]
  );
  res.json(rows);
});

router.post('/movements', async (req: Request, res: Response) => {
  const u = req as AuthedRequest;
  const pid = Number(req.body?.project_id);
  const mtype = String(req.body?.movement_type || 'giris');
  const qty = Number(req.body?.qty);
  if (!Number.isInteger(pid) || pid <= 0) return res.status(400).json({ error: 'Geçerli bir proje seçin.' });
  if (!MOVEMENT_TYPES[mtype]) return res.status(400).json({ error: 'Geçersiz hareket tipi.' });
  if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ error: 'Miktar pozitif bir sayı olmalı.' });

  let material_id = Number(req.body?.material_id);
  const newMatName = String(req.body?.new_material_name || '').trim();
  let matUnit = String(req.body?.unit || 'adet').trim() || 'adet';

  if ((!Number.isInteger(material_id) || material_id <= 0) && newMatName) {
    // Aynı isimde malzeme varsa onu kullan, yoksa yeni oluştur
    const allMats = await pool.query('SELECT id, name, unit FROM materials');
    const existing = allMats.rows.find(
      (m: any) => normalizeStockMaterialName(m.name) === normalizeStockMaterialName(newMatName)
    );
    if (existing) {
      material_id = Number(existing.id);
      matUnit = String(req.body?.unit || existing.unit || 'adet');
    } else {
      const code = String(req.body?.new_material_code || '').trim() || (await generateUniqueMaterialCode());
      const created = await pool.query(
        `INSERT INTO materials (code, name, category, spec, unit, quantity, status)
         VALUES ($1, $2, $3, '', $4, $5, 'open') RETURNING id, unit`,
        [code, newMatName, String(req.body?.new_material_category || 'Genel').trim(), matUnit.slice(0, 20), qty]
      );
      material_id = Number(created.rows[0].id);
    }
  }

  if (!Number.isInteger(material_id) || material_id <= 0) {
    return res.status(400).json({ error: 'Malzeme seçin veya yeni malzeme adı girin.' });
  }

  const mat = await pool.query('SELECT unit FROM materials WHERE id = $1', [material_id]);
  if ((mat.rowCount ?? 0) === 0) return res.status(404).json({ error: 'Malzeme bulunamadı.' });

  const supplier_id = req.body?.supplier_id === '' || req.body?.supplier_id == null ? null : Number(req.body?.supplier_id);
  const saha_request_id =
    req.body?.saha_request_id === '' || req.body?.saha_request_id == null ? null : Number(req.body?.saha_request_id);

  const { rows } = await pool.query(
    `INSERT INTO stock_movements (project_id, material_id, movement_type, qty, unit, irsaliye_no, supplier_id, saha_request_id, note, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [
      pid,
      material_id,
      mtype,
      qty,
      String(req.body?.unit || mat.rows[0].unit || 'adet').slice(0, 20),
      String(req.body?.irsaliye_no || '').trim().slice(0, 40),
      supplier_id,
      saha_request_id,
      String(req.body?.note || '').trim().slice(0, 300),
      u.user?.id,
    ]
  );

  // Eğer sevk hareketi bir saha talebine bağlandıysa talebi karşılandı olarak işaretle
  if (mtype === 'sevk' && saha_request_id) {
    await pool.query(
      `UPDATE saha_requests
       SET status = 'fulfilled', fulfilled_by = $1, fulfilled_at = now()
       WHERE id = $2 AND project_id = $3`,
      [u.user?.id || null, saha_request_id, pid]
    );
  }

  res.status(201).json(rows[0]);
});

router.delete('/movements/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Geçersiz kayıt.' });
  const r = await pool.query('DELETE FROM stock_movements WHERE id = $1', [id]);
  if ((r.rowCount ?? 0) === 0) return res.status(404).json({ error: 'Kayıt bulunamadı.' });
  res.status(204).end();
});

export default router;
