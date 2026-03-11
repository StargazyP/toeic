import { lookupWord } from "./voca";

export type WordPracticeResult = {
  examples: { en: string; ko: string }[];
};

type WordContext = { meaningKo?: string; pos?: string };

/** 예문에 입력 단어가 포함되었는지 검증 */
function containsWord(text: string, word: string): boolean {
  const w = word.toLowerCase().trim();
  const lower = text.toLowerCase();
  const variants = [
    w,
    w + "s",
    w + "ed",
    w + "ing",
    w.replace(/e$/, "") + "ed",
    w.replace(/e$/, "") + "ing",
    w.replace(/y$/, "i") + "ed",
    w.replace(/y$/, "i") + "es",
  ].filter((s) => s.length >= 3);
  return variants.some((v) => lower.includes(v));
}

function buildPrompt(word: string, context?: WordContext): string {
  const w = word.trim();
  const meaning = context?.meaningKo ? ` (한국어: ${context.meaningKo})` : "";
  const pos = context?.pos ? ` [품사: ${context.pos}]` : "";

  return `Generate for the word "${w}"${meaning}${pos}.

RULES:
- 10 example sentences in ENGLISH only. EACH must contain "${w}" (or joined/joins/joining etc).
- Business/TOEIC context. Keep each sentence SHORT: 10-15 words maximum.
- Simple, clear sentences. No long complex clauses.

Output ONLY valid JSON:
{"examples":[{"en":"..."},{"en":"..."},{"en":"..."},{"en":"..."},{"en":"..."},{"en":"..."},{"en":"..."},{"en":"..."},{"en":"..."},{"en":"..."}]}`;
}

function normalizeResult(parsed: any): WordPracticeResult | null {
  if (!parsed?.examples) return null;

  const toEnKo = (item: any): { en: string; ko: string } | null => {
    if (typeof item === "string") return { en: item, ko: "" };
    if (item && typeof item.en === "string") return { en: item.en, ko: item.ko || "" };
    return null;
  };

  const examples = (parsed.examples as any[]).map(toEnKo).filter(Boolean) as { en: string; ko: string }[];
  if (examples.length >= 2) return { examples };
  return null;
}

/** 예문 생성용 (phi3:mini) - 영어만 생성, num_predict 2000(10개 확보), temperature 0.5 */
const OLLAMA_GENERATION_OPTIONS = {
  num_predict: 2000,
  temperature: 0.5,
  top_p: 0.9,
  repeat_penalty: 1.15,
};

/** 번역용 (qwen2:1.5b) - num_predict 200(긴 문장 대비), temperature 0.2 */
const OLLAMA_TRANSLATION_OPTIONS = {
  num_predict: 200,
  temperature: 0.2,
};

function getOllamaBaseUrl(): string {
  return (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace("localhost", "127.0.0.1");
}

/** JSON 파싱 실패 시 정규식으로 examples 추출 (en만 있어도 됨) */
function parseJsonFallback(text: string): { examples: { en: string; ko: string }[] } | null {
  const fixSection = (s: string) => s.replace(/\bde:\s*"([^"]*)"/g, '"en": "$1"').replace(/\bde:\s*([A-Z][^"\]}]*)/g, '"en": "$1"');
  const extractEnKo = (section: string): { en: string; ko: string }[] => {
    const fixed = fixSection(section);
    const items: { en: string; ko: string }[] = [];
    const re = /"en"\s*:\s*"((?:[^"\\]|\\.)*)"?\s*(?:,?\s*"ko"\s*:\s*"((?:[^"\\]|\\.)*)"?)?/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(fixed)) !== null) {
      const en = m[1].replace(/\\"/g, '"').trim();
      const ko = (m[2] || "").replace(/\\"/g, '"').trim();
      if (en.length >= 5) items.push({ en, ko });
    }
    if (items.length < 2) {
      const enOnlyRe = /"en"\s*:\s*"([^"]+)"/g;
      while ((m = enOnlyRe.exec(fixed)) !== null) {
        if (m[1] && m[1].length >= 5) items.push({ en: m[1].trim(), ko: "" });
      }
    }
    if (items.length < 2) {
      const altRe = /"en"\s*:\s*"([^"]+)"|"ko"\s*:\s*"([^"]*)"?/g;
      let en = "";
      let ko = "";
      while ((m = altRe.exec(fixed)) !== null) {
        if (m[1]) en = m[1].trim();
        if (m[2] !== undefined) ko = (m[2] || "").trim();
        if (en.length >= 5) {
          items.push({ en, ko });
          en = "";
          ko = "";
        }
      }
    }
    return items;
  };
  let section = "";
  const completeMatch = text.match(/"examples"\s*:\s*\[([\s\S]*?)\]/);
  if (completeMatch) {
    section = completeMatch[1] || "";
  } else {
    const truncatedMatch = text.match(/"examples"\s*:\s*\[([\s\S]*)$/);
    if (truncatedMatch) section = truncatedMatch[1] || "";
  }
  if (!section) return null;
  const examples = extractEnKo(section);
  if (examples.length >= 2) return { examples };
  return null;
}

