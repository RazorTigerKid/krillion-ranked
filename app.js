// Krillion Ranked — browser client (ocean dive edition)
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} } };

  let token = store.get('krillion_token');
  let me = null, info = null, ws = null, wsRetry = 0, lastMode = 'ranked';
  const M = { rounds: 7, n: 0, opp: null, you: null, ranked: true, lastWrong: null, promptId: null, end: null, lockedThisRound: false };

  // ════════════════════════ OCEAN SCENE ENGINE ════════════════════════
  const PX_PER_M = 0.55;               // screen pixels per meter of depth
  let MPP = 10;                         // meters per point (from server config)
  const world = $('world'), scene = $('scene');
  const kYou = $('krill-you'), kOpp = $('krill-opp');
  let cam = 0, camTarget = 0, follow = null;   // follow: 'you' or null (fixed target)
  let youM = 0, oppM = 0;

  const ZONES = [
    [100, 'most seaweed stops here'],
    [200, 'light begins to fade · the twilight zone'],
    [332, 'deepest scuba dive ever · 332m'],
    [500, 'giant squid territory'],
    [1000, 'most sunlight stops here · the midnight zone'],
    [2250, 'sperm whales hunt this deep'],
    [3800, 'the Titanic rests here'],
    [4000, 'the abyss begins'],
    [6000, 'the hadal zone · ocean trenches'],
    [6900, 'snailfish drift down here'],
  ];
  // water colour by depth (meters)
  const COLORS = [[0, [47, 110, 150]], [150, [34, 86, 124]], [400, [20, 58, 92]], [1000, [11, 33, 58]], [2500, [7, 20, 38]], [5000, [4, 11, 23]], [7500, [2, 5, 12]]];
  function waterAt(m) {
    if (m <= 0) return 'rgb(47,110,150)';
    for (let i = 1; i < COLORS.length; i++) {
      const [m1, c1] = COLORS[i], [m0, c0] = COLORS[i - 1];
      if (m <= m1) { const k = (m - m0) / (m1 - m0); return `rgb(${c0.map((v, j) => Math.round(v + (c1[j] - v) * k)).join(',')})`; }
    }
    return 'rgb(2,5,12)';
  }
  const y = (m) => m * PX_PER_M;
  const ky = (m) => y(m) + 36;         // krill/tags sit a little under the waves at 0m

  function buildDeco() {
    const d = $('deco'); let h = '';
    for (const [m, label] of ZONES) h += `<div class="zone" style="top:${y(m)}px"><span>${m.toLocaleString()}m · ${esc(label)}</span></div>`;
    const rnd = (a, b) => a + Math.random() * (b - a);
    for (let i = 0; i < 26; i++) { const m = rnd(15, 420), r = Math.random() < .5; h += `<div class="fish ${r ? 'r' : ''}" style="top:${y(m)}px;left:${r ? rnd(80, 140) : rnd(-40, 20)}vw;animation-duration:${rnd(28, 60)}s;animation-delay:-${rnd(0, 60)}s;transform:${r ? 'scaleX(-1)' : ''} scale(${rnd(.6, 1.3)})"></div>`; }
    for (let i = 0; i < 18; i++) h += `<div class="jelly" style="top:${y(rnd(250, 2200))}px;left:${rnd(5, 85)}%;animation-delay:-${rnd(0, 7)}s"></div>`;
    for (let i = 0; i < 220; i++) h += `<div class="speck" style="top:${y(rnd(150, 7600))}px;left:${rnd(0, 96)}%;animation-delay:-${rnd(0, 3)}s"></div>`;
    for (let i = 0; i < 22; i++) h += `<div class="angler" style="top:${y(rnd(1100, 7400))}px;left:${rnd(4, 90)}%;animation-delay:-${rnd(0, 2)}s"></div>`;
    for (let i = 0; i < 16; i++) { const m = rnd(1400, 7600), w = rnd(160, 420); h += `<div class="rock" style="top:${y(m)}px;left:${rnd(-5, 85)}%;width:${w}px;height:${w * rnd(.35, .6)}px"></div>`; }
    for (let i = 0; i < 20; i++) { const m = rnd(1500, 7600), hh = rnd(80, 220); h += `<div class="kelp" style="top:${y(m) - hh}px;height:${hh}px;left:${rnd(0, 92)}%;animation-delay:-${rnd(0, 5)}s"></div>`; }
    d.innerHTML = h;
  }
  buildDeco();

  function setYou(m) { youM = m; kYou.style.top = ky(Math.max(-5, m)) + 'px'; }
  function setOpp(m) { oppM = m; kOpp.style.top = ky(Math.max(-5, m)) + 'px'; }
  function camAt(m, frac) { follow = null; camTarget = y(m) - innerHeight * frac; } // put depth m at `frac` of screen height
  function followYou() { follow = 'you'; }

  let lastRuler = null;
  function drawRuler() {
    const topM = cam / PX_PER_M, botM = (cam + innerHeight) / PX_PER_M;
    const key = Math.round(topM);
    if (key === lastRuler) return; lastRuler = key;
    let h = '';
    const step = 50;
    for (let m = Math.max(0, Math.ceil(topM / step) * step); m <= botM; m += step) {
      const major = m % 250 === 0;
      h += `<div class="tick ${major ? 'major' : ''}" style="top:${y(m) - cam}px">${major ? `<span>-${m.toLocaleString()}m</span>` : ''}</div>`;
    }
    $('ruler-ticks').innerHTML = h;
  }
  function placeMarker(el, krillEl) {
    const r = krillEl.getBoundingClientRect();
    const cy = r.top + r.height / 2;
    const top = Math.max(26, Math.min(innerHeight - 26, cy));
    el.style.top = top + 'px';
    el.classList.toggle('edge-top', cy < 26); el.classList.toggle('edge-bottom', cy > innerHeight - 26);
  }
  function frame() {
    if (follow === 'you') {
      const r = kYou.getBoundingClientRect();
      const krillWorldY = r.top + r.height / 2 + cam;
      camTarget = krillWorldY - innerHeight * 0.5;
    }
    cam += (camTarget - cam) * 0.07;
    world.style.transform = `translateY(${-cam}px)`;
    scene.style.backgroundColor = waterAt((cam + innerHeight / 2) / PX_PER_M);
    drawRuler();
    placeMarker($('rmark-you'), kYou);
    if (!kOpp.classList.contains('hidden')) placeMarker($('rmark-opp'), kOpp);
    requestAnimationFrame(frame);
  }
  camAt(0, 0.55); cam = camTarget; requestAnimationFrame(frame);

  function bubbles(n = 8, fromOpp = false) {
    const k = (fromOpp ? kOpp : kYou), b = $('bubbles');
    const r = k.getBoundingClientRect();
    for (let i = 0; i < n; i++) {
      setTimeout(() => {
        const e = document.createElement('div');
        e.className = 'bubble';
        const rr = k.getBoundingClientRect();
        e.style.left = (rr.left + rr.width / 2 + (Math.random() * 20 - 10)) + 'px';
        e.style.top = (rr.top + cam) + 'px';
        e.style.setProperty('--dx', (Math.random() * 30 - 15) + 'px');
        const s = 4 + Math.random() * 7; e.style.width = e.style.height = s + 'px';
        b.appendChild(e); setTimeout(() => e.remove(), 2500);
      }, i * 140);
    }
    return r;
  }

  // Dashed tier lines below you: "PLANKTON · 10", "SCHOOLER · 30" …
  function showGuides(fromM) {
    const g = $('guides');
    const tiers = (info && info.answerTiers) || [];
    g.innerHTML = tiers.map((t) => `<div class="guide" style="top:${ky(fromM + t.points * MPP)}px;border-color:${t.color};color:${t.color}"><span>${esc(t.name.toUpperCase())} · ${t.points}</span></div>`).join('');
    requestAnimationFrame(() => g.querySelectorAll('.guide').forEach((e) => e.classList.add('on')));
    clearTimeout(showGuides.t); showGuides.t = setTimeout(() => g.querySelectorAll('.guide').forEach((e) => e.classList.remove('on')), 4200);
  }
  function sinkTag(text, color, fromM, toM) {
    const t = document.createElement('div');
    t.className = 'tag';
    t.textContent = `“${text}”`;
    t.style.color = color || 'var(--text)';
    t.style.left = innerWidth < 640 ? 'calc(14% + 28px)' : 'calc(16% + 34px)';
    t.style.top = ky(fromM) + 'px';
    $('tags').appendChild(t);
    requestAnimationFrame(() => requestAnimationFrame(() => { t.style.top = ky(toM) + 'px'; }));
    setTimeout(() => { t.style.opacity = '.35'; }, 9000);
  }

  // Creatures for each tier (little SVG drawings)
  function creature(tier, color) {
    const c = color || '#8aa3b5';
    const svg = (inner, vb = '0 0 64 40') => `<svg viewBox="${vb}" style="color:${c}" fill="${c}">${inner}</svg>`;
    switch (tier) {
      case 'Plankton': return svg('<circle cx="14" cy="20" r="3"/><circle cx="26" cy="12" r="2"/><circle cx="32" cy="26" r="3.5"/><circle cx="44" cy="16" r="2.5"/><circle cx="50" cy="28" r="2"/><circle cx="22" cy="30" r="1.8"/>');
      case 'Schooler': return svg('<path d="M4 12 l5-4v8z M9 12 c4-6 14-6 18 0 c-4 6-14 6-18 0z"/><path d="M30 22 l5-4v8z M35 22 c4-6 14-6 18 0 c-4 6-14 6-18 0z"/><path d="M12 32 l5-4v8z M17 32 c4-6 14-6 18 0 c-4 6-14 6-18 0z"/>');
      case 'Rare': return svg('<path d="M32 2 c10 0 14 10 12 20 h-24 c-2-10 2-20 12-20z"/><g stroke="currentColor" stroke-width="2.4" fill="none" stroke-linecap="round"><path d="M22 22 c-2 8-6 12-10 16"/><path d="M28 22 c0 8-2 12-4 16"/><path d="M36 22 c0 8 2 12 4 16"/><path d="M42 22 c2 8 6 12 10 16"/></g><circle cx="27" cy="14" r="2" fill="#0a1420"/><circle cx="37" cy="14" r="2" fill="#0a1420"/>');
      case 'Deep Cut': return svg('<path d="M12 22 c4-12 26-14 34-4 l10-8 v24 l-10-8 c-8 10-30 8-34-4z"/><path d="M22 12 c2-8 10-10 14-8" stroke="currentColor" stroke-width="1.6" fill="none"/><circle cx="37" cy="5" r="3" fill="#e8ff9e"/><path d="M13 24 l3 3 l3-3 l3 3 l3-3" stroke="#0a1420" stroke-width="1.2" fill="none"/><circle cx="20" cy="18" r="2" fill="#0a1420"/>');
      case 'One in a Krillion': return svg('<path d="M24 10 C34 6 44 12 42 22 C41 29 35 33 29 32 C34 29 36 25 34 20 C32 15 27 14 24 10 Z"/><g stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"><path d="M25 9 C20 1 14 0 10 2"/><path d="M26 8 C23 0 18 -2 13 -1"/></g><circle cx="27" cy="12" r="1.6" fill="#221a00"/><path d="M8 26 l2-5 l2 5 l5 2 l-5 2 l-2 5 l-2-5 l-5-2z M52 8 l1.5-4 l1.5 4 l4 1.5 l-4 1.5 l-1.5 4 l-1.5-4 l-4-1.5z M54 30 l1-3 l1 3 l3 1 l-3 1 l-1 3 l-1-3 l-3-1z"/>', '0 -4 64 44');
      default: return svg('<circle cx="24" cy="26" r="6" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="38" cy="14" r="4" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="44" cy="30" r="3" fill="none" stroke="currentColor" stroke-width="2"/>');
    }
  }
  const FLAVOR = {
    'Plankton': 'Everyone thought of it. You drift with the plankton.',
    'Schooler': 'Solid — swims with the school.',
    'Rare': 'Few swim this deep. The light is fading.',
    'Deep Cut': 'True obscurity. Few go this deep.',
    'One in a Krillion': 'One in a krillion. Legendary.',
  };

  // ════════════════════════ UI HELPERS ════════════════════════
  function show(screen) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === 'screen-' + screen));
  }
  function toast(msg, ms = 2800) { const t = $('toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add('hidden'), ms); }
  function banner(text) { banner.on = true; $('banner').textContent = text; $('banner').classList.remove('hidden'); }
  function hideBanner() { banner.on = false; clearTimeout(banner.t); $('banner').classList.add('hidden'); }
  const meters = (pts) => `${Math.round(pts * MPP).toLocaleString()}m`;

  async function api(path, body) {
    const res = await fetch('/api/' + path, { method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { logout(false); throw new Error('logged out'); }
    return { ok: res.ok, data };
  }
  function badge(el, rank) { el.style.setProperty('--c', rank.color); el.textContent = rank.tier === 'Unranked' ? '?' : rank.division || (!rank.next ? '★' : rank.tier[0]); }

  // ════════════════════════ AUTH ════════════════════════
  let authMode = 'login';
  document.querySelectorAll('[data-auth]').forEach((b) => b.addEventListener('click', () => {
    authMode = b.dataset.auth;
    document.querySelectorAll('[data-auth]').forEach((x) => x.classList.toggle('active', x === b));
    $('auth-submit').textContent = authMode === 'login' ? '▼ LOG IN ▼' : '▼ CREATE DIVER ▼';
    $('auth-error').textContent = '';
  }));
  $('auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    $('auth-submit').disabled = true;
    try {
      const { ok, data } = await api(authMode, { username: f.username.value, password: f.password.value });
      if (!ok) { $('auth-error').textContent = data.error || 'Something went wrong'; return; }
      token = data.token; store.set('krillion_token', token); f.reset();
      await enterHome(); connect();
    } finally { $('auth-submit').disabled = false; }
  });
  $('logout').addEventListener('click', () => logout(true));
  function logout(callServer) {
    if (callServer && token) api('logout', {}).catch(() => {});
    token = null; me = null; store.set('krillion_token', null);
    if (ws) { ws.onclose = null; ws.close(); ws = null; }
    toSurface(); show('auth');
  }

  // ════════════════════════ HOME ════════════════════════
  function toSurface() { kOpp.classList.add('hidden'); $('rmark-opp').classList.add('hidden'); setYou(0); camAt(0, 0.55); }
  async function enterHome() {
    toSurface(); show('home');
    await Promise.all([loadInfo(), loadMe()]);
  }
  async function loadInfo() {
    const { data } = await api('info');
    info = data; MPP = info.metersPerPoint || 10;
    $('db-info').textContent = `${info.prompts} prompts · ${info.answers.toLocaleString()} accepted answers`;
    $('online-count').textContent = `${info.online} online`;
    const tl = `${info.promptsPerMatch} prompts · ${info.secondsPerRound} seconds each · rarer answers sink deeper`;
    document.querySelectorAll('.tagline').forEach((e) => { e.textContent = tl; });
  }
  async function loadMe() {
    const { data } = await api('me');
    me = data;
    $('me-name').textContent = `${me.name} · ${me.wins}W ${me.losses}L${me.draws ? ` ${me.draws}D` : ''}`;
    badge($('me-badge'), me.rank);
    $('me-rank').textContent = `${me.rank.label.toUpperCase()}${me.rank.tier === 'Unranked' ? '' : ` · ${me.rating}`}`;
    $('me-rank').style.color = me.rank.color;
    if (me.rank.tier === 'Unranked') {
      const p = info ? info.placements : 10;
      $('me-progress').style.width = (me.games / p) * 100 + '%';
      $('me-next').textContent = `${p - me.games} more ranked dive${p - me.games === 1 ? '' : 's'} until you get a rank`;
    } else if (me.rank.next) {
      const from = me.rank.tier === 'Plankton' ? Math.max(0, me.rank.next.at - 200) : me.rank.from;
      $('me-progress').style.width = Math.max(4, Math.min(100, ((me.rating - from) / (me.rank.next.at - from)) * 100)) + '%';
      $('me-next').textContent = `${me.rank.next.at - me.rating} rating to ${me.rank.next.label}`;
    } else { $('me-progress').style.width = '100%'; $('me-next').textContent = 'top of the food chain'; }
  }

  // ── Logbook panels ──
  document.querySelectorAll('[data-panel]').forEach((b) => b.addEventListener('click', () => openPanel(b.dataset.panel)));
  $('modal-close').addEventListener('click', () => $('modal').classList.add('hidden'));
  $('modal').addEventListener('click', (e) => { if (e.target.id === 'modal') $('modal').classList.add('hidden'); });
  async function openPanel(which) {
    const body = $('modal-body');
    $('modal').classList.remove('hidden');
    body.innerHTML = '<div class="empty">loading…</div>';
    if (which === 'leaderboard') {
      const { data } = await api('leaderboard');
      body.innerHTML = `<h3>LEADERBOARD</h3>` + (data.length ? `<table><tr><th>#</th><th>DIVER</th><th>RANK</th><th class="num">RATING</th><th class="num">W/L</th></tr>` +
        data.map((r) => `<tr class="${me && r.name === me.name ? 'me' : ''}"><td>${r.place}</td><td>${esc(r.name)}</td><td><span class="pill" style="color:${r.rank.color}">${esc(r.rank.label.toUpperCase())}</span></td><td class="num">${r.rating}</td><td class="num">${r.wins}/${r.losses}</td></tr>`).join('') + '</table>'
        : `<div class="empty">Nobody has finished placements yet. Be the first!</div>`);
    } else if (which === 'history') {
      const { data } = await api('history');
      body.innerHTML = `<h3>MY DIVES</h3>` + (data.length ? `<table><tr><th>RESULT</th><th>RIVAL</th><th class="num">DEPTH</th><th class="num">RATING</th></tr>` +
        data.map((m) => `<tr><td class="res-${m.result}">${m.result.toUpperCase()}${m.reason === 'forfeit' ? ' (FF)' : ''}</td><td>${esc(m.opp)}${m.ranked ? '' : ' <span class="dim small">practice</span>'}</td><td class="num">${meters(m.myScore)} / ${meters(m.oppScore)}</td><td class="num">${m.ranked ? (m.delta > 0 ? '+' : '') + m.delta : '—'}</td></tr>`).join('') + '</table>'
        : `<div class="empty">No dives yet.</div>`);
    } else if (which === 'ranks') {
      body.innerHTML = `<h3>RANKS</h3>` + [...info.ranks].reverse().map((t) => `<div class="rank-row"><span class="dot" style="background:${t.color}"></span><b style="color:${t.color}">${esc(t.name.toUpperCase())}</b><span class="dim">${t.min > 0 ? t.min + '+ rating' : 'start'}</span></div>`).join('') +
        `<p class="dim small">Every rank except the lowest and highest has divisions III → II → I. Your first ${info.placements} ranked dives are placements.</p>`;
    } else {
      body.innerHTML = `<h3>HOW TO PLAY</h3><div class="how">
        <p><b>Name an answer nobody else would think of.</b> The rarer your answer, the deeper your krill sinks.</p>
        <ul><li><b>${info.promptsPerMatch} prompts</b>, ${info.secondsPerRound} seconds each. Lock in <b>one</b> correct answer per prompt.</li>
        <li>Wrong guesses cost <b>${info.penalty} points</b> each (you float up a little), but you can keep guessing.</li>
        <li>Typos are forgiven: autocorrect figures out what you meant.</li>
        <li>You can see your rival's krill diving next to yours, but not their answers.</li>
        <li>Same answer as your rival? <b>JINX</b>: you split the points.</li>
        <li>Deepest diver wins. Win ranked dives to climb from Plankton to Leviathan.</li></ul>
        <div class="tier-list">${info.answerTiers.map((t) => `<div class="tier-row">${creature(t.name, t.color)}<span class="tier-name" style="color:${t.color}">${esc(t.name.toUpperCase())}</span><span>+${t.points} pts · sink ${t.points * MPP}m</span></div>`).join('')}</div>
        <p class="dim small">Every prompt hides exactly two One in a Krillion answers.</p></div>`;
    }
  }

  // ════════════════════════ SOCKET ════════════════════════
  function connect() {
    if (!token) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => { wsRetry = 0; ws.send(JSON.stringify({ t: 'auth', token })); };
    ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } handle(m); };
    ws.onclose = () => {
      ws = null; if (!token) return;
      if (document.querySelector('#screen-match.active')) banner('connection lost · reconnecting…');
      setTimeout(connect, Math.min(8000, 500 * 2 ** wsRetry++));
    };
  }
  function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); else toast('Not connected yet, try again in a second'); }

  function handle(m) {
    switch (m.t) {
      case 'hello': hideBanner(); break;
      case 'error':
        if (m.code === 'auth') return logout(false);
        if (m.code === 'replaced') { token = null; toast(m.msg, 6000); show('auth'); }
        break;
      case 'queued': startQueue(); break;
      case 'queue_status': $('queue-range').textContent = `looking ±${m.range} rating · ${m.inQueue} diver${m.inQueue === 1 ? '' : 's'} in queue`; break;
      case 'queue_cancelled': enterHome(); break;
      case 'match_start': onMatchStart(m); break;
      case 'round': onRound(m); break;
      case 'guess_result': onGuess(m); break;
      case 'depths': onDepths(m); break;
      case 'jinx': toast(`JINX! ${M.opp.name} said “${m.name}” too. Points split.`); break;
      case 'reveal': onReveal(m); break;
      case 'score': setYou(m.scores.you * MPP); setOpp(m.scores.opp * MPP); updateHud(m.scores.you, m.scores.opp); break;
      case 'match_end': onMatchEnd(m); break;
      case 'opp_disconnected': {
        const tick = () => { const s = Math.max(0, Math.ceil((m.forfeitAt - Date.now()) / 1000)); banner(`${M.opp.name} lost connection · forfeits in ${s}s`); if (s > 0 && banner.on) banner.t = setTimeout(tick, 500); };
        tick(); break;
      }
      case 'opp_reconnected': hideBanner(); toast(`${M.opp.name} reconnected`); break;
      case 'report_ok': $('r-report').textContent = `Thanks! “${m.text}” was sent for review.`; break;
    }
  }

  // ════════════════════════ QUEUE ════════════════════════
  let queueStart = 0;
  $('btn-ranked').addEventListener('click', () => { lastMode = 'ranked'; send({ t: 'queue' }); });
  $('btn-practice').addEventListener('click', () => { lastMode = 'practice'; send({ t: 'practice' }); });
  $('btn-cancel').addEventListener('click', () => send({ t: 'cancel' }));
  function startQueue() {
    queueStart = Date.now(); show('queue'); camAt(0, 0.12);
    const tick = () => {
      if (!document.querySelector('#screen-queue.active')) return;
      const s = Math.floor((Date.now() - queueStart) / 1000);
      $('queue-time').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      setTimeout(tick, 250);
    };
    tick();
  }

  // ════════════════════════ MATCH ════════════════════════
  let timerRAF = null, countdownT = null;
  function updateHud(you, opp) {
    $('h-you-depth').textContent = meters(Math.max(0, you));
    $('h-opp-depth').textContent = meters(Math.max(0, opp));
  }
  function onMatchStart(m) {
    Object.assign(M, { rounds: m.rounds, opp: m.opp, you: m.you, ranked: m.ranked, end: null });
    $('h-you-name').textContent = m.you.name;
    $('h-opp-name').textContent = m.opp.name;
    $('krill-opp-name').textContent = m.opp.name;
    $('rmark-opp').textContent = m.opp.name.slice(0, 10).toUpperCase();
    $('h-mode').textContent = m.ranked ? `RANKED · vs ${m.opp.rank ? m.opp.rank.label.toUpperCase() : ''}` : 'PRACTICE · no rating change';
    $('h-opp-status').textContent = '';
    $('tags').innerHTML = ''; $('guides').innerHTML = '';
    kOpp.classList.remove('hidden'); $('rmark-opp').classList.remove('hidden');
    setYou(0); setOpp(0); updateHud(0, 0);
    ['reveal', 'btn-surface', 'countdown'].forEach((id) => $(id).classList.add('hidden'));
    $('prompt-card').classList.add('fade');
    $('p-text').textContent = '';
    hideBanner(); show('match');
    $('dive-bar').classList.remove('gone');
    followYou();
    setInput(false, 'the boat is lowering you in…');
  }

  function setInput(enabled, placeholder) {
    const i = $('guess-input');
    i.disabled = !enabled; $('dive-btn').disabled = !enabled;
    if (placeholder) i.placeholder = placeholder;
    if (enabled) setTimeout(() => i.focus(), 30);
  }

  function onRound(m) {
    M.n = m.n; M.promptId = m.promptId; M.lastWrong = null; M.lockedThisRound = false;
    $('reveal').classList.add('hidden');
    $('tags').classList.remove('dim');
    $('dive-bar').classList.remove('gone');
    $('h-round').textContent = `PROMPT ${m.n} OF ${m.total}`;
    $('p-num').textContent = `PROMPT ${m.n} OF ${m.total}`;
    $('p-text').textContent = m.text;
    $('prompt-card').classList.remove('fade');
    $('feedback').textContent = ''; $('feedback').className = 'feedback';
    $('h-opp-status').textContent = 'diving…';
    $('guess-input').value = '';
    followYou();
    const offset = Date.now() - m.now;
    const startsAt = m.startsAt + offset, endsAt = m.endsAt + offset;
    // "descending · the clock starts in 3"
    clearTimeout(countdownT);
    const cd = () => {
      const left = Math.ceil((startsAt - Date.now()) / 1000);
      if (left > 0 && !m.resumed) { $('countdown').classList.remove('hidden'); $('countdown-n').textContent = left; setInput(false, 'get ready…'); countdownT = setTimeout(cd, 200); }
      else {
        $('countdown').classList.add('hidden');
        if (m.mine && m.mine.name) { lockUI(m.mine.name); }
        else setInput(true, 'type one answer_');
      }
    };
    cd();
    // timer ring + line
    cancelAnimationFrame(timerRAF);
    const total = endsAt - startsAt, ring = $('t-ring'), fill = $('time-fill');
    const tick = () => {
      const now = Date.now();
      const left = Math.max(0, Math.min(total, endsAt - Math.max(now, startsAt)));
      $('t-num').textContent = Math.ceil(left / 1000);
      ring.style.strokeDashoffset = 163.4 * (1 - left / total);
      ring.classList.toggle('low', left < 6000);
      fill.style.width = (left / total) * 100 + '%';
      fill.style.background = left < 6000 ? 'var(--pink)' : 'var(--cyan)';
      if (left > 0) timerRAF = requestAnimationFrame(tick);
    };
    tick();
  }

  function lockUI(name) {
    M.lockedThisRound = true;
    setInput(false, 'locked in');
    $('guess-input').value = name;
  }

  $('guess-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('guess-input').value.trim();
    if (!v || $('guess-input').disabled) return;
    send({ t: 'guess', text: v });
  });

  function onGuess(m) {
    const fb = $('feedback');
    if (m.ok) {
      const from = youM;
      lockUI(m.name);
      fb.className = 'feedback ok';
      fb.textContent = `✓ ${m.name}${m.fuzzy && m.typed && m.typed.toLowerCase() !== m.name.toLowerCase() ? ` (autocorrected from “${m.typed}”)` : ''}${m.jinx ? ' · JINX! points split' : ''}`;
      showGuides(from);
      sinkTag(m.name, m.tierColor, from, from + m.points * MPP);
      bubbles(14);
      return;
    }
    M.lastWrong = m.text;
    fb.className = 'feedback bad';
    fb.textContent = `“${m.text}”: no echo. try again  −${m.penalty}`;
    const i = $('guess-input');
    i.classList.remove('shake'); void i.offsetWidth; i.classList.add('shake');
    i.select();
    bubbles(4);
  }

  function onDepths(m) {
    const was = oppM;
    setYou(m.you * MPP); setOpp(m.opp * MPP); updateHud(m.you, m.opp);
    $('h-opp-status').textContent = m.oppLocked ? 'locked in ✓' : m.oppWrong ? `missed ×${m.oppWrong}` : 'diving…';
    if (m.opp * MPP > was + 1) bubbles(10, true);
  }

  function onReveal(m) {
    cancelAnimationFrame(timerRAF);
    $('countdown').classList.add('hidden');
    $('prompt-card').classList.add('fade');
    setInput(false, 'surfacing thoughts…');
    const r = m.you;
    const tier = r.answer ? r.tier : null;
    const color = r.answer ? r.tierColor : '#8aa3b5';
    $('r-creature').innerHTML = creature(tier, color);
    $('r-tier').textContent = r.answer ? r.tier.toUpperCase() : 'NO CATCH';
    $('r-tier').style.color = color;
    $('r-answer').textContent = r.answer ? `“${r.answer}”` : '';
    const pen = r.penalty ? `  ·  −${r.penalty} for ${r.wrong} miss${r.wrong === 1 ? '' : 'es'}` : '';
    $('r-pts').innerHTML = r.answer ? `<span style="color:${color}">+${r.points} PTS</span> · sink ${meters(r.points)}${pen}` : (pen ? pen.replace(/^ {2}· /, '') : 'you stayed put');
    $('r-flavor').textContent = r.jinx ? `JINX! You and ${M.opp.name} both said it, so the points are split.` : (r.answer ? FLAVOR[r.tier] || '' : 'No answer this time. You stayed put.');
    $('r-fact').classList.toggle('hidden', !r.fact);
    $('r-fact').textContent = r.fact || '';
    const o = m.opp;
    $('r-opp').innerHTML = o.answered
      ? `${esc(M.opp.name.toUpperCase())} sank ${meters(Math.max(0, o.points))} · <span style="color:${o.tierColor}">${esc(o.tier.toUpperCase())}</span>${o.penalty ? ` · −${o.penalty}` : ''}`
      : `${esc(M.opp.name.toUpperCase())} found nothing${o.penalty ? ` · −${o.penalty}` : ''}`;
    const rep = $('r-report');
    if (M.lastWrong) {
      rep.classList.remove('hidden');
      rep.innerHTML = `Think “${esc(M.lastWrong)}” should count? <button id="r-report-btn">Report it</button>`;
      $('r-report-btn').onclick = () => send({ t: 'report', promptId: m.promptId, text: M.lastWrong });
    } else rep.classList.add('hidden');
    $('reveal').classList.remove('hidden');
    $('tags').classList.add('dim');
    setYou(m.scores.you * MPP); setOpp(m.scores.opp * MPP); updateHud(m.scores.you, m.scores.opp);
    $('h-opp-status').textContent = '';
  }

  $('btn-forfeit').addEventListener('click', () => {
    const b = $('btn-forfeit');
    if (b.dataset.armed) { delete b.dataset.armed; b.textContent = 'forfeit'; send({ t: 'forfeit' }); return; }
    b.dataset.armed = '1'; b.textContent = 'tap again to forfeit';
    setTimeout(() => { delete b.dataset.armed; b.textContent = 'forfeit'; }, 3000);
  });

  // ════════════════════════ END OF MATCH ════════════════════════
  function onMatchEnd(m) {
    M.end = m;
    cancelAnimationFrame(timerRAF); clearTimeout(countdownT); hideBanner();
    $('reveal').classList.add('hidden'); $('prompt-card').classList.add('fade'); $('countdown').classList.add('hidden');
    setInput(false, '');
    if (m.reason === 'forfeit') return surface();
    $('btn-surface').classList.remove('hidden');
    $('dive-bar').classList.add('gone'); $('tags').classList.remove('dim');
    clearTimeout(onMatchEnd.t); onMatchEnd.t = setTimeout(surface, 9000);
  }
  $('btn-surface').addEventListener('click', surface);

  function surface() {
    clearTimeout(onMatchEnd.t);
    const m = M.end; if (!m) return;
    M.end = null;
    $('btn-surface').classList.add('hidden');
    camAt(0, 0.55);              // swim back up to the boat
    setTimeout(() => showResult(m), 1300);
  }

  function showResult(m) {
    const w = $('res-word');
    w.textContent = m.result === 'win' ? 'VICTORY' : m.result === 'loss' ? 'DEFEAT' : 'DRAW';
    w.className = 'result-word ' + m.result;
    $('res-depths').innerHTML = `you dove <b>${meters(Math.max(0, m.scores.you))}</b> · ${esc(M.opp ? M.opp.name : 'rival')} dove <b>${meters(Math.max(0, m.scores.opp))}</b>`;
    $('res-reason').textContent = m.reason === 'forfeit' ? (m.forfeitedBy === 'you' ? 'you forfeited' : 'your rival forfeited') : '';
    $('res-rating-box').classList.toggle('hidden', !m.ranked);
    const promo = $('res-promo'); promo.classList.add('hidden');
    if (m.ranked) {
      badge($('res-badge'), m.rankAfter);
      $('res-rank').textContent = m.rankAfter.label.toUpperCase(); $('res-rank').style.color = m.rankAfter.color;
      const d = $('res-delta'); d.textContent = (m.delta >= 0 ? '+' : '') + m.delta; d.className = m.delta >= 0 ? 'up' : 'down';
      const from = m.ratingBefore, to = m.ratingAfter, t0 = performance.now();
      const step = (t) => { const k = Math.min(1, (t - t0) / 900); $('res-rating').textContent = Math.round(from + (to - from) * k); if (k < 1) requestAnimationFrame(step); };
      requestAnimationFrame(step);
      if (m.rankBefore.label !== m.rankAfter.label) {
        const placed = m.rankBefore.tier === 'Unranked' && m.rankAfter.tier !== 'Unranked';
        const up = m.ratingAfter > m.ratingBefore;
        if (placed) { promo.textContent = `PLACED IN ${m.rankAfter.label.toUpperCase()}!`; promo.className = 'promo'; }
        else if (m.rankAfter.tier !== 'Unranked') { promo.textContent = up ? `PROMOTED TO ${m.rankAfter.label.toUpperCase()}!` : `DROPPED TO ${m.rankAfter.label.toUpperCase()}`; promo.className = 'promo' + (up ? '' : ' down'); }
      }
    }
    renderCatch(m.catch || [], m);
    $('res-again').textContent = m.ranked ? '▼ DIVE AGAIN ▼' : '▼ PRACTICE AGAIN ▼';
    kOpp.classList.add('hidden'); $('rmark-opp').classList.add('hidden'); setYou(0);
    show('result');
    $('screen-result').scrollTop = 0;
  }
  $('res-again').addEventListener('click', () => send({ t: lastMode === 'ranked' ? 'queue' : 'practice' }));
  $('res-home').addEventListener('click', () => enterHome());

  // The Catch: every round, tap it to see every answer (the 2 krillions + facts first)
  function renderCatch(rounds, m) {
    const el = $('res-catch');
    if (!rounds.length) { el.innerHTML = ''; return; }
    const oppName = M.opp ? M.opp.name : 'rival';
    const best = Math.max(...rounds.map((r) => (r.you && r.you.points) || 0));
    el.innerHTML = `<div class="catch-head"><b>THE CATCH</b> · tap a round for every answer</div>` + rounds.map((r, i) => {
      const y = r.you || {}, o = r.opp || {};
      return `<div class="catch-round" data-i="${i}">
        <button class="catch-row">
          <span class="catch-n">${i + 1}</span>
          <span class="catch-ico">${creature(y.answer ? y.tier : null, y.answer ? y.tierColor : '#4f6878')}</span>
          <span class="catch-main">
            <span class="catch-prompt">${esc(r.text)}</span>
            <span class="catch-ans">${y.answer ? esc(y.answer) : '<span class="dim">no answer</span>'}</span>
            <span class="catch-opp">${esc(oppName)}: ${o.answer ? `${esc(o.answer)} (${o.points})` : 'no answer'}</span>
          </span>
          <span class="catch-pts" style="color:${y.answer ? y.tierColor : '#4f6878'}">${y.answer ? y.points : 0}</span>
        </button>
        <div class="catch-list hidden"></div>
      </div>`;
    }).join('') + `<div class="logbook">LOGBOOK · deepest single dive <b>${meters(best)}</b> · total <b>${meters(Math.max(0, m.scores.you))}</b></div>`;
    el.querySelectorAll('.catch-round').forEach((row) => row.querySelector('.catch-row').addEventListener('click', () => {
      const list = row.querySelector('.catch-list');
      const open = list.classList.toggle('hidden') === false;
      if (open && !list.innerHTML) {
        const r = rounds[row.dataset.i];
        const mine = r.you && r.you.answer, theirs = r.opp && r.opp.answer;
        list.innerHTML = r.answers.map((a) => `<div class="ci ${a.krillion ? 'kr' : ''} ${a.name === mine ? 'mine' : ''}">
          <div class="ci-top"><span class="ci-name">${a.krillion ? '★ ' : ''}${esc(a.name)}${a.name === mine ? '<span class="you-tag">YOU</span>' : ''}${a.name === theirs ? '<span class="opp-tag">RIVAL</span>' : ''}</span>
          <span class="ci-pts" style="color:${a.color}">+${a.points}</span></div>
          ${a.fact ? `<div class="ci-fact">${esc(a.fact)}</div>` : ''}</div>`).join('');
      }
    }));
  }

  // refresh "online" count now and then
  setInterval(() => { if (document.querySelector('#screen-home.active') && token) api('info').then(({ data }) => { $('online-count').textContent = `${data.online} online`; }).catch(() => {}); }, 15000);

  // ════════════════════════ START ════════════════════════
  (async () => {
    if (!token) return show('auth');
    try { await enterHome(); connect(); } catch { show('auth'); }
  })();
})();
