// OVN-015: shouldLog gates noisy frequency-events at LOG_LEVEL=warn so the
// dashboard.out doesn't drown real ECONNABORTED traces in 1300+ debounce
// lines per overnight run.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// LOG_LEVEL is read at module import time. We re-import with a query-string
// cachebust to exercise different envs in isolation.
async function importLogger(level) {
  const orig = process.env.LOG_LEVEL;
  if (level === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = level;
  const mod = await import(`../src/logger.js?cachebust=${Date.now()}-${Math.random()}`);
  if (orig === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = orig;
  return mod;
}

test('OVN-015: shouldLog default (info) lets info+warn+error through, hides debug', async () => {
  const { shouldLog } = await importLogger();
  assert.equal(shouldLog('debug'), false);
  assert.equal(shouldLog('info'), true);
  assert.equal(shouldLog('warn'), true);
  assert.equal(shouldLog('error'), true);
});

test('OVN-015: shouldLog at debug shows everything', async () => {
  const { shouldLog } = await importLogger('debug');
  assert.equal(shouldLog('debug'), true);
  assert.equal(shouldLog('info'), true);
  assert.equal(shouldLog('warn'), true);
  assert.equal(shouldLog('error'), true);
});

test('OVN-015: shouldLog at warn hides info+debug', async () => {
  const { shouldLog } = await importLogger('warn');
  assert.equal(shouldLog('debug'), false);
  assert.equal(shouldLog('info'), false);
  assert.equal(shouldLog('warn'), true);
  assert.equal(shouldLog('error'), true);
});

test('OVN-015: shouldLog with unknown level defaults to visible', async () => {
  const { shouldLog } = await importLogger('warn');
  assert.equal(shouldLog('TRACE'), true, 'unknown levels are not gated');
});

test('OVN-015: brainDebug emits when LOG_LEVEL=debug', async () => {
  const { brainDebug } = await importLogger('debug');
  const captured = [];
  const orig = console.log;
  console.log = (...a) => captured.push(a.join(' '));
  try {
    brainDebug('test message');
  } finally {
    console.log = orig;
  }
  assert.equal(captured.length, 1);
  assert.match(captured[0], /test message/);
});

test('OVN-015: brainDebug is silent when LOG_LEVEL=info', async () => {
  const { brainDebug } = await importLogger('info');
  const captured = [];
  const orig = console.log;
  console.log = (...a) => captured.push(a.join(' '));
  try {
    brainDebug('should not appear');
  } finally {
    console.log = orig;
  }
  assert.equal(captured.length, 0);
});
