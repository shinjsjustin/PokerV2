-- Sessions table (optional, for database-backed sessions)
CREATE TABLE IF NOT EXISTS sessions (
    session_id VARCHAR(128) COLLATE utf8mb4_bin NOT NULL,
    expires INT(11) UNSIGNED NOT NULL,
    data MEDIUMTEXT COLLATE utf8mb4_bin,
    PRIMARY KEY (session_id)
);

-- ─────────────────────────────────────────
-- POKER APP — MySQL Schema v1.0
-- ─────────────────────────────────────────

-- 1. TABLES
CREATE TABLE tables (
  table_id    INT          NOT NULL AUTO_INCREMENT,
  name        VARCHAR(100) NOT NULL,
  max_players TINYINT      NOT NULL DEFAULT 9,
  small_blind INT          NOT NULL DEFAULT 10,
  big_blind   INT          NOT NULL DEFAULT 20,
  dealer_seat TINYINT      NOT NULL DEFAULT 1,
  seats       JSON         NULL,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (table_id)
);

-- 2. GAMESTATE (one row per hand dealt)
CREATE TABLE gamestate (
  game_id         INT     NOT NULL AUTO_INCREMENT,
  table_id        INT     NOT NULL,
  big_blind       INT     NOT NULL DEFAULT 20,
  max_players     TINYINT NOT NULL DEFAULT 9,
  dealer_seat     TINYINT NOT NULL DEFAULT 0,
  hot_seat        TINYINT NULL,
  stage           TINYINT NOT NULL DEFAULT 0,
  aggrounds       TINYINT NULL, 

  pot             INT     NOT NULL DEFAULT 0,
  current_bet     INT     NOT NULL DEFAULT 0,
  bets            JSON    NULL,
  community_cards JSON    NULL,
  deck            JSON    NULL,

  started_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at        TIMESTAMP NULL,

  PRIMARY KEY (game_id),
  FOREIGN KEY (table_id) REFERENCES tables(table_id)
);

-- 3. SIDEPOTS (one row per sidepot, linked to gamestate)
CREATE TABLE sidepots (
  sidepot_id      INT     NOT NULL AUTO_INCREMENT,
  game_id         INT     NOT NULL,
  amount          INT     NOT NULL DEFAULT 0,
  seat            TINYINT NOT NULL,

  PRIMARY KEY (sidepot_id),
  FOREIGN KEY (game_id) REFERENCES gamestate(game_id)
);

-- 4. PLAYERS
CREATE TABLE players (
  player_id     INT          NOT NULL AUTO_INCREMENT,
  username      VARCHAR(50)  NOT NULL,
  email         VARCHAR(100) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  chip_balance  INT          NOT NULL DEFAULT 1000,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,

  table_id      INT          NULL,
  seat_number   TINYINT      NULL,
  status        ENUM('active','sitting_out','offline') NULL,
  joined_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  game_id       INT          NULL,
  hole_cards    JSON         NULL,
  current_bet   INT          NULL,

  PRIMARY KEY (player_id),
  UNIQUE KEY uq_username (username),
  UNIQUE KEY uq_email    (email),
  FOREIGN KEY (table_id) REFERENCES tables(table_id),
  FOREIGN KEY (game_id)  REFERENCES gamestate(game_id)
);