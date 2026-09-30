// Loads the prompt database, checks answers (with nicknames + typo tolerance),
// and works out how "rare" each answer is.
//
// ── Prompt files ────────────────────────────────────────────────────────────
// Every .json file in data/prompts/ looks like:
//   {
//     "category": "Geography",
//     "lists":   { "countries": [ ...answers... ] },     // reusable answer lists
//     "prompts": [
//       { "id": "countries",   "text": "Name a country", "list": "countries" },
//       { "id": "countries-b", "text": "Name a country starting with B",
//         "list": "countries", "filter": { "startsWith": "B" } },
//       { "id": "planets",     "text": "Name a planet", "answers": [ ... ] }
//     ]
//   }
//
// An answer can be written three ways:
//   "Brazil"                                        just the name
//   ["United States", "USA", "US", "America"]      name + other accepted spellings
//   { "a": "Nigeria", "alt": ["..."], "t": ["africa"] }   with tags for filters
//
// Every prompt also gets exactly TWO "One in a Krillion" answers, with a fun fact:
//   "krillion": [
//     { "a": "Kalles Kaviar", "fact": "Swedish cod-roe spread sold in a blue-and-yellow tube since 1954." },
//     { "a": "Space food",    "fact": "NASA astronaut meals came in aluminium squeeze tubes." }
//   ]
// They're worth 100 points, stay secret during matches, and show up in The Catch after.
//
// IMPORTANT: write answers roughly from MOST common to LEAST common. Before real
// players have played a prompt, that order decides how rare each answer is.
// After enough games, real player data takes over.

const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');
const C = require('../config');

const PROMPT_DIR = path.join(__dirname, '..', 'data', 'prompts');
const MIN_ANSWERS = 8;      // prompts with fewer valid answers are skipped
const SEED_PICKS = 60;      // total seed weight spread over the list (file order)
const REAL_DATA_HALF = 300; // after this many real answers to a prompt, real data and file order count equally

