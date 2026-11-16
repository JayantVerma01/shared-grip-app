'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const { Game, PALETTE } = require('./game');
const { Store } = require('./store');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};
const CSP = "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'";

/**
 * Builds the HTTP + WebSocket server. Returns a handle so tests can start it
 * on an ephemeral port and inspect/close it.
 *
 * Protocol (JSON text frames)
 *   C->S  hello   {t, token?, name?, color?, v}      first message, identifies the user
 *   C->S  claim   {t, i, rid}                         try to capture tile i
 *   C->S  profile {t, name?, color?}                  rename / recolour
 *   S->C  welcome {t, you, cfg, now, seq, owners, locks, users, online, cooldownUntil}
 *   S->C  ack     {t, rid, i, o, p, lock, r, cd}      your claim won (sent immediately)
 *   S->C  nack    {t, rid, i, reason, retryAt?, tile} your claim lost / was invalid
 *   S->C  tiles   {t, u:[{i,o,p,lock,r}]}             batched tile changes for everyone
 *   S->C  user    {t, u:{id,name,color}}              user joined / changed profile
 *   S->C  online  {t, n}                              number of distinct users online
 */
function createApp(opts = {}) {
  const {
    port = 3000,
    host = '0.0.0.0',
    dataFile = null,
    game: gameOpts = {},
    batchMs = 50,                       // tile-update coalescing window
    rate = { burst: 20, perSec: 10 },   // per-connection message budget
  } = opts;

  let store = null;
  let game = new Game(gameOpts);
  if (dataFile) {
    store = new Store(dataFile, () => game.serialize());
    const restored = Game.fromState(store.load(), gameOpts);
    if (restored) game = restored;
  }

  const conns = new Set();   // joined connections (receive broadcasts)
  const byUser = new Map();  // userId -> Set<conn>  (several tabs per user are fine)
  let pending = [];          // tile updates waiting for the next batch flush
  let flushTimer = null;
  let onlineDirty = false;

  /* ------------------------------------------------------------- http */
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, online: byUser.size, claimed: game.claimedCount(), tiles: game.size, seq: game.seq }));
    }
    let rel;
    try { rel = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end(); }
    if (rel === '/') rel = '/index.html';
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
      res.writeHead(200, {
        'content-type': MIME[path.extname(file)] || 'application/octet-stream',
        'cache-control': 'no-cache',
        'content-security-policy': CSP,
        'x-content-type-options': 'nosniff',
      });
      fs.createReadStream(file).pipe(res);
    });
  });

  /* -------------------------------------------------------- websocket */
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1024, perMessageDeflate: false });

  const send = (conn, payload) => {
    const ws = conn.ws;
    if (ws.readyState !== 1) return;
    // A client that can't keep up must not make the server buffer without bound.
    if (ws.bufferedAmount > 1024 * 1024) return ws.terminate();
    ws.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
  };
  const broadcast = (payload) => {
    const str = typeof payload === 'string' ? payload : JSON.stringify(payload);
    for (const c of conns) send(c, str);
  };

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(flush, batchMs);
  }
  /** Coalesce everything that happened in the window into one frame, serialised once for all clients. */
  function flush() {
    flushTimer = null;
    if (pending.length) {
      const u = pending;
      pending = [];
      broadcast({ t: 'tiles', u });
    }
    if (onlineDirty) {
      onlineDirty = false;
      broadcast({ t: 'online', n: byUser.size });
    }
  }

  function onHello(conn, msg) {
    if (conn.user) return;
    const user = game.join({ token: msg.token, name: msg.name, color: msg.color });
    conn.user = user;
    let set = byUser.get(user.id);
    if (!set) byUser.set(user.id, (set = new Set()));
    set.add(conn);

    const snap = game.snapshot(new Set(byUser.keys()));
    send(conn, {
      t: 'welcome', v: 1,
      you: { id: user.id, name: user.name, color: user.color, token: user.token },
      cfg: { w: game.width, h: game.height, cooldownMs: game.cooldownMs, lockMs: game.lockMs, palette: PALETTE },
      now: Date.now(), echo: msg.ts, // `echo` lets the client estimate clock offset
      online: byUser.size, cooldownUntil: user.cooldownUntil,
      ...snap,
    });
    conns.add(conn); // only now, so welcome is always the first frame
    // Everyone else needs to learn (or refresh) this user's name/colour before seeing their tiles.
    for (const c of conns) if (c !== conn) send(c, { t: 'user', u: game.publicUser(user) });
    onlineDirty = true;
    scheduleFlush();
    store?.markDirty();
  }

  function onClaim(conn, msg) {
    const rid = Number.isSafeInteger(msg.rid) ? msg.rid : 0;
    const res = game.claim(conn.user.id, msg.i);
    if (res.ok) {
      const u = res.update;
      send(conn, { t: 'ack', rid, i: u.i, o: u.o, p: u.p, lock: u.lock, r: u.r, cd: res.cooldownUntil });
      pending.push(u);
      scheduleFlush();
      store?.markDirty();
    } else {
      send(conn, { t: 'nack', rid, i: msg.i, reason: res.reason, retryAt: res.retryAt, tile: res.tile });
    }
  }

  function onProfile(conn, msg) {
    const user = game.setProfile(conn.user.id, msg);
    if (!user) return;
    broadcast({ t: 'user', u: game.publicUser(user) });
    store?.markDirty();
  }

  wss.on('connection', (ws) => {
    const conn = { ws, user: null, alive: true, tokens: rate.burst, last: Date.now(), strikes: 0 };
    const helloTimer = setTimeout(() => !conn.user && ws.close(4000, 'hello timeout'), 5000);

    ws.on('pong', () => { conn.alive = true; });
    ws.on('error', () => {});
    ws.on('message', (data, isBinary) => {
      if (isBinary) return ws.close(1003);
      // Token bucket: protects the server from a client spamming claims.
      const now = Date.now();
      conn.tokens = Math.min(rate.burst, conn.tokens + ((now - conn.last) / 1000) * rate.perSec);
      conn.last = now;
      if (conn.tokens < 1) {
        if (++conn.strikes > 200) ws.close(1008, 'rate limit');
        return;
      }
      conn.tokens -= 1;

      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.t === 'hello') return onHello(conn, msg);
      if (!conn.user) return;
      if (msg.t === 'claim') return onClaim(conn, msg);
      if (msg.t === 'profile') return onProfile(conn, msg);
    });
    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (!conn.user) return;
      conns.delete(conn);
      const set = byUser.get(conn.user.id);
      set?.delete(conn);
      if (set && set.size === 0) byUser.delete(conn.user.id);
      conn.user.lastSeen = Date.now();
      onlineDirty = true;
      scheduleFlush();
    });
  });

  // Heartbeat: drop half-open connections so "online" stays honest.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      const conn = [...conns].find((c) => c.ws === ws);
      if (conn && !conn.alive) { ws.terminate(); continue; }
      if (conn) conn.alive = false;
      ws.ping();
    }
  }, 30000);
  heartbeat.unref();

  return {
    server, game, wss,
    listen: () => new Promise((resolve) => server.listen(port, host, () => resolve(server.address().port))),
    close: () => new Promise((resolve) => {
      clearInterval(heartbeat);
      clearTimeout(flushTimer);
      store?.flushSync();
      for (const ws of wss.clients) ws.terminate();
      wss.close(() => server.close(() => resolve()));
    }),
  };
}

module.exports = { createApp };
