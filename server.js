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
  start_url: '/', scope: '/', display: 'standalone', orientation: 'any', background_color: '#FFF8E7', theme_color: '#FFF8E7',
  icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png' }],
});
const ICONS = {
  '/icon-192.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAMAAAADACAIAAADdvvtQAAAQAElEQVR4AeydCVxU1RfHGURQEVBwQwQ1NTdw7+9WIFpiJWn9I8H8KIjbX4E0xTQXXLLQ0lzSTBT8qOBuIBlKaChYopaChSmi4gZuaAoKiMz/jI+m2Zh5b+at9x0+h+d99917zrm/8/XNY95jsHZq0AoNFTBbAWsr/EIFLFAAAbJAPJxqZYUAIQUWKYAAWSQfTkaAkAGLFECALJIPJ5sNEEqHCqgUQIBUKuC32QogQGZLhxNVCiBAKhXw22wFECCzpcOJKgUQIJUK+G22AgiQ2dLhRJUC/AOkiorfxCiAABFTSmEWggAJozsxUREgYkopzEIQIGF0JyYqAkRMKYVZCAIkjO7ERJUQQMRoTtRCECCiysn/YhAg/jUnKiICRFQ5+V8MAsS/5kRFFAygJs1cvV9/Iyg4ZNqnc6bPiyLYgv832aa2LVHUaCxGGICG+A9b8OVXo0LH+foN6ejVpX2nTgRbP2+fydOn29SurSE7OU2+AXJwdJw2Z+57I0fa2NjwpaLwcTy7dps8fQaRDPENUL8BAzt6eglfUt4zIJUhXgFy8/AYFhDAe+3EEtCTxPMQrwD5vuFn5JWrXu1yd4f7bRvcJsOa1nuoTy55DPEKUIuWLfU1pXqa2xd7u13o7HKTDHpgFQ625c51SqnVaW4JY4g/gBQKhZuHh6aUmu02De5q7pLRLi6zJ54h/gBSKpV2dnY1kKGsZ1NewyFpdxPPEH8AGQUBTk9GjwtzkJ2oZDMkEoDYKZVovRDMEALEE3WkMoQA8QQQhCGSIQQIKsufkccQAsQfPVQkwhhCgKiy8roliSEEiAt0TPskhiEEyHSxORpBBkMIEEd40HJLAEMIEK1KczdI6gwhQNyxQdezpBlCgOiWmdNx0mUIAeIUDAbOJcoQAsSgxlwPLS6T3vNDCBDXVDDzL7nzEALErMA8jJYWQwgQD0gwDiEhhhAgxtXlZ4JUGEKA+OHBnCiSYAgB0irto5KnP/6c+8Xa1Imzd4wM36w22IVOOFT6hNeH/8XPEAKkAqis/Fn896dGTInt/uay8Pm7N+74NS3zQtbZArXBLnTCoS5+0YFhcduTTsMU1Uzuv+kxxH0eNURAgKwyT+V7B6ycv+LH0znXa1BJq/tU9rW5Xx2AKceyLmkd4GxHzAzJHaCExNMhM+LvP3jCtPowJXRmwpa9J5lONG+8aBmSNUDJaefmrzhQVaU0r6gwcdGqFHh1M28601niZEi+AF28cmdW9H6lmfBUVx+mT1249+LlO9X7Gv/Y1arU2GOnKUKGZArQ07JnEfP3lJWzUGOVqwV7njyt0GHEofZTnR5WdsXGkEwB2p70W95V1j7OIe/K3R37f9fhw8nuiaMt40srHScGd0XFkBwBelxStj4+02BtzO78LiET3GpOVyisOrvc1Oxhsc0eQ5YmJUeAYneduP/AwCf3WKLlveJScKvjwcnuqVv9BzqdbO0aYajy2TO2opj0IzuAih+Wxu48YVIXMwbE7Trx92Pd6x6vRtd93XNbOd51smP/5awmhsxI3uwpsgNo1w9nSri5HfG4tBwurfQrAT+OdXAu7Ot6aUirHNbtP83y9SPy2SMvgCorq7bu4/Ctv23fn4IQfNZP8FjyAigl/c+iu4+5E73wziMIwZ1/EXqWF0BwhuC6BjyE4HoJjPzLCKDrtx7QvF3KSEGdwRDi2i2ufvLSiSXobnVwGQG072B29aI5/ud7vgJxvA5a7uUCkFKp5BMgCEdLfukPkgtAWWcLbhQa+Oh4Lip4vfAhhOPCswh9ygWgxEOGX78G9ms3ZfRrLg3rWVIbGxvrYYO9poUOUDvZn3pO3Sa7IQuA4AXl6AkDTw862NstmTn04/EDs5JmHE4IX7MoAGAaOqizZ3vXenVr/PNetWpZt3Z3AfJCAnovmemfGDMu++CsFfPeCwv2GdCnrdWLr6NZeRD0RZPwjSwAys0runO/RL+Sr3T1qFdX9eH5CoWilbvzW76dAKZVC95P2jjhXOqn+RlRBu1i+ry0hLCYpSPnRgwJ9O/h1cGtjl01bb5921FR4N0mCEq1yd7KAqCMk/kGq3jkl7x+w5d/tvpgxslLpU90H+gxOEW/E840f1wojNl+fGDQmqivU9QDMmoIqh5ARoM5QBJcd2rG+ZqyLn36LG53VvD0+G5vRr87YePE2Ttmfp4ISK2OO7pp5687k38/cOTPoyfyjp++fOhoLvwct2Vv1prNR6PX/TRn2f6webs+jNjc1S962LgN0evSCm4Ua0Y5xtcj95pB+W+TD9DDR0+yc2+ZVLaqSplz/mZa5oW9KdmA1KrY9M+/Sf10WXJE1J6xkQmjp22dPHd35JLEhSsPrtyUHrP9lx3JZ1LSz584U1Cq9ywiFQt+EIPQVJvgLfkAZedy9VSXSSwEDG0yN7YGkA/QWeEAEjA0W3yY9EM+QFlnrppUgaMBAobmaEX6bgkHqLy88kzuDf1l89MDoSEBfmIJFYVwgP7MK6yoeC6UuBAaEhAqOj9xeQSInwVpR/nr0m3tDhN78KYOZfrjqH7Y6h8y0sM0ASOuxHmIcID0TwBAgLZZqXehQvCWNGXQ1jGqH7bQr56iVP47neqEo5qmn4DmUQLahAN0/lKRuq5UsYEAbbNS79Ivp3qKQvHvdMWLLyqcenvl2n36bqU4kliA7hWXfBefmZ1760VZFVAbhUJVbGhwagrtr9M51zckHIdkOA0qoHMCAco5f2Pqwn29hy1ftv6wgMpSoZ9XVS39Ng2SmbZoH5G3V4kCKO/KnZAZ8e9O2JScJrrHcfb/dM5/7Hdwr63gBlEvauQAtG5LxpDR34r8FibcaxsY9A3rv5lPne0E2UoBIBrCwL3P5TFHaAwUxZAv1x+GhEWRisVJkABQ0d1Ha7ccs1gKXh1AwoV3HvEakptgJACUeSr/+XPLPmmMG3GNeIWEj5/ONzJAKodIAKhZY0epyK2Zp0TT1lwCtEkA6NVX2kwNHWBnawPrkYRBqpAwpC2JbI0nSQJAsMLwYJ/0nRGTRvV3a+oEu6I1SC882BtSDQ/2EW2SjBIjBCBYc5NGDpETXz+2Z+re9aFffOI/9oM+dexEcU6CNCAZSClx43hIb2qoL6QKCZNh5ACkrke3zi0+GNpjTrifaxPqbKS+MaXbUE+xsEHdZXvhXeveqpWV6tK+tbsLJAMpebVvbmEgEU4nECC1ymkJYS9+sWvB5UzDdiZlZlp82M61IfGrx1C27rOAzyKHTh8/MCLER8egEw7BAGokbHetCzmcEH724CeXM6P+CaFuqCLmZyyABH6Im6ROibwGyQCZrJZj/bqtPVx6dfHo070VZX4+nYLe6Tl59GsfjR2gY9AJh2AANRK2Pb08Wrk7O9jXMRmI4AGyBojguvK2NASIN6nJDIQAkVlX3laFAPEmNZmBECBDdcU+2gogQLSlwoGGFECADKmCfbQVQIBoS4UDDSmAABlSBftoK4AA0ZYKBxpSAAEypAr20VYAAaItFZ2B8htDAkAXL99eFZvOuiUknn5UovoDctv3/8a689VxR0+eLSCANxIAcm3qtGnHL1ASdm3e8gN9hq1YsubQg4el7HoGb0BkUPjmwaPWZp6S9qP1JADkYF9n5PBXuPjfXF5RGbvrRGrGX3a2nDzcmF9wb8zH2xIP5XCRPD8+SQAIlAoO6F2rlgIaZphS9digsXk55291bNvE2AjLjs1euv9xSZllPgSbTQhAzRo7+g/yNENFpVKpMAWeQqE4d0H1MTFm+KczpeLZ85T0XDojRTiGEIBA2dDAfrDlyJ4/r+rp5c6Rc3D7+x/XYStFIwegTu2a9evZmrsa9OneijvnN4v+5s45p57JAQhkGhfYF7ZcGLzS9VY9N92SC+fg8xFeA4EKgptPn3at3V0YpQHXN0pTF9FAD/iEkeMC+0MDTVMBos5AsLBJoxjXWEHjIlqhUA0a0LctU0AhJbKNNICGD+7q3MCiPz9opN4KhWLCSA4v1Y2EFu0h0gCysbEOHcHVlRBUcbgfh4CCf8kZaQBBAYKG9YQt6wZogk/b2rVG+PeABrtmbS3VQkg1byP1c3Ko6+jA/m+LNnSsSwVt4dqQarC4dTH7ZZfFJMxyRSBAoENj5/qwZdfUH6nRxMWeXc/grWkj9hMGtzwYmQB5tXdlVzsPt4YNHKuvzb3au7HrHLx5dmDfJ7jlwcgEqC/bb0lrvsfd2KV+m5aN2K1N/14vseuQN29kAuTn3dGJ1cugMf/trVkSdq+j4SaJR3P2r6s0E+auTSZADvXrhI1h7TPkhg/2evmlJpo1gHcK3Nj7LL054X6azqXVJhMgqEFwQO+uHVm4sGjkbB819S1wqGOrF72vUL07rdPNePejsQPgNjDjaaKZQCxA1taKbxYHNG9q0ScA29e1Xb8k0OCbAt06tZg9ZbCFdRzU/+WIENbOlMySYWk0sQCBPs2bOiXHThzY72Vom2FeHZonx07o7tmiprnwQrYhOhBOUTUNMN4P554N0UHGx4j/KMkAgfrws3fM0qC0+LBxgX1pVrp+PbvAd3rs+TY0MWZ8yxYm7u0P6t8+K2nGyqj3vHu3hXB0zLO965wwvzMpM6V+7qEWSzhA1CJbe7jAyw1UeufakOVz342cNAiKp2Mfj/ONnvXOtlWjsw/NWhLpb+TEQ/nU3Pq/7hX31YenkmcArIunv/3RWB8d57AL0KxZFHBke1jSxgljR/RxrF/9vramHym2ZQGQujC9ungM9+sy6cNX4eVDx6aM8Q54u3vfHuY/0+jcwB5eLkcO7xURovsBnRALoHnLt5PJU5o6Vak05AWQVKoioTwRIAkVS4ypIkBirIqoc9JODgHS1gP3GCqAADEUDIdrK4AAaeuBewwVQIAYCobDtRVAgLT1wD2GCiBADAXD4doKIEDaeuAeQwUYAMTQMw6XhQIIkCzKzN0iESDutJWFZwRIFmXmbpEIEHfaysIzAiSLMnO3SASIO21l4ZkPgGQhpFwXiQDJtfIsrRsBYklIubpBgORaeZbWjQCxJKRc3SBAcq08S+tGgFgSUq5uRA2QXIsipXUjQFKqlghzRYBEWBQppYQASalaIswVARJhUaSUEgIkpWqJMFcESIRFkVJKZAIkpQpIPFcESOIFFDp9BEjoCkg8PgIk8QIKnT4CJHQFJB5fLAA9fWYrcSWFSV9w3cQCUOETJ2EqIPGoguvGK0CX8/JqqtfFB65/3GtRVNKguMxeQJNQaNAKFAPddCQ1IrLOSFZ2eQXoRkGBkaRvlDifvedxsqgNGh0FQCtQTF/Py5dq/F+qP9jyHl4BSk9LraystDxp9FCTAiDv8fSfazrKRT+vAMEZKGn3bi6WgT4pBUDem9euUW1+trwCBEtKTU66fvUqNNBYVyD/4gWQl3W3xh3yDZBSqVw8+5M927bCydZ4ZniUvgIVFRUJcbFLo+aDvPRnsTKSb4CopFMP/LAgcsbWgOCOSAAAAIBJREFUjTE/Hzp4/lzOhdxcNDMUAOlAwG2bNi6cGZmeeojSluetMADBIu8UFWYcTtu+Oe7rz5csX7xQ6iZI/iAdCHgs7ae7t4tAUkFMMIAEWS0GZV0BBIh1SeXlEAGSV71ZXy0CxLqk8nKIAMmr3qyvFgFiXVJ5OUSABK631MP/HwAA///wTOruAAAABklEQVQDAHHJAWZGVfR0AAAAAElFTkSuQmCC', 'base64'),
  '/icon-512.png': Buffer.from('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', 'base64'),
  '/apple-touch-icon.png': Buffer.from('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', 'base64'),
};

