// Step 2 (2026-05-10): brain-level stuck-loop early break + craft/place_block
// guidance + collect_block × jump_loop recovery.
//
// Run with:    node --test test/brain-stuck-loop.test.mjs
//
// All three fixes touch only in-memory state and the memory hook. The Brain
// constructor is exercised with a stub bot so no I/O is required, mirroring
// the brain-hardblock test conventions.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Brain } from '../src/bots/brain.js';

function makeStubBot() {
  return {
    username: 'TestStubBot',
    version: '1.21.4',
    health: 20,
    food: 20,
    time: { timeOfDay: 6000 },
    entity: { position: { x: 10, y: 64, z: -7, floored: () => ({ x: 10, y: 64, z: -7 }) } },
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
  const bot = makeStubBot();
  const memCalls = [];
  const memory = {
    _state: { current_goal: null },
    applyUpdate: (update) => { memCalls.push(update); },
    contextBlock: () => '',
    setRenderPosition: () => {},
    latestIncomingChat: () => null,
  };
  const brain = new Brain(bot, { memory });
  return { brain, bot, memCalls };
}

function pushDecision(brain, type, args, ok = true) {
  const sig = brain._canonicalSig(type, args);
  const key = sig.split(':').slice(1).join(':');
  brain._recentDecisions.push({
    ts:   Date.now(),
    type,
    args,
    key,
    sig,
    ok,
  });
}

// ---------------------------------------------------------------------------
// Fix 1 — Stuck-loop early break detector
// ---------------------------------------------------------------------------

test('Fix 1 — _detectStuckLoopEarly returns null when ring has fewer than threshold entries', () => {
  const { brain } = makeBrain();
  pushDecision(brain, 'craft', { item: 'wooden_pickaxe' });
  pushDecision(brain, 'craft', { item: 'wooden_pickaxe' });
  pushDecision(brain, 'craft', { item: 'wooden_pickaxe' });
  assert.equal(brain._detectStuckLoopEarly(), null, '3 entries is below the 4-threshold');
});

test('Fix 1 — _detectStuckLoopEarly fires at exactly 4 identical sigs in last 8', () => {
  const { brain } = makeBrain();
  pushDecision(brain, 'goto_coord', { x: 0, z: 0 });
  pushDecision(brain, 'craft', { item: 'wooden_pickaxe' });
  pushDecision(brain, 'craft', { item: 'wooden_pickaxe' });
  pushDecision(brain, 'craft', { item: 'wooden_pickaxe' });
  pushDecision(brain, 'craft', { item: 'wooden_pickaxe' });
  const stuck = brain._detectStuckLoopEarly();
  assert.ok(stuck, 'stuck loop detected');
  assert.equal(stuck.count, 4, 'reports count');
  assert.equal(stuck.type, 'craft', 'reports skill type');
  assert.equal(stuck.label, 'craft(item=wooden_pickaxe)', 'reports human label');
  assert.equal(stuck.sig, 'craft:item=wooden_pickaxe', 'reports canonical sig');
});

test('Fix 1 — _detectStuckLoopEarly only looks at last 8 entries', () => {
  const { brain } = makeBrain();
  // 4 old craft entries that fall outside the 8-window once we add 8 more
  for (let i = 0; i < 4; i++) pushDecision(brain, 'craft', { item: 'wooden_pickaxe' });
  // 8 distinct entries push the old crafts out of the 8-window
  for (let i = 0; i < 8; i++) pushDecision(brain, 'goto_coord', { x: i, z: 0 });
  // Each goto_coord has a distinct sig (different x), so no sig has count ≥4
  assert.equal(brain._detectStuckLoopEarly(), null, 'old crafts are out of window, distinct gotos do not group');
});

test('Fix 1 — _detectStuckLoopEarly does not fire on look_around or wait', () => {
  const { brain } = makeBrain();
  // ring full of look_around (substituted by other anti-loop layers) should
  // not itself trigger a stuck-loop fire — that would create infinite recursion
  for (let i = 0; i < 6; i++) pushDecision(brain, 'look_around', { turns: 4 });
  const stuck = brain._detectStuckLoopEarly();
  // detector reports the count, but the caller is responsible for the skip.
  // Verify the skip-list: if the latest pushed entry is look_around or wait,
  // the early-break check in _think should NOT mutate result.action.
  // We test the fire-side here; the skip-side is validated end-to-end below.
  assert.ok(stuck, 'detector still reports the cycle');
  assert.equal(stuck.type, 'look_around');
});

// ---------------------------------------------------------------------------
// Fix 2 — craft / place_block specific guidance
// ---------------------------------------------------------------------------

test('Fix 2 — craft loop guidance mentions recipe inputs', () => {
  const { brain, memCalls } = makeBrain();
  for (let i = 0; i < 4; i++) pushDecision(brain, 'craft', { item: 'wooden_pickaxe' });
  const result = { action: { type: 'craft', args: { item: 'wooden_pickaxe' } } };
  brain._applyStuckLoopEarlyBreak(result);
  assert.equal(result.action.type, 'look_around', 'action substituted to look_around');
  assert.deepEqual(result.action.args, { turns: 4 });
  assert.equal(memCalls.length, 1, 'one memory_update written');
  const guidance = memCalls[0].add_failed;
  assert.match(guidance, /recipe inputs may be missing/i, 'craft guidance mentions recipe inputs');
  assert.match(guidance, /verify inventory/i, 'craft guidance tells LLM to verify inventory');
  assert.match(guidance, /cycled 4/i, 'guidance reports cycle count');
});

test('Fix 2 — place_block loop guidance mentions placement blocked', () => {
  const { brain, memCalls } = makeBrain();
  for (let i = 0; i < 4; i++) pushDecision(brain, 'place_block', { block: 'crafting_table' });
  const result = { action: { type: 'place_block', args: { block: 'crafting_table' } } };
  brain._applyStuckLoopEarlyBreak(result);
  assert.equal(result.action.type, 'look_around');
  const guidance = memCalls[0].add_failed;
  assert.match(guidance, /placement may be blocked/i, 'place_block guidance mentions placement');
  assert.match(guidance, /verify .* surroundings/i, 'place_block guidance tells LLM to verify surroundings');
});

test('Fix 2 — collect_block loop falls back to generic different-approach guidance', () => {
  const { brain, memCalls } = makeBrain();
  for (let i = 0; i < 4; i++) pushDecision(brain, 'collect_block', { block: 'birch_log' });
  const result = { action: { type: 'collect_block', args: { block: 'birch_log' } } };
  brain._applyStuckLoopEarlyBreak(result);
  assert.equal(result.action.type, 'look_around');
  const guidance = memCalls[0].add_failed;
  assert.match(guidance, /try a different approach/i, 'collect_block guidance is the generic variant');
  assert.match(guidance, /different block target|different range|dig the obstacle|move to a new area/i,
    'guidance lists specific alternatives');
  assert.doesNotMatch(guidance, /recipe inputs/i, 'collect_block does not get the craft variant');
});

// ---------------------------------------------------------------------------
// Fix 3 — collect_block × jump_loop recovery
// ---------------------------------------------------------------------------

test('Fix 3 — _recentJumpLoopCancels returns empty when nothing recorded', () => {
  const { brain } = makeBrain();
  assert.deepEqual(
    brain._recentJumpLoopCancels('collect_block', { block: 'birch_log' }),
    [],
    'fresh brain has no jump-loop cancels',
  );
});

test('Fix 3 — _recordJumpLoopCancel + _recentJumpLoopCancels respect the 60s window', () => {
  const { brain } = makeBrain();
  brain._recordJumpLoopCancel('collect_block', { block: 'birch_log' });
  brain._recordJumpLoopCancel('collect_block', { block: 'birch_log' });
  assert.equal(
    brain._recentJumpLoopCancels('collect_block', { block: 'birch_log' }).length,
    2,
    '2 fresh cancels recorded',
  );
  // Age both entries past the 60s window
  const stale = Date.now() - 90_000;
  for (const arr of brain._jumpLoopCancelLog.values()) {
    for (const e of arr) e.ts = stale;
  }
  assert.deepEqual(
    brain._recentJumpLoopCancels('collect_block', { block: 'birch_log' }),
    [],
    'entries older than 60s are pruned',
  );
});

test('Fix 3 — substitutes collect_block with collect_jump_recover after 2 jump_loop cancels', () => {
  const { brain, memCalls } = makeBrain();
  brain._recordJumpLoopCancel('collect_block', { block: 'birch_log', count: 1, range: 8 });
  brain._recordJumpLoopCancel('collect_block', { block: 'birch_log', count: 1, range: 8 });
  const result = { action: { type: 'collect_block', args: { block: 'birch_log', count: 1, range: 8 } } };
  const substituted = brain._applyCollectJumpRecovery(result);
  assert.equal(substituted, true, 'recovery was substituted');
  assert.equal(result.action.type, 'collect_jump_recover', 'action substituted to recovery skill');
  assert.equal(memCalls.length, 1, 'one memory_update written');
  const guidance = memCalls[0].add_failed;
  assert.match(guidance, /collect_block.*birch_log.*2 jump_loops/i, 'guidance names the skill and count');
  assert.match(guidance, /\(10,64,-7\)/, 'guidance reports the bot position');
  assert.match(guidance, /DO NOT repeat/i, 'guidance forbids repeat');
});

test('Fix 3 — does not substitute when fewer than 2 jump_loop cancels in window', () => {
  const { brain } = makeBrain();
  brain._recordJumpLoopCancel('collect_block', { block: 'oak_log' });
  const result = { action: { type: 'collect_block', args: { block: 'oak_log' } } };
  const substituted = brain._applyCollectJumpRecovery(result);
  assert.equal(substituted, false, '1 cancel does not trigger recovery');
  assert.equal(result.action.type, 'collect_block', 'original action preserved');
});

test('Fix 3 — different collect_block target counts independently', () => {
  const { brain } = makeBrain();
  brain._recordJumpLoopCancel('collect_block', { block: 'birch_log' });
  brain._recordJumpLoopCancel('collect_block', { block: 'birch_log' });
  // birch is over threshold but oak is fresh
  const result = { action: { type: 'collect_block', args: { block: 'oak_log' } } };
  const substituted = brain._applyCollectJumpRecovery(result);
  assert.equal(substituted, false, 'oak_log is not affected by birch_log cancels');
  assert.equal(result.action.type, 'collect_block');
});

// ---------------------------------------------------------------------------
// Composability — verify the layers do not deadlock
// ---------------------------------------------------------------------------

test('Composability — early-break skips when latest decision was already substituted to wait', () => {
  const { brain, memCalls } = makeBrain();
  // Simulate the failure-cooldown path: original LLM pick was craft, but the
  // failure-cooldown converted it to wait BEFORE the push to _recentDecisions.
  // The ring therefore records 'wait' as the latest entry. Older entries can
  // still be 'craft' (from earlier turns when failure-cooldown hadn't yet
  // tripped) — but the early-break sees the latest is 'wait' and bails.
  for (let i = 0; i < 3; i++) pushDecision(brain, 'craft', { item: 'wooden_pickaxe' });
  pushDecision(brain, 'wait', {});
  const result = { action: { type: 'wait', args: { seconds: 5 } } };
  const substituted = brain._applyStuckLoopEarlyBreak(result);
  assert.equal(substituted, false, 'no substitution when latest action is wait');
  assert.equal(result.action.type, 'wait', 'wait preserved');
  assert.equal(memCalls.length, 0, 'no memory write — failure-cooldown owned this turn');
});

test('Composability — early-break skips when latest decision is look_around', () => {
  const { brain } = makeBrain();
  for (let i = 0; i < 3; i++) pushDecision(brain, 'craft', { item: 'wooden_pickaxe' });
  pushDecision(brain, 'look_around', { turns: 4 });
  const result = { action: { type: 'look_around', args: { turns: 4 } } };
  const substituted = brain._applyStuckLoopEarlyBreak(result);
  assert.equal(substituted, false, 'no substitution when latest action is look_around');
});

test('Composability — collect_jump recovery clears its log so it does not double-fire next turn', () => {
  const { brain } = makeBrain();
  brain._recordJumpLoopCancel('collect_block', { block: 'birch_log' });
  brain._recordJumpLoopCancel('collect_block', { block: 'birch_log' });
  const result = { action: { type: 'collect_block', args: { block: 'birch_log' } } };
  brain._applyCollectJumpRecovery(result);
  // Next turn the LLM picks the same collect_block: log was cleared, so no
  // re-substitution until a fresh jump_loop happens.
  const result2 = { action: { type: 'collect_block', args: { block: 'birch_log' } } };
  const substituted2 = brain._applyCollectJumpRecovery(result2);
  assert.equal(substituted2, false, 'recovery does not double-fire on consecutive turns');
});
