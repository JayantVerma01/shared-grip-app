'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server/app');
const { TestClient, sleep } = require('./helpers');

async function boot(game = {}, extra = {}) {
  const app = createApp({ port: 0, host: '127.0.0.1', dataFile: null, batchMs: 10, game: { width: 10, height: 10, ...game }, ...extra });
  const port = await app.listen();
  return { app, port };
}

test('a claim by one client is pushed to every other client in real time', async () => {
  const { app, port } = await boot();
  const [a, b, c] = await Promise.all([1, 2, 3].map((n) => new TestClient(port, { name: `P${n}` }).open()));
  const seen = Promise.all([b, c].map((cl) => cl.waitFor((m) => m.t === 'tiles' && m.u.some((u) => u.i === 5))));
  a.claim(5);
  await a.waitFor((m) => m.t === 'ack');
  await seen;
  assert.equal(b.owner[5], a.you.id);
  assert.equal(c.owner[5], a.you.id);
  [a, b, c].forEach((x) => x.close());
  await app.close();
});

test('simultaneous claims on one tile: one ack, everyone else nack, and all clients agree', async () => {
  const { app, port } = await boot({ cooldownMs: 0, lockMs: 10_000 });
  const clients = await Promise.all(Array.from({ length: 12 }, (_, n) => new TestClient(port, { name: `P${n}` }).open()));
  clients.forEach((c) => c.claim(42));
  await sleep(300);
  const winners = clients.filter((c) => c.acks === 1);
  assert.equal(winners.length, 1);
  assert.equal(clients.filter((c) => c.nacks.locked === 1).length, 11);
  for (const c of clients) assert.equal(c.owner[42], winners[0].you.id);
  clients.forEach((c) => c.close());
  await app.close();
});

test('server enforces cooldown and shields even if the client ignores them', async () => {
  const { app, port } = await boot({ cooldownMs: 400, lockMs: 400 });
  const a = await new TestClient(port).open();
  a.claim(1, 1);
  a.claim(2, 2);
  await sleep(100);
  assert.equal(a.acks, 1);
  assert.equal(a.nacks.cooldown, 1);
  await sleep(400);
  a.claim(3, 3);
  await sleep(100);
  assert.equal(a.acks, 2);
  a.close();
  await app.close();
});

test('returning with the token restores identity; state survives reconnect', async () => {
  const { app, port } = await boot({ cooldownMs: 0 });
  const a = await new TestClient(port, { name: 'Ann' }).open();
  a.claim(7);
  await a.waitFor((m) => m.t === 'ack');
  const { token, id } = a.you;
  a.close();
  await sleep(50);
  const again = await new TestClient(port, { token }).open();
  assert.equal(again.you.id, id);
  assert.equal(again.owner[7], id);
  again.close();
  await app.close();
});

test('malformed and abusive input never crashes the server', async () => {
  const { app, port } = await boot({}, { rate: { burst: 5, perSec: 1 } });
  const c = await new TestClient(port).open();
  for (const junk of ['not json', '[]', 'null', '{"t":"claim","i":"x"}', '{"t":"claim","i":1e9}', '{"t":"profile","name":{"a":1}}', '{"t":"zzz"}']) c.ws.send(junk);
  for (let n = 0; n < 50; n++) c.claim(n % 100, n); // blows through the rate limit
  await sleep(150);
  const fresh = await new TestClient(port).open(); // server still serving
  assert.equal(fresh.owner.length, 100);
  c.close(); fresh.close();
  await app.close();
});

test('load: 60 clients hammering for 1.5s all converge to the exact server state', async () => {
  const { app, port } = await boot({ width: 20, height: 15, cooldownMs: 0, lockMs: 0 }, { rate: { burst: 1e6, perSec: 1e6 } });
  const clients = await Promise.all(Array.from({ length: 60 }, (_, n) => new TestClient(port, { name: `Bot${n}` }).open()));
  const end = Date.now() + 1500;
  await Promise.all(clients.map(async (c) => {
    while (Date.now() < end) { c.claim(Math.floor(Math.random() * 300)); await sleep(5 + Math.random() * 10); }
  }));
  await sleep(400); // let the last batches drain
  const truth = [...app.game.owner];
  for (const c of clients) assert.deepEqual([...c.owner], truth, `client ${c.you.name} diverged`);
  const recount = new Map();
  for (const o of truth) if (o) recount.set(o, (recount.get(o) || 0) + 1);
  for (const [id, n] of recount) assert.equal(app.game.counts.get(id), n);
  const totalAcks = clients.reduce((s, c) => s + c.acks, 0);
  assert.equal(totalAcks, app.game.seq, 'every accepted claim produced exactly one revision');
  clients.forEach((c) => c.close());
  await app.close();
});
