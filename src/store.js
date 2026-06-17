import fs from 'node:fs/promises';
import path from 'node:path';

const FILE_NAME = 'bots.json';
const SAVE_DEBOUNCE_MS = 200;

export class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, FILE_NAME);
    this.bots = new Map();
    this._saveTimer = null;
    this._savePromise = null;
  }

  async load() {
    await fs.mkdir(this.dataDir, { recursive: true });
    // clean up any stale temp file left by a prior crashed write
    try { await fs.unlink(`${this.filePath}.tmp`); }
    catch (err) { if (err.code !== 'ENOENT') throw err; }

    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.bots)) {
        for (const bot of parsed.bots) {
          if (bot && bot.id) this.bots.set(bot.id, bot);
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  list() {
    return [...this.bots.values()];
  }

  get(id) {
    return this.bots.get(id);
  }

  upsert(bot) {
    this.bots.set(bot.id, bot);
    this._scheduleSave();
  }

  remove(id) {
    if (this.bots.delete(id)) this._scheduleSave();
  }

  _scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._savePromise = this._save().catch((err) => {
        console.error('[store] save failed:', err);
      });
    }, SAVE_DEBOUNCE_MS);
  }

  async flush() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
      await this._save();
      return;
    }
    if (this._savePromise) await this._savePromise;
  }

  async _save() {
    const payload = JSON.stringify({ bots: this.list() }, null, 2);
    const tmp = `${this.filePath}.tmp`;
    await fs.writeFile(tmp, payload, 'utf8');
    await fs.rename(tmp, this.filePath);
  }
}
