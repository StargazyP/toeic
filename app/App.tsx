import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  ScrollView,
  Platform,
  ActivityIndicator,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Speech from "expo-speech";

const API_BASE =
  process.env.EXPO_PUBLIC_API_URL || "http://jangdonggun.iptime.org:4000";

const STORAGE_KEY_TOKEN = "toeic_token";
const STORAGE_KEY_DAILY_COUNT = "toeic_daily_count";

type Word = { id: number; word: string; meaning: string; pos: string };

type QuizResultItem = {
  word: string;
  meaning: string;
  pos: string;
  quiz_type: string;
  prompt: string;
  user_answer: string;
  correct_answer: string;
  is_correct: boolean;
};

// ─── Web hover style injection ───
function WebStyleInjector() {
  if (Platform.OS !== "web") return null;
  return (
    <style
      dangerouslySetInnerHTML={{
        __html: `
          * { box-sizing: border-box; }
          body { margin: 0; background: #FFFFFF; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
          input:focus { outline: none; border-color: #000000 !important; }
          ::-webkit-scrollbar { width: 6px; height: 6px; }
          ::-webkit-scrollbar-track { background: #fafafa; border-radius: 3px; }
          ::-webkit-scrollbar-thumb { background: #e8e8e8; border-radius: 3px; transition: background 0.2s ease; }
          ::-webkit-scrollbar-thumb:hover { background: #d8d8d8; }
          * { scrollbar-width: thin; scrollbar-color: #e8e8e8 #fafafa; }
          [role="button"], button, a { transition: all 0.8s cubic-bezier(0.25, 0.1, 0.25, 1); }
          div[role="button"] { transition: background-color 0.8s cubic-bezier(0.25, 0.1, 0.25, 1), border-color 0.8s cubic-bezier(0.25, 0.1, 0.25, 1), opacity 0.8s cubic-bezier(0.25, 0.1, 0.25, 1); }
        `,
      }}
    />
  ) as any;
}

// ─── Hover Button ───
function HoverButton({
  onPress,
  style,
  hoverStyle,
  children,
  disabled,
}: {
  onPress: () => void;
  style?: any;
  hoverStyle?: any;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      disabled={disabled}
      style={[style, hovered && (hoverStyle || s.hoverDefault)]}
    >
      {children}
    </Pressable>
  );
}

// ─────────────────── App ───────────────────

