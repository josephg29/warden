// OVN-017 (post-mortem of Test33, 2026-05-08): the watchdog's stuck_loop and
// phantom_craft_loop detectors silently never fired because they were reading
// the old flat brainInfo shape after the brain rewrite reshaped lastDecision
// to `{ action: { skill, args }, ... }` and lastSkillResult to
// `{ skill, args, outcome: { ok, error }, ... }`.
//
// These tests pin down the exact dashboard payload the API serves today so
// the next shape drift fails the build instead of the fleet.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { __testing } from '../data/overnight/watchdog.mjs';

const {
  decisionSig,
  trackDecisionHistory,
  trackPhantomCraft,
  trackProgressStarvation,
  classifyHealth,
  skillOk,
  skillError,
  detectMassDisconnect,
} = __testing;

// Real dashboard payload shape — see src/server/http.js#GET /bots/:id/decision
// and src/bots/brain.js#_recordDecision / lastSkillResult assignment.
// Canonical: `lastDecision.action = { type, args }`. Confirmed against the
// live dashboard on 2026-05-08 during the Test33 post-mortem.
function decisionPayload({ skill, args = {}, ts = Date.now() } = {}) {
  return {
    lastDecision: {
      reason:        'idle',
      observation:   '',
      say:           null,
      action:        skill ? { type: skill, args } : null,
      memory_update: null,
      error:         null,
      ts,
    },
    lastSkillResult: null,
    currentSkill:    null,
  };
}

function skillResultPayload({ skill, args = {}, ok, error = null, ts = Date.now() }) {
  return {
    skill,
    args,
    outcome:    { ok, ...(error ? { error } : {}) },
    durationMs: 100,
    ts,
  };
}

// -- decisionSig handles the action-wrapped shape ---------------------------

test('decisionSig reads action.type — the canonical brain.js shape (live 2026-05-08)', () => {
  const ld = { action: { type: 'place_block', args: { block: 'crafting_table' } }, ts: 1 };
  assert.equal(decisionSig(ld), 'place_block:{"block":"crafting_table"}');
});

test('decisionSig also reads action.skill (intermediate shape, for forward compat)', () => {
  const ld = { action: { skill: 'place_block', args: { block: 'crafting_table' } }, ts: 1 };
  assert.equal(decisionSig(ld), 'place_block:{"block":"crafting_table"}');
});

test('decisionSig still works on the legacy flat shape (backward compat)', () => {
  const ld = { skill: 'craft', args: { item: 'oak_planks' } };
  assert.equal(decisionSig(ld), 'craft:{"item":"oak_planks"}');
});

test('decisionSig returns null when skill is missing — no false positives', () => {
  assert.equal(decisionSig({ reason: 'idle', ts: 1 }), null);
  assert.equal(decisionSig(null), null);
  assert.equal(decisionSig(undefined), null);
});

// -- trackDecisionHistory populates recentDecisions on the real shape -------

test('trackDecisionHistory populates recentDecisions on the real dashboard shape', () => {
  const slot = {};
  trackDecisionHistory(slot, decisionPayload({ skill: 'place_block', args: { block: 'crafting_table' }, ts: 1000 }));
  trackDecisionHistory(slot, decisionPayload({ skill: 'place_block', args: { block: 'crafting_table' }, ts: 2000 }));
  assert.equal(slot.recentDecisions.length, 2);
  assert.equal(slot.recentDecisions[0].sig, 'place_block:{"block":"crafting_table"}');
  assert.equal(slot.recentDecisions[1].sig, 'place_block:{"block":"crafting_table"}');
});

test('trackDecisionHistory dedupes consecutive same-ts entries', () => {
  const slot = {};
  trackDecisionHistory(slot, decisionPayload({ skill: 'craft', args: { item: 'oak_planks' }, ts: 1000 }));
  trackDecisionHistory(slot, decisionPayload({ skill: 'craft', args: { item: 'oak_planks' }, ts: 1000 }));
  assert.equal(slot.recentDecisions.length, 1);
});

// -- The Test33 reproduction: classifyHealth must return stuck_loop ---------

