'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Game, sanitizeName, PALETTE } = require('../server/game');

function make(opts = {}) {
  const clock = { t: 1_000_000 };
  const game = new Game({ width: 5, height: 4, cooldownMs: 1000, lockMs: 3000, now: () => clock.t, ...opts });
  return { game, clock };
}

test('claiming an unclaimed tile assigns it and bumps revision', () => {
  const { game } = make();
  const a = game.join({ name: 'Ann' });
  const res = game.claim(a.id, 7);
  assert.equal(res.ok, true);
  assert.equal(game.owner[7], a.id);
  assert.equal(res.update.p, 0);
  assert.equal(res.update.r, 1);
  assert.equal(game.counts.get(a.id), 1);
});

test('two users racing for the same tile: exactly one wins', () => {
  const { game } = make();
  const a = game.join({}), b = game.join({});
  const r1 = game.claim(a.id, 3);
  const r2 = game.claim(b.id, 3);
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, 'locked');
  assert.equal(game.owner[3], a.id);
  assert.equal(r2.tile.o, a.id, 'rejection carries the authoritative tile so the client can reconcile');
});

test('lock expires and the tile can then be stolen', () => {
  const { game, clock } = make({ cooldownMs: 0 });
  const a = game.join({}), b = game.join({});
  game.claim(a.id, 0);
  clock.t += 2999;
  assert.equal(game.claim(b.id, 0).reason, 'locked');
  clock.t += 2;
  const res = game.claim(b.id, 0);
  assert.equal(res.ok, true);
  assert.equal(res.update.p, a.id);
  assert.equal(game.counts.get(a.id), 0);
  assert.equal(game.counts.get(b.id), 1);
});

test('cooldown applies per user, not globally', () => {
  const { game, clock } = make();
  const a = game.join({}), b = game.join({});
  assert.equal(game.claim(a.id, 0).ok, true);
  const again = game.claim(a.id, 1);
  assert.equal(again.reason, 'cooldown');
  assert.ok(again.retryAt > clock.t);
  assert.equal(game.claim(b.id, 1).ok, true, 'other users are unaffected');
  clock.t += 1000;
  assert.equal(game.claim(a.id, 2).ok, true);
});

test('a rejected claim does not consume the cooldown', () => {
  const { game } = make();
  const a = game.join({}), b = game.join({});
  game.claim(a.id, 0);
  assert.equal(game.claim(b.id, 0).reason, 'locked');
  assert.equal(game.claim(b.id, 1).ok, true);
});

test('cannot claim own tile; bad input is rejected', () => {
  const { game, clock } = make({ cooldownMs: 0 });
  const a = game.join({});
  game.claim(a.id, 0);
  clock.t += 5000;
  assert.equal(game.claim(a.id, 0).reason, 'own');
  for (const bad of [-1, 20, 1.5, NaN, '3', null, undefined]) assert.equal(game.claim(a.id, bad).reason, 'bad_tile');
  assert.equal(game.claim(999, 1).reason, 'unknown_user');
});

test('token identifies returning users; unknown tokens create new users', () => {
  const { game } = make();
  const a = game.join({ name: 'Ann' });
  assert.equal(game.join({ token: a.token }).id, a.id);
  assert.notEqual(game.join({ token: 'nope' }).id, a.id);
});

test('profile input is sanitised', () => {
  assert.equal(sanitizeName('  Hello‮   World ​ '), 'Hello World');
  assert.equal(sanitizeName('x'.repeat(50)).length, 16);
  assert.equal(sanitizeName('   '), null);
  assert.equal(sanitizeName(42), null);
  const { game } = make();
  const a = game.join({ color: '#123456' });
  assert.ok(PALETTE.includes(a.color), 'arbitrary colours are replaced by a palette colour');
  game.setProfile(a.id, { name: 'Zed', color: PALETTE[3] });
  assert.equal(a.name, 'Zed');
  assert.equal(a.color, PALETTE[3]);
});

test('new users get distinct colours until the palette is exhausted', () => {
  const { game } = make();
  const colors = new Set(Array.from({ length: PALETTE.length }, () => game.join({}).color));
  assert.equal(colors.size, PALETTE.length);
});

test('serialize -> fromState round-trips ownership, identities and live locks', () => {
  const { game, clock } = make();
  const a = game.join({ name: 'Ann' }), b = game.join({ name: 'Bob' });
  game.claim(a.id, 2); game.claim(b.id, 9);
  const copy = Game.fromState(JSON.parse(JSON.stringify(game.serialize())), { width: 5, height: 4, now: () => clock.t });
  assert.deepEqual([...copy.owner], [...game.owner]);
  assert.equal(copy.join({ token: a.token }).name, 'Ann');
  assert.equal(copy.counts.get(b.id), 1);
  assert.ok(copy.lockUntil[2] > clock.t, 'locks survive restart');
  const c = copy.join({});
  assert.ok(![a.id, b.id].includes(c.id), 'ids never collide after restore');
});

test('fromState rejects mismatched or corrupt data', () => {
  const { game } = make();
  assert.equal(Game.fromState(null), null);
  assert.equal(Game.fromState({ ...game.serialize(), width: 99 }, { width: 5, height: 4 }), null);
  assert.equal(Game.fromState({ v: 1, width: 5, height: 4, owners: [1] }, { width: 5, height: 4 }), null);
});

test('stress: counts always equal a recount of the board', () => {
  const { game, clock } = make({ width: 10, height: 10, cooldownMs: 0, lockMs: 0 });
  const users = Array.from({ length: 8 }, () => game.join({}));
  for (let n = 0; n < 5000; n++) {
    clock.t += 1;
    game.claim(users[Math.floor(Math.random() * users.length)].id, Math.floor(Math.random() * 100));
  }
  const recount = new Map();
  for (const o of game.owner) if (o) recount.set(o, (recount.get(o) || 0) + 1);
  for (const u of users) assert.equal(game.counts.get(u.id) || 0, recount.get(u.id) || 0);
});
