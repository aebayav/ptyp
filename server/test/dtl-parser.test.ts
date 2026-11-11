// dtl-parser regresyonları: gerçek OCR çıktıları (ocr-service/bench_out) + sentetik Excel.
// Bench dosyaları Indra OCR'ın temiz sonuçlarıdır — parser bunları bozmamalı;
// koordinatlar ise çözümleme sonrası her zaman gerçekçi aralıkta kalmalı
// (D-8 hatası: 4247726.27 → 247726 gibi %1e6 kaymaları regresyonu).
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import * as XLSX from 'xlsx';
import { parseExcelDtl, parseDtlLine, finalizeDtlRows } from '../src/dtl-parser';
import { normalizeDtlRowTypes, normalizeTowerType } from '../src/tower-types';
import { parseTm3Lines } from '../src/coord-parser';

const BENCH_DIR = path.resolve(process.cwd(), '..', 'ocr-service', 'bench_out');

function benchFiles(): string[] {
  try {
    return fs.readdirSync(BENCH_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
}

function loadBench(name: string): any {
  return JSON.parse(fs.readFileSync(path.join(BENCH_DIR, name), 'utf8'));
}

// dtl.indra satırları DtlRow benzeri nesnelerdir; normalizeDtlRowTypes bunları kabul eder
function indraDtlRows(data: any): any[] {
  return (data?.dtl?.indra || []) as any[];
}

function indraRawLines(data: any): string[] {
  return ((data?.rows?.indra || []) as any[]).map((r) => String(r.raw || ''));
}

describe('bench verileri — temiz tipler bozulmamalı', () => {
  const files = benchFiles();
  if (files.length === 0) {
    it.skip('bench_out yok — OCR çıktı verisi bulunamadı', () => {});
    return;
  }
  for (const f of files) {
    it(`${f}: tüm direk tipleri normalizasyon sonrası aynı kalır`, () => {
      const data = loadBench(f);
      const rows = indraDtlRows(data);
      expect(rows.length).toBeGreaterThan(0);
      const out = normalizeDtlRowTypes(rows);
      out.forEach((r, i) => {
        expect(r.tower_type, `temiz tip değişti (${f} satır ${i}): ${rows[i].tower_type} → ${r.tower_type}`).toBe(
          rows[i].tower_type
        );
      });
    });

    it(`${f}: raw satırlardan çözümlenen koordinatlar gerçekçi aralıkta`, () => {
      const data = loadBench(f);
      const lines = indraRawLines(data);
      expect(lines.length).toBeGreaterThan(0);
      const rows = parseTm3Lines(lines.join('\n'));
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        expect(r.easting, `easting aralık dışı: ${r.easting} (${f})`).toBeGreaterThanOrEqual(100000);
        expect(r.easting).toBeLessThanOrEqual(900000);
        expect(r.northing, `northing aralık dışı: ${r.northing} (${f})`).toBeGreaterThanOrEqual(3500000);
        expect(r.northing).toBeLessThanOrEqual(5000000);
      }
    });
  }
});

describe('parseExcelDtl — sentetik DTL Excel', () => {
  function dtlWorkbook(): Buffer {
    const rows = [
      ['DİREK NO', 'ARA MESAFE', 'DİREK TİP', 'FONKSİYON', '(Y)', '(X)', 'GEÇİLEN', 'AÇIKLAMA'],
      ['1', '345.5', 'PFT', 'T', '597201.19', '4218498.82', 'yol', ''],
      ['2', '322.0', 'PB1', 'A', '597341.15', '4218126.24', '', 'dere geçişi'],
    ];
    const ws = XLSX.utils.aoa_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'DTL');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  }

  it('satırları ve sütunları okur', () => {
    const res = parseExcelDtl(dtlWorkbook());
    expect(res.rows.length).toBe(2);
    const [a, b] = res.rows;
    expect(a.pole).toBe('1');
    expect(a.span_m).toBe(345.5);
    expect(a.function).toBe('T');
    expect(a.easting).toBe(597201.19);
    expect(a.crossing).toContain('YOL'); // geçiş zenginleştirmesi: 'yol' → 'ASFALT YOL' vb.
    expect(b.tower_type).toBe('PB1');
    expect(b.remarks).toBe('dere geçişi');
  });

  it('okunan tipler normalize edilebilir (PFT → PF1)', () => {
    const res = parseExcelDtl(dtlWorkbook());
    const out = normalizeDtlRowTypes(res.rows);
    expect(out[0].tower_type).toBe('PF1');
    expect(out[0].tower_type_raw).toBe('PFT');
  });
});

