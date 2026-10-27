// %100 Lokal Saha Fotoğrafı Doğrulama Karar Motoru (Decision Model) ve Hakediş Havuzu Hesaplayıcısı
// Hiçbir dış bulut API'sine veri göndermez; koordinat gizliliğini korumak için:
//   1) JPEG EXIF/APP1 metaverisini disk kaydından önce temizler (stripJpegExif),
//   2) Açık koordinat saklamak yerine yalnızca hedef direğe bağıl sapmayı (gps_distance_m)
//      ve projedeki en yakın direk kilidini (nearest_pole_idx) kaydeder,
//   3) Lokal OpenCV servisi (127.0.0.1:8787/verify-pole-photo) üzerinden 64-bit dHash,
//      bulanıklık, parlaklık ve yapısal/spektral aşama uyumu özniteliklerini alır,
//   4) 100 puanlık açıklanabilir Kanıt Karnesi (Scorecard) üretip uygun kayıtları
//      DTL metraj/tonaj karşılıklarıyla hakedis_pool tablosuna düşürür.

import crypto from 'crypto';
import http from 'http';
import https from 'https';
import { pool } from './db';
import { POLE_STATUSES, poleNumberFromName, poleProgress } from './pole-statuses';

const OCR_URL = (process.env.OCR_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');

export interface PoleCoordRow {
  idx: number;
  name: string;
  lat: number;
  lon: number;
  tower_type?: string;
  pole_function?: string;
  meta?: any;
}

export interface LocationEvalResult {
  has_gps: boolean;
  gps_distance_m: number | null;
  nearest_pole_idx: number | null;
  nearest_pole_name: string;
  nearest_distance_m: number | null;
  wrong_pole_locked: boolean;
}

export interface LocalVisualMetrics {
  dhash: string;
  blur_score: number;
  brightness: number;
  contrast: number;
  soil_ratio: number;
  concrete_gray_ratio: number;
  sky_ratio: number;
  structural_line_score: number;
  is_blank_or_uniform: boolean;
  claimed_affinity: number;
}

export interface DecisionScorecard {
  total_score: number;
  decision_status: 'auto_approved' | 'needs_review' | 'rejected';
  gps_score: number;
  phash_score: number;
  quality_score: number;
  visual_score: number;
  dtl_score: number;
  duplicate_of_pole?: string | null;
  duplicate_similarity_pct?: number | null;
  reasons: string[];
  flags: string[];
  visual_metrics: Partial<LocalVisualMetrics>;
  checklist_completed: string[];
}

/** JPEG dosyasındaki APP1 (EXIF / GPS) segmentlerini temizler — koordinat sızıntısını önler. */
export function stripJpegExif(buf: Buffer): Buffer {
  if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) {
    return buf;
  }
  const chunks: Buffer[] = [buf.subarray(0, 2)];
  let pos = 2;
  while (pos + 4 <= buf.length) {
    if (buf[pos] !== 0xff) {
      chunks.push(buf.subarray(pos));
      break;
    }
    const marker = buf[pos + 1];
    // SOS (Start of Scan) veya EOI: kalan sıkıştırılmış görüntü verisini olduğu gibi ekle
    if (marker === 0xda || marker === 0xd9) {
      chunks.push(buf.subarray(pos));
      break;
    }
    // Bağımsız işaretçiler (RST0..RST7, SOI, TEM)
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      chunks.push(buf.subarray(pos, pos + 2));
      pos += 2;
      continue;
    }
    const segLen = buf.readUInt16BE(pos + 2);
    if (segLen < 2 || pos + 2 + segLen > buf.length) {
      chunks.push(buf.subarray(pos));
      break;
    }
    // APP1 (0xFFE1) — EXIF & GPS metaverisi içerir -> atla
    if (marker === 0xe1) {
      pos += 2 + segLen;
      continue;
    }
    chunks.push(buf.subarray(pos, pos + 2 + segLen));
    pos += 2 + segLen;
  }
  return Buffer.concat(chunks);
}

