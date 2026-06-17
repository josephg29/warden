import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';

class SettingsStore extends EventEmitter {
  constructor(filePath) {
    super();
    this.filePath = filePath;
    this._data    = {};
  }

  async load() {
    try {
      const raw  = await fs.readFile(this.filePath, 'utf8');
      this._data = JSON.parse(raw);
    } catch { /* file doesn't exist yet — start empty */ }

    // env var seeds the key if nothing is stored yet
    if (!this._data.cerebrasApiKey && process.env.CEREBRAS_API_KEY) {
      this._data.cerebrasApiKey = process.env.CEREBRAS_API_KEY;
    }
    // legacy DeepSeek seeding (kept for A/B fallback):
    // if (!this._data.deepseekApiKey && process.env.DEEPSEEK_API_KEY) {
    //   this._data.deepseekApiKey = process.env.DEEPSEEK_API_KEY;
    // }
  }

  get(key) {
    return this._data[key] ?? null;
  }

  async set(key, value) {
    if (value === null || value === undefined || value === '') {
      delete this._data[key];
    } else {
      this._data[key] = value;
    }
    await this._save();
    this.emit('change');
  }

  toPublicJSON() {
    return {
      hasCerebrasKey: !!this._data.cerebrasApiKey,
    };
  }

  async _save() {
    const tmp = `${this.filePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this._data, null, 2), 'utf8');
    await fs.rename(tmp, this.filePath);
  }
}

export const settingsStore = new SettingsStore(
  path.resolve(import.meta.dirname, '..', 'data', 'settings.json')
);
