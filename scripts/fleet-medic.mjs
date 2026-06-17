#!/usr/bin/env node
// MEDIC-001: autonomous fleet medic — detects stuck/bad bot patterns from
// the dashboard API and applies a graduated intervention ladder.
//
// Runs alongside the existing supervisor + watchdog. The watchdog already
// handles full-slot recycles on the loudest signals (10× same decision,
// java dead, etc.) — the medic layers gentler, earlier nudges so a wedged
// bot doesn't sit for 60+ minutes before tripping the watchdog's thresholds.
//
// Patterns mined from data/overnight/manual-restarts.jsonl + the BUG-001..21
// backlog (AI/sessions/2026-05-06-bug-backlog.md). Top three failure shapes:
//   - same skill+args repeated for hours (BUG-001, 10× / day)
//   - stationary 20-60 min while brain still "deciding" (death+stuck loops)
//   - lastDecisionAgeS climbing silently (BUG-002/007 brain stall)
//
// Intervention ladder (per bot, per signal):
//   L1  log only                     (first detection — observation window)
//   L2  snapshot bot state           (forensic record; non-destructive)
//   L3  POST disconnect + connect    (gentle reconnect, no world wipe)
//   L4  POST /api/admin/slots/:n/recycle  (atomic snapshot+kill+respawn)
//   L5  alarm-only — write loud jsonl line, never auto-escalate further
//
// Cooldowns prevent runaway recycle loops: after L4 a bot is grace-listed
// for 15 min before the medic will look at it again at all.
//
// Safety:
//   - PID file refuses double-start.
//   - 90s global startup grace (no L3/L4 in the first 90s).
//   - 60s post-recycle grace per bot.
//   - 60s after-supervisor-restart grace if dashboard heartbeat is recent.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const REPO_ROOT  = path.resolve(__dirname, '..');
const DATA_DIR   = process.env.DATA_DIR ?? path.join(REPO_ROOT, 'data');
const OVERNIGHT  = path.join(DATA_DIR, 'overnight');
const PID_FILE   = path.join(OVERNIGHT, 'medic.pid');
const LOG_FILE   = path.join(OVERNIGHT, 'medic.jsonl');
const DASHBOARD  = process.env.DASHBOARD ?? 'http://127.0.0.1:8080';

// ---- tunables ------------------------------------------------------------
const POLL_INTERVAL_MS         = 20_000;
const STARTUP_GRACE_MS         = 90_000;
const POST_RECYCLE_GRACE_MS    = 60_000;
const PER_BOT_COOLDOWN_MS      = 5 * 60_000;   // no re-intervene < 5min
const ESCALATE_GAP_MS          = 5 * 60_000;   // wait this long before next level
const POST_L4_BLACKOUT_MS      = 15 * 60_000;  // L4 → 15min hands-off
const L5_FORCE_WINDOW_MS       = 10 * 60_000;  // count L5 alarms in this window
const L5_FORCE_THRESH          = 3;            // 3+ L5 alarms → force recycle
const POST_FORCE_RECYCLE_MS    = 30 * 60_000;  // longer cooldown after force recycle

const DECISION_STALE_S         = 180;          // lastDecisionAgeS > this → brain freeze
const REPEAT_DECISION_THRESH   = 5;            // same sig in last N → stuck loop
const REPEAT_DECISION_HISTORY  = 8;            // ring buffer size
const WAIT_SPIRAL_THRESH       = 6;            // 6 consecutive 'wait' picks
const STATIONARY_RADIUS_BLOCKS = 2;
const STATIONARY_WINDOW_MS     = 8 * 60_000;   // 8 min in same 2-block radius
const DISCONNECT_GRACE_MS      = 5 * 60_000;
const BRAIN_ERROR_GRACE_MS     = 3 * 60_000;   // persistent lastBrainError

// Slots 1-5 are recycle-eligible (PORT_BY_SLOT in src/admin.js).
// Slots 6-8 (if running) only get L3 reconnect; L4 falls back to L5 alarm.
const RECYCLE_ELIGIBLE_SLOTS = new Set([1, 2, 3, 4, 5]);

