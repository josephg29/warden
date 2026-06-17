// OVN-011: pruner less aggressive — require 2 contradictions before
// removing a learned fact. The previous policy threw away useful heuristics
// like "jump_loop can be broken by switching to goto_item or pillar_up" the
// first time the LLM logged a related failure.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';

import { PlayerMemory } from '../src/bots/player-memory.js';

async function makeMemory() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mem-pruner-'));
  // PlayerMemory constructor uses opts.dataDir. memory file goes to
  // <dataDir>/memory/<botId>.json. The dir doesn't need to exist for tests
  // that don't call load()/persist().
  const m = new PlayerMemory('TestPruner', {
    dataDir: dir,
    log: () => {},  // silence logs in tests
  });
  return { m, dir, cleanup: () => fsp.rm(dir, { recursive: true, force: true }) };
}

// Inputs are crafted to land cleanly on the existing pruner's polarity
// classifier (player-memory.js:512-516). POSITIVE matches "works"/"reliable";
// NEGATIVE matches "fail"/"missing". Stopwords filtered out leave the
// salient tokens (wooden_pickaxe, stone, etc.) for the overlap check.
const POSITIVE_TEXT = 'wooden_pickaxe works on stone reliably';
const POSITIVE_TEXT_2 = 'iron_sword is reliable to kill zombies';

test('OVN-011: first contradiction does NOT prune the fact', async () => {
  const { m, cleanup } = await makeMemory();
  try {
    m.applyUpdate({ add_learned: POSITIVE_TEXT }, { position: null });
    assert.equal(m._state.learned.length, 1, 'fact should be added');

    // Negative contradiction sharing salient tokens (wooden_pickaxe, stone)
    m.applyUpdate({ add_learned: 'wooden_pickaxe missing — stone too hard' }, { position: null });

    const original = m._state.learned.find((f) => f.text === POSITIVE_TEXT);
    assert.ok(original, 'positive fact must survive single contradiction');
    assert.equal(original.contradictionCount, 1, 'contradiction strike should be recorded');
  } finally {
    await cleanup();
  }
});

test('OVN-011: second contradiction prunes the fact', async () => {
  const { m, cleanup } = await makeMemory();
  try {
    m.applyUpdate({ add_learned: POSITIVE_TEXT }, { position: null });

    m.applyUpdate({ add_learned: 'wooden_pickaxe missing — stone too hard' }, { position: null });
    const afterFirst = m._state.learned.find((f) => f.text === POSITIVE_TEXT);
    assert.ok(afterFirst, 'first contradiction must keep the fact');
    assert.equal(afterFirst.contradictionCount, 1);

    // Different wording, same shared tokens (wooden_pickaxe, stone) so the
    // polarity classifier still detects a contradiction.
    m.applyUpdate({ add_learned: 'wooden_pickaxe fails on stone consistently' }, { position: null });
    const afterSecond = m._state.learned.find((f) => f.text === POSITIVE_TEXT);
    assert.equal(afterSecond, undefined, 'second contradiction must prune the fact');
  } finally {
    await cleanup();
  }
});

test('OVN-011: unrelated facts are not affected', async () => {
  const { m, cleanup } = await makeMemory();
  try {
    m.applyUpdate({ add_learned: POSITIVE_TEXT }, { position: null });
    m.applyUpdate({ add_learned: POSITIVE_TEXT_2 }, { position: null });
    assert.equal(m._state.learned.length, 2);

    // contradict the pickaxe fact only
    m.applyUpdate({ add_learned: 'wooden_pickaxe missing — stone too hard' }, { position: null });

    const swordFact = m._state.learned.find((f) => f.text === POSITIVE_TEXT_2);
    assert.ok(swordFact, 'unrelated fact must survive');
    assert.equal(swordFact.contradictionCount ?? 0, 0, 'unrelated fact must not accrue strikes');
  } finally {
    await cleanup();
  }
});
