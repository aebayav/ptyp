import { describe, it, expect } from 'vitest';
import {
  normalizeStockMaterialName,
  isStockableKesifItem,
  buildStockSummary,
} from '../src/routes/stock';

describe('stock helper functions', () => {
  it('normalizes Turkish characters and strips Temin ve Montaj suffix', () => {
    expect(normalizeStockMaterialName('3A Tipi Direk — Temin ve Montaj')).toBe(
      normalizeStockMaterialName('3A Tipi Direk')
    );
    expect(normalizeStockMaterialName('Silikon İzolatör Takımı — Askı')).toBe(
      normalizeStockMaterialName('silikon izolator takimi - aski')
    );
  });

  it('filters out non-material route length items from kesif sync', () => {
    expect(isStockableKesifItem('Hat Uzunluğu (Güzergah)', 'km')).toBe(false);
    expect(isStockableKesifItem('3A Tipi Direk — Temin ve Montaj', 'adet')).toBe(true);
    expect(isStockableKesifItem('477 MCM HAWK İletken (3 faz)', 'kg')).toBe(true);
  });

  it('builds stock summary with accurate kesif matching and status calculation', () => {
    const materials = [
      { id: 1, code: 'M-001', name: '3A Tipi Direk', unit: 'adet', spec: '', target_price: null },
      { id: 2, code: 'M-002', name: 'Silikon İzolatör Takımı — Askı', unit: 'takım', spec: '', target_price: null },
      { id: 3, code: 'M-003', name: 'Topraklama Kazığı', unit: 'adet', spec: '', target_price: null },
    ];
    const movements = [
      { material_id: 1, total_in: 10, total_out: 3 },
      { material_id: 2, total_in: 5, total_out: 5 },
    ];
    const kesif = [
      { item_name: '3A Tipi Direk — Temin ve Montaj', qty: 12 },
      { item_name: 'Silikon İzolatör Takımı — Askı', qty: 20 },
    ];

    const summary = buildStockSummary(materials, movements, kesif);
    expect(summary).toHaveLength(3);

    // 3A Tipi Direk: kesif=12, in=10, out=3, remaining=7 -> sufficient
    expect(summary[0].kesif).toBe(12);
    expect(summary[0].remaining).toBe(7);
    expect(summary[0].stock_status).toBe('sufficient');

    // İzolatör: kesif=20, in=5, out=5, remaining=0 (had movements) -> depleted
    expect(summary[1].kesif).toBe(20);
    expect(summary[1].remaining).toBe(0);
    expect(summary[1].stock_status).toBe('depleted');

    // Topraklama Kazığı: in=0, out=0, remaining=0 (no movements yet) -> no_entry
    expect(summary[2].kesif).toBeNull();
    expect(summary[2].remaining).toBe(0);
    expect(summary[2].stock_status).toBe('no_entry');
  });
});
