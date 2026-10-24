import dotenv from 'dotenv';
import path from 'path';

// .env dosyası server/ klasöründedir (hem src hem dist'ten bir üst seviye = server/)
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// Geliştirme ortamı için bilinen (güvensiz) varsayılanlar — üretimde KULLANILAMAZ
export const DEV_JWT_SECRET = 'ptyp-dev-gizli-anahtar-degistirin';
export const DEV_ADMIN_PASSWORD = 'admin123';

export const isProduction = process.env.NODE_ENV === 'production';

export const config = {
  port: Number(process.env.PORT || 3000),
  db: {
    host: process.env.PGHOST || 'localhost',
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || 'ptyp_app',
    password: process.env.PGPASSWORD || '',
    database: process.env.PGDATABASE || 'ptyp',
  },
  jwtSecret: process.env.JWT_SECRET || DEV_JWT_SECRET,
  jwtExpires: process.env.JWT_EXPIRES || '12h',
  adminUsername: process.env.PTYP_ADMIN_USERNAME || 'admin',
  adminPassword: process.env.PTYP_ADMIN_PASSWORD || DEV_ADMIN_PASSWORD,
  // Giriş denemesi sınırı: pencere (dk) başına IP+kullanıcı adı için en fazla deneme
  loginRateWindowMin: Number(process.env.LOGIN_RATE_WINDOW_MIN || 15),
  loginRateMax: Number(process.env.LOGIN_RATE_MAX || 10),
  // Reverse proxy (nginx / panel) arkasında gerçek istemci IP'si için
  trustProxy: process.env.TRUST_PROXY ?? (isProduction ? '1' : ''),
};

/**
 * Güvenlik açısından kritik ayarları doğrular.
 * Üretimde (NODE_ENV=production) güvensiz varsayılanlarla açılışı REDDEDER;
 * geliştirmede yalnızca uyarı basar.
 */
export function validateConfig(): void {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!process.env.JWT_SECRET || process.env.JWT_SECRET === DEV_JWT_SECRET) {
    (isProduction ? errors : warnings).push(
      'JWT_SECRET ayarlı değil veya varsayılan değerde. Rastgele uzun bir değer üretin: ' +
        `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
    );
  } else if (process.env.JWT_SECRET.length < 32) {
    warnings.push('JWT_SECRET 32 karakterden kısa — daha uzun rastgele bir değer önerilir.');
  }

  if (process.env.PTYP_ADMIN_PASSWORD === DEV_ADMIN_PASSWORD) {
    warnings.push('PTYP_ADMIN_PASSWORD varsayılan değerde (admin123). Değiştirin.');
  }

  for (const w of warnings) console.warn('[PTYP] UYARI: ' + w);
  if (errors.length > 0) {
    for (const e of errors) console.error('[PTYP] HATA: ' + e);
    console.error('[PTYP] Üretim ortamında güvensiz ayarlarla başlatılmıyor. server/.env dosyasını düzeltin.');
    process.exit(1);
  }
}
