#!/bin/bash
set -euo pipefail

# ============================================================
# TOEIC API 배포 스크립트
# 클라우드 서버에서 실행
#
# 사용법:
#   첫 배포:  ./deploy.sh
#   재배포:   ./deploy.sh
# ============================================================

APP_DIR="/opt/toeic"
API_DIR="${APP_DIR}/api"

echo "========================================="
echo " TOEIC API Deploy"
echo "========================================="

# ── 디렉토리 확인 ──
if [ ! -d "${API_DIR}" ]; then
  echo "[error] ${API_DIR} not found."
  echo "먼저 코드를 ${APP_DIR}에 업로드하세요:"
  echo "  scp -r . user@server:${APP_DIR}/"
  echo "  또는"
  echo "  git clone <repo> ${APP_DIR}"
  exit 1
fi

cd "${APP_DIR}"

# ── .env 확인 ──
if [ ! -f "${API_DIR}/.env" ]; then
  if [ -f "${API_DIR}/.env.production" ]; then
    echo "[env] .env not found, copying from .env.production template..."
    cp "${API_DIR}/.env.production" "${API_DIR}/.env"
    echo "[env] .env.production → .env 복사 완료"
    echo "[env] !!! ${API_DIR}/.env 파일의 __CHANGE_ME__ 값을 반드시 변경하세요 !!!"

    if [ -f "/root/.toeic-db-credentials" ]; then
      source /root/.toeic-db-credentials
      sed -i "s|DB_PASS=__CHANGE_ME__|DB_PASS=${DB_PASS}|" "${API_DIR}/.env"
      echo "[env] DB_PASS를 자동으로 설정했습니다"
    fi

    JWT=$(openssl rand -base64 32)
    sed -i "s|JWT_SECRET=__CHANGE_ME__|JWT_SECRET=${JWT}|" "${API_DIR}/.env"
    echo "[env] JWT_SECRET을 자동 생성했습니다"
  else
    echo "[error] .env 파일이 없습니다. api/.env.production을 참고하여 생성하세요."
    exit 1
  fi
fi

# ── 의존성 설치 ──
echo "[deploy] Installing dependencies..."
cd "${API_DIR}"
npm ci --production=false

# ── TypeScript 빌드 ──
echo "[deploy] Building TypeScript..."
npm run build

# ── PM2 시작/리로드 ──
cd "${APP_DIR}"
if pm2 list | grep -q "toeic-api"; then
  echo "[deploy] Reloading PM2 (zero-downtime)..."
  pm2 reload ecosystem.config.js
else
  echo "[deploy] Starting PM2..."
  pm2 start ecosystem.config.js
fi

# ── PM2 자동 시작 등록 ──
pm2 save

echo ""
echo "[deploy] Status:"
pm2 status

echo ""
echo "========================================="
echo " Deploy Complete!"
echo "========================================="
echo ""
echo "로그 확인:"
echo "  pm2 logs toeic-api"
echo "  pm2 logs toeic-autoscaler"
echo ""
echo "헬스 체크:"
echo "  curl http://localhost:4000/api/health"
echo ""
