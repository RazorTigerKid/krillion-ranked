// Live 1v1 matches, matchmaking queue, and the practice bot.
const C = require('../config');
const db = require('./db');
const P = require('./prompts');
const { rankFor, eloChange } = require('./ranks');

const online = new Map();   // userId -> socket (one live connection per player)
const queue = new Map();    // userId -> { user, since }
const inMatch = new Map();  // userId -> Match
let nextMatchId = 1;

const send = (userId, msg) => { const s = online.get(userId); if (s) s.send(msg); };

function publicUser(u) {
  return { id: u.id, name: u.username, rating: u.rating, games: u.games, rank: rankFor(u.rating, u.games) };
}
function freshUser(id) { return db.prepare('SELECT * FROM users WHERE id = ?').get(id); }

// Prompt ids from each player's last few matches, so they don't repeat too soon
function recentPromptIds(userIds) {
  const ids = new Set();
  for (const uid of userIds) {
    const rows = db.prepare('SELECT rounds_json FROM matches WHERE p1 = ? OR p2 = ? ORDER BY id DESC LIMIT 6').all(uid, uid);
    for (const r of rows) for (const rd of JSON.parse(r.rounds_json)) ids.add(rd.promptId);
  }
  return ids;
}

// ── Bot (practice mode) ────────────────────────────────────────────────────
const BOT = { id: 0, username: 'KrillBot', rating: C.START_RATING, games: C.PLACEMENT_GAMES, bot: true };

function botPlay(match, round) {
  const delay = Math.max(0, round.startsAt - Date.now()) + 3000 + Math.random() * (C.SECONDS_PER_ROUND * 1000 * 0.6);
  round.botTimer = setTimeout(() => {
    if (match.round !== round || round.done) return;
    const r = Math.random();
    if (r < 0.08) return; // bot blanks sometimes
    if (r < 0.3) match.applyWrong(BOT.id, '???');
    // Plays like an average diver: mostly common answers, sometimes rare, never a krillion
    const rows = [...round.table.values()].filter((x) => !x.isKrillion);
    const want = Math.random();
    const tier = want < 0.35 ? 'Plankton' : want < 0.7 ? 'Schooler' : want < 0.92 ? 'Rare' : 'Deep Cut';
    const pool = rows.filter((x) => x.tier === tier);
    const a = (pool.length ? pool : rows)[Math.floor(Math.random() * (pool.length || rows.length))];
    match.applyCorrect(BOT.id, a.key, a.name);
  }, delay);
}

// ── Match ──────────────────────────────────────────────────────────────────
class Match {
  constructor(u1, u2, ranked) {
    this.id = nextMatchId++;
    this.ranked = ranked;
    this.players = [u1, u2];                 // user rows (u2 may be BOT)
    this.scores = { [u1.id]: 0, [u2.id]: 0 };
    this.history = [];
    this.played = [];             // full round results, for The Catch screen
    this.prompts = P.pickForMatch(C.PROMPTS_PER_MATCH, recentPromptIds([u1.id, u2.id].filter(Boolean)));
    this.roundIndex = -1;
    this.round = null;
    this.over = false;
    this.forfeitTimers = {};
    for (const u of this.players) if (!u.bot) inMatch.set(u.id, this);
  }

  opp(uid) { return this.players.find((p) => p.id !== uid); }
  humans() { return this.players.filter((p) => !p.bot); }

  start() {
    for (const u of this.humans()) send(u.id, this.startMsg(u.id));
    setTimeout(() => this.nextRound(), 3000);
  }

  startMsg(uid) {
    const me = this.players.find((p) => p.id === uid);
    const opp = this.opp(uid);
    return { t: 'match_start', matchId: this.id, ranked: this.ranked, rounds: this.prompts.length,
             you: publicUser(me), opp: opp.bot ? { name: opp.username, bot: true } : publicUser(opp) };
  }

