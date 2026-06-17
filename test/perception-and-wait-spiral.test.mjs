// Phase C (Step 2.5, 2026-05-11): perception + wait-spiral detector.
//
// Run with:  node --test test/perception-and-wait-spiral.test.mjs
//
// C1 — summarizeSurroundings: structured 5-closest-trees + 5-closest-ores +
//      facing direction. Replaces the existing "Nearby blocks" line with a
//      richer summary the LLM can act on.
// C2 — detectWaitSpiral: >3 wait actions in last 8 decisions while a goal
//      is active → a memory hint to abandon the approach.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import minecraftData from 'minecraft-data';

import {
  summarizeSurroundings,
  detectWaitSpiral,
  facingFromYaw,
  breakRegroupWait,
  __testing,
} from '../src/bots/brain.js';

const { SKILLS } = __testing;
const mcData = minecraftData('1.21.4');

// ---------------------------------------------------------------------------
// Bot mocking helpers
// ---------------------------------------------------------------------------

function makeVec3(x, y, z) {
  function V(xx, yy, zz) {
    if (!(this instanceof V)) return new V(xx, yy, zz);
    this.x = xx; this.y = yy; this.z = zz;
  }
  V.prototype.offset = function (dx, dy, dz) { return new V(this.x + dx, this.y + dy, this.z + dz); };
  V.prototype.distanceTo = function (p) {
    const dx = this.x - p.x, dy = this.y - p.y, dz = this.z - p.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  };
  V.prototype.floored = function () { return new V(this.x | 0, this.y | 0, this.z | 0); };
  return new V(x, y, z);
}

// Builds a bot whose findBlock returns the closest block matching `id` from a
// canned world map. Sufficient for surroundings tests — we only care about
// distance and name, not the full world.
function makeBotWithBlocks(blocks, opts = {}) {
  const me = opts.position ?? makeVec3(0, 64, 0);
  // Index canned blocks by integer-coord key so blockAt lookups stay
  // consistent with findBlocks (matches mineflayer's actual behavior).
  const byKey = new Map();
  for (const b of blocks) {
    const id = mcData.blocksByName[b.name]?.id ?? -1;
    byKey.set(`${b.x | 0},${b.y | 0},${b.z | 0}`, { name: b.name, type: id });
  }
  return {
    username: 'TestBot',
    version: '1.21.4',
    entity: { position: me, yaw: opts.yaw ?? 0 },
    inventory: { items: () => [] },
    findBlock: ({ matching }) => {
      const ids = Array.isArray(matching) ? new Set(matching) : new Set([matching]);
      let best = null, bestD = Infinity;
      for (const b of blocks) {
        const id = mcData.blocksByName[b.name]?.id;
        if (!ids.has(id)) continue;
        const dx = b.x - me.x, dy = b.y - me.y, dz = b.z - me.z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d < bestD) { bestD = d; best = { name: b.name, position: makeVec3(b.x, b.y, b.z), type: id }; }
      }
      return best;
    },
    findBlocks: ({ matching, maxDistance = 32, count = 5 }) => {
      const ids = Array.isArray(matching) ? new Set(matching) : new Set([matching]);
      const out = [];
      for (const b of blocks) {
        const id = mcData.blocksByName[b.name]?.id;
        if (!ids.has(id)) continue;
        const dx = b.x - me.x, dy = b.y - me.y, dz = b.z - me.z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d <= maxDistance) out.push({ ...b, _d: d });
      }
      out.sort((a, b) => a._d - b._d);
      return out.slice(0, count).map((b) => makeVec3(b.x, b.y, b.z));
    },
    blockAt: (p) => {
      const k = `${p.x | 0},${p.y | 0},${p.z | 0}`;
      const hit = byKey.get(k);
      if (hit) return { ...hit, position: makeVec3(p.x | 0, p.y | 0, p.z | 0) };
      return { name: 'air', type: mcData.blocksByName.air.id, position: makeVec3(p.x | 0, p.y | 0, p.z | 0) };
    },
    on: () => {},
    once: () => {},
    pathfinder: { setGoal: () => {}, goto: async () => {} },
  };
}

// ---------------------------------------------------------------------------
// C1 — facingFromYaw (pure)
// ---------------------------------------------------------------------------

test('C1 — facingFromYaw maps mineflayer yaw to compass directions', () => {
  // Mineflayer convention: yaw 0 → south, π/2 → west (counterclockwise positive).
  // The function rounds to nearest cardinal and returns a string.
  assert.equal(facingFromYaw(0),               'south');
  assert.equal(facingFromYaw(Math.PI / 2),     'west');
  assert.equal(facingFromYaw(Math.PI),         'north');
  assert.equal(facingFromYaw(-Math.PI / 2),    'east');
  // Non-cardinal yaws snap to nearest
  assert.equal(facingFromYaw(0.3),             'south');
  assert.equal(facingFromYaw(Math.PI / 4 + 0.05), 'south-west');
});

