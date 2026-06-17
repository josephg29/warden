#!/usr/bin/env node
// OVN-001: process supervisor for the dashboard + watchdog pair.
//
// Origin: 2026-05-07 overnight. The dashboard's express event loop wedged
// silently after ~22 minutes (BUG-OVN-001). Port 8080 kept accepting TCP
// but every HTTP request hung forever. The watchdog correctly process.exit(2)
// on dashboard_down — but nothing was watching the watchdog, so the fleet
// stayed broken for 78 minutes until manual intervention.
//
// This script is the missing supervisor:
//   - Spawns dashboard (node src/index.js) + watchdog (node data/overnight/watchdog.mjs)
//   - Restarts either one on exit with exponential backoff (1s → 60s cap)
//   - Heartbeat-stale kill: if dashboard heartbeat mtime > 60s and the
//     dashboard process is still alive, the event loop is wedged. SIGKILL
//     and let the restart loop bring it back. Two consecutive stale checks
//     required to avoid GC-stall false positives.
//   - Writes pid files on spawn and removes them on clean exit (OVN-016).
//   - Refuses to flap: > 5 restarts of a single child inside 5 minutes
//     exits non-zero with a clear message so an operator can intervene.
//
// CLI:
//   --no-watchdog        skip watchdog, run dashboard only
//   --no-dashboard       skip dashboard, run watchdog only
//   --once               smoke-test mode: spawn each child, wait 5s, exit
//   --quiet              suppress per-tick stdout (events still go to jsonl)
//   --data-dir <path>    override DATA_DIR (default: <repo>/data)
//
// Usage:
//   npm run supervisor
//   node scripts/supervisor.mjs --no-watchdog            # dashboard only

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const REPO_ROOT  = path.resolve(__dirname, '..');

// -- tunables --------------------------------------------------------------
const RESTART_BACKOFF_MS_INITIAL = 1_000;
const RESTART_BACKOFF_MS_CAP     = 60_000;
const RESTART_RESET_AFTER_MS     = 5 * 60_000;   // child uptime threshold to reset backoff
const FLAP_MAX_RESTARTS          = 5;            // > this many in window => bail
const FLAP_WINDOW_MS             = 5 * 60_000;
const HEARTBEAT_FILENAME         = 'dashboard-heartbeat';
const HEARTBEAT_STALE_MS         = 60_000;
const HEARTBEAT_CHECK_INTERVAL_MS = 15_000;
const HEARTBEAT_STALE_STREAK_TRIP = 2;           // consecutive stale checks before kill
const SHUTDOWN_GRACE_MS          = 8_000;

// -- arg parsing -----------------------------------------------------------
function parseArgs(argv) {
  const out = {
    runDashboard: true,
    runWatchdog:  true,
    once:         false,
    quiet:        false,
    dataDir:      process.env.DATA_DIR ?? path.join(REPO_ROOT, 'data'),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if      (a === '--no-watchdog')  out.runWatchdog = false;
    else if (a === '--no-dashboard') out.runDashboard = false;
    else if (a === '--once')         out.once = true;
    else if (a === '--quiet')        out.quiet = true;
    else if (a === '--data-dir')     out.dataDir = path.resolve(argv[++i]);
    else if (a === '-h' || a === '--help') {
      process.stdout.write(readHelp());
      process.exit(0);
    } else {
      console.error(`unknown arg: ${a}`);
      process.exit(2);
    }
  }
  if (!out.runDashboard && !out.runWatchdog) {
    console.error('error: --no-dashboard and --no-watchdog cannot both be set');
    process.exit(2);
  }
  return out;
}

function readHelp() {
  return `supervisor: keep the dashboard + watchdog pair alive

  --no-dashboard       run watchdog only
  --no-watchdog        run dashboard only
  --once               smoke-test: spawn each child, wait 5s, exit
  --quiet              suppress stdout (events still appended to jsonl)
  --data-dir <path>    override data dir
`;
}