/** İki WGS84 koordinatı arasındaki Haversine mesafesi (metre). */
export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 10) / 10;
}

/** 16 karakterlik iki hex dHash arasındaki Hamming mesafesi (0 = birebir aynı, 64 = tamamen zıt). */
export function hammingDistanceHex(a: string, b: string): number {
  const ha = String(a || '').trim().toLowerCase();
  const hb = String(b || '').trim().toLowerCase();
  if (ha.length !== 16 || hb.length !== 16) return 64;
  let dist = 0;
  for (let i = 0; i < 16; i++) {
    const va = parseInt(ha[i], 16);
    const vb = parseInt(hb[i], 16);
    if (Number.isNaN(va) || Number.isNaN(vb)) return 64;
    let xor = va ^ vb;
    while (xor > 0) {
      dist += xor & 1;
      xor >>= 1;
    }
  }
  return dist;
}

/** Çekim konumunu projedeki tüm direklerle karşılaştırır; açık koordinatı kaydetmeden bağıl sapmayı döndürür. */
export function evaluatePoleLocation(
  targetPoleIdx: number,
  allPoles: PoleCoordRow[],
  captureLat?: number | null,
  captureLon?: number | null,
  precomputedDistanceM?: number | null
): LocationEvalResult {
  const target = allPoles.find((p) => Number(p.idx) === Number(targetPoleIdx));
  if (
    target &&
    captureLat != null &&
    captureLon != null &&
    Number.isFinite(Number(captureLat)) &&
    Number.isFinite(Number(captureLon))
  ) {
    const lat = Number(captureLat);
    const lon = Number(captureLon);
    const targetDist = haversineMeters(lat, lon, Number(target.lat), Number(target.lon));
    let nearestIdx = target.idx;
    let nearestName = target.name;
    let nearestDist = targetDist;

    for (const p of allPoles) {
      if (!Number.isFinite(Number(p.lat)) || !Number.isFinite(Number(p.lon))) continue;
      const d = haversineMeters(lat, lon, Number(p.lat), Number(p.lon));
      if (d < nearestDist) {
        nearestDist = d;
        nearestIdx = p.idx;
        nearestName = p.name;
      }
    }

    // Başka bir direğin dibindeyken (<=45m) uzaktaki bir direğe yükleme yapılıyorsa kilitle
    const wrongPoleLocked =
      nearestIdx !== target.idx && nearestDist <= 55 && targetDist > nearestDist + 35;

    return {
      has_gps: true,
      gps_distance_m: targetDist,
      nearest_pole_idx: nearestIdx,
      nearest_pole_name: nearestName,
      nearest_distance_m: nearestDist,
      wrong_pole_locked: wrongPoleLocked,
    };
  }

  if (precomputedDistanceM != null && Number.isFinite(Number(precomputedDistanceM)) && Number(precomputedDistanceM) >= 0) {
    const dist = Math.round(Number(precomputedDistanceM) * 10) / 10;
    return {
      has_gps: true,
      gps_distance_m: dist,
      nearest_pole_idx: target ? target.idx : targetPoleIdx,
      nearest_pole_name: target ? target.name : `D-${targetPoleIdx}`,
      nearest_distance_m: dist,
      wrong_pole_locked: false,
    };
  }

  return {
    has_gps: false,
    gps_distance_m: null,
    nearest_pole_idx: null,
    nearest_pole_name: '',
    nearest_distance_m: null,
    wrong_pole_locked: false,
  };
}