  nextRound() {
    if (this.over) return;
    this.roundIndex++;
    if (this.roundIndex >= this.prompts.length) return this.finish('normal');
    const prompt = this.prompts[this.roundIndex];
    // "descending · the clock starts in 3": the prompt shows first, then the timer starts
    const startsAt = Date.now() + C.DESCENT_SECONDS * 1000;
    const endsAt = startsAt + C.SECONDS_PER_ROUND * 1000;
    const state = () => ({ key: null, name: null, points: 0, wrong: 0, guesses: [], lastGuess: 0 });
    this.round = { prompt, startsAt, endsAt, done: false, table: P.rarityTable(prompt).table,
      p: { [this.players[0].id]: state(), [this.players[1].id]: state() } };
    this.round.timer = setTimeout(() => this.endRound(), endsAt - Date.now() + 300);
    for (const u of this.humans()) send(u.id, this.roundMsg());
    if (this.players.some((p) => p.bot)) botPlay(this, this.round);
  }

  roundMsg() {
    const r = this.round;
    return { t: 'round', n: this.roundIndex + 1, total: this.prompts.length, promptId: r.prompt.id,
             text: r.prompt.text, category: r.prompt.category, answerCount: r.prompt.answers.length,
             startsAt: r.startsAt, endsAt: r.endsAt, now: Date.now(), penalty: C.WRONG_GUESS_PENALTY };
  }

  finishedFor(uid) {
    return !!this.round.p[uid].key;
  }

  // Running score including this round so far = how deep your krill is
  live(uid) { return this.scores[uid] + (this.round && !this.round.done ? this.round.p[uid].points - this.round.p[uid].wrong * C.WRONG_GUESS_PENALTY : 0); }

  sendDepths() {
    for (const u of this.humans()) {
      const o = this.opp(u.id);
      send(u.id, { t: 'depths', you: this.live(u.id), opp: this.live(o.id), oppLocked: this.finishedFor(o.id), oppWrong: this.round.p[o.id].wrong });
    }
  }

  guess(uid, text) {
    const r = this.round;
    if (this.over || !r || r.done || this.finishedFor(uid) || Date.now() < r.startsAt) return;
    text = String(text || '').slice(0, 80).trim();
    if (!text) return;
    const now = Date.now();
    if (now - r.p[uid].lastGuess < 250) return; // no machine-gun spamming
    r.p[uid].lastGuess = now;
    r.p[uid].guesses.push(text);
    const res = P.check(r.prompt, text);
    if (res.ok) this.applyCorrect(uid, res.key, res.name, text, res.fuzzy);
    else this.applyWrong(uid, text);
  }

  // Scored the moment you lock in, so your krill sinks right away (like the original).
  applyCorrect(uid, key, name, typed, fuzzy) {
    const r = this.round;
    const row = r.table.get(key);
    const me = r.p[uid], them = r.p[this.opp(uid).id];
    me.key = key; me.name = name; me.points = row.points;
    let jinx = false;
    if (them.key === key) { // JINX: same answer, both get the split
      jinx = true;
      me.points = Math.round(row.points * C.JINX_SPLIT);
      them.points = Math.round(row.points * C.JINX_SPLIT);
      send(this.opp(uid).id, { t: 'jinx', points: them.points, name });
    }
    send(uid, { t: 'guess_result', ok: true, name, fuzzy: !!fuzzy, typed, points: me.points, tier: row.tier,
      tierColor: row.tierColor, isKrillion: row.isKrillion, rarerThan: row.rarerThan, jinx });
    this.sendDepths();
    this.maybeEndRound();
  }

  applyWrong(uid, text) {
    const r = this.round;
    r.p[uid].wrong++;
    send(uid, { t: 'guess_result', ok: false, text, penalty: C.WRONG_GUESS_PENALTY, wrong: r.p[uid].wrong });
    this.sendDepths();
  }

  maybeEndRound() {
    if (this.players.every((p) => this.finishedFor(p.id))) {
      clearTimeout(this.round.timer);
      setTimeout(() => this.endRound(), 600);
    }
  }

