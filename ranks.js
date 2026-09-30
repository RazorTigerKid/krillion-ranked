// Rating (Elo) and rank tiers. All the numbers and names live in config.js.
//
// Beating someone rated higher than you gives more points; losing to someone rated
// lower costs more. During placements your rating moves faster.
const C = require('../config');

const RANKS = [...C.RANKS].sort((a, b) => a.min - b.min);

function rankFor(rating, games = C.PLACEMENT_GAMES) {
  if (games < C.PLACEMENT_GAMES) {
    return { tier: 'Unranked', division: null, label: `Placements ${games}/${C.PLACEMENT_GAMES}`, color: '#6b8594', next: null };
  }
  let i = RANKS.length - 1;
  while (i > 0 && rating < RANKS[i].min) i--;
  const t = RANKS[i];
  const nextTier = RANKS[i + 1];
  const isEnd = i === 0 || !nextTier;
  if (isEnd) {
    return { tier: t.name, division: null, label: t.name, color: t.color, from: i === 0 ? Math.min(rating, 0) : t.min, next: nextTier ? { label: nextTier.name, at: nextTier.min } : null };
  }
  const width = nextTier.min - t.min;
  const divs = C.DIVISIONS.length;
  const idx = Math.min(divs - 1, Math.floor(((rating - t.min) / width) * divs));
  const division = C.DIVISIONS[idx];
  const next = idx < divs - 1
    ? { label: `${t.name} ${C.DIVISIONS[idx + 1]}`, at: Math.ceil(t.min + (width * (idx + 1)) / divs) }
    : { label: nextTier.name, at: nextTier.min };
  const from = Math.ceil(t.min + (width * idx) / divs);
  return { tier: t.name, division, label: `${t.name} ${division}`, color: t.color, from, next };
}

function expected(a, b) {
  return 1 / (1 + Math.pow(10, (b - a) / 400));
}

// result: 1 = A won, 0 = A lost, 0.5 = draw. Returns rating changes for A and B.
function eloChange(ratingA, gamesA, ratingB, gamesB, result) {
  const kA = gamesA < C.PLACEMENT_GAMES ? C.K_PLACEMENT : C.K_NORMAL;
  const kB = gamesB < C.PLACEMENT_GAMES ? C.K_PLACEMENT : C.K_NORMAL;
  const eA = expected(ratingA, ratingB);
  let dA = Math.round(kA * (result - eA));
  let dB = Math.round(kB * ((1 - result) - (1 - eA)));
  if (result === 1) { dA = Math.max(dA, 1); dB = Math.min(dB, -1); }
  if (result === 0) { dA = Math.min(dA, -1); dB = Math.max(dB, 1); }
  return { dA, dB };
}

module.exports = { rankFor, eloChange, RANKS };