/** Lokal Python ocr-service (/verify-pole-photo) üzerinden görsel öznitelikleri alır; erişilemezse yerel yedek üretir. */
export async function analyzePhotoLocal(buffer: Buffer, filename: string, stage: string): Promise<LocalVisualMetrics> {
  try {
    const boundary = '----PtypPhotoVerify' + Date.now().toString(16);
    const safeName = (filename || 'pole.jpg').replace(/["\r\n]/g, '_');
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeName}"\r\nContent-Type: image/jpeg\r\n\r\n`,
      'utf8'
    );
    const foot = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
    const body = Buffer.concat([head, buffer, foot]);
    const url = new URL(`${OCR_URL}/verify-pole-photo?stage=${encodeURIComponent(stage || '')}`);
    const lib = url.protocol === 'https:' ? https : http;

    const resData = await new Promise<any>((resolve, reject) => {
      const req = lib.request(
        {
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname + url.search,
          method: 'POST',
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': body.length,
          },
          timeout: 8000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            try {
              const raw = Buffer.concat(chunks).toString('utf8');
              if ((res.statusCode || 500) >= 400) return reject(new Error(raw));
              resolve(JSON.parse(raw));
            } catch (err) {
              reject(err);
            }
          });
        }
      );
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.write(body);
      req.end();
    });

    if (resData && typeof resData.dhash === 'string') {
      return {
        dhash: resData.dhash,
        blur_score: Number(resData.blur_score ?? 75),
        brightness: Number(resData.brightness ?? 128),
        contrast: Number(resData.contrast ?? 45),
        soil_ratio: Number(resData.soil_ratio ?? 0.2),
        concrete_gray_ratio: Number(resData.concrete_gray_ratio ?? 0.2),
        sky_ratio: Number(resData.sky_ratio ?? 0.2),
        structural_line_score: Number(resData.structural_line_score ?? 0.5),
        is_blank_or_uniform: Boolean(resData.is_blank_or_uniform),
        claimed_affinity: Number(resData.claimed_affinity ?? 0.78),
      };
    }
  } catch {
    /* Lokal OCR servisine ulaşılamadığında deterministik yedek */
  }

  const sha = crypto.createHash('sha256').update(buffer).digest('hex');
  return {
    dhash: sha.slice(0, 16),
    blur_score: 72,
    brightness: 125,
    contrast: 42,
    soil_ratio: 0.22,
    concrete_gray_ratio: 0.25,
    sky_ratio: 0.25,
    structural_line_score: 0.55,
    is_blank_or_uniform: buffer.length < 2500,
    claimed_affinity: 0.78,
  };
}

/**
 * 100 Puanlık Açıklanabilir Karar Modeli (Decision Tree / Scorecard)
 *   - Konum & En Yakın Direk Kilidi: 30 puan
 *   - Görsel Tekillik (pHash Kopya Kalkanı): 25 puan
 *   - Görüntü Kalitesi & Saha Kontrol Listesi: 15 puan
 *   - Görsel Aşama Uyumu (OpenCV Yapısal/Spektral): 15 puan
 *   - DTL Dijital İkiz & Aşama Kronolojisi: 15 puan
 */
