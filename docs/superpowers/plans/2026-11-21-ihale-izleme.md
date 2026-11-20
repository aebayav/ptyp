# İhale İzleme (İhale Kutusu) — Uygulama Planı

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** EKAP ihale duyurularını Playwright ile günlük hasat edip İhale Kutusu sayfasında sunan izleme modülü (tasarım: ihale tarih penceresi, değişim işaretleme, tarama sağlığı).

**Architecture:** systemd timer → bağımsız Node script'i → kısa ömürlü headless chromium (Turnstile'i doğal geçer) → sayfa bağlamında EKAP JSON API'sini sorgular → saf `ihale-upsert` mantığıyla DB'ye upsert → owner-only route'lar → `/ihaleler` sayfası + Portföy kartı.

**Tech Stack:** Express 5 + TypeScript strict · pg · Playwright (chromium) · React 18 · vitest

**Spec:** `docs/superpowers/specs/2026-11-21-ihale-izleme-design.md` (onaylı; pencere/karma/sağlık/merdiven kararları orada)

## Global Constraints

- `tsc` derlemesi temiz kalalı; yeni bağımlılık YALNIZ `playwright` (server, runtime)
- **Express süreci asla playwright import etmez** — elle tarama `scripts/ihale-monitor.js`'i child process olarak **spawn** eder (`routes/ihaleler.ts` `ekap-client`'ı import ETMEZ)
- EKAP nezaketi: koşu başına ≤5 sorgu, sorgu başına ≤3 sayfa (×10 kayıt); yalnız günlük timer + elle "Şimdi Tara"
- Tarih ayrıştırma: EKAP'tan gelen `DD.MM.YYYY HH:mm` **Europe/Istanbul duvar saati** kabul edilir (VPS UTC'de koşar)
- UI Türkçe; yalnız mevcut CSS sınıfları; route/migrasyon/sayfa desenleri birebir mevcut dosyalar gibi
- Migrasyon numarası: `migrations.ts`'teki en yüksek `id`'nin sıradakisi (grep ile bulunur)

## Review Focus

1. *`23.03.2027 14:00` UTC+3 duvar saati yanlış çözülürse* (VPS UTC) tüm teslim sayaçları kayar → Task 1 Test 1-2 (EDT örnekleriyle)
2. *İhale tarihi değişimi (erteleme) okunmamış işaretlemeli* → Task 1 Test 4
3. *Yalnız `raw` alanı tazelenmesi (rutin koşu) okunmamış YAPMAMALI* → Task 1 Test 5
4. *Tarama sessiz bayatlaması* — son başarılı >48 sa → görünür uyarı → Task 1 Test 6 (`isScanStale`) + Task 4 görsel çip adımı
5. *scan-now çift tetikleme / timer çakışması* → Task 1 Test 7 (`scanGuard`: running ise veya <10 dk reddet) + Task 3 route adımı

---

### Task 1: Migrasyon + saf çekirdek (`ihale-upsert.ts`) — TDD

**Files:**
- Modify: `server/src/migrations.ts` (sona yeni migrasyon; `grep -n "id:" server/src/migrations.ts` ile en yükseği bul, sıradakini al)
- Create: `server/src/ihale-upsert.ts`
- Test: `server/test/ihale-upsert.test.ts`

**Interfaces (sonraki görevler bunları tüketir — adlar birebir):**
- `parseEkapTarih(s: string): Date | null` — `DD.MM.YYYY HH:mm`, Europe/Istanbul
- `mapEkapRow(raw: EkapRow): TenderMapped` — `{ ikn, ihale_adi, ihale_tip, usul, durum, durum_aciklama, idare_adi, il, ihale_tarih_saat: Date | null, content_hash }`; `content_hash` = sha256(`/`-join: ihaleAdi, ihaleDurum, ihaleTarihSaat) ilk 16 hex
- `classifyUpsert(existing | null, incoming: TenderMapped): { action: 'insert' | 'update_changed' | 'update_seen'; changedFields: string[] }`
- `isScanStale(lastOkIso: string | null, nowMs?: number): boolean` — son 'ok' > 48 saat
- `scanGuard(lastRun: { status: string; started_at: string } | null, nowMs?: number): { allow: boolean; reason?: string }` — status 'running' VEYA başlangıç < 10 dk → reddet
- `EkapRow` tipi: `{ id, ikn, ihaleAdi, ihaleTip, ihaleTipAciklama, ihaleUsulAciklama, ihaleDurum, ihaleDurumAciklama, idareAdi, ihaleIlAdi, ihaleTarihSaat, dokumanSayisi }` (ham JSON `raw` ayrı saklanır)

