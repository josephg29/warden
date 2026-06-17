// BUG-019: capture a bot's runtime + memory state as a frozen JSON record
// just before a wipe. Doesn't restore anything — the goal is forensic
// preservation so a Test28-style mid-run achievement (iron_pickaxe + base
// anchors) isn't silently destroyed by the next restart cycle.
//
// Used by:
//   - POST /api/bots/:id/snapshot (manual capture before any operation)
//   - recycleSlot in src/admin.js (always called first, before disconnect)

import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

const SNAPSHOT_SUBDIR = 'snapshots';
const RECENT_CHAT_LIMIT = 10;

// Filename-safe snapshot reason — already validated upstream but defense in
// depth keeps `../` style strings from reaching the filesystem.
function sanitizeReason(reason) {
  if (!reason) return 'manual';
  return String(reason).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40) || 'manual';
}

function safeBotName(name) {
  return String(name || 'bot').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40);
}

export async function takeSnapshot(instance, opts = {}) {
  if (!instance) throw new Error('takeSnapshot: instance is required');

  const reason = sanitizeReason(opts.reason);
  const dir    = opts.dir ?? path.join(config.dataDir, SNAPSHOT_SUBDIR);
  const ts     = new Date();

  const mf       = instance.mfBot;
  const memSnap  = instance.memoryState ?? null;
  const memState = memSnap?.state ?? null;

  const inventory = mf?.inventory
    ? mf.inventory.items().map((i) => ({
        slot:  i.slot,
        name:  i.name,
        count: i.count,
        durabilityUsed: i.durabilityUsed ?? null,
      }))
    : [];

  const pos = mf?.entity?.position;
  const position = pos && Number.isFinite(pos.x)
    ? { x: pos.x, y: pos.y, z: pos.z }
    : null;

  // last N chat lines from the memory event ring buffer. We treat anything
  // typed `chat` as a chat line — that's how PlayerMemory tags chat_in
  // events. Self-narration (decisions with `say`) lives in people[].exchanges
  // so we don't pull it here.
  const events = Array.isArray(memState?.recent_events) ? memState.recent_events : [];
  const recentChat = events
    .filter((e) => e?.type === 'chat')
    .slice(-RECENT_CHAT_LIMIT)
    .map((e) => ({ ts: e.ts, summary: e.summary, location: e.location ?? null }));

  const anchors = Array.isArray(memState?.anchors) ? memState.anchors : [];

  const snapshot = {
    schemaVersion: 1,
    capturedAt:    ts.toISOString(),
    reason,
    bot: {
      id:             instance.bot.id,
      name:           instance.bot.name,
      port:           instance.bot.port,
      actualUsername: instance.actualUsername,
      state:          instance.state,
    },
    position,
    health:     mf?.health     ?? null,
    food:       mf?.food       ?? null,
    experience: mf?.experience ?? null,
    dimension:  mf?.game?.dimension ?? null,
    inventory,
    anchors,
    recentChat,
    memoryState: memState,
  };

  await fsp.mkdir(dir, { recursive: true });
  const fname = `${safeBotName(instance.bot.name)}-${reason}-${ts.getTime()}.json`;
  const filePath = path.join(dir, fname);
  await fsp.writeFile(filePath, JSON.stringify(snapshot, null, 2), 'utf8');

  return { path: filePath, snapshot };
}
