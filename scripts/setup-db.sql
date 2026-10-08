-- PTYP veritabanı kurulumu (idempotent — güvenle tekrar çalıştırılabilir)
--
-- Ubuntu:   sudo -u postgres psql -f setup-db.sql
-- Windows:  "C:\Users\abaya\PostgreSQL\bin\psql.exe" -U postgres -h localhost -f scripts\setup-db.sql
--
-- Çalıştırmadan önce aşağıdaki 'DEGISTIRIN' şifresini kendi belirlediğinizle değiştirin;
-- aynı şifreyi server/.env dosyasındaki PGPASSWORD alanına yazın.

-- 1) Uygulama kullanıcısı (yoksa oluştur)
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ptyp_app') THEN
    CREATE USER ptyp_app WITH PASSWORD 'DEGISTIRIN';
  END IF;
END $$;

-- 2) Veritabanı (yoksa oluştur, sahibi ptyp_app)
SELECT 'CREATE DATABASE ptyp OWNER ptyp_app'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'ptyp')\gexec

-- 3) Sahipliği garantiye al
ALTER DATABASE ptyp OWNER TO ptyp_app;
