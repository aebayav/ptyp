// Keşif (BOQ) modülü: DTL verisinden otomatik keşif kalemleri üretir,
// düzenlenebilir kalem listesi saklar ve Excel dışa aktarımı yapar.
import { Router, Request, Response } from 'express';
import * as XLSX from 'xlsx';
import { pool } from '../db';
import { requireAuth, requireRole } from '../auth';
import { DtlHeader, DtlRow } from '../dtl-parser';

const router = Router();

// Keşif yalnızca iş sahibine açık (maliyet verileri içerir)
router.use(requireAuth, requireRole('owner'));

// ACSR çelik özlü alüminyum iletkenlerin yaklaşık ağırlıkları (kg/km, kuş kodları)
const CONDUCTOR_KG_KM: Record<string, number> = {
  RAVEN: 216,
  QUAIL: 271,
  PIGEON: 343,
  PENGUIN: 433,
  WAXWING: 541,
  PARTRIDGE: 541,
  OSPREY: 683,
  HEN: 975,
  HAWK: 975,
  DRAKE: 1610,
  CONDOR: 1610,
  TERN: 1610,
  CARDINAL: 1915,
  FINCH: 2240,
  BLUEJAY: 2240,
};

const round3 = (n: number) => Math.round(n * 1000) / 1000;

