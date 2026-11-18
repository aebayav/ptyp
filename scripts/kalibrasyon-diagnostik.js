// Kalibrasyon diagnostiği: referans KMZ koordinatlarını sunucudaki direklerle karşılaştırır.
// Yalnızca VPS üzerinde çalıştırılır; tüm ayarlar ortam değişkeni/argümanla verilir:
//   node scripts/kalibrasyon-diagnostik.js [kmz-dosyası] [proje-id]
// Gerekli ortam değişkenleri: PTYP_USER, PTYP_PASS (ve isteğe bağlı PTYP_HOST/PTYP_PORT).
const AdmZip = require(require.resolve('adm-zip', { paths: [`${__dirname}/../server`] }));
const fs = require('fs');
const http = require('http');

const HOST = process.env.PTYP_HOST || '127.0.0.1';
const PORT = Number(process.env.PTYP_PORT || 3000);
const KMZ = process.argv[2] || process.env.PTYP_KMZ || '/tmp/orijinal.kmz';
const PROJECT_ID = Number(process.argv[3] || process.env.PTYP_PROJECT_ID || 1);
const USER = process.env.PTYP_USER;
const PASS = process.env.PTYP_PASS;

if (!USER || !PASS) {
  console.error('PTYP_USER ve PTYP_PASS ortam değişkenlerini tanımlayın.');
  process.exit(1);
}

function post(path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: HOST, port: PORT, path, method: 'POST', headers: { 'Content-Type': 'application/json' } },
      (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => resolve(JSON.parse(d))); }
    );
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

function get(path, token) {
  return new Promise((resolve, reject) => {
    http.get({ host: HOST, port: PORT, path, headers: { Authorization: 'Bearer ' + token } }, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
}

async function main() {
  if (!fs.existsSync(KMZ)) {
    console.error(`KMZ dosyası bulunamadı: ${KMZ}`);
    process.exit(1);
  }
  const tokenRes = await post('/api/auth/login', { username: USER, password: PASS });
  if (!tokenRes.token) {
    console.error('Giriş başarısız:', tokenRes.error || tokenRes);
    process.exit(1);
  }
  const token = tokenRes.token;
  const polesRaw = await get(`/api/poles?project_id=${PROJECT_ID}`, token);
  const list = Array.isArray(polesRaw) ? polesRaw : polesRaw.poles;

  const zip = new AdmZip(KMZ);
  const e = zip.getEntries().find((x) => x.entryName.toLowerCase().endsWith('.kml'));
  const kml = e.getData().toString('utf8');
  const ref = [];
  let m;
  const re = /<coordinates>([^<]+)<\/coordinates>/g;
  while ((m = re.exec(kml))) {
    for (const l of m[1].trim().split(/\s+/)) {
      const [lon, lat] = l.split(',');
      if (lon && lat) ref.push({ lat: +lat, lon: +lon });
    }
  }
  console.log('ref nokta:', ref.length, '| direk:', list.length);

  const kalan = ref
    .map((r) => {
      let bd = 1e9;
      for (const p of list) bd = Math.min(bd, Math.hypot(r.lat - p.lat, r.lon - p.lon));
      return bd * 111320;
    })
    .sort((a, b) => a - b);
  console.log('kalan mesafe (m): min', kalan[0].toFixed(0), '| medyan', kalan[Math.floor(kalan.length / 2)].toFixed(0), '| max', kalan[kalan.length - 1].toFixed(0));
  console.log('kalan > 100m nokta:', kalan.filter((x) => x > 100).length);

  const bb = (arr) =>
    arr.reduce(
      (a, p) => ({ n: Math.max(a.n, p.lat), s: Math.min(a.s, p.lat), e: Math.max(a.e, p.lon), w: Math.min(a.w, p.lon) }),
      { n: -90, s: 90, e: -180, w: 180 }
    );
  const b1 = bb(ref);
  const b2 = bb(list);
  console.log('ref bbox K/G D/B:', b1.n.toFixed(5), b1.s.toFixed(5), b1.e.toFixed(5), b1.w.toFixed(5));
  console.log('biz bbox K/G D/B:', b2.n.toFixed(5), b2.s.toFixed(5), b2.e.toFixed(5), b2.w.toFixed(5));
}
main().catch((err) => { console.error(err); process.exit(1); });