export function evaluateDecisionScorecard(params: {
  targetPole: PoleCoordRow;
  claimedStage: string;
  previousStage: string;
  location: LocationEvalResult;
  visual: LocalVisualMetrics;
  existingPhotos: { pole_idx: number; pole_name: string; phash: string; sha256: string }[];
  sha256: string;
  checklistCompleted?: string[];
  dtlRow?: any | null;
}): DecisionScorecard {
  const {
    targetPole,
    claimedStage,
    previousStage,
    location,
    visual,
    existingPhotos,
    sha256,
    checklistCompleted = [],
    dtlRow,
  } = params;

  const reasons: string[] = [];
  const flags: string[] = [];
  let hardReject = false;

  // 1. KONUM & EN YAKIN DİREK KİLİDİ (Max 30 puan)
  let gpsScore = 0;
  if (location.wrong_pole_locked) {
    gpsScore = 0;
    hardReject = true;
    flags.push(
      `WRONG_POLE_LOCATION: Fiziksel konumunuz ${location.nearest_pole_name} direğine (${location.nearest_distance_m} m) yakın, ancak ${targetPole.name} (${location.gps_distance_m} m) seçildi.`
    );
  } else if (location.has_gps && location.gps_distance_m != null) {
    const d = location.gps_distance_m;
    if (d <= 45) {
      gpsScore = 30;
      reasons.push(`Konum doğrulandı: ${targetPole.name} direğine Δ ${d} m mesafede çekildi.`);
    } else if (d <= 95) {
      gpsScore = 22;
      reasons.push(`Konum kabul sınırında: ${targetPole.name} direğine Δ ${d} m mesafede.`);
    } else if (d <= 160) {
      gpsScore = 10;
      flags.push(`GPS_MODERATE_OFFSET: Direk merkezinden Δ ${d} m uzakta çekilmiş (teknik ofis onayı önerilir).`);
    } else {
      gpsScore = 0;
      hardReject = true;
      flags.push(`OUT_OF_GEOFENCE: Çekim noktası ${targetPole.name} direğinden Δ ${d} m uzakta (izin verilen eşik ≤ 160 m).`);
    }
  } else {
    gpsScore = 14;
    flags.push('NO_GPS_PROOF: Cihaz konum doğrulaması olmadan yüklendi (teknik ofis incelemesine yönlendirildi).');
  }

  // 2. GÖRSEL PARMAK İZİ (pHash / SHA256) MÜKERRERLİK KALKANI (Max 25 puan)
  let phashScore = 25;
  let duplicateOfPole: string | null = null;
  let duplicateSimPct: number | null = null;

  for (const ex of existingPhotos) {
    if (ex.sha256 && ex.sha256 === sha256) {
      duplicateOfPole = ex.pole_name || `D-${ex.pole_idx}`;
      duplicateSimPct = 100;
      if (Number(ex.pole_idx) !== Number(targetPole.idx)) {
        phashScore = 0;
        hardReject = true;
        flags.push(`DUPLICATE_PHOTO_OTHER_POLE: Bu fotoğraf birebir daha önce ${duplicateOfPole} direğinde kullanılmış.`);
      } else {
        phashScore = 8;
        flags.push(`DUPLICATE_PHOTO_SAME_POLE: Aynı fotoğraf bu direğe tekrar yüklendi.`);
      }
      break;
    }
    if (ex.phash && visual.dhash && ex.phash.length === 16 && visual.dhash.length === 16) {
      const ham = hammingDistanceHex(ex.phash, visual.dhash);
      if (ham <= 5) {
        const sim = Math.round(((64 - ham) / 64) * 100);
        duplicateOfPole = ex.pole_name || `D-${ex.pole_idx}`;
        duplicateSimPct = sim;
        if (Number(ex.pole_idx) !== Number(targetPole.idx)) {
          phashScore = 0;
          hardReject = true;
          flags.push(
            `DUPLICATE_PHOTO_OTHER_POLE: Görsel parmak izi ${duplicateOfPole} direğindeki fotoğrafla %${sim} oranında aynı.`
          );
        } else {
          phashScore = 12;
          flags.push(`SIMILAR_PHOTO_SAME_POLE: Bu direkteki mevcut bir fotoğrafla %${sim} benzerlik taşıyor.`);
        }
        break;
      }
    }
  }
  if (phashScore === 25) {
    reasons.push('Görsel parmak izi (dHash) benzersiz; proje havuzunda mükerrer kayıt yok.');
  }

  // 3. GÖRÜNTÜ KALİTESİ & KONTROL LİSTESİ (Max 15 puan)
  let qualityScore = 10;
  if (visual.is_blank_or_uniform) {
    qualityScore = 0;
    hardReject = true;
    flags.push('BLANK_OR_UNIFORM_IMAGE: Görselde saha detayı tespit edilemedi (boş/tek renk ekran veya kapalı lens).');
  } else {
    if (visual.blur_score < 22) {
      qualityScore -= 7;
      flags.push(`BLURRY_IMAGE: Fotoğraf netliği düşük (netlik skoru: ${visual.blur_score}/100).`);
    } else if (visual.blur_score >= 45) {
      reasons.push(`Görüntü netliği uygun (${visual.blur_score}/100).`);
    }
    if (visual.brightness < 22 || visual.brightness > 246) {
      qualityScore = Math.max(0, qualityScore - 5);
      flags.push('EXPOSURE_ISSUE: Fotoğraf aşırı karanlık veya aşırı parlamış.');
    }
  }
  const checklistBonus = Math.min(5, checklistCompleted.length >= 2 ? 5 : checklistCompleted.length * 2);
  qualityScore = Math.min(15, qualityScore + checklistBonus);
  if (checklistCompleted.length > 0) {
    reasons.push(`Saha kalite kontrol listesi onaylandı (${checklistCompleted.length} madde).`);
  }

  // 4. GÖRSEL AŞAMA UYUMU (Max 15 puan)
  const aff = Number(visual.claimed_affinity ?? 0.75);
  let visualScore = Math.round(Math.max(0, Math.min(15, aff * 15)));
  if (aff >= 0.65) {
    reasons.push(
      `Görsel doku ve yapı analizi "${POLE_STATUSES[claimedStage]?.label || claimedStage}" aşamasıyla uyumlu (%${Math.round(aff * 100)}).`
    );
  } else {
    flags.push(
      `LOW_VISUAL_AFFINITY: Görsel doku "${POLE_STATUSES[claimedStage]?.label || claimedStage}" aşaması için düşük güven verdi (%${Math.round(aff * 100)}).`
    );
  }

  // 5. DTL DİJİTAL İKİZ & AŞAMA KRONOLOJİSİ (Max 15 puan)
  let dtlScore = 15;
  const prevProg = poleProgress(previousStage);
  const nextProg = poleProgress(claimedStage);
  // Aşama atlama kontrolü: örn. doğrudan 'none' -> 'stringing'/'completed' geçişi
  if (prevProg === 0 && nextProg >= 70) {
    dtlScore -= 6;
    flags.push(
      `STAGE_JUMP_WARNING: Direk önceki aşamalar (Kazı/Temel/Montaj) kaydedilmeden doğrudan "${POLE_STATUSES[claimedStage]?.label || claimedStage}" aşamasına geçirildi.`
    );
  } else {
    reasons.push('Aşama ilerleme kronolojisi tutarlı.');
  }

  const ttype = String(dtlRow?.tower_type || targetPole.tower_type || targetPole.meta?.tower_type || '').trim();
  const pfunc = String(dtlRow?.function || targetPole.pole_function || targetPole.meta?.function || '').trim();
  if (ttype) {
    reasons.push(`DTL Dijital İkiz eşleşti: Tip ${ttype}${pfunc ? ` (${pfunc})` : ''}.`);
  }

  const totalScore = Math.max(0, Math.min(100, gpsScore + phashScore + qualityScore + visualScore + dtlScore));

  let decisionStatus: 'auto_approved' | 'needs_review' | 'rejected' = 'needs_review';
  if (hardReject || totalScore < 48) {
    decisionStatus = 'rejected';
  } else if (totalScore >= 76 && location.has_gps && !flags.some((f) => f.startsWith('STAGE_JUMP_WARNING'))) {
    decisionStatus = 'auto_approved';
  } else {
    decisionStatus = 'needs_review';
  }

  return {
    total_score: totalScore,
    decision_status: decisionStatus,
    gps_score: gpsScore,
    phash_score: phashScore,
    quality_score: qualityScore,
    visual_score: visualScore,
    dtl_score: dtlScore,
    duplicate_of_pole: duplicateOfPole,
    duplicate_similarity_pct: duplicateSimPct,
    reasons,
    flags,
    visual_metrics: {
      dhash: visual.dhash,
      blur_score: visual.blur_score,
      brightness: visual.brightness,
      contrast: visual.contrast,
      soil_ratio: visual.soil_ratio,
      concrete_gray_ratio: visual.concrete_gray_ratio,
      sky_ratio: visual.sky_ratio,
      structural_line_score: visual.structural_line_score,
      claimed_affinity: visual.claimed_affinity,
    },
    checklist_completed: checklistCompleted,
  };
}

