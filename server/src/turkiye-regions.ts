// İllerin resmi 3° ve 6° dilim orta meridyenleri
// Kaynak: "İllerin Dilim Orta Meridyenleri (Boylamları)" resmi tablosu
export interface ProvinceInfo {
  lon: number;      // BOYLAM
  lat: number;      // ENLEM
  cm: number;       // 3° Dilim Orta meridyeni
  utmZone: number;  // 6° Zone (35..38)
  cm6: number;      // 6° Dilim Orta meridyeni (27, 33, 39, 45)
}

export const PROVINCES: Record<string, ProvinceInfo> = {
  adana:          { lon: 35.3324, lat: 36.9719, cm: 36, utmZone: 36, cm6: 33 },
  adiyaman:       { lon: 38.2784, lat: 37.7607, cm: 39, utmZone: 37, cm6: 39 },
  afyon:          { lon: 30.5418, lat: 38.7558, cm: 30, utmZone: 36, cm6: 33 },
  afyonkarahisar: { lon: 30.5418, lat: 38.7558, cm: 30, utmZone: 36, cm6: 33 },
  agri:           { lon: 43.0544, lat: 39.7226, cm: 42, utmZone: 38, cm6: 45 },
  aksaray:        { lon: 34.0284, lat: 38.3746, cm: 33, utmZone: 36, cm6: 33 },
  amasya:         { lon: 35.8320, lat: 40.6544, cm: 36, utmZone: 36, cm6: 33 },
  ankara:         { lon: 32.8496, lat: 39.9347, cm: 33, utmZone: 36, cm6: 33 },
  antalya:        { lon: 30.6868, lat: 36.8940, cm: 30, utmZone: 36, cm6: 33 },
  ardahan:        { lon: 42.7031, lat: 41.1103, cm: 42, utmZone: 38, cm6: 45 },
  artvin:         { lon: 41.8200, lat: 41.1816, cm: 42, utmZone: 37, cm6: 39 },
  aydin:          { lon: 27.8426, lat: 37.8528, cm: 27, utmZone: 35, cm6: 27 },
  balikesir:      { lon: 27.8833, lat: 39.6521, cm: 27, utmZone: 35, cm6: 27 },
  bartin:         { lon: 32.3378, lat: 41.6364, cm: 33, utmZone: 36, cm6: 33 },
  batman:         { lon: 41.1235, lat: 37.8783, cm: 42, utmZone: 37, cm6: 39 },
  bayburt:        { lon: 40.2284, lat: 40.2587, cm: 39, utmZone: 37, cm6: 39 },
  bilecik:        { lon: 29.9805, lat: 40.1426, cm: 30, utmZone: 35, cm6: 27 },
  bingol:         { lon: 40.4895, lat: 38.8891, cm: 39, utmZone: 37, cm6: 39 },
  bitlis:         { lon: 42.1084, lat: 38.3997, cm: 42, utmZone: 38, cm6: 45 },
  bolu:           { lon: 31.6107, lat: 40.7333, cm: 33, utmZone: 36, cm6: 33 },
  burdur:         { lon: 30.2843, lat: 37.7193, cm: 30, utmZone: 36, cm6: 33 },
  bursa:          { lon: 29.0708, lat: 40.2071, cm: 30, utmZone: 35, cm6: 27 },
  canakkale:      { lon: 26.4142, lat: 40.1566, cm: 27, utmZone: 35, cm6: 27 },
  cankiri:        { lon: 33.6168, lat: 40.5985, cm: 33, utmZone: 36, cm6: 33 },
  corum:          { lon: 34.9536, lat: 40.5509, cm: 36, utmZone: 36, cm6: 33 },
  denizli:        { lon: 29.0865, lat: 37.7735, cm: 30, utmZone: 35, cm6: 27 },
  diyarbakir:     { lon: 40.2145, lat: 37.9189, cm: 39, utmZone: 37, cm6: 39 },
  duzce:          { lon: 31.1639, lat: 40.8393, cm: 30, utmZone: 36, cm6: 33 },
  edirne:         { lon: 26.5604, lat: 41.6755, cm: 27, utmZone: 35, cm6: 27 },
  elazig:         { lon: 39.2229, lat: 38.6755, cm: 39, utmZone: 37, cm6: 39 },
  erzincan:       { lon: 39.4905, lat: 39.7492, cm: 39, utmZone: 37, cm6: 39 },
  erzurum:        { lon: 41.2709, lat: 39.9051, cm: 42, utmZone: 37, cm6: 39 },
  eskisehir:      { lon: 30.5025, lat: 39.7700, cm: 30, utmZone: 36, cm6: 33 },
  gaziantep:      { lon: 37.3867, lat: 37.0646, cm: 36, utmZone: 37, cm6: 39 },
  giresun:        { lon: 38.3903, lat: 40.9175, cm: 39, utmZone: 37, cm6: 39 },
  gumushane:      { lon: 39.4671, lat: 40.4611, cm: 39, utmZone: 37, cm6: 39 },
  hakkari:        { lon: 43.7392, lat: 37.5761, cm: 45, utmZone: 38, cm6: 45 },
  hatay:          { lon: 36.1621, lat: 36.2018, cm: 36, utmZone: 37, cm6: 39 },
  igdir:          { lon: 44.0455, lat: 39.9193, cm: 45, utmZone: 38, cm6: 45 },
  isparta:        { lon: 30.5589, lat: 37.7636, cm: 30, utmZone: 36, cm6: 33 },
  istanbul:       { lon: 28.9766, lat: 41.0291, cm: 30, utmZone: 35, cm6: 27 },
  izmir:          { lon: 27.1297, lat: 38.4101, cm: 27, utmZone: 35, cm6: 27 },
  'k.maras':      { lon: 36.9283, lat: 37.5894, cm: 36, utmZone: 37, cm6: 39 },
  kahramanmaras:  { lon: 36.9283, lat: 37.5894, cm: 36, utmZone: 37, cm6: 39 },
  karabuk:        { lon: 32.6264, lat: 41.1982, cm: 33, utmZone: 36, cm6: 33 },
  karaman:        { lon: 33.2219, lat: 37.1814, cm: 33, utmZone: 36, cm6: 33 },
  kars:           { lon: 43.0958, lat: 40.6094, cm: 42, utmZone: 38, cm6: 45 },
  kastamonu:      { lon: 33.7719, lat: 41.3723, cm: 33, utmZone: 36, cm6: 33 },
  kayseri:        { lon: 35.4801, lat: 38.7229, cm: 36, utmZone: 36, cm6: 33 },
  kilis:          { lon: 37.1139, lat: 36.7176, cm: 36, utmZone: 37, cm6: 39 },
  kirikkale:      { lon: 33.5160, lat: 39.8417, cm: 33, utmZone: 36, cm6: 33 },
  kirklareli:     { lon: 27.2285, lat: 41.7378, cm: 27, utmZone: 35, cm6: 27 },
  kirsehir:       { lon: 34.1640, lat: 39.1480, cm: 33, utmZone: 36, cm6: 33 },
  kocaeli:        { lon: 29.9507, lat: 40.7732, cm: 30, utmZone: 35, cm6: 27 },
  konya:          { lon: 32.5110, lat: 37.8704, cm: 33, utmZone: 36, cm6: 33 },
  kutahya:        { lon: 29.9879, lat: 39.4217, cm: 30, utmZone: 35, cm6: 27 },
  malatya:        { lon: 38.3143, lat: 38.3475, cm: 39, utmZone: 37, cm6: 39 },
  manisa:         { lon: 27.4297, lat: 38.6222, cm: 27, utmZone: 35, cm6: 27 },
  mardin:         { lon: 40.7584, lat: 37.3136, cm: 42, utmZone: 37, cm6: 39 },
  mersin:         { lon: 34.6090, lat: 36.8000, cm: 36, utmZone: 36, cm6: 33 },
  mugla:          { lon: 28.3658, lat: 37.2196, cm: 27, utmZone: 35, cm6: 27 },
  mus:            { lon: 41.4878, lat: 38.7334, cm: 42, utmZone: 37, cm6: 39 },
  nevsehir:       { lon: 34.7140, lat: 38.6246, cm: 36, utmZone: 36, cm6: 33 },
  nigde:          { lon: 34.6775, lat: 37.9718, cm: 36, utmZone: 36, cm6: 33 },
  ordu:           { lon: 37.8740, lat: 40.9881, cm: 39, utmZone: 37, cm6: 39 },
  osmaniye:       { lon: 36.2485, lat: 37.0743, cm: 36, utmZone: 37, cm6: 39 },
  rize:           { lon: 40.5214, lat: 41.0224, cm: 42, utmZone: 37, cm6: 39 },
  sakarya:        { lon: 30.3793, lat: 40.7489, cm: 30, utmZone: 36, cm6: 33 },
  samsun:         { lon: 36.3234, lat: 41.2871, cm: 36, utmZone: 37, cm6: 39 },
  sanliurfa:      { lon: 38.7922, lat: 37.1512, cm: 39, utmZone: 37, cm6: 39 },
  siirt:          { lon: 41.9442, lat: 37.9251, cm: 42, utmZone: 37, cm6: 39 },
  sinop:          { lon: 35.1600, lat: 42.0269, cm: 36, utmZone: 36, cm6: 33 },
  sirnak:         { lon: 42.4608, lat: 37.5228, cm: 42, utmZone: 38, cm6: 45 },
  sivas:          { lon: 37.0172, lat: 39.7515, cm: 36, utmZone: 37, cm6: 39 },
  tekirdag:       { lon: 27.5144, lat: 40.9792, cm: 27, utmZone: 35, cm6: 27 },
  tokat:          { lon: 36.5559, lat: 40.3063, cm: 36, utmZone: 37, cm6: 39 },
  trabzon:        { lon: 39.7191, lat: 41.0061, cm: 39, utmZone: 37, cm6: 39 },
  tunceli:        { lon: 39.5491, lat: 39.1069, cm: 39, utmZone: 37, cm6: 39 },
  usak:           { lon: 29.4056, lat: 38.6716, cm: 30, utmZone: 35, cm6: 27 },
  van:            { lon: 43.3816, lat: 38.4970, cm: 42, utmZone: 38, cm6: 45 },
  yalova:         { lon: 29.2712, lat: 40.6560, cm: 30, utmZone: 35, cm6: 27 },
  yozgat:         { lon: 34.8055, lat: 39.8212, cm: 36, utmZone: 36, cm6: 33 },
  zonguldak:      { lon: 31.7925, lat: 41.4514, cm: 33, utmZone: 36, cm6: 33 },
};

