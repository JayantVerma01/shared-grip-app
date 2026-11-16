'use strict';
const crypto = require('node:crypto');

/**
 * Game engine: the single source of truth for tiles, users and rules.
 *
 * Deliberately free of any I/O (no sockets, no disk, no timers) so that it is
 * trivially unit-testable with an injected clock. Node runs JS on one thread,
 * and `claim()` is fully synchronous, so every claim is atomic: two users
 * racing for the same tile are simply serialised, first one in wins, second
 * gets a `locked` rejection. No locks or transactions are needed.
 *
 * Rules
 *  - Per-user cooldown: after a successful claim you must wait `cooldownMs`.
 *  - Tile lock: a freshly captured tile is shielded for `lockMs`, so it can't
 *    be instantly stolen back. Unlocked tiles can be stolen by anyone.
 *  - You can't claim a tile you already own.
 */

const PALETTE = [
  '#ef4444', '#f97316', '#f59e0b', '#84cc16', '#22c55e', '#14b8a6',
  '#06b6d4', '#3b82f6', '#6366f1', '#8b5cf6', '#d946ef', '#ec4899',
];

const ADJECTIVES = ['Swift', 'Brave', 'Lucky', 'Quiet', 'Sneaky', 'Jolly', 'Bold', 'Clever', 'Mighty', 'Nimble', 'Witty', 'Fuzzy'];
const ANIMALS = ['Otter', 'Falcon', 'Panda', 'Fox', 'Lynx', 'Heron', 'Gecko', 'Badger', 'Koala', 'Raven', 'Moose', 'Newt'];

const NAME_MAX = 16;
const STALE_USER_MS = 7 * 24 * 3600 * 1000;

// Control chars, zero-width and bidi-override characters (spoofing vectors).
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g;

function sanitizeName(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX).trim();
  return s.length ? s : null;
}

function sanitizeColor(raw) {
  return typeof raw === 'string' && PALETTE.includes(raw.toLowerCase()) ? raw.toLowerCase() : null;
}

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

class Game {
  constructor(opts = {}) {
    this.width = opts.width ?? 40;
    this.height = opts.height ?? 30;
    this.cooldownMs = opts.cooldownMs ?? 1500;
    this.lockMs = opts.lockMs ?? 5000;
    this.now = opts.now ?? Date.now; // injectable clock for tests

    const n = this.width * this.height;
    this.size = n;
    this.owner = new Int32Array(n);      // 0 = unclaimed, else user id
    this.lockUntil = new Float64Array(n); // epoch ms; only meaningful while owned
    this.rev = new Uint32Array(n);        // seq at which each tile last changed

    this.seq = 0;                 // global, monotonically increasing change counter
    this.nextUserId = 1;
    this.users = new Map();       // id -> user
    this.tokens = new Map();      // secret token -> user
    this.counts = new Map();      // id -> tiles owned (maintained incrementally)
  }

  /* ---------------------------------------------------------------- users */

  /** Find the user for a token, or create a new one. Never trusts the client for identity beyond the secret token. */
  join({ token, name, color } = {}) {
    let user = typeof token === 'string' ? this.tokens.get(token) : undefined;
    if (!user) {
      user = {
        id: this.nextUserId++,
        token: crypto.randomBytes(16).toString('hex'),
        name: sanitizeName(name) || `${pick(ADJECTIVES)} ${pick(ANIMALS)}`,
        color: sanitizeColor(color) || this._leastUsedColor(),
        cooldownUntil: 0,
        lastSeen: this.now(),
      };
      this.users.set(user.id, user);
      this.tokens.set(user.token, user);
    }
    user.lastSeen = this.now();
    return user;
  }

  setProfile(userId, { name, color }) {
    const user = this.users.get(userId);
    if (!user) return null;
    const n = sanitizeName(name);
    const c = sanitizeColor(color);
    if (n) user.name = n;
    if (c) user.color = c;
    return user;
  }

  _leastUsedColor() {
    const used = new Map(PALETTE.map((c) => [c, 0]));
    for (const u of this.users.values()) used.set(u.color, (used.get(u.color) || 0) + 1);
    const min = Math.min(...used.values());
    return pick(PALETTE.filter((c) => used.get(c) === min));
  }

  publicUser(u) {
    return { id: u.id, name: u.name, color: u.color };
  }

  /* ---------------------------------------------------------------- tiles */

