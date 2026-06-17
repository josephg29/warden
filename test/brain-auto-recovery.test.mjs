// Phase A4 (Step 2.5+, 2026-05-12): auto-execute the `recovery` hint that
// failing skills can attach to their outcome (currently only use_block's
// out_of_range path). Tests cover the substitution branch, the single-step
// cap, malformed-recovery rejection, and the success/no-recovery passthrough.
//
// Run with:  node --test test/brain-auto-recovery.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Brain } from '../src/bots/brain.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeStubBot() {
  return {
    username: 'TestAutoRecovery',
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
  const memCalls = [];
  const memory = {
    _state: { current_goal: null },
    applyUpdate: (update) => { memCalls.push(update); },
    contextBlock: () => '',
    setRenderPosition: () => {},
    latestIncomingChat: () => null,
  };
  const brain = new Brain(bot, { memory });

  const startCalls = [];
  brain._startSkill = (action) => { startCalls.push(action); };

  const thinkCalls = [];
  brain._scheduleThink = (reason) => { thinkCalls.push(reason); };
  brain._scheduleIdleTimer = () => {};

  return { brain, bot, memCalls, startCalls, thinkCalls };
}

function makeRunningSkill(name = 'use_block', args = { block: 'crafting_table' }) {
  return { name, args, abort: () => {}, startedAt: Date.now() };
}

// ---------------------------------------------------------------------------
// Recovery substitution — happy path
// ---------------------------------------------------------------------------

test('A4 — _onSkillDone with valid recovery starts the recovery skill', () => {
  const { brain, startCalls } = makeBrain();
  const skill = makeRunningSkill();
  brain._currentSkill = skill;

  brain._onSkillDone(skill, {
    ok: false,
    error_code: 'out_of_range',
    error: 'use_block crafting_table: out of use-range',
    recovery: { skill: 'goto_coord', args: { x: 5, y: 64, z: 0 } },
  });

  assert.equal(startCalls.length, 1, 'recovery skill was started');
  assert.equal(startCalls[0].type, 'goto_coord');
  assert.deepEqual(startCalls[0].args, { x: 5, y: 64, z: 0 });
});

test('A4 — _onSkillDone does NOT schedule a think when substituting recovery', () => {
  const { brain, thinkCalls } = makeBrain();
  const skill = makeRunningSkill();
  brain._currentSkill = skill;

  brain._onSkillDone(skill, {
    ok: false,
    error_code: 'out_of_range',
    error: 'oor',
    recovery: { skill: 'goto_coord', args: { x: 5, y: 64, z: 0 } },
  });

  assert.equal(thinkCalls.length, 0, 'must NOT schedule think on substitution');
});

test('A4 — _onSkillDone records add_failed memory entry on recovery substitution', () => {
  const { brain, memCalls } = makeBrain();
  const skill = makeRunningSkill();
  brain._currentSkill = skill;

  brain._onSkillDone(skill, {
    ok: false,
    error_code: 'out_of_range',
    error: 'oor',
    recovery: { skill: 'goto_coord', args: { x: 5, y: 64, z: 0 } },
  });

  const last = memCalls[memCalls.length - 1];
  assert.ok(last && typeof last.add_failed === 'string', 'add_failed string was written');
  assert.match(last.add_failed, /out_of_range/i);
  assert.match(last.add_failed, /goto_coord/);
});

test('A4 — _onSkillDone sets _autoRecovering = true when it substitutes', () => {
  const { brain } = makeBrain();
  const skill = makeRunningSkill();
  brain._currentSkill = skill;

  brain._onSkillDone(skill, {
    ok: false,
    error_code: 'out_of_range',
    error: 'oor',
    recovery: { skill: 'goto_coord', args: { x: 5, y: 64, z: 0 } },
  });

  assert.equal(brain._autoRecovering, true);
});

// ---------------------------------------------------------------------------
// Single-step cap — second consecutive recovery is refused
// ---------------------------------------------------------------------------

