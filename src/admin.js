// BUG-021: replace the 10-step manual restart sequence with one API call.
//
// Every previous restart was: find listener PID → POST disconnect →
// DELETE memory → taskkill java → wait for port to free → wipe world dirs
// → clear logs → spawn java → wait for "Done (" → PATCH bot name →
// POST connect. Any error mid-way left the slot in a half-state.
//
// recycleSlot does the whole thing atomically and reports a single
// { ok, newTestNum, javaPid, durationMs, snapshotPath } result.
//
// Note on PIDs (BUG-017): always look up the listener PID from the OS
// rather than relying on the spawn PID we got back at start time.
// PowerShell Start-Process returns the launcher PID on Windows, which
// often differs from the actual java.exe owning the LISTEN socket.

import path from 'node:path';
import fsp from 'node:fs/promises';
import net from 'node:net';
import { spawn, exec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import { config } from './config.js';
import { takeSnapshot } from './snapshot.js';
import { sweepOneSlotDir } from './diskwatch.js';

const execAsync = promisify(exec);

// Slot N → MC server port. Hardcoded from the overnight 5-parallel layout
// (data/bots.json + data/mc-test-slot{1..5}/server.properties). Derive
// dynamically later if the layout changes.
export const PORT_BY_SLOT = Object.freeze({
  1: 25565,
  2: 25566,
  3: 25567,
  4: 25568,
  5: 25569,
});

const WORLD_SUBDIRS_TO_WIPE = ['world', 'world_nether', 'world_the_end'];
const PORT_FREE_TIMEOUT_MS  = 30_000;
const PORT_LISTEN_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS       = 1500;

function slotDirFor(slotN) {
  return path.join(config.dataDir, `mc-test-slot${slotN}`);
}

// ----- port liveness checks ------------------------------------------------

function probePort(port, host = '127.0.0.1', timeoutMs = 700) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    let done = false;
    const finish = (listening) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch { /* noop */ }
      resolve(listening);
    };
    sock.once('connect', () => finish(true));
    sock.once('error',   () => finish(false));
    sock.once('timeout', () => finish(false));
    sock.setTimeout(timeoutMs);
  });
}

async function waitForPortFree(port, timeoutMs = PORT_FREE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await probePort(port))) return true;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`port ${port} still listening after ${timeoutMs}ms`);
}

async function waitForPortListening(port, timeoutMs = PORT_LISTEN_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probePort(port)) return true;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`port ${port} not listening after ${timeoutMs}ms`);
}

// ----- listener-PID lookup + kill ------------------------------------------

