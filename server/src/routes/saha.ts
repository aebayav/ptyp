// Saha modülü: direk bazlı ilerleme durumu + saha fotoğrafları.
// Direkler yeniden işlenince (poles tablosu silinip yeniden yazılır) id'ler değişir;
// bu yüzden kayıtlar pole id yerine (project_id, pole_idx) ile tutulur.
import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import QRCode from 'qrcode';
import { pool } from '../db';
import { requireAuth, requireRole, AuthedRequest } from '../auth';
import { POLE_STATUSES, poleNumberFromName, poleProgress } from '../pole-statuses';
import { toDateOrNull } from '../dates';
import { syncWorkGroupsFromSaha } from '../work-plan-generator';
import {
  analyzePhotoLocal,
  evaluateDecisionScorecard,
  evaluatePoleLocation,
  stripJpegExif,
  upsertHakedisPoolEntry,
} from '../pole-verifier';

const router = Router();

// Saha sayfası iş sahibi + saha ekibi rollerine açık
router.use(requireAuth, requireRole('owner', 'field'));

const PHOTOS_DIR = path.join(__dirname, '..', '..', 'uploads', 'pole-photos');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 8 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype && file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Yalnızca görsel dosyaları yüklenebilir.'));
  },
});

async function projectExists(id: number): Promise<boolean> {
  const r = await pool.query('SELECT 1 FROM projects WHERE id = $1', [id]);
  return (r.rowCount ?? 0) === 1;
}

async function poleExists(projectId: number, idx: number): Promise<boolean> {
  const r = await pool.query('SELECT 1 FROM poles WHERE project_id = $1 AND idx = $2', [projectId, idx]);
  return (r.rowCount ?? 0) === 1;
}

// Projenin direkleri + durumları + fotoğrafları + ilerleme özeti
router.get('/:id', async (req: Request, res: Response) => {
  const projectId = Number(req.params.id);
  if (!Number.isInteger(projectId) || projectId <= 0) {
    return res.status(400).json({ error: 'Geçerli bir proje seçin.' });
  }
  const proj = await pool.query('SELECT name FROM projects WHERE id = $1', [projectId]);
  if (proj.rowCount === 0) return res.status(404).json({ error: 'Proje bulunamadı.' });

  const poles = await pool.query(
    `SELECT p.idx, p.name, p.lat, p.lon,
            p.meta->>'tower_type' AS tower_type,
            p.meta->>'function' AS pole_function,
            p.meta->>'station_text' AS station_text,
            p.meta->>'span_m' AS span_m,
            p.meta->>'body_ext_m' AS body_ext_m,
            COALESCE(s.status, 'none') AS status,
            s.note, s.updated_at, s.updated_by,
            u.display_name AS updated_by_name
     FROM poles p
     LEFT JOIN pole_status s ON s.project_id = p.project_id AND s.pole_idx = p.idx
     LEFT JOIN users u ON u.id = s.updated_by
     WHERE p.project_id = $1
     ORDER BY p.idx`,
    [projectId]
  );
  const photos = await pool.query(
    `SELECT ph.id, ph.pole_idx, ph.caption, ph.stage, ph.gps_distance_m,
            ph.nearest_pole_idx, ph.nearest_pole_name, ph.nearest_distance_m,
            ph.decision_status, ph.decision_score, ph.scorecard,
            ph.review_note, ph.reviewed_at, ph.created_at, ph.uploaded_by,
            u.display_name AS uploaded_by_name,
            ru.display_name AS reviewed_by_name
     FROM pole_photos ph
     LEFT JOIN users u ON u.id = ph.uploaded_by
     LEFT JOIN users ru ON ru.id = ph.reviewed_by
     WHERE ph.project_id = $1
     ORDER BY ph.created_at DESC`,
    [projectId]
  );
  const poolAgg = await pool.query(
    `SELECT status, COUNT(*)::int AS cnt
     FROM hakedis_pool
     WHERE project_id = $1
     GROUP BY status`,
    [projectId]
  );
  const poolCounts: Record<string, number> = { ready: 0, pending_review: 0, transferred: 0, rejected: 0 };
  for (const r of poolAgg.rows) {
    poolCounts[r.status] = Number(r.cnt) || 0;
  }

  const photoByPole = new Map<number, any[]>();
  for (const ph of photos.rows) {
    if (!photoByPole.has(ph.pole_idx)) photoByPole.set(ph.pole_idx, []);
    photoByPole.get(ph.pole_idx)!.push({
      id: ph.id,
      caption: ph.caption,
      stage: ph.stage || '',
      stage_label: ph.stage && POLE_STATUSES[ph.stage] ? POLE_STATUSES[ph.stage].label : '',
      gps_distance_m: ph.gps_distance_m != null ? Number(ph.gps_distance_m) : null,
      nearest_pole_idx: ph.nearest_pole_idx,
      nearest_pole_name: ph.nearest_pole_name || '',
      nearest_distance_m: ph.nearest_distance_m != null ? Number(ph.nearest_distance_m) : null,
      decision_status: ph.decision_status || 'auto_approved',
      decision_score: Number(ph.decision_score ?? 85),
      scorecard: ph.scorecard || {},
      review_note: ph.review_note || '',
      reviewed_at: ph.reviewed_at,
      reviewed_by_name: ph.reviewed_by_name || '',
      uploaded_by_name: ph.uploaded_by_name || '',
      created_at: ph.created_at,
      url: `/api/saha/photos/${ph.id}/file`,
    });
  }

  const counts: Record<string, number> = {};
  let progressSum = 0;
  const out = poles.rows.map((p: any) => {
    const st = POLE_STATUSES[p.status] ? p.status : 'none';
    counts[st] = (counts[st] || 0) + 1;
    progressSum += POLE_STATUSES[st].progress;
    return {
      idx: p.idx,
      name: p.name,
      lat: p.lat,
      lon: p.lon,
      tower_type: p.tower_type || '',
      pole_function: p.pole_function || '',
      station_text: p.station_text || '',
      span_m: p.span_m != null ? Number(p.span_m) : null,
      body_ext_m: p.body_ext_m != null ? Number(p.body_ext_m) : null,
      status: st,
      status_label: POLE_STATUSES[st].label,
      note: p.note || '',
      updated_at: p.updated_at,
      updated_by: p.updated_by_name || '',
      photos: photoByPole.get(p.idx) || [],
    };
  });

  res.json({
    project_name: proj.rows[0].name,
    poles: out,
    statuses: POLE_STATUSES,
    pool_summary: poolCounts,
    summary: {
      status_counts: Object.keys(POLE_STATUSES).map((k) => ({
        status: k,
        label: POLE_STATUSES[k].label,
        color: POLE_STATUSES[k].color,
        count: counts[k] || 0,
      })),
      progress: out.length > 0 ? Math.round((progressSum / out.length) * 10) / 10 : 0,
      pole_count: out.length,
    },
  });
});

