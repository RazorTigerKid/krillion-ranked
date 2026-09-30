# Krillion Ranked 🦐

A rare-answer trivia game with **live ranked 1v1 matches**. You and an opponent get the same prompts, like "Name a country in Africa". Each of you locks in one correct answer, and **the rarer your answer, the deeper your krill dives into the ocean**. You can watch your opponent's depth tracker sink live (never their answers). Win matches to climb the ranks from Plankton to Leviathan.

- 122 prompts, about 31,000 accepted answers (easy to add more)
- Ocean dive interface: every answer sinks you deeper (10 m per point), and your opponent's krill dives alongside you
- Autocorrect for typos, plurals and nicknames ("USA", "Brazill", "veenaa", "Appalachians")
- Ranked matchmaking with Elo ratings, placement games, ranks and divisions
- Practice mode against KrillBot
- Leaderboard and match history
- Reconnects you if your wifi blips mid-match
- A "this should count!" report button so players help grow the answer lists

**No installs needed besides Node.js.** It has zero dependencies, so you never have to run `npm install`.

---

## 1. Run it on your computer

1. Install **Node.js 22.5 or newer** from https://nodejs.org (pick "LTS").
2. Open a terminal in this folder and run:
   ```
   npm start
   ```
3. Go to **http://localhost:3000**.
4. To test ranked by yourself, open a second window in **incognito/private mode**, make a second account, and hit "Find ranked match" in both windows.

Friends on the same wifi can join at `http://YOUR-COMPUTER'S-IP:3000`.

## 2. Change the settings

Everything is in **`config.js`**. Open it, change a value, save, and restart (`Ctrl+C`, then `npm start` again).

| Want to… | Change |
|---|---|
| Rename ranks / change colors / change rating needed | `RANKS` |
| More or fewer prompts per match | `PROMPTS_PER_MATCH` (set to 7) |
| Longer or shorter timer | `SECONDS_PER_ROUND` |
| Make wrong guesses hurt more | `WRONG_GUESS_PENALTY` |
| Fewer placement games | `PLACEMENT_GAMES` |

## 3. Add prompts and answers

Prompts live in `data/prompts/*.json`. There's one file per category, and you can add new files.

```json
{ "id": "planets", "text": "Name a planet", "answers": [
    "Earth", "Mars", "Jupiter", "Saturn", ["Uranus", "Planet Uranus"], "Neptune"
] }
```

- **Put common answers first and rare ones last.** Until real people have played a prompt, that order decides how many points each answer is worth. After enough games, real player data takes over automatically.
- `["Name", "other spelling", "nickname"]` means all of those spellings count as the same answer.
- Every prompt needs exactly two One in a Krillion answers with a fact:
  `"krillion": [ { "a": "Timor-Leste", "alt": ["East Timor"], "fact": "One of the world's newest countries..." }, { ... } ]`
- Reuse a big list with a filter: `{ "id": "countries-b", "text": "Name a country starting with B", "list": "countries", "filter": { "startsWith": "B" } }`
  Filters: `startsWith`, `endsWith`, `contains`, `tag`, `tags`, `words`, `minWords`, `maxLength`, `minLength`.

After editing, check for mistakes:
```
npm run check-prompts
npm run check-prompts -- countries "usa" "brazill" "narnia"     ← tests some guesses
```

### Player reports
When someone's answer gets rejected, they can tap **Report it**. To see the reports:
```
npm run reports
```
If a report is right, add the answer to the prompt file, then run `npm run reports -- done 12` (12 is the report number). If it's wrong, run `npm run reports -- dismiss 12`.

## 4. How scoring and ranks work

- **Points per answer:** every correct answer lands in a tier:

  | Tier | Points | What it means |
  |---|---|---|
  | Plankton | 10 | one of the most common answers |
  | Schooler | 30 | a normal answer lots of people know |
  | Rare | 60 | not many people think of it |
  | Deep Cut | 85 | almost nobody says it |
  | One in a Krillion | 100 | legendary: exactly 2 per prompt, each with a fun fact |

  The tier depends on how rare the answer is: how many answers people give that are *more popular* than yours. Change the names, points, or cutoffs in `ANSWER_TIERS` in `config.js`.
- **One in a Krillion:** every prompt has exactly **2** hand-picked legendary answers, each with a fun fact. They're worth 100, stay secret during the match, and show up at the top of **The Catch** afterward. They're written under `"krillion"` in each prompt (see below). If tons of players start saying one, it drops to a normal tier so nobody can farm it.
- **How the other tiers are decided:** answers are listed from most famous to least famous, so the famous ones (China, Dog, Toothpaste) are Plankton and obscure ones are Deep Cut. After enough games, what real players actually say takes over.
- **The Catch:** after every match, tap any round to see every accepted answer, with the 2 krillions and their facts at the top.
- **Wrong guess:** −5 points each. Guesses are unlimited, so you're never locked out. Keep trying until you hit a real answer or time runs out.
- **Jinx:** if both players say the same answer, each gets half.
- **Rating (Elo):** everyone starts at 1000. Beating a higher-rated player gets you more points, and losing to a lower-rated player costs more. The first 10 games are placements, where your rating moves faster.
- **Matchmaking:** you're first matched with people within ±100 rating, and the range widens the longer you wait.
- **Leaving a match:** you have 20 seconds to reconnect. After that, it counts as a forfeit (a loss).

## 5. Put it online so anyone can play

Any host that runs Node.js 22.5+ works. **Important:** the database is one file (`data/krillion.db`), so the host needs a **persistent disk**. Otherwise accounts and ranks get wiped every time you redeploy.

**Railway (easy):**
1. Put this folder on GitHub.
2. On railway.app, click New Project → Deploy from GitHub → pick the repo. The start command is `npm start`.
3. Add a **Volume** mounted at `/data`, and set the variable `DB_PATH=/data/krillion.db`.
4. Under Settings → Networking, click "Generate Domain". That's your game link.

**Render:** use a Web Service with start command `npm start`, add a Disk mounted at `/data`, and set `DB_PATH=/data/krillion.db`. Disks need a paid plan there.

Want your own name like `krillionranked.com`? Buy the domain and point it at your host (both hosts have a "custom domain" setting).

## 6. Project layout

```
config.js            ← all the settings
data/prompts/        ← the question database (JSON)
public/              ← what players see (HTML, CSS, JS)
server/
  index.js           ← web server + API
  game.js            ← matchmaking, live matches, bot
  prompts.js         ← answer checking + rarity scoring
  ranks.js           ← Elo + rank names
  auth.js            ← accounts + logins
  db.js              ← SQLite database
  ws.js              ← WebSocket (live connection) code
scripts/             ← check-prompts, reports
test/                ← npm test plays full matches automatically
```

Run `npm test` any time you change the code. It plays full ranked, practice, disconnect and reconnect matches to make sure nothing broke.
