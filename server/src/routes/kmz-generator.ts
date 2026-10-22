// Excel/PDF/TIFF → otomatik KMZ üretme ve projeye aktarma
import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import * as XLSX from 'xlsx';
import { pool } from '../db';
import { requireAuth, requireRole } from '../auth';
import { runJob, getJob } from '../parse-jobs';
import { parseExcelCoordinates, parsePdfText, parseTm3Lines, tm3ToWgs84, convertTm3List, wgs84ToTm3 } from '../coord-parser';
import { parseExcelDtl, parsePdfTextDtl, DtlParseResult, DtlRow } from '../dtl-parser';
import { detectRegion } from '../turkiye-regions';
import { detectDocumentKind, analyzePdf, isTiff } from '../document-reader';
import { parseKmz, routeLengthKm, PolePoint, PoleMeta } from '../kmz-parser';
import { callOcr, OcrCell } from '../ocr-client';
import { buildKmz, formatPoleDisplayName, formatPoleDescription, isPortalPoint } from '../kmz-builder';
import { importPolesForProject } from '../pole-importer';
import { normalizeDtlRowTypes } from '../tower-types';

function cleanPoleKey(name: string): string {
  const s = (name || '').trim().toUpperCase();
  if (/^PORTAL/.test(s)) return 'PORTAL';
  const m = s.match(/^(?:D[-._\s]?|direk\s*)?(\d+)(?:\([A-Z0-9]+\))?$/i);
  if (m) return m[1];
  return s.replace(/\([A-Z0-9]+\)$/, '').trim();
}

// Meta taşıyan direklerden güzergahın 3° TM dilimini (CM) geri çıkar
const TM3_CMS = [27, 30, 33, 36, 39, 42, 45];
function inferTm3Cm(poles: PolePoint[]): number | null {
  for (const p of poles) {
    const e = p.meta?.easting;
    const n = p.meta?.northing;
    if (e == null || n == null || p.lat == null || p.lon == null) continue;
    let best: number | null = null;
    let bestErr = Infinity;
    for (const cm of TM3_CMS) {
      const r = wgs84ToTm3(p.lat, p.lon, cm);
      const err = Math.hypot(r.easting - Number(e), r.northing - Number(n));
      if (err < bestErr) {
        bestErr = err;
        best = cm;
      }
    }
    if (bestErr < 2000) return best; // doğru dilim metre-altı uyum verir
  }
  return null;
}

function enrichPolesWithMetadata(
  poles: PolePoint[],
  tmRows: { name: string; easting: number; northing: number }[],
  dtlRows: DtlRow[]
): PolePoint[] {
  let towerSeq = 0;
  return poles.map((p, idx) => {
    const prevMeta: PoleMeta = p.meta ? { ...p.meta } : {};
    const tm = tmRows.length === poles.length ? tmRows[idx] : tmRows.find((t) => cleanPoleKey(t.name) === cleanPoleKey(p.name));
    let easting: number | null = tm?.easting ?? prevMeta.easting ?? null;
    let northing: number | null = tm?.northing ?? prevMeta.northing ?? null;
    // Eksik TM3 değerlerini WGS84'ten geri hesapla (dilim, meta taşıyanlardan çıkarılır)
    if ((easting == null || northing == null) && p.lat != null && p.lon != null) {
      const cm = inferTm3Cm(poles);
      if (cm != null) {
        const back = wgs84ToTm3(p.lat, p.lon, cm);
        easting = easting ?? back.easting;
        northing = northing ?? back.northing;
      }
    }

    let dtl: DtlRow | undefined;
    if (easting != null && northing != null && dtlRows.length > 0) {
      dtl = dtlRows.find(
        (d) =>
          d.easting != null &&
          d.northing != null &&
          Math.hypot(Number(d.easting) - easting, Number(d.northing) - northing) < 2.5
      );
    }
    if (!dtl && dtlRows.length > 0) {
      const key = cleanPoleKey(p.name);
      if (key === 'PORTAL') {
        const portals = dtlRows.filter((d) => cleanPoleKey(d.pole) === 'PORTAL' || d.tower_type === 'PORTAL');
        if (portals.length > 0) {
          dtl = idx < poles.length / 2 ? portals[0] : portals[portals.length - 1];
        }
      } else if (key) {
        dtl = dtlRows.find((d) => cleanPoleKey(d.pole) === key);
      }
    }

    const portal =
      isPortalPoint(p) ||
      dtl?.tower_type === 'PORTAL' ||
      dtl?.function === 'PORTAL' ||
      cleanPoleKey(p.name) === 'PORTAL';
    if (!portal) towerSeq += 1;

    const func = (dtl?.function || prevMeta.function || (portal ? 'PORTAL' : '')).toUpperCase();
    const ttype = dtl?.tower_type || prevMeta.tower_type || (portal ? 'PORTAL' : '');
    const style = portal
      ? 'portal'
      : prevMeta.style || (['KD', 'KT', 'N', 'D'].includes(func) ? 'dead' : 'tower');

    const meta: PoleMeta = {
      ...prevMeta,
      ...(ttype ? { tower_type: ttype } : {}),
      ...(func ? { function: func } : {}),
      ...(dtl?.station_text || prevMeta.station_text ? { station_text: dtl?.station_text || prevMeta.station_text } : {}),
      span_m: dtl?.span_m ?? prevMeta.span_m ?? null,
      easting: easting ?? dtl?.easting ?? null,
      northing: northing ?? dtl?.northing ?? null,
      ...(dtl?.crossing || prevMeta.crossing ? { crossing: dtl?.crossing || prevMeta.crossing } : {}),
      ...(dtl?.remarks || prevMeta.remarks ? { remarks: dtl?.remarks || prevMeta.remarks } : {}),
      nominal_height_m: dtl?.nominal_height_m ?? prevMeta.nominal_height_m ?? null,
      body_ext_m: dtl?.body_ext_m ?? prevMeta.body_ext_m ?? null,
      ground_elev_m: dtl?.ground_elev_m ?? prevMeta.ground_elev_m ?? null,
      ...(dtl?.insulator_set || prevMeta.insulator_set ? { insulator_set: dtl?.insulator_set || prevMeta.insulator_set } : {}),
      ...(dtl?.insulator_count || prevMeta.insulator_count
        ? { insulator_count: dtl?.insulator_count || prevMeta.insulator_count }
        : {}),
      ...(dtl?.insulator_ref || prevMeta.insulator_ref ? { insulator_ref: dtl?.insulator_ref || prevMeta.insulator_ref } : {}),
      style,
    };

    const tempPoint: PolePoint = {
      ...p,
      alt: p.alt ?? meta.ground_elev_m ?? null,
      meta,
    };
    const displayName = formatPoleDisplayName(tempPoint, idx, poles.length, towerSeq);
    meta.description = formatPoleDescription({ ...tempPoint, name: displayName });

    return {
      ...tempPoint,
      name: displayName,
      meta,
    };
  });
}

