// PTYP — firma sunumu için gerçekçi örnek veri seti
// Kullanım: node scripts/seed-demo.mjs
const BASE = process.env.PTYP_URL || 'http://202.92.21.116:3000';

let token = '';
const ids = { materials: {}, suppliers: {}, groups: {}, users: {} };

async function api(path, { method = 'GET', body, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* boş yanıt */ }
  if (!res.ok) {
    const msg = (json && json.error) ? json.error : `HTTP ${res.status}`;
    throw new Error(`${method} ${path} → ${msg}`);
  }
  return json ?? text;
}

function log(ok, msg) {
  console.log(`${ok ? '  ✓' : '  ✗'} ${msg}`);
}

async function cleanup() {
  console.log('--- Temizlik (paralel oturum test çöpleri) ---');
  try {
    const projs = await api('/api/projects');
    for (const p of projs) {
      if (p.name === 'xasdadsa') {
        await api(`/api/projects/${p.id}`, { method: 'DELETE' });
        log(true, `proje silindi: ${p.name}`);
      }
    }
  } catch (e) { log(false, 'proje temizliği: ' + e.message); }

  try {
    const projs = await api('/api/projects');
    for (const p of projs) {
      const groups = await api(`/api/workgroups?project_id=${p.id}`);
      for (const g of groups) {
        if (g.name === 'aaaa' || g.name.startsWith('test') || g.name.startsWith('Test')) {
          await api(`/api/workgroups/${g.id}`, { method: 'DELETE' });
          log(true, `iş grubu silindi: ${g.name} (${p.name})`);
        }
      }
    }
  } catch (e) { log(false, 'grup temizliği: ' + e.message); }

  try {
    const mats = await api('/api/materials');
    for (const m of mats) {
      if (m.name === 'test') {
        await api(`/api/materials/${m.id}`, { method: 'DELETE' });
        log(true, `malzeme silindi: ${m.name}`);
      }
    }
  } catch (e) { log(false, 'malzeme temizliği: ' + e.message); }

  try {
    const sups = await api('/api/suppliers');
    for (const s of sups) {
      if (s.name === 'asdfa') {
        await api(`/api/suppliers/${s.id}`, { method: 'DELETE' });
        log(true, `satıcı silindi: ${s.name}`);
      }
    }
  } catch (e) { log(false, 'satıcı temizliği: ' + e.message); }

  try {
    const quotes = await api('/api/quotes');
    for (const q of quotes) {
      await api(`/api/quotes/${q.id}`, { method: 'DELETE' });
    }
    if (quotes.length) log(true, `${quotes.length} eski teklif silindi`);
  } catch (e) { log(false, 'teklif temizliği: ' + e.message); }
}

async function seedProjects() {
  console.log('--- Projeler ---');
  const projs = await api('/api/projects');
  const p1 = projs.find((p) => p.name === 'Şantiye 1');
  await api(`/api/projects/${p1.id}`, {
    method: 'PUT',
    body: {
      name: 'Şantiye 1',
      type: 'enh',
      capacity: '154 kV Çift Devre',
      employer: 'Kalyon Enerji Yatırımları A.Ş.',
      contract_no: 'KLY-2026/014',
      start_date: '2026-03-02',
      end_date: '2026-12-31',
    },
  });
  log(true, `Şantiye 1 güncellendi (Kalyon ENH, ${p1.pole_count} direk)`);

  let p2 = projs.find((p) => p.name === 'Şantiye 2');
  const p2fields = {
    name: 'Şantiye 2',
    type: 'tm',
    capacity: '154/34,5 kV — 2×25 MVA',
    employer: 'Kalyon Enerji Yatırımları A.Ş.',
    contract_no: 'KLY-2026/014-TM',
    start_date: '2026-04-15',
    end_date: '2026-11-30',
  };
  if (p2) {
    await api(`/api/projects/${p2.id}`, { method: 'PUT', body: p2fields });
    log(true, `Şantiye 2 zaten var (id=${p2.id}) — güncellendi`);
  } else {
    p2 = await api('/api/projects', { method: 'POST', body: p2fields });
    log(true, `Şantiye 2 oluşturuldu (Trafo Merkezi, id=${p2.id})`);
  }
  ids.p2 = p2.id;
}

