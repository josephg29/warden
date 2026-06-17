// Phase A (Step 2.5, 2026-05-11): crafting + table-perception competence.
//
// Run with:  node --test test/brain-crafting-perception.test.mjs
//
// Tests for the four Phase A fixes:
//   A1. craft() static recipe-prereqs gate (RECIPE_PREREQS + checkRecipePrereqs).
//   A2. craft() post-validation distinct error_code on UI desync.
//   A3. place_block(crafting_table) pre-flight: surface + inventory + reach.
//   A4. use_block(crafting_table) line-of-sight + range substitute.
//
// Plus an end-to-end happy path: oak_log → planks → stick → crafting_table
// → place_block → wooden_pickaxe — exercised against a stateful mock bot
// that mutates inventory the way mineflayer would.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import minecraftData from 'minecraft-data';

import {
  checkRecipePrereqs,
  RECIPE_PREREQS,
  WOOD_PLANK_VARIANTS,
  WOOD_LOG_VARIANTS,
  __testing,
} from '../src/bots/brain.js';
import * as brainModule from '../src/bots/brain.js';
const consolidateToSingleSpecies = brainModule.consolidateToSingleSpecies;

const { SKILLS } = __testing;
const mcData = minecraftData('1.21.4');

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeInventory(items) {
  // mineflayer-shaped inventory: each item has .name, .count, .type (id)
  const out = items.map((i) => ({
    name: i.name,
    count: i.count,
    type: mcData.itemsByName[i.name]?.id ?? mcData.blocksByName[i.name]?.id ?? -1,
    durabilityUsed: i.durabilityUsed ?? 0,
    maxDurability: i.maxDurability ?? 0,
  }));
  return {
    items: () => out,
    _raw: out,
  };
}

function makeVec3(x, y, z) {
  // Minimal Vec3 stand-in: just a constructor-callable plain object that
  // exposes .x/.y/.z and supports .offset() + .distanceTo() + .floored().
  function V(xx, yy, zz) {
    if (!(this instanceof V)) return new V(xx, yy, zz);
    this.x = xx | 0; this.y = yy | 0; this.z = zz | 0;
  }
  V.prototype.offset = function (dx, dy, dz) { return new V(this.x + dx, this.y + dy, this.z + dz); };
  V.prototype.distanceTo = function (p) {
    const dx = this.x - p.x, dy = this.y - p.y, dz = this.z - p.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  };
  V.prototype.floored = function () { return new V(this.x, this.y, this.z); };
  const v = new V(x, y, z);
  return v;
}

function makeBot(opts = {}) {
  const inv = opts.inventory ?? makeInventory([]);
  const pos = opts.position ?? makeVec3(0, 64, 0);
  // Default world: 1-block-deep solid plane at y=63 (bot stands at y=64 ≈ "on grass")
  const world = opts.world ?? new Map();          // key=`${x},${y},${z}` → name
  const blockAt = (p) => {
    const k = `${p.x | 0},${p.y | 0},${p.z | 0}`;
    if (world.has(k)) {
      const name = world.get(k);
      const id = mcData.blocksByName[name]?.id ?? -1;
      return { name, type: id, position: makeVec3(p.x | 0, p.y | 0, p.z | 0) };
    }
    // y<=63 → stone (solid), else → air
    if ((p.y | 0) <= 63) return { name: 'stone', type: mcData.blocksByName.stone.id, position: makeVec3(p.x | 0, p.y | 0, p.z | 0) };
    return { name: 'air', type: mcData.blocksByName.air.id, position: makeVec3(p.x | 0, p.y | 0, p.z | 0) };
  };
  return {
    username: opts.username ?? 'TestBot',
    version: '1.21.4',
    health: 20,
    food: 20,
    time: { timeOfDay: 6000 },
    entity: { position: pos },
    entities: opts.entities ?? {},
    inventory: inv,
    findBlock: opts.findBlock ?? (() => null),
    blockAt,
    recipesFor: opts.recipesFor ?? (() => []),
    craft:        opts.craftFn        ?? (async () => {}),
    equip:        opts.equipFn        ?? (async () => {}),
    placeBlock:   opts.placeBlockFn   ?? (async () => {}),
    activateBlock:opts.activateBlockFn?? (async () => {}),
    lookAt:       opts.lookAtFn       ?? (async () => {}),
    pathfinder: {
      goto: opts.gotoFn ?? (async () => {}),
      setGoal: () => {},
    },
    world,
    on: () => {},
    once: () => {},
    removeListener: () => {},
  };
}

