# Tilewar

A real-time shared grid. 1,200 tiles (40×30). Open the site, pick a name and colour, click a tile to capture it, and everyone else watches it happen live. Steal tiles from rivals once their shield wears off.

```bash
npm install
npm start          # http://localhost:3000
npm test           # 12 unit + 6 integration tests, incl. a 60-client load test
```

Open it in two browsers (or a normal + private window) to see the real-time sync. Config via env: `PORT`, `GRID_W`, `GRID_H`, `COOLDOWN_MS`, `LOCK_MS`, `DATA_FILE`.

## Stack and why

| Layer | Choice | Why |
|---|---|---|
| Server | Node.js + [`ws`](https://github.com/websockets/ws) | Single-threaded event loop means every claim is naturally atomic, which makes conflict handling trivial and provable. `ws` is a thin, battle-tested WebSocket layer, so the protocol is visible rather than hidden behind a framework. |
| Real-time | Raw WebSockets, small JSON protocol | Bi-directional, low-latency, nothing to configure. No Socket.IO: I wanted control over reconnects, batching and ordering. |
| State | In-memory typed arrays + atomic JSON snapshots to disk | The world is ~1k tiles, so a database round-trip per click would add latency for no benefit. Snapshots (debounced, temp-file + rename) survive restarts and crashes. |
| Frontend | Vanilla ES modules + one `<canvas>`, no build step | Canvas keeps 1,200 animated tiles smooth with zoom/pan; no framework or bundler to explain. |

## How conflicts and real-time work

**Server is the only authority.** Clients send *intent* (`claim tile 42`), never state. `Game.claim()` is synchronous, so two simultaneous claims are serialised by the event loop: the first wins, the second gets a `nack` with the reason and the authoritative tile state. No locks, no race window.

**Rules (all enforced server-side, so a hacked client can't cheat):**
- *Cooldown*: 1.5 s between your claims.
- *Shield*: a freshly captured tile can't be stolen for 5 s. After that it's up for grabs.
- Can't claim your own tile. Rejected claims don't burn your cooldown.

**Instant feel without lying.** The client paints a pending claim optimistically (pulsing tile), then settles on `ack` or rolls back on `nack`. The server replies to the claimer immediately, and fans the change out to everyone else in a coalesced batch every ≤50 ms: one `JSON.stringify` per batch, shared by all sockets, so cost grows with *changes*, not with *changes × clients*.

**Order-independent convergence.** Every change carries a global revision `r`. The client applies a change only if `r` is newer than the tile's current revision. Acks, batches and rejections can therefore arrive in any order and clients still end up identical. The load test proves it: 60 clients hammering for 1.5 s all end with a board byte-identical to the server's, and the number of acks equals the server's revision counter.

**Resilience.**
- Identity is a secret token in `localStorage`; reconnecting restores your name, colour, tiles and cooldown.
- Auto-reconnect with exponential backoff and jitter; a reconnect gets a full `welcome` snapshot, so there is nothing to diff and nothing to miss.
- Heartbeat pings drop half-open sockets so "online" stays honest.
- Per-connection token-bucket rate limit, 1 KB frame cap, input validation and sanitised names (control/bidi characters stripped, colours restricted to a palette), slow-consumer protection (`bufferedAmount`), and a CSP with no inline scripts or styles.

### Protocol

```
C→S  hello   {token?, name?, color?}     S→C  welcome {you, cfg, seq, owners, locks, users, online, cooldownUntil, now}
C→S  claim   {i, rid}                    S→C  ack     {rid, i, o, p, lock, r, cd}     (to claimer, immediate)
C→S  profile {name?, color?}             S→C  nack    {rid, i, reason, retryAt?, tile}
                                         S→C  tiles   {u:[{i,o,p,lock,r}]}            (to everyone, batched)
                                         S→C  user    {u:{id,name,color}}
                                         S→C  online  {n}
```

## UI

- Canvas board with **zoom / pan** (wheel, drag, pinch on touch, +/−/fit buttons) and keyboard play (arrows move, Enter claims, `0` fits).
- Micro-interactions: pop + ripple on capture, shake and red flash on rejection, shrinking **shield ring** on protected tiles, pulsing optimistic state, hover tooltip with owner and live shield countdown.
- Sidebar: editable name, 12-colour picker, cooldown meter, live **leaderboard** (reuses DOM rows so ranks re-order without flicker), territory progress, and an activity feed that flags when someone takes *your* tile.
- Dark and light themes (follows the OS), responsive down to phone width, `prefers-reduced-motion` respected.

## Project layout

```
server/game.js    rules + state (pure, no I/O, injectable clock)
server/app.js     HTTP static + WebSocket protocol, batching, rate limiting
server/store.js   debounced atomic snapshots
public/           index.html, style.css, app.js (canvas client)
test/             unit tests, integration + load tests, headless protocol client
```

## What I'd do next to scale out

Today it's one process, which comfortably handles hundreds of concurrent players. To go beyond one node: shard the world into regions so clients subscribe only to the chunks they can see, and move `claim()` into an atomic Redis Lua script (or a Postgres `UPDATE … WHERE` conditional write) with Redis pub/sub fanning updates out across stateless WebSocket nodes. The revision-based client protocol already tolerates that kind of reordering.
