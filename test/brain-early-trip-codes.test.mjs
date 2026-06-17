// 2026-05-12 follow-up to Step 2.5: isEarlyTripError now accepts a structured
// error_code so deterministic skill failures (notably craft_succeeded_but_item_missing)
// trip the failure cooldown at threshold 1 instead of 2. Tests cover the code
// path plus backward-compat with the existing regex list, plus the
// _isBlockedSkill / _recordFailure plumbing.
//
// Run with:  node --test test/brain-early-trip-codes.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  Brain,
  isEarlyTripError,
  summarizeBlockedActions,
} from '../src/bots/brain.js';

// ---------------------------------------------------------------------------
// Pure helper: isEarlyTripError
// ---------------------------------------------------------------------------

test('isEarlyTripError — null inputs return false', () => {
  assert.equal(isEarlyTripError(null), false);
  assert.equal(isEarlyTripError(undefined, undefined), false);
  assert.equal(isEarlyTripError('', null), false);
});

test('isEarlyTripError — backward compat: regex match on error text still works', () => {
  assert.equal(isEarlyTripError('no oak_log in inventory'), true);
  assert.equal(isEarlyTripError('no birch_log within 32m'), true);
  assert.equal(isEarlyTripError('craft wooden_pickaxe: no recipe available'), true);
});

test('isEarlyTripError — error_code path matches EARLY_TRIP_CODES', () => {
  // text alone wouldn't match any regex, but the code does
  const phantomText = 'craft wooden_pickaxe: server reported success but wooden_pickaxe never landed in inventory (output dropped on ground)';
  assert.equal(isEarlyTripError(phantomText), false, 'text alone is not a match');
  assert.equal(
    isEarlyTripError(phantomText, 'craft_succeeded_but_item_missing'),
    true,
    'error_code trips the early-trip detection',
  );
});

test('isEarlyTripError — recognizes all current deterministic codes', () => {
  const codes = [
    'craft_succeeded_but_item_missing',
    'no_valid_surface',
    'already_have_tool',
    'missing_prereqs',
    'unknown_block',
    'no_block_in_inventory',
  ];
  for (const c of codes) {
    assert.equal(isEarlyTripError('some text', c), true, `code ${c} should be early-trip`);
  }
});

test('isEarlyTripError — explicitly does NOT trip out_of_range (A4 handles it)', () => {
  assert.equal(
    isEarlyTripError('out of use-range (12m > 4.5m)', 'out_of_range'),
    false,
    'out_of_range must NOT be deterministic — A4 auto-recovery is the only path',
  );
});

test('isEarlyTripError — explicitly does NOT trip transient codes', () => {
  for (const c of ['equip_failed', 'no_target', 'pathfind_failed', 'activate_failed']) {
    assert.equal(isEarlyTripError('some text', c), false, `code ${c} must stay transient`);
  }
});

test('isEarlyTripError — unknown error_code falls through to regex', () => {
  assert.equal(isEarlyTripError('no oak_log in inventory', 'bogus_code'), true);
  assert.equal(isEarlyTripError('transient failure', 'bogus_code'), false);
});

// ---------------------------------------------------------------------------
// summarizeBlockedActions — threshold drops to 1 when last failure has a code
// ---------------------------------------------------------------------------

test('summarizeBlockedActions — single failure with deterministic code appears in summary', () => {
  const log = new Map();
  log.set('craft:item=wooden_pickaxe', [
    {
      ts: Date.now(),
      error: 'craft wooden_pickaxe: server reported success but never landed',
      errorCode: 'craft_succeeded_but_item_missing',
    },
  ]);
  const summary = summarizeBlockedActions(log);
  assert.equal(summary.length, 1, 'one entry should trip the threshold-1 path');
  assert.match(summary[0], /craft:item=wooden_pickaxe/);
});

test('summarizeBlockedActions — single failure with no code does NOT appear (threshold 2)', () => {
  const log = new Map();
  log.set('use_block:block=crafting_table', [
    {
      ts: Date.now(),
      error: 'transient network blip',
      errorCode: null,
    },
  ]);
  assert.deepEqual(summarizeBlockedActions(log), []);
});

// ---------------------------------------------------------------------------
// Brain._recordFailure + _isBlockedSkill — end-to-end
// ---------------------------------------------------------------------------

function makeStubBot() {
  return {
    username: 'TestEarlyTrip',
    version: '1.21.4',
    health: 20,
    food: 20,
    time: { timeOfDay: 6000 },
    entity: { position: { x: 0, y: 64, z: 0, floored: () => ({ x: 0, y: 64, z: 0 }) } },
    entities: {},
    inventory: { slots: {}, items: () => [] },
    findBlock: () => null,
    blockAt: () => null,
    chat: () => {},
    on: () => {},
    once: () => {},
    removeListener: () => {},
  };
}

function makeBrain() {
  const memory = {
    _state: { current_goal: null },
    applyUpdate: () => {},
    contextBlock: () => '',
    setRenderPosition: () => {},
    latestIncomingChat: () => null,
  };
  return new Brain(makeStubBot(), { memory });
}

