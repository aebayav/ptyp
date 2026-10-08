# ⚡ PTYP — Proje Yönetim Sistemi

Elektrik Nakil Hattı & Trafo Merkezi projesi için modüler iş takip ve tedarik yönetim sistemi.

**Teknoloji:** React 18 + Vite 5 (frontend) · Express 5 + TypeScript (backend) · PostgreSQL (veritabanı)

## Proje yapısı

```
ptyp-main/
├── server/            # TypeScript + Express API
│   ├── src/
│   │   ├── index.ts           # uygulama girişi, SPA servisi, hata yakalama
│   │   ├── config.ts          # .env yükleme + yapılandırma
│   │   ├── db.ts              # PostgreSQL bağlantısı + şema oluşturma
│   │   └── routes/            # API modülleri
│   │       ├── materials.ts   # malzeme listesi CRUD
│   │       ├── suppliers.ts   # satıcı CRUD
│   │       ├── quotes.ts      # teklif CRUD + seçim işlemleri
│   │       └── overview.ts    # genel bakış özeti
│   ├── .env.example   # ortam değişkeni şablonu
│   └── .env           # GERÇEK AYARLAR — git'e EKLEMEYİN
├── client/            # React + Vite
│   └── src/pages/     # Dashboard, Materials, Suppliers, Quotes
├── scripts/
│   └── setup-db.sql   # veritabanı + kullanıcı kurulum şablonu
└── package.json       # kurulum/derleme/başlatma komutları
```

## Kurulum

Gereksinimler: Node.js 22+, PostgreSQL (bu makinede 17 kurulu ve servis olarak çalışıyor).

### 1. Veritabanı ve kullanıcı oluştur

`postgres` süper kullanıcısıyla bir kez çalıştırın
(`scripts/setup-db.sql` içindeki şifreyi kendinize göre değiştirin):

```
"C:\Users\abaya\PostgreSQL\bin\psql.exe" -U postgres -h localhost -f scripts\setup-db.sql
```

> Not: `CREATE DATABASE`/`CREATE USER` zaten yapıldıysa tekrar çalıştırmayın — hata verir.

### 2. Ortam dosyasını oluştur

```
cp server/.env.example server/.env
```

`server/.env` içinde `PGPASSWORD` alanına `setup-db.sql`'de belirlediğiniz şifreyi yazın.

### 3. Bağımlılıkları kur ve derle

```
npm run setup   # server + client bağımlılıkları
npm run build   # TypeScript derlemesi + Vite build
```

### 4. Başlat

```
npm start
```

Sunucu `http://localhost:3000` adresinde açılır. Aynı ağdaki diğer bilgisayarlar için
başlangıç ekranında yazılan `Ağ:` adresi kullanılır (ilk açılışta Windows güvenlik
duvarı izni sorarsa **Allow** deyin, yoksa ağdan erişim sessizce başarısız olur).

## Geliştirme modu

```
npm run dev   # tsx watch (server, :3000) + Vite dev (client, :5173)
```

## Mevcut modüller

| Modül | Durum |
|---|---|
| 📦 Tedarik — Malzeme Listesi | ✅ |
| 🏢 Tedarik — Satıcılar | ✅ |
| 💰 Tedarik — Teklif & Karşılaştırma | ✅ |
| 🔧 İş Takibi | Planlandı |
| 🧾 Muhasebe | Planlandı |
| 📁 Dokümanlar | Planlandı |
