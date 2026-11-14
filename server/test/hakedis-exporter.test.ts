import { describe, expect, it } from 'vitest';
import { buildHakedisExportData, renderHakedisPrintableReportHtml } from '../src/hakedis-exporter';

describe('buildHakedisExportData', () => {
  const sampleInput = {
    project: {
      name: '154 kV Diyarbakır-Mardin ENH',
      employer: 'TEİAŞ 16. Bölge Müdürlüğü',
      contract_no: '2026/104521',
      start_date: '2026-01-15',
      end_date: '2026-12-30',
      type: 'enh',
      capacity: '154 kV',
    },
    payment: {
      id: 3,
      period_no: 2,
      period_label: 'Kasım 2026',
      status: 'approved',
      notes: '2. ara hakediş',
    },
    items: [
      {
        item_name: 'Galvanizli Çelik Kafes Direk Montajı',
        work_group_name: 'FAZ-04 Direk Montajı',
        unit: 'kg',
        contract_qty: 100000,
        previous_qty: 20000,
        current_qty: 15000,
        unit_price: 40,
        notes: '',
      },
      {
        item_name: 'Temel Betonu C25/30',
        work_group_name: 'FAZ-03 Temel',
        unit: 'm³',
        contract_qty: 500,
        previous_qty: 100,
        current_qty: 50,
        unit_price: 2000,
        notes: '',
      },
    ],
    poolEntries: [
      {
        pole_idx: 5,
        pole_name: 'D-5',
        stage: 'erection',
        tower_type: 'PE1',
        pole_function: 'KD',
        item_name: 'Direk Montajı (Dikim) — PE1',
        unit: 'kg',
        qty: 7900,
        unit_price: 40,
        decision_score: 94,
        gps_distance_m: 12.4,
        status: 'transferred',
      },
      {
        pole_idx: 6,
        pole_name: 'D-6',
        stage: 'erection',
        tower_type: 'PB1',
        pole_function: 'T',
        item_name: 'Direk Montajı (Dikim) — PB1',
        unit: 'kg',
        qty: 4200,
        unit_price: 40,
        decision_score: 91,
        gps_distance_m: 18.0,
        status: 'transferred',
      },
    ],
    priceIndices: [
      { period: '2026-01', index_name: 'TUFE', value: 2000, notes: 'Baz ay' },
      { period: '2026-11', index_name: 'TUFE', value: 2300, notes: 'Cari ay' },
    ],
  };

  it('computes icmal totals, Pn price difference, VAT, and multi-sheet rows accurately', () => {
    const res = buildHakedisExportData(sampleInput);

    // previous: 20000*40 + 100*2000 = 800,000 + 200,000 = 1,000,000
    expect(res.icmal.previous_amount).toBe(1000000);
    // current: 15000*40 + 50*2000 = 600,000 + 100,000 = 700,000
    expect(res.icmal.current_amount).toBe(700000);
    // cumulative: 1,700,000
    expect(res.icmal.cumulative_amount).toBe(1700000);
    // Pn = 2300 / 2000 = 1.15 -> price_diff = 700,000 * 0.15 = 105,000
    expect(res.icmal.pn).toBeCloseTo(1.15, 4);
    expect(res.icmal.price_diff_amount).toBeCloseTo(105000, 2);
    // subtotal = 805,000; VAT (20%) = 161,000; grand_total = 966,000
    expect(res.icmal.subtotal_with_diff).toBeCloseTo(805000, 2);
    expect(res.icmal.vat_amount).toBeCloseTo(161000, 2);
    expect(res.icmal.grand_total).toBeCloseTo(966000, 2);

    expect(res.sheets.kapakAndIcmalRows.length).toBeGreaterThan(10);
    expect(res.sheets.yesilDefterRows.length).toBeGreaterThan(5);
    expect(res.sheets.fiyatFarkiRows.length).toBeGreaterThan(4);
  });

  it('renders printable HTML report containing project details, green book table, and signature blocks', () => {
    const data = buildHakedisExportData(sampleInput);
    const html = renderHakedisPrintableReportHtml(data, []);
    expect(html).toContain('154 kV Diyarbakır-Mardin ENH');
    expect(html).toContain('TEİAŞ 16. Bölge Müdürlüğü');
    expect(html).toContain('Yeşil Defter');
    expect(html).toContain('D-5');
    expect(html).toContain('PE1');
    expect(html).toContain('Kontrol Mühendisi');
  });
});
