-- TOEIC 단어 학습 앱 - MySQL 스키마

CREATE TABLE IF NOT EXISTS users (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(100),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

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
);

CREATE TABLE IF NOT EXISTS user_practice_sessions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  word VARCHAR(100) NOT NULL,
  questions JSON NOT NULL,
  answers JSON NOT NULL,
  practiced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user_practice (user_id)
);

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
);

CREATE TABLE IF NOT EXISTS user_compositions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  words JSON NOT NULL,
  ai_english TEXT NOT NULL DEFAULT '',
  ai_korean TEXT NOT NULL DEFAULT '',
  user_writing TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user_comp (user_id)
);