// -- log helpers -----------------------------------------------------------
class SupervisorLogger {
  constructor({ logFile, quiet }) {
    this.logFile = logFile;
    this.quiet   = quiet;
  }
  async event(obj) {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n';
    try { await fsp.appendFile(this.logFile, line, 'utf8'); }
    catch (err) {
      // Logging must never crash the supervisor.
      console.error(`[supervisor] log write failed: ${err.message}`);
    }
    if (!this.quiet) console.log('[supervisor]', line.trim());
  }
}

// -- pid helpers -----------------------------------------------------------
function processAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

function killProcess(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      // /F forced, /T tree-kill so child Java processes don't survive.
      execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch { /* already gone */ }
}

async function writePidFile(file, pid) {
  await fsp.writeFile(file, String(pid), 'utf8');
}

async function removePidFile(file) {
  try { await fsp.unlink(file); }
  catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`[supervisor] pid cleanup failed for ${file}: ${err.message}`);
    }
  }
}

// OVN-016: stale .pid files from prior crashes confuse operators. On startup,
// scan the overnight dir and remove any pid files whose pid no longer exists.
export async function cleanupStalePids(overnightDir) {
  let removed = [];
  let entries;
  try { entries = await fsp.readdir(overnightDir); }
  catch (err) {
    if (err.code === 'ENOENT') return removed;
    throw err;
  }
  for (const name of entries) {
    if (!name.endsWith('.pid')) continue;
    const file = path.join(overnightDir, name);
    let raw;
    try { raw = (await fsp.readFile(file, 'utf8')).trim(); }
    catch { continue; }
    const pid = parseInt(raw, 10);
    if (!Number.isFinite(pid) || pid <= 0) {
      // malformed — remove
      await removePidFile(file);
      removed.push({ file, pid: null, reason: 'malformed' });
      continue;
    }
    if (!processAlive(pid)) {
      await removePidFile(file);
      removed.push({ file, pid, reason: 'process_dead' });
    }
  }
  return removed;
}

// -- backoff math ----------------------------------------------------------
export function nextBackoffMs(attempt) {
  // attempt is 1-indexed. 1 → 1s, 2 → 2s, 3 → 4s, 4 → 8s … cap at 60s.
  const ms = RESTART_BACKOFF_MS_INITIAL * Math.pow(2, Math.max(0, attempt - 1));
  return Math.min(ms, RESTART_BACKOFF_MS_CAP);
}

// -- child manager ---------------------------------------------------------
class SupervisedChild {
  constructor({ name, command, args, cwd, env, pidFile, logOut, logErr, logger }) {
    this.name       = name;
    this.command    = command;
    this.args       = args;
    this.cwd        = cwd;
    this.env        = env;
    this.pidFile    = pidFile;
    this.logOut     = logOut;
    this.logErr     = logErr;
    this.logger     = logger;
    this.proc       = null;
    this.startedAt  = 0;
    this.restartHistory = []; // [{ ts, reason }]
    this.attempt    = 0;       // for backoff calc; reset on stable run
    this.stopping   = false;   // true when supervisor is shutting down
    this.exitedHandlerInstalled = false;
  }

