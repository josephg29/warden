#!/usr/bin/env node
// Overnight watchdog for 5 parallel agora tests.
// Polls each bot every POLL_MS, detects unhealthy patterns, restarts as a new TestN.
// Logs all events to overnight.jsonl.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const __filename = fileURLToPath(import.meta.url);
const ROOT       = path.resolve(path.dirname(__filename), '..', '..'); // mc-mission-control
const DATA_DIR   = path.join(ROOT, 'data');
const NIGHT_DIR  = path.join(DATA_DIR, 'overnight');
const STATE_FILE = path.join(NIGHT_DIR, 'state.json');
const LOG_FILE   = path.join(NIGHT_DIR, 'overnight.jsonl');
const DASHBOARD  = process.env.DASHBOARD ?? 'http://127.0.0.1:8080';

const POLL_MS                  = 60_000;        // 60 s between health sweeps
const STALL_DECISION_AGE_S     = 300;           // 5 min with no new decision => stalled
const DISCONNECT_GRACE_MS      = 120_000;       // 2 min disconnected => unhealthy
const DEATH_WINDOW_MS          = 5 * 60_000;    // count deaths inside this window
const DEATH_THRESHOLD          = 3;             // ≥3 deaths in window => death loop
const REPEAT_DECISION_THRESH   = 10;            // ≥10 same skill+args in last 20 decisions
const PHANTOM_CRAFT_THRESH     = 3;             // ≥3 phantom-craft pairs in window
// OVN-017: progress-starvation. 30 decisions with zero ok=true outcomes is
// ~2.5 minutes at the brain's current 5s cadence — comfortably past any
// legitimate exploration phase, well short of the 11-hour Test33 disaster.
const PROGRESS_WINDOW_LEN      = 30;
const PROGRESS_OK_MIN          = 1;
// 2026-05-11: bumped from 120s → 240s after the BUG-001 deploy run exposed a
// 5-slot failed-boot loop. World gen for a freshly-wiped slot on a busy host
// (8 Java instances + Node + dashboard + watchdog) was exceeding 120s. The
// retry on each timeout was wiping the partial world and restarting from
// zero, so the slot could never progress. 240s + don't-wipe-on-retry +
// exponential backoff (see slot.bootTimeoutStreak below) breaks the loop.
const SERVER_BOOT_TIMEOUT_MS   = 240_000;       // wait this long for "Done (" after spawn
const KILL_GRACE_MS            = 8_000;
const RESTART_COOLDOWN_MS      = 30_000;        // base cooldown — multiplied by 2^streak on boot-timeout
// Exponential backoff cap and "stop retrying, alert human" threshold for the
// slot's consecutive boot-timeout streak. After MAX_BOOT_TIMEOUT_STREAK
// failures in a row, the watchdog marks the slot dormant — logs a single
// `boot_timeout_streak_giveup` event and stops trying to recycle the slot
// until restart_complete fires (which clears the streak).
const RESTART_BACKOFF_CAP_MS   = 30 * 60_000;    // 30 min ceiling
const MAX_BOOT_TIMEOUT_STREAK  = 8;              // beyond this, give up and alert

// OBS-MASS-DC: when ≥4 slots disconnect within this window, label the event
// as a single infrastructure incident rather than N per-bot stuck-states.
const MASS_DC_WINDOW_MS  = 3 * 60_000;   // 3-minute window for fleet mass-disconnect
const MASS_DC_THRESHOLD  = 4;            // ≥4 slots in window → mass_disconnect label

// Phase B / B2 (Step 2.5, 2026-05-11): spawn quality detector. After the bot
// reaches brainStatus=active for the first time post-spawn, give it 60s to
// move and stabilize. If after the window it's still in a bad y-band
// (deep cave or mountaintop) or hasn't moved horizontally, flag the slot
// for human review by appending to spawn-reseed-candidates.jsonl. Reset on
// every restart_complete so the next spawn gets a fresh window.
//
// Bounds:
//   y < -10 → too deep (Slot 4 has been at y=-51 for >24h in flooded cave)
//   y > 200 → mountaintop / floating (no resources, may fall to death)
//   horizontal < 5m → completely stuck (probably terrain trap)
//
// Output is ADVISORY ONLY — destructive reset still requires human approval
// via /test-reset slot=N --yes per project_agora_test_convention.md.
export const SPAWN_OBSERVE_WINDOW_MS = 60_000;
const SPAWN_Y_LOW    = -10;
const SPAWN_Y_HIGH   = 200;
const SPAWN_MIN_MOVE = 5;
const SPAWN_RESEED_FILE = path.join(NIGHT_DIR, 'spawn-reseed-candidates.jsonl');

