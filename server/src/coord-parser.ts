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
  const s = String(raw).trim();
  // "55.0" gibi kayan noktalı direk numaralarını "55" yap
  return s.replace(/^(\d+)\.0+$/, '$1');
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

export function parseExcelCoordinates(buffer: Buffer): { poles: PolePoint[] } {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) return { poles: [] };
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null }) as unknown[][];

  const cols = detectColumns(rows);
  const poles: PolePoint[] = [];

  if (cols) {
    const start = rows.findIndex((r) => {
      const f0 = fold(String(r[cols.latIdx] ?? ''));
      const f1 = fold(String(r[cols.lonIdx] ?? ''));
      return (LAT_KEYS.some((k) => f0.includes(k)) || LON_KEYS.some((k) => f0.includes(k))) && (LAT_KEYS.some((k) => f1.includes(k)) || LON_KEYS.some((k) => f1.includes(k)));
    });
    for (let r = Math.max(0, start + 1); r < rows.length; r++) {
      const row = rows[r];
      if (!row) continue;
      let lat = parseCoordNumber(row[cols.latIdx]);
      let lon = parseCoordNumber(row[cols.lonIdx]);
      // Başlık "X/Y" yerine değer aralığına göre düzelt
      if (lat != null && lon != null && isLon(lat) && isLat(lon)) {
        const t = lat; lat = lon; lon = t;
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

  return { poles };
}

// PDF metni: koordinat desenlerinden direkleri çıkar
// (document-reader.analyzePdf ile metin katmanı önceden doğrulanır)
// Enine Merkator ters izdüşümü (Krüger serisi) — WGS84/GRS80 elipsoidi
// (ITRF-96 ≈ WGS84: fark cm düzeyinde, ihmal edilir)
function tmToWgs84(easting: number, northing: number, lon0Deg: number, k0: number): { lat: number; lon: number } {
  const a = 6378137;
  const f = 1 / 298.257223563;
  const e2 = f * (2 - f);
  const ep2 = e2 / (1 - e2);
  const n = f / (2 - f);
  const A = (a / (1 + n)) * (1 + (n * n) / 4 + (n * n * n * n) / 64);
  const alpha = [0, n / 2 - (2 * n * n) / 3 + (5 * n * n * n) / 16, (13 * n * n) / 48 - (3 * n * n * n) / 5, (61 * n * n * n) / 240];
  const x = easting - 500000;
  const y = northing;
  const mu = y / k0 / A;
  const phi1 =
    mu +
    alpha[1] * Math.sin(2 * mu) +
    alpha[2] * Math.sin(4 * mu) +
    alpha[3] * Math.sin(6 * mu);
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

// Satırlardan UTM koordinat çiftleri (easting ~6 hane, northing ~7 hane)
// Türkçe ondalık virgülü desteklenir (592259,15 → 592259.15)
export function parseUtmLines(text: string): { name: string; easting: number; northing: number }[] {
  const out: { name: string; easting: number; northing: number }[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = line.match(/\b(\d{6})(?:[.,](\d{1,2}))?[\s|;,]+(\d{7})(?:[.,](\d{1,2}))?\b/);
    if (!m) continue;
    const east = Number(m[1]) + (m[2] ? Number('0.' + m[2]) : 0);
    const north = Number(m[3]) + (m[4] ? Number('0.' + m[4]) : 0);
    if (east < 100000 || east > 900000) continue;
    if (north < 3000000 || north > 6000000) continue; // Türkiye kuzey aralığı
    const first = line.split(/\s+/)[0].replace(/[.:;]+$/, '');
    const name = /^[A-Za-z0-9\-/]{1,12}$/.test(first) ? cleanName(first) : '';
    out.push({ name, easting: east, northing: north });
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
    // 7 haneli (önekli) veya 6 haneli easting + 7 haneli northing
    const m = line.match(/\b(\d{7})(?:[.,](\d{1,2}))?[\s|;,]+(\d{7})(?:[.,](\d{1,2}))?\b/);
    let east: number | null = null;
    let north: number | null = null;
    if (m) {
      const first = Number(m[1]) + (m[2] ? Number('0.' + m[2]) : 0);
      north = Number(m[3]) + (m[4] ? Number('0.' + m[4]) : 0);
      // Önekli easting (dilim no + 6 hane) → öneki sök
      east = first >= 3000000 ? first % 1000000 : null;
    } else {
      const m2 = line.match(/\b(\d{6})(?:[.,](\d{1,2}))?[\s|;,]+(\d{7})(?:[.,](\d{1,2}))?\b/);
      if (!m2) continue;
      east = Number(m2[1]) + (m2[2] ? Number('0.' + m2[2]) : 0);
      north = Number(m2[3]) + (m2[4] ? Number('0.' + m2[4]) : 0);
    }
    if (east == null || north == null) continue;
    if (east < 100000 || east > 900000) continue;
    if (north < 3000000 || north > 6000000) continue;
    const first = line.split(/\s+/)[0].replace(/[.:;]+$/, '');
    const name = /^[A-Za-z0-9\-/]{1,12}$/.test(first) ? cleanName(first) : '';
    out.push({ name, easting: east, northing: north });
  }
  return out;
}

export function parsePdfText(text: string): { poles: PolePoint[] } {
  const poles: PolePoint[] = [];

  const COORD_RE = /(\d{1,2}[.,]\d{3,})\s*[,;\s]\s*(\d{1,2}[.,]\d{3,})/g;
  const NAME_RE = /(?:direk\s*[:\-]?\s*)?(d\s*[:\-]?\s*\d+|[a-z]?\d{1,4})/i;

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
