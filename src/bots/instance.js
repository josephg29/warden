import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import mineflayer from 'mineflayer';
import { config } from '../config.js';
import { hasLLMKey } from '../llm.js';
import { Brain } from './brain.js';
import { PlayerMemory } from './player-memory.js';
import { safeError } from '../safe-error.js';

// BUG-013: ring-buffer of last positions and the chunk hash so post-mortem
// can correlate disconnect storms with a specific chunk. Sampled once per
// second on physicsTick (mineflayer fires that ~20×/s; we throttle).
const POSITION_RING_SIZE         = 5;
const POSITION_SAMPLE_INTERVAL_MS = 1000;
const DISCONNECT_LOG_DIR_NAME     = 'diagnostics';
const DISCONNECT_LOG_FILE_NAME    = 'disconnects.jsonl';
const DEATH_LOG_FILE_NAME         = 'deaths.jsonl';
// OVN-004: hostile-radius used for "what was nearby when we died". Tighter
// than HOSTILE_RADIUS in brain.js because we want only actual threats, not
// awareness-radius mobs.
const DEATH_HOSTILE_RADIUS       = 8;

// BUG-018: a respawn at y < SAFE_SPAWN_Y is treated as "into deepslate / void"
// and triggers an auto-/tp to a safer altitude. Test29 today respawned at
// (0,-58,0) just above the void layer at y=-64.
const SAFE_SPAWN_Y    = 30;
const TP_TARGET_Y     = 80;

function hasCerebrasKey() {
  return hasLLMKey();
}

export const STATE = Object.freeze({
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  ERROR: 'error',
});

export class BusyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BusyError';
  }
}

export class BotInstance extends EventEmitter {
  constructor(bot) {
    super();
    this.bot = bot;                // persisted record
    this.state = STATE.DISCONNECTED;
    this.error = null;
    this.joinedAt = null;
    this.pendingAuth = null;       // { userCode, verificationUri, expiresAt }
    this.actualUsername = null;    // populated after spawn (esp. for MS auth)
    this._mfBot = null;
    this._brain = null;
    this._memory = null;
    this._busy = false;
    // persists across Brain rebuilds — debounce NaN reconnect storms
    this._lastReconnectAt = 0;
    // dashboard extensions
    this._worldBorder = { centerX: 0, centerZ: 0, size: 60000000 };
    this._worldBorderReceived = false;
    this._lastMemorySnapshot = null;   // { contextBlock, state } — survives disconnect
    this._memoryBroadcastThrottle = 0;

    // BUG-013: ring-buffer of recent positions so the kicked/end handlers can
    // capture where the bot actually was when it dropped. Each entry is
    // { ts, x, y, z, chunk: { x, z } }.
    this._positionRing = [];
    this._lastPositionSampleAt = 0;
    // OVN-004: instrumentation for the slot-3 death-loop investigation.
    // Captures everything we can grab at the moment mineflayer fires the
    // death event so we can correlate failure modes (void, lava, hostile,
    // suffocation, fall) with spawn coords and tenure.
    this._lastSpawnAt = 0;
    this._lastHpBeforeDeath = 20;
    this._deathCount = 0;
  }

  toJSON() {
    const bi = this.brainInfo;
    return {
      ...this.bot,
      state: this.state,
      error: this.error,
      joinedAt: this.joinedAt,
      pendingAuth: this.pendingAuth,
      actualUsername: this.actualUsername,
      hasBrain: !!this._brain,
      // F3: truthful brain status — distinguishes a healthy brain that's
      // making decisions from one that's connected but inert.
      brainStatus:       bi?.status               ?? (this._brain ? 'starting' : 'none'),
      lastDecisionAgeS:  bi?.lastDecisionAgeS     ?? null,
      lastBrainError:    bi?.lastError            ?? null,
    };
  }

  // ---- dashboard read-only getters ----------------------------------------

  get mfBot() { return this._mfBot; }
  get worldBorder() { return this._worldBorder; }
  get worldBorderReceived() { return this._worldBorderReceived; }