// Direk durumu güncelle (UPSERT)
router.put('/:id/status', async (req: Request, res: Response) => {
  const projectId = Number(req.params.id);
  if (!Number.isInteger(projectId) || projectId <= 0) {
    return res.status(400).json({ error: 'Geçerli bir proje seçin.' });
  }
  const idx = Number(req.body?.pole_idx);
  if (!Number.isInteger(idx) || idx < 0) {
    return res.status(400).json({ error: 'Direk seçilmedi.' });
  }
  const status = String(req.body?.status || 'none');
  if (!POLE_STATUSES[status]) return res.status(400).json({ error: 'Geçersiz durum.' });
  const note = String(req.body?.note || '').slice(0, 500);

  if (!(await projectExists(projectId))) return res.status(404).json({ error: 'Proje bulunamadı.' });
  if (!(await poleExists(projectId, idx))) return res.status(404).json({ error: 'Direk bulunamadı.' });

  const uid = (req as AuthedRequest).user?.id ?? null;
  await pool.query(
    `INSERT INTO pole_status (project_id, pole_idx, status, note, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (project_id, pole_idx) DO UPDATE SET
       status = EXCLUDED.status, note = EXCLUDED.note,
       updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [projectId, idx, status, note, uid]
  );
  // Saha direk durumu güncellendiğinde bağlı iş gruplarının ilerlemesini otomatik senkronize et
  await syncWorkGroupsFromSaha(projectId, true).catch(() => {});
  res.json({ pole_idx: idx, status, status_label: POLE_STATUSES[status].label, note });
});

// Direğe fotoğraf ekle (çoklu) + %100 Lokal Karar Modeli (Decision Scorecard) + Otomatik Hakediş Havuzu
router.post('/:id/photos', upload.array('photos', 8), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const projectId = Number(req.params.id);
    if (!Number.isInteger(projectId) || projectId <= 0) {
      return res.status(400).json({ error: 'Geçerli bir proje seçin.' });
    }
    const idx = Number(req.body?.pole_idx);
    if (!Number.isInteger(idx) || idx < 0) return res.status(400).json({ error: 'Direk seçilmedi.' });
    if (!(await projectExists(projectId))) return res.status(404).json({ error: 'Proje bulunamadı.' });

    const allPolesRes = await pool.query(
      `SELECT p.idx, p.name, p.lat, p.lon, p.meta,
              p.meta->>'tower_type' AS tower_type,
              p.meta->>'function' AS pole_function,
              COALESCE(s.status, 'none') AS current_status,
              COALESCE(s.note, '') AS current_note
       FROM poles p
       LEFT JOIN pole_status s ON s.project_id = p.project_id AND s.pole_idx = p.idx
       WHERE p.project_id = $1
       ORDER BY p.idx`,
      [projectId]
    );
    const targetPole = allPolesRes.rows.find((p: any) => Number(p.idx) === idx);
    if (!targetPole) return res.status(404).json({ error: 'Direk bulunamadı.' });

    const files = (req.files as Express.Multer.File[]) || [];
    if (files.length === 0) return res.status(400).json({ error: 'Fotoğraf seçilmedi.' });

    // Mevcut proje fotoğraflarının parmak izleri (mükerrer/kopya kontrolü için)
    const existingPhotosRes = await pool.query(
      `SELECT ph.pole_idx, COALESCE(p.name, 'D-' || ph.pole_idx::text) AS pole_name, ph.phash, ph.sha256
       FROM pole_photos ph
       LEFT JOIN poles p ON p.project_id = ph.project_id AND p.idx = ph.pole_idx
       WHERE ph.project_id = $1`,
      [projectId]
    );
    const existingPhotos = existingPhotosRes.rows;

    // DTL tablosundan bu direğin dijital ikiz verisini çek
    let dtlRow: any = null;
    const dtlRes = await pool.query('SELECT rows FROM project_dtl WHERE project_id = $1', [projectId]);
    if (dtlRes.rows[0]?.rows && Array.isArray(dtlRes.rows[0].rows)) {
      const pNum = poleNumberFromName(targetPole.name);
      dtlRow =
        dtlRes.rows[0].rows.find((r: any) => {
          const rn = poleNumberFromName(String(r?.pole || ''));
          return (pNum != null && rn === pNum) || String(r?.pole || '').trim() === targetPole.name;
        }) || null;
    }

    const claimedStageRaw = String(req.body?.stage || '').trim();
    const claimedStage = POLE_STATUSES[claimedStageRaw] ? claimedStageRaw : targetPole.current_status || 'none';
    const note = String(req.body?.note ?? targetPole.current_note ?? '').slice(0, 500);
    const caption = String(req.body?.caption || (POLE_STATUSES[claimedStage]?.label ?? '')).slice(0, 200);

    // Koordinat gizliliği: ham capture_lat/capture_lon yalnızca bellekte bağıl sapma (gps_distance_m)
    // ve en yakın direk kilidini (nearest_pole_idx) hesaplamak için kullanılır; veritabanına ASLA yazılmaz!
    const captureLat = req.body?.capture_lat != null && req.body?.capture_lat !== '' ? Number(req.body.capture_lat) : null;
    const captureLon = req.body?.capture_lon != null && req.body?.capture_lon !== '' ? Number(req.body.capture_lon) : null;
    const precomputedDist =
      req.body?.gps_distance_m != null && req.body?.gps_distance_m !== '' ? Number(req.body.gps_distance_m) : null;

    let checklistCompleted: string[] = [];
    if (req.body?.checklist) {
      try {
        const parsed = typeof req.body.checklist === 'string' ? JSON.parse(req.body.checklist) : req.body.checklist;
        if (Array.isArray(parsed)) checklistCompleted = parsed.map((x) => String(x).slice(0, 120));
      } catch {
        /* yok say */
      }
    }

    const locationEval = evaluatePoleLocation(idx, allPolesRes.rows, captureLat, captureLon, precomputedDist);

    const dir = path.join(PHOTOS_DIR, String(projectId));
    fs.mkdirSync(dir, { recursive: true });
    const uid = (req as AuthedRequest).user?.id ?? null;
    const saved: any[] = [];
    let bestDecision: any = null;

    for (const f of files) {
      // JPEG EXIF GPS etiketlerini disk kaydından önce temizle
      const sanitizedBuf = stripJpegExif(f.buffer);
      const sha256 = crypto.createHash('sha256').update(sanitizedBuf).digest('hex');
      const visual = await analyzePhotoLocal(sanitizedBuf, f.originalname || 'foto.jpg', claimedStage);
      const scorecard = evaluateDecisionScorecard({
        targetPole,
        claimedStage,
        previousStage: targetPole.current_status || 'none',
        location: locationEval,
        visual,
        existingPhotos,
        sha256,
        checklistCompleted,
        dtlRow,
      });

      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${path.basename(f.originalname || 'foto.jpg').replace(/[^A-Za-z0-9._-]/g, '_')}`;
      fs.writeFileSync(path.join(dir, filename), sanitizedBuf);

      const r = await pool.query(
        `INSERT INTO pole_photos (
           project_id, pole_idx, filename, caption, uploaded_by,
           stage, phash, sha256, gps_distance_m,
           nearest_pole_idx, nearest_pole_name, nearest_distance_m,
           decision_status, decision_score, scorecard
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         RETURNING id, caption, stage, gps_distance_m, nearest_pole_idx, nearest_pole_name,
                   nearest_distance_m, decision_status, decision_score, scorecard, created_at`,
        [
          projectId,
          idx,
          filename,
          caption,
          uid,
          claimedStage,
          visual.dhash || '',
          sha256,
          locationEval.gps_distance_m,
          locationEval.nearest_pole_idx,
          locationEval.nearest_pole_name || '',
          locationEval.nearest_distance_m,
          scorecard.decision_status,
          scorecard.total_score,
          JSON.stringify(scorecard),
        ]
      );

      // Aynı istekteki sonraki fotoğrafların kopya kontrolü için listeye ekle
      existingPhotos.push({
        pole_idx: idx,
        pole_name: targetPole.name,
        phash: visual.dhash || '',
        sha256,
      });

      const row = r.rows[0];
      saved.push({
        id: row.id,
        caption: row.caption,
        stage: row.stage,
        stage_label: POLE_STATUSES[row.stage]?.label || '',
        gps_distance_m: row.gps_distance_m != null ? Number(row.gps_distance_m) : null,
        nearest_pole_idx: row.nearest_pole_idx,
        nearest_pole_name: row.nearest_pole_name,
        nearest_distance_m: row.nearest_distance_m != null ? Number(row.nearest_distance_m) : null,
        decision_status: row.decision_status,
        decision_score: Number(row.decision_score),
        scorecard: row.scorecard,
        created_at: row.created_at,
        url: `/api/saha/photos/${row.id}/file`,
      });

      if (!bestDecision || Number(row.decision_score) > Number(bestDecision.decision_score)) {
        bestDecision = saved[saved.length - 1];
      }
    }

    // Eğer aşama belirtilmişse ve karar reddedilmemişse:
    //  - auto_approved veya 'issue' ise direk durumunu otomatik güncelle + iş planını senkronize et
    //  - hakedis_pool tablosuna otomatik metraj satırı ekle/güncelle
    let poolEntry: any = null;
    let statusUpdated = false;
    if (bestDecision && claimedStage && claimedStage !== 'none') {
      if (bestDecision.decision_status === 'auto_approved' || claimedStage === 'issue') {
        await pool.query(
          `INSERT INTO pole_status (project_id, pole_idx, status, note, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, $5, now())
           ON CONFLICT (project_id, pole_idx) DO UPDATE SET
             status = EXCLUDED.status,
             note = CASE WHEN EXCLUDED.note <> '' THEN EXCLUDED.note ELSE pole_status.note END,
             updated_by = EXCLUDED.updated_by,
             updated_at = now()`,
          [projectId, idx, claimedStage, note, uid]
        );
        await syncWorkGroupsFromSaha(projectId, true).catch(() => {});
        statusUpdated = true;
      }

      if (claimedStage !== 'issue') {
        poolEntry = await upsertHakedisPoolEntry({
          projectId,
          pole: targetPole,
          stage: claimedStage,
          photoId: bestDecision.id,
          decisionScore: bestDecision.decision_score,
          decisionStatus: bestDecision.decision_status,
          gpsDistanceM: bestDecision.gps_distance_m,
          dtlRow,
          notes: note,
        });
      }
    }

    res.status(201).json({
      saved,
      decision: bestDecision,
      status_updated: statusUpdated,
      hakedis_pool_entry: poolEntry,
    });
  } catch (e) {
    next(e);
  }
});

