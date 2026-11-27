import { describe, it, expect } from 'vitest';
import { buildQueryBody, todayStartIstanbul, runEkapHarvestHttp, EkapRow } from '../src/ekap-http';

// Düz HTTP hasat — tarayıcı yok, auth çerezi var. fetch enjekte edilerek
// sandbox'ta koşturulur; politika sınırları (sayfa/tekrar/nezaket) burada sabitlenir.

const ROW = (ikn: string): EkapRow => ({
  id: 'x' + ikn,
  ikn,
  ihaleAdi: 'Test ' + ikn,
  ihaleTip: '2',
  ihaleTipAciklama: 'Yapım',
  ihaleUsulAciklama: 'İhale Usulü: Açık',
  ihaleDurum: '2',
  ihaleDurumAciklama: 'İhale İlanı Yayımlanmış, Katılıma Açık',
  idareAdi: 'TEİAŞ',
  ihaleIlAdi: 'ANKARA',
  ihaleTarihSaat: '23.03.2027 14:00',
  dokumanSayisi: 0,
});

describe('buildQueryBody', () => {
  it('pins the recon schema: Yapım type, forward window, asc order, paging', () => {
    const b = buildQueryBody('trafo merkezi', 10, '2026-11-24T00:00:00');
    expect(b.searchText).toBe('trafo merkezi');
    expect(b.ihaleTuruIdList).toEqual([2]);
    expect(b.ihaleTarihSaatBaslangic).toBe('2026-11-24T00:00:00');
    expect(b.ihaleTarihSaatBitis).toBeNull();
    expect(b.orderBy).toBe('ihaleTarihi');
    expect(b.siralamaTipi).toBe('asc');
    expect(b.paginationSkip).toBe(10);
    expect(b.paginationTake).toBe(10);
    expect(b.yasaKapsami4734List).toEqual([1]);
  });

  it('todayStartIstanbul returns today at 00:00 in TR wall time (UTC+03)', () => {
    // 24.11.2026 01:30 UTC → TR duvar saati 04:30 → gün 2026-11-24
    expect(todayStartIstanbul(Date.parse('2026-11-24T01:30:00Z'))).toBe('2026-11-24T00:00:00');
    // 23.11.2026 22:00 UTC → TR 24.11 01:00 → gün 2026-11-24
    expect(todayStartIstanbul(Date.parse('2026-11-23T22:00:00Z'))).toBe('2026-11-24T00:00:00');
  });
});

describe('runEkapHarvestHttp', () => {
  const pages = (lists: EkapRow[][]) => {
    let call = 0;
    const seen: any[] = [];
    const fetchMock = async (_url: string, init?: any) => {
      const body = JSON.parse(init.body);
      seen.push(body.paginationSkip);
      const list = lists[Math.min(call, lists.length - 1)];
      call++;
      if (list === 'ERR429') {
        if (call <= 1) return { ok: false, status: 429, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => ({ list: [] }) };
      }
      return { ok: true, status: 200, json: async () => ({ list }) };
    };
    return { fetchMock, seen };
  };
  const noSleep = async () => {};

  it('collects paged rows with cookie header and stops at short page', async () => {
    const { fetchMock, seen } = pages([Array.from({ length: 10 }, (_, i) => ROW(`2026/${i}`)), [ROW('2026/99')]]);
    const sent: any[] = [];
    const spy = async (url: string, init?: any) => {
      sent.push(init.headers.cookie);
      return fetchMock(url, init);
    };
    const rows = await runEkapHarvestHttp(
      [{ name: 'ENH', searchText: 'enerji nakil hattı' }],
      'authcookie=1',
      { fetchImpl: spy as any, sleepImpl: noSleep }
    );
    expect(rows).toHaveLength(11);
    expect(seen).toEqual([0, 10]); // dolu sayfa 0 → sayfa 1 → <10 → dur
    expect(sent.every((c) => c === 'authcookie=1')).toBe(true); // çerez her istekte
  });

  it('retries 429 with backoff and then succeeds', async () => {
    // İlk istek 429, ikinci 200 (boş liste) — retried path
    let call = 0;
    const fetchMock = async () => {
      call++;
      if (call === 1) return { ok: false, status: 429, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ list: [ROW('2026/7')] }) };
    };
    const rows = await runEkapHarvestHttp([{ name: 'T', searchText: 'trafo' }], 'c=1', {
      fetchImpl: fetchMock as any,
      sleepImpl: noSleep,
    });
    expect(rows).toHaveLength(1);
    expect(call).toBe(2);
  });

  it('0 rows is legitimate (no open tenders) — returns empty, no error', async () => {
    const { fetchMock } = pages([[[]]]);
    const rows = await runEkapHarvestHttp([{ name: 'T', searchText: 'trafo' }], 'c=1', {
      fetchImpl: fetchMock as any,
      sleepImpl: noSleep,
    });
    expect(rows).toHaveLength(0);
  });

  it('expired session (401/403/428-after-retries) → clear Turkish cookie-refresh error', async () => {
    const always401 = async () => ({ ok: false, status: 401, json: async () => ({}) });
    await expect(
      runEkapHarvestHttp([{ name: 'T', searchText: 'trafo' }], 'c=1', {
        fetchImpl: always401 as any,
        sleepImpl: noSleep,
      })
    ).rejects.toThrow('oturum');
    // 428 kalıcı: 3 tekrarın ardından da hata (tekrar dolmadan yeterince uyuyamaz)
    let calls = 0;
    const always428 = async () => {
      calls++;
      return { ok: false, status: 428, json: async () => ({}) };
    };
    await expect(
      runEkapHarvestHttp([{ name: 'T', searchText: 'trafo' }], 'c=1', {
        fetchImpl: always428 as any,
        sleepImpl: noSleep,
      })
    ).rejects.toThrow('oturum');
    expect(calls).toBe(4); // 1 + 3 tekrar
  });

  it('missing cookie header → immediate session error, zero requests', async () => {
    let calls = 0;
    const fetchMock = async () => {
      calls++;
      return { ok: true, status: 200, json: async () => ({ list: [] }) };
    };
    await expect(
      runEkapHarvestHttp([{ name: 'T', searchText: 'trafo' }], '  ', {
        fetchImpl: fetchMock as any,
        sleepImpl: noSleep,
      })
    ).rejects.toThrow('oturum');
    expect(calls).toBe(0);
  });

  it('strips leading "cookie:" prefix and rejects HTML challenge pages cleanly', async () => {
    const sent: string[] = [];
    const fetchOk = async (_url: string, init?: any) => {
      sent.push(init.headers.cookie);
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json; charset=utf-8' },
        json: async () => ({ list: [ROW('2026/42')] }),
      };
    };
    const rows = await runEkapHarvestHttp([{ name: 'T', searchText: 'trafo' }], 'cookie: EKAP_SESSION=abc123\r\n', {
      fetchImpl: fetchOk as any,
      sleepImpl: noSleep,
    });
    expect(rows).toHaveLength(1);
    expect(sent[0]).toBe('EKAP_SESSION=abc123');

    const fetchHtml = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'text/html; charset=utf-8' },
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
    });
    await expect(
      runEkapHarvestHttp([{ name: 'T', searchText: 'trafo' }], 'EKAP_SESSION=abc123', {
        fetchImpl: fetchHtml as any,
        sleepImpl: noSleep,
      })
    ).rejects.toThrow('oturum');
  });
});
