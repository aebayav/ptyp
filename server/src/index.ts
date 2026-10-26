import express, { NextFunction, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { initSchema } from './db';
import { config, validateConfig } from './config';
import { applySecurity, publicLimiter } from './security';
import authRouter from './routes/auth';
import usersRouter from './routes/users';
import quoteUploadRouter from './routes/quote-upload';
import materialsRouter from './routes/materials';
import suppliersRouter from './routes/suppliers';
import quotesRouter from './routes/quotes';
import workgroupsRouter from './routes/workgroups';
import tasksRouter from './routes/tasks';
import polesRouter from './routes/poles';
import projectsRouter from './routes/projects';
import exportRouter from './routes/export';
import overviewRouter from './routes/overview';
import progressPaymentsRouter from './routes/progress-payments';
import dailyReportsRouter from './routes/daily-reports';
import kmzGeneratorRouter from './routes/kmz-generator';
import kesifRouter from './routes/kesif';
import sahaRouter from './routes/saha';
import parcelsRouter from './routes/parcels';
import stockRouter from './routes/stock';
import planningRouter from './routes/planning';
import fiyatFarkiRouter from './routes/fiyat-farki';

validateConfig(); // üretimde güvensiz varsayılanlarla açılmayı reddeder
const app = express();
applySecurity(app);
app.use(express.json());

// ---------- Açık uç (giriş gerektirmez) ----------
app.use('/api/auth', authRouter);
app.use('/api/public', publicLimiter, quoteUploadRouter); // satıcı teklif dosyası yükleme (herkese açık, IP başına sınırlı)

// ---------- Buradan sonrası kimlik doğrulama ister (route dosyalarında requireAuth) ----------
app.use('/api/users', usersRouter);
app.use('/api/materials', materialsRouter);
app.use('/api/suppliers', suppliersRouter);
app.use('/api/quotes', quotesRouter);
app.use('/api/workgroups', workgroupsRouter);
app.use('/api/tasks', tasksRouter);
app.use('/api/poles', polesRouter);
app.use('/api/projects', projectsRouter);
app.use('/api/export', exportRouter);
app.use('/api/progress-payments', progressPaymentsRouter);
app.use('/api/daily-reports', dailyReportsRouter);
app.use('/api/kmz-generator', kmzGeneratorRouter);
app.use('/api/kesif', kesifRouter);
app.use('/api/saha', sahaRouter);
app.use('/api/parcels', parcelsRouter);
app.use('/api/stock', stockRouter);
app.use('/api/planning', planningRouter);
app.use('/api/fiyat-farki', fiyatFarkiRouter);
app.use('/api', overviewRouter);

// ---------- İstemci (build edilmiş SPA) ----------
const dist = path.join(__dirname, '..', '..', 'client', 'dist');
if (fs.existsSync(dist)) {
  // index.html önbelleğe alınmasın (yeni bundle'lar anında görünsün);
  // hash'li asset'ler uzun ömürlü cache'lenebilir
  app.use(
    express.static(dist, {
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
        else res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      },
    })
  );
  // SPA fallback: API dışı GET isteklerinde index.html döndür
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(dist, 'index.html'));
  });
}

// ---------- 404 ----------
app.use((_req, res) => {
  res.status(404).json({ error: 'İstenen kaynak bulunamadı.' });
});

// ---------- Hata yakalama (Türkçe, açıklayıcı) ----------
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use(
  (
    err: Error & { code?: string; name?: string; status?: number },
    _req: Request,
    res: Response,
    _next: NextFunction
  ) => {
    if (err && err.name === 'MulterError') {
      return res.status(400).json({ error: 'Dosya yükleme hatası: dosya çok büyük olabilir (en fazla 10 MB).' });
    }
    if (err && err.code === '23505') {
      return res.status(400).json({ error: 'Bu kayıt zaten mevcut (benzersiz alan çakışması).' });
    }
    // 4xx hatalar (ör. InvalidDateError) kullanıcıya olduğu gibi iletilir
    if (err && err.status && err.status >= 400 && err.status < 500) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error('[PTYP hata]', err.message);
    res.status(500).json({ error: 'Sunucuda beklenmeyen bir hata oluştu: ' + err.message });
  }
);

function lanIPs(): string[] {
  const ips: string[] = [];
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const net of nets || []) {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
    }
  }
  return ips;
}

// Kütüphane içi (örn. pdf-parse) stray rejection'larının sunucuyu
// çökertmemesi için global koruma
process.on('unhandledRejection', (reason) => {
  console.error('Unexpected rejection:', reason instanceof Error ? reason.message : reason);
});

initSchema()
  .then(() => {
    app.listen(config.port, '0.0.0.0', () => {
      console.log('');
      console.log('  ⚡ PTYP — Elektrik Nakil Hattı & Trafo Merkezi Proje Yönetim Sistemi');
      console.log('  ------------------------------------------------------------');
      console.log(`  Yerel : http://localhost:${config.port}`);
      for (const ip of lanIPs()) console.log(`  Ağ    : http://${ip}:${config.port}`);
      console.log('');
    });
  })
  .catch((e) => {
    console.error('Veritabanına bağlanılamadı / şema oluşturulamadı:', e.message);
    console.error('Bağlantı ayarlarını server/.env dosyasından kontrol edin.');
    process.exit(1);
  });
