# İhale İzleme (İhale Kutusu) — Tasarım Belgesi

**Tarih:** 2026-11-21 · **Durum:** Onaya sunuluyor

## Amaç ve Neden

PTYP'ye EKAP ihale duyurularını izleyen bir modül: firma ilgisindeki ihaleler
(ENH / trafo merkezi yapım işleri) günlük otomatik yoklamayla toplanır, "İhale
Kutusu" sayfasında teslim tarihine göre sıralanır, yenileri okunmamış olarak
vurgulanır. Bugün ihale kontrolü elle EKAP'ta yapılıyor — kaçırmak bedeli
yüksek (son teslim, teminat, hazırlık süresi).

**Askıda:** Teklif hazırlama (ayrı proje olarak sonra değerlendirilecek).

## Keşif Bulguları (tasarımın dayanağı — 21.11.2026 canlı test)

- Yeni EKAP arama: `ekapv2.kik.gov.tr/ekap/search` (Angular SPA).
- Veri ucu: `POST /b_ihalearama/api/Ihale/GetListByParameters`
  (sorgu: `searchText`, `ihaleTuruIdList` [1=Mal, 2=Yapım, 3=Hizmet, 4=Danışmanlık],
  `ilan/ihaleTarihSaatBaslangic/Bitis`, `paginationSkip/Take`, `orderBy`).
  Yanıt kalemi: `id` (hash), `ikn`, `ihaleAdi`, `ihaleTip(Aciklama)`,
  `ihaleUsulAciklama`, `ihaleDurum(Aciklama)`, `idareAdi`, `ihaleIlAdi`,
  `ihaleTarihSaat` (`DD.MM.YYYY HH:mm`), `dokumanListe`.
- Koruma: Cloudflare Turnstile (`b_han/api/human-verification/*` → Turnstile JS →
  verify) — gerçek tarayıcıda görünmez/modo yönetili geçiyor (test oturumunda tüm
  çağrılar 200). Düz Node fetch bu el sıkışmayı taklit edemez → **veri alma yalnız
  gerçek tarayıcıyla**.

## Yaklaşımlar

1. **(Seçilen) Playwright + sayfa bağlamında API hasadı:** günlük iş headless
   chromium'da arama sayfasını açar (Turnstile doğal geçer), ardından sayfa
   bağlamında kendi `fetch`'lerimizle `GetListByParameters` sorguları koşar ve
   JSON'u yakalar. UI formu hiç doldurulmaz → EKAP arayüzünü yeniden tasarlarsa
   bile API yüzeyi sürekli kullanılır; en kötü durumda form-sürüşü yedeği.
   **Turnstile doğrulama merdiveni (derleme sırasında ilk görev — spike):**
   (a) headless chromium ile gerçek sorgu — 200'ler dönüyorsa tamam;
   (b) zorlanırsa headful chromium + `xvfb-run` (tek seferlik kök hazırlığına
   küçük apt paketleri eklenir); (c) ikisi de geçemezse iş net hatayla çıkar ve
   modül "Şimdi Tara" elle taramaya dejenere olur — sessiz boş kutu ASLA kabul
   edilmez (tarama sağlık göstergesi bunu görünür kılar, aşağıda).
   *Not: Turnstile bugün canlı testte kullanıcı-tarayıcısında sorunsuz geçti;
   headless davranışı spike adımında kanıtlanacak.*
2. *(Reddedilen)* Düz Node ile API tersine mühendisliği — Turnstile engeli;
   kırılgan bir silah yarışı.
3. *(Reddedilen)* Ücretli hazır ihale servisi — abonelik kararı ve dış bağımlılık;
   EKAP zaten tek resmî kaynak, kapsam 4734 duyurularının tamamı orada.

## Tasarım

### Veri akışı

