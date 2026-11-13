'use strict';
/* Undercover — realtime game server (Node + ws). Rooms live in memory; no database. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const PAIRS = require('./words');

const PORT = Number(process.env.PORT) || 3000;
// Gully Football physics (kept inside this file so only server.js needs uploading)
const FB = (() => {
// Gully Football physics. The server decides each turn, but phones run this SAME code on the same numbers,
// so only the aims travel over the network (tiny messages, no download wait). Keep it deterministic:
// only + - * / and Math.sqrt inside simulate (no sin / cos / pow), a fixed time step, and rounded inputs.
const DR = 20, BR = 11, POST = 5; // disc radius, ball radius, goal post radius
const NET = 26;                   // depth of the net behind each goal line
const MAXV = 840;                 // flick speed at full power (units / second)
const DT = 1 / 60;
const FR_DISC = 0.978, FR_BALL = 0.986, REST_WALL = 0.82, REST_HIT = 0.92;
const M_DISC = 1, M_BALL = 0.45;
const MAX_STEPS = 60 * 7;
const rd3 = (v) => Math.round(v * 1000) / 1000;

// Pitch grows with the number of players. gw = goal mouth, gws = wider goal for sudden death.
function size(n) {
  const [W, H] = n <= 4 ? [300, 480] : n <= 8 ? [340, 560] : [380, 640];
  return { W, H, gw: Math.round(100 * W / 300), gws: Math.round(170 * W / 300) };
}

// Kick-off layout. Team 0 defends the bottom goal and attacks the top one; team 1 is the mirror image.
function layout(ids, team, W, H) {
  const pos = {};
  for (const t of [0, 1]) {
    const mine = ids.filter((id) => team[id] === t);
    const rows = mine.length > 3 ? [mine.slice(0, 3), mine.slice(3)] : [mine];
    rows.forEach((row, r) => {
      row.forEach((id, k) => {
        const x = W * (k + 1) / (row.length + 1);
        const dy = r === 0 ? 0.30 : 0.18; // distance from own goal line, as a share of the pitch
        pos[id] = t === 0 ? [rd3(x), rd3(H * (1 - dy))] : [rd3(W - x), rd3(H * dy)];
      });
    });
  }
  return pos;
}

// Turns an aim {dx,dy,pw} into a rounded velocity [vx,vy] (done once, on the server).
function aimVel(a) {
  const len = Math.hypot(a.dx, a.dy) || 1;
  const pw = Math.max(0, Math.min(1, a.pw));
  return [rd3(a.dx / len * pw * MAXV), rd3(a.dy / len * pw * MAXV)];
}

// Plays one turn. fb = { ids, pos:{id:[x,y]}, ball:[x,y], sudden, W, H, gw, gws }, vel = { id: [vx,vy] }.
// Returns { frames, goal: 0|1|null (team that scored), by: id|null, pos, ball } (final positions, rounded). Does not change fb.
function simulate(fb, vel) {
  const W = fb.W, H = fb.H, g = fb.sudden ? fb.gws : fb.gw;
  const gx0 = (W - g) / 2, gx1 = (W + g) / 2;
  const ids = fb.ids;
  const B = ids.map((id) => ({ id, r: DR, m: M_DISC, x: fb.pos[id][0], y: fb.pos[id][1], vx: 0, vy: 0, disc: true }));
  const ball = { id: null, r: BR, m: M_BALL, x: fb.ball[0], y: fb.ball[1], vx: 0, vy: 0, disc: false };
  const all = [ball].concat(B);
  for (const b of B) { const v = vel[b.id]; if (v) { b.vx = v[0]; b.vy = v[1]; } }
  const posts = [[gx0, 0], [gx1, 0], [gx0, H], [gx1, H]];
  const r1 = (v) => Math.round(v * 10) / 10;
  const snap = () => { const f = [r1(ball.x), r1(ball.y)]; for (const b of B) f.push(r1(b.x), r1(b.y)); return f; };
  const frames = [snap()];
  let touch = null, goal = null, by = null, calm = 0, extra = 0;

  const hit = (a, b) => { // circle vs circle, elastic with a little loss
    const dx = b.x - a.x, dy = b.y - a.y; const d2 = dx * dx + dy * dy, rr = a.r + b.r;
    if (d2 >= rr * rr || d2 === 0) return false;
    const d = Math.sqrt(d2), nx = dx / d, ny = dy / d;
    const im1 = a.fixed ? 0 : 1 / a.m, im2 = b.fixed ? 0 : 1 / b.m;
    const push = (rr - d) / (im1 + im2);
    a.x -= nx * push * im1; a.y -= ny * push * im1; b.x += nx * push * im2; b.y += ny * push * im2;
    const rv = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
    if (rv < 0) {
      const j = -(1 + REST_HIT) * rv / (im1 + im2);
      a.vx -= j * im1 * nx; a.vy -= j * im1 * ny; b.vx += j * im2 * nx; b.vy += j * im2 * ny;
    }
    return true;
  };

  for (let step = 1; step <= MAX_STEPS; step++) {
    if (goal === null) {
      for (const b of all) {
        b.x += b.vx * DT; b.y += b.vy * DT;
        const fr = b.disc ? FR_DISC : FR_BALL; b.vx *= fr; b.vy *= fr;
        if (b.vx * b.vx + b.vy * b.vy < 36) { b.vx = 0; b.vy = 0; }
      }
      // walls (discs can never enter a goal; the ball can, through the mouth)
      for (const b of all) {
        if (b.x < b.r) { b.x = b.r; b.vx = Math.abs(b.vx) * REST_WALL; }
        if (b.x > W - b.r) { b.x = W - b.r; b.vx = -Math.abs(b.vx) * REST_WALL; }
        const inMouth = !b.disc && b.x > gx0 && b.x < gx1;
        if (!inMouth) {
          if (b.y < b.r) { b.y = b.r; b.vy = Math.abs(b.vy) * REST_WALL; }
          if (b.y > H - b.r) { b.y = H - b.r; b.vy = -Math.abs(b.vy) * REST_WALL; }
        }
      }
      for (const b of B) { // discs stay out of the goals completely
        if (b.y < b.r) { b.y = b.r; b.vy = Math.abs(b.vy) * REST_WALL; }
        if (b.y > H - b.r) { b.y = H - b.r; b.vy = -Math.abs(b.vy) * REST_WALL; }
      }
      for (const p of posts) { // posts are tiny fixed circles
        const post = { x: p[0], y: p[1], vx: 0, vy: 0, r: POST, m: 1, fixed: true };
        for (const b of all) hit(b, post);
      }
      for (let i = 0; i < all.length; i++) for (let k = i + 1; k < all.length; k++) {
        if (hit(all[i], all[k]) && (all[i] === ball || all[k] === ball)) touch = (all[i] === ball ? all[k] : all[i]).id;
      }
      // goal?
      if (ball.x > gx0 && ball.x < gx1) {
        if (ball.y < 0) { goal = 0; by = touch; }       // top goal: team 0 scores
        else if (ball.y > H) { goal = 1; by = touch; }  // bottom goal: team 1 scores
      }
      if (goal !== null) { for (const b of B) { b.vx = 0; b.vy = 0; } }
    } else {
      // the ball runs into the net and settles
      ball.x += ball.vx * DT; ball.y += ball.vy * DT; ball.vx *= 0.82; ball.vy *= 0.82;
      const top = goal === 0;
      if (top && ball.y < -NET + BR) { ball.y = -NET + BR; ball.vy = 0; }
      if (!top && ball.y > H + NET - BR) { ball.y = H + NET - BR; ball.vy = 0; }
      ball.x = Math.max(gx0 + BR, Math.min(gx1 - BR, ball.x));
      extra++;
    }
    if (step % 2 === 0) frames.push(snap());
    if (goal !== null) { if (extra >= 16) break; continue; }
    let moving = false; for (const b of all) if (b.vx || b.vy) { moving = true; break; }
    calm = moving ? 0 : calm + 1;
    if (calm > 6) break;
  }
  frames.push(snap());
  const pos = {}; B.forEach((b) => { pos[b.id] = [rd3(b.x), rd3(b.y)]; });
  return { frames, goal, by, pos, ball: [rd3(ball.x), rd3(ball.y)] };
}

return { DR, BR, NET, MAXV, size, layout, aimVel, simulate, rd3 };
})();
const MAX_PLAYERS = 20;
const MIN_PLAYERS = 3;
const GUESS_SECS = 30;
let webpush = null; // optional: phone notifications while the app is in the background
try {
  webpush = require('web-push');
  const keys = process.env.VAPID_PUBLIC && process.env.VAPID_PRIVATE ? { publicKey: process.env.VAPID_PUBLIC, privateKey: process.env.VAPID_PRIVATE } : webpush.generateVAPIDKeys();
  webpush.setVapidDetails('mailto:undercover@example.com', keys.publicKey, keys.privateKey);
  webpush.pub = keys.publicKey;
} catch (e) { webpush = null; }
const UC_BONUS = 3; // Undercover guesses the civilian word after being voted out
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I, L, O, 0, 1

// ---------------------------------------------------------------- static page
const htmlPath = [path.join(__dirname, 'public', 'index.html'), path.join(__dirname, 'index.html')].find((f) => fs.existsSync(f));
// One-phone mode runs fully in the browser, so the page gets the same word pairs as the server (from words.js).
const htmlRaw = Buffer.from(fs.readFileSync(htmlPath, 'utf8').replace('/*__WORDS__*/[]', () => JSON.stringify(PAIRS)).replace('/*__MODES__*/[]', () => JSON.stringify(PAIRS.MODES)));
const htmlGz = zlib.gzipSync(htmlRaw, { level: 9 });
const etag = '"' + crypto.createHash('sha1').update(htmlRaw).digest('hex').slice(0, 16) + '"';

// Service worker: keeps a copy of the page on the phone so it opens instantly (even while the free
// server is still waking up) and one-phone mode works offline. New versions download in the background.
const SW_JS = `const C = 'uc-page';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('push', (e) => {
  let d = {}; try { d = e.data.json(); } catch (er) { d = { title: 'Undercover', body: e.data && e.data.text() }; }
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cl) => {
    if (cl.some((c) => c.visibilityState === 'visible')) return; // app is open on screen: no popup needed
    return self.registration.showNotification(d.title || 'Undercover', { body: d.body || '', tag: d.tag || 'uc', renotify: true, vibrate: d.vib || [200, 100, 200], icon: '/icon-192.png', badge: '/icon-192.png', data: { url: d.url || '/' } });
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cl) => {
    const c = cl[0]; if (c) return c.focus();
    return self.clients.openWindow((e.notification.data && e.notification.data.url) || '/');
  }));
});
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (u.hostname === 'fonts.googleapis.com' || u.hostname === 'fonts.gstatic.com') { // keep fonts for offline play
    e.respondWith(caches.open('uc-fonts').then(async (c) => (await c.match(e.request)) || fetch(e.request).then((r) => { c.put(e.request, r.clone()); return r; })));
    return;
  }
  if (u.origin !== location.origin || u.pathname !== '/') return;
  e.respondWith(caches.open(C).then(async (c) => {
    const cached = await c.match('/');
    const net = fetch('/', { cache: 'no-cache' }).then(async (r) => {
      if (r.ok) {
        const before = cached && cached.headers.get('ETag');
        await c.put('/', r.clone());
        if (cached && before !== r.headers.get('ETag')) (await self.clients.matchAll()).forEach((cl) => cl.postMessage({ t: 'updated' }));
      }
      return r;
    });
    if (cached) { e.waitUntil(net.catch(() => {})); return cached; }
    return net;
  }));
});
`;