export default function App() {
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState("");

  const [dailyCount, setDailyCount] = useState<number | null>(null);
  const [words, setWords] = useState<Word[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [showMeaning, setShowMeaning] = useState(false);
  const [sessionFinished, setSessionFinished] = useState(false);
  const [wordsError, setWordsError] = useState("");

  const [showWordPractice, setShowWordPractice] = useState(false);
  const [showPracticeWrite, setShowPracticeWrite] = useState(false);
  const [showMyWords, setShowMyWords] = useState(false);
  const [practiceWriteData, setPracticeWriteData] = useState<{
    id: number;
    word: string;
    examples: { en: string; ko: string }[];
    user_english: string[];
  } | null>(null);
  const [showCountInput, setShowCountInput] = useState(false);
  const [showQuiz, setShowQuiz] = useState(false);
  const [quizResults, setQuizResults] = useState<QuizResultItem[]>([]);
  const [showComposition, setShowComposition] = useState(false);

  useEffect(() => {
    (async () => {
      const saved = await AsyncStorage.getItem(STORAGE_KEY_TOKEN);
      if (saved) setToken(saved);
      setLoading(false);
    })();
  }, []);

  const handleAuth = useCallback(async () => {
    setAuthError("");
    try {
      const endpoint = authMode === "login" ? "/api/login" : "/api/register";
      const res = await fetch(`${API_BASE}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Auth failed");
      await AsyncStorage.setItem(STORAGE_KEY_TOKEN, data.token);
      setToken(data.token);
    } catch (err: any) {
      setAuthError(err.message);
    }
  }, [authMode, username, password]);

  const handleLogout = useCallback(async () => {
    await AsyncStorage.multiRemove([STORAGE_KEY_TOKEN, STORAGE_KEY_DAILY_COUNT]);
    setToken(null);
    setDailyCount(null);
    setWords([]);
    setSessionFinished(false);
    setShowWordPractice(false);
    setShowMyWords(false);
    setShowCountInput(false);
  }, []);

  const prepareSession = useCallback(async (count: number) => {
    setWordsError("");
    setLoading(true);
    try {
      const headers: Record<string, string> = {};
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const res = await fetch(
        `${API_BASE}/api/words/today?count=${count}&_=${Date.now()}`,
        { cache: "no-store" as any, headers }
      );
      const data = await res.json();
      if (!res.ok || !Array.isArray(data.words) || data.words.length === 0) {
        throw new Error("학습할 새 단어가 없습니다");
      }
      setWords(data.words);
      setCurrentIndex(0);
      setShowMeaning(false);
      setSessionFinished(false);
    } catch (err: any) {
      setWordsError(err.message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  const handleSelectDailyCount = useCallback(
    async (count: number) => {
      setDailyCount(count);
      await AsyncStorage.setItem(STORAGE_KEY_DAILY_COUNT, String(count));
      await prepareSession(count);
    },
    [prepareSession]
  );

  const handleGoBackToStart = useCallback(async () => {
    await AsyncStorage.removeItem(STORAGE_KEY_DAILY_COUNT);
    setDailyCount(null);
    setWords([]);
    setCurrentIndex(0);
    setSessionFinished(false);
    setShowWordPractice(false);
    setShowMyWords(false);
    setShowCountInput(false);
    setShowQuiz(false);
    setQuizResults([]);
    setShowComposition(false);
  }, []);

  const handleNext = useCallback(() => {
    if (currentIndex + 1 >= words.length) {
      setSessionFinished(true);
    } else {
      setCurrentIndex((i) => i + 1);
      setShowMeaning(false);
    }
  }, [currentIndex, words]);

  // ── Render ──

  if (loading) {
    return (
      <View style={s.center}>
        <WebStyleInjector />
        <ActivityIndicator size="large" color="#000000" />
      </View>
    );
  }

  // ── Auth ──
  if (!token) {
    return (
      <View style={s.page}>
        <WebStyleInjector />
        <View style={s.authCard}>
          <Text style={s.logo}>TOEIC</Text>
          <Text style={s.authTitle}>
            {authMode === "login" ? "로그인" : "회원가입"}
          </Text>

          <View style={s.fieldGroup}>
            <Text style={s.label}>아이디</Text>
            <TextInput
              style={s.input}
              placeholder="아이디를 입력하세요"
              placeholderTextColor="#C4C4C4"
              value={username}
              onChangeText={setUsername}
              autoCapitalize="none"
            />
          </View>
          <View style={s.fieldGroup}>
            <Text style={s.label}>비밀번호</Text>
            <TextInput
              style={s.input}
              placeholder="비밀번호를 입력하세요"
              placeholderTextColor="#C4C4C4"
              value={password}
              onChangeText={setPassword}
              secureTextEntry
            />
          </View>

          {!!authError && <Text style={s.errorText}>{authError}</Text>}

          <HoverButton
            onPress={handleAuth}
            style={s.btnPrimary}
            hoverStyle={s.btnPrimaryHover}
          >
            <Text style={s.btnPrimaryText}>
              {authMode === "login" ? "로그인" : "회원가입"}
            </Text>
          </HoverButton>

          <HoverButton
            onPress={() =>
              setAuthMode((m) => (m === "login" ? "register" : "login"))
            }
            style={s.linkWrap}
            hoverStyle={{ opacity: 0.6 }}
          >
            <Text style={s.linkText}>
              {authMode === "login"
                ? "계정이 없으신가요? 회원가입"
                : "이미 계정이 있으신가요? 로그인"}
            </Text>
          </HoverButton>
        </View>
      </View>
    );
  }

  // ── 연습 작성 전용 페이지 ──
  if (showPracticeWrite && practiceWriteData) {
    return (
      <>
        <WebStyleInjector />
        <PracticeWriteScreen
          token={token}
          practiceData={practiceWriteData}
          onBack={() => {
            setShowPracticeWrite(false);
            setPracticeWriteData(null);
            setShowMyWords(true);
          }}
        />
      </>
    );
  }

  // ── Word Practice (새 연습 생성) ──
  if (showWordPractice) {
    return (
      <>
        <WebStyleInjector />
        <WordPracticeScreen
          token={token}
          onBack={() => setShowWordPractice(false)}
        />
      </>
    );
  }

  // ── My Words ──
  if (showMyWords) {
    return (
      <>
        <WebStyleInjector />
        <MyWordsScreen
          token={token}
          onBack={() => setShowMyWords(false)}
          onOpenPracticeWrite={(p) => {
            setPracticeWriteData({
              id: p.id,
              word: p.word,
              examples: p.examples || [],
              user_english: p.user_english || [],
            });
            setShowMyWords(false);
            setShowPracticeWrite(true);
          }}
        />
      </>
    );
  }

  // ── Count Input Screen (Step 2) ──
  if (dailyCount === null && showCountInput) {
    return (
      <View style={s.page}>
        <WebStyleInjector />
        <TopBar onLogout={handleLogout} onMyWords={() => setShowMyWords(true)} />
        <CountInputScreen
          onSubmit={handleSelectDailyCount}
          onBack={() => setShowCountInput(false)}
        />
      </View>
    );
  }

  // ── Main Screen (Step 1) ──
  if (dailyCount === null) {
    return (
      <View style={s.page}>
        <WebStyleInjector />
        <TopBar onLogout={handleLogout} onMyWords={() => setShowMyWords(true)} />
        <MainScreen
          onNext={() => setShowCountInput(true)}
          onWordPractice={() => setShowWordPractice(true)}
        />
      </View>
    );
  }

  // ── Error ──
  if (wordsError) {
    return (
      <View style={s.page}>
        <WebStyleInjector />
        <TopBar onLogout={handleLogout} onMyWords={() => setShowMyWords(true)} />
        <View style={s.content}>
          <Text style={s.errorText}>{wordsError}</Text>
          <HoverButton
            onPress={() => prepareSession(dailyCount)}
            style={[s.btnPrimary, { marginTop: 12 }]}
            hoverStyle={s.btnPrimaryHover}
          >
            <Text style={s.btnPrimaryText}>다시 시도</Text>
          </HoverButton>
          <HoverButton
            onPress={handleGoBackToStart}
            style={[s.btnGhost, { marginTop: 8 }]}
            hoverStyle={s.btnGhostHover}
          >
            <Text style={s.btnGhostText}>뒤로 가기</Text>
          </HoverButton>
        </View>
      </View>
    );
  }

  // ── Composition (AI 작문 연습) ──
  if (sessionFinished && showComposition) {
    return (
      <>
        <WebStyleInjector />
        <CompositionScreen
          token={token}
          words={words}
          onBack={() => setShowComposition(false)}
          onHome={handleGoBackToStart}
        />
      </>
    );
  }

  // ── Quiz ──
  if (sessionFinished && showQuiz) {
    return (
      <>
        <WebStyleInjector />
        <QuizScreen
          token={token}
          words={words}
          onFinish={(results) => {
            setQuizResults(results);
            setShowQuiz(false);
          }}
          onBack={() => setShowQuiz(false)}
        />
      </>
    );
  }

  // ── Session Finished ──
  if (sessionFinished) {
    const quizCorrect = quizResults.filter((r) => r.is_correct).length;
    return (
      <View style={s.page}>
        <WebStyleInjector />
        <TopBar onLogout={handleLogout} onMyWords={() => setShowMyWords(true)} />
        <ScrollView
          style={s.scroll}
          contentContainerStyle={s.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          <Text style={s.heading}>단어 확인 완료</Text>
          <View style={s.statRow}>
            <View style={s.statBox}>
              <Text style={s.statNum}>{words.length}</Text>
              <Text style={s.statLabel}>학습 단어</Text>
            </View>
          </View>

          {quizResults.length > 0 && (
            <>
              <View style={s.statRow}>
                <View style={s.statBox}>
                  <Text style={s.statNum}>{quizResults.length}</Text>
                  <Text style={s.statLabel}>퀴즈 문제</Text>
                </View>
                <View style={s.statBox}>
                  <Text style={[s.statNum, { color: "#22C55E" }]}>{quizCorrect}</Text>
                  <Text style={s.statLabel}>정답</Text>
                </View>
                <View style={s.statBox}>
                  <Text style={[s.statNum, { color: "#EF4444" }]}>{quizResults.length - quizCorrect}</Text>
                  <Text style={s.statLabel}>오답</Text>
                </View>
              </View>

              {(() => {
                const byWord = new Map<string, QuizResultItem[]>();
                quizResults.forEach((r) => {
                  const arr = byWord.get(r.word) || [];
                  arr.push(r);
                  byWord.set(r.word, arr);
                });
                return (
                  <View style={s.listCard}>
                    <Text style={s.listTitle}>퀴즈 결과</Text>
                    {Array.from(byWord.entries()).map(([word, items], i, arr) => {
                      const allCorrect = items.every((r) => r.is_correct);
                      return (
                        <View key={word} style={[s.listRow, i === arr.length - 1 && { borderBottomWidth: 0 }]}>
                          <View style={{ flex: 1 }}>
                            <Text style={s.listWord}>{word}</Text>
                            <Text style={[s.listMeaning, { color: allCorrect ? "#22C55E" : "#EF4444" }]}>
                              {allCorrect ? "아는 단어" : "모르는 단어"}
                            </Text>
                          </View>
                          <Text style={[s.myWordBadge, allCorrect ? s.badgeKnown : s.badgeUnknown]}>
                            {allCorrect ? "O" : "X"}
                          </Text>
                        </View>
                      );
                    })}
                  </View>
                );
              })()}
            </>
          )}

          <View style={s.listCard}>
            <Text style={s.listTitle}>오늘 본 단어</Text>
            {words.map((w, i) => (
              <View key={w.id} style={[s.listRow, i === words.length - 1 && { borderBottomWidth: 0 }]}>
                <Text style={s.listWord}>{w.word}</Text>
                <Text style={s.listMeaning}>{w.meaning}</Text>
              </View>
            ))}
          </View>

          <View style={s.finishBtns}>
            {quizResults.length === 0 && (
              <HoverButton
                onPress={() => setShowQuiz(true)}
                style={s.btnPrimary}
                hoverStyle={s.btnPrimaryHover}
              >
                <Text style={s.btnPrimaryText}>퀴즈 풀기</Text>
              </HoverButton>
            )}
            <HoverButton
              onPress={handleGoBackToStart}
              style={s.btnOutline}
              hoverStyle={s.btnOutlineHover}
            >
              <Text style={s.btnOutlineText}>처음으로 돌아가기</Text>
            </HoverButton>
          </View>
        </ScrollView>
      </View>
    );
  }

  // ── Learning Card ──
  const currentWord = words[currentIndex];
  if (!currentWord) {
    return (
      <View style={s.center}>
        <WebStyleInjector />
        <ActivityIndicator size="large" color="#000000" />
        <Text style={s.loadingText}>단어를 불러오는 중...</Text>
      </View>
    );
  }

  return (
    <View style={s.page}>
      <WebStyleInjector />
      <TopBar onLogout={handleLogout} onMyWords={() => setShowMyWords(true)} />
      <View style={s.content}>
        <Text style={s.progress}>
          {currentIndex + 1} / {words.length}
        </Text>

        <View style={s.card}>
          <Text style={s.cardWord}>{currentWord.word}</Text>
          <Text style={s.cardPos}>{currentWord.pos}</Text>

          {showMeaning ? (
            <>
              <Text style={s.cardMeaning}>{currentWord.meaning}</Text>
              <HoverButton
                onPress={() => Speech.speak(currentWord.word, { language: "en-US", rate: 0.9 })}
                style={[s.ttsBtn, { marginTop: 16 }]}
                hoverStyle={s.ttsBtnHover}
              >
                <Text style={s.ttsBtnText}>🔊 발음 듣기</Text>
              </HoverButton>
            </>
          ) : (
            <HoverButton
              onPress={() => setShowMeaning(true)}
              style={s.meaningBtn}
              hoverStyle={s.meaningBtnHover}
            >
              <Text style={s.meaningBtnText}>뜻 보기</Text>
            </HoverButton>
          )}
        </View>

        <View style={s.choiceRow}>
          <HoverButton
            onPress={handleNext}
            style={[s.btnPrimary, { minWidth: 200, paddingHorizontal: 48 }]}
            hoverStyle={s.btnPrimaryHover}
          >
            <Text style={s.btnPrimaryText}>다음</Text>
          </HoverButton>
        </View>
      </View>
    </View>
  );
}

// ─────────── Top Bar ───────────

function TopBar({
  onLogout,
  onMyWords,
}: {
  onLogout: () => void;
  onMyWords?: () => void;
}) {
  return (
    <View style={s.topBar}>
      <Text style={s.topBarLogo}>TOEIC</Text>
      <View style={s.topBarRight}>
        {onMyWords && (
          <HoverButton
            onPress={onMyWords}
            style={s.topBarBtn}
            hoverStyle={s.topBarBtnHover}
          >
            <Text style={s.topBarBtnText}>나의 단어</Text>
          </HoverButton>
        )}
        <HoverButton
          onPress={onLogout}
          style={s.logoutBtn}
          hoverStyle={s.logoutBtnHover}
        >
          <Text style={s.logoutBtnText}>로그아웃</Text>
        </HoverButton>
      </View>
    </View>
  );
}

// ─────────── Main Screen (Step 1: Start) ───────────

function MainScreen({
  onNext,
  onWordPractice,
}: {
  onNext: () => void;
  onWordPractice: () => void;
}) {
  return (
    <View style={s.content}>
      <Text style={s.heading}>TOEIC 단어 학습</Text>
      <Text style={s.desc}>오늘도 단어를 학습해볼까요?</Text>

      <HoverButton
        onPress={onNext}
        style={s.startBtn}
        hoverStyle={s.startBtnHover}
      >
        <Text style={s.startBtnText}>시작</Text>
      </HoverButton>

      <View style={s.divider} />

      <HoverButton
        onPress={onWordPractice}
        style={s.btnOutline}
        hoverStyle={s.btnOutlineHover}
      >
        <Text style={s.btnOutlineText}>단어로 예시문·질문 만들기</Text>
      </HoverButton>
    </View>
  );
}

// ─────────── Count Input Screen (Step 2) ───────────

function CountInputScreen({
  onSubmit,
  onBack,
}: {
  onSubmit: (count: number) => void;
  onBack: () => void;
}) {
  const [inputValue, setInputValue] = useState("");

  const handleSubmit = useCallback(() => {
    const num = parseInt(inputValue, 10);
    if (!num || num < 1) return;
    onSubmit(Math.min(num, 50));
  }, [inputValue, onSubmit]);

  return (
    <View style={s.content}>
      <Text style={s.heading}>몇 개의 단어를 학습하시겠어요?</Text>
      <Text style={s.desc}>학습할 단어 수를 입력해주세요 (최대 50개)</Text>

      <View style={s.startInputRow}>
        <TextInput
          style={s.startInput}
          placeholder="예: 10"
          placeholderTextColor="#CCCCCC"
          value={inputValue}
          onChangeText={setInputValue}
          keyboardType="number-pad"
          onSubmitEditing={handleSubmit}
          maxLength={3}
          autoFocus
        />
        <HoverButton
          onPress={handleSubmit}
          style={s.startBtn}
          hoverStyle={s.startBtnHover}
        >
          <Text style={s.startBtnText}>전송</Text>
        </HoverButton>
      </View>

      <View style={{ marginTop: 20 }}>
        <HoverButton
          onPress={onBack}
          style={s.btnOutline}
          hoverStyle={s.btnOutlineHover}
        >
          <Text style={s.btnOutlineText}>뒤로가기</Text>
        </HoverButton>
      </View>
    </View>
  );
}

// ─────────── Word Practice Screen (새 연습 생성) ───────────

function WordPracticeScreen({ token, onBack }: { token: string | null; onBack: () => void }) {
  const [word, setWord] = useState("");
  const [result, setResult] = useState<{
    examples: { en: string; ko: string }[];
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [saveStatus, setSaveStatus] = useState<"" | "saving" | "saved" | "error">("");
  const [saveError, setSaveError] = useState("");
  const [step, setStep] = useState<"examples" | "writing">("examples");
  const [userEnglish, setUserEnglish] = useState<string[]>([]);

  const handleGenerate = useCallback(async () => {
    if (!word.trim()) return;
    setLoading(true);
    setError("");
    setResult(null);
    setSaveStatus("");
    setSaveError("");
    setStep("examples");
    try {
      const res = await fetch(`${API_BASE}/api/word/practice`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ word: word.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Generation failed");
      setResult(data);
      setUserEnglish((data.examples || []).map(() => ""));
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [word]);

  const handleGoToWriting = useCallback(() => {
    setStep("writing");
  }, []);

  const handleBackToExamples = useCallback(() => {
    setStep("examples");
  }, []);

  const handleEnglishChange = useCallback((index: number, text: string) => {
    setUserEnglish((prev) => {
      const next = [...prev];
      next[index] = text;
      return next;
    });
  }, []);

  const handleSave = useCallback(async () => {
    if (!token) {
      setSaveStatus("error");
      return;
    }
    if (!result?.examples?.length || !word.trim()) return;
    setSaveStatus("saving");
    setSaveError("");
    try {
      const res = await fetch(`${API_BASE}/api/practice/save`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          word: word.trim(),
          examples: result.examples,
          user_english: result.examples.map((_, i) => userEnglish[i] ?? ""),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "저장 실패");
      setSaveStatus("saved");
    } catch (err: any) {
      setSaveStatus("error");
      setSaveError(err.message || "저장 실패");
    }
  }, [token, word, result, userEnglish]);

  return (
    <View style={s.page}>
      <View style={s.topBar}>
        <HoverButton
          onPress={step === "writing" ? handleBackToExamples : onBack}
          style={s.backBtn}
          hoverStyle={s.backBtnHover}
        >
          <Text style={s.backBtnText}>
            {step === "writing" ? "← 예시문 보기" : "← 돌아가기"}
          </Text>
        </HoverButton>
        <View />
      </View>

      <ScrollView
        style={s.scroll}
        contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <Text style={s.heading}>단어 연습</Text>
        <Text style={s.desc}>
          {step === "examples"
            ? "phi3가 영어 예시문을 만들고, qwen2가 한국어로 번역합니다."
            : "한국어를 보고 영어로 작성해 보세요. 작성 후 저장하면 나의 단어에서 확인할 수 있습니다."}
        </Text>

        <View style={s.practiceInputRow}>
          <TextInput
            style={[s.input, { flex: 1, marginBottom: 0 }]}
            placeholder="영어 단어 입력 (예: achieve)"
            placeholderTextColor="#C4C4C4"
            value={word}
            onChangeText={setWord}
            autoCapitalize="none"
            onSubmitEditing={handleGenerate}
            editable={step === "examples"}
          />
          <HoverButton
            onPress={handleGenerate}
            style={s.generateBtn}
            hoverStyle={s.generateBtnHover}
            disabled={loading || step === "writing"}
          >
            <Text style={s.generateBtnText}>
              {loading ? "생성 중..." : "생성"}
            </Text>
          </HoverButton>
        </View>

        {loading && (
          <ActivityIndicator
            size="large"
            color="#000000"
            style={{ marginTop: 32 }}
          />
        )}

        {!!error && (
          <Text style={[s.errorText, { marginTop: 16 }]}>{error}</Text>
        )}

        {result && step === "examples" && (
          <View style={s.practiceCard}>
            <Text style={s.practiceLabel}>예시문 (phi3 영어 → qwen2 한국어)</Text>
            {result.examples.map((ex, i) => (
              <View key={`ex-${i}`} style={s.practiceItemWrap}>
                <Text style={s.practiceEn}>
                  {i + 1}. {ex.en}
                </Text>
                {!!ex.ko && <Text style={s.practiceKo}>→ {ex.ko}</Text>}
              </View>
            ))}
            <HoverButton
              onPress={handleGoToWriting}
              style={[s.generateBtn, { marginTop: 20, alignSelf: "flex-start" }]}
              hoverStyle={s.generateBtnHover}
            >
              <Text style={s.generateBtnText}>한국어를 보고 영어로 작성하기 →</Text>
            </HoverButton>
          </View>
        )}

        {result && step === "writing" && (
          <View style={s.practiceCard}>
            <Text style={s.practiceLabel}>한국어를 보고 영어로 작성해 보세요</Text>
            {result.examples.map((ex, i) => (
              <View
                key={`ex-${i}`}
                style={[
                  s.practiceQuestionWrap,
                  i === result.examples.length - 1 && { borderBottomWidth: 0, paddingBottom: 0 },
                ]}
              >
                <Text style={s.practiceEn}>
                  {i + 1}. {ex.ko}
                </Text>
                <TextInput
                  style={s.practiceAnswerInput}
                  placeholder={`위 한국어를 영어로 작성하세요`}
                  placeholderTextColor="#C4C4C4"
                  value={userEnglish[i] ?? ""}
                  onChangeText={(text) => handleEnglishChange(i, text)}
                  multiline
                  numberOfLines={2}
                />
              </View>
            ))}
            <View style={{ flexDirection: "row", alignItems: "center", gap: 12, marginTop: 16 }}>
              <HoverButton
                onPress={handleSave}
                style={[s.generateBtn, !token && { opacity: 0.7 }]}
                hoverStyle={s.generateBtnHover}
                disabled={saveStatus === "saving" || !token}
              >
                <Text style={s.generateBtnText}>
                  {saveStatus === "saving" ? "저장 중..." : saveStatus === "saved" ? "저장됨 ✓" : "저장"}
                </Text>
              </HoverButton>
              {!token && (
                <Text style={s.practiceKoHint}>로그인하면 저장할 수 있습니다</Text>
              )}
              {saveStatus === "error" && token && (
                <Text style={[s.practiceKoHint, { color: "#CC0000" }]}>
                  저장 실패: {saveError}
                </Text>
              )}
            </View>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

// ─────────── Practice Write Screen (연습 작성 전용) ───────────

function PracticeWriteScreen({
  token,
  practiceData,
  onBack,
}: {
  token: string | null;
  practiceData: { id: number; word: string; examples: { en: string; ko: string }[]; user_english: string[] };
  onBack: () => void;
}) {
  const [userEnglish, setUserEnglish] = useState<string[]>(
    practiceData.user_english?.length === practiceData.examples.length
      ? [...practiceData.user_english]
      : practiceData.examples.map(() => "")
  );
  const [saveStatus, setSaveStatus] = useState<"" | "saving" | "saved" | "error">("");
  const [saveError, setSaveError] = useState("");

  const handleEnglishChange = useCallback((index: number, text: string) => {
    setUserEnglish((prev) => {
      const next = [...prev];
      next[index] = text;
      return next;
    });
  }, []);

  const handleSave = useCallback(async () => {
    if (!token) {
      setSaveStatus("error");
      setSaveError("로그인이 필요합니다");
      return;
    }
    if (!practiceData.examples?.length || !practiceData.word.trim()) return;
    setSaveStatus("saving");
    setSaveError("");
    try {
      const res = await fetch(`${API_BASE}/api/practice/${practiceData.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          word: practiceData.word.trim(),
          examples: practiceData.examples,
          user_english: practiceData.examples.map((_, i) => userEnglish[i] ?? ""),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "저장 실패");
      setSaveStatus("saved");
    } catch (err: any) {
      setSaveStatus("error");
      setSaveError(err.message || "저장 실패");
    }
  }, [token, practiceData, userEnglish]);

  return (
    <View style={s.page}>
      <View style={s.topBar}>
        <HoverButton onPress={onBack} style={s.backBtn} hoverStyle={s.backBtnHover}>
          <Text style={s.backBtnText}>← 돌아가기</Text>
        </HoverButton>
        <View />
      </View>

      <ScrollView
        style={s.scroll}
        contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <Text style={s.heading}>연습 작성</Text>
        <Text style={s.desc}>
          한국어를 보고 영어로 작성해 보세요. 수정 후 저장하면 반영됩니다.
        </Text>

        <View style={s.practiceCard}>
          <Text style={s.practiceLabel}>{practiceData.word} · 연습 수정</Text>
          {practiceData.examples.map((ex, i) => (
            <View
              key={`ex-${i}`}
              style={[
                s.practiceQuestionWrap,
                i === practiceData.examples.length - 1 && { borderBottomWidth: 0, paddingBottom: 0 },
              ]}
            >
              <Text style={s.practiceEn}>
                {i + 1}. {ex.ko || ex.en || ""}
              </Text>
              <TextInput
                style={s.practiceAnswerInput}
                placeholder="위 한국어를 영어로 작성하세요"
                placeholderTextColor="#C4C4C4"
                value={userEnglish[i] ?? ""}
                onChangeText={(text) => handleEnglishChange(i, text)}
                multiline
                numberOfLines={2}
              />
            </View>
          ))}
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12, marginTop: 16 }}>
            <HoverButton
              onPress={handleSave}
              style={[s.generateBtn, !token && { opacity: 0.7 }]}
              hoverStyle={s.generateBtnHover}
              disabled={saveStatus === "saving" || !token}
            >
              <Text style={s.generateBtnText}>
                {saveStatus === "saving" ? "저장 중..." : saveStatus === "saved" ? "저장됨 ✓" : "저장"}
              </Text>
            </HoverButton>
            {!token && (
              <Text style={s.practiceKoHint}>로그인하면 저장할 수 있습니다</Text>
            )}
            {saveStatus === "error" && token && (
              <Text style={[s.practiceKoHint, { color: "#CC0000" }]}>
                저장 실패: {saveError}
              </Text>
            )}
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

// ─────────── Quiz Screen (빈칸 채우기 + 한국어↔영어 랜덤) ───────────

type QuizData = {
  word: string;
  sentences: { original: string; blanked: string }[];
};

type QuizItem = {
  word: string;
  meaning: string;
  pos: string;
  type: "fill_blank" | "ko_to_en";
  prompt: string;
  correctAnswer: string;
};

function buildQuizItems(quizData: QuizData[], words: Word[]): QuizItem[] {
  const items: QuizItem[] = [];
  for (const qd of quizData) {
    const w = words.find((x) => x.word.toLowerCase() === qd.word.toLowerCase());
    if (!w) continue;
    const types: ("fill_blank" | "ko_to_en")[] = [];
    if (qd.sentences.length >= 2) {
      types.push(Math.random() < 0.5 ? "fill_blank" : "ko_to_en");
      types.push(types[0] === "fill_blank" ? "ko_to_en" : "fill_blank");
    } else {
      types.push(Math.random() < 0.5 ? "fill_blank" : "ko_to_en");
    }
    for (let i = 0; i < types.length; i++) {
      const t = types[i];
      if (t === "fill_blank" && qd.sentences[i]) {
        items.push({
          word: w.word, meaning: w.meaning, pos: w.pos,
          type: "fill_blank",
          prompt: qd.sentences[i].blanked,
          correctAnswer: w.word,
        });
      } else {
        items.push({
          word: w.word, meaning: w.meaning, pos: w.pos,
          type: "ko_to_en",
          prompt: w.meaning,
          correctAnswer: w.word,
        });
      }
    }
  }
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

function QuizScreen({
  token,
  words,
  onFinish,
  onBack,
}: {
  token: string | null;
  words: Word[];
  onFinish: (results: QuizResultItem[]) => void;
  onBack: () => void;
}) {
  const [quizItems, setQuizItems] = useState<QuizItem[]>([]);
  const [generating, setGenerating] = useState(true);
  const [genError, setGenError] = useState("");
  const [idx, setIdx] = useState(0);
  const [answer, setAnswer] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [results, setResults] = useState<QuizResultItem[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/quiz/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ words: words.map((w) => w.word) }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "퀴즈 생성 실패");
        const items = buildQuizItems(data.quiz || [], words);
        setQuizItems(items);
      } catch (err: any) {
        setGenError(err.message);
      } finally {
        setGenerating(false);
      }
    })();
  }, [words]);

  const current = quizItems[idx];
  const isCorrect = submitted ? answer.trim().toLowerCase() === current?.correctAnswer?.toLowerCase() : false;

  const handleSubmit = useCallback(() => {
    if (!current) return;

    if (!submitted) {
      setSubmitted(true);
      return;
    }

    const newResults: QuizResultItem[] = [...results, {
      word: current.word,
      meaning: current.meaning,
      pos: current.pos,
      quiz_type: current.type,
      prompt: current.prompt,
      user_answer: answer.trim(),
      correct_answer: current.correctAnswer,
      is_correct: answer.trim().toLowerCase() === current.correctAnswer.toLowerCase(),
    }];
    setResults(newResults);

    if (idx + 1 >= quizItems.length) {
      setSaving(true);
      if (token) {
        fetch(`${API_BASE}/api/quiz/save`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ results: newResults }),
        }).catch(() => {}).finally(() => {
          setSaving(false);
          onFinish(newResults);
        });
      } else {
        setSaving(false);
        onFinish(newResults);
      }
      return;
    }

    setIdx((i) => i + 1);
    setAnswer("");
    setSubmitted(false);
  }, [submitted, current, answer, results, idx, quizItems.length, token, onFinish]);

  if (generating) {
    return (
      <View style={s.center}>
        <ActivityIndicator size="large" color="#000000" />
        <Text style={s.loadingText}>AI가 퀴즈 문장을 생성하고 있습니다...</Text>
      </View>
    );
  }

  if (genError || quizItems.length === 0) {
    return (
      <View style={s.page}>
        <View style={s.topBar}>
          <HoverButton onPress={onBack} style={s.backBtn} hoverStyle={s.backBtnHover}>
            <Text style={s.backBtnText}>← 돌아가기</Text>
          </HoverButton>
          <View />
        </View>
        <View style={s.content}>
          <Text style={s.errorText}>{genError || "퀴즈 생성에 실패했습니다"}</Text>
          <HoverButton onPress={onBack} style={[s.btnPrimary, { marginTop: 12 }]} hoverStyle={s.btnPrimaryHover}>
            <Text style={s.btnPrimaryText}>돌아가기</Text>
          </HoverButton>
        </View>
      </View>
    );
  }

  if (saving) {
    return (
      <View style={s.center}>
        <ActivityIndicator size="large" color="#000000" />
        <Text style={s.loadingText}>퀴즈 결과 저장 중...</Text>
      </View>
    );
  }

  if (!current) return null;

  return (
    <View style={s.page}>
      <View style={s.topBar}>
        <HoverButton onPress={onBack} style={s.backBtn} hoverStyle={s.backBtnHover}>
          <Text style={s.backBtnText}>← 건너뛰기</Text>
        </HoverButton>
        <Text style={s.topBarLogo}>퀴즈</Text>
        <View style={{ width: 60 }} />
      </View>

      <View style={s.content}>
        <Text style={s.progress}>
          {idx + 1} / {quizItems.length}
        </Text>

        <View style={s.card}>
          <Text style={[s.label, { marginBottom: 12 }]}>
            {current.type === "ko_to_en" ? "한국어 뜻 → 영어 단어 입력" : "빈칸에 들어갈 영어 단어 입력"}
          </Text>

          {current.type === "ko_to_en" ? (
            <Text style={s.cardWord}>{current.prompt}</Text>
          ) : (
            <Text style={{ fontSize: 16, color: "#000000", lineHeight: 26, textAlign: "center" }}>
              {current.prompt}
            </Text>
          )}

          <TextInput
            style={[
              s.quizInput,
              submitted && (isCorrect ? s.quizInputCorrect : s.quizInputWrong),
            ]}
            placeholder="영어 단어를 입력하세요"
            placeholderTextColor="#C4C4C4"
            value={answer}
            onChangeText={setAnswer}
            onSubmitEditing={handleSubmit}
            autoCapitalize="none"
            editable={!submitted}
            autoFocus
          />

          {submitted && (
            <View style={s.quizFeedback}>
              <Text style={[s.quizFeedbackText, isCorrect ? { color: "#22C55E" } : { color: "#EF4444" }]}>
                {isCorrect ? "정답!" : "오답"}
              </Text>
              {!isCorrect && (
                <Text style={s.quizCorrectAnswer}>정답: {current.correctAnswer}</Text>
              )}
            </View>
          )}
        </View>

        <HoverButton
          onPress={handleSubmit}
          style={[s.btnPrimary, { marginTop: 20, maxWidth: 420 }]}
          hoverStyle={s.btnPrimaryHover}
        >
          <Text style={s.btnPrimaryText}>
            {submitted
              ? idx + 1 >= quizItems.length ? "결과 보기" : "다음 문제"
              : "정답 확인"}
          </Text>
        </HoverButton>
      </View>
    </View>
  );
}