describe('parseDtlLine ve finalizeDtlRows — çok bölümlü ve OCR kaynaklı TEİAŞ DTL satırları', () => {
  it('BD (Branşman Direği), 2FN1, 3PE1/3PB1, CPFH(N) ve negatif ağırlık açıklığını doğru ayrıştırır', () => {
    const r28 = parseDtlLine(
      '28 | 45.07 | 125 | 148 | 10+009.72 | S.4 | 194.0201 | BD | 28 | 2FNI | 22 | 6 | 11.50 | 3 | 4 | 5 | 4 | 774.15 | CG/G | 26/13 | U160BL | 410073.44 | 4395502.71 | BRANŞMAN DİREĞI | 2 | 3'
    );
    expect(r28).not.toBeNull();
    expect(r28?.pole).toBe('28');
    expect(r28?.function).toBe('BD');
    expect(r28?.tower_type).toBe('2FN1');
    expect(r28?.station_text).toBe('10+009.72');
    expect(r28?.remarks).toBe('Branşman Direği');

    const r40 = parseDtlLine(
      '40 | 439.00 | 357 | 363 | 20+980.00 | T | 40 | PBI | 27 | 12 | 10.50 | 1 | 2 | 1 | 810.26 | A | 13 | U120BL | 406637.05 | 4404691.47 | 3 | 3'
    );
    expect(r40?.pole).toBe('40');
    expect(r40?.station_text).toBe('20+980.00');
    expect(r40?.tower_type).toBe('PB1');

    const r64 = parseDtlLine(
      '64 | 20.83 | 120 | -103 | 30+935.59 | ND.2 | 194.0681 | N | 64 | CPEH(N | 31 | 15 | 10.50 | I | 676.19 | ÇG/G | 26/13 | U160BL | 406086.55 | 4414189.23 | 4 | 3'
    );
    expect(r64?.pole).toBe('64');
    expect(r64?.station_text).toBe('30+935.59');
    expect(r64?.tower_type).toBe('CPFH');
    expect(r64?.function).toBe('N');

    const d13 = parseDtlLine('D.13 | D | D.13 | 3PE1 | 30 | 773.67 | 406819.77 | 4407264.17 | 4 | 3 | BABLANTI ANLAS');
    expect(d13?.pole).toBe('D.13');
    expect(d13?.tower_type).toBe('3PE1');
    expect(d13?.function).toBe('D');
    expect(d13?.remarks).toBe('BAĞLANTI ANLAŞ.');
  });

  it('finalizeDtlRows çok-bölümlü (GİRDİ 26..28 + ÇIKTI 12..14 + D.13..D.14) direk numaralarını ezmez', () => {
    const sample = ['26', '27', '28', '12', '13', '14', 'D.13', 'D.14'].map((p) => ({
      pole: p,
      span_m: 300,
      wind_span_m: null,
      weight_span_m: null,
      station_text: '',
      station_m: null,
      some_no: '',
      line_angle_grad: null,
      crossing: '',
      function: 'T',
      tower_type: 'PB1',
      nominal_height_m: 24,
      body_ext_m: 6,
      hook_diff_m: null,
      center_ext_m: null,
      leg_a_m: null,
      leg_b_m: null,
      leg_c_m: null,
      leg_d_m: null,
      ground_elev_m: null,
      insulator_set: 'A',
      insulator_count: '13',
      insulator_ref: 'U120BL',
      easting: 400000,
      northing: 4400000,
      remarks: '',
      profile_no: null,
      ice_zone: null,
    }));
    const out = finalizeDtlRows(sample);
    expect(out.map((r) => r.pole)).toEqual(['26', '27', '28', '12', '13', '14', 'D.13', 'D.14']);
  });
});
