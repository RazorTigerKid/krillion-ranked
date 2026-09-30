// Krillion Ranked — server entry point.  Run with:  npm start
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../config');
const db = require('./db');
const auth = require('./auth');
const P = require('./prompts');
const ws = require('./ws');
const game = require('./game');
const { rankFor, RANKS } = require('./ranks');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(__dirname, '..', 'public');

const loaded = P.reload();
for (const w of loaded.warnings) console.warn('⚠ ' + w);
const answerTotal = P.all().reduce((s, p) => s + p.answers.length, 0);
console.log(`Loaded ${loaded.count} prompts with ${answerTotal} total answers`);

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 10000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
  });
}

function tokenOf(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

// Tiny rate limit for login/register so nobody can spam guesses at passwords
const hits = new Map();
function limited(req) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 60000);
  arr.push(now); hits.set(ip, arr);
  return arr.length > 20;
}

function historyFor(userId, limit = 20) {
  const rows = db.prepare(`SELECT m.*, u1.username AS n1, u2.username AS n2 FROM matches m
    LEFT JOIN users u1 ON u1.id = m.p1 LEFT JOIN users u2 ON u2.id = m.p2
    WHERE m.p1 = ? OR m.p2 = ? ORDER BY m.id DESC LIMIT ?`).all(userId, userId, limit);
  return rows.map((m) => {
    const me1 = m.p1 === userId;
    const result = m.winner == null ? 'draw' : m.winner === userId ? 'win' : 'loss';
    return { id: m.id, ranked: !!m.ranked, at: m.created_at, result, reason: m.end_reason,
      opp: me1 ? (m.n2 || 'KrillBot') : m.n1,
      myScore: me1 ? m.p1_score : m.p2_score, oppScore: me1 ? m.p2_score : m.p1_score,
      delta: me1 ? m.p1_delta : m.p2_delta };
  });
}

async function api(req, res, url) {
  const route = `${req.method} ${url.pathname}`;
  if (route === 'POST /api/register' || route === 'POST /api/login') {
    if (limited(req)) return json(res, 429, { error: 'Too many tries, wait a minute' });
    const b = await readBody(req);
    const r = route.endsWith('register') ? auth.register(b.username, b.password) : auth.login(b.username, b.password);
    return json(res, r.error ? 400 : 200, r);
  }
  if (route === 'POST /api/logout') { auth.logout(tokenOf(req)); return json(res, 200, { ok: true }); }
  if (route === 'GET /api/me') {
    const u = auth.userFromToken(tokenOf(req));
    if (!u) return json(res, 401, { error: 'Not logged in' });
    return json(res, 200, { ...game.publicUser(u), wins: u.wins, losses: u.losses, draws: u.draws, peak: u.peak_rating, peakRank: rankFor(u.peak_rating) });
  }
  if (route === 'GET /api/history') {
    const u = auth.userFromToken(tokenOf(req));
    if (!u) return json(res, 401, { error: 'Not logged in' });
    return json(res, 200, historyFor(u.id));
  }
  if (route === 'GET /api/leaderboard') {
    const rows = db.prepare(`SELECT id, username, rating, games, wins, losses FROM users WHERE games >= ?
      ORDER BY rating DESC, wins DESC LIMIT 100`).all(C.PLACEMENT_GAMES);
    return json(res, 200, rows.map((r, i) => ({ place: i + 1, name: r.username, rating: r.rating, wins: r.wins, losses: r.losses, rank: rankFor(r.rating, r.games) })));
  }
  if (route === 'GET /api/info') {
    return json(res, 200, { prompts: P.all().length, answers: answerTotal, ...game.stats(),
      ranks: RANKS, promptsPerMatch: C.PROMPTS_PER_MATCH, secondsPerRound: C.SECONDS_PER_ROUND,
      metersPerPoint: C.METERS_PER_POINT, answerTiers: [...C.ANSWER_TIERS, C.KRILLION_TIER], penalty: C.WRONG_GUESS_PENALTY, placements: C.PLACEMENT_GAMES });
  }
  return json(res, 404, { error: 'Not found' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    // Static files
    let file = path.normalize(path.join(PUBLIC, decodeURIComponent(url.pathname)));
    if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
    if (url.pathname === '/' || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC, 'index.html');
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: 'Server error' });
  }
});

ws.attach(server, '/ws', (sock) => game.onSocket(sock, auth.userFromToken));

server.listen(PORT, () => console.log(`🦐 Krillion Ranked running at http://localhost:${PORT}`));
