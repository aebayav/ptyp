// dtl-parser regresyonları: gerçek OCR çıktıları (ocr-service/bench_out) + sentetik Excel.
// Bench dosyaları Indra OCR'ın temiz sonuçlarıdır — parser bunları bozmamalı;
// koordinatlar ise çözümleme sonrası her zaman gerçekçi aralıkta kalmalı
// (D-8 hatası: 4247726.27 → 247726 gibi %1e6 kaymaları regresyonu).
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import * as XLSX from 'xlsx';
import { parseExcelDtl } from '../src/dtl-parser';
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
