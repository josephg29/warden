// Step 2.6 (commit 3176b5d): the live dashboard (agora-site/live.html) added
// 'llm_backoff' to the warn-pill branch so a human operator sees a yellow pill
// when a bot is intentionally paused on Cerebras 429s — distinct from green
// (active) and red (disconnected) and same yellow as 'stalled'.
//
// pillClass lives inside a browser-side <script> in agora-site/live.html and
// can't be imported. To keep this test free of bots/ imports and free of a
// headless browser dep, we re-implement the function inline from the source
// and pin its behavior. If agora-site/live.html#pillClass changes, this
// test will diverge from the live dashboard — that drift is the signal to
// update both in lockstep.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Mirrors agora-site/live.html pillClass (commit 3176b5d).
function pillClass(brainStatus, state, lastDecisionAgeS) {
  if (state !== 'connected') return 'bad';
  if (brainStatus === 'stalled' || brainStatus === 'error' || brainStatus === 'llm_backoff') return 'warn';
  if (lastDecisionAgeS != null && lastDecisionAgeS > 60) return 'warn';
  return 'ok';
}

// Mirrors agora-site/live.html per-bot brain pill class expression.
function brainPillClass(brainStatus) {
  if (brainStatus === 'active') return 'ok';
  if (brainStatus === 'stalled' || brainStatus === 'llm_backoff') return 'warn';
  return '';
}

test('pillClass: disconnected → bad regardless of brain state', () => {
  assert.equal(pillClass('active',      'disconnected', 1),   'bad');
  assert.equal(pillClass('llm_backoff', 'connecting',   1),   'bad');
  assert.equal(pillClass('stalled',     null,           1),   'bad');
});

test('pillClass: active + fresh decision → ok (green)', () => {
  assert.equal(pillClass('active', 'connected', 5),    'ok');
  assert.equal(pillClass('active', 'connected', 60),   'ok');
  assert.equal(pillClass('active', 'connected', null), 'ok');
});

test('pillClass: stalled → warn (yellow)', () => {
  assert.equal(pillClass('stalled', 'connected', 5), 'warn');
});

test('pillClass: error → warn (yellow) — legacy status still mapped', () => {
  assert.equal(pillClass('error', 'connected', 5), 'warn');
});

test('Step 2.6: pillClass maps llm_backoff → warn (yellow), NOT bad', () => {
  // The whole point of Step 2.6's llm_backoff split: intentional pause is
  // visible to a human (yellow) but the watchdog treats it as healthy.
  assert.equal(pillClass('llm_backoff', 'connected', 5),   'warn');
  assert.equal(pillClass('llm_backoff', 'connected', 600), 'warn');
});

test('pillClass: stale decision (>60s) on otherwise-active bot → warn', () => {
  assert.equal(pillClass('active', 'connected', 61),  'warn');
  assert.equal(pillClass('active', 'connected', 120), 'warn');
});

test('brainPillClass: active → ok, stalled → warn, llm_backoff → warn, other → empty', () => {
  assert.equal(brainPillClass('active'),      'ok');
  assert.equal(brainPillClass('stalled'),     'warn');
  assert.equal(brainPillClass('llm_backoff'), 'warn');
  // Step 2.6: legacy 'error' status is NOT in the per-bot brain pill warn set —
  // matching the source: only 'stalled' || 'llm_backoff'.
  assert.equal(brainPillClass('error'),       '');
  assert.equal(brainPillClass('thinking'),    '');
  assert.equal(brainPillClass(undefined),     '');
});
