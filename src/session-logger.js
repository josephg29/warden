import fs from 'node:fs';
import path from 'node:path';

const LOG_DIR = path.resolve(import.meta.dirname, '..', 'data', 'logs');
const SESSION_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/;

class SessionLogger {
  constructor() {
    this._stream        = null;
    this._sessionId     = null;
    this._serverStartTs = null;
  }

  startSession() {
    if (this._stream) this.endSession();
    this._serverStartTs = Date.now();
    this._sessionId     = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dir = path.join(LOG_DIR, this._sessionId);
    fs.mkdirSync(dir, { recursive: true });
    this._stream = fs.createWriteStream(path.join(dir, 'events.jsonl'), { flags: 'a' });
    this._write({ type: 'session:start', sessionId: this._sessionId, serverStartTs: this._serverStartTs });
  }

  endSession() {
    if (!this._stream) return;
    this._write({ type: 'session:end', sessionId: this._sessionId });
    this._stream.end();
    this._stream        = null;
    this._serverStartTs = null;
    this._sessionId     = null;
  }

  isActive() {
    return this._stream !== null;
  }

  log(event) {
    if (!this._stream) return;
    // event.mcDay is authoritative when present (from bot.time.day),
    // otherwise estimate from server uptime (20 real min = 1 MC day)
    const mcDay = event.mcDay ?? (
      this._serverStartTs
        ? Math.floor((Date.now() - this._serverStartTs) / 1_200_000)
        : 0
    );
    this._write({ ...event, mcDay });
  }

  listSessions() {
    try {
      return fs.readdirSync(LOG_DIR, { withFileTypes: true })
        .filter(e => e.isDirectory() && SESSION_RE.test(e.name))
        .map(e => e.name)
        .sort()
        .reverse();
    } catch { return []; }
  }

  readSession(sessionId) {
    if (!SESSION_RE.test(sessionId)) return null;
    const file = path.join(LOG_DIR, sessionId, 'events.jsonl');
    try {
      const raw = fs.readFileSync(file, 'utf8');
      return raw.trim().split('\n').filter(Boolean).map(line => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean);
    } catch { return null; }
  }

  _write(event) {
    if (!this._stream) return;
    this._stream.write(JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n');
  }
}

export const sessionLogger = new SessionLogger();
