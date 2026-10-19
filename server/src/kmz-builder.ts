// Direk listesinden Google Earth KMZ dosyası üretme
import AdmZip from 'adm-zip';
import { PolePoint } from './kmz-parser';

function xmlEsc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function isPortalPoint(p: PolePoint): boolean {
  return (
    /^portal/i.test((p.name || '').trim()) ||
    p.meta?.tower_type === 'PORTAL' ||
    p.meta?.function === 'PORTAL' ||
    p.meta?.style === 'portal'
  );
}

export function formatPoleDisplayName(p: PolePoint, idx: number, total: number, towerSeq: number): string {
  const raw = (p.name || '').trim();
  if (isPortalPoint(p)) {
    if (/^portal[-_\s]*(ba[sş]lang[ıi][cç]|biti[sş])/i.test(raw)) return raw;
    if (idx === 0 || (total > 1 && idx < total / 2)) return 'Portal-Başlangıç';
    return 'Portal-Bitiş';
  }
  if (!raw) return `D-${towerSeq}`;
  const cleanNum = raw.replace(/\([A-Za-z0-9]+\)$/, '').trim();
  if (/^\d+$/.test(cleanNum)) return `D-${cleanNum}`;
  return raw;
}

export function formatPoleDescription(p: PolePoint): string {
  const m = p.meta;
  if (!m) return '';
  if (isPortalPoint(p)) {
    if (m.easting != null && m.northing != null) {
      return `X: ${Number(m.easting).toFixed(2)}<br>Y: ${Number(m.northing).toFixed(2)}`;
    }
    return m.description || '';
  }
  const parts: string[] = [];
  if (m.tower_type) parts.push(`Direk Tipi: ${m.tower_type}`);
  if (m.function) parts.push(`Fonksiyon: ${m.function}`);
  if (m.station_text) parts.push(`İstasyon: ${m.station_text}`);
  if (m.easting != null && Number.isFinite(Number(m.easting))) {
    parts.push(`X(E): ${Number(m.easting).toFixed(2)}`);
  }
  if (m.northing != null && Number.isFinite(Number(m.northing))) {
    parts.push(`Y(N): ${Number(m.northing).toFixed(2)}`);
  }
  const cr = (m.crossing || '').trim();
  const rm = (m.remarks || '').trim();
  if (cr && rm && !cr.toLowerCase().includes(rm.toLowerCase())) {
    parts.push(`Geçiş: ${cr} (${rm})`);
  } else if (cr) {
    parts.push(`Geçiş: ${cr}`);
  } else if (rm) {
    parts.push(`Geçiş: ${rm}`);
  }
  if (parts.length > 0) return parts.join('<br>');
  return m.description || '';
}

export function buildKmz(poles: PolePoint[], docName: string): Buffer {
  const towerPlacemarks: string[] = [];
  const portalPlacemarks: string[] = [];
  let towerSeq = 0;

  poles.forEach((p, idx) => {
    const portal = isPortalPoint(p);
    if (!portal) towerSeq += 1;
    const displayName = formatPoleDisplayName(p, idx, poles.length, towerSeq);
    const desc = formatPoleDescription(p);
    const descXml = desc ? `<description><![CDATA[${desc}]]></description>` : '';
    const coord = `${p.lon.toFixed(7)},${p.lat.toFixed(7)},0`;

    if (portal) {
      portalPlacemarks.push(
        `<Placemark><name>${xmlEsc(displayName)}</name>${descXml}<styleUrl>#portal</styleUrl><Point><coordinates>${coord}</coordinates></Point></Placemark>`
      );
    } else {
      const fn = (p.meta?.function || '').toUpperCase();
      const isDead = p.meta?.style === 'dead' || ['KD', 'KT', 'N', 'D'].includes(fn);
      const styleId = isDead ? 'dead' : 'tower';
      towerPlacemarks.push(
        `<Placemark><name>${xmlEsc(displayName)}</name>${descXml}<styleUrl>#${styleId}</styleUrl><Point><coordinates>${coord}</coordinates></Point></Placemark>`
      );
    }
  });

  const line = poles.map((p) => `${p.lon.toFixed(7)},${p.lat.toFixed(7)},0`).join(' ');
  const portalsFolder =
    portalPlacemarks.length > 0
      ? `\n<Folder><name>Portallar</name>\n${portalPlacemarks.join('\n')}\n</Folder>`
      : '';

  const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
<name>${xmlEsc(docName)}</name>
<Style id="tower"><IconStyle><color>ff00ffff</color><scale>0.9</scale><Icon><href>http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href></Icon></IconStyle><LabelStyle><scale>0.8</scale></LabelStyle></Style>
<Style id="dead"><IconStyle><color>ff0000ff</color><scale>1.1</scale><Icon><href>http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href></Icon></IconStyle><LabelStyle><scale>0.8</scale></LabelStyle></Style>
<Style id="portal"><IconStyle><color>ffff0000</color><scale>1.0</scale><Icon><href>http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href></Icon></IconStyle><LabelStyle><scale>0.8</scale></LabelStyle></Style>
<Style id="ln"><LineStyle><color>ff00a5ff</color><width>3</width></LineStyle></Style>
<Folder><name>Hat</name>
<Placemark><name>Enerji İletim Hattı</name><styleUrl>#ln</styleUrl><LineString><tessellate>1</tessellate><coordinates>${line}</coordinates></LineString></Placemark>
</Folder>
<Folder><name>Direkler</name>
${towerPlacemarks.join('\n')}
</Folder>${portalsFolder}
</Document>
</kml>`;

  const zip = new AdmZip();
  zip.addFile('doc.kml', Buffer.from(kml, 'utf8'));
  return zip.toBuffer();
}