test('classifyHealth returns stuck_loop for 10 identical decisions (Test33 reproduction)', () => {
  const now = Date.now();
  const slot = {
    slot:               5,
    javaPid:            process.pid,            // alive (this test process)
    lastSeenConnected:  now,
    recentDecisions:    Array.from({ length: 10 }, (_, i) => ({
      ts:  now - (10 - i) * 5000,
      sig: 'place_block:{"block":"crafting_table"}',
    })),
    phantomCraftWindow: [],
    progressWindow:     [],
  };
  const verdict = classifyHealth({
    state:    { state: 'connected', brainStatus: 'thinking', lastDecisionAgeS: 5, memory: { state: { recent_events: [] } } },
    decision: null,
    slot,
    now,
  });
  assert.equal(verdict.unhealthy, true);
  assert.equal(verdict.reason, 'stuck_loop');
  assert.equal(verdict.evidence.repeatedSkill, 'place_block:{"block":"crafting_table"}');
});

// -- phantom-craft detector reads outcome.ok / outcome.error ----------------

test('skillOk / skillError read outcome-wrapped shape', () => {
  const lsr = skillResultPayload({ skill: 'craft', ok: true });
  assert.equal(skillOk(lsr), true);
  assert.equal(skillError(lsr), '');

  const fail = skillResultPayload({ skill: 'place_block', ok: false, error: 'no crafting_table in inventory' });
  assert.equal(skillOk(fail), false);
  assert.equal(skillError(fail), 'no crafting_table in inventory');
});

test('trackPhantomCraft fires on craft-ok then place_block-no-X-in-inventory', () => {
  const slot = {};
  // First tick: craft(crafting_table) reports ok=true
  const t1 = Date.now();
  trackPhantomCraft(slot, {
    lastDecision:    { action: { type: 'craft', args: { item: 'crafting_table' } }, ts: t1 },
    lastSkillResult: skillResultPayload({ skill: 'craft', args: { item: 'crafting_table' }, ok: true, ts: t1 }),
  });
  assert.ok(slot.lastCraftClaim, 'craft-ok must arm the claim');
  assert.equal(slot.lastCraftClaim.item, 'crafting_table');

  // Second tick: place_block fails because inventory shows nothing
  const t2 = t1 + 1000;
  trackPhantomCraft(slot, {
    lastDecision:    { action: { type: 'place_block', args: { block: 'crafting_table' } }, ts: t2 },
    lastSkillResult: skillResultPayload({ skill: 'place_block', args: { block: 'crafting_table' }, ok: false, error: 'no crafting_table in inventory', ts: t2 }),
  });
  assert.equal(slot.phantomCraftWindow.length, 1, 'phantom-craft pair must be recorded');
  assert.equal(slot.phantomCraftWindow[0].item, 'crafting_table');
});

// -- progress starvation: catches Test33 even if encoding drifts again ------

test('classifyHealth returns progress_starvation when 30 decisions yield zero ok=true outcomes', () => {
  const now = Date.now();
  const slot = {
    slot:               5,
    javaPid:            process.pid,
    lastSeenConnected:  now,
    recentDecisions:    [],                    // detector blind, by design
    phantomCraftWindow: [],
    progressWindow:     Array.from({ length: 30 }, (_, i) => ({
      ts:    now - (30 - i) * 5000,
      skill: i % 2 === 0 ? 'place_block' : 'wait',
      ok:    false,                             // every outcome fails / no-ops
    })),
  };
  const verdict = classifyHealth({
    state:    { state: 'connected', brainStatus: 'thinking', lastDecisionAgeS: 5, memory: { state: { recent_events: [] } } },
    decision: null,
    slot,
    now,
  });
  assert.equal(verdict.unhealthy, true);
  assert.equal(verdict.reason, 'progress_starvation');
  assert.equal(verdict.evidence.window, 30);
  assert.equal(verdict.evidence.oks, 0);
});

