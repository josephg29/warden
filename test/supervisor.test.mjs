// OVN-001/016: supervisor backoff math + stale-pid cleanup.
// The supervisor itself is exercised manually via the smoke tests in
// RUNBOOK.md — these tests cover the pure helpers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { __testing } from '../scripts/supervisor.mjs';

const { nextBackoffMs, cleanupStalePids, processAlive } = __testing;

test('OVN-001: nextBackoffMs doubles each attempt and caps at 60s', () => {
  assert.equal(nextBackoffMs(1), 1_000);
  assert.equal(nextBackoffMs(2), 2_000);
  assert.equal(nextBackoffMs(3), 4_000);
  assert.equal(nextBackoffMs(4), 8_000);
  assert.equal(nextBackoffMs(5), 16_000);
  assert.equal(nextBackoffMs(6), 32_000);
  assert.equal(nextBackoffMs(7), 60_000); // 64 → cap
  assert.equal(nextBackoffMs(20), 60_000); // far past cap
});

test('OVN-001: nextBackoffMs handles zero/negative defensively', () => {
  // attempt=0 should not produce a sub-second delay (could thunder)
  assert.ok(nextBackoffMs(0) >= 1_000, `got ${nextBackoffMs(0)}`);
  assert.ok(nextBackoffMs(-1) >= 1_000, `got ${nextBackoffMs(-1)}`);
});

test('OVN-016: cleanupStalePids removes files for dead pids and keeps live ones', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sup-pid-'));
  try {
    // Write a stale pid (huge unused number)
    const stalePid = 999_999_999;
    assert.equal(processAlive(stalePid), false, 'precondition: stale pid must be dead');
    await fsp.writeFile(path.join(tmpDir, 'dashboard.pid'), String(stalePid));

    // Write a live pid (this process)
    await fsp.writeFile(path.join(tmpDir, 'watchdog.pid'), String(process.pid));

    // Write a malformed pid
    await fsp.writeFile(path.join(tmpDir, 'broken.pid'), 'not-a-number');

    // Non-pid file should be ignored
    await fsp.writeFile(path.join(tmpDir, 'state.json'), '{}');

    const removed = await cleanupStalePids(tmpDir);

    const removedNames = removed.map((r) => path.basename(r.file)).sort();
    assert.deepEqual(removedNames, ['broken.pid', 'dashboard.pid'].sort());

    // Live pid file must remain.
    const remaining = (await fsp.readdir(tmpDir)).sort();
    assert.deepEqual(remaining, ['state.json', 'watchdog.pid']);

    // Verify reasons.
    const dashEntry = removed.find((r) => path.basename(r.file) === 'dashboard.pid');
    assert.equal(dashEntry.reason, 'process_dead');
    const brokenEntry = removed.find((r) => path.basename(r.file) === 'broken.pid');
    assert.equal(brokenEntry.reason, 'malformed');
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
});

test('OVN-016: cleanupStalePids on missing dir returns []', async () => {
  const ghost = path.join(os.tmpdir(), `nope-${Date.now()}-${Math.random()}`);
  const removed = await cleanupStalePids(ghost);
  assert.deepEqual(removed, []);
});
