import * as fs from "fs";
import * as path from "path";

export type VocaItem = {
  word: string;
  pos: string[];
  level: string[];
  meaningKo?: string;
};

export type Word = {
  id: number;
  word: string;
  meaning: string;
  pos: string;
};

let vocaCache: VocaItem[] | null = null;

function getVocaPath(): string | null {
  const candidates = [
    process.env.VOCA_JSON_PATH,
    path.join(__dirname, "..", "..", "toeic.json"),
    path.join(process.cwd(), "..", "toeic.json"),
    path.join(process.cwd(), "toeic.json"),
  ].filter(Boolean) as string[];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function loadVoca(): VocaItem[] {
  if (vocaCache) return vocaCache;

  const filePath = getVocaPath();
  if (!filePath) {
    console.warn("[voca] toeic.json not found");
    return [];
  }

  const raw = fs.readFileSync(filePath, "utf-8");
  vocaCache = JSON.parse(raw) as VocaItem[];
  console.log(`[voca] loaded ${vocaCache.length} words from ${filePath}`);
  return vocaCache;
}

function toWordItem(v: VocaItem, i: number): Word {
  return {
    id: i,
    word: v.word,
    meaning: v.meaningKo || v.word,
    pos: v.pos.join(", "),
  };
}

/** toeic.json에서 단어 정보 조회 (의미, 품사) */
export function lookupWord(word: string): { meaningKo: string; pos: string } | null {
  const voca = loadVoca();
  const w = word.trim().toLowerCase();
  const item = voca.find((v) => v.word.toLowerCase() === w);
  if (!item) return null;
  return {
    meaningKo: item.meaningKo || "",
    pos: item.pos?.join(", ") || "",
  };
}

export function pickRandomWords(count: number, excludeWords?: string[]): Word[] {
  const all = loadVoca();
  if (all.length === 0) return [];

  const excludeSet = new Set((excludeWords || []).map((w) => w.toLowerCase()));
  const candidates = all
    .map((v, i) => ({ v, i }))
    .filter(({ v }) => !excludeSet.has(v.word.toLowerCase()));

  if (candidates.length === 0) return [];

  const n = Math.min(count, candidates.length);
  const indices = new Set<number>();
  while (indices.size < n) {
    indices.add(Math.floor(Math.random() * candidates.length));
  }

  return Array.from(indices).map((idx) => {
    const { v, i } = candidates[idx];
    return toWordItem(v, i);
  });
}
