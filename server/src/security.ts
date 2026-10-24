import type { Express, Request } from 'express';
import helmet from 'helmet';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { config } from './config';

/**
 * Temel HTTP güvenlik katmanı: güvenlik başlıkları + kaba kuvvet / kötüye kullanım sınırları.
 */
export function applySecurity(app: Express): void {
  // Proxy arkasında req.ip'nin gerçek istemci IP'si olması için (rate-limit anahtarı)
  if (config.trustProxy) {
    const n = Number(config.trustProxy);
    app.set('trust proxy', Number.isFinite(n) ? n : config.trustProxy);
  }
  app.disable('x-powered-by');

  app.use(
    helmet({
      // CSP kapalı: harita karoları (OSM/uydu), QR görselleri ve satır içi stiller
      // farklı kaynaklardan yükleniyor; yanlış bir CSP arayüzü sessizce bozar.
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
      // HSTS yalnızca HTTPS sonlandıran proxy'de ayarlanmalı (LAN'da http kullanılıyor)
      strictTransportSecurity: false,
    })
  );
}

const tooMany = (msg: string) => ({ error: msg });

/** Giriş denemeleri: IP + kullanıcı adı başına; başarılı girişler sayılmaz. */
export const loginLimiter = rateLimit({
  windowMs: config.loginRateWindowMin * 60 * 1000,
  limit: config.loginRateMax,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req: Request) => {
    const user = String(req.body?.username || '').trim().toLowerCase();
    return `${ipKeyGenerator(req.ip || '')}|${user}`;
  },
  message: tooMany(
    `Çok fazla başarısız giriş denemesi. Lütfen ${config.loginRateWindowMin} dakika sonra tekrar deneyin.`
  ),
});

/** Halka açık uçlar (satıcı teklif yükleme): IP başına. */
export const publicLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: tooMany('Çok fazla istek gönderildi. Lütfen biraz sonra tekrar deneyin.'),
});
