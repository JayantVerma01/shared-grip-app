/* Tilewar client. Plain ES modules, no build step.
 *
 * Architecture
 *   net    - WebSocket with auto-reconnect; the server is the only authority.
 *   state  - flat typed arrays mirroring the server (owner / lock / rev per tile).
 *   render - one <canvas>, redrawn only while something is changing.
 *   ui     - sidebar (profile, leaderboard, feed) kept in sync from state.
 *
 * Consistency rule: every tile change carries a server revision `r`. A change
 * is applied only if r > the tile's current revision, so acks, batches and
 * rejections can arrive in any order and the client still converges.
 */

const T = 40;          // tile size in world units
const GAP = 4;         // gap between tiles
const MIN_K = 0.25, MAX_K = 4;
const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ state */
const S = {
  w: 0, h: 0, cfg: null,
  owner: new Int32Array(0), lock: new Float64Array(0), rev: new Uint32Array(0),
  users: new Map(), counts: new Map(),
  me: null, online: 0, cooldownUntil: 0, maxLock: 0,
  clockOffset: 0,
};
const serverNow = () => Date.now() + S.clockOffset;
const pending = new Map();  // tile -> { rid, prevCooldown }   (optimistic claims awaiting ack)
const anims = new Map();    // tile -> { kind, start }
let ridCounter = 0;
let dirty = true, lbDirty = true;

const store = {
  get(k) { try { return localStorage.getItem('tilewar.' + k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem('tilewar.' + k, v); } catch { /* private mode */ } },
};

/* ------------------------------------------------------------------- view */
const canvas = $('board'), stage = $('stage'), ctx = canvas.getContext('2d');
const view = { x: 0, y: 0, k: 1 };
let cw = 0, ch = 0, dpr = 1, userMoved = false, theme = {};
let hover = -1, pointer = { x: 0, y: 0, inside: false };

function readTheme() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => cs.getPropertyValue(n).trim();
  theme = { panel: v('--panel'), tile: v('--tile'), tileHover: v('--tile-hover'), text: v('--text'), line: v('--line'), accent: v('--accent') };
  dirty = true;
}
matchMedia('(prefers-color-scheme: light)').addEventListener('change', readTheme);

function resize() {
  const r = stage.getBoundingClientRect();
  cw = r.width; ch = r.height; dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr);
  if (S.w && !userMoved) fit(); else clampView();
  dirty = true;
}
new ResizeObserver(resize).observe(stage);

function fitK() {
  const pad = 36;
  return Math.max(0.05, Math.min((cw - pad) / (S.w * T), (ch - pad) / (S.h * T)));
}
function fit() {
  if (!S.w) return;
  view.k = fitK();
  view.x = (cw - S.w * T * view.k) / 2;
  view.y = (ch - S.h * T * view.k) / 2;
  dirty = true;
}
function clampView() {
  if (!S.w) return;
  const keep = 120; // always leave part of the board on screen
  const bw = S.w * T * view.k, bh = S.h * T * view.k;
  view.x = Math.min(cw - keep, Math.max(keep - bw, view.x));
  view.y = Math.min(ch - keep, Math.max(keep - bh, view.y));
}
function zoomAt(px, py, factor) {
  const k = Math.min(MAX_K, Math.max(Math.min(MIN_K, fitK() * 0.8), view.k * factor));
  const wx = (px - view.x) / view.k, wy = (py - view.y) / view.k;
  view.k = k; view.x = px - wx * k; view.y = py - wy * k;
  userMoved = true; clampView(); dirty = true;
}
function tileAt(px, py) {
  const c = Math.floor((px - view.x) / view.k / T), r = Math.floor((py - view.y) / view.k / T);
  return c < 0 || r < 0 || c >= S.w || r >= S.h ? -1 : r * S.w + c;
}

/* ---------------------------------------------------------------- helpers */
const colorOf = (id) => S.users.get(id)?.color || '#7b8196';
const nameOf = (id) => S.users.get(id)?.name || `Player ${id}`;
const coord = (i) => `${i % S.w + 1},${Math.floor(i / S.w) + 1}`;
const ease = (p) => 1 - Math.pow(1 - p, 3);

function bump(map, id, d) { map.set(id, (map.get(id) || 0) + d); }

