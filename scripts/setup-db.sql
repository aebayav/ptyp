-- PTYP veritabanı kurulumu
-- postgres süper kullanıcısıyla çalıştırın:
--   psql -U postgres -h localhost -f scripts/setup-db.sql
-- (uygulama şifresini kendinize göre değiştirin; aynısını server/.env'e yazın)

CREATE DATABASE ptyp;
CREATE USER ptyp_app WITH PASSWORD 'DEGISTIRIN';
ALTER DATABASE ptyp OWNER TO ptyp_app;
