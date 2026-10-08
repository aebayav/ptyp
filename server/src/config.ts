import dotenv from 'dotenv';
import path from 'path';

// .env dosyası server/ klasöründedir (hem src hem dist'ten bir üst seviye = server/)
dotenv.config({ path: path.join(__dirname, '..', '.env') });

export const config = {
  port: Number(process.env.PORT || 3000),
  db: {
    host: process.env.PGHOST || 'localhost',
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || 'ptyp_app',
    password: process.env.PGPASSWORD || '',
    database: process.env.PGDATABASE || 'ptyp',
  },
};
