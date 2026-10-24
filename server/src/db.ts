import { Pool, types } from 'pg';
import bcrypt from 'bcryptjs';
import { config, isProduction } from './config';
import { runMigrations } from './migrations';
import { initParseJobs } from './parse-jobs';

// NUMERIC (OID 1700) değerleri string yerine number olarak gelsin (price, quantity, target_price)
types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));
// DATE (OID 1082) 'YYYY-MM-DD' metni olarak kalsın: JS Date'e çevrilirse saat dilimi
// kayması olur (ör. 2026-03-02 → 2026-03-01T21:00:00Z) ve istemci karşılaştırmaları bozulur
types.setTypeParser(1082, (v) => v);

export const pool = new Pool({
  ...config.db,
  max: 10,
  idleTimeoutMillis: 30000,
});

// Uygulama açılışında şemayı güncelle: bekleyen numaralı migrasyonlar (bkz. migrations.ts)
export async function initSchema(): Promise<void> {
  await runMigrations(pool);
  initParseJobs(pool); // restart sonrası yarım kalan parse işlerini kapat
  await seedAdmin();
}

// İlk açılışta hiç kullanıcı yoksa yönetici hesabı oluştur
async function seedAdmin(): Promise<void> {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM users');
  if (rows[0].c > 0) return;
  if (!process.env.PTYP_ADMIN_PASSWORD && isProduction) {
    throw new Error(
      'Hiç kullanıcı yok ve PTYP_ADMIN_PASSWORD ayarlı değil. Üretimde varsayılan yönetici şifresiyle hesap oluşturulmaz — server/.env dosyasına PTYP_ADMIN_PASSWORD ekleyin.'
    );
  }
  await pool.query(
    `INSERT INTO users (username, password_hash, role, display_name) VALUES ($1, $2, 'owner', 'Yönetici')`,
    [config.adminUsername, bcrypt.hashSync(config.adminPassword, 10)]
  );
  console.log(`[PTYP] İlk yönetici hesabı oluşturuldu: "${config.adminUsername}"`);
  if (!process.env.PTYP_ADMIN_PASSWORD) {
    console.warn('[PTYP] UYARI: PTYP_ADMIN_PASSWORD .env\'de ayarlı değil — varsayılan şifre kullanılıyor. Giriş yaptıktan sonra değiştirin!');
  }
}
