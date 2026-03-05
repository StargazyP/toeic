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