const GOLFER = (() => { // the 3D golfer model (optional file)
  const f = [path.join(__dirname, 'public', 'golfer.json'), path.join(__dirname, 'golfer.json')].find((x) => fs.existsSync(x));
  if (!f) return null; const raw = fs.readFileSync(f); return { raw, gz: zlib.gzipSync(raw, { level: 6 }) };
})();
// ---------------------------------------------------------------- admin, blocking, feedback
// Admin = one phone. The first phone to claim it gets a secret token; put that token in Render as ADMIN_TOKEN
// so the admin phone is still recognised after the free server restarts. Only the token is checked, nothing else.
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'uc-admin.json');
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const ADM = { hash: process.env.ADMIN_TOKEN ? sha(process.env.ADMIN_TOKEN) : '', blockedCids: {}, blockedIps: {}, feedback: [], push: null };
try { // best effort: on the free plan this file is wiped when the server restarts
  const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  if (!ADM.hash && typeof d.hash === 'string') ADM.hash = d.hash;
  if (d.blockedCids) ADM.blockedCids = d.blockedCids;
  if (d.blockedIps) ADM.blockedIps = d.blockedIps;
  if (Array.isArray(d.feedback)) ADM.feedback = d.feedback.slice(-300);
  if (d.push && typeof d.push.endpoint === 'string') ADM.push = d.push;
} catch (e) { /* first run */ }
let admSaveT = null;
function admSave() {
  clearTimeout(admSaveT);
  admSaveT = setTimeout(() => { try { fs.writeFileSync(DATA_FILE, JSON.stringify({ hash: ADM.hash, blockedCids: ADM.blockedCids, blockedIps: ADM.blockedIps, feedback: ADM.feedback, push: ADM.push })); } catch (e) { /* read-only disk: fine */ } }, 800);
}
// phone notification for the admin (feedback, reports, username requests, new rooms)
const admNoteAt = {};
function admNotify(title, body, key) {
  if (!webpush || !ADM.push) return;
  const now = Date.now(); if (key) { if (now - (admNoteAt[key] || 0) < 60000) return; admNoteAt[key] = now; }
  webpush.sendNotification(ADM.push, JSON.stringify({ title, body: String(body || '').slice(0, 140), tag: 'adm-' + (key || 'x'), vib: [150, 80, 150], url: '/' }), { TTL: 3600, urgency: 'normal' }).catch((e) => { if (e && (e.statusCode === 404 || e.statusCode === 410)) { ADM.push = null; admSave(); } });
}
const ipOf = (req) => String((req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')).split(',')[0].trim();
function cookieCid(req) { const m = /(?:^|;\s*)uc_cid=([A-Za-z0-9]{4,40})/.exec(req.headers.cookie || ''); return m ? m[1] : ''; }
function queryCid(req) { const m = /[?&]c=([A-Za-z0-9]{4,40})/.exec(req.url || ''); return m ? m[1] : ''; }
const isBlocked = (cid, ip) => !!((cid && ADM.blockedCids[cid]) || (ip && ADM.blockedIps[ip]));
function deviceOf(ua) {
  ua = String(ua || '');
  const os = /iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Unknown';
  const br = /EdgA?\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /Firefox/.test(ua) ? 'Firefox' : /Chrome|CriOS/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : '';
  const mm = /Android[^;]*;\s*([^;)]+?)(?:\sBuild|\))/.exec(ua);
  return (mm ? mm[1].trim() + ' · ' : '') + os + (br ? ' · ' + br : '');
}
const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (isBlocked(cookieCid(req), ipOf(req))) return; // blocked: the page just never loads (no answer, no error)
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
  { const win = c.winner.ids ? c.winner.ids : c.winner.team == null ? [] : [].concat(...c.inns.filter((x) => x.team === c.winner.team).map((x) => x.bat)); recordWins(room, 'cricket', c.ids, win); }
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
    game: 'undercover', dwSet: { rounds: 3, secs: 80, hints: 2 }, dw: null, gfSet: { holes: 3, secs: 8 }, gf: null, bfSet: { diff: 'normal', mode: 't2', goals: 5, head: { o: 0, b: 0 }, bots: { o: 2, b: 2 }, balls: 3 }, bf: null, rkSet: { map: 'snow', mode: 't3', goals: 5, diff: 'normal', bots: { o: 2, b: 3 } }, rk: null, mbSet: { bots: 2, speed: 'normal', shrink: true }, mb: null, cr: null, lz: null, lzSet: { bots: 3, shrink: 'center', time: 15 }, lt: null, ltSet: { bots: 5, floors: 3, speed: 'normal', push: true }, unSet: { secs: 20, mode: 'classic' }, un: null, ckSet: { mode: 'team', overs: 2, building: true, onetip: true }, ck: null, ckTeam: {}, fbSet: { goals: 3, secs: 8, mode: 'match', tie: 'pens' }, fb: null, rc: null,
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
    if (q.ws && q.ws.user) o.fr = 1;
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
    t: 'state', apaused: !!room.apaused, game: room.game, now: Date.now(), code: room.code, phase: room.phase, round: room.round,
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
  if (room.game === 'bully') { v.bfSet = room.bfSet; v.bfMe = {}; for (const q of room.players.values()) if (!q.left) v.bfMe[q.id] = bfOf(room, q); if (room.bf) v.bf = { ids: room.bf.ids, seq: room.bf.seq, res: room.bf.res || null }; }
  if (room.game === 'tapri') { const t = room.tp || {}; v.tp = { votes: t.votes || {}, chai: t.chai || {}, kind: t.kind || {}, spot: t.spot || {}, av: t.av || {}, wall: (t.wall || []).map((x) => ({ id: x.id, by: x.by })), ak: t.ak || null, td: t.td || null, mu: t.mu ? { now: t.mu.now, t: Date.now(), q: t.mu.q.map((x) => ({ id: x.id, tid: x.tid, title: x.title, artist: x.artist, img: x.img, by: x.by, v: Object.keys(x.v).length, vs: Object.keys(x.v) })), keys: !!(process.env.SPOTIFY_ID && process.env.SPOTIFY_SECRET) } : { now: null, t: Date.now(), q: [], keys: !!(process.env.SPOTIFY_ID && process.env.SPOTIFY_SECRET) }, whistle: t.whistle || null, emo: t.emo || {}, sky: t.sky || 'dusk', radio: t.radio | 0, paid: t.paid | 0, score: t.score || '', notes: t.notes || [], ludo: t.ludo || null }; }
  if (room.game === 'lasttile') { v.ltSet = room.ltSet; if (room.lt) v.lt = { ids: room.lt.ids, seq: room.lt.seq, host: room.lt.host, bots: room.lt.bots, floors: room.lt.floors, speed: room.lt.speed, push: room.lt.push }; }
  if (room.game === 'laser') { v.lzSet = room.lzSet; if (room.lz) v.lz = { ids: room.lz.ids, seq: room.lz.seq, host: room.lz.host, bots: room.lz.bots, shrink: room.lz.shrink, time: room.lz.time }; }
  if (room.game === 'carrom') { if (room.cr) v.cr = { ids: room.cr.ids, seq: room.cr.seq, host: room.cr.host }; }
  if (room.game === 'bomb') { v.mbSet = room.mbSet; if (room.mb) v.mb = { ids: room.mb.ids, seq: room.mb.seq, bots: room.mb.bots }; }
  if (room.game === 'rocket') { v.rkSet = room.rkSet; v.rkMe = {}; for (const q of room.players.values()) if (!q.left) v.rkMe[q.id] = rkOf(room, q); if (room.rk) v.rk = { ids: room.rk.ids, seq: room.rk.seq, res: room.rk.res || null, teams: room.rk.teams, bots: room.rk.bots }; }
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
  recordWins(room, 'undercover', [...room.players.values()].filter((x) => x.role).map((x) => x.id), [...room.players.values()].filter((x) => delta[norm(x.name)] && delta[norm(x.name)].won).map((x) => x.id));
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
  room.fb.winner = team; { const ids = fbPlayers(room).map((x) => x.id || x); const f = room.fb; recordWins(room, 'football', ids, ids.filter((id) => f.team && f.team[id] === team)); }
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
  setPhase(room, 'uover'); recordWins(room, 'uno', u.ids, [w]);
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
  if (room.game === 'bully') return bfCheck(room);
  if (room.game === 'rocket') return rkCheck(room);
  if (room.game === 'bomb') return mbCheck(room);
  if (room.game === 'carrom') return crCheck(room);
  if (room.game === 'laser') return lzCheck(room);
  if (room.game === 'lasttile') return ltCheck(room);
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
  if (room.phase === 'lobby' || room.phase === 'over' || room.phase === 'dover' || room.phase === 'gover' || room.phase === 'bover' || room.phase === 'kover' || room.phase === 'mover') room.players.delete(p.id);
  else { p.left = true; p.alive = false; delete room.votes[p.id]; delete room.descs[p.id]; }
  if (![...room.players.values()].some((q) => !q.left)) { clearTimeout(room.timer); dwClear(room); rooms.delete(room.code); return; }
  if (wasHost && !transferHost(room)) { /* nobody connected: host stays unassigned until someone rejoins */ }
  if (room.game === 'uno') unRemove(room, p);
  afterRemoval(room);
}

// ---------------------------------------------------------------- websocket
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 32768, perMessageDeflate: false, verifyClient: (info) => !isBlocked(queryCid(info.req), ipOf(info.req)) });

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


