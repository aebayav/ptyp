// İllerin resmi 3° dilim orta meridyenleri
// Kaynak: "İllerin Dilim Orta Meridyenleri (Boylamları)" resmi tablosu
// cm: il merkezinin resmi 3° TM orta meridyeni; lon: il merkezi boylamı
// Not: ENH hatları il sınırını aşabilir; komşu dilim adayları da denenir ve
// sonuç, il merkezi boylamına yakınlıkla doğrulanır (bkz. kmz-generator).
interface ProvinceInfo {
  lon: number;
  cm: number;
}

const PROVINCES: Record<string, ProvinceInfo> = {
  adana: { lon: 35.332, cm: 36 },
  adiyaman: { lon: 38.278, cm: 39 },
  afyon: { lon: 30.542, cm: 30 },
  agri: { lon: 43.054, cm: 42 },
  aksaray: { lon: 34.028, cm: 33 },
  amasya: { lon: 35.832, cm: 36 },
  ankara: { lon: 32.850, cm: 33 },
  antalya: { lon: 30.687, cm: 30 },
  ardahan: { lon: 42.703, cm: 42 },
  artvin: { lon: 41.820, cm: 42 },
  aydin: { lon: 27.843, cm: 27 },
  balikesir: { lon: 27.883, cm: 27 },
  bartin: { lon: 32.338, cm: 33 },
  batman: { lon: 41.123, cm: 42 },
  bayburt: { lon: 40.228, cm: 39 },
  bilecik: { lon: 29.980, cm: 30 },
  bingol: { lon: 40.489, cm: 39 },
  bitlis: { lon: 42.108, cm: 42 },
  bolu: { lon: 31.611, cm: 33 },
  burdur: { lon: 30.284, cm: 30 },
  bursa: { lon: 29.071, cm: 30 },
  canakkale: { lon: 26.414, cm: 27 },
  cankiri: { lon: 33.617, cm: 33 },
  corum: { lon: 34.954, cm: 36 },
  denizli: { lon: 29.087, cm: 30 },
  diyarbakir: { lon: 40.215, cm: 39 },
  duzce: { lon: 31.164, cm: 30 },
  edirne: { lon: 26.560, cm: 27 },
  elazig: { lon: 39.223, cm: 39 },
  erzincan: { lon: 39.490, cm: 39 },
  erzurum: { lon: 41.271, cm: 42 },
  eskisehir: { lon: 30.503, cm: 30 },
  gaziantep: { lon: 37.387, cm: 36 },
  giresun: { lon: 38.390, cm: 39 },
  gumushane: { lon: 39.467, cm: 39 },
  hakkari: { lon: 43.739, cm: 45 },
  hatay: { lon: 36.162, cm: 36 },
  igdir: { lon: 44.045, cm: 45 },
  isparta: { lon: 30.559, cm: 30 },
  istanbul: { lon: 28.977, cm: 30 },
  izmir: { lon: 27.130, cm: 27 },
  'k.maras': { lon: 36.928, cm: 36 },
  kahramanmaras: { lon: 36.928, cm: 36 },
  karabuk: { lon: 32.626, cm: 33 },
  karaman: { lon: 33.222, cm: 33 },
  kars: { lon: 43.096, cm: 42 },
  kastamonu: { lon: 33.772, cm: 33 },
  kayseri: { lon: 35.480, cm: 36 },
  kilis: { lon: 37.114, cm: 36 },
  kirikkale: { lon: 33.516, cm: 33 },
  kirklareli: { lon: 27.229, cm: 27 },
  kirsehir: { lon: 34.164, cm: 33 },
  kocaeli: { lon: 29.951, cm: 30 },
  konya: { lon: 32.511, cm: 33 },
  kutahya: { lon: 29.988, cm: 30 },
  malatya: { lon: 38.314, cm: 39 },
  manisa: { lon: 27.430, cm: 27 },
  mardin: { lon: 40.758, cm: 42 },
  mersin: { lon: 34.609, cm: 36 },
  mugla: { lon: 28.366, cm: 27 },
  mus: { lon: 41.488, cm: 42 },
  nevsehir: { lon: 34.714, cm: 36 },
  nigde: { lon: 34.678, cm: 36 },
  ordu: { lon: 37.874, cm: 39 },
  osmaniye: { lon: 36.248, cm: 36 },
  rize: { lon: 40.521, cm: 42 },
  sakarya: { lon: 30.379, cm: 30 },
  samsun: { lon: 36.323, cm: 36 },
  sanliurfa: { lon: 38.792, cm: 39 },
  siirt: { lon: 41.944, cm: 42 },
  sinop: { lon: 35.160, cm: 36 },
  sirnak: { lon: 42.461, cm: 42 },
  sivas: { lon: 37.017, cm: 36 },
  tekirdag: { lon: 27.514, cm: 27 },
  tokat: { lon: 36.556, cm: 36 },
  trabzon: { lon: 39.719, cm: 39 },
  tunceli: { lon: 39.549, cm: 39 },
  usak: { lon: 29.406, cm: 30 },
  van: { lon: 43.382, cm: 42 },
  yalova: { lon: 29.271, cm: 30 },
  yozgat: { lon: 34.806, cm: 36 },
  zonguldak: { lon: 31.793, cm: 33 },
};

// Türkiye 3° dilim orta meridyenleri
const VALID_CMS = [27, 30, 33, 36, 39, 42, 45];

// Türkçe karakterleri ASCII'ye indirge (arama için)
function asciiTr(s: string): string {
  return s
    .replace(/\u0130/g, 'i') // İ → i (lowercase önce; aksi halde i̇ birleşik karakter olur)
    .toLowerCase()
    .replace(/ç/g, 'c').replace(/ğ/g, 'g').replace(/ı/g, 'i')
    .replace(/ö/g, 'o').replace(/ş/g, 's').replace(/ü/g, 'u');
}

export interface RegionGuess {
  city: string | null; // bulunan il (ascii anahtar)
  provLon: number | null; // il merkezi boylamı (plausibility kontrolü için)
  cmOrder: number[]; // denenmesi gereken orta meridyen sırası
}

// Uzun isim önce: Kahramanmaraş/Karabük/Kırıkkale/Kırklareli karışmasın
const CITY_NAMES = Object.keys(PROVINCES).sort((a, b) => b.length - a.length);

export function detectRegion(text: string): RegionGuess {
  const norm = asciiTr(text || '');
  for (const name of CITY_NAMES) {
    if (norm.includes(name)) {
      const info = PROVINCES[name];
      // Resmi CM önce; komşu dilimler (±3, ±6) mesafeye göre; kalanlar sonda
      const order = [info.cm];
      for (const d of [3, -3, 6, -6, 9, -9]) {
        const cand = info.cm + d;
        if (VALID_CMS.includes(cand) && !order.includes(cand)) order.push(cand);
      }
      for (const cm of VALID_CMS) if (!order.includes(cm)) order.push(cm);
      return { city: name, provLon: info.lon, cmOrder: order };
    }
  }
  // İl bulunamadı: merkeze (39) yakınlık sırasıyla hepsini dene
  const fallback = [...VALID_CMS].sort((a, b) => Math.abs(a - 39) - Math.abs(b - 39));
  return { city: null, provLon: null, cmOrder: fallback };
}
