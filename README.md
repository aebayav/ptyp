# PTYP — Proje Yönetim Sistemi

Elektrik Nakil Hattı (ENH) ve Trafo Merkezi projeleri için modüler proje yönetim sistemi:
tedarik, iş takibi, hakediş, keşif (BOQ), saha günlük raporları ve belgeden otomatik KMZ üretimi.

**Teknoloji:** React 18 + Vite 5 (frontend) · Express 5 + TypeScript (backend) · PostgreSQL (veritabanı) · Python FastAPI OCR servisi (Indra OCR + GLM-OCR)

## Modüller

| Modül | Açıklama |
|---|---|
| Genel Bakış | Proje özeti ve durum kartları |
| Tedarik — Malzeme Listesi | ENH/trafo malzemeleri, tedarik durumu, hedef fiyatlar |
| Tedarik — Satıcılar | Tedarikçi firmalar ve teklif geçmişi |
| Tedarik — Teklif & Karşılaştırma | Teklif toplama, en uygun teklifi seçme |
| Depo & Stok | İrsaliye girişi, sahaya sevk, sarfiyat; kalan stok + keşif karşılaştırması (saha talepleri bağlanabilir) |
| İş Takibi & Güzergah | İş grupları, görevler, ağırlıklı ilerleme, harita |
| Kamulaştırma | Açıklık bazında parsel/malik/irtifak/bedel takibi; izinsiz parseller haritada kırmızı |
| Plan & Gerçekleşme | Ağırlıklı ilerlemeden otomatik S-eğrisi + Gantt + gecikme uyarısı |
| Hakediş Yönetimi | Aylık hakediş hesaplama (sözleşme miktarları, birim fiyatlar) |
| Fiyat Farkı | TÜİK endeks kayıtları + Pn formülü (Pn = İn/İo, Fark = Tutar × (Pn − 1)); **Otomatik Getir** ile TCMB EVDS'den resmi endeks değeri çekilir (`EVDS_API_KEY` gerekli — evds2.tcmb.gov.tr'den ücretsiz) |
| Keşif (BOQ) | DTL belgesinden otomatik keşif özeti — düzenlenebilir kalemler, Excel çıktısı |
| Saha | Direk bazlı ilerleme + fotoğraf + QR kartları + malzeme talebi (field rolü) |
| Saha Günlük Raporu | Günlük personel, ekipman ve imalat kaydı |
| İSG | Toolbox eğitimleri, ramak kala / kaza kayıtları, personel sertifikaları + bitiş uyarıları |
| Belge → KMZ | PDF/TIFF/Excel'den direk koordinatları + DTL tablosunu okuyup KMZ üretme |
| Dokümanlar | Pafta, DTL revizyonları ve onay yazıları — projeye bağlı, revizyonlu, dosyalı |
| Kullanıcılar | İş sahibi, saha ve satıcı (tedarikçi portalı) hesapları |
| İhale Kutusu | EKAP ihale duyuruları — tarayıcıda tek tıklamalık tarama; teslim tarihli liste, değişim uyarıları |

Tedarikçiler kendi portalında yalnızca açık malzemeleri ve kendi tekliflerini görür.

## Belge → KMZ ve Keşif boru hattı

1. Belge (PDF metin katmanı / taranmış PDF / TIFF / Excel) yüklenir.
2. Taranmış belgeler **Indra OCR** (ONNX, CPU, ana motor) ile okunur; eksik/zayıf hücreler **GLM-OCR** (Ollama) ile doldurulur.
3. Koordinatlar **ITRF-96 / 3° TM** (otomatik dilim tespiti, il/ilçe tablosu + doğrulama) veya WGS84 üzerinden dönüştürülür; referans KMZ ile şantiye grid kalibrasyonu yapılabilir.
4. Direkler DTL öznitelikleriyle zenginleştirilir (tip, fonksiyon, istasyon, geçiş). OCR bozulan direk tipleri bilinen tip sözlüğüyle eşleştirilip düzeltilir (`server/src/tower-types.ts`).
5. Düzeltilebilir tablo → KMZ üretimi + projeye kayıt. Toplu yüklemede tüm dosyaların DTL satırları birleştirilir.
6. **Keşif**: DTL'den otomatik BOQ kalemleri üretilir — direk tipi adetleri, hat uzunluğu, iletken miktarı (kg/m), izolatör takımları. Kalemler düzenlenebilir, birim fiyat girilebilir, Excel'e aktarılabilir.

