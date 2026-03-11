#!/bin/bash
set -euo pipefail

# ============================================================
# Android APK 빌드 스크립트
#
# 사전 조건:
#   1. Expo 계정 필요 (https://expo.dev 가입)
#   2. eas login 실행하여 로그인
#
# 사용법:
#   ./build-apk.sh          직접배포용 APK (.apk)
#   ./build-apk.sh prod     Google Play용 AAB (.aab)
# ============================================================

PROFILE="${1:-preview}"
APP_DIR="$(cd "$(dirname "$0")/../app" && pwd)"

echo "========================================="
echo " Android Build (profile: ${PROFILE})"
echo "========================================="

export PATH="$HOME/.local/bin:$PATH"

# ── EAS 로그인 확인 ──
if ! eas whoami &>/dev/null; then
  echo "[auth] Expo 계정 로그인이 필요합니다."
  echo "       eas login 을 먼저 실행하세요."
  eas login
fi

WHOAMI=$(eas whoami)
echo "[auth] Logged in as: ${WHOAMI}"

cd "$APP_DIR"

# ── 빌드 프로필 결정 ──
case "$PROFILE" in
  prod|production)
    echo "[build] Google Play용 AAB 빌드..."
    eas build --platform android --profile production --non-interactive
    ;;
  preview|apk)
    echo "[build] 직접배포용 APK 빌드..."
    eas build --platform android --profile preview --non-interactive
    ;;
  dev|development)
    echo "[build] 개발용 APK 빌드..."
    eas build --platform android --profile development --non-interactive
    ;;
  *)
    echo "[error] Unknown profile: ${PROFILE}"
    echo "Usage: $0 [preview|production|development]"
    exit 1
    ;;
esac

echo ""
echo "========================================="
echo " Build submitted!"
echo "========================================="
echo ""
echo "빌드 상태 확인:"
echo "  eas build:list"
echo ""
echo "빌드 완료 후 다운로드:"
echo "  EAS 대시보드에서 다운로드 또는"
echo "  eas build:list → URL 복사"
echo ""