async function translateEnToKo(enText: string): Promise<string> {
  const baseUrl = getOllamaBaseUrl();
  const model = process.env.OLLAMA_TRANSLATION_MODEL || "qwen2:1.5b";

  const res = await fetch(`${baseUrl}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      prompt: `Translate this English sentence to Korean. Output ONLY the Korean translation. Use only Korean (한글) characters. No Chinese or Japanese.\n\n${enText}`,
      stream: false,
      options: OLLAMA_TRANSLATION_OPTIONS,
    }),
  });

  if (!res.ok) throw new Error(`Ollama translation failed: ${res.status}`);
  const data = (await res.json()) as { response?: string };
  return (data.response || "").trim();
}

async function translateResultKo(result: WordPracticeResult): Promise<WordPracticeResult> {
  const examples = await Promise.all(
    result.examples.map(async (item) => {
      try {
        const ko = await translateEnToKo(item.en);
        return { en: item.en, ko: ko || item.ko };
      } catch (err) {
        console.warn("[wordPractice] Translation failed:", item.en.slice(0, 30), err);
        return item;
      }
    })
  );
  return { examples };
}

async function callOllama(word: string, context?: WordContext): Promise<WordPracticeResult> {
  const baseUrl = getOllamaBaseUrl();
  const model = process.env.OLLAMA_MODEL || "phi3:mini";
  const w = word.trim();

  console.log(`[wordPractice] Calling Ollama ${baseUrl} model=${model}`);

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 120_000);
  const res = await fetch(`${baseUrl}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      prompt: buildPrompt(w, context),
      stream: false,
      options: OLLAMA_GENERATION_OPTIONS,
    }),
    signal: ctrl.signal,
  }).finally(() => clearTimeout(t));

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`Ollama 오류 (${res.status}): ${errBody.slice(0, 150) || res.statusText}`);
  }

  const data = (await res.json()) as { response?: string; error?: string };
  if (data.error) {
    console.warn("[wordPractice] Ollama error field:", data.error);
    throw new Error(`Ollama 오류: ${data.error}`);
  }
  const text = data.response || "";
  if (!text.trim()) {
    console.warn("[wordPractice] Empty response from Ollama");
    throw new Error(`예문 생성 실패. (Ollama가 빈 응답을 반환했습니다)`);
  }

  let jsonStr: string | null = null;
  const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (codeBlock) {
    jsonStr = codeBlock[1].trim();
  } else {
    const objMatch = text.match(/\{[\s\S]*"examples"\s*:\s*\[[\s\S]*\}/) || text.match(/\{[\s\S]*"examples"[\s\S]*/);
    jsonStr = objMatch ? objMatch[0] : null;
  }
  if (!jsonStr) {
    const braceStart = text.indexOf("{");
    if (braceStart >= 0) {
      const braceEnd = text.lastIndexOf("}") + 1;
      if (braceEnd > braceStart) {
        jsonStr = text.slice(braceStart, braceEnd);
      } else {
        jsonStr = text.slice(braceStart);
      }
    }
  }

  if (!jsonStr) {
    console.warn("[wordPractice] No JSON. Response length:", text.length, "Preview:", text.slice(0, 400));
    throw new Error(`예문 생성 실패. (phi3 응답에서 JSON을 찾을 수 없음)`);
  }

  // phi3 오타/잘림 복구
  jsonStr = jsonStr
    .replace(/"nde"\s*:/g, '"en":')
    .replace(/"de"\s*:/g, '"en":')
    .replace(/\bde:\s*"/g, '"en": "')
    .replace(/\bde:\s*(.+)$/gm, (_, rest) => `"en": "${rest.trim().replace(/\"$/, "")}"`);

  // 잘린 JSON 수리: 끝이 } 가 아니면 닫기
  const trimmed = jsonStr.trim();
  const needsClose =
    !trimmed.endsWith("}") ||
    trimmed.endsWith(" ") ||
    trimmed.endsWith("\n") ||
    /[a-zA-Z가-힣0-9]\s*$/.test(trimmed);
  if (needsClose) {
    let fix = trimmed;
    if (!fix.endsWith('"') && !fix.endsWith("}") && !fix.endsWith("]")) fix += '"';
    if (!fix.includes(']')) fix += "}]}";
    const openBraces = (fix.match(/\{/g) || []).length;
    const closeBraces = (fix.match(/\}/g) || []).length;
    const openBrackets = (fix.match(/\[/g) || []).length;
    const closeBrackets = (fix.match(/\]/g) || []).length;
    for (let i = closeBrackets; i < openBrackets; i++) fix += "]";
    for (let i = closeBraces; i < openBraces; i++) fix += "}";
    jsonStr = fix;
  }

  let parsed: any;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    const fallback = parseJsonFallback(jsonStr) || parseJsonFallback(text);
    if (fallback) {
      parsed = fallback;
    } else {
      console.warn("[wordPractice] JSON parse error:", (e as Error).message, "Preview:", jsonStr.slice(0, 300));
      throw new Error(`예문 생성 실패. (JSON 형식 오류)`);
    }
  }

  let result = normalizeResult(parsed);
  if (!result) throw new Error(`예문 생성 실패.`);

  const validExamples = result.examples.filter((ex) => containsWord(ex.en, w));
  if (validExamples.length < 2) {
    const bad = result.examples.find((ex) => !containsWord(ex.en, w));
    if (bad) console.warn("[wordPractice] Example missing word:", bad.en.slice(0, 60), "| word:", w);
    throw new Error(`예문에 "${w}"가 포함되지 않았습니다. 다시 시도해 주세요.`);
  }
  result = { ...result, examples: validExamples };

  // phi3 한국어 품질이 낮으므로 qwen2로 항상 영→한 번역
  return await translateResultKo(result);
}

async function callOpenAI(word: string, context?: WordContext): Promise<WordPracticeResult> {
  const apiKey = process.env.OPENAI_API_KEY!;
  const w = word.trim();

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: buildPrompt(w, context) }],
      temperature: 0.5,
      max_tokens: 500,
    }),
  });

  if (!res.ok) throw new Error(`OpenAI error: ${res.status}`);

  const data = (await res.json()) as any;
  const text = data.choices?.[0]?.message?.content || "";
  const objMatch = text.match(/\{[\s\S]*"examples"[\s\S]*\}/);
  if (!objMatch) throw new Error(`예문 생성 실패.`);

  const parsed = JSON.parse(objMatch[0]);
  const result = normalizeResult(parsed);
  if (!result) throw new Error(`예문 생성 실패.`);

  for (const ex of result.examples) {
    if (!containsWord(ex.en, w)) {
      throw new Error(`예문에 "${w}"가 포함되지 않았습니다. 다시 시도해 주세요.`);
    }
  }

  return await translateResultKo(result);
}

