# İhale İzleme (İhale Kutusu) — Uygulama Planı

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** EKAP ihale duyurularını Playwright ile günlük hasat edip İhale Kutusu sayfasında sunan izleme modülü (tasarım: ihale tarih penceresi, değişim işaretleme, tarama sağlığı).

**Architecture:** kullanıcının gerçek tarayıcısında bir **bookmarklet** EKAP arama sayfasının bağlamında sorguları koşar (Turnstile kullanıcı oturumuyla zaten doğrulanmış) ve satırları token'la PTYP ingest ucuyla gönderir → saf `ihale-upsert` mantığıyla DB'ye upsert → owner-only route'lar → `/ihaleler` sayfası + Portföy kartı. (Revizyon A: Playwright sunucu hasadı kanıtlanarak öldü — bkz. spec eki.)

**Tech Stack:** Express 5 + TypeScript strict · pg · Playwright (chromium) · React 18 · vitest

**Spec:** `docs/superpowers/specs/2026-11-21-ihale-izleme-design.md` (onaylı; pencere/karma/sağlık/merdiven kararları orada)

## Global Constraints

- `tsc` derlemesi temiz kalmalı; **yeni npm bağımlılığı yok** (Playwright pivotla düştü)
- **İngest ucu `requireAuth` DIŞINDA** — kendi koruması `x-ptyp-token` + CORS (yalnız `https://ekapv2.kik.gov.tr`, preflight dahil); Express yalnız saf `http`/`pool` kullanır
- EKAP nezaketi: bookmarklet sorgu başına ≤3 sayfa (×10 kayıt); ingest `scanGuard` ile çift-tıklamayı reddeder (429)
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

### Task 2: Migrasyon genişletmesi (ingest token) + bookmarklet üretici — TDD