// Install as an app ("Add to Home screen"): manifest + icons (icons are embedded so there are no extra files to upload)
const MANIFEST = JSON.stringify({
  name: 'Undercover', short_name: 'Undercover', description: 'Undercover / Mr. White word game for your group',
  start_url: '/', scope: '/', display: 'standalone', orientation: 'portrait', background_color: '#FFF8E7', theme_color: '#FFF8E7',
  icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png' }],
});
const ICONS = {
  '/icon-192.png': Buffer.from('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', 'base64'),
  '/icon-512.png': Buffer.from('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', 'base64'),
  '/apple-touch-icon.png': Buffer.from('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', 'base64'),
};

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/' || url === '/index.html') {
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag }); return res.end(); }
    const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ETag: etag, Vary: 'Accept-Encoding' };
    if (gz) headers['Content-Encoding'] = 'gzip';
    res.writeHead(200, headers);
    return res.end(gz ? htmlGz : htmlRaw);
  }
  if (url === '/manifest.webmanifest') {
    res.writeHead(200, { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-cache' });
    return res.end(MANIFEST);
  }
  if (ICONS[url]) {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=604800' });
    return res.end(ICONS[url]);
  }
  if (url === '/sw.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
    return res.end(SW_JS);
  }
  if (url === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if (url === '/favicon.ico') { res.writeHead(204); return res.end(); }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

// ---------------------------------------------------------------- helpers
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.floor(Number(v)) || lo));
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
const norm = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentions = (text, word) => { const w = norm(word); return !!w && new RegExp('(^| )' + reEsc(w) + '( |$)').test(norm(text)); };
const rid = () => crypto.randomBytes(6).toString('hex');
function shuffle(a) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function send(ws, obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
const errTo = (ws, msg) => send(ws, { t: 'err', msg });
// Phone notification (with vibration) for a player whose app is in the background or closed.
function notify(room, p, title, body, vib) {
  if (!webpush || !p || !p.push || p.left || (p.connected && !p.hidden)) return;
  webpush.sendNotification(p.push, JSON.stringify({ title, body, tag: 'uc-' + room.code, vib: vib || [200, 100, 200], url: '/?c=' + room.code }), { TTL: 90, urgency: 'high' })
    .catch((e) => { if (e && (e.statusCode === 404 || e.statusCode === 410)) p.push = null; });
}

// ---------------------------------------------------------------- rooms
const rooms = new Map();

function newCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += ALPHABET[crypto.randomInt(ALPHABET.length)];
    if (!rooms.has(c)) return c;
  }
}
// Word picking
// - About half the rounds use a pair tagged 'meme' (memes + Hindi slang); the rest use everyday words.
// - A pair is NOT used again until every pair in its group has been played; then that group starts over.
// - On top of that, a word just played stays out for the next COOLDOWN pairs (words shared between pairs).
// - Phones keep the "already played" list (as short hashes, so it can't leak words) and hand it to the
//   server when they create a lobby, so a sleeping server or a new lobby doesn't reset it.
const COOLDOWN = 30;
const MEME_SHARE = 0.5;
function pairKey(a, b) {
  const t = [norm(a), norm(b)].sort().join('|');
  let h = 0x811c9dc5;
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}
const KEYS = PAIRS.map((p) => pairKey(p[0], p[1]));
const KEYSET = new Set(KEYS);
const MODE_IDS = PAIRS.MODES.map((m) => m.id);
function cleanModes(list) {
  const m = Array.isArray(list) ? [...new Set(list.filter((x) => MODE_IDS.includes(x) && x !== 'mix'))] : [];
  return m.length ? m : ['mix'];
}
// state = { used: Set<key>, recent: [normalised words] }; modes = chosen word modes (['mix'] = everything)
function pickPair(state, rand, modes) {
  modes = cleanModes(modes);
  const mix = modes[0] === 'mix';
  const all = PAIRS.map((_, i) => i).filter((i) => mix || PAIRS[i][4].split(' ').some((x) => modes.includes(x)));
  // groups: in Mix, memes and everyday words alternate about half/half; in chosen modes it's one group
  const groupOf = (i) => (mix ? (PAIRS[i][2] === 'meme' ? 'm' : 'n') : 'g');
  for (const g of new Set(all.map(groupOf))) { // a whole group used up -> that group starts over
    const grp = all.filter((i) => groupOf(i) === g);
    if (grp.every((i) => state.used.has(KEYS[i]))) grp.forEach((i) => state.used.delete(KEYS[i]));
  }
  const block = new Set(state.recent);
  const fresh = all.filter((i) => !state.used.has(KEYS[i]));
  const ok = fresh.filter((i) => !block.has(norm(PAIRS[i][0])) && !block.has(norm(PAIRS[i][1])));
  const want = !mix ? 'g' : rand(1000) < MEME_SHARE * 1000 ? 'm' : 'n';
  let pool = ok.filter((i) => groupOf(i) === want);
  if (!pool.length) pool = ok.length ? ok : fresh.filter((i) => groupOf(i) === want);
  if (!pool.length) pool = fresh.length ? fresh : all;
  const i = pool[rand(pool.length)];
  state.used.add(KEYS[i]);
  state.recent.push(norm(PAIRS[i][0]), norm(PAIRS[i][1]));
  while (state.recent.length > COOLDOWN * 2) state.recent.shift();
  return PAIRS[i];
}
function drawPair(room) {
  const [a, b, , cat] = pickPair(room.words, (n) => crypto.randomInt(n), room.settings.modes);
  return Math.random() < 0.5 ? { civilian: a, undercover: b, cat } : { civilian: b, undercover: a, cat };
}
function loadWords(m) { // memory handed over by the phone that creates the lobby
  const used = new Set(Array.isArray(m && m.used) ? m.used.filter((k) => typeof k === 'string' && KEYSET.has(k)).slice(0, 2000) : []);
  const recent = Array.isArray(m && m.recent) ? m.recent.filter((w) => typeof w === 'string' && w.length < 40).slice(-COOLDOWN * 2).map(norm) : [];
  return { used, recent };
}
function shareWords(room) { // phones save the updated memory
  const msg = { t: 'words', used: [...room.words.used], recent: room.words.recent };
  for (const p of room.players.values()) if (p.ws && p.connected) send(p.ws, msg);
}
function makeRoom(words) {
  const room = {
    code: newCode(), hostId: null, supervisorId: null, players: new Map(),
    game: 'undercover', unSet: { secs: 20 }, un: null, fbSet: { goals: 3, secs: 8, mode: 'match', tie: 'pens' }, fb: null, rc: null,
    phase: 'lobby', round: 0, seq: 0, timer: null, endsAt: 0,
    settings: { describeSecs: 30, autoRoles: true, undercover: 1, white: 1, whiteGuess: true, hint: false, board: true, reacts: true, modes: ['mix'], joker: false, chat: true, chatSlow: 5, reactCd: 3, ucGuess: true, whiteTries: 2, sheriff: true },
    words: words || { used: new Set(), recent: [] }, pair: null, nextPair: null, customPair: null, supReq: null,
    typingId: null, typingUntil: 0, typingTimer: null, undo: null, stats: {},
    descs: {}, order: [], turn: 0, history: [], votes: {}, tie: false,
    lastElim: null, guess: null, whiteId: null, ownerId: null, winner: null, touched: Date.now(),
  };
  room.nextPair = drawPair(room);
  rooms.set(room.code, room);
  return room;
}
function addPlayer(room, name) {
  const p = {
    id: rid(), token: crypto.randomBytes(16).toString('hex'), name, ws: null, connected: false, discAt: 0,
    alive: true, role: null, word: '', revealed: false, left: false,
  };
  room.players.set(p.id, p);
  return p;
}

const parts = (room) => [...room.players.values()].filter((p) => p.id !== room.supervisorId && !p.left);
const alivePlayers = (room) => parts(room).filter((p) => p.alive && p.role);

function autoCounts(n) {
  return { u: Math.max(1, Math.floor((n - 1) / 4)), w: n >= 6 ? (n >= 12 ? 2 : 1) : 0 };
}
const isImp = (p) => p.role === 'undercover' || p.role === 'white'; // the Joker is on nobody's team
function plan(room) {
  const n = parts(room).length;
  const { u, w } = room.settings.autoRoles ? autoCounts(n) : { u: room.settings.undercover, w: room.settings.white };
  const j = room.settings.joker && n >= 6 ? 1 : 0; // Joker only with 6+ players
  return { n, u, w, j, c: n - u - w - j };
}
function checkStart(room) {
  const pl = plan(room);
  if (pl.n < MIN_PLAYERS) return `Need at least ${MIN_PLAYERS} players (${pl.n} now)`;
  if (pl.u + pl.w < 1) return 'Add at least one Undercover or Mr. White';
  if (pl.c < 2 || pl.c <= pl.u + pl.w) return 'Too many impostors: civilians must outnumber Undercover + Mr. White';
  return null;
}

function setPhase(room, phase) {
  room.phase = phase;
  room.seq++;
  clearTimeout(room.timer);
  room.endsAt = 0;
}
function schedule(room, ms, fn) {
  const seq = room.seq;
  room.endsAt = Date.now() + ms;
  room.timer = setTimeout(() => { if (room.seq === seq) fn(); }, ms);
}

function breakdown(room, votes) {
  const out = {};
  for (const [voter, target] of Object.entries(votes || {})) (out[target] = out[target] || []).push(voter);
  return out;
}

