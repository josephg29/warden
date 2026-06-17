// BUG-002: surface disk pressure before it silently wedges every brain.
//
// The 2026-05-06 outage: C: drive hit 0 bytes free → fs.writeFile to memory
// JSON returned ENOSPC → brain caught it and re-tried indefinitely → all 5
// bots stalled within 18 s of each other with brainStatus="stalled" and no
// surfaced error.
//
// This module:
//   1. Polls free disk space on the data dir's drive every POLL_MS.
//   2. Exposes a level (ok / warn / critical) and freeMB for the dashboard
//      via /api/server.
//   3. On critical (< CRITICAL_MB), broadcasts a console.warn AND sets
//      instance.error on every BotInstance so the dashboard's per-bot card
//      shows "disk_low: <mb> MB free" instead of an empty error field.
//   4. Runs a one-shot startup sweep over slot dirs to clear logs/
//      crash-reports/cache before any java process can re-fill them.

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const POLL_MS     = 30_000;
export const WARN_MB     = 500;
export const CRITICAL_MB = 100;

const SLOT_SUBDIRS_TO_CLEAR = ['logs', 'crash-reports', 'cache'];
const SLOT_DIR_RE = /^mc-test-slot\d+$/;

export class DiskWatch extends EventEmitter {
  constructor({ dataDir, manager } = {}) {
    super();
    this._dataDir = dataDir;
    this._manager = manager ?? null;
    this._timer   = null;
    this._freeMB  = null;
    this._level   = 'ok';
    this._lastCheckAt = 0;
  }

  start() {
    if (this._timer) return;
    // first check is immediate so /api/server has a value on first poll
    this._check().catch(() => { /* swallow — logged inside */ });
    this._timer = setInterval(() => {
      this._check().catch(() => { /* swallow */ });
    }, POLL_MS);
    this._timer.unref?.();
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  get freeMB() { return this._freeMB; }
  get level()  { return this._level; }

  toJSON() {
    return {
      freeMB:    this._freeMB,
      level:     this._level,
      warnMB:    WARN_MB,
      criticalMB: CRITICAL_MB,
      lastCheckAt: this._lastCheckAt || null,
    };
  }

  async _check() {
    let freeMB = null;
    try {
      // Node 18.18+ / 20+: fs.statfs. Falls back to null on failure.
      const st = await fsp.statfs(this._dataDir);
      const freeBytes = Number(st.bavail) * Number(st.bsize);
      freeMB = Math.max(0, Math.round(freeBytes / (1024 * 1024)));
    } catch (err) {
      console.warn(`[diskwatch] statfs failed: ${err.message}`);
      return;
    }

    this._lastCheckAt = Date.now();
    const prevLevel = this._level;
    this._freeMB = freeMB;

    let level = 'ok';
    if (freeMB < CRITICAL_MB)      level = 'critical';
    else if (freeMB < WARN_MB)     level = 'warn';
    this._level = level;

    if (level !== prevLevel) {
      if (level === 'critical') {
        console.warn(`[diskwatch] CRITICAL: ${freeMB} MB free on data dir — bots may stall on writes`);
      } else if (level === 'warn') {
        console.warn(`[diskwatch] LOW: ${freeMB} MB free on data dir`);
      } else if (prevLevel !== 'ok') {
        console.log(`[diskwatch] recovered: ${freeMB} MB free`);
      }
      this.emit('change', { freeMB, level, prev: prevLevel });
    }

    // critical: smear onto every BotInstance.error so the dashboard's per-bot
    // card surfaces it. Recovers (clears) when level transitions back to ok
    // OR when the next event (kicked / disconnect / connect) overwrites it.
    if (this._manager) {
      if (level === 'critical') {
        const msg = `disk_low: ${freeMB} MB free`;
        for (const inst of this._manager.list()) {
          // only stamp if not already showing a different error — don't
          // overwrite a fresh kicked/runtime error with stale disk info.
          if (!inst.error || /^disk_low:/.test(inst.error)) {
            inst.error = msg;
            inst.emit?.('change');
          }
        }
      } else if (prevLevel === 'critical' && level !== 'critical') {
        for (const inst of this._manager.list()) {
          if (inst.error && /^disk_low:/.test(inst.error)) {
            inst.error = null;
            inst.emit?.('change');
          }
        }
      }
    }
  }
}

// BUG-002: one-shot startup sweep — nuke logs/crash-reports/cache inside each
// data/mc-test-slot* subdir. Runs synchronously at boot before any MC server
// process can re-fill them. Best-effort: in-use files on Windows simply skip.
// Step 2.6 (2026-05-17): preserve cache/mojang_*.jar across the startup
// sweep too (sweepOneSlotDir already does this — they need to match or the
// next dashboard restart re-nukes everything). Same rationale: the Mojang
// jar is immutable per Minecraft version and the CDN is flaky.
export function sweepSlotDirsAtStartup(dataDir) {
  let entries;
  try { entries = fs.readdirSync(dataDir, { withFileTypes: true }); }
  catch { return { swept: 0, errors: 0 }; }

  let swept = 0, errors = 0;
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (!SLOT_DIR_RE.test(ent.name)) continue;
    const slotDir = path.join(dataDir, ent.name);
    for (const sub of SLOT_SUBDIRS_TO_CLEAR) {
      const target = path.join(slotDir, sub);
      if (sub === 'cache') {
        try {
          const items = fs.readdirSync(target, { withFileTypes: true });
          for (const it of items) {
            if (!it.isFile()) {
              try { fs.rmSync(path.join(target, it.name), { recursive: true, force: true }); }
              catch { /* skip */ }
              continue;
            }
            if (/^mojang_[\d.]+\.jar$/.test(it.name)) continue;
            try { fs.rmSync(path.join(target, it.name), { force: true }); }
            catch { /* skip */ }
          }
          swept += 1;
        } catch { /* dir missing — nothing to sweep */ }
        continue;
      }
      try {
        fs.rmSync(target, { recursive: true, force: true });
        swept += 1;
      } catch (err) {
        errors += 1;
        console.warn(`[diskwatch] sweep ${target} failed: ${err.message}`);
      }
    }
  }
  return { swept, errors };
}