**Files:**
- Modify: `server/src/migrations.ts` (migrasyon #11'in içine `ihale_settings` — henüz hiçbir DB'ye uygulanmadığı için güvenle genişletilir; ledger ruling'e bağlı)
- Create: `server/src/ihale-bookmarklet.ts`
- Test: `server/test/ihale-bookmarklet.test.ts`

**Interfaces:**
- Consumes: Task 1 çekirdeği; `ihale_monitor_queries` aktif satırları
- Produces:
  - `generateBookmarklet(input: { origin: string; token: string; queries: { name: string; search_text: string }[] }): string` — `javascript:` + `encodeURIComponent(...)` önekli tek satır; içinde:
    - bugünün Europe/Istanbul 00:00'ı **koşu anında** hesaplanır (yeniden üretim gereksiz)
    - her sorgu için `POST /b_ihalearama/api/Ihale/GetListByParameters` (gövde şablonu: Task 1 recon'unun tam alan listesi — `ihaleTuruIdList:[2]`, `orderBy:'ihaleTarihi'`, `siralamaTipi:'asc'`, `paginationTake:10`, sayfa 0..2, `<10` satırda dur)
    - toplanan satırlar `POST {origin}/api/ihaleler/ingest` (`x-ptyp-token` başlığı) ile gönderilir; yanıt özeti `alert` ile kullanıcıya ("X yeni, Y değişen ✓" / hata mesajı)
    - 0 satır da gönderilir (tazelik sinyali; sessiz-boş-kabul yok mantığı elle hasatta geçersiz)
  - `EKAP_SEARCH_URL` sabiti (`https://ekapv2.kik.gov.tr/ekap/search`) — İstemci "EKAP'ı Aç" için

- [ ] **Adım 1: Başarısız testleri yaz**

  Test 1 — çıktı `javascript:` ile başlar; `decodeURIComponent` sonrası `origin`, `token`, her `search_text` ve `ihaleTuruIdList:[2]` içerir
  Test 2 — tarih penceresi koşu anında: üretilen kodda sabit tarih YOK, `Date.now()` / `toISOString` çağrısı VAR
  Test 3 — `{origin}/api/ihaleler/ingest` hedefi ve `x-ptyp-token` başlığı kodda mevcut
  Test 4 — sorgular arası nezaket: 0 satır dönerse ingest yine çağrılır; sayfa döngüsü `<10` satırda kırılır
  Test 5 — üretim deterministik: aynı girdi iki kez aynı uzunluğun (%95+ karakter birebir) çıktı — rastgelelik yok

- [ ] **Adım 2: RED doğrula** — `npm --prefix server run test` → FAIL (`Cannot find module '../src/ihale-bookmarklet'`)

- [ ] **Adım 3: Migrasyon #11'i genişlet** — `ihale_settings (id INTEGER PRIMARY KEY DEFAULT 1, ingest_token TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())` + boşsa rastgele token tohumu (crypto)

- [ ] **Adım 4: `ihale-bookmarklet.ts`'i uygula** — tek şablonlu fonksiyon; gövde şablonu Task 1'in EKAP recon gövdesi

- [ ] **Adım 5: GREEN + derleme** — tüm testler + `tsc` temiz

- [ ] **Adım 6: Commit** — `feat(ihale): add ingest token setting and bookmarklet generator`

---

### Task 3: Route'lar — liste, okundu, stats, sorgu CRUD, ingest (CORS+token), bookmarklet üretici ucu

**Files:**
- Create: `server/src/routes/ihaleler.ts` (İKİ router: authed + ingest)
- Modify: `server/src/index.ts` (mount: auth bloğuna `app.use('/api/ihaleler', ihalelerRouter)` + `app.use('/api/ihaleler/ingest', ihaleIngestRouter)` — ingest auth DIŞINDA)

**Interfaces:**
- Consumes: Task 1 `mapEkapRow`/`classifyUpsert`/`isScanStale`/`scanGuard`/`EkapRow`; Task 2 `generateBookmarklet` + `ihale_settings.ingest_token`
- Produces (Task 4 tüketir — alan adları birebir):
  - `GET /api/ihaleler` → satır dizisi: `{ ikn, ihale_adi, ihale_tip, usul, durum, durum_aciklama, idare_adi, il, ihale_tarih_saat, is_read, changed_fields, matched_queries, last_seen_at }` — sıra: okunmamış önce, sonra `ihale_tarih_saat` artan
  - `GET /api/ihaleler/stats` → `{ unread: number, last_run: { status, started_at, finished_at, error, new_count, changed_count } | null, is_stale: boolean }`
  - `PUT /api/ihaleler/ikn/:ikn/read` → 204; `PUT /api/ihaleler/read-all` → 204
  - `GET /api/ihaleler/bookmarklet` → `{ code: string, ekap_url: string, token_suffix: string }` — origin `req.protocol + '://' + req.get('host')`
  - `POST /api/ihaleler/ingest-token/regenerate` → `{ token }` (ihale_settings günceller)
  - `GET/POST /api/ihaleler/queries`, `PUT/DELETE /api/ihaleler/queries/:id` → sorgu CRUD; POST'ta `active=true`, say >5 → 400
  - `POST /api/ihaleler/ingest` (**token ile, auth dışı**): gövde `{ rows: EkapRow[] }`; `scanGuard` reddi → 429 `{error}`; başarı → `{ new_count, changed_count }` + `ihale_scan_runs`'a 'ok' satırı ('running' yok — eşzamanlı riski bookmarklet tekil tıklamada yok). CORS: `Origin: https://ekapv2.kik.gov.tr` tam eşleşmeli; `Access-Control-Allow-Origin: <o origin>`, `Allow-Headers: content-type, x-ptyp-token`, `Allow-Methods: POST, OPTIONS`; OPTIONS 204.
  - Authed router: `router.use(requireAuth, requireRole('owner'))`

- [ ] **Adım 1: Route'ları yaz** — yukarıdaki şema birebir; ingest `x-ptyp-token`'ı `ihale_settings`'ten sabit-zamanlı karşılaştırır (`timingSafeEqual` benzeri uzunluk-normalize basit karşılaştırma yeterli — token zaten yüksek entropi); upsert döngüsü migrasyondaki şemayla (INSERT ON CONFLICT DO NOTHING / update_changed / update_seen — Task 1 kararları)
- [ ] **Adım 2: Derleme + paket** — `tsc` temiz, tüm testler (127+5); CORS/ingest akışı canlı doğrulama Task 5'te VPS'te (yerel DB parolası uyuşmuyor — ledger'da)
- [ ] **Adım 3: Commit** — `feat(ihale): add tender list/stats/queries routes and token-protected CORS ingest`

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
  - `page-head`: "İhale Kutusu" + "Yenile" düğmesi (liste+stats yeniden fetch)
  - **"EKAP Taraması" kurulum kartı** (`card`, sayfanın üstünde): (1) `GET /api/ihaleler/bookmarklet` → gösterilen `<a>` bağlantısı (`javascript:` kodu — sürüklenebilir yer imi) + "Kopyala" düğmesi (clipboard) + kısa 3 adımlı Türkçe talimat (EKAP'i aç → yer imine tıkla → kutuya dön); (2) "EKAP Arama Sayfasını Aç" düğmesi (`window.open(ekap_url)`); (3) sorgular değişince bookmarklet'in yeniden kopyalanması gerektiği notu
  - "Son tarama" satırı: `{status} · {fmtDate(finished_at)} · yeni {new_count}`; `is_stale` → `badge-amber "tarama uyuyor"` (Review Focus 4'ün görünen hali)
  - Tablo: İKN (kalın okunmamışsa) · Ad (+`badge-amber "değişti"` changed_fields doluysa) · İdare · İl · Durum (`badge-red` iptal, `badge-green` açık-benzeri — eşleme: açıklama metni 'İptal' içerir → red, 'Katılıma Açık' → green, değilse gray) · Tarih (fmtDate + "X gün" sayaç; geçmişse `badge-red "kapandı"`)
  - Satır tıklaması: `PUT .../read` + `window.open` EKAP arama (`https://ekapv2.kik.gov.tr/ekap/search`)
  - Sorgu paneli: aktif sorgular chip'leri (sil ×) + yeni anahtar kelime formu (POST) + sorgu değişince kurulum kartında "bookmarklet'i güncelle" notu basılır
  - "Tümünü Okundu İşaretle" düğmesi
- [ ] **Adım 2: Portföy kartı** — `Portfolyo.jsx`: `/api/ihaleler/stats` fetch; 4. `stat-card` `{unread} Yeni İhale` (warn sınıfı >0), `/ihaleler`'e Link + onClick `setProjectId` GEREKMEZ (ihaleler proje-bağımsız); `is_stale` → kartın altına `badge-amber` çip
- [ ] **Adım 3: Derleme kapısı** — `npm --prefix client run build` hatasız
- [ ] **Adım 4: Commit** — `feat(ihale): add Ihale Kutusu page with scan status and query management`

---

### Task 5: README + dağıtım + canlı uçtan-uca doğrulama (kullanıcı tarayıcısıyla)

**Files:**
- Modify: `README.md` (modül tablosuna "İhale Kutusu" satırı + kurulum bölümü)

CI/CD değişikliği YOK (yeni npm bağımlılık kalmadı; mevcut hat sırayı düzenliyor). systemd YOK.

- [ ] **Adım 1: README** — "İhale İzleme" bölümü: bookmarklet kurulumu (İhale Kutusu → "Bookmarklet'i Kur" kartı → sürükle/kopyala), günlük ritüel (EKAP'i aç → yer imine tıkla → kutuya dön; "tarama uyuyor" çipi >48 sa hatırlatır), sorgu yönetimi UI'dan, token yenileme (sızıntı halinde "Yeniden Üret")
- [ ] **Adım 2: Tam derleme kapısı** — `npm --prefix server run build` + tüm testler + `npm --prefix client run build`
- [ ] **Adım 3: Commit + push** — `feat(ihale): add tender monitoring README for bookmarklet workflow` → push → CI otomatik dağıtır (deploy betiği değişmedi)
- [ ] **Adım 4: Canlı uçtan-uca doğrulama (kullanıcıyla)** — canlıda: (1) `/ihaleler` açılır, kurulum kartından bookmarklet kopyalanır/yer imine eklenir; (2) EKAP arama sayfası açılır, yer imine tıklanır → alert "X yeni ✓"; (3) İhale Kutusu yenilenir: satırlar + "son tarama" taze + Portföy çipi; (4) çift tıklama koruması: yer imine hemen tekrar tıklanır → 429 alerti. Kanıtlar ledger'e.