- [ ] **Adım 1: Başarısız testleri yaz**

  Test 1 — `parseEkapTarih('23.03.2027 14:00')` → `new Date('2027-03-23T11:00:00Z')` (UTC+3 duvar saati, VPS UTC'de dahi)
  Test 2 — geçersiz/boş girdi → `null`; yıl çevrimi ('05.01.2027 09:30' → `2027-01-05T06:30:00Z`)
  Test 3 — `mapEkapRow`: alan eşlemesi + `content_hash` deterministik (aynı girdi iki kez aynı)
  Test 4 — `classifyUpsert(null, x)` → `insert`; mevcut + `ihale_tarih_saat` değişti → `update_changed`, `changedFields ['ihale_tarih_saat']`; `durum` değişti → `update_changed`
  Test 5 — `classifyUpsert` yalnız `raw` farkı (karma aynı) → `update_seen`, `changedFields` boş
  Test 6 — `isScanStale`: 47 saat önce `false`, 49 saat önce `true`, `null` → `true`
  Test 7 — `scanGuard`: running → reddet; 5 dk önce 'ok' → reddet; 15 dk önce → izin

- [ ] **Adım 2: RED doğrula** — `npm --prefix server run test` → FAIL (`Cannot find module '../src/ihale-upsert'`)

- [ ] **Adım 3: Migrasyonu yaz** (`migrations.ts` sonuna; id = en yüksek + 1)

  Üç tablo + tohum sorgular (spec şeması birebir: `tenders` UNIQUE ikn + content_hash + changed_fields + raw JSONB; `ihale_scan_runs`; `ihale_monitor_queries` tohum: "enerji nakil hattı", "trafo merkezi", "enerji iletim hattı", active=true)

- [ ] **Adım 4: `ihale-upsert.ts`'i uygula** — minimal, testleri geçecek kadar

- [ ] **Adım 5: GREEN doğrula** — `npm --prefix server run test` tümü geçer; `npm --prefix server run build` temiz

- [ ] **Adım 6: Commit** — `feat(ihale): add tender tables and pure mapping/upsert core`

---

### Task 2: EKAP hasat client'i + monitör CLI + canlı spike (merdiven doğrulaması)

**Files:**
- Create: `server/src/ekap-client.ts`
- Create: `server/src/scripts/ihale-monitor.ts`
- Modify: `server/package.json` (`playwright` runtime dep; script girişi yok — doğrudan node ile koşulur)

**Interfaces:**
- Consumes: Task 1 `EkapRow`, `ihale_monitor_queries` tablosu
- Produces: `runEkapHarvest(queries: { name: string; searchText: string }[], opts?: { headful?: boolean }): Promise<EkapRow[]>` — chromium açar → `ekapv2.kik.gov.tr/ekap/search` yükler → doğrulama oturumunu bekler (ağ boşta / `human-verification/status` OK) → sayfa bağlamında `fetch('/b_ihalearama/api/Ihale/GetListByParameters', {method:'POST', headers:{'content-type':'application/json','api-version':'v1'}, body: JSON.stringify(q)})` — gövde: `{searchText, ihaleAdindaAra:true, teklifCetvelindeAra:true, searchType:'GirdigimGibi', yasaKapsami4734List:[1], ihaleTuruIdList:[2], ihaleTarihSaatBaslangic:<bugün 00:00 Europe/Istanbul ISO>, orderBy:'ihaleTarihi', siralamaTipi:'asc', paginationSkip, paginationTake:10}` — sayfa 0..2, satır bitince dur. Sorgular arası ~1 sn `waitTimeout` (nezaket). Hata: açıklayıcı `Error` fırlat, tarayıcıyı `finally`'de kapat.
- `ihale-monitor.ts` CLI: pool + `runMigrations` YOK (sunucu Express açarken migrasyonu zaten uygular; script yalnız okur-yazar) → aktif sorguları oku → hasat → her satır `mapEkapRow` + `classifyUpsert` → INSERT/UPDATE → koşu kaydı: başta `ihale_scan_runs`'a `status='running'` satırı, sonda 'ok'/'error' + new_count/changed_count → exit 0/1. Ortam: `IHALE_HEADFUL=1` (merdiven (b)); `IHALE_MAX_QUERIES` varsayılan 5.

- [ ] **Adım 1: playwright'i kur** — `npm.cmd --prefix server install playwright` (chromium iner ~300 MB; bu makinede bir kez)

- [ ] **Adım 2: Spike — merdiven (a): headless canlı doğrulama**

  Yereldeki `.env` DB'sine karşı: `npx.cmd --prefix server tsx src/scripts/ihale-monitor.ts` koştur.
  Expected: koşu kaydı 'ok', `tenders` tablosunda ≥1 satır (İKN'li, tarih ayrıştırılmış). **Turnstile headless'i engellerse** (timeout/403/boş yanıt): spike sonucunu kayda geçir, `IHALE_HEADFUL=1` (yerelde görünen pencere) ile tekrar — bu VPS'te `xvfb-run` karşılığıdır (merdiven (b)). İkisi de ölmüşse: DUR, kullanıcıya bildir (tasarımın (c) kolu). Spike sonucunu çalışma alanı ledger'ine yaz.

- [ ] **Adım 3: `ekap-client.ts` + `ihale-monitor.ts`'i yaz** (Adım 2'de öğrenilenlerle; doğrulama bekleyişi, hata mesajları)

- [ ] **Adım 4: CLI'yi canlı doğrula** — yeniden koş; `psql` yerine: küçük node sorgusuyla veya ikinci koşuyla `update_seen` yolunu doğrula (aynı İKN tekrar → changed 0, is_read korunur)

- [ ] **Adım 5: Derleme + paket** — `npm --prefix server run build` (dist/scripts/ihale-monitor.js oluşmalı) + tüm testler

- [ ] **Adım 6: Commit** — `feat(ihale): add EKAP harvest client and daily monitor script`

---

### Task 3: Route'lar — liste, okundu, stats, sorgu CRUD, scan-now (spawn)

**Files:**
- Create: `server/src/routes/ihaleler.ts`
- Modify: `server/src/index.ts` (mount: `app.use('/api/ihaleler', ihalelerRouter)` — auth bloğunun altına, overviewRouter'ın yanına)

**Interfaces:**
- Consumes: Task 1 `isScanStale`/`scanGuard`; `ihale_scan_runs`/`tenders`/`ihale_monitor_queries`; **spawn edilen** `dist/scripts/ihale-monitor.js` (Express playwright import ETMEZ)
- Produces (Task 4 tüketir — alan adları birebir):
  - `GET /api/ihaleler` → satır dizisi: `{ ikn, ihale_adi, ihale_tip, usul, durum, durum_aciklama, idare_adi, il, ihale_tarih_saat, is_read, changed_fields, matched_queries, last_seen_at }` — sıra: okunmamış önce, sonra `ihale_tarih_saat` artan
  - `GET /api/ihaleler/stats` → `{ unread: number, last_run: { status, started_at, finished_at, error, new_count, changed_count } | null, is_stale: boolean }`
  - `PUT /api/ihaleler/ikn/:ikn/read` → 204; `PUT /api/ihaleler/read-all` → 204
  - `POST /api/ihaleler/scan-now` → `scanGuard` reddi: 429 + `{error}`; izin: `ihale_scan_runs`'a 'running' satırı + `spawn('node', ['dist/scripts/ihale-monitor.js'], {detached:true, stdio:'ignore'}).unref()` → `202 {started:true}` (dev'de `tsx src/scripts/...` — `isProduction`'a göre seç)
  - `GET/POST /api/ihaleler/queries`, `PUT/DELETE /api/ihaleler/queries/:id` → sorgu CRUD; POST'ta `active=true`, say >5 → 400
  - Router: `router.use(requireAuth, requireRole('owner'))`

- [ ] **Adım 1: Route'ları yaz** — yukarıdaki şema birebir; `scanGuard`'ın sonucu 429 gövdesinde nedenle döner
- [ ] **Adım 2: `scan-now` çakışma yolunu doğrula** — yerelde sunucuyu başlat (`npm run dev`), curl ile: (1) tarama → 202; (2) hemen tekrar → 429 (running koruması); `stats`'ta running görünür; tarama bitince 'ok' + is_stale=false
- [ ] **Adım 3: Derleme + paket** — `tsc` temiz, tüm testler, `dist/scripts` yolu doğru (spawn dev/prod ayrımı TS'te derlenebilir olmalı)
- [ ] **Adım 4: Commit** — `feat(ihale): add tender list/stats/scan API routes`

---

### Task 4: İstemci — İhale Kutusu + navigasyon + Portföy kartı

**Files:**
- Create: `client/src/pages/Ihaleler.jsx`
- Modify: `client/src/App.jsx` (import + owner route `/ihaleler` + kenar çubuğu NavLink "İhaleler" — "Kullanıcılar"dan önce uygun blok)
- Modify: `client/src/pages/Portfolyo.jsx` (stats fetch + 4. stat-card + bayatlama çipi)

**Interfaces:**
- Consumes: Task 3'ün uç şemaları; `api`, `fmtDate`, `StatusBadge` yerine `badge-*` sınıfları (mevcut desen)
- Produces: rota `/ihaleler` (yalnız owner dalı); `Ihaleler` default export

- [ ] **Adım 1: Sayfayı yaz** — `Planlama.jsx` iskeleti (loading/error/empty). İçerik:
  - `page-head`: "İhale Kutusu" + "🔄 Şimdi Tara" (scan-now 202 → stats poll 3 sn arayla bitene dek → liste yenile; 429 → hata mesajı nedeniyle)
  - "Son tarama" satırı: `{status} · {fmtDate(finished_at)} · yeni {new_count}`; `is_stale` → `badge-amber "tarama uyuyor"` (Review Focus 4'ün görünen hali)
  - Tablo: İKN (kalın okunmamışsa) · Ad (+`badge-amber "değişti"` changed_fields doluysa) · İdare · İl · Durum (`badge-red` iptal, `badge-green` açık-benzeri — eşleme: açıklama metni 'İptal' içerir → red, 'Katılıma Açık' → green, değilse gray) · Tarih (fmtDate + "X gün" sayaç; geçmişse `badge-red "kapandı"`)
  - Satır tıklaması: `PUT .../read` + `window.open` EKAP arama (`https://ekapv2.kik.gov.tr/ekap/search` — İKN ile derin bağlantı spike'ta çözüldüyse onu kullan, çözülmediyse arama sayfası)
  - Sorgu paneli: aktif sorgular chip'leri (sil ×) + yeni anahtar kelime formu (POST)
  - "Tümünü Okundu İşaretle" düğmesi
- [ ] **Adım 2: Portföy kartı** — `Portfolyo.jsx`: `/api/ihaleler/stats` fetch; 4. `stat-card` `{unread} Yeni İhale` (warn sınıfı >0), `/ihaleler`'e Link + onClick `setProjectId` GEREKMEZ (ihaleler proje-bağımsız); `is_stale` → kartın altına `badge-amber` çip
- [ ] **Adım 3: Derleme kapısı** — `npm --prefix client run build` hatasız
- [ ] **Adım 4: Commit** — `feat(ihale): add Ihale Kutusu page with scan status and query management`

---

### Task 5: CI/CD + systemd timer + README (dağıtım omurgası)

**Files:**
- Modify: `.github/workflows/ci-cd.yml`
- Create: `deploy/ptyp-ihale-monitor.service` + `deploy/ptyp-ihale-monitor.timer`
- Modify: `README.md`

- [ ] **Adım 1: CI betiği** — test işine ortam `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1"` (server bağımlılık kurulumunda tarayıcı inmesin); deploy SSH betiğinde `npm run build` ÖNCESİNE `npm --prefix server install --no-audit --no-fund` satırı (yeni bağımlılıklar dağıtımı kırmaz)
- [ ] **Adım 2: systemd birimleri** — `ptyp-backup` deseninin kopyası: service (User=turguz, oneshot, `ExecStart=/usr/bin/node /home/turguz/ptyp/server/dist/scripts/ihale-monitor.js`, WorkingDirectory=/home/turguz/ptyp/server) + timer (OnCalendar `*-*-* 06:00:00`, Persistent=true). Not: `.env` yükleme `db.ts → config.ts` zinciriyle zaten olur (Task 2 spike kanıtlar)
- [ ] **Adım 3: README** — "İhale İzleme" bölümü: VPS tek sefer hazırlığı (npm install → `npx playwright install chromium` → `sudo npx playwright install-deps` [şifre bir kez] → `systemctl enable --now ptyp-ihale-monitor.timer`), spike merdiveni notu (headful gerekiyorsa `IHALE_HEADFUL=1` + `xvfb`), sorgu yönetimi UI'dan
- [ ] **Adım 4: Derleme + paket** — `npm --prefix server run build` + tüm testler + `npm --prefix client run build` (dağıtım öncesi tam kapı)
- [ ] **Adım 5: Commit** — `ci(ihale): install server deps on deploy, add monitor timer units and README ops`

- [ ] **Adım 6: Kullanıcıyla dağıtım** — push → CI yeşil dağıtım; VPS hazırlığını kullanıcıyla birlikte yap (sudo şifresi ondan): npm install, chromium + deps, timer enable; ardından canlı doğrulama: elle tarama tetikle → İhale Kutusu'nda satırlar + stats ok