test('_recordFailure — persists errorCode on the log entry', () => {
  const brain = makeBrain();
  brain._recordFailure('craft', { item: 'wooden_pickaxe' }, 'phantom!', 'craft_succeeded_but_item_missing');
  const fails = brain._recentFailures('craft', { item: 'wooden_pickaxe' });
  assert.equal(fails.length, 1);
  assert.equal(fails[0].errorCode, 'craft_succeeded_but_item_missing');
});

test('_recordFailure — defaults errorCode to null when omitted (backward compat)', () => {
  const brain = makeBrain();
  brain._recordFailure('use_block', { block: 'crafting_table' }, 'oor');
  const fails = brain._recentFailures('use_block', { block: 'crafting_table' });
  assert.equal(fails[0].errorCode, null);
});

test('_isBlockedSkill — 1 deterministic-code failure blocks at threshold 1', () => {
  const brain = makeBrain();
  brain._recordFailure('craft', { item: 'wooden_pickaxe' }, 'phantom!', 'craft_succeeded_but_item_missing');
  const blocked = brain._isBlockedSkill('craft', { item: 'wooden_pickaxe' });
  assert.ok(blocked, 'should block after 1 failure when error_code is deterministic');
  assert.equal(blocked.earlyTrip, true);
});

test('_isBlockedSkill — 1 transient failure does NOT block (still needs threshold 2)', () => {
  const brain = makeBrain();
  brain._recordFailure('use_block', { block: 'crafting_table' }, 'transient', 'activate_failed');
  const blocked = brain._isBlockedSkill('use_block', { block: 'crafting_table' });
  assert.equal(blocked, null, 'must not block transient failures at 1');
});

test('_isBlockedSkill — 2 transient failures DO block (threshold 2 path)', () => {
  const brain = makeBrain();
  brain._recordFailure('use_block', { block: 'crafting_table' }, 'transient1', 'activate_failed');
  brain._recordFailure('use_block', { block: 'crafting_table' }, 'transient2', 'activate_failed');
  const blocked = brain._isBlockedSkill('use_block', { block: 'crafting_table' });
  assert.ok(blocked, 'must block after 2 transient failures');
  assert.equal(blocked.earlyTrip, false);
});

// ---------------------------------------------------------------------------
// 2026-05-13 hardblock-escalation slice — early-trip promotes to hardblock
// after 1 fail instead of waiting for SIG_HARDBLOCK_THRESHOLD=3.
//
// Validates the chain: _recordFailure(code) → _isBlockedSkill(earlyTrip=true)
// → manual _addBlockedSig (as brain.js:962 now does on earlyTrip) →
// _isSigBlocked observes the block. This is the BUG-001 root-cause fix
// motivated by the 2026-05-13 rerun where two bots looped craft x10 despite
// the cooldown banner firing.
// ---------------------------------------------------------------------------

test('hardblock — 1 deterministic failure escalates immediately (BUG-001 fix)', () => {
  const brain = makeBrain();
  brain._recordFailure('craft', { item: 'wooden_pickaxe' }, 'phantom!', 'craft_succeeded_but_item_missing');

  const blocked = brain._isBlockedSkill('craft', { item: 'wooden_pickaxe' });
  assert.ok(blocked, 'cooldown trips at threshold 1');
  assert.equal(blocked.earlyTrip, true);

  // brain.js:962 condition: `(blocked.earlyTrip || blocked.fails.length >= 3)`
  // earlyTrip path is the new behavior — 1 fail is enough to hardblock.
  assert.equal(blocked.fails.length, 1);

  brain._addBlockedSig('craft', { item: 'wooden_pickaxe' }, blocked.lastError);
  assert.equal(brain._isSigBlocked('craft', { item: 'wooden_pickaxe' }), true,
    'sig is hardblocked after the escalation slice runs');
});

test('hardblock — 1 transient failure does NOT escalate (threshold 2 still applies)', () => {
  const brain = makeBrain();
  brain._recordFailure('use_block', { block: 'crafting_table' }, 'transient', 'activate_failed');
  const blocked = brain._isBlockedSkill('use_block', { block: 'crafting_table' });
  assert.equal(blocked, null, 'transient cooldown still needs 2 fails');
  assert.equal(brain._isSigBlocked('use_block', { block: 'crafting_table' }), false,
    'no sig hardblock without crossing threshold');
});

test('hardblock — _blockedSigsBlock banner names the early-trip sig', () => {
  const brain = makeBrain();
  brain._recordFailure('craft', { item: 'wooden_pickaxe' }, 'no recipe — missing 2x stick', 'missing_prereqs');
  const blocked = brain._isBlockedSkill('craft', { item: 'wooden_pickaxe' });
  assert.equal(blocked.earlyTrip, true);
  brain._addBlockedSig('craft', { item: 'wooden_pickaxe' }, blocked.lastError);
  const banner = brain._blockedSigsBlock();
  assert.match(banner, /BLOCKED THIS TURN/);
  assert.match(banner, /craft/);
  assert.match(banner, /wooden_pickaxe/);
});
