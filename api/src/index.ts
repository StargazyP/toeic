import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import mysql from "mysql2/promise";
import os from "os";
import { pickRandomWords, loadVoca } from "./voca";
import { generateWordPractice, generateComposition, generateQuizSentences } from "./wordPractice";

const app = express();

// ── 실시간 요청 메트릭 수집 ──
const metrics = {
  requestsInWindow: 0,
  activeConnections: 0,
  totalRequests: 0,
  totalResponseTime: 0,
  windowStart: Date.now(),
};

const METRICS_WINDOW_MS = 60_000;

function resetWindowIfNeeded() {
  const now = Date.now();
  if (now - metrics.windowStart >= METRICS_WINDOW_MS) {
    metrics.requestsInWindow = 0;
    metrics.totalResponseTime = 0;
    metrics.windowStart = now;
  }
}

app.use((req, res, next) => {
  metrics.activeConnections++;
  metrics.requestsInWindow++;
  metrics.totalRequests++;
  const start = Date.now();

  res.on("finish", () => {
    metrics.activeConnections--;
    metrics.totalResponseTime += Date.now() - start;
    resetWindowIfNeeded();
  });

  next();
});

// ── Security & Performance middleware ──
app.use(helmet());
app.use(compression());
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.set("trust proxy", 1);

const globalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "요청이 너무 많습니다. 잠시 후 다시 시도해주세요." },
});
app.use("/api/", globalLimiter);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: "로그인 시도가 너무 많습니다. 15분 후 다시 시도해주세요." },
});

const aiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 10,
  message: { error: "AI 요청이 너무 많습니다. 잠시 후 다시 시도해주세요." },
});

const PORT = Number(process.env.PORT) || 4000;
const JWT_SECRET = process.env.JWT_SECRET || "toeic-secret";

// ── MySQL pool (1000명 동시 사용자 대응) ──
const pool = mysql.createPool({
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT) || 3308,
  user: process.env.DB_USER || "toeic",
  password: process.env.DB_PASS || "toeicpassword",
  database: process.env.DB_NAME || "toeic",
  waitForConnections: true,
  connectionLimit: 30,
  queueLimit: 100,
  connectTimeout: 10_000,
  enableKeepAlive: true,
  keepAliveInitialDelay: 30_000,
});

// ── AI 동시성 제어 (Ollama 과부하 방지) ──
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
      this.queue.push(() => {
        this.running++;
        resolve();
      });
    });
  }

  release(): void {
    this.running--;
    const next = this.queue.shift();
    if (next) next();
  }

  get pending() {
    return this.queue.length;
  }
}

const aiSemaphore = new Semaphore(Number(process.env.AI_CONCURRENCY) || 5);