// ---------------------------------------------------------------- personalised view
function view(room, p) {
  const over = room.phase === 'over';
  const inGame = ['describe', 'vote', 'whiteguess', 'elim', 'over'].includes(room.phase);
  const watching = !!p.watch && inGame && !p.role; // joined mid-game: waits and watches with every word visible
  const sup = room.supervisorId === p.id;
  const players = [...room.players.values()].map((q) => {
    const o = {
      id: q.id, name: q.name, connected: q.connected, host: q.id === room.hostId,
      sup: q.id === room.supervisorId, alive: q.alive, left: q.left,
    };
    if (inGame && q.role) {
      o.in = true; // takes part in this game (role itself stays private)
      if (room.phase === 'describe') o.submitted = !!room.descs[q.id];
      if (room.phase === 'vote') o.voted = !!room.votes[q.id];
      if (sup || over || watching) { o.role = q.role; o.word = q.word; if (q.sheriff) o.sheriff = true; }
      else if (q.revealed) o.role = q.role; // eliminated: role only, never the word
    }
    return o;
  });
  const v = {
    t: 'state', game: room.game, now: Date.now(), code: room.code, phase: room.phase, round: room.round,
    settings: room.settings, endsAt: room.endsAt, plan: plan(room), players,
    history: room.history, tie: room.tie, lastElim: room.lastElim, guess: room.guess, whiteId: room.whiteId,
    winner: over ? room.winner : null, pair: over ? room.pair : null,
    me: { id: p.id, name: p.name, host: p.id === room.hostId, sup, watch: watching, alive: p.alive && !p.left && !watching },
  };
  if (inGame && p.role) {
    v.me.white = p.role === 'white'; v.me.joker = p.role === 'joker'; v.me.word = p.word;
    if (p.role === 'white') v.me.wLeft = Math.max(0, (room.settings.whiteTries || 0) - (p.wTried || 0));
    if (p.role === 'white' && room.settings.hint && room.pair) v.me.hint = room.pair.cat || 'Custom words';
    if (p.sheriff) { v.me.sheriff = true; v.me.shot = p.sheriffAt === room.round; }
  }
  // private: only the voted-out Undercover sees this. One try, no timer: open until the game ends.
  if (p.ucOpen && ['describe', 'vote', 'whiteguess', 'elim'].includes(room.phase)) v.ucAsk = true;
  if (p.ucRes && inGame) v.ucResult = p.ucRes;
  if (room.game === 'football') {
    v.fbSet = room.fbSet;
    if (room.fb) {
      const f = room.fb;
      v.fb = { ids: f.ids, team: f.team, pos: f.pos, ball: f.ball, score: f.score, turn: f.turn, sudden: f.sudden, W: f.W, H: f.H, gw: f.sudden ? f.gws : f.gw,
        goals: f.goals, aimed: Object.keys(f.aims), winner: f.winner, last: f.last, lastTurn: f.lastTurn };
      if (f.pk) { // penalties: never include anybody's secret pick, only whether they have picked
        const k = f.pk, pk = room.pkPick || {};
        v.fb.pk = { why: k.why, score: k.score, hist: k.hist, cur: k.cur, sd: k.sd, kdone: !!pk.k, sdone: !!pk.s, res: k.res, n: k.n };
      }
    }
  }
  if (room.game === 'uno') {
    v.unSet = room.unSet;
    if (room.un) {
      const u = room.un, id = p.id, curId = u.ids[u.cur];
      const counts = {}; for (const q of u.ids) counts[q] = u.hands[q].length;
      // never include other hands, the UNO timers or who can be caught: nothing hints at the buttons
      v.un = { gid: u.gid, ids: u.ids, counts, hand: u.hands[id] || [], top: u.top, color: u.color, dir: u.dir, cur: curId, pend: u.pend, fin: u.fin, paused: u.paused ? u.paused.left || 1 : 0,
        drew: curId === id ? u.drew : null, pile: u.draw.length, disc: u.disc.length, ev: u.ev, last: u.last, log: u.log || [], winner: u.winner, ranks: u.ranks, resh: u.resh || 0 };
    }
  }
  if (room.game === 'race' && room.rc) {
    const r = room.rc;
    v.rc = { ids: r.ids, startAt: r.startAt, laps: RACE_LAPS, fin: r.fin, results: r.results, rank: raceRank(room) };
  }
  if (room.typingId && Date.now() < room.typingUntil) v.typing = room.typingId;
  if (p.id === room.hostId && room.supReq && room.players.get(room.supReq)) v.supReq = { id: room.supReq, name: room.players.get(room.supReq).name };
  if (room.supReq === p.id) v.mySupReq = true;
  if (p.muteUntil && p.muteUntil > Date.now()) v.me.muteUntil = p.muteUntil;
  if (sup && room.phase === 'lobby') v.customPair = room.customPair;
  if (p.id === room.hostId) v.canUndo = !!room.undo && ['elim', 'whiteguess', 'over'].includes(room.phase);
  if (room.settings.board && (room.phase === 'lobby' || room.phase === 'over')) {
    v.board = Object.values(room.stats).sort((x, y) => y.pts - x.pts || y.wins - x.wins).slice(0, 20);
  }
  if (p.id === room.hostId) v.startErr = room.phase === 'lobby' ? checkStart(room) : null;
  if (sup && room.phase === 'lobby') v.nextPair = room.nextPair;
  if (room.phase === 'describe') { v.order = room.order; v.turnId = room.order[room.turn]; v.clues = room.descs; }
  if (room.phase === 'vote') {
    v.myVote = room.votes[p.id] || null;
    if (sup) v.breakdown = breakdown(room, room.votes);
    if (room.tie) { v.tieTally = room.tieTally; v.tieTop = room.tieTop; }
  }
  return v;
}
function f2(pos) { const o = {}; for (const k of Object.keys(pos)) o[k] = [Math.round(pos[k][0] * 10) / 10, Math.round(pos[k][1] * 10) / 10]; return o; }
function broadcast(room) {
  room.touched = Date.now();
  for (const p of room.players.values()) if (p.ws && p.connected) send(p.ws, view(room, p));
}

// ---------------------------------------------------------------- game flow
function startGame(room, custom) {
  const err = checkStart(room);
  if (err) return err;
  let pair = room.nextPair || drawPair(room);
  if (room.customPair && room.supervisorId) pair = room.customPair;
  if (custom && room.supervisorId === room.hostId) {
    const a = clean(custom.civilian, 24), b = clean(custom.undercover, 24);
    if (a || b) {
      if (!a || !b) return 'Enter both custom words (or leave both empty for a random pair)';
      if (norm(a) === norm(b)) return 'The two words must be different';
      pair = { civilian: a, undercover: b };
    }
  }
  const all = parts(room);
  const { u, w } = plan(room);
  const imps = pickImpostors(all, u + w, room.prevImp || new Set());
  const impRoles = shuffle(Array.from({ length: u + w }, (_, i) => (i < u ? 'undercover' : 'white')));
  room.prevImp = new Set(imps.map((p) => p.id));
  const { j } = plan(room);
  const rest = shuffle(all.filter((p) => !imps.includes(p)));
  const joker = j ? rest[0] : null;
  all.forEach((p) => {
    const k = imps.indexOf(p);
    p.role = k >= 0 ? impRoles[k] : p === joker ? 'joker' : 'civilian';
    p.word = p.role === 'civilian' || p.role === 'joker' ? pair.civilian : p.role === 'undercover' ? pair.undercover : '';
    p.alive = true; p.revealed = false; p.watch = false; p.wTried = 0;
    p.ucOpen = false; p.ucRes = null; p.sheriff = false; p.sheriffAt = -1;
  });
  // Sheriff: one civilian gets one bullet that can take out an impostor (Undercover or Mr. White) during voting
  if (room.settings.sheriff && u + w > 0) { const civs = all.filter((p) => p.role === 'civilian'); if (civs.length) civs[Math.floor(Math.random() * civs.length)].sheriff = true; }
  room.pair = pair; room.nextPair = null; room.customPair = null; room.undo = null; room.scoredFor = null;
  shareWords(room);
  room.history = []; room.lastElim = null; room.guess = null; room.winner = null; room.whiteId = null;
  room.round = 1;
  startDescribe(room);
  for (const q of all) notify(room, q, '🎮 New game started', 'Open Undercover to see your word', [100, 60, 100]);
  return null;
}

// Pick impostors at random, but people who were impostors last game get a much smaller chance,
// so the same friends don't keep getting the role.
function pickImpostors(players, k, prev) {
  const pool = players.map((p) => ({ p, w: prev.has(p.id) ? 0.2 : 1 }));
  const out = [];
  while (out.length < k && pool.length) {
    let r = Math.random() * pool.reduce((t, x) => t + x.w, 0), i = 0;
    while (i < pool.length - 1 && (r -= pool[i].w) > 0) i++;
    out.push(pool.splice(i, 1)[0].p);
  }
  return out;
}
// Random speaking order, re-shuffled until no two impostors speak back to back (when that's possible).
function spreadOrder(list) {
  const imp = isImp;
  const k = list.filter(imp).length;
  let best = shuffle(list), bestBad = Infinity;
  if (k * 2 > list.length) return best;
  for (let t = 0; t < 200; t++) {
    const o = t ? shuffle(list) : best;
    let bad = 0;
    for (let i = 0; i + 1 < o.length; i++) if (imp(o[i]) && imp(o[i + 1])) bad++;
    if (bad < bestBad) { best = o; bestBad = bad; }
    if (!bad) break;
  }
  return best;
}

const isActive = (room, id) => { const q = room.players.get(id); return !!q && !q.left && q.alive; };
function startDescribe(room) {
  setPhase(room, 'describe');
  room.descs = {}; room.votes = {}; room.tie = false; room.guess = null; room.whiteId = null;
  room.order = spreadOrder(alivePlayers(room)).map((p) => p.id); // fresh random speaking order every round
  room.turn = 0;
  startTurn(room);
}
function startTurn(room) {
  room.seq++; clearTimeout(room.timer);
  schedule(room, room.settings.describeSecs * 1000, () => advanceTurn(room)); // out of time = skipped
  broadcast(room);
  if (room.turn > 0 || room.round > 1) notify(room, room.players.get(room.order[room.turn]), '🎤 Your turn!', 'Give your clue now (' + room.settings.describeSecs + 's)', [400, 100, 400]);
}
function advanceTurn(room) {
  if (room.phase !== 'describe') return;
  do { room.turn++; } while (room.turn < room.order.length && !isActive(room, room.order[room.turn]));
  if (room.turn >= room.order.length) return endDescribe(room); // everyone has spoken -> straight to discussion + voting
  startTurn(room);
}
function endDescribe(room) {
  if (room.phase !== 'describe') return;
  room.history.push({ round: room.round, items: room.order.filter((id) => { const q = room.players.get(id); return q && !q.left; }).map((id) => [id, room.descs[id] || '']) });
  setPhase(room, 'vote');
  room.votes = {}; room.tie = false;
  broadcast(room);
  for (const q of alivePlayers(room)) notify(room, q, '🗳️ Voting started', 'Who is the impostor? Cast your vote', [90, 70, 90]);
}

function tryResolve(room, force) {
  if (room.phase !== 'vote') return;
  const alive = alivePlayers(room);
  const voters = alive.filter((p) => room.votes[p.id]);
  if (!force && voters.length < alive.length) return broadcast(room);
  const counts = {};
  for (const p of voters) counts[room.votes[p.id]] = (counts[room.votes[p.id]] || 0) + 1;
  const max = Math.max(0, ...Object.values(counts));
  const top = Object.keys(counts).filter((id) => counts[id] === max);
  if (max > 0 && top.length === 1) return eliminate(room, top[0]);
  // No majority: show who tied, wipe the votes and let everyone vote again from scratch.
  room.tieTally = breakdown(room, room.votes);
  room.tieTop = top.map((id) => (room.players.get(id) || {}).name).filter(Boolean);
  room.votes = {};
  room.tie = true;
  broadcast(room);
}