  get brainInfo() {
    if (!this._brain) return null;
    const b = this._brain;
    const cs = b._currentSkill;
    const now = Date.now();
    const lastDecisionAgeS = b.lastDecision ? Math.round((now - b.lastDecision.ts) / 1000) : null;
    // F3: derived status field for the dashboard
    // Step 2.6 (2026-05-16): 'llm_backoff' is a new, distinct state for "the
    // brain is intentionally sleeping in Cerebras backoff" — separate from
    // 'error' (last call failed) and 'stalled' (lastDecision is stale and no
    // explanation). The watchdog uses this to skip slot recycle when the bot
    // is just patiently waiting for Cerebras to recover.
    let status;
    if (b._llmInBackoff && b._llmInBackoff()) {
      status = 'llm_backoff';
    } else if (!b.lastDecision) {
      status = 'starting';
    } else if (lastDecisionAgeS != null && lastDecisionAgeS > 60) {
      status = 'stalled';
    } else {
      status = 'active';
    }

    // BUG-015 (synthesize lastError when only _lastErrMsg was populated). The
    // earlier `status === 'error'` branch was removed in Step 2.6 — that
    // status is no longer reachable (in-backoff bots now read as
    // 'llm_backoff'). This single synthesis below remains to keep the
    // dashboard's "last error" tile populated for any catch-path that
    // updated the loose string but not the typed lastError object.
    let lastError = b.lastError ?? null;
    if (!lastError && b._lastErrMsg) {
      lastError = { ts: Date.now(), status: null, message: String(b._lastErrMsg).slice(0, 200) };
    }

    return {
      currentSkill:    cs ? { name: cs.name, args: cs.args, startedAt: cs.startedAt } : null,
      lastDecision:    b.lastDecision ?? null,
      lastSkillResult: b.lastSkillResult ?? null,
      lastError,
      lastDecisionAgeS,
      status,
    };
  }

  get memoryState() {
    if (this._memory) {
      try {
        return { contextBlock: this._memory.contextBlock(), state: this._memory._state };
      } catch { /* fall through */ }
    }
    return this._lastMemorySnapshot ?? null;
  }

  getFullState() {
    const mf = this._mfBot;
    const pos = mf?.entity?.position;
    const bi = this.brainInfo;
    return {
      id:             this.bot.id,
      name:           this.bot.name,
      state:          this.state,
      actualUsername: this.actualUsername,
      joinedAt:       this.joinedAt,
      position: (pos && !isNaN(pos.x)) ? {
        x: pos.x, y: pos.y, z: pos.z,
        yaw:   mf.entity?.yaw   ?? 0,
        pitch: mf.entity?.pitch ?? 0,
      } : null,
      health:     mf?.health     ?? null,
      food:       mf?.food       ?? null,
      experience: mf?.experience ?? null,
      dimension:  mf?.game?.dimension ?? null,
      inventory: mf?.inventory ? mf.inventory.items().map((i) => ({
        slot: i.slot, name: i.name, count: i.count,
        durabilityUsed: i.durabilityUsed ?? null,
      })) : [],
      currentSkill:    bi?.currentSkill    ?? null,
      lastDecision:    bi?.lastDecision    ?? null,
      lastSkillResult: bi?.lastSkillResult ?? null,
      // F3: also include in /state for easy polling
      brainStatus:      bi?.status            ?? (this._brain ? 'starting' : 'none'),
      lastDecisionAgeS: bi?.lastDecisionAgeS  ?? null,
      lastBrainError:   bi?.lastError         ?? null,
      memory:          this.memoryState,
    };
  }