const router = Router();

router.use(requireAuth, requireRole('owner'));

const UPLOADS_DIR = path.join(__dirname, '..', '..', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

// OCR satırlarından direkleri çıkar; düşük güvenli satırları işaretle
function polesFromOcr(ocr: { pages: { rows: OcrCell[][] }[] }): {
  poles: PolePoint[];
  uncertain: { row: number; text: string }[];
  lines: string;
} {
  const linesArr: string[] = [];
  const uncertain: { row: number; text: string }[] = [];
  let rowNo = 0;
  for (const page of ocr.pages) {
    for (const row of page.rows) {
      rowNo++;
      const text = row.map((c) => c.text).join(' ').trim();
      if (!text) continue;
      // Düşük güvenli KOORDİNAT hücresi olan satırlar parse edilmez:
      // parseTm3Lines %1e6 kuralı bunları uydurma easting'e çevirebiliyordu
      // (ör. D-8: 4247726.27 → 247726). Yalnız belirsiz listesine düşer.
      const coordCells = row.filter((c) => /^\d{5,8}(?:[.,]\d+)?$/.test(c.text.trim()));
      const lowCoord = coordCells.some((c) => c.conf != null && c.conf < 0.7 && !c.fallback);
      if (lowCoord) {
        uncertain.push({ row: rowNo, text });
        continue;
      }
      linesArr.push(text);
    }
  }
  const lines = linesArr.join('\n');
  const poles = parsePdfText(lines).poles;
  return { poles, uncertain, lines };
}

// Parse işleyicisi, sahte bir res üzerinden koşar: res.json / res.status().json
// çağrıları ParseExit fırlatır, kuyruk bunu sonuç (200) veya hata olarak yakalar.
class ParseExit extends Error {
  constructor(
    public status: number,
    public payload: any
  ) {
    super(payload?.error || (status === 200 ? 'ok' : 'hata'));
  }
}

let jobReport: ((p: string) => void) | null = null;

function fakeJobRes(): Response {
  return {
    status(code: number) {
      return {
        json(payload: any) {
          throw new ParseExit(code, payload);
        },
      } as any;
    },
    json(payload: any) {
      throw new ParseExit(200, payload);
    },
  } as unknown as Response;
}

// Excel/PDF/TIFF → parse → KMZ üret → (isteğe bağlı) projeye aktar.
// Uzun işler (taranmış belge OCR'ı 2-5 dk) panel proxy'sini aşamadığı için
// istek ANINDA 202 + job_id döner; iş kuyrukta koşar, istemci /job/:id yoklar.
router.post('/parse', upload.single('file'), (req: Request, res: Response, next: NextFunction) => {
  if (!req.file) return res.status(400).json({ error: 'Dosya yüklenmedi.' });
  const kind = detectDocumentKind(req.file.originalname);
  if (kind === 'unknown') {
    return res.status(400).json({ error: 'Desteklenen biçimler: Excel (.xlsx/.xls), PDF, TIFF (.tif/.tiff).' });
  }
  const job = runJob('Belge okunuyor…', async (report) => {
    jobReport = report;
    try {
      const fakeNext = (e?: any) => {
        if (e) throw e;
      };
      await parseHandler(req, fakeJobRes(), fakeNext as any);
      throw new Error('Beklenmeyen durum: işleyici yanıt döndürmeden bitti.');
    } catch (e: any) {
      if (e instanceof ParseExit) {
        if (e.status === 200) return e.payload;
        throw new Error(e.payload?.error || 'İşlem başarısız.');
      }
      throw e;
    } finally {
      jobReport = null;
    }
  });
  res.status(202).json({ job_id: job.id, status: job.status });
});

// Kuyruktaki işin durumu / sonucu
router.get('/job/:id', (req: Request, res: Response) => {
  const job = getJob(String(req.params.id));
  if (!job) return res.status(404).json({ error: 'İş bulunamadı.' });
  res.json({
    id: job.id,
    status: job.status,
    progress: job.progress,
    started_at: job.started_at,
    finished_at: job.finished_at,
    elapsed_s: Math.round(((job.finished_at ?? Date.now()) - job.started_at) / 1000),
    ...(job.status === 'done' ? { result: job.result } : {}),
    ...(job.status === 'error' ? { error: job.error } : {}),
  });
});

async function parseHandler(req: Request, res: Response, next: NextFunction): Promise<any> {
  try {
    if (!req.file) return res.status(400).json({ error: 'Dosya yüklenmedi.' });

    const kind = detectDocumentKind(req.file.originalname);
    if (kind === 'unknown') {
      return res.status(400).json({ error: 'Desteklenen biçimler: Excel (.xlsx/.xls), PDF, TIFF (.tif/.tiff).' });
    }
    // Uzantı hatalı olsa bile TIFF sihirli baytını doğrula
    if (kind !== 'tiff' && isTiff(req.file.buffer)) {
      return res.status(400).json({ error: 'Bu dosya bir TIFF görüntüsü. Doğru uzantıyla (.tif/.tiff) yükleyin.' });
    }

    const projectId = req.body?.project_id ? Number(req.body.project_id) : null;
    let projectName = '';
    if (projectId != null) {
      const p = await pool.query('SELECT name FROM projects WHERE id = $1', [projectId]);
      if (p.rowCount === 0) return res.status(404).json({ error: 'Proje bulunamadı.' });
      projectName = String(p.rows[0]?.name || '');
    }

    let poles: PolePoint[] = [];
    let source: string = kind;
    let textLines: string | null = null;
    let dtlResult: DtlParseResult = {
      header: { title: '', voltage_kv: '', conductor: '', line_name: '', notes: '' },
      rows: [],
    };
    let ocrResult: {
      pages: { page: number; preview: string; rows: OcrCell[][] }[];
      uncertain: { row: number; text: string }[];
    } | null = null;
    // ITRF-96 / 3° TM orta meridyeni: 0 = otomatik algıla; ör. 42
    const tm3Cm = Number(req.body?.tm3_cm || 0);

    if (kind === 'excel') {
      try {
        const parsed = parseExcelCoordinates(req.file.buffer);
        poles = parsed.poles;
        textLines = parsed.textLines;
        dtlResult = parseExcelDtl(req.file.buffer);
      } catch (e: any) {
        return res.status(400).json({ error: 'Excel okunamadı: ' + (e.message || 'geçersiz içerik') });
      }
    } else if (kind === 'pdf') {
      // PDF: önce metin katmanı kontrolü
      let analysis;
      try {
        analysis = await analyzePdf(req.file.buffer);
      } catch (e: any) {
        return res.status(400).json({ error: 'PDF okunamadı: ' + (e.message || 'geçersiz içerik') });
      }
      if (analysis.hasTextLayer) {
        source = 'pdf-text';
        textLines = analysis.text;
        poles = parsePdfText(analysis.text).poles;
        dtlResult = parsePdfTextDtl(analysis.text);
      }
      // Metin katmanı yoksa veya metin katmanından hiç koordinat (WGS84 / TM3) çıkmadıysa OCR'a düş
      if (!analysis.hasTextLayer || (poles.length === 0 && parseTm3Lines(analysis.text).length === 0)) {
        try {
          if (jobReport) jobReport('OCR çalışıyor — taranmış belge okunuyor (birkaç dakika sürebilir)…');
          const ocr = await callOcr(req.file.buffer, req.file.originalname);
          if (jobReport) jobReport('Direkler işleniyor ve kaydediliyor…');
          const { poles: p, uncertain, lines } = polesFromOcr(ocr);
          poles = p;
          if (ocr.dtl_header || (ocr.dtl_rows && ocr.dtl_rows.length > 0)) {
            dtlResult = {
              header: ocr.dtl_header || { title: '', voltage_kv: '', conductor: '', line_name: '', notes: '' },
              rows: ocr.dtl_rows || [],
            };
          }
          const hdrText = dtlResult.header.title || dtlResult.header.line_name || '';
          textLines = [analysis.text, hdrText, lines].filter(Boolean).join('\n');
          ocrResult = { pages: ocr.pages.map((pg) => ({ page: pg.page, preview: pg.preview, rows: pg.rows })), uncertain };
        } catch (e: any) {
          return res.status(503).json({ error: 'Taranmış PDF için OCR servisi kullanılamıyor: ' + e.message });
        }
        source = 'pdf-ocr';
      }
    } else {
      // TIFF → OCR servisi
      try {
        if (jobReport) jobReport('OCR çalışıyor — taranmış görüntü okunuyor (birkaç dakika sürebilir)…');
        const ocr = await callOcr(req.file.buffer, req.file.originalname);
        if (jobReport) jobReport('Direkler işleniyor ve kaydediliyor…');
        const { poles: p, uncertain, lines } = polesFromOcr(ocr);
        poles = p;
        if (ocr.dtl_header || (ocr.dtl_rows && ocr.dtl_rows.length > 0)) {
          dtlResult = {
            header: ocr.dtl_header || { title: '', voltage_kv: '', conductor: '', line_name: '', notes: '' },
            rows: ocr.dtl_rows || [],
          };
        }
        const hdrText = dtlResult.header.title || dtlResult.header.line_name || '';
        textLines = [hdrText, lines].filter(Boolean).join('\n');
        ocrResult = { pages: ocr.pages.map((pg) => ({ page: pg.page, preview: pg.preview, rows: pg.rows })), uncertain };
      } catch (e: any) {
        return res.status(503).json({ error: 'TIFF için OCR servisi kullanılamıyor: ' + e.message });
      }
      source = 'tiff-ocr';
    }

    // WGS84 koordinat bulunamadıysa ITRF-96 / 3° TM (veya 6° UTM) ile dönüştür
    // Türkiye 3 derecelik dilim orta meridyenleri: 27, 30, 33, 36, 39, 42, 45
    let tm3CmUsed: number | null = null;
    const tmRows = textLines ? parseTm3Lines(textLines) : [];
    if (poles.length === 0 && tmRows.length > 0) {
      // Northing medyanından yaklaşık enlemi bul (CM'den bağımsızdır)
      const sortedN = tmRows.map((r) => r.northing).sort((a, b) => a - b);
      const medianN = sortedN[Math.floor(sortedN.length / 2)];
      const approxLat = tm3ToWgs84(500000, medianN, 39).lat;

      // Dosya adı + proje adı + belge metninden bölge tespiti
      const region = detectRegion(`${req.file.originalname}\n${projectName}\n${textLines}`, approxLat);
      const cmsToTry = region.cmOrder;
      if (region.city) {
        console.log(`[KMZ-ÜRET] bölge tespiti: ${region.city} (resmi CM ${cmsToTry[0]}, referans boylam ${region.provLon?.toFixed(2)})`);
      }

      // Referans boylam(lar)ı: metinden tespit edilen il/ilçeler; yoksa projedeki mevcut direklerin boylamı
      const refLons: number[] = region.matches.map((m) => m.info.lon);
      if (refLons.length === 0 && projectId != null) {
        const existing = await pool.query(
          'SELECT AVG(lat) AS lat, AVG(lon) AS lon FROM poles WHERE project_id = $1',
          [projectId]
        );
        const exLat = Number(existing.rows[0]?.lat);
        const exLon = Number(existing.rows[0]?.lon);
        if (Number.isFinite(exLat) && Number.isFinite(exLon) && Math.abs(exLat - approxLat) <= 1.8) {
          refLons.push(exLon);
        }
      }

      if (tm3Cm >= 27 && tm3Cm <= 45) {
        let chosenCm = tm3Cm;
        let conv = convertTm3List(tmRows, chosenCm);
        // Kullanıcı ör. "DOM 39° (Diyarbakır)" seçmiş olsa bile hat ilin doğu ilçesinde (ör. Lice, DOM 42°)
        // ise seçili CM hattı ~270 km batıya (Malatya/K.Maraş'a) atar. Belgede/projede tespit edilen
        // referans boylama göre >1.6° sapma varsa ve komşu dilim (±3°) tam bölgeye düşüyorsa otomatik düzelt.
        if (conv.length > 0 && refLons.length > 0) {
          const meanLon = conv.reduce((s, p) => s + p.lon, 0) / conv.length;
          const distSel = Math.min(...refLons.map((rl) => Math.abs(meanLon - rl)));
          if (distSel > 1.6) {
            for (const adjCm of [tm3Cm + 3, tm3Cm - 3]) {
              if (adjCm < 27 || adjCm > 45) continue;
              const convAdj = convertTm3List(tmRows, adjCm);
              if (convAdj.length === 0) continue;
              const meanAdj = convAdj.reduce((s, p) => s + p.lon, 0) / convAdj.length;
              const distAdj = Math.min(...refLons.map((rl) => Math.abs(meanAdj - rl)));
              if (distAdj <= 1.2 && distAdj + 0.8 < distSel) {
                console.log(
                  `[KMZ-ÜRET] Seçili CM ${tm3Cm} (${meanLon.toFixed(2)}°D) bölge referansından ${distSel.toFixed(2)}° uzakta → komşu dilim CM ${adjCm} (${meanAdj.toFixed(2)}°D, fark ${distAdj.toFixed(2)}°) kullanıldı`
                );
                chosenCm = adjCm;
                conv = convAdj;
                break;
              }
            }
          }
        }
        if (conv.length > 0) {
          poles = conv;
          tm3CmUsed = chosenCm;
          console.log(`[KMZ-ÜRET] ${req.file.originalname}: ITRF-96 3°TM (CM ${tm3CmUsed}) ile ${poles.length} direk çevrildi`);
        }
      } else {
        if (refLons.length > 0) {
          let best: { poles: PolePoint[]; cm: number; dist: number } | null = null;
          for (const cm of cmsToTry) {
            const conv = convertTm3List(tmRows, cm);
            if (conv.length === 0) continue;
            const meanLon = conv.reduce((s, p) => s + p.lon, 0) / conv.length;
            const minDist = Math.min(...refLons.map((rl) => Math.abs(meanLon - rl)));
            if (minDist > 2.2) {
              console.log(`[KMZ-ÜRET] CM ${cm} elendi: sonuç boylam ${meanLon.toFixed(2)} referans boylamdan uzak (fark ${minDist.toFixed(2)}°)`);
              continue;
            }
            if (!best || minDist < best.dist) {
              best = { poles: conv, cm, dist: minDist };
            }
          }
          if (best) {
            poles = best.poles;
            tm3CmUsed = best.cm;
            console.log(`[KMZ-ÜRET] ${req.file.originalname}: ITRF-96 3°TM (CM ${tm3CmUsed}) ile ${poles.length} direk çevrildi`);
          }
        }

        if (poles.length === 0) {
          for (const cm of cmsToTry) {
            const conv = convertTm3List(tmRows, cm);
            if (conv.length > 0) {
              poles = conv;
              tm3CmUsed = cm;
              console.log(`[KMZ-ÜRET] ${req.file.originalname}: ITRF-96 3°TM (CM ${tm3CmUsed}) ile ${poles.length} direk çevrildi`);
              break;
            }
          }
        }
      }
    }

    // Proje referans hizalaması (yerel şantiye gridi ofseti, derece cinsinden)
    let gridApplied: { dlat: number; dlon: number } | null = null;
    if (projectId != null && poles.length > 0) {
      const g = await pool.query('SELECT grid_dlat, grid_dlon FROM projects WHERE id = $1', [projectId]);
      const dlat = Number(g.rows[0]?.grid_dlat || 0);
      const dlon = Number(g.rows[0]?.grid_dlon || 0);
      if (dlat !== 0 || dlon !== 0) {
        poles = poles.map((p) => ({ ...p, lat: p.lat + dlat, lon: p.lon + dlon }));
        gridApplied = { dlat, dlon };
        console.log(
          `[KMZ-ÜRET] proje grid ofseti uygulandı: +${Math.round(dlat * 110900)}m K, +${Math.round(dlon * 87300)}m D`
        );
      }
    }

    if (poles.length === 0) {
      console.log(`[KMZ-ÜRET] ${req.file.originalname} → ${source}: koordinat bulunamadı`);
      return res.status(400).json({
        error: 'Dosyada koordinat bulunamadı. PDF taranmış görüntü olabilir; Excel için enlem/boylam (veya X/Y) sütun başlıkları olmalı.',
      });
    }
    if (poles.length < 2) {
      console.log(`[KMZ-ÜRET] ${req.file.originalname} → ${source}: yalnız ${poles.length} direk`);
      return res.status(400).json({ error: 'En az 2 direk bulunmalı (güzergah çizgisi için).' });
    }

    // Direk tipi eşleştirici: OCR bozulmalarını (PFT→PF1, PBI→PB1...) bilinen
    // tip kümesine göre düzelt; belirsiz olanlar olduğu gibi kalır.
    if (dtlResult.rows.length > 0) {
      dtlResult.rows = normalizeDtlRowTypes(dtlResult.rows);
    }

    // Direkleri DTL ve TM3 öznitelikleriyle zenginleştir (Direk Tipi, Fonksiyon, İstasyon, X/Y, Geçiş vb.)
    poles = enrichPolesWithMetadata(poles, tmRows, dtlResult.rows || []);

    console.log(
      `[KMZ-ÜRET] ${req.file.originalname} → ${source}: ${poles.length} direk` +
        (ocrResult ? `, belirsiz satır: ${ocrResult.uncertain.length}` : '')
    );

    // Keşif modülü için DTL verisini kalıcı sakla (düzeltmeler /from-rows'ta geri eşitlenir)
    if (projectId != null && dtlResult.rows.length > 0) {
      try {
        await pool.query(
          `INSERT INTO project_dtl (project_id, header, rows, file_name, source, updated_at)
           VALUES ($1, $2::jsonb, $3::jsonb, $4, $5, now())
           ON CONFLICT (project_id) DO UPDATE SET
             header = EXCLUDED.header, rows = EXCLUDED.rows,
             file_name = EXCLUDED.file_name, source = EXCLUDED.source, updated_at = now()`,
          [projectId, JSON.stringify(dtlResult.header), JSON.stringify(dtlResult.rows), req.file.originalname, source]
        );
      } catch (e: any) {
        console.log(`[KMZ-ÜRET] DTL saklama hatası (keşif etkilenir): ${e.message}`);
      }
    }

    // KMZ üret — dosya adı proje adından türetilir
    const baseDocName = path.basename(req.file.originalname, path.extname(req.file.originalname));
    const docTitle = dtlResult.header?.line_name || dtlResult.header?.title || baseDocName;
    const kmzBuf = buildKmz(poles, docTitle);
    const kmzFile = `${sanitizeFileName(projectName)}-${Date.now()}.kmz`;
    fs.writeFileSync(path.join(UPLOADS_DIR, kmzFile), kmzBuf);

    const poleCoords: [number, number][] = poles.map((p) => [p.lat, p.lon]);
    const connectionKm = routeLengthKm(poleCoords);

    let saved = 0;
    if (projectId != null) {
      const result = await importPolesForProject(projectId, poles, poleCoords, req.file.originalname, poles.length, connectionKm);
      saved = result.saved;
      try {
        fs.writeFileSync(path.join(UPLOADS_DIR, `latest-p${projectId}.kmz`), kmzBuf);
      } catch { /* kritik değil */ }
    }

    res.json({
      poles: poles.map((p, i) => ({
        no: i + 1,
        name: p.name || `D-${i + 1}`,
        lat: p.lat,
        lon: p.lon,
        alt: p.alt ?? null,
        meta: p.meta || null,
      })),
      count: poles.length,
      saved,
      source,
      ocr: ocrResult,
      dtl: dtlResult,
      tm3_cm_used: tm3CmUsed,
      grid_applied: gridApplied,
      connection_km: connectionKm,
      file_name: req.file.originalname,
      kmz: `/api/kmz-generator/download/${kmzFile}`,
    });
  } catch (e) {
    next(e);
  }
}

// Referans KMZ ile proje güzergahını hizala (yerel şantiye gridi ofsetini öğren ve uygula)
router.post('/calibrate', upload.single('file'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Referans KMZ yüklenmedi.' });
    const projectId = Number(req.body?.project_id);
    if (!Number.isInteger(projectId) || projectId <= 0) {
      return res.status(400).json({ error: 'Geçerli bir proje seçin.' });
    }
    const p = await pool.query('SELECT 1 FROM projects WHERE id = $1', [projectId]);
    if (p.rowCount === 0) return res.status(404).json({ error: 'Proje bulunamadı.' });

    // Referans noktaları (direkler + rota köşeleri)
    const ref = parseKmz(req.file.buffer);
    const refPts: { lat: number; lon: number }[] = [];
    for (const pole of ref.poles) refPts.push({ lat: pole.lat, lon: pole.lon });
    if (ref.route) for (const [lat, lon] of ref.route) refPts.push({ lat, lon });
    if (refPts.length < 2) return res.status(400).json({ error: 'Referans KMZ içinde koordinat bulunamadı.' });

    // Projenin mevcut (dönüştürülmüş) direkleri
    const cur = await pool.query('SELECT lat, lon FROM poles WHERE project_id = $1', [projectId]);
    if ((cur.rowCount ?? 0) < 2) {
      return res.status(400).json({ error: 'Projede en az 2 direk olmalı — önce belgeden güzergah üretin.' });
    }

    // Saklı grid ofseti (ham dönüşüm → gerçek konum toplam ötelemesi)
    const gp = await pool.query('SELECT grid_dlat, grid_dlon FROM projects WHERE id = $1', [projectId]);
    const gridOld = {
      lat: Number(gp.rows[0]?.grid_dlat || 0),
      lon: Number(gp.rows[0]?.grid_dlon || 0),
    };
    // Ham dönüşüm konumları = mevcut direkler − saklı ofset
    const rawRows = cur.rows.map((c: any) => ({ lat: c.lat - gridOld.lat, lon: c.lon - gridOld.lon }));

    // Katı öteleme varsayımı: toplam ofset = ağırlık merkezleri farkı (eşleştirme gerektirmez)
    const refCent = refPts.reduce(
      (a, p) => ({ lat: a.lat + p.lat / refPts.length, lon: a.lon + p.lon / refPts.length }),
      { lat: 0, lon: 0 }
    );
    const rawCent = rawRows.reduce(
      (a, p) => ({ lat: a.lat + p.lat / rawRows.length, lon: a.lon + p.lon / rawRows.length }),
      { lat: 0, lon: 0 }
    );
    const dlatTotal = refCent.lat - rawCent.lat;
    const dlonTotal = refCent.lon - rawCent.lon;
    // Emniyet: anlamsız (çok büyük) toplam ofsetleri reddet
    if (Math.hypot(dlatTotal * 110900, dlonTotal * 87300) > 50000) {
      return res.status(400).json({ error: 'Referans ile mevcut güzergah arasındaki fark çok büyük (>50 km).' });
    }
    // Bu turda direklere uygulanacak artım
    const dlat = dlatTotal - gridOld.lat;
    const dlon = dlonTotal - gridOld.lon;

    await pool.query('UPDATE projects SET grid_dlat = $2, grid_dlon = $3 WHERE id = $1', [projectId, dlatTotal, dlonTotal]);
    await pool.query('UPDATE poles SET lat = lat + $2, lon = lon + $3 WHERE project_id = $1', [projectId, dlat, dlon]);
    const pr = await pool.query('SELECT route FROM projects WHERE id = $1', [projectId]);
    if (pr.rows[0]?.route) {
      const raw = pr.rows[0].route as unknown;
      const isFlat =
        Array.isArray(raw) && raw.length > 0 && Array.isArray((raw as unknown[])[0]) &&
        typeof ((raw as unknown[])[0] as unknown[])[0] === 'number';
      const shift = ([la, lo]: [number, number]): [number, number] => [la + dlat, lo + dlon];
      const route = isFlat ? (raw as [number, number][]).map(shift) : (raw as [number, number][][]).map((seg) => seg.map(shift));
      await pool.query('UPDATE projects SET route = $2 WHERE id = $1', [projectId, JSON.stringify(route)]);
    }

    console.log(
      `[KMZ-ÜRET] kalibrasyon: proje ${projectId} → +${Math.round(dlat * 110900)}m K, +${Math.round(dlon * 87300)}m D (${refPts.length} referans noktası)`
    );
    res.json({
      dlat,
      dlon,
      northM: Math.round(dlat * 110900),
      eastM: Math.round(dlon * 87300),
      refPoints: refPts.length,
      applied: cur.rowCount ?? 0,
    });
  } catch (e) {
    next(e);
  }
});

