// End-to-end test: two players sign up, queue for ranked, play a full match,
// plus a practice match vs the bot and a disconnect/forfeit.   Run: npm test
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

// Fast settings for testing, and a throwaway database
const C = require('../config');
Object.assign(C, { SECONDS_PER_ROUND: 3, REVEAL_SECONDS: 0.3, FORFEIT_AFTER_SECONDS: 1, DESCENT_SECONDS: 0.2 });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'krillion-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.PORT = 3999;
require('../server/index.js');
const P = require('../server/prompts');

const BASE = 'http://localhost:3999';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function signup(name) {
  const r = await fetch(BASE + '/api/register', { method: 'POST', body: JSON.stringify({ username: name, password: 'secret123' }) });
  const d = await r.json();
  assert.ok(d.token, 'register failed: ' + JSON.stringify(d));
  return d.token;
}

function client(token) {
  const ws = new WebSocket('ws://localhost:3999/ws');
  const inbox = [];
  const waiters = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    inbox.push(m);
    for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
  };
  const c = {
    ws, inbox,
    send: (o) => ws.send(JSON.stringify(o)),
    waitFor: (t, timeout = 15000) => new Promise((resolve, reject) => {
      const pred = typeof t === 'function' ? t : (m) => m.t === t;
      const found = inbox.find(pred);
      if (found) { inbox.splice(inbox.indexOf(found), 1); return resolve(found); }
      const w = { pred, resolve: (m) => { inbox.splice(inbox.indexOf(m), 1); clearTimeout(timer); resolve(m); } };
      const timer = setTimeout(() => reject(new Error('timeout waiting for ' + t)), timeout);
      waiters.push(w);
    }),
  };
  return new Promise((res) => { ws.onopen = () => { c.send({ t: 'auth', token }); res(c); }; });
}

