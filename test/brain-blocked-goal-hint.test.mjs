// BUG-018 (2026-05-11): when the brain force-clears a goal on BLOCKED-SIG
// IGNORED, the cleared goal text now includes a concrete next-step pointing
// at the missing prerequisite in the wood-tier resource chain. The
// 2026-05-11 overnight run showed bots drifting off-strategy after the
// generic clear; this restores forward motion toward the original objective.
//
// Run with:  node --test test/brain-blocked-goal-hint.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deriveBlockedGoalHint } from '../src/bots/brain.js';
import * as brainModule from '../src/bots/brain.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeBot(items) {
  return {
    inventory: {
      items: () => items.map(([name, count]) => ({ name, count })),
    },
  };
}

// ---------------------------------------------------------------------------
// Wood-tier chain — walks back from blocked sig to first missing material
// ---------------------------------------------------------------------------

test('hint — craft(wooden_pickaxe) with empty inventory points at collect_block(log)', () => {
  const bot = makeBot([]);
  const hint = deriveBlockedGoalHint('craft', { item: 'wooden_pickaxe', count: 1 }, bot, 'no recipe — missing prereqs');
  assert.match(hint, /collect_block/i);
  assert.match(hint, /log/i);
  assert.match(hint, /BLOCKED:/);
});

test('hint — craft(wooden_pickaxe) with log only points at craft(planks)', () => {
  const bot = makeBot([['oak_log', 4]]);
  const hint = deriveBlockedGoalHint('craft', { item: 'wooden_pickaxe', count: 1 }, bot, 'missing prereqs');
  assert.match(hint, /craft\(item=oak_planks\)/);
  assert.doesNotMatch(hint, /collect_block/);
});

test('hint — craft(wooden_pickaxe) with planks but no sticks points at craft(stick)', () => {
  const bot = makeBot([['oak_planks', 8]]);
  const hint = deriveBlockedGoalHint('craft', { item: 'wooden_pickaxe', count: 1 }, bot, 'missing prereqs');
  assert.match(hint, /craft\(item=stick\)/);
  assert.doesNotMatch(hint, /oak_planks/i);
});

test('hint — craft(wooden_pickaxe) with all ingredients points at crafting_table', () => {
  const bot = makeBot([['oak_planks', 8], ['stick', 4]]);
  const hint = deriveBlockedGoalHint('craft', { item: 'wooden_pickaxe', count: 1 }, bot, 'no recipe');
  assert.match(hint, /crafting_table/);
  assert.doesNotMatch(hint, /collect_block/);
});

test('hint — craft(crafting_table) with no logs points at collect_block(log)', () => {
  const bot = makeBot([]);
  const hint = deriveBlockedGoalHint('craft', { item: 'crafting_table', count: 1 }, bot, 'missing prereqs');
  assert.match(hint, /collect_block/);
  assert.match(hint, /log/);
});

test('hint — craft(crafting_table) with log but no planks points at craft(planks)', () => {
  const bot = makeBot([['oak_log', 1]]);
  const hint = deriveBlockedGoalHint('craft', { item: 'crafting_table', count: 1 }, bot, 'missing prereqs');
  assert.match(hint, /craft\(item=oak_planks\)/);
});

test('hint — craft(stick) with planks does NOT recommend stick (avoid loop)', () => {
  const bot = makeBot([['oak_planks', 8]]);
  const hint = deriveBlockedGoalHint('craft', { item: 'stick', count: 4 }, bot, 'no recipe');
  // stick's prereqs are planks; planks are present; falls through to "have ingredients"
  assert.match(hint, /crafting_table|ingredients/i);
});

// ---------------------------------------------------------------------------
// Error-code-driven hints
// ---------------------------------------------------------------------------

test('hint — craft_succeeded_but_item_missing routes to drop(unused)', () => {
  const bot = makeBot([['oak_planks', 64], ['oak_log', 64]]);
  const hint = deriveBlockedGoalHint(
    'craft',
    { item: 'wooden_pickaxe', count: 1 },
    bot,
    'craft wooden_pickaxe: server reported success but wooden_pickaxe never landed in inventory',
  );
  assert.match(hint, /drop/);
  assert.doesNotMatch(hint, /collect_block/);
});

