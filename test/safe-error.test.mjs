// BUG-014: verify the rate limit + circuit breaker actually back-pressure.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeError, safeFleetError, __testing } from '../src/safe-error.js';

const { PER_BOT_LIMIT, PER_BOT_WINDOW_MS, FLEET_LIMIT } = __testing;

// Capture console.error so we can count what actually got through.
// Must await fn before restoring — otherwise the finally restores the
// original console.error before the test's setImmediate emits fire.
async function withCapturedStderr(fn) {
  const orig = console.error;
  const captured = [];
  console.error = (...args) => { captured.push(args.join(' ')); };
  try {
    return await fn(captured);
  } finally {
    console.error = orig;
  }
}

// All emits go through setImmediate. Wait one immediate-cycle for everything
// scheduled in the synchronous burst to flush.
function flushImmediates() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('safeError lets PER_BOT_LIMIT events through inside one window', async () => {
  __testing.reset();
  await withCapturedStderr(async (captured) => {
    for (let i = 0; i < PER_BOT_LIMIT; i++) safeError('botA', `msg-${i}`);
    await flushImmediates();
    assert.equal(captured.length, PER_BOT_LIMIT, 'exactly PER_BOT_LIMIT writes should reach stderr');
    for (let i = 0; i < PER_BOT_LIMIT; i++) {
      assert.match(captured[i], new RegExp(`\\[bot:botA\\].*msg-${i}`));
    }
  });
});

test('safeError drops over-limit events but emits a single rate-limit notice', async () => {
  __testing.reset();
  await withCapturedStderr(async (captured) => {
    const burst = PER_BOT_LIMIT + 10;
    for (let i = 0; i < burst; i++) safeError('botA', `msg-${i}`);
    await flushImmediates();
    const writes = captured.filter((line) => line.includes('[bot:botA]'));
    const notices = captured.filter((line) => line.includes('[safe-error:botA]') && line.includes('rate-limit'));
    assert.equal(writes.length, PER_BOT_LIMIT);
    assert.equal(notices.length, 1, 'exactly one rate-limit notice per window');
    assert.match(notices[0], /suppressed in last/);
  });
});

test('per-bot rate-limit windows are independent', async () => {
  __testing.reset();
  await withCapturedStderr(async (captured) => {
    // burst on botA — should hit limit
    for (let i = 0; i < PER_BOT_LIMIT + 3; i++) safeError('botA', `a-${i}`);
    // botB is fresh — should sail through
    for (let i = 0; i < PER_BOT_LIMIT; i++) safeError('botB', `b-${i}`);
    await flushImmediates();
    const aWrites = captured.filter((line) => line.includes('[bot:botA]')).length;
    const bWrites = captured.filter((line) => line.includes('[bot:botB]')).length;
    assert.equal(aWrites, PER_BOT_LIMIT);
    assert.equal(bWrites, PER_BOT_LIMIT, 'botB unaffected by botA back-pressure');
  });
});

test('fleet circuit breaker trips after FLEET_LIMIT cross-bot errors', async () => {
  __testing.reset();
  await withCapturedStderr(async (captured) => {
    // Spread errors across many bot ids so per-bot limits don't trip first.
    for (let i = 0; i < FLEET_LIMIT + 5; i++) {
      safeError(`bot-${i}`, `m-${i}`);
    }
    await flushImmediates();
    const breakerNotices = captured.filter((l) => l.includes('fleet error rate exceeded'));
    assert.equal(breakerNotices.length, 1, 'exactly one fleet-breaker notice on trip');
    const writes = captured.filter((l) => l.includes('[bot:bot-'));
    // Up to FLEET_LIMIT writes get through; the rest are dropped silently.
    assert.ok(writes.length <= FLEET_LIMIT, `expected <= ${FLEET_LIMIT} writes, got ${writes.length}`);
  });
});

test('safeFleetError tags as [bot:fleet]', async () => {
  __testing.reset();
  await withCapturedStderr(async (captured) => {
    safeFleetError('hello world');
    await flushImmediates();
    assert.equal(captured.length, 1);
    assert.match(captured[0], /\[bot:fleet\].*hello world/);
  });
});

test('emit is asynchronous — the call site never blocks', async () => {
  __testing.reset();
  await withCapturedStderr(async (captured) => {
    safeError('botA', 'sync check');
    // Before the immediate fires, nothing should be in captured yet.
    assert.equal(captured.length, 0, 'emits must defer past the current tick');
    await flushImmediates();
    assert.equal(captured.length, 1);
  });
});