// Sık geçen ilçe / trafo merkezi adlarından il eşlemesi
const DISTRICT_TO_PROVINCE: Record<string, string> = {
  sivrihisar: 'eskisehir',
  emirdag: 'afyon',
  bolvadin: 'afyon',
  sandikli: 'afyon',
  dinar: 'afyon',
  polatli: 'ankara',
  beypazari: 'ankara',
  lice: 'diyarbakir',
  bismil: 'diyarbakir',
  ergani: 'diyarbakir',
  silvan: 'diyarbakir',
  dicle: 'diyarbakir',
  hani: 'diyarbakir',
  kulp: 'diyarbakir',
  cermik: 'diyarbakir',
  cinar: 'diyarbakir',
  kralkizi: 'diyarbakir',
  kiralkizi: 'diyarbakir',
  viransehir: 'sanliurfa',
  siverek: 'sanliurfa',
  birecik: 'sanliurfa',
  suruc: 'sanliurfa',
  kiziltepe: 'mardin',
  nusaybin: 'mardin',
  midyat: 'mardin',
  cizre: 'sirnak',
  silopi: 'sirnak',
  idil: 'sirnak',
  yuksekova: 'hakkari',
  ercis: 'van',
  tatvan: 'bitlis',
  ahlat: 'bitlis',
  patnos: 'agri',
  dogubayazit: 'agri',
  elbistan: 'kahramanmaras',
  afsin: 'kahramanmaras',
  pazarcik: 'kahramanmaras',
  iskenderun: 'hatay',
  dortyol: 'hatay',
  kirikhan: 'hatay',
  reyhanli: 'hatay',
  antakya: 'hatay',
  ceylanpinar: 'sanliurfa',
  nizip: 'gaziantep',
  islahiye: 'gaziantep',
  tarsus: 'mersin',
  silifke: 'mersin',
  anamur: 'mersin',
  eregli: 'konya',
  aksehir: 'konya',
  beysehir: 'konya',
  seydisehir: 'konya',
  cihanbeyli: 'konya',
  kulu: 'konya',
  karapinar: 'konya',
  manavgat: 'antalya',
  alanya: 'antalya',
  finike: 'antalya',
  kumluca: 'antalya',
  fethiye: 'mugla',
  bodrum: 'mugla',
  milas: 'mugla',
  marmaris: 'mugla',
  yatağan: 'mugla',
  yatagan: 'mugla',
  soma: 'manisa',
  akhisar: 'manisa',
  salihli: 'manisa',
  turgutlu: 'manisa',
  alasehir: 'manisa',
  bergama: 'izmir',
  aliaga: 'izmir',
  odemis: 'izmir',
  tire: 'izmir',
  torbali: 'izmir',
  bandirma: 'balikesir',
  edremit: 'balikesir',
  gonen: 'balikesir',
  bigadic: 'balikesir',
  biga: 'canakkale',
  can: 'canakkale',
  gelibolu: 'canakkale',
  corlu: 'tekirdag',
  cerkezkoy: 'tekirdag',
  luleburgaz: 'kirklareli',
  kesan: 'edirne',
  uzunkopru: 'edirne',
  inegol: 'bursa',
  mustafakemalpasa: 'bursa',
  karacabey: 'bursa',
  gemlik: 'bursa',
  orhangazi: 'bursa',
  gebze: 'kocaeli',
  izmit: 'kocaeli',
  adapazari: 'sakarya',
  hendek: 'sakarya',
  karasu: 'sakarya',
  bolu: 'bolu',
  gerede: 'bolu',
  cankiri: 'cankiri',
  sungurlu: 'corum',
  osmancik: 'corum',
  merzifon: 'amasya',
  bafr: 'samsun',
  bafra: 'samsun',
  carsamba: 'samsun',
  unye: 'ordu',
  fatsa: 'ordu',
  bulancak: 'giresun',
  akcaabat: 'trabzon',
  of: 'trabzon',
  ardesen: 'rize',
  cayeli: 'rize',
  hopa: 'artvin',
  borcka: 'artvin',
  oltu: 'erzurum',
  horasan: 'erzurum',
  pasinler: 'erzurum',
  keban: 'elazig',
  kovancilar: 'elazig',
  karakocan: 'elazig',
  baskil: 'elazig',
  maden: 'elazig',
  darende: 'malatya',
  dogansehir: 'malatya',
  divrigi: 'sivas',
  sarkisla: 'sivas',
  suşehri: 'sivas',
  susehri: 'sivas',
  yildizeli: 'sivas',
  kangal: 'sivas',
  zile: 'tokat',
  erbaa: 'tokat',
  niksar: 'tokat',
  turhal: 'tokat',
  sorgun: 'yozgat',
  yerkoy: 'yozgat',
  bogazliyan: 'yozgat',
  develi: 'kayseri',
  bunyan: 'kayseri',
  yahyali: 'kayseri',
  kozan: 'adana',
  ceyhan: 'adana',
  kadirli: 'osmaniye',
  duzici: 'osmaniye',
};

