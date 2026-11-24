// EKAP HTTP hasat client'i — tarayıcı YOK. Kullanıcının giriş yapılı oturum
// çereziyle (ihale_settings.ekap_cookies) arama API'sine düz POST atar.
// Dürüst politika: Turnstile atlatabilme yok; oturum geçersizse açık Türkçe
// hata fırlatılır ("çerez yenile"), sessiz boş hasat ASLA kabul edilmez.
//
// Test edilebilirlik: fetch ve sleep enjekte edilebilir (sandbox testleri).

export interface HarvestQuery {
  name: string;
  searchText: string;
}

export interface EkapRow {
  id: string;
  ikn: string;
  ihaleAdi: string;
  ihaleTip: string;
  ihaleTipAciklama: string;
  ihaleUsulAciklama: string;
  ihaleDurum: string;
  ihaleDurumAciklama: string;
  idareAdi: string;
  ihaleIlAdi: string;
  ihaleTarihSaat: string;
  dokumanSayisi: number;
}

/** API gövdesi — recon'dan birebir (bkz. spec). Pencere: ihale tarihi bugünden ileri. */
export function buildQueryBody(searchText: string, skip: number, todayIso: string): Record<string, unknown> {
  return {
    searchText,
    filterType: null,
    ikNdeAra: false,
    ihaleAdindaAra: true,
    ihaleBilgilerindeAra: true,
    teklifCetvelindeAra: true,
    searchType: 'GirdigimGibi',
    iknYili: null,
    iknSayi: null,
    ihaleTarihSaatBaslangic: todayIso,
    ihaleTarihSaatBitis: null,
    ilanTarihSaatBaslangic: null,
    ilanTarihSaatBitis: null,
    yasaKapsami4734List: [1],
    ihaleTuruIdList: [2], // Yapım
    ihaleUsulIdList: [],
    ihaleUsulAltIdList: [],
    ihaleIlIdList: [],
    ihaleDurumIdList: [],
    ihaleIlanTuruIdList: [],
    teklifTuruIdList: [],
    asiriDusukTeklifIdList: [],
    istisnaMaddeIdList: [],
    okasBransKodList: [],
    okasBransAdiList: [],
    eIhale: null,
    eEksiltmeYapilacakMi: null,
    ortakAlimMi: null,
    kismiTeklifMi: null,
    fiyatDisiUnsurVarmi: null,
    ekonomikVeMaliYeterlilikBelgeleriIsteniyorMu: null,
    meslekiTeknikYeterlilikBelgeleriIsteniyorMu: null,
    isDeneyimiGosterenBelgelerIsteniyorMu: null,
    yerliIstekliyeFiyatAvantajiUgulaniyorMu: null,
    yabanciIsteklilereIzinVeriliyorMu: null,
    alternatifTeklifVerilebilirMi: null,
    konsorsiyumKatilabilirMi: null,
    altYukleniciCalistirilabilirMi: null,
    fiyatFarkiVerilecekMi: null,
    avansVerilecekMi: null,
    cerceveAnlasmaMi: null,
    personelCalistirilmasinaDayaliMi: null,
    orderBy: 'ihaleTarihi',
    siralamaTipi: 'asc',
    paginationSkip: skip,
    paginationTake: 10,
  };
}

/** Bugünün Europe/Istanbul 00:00'ı — koşu anında hesaplanır. */
export function todayStartIstanbul(nowMs: number = Date.now()): string {
  const trNow = new Date(nowMs + 3 * 60 * 60 * 1000); // TR 2016'dan beri yıl boyu UTC+03
  return trNow.toISOString().slice(0, 10) + 'T00:00:00';
}

export type FetchLike = (url: string, init?: any) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;
export type SleepLike = (ms: number) => Promise<void>;

export interface HarvestHttpOptions {
  /** Enjekte edilebilir fetch (test) — verilmezse Node'un global fetch'i kullanılır */
  fetchImpl?: FetchLike;
  /** Enjekte edilebilir sleep (test) */
  sleepImpl?: SleepLike;
  /** Sorgu başına en çok sayfa — nezaket sınırı */
  maxPages?: number;
}

const API_URL = 'https://ekapv2.kik.gov.tr/b_ihalearama/api/Ihale/GetListByParameters';

/** Oturum çerezi geçersiz/hesap yetkisi yok → net hata (çerez yenileme talimatıyla). */
function sessionError(status: number): Error {
  return new Error(
    `EKAP oturumu geçersiz (HTTP ${status}). EKAP'e giriş yapıp oturum çerezini ` +
      `İhale Kutusu sayfasından yenileyin.`
  );
}

/**
 * Aktif sorguların hepsini EKAP'tan hasat eder (auth çereziyle düz HTTP).
 * 428/429'da sayfa başına 3 kez 5 sn bekleyip yeniden dener.
 * 0 satır meşrudur (açık ihale olmayabilir) — hata sayılmaz.
 */
export async function runEkapHarvestHttp(
  queries: HarvestQuery[],
  cookieHeader: string,
  opts: HarvestHttpOptions = {}
): Promise<EkapRow[]> {
  const doFetch: FetchLike = opts.fetchImpl || (globalThis as any).fetch.bind(globalThis);
  const sleep: SleepLike = opts.sleepImpl || ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const maxPages = opts.maxPages ?? 3;
  const today = todayStartIstanbul();

  if (!cookieHeader || !cookieHeader.trim()) {
    throw sessionError(401);
  }

  const all: EkapRow[] = [];
  for (let qi = 0; qi < queries.length; qi++) {
    let done = false;
    for (let p = 0; p < maxPages && !done; p++) {
      let attempt = 0;
      let res: { ok: boolean; status: number; json: () => Promise<any> } | null = null;
      for (;;) {
        res = await doFetch(API_URL, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            'api-version': 'v1',
            cookie: cookieHeader,
          },
          body: JSON.stringify(buildQueryBody(queries[qi].searchText, p * 10, today)),
        });
        if (res.ok) break;
        if ((res.status === 428 || res.status === 429) && attempt < 3) {
          attempt++;
          await sleep(5000);
          continue;
        }
        throw sessionError(res.status);
      }
      const data = await res!.json();
      const list = (data && Array.isArray(data.list) ? data.list : []) as EkapRow[];
      for (const r of list) {
        if (r && r.ikn) all.push(r);
      }
      if (list.length < 10) done = true;
    }
    // Sorgular arası nezaket aralığı
    if (qi < queries.length - 1) await sleep(1500);
  }
  return all;
}