// ---------------------------------------------------------------------------
// C1 — summarizeSurroundings (pure)
// ---------------------------------------------------------------------------

test('C1 — summarizeSurroundings returns 5 closest trees sorted by distance', () => {
  const blocks = [
    { name: 'oak_log',    x: 30, y: 64, z: 0  },  // 30
    { name: 'oak_log',    x: 5,  y: 64, z: 0  },  // 5
    { name: 'birch_log',  x: 0,  y: 64, z: 12 },  // 12
    { name: 'spruce_log', x: 0,  y: 64, z: 8  },  // 8
    { name: 'oak_log',    x: 0,  y: 64, z: 20 },  // 20
    { name: 'cherry_log', x: 0,  y: 64, z: 60 },  // outside default 32m
  ];
  const bot = makeBotWithBlocks(blocks);
  const r = summarizeSurroundings(bot, mcData);
  assert.equal(r.trees.length, 5, '5 closest within range');
  // verify sorting
  for (let i = 1; i < r.trees.length; i++) {
    assert.ok(r.trees[i].dist >= r.trees[i - 1].dist, 'sorted ascending');
  }
  // closest should be (5,64,0)
  assert.equal(r.trees[0].name, 'oak_log');
  assert.equal(Math.round(r.trees[0].dist), 5);
});

test('C1 — summarizeSurroundings returns up to 5 closest ores within 32m, sorted', () => {
  // All these are within 32m of (0,64,0):
  //   coal_ore @(10,60,0)    → √(100+16) ≈ 10.8m
  //   iron_ore @(0,50,5)     → √(196+25) ≈ 14.9m
  //   copper_ore @(20,55,0)  → √(400+81) ≈ 21.9m
  //   gold_ore @(0,40,8)     → √(576+64) ≈ 25.3m
  //   redstone_ore @(15,55,15) → √(225+81+225) ≈ 23.0m
  // diamond_ore @(0,5,0) is 59m away — out of range.
  const blocks = [
    { name: 'coal_ore',     x: 10, y: 60, z: 0  },
    { name: 'iron_ore',     x: 0,  y: 50, z: 5  },
    { name: 'diamond_ore',  x: 0,  y: 5,  z: 0  },  // out of range
    { name: 'copper_ore',   x: 20, y: 55, z: 0  },
    { name: 'gold_ore',     x: 0,  y: 40, z: 8  },
    { name: 'redstone_ore', x: 15, y: 55, z: 15 },
  ];
  const bot = makeBotWithBlocks(blocks);
  const r = summarizeSurroundings(bot, mcData);
  assert.equal(r.ores.length, 5, 'all 5 in-range ores reported');
  // verify sorting + closest is coal_ore
  for (let i = 1; i < r.ores.length; i++) {
    assert.ok(r.ores[i].dist >= r.ores[i - 1].dist, 'sorted ascending');
  }
  assert.equal(r.ores[0].name, 'coal_ore');
  // out-of-range diamond_ore must NOT appear
  const oreNames = r.ores.map((o) => o.name);
  assert.ok(!oreNames.includes('diamond_ore'), 'out-of-range ore excluded');
});

test('C1 — summarizeSurroundings returns facing direction', () => {
  const bot = makeBotWithBlocks([], { yaw: 0 });
  const r = summarizeSurroundings(bot, mcData);
  assert.equal(r.facing, 'south');
});

test('C1 — summarizeSurroundings.toString() is a compact prompt-ready string', () => {
  const blocks = [
    { name: 'oak_log',  x: 5,  y: 64, z: 0 },
    { name: 'iron_ore', x: 0,  y: 50, z: 5 },
  ];
  const bot = makeBotWithBlocks(blocks, { yaw: -Math.PI / 2 });
  const r = summarizeSurroundings(bot, mcData);
  const s = r.toString();
  assert.match(s, /facing east/i);
  assert.match(s, /oak_log/);
  assert.match(s, /iron_ore/);
});

test('C1 — summarizeSurroundings handles empty world gracefully', () => {
  const bot = makeBotWithBlocks([]);
  const r = summarizeSurroundings(bot, mcData);
  assert.equal(r.trees.length, 0);
  assert.equal(r.ores.length, 0);
  assert.match(r.toString(), /no trees/i);
});

// ---------------------------------------------------------------------------
// C1 — SKILLS.look_around emits surroundings in its result
// ---------------------------------------------------------------------------