// Düzeltilmiş satırlardan KMZ üret + projeye aktar
router.post('/from-rows', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const projectId = Number(req.body?.project_id);
    if (!Number.isInteger(projectId) || projectId <= 0) {
      return res.status(400).json({ error: 'Geçerli bir proje seçin.' });
    }
    const p = await pool.query('SELECT name FROM projects WHERE id = $1', [projectId]);
    if (p.rowCount === 0) return res.status(404).json({ error: 'Proje bulunamadı.' });

    const raw = Array.isArray(req.body?.poles) ? req.body.poles : [];
    let poles: PolePoint[] = [];
    for (const r of raw) {
      const lat = Number(r?.lat);
      const lon = Number(r?.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      if (lat < 36 || lat > 42 || lon < 26 || lon > 45) {
        return res.status(400).json({ error: `Geçersiz koordinat: ${r?.name || ''} (${lat}, ${lon})` });
      }
      const meta: PoleMeta | undefined = r?.meta && typeof r.meta === 'object' ? r.meta : undefined;
      poles.push({
        name: String(r?.name || '').trim(),
        lat,
        lon,
        alt: r?.alt != null ? Number(r.alt) : null,
        ...(meta ? { meta } : {}),
      });
    }
    if (poles.length < 2) {
      return res.status(400).json({ error: 'En az 2 geçerli direk satırı gerekli.' });
    }

    poles = enrichPolesWithMetadata(poles, [], []);

    const docName = String(req.body?.doc_name || 'belge');
    const kmzBuf = buildKmz(poles, docName);
    const kmzFile = `${sanitizeFileName(p.rows[0].name)}-${Date.now()}.kmz`;
    fs.writeFileSync(path.join(UPLOADS_DIR, kmzFile), kmzBuf);

    const coords: [number, number][] = poles.map((x) => [x.lat, x.lon]);
    const connectionKm = routeLengthKm(coords);
    const result = await importPolesForProject(projectId, poles, coords, `${docName} (düzeltilmiş)`, poles.length, connectionKm);
    try {
      fs.writeFileSync(path.join(UPLOADS_DIR, `latest-p${projectId}.kmz`), kmzBuf);
    } catch { /* kritik değil */ }

    // Keşif: kullanıcının düzelttiği direk meta'sını saklı DTL satırlarına geri yansıt
    try {
      const dtlStored = await pool.query('SELECT rows FROM project_dtl WHERE project_id = $1', [projectId]);
      if (
        (dtlStored.rowCount ?? 0) > 0 &&
        Array.isArray(dtlStored.rows[0].rows) &&
        dtlStored.rows[0].rows.length > 0
      ) {
        const dtlRows: DtlRow[] = dtlStored.rows[0].rows;
        let changed = false;
        for (const p of poles) {
          if (!p.meta) continue;
          const key = cleanPoleKey(String(p.name || ''));
          const row = dtlRows.find((r) => cleanPoleKey(String(r.pole || '')) === key);
          if (!row) continue;
          const m = p.meta as Record<string, unknown>;
          if (m.tower_type && String(m.tower_type).trim()) {
            row.tower_type = String(m.tower_type).trim().toUpperCase();
            changed = true;
          }
          if (m.function && String(m.function).trim()) {
            row.function = String(m.function).trim().toUpperCase();
            changed = true;
          }
          if (m.station_text != null) {
            row.station_text = String(m.station_text || '');
            changed = true;
          }
          if (m.crossing != null) {
            row.crossing = String(m.crossing || '');
            changed = true;
          }
          if (m.remarks != null) {
            row.remarks = String(m.remarks || '');
            changed = true;
          }
        }
        if (changed) {
          await pool.query(
            'UPDATE project_dtl SET rows = $2::jsonb, updated_at = now() WHERE project_id = $1',
            [projectId, JSON.stringify(dtlRows)]
          );
          console.log(`[KMZ-ÜRET] keşif DTL'si düzeltilmiş direk bilgileriyle eşitlendi (proje ${projectId})`);
        }
      }
    } catch (e: any) {
      console.log(`[KMZ-ÜRET] keşif DTL eşitleme hatası: ${e.message}`);
    }

    res.json({
      saved: result.saved,
      count: poles.length,
      connection_km: connectionKm,
      kmz: `/api/kmz-generator/download/${kmzFile}`,
    });
  } catch (e) {
    next(e);
  }
});