function eliminate(room, id, shot) {
  const p = room.players.get(id);
  room.undo = { id: p.id, votes: { ...room.votes } };
  p.alive = false; p.revealed = true;
  room.lastElim = { id: p.id, name: p.name, role: p.role, breakdown: shot ? {} : breakdown(room, room.votes) };
  if (shot) { room.lastElim.sheriff = shot; room.undo.sheriff = shot.byId; }
  room.tie = false;
  if (p.role === 'joker') return endGame(room, 'joker');
  notify(room, p, '😵 You were voted out', 'Open Undercover to see what happens', [400]);
  p.ucOpen = p.role === 'undercover' && !!room.settings.ucGuess && !!room.pair && !p.ucRes;
  if (p.ucOpen) notify(room, p, '🕵️ Secret chance!', 'Guess the civilians\' word for +3', [300, 80, 300]);
  if (p.role === 'white' && room.settings.whiteGuess && !shot) { // a Sheriff's bullet gives no last guess
    setPhase(room, 'whiteguess');
    room.whiteId = p.id;
    schedule(room, GUESS_SECS * 1000, () => finishGuess(room, ''));
    return broadcast(room);
  }
  afterElim(room);
}
function finishGuess(room, text) {
  if (room.phase !== 'whiteguess') return;
  const ok = !!text && norm(text) === norm(room.pair.civilian);
  room.guess = { by: room.whiteId, text, ok };
  if (ok) return endGame(room, 'white');
  afterElim(room);
}
function checkWin(room) {
  const alive = alivePlayers(room);
  const imp = alive.filter(isImp).length;
  const civ = alive.filter((p) => p.role === 'civilian').length;
  if (imp === 0) return 'civilians';
  if (imp >= civ) return 'impostors';
  return null;
}
function afterElim(room) {
  const win = checkWin(room);
  if (win) return endGame(room, win);
  setPhase(room, 'elim');
  broadcast(room);
}
function endGame(room, winner) {
  setPhase(room, 'over');
  for (const q of room.players.values()) q.ucOpen = false;
  for (const q of room.players.values()) if (q.role) notify(room, q, '🏁 Game over', 'See who won and both words', [70, 50, 70, 50, 70]);
  room.winner = winner;
  const delta = {};
  for (const p of room.players.values()) {
    if (!p.role) continue;
    const won = winner === 'civilians' ? p.role === 'civilian' : winner === 'impostors' ? isImp(p) : winner === 'joker' ? p.role === 'joker' : p.id === (room.guess && room.guess.by);
    const pts = !won ? 0 : winner === 'civilians' ? 2 : winner === 'impostors' ? 4 : 6;
    const k = norm(p.name);
    const st = room.stats[k] || (room.stats[k] = { name: p.name, pts: 0, games: 0, wins: 0, imp: 0 });
    st.name = p.name; st.pts += pts; st.games += 1; st.wins += won ? 1 : 0; st.imp += isImp(p) ? 1 : 0;
    delta[k] = { pts, won: won ? 1 : 0, imp: isImp(p) ? 1 : 0 };
  }
  room.lastDelta = delta;
  broadcast(room);
}
function undoKick(room) { // host: put the last voted-out player back and vote again
  const u = room.undo; if (!u) return;
  const p = room.players.get(u.id);
  if (room.phase === 'over' && room.lastDelta) {
    for (const [k, d] of Object.entries(room.lastDelta)) { const st = room.stats[k]; if (st) { st.pts -= d.pts; st.games -= 1; st.wins -= d.won; st.imp -= d.imp; if (st.games <= 0) delete room.stats[k]; } }
    room.lastDelta = null;
  }
  if (u.bonus && room.stats[u.bonus]) room.stats[u.bonus].pts -= UC_BONUS;
  if (p && !p.left) { p.alive = true; p.revealed = false; }
  if (p) { p.ucOpen = false; p.ucRes = null; }
  if (u.sheriff && room.players.get(u.sheriff)) room.players.get(u.sheriff).sheriffAt = -1;
  room.undo = null; room.lastElim = null; room.guess = null; room.whiteId = null; room.winner = null;
  setPhase(room, 'vote');
  room.votes = {}; room.tie = false;
  notice(room, 'Host undid the last kick. Vote again.');
  broadcast(room);
}
// ---------------------------------------------------------------- Gully Football
const FB_MAX = 12, FB_TURNS = 20;
const fbPlayers = (room) => (room.fb ? room.fb.ids.map((id) => room.players.get(id)).filter((p) => p && !p.left) : []);
function fbSend(room, obj) { for (const q of room.players.values()) if (q.ws && q.connected) send(q.ws, obj); }
function fbStart(room) {
  const cands = [...room.players.values()].filter((p) => !p.left);
  if (cands.length < 1) return 'Need at least 1 player';
  const sel = shuffle(cands.filter((p) => p.connected)).slice(0, FB_MAX);
  if (sel.length < 1) return 'Need at least 1 player online';
  for (const p of room.players.values()) p.watch = false;
  const ids = sel.map((p) => p.id), team = {};
  ids.forEach((id, i) => { team[id] = i % 2; });
  for (const p of cands) if (!ids.includes(p.id)) p.watch = true;
  const sz = FB.size(ids.length);
  room.pkPick = null;
  room.fb = { ids, team, W: sz.W, H: sz.H, gw: sz.gw, gws: sz.gws, pos: FB.layout(ids, team, sz.W, sz.H), ball: [sz.W / 2, sz.H / 2], score: [0, 0], turn: 0, sudden: false, aims: {}, goals: [], winner: null, last: null, lastTurn: -1, sim: null, pk: null };
  if (room.fbSet.mode === 'pens') pkStart(room, 'fun'); else fbAim(room);
  for (const p of sel) notify(room, p, '⚽ Football started', 'Open the game and play!', [100, 60, 100]);
  return null;
}
function fbAim(room) {
  const f = room.fb; f.aims = {};
  setPhase(room, 'faim');
  schedule(room, room.fbSet.secs * 1000, () => fbFire(room));
  broadcast(room);
}
function fgoMsg(f) {
  const s = f.sim;
  return { t: 'fgo', turn: f.turn, startAt: s.startAt, ids: f.ids, pos: f.pos, ball: f.ball, v: s.v, sudden: f.sudden, W: f.W, H: f.H, gw: f.gw, gws: f.gws, goal: s.goal, by: s.by };
}
function fbFire(room) {
  if (room.phase !== 'faim' || !room.fb) return;
  const f = room.fb;
  const v = {}; for (const id of Object.keys(f.aims)) v[id] = FB.aimVel(f.aims[id]);
  const sim = FB.simulate(f, v);
  f.sim = { turn: f.turn, goal: sim.goal, by: sim.by, v, end: { pos: sim.pos, ball: sim.ball }, startAt: Date.now() + 250 };
  setPhase(room, 'fplay');
  fbSend(room, fgoMsg(f));
  broadcast(room);
  const ms = 250 + Math.round(sim.frames.length * 1000 / 30) + (sim.goal !== null ? 3600 : 250);
  schedule(room, ms, () => fbAfter(room));
}
function fbAfter(room) {
  if (room.phase !== 'fplay' || !room.fb) return;
  const f = room.fb, s = f.sim;
  if (s) { f.pos = s.end.pos; f.ball = s.end.ball; }
  if (s && s.goal !== null) {
    f.score[s.goal]++;
    f.last = { team: s.goal, by: s.by, turn: f.turn }; f.lastTurn = f.turn;
    f.goals.push({ team: s.goal, by: s.by, own: s.by != null && f.team[s.by] !== s.goal });
    f.pos = FB.layout(f.ids, f.team, f.W, f.H); f.ball = [f.W / 2, f.H / 2];
    if (f.score[s.goal] >= room.fbSet.goals || f.sudden) return fbEnd(room, s.goal);
  }
  f.turn++;
  if (f.turn >= FB_TURNS && !f.sudden) {
    if (f.score[0] !== f.score[1]) return fbEnd(room, f.score[0] > f.score[1] ? 0 : 1);
    if (room.fbSet.tie === 'pens') { notice(room, '🥅 Level after 20 turns! PENALTY SHOOTOUT'); return pkStart(room, 'tie'); }
    f.sudden = true; notice(room, '⚡ SUDDEN DEATH! The goals get wider. Next goal wins');
  }
  fbAim(room);
}
function fbEnd(room, team) {
  setPhase(room, 'fover');
  room.fb.winner = team;
  for (const p of fbPlayers(room)) notify(room, p, '🏁 Full time', 'Final score ' + room.fb.score.join('–'), [70, 50, 70, 50, 70]);
  broadcast(room);
}
// ---- penalty shootout: kicker swipes to a zone and stops a power bar, keeper swipes to a zone. Same zone = saved.
const PK_ZONES = ['TL', 'TR', 'M', 'BL', 'BR'], PK_KICKS = 5, PK_SECS = 9;
function pkStart(room, why) {
  const f = room.fb;
  const m = [0, 1].map((t) => f.ids.filter((id) => f.team[id] === t));
  f.pk = { why, score: [0, 0], hist: [[], []], taken: [0, 0], cur: null, sd: false, res: null, n: 0, m };
  pkNext(room);
}
function pkNext(room) {
  const f = room.fb, k = f.pk;
  const solo = !k.m[0].length || !k.m[1].length;
  let t = k.taken[0] <= k.taken[1] ? 0 : 1;
  if (!k.m[t].length) t = 1 - t;
  const mine = k.m[t], other = k.m[1 - t], i = k.taken[t];
  k.cur = { team: t, kicker: mine[i % mine.length], keeper: other.length ? other[i % other.length] : null };
  k.sd = k.taken[0] >= PK_KICKS && k.taken[1] >= PK_KICKS && !solo;
  k.res = null; k.n++;
  room.pkPick = {};
  setPhase(room, 'pkaim');
  const up = (id) => { const q = id && room.players.get(id); return q && !q.left && q.connected; };
  if (!up(k.cur.kicker)) room.pkPick.k = { z: PK_ZONES[Math.floor(Math.random() * 5)], pw: 0.2, auto: true };
  if (k.cur.keeper && !up(k.cur.keeper)) room.pkPick.s = PK_ZONES[Math.floor(Math.random() * 5)];
  schedule(room, PK_SECS * 1000, () => pkResolve(room));
  broadcast(room);
  pkMaybe(room);
}
function pkMaybe(room) { // both picks in: resolve shortly
  const f = room.fb, k = f.pk, pk = room.pkPick;
  if (room.phase !== 'pkaim' || !pk || !pk.k) return;
  if (k.cur.keeper && !pk.s) return;
  if (pk.go) return; pk.go = true;
  const wait = pk.k.auto || !k.cur.keeper || pk.s ? 400 : 0;
  schedule(room, wait, () => pkResolve(room));
}
function pkResolve(room) {
  if (room.phase !== 'pkaim' || !room.fb || !room.fb.pk) return;
  const f = room.fb, k = f.pk, c = k.cur, pk = room.pkPick || {};
  const rz = () => PK_ZONES[Math.floor(Math.random() * 5)];
  const kz = pk.k ? pk.k.z : rz(), pw = pk.k ? pk.k.pw : 0.2;
  const sz = pk.s || (c.keeper ? 'M' : rz());
  const pc = pw < 0.22 ? 'green' : pw < 0.6 ? 'orange' : 'red';
  const on = pc === 'green' ? true : pc === 'orange' ? Math.random() < 0.85 : Math.random() < 0.05;
  let out;
  if (!on) out = pc === 'orange' ? 'post' : 'over';
  else if (pc === 'red') out = 'goal';
  else if (kz === sz) out = pc === 'green' ? 'save' : (Math.random() < 0.5 ? 'save' : 'goal');
  else out = 'goal';
  const side = (z) => (z === 'M' ? 'M' : z[1]);
  const tip = out === 'goal' && on && kz !== sz && side(kz) === side(sz) && kz !== 'M';
  k.taken[c.team]++;
  k.hist[c.team].push(out === 'goal' ? 'g' : out === 'save' ? 's' : out === 'post' ? 'p' : 'o');
  if (out === 'goal') k.score[c.team]++;
  k.res = { kz, sz, pc, out, tip, kicker: c.kicker, keeper: c.keeper, team: c.team };
  room.pkPick = null;
  setPhase(room, 'pkshow');
  broadcast(room);
  schedule(room, 3300, () => pkAfter(room));
}
function pkAfter(room) {
  if (room.phase !== 'pkshow' || !room.fb || !room.fb.pk) return;
  const f = room.fb, k = f.pk, a = k.taken[0], b = k.taken[1], s0 = k.score[0], s1 = k.score[1];
  const solo = !k.m[0].length || !k.m[1].length;
  let win = null;
  if (solo) { const t = k.m[0].length ? 0 : 1; if (k.taken[t] >= PK_KICKS) win = k.score[t] >= 3 ? t : 1 - t; }
  else if (a >= PK_KICKS && b >= PK_KICKS) { if (a === b && s0 !== s1) win = s0 > s1 ? 0 : 1; }
  else if (Math.max(a, b) <= PK_KICKS) {
    const r0 = PK_KICKS - a, r1 = PK_KICKS - b;
    if (s0 > s1 + r1) win = 0; else if (s1 > s0 + r0) win = 1;
  }
  if (win == null) return pkNext(room);
  return fbEnd(room, win);
}
// ---------------------------------------------------------------- UNO (2 to 12 players)
// Card = colour letter + value: R/Y/G/B + 0-9, s (skip), r (reverse), d (+2); wilds are Xw (wild) and Xf (+4).
const U_COLORS = ['R', 'Y', 'G', 'B'], U_ORD = { 0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, s: 10, r: 11, d: 12, w: 13, f: 14 }, U_COL = { R: 0, Y: 1, G: 2, B: 3, X: 4 };
const uNum = (c) => c[1] >= '0' && c[1] <= '9';
function uDeck(decks) {
  const d = [];
  for (let k = 0; k < decks; k++) {
    for (const c of U_COLORS) {
      d.push(c + '0');
      for (let n = 1; n <= 9; n++) d.push(c + n, c + n);
      for (const sp of ['s', 'r', 'd']) d.push(c + sp, c + sp);
    }
    for (let i = 0; i < 6; i++) d.push('Xw', 'Xf'); // a few more wilds and +4s than the real deck
  }
  return d;
}
const uSort = (h) => h.sort((a, b) => (U_COL[a[0]] - U_COL[b[0]]) || (U_ORD[a[1]] - U_ORD[b[1]]));
const uCan = (u, c) => c[0] === 'X' || c[0] === u.color || c[1] === u.top[1];
function uEv(u, o) { u.ev++; u.last = Object.assign({ i: u.ev }, o); u.log = (u.log || []).concat([u.last]).slice(-6); }
function uDraw(u, n) { // draw pile ran out? keep the top 2 discards, shuffle the rest into a fresh pile
  const out = [];
  for (let i = 0; i < n; i++) {
    if (!u.draw.length && u.disc.length > 2) { const keep = u.disc.splice(u.disc.length - 2, 2); u.draw = shuffle(u.disc); u.disc = keep; u.resh = (u.resh || 0) + 1; }
    if (!u.draw.length) break;
    out.push(u.draw.pop());
  }
  return out;
}
const uAct = (u) => u.ids.filter((id) => !u.fin.includes(id));
const uAdv = (u, k) => { const n = u.ids.length; for (let s = 0; s < k; s++) { let g = 0; do { u.cur = (((u.cur + u.dir) % n) + n) % n; } while (u.fin.includes(u.ids[u.cur]) && ++g < n); } };
function unStart(room) {
  const cands = [...room.players.values()].filter((p) => !p.left && p.connected);
  if (cands.length < 2) return 'Need at least 2 players';
  const sel = shuffle(cands).slice(0, 12), ids = sel.map((p) => p.id);
  for (const p of room.players.values()) p.watch = false;
  for (const p of cands) if (!ids.includes(p.id)) p.watch = true;
  let draw = shuffle(uDeck(ids.length > 6 ? 2 : 1));
  const hands = {}; for (const id of ids) hands[id] = [];
  for (let r = 0; r < 7; r++) for (const id of ids) hands[id].push(draw.pop());
  let top = null; const buried = [];
  while (draw.length) { const c = draw.pop(); if (uNum(c)) { top = c; break; } buried.push(c); } // the first card is always a number
  draw = shuffle(draw.concat(buried));
  for (const id of ids) uSort(hands[id]);
  room.unGid = (room.unGid || 0) + 1;
  room.un = { gid: room.unGid, ids, hands, draw, disc: [top], top, color: top[0], dir: 1, cur: 0, pend: null, drew: null, said: {}, calls: {}, fin: [], ev: 0, last: null, winner: null, ranks: null, resh: 0 };
  setPhase(room, 'udeal');
  schedule(room, 4800, () => unTurn(room)); // shuffle + deal animation plays on every phone first
  broadcast(room);
  for (const p of sel) notify(room, p, '🃏 UNO started', 'Open the game and play!', [100, 60, 100]);
  return null;
}
function unTurn(room) {
  const u = room.un; if (!u) return;
  setPhase(room, 'uturn'); u.drew = null; u.paused = null;
  if (u.fin.includes(u.ids[u.cur])) uAdv(u, 1);
  const q = room.players.get(u.ids[u.cur]), secs = room.unSet.secs;
  if (!q || q.left || !q.connected) schedule(room, 3000, () => unAuto(room));
  else if (secs) schedule(room, secs * 1000, () => unAuto(room));
  broadcast(room);
}
function unAuto(room) { // time ran out (or the player is away): draw and pass
  const u = room.un; if (!u || room.phase !== 'uturn') return;
  const id = u.ids[u.cur], p = room.players.get(id); if (!p) return;
  if (u.drew !== null) return unPass(room, p);
  unDraw(room, p, true);
}
function unOver(room) {
  const u = room.un;
  const rest = u.ids.filter((id) => !u.fin.includes(id)).sort((a, b) => u.hands[a].length - u.hands[b].length);
  const w = u.fin[0] || rest[0];
  u.winner = w; u.ranks = u.fin.concat(rest).map((id) => ({ id, left: u.hands[id].length }));
  setPhase(room, 'uover');
  for (const id of u.ids) { const q = room.players.get(id); if (q && !q.left) notify(room, q, '🏁 UNO finished', (room.players.get(w) || {}).name + ' won', [70, 50, 70]); }
  broadcast(room);
}
function unPlay(room, p, idxs, color) {
  const u = room.un;
  if (!u || room.phase !== 'uturn' || u.ids[u.cur] !== p.id) return 'Not your turn';
  const hand = u.hands[p.id];
  if (!Array.isArray(idxs) || !idxs.length || idxs.length > 12) return 'Pick a card';
  if (new Set(idxs).size !== idxs.length || idxs.some((i) => !Number.isInteger(i) || i < 0 || i >= hand.length)) return 'Pick a card';
  const cards = idxs.map((i) => hand[i]), first = cards[0], last = cards[cards.length - 1];
  if (u.drew !== null && !(idxs.length === 1 && idxs[0] === u.drew)) return 'Play the card you drew, or pass';
  if (u.pend) {
    if (cards.length !== 1 || first[1] !== (u.pend.k === '2' ? 'd' : 'f')) return u.pend.k === '2' ? 'Only a +2 can go on a +2. Draw the cards' : 'Only a +4 can go on a +4. Draw the cards';
  } else {
    if (cards.length > 1 && !cards.every((c) => uNum(c) && c[1] === first[1])) return 'Only number cards of the same number go together';
    if (!uCan(u, first)) return "That card doesn't match";
  }
  if (cards.length === hand.length && !uNum(last)) return "A power card can't be your last card. Draw instead";
  if (cards.some((c) => c[0] === 'X') && !U_COLORS.includes(color)) return 'Pick a colour';
  for (const i of [...idxs].sort((a, b) => b - a)) hand.splice(i, 1);
  for (const c of cards) u.disc.push(c);
  u.top = last; u.color = last[0] === 'X' ? color : last[0];
  const n = uAct(u).length;
  if (cards.length === 1) {
    const v = last[1];
    if (v === 's') uAdv(u, 2);
    else if (v === 'r') { u.dir = -u.dir; uAdv(u, n === 2 ? 2 : 1); }
    else if (v === 'd') { u.pend = { k: '2', n: (u.pend ? u.pend.n : 0) + 2 }; uAdv(u, 1); }
    else if (v === 'f') { u.pend = { k: '4', n: (u.pend ? u.pend.n : 0) + 4 }; uAdv(u, 1); }
    else uAdv(u, 1);
  } else uAdv(u, 1);
  u.drew = null;
  uEv(u, { k: 'play', id: p.id, cards, color: u.color, pend: u.pend ? u.pend.n : 0 });
  if (!hand.length) {
    u.fin.push(p.id); delete u.calls[p.id]; delete u.said[p.id]; u.last.fin = u.fin.length;
    if (u.fin.length >= Math.min(3, u.ids.length - 1) || uAct(u).length < 2) return unOver(room), null;
    u.drew = null; unTurn(room); return null;
  }
  if (hand.length === 1) { if (u.said[p.id]) delete u.said[p.id]; else u.calls[p.id] = Date.now(); }
  else { delete u.calls[p.id]; if (hand.length > 2) delete u.said[p.id]; }
  unTurn(room);
  return null;
}
function unDraw(room, p, auto) {
  const u = room.un;
  if (!u || room.phase !== 'uturn' || u.ids[u.cur] !== p.id || u.drew !== null) return;
  const hand = u.hands[p.id];
  delete u.calls[p.id]; delete u.said[p.id];
  if (u.pend) {
    const got = uDraw(u, u.pend.n); for (const c of got) hand.push(c); uSort(hand);
    uEv(u, { k: 'draw', id: p.id, n: got.length, pend: true });
    u.pend = null; uAdv(u, 1);
    return unTurn(room);
  }
  const got = uDraw(u, 1);
  if (!got.length) { uEv(u, { k: 'pass', id: p.id }); uAdv(u, 1); return unTurn(room); }
  hand.push(got[0]); uSort(hand);
  uEv(u, { k: 'draw', id: p.id, n: 1 });
  if (!auto && uCan(u, got[0])) { // may play the card you just drew, or pass
    u.drew = hand.indexOf(got[0]);
    const secs = room.unSet.secs;
    room.seq++; clearTimeout(room.timer); if (secs) schedule(room, Math.min(secs, 12) * 1000, () => unAuto(room));
    return broadcast(room);
  }
  uAdv(u, 1); unTurn(room);
}
function unPass(room, p) {
  const u = room.un;
  if (!u || room.phase !== 'uturn' || u.ids[u.cur] !== p.id || u.drew === null) return;
  uEv(u, { k: 'pass', id: p.id }); u.drew = null; uAdv(u, 1); unTurn(room);
}
function unUno(room, p) {
  const u = room.un; if (!u || !u.ids.includes(p.id) || !['udeal', 'uturn'].includes(room.phase)) return;
  const hand = u.hands[p.id];
  if (hand.length === 2) { u.said[p.id] = true; uEv(u, { k: 'uno', id: p.id }); return broadcast(room); } // pressed early: counts when you play down to 1
  if (hand.length === 1 && u.calls[p.id] && Date.now() < u.calls[p.id] + 3000) { delete u.calls[p.id]; uEv(u, { k: 'uno', id: p.id }); broadcast(room); }
}
function unCatch(room, p) { // after 3 seconds anybody can catch a player who forgot to say UNO
  const u = room.un; if (!u || !u.ids.includes(p.id) || room.phase !== 'uturn') return;
  const now = Date.now();
  const t = Object.keys(u.calls).filter((id) => id !== p.id && now >= u.calls[id] + 3000 && u.hands[id] && u.hands[id].length === 1).sort((a, b) => u.calls[a] - u.calls[b])[0];
  if (!t) return;
  delete u.calls[t];
  const got = uDraw(u, 2); for (const c of got) u.hands[t].push(c); uSort(u.hands[t]);
  uEv(u, { k: 'caught', id: t, by: p.id, n: got.length });
  broadcast(room);
}
function unRemove(room, p) {
  const u = room.un;
  if (!u || !['udeal', 'uturn'].includes(room.phase)) return;
  const i = u.ids.indexOf(p.id); if (i < 0) return;
  u.draw = u.hands[p.id].concat(u.draw); // their cards go under the draw pile
  u.ids.splice(i, 1); u.fin = u.fin.filter((x) => x !== p.id); delete u.hands[p.id]; delete u.calls[p.id]; delete u.said[p.id];
  if (uAct(u).length < 2) { notice(room, 'Not enough players left'); return unOver(room); }
  if (i < u.cur) u.cur--;
  else if (i === u.cur) { u.cur = (((i + (u.dir === -1 ? -1 : 0)) % u.ids.length) + u.ids.length) % u.ids.length; u.drew = null; if (room.phase === 'uturn') return unTurn(room); }
  u.cur = ((u.cur % u.ids.length) + u.ids.length) % u.ids.length;
}
function unBack(room) {
  setPhase(room, 'lobby'); room.un = null;
  for (const [id, p] of room.players) if (p.left) room.players.delete(id);
  for (const p of room.players.values()) p.watch = false;
  broadcast(room);
}
function fbBack(room) { // back to the football lobby
  setPhase(room, 'lobby'); room.fb = null; room.pkPick = null;
  for (const [id, p] of room.players) if (p.left) room.players.delete(id);
  for (const p of room.players.values()) p.watch = false;
  broadcast(room);
}
function fbCheck(room) { // somebody left: make sure both teams still have a player
  if (!room.fb || !['faim', 'fplay', 'pkaim', 'pkshow'].includes(room.phase)) return broadcast(room);
  const live = fbPlayers(room), had = (t) => room.fb.ids.some((id) => room.fb.team[id] === t);
  if (!live.length || (had(0) && !live.some((p) => room.fb.team[p.id] === 0)) || (had(1) && !live.some((p) => room.fb.team[p.id] === 1))) {
    notice(room, 'A team has no players left. Back to the lobby');
    return fbBack(room);
  }
  broadcast(room);
}
// ---------------------------------------------------------------- Beach Buggy race
// Each phone drives its own buggy. The server keeps the standings and passes everyone's position on (10 times a second)
// so phones can draw the other buggies and bump into them.
const RACE_LAPS = 3, RACE_MIN_MS = 20000, RACE_AFTER_FIRST = 45000, RACE_MAX_MS = 6 * 60 * 1000;
const racers = (room) => (room.rc ? room.rc.ids.map((id) => room.players.get(id)).filter((p) => p && !p.left) : []);
function raceRank(room) {
  const r = room.rc; if (!r) return [];
  return r.ids.filter((id) => room.players.get(id) && !room.players.get(id).left)
    .map((id) => [id, r.fin[id] != null ? RACE_LAPS : Math.round((r.prog[id] || 0) * 1000) / 1000, r.fin[id] != null ? r.fin[id] : null])
    .sort((a, b) => (a[2] != null && b[2] != null ? a[2] - b[2] : a[2] != null ? -1 : b[2] != null ? 1 : b[1] - a[1]));
}
function raceStart(room) {
  const sel = [...room.players.values()].filter((p) => !p.left && p.connected).slice(0, 12);
  if (!sel.length) return 'Need at least 1 player';
  for (const p of room.players.values()) p.watch = !sel.includes(p);
  room.rc = { ids: sel.map((p) => p.id), startAt: Date.now() + 4500, prog: {}, fin: {}, cars: {}, results: null, firstFin: false };
  setPhase(room, 'rrace');
  schedule(room, RACE_MAX_MS, () => raceEnd(room));
  broadcast(room);
  for (const p of sel) notify(room, p, '🏖️ Race starting!', 'Open the game, 3… 2… 1…', [100, 60, 100]);
  return null;
}
function raceEnd(room) {
  if (room.phase !== 'rrace' || !room.rc) return;
  room.rc.results = raceRank(room);
  setPhase(room, 'rover');
  broadcast(room);
}
function raceCheck(room) { // everyone still racing has finished?
  if (room.phase !== 'rrace' || !room.rc) return broadcast(room);
  const live = racers(room);
  if (!live.length) { setPhase(room, 'lobby'); room.rc = null; return broadcast(room); }
  if (live.every((p) => room.rc.fin[p.id] != null)) return raceEnd(room);
  broadcast(room);
}
setInterval(() => { // live standings, 3 times a second, only while racing
  for (const room of rooms.values()) {
    if (room.phase !== 'rrace' || !room.rc) continue;
    const list = raceRank(room);
    for (const q of room.players.values()) if (q.ws && q.connected) send(q.ws, { t: 'rrank', list });
  }
}, 333);
setInterval(() => { // where every buggy is, 10 times a second (only when 2+ are racing)
  for (const room of rooms.values()) {
    const r = room.rc;
    if (room.phase !== 'rrace' || !r || r.ids.length < 2 || !r.cars) continue;
    const l = r.ids.filter((id) => r.cars[id] && r.fin[id] == null && room.players.get(id) && !room.players.get(id).left).map((id) => r.cars[id]);
    if (!l.length) continue;
    for (const q of room.players.values()) if (q.ws && q.connected) send(q.ws, { t: 'rcars', l });
  }
}, 50);
function notice(room, msg) { for (const p of room.players.values()) if (p.ws && p.connected) send(p.ws, { t: 'notice', msg }); }
function backToLobby(room) {
  for (const [id, p] of room.players) if (p.left) room.players.delete(id);
  for (const p of room.players.values()) { p.role = null; p.word = ''; p.alive = true; p.revealed = false; p.ucOpen = false; p.ucRes = null; p.sheriff = false; p.sheriffAt = -1; }
  setPhase(room, 'lobby');
  room.round = 0; room.descs = {}; room.votes = {}; room.tie = false; room.history = [];
  room.lastElim = null; room.guess = null; room.whiteId = null; room.winner = null; room.pair = null; room.undo = null;
  room.nextPair = drawPair(room);
}