async function runSkill(name, args, bot) {
  const ac = new AbortController();
  return await SKILLS[name]({ bot, signal: ac.signal, mcData }, args);
}

// ---------------------------------------------------------------------------
// A1 — checkRecipePrereqs (pure helper)
// ---------------------------------------------------------------------------

test('A1 — checkRecipePrereqs returns {ok:true} for items with no entry in RECIPE_PREREQS', () => {
  const r = checkRecipePrereqs('totally_unknown_item', []);
  assert.equal(r.ok, true, 'unknown items pass the gate (defer to mineflayer recipesFor)');
});

test('A1 — checkRecipePrereqs reports missing logs for oak_planks', () => {
  const r = checkRecipePrereqs('oak_planks', []);
  assert.equal(r.ok, false);
  assert.equal(r.missing.length, 1);
  assert.equal(r.missing[0].count, 1);
  assert.equal(r.missing[0].have, 0);
  assert.ok(r.missing[0].any.some((n) => WOOD_LOG_VARIANTS.includes(n)), 'should require any wood log');
});

test('A1 — checkRecipePrereqs accepts any plank variant for stick', () => {
  const okWith = (name) => checkRecipePrereqs('stick', [{ name, count: 2 }]).ok;
  assert.equal(okWith('oak_planks'),    true);
  assert.equal(okWith('spruce_planks'), true);
  assert.equal(okWith('birch_planks'),  true);
  assert.equal(okWith('cherry_planks'), true);
});

test('A1 — checkRecipePrereqs flags BOTH missing prereqs for wooden_pickaxe', () => {
  const r = checkRecipePrereqs('wooden_pickaxe', []);
  assert.equal(r.ok, false);
  assert.equal(r.missing.length, 2, 'reports planks AND sticks');
  const missingNames = r.missing.map((m) => m.any.join('|'));
  assert.ok(missingNames.some((n) => /plank/.test(n)), 'missing planks');
  assert.ok(missingNames.some((n) => /^stick$/.test(n)), 'missing sticks');
});

test('A1 — checkRecipePrereqs reports partial-have for wooden_pickaxe', () => {
  const r = checkRecipePrereqs('wooden_pickaxe', [
    { name: 'oak_planks', count: 3 },
    { name: 'stick',      count: 1 },  // only 1 of 2 sticks
  ]);
  assert.equal(r.ok, false);
  assert.equal(r.missing.length, 1, 'planks satisfied; only sticks remain');
  assert.equal(r.missing[0].count, 2);
  assert.equal(r.missing[0].have, 1);
});

test('A1 — checkRecipePrereqs satisfied for wooden_pickaxe with full inventory', () => {
  const r = checkRecipePrereqs('wooden_pickaxe', [
    { name: 'birch_planks', count: 3 },
    { name: 'stick',        count: 2 },
  ]);
  assert.equal(r.ok, true);
});

test('A1 — RECIPE_PREREQS table contains all wood-tier recipes from the brief', () => {
  const required = ['stick', 'crafting_table', 'wooden_pickaxe', 'wooden_axe', 'wooden_sword', 'wooden_shovel', 'wooden_hoe'];
  for (const r of required) assert.ok(RECIPE_PREREQS[r], `missing entry: ${r}`);
  // and one entry per wood variant
  for (const v of WOOD_PLANK_VARIANTS) assert.ok(RECIPE_PREREQS[v], `missing plank entry: ${v}`);
});

// ---------------------------------------------------------------------------
// A1 integration — SKILLS.craft prereqs gate
// ---------------------------------------------------------------------------

