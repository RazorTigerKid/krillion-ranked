// Accounts and login sessions. Passwords are hashed with scrypt (built into Node).
const crypto = require('node:crypto');
const db = require('./db');

const USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/;
const SESSION_DAYS = 30;

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 32);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function checkPassword(pw, stored) {
  const [saltHex, hashHex] = stored.split(':');
  const hash = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 32);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}

function newSession(userId) {
  const token = crypto.randomBytes(24).toString('base64url');
  db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)').run(token, userId, Date.now());
  return token;
}

function register(username, password) {
  username = String(username || '').trim();
  password = String(password || '');
  if (!USERNAME_RE.test(username)) return { error: 'Username must be 3-16 letters, numbers or _' };
  if (password.length < 6) return { error: 'Password must be at least 6 characters' };
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) return { error: 'That username is taken' };
  const start = require('../config').START_RATING;
  const r = db.prepare('INSERT INTO users (username, pass_hash, rating, peak_rating, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(username, hashPassword(password), start, start, Date.now());
  return { token: newSession(Number(r.lastInsertRowid)) };
}

function login(username, password) {
  const u = db.prepare('SELECT id, pass_hash FROM users WHERE username = ?').get(String(username || '').trim());
  if (!u || !checkPassword(String(password || ''), u.pass_hash)) return { error: 'Wrong username or password' };
  return { token: newSession(u.id) };
}

function logout(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(String(token || ''));
}

// Returns the user row for a session token, or null.
function userFromToken(token) {
  if (!token) return null;
  const s = db.prepare('SELECT user_id, created_at FROM sessions WHERE token = ?').get(String(token));
  if (!s) return null;
  if (Date.now() - s.created_at > SESSION_DAYS * 864e5) { logout(token); return null; }
  return db.prepare('SELECT * FROM users WHERE id = ?').get(s.user_id) || null;
}

module.exports = { register, login, logout, userFromToken };
