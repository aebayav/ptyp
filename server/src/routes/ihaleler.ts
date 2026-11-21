// İhale İzleme route'ları — İKİ router:
//
//  1. ihalelerRouter (JWT + owner): liste, okundu, stats, sorgu CRUD,
//     bookmarklet üretici, token yenileme.
//  2. ihaleIngestRouter (TOKEN + CORS, auth DIŞINDA): bookmarklet'in
//     EKAP sayfasından çağırdığı ingest ucu. CORS yalnız EKAP origin'ine
//     açılır; x-ptyp-token, ihale_settings tablosundaki uzun ömürlü
//     ingest token'la karşılaştırılır (JWT'nin 12 saatlik süresi bu akışa girmez).
import { Router, Request, Response } from 'express';
import { pool } from '../db';
import { requireAuth, requireRole } from '../auth';
import { mapEkapRow, classifyUpsert, isScanStale, scanGuard, EkapRow } from '../ihale-upsert';
import { generateBookmarklet, EKAP_SEARCH_URL } from '../ihale-bookmarklet';

// ---------- 1) Yetkili uçlar ----------

const router = Router();
router.use(requireAuth, requireRole('owner'));

// İhale listesi: okunmamış önce, sonra teslim/açılış tarihi artan
router.get('/', async (_req: Request, res: Response) => {
  const { rows } = await pool.query(
    `SELECT ikn, ihale_adi, ihale_tip, usul, durum, durum_aciklama, idare_adi, il,
            ihale_tarih_saat, is_read, changed_fields, matched_queries, last_seen_at
     FROM tenders
     ORDER BY is_read ASC, ihale_tarih_saat ASC NULLS LAST`
  );
  res.json(rows);
});

// Tarama durumu: okunmamış sayısı + son koşu + bayatlama çipi verisi
router.get('/stats', async (_req: Request, res: Response) => {
  const [unread, lastRun] = await Promise.all([
    pool.query('SELECT COUNT(*)::int AS c FROM tenders WHERE is_read = false'),
    pool.query(
      `SELECT status, started_at, finished_at, error, new_count, changed_count
       FROM ihale_scan_runs ORDER BY id DESC LIMIT 1`
    ),
  ]);
  const run = lastRun.rows[0] || null;
  res.json({
    unread: unread.rows[0].c,
    last_run: run,
    is_stale: run
      ? isScanStale(run.status === 'ok' ? String(run.finished_at || run.started_at) : null)
      : true,
  });
});

// Tek ihaleyi okundu işaretle
router.put('/ikn/:ikn/read', async (req: Request, res: Response) => {
  const ikn = String(req.params.ikn || '').trim();
  if (!ikn) return res.status(400).json({ error: 'Geçersiz İKN.' });
  const r = await pool.query('UPDATE tenders SET is_read = true WHERE ikn = $1', [ikn]);
  if ((r.rowCount ?? 0) === 0) return res.status(404).json({ error: 'İhale bulunamadı.' });
  res.status(204).end();
});

// Tümünü okundu işaretle
router.put('/read-all', async (_req: Request, res: Response) => {
  await pool.query('UPDATE tenders SET is_read = true WHERE is_read = false');
  res.status(204).end();
});

// Bookmarklet üretici — origin istekten türetilir (proxy arkasında trust proxy açık)
router.get('/bookmarklet', async (req: Request, res: Response) => {
  const origin = `${req.protocol}://${req.get('host')}`;
  const { rows: tokenRows } = await pool.query(
    'SELECT ingest_token FROM ihale_settings WHERE id = 1'
  );
  const token = tokenRows[0]?.ingest_token || '';
  if (!token) return res.status(500).json({ error: 'İngest token bulunamadı — migrasyonları kontrol edin.' });

  const { rows: queries } = await pool.query(
    'SELECT name, search_text FROM ihale_monitor_queries WHERE active ORDER BY id LIMIT 5'
  );
  res.json({
    code: generateBookmarklet({
      origin,
      token,
      queries: queries.map((q: any) => ({ name: q.name, search_text: q.search_text })),
    }),
    ekap_url: EKAP_SEARCH_URL,
    token_suffix: token.slice(0, 6) + '…' + token.slice(-4),
  });
});

