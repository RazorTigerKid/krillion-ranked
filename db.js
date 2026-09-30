// SQLite database using Node's built-in node:sqlite (Node 22.5+).
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { START_RATING } = require('../config');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'krillion.db');
if (DB_PATH !== ':memory:') fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    username    TEXT NOT NULL UNIQUE COLLATE NOCASE,
    pass_hash   TEXT NOT NULL,
    rating      INTEGER NOT NULL DEFAULT ${Number(START_RATING)},
    peak_rating INTEGER NOT NULL DEFAULT ${Number(START_RATING)},
    games       INTEGER NOT NULL DEFAULT 0,
    wins        INTEGER NOT NULL DEFAULT 0,
    losses      INTEGER NOT NULL DEFAULT 0,
    draws       INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS matches (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ranked        INTEGER NOT NULL,
    p1            INTEGER NOT NULL,
    p2            INTEGER,            -- NULL when playing the bot
    p1_score      INTEGER NOT NULL,
    p2_score      INTEGER NOT NULL,
    winner        INTEGER,            -- user id, 0 for bot, NULL for draw
    p1_before     INTEGER,
    p2_before     INTEGER,
    p1_delta      INTEGER,
    p2_delta      INTEGER,
    end_reason    TEXT NOT NULL,      -- 'normal' | 'forfeit'
    rounds_json   TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_matches_p1 ON matches(p1, created_at);
  CREATE INDEX IF NOT EXISTS idx_matches_p2 ON matches(p2, created_at);

  -- How many times each answer has been given in real matches (drives rarity).
  CREATE TABLE IF NOT EXISTS answer_stats (
    prompt_id  TEXT NOT NULL,
    answer_key TEXT NOT NULL,
    picks      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (prompt_id, answer_key)
  );

  -- "My answer should have counted" reports, reviewed with: npm run reports
  CREATE TABLE IF NOT EXISTS reports (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    prompt_id  TEXT NOT NULL,
    text       TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'open',
    created_at INTEGER NOT NULL,
    UNIQUE (prompt_id, text)
  );
`);

module.exports = db;
