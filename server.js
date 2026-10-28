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
const MAX_PLAYERS = 20;
const MIN_PLAYERS = 3;
const GUESS_SECS = 30;
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I, L, O, 0, 1

// ---------------------------------------------------------------- static page
const htmlPath = [path.join(__dirname, 'public', 'index.html'), path.join(__dirname, 'index.html')].find((f) => fs.existsSync(f));
const htmlRaw = fs.readFileSync(htmlPath);
const htmlGz = zlib.gzipSync(htmlRaw, { level: 9 });
const etag = '"' + crypto.createHash('sha1').update(htmlRaw).digest('hex').slice(0, 16) + '"';

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

// ---------------------------------------------------------------- rooms
const rooms = new Map();

function newCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += ALPHABET[crypto.randomInt(ALPHABET.length)];
    if (!rooms.has(c)) return c;
  }
}
function drawPair(room) {
  if (!room.deck.length) room.deck = shuffle(PAIRS.map((_, i) => i));
  const [a, b] = PAIRS[room.deck.pop()];
  return Math.random() < 0.5 ? { civilian: a, undercover: b } : { civilian: b, undercover: a };
}
function makeRoom() {
  const room = {
    code: newCode(), hostId: null, supervisorId: null, players: new Map(),
    phase: 'lobby', round: 0, seq: 0, timer: null, endsAt: 0,
    settings: { describeSecs: 30, autoRoles: true, undercover: 1, white: 1, autoAdvance: true, whiteGuess: true },
    deck: [], pair: null, nextPair: null,
    descs: {}, history: [], votes: {}, tie: false,
    lastElim: null, guess: null, whiteId: null, winner: null, touched: Date.now(),
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
  return { u: Math.max(1, Math.floor((n - 1) / 4)), w: n >= 5 ? (n >= 12 ? 2 : 1) : 0 };
}
function plan(room) {
  const n = parts(room).length;
  const { u, w } = room.settings.autoRoles ? autoCounts(n) : { u: room.settings.undercover, w: room.settings.white };
  return { n, u, w, c: n - u - w };
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
  const sup = room.supervisorId === p.id;
  const over = room.phase === 'over';
  const inGame = ['describe', 'vote', 'whiteguess', 'elim', 'over'].includes(room.phase);
  const players = [...room.players.values()].map((q) => {
    const o = {
      id: q.id, name: q.name, connected: q.connected, host: q.id === room.hostId,
      sup: q.id === room.supervisorId, alive: q.alive, left: q.left,
    };
    if (inGame && q.role) {
      o.in = true; // takes part in this game (role itself stays private)
      if (room.phase === 'describe') o.submitted = !!room.descs[q.id];
      if (room.phase === 'vote') o.voted = !!room.votes[q.id];
      if (sup || over || q.revealed) { o.role = q.role; o.word = q.word; }
    }
    return o;
  });
  const v = {
    t: 'state', now: Date.now(), code: room.code, phase: room.phase, round: room.round,
    settings: room.settings, endsAt: room.endsAt, plan: plan(room), players,
    history: room.history, tie: room.tie, lastElim: room.lastElim, guess: room.guess, whiteId: room.whiteId,
    winner: over ? room.winner : null, pair: over ? room.pair : null,
    me: { id: p.id, name: p.name, host: p.id === room.hostId, sup, alive: p.alive && !p.left },
  };
  if (inGame && p.role) { v.me.white = p.role === 'white'; v.me.word = p.word; }
  if (p.id === room.hostId) v.startErr = room.phase === 'lobby' ? checkStart(room) : null;
  if (sup && room.phase === 'lobby') v.nextPair = room.nextPair;
  if (room.phase === 'describe') { v.myDesc = room.descs[p.id] || ''; if (sup) v.live = room.descs; }
  if (room.phase === 'vote') {
    v.myVote = room.votes[p.id] || null;
    if (room.tie || sup) v.breakdown = breakdown(room, room.votes);
  }
  return v;
}
function broadcast(room) {
  room.touched = Date.now();
  for (const p of room.players.values()) if (p.ws && p.connected) send(p.ws, view(room, p));
}

// ---------------------------------------------------------------- game flow
function startGame(room, custom) {
  const err = checkStart(room);
  if (err) return err;
  let pair = room.nextPair || drawPair(room);
  if (custom && room.supervisorId === room.hostId) {
    const a = clean(custom.civilian, 24), b = clean(custom.undercover, 24);
    if (a || b) {
      if (!a || !b) return 'Enter both custom words (or leave both empty for a random pair)';
      if (norm(a) === norm(b)) return 'The two words must be different';
      pair = { civilian: a, undercover: b };
    }
  }
  const ps = shuffle(parts(room));
  const { u, w } = plan(room);
  ps.forEach((p, i) => {
    p.role = i < u ? 'undercover' : i < u + w ? 'white' : 'civilian';
    p.word = p.role === 'civilian' ? pair.civilian : p.role === 'undercover' ? pair.undercover : '';
    p.alive = true; p.revealed = false;
  });
  room.pair = pair; room.nextPair = null;
  room.history = []; room.lastElim = null; room.guess = null; room.winner = null; room.whiteId = null;
  room.round = 1;
  startDescribe(room);
  return null;
}

function startDescribe(room) {
  setPhase(room, 'describe');
  room.descs = {}; room.votes = {}; room.tie = false; room.guess = null; room.whiteId = null;
  schedule(room, room.settings.describeSecs * 1000, () => endDescribe(room));
  broadcast(room);
}
function endDescribe(room) {
  if (room.phase !== 'describe') return;
  room.history.push({ round: room.round, items: alivePlayers(room).map((p) => [p.id, room.descs[p.id] || '']) });
  setPhase(room, 'vote');
  room.votes = {}; room.tie = false;
  broadcast(room);
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
  room.tie = true; // no majority: everyone may change their vote
  broadcast(room);
}

function eliminate(room, id) {
  const p = room.players.get(id);
  p.alive = false; p.revealed = true;
  room.lastElim = { id: p.id, name: p.name, role: p.role, word: p.word, breakdown: breakdown(room, room.votes) };
  room.tie = false;
  if (p.role === 'white' && room.settings.whiteGuess) {
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
  const imp = alive.filter((p) => p.role !== 'civilian').length;
  const civ = alive.length - imp;
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
  room.winner = winner;
  broadcast(room);
}
function backToLobby(room) {
  for (const [id, p] of room.players) if (p.left) room.players.delete(id);
  for (const p of room.players.values()) { p.role = null; p.word = ''; p.alive = true; p.revealed = false; }
  setPhase(room, 'lobby');
  room.round = 0; room.descs = {}; room.votes = {}; room.tie = false; room.history = [];
  room.lastElim = null; room.guess = null; room.whiteId = null; room.winner = null; room.pair = null;
  room.nextPair = drawPair(room);
}

// After a player leaves/is kicked mid-game, re-check whatever the current phase is waiting for.
function afterRemoval(room) {
  if (!['describe', 'vote', 'whiteguess', 'elim'].includes(room.phase)) return broadcast(room);
  const win = checkWin(room);
  if (win) return endGame(room, win);
  if (room.phase === 'describe') {
    const alive = alivePlayers(room);
    if (room.settings.autoAdvance && alive.every((p) => room.descs[p.id])) return endDescribe(room);
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
  if (room.supervisorId === p.id && room.phase === 'lobby') room.supervisorId = null;
  if (room.phase === 'lobby' || room.phase === 'over') room.players.delete(p.id);
  else { p.left = true; p.alive = false; delete room.votes[p.id]; delete room.descs[p.id]; }
  if (![...room.players.values()].some((q) => !q.left)) { clearTimeout(room.timer); rooms.delete(room.code); return; }
  if (wasHost && !transferHost(room)) { /* nobody connected: host stays unassigned until someone rejoins */ }
  afterRemoval(room);
}

// ---------------------------------------------------------------- websocket
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096, perMessageDeflate: false });

function attach(ws, room, p) {
  if (p.ws && p.ws !== ws) { p.ws.ctx = null; try { p.ws.close(); } catch (e) { /* ignore */ } }
  p.ws = ws; p.connected = true; p.discAt = 0;
  ws.ctx = { code: room.code, pid: p.id };
  if (!room.hostId || !room.players.get(room.hostId)) room.hostId = p.id;
  send(ws, { t: 'joined', id: p.id, token: p.token, code: room.code });
  broadcast(room);
}

function handle(ws, m) {
  if (!m || typeof m.t !== 'string') return;
  // ---- before joining a room
  if (m.t === 'create') {
    const name = clean(m.name, 14);
    if (!name) return errTo(ws, 'Enter your name');
    const room = makeRoom();
    const p = addPlayer(room, name);
    room.hostId = p.id;
    return attach(ws, room, p);
  }
  if (m.t === 'join') {
    const name = clean(m.name, 14);
    const room = rooms.get(clean(m.code, 4).toUpperCase());
    if (!name) return errTo(ws, 'Enter your name');
    if (!room) return errTo(ws, 'No lobby with that code');
    if (room.phase !== 'lobby' && room.phase !== 'over') return errTo(ws, 'Game already in progress. Ask the host to start a new game');
    if ([...room.players.values()].filter((q) => !q.left).length >= MAX_PLAYERS) return errTo(ws, 'Lobby is full');
    if ([...room.players.values()].some((q) => !q.left && norm(q.name) === norm(name))) return errTo(ws, 'That name is taken in this lobby');
    return attach(ws, room, addPlayer(room, name));
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
      if ('autoAdvance' in m) s.autoAdvance = !!m.autoAdvance;
      if ('whiteGuess' in m) s.whiteGuess = !!m.whiteGuess;
      if ('supervisor' in m) room.supervisorId = m.supervisor ? room.hostId : null;
      return broadcast(room);
    }
    case 'reroll':
      if (!hostOnly() || room.phase !== 'lobby' || room.supervisorId !== p.id) return;
      room.nextPair = drawPair(room);
      return broadcast(room);
    case 'start': {
      if (!hostOnly() || room.phase !== 'lobby') return;
      const err = startGame(room, m.custom);
      return err ? errTo(ws, err) : undefined;
    }
    case 'describe': {
      if (room.phase !== 'describe' || !p.alive || !p.role) return;
      const text = clean(m.text, 40);
      if (!text) return errTo(ws, 'Type a word or short phrase');
      if (p.word && mentions(text, p.word)) return errTo(ws, "Don't say your actual word!");
      room.descs[p.id] = text;
      if (room.settings.autoAdvance && alivePlayers(room).every((q) => room.descs[q.id])) return endDescribe(room);
      return broadcast(room);
    }
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
      return tryResolve(room, false);
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
      return finishGuess(room, clean(m.text, 40));
    case 'next':
      if (!hostOnly() || room.phase !== 'elim') return;
      room.round++;
      return startDescribe(room);
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

module.exports = { server, rooms };
