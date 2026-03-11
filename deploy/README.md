# 배포 가이드

## 파일 구조

```
deploy/
├── setup-server.sh     # 1. 클라우드 서버 초기 셋업
├── deploy.sh           # 2. API 코드 배포
├── setup-nginx.sh      # 3. Nginx + SSL 설정
├── migrate-db.sh       # 4. DB 마이그레이션
├── build-apk.sh        # 5. Android APK 빌드
└── README.md           # 이 파일
```

## 백엔드 배포 순서

### 1. 클라우드 서버 생성

Oracle Cloud Free Tier (추천, 무료):
- ARM 인스턴스: 4 vCPU, 24GB RAM
- Ubuntu 22.04 선택
- 방화벽: 80, 443 포트 오픈

### 2. 서버 초기 셋업

```bash
scp deploy/setup-server.sh user@server:/tmp/
ssh user@server 'chmod +x /tmp/setup-server.sh && sudo /tmp/setup-server.sh'
```

### 3. 코드 업로드

```bash
rsync -avz --exclude node_modules --exclude dist --exclude .expo \
  . user@server:/opt/toeic/
```

### 4. DB 마이그레이션

```bash
# 홈서버에서 백업
cd deploy && ./migrate-db.sh dump

# 클라우드로 전송 & 복원
scp toeic_backup_*.sql user@server:/tmp/
ssh user@server 'cd /opt/toeic/deploy && ./migrate-db.sh restore /tmp/toeic_backup_*.sql'
```

### 5. API 배포

```bash
ssh user@server 'cd /opt/toeic/deploy && ./deploy.sh'
```

### 6. Nginx + SSL

```bash
ssh user@server 'cd /opt/toeic/deploy && sudo ./setup-nginx.sh yourdomain.com your@email.com'
```

## Android APK 빌드

### 사전 준비

1. [expo.dev](https://expo.dev) 계정 생성
2. `eas login` 으로 로그인
3. `eas.json`에서 `EXPO_PUBLIC_API_URL`을 프로덕션 URL로 변경

### 빌드

```bash
# 직접 배포용 APK
./deploy/build-apk.sh

# Google Play용 AAB
./deploy/build-apk.sh prod
```

### 배포

- **직접 배포**: APK 파일을 공유 (메신저, 이메일 등)
- **Google Play**: [Play Console](https://play.google.com/console)에 AAB 업로드 ($25 등록비)
