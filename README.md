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

## Karanlık / aydınlık tema

Sol menünün altındaki tema düğmesiyle değiştirilir; tercih tarayıcıda saklanır.
Arayüz **Martel Sans** yazı tipini kullanır (npm ile self-host edilir).
