// Review "my answer should have counted" reports from players.
//   npm run reports                 list open reports
//   npm run reports -- dismiss 12   mark report #12 as dismissed
//   npm run reports -- done 12      mark report #12 as done (after you add it to the prompt file)
//
// To accept a report: open the prompt's file in data/prompts/, add the answer
// (or add it as another spelling of an existing answer), then mark it done.
const db = require('../server/db');
const P = require('../server/prompts');
P.reload();

const [cmd, id] = process.argv.slice(2);
if (cmd === 'dismiss' || cmd === 'done') {
  const r = db.prepare('UPDATE reports SET status = ? WHERE id = ?').run(cmd === 'done' ? 'done' : 'dismissed', Number(id));
  console.log(r.changes ? `Report #${id} marked ${cmd}` : `No report #${id}`);
  process.exit(0);
}

const rows = db.prepare(`SELECT r.id, r.prompt_id, r.text, r.created_at, u.username FROM reports r
  LEFT JOIN users u ON u.id = r.user_id WHERE r.status = 'open' ORDER BY r.prompt_id, r.id`).all();
if (!rows.length) { console.log('No open reports 🎉'); process.exit(0); }
let last = null;
for (const r of rows) {
  const p = P.get(r.prompt_id);
  if (r.prompt_id !== last) {
    console.log(`\n${p ? `"${p.text}"` : r.prompt_id}  (id: ${r.prompt_id}${p ? `, file: data/prompts/${p.file}` : ''})`);
    last = r.prompt_id;
  }
  const nowOk = p && P.check(p, r.text).ok;
  console.log(`  #${r.id}  "${r.text}"  — by ${r.username || '?'}${nowOk ? '  (already accepted now)' : ''}`);
}
console.log('\nMark handled with:  npm run reports -- done <#>   or   npm run reports -- dismiss <#>');
