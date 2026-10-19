// Excel (.xlsx) ve PDF metinlerinden direk koordinatları çıkarma
import * as XLSX from 'xlsx';
import { PolePoint } from './kmz-parser';

const LAT_RANGE: [number, number] = [36, 42]; // Türkiye enlem aralığı
const LON_RANGE: [number, number] = [26, 45]; // Türkiye boylam aralığı

// Türkçe fold: büyük/küçük harf ve Türkçe karakterleri sadeleştir
function fold(s: string): string {
  return s
    .toLocaleLowerCase('tr')
    .replace(/ı/g, 'i')
    .replace(/ğ/g, 'g')
    .replace(/ş/g, 's')
    .replace(/ç/g, 'c')
    .replace(/ü/g, 'u')
    .replace(/ö/g, 'o')
    .replace(/[^a-z0-9]/g, '');
}

const NAME_KEYS = ['ad', 'adi', 'isim', 'direk', 'direkno', 'pole', 'name', 'no', 'numara', 'kod', 'code', 'etiket', 'label'];
const LAT_KEYS = ['enlem', 'lat', 'latitude', 'y', 'north', 'northing', 'kuzey'];
const LON_KEYS = ['boylam', 'lon', 'long', 'lng', 'x', 'east', 'easting', 'dogu'];

