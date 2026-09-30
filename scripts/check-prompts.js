// Checks the prompt database for mistakes and prints a summary.
//   npm run check-prompts            summary + warnings
//   npm run check-prompts -- <id>    also test some guesses against one prompt, e.g.
//   npm run check-prompts -- countries "usa" "brazill" "narnia"
process.env.DB_PATH = ':memory:';
const P = require('../server/prompts');

let loaded;
try { loaded = P.reload(); } catch (e) { console.error('❌ ' + e.message); process.exit(1); }

const byCat = {};
let total = 0;
for (const p of P.all()) {
  byCat[p.category] = byCat[p.category] || { prompts: 0, answers: 0 };
  byCat[p.category].prompts++;
  byCat[p.category].answers += p.answers.length;
  total += p.answers.length;
}
console.log('\nCategory                 Prompts   Answers');
console.log('─'.repeat(44));
for (const [c, v] of Object.entries(byCat).sort()) console.log(c.padEnd(24), String(v.prompts).padStart(7), String(v.answers).padStart(9));
console.log('─'.repeat(44));
console.log('TOTAL'.padEnd(24), String(P.all().length).padStart(7), String(total).padStart(9));

if (loaded.warnings.length) {
  console.log(`\n⚠ ${loaded.warnings.length} warning(s):`);
  for (const w of loaded.warnings) console.log('  - ' + w);
} else console.log('\n✅ No problems found');

const [id, ...guesses] = process.argv.slice(2);
if (id) {
  const p = P.get(id);
  if (!p) { console.log(`\nNo prompt with id "${id}"`); process.exit(1); }
  console.log(`\n"${p.text}" — ${p.answers.length} answers`);
  const { table } = P.rarityTable(p);
  for (const g of guesses) {
    const r = P.check(p, g);
    console.log(`  ${JSON.stringify(g).padEnd(26)} ${r.ok ? `✅ ${r.name}${r.fuzzy ? ' (typo fixed)' : ''} — ${table.get(r.key).tier}, ${table.get(r.key).points} pts` : '❌ not accepted'}`);
  }
}