test('C1 — SKILLS.look_around returns surroundings in its ok result', async () => {
  const blocks = [
    { name: 'oak_log',  x: 5, y: 64, z: 0 },
    { name: 'iron_ore', x: 0, y: 60, z: 5 },
  ];
  const bot = makeBotWithBlocks(blocks);
  bot.look = async () => {};  // mineflayer's bot.look
  const ac = new AbortController();
  const r = await SKILLS.look_around({ bot, signal: ac.signal, mcData }, { turns: 1 });
  assert.equal(r.ok, true);
  assert.ok(r.surroundings, 'returns surroundings object');
  assert.ok(Array.isArray(r.surroundings.trees));
  assert.ok(Array.isArray(r.surroundings.ores));
  assert.equal(r.surroundings.trees[0].name, 'oak_log');
});

// ---------------------------------------------------------------------------
// C2 — detectWaitSpiral (pure)
// ---------------------------------------------------------------------------

function dec(type, args = {}, ts = Date.now()) {
  return { type, args, ts };
}

test('C2 — detectWaitSpiral: no spiral when fewer than 4 waits in window', () => {
  const r = detectWaitSpiral([
    dec('wait'), dec('craft'), dec('wait'), dec('look_around'),
    dec('wait'), dec('collect_block'),
  ], 'craft a wooden pickaxe');
  assert.equal(r.spiral, false);
  assert.equal(r.waitCount, 3);
});

test('C2 — detectWaitSpiral: spiral fires at 4 waits in last 8 with active goal', () => {
  const r = detectWaitSpiral([
    dec('look_around'), dec('craft'), dec('wait'), dec('wait'),
    dec('wait'), dec('look_around'), dec('wait'), dec('chat_only'),
  ], 'craft a wooden pickaxe');
  assert.equal(r.spiral, true);
  assert.equal(r.waitCount, 4);
});

test('C2 — detectWaitSpiral: only looks at last 8 decisions', () => {
  const decs = [
    dec('wait'), dec('wait'), dec('wait'), dec('wait'),  // outside window
    dec('craft'), dec('craft'), dec('craft'), dec('craft'),
    dec('craft'), dec('craft'), dec('craft'), dec('craft'),
  ];
  const r = detectWaitSpiral(decs, 'craft a wooden pickaxe');
  assert.equal(r.spiral, false);
});

test('C2 — detectWaitSpiral: does NOT fire when no active goal', () => {
  const r = detectWaitSpiral([
    dec('wait'), dec('wait'), dec('wait'), dec('wait'),
    dec('wait'), dec('wait'), dec('wait'), dec('wait'),
  ], null);
  assert.equal(r.spiral, false);
  assert.equal(r.reason, 'no_goal');
});

test('C2 — detectWaitSpiral: empty-string goal counts as no goal', () => {
  const r = detectWaitSpiral([
    dec('wait'), dec('wait'), dec('wait'), dec('wait'),
    dec('wait'), dec('wait'), dec('wait'), dec('wait'),
  ], '   ');
  assert.equal(r.spiral, false);
});

// ---------------------------------------------------------------------------
// breakRegroupWait — BUG-001 mitigation: when paralysis override has rewritten
// the goal to "stuck — regroup ..." but the LLM keeps picking wait, force a
// look_around so the bot re-perceives and has a chance to do something useful.
// ---------------------------------------------------------------------------

test('breakRegroupWait — forces look_around when regroup goal + wait action', () => {
  const goal = 'stuck — regroup and pick a new objective unrelated to the previous one';
  const out = breakRegroupWait(goal, { type: 'wait', args: { seconds: 30 } });
  assert.deepEqual(out, { type: 'look_around', args: { turns: 4 } });
});

test('breakRegroupWait — case/whitespace tolerant + hyphen variant', () => {
  const a = breakRegroupWait('  Stuck - regroup and try again', { type: 'wait', args: { seconds: 5 } });
  assert.equal(a.type, 'look_around');
  const b = breakRegroupWait('STUCK — regroup now', { type: 'wait', args: {} });
  assert.equal(b.type, 'look_around');
});

test('breakRegroupWait — no-op when goal is not a regroup goal', () => {
  const action = { type: 'wait', args: { seconds: 30 } };
  const out = breakRegroupWait('mine 4 oak_logs', action);
  assert.strictEqual(out, action); // unchanged reference
});

test('breakRegroupWait — no-op when action is not wait', () => {
  const action = { type: 'collect_block', args: { block: 'oak_log' } };
  const out = breakRegroupWait('stuck — regroup', action);
  assert.strictEqual(out, action);
});

test('breakRegroupWait — null/empty goal returns action unchanged', () => {
  const action = { type: 'wait', args: { seconds: 30 } };
  assert.strictEqual(breakRegroupWait(null, action), action);
  assert.strictEqual(breakRegroupWait('', action), action);
  assert.strictEqual(breakRegroupWait(undefined, action), action);
});
