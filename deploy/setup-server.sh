#!/bin/bash
set -euo pipefail

# ============================================================
# TOEIC API - 클라우드 서버 초기 셋업 스크립트
# 대상: Ubuntu 22.04 (Oracle Cloud Free Tier ARM 또는 x86)
#
# 사용법: ssh로 클라우드 서버 접속 후
#   chmod +x setup-server.sh && sudo ./setup-server.sh
# ============================================================

echo "========================================="
echo " TOEIC API Server Setup"
echo "========================================="

export DEBIAN_FRONTEND=noninteractive

# ── 1. 시스템 업데이트 ──
echo "[1/7] System update..."
apt-get update -y && apt-get upgrade -y

# ── 2. Node.js 20 LTS ──
echo "[2/7] Installing Node.js 20..."
if ! command -v node &> /dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
echo "Node.js $(node -v), npm $(npm -v)"

# ── 3. PM2 ──
echo "[3/7] Installing PM2..."
npm install -g pm2

# ── 4. MySQL 8 ──
echo "[4/7] Installing MySQL 8..."
if ! command -v mysql &> /dev/null; then
  apt-get install -y mysql-server
  systemctl enable mysql
  systemctl start mysql

  echo "[mysql] Securing installation..."
  MYSQL_ROOT_PASS=$(openssl rand -base64 24)
  MYSQL_APP_PASS=$(openssl rand -base64 24)

  mysql -u root <<SQLEOF
ALTER USER 'root'@'localhost' IDENTIFIED WITH mysql_native_password BY '${MYSQL_ROOT_PASS}';
CREATE DATABASE IF NOT EXISTS toeic CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'toeic'@'localhost' IDENTIFIED BY '${MYSQL_APP_PASS}';
GRANT ALL PRIVILEGES ON toeic.* TO 'toeic'@'localhost';
FLUSH PRIVILEGES;
SQLEOF

  echo ""
  echo "============================================"
  echo " MySQL Credentials (저장해두세요!)"
  echo "============================================"
  echo " Root Password: ${MYSQL_ROOT_PASS}"
  echo " App User:      toeic"
  echo " App Password:  ${MYSQL_APP_PASS}"
  echo " Database:      toeic"
  echo "============================================"
  echo ""

  cat > /root/.toeic-db-credentials <<CREDEOF
MYSQL_ROOT_PASS=${MYSQL_ROOT_PASS}
DB_USER=toeic
DB_PASS=${MYSQL_APP_PASS}
DB_NAME=toeic
DB_HOST=127.0.0.1
DB_PORT=3306
CREDEOF
  chmod 600 /root/.toeic-db-credentials
  echo "[mysql] Credentials saved to /root/.toeic-db-credentials"
else
  echo "[mysql] Already installed, skipping."
fi

# ── 5. Nginx ──
echo "[5/7] Installing Nginx..."
apt-get install -y nginx certbot python3-certbot-nginx
systemctl enable nginx
systemctl start nginx

# ── 6. Ollama ──
echo "[6/7] Installing Ollama..."
if ! command -v ollama &> /dev/null; then
  curl -fsSL https://ollama.com/install.sh | sh
  systemctl enable ollama
  systemctl start ollama
  sleep 3
  echo "[ollama] Pulling phi3:mini model (this may take a while)..."
  ollama pull phi3:mini
  echo "[ollama] Pulling qwen2:1.5b model..."
  ollama pull qwen2:1.5b
else
  echo "[ollama] Already installed, skipping."
fi

# ── 7. 방화벽 ──
echo "[7/7] Configuring firewall..."
if command -v ufw &> /dev/null; then
  ufw allow 22/tcp
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw --force enable
  echo "[firewall] Ports 22, 80, 443 opened"
fi

# ── 앱 디렉토리 생성 ──
APP_DIR="/opt/toeic"
mkdir -p "$APP_DIR"
echo "[setup] App directory: $APP_DIR"

echo ""
echo "========================================="
echo " Setup Complete!"
echo "========================================="
echo ""
echo "다음 단계:"
echo "  1. /root/.toeic-db-credentials 파일에서 DB 비밀번호 확인"
echo "  2. 코드를 ${APP_DIR}에 업로드 (scp 또는 git clone)"
echo "  3. deploy/deploy.sh 실행"
echo "  4. deploy/setup-nginx.sh <도메인> 실행"
echo ""
