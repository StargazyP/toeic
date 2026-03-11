# TOEIC Vocabulary Learning App

> A minimalist English vocabulary learning app — study 3 to 50 words a day with AI-powered practice.

---

## Architecture

![Architecture Diagram](docs/architecture.png)

---

## Project Structure

```
toeic/
├── api/                     # Backend (Node.js + Express + TypeScript)
│   └── src/
│       ├── index.ts         # Express server, auth, API routes, metrics
│       ├── autoscaler.ts    # PM2 dynamic auto-scaler (CPU/RPM-based)
│       ├── voca.ts          # Vocabulary loader & random picker
│       └── wordPractice.ts  # AI sentence generation (Ollama / OpenAI)
├── app/                     # Frontend (React Native + Expo + TypeScript)
│   ├── App.tsx              # Full UI (auth, learning, quiz, practice, my words)
│   ├── app.json             # Expo config
│   └── eas.json             # EAS Build profiles (APK / AAB)
├── deploy/                  # Production deployment scripts
│   ├── setup-server.sh      # Cloud server initial setup
│   ├── setup-nginx.sh       # Nginx reverse proxy + SSL
│   ├── deploy.sh            # API code deployment
│   ├── migrate-db.sh        # MySQL data migration
│   └── build-apk.sh         # Android APK/AAB build
├── ecosystem.config.js      # PM2 cluster + auto-scaler config
├── docker-compose.yml       # MySQL container (development)
├── toeic.json               # TOEIC vocabulary dataset
└── docs/
    ├── architecture.png     # Architecture diagram
    └── performance-improvements.md
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | React Native + Expo + TypeScript |
| **Backend** | Node.js + Express + TypeScript |
| **Database** | MySQL 8.4 (Connection Pool, Transactions) |
| **Auth** | JWT + bcryptjs |
| **AI** | Ollama (phi3:mini for sentences, qwen2:1.5b for translation) |
| **AI Fallback** | OpenAI GPT-4o-mini |
| **Process Manager** | PM2 Cluster Mode + Custom Auto-scaler |
| **Security** | Helmet, CORS, Rate Limiting, Input Validation |
| **Deployment** | Nginx + Let's Encrypt SSL, EAS Build (Android) |
| **Platform** | Web, Android (APK), iOS |

---

## Key Features

### 1. Vocabulary Learning
- Choose how many words to study per session (up to 50)
- Flashcard-style word cards with "Show meaning" toggle
- Previously studied words are automatically excluded
- TTS pronunciation support

### 2. AI-Powered Quiz
- Fill-in-the-blank and Korean→English quiz types
- AI generates contextual sentences for each word
- Results tracked with correct/incorrect history per word
- Detailed word history view with wrong answer review

### 3. AI Sentence Practice
- Enter any English word → Ollama generates 10 example sentences
- qwen2 translates sentences to Korean
- Practice mode: read Korean, write English
- Save and edit practice results

### 4. AI Composition
- AI generates a paragraph using all studied words
- Korean translation provided as a prompt
- Write your own English composition and compare with AI

### 5. My Words
- All studied words with known/unknown classification
- Practice history with re-edit capability
- Per-word quiz history and wrong answer review

---

## Performance & Scalability (1,000 Concurrent Users)

| Feature | Implementation |
|---------|---------------|
| **DB Connection Pool** | mysql2 pool (30 connections, queue limit 100) |
| **Transactions** | All write operations wrapped in transactions |
| **Rate Limiting** | Global (120/min), Auth (20/15min), AI (10/min) |
| **PM2 Cluster** | Multi-process with CPU core auto-detection |
| **Auto-scaling** | Custom scaler monitors CPU load, RPM, response time |
| **AI Concurrency** | Semaphore pattern (max 5 concurrent AI calls) |
| **Security** | Helmet headers, GZIP compression, input size limits |
| **Graceful Shutdown** | SIGTERM/SIGINT handling, DB pool cleanup |
| **Real-time Metrics** | `/api/metrics` endpoint (RPM, connections, response time) |

---

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/register` | User registration |
| POST | `/api/login` | User login |
| GET | `/api/me` | Authenticated user info |
| GET | `/api/words/today?count=N` | Get random words for today's session |
| POST | `/api/words/save` | Save study results (known/unknown) |
| GET | `/api/words/my` | User's word list |
| POST | `/api/word/practice` | AI sentence generation |
| POST | `/api/practice/save` | Save practice session |
| PATCH | `/api/practice/:id` | Update practice session |
| GET | `/api/practice/my` | User's practice history |
| POST | `/api/quiz/generate` | AI quiz generation |
| POST | `/api/quiz/save` | Save quiz results |
| GET | `/api/quiz/word/:word` | Word detail + quiz history |
| POST | `/api/composition/generate` | AI composition generation |
| POST | `/api/composition/save` | Save composition |
| GET | `/api/metrics` | Real-time server metrics |
| GET | `/api/health` | Health check |

---

## Getting Started

### Prerequisites
- Node.js 20+
- MySQL 8+
- Ollama (optional, for local LLM)

### 1. Database

```bash
docker-compose up -d    # Start MySQL container
```

### 2. Backend

```bash
cd api
cp .env.example .env    # Edit with your credentials
npm install
npm run dev             # Development (tsx watch, port 4000)
```

### 3. Frontend

```bash
cd app
npm install
npm start               # Expo dev server
```

### 4. Ollama (Optional)

```bash
ollama serve
ollama pull phi3:mini
ollama pull qwen2:1.5b
```

### 5. Production (PM2 Cluster)

```bash
cd api && npm run build && cd ..
pm2 start ecosystem.config.js
pm2 save && pm2 startup
```

---

## Production Deployment

Deployment scripts are provided in the `deploy/` directory:

```bash
# 1. Cloud server setup (Ubuntu 22.04)
sudo ./deploy/setup-server.sh

# 2. Upload code & deploy API
./deploy/deploy.sh

# 3. Nginx + SSL
sudo ./deploy/setup-nginx.sh yourdomain.com

# 4. DB migration (from local to cloud)
./deploy/migrate-db.sh dump       # On local server
./deploy/migrate-db.sh restore    # On cloud server

# 5. Android APK build
./deploy/build-apk.sh             # Preview APK
./deploy/build-apk.sh prod        # Production AAB
```

See [`deploy/README.md`](deploy/README.md) for detailed instructions.

---

## Database Schema

Tables are auto-created on server startup:

- `users` — User accounts (email, password hash)
- `user_words` — Study history (word, status, quiz sentence)
- `user_practice_sessions` — AI practice sessions (examples, user writing)
- `user_quiz_results` — Quiz results (type, prompt, answer, correctness)

---

## Design Philosophy

- **Extreme minimalism** — No scores, streaks, ads, or gamification
- **Zero friction** — Open the app, study, done
- **Local AI first** — Cost-free with Ollama, OpenAI as fallback
- **Production ready** — Handles 1,000 concurrent users with auto-scaling
