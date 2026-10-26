// Numaralı şema migrasyonları.
//
// Kurallar:
//  - Her migrasyon BİR KEZ çalışır ve `schema_migrations` tablosuna kaydedilir.
//  - Uygulanmış bir migrasyonu ASLA değiştirmeyin; yeni değişiklik = yeni numara (listenin sonuna).
//  - Her migrasyon kendi transaction'ı içinde koşar: hata olursa o adım tamamen geri alınır.
//  - Aynı anda iki sunucu süreci açılırsa advisory lock sayesinde yalnızca biri migrasyon yapar.
import type { PoolClient } from 'pg';

export interface Migration {
  id: number;
  name: string;
  up: (c: PoolClient) => Promise<void>;
}

async function columns(c: PoolClient, table: string): Promise<Set<string>> {
  const r = await c.query(`SELECT column_name FROM information_schema.columns WHERE table_name = $1`, [table]);
  return new Set(r.rows.map((x: any) => x.column_name));
}

async function constraintExists(c: PoolClient, name: string): Promise<boolean> {
  const r = await c.query(`SELECT 1 FROM pg_constraint WHERE conname = $1`, [name]);
  return (r.rowCount ?? 0) > 0;
}

export const MIGRATIONS: Migration[] = [
  {
    // Migrasyon sistemi öncesindeki tüm şema + elle yazılmış eski migrasyonlar.
    // Tamamen idempotent: mevcut (eski) veritabanlarında güvenle çalışır.
    id: 1,
    name: 'baseline',
    up: async (c) => {
      await c.query(`
        CREATE TABLE IF NOT EXISTS materials (
          id            SERIAL PRIMARY KEY,
          code          TEXT NOT NULL UNIQUE,
          name          TEXT NOT NULL,
          category      TEXT NOT NULL DEFAULT '',
          spec          TEXT NOT NULL DEFAULT '',
          unit          TEXT NOT NULL DEFAULT 'adet',
          quantity      NUMERIC(12,2) NOT NULL DEFAULT 1,
          target_price  NUMERIC(14,2),
          status        TEXT NOT NULL DEFAULT 'open',
          notes         TEXT NOT NULL DEFAULT '',
          created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE TABLE IF NOT EXISTS suppliers (
          id            SERIAL PRIMARY KEY,
          name          TEXT NOT NULL,
          contact_name  TEXT NOT NULL DEFAULT '',
          phone         TEXT NOT NULL DEFAULT '',
          email         TEXT NOT NULL DEFAULT '',
          address       TEXT NOT NULL DEFAULT '',
          notes         TEXT NOT NULL DEFAULT '',
          created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE TABLE IF NOT EXISTS quotes (
          id            SERIAL PRIMARY KEY,
          material_id   INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
          supplier_id   INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
          price         NUMERIC(14,2) NOT NULL,
          currency      TEXT NOT NULL DEFAULT 'TRY',
          delivery_days INTEGER,
          validity_date TEXT NOT NULL DEFAULT '',
          status        TEXT NOT NULL DEFAULT 'received',
          notes         TEXT NOT NULL DEFAULT '',
          created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE TABLE IF NOT EXISTS projects (
          id          SERIAL PRIMARY KEY,
          name        TEXT NOT NULL,
          type        TEXT NOT NULL DEFAULT 'enh',
          capacity    TEXT NOT NULL DEFAULT '',
          employer    TEXT NOT NULL DEFAULT '',
          contract_no TEXT NOT NULL DEFAULT '',
          start_date  TEXT NOT NULL DEFAULT '',
          end_date    TEXT NOT NULL DEFAULT '',
          route       JSONB,
          file_name   TEXT,
          uploaded_at TEXT,
          point_total INTEGER,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE TABLE IF NOT EXISTS users (
          id            SERIAL PRIMARY KEY,
          username      TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          role          TEXT NOT NULL DEFAULT 'owner',
          display_name  TEXT NOT NULL DEFAULT '',
          supplier_id   INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE TABLE IF NOT EXISTS work_groups (
          id            SERIAL PRIMARY KEY,
          code          TEXT NOT NULL UNIQUE,
          name          TEXT NOT NULL,
          weight        NUMERIC(5,2) NOT NULL DEFAULT 0,
          progress      NUMERIC(5,2) NOT NULL DEFAULT 0,
          planned_start TEXT NOT NULL DEFAULT '',
          planned_end   TEXT NOT NULL DEFAULT '',
          status        TEXT NOT NULL DEFAULT 'pending',
          notes         TEXT NOT NULL DEFAULT '',
          segment_from  INTEGER,
          segment_to    INTEGER,
          project_id    INTEGER REFERENCES projects(id) ON DELETE CASCADE,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE TABLE IF NOT EXISTS tasks (
          id            SERIAL PRIMARY KEY,
          work_group_id INTEGER NOT NULL REFERENCES work_groups(id) ON DELETE CASCADE,
          title         TEXT NOT NULL,
          description   TEXT NOT NULL DEFAULT '',
          assignee_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
          due_date      TEXT NOT NULL DEFAULT '',
          status        TEXT NOT NULL DEFAULT 'todo',
          priority      TEXT NOT NULL DEFAULT 'normal',
          created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE INDEX IF NOT EXISTS idx_tasks_group ON tasks(work_group_id);
        CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id);

        CREATE TABLE IF NOT EXISTS poles (
          id    SERIAL PRIMARY KEY,
          name  TEXT NOT NULL DEFAULT '',
          lat   DOUBLE PRECISION NOT NULL,
          lon   DOUBLE PRECISION NOT NULL,
          alt   DOUBLE PRECISION,
          idx   INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS kmz_meta (
          key   TEXT PRIMARY KEY,
          value JSONB NOT NULL
        );

        CREATE TABLE IF NOT EXISTS daily_reports (
          id            SERIAL PRIMARY KEY,
          project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          report_date   DATE NOT NULL,
          weather       TEXT NOT NULL DEFAULT '',
          temperature   NUMERIC(4,1),
          work_summary  TEXT NOT NULL DEFAULT '',
          issues        TEXT NOT NULL DEFAULT '',
          created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE(project_id, report_date)
        );

        CREATE TABLE IF NOT EXISTS daily_report_crew (
          id          SERIAL PRIMARY KEY,
          report_id   INTEGER NOT NULL REFERENCES daily_reports(id) ON DELETE CASCADE,
          role        TEXT NOT NULL,
          company     TEXT NOT NULL DEFAULT '',
          count       INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS daily_report_equipment (
          id              SERIAL PRIMARY KEY,
          report_id       INTEGER NOT NULL REFERENCES daily_reports(id) ON DELETE CASCADE,
          equipment_type  TEXT NOT NULL,
          description     TEXT NOT NULL DEFAULT '',
          count           INTEGER NOT NULL DEFAULT 1
        );

        CREATE TABLE IF NOT EXISTS progress_payments (
          id            SERIAL PRIMARY KEY,
          project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          period_no     INTEGER NOT NULL,
          period_label  TEXT NOT NULL,
          status        TEXT NOT NULL DEFAULT 'draft',
          submitted_at  TIMESTAMPTZ,
          approved_at   TIMESTAMPTZ,
          notes         TEXT NOT NULL DEFAULT '',
          created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE TABLE IF NOT EXISTS progress_payment_items (
          id              SERIAL PRIMARY KEY,
          payment_id      INTEGER NOT NULL REFERENCES progress_payments(id) ON DELETE CASCADE,
          work_group_id   INTEGER REFERENCES work_groups(id) ON DELETE SET NULL,
          item_name       TEXT NOT NULL,
          unit            TEXT NOT NULL DEFAULT 'adet',
          contract_qty    NUMERIC(12,2) NOT NULL DEFAULT 0,
          previous_qty    NUMERIC(12,2) NOT NULL DEFAULT 0,
          current_qty     NUMERIC(12,2) NOT NULL DEFAULT 0,
          unit_price      NUMERIC(14,2) NOT NULL DEFAULT 0,
          notes           TEXT NOT NULL DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS project_dtl (
          project_id  INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
          header      JSONB NOT NULL DEFAULT '{}',
          rows        JSONB NOT NULL DEFAULT '[]',
          file_name   TEXT,
          source      TEXT,
          updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE TABLE IF NOT EXISTS pole_status (
          id          SERIAL PRIMARY KEY,
          project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          pole_idx    INTEGER NOT NULL,
          status      TEXT NOT NULL DEFAULT 'none',
          note        TEXT NOT NULL DEFAULT '',
          updated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
          updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE(project_id, pole_idx)
        );

        CREATE TABLE IF NOT EXISTS pole_photos (
          id           SERIAL PRIMARY KEY,
          project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          pole_idx     INTEGER NOT NULL,
          filename     TEXT NOT NULL,
          caption      TEXT NOT NULL DEFAULT '',
          uploaded_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE TABLE IF NOT EXISTS saha_requests (
          id            SERIAL PRIMARY KEY,
          project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          item_name     TEXT NOT NULL,
          qty           NUMERIC(12,2) NOT NULL DEFAULT 1,
          unit          TEXT NOT NULL DEFAULT 'adet',
          pole_ref      TEXT NOT NULL DEFAULT '',
          needed_by     TEXT NOT NULL DEFAULT '',
          note          TEXT NOT NULL DEFAULT '',
          status        TEXT NOT NULL DEFAULT 'open',
          requested_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
          fulfilled_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
          fulfilled_at  TIMESTAMPTZ
        );

        CREATE TABLE IF NOT EXISTS kesif_items (
          id          SERIAL PRIMARY KEY,
          project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          position    INTEGER NOT NULL,
          item_name   TEXT NOT NULL,
          unit        TEXT NOT NULL DEFAULT 'adet',
          qty         NUMERIC(14,3) NOT NULL DEFAULT 0,
          unit_price  NUMERIC(14,2) NOT NULL DEFAULT 0,
          notes       TEXT NOT NULL DEFAULT '',
          updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE INDEX IF NOT EXISTS idx_quotes_material ON quotes(material_id);
        CREATE INDEX IF NOT EXISTS idx_quotes_supplier ON quotes(supplier_id);
        CREATE INDEX IF NOT EXISTS idx_daily_reports_project ON daily_reports(project_id);
        CREATE INDEX IF NOT EXISTS idx_daily_report_crew_report ON daily_report_crew(report_id);
        CREATE INDEX IF NOT EXISTS idx_daily_report_equip_report ON daily_report_equipment(report_id);
        CREATE INDEX IF NOT EXISTS idx_progress_payments_project ON progress_payments(project_id);
        CREATE INDEX IF NOT EXISTS idx_progress_payment_items_payment ON progress_payment_items(payment_id);
        CREATE INDEX IF NOT EXISTS idx_kesif_items_project ON kesif_items(project_id);
        CREATE INDEX IF NOT EXISTS idx_pole_photos_pole ON pole_photos(project_id, pole_idx);
      `);

      // Eski veritabanları: güzergah kesim alanları
      const wgCols = await columns(c, 'work_groups');
      if (!wgCols.has('segment_from')) {
        await c.query('ALTER TABLE work_groups ADD COLUMN segment_from INTEGER');
        await c.query('ALTER TABLE work_groups ADD COLUMN segment_to INTEGER');
      }

      // Çoklu proje desteği — varsayılan proje + mevcut verileri ona bağla
      const projCount = await c.query('SELECT COUNT(*)::int AS c FROM projects');
      if (projCount.rows[0].c === 0) {
        await c.query(`INSERT INTO projects (name) VALUES ('Şantiye 1')`);
      }
      const firstProjId = (await c.query('SELECT MIN(id) AS id FROM projects')).rows[0].id;

      const poleCols = await columns(c, 'poles');
      if (!poleCols.has('project_id')) await c.query('ALTER TABLE poles ADD COLUMN project_id INTEGER');
      if (!poleCols.has('meta')) await c.query('ALTER TABLE poles ADD COLUMN meta JSONB');
      await c.query('UPDATE poles SET project_id = $1 WHERE project_id IS NULL', [firstProjId]);
      await c.query('ALTER TABLE poles ALTER COLUMN project_id SET NOT NULL');
      if (!(await constraintExists(c, 'poles_project_fk'))) {
        await c.query(
          'ALTER TABLE poles ADD CONSTRAINT poles_project_fk FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE'
        );
      }

      if (!wgCols.has('project_id')) await c.query('ALTER TABLE work_groups ADD COLUMN project_id INTEGER');
      await c.query('UPDATE work_groups SET project_id = $1 WHERE project_id IS NULL', [firstProjId]);
      await c.query('ALTER TABLE work_groups ALTER COLUMN project_id SET NOT NULL');
      if (!(await constraintExists(c, 'work_groups_project_fk'))) {
        await c.query(
          'ALTER TABLE work_groups ADD CONSTRAINT work_groups_project_fk FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE'
        );
      }

      // Eski kmz_meta verisini varsayılan projeye taşı
      const meta = await c.query(
        `SELECT key, value FROM kmz_meta WHERE key IN ('route', 'file_name', 'uploaded_at', 'point_total')`
      );
      if (meta.rows.length > 0) {
        const m: Record<string, any> = {};
        for (const r of meta.rows) m[r.key] = r.value;
        const cur = await c.query('SELECT route FROM projects WHERE id = $1', [firstProjId]);
        if (cur.rows[0].route == null) {
          await c.query(
            'UPDATE projects SET route = $1, file_name = $2, uploaded_at = $3, point_total = $4 WHERE id = $5',
            [m.route || null, m.file_name || null, m.uploaded_at || null, m.point_total || null, firstProjId]
          );
        }
      }

      // Projeler: tip/kapasite/işveren/sözleşme alanları
      const projCols = await columns(c, 'projects');
      if (!projCols.has('type')) {
        await c.query(`ALTER TABLE projects ADD COLUMN type TEXT NOT NULL DEFAULT 'enh'`);
        await c.query(`ALTER TABLE projects ADD COLUMN capacity TEXT NOT NULL DEFAULT ''`);
        await c.query(`ALTER TABLE projects ADD COLUMN employer TEXT NOT NULL DEFAULT ''`);
        await c.query(`ALTER TABLE projects ADD COLUMN contract_no TEXT NOT NULL DEFAULT ''`);
        await c.query(`ALTER TABLE projects ADD COLUMN start_date TEXT NOT NULL DEFAULT ''`);
        await c.query(`ALTER TABLE projects ADD COLUMN end_date TEXT NOT NULL DEFAULT ''`);
      }
      // Referans hizalama (yerel şantiye gridi ofseti, derece cinsinden)
      if (!projCols.has('grid_dlat')) {
        await c.query(`ALTER TABLE projects ADD COLUMN grid_dlat DOUBLE PRECISION NOT NULL DEFAULT 0`);
        await c.query(`ALTER TABLE projects ADD COLUMN grid_dlon DOUBLE PRECISION NOT NULL DEFAULT 0`);
      }
    },
  },

  {
    // Metin olarak tutulan tarih alanlarını gerçek DATE tipine çevirir.
    // Boş metin → NULL. 'YYYY-MM-DD' ve 'GG.AA.YYYY' biçimleri dönüştürülür;
    // dönüştürülemeyen değerler kaybolmasın diye önce `migration_date_backup` tablosuna yedeklenir.
    id: 2,
    name: 'text-dates-to-date',
    up: async (c) => {
      await c.query(`
        CREATE OR REPLACE FUNCTION ptyp_try_date(v TEXT) RETURNS DATE AS $$
        BEGIN
          v := btrim(coalesce(v, ''));
          IF v = '' THEN RETURN NULL; END IF;
          IF v ~ '^\\d{4}-\\d{2}-\\d{2}' THEN
            RETURN substr(v, 1, 10)::date;
          ELSIF v ~ '^\\d{1,2}[./]\\d{1,2}[./]\\d{4}$' THEN
            RETURN to_date(replace(v, '/', '.'), 'DD.MM.YYYY');
          END IF;
          RETURN NULL;
        EXCEPTION WHEN others THEN
          RETURN NULL;
        END;
        $$ LANGUAGE plpgsql IMMUTABLE;

        CREATE TABLE IF NOT EXISTS migration_date_backup (
          table_name  TEXT NOT NULL,
          row_id      INTEGER NOT NULL,
          column_name TEXT NOT NULL,
          old_value   TEXT NOT NULL,
          backed_up_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);

      const targets: [string, string][] = [
        ['projects', 'start_date'],
        ['projects', 'end_date'],
        ['work_groups', 'planned_start'],
        ['work_groups', 'planned_end'],
        ['tasks', 'due_date'],
        ['quotes', 'validity_date'],
        ['saha_requests', 'needed_by'],
      ];
      for (const [table, col] of targets) {
        const type = await c.query(
          `SELECT data_type FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
          [table, col]
        );
        if (type.rows[0]?.data_type !== 'text') continue; // zaten dönüştürülmüş / yok
        // Dönüştürülemeyecek (boş olmayan) değerleri yedekle
        await c.query(
          `INSERT INTO migration_date_backup (table_name, row_id, column_name, old_value)
           SELECT $1, id, $2, ${col} FROM ${table}
           WHERE btrim(coalesce(${col}, '')) <> '' AND ptyp_try_date(${col}) IS NULL`,
          [table, col]
        );
        await c.query(`ALTER TABLE ${table} ALTER COLUMN ${col} DROP DEFAULT`);
        await c.query(`ALTER TABLE ${table} ALTER COLUMN ${col} DROP NOT NULL`);
        await c.query(`ALTER TABLE ${table} ALTER COLUMN ${col} TYPE DATE USING ptyp_try_date(${col})`);
      }

      await c.query(`CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_date) WHERE status <> 'done'`);
    },
  },

  {
    // Belge → KMZ ayrıştırma işleri: sunucu yeniden başlasa da kaybolmasın
    id: 3,
    name: 'parse-jobs',
    up: async (c) => {
      await c.query(`
        CREATE TABLE IF NOT EXISTS parse_jobs (
          id           UUID PRIMARY KEY,
          kind         TEXT NOT NULL DEFAULT 'kmz-parse',
          status       TEXT NOT NULL DEFAULT 'queued',
          progress     TEXT NOT NULL DEFAULT '',
          file_name    TEXT,
          file_path    TEXT,
          params       JSONB NOT NULL DEFAULT '{}',
          result       JSONB,
          error        TEXT,
          attempts     INTEGER NOT NULL DEFAULT 0,
          created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
          started_at   TIMESTAMPTZ,
          finished_at  TIMESTAMPTZ
        );
        CREATE INDEX IF NOT EXISTS idx_parse_jobs_status ON parse_jobs(status);
      `);
    },
  },

  {
    // Kamulaştırma / arazi takibi: açıklık (direk arası) bazında parsel kayıtları.
    // pole_from/pole_to, poles tablosunun idx alanına bakar (yeniden işlemede değişmez).
    id: 4,
    name: 'parcels',
    up: async (c) => {
      await c.query(`
        CREATE TABLE IF NOT EXISTS parcels (
          id              SERIAL PRIMARY KEY,
          project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          pole_from_idx   INTEGER NOT NULL,
          pole_to_idx     INTEGER NOT NULL,
          parcel_no       TEXT NOT NULL DEFAULT '',
          owner_name      TEXT NOT NULL DEFAULT '',
          easement_status TEXT NOT NULL DEFAULT 'belirsiz',
          legal_status    TEXT NOT NULL DEFAULT 'yok',
          price           NUMERIC(14,2),
          notes           TEXT NOT NULL DEFAULT '',
          created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS idx_parcels_project ON parcels(project_id);
      `);
    },
  },

  {
    // Depo & stok: irsaliye ile giriş, şantiyeye sevk, sarfiyat; kalan stok =
    // giriş − (sevk + sarfiyat). Saha talepleri sevk kaydına bağlanabilir.
    id: 5,
    name: 'stock-movements',
    up: async (c) => {
      await c.query(`
        CREATE TABLE IF NOT EXISTS stock_movements (
          id              SERIAL PRIMARY KEY,
          project_id      INTEGER REFERENCES projects(id) ON DELETE CASCADE,
          material_id     INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
          movement_type   TEXT NOT NULL DEFAULT 'giris',
          qty             NUMERIC(14,3) NOT NULL DEFAULT 0,
          unit            TEXT NOT NULL DEFAULT 'adet',
          irsaliye_no     TEXT NOT NULL DEFAULT '',
          supplier_id     INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
          saha_request_id INTEGER REFERENCES saha_requests(id) ON DELETE SET NULL,
          note            TEXT NOT NULL DEFAULT '',
          created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS idx_stock_movements_material ON stock_movements(material_id);
        CREATE INDEX IF NOT EXISTS idx_stock_movements_project ON stock_movements(project_id);
      `);
    },
  },

  {
    // Hakediş fiyat farkı: TÜİK endeks değerleri (aylık) + Pn hesabı.
    id: 6,
    name: 'price-indices',
    up: async (c) => {
      await c.query(`
        CREATE TABLE IF NOT EXISTS price_indices (
          id          SERIAL PRIMARY KEY,
          project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          period      TEXT NOT NULL,
          index_name  TEXT NOT NULL DEFAULT 'TUFE',
          value       NUMERIC(14,4) NOT NULL,
          notes       TEXT NOT NULL DEFAULT '',
          created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE(project_id, period, index_name)
        );
        CREATE INDEX IF NOT EXISTS idx_price_indices_project ON price_indices(project_id);
      `);
    },
  },
];

