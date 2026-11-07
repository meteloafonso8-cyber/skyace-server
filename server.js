'use strict';
/*
 * Sky Ace – servidor (ranking global + salas multijogador)
 * Sem dependências: precisa apenas de Node.js 18+.
 *
 * Variáveis de ambiente (todas opcionais):
 *   PORT                  porta (por omissão 8080)
 *   DATA_DIR              pasta onde guarda scores.json (por omissão ./data)
 *   ADMIN_KEY             chave para apagar entradas do ranking (moderação)
 *   ALLOWED_EXTENSION_ID  ID da tua extensão; se definido, só ela pode ligar-se
 *   TRUST_PROXY=1         usa X-Forwarded-For (necessário atrás de Render/Fly/Nginx)
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = +process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const EXT_ID = (process.env.ALLOWED_EXTENSION_ID || '').trim();
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const MAX_MSG = 2048;           // bytes por mensagem WebSocket
const MAX_CLIENTS = 3000;
const MAX_PER_IP = 8;
const MAX_ROOMS = 800;
const ROOM_MAX_PLAYERS = 4;
const MATCH_MS = 120000;        // duração de uma partida
const COUNTDOWN_MS = 3000;
const MAX_STORED_SCORES = 5000;

/* ------------------------------------------------------------------ */
/* utilitários                                                         */
/* ------------------------------------------------------------------ */
const clean = (s, fallback = 'Piloto') => {
  const t = String(s ?? '').normalize('NFKC').replace(/[^\p{L}\p{N} _.\-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 12);
  return t.length >= 2 ? t : fallback;
};
const int = (v, lo, hi) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
};
const num = (v, lo, hi) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
};
const PID_RE = /^[a-f0-9]{16,64}$/;

const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const h = hits.get(key);
  if (!h || now - h.t > windowMs) { hits.set(key, { t: now, n: 1 }); return false; }
  h.n++;
  return h.n > max;
}
setInterval(() => { const now = Date.now(); for (const [k, h] of hits) if (now - h.t > 120000) hits.delete(k); }, 60000).unref();

const ipOf = req => {
  if (TRUST_PROXY) {
    const x = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (x) return x;
  }
  return req.socket.remoteAddress || '?';
};

/* ------------------------------------------------------------------ */
/* ranking global                                                      */
/* ------------------------------------------------------------------ */
const SCORES_FILE = path.join(DATA_DIR, 'scores.json');
const scores = new Map(); // pid -> { n: nome, s: pontos, l: nível, t: timestamp }

// Armazenamento externo opcional (Upstash Redis via HTTP). Sem isto usa ficheiro local.
const UP_URL = (process.env.UPSTASH_REDIS_REST_URL || '').trim().replace(/\/+$/, '');
const UP_TOKEN = (process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
const REMOTE = !!(UP_URL && UP_TOKEN);
const HKEY = 'skyace:scores';
const RETRY_MS = +process.env.REMOTE_RETRY_MS || 30000;

async function redis(cmd) {
  const r = await fetch(UP_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + UP_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
    signal: AbortSignal.timeout(8000)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error || 'http ' + r.status);
  return j.result;
}
async function redisRetry(cmd, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try { return await redis(cmd); } catch (e) {
      if (i === tries - 1) { console.error('Upstash falhou (' + cmd[0] + '):', e.message); return null; }
      await new Promise(r => setTimeout(r, 800 * (i + 1)));
    }
  }
}
function save(pid) { if (REMOTE && scores.has(pid)) redisRetry(['HSET', HKEY, pid, JSON.stringify(scores.get(pid))]); }
function drop(pid) { if (REMOTE) redisRetry(['HDEL', HKEY, pid]); }

let dirty = false, sortedCache = null;
const touch = () => { dirty = true; sortedCache = null; };
const sorted = () => sortedCache || (sortedCache = [...scores.entries()].sort((a, b) => b[1].s - a[1].s || a[1].t - b[1].t));

async function loadScores() {
  if (!REMOTE) {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const j = JSON.parse(fs.readFileSync(SCORES_FILE, 'utf8'));
      for (const [k, v] of Object.entries(j)) scores.set(k, v);
    } catch (e) { /* primeira execução */ }
    console.log(`Ranking em ficheiro (${SCORES_FILE}): ${scores.size} entradas`);
    setInterval(() => {
      if (!dirty) return;
      dirty = false;
      fs.writeFile(SCORES_FILE + '.tmp', JSON.stringify(Object.fromEntries(scores)), err => {
        if (!err) fs.rename(SCORES_FILE + '.tmp', SCORES_FILE, () => {});
      });
    }, 8000).unref();
    return;
  }
  for (;;) {
    try {
      const res = await redis(['HGETALL', HKEY]);
      const arr = Array.isArray(res) ? res : Object.entries(res || {}).flat();
      for (let i = 0; i + 1 < arr.length; i += 2) {
        try {
          const v = JSON.parse(arr[i + 1]), cur = scores.get(arr[i]);
          if (!cur || v.s > cur.s) scores.set(arr[i], v);
        } catch (e) { /* entrada inválida */ }
      }
      sortedCache = null;
      console.log(`Ranking carregado do Upstash: ${scores.size} entradas`);
      return;
    } catch (e) {
      console.error('Upstash indisponível, a tentar de novo:', e.message);
      await new Promise(r => setTimeout(r, RETRY_MS));
    }
  }
}

