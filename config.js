// ╔══════════════════════════════════════════════════════════════════╗
// ║  GAME SETTINGS — change anything here, then restart the server.   ║
// ╚══════════════════════════════════════════════════════════════════╝

module.exports = {
  // ── Matches ──────────────────────────────────────────────────────────
  PROMPTS_PER_MATCH: 7,      // how many prompts (rounds) in one match
  SECONDS_PER_ROUND: 25,     // time to answer each prompt
  REVEAL_SECONDS: 6,         // how long the round results show before the next prompt
  DESCENT_SECONDS: 3,        // "descending · the clock starts in 3" before each prompt
  WRONG_GUESS_PENALTY: 5,    // points lost per wrong guess (guesses are unlimited)
  METERS_PER_POINT: 10,      // how far your krill sinks per point (85 pts = sink 850m)
  JINX_SPLIT: 0.5,           // if both players say the same answer, each gets this fraction
  FORFEIT_AFTER_SECONDS: 20, // if someone disconnects mid-match, they lose after this long

  // ── Answer tiers (how many points an answer is worth) ──────────────────
  // Every correct answer gets a tier based on how rare it is.
  //   rarerThan: the answer has to be rarer than this % of all answers people give
  //   (0 = the most common answers, 100 = nobody ever says it)
  // Keep them sorted from most common to rarest.
  ANSWER_TIERS: [
    { name: 'Plankton', points: 10, rarerThan: 0,  color: '#8fa3b0' },
    { name: 'Schooler', points: 30, rarerThan: 45, color: '#3dd6c6' },
    { name: 'Rare',     points: 60, rarerThan: 75, color: '#b57bff' },
    { name: 'Deep Cut', points: 85, rarerThan: 93, color: '#ff9f43' },
  ],
  // The legendary tier. Every prompt has exactly 2 of these, written by hand in the
  // prompt files under "krillion" (with a fun fact). See data/prompts/ for examples.
  // If lots of players start saying one, it drops back to a normal tier so it can't be farmed.
  KRILLION_TIER: { name: 'One in a Krillion', points: 100, color: '#ffd54f' },
  KRILLION_DEMOTE_BELOW: 75, // a krillion answer loses its status if it becomes less rare than this

  // ── Rating ───────────────────────────────────────────────────────────
  START_RATING: 1000,
  PLACEMENT_GAMES: 10,       // first N games move your rating faster and show "Placements"
  K_PLACEMENT: 48,           // how much rating moves per game during placements
  K_NORMAL: 28,              // how much rating moves per game after placements

  // ── Ranks ────────────────────────────────────────────────────────────
  // Rename, recolor, add or remove ranks freely. Keep them sorted from lowest to highest.
  //   name:  what players see
  //   min:   rating needed to reach it (the first rank should be 0)
  //   color: badge color
  // Every rank except the lowest and highest is split into divisions III, II, I.
  RANKS: [
    { name: 'Plankton',  min: 0,    color: '#8fa3b0' },
    { name: 'Krill',     min: 800,  color: '#ff8a7a' },
    { name: 'Shrimp',    min: 950,  color: '#ff6f91' },
    { name: 'Crab',      min: 1100, color: '#e8743b' },
    { name: 'Squid',     min: 1250, color: '#b57bff' },
    { name: 'Dolphin',   min: 1400, color: '#4fc3f7' },
    { name: 'Shark',     min: 1550, color: '#5c7cfa' },
    { name: 'Orca',      min: 1700, color: '#e0e6ea' },
    { name: 'Leviathan', min: 1850, color: '#ffd54f' },
  ],
  DIVISIONS: ['III', 'II', 'I'],

  // ── Matchmaking ──────────────────────────────────────────────────────
  MATCH_RANGE_START: 100,    // at first, only match players within this many rating points
  MATCH_RANGE_GROWTH: 25,    // ...and widen the range by this much every second you wait
  MATCH_RANGE_MAX: 800,
};