// İngest token'ını yenile (sızıntı halinde)
router.post('/ingest-token/regenerate', async (_req: Request, res: Response) => {
  const token = require('crypto')
    .createHash('md5')
    .update(String(Date.now()) + String(Math.random()) + 'ptyp-ihale')
    .digest('hex');
  await pool.query('UPDATE ihale_settings SET ingest_token = $1, updated_at = now() WHERE id = 1', [token]);
  res.json({ token });
});

// Sorgu listesi
router.get('/queries', async (_req: Request, res: Response) => {
  const { rows } = await pool.query(
    'SELECT id, name, search_text, active, created_at FROM ihale_monitor_queries ORDER BY id'
  );
  res.json(rows);
});

// Yeni sorgu — nezaket sınırı: en çok 5 aktif sorgu
router.post('/queries', async (req: Request, res: Response) => {
  const name = String(req.body?.name || '').trim().slice(0, 60);
  const searchText = String(req.body?.search_text || '').trim().slice(0, 120);
  if (!searchText) return res.status(400).json({ error: 'Anahtar kelime zorunludur.' });
  const cnt = await pool.query('SELECT COUNT(*)::int AS c FROM ihale_monitor_queries WHERE active');
  if (cnt.rows[0].c >= 5) {
    return res.status(400).json({ error: 'En fazla 5 aktif sorgu olabilir — önce birini silin.' });
  }
  const { rows } = await pool.query(
    `INSERT INTO ihale_monitor_queries (name, search_text) VALUES ($1, $2)
     RETURNING id, name, search_text, active, created_at`,
    [name || searchText, searchText]
  );
  res.status(201).json(rows[0]);
});

// Sorgu güncelle / sil
router.put('/queries/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Geçersiz kayıt.' });
  const active = req.body?.active === false ? false : true;
  const r = await pool.query('UPDATE ihale_monitor_queries SET active = $1 WHERE id = $2 RETURNING id', [active, id]);
  if ((r.rowCount ?? 0) === 0) return res.status(404).json({ error: 'Sorgu bulunamadı.' });
  res.status(204).end();
});

router.delete('/queries/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Geçersiz kayıt.' });
  const r = await pool.query('DELETE FROM ihale_monitor_queries WHERE id = $1', [id]);
  if ((r.rowCount ?? 0) === 0) return res.status(404).json({ error: 'Sorgu bulunamadı.' });
  res.status(204).end();
});

export default router;

// ---------- 2) İngest ucu (bookmarklet) ----------

const EKAP_ORIGIN = 'https://ekapv2.kik.gov.tr';

function corsForEkap(res: Response, origin: string | undefined): void {
  if (origin === EKAP_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', EKAP_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type, x-ptyp-token');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
}

async function ingestToken(): Promise<string> {
  const { rows } = await pool.query('SELECT ingest_token FROM ihale_settings WHERE id = 1');
  return String(rows[0]?.ingest_token || '');
}

export const ihaleIngestRouter = Router();

// Preflight
ihaleIngestRouter.options('/', (req: Request, res: Response) => {
  corsForEkap(res, req.headers.origin);
  res.status(204).end();
});