async function ensureTable() {
  try {
    await pool.execute(`SELECT 1 FROM users LIMIT 1`);
    console.log("[db] users table ready");
  } catch (err) {
    console.warn("[db] users table check failed:", (err as Error).message);
  }
  try {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS user_words (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id CHAR(36) NOT NULL,
        word VARCHAR(100) NOT NULL,
        meaning VARCHAR(255) DEFAULT '',
        pos VARCHAR(50) DEFAULT '',
        status ENUM('known','unknown') NOT NULL DEFAULT 'unknown',
        quiz_sentence TEXT,
        studied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_user_status (user_id, status),
        INDEX idx_user_word (user_id, word)
      )
    `);
    console.log("[db] user_words table ready");
    await pool.execute(`ALTER TABLE user_words ADD COLUMN quiz_sentence TEXT AFTER status`).catch(() => {});
  } catch (err) {
    console.warn("[db] user_words table:", (err as Error).message);
  }
  try {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS user_practice_sessions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id CHAR(36) NOT NULL,
        word VARCHAR(100) NOT NULL,
        questions JSON NOT NULL,
        answers JSON NOT NULL,
        practiced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_user_practice (user_id)
      )
    `);
    try {
      await pool.execute(`ALTER TABLE user_practice_sessions MODIFY user_id CHAR(36) NOT NULL`);
    } catch (_) {}
    console.log("[db] user_practice_sessions table ready");
  } catch (err) {
    console.warn("[db] user_practice_sessions:", (err as Error).message);
  }
  try {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS user_quiz_results (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id CHAR(36) NOT NULL,
        word VARCHAR(100) NOT NULL,
        quiz_type VARCHAR(50) NOT NULL DEFAULT 'fill_blank',
        prompt TEXT,
        user_answer VARCHAR(255) NOT NULL DEFAULT '',
        correct_answer VARCHAR(255) NOT NULL DEFAULT '',
        is_correct TINYINT(1) NOT NULL DEFAULT 0,
        quizzed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_user_quiz (user_id),
        INDEX idx_user_quiz_word (user_id, word)
      )
    `);
    await pool.execute(`ALTER TABLE user_quiz_results MODIFY COLUMN quiz_type VARCHAR(50) NOT NULL DEFAULT 'fill_blank'`).catch(() => {});
    await pool.execute(`ALTER TABLE user_quiz_results ADD COLUMN prompt TEXT AFTER quiz_type`).catch(() => {});
    await pool.execute(`ALTER TABLE user_quiz_results ADD INDEX idx_user_quiz_word (user_id, word)`).catch(() => {});
    console.log("[db] user_quiz_results table ready");
  } catch (err) {
    console.warn("[db] user_quiz_results:", (err as Error).message);
  }
  try {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS user_compositions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id CHAR(36) NOT NULL,
        words JSON NOT NULL,
        ai_english TEXT NOT NULL DEFAULT '',
        ai_korean TEXT NOT NULL DEFAULT '',
        user_writing TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_user_comp (user_id)
      )
    `);
    console.log("[db] user_compositions table ready");
  } catch (err) {
    console.warn("[db] user_compositions:", (err as Error).message);
  }
}

// ── Auth middleware ──
function authMiddleware(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No token" });
  }
  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET) as { id: number | string };
    (req as any).userId = payload.id;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

// ── Auth routes (rate limited) ──
app.post("/api/register", authLimiter, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: "username/password required" });
    }
    const hashed = await bcrypt.hash(password, 10);

    await conn.beginTransaction();
    await conn.execute(
      "INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)",
      [username, hashed, username]
    );
    const [rows] = await conn.execute(
      "SELECT id, email, name FROM users WHERE email = ?",
      [username]
    );
    await conn.commit();

    const created = (rows as any[])[0];
    const token = jwt.sign({ id: created.id, email: created.email }, JWT_SECRET, { expiresIn: "30d" });
    return res.json({ token, user: { id: created.id, username: created.email } });
  } catch (err: any) {
    await conn.rollback().catch(() => {});
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ error: "이미 존재하는 아이디입니다" });
    }
    return res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

app.post("/api/login", authLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    const [rows] = await pool.execute(
      "SELECT * FROM users WHERE email = ?",
      [username]
    );
    const user = (rows as any[])[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: "아이디 또는 비밀번호가 틀립니다" });
    }
    const token = jwt.sign(
      { id: user.id, email: user.email },
      JWT_SECRET,
      { expiresIn: "30d" }
    );
    return res.json({ token, user: { id: user.id, username: user.email } });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

app.get("/api/me", authMiddleware, (req, res) => {
  res.json({ userId: (req as any).userId });
});

// ── Vocabulary routes ──
app.get("/api/words/today", async (req, res) => {
  res.set("Cache-Control", "no-store");
  const count = Number(req.query.count) || 5;

  let excludeWords: string[] = [];
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    try {
      const payload = jwt.verify(authHeader.slice(7), JWT_SECRET) as { id: string };
      const [rows] = await pool.execute(
        "SELECT DISTINCT word FROM user_words WHERE user_id = ?",
        [payload.id]
      );
      excludeWords = (rows as any[]).map((r: any) => r.word);
    } catch {}
  }

  const words = pickRandomWords(count, excludeWords);
  if (words.length === 0) {
    return res.status(500).json({ error: "No vocabulary loaded" });
  }
  return res.json({ words, excludedCount: excludeWords.length });
});