export type CompositionResult = {
  english: string;
  korean: string;
};

function buildCompositionPrompt(words: string[]): string {
  const list = words.join(", ");
  return `Write a short English paragraph (5-8 sentences) using ALL of these words: ${list}

RULES:
- Business/TOEIC context.
- Use simple, clear sentences. Each sentence 10-20 words.
- Every word from the list MUST appear at least once.
- Output ONLY valid JSON:
{"english":"...the paragraph..."}`;
}

async function callOllamaComposition(words: string[]): Promise<CompositionResult> {
  const baseUrl = getOllamaBaseUrl();
  const model = process.env.OLLAMA_MODEL || "phi3:mini";

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 120_000);
  const res = await fetch(`${baseUrl}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      prompt: buildCompositionPrompt(words),
      stream: false,
      options: { num_predict: 1000, temperature: 0.6, top_p: 0.9 },
    }),
    signal: ctrl.signal,
  }).finally(() => clearTimeout(t));

  if (!res.ok) throw new Error(`Ollama 오류 (${res.status})`);
  const data = (await res.json()) as { response?: string };
  const text = data.response || "";

  let english = "";
  try {
    const jsonMatch = text.match(/\{[\s\S]*"english"\s*:\s*"([\s\S]*?)"\s*\}/);
    if (jsonMatch) {
      english = jsonMatch[1].replace(/\\n/g, "\n").replace(/\\"/g, '"');
    }
  } catch {}
  if (!english) {
    english = text.replace(/```[\s\S]*?```/g, "").replace(/\{[\s\S]*?\}/g, "").trim();
    if (!english) english = text.trim();
  }
  if (english.length < 20) throw new Error("작문 생성 실패 (응답이 너무 짧습니다)");

  let korean = "";
  try {
    korean = await translateEnToKo(english);
  } catch {
    korean = "";
  }

  return { english, korean };
}

export async function generateComposition(words: string[]): Promise<CompositionResult> {
  if (!words.length) throw new Error("단어 목록이 필요합니다.");

  try {
    return await callOllamaComposition(words);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[composition] Ollama failed:", msg);
    throw new Error(`작문 생성에 실패했습니다. ${msg}`);
  }
}

export type QuizSentenceItem = {
  word: string;
  sentences: { original: string; blanked: string }[];
};

function buildQuizPrompt(words: string[]): string {
  const list = words.map((w) => `"${w}"`).join(", ");
  return `Generate 2 short English sentences for EACH word: ${list}

RULES:
- Each sentence MUST contain the EXACT target word (not variants).
- Business/TOEIC context. 8-14 words per sentence. Simple grammar.
- Output ONLY valid JSON array:
[{"word":"...","s1":"...","s2":"..."},{"word":"...","s1":"...","s2":"..."}]`;
}

function blankOutWord(sentence: string, word: string): string {
  const re = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
  return sentence.replace(re, "____");
}

async function callOllamaQuiz(words: string[]): Promise<QuizSentenceItem[]> {
  const baseUrl = getOllamaBaseUrl();
  const model = process.env.OLLAMA_MODEL || "phi3:mini";

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 120_000);
  const res = await fetch(`${baseUrl}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      prompt: buildQuizPrompt(words),
      stream: false,
      options: { num_predict: 2000, temperature: 0.5, top_p: 0.9, repeat_penalty: 1.15 },
    }),
    signal: ctrl.signal,
  }).finally(() => clearTimeout(t));

  if (!res.ok) throw new Error(`Ollama 오류 (${res.status})`);
  const data = (await res.json()) as { response?: string };
  const text = data.response || "";

  let parsed: any[] = [];
  try {
    const arrMatch = text.match(/\[[\s\S]*\]/);
    if (arrMatch) parsed = JSON.parse(arrMatch[0]);
  } catch {
    const items: any[] = [];
    const re = /\{\s*"word"\s*:\s*"([^"]+)"\s*,\s*"s1"\s*:\s*"([^"]+)"\s*,\s*"s2"\s*:\s*"([^"]+)"\s*\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      items.push({ word: m[1], s1: m[2], s2: m[3] });
    }
    parsed = items;
  }

  const result: QuizSentenceItem[] = [];
  const wordSet = new Map(words.map((w) => [w.toLowerCase(), w]));

  for (const item of parsed) {
    const w = wordSet.get(item.word?.toLowerCase());
    if (!w) continue;
    const sArr: { original: string; blanked: string }[] = [];
    for (const key of ["s1", "s2"]) {
      const sent = item[key];
      if (typeof sent === "string" && sent.length > 10) {
        const blanked = blankOutWord(sent, w);
        if (blanked !== sent) {
          sArr.push({ original: sent, blanked });
        }
      }
    }
    if (sArr.length > 0) result.push({ word: w, sentences: sArr });
    wordSet.delete(w.toLowerCase());
  }

  if (result.length < words.length) {
    for (const [, w] of wordSet) {
      result.push({
        word: w,
        sentences: [
          { original: `The company will ${w} the new product next month.`, blanked: `The company will ____ the new product next month.` },
          { original: `We need to ${w} before the deadline.`, blanked: `We need to ____ before the deadline.` },
        ],
      });
    }
  }

  return result;
}

