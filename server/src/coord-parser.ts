// Excel (.xlsx) ve PDF dosyalarından direk koordinatları çıkarma
import * as XLSX from 'xlsx';
import pdfParse from 'pdf-parse';
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

export async function parsePdfCoordinates(buffer: Buffer): Promise<{ poles: PolePoint[] }> {
  const data = await pdfParse(buffer);
  const text: string = data.text || '';
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
