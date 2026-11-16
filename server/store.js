'use strict';
const fs = require('node:fs');
const path = require('node:path');

/**
 * Tiny durable store: debounced, atomic JSON snapshots.
 *
 * Why not a database? The whole world is ~1k tiles + a few users, it lives in
 * memory for speed, and the server is the single writer. A snapshot every
 * ~1.5s of activity gives crash-safety with zero ops burden. Writes go to a
 * temp file then rename(), so a crash mid-write never corrupts the last good
 * snapshot. (To scale out you'd swap this for Redis/Postgres - see README.)
 */
class Store {
  constructor(file, getState, { debounceMs = 1500 } = {}) {
    this.file = file;
    this.getState = getState;
    this.debounceMs = debounceMs;
    this.timer = null;
    this.writing = false;
    this.again = false;
  }

  load() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return null;
    }
  }

  markDirty() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this._write();
    }, this.debounceMs);
    this.timer.unref?.();
  }

  async _write() {
    if (this.writing) { this.again = true; return; }
    this.writing = true;
    try {
      const tmp = `${this.file}.tmp`;
      await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
      await fs.promises.writeFile(tmp, JSON.stringify(this.getState()));
      await fs.promises.rename(tmp, this.file);
    } catch (err) {
      console.error('[store] write failed:', err.message);
    } finally {
      this.writing = false;
      if (this.again) { this.again = false; this.markDirty(); }
    }
  }

  /** Synchronous flush for graceful shutdown. */
  flushSync() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.getState()));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('[store] flush failed:', err.message);
    }
  }
}

module.exports = { Store };
