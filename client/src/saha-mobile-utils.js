// Mobil Saha Yardımcıları:
//  1) Aşama bazlı saha kalite kontrol listeleri (STAGE_CHECKLISTS) ve çekim rehberi
//  2) Cihaz içi GPS ile En Yakın Direk bulucu (findNearestPole) — açık koordinatı dışarı sızdırmaz
//  3) Canvas tabanlı EXIF temizleme, sıkıştırma, anlık bulanıklık kontrolü ve koordinatsız güvenli filigran (processFieldPhotoClient)
//  4) IndexedDB tabanlı Çevrimdışı Senkronizasyon Kuyruğu (Offline Sync Queue) ve proje önbelleği

export const STAGE_CHECKLISTS = {
  excavation: {
    shotHint: 'Temel çukurunun 4 ayağını/genelini ve zemin yapısını gösterecek şekilde çekin.',
    items: [
      'Temel çukur derinliği ve ebatları projeye uygun',
      'Zemin sınıfı (normal/kaya/sulu) kontrol edildi',
      'Çukur tabanı tesviyesi tamamlandı',
    ],
  },
  foundation: {
    shotHint: 'Ankraj (stub) ayaklarını, topraklama şeridini ve dökülen temel betonunu kadraja alın.',
    items: [
      'Ankraj mastar ve diyagonal terazi ölçümü yapıldı',
      'Topraklama şeridi / kazığı bağlantısı tamamlandı',
      'Grobeton / temel betonu dökümü ve vibrasyon uygulandı',
    ],
  },
  erection: {
    shotHint: 'Dikilen çelik kafes direğin tam boyunu ve traverslerini aşağıdan yukarıya net çekin.',
    items: [
      'Gövde ve travers profilleri DTL tipine uygun monte edildi',
      'Direk şakül ve eksen kontrolü yapıldı',
      'Cıvata torklama ve zımbalama işlemi tamamlandı',
    ],
  },
  fittings: {
    shotHint: 'Travers üzerindeki askı/gergi izolatör zincirlerini ve hırdavat montajını çekin.',
    items: [
      'DTL izolatör seti tipine (Askı / Çift Gergi) uygun montaj yapıldı',
      'Ark boynuzları ve kopilya emniyetleri kontrol edildi',
      'Tel çekim makaraları / klempler uygun bağlandı',
    ],
  },
  stringing: {
    shotHint: 'Menzilde çekilen faz iletkenlerini, koruma telini/OPGW ve sehim durumunu çekin.',
    items: [
      'Faz iletkenleri ve koruma teli hasarsız çekildi',
      'Sıcaklık-sehim cetveline göre sehim ayarı verildi',
      'Damper, sıkma klempi ve jumper bağlantıları tamamlandı',
    ],
  },
  completed: {
    shotHint: 'Direk numara/ölüm tehlike levhası ve tamamlanmış direk genel görünümünü çekin.',
    items: [
      'Direk numarataj ve ölüm tehlike levhaları takıldı',
      'Topraklama geçiş direnci ölçümü uygun',
      'Çevre temizliği ve geçici kabul hazırlığı tamam',
    ],
  },
  issue: {
    shotHint: 'Sahadaki engeli, zemin problemini veya hasarı net gösterecek şekilde çekin.',
    items: [
      'Engel / arıza detayı not alanına yazıldı',
    ],
  },
};

/** İki nokta arası Haversine mesafesi (metre). */
export function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 10) / 10;
}

/** Kullanıcının anlık GPS konumuna göre projedeki en yakın direği ve seçili direğe mesafeyi bulur. */
export function findNearestPole(lat, lon, poles = [], selectedPoleIdx = null) {
  if (lat == null || lon == null || !Array.isArray(poles) || poles.length === 0) return null;
  let nearest = null;
  let nearestDist = Infinity;
  let selectedDist = null;

  for (const p of poles) {
    if (p.lat == null || p.lon == null) continue;
    const d = haversineMeters(lat, lon, Number(p.lat), Number(p.lon));
    if (d < nearestDist) {
      nearestDist = d;
      nearest = p;
    }
    if (selectedPoleIdx != null && Number(p.idx) === Number(selectedPoleIdx)) {
      selectedDist = d;
    }
  }
  if (!nearest) return null;
  const wrongPoleWarning =
    selectedPoleIdx != null &&
    Number(nearest.idx) !== Number(selectedPoleIdx) &&
    nearestDist <= 55 &&
    selectedDist != null &&
    selectedDist > nearestDist + 35;

  return {
    nearestPole: nearest,
    nearestDistanceM: nearestDist,
    selectedDistanceM: selectedDist,
    wrongPoleWarning,
  };
}

/** Cihaz içinde hızlı bulanıklık ve parlaklık ölçümü (0..100). */
function measureCanvasQuality(ctx, width, height) {
  const sampleW = Math.min(240, width);
  const sampleH = Math.min(240, height);
  const imgData = ctx.getImageData(
    Math.floor((width - sampleW) / 2),
    Math.floor((height - sampleH) / 2),
    sampleW,
    sampleH
  ).data;

  const gray = new Float32Array(sampleW * sampleH);
  let sum = 0;
  for (let i = 0, j = 0; i < imgData.length; i += 4, j++) {
    const g = 0.299 * imgData[i] + 0.587 * imgData[i + 1] + 0.114 * imgData[i + 2];
    gray[j] = g;
    sum += g;
  }
  const brightness = sum / gray.length;

  // 2B Laplacian varyansı
  let lapSum = 0;
  let lapSqSum = 0;
  let count = 0;
  for (let y = 1; y < sampleH - 1; y++) {
    for (let x = 1; x < sampleW - 1; x++) {
      const idx = y * sampleW + x;
      const lap =
        gray[idx - sampleW] +
        gray[idx + sampleW] +
        gray[idx - 1] +
        gray[idx + 1] -
        4 * gray[idx];
      lapSum += lap;
      lapSqSum += lap * lap;
      count++;
    }
  }
  const meanLap = count > 0 ? lapSum / count : 0;
  const variance = count > 0 ? Math.max(0, lapSqSum / count - meanLap * meanLap) : 0;
  const blurScore = Math.min(100, Math.max(0, Math.round((Math.log1p(variance) / Math.log1p(380)) * 100)));

  return {
    blurScore,
    brightness: Math.round(brightness),
  };
}