test('hint — no_valid_surface routes to dig_down', () => {
  const bot = makeBot([['crafting_table', 1]]);
  const hint = deriveBlockedGoalHint(
    'place_block',
    { block: 'crafting_table' },
    bot,
    'place_block crafting_table: no solid surface in adjacent ring',
  );
  assert.match(hint, /dig_down|flat ground/i);
});

test('hint — out_of_range routes to goto_coord', () => {
  const bot = makeBot([]);
  const hint = deriveBlockedGoalHint(
    'use_block',
    { block: 'crafting_table' },
    bot,
    'use_block crafting_table: out of use-range (12m > 4.5m)',
  );
  assert.match(hint, /goto_coord/);
});

// ---------------------------------------------------------------------------
// Fallback — non-craft / unknown / null bot
// ---------------------------------------------------------------------------

test('hint — unknown skill falls back to generic message', () => {
  const bot = makeBot([]);
  const hint = deriveBlockedGoalHint('say', { text: 'hello' }, bot, null);
  assert.match(hint, /BLOCKED:/);
  assert.match(hint, /pick a different objective/);
});

test('hint — craft of item not in RECIPE_PREREQS falls back to generic', () => {
  const bot = makeBot([]);
  const hint = deriveBlockedGoalHint('craft', { item: 'enchanted_golden_apple' }, bot, 'missing');
  assert.match(hint, /pick a different objective/);
});

test('hint — null bot falls back to generic for craft', () => {
  const hint = deriveBlockedGoalHint('craft', { item: 'wooden_pickaxe' }, null, 'missing');
  assert.match(hint, /pick a different objective/);
});

test('hint — empty args / missing item falls back to generic', () => {
  const bot = makeBot([]);
  const hint = deriveBlockedGoalHint('craft', {}, bot, null);
  assert.match(hint, /pick a different objective/);
});

// Step 2.6 hotfix (2026-05-17): dig_block hard-blocked for missing pickaxe
// must redirect to the wood-tier chain, not "pick a different objective".
// The overnight queue showed 8 bots churning on dig_block hard-blocks with
// the generic hint setting them up to fail again next turn.

test('hint — dig_block blocked for no-pickaxe with empty inv → collect log', () => {
  const bot = makeBot([['dirt', 17]]);
  const hint = deriveBlockedGoalHint('dig_block', { x: 53, y: 108, z: -72 }, bot, 'no pickaxe in inventory — craft wooden_pickaxe first (3 planks + 2 sticks at a crafting_table)');
  assert.match(hint, /collect_block/);
  assert.match(hint, /log/);
  assert.match(hint, /STOP digging/i);
  assert.doesNotMatch(hint, /pick a different objective/);
});

test('hint — dig_down blocked for no-pickaxe with logs → craft planks', () => {
  const bot = makeBot([['oak_log', 2]]);
  const hint = deriveBlockedGoalHint('dig_down', {}, bot, 'no pickaxe in inventory — craft wooden_pickaxe first');
  assert.match(hint, /craft\(item=oak_planks\)/);
  assert.match(hint, /STOP digging/i);
});

test('hint — dig_block blocked for no-pickaxe with planks → craft stick', () => {
  const bot = makeBot([['oak_planks', 8]]);
  const hint = deriveBlockedGoalHint('dig_block', { x: 0, y: 60, z: 0 }, bot, 'no pickaxe in inventory — craft wooden_pickaxe first');
  assert.match(hint, /craft\(item=stick\)/);
  assert.match(hint, /STOP digging/i);
});

test('hint — dig_block blocked for no-pickaxe with planks+sticks → place crafting_table', () => {
  const bot = makeBot([['oak_planks', 8], ['stick', 4]]);
  const hint = deriveBlockedGoalHint('dig_block', { x: 0, y: 60, z: 0 }, bot, 'no pickaxe in inventory — craft wooden_pickaxe first');
  assert.match(hint, /crafting_table/);
  assert.match(hint, /wooden_pickaxe/);
});

