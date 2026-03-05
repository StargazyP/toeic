import "dotenv/config";
import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import mysql from "mysql2/promise";
import { pickRandomWords, loadVoca } from "./voca";
import { generateWordPractice } from "./wordPractice";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT) || 4000;
const JWT_SECRET = process.env.JWT_SECRET || "toeic-secret";

// ── MySQL pool ──
const pool = mysql.createPool({
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT) || 3308,
  user: process.env.DB_USER || "toeic",
  password: process.env.DB_PASS || "toeicpassword",
  database: process.env.DB_NAME || "toeic",
  waitForConnections: true,
  connectionLimit: 5,
});

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
        studied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_user_status (user_id, status),
        INDEX idx_user_word (user_id, word)
      )
    `);
    console.log("[db] user_words table ready");
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

// ── Auth routes ──
app.post("/api/register", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: "username/password required" });
    }
    const hashed = await bcrypt.hash(password, 10);
    const [result] = await pool.execute(
      "INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)",
      [username, hashed, username]
    );
    const [rows] = await pool.execute(
      "SELECT id, email, name FROM users WHERE email = ?",
      [username]
    );
    const created = (rows as any[])[0];
    const token = jwt.sign({ id: created.id, email: created.email }, JWT_SECRET, { expiresIn: "30d" });
    return res.json({ token, user: { id: created.id, username: created.email } });
  } catch (err: any) {
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ error: "이미 존재하는 아이디입니다" });
    }
    return res.status(500).json({ error: err.message });
  }
});

app.post("/api/login", async (req, res) => {
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

// ── Word Practice (Ollama / OpenAI) ──
app.post("/api/word/practice", async (req, res) => {
  const { word } = req.body;
  if (!word || typeof word !== "string") {
    return res.status(400).json({ error: "word is required" });
  }
  try {
    const result = await generateWordPractice(word.trim());
    return res.json(result);
  } catch (err: any) {
    console.error("[word/practice] error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ── User Words (학습 기록) ──
app.post("/api/words/save", authMiddleware, async (req, res) => {
  const userId = (req as any).userId;
  const { words } = req.body as {
    words: { word: string; meaning: string; pos: string; status: "known" | "unknown" }[];
  };
  if (!Array.isArray(words) || words.length === 0) {
    return res.status(400).json({ error: "words array required" });
  }
  try {
    const values = words.map((w) => [userId, w.word, w.meaning || "", w.pos || "", w.status]);
    const placeholders = values.map(() => "(?, ?, ?, ?, ?)").join(", ");
    await pool.execute(
      `INSERT INTO user_words (user_id, word, meaning, pos, status) VALUES ${placeholders}`,
      values.flat()
    );
    return res.json({ saved: words.length });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

app.get("/api/words/my", authMiddleware, async (req, res) => {
  const userId = (req as any).userId;
  try {
    const [rows] = await pool.execute(
      `SELECT word, meaning, pos, status, studied_at
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

// ── Start ──
app.listen(PORT, "0.0.0.0", async () => {
  await ensureTable();
  loadVoca();
  console.log(`[api] listening on http://0.0.0.0:${PORT}`);
});
