#!/bin/bash
set -euo pipefail

# ============================================================
# MySQL 데이터 마이그레이션 스크립트
#
# 1단계 (홈서버에서 실행): 백업 생성
#   ./migrate-db.sh dump
#
# 2단계 (클라우드 서버에서 실행): 복원
#   ./migrate-db.sh restore <dump-file>
# ============================================================

ACTION="${1:-help}"

case "$ACTION" in
  dump)
    echo "========================================="
    echo " MySQL Dump (홈서버에서 실행)"
    echo "========================================="

    SRC_HOST="${DB_HOST:-127.0.0.1}"
    SRC_PORT="${DB_PORT:-3308}"
    SRC_USER="${DB_USER:-toeic}"
    SRC_PASS="${DB_PASS:-toeicpassword}"
    SRC_DB="${DB_NAME:-toeic}"

    TIMESTAMP=$(date +%Y%m%d_%H%M%S)
    DUMP_FILE="toeic_backup_${TIMESTAMP}.sql"

    echo "[dump] Connecting to ${SRC_HOST}:${SRC_PORT}..."
    mysqldump \
      -h "$SRC_HOST" \
      -P "$SRC_PORT" \
      -u "$SRC_USER" \
      -p"$SRC_PASS" \
      --single-transaction \
      --routines \
      --triggers \
      "$SRC_DB" > "$DUMP_FILE"

    echo "[dump] Backup saved: ${DUMP_FILE} ($(du -h "$DUMP_FILE" | cut -f1))"
    echo ""
    echo "다음 단계:"
    echo "  scp ${DUMP_FILE} user@cloud-server:/tmp/"
    echo "  ssh user@cloud-server 'cd /opt/toeic/deploy && ./migrate-db.sh restore /tmp/${DUMP_FILE}'"
    ;;

  restore)
    DUMP_FILE="${2:?Usage: $0 restore <dump-file>}"
    echo "========================================="
    echo " MySQL Restore (클라우드에서 실행)"
    echo "========================================="

    if [ ! -f "$DUMP_FILE" ]; then
      echo "[error] File not found: ${DUMP_FILE}"
      exit 1
    fi

    DST_HOST="${DB_HOST:-127.0.0.1}"
    DST_PORT="${DB_PORT:-3306}"
    DST_USER="${DB_USER:-toeic}"
    DST_DB="${DB_NAME:-toeic}"

    if [ -f "/root/.toeic-db-credentials" ]; then
      source /root/.toeic-db-credentials
      DST_PASS="${DB_PASS}"
    else
      read -sp "[restore] Enter MySQL password for ${DST_USER}: " DST_PASS
      echo ""
    fi

    echo "[restore] Restoring ${DUMP_FILE} → ${DST_DB}..."
    mysql \
      -h "$DST_HOST" \
      -P "$DST_PORT" \
      -u "$DST_USER" \
      -p"$DST_PASS" \
      "$DST_DB" < "$DUMP_FILE"

    echo "[restore] Done! Verifying tables..."
    mysql \
      -h "$DST_HOST" \
      -P "$DST_PORT" \
      -u "$DST_USER" \
      -p"$DST_PASS" \
      -e "USE ${DST_DB}; SHOW TABLES; SELECT COUNT(*) AS user_count FROM users;" 2>/dev/null || true

    echo ""
    echo "[restore] Migration complete!"
    ;;

  *)
    echo "Usage:"
    echo "  $0 dump              홈서버에서 백업 생성"
    echo "  $0 restore <file>    클라우드에서 백업 복원"
    ;;
esac
