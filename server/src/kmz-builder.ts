// Direk listesinden Google Earth KMZ dosyası üretme
import AdmZip from 'adm-zip';
import { PolePoint } from './kmz-parser';

function xmlEsc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function buildKmz(poles: PolePoint[], docName: string): Buffer {
  const placemarks = poles
    .map(
      (p, i) =>
        `<Placemark><name>${xmlEsc(p.name || `Direk ${i + 1}`)}</name><Point><coordinates>${p.lon},${p.lat},0</coordinates></Point></Placemark>`
    )
    .join('\n');
  const line = poles.map((p) => `${p.lon},${p.lat},0`).join(' ');
  const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
  <name>${xmlEsc(docName)}</name>
${placemarks}
  <Placemark><name>Güzergah</name><LineString><coordinates>${line}</coordinates></LineString></Placemark>
</Document>
</kml>`;
  const zip = new AdmZip();
  zip.addFile('doc.kml', Buffer.from(kml, 'utf8'));
  return zip.toBuffer();
}