test('A1 — SKILLS.craft returns missing_prereqs error_code when prereqs absent', async () => {
  const bot = makeBot({ inventory: makeInventory([]) });
  const r = await runSkill('craft', { item: 'wooden_pickaxe' }, bot);
  assert.equal(r.ok, false);
  assert.equal(r.error_code, 'missing_prereqs', 'returns structured code');
  assert.ok(Array.isArray(r.missing), 'returns missing list');
  assert.ok(r.missing.length >= 1);
  assert.match(r.error, /no recipe available/i, 'error string trips isEarlyTripError');
});

test('A1 — SKILLS.craft prereqs gate fires BEFORE pathfind to crafting_table', async () => {
  let pathfinderCalled = false;
  const bot = makeBot({
    inventory: makeInventory([]),
    findBlock: () => ({ position: makeVec3(5, 64, 5), name: 'crafting_table' }),
    gotoFn: async () => { pathfinderCalled = true; },
  });
  await runSkill('craft', { item: 'wooden_pickaxe' }, bot);
  assert.equal(pathfinderCalled, false, 'must gate before pathfind to save a wasted trip');
});

test('A1 — SKILLS.craft prereqs gate accepts wood variant substitution (spruce_log → birch_planks request)', async () => {
  // Bot has spruce_log; LLM picks craft(birch_planks). Existing resolveWoodVariant
  // substitutes spruce_planks. Prereqs gate must accept spruce_log as satisfying
  // the "any log" requirement for the planks recipe.
  const bot = makeBot({
    inventory: makeInventory([{ name: 'spruce_log', count: 4 }]),
    recipesFor: () => [{ delta: [], result: { id: mcData.itemsByName.spruce_planks.id, count: 4 } }],
    craftFn: async () => { /* simulate craft, will fail at post-validation since inv unchanged */ },
  });
  const r = await runSkill('craft', { item: 'birch_planks' }, bot);
  // The prereqs gate should NOT fire here — bot has logs. The craft will fail
  // for a different reason (post-validation) — but error_code must NOT be
  // 'missing_prereqs'.
  assert.notEqual(r.error_code, 'missing_prereqs', 'gate must accept any log variant');
});

// ---------------------------------------------------------------------------
// A2 — SKILLS.craft post-validation distinct error_code
// ---------------------------------------------------------------------------

test('A2 — SKILLS.craft returns craft_succeeded_but_item_missing error_code on UI desync', async () => {
  // Setup: prereqs satisfied, recipesFor returns a recipe, bot.craft resolves
  // without throwing, but inventory count of the target never changes
  // (simulating output-dropped-on-floor / inventory-full).
  const inv = makeInventory([
    { name: 'oak_log', count: 4 },
  ]);
  const bot = makeBot({
    inventory: inv,
    recipesFor: () => [{ delta: [], result: { id: mcData.itemsByName.oak_planks.id, count: 4 } }],
    craftFn: async () => { /* mineflayer reports success but no inventory change */ },
  });
  const r = await runSkill('craft', { item: 'oak_planks' }, bot);
  assert.equal(r.ok, false);
  assert.equal(r.error_code, 'craft_succeeded_but_item_missing', 'returns A2 structured code');
  assert.match(r.error, /never landed in inventory/i);
});

test('A2 — SKILLS.craft returns ok with no error_code when delivered', async () => {
  const out = [
    { name: 'oak_log', count: 4, type: mcData.itemsByName.oak_log.id, durabilityUsed: 0, maxDurability: 0 },
  ];
  const bot = makeBot({
    inventory: { items: () => out, _raw: out },
    recipesFor: () => [{ delta: [], result: { id: mcData.itemsByName.oak_planks.id, count: 4 } }],
    craftFn: async () => {
      // Simulate successful craft: 1 log → 4 planks
      out.push({ name: 'oak_planks', count: 4, type: mcData.itemsByName.oak_planks.id, durabilityUsed: 0, maxDurability: 0 });
      out[0].count = 3;
    },
  });
  const r = await runSkill('craft', { item: 'oak_planks' }, bot);
  assert.equal(r.ok, true);
  assert.equal(r.error_code, undefined);
  assert.match(r.crafted, /oak_planks/);
});

