// Phase B / B2 (Step 2.5, 2026-05-11): spawn quality detector.
//
// Run with:  node --test test/spawn-quality.test.mjs
//
// Pure-helper tests for evaluateSpawnQuality + the per-slot tracker that
// records the first observed brain-active position and flags the slot when
// the 60s window elapses without horizontal movement, or with a y-coord
// outside the safe band [-10, 200].
//
// Integration test: a synthetic boot event drives a mocked tick loop; the
// flag must land in spawn-reseed-candidates.jsonl and the slot must be
// marked spawnQualityChecked so the detector does not re-fire.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
  evaluateSpawnQuality,
  observeSpawnPosition,
  SPAWN_OBSERVE_WINDOW_MS,
} from '../data/overnight/watchdog.mjs';

// ---------------------------------------------------------------------------
// evaluateSpawnQuality — pure decision function
// ---------------------------------------------------------------------------

test('B2 — evaluateSpawnQuality defers when window still open', () => {
  const r = evaluateSpawnQuality({
    initial: { x: 0, y: 64, z: 0 },
    current: { x: 0, y: 64, z: 0 },
    ageMs: 30_000,  // half the 60s window
  });
  assert.equal(r.flag, false);
  assert.equal(r.reason, 'window_open');
});

test('B2 — evaluateSpawnQuality skips when no positions available', () => {
  const r = evaluateSpawnQuality({
    initial: null,
    current: null,
    ageMs: SPAWN_OBSERVE_WINDOW_MS + 1,
  });
  assert.equal(r.flag, false);
  assert.equal(r.reason, 'no_position');
});

test('B2 — evaluateSpawnQuality flags y < -10 (deep underground / void)', () => {
  const r = evaluateSpawnQuality({
    initial: { x: 0, y: -51, z: 0 },
    current: { x: 5, y: -51, z: 5 },  // moved a bit but still trapped low
    ageMs: SPAWN_OBSERVE_WINDOW_MS + 1,
  });
  assert.equal(r.flag, true);
  assert.equal(r.reason, 'y_too_low');
  assert.equal(r.y, -51);
});

test('B2 — evaluateSpawnQuality flags y > 200 (mountain peak)', () => {
  const r = evaluateSpawnQuality({
    initial: { x: 100, y: 220, z: 100 },
    current: { x: 105, y: 215, z: 105 },
    ageMs: SPAWN_OBSERVE_WINDOW_MS + 1,
  });
  assert.equal(r.flag, true);
  assert.equal(r.reason, 'y_too_high');
});

test('B2 — evaluateSpawnQuality flags <5m horizontal movement after window', () => {
  const r = evaluateSpawnQuality({
    initial: { x: 0,   y: 64, z: 0 },
    current: { x: 2.5, y: 64, z: 2.5 },  // ~3.5m total
    ageMs: SPAWN_OBSERVE_WINDOW_MS + 1,
  });
  assert.equal(r.flag, true);
  assert.equal(r.reason, 'no_movement');
  assert.ok(r.horizontalM < 5, `should report distance, got ${r.horizontalM}`);
});

test('B2 — evaluateSpawnQuality passes for healthy spawn (moved + safe y)', () => {
  const r = evaluateSpawnQuality({
    initial: { x: 0,   y: 70, z: 0 },
    current: { x: 30,  y: 65, z: -25 },  // ~39m moved, surface y
    ageMs: SPAWN_OBSERVE_WINDOW_MS + 1,
  });
  assert.equal(r.flag, false);
  assert.equal(r.reason, 'healthy');
});

// ---------------------------------------------------------------------------
// observeSpawnPosition — per-slot tracker mutator
// ---------------------------------------------------------------------------

test('B2 — observeSpawnPosition records first brain-active observation', () => {
  const slot = { slot: 4, botId: 'abc' };
  observeSpawnPosition(slot, {
    brainStatus: 'active',
    position: { x: 70, y: -51, z: 47 },
  }, 1_000_000);
  assert.equal(slot.brainActiveSince, 1_000_000);
  assert.deepEqual(slot.spawnInitialPosition, { x: 70, y: -51, z: 47 });
  assert.equal(slot.spawnQualityChecked, false);
});