// ── Word Practice (Ollama / OpenAI) - rate limited + concurrency controlled ──
app.post("/api/word/practice", aiLimiter, async (req, res) => {
  const { word } = req.body;
  if (!word || typeof word !== "string") {
    return res.status(400).json({ error: "word is required" });
  }
  await aiSemaphore.acquire();
  try {
    const result = await generateWordPractice(word.trim());
    return res.json(result);
  } catch (err: any) {
    console.error("[word/practice] error:", err);
    return res.status(500).json({ error: err.message });
  } finally {
    aiSemaphore.release();
  }
});

// ── User Words (학습 기록) - 배치 크기 제한 + 트랜잭션 ──
const MAX_BATCH_WORDS = 50;

app.post("/api/words/save", authMiddleware, async (req, res) => {
  const userId = (req as any).userId;
  const { words } = req.body as {
    words: { word: string; meaning: string; pos: string; status: "known" | "unknown" }[];
  };
  if (!Array.isArray(words) || words.length === 0) {
    return res.status(400).json({ error: "words array required" });
  }
  if (words.length > MAX_BATCH_WORDS) {
    return res.status(400).json({ error: `한번에 최대 ${MAX_BATCH_WORDS}개까지 저장 가능합니다` });
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const values = words.map((w) => [userId, w.word, w.meaning || "", w.pos || "", w.status]);
    const placeholders = values.map(() => "(?, ?, ?, ?, ?)").join(", ");
    await conn.execute(
      `INSERT INTO user_words (user_id, word, meaning, pos, status) VALUES ${placeholders}`,
      values.flat()
    );
    await conn.commit();
    return res.json({ saved: words.length });
  } catch (err: any) {
    await conn.rollback().catch(() => {});
    return res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

app.get("/api/words/my", authMiddleware, async (req, res) => {
  const userId = (req as any).userId;
  try {
    const [rows] = await pool.execute(
      `SELECT word, meaning, pos, status, COALESCE(quiz_sentence, '') AS quiz_sentence, studied_at
       FROM user_words
       WHERE user_id = ?
       ORDER BY studied_at DESC`,
      [userId]
    );
    const all = rows as any[];
    const known = all.filter((r: any) => r.status === "known");
    const unknown = all.filter((r: any) => r.status === "unknown");
    return res.json({ total: all.length, known, unknown });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ── Practice (한국어→영어 작성) 저장/조회 ──
app.post("/api/practice/save", authMiddleware, async (req, res) => {
  const userId = (req as any).userId;
  const { word, examples, user_english } = req.body as {
    word: string;
    examples: { en: string; ko: string }[];
    user_english: string[];
  };
  if (!word?.trim() || !Array.isArray(examples) || !Array.isArray(user_english)) {
    return res.status(400).json({ error: "word, examples, user_english required" });
  }
  if (examples.length !== user_english.length) {
    return res.status(400).json({ error: "examples and user_english length mismatch" });
  }
  try {
    await pool.execute(
      `INSERT INTO user_practice_sessions (user_id, word, questions, answers) VALUES (?, ?, ?, ?)`,
      [userId, word.trim(), JSON.stringify(examples), JSON.stringify(user_english)]
    );
    return res.json({ saved: true });
  } catch (err: any) {
    console.error("[practice/save] error:", err);
    return res.status(500).json({ error: err.message || "저장 중 오류가 발생했습니다" });
  }
});

app.patch("/api/practice/:id", authMiddleware, async (req, res) => {
  const userId = (req as any).userId;
  const id = Number(req.params.id);
  const { word, examples, user_english } = req.body as {
    word?: string;
    examples?: { en: string; ko: string }[];
    user_english?: string[];
  };
  if (!id || isNaN(id)) {
    return res.status(400).json({ error: "Invalid id" });
  }
  if (!Array.isArray(examples) || !Array.isArray(user_english) || examples.length !== user_english.length) {
    return res.status(400).json({ error: "examples and user_english required, same length" });
  }
  try {
    const [rows] = await pool.execute(
      `SELECT id FROM user_practice_sessions WHERE id = ? AND user_id = ?`,
      [id, userId]
    );
    if ((rows as any[]).length === 0) {
      return res.status(404).json({ error: "Record not found" });
    }
    await pool.execute(
      `UPDATE user_practice_sessions SET word = ?, questions = ?, answers = ? WHERE id = ? AND user_id = ?`,
      [word?.trim() || "", JSON.stringify(examples), JSON.stringify(user_english), id, userId]
    );
    return res.json({ updated: true });
  } catch (err: any) {
    console.error("[practice/patch] error:", err);
    return res.status(500).json({ error: err.message || "수정 중 오류가 발생했습니다" });
  }
});

app.get("/api/practice/my", authMiddleware, async (req, res) => {
  const userId = (req as any).userId;
  try {
    const [rows] = await pool.execute(
      `SELECT id, word, questions, answers, practiced_at
       FROM user_practice_sessions
       WHERE user_id = ?
       ORDER BY practiced_at DESC`,
      [userId]
    );
    const list = (rows as any[]).map((r) => ({
      id: r.id,
      word: r.word,
      examples: typeof r.questions === "string" ? JSON.parse(r.questions) : r.questions,
      user_english: typeof r.answers === "string" ? JSON.parse(r.answers) : r.answers,
      practiced_at: r.practiced_at,
    }));
    return res.json({ list });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ── Quiz (빈칸 채우기 퀴즈) - rate limited + concurrency controlled ──
app.post("/api/quiz/generate", aiLimiter, async (req, res) => {
  const { words } = req.body as { words: string[] };
  if (!Array.isArray(words) || words.length === 0) {
    return res.status(400).json({ error: "words array required" });
  }
  if (words.length > 20) {
    return res.status(400).json({ error: "최대 20개 단어까지 퀴즈 생성 가능합니다" });
  }
  await aiSemaphore.acquire();
  try {
    const result = await generateQuizSentences(words);
    return res.json({ quiz: result });
  } catch (err: any) {
    console.error("[quiz/generate] error:", err);
    return res.status(500).json({ error: err.message });
  } finally {
    aiSemaphore.release();
  }
});

app.post("/api/quiz/save", authMiddleware, async (req, res) => {
  const userId = (req as any).userId;
  const { results } = req.body as {
    results: { word: string; meaning: string; pos: string; quiz_type: string; prompt: string; user_answer: string; correct_answer: string; is_correct: boolean }[];
  };
  if (!Array.isArray(results) || results.length === 0) {
    return res.status(400).json({ error: "results array required" });
  }
  if (results.length > MAX_BATCH_WORDS) {
    return res.status(400).json({ error: `한번에 최대 ${MAX_BATCH_WORDS}개까지 저장 가능합니다` });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const qValues = results.map((r) => [userId, r.word, r.quiz_type || "fill_blank", r.prompt || "", r.user_answer || "", r.correct_answer || "", r.is_correct ? 1 : 0]);
    const qPlaceholders = qValues.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ");
    await conn.execute(
      `INSERT INTO user_quiz_results (user_id, word, quiz_type, prompt, user_answer, correct_answer, is_correct) VALUES ${qPlaceholders}`,
      qValues.flat()
    );

    const wordStatus = new Map<string, { word: string; meaning: string; pos: string; failed: boolean; sentences: string[] }>();
    for (const r of results) {
      const key = r.word.toLowerCase();
      const existing = wordStatus.get(key);
      if (!existing) {
        wordStatus.set(key, { word: r.word, meaning: r.meaning || "", pos: r.pos || "", failed: !r.is_correct, sentences: [r.prompt || ""] });
      } else {
        if (!r.is_correct) existing.failed = true;
        if (r.prompt) existing.sentences.push(r.prompt);
      }
    }

    const wValues = Array.from(wordStatus.values()).map((v) => [
      userId, v.word, v.meaning, v.pos, v.failed ? "unknown" : "known", v.sentences.filter(Boolean).join("\n"),
    ]);
    if (wValues.length > 0) {
      const wPlaceholders = wValues.map(() => "(?, ?, ?, ?, ?, ?)").join(", ");
      await conn.execute(
        `INSERT INTO user_words (user_id, word, meaning, pos, status, quiz_sentence) VALUES ${wPlaceholders}`,
        wValues.flat()
      );
    }

    await conn.commit();
    return res.json({ saved: results.length });
  } catch (err: any) {
    await conn.rollback().catch(() => {});
    return res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

app.get("/api/quiz/my", authMiddleware, async (req, res) => {
  const userId = (req as any).userId;
  try {
    const [rows] = await pool.execute(
      `SELECT word, quiz_type, COALESCE(prompt,'') AS prompt, user_answer, correct_answer, is_correct, quizzed_at
       FROM user_quiz_results WHERE user_id = ? ORDER BY quizzed_at DESC LIMIT 200`,
      [userId]
    );
    return res.json({ results: rows });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

app.get("/api/quiz/word/:word", authMiddleware, async (req, res) => {
  const userId = (req as any).userId;
  const { word } = req.params;
  try {
    const [rows] = await pool.execute(
      `SELECT quiz_type, COALESCE(prompt,'') AS prompt, user_answer, correct_answer, is_correct, quizzed_at
       FROM user_quiz_results WHERE user_id = ? AND word = ? ORDER BY quizzed_at DESC`,
      [userId, word]
    );
    const [wordRows] = await pool.execute(
      `SELECT word, meaning, pos, status, COALESCE(quiz_sentence,'') AS quiz_sentence, studied_at
       FROM user_words WHERE user_id = ? AND word = ? ORDER BY studied_at DESC LIMIT 1`,
      [userId, word]
    );
    const wordInfo = (wordRows as any[])[0] || null;
    return res.json({ word: wordInfo, quizHistory: rows });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ── Composition (AI 작문 생성/저장) - rate limited + concurrency controlled ──
app.post("/api/composition/generate", aiLimiter, async (req, res) => {
  const { words } = req.body as { words: string[] };
  if (!Array.isArray(words) || words.length === 0) {
    return res.status(400).json({ error: "words array required" });
  }
  if (words.length > 20) {
    return res.status(400).json({ error: "최대 20개 단어까지 작문 생성 가능합니다" });
  }
  await aiSemaphore.acquire();
  try {
    const result = await generateComposition(words);
    return res.json(result);
  } catch (err: any) {
    console.error("[composition/generate] error:", err);
    return res.status(500).json({ error: err.message });
  } finally {
    aiSemaphore.release();
  }
});

app.post("/api/composition/save", authMiddleware, async (req, res) => {
  const userId = (req as any).userId;
  const { words, ai_english, ai_korean, user_writing } = req.body as {
    words: string[];
    ai_english: string;
    ai_korean: string;
    user_writing: string;
  };
  if (!Array.isArray(words) || !ai_english) {
    return res.status(400).json({ error: "words, ai_english required" });
  }
  try {
    await pool.execute(
      `INSERT INTO user_compositions (user_id, words, ai_english, ai_korean, user_writing) VALUES (?, ?, ?, ?, ?)`,
      [userId, JSON.stringify(words), ai_english, ai_korean || "", user_writing || ""]
    );
    return res.json({ saved: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ── Root ──
app.get("/", (_req, res) => {
  res.json({
    name: "TOEIC API",
    version: "1.0.0",
    status: "running",
    endpoints: {
      health: "/api/health",
      metrics: "/api/metrics",
      docs: "POST /api/login, GET /api/words/today, POST /api/word/practice ...",
    },
  });
});

// ── Health ──
app.get("/api/health", (_req, res) => {
  const voca = loadVoca();
  res.json({
    status: "ok",
    vocaCount: voca.length,
    ollamaUrl: process.env.OLLAMA_URL || "http://127.0.0.1:11434",
    ollamaModel: process.env.OLLAMA_MODEL || "phi3:mini",
  });
});

app.get("/api/health/ollama", async (_req, res) => {
  const baseUrl = (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace("localhost", "127.0.0.1");
  try {
    const r = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) {
      return res.status(502).json({ ok: false, error: `Ollama returned ${r.status}`, url: baseUrl });
    }
    const data = (await r.json()) as { models?: { name: string }[] };
    const models = data.models?.map((m) => m.name) ?? [];
    const genModel = process.env.OLLAMA_MODEL || "phi3:mini";
    const transModel = process.env.OLLAMA_TRANSLATION_MODEL || "qwen2:1.5b";
    return res.json({
      ok: true,
      url: baseUrl,
      models,
      generationModel: genModel,
      translationModel: transModel,
      generationReady: models.some((n) => n === genModel || n.startsWith(genModel + ":")),
      translationReady: models.some((n) => n === transModel || n.startsWith(transModel + ":")),
    });
  } catch (err: any) {
    return res.status(502).json({
      ok: false,
      error: err.message || String(err),
      url: baseUrl,
      hint: "Ollama가 실행 중인지 확인: ollama serve",
    });
  }
});

// ── Metrics (오토스케일러용) ──
app.get("/api/metrics", (_req, res) => {
  resetWindowIfNeeded();
  const cpus = os.cpus();
  const loadAvg = os.loadavg();
  const elapsed = Math.max(Date.now() - metrics.windowStart, 1);
  const rpm = Math.round((metrics.requestsInWindow / elapsed) * 60_000);
  const avgResponseTime = metrics.requestsInWindow > 0
    ? Math.round(metrics.totalResponseTime / metrics.requestsInWindow)
    : 0;

  res.json({
    pid: process.pid,
    uptime: Math.round(process.uptime()),
    cpuCount: cpus.length,
    loadAvg: { "1m": loadAvg[0], "5m": loadAvg[1], "15m": loadAvg[2] },
    memory: {
      totalMB: Math.round(os.totalmem() / 1048576),
      freeMB: Math.round(os.freemem() / 1048576),
      processRSS_MB: Math.round(process.memoryUsage().rss / 1048576),
    },
    requests: {
      rpm,
      activeConnections: metrics.activeConnections,
      totalRequests: metrics.totalRequests,
      avgResponseTimeMs: avgResponseTime,
    },
    ai: {
      pendingQueue: aiSemaphore.pending,
    },
  });
});

// ── Global error handler ──
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[unhandled]", err);
  res.status(500).json({ error: "서버 내부 오류가 발생했습니다" });
});

// ── Start + Graceful Shutdown ──
const server = app.listen(PORT, "0.0.0.0", async () => {
  await ensureTable();
  loadVoca();
  console.log(`[api] listening on http://0.0.0.0:${PORT}`);
  console.log(`[api] connection pool: ${30} max, AI concurrency: ${Number(process.env.AI_CONCURRENCY) || 5}`);
});

server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

async function gracefulShutdown(signal: string) {
  console.log(`[api] ${signal} received, shutting down gracefully...`);
  server.close(async () => {
    console.log("[api] HTTP server closed");
    try {
      await pool.end();
      console.log("[api] DB pool closed");
    } catch (err) {
      console.error("[api] DB pool close error:", err);
    }
    process.exit(0);
  });

  setTimeout(() => {
    console.error("[api] Forced shutdown after timeout");
    process.exit(1);
  }, 10_000);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
  console.error("[api] unhandledRejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("[api] uncaughtException:", err);
  gracefulShutdown("uncaughtException");
});