// After a player leaves/is kicked mid-game, re-check whatever the current phase is waiting for.
function afterRemoval(room) {
  if (room.game === 'football') return fbCheck(room);
  if (room.game === 'race') return raceCheck(room);
  if (room.game === 'uno') return broadcast(room);
  if (!['describe', 'vote', 'whiteguess', 'elim'].includes(room.phase)) return broadcast(room);
  const win = checkWin(room);
  if (win) return endGame(room, win);
  if (room.phase === 'describe') {
    if (!isActive(room, room.order[room.turn])) return advanceTurn(room);
  } else if (room.phase === 'vote') {
    for (const [voter, target] of Object.entries(room.votes)) {
      const a = room.players.get(voter), b = room.players.get(target);
      if (!a || !a.alive || !b || !b.alive) delete room.votes[voter];
    }
    return tryResolve(room, false);
  } else if (room.phase === 'whiteguess' && room.players.get(room.whiteId)?.left) {
    return finishGuess(room, '');
  }
  broadcast(room);
}

function transferHost(room) {
  const cands = [...room.players.values()].filter((p) => !p.left && p.connected && p.id !== room.hostId);
  const next = cands.find((p) => p.id !== room.supervisorId) || cands[0];
  if (!next) return false;
  if (room.supervisorId === room.hostId && room.phase === 'lobby') room.supervisorId = null;
  room.hostId = next.id;
  return true;
}

