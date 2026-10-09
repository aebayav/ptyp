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

// Metre cinsinden yaklaşık mesafe (hızlı, küçük ölçekte yeterli)
export function distM(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number }
): number {
  const dx = (b.lon - a.lon) * Math.cos((a.lat * Math.PI) / 180) * 111320;
  const dy = (b.lat - a.lat) * 111320;
  return Math.hypot(dx, dy);
}

// Aynı fiziksel noktaya düşen çoklu etiketleri (faz/devre işaretleri) tek direk olarak kümele
export function dedupePoles(points: PolePoint[], radiusM = 15): PolePoint[] {
  const clusters: PolePoint[][] = [];
  for (const p of points) {
    const cluster = clusters.find((c) => c.some((q) => distM(q, p) < radiusM));
    if (cluster) cluster.push(p);
    else clusters.push([p]);
  }
  return clusters.map((c) => {
    const lat = c.reduce((s, x) => s + x.lat, 0) / c.length;
    const lon = c.reduce((s, x) => s + x.lon, 0) / c.length;
    // 10.000 m üzeri rakımlar bozuk veri kabul edilir; 0 = eksik veri, gerçek değer önceliklidir
    const alt =
      c.find((x) => x.alt != null && x.alt > 0 && x.alt < 10000)?.alt ??
      c.find((x) => x.alt != null && x.alt < 10000)?.alt ??
      null;
    // Öncelik: "D-1"/"P2"/"direk 4" deseni > düz rakam > herhangi bir isim
    const DASH_RE = /direk|^d[-._\s]?\d+$|^p[-._\s]?\d+$|^dp[-._\s]?\d+$/i;
    const best =
      c.find((x) => DASH_RE.test(x.name)) ||
      c.find((x) => POLE_NAME_RE.test(x.name)) ||
      c.find((x) => x.name) ||
      null;
    return { name: best ? best.name : '', lat, lon, alt };
  });
}

// Direkleri güzergah hattı boyunca sırala (her direk en yakın rota noktasına göre)
export function sortByRoute(poles: PolePoint[], route: [number, number][]): PolePoint[] {
  const withOrder = poles.map((p) => {
    let bestI = 0;
    let bestD = Infinity;
    route.forEach(([lat, lon], i) => {
      const d = distM({ lat, lon }, p);
      if (d < bestD) {
        bestD = d;
        bestI = i;
      }
    });
    return { p, order: bestI };
  });
  return withOrder.sort((a, b) => a.order - b.order).map((x) => x.p);
}

// Rota yoksa: en yakın komşu zinciriyle sırala (güney ucundan başla)
export function sortNearestNeighbor(poles: PolePoint[]): PolePoint[] {
  if (poles.length < 2) return poles;
  const remaining = [...poles].sort((a, b) => a.lat - b.lat);
  const ordered: PolePoint[] = [remaining.shift()!];
  while (remaining.length > 0) {
    let bestI = 0;
    let bestD = Infinity;
    remaining.forEach((p, i) => {
      const d = distM(ordered[ordered.length - 1], p);
      if (d < bestD) {
        bestD = d;
        bestI = i;
      }
    });
    ordered.push(remaining.splice(bestI, 1)[0]);
  }
  return ordered;
}

function parseCoord(s: string): { lon: number; lat: number; alt: number | null } | null {
  const parts = s.split(',').map((x) => x.trim());
  if (parts.length < 2) return null;
  const lon = Number(parts[0]);
  const lat = Number(parts[1]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  const alt = parts.length >= 3 && parts[2] !== '' ? Number(parts[2]) : null;
  return { lon, lat, alt: alt != null && Number.isFinite(alt) ? alt : null };
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
  const lines: [number, number][][] = [];

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
        if (c) {
          const pts = c
            .split(/\s+/)
            .map((t) => parseCoord(t))
            .filter((x): x is { lon: number; lat: number; alt: number | null } => x !== null);
          if (pts.length >= 2) lines.push(pts.map((x) => [x.lat, x.lon]));
        }
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

  // Ana rota: en çok noktalı LineString (kısa etiket parçaları değil)
  let route: [number, number][] | null = null;
  if (lines.length > 0) {
    route = lines.reduce((best, l) => (l.length > best.length ? l : best), lines[0]);
  }

  // Direkler: aynı noktaya düşen etiketleri kümele; rota varsa ona göre sırala
  const unique = dedupePoles(allPoints);
  const poles = route && route.length >= 2 ? sortByRoute(unique, route) : sortNearestNeighbor(unique);

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