## CI/CD (GitHub Actions)

`.github/workflows/ci-cd.yml`:

- **Her push / PR'de:** bağımlılıklar (`npm ci`), vitest testleri (parser + tip eşleştirme + DATE regresyonları), server + client build.
- **main'e push'ta (testler geçerse):** Turguz VPS'e dağıtım — `git reset --hard origin/main` → `npm run build` → `sudo -n systemctl restart ptyp` → `is-active` sağlık kontrolü.

Gereksinimler:

1. GitHub repo ayarları → Secrets and variables → Actions → **`DEPLOY_SSH_KEY`** sırrı: `C:\Users\abaya\.ssh\id_ed25519` dosyasının içeriği (jump-host'a kayıtlı anahtar; şifresiz olmalı).
2. Sunucuda `/etc/sudoers.d/ptyp-ci` — `turguz` kullanıcısına yalnızca `systemctl restart/is-active ptyp` için NOPASSWD yetkisi (dar kapsam, `visudo -c` ile doğrulanmış).

Sır tanımlı değilken dağıtım adımı sessizce atlanır (testler yine koşar); sır eklendikten sonraki ilk push tam döngüyü çalıştırır.

## Proje yapısı

```
ptyp-main/
├── server/               # Express + TypeScript API
│   └── src/
│       ├── routes/       # auth, materials, suppliers, quotes, workgroups, tasks,
│       │                 # poles, projects, progress-payments, daily-reports,
│       │                 # kmz-generator, kesif, export, overview, users
│       ├── dtl-parser.ts # 27 sütunlu DTL ayrıştırıcı (Excel / metin / OCR)
│       ├── tower-types.ts# direk tipi sözlüğü + OCR bozulma eşleştirici
│       ├── coord-parser.ts # TM3/UTM/WGS84 dönüşümleri
│       ├── kmz-builder.ts / kmz-parser.ts
│       └── db.ts         # PostgreSQL şema + migrasyonlar
├── client/               # React + Vite
│   └── src/pages/        # Dashboard, Materials, Suppliers, Quotes, WorkTracking,
│                         # ProgressPayments, Kesif, DailyReports, DocumentKmz, ...
├── ocr-service/          # Python FastAPI — Indra OCR + GLM-OCR (Ollama)
├── deploy/               # systemd servisleri (ptyp, ocr, ollama)
└── scripts/              # DB kurulum şablonu, demo verisi
```

## Kurulum

Gereksinimler: Node.js 22+, PostgreSQL 17.

```bash
# 1) Veritabanı ve kullanıcı (bir kez)
"C:\Users\<kullanıcı>\PostgreSQL\bin\psql.exe" -U postgres -h localhost -f scripts\setup-db.sql

# 2) Ortam dosyası
cp server/.env.example server/.env   # PGPASSWORD ve diğer ayarları doldurun

# 3) Bağımlılıklar + derleme
npm run setup
npm run build

# 4) Başlat
npm start
```

Uygulama `http://localhost:3000` adresinde açılır. İlk açılışta hiç kullanıcı yoksa
`.env`'deki yönetici hesabı otomatik oluşturulur.

Geliştirme modu: `npm run dev` (server :3000 + Vite dev :5173)

## OCR servisi (ayrı bileşen)

`ocr-service/` FastAPI uygulaması `127.0.0.1:8787`'de çalışır; Node sunucu `OCR_URL`
üzerinden çağırır. Gereksinimler:

- Python 3.12 + venv (`ocr-service/.venv`)
- `pip install -r ocr-service/requirements.txt` (Indra OCR dahil)
- Ollama + `glm-ocr` modeli (yedek/dolgu okuma için)
- systemd: `deploy/ocr.service` (not: `OCR_CONCURRENCY=1` — eşzamanlı istekler modeli çökertir)

## Dağıtım (canlı sunucu)

Canlı sistemde derleme sunucuda yapılır ve `ptyp` systemd servisi yeniden başlatılır:

```bash
npm run build                      # lokal derleme kapısı
scp -r server/src client/src <sunucu>:~/ptyp/...
ssh <sunucu> "cd ~/ptyp && npm run build"
sudo systemctl restart ptyp        # yalnızca server kodu değiştiyse gerekir
```

## Mobil (Android / Capacitor)

Saha uygulaması Capacitor ile APK olarak paketlenir (`client/`):

```bash
npm --prefix client run mobile:init     # bir kez: cap add android
npm --prefix client run mobile:sync     # web derlemesini native projeye aktar
npm --prefix client run mobile:android  # Android Studio'da aç
```

`client/android/` klasörü `.gitignore`'dadır (yerel olarak üretilir). **APK'da saha GPS
özelliklerinin (En Yakın Direk, mesafe doğrulaması) çalışması için** Android projesini
yeniden ürettikten sonra `client/android-overrides/` içindeki izin dosyalarını kopyalayın
(ayrıntılar: `client/android-overrides/README.md`).

## İhale Kutusu (EKAP izleme)

EKAP, arama sayfasını Cloudflare Turnstile doğrulamasıyla korur ve otomatik
erişimi (sunucu tarafı scraping) reddeder. Bu yüzden tarama **sizin
tarayıcınızda** tek tıklamayla yapılır — Cloudflare'in zaten güvendiği istemci:

1. **İhale Kutusu** sayfasını açın → kurulum kartındaki **"PTYP İhale Hasadı"**
   bağlantısını tarayıcı yer imleri çubuğuna sürükleyin (veya "Kopyala").
2. **"EKAP Aramayı Aç"** ile arama sayfasını açın ve sayfanın **yüklenmesini
   bekleyin** (arama kutusu görünsün).
3. Yer imine bir kez tıklayın — aktif sorgular (örn. "enerji nakil hattı",
   "trafo merkezi", Yapım türü) sayfa içinde koşar ve sonuçlar PTYP'ye akar.
   Özet: "X yeni, Y değişen ✓".

Doğrulama oturumu henüz hazır değilse bookmarklet otomatik bekleyip **3 kez
yeniden dener** (428/429). Kalıcı hata alırsanız: **EKAP'e firma hesabınızla
(veya e-imza ile) giriş yapın** ve aynı yer imine tekrar tıklayın — giriş
yapılı oturumda doğrulama sorunu yaşanmaz.

- Sorguları İhale Kutusu'ndaki formdan yönetin (en fazla 5); değiştirince
  bookmarklet'i **yeniden kopyalayın** (yeni sorgular gömülü gelir).
- İhale tarihi değişirse (erteleme) veya durum değişirse (iptal/düzeltme) kayıt
  yeniden okunmamış işaretlenir.
- **"tarama uyuyor"** çipi (İhale Kutusu + Portföy) son başarılı taramadan
  48 saat geçince yanar — günlük ritüel bu.
- İngest token'ı sızarsa sayfadaki "Yeniden Üret" ile değiştirilir
  (bookmarklet'i yeniden kopyalamanız gerekir).

## Karanlık / aydınlık tema

Sol menünün altındaki tema düğmesiyle değiştirilir; tercih tarayıcıda saklanır.
Arayüz **Martel Sans** yazı tipini kullanır (npm ile self-host edilir).
