// Direk tipi eşleştirici regresyonları.
// Kapsanan gerçek hata: OCR 'PF1'i 'PFT', 'PB1'i 'PBI' okuyordu ve sahte tipler
// keşife (BOQ) yansıyordu. Kural: yüksek güvenli eşleşmede düzelt, belirsizde
// OLDUĞU GİBİ bırak (sessizce uydurma yok).
import { describe, it, expect } from 'vitest';
import { normalizeTowerType, normalizeDtlRowTypes, TOWER_TYPES } from '../src/tower-types';

describe('normalizeTowerType — bildirilen bozulmalar', () => {
  it('PFT → PF1 (1↔T karışması)', () => {
    expect(normalizeTowerType('PFT')).toBe('PF1');
  });

  it('PBI → PB1 (1↔I karışması)', () => {
    expect(normalizeTowerType('PBI')).toBe('PB1');
  });

  it('PEI → PE1', () => {
    expect(normalizeTowerType('PEI')).toBe('PE1');
  });

  it('PBT → PB1 (T↔1)', () => {
    expect(normalizeTowerType('PBT')).toBe('PB1');
  });

  it('küçük harfler büyütülür: pb1 → PB1', () => {
    expect(normalizeTowerType('pb1')).toBe('PB1');
  });
});

describe('normalizeTowerType — temiz tiplere dokunmaz', () => {
  it('sözlükteki her tip aynen kalır', () => {
    for (const t of TOWER_TYPES) {
      expect(normalizeTowerType(t), `temiz tip bozuldu: ${t}`).toBe(t);
    }
  });
});

describe('normalizeTowerType — belirsiz değerler uydurulmaz', () => {
  it('PRAK olduğu gibi kalır', () => {
    expect(normalizeTowerType('PRAK')).toBe('PRAK');
  });

  it('tamamen yabancı metin olduğu gibi kalır', () => {
    expect(normalizeTowerType('XYZ')).toBe('XYZ');
  });

  it('boş/null olduğu gibi kalır (boş metin olarak)', () => {
    expect(normalizeTowerType('')).toBe('');
    expect(normalizeTowerType(null)).toBe('');
  });
});

describe('normalizeDtlRowTypes — satır listesi', () => {
  it('bozuk tipleri düzeltir ve orijinali tower_type_raw saklar', () => {
    const rows = [{ tower_type: 'PFT' }, { tower_type: 'PB1' }];
    const out = normalizeDtlRowTypes(rows);
    expect(out[0].tower_type).toBe('PF1');
    expect(out[0].tower_type_raw).toBe('PFT');
    expect(out[1].tower_type).toBe('PB1');
    expect(out[1].tower_type_raw).toBeUndefined();
  });

  it('boş liste boş döner', () => {
    expect(normalizeDtlRowTypes([])).toEqual([]);
  });
});