// Toplu işlemede birleştirilmiş DTL'yi keşif için kalıcı sakla
// (her dosya /parse'te project_dtl'i ÜZERİNE yazdığı için batch sonunda
// frontend tüm dosyaların satırlarını buradan tek seferde kaydeder)
router.post('/save-dtl', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const projectId = Number(req.body?.project_id);
    if (!Number.isInteger(projectId) || projectId <= 0) {
      return res.status(400).json({ error: 'Geçerli bir proje seçin.' });
    }
    const p = await pool.query('SELECT 1 FROM projects WHERE id = $1', [projectId]);
    if (p.rowCount === 0) return res.status(404).json({ error: 'Proje bulunamadı.' });

    const incoming: DtlRow[] = Array.isArray(req.body?.rows) ? req.body.rows : [];
    const header = req.body?.header && typeof req.body.header === 'object' ? req.body.header : {};
    // OCR bozulmalarını düzelt (PFT→PF1 gibi)
    normalizeDtlRowTypes(incoming);

    // Direk anahtarına göre birleştir: aynı direk iki dosyada tekrarlanmışsa bir kez sayılır;
    // sunucuda zenginleştirilmiş satır korunur, eksik alanları gelenle tamamlanır.
    const stored = await pool.query('SELECT rows FROM project_dtl WHERE project_id = $1', [projectId]);
    const existing: DtlRow[] = Array.isArray(stored.rows[0]?.rows) ? stored.rows[0].rows : [];
    const byKey = new Map<string, DtlRow>();
    for (const r of existing) byKey.set(cleanPoleKey(String(r.pole || '')), r);
    const seen = new Set<string>();
    const merged: DtlRow[] = [];
    for (const r of incoming) {
      const key = cleanPoleKey(String((r as any).pole || ''));
      if (!key) {
        merged.push(r);
        continue;
      }
      if (seen.has(key)) continue;
      seen.add(key);
      const prev = byKey.get(key);
      if (prev) {
        if (!prev.tower_type && (r as any).tower_type) prev.tower_type = (r as any).tower_type;
        if (!prev.function && (r as any).function) prev.function = (r as any).function;
        if (!prev.station_text && (r as any).station_text) prev.station_text = (r as any).station_text;
        if (prev.span_m == null && (r as any).span_m != null) prev.span_m = (r as any).span_m;
        if (!prev.crossing && (r as any).crossing) prev.crossing = (r as any).crossing;
        if (!prev.insulator_set && (r as any).insulator_set) prev.insulator_set = (r as any).insulator_set;
        merged.push(prev);
      } else {
        merged.push(r);
      }
    }

    await pool.query(
      `INSERT INTO project_dtl (project_id, header, rows, file_name, source, updated_at)
       VALUES ($1, $2::jsonb, $3::jsonb, $4, $5, now())
       ON CONFLICT (project_id) DO UPDATE SET
         header = EXCLUDED.header, rows = EXCLUDED.rows,
         file_name = EXCLUDED.file_name, source = EXCLUDED.source, updated_at = now()`,
      [projectId, JSON.stringify(header), JSON.stringify(merged), 'toplu-belge', 'batch']
    );
    // Kalemler bayat kaldı — keşif sayfası açılınca yeni DTL'den otomatik üretilir
    await pool.query('DELETE FROM kesif_items WHERE project_id = $1', [projectId]);
    console.log(`[KMZ-ÜRET] toplu DTL kaydedildi: proje ${projectId}, ${merged.length} satır`);
    res.json({ saved_rows: merged.length });
  } catch (e) {
    next(e);
  }
});

