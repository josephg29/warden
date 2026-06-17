// Tests for the dev-mode _think exit invariant + the ungated brain watchdog
// (Session B follow-up to OVN-018).
//
// Run with:    node --test test/brain-watchdog-invariant.test.mjs
//
// Both pieces are tested through pure helpers extracted from Brain so we can
// inject `now` and other state without spinning up timers / mineflayer.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  Brain,
  watchdogDecision,
  thinkExitInvariantHolds,
  __testing,
} from '../src/bots/brain.js';

const NO_DEC_MS    = 180_000;  // BRAIN_NO_DECISION_TIMEOUT_MS
const WATCHDOG_MS  = 120_000;  // BRAIN_WATCHDOG_MS (existing)
const COLD_GRACE_MS = 60_000;  // BRAIN_COLD_START_GRACE_MS

const NOW = 1_700_000_000_000;

function commonInputs(overrides = {}) {
  return {
    now:             NOW,
    running:         true,
    thinking:        false,
    thinkStartedAt:  0,
    lastTickOkAt:    NOW - 1_000,
    lastDecisionTs:  0,
    brainStartedAt:  NOW - 5 * 60_000,    // 5min uptime, well past cold-start grace
    currentSkill:    null,
    idleTimer:       null,
    pendingThink:    null,
    thinkWatchdogMs: WATCHDOG_MS,
    noDecisionMs:    NO_DEC_MS,
    coldStartMs:     COLD_GRACE_MS,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// watchdogDecision — ungated 180s no-decision guard
// ---------------------------------------------------------------------------

test('watchdog: fires no_decision when lastDecisionAge > 180s and no scheduled think', () => {
  const out = watchdogDecision(commonInputs({
    lastDecisionTs: NOW - 200_000,
    lastTickOkAt:   NOW - 5_000, // recent tick — idle stall would NOT fire
  }));
  assert.equal(out?.kind, 'no_decision', 'no_decision kind');
  assert.equal(out?.reason, 'brain_watchdog_no_decision');
  assert.ok(out.ageMs >= 200_000, 'reports decision age');
});

test('watchdog: fires no_decision regardless of _thinking', () => {
  // _thinking is true but the in-flight think hasn't recorded a decision in 200s
  // and nothing else is scheduled — the original gated watchdog would NOT fire
  // (think_started 50s ago is below the 120s wedge threshold).
  const out = watchdogDecision(commonInputs({
    thinking:       true,
    thinkStartedAt: NOW - 50_000,
    lastDecisionTs: NOW - 200_000,
    lastTickOkAt:   NOW - 5_000,
  }));
  assert.equal(out?.kind, 'no_decision', 'fires even when thinking=true');
});

test('watchdog: cold-start grace prevents firing within 60s of brain start', () => {
  const out = watchdogDecision(commonInputs({
    brainStartedAt: NOW - 30_000,           // 30s into brain — within grace
    lastDecisionTs: NOW - 200_000,           // would otherwise be no_decision
    lastTickOkAt:   NOW - 200_000,
  }));
  assert.equal(out, null, 'no fire during cold-start grace');
});

test('watchdog: cold-start grace expires after 60s and watchdog resumes', () => {
  const out = watchdogDecision(commonInputs({
    brainStartedAt: NOW - 70_000,           // 70s — past 60s grace
    lastDecisionTs: NOW - 200_000,
    lastTickOkAt:   NOW - 5_000,
  }));
  assert.equal(out?.kind, 'no_decision', 'fires once grace expires');
});

test('watchdog: does NOT fire no_decision when _idleTimer is set', () => {
  const out = watchdogDecision(commonInputs({
    lastDecisionTs: NOW - 200_000,
    idleTimer:      { _id: 'fake' },        // truthy ⇒ think is scheduled
    lastTickOkAt:   NOW - 5_000,
  }));
  assert.equal(out, null, 'idleTimer counts as scheduled think');
});

test('watchdog: does NOT fire no_decision when _currentSkill is set', () => {
  const out = watchdogDecision(commonInputs({
    lastDecisionTs: NOW - 200_000,
    currentSkill:   { name: 'collect_block' },
    lastTickOkAt:   NOW - 5_000,
  }));
  assert.equal(out, null, 'currentSkill counts as scheduled think (completion re-arms)');
});

test('watchdog: does NOT fire no_decision when _pendingThink is queued', () => {
  const out = watchdogDecision(commonInputs({
    lastDecisionTs: NOW - 200_000,
    pendingThink:   { reason: 'damage', priority: 100 },
    lastTickOkAt:   NOW - 5_000,
  }));
  assert.equal(out, null, 'pendingThink counts as scheduled think');
});

test('watchdog: existing wedged_thinking still fires when think wedged > 120s', () => {
  const out = watchdogDecision(commonInputs({
    thinking:       true,
    thinkStartedAt: NOW - 130_000,   // wedged
    lastTickOkAt:   NOW - 130_000,
    lastDecisionTs: 0,                // never recorded — no_decision skipped
  }));
  assert.equal(out?.kind, 'wedged_thinking', 'pre-existing wedged check still works');
});

test('watchdog: existing idle_stall still fires after 120s idle with no skill', () => {
  const out = watchdogDecision(commonInputs({
    thinking:       false,
    currentSkill:   null,
    lastTickOkAt:   NOW - 130_000,
    lastDecisionTs: 0,
  }));
  assert.equal(out?.kind, 'idle_stall', 'pre-existing idle_stall check still works');
});

test('watchdog: returns null when running=false', () => {
  const out = watchdogDecision(commonInputs({
    running:        false,
    lastDecisionTs: NOW - 200_000,
  }));
  assert.equal(out, null);
});

test('watchdog: returns null when nothing is wrong', () => {
  const out = watchdogDecision(commonInputs({
    lastDecisionTs: NOW - 5_000, // recent decision
  }));
  assert.equal(out, null);
});

test('watchdog: at exactly 180s no fire (boundary), at 181s fires', () => {
  const just = watchdogDecision(commonInputs({
    lastDecisionTs: NOW - NO_DEC_MS,            // exactly 180s
    lastTickOkAt:   NOW - 5_000,
  }));
  assert.equal(just, null, 'boundary: no fire at exactly 180s');

  const past = watchdogDecision(commonInputs({
    lastDecisionTs: NOW - NO_DEC_MS - 1_000,    // 181s
    lastTickOkAt:   NOW - 5_000,
  }));
  assert.equal(past?.kind, 'no_decision', 'past boundary: fires');
});

// ---------------------------------------------------------------------------
// thinkExitInvariantHolds — silent-exit detection
// ---------------------------------------------------------------------------

test('invariant: holds when _idleTimer is set', () => {
  assert.equal(thinkExitInvariantHolds({
    idleTimer:    { _id: 'fake' },
    currentSkill: null,
    pendingThink: null,
    brainStatus:  'active',
    reason:       null,
  }), true);
});

test('invariant: holds when _currentSkill is set', () => {
  assert.equal(thinkExitInvariantHolds({
    idleTimer:    null,
    currentSkill: { name: 'goto_block' },
    pendingThink: null,
    brainStatus:  'active',
    reason:       null,
  }), true);
});

test('invariant: holds when _pendingThink is queued', () => {
  assert.equal(thinkExitInvariantHolds({
    idleTimer:    null,
    currentSkill: null,
    pendingThink: { reason: 'damage', priority: 100 },
    brainStatus:  'active',
    reason:       null,
  }), true);
});

test('invariant: holds when brainStatus is non-active and reason populated', () => {
  assert.equal(thinkExitInvariantHolds({
    idleTimer:    null,
    currentSkill: null,
    pendingThink: null,
    brainStatus:  'stopped',
    reason:       'brain stopped via stop()',
  }), true);
});

test('invariant: FAILS when nothing scheduled and brainStatus is active', () => {
  assert.equal(thinkExitInvariantHolds({
    idleTimer:    null,
    currentSkill: null,
    pendingThink: null,
    brainStatus:  'active',
    reason:       'idle',
  }), false, 'silent exit detected — no schedule, no inactive status');
});

test('invariant: FAILS when brainStatus non-active but reason is empty', () => {
  assert.equal(thinkExitInvariantHolds({
    idleTimer:    null,
    currentSkill: null,
    pendingThink: null,
    brainStatus:  'stopped',
    reason:       '',
  }), false, 'reason must be non-empty string');
  assert.equal(thinkExitInvariantHolds({
    idleTimer:    null,
    currentSkill: null,
    pendingThink: null,
    brainStatus:  'stopped',
    reason:       null,
  }), false, 'reason=null is not allowed');
});

// ---------------------------------------------------------------------------
// Brain integration — verify the assertion is wired into _think's finally
// ---------------------------------------------------------------------------

function makeStubBot() {
  return {
    username: 'TestStubBot',
    version:  '1.21.4',
    health:   20,
    food:     20,
    time:     { timeOfDay: 6000 },
    entity:   { position: { x: 0, y: 64, z: 0, floored: () => ({ x: 0, y: 64, z: 0 }) } },
    entities: {},
    inventory: { slots: {}, items: () => [] },
    findBlock: () => null,
    blockAt:   () => null,
    chat:      () => {},
    on:        () => {},
    once:      () => {},
    removeListener: () => {},
  };
}

test('Brain: _checkThinkExitInvariant records violation when state is bad', () => {
  const brain = new Brain(makeStubBot(), {});
  // Force the bad state: nothing scheduled, brainStatus default 'active'.
  brain._idleTimer    = null;
  brain._currentSkill = null;
  brain._pendingThink = null;
  brain._brainStatus       = 'active';
  brain._brainStatusReason = null;

  brain._checkThinkExitInvariant('idle');
  assert.ok(brain._lastInvariantViolation, 'violation recorded');
  assert.equal(brain._lastInvariantViolation.thinkReason, 'idle');
});

test('Brain: _checkThinkExitInvariant clears violation when state is good (idle scheduled)', () => {
  const brain = new Brain(makeStubBot(), {});
  brain._lastInvariantViolation = { ts: Date.now(), thinkReason: 'old', msg: 'previous' };
  brain._idleTimer = setTimeout(() => {}, 0);  // simulate scheduled think
  brain._brainStatus = 'active';

  brain._checkThinkExitInvariant('idle');
  assert.equal(brain._lastInvariantViolation, null, 'violation cleared');

  clearTimeout(brain._idleTimer);
  brain._idleTimer = null;
});

test('Brain: stop() flips _brainStatus to stopped with a reason', () => {
  const brain = new Brain(makeStubBot(), {});
  brain._running = true; // pretend we started
  brain.stop();
  assert.equal(brain._brainStatus, 'stopped');
  assert.ok(typeof brain._brainStatusReason === 'string' && brain._brainStatusReason.length > 0,
    'reason populated on stop()');
});

// ---------------------------------------------------------------------------
// watchdog wiring — lastBrainError population on trip
// ---------------------------------------------------------------------------

test('watchdogDecision-no-decision-trip-populates-lastBrainError', () => {
  const brain = new Brain(makeStubBot(), {});
  brain._running       = true;
  brain._brainStartedAt = Date.now() - 5 * 60_000;   // 5 min uptime — past cold-start
  brain.lastDecision   = { ts: Date.now() - 240_000 }; // 4 min old > 180s threshold
  brain._thinking      = false;
  brain._idleTimer     = null;
  brain._currentSkill  = null;
  brain._pendingThink  = null;
  brain._lastTickOkAt  = Date.now() - 1_000;          // recent tick so idle_stall won't preempt

  brain._tickWatchdog();
  brain.stop(); // cancel the setTimeout _scheduleThink queued

  assert.ok(brain.lastError, 'lastError must be set after watchdog trip');
  assert.equal(brain.lastError.status, 'watchdog');
  assert.equal(brain.lastError.message, 'watchdog:brain_watchdog_no_decision');
  assert.ok(typeof brain.lastError.ts === 'number', 'ts must be a number');
});

test('watchdogDecision-wedged-trip-populates-lastBrainError', () => {
  const brain = new Brain(makeStubBot(), {});
  brain._running       = true;
  brain._brainStartedAt = Date.now() - 5 * 60_000;
  brain.lastDecision   = null;                        // never decided — no_decision skipped (ts===0)
  brain._thinking      = true;
  brain._thinkStartedAt = Date.now() - 130_000;       // 130s > 120s threshold → wedged_thinking
  brain._idleTimer     = null;
  brain._currentSkill  = null;
  brain._pendingThink  = null;
  brain._lastTickOkAt  = Date.now() - 130_000;

  brain._tickWatchdog();
  brain.stop();

  assert.ok(brain.lastError, 'lastError must be set after watchdog trip');
  assert.equal(brain.lastError.status, 'watchdog');
  assert.equal(brain.lastError.message, 'watchdog:brain_watchdog');
  assert.ok(typeof brain.lastError.ts === 'number', 'ts must be a number');
});

// ---------------------------------------------------------------------------
// bucket-wait logging — >500ms wait emits info line
// ---------------------------------------------------------------------------

test('bucket-wait-over-500ms-logs', async () => {
  const origConsume = __testing.fleetBucket.consume.bind(__testing.fleetBucket);
  __testing.fleetBucket.consume = async () => {
    await new Promise((r) => setTimeout(r, 600));
  };

  const logged = [];
  const origInfo = console.info;
  console.info = (...args) => { logged.push(args.join(' ')); };

  try {
    const brain = new Brain(makeStubBot(), {});
    await brain._callLLM('dummy observation');
  } finally {
    __testing.fleetBucket.consume = origConsume;
    console.info = origInfo;
  }

  assert.ok(
    logged.some((msg) => msg.startsWith('fleet-bucket-wait:') && msg.includes('bot=TestStubBot')),
    `expected fleet-bucket-wait log line; got: ${JSON.stringify(logged)}`,
  );
});
