'use strict';
const path = require('node:path');
const { createApp } = require('./app');

const env = process.env;
const num = (v, d) => (v !== undefined && v !== '' && Number.isFinite(+v) ? +v : d);

const app = createApp({
  port: num(env.PORT, 3000),
  host: env.HOST || '0.0.0.0',
  dataFile: env.DATA_FILE || path.join(__dirname, '..', 'data', 'state.json'),
  game: {
    width: num(env.GRID_W, 40),
    height: num(env.GRID_H, 30),
    cooldownMs: num(env.COOLDOWN_MS, 1500),
    lockMs: num(env.LOCK_MS, 5000),
  },
});

app.listen().then((port) => {
  console.log(`Tilewar running → http://localhost:${port}  (${app.game.size} tiles)`);
});

let closing = false;
const shutdown = () => {
  if (closing) return;
  closing = true;
  app.close().then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