async function seedTrafoKmz() {
  console.log('--- Şantiye 2 KMZ (trafo sahası direkleri) ---');
  const baseLat = 39.8934, baseLon = 32.8151;
  const names = ['TM-1', 'TM-2', 'TM-3', 'TM-4', 'TM-5', 'TM-6', 'TM-7', 'TM-8'];
  const pts = names.map((n, i) => {
    const lat = baseLat + Math.sin((i / 7) * Math.PI) * 0.006;
    const lon = baseLon + i * 0.0011;
    return `<Placemark><name>${n}</name><Point><coordinates>${lon.toFixed(6)},${lat.toFixed(6)},860</coordinates></Point></Placemark>`;
  }).join('\n');
  const line = names.map((_, i) => {
    const lat = baseLat + Math.sin((i / 7) * Math.PI) * 0.006;
    return `${(baseLon + i * 0.0011).toFixed(6)},${lat.toFixed(6)},860`;
  }).join(' ');
  const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Trafo Merkezi Sahası</name>
${pts}
<Placemark><name>TM-hat</name><LineString><coordinates>${line}</coordinates></LineString></Placemark>
</Document></kml>`;
  const zip = await import('../server/node_modules/adm-zip/adm-zip.js').then((m) => m.default ?? m);
  const z = new zip();
  z.addFile('doc.kml', Buffer.from(kml, 'utf8'));
  const fd = new FormData();
  fd.append('project_id', String(ids.p2));
  fd.append('file', new Blob([z.toBuffer()], { type: 'application/octet-stream' }), 'santiye2-trafo.kmz');
  const r = await api('/api/poles/upload', { method: 'POST', form: fd });
  log(true, `Şantiye 2 KMZ yüklendi: ${r.saved} direk · hat ${r.connection_km} km`);
}

async function seedUsers() {
  console.log('--- Kullanıcılar ---');
  const existing = await api('/api/users');
  const names = existing.map((u) => u.username);
  if (!names.includes('mert.demir')) {
    await api('/api/users', {
      method: 'POST',
      body: { username: 'mert.demir', password: 'mert.demir', display_name: 'Mert Demir', role: 'owner' },
    });
    log(true, 'kullanıcı: mert.demir (Saha Şefi, owner)');
  } else log(true, 'mert.demir zaten var');
  const users = await api('/api/users');
  const mert = users.find((u) => u.username === 'mert.demir');
  const admin = users.find((u) => u.username === 'admin');
  ids.users.mert = mert.id;
  ids.users.admin = admin.id;
}

async function seedSuppliers() {
  console.log('--- Satıcılar ---');
  const list = [
    { name: 'DEMİRER Kablo San. ve Tic. A.Ş.', contact: 'Serkan Demirer', phone: '0216 555 34 21', email: 'teklif@demirerkablo.com.tr', address: 'İstanbul', notes: 'İletken ve OPGW ana tedarikçi' },
    { name: 'ELTAŞ Transformatör San. A.Ş.', contact: 'Ayhan Eltaş', phone: '0232 444 90 10', email: 'satis@eltas.com.tr', address: 'İzmir', notes: 'Güç trafoları, 20+ yıllık tedarikçi' },
    { name: 'ÇİMSA Beton — Ankara Şube', contact: 'Nuri Karaca', phone: '0312 555 77 00', email: 'ankara@cimsa.com.tr', address: 'Ankara', notes: 'Hazır beton, sahaya mobil santral kurulabilir' },
    { name: 'ENERJİSA Enerji Ekipmanları Ltd.', contact: 'Gökhan Aydın', phone: '0312 444 12 33', email: 'info@enerjisa-ekipman.com.tr', address: 'Ankara', notes: 'Kesici, ayırıcı, izolatör' },
    { name: 'SİMTAŞ Galvaniz ve Çelik Direk A.Ş.', contact: 'Emre Şimşek', phone: '0332 555 44 88', email: 'teklif@simtas.com.tr', address: 'Konya', notes: 'Direk imalatı, galvaniz kaplama' },
  ];
  const existing = await api('/api/suppliers');
  const existingNames = new Set(existing.map((s) => s.name));
  for (const s of list) {
    if (existingNames.has(s.name)) {
      ids.suppliers[s.name] = existing.find((x) => x.name === s.name).id;
      log(true, `satıcı zaten var: ${s.name}`);
      continue;
    }
    const created = await api('/api/suppliers', { method: 'POST', body: s });
    ids.suppliers[s.name] = created.id;
    log(true, `satıcı: ${s.name}`);
  }
}

async function seedMaterials() {
  console.log('--- Malzemeler ---');
  const list = [
    { name: 'ACSR 954 MCM Çelik Özlü Alüminyum İletken', category: 'İLETKEN', spec: '954 MCM, 54/7 al, galvaniz çekirdek', unit: 'km', quantity: 42, target_price: 1450000, status: 'open', notes: 'Direk aralığı ~300 m için hesaplandı' },
    { name: 'OPGW 48 Fiber Optik Toprak İletkeni', category: 'İLETKEN', spec: '48 FO, 12.5 kA kısa devre kapasiteli', unit: 'km', quantity: 42, target_price: 520000, status: 'open', notes: '' },
    { name: '154 kV Galvanizli Çelik Direk', category: 'DİREK', spec: 'Kafes tip, yükseklik 25-40 m, sıcak daldırma galvaniz', unit: 'ton', quantity: 850, target_price: 98000, status: 'open', notes: 'Kalyon ENH güzergahı için' },
    { name: 'Cam İzolatör U160BS', category: 'EKİPMAN', spec: 'U160BS, mekanik dayanım 160 kN', unit: 'adet', quantity: 5200, target_price: 1850, status: 'open', notes: '' },
    { name: 'Kompozit Silikon İzolatör FXBW-154/160', category: 'EKİPMAN', spec: '154 kV, 160 kN', unit: 'adet', quantity: 600, target_price: 6200, status: 'open', notes: 'Trafo merkezi giriş kapıları' },
    { name: 'SF6 Kesici 154 kV', category: 'TRAFO MERKEZİ', spec: '154 kV, 40 kA, 2000 A, 3 faz', unit: 'adet', quantity: 6, target_price: 2400000, status: 'open', notes: '' },
    { name: 'Motorlu Ayırıcı 154 kV', category: 'TRAFO MERKEZİ', spec: 'Çift topraklamalı, 1600 A', unit: 'adet', quantity: 12, target_price: 480000, status: 'open', notes: '' },
    { name: 'Güç Transformatörü 154/34,5 kV — 25 MVA', category: 'TRAFO MERKEZİ', spec: 'ONAN, %12,5 empedans, kademe değiştiricili', unit: 'adet', quantity: 2, target_price: 45000000, status: 'open', notes: 'Uzun teslim — 24 hafta' },
    { name: 'OG/AG Metal Clad Hücre', category: 'TRAFO MERKEZİ', spec: '34,5 kV, 16 hücre, çekmeceli kesicili', unit: 'adet', quantity: 16, target_price: 1150000, status: 'open', notes: '' },
    { name: 'SCADA ve Koruma Sistemi', category: 'TRAFO MERKEZİ', spec: 'RTU, röle koordinasyonu, fiber haberleşme', unit: 'set', quantity: 1, target_price: 8500000, status: 'open', notes: 'TEİAŞ şartnamesine uygun' },
    { name: 'Hazır Beton C30/37', category: 'İNŞAAT', spec: 'Pompalı, donma dirençli', unit: 'm³', quantity: 2600, target_price: 2850, status: 'open', notes: '' },
    { name: 'Betonarme Demiri B420C', category: 'İNŞAAT', spec: 'Nervürlü, 8-32 mm', unit: 'ton', quantity: 310, target_price: 33500, status: 'open', notes: '' },
  ];
  const existing = await api('/api/materials');
  const existingNames = new Set(existing.map((m) => m.name));
  for (const m of list) {
    if (existingNames.has(m.name)) {
      ids.materials[m.name] = existing.find((x) => x.name === m.name).id;
      log(true, `malzeme zaten var: ${m.name}`);
      continue;
    }
    const created = await api('/api/materials', { method: 'POST', body: m });
    ids.materials[m.name] = created.id;
    log(true, `malzeme: ${m.name} (${created.code})`);
  }
}

async function seedQuotes() {
  console.log('--- Teklifler ---');
  const existing = await api('/api/quotes');
  const existingKeys = new Set(existing.map((q) => `${q.material_id}|${q.supplier_id}`));
  let added = 0;
  const q = async (material, supplier, price, extra = {}) => {
    const key = `${ids.materials[material]}|${ids.suppliers[supplier]}`;
    if (existingKeys.has(key)) return false;
    await api('/api/quotes', {
      method: 'POST',
      body: {
        material_id: ids.materials[material],
        supplier_id: ids.suppliers[supplier],
        price, currency: 'TRY', delivery_days: 30, validity_date: '2026-11-30', status: 'received', notes: '',
        ...extra,
      },
    });
    added++;
    return true;
  };

  await q('ACSR 954 MCM Çelik Özlü Alüminyum İletken', 'DEMİRER Kablo San. ve Tic. A.Ş.', 1390000, { status: 'selected', delivery_days: 45, notes: 'En iyi fiyat + 24 ay garanti' });
  await q('ACSR 954 MCM Çelik Özlü Alüminyum İletken', 'ENERJİSA Enerji Ekipmanları Ltd.', 1525000);
  await q('OPGW 48 Fiber Optik Toprak İletkeni', 'DEMİRER Kablo San. ve Tic. A.Ş.', 495000, { status: 'selected', notes: 'Fiber sonlandırma dahil' });
  await q('OPGW 48 Fiber Optik Toprak İletkeni', 'ENERJİSA Enerji Ekipmanları Ltd.', 565000);
  await q('154 kV Galvanizli Çelik Direk', 'SİMTAŞ Galvaniz ve Çelik Direk A.Ş.', 92500, { status: 'selected', delivery_days: 60, notes: 'Nakliye dahil, şantiye teslim' });
  await q('154 kV Galvanizli Çelik Direk', 'ENERJİSA Enerji Ekipmanları Ltd.', 104000);
  await q('Cam İzolatör U160BS', 'ENERJİSA Enerji Ekipmanları Ltd.', 1740, { status: 'selected' });
  await q('Cam İzolatör U160BS', 'DEMİRER Kablo San. ve Tic. A.Ş.', 1990);
  await q('SF6 Kesici 154 kV', 'ENERJİSA Enerji Ekipmanları Ltd.', 2250000, { status: 'selected', delivery_days: 90, notes: 'ABB muadili, 2 yıl garanti' });
  await q('SF6 Kesici 154 kV', 'ELTAŞ Transformatör San. A.Ş.', 2580000);
  await q('Güç Transformatörü 154/34,5 kV — 25 MVA', 'ELTAŞ Transformatör San. A.Ş.', 43250000, { status: 'selected', delivery_days: 168, notes: 'Teknik şartname uyumlu, montaj gözetimi dahil' });
  await q('Güç Transformatörü 154/34,5 kV — 25 MVA', 'ENERJİSA Enerji Ekipmanları Ltd.', 48900000, { delivery_days: 210 });
  await q('Hazır Beton C30/37', 'ÇİMSA Beton — Ankara Şube', 2680, { status: 'selected', delivery_days: 1, notes: 'Sahaya mobil santral + pompa' });
  await q('Hazır Beton C30/37', 'SİMTAŞ Galvaniz ve Çelik Direk A.Ş.', 3010);
  await q('Betonarme Demiri B420C', 'ÇİMSA Beton — Ankara Şube', 32900);
  await q('Betonarme Demiri B420C', 'SİMTAŞ Galvaniz ve Çelik Direk A.Ş.', 34500);
  log(true, `${added} teklif eklendi (kabul edilenler dahil)`);
}

async function seedWorkGroupsAndTasks() {
  console.log('--- İş Grupları & Görevler ---');
  const p1 = (await api('/api/projects')).find((p) => p.name === 'Şantiye 1').id;

  const g1 = [
    { name: 'Güzergah Açma ve Kazı', weight: 12, progress: 100, planned_start: '2026-03-02', planned_end: '2026-05-15', status: 'completed', segment_from: 1, segment_to: 38, notes: '38 direk yeri açıldı, kazı tamamlandı' },
    { name: 'Temel Beton ve Gömme', weight: 20, progress: 62, planned_start: '2026-04-01', planned_end: '2026-07-31', status: 'active', segment_from: 1, segment_to: 38, notes: '26/38 temel döküldü' },
    { name: 'Direk Montajı', weight: 30, progress: 34, planned_start: '2026-05-15', planned_end: '2026-09-30', status: 'active', segment_from: 1, segment_to: 38, notes: '13 direk montajlandı, 4 tanesi ağır vinç bekliyor' },
    { name: 'İletken ve OPGW Çekimi', weight: 25, progress: 0, planned_start: '2026-09-01', planned_end: '2026-11-15', status: 'pending', segment_from: 1, segment_to: 38, notes: 'Makara ve gerdirme ekipmanı siparişi verildi' },
    { name: 'Test, Kontrol ve Devreye Alma', weight: 13, progress: 0, planned_start: '2026-11-01', planned_end: '2026-12-20', status: 'pending', notes: 'TEİAŞ kabul prosedürü' },
  ];
  const g2 = [
    { name: 'Saha Hazırlığı ve Hafriyat', weight: 20, progress: 100, planned_start: '2026-04-15', planned_end: '2026-05-30', status: 'completed', notes: '' },
    { name: 'Betonarme İşleri', weight: 35, progress: 45, planned_start: '2026-05-10', planned_end: '2026-08-31', status: 'active', notes: 'Trafo binası temeli + kule temelleri' },
    { name: 'Trafo ve Ekipman Montajı', weight: 30, progress: 0, planned_start: '2026-09-01', planned_end: '2026-11-15', status: 'pending', notes: 'Trafoların nakliyesi Eylül başı' },
    { name: 'Kumanda Binası ve SCADA', weight: 15, progress: 10, planned_start: '2026-07-01', planned_end: '2026-11-30', status: 'active', notes: '' },
  ];

  const existingGroups = [];
  for (const p of await api('/api/projects')) {
    existingGroups.push(...(await api(`/api/workgroups?project_id=${p.id}`)));
  }
  const existingGroupNames = new Set(existingGroups.map((g) => `${g.project_id}|${g.name}`));
  const makeGroup = async (g, pid) => {
    const key = `${pid}|${g.name}`;
    if (existingGroupNames.has(key)) {
      const found = existingGroups.find((x) => x.project_id === pid && x.name === g.name);
      ids.groups[g.name] = found.id;
      log(true, `grup zaten var: ${g.name}`);
      return;
    }
    const created = await api('/api/workgroups', { method: 'POST', body: { ...g, project_id: pid } });
    ids.groups[g.name] = created.id;
    log(true, `grup: ${created.code} ${g.name} (%${g.progress})`);
  };

  for (const g of g1) await makeGroup(g, p1);
  for (const g of g2) await makeGroup(g, ids.p2);

  console.log('--- Görevler ---');
  const tasks = [
    { group: 'Temel Beton ve Gömme', title: 'Km 12-24 arası temel kalıp kontrolü', description: 'Tüm temel kalıplarının proje kotuna göre kontrolü ve beton öncesi tutanak', assignee: 'mert', due_date: '2026-10-05', priority: 'high', status: 'in_progress' },
    { group: 'Temel Beton ve Gömme', title: 'Beton santrali kalite belgeleri arşivi', description: 'Her döküm için çökme ve numune raporlarını dosyala', assignee: 'mert', due_date: '2026-10-18', priority: 'normal', status: 'todo' },
    { group: 'Direk Montajı', title: 'D14-D17 arası direk montajı', description: '4 kafes direk montajı; 100T vinçle 3 gün planlanıyor', assignee: 'mert', due_date: '2026-10-25', priority: 'high', status: 'in_progress' },
    { group: 'Direk Montajı', title: 'Montaj için ağır vinç rezervasyonu', description: '100 tonluk vinç için sözleşme ve iş programı', assignee: 'admin', due_date: '2026-10-10', priority: 'high', status: 'in_progress' },
    { group: 'Direk Montajı', title: 'Montaj öncesi civata tork testleri', description: 'Montajlanan 13 direğin tork kalibrasyon kayıtları', assignee: 'mert', due_date: '2026-10-30', priority: 'normal', status: 'todo' },
    { group: 'İletken ve OPGW Çekimi', title: 'Çekim makaraları ve gerdirme seti siparişi', description: 'KMZ güzergahına göre ekipman listesi çıkarılıp siparişe bağlansın', assignee: 'admin', due_date: '2026-10-15', priority: 'high', status: 'todo' },
    { group: 'Güzergah Açma ve Kazı', title: 'Kazı işleri kapanış tutanağı', description: '38 direk yerinin kabul tutanakları ve fotoğraf arşivi', assignee: 'mert', due_date: '2026-06-01', priority: 'normal', status: 'done' },
    { group: 'Betonarme İşleri', title: 'Trafo binası taban döşemesi', description: 'Döşeme demiri + beton dökümü', assignee: 'mert', due_date: '2026-10-12', priority: 'high', status: 'in_progress' },
    { group: 'Kumanda Binası ve SCADA', title: 'SCADA panel şeması onayı', description: 'TEİAŞ onayına sunulacak son revizyon', assignee: 'admin', due_date: '2026-10-22', priority: 'normal', status: 'todo' },
  ];
  const existingTasks = await api('/api/tasks');
  const existingTitles = new Set(existingTasks.map((t) => t.title));
  for (const t of tasks) {
    if (existingTitles.has(t.title)) {
      log(true, `görev zaten var: ${t.title}`);
      continue;
    }
    await api('/api/tasks', {
      method: 'POST',
      body: {
        work_group_id: ids.groups[t.group],
        title: t.title,
        description: t.description,
        assignee_id: t.assignee === 'mert' ? ids.users.mert : ids.users.admin,
        due_date: t.due_date,
        priority: t.priority,
        status: t.status,
      },
    });
    log(true, `görev: ${t.title} (${t.status})`);
  }
}

async function seedPayments() {
  console.log('--- Hakedişler ---');
  const p1 = (await api('/api/projects')).find((p) => p.name === 'Şantiye 1').id;

  const h1items = [
    { work_group_id: ids.groups['Güzergah Açma ve Kazı'], item_name: 'Kazı ve Tahkimat', unit: 'm³', contract_qty: 12400, previous_qty: 0, current_qty: 12400, unit_price: 850, notes: 'Tamamlandı' },
    { work_group_id: ids.groups['Temel Beton ve Gömme'], item_name: 'C30/37 Temel Betonu', unit: 'm³', contract_qty: 1850, previous_qty: 0, current_qty: 1150, unit_price: 4950, notes: '26 temel' },
    { work_group_id: ids.groups['Direk Montajı'], item_name: '154 kV Direk Montajı', unit: 'adet', contract_qty: 38, previous_qty: 0, current_qty: 9, unit_price: 385000, notes: '9 direk' },
  ];
  const existingPays = await api(`/api/progress-payments?project_id=${p1}`);
  const existingPayLabels = new Set(existingPays.map((x) => x.period_label));
  if (!existingPayLabels.has('1 Nolu Hakediş — Haziran 2026')) {
    await api('/api/progress-payments', {
      method: 'POST',
      body: { project_id: p1, period_label: '1 Nolu Hakediş — Haziran 2026', notes: 'Kazı kapanışı + temel ve montaj ara hakedişi', items: h1items, status: 'draft' },
    });
    log(true, 'S1: 1 Nolu Hakediş (draft) — 3 kalem');
  } else log(true, 'hakediş zaten var: 1 Nolu Hakediş');

  const h2items = [
    { work_group_id: ids.groups['Temel Beton ve Gömme'], item_name: 'C30/37 Temel Betonu', unit: 'm³', contract_qty: 1850, previous_qty: 1150, current_qty: 700, unit_price: 4950, notes: 'Kalan temeller' },
    { work_group_id: ids.groups['Direk Montajı'], item_name: '154 kV Direk Montajı', unit: 'adet', contract_qty: 38, previous_qty: 9, current_qty: 4, unit_price: 385000, notes: 'Ağır vinç dönemi' },
    { work_group_id: ids.groups['İletken ve OPGW Çekimi'], item_name: 'İletken Çekimi (hazırlık)', unit: 'km', contract_qty: 42, previous_qty: 0, current_qty: 0, unit_price: 185000, notes: 'Malzeme temini sürüyor' },
  ];
  if (!existingPayLabels.has('2 Nolu Hakediş — Ağustos 2026')) {
    await api('/api/progress-payments', {
      method: 'POST',
      body: { project_id: p1, period_label: '2 Nolu Hakediş — Ağustos 2026', notes: 'Ara hakediş (taslak)', items: h2items, status: 'draft' },
    });
    log(true, 'S1: 2 Nolu Hakediş (draft) — 3 kalem');
  } else log(true, 'hakediş zaten var: 2 Nolu Hakediş');

  const h3items = [
    { work_group_id: ids.groups['Saha Hazırlığı ve Hafriyat'], item_name: 'Hafriyat ve Saha Tesviyesi', unit: 'm³', contract_qty: 8600, previous_qty: 0, current_qty: 8600, unit_price: 420, notes: 'Tamamlandı' },
    { work_group_id: ids.groups['Betonarme İşleri'], item_name: 'C30/37 Beton (trafo binası)', unit: 'm³', contract_qty: 2400, previous_qty: 0, current_qty: 1080, unit_price: 5200, notes: '%45 ilerleme' },
  ];
  const existingPays2 = await api(`/api/progress-payments?project_id=${ids.p2}`);
  if (!existingPays2.some((x) => x.period_label === '1 Nolu Hakediş — Temmuz 2026')) {
    await api('/api/progress-payments', {
      method: 'POST',
      body: { project_id: ids.p2, period_label: '1 Nolu Hakediş — Temmuz 2026', notes: '', items: h3items, status: 'draft' },
    });
    log(true, 'S2: 1 Nolu Hakediş (draft) — 2 kalem');
  } else log(true, 'hakediş zaten var: S2 1 Nolu Hakediş');
}

async function seedDailyReports() {
  console.log('--- Günlük Raporlar ---');
  const p1 = (await api('/api/projects')).find((p) => p.name === 'Şantiye 1').id;

  const reports = [
    {
      project_id: p1, report_date: '2026-10-07', weather: 'acik', temperature: 21,
      work_summary: 'D14 ve D15 direkleri montajlandı. Temel dökümü km 21-22 arası 2 temel tamamlandı. İş güvenliği toplantısı yapıldı.',
      issues: 'Vinç arızası nedeniyle D16 montajı yarına ertelendi.',
      crew: [{ role: 'muhendis', count: 2 }, { role: 'usta', count: 4 }, { role: 'isci', count: 18 }, { role: 'taseron', count: 6 }],
      equipment: [{ equipment_type: 'vinc', count: 2 }, { equipment_type: 'kamyon', count: 4 }, { equipment_type: 'jenerator', count: 1 }],
    },
    {
      project_id: p1, report_date: '2026-10-08', weather: 'bulutlu', temperature: 17,
      work_summary: 'D16 montajı tamamlandı. D17-D18 arası temel kazısı sürüyor. OPGW makaralarının muayenesi yapıldı.',
      issues: '',
      crew: [{ role: 'muhendis', count: 2 }, { role: 'usta', count: 5 }, { role: 'isci', count: 21 }, { role: 'taseron', count: 6 }],
      equipment: [{ equipment_type: 'vinc', count: 1 }, { equipment_type: 'kepce', count: 2 }, { equipment_type: 'kamyon', count: 5 }],
    },
    {
      project_id: p1, report_date: '2026-10-09', weather: 'acik', temperature: 19,
      work_summary: 'Km 21-22 temel betonu döküldü (2 temel). D17 direk kafesi sahaya getirildi, montaj öncesi kontroller tamam.',
      issues: 'İletken teslimatında 3 gün gecikme bildirildi.',
      crew: [{ role: 'muhendis', count: 2 }, { role: 'usta', count: 4 }, { role: 'isci', count: 20 }],
      equipment: [{ equipment_type: 'vinc', count: 1 }, { equipment_type: 'kepce', count: 2 }, { equipment_type: 'kamyon', count: 3 }, { equipment_type: 'beton_pompasi', count: 1 }],
    },
    {
      project_id: ids.p2, report_date: '2026-10-08', weather: 'acik', temperature: 18,
      work_summary: 'Trafo binası kolon kalıpları söküldü. 34,5 kV bara odası döşeme demiri bağlandı. Kumanda binası tuğla duvar %40.',
      issues: '',
      crew: [{ role: 'muhendis', count: 1 }, { role: 'usta', count: 3 }, { role: 'isci', count: 14 }],
      equipment: [{ equipment_type: 'kamyon', count: 2 }, { equipment_type: 'jenerator', count: 1 }],
    },
    {
      project_id: ids.p2, report_date: '2026-10-09', weather: 'bulutlu', temperature: 16,
      work_summary: 'Kumanda binası duvar işleri devam. Trafo nakliye yolu için dolgu ve sıkıştırma yapıldı.',
      issues: 'Yağmur riskine karşı beton yüzeyler örtüldü.',
      crew: [{ role: 'muhendis', count: 1 }, { role: 'usta', count: 3 }, { role: 'isci', count: 12 }],
      equipment: [{ equipment_type: 'kepce', count: 1 }, { equipment_type: 'kamyon', count: 2 }],
    },
  ];
  const existingReports = [];
  for (const p of await api('/api/projects')) {
    existingReports.push(...(await api(`/api/daily-reports?project_id=${p.id}`)));
  }
  const existingDates = new Set(existingReports.map((r) => `${r.project_id}|${r.report_date.slice(0, 10)}`));
  for (const r of reports) {
    if (existingDates.has(`${r.project_id}|${r.report_date}`)) {
      log(true, `rapor zaten var: ${r.report_date}`);
      continue;
    }
    await api('/api/daily-reports', { method: 'POST', body: r });
    log(true, `rapor: ${r.report_date} (${r.weather})`);
  }
}

(async () => {
  console.log('PTYP DEMO VERİ SETİ — başlıyor\n');
  try {
    const login = await api('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin' } });
    token = login.token;
    log(true, 'giriş: admin ✓');

    await cleanup();
    await seedProjects();
    await seedTrafoKmz();
    await seedUsers();
    await seedSuppliers();
    await seedMaterials();
    await seedQuotes();
    await seedWorkGroupsAndTasks();
    await seedPayments();
    await seedDailyReports();

    console.log('\n=== TAMAMLANDI ===');
    console.log(`Sunum adresi: ${BASE}`);
  } catch (e) {
    console.error('\nHATA:', e.message);
    process.exit(1);
  }
})();
