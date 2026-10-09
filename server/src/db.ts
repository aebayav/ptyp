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

    CREATE INDEX IF NOT EXISTS idx_quotes_material ON quotes(material_id);
    CREATE INDEX IF NOT EXISTS idx_quotes_supplier ON quotes(supplier_id);
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