/**
 * Kamera fotoğrafını cihazda sıkıştırır, EXIF GPS verisini temizler ve
 * AÇIK KOORDİNAT İÇERMEYEN güvenli doğrulama bandı (watermark) basar.
 */
export async function processFieldPhotoClient(file, meta = {}) {
  const {
    projectName = 'PTYP',
    poleName = 'D-?',
    towerType = '',
    stageLabel = '',
    distanceM = null,
  } = meta;

  const bitmapUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = reject;
      el.src = bitmapUrl;
    });

    const maxDim = 1600;
    const scale = Math.min(1, maxDim / Math.max(img.width || 1, img.height || 1));
    const w = Math.max(320, Math.round((img.width || 800) * scale));
    const h = Math.max(240, Math.round((img.height || 600) * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);

    // Filigran basmadan önce kalite ölçümü yap
    const quality = measureCanvasQuality(ctx, w, h);

    // Alt banda gizlilik korumalı doğrulama şeridi bas (açık koordinat ASLA yazılmaz)
    const barH = Math.max(46, Math.round(h * 0.068));
    ctx.fillStyle = 'rgba(13, 31, 60, 0.84)';
    ctx.fillRect(0, h - barH, w, barH);

    ctx.fillStyle = '#f5a623';
    ctx.fillRect(0, h - barH, 6, barH);

    const fontSize1 = Math.max(12, Math.round(barH * 0.36));
    const fontSize2 = Math.max(10, Math.round(barH * 0.28));
    const nowStr = new Date().toLocaleString('tr-TR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    const distBadge =
      distanceM != null && Number.isFinite(Number(distanceM))
        ? `Konum Sapması: Δ ${Math.round(Number(distanceM))}m`
        : 'Konum: Ofis / Manuel';

    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${fontSize1}px "Segoe UI", system-ui, sans-serif`;
    ctx.fillText(
      `${poleName}${towerType ? ` (${towerType})` : ''}  ·  ${stageLabel || 'Saha Kanıtı'}`,
      16,
      h - barH + Math.round(barH * 0.44)
    );

    ctx.fillStyle = '#cbd5e1';
    ctx.font = `${fontSize2}px "Segoe UI", system-ui, sans-serif`;
    ctx.fillText(
      `${projectName}  |  ${distBadge}  |  ${nowStr}  |  EXIF-Temiz`,
      16,
      h - barH + Math.round(barH * 0.82)
    );

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.84));
    const cleanFile = new File([blob], (file.name || 'saha.jpg').replace(/\.[^.]+$/, '') + '.jpg', {
      type: 'image/jpeg',
    });

    return {
      file: cleanFile,
      previewUrl: URL.createObjectURL(blob),
      blurScore: quality.blurScore,
      brightness: quality.brightness,
      sizeKb: Math.round(cleanFile.size / 1024),
    };
  } finally {
    URL.revokeObjectURL(bitmapUrl);
  }
}

// ---------- IndexedDB Çevrimdışı Kuyruk & Proje Önbelleği ----------

const DB_NAME = 'ptyp_saha_offline_db';
const DB_VERSION = 1;
const STORE_QUEUE = 'sync_queue';
const STORE_CACHE = 'project_cache';

function openOfflineDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      return reject(new Error('IndexedDB desteklenmiyor'));
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_QUEUE)) {
        db.createObjectStore(STORE_QUEUE, { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(STORE_CACHE)) {
        db.createObjectStore(STORE_CACHE, { keyPath: 'projectId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function cacheProjectSahaData(projectId, data) {
  try {
    const db = await openOfflineDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_CACHE, 'readwrite');
      tx.objectStore(STORE_CACHE).put({
        projectId: Number(projectId),
        data,
        cachedAt: new Date().toISOString(),
      });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* sessiz */
  }
}

export async function getCachedProjectSahaData(projectId) {
  try {
    const db = await openOfflineDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_CACHE, 'readonly');
      const req = tx.objectStore(STORE_CACHE).get(Number(projectId));
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

export async function enqueueOfflineSubmission(entry) {
  const db = await openOfflineDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_QUEUE, 'readwrite');
    const req = tx.objectStore(STORE_QUEUE).add({
      ...entry,
      createdAt: new Date().toISOString(),
    });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function listOfflineSubmissions(projectId = null) {
  try {
    const db = await openOfflineDb();
    const all = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_QUEUE, 'readonly');
      const req = tx.objectStore(STORE_QUEUE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    if (projectId == null) return all;
    return all.filter((x) => Number(x.projectId) === Number(projectId));
  } catch {
    return [];
  }
}

export async function removeOfflineSubmission(id) {
  try {
    const db = await openOfflineDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_QUEUE, 'readwrite');
      tx.objectStore(STORE_QUEUE).delete(id);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* sessiz */
  }
}