// ================================================================ Bully Football (6v6 party football, the host's phone runs the match)
const BF_CHARS = ['vedant', 'dj', 'rutu', 'hacker', 'beasty', 'moizt', 'bocha', 'jelly'];
function bfOf(room, q) { // a player's picks, with defaults
  if (!q.bf) { const used = new Set([...room.players.values()].filter((x) => x !== q && x.bf).map((x) => x.bf.num)); let n = 7; while (used.has(n)) n++; q.bf = { char: 'jelly', jelly: Math.floor(Math.random() * 6), num: n, team: null }; }
  if (!q.bf.team) { const c = { o: 0, b: 0 }; for (const x of room.players.values()) if (x !== q && !x.left && x.bf && x.bf.team) c[x.bf.team]++; q.bf.team = c.o <= c.b ? 'o' : 'b'; }
  return q.bf;
}
function bfHumans(room) { return [...room.players.values()].filter((q) => !q.left); }
function bfStart(room) {
  const hs = bfHumans(room), set = room.bfSet;
  const total = hs.length + set.bots.o + set.bots.b;
  if (total > 12) return 'Too many players: 12 max (remove some bots)';
  if (total < 2) return 'Add at least one bot or another player';
  hs.forEach((q) => bfOf(room, q));
  room.bf = { ids: hs.map((q) => q.id), seq: (room.bf ? room.bf.seq : 0) + 1, res: null, host: room.hostId };
  for (const q of room.players.values()) q.watch = false;
  setPhase(room, 'bplay'); return broadcast(room);
}
function bfCheck(room) { // somebody left: if the host's phone (which runs the match) is gone, back to the lobby
  if (room.phase === 'bplay') { const h = room.players.get(room.hostId); if (!h || h.left || !room.bf || room.bf.host !== room.hostId) { setPhase(room, 'lobby'); room.bf = null; notice(room, '⚠️ The match stopped: the host left'); } }
  return broadcast(room);
}
function bfRelay(room, from, obj) { const str = JSON.stringify(obj); for (const q of room.players.values()) if (q !== from && q.ws && q.connected && q.ws.readyState === 1) q.ws.send(str); }

// ================================================================ Turbo Ball (2D car football, up to 3v3, the host's phone runs the match)
function rkOf(room, q) { // a player's team, auto-balanced the first time
  if (!q.rk) q.rk = { team: null };
  if (!q.rk.team) { const c = { o: 0, b: 0 }; for (const x of room.players.values()) if (x !== q && !x.left && x.rk && x.rk.team) c[x.rk.team]++; q.rk.team = c.b <= c.o ? 'b' : 'o'; }
  return q.rk;
}
function rkHumans(room) { return [...room.players.values()].filter((q) => !q.left); }
function rkStart(room) {
  const hs = rkHumans(room), st = room.rkSet, c = { o: 0, b: 0 }, teams = {};
  hs.forEach((q) => { const t = rkOf(room, q).team; teams[q.id] = t; c[t]++; });
  if (c.o > 3 || c.b > 3) return 'Max 3 players per team: move someone to the other team';
  const bots = { o: Math.max(0, Math.min(st.bots.o, 3 - c.o)), b: Math.max(0, Math.min(st.bots.b, 3 - c.b)) };
  if (hs.length + bots.o + bots.b < 2) return 'Add a bot or another player first';
  room.rk = { ids: hs.map((q) => q.id), seq: (room.rk ? room.rk.seq : 0) + 1, res: null, host: room.hostId, teams, bots };
  for (const q of room.players.values()) q.watch = false;
  setPhase(room, 'kplay'); return broadcast(room);
}
function mbStart(room) {
  const hs = rkHumans(room), st = room.mbSet, bots = Math.max(0, Math.min(st.bots, 10 - hs.length));
  if (hs.length > 10) return 'Max 10 players';
  if (hs.length + bots < 2) return 'Add a bot or another player first';
  room.mb = { ids: hs.map((q) => q.id), seq: (room.mb ? room.mb.seq : 0) + 1, host: room.hostId, bots };
  for (const q of room.players.values()) q.watch = false;
  setPhase(room, 'mplay'); return broadcast(room);
}
function ltStart(room) {
  const hs = rkHumans(room);
  if (hs.length > 16) return 'Last Tile is for up to 16 players';
  if (hs.length < 1) return 'No players';
  const ls = room.ltSet || { bots: 5, floors: 3, speed: 'normal', push: true };
  room.lt = { ids: hs.map((q) => q.id), seq: (room.lt ? room.lt.seq : 0) + 1, host: room.hostId, bots: Math.max(0, Math.min(16 - hs.length, ls.bots)), floors: ls.floors, speed: ls.speed, push: ls.push !== false };
  for (const q of room.players.values()) q.watch = false;
  setPhase(room, 'ltplay'); return broadcast(room);
}
function ltCheck(room) {
  if (room.phase === 'ltplay') { const h = room.players.get(room.hostId); if (!h || h.left || !room.lt || room.lt.host !== room.hostId) { setPhase(room, 'lobby'); room.lt = null; notice(room, '⚠️ The match stopped: the host left'); } }
  return broadcast(room);
}
function lzStart(room) {
  const hs = rkHumans(room);
  if (hs.length > 8) return 'Laser Arena is for up to 8 players';
  if (hs.length < 1) return 'No players';
  const ls = room.lzSet || { bots: 3, shrink: 'center', time: 15 };
  room.lz = { ids: hs.map((q) => q.id), seq: (room.lz ? room.lz.seq : 0) + 1, host: room.hostId, bots: Math.max(0, Math.min(8 - hs.length, ls.bots)), shrink: ls.shrink, time: ls.time };
  for (const q of room.players.values()) q.watch = false;
  setPhase(room, 'lzplay'); return broadcast(room);
}
function lzCheck(room) {
  if (room.phase === 'lzplay') { const h = room.players.get(room.hostId); if (!h || h.left || !room.lz || room.lz.host !== room.hostId) { setPhase(room, 'lobby'); room.lz = null; notice(room, '⚠️ The match stopped: the host left'); } }
  return broadcast(room);
}
function crStart(room) {
  const hs = rkHumans(room);
  if (hs.length > 4) return 'Carrom is for up to 4 players';
  if (hs.length < 1) return 'No players';
  room.cr = { ids: hs.map((q) => q.id), seq: (room.cr ? room.cr.seq : 0) + 1, host: room.hostId };
  for (const q of room.players.values()) q.watch = false;
  setPhase(room, 'crplay'); return broadcast(room);
}
function crCheck(room) {
  if (room.phase === 'crplay') { const h = room.players.get(room.hostId); if (!h || h.left || !room.cr || room.cr.host !== room.hostId) { setPhase(room, 'lobby'); room.cr = null; notice(room, '⚠️ The match stopped: the host left'); } }
  return broadcast(room);
}
function mbCheck(room) {
  if (room.phase === 'mplay') { const h = room.players.get(room.hostId); if (!h || h.left || !room.mb || room.mb.host !== room.hostId) { setPhase(room, 'lobby'); room.mb = null; notice(room, '⚠️ The match stopped: the host left'); } }
  return broadcast(room);
}
function rkCheck(room) { // the host's phone runs the match: if it is gone, back to the lobby
  if (room.phase === 'kplay') { const h = room.players.get(room.hostId); if (!h || h.left || !room.rk || room.rk.host !== room.hostId) { setPhase(room, 'lobby'); room.rk = null; notice(room, '⚠️ The match stopped: the host left'); } }
  return broadcast(room);
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

// ---------------------------------------------------------------- friends (needs the DATABASE_URL database)
// Accounts have no password: the phone holds a secret token, the database only keeps its hash.
let DB = null, dbReady = null;
function setDb(d) { DB = d; dbReady = null; }
if (process.env.DATABASE_URL) {
  try {
    const { Pool } = require('pg');
    DB = new Pool({ connectionString: process.env.DATABASE_URL, ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false }, max: 4, idleTimeoutMillis: 20000, connectionTimeoutMillis: 8000 });
    DB.on('error', () => {});
  } catch (e) { console.error('friends: "pg" is not installed, friends are off'); }
}
function dbInit() {
  if (!DB) return Promise.reject(new Error('nodb'));
  if (!dbReady) {
    dbReady = DB.query('CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, uname TEXT UNIQUE NOT NULL, token_hash TEXT UNIQUE NOT NULL, push TEXT, created_at TIMESTAMPTZ DEFAULT now())')
      .then(() => DB.query('CREATE TABLE IF NOT EXISTS friends (a INT NOT NULL, b INT NOT NULL, req INT NOT NULL, ok BOOLEAN NOT NULL DEFAULT FALSE, PRIMARY KEY (a, b))'))
      .then(() => DB.query('CREATE TABLE IF NOT EXISTS wins (user_id INT NOT NULL, game TEXT NOT NULL, wins INT NOT NULL DEFAULT 0, plays INT NOT NULL DEFAULT 0, PRIMARY KEY (user_id, game))'))
      .then(() => DB.query('CREATE TABLE IF NOT EXISTS name_reqs (user_id INT PRIMARY KEY, wanted TEXT NOT NULL, at TIMESTAMPTZ DEFAULT now())'))
      .catch((e) => { dbReady = null; throw e; });
  }
  return dbReady;
}
const q = (text, params) => dbInit().then(() => DB.query(text, params)).then((r) => r.rows);
const userWs = new Map(); // user id -> sockets that are logged in
const FR_CMDS = new Set(['fauth', 'freg', 'fadd', 'faddp', 'faccept', 'fremove', 'flist', 'finvite', 'fpush', 'fchname']);
const pair = (x, y) => (x < y ? [x, y] : [y, x]);
function frSockets(uid) { return [...(userWs.get(uid) || [])].filter((w) => w.readyState === 1); }
function frLogin(ws, u) {
  frLogout(ws); ws.user = { id: u.id, uname: u.uname };
  if (!userWs.has(u.id)) userWs.set(u.id, new Set());
  userWs.get(u.id).add(ws);
  send(ws, { t: 'fme', uname: u.uname, vapid: webpush ? webpush.pub : null });
}

const TD_TRUTH = ['What is the most embarrassing thing in your phone gallery?', 'Who in this group would you trust with a secret?', 'What is your biggest fear that you never told us?', 'Which friend annoys you the most (be kind!)?', 'What was your worst haircut ever?', 'What is a lie you told that is still going?', 'Who was your first crush?', 'What is the weirdest food you secretly like?', 'What is the last thing you searched on Google?', 'Which game here do you secretly think you are bad at?', 'What is your most-used emoji and why?', 'If you could swap lives with one friend for a day, who?', 'What is something you pretend to like but do not?', 'What is the funniest thing you did in college?', 'Which friend would survive longest in a jungle?', 'What is the most money you wasted on something silly?', 'When did you last cry, and why?', 'What is your most embarrassing nickname?', 'What is your guilty pleasure song?', 'Whose chat do you reply to the fastest?'];
const TD_DARE = ['Talk in a funny accent until your next turn.', 'Send "I love chai" to the last person you messaged.', 'Do your best filmy dialogue right now.', 'Sing the first line of any song, loudly.', 'Let the group pick a new nickname for you for today.', 'Do 10 pushups, we count out loud.', 'Say the alphabet backwards in 20 seconds.', 'Act like a chaiwala for one minute.', 'Imitate any friend here and let us guess.', 'Show the last photo in your gallery.', 'Speak only in questions for the next 3 turns.', 'Dance for 15 seconds on voice or camera.', 'Tell a joke. If nobody laughs, do another dare.', 'Make the funniest face you can and hold it for 10 seconds.', 'Say "wah wah" after every sentence for 2 minutes.', 'Do a news-reader voice and announce the weather.', 'Hum a song and let us guess it.', 'Describe your day like a cricket commentator.', 'Order imaginary chai from the chaiwala in Hindi, Marathi and English.', 'Give a compliment to every person here.'];
function tdHandle(room, p, m, ws) { const t = room.tp; if (m.a === 'done') { if (t.td && (t.td.to === p.id || p.id === room.hostId || t.td.by === p.id)) t.td = null; return broadcast(room); }
  if (Date.now() - (t.tdAt || 0) < 1500) return; t.tdAt = Date.now(); const kind = m.k === 'dare' ? 'dare' : 'truth'; let text = clean(m.text, 120);
  if (!text) { const bank = kind === 'dare' ? TD_DARE : TD_TRUTH; text = bank[Math.floor(Math.random() * bank.length)]; }
  const live = [...room.players.values()].filter((x) => !x.left); let to = String(m.to || ''); if (!live.some((x) => x.id === to)) { const others = live.filter((x) => x.id !== p.id); to = (others.length ? others : live)[Math.floor(Math.random() * (others.length || live.length))].id; }
  t.td = { kind, text, to, by: p.id, at: Date.now() }; notice(room, (kind === 'dare' ? '😈 Dare for ' : '🤔 Truth for ') + (room.players.get(to) || {}).name + ': ' + text); return broadcast(room); }