export async function generateQuizSentences(words: string[]): Promise<QuizSentenceItem[]> {
  if (!words.length) throw new Error("단어 목록이 필요합니다.");
  try {
    return await callOllamaQuiz(words);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[quiz] Ollama failed:", msg);
    throw new Error(`퀴즈 문장 생성에 실패했습니다. ${msg}`);
  }
}

export async function generateWordPractice(word: string): Promise<WordPracticeResult> {
  const trimmed = word.trim();
  if (!trimmed) throw new Error("단어를 입력해 주세요.");

  const context = lookupWord(trimmed) ?? undefined;
  if (context) {
    console.log(`[wordPractice] "${trimmed}" (${context.meaningKo}, ${context.pos})`);
  }

  let lastError: Error | null = null;

  const ollamaUrl = process.env.OLLAMA_URL || "http://localhost:11434";
  try {
    return await callOllama(trimmed, context);
  } catch (err) {
    lastError = err instanceof Error ? err : new Error(String(err));
    console.warn("[wordPractice] Ollama failed:", lastError.message);
  }

  if (process.env.OPENAI_API_KEY) {
    try {
      return await callOpenAI(trimmed, context);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn("[wordPractice] OpenAI failed:", lastError.message);
    }
  }

  const msg = lastError?.message || "알 수 없는 오류";
  const base = getOllamaBaseUrl();
  throw new Error(`예문 생성에 실패했습니다. ${msg} (Ollama 실행 확인: ollama serve → ${base})`);
}