/* ------------------------------------------------------------------ apply */
/** Apply a tile change if it's newer than what we have. Returns the previous owner, or null if ignored. */
function applyTile(u) {
  const i = u.i;
  if (!(u.r > S.rev[i])) return null;
  const prev = S.owner[i];
  S.rev[i] = u.r;
  S.owner[i] = u.o;
  S.lock[i] = u.o ? u.lock : 0;
  if (S.lock[i] > S.maxLock) S.maxLock = S.lock[i];
  if (prev !== u.o) {
    if (prev) bump(S.counts, prev, -1);
    if (u.o) bump(S.counts, u.o, 1);
    anims.set(i, { kind: 'pop', start: performance.now() });
    lbDirty = true;
  }
  dirty = true;
  return { prev };
}

/* ------------------------------------------------------------------ claim */
function tryClaim(i) {
  if (i < 0) return;
  if (!net.ready) return toast('Offline, reconnecting…', 'error');
  const now = serverNow();
  if (S.owner[i] === S.me.id) return toast('That tile is already yours');
  if (pending.has(i)) return;
  if (now < S.cooldownUntil) { shake(i); return flashCooldown(); }
  if (S.owner[i] && now < S.lock[i]) { shake(i); return toast(`Shielded for ${((S.lock[i] - now) / 1000).toFixed(1)}s more`, 'error'); }

  const rid = ++ridCounter;
  pending.set(i, { rid, prevCooldown: S.cooldownUntil });
  S.cooldownUntil = now + S.cfg.cooldownMs; // optimistic; corrected by ack/nack
  net.send({ t: 'claim', i, rid });
  $('hint').classList.add('hide');
  dirty = true;
}
function shake(i) { anims.set(i, { kind: 'shake', start: performance.now() }); dirty = true; }
function flashCooldown() {
  const el = $('cooldown');
  el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake');
}

