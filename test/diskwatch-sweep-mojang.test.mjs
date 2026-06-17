// Step 2.6 (2026-05-16): sweepOneSlotDir must preserve cache/mojang_*.jar
// across slot recycles. The previous unconditional `rm -rf cache/` forced
// PaperMC to re-download mojang_<ver>.jar on every recycle, and a flaky
// Mojang CDN response left the slot unable to boot. See diskwatch.js (the
// `if (sub === 'cache')` branch) and commit 4d43210.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { sweepOneSlotDir } from '../src/diskwatch.js';

async function makeSlot() {
  const slot = await fsp.mkdtemp(path.join(os.tmpdir(), 'sweep-slot-'));
  await fsp.mkdir(path.join(slot, 'cache'), { recursive: true });
  await fsp.mkdir(path.join(slot, 'logs'), { recursive: true });
  await fsp.mkdir(path.join(slot, 'crash-reports'), { recursive: true });
  return slot;
}

test('sweepOneSlotDir preserves cache/mojang_*.jar and wipes the rest of cache/', async () => {
  const slot = await makeSlot();
  try {
    const cache = path.join(slot, 'cache');
    await fsp.writeFile(path.join(cache, 'mojang_1.21.4.jar'),  'mojang-jar-bytes');
    await fsp.writeFile(path.join(cache, 'mojang_1.20.1.jar'),  'older-jar-bytes');
    await fsp.writeFile(path.join(cache, 'some_other_file.dat'), 'should-be-wiped');
    await fsp.writeFile(path.join(cache, 'patches.bin'),         'should-be-wiped');
    await fsp.mkdir   (path.join(cache, 'libraries'),            { recursive: true });
    await fsp.writeFile(path.join(cache, 'libraries', 'asm.jar'), 'inside-subdir');

    const cleared = await sweepOneSlotDir(slot);

    // The cache entry should report the preservation note.
    assert.ok(cleared.some((c) => c.startsWith('cache')), `cleared list missing 'cache': ${cleared.join(',')}`);
    assert.ok(cleared.includes('cache (preserved mojang_*.jar)'), 'cache entry should annotate preservation');

    const remaining = (await fsp.readdir(cache)).sort();
    assert.deepEqual(
      remaining,
      ['mojang_1.20.1.jar', 'mojang_1.21.4.jar'].sort(),
      'only mojang_*.jar files should remain in cache/',
    );

    // Non-mojang files gone.
    await assert.rejects(fsp.access(path.join(cache, 'some_other_file.dat')));
    await assert.rejects(fsp.access(path.join(cache, 'patches.bin')));
    // Subdirectory removed entirely.
    await assert.rejects(fsp.access(path.join(cache, 'libraries')));

    // logs/ and crash-reports/ removed entirely.
    await assert.rejects(fsp.access(path.join(slot, 'logs')));
    await assert.rejects(fsp.access(path.join(slot, 'crash-reports')));
  } finally {
    await fsp.rm(slot, { recursive: true, force: true });
  }
});

test('sweepOneSlotDir tolerates a missing cache/ directory', async () => {
  const slot = await fsp.mkdtemp(path.join(os.tmpdir(), 'sweep-slot-nocache-'));
  try {
    await fsp.mkdir(path.join(slot, 'logs'), { recursive: true });
    const cleared = await sweepOneSlotDir(slot);
    // logs cleared; cache/ silently skipped (it didn't exist).
    assert.ok(cleared.includes('logs'));
  } finally {
    await fsp.rm(slot, { recursive: true, force: true });
  }
});

test('sweepOneSlotDir does NOT preserve files that only look like mojang jars', async () => {
  // Regex is ^mojang_[\d.]+\.jar$ — anything off-pattern is wiped.
  const slot = await makeSlot();
  try {
    const cache = path.join(slot, 'cache');
    await fsp.writeFile(path.join(cache, 'mojang_1.21.4.jar'),       'keep');
    await fsp.writeFile(path.join(cache, 'mojang_snapshot24w.jar'), 'wipe-non-numeric');
    await fsp.writeFile(path.join(cache, 'MOJANG_1.21.4.jar'),       'wipe-uppercase');
    await fsp.writeFile(path.join(cache, 'mojang_1.21.4.jar.bak'),  'wipe-extra-suffix');

    await sweepOneSlotDir(slot);

    const remaining = (await fsp.readdir(cache)).sort();
    assert.deepEqual(remaining, ['mojang_1.21.4.jar']);
  } finally {
    await fsp.rm(slot, { recursive: true, force: true });
  }
});
