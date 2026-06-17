import 'dotenv/config';
import path from 'node:path';
import { createServer } from 'node:http';
import { config } from './config.js';
import { installFileLogger } from './logger.js';
import { Store } from './store.js';
import { settingsStore } from './settings-store.js';
import { sessionLogger } from './session-logger.js';
import { BotManager } from './bots/manager.js';
import { MinecraftServerManager } from './mc-server/manager.js';
import { createApp } from './server/http.js';
import { attachWs } from './server/ws.js';
import { DiskWatch, sweepSlotDirsAtStartup } from './diskwatch.js';
import { startHeartbeat } from './heartbeat.js';
import { startSafeErrorReporter, safeError, safeFleetError } from './safe-error.js';

// F9: install rotating file logger before anything else logs.
installFileLogger({ logDir: path.join(config.dataDir, 'logs') });

// BUG-002: pre-emptively clear logs/crash-reports/cache inside every slot
// dir before the MC servers (which we don't manage in-process) get a chance
// to re-fill them. Runs once per boot.
const slotSweep = sweepSlotDirsAtStartup(config.dataDir);
if (slotSweep.swept > 0 || slotSweep.errors > 0) {
  console.log(`[boot] slot-dir sweep: cleared ${slotSweep.swept}, errors ${slotSweep.errors}`);
}

const store = new Store(config.dataDir);
await store.load();

await settingsStore.load();

if (!settingsStore.get('cerebrasApiKey')) {
  console.warn('[warden] no Cerebras API key — set one in the dashboard or .env');
}

const manager = new BotManager(store);
manager.restoreFromStore();

const mcServer = new MinecraftServerManager({
  serverDir: config.mcServerDir,
  jarPath:   config.mcServerJar,
  javaArgs:  ['-Xms512M', '-Xmx2G'],
});

// ---- session logging ---------------------------------------------------
mcServer.on('change', () => {
  const snap = mcServer.toJSON();
  if (snap.state === 'running') sessionLogger.startSession();
  sessionLogger.log({ type: 'server:state', state: snap.state, error: snap.error ?? null });
  if (snap.state === 'stopped') sessionLogger.endSession();
});
mcServer.on('log', (entry) => {
  sessionLogger.log({ type: 'server:log', line: entry.line });
});
manager.on('upsert', (instance) => {
  // F10: if a bot connects but the MC server is unmanaged (started outside
  // the dev server), no session is active. Open one on first bot connect so
  // events.jsonl captures the run regardless of who owns the server process.
  if (instance.state === 'connected' && !sessionLogger.isActive()) {
    sessionLogger.startSession();
  }
  sessionLogger.log({
    type:  'bot:state',
    botId: instance.bot.id,
    name:  instance.bot.name,
    state: instance.state,
    error: instance.error ?? null,
  });
  // close the session when the last bot disconnects AND the MC server is
  // not managed (otherwise mcServer.on('change') already handles it).
  if (sessionLogger.isActive()
      && mcServer.toJSON().state !== 'running'
      && manager.list().every((i) => i.state !== 'connected')) {
    sessionLogger.endSession();
  }
});
manager.on('chat', (entry) => {
  sessionLogger.log({ type: 'bot:chat', ...entry });
});
manager.on('decision', (entry) => {
  sessionLogger.log({ type: 'bot:decision', ...entry });
});
manager.on('brain-event', (entry) => {
  // brain emits its own .type (skill_done, hostile_near, damage, death, ...)
  sessionLogger.log({ type: `brain:${entry.type}`, botId: entry.botId, name: entry.name, data: entry.data, location: entry.location ?? null });
});
// -----------------------------------------------------------------------

// BUG-002: poll free disk every 30s; surface on /api/server and stamp a
// disk_low error onto every BotInstance when free < CRITICAL_MB.
const diskWatch = new DiskWatch({ dataDir: config.dataDir, manager });
diskWatch.start();

const app = createApp({ manager, mcServer, settingsStore, sessionLogger, diskWatch });
const httpServer = createServer(app);

attachWs({ httpServer, manager, mcServer, settingsStore });

// BUG-014 mitigation: route uncaught/unhandled errors through the
// rate-limited safe-error reporter so a sync stderr storm from one bot
// can't starve the shared event loop and time out all 5 connections.
startSafeErrorReporter();

httpServer.listen(config.port, config.host, () => {
  console.log(`[warden] listening on http://${config.host}:${config.port}`);
});

// BUG-009: touch <dataDir>/dashboard-heartbeat every 5s so the overnight
// watchdog can detect a hung dashboard independently of HTTP polls.
const heartbeat = startHeartbeat({ dataDir: config.dataDir });
console.log(`[heartbeat] writing to ${heartbeat.file}`);

// auto-start opt-in bots after server is up
for (const instance of manager.list()) {
  if (instance.bot.autoStart) {
    instance.connect().catch((err) => {
      safeError(instance.bot.id, `[autostart] ${instance.bot.name}: ${err.message}`);
    });
  }
}

let shuttingDown = false;
const shutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[warden] received ${signal}, shutting down...`);
  try {
    await manager.disconnectAll();
    await store.flush();
  } catch (err) {
    safeFleetError('[shutdown] error:', err);
  }
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