/** Bekleyen migrasyonları sırayla uygular. */
export async function runMigrations(pool: import('pg').Pool): Promise<void> {
  const c = await pool.connect();
  try {
    // Aynı anda açılan ikinci süreç burada bekler
    await c.query(`SELECT pg_advisory_lock(hashtext('ptyp_schema_migrations'))`);
    await c.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id         INTEGER PRIMARY KEY,
        name       TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    const done = new Set(
      (await c.query('SELECT id FROM schema_migrations')).rows.map((r: any) => Number(r.id))
    );
    const ids = MIGRATIONS.map((m) => m.id);
    if (new Set(ids).size !== ids.length) throw new Error('Migrasyon numaraları benzersiz olmalı.');

    for (const m of [...MIGRATIONS].sort((a, b) => a.id - b.id)) {
      if (done.has(m.id)) continue;
      const t0 = Date.now();
      await c.query('BEGIN');
      try {
        await m.up(c);
        await c.query('INSERT INTO schema_migrations (id, name) VALUES ($1, $2)', [m.id, m.name]);
        await c.query('COMMIT');
        console.log(`[PTYP] Migrasyon #${m.id} (${m.name}) uygulandı — ${Date.now() - t0} ms`);
      } catch (e: any) {
        await c.query('ROLLBACK');
        throw new Error(`Migrasyon #${m.id} (${m.name}) başarısız: ${e.message}`);
      }
    }
  } finally {
    await c.query(`SELECT pg_advisory_unlock(hashtext('ptyp_schema_migrations'))`).catch(() => {});
    c.release();
  }
}