// BUG-009: dashboard-down detection. Dashboard touches <dataDir>/dashboard-heartbeat
// every 5s. If mtime is older than HEARTBEAT_STALE_MS or three consecutive sweeps
// fail to poll *all* slots, treat the dashboard as dead.
const HEARTBEAT_FILE           = path.join(DATA_DIR, 'dashboard-heartbeat');
const HEARTBEAT_STALE_MS       = 60_000;        // mtime older than this => dead
const FLEET_POLL_FAIL_THRESH   = 3;             // 3 consecutive sweeps with all slots failing

// ---------- helpers ----------
async function logEvent(obj) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n';
  await fsp.appendFile(LOG_FILE, line, 'utf8');
  console.log('[watchdog]', line.trim());
}

async function readState() {
  try {
    const raw = await fsp.readFile(STATE_FILE, 'utf8');
    // OVN-003: PowerShell 5.1 `Set-Content -Encoding utf8` writes UTF-8 with
    // BOM. Strip it before parsing so hand-edits don't crash the watchdog.
    return JSON.parse(raw.replace(/^﻿/, ''));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return null;
  }
}
async function writeState(s) {
  await fsp.writeFile(STATE_FILE, JSON.stringify(s, null, 2), 'utf8');
}

async function api(method, url, body) {
  // OVN-002: cap each request at 5s. When the dashboard event loop wedges,
  // the OS-level TCP timeout is ~5min — that's why poll_error events were
  // spaced 5min apart instead of POLL_MS (60s). 5s × 2 calls × 5 slots
  // gives a worst-case 50s sweep, leaving headroom inside POLL_MS.
  const opts = { method, headers: {}, signal: AbortSignal.timeout(5000) };
  if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(`${DASHBOARD}${url}`, opts);
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new Error(`HTTP timeout 5000ms ${url}`);
    }
    throw err;
  }
  if (!res.ok && res.status !== 409 && res.status !== 404) {
    const txt = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${url}: ${txt.slice(0, 200)}`);
  }
  if (res.status === 204) return null;
  return res.json().catch(() => null);
}

function processAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killProcess(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch { /* already gone */ }
}

async function spawnMcServer(slot) {
  const slotDir = path.join(DATA_DIR, `mc-test-slot${slot.slot}`);
  const logPath = path.join(NIGHT_DIR, `mc-slot${slot.slot}.log`);
  // truncate prior log so "Done (" detection is unambiguous
  try { await fsp.unlink(logPath); } catch { /* noop */ }
  try { await fsp.unlink(`${logPath}.err`); } catch { /* noop */ }

  const out = fs.openSync(logPath, 'a');
  const err = fs.openSync(`${logPath}.err`, 'a');
  const child = spawn('java', ['-Xms256M', '-Xmx512M', '-jar', 'server.jar', '--nogui'], {
    cwd: slotDir,
    stdio: ['ignore', out, err],
    detached: true,
    windowsHide: true,
  });
  child.unref();
  return { pid: child.pid, logPath };
}

async function waitForDone(logPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const txt = await fsp.readFile(logPath, 'utf8');
      if (/Done \([^)]*\)! For help/.test(txt)) return true;
      // also accept the simpler "Done (" pattern in case the help phrase changes
      if (/Done \([\d.]+s\)/.test(txt)) return true;
    } catch { /* not yet */ }
    await delay(2000);
  }
  return false;
}

async function freshWorld(slotDir) {
  for (const w of ['world', 'world_nether', 'world_the_end']) {
    await fsp.rm(path.join(slotDir, w), { recursive: true, force: true });
  }
}

// ---------- health detection ----------
function classifyHealth({ state, decision, slot, now, massDisconnect = false }) {
  const evidence = {};

  // 1. process dead
  if (!processAlive(slot.javaPid)) {
    return { unhealthy: true, reason: 'java_process_dead', evidence: { javaPid: slot.javaPid } };
  }

  // 2. disconnected for too long; labelled mass_disconnect when ≥4 slots in window
  if (state.state !== 'connected') {
    const since = slot.lastSeenConnected ?? slot.connectedAt ?? 0;
    if (since && now - since > DISCONNECT_GRACE_MS) {
      const reason = massDisconnect ? 'mass_disconnect' : 'disconnected_too_long';
      return { unhealthy: true, reason, evidence: { state: state.state, since: new Date(since).toISOString() } };
    }
  }

  // 3. brain stalled — but llm_backoff means the brain is intentionally
  // pausing (W3 anti-fixation / rate-limit recovery), not stuck. Don't restart
  // for any reason while in backoff: the loop detectors below would mistake a
  // paused brain's stale lastDecision for a stuck pattern.
  if (state.brainStatus === 'llm_backoff') {
    return { unhealthy: false };
  }
  if (state.brainStatus === 'stalled' && (state.lastDecisionAgeS ?? 0) > STALL_DECISION_AGE_S) {
    return { unhealthy: true, reason: 'brain_stalled', evidence: { lastDecisionAgeS: state.lastDecisionAgeS, brainStatus: state.brainStatus, lastBrainError: state.lastBrainError } };
  }

  // 3b. Step 2.6: catch place_block:<x> with no_block_in_inventory on the
  // second consecutive repeat instead of waiting for the 10-repeat stuck_loop.
  // The error is deterministic — the second attempt will fail identically —
  // so 8 more attempts is ~5min of wasted brain cycles per occurrence.
  const errCode = decision?.lastSkillResult?.outcome?.error_code ?? decision?.lastSkillResult?.error_code ?? null;
  const decHistEarly = slot.recentDecisions ?? [];
  if (errCode === 'no_block_in_inventory' && decHistEarly.length >= 2) {
    const a = decHistEarly[decHistEarly.length - 1];
    const b = decHistEarly[decHistEarly.length - 2];
    if (a.sig && a.sig === b.sig && a.sig.startsWith('place_block:')) {
      return {
        unhealthy: true,
        reason: 'place_block_no_item',
        evidence: { repeatedSkill: a.sig, count: 2, error_code: 'no_block_in_inventory' },
      };
    }
  }

  // 4. death loop — recent_events with type=death in window
  const recent = state.memory?.state?.recent_events ?? [];
  const cutoff = now - DEATH_WINDOW_MS;
  const deaths = recent.filter((e) => {
    const ts = typeof e.ts === 'number' ? e.ts : Date.parse(e.ts || '');
    return ts >= cutoff && /death|died/i.test(JSON.stringify(e));
  });
  if (deaths.length >= DEATH_THRESHOLD) {
    return { unhealthy: true, reason: 'death_loop', evidence: { deathsInWindow: deaths.length, sample: deaths.slice(0, 3) } };
  }

  // 5. stuck loop — last 20 decisions all same skill+args
  const decHist = slot.recentDecisions ?? [];
  if (decHist.length >= REPEAT_DECISION_THRESH) {
    const last = decHist.slice(-REPEAT_DECISION_THRESH);
    const sig0 = last[0].sig;
    if (sig0 && last.every((d) => d.sig === sig0)) {
      return { unhealthy: true, reason: 'stuck_loop', evidence: { repeatedSkill: sig0, count: last.length } };
    }
  }

  // 6. phantom craft loop — pairs of (craft ok=true) followed by ("no X in inventory")
  const phantomCount = slot.phantomCraftWindow?.length ?? 0;
  if (phantomCount >= PHANTOM_CRAFT_THRESH) {
    return { unhealthy: true, reason: 'phantom_craft_loop', evidence: { phantomCount, window: slot.phantomCraftWindow.slice(-3) } };
  }

  // 7. progress starvation (OVN-017) — bot is deciding but nothing is succeeding.
  // Catches the Test33 mode even if decisionSig misses (encoding drift).
  const progress = slot.progressWindow ?? [];
  if (progress.length >= PROGRESS_WINDOW_LEN) {
    const oks = progress.filter((p) => p.ok).length;
    if (oks < PROGRESS_OK_MIN) {
      const skillCounts = {};
      for (const p of progress) skillCounts[p.skill] = (skillCounts[p.skill] ?? 0) + 1;
      return {
        unhealthy: true,
        reason: 'progress_starvation',
        evidence: { window: progress.length, oks, skillCounts },
      };
    }
  }

  return { unhealthy: false };
}

// OVN-017 (Test33 post-mortem 2026-05-08): the brain rewrite (commit 2a58406,
// 2026-05-02) reshaped lastDecision from `{ skill, args, ... }` to
// `{ action: { type, args }, reason, observation, ts, ... }`. The watchdog
// was written 5 days later but kept reading `d.skill` directly, so this
// function returned null on every decision. Result: `slot.recentDecisions`
// stayed [] forever and `stuck_loop` never fired. Test33 looped 11 hours on
// place_block(crafting_table) while the detector was structurally blind.
//
// Read all three known shapes — `d.skill` (legacy flat), `d.action.skill`
// (intermediate), `d.action.type` (current canonical, see brain.js:660+) —
// so a future shape rename gets caught by tests, not by another 11h outage.
// If skill is missing everywhere, return null and let the caller skip.
function decisionSig(d) {
  if (!d) return null;
  const skill = d.skill ?? d.action?.skill ?? d.action?.type ?? null;
  const args  = d.args  ?? d.action?.args  ?? {};
  if (!skill) return null;
  return `${skill}:${JSON.stringify(args)}`;
}

function trackDecisionHistory(slot, decision) {
  if (!decision?.lastDecision) return;
  const ld = decision.lastDecision;
  const sig = decisionSig(ld);
  if (!sig) return;
  slot.recentDecisions = slot.recentDecisions ?? [];
  // dedupe — same ts means same decision we already saw
  if (slot.recentDecisions.length && slot.recentDecisions[slot.recentDecisions.length - 1].ts === ld.ts) return;
  slot.recentDecisions.push({ ts: ld.ts, sig });
  if (slot.recentDecisions.length > 30) slot.recentDecisions.shift();
}

// OVN-017: same shape mismatch — lastSkillResult is
// `{ skill, args, outcome: { ok, error }, durationMs, ts }`, not
// `{ skill, ok, error }` as the original code assumed. The phantom-craft
// detector silently never fired because lsr.ok / lsr.error were undefined.
function skillOk(lsr)    { return lsr?.outcome?.ok ?? lsr?.ok ?? null; }
function skillError(lsr) { return lsr?.outcome?.error ?? lsr?.error ?? lsr?.message ?? ''; }

function trackPhantomCraft(slot, decision) {
  // detect a craft+ok=true followed by an inventory-failed equip/place within recent window
  const ld   = decision?.lastDecision;
  const lsr  = decision?.lastSkillResult;
  if (!ld || !lsr) return;
  slot.phantomCraftWindow = slot.phantomCraftWindow ?? [];
  const ok   = skillOk(lsr);
  const errS = skillError(lsr);
  const item = ld.args?.item ?? ld.action?.args?.item ?? null;
  // when last skill was craft and it claims success, mark craft success
  if (lsr.skill === 'craft' && ok === true) {
    slot.lastCraftClaim = { ts: Date.now(), item };
  }
  if (slot.lastCraftClaim && ok === false && /no .*in inventory/i.test(errS)) {
    if (lsr.skill === 'equip_item' || lsr.skill === 'place_block') {
      slot.phantomCraftWindow.push({ ts: Date.now(), item: slot.lastCraftClaim.item, error: errS.slice(0, 120) });
      slot.lastCraftClaim = null;
    }
  }
  // age out
  const cutoff = Date.now() - DEATH_WINDOW_MS;
  slot.phantomCraftWindow = slot.phantomCraftWindow.filter((p) => p.ts >= cutoff);
}

// OVN-017: defense-in-depth — even if decisionSig encoding changes again,
// catch "lots of decisions, zero successful skill outcomes" as a separate
// signal. A healthy bot produces a steady stream of skill_done with ok=true
// (movement, mining, crafting). 30+ consecutive decisions with zero ok=true
// outcomes means something is structurally wrong.
function trackProgressStarvation(slot, decision) {
  const lsr = decision?.lastSkillResult;
  if (!lsr) return;
  slot.progressWindow = slot.progressWindow ?? [];
  if (slot.progressWindow.length && slot.progressWindow[slot.progressWindow.length - 1].ts === lsr.ts) return;
  slot.progressWindow.push({ ts: lsr.ts ?? Date.now(), skill: lsr.skill, ok: skillOk(lsr) === true });
  if (slot.progressWindow.length > 40) slot.progressWindow.shift();
}

// Phase B / B2 (Step 2.5, 2026-05-11): record the first time we see the bot
// in brainStatus=active after a (re)start, so we can compare its position
// SPAWN_OBSERVE_WINDOW_MS later. Idempotent — once brainActiveSince is set,
// repeat calls do nothing. The restart path (restartSlot) is responsible for
// clearing brainActiveSince + spawnInitialPosition + spawnQualityChecked back
// to null/false on each new test boot.
export function observeSpawnPosition(slot, stateRes, nowMs) {
  if (!slot || !stateRes) return;
  if (stateRes.brainStatus !== 'active') return;
  if (slot.brainActiveSince != null) return;
  const pos = stateRes.position;
  if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) return;
  slot.brainActiveSince     = nowMs;
  slot.spawnInitialPosition = { x: pos.x, y: pos.y, z: pos.z };
  slot.spawnQualityChecked  = false;
}

// Phase B / B2: pure decision function for a single slot's spawn quality
// after the observe window has elapsed. Returns:
//   { flag: false, reason: 'window_open' }    — too early to check
//   { flag: false, reason: 'no_position' }    — can't compare without coords
//   { flag: true,  reason: 'y_too_low', y }   — below SPAWN_Y_LOW (cave / void)
//   { flag: true,  reason: 'y_too_high', y }  — above SPAWN_Y_HIGH (mountain)
//   { flag: true,  reason: 'no_movement', horizontalM } — sub-5m total move
//   { flag: false, reason: 'healthy' }        — looks viable
export function evaluateSpawnQuality({ initial, current, ageMs }) {
  if (ageMs < SPAWN_OBSERVE_WINDOW_MS) return { flag: false, reason: 'window_open' };
  if (!initial || !current) return { flag: false, reason: 'no_position' };
  if (current.y < SPAWN_Y_LOW)  return { flag: true, reason: 'y_too_low',  y: current.y };
  if (current.y > SPAWN_Y_HIGH) return { flag: true, reason: 'y_too_high', y: current.y };
  const dx = current.x - initial.x;
  const dz = current.z - initial.z;
  const horizontalM = Math.sqrt(dx * dx + dz * dz);
  if (horizontalM < SPAWN_MIN_MOVE) return { flag: true, reason: 'no_movement', horizontalM };
  return { flag: false, reason: 'healthy' };
}

// OBS-MASS-DC: returns the affected slots when ≥MASS_DC_THRESHOLD slots have
// slot.disconnectedSince within MASS_DC_WINDOW_MS of now, or [] otherwise.
// Caller logs one fleet-level event and passes massDisconnect=true to
// classifyHealth so per-bot verdicts use 'mass_disconnect' instead of
// 'disconnected_too_long'. slot.disconnectedSince is set in tick() pass 1.
function detectMassDisconnect(slots, now) {
  const affected = slots.filter(
    (s) => s.disconnectedSince != null && now - s.disconnectedSince <= MASS_DC_WINDOW_MS,
  );
  return affected.length >= MASS_DC_THRESHOLD ? affected : [];
}

// ---------- restart sequence ----------
async function restartSlot(slot, state, reason, evidence) {
  const oldTest = slot.testNum;
  const newTest = state.nextTestNum++;
  // OVN-004: enrich the restart record with the slot's recent decision
  // history + cumulative restart count so the slot-3 forensic analysis
  // can correlate failure modes with what the bot was actually doing.
  await logEvent({
    event: 'restart_begin',
    slot: slot.slot,
    botId: slot.botId,
    oldTest,
    newTest,
    reason,
    evidence,
    restartCountSoFar: slot.restartCount ?? 0,
    recentDecisions: (slot.recentDecisions ?? []).slice(-5),
    phantomCraftSamples: (slot.phantomCraftWindow ?? []).slice(-3),
  });

  // 2026-05-11: when the previous attempt timed out booting Java, preserve
  // the partial world dirs and skip the memory wipe. Java's already done
  // significant world generation; wiping it forces every retry to start over
  // and the slot can never finish. The streak counter resets on
  // restart_complete (success).
  const retryingBootTimeout = (slot.bootTimeoutStreak ?? 0) > 0;

  // disconnect bot
  try { await api('POST', `/api/bots/${slot.botId}/disconnect`); } catch (e) { await logEvent({ event: 'restart_warn', slot: slot.slot, step: 'disconnect', error: String(e) }); }
  await delay(2000);
  // wipe memory (skip on boot-timeout retry — bot's pre-boot memory is fine)
  if (!retryingBootTimeout) {
    try { await api('DELETE', `/api/bots/${slot.botId}/memory`); } catch (e) { await logEvent({ event: 'restart_warn', slot: slot.slot, step: 'wipe_memory', error: String(e) }); }
  }
  // kill server
  killProcess(slot.javaPid);
  await delay(KILL_GRACE_MS);
  // wipe world (skip on boot-timeout retry to preserve partial generation)
  if (!retryingBootTimeout) {
    await freshWorld(path.join(DATA_DIR, `mc-test-slot${slot.slot}`));
  } else {
    await logEvent({ event: 'restart_preserve_world', slot: slot.slot, streak: slot.bootTimeoutStreak });
  }
  // respawn server
  const { pid: newPid, logPath } = await spawnMcServer(slot);
  slot.javaPid = newPid;
  const ready = await waitForDone(logPath, SERVER_BOOT_TIMEOUT_MS);
  if (!ready) {
    slot.bootTimeoutStreak = (slot.bootTimeoutStreak ?? 0) + 1;
    // Exponential backoff: 2^streak × base, capped. Streak 1 → 1m, 3 → 4m, 5 → 16m, ≥6 → 30m.
    const backoff = Math.min(RESTART_COOLDOWN_MS * Math.pow(2, slot.bootTimeoutStreak), RESTART_BACKOFF_CAP_MS);
    await logEvent({
      event: 'restart_failed',
      slot: slot.slot,
      reason: 'mc_server_boot_timeout',
      javaPid: newPid,
      streak: slot.bootTimeoutStreak,
      backoffMs: backoff,
    });
    // mark slot as broken; next sweep after the backoff window will retry
    slot.testNum = newTest;
    slot.recentDecisions = [];
    slot.phantomCraftWindow = [];
    slot.progressWindow = [];
    slot.lastCraftClaim = null;
    slot.cooldownUntil = Date.now() + backoff;
    // Give-up: too many consecutive boot-timeouts means this slot needs human attention.
    if (slot.bootTimeoutStreak >= MAX_BOOT_TIMEOUT_STREAK) {
      slot.dormant = true;
      await logEvent({
        event: 'boot_timeout_streak_giveup',
        slot: slot.slot,
        streak: slot.bootTimeoutStreak,
        hint: 'human intervention needed — check the slot dir, bump SERVER_BOOT_TIMEOUT_MS, or wipe and clear bootTimeoutStreak in state.json',
      });
    }
    return;
  }
  // rename bot
  try { await api('PATCH', `/api/bots/${slot.botId}`, { name: `Test${newTest}` }); }
  catch (e) { await logEvent({ event: 'restart_warn', slot: slot.slot, step: 'rename', error: String(e) }); }
  await delay(1500);
  // reconnect bot
  try { await api('POST', `/api/bots/${slot.botId}/connect`); }
  catch (e) { await logEvent({ event: 'restart_warn', slot: slot.slot, step: 'connect', error: String(e) }); }

  slot.testNum         = newTest;
  slot.connectedAt     = Date.now();
  slot.lastSeenConnected = Date.now();
  slot.disconnectedSince = null;
  slot.recentDecisions = [];
  slot.phantomCraftWindow = [];
  slot.lastCraftClaim  = null;
  slot.cooldownUntil   = Date.now() + RESTART_COOLDOWN_MS;
  slot.restartCount    = (slot.restartCount ?? 0) + 1;
  // 2026-05-11: clear the boot-timeout streak + dormant flag on success.
  slot.bootTimeoutStreak = 0;
  slot.dormant           = false;
  // Phase B / B2 (Step 2.5, 2026-05-11): reset spawn-quality tracker so the
  // next test gets its own 60s observe window.
  slot.brainActiveSince     = null;
  slot.spawnInitialPosition = null;
  slot.spawnQualityChecked  = false;

  await logEvent({ event: 'restart_complete', slot: slot.slot, botId: slot.botId, newTest, javaPid: newPid });
}

// ---------- dashboard liveness ----------
// BUG-009: detect a hung dashboard separately from "all bots are wedged".
// Two independent signals — heartbeat-file mtime and consecutive all-slot
// poll failures — must both agree before we declare the dashboard dead.
async function dashboardHeartbeatAgeMs() {
  try {
    const st = await fsp.stat(HEARTBEAT_FILE);
    return Date.now() - st.mtimeMs;
  } catch (err) {
    if (err.code === 'ENOENT') return Infinity; // never written
    throw err;
  }
}

// ---------- main loop ----------
async function tick(state) {
  const now = Date.now();
  let pollFailures = 0;
  let pollAttempts = 0;

  // Pass 1: poll every non-cooldown slot and update per-slot tracking state.
  // Collecting results so fleet-level detection runs before per-slot verdicts.
  const swept = [];
  for (const slot of state.slots) {
    if (slot.cooldownUntil && now < slot.cooldownUntil) continue;
    // 2026-05-11: dormant slots have failed too many boot-timeouts in a row;
    // the watchdog stops trying until a human resets state.dormant=false.
    if (slot.dormant) continue;
    pollAttempts += 1;
    let stateRes, decisionRes;
    try {
      stateRes = await api('GET', `/api/bots/${slot.botId}/state`);
      decisionRes = await api('GET', `/api/bots/${slot.botId}/decision`);
    } catch (e) {
      pollFailures += 1;
      await logEvent({ event: 'poll_error', slot: slot.slot, error: String(e) });
      continue;
    }
    if (!stateRes) continue;

    if (stateRes.state === 'connected') {
      slot.lastSeenConnected = now;
      slot.disconnectedSince = null;
    } else {
      slot.disconnectedSince = slot.disconnectedSince ?? now;
    }

    trackDecisionHistory(slot, decisionRes);
    trackPhantomCraft(slot, decisionRes);
    trackProgressStarvation(slot, decisionRes);

    // Phase B / B2 (Step 2.5, 2026-05-11): record first brain-active position
    // so the spawn-quality check below can compare drift after 60s.
    observeSpawnPosition(slot, stateRes, now);

    swept.push({ slot, stateRes, decisionRes });
  }

  // OBS-MASS-DC: fleet-level detection. Emits ONE event instead of N individual
  // disconnected_too_long events when an infrastructure incident drops the fleet.
  const massAffected = detectMassDisconnect(state.slots, now);
  const massDisconnect = massAffected.length > 0;
  if (massDisconnect) {
    await logEvent({
      event: 'mass_disconnect',
      affectedSlots: massAffected.map((s) => s.slot),
      slotCount: massAffected.length,
    });
  }

  // Pass 2: apply per-slot health verdicts with fleet context.
  for (const { slot, stateRes, decisionRes } of swept) {
    const verdict = classifyHealth({ state: stateRes, decision: decisionRes, slot, now, massDisconnect });
    if (verdict.unhealthy) {
      await restartSlot(slot, state, verdict.reason, verdict.evidence);
    }
  }

  // Pass 3: spawn quality. Only relevant for slots that have observed a
  // brain-active state and not been flagged yet. The action is ADVISORY —
  // we append to spawn-reseed-candidates.jsonl for human review and never
  // auto-recycle a slot on this signal alone.
  for (const { slot, stateRes } of swept) {
    if (slot.spawnQualityChecked) continue;
    if (slot.brainActiveSince == null) continue;
    const verdict = evaluateSpawnQuality({
      initial: slot.spawnInitialPosition,
      current: stateRes.position,
      ageMs:   now - slot.brainActiveSince,
    });
    if (verdict.reason === 'window_open') continue;
    slot.spawnQualityChecked = true;
    if (!verdict.flag) continue;
    const entry = {
      ts: new Date().toISOString(),
      event: 'spawn_reseed_candidate',
      slot: slot.slot,
      botId: slot.botId,
      testNum: slot.testNum,
      reason: verdict.reason,
      initialPosition: slot.spawnInitialPosition,
      currentPosition: stateRes.position
        ? { x: stateRes.position.x, y: stateRes.position.y, z: stateRes.position.z }
        : null,
      horizontalM: verdict.horizontalM ?? null,
      hint: 'destructive — run `/test-reset slot=N --yes` ONLY after reviewing the slot manually',
    };
    try { await fsp.appendFile(SPAWN_RESEED_FILE, JSON.stringify(entry) + '\n', 'utf8'); }
    catch (e) { await logEvent({ event: 'spawn_reseed_write_failed', slot: slot.slot, error: String(e) }); }
    await logEvent({ event: 'spawn_reseed_candidate', slot: slot.slot, botId: slot.botId, reason: verdict.reason });
  }

  // BUG-009: dashboard-down detection.
  const allFailed = pollAttempts > 0 && pollFailures === pollAttempts;
  state.fleetPollFailStreak = allFailed ? (state.fleetPollFailStreak ?? 0) + 1 : 0;
  const heartbeatAge = await dashboardHeartbeatAgeMs();
  const heartbeatStale = heartbeatAge > HEARTBEAT_STALE_MS;
  if (state.fleetPollFailStreak >= FLEET_POLL_FAIL_THRESH && heartbeatStale) {
    await logEvent({
      event: 'dashboard_down',
      fleetPollFailStreak: state.fleetPollFailStreak,
      heartbeatAgeMs: Number.isFinite(heartbeatAge) ? heartbeatAge : null,
      heartbeatFile: HEARTBEAT_FILE,
      hint: 'restarting watchdog non-zero so the launcher (pm2/systemd/screen) can restart node + the watchdog',
    });
    // Deliberately don't try to spawn node ourselves — let the supervisor do
    // it. Two competing dashboard processes is worse than a brief outage.
    process.exit(2);
  }
  await writeState(state);
}

async function maybeBootMissingServers(state) {
  for (const slot of state.slots) {
    if (slot.javaPid && processAlive(slot.javaPid)) continue;
    await logEvent({ event: 'boot_server', slot: slot.slot, reason: 'pid_missing_or_dead' });
    const { pid, logPath } = await spawnMcServer(slot);
    slot.javaPid = pid;
    const ok = await waitForDone(logPath, SERVER_BOOT_TIMEOUT_MS);
    if (!ok) await logEvent({ event: 'boot_failed', slot: slot.slot, javaPid: pid });
    else await logEvent({ event: 'boot_ready', slot: slot.slot, javaPid: pid });
  }
}

async function ensureBotsConnected(state) {
  for (const slot of state.slots) {
    try {
      const s = await api('GET', `/api/bots/${slot.botId}/state`);
      if (s?.state !== 'connected') {
        await api('POST', `/api/bots/${slot.botId}/connect`);
        slot.connectedAt = Date.now();
        slot.lastSeenConnected = Date.now();
        await logEvent({ event: 'auto_connect', slot: slot.slot, botId: slot.botId, testNum: slot.testNum });
      } else {
        slot.lastSeenConnected = Date.now();
      }
    } catch (e) {
      await logEvent({ event: 'connect_error', slot: slot.slot, error: String(e) });
    }
  }
}

async function main() {
  await fsp.mkdir(NIGHT_DIR, { recursive: true });
  let state = await readState();
  if (!state) {
    // Seed slots from data/overnight/slots.json (populate per host) — users
    // don't share bot IDs across machines. See slots.example.json for the
    // expected shape. Falls back to a 5-slot placeholder layout matching
    // the default 25565..25569 port spread.
    const seedFile = path.join(NIGHT_DIR, 'slots.json');
    let slots;
    try {
      slots = JSON.parse(await fsp.readFile(seedFile, 'utf8')).slots;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      slots = [
        { slot: 1, botId: 'REPLACE_WITH_BOT_ID_1', port: 25565, testNum: 1,  javaPid: null, restartCount: 0 },
        { slot: 2, botId: 'REPLACE_WITH_BOT_ID_2', port: 25566, testNum: 2,  javaPid: null, restartCount: 0 },
        { slot: 3, botId: 'REPLACE_WITH_BOT_ID_3', port: 25567, testNum: 3,  javaPid: null, restartCount: 0 },
        { slot: 4, botId: 'REPLACE_WITH_BOT_ID_4', port: 25568, testNum: 4,  javaPid: null, restartCount: 0 },
        { slot: 5, botId: 'REPLACE_WITH_BOT_ID_5', port: 25569, testNum: 5,  javaPid: null, restartCount: 0 },
      ];
    }
    state = {
      startedAt: new Date().toISOString(),
      nextTestNum: Math.max(...slots.map((s) => s.testNum)) + 1,
      slots,
    };
  }
  // adopt PIDs passed via env (from launcher)
  if (process.env.SLOT_PIDS) {
    const parts = process.env.SLOT_PIDS.split(',').map((s) => parseInt(s, 10));
    for (let i = 0; i < state.slots.length && i < parts.length; i++) {
      if (parts[i] > 0) state.slots[i].javaPid = parts[i];
    }
  }
  await writeState(state);
  await logEvent({ event: 'watchdog_start', state });

  // ensure all 5 servers are up before we start polling
  await maybeBootMissingServers(state);
  // ensure bots are connected
  await ensureBotsConnected(state);
  await writeState(state);
  await logEvent({ event: 'watchdog_ready' });

  // graceful shutdown
  let stopping = false;
  const stop = async (sig) => {
    if (stopping) return;
    stopping = true;
    await logEvent({ event: 'watchdog_stop', signal: sig });
    process.exit(0);
  };
  process.on('SIGINT',  () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  // main loop
  while (true) {
    try { await tick(state); }
    catch (e) { await logEvent({ event: 'tick_error', error: String(e), stack: e.stack?.split('\n').slice(0, 3).join(' | ') }); }
    await delay(POLL_MS);
  }
}

// Only auto-run when invoked as the entrypoint, so tests can import helpers.
const isEntry = import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`
  || import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`;
if (isEntry) {
  main().catch(async (e) => {
    await logEvent({ event: 'watchdog_crash', error: String(e), stack: e.stack });
    process.exit(1);
  });
}

// OVN-002/003/017: exposed for unit tests. Not part of the public surface.
export const __testing = {
  readState, writeState, api,
  decisionSig, trackDecisionHistory, trackPhantomCraft, trackProgressStarvation,
  classifyHealth, skillOk, skillError,
  detectMassDisconnect,
  // Phase B / B2 (Step 2.5):
  evaluateSpawnQuality, observeSpawnPosition,
};
