import { Pool, types } from 'pg';
import bcrypt from 'bcryptjs';
import { config } from './config';

// NUMERIC (OID 1700) değerleri string yerine number olarak gelsin (price, quantity, target_price)
types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));

export const pool = new Pool({
  ...config.db,
  max: 10,
  idleTimeoutMillis: 30000,
});

// Uygulama açılışında şemayı garantiye al (idempotent)
export async function initSchema(): Promise<void> {
  await pool.query(`
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

    CREATE INDEX IF NOT EXISTS idx_quotes_material ON quotes(material_id);
    CREATE INDEX IF NOT EXISTS idx_quotes_supplier ON quotes(supplier_id);
    CREATE INDEX IF NOT EXISTS idx_daily_reports_project ON daily_reports(project_id);
    CREATE INDEX IF NOT EXISTS idx_daily_report_crew_report ON daily_report_crew(report_id);
    CREATE INDEX IF NOT EXISTS idx_daily_report_equip_report ON daily_report_equipment(report_id);
    CREATE INDEX IF NOT EXISTS idx_progress_payments_project ON progress_payments(project_id);
    CREATE INDEX IF NOT EXISTS idx_progress_payment_items_payment ON progress_payment_items(payment_id);
  `);
  await seedAdmin();

  // Migrasyon: eski veritabanlarına güzergah kesim alanlarını ekle
  const wgCols = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'work_groups'`
  );
  if (!wgCols.rows.some((r: any) => r.column_name === 'segment_from')) {
    await pool.query('ALTER TABLE work_groups ADD COLUMN segment_from INTEGER');
    await pool.query('ALTER TABLE work_groups ADD COLUMN segment_to INTEGER');
  }

  // Migrasyon: çoklu proje desteği — varsayılan proje + mevcut verileri ona bağla
  const projCount = await pool.query('SELECT COUNT(*)::int AS c FROM projects');
  if (projCount.rows[0].c === 0) {
    await pool.query(`INSERT INTO projects (name) VALUES ('Şantiye 1')`);
  }
  const firstProj = await pool.query('SELECT MIN(id) AS id FROM projects');

  const poleCols = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'poles'`
  );
  if (!poleCols.rows.some((r: any) => r.column_name === 'project_id')) {
    await pool.query('ALTER TABLE poles ADD COLUMN project_id INTEGER');
  }
  await pool.query('UPDATE poles SET project_id = $1 WHERE project_id IS NULL', [firstProj.rows[0].id]);
  await pool.query('ALTER TABLE poles ALTER COLUMN project_id SET NOT NULL');
  try {
    await pool.query(
      'ALTER TABLE poles ADD CONSTRAINT poles_project_fk FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE'
    );
  } catch {
    /* kısıt zaten var */
  }

  if (!wgCols.rows.some((r: any) => r.column_name === 'project_id')) {
    await pool.query('ALTER TABLE work_groups ADD COLUMN project_id INTEGER');
  }
  await pool.query('UPDATE work_groups SET project_id = $1 WHERE project_id IS NULL', [firstProj.rows[0].id]);
  await pool.query('ALTER TABLE work_groups ALTER COLUMN project_id SET NOT NULL');
  try {
    await pool.query(
      'ALTER TABLE work_groups ADD CONSTRAINT work_groups_project_fk FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE'
    );
  } catch {
    /* kısıt zaten var */
  }

  // Eski kmz_meta verisini varsayılan projeye taşı (bir kez)
  try {
    const meta = await pool.query(
      `SELECT key, value FROM kmz_meta WHERE key IN ('route', 'file_name', 'uploaded_at', 'point_total')`
    );
    if (meta.rows.length > 0) {
      const m: Record<string, any> = {};
      for (const r of meta.rows) m[r.key] = r.value;
      const cur = await pool.query('SELECT route FROM projects WHERE id = $1', [firstProj.rows[0].id]);
      if (cur.rows[0].route == null) {
        await pool.query(
          'UPDATE projects SET route = $1, file_name = $2, uploaded_at = $3, point_total = $4 WHERE id = $5',
          [m.route || null, m.file_name || null, m.uploaded_at || null, m.point_total || null, firstProj.rows[0].id]
        );
      }
    }
  } catch {
    /* kmz_meta yoksa önemsiz */
  }

  // Migrasyon: projeler tablosuna tip/kapasite/işveren/sözleşme alanlarını ekle
  const projCols = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'projects'`
  );
  if (!projCols.rows.some((r: any) => r.column_name === 'type')) {
    await pool.query(`ALTER TABLE projects ADD COLUMN type TEXT NOT NULL DEFAULT 'enh'`);
    await pool.query(`ALTER TABLE projects ADD COLUMN capacity TEXT NOT NULL DEFAULT ''`);
    await pool.query(`ALTER TABLE projects ADD COLUMN employer TEXT NOT NULL DEFAULT ''`);
    await pool.query(`ALTER TABLE projects ADD COLUMN contract_no TEXT NOT NULL DEFAULT ''`);
    await pool.query(`ALTER TABLE projects ADD COLUMN start_date TEXT NOT NULL DEFAULT ''`);
    await pool.query(`ALTER TABLE projects ADD COLUMN end_date TEXT NOT NULL DEFAULT ''`);
  }
}

// İlk açılışta hiç kullanıcı yoksa yönetici hesabı oluştur
async function seedAdmin(): Promise<void> {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM users');
  if (rows[0].c > 0) return;
  await pool.query(
    `INSERT INTO users (username, password_hash, role, display_name) VALUES ($1, $2, 'owner', 'Yönetici')`,
    [config.adminUsername, bcrypt.hashSync(config.adminPassword, 10)]
  );
  console.log(`[PTYP] İlk yönetici hesabı oluşturuldu: "${config.adminUsername}"`);
  if (!process.env.PTYP_ADMIN_PASSWORD) {
    console.warn('[PTYP] UYARI: PTYP_ADMIN_PASSWORD .env\'de ayarlı değil — varsayılan şifre kullanılıyor. Giriş yaptıktan sonra değiştirin!');
  }
}