  endRound() {
    const r = this.round;
    if (!r || r.done || this.over) return;
    r.done = true;
    clearTimeout(r.timer); clearTimeout(r.botTimer);
    const table = r.table;
    const { ordered } = P.rarityTable(r.prompt);
    const [a, b] = this.players;
    const jinx = r.p[a.id].key && r.p[a.id].key === r.p[b.id].key;
    const result = {};
    for (const u of this.players) {
      const s = r.p[u.id];
      let points = 0, rarerThan = null, tier = null, tierColor = null, isKrillion = false;
      if (s.key) {
        const row = table.get(s.key);
        points = s.points; rarerThan = row.rarerThan; tier = row.tier; tierColor = row.tierColor; isKrillion = row.isKrillion;
      }
      const penalty = s.wrong * C.WRONG_GUESS_PENALTY;
      const total = points - penalty;
      this.scores[u.id] += total;
      result[u.id] = { answer: s.name, points, penalty, total, rarerThan, tier, tierColor, isKrillion, fact: isKrillion ? table.get(s.key).fact : undefined, wrong: s.wrong, jinx: !!jinx, guesses: s.guesses };
    }
    // Real player answers feed the rarity stats (after scoring, so your own pick doesn't hurt you)
    for (const u of this.humans()) if (r.p[u.id].key) P.recordPick(r.prompt.id, r.p[u.id].key);

    const said = new Set(this.players.map((u) => r.p[u.id].key).filter(Boolean));
    const unsaid = ordered.filter((x) => !said.has(x.key) && !x.krillion); // never spoil a krillion answer
    const deepCuts = unsaid.slice(Math.floor(unsaid.length / 2)).sort(() => Math.random() - 0.5).slice(0, 3).map((x) => x.name);
    const mostCommon = ordered.slice(0, 3).map((x) => x.name);

    this.history.push({ promptId: r.prompt.id, text: r.prompt.text,
      [a.id]: { answer: result[a.id].answer, total: result[a.id].total },
      [b.id]: { answer: result[b.id].answer, total: result[b.id].total } });
    this.played.push({ prompt: r.prompt, result });

    for (const u of this.humans()) {
      const o = this.opp(u.id);
      send(u.id, { t: 'reveal', n: this.roundIndex + 1, total: this.prompts.length, promptId: r.prompt.id, text: r.prompt.text,
        you: result[u.id], opp: { ...result[o.id], guesses: undefined, answer: result[o.id].jinx ? result[o.id].answer : undefined, fact: undefined, answered: !!result[o.id].answer },
        scores: { you: this.scores[u.id], opp: this.scores[o.id] },
        deepCuts, mostCommon, answerCount: r.prompt.answers.length, nextAt: Date.now() + C.REVEAL_SECONDS * 1000 });
    }
    setTimeout(() => this.nextRound(), C.REVEAL_SECONDS * 1000);
  }

