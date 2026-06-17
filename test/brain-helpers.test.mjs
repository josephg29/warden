// OVN-005/006/008/009: brain skill-picker hardening helpers.
//
// Exercises the pure helpers we extracted from Brain so that the threshold
// logic and pattern matching can be locked down without spinning up a real
// mineflayer instance.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isEarlyTripError, summarizeBlockedActions, alreadyHasWorkingTool } from '../src/bots/brain.js';

// minimal stub mirroring just the bot.inventory.items() shape brain.js uses
function stubBot(items) {
  return { inventory: { items: () => items } };
}

test('OVN-005/009: isEarlyTripError matches "no X in inventory"', () => {
  assert.equal(isEarlyTripError('no crafting_table in inventory'), true);
  assert.equal(isEarlyTripError('no oak_planks in inventory'), true);
  assert.equal(isEarlyTripError('no wooden_pickaxe in inventory'), true);
});

test('OVN-005/009: isEarlyTripError matches "no X within Nm"', () => {
  assert.equal(isEarlyTripError('no crafting_table within 32m'), true);
  assert.equal(isEarlyTripError('no oak_log within 16m'), true);
  assert.equal(isEarlyTripError('no more cobblestone within 32m'), true);
});

test('OVN-005/009: isEarlyTripError matches "no recipe available"', () => {
  assert.equal(isEarlyTripError('craft wooden_pickaxe: no recipe available with current inventory'), true);
});

test('OVN-005/009: isEarlyTripError ignores transient/non-deterministic errors', () => {
  assert.equal(isEarlyTripError('pathfind: timed out'), false);
  assert.equal(isEarlyTripError('dig: tool broke'), false);
  assert.equal(isEarlyTripError('skill ran 45s without resolving — target likely unreachable'), false);
  assert.equal(isEarlyTripError(''), false);
  assert.equal(isEarlyTripError(null), false);
  assert.equal(isEarlyTripError(undefined), false);
});

test('OVN-005/009: summarizeBlockedActions trips on first deterministic failure', () => {
  const failureLog = new Map();
  failureLog.set('place_block:block=crafting_table', [
    { ts: Date.now() - 5000, error: 'no crafting_table in inventory' },
  ]);
  const out = summarizeBlockedActions(failureLog);
  assert.equal(out.length, 1, 'first failure of deterministic error must trip');
  assert.match(out[0], /place_block:block=crafting_table/);
  assert.match(out[0], /no crafting_table in inventory/);
});

test('OVN-005/009: summarizeBlockedActions waits for 2 failures on transient errors', () => {
  const failureLog = new Map();
  failureLog.set('goto_coord:x=10,z=10', [
    { ts: Date.now() - 10000, error: 'pathfind: timed out' },
  ]);
  const out1 = summarizeBlockedActions(failureLog);
  assert.equal(out1.length, 0, 'first transient failure should not block yet');

  failureLog.get('goto_coord:x=10,z=10').push({ ts: Date.now() - 1000, error: 'pathfind: timed out' });
  const out2 = summarizeBlockedActions(failureLog);
  assert.equal(out2.length, 1, 'second transient failure must trip threshold-2');
  assert.match(out2[0], /2x failed/);
});

test('OVN-005/009: summarizeBlockedActions reports last error verbatim', () => {
  const failureLog = new Map();
  failureLog.set('craft:item=wooden_pickaxe', [
    { ts: Date.now() - 5000, error: 'craft wooden_pickaxe: needs crafting_table' },
    { ts: Date.now() - 1000, error: 'craft wooden_pickaxe: no recipe available with current inventory' },
  ]);
  const out = summarizeBlockedActions(failureLog);
  assert.equal(out.length, 1);
  // Last entry is the deterministic one, so the last-error suffix must be the deterministic message
  assert.match(out[0], /no recipe available/);
});

test('OVN-005/009: summarizeBlockedActions skips empty buckets', () => {
  const failureLog = new Map();
  failureLog.set('craft:item=foo', []);
  const out = summarizeBlockedActions(failureLog);
  assert.equal(out.length, 0);
});

test('OVN-012: alreadyHasWorkingTool returns null for non-tools', () => {
  const bot = stubBot([{ name: 'oak_log', count: 4, durabilityUsed: 0, maxDurability: 0 }]);
  assert.equal(alreadyHasWorkingTool(bot, 'oak_log'), null);
  assert.equal(alreadyHasWorkingTool(bot, 'crafting_table'), null);
  assert.equal(alreadyHasWorkingTool(bot, ''), null);
});

test('OVN-012: alreadyHasWorkingTool blocks craft when tool already in inventory', () => {
  const bot = stubBot([{ name: 'wooden_pickaxe', count: 1, durabilityUsed: 10, maxDurability: 60 }]);
  const r = alreadyHasWorkingTool(bot, 'wooden_pickaxe');
  assert.ok(r, 'should block');
  assert.equal(r.count, 1);
  assert.ok(r.ratio > 0.8 && r.ratio <= 1, `ratio ${r.ratio} should be ~0.83`);
});

test('OVN-012: alreadyHasWorkingTool allows craft when tool is nearly broken', () => {
  // 55/60 durability used = 8% remaining, below the 20% threshold.
  const bot = stubBot([{ name: 'wooden_pickaxe', count: 1, durabilityUsed: 55, maxDurability: 60 }]);
  assert.equal(alreadyHasWorkingTool(bot, 'wooden_pickaxe'), null);
});

test('OVN-012: alreadyHasWorkingTool counts duplicates', () => {
  const bot = stubBot([
    { name: 'wooden_pickaxe', count: 1, durabilityUsed: 0, maxDurability: 60 },
    { name: 'wooden_pickaxe', count: 1, durabilityUsed: 50, maxDurability: 60 },
    { name: 'wooden_pickaxe', count: 1, durabilityUsed: 5, maxDurability: 60 },
  ]);
  const r = alreadyHasWorkingTool(bot, 'wooden_pickaxe');
  assert.ok(r);
  assert.equal(r.count, 3);
  // best ratio across the stack — the freshest one (durabilityUsed=0) wins
  assert.equal(r.ratio, 1);
});

test('OVN-012: alreadyHasWorkingTool blocks even when durability data is missing (fail-closed)', () => {
  const bot = stubBot([{ name: 'wooden_sword', count: 1 }]);
  const r = alreadyHasWorkingTool(bot, 'wooden_sword');
  assert.ok(r, 'missing durability should block (treat as fresh)');
  assert.equal(r.count, 1);
  assert.equal(r.ratio, 1);
});

test('OVN-012: alreadyHasWorkingTool returns null on empty inventory', () => {
  assert.equal(alreadyHasWorkingTool(stubBot([]), 'wooden_pickaxe'), null);
  assert.equal(alreadyHasWorkingTool({ inventory: undefined }, 'wooden_pickaxe'), null);
});

test('OVN-005/009: summarizeBlockedActions handles many entries deterministically', () => {
  const failureLog = new Map();
  failureLog.set('a:k=1', [{ ts: 1, error: 'no x in inventory' }]);
  failureLog.set('b:k=2', [{ ts: 1, error: 'pathfind: timed out' }]); // transient, single
  failureLog.set('c:k=3', [
    { ts: 1, error: 'pathfind: timed out' },
    { ts: 2, error: 'pathfind: timed out' },
  ]);
  const out = summarizeBlockedActions(failureLog).sort();
  assert.deepEqual(
    out,
    [
      'a:k=1 → 1x failed (last: no x in inventory)',
      'c:k=3 → 2x failed (last: pathfind: timed out)',
    ].sort(),
  );
});
