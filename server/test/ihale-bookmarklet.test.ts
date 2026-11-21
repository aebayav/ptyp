import { describe, it, expect, vi } from 'vitest';
import { generateBookmarklet, EKAP_SEARCH_URL } from '../src/ihale-bookmarklet';

// generateBookmarklet: PTYP kökü + ingest token + aktif sorguları gömülü bir
// javascript: URL'i üretir. Üretilen kod EKAP arama sayfası bağlamında koşar:
// sorguları çeker → PTYP ingest'e POST eder → özet alert basar.

const INPUT = {
  origin: 'https://turguz.app',
  token: 'test-token-abc123',
  queries: [
    { name: 'ENH', search_text: 'enerji nakil hattı' },
    { name: 'Trafo', search_text: 'trafo merkezi' },
  ],
};

/** javascript: önekini soyup Function sandbox'ında koşulabilir gövdeyi döndürür. */
function decodedCode(): string {
  const raw = generateBookmarklet(INPUT);
  expect(raw.startsWith('javascript:')).toBe(true);
  return decodeURIComponent(raw.slice('javascript:'.length));
}

/** EKAP + ingest fetch'lerini taklit ederek bookmarklet kodunu koşturur. */
async function runBookmarklet(ekapPages: any[][], ingestFail?: number) {
  const ekapCalls: number[] = [];
  let ingestBody: any = null;
  const alerts: string[] = [];

  const ekapResponse = (rows: any[]) => ({ ok: true, status: 200, json: async () => ({ list: rows }) });

  const fetchMock = async (url: string, init?: any) => {
    if (url.includes('b_ihalearama')) {
      const body = JSON.parse(init.body);
      ekapCalls.push(body.paginationSkip);
      const page = ekapPages[Math.min(ekapCalls.length - 1, ekapPages.length - 1)];
      return ekapResponse(page);
    }
    if (url.includes('/api/ihaleler/ingest')) {
      if (ingestFail) return { ok: false, status: ingestFail, json: async () => ({ error: 'az önce tarandı' }) };
      ingestBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ new_count: ingestBody.rows.length, changed_count: 1 }),
      };
    }
    throw new Error('beklenmeyen fetch: ' + url);
  };

  const code = decodedCode();
  const fn = new Function('fetch', 'alert', 'return ' + code);
  await fn(fetchMock, (m: string) => alerts.push(m));
  return { ekapCalls, ingestBody, alerts };
}

describe('generateBookmarklet — kaynak gömmesi', () => {
  it('embeds origin, token, every search_text and the Yapım type filter', () => {
    const code = decodedCode();
    expect(code).toContain('https://turguz.app/api/ihaleler/ingest');
    expect(code).toContain('test-token-abc123');
    expect(code).toContain('enerji nakil hattı');
    expect(code).toContain('trafo merkezi');
    expect(code).toContain('ihaleTuruIdList');
    expect(code).toContain('[2]');
  });

  it('computes the date window at RUN time — no fixed date literal in generated code', () => {
    const code = decodedCode();
    expect(code).toMatch(/Date\.now\(\)/);
    expect(code).not.toMatch(/20\d{2}-\d{2}-\d{2}T00:00:00/); // üretim anının tarihi sabitlenmemiş
  });

  it('is deterministic for identical input', () => {
    expect(generateBookmarklet(INPUT)).toBe(generateBookmarklet(INPUT));
  });

  it('exposes the EKAP search URL for the "EKAP Ac" open button', () => {
    expect(EKAP_SEARCH_URL).toBe('https://ekapv2.kik.gov.tr/ekap/search');
  });
});

describe('generateBookmarklet — sandbox davranışı', () => {
  it('collects paged results and POSTs all rows to PTYP ingest with the token', async () => {
    const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ ikn: `2026/${100 + i}`, ihaleAdi: `İhale ${i}` }));
    const { ekapCalls, ingestBody, alerts } = await runBookmarklet([
      rows(10), // sorgu 1, sayfa 0 (dolu → sayfa 1'e geç)
      rows(4), //  sorgu 1, sayfa 1 (<10 → dur)
      rows(0), //  sorgu 2, sayfa 0 (0 satır → dur)
    ]);
    expect(ekapCalls).toEqual([0, 10, 0]); // üç sayfa koşusu, nezaket sınırı içinde
    expect(ingestBody.rows).toHaveLength(14);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain('14');
    expect(alerts[0]).toContain('yeni');
  });

  it('still POSTs when zero rows are found (freshness signal, no silent empty)', async () => {
    const { ingestBody, alerts } = await runBookmarklet([[], []]);
    expect(ingestBody).not.toBeNull();
    expect(ingestBody.rows).toHaveLength(0);
    expect(alerts[0]).toContain('0');
  });

  it('alerts the EKAP error and skips ingest when EKAP rejects (stale verification)', async () => {
    const alerts: string[] = [];
    const fetchMock = async () => ({ ok: false, status: 428, json: async () => ({}) });
    const code = decodedCode();
    const fn = new Function('fetch', 'alert', 'return ' + code);
    await fn(fetchMock, (m: string) => alerts.push(m));
    expect(alerts[0]).toContain('428');
  });

  it('surfaces ingest rejection (429 double-click guard) with the server reason', async () => {
    const { alerts } = await runBookmarklet([[[], []]], 429);
    expect(alerts[0]).toContain('429');
    expect(alerts[0]).toContain('az önce tarandı');
  });
});
