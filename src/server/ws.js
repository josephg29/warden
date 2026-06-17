import { WebSocketServer } from 'ws';

// ---- world tick broadcaster ------------------------------------------------

let _worldTickInterval = null;

function startWorldTick(manager, broadcast) {
  if (_worldTickInterval) return;
  _worldTickInterval = setInterval(() => {
    const connected = manager.list().filter((i) => i.state === 'connected');
    if (!connected.length) {
      clearInterval(_worldTickInterval);
      _worldTickInterval = null;
      return;
    }

    const knownNames = new Set();
    for (const i of manager.list()) {
      if (i.bot.name)       knownNames.add(i.bot.name);
      if (i.actualUsername) knownNames.add(i.actualUsername);
    }

    const bots       = [];
    const playersMap = new Map();
    let border       = { centerX: 0, centerZ: 0, size: 60000000 };

    for (const inst of connected) {
      const mf = inst.mfBot;
      if (!mf) continue;

      const pos = mf.entity?.position;
      if (!pos || isNaN(pos.x)) continue;

      if (inst.worldBorderReceived) border = inst.worldBorder;

      const bi = inst.brainInfo;
      bots.push({
        id:               inst.bot.id,
        name:             inst.actualUsername ?? inst.bot.name,
        x:                pos.x,
        y:                pos.y,
        z:                pos.z,
        yaw:              mf.entity?.yaw ?? 0,
        health:           mf.health ?? 20,
        food:             mf.food ?? 20,
        currentSkillName: bi?.currentSkill?.name ?? null,
      });

      // non-bot players visible to this bot
      for (const [username, player] of Object.entries(mf.players ?? {})) {
        if (username === mf.username) continue;
        if (knownNames.has(username)) continue;
        if (playersMap.has(username)) continue;
        const entity = player.entity;
        if (!entity?.position || isNaN(entity.position.x)) continue;
        playersMap.set(username, {
          name: username,
          x:    entity.position.x,
          y:    entity.position.y,
          z:    entity.position.z,
        });
      }
    }

    broadcast({
      type:    'world:tick',
      ts:      Date.now(),
      bots,
      players: [...playersMap.values()],
      border,
    });
  }, 1000);
}

// ---------------------------------------------------------------------------

export function attachWs({ httpServer, manager, mcServer, settingsStore }) {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  const clients = new Set();

  wss.on('connection', (ws) => {
    clients.add(ws);
    safeSend(ws, {
      type:     'snapshot',
      bots:     manager.serialize(),
      server:   mcServer.toJSON(),
      settings: settingsStore.toPublicJSON(),
    });

    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
  });

  const broadcast = (message) => {
    const payload = JSON.stringify(message);
    for (const client of clients) {
      if (client.readyState === client.OPEN) client.send(payload);
    }
  };

  // Step 2.6 hardening: wrap manager event listeners so a throw in any
  // single broadcast (bad instance.toJSON, mineflayer mid-state mutation,
  // serializer failure on a circular ref) doesn't propagate up through the
  // EventEmitter into an unhandled rejection that crashes the dashboard.
  // bot fleet events
  manager.on('upsert', (instance) => {
    try {
      broadcast({ type: 'bot:upsert', bot: instance.toJSON() });
      if (!_worldTickInterval && manager.list().some((i) => i.state === 'connected')) {
        startWorldTick(manager, broadcast);
      }
    } catch (err) { console.error('[ws-listener] upsert:', err); }
  });
  manager.on('delete', (id) => {
    try { broadcast({ type: 'bot:delete', id }); }
    catch (err) { console.error('[ws-listener] delete:', err); }
  });
  manager.on('chat', (entry) => {
    try { broadcast({ type: 'bot:chat', ...entry }); }
    catch (err) { console.error('[ws-listener] chat:', err); }
  });

  // brain decision & skill broadcasts
  manager.on('decision', (entry) => {
    try { broadcast({ type: 'bot:decision', botId: entry.botId, decision: entry }); }
    catch (err) { console.error('[ws-listener] decision:', err); }
  });
  manager.on('brain-event', (entry) => {
    try {
      if (entry.type === 'skill_done') {
        broadcast({ type: 'bot:skill-done', botId: entry.botId, result: entry.data });
      }
    } catch (err) { console.error('[ws-listener] brain-event:', err); }
  });
  manager.on('memory-update', (entry) => {
    try {
      broadcast({
        type:         'bot:memory-update',
        botId:        entry.botId,
        contextBlock: entry.contextBlock,
        state:        entry.state,
      });
    } catch (err) { console.error('[ws-listener] memory-update:', err); }
  });

  // settings events
  settingsStore.on('change', () => {
    broadcast({ type: 'settings:update', settings: settingsStore.toPublicJSON() });
  });

  // minecraft server events
  mcServer.on('change', () => {
    broadcast({ type: 'server:status', server: mcServer.toJSON() });
  });
  mcServer.on('log', (entry) => {
    broadcast({ type: 'server:log', ...entry });
  });

  // start tick immediately if bots are already connected (e.g. after hot-reload)
  if (manager.list().some((i) => i.state === 'connected')) {
    startWorldTick(manager, broadcast);
  }

  return wss;
}

function safeSend(ws, message) {
  if (ws.readyState !== ws.OPEN) return;
  try { ws.send(JSON.stringify(message)); }
  catch (err) { console.error('[ws] send failed:', err); }
}