async function getListenerPid(port) {
  if (process.platform === 'win32') {
    // netstat -ano lists "Proto Local Foreign State PID" with whitespace
    // separation. We grep by ":<port>" and "LISTENING" because Windows
    // prints both LISTENING and ESTABLISHED rows for the same port pair.
    const { stdout } = await execAsync('netstat -ano -p TCP', { windowsHide: true });
    for (const raw of stdout.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (!line.includes('LISTENING')) continue;
      // Match :<port> at the end of the local address (avoid matching
      // ":25565" inside a foreign-address column for ESTABLISHED).
      if (!new RegExp(`:${port}\\b`).test(line)) continue;
      const parts = line.split(/\s+/);
      const pid = Number(parts[parts.length - 1]);
      if (Number.isFinite(pid) && pid > 0) return pid;
    }
    return null;
  }
  // POSIX: lsof first (clean), fall back to ss
  try {
    const { stdout } = await execAsync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`);
    const pid = Number(stdout.trim().split(/\s+/)[0]);
    if (Number.isFinite(pid) && pid > 0) return pid;
  } catch { /* fall through */ }
  try {
    const { stdout } = await execAsync(`ss -lntp 'sport = :${port}'`);
    const m = stdout.match(/pid=(\d+)/);
    if (m) return Number(m[1]);
  } catch { /* noop */ }
  return null;
}

async function killPid(pid) {
  if (process.platform === 'win32') {
    await execAsync(`taskkill /F /T /PID ${pid}`, { windowsHide: true });
    return;
  }
  try { process.kill(pid, 'SIGTERM'); } catch { /* noop */ }
  // SIGTERM gracefully; escalate after a short wait if still alive.
  await sleep(2000);
  try { process.kill(pid, 0); } catch { return; } // already gone
  try { process.kill(pid, 'SIGKILL'); } catch { /* noop */ }
}

// ----- spawn java for a slot -----------------------------------------------

async function spawnSlotJava(slotDir) {
  const jarPath = path.join(slotDir, 'server.jar');
  // existence check up front so we get a clear error rather than a child
  // that exits 1 a few seconds later.
  await fsp.access(jarPath);

  const outPath = path.join(slotDir, 'mc-out.log');
  const fd = fs.openSync(outPath, 'a');

  const args = ['-Xms512M', '-Xmx2G', '-jar', jarPath, '--nogui'];
  const proc = spawn('java', args, {
    cwd: slotDir,
    detached: true,                 // outlive the dashboard process
    stdio:    ['ignore', fd, fd],
    windowsHide: true,
  });

  // Detach so node can shut down without killing the slot's java.
  proc.unref();

  // Closing our copy of the fd is fine — the child still holds it.
  try { fs.closeSync(fd); } catch { /* noop */ }

  return proc.pid ?? null;
}

// ----- main entry ----------------------------------------------------------

export async function recycleSlot({ slotN, reason = 'recycle', nextTestNum, manager }) {
  const startedAt = Date.now();
  const port = PORT_BY_SLOT[slotN];
  if (!port) throw new Error(`unknown slot: ${slotN}`);
  const slotDir = slotDirFor(slotN);

  // 0. find the bot bound to this port
  const instance = manager.list().find((i) => i.bot.port === port);
  if (!instance) {
    throw new Error(`no bot configured for port ${port} (slot ${slotN})`);
  }

  // 1. snapshot — best-effort. Don't block recycle if it fails.
  let snapshotPath = null;
  try {
    const r = await takeSnapshot(instance, { reason });
    snapshotPath = r.path;
  } catch (err) {
    console.warn(`[admin] snapshot before recycle failed: ${err.message}`);
  }

  // 2. disconnect bot (graceful — give it 5s before forcing)
  try {
    await instance.disconnect();
  } catch (err) {
    console.warn(`[admin] disconnect: ${err.message}`);
  }

  // 3. delete memory file
  const memPath = path.join(config.dataDir, 'memory', `${instance.bot.id}.json`);
  try {
    await fsp.unlink(memPath);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[admin] unlink memory ${memPath}: ${err.message}`);
    }
  }

  // 4. kill java by listener PID (BUG-017: not by spawn PID)
  let javaPid = null;
  try {
    const pid = await getListenerPid(port);
    if (pid) {
      await killPid(pid);
      javaPid = pid;
    }
  } catch (err) {
    console.warn(`[admin] kill listener PID on port ${port}: ${err.message}`);
  }

  // 5. wait for the port to free up
  await waitForPortFree(port);

  // 6. wipe world dirs + clear logs/crash-reports/cache
  for (const sub of WORLD_SUBDIRS_TO_WIPE) {
    try {
      await fsp.rm(path.join(slotDir, sub), { recursive: true, force: true });
    } catch (err) {
      console.warn(`[admin] wipe ${sub}: ${err.message}`);
    }
  }
  await sweepOneSlotDir(slotDir);

  // 7. spawn fresh java
  const spawnPid = await spawnSlotJava(slotDir);
  console.log(`[admin] slot ${slotN} java spawn pid=${spawnPid} (will resolve to listener pid below)`);

  // 8. wait for it to listen on the slot port
  await waitForPortListening(port);

  // listener PID is what we care about going forward — capture it now.
  try {
    const pid = await getListenerPid(port);
    if (pid) javaPid = pid;
  } catch { /* keep spawn pid */ }

  // 9. PATCH bot to next TestN
  let resolvedTestNum = nextTestNum;
  if (resolvedTestNum == null) {
    const m = String(instance.bot.name).match(/^Test(\d+)$/);
    resolvedTestNum = m ? Number(m[1]) + 1 : null;
  }
  if (Number.isInteger(resolvedTestNum)) {
    manager.update(instance.bot.id, { name: `Test${resolvedTestNum}` });
  }

  // 10. reconnect
  await instance.connect();

  return {
    ok:          true,
    slotN,
    port,
    newTestNum:  resolvedTestNum,
    javaPid,
    snapshotPath,
    durationMs:  Date.now() - startedAt,
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