  async start({ reason } = { reason: 'initial' }) {
    if (this.stopping) return;
    if (this.proc && !this.proc.killed && this.proc.exitCode === null) {
      await this.logger.event({ event: 'start_skipped', child: this.name, reason: 'already_running', pid: this.proc.pid });
      return;
    }

    // If we've flapped too much, bail loudly.
    const now = Date.now();
    this.restartHistory = this.restartHistory.filter((r) => now - r.ts < FLAP_WINDOW_MS);
    if (this.restartHistory.length >= FLAP_MAX_RESTARTS) {
      await this.logger.event({
        event: 'flap_detected',
        child: this.name,
        restartsInWindow: this.restartHistory.length,
        windowMs: FLAP_WINDOW_MS,
        hint: 'supervisor exiting non-zero — investigate the underlying crash before restarting',
      });
      throw new Error(`${this.name} flapping (${this.restartHistory.length} restarts in ${FLAP_WINDOW_MS}ms)`);
    }

    // Open log fds. Append, don't truncate — operator may want history.
    const out = fs.openSync(this.logOut, 'a');
    const err = fs.openSync(this.logErr, 'a');

    const proc = spawn(this.command, this.args, {
      cwd:         this.cwd,
      env:         this.env,
      stdio:       ['ignore', out, err],
      detached:    false, // we keep them tied so SIGINT propagates
      windowsHide: true,
    });
    this.proc      = proc;
    this.startedAt = Date.now();
    if (reason !== 'initial') this.restartHistory.push({ ts: now, reason });

    await writePidFile(this.pidFile, proc.pid);
    await this.logger.event({
      event: 'spawn',
      child: this.name,
      pid:   proc.pid,
      reason,
      attempt: this.attempt + 1,
      logOut: this.logOut,
      logErr: this.logErr,
    });

    if (!this.exitedHandlerInstalled) {
      this.exitedHandlerInstalled = true;
    }

    proc.on('exit', async (code, signal) => {
      const uptimeMs = Date.now() - this.startedAt;
      await this.logger.event({
        event:    'exit',
        child:    this.name,
        pid:      proc.pid,
        code,
        signal,
        uptimeMs,
      });
      await removePidFile(this.pidFile);
      if (this.stopping) return;

      // Reset backoff if the child stayed up long enough.
      if (uptimeMs >= RESTART_RESET_AFTER_MS) this.attempt = 0;
      this.attempt += 1;
      const wait = nextBackoffMs(this.attempt);
      await this.logger.event({ event: 'restart_scheduled', child: this.name, inMs: wait, attempt: this.attempt });
      await delay(wait);
      try {
        await this.start({ reason: signal ? `signal:${signal}` : `exit:${code}` });
      } catch (e) {
        await this.logger.event({ event: 'flap_exit', child: this.name, error: String(e) });
        process.exit(3);
      }
    });

    proc.on('error', async (e) => {
      await this.logger.event({ event: 'spawn_error', child: this.name, error: String(e) });
    });
  }

  async stop() {
    this.stopping = true;
    if (!this.proc || this.proc.exitCode !== null) {
      await removePidFile(this.pidFile);
      return;
    }
    const pid = this.proc.pid;
    await this.logger.event({ event: 'stopping', child: this.name, pid });
    // SIGINT first; killProcess fallback if it's still alive after grace.
    try { this.proc.kill('SIGINT'); } catch { /* ignore */ }
    const deadline = Date.now() + SHUTDOWN_GRACE_MS;
    while (Date.now() < deadline) {
      if (this.proc.exitCode !== null) break;
      await delay(200);
    }
    if (this.proc.exitCode === null) {
      await this.logger.event({ event: 'force_kill', child: this.name, pid });
      killProcess(pid);
    }
    await removePidFile(this.pidFile);
  }

  async forceRestart(reason) {
    if (!this.proc || this.proc.exitCode !== null) return;
    const pid = this.proc.pid;
    await this.logger.event({ event: 'force_restart', child: this.name, pid, reason });
    killProcess(pid);
    // The exit handler will fire and trigger the normal restart-with-backoff path.
  }
}

// -- heartbeat-stale watcher ----------------------------------------------
async function heartbeatAgeMs(file) {
  try {
    const st = await fsp.stat(file);
    return Date.now() - st.mtimeMs;
  } catch (err) {
    if (err.code === 'ENOENT') return Infinity;
    throw err;
  }
}

