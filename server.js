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
function size(n, ar) {
  const [W, H0] = n <= 4 ? [300, 480] : n <= 8 ? [340, 560] : [380, 640];
  let H = H0; // a long pitch: fill the host's phone screen (ar = screen width / height), within sane limits
  if (ar > 0.3 && ar < 1) H = Math.max(H0, Math.min(Math.round(H0 * 1.45), 2 * Math.round((W / ar - 2 * NET) / 2)));
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

const GOLFER = (() => { // the 3D golfer model (optional file)
  const f = [path.join(__dirname, 'public', 'golfer.json'), path.join(__dirname, 'golfer.json')].find((x) => fs.existsSync(x));
  if (!f) return null; const raw = fs.readFileSync(f); return { raw, gz: zlib.gzipSync(raw, { level: 6 }) };
})();
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
  if (url === '/golfer.json') {
    if (!GOLFER) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Upload golfer.json next to index.html'); }
    const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || ''), headers = { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=604800', Vary: 'Accept-Encoding' };
    if (gz) headers['Content-Encoding'] = 'gzip';
    res.writeHead(200, headers); return res.end(gz ? GOLFER.gz : GOLFER.raw);
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
function okPhoto(d) { return typeof d === 'string' && d.length <= 16000 && /^data:image\/(jpeg|webp|png);base64,[A-Za-z0-9+/=]+$/.test(d); }
function openList() { // rooms that appear on the main page
  const out = [];
  for (const r of rooms.values()) {
    if (r.open === false || r.phase !== 'lobby') continue;
    const n = [...r.players.values()].filter((q) => !q.left).length;
    const hp = r.players.get(r.hostId);
    if (n >= MAX_PLAYERS || !hp || !hp.connected || hp.left) continue; // host gone/offline: not joinable
    out.push({ code: r.code, game: r.game, host: hp.name, photo: hp.photo || null, n, max: MAX_PLAYERS });
    if (out.length >= 20) break;
  }
  return out;
}
function dropReq(room, r, msg) { // forget a join request (declined, cancelled, timed out)
  clearTimeout(r.tm);
  if (room) room.pending.delete(r.id);
  if (r.ws && r.ws.pend === r) r.ws.pend = null;
  if (msg && r.ws && r.ws.readyState === 1) send(r.ws, { t: 'reqres', ok: false, msg });
  if (room && rooms.get(room.code) === room) broadcast(room);
}
// ---------------------------------------------------------------- Gully Cricket (2 to 8 players)
// Field units: batter at (0,0), bowler's end at (0,22), boundary circle radius CK_R around the batter.
// Angle th in degrees: 0 = straight back past the bowler, +90 = off side, -90 = leg side, +-180 = behind the keeper.
const CK_R = 60;
const CK_SPOT = { cover: [55, 33], midwicket: [-58, 31], midoff: [18, 33], point: [96, 29], midon: [-18, 33], sqleg: [-100, 27], slip: [150, 10], longoff: [24, 54], longon: [-24, 54], deepcover: [64, 54], deepmid: [-64, 54], fineleg: [-148, 42], third: [128, 50] };
const CK_ORDER = ['cover', 'midwicket', 'midoff', 'point', 'midon', 'sqleg', 'slip', 'longoff', 'longon', 'deepcover', 'deepmid', 'fineleg', 'third'];
const CK_BUILD = [-122, -58]; // the building on the leg side: a six into it is OUT (gully rule)
const ckP = (deg, r) => { const a = deg * Math.PI / 180; return [Math.round(Math.sin(a) * r * 10) / 10, Math.round(Math.cos(a) * r * 10) / 10]; };
const ckD = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const ckRnd = (a, b) => a + Math.random() * (b - a);
const ckPick = (a) => a[Math.floor(Math.random() * a.length)];

function ckSched(room, ms, fn) { clearTimeout(room.timer); room.seq++; schedule(room, ms, fn); }
function ckOn(room, id) { const q = room.players.get(id); return !!(q && !q.left); }
function ckLive(room, id) { const q = room.players.get(id); return !!(q && !q.left && q.connected); }
function ckName(room, id) { const q = room.players.get(id); return q ? q.name : 'Someone'; }

function ckTeams(room) { // lobby teams: everybody always has a team; newcomers go to the smaller side
  const t = room.ckTeam || (room.ckTeam = {});
  const ps = [...room.players.values()].filter((p) => !p.left);
  for (const id of Object.keys(t)) if (!ps.some((p) => p.id === id)) delete t[id];
  for (const p of ps) if (t[p.id] !== 0 && t[p.id] !== 1) {
    const n0 = ps.filter((q) => t[q.id] === 0).length, n1 = ps.filter((q) => t[q.id] === 1).length;
    t[p.id] = n0 <= n1 ? 0 : 1;
  }
  return t;
}
function ckShuffle(room) {
  const ps = shuffle([...room.players.values()].filter((p) => !p.left));
  room.ckTeam = {}; ps.forEach((p, i) => { room.ckTeam[p.id] = i % 2; });
}

function ckStart(room) {
  const cands = [...room.players.values()].filter((p) => !p.left && p.connected);
  if (cands.length < 2) return 'Need at least 2 players';
  const set = room.ckSet;
  let sel = cands.slice(0, 8);
  for (const p of room.players.values()) p.watch = false;
  for (const p of cands) if (!sel.includes(p)) p.watch = true;
  const ids = sel.map((p) => p.id), inns = [];
  let teams = null, common = null;
  if (set.mode === 'team') {
    const t = ckTeams(room);
    teams = [ids.filter((id) => t[id] === 0), ids.filter((id) => t[id] === 1)];
    if (!teams[0].length || !teams[1].length) return 'Both teams need at least 1 player';
    if (ids.length % 2 === 1 && Math.abs(teams[0].length - teams[1].length) === 1 && ids.length >= 3) { // odd number: the common player plays for both sides
      const big = teams[0].length > teams[1].length ? 0 : 1;
      common = teams[big][teams[big].length - 1]; teams[big] = teams[big].slice(0, -1);
    }
    const first = Math.random() < 0.5 ? 0 : 1;
    for (const k of [first, 1 - first]) {
      const bat = shuffle(teams[k].slice()); if (common) bat.push(common);
      const fld = teams[1 - k].slice(); if (common) fld.push(common);
      inns.push({ team: k, bat, fld, r: 0, w: 0, b: 0, ex: 0, maxW: bat.length, overs: [[]] });
    }
  } else { // everyone for themselves: each player bats their own innings (2 lives) against everybody else
    for (const id of shuffle(ids.slice())) inns.push({ team: null, bat: [id], fld: ids.filter((x) => x !== id), r: 0, w: 0, b: 0, ex: 0, maxW: 2, overs: [[]] });
  }
  const stats = {}; for (const id of ids) stats[id] = { r: 0, b: 0, f: 0, s: 0, w: 0, c: 0, ro: 0, st: 0 };
  room.ckGid = (room.ckGid || 0) + 1;
  room.ck = { gid: room.ckGid, mode: set.mode, ids, teams, common, overs: set.overs, building: !!set.building, onetip: !!set.onetip,
    inns, inn: -1, striker: null, sw: 0, bowler: null, lastBowler: null, keeper: null, field: {}, target: null,
    del: null, seg: null, segN: 0, ch: null, chN: 0, chFn: null, step: null, ballN: 0, ev: 0, last: null, log: [], stats,
    banner: null, winner: null, mom: null };
  for (const p of sel) notify(room, p, '🏏 Gully Cricket started', 'Open the game and play!', [100, 60, 100]);
  ckInn(room);
  return null;
}

function ckInn(room) { // start the next innings
  const c = room.ck; c.inn++;
  const I = c.inns[c.inn];
  I.bat = I.bat.filter((id) => ckOn(room, id)); I.maxW = Math.max(1, c.mode === 'team' ? I.bat.length : 2);
  c.sw = 0; c.striker = I.bat[0]; c.lastBowler = null; c.field = {}; c.del = null; c.seg = null; c.ch = null; c.step = null;
  const bn = c.mode === 'team' ? (I.team === 0 ? 'Team Red' : 'Team Blue') : ckName(room, c.striker);
  c.banner = c.mode === 'team'
    ? (c.inn === 0 ? bn + ' won the toss and will bat first!' : bn + ' need ' + c.target + ' to win in ' + c.overs + (c.overs > 1 ? ' overs' : ' over'))
    : bn + ' is batting' + (c.inn ? ' · score to beat: ' + Math.max(...c.inns.slice(0, c.inn).map((x) => x.r)) : '');
  setPhase(room, 'cintro');
  schedule(room, 3600, () => ckOver(room));
  broadcast(room);
}

function ckFielders(room) { // everybody on the fielding side who is still here, minus the batter
  const c = room.ck, I = c.inns[c.inn];
  return I.fld.filter((id) => ckOn(room, id) && id !== c.striker);
}
function ckOver(room) { // a new over: pick the bowler and keeper, then set the field
  const c = room.ck, I = c.inns[c.inn];
  if (I.overs[I.overs.length - 1].length) I.overs.push([]);
  const f = ckFielders(room);
  if (!f.length) return ckEnd(room);
  const live = f.filter((id) => ckLive(room, id));
  const pool = (live.length ? live : f).filter((id) => id !== c.lastBowler);
  const ov = I.overs.length - 1;
  c.bowler = (pool.length ? pool : f)[ov % (pool.length || f.length)];
  c.lastBowler = c.bowler;
  const rest = f.filter((id) => id !== c.bowler);
  c.keeper = rest.find((id) => id === c.keeper) || rest[0] || null;
  const used = new Set();
  const newField = {};
  for (const id of rest) {
    if (id === c.keeper) continue;
    if (c.field[id]) { newField[id] = c.field[id]; continue; }
    const spot = CK_ORDER.find((s) => !used.has(s) && !Object.values(newField).some((p) => p.s === s)) || 'cover';
    used.add(spot); const pp = ckP(CK_SPOT[spot][0], CK_SPOT[spot][1]); newField[id] = { x: pp[0], y: pp[1], s: spot };
  }
  c.field = newField;
  c.banner = null;
  setPhase(room, 'cfield');
  schedule(room, Object.keys(newField).length ? 9000 : 1200, () => ckBowlPhase(room));
  broadcast(room);
}
function ckBowlPhase(room) {
  const c = room.ck; c.step = null; c.ch = null; c.seg = null;
  setPhase(room, 'cbowl');
  schedule(room, ckLive(room, c.bowler) ? 15000 : 2200, () => ckDeliver(room, null));
  broadcast(room);
}
function ckDeliver(room, b) { // the bowler let it go (or the timer did)
  const c = room.ck; if (!c || room.phase !== 'cbowl') return;
  const I = c.inns[c.inn];
  if (!b) b = { line: ckPick([-1, 0, 0, 1]), len: ckPick([0, 1, 2, 2, 3]), spin: Math.random() < 0.4, pw: ckRnd(0.3, 0.75) };
  const pw = Math.max(0, Math.min(1, Number(b.pw) || 0));
  const line = [-1, 0, 1].includes(Number(b.line)) ? Number(b.line) : 0, len = [0, 1, 2, 3].includes(Number(b.len)) ? Number(b.len) : 2, spin = !!b.spin;
  if (pw > 0.86 && Math.random() < 0.42) { // red zone: too hard, sprays wide
    I.r += 1; I.ex += 1; I.overs[I.overs.length - 1].push('wd');
    return ckResult(room, { k: 'wd', runs: 1, txt: ckPick(['WIDE! Too much pace, no control.', 'Wide ball! The bowler went for too much.', 'Sprayed down the leg side. WIDE.']) }, true);
  }
  let wob = 0; if (pw > 0.66) wob = ckRnd(-0.35, 0.35); // orange zone: a bit less accurate
  const turn = spin ? ckRnd(0.25, 0.75) * (Math.random() < 0.5 ? -1 : 1) : 0;
  const fl = Math.round(spin ? 1300 - 300 * pw : 1060 - 430 * pw);
  c.ballN++;
  c.del = { n: c.ballN, line: Math.round((line + wob) * 100) / 100, len, spin, pw: Math.round(pw * 100) / 100, turn: Math.round(turn * 100) / 100, fl, lead: 1500, by: c.bowler };
  c.lock = null;
  c.step = 'bat'; c.seg = null; c.ch = null;
  setPhase(room, 'cplay');
  schedule(room, c.del.lead + fl + (ckLive(room, c.striker) ? 180 : 300), () => ckShot(room, ckLive(room, c.striker) ? ckLockShot(c) : ckBotShot()));
  broadcast(room);
}
function ckLockShot(c) { // easy mode: the batter locked a shot earlier; the game times the swing for them
  const L = c.lock; c.lock = null; if (!L) return null;
  return { e: Math.random() < 0.3 ? ckRnd(-148, 148) : ckRnd(-105, 105), th: L.th, s: L.s, loft: L.loft, def: L.def };
}
function ckBotShot() { return { e: ckRnd(-160, 160), th: ckRnd(-110, 110), s: ckRnd(0.3, 0.9), loft: Math.random() < 0.3, def: Math.random() < 0.2 }; }

function ckFly(c, a, b, air, ms, k) { c.seg = { i: ++c.segN, a, b, air: !!air, ms: Math.round(ms), k: k || null, at: Date.now() }; }

// a fielder gets a quick tap challenge; fn(ok) decides what happens next
function ckChallenge(room, k, id, ms, diff, fn) {
  const c = room.ck;
  c.ch = { k, id, ms: Math.round(ms), diff: Math.round(Math.max(0, Math.min(1, diff)) * 100) / 100, n: ++c.chN };
  c.chFn = fn; c.step = 'ch';
  if (ckLive(room, id)) ckSched(room, ms + 1600, () => ckChRes(room, c.ch.n, false));
  else ckSched(room, ms + 200, () => ckChRes(room, c.ch.n, Math.random() < 0.65 - 0.4 * c.ch.diff)); // away: the game guesses
  broadcast(room);
}
function ckChRes(room, n, ok) {
  const c = room.ck; if (!c || !c.ch || c.ch.n !== n) return;
  const fn = c.chFn; c.chFn = null; c.ch = null; c.step = null;
  fn(!!ok);
}

function ckShot(room, sh) { // the batter swung (sh) or didn't (null)
  const c = room.ck; if (!c || c.step !== 'bat') return;
  c.step = null; clearTimeout(room.timer);
  const d = c.del, I = c.inns[c.inn];
  const st = c.stats[c.striker]; if (st) st.b++;
  const effLine = d.line + (d.spin ? d.turn : 0);
  const onStumps = Math.abs(effLine) < 0.6 && d.len !== 3;
  const miss = !sh || Math.abs(sh.e) > 150;
  if (miss) {
    if (onStumps && Math.random() < 0.9) return ckOut(room, 'bowled', c.bowler, null, ckPick(['BOWLED HIM! Stumps everywhere!', 'Timber! Clean bowled.', 'Through the gate and OUT!']));
    const kp = c.keeper && ckOn(room, c.keeper) ? c.keeper : null;
    const stumpy = !!(sh && sh.loft);
    if (!kp) return ckRuns(room, d.spin ? 0 : 1, { k: d.spin ? '.' : 'b', txt: d.spin ? 'Beaten! Dot ball.' : 'Beaten, and they sneak a bye.' }, d.spin ? 0 : 1);
    ckFly(c, [d.line * 1.2, 0], [0, -6], false, 260);
    return ckChallenge(room, stumpy ? 'stump' : 'keep', kp, 900, stumpy ? 0.45 : 0.25, (ok) => {
      if (ok && stumpy) return ckOut(room, 'stumped', c.bowler, kp, 'Stepped out, missed it, and STUMPED by ' + ckName(room, kp) + '!');
      if (ok) return ckRuns(room, 0, { k: '.', txt: ckPick(['Beaten! Good take by the keeper.', 'Played and missed. Dot ball.', 'Past the bat, safe in the gloves.']) });
      const by = d.pw > 0.8 && !d.spin ? 4 : 1;
      return ckRuns(room, by, { k: 'b', txt: by === 4 ? 'The keeper fumbles it, four byes!' : 'Keeper misses it, they run a bye.' }, by);
    });
  }
  const e = Math.max(-150, Math.min(150, Number(sh.e) || 0)), q = Math.max(0, 1 - Math.abs(e) / 110), s = Math.max(0, Math.min(1, Number(sh.s) || 0));
  const qWord = Math.abs(e) < 40 ? 'perfect' : Math.abs(e) < 90 ? 'good' : 'edge';
  if (Math.abs(e) > 110) { // got an edge
    const th = (e > 0 ? 1 : -1) * ckRnd(140, 168);
    if (Math.random() < 0.6) return ckAir(room, th, ckRnd(12, 26), 'edge');
    return ckGround(room, th, 0, ckRnd(20, 64), 'edge');
  }
  if (sh.def) { ckFly(c, [0, 0], ckP(ckRnd(-30, 30), 4), false, 450); return ckRuns(room, 0, { k: '.', txt: ckPick(['Solid defence. Dead bat.', 'Blocked. Nothing doing.', 'Respect for that one, defended.']) }); }
  let th = Math.max(-140, Math.min(140, Number(sh.th) || 0)) + e * 0.25; // early pulls it leg side, late pushes it off side
  th = Math.max(-150, Math.min(150, th));
  let qq = q;
  if (d.len === 0 && sh.loft) qq *= 0.6; // hard to loft a yorker
  if (d.len === 3 && th < -30 && th > -130) qq = Math.min(1, qq * 1.15); // short ball: pull it!
  const pace = d.spin ? 1 : 1 + 0.15 * d.pw;
  if (sh.loft) return ckAir(room, th, (22 + 57 * s) * (0.32 + 0.68 * qq) * pace, qWord);
  return ckGround(room, th, 0, (18 + 58 * s) * (0.4 + 0.6 * qq) * pace, qWord);
}

function ckCatchers(room) { // everyone who can catch: field + keeper + bowler (from where they stand after bowling)
  const c = room.ck, out = [];
  for (const id of Object.keys(c.field)) if (ckOn(room, id)) out.push([id, [c.field[id].x, c.field[id].y]]);
  if (c.keeper && ckOn(room, c.keeper)) out.push([c.keeper, [0, -6]]);
  if (c.bowler && ckOn(room, c.bowler)) out.push([c.bowler, [0, 18]]);
  return out;
}
function ckAir(room, th, D, q) { // a lofted hit (or an edge in the air)
  const c = room.ck;
  const big = D >= CK_R, P = ckP(th, big ? CK_R - 1 : D);
  let best = null;
  for (const [id, pos] of ckCatchers(room)) { const dd = ckD(pos, P); if (!best || dd < best[1]) best = [id, dd, pos]; }
  const tf = 420 + Math.hypot(P[0], P[1]) * 15;
  const intoBuilding = c.building && big && th > CK_BUILD[0] && th < CK_BUILD[1];
  const landOrSix = () => {
    if (big) {
      ckFly(c, P, ckP(th, CK_R + 10), true, 500, 'six');
      if (intoBuilding) return ckOut(room, 'building', null, null, ckPick(['Huge hit... straight into the building! Gully rule: OUT!', 'Into Sharma uncle’s balcony. That is OUT!']));
      return ckRuns(room, 6, { k: '6', txt: ckPick(['SIX! That’s gone into the next street!', 'MASSIVE! Six runs!', 'Out of the gully! SIX!']) });
    }
    // lands in the field: one-tip-one-hand chance for whoever is closest to the bounce
    let tip = null;
    if (c.onetip) for (const [id, pos] of ckCatchers(room)) { const dd = ckD(pos, P); if (dd < 9 && (!tip || dd < tip[1])) tip = [id, dd]; }
    if (tip) {
      const L2 = ckP(th, Math.min(CK_R, D * 1.18));
      ckFly(c, P, L2, false, 420, 'tip');
      return ckChallenge(room, 'tip', tip[0], 650, 0.55 + 0.4 * tip[1] / 9, (ok) => {
        if (ok) return ckOut(room, 'caught', c.bowler, tip[0], 'ONE TIP ONE HAND! ' + ckName(room, tip[0]) + ' takes it after the bounce. OUT!');
        return ckGround(room, th, D, D * 1.25, 'rolled');
      });
    }
    return ckGround(room, th, D, D * 1.25, 'rolled');
  };
  if (best && best[1] < 11) {
    ckFly(c, [0, 0], P, true, tf, 'air');
    const who = best[0];
    return ckChallenge(room, 'catch', who, tf, best[1] / 11, (ok) => {
      if (ok) return ckOut(room, 'caught', c.bowler, who, (best[1] > 7 ? 'WHAT A DIVE! ' : '') + 'Caught by ' + ckName(room, who) + '! OUT!');
      c.drops = (c.drops || 0) + 1; c.lastDrop = ckName(room, who);
      if (big && !intoBuilding) { ckFly(c, P, ckP(th, CK_R + 10), true, 450, 'six'); return ckRuns(room, 6, { k: '6', txt: 'Dropped by ' + ckName(room, who) + ' and it goes for SIX!' }); }
      if (big && intoBuilding) { ckFly(c, P, ckP(th, CK_R + 10), true, 450, 'six'); return ckOut(room, 'building', null, null, 'Dropped... but it lands in the building. Gully rule: OUT!'); }
      return ckGround(room, th, D, D * 1.2, 'dropped');
    });
  }
  ckFly(c, [0, 0], P, true, tf, 'air');
  ckSched(room, tf, landOrSix);
  broadcast(room);
}
function ckGround(room, th, r0, D, q) { // the ball runs along the ground from radius r0
  const c = room.ck;
  const end = Math.min(D, CK_R);
  let best = null;
  for (const [id, pos] of ckCatchers(room)) {
    const a = th * Math.PI / 180, ux = Math.sin(a), uy = Math.cos(a);
    const t = pos[0] * ux + pos[1] * uy, dp = Math.abs(pos[0] * uy - pos[1] * ux);
    if (t <= r0 + 1 || t > end + 4) continue;
    const reach = 5 + t * 0.12;
    if (dp < reach && (!best || t < best[1])) best = [id, t, dp / reach];
  }
  const from = ckP(th, r0);
  const runsFor = (dist) => (dist < 14 ? 0 : dist < 30 ? 1 : dist < 46 ? 2 : 3);
  if (best) {
    const [who, t, diff] = best, at = ckP(th, t);
    ckFly(c, from, at, false, 260 + (t - r0) * 15, 'roll');
    return ckChallenge(room, 'stop', who, 260 + (t - r0) * 15, diff, (ok) => {
      if (ok) {
        const runs = runsFor(t);
        if (!runs) return ckRuns(room, 0, { k: '.', txt: 'Stopped by ' + ckName(room, who) + '. No run.' });
        if (runs === 1 && Math.random() < 0.65) return ckRuns(room, 1, { k: '1', txt: 'Fielded by ' + ckName(room, who) + '. Easy single.' });
        return ckThrow(room, who, at, runs, 'Fielded by ' + ckName(room, who) + ', they push for ' + (runs === 1 ? 'a quick single!' : 'run number ' + runs + '!'));
      }
      if (D >= CK_R) { ckFly(c, at, ckP(th, CK_R + 4), false, 380, 'four'); return ckRuns(room, 4, { k: '4', txt: 'Misfield by ' + ckName(room, who) + '! Races away for FOUR!' }); }
      const stop = ckP(th, D); ckFly(c, at, stop, false, 300 + (D - t) * 12, 'roll');
      return ckChaseThrow(room, stop, runsFor(D) + 1, 'Through ' + ckName(room, who) + '’s legs!');
    });
  }
  if (D >= CK_R) { ckFly(c, from, ckP(th, CK_R + 4), false, 260 + (CK_R - r0) * 13, 'four'); return ckRuns(room, 4, { k: '4', txt: ckPick(['FOUR! Into the gap, nobody there.', 'Cracking shot, FOUR runs!', 'Bisects the field. FOUR!']) }); }
  const stop = ckP(th, D); ckFly(c, from, stop, false, 260 + (D - r0) * 14, 'roll');
  return ckChaseThrow(room, stop, Math.max(1, runsFor(D)), null);
}
function ckChaseThrow(room, stop, runs, pre) { // nobody stopped it: the nearest fielder runs to it and throws
  const c = room.ck;
  let best = null; for (const [id, pos] of ckCatchers(room)) { if (id === c.keeper && ckCatchers(room).length > 1) continue; const dd = ckD(pos, stop); if (!best || dd < best[1]) best = [id, dd]; }
  if (!best || runs < 2 || Math.random() < 0.5) { ckSched(room, (c.seg ? Math.max(0, c.seg.at + c.seg.ms - Date.now()) : 400), () => ckRuns(room, runs, { k: String(runs), txt: (pre ? pre + ' ' : '') + (runs === 1 ? 'Pushed for a single.' : runs + ' runs, good running!') })); return broadcast(room); }
  ckSched(room, (c.seg ? Math.max(0, c.seg.at + c.seg.ms - Date.now()) : 400), () => ckThrow(room, best[0], stop, runs, pre));
  broadcast(room);
}
function ckThrow(room, who, at, runs, pre) { // they go for the last run; the fielder throws at the stumps
  const c = room.ck;
  const dist = Math.hypot(at[0], at[1]);
  c.seg = null;
  return ckChallenge(room, 'throw', who, 1700, Math.min(1, dist / 60), (ok) => {
    ckFly(c, at, [0, -0.5], dist > 30, 220 + dist * 8, ok ? 'hit' : 'miss');
    const close = Math.random() < 0.75 - dist / 120; // a direct hit only gets them if they were short
    if (ok && !close) return ckRuns(room, runs, { k: String(runs), txt: (pre ? pre + ' ' : '') + 'Direct hit by ' + ckName(room, who) + '... but they made it in time!' });
    if (ok) return ckOut(room, 'runout', null, who, (pre ? pre + ' ' : '') + 'Direct hit by ' + ckName(room, who) + '! RUN OUT going for ' + (runs === 1 ? 'the single' : 'run number ' + runs) + '!', runs - 1);
    return ckRuns(room, runs, { k: String(runs), txt: (pre ? pre + ' ' : '') + 'The throw misses! They complete ' + runs + (runs === 1 ? ' run.' : ' runs.') });
  });
}

function ckRuns(room, runs, info, byes) { // a legal ball with runs (no wicket)
  const c = room.ck, I = c.inns[c.inn], st = c.stats[c.striker];
  I.r += runs; I.b++;
  if (byes) I.ex += byes; else if (st) { st.r += runs; if (runs === 4) st.f++; if (runs === 6) st.s++; }
  I.overs[I.overs.length - 1].push(info.k === '.' || runs === 0 ? '0' : info.k === 'b' ? runs + 'b' : String(runs));
  return ckResult(room, { k: info.k, runs, txt: info.txt }, false);
}
function ckOut(room, how, bowlerId, fielderId, txt, runsDone) { // a wicket
  const c = room.ck, I = c.inns[c.inn];
  const r = runsDone || 0;
  I.r += r; I.b++; I.w++;
  const st = c.stats[c.striker]; if (st) st.r += r;
  if (bowlerId && how !== 'runout' && c.stats[bowlerId]) c.stats[bowlerId].w++;
  if (fielderId && c.stats[fielderId]) { if (how === 'caught') c.stats[fielderId].c++; if (how === 'runout') c.stats[fielderId].ro++; if (how === 'stumped') c.stats[fielderId].st++; }
  I.overs[I.overs.length - 1].push('W');
  return ckResult(room, { k: 'W', how, runs: r, out: c.striker, fielder: fielderId || null, txt }, false);
}
function ckResult(room, res, again) {
  const c = room.ck;
  c.ev++; c.last = Object.assign({ i: c.ev, batter: c.striker, bowler: c.bowler }, res);
  c.log = c.log.concat([{ i: c.ev, txt: res.txt, k: res.k }]).slice(-5);
  c.step = 'res'; c.ch = null;
  const slow = res.k === '6' || res.k === 'W';
  const segLeft = c.seg ? Math.max(0, c.seg.at + c.seg.ms - Date.now()) : 0;
  if (room.phase !== 'cplay') setPhase(room, 'cplay');
  ckSched(room, segLeft + (slow ? 3600 : res.k === 'wd' ? 1400 : 2200), () => (again ? ckBowlPhase(room) : ckNext(room)));
  broadcast(room);
}
function ckNext(room) { // after each ball: innings over? next batter? next over?
  const c = room.ck, I = c.inns[c.inn];
  const chased = c.mode === 'team' && c.inn === 1 && I.r >= c.target;
  if (I.w >= I.maxW || I.b >= c.overs * 6 || chased || !ckFielders(room).length) {
    if (c.mode === 'team' && c.inn === 0) {
      c.target = I.r + 1;
      c.banner = (I.team === 0 ? 'Team Red' : 'Team Blue') + ' made ' + I.r + '/' + I.w + '. Target: ' + c.target;
      setPhase(room, 'cbreak'); schedule(room, 4500, () => ckInn(room)); return broadcast(room);
    }
    if (c.mode === 'solo' && c.inn < c.inns.length - 1) {
      c.banner = ckName(room, I.bat[0]) + ' scored ' + I.r + (I.w ? ' (out ' + I.w + 'x)' : ' not out');
      setPhase(room, 'cbreak'); schedule(room, 3500, () => ckInn(room)); return broadcast(room);
    }
    return ckEnd(room);
  }
  const last = c.last;
  if (last && last.k === 'W') { // next batter in
    c.sw++;
    const nb = I.bat.slice(c.sw).find((id) => ckOn(room, id));
    if (c.mode === 'solo') c.striker = I.bat[0]; else if (nb) c.striker = nb; else return ckEnd(room);
  }
  if (I.b > 0 && I.b % 6 === 0 && I.overs[I.overs.length - 1].filter((x) => x !== 'wd').length >= 6) return ckOver(room);
  return ckBowlPhase(room);
}
function ckEnd(room) {
  const c = room.ck;
  if (c.mode === 'team') {
    const a = c.inns[0], b = c.inns[1];
    if (!b || b.r < a.r) c.winner = { team: a.team, txt: (a.team === 0 ? 'Team Red' : 'Team Blue') + ' win by ' + (a.r - (b ? b.r : 0)) + (a.r - (b ? b.r : 0) === 1 ? ' run!' : ' runs!') };
    else if (b.r > a.r) c.winner = { team: b.team, txt: (b.team === 0 ? 'Team Red' : 'Team Blue') + ' win by ' + Math.max(1, b.maxW - b.w) + ' wicket' + (b.maxW - b.w === 1 ? '' : 's') + '!' };
    else c.winner = { team: null, txt: 'It’s a TIE! What a game!' };
  } else {
    const top = Math.max(...c.inns.map((x) => x.r));
    const ws = c.inns.filter((x) => x.r === top).map((x) => x.bat[0]);
    c.winner = { ids: ws, txt: ws.map((id) => ckName(room, id)).join(' & ') + (ws.length > 1 ? ' tie' : ' wins') + ' with ' + top + ' runs!' };
  }
  let mom = null, best = -1;
  for (const id of c.ids) { const s = c.stats[id]; if (!s || !ckOn(room, id)) continue; const pts = s.r + s.f + 2 * s.s + 20 * s.w + 12 * (s.c + s.ro + s.st); if (pts > best) { best = pts; mom = id; } }
  c.mom = mom; c.step = null; c.ch = null;
  setPhase(room, 'cover');
  broadcast(room);
}
function ckBack(room) {
  setPhase(room, 'lobby'); room.ck = null;
  for (const [id, p] of room.players) if (p.left) room.players.delete(id);
  for (const p of room.players.values()) p.watch = false;
  broadcast(room);
}
function ckCheck(room) { // someone left mid-game
  const c = room.ck; if (!c || !['cintro', 'cfield', 'cbowl', 'cplay', 'cbreak'].includes(room.phase)) return broadcast(room);
  if (c.ids.filter((id) => ckOn(room, id)).length < 2) return ckEnd(room);
  if (c.ch && !ckOn(room, c.ch.id)) return ckChRes(room, c.ch.n, false);
  if (!ckOn(room, c.striker) && c.step !== 'res' && room.phase !== 'cintro' && room.phase !== 'cbreak') {
    c.inns[c.inn].maxW = Math.max(c.inns[c.inn].w + 1, c.inns[c.inn].maxW);
    return ckOut(room, 'retired', null, null, ckName(room, c.striker) + ' left the game. Next batter!');
  }
  if (!ckOn(room, c.bowler) && (room.phase === 'cbowl' || room.phase === 'cfield')) { c.lastBowler = null; return ckOver(room); }
  broadcast(room);
}
function ckView(room, p) {
  const c = room.ck; if (!c) return null;
  return { gid: c.gid, mode: c.mode, ids: c.ids, teams: c.teams, common: c.common, overs: c.overs, building: c.building, onetip: c.onetip,
    inns: c.inns.map((I) => ({ team: I.team, bat: I.bat, r: I.r, w: I.w, b: I.b, ex: I.ex, maxW: I.maxW, ov: I.overs.slice(-1)[0] })), inn: c.inn,
    striker: c.striker, bowler: c.bowler, keeper: c.keeper, field: c.field, target: c.target, del: c.del, seg: c.seg, ch: c.ch, step: c.step,
    ballN: c.ballN, ev: c.ev, last: c.last, log: c.log, stats: c.stats, banner: c.banner, winner: c.winner, mom: c.mom, build: CK_BUILD, R: CK_R };
}

function makeRoom(words) {
  const room = {
    code: newCode(), hostId: null, supervisorId: null, players: new Map(),
    game: 'undercover', dwSet: { rounds: 3, secs: 80, hints: 2 }, dw: null, gfSet: { holes: 3, secs: 8 }, gf: null, unSet: { secs: 20, mode: 'classic' }, un: null, ckSet: { mode: 'team', overs: 2, building: true, onetip: true }, ck: null, ckTeam: {}, fbSet: { goals: 3, secs: 8, mode: 'match', tie: 'pens' }, fb: null, rc: null,
    open: true, pending: new Map(), blocked: new Set(), cool: new Map(),
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
    open: room.open !== false,
    voice: [...room.players.values()].filter((q) => q.voice && q.connected && !q.left).map((q) => q.id),
  };
  if (p.id === room.hostId && room.phase === 'lobby' && room.pending.size) v.reqs = [...room.pending.values()].map((r) => ({ id: r.id, name: r.name, photo: r.photo }));
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
        goals: f.goals, aimed: Object.keys(f.aims), winner: f.winner, last: f.last, lastTurn: f.lastTurn, paused: f.paused ? 1 : 0 };
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
      const hand = u.hands[id] || [], mine = curId === id && room.phase === 'uturn';
      const ok = []; if (mine) hand.forEach((c, i) => { if ((u.drew === null || u.drew === i) && uCan(u, c)) ok.push(i); });
      v.un = { gid: u.gid, mode: u.mode, side: u.side, ids: u.ids, counts, hand, ok, mv: uMultiVals(u), owe: !!u.calls[id], out: u.out || [], top: u.top, color: u.color, dir: u.dir, cur: curId, pend: u.pend, fin: u.fin, paused: u.paused ? u.paused.left || 1 : 0,
        drew: curId === id ? u.drew : null, pile: u.draw.length, disc: u.disc.length, ev: u.ev, last: u.last, log: u.log || [], winner: u.winner, ranks: u.ranks, resh: u.resh || 0 };
    }
  }
  if (room.game === 'cricket') { v.ckSet = room.ckSet; v.ckTeam = ckTeams(room); v.ck = ckView(room, p); }
  if (room.game === 'draw') { v.dwSet = room.dwSet; if (room.dw) v.dw = dwView(room, p); }
  if (room.game === 'golf') { v.gfSet = room.gfSet; if (room.gf) v.gf = gfView(room); }
  if (room.game === 'race' && room.rc) {
    const r = room.rc;
    v.rc = { ids: r.ids, startAt: r.startAt, laps: RACE_LAPS, fin: r.fin, results: r.results, rank: raceRank(room) };
  }
  if (room.game === 'race') { v.rcSet = room.rcSet || { map: 'beach' };
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
function fbStart(room, ar) {
  const cands = [...room.players.values()].filter((p) => !p.left);
  if (cands.length < 1) return 'Need at least 1 player';
  const sel = shuffle(cands.filter((p) => p.connected)).slice(0, FB_MAX);
  if (sel.length < 1) return 'Need at least 1 player online';
  for (const p of room.players.values()) p.watch = false;
  const ids = sel.map((p) => p.id), team = {};
  ids.forEach((id, i) => { team[id] = i % 2; });
  for (const p of cands) if (!ids.includes(p.id)) p.watch = true;
  const sz = FB.size(ids.length, Number(ar) || 0);
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
// Card = colour letter + value. A Flip card has two faces joined with "~": light~dark (for example "R5~P3").
// Classic: R/Y/G/B 0-9, s skip, r reverse, d +2; wilds Xw (wild) and Xf (+4).
// Flip: light R/Y/G/B (1-9, o draw 1, s, r, l flip, Xw, Xt wild +2); dark P/T/V/O (1-9, v draw 5, k skip everyone, r, l, Xw, Xc wild draw colour).
// No Mercy: R/Y/G/B 0-9, s, r, d +2, q +4, a discard all, k skip everyone; wilds Xy reverse +4, Xh +6, Xj +10, Xu colour roulette.
const U_MODES = ['classic', 'flip', 'mercy'];
const U_ORD = { 0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, s: 10, r: 11, o: 12, d: 12, v: 12, q: 13, k: 14, a: 15, l: 16, w: 20, f: 21, t: 21, c: 22, y: 23, h: 24, j: 25, u: 26 };
const U_COL = { R: 0, Y: 1, G: 2, B: 3, P: 0, T: 1, V: 2, O: 3, X: 4 };
const U_DV = { classic: { d: 2, f: 4 }, mercy: { d: 2, q: 4, y: 4, h: 6, j: 10 }, flipL: { o: 1, t: 2 }, flipD: { v: 5 } };
const U_CAP = 25;
const uF = (u, c) => { const i = c.indexOf('~'); return i < 0 ? c : (u.side === 'D' ? c.slice(i + 1) : c.slice(0, i)); };
const uNumF = (f) => f[1] >= '0' && f[1] <= '9';
const uCols = (u) => (u.mode === 'flip' && u.side === 'D' ? ['P', 'T', 'V', 'O'] : ['R', 'Y', 'G', 'B']);
const uDv = (u, f) => (U_DV[u.mode === 'flip' ? 'flip' + u.side : u.mode] || {})[f[1]] || 0;
function uDeck(mode, decks) {
  const d = [];
  for (let k = 0; k < decks; k++) {
    if (mode === 'flip') {
      const L = [], D = [];
      for (const c of ['R', 'Y', 'G', 'B']) { for (let n = 1; n <= 9; n++) L.push(c + n, c + n); for (const sp of ['o', 's', 'r', 'l']) L.push(c + sp, c + sp); }
      for (const c of ['P', 'T', 'V', 'O']) { for (let n = 1; n <= 9; n++) D.push(c + n, c + n); for (const sp of ['v', 'k', 'r', 'l']) D.push(c + sp, c + sp); }
      for (let i = 0; i < 4; i++) { L.push('Xw', 'Xt'); D.push('Xw', 'Xc'); }
      shuffle(L); shuffle(D); for (let i = 0; i < L.length; i++) d.push(L[i] + '~' + D[i]);
    } else if (mode === 'mercy') {
      for (const c of ['R', 'Y', 'G', 'B']) { for (let n = 0; n <= 9; n++) d.push(c + n, c + n); for (const sp of ['s', 'r', 'd', 'q', 'a', 'k']) d.push(c + sp, c + sp, c + sp); }
      for (let i = 0; i < 4; i++) d.push('Xy', 'Xh', 'Xj', 'Xu');
    } else {
      for (const c of ['R', 'Y', 'G', 'B']) {
        d.push(c + '0');
        for (let n = 1; n <= 9; n++) d.push(c + n, c + n);
        for (const sp of ['s', 'r', 'd']) d.push(c + sp, c + sp);
      }
      for (let i = 0; i < 6; i++) d.push('Xw', 'Xf'); // a few more wilds and +4s than the real deck
    }
  }
  return d;
}
const uSort = (u, h) => h.sort((a, b) => { const fa = uF(u, a), fb = uF(u, b); return (U_COL[fa[0]] - U_COL[fb[0]]) || (U_ORD[fa[1]] - U_ORD[fb[1]]); });
function uCan(u, c) { // can this single card go on the pile right now?
  const f = uF(u, c);
  if (u.pend) return u.pend.k === 'n' && uDv(u, f) >= u.pend.v;
  if (f[0] === 'X') return true;
  return !u.color || f[0] === u.color || f[1] === uF(u, u.top)[1];
}
function uMultiOk(u, f) { // cards of one kind that may be thrown together
  if (uNumF(f)) return !(u.mode === 'mercy' && (f[1] === '0' || f[1] === '7'));
  if ('srk'.includes(f[1])) return true;
  return uDv(u, f) > 0 && f[1] !== 'y';
}
function uMultiVals(u) { // for the phone: which card kinds can be thrown together
  const out = []; for (let i = 0; i < 10; i++) if (uMultiOk(u, '#' + i)) out.push(String(i));
  for (const v of 'srkodfqvthj') { const f = '#' + v; if (v !== 'y' && uMultiOk(u, f)) out.push(v); }
  return out.join('');
}
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
const uGone = (u, id) => u.fin.includes(id) || (u.out || []).includes(id);
const uAct = (u) => u.ids.filter((id) => !uGone(u, id));
const uAdv = (u, k) => { const n = u.ids.length; for (let s = 0; s < k; s++) { let g = 0; do { u.cur = (((u.cur + u.dir) % n) + n) % n; } while (uGone(u, u.ids[u.cur]) && ++g < n); } };
function unStart(room) {
  const cands = [...room.players.values()].filter((p) => !p.left && p.connected);
  if (cands.length < 2) return 'Need at least 2 players';
  const mode = U_MODES.includes(room.unSet.mode) ? room.unSet.mode : 'classic';
  const sel = shuffle(cands).slice(0, 12), ids = sel.map((p) => p.id);
  for (const p of room.players.values()) p.watch = false;
  for (const p of cands) if (!ids.includes(p.id)) p.watch = true;
  const base = { mode, side: 'L' };
  let draw = shuffle(uDeck(mode, ids.length > 6 ? 2 : 1));
  const hands = {}; for (const id of ids) hands[id] = [];
  for (let r = 0; r < 7; r++) for (const id of ids) hands[id].push(draw.pop());
  let top = null; const buried = [];
  while (draw.length) { const c = draw.pop(); if (uNumF(uF(base, c))) { top = c; break; } buried.push(c); } // the first card is always a number
  draw = shuffle(draw.concat(buried));
  for (const id of ids) uSort(base, hands[id]);
  room.unGid = (room.unGid || 0) + 1;
  room.un = { gid: room.unGid, mode, side: 'L', ids, hands, draw, disc: [top], top, color: uF(base, top)[0], dir: 1, cur: 0, pend: null, drew: null, calls: {}, fin: [], out: [], ev: 0, last: null, winner: null, ranks: null, resh: 0, ucd: {} };
  setPhase(room, 'udeal');
  schedule(room, 4800, () => unTurn(room)); // shuffle + deal animation plays on every phone first
  broadcast(room);
  for (const p of sel) notify(room, p, '🃏 UNO started', 'Open the game and play!', [100, 60, 100]);
  return null;
}
function unTurn(room) {
  const u = room.un; if (!u) return;
  setPhase(room, 'uturn'); u.drew = null; u.paused = null;
  if (uGone(u, u.ids[u.cur])) uAdv(u, 1);
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
  const rest = u.ids.filter((id) => !uGone(u, id)).sort((a, b) => u.hands[a].length - u.hands[b].length);
  const w = u.fin[0] || rest[0];
  u.winner = w; u.ranks = u.fin.concat(rest).map((id) => ({ id, left: u.hands[id].length })).concat((u.out || []).map((id) => ({ id, left: 0, out: 1 })));
  setPhase(room, 'uover');
  for (const id of u.ids) { const q = room.players.get(id); if (q && !q.left) notify(room, q, '🏁 UNO finished', (room.players.get(w) || {}).name + ' won', [70, 50, 70]); }
  broadcast(room);
}
function uMercy(room, ids) { // No Mercy: 25 cards or more and you are out
  const u = room.un; if (u.mode !== 'mercy') return false; let any = false;
  for (const id of ids) {
    if (uGone(u, id) || !u.hands[id] || u.hands[id].length < U_CAP) continue;
    u.draw = u.hands[id].concat(u.draw); u.hands[id] = []; u.out.push(id); delete u.calls[id]; any = true;
    uEv(u, { k: 'out', id });
  }
  return any;
}
function unPlay(room, p, idxs, color, target) {
  const u = room.un;
  if (!u || room.phase !== 'uturn' || u.ids[u.cur] !== p.id) return 'Not your turn';
  const hand = u.hands[p.id];
  if (!Array.isArray(idxs) || !idxs.length || idxs.length > 12) return 'Pick a card';
  if (new Set(idxs).size !== idxs.length || idxs.some((i) => !Number.isInteger(i) || i < 0 || i >= hand.length)) return 'Pick a card';
  const cards = idxs.map((i) => hand[i]), faces = cards.map((c) => uF(u, c)), f0 = faces[0], v0 = f0[1], n = uAct(u).length;
  if (u.drew !== null && !(idxs.length === 1 && idxs[0] === u.drew)) return 'Play the card you drew, or pass';
  if (u.pend) {
    if (u.pend.k !== 'n') return u.pend.k === 'roul' ? 'Draw cards (Colour Roulette)' : 'Draw the cards';
    if (!faces.every((f) => uDv(u, f) >= u.pend.v)) return 'Only a draw card that is equal or bigger can go on this. Or draw the cards';
  } else if (!uCan(u, cards[0])) return "That card doesn't match";
  if (faces.length > 1) {
    if (!faces.every((f) => f[1] === v0)) return 'Only cards of the same kind go together';
    if (!uMultiOk(u, f0)) return "Those cards can't be played together";
  }
  const wild = f0[0] === 'X';
  if (wild && v0 !== 'u' && !uCols(u).includes(color)) return 'Pick a colour';
  let tgt = null;
  if (u.mode === 'mercy' && v0 === '7') {
    tgt = uAct(u).filter((id) => id !== p.id).includes(target) ? target : null;
    if (!tgt) return 'Pick a player to swap hands with';
  }
  for (const i of [...idxs].sort((a, b) => b - a)) hand.splice(i, 1);
  for (const c of cards) u.disc.push(c);
  const last = cards[cards.length - 1], lf = faces[faces.length - 1], side0 = u.side;
  u.top = last; u.color = wild ? (v0 === 'u' ? u.color : color) : lf[0];
  const m = cards.length, dv = uDv(u, f0), ev = { k: 'play', id: p.id, cards: faces, color: u.color, side: side0, pend: 0 };
  let touched = [];
  if (u.pend && u.pend.k === 'n') { u.pend.n += dv * m; u.pend.v = dv; } else if (dv > 0) u.pend = { k: 'n', n: dv * m, v: dv };
  if (dv > 0 && !(v0 === 'y')) uAdv(u, 1);
  else if (v0 === 's') uAdv(u, 1 + m);
  else if (v0 === 'r' || v0 === 'y') { if (m % 2) u.dir = -u.dir; uAdv(u, n === 2 && v0 === 'r' ? 2 : 1); if (v0 === 'y') { u.pend = u.pend && u.pend.k === 'n' ? u.pend : null; } }
  else if (v0 === 'k') { /* skip everyone: same player goes again */ }
  else if (v0 === 'l') {
    u.side = u.side === 'D' ? 'L' : 'D'; const nf = uF(u, last); u.color = nf[0] === 'X' ? null : nf[0];
    for (const id of u.ids) uSort(u, u.hands[id]);
    ev.flip = u.side; uAdv(u, 1);
  } else if (v0 === 'a') {
    const keep = []; for (const c of hand) { if (uF(u, c)[0] === lf[0]) { u.disc.push(c); ev.cards.push(uF(u, c)); } else keep.push(c); }
    hand.length = 0; for (const c of keep) hand.push(c); ev.all = ev.cards.length; uAdv(u, 1);
  } else if (v0 === 'c') { u.pend = { k: 'col', col: color }; uAdv(u, 1); }
  else if (v0 === 'u') { u.pend = { k: 'roul' }; uAdv(u, 1); }
  else if (v0 === '0' && u.mode === 'mercy') {
    const order = []; let g = 0, save = u.cur; do { order.push(u.ids[u.cur]); uAdv(u, 1); } while (u.cur !== save && ++g < 20); u.cur = save;
    const old = order.map((id) => u.hands[id]); order.forEach((id, i) => { u.hands[id] = old[(i + order.length - 1) % order.length]; uSort(u, u.hands[id]); });
    ev.rot = 1; touched = order; uAdv(u, 1);
  } else if (v0 === '7' && u.mode === 'mercy') {
    const t = u.hands[tgt]; u.hands[tgt] = u.hands[p.id]; u.hands[p.id] = t; uSort(u, u.hands[tgt]); uSort(u, u.hands[p.id]);
    ev.swap = tgt; touched = [tgt, p.id]; uAdv(u, 1);
  } else uAdv(u, 1);
  u.drew = null;
  const h2 = u.hands[p.id]; ev.pend = u.pend && u.pend.k === 'n' ? u.pend.n : 0;
  uEv(u, ev);
  if (touched.length) uMercy(room, touched);
  if (!h2.length) {
    u.fin.push(p.id); delete u.calls[p.id]; u.last.fin = u.fin.length;
    if (u.fin.length >= Math.min(3, u.ids.length - 1) || uAct(u).length < 2) return unOver(room), null;
    unTurn(room); return null;
  }
  if (uAct(u).length < 2) return unOver(room), null;
  if (h2.length === 1) u.calls[p.id] = Date.now(); else delete u.calls[p.id];
  unTurn(room);
  return null;
}
function unDraw(room, p, auto, color) {
  const u = room.un;
  if (!u || room.phase !== 'uturn' || u.ids[u.cur] !== p.id || u.drew !== null) return;
  const hand = u.hands[p.id];
  delete u.calls[p.id];
  const finish = (n, extra) => {
    uSort(u, hand); uEv(u, Object.assign({ k: 'draw', id: p.id, n }, extra || {}));
    if (uMercy(room, [p.id]) && uAct(u).length < 2) return unOver(room);
  };
  if (u.pend) {
    const pd = u.pend; let got = [];
    if (pd.k === 'n') got = uDraw(u, pd.n);
    else {
      let col = pd.k === 'col' ? pd.col : color;
      if (pd.k === 'roul') { if (!uCols(u).includes(col)) { if (!auto) return 'Pick a colour first'; col = uCols(u)[Math.floor(Math.random() * 4)]; } u.color = col; }
      for (let i = 0; i < 60; i++) { const c = uDraw(u, 1)[0]; if (!c) break; got.push(c); if (uF(u, c)[0] === col) break; }
      if (pd.k === 'col') u.color = col;
    }
    for (const c of got) hand.push(c);
    u.pend = null; uAdv(u, 1);
    finish(got.length, { pend: true, why: pd.k === 'n' ? undefined : pd.k, color: u.color });
    if (room.phase === 'uover') return;
    return unTurn(room);
  }
  let got = uDraw(u, 1);
  if (!got.length) { uEv(u, { k: 'pass', id: p.id }); uAdv(u, 1); return unTurn(room); }
  hand.push(got[0]);
  if (u.mode === 'mercy') { // No Mercy: keep drawing until something can be played
    while (!uCan(u, got[got.length - 1]) && hand.length < U_CAP) { const c = uDraw(u, 1)[0]; if (!c) break; got.push(c); hand.push(c); }
  }
  const lastC = got[got.length - 1]; uSort(u, hand);
  const playable = uCan(u, lastC);
  finish(got.length);
  if (room.phase === 'uover') return;
  if (u.out.includes(p.id)) { uAdv(u, 1); return unTurn(room); }
  if (!auto && playable) { // may play the card you just drew, or pass
    u.drew = hand.indexOf(lastC);
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
function unSkip(room, p) { // host: skip the current player's turn (somebody is away)
  const u = room.un; if (!u || room.phase !== 'uturn') return 'No turn to skip';
  const id = u.ids[u.cur]; if (u.paused) return 'Resume the game first';
  uEv(u, { k: 'hskip', id }); u.drew = null; uAdv(u, 1); unTurn(room); return null;
}
function unUno(room, p) { // only valid right after you played down to exactly one card
  const u = room.un; if (!u || !u.ids.includes(p.id) || !['udeal', 'uturn'].includes(room.phase)) return null;
  const hand = u.hands[p.id];
  if (!hand || hand.length !== 1) return 'UNO only works when you have exactly 1 card left';
  if (!u.calls[p.id]) return null; // already said: nothing to show twice
  delete u.calls[p.id]; uEv(u, { k: 'uno', id: p.id }); broadcast(room); return null;
}
function unCatch(room, p) { // 3 seconds after somebody got to one card without saying UNO, anyone can catch them
  const u = room.un; if (!u || !u.ids.includes(p.id) || room.phase !== 'uturn') return null;
  const now = Date.now(); if (now - (u.ucd[p.id] || 0) < 1500) return null; u.ucd[p.id] = now;
  const t = Object.keys(u.calls).filter((id) => id !== p.id && now >= u.calls[id] + 3000 && u.hands[id] && u.hands[id].length === 1).sort((a, b) => u.calls[a] - u.calls[b])[0];
  if (!t) return 'Nobody to catch right now';
  delete u.calls[t];
  const got = uDraw(u, 2); for (const c of got) u.hands[t].push(c); uSort(u, u.hands[t]);
  uEv(u, { k: 'caught', id: t, by: p.id, n: got.length });
  uMercy(room, [t]); if (uAct(u).length < 2) return unOver(room), null;
  broadcast(room); return null;
}
function unRemove(room, p) {
  const u = room.un;
  if (!u || !['udeal', 'uturn'].includes(room.phase)) return;
  const i = u.ids.indexOf(p.id); if (i < 0) return;
  u.draw = u.hands[p.id].concat(u.draw); // their cards go under the draw pile
  u.ids.splice(i, 1); u.fin = u.fin.filter((x) => x !== p.id); u.out = (u.out || []).filter((x) => x !== p.id); delete u.hands[p.id]; delete u.calls[p.id];
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
    if (room.phase !== 'rrace' || !r || r.ids.length < 2 || !r.cars || !r.dirty) continue;
    r.dirty = false; // nothing new since last time: don't send a repeat (phones read repeats as the car stopping)
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
  if (room.game === 'cricket') return ckCheck(room);
  if (room.game === 'draw') return dwCheck(room);
  if (room.game === 'golf') return gfCheck(room);
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
  if (room.phase === 'lobby' || room.phase === 'over' || room.phase === 'dover' || room.phase === 'gover') room.players.delete(p.id);
  else { p.left = true; p.alive = false; delete room.votes[p.id]; delete room.descs[p.id]; }
  if (![...room.players.values()].some((q) => !q.left)) { clearTimeout(room.timer); dwClear(room); rooms.delete(room.code); return; }
  if (wasHost && !transferHost(room)) { /* nobody connected: host stays unassigned until someone rejoins */ }
  if (room.game === 'uno') unRemove(room, p);
  afterRemoval(room);
}

// ---------------------------------------------------------------- websocket
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 32768, perMessageDeflate: false });

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
  if (room.game === 'draw' && room.dw) dwBack(room, p);
  if (room.game === 'football' && room.phase === 'fplay' && room.fb && room.fb.sim) send(ws, fgoMsg(room.fb));
  broadcast(room);
}

// ================================================================ Draw & Guess (skribbl style)
// Everything for this game lives in this block so only server.js needs uploading.
const DW_WORDS = 'cat,dog,elephant,tiger,lion,monkey,giraffe,zebra,horse,cow,pig,sheep,goat,rabbit,mouse,rat,squirrel,bat,fox,wolf,bear,panda,kangaroo,koala,camel,donkey,deer,hippo,rhino,crocodile,snake,frog,turtle,lizard,fish,shark,whale,dolphin,octopus,crab,jellyfish,starfish,seahorse,penguin,owl,eagle,parrot,peacock,duck,chicken,rooster,pigeon,crow,swan,flamingo,butterfly,bee,ant,spider,mosquito,fly,ladybug,snail,worm,dragonfly,scorpion,cockroach,gorilla,cheetah,leopard,bull,buffalo,hen,tortoise,seal,walrus,hedgehog,dinosaur,dragon,unicorn,mermaid,ghost,robot,alien,pizza,burger,sandwich,hot dog,french fries,ice cream,cake,cookie,donut,chocolate,candy,lollipop,popcorn,pancake,waffle,bread,butter,cheese,egg,bacon,sausage,noodles,pasta,soup,salad,rice,apple,banana,orange,grapes,watermelon,strawberry,cherry,pineapple,mango,lemon,coconut,peach,pear,kiwi,pomegranate,papaya,guava,carrot,potato,tomato,onion,garlic,corn,pumpkin,mushroom,broccoli,cucumber,chilli,peas,cabbage,coffee,tea,milk,juice,water bottle,soda,lassi,sugarcane juice,honey,jam,sushi,taco,cupcake,birthday cake,pie,candle,samosa,jalebi,dosa,idli,vada pav,pani puri,biryani,roti,naan,paneer,laddoo,gulab jamun,chai,pakora,pav bhaji,kulfi,rasgulla,thali,tandoor,butter chicken,papad,pickle,chaat,momos,maggi,dhokla,poha,upma,kheer,halwa,house,school,hospital,bank,temple,church,mosque,castle,palace,tower,bridge,tunnel,lighthouse,windmill,tent,igloo,farm,barn,factory,shop,market,mall,cinema,stadium,airport,railway station,bus stop,petrol pump,police station,fire station,library,museum,zoo,park,garden,playground,swimming pool,beach,island,mountain,volcano,desert,forest,jungle,river,waterfall,lake,ocean,cave,hill,village,city,skyscraper,apartment,hotel,restaurant,toilet,kitchen,bedroom,balcony,staircase,elevator,Taj Mahal,Eiffel Tower,Statue of Liberty,Great Wall,pyramid,Big Ben,Leaning Tower,Gateway of India,India Gate,Red Fort,Qutub Minar,Golden Temple,Mount Everest,Niagara Falls,Colosseum,car,bus,truck,bike,bicycle,scooter,auto rickshaw,rickshaw,tractor,train,metro,airplane,helicopter,rocket,ship,boat,submarine,sailboat,ambulance,fire truck,police car,taxi,jeep,tank,hot air balloon,parachute,skateboard,roller skates,wheelchair,trolley,cycle rickshaw,bullock cart,horse cart,chair,table,sofa,bed,pillow,blanket,mattress,wardrobe,mirror,lamp,fan,air conditioner,fridge,washing machine,oven,microwave,gas stove,pressure cooker,kettle,toaster,mixer,iron,broom,bucket,mug,plate,spoon,fork,knife,glass,bottle,bowl,pan,teapot,clock,wall clock,calendar,door,window,curtain,carpet,stairs,key,lock,matchbox,umbrella,suitcase,backpack,wallet,purse,watch,ring,necklace,earrings,bangles,crown,sunglasses,spectacles,hat,cap,helmet,scarf,tie,belt,gloves,shoes,slippers,sandals,socks,boots,shirt,t-shirt,jeans,jacket,sweater,dress,skirt,saree,kurta,turban,bindi,dupatta,lungi,topi,raincoat,pajamas,phone,mobile,laptop,computer,keyboard,mouse pad,monitor,television,remote,camera,headphones,speaker,microphone,charger,battery,torch,bulb,wifi,router,printer,calculator,satellite,drone,game controller,joystick,power bank,earphones,selfie stick,smart watch,tablet,pendrive,cable,plug,switch,pencil,pen,eraser,ruler,notebook,book,bag,scissors,glue,stapler,paint brush,crayon,chalk,blackboard,globe,map,compass,telescope,microscope,magnet,flag,envelope,letter,stamp,newspaper,magazine,diary,passport,ticket,football,cricket,cricket bat,cricket ball,stumps,wicket,tennis,badminton,shuttlecock,basketball,volleyball,hockey,golf,baseball,boxing,wrestling,kabaddi,carrom,chess,ludo,snake and ladder,cards,dice,puzzle,swing,seesaw,slide,kite,top,marbles,gilli danda,hide and seek,tug of war,skipping rope,hula hoop,yo-yo,balloon,trophy,medal,whistle,goal post,referee,umpire,six,bowling,archery,swimming,running,high jump,gym,dumbbell,yoga,cycling,surfing,skiing,fishing,doctor,nurse,teacher,police,soldier,farmer,chef,pilot,driver,actor,singer,dancer,painter,carpenter,tailor,barber,plumber,electrician,mechanic,fireman,postman,judge,lawyer,engineer,scientist,astronaut,magician,clown,king,queen,prince,princess,pirate,ninja,superhero,vampire,witch,zombie,monster,santa claus,snowman,baby,grandfather,twins,cowboy,detective,thief,shopkeeper,milkman,watchman,head,face,eye,ear,nose,mouth,tongue,teeth,hair,beard,moustache,neck,shoulder,arm,elbow,hand,finger,thumb,nail,chest,heart,stomach,back,leg,knee,foot,toe,skeleton,brain,bone,muscle,fist,smile,tears,sneeze,yawn,sleeping,laughing,crying,angry,dizzy,sweating,sun,moon,star,cloud,rain,rainbow,lightning,thunder,snow,wind,tornado,fire,smoke,ice,wave,flood,earthquake,sunrise,sunset,night,eclipse,comet,planet,earth,galaxy,saturn,milky way,meteor,tree,flower,rose,lotus,sunflower,cactus,grass,leaf,branch,seed,bush,palm tree,bamboo,mango tree,banana leaf,rock,stone,sand,mud,puddle,iceberg,diya,rangoli,firecracker,holi,diwali,rakhi,mehndi,wedding,baraat,dhol,tabla,sitar,flute,harmonium,guitar,piano,drum,violin,trumpet,saxophone,bell,temple bell,ganesh,om,lotus flower,peacock feather,kolam,garland,incense stick,pooja thali,yoga mat,spinning wheel,gandhi,elephant ride,snake charmer,monkey show,bollywood,hero,villain,film,movie ticket,song,dance,sword,shield,bow and arrow,axe,hammer,screw,screwdriver,saw,drill,wrench,ladder,rope,chain,hook,anchor,net,cage,trap,treasure,treasure map,pirate ship,diamond,gold,coin,money,rupee note,piggy bank,credit card,shopping cart,price tag,gift,sleep,run,jump,swim,sing,cry,laugh,eat,drink,cook,wash,brush teeth,take a bath,climb,fall,throw,catch,kick,push,pull,hug,clap,point,dig,paint,write,read,fight,whisper,shout,camping,shopping,haircut,photograph,selfie,traffic,traffic light,zebra crossing,speed breaker,signboard,christmas tree,scarecrow,fireworks,birthday,party hat,confetti,piñata,smiley,thumbs up,peace sign,question mark,arrow,circle,square,triangle,star shape,spider web,beehive,nest,egg shell,footprint,fingerprint,shadow,reflection,bubble,bubble gum,soap,shampoo,toothbrush,toothpaste,towel,comb,razor,perfume,lipstick,nail polish,cotton,syringe,thermometer,bandage,pills,stethoscope,crutches,mask,sanitizer,traffic cone,petrol,bulldozer,crane,construction worker,bricks,cement,paint bucket,wall,fence,gate,tap,pipe,sink,bathtub,shower,dustbin,garbage truck'.split(',').map((s) => s.trim()).filter(Boolean);
const DW_SHAPES = ['line', 'rect', 'square', 'ellipse', 'circle', 'tri', 'diamond', 'star', 'heart', 'arrow'];
const DW_COL = /^#[0-9a-fA-F]{6}$/;
function dwNorm(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, ''); }
function dwLev(a, b) {
  const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
function dwActive(room) { return [...room.players.values()].filter((q) => !q.left); }
function dwEligible(room) { const d = room.dw; return dwActive(room).filter((q) => q.id !== d.drawer && q.connected); }
function dwNew(room) {
  const act = dwActive(room);
  room.dw = {
    seq: 0, tm: null, order: shuffle(act.map((q) => q.id)), idx: -1, round: 1, rounds: room.dwSet.rounds, score: {}, likes: {}, used: new Set(),
    ops: [], redo: [], byId: {}, log: [], drawer: null, choices: null, word: '', rev: new Set(), hintN: 0, got: {}, gotN: 0, gotSum: 0, endAt: 0, secs: 0, extra: 0,
    turnStart: 0, paused: null, skip: {}, more: {}, liked: {}, last: null, gains: {},
  };
  for (const q of act) room.dw.score[q.id] = 0;
  return room.dw;
}
function dwClear(room) { if (room.dw) { clearTimeout(room.dw.tm); room.dw.seq++; } }
function dwSys(room, text, to) { const d = room.dw; const e = { k: 'sys', text, to: to || null, at: Date.now() }; d.log.push(e); if (d.log.length > 80) d.log.shift(); dwSendMsg(room, e); }
function dwSendMsg(room, e) {
  for (const q of room.players.values()) if (q.ws && q.connected && (!e.to || e.to.includes(q.id))) send(q.ws, { t: 'dmsg', m: { k: e.k, id: e.id, name: e.name, text: e.text, pts: e.pts } });
}
function dwLogFor(room, p) { return room.dw.log.filter((e) => !e.to || e.to.includes(p.id)).slice(-50).map((e) => ({ k: e.k, id: e.id, name: e.name, text: e.text, pts: e.pts })); }
function dwSync(room, p) { if (p.ws && p.connected && room.dw) send(p.ws, { t: 'dsync', ops: room.dw.ops, log: dwLogFor(room, p) }); }
function dwSyncAll(room) { for (const q of room.players.values()) dwSync(room, q); }
function dwTimer(room) {
  const d = room.dw; if (!d) return; clearTimeout(d.tm); if (d.paused) return;
  const seq = d.seq;
  d.tm = setTimeout(() => { if (room.dw === d && d.seq === seq) dwTick(room); }, 400);
}
function dwHintArr(d) { return d.word.split('').map((ch, i) => (/[a-z0-9]/i.test(ch) ? (d.rev.has(i) ? ch : '_') : ch)); }
function dwTick(room) {
  const d = room.dw, now = Date.now();
  if (room.phase === 'dpick') { if (now >= d.endAt) return dwPick(room, 0); }
  else if (room.phase === 'ddraw') {
    if (now >= d.endAt) return dwEnd(room, 'time');
    const max = room.dwSet.hints, el = now - d.turnStart, base = d.secs * 1000;
    if (d.hintN < max) {
      const thr = base * (max === 1 ? 0.5 : 0.3 + 0.5 * d.hintN / (max - 1));
      if (el >= thr) {
        const hid = []; d.word.split('').forEach((ch, i) => { if (/[a-z0-9]/i.test(ch) && !d.rev.has(i)) hid.push(i); });
        if (hid.length > 2) { d.rev.add(hid[Math.floor(Math.random() * hid.length)]); d.hintN++; broadcast(room); } else d.hintN = max;
      }
    }
  }
  dwTimer(room);
}
function dwNext(room) {
  const d = room.dw; if (!d) return;
  clearTimeout(d.tm);
  let p = null;
  for (let guard = 0; guard < 200; guard++) {
    d.idx++;
    if (d.idx >= d.order.length) { d.round++; d.idx = 0; if (d.round > d.rounds) return dwOver(room); }
    const q = room.players.get(d.order[d.idx]);
    if (q && !q.left) { p = q; break; }
  }
  if (!p || dwActive(room).length < 2) return dwOver(room);
  const pool = DW_WORDS.filter((w) => !d.used.has(w));
  const src = pool.length >= 3 ? pool : DW_WORDS;
  d.choices = shuffle(src.slice()).slice(0, 3); d.choices.forEach((w) => d.used.add(w));
  d.drawer = p.id; d.word = ''; d.rev = new Set(); d.hintN = 0; d.got = {}; d.gotN = 0; d.gotSum = 0; d.skip = {}; d.more = {}; d.liked = {}; d.extra = 0; d.gains = {};
  d.ops = []; d.redo = []; d.byId = {}; d.last = null; d.paused = null;
  setPhase(room, 'dpick'); d.seq++;
  d.endAt = Date.now() + 15000;
  if (!p.connected) { d.paused = { left: 15000 }; }
  dwSys(room, '🎨 ' + p.name + ' is choosing a word… (round ' + d.round + '/' + d.rounds + ')');
  dwSyncAll(room); broadcast(room); dwTimer(room);
}
function dwPick(room, i) {
  const d = room.dw; if (!d || room.phase !== 'dpick') return;
  d.word = d.choices[Math.max(0, Math.min(d.choices.length - 1, i | 0))]; d.choices = null;
  setPhase(room, 'ddraw'); d.seq++;
  d.secs = room.dwSet.secs; d.turnStart = Date.now(); d.endAt = d.turnStart + d.secs * 1000; d.paused = null;
  const dp = room.players.get(d.drawer);
  if (dp && !dp.connected) d.paused = { left: d.secs * 1000 };
  dwSys(room, '✏️ ' + (dp ? dp.name : 'Someone') + ' is drawing! Word has ' + d.word.replace(/[^a-z0-9]/gi, '').length + ' letters');
  broadcast(room); dwTimer(room);
}
function dwEnd(room, why) {
  const d = room.dw; if (!d || !['dpick', 'ddraw'].includes(room.phase)) return;
  clearTimeout(d.tm); d.seq++;
  const elig = Math.max(1, d.gotN + dwEligible(room).filter((q) => !d.got[q.id]).length);
  let dp = 0;
  if (why !== 'skipped' && d.gotN) dp = Math.round(d.gotSum / elig);
  if (dp) { d.score[d.drawer] = (d.score[d.drawer] || 0) + dp; d.gains[d.drawer] = dp; }
  if (!d.word && d.choices) d.word = d.choices[0];
  d.last = { word: d.word, drawer: d.drawer, gains: Object.assign({}, d.gains), why, got: d.gotN };
  setPhase(room, 'dres'); d.endAt = Date.now() + 7000; d.paused = null; d.choices = null;
  const nm = (room.players.get(d.drawer) || {}).name || 'Drawer';
  dwSys(room, (why === 'skipped' ? '⏭️ Turn skipped. ' : why === 'all' ? '🎉 Everybody guessed! ' : '⏰ Time is up! ') + 'The word was “' + d.word + '”' + (dp ? ' · ' + nm + ' +' + dp : ''));
  broadcast(room);
  const seq = d.seq; d.tm = setTimeout(() => { if (room.dw === d && d.seq === seq && room.phase === 'dres') dwNext(room); }, 7000);
}
function dwOver(room) {
  const d = room.dw; if (!d) return;
  clearTimeout(d.tm); d.seq++;
  setPhase(room, 'dover'); d.paused = null; d.choices = null;
  let best = null; for (const [id, n] of Object.entries(d.likes)) if (n > 0 && (!best || n > d.likes[best])) best = id;
  d.best = best;
  dwSys(room, '🏁 Game over!');
  broadcast(room);
}
function dwCheck(room) { // somebody left / went away: keep the game consistent
  const d = room.dw; if (!d || ['lobby', 'dover'].includes(room.phase)) return broadcast(room);
  if (dwActive(room).length < 2) return dwOver(room);
  const dp = room.players.get(d.drawer);
  if (['dpick', 'ddraw'].includes(room.phase) && (!dp || dp.left)) return dwEnd(room, 'skipped');
  if (room.phase === 'ddraw' && !d.paused) {
    const el = dwEligible(room);
    if (el.length && el.every((q) => d.got[q.id])) return dwEnd(room, 'all');
  }
  return broadcast(room);
}
function dwDisc(room, p) { // drawer lost connection: freeze the clock; host chooses wait / skip
  const d = room.dw; if (!d || p.id !== d.drawer || !['dpick', 'ddraw'].includes(room.phase) || d.paused) return;
  d.paused = { left: Math.max(1500, d.endAt - Date.now()) }; clearTimeout(d.tm);
  dwSys(room, '⏸ ' + p.name + ' went offline. The host can wait or skip');
}
function dwBack(room, p) {
  const d = room.dw; if (!d) return;
  dwSync(room, p);
  if (p.id === d.drawer && d.paused && !d.paused.hold) { d.endAt = Date.now() + d.paused.left; d.paused = null; dwSys(room, '▶️ ' + p.name + ' is back!'); dwTimer(room); }
  if (!(d.score[p.id] >= 0)) d.score[p.id] = 0;
}
function dwJoined(room, p) {
  const d = room.dw; if (!d) return;
  if (!d.order.includes(p.id)) d.order.push(p.id);
  if (!(d.score[p.id] >= 0)) d.score[p.id] = 0;
}
function dwView(room, p) {
  const d = room.dw, isD = p.id === d.drawer, know = isD || !!d.got[p.id] || room.phase === 'dres' || room.phase === 'dover';
  const el = dwEligible(room);
  return {
    round: d.round, rounds: d.rounds, drawer: d.drawer, idx: d.idx, n: d.order.length, score: d.score, got: Object.keys(d.got),
    word: know ? d.word : null, hint: room.phase === 'ddraw' && d.word ? dwHintArr(d) : null, len: d.word ? d.word.length : 0,
    choices: isD && room.phase === 'dpick' ? d.choices : null, endAt: d.endAt, pleft: d.paused ? d.paused.left : 0, paused: d.paused ? 1 : 0, hold: d.paused && d.paused.hold ? 1 : 0,
    secs: room.phase === 'dpick' ? 15 : d.secs + d.extra, skip: Object.keys(d.skip).length, myskip: !!d.skip[p.id], need: Math.floor(el.length / 2) + 1,
    more: p.id === room.hostId ? Object.values(d.more) : [], mymore: !!d.more[p.id], last: d.last, likes: d.likes, liked: !!d.liked[p.id], best: d.best || null,
  };
}
function dwClean(op) {
  if (!op || typeof op !== 'object') return null;
  const num = (x) => { x = Number(x); return Number.isFinite(x) ? Math.max(-20, Math.min(1420, Math.round(x * 10) / 10)) : 0; };
  const col = DW_COL.test(op.c) ? op.c : '#000000';
  const w = Math.max(1, Math.min(60, Math.round(Number(op.w) || 4)));
  if (op.k === 'p') {
    if (!Array.isArray(op.p) || !op.p.length || op.p.length > 240) return null;
    return { k: 'p', id: String(op.id || '').slice(0, 12), c: col, w, p: op.p.map(num) };
  }
  if (op.k === 'sh') {
    if (!DW_SHAPES.includes(op.s) || !Array.isArray(op.a) || op.a.length !== 4) return null;
    return { k: 'sh', s: op.s, c: col, w, f: op.f ? 1 : 0, a: op.a.map(num) };
  }
  if (op.k === 'poly') {
    if (!Array.isArray(op.p) || op.p.length < 4 || op.p.length > 40) return null;
    return { k: 'poly', c: col, w, f: op.f ? 1 : 0, z: op.z ? 1 : 0, p: op.p.map(num) };
  }
  if (op.k === 'f') return { k: 'f', c: col, x: num(op.x), y: num(op.y) };
  if (op.k === 'u' || op.k === 'r' || op.k === 'c') return { k: op.k };
  if (op.k === 'rp') { const inner = dwClean(op.o); if (!inner || inner.k === 'p' || inner.k === 'f') return null; return { k: 'rp', id: String(op.id || '').slice(0, 12), o: inner }; }
  return null;
}
function dwApply(d, op) {
  if (op.k === 'p') {
    const ex = d.byId[op.id];
    if (ex) { if (ex.p.length < 4000) ex.p.push(...op.p); }
    else { if (d.ops.length >= 2500) return false; d.ops.push(op); d.byId[op.id] = op; d.redo = []; }
  } else if (op.k === 'sh' || op.k === 'poly' || op.k === 'f') {
    if (d.ops.length >= 2500) return false; d.ops.push(op); d.redo = [];
  } else if (op.k === 'u') { const x = d.ops.pop(); if (x) { if (x.id) delete d.byId[x.id]; d.redo.push(x); if (d.redo.length > 60) d.redo.shift(); } }
  else if (op.k === 'r') { const x = d.redo.pop(); if (x) { d.ops.push(x); if (x.id) d.byId[x.id] = x; } }
  else if (op.k === 'c') { d.ops = []; d.redo = []; d.byId = {}; }
  else if (op.k === 'rp') {
    const i = d.ops.findIndex((o) => o.id && o.id === op.id);
    if (i < 0) return false; delete d.byId[op.id]; d.ops[i] = op.o;
  }
  return true;
}
function dwGuess(room, p, textRaw) {
  const d = room.dw, text = clean(textRaw, 40); if (!text) return;
  const now = Date.now(); if (now - (p.lastDg || 0) < 250) return; p.lastDg = now;
  if (room.phase === 'lobby' || !d) return;
  const live = room.phase === 'ddraw' && !d.paused;
  const isD = p.id === d.drawer;
  if (isD || d.got[p.id] || !live) { // drawer + people who already guessed talk privately; everybody can chat between turns
    const to = (room.phase === 'ddraw') ? [d.drawer, ...Object.keys(d.got)] : null;
    if (room.phase === 'ddraw' && !isD && !d.got[p.id]) return;
    const e = { k: 'pm', id: p.id, name: p.name, text, to, at: now }; d.log.push(e); if (d.log.length > 80) d.log.shift(); return dwSendMsg(room, e);
  }
  const n = dwNorm(text), w = dwNorm(d.word);
  if (!n) return;
  if (n === w || n === w + 's' || n + 's' === w) {
    const total = d.secs * 1000 + d.extra * 1000, f = Math.max(0, Math.min(1, (now - d.turnStart) / total));
    const pts = Math.max(60, Math.round(500 * (1 - 0.75 * f) - 25 * d.gotN));
    d.got[p.id] = now; d.gotN++; d.gotSum += pts; d.score[p.id] = (d.score[p.id] || 0) + pts; d.gains[p.id] = pts;
    const e = { k: 'ok', id: p.id, name: p.name, text: '', pts, at: now }; d.log.push(e); dwSendMsg(room, e);
    if (p.ws) send(p.ws, { t: 'dgot', word: d.word, pts });
    const el = dwEligible(room);
    if (el.length && el.every((q) => d.got[q.id])) return dwEnd(room, 'all');
    return broadcast(room);
  }
  const e = { k: 'g', id: p.id, name: p.name, text, at: now }; d.log.push(e); if (d.log.length > 80) d.log.shift(); dwSendMsg(room, e);
  if (w.length >= 4 && dwLev(n, w) <= (w.length >= 8 ? 2 : 1)) { const c = { k: 'close', text: '“' + text + '” is close!', to: [p.id], at: now }; dwSendMsg(room, c); }
}

/* ===== Gully Golf physics: pure JS, no three.js. Same code will run on the server later. =====
   Units: metres, seconds. y is up. The hole runs along +z. yaw 0 = +z, positive yaw turns toward +x. */
var GolfSim = (function () {
  var G = 9.81, R = 0.0214, DT = 1 / 120, CUP = 0.068, CR = 0.06; // CR: collision radius (a bit bigger than a real ball so hits happen)
  var KD = 0.0036, KL = 0.0035, KC = 0.0021, WK = 1.9; // WK: wind feels stronger than real life, so it matters
  var SURF = {
    tee: { e: 0.30, mu: 0.2, f: 0.30, name: 'Tee' },
    fairway: { e: 0.30, mu: 0.2, f: 0.28, name: 'Fairway' },
    fringe: { e: 0.27, mu: 0.13, f: 0.24, name: 'Fringe' },
    green: { e: 0.22, mu: 0.068, f: 0.18, name: 'Green' },
    rough: { e: 0.16, mu: 0.34, f: 0.48, name: 'Rough' },
    sand: { e: 0.04, mu: 1.1, f: 0.88, name: 'Bunker' },
    water: { e: 0, mu: 9, f: 1, name: 'Water' },
    oob: { e: 0.2, mu: 0.4, f: 0.5, name: 'Out of bounds' }
  };
  var CLUBS = [
    { id: 'DR', n: 'Driver', v: 71, a: 10.5, b: 0.55 },
    { id: '3W', n: '3 Wood', v: 64, a: 13, b: 0.62 },
    { id: '5I', n: '5 Iron', v: 55, a: 17, b: 0.75 },
    { id: '7I', n: '7 Iron', v: 48.5, a: 22, b: 0.85 },
    { id: '9I', n: '9 Iron', v: 42, a: 28, b: 0.95 },
    { id: 'PW', n: 'Wedge', v: 36, a: 35, b: 1.05 },
    { id: 'SW', n: 'Sand Wedge', v: 27, a: 46, b: 1.15 },
    { id: 'PT', n: 'Putter', v: 6.6, a: 0, b: 0, putt: true }
  ];
  function rng(seed) { var s = seed >>> 0 || 1; return function () { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
  function sstep(a, b, x) { var t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); }
  function ell(x, z, o) { var dx = (x - o.x) / o.rx, dz = (z - o.z) / o.rz; return Math.sqrt(dx * dx + dz * dz); }

  /* ---------- a hole, made from a seed ---------- */
  function makeHole(seed, parWanted) {
    var r = rng(seed * 7919 + 13), par = parWanted || [3, 4, 4, 5][Math.floor(r() * 4)];
    var L = par === 3 ? 135 + r() * 45 : par === 4 ? 300 + r() * 70 : 445 + r() * 55;
    var bend = (r() < 0.5 ? -1 : 1) * (par === 3 ? r() * 8 : 12 + r() * 26), ph = r() * 6, p1 = r() * 6, p2 = r() * 6, p3 = r() * 6;
    var H = { seed: seed, par: par, L: L, bend: bend };
    H.cx = function (z) { return bend * sstep(0.3 * L, 0.78 * L, z) + 5 * Math.sin(z / 47 + ph) * sstep(0, 60, z); };
    H.fw = function (z) { return 15 + 3.5 * Math.sin(z / 38 + p1); };
    H.fs = par === 3 ? L - 38 : 95 + r() * 25; // fairway starts here (rough between tee and fairway)
    var gx = H.cx(L), green = { x: gx, z: L, rx: 11 + r() * 3, rz: 13 + r() * 4 };
    var ang = r() * 6.283, slope = 0.012 + r() * 0.018;
    green.sx = Math.sin(ang) * slope; green.sz = Math.cos(ang) * slope;
    H.green = green;
    var ca = r() * 6.283, cr = 0.15 + r() * 0.4;
    H.cup = { x: gx + Math.sin(ca) * green.rx * cr, z: L + Math.cos(ca) * green.rz * cr };
    H.tee = { x: 0, z: 0 };
    var bunkers = [];
    function addB(x, z, rx, rz) { bunkers.push({ x: x, z: z, rx: rx, rz: rz }); }
    var nGb = 1 + Math.floor(r() * 3);
    for (var i = 0; i < nGb; i++) { var a = (r() - 0.5) * 3.6 + (i % 2 ? Math.PI : 0), dd = 1.18 + r() * 0.15; addB(gx + Math.sin(a) * green.rx * dd * 1.05, L + Math.cos(a) * green.rz * dd - 2, 3.5 + r() * 2.5, 2.6 + r() * 2); }
    if (par > 3) { var lz = Math.min(L - 70, 225 + r() * 30), side = r() < 0.5 ? -1 : 1; addB(H.cx(lz) + side * (H.fw(lz) - 2), lz, 4 + r() * 3, 7 + r() * 5); if (r() < 0.6) addB(H.cx(lz + 25) - side * (H.fw(lz + 25) - 1), lz + 25, 3.5 + r() * 2, 6 + r() * 4); }
    H.bunkers = bunkers;
    H.ponds = [];
    if (par === 3 ? r() < 0.75 : r() < 0.55) {
      if (par === 3) H.ponds.push({ x: gx + (r() - 0.5) * 6, z: L - green.rz - 13, rx: 17 + r() * 6, rz: 7 + r() * 3 });
      else { var pz = 130 + r() * (L - 230), s2 = r() < 0.5 ? -1 : 1; H.ponds.push({ x: H.cx(pz) + s2 * (H.fw(pz) + 9), z: pz, rx: 10 + r() * 6, rz: 20 + r() * 12 }); }
    }
    H.water = -0.55;
    H.base = function (x, z) { return 1.1 * Math.sin(x / 23 + p1) * Math.sin(z / 31 + p2) + 0.9 * Math.sin(z / 57 + p3) + 0.5 * Math.sin((x + z) / 19 + ph); };
    H.h = function (x, z) {
      var y = H.base(x, z), d;
      var tt = Math.max(Math.abs(x) / 6, Math.abs(z) / 8); if (tt < 1.6) y = y * sstep(1, 1.6, tt) + 0.25 * (1 - sstep(1, 1.6, tt)) + H.base(0, 0) * (1 - sstep(1, 1.6, tt)) * 0;
      d = ell(x, z, green);
      if (d < 1.7) { var gy = H.base(green.x, green.z) + green.sx * (x - green.x) + green.sz * (z - green.z) + 0.12 * Math.sin((x - green.x) / 5) * Math.cos((z - green.z) / 6); var k = 1 - sstep(1.05, 1.7, d); y = y * (1 - k) + gy * k; }
      for (var i = 0; i < bunkers.length; i++) { d = ell(x, z, bunkers[i]); if (d < 1.15) y -= 0.55 * (1 - sstep(0.55, 1.15, d)); }
      for (i = 0; i < H.ponds.length; i++) { d = ell(x, z, H.ponds[i]); if (d < 1.45) { var t = 1 - sstep(0.7, 1.45, d); y = y * (1 - t) + (H.water - 0.9) * t; } }
      return y;
    };
    H.surf = function (x, z) {
      var i, c = H.cx(z), off = Math.abs(x - c);
      if (z < -28 || z > L + 48 || off > 72) return 'oob';
      for (i = 0; i < H.ponds.length; i++) if (ell(x, z, H.ponds[i]) < 1) return 'water';
      for (i = 0; i < bunkers.length; i++) if (ell(x, z, bunkers[i]) < 1) return 'sand';
      var dg = ell(x, z, green); if (dg < 1) return 'green'; if (dg < 1.22) return 'fringe';
      if (Math.abs(x) < 5 && z > -6 && z < 6) return 'tee';
      if (z > H.fs && z < L + 4 && off < H.fw(z)) return 'fairway';
      return 'rough';
    };
    // trees along both sides, out of play lines
    var trees = [];
    for (var z = -20; z < L + 45; z += 5 + r() * 6) {
      for (var sd = -1; sd <= 1; sd += 2) {
        if (r() < 0.25) continue;
        var w = Math.max(H.fw(z) + 14, 26) + r() * 22, tx = H.cx(z) + sd * w, tz = z + (r() - 0.5) * 4;
        if (ell(tx, tz, green) < 2 || H.surf(tx, tz) === 'water') continue;
        trees.push({ x: tx, z: tz, s: 0.8 + r() * 0.6, k: r() < 0.55 ? 0 : 1 });
        if (r() < 0.5) trees.push({ x: tx + sd * (6 + r() * 10), z: tz + (r() - 0.5) * 8, s: 0.8 + r() * 0.7, k: r() < 0.5 ? 0 : 1 });
      }
    }
    H.trees = trees;
    H.windSeed = r();
    return H;
  }
  function normal(H, x, z) { var e = 0.15, dx = (H.h(x + e, z) - H.h(x - e, z)) / (2 * e), dz = (H.h(x, z + e) - H.h(x, z - e)) / (2 * e); var l = Math.sqrt(dx * dx + 1 + dz * dz); return [-dx / l, 1 / l, -dz / l]; }

  /* ---------- launching a shot ---------- */
  function lieFactor(lie, club) {
    if (lie === 'rough') return club.id === 'SW' || club.id === 'PW' ? 0.9 : 0.82;
    if (lie === 'sand') return club.id === 'SW' ? 0.85 : club.id === 'PW' ? 0.65 : 0.45;
    return 1;
  }
  /* shot = { club index, power 0..1, yaw (radians), err (deg, from the timing needle), side (-1..1 curve), spin (-1 back .. +1 top) } */
  function launch(ball, shot, lie) {
    var c = CLUBS[shot.club], sp = c.v * Math.max(0.03, Math.min(1, shot.power)) * lieFactor(lie, c);
    var yaw = shot.yaw + (shot.err || 0) * Math.PI / 180, pitch = (c.a + (c.putt ? 0 : -2 * (shot.spin || 0))) * Math.PI / 180;
    ball.v = [Math.sin(yaw) * Math.cos(pitch) * sp, Math.sin(pitch) * sp, Math.cos(yaw) * Math.cos(pitch) * sp];
    ball.b = c.putt ? 0 : c.b * (1 - 0.45 * (shot.spin || 0));
    ball.sd = c.putt ? 0 : (shot.side || 0) * 0.55 - (shot.err || 0) * 0.04; // a ball pushed left also curves left
    ball.top = shot.spin || 0;
    ball.mode = c.putt ? 'roll' : 'air';
    if (!c.putt) ball.p[1] += 0.02;
  }

  /* ---------- run every ball of a round at the same time ---------- */
  // balls: [{ id, p:[x,y,z], shot or null (just sits there), lie }]. Returns { frames: [[x,y,z,...per ball] ...], fps, res: [...] }
  function run(H, balls, wind, opts) {
    opts = opts || {};
    var noHole = !!opts.noHole, maxT = opts.maxT || 32, stopAtLand = !!opts.stopAtLand;
    var B = balls.map(function (b) {
      var o = { id: b.id, p: b.p.slice(), v: [0, 0, 0], b: 0, sd: 0, top: 0, mode: 'rest', o: b.p.slice(), carry: null, land: null, ev: [], hits: [] };
      if (b.shot) { launch(o, b.shot, b.lie || H.surf(o.p[0], o.p[2])); o.shotLie = b.lie; }
      if (b.done) o.mode = 'gone';
      return o;
    });
    var frames = [], fps = 30, every = Math.round(1 / DT / fps), step = 0, t = 0;
    function rec() { var f = []; for (var i = 0; i < B.length; i++) { var q = B[i]; f.push(Math.round(q.p[0] * 100) / 100, Math.round(q.p[1] * 100) / 100, Math.round(q.p[2] * 100) / 100); } frames.push(f); }
    rec();
    function active(q) { return q.mode === 'air' || q.mode === 'roll'; }
    while (t < maxT) {
      var any = false;
      for (var i = 0; i < B.length; i++) { var q = B[i]; if (!active(q)) continue; any = true; stepBall(H, q, wind, t, noHole); if (stopAtLand && q.land) q.mode = 'rest'; }
      // ball-to-ball hits
      for (i = 0; i < B.length; i++) for (var j = i + 1; j < B.length; j++) {
        var a = B[i], b = B[j]; if (a.mode === 'gone' || b.mode === 'gone' || a.mode === 'hole' || b.mode === 'hole' || a.mode === 'water' || b.mode === 'water' || a.mode === 'oob' || b.mode === 'oob') continue;
        if (!active(a) && !active(b)) continue;
        var dx = b.p[0] - a.p[0], dy = b.p[1] - a.p[1], dz = b.p[2] - a.p[2], d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > 4 * CR * CR || d2 < 1e-8) continue;
        var d = Math.sqrt(d2), nx = dx / d, ny = dy / d, nz = dz / d, rv = (b.v[0] - a.v[0]) * nx + (b.v[1] - a.v[1]) * ny + (b.v[2] - a.v[2]) * nz;
        if (rv >= 0) continue;
        var jj = -(1 + 0.88) * rv / 2;
        a.v[0] -= jj * nx; a.v[1] -= jj * ny; a.v[2] -= jj * nz; b.v[0] += jj * nx; b.v[1] += jj * ny; b.v[2] += jj * nz;
        var push = (2 * CR - d) / 2; a.p[0] -= nx * push; a.p[2] -= nz * push; b.p[0] += nx * push; b.p[2] += nz * push;
        if (a.mode === 'rest') a.mode = 'roll'; if (b.mode === 'rest') b.mode = 'roll';
        a.hits.push(b.id); b.hits.push(a.id); a.ev.push({ k: 'hit', t: t, with: b.id }); b.ev.push({ k: 'hit', t: t, with: a.id });
      }
      t += DT; step++;
      if (step % every === 0) rec();
      if (!any) break;
    }
    rec();
    var res = B.map(function (q) {
      var s = q.mode === 'hole' ? 'hole' : q.mode === 'water' ? 'water' : q.mode === 'oob' ? 'oob' : H.surf(q.p[0], q.p[2]);
      return { id: q.id, end: q.mode === 'air' || q.mode === 'roll' ? 'rest' : q.mode, p: q.p, surf: s, carry: q.carry, land: q.land, total: Math.hypot(q.p[0] - q.o[0], q.p[2] - q.o[2]), ev: q.ev, hits: q.hits };
    });
    return { frames: frames, fps: fps, res: res, t: t };
  }
  function stepBall(H, q, wind, t, noHole) {
    var p = q.p, v = q.v, gy, s, n;
    if (q.mode === 'air') {
      var rx = v[0] - wind[0] * WK, ry = v[1], rz = v[2] - wind[1] * WK, sp = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1e-6;
      // right of travel = rel x up ; lift = right x rel
      var Rx = -rz, Rz = rx, rl = Math.sqrt(Rx * Rx + Rz * Rz) || 1e-6; Rx /= rl; Rz /= rl;
      var Lx = (0 * rz - Rz * ry) / sp, Ly = (Rz * rx - Rx * rz) / sp, Lz = (Rx * ry - 0 * rx) / sp; // lift = right x rel
      var ax = -KD * sp * rx + KL * q.b * sp * sp * Lx + KC * q.sd * sp * sp * Rx;
      var ay = -G - KD * sp * ry + KL * q.b * sp * sp * Ly;
      var az = -KD * sp * rz + KL * q.b * sp * sp * Lz + KC * q.sd * sp * sp * Rz;
      v[0] += ax * DT; v[1] += ay * DT; v[2] += az * DT;
      p[0] += v[0] * DT; p[1] += v[1] * DT; p[2] += v[2] * DT;
      q.b *= 1 - 0.06 * DT; q.sd *= 1 - 0.05 * DT;
      var sf = H.surf(p[0], p[2]);
      if (sf === 'water' && p[1] <= H.water + R) { q.mode = 'water'; q.ev.push({ k: 'water', t: t }); p[1] = H.water; if (!q.land) { q.land = p.slice(); q.carry = Math.hypot(p[0] - q.o[0], p[2] - q.o[2]); } return; }
      gy = H.h(p[0], p[2]);
      if (p[1] <= gy + R) {
        p[1] = gy + R;
        if (!q.land) { q.land = p.slice(); q.carry = Math.hypot(p[0] - q.o[0], p[2] - q.o[2]); q.ev.push({ k: 'land', t: t, s: sf }); }
        if (sf === 'oob') { q.mode = 'oob'; q.ev.push({ k: 'oob', t: t }); return; }
        if (!noHole && (sf === 'green' || sf === 'fringe') && Math.hypot(p[0] - H.cup.x, p[2] - H.cup.z) < CUP && Math.hypot(v[0], v[2]) < 9) { q.mode = 'hole'; q.ev.push({ k: 'hole', t: t, dunk: 1 }); p[0] = H.cup.x; p[2] = H.cup.z; p[1] = gy - 0.06; return; }
        n = normal(H, p[0], p[2]); var S = SURF[sf];
        var vn = v[0] * n[0] + v[1] * n[1] + v[2] * n[2];
        if (vn < 0) {
          var tx = v[0] - vn * n[0], ty = v[1] - vn * n[1], tz = v[2] - vn * n[2];
          var keep = 1 - S.f, chk = (sf === 'green' || sf === 'fringe' || sf === 'fairway') ? 0.32 * q.b - 0.12 * q.top : 0.12 * q.b;
          keep = Math.max(0.02, keep * (1 - Math.max(-0.25, Math.min(0.75, chk))));
          var e = S.e * (Math.abs(vn) > 3 ? 1 : 0.6);
          v[0] = tx * keep - e * vn * n[0]; v[1] = ty * keep - e * vn * n[1]; v[2] = tz * keep - e * vn * n[2];
          q.b *= 0.5; q.sd *= 0.3;
          if (Math.abs(vn) * e < 0.9) { q.mode = 'roll'; v[1] = 0; }
        }
      }
      return;
    }
    // rolling
    n = normal(H, p[0], p[2]);
    var sf2 = H.surf(p[0], p[2]), S2 = SURF[sf2];
    if (sf2 === 'water') { q.mode = 'water'; q.ev.push({ k: 'water', t: t }); p[1] = H.water; return; }
    if (sf2 === 'oob') { q.mode = 'oob'; q.ev.push({ k: 'oob', t: t }); return; }
    // gravity along the slope
    var gn = -G * n[1], gtx = -gn * n[0], gty = -G - gn * n[1], gtz = -gn * n[2];
    var vh = Math.sqrt(v[0] * v[0] + v[2] * v[2]);
    var fr = S2.mu * G * n[1];
    if (vh > 1e-4) { v[0] += (gtx - fr * v[0] / vh) * DT; v[2] += (gtz - fr * v[2] / vh) * DT; var vh2 = Math.sqrt(v[0] * v[0] + v[2] * v[2]); if ((v[0] * gtx + v[2] * gtz) <= 0 && vh2 < fr * DT * 1.5) { v[0] = 0; v[2] = 0; } }
    else { var gh = Math.sqrt(gtx * gtx + gtz * gtz); if (gh > fr * 1.05) { v[0] += gtx * DT * 0.5; v[2] += gtz * DT * 0.5; } }
    p[0] += v[0] * DT; p[2] += v[2] * DT; p[1] = H.h(p[0], p[2]) + R; v[1] = 0;
    s = Math.sqrt(v[0] * v[0] + v[2] * v[2]);
    if (!noHole && (sf2 === 'green' || sf2 === 'fringe')) {
      var dxh = p[0] - H.cup.x, dzh = p[2] - H.cup.z, dh = Math.sqrt(dxh * dxh + dzh * dzh);
      if (dh < CUP) {
        if (s < 1.45) { q.mode = 'hole'; q.ev.push({ k: 'hole', t: t }); p[0] = H.cup.x; p[2] = H.cup.z; p[1] -= 0.07; return; }
        if (s < 2.6 && !q.lip) { q.lip = 1; var k = 0.55, ang = (dxh * v[2] - dzh * v[0]) > 0 ? 0.6 : -0.6, c = Math.cos(ang), si = Math.sin(ang), nx = v[0] * c - v[2] * si, nz = v[0] * si + v[2] * c; v[0] = nx * k; v[2] = nz * k; q.ev.push({ k: 'lip', t: t }); }
      } else if (dh > 0.3) q.lip = 0;
    }
    if (!q.land) { q.land = p.slice(); q.carry = 0; }
    if (s < 0.03) { var gh2 = Math.sqrt(gtx * gtx + gtz * gtz); if (gh2 <= fr * 1.05) { q.mode = 'rest'; v[0] = v[2] = 0; } }
  }

  /* ---------- helpers for aiming and for the computer players ---------- */
  function lieAt(H, p) { return H.surf(p[0], p[2]); }
  function preview(H, p, shot, lie) { // flight with no wind, until it first lands
    var r = run(H, [{ id: 'p', p: p, shot: shot, lie: lie }], [0, 0], { noHole: true, stopAtLand: !CLUBS[shot.club].putt, maxT: 14 });
    var pts = r.frames.map(function (f) { return [f[0], f[1], f[2]]; });
    return { pts: pts, land: r.res[0].land || r.res[0].p, end: r.res[0].p };
  }
  var fullCache = {};
  function fullCarry(ci) { // carry with 100% power from flat fairway, no wind (for the club list)
    if (fullCache[ci] != null) return fullCache[ci];
    var F = { h: function () { return 0; }, surf: function () { return 'fairway'; }, cup: { x: 1e9, z: 1e9 }, water: -9 };
    var r = run(F, [{ id: 'x', p: [0, R, 0], shot: { club: ci, power: 1, yaw: 0 }, lie: 'fairway' }], [0, 0], { noHole: true, stopAtLand: !CLUBS[ci].putt });
    return (fullCache[ci] = Math.round(CLUBS[ci].putt ? r.res[0].total : r.res[0].carry));
  }
  function suggest(H, p) { // best club for the distance to the pin
    var lie = lieAt(H, p), d = Math.hypot(H.cup.x - p[0], H.cup.z - p[2]);
    if (lie === 'green' || (lie === 'fringe' && d < 18)) return 7;
    for (var i = 6; i >= 0; i--) if (fullCarry(i) * lieFactor(lie, CLUBS[i]) >= d * 0.92) return i;
    return 0;
  }
  function botShot(H, p, wind, skill, rnd) { // a computer player's shot
    var lie = lieAt(H, p), ci = suggest(H, p), c = CLUBS[ci];
    var tx = H.cup.x, tz = H.cup.z, d = Math.hypot(tx - p[0], tz - p[2]);
    var reach = c.putt ? 99 : fullCarry(ci) * lieFactor(lie, c) * 1.05;
    if (!c.putt && d > reach) { // lay up along the middle of the fairway
      var z = p[2] + reach * 0.97; for (var k = 0; k < 6; k++) { var x = H.cx(z); var dd = Math.hypot(x - p[0], z - p[2]); z += (reach * 0.97 - dd) * 0.9; }
      tx = H.cx(z); tz = z; d = Math.hypot(tx - p[0], tz - p[2]);
    }
    var yaw = Math.atan2(tx - p[0], tz - p[2]), lo = 0.05, hi = 1, pw = 0.6;
    for (var it = 0; it < 14; it++) {
      pw = (lo + hi) / 2;
      var pr = c.putt ? run(H, [{ id: 'b', p: p, shot: { club: ci, power: pw, yaw: yaw }, lie: lie }], [0, 0], { noHole: true, maxT: 14 }).res[0].total : preview(H, p, { club: ci, power: pw, yaw: yaw }, lie).land;
      var got = c.putt ? pr : Math.hypot(pr[0] - p[0], pr[2] - p[2]);
      var want = c.putt ? d + 0.35 : d * (lie === 'green' ? 1 : 0.93);
      if (got < want) lo = pw; else hi = pw;
    }
    if (!c.putt) { // lean into the wind a little
      var flight = 2 + d / 45; yaw -= Math.atan2(wind[0] * flight * 0.55 * Math.cos(yaw) - wind[1] * flight * 0.55 * Math.sin(yaw), d);
      pw *= 1 - (wind[0] * Math.sin(yaw) + wind[1] * Math.cos(yaw)) * 0.012;
    }
    var e = (rnd() + rnd() + rnd() - 1.5) * (1 - skill) * (c.putt ? 3.2 : 6);
    return { club: ci, power: Math.max(0.05, Math.min(1, pw * (1 + (rnd() - 0.5) * (1 - skill) * (c.putt ? 0.18 : 0.12)))), yaw: yaw, err: e, side: 0, spin: 0 };
  }
  return { R: R, CUP: CUP, CLUBS: CLUBS, SURF: SURF, rng: rng, makeHole: makeHole, run: run, preview: preview, fullCarry: fullCarry, suggest: suggest, botShot: botShot, normal: normal, lieAt: lieAt, lieFactor: lieFactor };
})();

// ---------------------------------------------------------------- Gully Golf (everyone plays the same hole at once; the server runs the ball physics)
const GF_COLS = ['#f5d33d', '#58c4ff', '#ff7aa8', '#b6ea6a', '#c79bff', '#ff9f43', '#4be0c8', '#f2f2f2'];
function gfTee(H, i) { const row = Math.floor(i / 4), col = i % 4, x = -3.6 + col * 2.4, z = 0.5 - row * 2.6; return [x, H.h(x, z) + GolfSim.R, z]; }
function gfStart(room) {
  const cands = [...room.players.values()].filter((p) => !p.left && p.connected);
  if (!cands.length) return 'Nobody to play';
  const ids = cands.slice(0, 8).map((p) => p.id);
  for (const p of room.players.values()) p.watch = !ids.includes(p.id);
  room.gf = { ids, holes: room.gfSet.holes, hole: 0, n: 0, round: 0, P: {}, card: [], last: null };
  ids.forEach((id, i) => { room.gf.P[id] = { c: GF_COLS[i], total: 0, pos: [0, 0, 0], strokes: 0, done: false, holed: false, locked: false, shot: null, lie: 'tee' }; });
  gfHole(room);
  for (const id of ids) { const q = room.players.get(id); if (q) notify(room, q, '⛳ Golf started', 'Tee off!', [80, 40, 80]); }
  return null;
}
function gfHole(room) {
  const g = room.gf; g.hole++;
  g.seed = crypto.randomInt(1, 1e9); g.H = GolfSim.makeHole(g.seed, g.hole === 1 ? 4 : undefined); g.par = g.H.par;
  const ws = Math.random() < 0.15 ? Math.random() * 1.5 : 1.5 + Math.random() * 5.5, wa = Math.random() * 6.283;
  g.wind = [Math.round(Math.sin(wa) * ws * 100) / 100, Math.round(Math.cos(wa) * ws * 100) / 100];
  g.ids.forEach((id, i) => { const P = g.P[id]; Object.assign(P, { pos: gfTee(g.H, i), strokes: 0, done: false, holed: false, locked: false, shot: null, lie: 'tee' }); });
  g.last = null;
  gfRound(room, true);
}
function gfActive(room) { const g = room.gf; return g.ids.filter((id) => !g.P[id].done); }
function gfRound(room, first) {
  const g = room.gf; g.round++;
  for (const id of g.ids) { const P = g.P[id]; P.locked = false; P.shot = null; P.lie = GolfSim.lieAt(g.H, P.pos); }
  setPhase(room, 'gaim');
  const ms = room.gfSet.secs * 1000 + (first ? 2500 : 600);
  g.endAt = Date.now() + ms;
  schedule(room, ms, () => gfLaunch(room));
  broadcast(room);
}
function gfNum(v, lo, hi, d) { v = Number(v); return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d; }
function gfShot(room, p, m) {
  const g = room.gf; if (!g || room.phase !== 'gaim' || !g.ids.includes(p.id)) return;
  const P = g.P[p.id]; if (P.done || P.locked) return;
  const s = m.shot || {};
  P.shot = { club: Math.round(gfNum(s.club, 0, 7, 0)), power: gfNum(s.power, 0.02, 1, 0.5), yaw: gfNum(s.yaw, -7, 7, 0), err: gfNum(s.err, -9, 9, 0), side: gfNum(s.side, -1, 1, 0), spin: gfNum(s.spin, -1, 1, 0) };
  P.locked = true;
  const need = gfActive(room).filter((id) => { const q = room.players.get(id); return q && q.connected && !q.left; });
  if (need.every((id) => g.P[id].locked)) { const left = g.endAt - Date.now(); if (left > 700) { g.endAt = Date.now() + 700; schedule(room, 700, () => gfLaunch(room)); } }
  broadcast(room);
}
function gfLaunch(room) {
  const g = room.gf; if (!g || room.phase !== 'gaim') return;
  const H = g.H, shots = {}, starts = {}, lies = {}, done = {};
  for (const id of g.ids) {
    const P = g.P[id]; starts[id] = P.pos; lies[id] = P.lie; done[id] = P.done;
    if (P.done) continue;
    if (!P.shot) { // missed the timer: soft shot at the pin
      const c = GolfSim.suggest(H, P.pos);
      P.shot = { club: c, power: GolfSim.CLUBS[c].putt ? 0.3 : 0.5, yaw: Math.atan2(H.cup.x - P.pos[0], H.cup.z - P.pos[2]), err: (Math.random() - 0.5) * 6, side: 0, spin: 0, auto: 1 };
    }
    shots[id] = P.shot;
  }
  const balls = g.ids.map((id) => (done[id] ? { id, p: starts[id], done: true } : { id, p: starts[id], shot: shots[id], lie: lies[id] }));
  const sim = GolfSim.run(H, balls, g.wind);
  const res = {};
  sim.res.forEach((r) => { res[r.id] = { end: r.end, p: r.p.map((v) => Math.round(v * 1000) / 1000), surf: r.surf }; });
  g.n++; g.last = { n: g.n, shots, starts, lies, done, res, t: sim.t };
  setPhase(room, 'gfly');
  schedule(room, Math.round((0.35 + sim.t / 1.3 + 1.6) * 1000), () => gfAfter(room));
  broadcast(room);
}
function gfAfter(room) {
  const g = room.gf; if (!g || room.phase !== 'gfly' || !g.last) return;
  const H = g.H;
  for (const id of g.ids) {
    const P = g.P[id], r = g.last.res[id]; if (P.done || !r) continue;
    P.strokes++;
    if (r.end === 'hole') { P.done = true; P.holed = true; P.pos = [H.cup.x, H.h(H.cup.x, H.cup.z), H.cup.z]; }
    else if (r.end === 'water' || r.end === 'oob') P.strokes++;
    else P.pos = r.p;
    if (!P.done && P.strokes >= g.par + 5) P.done = true; // picked up
  }
  const still = gfActive(room).filter((id) => { const q = room.players.get(id); return q && !q.left; });
  if (!still.length) return gfHoleDone(room);
  gfRound(room, false);
}
function gfHoleDone(room) {
  const g = room.gf, s = {};
  for (const id of g.ids) { const P = g.P[id]; s[id] = { n: P.strokes, holed: P.holed }; P.total += P.strokes - g.par; }
  g.card.push({ hole: g.hole, par: g.par, s });
  if (g.hole >= g.holes) { setPhase(room, 'gover'); return broadcast(room); }
  setPhase(room, 'ghole'); schedule(room, 7000, () => gfHole(room)); broadcast(room);
}
function gfCheck(room) { // somebody left
  const g = room.gf; if (!g || !['gaim', 'gfly', 'ghole'].includes(room.phase)) return broadcast(room);
  g.ids = g.ids.filter((id) => { const q = room.players.get(id); return q && !q.left; });
  if (!g.ids.length) { setPhase(room, 'lobby'); room.gf = null; return broadcast(room); }
  if (room.phase === 'gaim') { const need = gfActive(room).filter((id) => room.players.get(id).connected); if (!need.length) return gfLaunch(room); }
  broadcast(room);
}
function gfView(room) {
  const g = room.gf, P = {};
  for (const id of g.ids) { const q = g.P[id]; P[id] = { c: q.c, pos: q.pos, strokes: q.strokes, done: q.done, holed: q.holed, locked: q.locked, total: q.total }; }
  return { ids: g.ids, hole: g.hole, holes: g.holes, seed: g.seed, par: g.par, wind: g.wind, round: g.round, n: g.n, endAt: g.endAt, P, last: room.phase === 'gfly' ? g.last : null, card: g.card };
}

function handle(ws, m) {
  if (!m || typeof m.t !== 'string') return;
  // ---- before joining a room
  if (m.t === 'create') {
    const name = clean(m.name, 14);
    if (!name) return errTo(ws, 'Enter your name');
    const room = makeRoom(loadWords(m));
    if (m.game === 'football' || m.game === 'race' || m.game === 'uno' || m.game === 'cricket' || m.game === 'draw' || m.game === 'golf') room.game = m.game;
    if (m.open === false) room.open = false;
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
    if (room.game === 'draw') dwJoined(room, np);
    if (room.phase !== 'lobby' && room.phase !== 'over' && room.phase !== 'fover' && room.phase !== 'rover' && room.phase !== 'uover' && room.phase !== 'cover' && room.phase !== 'gover' && room.game !== 'draw') { np.watch = true; notice(room, '👀 ' + name + ' joined. Watching until the next game'); }
    return attach(ws, room, np);
  }
  if (m.t === 'rooms') { if (Date.now() - (ws.roomsAt || 0) < 700) return; ws.roomsAt = Date.now(); return send(ws, { t: 'rooms', list: openList(), online: wss.clients.size }); }
  if (m.t === 'req') { // ask the host to let me in
    if (ws.ctx) return;
    const name = clean(m.name, 14), cid = clean(m.cid, 24) || 'x';
    const room = rooms.get(clean(m.code, 4).toUpperCase());
    const no = (msg) => send(ws, { t: 'reqres', ok: false, msg });
    if (!name) return no('Set your name first');
    if (!room || room.open === false || room.phase !== 'lobby') return no('That room is not open any more');
    if ([...room.players.values()].filter((q) => !q.left).length >= MAX_PLAYERS) return no('Room is full');
    if ([...room.players.values()].some((q) => !q.left && norm(q.name) === norm(name))) return no('That name is already in the room. Change your name in Profile');
    if (room.blocked.has(cid)) return no('The host declined your request');
    if ((room.cool.get(cid) || 0) > Date.now()) return no('Wait a minute before asking again');
    if (ws.pend) dropReq(rooms.get(ws.pend.room), ws.pend, null);
    if ([...room.pending.values()].some((r) => r.cid === cid)) return no('You already asked this room');
    if (room.pending.size >= 5) return no('The host has too many requests. Try again soon');
    const r = { id: Math.random().toString(36).slice(2, 8), ws, name, cid, photo: okPhoto(m.photo) ? m.photo : null, room: room.code };
    r.tm = setTimeout(() => dropReq(rooms.get(r.room), r, 'The host did not reply'), 60000);
    room.pending.set(r.id, r); ws.pend = r;
    send(ws, { t: 'reqwait', code: room.code });
    return broadcast(room);
  }
  if (m.t === 'reqcancel') { const r = ws.pend; if (r) dropReq(rooms.get(r.room), r, null); return; }
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
    case 'ckset': {
      if (!hostOnly() || room.game !== 'cricket' || room.phase !== 'lobby') return;
      const s = room.ckSet;
      if (m.mode === 'team' || m.mode === 'solo') s.mode = m.mode;
      if ([1, 2, 3, 5].includes(Number(m.overs))) s.overs = Number(m.overs);
      if ('building' in m) s.building = !!m.building;
      if ('onetip' in m) s.onetip = !!m.onetip;
      return broadcast(room);
    }
    case 'ckshuffle': if (!hostOnly() || room.game !== 'cricket' || room.phase !== 'lobby') return; ckShuffle(room); return broadcast(room);
    case 'ckmove': { if (!hostOnly() || room.game !== 'cricket' || room.phase !== 'lobby') return; const t = ckTeams(room), id = String(m.id); if (t[id] === 0 || t[id] === 1) t[id] = 1 - t[id]; return broadcast(room); }
    case 'ckstart': { if (!hostOnly() || room.game !== 'cricket' || !['lobby', 'cover'].includes(room.phase)) return; const err = ckStart(room); return err ? errTo(ws, err) : undefined; }
    case 'cklobby': if (!hostOnly() || room.game !== 'cricket' || room.phase === 'lobby') return; return ckBack(room);
    case 'ckpos': { // a fielder moves their spot (the bowler can move anyone)
      const c = room.ck; if (room.game !== 'cricket' || room.phase !== 'cfield' || !c) return;
      const id = m.id && p.id === c.bowler ? String(m.id) : p.id; if (!c.field[id]) return;
      let x = Number(m.x), y = Number(m.y); if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      const r = Math.hypot(x, y); if (r > CK_R - 2) { x *= (CK_R - 2) / r; y *= (CK_R - 2) / r; }
      if (Math.abs(x) < 3 && y > -4 && y < 24) x = x < 0 ? -3 : 3; // keep off the pitch
      c.field[id] = { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, s: null };
      return broadcast(room);
    }
    case 'ckready': { const c = room.ck; if (room.game !== 'cricket' || room.phase !== 'cfield' || !c || (p.id !== c.bowler && p.id !== room.hostId)) return; return ckBowlPhase(room); }
    case 'ckbowl': { const c = room.ck; if (room.game !== 'cricket' || room.phase !== 'cbowl' || !c || p.id !== c.bowler) return; return ckDeliver(room, m); }
    case 'ckshot': {
      const c = room.ck; if (room.game !== 'cricket' || !c || c.step !== 'bat' || p.id !== c.striker || !c.del || m.n !== c.del.n) return;
      c.lock = { th: Math.max(-140, Math.min(140, Number(m.th) || 0)), s: Math.max(0, Math.min(1, Number(m.s) || 0)), loft: !!m.loft, def: !!m.def };
      return send(ws, { t: 'cklock', n: c.del.n });
    }
    case 'ckact': { const c = room.ck; if (room.game !== 'cricket' || !c || !c.ch || c.ch.id !== p.id || m.n !== c.ch.n) return; return ckChRes(room, c.ch.n, !!m.ok); }
    case 'vjoin': { // live voice: join (max 6, phones connect to each other directly)
      if (p.voice) return;
      if ([...room.players.values()].filter((q) => q.voice && q.connected && !q.left).length >= 6) return errTo(ws, 'Voice is full (6 people max)');
      p.voice = true; return broadcast(room);
    }
    case 'vleave': { if (!p.voice) return; p.voice = false; return broadcast(room); }
    case 'vsig': { // pass call setup between two phones in this room
      const q = room.players.get(String(m.to));
      if (!p.voice || !q || q === p || !q.voice || !q.ws || !q.connected || !m.d || typeof m.d !== 'object') return;
      if (JSON.stringify(m.d).length > 12000) return;
      return send(q.ws, { t: 'vsig', from: p.id, d: m.d });
    }
    case 'reqans': {
      if (!hostOnly()) return;
      const r = room.pending.get(String(m.id));
      if (!r) return;
      if (!m.ok) { room.cool.set(r.cid, Date.now() + 60000); if (m.block) room.blocked.add(r.cid); return dropReq(room, r, 'The host declined your request'); }
      dropReq(room, r, null);
      if (!r.ws || r.ws.readyState !== 1 || r.ws.ctx || room.phase !== 'lobby') return;
      if ([...room.players.values()].filter((q) => !q.left).length >= MAX_PLAYERS) return send(r.ws, { t: 'reqres', ok: false, msg: 'Room is full' });
      if ([...room.players.values()].some((q) => !q.left && norm(q.name) === norm(r.name))) return send(r.ws, { t: 'reqres', ok: false, msg: 'That name is already in the room' });
      const np = addPlayer(room, r.name);
      if (room.game === 'draw') dwJoined(room, np);
      if (r.photo) np.photo = r.photo;
      attach(r.ws, room, np);
      if (np.photo) for (const q of room.players.values()) if (q.ws && q.connected) send(q.ws, { t: 'photo', name: np.name, data: np.photo });
      return;
    }
    case 'settings': {
      if (!hostOnly() || room.phase !== 'lobby') return;
      const s = room.settings;
      if ('open' in m) room.open = !!m.open;
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
      const err = fbStart(room, m.ar);
      return err ? errTo(ws, err) : undefined;
    }
    case 'flobby':
      if (!hostOnly() || room.game !== 'football' || !['fover', 'faim', 'fplay', 'pkaim', 'pkshow'].includes(room.phase)) return;
      return fbBack(room);
    case 'fpause': {
      if (!hostOnly() || room.game !== 'football' || room.phase !== 'faim' || !room.fb || room.fb.paused) return;
      clearTimeout(room.timer); room.fb.paused = { left: room.endsAt ? Math.max(1500, room.endsAt - Date.now()) : 3000 }; room.endsAt = 0;
      notice(room, '⏸ Match paused by the host'); return broadcast(room);
    }
    case 'fresume': {
      if (!hostOnly() || room.game !== 'football' || !room.fb || !room.fb.paused) return;
      const fleft = room.fb.paused.left; room.fb.paused = null;
      schedule(room, fleft, () => fbFire(room));
      notice(room, '▶️ Match resumed'); return broadcast(room);
    }
    case 'kick': {
      if (!hostOnly()) return;
      if (room.phase !== 'lobby') return errTo(ws, 'You can only remove people from the lobby');
      const q = room.players.get(String(m.id));
      if (!q || q.id === p.id || q.left) return;
      notice(room, '🚪 ' + q.name + ' was removed by the host');
      removePlayer(room, q, false);
      return;
    }
    case 'switchgame': {
      if (!hostOnly()) return;
      const g = ['undercover', 'football', 'race', 'uno', 'cricket', 'draw', 'golf'].includes(m.game) ? m.game : null;
      if (!g) return;
      if (!['lobby', 'over', 'fover', 'rover', 'uover', 'cover', 'dover', 'gover'].includes(room.phase)) return errTo(ws, 'Finish or end the current game first');
      if (g === room.game && room.phase === 'lobby') return;
      clearTimeout(room.timer); dwClear(room); room.dw = null; room.gf = null; room.seq++;
      room.game = g; room.un = null; room.fb = null; room.pkPick = null; room.rc = null; room.ck = null; room.winner = null; room.guess = null; room.votes = {}; room.tie = false; room.descs = {}; room.history = [];
      for (const [qid, q] of room.players) if (q.left) room.players.delete(qid);
      for (const q of room.players.values()) { q.watch = false; q.alive = true; q.role = null; q.word = ''; q.revealed = false; }
      setPhase(room, 'lobby');
      const gn = { undercover: '🕵️ Undercover', football: '⚽ Football', race: '🏖️ Beach Buggy', uno: '🃏 UNO', cricket: '🏏 Cricket', draw: '🎨 Draw & Guess', golf: '⛳ Golf' }[g];
      notice(room, '🎮 The host switched the game to ' + gn);
      return broadcast(room);
    }
    case 'faim': {
      if (room.phase !== 'faim' || !room.fb || !room.fb.ids.includes(p.id)) return;
      if (room.fb.paused) return errTo(ws, '⏸ Match is paused');
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
    case 'gset': {
      if (!hostOnly() || room.game !== 'golf' || !['lobby', 'gover'].includes(room.phase)) return;
      if ([1, 3, 6, 9].includes(Number(m.holes))) room.gfSet.holes = Number(m.holes);
      if ([8, 12, 20].includes(Number(m.secs))) room.gfSet.secs = Number(m.secs);
      return broadcast(room);
    }
    case 'gstart': {
      if (!hostOnly() || room.game !== 'golf' || !['lobby', 'gover'].includes(room.phase)) return;
      const e = gfStart(room); return e ? errTo(ws, e) : undefined;
    }
    case 'gshot': { if (room.game !== 'golf') return; return gfShot(room, p, m); }
    case 'gnext': { if (!hostOnly() || room.game !== 'golf' || room.phase !== 'ghole') return; return gfHole(room); }
    case 'globby': {
      if (!hostOnly() || room.game !== 'golf' || room.phase === 'lobby') return;
      setPhase(room, 'lobby'); room.gf = null;
      for (const [qid, q] of room.players) if (q.left) room.players.delete(qid);
      for (const q of room.players.values()) q.watch = false;
      return broadcast(room);
    }
    case 'dset': {
      if (!hostOnly() || room.game !== 'draw' || !['lobby', 'dover'].includes(room.phase)) return;
      const s = room.dwSet;
      if ([2, 3, 4, 5, 8].includes(Number(m.rounds))) s.rounds = Number(m.rounds);
      if ([40, 60, 80, 100, 120, 150].includes(Number(m.secs))) s.secs = Number(m.secs);
      if ([0, 1, 2, 3].includes(Number(m.hints))) s.hints = Number(m.hints);
      return broadcast(room);
    }
    case 'dstart': {
      if (!hostOnly() || room.game !== 'draw' || !['lobby', 'dover'].includes(room.phase)) return;
      if (dwActive(room).filter((q) => q.connected).length < 2) return errTo(ws, 'Need at least 2 players');
      for (const [qid, q] of room.players) if (q.left) room.players.delete(qid);
      dwClear(room); dwNew(room);
      return dwNext(room);
    }
    case 'dpick': { const d = room.dw; if (room.game !== 'draw' || !d || room.phase !== 'dpick' || p.id !== d.drawer || d.paused) return; return dwPick(room, Number(m.i)); }
    case 'dop': {
      const d = room.dw; if (room.game !== 'draw' || !d || room.phase !== 'ddraw' || p.id !== d.drawer || d.paused || !Array.isArray(m.ops)) return;
      const out = [];
      for (const raw of m.ops.slice(0, 40)) { const c = dwClean(raw); if (c && dwApply(d, c)) out.push(c); }
      if (out.length) for (const q of room.players.values()) if (q.id !== p.id && q.ws && q.connected) send(q.ws, { t: 'dops', ops: out });
      return;
    }
    case 'dpause': {
      const d = room.dw; if (!hostOnly() || room.game !== 'draw' || !d || !['dpick', 'ddraw'].includes(room.phase)) return;
      if (d.paused && d.paused.hold) { d.endAt = Date.now() + d.paused.left; d.paused = null; dwSys(room, '▶️ Host resumed the game'); dwTimer(room); return broadcast(room); }
      if (d.paused) return;
      d.paused = { left: Math.max(1500, d.endAt - Date.now()), hold: 1 }; clearTimeout(d.tm); dwSys(room, '⏸ Host paused the game'); return broadcast(room);
    }
    case 'dguess': { if (room.game !== 'draw' || !room.dw) return; return dwGuess(room, p, m.text); }
    case 'dtime': {
      const d = room.dw; if (!hostOnly() || room.game !== 'draw' || !d || room.phase !== 'ddraw') return;
      const add = Number(m.add); if (![10, 20, 30].includes(add)) return;
      if (d.extra >= 180) return errTo(ws, 'That is already a lot of extra time');
      d.extra += add; if (d.paused) d.paused.left += add * 1000; else d.endAt += add * 1000; d.more = {};
      dwSys(room, '⏱ Host added +' + add + ' seconds'); return broadcast(room);
    }
    case 'dmore': {
      const d = room.dw; if (room.game !== 'draw' || !d || room.phase !== 'ddraw' || d.more[p.id]) return;
      d.more[p.id] = p.name; return broadcast(room);
    }
    case 'dskip': {
      const d = room.dw; if (room.game !== 'draw' || !d || room.phase !== 'ddraw' || p.id === d.drawer) return;
      if (d.skip[p.id]) delete d.skip[p.id]; else d.skip[p.id] = 1;
      const need = Math.floor(dwEligible(room).length / 2) + 1;
      if (Object.keys(d.skip).length >= need) { dwSys(room, '🗳️ Players voted to skip this drawing'); return dwEnd(room, 'skipped'); }
      return broadcast(room);
    }
    case 'dforce': {
      const d = room.dw; if (!hostOnly() || room.game !== 'draw' || !d) return;
      if (['dpick', 'ddraw'].includes(room.phase)) { dwSys(room, '⏭️ Host skipped this turn'); return dwEnd(room, 'skipped'); }
      if (room.phase === 'dres') return dwNext(room);
      return;
    }
    case 'dlike': {
      const d = room.dw; if (room.game !== 'draw' || !d || room.phase !== 'dres' || p.id === d.drawer || d.liked[p.id]) return;
      d.liked[p.id] = 1; d.likes[d.drawer] = (d.likes[d.drawer] || 0) + 1; return broadcast(room);
    }
    case 'dlobby': {
      if (!hostOnly() || room.game !== 'draw' || room.phase === 'lobby') return;
      dwClear(room); room.dw = null; clearTimeout(room.timer);
      for (const [qid, q] of room.players) if (q.left) room.players.delete(qid);
      setPhase(room, 'lobby'); return broadcast(room);
    }
    case 'uset': {
      if (!hostOnly() || room.game !== 'uno' || room.phase !== 'lobby') return;
      if ([0, 10, 20, 30].includes(Number(m.secs))) room.unSet.secs = Number(m.secs);
      if (U_MODES.includes(m.mode)) room.unSet.mode = m.mode;
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
    case 'uplay': { if (room.game !== 'uno') return; if (room.un && room.un.paused) return errTo(ws, '⏸ Game is paused'); const e = unPlay(room, p, m.cards, m.color, m.target); return e ? errTo(ws, e) : undefined; }
    case 'udraw': { if (room.game !== 'uno' || (room.un && room.un.paused)) return; const e = unDraw(room, p, false, m.color); return e ? errTo(ws, e) : undefined; }
    case 'upass': if (room.game === 'uno' && !(room.un && room.un.paused)) unPass(room, p); return;
    case 'uuno': { if (room.game !== 'uno' || (room.un && room.un.paused)) return; const e = unUno(room, p); return e ? errTo(ws, e) : undefined; }
    case 'ucatch': { if (room.game !== 'uno' || (room.un && room.un.paused)) return; const e = unCatch(room, p); return e ? errTo(ws, e) : undefined; }
    case 'uskip': { if (!hostOnly() || room.game !== 'uno') return; const e = unSkip(room, p); return e ? errTo(ws, e) : undefined; }
    case 'rset': {
      if (!hostOnly() || room.game !== 'race' || room.phase !== 'lobby') return;
      room.rcSet = { map: m.map === 'f1' ? 'f1' : 'beach' };
      return broadcast(room);
    }
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
      const d = Number(m.d), x = Number(m.x), sp = Number(m.sp), hh = Number(m.h) || 0, ts = Number(m.ts);
      if (![d, x, sp].every(Number.isFinite)) return;
      r.cars[p.id] = [p.id, Math.round(d), Math.round(Math.max(-3, Math.min(3, x)) * 1000) / 1000, Math.round(Math.max(0, Math.min(40000, sp))), (Number(m.f) | 0) & 127, Math.round(Math.max(0, Math.min(5000, hh))), Number.isFinite(ts) ? Math.round(ts) : null, (p.rseq = ((p.rseq || 0) + 1) % 1e6)];
      r.dirty = true;
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
      if (d !== null && (typeof d !== 'string' || !/^data:image\/(jpeg|webp|png);base64,[A-Za-z0-9+/=]+$/.test(d) || d.length > 16000)) return errTo(ws, 'Photo too big');
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
      if (room.game === 'draw' && room.phase !== 'lobby' && room.phase !== 'dover') return errTo(ws, 'Use the guess box');
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
  ws.isAlive = true; ws.rl = 0; ws.rh = 0;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => {
    ws.isAlive = true;
    let m;
    try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    const hot = m && (m.t === 'dop' || m.t === 'dguess' || m.t === 'rpos' || m.t === 'ckpos' || m.t === 'rprog' || m.t === 'rbump' || m.t === 'vsig' || m.t === 'ping');
    if (hot ? ++ws.rh > 260 : ++ws.rl > 40) return; // flood guard (reset every 5s); race positions & voice setup have their own, bigger budget
    try { handle(ws, m); } catch (e) { console.error('handler error:', e); }
  });
  ws.on('close', () => {
    const ctx = ws.ctx;
    const room = ctx && rooms.get(ctx.code);
    const p = room && room.players.get(ctx.pid);
    if (ws.pend) dropReq(rooms.get(ws.pend.room), ws.pend, null);
    if (p && p.ws === ws) { p.ws = null; p.connected = false; p.voice = false; p.discAt = Date.now(); if (room.game === 'draw' && room.dw) dwDisc(room, p); broadcast(room); }
  });
  ws.on('error', () => {});
});

setInterval(() => { for (const c of wss.clients) { c.rl = 0; c.rh = 0; } }, 5000);
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

module.exports = { GolfSim, server, rooms, broadcast, pickPair, cleanModes, pairKey, COOLDOWN, MEME_SHARE, pickImpostors, spreadOrder };
