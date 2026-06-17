// BUG-014 mitigation: route every error log through a single async,
// rate-limited path so one bot's stderr storm cannot starve the shared
// Node event loop and time out every other bot's mineflayer connection.
//
// The proper architectural fix — running each bot in its own Node child
// process — is tracked under BUG-014 in the backlog and remains deferred
// (estimate: weeks of work; touches BotManager, BotInstance, the WebSocket
// aggregator, and every API endpoint that talks to a bot). This module
// addresses the actual failure shape we observed on 2026-05-04:
// synchronous `console.trace()` deprecation warnings firing simultaneously
// across all 5 bots backed up the stderr pipe and blocked the event loop.
//
// Two layers of protection:
//
//   1. Per-bot rate limit. A bot exceeding PER_BOT_LIMIT errors inside
//      PER_BOT_WINDOW_MS has its writes silently dropped until the window
//      rolls. We emit one summary line per drop window so the operator
//      knows traffic is being suppressed.
//
//   2. Fleet-wide circuit breaker. If the cross-bot total exceeds
//      FLEET_LIMIT inside FLEET_WINDOW_MS we suppress all error writes for
//      FLEET_COOLDOWN_MS, again with a single summary on entry/exit.
//
// All writes go through `setImmediate` so they never run on the same tick
// as the calling code — even a synchronous storm spreads across ticks.

const PER_BOT_LIMIT       = 5;
const PER_BOT_WINDOW_MS   = 1_000;
const FLEET_LIMIT         = 30;
const FLEET_WINDOW_MS     = 1_000;
const FLEET_COOLDOWN_MS   = 5_000;
const FLEET_KEY           = '__fleet__';

class RingCounter {
  constructor(windowMs) { this.windowMs = windowMs; this.events = []; }
  push(now) {
    this.events.push(now);
    const cutoff = now - this.windowMs;
    while (this.events.length && this.events[0] < cutoff) this.events.shift();
    return this.events.length;
  }
  size(now) {
    const cutoff = now - this.windowMs;
    while (this.events.length && this.events[0] < cutoff) this.events.shift();
    return this.events.length;
  }
}

const perBot = new Map();   // botId -> { ring, droppedSinceLastNotice, lastNoticeAt }
let fleetRing = new RingCounter(FLEET_WINDOW_MS);
let fleetCooldownUntil = 0;
let fleetDroppedDuringCooldown = 0;
let fleetCooldownAnnouncedAt = 0;

function bucketFor(botId) {
  let b = perBot.get(botId);
  if (!b) {
    b = { ring: new RingCounter(PER_BOT_WINDOW_MS), droppedSinceLastNotice: 0, lastNoticeAt: 0 };
    perBot.set(botId, b);
  }
  return b;
}

function fmtArgs(args) {
  return args.map((a) => {
    if (a instanceof Error) return a.stack || a.message;
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ');
}

function emit(prefix, args) {
  // Defer the actual stderr write off the current tick so a synchronous
  // burst of safeError calls cannot block the event loop within one tick.
  setImmediate(() => {
    try { console.error(prefix, fmtArgs(args)); }
    catch { /* swallow — error path must never throw */ }
  });
}

/**
 * Log an error tagged with a botId, with both per-bot and fleet-wide
 * back-pressure. Never throws; never blocks; safe to call from any tick.
 *
 * @param {string} botId  identifier — bot id, "fleet", "uncaught", etc.
 * @param  {...any} args  printf-style args; first arg is usually the message.
 */
export function safeError(botId, ...args) {
  const now = Date.now();
  const id = botId || 'unknown';

  // Layer 2: fleet circuit breaker.
  if (now < fleetCooldownUntil) {
    fleetDroppedDuringCooldown += 1;
    return;
  }
  const fleetCount = fleetRing.push(now);
  if (fleetCount > FLEET_LIMIT) {
    fleetCooldownUntil = now + FLEET_COOLDOWN_MS;
    if (now - fleetCooldownAnnouncedAt > FLEET_COOLDOWN_MS) {
      fleetCooldownAnnouncedAt = now;
      emit('[safe-error]', [`fleet error rate exceeded (${fleetCount}/${FLEET_WINDOW_MS}ms) — suppressing for ${FLEET_COOLDOWN_MS}ms`]);
    }
    fleetDroppedDuringCooldown += 1;
    return;
  }

  // Layer 1: per-bot rate limit.
  const bucket = bucketFor(id);
  const perBotCount = bucket.ring.push(now);
  if (perBotCount > PER_BOT_LIMIT) {
    bucket.droppedSinceLastNotice += 1;
    if (now - bucket.lastNoticeAt > PER_BOT_WINDOW_MS) {
      bucket.lastNoticeAt = now;
      const dropped = bucket.droppedSinceLastNotice;
      bucket.droppedSinceLastNotice = 0;
      emit(`[safe-error:${id}]`, [`rate-limit ${dropped} suppressed in last ${PER_BOT_WINDOW_MS}ms`]);
    }
    return;
  }

  emit(`[bot:${id}]`, args);
}

/**
 * Report a fleet-wide event (uncaught exception, unhandled rejection,
 * cross-cutting infra error). Tagged with `[fleet]` so log readers can
 * distinguish per-bot from process-wide failures.
 */
export function safeFleetError(...args) {
  safeError('fleet', ...args);
}

/**
 * Drain pending fleet-cooldown drops if any — useful at the end of a
 * cooldown window so the operator sees the total suppressed count.
 * Called from a low-frequency timer in startSafeErrorReporter.
 */
function maybeDrainFleetCooldown() {
  if (fleetDroppedDuringCooldown === 0) return;
  if (Date.now() < fleetCooldownUntil) return;
  const n = fleetDroppedDuringCooldown;
  fleetDroppedDuringCooldown = 0;
  emit('[safe-error]', [`fleet cooldown ended; ${n} writes were suppressed`]);
}

/**
 * Install process-wide handlers for uncaught exceptions / unhandled
 * rejections that route through safeFleetError. Returns a stop() handle.
 */
export function startSafeErrorReporter() {
  const onUncaught   = (err) => safeFleetError('uncaughtException:', err);
  const onUnhandled  = (reason) => safeFleetError('unhandledRejection:', reason);
  process.on('uncaughtException',  onUncaught);
  process.on('unhandledRejection', onUnhandled);

  const drainTimer = setInterval(maybeDrainFleetCooldown, 1_000);
  drainTimer.unref?.();

  return {
    stop() {
      process.off('uncaughtException',  onUncaught);
      process.off('unhandledRejection', onUnhandled);
      clearInterval(drainTimer);
    },
  };
}

// --- test hooks (not part of the public surface) ---------------------------
export const __testing = {
  reset() {
    perBot.clear();
    fleetRing = new RingCounter(FLEET_WINDOW_MS);
    fleetCooldownUntil = 0;
    fleetDroppedDuringCooldown = 0;
    fleetCooldownAnnouncedAt = 0;
  },
  state() {
    return {
      perBotKeys: [...perBot.keys()],
      fleetCount: fleetRing.size(Date.now()),
      fleetCooldownUntil,
      fleetDroppedDuringCooldown,
    };
  },
  PER_BOT_LIMIT, PER_BOT_WINDOW_MS, FLEET_LIMIT, FLEET_WINDOW_MS, FLEET_COOLDOWN_MS,
};
