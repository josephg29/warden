// Repro test for BUG-001/003/006/012 hard-block enforcement (Session A).
//
// Run with:    node --test test/brain-hardblock.test.mjs
//
// The brain depends on mineflayer / pathfinder / openai for production use, but
// the hard-block layer added by Session A only touches in-memory state and the
// memory hook. We construct a Brain with a minimal stub bot so the constructor
// runs without I/O, then drive the decision-layer helpers directly.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Brain } from '../src/bots/brain.js';

function makeStubBot() {
  // The Brain constructor only reads basic fields off the bot; nothing more is
  // touched until start() is called (which we never call). All we need is for
  // method lookups not to throw and for entity.position to be present.
  return {
    username: 'TestStubBot',
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
  const bot = makeStubBot();
  // memory updates are written via _memory.applyUpdate; we capture them so the
  // test can assert that the BUG-001 set_goal / add_failed payload was sent.
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

test('BUG-001 — _addBlockedSig + _isSigBlocked + _blockedSigsBlock', () => {
  const { brain } = makeBrain();
  const skill = 'craft';
  const args  = { item: 'crafting_table', count: 1 };

  assert.equal(brain._isSigBlocked(skill, args), false, 'fresh brain has no blocked sigs');
  assert.equal(brain._blockedSigsBlock(), '', 'empty block when nothing is blocked');

  brain._addBlockedSig(skill, args, 'missing 4x any plank');

  assert.equal(brain._isSigBlocked(skill, args), true, 'sig is blocked after _addBlockedSig');
  // count knob is in ARGS_IGNORE so different counts collide on the same sig
  assert.equal(brain._isSigBlocked(skill, { item: 'crafting_table', count: 8 }), true,
    'count is ignored by the canonical sig');

  const block = brain._blockedSigsBlock();
  assert.ok(block.startsWith('## BLOCKED THIS TURN'), 'block has the loud header');
  assert.ok(block.includes('craft(item=crafting_table'), 'block names the offending sig');
  assert.ok(block.includes('missing 4x any plank'), 'block carries the last error verbatim');
});

test('BUG-001 — _recentFailures threshold drives hard-block escalation', () => {
  const { brain, memCalls } = makeBrain();
  const skill = 'craft';
  const args  = { item: 'crafting_table', count: 1 };

  // Queue 4 identical failures within the SKILL_FAIL_WINDOW (60s default). The
  // 5th attempt is what the decision layer would evaluate next; we simulate
  // that evaluation by calling the same helpers _think calls inline.
  for (let i = 0; i < 4; i++) {
    brain._recordFailure(skill, args, `attempt ${i + 1} failed`);
  }
  const fails = brain._recentFailures(skill, args);
  assert.equal(fails.length, 4, 'all 4 failures are in window');

  // Mirror the BUG-001 escalation arm in _think — when fails reach
  // SIG_HARDBLOCK_THRESHOLD (3), brain adds the sig to _blockedSigs and
  // forces the action to look_around via _forceLookAround.
  const result = { action: { type: skill, args: { ...args } } };
  assert.ok(fails.length >= 3, 'fails meet hard-block threshold');
  brain._addBlockedSig(skill, args, fails[fails.length - 1].error);
  brain._forceLookAround(result, {
    setGoal:   `BLOCKED: craft(item=crafting_table) failed ${fails.length}x — pick a different objective`,
    addFailed: `craft(item=crafting_table) failed ${fails.length}x in 60s`,
  });

  assert.equal(result.action.type, 'look_around', '5th attempt is forced to look_around');
  assert.deepEqual(result.action.args, { turns: 4 }, 'look_around uses default turns=4');
  assert.equal(brain._isSigBlocked(skill, args), true, 'sig is now in the hard-block list');

  // Memory was told about both the abandonment and the failure
  assert.equal(memCalls.length, 1, 'one memory_update was applied');
  assert.ok(/BLOCKED:/.test(memCalls[0].set_goal),    'set_goal carries the BLOCKED prefix');
  assert.ok(/failed 4x/.test(memCalls[0].add_failed), 'add_failed describes the count');

  // And the prompt-builder hook surfaces it loudly
  assert.ok(brain._blockedSigsBlock().includes('## BLOCKED THIS TURN'));
});

test('BUG-012 — 2-cycle alternation detector', () => {
  const { brain } = makeBrain();
  // Manually populate the ring with strict A-B-A-B alternation, with at least
  // one ok=false entry — mirrors the Test28 goto_block(stone) <-> goto_block(iron_ore) loop.
  const t = Date.now() - 10_000;
  const A = { type: 'goto_block', args: { block: 'stone' },    sig: 'goto_block:block=stone',    key: 'block=stone',    ok: true,  ts: t };
  const B = { type: 'goto_block', args: { block: 'iron_ore' }, sig: 'goto_block:block=iron_ore', key: 'block=iron_ore', ok: false, ts: t + 1 };
  for (let i = 0; i < 8; i++) {
    brain._recentDecisions.push(i % 2 === 0 ? { ...A, ts: t + i } : { ...B, ts: t + i });
  }
  const osc = brain._detectOscillation();
  assert.ok(osc, 'oscillation detected on strict A-B-A-B with ≥1 fail');
  assert.equal(osc.length, 2);
  const labels = osc.map((o) => o.label).sort();
  assert.deepEqual(labels, ['goto_block(block=iron_ore)', 'goto_block(block=stone)']);
});

test('BUG-012 — does NOT fire on AAA-BBB block patterns', () => {
  const { brain } = makeBrain();
  const t = Date.now() - 10_000;
  const A = { type: 'goto_block', args: { block: 'stone' },    sig: 'goto_block:block=stone',    key: 'block=stone',    ok: true,  ts: t };
  const B = { type: 'goto_block', args: { block: 'iron_ore' }, sig: 'goto_block:block=iron_ore', key: 'block=iron_ore', ok: false, ts: t + 1 };
  // 4 of A then 4 of B — same 2 distinct sigs, but no alternation
  for (let i = 0; i < 4; i++) brain._recentDecisions.push({ ...A, ts: t + i });
  for (let i = 0; i < 4; i++) brain._recentDecisions.push({ ...B, ts: t + 4 + i });
  assert.equal(brain._detectOscillation(), null, 'AAA-BBB is not oscillation');
});

test('BUG-003 — completion-blindness needs all-ok + stale goal', () => {
  const { brain } = makeBrain();
  // 5 consecutive successes of the same sig
  const sig = 'goto_coord:x=8,y=31,z=-6';
  const t = Date.now();
  for (let i = 0; i < 5; i++) {
    brain._recentDecisions.push({
      ts: t + i,
      type: 'goto_coord',
      args: { x: 8, y: 31, z: -6 },
      key:  'x=8,y=31,z=-6',
      sig,
      ok: true,
    });
  }
  // goal hasn't been updated → _goalChangedAt was set at construction time;
  // we age it past GOAL_STALE_MS (5min) by rewinding it
  brain._goalChangedAt = Date.now() - (6 * 60 * 1000);

  const label = brain._detectCompletionBlindness(sig);
  assert.equal(label, 'goto_coord(x=8,y=31,z=-6)', 'detector flags the no-op success loop');

  // Same data but with a recent goal change → no detection
  brain._goalChangedAt = Date.now();
  assert.equal(brain._detectCompletionBlindness(sig), null, 'fresh goal change suppresses BUG-003');
});

test('BUG-001 — _blockedSigs honours the 5-minute TTL', () => {
  const { brain } = makeBrain();
  brain._addBlockedSig('craft', { item: 'stick' }, 'no planks');
  assert.equal(brain._isSigBlocked('craft', { item: 'stick' }), true);
  // Force-expire by mutating the entry's `until`
  for (const [, e] of brain._blockedSigs) e.until = Date.now() - 1;
  assert.equal(brain._isSigBlocked('craft', { item: 'stick' }), false, 'expired entries are evicted on read');
  assert.equal(brain._blockedSigsBlock(), '', 'block string is empty after eviction');
});
