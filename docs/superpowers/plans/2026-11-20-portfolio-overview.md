# Portföy Genel Bakış — Uygulama Planı

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tüm projeleri ilerleme, hakediş durumu ve uyarılarla tek tabloda gösteren `/portfoy` sayfası + `GET /api/overview/portfolio` agregat endpoint'i.

**Architecture:** Sunucuda 8 paralel `GROUP BY project_id` sorgusu tek yanıtta toplanır; saf `buildPortfolio()` fonksiyonu repo test stiliyle (DB'siz birim test, `stock.test.ts` deseni) doğrulanır. İstemcide tek yeni sayfa mevcut stilleri kullanır; proje seçimi `useProjects` üzerinden hücre bağlantılarında ayarlanır.

**Tech Stack:** Express 5 + TypeScript (strict) · pg · React 18 · vitest

**Spec:** `docs/superpowers/specs/2026-11-20-portfolio-overview-design.md`

## Global Constraints

- TypeScript strict — `tsc` derlemesi temiz kalmalı (`npm --prefix server run build`)
- Yeni npm bağımlılığı yok
- SQL: endpoint parametre almaz; tüm sorgular sabit güvenli (mevcut `overview.ts` deseni)
- UI metinleri Türkçe; yalnızca mevcut CSS sınıfları (`stat-card`, `table-wrap`, `progress-track/progress-fill mini`, `badge-*`)
- Commit'ler semantic: `feat(portfolio): ...`

## Review Focus

1. *Verisi hiç olmayan proje (yeni oluşturulmuş)* — tüm alanlar 0 olmalı, NaN/undefined yok → Task 1 Test 3
2. *work_groups weight toplamı 0* — AVG(progress) fallback'i → Task 1 Test 2
3. *Sıralama eşitliği* — warning_count eşitse ilerlemesi yüksek olan önce → Task 1 Test 4
4. *Boş portföy (proje yok)* — istemcide boş sayfa değil, yönlendiren empty state → Task 2 Adım 2 (istemci test altyapısı repoda yok; adım açıkça şartıyor, `vite build` + gözden geçirme doğrular)
5. *owner olmayan rol `/portfoy`'e giderse* — route yalnızca owner dalında kayıtlı; `*` yakalayıcısı yönlendirir → Task 2 Adım 3 (aynı nedenle adım + derleme ile sabitlenir)

---

### Task 1: Sunucu — `buildPortfolio()` + `/overview/portfolio` endpoint'i

**Files:**
- Create: `server/src/portfolio-summary.ts`
- Test: `server/test/portfolio-summary.test.ts`
- Modify: `server/src/routes/overview.ts`

**Interfaces:**
- Consumes: mevcut `pool`, `requireAuth`/`requireRole` (overview.ts router.use zaten owner kısıtlar)
- Produces (Task 2 bunları tüketir — alan adları birebir):
  - `buildPortfolio(input: BuildPortfolioInput): PortfolioResponse`
  - `GET /api/overview/portfolio` → `PortfolioResponse`:
    ```ts
    {
      projects: Array<{
        id: number; name: string; type: string; capacity: string; employer: string; end_date: string;
        progress: number;          // 0-100, 1 ondalık
        saha_progress: number;     // 0-100, 1 ondalık
        saha_poles: number;
        payments: { draft: number; submitted: number; approved: number; total_amount: number };
        warnings: { late_tasks: number; unpermitted_parcels: number; expiring_certs: number; open_requests: number };
        warning_count: number;
      }>;
      totals: { project_count: number; firm_progress: number; projects_with_warnings: number };
    }
    ```
  - Sıralama kuralı: `warning_count` azalan, eşitlikte `progress` azalan (sunucu uygular).

- [ ] **Adım 1: Başarısız testleri yaz** (`server/test/portfolio-summary.test.ts`)

  Test 1 — birleştirme: projects 2 satır; girdi satırları (aşağıdaki fixture) → p1:
  `progress 71.0` (num 71/den 100), `saha_progress 48.0` (num 480/cnt 10), `warning_count 2`
  (late_tasks 2), payments `{draft:1, submitted:0, approved:1, total_amount: 4200000}`.
  ```ts
  const r = buildPortfolio({
    projects: [
      { id: 1, name: 'DIYAR-2', type: 'enh', capacity: '63 MVA', employer: 'TEİAŞ', end_date: '2027-01-15' },
      { id: 2, name: 'Trafo-X', type: 'trafo', capacity: '', employer: '', end_date: '' },
    ],
    weighted: [{ project_id: 1, num: 71, den: 100, avg_progress: 40 }],
    saha: [{ project_id: 1, num: 480, cnt: 10 }],
    lateTasks: [{ project_id: 1, c: 2 }],
    parcels: [], expiringCerts: [], openRequests: [],
    payments: [
      { project_id: 1, status: 'draft', c: 1, total: 4200000 },
      { project_id: 1, status: 'approved', c: 1, total: 0 },
    ],
  });
  expect(r.projects[0].progress).toBe(71.0);
  // ...payments, warning_count, saha iddiaları
  ```
  Test 2 — AVG fallback: `weighted: [{ project_id: 1, num: 0, den: 0, avg_progress: 33 }]` → `progress` 33.
  Test 3 — verisi olmayan proje: p2 hiçbir girdi satırında yok → tüm sayılar 0, `payments` dört alanı da 0, `warning_count` 0, hiçbir alan `NaN` değil.
  Test 4 — sıralama: p1 (warn 1, prog 50), p2 (warn 1, prog 80), p3 (warn 3) → sıra `p3, p2, p1`.
  Test 5 — totals: den 100/num 50 + den 100/num 80 → `firm_progress` 65.0; `projects_with_warnings` uyarılı proje sayısı.
  Test 6 — hakediş durumları: draft/submitted/approved adetleri kendi alanlarına, `total_amount` tüm satırların toplamı.

- [ ] **Adım 2: Testleri çalıştır — başarısız olmalı**

  Run: `npm --prefix server run test`
  Expected: FAIL — `Cannot find module '../src/portfolio-summary'`

- [ ] **Adım 3: `buildPortfolio`'yu uygula** (`server/src/portfolio-summary.ts`)

  `BuildPortfolioInput` yukarıdaki fixture alan adlarıyla (projects, weighted, saha,
  lateTasks, parcels, expiringCerts, openRequests, payments). İç not: `weighted` satırı
  `den > 0` ise `num/den`, değilse `avg_progress` (1 ondalığa yuvarla, `stock.ts`'teki
  `Math.round(x*10)/10` deseni). `totals.firm_progress`: Σnum/Σden (den'li projeler);
  Σden = 0 ise projekt `progress` ortalaması. Boş map'ler `Map<number, row>` ile
  lookup — eksik anahtar 0 döner (NaN yok).

- [ ] **Adım 4: Testleri çalıştır — geçmeli**

  Run: `npm --prefix server run test`
  Expected: PASS (109 + 6 yeni)

- [ ] **Adım 5: Endpoint'i bağla** (`server/src/routes/overview.ts`)

  `GET /overview/portfolio`: 8 `pool.query` paralel (`Promise.all`, mevcut dosya deseni):
  - `SELECT id, name, type, capacity, employer, end_date FROM projects ORDER BY id`
  - `SELECT project_id, COALESCE(SUM(progress * weight),0)::float AS num, COALESCE(SUM(weight),0)::float AS den, COALESCE(AVG(progress),0)::float AS avg_progress FROM work_groups WHERE project_id IS NOT NULL GROUP BY project_id`
  - saha (mevcut overview.ts 22-33'teki CASE ağırlıkları aynen, `GROUP BY p.project_id`)
  - `SELECT w.project_id, COUNT(*)::int AS c FROM tasks t JOIN work_groups w ON w.id = t.work_group_id WHERE w.project_id IS NOT NULL AND t.status != 'done' AND t.due_date IS NOT NULL AND t.due_date < CURRENT_DATE GROUP BY w.project_id`
  - izinsiz parsel, expiring sertifika (`expiry_date <= CURRENT_DATE + 30`), açık saha talebi — hepsi `WHERE ... GROUP BY project_id`
  - `SELECT pp.project_id, pp.status, COUNT(*)::int AS c, COALESCE(SUM(i.current_qty * i.unit_price), 0)::float AS total FROM progress_payments pp LEFT JOIN progress_payment_items i ON i.payment_id = pp.id WHERE pp.project_id IS NOT NULL GROUP BY pp.project_id, pp.status`
  Sonuç `buildPortfolio(...)` ile `res.json`'a.

- [ ] **Adım 6: Derleme + tam paket**

  Run: `npm --prefix server run build` ardından `npm --prefix server run test`
  Expected: tsc temiz; tüm testler PASS.

- [ ] **Adım 7: Commit**

  ```bash
  git add server/src/portfolio-summary.ts server/test/portfolio-summary.test.ts server/src/routes/overview.ts
  git commit -m "feat(portfolio): add per-project portfolio aggregate endpoint"
  ```

---

### Task 2: İstemci — `/portfoy` sayfası + navigasyon

**Files:**
- Create: `client/src/pages/Portfolyo.jsx`
- Modify: `client/src/App.jsx` (import + owner dalına route + kenar çubuğu NavLink)
- Modify: `client/src/pages/Dashboard.jsx` (page-head'e bağlantı düğmesi)

**Interfaces:**
- Consumes: Task 1'in `PortfolioResponse` alan adları (birebir); `api` (`../api`), `useProjects` + `fmtMoney`, `fmtDate` (`../utils`)
- Produces: rota `/portfoy` (yalnız owner dalı); `Portfolyo` default export

- [ ] **Adım 1: Sayfayı yaz** (`client/src/pages/Portfolyo.jsx`)

  Desen: `Planlama.jsx` yeniden düzenlenmiş haliyle aynı iskelet — `loading` state,
  `error-banner` + "Tekrar Dene", boş durum. İçerik:
  - Özet şerit: 3 `stat-card` — Toplam Proje · Firma İlerlemesi `%{totals.firm_progress}` (mini
    progress bar, Dashboard 101-114 deseni) · Uyarılı Proje (warn sınıfı)
  - `table-wrap` tablo; sütunlar: Proje (ad kalın, altta muted `type · capacity · employer`,
    sağda `fmtDate(end_date)` boşsa hiç), İlerleme (bar + %), Saha (bar + % + `{saha_poles} direk`),
    Hakediş (chips: `{draft}T {submitted}O {approved}A`, altta `fmtMoney(total_amount)`), Uyarılar
    (chips yalnız > 0 olanlar: `⚠ {late_tasks} gecikme`, `⛔ {unpermitted_parcels} izinsiz`,
    `🎓 {expiring_certs} sertifika`, `📦 {open_requests} talep`)
  - Hücre bağlantıları: her hücre `<Link>` + `onClick={() => setProjectId(row.id)}`
    (hedef: ilerleme→`/is-takibi`, saha→`/saha`, hakediş→`/hakedisler`; uyarı chip'leri→
    `/is-takibi`, `/kamulastirma`, `/isg`, `/depo`). `useProjects()`'ten `setProjectId`.
  - `page-head`: "Portföy" başlığı + `Yenile` düğmesi (`load` yeniden çağırır, Dashboard `error-banner` deseni).
  - Uyarı chip stili: mevcut `badge-amber`/`badge-red` sınıfları (`DECISION_BADGE` kullanımı yok — basit span).

- [ ] **Adım 2: Boş ve uç durumları şartla**

  `projects.length === 0` → tablo yerine `empty` kartı: "Henüz proje yok." +
  `<Link to="/is-takibi">İş Takibi'nden yeni proje oluşturun</Link>` (WorkTracking proje
  CRUD barındırır). `totals.firm_progress` 0'ı normal gösterir (progress bar 0 genişlik).

- [ ] **Adım 3: Route + kenar çubuğu + Dashboard bağlantısı**

  `App.jsx`: `import Portfolyo from './pages/Portfolyo'`; owner routes içine
  `<Route path="/portfoy" element={<Portfolyo />} />`; kenar çubuğunda "Genel Bakış"
  NavLink'inin (138-140) hemen altına `<NavLink to="/portfoy">Portföy</NavLink>` (aynı
  className deseni). **Yalnızca owner dalına** — field/supplier dallarına eklenmez
  (`*` yakalayıcısı onları yönlendirir). `Dashboard.jsx` page-head sağına
  `<Link to="/portfoy" className="btn">Portföy</Link>` ("+ Yeni Malzeme" yanına).

- [ ] **Adım 4: Derleme doğrulaması**

  Run: `npm --prefix client run build`
  Expected: `✓ built` hatasız (JSX hatası derlemeyi kırar — tek güvenilir otomatik kapı).

- [ ] **Adım 5: Commit**

  ```bash
  git add client/src/pages/Portfolyo.jsx client/src/App.jsx client/src/pages/Dashboard.jsx
  git commit -m "feat(portfolio): add /portfoy page with per-project progress, hakedis and warnings"
  ```
