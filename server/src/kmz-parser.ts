// KMZ (Google Earth) dosyasından direk noktaları ve güzergah hattı çıkarma
import { XMLParser } from 'fast-xml-parser';
import AdmZip from 'adm-zip';

export interface PolePoint {
  name: string;
  lat: number;
  lon: number;
  alt: number | null;
}

export interface KmzResult {
  poles: PolePoint[];
  route: [number, number][] | null;
  placemarkCount: number;
}

// "D-1", "P12", "DP3", "direk 4", "5" gibi adlar direk sayılır
const POLE_NAME_RE = /direk|^d[-._\s]?\d+$|^p[-._\s]?\d+$|^dp[-._\s]?\d+$|^\d+$/i;

function parseCoord(s: string): { lon: number; lat: number; alt: number | null } | null {
  const parts = s.split(',').map((x) => x.trim());
  if (parts.length < 2) return null;
  const lon = Number(parts[0]);
  const lat = Number(parts[1]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  const alt = parts.length >= 3 && parts[2] !== '' ? Number(parts[2]) : null;
  return { lon, lat, alt: Number.isFinite(alt!) ? alt : null };
}

export function parseKmz(buffer: Buffer): KmzResult {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();
  if (entries.length === 0) throw new Error('KMZ dosyası boş veya bozuk.');
  const kmlEntry = entries.find((e) => e.entryName.toLowerCase().endsWith('.kml')) || entries[0];
  const kml = kmlEntry.getData().toString('utf8');
  return parseKmlText(kml);
}

// KML metnini ayrıştır (hem KMZ içinden hem doğrudan .kml yüklemesinden)
export function parseKmlText(kml: string): KmzResult {
  if (!kml || kml.length < 20) throw new Error('KML içeriği okunamadı.');

  const doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' }).parse(kml);

  const points: { name: string; coord: string }[] = [];
  const lines: string[] = [];

  function walk(node: unknown): void {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const obj = node as Record<string, unknown>;
    if (obj.Placemark) {
      for (const p of Array.isArray(obj.Placemark) ? obj.Placemark : [obj.Placemark]) {
        const pm = p as Record<string, any>;
        const name = pm.name != null ? String(pm.name).trim() : '';
        const point = pm.Point || pm.MultiGeometry?.Point;
        const coord = point?.coordinates != null ? String(point.coordinates).trim() : '';
        if (coord) points.push({ name, coord });
      }
    }
    if (obj.LineString) {
      for (const ls of Array.isArray(obj.LineString) ? obj.LineString : [obj.LineString]) {
        const c = (ls as Record<string, any>).coordinates != null ? String((ls as Record<string, any>).coordinates).trim() : '';
        if (c) lines.push(c);
      }
    }
    for (const [k, v] of Object.entries(obj)) {
      // Placemark içindeki LineString'i de yakalamak için ağaca inmeye devam et
      if (k === 'Point') continue; // Point.coordinates string'dir, gereksiz
      walk(v);
    }
  }
  walk(doc);

  const allPoints = points
    .map((p) => {
      const c = parseCoord(p.coord);
      return c ? { name: p.name, lon: c.lon, lat: c.lat, alt: c.alt } : null;
    })
    .filter((p): p is PolePoint => p !== null);

  // Direk desenine uyanlar; hiçbiri uymuyorsa tüm noktalar direk sayılır
  let poles = allPoints.filter((p) => POLE_NAME_RE.test(p.name));
  if (poles.length === 0) poles = allPoints;

  // Güzergah hattı: ilk LineString'in noktaları (Leaflet sırası: [lat, lon])
  let route: [number, number][] | null = null;
  if (lines.length > 0) {
    const pts = lines[0]
      .split(/\s+/)
      .map((t) => parseCoord(t))
      .filter((c): c is { lon: number; lat: number; alt: number | null } => c !== null);
    if (pts.length >= 2) route = pts.map((c) => [c.lat, c.lon]);
  }

  return { poles, route, placemarkCount: points.length };
}

// Güzergah uzunluğu (haversine, km)
export function routeLengthKm(route: [number, number][]): number {
  const R = 6371;
  const rad = (d: number) => (d * Math.PI) / 180;
  let total = 0;
  for (let i = 1; i < route.length; i++) {
    const [lat1, lon1] = route[i - 1];
    const [lat2, lon2] = route[i];
    const dLat = rad(lat2 - lat1);
    const dLon = rad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
    total += 2 * R * Math.asin(Math.sqrt(a));
  }
  return Math.round(total * 100) / 100;
}
