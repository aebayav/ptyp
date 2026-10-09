import { Router, Request, Response } from 'express';
import * as XLSX from 'xlsx';
import { pool } from '../db';
import { requireAuth, requireRole } from '../auth';

const router = Router();

// Dışa aktarma yalnızca iş sahibine açık (maliyet verileri içerir)
router.use(requireAuth, requireRole('owner'));

const MATERIAL_STATUS_TR = {
  open: 'Teklif Toplanıyor',
  evaluating: 'Değerlendirmede',
  ordered: 'Sipariş Verildi',
  delivered: 'Teslim Alındı',
} as Record<string, string>;

const QUOTE_STATUS_TR = {
  requested: 'Talep Edildi',
  received: 'Teklif Alındı',
  selected: 'Seçildi',
} as Record<string, string>;

const GROUP_STATUS_TR = { pending: 'Başlamadı', active: 'Devam Ediyor', completed: 'Tamamlandı' } as Record<string, string>;
const TASK_STATUS_TR = { todo: 'Yapılacak', in_progress: 'Devam Ediyor', done: 'Tamamlandı' } as Record<string, string>;
const PRIORITY_TR = { low: 'Düşük', normal: 'Normal', high: 'Yüksek' } as Record<string, string>;

function sheet(rows: (string | number | null)[][]) {
  return XLSX.utils.aoa_to_sheet(rows);
}

function sendXlsx(res: Response, wb: XLSX.WorkBook, filename: string) {
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.send(buf);
}

// ---------- Malzemeler ----------
router.get('/materials', async (_req: Request, res: Response) => {
  const { rows } = await pool.query(`
    SELECT m.code, m.name, m.category, m.spec, m.unit, m.quantity, m.target_price, m.status, m.notes,
           COUNT(q.id)::int AS quote_count
    FROM materials m LEFT JOIN quotes q ON q.material_id = m.id
    GROUP BY m.id ORDER BY m.code
  `);
  const data: (string | number | null)[][] = [
    ['Kod', 'Malzeme', 'Kategori', 'Teknik Özellik', 'Birim', 'Miktar', 'Hedef Fiyat (TRY)', 'Durum', 'Teklif Sayısı', 'Not'],
    ...rows.map((r: any) => [
      r.code, r.name, r.category, r.spec, r.unit, r.quantity, r.target_price,
      MATERIAL_STATUS_TR[r.status] || r.status, r.quote_count, r.notes,
    ]),
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet(data), 'Malzemeler');
  sendXlsx(res, wb, 'ptyp-malzemeler.xlsx');
});

// ---------- Satıcılar ----------
router.get('/suppliers', async (_req: Request, res: Response) => {
  const { rows } = await pool.query(`
    SELECT s.name, s.contact_name, s.phone, s.email, s.address, s.notes, COUNT(q.id)::int AS quote_count
    FROM suppliers s LEFT JOIN quotes q ON q.supplier_id = s.id
    GROUP BY s.id ORDER BY s.name
  `);
  const data: (string | number | null)[][] = [
    ['Firma', 'Yetkili', 'Telefon', 'E-posta', 'Adres', 'Teklif Sayısı', 'Not'],
    ...rows.map((r: any) => [r.name, r.contact_name, r.phone, r.email, r.address, r.quote_count, r.notes]),
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet(data), 'Satıcılar');
  sendXlsx(res, wb, 'ptyp-saticilar.xlsx');
});