test('progress_starvation does NOT fire when at least one ok=true exists in the window', () => {
  const now = Date.now();
  const slot = {
    slot:               5,
    javaPid:            process.pid,
    lastSeenConnected:  now,
    recentDecisions:    [],
    phantomCraftWindow: [],
    progressWindow:     [
      ...Array.from({ length: 29 }, (_, i) => ({ ts: now - (30 - i) * 5000, skill: 'wait', ok: false })),
      { ts: now - 1000, skill: 'craft', ok: true },
    ],
  };
  const verdict = classifyHealth({
    state:    { state: 'connected', brainStatus: 'thinking', lastDecisionAgeS: 5, memory: { state: { recent_events: [] } } },
    decision: null,
    slot,
    now,
  });
  assert.equal(verdict.unhealthy, false);
});

// -- end-to-end: classifyHealth reports healthy in the steady-state case ---

test('classifyHealth reports healthy when the bot is moving normally', () => {
  const now = Date.now();
  const sigs = ['goto_coord:{"x":1,"z":2}', 'dig_block:{"block":"oak_log"}', 'craft:{"item":"oak_planks"}'];
  const slot = {
    slot:               5,
    javaPid:            process.pid,
    lastSeenConnected:  now,
    recentDecisions:    Array.from({ length: 12 }, (_, i) => ({ ts: now - (12 - i) * 5000, sig: sigs[i % sigs.length] })),
    phantomCraftWindow: [],
    progressWindow:     Array.from({ length: 12 }, (_, i) => ({ ts: now - (12 - i) * 5000, skill: 'goto_coord', ok: true })),
  };
  const verdict = classifyHealth({
    state:    { state: 'connected', brainStatus: 'thinking', lastDecisionAgeS: 5, memory: { state: { recent_events: [] } } },
    decision: null,
    slot,
    now,
  });
  assert.equal(verdict.unhealthy, false);
});

// -- OBS-MASS-DC: mass-disconnect detector --------------------------------

test('detectMassDisconnect triggers when 4-of-5 slots disconnect within 3 minutes', () => {
  const now = Date.now();
  const slots = [
    { slot: 1, disconnectedSince: now - 60_000  },   // 1 min ago — in window
    { slot: 2, disconnectedSince: now - 90_000  },   // 1.5 min ago — in window
    { slot: 3, disconnectedSince: now - 120_000 },   // 2 min ago — in window
    { slot: 4, disconnectedSince: now - 150_000 },   // 2.5 min ago — in window
    { slot: 5, disconnectedSince: null           },  // still connected
  ];
  const affected = detectMassDisconnect(slots, now);
  assert.equal(affected.length, 4, '4 slots in 3-min window must trigger mass_disconnect');
  const nums = affected.map((s) => s.slot).sort((a, b) => a - b);
  assert.deepEqual(nums, [1, 2, 3, 4]);
});

test('detectMassDisconnect does NOT fire when only 3-of-5 slots are disconnected', () => {
  const now = Date.now();
  const slots = [
    { slot: 1, disconnectedSince: now - 60_000  },
    { slot: 2, disconnectedSince: now - 90_000  },
    { slot: 3, disconnectedSince: now - 120_000 },
    { slot: 4, disconnectedSince: null           },
    { slot: 5, disconnectedSince: null           },
  ];
  const affected = detectMassDisconnect(slots, now);
  assert.equal(affected.length, 0, '3 disconnected slots must not trigger mass_disconnect');
});

test('detectMassDisconnect does NOT fire when 4 disconnects span more than 3 minutes', () => {
  const now = Date.now();
  // slot 1 is 4 min ago — outside the 3-min window; only 3 fall within it
  const slots = [
    { slot: 1, disconnectedSince: now - 4 * 60_000 },   // 4 min ago — OUTSIDE window
    { slot: 2, disconnectedSince: now - 2 * 60_000 },   // 2 min ago — in window
    { slot: 3, disconnectedSince: now - 90_000      },   // 1.5 min ago — in window
    { slot: 4, disconnectedSince: now - 60_000      },   // 1 min ago — in window
    { slot: 5, disconnectedSince: null               },  // connected
  ];
  const affected = detectMassDisconnect(slots, now);
  assert.equal(affected.length, 0, 'only 3 slots within window — must not trigger (below threshold 4)');
});

