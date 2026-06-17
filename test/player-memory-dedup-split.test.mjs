// 2026-05-12 follow-up to Phase D: a shared 0.40 paraphrase threshold ate
// legitimate learned facts down to 0-1 on two of eight bots in the fleet run.
// The threshold is now split — LEARNED stays at the prior 0.55 (only true
// paraphrases collapse) and FAILED uses the tighter 0.40 (near-duplicate
// failure wordings still collapse so failed_attempts stays signal-dense).
//
// Run with:  node --test test/player-memory-dedup-split.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';

import { PlayerMemory, jaccardSimilarity, memoryTokens } from '../src/bots/player-memory.js';

async function makeMemory() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mem-dedup-'));
  const m = new PlayerMemory('TestDedupSplit', {
    dataDir: dir,
    log: () => {},
  });
  return { m, cleanup: () => fsp.rm(dir, { recursive: true, force: true }) };
}

// Pair crafted so the Jaccard similarity lands BETWEEN the two thresholds:
//  - tokens(T1) = {craft, pickaxe, failed, without, enough, wood, material} (7)
//  - tokens(T2) = {missing, wood, material, craft, pickaxe, stop}            (6)
//  - shared    = {craft, pickaxe, wood, material}                            (4)
//  - union     = 9 ⇒ Jaccard = 4/9 ≈ 0.444
// → above 0.40 (failed rejects), below 0.55 (learned accepts).
const TEXT_A = 'craft pickaxe failed without enough wood material';
const TEXT_B = 'missing wood material to craft pickaxe stop';

test('sanity — TEXT_A vs TEXT_B Jaccard sits between the two thresholds', () => {
  const sim = jaccardSimilarity(memoryTokens(TEXT_A), memoryTokens(TEXT_B));
  assert.ok(sim > 0.40, `expected > 0.40, got ${sim.toFixed(3)}`);
  assert.ok(sim < 0.55, `expected < 0.55, got ${sim.toFixed(3)}`);
});

test('add_learned — distinct-enough near-duplicate is ACCEPTED (0.55 threshold)', async () => {
  const { m, cleanup } = await makeMemory();
  try {
    m.applyUpdate({ add_learned: TEXT_A }, { position: null });
    m.applyUpdate({ add_learned: TEXT_B }, { position: null });
    assert.equal(m._state.learned.length, 2, 'both learned entries should land — Jaccard < 0.55');
  } finally {
    await cleanup();
  }
});

test('add_failed — same near-duplicate IS rejected (0.40 threshold)', async () => {
  const { m, cleanup } = await makeMemory();
  try {
    m.applyUpdate({ add_failed: TEXT_A }, { position: null });
    m.applyUpdate({ add_failed: TEXT_B }, { position: null });
    assert.equal(m._state.failed_attempts.length, 1, 'second failed entry should be dropped — Jaccard > 0.40');
  } finally {
    await cleanup();
  }
});

test('add_learned — true paraphrase (very high Jaccard) is still rejected', async () => {
  const { m, cleanup } = await makeMemory();
  try {
    const original = 'wooden_pickaxe works on stone reliably';
    const paraphrase = 'wooden_pickaxe works reliably on stone';
    m.applyUpdate({ add_learned: original }, { position: null });
    m.applyUpdate({ add_learned: paraphrase }, { position: null });
    assert.equal(m._state.learned.length, 1, 'second entry should fold — true paraphrase');
  } finally {
    await cleanup();
  }
});

test('add_failed — disjoint failures both land', async () => {
  const { m, cleanup } = await makeMemory();
  try {
    m.applyUpdate({ add_failed: 'goto_block birch_log: pathfind blocked' }, { position: null });
    m.applyUpdate({ add_failed: 'craft wooden_pickaxe: missing prereqs sticks' }, { position: null });
    assert.equal(m._state.failed_attempts.length, 2);
  } finally {
    await cleanup();
  }
});