  tileState(i) {
    return { i, o: this.owner[i], lock: this.owner[i] ? this.lockUntil[i] : 0, r: this.rev[i] };
  }

  /**
   * Attempt to claim tile `i` for `userId`.
   * Returns { ok:true, update, cooldownUntil } or { ok:false, reason, retryAt?, tile }.
   */
  claim(userId, i) {
    const user = this.users.get(userId);
    if (!user) return { ok: false, reason: 'unknown_user' };
    if (!Number.isInteger(i) || i < 0 || i >= this.size) return { ok: false, reason: 'bad_tile' };

    const now = this.now();
    const fail = (reason, retryAt) => ({ ok: false, reason, retryAt, tile: this.tileState(i) });

    if (this.owner[i] === userId) return fail('own');
    if (now < user.cooldownUntil) return fail('cooldown', user.cooldownUntil);
    if (this.owner[i] !== 0 && now < this.lockUntil[i]) return fail('locked', this.lockUntil[i]);

    const prev = this.owner[i];
    if (prev) this.counts.set(prev, (this.counts.get(prev) || 1) - 1);
    this.counts.set(userId, (this.counts.get(userId) || 0) + 1);

    this.owner[i] = userId;
    this.lockUntil[i] = now + this.lockMs;
    this.rev[i] = ++this.seq;
    user.cooldownUntil = now + this.cooldownMs;
    user.lastSeen = now;

    return {
      ok: true,
      cooldownUntil: user.cooldownUntil,
      update: { i, o: userId, p: prev, lock: this.lockUntil[i], r: this.rev[i] },
    };
  }

  /* ------------------------------------------------------------- snapshot */

  /** Full state for a freshly connected client. `online` is a Set of user ids to always include. */
  snapshot(online = new Set()) {
    const now = this.now();
    const locks = [];
    for (let i = 0; i < this.size; i++) {
      if (this.owner[i] && this.lockUntil[i] > now) locks.push([i, this.lockUntil[i]]);
    }
    const users = [];
    for (const u of this.users.values()) {
      if ((this.counts.get(u.id) || 0) > 0 || online.has(u.id)) users.push(this.publicUser(u));
    }
    return { seq: this.seq, owners: Array.from(this.owner), locks, users };
  }

  claimedCount() {
    let n = 0;
    for (const c of this.counts.values()) n += c;
    return n;
  }

  /* ---------------------------------------------------------- persistence */

  serialize() {
    const now = this.now();
    const users = [];
    for (const u of this.users.values()) {
      const stale = (this.counts.get(u.id) || 0) === 0 && now - u.lastSeen > STALE_USER_MS;
      if (!stale) users.push({ id: u.id, token: u.token, name: u.name, color: u.color, lastSeen: u.lastSeen });
    }
    const locks = [];
    for (let i = 0; i < this.size; i++) if (this.owner[i] && this.lockUntil[i] > now) locks.push([i, this.lockUntil[i]]);
    return {
      v: 1, width: this.width, height: this.height, seq: this.seq,
      nextUserId: this.nextUserId, users, owners: Array.from(this.owner), locks,
    };
  }

  /** Rebuild a Game from serialize() output; returns null if the data is unusable (caller starts fresh). */
  static fromState(state, opts = {}) {
    try {
      const g = new Game(opts);
      if (!state || state.v !== 1 || state.width !== g.width || state.height !== g.height) return null;
      if (!Array.isArray(state.owners) || state.owners.length !== g.size) return null;
      for (const u of state.users) {
        const user = { id: u.id, token: u.token, name: u.name, color: u.color, cooldownUntil: 0, lastSeen: u.lastSeen || 0 };
        g.users.set(user.id, user);
        g.tokens.set(user.token, user);
      }
      state.owners.forEach((o, i) => {
        if (o && g.users.has(o)) {
          g.owner[i] = o;
          g.counts.set(o, (g.counts.get(o) || 0) + 1);
        }
      });
      for (const [i, until] of state.locks || []) if (g.owner[i]) g.lockUntil[i] = until;
      g.seq = state.seq || 0;
      g.rev.fill(g.seq); // all tiles are "as of" the restored seq
      g.nextUserId = Math.max(state.nextUserId || 1, ...[...g.users.keys()].map((k) => k + 1));
      return g;
    } catch {
      return null;
    }
  }
}

module.exports = { Game, PALETTE, sanitizeName, sanitizeColor, NAME_MAX };