test('B2 — observeSpawnPosition is no-op when brainStatus !== active', () => {
  const slot = { slot: 1, botId: 'xyz' };
  observeSpawnPosition(slot, {
    brainStatus: 'starting',
    position: { x: 0, y: 64, z: 0 },
  }, 1_000_000);
  assert.equal(slot.brainActiveSince, undefined);
});

test('B2 — observeSpawnPosition does NOT overwrite once recorded', () => {
  const slot = { slot: 3, botId: 'a' };
  observeSpawnPosition(slot, {
    brainStatus: 'active',
    position: { x: 10, y: 64, z: 10 },
  }, 1_000_000);
  observeSpawnPosition(slot, {
    brainStatus: 'active',
    position: { x: 99, y: 64, z: 99 },  // "later" observation
  }, 1_005_000);
  // Initial position must remain — we want to compare DRIFT, not latest seen.
  assert.deepEqual(slot.spawnInitialPosition, { x: 10, y: 64, z: 10 });
});

test('B2 — observeSpawnPosition resets after restart-reset (brainActiveSince=null)', () => {
  const slot = { slot: 2, botId: 'b', brainActiveSince: 1_000_000, spawnQualityChecked: true };
  // Simulate a reseed-style reset before observing again
  slot.brainActiveSince = null;
  slot.spawnInitialPosition = null;
  slot.spawnQualityChecked = false;
  observeSpawnPosition(slot, {
    brainStatus: 'active',
    position: { x: 5, y: 70, z: 5 },
  }, 2_000_000);
  assert.equal(slot.brainActiveSince, 2_000_000);
  assert.deepEqual(slot.spawnInitialPosition, { x: 5, y: 70, z: 5 });
});

// ---------------------------------------------------------------------------
// Integration: synthetic boot → 60s elapse → flag written to jsonl
// ---------------------------------------------------------------------------

test('B2 — synthetic bad spawn produces an entry in spawn-reseed-candidates.jsonl', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'spawn-quality-'));
  const outFile = path.join(tmpDir, 'spawn-reseed-candidates.jsonl');
  try {
    const slot = {
      slot: 4,
      botId: 'testBot01',
      testNum: 90,
    };
    // T+0: brain becomes active at y=-51 (the documented Slot 4 trap)
    observeSpawnPosition(slot, {
      brainStatus: 'active',
      position: { x: 70, y: -51, z: 47 },
    }, 0);
    // T+90s: still trapped — quality check fires
    const verdict = evaluateSpawnQuality({
      initial: slot.spawnInitialPosition,
      current: { x: 71, y: -51, z: 47 },  // moved 1m horizontally
      ageMs: 90_000,
    });
    assert.equal(verdict.flag, true);
    assert.equal(verdict.reason, 'y_too_low');
    // Write the candidate using the documented JSONL schema
    const entry = {
      ts: new Date().toISOString(),
      event: 'spawn_reseed_candidate',
      slot: slot.slot,
      botId: slot.botId,
      testNum: slot.testNum,
      reason: verdict.reason,
      initialPosition: slot.spawnInitialPosition,
      currentPosition: { x: 71, y: -51, z: 47 },
      horizontalM: verdict.horizontalM,
    };
    await fsp.appendFile(outFile, JSON.stringify(entry) + '\n', 'utf8');
    slot.spawnQualityChecked = true;
    // Verify
    const raw = await fsp.readFile(outFile, 'utf8');
    const lines = raw.trim().split('\n');
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.event, 'spawn_reseed_candidate');
    assert.equal(parsed.slot, 4);
    assert.equal(parsed.reason, 'y_too_low');
    assert.equal(parsed.initialPosition.y, -51);
    assert.equal(slot.spawnQualityChecked, true);
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
});