// ---- pid + log helpers ---------------------------------------------------
function processAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function claimPidFile() {
  try {
    const raw = await fsp.readFile(PID_FILE, 'utf8');
    const prior = Number(raw.trim());
    if (prior && processAlive(prior)) {
      throw new Error(`another medic is already running (pid ${prior}); refuse to start`);
    }
  } catch (err) {
    if (err.code !== 'ENOENT' && !String(err).includes('refuse to start')) {
      // unreadable but not missing → safer to bail
      if (String(err).includes('refuse to start')) throw err;
    }
    if (String(err).includes('refuse to start')) throw err;
  }
  await fsp.mkdir(OVERNIGHT, { recursive: true });
  await fsp.writeFile(PID_FILE, String(process.pid), 'utf8');
}

async function releasePidFile() {
  try { await fsp.unlink(PID_FILE); } catch { /* ignore */ }
}

async function logEvent(obj) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n';
  try { await fsp.appendFile(LOG_FILE, line, 'utf8'); } catch (e) { console.error('[medic] log fail:', e.message); }
  if (!process.env.MEDIC_QUIET) process.stdout.write(`[medic] ${line}`);
}

// ---- dashboard API -------------------------------------------------------
async function api(method, urlPath, body) {
  const opts = { method, signal: AbortSignal.timeout(8000), headers: {} };
  if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${DASHBOARD}${urlPath}`, opts);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  if (!res.ok) {
    const e = new Error(`HTTP ${res.status} ${method} ${urlPath}: ${json?.error ?? text?.slice(0, 200)}`);
    e.status = res.status;
    throw e;
  }
  return json;
}

// ---- decision signature (mirrors watchdog.mjs#decisionSig) ---------------
function decisionSig(d) {
  if (!d) return null;
  const skill = d.skill ?? d.action?.skill ?? d.action?.type ?? null;
  const args  = d.args  ?? d.action?.args  ?? {};
  if (!skill) return null;
  try { return `${skill}:${JSON.stringify(args)}`; } catch { return `${skill}:?`; }
}

// ---- per-bot tracking ----------------------------------------------------
function newBotTrack(botId) {
  return {
    botId,
    sigs: [],                // ring of decision sigs, newest last
    lastDecisionTs: null,
    posHistory: [],          // [{ ts, x, y, z }] keep last 30 samples
    brainErrorSince: null,   // ts when lastBrainError became non-empty
    disconnectedSince: null,
    lastBrainError: '',
    // ladder state per signal: { L: level, ts: lastActionTs, blackoutUntil }
    ladder: {},              // { signalName: { level, lastTs, blackoutUntil } }
    l5Alarms: [],            // timestamps of recent L5 alarms (any signal)
    forceRecycleBlackoutUntil: 0,
  };
}

function pushSig(track, sig, ts) {
  if (!sig) return;
  if (track.sigs.length && track.sigs[track.sigs.length - 1].ts === ts) return;
  track.sigs.push({ sig, ts });
  if (track.sigs.length > REPEAT_DECISION_HISTORY) track.sigs.shift();
}

function pushPos(track, pos, now) {
  if (!pos || typeof pos.x !== 'number') return;
  track.posHistory.push({ ts: now, x: pos.x, y: pos.y, z: pos.z });
  // drop entries older than 2× stationary window
  const cutoff = now - 2 * STATIONARY_WINDOW_MS;
  while (track.posHistory.length && track.posHistory[0].ts < cutoff) track.posHistory.shift();
}

// ---- detection rules -----------------------------------------------------
function detectSignals(track, stateRes, decisionRes, now) {
  const signals = [];
  const state = stateRes?.state;
  const brainStatus = stateRes?.brainStatus;
  const lastDecAge = stateRes?.lastDecisionAgeS;

  // skip detection while brain is intentionally paused
  if (brainStatus === 'llm_backoff') return signals;

  // 1. repeated decision (stuck loop)
  if (track.sigs.length >= REPEAT_DECISION_THRESH) {
    const recent = track.sigs.slice(-REPEAT_DECISION_THRESH);
    const sig0 = recent[0].sig;
    if (sig0 && recent.every((s) => s.sig === sig0)) {
      signals.push({ name: 'stuck_decision', evidence: { sig: sig0, count: recent.length } });
    }
  }

  // 2. wait-spiral
  if (track.sigs.length >= WAIT_SPIRAL_THRESH) {
    const tail = track.sigs.slice(-WAIT_SPIRAL_THRESH);
    if (tail.every((s) => s.sig && s.sig.startsWith('wait:'))) {
      signals.push({ name: 'wait_spiral', evidence: { count: tail.length } });
    }
  }

  // 3. brain stale (decision not advancing while connected)
  if (state === 'connected' && typeof lastDecAge === 'number' && lastDecAge > DECISION_STALE_S) {
    signals.push({ name: 'decision_stale', evidence: { lastDecisionAgeS: lastDecAge, brainStatus } });
  }

  // 4. stationary too long
  if (state === 'connected' && track.posHistory.length >= 2) {
    const oldest = track.posHistory[0];
    const newest = track.posHistory[track.posHistory.length - 1];
    if (now - oldest.ts >= STATIONARY_WINDOW_MS) {
      // check all positions stay within radius of newest
      const maxDist = track.posHistory.reduce((m, p) => {
        const dx = p.x - newest.x, dz = p.z - newest.z;
        return Math.max(m, Math.sqrt(dx * dx + dz * dz));
      }, 0);
      if (maxDist <= STATIONARY_RADIUS_BLOCKS) {
        signals.push({
          name: 'stationary',
          evidence: {
            pos: { x: Math.round(newest.x), y: Math.round(newest.y), z: Math.round(newest.z) },
            windowMs: now - oldest.ts,
            maxDist: Number(maxDist.toFixed(2)),
          },
        });
      }
    }
  }

  // 5. disconnected too long
  if (state !== 'connected' && track.disconnectedSince && now - track.disconnectedSince > DISCONNECT_GRACE_MS) {
    signals.push({
      name: 'disconnected',
      evidence: { state, sinceMs: now - track.disconnectedSince },
    });
  }

  // 6. persistent brain error
  if (track.brainErrorSince && now - track.brainErrorSince > BRAIN_ERROR_GRACE_MS) {
    signals.push({
      name: 'brain_error_persist',
      evidence: { lastBrainError: track.lastBrainError, sinceMs: now - track.brainErrorSince },
    });
  }

  return signals;
}

// ---- intervention ladder -------------------------------------------------
function nextLevel(ladder, signalName, now) {
  const s = ladder[signalName];
  if (!s) return { level: 1, lastTs: 0 };
  if (s.blackoutUntil && now < s.blackoutUntil) return { level: 0, lastTs: s.lastTs };  // 0 = blocked
  if (now - s.lastTs < ESCALATE_GAP_MS) return { level: 0, lastTs: s.lastTs };           // too soon
  return { level: Math.min(s.level + 1, 5), lastTs: s.lastTs };
}

function recordLadder(ladder, signalName, level, now) {
  const prev = ladder[signalName] ?? { level: 0, lastTs: 0 };
  prev.level = level;
  prev.lastTs = now;
  if (level >= 4) prev.blackoutUntil = now + POST_L4_BLACKOUT_MS;
  ladder[signalName] = prev;
}

// Last-resort: if a bot keeps tripping L5 alarms, force a recycle once per
// 30-min window, bypassing the per-signal blackout and the recycle-eligible
// guard. Returns true if a force recycle was attempted (caller should skip
// the regular alarm log in that case).
async function maybeForceRecycle({ track, bot, slot, signal, now, base }) {
  // prune + record this alarm
  const cutoff = now - L5_FORCE_WINDOW_MS;
  track.l5Alarms = track.l5Alarms.filter((t) => t >= cutoff);
  track.l5Alarms.push(now);
  if (track.l5Alarms.length < L5_FORCE_THRESH) return false;
  if (now < track.forceRecycleBlackoutUntil) return false;
  if (!slot) return false;
  try {
    const out = await api('POST', `/api/admin/slots/${slot}/recycle`, { reason: `medic_force_${signal.name}` });
    await logEvent({
      event: 'intervene',
      action: 'L5_force_recycle',
      note: 'L5 alarm threshold reached — force recycle',
      alarmCount: track.l5Alarms.length,
      result: out,
      ...base,
    });
    track.posHistory = [];
    track.sigs = [];
    track.brainErrorSince = null;
    track.disconnectedSince = null;
    track.l5Alarms = [];
    track.forceRecycleBlackoutUntil = now + POST_FORCE_RECYCLE_MS;
    // also reset ladder so we start fresh post-force-recycle
    for (const k of Object.keys(track.ladder)) {
      track.ladder[k] = { level: 0, lastTs: now, blackoutUntil: now + POST_FORCE_RECYCLE_MS };
    }
  } catch (e) {
    await logEvent({
      event: 'intervene_fail',
      action: 'L5_force_recycle',
      error: String(e),
      status: e.status,
      alarmCount: track.l5Alarms.length,
      ...base,
    });
  }
  return true;
}

async function intervene({ track, bot, slot, signal, level }) {
  const base = { signal: signal.name, evidence: signal.evidence, botId: bot.id, slot };
  const now = Date.now();
  if (level === 1) {
    await logEvent({ event: 'detect', action: 'L1_log', ...base });
    return true;
  }
  if (level === 2) {
    try {
      await api('POST', `/api/bots/${bot.id}/snapshot`, { reason: `medic_${signal.name}` });
      await logEvent({ event: 'intervene', action: 'L2_snapshot', ...base });
    } catch (e) {
      await logEvent({ event: 'intervene_fail', action: 'L2_snapshot', error: String(e), ...base });
    }
    return true;
  }
  if (level === 3) {
    try {
      // gentle reconnect
      try { await api('POST', `/api/bots/${bot.id}/disconnect`); } catch { /* may already be disconnected */ }
      await delay(2000);
      await api('POST', `/api/bots/${bot.id}/connect`);
      await logEvent({ event: 'intervene', action: 'L3_reconnect', ...base });
    } catch (e) {
      await logEvent({ event: 'intervene_fail', action: 'L3_reconnect', error: String(e), ...base });
    }
    return true;
  }
  if (level === 4) {
    if (!slot || !RECYCLE_ELIGIBLE_SLOTS.has(slot)) {
      const forced = await maybeForceRecycle({ track, bot, slot, signal, now, base });
      if (!forced) {
        await logEvent({ event: 'alarm', action: 'L5_alarm', note: 'slot not recycle-eligible', ...base });
      }
      return true;
    }
    try {
      const out = await api('POST', `/api/admin/slots/${slot}/recycle`, { reason: `medic_${signal.name}` });
      await logEvent({ event: 'intervene', action: 'L4_recycle', result: out, ...base });
      track.posHistory = [];
      track.sigs = [];
      track.brainErrorSince = null;
      track.disconnectedSince = null;
    } catch (e) {
      await logEvent({ event: 'intervene_fail', action: 'L4_recycle', error: String(e), status: e.status, ...base });
    }
    return true;
  }
  // level 5: alarm — but if alarms keep firing, force a recycle as last resort
  const forced = await maybeForceRecycle({ track, bot, slot, signal, now, base });
  if (!forced) {
    await logEvent({ event: 'alarm', action: 'L5_alarm', note: 'ladder exhausted', ...base });
  }
  return true;
}

// ---- main loop -----------------------------------------------------------
async function botSlot(bot) {
  // Best-effort slot derivation: bot.host is typically 127.0.0.1, port 25565+
  const port = bot.port ?? bot.server?.port ?? null;
  if (!port || port < 25565) return null;
  const slot = port - 25564;
  return slot >= 1 && slot <= 8 ? slot : null;
}

async function tick(state, now) {
  let bots;
  try {
    const r = await api('GET', '/api/bots');
    bots = r?.bots ?? [];
  } catch (e) {
    await logEvent({ event: 'poll_error', stage: 'list_bots', error: String(e) });
    return;
  }

  const inStartupGrace = now - state.startedAt < STARTUP_GRACE_MS;

  for (const bot of bots) {
    if (!bot?.id) continue;
    let track = state.bots.get(bot.id);
    if (!track) {
      track = newBotTrack(bot.id);
      state.bots.set(bot.id, track);
    }

    let stateRes, decisionRes;
    try {
      stateRes    = await api('GET', `/api/bots/${bot.id}/state`);
      decisionRes = await api('GET', `/api/bots/${bot.id}/decision`);
    } catch (e) {
      await logEvent({ event: 'poll_error', botId: bot.id, error: String(e) });
      continue;
    }

    // update tracking
    if (stateRes?.state === 'connected') {
      track.disconnectedSince = null;
      const pos = stateRes.position ?? stateRes.entity?.position ?? null;
      pushPos(track, pos, now);
    } else if (!track.disconnectedSince) {
      track.disconnectedSince = now;
    }

    const ld = decisionRes?.lastDecision;
    if (ld) {
      const sig = decisionSig(ld);
      const ldTs = typeof ld.ts === 'number' ? ld.ts : Date.parse(ld.ts || '') || now;
      if (track.lastDecisionTs !== ldTs) {
        pushSig(track, sig, ldTs);
        track.lastDecisionTs = ldTs;
      }
    }

    const lbe = stateRes?.lastBrainError ?? '';
    if (lbe && lbe !== track.lastBrainError) {
      track.lastBrainError = lbe;
      track.brainErrorSince = now;
    } else if (!lbe) {
      track.lastBrainError = '';
      track.brainErrorSince = null;
    }

    const slot = await botSlot(bot);

    // detect
    const signals = detectSignals(track, stateRes, decisionRes, now);

    for (const sig of signals) {
      const decision = nextLevel(track.ladder, sig.name, now);
      if (decision.level === 0) continue;
      // per-bot global cooldown: if we acted on ANY signal for this bot
      // in last PER_BOT_COOLDOWN_MS, only allow L1 (log)
      const anyRecent = Object.values(track.ladder)
        .some((s) => s.lastTs && now - s.lastTs < PER_BOT_COOLDOWN_MS);
      let level = decision.level;
      if (anyRecent && level > 1) level = 1;
      // startup grace: never escalate past L2 in first 90s
      if (inStartupGrace && level > 2) level = Math.min(level, 2);
      // post-recycle grace: skip any action if a recycle happened recently
      const recentRecycle = Object.values(track.ladder)
        .some((s) => s.level >= 4 && s.lastTs && now - s.lastTs < POST_RECYCLE_GRACE_MS);
      if (recentRecycle) continue;

      const acted = await intervene({ track, bot, slot, signal: sig, level });
      if (acted) recordLadder(track.ladder, sig.name, level, now);
    }
  }
}

// ---- main ---------------------------------------------------------------
async function main() {
  await claimPidFile();
  const state = { startedAt: Date.now(), bots: new Map() };

  let stopping = false;
  const shutdown = async (sig) => {
    if (stopping) return;
    stopping = true;
    await logEvent({ event: 'medic_stopping', signal: sig });
    await releasePidFile();
    process.exit(0);
  };
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', async (err) => {
    await logEvent({ event: 'uncaught', error: String(err), stack: err?.stack?.split('\n').slice(0, 4) });
    await releasePidFile();
    process.exit(1);
  });

  await logEvent({
    event: 'medic_start',
    pid: process.pid,
    dashboard: DASHBOARD,
    pollIntervalMs: POLL_INTERVAL_MS,
    startupGraceMs: STARTUP_GRACE_MS,
  });

  while (!stopping) {
    const now = Date.now();
    try {
      await tick(state, now);
    } catch (e) {
      await logEvent({ event: 'tick_error', error: String(e), stack: e?.stack?.split('\n').slice(0, 4) });
    }
    await delay(POLL_INTERVAL_MS);
  }
}

main().catch(async (e) => {
  console.error('[medic] fatal:', e);
  try { await logEvent({ event: 'fatal', error: String(e) }); } catch {}
  await releasePidFile();
  process.exit(1);
});
