import { POLE_STATUSES } from './pole-statuses';

export interface HakedisExportInput {
  project: {
    id?: number;
    name: string;
    employer?: string;
    contract_no?: string;
    start_date?: string;
    end_date?: string;
    type?: string;
    capacity?: string;
  };
  payment: {
    id: number;
    period_no: number;
    period_label: string;
    status: string;
    notes?: string;
    submitted_at?: string | null;
    approved_at?: string | null;
    created_at?: string | null;
  };
  items: {
    id?: number;
    item_name: string;
    work_group_name?: string;
    unit: string;
    contract_qty: number | string;
    previous_qty: number | string;
    current_qty: number | string;
    unit_price: number | string;
    notes?: string;
  }[];
  poolEntries: {
    id?: number;
    pole_idx: number;
    pole_name: string;
    stage: string;
    tower_type?: string;
    pole_function?: string;
    item_name: string;
    unit: string;
    qty: number | string;
    unit_price?: number | string;
    decision_score?: number;
    gps_distance_m?: number | string | null;
    status?: string;
    created_at?: string;
    reviewed_at?: string;
    evidence_photo_id?: number | null;
  }[];
  priceIndices: {
    period: string;
    index_name: string;
    value: number | string;
    notes?: string;
  }[];
}

export interface HakedisEvidenceCard {
  pole_name: string;
  tower_type: string;
  pole_function: string;
  stage_label: string;
  item_name: string;
  qty_text: string;
  decision_score: number;
  gps_distance_m: number | null;
  created_at: string;
  data_uri: string | null;
}

const PAYMENT_STATUS_TR: Record<string, string> = {
  draft: 'Taslak',
  submitted: 'İdareye Sunuldu',
  approved: 'Onaylandı',
  paid: 'Ödendi',
};

function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function round4(n: number): number {
  return Math.round((Number(n) || 0) * 10000) / 10000;
}