// Türkiye 3° dilim orta meridyenleri
export const VALID_CMS = [27, 30, 33, 36, 39, 42, 45];

// Türkçe karakterleri ASCII'ye indirge (arama için)
function asciiTr(s: string): string {
  return s
    .replace(/\u0130/g, 'i') // İ → i (lowercase önce; aksi halde i̇ birleşik karakter olur)
    .toLowerCase()
    .replace(/ç/g, 'c').replace(/ğ/g, 'g').replace(/ı/g, 'i')
    .replace(/ö/g, 'o').replace(/ş/g, 's').replace(/ü/g, 'u');
}

export interface RegionGuess {
  city: string | null;       // bulunan il (ascii anahtar)
  provLon: number | null;    // il merkezi boylamı
  provLat: number | null;    // il merkezi enlemi
  utmZone: number | null;    // 6° UTM Zone (35..38)
  cmOrder: number[];         // denenmesi gereken 3° orta meridyen sırası
  matches: { city: string; info: ProvinceInfo }[]; // metinde geçen tüm il eşleşmeleri
}

// Uzun isim önce: Kahramanmaraş/Karabük/Kırıkkale/Kırklareli karışmasın
const CITY_NAMES = Object.keys(PROVINCES).sort((a, b) => b.length - a.length);
const DISTRICT_NAMES = Object.keys(DISTRICT_TO_PROVINCE).sort((a, b) => b.length - a.length);