test('A4 — second consecutive recovery is NOT substituted and falls through to a think', () => {
  const { brain, startCalls, thinkCalls } = makeBrain();
  const skill = makeRunningSkill();
  brain._currentSkill = skill;

  // First call: should substitute.
  brain._onSkillDone(skill, {
    ok: false,
    error_code: 'out_of_range',
    error: 'oor',
    recovery: { skill: 'goto_coord', args: { x: 5, y: 64, z: 0 } },
  });
  assert.equal(startCalls.length, 1, 'first substitution fired');
  assert.equal(brain._autoRecovering, true);

  // Second call: still has a recovery field, but _autoRecovering blocks it.
  const recoverySkill = { name: 'goto_coord', args: { x: 5 }, abort: () => {}, startedAt: Date.now() };
  brain._currentSkill = recoverySkill;
  brain._onSkillDone(recoverySkill, {
    ok: false,
    error_code: 'out_of_range',
    error: 'oor again',
    recovery: { skill: 'goto_coord', args: { x: 9, y: 64, z: 0 } },
  });

  assert.equal(startCalls.length, 1, 'no second substitution');
  assert.equal(brain._autoRecovering, false, 'flag reset for next round');
  assert.equal(thinkCalls.length, 1, 'fell through to _scheduleThink');
});

// ---------------------------------------------------------------------------
// Passthrough cases — no recovery / success / malformed
// ---------------------------------------------------------------------------

test('A4 — _onSkillDone on success schedules a think and clears _autoRecovering', () => {
  const { brain, startCalls, thinkCalls } = makeBrain();
  brain._autoRecovering = true; // pretend we were mid-recovery
  const skill = makeRunningSkill('goto_coord', { x: 5 });
  brain._currentSkill = skill;

  brain._onSkillDone(skill, { ok: true });

  assert.equal(startCalls.length, 0);
  assert.equal(thinkCalls.length, 1);
  assert.equal(brain._autoRecovering, false);
});

test('A4 — _onSkillDone with no recovery field falls through normally', () => {
  const { brain, startCalls, thinkCalls } = makeBrain();
  const skill = makeRunningSkill();
  brain._currentSkill = skill;

  brain._onSkillDone(skill, { ok: false, error_code: 'unknown_block', error: 'no recovery here' });

  assert.equal(startCalls.length, 0);
  assert.equal(thinkCalls.length, 1);
});

test('A4 — _onSkillDone rejects recovery with unknown skill name', () => {
  const { brain, startCalls, thinkCalls } = makeBrain();
  const skill = makeRunningSkill();
  brain._currentSkill = skill;

  brain._onSkillDone(skill, {
    ok: false,
    error_code: 'out_of_range',
    error: 'oor',
    recovery: { skill: 'not_a_real_skill', args: {} },
  });

  assert.equal(startCalls.length, 0, 'must not start nonexistent skill');
  assert.equal(thinkCalls.length, 1, 'falls through to think');
});

test('A4 — _onSkillDone rejects malformed recovery shapes', () => {
  for (const bad of [
    { recovery: null },
    { recovery: 'goto_coord' },
    { recovery: { skill: null, args: {} } },
    { recovery: { args: {} } },              // missing skill
    { recovery: { skill: 'goto_coord' } },   // missing args is OK actually — guarded by ??
  ]) {
    const { brain, startCalls, thinkCalls } = makeBrain();
    const skill = makeRunningSkill();
    brain._currentSkill = skill;
    brain._onSkillDone(skill, { ok: false, error_code: 'out_of_range', error: 'oor', ...bad });

    if (bad.recovery && bad.recovery.skill === 'goto_coord') {
      // The "missing args" shape SHOULD still substitute (args defaults to {}).
      assert.equal(startCalls.length, 1, 'missing-args recovery still substitutes');
      assert.deepEqual(startCalls[0].args, {});
    } else {
      assert.equal(startCalls.length, 0, 'must not start malformed recovery');
      assert.equal(thinkCalls.length, 1, 'falls through to think');
    }
  }
});
