// Regresyon: DATE sütunları metin karşılaştırmalarıyla kullanılmamalı ve
// LATE_TASK_SQL JOIN'li sorgularda "column reference 'status' is ambiguous" üretmemeli.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { LATE_TASK_SQL, lateTaskSql } from '../src/late-filter';

const ROUTES_DIR = path.resolve(process.cwd(), 'src', 'routes');

function routeFiles(): string[] {
  try {
    return fs.readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.ts'));
  } catch {
    return [];
  }
}

const FORBIDDEN = [
  /due_date\s*!=\s*''/,
  /planned_start\s*!=\s*''/,
  /planned_end\s*!=\s*''/,
  /to_char\(\s*now\(\)\s*,\s*'YYYY-MM-DD'\s*\)/,
];

describe('DATE sütunları metin karşılaştırması içermez', () => {
  const files = routeFiles();
  if (files.length === 0) {
    it.skip('routes klasörü bulunamadı', () => {});
    return;
  }
  for (const f of files) {
    it(`${f}: yasak tarih-karşılaştırma kalıbı yok`, () => {
      const src = fs.readFileSync(path.join(ROUTES_DIR, f), 'utf8');
      for (const re of FORBIDDEN) {
        expect(src, `${f} içinde yasak kalıp: ${re}`).not.toMatch(re);
      }
    });
  }
});

describe('LATE_TASK_SQL tablo takma adı güvenliği (ambiguous status önleme)', () => {
  it('varsayılan LATE_TASK_SQL tüm sütunları t. takma adıyla nitelendirir', () => {
    expect(LATE_TASK_SQL).toBe("t.status != 'done' AND t.due_date IS NOT NULL AND t.due_date < CURRENT_DATE");
    expect(lateTaskSql('')).toBe("status != 'done' AND due_date IS NOT NULL AND due_date < CURRENT_DATE");
  });

  it('LATE_TASK_SQL kullanan tüm sorgularda tasks tablosu t takma adıyla tanımlıdır', () => {
    for (const f of routeFiles()) {
      const src = fs.readFileSync(path.join(ROUTES_DIR, f), 'utf8');
      const queries = src.match(/`[^`]*\$\{LATE_TASK_SQL\}[^`]*`/g) || [];
      for (const q of queries) {
        expect(q, `${f} içindeki LATE_TASK_SQL sorgusunda 'tasks t' takma adı eksik: ${q}`).toMatch(
          /\b(?:FROM|JOIN)\s+tasks\s+t\b/i
        );
      }
    }
  });
});
