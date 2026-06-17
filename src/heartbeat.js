// BUG-009: dashboard heartbeat.
//
// The watchdog can poll bot endpoints — but if the dashboard process itself
// hangs (event loop blocked, GC stall, etc.), every poll returns an error and
// the watchdog has historically had no way to tell "dashboard is dead" from
// "all bots are dead". Yesterday's overnight catastrophe was exactly this:
// the dashboard hung at 02:02 PT and the watchdog logged 1455 poll_error
// events over 5 hours without ever restarting anything.
//
// We touch a single file every HEARTBEAT_INTERVAL_MS so the watchdog can
// check its mtime and conclude "dashboard is alive" or "dashboard is dead"
// independently of the HTTP layer.
//
// File location: <dataDir>/dashboard-heartbeat — small, ignored by git via
// data/ being a gitignored runtime dir.

import path from 'node:path';
import fsp from 'node:fs/promises';

export const HEARTBEAT_INTERVAL_MS = 5_000;
export const HEARTBEAT_FILENAME    = 'dashboard-heartbeat';

/**
 * Start a background heartbeat that touches `<dataDir>/dashboard-heartbeat`
 * every HEARTBEAT_INTERVAL_MS. Returns a stop() function.
 *
 * Errors are swallowed (logged once per minute max) — heartbeat must never
 * crash the dashboard.
 *
 * @param {{ dataDir: string }} opts
 * @returns {{ stop: () => void, file: string }}
 */
export function startHeartbeat({ dataDir }) {
  const file = path.join(dataDir, HEARTBEAT_FILENAME);
  let lastErrorLogAt = 0;

  const tick = async () => {
    const now = Date.now();
    try {
      // Write the timestamp as JSON so a human can `cat` the file and see
      // when the dashboard last reported alive.
      await fsp.writeFile(file, JSON.stringify({ ts: new Date(now).toISOString(), pid: process.pid }) + '\n', 'utf8');
    } catch (err) {
      // Never throw from heartbeat. Log at most once a minute.
      if (now - lastErrorLogAt > 60_000) {
        lastErrorLogAt = now;
        console.error('[heartbeat] write failed:', err.message);
      }
    }
  };

  // First tick immediately so a freshly-started dashboard doesn't look dead
  // for the first interval.
  tick();
  const id = setInterval(tick, HEARTBEAT_INTERVAL_MS);
  // Don't keep the event loop alive just for this — the http server already
  // does that. If the http server dies, we want the process to exit too.
  id.unref?.();

  return {
    file,
    stop: () => clearInterval(id),
  };
}