function removePlayer(room, p, selfLeft) {
  const wasHost = p.id === room.hostId;
  if (p.ws) { p.ws.ctx = null; send(p.ws, { t: selfLeft ? 'left' : 'kicked' }); }
  p.ws = null; p.connected = false;
  if (room.supervisorId === p.id && room.phase === 'lobby') { room.supervisorId = null; room.customPair = null; }
  if (room.supReq === p.id) room.supReq = null;
  if (room.phase === 'lobby' || room.phase === 'over') room.players.delete(p.id);
  else { p.left = true; p.alive = false; delete room.votes[p.id]; delete room.descs[p.id]; }
  if (![...room.players.values()].some((q) => !q.left)) { clearTimeout(room.timer); rooms.delete(room.code); return; }
  if (wasHost && !transferHost(room)) { /* nobody connected: host stays unassigned until someone rejoins */ }
  if (room.game === 'uno') unRemove(room, p);
  afterRemoval(room);
}

// ---------------------------------------------------------------- websocket
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16384, perMessageDeflate: false });

function attach(ws, room, p) {
  if (p.ws && p.ws !== ws) { p.ws.ctx = null; try { p.ws.close(); } catch (e) { /* ignore */ } }
  p.ws = ws; p.connected = true; p.discAt = 0;
  ws.ctx = { code: room.code, pid: p.id };
  if (!room.hostId || !room.players.get(room.hostId)) room.hostId = p.id;
  if (p.id === room.ownerId && room.hostId !== p.id) { // host dropped and got replaced automatically: give it back
    if (room.supervisorId === room.hostId && room.phase === 'lobby') room.supervisorId = null;
    room.hostId = p.id;
    notice(room, '👑 ' + p.name + ' is back. Host again');
  }
  send(ws, { t: 'joined', id: p.id, token: p.token, code: room.code, vapid: webpush ? webpush.pub : null });
  const photos = {}; for (const q of room.players.values()) if (q.photo && !q.left) photos[q.name] = q.photo;
  send(ws, { t: 'photos', map: photos });
  send(ws, { t: 'chatlog', list: room.chat || [] });
  if (room.game === 'football' && room.phase === 'fplay' && room.fb && room.fb.sim) send(ws, fgoMsg(room.fb));
  broadcast(room);
}