// Teknik Ofis Fotoğraf İnceleme Kararı (Onayla / Reddet) — İş Sahibi
router.put('/photos/:id/review', requireRole('owner'), async (req: Request, res: Response) => {
  const photoId = Number(req.params.id);
  if (!Number.isInteger(photoId) || photoId <= 0) return res.status(400).json({ error: 'Geçersiz fotoğraf.' });

  const action = String(req.body?.action || '').trim(); // 'approve' | 'reject'
  if (!['approve', 'reject'].includes(action)) {
    return res.status(400).json({ error: 'Geçersiz işlem (approve veya reject olmalı).' });
  }
  const reviewNote = String(req.body?.review_note || '').slice(0, 300);
  const uid = (req as AuthedRequest).user?.id ?? null;

  const phRes = await pool.query('SELECT * FROM pole_photos WHERE id = $1', [photoId]);
  if (phRes.rowCount === 0) return res.status(404).json({ error: 'Fotoğraf bulunamadı.' });
  const ph = phRes.rows[0];
  const newDecision = action === 'approve' ? 'manual_approved' : 'manual_rejected';

  await pool.query(
    `UPDATE pole_photos
     SET decision_status = $1, reviewed_by = $2, reviewed_at = now(), review_note = $3
     WHERE id = $4`,
    [newDecision, uid, reviewNote, photoId]
  );

  const poleRes = await pool.query(
    `SELECT idx, name, meta, meta->>'tower_type' AS tower_type FROM poles WHERE project_id = $1 AND idx = $2`,
    [ph.project_id, ph.pole_idx]
  );
  const targetPole = poleRes.rows[0] || { idx: ph.pole_idx, name: `D-${ph.pole_idx}` };

  if (ph.stage && ph.stage !== 'none') {
    if (action === 'approve') {
      await pool.query(
        `INSERT INTO pole_status (project_id, pole_idx, status, note, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (project_id, pole_idx) DO UPDATE SET
           status = EXCLUDED.status, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [ph.project_id, ph.pole_idx, ph.stage, reviewNote, uid]
      );
      await syncWorkGroupsFromSaha(ph.project_id, true).catch(() => {});
    }

    if (ph.stage !== 'issue') {
      await upsertHakedisPoolEntry({
        projectId: ph.project_id,
        pole: targetPole,
        stage: ph.stage,
        photoId: ph.id,
        decisionScore: Number(ph.decision_score || 85),
        decisionStatus: newDecision,
        gpsDistanceM: ph.gps_distance_m != null ? Number(ph.gps_distance_m) : null,
        notes: reviewNote,
      });
    }
  }

  res.json({ id: photoId, decision_status: newDecision, review_note: reviewNote });
});

// Projenin Hakediş Havuzu & Kanıt Karnesi Listesi
router.get('/:id/hakedis-pool', async (req: Request, res: Response) => {
  const projectId = Number(req.params.id);
  if (!Number.isInteger(projectId) || projectId <= 0) {
    return res.status(400).json({ error: 'Geçerli bir proje seçin.' });
  }
  if (!(await projectExists(projectId))) return res.status(404).json({ error: 'Proje bulunamadı.' });

  const { rows } = await pool.query(
    `SELECT hp.*,
            wg.code AS work_group_code,
            wg.name AS work_group_name,
            ph.decision_status AS photo_decision_status,
            ph.scorecard AS photo_scorecard,
            ph.nearest_pole_name,
            ph.review_note,
            pp.period_no AS payment_period_no,
            pp.period_label AS payment_period_label
     FROM hakedis_pool hp
     LEFT JOIN work_groups wg ON wg.id = hp.work_group_id
     LEFT JOIN pole_photos ph ON ph.id = hp.evidence_photo_id
     LEFT JOIN progress_payments pp ON pp.id = hp.payment_id
     WHERE hp.project_id = $1
     ORDER BY
       (hp.status = 'pending_review') DESC,
       (hp.status = 'ready') DESC,
       hp.pole_idx ASC,
       hp.created_at DESC`,
    [projectId]
  );

  const items = rows.map((r: any) => ({
    ...r,
    qty: Number(r.qty || 0),
    unit_price: Number(r.unit_price || 0),
    gps_distance_m: r.gps_distance_m != null ? Number(r.gps_distance_m) : null,
    stage_label: POLE_STATUSES[r.stage]?.label || r.stage,
    stage_color: POLE_STATUSES[r.stage]?.color || '#64748b',
    photo_url: r.evidence_photo_id ? `/api/saha/photos/${r.evidence_photo_id}/file` : null,
  }));

  const readyItems = items.filter((i: any) => i.status === 'ready');
  const summary = {
    total_count: items.length,
    ready_count: readyItems.length,
    pending_review_count: items.filter((i: any) => i.status === 'pending_review').length,
    transferred_count: items.filter((i: any) => i.status === 'transferred').length,
    rejected_count: items.filter((i: any) => i.status === 'rejected').length,
    ready_steel_kg: Math.round(
      readyItems.filter((i: any) => i.unit === 'kg').reduce((s: number, i: any) => s + i.qty, 0)
    ),
    ready_concrete_m3:
      Math.round(
        readyItems
          .filter((i: any) => i.unit === 'm³' && i.stage === 'foundation')
          .reduce((s: number, i: any) => s + i.qty, 0) * 10
      ) / 10,
    ready_excavation_m3:
      Math.round(
        readyItems
          .filter((i: any) => i.unit === 'm³' && i.stage === 'excavation')
          .reduce((s: number, i: any) => s + i.qty, 0) * 10
      ) / 10,
  };

  res.json({ items, summary });
});

// Hakediş havuzu satırını güncelle (miktar, birim fiyat, durum) — İş Sahibi
router.put('/hakedis-pool/:poolId', requireRole('owner'), async (req: Request, res: Response) => {
  const poolId = Number(req.params.poolId);
  if (!Number.isInteger(poolId) || poolId <= 0) return res.status(400).json({ error: 'Geçersiz havuz kaydı.' });

  const ex = await pool.query('SELECT * FROM hakedis_pool WHERE id = $1', [poolId]);
  if (ex.rowCount === 0) return res.status(404).json({ error: 'Kayıt bulunamadı.' });
  const cur = ex.rows[0];

  const qty = req.body?.qty != null ? Number(req.body.qty) : Number(cur.qty);
  const unitPrice = req.body?.unit_price != null ? Number(req.body.unit_price) : Number(cur.unit_price);
  const status = req.body?.status && ['ready', 'pending_review', 'rejected', 'transferred'].includes(req.body.status)
    ? String(req.body.status)
    : cur.status;
  const notes = req.body?.notes != null ? String(req.body.notes).slice(0, 300) : cur.notes;
  const uid = (req as AuthedRequest).user?.id ?? null;

  const { rows } = await pool.query(
    `UPDATE hakedis_pool
     SET qty = $1, unit_price = $2, status = $3, notes = $4,
         reviewed_by = $5, reviewed_at = now(), updated_at = now()
     WHERE id = $6
     RETURNING *`,
    [qty, unitPrice, status, notes, uid, poolId]
  );

  // Eğer havuzdan onaylandıysa ilgili fotoğrafı ve direk durumunu da senkronize et
  if (status === 'ready' && cur.status !== 'ready') {
    if (cur.evidence_photo_id) {
      await pool.query(
        `UPDATE pole_photos SET decision_status = 'manual_approved', reviewed_by = $1, reviewed_at = now() WHERE id = $2`,
        [uid, cur.evidence_photo_id]
      );
    }
    await pool.query(
      `INSERT INTO pole_status (project_id, pole_idx, status, note, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (project_id, pole_idx) DO UPDATE SET
         status = EXCLUDED.status, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [cur.project_id, cur.pole_idx, cur.stage, notes, uid]
    );
    await syncWorkGroupsFromSaha(cur.project_id, true).catch(() => {});
  } else if (status === 'rejected' && cur.evidence_photo_id) {
    await pool.query(
      `UPDATE pole_photos SET decision_status = 'manual_rejected', reviewed_by = $1, reviewed_at = now() WHERE id = $2`,
      [uid, cur.evidence_photo_id]
    );
  }

  res.json(rows[0]);
});

// Hakediş Havuzundaki onaylı ('ready') kalemleri Hakediş Yönetimi (progress_payments) dönemine aktar
router.post('/:id/hakedis-pool/transfer', requireRole('owner'), async (req: Request, res: Response) => {
  const projectId = Number(req.params.id);
  if (!Number.isInteger(projectId) || projectId <= 0) {
    return res.status(400).json({ error: 'Geçerli bir proje seçin.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const readyRes = await client.query(
      `SELECT * FROM hakedis_pool WHERE project_id = $1 AND status = 'ready' ORDER BY pole_idx ASC, id ASC`,
      [projectId]
    );
    if (readyRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Hakediş havuzunda aktarılmaya hazır (onaylı) kayıt bulunmuyor.' });
    }

    let paymentId = req.body?.payment_id ? Number(req.body.payment_id) : null;
    let paymentRow: any = null;

    if (paymentId) {
      const pCheck = await client.query(
        `SELECT * FROM progress_payments WHERE id = $1 AND project_id = $2`,
        [paymentId, projectId]
      );
      if (pCheck.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Seçilen hakediş dönemi bulunamadı.' });
      }
      paymentRow = pCheck.rows[0];
    } else {
      // Mevcut açık taslak varsa onu kullan, yoksa yeni hakediş dönemi oluştur
      const draftRes = await client.query(
        `SELECT * FROM progress_payments WHERE project_id = $1 AND status = 'draft' ORDER BY period_no DESC LIMIT 1`,
        [projectId]
      );
      if (draftRes.rows.length > 0 && !req.body?.create_new) {
        paymentRow = draftRes.rows[0];
        paymentId = paymentRow.id;
      } else {
        const maxNoRes = await client.query(
          `SELECT COALESCE(MAX(period_no), 0) AS max_no FROM progress_payments WHERE project_id = $1`,
          [projectId]
        );
        const nextNo = Number(maxNoRes.rows[0].max_no) + 1;
        const label =
          String(req.body?.period_label || '').trim() ||
          `Hakediş #${nextNo} (Saha Doğrulama Havuzu — ${new Date().toISOString().slice(0, 10)})`;
        const insP = await client.query(
          `INSERT INTO progress_payments (project_id, period_no, period_label, status, notes)
           VALUES ($1, $2, $3, 'draft', $4)
           RETURNING *`,
          [projectId, nextNo, label, 'Saha karar motoru ile doğrulanan direk kanıtlarından otomatik oluşturuldu.']
        );
        paymentRow = insP.rows[0];
        paymentId = paymentRow.id;
      }
    }

    for (const item of readyRes.rows) {
      const noteText = `Kanıt Skoru: ${item.decision_score}/100${item.gps_distance_m != null ? ` · Δ ${item.gps_distance_m}m` : ''}${item.notes ? ` · ${item.notes}` : ''}`;
      await client.query(
        `INSERT INTO progress_payment_items (
           payment_id, work_group_id, item_name, unit, contract_qty, previous_qty, current_qty, unit_price, notes
         )
         VALUES ($1, $2, $3, $4, $5, 0, $6, $7, $8)`,
        [
          paymentId,
          item.work_group_id,
          item.item_name,
          item.unit,
          Number(item.qty) || 1,
          Number(item.qty) || 1,
          Number(item.unit_price) || 0,
          noteText,
        ]
      );
      await client.query(
        `UPDATE hakedis_pool SET status = 'transferred', payment_id = $1, updated_at = now() WHERE id = $2`,
        [paymentId, item.id]
      );
    }

    await client.query('COMMIT');
    res.json({
      transferred_count: readyRes.rows.length,
      payment: paymentRow,
    });
  } catch (e: any) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// Fotoğrafı sil (dosya + kayıt)
router.delete('/photos/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Geçersiz fotoğraf.' });
  const r = await pool.query('SELECT project_id, filename FROM pole_photos WHERE id = $1', [id]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'Fotoğraf bulunamadı.' });
  const fpath = path.join(PHOTOS_DIR, String(r.rows[0].project_id), r.rows[0].filename);
  try {
    if (fs.existsSync(fpath)) fs.unlinkSync(fpath);
  } catch {
    /* dosya zaten yok */
  }
  await pool.query('DELETE FROM pole_photos WHERE id = $1', [id]);
  res.status(204).end();
});

// Fotoğraf dosyasını indir (oturumlu)
router.get('/photos/:id/file', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Geçersiz fotoğraf.' });
  const r = await pool.query('SELECT project_id, filename FROM pole_photos WHERE id = $1', [id]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'Fotoğraf bulunamadı.' });
  const fpath = path.join(PHOTOS_DIR, String(r.rows[0].project_id), r.rows[0].filename);
  if (!fs.existsSync(fpath)) return res.status(404).json({ error: 'Dosya diskte bulunamadı.' });
  res.sendFile(fpath);
});

