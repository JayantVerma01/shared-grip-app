'use strict';
const WebSocket = require('ws');

/**
 * Headless protocol client that applies updates with the exact same rule as the
 * browser client (apply only if r > tile revision). Used by the integration
 * test and the load script to prove clients converge to the server's state.
 */
class TestClient {
  constructor(port, { token, name } = {}) {
    this.port = port;
    this.token = token;
    this.name = name;
    this.inbox = [];
    this.waiters = [];
    this.acks = 0;
    this.nacks = {};
  }

  open() {
    return new Promise((resolve, reject) => {
      const ws = (this.ws = new WebSocket(`ws://127.0.0.1:${this.port}/ws`));
      ws.on('error', reject);
      ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', v: 1, ts: Date.now(), token: this.token, name: this.name })));
      ws.on('message', (d) => {
        const m = JSON.parse(d.toString());
        this._handle(m);
        if (m.t === 'welcome') resolve(this);
        const w = this.waiters.filter((x) => x.pred(m));
        this.waiters = this.waiters.filter((x) => !w.includes(x));
        w.forEach((x) => x.resolve(m));
      });
    });
  }

  _handle(m) {
    if (m.t === 'welcome') {
      this.you = m.you; this.cfg = m.cfg;
      this.owner = Int32Array.from(m.owners);
      this.rev = new Uint32Array(this.owner.length).fill(m.seq);
      this.lock = new Float64Array(this.owner.length);
      for (const [i, until] of m.locks) this.lock[i] = until;
    } else if (m.t === 'ack') {
      this.acks++;
      this._apply({ i: m.i, o: m.o, lock: m.lock, r: m.r });
    } else if (m.t === 'nack') {
      this.nacks[m.reason] = (this.nacks[m.reason] || 0) + 1;
      if (m.tile) this._apply(m.tile);
    } else if (m.t === 'tiles') {
      m.u.forEach((u) => this._apply(u));
    }
  }

  _apply(u) {
    if (!(u.r > this.rev[u.i])) return;
    this.rev[u.i] = u.r; this.owner[u.i] = u.o; this.lock[u.i] = u.o ? u.lock : 0;
  }

  send(obj) { this.ws.send(JSON.stringify(obj)); }
  claim(i, rid = 1) { this.send({ t: 'claim', i, rid }); }
  waitFor(pred, ms = 2000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('waitFor timeout')), ms);
      this.waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
    });
  }
  close() { this.ws.close(); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { TestClient, sleep };