// ---------- Teklifler + karşılaştırma özeti ----------
router.get('/quotes', async (_req: Request, res: Response) => {
  const { rows } = await pool.query(`
    SELECT q.price, q.currency, q.delivery_days, q.validity_date, q.status, q.notes, q.created_at,
           m.code AS material_code, m.name AS material_name, m.target_price,
           s.name AS supplier_name
    FROM quotes q
    JOIN materials m ON m.id = q.material_id
    JOIN suppliers s ON s.id = q.supplier_id
    ORDER BY m.code, q.price
  `);
  const quoteRows: (string | number | null)[][] = [
    ['Malzeme Kodu', 'Malzeme', 'Satıcı', 'Fiyat', 'Para Birimi', 'Teslim (gün)', 'Geçerlilik', 'Durum', 'Not'],
    ...rows.map((r: any) => [
      r.material_code, r.material_name, r.supplier_name, r.price, r.currency,
      r.delivery_days, r.validity_date, QUOTE_STATUS_TR[r.status] || r.status, r.notes,
    ]),
  ];

  // Karşılaştırma: malzeme başına en düşük teklif + hedef farkı
  const mats = await pool.query(`
    SELECT m.code, m.name, m.target_price
    FROM materials m LEFT JOIN quotes q ON q.material_id = m.id
    GROUP BY m.id ORDER BY m.code
  `);
  const best = await pool.query(`
    SELECT DISTINCT ON (material_id) material_id, supplier_id, price, currency
    FROM quotes ORDER BY material_id, price
  `);
  const sup = await pool.query('SELECT id, name FROM suppliers');
  const supMap = new Map(sup.rows.map((s: any) => [s.id, s.name]));
  const bestMap = new Map(best.rows.map((b: any) => [b.material_id, b]));

  const cmpRows: (string | number | null)[][] = [
    ['Malzeme Kodu', 'Malzeme', 'En İyi Satıcı', 'En İyi Fiyat', 'Para Birimi', 'Hedef Fiyat', 'Fark'],
  ];
  let total = 0;
  for (const m of mats.rows) {
    const b = bestMap.get(m.id);
    if (!b) {
      cmpRows.push([m.code, m.name, '—', null, '—', m.target_price, null]);
      continue;
    }
    const diff = m.target_price != null ? Number(b.price) - Number(m.target_price) : null;
    total += Number(b.price);
    cmpRows.push([m.code, m.name, supMap.get(b.supplier_id) || '—', b.price, b.currency, m.target_price, diff]);
  }
  cmpRows.push(['TOPLAM', '', '', total, '', '', '']);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet(quoteRows), 'Teklifler');
  XLSX.utils.book_append_sheet(wb, sheet(cmpRows), 'Karşılaştırma');
  sendXlsx(res, wb, 'ptyp-teklifler.xlsx');
});

// ---------- Direkler (KMZ güzergah) ----------
router.get('/poles', async (_req: Request, res: Response) => {
  const { rows } = await pool.query('SELECT name, lat, lon, alt, idx FROM poles ORDER BY idx');
  const data: (string | number | null)[][] = [
    ['Sıra', 'Direk', 'Enlem', 'Boylam', 'Rakım (m)'],
    ...rows.map((p: any, i: number) => [i + 1, p.name, p.lat, p.lon, p.alt]),
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet(data), 'Direkler');
  sendXlsx(res, wb, 'ptyp-direkler.xlsx');
});

// ---------- İş takibi (gruplar + görevler) ----------
router.get('/worktracking', async (_req: Request, res: Response) => {
  const groups = await pool.query(`
    SELECT w.code, w.name, w.weight, w.progress, w.status, w.planned_start, w.planned_end, w.notes,
           COUNT(t.id)::int AS task_count,
           COUNT(t.id) FILTER (WHERE t.status = 'done')::int AS done_count
    FROM work_groups w LEFT JOIN tasks t ON t.work_group_id = w.id
    GROUP BY w.id ORDER BY w.code
  `);
  const tasks = await pool.query(`
    SELECT w.code AS group_code, t.title, t.description, u.display_name AS assignee,
           t.due_date, t.priority, t.status
    FROM tasks t
    JOIN work_groups w ON w.id = t.work_group_id
    LEFT JOIN users u ON u.id = t.assignee_id
    ORDER BY w.code, t.due_date
  `);

  const groupRows: (string | number | null)[][] = [
    ['Kod', 'İş Grubu', 'Ağırlık %', 'İlerleme %', 'Durum', 'Başlangıç', 'Bitiş', 'Görev (tamam/toplam)', 'Not'],
    ...groups.rows.map((g: any) => [
      g.code, g.name, g.weight, g.progress, GROUP_STATUS_TR[g.status] || g.status,
      g.planned_start, g.planned_end, `${g.done_count}/${g.task_count}`, g.notes,
    ]),
  ];
  const taskRows: (string | number | null)[][] = [
    ['Grup', 'Görev', 'Açıklama', 'Atanan', 'Termin', 'Öncelik', 'Durum'],
    ...tasks.rows.map((t: any) => [
      t.group_code, t.title, t.description, t.assignee || '', t.due_date,
      PRIORITY_TR[t.priority] || t.priority, TASK_STATUS_TR[t.status] || t.status,
    ]),
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet(groupRows), 'İş Grupları');
  XLSX.utils.book_append_sheet(wb, sheet(taskRows), 'Görevler');
  sendXlsx(res, wb, 'ptyp-is-takibi.xlsx');
});

export default router;