const esc = (s: unknown) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// QR çıktısı: direk başına QR kartlı yazdırılabilir sayfa.
// QR, /saha?proje=<id>&direk=<idx> adresini taşır — telefonla okutulunca
// Saha sayfası ilgili direği açar/odaklar.
router.get('/:id/qr', async (req: Request, res: Response) => {
  const projectId = Number(req.params.id);
  if (!Number.isInteger(projectId) || projectId <= 0) {
    return res.status(400).json({ error: 'Geçerli bir proje seçin.' });
  }
  const proj = await pool.query('SELECT name FROM projects WHERE id = $1', [projectId]);
  if (proj.rowCount === 0) return res.status(404).json({ error: 'Proje bulunamadı.' });
  const poles = await pool.query(
    `SELECT idx, name, meta->>'tower_type' AS tower_type, meta->>'station_text' AS station_text
     FROM poles WHERE project_id = $1 ORDER BY idx`,
    [projectId]
  );
  if (poles.rows.length === 0) return res.status(400).json({ error: 'Bu projede direk yok.' });

  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').trim();
  const base = `${proto}://${host}`;

  const cards: string[] = [];
  for (const p of poles.rows) {
    // DİKKAT: panel proxy ikinci query parametresini soyduğu için
    // proje/direk BİLGİSİ path içinde taşınır (?proje=&direk= kullanılmaz).
    const url = `${base}/saha/direk/${projectId}/${p.idx}`;
    let svg = '';
    try {
      svg = await QRCode.toString(url, { type: 'svg', margin: 0, width: 128 });
    } catch {
      /* qr üretilemezse boş kalır */
    }
    cards.push(
      `<div class="qrcard"><div class="qr">${svg}</div><div class="qrname">${esc(p.name)}</div>` +
        `<div class="qrmeta">${esc(p.tower_type || '')}${p.station_text ? ' · ' + esc(p.station_text) : ''}</div></div>`
    );
  }

  const html = `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Direk QR — ${esc(proj.rows[0].name)}</title>
<style>
body{font-family:'Segoe UI',system-ui,sans-serif;margin:0;padding:24px;color:#1c2b3a}
h1{font-size:18px;margin:0 0 4px}
.sub{color:#6b7a8c;font-size:12px;margin-bottom:16px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}
.qrcard{border:1px solid #dbe2ea;border-radius:10px;padding:10px;text-align:center;break-inside:avoid;background:#fff}
.qr svg{width:110px;height:110px}
.qrname{font-weight:700;font-size:13px;margin-top:6px}
.qrmeta{font-size:10.5px;color:#6b7a8c;margin-top:2px}
.print-btn{position:fixed;top:16px;right:16px;background:#0d1f3c;color:#fff;border:none;border-radius:8px;padding:10px 18px;font-size:13px;cursor:pointer}
@media print{.print-btn{display:none}body{padding:6mm}}
</style></head><body>
<button class="print-btn" onclick="window.print()">Yazdır</button>
<h1>Direk QR Kartları — ${esc(proj.rows[0].name)}</h1>
<div class="sub">${poles.rows.length} direk · telefonla okutunca Saha sayfasında ilgili direk açılır</div>
<div class="grid">${cards.join('')}</div>
</body></html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// ---------- Saha malzeme talepleri ----------

// Talepler: açık olanlar önce, yeniden eskiye
router.get('/:id/requests', async (req: Request, res: Response) => {
  const projectId = Number(req.params.id);
  if (!Number.isInteger(projectId) || projectId <= 0) {
    return res.status(400).json({ error: 'Geçerli bir proje seçin.' });
  }
  const proj = await pool.query('SELECT 1 FROM projects WHERE id = $1', [projectId]);
  if (proj.rowCount === 0) return res.status(404).json({ error: 'Proje bulunamadı.' });
  const { rows } = await pool.query(
    `SELECT r.*, u.display_name AS requested_by_name, f.display_name AS fulfilled_by_name
     FROM saha_requests r
     LEFT JOIN users u ON u.id = r.requested_by
     LEFT JOIN users f ON f.id = r.fulfilled_by
     WHERE r.project_id = $1
     ORDER BY (r.status = 'open') DESC, r.created_at DESC`,
    [projectId]
  );
  res.json(rows);
});

// Yeni talep
router.post('/:id/requests', async (req: Request, res: Response) => {
  const projectId = Number(req.params.id);
  if (!Number.isInteger(projectId) || projectId <= 0) {
    return res.status(400).json({ error: 'Geçerli bir proje seçin.' });
  }
  const itemName = String(req.body?.item_name || '').trim();
  if (!itemName) return res.status(400).json({ error: 'Malzeme adı zorunludur.' });
  const qty = Number(req.body?.qty);
  if (!(Number.isFinite(qty) && qty > 0)) return res.status(400).json({ error: 'Geçerli bir miktar girin.' });
  const proj = await pool.query('SELECT 1 FROM projects WHERE id = $1', [projectId]);
  if (proj.rowCount === 0) return res.status(404).json({ error: 'Proje bulunamadı.' });

  const uid = (req as AuthedRequest).user?.id ?? null;
  const { rows } = await pool.query(
    `INSERT INTO saha_requests (project_id, item_name, qty, unit, pole_ref, needed_by, note, requested_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, created_at`,
    [
      projectId,
      itemName.slice(0, 200),
      qty,
      String(req.body?.unit || 'adet').slice(0, 20),
      String(req.body?.pole_ref || '').slice(0, 80),
      toDateOrNull(req.body?.needed_by, 'gerekli tarih'),
      String(req.body?.note || '').slice(0, 300),
      uid,
    ]
  );
  res.status(201).json(rows[0]);
});

// Talep durumu: fulfilled/cancelled iş sahibi; saha ekibi yalnızca kendi talebini iptal edebilir
router.put('/requests/:id/status', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Geçersiz talep.' });
  const status = String(req.body?.status || '');
  if (!['open', 'fulfilled', 'cancelled'].includes(status)) return res.status(400).json({ error: 'Geçersiz durum.' });
  const r = await pool.query('SELECT * FROM saha_requests WHERE id = $1', [id]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'Talep bulunamadı.' });
  const user = (req as AuthedRequest).user!;
  if (user.role === 'field' && !(status === 'cancelled' && r.rows[0].requested_by === user.id)) {
    return res.status(403).json({ error: 'Saha ekibi yalnızca kendi talebini iptal edebilir.' });
  }
  await pool.query(
    `UPDATE saha_requests SET status = $1,
       fulfilled_by = CASE WHEN $1 = 'fulfilled' THEN $2::int ELSE NULL END,
       fulfilled_at = CASE WHEN $1 = 'fulfilled' THEN now() ELSE NULL END
     WHERE id = $3`,
    [status, user.id, id]
  );
  res.json({ id, status });
});

export default router;
