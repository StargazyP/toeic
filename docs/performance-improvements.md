# TOEIC API 서버 성능 및 안정성 개선 보고서

> **목표**: 1,000명 동시 사용자 환경에서의 안정적 운영  
> **대상**: `api/src/index.ts`, `api/src/autoscaler.ts`, `ecosystem.config.js`

---

## 목차

1. [개선 전 문제점 분석](#1-개선-전-문제점-분석)
2. [DB 커넥션 풀 최적화](#2-db-커넥션-풀-최적화)
3. [트랜잭션 처리](#3-트랜잭션-처리)
4. [Rate Limiting (요청 제한)](#4-rate-limiting-요청-제한)
5. [보안 미들웨어](#5-보안-미들웨어)
6. [AI 동시성 제어 (Semaphore)](#6-ai-동시성-제어-semaphore)
7. [입력 검증 강화](#7-입력-검증-강화)
8. [실시간 메트릭 수집](#8-실시간-메트릭-수집)
9. [유동적 오토스케일링](#9-유동적-오토스케일링)
10. [Graceful Shutdown](#10-graceful-shutdown)
11. [글로벌 에러 핸들링](#11-글로벌-에러-핸들링)
12. [변경된 파일 목록](#12-변경된-파일-목록)
13. [환경변수 설정](#13-환경변수-설정)
14. [실행 방법](#14-실행-방법)

---

## 1. 개선 전 문제점 분석

| 문제 | 영향 | 위험도 |
|------|------|--------|
| DB 커넥션 풀 5개 | 6번째 요청부터 대기열, 1000명 동시 접속 시 타임아웃 | **치명적** |
| 트랜잭션 미사용 | `quiz/save`에서 2개 테이블 INSERT 중 하나 실패 시 데이터 불일치 | **높음** |
| Rate Limiting 없음 | DDoS, 브루트포스 공격에 무방비 | **높음** |
| AI 동시성 제어 없음 | Ollama에 동시 100개 요청 → 서버 메모리 고갈 | **높음** |
| 보안 헤더 미설정 | XSS, clickjacking 등 웹 취약점 노출 | **중간** |
| 응답 압축 없음 | 불필요한 대역폭 소모 | **중간** |
| 요청 크기 제한 없음 | 대용량 페이로드로 메모리 고갈 가능 | **중간** |
| 단일 프로세스 | CPU 멀티코어 활용 불가 | **높음** |
| Graceful Shutdown 없음 | 배포/재시작 시 진행 중인 요청 유실 | **중간** |
| 에러 핸들링 미흡 | 예외 발생 시 프로세스 크래시 | **높음** |

---

## 2. DB 커넥션 풀 최적화

### 변경 전

```typescript
const pool = mysql.createPool({
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT) || 3308,
  user: process.env.DB_USER || "toeic",
  password: process.env.DB_PASS || "toeicpassword",
  database: process.env.DB_NAME || "toeic",
  waitForConnections: true,
  connectionLimit: 5,
});
```

### 변경 후

```typescript
const pool = mysql.createPool({
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT) || 3308,
  user: process.env.DB_USER || "toeic",
  password: process.env.DB_PASS || "toeicpassword",
  database: process.env.DB_NAME || "toeic",
  waitForConnections: true,
  connectionLimit: 30,        // 5 → 30 (6배 증가)
  queueLimit: 100,            // 대기열 초과 시 즉시 에러 (무한 대기 방지)
  connectTimeout: 10_000,     // 연결 실패 10초 타임아웃
  enableKeepAlive: true,      // TCP 연결 유지로 재연결 비용 절감
  keepAliveInitialDelay: 30_000,
});
```

### 핵심 변경 사항

| 설정 | 변경 전 | 변경 후 | 이유 |
|------|---------|---------|------|
| `connectionLimit` | 5 | 30 | 동시 30개 DB 쿼리 처리 가능 |
| `queueLimit` | 없음(무한) | 100 | 대기열 100개 초과 시 즉시 에러 반환 |
| `connectTimeout` | 없음 | 10초 | 연결 실패 빠르게 감지 |
| `enableKeepAlive` | 없음 | true | 커넥션 재사용 최적화 |

---

## 3. 트랜잭션 처리

여러 테이블에 걸친 쓰기 작업을 하나의 트랜잭션으로 묶어 **원자성(Atomicity)** 보장.

### 적용 대상

#### `/api/register` — 회원가입

```typescript
// 변경 전: pool.execute() 2번 호출 (트랜잭션 없음)
// 문제: INSERT 성공 후 SELECT 전에 다른 요청이 끼어들 수 있음

// 변경 후:
const conn = await pool.getConnection();
try {
  await conn.beginTransaction();
  await conn.execute("INSERT INTO users ...");
  const [rows] = await conn.execute("SELECT id, email FROM users WHERE ...");
  await conn.commit();
} catch (err) {
  await conn.rollback().catch(() => {});
  // 에러 처리
} finally {
  conn.release();
}
```

#### `/api/words/save` — 학습 기록 저장

```typescript
// 배치 INSERT를 트랜잭션으로 보호
const conn = await pool.getConnection();
try {
  await conn.beginTransaction();
  await conn.execute(`INSERT INTO user_words ... VALUES ${placeholders}`, values.flat());
  await conn.commit();
} catch (err) {
  await conn.rollback().catch(() => {});
} finally {
  conn.release();
}
```

#### `/api/quiz/save` — 퀴즈 결과 저장 (가장 중요)

```typescript
// 변경 전: user_quiz_results INSERT → user_words INSERT (트랜잭션 없음)
// 문제: 첫 번째 INSERT 성공, 두 번째 INSERT 실패 시 데이터 불일치

// 변경 후:
const conn = await pool.getConnection();
try {
  await conn.beginTransaction();
  await conn.execute(`INSERT INTO user_quiz_results ...`);  // 퀴즈 결과
  await conn.execute(`INSERT INTO user_words ...`);          // 학습 기록
  await conn.commit();                                       // 모두 성공 시 커밋
} catch (err) {
  await conn.rollback().catch(() => {});                     // 하나라도 실패 시 전체 롤백
} finally {
  conn.release();
}
```

---

## 4. Rate Limiting (요청 제한)

3단계 레이어로 요청량을 제어합니다.

### 미들웨어 구성

```typescript
// 1) 글로벌 리미터 — 모든 API 요청
const globalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,   // 1분
  max: 120,                    // IP당 분당 120회
});
app.use("/api/", globalLimiter);

// 2) 인증 리미터 — 로그인/회원가입 전용
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,   // 15분
  max: 20,                      // IP당 15분에 20회
});

// 3) AI 리미터 — AI 생성 엔드포인트 전용
const aiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,    // 1분
  max: 10,                      // IP당 분당 10회
});
```

### 적용 현황

| 리미터 | 적용 엔드포인트 | 제한 | 목적 |
|--------|-----------------|------|------|
| `globalLimiter` | 모든 `/api/*` | IP당 분당 120회 | 전반적 남용 방지 |
| `authLimiter` | `/api/register`, `/api/login` | IP당 15분에 20회 | 브루트포스 차단 |
| `aiLimiter` | `/api/word/practice`, `/api/quiz/generate`, `/api/composition/generate` | IP당 분당 10회 | Ollama 과부하 방지 |

---

## 5. 보안 미들웨어

### 추가된 패키지

```bash
npm install helmet compression express-rate-limit
```

### 적용 코드

```typescript
app.use(helmet());                        // HTTP 보안 헤더 자동 설정
app.use(compression());                   // gzip 응답 압축
app.use(express.json({ limit: "1mb" }));  // 요청 본문 크기 제한
app.set("trust proxy", 1);               // 리버스 프록시 뒤에서 IP 정확히 식별
```

### helmet이 설정하는 헤더

| 헤더 | 역할 |
|------|------|
| `X-Content-Type-Options: nosniff` | MIME 타입 스니핑 방지 |
| `X-Frame-Options: SAMEORIGIN` | 클릭재킹 방지 |
| `X-XSS-Protection` | XSS 필터 활성화 |
| `Strict-Transport-Security` | HTTPS 강제 |
| `Content-Security-Policy` | 스크립트 주입 방지 |

### compression 효과

- JSON 응답 평균 60~70% 크기 감소
- 네트워크 대역폭 절약
- 클라이언트 로딩 속도 향상

---

## 6. AI 동시성 제어 (Semaphore)

Ollama 서버는 동시 요청이 많으면 메모리 부족/타임아웃이 발생합니다.  
**Semaphore 패턴**으로 동시 실행 수를 제한하고, 초과 요청은 큐에서 대기합니다.

### 구현

```typescript
class Semaphore {
  private queue: (() => void)[] = [];
  private running = 0;
  constructor(private max: number) {}

  async acquire(): Promise<void> {
    if (this.running < this.max) {
      this.running++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => { this.running++; resolve(); });
    });
  }

  release(): void {
    this.running--;
    const next = this.queue.shift();
    if (next) next();
  }

  get pending() { return this.queue.length; }
}

const aiSemaphore = new Semaphore(Number(process.env.AI_CONCURRENCY) || 5);
```

### 적용 엔드포인트

```typescript
app.post("/api/word/practice", aiLimiter, async (req, res) => {
  await aiSemaphore.acquire();    // 슬롯 확보 (최대 5개 동시)
  try {
    const result = await generateWordPractice(word.trim());
    return res.json(result);
  } finally {
    aiSemaphore.release();        // 슬롯 반환
  }
});
```

### 동작 흐름 (최대 동시 5개 기준)

```
요청 1 → acquire() → 즉시 실행 (running: 1)
요청 2 → acquire() → 즉시 실행 (running: 2)
요청 3 → acquire() → 즉시 실행 (running: 3)
요청 4 → acquire() → 즉시 실행 (running: 4)
요청 5 → acquire() → 즉시 실행 (running: 5)
요청 6 → acquire() → 큐에서 대기 (queue: 1)
요청 7 → acquire() → 큐에서 대기 (queue: 2)
  ...요청 1 완료 → release() → 요청 6이 큐에서 빠져나와 실행
```

---

## 7. 입력 검증 강화

### 배치 크기 제한

```typescript
const MAX_BATCH_WORDS = 50;

// /api/words/save
if (words.length > MAX_BATCH_WORDS) {
  return res.status(400).json({ error: `한번에 최대 ${MAX_BATCH_WORDS}개까지 저장 가능합니다` });
}

// /api/quiz/save
if (results.length > MAX_BATCH_WORDS) {
  return res.status(400).json({ error: `한번에 최대 ${MAX_BATCH_WORDS}개까지 저장 가능합니다` });
}
```

### AI 생성 입력 제한

```typescript
// /api/quiz/generate, /api/composition/generate
if (words.length > 20) {
  return res.status(400).json({ error: "최대 20개 단어까지 생성 가능합니다" });
}
```

### 요청 본문 크기 제한

```typescript
app.use(express.json({ limit: "1mb" }));  // 1MB 초과 요청 거부
```

---

## 8. 실시간 메트릭 수집

모든 요청에 미들웨어가 붙어 실시간 성능 지표를 수집합니다.

### 수집 데이터

```typescript
const metrics = {
  requestsInWindow: 0,     // 현재 윈도우(1분) 내 요청 수
  activeConnections: 0,     // 현재 처리 중인 요청 수
  totalRequests: 0,         // 서버 시작 이후 총 요청 수
  totalResponseTime: 0,     // 현재 윈도우 내 총 응답시간 (ms)
  windowStart: Date.now(),  // 윈도우 시작 시각
};
```

### `/api/metrics` 엔드포인트 응답 예시

```json
{
  "pid": 12345,
  "uptime": 3600,
  "cpuCount": 4,
  "loadAvg": { "1m": 1.5, "5m": 1.2, "15m": 0.8 },
  "memory": {
    "totalMB": 8192,
    "freeMB": 4096,
    "processRSS_MB": 128
  },
  "requests": {
    "rpm": 450,
    "activeConnections": 12,
    "totalRequests": 54321,
    "avgResponseTimeMs": 85
  },
  "ai": {
    "pendingQueue": 3
  }
}
```

---

## 9. 유동적 오토스케일링

### 아키텍처

```
┌─────────────────────┐    GET /api/metrics    ┌────────────────────┐
│     toeic-api       │◄──────────────────────│  toeic-autoscaler  │
│  (PM2 cluster)      │  RPM, CPU, 응답시간     │  (PM2 fork, 1개)   │
│  2~N개 인스턴스      │                        │  15초마다 폴링      │
└─────────────────────┘                        └─────────┬──────────┘
                                                         │
                                                 pm2 scale toeic-api N
                                                         │
                                               ┌─────────▼──────────┐
                                               │       PM2          │
                                               │  인스턴스 증감 실행  │
                                               └────────────────────┘
```

### 스케일링 판단 기준

#### 스케일 업 (하나라도 해당 시)

| 지표 | 임계값 | 설명 |
|------|--------|------|
| CPU loadAvg(1m) | > 코어수 x 70% | CPU 과부하 |
| RPM / 인스턴스 | > 200 | 인스턴스당 요청 과다 |
| 평균 응답시간 | > 2,000ms | 응답 지연 |

#### 스케일 다운 (모두 해당 시)

| 지표 | 임계값 | 설명 |
|------|--------|------|
| CPU loadAvg(1m) | < 코어수 x 30% | CPU 여유 |
| RPM / 인스턴스 | < 50 | 인스턴스당 요청 적음 |
| 평균 응답시간 | < 500ms | 응답 양호 |

### 안전장치

| 기능 | 값 | 설명 |
|------|-----|------|
| 최소 인스턴스 | `ceil(CPU코어/2)` 또는 최소 2개 | 서비스 가용성 보장 |
| 최대 인스턴스 | CPU 코어 수 | 리소스 초과 방지 |
| 쿨다운 | 60초 | 스케일 후 재조정 방지 (flapping 방지) |
| 점진적 스케일 다운 | 1개씩 감소 | 급격한 축소 방지 |

### 시나리오 예시 (4코어 서버)

```
[시간]   [인스턴스]  [RPM]   [CPU]    [이벤트]
00:00    2개        30      15%     서버 시작
08:00    2개        80      25%     출근 시간 접속 시작
09:00    3개        450     55%     → SCALE UP (RPM 초과)
09:30    4개        800     75%     → SCALE UP (CPU 초과)
12:00    4개        900     80%     피크 시간 (최대 유지)
14:00    4개        400     50%     트래픽 감소 시작
14:01    3개        300     40%     → SCALE DOWN
14:02    2개        100     20%     → SCALE DOWN
18:00    2개        50      10%     퇴근 후 최소 유지
```

### 오토스케일러 로그 예시

```
[autoscaler] started — app=toeic-api min=2 max=4 cpus=4 poll=15000ms cooldown=60000ms
[autoscaler] instances=2 target=2 load=15.2% rpm=30 avgRt=45ms active=2 aiQueue=0
[autoscaler] instances=2 target=3 load=55.0% rpm=450 avgRt=120ms active=15 aiQueue=2
[autoscaler] SCALE UP: 2 → 3
[autoscaler] instances=3 target=4 load=75.0% rpm=800 avgRt=350ms active=28 aiQueue=5
[autoscaler] SCALE UP: 3 → 4
[autoscaler] instances=4 target=3 load=25.0% rpm=100 avgRt=30ms active=3 aiQueue=0
[autoscaler] SCALE DOWN: 4 → 3
```

---

## 10. Graceful Shutdown

배포/재시작 시 진행 중인 요청을 안전하게 완료한 후 종료합니다.

```typescript
async function gracefulShutdown(signal: string) {
  console.log(`[api] ${signal} received, shutting down gracefully...`);

  // 1. 새 요청 수신 중지
  server.close(async () => {
    console.log("[api] HTTP server closed");

    // 2. DB 풀 정리
    try {
      await pool.end();
      console.log("[api] DB pool closed");
    } catch (err) {
      console.error("[api] DB pool close error:", err);
    }

    // 3. 정상 종료
    process.exit(0);
  });

  // 4. 10초 안에 종료 안되면 강제 종료
  setTimeout(() => {
    console.error("[api] Forced shutdown after timeout");
    process.exit(1);
  }, 10_000);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
```

### HTTP Keep-Alive 설정

```typescript
server.keepAliveTimeout = 65_000;   // 로드밸런서 기본값(60s)보다 길게
server.headersTimeout = 66_000;     // keepAliveTimeout + 1s
```

---

## 11. 글로벌 에러 핸들링

```typescript
// Express 글로벌 에러 핸들러
app.use((err, _req, res, _next) => {
  console.error("[unhandled]", err);
  res.status(500).json({ error: "서버 내부 오류가 발생했습니다" });
});

// Promise rejection (비동기 에러)
process.on("unhandledRejection", (reason) => {
  console.error("[api] unhandledRejection:", reason);
});

// 치명적 예외 → graceful shutdown 실행
process.on("uncaughtException", (err) => {
  console.error("[api] uncaughtException:", err);
  gracefulShutdown("uncaughtException");
});
```

---

## 12. 변경된 파일 목록

| 파일 | 변경 유형 | 설명 |
|------|-----------|------|
| `api/src/index.ts` | 수정 | 풀 확장, 트랜잭션, Rate Limit, Semaphore, 메트릭, Shutdown |
| `api/src/autoscaler.ts` | 신규 | PM2 오토스케일러 |
| `ecosystem.config.js` | 수정 | 동적 인스턴스 설정 + 오토스케일러 등록 |
| `api/package.json` | 수정 | helmet, compression, express-rate-limit 추가 |

### 추가된 의존성

| 패키지 | 버전 | 용도 |
|--------|------|------|
| `helmet` | latest | HTTP 보안 헤더 |
| `compression` | latest | gzip 응답 압축 |
| `express-rate-limit` | latest | 요청 속도 제한 |
| `@types/compression` | latest (dev) | TypeScript 타입 |

---

## 13. 환경변수 설정

### 기존 변수 (변경 없음)

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `PORT` | 4000 | 서버 포트 |
| `DB_HOST` | 127.0.0.1 | MySQL 호스트 |
| `DB_PORT` | 3308 | MySQL 포트 |
| `JWT_SECRET` | toeic-secret | JWT 시크릿 |

### 신규 추가 변수

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `AI_CONCURRENCY` | 5 | AI 동시 요청 최대 수 |
| `SCALE_MIN` | ceil(CPU/2) | 최소 인스턴스 수 |
| `SCALE_MAX` | CPU 코어 수 | 최대 인스턴스 수 |
| `SCALE_POLL_MS` | 15000 | 오토스케일러 폴링 간격 (ms) |
| `SCALE_COOLDOWN_MS` | 60000 | 스케일 후 쿨다운 (ms) |

---

## 14. 실행 방법

### 개발 환경

```bash
cd api
npm run dev
```

### 프로덕션 환경 (PM2 + 오토스케일링)

```bash
# PM2 설치
npm install -g pm2

# 서버 시작 (API + 오토스케일러)
cd /home/jangdonggun/포트폴리오/toeic
pm2 start ecosystem.config.js

# 상태 확인
pm2 status

# 로그 확인
pm2 logs toeic-api           # API 서버 로그
pm2 logs toeic-autoscaler    # 오토스케일러 로그

# 메트릭 확인
curl http://localhost:4000/api/metrics

# 수동 스케일 (필요 시)
pm2 scale toeic-api 4

# 서버 중지
pm2 stop all

# 서버 삭제
pm2 delete all
```

### 서버 재시작 시 자동 실행

```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```