function submitScore(b) {
  const pid = String(b.pid || '');
  if (!PID_RE.test(pid)) return { err: 'pid' };
  const score = int(b.score, 0, 5000000);
  const time = num(b.time, 0, 7200);
  const level = int(b.level, 1, 99);
  if (time < 3) return { err: 'time' };
  if (score > time * 2500 + 500) return { err: 'implausible' };  // filtro anti-batota básico
  const name = clean(b.name);
  const prev = scores.get(pid);
  if (!prev || score > prev.s) {
    scores.set(pid, { n: name, s: score, l: level, t: Date.now() });
    touch(); save(pid);
    if (scores.size > MAX_STORED_SCORES) {
      const worst = sorted()[sorted().length - 1];
      if (worst) { scores.delete(worst[0]); drop(worst[0]); touch(); }
    }
  } else if (prev.n !== name) { prev.n = name; touch(); save(pid); }
  const list = sorted();
  const rank = list.findIndex(e => e[0] === pid) + 1;
  return { ok: true, rank, total: list.length, best: scores.get(pid).s };
}

function topView(limit, pid) {
  const list = sorted();
  const top = list.slice(0, limit).map((e, i) => ({ r: i + 1, n: e[1].n, s: e[1].s, l: e[1].l, you: e[0] === pid }));
  let me = null;
  if (pid && PID_RE.test(pid)) {
    const i = list.findIndex(e => e[0] === pid);
    if (i >= 0) me = { r: i + 1, n: list[i][1].n, s: list[i][1].s };
  }
  return { top, me, total: list.length };
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */
const corsOrigin = () => (EXT_ID ? 'chrome-extension://' + EXT_ID : '*');
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': corsOrigin(),
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
    'Access-Control-Max-Age': '600',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}