```
systemd timer (gün 06:00 + systemd Persistent=true kaçıran günü telafi)
  → node server/dist/scripts/ihale-monitor.js
     → Playwright: ekapv2 search sayfası (doğrulama otomatik)
     → ihale_monitor_queries tablosundaki her aktif sorgu için:
         GetListByParameters(searchText=sorgu.metin, ihaleTuruIdList=[2],
                            ihaleTarihSaatBaslangic=şimdi,  → AÇIK ihaleler)
                            orderBy=ihaleTarihi asc, sayfa başına 10, en çok 3 sayfa)
     → sonuçları tenders tablosuna upsert (İKN benzersiz anahtar)
         yeni İKN → is_read=false
         İçerik karması (durum, ihaleTarihSaat, ihaleAdi) değişti → is_read=false
         + "değişti" notu (ertelenen/iptal edilen ihale tekrar görünür)
         değişiklik yok → yalnız last_seen_at
     → her koşu ihale_scan_runs'a kaydolur (başarı/hata/yeni sayısı)
  → İhale Kutusu sayfası (/ihaleler) okunmamış vurgusuyla listeler
     + "Son tarama: <saat>, durum" satırı — başarısızlık sessiz kalamaz
  → Portföy uyarı şeridine: okunmamış ihale sayısı + son tarama >48 sa ise
     "tarama uyuyor" uyarısı
```

**Pencere kararı (tasarımcı çağrısı — onayda vetolanabilir):** sorgu penceresi
**ihale (teslim/açılış) tarihi = bugünden ileri** — duyuru tarihi penceresi değil.
Böylece gün 1'de kutu, ne zaman duyurulduysa duyurulmuş TÜM açık ihaleleri
içerir; İKN-dedupe tekrarları zararsız kılar. Sayfalama: sorgu başına en çok 3
sayfa (30 kayıt) — en yakın teslim tarihler önce; "≤5 sorgu" nezaket sınırıyla
birlikte günlük yük ≤ 15 API çağrısı.

### Veritabanı (numaralı migrasyon, mevcut desen)

- `ihale_monitor_queries`: `id, name, search_text, active, created_at`
  — tohum: "enerji nakil hattı", "trafo merkezi", "enerji iletim hattı" (Yapım=2)
- `tenders`: `id, ikn TEXT UNIQUE, ihale_adi, ihale_tip, usul, durum, durum_aciklama,
  idare_adi, il, ihale_tarih_saat TIMESTAMPTZ, content_hash TEXT,
  first_seen_at, last_seen_at, last_change_at, changed_fields JSONB,
  is_read BOOLEAN DEFAULT false, matched_queries JSONB, raw JSONB`
- `ihale_scan_runs`: `id, started_at, finished_at, status ('ok'|'error'),
  error TEXT, queries_run INT, new_count INT, changed_count INT` — İhale Kutusu
  başlığındaki "son tarama" göstergesi ve Portföy uyarma çipi bu tablodan okur

### Sunucu

- `server/src/ekap-client.ts` — Playwright hasat mantığı (tarayıcı ömrü ~60 sn,
  sorgu başına nazik aralık; hata → açıklayıcı log, çıkış kodu 1)