function handle(ws, m) {
  if (!m || typeof m.t !== 'string') return;
  // ---- before joining a room
  if (m.t === 'create') {
    const name = clean(m.name, 14);
    if (!name) return errTo(ws, 'Enter your name');
    const room = makeRoom(loadWords(m));
    if (m.game === 'football' || m.game === 'race' || m.game === 'uno') room.game = m.game;
    const p = addPlayer(room, name);
    room.hostId = room.ownerId = p.id;
    attach(ws, room, p);
    return shareWords(room);
  }
  if (m.t === 'join') {
    const name = clean(m.name, 14);
    const room = rooms.get(clean(m.code, 4).toUpperCase());
    if (!name) return errTo(ws, 'Enter your name');
    if (!room) return errTo(ws, 'No lobby with that code');
    if ([...room.players.values()].filter((q) => !q.left).length >= MAX_PLAYERS) return errTo(ws, 'Lobby is full');
    if ([...room.players.values()].some((q) => !q.left && norm(q.name) === norm(name))) return errTo(ws, 'That name is taken in this lobby');
    const np = addPlayer(room, name);
    if (room.phase !== 'lobby' && room.phase !== 'over' && room.phase !== 'fover' && room.phase !== 'rover' && room.phase !== 'uover') { np.watch = true; notice(room, '👀 ' + name + ' joined. Watching until the next game'); }
    return attach(ws, room, np);
  }
  if (m.t === 'rejoin') {
    const room = rooms.get(clean(m.code, 4).toUpperCase());
    const p = room && [...room.players.values()].find((q) => !q.left && typeof m.token === 'string' && q.token === m.token);
    if (!p) return send(ws, { t: 'norejoin' });
    return attach(ws, room, p);
  }
  if (m.t === 'ping') return send(ws, { t: 'pong' });

  // ---- inside a room
  const ctx = ws.ctx;
  const room = ctx && rooms.get(ctx.code);
  const p = room && room.players.get(ctx.pid);
  if (!p) return;
  const isHost = p.id === room.hostId;
  const hostOnly = () => { if (!isHost) { errTo(ws, 'Only the host can do that'); return false; } return true; };

  switch (m.t) {
    case 'settings': {
      if (!hostOnly() || room.phase !== 'lobby') return;
      const s = room.settings;
      if ('describeSecs' in m) s.describeSecs = clamp(m.describeSecs, 5, 300);
      if ('autoRoles' in m) s.autoRoles = !!m.autoRoles;
      if ('undercover' in m) s.undercover = clamp(m.undercover, 0, 10);
      if ('white' in m) s.white = clamp(m.white, 0, 5);
      if ('supervisor' in m) { room.supervisorId = m.supervisor ? room.hostId : null; room.customPair = null; }
      if ('hint' in m) s.hint = !!m.hint;
      if ('board' in m) s.board = !!m.board;
      if ('reacts' in m) s.reacts = !!m.reacts;
      if ('joker' in m) s.joker = !!m.joker;
      if ('ucGuess' in m) s.ucGuess = !!m.ucGuess;
      if ('sheriff' in m) s.sheriff = !!m.sheriff;
      if ('whiteTries' in m) s.whiteTries = Math.max(0, Math.min(3, m.whiteTries | 0));
      if ('chat' in m) s.chat = !!m.chat;
      if ('chatSlow' in m && [0, 5, 10, 30].includes(Number(m.chatSlow))) s.chatSlow = Number(m.chatSlow);
      if ('reactCd' in m && [1, 3, 10].includes(Number(m.reactCd))) s.reactCd = Number(m.reactCd);
      if ('modes' in m) { s.modes = cleanModes(m.modes); if (!room.customPair) room.nextPair = drawPair(room); }
      return broadcast(room);
    }
    case 'reroll':
      if (room.phase !== 'lobby' || room.supervisorId !== p.id) return;
      room.nextPair = drawPair(room); room.customPair = null;
      return broadcast(room);
    case 'setWords': { // the supervisor types their own pair
      if (room.phase !== 'lobby' || room.supervisorId !== p.id) return;
      const a = clean(m.civilian, 24), b = clean(m.undercover, 24);
      if (!a && !b) { room.customPair = null; return broadcast(room); }
      if (!a || !b) return errTo(ws, 'Enter both words');
      if (norm(a) === norm(b)) return errTo(ws, 'The two words must be different');
      room.customPair = { civilian: a, undercover: b, cat: 'Custom words' };
      return broadcast(room);
    }
    case 'supReq': // a player asks to be the supervisor; the host must approve
      if (room.phase !== 'lobby' || isHost || room.supervisorId === p.id) return;
      room.supReq = m.cancel ? (room.supReq === p.id ? null : room.supReq) : p.id;
      return broadcast(room);
    case 'supAnswer':
      if (!hostOnly() || room.phase !== 'lobby' || !room.supReq) return;
      if (m.ok && room.players.get(room.supReq)) { room.supervisorId = room.supReq; room.customPair = null; }
      else { const r = room.players.get(room.supReq); if (r && r.ws) send(r.ws, { t: 'err', msg: 'The host said no to supervisor' }); }
      room.supReq = null;
      return broadcast(room);
    case 'supDrop': // host or the supervisor can end supervising
      if (room.phase !== 'lobby' || !(isHost || room.supervisorId === p.id)) return;
      room.supervisorId = null; room.customPair = null;
      return broadcast(room);
    case 'typing': {
      const turn = (room.phase === 'describe' && room.order[room.turn] === p.id) || (room.phase === 'whiteguess' && room.whiteId === p.id);
      if (!turn) return;
      const was = room.typingId === p.id && Date.now() < room.typingUntil;
      room.typingId = p.id; room.typingUntil = Date.now() + 3500;
      clearTimeout(room.typingTimer);
      room.typingTimer = setTimeout(() => { room.typingId = null; broadcast(room); }, 3600);
      return was ? undefined : broadcast(room);
    }
    case 'restart': { // host: scrap this round, new word + new roles, nobody scores
      if (!hostOnly() || !['describe', 'vote', 'whiteguess', 'elim'].includes(room.phase)) return;
      backToLobby(room);
      const err = startGame(room, null);
      if (err) { broadcast(room); return errTo(ws, err); }
      return notice(room, '🔄 Host started a fresh round with a new word');
    }
    case 'undo':
      if (!hostOnly() || !room.undo || !['elim', 'whiteguess', 'over'].includes(room.phase)) return;
      return undoKick(room);
    case 'react': {
      const E = room.game === 'uno' ? ['😂', '😡', '😱', '🔥', '👏', '🤡', '😎', '🙏', '🥶', '💀', '😈', '🤯'] : ['😂', '🤨', '🤡', '🔥', '😱', '👀'];
      if (!room.settings.reacts || !E.includes(m.e) || room.phase === 'lobby') return;
      const now = Date.now(); if (now - (p.lastReact || 0) < room.settings.reactCd * 1000 - 150) return; p.lastReact = now;
      for (const q of room.players.values()) if (q.ws && q.connected) send(q.ws, { t: 'react', e: m.e, from: p.name });
      return;
    }
    case 'start': {
      if (!hostOnly() || room.phase !== 'lobby') return;
      const err = startGame(room, m.custom);
      return err ? errTo(ws, err) : undefined;
    }
    case 'describe': {
      if (room.phase !== 'describe' || !p.alive || !p.role) return;
      if (room.order[room.turn] !== p.id) return errTo(ws, "It's not your turn yet");
      const text = clean(m.text, 40);
      if (!text) return errTo(ws, 'Type a word or short phrase');
      if (p.word && mentions(text, p.word)) return errTo(ws, "Don't say your actual word!");
      if (Object.values(room.descs).some((d) => norm(d) === norm(text))) return errTo(ws, 'Someone already said that. Try a different clue');
      room.descs[p.id] = text; room.typingId = null;
      return advanceTurn(room);
    }
    case 'skipTurn':
      if (!hostOnly() || room.phase !== 'describe') return;
      return advanceTurn(room);
    case 'endDescribe':
      if (!hostOnly()) return;
      return endDescribe(room);
    case 'vote': {
      if (room.phase !== 'vote' || !p.alive || !p.role) return;
      if (m.target === null) delete room.votes[p.id];
      else {
        const t = room.players.get(String(m.target));
        if (!t || !t.alive || !t.role || t.id === p.id) return errTo(ws, "Can't vote for that player");
        room.votes[p.id] = t.id;
      }
      room.tie = false; // re-voting has started: hide the tie card
      return tryResolve(room, false);
    }
    case 'sheriff': { // the Sheriff's one shot, during voting: hits Mr. White = he is out, otherwise the Sheriff is out
      if (room.phase !== 'vote' || !p.alive || !p.sheriff) return;
      if (p.sheriffAt === room.round) return errTo(ws, 'Only one shot per voting round');
      const t = room.players.get(String(m.target));
      if (!t || !t.alive || !t.role || t.left || t.id === p.id) return errTo(ws, "Can't shoot that player");
      const hit = t.role === 'white' || t.role === 'undercover'; // the Joker and civilians count as a miss
      p.sheriffAt = room.round;
      const shot = { byId: p.id, by: p.name, targetId: t.id, target: t.name, hit, role: hit ? t.role : null };
      for (const q of room.players.values()) if (q.ws && q.connected) send(q.ws, Object.assign({ t: 'sheriff' }, shot));
      const cm = { sys: true, text: '🤠 Sheriff ' + p.name + ' shot ' + t.name + (hit ? ' ✓ ' + (t.role === 'white' ? 'Mr. White' : 'the Undercover') + ' is out!' : ' ✗ wrong! The Sheriff is out'), at: Date.now() };
      room.chat = (room.chat || []).concat(cm).slice(-40);
      for (const q of room.players.values()) if (q.ws && q.connected) send(q.ws, { t: 'chat', m: cm });
      return eliminate(room, hit ? t.id : p.id, shot);
    }
    case 'fset': {
      if (!hostOnly() || room.game !== 'football' || room.phase !== 'lobby') return;
      if ([1, 2, 3, 5].includes(Number(m.goals))) room.fbSet.goals = Number(m.goals);
      if ([4, 6, 8, 12].includes(Number(m.secs))) room.fbSet.secs = Number(m.secs);
      if (['match', 'pens'].includes(m.mode)) room.fbSet.mode = m.mode;
      if (['pens', 'sudden'].includes(m.tie)) room.fbSet.tie = m.tie;
      return broadcast(room);
    }
    case 'fstart': {
      if (!hostOnly() || room.game !== 'football' || !['lobby', 'fover'].includes(room.phase)) return;
      const err = fbStart(room);
      return err ? errTo(ws, err) : undefined;
    }
    case 'flobby':
      if (!hostOnly() || room.game !== 'football' || !['fover', 'faim', 'fplay', 'pkaim', 'pkshow'].includes(room.phase)) return;
      return fbBack(room);
    case 'faim': {
      if (room.phase !== 'faim' || !room.fb || !room.fb.ids.includes(p.id)) return;
      const dx = Number(m.dx), dy = Number(m.dy), pw = Number(m.pw);
      if (![dx, dy, pw].every(Number.isFinite) || Math.hypot(dx, dy) < 0.001) return;
      room.fb.aims[p.id] = { dx, dy, pw: Math.max(0, Math.min(1, pw)) };
      const need = fbPlayers(room).filter((q) => q.connected);
      if (need.length && need.every((q) => room.fb.aims[q.id])) schedule(room, 300, () => fbFire(room)); // everyone locked in: fire soon
      return broadcast(room);
    }
    case 'pkick': { // kicker: zone + power bar position (0..1), locked
      const f = room.fb, pk = room.pkPick;
      if (room.phase !== 'pkaim' || !f || !f.pk || !pk || f.pk.cur.kicker !== p.id || pk.k) return;
      const pw = Number(m.pw);
      if (!PK_ZONES.includes(m.z) || !Number.isFinite(pw)) return;
      pk.k = { z: m.z, pw: Math.max(0, Math.min(1, pw)) };
      broadcast(room);
      return pkMaybe(room);
    }
    case 'psave': { // keeper: zone (can change until the kicker has locked)
      const f = room.fb, pk = room.pkPick;
      if (room.phase !== 'pkaim' || !f || !f.pk || !pk || f.pk.cur.keeper !== p.id || pk.go) return;
      if (!PK_ZONES.includes(m.z)) return;
      pk.s = m.z;
      broadcast(room);
      return pkMaybe(room);
    }
    case 'uset': {
      if (!hostOnly() || room.game !== 'uno' || room.phase !== 'lobby') return;
      if ([0, 10, 20, 30].includes(Number(m.secs))) room.unSet.secs = Number(m.secs);
      return broadcast(room);
    }
    case 'ustart': {
      if (!hostOnly() || room.game !== 'uno' || !['lobby', 'uover'].includes(room.phase)) return;
      const err = unStart(room);
      return err ? errTo(ws, err) : undefined;
    }
    case 'upause': {
      if (!hostOnly() || room.game !== 'uno' || room.phase !== 'uturn' || !room.un || room.un.paused) return;
      clearTimeout(room.timer); room.un.paused = { left: room.endsAt ? Math.max(1500, room.endsAt - Date.now()) : 0 }; room.endsAt = null;
      notice(room, '⏸ Game paused by the host'); return broadcast(room);
    }
    case 'uresume': {
      if (!hostOnly() || room.game !== 'uno' || !room.un || !room.un.paused) return;
      const left = room.un.paused.left; room.un.paused = null;
      if (left) schedule(room, left, () => unAuto(room)); else room.endsAt = null;
      notice(room, '▶️ Game resumed'); return broadcast(room);
    }
    case 'ulobby':
      if (!hostOnly() || room.game !== 'uno' || !['udeal', 'uturn', 'uover'].includes(room.phase)) return;
      return unBack(room);
    case 'uplay': { if (room.game !== 'uno') return; if (room.un && room.un.paused) return errTo(ws, '⏸ Game is paused'); const e = unPlay(room, p, m.cards, m.color); return e ? errTo(ws, e) : undefined; }
    case 'udraw': if (room.game === 'uno' && !(room.un && room.un.paused)) unDraw(room, p, false); return;
    case 'upass': if (room.game === 'uno' && !(room.un && room.un.paused)) unPass(room, p); return;
    case 'uuno': if (room.game === 'uno' && !(room.un && room.un.paused)) unUno(room, p); return;
    case 'ucatch': if (room.game === 'uno' && !(room.un && room.un.paused)) unCatch(room, p); return;
    case 'rstart': {
      if (!hostOnly() || room.game !== 'race' || !['lobby', 'rover'].includes(room.phase)) return;
      const err = raceStart(room);
      return err ? errTo(ws, err) : undefined;
    }
    case 'rlobby':
      if (!hostOnly() || room.game !== 'race' || !['rrace', 'rover'].includes(room.phase)) return;
      setPhase(room, 'lobby'); room.rc = null;
      for (const [id, q] of room.players) if (q.left) room.players.delete(id);
      for (const q of room.players.values()) q.watch = false;
      return broadcast(room);
    case 'rprog': { // how far this phone's buggy has got: laps done + part of the current lap
      const r = room.rc;
      if (room.phase !== 'rrace' || !r || !r.ids.includes(p.id) || r.fin[p.id] != null) return;
      const d = Number(m.d);
      if (!Number.isFinite(d) || Date.now() < r.startAt) return;
      r.prog[p.id] = Math.max(0, Math.min(RACE_LAPS - 0.001, d));
      return;
    }
    case 'rpos': { // this phone's buggy: distance, side position, speed, flags (turbo/drift/shield/air…), height
      const r = room.rc;
      if (room.phase !== 'rrace' || !r || !r.cars || !r.ids.includes(p.id) || r.fin[p.id] != null) return;
      const d = Number(m.d), x = Number(m.x), sp = Number(m.sp), hh = Number(m.h) || 0;
      if (![d, x, sp].every(Number.isFinite)) return;
      r.cars[p.id] = [p.id, Math.round(d), Math.round(Math.max(-3, Math.min(3, x)) * 1000) / 1000, Math.round(Math.max(0, Math.min(40000, sp))), (Number(m.f) | 0) & 127, Math.round(Math.max(0, Math.min(5000, hh)))];
      return;
    }
    case 'rbump': { // a buggy hit another one: tell the other phone so it gets pushed too
      const r = room.rc;
      if (room.phase !== 'rrace' || !r || !r.ids.includes(p.id) || !r.ids.includes(m.to) || m.to === p.id) return;
      const now = Date.now(); if (now - (p.bumpAt || 0) < 120) return; p.bumpAt = now;
      const q = room.players.get(m.to); if (!q || !q.ws || !q.connected || r.fin[q.id] != null) return;
      send(q.ws, { t: 'rbump', from: p.id, sx: Number(m.sx) > 0 ? 1 : -1, k: Math.max(0, Math.min(4, Number(m.k) || 0)), sp: Math.max(0, Math.min(40000, Number(m.sp) || 0)), rel: Math.max(-1000, Math.min(1000, Number(m.rel) || 0)) });
      return;
    }
    case 'rfin': {
      const r = room.rc;
      if (room.phase !== 'rrace' || !r || !r.ids.includes(p.id) || r.fin[p.id] != null) return;
      const ms = Math.round(Number(m.ms)), real = Date.now() - r.startAt;
      if (!Number.isFinite(ms) || ms < RACE_MIN_MS || real < RACE_MIN_MS - 2000) return errTo(ws, 'That was too fast 🤨');
      r.fin[p.id] = Math.min(ms, real + 1500); if (r.cars) delete r.cars[p.id];
      const place = Object.keys(r.fin).length;
      notice(room, '🏁 ' + p.name + ' finished ' + (place <= 3 ? ['1st', '2nd', '3rd'][place - 1] : place + 'th') + '!');
      if (!r.firstFin) { r.firstFin = true; if (racers(room).some((q) => r.fin[q.id] == null)) schedule(room, RACE_AFTER_FIRST, () => raceEnd(room)); }
      return raceCheck(room);
    }
    case 'closeVote':
      if (!hostOnly() || room.phase !== 'vote') return;
      return tryResolve(room, true);
    case 'skipVote':
      if (!hostOnly() || room.phase !== 'vote') return;
      room.round++; room.lastElim = null;
      return startDescribe(room);
    case 'guess':
      if (room.phase !== 'whiteguess' || p.id !== room.whiteId) return;
      room.typingId = null;
      return finishGuess(room, clean(m.text, 40));
    case 'next':
      if (!hostOnly() || room.phase !== 'elim') return;
      room.round++; room.undo = null;
      return startDescribe(room);
    case 'push': { // this phone's notification subscription
      const sub = m.sub;
      if (sub && typeof sub.endpoint === 'string' && /^https:\/\//.test(sub.endpoint) && sub.keys && typeof sub.keys.p256dh === 'string' && typeof sub.keys.auth === 'string')
        p.push = { endpoint: sub.endpoint.slice(0, 800), keys: { p256dh: sub.keys.p256dh.slice(0, 200), auth: sub.keys.auth.slice(0, 100) } };
      else p.push = null;
      return;
    }
    case 'vis':
      p.hidden = !!m.hidden;
      return;
    case 'photo': { // session profile photo: kept in memory for this lobby only, never saved
      const d = m.data;
      if (d !== null && (typeof d !== 'string' || !/^data:image\/(jpeg|webp|png);base64,[A-Za-z0-9+/=]+$/.test(d) || d.length > 14000)) return errTo(ws, 'Photo too big');
      if (Date.now() - (p.photoAt || 0) < 2000) return errTo(ws, 'Slow down');
      p.photoAt = Date.now(); p.photo = d || null;
      for (const q of room.players.values()) if (q.ws && q.connected) send(q.ws, { t: 'photo', name: p.name, data: p.photo });
      return;
    }
    case 'whiteTry': { // Mr. White guesses the civilians' word in the middle of a round; everyone sees it
      if (!['describe', 'vote', 'elim'].includes(room.phase) || p.role !== 'white' || !p.alive || !room.pair) return;
      if ((p.wTried || 0) >= (room.settings.whiteTries || 0)) return errTo(ws, 'No guesses left');
      const text = clean(m.text, 40);
      if (!text) return errTo(ws, 'Type your guess');
      p.wTried = (p.wTried || 0) + 1;
      const ok = norm(text) === norm(room.pair.civilian);
      const left = Math.max(0, room.settings.whiteTries - p.wTried);
      for (const q of room.players.values()) if (q.ws && q.connected) send(q.ws, { t: 'wguess', id: p.id, name: p.name, text, ok, left });
      const cm = { sys: true, text: '🎯 ' + p.name + ' (Mr. White) guessed “' + text + '” ' + (ok ? '✓ CORRECT!' : '✗ wrong'), at: Date.now() };
      room.chat = (room.chat || []).concat(cm).slice(-40);
      for (const q of room.players.values()) if (q.ws && q.connected) send(q.ws, { t: 'chat', m: cm });
      if (ok) { room.guess = { by: p.id, text, ok: true, mid: true }; room.undo = null; return endGame(room, 'white'); }
      return broadcast(room);
    }
    case 'ucGuess': { // the voted-out Undercover's private guess
      if (!p.ucOpen || !room.pair || !['describe', 'vote', 'whiteguess', 'elim'].includes(room.phase)) return;
      const text = clean(m.text, 40);
      if (!text) return errTo(ws, 'Type your guess');
      const ok = norm(text) === norm(room.pair.civilian);
      p.ucOpen = false; p.ucRes = { by: p.id, text, ok };
      if (ok) {
        const k = norm(p.name);
        const st = room.stats[k] || (room.stats[k] = { name: p.name, pts: 0, games: 0, wins: 0, imp: 0 });
        st.pts += UC_BONUS;
        if (room.undo && room.undo.id === p.id) room.undo.bonus = k;
      }
      return send(ws, view(room, p));
    }
    case 'abort': // host: stop the round right now and take everyone back to the lobby (no points)
      if (!hostOnly() || !['describe', 'vote', 'whiteguess', 'elim'].includes(room.phase)) return;
      backToLobby(room);
      notice(room, '🛑 Host stopped the round. Back to the lobby');
      return broadcast(room);
    case 'voteAgain': // host: skip the clue round and vote again straight away
      if (!hostOnly() || room.phase !== 'elim') return;
      room.round++; room.undo = null; room.lastElim = null; room.guess = null; room.whiteId = null;
      setPhase(room, 'vote');
      room.votes = {}; room.tie = false;
      return broadcast(room);
    case 'toLobby':
      if (!hostOnly() || room.phase !== 'over') return;
      backToLobby(room);
      return broadcast(room);
    case 'playAgain': {
      if (!hostOnly() || room.phase !== 'over') return;
      backToLobby(room);
      const err = startGame(room, null);
      if (err) { broadcast(room); return errTo(ws, err); }
      return;
    }
    case 'chat': {
      const s = room.settings, now = Date.now();
      if (!s.chat) return errTo(ws, 'Chat is off');
      if (room.game === 'undercover' && !['lobby', 'vote', 'elim', 'over'].includes(room.phase)) return errTo(ws, 'Chat opens during the discussion');
      if (p.watch && room.game === 'undercover' && room.phase !== 'lobby' && room.phase !== 'over') return errTo(ws, '👀 You can see the words, so chat opens for you after this game');
      if (p.muteUntil && p.muteUntil > now) return errTo(ws, '🔇 You are muted for ' + Math.ceil((p.muteUntil - now) / 1000) + 's');
      const wait = (p.lastChat || 0) + s.chatSlow * 1000 - now;
      if (wait > 0) return errTo(ws, '🐢 Slow mode: wait ' + Math.ceil(wait / 1000) + 's');
      const text = clean(m.text, 120);
      if (!text) return;
      if (room.pair && room.phase !== 'over' && room.phase !== 'lobby' && (mentions(text, room.pair.civilian) || mentions(text, room.pair.undercover)))
        return errTo(ws, '🚫 No secret words in chat!');
      p.lastChat = now;
      const msg = { id: p.id, name: p.name, text, at: now };
      room.chat = (room.chat || []).concat(msg).slice(-40);
      for (const q of room.players.values()) if (q.ws && q.connected) send(q.ws, { t: 'chat', m: msg });
      return;
    }
    case 'mute': {
      if (!hostOnly()) return;
      const t = room.players.get(String(m.id));
      if (!t || t.id === p.id) return;
      t.muteUntil = Date.now() + 60000;
      const msg = { sys: true, text: '🔇 ' + t.name + ' is muted for 1 minute', at: Date.now() };
      room.chat = (room.chat || []).concat(msg).slice(-40);
      for (const q of room.players.values()) if (q.ws && q.connected) send(q.ws, { t: 'chat', m: msg });
      return broadcast(room);
    }
    case 'makeHost': {
      if (!hostOnly()) return;
      const t = room.players.get(String(m.id));
      if (!t || t.left || !t.connected || t.id === p.id) return errTo(ws, 'That player is not online');
      room.hostId = room.ownerId = t.id; room.supReq = null;
      notice(room, '👑 ' + t.name + ' is now the host');
      return broadcast(room);
    }
    case 'kick': {
      if (!hostOnly()) return;
      const t = room.players.get(String(m.id));
      if (!t || t.id === p.id) return;
      return removePlayer(room, t, false);
    }
    case 'leave':
      return removePlayer(room, p, true);
    default:
  }
}

wss.on('connection', (ws) => {
  ws.isAlive = true; ws.rl = 0;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => {
    ws.isAlive = true;
    if (++ws.rl > 40) return; // flood guard (reset every 5s)
    let m;
    try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    try { handle(ws, m); } catch (e) { console.error('handler error:', e); }
  });
  ws.on('close', () => {
    const ctx = ws.ctx;
    const room = ctx && rooms.get(ctx.code);
    const p = room && room.players.get(ctx.pid);
    if (p && p.ws === ws) { p.ws = null; p.connected = false; p.discAt = Date.now(); broadcast(room); }
  });
  ws.on('error', () => {});
});

setInterval(() => { for (const c of wss.clients) c.rl = 0; }, 5000);
setInterval(() => { // drop dead sockets so "offline" shows quickly
  for (const c of wss.clients) { if (!c.isAlive) { c.terminate(); continue; } c.isAlive = false; try { c.ping(); } catch (e) { /* ignore */ } }
}, 15000);
setInterval(() => { // housekeeping
  const now = Date.now();
  for (const room of rooms.values()) {
    const host = room.players.get(room.hostId);
    if (host && !host.connected && host.discAt && now - host.discAt > 60000 && transferHost(room)) broadcast(room);
    const anyone = [...room.players.values()].some((p) => p.connected);
    if (!anyone && now - room.touched > 30 * 60000) { clearTimeout(room.timer); rooms.delete(room.code); }
  }
}, 10000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\nUndercover server running on port ${PORT}`);
  console.log(`  This computer:  http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces()))
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) console.log(`  Same Wi-Fi:     http://${a.address}:${PORT}   <- share this with the players`);
  console.log('');
});

module.exports = { server, rooms, broadcast, pickPair, cleanModes, pairKey, COOLDOWN, MEME_SHARE, pickImpostors, spreadOrder };