function akLetter(txt) { const ch = Array.from(String(txt).toLowerCase()).filter((c) => /\p{L}/u.test(c)); return ch; }
function akTimer(room) { const t = room.tp, A = t.ak; clearTimeout(room.akTimer); if (!A || !A.on) return; A.ends = Date.now() + 30000; room.akTimer = setTimeout(() => { if (!t.ak || !t.ak.on) return; const A2 = t.ak, id = A2.order[A2.turn], q = room.players.get(id); A2.log = (q ? q.name : 'Someone') + ' ran out of time! −1'; A2.score[id] = (A2.score[id] | 0) - 1; akNext(room); broadcast(room); }, 30500); }
function akNext(room) { const A = room.tp.ak; for (let i = 1; i <= A.order.length; i++) { const j = (A.turn + i) % A.order.length, q = room.players.get(A.order[j]); if (q && !q.left) { A.turn = j; break; } } akTimer(room); }
function akHandle(room, p, m) { const t = room.tp, A = t.ak || (t.ak = { on: false, order: [], score: {}, used: [], letter: '', turn: 0, log: '', last: null, ends: 0 });
  if (m.a === 'join') { if (A.on || A.order.includes(p.id) || A.order.length >= 8) return; A.order.push(p.id); A.score[p.id] = 0; A.log = p.name + ' joined'; }
  else if (m.a === 'leave') { const i = A.order.indexOf(p.id); if (i < 0) return; const cur = A.order[A.turn]; A.order.splice(i, 1); delete A.score[p.id]; if (A.on && A.order.length < 2) { A.on = false; clearTimeout(room.akTimer); A.log = 'Not enough players'; } else if (A.on && cur === p.id) { A.turn = (A.turn - 1 + A.order.length) % A.order.length; akNext(room); } else if (A.turn >= A.order.length) A.turn = 0; if (!A.order.length) t.ak = null; }
  else if (m.a === 'start') { if (A.order.length < 2 || A.on) return; if (!A.order.includes(p.id) && p.id !== room.hostId) return; A.on = true; A.used = []; A.turn = Math.floor(Math.random() * A.order.length); A.letter = 'abcdefghijklmnoprstv'[Math.floor(Math.random() * 20)]; A.log = 'Sing a song starting with “' + A.letter.toUpperCase() + '”'; A.order.forEach((id) => { A.score[id] = 0; }); akTimer(room); }
  else if (m.a === 'stop') { if (!A.order.includes(p.id) && p.id !== room.hostId) return; A.on = false; clearTimeout(room.akTimer); A.log = 'Game over!'; }
  else if (m.a === 'say') { if (!A.on || A.order[A.turn] !== p.id) return; const txt = clean(m.text, 60); if (!txt) return; const L = akLetter(txt); if (!L.length) return;
    if (L[0] !== A.letter) { A.log = 'Must start with “' + A.letter.toUpperCase() + '”'; return; } const key = L.join(''); if (A.used.includes(key)) { A.log = 'Already sung! Try another'; return; }
    A.used.push(key); A.score[p.id] = (A.score[p.id] | 0) + 1; A.letter = L[L.length - 1]; A.last = { by: p.name, text: txt }; A.log = p.name + ' sang “' + txt + '” +1. Next letter: ' + A.letter.toUpperCase(); akNext(room); } }

async function tapriStats(room, p, ws) { try { const ids = new Set(); for (const x of room.players.values()) if (!x.left && x.ws && x.ws.user) ids.add(x.ws.user.id);
    if (ws.user) { ids.add(ws.user.id); const fr = await q('SELECT CASE WHEN a = $1 THEN b ELSE a END AS oid FROM friends WHERE (a = $1 OR b = $1) AND ok', [ws.user.id]); for (const r of fr) ids.add(r.oid); }
    if (!ids.size) return send(ws, { t: 'tstats', rows: [], login: !ws.user });
    const rows = await q('SELECT u.uname, w.game, w.wins, w.plays FROM wins w JOIN users u ON u.id = w.user_id WHERE w.user_id = ANY($1::int[])', [[...ids]]), by = {};
    for (const r of rows) { const o = by[r.uname] || (by[r.uname] = { uname: r.uname, g: {}, wins: 0, plays: 0 }); o.g[r.game] = [r.wins, r.plays]; o.wins += r.wins; o.plays += r.plays; }
    send(ws, { t: 'tstats', login: !ws.user, rows: Object.values(by).sort((a, b) => b.wins - a.wins || b.plays - a.plays).slice(0, 12) }); } catch (e) { send(ws, { t: 'tstats', rows: [], login: !ws.user }); } }