// "39,1234" (TR) / "39.1234" / "1.234,56" → number
export function parseCoordNumber(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  let s = String(raw).trim();
  if (!s) return null;
  if (s.includes(',') && s.includes('.')) {
    s = s.replace(/\./g, '').replace(',', '.'); // binlik + ondalık
  } else if (s.includes(',')) {
    s = s.replace(',', '.'); // TR ondalık
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function isLat(n: number) {
  return n >= LAT_RANGE[0] && n <= LAT_RANGE[1];
}
function isLon(n: number) {
  return n >= LON_RANGE[0] && n <= LON_RANGE[1];
}

function cleanName(raw: unknown): string {
  if (raw == null) return '';
  let s = String(raw).trim();
  if (!s) return '';
  // "55.0" gibi kayan noktalı direk numaralarını "55" yap
  s = s.replace(/^(\d+)\.0+$/, '$1');
  // "D-1", "d.1", "D 1", "d_1", "D1" → "D-1"  /  "DP-3", "dp.3" → "DP-3"  /  "P 5" → "P-5"
  const poleM = s.match(/^(d\s*p|d|p)[\s._\-]*(\d+)$/i);
  if (poleM) {
    const prefix = poleM[1].toUpperCase().replace(/\s+/g, '');
    return `${prefix}-${poleM[2]}`;
  }
  // Sadece sayıysa dokunma
  return s;
}

interface ColumnMap {
  nameIdx: number;
  latIdx: number;
  lonIdx: number;
}

function detectColumns(rows: unknown[][]): ColumnMap | null {
  for (let r = 0; r < Math.min(rows.length, 15); r++) {
    const row = rows[r];
    const idx: { name: number; lat: number; lon: number } = { name: -1, lat: -1, lon: -1 };
    row.forEach((cell, i) => {
      const f = fold(String(cell ?? ''));
      if (!f) return;
      if (idx.name === -1 && NAME_KEYS.some((k) => f.includes(k))) idx.name = i;
      if (idx.lat === -1 && LAT_KEYS.some((k) => f === k || f.includes(k))) idx.lat = i;
      if (idx.lon === -1 && LON_KEYS.some((k) => f === k || f.includes(k))) idx.lon = i;
    });
    if (idx.lat !== -1 && idx.lon !== -1) {
      return { nameIdx: idx.name, latIdx: idx.lat, lonIdx: idx.lon };
    }
  }
  return null;
}

// "39.1234, 32.5678" gibi tek hücrede birleşik koordinat
function splitCombined(raw: unknown): { lat: number; lon: number } | null {
  if (raw == null) return null;
  const s = String(raw);
  const m = s.match(/(-?\d{1,2}[.,]\d{3,})\s*[,;\s]\s*(-?\d{1,2}[.,]\d{3,})/);
  if (!m) return null;
  const a = parseCoordNumber(m[1]);
  const b = parseCoordNumber(m[2]);
  if (a == null || b == null) return null;
  if (isLat(a) && isLon(b)) return { lat: a, lon: b };
  if (isLon(a) && isLat(b)) return { lat: b, lon: a };
  return null;
}

export function parseExcelCoordinates(buffer: Buffer): { poles: PolePoint[]; textLines: string } {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const poles: PolePoint[] = [];
  const rawLines: string[] = [];

  for (const sheetName of wb.SheetNames) {
    rawLines.push(sheetName);
    const sheet = wb.Sheets[sheetName];
    if (!sheet) continue;
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null }) as unknown[][];

    // Metin/TM3 geri dönüşü için hücre içeriklerini ve olası (Direk, Y, X) satırlarını topla
    for (const row of rows) {
      if (!row) continue;
      const nonEmpty = row.filter((c) => c != null && String(c).trim() !== '');
      if (nonEmpty.length === 0) continue;
      let east: number | null = null;
      let north: number | null = null;
      let poleName = '';
      for (const cell of row) {
        const n = parseCoordNumber(cell);
        if (n != null && n >= 100000 && n <= 900000 && east == null) {
          east = n;
        } else if (n != null && n >= 3500000 && n <= 5000000 && north == null) {
          north = n;
        } else if (!poleName && cell != null) {
          const s = String(cell).trim();
          if (POLE_TOKEN_RE.test(s)) poleName = cleanName(s);
        }
      }
      if (east != null && north != null) {
        rawLines.push(`${poleName || ''} ${east} ${north}`.trim());
      } else {
        rawLines.push(nonEmpty.map((c) => String(c).trim()).join(' '));
      }
    }

    if (poles.length > 0) continue;
    const cols = detectColumns(rows);
    if (cols) {
      const start = rows.findIndex((r) => {
        const f0 = fold(String(r[cols.latIdx] ?? ''));
        const f1 = fold(String(r[cols.lonIdx] ?? ''));
        return (
          (LAT_KEYS.some((k) => f0.includes(k)) || LON_KEYS.some((k) => f0.includes(k))) &&
          (LAT_KEYS.some((k) => f1.includes(k)) || LON_KEYS.some((k) => f1.includes(k)))
        );
      });
      for (let r = Math.max(0, start + 1); r < rows.length; r++) {
        const row = rows[r];
        if (!row) continue;
        let lat = parseCoordNumber(row[cols.latIdx]);
        let lon = parseCoordNumber(row[cols.lonIdx]);
        // Başlık "X/Y" yerine değer aralığına göre düzelt
        if (lat != null && lon != null && isLon(lat) && isLat(lon)) {
          const t = lat;
          lat = lon;
          lon = t;
        }
        if (lat == null || lon == null || !isLat(lat) || !isLon(lon)) continue;
        poles.push({ name: cleanName(cols.nameIdx >= 0 ? row[cols.nameIdx] : ''), lat, lon, alt: null });
      }
    }

    // Başlık algılanamadıysa: herhangi bir hücrede birleşik koordinat ara
    if (poles.length === 0) {
      for (let r = 0; r < rows.length; r++) {
        const row = rows[r] || [];
        let name = '';
        let found: { lat: number; lon: number } | null = null;
        for (const cell of row) {
          const c = splitCombined(cell);
          if (c) {
            found = c;
          } else if (cell != null && String(cell).trim() && !found && !String(cell).includes('.')) {
            name = name || cleanName(cell);
          }
        }
        if (found) {
          poles.push({ name: name || `Direk ${poles.length + 1}`, lat: found.lat, lon: found.lon, alt: null });
        }
      }
    }
  }

  return { poles, textLines: rawLines.join('\n') };
}

