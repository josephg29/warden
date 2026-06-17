// BUG-CEREBRAS-429: fleet-wide Cerebras token bucket.
// Verifies the bucket correctly throttles aggregate LLM calls to FLEET_LLM_RATE req/s.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { __testing } from '../src/bots/brain.js';

const { fleetBucket, computeBackoffNext, deriveBrainStatus } = __testing;

function reset() {
  fleetBucket._reset();
}

test('Step 2.6 — fleet bucket rate is 6 req/s (raised from 4 after Phase B saturation at 8 effective bots)', () => {
  // Step 2.6 (2026-05-16): overnight Step 2.5 run showed Phase B's 4 r/s cap
  // saturating under sustained 8-bot load, producing exponential-backoff cascades
  // that hit the 300s LLM_BACKOFF_MAX_MS cap (logged as false "brain_stalled"
  // events at 307s/313s/342s). Raised to 6 r/s + lowered backoff cap to 60s so
  // a recovering bot resumes within a minute instead of looking wedged.
  assert.equal(fleetBucket.rate, 6, 'rate must be 6 req/s');
  assert.equal(fleetBucket.capacity, 6, 'capacity must equal rate — no unbounded burst accumulation');
});

test('fleet bucket starts at full capacity', () => {
  reset();
  assert.equal(fleetBucket.tokens, fleetBucket.capacity);
});

test('consume() resolves immediately and decrements tokens when bucket has tokens', async () => {
  reset();
  const before = fleetBucket.tokens;
  const t0 = Date.now();
  await fleetBucket.consume();
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 80, `consume() should be immediate when tokens available, took ${elapsed}ms`);
  assert.ok(fleetBucket.tokens < before, 'token was decremented');
});

test('consume() waits ~167ms when bucket is empty at 6 req/s', async () => {
  reset();
  fleetBucket.tokens = 0;
  fleetBucket.lastRefill = Date.now();
  const t0 = Date.now();
  await fleetBucket.consume();
  const elapsed = Date.now() - t0;
  // At 6 req/s, one token accumulates in ~166.67ms. Allow generous bounds for CI jitter.
  assert.ok(elapsed >= 100, `expected ≥100ms wait at 6 req/s, got ${elapsed}ms`);
  assert.ok(elapsed < 220,  `expected <220ms wait at 6 req/s, got ${elapsed}ms`);
});

test('six sequential consume() calls drain the capacity-6 bucket completely', async () => {
  reset();
  await fleetBucket.consume();
  await fleetBucket.consume();
  await fleetBucket.consume();
  await fleetBucket.consume();
  await fleetBucket.consume();
  await fleetBucket.consume();
  // After 6 immediate consumes the bucket should be empty (or very near 0)
  assert.ok(fleetBucket.tokens < 0.5, `expected <0.5 tokens after draining capacity-6 bucket, got ${fleetBucket.tokens}`);
});

test('Step 2.6 — computeBackoffNext doubles and caps at 60_000ms', () => {
  // Backoff schedule: 0 → 5s → 10s → 20s → 40s → 60s (capped).
  // Was 300_000ms in Step 2.5; lowered so a recovering bot resumes inside a minute
  // instead of being misclassified as a true stall (the 307s/313s/342s "stalls"
  // in the overnight report were really backoff-cap sleeps).
  assert.equal(computeBackoffNext(0), 5000, 'initial backoff = 5s');
  assert.equal(computeBackoffNext(5000), 10000, '5s → 10s');
  assert.equal(computeBackoffNext(20000), 40000, '20s → 40s');
  assert.equal(computeBackoffNext(40000), 60000, '40s → 60s (capped, not 80s)');
  assert.equal(computeBackoffNext(60000), 60000, '60s stays capped at 60s');
});

test('Step 2.6 — deriveBrainStatus distinguishes llm_backoff from stalled', () => {
  const now = Date.now();

  // In active backoff window: status is llm_backoff, NOT stalled — even if
  // lastDecisionTs looks old, because the bot is intentionally sleeping.
  const backoffStatus = deriveBrainStatus({
    llmBackoffUntil: now + 10_000,
    lastDecisionTs: now - 200_000,
  });
  assert.equal(backoffStatus, 'llm_backoff', 'active backoff window → llm_backoff');

  // No backoff but lastDecisionTs is very stale → true stall.
  const stalledStatus = deriveBrainStatus({
    llmBackoffUntil: 0,
    lastDecisionTs: now - 200_000,
  });
  assert.equal(stalledStatus, 'stalled', 'no backoff + stale decision → stalled');

  // No backoff and recent decision → not stalled.
  const okStatus = deriveBrainStatus({
    llmBackoffUntil: 0,
    lastDecisionTs: now - 1_000,
  });
  assert.notEqual(okStatus, 'stalled', 'no backoff + recent decision must not be stalled');
  assert.notEqual(okStatus, 'llm_backoff', 'no backoff + recent decision must not be llm_backoff');
});
