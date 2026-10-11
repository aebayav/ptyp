# Paketo Build Hatası Raporu — PTYP (`tsc: not found`)

**Tarih:** 2026-10-11
**Proje:** ptyp-main (PTYP — ENH & Trafo Merkezi Proje Yönetim Sistemi)
**Ortam:** Paketo Buildpacks (`pack build`), Node Engine 24.21.0, npm-install 2.3.30, node-run-script 2.3.54

---

## 1. Özet (TL;DR)

Build, **`npm run build` → `npm --prefix server run build` → `tsc`** adımında şu hatayla başarısız oluyor:

```
> ptyp-server@0.1.0 build
> tsc
sh: 1: tsc: not found
exit status 127
ERROR: failed to build: exit status 1
```

**Kök neden:** Paketo'nun `npm-install` buildpack'i **yalnızca kök `package.json`'ı kurar**. Bu proje monorepo benzeri bir yapıya sahip (`server/package.json`, `client/package.json` ayrı) ve `typescript` devDependency'si `server/package.json` içinde tanımlı. Kök `npm ci` yalnızca 25 paket (sadece `concurrently` ve bağımlılıkları) kurduğu için `server/node_modules` hiç oluşmuyor → `tsc` bulunamıyor.

**Not:** `tsc` hatası düzeltilse bile imaj çalışma zamanında **yine ayağa kalkamayacaktır** (bkz. Bölüm 4). Paketo bu repo yapısını desteklemiyor; tek kök `package.json` bekliyor.

---

## 2. Kritik Log Parçaları

### 2.1. Detect aşaması (node-start buildpack)

```
could not find app in /workspace: expected one of server.js | server.cjs | server.mjs
| app.js | app.cjs | app.mjs | main.js | main.cjs | main.mjs | index.js | index.cjs | index.mjs
err:  paketo-buildpacks/node-start@2.7.7 (1)
```

Giriş noktası kökte değil, `server/dist/index.js` altında. `node-start` bu yüzden devre dışı kalıyor. Kök `package.json`'da `start` script'i olduğu için `npm-start` buildpack'i devreye giriyor ve imaj `npm start` ile başlıyor — şu an için bu durum tek başına ölümcül değil.

### 2.2. npm-install — kök kurulum

```
Running 'npm ci --unsafe-perm --cache ...'
added 25 packages, and audited 26 packages in 1s
```

25 paket = kök `package.json`'ın devDependencies'ı (`concurrently`) + bağımlılıkları. `server/` ve `client/` kurulmadı.

### 2.3. npm-install — launch ortamı (devDeps temizliği)

```
Executing launch environment install process
Running 'npm prune'
removed 25 packages, and audited 1 package in 494ms
```

Çalışma zamanı katmanında yalnızca kökün **production** bağımlılıkları kalıyor (kök `dependencies` boş → 1 paket kalıyor).

### 2.4. node-run-script — build hatası

```
Running 'npm run build'
> ptyp-main@0.1.0 build
> npm --prefix server run build && npm --prefix client run build
> ptyp-server@0.1.0 build
> tsc
sh: 1: tsc: not found
exit status 127
ERROR: failed to build: exit status 1
```

---

## 3. Mevcut Yapı (sorunlu)

```
ptyp-main/
├── package.json          ← sadece concurrently (devDependency) + script'ler
├── server/
│   ├── package.json      ← prod deps: express, pg, jsonwebtoken...  devDeps: typescript, @types/*, tsx
│   ├── tsconfig.json
│   └── src/index.ts      ← build: tsc → dist/index.js
└── client/
    ├── package.json      ← deps: react, react-dom, react-router-dom   devDeps: vite, @vitejs/plugin-react
    ├── vite.config.js    ← ESM import kullanıyor ("type": "module" gerektiriyor)
    └── src/...           ← build: vite build → dist/
```

Kök `package.json` script'leri:

```json
"build": "npm --prefix server run build && npm --prefix client run build",
"start": "node server/dist/index.js",
"dev":   "concurrently \"npm --prefix server run dev\" \"npm --prefix client run dev\""
```

Server, client/dist'i statik olarak servis ediyor (`server/src/index.ts` → `express.static` + `sendFile` fallback). Bu kısım doğru; sorun sadece Paketo'nun kurulum modeliyle ilgili.

---

## 4. Zincirleme Sorunlar (hepsi aynı kök nedenden)

| # | Sorun | Nerede | Etki |
|---|-------|--------|------|
| 1 | `tsc: not found` (exit 127) | Build | **Build anında patlıyor** — görülen hata bu |
| 2 | `npm prune` → launch modüllerinde sadece kök prod deps kalıyor | Launch | `express`, `pg`, `jsonwebtoken` vb. imajda **olmayacak** → `npm start` çöker |
| 3 | `node-start` kökte giriş dosyası bulamıyor | Detect | Şimdilik `npm-start` kurtarıyor; ama kök `start` script'i olmasaydı imaj hiç başlatılamazdı |