  // reason: 'normal' | 'forfeit'; loserId given for forfeits
  finish(reason, loserId = null) {
    if (this.over) return;
    this.over = true;
    if (this.round) { clearTimeout(this.round.timer); clearTimeout(this.round.botTimer); }
    for (const t of Object.values(this.forfeitTimers)) clearTimeout(t);
    const [a, b] = this.players;
    let resultA; // 1 win, 0 loss, 0.5 draw (from A's point of view)
    if (reason === 'forfeit') resultA = loserId === a.id ? 0 : 1;
    else resultA = this.scores[a.id] > this.scores[b.id] ? 1 : this.scores[a.id] < this.scores[b.id] ? 0 : 0.5;

    const fa = a.bot ? a : freshUser(a.id);
    const fb = b.bot ? b : freshUser(b.id);
    let dA = 0, dB = 0;
    if (this.ranked) ({ dA, dB } = eloChange(fa.rating, fa.games, fb.rating, fb.games, resultA));

    const winner = resultA === 1 ? a.id : resultA === 0 ? b.id : null;
    const upd = db.prepare(`UPDATE users SET rating = rating + ?, peak_rating = MAX(peak_rating, rating + ?), games = games + 1,
      wins = wins + ?, losses = losses + ?, draws = draws + ? WHERE id = ?`);
    if (this.ranked) {
      upd.run(dA, dA, resultA === 1 ? 1 : 0, resultA === 0 ? 1 : 0, resultA === 0.5 ? 1 : 0, a.id);
      upd.run(dB, dB, resultA === 0 ? 1 : 0, resultA === 1 ? 1 : 0, resultA === 0.5 ? 1 : 0, b.id);
    }
    db.prepare(`INSERT INTO matches (ranked, p1, p2, p1_score, p2_score, winner, p1_before, p2_before, p1_delta, p2_delta, end_reason, rounds_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      this.ranked ? 1 : 0, a.id, b.bot ? null : b.id, this.scores[a.id], this.scores[b.id],
      winner, fa.rating, b.bot ? null : fb.rating, dA, b.bot ? null : dB, reason, JSON.stringify(this.history), Date.now());

    for (const [u, before, delta, res] of [[fa, fa, dA, resultA], [fb, fb, dB, 1 - resultA]]) {
      if (u.bot) continue;
      inMatch.delete(u.id);
      const after = freshUser(u.id);
      const o = this.opp(u.id);
      send(u.id, { t: 'match_end', ranked: this.ranked, reason, forfeitedBy: reason === 'forfeit' ? (loserId === u.id ? 'you' : 'opp') : null,
        result: res === 1 ? 'win' : res === 0 ? 'loss' : 'draw',
        scores: { you: this.scores[u.id], opp: this.scores[o.id] },
        ratingBefore: before.rating, ratingAfter: after.rating, delta,
        rankBefore: rankFor(before.rating, before.games), rankAfter: rankFor(after.rating, after.games),
        you: publicUser(after), catch: this.catchFor(u.id) });
    }
  }

  // "The Catch": every round you played, with the full answer list for that prompt.
  // The two One in a Krillion answers (with their fun facts) come first, then the rest
  // from most points to least, A→Z inside each tier.
  catchFor(uid) {
    const o = this.opp(uid);
    const pick = (x) => x && { answer: x.answer, points: x.points, total: x.total, tier: x.tier, tierColor: x.tierColor, isKrillion: x.isKrillion };
    return this.played.map(({ prompt, result }) => {
      const { table } = P.rarityTable(prompt);
      const answers = [...table.values()]
        .map((a) => ({ name: a.name, points: a.points, tier: a.tier, color: a.tierColor, krillion: a.isKrillion, fact: a.krillion ? a.fact : undefined }))
        .sort((x, y) => (y.krillion - x.krillion) || (y.points - x.points) || x.name.localeCompare(y.name));
      return { promptId: prompt.id, text: prompt.text, category: prompt.category, you: pick(result[uid]), opp: pick(result[o.id]), answers };
    });
  }

  // Player dropped: give them a grace period to come back
  disconnected(uid) {
    if (this.over) return;
    const o = this.opp(uid);
    if (o.bot) return this.finish('forfeit', uid); // practice: just end it
    send(o.id, { t: 'opp_disconnected', forfeitAt: Date.now() + C.FORFEIT_AFTER_SECONDS * 1000 });
    this.forfeitTimers[uid] = setTimeout(() => this.finish('forfeit', uid), C.FORFEIT_AFTER_SECONDS * 1000);
  }

  reconnected(uid) {
    clearTimeout(this.forfeitTimers[uid]);
    delete this.forfeitTimers[uid];
    send(this.opp(uid).id, { t: 'opp_reconnected' });
    send(uid, this.startMsg(uid));
    const r = this.round;
    if (r && !r.done) {
      send(uid, { ...this.roundMsg(), resumed: true, mine: { name: r.p[uid].name, wrong: r.p[uid].wrong, points: r.p[uid].points },
        oppLocked: this.finishedFor(this.opp(uid).id) });
      this.sendDepths();
    }
    send(uid, { t: 'score', scores: { you: this.scores[uid], opp: this.scores[this.opp(uid).id] } });
  }
}

// ── Matchmaking ────────────────────────────────────────────────────────────
function rangeFor(since) {
  const secs = (Date.now() - since) / 1000;
  return Math.min(C.MATCH_RANGE_MAX, C.MATCH_RANGE_START + C.MATCH_RANGE_GROWTH * secs);
}

function tickQueue() {
  const waiting = [...queue.values()].sort((x, y) => x.since - y.since);
  const paired = new Set();
  for (const a of waiting) {
    if (paired.has(a.user.id)) continue;
    let best = null;
    for (const b of waiting) {
      if (b === a || paired.has(b.user.id)) continue;
      const diff = Math.abs(a.user.rating - b.user.rating);
      // both players have to be OK with the gap
      if (diff <= rangeFor(a.since) && diff <= rangeFor(b.since) && (!best || diff < best.diff)) best = { b, diff };
    }
    if (best) {
      paired.add(a.user.id); paired.add(best.b.user.id);
      queue.delete(a.user.id); queue.delete(best.b.user.id);
      new Match(freshUser(a.user.id), freshUser(best.b.user.id), true).start();
    }
  }
  for (const q of queue.values()) {
    send(q.user.id, { t: 'queue_status', waitingSecs: Math.floor((Date.now() - q.since) / 1000), range: Math.round(rangeFor(q.since)), inQueue: queue.size });
  }
}
setInterval(tickQueue, 1000).unref();

// ── Socket handling ────────────────────────────────────────────────────────
function onSocket(ws, userFromToken) {
  let uid = null;
  ws.on('message', (msg) => {
    ws.alive = true;
    if (!msg || typeof msg.t !== 'string') return;
    if (msg.t === 'auth') {
      const u = userFromToken(msg.token);
      if (!u) return ws.send({ t: 'error', code: 'auth', msg: 'Please log in again' });
      uid = u.id;
      const old = online.get(uid);
      online.set(uid, ws);
      if (old && old !== ws) { old.send({ t: 'error', code: 'replaced', msg: 'You opened the game somewhere else' }); old.close(); }
      ws.send({ t: 'hello', you: publicUser(u) });
      const m = inMatch.get(uid);
      if (m) m.reconnected(uid);
      return;
    }
    if (!uid) return;
    const m = inMatch.get(uid);
    switch (msg.t) {
      case 'queue':
        if (m || queue.has(uid)) return;
        queue.set(uid, { user: freshUser(uid), since: Date.now() });
        ws.send({ t: 'queued' });
        break;
      case 'cancel':
        queue.delete(uid);
        ws.send({ t: 'queue_cancelled' });
        break;
      case 'practice':
        if (m) return;
        queue.delete(uid);
        new Match(freshUser(uid), BOT, false).start();
        break;
      case 'guess':
        if (m) m.guess(uid, msg.text);
        break;
      case 'forfeit':
        if (m) m.finish('forfeit', uid);
        break;
      case 'report': {
        const text = String(msg.text || '').trim().slice(0, 80);
        if (text && P.get(msg.promptId)) {
          db.prepare('INSERT OR IGNORE INTO reports (user_id, prompt_id, text, created_at) VALUES (?, ?, ?, ?)')
            .run(uid, msg.promptId, text, Date.now());
          ws.send({ t: 'report_ok', text });
        }
        break;
      }
    }
  });
  ws.on('close', () => {
    if (!uid || online.get(uid) !== ws) return;
    online.delete(uid);
    queue.delete(uid);
    const m = inMatch.get(uid);
    if (m) m.disconnected(uid);
  });
}

function stats() { return { online: online.size, inQueue: queue.size, liveMatches: new Set(inMatch.values()).size }; }

module.exports = { onSocket, stats, publicUser };
