// Regresyon: portföy hakediş sayısı JOIN'li satır değil hakediş kaydı saymalıdır.
// COUNT(*) progress_payment_items JOIN'iyle şişer — 5 kalemli hakediş "5T" görünür.
// (Kaynak tarama deseni date-sql.test.ts ile aynı — DB gerektirmez.)
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const OVERVIEW_SRC = path.resolve(process.cwd(), 'src', 'routes', 'overview.ts');

describe('portföy SQL regresyonları', () => {
  it('overview.ts: hakediş adet sorgusu COUNT(DISTINCT pp.id) kullanır', () => {
    const src = fs.readFileSync(OVERVIEW_SRC, 'utf8');
    expect(src).toMatch(/COUNT\(DISTINCT pp\.id\)::int AS c/);
  });
});