// ---------------------------------------------------------------------------
// A3 — SKILLS.place_block(crafting_table) pre-flight
// ---------------------------------------------------------------------------

test('A3 — SKILLS.place_block returns no_block_in_inventory error_code when inventory missing', async () => {
  const bot = makeBot({ inventory: makeInventory([]) });
  const r = await runSkill('place_block', { block: 'crafting_table' }, bot);
  assert.equal(r.ok, false);
  assert.equal(r.error_code, 'no_block_in_inventory');
  assert.match(r.error, /no crafting_table in inventory/);
});

test('A3 — SKILLS.place_block returns no_valid_surface error_code when ring has no solid base', async () => {
  // Float in the air at y=200 — no solid blocks anywhere in the ring
  const bot = makeBot({
    inventory: makeInventory([{ name: 'crafting_table', count: 1 }]),
    position: makeVec3(0, 200, 0),
  });
  const r = await runSkill('place_block', { block: 'crafting_table' }, bot);
  assert.equal(r.ok, false);
  assert.equal(r.error_code, 'no_valid_surface');
  assert.match(r.error, /no solid surface/i);
});

test('A3 — SKILLS.place_block proceeds when inventory + surface valid', async () => {
  // Standing on solid ground at y=64; ring has plenty of solid bases at y=63
  let placeCalled = false;
  const bot = makeBot({
    inventory: makeInventory([{ name: 'crafting_table', count: 1 }]),
    position: makeVec3(0, 64, 0),
    placeBlockFn: async () => { placeCalled = true; },
  });
  const r = await runSkill('place_block', { block: 'crafting_table' }, bot);
  assert.equal(r.ok, true, `expected ok, got: ${JSON.stringify(r)}`);
  assert.equal(placeCalled, true, 'placeBlock invoked when preflight passes');
});

// ---------------------------------------------------------------------------
// A4 — SKILLS.use_block(crafting_table) line-of-sight + range
// ---------------------------------------------------------------------------

test('A4 — SKILLS.use_block returns no_target error_code when block not found', async () => {
  const bot = makeBot({ findBlock: () => null });
  const r = await runSkill('use_block', { block: 'crafting_table' }, bot);
  assert.equal(r.ok, false);
  assert.equal(r.error_code, 'no_target');
});

test('A4 — SKILLS.use_block calls bot.lookAt at the target before activate', async () => {
  let lookCount = 0, activateCalled = false;
  const tablePos = makeVec3(2, 64, 0);
  const bot = makeBot({
    findBlock: () => ({ position: tablePos, name: 'crafting_table' }),
    lookAtFn: async () => { lookCount += 1; },
    activateBlockFn: async () => { activateCalled = true; },
  });
  await runSkill('use_block', { block: 'crafting_table' }, bot);
  assert.ok(lookCount >= 1, 'lookAt called before activate');
  assert.equal(activateCalled, true);
});

test('A4 — SKILLS.use_block detects out-of-range and substitutes goto_coord recovery', async () => {
  // Table is 12 blocks away — outside the default 4-block use range.
  let gotoArgs = null;
  let activateCalled = false;
  const bot = makeBot({
    position: makeVec3(0, 64, 0),
    findBlock: () => ({ position: makeVec3(12, 64, 0), name: 'crafting_table' }),
    gotoFn: async (g) => { gotoArgs = g; },
    activateBlockFn: async () => { activateCalled = true; },
  });
  // Override pathfinder.goto to never actually move the bot — simulates a
  // pathfinder that "finished" but the bot is still 12 blocks away.
  bot.pathfinder.goto = async () => {};
  const r = await runSkill('use_block', { block: 'crafting_table' }, bot);
  assert.equal(r.ok, false);
  assert.equal(r.error_code, 'out_of_range');
  assert.match(r.error, /out of use-range/i);
  assert.equal(activateCalled, false, 'must NOT call activate when out of range');
});

// ---------------------------------------------------------------------------
// End-to-end happy-path: oak_log → planks → stick → crafting_table → place → wooden_pickaxe
// ---------------------------------------------------------------------------