function numOrNull(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

interface GenItem {
  item_name: string;
  unit: string;
  qty: number;
  notes: string;
}

export function generateKesifItems(header: DtlHeader, rows: DtlRow[]): GenItem[] {
  const items: GenItem[] = [];

  // 1) Direk kalemleri — tip bazlı adetler
  const typeCount: Record<string, number> = {};
  for (const r of rows) {
    const t = (r.tower_type || '').trim().toUpperCase();
    const key = t || 'TİPİ BİLİNMEYEN';
    typeCount[key] = (typeCount[key] || 0) + 1;
  }
  const sortedTypes = Object.entries(typeCount).sort((a, b) => a[0].localeCompare(b[0], 'tr'));
  for (const [t, n] of sortedTypes) {
    let label: string;
    if (t === 'PORTAL') label = 'Portal Yapısı (Trafo Merkezi Girişi)';
    else if (t === 'TİPİ BİLİNMEYEN') label = 'Direk — Tipi Okunamadı';
    else label = `${t} Tipi Direk`;
    items.push({ item_name: `${label} — Temin ve Montaj`, unit: 'adet', qty: n, notes: '' });
  }

  // 2) Hat uzunluğu + 3) iletken miktarı
  const spans = rows.map((r) => numOrNull(r.span_m)).filter((n): n is number => n !== null);
  let totalSpan = spans.reduce((a, b) => a + b, 0);
  let lenNote = 'Direk araları (ara mesafe) toplamı';
  if (totalSpan <= 0) {
    const sts = rows.map((r) => numOrNull(r.station_m)).filter((n): n is number => n !== null);
    if (sts.length >= 2) {
      totalSpan = Math.max(...sts) - Math.min(...sts);
      lenNote = 'İstasyon aralığından türetildi (ara mesafeler okunamadı)';
    }
  }
  if (totalSpan > 0) {
    items.push({ item_name: 'Hat Uzunluğu (Güzergah)', unit: 'km', qty: round3(totalSpan / 1000), notes: lenNote });
    const cond = (header.conductor || '').trim().toUpperCase();
    if (cond) {
      const kgKey = Object.keys(CONDUCTOR_KG_KM).find((k) => cond.includes(k));
      if (kgKey) {
        items.push({
          item_name: `${cond} İletken (3 faz)`,
          unit: 'kg',
          qty: round3((totalSpan / 1000) * 3 * CONDUCTOR_KG_KM[kgKey]),
          notes: `3 faz × hat uzunluğu × ~${CONDUCTOR_KG_KM[kgKey]} kg/km`,
        });
      } else {
        items.push({
          item_name: `${cond} İletken (3 faz)`,
          unit: 'm',
          qty: round3(totalSpan * 3),
          notes: '3 faz × hat uzunluğu (ağırlık bilinmiyor — birim fiyatı m üzerinden verin)',
        });
      }
    } else {
      items.push({
        item_name: 'İletken Çekimi (3 faz)',
        unit: 'm',
        qty: round3(totalSpan * 3),
        notes: 'İletken tipi DTL başlığından okunamadı',
      });
    }
  }

  // 4) İzolatör takımları (set yoksa fonksiyondan türet)
  const sets: Record<string, number> = {};
  for (const r of rows) {
    const s = (r.insulator_set || '').trim().toUpperCase();
    if (s) sets[s] = (sets[s] || 0) + 1;
  }
  let aski = 0;
  let gergi = 0;
  if (Object.keys(sets).length > 0) {
    aski = (sets['A'] || 0) + 2 * (sets['ÇA'] || 0);
    gergi = 2 * (sets['ÇGÇG'] || 0);
  } else {
    for (const r of rows) {
      const f = (r.function || '').trim().toUpperCase();
      if (!f || f === 'PORTAL') continue;
      if (f === 'T') gergi += 1;
      else aski += 1;
    }
  }
  if (aski > 0) {
    items.push({
      item_name: 'Silikon İzolatör Takımı — Askı',
      unit: 'takım',
      qty: aski,
      notes: 'İzolatör setinden: A=1 takım, ÇA (çift askı)=2 takım',
    });
  }
  if (gergi > 0) {
    items.push({
      item_name: 'Silikon İzolatör Takımı — Gergi',
      unit: 'takım',
      qty: gergi,
      notes: 'İzolatör setinden: ÇGÇG (çift gergi)=2 takım',
    });
  }

  return items;
}

function buildSummary(rows: DtlRow[]) {
  const typeCount: Record<string, number> = {};
  let portalCount = 0;
  for (const r of rows) {
    const t = (r.tower_type || '').trim().toUpperCase();
    const key = t || 'TİPİ BİLİNMEYEN';
    typeCount[key] = (typeCount[key] || 0) + 1;
    if (t === 'PORTAL') portalCount++;
  }
  const spans = rows.map((r) => numOrNull(r.span_m)).filter((n): n is number => n !== null);
  const totalSpan = spans.reduce((a, b) => a + b, 0);
  const sts = rows.map((r) => numOrNull(r.station_m)).filter((n): n is number => n !== null);
  return {
    pole_count: rows.length,
    portal_count: portalCount,
    type_counts: Object.entries(typeCount)
      .sort((a, b) => a[0].localeCompare(b[0], 'tr'))
      .map(([type, count]) => ({ type, count })),
    total_span_m: round3(totalSpan),
    station_from: sts.length ? Math.min(...sts) : null,
    station_to: sts.length ? Math.max(...sts) : null,
  };
}

async function loadItems(projectId: number) {
  const { rows } = await pool.query(
    'SELECT id, position, item_name, unit, qty, unit_price, notes FROM kesif_items WHERE project_id = $1 ORDER BY position, id',
    [projectId]
  );
  return rows;
}

async function saveItems(projectId: number, items: GenItem[]) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM kesif_items WHERE project_id = $1', [projectId]);
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      await client.query(
        `INSERT INTO kesif_items (project_id, position, item_name, unit, qty, unit_price, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          projectId,
          i,
          String(it.item_name || '').trim(),
          String(it.unit || 'adet').trim() || 'adet',
          numOrNull(it.qty) || 0,
          numOrNull((it as any).unit_price) || 0,
          String((it as any).notes || ''),
        ]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return loadItems(projectId);
}

// Keşif verisini getir (kalem yoksa DTL'den otomatik üretip saklar)
router.get('/:id', async (req: Request, res: Response) => {
  const projectId = Number(req.params.id);
  if (!Number.isInteger(projectId) || projectId <= 0) {
    return res.status(400).json({ error: 'Geçerli bir proje seçin.' });
  }
  const proj = await pool.query('SELECT name FROM projects WHERE id = $1', [projectId]);
  if (proj.rowCount === 0) return res.status(404).json({ error: 'Proje bulunamadı.' });

  const dtl = await pool.query('SELECT * FROM project_dtl WHERE project_id = $1', [projectId]);
  const header: DtlHeader = dtl.rows[0]?.header || {
    title: '',
    voltage_kv: '',
    conductor: '',
    line_name: '',
    notes: '',
  };
  const rows: DtlRow[] = Array.isArray(dtl.rows[0]?.rows) ? dtl.rows[0].rows : [];

  let items = await loadItems(projectId);
  if (items.length === 0 && rows.length > 0) {
    items = await saveItems(projectId, generateKesifItems(header, rows));
  }

  res.json({
    project_name: proj.rows[0].name,
    dtl: {
      header,
      row_count: rows.length,
      file_name: dtl.rows[0]?.file_name || null,
      source: dtl.rows[0]?.source || null,
      updated_at: dtl.rows[0]?.updated_at || null,
    },
    summary: buildSummary(rows),
    items,
  });
});

// Keşif kalemlerini DTL verisinden yeniden üret (mevcut düzenlemeler silinir)
router.post('/:id/regenerate', async (req: Request, res: Response) => {
  const projectId = Number(req.params.id);
  if (!Number.isInteger(projectId) || projectId <= 0) {
    return res.status(400).json({ error: 'Geçerli bir proje seçin.' });
  }
  const proj = await pool.query('SELECT name FROM projects WHERE id = $1', [projectId]);
  if (proj.rowCount === 0) return res.status(404).json({ error: 'Proje bulunamadı.' });

  const dtl = await pool.query('SELECT * FROM project_dtl WHERE project_id = $1', [projectId]);
  const rows: DtlRow[] = Array.isArray(dtl.rows[0]?.rows) ? dtl.rows[0].rows : [];
  if (rows.length === 0) {
    return res
      .status(400)
      .json({ error: 'Bu projede DTL verisi yok — önce Belge → KMZ sayfasından DTL belgesini işleyin.' });
  }
  const header: DtlHeader = dtl.rows[0].header || {};
  const items = await saveItems(projectId, generateKesifItems(header, rows));
  res.json({ items, summary: buildSummary(rows), row_count: rows.length });
});

// Kalem listesini kaydet (düzenlenmiş haliyle değiştir)
router.put('/:id/items', async (req: Request, res: Response) => {
  const projectId = Number(req.params.id);
  if (!Number.isInteger(projectId) || projectId <= 0) {
    return res.status(400).json({ error: 'Geçerli bir proje seçin.' });
  }
  const proj = await pool.query('SELECT 1 FROM projects WHERE id = $1', [projectId]);
  if (proj.rowCount === 0) return res.status(404).json({ error: 'Proje bulunamadı.' });

  const raw = Array.isArray(req.body?.items) ? req.body.items : [];
  const items: GenItem[] = raw
    .map((it: any) => ({
      item_name: String(it?.item_name || '').trim(),
      unit: String(it?.unit || 'adet').trim() || 'adet',
      qty: numOrNull(it?.qty) || 0,
      unit_price: numOrNull(it?.unit_price) || 0,
      notes: String(it?.notes || ''),
    }))
    .filter((it: GenItem) => it.item_name);
  if (items.length === 0 && raw.length > 0) {
    return res.status(400).json({ error: 'Kalem adı boş olan satırlar kaydedilemez.' });
  }
  const saved = await saveItems(projectId, items);
  res.json({ items: saved });
});

// Excel dışa aktarımı: Keşif Özeti + DTL sayfaları
router.get('/:id/export', async (req: Request, res: Response) => {
  const projectId = Number(req.params.id);
  if (!Number.isInteger(projectId) || projectId <= 0) {
    return res.status(400).json({ error: 'Geçerli bir proje seçin.' });
  }
  const proj = await pool.query('SELECT name FROM projects WHERE id = $1', [projectId]);
  if (proj.rowCount === 0) return res.status(404).json({ error: 'Proje bulunamadı.' });

  const dtl = await pool.query('SELECT * FROM project_dtl WHERE project_id = $1', [projectId]);
  const header: DtlHeader = dtl.rows[0]?.header || {};
  const rows: DtlRow[] = Array.isArray(dtl.rows[0]?.rows) ? dtl.rows[0].rows : [];
  let items = await loadItems(projectId);
  if (items.length === 0 && rows.length > 0) {
    items = await saveItems(projectId, generateKesifItems(header, rows));
  }

  const projName = proj.rows[0].name;
  const info: (string | number)[][] = [
    ['Proje', projName],
    ['Hat', header.line_name || header.title || ''],
    ['Gerilim', header.voltage_kv || ''],
    ['İletken', header.conductor || ''],
    ['Kaynak Belge', dtl.rows[0]?.file_name || ''],
    ['Üretim Tarihi', dtl.rows[0]?.updated_at ? new Date(dtl.rows[0].updated_at).toLocaleString('tr-TR') : ''],
    ['Notlar', header.notes || ''],
  ];

  const itemRows: (string | number)[][] = [
    ['Sıra', 'İş Kalemi', 'Birim', 'Miktar', 'Birim Fiyat (₺)', 'Tutar (₺)', 'Not'],
  ];
  let total = 0;
  items.forEach((it: any, i: number) => {
    const qty = Number(it.qty) || 0;
    const price = Number(it.unit_price) || 0;
    const amount = qty * price;
    total += amount;
    itemRows.push([i + 1, it.item_name, it.unit, qty, price, round3(amount), it.notes]);
  });
  itemRows.push(['', 'TOPLAM', '', '', '', round3(total), '']);

  const keşifSheet = XLSX.utils.aoa_to_sheet([...info, [], ...itemRows]);
  keşifSheet['!cols'] = [{ wch: 14 }, { wch: 46 }, { wch: 8 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 50 }];

  const dtlRowsData: (string | number | null)[][] = [
    [
      'Sıra',
      'Direk No',
      'Direk Tipi',
      'Fonksiyon',
      'İstasyon',
      'Ara Mesafe (m)',
      'Rüzgar Açıklığı',
      'Ağırlık Açıklığı',
      'Hat Açısı (grad)',
      'Geçiş',
      'X (E)',
      'Y (N)',
      'Zemin Kotu',
      'İzolatör Seti',
      'İzolatör Adedi',
      'Buz Bölgesi',
      'Notlar',
    ],
  ];
  rows.forEach((r: DtlRow, i: number) => {
    dtlRowsData.push([
      i + 1,
      r.pole,
      r.tower_type,
      r.function,
      r.station_text,
      r.span_m,
      r.wind_span_m,
      r.weight_span_m,
      r.line_angle_grad,
      r.crossing,
      r.easting,
      r.northing,
      r.ground_elev_m,
      r.insulator_set,
      r.insulator_count,
      r.ice_zone,
      r.remarks,
    ]);
  });
  const dtlSheet = XLSX.utils.aoa_to_sheet(dtlRowsData);
  dtlSheet['!cols'] = [
    { wch: 6 }, { wch: 9 }, { wch: 12 }, { wch: 10 }, { wch: 11 }, { wch: 13 }, { wch: 12 },
    { wch: 12 }, { wch: 11 }, { wch: 22 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 11 },
    { wch: 11 }, { wch: 10 }, { wch: 24 },
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, keşifSheet, 'Keşif Özeti');
  XLSX.utils.book_append_sheet(wb, dtlSheet, 'DTL');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  res.setHeader(
    'Content-Disposition',
    `attachment; filename*=UTF-8''${encodeURIComponent(`kesif-${projName}.xlsx`)}`
  );
  res.send(buf);
});

export default router;