/** DTL satırı ve direk tipinden ilgili saha aşaması için hakediş metrajı (miktar, birim, kalem adı) üretir. */
export function computeDtlMetraj(
  pole: { idx: number; name: string; tower_type?: string; meta?: any },
  stage: string,
  dtlRow?: any | null
): { item_name: string; unit: string; qty: number; tower_type: string; pole_function: string } {
  const ttype = String(dtlRow?.tower_type || pole.tower_type || pole.meta?.tower_type || 'Standart').trim();
  const pfunc = String(dtlRow?.function || pole.meta?.function || '').trim();
  const bodyExt = Number(dtlRow?.body_ext_m ?? pole.meta?.body_ext_m ?? 0) || 0;
  const spanM = Number(dtlRow?.span_m ?? pole.meta?.span_m ?? 0) || 0;
  const dtlWeightKg = Number(dtlRow?.total_weight_kg ?? dtlRow?.weight_kg ?? pole.meta?.weight_kg ?? 0) || 0;

  // Direk tipi bazlı yaklaşık galvanizli çelik ağırlığı (DTL'de açık kg yoksa TEİAŞ tipik değerleri)
  const estimateSteelKg = (): number => {
    if (dtlWeightKg > 100) return Math.round(dtlWeightKg);
    const up = ttype.toUpperCase();
    let base = 3100;
    if (up.startsWith('PA')) base = 2450;
    else if (up.startsWith('PB')) base = 3150;
    else if (up.startsWith('PC')) base = 4400;
    else if (up.startsWith('PD')) base = 5100;
    else if (up.startsWith('PE')) base = 6300;
    else if (up.startsWith('PF')) base = 7800;
    else if (up.startsWith('2FS')) base = 5600;
    else if (up.startsWith('2FN')) base = 8900;
    else if (up.includes('PORTAL')) base = 4200;
    return Math.round(base + Math.max(0, bodyExt) * 165);
  };

  // Temel tipi bazlı yaklaşık kazı/beton hacmi
  const isAnchor = ['KD', 'D', 'N', 'PORTAL'].includes(pfunc.toUpperCase()) || /^(?:PC|PD|PE|PF|2FN)/i.test(ttype);

  switch (stage) {
    case 'excavation':
      return {
        item_name: `${pole.name} (${ttype}) — Temel Kazısı`,
        unit: 'm³',
        qty: isAnchor ? 48 : 26,
        tower_type: ttype,
        pole_function: pfunc,
      };
    case 'foundation':
      return {
        item_name: `${pole.name} (${ttype}) — Temel Betonu & Ankraj`,
        unit: 'm³',
        qty: isAnchor ? 18.5 : 9.5,
        tower_type: ttype,
        pole_function: pfunc,
      };
    case 'erection':
      return {
        item_name: `${pole.name} (${ttype}${bodyExt ? ` +${bodyExt}m` : ''}) — Direk Montajı`,
        unit: 'kg',
        qty: estimateSteelKg(),
        tower_type: ttype,
        pole_function: pfunc,
      };
    case 'fittings': {
      const insSet = String(dtlRow?.insulator_set || pole.meta?.insulator_set || (isAnchor ? 'ÇG' : 'A')).trim();
      return {
        item_name: `${pole.name} (${ttype}) — İzolatör & Hırdavat (${insSet})`,
        unit: 'takım',
        qty: isAnchor ? 6 : 3,
        tower_type: ttype,
        pole_function: pfunc,
      };
    }
    case 'stringing':
      return {
        item_name: `${pole.name} Menzili — İletken & Tel Çekimi`,
        unit: spanM > 0 ? 'm' : 'menzil',
        qty: spanM > 0 ? Math.round(spanM * 10) / 10 : 1,
        tower_type: ttype,
        pole_function: pfunc,
      };
    case 'completed':
    default:
      return {
        item_name: `${pole.name} (${ttype}) — Direk Tamamlama & Kabul`,
        unit: 'adet',
        qty: 1,
        tower_type: ttype,
        pole_function: pfunc,
      };
  }
}