// ─────────── Composition Screen (AI 작문 연습) ───────────

function CompositionScreen({
  token,
  words,
  onBack,
  onHome,
}: {
  token: string | null;
  words: Word[];
  onBack: () => void;
  onHome: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [aiEnglish, setAiEnglish] = useState("");
  const [aiKorean, setAiKorean] = useState("");
  const [userWriting, setUserWriting] = useState("");
  const [saveStatus, setSaveStatus] = useState<"" | "saving" | "saved" | "error">("");
  const [showAnswer, setShowAnswer] = useState(false);

  const handleGenerate = useCallback(async () => {
    setLoading(true);
    setError("");
    setAiEnglish("");
    setAiKorean("");
    setUserWriting("");
    setShowAnswer(false);
    setSaveStatus("");
    try {
      const res = await fetch(`${API_BASE}/api/composition/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ words: words.map((w) => w.word) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "작문 생성 실패");
      setAiEnglish(data.english || "");
      setAiKorean(data.korean || "");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [words]);

  const handleSave = useCallback(async () => {
    if (!token) return;
    setSaveStatus("saving");
    try {
      const res = await fetch(`${API_BASE}/api/composition/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          words: words.map((w) => w.word),
          ai_english: aiEnglish,
          ai_korean: aiKorean,
          user_writing: userWriting,
        }),
      });
      if (!res.ok) throw new Error("저장 실패");
      setSaveStatus("saved");
    } catch {
      setSaveStatus("error");
    }
  }, [token, words, aiEnglish, aiKorean, userWriting]);

  return (
    <View style={s.page}>
      <View style={s.topBar}>
        <HoverButton onPress={onBack} style={s.backBtn} hoverStyle={s.backBtnHover}>
          <Text style={s.backBtnText}>← 돌아가기</Text>
        </HoverButton>
        <View />
      </View>

      <ScrollView style={s.scroll} contentContainerStyle={s.scrollContent} showsVerticalScrollIndicator={false}>
        <Text style={s.heading}>AI 영어 작문 연습</Text>
        <Text style={s.desc}>
          학습한 단어로 AI가 영어 작문을 생성합니다.{"\n"}
          한국어 번역을 보고 영어로 작문해 보세요.
        </Text>

        <View style={s.listCard}>
          <Text style={s.listTitle}>사용 단어</Text>
          <Text style={{ fontSize: 13, color: "#666666", lineHeight: 22 }}>
            {words.map((w) => w.word).join(", ")}
          </Text>
        </View>

        {!aiEnglish && !loading && (
          <HoverButton onPress={handleGenerate} style={s.btnPrimary} hoverStyle={s.btnPrimaryHover}>
            <Text style={s.btnPrimaryText}>AI 작문 생성하기</Text>
          </HoverButton>
        )}

        {loading && (
          <View style={{ alignItems: "center", marginTop: 24 }}>
            <ActivityIndicator size="large" color="#000000" />
            <Text style={s.loadingText}>phi3가 영어 작문을 생성하고 qwen2가 번역 중...</Text>
          </View>
        )}

        {!!error && <Text style={[s.errorText, { marginTop: 16 }]}>{error}</Text>}

        {!!aiKorean && (
          <View style={[s.practiceCard, { marginTop: 16 }]}>
            <Text style={s.practiceLabel}>한국어 (AI 번역)</Text>
            <Text style={{ fontSize: 14, color: "#000000", lineHeight: 24 }}>{aiKorean}</Text>
          </View>
        )}

        {!!aiEnglish && (
          <>
            <View style={[s.practiceCard, { marginTop: 12 }]}>
              <Text style={s.practiceLabel}>영어로 작문해 보세요</Text>
              <TextInput
                style={[s.practiceAnswerInput, { minHeight: 120 }]}
                placeholder="위 한국어를 영어로 작문하세요..."
                placeholderTextColor="#C4C4C4"
                value={userWriting}
                onChangeText={setUserWriting}
                multiline
              />
            </View>

            <View style={{ flexDirection: "row", gap: 8, marginTop: 12, width: "100%", maxWidth: 420 }}>
              <HoverButton
                onPress={() => setShowAnswer(!showAnswer)}
                style={[s.btnOutline, { flex: 1 }]}
                hoverStyle={s.btnOutlineHover}
              >
                <Text style={s.btnOutlineText}>{showAnswer ? "정답 숨기기" : "정답 보기"}</Text>
              </HoverButton>
              <HoverButton
                onPress={handleSave}
                style={[s.generateBtn, { flex: 1, alignItems: "center" }, !token && { opacity: 0.5 }]}
                hoverStyle={s.generateBtnHover}
                disabled={!token || saveStatus === "saving"}
              >
                <Text style={s.generateBtnText}>
                  {saveStatus === "saving" ? "저장 중..." : saveStatus === "saved" ? "저장됨 ✓" : "저장"}
                </Text>
              </HoverButton>
            </View>

            {showAnswer && (
              <View style={[s.practiceCard, { marginTop: 12 }]}>
                <Text style={s.practiceLabel}>AI 영어 작문 (정답)</Text>
                <Text style={{ fontSize: 14, color: "#000000", lineHeight: 24 }}>{aiEnglish}</Text>
              </View>
            )}

            <HoverButton
              onPress={onHome}
              style={[s.btnOutline, { marginTop: 20 }]}
              hoverStyle={s.btnOutlineHover}
            >
              <Text style={s.btnOutlineText}>처음으로 돌아가기</Text>
            </HoverButton>
          </>
        )}
      </ScrollView>
    </View>
  );
}