// Bookmarklet POST'u — token korumalı, auth dışı
ihaleIngestRouter.post('/', async (req: Request, res: Response) => {
  corsForEkap(res, req.headers.origin);

  const sent = String(req.headers['x-ptyp-token'] || '');
  const expected = await ingestToken();
  if (!expected || sent.length !== expected.length || sent !== expected) {
    return res.status(401).json({ error: 'Geçersiz ingest token. İhale Kutusu sayfasından bookmarklet\'i yeniden kopyalayın.' });
  }

  // Çift tıklama koruması: son koşu 10 dakikadan yeni → satırlar yine işlenmez,
  // EKAP'ı ikinci turdan korumak için tamamı reddedilir
  const last = await pool.query(
    `SELECT status, started_at FROM ihale_scan_runs ORDER BY id DESC LIMIT 1`
  );
  const guard = scanGuard(last.rows[0] || null);
  if (!guard.allow) {
    return res.status(429).json({ error: guard.reason || 'Az önce tarandı.' });
  }

  const rows: EkapRow[] = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (rows.length > 200) {
    return res.status(400).json({ error: 'Tek koşuda en fazla 200 satır bekleniyor.' });
  }

  const runRow = await pool.query(
    `INSERT INTO ihale_scan_runs (status, queries_run) VALUES ('running', 0) RETURNING id`
  );
  const runId = Number(runRow.rows[0].id);

  let newCount = 0;
  let changedCount = 0;
  try {
    for (const raw of rows) {
      const incoming = mapEkapRow(raw);
      if (!incoming.ikn) continue;
      const { rows: existingRows } = await pool.query(
        `SELECT ikn, ihale_adi, ihale_tip, usul, durum, durum_aciklama, idare_adi, il,
                ihale_tarih_saat, content_hash
         FROM tenders WHERE ikn = $1`,
        [incoming.ikn]
      );
      const decision = classifyUpsert(existingRows[0] || null, incoming);

      if (decision.action === 'insert') {
        await pool.query(
          `INSERT INTO tenders
             (ikn, ihale_adi, ihale_tip, usul, durum, durum_aciklama, idare_adi, il,
              ihale_tarih_saat, content_hash, is_read, changed_fields, raw)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false,'[]'::jsonb,$11::jsonb)
           ON CONFLICT (ikn) DO NOTHING`,
          [
            incoming.ikn, incoming.ihale_adi, incoming.ihale_tip, incoming.usul,
            incoming.durum, incoming.durum_aciklama, incoming.idare_adi, incoming.il,
            incoming.ihale_tarih_saat, incoming.content_hash, JSON.stringify(raw),
          ]
        );
        newCount++;
      } else if (decision.action === 'update_changed') {
        await pool.query(
          `UPDATE tenders SET
              ihale_adi = $2, ihale_tip = $3, usul = $4, durum = $5, durum_aciklama = $6,
              idare_adi = $7, il = $8, ihale_tarih_saat = $9, content_hash = $10,
              last_seen_at = now(), last_change_at = now(),
              changed_fields = $11::jsonb, is_read = false, raw = $12::jsonb
           WHERE ikn = $1`,
          [
            incoming.ikn, incoming.ihale_adi, incoming.ihale_tip, incoming.usul,
            incoming.durum, incoming.durum_aciklama, incoming.idare_adi, incoming.il,
            incoming.ihale_tarih_saat, incoming.content_hash,
            JSON.stringify(decision.changedFields), JSON.stringify(raw),
          ]
        );
        changedCount++;
      } else {
        await pool.query(
          `UPDATE tenders SET last_seen_at = now(), raw = $2::jsonb WHERE ikn = $1`,
          [incoming.ikn, JSON.stringify(raw)]
        );
      }
    }

    await pool.query(
      `UPDATE ihale_scan_runs
         SET status = 'ok', finished_at = now(), new_count = $2, changed_count = $3
       WHERE id = $1`,
      [runId, newCount, changedCount]
    );
    res.json({ new_count: newCount, changed_count: changedCount });
  } catch (e: any) {
    await pool.query(
      `UPDATE ihale_scan_runs SET status = 'error', finished_at = now(), error = $2 WHERE id = $1`,
      [runId, String(e?.message || e).slice(0, 500)]
    ).catch(() => {});
    throw e; // merkezi hata katmanı 500'ler
  }
});
