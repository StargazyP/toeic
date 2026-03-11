#!/bin/bash
set -euo pipefail

# ============================================================
# Nginx 리버스 프록시 + Let's Encrypt SSL 설정
#
# 사용법: sudo ./setup-nginx.sh yourdomain.com your@email.com
# ============================================================

DOMAIN="${1:?Usage: $0 <domain> [email]}"
EMAIL="${2:-admin@${DOMAIN}}"
API_PORT=4000

echo "========================================="
echo " Nginx + SSL Setup"
echo " Domain: ${DOMAIN}"
echo " Email:  ${EMAIL}"
echo "========================================="

# ── Nginx 설정 생성 ──
cat > /etc/nginx/sites-available/toeic-api <<NGINXEOF
# HTTP → HTTPS 리다이렉트
server {
    listen 80;
    server_name ${DOMAIN};

    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}

# HTTPS 리버스 프록시
server {
    listen 443 ssl http2;
    server_name ${DOMAIN};

    # SSL 인증서 (certbot이 자동 설정)
    ssl_certificate /etc/letsencrypt/live/${DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${DOMAIN}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    # 보안 헤더
    add_header X-Frame-Options SAMEORIGIN;
    add_header X-Content-Type-Options nosniff;
    add_header X-XSS-Protection "1; mode=block";
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    # 요청 크기 제한
    client_max_body_size 5m;

    # 프록시 설정
    location / {
        proxy_pass http://127.0.0.1:${API_PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;

        # 타임아웃 (AI 생성 요청은 오래 걸릴 수 있음)
        proxy_connect_timeout 60s;
        proxy_send_timeout 120s;
        proxy_read_timeout 120s;
    }
}
NGINXEOF

# ── 심볼릭 링크 ──
ln -sf /etc/nginx/sites-available/toeic-api /etc/nginx/sites-enabled/toeic-api
rm -f /etc/nginx/sites-enabled/default

# ── Nginx 설정 테스트 ──
echo "[nginx] Testing configuration..."
nginx -t

# ── 먼저 HTTP로 시작 (certbot 인증 위해) ──
cat > /etc/nginx/sites-available/toeic-api-temp <<TEMPEOF
server {
    listen 80;
    server_name ${DOMAIN};

    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        proxy_pass http://127.0.0.1:${API_PORT};
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    }
}
TEMPEOF

ln -sf /etc/nginx/sites-available/toeic-api-temp /etc/nginx/sites-enabled/toeic-api
systemctl reload nginx

# ── SSL 인증서 발급 ──
echo "[certbot] Obtaining SSL certificate..."
certbot --nginx -d "${DOMAIN}" --non-interactive --agree-tos -m "${EMAIL}" --redirect

# ── 최종 Nginx 설정 적용 ──
ln -sf /etc/nginx/sites-available/toeic-api /etc/nginx/sites-enabled/toeic-api
nginx -t && systemctl reload nginx

# ── 인증서 자동 갱신 확인 ──
echo "[certbot] Testing auto-renewal..."
certbot renew --dry-run

echo ""
echo "========================================="
echo " Nginx + SSL Setup Complete!"
echo "========================================="
echo ""
echo " https://${DOMAIN} → localhost:${API_PORT}"
echo " SSL 인증서 자동 갱신 활성화됨"
echo ""