// ─────────── Word Detail Screen ───────────

type QuizHistoryItem = {
  quiz_type: string;
  prompt: string;
  user_answer: string;
  correct_answer: string;
  is_correct: number;
  quizzed_at: string;
};

function WordDetailScreen({
  token,
  wordName,
  onBack,
}: {
  token: string | null;
  wordName: string;
  onBack: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [wordInfo, setWordInfo] = useState<{ word: string; meaning: string; pos: string; status: string } | null>(null);
  const [quizHistory, setQuizHistory] = useState<QuizHistoryItem[]>([]);

  useEffect(() => {
    if (!token) { setLoading(false); return; }
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/quiz/word/${encodeURIComponent(wordName)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json();
        if (res.ok) {
          setWordInfo(data.word);
          setQuizHistory(data.quizHistory || []);
        }
      } catch {}
      setLoading(false);
    })();
  }, [token, wordName]);

  const formatDate = (ds: string) => {
    const d = new Date(ds);
    return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };

  return (
    <View style={s.page}>
      <View style={s.topBar}>
        <HoverButton onPress={onBack} style={s.backBtn} hoverStyle={s.backBtnHover}>
          <Text style={s.backBtnText}>← 돌아가기</Text>
        </HoverButton>
        <View />
      </View>

      <ScrollView style={s.scroll} contentContainerStyle={s.scrollContent} showsVerticalScrollIndicator={false}>
        {loading ? (
          <ActivityIndicator size="large" color="#000000" style={{ marginTop: 48 }} />
        ) : (
          <>
            <View style={[s.card, { marginBottom: 20 }]}>
              <Text style={s.cardWord}>{wordName}</Text>
              {wordInfo && (
                <>
                  <Text style={s.cardPos}>{wordInfo.pos}</Text>
                  <Text style={s.cardMeaning}>{wordInfo.meaning}</Text>
                  <View style={{ marginTop: 12, alignSelf: "center" }}>
                    <Text style={[s.myWordBadge, wordInfo.status === "known" ? s.badgeKnown : s.badgeUnknown, { width: "auto", height: "auto", fontSize: 14, paddingHorizontal: 16, paddingVertical: 6, borderRadius: 16, lineHeight: 20 }]}>
                      {wordInfo.status === "known" ? "아는 단어" : "모르는 단어"}
                    </Text>
                  </View>
                </>
              )}
            </View>

            {(() => {
              const wrongItems = quizHistory.filter((q) => !q.is_correct);
              if (wrongItems.length === 0 && quizHistory.length > 0) {
                return <Text style={s.desc}>모든 문제를 맞혔습니다</Text>;
              }
              if (wrongItems.length === 0) {
                return <Text style={s.desc}>퀴즈 기록이 없습니다</Text>;
              }
              return (
                <>
                  <Text style={[s.heading, { fontSize: 18, marginBottom: 12 }]}>틀린 퀴즈 기록</Text>
                  {wrongItems.map((q, i) => (
                    <View key={i} style={[s.listCard, { marginBottom: 12 }]}>
                      <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 10 }}>
                        <Text style={{ fontSize: 12, color: "#EF4444", fontWeight: "600" }}>
                          {q.quiz_type === "ko_to_en" ? "한국어 → 영어" : "빈칸 채우기"}
                        </Text>
                        <Text style={{ fontSize: 12, color: "#9CA3AF" }}>{formatDate(q.quizzed_at)}</Text>
                      </View>

                      {q.quiz_type === "fill_blank" && !!q.prompt ? (
                        <View style={{ backgroundColor: "#F0FDF4", borderRadius: 8, padding: 12 }}>
                          <Text style={{ fontSize: 15, color: "#111827", lineHeight: 24 }}>
                            {q.prompt.replace(/____/g, q.correct_answer)}
                          </Text>
                          <Text style={{ fontSize: 12, color: "#16A34A", marginTop: 6 }}>
                            정답: {q.correct_answer}
                          </Text>
                        </View>
                      ) : (
                        <View style={{ backgroundColor: "#F0FDF4", borderRadius: 8, padding: 12 }}>
                          <Text style={{ fontSize: 15, color: "#111827", lineHeight: 24 }}>
                            {wordInfo?.meaning || q.prompt}
                          </Text>
                        </View>
                      )}
                    </View>
                  ))}
                </>
              );
            })()}
          </>
        )}
      </ScrollView>
    </View>
  );
}