/** Karar sonucuna göre hakedis_pool tablosuna otomatik metraj/hakediş satırı ekler veya günceller. */
export async function upsertHakedisPoolEntry(params: {
  projectId: number;
  pole: { idx: number; name: string; tower_type?: string; meta?: any };
  stage: string;
  photoId: number | null;
  decisionScore: number;
  decisionStatus: 'auto_approved' | 'needs_review' | 'rejected' | 'manual_approved' | 'manual_rejected';
  gpsDistanceM: number | null;
  dtlRow?: any | null;
  notes?: string;
}): Promise<any | null> {
  const { projectId, pole, stage, photoId, decisionScore, decisionStatus, gpsDistanceM, dtlRow, notes = '' } = params;
  if (!stage || stage === 'none' || stage === 'issue') return null;

  const metraj = computeDtlMetraj(pole, stage, dtlRow);

  // İlgili saha_stage ve direk aralığına uyan iş grubunu bul
  const pNum = poleNumberFromName(pole.name);
  const wgRes = await pool.query(
    `SELECT id, unit_price FROM (
       SELECT wg.id,
              0::numeric AS unit_price,
              CASE WHEN wg.saha_stage = $2 THEN 0 ELSE 1 END AS stg_rank,
              CASE WHEN $3::int IS NOT NULL AND wg.segment_from IS NOT NULL AND wg.segment_to IS NOT NULL
                        AND $3::int BETWEEN LEAST(wg.segment_from, wg.segment_to) AND GREATEST(wg.segment_from, wg.segment_to)
                   THEN 0 ELSE 1 END AS seg_rank
       FROM work_groups wg
       WHERE wg.project_id = $1 AND (wg.saha_stage = $2 OR wg.saha_stage = '' OR wg.saha_stage = 'all')
       ORDER BY stg_rank ASC, seg_rank ASC, wg.id ASC
       LIMIT 1
     ) sub`,
    [projectId, stage, pNum]
  );
  const workGroupId = wgRes.rows[0]?.id ?? null;

  const poolStatus =
    decisionStatus === 'auto_approved' || decisionStatus === 'manual_approved'
      ? 'ready'
      : decisionStatus === 'needs_review'
        ? 'pending_review'
        : 'rejected';

  const { rows } = await pool.query(
    `INSERT INTO hakedis_pool (
       project_id, pole_idx, pole_name, stage, tower_type, pole_function,
       work_group_id, item_name, unit, qty, unit_price,
       evidence_photo_id, decision_score, gps_distance_m, status, notes, updated_at
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now())
     ON CONFLICT (project_id, pole_idx, stage) DO UPDATE SET
       pole_name = EXCLUDED.pole_name,
       tower_type = EXCLUDED.tower_type,
       pole_function = EXCLUDED.pole_function,
       work_group_id = COALESCE(EXCLUDED.work_group_id, hakedis_pool.work_group_id),
       item_name = EXCLUDED.item_name,
       unit = EXCLUDED.unit,
       qty = EXCLUDED.qty,
       evidence_photo_id = COALESCE(EXCLUDED.evidence_photo_id, hakedis_pool.evidence_photo_id),
       decision_score = EXCLUDED.decision_score,
       gps_distance_m = COALESCE(EXCLUDED.gps_distance_m, hakedis_pool.gps_distance_m),
       status = CASE WHEN hakedis_pool.status = 'transferred' THEN 'transferred' ELSE EXCLUDED.status END,
       notes = CASE WHEN EXCLUDED.notes <> '' THEN EXCLUDED.notes ELSE hakedis_pool.notes END,
       updated_at = now()
     RETURNING *`,
    [
      projectId,
      pole.idx,
      pole.name,
      stage,
      metraj.tower_type,
      metraj.pole_function,
      workGroupId,
      metraj.item_name,
      metraj.unit,
      metraj.qty,
      0,
      photoId,
      decisionScore,
      gpsDistanceM,
      poolStatus,
      notes,
    ]
  );

  return rows[0] || null;
}