// -- Step 2.6 (2026-05-16): place_block_no_item + llm_backoff guard ---------

test('classifyHealth fires place_block_no_item on 2 repeated place_block + no_block_in_inventory', () => {
  const now = Date.now();
  const sig = 'place_block:{"block":"crafting_table"}';
  const slot = {
    slot:               5,
    javaPid:            process.pid,
    lastSeenConnected:  now,
    recentDecisions: [
      { ts: now - 10_000, sig },
      { ts: now - 5_000,  sig },
    ],
    phantomCraftWindow: [],
    progressWindow:     [],
  };
  const verdict = classifyHealth({
    state:    { state: 'connected', brainStatus: 'thinking', lastDecisionAgeS: 5, memory: { state: { recent_events: [] } } },
    decision: {
      lastDecision:    { action: { type: 'place_block', args: { block: 'crafting_table' } }, ts: now },
      lastSkillResult: { skill: 'place_block', args: { block: 'crafting_table' }, outcome: { ok: false, error_code: 'no_block_in_inventory', error: 'no crafting_table in inventory' }, ts: now },
    },
    slot,
    now,
  });
  assert.equal(verdict.unhealthy, true);
  assert.equal(verdict.reason, 'place_block_no_item');
  assert.equal(verdict.evidence.repeatedSkill, sig);
  assert.equal(verdict.evidence.count, 2);
  assert.equal(verdict.evidence.error_code, 'no_block_in_inventory');
});

test('classifyHealth does NOT fire place_block_no_item when error_code is different — falls through', () => {
  const now = Date.now();
  const sig = 'place_block:{"block":"crafting_table"}';
  const slot = {
    slot:               5,
    javaPid:            process.pid,
    lastSeenConnected:  now,
    // Only 2 repeats — the 10-repeat stuck_loop must NOT fire either.
    recentDecisions: [
      { ts: now - 10_000, sig },
      { ts: now - 5_000,  sig },
    ],
    phantomCraftWindow: [],
    progressWindow:     [],
  };
  const verdict = classifyHealth({
    state:    { state: 'connected', brainStatus: 'thinking', lastDecisionAgeS: 5, memory: { state: { recent_events: [] } } },
    decision: {
      lastDecision:    { action: { type: 'place_block', args: { block: 'crafting_table' } }, ts: now },
      lastSkillResult: { skill: 'place_block', args: { block: 'crafting_table' }, outcome: { ok: false, error_code: 'no_valid_surface', error: 'no valid surface' }, ts: now },
    },
    slot,
    now,
  });
  assert.equal(verdict.unhealthy, false, 'different error_code at 2 repeats must NOT trip the early detector');
});

test('classifyHealth returns healthy when brainStatus is llm_backoff even with stale decision age', () => {
  const now = Date.now();
  const slot = {
    slot:               5,
    javaPid:            process.pid,
    lastSeenConnected:  now,
    recentDecisions:    [],
    phantomCraftWindow: [],
    progressWindow:     [],
  };
  const verdict = classifyHealth({
    state:    { state: 'connected', brainStatus: 'llm_backoff', lastDecisionAgeS: 600, memory: { state: { recent_events: [] } } },
    decision: null,
    slot,
    now,
  });
  assert.equal(verdict.unhealthy, false, 'llm_backoff is intentional pause — never restart');
});

test('classifyHealth returns mass_disconnect (not disconnected_too_long) when massDisconnect flag is set', () => {
  const now = Date.now();
  const slot = {
    slot:               1,
    javaPid:            process.pid,
    lastSeenConnected:  now - 5 * 60_000,   // was connected 5 min ago
    disconnectedSince:  now - 3 * 60_000,
    recentDecisions:    [],
    phantomCraftWindow: [],
    progressWindow:     [],
  };
  const verdict = classifyHealth({
    state:    { state: 'disconnected', brainStatus: 'idle', memory: { state: { recent_events: [] } } },
    decision: null,
    slot,
    now,
    massDisconnect: true,
  });
  assert.equal(verdict.unhealthy, true);
  assert.equal(verdict.reason, 'mass_disconnect', 'massDisconnect=true must override disconnected_too_long label');
});