  async connect() {
    if (this._busy) throw new BusyError('bot is currently transitioning');
    if (this.state === STATE.CONNECTED || this.state === STATE.CONNECTING) return;

    this._busy = true;
    this.actualUsername = null;
    this._setState(STATE.CONNECTING, null);

    try {
      const auth = this.bot.auth || 'offline';
      const opts = {
        host: this.bot.host,
        port: this.bot.port,
        auth,
      };

      if (auth === 'microsoft') {
        // for MS auth, `username` is treated as a stable cache key — using
        // the bot id keeps each bot's token cache isolated from the others.
        opts.username = this.bot.id;
        opts.profilesFolder = config.msaCacheDir;
        opts.onMsaCode = (data) => {
          this.pendingAuth = {
            userCode: data?.user_code ?? '',
            verificationUri: data?.verification_uri ?? 'https://www.microsoft.com/link',
            expiresAt: data?.expires_in
              ? new Date(Date.now() + data.expires_in * 1000).toISOString()
              : null,
          };
          this.emit('change');
        };
      } else {
        opts.username = this.bot.name;
      }

      if (this.bot.version && this.bot.version !== 'auto') {
        opts.version = this.bot.version;
      }

      const mf = mineflayer.createBot(opts);
      this._mfBot = mf;

      await new Promise((resolve, reject) => {
        const cleanupListeners = () => {
          mf.removeListener('spawn', onSpawn);
          mf.removeListener('error', onError);
          mf.removeListener('end', onEnd);
          mf.removeListener('kicked', onKicked);
        };
        const onSpawn = () => { cleanupListeners(); resolve(); };
        const onError = (err) => { cleanupListeners(); reject(err); };
        const onEnd = (reason) => {
          cleanupListeners();
          reject(new Error(`disconnected before spawn: ${reason || 'unknown'}`));
        };
        const onKicked = (reason) => {
          cleanupListeners();
          const r = typeof reason === 'string' ? reason : safeStringify(reason);
          reject(new Error(`kicked: ${r}`));
        };
        mf.once('spawn', onSpawn);
        mf.once('error', onError);
        mf.once('end', onEnd);
        mf.once('kicked', onKicked);
      });

      this._wireRuntimeEvents(mf);
      this.actualUsername = mf.username || null;
      this.joinedAt = new Date().toISOString();
      this._setState(STATE.CONNECTED, null);

      if (hasCerebrasKey()) {
        const memory = new PlayerMemory(this.bot.id, {
          persona:  this.bot.persona ?? `${this.bot.name}, a curious survivor on a fresh Minecraft server`,
          dataDir:  config.dataDir,
        });
        await memory.load();
        this._memory = memory;

        this._brain = new Brain(mf, {
          memory,
          systemPromptOverride: this.bot.systemPromptOverride ?? null,
          chatRethinkGapMs:     this.bot.chatRethinkGapMs ?? 0,
          onDecision:  (d) => this.emit('decision', { botId: this.bot.id, name: this.bot.name, ...d }),
          onEvent:     (e) => {
            const pos = mf.entity?.position;
            const loc = pos && Number.isFinite(pos.x) && Number.isFinite(pos.z)
              ? { x: Math.round(pos.x), y: Math.round(pos.y ?? 64), z: Math.round(pos.z) }
              : null;
            const enriched = loc ? { ...e, location: loc } : e;
            try { memory.handleEvent(enriched); } catch (err) {
              console.warn(`[memory:${this.bot.name}] handleEvent failed: ${err.message}`);
            }
            this.emit('brain-event', { botId: this.bot.id, name: this.bot.name, ...enriched });
            // always keep snapshot fresh (survives disconnect)
            try {
              const contextBlock = memory.contextBlock();
              this._lastMemorySnapshot = { contextBlock, state: memory._state };
              // throttled broadcast ≤1/s per bot
              const now = Date.now();
              if (now - this._memoryBroadcastThrottle >= 1000) {
                this._memoryBroadcastThrottle = now;
                this.emit('memory-update', { botId: this.bot.id, contextBlock, state: memory._state });
              }
            } catch { /* noop */ }
          },
          onError:     (e) => {
            this.error = e.message;
            this.emit('change');
          },
          onReconnect: () => {
            const now = Date.now();
            const sinceLast = now - this._lastReconnectAt;
            // Debounce: a reconnect cycle takes ~5–10s during which positions
            // briefly NaN. Without this guard the new Brain triggers its own
            // reconnect on the first think and we storm the server.
            if (this._lastReconnectAt && sinceLast < 30000) {
              console.warn(`[brain] NaN reconnect for ${this.bot.name} suppressed (${Math.round(sinceLast/1000)}s since last)`);
              return;
            }
            // Don't reconnect if we just joined — give the world ~10s to send
            // the entity packet that fills in our position.
            if (this.joinedAt) {
              const sinceJoin = now - new Date(this.joinedAt).getTime();
              if (sinceJoin < 10000) {
                console.warn(`[brain] NaN reconnect for ${this.bot.name} suppressed (only ${Math.round(sinceJoin/1000)}s since join — waiting for world sync)`);
                return;
              }
            }
            this._lastReconnectAt = now;
            console.warn(`[brain] NaN reconnect triggered for ${this.bot.name}`);
            this.disconnect().then(() => this.connect()).catch((err) => {
              safeError(this.bot.id, `reconnect failed for ${this.bot.name}: ${err.message}`);
            });
          },
        });
        this._brain.start();
        console.log(`[brain] started for ${this.bot.name}`);
      } else {
        console.warn(`[brain] skipped for ${this.bot.name} — no API key set`);
      }
    } catch (err) {
      this._cleanup();
      this._setState(STATE.ERROR, formatError(err));
      throw err;
    } finally {
      this._busy = false;
    }
  }