function readBody(req, cb) {
  let size = 0; const chunks = [];
  req.on('data', c => { size += c.length; if (size > 2048) { req.destroy(); return; } chunks.push(c); });
  req.on('end', () => { try { cb(null, JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { cb(e); } });
  req.on('error', () => cb(new Error('read')));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const ip = ipOf(req);
  if (req.method === 'OPTIONS') return send(res, 204, {});

  if (req.method === 'GET' && url.pathname === '/health')
    return send(res, 200, { ok: true, rooms: rooms.size, clients: clients.size, scores: scores.size, storage: REMOTE ? 'upstash' : 'file', up: Math.round(process.uptime()) });

  if (req.method === 'GET' && url.pathname === '/api/top') {
    if (limited('g:' + ip, 120, 60000)) return send(res, 429, { err: 'rate' });
    const limit = int(url.searchParams.get('limit') || 15, 1, 50);
    return send(res, 200, topView(limit, url.searchParams.get('pid') || ''));
  }

  if (req.method === 'POST' && url.pathname === '/api/score') {
    if (limited('p:' + ip, 20, 60000)) return send(res, 429, { err: 'rate' });
    return readBody(req, (err, body) => {
      if (err) return send(res, 400, { err: 'json' });
      const r = submitScore(body);
      send(res, r.err ? 422 : 200, r);
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/delete') {
    if (!ADMIN_KEY || req.headers['x-admin-key'] !== ADMIN_KEY) return send(res, 403, { err: 'forbidden' });
    return readBody(req, (err, body) => {
      if (err) return send(res, 400, { err: 'json' });
      // apagar por pid, ou por nome (apaga todas as entradas com esse nome)
      let n = 0;
      if (body.pid && scores.delete(String(body.pid))) { drop(String(body.pid)); n++; }
      if (body.name) for (const [k, v] of scores) if (v.n === String(body.name)) { scores.delete(k); drop(k); n++; }
      if (n) touch();
      send(res, 200, { ok: true, deleted: n });
    });
  }
  send(res, 404, { err: 'not_found' });
});

/* ------------------------------------------------------------------ */
/* WebSocket mínimo (RFC 6455) – texto apenas                          */
/* ------------------------------------------------------------------ */
const clients = new Set();
const perIp = new Map();

function frame(op, payload) {
  const p = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '');
  let h;
  if (p.length < 126) h = Buffer.from([0x80 | op, p.length]);
  else if (p.length < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 126; h.writeUInt16BE(p.length, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(p.length), 2); }
  return Buffer.concat([h, p]);
}
function wsSend(c, obj) {
  if (c.dead || !c.sock.writable) return;
  try { c.sock.write(frame(1, JSON.stringify(obj))); } catch (e) { /* ignorar */ }
}
function kill(c) {
  if (c.dead) return;
  c.dead = true;
  clients.delete(c);
  perIp.set(c.ip, Math.max(0, (perIp.get(c.ip) || 1) - 1));
  leaveRoom(c);
  try { c.sock.destroy(); } catch (e) { /* ignorar */ }
}

server.on('upgrade', (req, sock) => {
  const ip = ipOf(req);
  const origin = String(req.headers.origin || '');
  const key = req.headers['sec-websocket-key'];
  const okOrigin = EXT_ID ? origin === 'chrome-extension://' + EXT_ID : true;
  if (req.url.split('?')[0] !== '/ws' || !key || !okOrigin || clients.size >= MAX_CLIENTS || (perIp.get(ip) || 0) >= MAX_PER_IP) {
    sock.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return sock.destroy();
  }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  sock.setNoDelay(true);
  const c = { sock, ip, buf: Buffer.alloc(0), frag: null, fragLen: 0, alive: true, dead: false, tokens: 80, tk: Date.now(), room: null, p: null };
  clients.add(c);
  perIp.set(ip, (perIp.get(ip) || 0) + 1);
  sock.on('data', d => onData(c, d));
  sock.on('close', () => kill(c));
  sock.on('error', () => kill(c));
});

function onData(c, chunk) {
  c.buf = Buffer.concat([c.buf, chunk]);
  if (c.buf.length > MAX_MSG * 4) return kill(c);
  for (;;) {
    const b = c.buf;
    if (b.length < 2) return;
    const fin = !!(b[0] & 0x80), op = b[0] & 0x0f, masked = !!(b[1] & 0x80);
    let len = b[1] & 0x7f, off = 2;
    if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) return; const big = b.readBigUInt64BE(2); if (big > BigInt(MAX_MSG)) return kill(c); len = Number(big); off = 10; }
    if (!masked || len > MAX_MSG) return kill(c);
    if (b.length < off + 4 + len) return;
    const mask = b.subarray(off, off + 4);
    const payload = Buffer.from(b.subarray(off + 4, off + 4 + len));
    for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
    c.buf = b.subarray(off + 4 + len);

    if (op === 0x8) { try { c.sock.write(frame(0x8, Buffer.alloc(0))); } catch (e) { /* ignorar */ } return kill(c); }
    if (op === 0x9) { if (payload.length <= 125) c.sock.write(frame(0xA, payload)); continue; }
    if (op === 0xA) { c.alive = true; continue; }
    if (op === 0x1) { c.frag = [payload]; c.fragLen = len; }
    else if (op === 0x0 && c.frag) { c.frag.push(payload); c.fragLen += len; if (c.fragLen > MAX_MSG) return kill(c); }
    else return kill(c);
    if (fin) {
      const text = Buffer.concat(c.frag).toString('utf8'); c.frag = null;
      // limite de mensagens por segundo (token bucket)
      const now = Date.now();
      c.tokens = Math.min(80, c.tokens + (now - c.tk) * 0.06); c.tk = now;
      if (--c.tokens < 0) continue;
      let m; try { m = JSON.parse(text); } catch (e) { continue; }
      if (m && typeof m === 'object') onMessage(c, m);
    }
  }
}
setInterval(() => {
  for (const c of clients) {
    if (!c.alive) { kill(c); continue; }
    c.alive = false;
    try { c.sock.write(frame(0x9, Buffer.alloc(0))); } catch (e) { /* ignorar */ }
  }
}, 25000).unref();