test('hint — dig_block with non-pickaxe error falls back to generic', () => {
  const bot = makeBot([]);
  const hint = deriveBlockedGoalHint('dig_block', { x: 0, y: 60, z: 0 }, bot, 'block out of range');
  assert.match(hint, /pick a different objective/);
});

// BUG-024 (Path 2, 2026-05-18): pillar_up no_headroom and no_floor hints
test('hint — pillar_up with no_headroom routes to dig the ceiling', () => {
  const bot = makeBot([['dirt', 10]]);
  const hint = deriveBlockedGoalHint('pillar_up', { block: 'dirt' }, bot, 'pillar_up dirt: headroom blocked above by stone — no_headroom');
  assert.match(hint, /headroom/i);
  assert.match(hint, /dig_block|mine.*above|goto_coord/);
});

test('hint — pillar_up with no_floor routes to land/place footing', () => {
  const bot = makeBot([['dirt', 10]]);
  const hint = deriveBlockedGoalHint('pillar_up', { block: 'dirt' }, bot, 'pillar_up dirt: no_floor — in mid-air');
  assert.match(hint, /solid floor|footing|land/i);
});

// Step 2.6 hotfix (2026-05-17): extractGoalNextStep parses concrete skill
// calls out of "Next step:" phrases so the wait-spiral substitution path
// can deterministically execute them when the LLM ignores the hint.

test('extractGoalNextStep — collect_block from wood-chain hint', () => {
  const { extractGoalNextStep } = brainModule.__testing;
  const goal = 'BLOCKED: craft(wooden_pickaxe) needs the wood chain. Next step: collect_block(<oak_log|spruce_log|birch_log|any_log>) — any wood log will do.';
  const step = extractGoalNextStep(goal);
  assert.deepEqual(step, { type: 'collect_block', args: { block: 'oak_log', count: 1, range: 64 } });
});

test('extractGoalNextStep — craft(item=oak_planks)', () => {
  const { extractGoalNextStep } = brainModule.__testing;
  const step = extractGoalNextStep('BLOCKED: foo. Next step: craft(item=oak_planks) — 1 log → 4 planks.');
  assert.deepEqual(step, { type: 'craft', args: { item: 'oak_planks', count: 1 } });
});

test('extractGoalNextStep — craft(item=stick)', () => {
  const { extractGoalNextStep } = brainModule.__testing;
  const step = extractGoalNextStep('Next step: craft(item=stick)');
  assert.deepEqual(step, { type: 'craft', args: { item: 'stick', count: 1 } });
});

test('extractGoalNextStep — place_block(crafting_table) bare', () => {
  const { extractGoalNextStep } = brainModule.__testing;
  const step = extractGoalNextStep('Next step: place_block(crafting_table)');
  assert.deepEqual(step, { type: 'place_block', args: { block: 'crafting_table' } });
});

test('extractGoalNextStep — dig_down() empty args', () => {
  const { extractGoalNextStep } = brainModule.__testing;
  const step = extractGoalNextStep('BLOCKED: place_block(furnace) — no flat surface. Next step: dig_down() to flatten, then place_block again.');
  assert.deepEqual(step, { type: 'dig_down', args: {} });
});

test('extractGoalNextStep — no Next step → null', () => {
  const { extractGoalNextStep } = brainModule.__testing;
  assert.equal(extractGoalNextStep('mine some iron'), null);
});

test('extractGoalNextStep — non-string input → null', () => {
  const { extractGoalNextStep } = brainModule.__testing;
  assert.equal(extractGoalNextStep(null), null);
  assert.equal(extractGoalNextStep(undefined), null);
});

// ---------------------------------------------------------------------------
// Step 2.6 (2026-05-16): post-craft stick nudge. The 30h overnight run
// produced 69 plank crafts but only 1 stick craft because the LLM jumped
// straight from "I have planks" to "craft wooden_pickaxe", skipping sticks.
// derivePostCraftNudge fires a one-shot goal hint immediately after a
// successful plank craft so the next _think is steered at sticks.
// ---------------------------------------------------------------------------