// Düzeltilmiş satırları Excel (.xlsx) olarak indir
router.post('/export-rows', async (req: Request, res: Response) => {
  const raw = Array.isArray(req.body?.poles) ? req.body.poles : [];
  const rows: (string | number)[][] = [
    ['Sıra', 'Direk', 'Direk Tipi', 'Fonksiyon', 'İstasyon', 'X (E)', 'Y (N)', 'Geçiş / Açıklama', 'Enlem', 'Boylam'],
  ];
  raw.forEach((r: any, i: number) => {
    const m: PoleMeta = r?.meta || {};
    const cr = (m.crossing || '').trim();
    const rm = (m.remarks || '').trim();
    const gecis = cr && rm && !cr.toLowerCase().includes(rm.toLowerCase()) ? `${cr} (${rm})` : cr || rm || '';
    rows.push([
      i + 1,
      String(r?.name || ''),
      String(m.tower_type || ''),
      String(m.function || ''),
      String(m.station_text || ''),
      m.easting != null ? Number(m.easting) : '',
      m.northing != null ? Number(m.northing) : '',
      gecis,
      Number(r?.lat) || 0,
      Number(r?.lon) || 0,
    ]);
  });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Direkler');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('direkler-duzeltilmis.xlsx')}`);
  res.send(buf);
});

