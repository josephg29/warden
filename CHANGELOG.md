# Changelog

All notable changes to this project will be documented in this file. The
format is loosely based on [Keep a Changelog](https://keepachangelog.com/),
and the project adheres to [Semantic Versioning](https://semver.org/) once
the public API stabilises.

## [Unreleased]

Initial public release. The bug IDs below trace back to a 27-hour overnight
run on 2026-05-06 that catalogued 19 distinct failure modes; 14 fixes shipped
2026-05-06 and the remaining 5 on 2026-05-07.

### Added — operations layer

- **Atomic slot recycle** (`POST /api/admin/slots/:n/recycle`) — replaces the
  11-step manual restart. Snapshot → disconnect → kill listener PID (not
  spawn PID) → wipe world + slot subdirs → spawn java → wait for `Done (` →
  rename bot → reconnect. (BUG-021)
- **Pre-wipe snapshots** (`src/snapshot.js`) — inventory, position,
  last-10-chat, anchors, full memory state captured before any recycle so
  history isn't silently lost. (BUG-019)
- **Disk surveillance** (`src/diskwatch.js`) — polls `fs.statfs` every 30s,
  exposes free-MB on `/api/server`, stamps `disk_low: <mb> MB free` onto
  every BotInstance.error when free<100MB. One-shot startup sweep of slot
  log/crash/cache subdirs. (BUG-002)
- **Dashboard heartbeat + watchdog dashboard-down detection** —
  `data/dashboard-heartbeat` written every 5s; watchdog exits non-zero when
  ≥3 sweeps fail across all slots AND heartbeat mtime > 60s. Supervisor
  restarts both. (BUG-009)
- **Cloudflared URL auto-rotation** — `agora-site/live.html` reads endpoint
  from `tunnel.json`; new `scripts/cloudflared-watcher.mjs` tails the
  cloudflared log and triggers `vercel deploy --prod --yes`. (BUG-010)
- **Disconnect diagnostics** — 1Hz position ring buffer + chunk hash + raw
  payload appended to `data/diagnostics/disconnects.jsonl`. (BUG-013)
- **Spawn-Y safety net** — runtime `spawn` handler `/tp`s up to y=80 if bot
  respawns at y<30 (deepslate / void zone). (BUG-018)
- **Live dashboard inventory + anchors** — collapsible per-card details
  panel pulling from `/api/bots/:id/state`. (BUG-020)
- **Operational runbook** (`RUNBOOK.md`) — shell choice, listener-PID lookup,
  slot recycle, disk pressure, tunnel rotation, watchdog setup, fleet
  fate-sharing. (BUG-016)
- **Listener-PID helper scripts** (`data/overnight/get-slot-pid.sh`,
  `restart-slot.sh`) — codified lookup-then-kill pattern for ad-hoc manual
  use. (BUG-017)

### Added — brain hardening

- **Hard-block** at the decision layer — `(skill, args)` failing 3+ times in
  60s gets blocklisted for 5 min, surfaced at the top of every prompt as
  `## BLOCKED THIS TURN`. (BUG-001)
- **Completion-blindness detector** — 5+ consecutive same-sig successes with
  goal stale 5min triggers a `set_goal: PROGRESS` rewrite. (BUG-003)
- **Memory/inventory diff** — pre-craft check against live
  `bot.inventory.items()`; mismatch injects `MEMORY STALE …` and forces
  `look_around`. (BUG-006)
- **Oscillation detector** — strict A-B-A-B alternation with at least one
  failure adds both sigs to the block list. (BUG-012)
- **Chat throttle** (`_emitChat`) — 3000ms gap to comply with PaperMC anti-
  spam kicks. (BUG-004)
- **Worldborder clamp** — `goto_coord` reads worldborder packets and rejects
  out-of-bounds with a clamp suggestion. (BUG-005)
- **Typed LLM errors** — `_callLLM` classifies 402/401/429/5xx/network/
  timeout into `lastError.class`; one-shot offline broadcast routed through
  `_emitChat`. (BUG-007)
- **Pillar-up auto-recovery** — auto-digs headroom (capped 2 sub-steps) before
  bailing with a relocate hint. (BUG-011)
- **Synthesised lastError** — `brainInfo` mirrors the loose `_lastErrMsg`
  string into a typed `lastError` so the dashboard never sees status=error
  + empty message. (BUG-015)

### Added — fleet hardening

- **Safe-error reporter** (`src/safe-error.js`) — per-bot rate limit
  (5 errors / 1s window) + fleet circuit breaker (30 errors / 1s →
  5s cooldown). All emits deferred via `setImmediate` so a synchronous
  burst can't block the shared event loop. Wired into
  `process.on(uncaught/unhandled)`, `brain._reportError`, and
  reconnect/autostart catch-paths. Mitigates BUG-014; full per-bot subprocess
  isolation remains deferred.

### Fixed

- `entity.mobType` deprecation — switched to `entity.displayName`. The sync
  `console.trace` storms from this deprecation were the proximate cause of
  the 2026-05-04 fleet-wide event-loop block. (BUG-008)