/* ------------------------------------------------------------------ */
/* salas                                                               */
/* ------------------------------------------------------------------ */
const rooms = new Map();
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem I, O, 0, 1
function newCode() {
  for (let i = 0; i < 60; i++) {
    let s = '';
    for (let k = 0; k < 5; k++) s += ALPHA[crypto.randomInt(ALPHA.length)];
    if (!rooms.has(s)) return s;
  }
  return null;
}
const toAll = (room, obj, except) => { for (const p of room.players) if (p !== except) wsSend(p.c, obj); };
function roomInfo(room) {
  for (const p of room.players)
    wsSend(p.c, { t: 'room', code: room.code, you: p.id, host: room.hostId, state: room.state, players: room.players.map(q => ({ id: q.id, name: q.name })) });
}
function addPlayer(room, c, name) {
  const p = { id: room.nextId++, name, c, score: 0, done: false };
  room.players.push(p); c.room = room; c.p = p;
  return p;
}
function leaveRoom(c) {
  const room = c.room, p = c.p;
  if (!room) return;
  c.room = null; c.p = null;
  room.players = room.players.filter(q => q !== p);
  if (room.state === 'running') room.left.push({ id: p.id, name: p.name, score: p.score });
  if (!room.players.length) { clearTimeout(room.timer); rooms.delete(room.code); return; }
  if (room.hostId === p.id) room.hostId = room.players[0].id;
  toAll(room, { t: 'left', id: p.id });
  if (room.state === 'running' && room.players.every(q => q.done)) return finish(room);
  roomInfo(room);
}
function startMatch(room) {
  room.state = 'running'; room.left = [];
  room.seed = crypto.randomInt(1, 2147483647);
  for (const p of room.players) { p.score = 0; p.done = false; }
  toAll(room, { t: 'start', seed: room.seed, in: COUNTDOWN_MS, dur: MATCH_MS });
  room.timer = setTimeout(() => finish(room), COUNTDOWN_MS + MATCH_MS + 10000);
}
function finish(room) {
  if (room.state !== 'running') return;
  clearTimeout(room.timer);
  const all = room.players.map(p => ({ id: p.id, name: p.name, score: p.score })).concat(room.left);
  all.sort((a, b) => b.score - a.score);
  room.state = 'lobby';
  toAll(room, { t: 'results', list: all });
  roomInfo(room);
}

function onMessage(c, m) {
  const t = m.t;
  if (t === 'create') {
    if (c.room) return;
    if (rooms.size >= MAX_ROOMS || limited('c:' + c.ip, 10, 60000)) return wsSend(c, { t: 'err', m: 'Servidor cheio. Tenta daqui a pouco.' });
    const code = newCode();
    if (!code) return wsSend(c, { t: 'err', m: 'Não foi possível criar sala.' });
    const room = { code, state: 'lobby', players: [], hostId: 0, nextId: 1, seed: 0, timer: null, left: [] };
    rooms.set(code, room);
    const p = addPlayer(room, c, clean(m.name));
    room.hostId = p.id;
    return roomInfo(room);
  }
  if (t === 'join') {
    if (c.room) return;
    if (limited('j:' + c.ip, 30, 60000)) return wsSend(c, { t: 'err', m: 'Demasiadas tentativas.' });
    const room = rooms.get(String(m.code || '').toUpperCase().trim());
    if (!room) return wsSend(c, { t: 'err', m: 'Sala não encontrada.' });
    if (room.state !== 'lobby') return wsSend(c, { t: 'err', m: 'A partida já começou.' });
    if (room.players.length >= ROOM_MAX_PLAYERS) return wsSend(c, { t: 'err', m: 'Sala cheia (máx. 4).' });
    addPlayer(room, c, clean(m.name));
    return roomInfo(room);
  }
  const room = c.room, p = c.p;
  if (!room) return;
  if (t === 'start') {
    if (p.id !== room.hostId || room.state !== 'lobby') return;
    if (room.players.length < 2) return wsSend(c, { t: 'err', m: 'São precisos pelo menos 2 jogadores.' });
    return startMatch(room);
  }
  if (t === 'pos') {
    if (room.state !== 'running') return;
    p.score = int(m.s, 0, 1000000);
    return toAll(room, { t: 'pos', id: p.id, x: num(m.x, 0, 360), y: num(m.y, 0, 520), b: num(m.b, -3.5, 3.5), s: p.score, h: int(m.h, 0, 100), a: m.a ? 1 : 0 }, p);
  }
  if (t === 'atk') {
    if (room.state !== 'running') return;
    const now = Date.now();
    if (now - (p.lastAtk || 0) < 1200) return;
    p.lastAtk = now;
    return toAll(room, { t: 'atk', from: p.id, name: p.name, k: m.k === 'wave' ? 'wave' : 'diver' }, p);
  }
  if (t === 'done') {
    if (room.state !== 'running' || p.done) return;
    p.done = true; p.score = int(m.s, 0, 1000000);
    toAll(room, { t: 'fin', id: p.id, score: p.score });
    if (room.players.every(q => q.done)) finish(room);
    return;
  }
  if (t === 'leave') return leaveRoom(c);
}

server.listen(PORT, () => console.log(`Sky Ace server a ouvir na porta ${PORT}`));
loadScores();
process.on('SIGTERM', () => { try { if (REMOTE) process.exit(0); fs.writeFileSync(SCORES_FILE, JSON.stringify(Object.fromEntries(scores))); } catch (e) { /* ignorar */ } process.exit(0); });