- `server/src/scripts/ihale-monitor.ts` — bağımsız CLI girdisi (DB pool + migrasyon
  şemaları üzerinden çalışır; `tsx`/dist'ten koşar)
- `server/src/routes/ihaleler.ts` — owner-only: `GET /api/ihaleler` (liste + filtre),
  `PUT /api/ihaleler/:ikn/read`, sorgu CRUD, `POST /api/ihaleler/scan-now`
  (elle tetikleme: script'i spawn eder, 202 + parse-jobs benzeri basit durum).
- Yeni bağımlılık: `playwright` (yalnız server; VPS'te bir kez
  `npx playwright install chromium`).

### İstemci

- `client/src/pages/Ihaleler.jsx` — "İhale Kutusu": teslim tarihine göre sıralı
  tablo; okunmamış satır vurgusu; İKN/Ad/İdare/İl/Durum/Tarih sütunları;
  "Şimdi Tara" düğmesi (scan-now, dönen durum); sorgu yönetimi (basit form);
  satır → EKAP'ta o İKN ile arama bağlantısı (ayrıntı sayfası URL desimi
  derleme sırasında doğrulanır; olmazsa arama bağlantısı yeterli).
- `App.jsx`: owner kenar çubuğuna "İhaleler"; Portföy uyarı kartına
  okunmamış ihale sayısı (mevcut uyarı deseni).

### Operasyon (VPS)

- **Tek seferlik kök hazırlığı (tasarımın onayıyla bir kez, SSH'ta):**
  1. `cd ~/ptyp && npm --prefix server install` (yeni bağımlılık: playwright)
  2. `npx --prefix server playwright install chromium` (~300 MB tarayıcı)
  3. `sudo npx --prefix server playwright install-deps` (chromium sistem
     kütüphaneleri — **sudo şifresi bir kez kullanıcıdan**; CI'nın sudoers'ı
     bunu kapsamaz, kasıtlı)
  4. Spike sonucu headful+xvfb gerekiyorsa: `sudo apt-get install xvfb` (merdivenin
     (b) adımı)
- **CI/CD betiği güncellemesi:** deploy adımına `npm --prefix server install`
  eklenir (gelecek bağımlılıklar dağıtımı kırmaz); test işinde
  `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` (her koşuda tarayıcı inmesi engellenir).
- `deploy/ptyp-ihale-monitor.service` + `.timer` (OnCalendar 06:00,
  Persistent=true) — ptyp-backup deseninin aynısı; `OnFailure=` notu systemd
  günlüğüne düşer.
- Timer kurulumu README'ye eklenir. Cron/Elle: `node dist/scripts/ihale-monitor.js`.

## Hedefler

- Gün 1'den itibaren: firmayı ilgilendiren ihaleler tek ekranda, teslim sıralı
- Yeni duyuru görünür vurgu + Portföy uyarısı
- Sorgular kullanıcı tarafından genişletilebilir (yeni anahtar kelime/kurum)

## Hedef Olmayanlar (v1)

- E-posta/bildirim gönderimi (sonraki aşama: Bildirim Merkezi projesiyle birleşir;
  v1'de sessiz bayatlama **olmaz** — tarama sağlık göstergesi + Portföy çipi kapsar)
- İhale dokümanı indirme (`dokumanListe` alanı veri olarak saklanır, indirilmez)
- Teklif hazırlama (askıda — kullanıcı kararı)
- İkinci kaynak (Kamu İhale Bülteni vb.) — EKAP arama 4734 kapsamının tamamını
  kapsıyor; gerekirse v2'de eklenir
- Otomatik yenileme sayfada — elle "Şimdi Tara" + günlük timer yeterli

## Kısıtlar

- EKAP'a günde en çok 1 otomatik yoklama (+ kullanıcı elle tıklaması); sorgu
  sayısı ≤ 5; politeliğin korunması bir tasarım gereği
- Playwright yalnız izleme script'inde çalışır — Express sürecine **girmez**
  (bellek izolasyonu; 10 GB VPS'te chromium ~500 MB zirve, kısa ömürlü)
- TypeScript strict; mevcut stil/migrasyon/route desenleri aynen
- Yeni satır eklenen kök hazırlığı kullanıcı onayıyla bir kez yapılır (sudo
  şifresi kullanıcının eliyle girilir); CI asla kök kurulum yapmaz

## Yapımcıya Kalan

- EKAP ayrıntı sayfası URL desimi (İKN ile derin bağlantı) — derleme sırasında
  canlı doğrulanacak; çözülmezse arama bağlantısı fallback.
- `ihaleTuruIdList` tip kodlarının canlı doğrulaması (test gövdesinde 1..4
  sırası: Mal/Yapım/Hizmet/Danışmanlık varsayımı — Yapım=2 kontrol edilecek).
- `scan-now` iş durum izleme ayrıntısı (tamamlanana kadar poll — parse-jobs
  deseninin hafif türevi ya da senkron await).