// Üretilen KMZ'yi indir
router.get('/download/:file', (req: Request, res: Response) => {
  const file = path.basename(String(req.params.file));
  const p = path.join(UPLOADS_DIR, file);
  // UPLOADS_DIR yalnız üretilen KMZ'leri barındırır; basename + .kmz kontrolü yeterli
  if (!file.endsWith('.kmz') || file.startsWith('.') || !fs.existsSync(p)) {
    return res.status(404).json({ error: 'Dosya bulunamadı.' });
  }
  res.setHeader('Content-Type', 'application/vnd.google-earth.kmz');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file)}`);
  res.sendFile(p);
});

// Mevcut proje güzergahını KMZ olarak indir
router.get('/from-project', async (req: Request, res: Response) => {
  const projectId = Number(req.query.project_id);
  if (!Number.isInteger(projectId) || projectId <= 0) {
    return res.status(400).json({ error: 'Geçerli bir proje seçin (project_id).' });
  }
  const proj = await pool.query('SELECT name FROM projects WHERE id = $1', [projectId]);
  if (proj.rowCount === 0) return res.status(404).json({ error: 'Proje bulunamadı.' });
  const poles = await pool.query(
    'SELECT name, lat, lon, alt, meta FROM poles WHERE project_id = $1 ORDER BY idx',
    [projectId]
  );
  if (poles.rows.length < 2) return res.status(400).json({ error: 'Bu projede güzergah için yeterli direk yok.' });
  // Eksik TM3 meta'sını WGS84'ten geri doldur (dilim meta taşıyanlardan çıkarılır)
  const cm = inferTm3Cm(poles.rows as PolePoint[]);
  if (cm != null) {
    for (const p of poles.rows) {
      const m = p.meta || {};
      if ((m.easting == null || m.northing == null) && p.lat != null && p.lon != null) {
        const back = wgs84ToTm3(p.lat, p.lon, cm);
        p.meta = { ...m, easting: m.easting ?? back.easting, northing: m.northing ?? back.northing };
      }
    }
  }
  const kmzBuf = buildKmz(poles.rows, proj.rows[0].name);
  res.setHeader('Content-Type', 'application/vnd.google-earth.kmz');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename*=UTF-8''${encodeURIComponent('guzergah-' + proj.rows[0].name + '.kmz')}`
  );
  res.send(kmzBuf);
});

// Dosya adı güvenleştirme: KMZ adı proje adından türetilir
function sanitizeFileName(s: unknown): string {
  const base = String(s || '')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .slice(0, 60)
    .trim();
  return base || 'guzergah';
}

export default router;
