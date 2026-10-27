// Regresyon: DATE sütunları metin karşılaştırmalarıyla kullanılmamalı.
// Gerçek hata: workgroups PUT'taki late-count sorgusu `due_date != ''` yapıyordu →
// PostgreSQL "invalid input syntax for type date" ile 500 dönüyordu.
// Bu test, yasak kalıpların kaynak koda geri dönmesini engeller.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

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