// BUG-002: per-slot sweep used by the recycle endpoint and on-connect hook.
// Same logic as sweepSlotDirsAtStartup but scoped to one slot.
// Step 2.6 (2026-05-16): preserve cache/mojang_*.jar across sweeps. PaperMC
// re-downloads the vanilla server jar on every boot if missing; the Mojang
// CDN occasionally fails (rate-limit / DNS / network), leaving the slot
// unable to boot. Cached jars are immutable per Minecraft version, so
// keeping them shaves ~30s off every recycle and removes a flaky external
// dependency from the hot path.
export async function sweepOneSlotDir(slotDir) {
  const cleared = [];
  for (const sub of SLOT_SUBDIRS_TO_CLEAR) {
    const target = path.join(slotDir, sub);
    if (sub === 'cache') {
      try {
        const entries = await fsp.readdir(target, { withFileTypes: true });
        for (const ent of entries) {
          if (!ent.isFile()) {
            try { await fsp.rm(path.join(target, ent.name), { recursive: true, force: true }); }
            catch { /* skip */ }
            continue;
          }
          if (/^mojang_[\d.]+\.jar$/.test(ent.name)) continue;
          try { await fsp.rm(path.join(target, ent.name), { force: true }); }
          catch { /* skip */ }
        }
        cleared.push(`${sub} (preserved mojang_*.jar)`);
      } catch { /* dir missing — nothing to clear */ }
      continue;
    }
    try {
      await fsp.rm(target, { recursive: true, force: true });
      cleared.push(sub);
    } catch { /* in use — skip */ }
  }
  return cleared;
}