**Sonuç:** `tsc` hatası tek başına düzeltilse bile (ör. build script'ine `--prefix` install adımları ekleyerek), çalışma zamanı katmanında server bağımlılıkları olmadığı için imaj yine kullanılamaz durumda olur. Kök neden tek: **Paketo monorepo/çoklu package.json yapısını desteklemiyor.**

---

## 5. Çözüm Seçenekleri

### Seçenek A — Tek kök package.json (ÖNERİLEN)

Tüm bağımlılıklar köke taşınır; `server/package.json` ve `client/package.json` (ve lock dosyaları) silinir, tek `package-lock.json` kalır.

```json
{
  "name": "ptyp-main",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "concurrently \"tsx watch server/src/index.ts\" \"cd client && vite\"",
    "build": "tsc -p server && cd client && vite build",
    "start": "node server/dist/index.js"
  },
  "dependencies": {
    "adm-zip": "^0.5.16",
    "bcryptjs": "^2.4.3",
    "dotenv": "^16.4.7",
    "express": "^5.1.0",
    "fast-xml-parser": "^4.5.1",
    "jsonwebtoken": "^9.0.2",
    "mammoth": "^1.8.0",
    "multer": "^1.4.5-lts.2",
    "pdf-parse": "^1.1.1",
    "pg": "^8.13.1",
    "xlsx": "^0.18.5",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.26.2"
  },
  "devDependencies": {
    "concurrently": "^9.1.2",
    "typescript": "^5.7.2",
    "@types/adm-zip": "^0.5.7",
    "@types/bcryptjs": "^2.4.6",
    "@types/express": "^5.0.1",
    "@types/jsonwebtoken": "^9.0.7",
    "@types/multer": "^1.4.12",
    "@types/node": "^22.10.2",
    "@types/pdf-parse": "^1.1.4",
    "@types/pg": "^8.11.10",
    "tsx": "^4.19.2",
    "vite": "^5.4.11",
    "@vitejs/plugin-react": "^4.3.4"
  }
}
```

Gerekli ek adımlar:

1. `client/vite.config.js` → **`client/vite.config.mjs`** olarak yeniden adlandır (dosya ESM `import` kullanıyor; client/package.json silinince `"type": "module"` ortamı kaybolacağı için `.mjs` uzantısıyla ESM'i açıkça belirtmek gerekir). Vite `vite.config.mjs`'i otomatik tanır.
2. `server/package.json` ve `client/package.json` + bu iki dosyanın lock dosyaları silinir; kökte tek `npm install` → yeni tek `package-lock.json`.
3. `server/tsconfig.json` içindeki path'ler tsconfig'in konumuna göre çözülür; `tsc -p server` kökten çağrıldığında sorunsuz çalışır.
4. Doğrulama: yerelde `npm run build && npm start` → sonra `pack build` tekrar denenir.

**Artılar:** Paketo'nun beklediği yapıya birebir uyum; build + launch katmanları doğru çalışır; tek lock dosyası; dev akışı korunur (`npm run dev` aynı şekilde çalışır).
**Eksiler:** Git geçmişinde yapısal değişiklik; server/client altındaki package.json'a alışkın araçların (`npm --prefix`) kaldırılması.

### Seçenek B — Yapıyı koruyan yama (KIRILGAN, önerilmez)

Kök `package.json`:

```json
"build": "npm --prefix server ci && npm --prefix client ci && npm --prefix server run build && npm --prefix client run build"
```

**ve** server'ın prod bağımlılıkları (express, pg, ...) kök `dependencies` alanına **kopyalanmalı** ki `npm prune` sonrası launch katmanında kalsınlar.

Sorunları: iki kopya bağımlılık listesi senkron tutulmalı; `npm ci` build aşamasında NODE_ENV=production ile devDeps'i atlayabilir (buildpack build env'i development yapsa da davranış sürüme göre değişir); bakımı zahmetli.

### Seçenek C — Paketo'dan vazgeç, klasik Dockerfile

```dockerfile
FROM node:24 AS build
WORKDIR /app
COPY . .
RUN npm ci --prefix server --include=dev && npm ci --prefix client --include=dev
RUN npm --prefix server run build && npm --prefix client run build

FROM node:24-slim
WORKDIR /app
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/client/dist ./client/dist
COPY server/package*.json ./server/
RUN cd server && npm ci --omit=dev
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server/dist/index.js"]
```

**Artılar:** Monorepo yapısı olduğu gibi kalır; aşamalar tam kontrol altında.
**Eksiler:** Paketo buildpack zincirinden (ve `turguz/kutuphaneler` custom buildpack'inden) vazgeçilir; imaj boyutu/katman optimizasyonu manuel yapılır.

---

## 6. Öneri

**Seçenek A** uygulanmalı. Sebepler:

- Paketo'nun kökten beklediği yapıya geçilmiş olur; hem `tsc` build hatası hem de runtime'da `express` bulunamaması sorunu tek hamlede çözülür.
- Dev akışı (`npm run dev`) korunur.
- Tek `package-lock.json` ile sürüm yönetimi sadeleşir.
- `turguz/kutuphaneler` custom buildpack'i sorunun kaynağı değil (sorun ondan önceki Paketo node buildpack'lerinde) — A seçeneğiyle custom buildpack de sorunsuz çalışmaya devam eder.

## 7. Doğrulama Planı (A uygulanınca)

1. `npm install` (kök) → tek lock dosyası oluşur.
2. `npm run build` → `server/dist` ve `client/dist` oluşur.
3. `npm start` → `http://localhost:3000` yanıt verir (express + statik client).
4. `pack build <imaj> --builder <mevcut builder>` → build başarılı, `tsc: not found` yok.
5. İmaj çalıştırılıp `/api/health` (veya muadili) + client ana sayfası kontrol edilir.
