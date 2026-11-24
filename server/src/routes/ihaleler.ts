// İhale İzleme route'ları — owner-only (JWT).
// Hasat sunucuda: "Şimdi Tara" (scan-now) monitör CLI'sini child process olarak
// spawn eder (Express asla ekap-http import ETMEZ — süreç izolasyonu).
// Oturum çerezi kullanıcı tarafından kaydedilir (ihale_settings.ekap_cookies).
import { Router, Request, Response } from 'express';
import { spawn } from 'child_process';
import path from 'path';
import { pool } from '../db';
import { requireAuth, requireRole } from '../auth';
import { isScanStale, scanGuard } from '../ihale-upsert';

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

// Tarama durumu: okunmamış sayısı + son koşu + bayatlama + çerez var mı
router.get('/stats', async (_req: Request, res: Response) => {
  const [unread, lastRun, lastOk, cookies] = await Promise.all([
    pool.query('SELECT COUNT(*)::int AS c FROM tenders WHERE is_read = false'),
    pool.query(
      `SELECT status, started_at, finished_at, error, new_count, changed_count
       FROM ihale_scan_runs ORDER BY id DESC LIMIT 1`
    ),
    pool.query(
      `SELECT finished_at, started_at FROM ihale_scan_runs
       WHERE status = 'ok' ORDER BY id DESC LIMIT 1`
    ),
    pool.query('SELECT LENGTH(ekap_cookies) AS len FROM ihale_settings WHERE id = 1'),
  ]);
  const run = lastRun.rows[0] || null;
  const ok = lastOk.rows[0] || null;
  const cookieLen = Number(cookies.rows[0]?.len || 0);
  res.json({
    unread: unread.rows[0].c,
    last_run: run,
    is_stale: isScanStale(ok ? String(ok.finished_at || ok.started_at) : null),
    has_cookies: cookieLen > 0,
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

// EKAP oturum çerezini kaydet/güncelle (owner) — gizli, asla geri döndürülmez
router.put('/ekap-cookies', async (req: Request, res: Response) => {
  const cookies = String(req.body?.cookies || '').trim().slice(0, 4000);
  if (!cookies || cookies.length < 20) {
    return res.status(400).json({
      error: 'Çerez boş/çok kısa. EKAP sekmesinde F12 → Network → herhangi bir istek → Request Headers → cookie satırının TAMAMINI kopyalayın.',
    });
  }
  await pool.query(
    'UPDATE ihale_settings SET ekap_cookies = $1, updated_at = now() WHERE id = 1',
    [cookies]
  );
  res.json({ saved: true });
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

// "Şimdi Tara" — monitör CLI'yi spawn eder (Express ekap-http YÜKLEMEZ).
// Çift tıklama: scanGuard; çökme kalıntısı: 15 dk'lik terk koşu kurtarması.
router.post('/scan-now', async (_req: Request, res: Response) => {
  // Çökme kalıntısı kurtarma: süre aşmış 'running' koşuyu hata olarak kapat
  const abandoned = await pool.query(
    `UPDATE ihale_scan_runs
        SET status = 'error', finished_at = now(),
            error = 'Koşu yarım kaldı (sunucu yeniden başladı olabilir).'
      WHERE status = 'running' AND started_at < now() - (15 * 60 * 1000 || ' milliseconds')::interval
      RETURNING id`
  );
  if ((abandoned.rowCount ?? 0) > 0) {
    console.warn(`[IHALE] ${abandoned.rowCount} terk edilmiş koşu hata olarak kapatıldı`);
  }

  const last = await pool.query(
    `SELECT status, started_at FROM ihale_scan_runs ORDER BY id DESC LIMIT 1`
  );
  const guard = scanGuard(last.rows[0] || null);
  if (!guard.allow) {
    return res.status(429).json({ error: guard.reason || 'Az önce tarandı.' });
  }

  // Çerez var mı? (spawn hemen ölmesin — net hata dönsün)
  const cookies = await pool.query('SELECT LENGTH(ekap_cookies) AS len FROM ihale_settings WHERE id = 1');
  if (!(Number(cookies.rows[0]?.len || 0) > 0)) {
    return res.status(400).json({
      error: 'EKAP oturum çerezi kayıtlı değil. Önce EKAP\'e giriş yapıp çerezi kaydedin.',
    });
  }

  const isProd = process.env.NODE_ENV === 'production';
  const script = isProd
    ? path.join(__dirname, '..', 'scripts', 'ihale-monitor.js') // dist/scripts
    : path.join(__dirname, 'ihale-monitor.ts');
  const child = isProd
    ? spawn('node', [script], { detached: true, stdio: 'ignore' })
    : spawn('npx', ['tsx', script], { detached: true, stdio: 'ignore', shell: true });
  child.unref();
  res.status(202).json({ started: true });
});

export default router;