test('Phase A E2E — full wood-tier loop succeeds with mocked stateful bot', async () => {
  // Stateful inventory that mineflayer's craft mutates the way real craft does.
  // Start with 6 logs — enough for: 4 planks (table) + 4 planks (pickaxe) +
  // 4 planks (sticks-from-2 + spare) + 2 spare. The order below mirrors the
  // brief's "collect log → craft 4 planks → craft sticks → craft crafting_table
  // → place → use → craft pickaxe" but interleaves a top-up craft(oak_planks)
  // before the table and pickaxe steps so the inventory accounting stays sane.
  const out = [
    { name: 'oak_log', count: 6, type: mcData.itemsByName.oak_log.id, durabilityUsed: 0, maxDurability: 0 },
  ];
  function addItem(name, n) {
    const found = out.find((i) => i.name === name);
    if (found) { found.count += n; return; }
    out.push({ name, count: n, type: mcData.itemsByName[name]?.id ?? mcData.blocksByName[name]?.id ?? -1, durabilityUsed: 0, maxDurability: 0 });
  }
  function consumeItem(name, n) {
    const found = out.find((i) => i.name === name);
    if (!found) return;
    found.count -= n;
    if (found.count <= 0) out.splice(out.indexOf(found), 1);
  }
  // World tracks placed blocks
  const world = new Map();
  const bot = makeBot({
    inventory: { items: () => out, _raw: out },
    position: makeVec3(0, 64, 0),
    world,
  });
  // Mock the recipe + craft side-effects per recipe. Note: mc-data assigns
  // distinct IDs in itemsByName vs blocksByName for the same name (e.g.
  // crafting_table). The craft skill prefers itemsByName, so we key off
  // the item id when both exist; the lookup below covers both forms.
  bot.recipesFor = (id) => [{ result: { id, count: 1 } }];
  function idsFor(name) {
    return [mcData.itemsByName[name]?.id, mcData.blocksByName[name]?.id].filter((x) => x != null);
  }
  bot.craft = async (recipe, count) => {
    const rid = recipe.result.id;
    if (idsFor('oak_planks').includes(rid)) {
      consumeItem('oak_log', 1); addItem('oak_planks', 4);
    } else if (idsFor('stick').includes(rid)) {
      consumeItem('oak_planks', 2); addItem('stick', 4);
    } else if (idsFor('crafting_table').includes(rid)) {
      consumeItem('oak_planks', 4); addItem('crafting_table', 1);
    } else if (idsFor('wooden_pickaxe').includes(rid)) {
      consumeItem('oak_planks', 3); consumeItem('stick', 2); addItem('wooden_pickaxe', 1);
    }
  };
  // Track the placed crafting_table in world + findBlock
  bot.placeBlock = async (ref, face) => {
    consumeItem('crafting_table', 1);
    world.set(`1,64,0`, 'crafting_table');
  };
  bot.findBlock = (q) => {
    const tableId = mcData.blocksByName.crafting_table.id;
    if (q.matching === tableId && world.get('1,64,0') === 'crafting_table') {
      return { position: makeVec3(1, 64, 0), name: 'crafting_table', type: tableId };
    }
    return null;
  };

  // Step 1: 4 planks (uses 1 log) — gives us enough for the table.
  let r = await runSkill('craft', { item: 'oak_planks', count: 4 }, bot);
  assert.equal(r.ok, true, `step1 planks: ${JSON.stringify(r)}`);

  // Step 2: crafting_table (consumes 4 planks).
  r = await runSkill('craft', { item: 'crafting_table', count: 1 }, bot);
  assert.equal(r.ok, true, `step2 table: ${JSON.stringify(r)}`);

  // Step 3: place_block(crafting_table) — consumes table from inventory,
  // surface preflight passes (standing on solid ground at y=64).
  r = await runSkill('place_block', { block: 'crafting_table' }, bot);
  assert.equal(r.ok, true, `step3 place: ${JSON.stringify(r)}`);

  // Step 4: more planks for sticks + pickaxe (uses 1 log → 4 planks).
  r = await runSkill('craft', { item: 'oak_planks', count: 4 }, bot);
  assert.equal(r.ok, true, `step4 planks-for-stick: ${JSON.stringify(r)}`);

  // Step 5: sticks (consumes 2 planks → 4 sticks).
  r = await runSkill('craft', { item: 'stick', count: 4 }, bot);
  assert.equal(r.ok, true, `step5 sticks: ${JSON.stringify(r)}`);

  // Step 6: top up planks for the pickaxe (needs 3) — currently have 2.
  r = await runSkill('craft', { item: 'oak_planks', count: 4 }, bot);
  assert.equal(r.ok, true, `step6 planks-for-pickaxe: ${JSON.stringify(r)}`);

  // Step 7: wooden_pickaxe (3 planks + 2 sticks at the placed table).
  r = await runSkill('craft', { item: 'wooden_pickaxe', count: 1 }, bot);
  assert.equal(r.ok, true, `step7 pickaxe: ${JSON.stringify(r)}`);

  // Verify final state — wooden_pickaxe in inventory, table placed in world.
  const finalInv = out.reduce((acc, i) => { acc[i.name] = i.count; return acc; }, {});
  assert.equal(finalInv.wooden_pickaxe, 1, 'pickaxe in inventory at end');
  assert.equal(world.get('1,64,0'), 'crafting_table', 'table placed in world');
});