(async () => {
  let passed = 0;
  const ok = (msg) => { passed++; console.log('  ✓ ' + msg); };

  // ── 1. Ranked match ──
  const tA = await signup('alice'), tB = await signup('bob');
  const bad = await (await fetch(BASE + '/api/register', { method: 'POST', body: JSON.stringify({ username: 'alice', password: 'secret123' }) })).json();
  assert.match(bad.error, /taken/); ok('duplicate username rejected');

  const A = await client(tA), B = await client(tB);
  await A.waitFor('hello'); await B.waitFor('hello'); ok('both players connected');
  A.send({ t: 'queue' }); B.send({ t: 'queue' });
  const sA = await A.waitFor('match_start'); const sB = await B.waitFor('match_start');
  assert.equal(sA.ranked, true); assert.equal(sA.opp.name, 'bob'); assert.equal(sA.rounds, C.PROMPTS_PER_MATCH);
  ok(`matchmaking paired alice vs bob (${sA.rounds} prompts)`);

  const seenPrompts = new Set();
  for (let i = 1; i <= sA.rounds; i++) {
    const rA = await A.waitFor('round'); await B.waitFor('round');
    assert.equal(rA.n, i);
    await sleep(300); // wait out the "descending" countdown
    seenPrompts.add(rA.promptId);
    const prompt = P.get(rA.promptId);
    if (i === 1) {
      // Alice: one wrong guess then the most common answer. Bob: a rare answer.
      A.send({ t: 'guess', text: 'zzzz not a real answer' });
      const g = await A.waitFor('guess_result'); assert.equal(g.ok, false);
      const d = await B.waitFor('depths'); assert.equal(d.opp, -C.WRONG_GUESS_PENALTY); // bob sees alice float up
      await sleep(300);
      A.send({ t: 'guess', text: prompt.answers[0].name });
      assert.equal((await A.waitFor('guess_result')).ok, true);
      B.send({ t: 'guess', text: prompt.answers[prompt.answers.length - 1].name });
      const rev = await B.waitFor('reveal'); const revA = await A.waitFor('reveal');
      assert.ok(rev.you.points > revA.you.points, 'rare answer should beat common answer');
      assert.equal(rev.opp.answer, undefined, "opponent's answer stays hidden");
      assert.equal(revA.you.penalty, C.WRONG_GUESS_PENALTY);
      assert.equal(revA.you.tier, 'Plankton'); assert.equal(revA.you.points, 10);
      assert.ok(C.ANSWER_TIERS.concat(C.KRILLION_TIER).some((t) => t.name === rev.you.tier && t.points === rev.you.points));
      ok(`round 1: ${rev.you.tier} answer ${rev.you.points} pts beats common ${revA.you.points} pts, wrong guess −${revA.you.penalty}`);
    } else if (i === 2) {
      // Jinx: same answer
      const ans = prompt.answers[3].name;
      A.send({ t: 'guess', text: ans }); B.send({ t: 'guess', text: ans.toUpperCase() + ' ' });
      const rv = await A.waitFor('reveal'); await B.waitFor('reveal');
      assert.equal(rv.you.jinx, true); ok('round 2: jinx detected, points split');
    } else if (i === 3) {
      // Nobody answers: timer runs out
      const rv = await A.waitFor('reveal'); await B.waitFor('reveal');
      assert.equal(rv.you.total, 0); ok('round 3: timeout with no answer = 0');
    } else {
      // Bob plays rare, Alice plays common -> Bob wins
      A.send({ t: 'guess', text: prompt.answers[0].name });
      B.send({ t: 'guess', text: prompt.answers[prompt.answers.length - 2].name });
      await A.waitFor('reveal'); await B.waitFor('reveal');
    }
  }
  assert.equal(seenPrompts.size, sA.rounds); ok('no repeated prompts in a match');
  const eA = await A.waitFor('match_end'), eB = await B.waitFor('match_end');
  assert.equal(eB.result, 'win'); assert.equal(eA.result, 'loss');
  assert.ok(eB.delta > 0 && eA.delta < 0);
  ok(`bob won ${eB.scores.you}–${eB.scores.opp}; rating bob +${eB.delta}, alice ${eA.delta}`);

  const hist = await (await fetch(BASE + '/api/history', { headers: { Authorization: 'Bearer ' + tB } })).json();
  assert.equal(hist[0].result, 'win'); ok('match saved to history');

  // ── 2. Practice vs bot ──
  A.send({ t: 'practice' });
  const pm = await A.waitFor('match_start');
  assert.equal(pm.ranked, false); assert.equal(pm.opp.bot, true);
  for (let i = 1; i <= pm.rounds; i++) {
    const r = await A.waitFor('round');
    await sleep(300);
    A.send({ t: 'guess', text: P.get(r.promptId).answers[5].name });
    await A.waitFor('reveal');
  }
  const pe = await A.waitFor('match_end');
  assert.equal(pe.delta, 0); ok(`practice vs bot finished (${pe.result}, no rating change)`);

  // ── 3. Disconnect -> forfeit ──
  A.send({ t: 'queue' }); B.send({ t: 'queue' });
  await A.waitFor('match_start'); await B.waitFor('match_start');
  await A.waitFor('round');
  B.ws.close();
  await A.waitFor('opp_disconnected');
  const fe = await A.waitFor('match_end');
  assert.equal(fe.result, 'win'); assert.equal(fe.reason, 'forfeit');
  ok('opponent disconnect -> forfeit win after grace period');

  // ── 4. Reconnect mid-match ──
  const B2 = await client(tB); await B2.waitFor('hello');
  A.send({ t: 'queue' }); B2.send({ t: 'queue' });
  await A.waitFor('match_start'); await B2.waitFor('match_start');
  await B2.waitFor('round');
  B2.ws.close();
  await A.waitFor('opp_disconnected');
  const B3 = await client(tB);
  await B3.waitFor('hello');
  const resumed = await B3.waitFor('match_start');
  await A.waitFor('opp_reconnected');
  ok('reconnect within grace period resumes the match');
  B3.send({ t: 'forfeit' });
  const ff = await B3.waitFor('match_end');
  assert.equal(ff.result, 'loss'); ok('manual forfeit = loss');

  // ── 5. Answer tiers ──
  const shapes = P.rarityTable(P.get('shapes')).table;
  assert.equal(shapes.get('circle').tier, 'Plankton');
  assert.equal(shapes.get('rhombicosidodecahedron').tier, 'One in a Krillion');
  assert.equal(shapes.get('rhombicosidodecahedron').points, 100);
  ok('tiers: Circle = Plankton (10), Rhombicosidodecahedron = One in a Krillion (100)');

  // ── 6. Leaderboard / info ──
  const info = await (await fetch(BASE + '/api/info')).json();
  assert.ok(info.prompts > 50); ok(`info: ${info.prompts} prompts, ${info.answers} answers`);

  console.log(`\nAll ${passed} checks passed ✅`);
  process.exit(0);
})().catch((e) => { console.error('\n❌ TEST FAILED:', e); process.exit(1); });