// Kısa il adlarının ("van", "mus", "kars", "agri", "ordu", "bolu", "usak", "rize")
// başka Türkçe kelimelerin ("unvan", "olmus", "karsi", "kusak") içinde eşleşmesini önle
function containsToken(norm: string, word: string): boolean {
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Kelime başı harf olmamalı; kelime sonu ya harf olmamalı ya da sayı/ek sınırı olmalı
  if (word.length <= 4) {
    const re = new RegExp(`(?:^|[^a-z])${esc}(?:$|[^a-z])`);
    return re.test(norm);
  }
  const re = new RegExp(`(?:^|[^a-z])${esc}`);
  return re.test(norm);
}

function buildCmOrder(cm: number): number[] {
  const order = [cm];
  for (const d of [3, -3, 6, -6, 9, -9]) {
    const cand = cm + d;
    if (VALID_CMS.includes(cand) && !order.includes(cand)) order.push(cand);
  }
  for (const c of VALID_CMS) if (!order.includes(c)) order.push(c);
  return order;
}

export function detectRegion(text: string, approxLat?: number | null): RegionGuess {
  const norm = asciiTr(text || '');
  const matches: { city: string; info: ProvinceInfo }[] = [];
  const seen = new Set<string>();

  for (const name of CITY_NAMES) {
    if (containsToken(norm, name)) {
      const info = PROVINCES[name];
      const canonical = name === 'k.maras' ? 'kahramanmaras' : name === 'afyonkarahisar' ? 'afyon' : name;
      if (!seen.has(canonical)) {
        seen.add(canonical);
        matches.push({ city: canonical, info });
      }
    }
  }
  for (const dist of DISTRICT_NAMES) {
    if (containsToken(norm, dist)) {
      const prov = DISTRICT_TO_PROVINCE[dist];
      const info = PROVINCES[prov];
      if (info && !seen.has(prov)) {
        seen.add(prov);
        matches.push({ city: prov, info });
      }
    }
  }

  // Eğer yaklaşık enlem biliniyorsa (Northing değerinden), enlemi çok uzak (>2.2°) olan
  // tesadüfi eşleşmeleri ele (ör. metinde şirket/özel isim olarak geçen başka bir il adı)
  let validMatches = matches;
  if (approxLat != null && Number.isFinite(approxLat) && matches.length > 0) {
    const latFiltered = matches.filter((m) => Math.abs(m.info.lat - approxLat) <= 2.2);
    if (latFiltered.length > 0) {
      validMatches = latFiltered;
    }
  }

  if (validMatches.length > 0) {
    const primary = validMatches[0];
    return {
      city: primary.city,
      provLon: primary.info.lon,
      provLat: primary.info.lat,
      utmZone: primary.info.utmZone,
      cmOrder: buildCmOrder(primary.info.cm),
      matches: validMatches,
    };
  }

  // İl bulunamadı: merkeze (39) yakınlık sırasıyla hepsini dene
  const fallback = [...VALID_CMS].sort((a, b) => Math.abs(a - 39) - Math.abs(b - 39));
  return { city: null, provLon: null, provLat: null, utmZone: null, cmOrder: fallback, matches: [] };
}
