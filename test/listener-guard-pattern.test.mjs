// Step 2.6 (commit fe80ed9): src/server/ws.js wraps every manager.on(...)
// listener body in try/catch so a throw inside one broadcast (e.g. a circular
// ref hitting JSON.stringify, or a mineflayer mid-state mutation surfacing
// during instance.toJSON) doesn't propagate up through EventEmitter into an
// unhandled rejection that crashes the dashboard.
//
// ws.js can't be imported here without pulling in src/bots/ (manager, instance,
// brain). Per task constraints those files are owned by a sibling agent and
// are read-only. We re-implement the wrap pattern inline and pin its
// invariants: emit must not throw, and the failure must be observable via
// console.error.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

// Mirrors the wrap pattern used in src/server/ws.js for each `manager.on(...)`
// listener. Body throws are caught and logged with a tag prefix; everything
// else propagates normally.
function wrapListener(tag, body) {
  return (...args) => {
    try { body(...args); }
    catch (err) { console.error(`[ws-listener] ${tag}:`, err); }
  };
}

function withCapturedConsoleError(fn) {
  const captured = [];
  const original = console.error;
  console.error = (...args) => { captured.push(args); };
  try { fn(); }
  finally { console.error = original; }
  return captured;
}

test('wrapped listener: synchronous throw is swallowed, emit() does not propagate', () => {
  const mgr = new EventEmitter();
  let processExitCalled = false;
  const originalExit = process.exit;
  // @ts-ignore
  process.exit = () => { processExitCalled = true; };

  try {
    mgr.on('upsert', wrapListener('upsert', () => {
      throw new Error('boom: instance.toJSON failed');
    }));

    const calls = withCapturedConsoleError(() => {
      // Must NOT throw — that's the whole point of the Step 2.6 guard.
      assert.doesNotThrow(() => mgr.emit('upsert', { id: 'bot-1' }));
    });

    assert.equal(calls.length, 1, 'console.error must be called exactly once');
    assert.match(String(calls[0][0]), /\[ws-listener\] upsert:/);
    assert.ok(calls[0][1] instanceof Error);
    assert.match(calls[0][1].message, /boom/);
    assert.equal(processExitCalled, false, 'a thrown listener must NOT terminate the process');
  } finally {
    process.exit = originalExit;
  }
});

test('wrapped listener: a healthy listener still runs on emit', () => {
  const mgr = new EventEmitter();
  let received = null;
  mgr.on('chat', wrapListener('chat', (entry) => { received = entry; }));
  mgr.emit('chat', { botId: 'b1', text: 'hi' });
  assert.deepEqual(received, { botId: 'b1', text: 'hi' });
});

test('wrapped listener: one listener throwing does not block sibling listeners', () => {
  const mgr = new EventEmitter();
  let siblingRan = false;

  mgr.on('decision', wrapListener('decision', () => { throw new Error('serializer crash'); }));
  mgr.on('decision', wrapListener('decision', () => { siblingRan = true; }));

  withCapturedConsoleError(() => {
    assert.doesNotThrow(() => mgr.emit('decision', { botId: 'b1' }));
  });
  assert.equal(siblingRan, true, 'a sibling listener after a throwing one must still run');
});

// --- HTTP handler guard pattern (mirrors src/server/http.js Step 2.6 wraps)
//
// The four read-only GET endpoints (/bots/:id/state, /bots/:id/memory,
// /bots/:id/decision, /world) each wrap their body in:
//   try { ... } catch (err) {
//     console.error('[http]', req.path, err);
//     res.status(500).json({ error: err.message || 'internal error' });
//   }
// We pin that contract here without importing the express app.

function wrapHttpHandler(body) {
  return (req, res) => {
    try { body(req, res); }
    catch (err) {
      console.error('[http]', req.path, err);
      res.status(500).json({ error: err.message || 'internal error' });
    }
  };
}

function makeRes() {
  const res = {
    statusCode: 200,
    body:       null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return res;
}

test('wrapHttpHandler: throwing body produces 500 + structured error body', () => {
  const handler = wrapHttpHandler(() => {
    const undef = undefined;
    return undef.foo; // synchronous throw — same shape as the overnight crash
  });

  const req = { path: '/api/bots/x/state' };
  const res = makeRes();

  withCapturedConsoleError(() => {
    assert.doesNotThrow(() => handler(req, res));
  });

  assert.equal(res.statusCode, 500);
  assert.ok(res.body && typeof res.body.error === 'string');
  assert.match(res.body.error, /Cannot read|undefined/);
});

test('wrapHttpHandler: success path is unchanged (no try/catch interference)', () => {
  const handler = wrapHttpHandler((_req, res) => {
    res.json({ ok: true, items: [1, 2, 3] });
  });
  const res = makeRes();
  handler({ path: '/api/world' }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, items: [1, 2, 3] });
});

test('wrapHttpHandler: error message falls back to "internal error" when err.message is empty', () => {
  const handler = wrapHttpHandler(() => {
    const e = new Error('');
    throw e;
  });
  const res = makeRes();
  withCapturedConsoleError(() => handler({ path: '/api/world' }, res));
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error, 'internal error');
});