/* -------------------------------------------------------------------- net */
const net = {
  ws: null, ready: false, retry: 0, timer: null,
  connect() {
    clearTimeout(this.timer);
    setStatus('connecting', this.retry ? 'Reconnecting…' : 'Connecting…');
    const ws = (this.ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`));
    ws.onopen = () => {
      ws.send(JSON.stringify({
        t: 'hello', v: 1, ts: Date.now(),
        token: store.get('token') || undefined, name: store.get('name') || undefined, color: store.get('color') || undefined,
      }));
    };
    ws.onmessage = (e) => { try { onMessage(JSON.parse(e.data)); } catch (err) { console.error(err); } };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ready = false;
      // Roll back optimistic claims; the next welcome carries the truth.
      for (const p of pending.values()) S.cooldownUntil = Math.min(S.cooldownUntil, p.prevCooldown);
      pending.clear(); dirty = true;
      setStatus('offline', 'Reconnecting…');
      const delay = Math.min(8000, 500 * 2 ** this.retry++) * (0.6 + Math.random() * 0.4);
      this.timer = setTimeout(() => this.connect(), delay);
    };
  },
  send(obj) { if (this.ready && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj)); },
};

function onMessage(m) {
  switch (m.t) {
    case 'welcome': return onWelcome(m);
    case 'ack': {
      pending.delete(m.i);
      S.cooldownUntil = m.cd;
      const res = applyTile({ i: m.i, o: m.o, lock: m.lock, r: m.r });
      if (res) log(m.p ? `<span class="c"></span><b>You</b> took (${coord(m.i)}) from <b>${esc(nameOf(m.p))}</b>` : `<span class="c"></span><b>You</b> claimed (${coord(m.i)})`, false, S.me.id);
      return;
    }
    case 'nack': {
      const p = pending.get(m.i);
      pending.delete(m.i);
      if (p) S.cooldownUntil = p.prevCooldown;
      if (m.tile) applyTile(m.tile);
      if (m.reason === 'cooldown' && m.retryAt) { S.cooldownUntil = m.retryAt; flashCooldown(); }
      shake(m.i);
      const msgs = { own: 'That tile is already yours', locked: 'That tile is shielded right now', cooldown: 'Still recharging…' };
      toast(msgs[m.reason] || "Couldn't claim that tile", 'error');
      return;
    }
    case 'tiles': {
      // Only narrate the tail of a big batch; the board itself shows everything.
      const events = [];
      for (const u of m.u) {
        const res = applyTile(u);
        if (res && u.o !== S.me.id) events.push([u, res.prev]);
      }
      for (const [u, prev] of events.slice(-4)) {
        const hit = prev === S.me.id;
        const who = `<b>${esc(nameOf(u.o))}</b>`;
        const what = hit ? `took your tile (${coord(u.i)})` : prev ? `took (${coord(u.i)}) from <b>${esc(nameOf(prev))}</b>` : `claimed (${coord(u.i)})`;
        log(`<span class="c"></span>${who} ${what}`, hit, u.o);
      }
      return;
    }
    case 'user': {
      S.users.set(m.u.id, m.u);
      if (S.me && m.u.id === S.me.id) { S.me = { ...S.me, ...m.u }; renderProfile(); }
      dirty = lbDirty = true;
      return;
    }
    case 'online': S.online = m.n; $('online-count').textContent = m.n; return;
  }
}

function onWelcome(m) {
  const first = !S.cfg;
  const { w, h } = m.cfg;
  S.cfg = m.cfg; S.w = w; S.h = h;
  S.owner = Int32Array.from(m.owners);
  S.lock = new Float64Array(w * h);
  for (const [i, until] of m.locks) { S.lock[i] = until; S.maxLock = Math.max(S.maxLock, until); }
  S.rev = new Uint32Array(w * h).fill(m.seq);
  S.users = new Map(m.users.map((u) => [u.id, u]));
  S.users.set(m.you.id, { id: m.you.id, name: m.you.name, color: m.you.color });
  S.counts = new Map();
  for (const o of S.owner) if (o) bump(S.counts, o, 1);
  S.me = m.you;
  S.cooldownUntil = m.cooldownUntil;
  S.online = m.online; $('online-count').textContent = m.online;
  // Estimate server clock offset assuming symmetric latency.
  const rtt = Date.now() - m.echo;
  S.clockOffset = m.now - (m.echo + rtt / 2);

  store.set('token', m.you.token); store.set('name', m.you.name); store.set('color', m.you.color);
  pending.clear(); anims.clear();
  net.ready = true; net.retry = 0;
  setStatus('live', 'Live');
  if (first) { buildColors(); resize(); fit(); }
  renderProfile();
  dirty = lbDirty = true;
}

/* ----------------------------------------------------------------- render */
function rrect(x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect && r > 0.5) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
}

function drawTile(i, t, now, detailed) {
  const c = i % S.w, r = (i / S.w) | 0;
  const o = S.owner[i], a = anims.get(i);
  const s = T - GAP;
  let cx = c * T + T / 2, cy = r * T + T / 2, scale = 1, flash = 0, ring = 0;

  if (a) {
    const p = Math.min(1, (t - a.start) / (a.kind === 'shake' ? 380 : 500));
    if (a.kind === 'pop') { scale = 1 + 0.28 * Math.sin(Math.PI * Math.min(1, p * 1.25)) * (1 - p * 0.4); ring = p; }
    else { cx += Math.sin(p * Math.PI * 7) * 3 * (1 - p); flash = (1 - p) * 0.4; }
    if (p >= 1) anims.delete(i);
  }

  const isPending = pending.has(i);
  let fill = isPending ? colorOf(S.me.id) : o ? colorOf(o) : (hover === i ? theme.tileHover : theme.tile);
  const size = s * scale, x = cx - size / 2, y = cy - size / 2, rad = detailed ? 7 * scale : 0;

  ctx.globalAlpha = isPending ? 0.55 + 0.25 * Math.sin(t / 110) : 1;
  ctx.fillStyle = fill;
  rrect(x, y, size, size, rad); ctx.fill();
  ctx.globalAlpha = 1;

  if (o && detailed) { // soft top highlight gives owned tiles some depth
    const g = ctx.createLinearGradient(0, y, 0, y + size);
    g.addColorStop(0, 'rgba(255,255,255,.22)'); g.addColorStop(0.55, 'rgba(255,255,255,0)'); g.addColorStop(1, 'rgba(0,0,0,.14)');
    ctx.fillStyle = g; rrect(x, y, size, size, rad); ctx.fill();
  }
  if (o && o === S.me.id && detailed) {
    ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = 2;
    rrect(x + 3, y + 3, size - 6, size - 6, Math.max(0, rad - 3)); ctx.stroke();
  }
  if (flash) { ctx.fillStyle = `rgba(239,68,68,${flash})`; rrect(x, y, size, size, rad); ctx.fill(); }
  if (hover === i) {
    ctx.strokeStyle = theme.accent; ctx.lineWidth = 2.5;
    rrect(x - 1, y - 1, size + 2, size + 2, rad + 1); ctx.stroke();
  }
  if (ring > 0 && ring < 1) { // ripple
    ctx.strokeStyle = fill; ctx.globalAlpha = 0.6 * (1 - ring); ctx.lineWidth = 3 * (1 - ring) + 1;
    rrect(cx - s * (0.5 + 0.7 * ease(ring)), cy - s * (0.5 + 0.7 * ease(ring)), s * (1 + 1.4 * ease(ring)), s * (1 + 1.4 * ease(ring)), 10);
    ctx.stroke(); ctx.globalAlpha = 1;
  }
  if (o && detailed && S.lock[i] > now) { // shield countdown ring
    const frac = Math.min(1, (S.lock[i] - now) / S.cfg.lockMs);
    ctx.lineCap = 'round'; ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255,255,255,.28)';
    ctx.beginPath(); ctx.arc(cx, cy, s * 0.2, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,.95)';
    ctx.beginPath(); ctx.arc(cx, cy, s * 0.2, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac); ctx.stroke();
  }
}

function draw(t) {
  const now = serverNow();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, ch);
  if (!S.w) return;
  ctx.translate(view.x, view.y); ctx.scale(view.k, view.k);

  // Board backing
  const pad = 10;
  ctx.shadowColor = 'rgba(0,0,0,.28)'; ctx.shadowBlur = 24 * view.k; ctx.shadowOffsetY = 8 * view.k;
  ctx.fillStyle = theme.panel;
  rrect(-pad, -pad, S.w * T + pad * 2, S.h * T + pad * 2, 14); ctx.fill();
  ctx.shadowColor = 'transparent';

  const c0 = Math.max(0, Math.floor(-view.x / view.k / T)), c1 = Math.min(S.w - 1, Math.floor((cw - view.x) / view.k / T));
  const r0 = Math.max(0, Math.floor(-view.y / view.k / T)), r1 = Math.min(S.h - 1, Math.floor((ch - view.y) / view.k / T));
  const detailed = view.k > 0.45;
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) { const i = r * S.w + c; if (!anims.has(i)) drawTile(i, t, now, detailed); }
  for (const i of anims.keys()) { const c = i % S.w, r = (i / S.w) | 0; if (c >= c0 && c <= c1 && r >= r0 && r <= r1) drawTile(i, t, now, detailed); }
}

function frame(t) {
  requestAnimationFrame(frame);
  const now = serverNow();
  const animating = anims.size || pending.size || now < S.maxLock + 50 || now < S.cooldownUntil + 80;
  if (S.cfg) { updateCooldown(now); updateTooltip(now); }
  if (dirty || animating) { dirty = false; draw(t); }
}

/* ------------------------------------------------------------------ input */
const pointers = new Map();
let drag = null, pinch = null;

function localXY(e) { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
function setHover(i) { if (i !== hover) { hover = i; dirty = true; } }

canvas.addEventListener('pointerdown', (e) => {
  canvas.classList.remove('kbd');
  canvas.focus({ preventScroll: true });
  canvas.setPointerCapture(e.pointerId);
  const p = localXY(e);
  pointers.set(e.pointerId, p);
  if (pointers.size === 1) drag = { x: p.x, y: p.y, vx: view.x, vy: view.y, moved: false };
  else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), k: view.k };
    drag = null;
  }
});
canvas.addEventListener('pointermove', (e) => {
  const p = localXY(e);
  pointer = { x: p.x, y: p.y, inside: true };
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);
  if (pinch && pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    zoomAt(mid.x, mid.y, (pinch.k * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d) / view.k);
    return;
  }
  if (drag && pointers.has(e.pointerId)) {
    const dx = p.x - drag.x, dy = p.y - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) > 5) { drag.moved = true; canvas.classList.add('dragging'); setHover(-1); }
    if (drag.moved) { view.x = drag.vx + dx; view.y = drag.vy + dy; userMoved = true; clampView(); dirty = true; }
    return;
  }
  if (e.pointerType === 'mouse') setHover(tileAt(p.x, p.y));
});
function endPointer(e, canClaim) {
  const p = localXY(e);
  const wasTap = drag && !drag.moved && pointers.size === 1;
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
  if (pointers.size === 0) { canvas.classList.remove('dragging'); }
  if (wasTap && canClaim) { setHover(tileAt(p.x, p.y)); tryClaim(tileAt(p.x, p.y)); }
  if (pointers.size === 0) drag = null;
  if (e.pointerType !== 'mouse') setHover(-1);
}
canvas.addEventListener('pointerup', (e) => endPointer(e, true));
canvas.addEventListener('pointercancel', (e) => endPointer(e, false));
canvas.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && !drag) { pointer.inside = false; setHover(-1); } });
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const dy = e.deltaY * (e.deltaMode === 1 ? 16 : 1);
  const p = localXY(e);
  zoomAt(p.x, p.y, Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0016)));
}, { passive: false });

canvas.addEventListener('keydown', (e) => {
  canvas.classList.add('kbd');
  const move = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
  if (move) {
    e.preventDefault();
    const cur = hover < 0 ? Math.floor(S.h / 2) * S.w + Math.floor(S.w / 2) : hover;
    const c = Math.min(S.w - 1, Math.max(0, cur % S.w + move[0])), r = Math.min(S.h - 1, Math.max(0, Math.floor(cur / S.w) + move[1]));
    setHover(r * S.w + c);
    pointer = { x: view.x + (c + 0.5) * T * view.k, y: view.y + (r + 0.5) * T * view.k, inside: true };
  } else if ((e.key === 'Enter' || e.key === ' ') && hover >= 0) { e.preventDefault(); tryClaim(hover); }
  else if (e.key === '0') { userMoved = false; fit(); }
  else if (e.key === '+' || e.key === '=') zoomAt(cw / 2, ch / 2, 1.25);
  else if (e.key === '-') zoomAt(cw / 2, ch / 2, 0.8);
});

$('zoom-in').onclick = () => zoomAt(cw / 2, ch / 2, 1.3);
$('zoom-out').onclick = () => zoomAt(cw / 2, ch / 2, 1 / 1.3);
$('zoom-fit').onclick = () => { userMoved = false; fit(); };

/* --------------------------------------------------------------------- ui */
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

let toastTimer = null;
function toast(msg, kind = 'info') {
  const el = $('toast');
  el.textContent = msg; el.dataset.kind = kind; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
}

function setStatus(state, text) { $('status').dataset.state = state; $('status-text').textContent = text; }

function log(html, hit, userId) {
  const feed = $('feed');
  const li = document.createElement('li');
  li.innerHTML = html; // all dynamic parts are escaped by esc(); colours come from a fixed server palette
  // Colours are applied via CSSOM (CSP forbids inline style attributes).
  for (const c of li.querySelectorAll('.c')) c.style.background = colorOf(userId);
  if (hit) li.className = 'hit';
  feed.prepend(li);
  while (feed.children.length > 7) feed.lastChild.remove();
}

function buildColors() {
  const box = $('colors');
  box.replaceChildren();
  for (const c of S.cfg.palette) {
    const b = document.createElement('button');
    b.type = 'button'; b.setAttribute('role', 'radio'); b.style.background = c; b.dataset.color = c; b.title = c; b.setAttribute('aria-label', `Colour ${c}`);
    b.onclick = () => { net.send({ t: 'profile', color: c }); store.set('color', c); S.users.set(S.me.id, { ...S.users.get(S.me.id), color: c }); S.me.color = c; renderProfile(); dirty = lbDirty = true; };
    box.append(b);
  }
}
function renderProfile() {
  if (!S.me) return;
  $('me-swatch').style.background = S.me.color;
  const input = $('name-input');
  if (document.activeElement !== input) input.value = S.me.name;
  for (const b of $('colors').children) b.setAttribute('aria-checked', String(b.dataset.color === S.me.color));
}
const nameInput = $('name-input');
nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') nameInput.blur(); if (e.key === 'Escape') { nameInput.value = S.me.name; nameInput.blur(); } });
nameInput.addEventListener('change', () => {
  const name = nameInput.value.trim();
  if (!name) { nameInput.value = S.me.name; return; }
  net.send({ t: 'profile', name }); store.set('name', name);
  S.me.name = name; S.users.set(S.me.id, { ...S.users.get(S.me.id), name }); lbDirty = true;
});

function updateCooldown(now) {
  const rem = Math.max(0, S.cooldownUntil - now), total = S.cfg.cooldownMs;
  const frac = total ? 1 - Math.min(1, rem / total) : 1;
  $('cooldown-fill').style.transform = `scaleX(${frac})`;
  $('cooldown').classList.toggle('busy', rem > 0);
  const txt = rem > 0 ? `Recharging… ${(rem / 1000).toFixed(1)}s` : 'Ready to claim';
  if ($('cooldown-text').textContent !== txt) $('cooldown-text').textContent = txt;
}

/* tooltip */
const tip = $('tooltip');
tip.innerHTML = '<div class="t-row"><span class="t-sw"></span><b class="t-name"></b></div><div class="t-sub"></div>';
const tipSw = tip.querySelector('.t-sw'), tipName = tip.querySelector('.t-name'), tipSub = tip.querySelector('.t-sub');
function updateTooltip(now) {
  if (hover < 0 || !pointer.inside || drag?.moved) { tip.hidden = true; canvas.classList.remove('can-claim'); return; }
  const o = S.owner[hover], locked = o && S.lock[hover] > now;
  tipSw.style.background = o ? colorOf(o) : theme.tile;
  tipName.textContent = o ? (o === S.me.id ? `${nameOf(o)} (you)` : nameOf(o)) : 'Unclaimed';
  tipSub.textContent = `(${coord(hover)}) · ` + (o === S.me?.id ? 'yours' : locked ? `shielded ${((S.lock[hover] - now) / 1000).toFixed(1)}s` : o ? 'up for grabs' : 'click to claim');
  canvas.classList.toggle('can-claim', o !== S.me?.id && !locked);
  tip.hidden = false;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  tip.style.left = `${Math.max(8, Math.min(cw - w - 8, pointer.x + 16))}px`;
  tip.style.top = `${Math.max(8, Math.min(ch - h - 8, pointer.y + 16))}px`;
}

/* leaderboard: derived from local tile counts, which already mirror the server */
const lbRows = new Map();
function renderBoard() {
  if (!S.me) return;
  const total = S.w * S.h;
  const ranked = [...S.counts].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const claimed = ranked.reduce((s, [, n]) => s + n, 0);
  $('claimed-count').textContent = `${claimed} / ${total}`;
  $('claimed-bar').style.width = `${(claimed / total) * 100}%`;
  $('you-count').textContent = `${S.counts.get(S.me.id) || 0} tiles`;

  const shown = ranked.slice(0, 6).map(([id, n], idx) => ({ id, n, rank: idx + 1 }));
  const myIdx = ranked.findIndex(([id]) => id === S.me.id);
  if (myIdx >= 6) shown.push({ id: S.me.id, n: ranked[myIdx][1], rank: myIdx + 1 });

  const list = $('leaderboard');
  if (!shown.length) { list.innerHTML = '<li class="empty">No territory claimed yet. Be the first!</li>'; lbRows.clear(); return; }
  list.querySelector('.empty')?.remove();
  const keep = new Set();
  shown.forEach(({ id, n, rank }) => {
    keep.add(id);
    let row = lbRows.get(id);
    if (!row) {
      const li = document.createElement('li');
      li.innerHTML = '<span class="rank"></span><span class="sw"></span><span class="nm"></span><span class="ct"></span>';
      row = { li, rank: li.children[0], sw: li.children[1], nm: li.children[2], ct: li.children[3] };
      lbRows.set(id, row);
    }
    row.li.classList.toggle('me', id === S.me.id);
    row.rank.textContent = rank; row.sw.style.background = colorOf(id);
    row.nm.textContent = id === S.me.id ? `${nameOf(id)} (you)` : nameOf(id);
    row.ct.textContent = n;
    list.append(row.li); // re-append in order; reuses the element so nothing flickers
  });
  for (const [id, row] of lbRows) if (!keep.has(id)) { row.li.remove(); lbRows.delete(id); }
}
setInterval(() => { if (lbDirty) { lbDirty = false; renderBoard(); } }, 250);

setTimeout(() => $('hint').classList.add('hide'), 12000);

/* ------------------------------------------------------------------ start */
readTheme();
resize();
requestAnimationFrame(frame);
net.connect();