// PDF metni: koordinat desenlerinden direkleri çıkar
// (document-reader.analyzePdf ile metin katmanı önceden doğrulanır)
// Enine Merkator ters izdüşümü (Redfearn / Snyder ayak noktası enlemi serisi) — WGS84/GRS80 elipsoidi
// (ITRF-96 ≈ WGS84: fark cm düzeyinde, ihmal edilir)
function tmToWgs84(easting: number, northing: number, lon0Deg: number, k0: number): { lat: number; lon: number } {
  const a = 6378137;
  const f = 1 / 298.257223563;
  const e2 = f * (2 - f);
  const ep2 = e2 / (1 - e2);
  const n = f / (2 - f);
  const A = (a / (1 + n)) * (1 + (n * n) / 4 + (n * n * n * n) / 64);
  // Ayak noktası enlemi (footpoint latitude φ1) katsayıları (Snyder Eq. 3-26):
  // Önceki kodda yanlışlıkla ileri dönüşüm (α1 = n/2 - ...) kullanıldığı için
  // enlem ~0.0937° (~10.4 km) güneye ve boylam ~150-300 m kayıyordu.
  const c1 = (3 * n) / 2 - (27 * n * n * n) / 32 + (269 * Math.pow(n, 5)) / 512;
  const c2 = (21 * n * n) / 16 - (55 * Math.pow(n, 4)) / 32;
  const c3 = (151 * n * n * n) / 96 - (417 * Math.pow(n, 5)) / 128;
  const c4 = (1097 * Math.pow(n, 4)) / 512;
  const x = easting - 500000;
  const y = northing;
  const mu = y / (k0 * A);
  const phi1 =
    mu +
    c1 * Math.sin(2 * mu) +
    c2 * Math.sin(4 * mu) +
    c3 * Math.sin(6 * mu) +
    c4 * Math.sin(8 * mu);
  const sinP = Math.sin(phi1);
  const cosP = Math.cos(phi1);
  const tanP = Math.tan(phi1);
  const N1 = a / Math.sqrt(1 - e2 * sinP * sinP);
  const T1 = tanP * tanP;
  const C1 = ep2 * cosP * cosP;
  const R1 = (a * (1 - e2)) / Math.pow(1 - e2 * sinP * sinP, 1.5);
  const D = x / (N1 * k0);
  const lat =
    phi1 -
    ((N1 * tanP) / R1) *
      ((D * D) / 2 -
        ((5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * Math.pow(D, 4)) / 24 +
        ((61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * Math.pow(D, 6)) / 720);
  const lonDeltaRad =
    (D - ((1 + 2 * T1 + C1) * Math.pow(D, 3)) / 6 + ((5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * Math.pow(D, 5)) / 120) /
    cosP;
  const lon = lon0Deg + (lonDeltaRad * 180) / Math.PI;
  return { lat: (lat * 180) / Math.PI, lon };
}

// UTM (WGS84, kuzey yarımküre) → enlem/boylam
export function utmToWgs84(easting: number, northing: number, zone: number): { lat: number; lon: number } {
  return tmToWgs84(easting, northing, zone * 6 - 183, 0.9996);
}

// ITRF-96 / 3° TM (Türkiye 3 derecelik dilim) → enlem/boylam
// k0 = 1.0, sahte doğu 500000 m, sahte kuzey 0
export function tm3ToWgs84(easting: number, northing: number, cm: number): { lat: number; lon: number } {
  return tmToWgs84(easting, northing, cm, 1.0);
}

// WGS84 → ITRF-96 / 3° TM ters dönüşüm (Krüger serisi, k0=1, sahte doğu 500 km)
export function wgs84ToTm3(lat: number, lon: number, cm: number): { easting: number; northing: number } {
  const a = 6378137;
  const f = 1 / 298.257223563;
  const e2 = f * (2 - f);
  const ep2 = e2 / (1 - e2);
  const phi = (lat * Math.PI) / 180;
  const lam = ((lon - cm) * Math.PI) / 180;
  const s = Math.sin(phi);
  const c = Math.cos(phi);
  const t = Math.tan(phi);
  const N = a / Math.sqrt(1 - e2 * s * s);
  const T = t * t;
  const C = ep2 * c * c;
  const A = c * lam;
  const e2_2 = e2 * e2;
  const e2_3 = e2_2 * e2;
  const M =
    a *
    ((1 - e2 / 4 - (3 * e2_2) / 64 - (5 * e2_3) / 256) * phi -
      ((3 * e2) / 8 + (3 * e2_2) / 32 + (45 * e2_3) / 1024) * Math.sin(2 * phi) +
      ((15 * e2_2) / 256 + (45 * e2_3) / 1024) * Math.sin(4 * phi) -
      ((35 * e2_3) / 3072) * Math.sin(6 * phi));
  const easting =
    N *
      (A +
        ((1 - T + C) * A ** 3) / 6 +
        ((5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5) / 120) +
    500000;
  const northing =
    M +
    N *
      t *
      ((A * A) / 2 +
        ((5 - T + 9 * C + 4 * C * C) * A ** 4) / 24 +
        ((61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6) / 720);
  return { easting, northing };
}

// Aynı güzergahta 3° dilim sınırı geçişi varsa (ör. CM 30 doğu ucu E≈629k → CM 33 batı ucu E≈371k),
// komşu dilime geçen noktaların CM değerini (±3°) otomatik uyarla.
export function convertTm3List(
  rows: { name: string; easting: number; northing: number }[],
  baseCm: number
): PolePoint[] {
  if (rows.length === 0) return [];
  const hasHigh = rows.some((r) => r.easting > 580000);
  const hasLow = rows.some((r) => r.easting < 420000);
  const hasMid = rows.some((r) => r.easting >= 430000 && r.easting <= 570000);
  const straddlesBoundary = hasHigh && hasLow && !hasMid;
  // Baskın grubun hangi tarafta olduğunu belirle (baseCm baskın gruba aittir)
  const highCount = rows.filter((r) => r.easting > 500000).length;
  const baseIsHigh = highCount >= rows.length - highCount;

  const out: PolePoint[] = [];
  for (const u of rows) {
    let cm = baseCm;
    if (straddlesBoundary) {
      if (baseIsHigh && u.easting < 420000 && baseCm + 3 <= 45) cm = baseCm + 3;
      else if (!baseIsHigh && u.easting > 580000 && baseCm - 3 >= 27) cm = baseCm - 3;
    }
    const { lat, lon } = tm3ToWgs84(u.easting, u.northing, cm);
    if (lat >= 35.5 && lat <= 42.5 && lon >= 25.5 && lon <= 45.5) {
      out.push({ name: u.name, lat, lon, alt: null });
    }
  }
  return out;
}

const POLE_TOKEN_RE = /^(?:portal|(?:d\s*p|p\s*b|d\s*m|d|p)[\s._\-]?\d{1,4}|\d{1,4}|[A-Za-z]{1,2}\d{1,4})$/i;

// Satırlardan UTM koordinat çiftleri (easting ~6 hane, northing ~7 hane)
// Türkçe ondalık virgülü desteklenir (592259,15 → 592259.15)
export function parseUtmLines(text: string): { name: string; easting: number; northing: number }[] {
  const out: { name: string; easting: number; northing: number }[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = line.match(/\b(\d{6})(?:[.,](\d{1,4}))?[\s|;,]+(\d{7})(?:[.,](\d{1,4}))?\b/);
    if (!m) continue;
    const east = Number(m[1]) + (m[2] ? Number('0.' + m[2]) : 0);
    const north = Number(m[3]) + (m[4] ? Number('0.' + m[4]) : 0);
    if (east < 100000 || east > 900000) continue;
    if (north < 3000000 || north > 6000000) continue; // Türkiye kuzey aralığı
    const firstWord = line.split(/\s+/)[0].replace(/[.:;|]+$/, '');
    const nameUtm = POLE_TOKEN_RE.test(firstWord) ? cleanName(firstWord) : '';
    out.push({ name: nameUtm, easting: east, northing: north });
  }
  return out;
}

// ITRF-96 / 3° TM satırlarından koordinat çiftleri
// easting: 6 hane (350000-650000) veya dilim önekli 7 hane (ör. 6 500000),
// northing: 7 hane (Türkiye için 3.5M-4.8M)
export function parseTm3Lines(text: string): { name: string; easting: number; northing: number }[] {
  const out: { name: string; easting: number; northing: number }[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    // 7 haneli (önekli) veya 6 haneli easting + 7 haneli northing (veya tersi 7+6)
    const m = line.match(/\b(\d{7})(?:[.,](\d{1,4}))?[\s|;,]+(\d{7})(?:[.,](\d{1,4}))?\b/);
    let east: number | null = null;
    let north: number | null = null;
    if (m) {
      const first = Number(m[1]) + (m[2] ? Number('0.' + m[2]) : 0);
      north = Number(m[3]) + (m[4] ? Number('0.' + m[4]) : 0);
      // Önekli easting (dilim no + 6 hane) → öneki sök; kalan Türkiye TM3
      // aralığında değilse satırı reddet (yanlış okunmuş northing çifti koruması)
      if (first >= 3000000) {
        const rem = first % 1000000;
        if (rem < 300000 || rem > 700000) continue;
        east = rem;
      }
    } else {
      const m2 = line.match(/\b(\d{6})(?:[.,](\d{1,4}))?[\s|;,]+(\d{7})(?:[.,](\d{1,4}))?\b/);
      if (m2) {
        east = Number(m2[1]) + (m2[2] ? Number('0.' + m2[2]) : 0);
        north = Number(m2[3]) + (m2[4] ? Number('0.' + m2[4]) : 0);
      } else {
        const m3 = line.match(/\b(\d{7})(?:[.,](\d{1,4}))?[\s|;,]+(\d{6})(?:[.,](\d{1,4}))?\b/);
        if (!m3) continue;
        north = Number(m3[1]) + (m3[2] ? Number('0.' + m3[2]) : 0);
        east = Number(m3[3]) + (m3[4] ? Number('0.' + m3[4]) : 0);
      }
    }
    if (east == null || north == null) continue;
    // Türkiye 3° TM easting aralığı (500km sahte doğu ± 1.5°): ~369k-631k;
    // bunun dışı yanlış okumadır (örn. çift northing 4247726 → 247726)
    if (east < 300000 || east > 700000) continue;
    if (north < 3000000 || north > 6000000) continue;
    const firstWord = line.split(/\s+/)[0].replace(/[.:;|]+$/, '');
    const nameTm = POLE_TOKEN_RE.test(firstWord) ? cleanName(firstWord) : '';
    out.push({ name: nameTm, easting: east, northing: north });
  }
  return out;
}

export function parsePdfText(text: string): { poles: PolePoint[] } {
  const poles: PolePoint[] = [];

  const COORD_RE = /(\d{1,2}[.,]\d{3,})\s*[,;\s]\s*(\d{1,2}[.,]\d{3,})/g;
  const NAME_RE = /(?:direk\s*[:\-]?\s*)?(?:(d\s*p|d|p)[\s._\-]?\d+|\d{1,4})/i;

  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const m = t.match(COORD_RE);
    if (!m) continue;
    let lat: number | null = null;
    let lon: number | null = null;
    for (const pair of m) {
      const [a, b] = pair.split(/[,;\s]+/);
      const na = parseCoordNumber(a);
      const nb = parseCoordNumber(b);
      if (na == null || nb == null) continue;
      if (isLat(na) && isLon(nb)) { lat = na; lon = nb; break; }
      if (isLon(na) && isLat(nb)) { lat = nb; lon = na; break; }
    }
    if (lat == null || lon == null) continue;
    const namePart = t.slice(0, t.indexOf(m[0])).trim();
    const nm = namePart.match(NAME_RE);
    poles.push({ name: cleanName(nm ? nm[0] : ''), lat, lon, alt: null });
  }

  return { poles };
}