// ─────────── My Words Screen ───────────

type MyWord = {
  word: string;
  meaning: string;
  pos: string;
  status: "known" | "unknown";
  quiz_sentence: string;
  studied_at: string;
};

type PracticeRecord = {
  id: number;
  word: string;
  examples: { en: string; ko: string }[];
  user_english: string[];
  practiced_at: string;
};

function MyWordsScreen({
  token,
  onBack,
  onOpenPracticeWrite,
}: {
  token: string | null;
  onBack: () => void;
  onOpenPracticeWrite?: (p: PracticeRecord) => void;
}) {
  const [tab, setTab] = useState<"all" | "known" | "unknown" | "practice">("all");
  const [known, setKnown] = useState<MyWord[]>([]);
  const [unknown, setUnknown] = useState<MyWord[]>([]);
  const [practiceList, setPracticeList] = useState<PracticeRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedWord, setSelectedWord] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        if (!token) {
          setLoading(false);
          return;
        }
        const [wordsRes, practiceRes] = await Promise.all([
          fetch(`${API_BASE}/api/words/my`, {
            headers: { Authorization: `Bearer ${token}` },
          }),
          fetch(`${API_BASE}/api/practice/my`, {
            headers: { Authorization: `Bearer ${token}` },
          }),
        ]);
        const wordsData = await wordsRes.json();
        if (wordsRes.ok) {
          setKnown(wordsData.known || []);
          setUnknown(wordsData.unknown || []);
        }
        const practiceData = await practiceRes.json();
        if (practiceRes.ok) {
          setPracticeList(practiceData.list || []);
        }
      } catch {}
      setLoading(false);
    })();
  }, [token]);

  const displayed =
    tab === "known" ? known : tab === "unknown" ? unknown : [...unknown, ...known];

  const uniqueWords = displayed.reduce<MyWord[]>((acc, w) => {
    if (!acc.find((a) => a.word === w.word)) acc.push(w);
    return acc;
  }, []);

  const formatDate = (ds: string) => {
    const d = new Date(ds);
    return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };

  if (selectedWord) {
    return (
      <WordDetailScreen
        token={token}
        wordName={selectedWord}
        onBack={() => setSelectedWord(null)}
      />
    );
  }

  return (
    <View style={s.page}>
      <View style={s.topBar}>
        <HoverButton onPress={onBack} style={s.backBtn} hoverStyle={s.backBtnHover}>
          <Text style={s.backBtnText}>← 돌아가기</Text>
        </HoverButton>
        <View />
      </View>

      <ScrollView
        style={s.scroll}
        contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <Text style={s.heading}>나의 단어 리스트</Text>
        <Text style={s.desc}>
          {tab === "practice"
            ? `연습 기록 ${practiceList.length}개`
            : `학습한 단어 ${known.length + unknown.length}개 · 아는 단어 ${known.length}개 · 모르는 단어 ${unknown.length}개`}
        </Text>

        <View style={s.tabRow}>
          {(["all", "unknown", "known", "practice"] as const).map((t) => (
            <HoverButton
              key={t}
              onPress={() => setTab(t)}
              style={[s.tabBtn, tab === t && s.tabBtnActive]}
              hoverStyle={s.tabBtnHover}
            >
              <Text style={[s.tabBtnText, tab === t && s.tabBtnTextActive]}>
                {t === "all" ? "전체" : t === "known" ? "아는 단어" : t === "unknown" ? "모르는 단어" : "연습"}
              </Text>
            </HoverButton>
          ))}
        </View>

        {loading ? (
          <ActivityIndicator size="large" color="#000000" style={{ marginTop: 32 }} />
        ) : tab === "practice" ? (
          practiceList.length === 0 ? (
            <Text style={[s.desc, { marginTop: 32 }]}>
              {token ? "아직 연습 기록이 없습니다" : "로그인하면 연습 기록을 볼 수 있습니다"}
            </Text>
          ) : (
            <View style={s.practiceCardList}>
              {practiceList.map((p) => (
                <HoverButton
                  key={p.id}
                  onPress={() => onOpenPracticeWrite?.(p)}
                  style={s.practiceSessionCard}
                  hoverStyle={s.practiceSessionCardHover}
                >
                  <Text style={s.practiceSessionWord}>{p.word}</Text>
                  <Text style={s.practiceSessionDate}>{formatDate(p.practiced_at)}</Text>
                </HoverButton>
              ))}
            </View>
          )
        ) : uniqueWords.length === 0 ? (
          <Text style={[s.desc, { marginTop: 32 }]}>아직 학습한 단어가 없습니다</Text>
        ) : (
          <View style={s.listCard}>
            {uniqueWords.map((w, i) => (
              <Pressable
                key={`${w.word}-${i}`}
                onPress={() => setSelectedWord(w.word)}
                style={[s.listRow, i === uniqueWords.length - 1 && { borderBottomWidth: 0 }]}
              >
                <View style={{ flex: 1 }}>
                  <Text style={s.listWord}>{w.word}</Text>
                  <Text style={s.listMeaning}>{w.meaning}</Text>
                  {!!w.quiz_sentence && (
                    <Text style={{ fontSize: 11, color: "#9CA3AF", marginTop: 2 }}>퀴즈 기록 있음 →</Text>
                  )}
                </View>
                <Text style={[s.myWordBadge, w.status === "known" ? s.badgeKnown : s.badgeUnknown]}>
                  {w.status === "known" ? "O" : "X"}
                </Text>
              </Pressable>
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

// ─────────── Styles ───────────

const s = StyleSheet.create({
  // Layout
  page: {
    flex: 1,
    backgroundColor: "#FFFFFF",
  },
  center: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#FFFFFF",
  },
  content: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    alignItems: "center",
    paddingHorizontal: 24,
    paddingTop: 24,
    paddingBottom: 48,
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
    color: "#AAAAAA",
    fontWeight: "300",
  },

  // Hover default
  hoverDefault: {
    opacity: 0.7,
  },

  // Top bar
  topBar: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 24,
    paddingTop: Platform.OS === "web" ? 20 : 48,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#EBEBEB",
  },
  topBarLogo: {
    fontSize: 16,
    fontWeight: "400",
    color: "#000000",
    letterSpacing: 3,
  },

  // Auth
  authCard: {
    width: "100%",
    maxWidth: 380,
    alignItems: "center",
    paddingHorizontal: 32,
    paddingTop: 60,
  },
  logo: {
    fontSize: 24,
    fontWeight: "300",
    color: "#000000",
    letterSpacing: 6,
    marginBottom: 36,
  },
  authTitle: {
    fontSize: 18,
    fontWeight: "400",
    color: "#000000",
    marginBottom: 28,
  },
  fieldGroup: {
    width: "100%",
    marginBottom: 16,
  },
  label: {
    fontSize: 12,
    fontWeight: "400",
    color: "#AAAAAA",
    marginBottom: 6,
    letterSpacing: 0.5,
  },

  // Inputs
  input: {
    width: "100%",
    height: 46,
    borderWidth: 1,
    borderColor: "#E0E0E0",
    borderRadius: 6,
    paddingHorizontal: 14,
    fontSize: 14,
    fontWeight: "300",
    color: "#000000",
    backgroundColor: "#FFFFFF",
  },

  // Buttons
  btnPrimary: {
    width: "100%",
    maxWidth: 420,
    backgroundColor: "#000000",
    paddingVertical: 13,
    borderRadius: 6,
    alignItems: "center",
    marginTop: 10,
  },
  btnPrimaryHover: {
    backgroundColor: "#1A1A1A",
  },
  btnPrimaryText: {
    color: "#FFFFFF",
    fontSize: 14,
    fontWeight: "400",
    letterSpacing: 0.5,
  },
  btnOutline: {
    width: "100%",
    maxWidth: 420,
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "#E0E0E0",
    paddingVertical: 12,
    borderRadius: 6,
    alignItems: "center",
    marginTop: 8,
  },
  btnOutlineHover: {
    backgroundColor: "#F5F5F5",
    borderColor: "#D6D6D6",
  },
  btnOutlineText: {
    color: "#000000",
    fontSize: 13,
    fontWeight: "400",
    letterSpacing: 0.3,
  },
  btnGhost: {
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 6,
    alignItems: "center",
  },
  btnGhostHover: {
    backgroundColor: "#F5F5F5",
  },
  btnGhostText: {
    color: "#AAAAAA",
    fontSize: 13,
    fontWeight: "300",
  },
  linkWrap: {
    marginTop: 24,
    paddingVertical: 4,
  },
  linkText: {
    color: "#AAAAAA",
    fontSize: 12,
    fontWeight: "300",
  },
  errorText: {
    color: "#000000",
    fontSize: 12,
    fontWeight: "300",
    marginBottom: 8,
    textAlign: "center",
  },

  // Logout
  logoutBtn: {
    paddingVertical: 5,
    paddingHorizontal: 12,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: "#E0E0E0",
  },
  logoutBtnHover: {
    backgroundColor: "#F5F5F5",
    borderColor: "#D6D6D6",
  },
  logoutBtnText: {
    color: "#AAAAAA",
    fontSize: 11,
    fontWeight: "300",
    letterSpacing: 0.3,
  },

  // Back
  backBtn: {
    paddingVertical: 6,
    paddingHorizontal: 4,
  },
  backBtnHover: {
    opacity: 0.5,
  },
  backBtnText: {
    color: "#AAAAAA",
    fontSize: 13,
    fontWeight: "300",
  },

  // Count selection
  heading: {
    fontSize: 20,
    fontWeight: "300",
    color: "#000000",
    marginBottom: 8,
    textAlign: "center",
    letterSpacing: 0.5,
  },
  desc: {
    fontSize: 13,
    fontWeight: "300",
    color: "#AAAAAA",
    marginBottom: 32,
    textAlign: "center",
  },
  divider: {
    width: "100%",
    maxWidth: 380,
    height: 1,
    backgroundColor: "#EBEBEB",
    marginVertical: 24,
  },

  // Card
  progress: {
    fontSize: 12,
    color: "#CCCCCC",
    marginBottom: 28,
    fontWeight: "300",
    letterSpacing: 2,
  },
  card: {
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "#EEEEEE",
    borderRadius: 12,
    paddingVertical: 52,
    paddingHorizontal: 40,
    width: "100%",
    maxWidth: 420,
    alignItems: "center",
  },
  cardWord: {
    fontSize: 34,
    fontWeight: "300",
    color: "#000000",
    marginBottom: 10,
    letterSpacing: -0.5,
  },
  ttsBtn: {
    alignSelf: "flex-start",
    paddingVertical: 8,
    paddingHorizontal: 14,
    backgroundColor: "#F5F5F5",
    borderRadius: 6,
    marginBottom: 12,
  },
  ttsBtnHover: {
    backgroundColor: "#EEEEEE",
  },
  ttsBtnText: {
    fontSize: 13,
    color: "#666666",
  },
  cardPos: {
    fontSize: 12,
    color: "#CCCCCC",
    marginBottom: 28,
    fontWeight: "300",
    letterSpacing: 1,
  },
  cardMeaning: {
    fontSize: 18,
    color: "#000000",
    fontWeight: "400",
  },
  meaningBtn: {
    borderWidth: 1,
    borderColor: "#E0E0E0",
    paddingVertical: 9,
    paddingHorizontal: 24,
    borderRadius: 6,
  },
  meaningBtnHover: {
    backgroundColor: "#F5F5F5",
    borderColor: "#D6D6D6",
  },
  meaningBtnText: {
    fontSize: 13,
    color: "#000000",
    fontWeight: "300",
    letterSpacing: 0.3,
  },

  // Choice
  choiceRow: {
    flexDirection: "row",
    gap: 12,
    marginTop: 28,
  },
  btnKnow: {
    backgroundColor: "#000000",
    borderWidth: 1,
    borderColor: "#000000",
    paddingVertical: 12,
    paddingHorizontal: 32,
    borderRadius: 6,
  },
  btnKnowHover: {
    backgroundColor: "#1A1A1A",
  },
  btnKnowText: {
    color: "#FFFFFF",
    fontSize: 13,
    fontWeight: "400",
    letterSpacing: 0.5,
  },
  btnDontKnow: {
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "#E0E0E0",
    paddingVertical: 12,
    paddingHorizontal: 32,
    borderRadius: 6,
  },
  btnDontKnowHover: {
    backgroundColor: "#F5F5F5",
    borderColor: "#D6D6D6",
  },
  btnDontKnowText: {
    color: "#000000",
    fontSize: 13,
    fontWeight: "400",
    letterSpacing: 0.5,
  },

  // Results
  statRow: {
    flexDirection: "row",
    gap: 12,
    marginTop: 20,
    marginBottom: 24,
    width: "100%",
    maxWidth: 420,
  },
  statBox: {
    flex: 1,
    paddingVertical: 16,
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "#EEEEEE",
    borderRadius: 8,
    alignItems: "center",
  },
  statNum: {
    fontSize: 22,
    fontWeight: "300",
    color: "#000000",
  },
  statLabel: {
    fontSize: 11,
    fontWeight: "300",
    color: "#BBBBBB",
    marginTop: 4,
    letterSpacing: 0.3,
  },
  listCard: {
    width: "100%",
    maxWidth: 420,
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "#EEEEEE",
    borderRadius: 8,
    padding: 16,
    marginBottom: 12,
  },
  listTitle: {
    fontSize: 12,
    fontWeight: "400",
    color: "#000000",
    marginBottom: 10,
    letterSpacing: 0.5,
  },
  listRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: "#F5F5F5",
  },
  listWord: {
    fontSize: 14,
    color: "#000000",
    fontWeight: "400",
  },
  listMeaning: {
    fontSize: 13,
    fontWeight: "300",
    color: "#AAAAAA",
  },
  practiceCardList: {
    width: "100%",
    maxWidth: 420,
  },
  practiceSessionCard: {
    marginBottom: 12,
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "#EEEEEE",
    borderRadius: 8,
    padding: 16,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  practiceSessionCardHover: {
    backgroundColor: "#F8F8F8",
    borderColor: "#DDDDDD",
  },
  practiceSessionWord: {
    fontSize: 16,
    fontWeight: "500",
    color: "#000000",
  },
  practiceSessionDate: {
    fontSize: 12,
    fontWeight: "300",
    color: "#888888",
  },
  finishBtns: {
    width: "100%",
    maxWidth: 420,
    marginTop: 12,
    gap: 8,
  },

  // Practice
  practiceInputRow: {
    flexDirection: "row",
    alignItems: "center",
    width: "100%",
    maxWidth: 420,
    gap: 8,
  },
  generateBtn: {
    backgroundColor: "#000000",
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 6,
  },
  generateBtnHover: {
    backgroundColor: "#1A1A1A",
  },
  generateBtnText: {
    color: "#FFFFFF",
    fontSize: 13,
    fontWeight: "400",
    letterSpacing: 0.3,
  },
  practiceCard: {
    width: "100%",
    maxWidth: 420,
    backgroundColor: "#FFFFFF",
    borderWidth: 1,
    borderColor: "#EEEEEE",
    borderRadius: 8,
    padding: 20,
    marginTop: 24,
  },
  practiceLabel: {
    fontSize: 11,
    fontWeight: "400",
    color: "#000000",
    marginBottom: 12,
    textTransform: "uppercase" as any,
    letterSpacing: 2,
  },
  practiceItemWrap: {
    marginBottom: 14,
  },
  practiceEn: {
    fontSize: 14,
    fontWeight: "400",
    color: "#000000",
    lineHeight: 22,
  },
  practiceKo: {
    fontSize: 13,
    fontWeight: "300",
    color: "#AAAAAA",
    lineHeight: 20,
    marginLeft: 18,
    marginTop: 4,
  },
  practiceQuestionWrap: {
    marginBottom: 20,
    paddingBottom: 20,
    borderBottomWidth: 1,
    borderBottomColor: "#F0F0F0",
  },
  practiceKoHint: {
    fontSize: 12,
    fontWeight: "300",
    color: "#AAAAAA",
    marginTop: 4,
    marginBottom: 8,
  },
  practiceAnswerInput: {
    marginTop: 8,
    padding: 12,
    borderWidth: 1,
    borderColor: "#EEEEEE",
    borderRadius: 6,
    fontSize: 14,
    color: "#000000",
    minHeight: 80,
    textAlignVertical: "top",
  },

  // Top bar right
  topBarRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  topBarBtn: {
    paddingVertical: 5,
    paddingHorizontal: 12,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: "#E0E0E0",
  },
  topBarBtnHover: {
    backgroundColor: "#F5F5F5",
    borderColor: "#D6D6D6",
  },
  topBarBtnText: {
    color: "#000000",
    fontSize: 11,
    fontWeight: "300",
    letterSpacing: 0.3,
  },

  // Tabs
  tabRow: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 20,
    width: "100%",
    maxWidth: 420,
  },
  tabBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "#E0E0E0",
    alignItems: "center",
    backgroundColor: "#FFFFFF",
  },
  tabBtnActive: {
    backgroundColor: "#000000",
    borderColor: "#000000",
  },
  tabBtnHover: {
    backgroundColor: "#F5F5F5",
  },
  tabBtnText: {
    fontSize: 12,
    fontWeight: "300",
    color: "#000000",
    letterSpacing: 0.3,
  },
  tabBtnTextActive: {
    color: "#FFFFFF",
  },

  // Badge
  myWordBadge: {
    fontSize: 12,
    fontWeight: "400",
    width: 24,
    height: 24,
    borderRadius: 12,
    textAlign: "center",
    lineHeight: 24,
    overflow: "hidden",
  },
  badgeKnown: {
    backgroundColor: "#F0F0F0",
    color: "#000000",
  },
  badgeUnknown: {
    backgroundColor: "#000000",
    color: "#FFFFFF",
  },

  // Quiz
  quizInput: {
    width: "100%",
    height: 48,
    borderWidth: 1,
    borderColor: "#E0E0E0",
    borderRadius: 6,
    paddingHorizontal: 16,
    fontSize: 16,
    fontWeight: "300" as const,
    color: "#000000",
    backgroundColor: "#FFFFFF",
    textAlign: "center" as const,
    marginTop: 20,
  },
  quizInputCorrect: {
    borderColor: "#22C55E",
    backgroundColor: "#F0FFF4",
  },
  quizInputWrong: {
    borderColor: "#EF4444",
    backgroundColor: "#FFF5F5",
  },
  quizFeedback: {
    marginTop: 12,
    alignItems: "center" as const,
  },
  quizFeedbackText: {
    fontSize: 16,
    fontWeight: "500" as const,
  },
  quizCorrectAnswer: {
    fontSize: 14,
    fontWeight: "300" as const,
    color: "#666666",
    marginTop: 4,
  },

  // Main screen
  startInputRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    width: "100%",
    maxWidth: 280,
  },
  startInput: {
    flex: 1,
    height: 48,
    borderWidth: 1,
    borderColor: "#E0E0E0",
    borderRadius: 6,
    paddingHorizontal: 16,
    fontSize: 16,
    fontWeight: "300",
    color: "#000000",
    backgroundColor: "#FFFFFF",
    textAlign: "center",
  },
  startBtn: {
    backgroundColor: "#000000",
    height: 48,
    paddingHorizontal: 28,
    borderRadius: 6,
    alignItems: "center",
    justifyContent: "center",
  },
  startBtnHover: {
    backgroundColor: "#1A1A1A",
  },
  startBtnText: {
    color: "#FFFFFF",
    fontSize: 14,
    fontWeight: "400",
    letterSpacing: 1,
  },
});
