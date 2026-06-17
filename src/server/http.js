import path from 'node:path';
import fsp from 'node:fs/promises';
import express from 'express';
import { config } from '../config.js';
import { ValidationError } from '../bots/manager.js';
import { BusyError } from '../bots/instance.js';
import { takeSnapshot } from '../snapshot.js';
import { recycleSlot, PORT_BY_SLOT } from '../admin.js';

function configuredBotNames(manager) {
  const names = new Set();
  for (const i of manager.list()) {
    if (i.bot.name)       names.add(i.bot.name);
    if (i.actualUsername) names.add(i.actualUsername);
  }
  return names;
}

export function createApp({ manager, mcServer, settingsStore, sessionLogger, diskWatch }) {
  const app = express();
  app.use(express.json());

  // CORS — open GET/HEAD/OPTIONS so a public dashboard (e.g. agora-site on
  // Vercel reaching the localhost dashboard via cloudflared tunnel) can read
  // bot state without same-origin restrictions. Mutating endpoints stay
  // same-origin only because we never echo Allow-Methods for them.
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    res.setHeader('Access-Control-Max-Age', '600');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });

  const api = express.Router();

  api.get('/bots', (_req, res) => {
    res.json({ bots: manager.serialize() });
  });

  api.post('/bots', (req, res, next) => {
    try {
      const instance = manager.create(req.body || {});
      res.status(201).json({ bot: instance.toJSON() });
    } catch (err) { next(err); }
  });

  api.patch('/bots/:id', (req, res, next) => {
    try {
      const instance = manager.update(req.params.id, req.body || {});
      if (!instance) return res.status(404).json({ error: 'not found' });
      res.json({ bot: instance.toJSON() });
    } catch (err) { next(err); }
  });

  api.delete('/bots/:id', async (req, res, next) => {
    try {
      const ok = await manager.remove(req.params.id);
      if (!ok) return res.status(404).json({ error: 'not found' });
      res.status(204).end();
    } catch (err) { next(err); }
  });

  api.post('/bots/:id/connect', async (req, res, next) => {
    try {
      const instance = manager.get(req.params.id);
      if (!instance) return res.status(404).json({ error: 'not found' });
      await instance.connect();
      res.json({ bot: instance.toJSON() });
    } catch (err) { next(err); }
  });

  api.post('/bots/:id/disconnect', async (req, res, next) => {
    try {
      const instance = manager.get(req.params.id);
      if (!instance) return res.status(404).json({ error: 'not found' });
      await instance.disconnect();
      res.json({ bot: instance.toJSON() });
    } catch (err) { next(err); }
  });

  api.delete('/bots/:id/memory', async (req, res, next) => {
    try {
      const instance = manager.get(req.params.id);
      if (!instance) return res.status(404).json({ error: 'not found' });
      if (instance.state !== 'disconnected') {
        return res.status(409).json({ error: 'disconnect the bot before clearing memory' });
      }
      const filePath = path.join(config.dataDir, 'memory', `${instance.bot.id}.json`);
      try {
        await fsp.unlink(filePath);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      instance._lastMemorySnapshot = null;
      res.json({ ok: true, cleared: instance.bot.id });
    } catch (err) { next(err); }
  });

  // ---- read-only dashboard endpoints -------------------------------------

  // Step 2.6 hardening: wrap the four heavily-polled read handlers in
  // try/catch. The 30h overnight saw 5 dashboard restarts that all began as
  // synchronous throws inside these getters (a mineflayer mid-flight state
  // mutation surfaced as `cannot read properties of undefined`), which the
  // Express default error path turns into an unhandled rejection. Catching
  // locally keeps the dashboard alive and returns a 500 to the watchdog so it
  // logs a poll_error instead of restarting the process.
  api.get('/bots/:id/state', (req, res) => {
    try {
      const instance = manager.get(req.params.id);
      if (!instance) return res.status(404).json({ error: 'not found' });
      res.json(instance.getFullState());
    } catch (err) {
      console.error('[http]', req.path, err);
      res.status(500).json({ error: err.message || 'internal error' });
    }
  });

  api.get('/bots/:id/memory', (req, res) => {
    try {
      const instance = manager.get(req.params.id);
      if (!instance) return res.status(404).json({ error: 'not found' });
      const mem = instance.memoryState;
      res.json(mem ?? { contextBlock: '', state: null });
    } catch (err) {
      console.error('[http]', req.path, err);
      res.status(500).json({ error: err.message || 'internal error' });
    }
  });

  api.get('/bots/:id/decision', (req, res) => {
    try {
      const instance = manager.get(req.params.id);
      if (!instance) return res.status(404).json({ error: 'not found' });
      const bi = instance.brainInfo;
      res.json({
        lastDecision:    bi?.lastDecision    ?? null,
        lastSkillResult: bi?.lastSkillResult ?? null,
        currentSkill:    bi?.currentSkill    ?? null,
      });
    } catch (err) {
      console.error('[http]', req.path, err);
      res.status(500).json({ error: err.message || 'internal error' });
    }
  });

  api.get('/world', (req, res) => {
    try {
    const knownBotNames = configuredBotNames(manager);
    const connected = manager.list().filter((i) => i.state === 'connected');

    const players = [];
    let border    = { centerX: 0, centerZ: 0, size: 60000000 };
    let dimension = 'minecraft:overworld';

    for (const inst of connected) {
      const mf = inst.mfBot;
      if (!mf) continue;

      if (inst.worldBorderReceived) border = inst.worldBorder;
      if (mf.game?.dimension) dimension = mf.game.dimension;

      // visible human players (from this bot's perspective)
      for (const [username, player] of Object.entries(mf.players ?? {})) {
        if (username === mf.username) continue;
        const entity = player.entity;
        if (!entity?.position || isNaN(entity.position.x)) continue;
        players.push({
          name:  username,
          x:     entity.position.x,
          y:     entity.position.y,
          z:     entity.position.z,
          isBot: knownBotNames.has(username),
          online: true,
        });
      }

      // this bot's own position
      const pos = mf.entity?.position;
      if (pos && !isNaN(pos.x)) {
        players.push({
          name:   inst.actualUsername ?? inst.bot.name,
          x:      pos.x,
          y:      pos.y,
          z:      pos.z,
          isBot:  true,
          online: true,
        });
      }
    }

    res.json({ players, border, dimension });
    } catch (err) {
      console.error('[http]', req.path, err);
      res.status(500).json({ error: err.message || 'internal error' });
    }
  });

  // ---- Minecraft server routes -----------------------------------------
  const srv = express.Router();

  srv.get('/', (_req, res) => {
    // BUG-002: include disk-pressure summary so the dashboard sees disk_low
    // before bots silently stall on ENOSPC.
    const disk = diskWatch?.toJSON?.() ?? null;
    res.json({
      server: mcServer.toJSON(),
      disk,
      diskFreeMB: disk?.freeMB ?? null,
    });
  });

  srv.post('/start', async (_req, res, next) => {
    try {
      await mcServer.start();
      res.json({ server: mcServer.toJSON() });
    } catch (err) { next(err); }
  });

  srv.post('/stop', (_req, res) => {
    mcServer.stop();
    res.json({ server: mcServer.toJSON() });
  });

  srv.post('/command', (req, res) => {
    const { command } = req.body ?? {};
    if (typeof command !== 'string' || !command.trim()) {
      return res.status(400).json({ error: 'command required' });
    }
    mcServer.sendCommand(command.trim());
    res.json({ ok: true });
  });

  api.use('/server', srv);

  // ---- log routes ------------------------------------------------------
  api.get('/logs', (_req, res) => {
    res.json({ sessions: sessionLogger.listSessions() });
  });

  api.get('/logs/:sessionId', (req, res) => {
    const events = sessionLogger.readSession(req.params.sessionId);
    if (!events) return res.status(404).json({ error: 'session not found' });
    res.json({ events });
  });

  // ---- settings routes -------------------------------------------------
  api.get('/settings', (_req, res) => {
    res.json({ settings: settingsStore.toPublicJSON() });
  });

  api.patch('/settings', async (req, res, next) => {
    try {
      // Accept the generic `llmApiKey` and the legacy `cerebrasApiKey` alias;
      // both write to the canonical `llmApiKey` slot.
      const body = req.body ?? {};
      const incoming = body.llmApiKey !== undefined ? body.llmApiKey : body.cerebrasApiKey;
      if (incoming !== undefined) {
        const trimmed = typeof incoming === 'string' ? incoming.trim() : '';
        await settingsStore.set('llmApiKey', trimmed || null);
      }
      res.json({ settings: settingsStore.toPublicJSON() });
    } catch (err) { next(err); }
  });
  // ---- BUG-019: snapshot endpoint --------------------------------------
  // POST /api/bots/:id/snapshot { reason? } → writes a frozen record of
  // inventory, position, last 10 chat lines, full memory state, and named
  // anchors to data/snapshots/<botName>-<reason>-<ts>.json. Doesn't restore
  // anything; just preserves a record before a recycle wipes it.
  api.post('/bots/:id/snapshot', async (req, res, next) => {
    try {
      const instance = manager.get(req.params.id);
      if (!instance) return res.status(404).json({ error: 'not found' });
      const reason = typeof req.body?.reason === 'string' && req.body.reason.trim()
        ? req.body.reason.trim().replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40)
        : 'manual';
      const result = await takeSnapshot(instance, { reason });
      res.json({ ok: true, path: result.path, snapshot: result.snapshot });
    } catch (err) { next(err); }
  });

  // ---- BUG-021: admin slot recycle -------------------------------------
  // POST /api/admin/slots/:slotN/recycle { reason?, nextTestNum? } →
  // snapshot → disconnect → delete memory → kill listener PID on the slot's
  // port → wait for port free → wipe world dirs → spawn fresh java →
  // wait for it to listen → PATCH bot to next TestN → connect.
  // Returns { ok, newTestNum, javaPid, durationMs, snapshotPath }.
  api.post('/admin/slots/:slotN/recycle', async (req, res, next) => {
    try {
      const slotN = Number(req.params.slotN);
      if (!Number.isInteger(slotN) || !PORT_BY_SLOT[slotN]) {
        return res.status(400).json({ error: `invalid slot: ${req.params.slotN}` });
      }
      const reason = typeof req.body?.reason === 'string' && req.body.reason.trim()
        ? req.body.reason.trim().replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40)
        : 'recycle';
      const nextTestNum = req.body?.nextTestNum != null
        ? Number(req.body.nextTestNum)
        : null;
      if (nextTestNum != null && !Number.isInteger(nextTestNum)) {
        return res.status(400).json({ error: 'nextTestNum must be an integer' });
      }
      const out = await recycleSlot({ slotN, reason, nextTestNum, manager });
      res.json(out);
    } catch (err) { next(err); }
  });
  // ----------------------------------------------------------------------

  app.use('/api', api);

  app.use(express.static(config.publicDir, { extensions: ['html'] }));

  // central error handler
  app.use((err, _req, res, _next) => {
    if (err instanceof ValidationError) {
      return res.status(400).json({ error: err.message });
    }
    if (err instanceof BusyError) {
      return res.status(409).json({ error: err.message });
    }
    console.error('[http]', err);
    res.status(500).json({ error: err.message || 'internal error' });
  });

  return app;
}