// ---------------------------------------------------------------------------
// Step 2.6 — Same-species recipe enforcement + consolidator helper
// ---------------------------------------------------------------------------
// Minecraft's real crafting_table / wooden_pickaxe recipes need 4 (or 3) planks
// of the SAME wood species. The current checkRecipePrereqs accepts a mixed
// aggregate, which produced 74% of stuck-loops in the Step 2.5 overnight.

test('Step 2.6 — checkRecipePrereqs rejects mixed-species planks for crafting_table', () => {
  const r = checkRecipePrereqs('crafting_table', [
    { name: 'oak_planks',    count: 2 },
    { name: 'spruce_planks', count: 2 },
  ]);
  assert.equal(r.ok, false, 'mixed 2+2 planks must not satisfy crafting_table (real recipe needs 4 same)');
  assert.ok(Array.isArray(r.missing) && r.missing.length >= 1, 'missing list reports the same-species shortfall');
});

test('Step 2.6 — checkRecipePrereqs accepts 5 same-species planks for crafting_table', () => {
  const r = checkRecipePrereqs('crafting_table', [
    { name: 'spruce_planks', count: 5 },
  ]);
  assert.equal(r.ok, true);
});

test('Step 2.6 — checkRecipePrereqs rejects mixed-species planks for wooden_pickaxe', () => {
  const r = checkRecipePrereqs('wooden_pickaxe', [
    { name: 'oak_planks',    count: 2 },
    { name: 'spruce_planks', count: 1 },
    { name: 'stick',         count: 2 },
  ]);
  assert.equal(r.ok, false, 'wooden_pickaxe needs 3 same-species planks');
});

test('Step 2.6 — consolidateToSingleSpecies picks the species that already meets the need', () => {
  const r = consolidateToSingleSpecies(
    [{ name: 'spruce_planks', count: 5 }, { name: 'oak_planks', count: 2 }],
    4,
  );
  assert.deepEqual(r, { species: 'spruce_planks', haveCount: 5 });
});

test('Step 2.6 — consolidateToSingleSpecies returns null when no single species can reach need without logs', () => {
  const r = consolidateToSingleSpecies(
    [{ name: 'oak_planks', count: 3 }, { name: 'spruce_planks', count: 3 }],
    4,
  );
  assert.equal(r, null);
});

test('Step 2.6 — consolidateToSingleSpecies signals log-craft path when planks+logs can satisfy', () => {
  const r = consolidateToSingleSpecies(
    [{ name: 'oak_planks', count: 2 }, { name: 'spruce_log', count: 3 }],
    4,
  );
  assert.deepEqual(r, {
    species: 'spruce_planks',
    haveCount: 2,
    needCraft: { from: 'spruce_log', logs: 1 },
  });
});