test('post-craft nudge — successful plank craft with no sticks → set_goal mentions sticks + no-table', () => {
  const { derivePostCraftNudge } = brainModule;
  const bot = makeBot([['oak_planks', 4]]);
  const nudge = derivePostCraftNudge(
    'craft',
    { item: 'oak_planks', count: 1 },
    { ok: true, crafted: '4x oak_planks' },
    bot,
    'explore',
  );
  assert.ok(nudge, 'expected a nudge object, got null/undefined');
  assert.ok(typeof nudge.set_goal === 'string', 'nudge must expose a set_goal string');
  assert.match(nudge.set_goal, /craft sticks/i);
  assert.match(nudge.set_goal, /no table/i);
});

test('post-craft nudge — sticks already in inventory → no nudge', () => {
  const { derivePostCraftNudge } = brainModule;
  const bot = makeBot([['oak_planks', 4], ['stick', 5]]);
  const nudge = derivePostCraftNudge(
    'craft',
    { item: 'oak_planks', count: 1 },
    { ok: true, crafted: '4x oak_planks' },
    bot,
    'explore',
  );
  assert.ok(nudge == null, `expected null/undefined, got ${JSON.stringify(nudge)}`);
});

test('post-craft nudge — current_goal already mentions sticks → no nudge', () => {
  const { derivePostCraftNudge } = brainModule;
  const bot = makeBot([['oak_planks', 4]]);
  const nudge = derivePostCraftNudge(
    'craft',
    { item: 'oak_planks', count: 1 },
    { ok: true, crafted: '4x oak_planks' },
    bot,
    'craft sticks next',
  );
  assert.ok(nudge == null, `expected null/undefined, got ${JSON.stringify(nudge)}`);
});

test('post-craft nudge — craft failed → no nudge', () => {
  const { derivePostCraftNudge } = brainModule;
  const bot = makeBot([['oak_planks', 4]]);
  const nudge = derivePostCraftNudge(
    'craft',
    { item: 'oak_planks', count: 1 },
    { ok: false, error: 'no recipe' },
    bot,
    'explore',
  );
  assert.ok(nudge == null, `expected null/undefined, got ${JSON.stringify(nudge)}`);
});

test('post-craft nudge — crafted item is not a plank → no nudge', () => {
  const { derivePostCraftNudge } = brainModule;
  const bot = makeBot([['oak_planks', 4]]);
  const nudge = derivePostCraftNudge(
    'craft',
    { item: 'wooden_pickaxe', count: 1 },
    { ok: true, crafted: '1x wooden_pickaxe' },
    bot,
    'explore',
  );
  assert.ok(nudge == null, `expected null/undefined, got ${JSON.stringify(nudge)}`);
});

// ---------------------------------------------------------------------------
// Step 2.6 (2026-05-16): synchronous failure recording. _onSkillDone must
// record the failure BEFORE returning, so that the next _think (after the
// MIN_THINK_GAP_MS=1500ms gap) sees the failure in the cooldown ring.
// Without this, place_block:crafting_table stuck-loops because _isBlockedSkill
// returns null right after the failure resolves.
// ---------------------------------------------------------------------------

test('race — _onSkillDone records failure synchronously so _isBlockedSkill sees it immediately', () => {
  const { Brain } = brainModule;
  const bot = {
    username: 'TestRace',
    inventory: { items: () => [] },
    entity: { position: { x: 0, y: 64, z: 0 } },
  };
  const brain = new Brain(bot, { memory: null });

  const skill = { name: 'place_block', args: { block: 'crafting_table' }, startedAt: Date.now() };
  // NB: intentionally do NOT pre-set brain._currentSkill. The current
  // implementation early-returns when this._currentSkill !== skill, so the
  // failure is never recorded synchronously — that's the race we want fixed.
  brain._onSkillDone(skill, {
    ok: false,
    error_code: 'no_block_in_inventory',
    error: 'no crafting_table in inventory',
  });

  const blocked = brain._isBlockedSkill('place_block', { block: 'crafting_table' });
  assert.ok(blocked, 'expected place_block:crafting_table to be blocked synchronously after _onSkillDone');
});
