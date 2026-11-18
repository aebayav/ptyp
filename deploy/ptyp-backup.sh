#!/usr/bin/env bash
# PTYP günlük yedek: veritabanı (pg_dump, custom format) + uploads/ (KMZ, saha fotoğrafları).
# ptyp-backup.timer her gün 03:00'te çalıştırır; 14 gün saklanır.
set -euo pipefail

cd /home/turguz/ptyp/server
set -a
# shellcheck disable=SC1091
. ./.env
set +a

BACKUP_DIR=/home/turguz/backups
KEEP_DAYS=14
STAMP="$(date +%F_%H%M)"

mkdir -p "$BACKUP_DIR/db" "$BACKUP_DIR/uploads"

# 1) Veritabanı
PGPASSWORD="$PGPASSWORD" pg_dump \
  -U "$PGUSER" -h "$PGHOST" -p "${PGPORT:-5432}" -d "$PGDATABASE" \
  --no-owner -F c -f "$BACKUP_DIR/db/ptyp_${STAMP}.dump"

# 2) Yüklenen dosyalar (üretilen KMZ'ler + saha fotoğrafları)
tar czf "$BACKUP_DIR/uploads/uploads_${STAMP}.tgz" \
  -C /home/turguz/ptyp/server uploads 2>/dev/null || true

# 3) Eski yedekleri temizle
find "$BACKUP_DIR/db" -name '*.dump' -mtime +"$KEEP_DAYS" -delete
find "$BACKUP_DIR/uploads" -name '*.tgz' -mtime +"$KEEP_DAYS" -delete

echo "$(date '+%F %T') PTYP yedek tamam: db + uploads → $BACKUP_DIR"