function fmtTrMoney(n: number): string {
  return (Number(n) || 0).toLocaleString('tr-TR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }) + ' ₺';
}

function fmtTrNum(n: number, maxDecimals = 2): string {
  return (Number(n) || 0).toLocaleString('tr-TR', {
    maximumFractionDigits: maxDecimals,
  });
}

function escHtml(s: any): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function buildHakedisExportData(input: HakedisExportInput) {
  const { project, payment, items = [], poolEntries = [], priceIndices = [] } = input;

  let contractAmount = 0;
  let previousAmount = 0;
  let currentAmount = 0;

  const normalizedItems = items.map((it, idx) => {
    const cQty = Number(it.contract_qty) || 0;
    const pQty = Number(it.previous_qty) || 0;
    const curQty = Number(it.current_qty) || 0;
    const cumQty = pQty + curQty;
    const uPrice = Number(it.unit_price) || 0;

    const cAmt = round2(cQty * uPrice);
    const pAmt = round2(pQty * uPrice);
    const curAmt = round2(curQty * uPrice);
    const cumAmt = round2(pAmt + curAmt);

    contractAmount += cAmt;
    previousAmount += pAmt;
    currentAmount += curAmt;

    return {
      row_no: idx + 1,
      item_name: it.item_name || '',
      work_group_name: it.work_group_name || '',
      unit: it.unit || 'adet',
      contract_qty: cQty,
      previous_qty: pQty,
      current_qty: curQty,
      cumulative_qty: cumQty,
      unit_price: uPrice,
      contract_amount: cAmt,
      previous_amount: pAmt,
      current_amount: curAmt,
      cumulative_amount: cumAmt,
      notes: it.notes || '',
    };
  });

  contractAmount = round2(contractAmount);
  previousAmount = round2(previousAmount);
  currentAmount = round2(currentAmount);
  const cumulativeAmount = round2(previousAmount + currentAmount);

  // Fiyat farkı (Pn) hesabı: Aynı index_name için en eski (baz İ0) ve en yeni (cari İn) kaydı bul
  const sortedIndices = [...priceIndices]
    .filter((x) => Number(x.value) > 0 && x.period)
    .sort((a, b) => String(a.period).localeCompare(String(b.period)));

  let basePeriod = '';
  let currentPeriod = '';
  let indexName = 'TUFE';
  let baseIndexVal = 0;
  let currentIndexVal = 0;
  let pn = 1;
  let priceDiffAmount = 0;

  if (sortedIndices.length >= 2) {
    const first = sortedIndices[0];
    const sameSeries = sortedIndices.filter((x) => x.index_name === first.index_name);
    if (sameSeries.length >= 2) {
      const b = sameSeries[0];
      const c = sameSeries[sameSeries.length - 1];
      indexName = first.index_name;
      basePeriod = b.period;
      currentPeriod = c.period;
      baseIndexVal = Number(b.value);
      currentIndexVal = Number(c.value);
      pn = round4(currentIndexVal / baseIndexVal);
      priceDiffAmount = round2(currentAmount * (batchPnDiff(currentIndexVal, baseIndexVal)));
    }
  }

  const subtotalWithDiff = round2(currentAmount + priceDiffAmount);
  const vatRate = 0.2;
  const vatAmount = round2(subtotalWithDiff * vatRate);
  const grandTotal = round2(subtotalWithDiff + vatAmount);

  // 1. Sayfa: Hakediş Kapağı & İcmal Cetveli
  const kapakAndIcmalRows: (string | number | null)[][] = [
    ['RESMİ HAKEDİŞ KAPAĞI VE İCMAL CETVELİ'],
    ['Proje Adı', project.name || '—', 'Hakediş No', `#${payment.period_no}`],
    ['İşveren / İdare', project.employer || '—', 'Hakediş Dönemi', payment.period_label || '—'],
    ['Sözleşme No', project.contract_no || '—', 'Durum', PAYMENT_STATUS_TR[payment.status] || payment.status],
    ['Kapasite / Tip', `${(project.type || 'enh').toUpperCase()} ${project.capacity || ''}`.trim(), 'Notlar', payment.notes || '—'],
    [],
    ['POZ / SIRA', 'İŞ KALEMİ', 'İŞ GRUBU', 'BİRİM', 'SÖZLEŞME MİKTARI', 'ÖNCEKİ DÖNEM MİKTAR', 'BU DÖNEM MİKTAR', 'KÜMÜLATİF MİKTAR', 'BİRİM FİYAT (TRY)', 'ÖNCEKİ TUTAR (TRY)', 'BU DÖNEM TUTARI (TRY)', 'KÜMÜLATİF TUTAR (TRY)'],
    ...normalizedItems.map((it) => [
      it.row_no,
      it.item_name,
      it.work_group_name,
      it.unit,
      it.contract_qty,
      it.previous_qty,
      it.current_qty,
      it.cumulative_qty,
      it.unit_price,
      it.previous_amount,
      it.current_amount,
      it.cumulative_amount,
    ]),
    [],
    ['', 'İCMAL ÖZETİ', '', '', '', '', '', '', '', 'ÖNCEKİ (TRY)', 'BU DÖNEM (TRY)', 'KÜMÜLATİF (TRY)'],
    ['A', 'Yapılan İşler Tutarı (Birim Fiyat İcmali)', '', '', '', '', '', '', '', previousAmount, currentAmount, cumulativeAmount],
    ['B', `Fiyat Farkı Tutarı (${basePeriod && currentPeriod ? `${indexName}: ${basePeriod} → ${currentPeriod}, Pn=${pn}` : 'Endeks farkı yok'})`, '', '', '', '', '', '', '', 0, priceDiffAmount, priceDiffAmount],
    ['C', 'KDV Hariç Hakediş Toplamı (A + B)', '', '', '', '', '', '', '', previousAmount, subtotalWithDiff, round2(previousAmount + subtotalWithDiff)],
    ['D', 'KDV (%20)', '', '', '', '', '', '', '', round2(previousAmount * vatRate), vatAmount, round2((previousAmount + subtotalWithDiff) * vatRate)],
    ['E', 'GENEL HAKEDİŞ TOPLAMI (KDV DAHİL)', '', '', '', '', '', '', '', round2(previousAmount * 1.2), grandTotal, round2((previousAmount + subtotalWithDiff) * 1.2)],
  ];

  // 2. Sayfa: Yeşil Defter (Direk & Aşama Bazlı Doğrulanmış Metraj Cetveli)
  const normalizedPool = poolEntries.map((pe, idx) => {
    const stgLabel = POLE_STATUSES[pe.stage]?.label || pe.stage;
    const qty = Number(pe.qty) || 0;
    const uPrice = Number(pe.unit_price) || 0;
    return {
      row_no: idx + 1,
      pole_idx: pe.pole_idx,
      pole_name: pe.pole_name || `D-${pe.pole_idx}`,
      tower_type: pe.tower_type || 'Standart',
      pole_function: pe.pole_function || '',
      stage: pe.stage,
      stage_label: stgLabel,
      item_name: pe.item_name,
      unit: pe.unit || 'adet',
      qty,
      unit_price: uPrice,
      amount: round2(qty * uPrice),
      decision_score: Number(pe.decision_score ?? 85),
      gps_distance_m: pe.gps_distance_m != null ? Number(pe.gps_distance_m) : null,
      status: pe.status || 'ready',
      evidence_photo_id: pe.evidence_photo_id || null,
      created_at: pe.created_at || '',
    };
  });

  const yesilDefterRows: (string | number | null)[][] = [
    ['YEŞİL DEFTER — DİREK VE AŞAMA BAZLI DOĞRULANMIŞ METRAJ CETVELİ'],
    ['Proje', project.name || '—', 'Dönem', `#${payment.period_no} — ${payment.period_label}`],
    [],
    ['SIRA', 'DİREK NO', 'DİREK TİPİ', 'FONKSİYON', 'İMALAT AŞAMASI', 'METRAJ KALEMİ', 'BİRİM', 'MİKTAR / METRAJ', 'KANIT PUANI (/100)', 'KONUM SAPMASI (m)', 'DURUM'],
    ...(normalizedPool.length > 0
      ? normalizedPool.map((pe) => [
          pe.row_no,
          pe.pole_name,
          pe.tower_type,
          pe.pole_function || '—',
          pe.stage_label,
          pe.item_name,
          pe.unit,
          pe.qty,
          pe.decision_score,
          pe.gps_distance_m != null ? pe.gps_distance_m : 'Ofis/Manuel',
          pe.status === 'transferred' ? 'Bu Hakedişte' : pe.status === 'ready' ? 'Onaylı (Hazır)' : pe.status,
        ])
      : [['—', 'Bu dönem için direk bazlı saha havuzu kaydı bulunmuyor (kalem bazlı icmal kullanıldı).', '', '', '', '', '', '', '', '', '']]),
    [],
    ['', 'KALEM BAZLI METRAJ ÖZETİ', '', 'BİRİM', 'ÖNCEKİ MİKTAR', 'BU DÖNEM MİKTAR', 'KÜMÜLATİF MİKTAR', 'SÖZLEŞME MİKTARI', 'GERÇEKLEŞME %', '', ''],
    ...normalizedItems.map((it) => [
      it.row_no,
      it.item_name,
      it.work_group_name,
      it.unit,
      it.previous_qty,
      it.current_qty,
      it.cumulative_qty,
      it.contract_qty,
      it.contract_qty > 0 ? round2((it.cumulative_qty / it.contract_qty) * 100) : 0,
      '',
      '',
    ]),
  ];

  // 3. Sayfa: Fiyat Farkı (Pn) Hesap Tablosu
  const fiyatFarkiRows: (string | number | null)[][] = [
    ['FİYAT FARKI (Pn) HESAP TABLOSU'],
    ['Formül', 'Pn = İn / İo  ·  Fiyat Farkı = Hakediş Tutarı × (Pn − 1)'],
    ['Endeks Serisi', indexName, 'Baz Dönem (İo)', basePeriod || '—', 'Cari Dönem (İn)', currentPeriod || '—'],
    ['Baz Endeks (İo)', baseIndexVal || null, 'Cari Endeks (İn)', currentIndexVal || null, 'Pn Katsayısı', pn],
    ['Bu Dönem İmalat Tutarı (TRY)', currentAmount, 'Fiyat Farkı Tutarı (TRY)', priceDiffAmount, 'Fiyat Farkı Dahil Toplam (TRY)', subtotalWithDiff],
    [],
    ['DÖNEM (YYYY-AA)', 'ENDEKS ADI', 'ENDEKS DEĞERİ', 'AÇIKLAMA / KAYNAK'],
    ...sortedIndices.map((pi) => [pi.period, pi.index_name, Number(pi.value), pi.notes || '']),
  ];

  return {
    project,
    payment: {
      ...payment,
      status_label: PAYMENT_STATUS_TR[payment.status] || payment.status,
    },
    items: normalizedItems,
    poolEntries: normalizedPool,
    icmal: {
      contract_amount: contractAmount,
      previous_amount: previousAmount,
      current_amount: currentAmount,
      cumulative_amount: cumulativeAmount,
      index_name: indexName,
      base_period: basePeriod,
      current_period: currentPeriod,
      base_index: baseIndexVal,
      current_index: currentIndexVal,
      pn,
      price_diff_amount: priceDiffAmount,
      subtotal_with_diff: subtotalWithDiff,
      vat_rate: vatRate,
      vat_amount: vatAmount,
      grand_total: grandTotal,
    },
    sheets: {
      kapakAndIcmalRows,
      yesilDefterRows,
      fiyatFarkiRows,
    },
  };
}

function batchPnDiff(currentVal: number, baseVal: number): number {
  if (!baseVal || baseVal <= 0) return 0;
  return currentVal / baseVal - 1;
}

export function renderHakedisPrintableReportHtml(
  data: ReturnType<typeof buildHakedisExportData>,
  evidenceCards: HakedisEvidenceCard[] = []
): string {
  const { project, payment, items, poolEntries, icmal } = data;
  const nowStr = new Date().toLocaleDateString('tr-TR');

  const itemRowsHtml = items
    .map(
      (it) => `
      <tr>
        <td class="c">${it.row_no}</td>
        <td><b>${escHtml(it.item_name)}</b>${it.work_group_name ? `<div class="sub">${escHtml(it.work_group_name)}</div>` : ''}</td>
        <td class="c">${escHtml(it.unit)}</td>
        <td class="r">${fmtTrNum(it.contract_qty)}</td>
        <td class="r">${fmtTrNum(it.previous_qty)}</td>
        <td class="r"><b>${fmtTrNum(it.current_qty)}</b></td>
        <td class="r">${fmtTrNum(it.cumulative_qty)}</td>
        <td class="r">${fmtTrMoney(it.unit_price)}</td>
        <td class="r"><b>${fmtTrMoney(it.current_amount)}</b></td>
      </tr>`
    )
    .join('');

  const greenBookRowsHtml =
    poolEntries.length > 0
      ? poolEntries
          .map(
            (pe) => `
      <tr>
        <td class="c">${pe.row_no}</td>
        <td><b>${escHtml(pe.pole_name)}</b></td>
        <td class="c">${escHtml(pe.tower_type)}${pe.pole_function ? ` (${escHtml(pe.pole_function)})` : ''}</td>
        <td>${escHtml(pe.stage_label)}</td>
        <td>${escHtml(pe.item_name)}</td>
        <td class="c">${escHtml(pe.unit)}</td>
        <td class="r"><b>${fmtTrNum(pe.qty)}</b></td>
        <td class="c">${pe.decision_score}/100</td>
        <td class="c">${pe.gps_distance_m != null ? `Δ ${Math.round(pe.gps_distance_m)} m` : 'Manuel'}</td>
      </tr>`
          )
          .join('')
      : `<tr><td colspan="9" class="c muted">Bu dönem için direk bazlı saha havuzu kaydı bulunmuyor.</td></tr>`;

  const evidenceHtml =
    evidenceCards.length > 0
      ? `
      <div class="page-break"></div>
      <h2>3. SAHA KANIT ALBÜMÜ (DOĞRULANMIŞ DİREK İMALAT FOTOĞRAFLARI)</h2>
      <div class="album-grid">
        ${evidenceCards
          .map(
            (ev) => `
          <div class="album-card">
            ${
              ev.data_uri
                ? `<img src="${ev.data_uri}" alt="${escHtml(ev.pole_name)}" />`
                : `<div class="no-img">Görsel Yüklenemedi</div>`
            }
            <div class="album-meta">
              <div><b>${escHtml(ev.pole_name)}</b> (${escHtml(ev.tower_type)}${ev.pole_function ? ` · ${escHtml(ev.pole_function)}` : ''}) — <b>${escHtml(ev.stage_label)}</b></div>
              <div>${escHtml(ev.item_name)}: <b>${escHtml(ev.qty_text)}</b></div>
              <div class="sub">Kanıt Puanı: ${ev.decision_score}/100 · Konum: ${ev.gps_distance_m != null ? `Δ ${Math.round(ev.gps_distance_m)} m` : 'Ofis'} · ${escHtml(ev.created_at)}</div>
            </div>
          </div>`
          )
          .join('')}
      </div>`
      : '';

  return `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<title>Hakediş #${payment.period_no} (${escHtml(payment.period_label)}) — Yeşil Defter & İcmal Raporu</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", system-ui, -apple-system, sans-serif; color: #0f172a; margin: 0; padding: 20px; font-size: 12px; background: #f8fafc; }
  .sheet { max-width: 1020px; margin: 0 auto; background: #fff; padding: 26px 30px; border: 1px solid #cbd5e1; border-radius: 8px; }
  .toolbar { max-width: 1020px; margin: 0 auto 12px; display: flex; justify-content: space-between; align-items: center; background: #0d1f3c; color: #fff; padding: 10px 16px; border-radius: 8px; }
  .toolbar button { background: #f5a623; color: #0d1f3c; border: none; font-weight: 700; padding: 7px 14px; border-radius: 5px; cursor: pointer; font-size: 12.5px; }
  .doc-head { border-bottom: 2px solid #0d1f3c; padding-bottom: 10px; margin-bottom: 14px; display: flex; justify-content: space-between; align-items: flex-start; }
  .doc-head h1 { margin: 0 0 4px; font-size: 18px; color: #0d1f3c; }
  .meta-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px 18px; background: #f1f5f9; padding: 10px 14px; border-radius: 6px; margin-bottom: 16px; border: 1px solid #e2e8f0; }
  h2 { font-size: 13.5px; color: #0d1f3c; border-left: 4px solid #f5a623; padding-left: 8px; margin: 18px 0 8px; text-transform: uppercase; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 14px; font-size: 11.5px; }
  th, td { border: 1px solid #cbd5e1; padding: 5px 7px; vertical-align: middle; }
  th { background: #f1f5f9; font-weight: 700; text-align: left; }
  .r { text-align: right; font-variant-numeric: tabular-nums; }
  .c { text-align: center; }
  .sub { font-size: 10.5px; color: #64748b; }
  .muted { color: #64748b; }
  .icmal-box { width: 420px; margin-left: auto; }
  .sig-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; margin-top: 28px; padding-top: 12px; page-break-inside: avoid; }
  .sig-box { border: 1px solid #cbd5e1; border-radius: 6px; padding: 10px 12px; height: 95px; text-align: center; }
  .sig-box b { display: block; margin-bottom: 4px; color: #0d1f3c; }
  .album-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
  .album-card { border: 1px solid #cbd5e1; border-radius: 6px; overflow: hidden; page-break-inside: avoid; }
  .album-card img { width: 100%; height: 210px; object-fit: cover; display: block; background: #0f172a; }
  .album-meta { padding: 7px 10px; font-size: 11px; background: #f8fafc; }
  @media print {
    body { background: #fff; padding: 0; }
    .toolbar { display: none; }
    .sheet { border: none; padding: 0; max-width: none; }
    .page-break { page-break-before: always; }
  }
</style>
</head>
<body>
  <div class="toolbar">
    <div><b>PTYP Resmi Hakediş &amp; Yeşil Defter Raporu</b> — ${escHtml(project.name)} (${escHtml(payment.period_label)})</div>
    <button onclick="window.print()">🖨️ Yazdır / PDF Olarak Kaydet</button>
  </div>
  <div class="sheet">
    <div class="doc-head">
      <div>
        <h1>HAKEDİŞ İCMALİ VE YEŞİL DEFTER (METRAJ CETVELİ)</h1>
        <div class="sub">Proje: <b>${escHtml(project.name)}</b> · Hakediş No: <b>#${payment.period_no} (${escHtml(payment.period_label)})</b></div>
      </div>
      <div style="text-align:right">
        <div><b>Düzenleme Tarihi:</b> ${nowStr}</div>
        <div><b>Durum:</b> ${escHtml(payment.status_label)}</div>
      </div>
    </div>

    <div class="meta-grid">
      <div><b>İşveren / İdare:</b> ${escHtml(project.employer || '—')}</div>
      <div><b>Sözleşme No:</b> ${escHtml(project.contract_no || '—')}</div>
      <div><b>Proje Tipi / Kapasite:</b> ${escHtml((project.type || 'ENH').toUpperCase())} ${escHtml(project.capacity || '')}</div>
      <div><b>Takvim:</b> ${escHtml(project.start_date || '—')} → ${escHtml(project.end_date || '—')}</div>
    </div>

    <h2>1. HAKEDİŞ BİRİM FİYAT İCMAL CETVELİ</h2>
    <table>
      <thead>
        <tr>
          <th class="c" style="width:36px">Poz</th>
          <th>İş Kalemi / Açıklama</th>
          <th class="c" style="width:52px">Birim</th>
          <th class="r">Sözleşme</th>
          <th class="r">Önceki</th>
          <th class="r">Bu Dönem</th>
          <th class="r">Kümülatif</th>
          <th class="r">Birim Fiyat</th>
          <th class="r">Bu Dönem Tutarı</th>
        </tr>
      </thead>
      <tbody>
        ${itemRowsHtml}
      </tbody>
    </table>

    <table class="icmal-box">
      <tbody>
        <tr><td>Önceki Dönemler Kümülatif İmalat</td><td class="r">${fmtTrMoney(icmal.previous_amount)}</td></tr>
        <tr><td><b>Bu Dönem Yapılan İmalat Tutarı (A)</b></td><td class="r"><b>${fmtTrMoney(icmal.current_amount)}</b></td></tr>
        <tr>
          <td>Fiyat Farkı Kararnamesi Tutarı (B) ${icmal.base_period ? `<div class="sub">${escHtml(icmal.index_name)}: ${escHtml(icmal.base_period)} → ${escHtml(icmal.current_period)} (Pn = ${icmal.pn})</div>` : ''}</td>
          <td class="r">${fmtTrMoney(icmal.price_diff_amount)}</td>
        </tr>
        <tr><td><b>KDV Hariç Bu Dönem Toplamı (A + B)</b></td><td class="r"><b>${fmtTrMoney(icmal.subtotal_with_diff)}</b></td></tr>
        <tr><td>KDV (%20)</td><td class="r">${fmtTrMoney(icmal.vat_amount)}</td></tr>
        <tr style="background:#f1f5f9;font-size:13px"><td><b>ÖDENECEK TOPLAM TUTAR (KDV DAHİL)</b></td><td class="r"><b>${fmtTrMoney(icmal.grand_total)}</b></td></tr>
      </tbody>
    </table>

    <h2>2. YEŞİL DEFTER (DİREK &amp; AŞAMA BAZLI DOĞRULANMIŞ METRAJ DÖKÜMÜ)</h2>
    <table>
      <thead>
        <tr>
          <th class="c" style="width:36px">#</th>
          <th>Direk No</th>
          <th class="c">Tip / Fonksiyon</th>
          <th>İmalat Aşaması</th>
          <th>Metraj Kalemi</th>
          <th class="c">Birim</th>
          <th class="r">Miktar</th>
          <th class="c">Kanıt Puanı</th>
          <th class="c">GPS Sapma</th>
        </tr>
      </thead>
      <tbody>
        ${greenBookRowsHtml}
      </tbody>
    </table>

    <div class="sig-grid">
      <div class="sig-box">
        <b>YÜKLENİCİ / ŞANTİYE ŞEFİ</b>
        <span class="sub">Düzenleyen &amp; İmza</span>
      </div>
      <div class="sig-box">
        <b>KONTROL MÜHENDİSİ</b>
        <span class="sub">Kontrol Mühendisi &amp; Saha Metraj Onayı</span>
      </div>
      <div class="sig-box">
        <b>İDARE / BÖLGE MÜDÜRLÜĞÜ</b>
        <span class="sub">Onay</span>
      </div>
    </div>

    ${evidenceHtml}
  </div>
</body>
</html>`;
}