// ---- Spotify: a shared queue that everyone votes on. The top-voted song plays next. Search needs SPOTIFY_ID and SPOTIFY_SECRET; pasting a link works without keys.
let spTok = null, spExp = 0;
async function spToken() { if (spTok && Date.now() < spExp) return spTok; const r = await fetch('https://accounts.spotify.com/api/token', { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(process.env.SPOTIFY_ID + ':' + process.env.SPOTIFY_SECRET).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' }); const j = await r.json(); spTok = j.access_token; spExp = Date.now() + (j.expires_in - 60) * 1000; return spTok; }
function muStart(room) { const M = room.tp.mu; if (!M.q.length) { M.now = null; return; } M.q.sort((a, b) => Object.keys(b.v).length - Object.keys(a.v).length || a.id - b.id); const x = M.q.shift(); M.now = { id: x.id, tid: x.tid, title: x.title, artist: x.artist, img: x.img, by: x.by, at: Date.now() }; }
async function muHandle(room, p, m, ws) { const t = room.tp, M = t.mu || (t.mu = { now: null, q: [] });
  try {
    if (m.t === 'tmsearch') { if (!process.env.SPOTIFY_ID || !process.env.SPOTIFY_SECRET) return send(ws, { t: 'tmres', err: 'nokeys' }); const qs = clean(m.q, 60); if (!qs) return; if (Date.now() - (p.lastMs || 0) < 800) return; p.lastMs = Date.now();
      const r = await fetch('https://api.spotify.com/v1/search?type=track&limit=10&market=IN&q=' + encodeURIComponent(qs), { headers: { Authorization: 'Bearer ' + (await spToken()) } }); const j = await r.json();
      return send(ws, { t: 'tmres', res: ((j.tracks && j.tracks.items) || []).map((x) => ({ tid: x.id, title: x.name, artist: (x.artists || []).map((a) => a.name).join(', '), img: x.album && x.album.images && x.album.images.length ? x.album.images[x.album.images.length - 1].url : '' })) }); }
    if (m.t === 'tmadd') { if (Date.now() - (p.lastMa || 0) < 2500) return; p.lastMa = Date.now(); let tid = String(m.tid || ''); if (!/^[A-Za-z0-9]{22}$/.test(tid)) { const u = String(m.url || ''), mm = u.match(/track[/:]([A-Za-z0-9]{22})/); if (!mm) return errTo(ws, 'Paste a Spotify song link'); tid = mm[1]; }
      if (M.q.length >= 15) return errTo(ws, 'The queue is full'); if (M.q.some((x) => x.tid === tid) || (M.now && M.now.tid === tid)) return errTo(ws, 'That song is already in the queue');
      let title = clean(m.title, 80), artist = clean(m.artist, 80), img = /^https:\/\/[a-z0-9.-]*scdn\.co\//.test(String(m.img || '')) ? String(m.img).slice(0, 200) : '';
      if (!title) { try { const r = await fetch('https://open.spotify.com/oembed?url=' + encodeURIComponent('https://open.spotify.com/track/' + tid)); const j = await r.json(); title = clean(j.title, 80) || 'Spotify song'; if (/^https:\/\/[a-z0-9.-]*scdn\.co\//.test(j.thumbnail_url || '')) img = j.thumbnail_url; } catch (e) { title = 'Spotify song'; } }
      M.q.push({ id: ++t.nid, tid, title, artist, img, by: p.name, v: { [p.id]: 1 } }); if (!M.now) muStart(room); notice(room, '🎵 ' + p.name + ' added “' + title + '”'); return broadcast(room); }
    if (m.t === 'tmvote') { const x = M.q.find((y) => y.id === Number(m.id)); if (!x) return; if (x.v[p.id]) delete x.v[p.id]; else x.v[p.id] = 1; return broadcast(room); }
    if (m.t === 'tmnext') { if (!M.now) return; if (p.id !== room.hostId) return; muStart(room); return broadcast(room); }
  } catch (e) { errTo(ws, 'Spotify did not answer. Try again'); } }
function recordWins(room, game, played, winners) { // friends with a username get their wins counted
  try { const w = new Set(winners || []); for (const id of played || []) { const p = room.players.get(id), uid = p && p.ws && p.ws.user && p.ws.user.id; if (!uid) continue;
    q('INSERT INTO wins (user_id, game, wins, plays) VALUES ($1, $2, $3, 1) ON CONFLICT (user_id, game) DO UPDATE SET wins = wins.wins + $3, plays = wins.plays + 1', [uid, game, w.has(id) ? 1 : 0]).catch(() => {}); } } catch (e) { /* ignore */ }
}
function frLogout(ws) {
  if (ws.user) { const s = userWs.get(ws.user.id); if (s) { s.delete(ws); if (!s.size) userWs.delete(ws.user.id); } ws.user = null; }
}
async function frList(ws) {
  const me = ws.user.id;
  const rows = await q('SELECT f.a, f.b, f.req, f.ok, u.id AS oid, u.uname FROM friends f JOIN users u ON u.id = (CASE WHEN f.a = $1 THEN f.b ELSE f.a END) WHERE f.a = $1 OR f.b = $1', [me]);
  const friends = [], inc = [], out = [];
  for (const r of rows) {
    if (!r.ok) { (r.req === me ? out : inc).push({ uname: r.uname }); continue; }
    const socks = frSockets(r.oid), w = socks[0], room = w && w.ctx && rooms.get(w.ctx.code);
    friends.push({ uname: r.uname, online: socks.length > 0, room: room ? { code: room.code, game: room.game, phase: room.phase } : null });
  }
  friends.sort((x, y) => (y.online - x.online) || x.uname.localeCompare(y.uname));
  const rq = await q('SELECT wanted FROM name_reqs WHERE user_id = $1', [me]);
  send(ws, { t: 'flist', friends, inc, out, rename: rq.length ? rq[0].wanted : null });
}
async function frCmd(ws, m) {
  try {
    if (m.t === 'fauth') {
      if (typeof m.token !== 'string' || m.token.length < 16 || m.token.length > 64) return send(ws, { t: 'fnone' });
      const r = await q('SELECT id, uname FROM users WHERE token_hash = $1', [sha(m.token)]);
      if (!r.length) return send(ws, { t: 'fnone' });
      return frLogin(ws, r[0]);
    }
    if (m.t === 'freg') {
      if (ws.user) return;
      const un = String(m.uname || '').toLowerCase().trim();
      if (!/^[a-z0-9_]{2,16}$/.test(un)) return errTo(ws, 'Username: 2 to 16 letters, numbers or _');
      if (typeof m.token !== 'string' || m.token.length < 16 || m.token.length > 64) return;
      if (Date.now() - (ws.regAt || 0) < 3000) return errTo(ws, 'One moment, still saving. Try again in a few seconds');
      ws.regAt = Date.now();
      const ex = await q('SELECT 1 FROM users WHERE uname = $1', [un]);
      if (ex.length && ws.isAdmin) { // the admin phone lost its sign-in: take the account back onto this phone
        const rr = await q('UPDATE users SET token_hash = $2 WHERE uname = $1 RETURNING id, uname', [un, sha(m.token)]);
        if (rr.length) return frLogin(ws, rr[0]);
      }
      if (ex.length) return errTo(ws, 'That username is taken');
      let r;
      try { r = await q('INSERT INTO users (uname, token_hash) VALUES ($1, $2) RETURNING id, uname', [un, sha(m.token)]); } catch (e) { return errTo(ws, 'That username is taken'); }
      return frLogin(ws, r[0]);
    }
    if (!ws.user) return send(ws, { t: 'fnone' });
    const me = ws.user;
    if (m.t === 'flist') return frList(ws);
    if (m.t === 'fpush') {
      const sub = m.sub;
      const ok = sub && typeof sub.endpoint === 'string' && /^https:\/\//.test(sub.endpoint) && sub.keys && typeof sub.keys.p256dh === 'string' && typeof sub.keys.auth === 'string';
      await q('UPDATE users SET push = $2 WHERE id = $1', [me.id, ok ? JSON.stringify({ endpoint: sub.endpoint.slice(0, 800), keys: { p256dh: sub.keys.p256dh.slice(0, 200), auth: sub.keys.auth.slice(0, 100) } }) : null]);
      return;
    }
    if (m.t === 'fchname') { // ask the admin for a new username (the admin approves or denies it)
      const want = String(m.uname || '').toLowerCase().trim().replace(/^@/, '');
      if (!want) { await q('DELETE FROM name_reqs WHERE user_id = $1', [me.id]); return frList(ws); }
      if (!/^[a-z0-9_]{2,16}$/.test(want)) return errTo(ws, 'Username: 2 to 16 letters, numbers or _');
      if (want === me.uname) return errTo(ws, 'That is already your username');
      if (Date.now() - (ws.nmAt || 0) < 3000) return errTo(ws, 'Wait a few seconds');
      ws.nmAt = Date.now();
      if ((await q('SELECT 1 FROM users WHERE uname = $1', [want])).length) return errTo(ws, 'That username is taken');
      await q('DELETE FROM name_reqs WHERE user_id = $1', [me.id]);
      await q('INSERT INTO name_reqs (user_id, wanted) VALUES ($1, $2)', [me.id, want]); admNotify('✏️ Username change request', '@' + (me.uname || '?') + ' wants @' + want, 'nr');
      send(ws, { t: 'fok', msg: 'Request sent. Your name changes when the admin approves it' });
      return frList(ws);
    }
    const un = String(m.uname || '').toLowerCase().trim();
    const tr = un ? await q('SELECT id, uname, push FROM users WHERE uname = $1', [un]) : [];
    const target = tr[0];
    if (m.t === 'fadd') {
      if (!target) return errTo(ws, 'No player with that username');
      if (target.id === me.id) return errTo(ws, 'That is you');
      const [a, b] = pair(me.id, target.id);
      const ex = (await q('SELECT req, ok FROM friends WHERE a = $1 AND b = $2', [a, b]))[0];
      if (ex && ex.ok) return errTo(ws, 'Already friends');
      if (ex && ex.req === me.id) return errTo(ws, 'Request already sent');
      if (ex) { await q('UPDATE friends SET ok = TRUE WHERE a = $1 AND b = $2', [a, b]); send(ws, { t: 'fok', msg: 'You and @' + target.uname + ' are friends now' }); }
      else {
        const cnt = (await q('SELECT COUNT(*)::int AS n FROM friends WHERE req = $1 AND ok = FALSE', [me.id]))[0].n;
        if (cnt >= 30) return errTo(ws, 'Too many pending requests');
        await q('INSERT INTO friends (a, b, req, ok) VALUES ($1, $2, $3, FALSE)', [a, b, me.id]);
        send(ws, { t: 'fok', msg: 'Request sent to @' + target.uname });
      }
      for (const w of frSockets(target.id)) send(w, { t: ex ? 'fchg' : 'freq', from: me.uname });
      return frList(ws);
    }
    if (m.t === 'faccept') {
      if (!target) return;
      const [a, b] = pair(me.id, target.id);
      await q('UPDATE friends SET ok = TRUE WHERE a = $1 AND b = $2 AND req <> $3', [a, b, me.id]);
      for (const w of frSockets(target.id)) send(w, { t: 'fchg', from: me.uname });
      return frList(ws);
    }
    if (m.t === 'fremove') {
      if (!target) return;
      const [a, b] = pair(me.id, target.id);
      await q('DELETE FROM friends WHERE a = $1 AND b = $2', [a, b]);
      for (const w of frSockets(target.id)) send(w, { t: 'fchg', from: me.uname });
      return frList(ws);
    }
    if (m.t === 'finvite') {
      if (!target) return;
      const room = ws.ctx && rooms.get(ws.ctx.code), pl = room && room.players.get(ws.ctx.pid);
      if (!room || !pl) return errTo(ws, 'Join or make a lobby first');
      if (room.phase !== 'lobby') return errTo(ws, 'You can invite friends while you are in the lobby');
      const [a, b] = pair(me.id, target.id);
      const fr = (await q('SELECT ok FROM friends WHERE a = $1 AND b = $2', [a, b]))[0];
      if (!fr || !fr.ok) return errTo(ws, 'You are not friends yet');
      ws.invAt = ws.invAt || {};
      if (Date.now() - (ws.invAt[target.id] || 0) < 8000) return errTo(ws, 'Invite already sent. Wait a few seconds');
      ws.invAt[target.id] = Date.now();
      const socks = frSockets(target.id), info = ws.info || {};
      const payload = { t: 'finv', from: me.uname, name: pl.name, photo: info.photo || null, code: room.code, game: room.game };
      for (const w of socks) send(w, payload);
      let how = socks.length ? 'online' : 'none';
      if (!socks.length && webpush && target.push) {
        try {
          await webpush.sendNotification(JSON.parse(target.push), JSON.stringify({ title: pl.name + ' invited you', body: 'Join their ' + (room.game === 'bully' ? 'Bully Football' : room.game === 'rocket' ? 'Turbo Ball' : room.game === 'tapri' ? 'Chai Tapri' : room.game === 'bomb' ? 'Bomb Pass' : room.game === 'carrom' ? 'Carrom' : room.game === 'laser' ? 'Laser Arena' : room.game === 'lasttile' ? 'Last Tile' : room.game === 'undercover' ? 'Undercover' : room.game) + ' lobby', tag: 'inv-' + room.code, vib: [200, 100, 200, 100, 300], url: '/?c=' + room.code }), { TTL: 600, urgency: 'high' });
          how = 'push';
        } catch (e) { if (e && (e.statusCode === 404 || e.statusCode === 410)) q('UPDATE users SET push = NULL WHERE id = $1', [target.id]).catch(() => {}); }
      }
      return send(ws, { t: 'finvok', uname: target.uname, how });
    }
  } catch (e) {
    if (e && e.message !== 'nodb') console.error('friends error:', e.message);
    if (m.t === 'fauth') return send(ws, { t: 'fdown' });
    errTo(ws, 'Friends are not available right now. Try again soon');
  }
}

// ---- admin commands (only a phone that proved it holds the admin token can reach these)
function admView() {
  const online = [];
  for (const c of wss.clients) {
    const ctx = c.ctx, room = ctx && rooms.get(ctx.code), pl = room && room.players.get(ctx.pid), info = c.info || {};
    online.push({ uid: c.uid, user: c.user ? c.user.uname : '', name: (pl && pl.name) || info.name || '', photo: info.photo || null, dev: deviceOf(c.ua), ip: c.ip || '', since: c.since, code: room ? room.code : '', game: room ? room.game : '', phase: room ? room.phase : '', admin: !!c.isAdmin, blocked: isBlocked(info.cid, null) });
  }
  if (online.length > 40) online.forEach((o) => { o.photo = null; });
  const rl = [];
  for (const r of rooms.values()) {
    const ps = [...r.players.values()].filter((q) => !q.left);
    rl.push({ code: r.code, game: r.game, phase: r.phase, paused: !!r.apaused, open: r.open !== false, host: (r.players.get(r.hostId) || {}).name || '', players: ps.map((q) => ({ name: q.name, on: !!q.connected, host: q.id === r.hostId })) });
  }
  return {
    t: 'admdata', now: Date.now(), online, rooms: rl, fb: ADM.feedback.slice(-100).reverse(),
    blocked: Object.keys(ADM.blockedCids).map((cid) => Object.assign({ cid }, ADM.blockedCids[cid])),
    ips: Object.keys(ADM.blockedIps).map((ip) => Object.assign({ ip }, ADM.blockedIps[ip])),
  };
}
async function admSend(ws) {
  const v = admView();
  try { v.names = (await q('SELECT r.user_id AS id, r.wanted, u.uname FROM name_reqs r JOIN users u ON u.id = r.user_id ORDER BY r.at')).map((r) => ({ id: r.id, wanted: r.wanted, uname: r.uname })); } catch (e) { v.names = []; }
  send(ws, v);
}
async function admRename(ws, m) {
  try {
    const id = parseInt(m.id, 10), r = (await q('SELECT wanted FROM name_reqs WHERE user_id = $1', [id]))[0];
    if (!r) return admSend(ws);
    if (m.ok) {
      try { await q('UPDATE users SET uname = $2 WHERE id = $1', [id, r.wanted]); } catch (e) { await q('DELETE FROM name_reqs WHERE user_id = $1', [id]); errTo(ws, '@' + r.wanted + ' is already taken'); return admSend(ws); }
    }
    await q('DELETE FROM name_reqs WHERE user_id = $1', [id]);
    for (const w of frSockets(id)) {
      if (m.ok) { w.user.uname = r.wanted; send(w, { t: 'fme', uname: r.wanted, vapid: webpush ? webpush.pub : null }); send(w, { t: 'fok', msg: 'Your username is now @' + r.wanted }); }
      else send(w, { t: 'fok', msg: 'The admin did not approve @' + r.wanted });
      frList(w).catch(() => {});
    }
  } catch (e) { errTo(ws, 'Could not do that right now'); }
  return admSend(ws);
}
function admCmd(ws, m) {
  const target = () => { for (const c of wss.clients) if (c.uid === m.uid) return c; return null; };
  if (m.t === 'admget') return admSend(ws);
  if (m.t === 'admpush') {
    const sub = m.sub;
    if (sub && typeof sub.endpoint === 'string' && /^https:\/\//.test(sub.endpoint) && sub.keys && typeof sub.keys.p256dh === 'string' && typeof sub.keys.auth === 'string') { ADM.push = { endpoint: sub.endpoint.slice(0, 800), keys: { p256dh: sub.keys.p256dh.slice(0, 200), auth: sub.keys.auth.slice(0, 100) } }; admSave(); admNotify('🔔 Admin alerts are on', 'You will get a notification for feedback, reports and name requests'); }
    return;
  }
  if (m.t === 'admpause') { const r = rooms.get(clean(m.code, 4)); if (!r) return; r.apaused = !r.apaused; broadcast(r); return admSend(ws); }
  if (m.t === 'admkick' || m.t === 'admblock') {
    const c = target(); if (!c || c === ws || c.isAdmin) return;
    const room = c.ctx && rooms.get(c.ctx.code), pl = room && room.players.get(c.ctx.pid);
    const nm = (pl && pl.name) || (c.info && c.info.name) || '?';
    if (pl) removePlayer(room, pl, false);
    if (m.t === 'admblock') {
      const info = c.info || {}, rec = { name: nm, dev: deviceOf(c.ua), at: Date.now() };
      if (info.cid) ADM.blockedCids[info.cid] = rec;
      if (m.ip && c.ip) ADM.blockedIps[c.ip] = rec;
      admSave();
      try { c.terminate(); } catch (e) { /* gone */ }
    }
    return admSend(ws);
  }
  if (m.t === 'admunblock') {
    if (m.cid) delete ADM.blockedCids[String(m.cid)];
    if (m.ip) delete ADM.blockedIps[String(m.ip)];
    admSave(); return admSend(ws);
  }
  if (m.t === 'admname') return admRename(ws, m);
  if (m.t === 'admfbdel') { ADM.feedback = ADM.feedback.filter((f) => f.id !== m.id); admSave(); return admSend(ws); }
}

function handle(ws, m) {
  if (!m || typeof m.t !== 'string') return;
  // ---- before joining a room
  if (m.t === 'create') {
    const name = clean(m.name, 14);
    if (!name) return errTo(ws, 'Enter your name');
    const room = makeRoom(loadWords(m));
    if (m.game === 'football' || m.game === 'race' || m.game === 'uno' || m.game === 'cricket' || m.game === 'draw' || m.game === 'golf' || m.game === 'bully' || m.game === 'rocket' || m.game === 'bomb' || m.game === 'carrom' || m.game === 'laser' || m.game === 'lasttile' || m.game === 'tapri') room.game = m.game;
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
    if (room.game === 'tapri') { // the chai tapri is open to everyone: walk straight in, no request to the host
      const np = addPlayer(room, name);
      if (okPhoto(m.photo)) np.photo = m.photo;
      attach(ws, room, np);
      if (np.photo) for (const q of room.players.values()) if (q.ws && q.connected) send(q.ws, { t: 'photo', name: np.name, data: np.photo });
      return;
    }
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
  if (m.t === 'faddp') { // add a player in my lobby as a friend (the username stays on the server)
    const room = ws.ctx && rooms.get(ws.ctx.code), q = room && room.players.get(String(m.id));
    if (!ws.user) return errTo(ws, 'Pick a username in Friends first');
    if (!q || q.left || !q.ws || !q.ws.user) return errTo(ws, 'That player has no friend username yet');
    m = { t: 'fadd', uname: q.ws.user.uname };
  }
  if (FR_CMDS.has(m.t)) { frCmd(ws, m); return; }
  if (m.t === 'hello') { ws.info = { cid: clean(m.cid, 40).replace(/[^A-Za-z0-9]/g, ''), name: clean(m.name, 14), photo: okPhoto(m.photo) ? m.photo : null }; return; }
  if (m.t === 'fb') { // feedback from a player (can be anonymous)
    const text = String(m.text == null ? '' : m.text).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, 600);
    if (text.length < 3) return errTo(ws, 'Write a little more');
    if (Date.now() - (ws.fbAt || 0) < 15000) return errTo(ws, 'Wait a few seconds before sending another');
    ws.fbAt = Date.now();
    const anon = m.anon !== false, info = ws.info || {};
    ADM.feedback.push({ id: rid(), at: Date.now(), text, anon, name: anon ? '' : (clean(m.name, 14) || info.name || ''), dev: anon ? '' : deviceOf(ws.ua) });
    if (ADM.feedback.length > 300) ADM.feedback.shift();
    admSave(); admNotify('💬 New feedback', text, 'fb');
    return send(ws, { t: 'fbok' });
  }
  if (m.t === 'rep') { // a player reports someone in their lobby (the admin reads it in the Feedback tab)
    const rm = ws.ctx && rooms.get(ws.ctx.code), rp = rm && rm.players.get(ws.ctx.pid);
    if (!rp) return;
    if (Date.now() - (ws.fbAt || 0) < 15000) return errTo(ws, 'Wait a few seconds before sending another');
    const who = clean(m.name, 14), why = clean(m.why, 60);
    if (!who || !why) return;
    ws.fbAt = Date.now();
    ADM.feedback.push({ id: rid(), at: Date.now(), kind: 'report', text: rp.name + ' reported ' + who + ': ' + why + '  [room ' + rm.code + ', ' + rm.game + ']', anon: false, name: rp.name, dev: '' });
    if (ADM.feedback.length > 300) ADM.feedback.shift();
    admSave(); admNotify('🚩 New report', rp.name + ' reported ' + who + ': ' + why, 'rep');
    return send(ws, { t: 'fok', msg: 'Report sent to the admin' });
  }
  if (m.t === 'adm') { if (ADM.hash && typeof m.token === 'string' && sha(m.token) === ADM.hash) { ws.isAdmin = true; return send(ws, { t: 'admok' }); } return send(ws, { t: 'admno' }); }
  if (m.t === 'admclaim') { // first phone to claim becomes the admin (only while nobody is)
    if (ADM.hash) return errTo(ws, 'Admin is already set');
    if (typeof m.token !== 'string' || m.token.length < 16 || m.token.length > 64) return;
    ADM.hash = sha(m.token); ws.isAdmin = true; admSave();
    return send(ws, { t: 'admok', claimed: true });
  }
  if (m.t.indexOf('adm') === 0) { if (ws.isAdmin) admCmd(ws, m); return; }
  if (m.t === 'ping') return send(ws, { t: 'pong' });

  // ---- inside a room
  const ctx = ws.ctx;
  const room = ctx && rooms.get(ctx.code);
  const p = room && room.players.get(ctx.pid);
  if (!p) return;
  if (room.apaused && !['leave', 'chat', 'vjoin', 'vleave', 'vsig', 'photo', 'react', 'typing'].includes(m.t)) { if (m.t !== 'bin' && m.t !== 'bst' && m.t !== 'kin' && m.t !== 'kst' && m.t !== 'mbin' && m.t !== 'mbst' && m.t !== 'crin' && m.t !== 'crst' && m.t !== 'lzin' && m.t !== 'lzst' && m.t !== 'ltin' && m.t !== 'ltst' && m.t !== 'rpos' && m.t !== 'rprog' && m.t !== 'ckpos' && m.t !== 'dop') errTo(ws, '⏸ Paused by the admin'); return; }
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
      const g = ['undercover', 'football', 'race', 'uno', 'cricket', 'draw', 'golf', 'bully', 'rocket', 'bomb', 'carrom', 'laser', 'lasttile', 'tapri'].includes(m.game) ? m.game : null;
      if (!g) return;
      if (!['lobby', 'over', 'fover', 'rover', 'uover', 'cover', 'dover', 'gover', 'bover', 'kover', 'mover'].includes(room.phase)) return errTo(ws, 'Finish or end the current game first');
      if (g === room.game && room.phase === 'lobby') return;
      clearTimeout(room.timer); dwClear(room); room.dw = null; room.gf = null; room.bf = null; room.rk = null; room.mb = null; room.seq++;
      room.game = g; room.un = null; room.fb = null; room.pkPick = null; room.rc = null; room.ck = null; room.winner = null; room.guess = null; room.votes = {}; room.tie = false; room.descs = {}; room.history = [];
      for (const [qid, q] of room.players) if (q.left) room.players.delete(qid);
      for (const q of room.players.values()) { q.watch = false; q.alive = true; q.role = null; q.word = ''; q.revealed = false; }
      setPhase(room, 'lobby');
      const gn = { undercover: '🕵️ Undercover', football: '⚽ Football', race: '🏖️ Beach Buggy', uno: '🃏 UNO', cricket: '🏏 Cricket', draw: '🎨 Draw & Guess', golf: '⛳ Golf', bully: '🤼 Bully Football', rocket: '🚗 Turbo Ball', bomb: '💣 Bomb Pass', carrom: '🎯 Carrom', laser: '🔫 Laser Arena', lasttile: '🔷 Last Tile', tapri: '☕ Chai Tapri' }[g];
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
    case 'bset': {
      if (!hostOnly() || room.game !== 'bully' || !['lobby', 'bover'].includes(room.phase)) return;
      const st = room.bfSet;
      if (['easy', 'normal', 'hard'].includes(m.diff)) st.diff = m.diff;
      if (['t2', 't3', 't5', 'g'].includes(m.mode)) st.mode = m.mode;
      if ([3, 5, 7, 10].includes(Number(m.goals))) st.goals = Number(m.goals);
      if ([1, 2, 3, 4, 5].includes(Number(m.balls))) st.balls = Number(m.balls);
      if (m.head && typeof m.head === 'object') ['o', 'b'].forEach((k) => { const v = Number(m.head[k]); if (Number.isInteger(v) && v >= 0 && v <= 5) st.head[k] = v; });
      if (m.bots && typeof m.bots === 'object') ['o', 'b'].forEach((k) => { const v = Number(m.bots[k]); if (Number.isInteger(v) && v >= 0 && v <= 11) st.bots[k] = v; });
      const hn = bfHumans(room).length; while (hn + st.bots.o + st.bots.b > 12) { if (st.bots.o >= st.bots.b && st.bots.o > 0) st.bots.o--; else if (st.bots.b > 0) st.bots.b--; else break; }
      return broadcast(room);
    }
    case 'bme': { // my character / number / team
      if (room.game !== 'bully' || !['lobby', 'bover'].includes(room.phase)) return;
      const me = bfOf(room, p);
      if (typeof m.char === 'string' && BF_CHARS.includes(m.char)) {
        if (m.char !== 'jelly' && [...room.players.values()].some((q) => q !== p && !q.left && q.bf && q.bf.char === m.char)) return errTo(ws, 'Someone already picked that character');
        me.char = m.char;
      }
      if (Number.isInteger(m.jelly) && m.jelly >= 0 && m.jelly < 6) me.jelly = m.jelly;
      if (Number.isInteger(m.num) && m.num >= 0 && m.num <= 100) me.num = m.num;
      if (m.team === 'o' || m.team === 'b') me.team = m.team;
      return broadcast(room);
    }
    case 'bteam': { // host moves a player to the other side
      if (!hostOnly() || room.game !== 'bully' || !['lobby', 'bover'].includes(room.phase)) return;
      const q = room.players.get(String(m.id)); if (!q || q.left) return; const b = bfOf(room, q); b.team = b.team === 'o' ? 'b' : 'o'; return broadcast(room);
    }
    case 'bshuffle': {
      if (!hostOnly() || room.game !== 'bully' || !['lobby', 'bover'].includes(room.phase)) return;
      const hs = bfHumans(room).sort(() => Math.random() - 0.5), st = room.bfSet, total = hs.length + st.bots.o + st.bots.b, half = Math.ceil(total / 2), side = Math.random() < 0.5 ? ['o', 'b'] : ['b', 'o'];
      const hA = Math.min(hs.length, Math.ceil(hs.length / 2)); hs.forEach((q, i) => { bfOf(room, q).team = i < hA ? side[0] : side[1]; });
      st.bots[side[0]] = Math.max(0, half - hA); st.bots[side[1]] = Math.max(0, total - half - (hs.length - hA));
      return broadcast(room);
    }
    case 'bstart': {
      if (!hostOnly() || room.game !== 'bully' || !['lobby', 'bover', 'bplay'].includes(room.phase)) return;
      const e = bfStart(room); return e ? errTo(ws, e) : undefined;
    }
    case 'blobby': {
      if (!hostOnly() || room.game !== 'bully' || room.phase === 'lobby') return;
      setPhase(room, 'lobby'); room.bf = null;
      for (const [qid, q] of room.players) if (q.left) room.players.delete(qid);
      return broadcast(room);
    }
    case 'bin': { // a player's stick + buttons, passed straight to the host's phone
      if (room.game !== 'bully' || room.phase !== 'bplay' || p.id === room.hostId) return;
      const h = room.players.get(room.hostId); if (!h || !h.ws || !h.connected) return;
      const n = (v, a) => { v = Number(v); return Number.isFinite(v) ? Math.max(-a, Math.min(a, Math.round(v * 100) / 100)) : 0; };
      return send(h.ws, { t: 'bin', id: p.id, x: n(m.x, 1), z: n(m.z, 1), j: (Number(m.j) | 0) % 1e6, e: (Number(m.e) | 0) % 1e6, y: n(m.y, 7) });
    }
    case 'bst': { // the host's match snapshot, sent on to everyone else
      if (room.game !== 'bully' || room.phase !== 'bplay' || p.id !== room.hostId) return;
      const now = Date.now(); if (now - (room.bfAt || 0) < 20) return; room.bfAt = now;
      m.t = 'bst'; return bfRelay(room, p, m);
    }
    case 'bend': {
      if (room.game !== 'bully' || room.phase !== 'bplay' || p.id !== room.hostId || !room.bf) return;
      room.bf.res = { o: Math.max(0, Math.min(99, Number(m.o) | 0)), b: Math.max(0, Math.min(99, Number(m.b) | 0)) };
      { const live = [...room.players.values()].filter((x) => !x.left), win = room.bf.res.o === room.bf.res.b ? null : room.bf.res.o > room.bf.res.b ? 'o' : 'b'; recordWins(room, 'bully', live.map((x) => x.id), win ? live.filter((x) => bfOf(room, x).team === win).map((x) => x.id) : []); }
      setPhase(room, 'bover'); return broadcast(room);
    }
    case 'kset': {
      if (!hostOnly() || room.game !== 'rocket' || !['lobby', 'kover'].includes(room.phase)) return;
      const st = room.rkSet;
      if (['snow', 'stadium'].includes(m.map)) st.map = m.map;
      if (['t2', 't3', 't5', 'g'].includes(m.mode)) st.mode = m.mode;
      if ([3, 5, 7, 10].includes(Number(m.goals))) st.goals = Number(m.goals);
      if (['easy', 'normal', 'hard'].includes(m.diff)) st.diff = m.diff;
      if (m.bots && typeof m.bots === 'object') ['o', 'b'].forEach((k) => { const v = Number(m.bots[k]); if (Number.isInteger(v) && v >= 0 && v <= 3) st.bots[k] = v; });
      return broadcast(room);
    }
    case 'kme': {
      if (room.game !== 'rocket' || !['lobby', 'kover'].includes(room.phase)) return;
      const me = rkOf(room, p); if (m.team === 'o' || m.team === 'b') me.team = m.team;
      return broadcast(room);
    }
    case 'kcar': { // a player's car in the garage: body, accent colour, boost colour
      if (room.game !== 'rocket' || !['lobby', 'kover'].includes(room.phase)) return;
      const m2 = Number(m.m), a2 = Number(m.a), b2 = Number(m.b);
      if (![m2, a2, b2].every(Number.isInteger) || m2 < 0 || m2 > 4 || a2 < 0 || a2 > 7 || b2 < 0 || b2 > 5) return;
      rkOf(room, p).car = { m: m2, a: a2, b: b2 }; return broadcast(room);
    }
    case 'kteam': {
      if (!hostOnly() || room.game !== 'rocket' || !['lobby', 'kover'].includes(room.phase)) return;
      const q = room.players.get(String(m.id)); if (!q || q.left) return; const r = rkOf(room, q); r.team = r.team === 'o' ? 'b' : 'o'; return broadcast(room);
    }
    case 'kshuffle': {
      if (!hostOnly() || room.game !== 'rocket' || !['lobby', 'kover'].includes(room.phase)) return;
      const hs = rkHumans(room).sort(() => Math.random() - 0.5), first = Math.random() < 0.5 ? ['o', 'b'] : ['b', 'o'];
      hs.forEach((q, i) => { rkOf(room, q).team = first[i % 2]; });
      return broadcast(room);
    }
    case 'kfill': { // fill every empty seat with a bot (3v3)
      if (!hostOnly() || room.game !== 'rocket' || !['lobby', 'kover'].includes(room.phase)) return;
      const c = { o: 0, b: 0 }; rkHumans(room).forEach((q) => { c[rkOf(room, q).team]++; });
      room.rkSet.bots = { o: Math.max(0, 3 - c.o), b: Math.max(0, 3 - c.b) }; return broadcast(room);
    }
    case 'kstart': {
      if (!hostOnly() || room.game !== 'rocket' || !['lobby', 'kover', 'kplay'].includes(room.phase)) return;
      const e = rkStart(room); return e ? errTo(ws, e) : undefined;
    }
    case 'klobby': {
      if (!hostOnly() || room.game !== 'rocket' || room.phase === 'lobby') return;
      setPhase(room, 'lobby'); room.rk = null;
      for (const [qid, q] of room.players) if (q.left) room.players.delete(qid);
      return broadcast(room);
    }
    case 'kin': { // a player's stick + buttons, passed straight to the host's phone
      if (room.game !== 'rocket' || room.phase !== 'kplay' || p.id === room.hostId) return;
      const h = room.players.get(room.hostId); if (!h || !h.ws || !h.connected) return;
      const x = Number(m.x); return send(h.ws, { t: 'kin', id: p.id, x: Number.isFinite(x) ? Math.max(-1, Math.min(1, Math.round(x * 100) / 100)) : 0, y: Number.isFinite(Number(m.y)) ? Math.max(-1, Math.min(1, Math.round(Number(m.y) * 100) / 100)) : 0, b: m.b ? 1 : 0, j: (Number(m.j) | 0) % 1e6, r: (Number(m.r) | 0) % 1e6, i: m.i ? 1 : 0, h: Number.isFinite(Number(m.h)) ? Math.max(-7000, Math.min(7000, Number(m.h) | 0)) : 0, e: m.e ? 1 : 0 });
    }
    case 'kst': { // the host's match snapshot, sent on to everyone else
      if (room.game !== 'rocket' || room.phase !== 'kplay' || p.id !== room.hostId) return;
      const now = Date.now(); if (now - (room.rkAt || 0) < 20) return; room.rkAt = now;
      m.t = 'kst'; return bfRelay(room, p, m);
    }
    case 'kend': {
      if (room.game !== 'rocket' || room.phase !== 'kplay' || p.id !== room.hostId || !room.rk) return;
      room.rk.res = { o: Math.max(0, Math.min(99, Number(m.o) | 0)), b: Math.max(0, Math.min(99, Number(m.b) | 0)) };
      { const live = [...room.players.values()].filter((x) => !x.left), win = room.rk.res.o === room.rk.res.b ? null : room.rk.res.o > room.rk.res.b ? 'o' : 'b'; recordWins(room, 'rocket', live.map((x) => x.id), win ? live.filter((x) => rkOf(room, x).team === win).map((x) => x.id) : []); }
      setPhase(room, 'kover'); return broadcast(room);
    }
    case 'tvote': case 'tchai': case 'tnote': case 'tdel': case 'temo': case 'tsky': case 'tradio': case 'tpaid': case 'tscore': case 'tludo': case 'tseat': case 'tavatar': case 'twhistle': case 'twall': case 'twdel': case 'twget': case 'tstats': case 'tak': case 'ttd': case 'tmadd': case 'tmvote': case 'tmnext': case 'tmsearch': { // Chai Tapri: hang out, vote for the next game, order chai, pin ideas
      if (room.game !== 'tapri' || room.phase !== 'lobby') return;
      const t = room.tp || (room.tp = { votes: {}, chai: {}, notes: [], nid: 0 });
      if (m.t === 'tvote') { const g = String(m.g || ''); if (!g || t.votes[p.id] === g) delete t.votes[p.id]; else if (['undercover', 'uno', 'football', 'race', 'cricket', 'draw', 'golf', 'bully', 'rocket', 'bomb', 'carrom', 'laser', 'lasttile'].includes(g)) t.votes[p.id] = g; }
      else if (m.t === 'tchai') { if (t.chai[p.id] && Date.now() - t.chai[p.id] < 4000) return; const k = Math.max(0, Math.min(2, Number(m.k) | 0)); t.chai[p.id] = Date.now(); (t.kind || (t.kind = {}))[p.id] = k; notice(room, '☕ ' + p.name + ' ordered ' + ['a cutting chai', 'a masala chai', 'a bun maska'][k]); }
      else if (m.t === 'temo') { const E = ['😂', '👏', '😍', '🔥', '👋', '😮', '😢', '🎉', '🙏', '💀', 'wah!']; const e = String(m.e || ''); if (!E.includes(e) || Date.now() - ((t.emo || {})[p.id] || {}).at < 900) return; (t.emo || (t.emo = {}))[p.id] = { e, at: Date.now() }; }
      else if (m.t === 'tsky') { if (!['dusk', 'day', 'night', 'rain'].includes(m.k) || Date.now() - (t.skyAt || 0) < 3000) return; t.sky = m.k; t.skyAt = Date.now(); notice(room, '🌦️ ' + p.name + ' changed the weather: ' + m.k); }
      else if (m.t === 'tradio') { const k = Math.max(0, Math.min(3, Number(m.k) | 0)); if (Date.now() - (t.radioAt || 0) < 800) return; t.radio = k; t.radioAt = Date.now(); }
      else if (m.t === 'tpaid') { if (Date.now() - (p.lastPaid || 0) < 20000) return errTo(ws, 'Thanks! You just said that'); p.lastPaid = Date.now(); t.paid = (t.paid | 0) + 1; notice(room, '💸 ' + p.name + ' paid for the chai. Thank you!'); }
      else if (m.t === 'tseat') { const i = Number(m.i); if (!Number.isInteger(i) || i < -1 || i > 19) return; const sp = t.spot || (t.spot = {}); if (i >= 0) { for (const [id, v] of Object.entries(sp)) { const q = room.players.get(id); if (v === i && id !== p.id && q && !q.left) return errTo(ws, 'Someone is sitting there'); } sp[p.id] = i; } else delete sp[p.id]; }
      else if (m.t === 'tavatar') { const n = (v, mx) => Math.max(0, Math.min(mx, Number(v) | 0)); (t.av || (t.av = {}))[p.id] = { s: n(m.s, 9), k: n(m.k, 4), h: n(m.h, 3), c: n(m.c, 5) }; }
      else if (m.t === 'twhistle') { if (Date.now() - (t.whAt || 0) < 6000) return; t.whAt = Date.now(); t.whistle = { id: p.id, at: Date.now() }; }
      else if (m.t === 'twall') { const img = String(m.img || ''); if (!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(img) || img.length > 70000) return errTo(ws, 'Photo is too big'); const W = t.wall || (t.wall = []); W.push({ id: ++t.nid, by: p.name, pid: p.id, img }); while (W.length > 6) W.shift(); }
      else if (m.t === 'twdel') { const W = t.wall || []; const i = W.findIndex((x) => x.id === Number(m.id)); if (i >= 0 && (W[i].pid === p.id || p.id === room.hostId)) W.splice(i, 1); }
      else if (m.t === 'twget') { const x = (t.wall || []).find((y) => y.id === Number(m.id)); if (x) send(ws, { t: 'twimg', id: x.id, img: x.img }); return; }
      else if (m.t === 'tstats') { tapriStats(room, p, ws); return; }
      else if (m.t === 'tak') { akHandle(room, p, m); }
      else if (m.t === 'ttd') { tdHandle(room, p, m, ws); }
      else if (m.t === 'tmadd' || m.t === 'tmvote' || m.t === 'tmnext' || m.t === 'tmsearch') { return muHandle(room, p, m, ws); }
      else if (m.t === 'tscore') { t.score = clean(m.text, 44); }
      else if (m.t === 'tludo') {
        const L = t.ludo || (t.ludo = { pl: [], pos: {}, turn: 0, dice: 0, win: null, log: '' }), WIN = 30, live = (id) => { const q = room.players.get(id); return q && !q.left; };
        const next = () => { for (let i = 1; i <= L.pl.length; i++) { const j = (L.turn + i) % L.pl.length; if (live(L.pl[j])) { L.turn = j; return; } } };
        if (m.a === 'join') { if (L.pl.includes(p.id) || L.pl.length >= 4) return; if (L.win) { L.pl.forEach((id) => { L.pos[id] = 0; }); L.win = null; L.turn = 0; L.dice = 0; } L.pl.push(p.id); L.pos[p.id] = 0; L.log = p.name + ' sat down to play'; }
        else if (m.a === 'leave') { const i = L.pl.indexOf(p.id); if (i < 0) return; L.pl.splice(i, 1); delete L.pos[p.id]; if (L.turn >= L.pl.length) L.turn = 0; if (!L.pl.length) t.ludo = null; }
        else if (m.a === 'reset') { if (!L.pl.includes(p.id) && p.id !== room.hostId) return; L.pl.forEach((id) => { L.pos[id] = 0; }); L.turn = 0; L.dice = 0; L.win = null; L.log = 'New game!'; }
        else if (m.a === 'roll') { if (L.win || L.pl.length < 2 || L.pl[L.turn] !== p.id) return; const d = 1 + Math.floor(Math.random() * 6); L.dice = d; let np = (L.pos[p.id] || 0) + d, msg = p.name + ' rolled ' + d;
          if (np > WIN) np = L.pos[p.id]; else if (np === WIN) { L.win = p.id; msg += ' and WON! 🏆'; }
          else for (const id of L.pl) if (id !== p.id && L.pos[id] === np && np > 0) { L.pos[id] = 0; const q = room.players.get(id); msg += ', sent ' + (q ? q.name : 'someone') + ' back!'; }
          L.pos[p.id] = np; L.log = msg; if (!L.win && d !== 6) next(); }
      }
      else if (m.t === 'tnote') { const now = Date.now(); if (now - (p.lastNote || 0) < 4000) return errTo(ws, 'Wait a moment before pinning another idea'); const text = clean(m.text, 90); if (!text) return; p.lastNote = now;
        t.notes.push({ id: ++t.nid, by: p.name, pid: p.id, text: text, at: now }); if (t.notes.length > 16) t.notes.shift(); }
      else if (m.t === 'tdel') { const i = t.notes.findIndex((n) => n.id === Number(m.id)); if (i >= 0 && (t.notes[i].pid === p.id || p.id === room.hostId)) t.notes.splice(i, 1); }
      return broadcast(room);
    }
    case 'ltset': {
      if (!hostOnly() || room.game !== 'lasttile' || room.phase !== 'lobby') return;
      const ls = room.ltSet || (room.ltSet = { bots: 5, floors: 3, speed: 'normal', push: true });
      if (Number.isInteger(m.bots)) ls.bots = Math.max(0, Math.min(15, m.bots));
      if ([1, 2, 3].includes(m.floors)) ls.floors = m.floors;
      if (['slow', 'normal', 'fast'].includes(m.speed)) ls.speed = m.speed;
      if (typeof m.push === 'boolean') ls.push = m.push;
      return broadcast(room);
    }
    case 'ltstart': {
      if (!hostOnly() || room.game !== 'lasttile' || !['lobby', 'ltover', 'ltplay'].includes(room.phase)) return;
      const e = ltStart(room); return e ? errTo(ws, e) : undefined;
    }
    case 'ltlobby': {
      if (!hostOnly() || room.game !== 'lasttile' || room.phase === 'lobby') return;
      setPhase(room, 'lobby'); room.lt = null;
      for (const [qid, q] of room.players) if (q.left) room.players.delete(qid);
      return broadcast(room);
    }
    case 'ltin': {
      if (room.game !== 'lasttile' || room.phase !== 'ltplay' || p.id === room.hostId) return;
      const h = room.players.get(room.hostId); if (!h || !h.ws || !h.connected) return;
      const f = (v) => { v = Number(v); return Number.isFinite(v) ? Math.max(-1, Math.min(1, Math.round(v * 100) / 100)) : 0; };
      return send(h.ws, { t: 'ltin', id: p.id, mx: f(m.mx), my: f(m.my), jn: (Number(m.jn) | 0) & 255 });
    }
    case 'ltst': {
      if (room.game !== 'lasttile' || room.phase !== 'ltplay' || p.id !== room.hostId) return;
      const now = Date.now(); if (now - (room.ltAt || 0) < 20) return; room.ltAt = now;
      m.t = 'ltst'; return bfRelay(room, p, m);
    }
    case 'ltend': {
      if (room.game !== 'lasttile' || room.phase !== 'ltplay' || p.id !== room.hostId || !room.lt) return;
      const ids = room.lt.ids, w = Number(m.w); recordWins(room, 'lasttile', ids, Number.isInteger(w) && ids[w] ? [ids[w]] : []);
      setPhase(room, 'ltover'); return broadcast(room);
    }
    case 'lzset': {
      if (!hostOnly() || room.game !== 'laser' || room.phase !== 'lobby') return;
      const ls = room.lzSet || (room.lzSet = { bots: 3, shrink: 'center', time: 15 });
      if (Number.isInteger(m.bots)) ls.bots = Math.max(0, Math.min(7, m.bots));
      if (m.shrink === 'center' || m.shrink === 'random') ls.shrink = m.shrink;
      if ([10, 15, 20].includes(m.time)) ls.time = m.time;
      return broadcast(room);
    }
    case 'lzstart': {
      if (!hostOnly() || room.game !== 'laser' || !['lobby', 'lzover', 'lzplay'].includes(room.phase)) return;
      const e = lzStart(room); return e ? errTo(ws, e) : undefined;
    }
    case 'lzlobby': {
      if (!hostOnly() || room.game !== 'laser' || room.phase === 'lobby') return;
      setPhase(room, 'lobby'); room.lz = null;
      for (const [qid, q] of room.players) if (q.left) room.players.delete(qid);
      return broadcast(room);
    }
    case 'lzin': {
      if (room.game !== 'laser' || room.phase !== 'lzplay' || p.id === room.hostId) return;
      const h = room.players.get(room.hostId); if (!h || !h.ws || !h.connected) return;
      const f = (v, a) => { v = Number(v); return Number.isFinite(v) ? Math.max(-a, Math.min(a, Math.round(v * 100) / 100)) : 0; };
      return send(h.ws, { t: 'lzin', id: p.id, mx: f(m.mx, 1), my: f(m.my, 1), a: f(m.a, 7), r: m.r ? 1 : 0 });
    }
    case 'lzst': {
      if (room.game !== 'laser' || room.phase !== 'lzplay' || p.id !== room.hostId) return;
      const now = Date.now(); if (now - (room.lzAt || 0) < 20) return; room.lzAt = now;
      m.t = 'lzst'; return bfRelay(room, p, m);
    }
    case 'lzend': {
      if (room.game !== 'laser' || room.phase !== 'lzplay' || p.id !== room.hostId || !room.lz) return;
      const ids = room.lz.ids, w = Number(m.w); recordWins(room, 'laser', ids, Number.isInteger(w) && ids[w] ? [ids[w]] : []);
      setPhase(room, 'lzover'); return broadcast(room);
    }
    case 'crstart': {
      if (!hostOnly() || room.game !== 'carrom' || !['lobby', 'crover', 'crplay'].includes(room.phase)) return;
      const e = crStart(room); return e ? errTo(ws, e) : undefined;
    }
    case 'crlobby': {
      if (!hostOnly() || room.game !== 'carrom' || room.phase === 'lobby') return;
      setPhase(room, 'lobby'); room.cr = null;
      for (const [qid, q] of room.players) if (q.left) room.players.delete(qid);
      return broadcast(room);
    }
    case 'crin': {
      if (room.game !== 'carrom' || room.phase !== 'crplay' || p.id === room.hostId) return;
      const h = room.players.get(room.hostId); if (!h || !h.ws || !h.connected) return;
      const f = (v, a) => { v = Number(v); return Number.isFinite(v) ? Math.max(-a, Math.min(a, Math.round(v * 100) / 100)) : 0; };
      return send(h.ws, { t: 'crin', id: p.id, x: f(m.x, 40), dx: f(m.dx, 200), dy: f(m.dy, 200), p: f(m.p, 1) });
    }
    case 'crst': {
      if (room.game !== 'carrom' || room.phase !== 'crplay' || p.id !== room.hostId) return;
      const now = Date.now(); if (now - (room.crAt || 0) < 20) return; room.crAt = now;
      m.t = 'crst'; return bfRelay(room, p, m);
    }
    case 'crend': {
      if (room.game !== 'carrom' || room.phase !== 'crplay' || p.id !== room.hostId || !room.cr) return;
      const ids = room.cr.ids, win = m.win === 'b' ? 'b' : 'w'; recordWins(room, 'carrom', ids, ids.filter((id, i) => (i % 2 === 0) === (win === 'w')));
      setPhase(room, 'crover'); return broadcast(room);
    }
    case 'mbset': {
      if (!hostOnly() || room.game !== 'bomb' || !['lobby', 'mover'].includes(room.phase)) return;
      const st = room.mbSet;
      if (Number.isInteger(Number(m.bots)) && m.bots >= 0 && m.bots <= 9) st.bots = Number(m.bots);
      if (['chill', 'normal', 'hectic'].includes(m.speed)) st.speed = m.speed;
      if (typeof m.shrink === 'boolean') st.shrink = m.shrink;
      return broadcast(room);
    }
    case 'mbstart': {
      if (!hostOnly() || room.game !== 'bomb' || !['lobby', 'mover', 'mplay'].includes(room.phase)) return;
      const e = mbStart(room); return e ? errTo(ws, e) : undefined;
    }
    case 'mblobby': {
      if (!hostOnly() || room.game !== 'bomb' || room.phase === 'lobby') return;
      setPhase(room, 'lobby'); room.mb = null;
      for (const [qid, q] of room.players) if (q.left) room.players.delete(qid);
      return broadcast(room);
    }
    case 'mbin': {
      if (room.game !== 'bomb' || room.phase !== 'mplay' || p.id === room.hostId) return;
      const h = room.players.get(room.hostId); if (!h || !h.ws || !h.connected) return;
      const f = (v) => { v = Number(v); return Number.isFinite(v) ? Math.max(-1, Math.min(1, Math.round(v * 100) / 100)) : 0; };
      return send(h.ws, { t: 'mbin', id: p.id, x: f(m.x), y: f(m.y), d: (Number(m.d) | 0) % 1e6 });
    }
    case 'mbst': {
      if (room.game !== 'bomb' || room.phase !== 'mplay' || p.id !== room.hostId) return;
      const now = Date.now(); if (now - (room.mbAt || 0) < 20) return; room.mbAt = now;
      m.t = 'mbst'; return bfRelay(room, p, m);
    }
    case 'mbend': {
      if (room.game !== 'bomb' || room.phase !== 'mplay' || p.id !== room.hostId || !room.mb) return;
      setPhase(room, 'mover'); return broadcast(room);
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

wss.on('connection', (ws, req) => {
  ws.isAlive = true; ws.rl = 0; ws.rh = 0;
  ws.uid = rid(); ws.since = Date.now(); ws.ip = ipOf(req); ws.ua = String(req.headers['user-agent'] || '').slice(0, 220);
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => {
    ws.isAlive = true;
    let m;
    try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    const hot = m && (m.t === 'dop' || m.t === 'dguess' || m.t === 'rpos' || m.t === 'ckpos' || m.t === 'rprog' || m.t === 'rbump' || m.t === 'vsig' || m.t === 'ping' || m.t === 'bin' || m.t === 'bst' || m.t === 'kin' || m.t === 'kst' || m.t === 'mbin' || m.t === 'mbst' || m.t === 'crin' || m.t === 'crst' || m.t === 'lzin' || m.t === 'lzst' || m.t === 'ltin' || m.t === 'ltst');
    if (hot ? ++ws.rh > 420 : ++ws.rl > 40) return; // flood guard (reset every 5s); race positions & voice setup have their own, bigger budget
    try { handle(ws, m); } catch (e) { console.error('handler error:', e); }
  });
  ws.on('close', () => {
    frLogout(ws);
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

module.exports = { setDb, GolfSim, server, rooms, broadcast, pickPair, cleanModes, pairKey, COOLDOWN, MEME_SHARE, pickImpostors, spreadOrder };
