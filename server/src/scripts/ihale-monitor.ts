// İhale İzleme monitörü — bağımsız CLI (systemd timer + "Şimdi Tara" spawn'ı).
// EKAP'tan giriş yapılı oturum çereziyle DÜZ HTTP hasat (tarayıcı yok, günde
// bir kez, ≤5 sorgu × ≤3 sayfa) → classifyUpsert ile upsert → koşu kaydı.
//
// Kullanım:
//   npx tsx src/scripts/ihale-monitor.ts        (geliştirme)
//   node dist/scripts/ihale-monitor.js          (VPS / systemd / scan-now)
// Ortam: IHALE_COOKIES (test override — DB'deki çerezi değil bunu kullanır)
import { pool } from '../db';
import { runEkapHarvestHttp } from '../ekap-http';
import { mapEkapRow, classifyUpsert, EkapRow } from '../ihale-upsert';

async function main(): Promise<void> {
  // Koşu kaydı: başta 'running' — scanGuard çift koşuyu görür, çökme kalıntısı
  // 15 dk sonra ingest tarafındaki kurtarma/sonraki koşu tarafından kapanır
  const runRow = await pool.query(
    `INSERT INTO ihale_scan_runs (status) VALUES ('running') RETURNING id`
  );
  const runId = Number(runRow.rows[0].id);

  try {
    const maxQueries = Math.max(1, Number(process.env.IHALE_MAX_QUERIES || 5));

    // Oturum çerezi: env override (test) yoksa DB'den
    let cookieHeader = String(process.env.IHALE_COOKIES || '').trim();
    if (!cookieHeader) {
      const { rows } = await pool.query('SELECT ekap_cookies FROM ihale_settings WHERE id = 1');
      cookieHeader = String(rows[0]?.ekap_cookies || '').trim();
    }
    if (!cookieHeader) {
      throw new Error(
        'EKAP oturum çerezi tanımlı değil. EKAP\'e giriş yapıp çerezi İhale Kutusu sayfasından kaydedin.'
      );
    }

    const { rows: queries } = await pool.query(
      'SELECT name, search_text FROM ihale_monitor_queries WHERE active ORDER BY id LIMIT $1',
      [maxQueries]
    );
    if (queries.length === 0) {
      throw new Error('Aktif izleme sorgusu yok — İhale Kutusu sayfasından ekleyin.');
    }

    const rows: EkapRow[] = await runEkapHarvestHttp(
      queries.map((q: any) => ({ name: q.name, searchText: q.search_text })),
      cookieHeader
    );

    let newCount = 0;
    let changedCount = 0;
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
        const ins = await pool.query(
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
        newCount += ins.rowCount ?? 0;
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
         SET status = 'ok', finished_at = now(), queries_run = $2, new_count = $3, changed_count = $4
       WHERE id = $1`,
      [runId, queries.length, newCount, changedCount]
    );
    console.log(`[IHALE] koşu tamam: ${newCount} yeni, ${changedCount} değişen, ${rows.length} satır`);
    process.exit(0);
  } catch (e: any) {
    await pool.query(
      `UPDATE ihale_scan_runs SET status = 'error', finished_at = now(), error = $2 WHERE id = $1`,
      [runId, String(e?.message || e).slice(0, 500)]
    ).catch(() => {});
    console.error('[IHALE] koşu başarısız:', e?.message || e);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('[IHALE] monitör başlatılamadı:', e?.message || e);
  process.exit(1);
});
