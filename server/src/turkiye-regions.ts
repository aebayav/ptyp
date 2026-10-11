// Türkiye 3° TM: şehir/bölge → tercih edilen orta meridyen sırası
// CM kapsamları: 27→[25.5-28.5] 30→[28.5-31.5] 33→[31.5-34.5] 36→[34.5-37.5]
//                39→[37.5-40.5] 42→[40.5-43.5] 45→[43.5-46.5]
const CITY_CM: Record<string, number[]> = {
  // Batı
  istanbul: [27, 30], izmir: [27, 30], bursa: [27, 30], balikesir: [27, 30],
  canakkale: [27, 30], manisa: [27, 30], tekirdag: [27, 30], edirne: [27, 30],
  mugla: [27, 30], denizli: [27, 30], aydin: [27, 30], usak: [27, 30],
  kocaeli: [30, 27], sakarya: [30, 27], yalova: [30, 27], bilecik: [30, 27],
  // Batı Karadeniz / İç Batı
  eskisehir: [30, 33], bolu: [30, 33], duzce: [30, 33], zonguldak: [30, 33],
  kutahya: [30, 33], afyon: [30, 33], isparta: [30, 33], antalya: [30, 33],
  burdur: [30, 33],
  // Orta
  ankara: [33, 36], konya: [33, 36], kirikkale: [33, 36], kirsehir: [33, 36],
  nevsehir: [33, 36], nigde: [33, 36], karaman: [33, 36], aksaray: [33, 36],
  yozgat: [33, 36], corum: [33, 36], sinop: [33, 36], kastamonu: [33, 30],
  karabuk: [33, 30], bartin: [33, 30], samsun: [36, 33], ordu: [36, 39],
  amasya: [36, 33], tokat: [36, 39],
  // İç / Doğu Akdeniz ve İç Doğu
  kayseri: [36, 33], sivas: [36, 39], mersin: [33, 36], adana: [36, 33],
  osmaniye: [36, 39], hatay: [36, 33], gaziantep: [36, 39], kilis: [36, 39],
  kahramanmaras: [36, 39], maras: [36, 39],
  // Güneydoğu
  sanliurfa: [39, 36], adiyaman: [39, 36], malatya: [39, 36], elazig: [39, 42],
  tunceli: [39, 42], erzincan: [39, 42], gumushane: [39, 42], bayburt: [42, 39],
  diyarbakir: [42, 39], lice: [42, 39], batman: [42, 45], mardin: [42, 39],
  siirt: [42, 45], sirnak: [42, 45], bitlis: [42, 45], mus: [42, 39],
  bingol: [42, 39], erzurum: [42, 45],
  // Doğu uç
  van: [45, 42], hakkari: [45, 42], agri: [45, 42], kars: [45, 42],
  igdir: [45, 42], ardahan: [45, 42],
  // Karadeniz doğu
  rize: [39, 42], trabzon: [39, 42], artvin: [42, 45], giresun: [36, 39],
};

const ALL_CMS = [27, 30, 33, 36, 39, 42, 45];

// Türkçe karakterleri ASCII'ye indirge (arama için)
function asciiTr(s: string): string {
  return s
    .replace(/\u0130/g, 'i') // İ → i (lowercase önce; aksi halde i̇ birleşik karakter olur)
    .toLowerCase()
    .replace(/ç/g, 'c').replace(/ğ/g, 'g').replace(/ı/g, 'i')
    .replace(/ö/g, 'o').replace(/ş/g, 's').replace(/ü/g, 'u')
    .replace(/â/g, 'a').replace(/î/g, 'i').replace(/û/g, 'u');
}

// Dosya adı + belge metninden şehir tespiti → CM deneme sırası
// En uzun şehir adı önce kontrol edilir (kahramanmaras > maras)
const CITY_KEYS = Object.keys(CITY_CM).sort((a, b) => b.length - a.length);

export function detectRegion(text: string): { city: string | null; cmOrder: number[] } {
  const hay = asciiTr(text || '');
  for (const key of CITY_KEYS) {
    if (hay.includes(key)) {
      const preferred = CITY_CM[key];
      const order = [...preferred, ...ALL_CMS.filter((c) => !preferred.includes(c))];
      return { city: key, cmOrder: order };
    }
  }
  // Bölge bilgisi yok → genel sıra (orta/doğu ağırlıklı; Türkiye'de en sık 36/39/42)
  return { city: null, cmOrder: [39, 36, 42, 33, 30, 27, 45] };
}