  async disconnect() {
    if (this.state === STATE.DISCONNECTED) return;

    // Force-cancel an in-flight connect (e.g. during MS auth device-code wait).
    // Calling mf.end() triggers the 'end' event the connect promise listens for,
    // which rejects the promise. The connect catch+finally then cleans up.
    if (this._busy && this.state === STATE.CONNECTING) {
      if (this._mfBot) {
        try { this._mfBot.end(); } catch { /* noop */ }
      }
      const start = Date.now();
      while (this._busy && Date.now() - start < 5000) {
        await new Promise((r) => setTimeout(r, 50));
      }
      if (this.state !== STATE.DISCONNECTED) {
        this._cleanup();
        this._setState(STATE.DISCONNECTED, null);
      }
      return;
    }

    if (this._busy) throw new BusyError('bot is currently transitioning');

    this._busy = true;
    try {
      const mf = this._mfBot;
      if (!mf) {
        this._setState(STATE.DISCONNECTED, null);
        return;
      }

      await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          mf.removeListener('end', finish);
          resolve();
        };
        mf.once('end', finish);
        try {
          mf.quit('disconnected by warden');
        } catch {
          finish();
        }
        // hard timeout — never let disconnect hang
        setTimeout(finish, 3000).unref();
      });

      this._cleanup();
      this._setState(STATE.DISCONNECTED, null);
    } finally {
      this._busy = false;
    }
  }

  _wireRuntimeEvents(mf) {
    // BUG-013: sample bot.entity.position into the ring buffer ~1×/s. We hook
    // physicsTick (fires ~20×/s) and throttle locally so we don't allocate
    // 20× more than we need.
    mf.on('physicsTick', () => {
      const now = Date.now();
      if (now - this._lastPositionSampleAt < POSITION_SAMPLE_INTERVAL_MS) return;
      const p = mf.entity?.position;
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.z)) return;
      this._lastPositionSampleAt = now;
      this._positionRing.push({
        ts: now,
        x: Math.round(p.x * 100) / 100,
        y: Math.round(p.y * 100) / 100,
        z: Math.round(p.z * 100) / 100,
        chunk: { x: Math.floor(p.x / 16), z: Math.floor(p.z / 16) },
      });
      if (this._positionRing.length > POSITION_RING_SIZE) {
        this._positionRing.splice(0, this._positionRing.length - POSITION_RING_SIZE);
      }
    });

    mf.on('error', (err) => {
      this.error = formatError(err);
      this.emit('change');
    });

    mf.on('kicked', (reason) => {
      this.error = typeof reason === 'string' ? reason : safeStringify(reason);
      // BUG-013: persist forensic data — last 5 positions, chunk hash, raw
      // payload — so we can correlate Test10-style disconnect storms with a
      // specific chunk or coord without needing the bot to be alive.
      this._recordDisconnectDiagnostic({ event: 'kicked', reason });
      this.emit('change');
    });

    mf.on('end', (reason) => {
      if (this._busy) return; // graceful disconnect path handles it
      // BUG-013: persist before cleanup wipes _mfBot.
      this._recordDisconnectDiagnostic({ event: 'end', reason });
      this._cleanup();
      this._setState(STATE.ERROR, this.error || `connection ended: ${reason || 'unknown'}`);
    });

    mf.on('chat', (username, message) => {
      this.emit('chat', { botId: this.bot.id, username, message, ts: new Date().toISOString() });
    });

    // OVN-004: track HP just-before-death so the diagnostic can report what
    // damage shape killed us (single hit from full HP = something dangerous;
    // gradual drain to 0 = sustained pressure). mineflayer fires `health`
    // before `death`, so the latest snapshot is captured here.
    mf.on('health', () => {
      const h = mf.health;
      if (typeof h === 'number' && h > 0) this._lastHpBeforeDeath = h;
    });

    // OVN-004: death diagnostic. Capture coords, dimension, nearby hostiles,
    // recent positions, food, time since last spawn — written synchronously
    // to data/diagnostics/deaths.jsonl so a slot that crashes immediately
    // afterward doesn't lose the record.
    mf.on('death', () => {
      this._deathCount += 1;
      this._recordDeathDiagnostic();
    });

    // BUG-018: every spawn (initial and respawn), check if we landed in the
    // deepslate / void zone (y < SAFE_SPAWN_Y). If so, ask the server to /tp
    // us up — bots are op'd in our offline-mode setup so the server executes
    // the command. Best-effort: if not op'd, the chat goes nowhere and the
    // brain handles it on the next think.
    mf.on('spawn', () => {
      // OVN-004: stamp the spawn time so the death diagnostic can compute
      // tenure ("died 12s after spawn" vs "died 18min after spawn").
      this._lastSpawnAt = Date.now();
      this._lastHpBeforeDeath = mf.health ?? 20;
      const p = mf.entity?.position;
      if (!p || !Number.isFinite(p.y)) return;
      if (p.y >= SAFE_SPAWN_Y) return;
      const who = mf.username ?? this.actualUsername ?? this.bot.name ?? '@s';
      console.warn(`[bot:${this.bot.name}] unsafe spawn at y=${Math.round(p.y)} — auto-tp to y=${TP_TARGET_Y}`);
      try {
        // /tp <self> ~ <y> ~ keeps x,z and lifts y to a safe altitude.
        mf.chat(`/tp ${who} ~ ${TP_TARGET_Y} ~`);
      } catch (err) {
        console.warn(`[bot:${this.bot.name}] auto-tp failed: ${err.message}`);
      }
    });

    // worldborder tracking via raw protocol packets (best-effort; field names vary by version)
    const raw = mf._client;
    if (raw) {
      const applySize = (p) => {
        const size = p.newDiameter ?? p.diameter ?? (p.radius != null ? p.radius * 2 : null);
        if (size != null && !isNaN(size)) {
          this._worldBorder = {
            centerX: p.x ?? p.centerX ?? this._worldBorder.centerX,
            centerZ: p.z ?? p.centerZ ?? this._worldBorder.centerZ,
            size,
          };
          this._worldBorderReceived = true;
        }
      };
      const applyCenter = (p) => {
        if (p.x != null && p.z != null && !isNaN(p.x)) {
          this._worldBorder = { ...this._worldBorder, centerX: p.x, centerZ: p.z };
          this._worldBorderReceived = true;
        }
      };
      raw.on('initialize_world_border', applySize);
      raw.on('world_border',           applySize);
      raw.on('world_border_size',      applySize);
      raw.on('world_border_lerp_size', applySize);
      raw.on('world_border_center',    applyCenter);
    }
  }

  // BUG-013: synchronous append to data/diagnostics/disconnects.jsonl so
  // we never lose the record to an async-error race. Best-effort — if the
  // disk is full (the very thing BUG-002 fixes), this throws into the catch
  // and we move on without crashing the bot lifecycle.
  _recordDisconnectDiagnostic({ event, reason }) {
    try {
      const mf = this._mfBot;
      const p  = mf?.entity?.position;
      const currentChunk = (p && Number.isFinite(p.x))
        ? { x: Math.floor(p.x / 16), z: Math.floor(p.z / 16) }
        : null;
      const entry = {
        ts:   new Date().toISOString(),
        botId: this.bot.id,
        name:  this.bot.name,
        port:  this.bot.port,
        event,
        reasonRaw:    reason ?? null,
        reasonString: typeof reason === 'string' ? reason : safeStringify(reason),
        recentPositions: this._positionRing.slice(),
        currentChunk,
        worldBorder:  { ...this._worldBorder, received: this._worldBorderReceived },
        health: mf?.health ?? null,
        food:   mf?.food   ?? null,
        dimension: mf?.game?.dimension ?? null,
      };
      const dir  = path.join(config.dataDir, DISCONNECT_LOG_DIR_NAME);
      const file = path.join(dir, DISCONNECT_LOG_FILE_NAME);
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(file, JSON.stringify(entry) + '\n');
    } catch (err) {
      console.warn(`[bot:${this.bot.name}] disconnect-diagnostic write failed: ${err.message}`);
    }
  }

  // OVN-004: synchronous write so a death that immediately precedes a
  // disconnect/crash still leaves a record. Modeled after the disconnect
  // diagnostic — same dir, sibling jsonl, identical safety.
  _recordDeathDiagnostic() {
    try {
      const mf = this._mfBot;
      const p  = mf?.entity?.position;
      const tenureMs = this._lastSpawnAt ? Date.now() - this._lastSpawnAt : null;

      // Find hostiles within DEATH_HOSTILE_RADIUS at the moment of death so
      // we can attribute the kill to a specific mob type even when mineflayer
      // doesn't expose the damage source directly.
      const nearbyHostiles = [];
      if (p && Number.isFinite(p.x) && mf?.entities) {
        for (const e of Object.values(mf.entities)) {
          if (!e?.position || !Number.isFinite(e.position.x)) continue;
          if (e === mf.entity) continue;
          const dx = e.position.x - p.x, dy = (e.position.y ?? p.y) - p.y, dz = e.position.z - p.z;
          const d  = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (d > DEATH_HOSTILE_RADIUS) continue;
          // Match brain.js's preferred name source — drop e.mobType (OVN-010).
          const name = (e.name ?? e.username ?? '').toLowerCase();
          if (!name) continue;
          nearbyHostiles.push({ name, distance: Math.round(d * 10) / 10 });
        }
        nearbyHostiles.sort((a, b) => a.distance - b.distance);
      }

      const entry = {
        ts:   new Date().toISOString(),
        botId: this.bot.id,
        name:  this.bot.name,
        port:  this.bot.port,
        deathCount: this._deathCount,
        tenureMs,
        position: (p && Number.isFinite(p.x))
          ? { x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100, z: Math.round(p.z * 100) / 100 }
          : null,
        currentChunk: (p && Number.isFinite(p.x))
          ? { x: Math.floor(p.x / 16), z: Math.floor(p.z / 16) }
          : null,
        recentPositions: this._positionRing.slice(),
        nearbyHostiles: nearbyHostiles.slice(0, 6),
        hpBeforeDeath: this._lastHpBeforeDeath,
        food: mf?.food ?? null,
        dimension: mf?.game?.dimension ?? null,
        // y < -60 strongly implies void; y near 0 with lava nearby implies lava
        // — the field is here so a downstream analysis script can pivot.
        likelyVoid: !!(p && Number.isFinite(p.y) && p.y <= -60),
      };
      const dir  = path.join(config.dataDir, DISCONNECT_LOG_DIR_NAME);
      const file = path.join(dir, DEATH_LOG_FILE_NAME);
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(file, JSON.stringify(entry) + '\n');
    } catch (err) {
      console.warn(`[bot:${this.bot.name}] death-diagnostic write failed: ${err.message}`);
    }
  }

  _cleanup() {
    if (this._brain) {
      this._brain.stop();
      this._brain = null;
    }
    if (this._memory) {
      // synchronous flush inside stop() so a process exit after disconnect persists state
      this._memory.stop().catch((err) => console.warn(`[memory] stop failed for ${this.bot.name}: ${err.message}`));
      this._memory = null;
    }
    if (this._mfBot) {
      const mf = this._mfBot;
      this._mfBot = null;
      try {
        mf.removeAllListeners();
        // permanent no-op listener so any straggling errors from internal
        // sockets emitted after teardown never crash the process
        mf.on('error', () => {});
        mf.end();
      } catch { /* noop */ }
    }
    this.joinedAt = null;
    this.actualUsername = null;
  }

  _setState(state, error) {
    this.state = state;
    this.error = error;
    if (state !== STATE.CONNECTING) {
      this.pendingAuth = null;
    }
    this.emit('change');
  }
}

function safeStringify(value) {
  try { return JSON.stringify(value); } catch { return String(value); }
}

function formatError(err) {
  if (!err) return 'unknown error';
  if (Array.isArray(err.errors) && err.errors.length > 0) {
    const inner = err.errors[0];
    return inner?.code || inner?.message || String(inner);
  }
  return err.code || err.message || String(err);
}