function startHeartbeatWatcher({ heartbeatFile, dashboardChild, logger }) {
  let staleStreak = 0;
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    if (!dashboardChild.proc || dashboardChild.proc.exitCode !== null) {
      // Dashboard isn't running — restart-on-exit path owns this. Don't double-fire.
      staleStreak = 0;
      return;
    }
    let age;
    try { age = await heartbeatAgeMs(heartbeatFile); }
    catch (err) {
      await logger.event({ event: 'heartbeat_check_error', error: String(err) });
      return;
    }
    if (age > HEARTBEAT_STALE_MS) {
      staleStreak += 1;
      await logger.event({ event: 'heartbeat_stale', ageMs: Number.isFinite(age) ? age : null, streak: staleStreak });
      if (staleStreak >= HEARTBEAT_STALE_STREAK_TRIP) {
        await dashboardChild.forceRestart('heartbeat_stale');
        staleStreak = 0;
      }
    } else {
      staleStreak = 0;
    }
  };
  const id = setInterval(() => {
    tick().catch(async (e) => {
      await logger.event({ event: 'heartbeat_watcher_crash', error: String(e) });
    });
  }, HEARTBEAT_CHECK_INTERVAL_MS);
  return { stop: () => { stopped = true; clearInterval(id); } };
}

// -- main -----------------------------------------------------------------
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const overnightDir = path.join(opts.dataDir, 'overnight');
  await fsp.mkdir(overnightDir, { recursive: true });

  const logFile = path.join(overnightDir, 'supervisor.jsonl');
  const logger = new SupervisorLogger({ logFile, quiet: opts.quiet });

  const removed = await cleanupStalePids(overnightDir);
  if (removed.length) {
    await logger.event({ event: 'pid_cleanup', removed });
  }

  await logger.event({ event: 'supervisor_start', dataDir: opts.dataDir, runDashboard: opts.runDashboard, runWatchdog: opts.runWatchdog, once: opts.once });

  const env = { ...process.env, DATA_DIR: opts.dataDir };

  const dashboard = opts.runDashboard
    ? new SupervisedChild({
        name:    'dashboard',
        command: process.execPath,
        args:    ['src/index.js'],
        cwd:     REPO_ROOT,
        env,
        pidFile: path.join(overnightDir, 'dashboard.pid'),
        logOut:  path.join(overnightDir, 'dashboard.out'),
        logErr:  path.join(overnightDir, 'dashboard.err'),
        logger,
      })
    : null;

  const watchdog = opts.runWatchdog
    ? new SupervisedChild({
        name:    'watchdog',
        command: process.execPath,
        args:    ['data/overnight/watchdog.mjs'],
        cwd:     REPO_ROOT,
        env,
        pidFile: path.join(overnightDir, 'watchdog.pid'),
        logOut:  path.join(overnightDir, 'watchdog.out'),
        logErr:  path.join(overnightDir, 'watchdog.err'),
        logger,
      })
    : null;

  if (dashboard) await dashboard.start();
  if (watchdog) await watchdog.start();

  const heartbeatWatcher = dashboard
    ? startHeartbeatWatcher({
        heartbeatFile: path.join(opts.dataDir, HEARTBEAT_FILENAME),
        dashboardChild: dashboard,
        logger,
      })
    : { stop: () => {} };

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    await logger.event({ event: 'supervisor_stop', signal });
    heartbeatWatcher.stop();
    const tasks = [];
    if (dashboard) tasks.push(dashboard.stop());
    if (watchdog) tasks.push(watchdog.stop());
    await Promise.all(tasks);
    await logger.event({ event: 'supervisor_stopped' });
    process.exit(0);
  };
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  if (opts.once) {
    // Smoke mode: confirm both children spawned, wait 5s, then shut down.
    await delay(5_000);
    await shutdown('once');
    return;
  }

  // Idle. The supervisor stays alive purely to manage the child lifecycle.
  // Children attach event handlers that keep the loop alive.
  // Add a noop interval as a belt-and-braces keepalive in case both children
  // exit at the same instant before any signal arrives.
  setInterval(() => {}, 60_000);
}

// Only auto-run when invoked as the entrypoint, so tests can import helpers.
const isEntry = import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`
  || import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`;
if (isEntry) {
  main().catch(async (err) => {
    console.error('[supervisor] crash:', err);
    process.exit(1);
  });
}

// Exported for unit tests.
export const __testing = { nextBackoffMs, cleanupStalePids, processAlive };