// ── Text normalisation ─────────────────────────────────────────────────────
function norm(s) {
  return String(s)
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')   // é -> e
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`.]/g, '')                             // don't -> dont, st. -> st
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/^(the|a|an) /, '')
    .replace(/\bsaint\b/g, 'st')                        // Saint Lucia == St Lucia
    .replace(/\bmount\b/g, 'mt');
}

// Plural/singular forgiveness: "tigers" -> "tiger", "berries" -> "berry"
function singular(w) {
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 4 && /(ches|shes|sses|xes|zes|oes)$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) return w.slice(0, -1);
  return w;
}
function variants(n) {
  const compact = n.replace(/ /g, '');
  const sing = n.split(' ').map(singular).join(' ');
  return new Set([n, compact, sing, sing.replace(/ /g, '')]);
}

function levenshtein(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      best = Math.min(best, cur[j]);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}
// Autocorrect: how many letters can be wrong, based on word length
function typoAllowance(len) {
  if (len <= 3) return 0;
  if (len <= 5) return 1;
  if (len <= 9) return 2;
  return 3;
}

// Words from the prompt itself ("Name a mountain range" -> mountain, range) can be left off
// an answer: "Appalachians" counts for "Appalachian Mountains", "vehicle" for "Vehicle insurance".
const STOP = new Set(('name a an the of type types kind kinds that in on with starting ending letter letters or and to used ' +
  'can be something some one for from is are by over than including all count counts as standard not your you people ' +
  'keep native lives more fewer its it any famous word words has have human body sold found appears like').split(' '));
function genericWords(text) {
  const out = new Set();
  for (const w of norm(text).split(' ')) {
    if (w.length < 3 || STOP.has(w) || /^\d/.test(w)) continue;
    out.add(w); out.add(singular(w)); out.add(w + 's'); out.add(w.endsWith('y') ? w.slice(0, -1) + 'ies' : w + 'es');
  }
  return out;
}
function stripGeneric(n, generic) {
  let words = n.split(' ');
  while (words.length > 1 && generic.has(words[words.length - 1])) words = words.slice(0, -1);
  while (words.length > 1 && generic.has(words[0])) words = words.slice(1);
  const s = words.join(' ');
  return s !== n && s.replace(/ /g, '').length >= 3 ? s : null;
}

// ── Loading ────────────────────────────────────────────────────────────────
function parseEntry(e) {
  if (typeof e === 'string') return { name: e, alts: [], tags: [] };
  if (Array.isArray(e)) return { name: e[0], alts: e.slice(1), tags: [] };
  return { name: e.a, alts: e.alt || [], tags: e.t || [], fact: e.fact || null };
}

function applyFilter(entries, f) {
  if (!f) return entries;
  return entries.filter((e) => {
    const n = norm(e.name);
    if (f.startsWith && !n.startsWith(norm(f.startsWith))) return false;
    if (f.endsWith && !n.endsWith(norm(f.endsWith))) return false;
    if (f.contains && !n.includes(norm(f.contains))) return false;
    if (f.tag && !e.tags.includes(f.tag)) return false;
    if (f.tags && !f.tags.some((t) => e.tags.includes(t))) return false;
    if (f.notTag && e.tags.includes(f.notTag)) return false;
    if (f.words && n.split(' ').length !== f.words) return false;
    if (f.minWords && n.split(' ').length < f.minWords) return false;
    if (f.maxLength && n.replace(/ /g, '').length > f.maxLength) return false;
    if (f.minLength && n.replace(/ /g, '').length < f.minLength) return false;
    return true;
  });
}

function buildPrompt(p, category, entries, file) {
  // One in a Krillion answers (exactly 2 per prompt) go last = rarest, and carry a fun fact.
  // If a krillion answer is already in the list (under any spelling), merge them.
  const kr = (p.krillion || []).map(parseEntry);
  const spellings = (e) => new Set([e.name, ...e.alts].map(norm));
  const kept = [];
  for (const e of entries) {
    const es = spellings(e);
    const k = kr.find((x) => [...spellings(x)].some((s) => es.has(s)));
    if (k) k.alts = [...new Set([...k.alts, e.name, ...e.alts])];
    else kept.push(e);
  }
  entries = [...kept, ...kr.map((k) => ({ ...k, krillion: true }))];
  const answers = [];           // [{ key, name }]
  const index = new Map();      // any accepted spelling variant -> answer key
  const soft = new Map();       // shortened spellings (generic word dropped); never override real ones
  const generic = genericWords(p.text);
  const seen = new Set();
  for (const e of entries) {
    const key = norm(e.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    answers.push({ key, name: e.name, krillion: !!e.krillion, fact: e.fact || null });
    for (const spelling of [e.name, ...e.alts]) {
      for (const v of variants(norm(spelling))) {
        if (!v) continue;
        const existing = index.get(v);
        if (existing && existing !== key) index.set(v, null); // ambiguous spelling -> reject
        else index.set(v, key);
      }
      const short = stripGeneric(norm(spelling), generic);
      if (short) for (const v of variants(short)) {
        const ex = soft.get(v);
        if (ex !== undefined && ex !== key) soft.set(v, null); else soft.set(v, key);
      }
    }
  }
  for (const [v, key] of soft) if (!index.has(v)) index.set(v, key);
  // Seed weights: earlier in the list = more common (Zipf curve)
  let total = 0;
  const w = answers.map((_, i) => { const x = 1 / (i + 1); total += x; return x; });
  answers.forEach((a, i) => { a.seed = (w[i] / total) * SEED_PICKS; });
  return { id: p.id, text: p.text, category: p.category || category, answers, index, generic, byKey: new Map(answers.map((a) => [a.key, a])), file };
}

function loadAll(dir = PROMPT_DIR) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  const raw = files.map((f) => {
    try { return { file: f, data: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }; }
    catch (err) { throw new Error(`Bad JSON in data/prompts/${f}: ${err.message}`); }
  });
  const lists = {};
  for (const { file, data } of raw) {
    for (const [name, arr] of Object.entries(data.lists || {})) {
      if (lists[name]) throw new Error(`List "${name}" is defined twice (second time in ${file})`);
      lists[name] = arr.map(parseEntry);
    }
  }
  const prompts = new Map();
  const warnings = [];
  for (const { file, data } of raw) {
    for (const p of data.prompts || []) {
      if (!p.id || !p.text) { warnings.push(`${file}: a prompt is missing "id" or "text"`); continue; }
      if (prompts.has(p.id)) { warnings.push(`${file}: duplicate prompt id "${p.id}"`); continue; }
      let entries;
      if (p.list) {
        if (!lists[p.list]) { warnings.push(`${file}: prompt "${p.id}" uses unknown list "${p.list}"`); continue; }
        entries = lists[p.list];
      } else entries = (p.answers || []).map(parseEntry);
      entries = applyFilter(entries, p.filter);
      const built = buildPrompt(p, data.category || 'General', entries, file);
      if (built.answers.length < MIN_ANSWERS) {
        warnings.push(`${file}: prompt "${p.id}" only has ${built.answers.length} answers (needs ${MIN_ANSWERS}), skipped`);
        continue;
      }
      const nk = built.answers.filter((a) => a.krillion).length;
      if (nk !== 2) warnings.push(`${file}: prompt "${p.id}" has ${nk} One in a Krillion answers (should be 2)`);
      for (const a of built.answers) if (a.krillion && !a.fact) warnings.push(`${file}: krillion answer "${a.name}" in "${p.id}" has no "fact"`);
      prompts.set(p.id, built);
    }
  }
  return { prompts, warnings };
}

let PROMPTS = new Map();
function reload() {
  const { prompts, warnings } = loadAll();
  PROMPTS = prompts;
  return { count: prompts.size, warnings };
}
function get(id) { return PROMPTS.get(id); }
function all() { return [...PROMPTS.values()]; }

// ── Checking a guess ───────────────────────────────────────────────────────
// Returns { ok: true, key, name } or { ok: false }
function check(prompt, guess) {
  const n0 = norm(guess);
  if (!n0) return { ok: false };
  const tries = [n0];
  const stripped = stripGeneric(n0, prompt.generic || new Set());
  if (stripped) tries.push(stripped);
  for (const n of tries) {
    for (const v of variants(n)) {
      if (prompt.index.has(v)) {
        const key = prompt.index.get(v);
        if (!key) return { ok: false };
        return { ok: true, key, name: prompt.byKey.get(key).name };
      }
    }
  }
  // Autocorrect: closest spelling within the typo allowance, and it has to be a clear winner
  for (const n of tries) {
    const target = n.replace(/ /g, '');
    const max = typoAllowance(target.length);
    if (max === 0) continue;
    let bestD = max + 1, bestKey = null, tie = false;
    for (const [spelling, key] of prompt.index) {
      if (!key) continue;
      const d = levenshtein(target, spelling.replace(/ /g, ''), max);
      if (d < bestD) { bestD = d; bestKey = key; tie = false; }
      else if (d === bestD && key !== bestKey) tie = true;
    }
    if (bestKey && bestD <= max && !tie) return { ok: true, key: bestKey, name: prompt.byKey.get(bestKey).name, fuzzy: true };
  }
  return { ok: false };
}

// ── Rarity ─────────────────────────────────────────────────────────────────
// Every answer gets "picks" = seed (from file order) + times real players said it.
// rarerThan = what % of all picks go to answers MORE popular than this one.
// That % picks the answer's tier (Plankton, Schooler, Rare, Deep Cut) from config.js.
// Answers marked "krillion": true get the One in a Krillion tier while they're still rare.
function tierFor(rarerThan, krillion) {
  const tiers = C.ANSWER_TIERS;
  let t = tiers[0];
  for (const x of tiers) if (rarerThan >= x.rarerThan) t = x;
  // Krillion answers stay legendary unless so many players say them that they drop below this cutoff
  if (krillion && rarerThan >= (C.KRILLION_DEMOTE_BELOW ?? 75)) return { ...C.KRILLION_TIER, krillion: true };
  return t;
}

function rarityTable(prompt) {
  const rows = db.prepare('SELECT answer_key, picks FROM answer_stats WHERE prompt_id = ?').all(prompt.id);
  const real = new Map(rows.map((r) => [r.answer_key, r.picks]));
  const realTotal = rows.reduce((s, r) => s + r.picks, 0);
  // The more real games a prompt has, the more real player data counts (half-and-half at REAL_DATA_HALF picks)
  const w = realTotal / (realTotal + REAL_DATA_HALF);
  const list = prompt.answers.map((a) => ({ key: a.key, name: a.name, krillion: a.krillion, fact: a.fact, real: real.get(a.key) || 0,
    share: (1 - w) * (a.seed / SEED_PICKS) + (realTotal ? w * ((real.get(a.key) || 0) / realTotal) : 0) }));
  list.sort((x, y) => y.share - x.share);
  let above = 0;
  const table = new Map();
  for (let i = 0; i < list.length; ) {
    let j = i, group = 0;
    while (j < list.length && Math.abs(list[j].share - list[i].share) < 1e-12) { group += list[j].share; j++; }
    for (let k = i; k < j; k++) {
      const rarerThan = Math.round(above * 100);
      const tier = tierFor(rarerThan, list[k].krillion);
      table.set(list[k].key, { ...list[k], rarerThan, points: tier.points, tier: tier.name, tierColor: tier.color, isKrillion: !!tier.krillion });
    }
    above += group;
    i = j;
  }
  return { table, ordered: list };
}

function recordPick(promptId, key) {
  db.prepare(`INSERT INTO answer_stats (prompt_id, answer_key, picks) VALUES (?, ?, 1)
              ON CONFLICT(prompt_id, answer_key) DO UPDATE SET picks = picks + 1`).run(promptId, key);
}

// Pick n random prompts, trying to spread across categories and skip recent ones.
function pickForMatch(n, avoid = new Set()) {
  let pool = all().filter((p) => !avoid.has(p.id));
  if (pool.length < n) pool = all();
  const chosen = [];
  const usedCats = new Set();
  const shuffled = pool.sort(() => Math.random() - 0.5);
  for (const p of shuffled) {
    if (chosen.length >= n) break;
    if (!usedCats.has(p.category)) { chosen.push(p); usedCats.add(p.category); }
  }
  for (const p of shuffled) {
    if (chosen.length >= n) break;
    if (!chosen.includes(p)) chosen.push(p);
  }
  return chosen;
}

module.exports = { reload, get, all, check, rarityTable, recordPick, pickForMatch, norm, loadAll };
