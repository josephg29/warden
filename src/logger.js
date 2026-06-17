// F9: persistent rotating console log. Patches console.{log,warn,error,info,debug}
// so all output is mirrored to data/logs/dev-server.YYYY-MM-DD.log AND still
// appears on stdout/stderr. Rotates at MAX_BYTES; old files are renamed
// `.0`, `.1`, … (oldest dropped at MAX_BACKUPS).
//
// Without this, our only debugging signal is whatever TTY launched the dev
// server — which doesn't survive a detached process or a sudden crash.
//
// BUG-002: caps tightened to 5 MB / 2 generations and a startup sweep prunes
// session-log subdirs older than PRUNE_DAYS_OLD so a single day can't fill
// the C: drive and silently wedge every brain.
//
// OVN-015: LOG_LEVEL env gates noisy frequency-events (debouncing, jump-loop
// detected, blocking) so dashboard.out doesn't drown a real ECONNABORTED in
// thousands of routine debounce lines. See `shouldLog()`.

import fs from 'node:fs';
import path from 'node:path';

// OVN-015: numeric level so comparisons are simple. Lower = more verbose.
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const ENV_LOG_LEVEL = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
const ACTIVE_LEVEL = LEVELS[ENV_LOG_LEVEL] ?? LEVELS.info;

export function shouldLog(level) {
  const num = LEVELS[String(level).toLowerCase()];
  if (num === undefined) return true; // unknown levels default to visible
  return num >= ACTIVE_LEVEL;
}

// Frequency-noise events route through here. When LOG_LEVEL=warn or higher,
// these vanish; the actual error paths (console.warn for real failures)
// stay loud. Use brainDebug for events that fire many times per minute on
// a stuck bot — debouncing, jump-loop detected, blocking, etc.
export function brainDebug(...args) {
  if (!shouldLog('debug')) return;
  console.log(...args);
}

const MAX_BYTES        = 5 * 1024 * 1024;  // BUG-002: was 10 MB; tightened
const MAX_BACKUPS      = 2;                // BUG-002: was 5; keep two generations
const PRUNE_DAYS_OLD   = 3;                // BUG-002: prune session-log subdirs older than this
const SESSION_DIR_RE   = /^\d{4}-\d{2}-\d{2}/; // matches '2026-05-04T...' or '2026-05-04'

let stream     = null;
let streamPath = null;
let streamSize = 0;

function todayStamp() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function ensureStream(logDir) {
  const target = path.join(logDir, `dev-server.${todayStamp()}.log`);
  if (stream && streamPath === target) return;
  // close prior stream (date rolled over)
  if (stream) { try { stream.end(); } catch { /* noop */ } }
  fs.mkdirSync(logDir, { recursive: true });
  // continue an existing day's file rather than truncating
  let size = 0;
  try { size = fs.statSync(target).size; } catch { /* new file */ }
  stream     = fs.createWriteStream(target, { flags: 'a' });
  streamPath = target;
  streamSize = size;
}

function rotateIfNeeded() {
  if (!stream || streamSize < MAX_BYTES) return;
  try { stream.end(); } catch { /* noop */ }
  // shift backups: .{N-1} → drop, …, current → .0
  for (let i = MAX_BACKUPS - 1; i >= 0; i--) {
    const src = i === 0 ? streamPath : `${streamPath}.${i - 1}`;
    const dst = `${streamPath}.${i}`;
    try { fs.renameSync(src, dst); } catch { /* missing — ok */ }
  }
  let size = 0;
  try { size = fs.statSync(streamPath).size; } catch { /* will recreate */ }
  stream     = fs.createWriteStream(streamPath, { flags: 'a' });
  streamSize = size;
}

function writeLine(level, args) {
  if (!stream) return;
  const ts = new Date().toISOString();
  const text = args.map((a) => {
    if (typeof a === 'string') return a;
    if (a instanceof Error)    return a.stack || a.message;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ');
  const line = `${ts} ${level} ${text}\n`;
  try { stream.write(line); streamSize += Buffer.byteLength(line); } catch { /* noop */ }
  rotateIfNeeded();
}

// BUG-002: drop session-log subdirs older than PRUNE_DAYS_OLD. Best-effort —
// if a dir is in use (stat fails, rmdir fails), skip it; the next startup
// retries. Synchronous on purpose: runs once at boot before anything else
// writes to disk.
function pruneOldLogDirs(logDir) {
  let entries;
  try { entries = fs.readdirSync(logDir, { withFileTypes: true }); }
  catch { return { pruned: 0, kept: 0 }; }
  const cutoff = Date.now() - PRUNE_DAYS_OLD * 24 * 60 * 60 * 1000;
  let pruned = 0;
  let kept   = 0;
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (!SESSION_DIR_RE.test(ent.name)) continue;
    const full = path.join(logDir, ent.name);
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(full).mtimeMs; } catch { continue; }
    if (mtimeMs >= cutoff) { kept += 1; continue; }
    try {
      fs.rmSync(full, { recursive: true, force: true });
      pruned += 1;
    } catch { /* in use — skip */ }
  }
  return { pruned, kept };
}

export function installFileLogger({ logDir }) {
  ensureStream(logDir);
  // re-check the date once a minute so the file rolls at midnight UTC
  setInterval(() => ensureStream(logDir), 60_000).unref?.();

  // BUG-002: prune old session-log subdirs at startup so a runaway day can't
  // accumulate weeks of jsonl events on disk.
  const swept = pruneOldLogDirs(logDir);
  if (swept.pruned > 0) {
    writeLine('INFO', [`[logger] pruned ${swept.pruned} session-log subdir(s) older than ${PRUNE_DAYS_OLD}d (kept ${swept.kept})`]);
  }

  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      try { writeLine(level.toUpperCase(), args); } catch { /* noop */ }
      orig(...args);
    };
  }
}
