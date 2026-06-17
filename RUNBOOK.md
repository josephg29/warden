# Operational Runbook

Crystallized operational notes for running the 5-parallel agora fleet on this
host. Read alongside `README.md`. New entries earn their place by appearing as
"avoidable lessons" in a post-mortem at least once.

> **Starting an overnight run? Read [OVERNIGHT.md](./OVERNIGHT.md) first.**
> It is the single source of truth for the startup → observe → wake-up flow.
> This runbook is for ad-hoc operational interventions during a run.

## Shell choice on Windows: prefer Bash

> Origin: BUG-016 (2026-05-06). PowerShell crashed mid-restart with
> `System.Management.Automation … paging file is too small`, leaving the slot
> in a half-restarted state.

When running multi-step restart procedures from the terminal, **prefer Bash
(Git Bash / MSYS) over PowerShell** on this host.

Why: 5 java processes (~5 GB heap), node, plus PowerShell's own runtime sit on
top of an already-stretched pagefile. PowerShell allocates per-script and
crashes under memory pressure exactly when a restart is in flight. The Bash
equivalent of the same restart sequence has run reliably 14+ times without a
crash.

Where you still need PowerShell:
- `Get-NetTCPConnection -LocalPort <port> -State Listen` for listener PID
  lookup. The `netstat -ano | findstr LISTENING` equivalent works in Bash and
  is preferred (see BUG-017 below).

## Listener PID lookup: never trust the spawn PID

> Origin: BUG-017 (recurring). On Windows, `Start-Process java …` returns the
> launcher PID, not the actual `java.exe` PID owning the LISTEN socket. Days
> later, `taskkill /PID <launcher>` returns "process not found" while the real
> Java is still serving on `:25565`.

Always look up the listener PID from the OS before killing:

```bash
# Bash (Windows or POSIX)
./data/overnight/get-slot-pid.sh 1   # prints PID owning :25565
```

The `recycle-slot` admin endpoint (`POST /api/admin/slots/:n/recycle`) already
does this correctly via `src/admin.js#getListenerPid`. Use the API when the
dashboard is up; use the script for ad-hoc manual restarts.

## Slot restart: prefer the API

```bash
# One-shot atomic restart of slot 3 (renames bot to next TestN)
curl -X POST http://127.0.0.1:8080/api/admin/slots/3/recycle
```

This snapshots → disconnects → kills the listener PID (not the spawn PID) →
wipes world + slot subdirs → respawns java → renames bot → reconnects. Returns
`{ok, newTestNum, javaPid, durationMs, snapshotPath}`.

Only fall back to manual steps when the dashboard itself is down. In that
case, see `data/overnight/restart-slot.sh` for the Bash-native equivalent.

## Disk space: watch C: drive

> Origin: BUG-002 (P0, fired 2× on 2026-05-06).

The dashboard's `/api/server` endpoint surfaces `disk.freeMB`. The brain
stamps `disk_low: <mb> MB free` onto `BotInstance.error` when free < 100 MB.
The diskwatch sweep prunes rotated logs older than 3 days at startup.

If free MB drops below 500 MB during a run, **stop the fleet and clean up
before continuing** — symptoms include all 5 brains stalling silently within
~18s of each other while still appearing connected.

## Cloudflared tunnel: URL rotates

> Origin: BUG-010.

`agora-site/live.html` reads its `ENDPOINT` from `agora-site/tunnel.json` at
page load. When cloudflared restarts (laptop sleep, network blip, process
crash), the tunnel watcher (`scripts/cloudflared-watcher.mjs`) detects the new
URL, updates `tunnel.json`, and runs `vercel deploy --prod --yes` from
`agora-site/`. Expect ~30–60s of "TUNNEL DOWN" on the live page during the
rotation.

If the watcher isn't running:

```bash
# From repo root
node scripts/cloudflared-watcher.mjs \
  --log path/to/cloudflared.log
```

## Watchdog: dashboard heartbeat

> Origin: BUG-009.

The dashboard touches `data/dashboard-heartbeat` every 5s. The watchdog
(`data/overnight/watchdog.mjs`) considers the dashboard dead when:

- The heartbeat file's mtime is > 60s old, OR
- ≥3 consecutive sweeps return `poll_error` for ALL 5 slots.

When dashboard-down is detected, the watchdog logs `dashboard_down` and exits
non-zero. The launcher is expected to restart both the dashboard and the
watchdog. The watchdog deliberately does **not** re-spawn the dashboard
itself, to avoid two watchdogs racing on a flapping process.

## Supervisor: keep dashboard + watchdog alive

> Origin: BUG-OVN-001 (2026-05-07). The dashboard event loop wedged silently
> after ~22 min and stayed broken for 78 min because nothing was watching the
> watchdog itself.

Run both processes under `scripts/supervisor.mjs`. It restarts either child
on exit (exponential backoff 1s → 60s, reset after 5min uptime) and SIGKILLs
+ restarts the dashboard if its heartbeat file is stale (mtime > 60s) for
two consecutive 15s checks. Caps flapping at 5 restarts/5min — exits non-zero
beyond that so an operator can investigate.

```bash
npm run supervisor                        # foreground; Ctrl-C to stop
npm run supervisor -- --once              # smoke test: spawn both, wait 5s, stop
npm run supervisor -- --no-watchdog       # dashboard only
npm run supervisor -- --quiet             # suppress per-event stdout
```

Logs: `data/overnight/supervisor.jsonl` (events), `data/overnight/{dashboard,watchdog}.{out,err}` (child stdio).
PIDs: `data/overnight/{dashboard,watchdog}.pid` written on spawn, removed on clean exit.

Stale `.pid` files from prior crashes are cleared automatically on supervisor
start. Run `npm run clean:pids` to clear them ad-hoc.

### Supervisor smoke tests (no overnight required)

1. **Restart-on-exit** — `npm run supervisor`, then in another shell
   `taskkill /F /PID $(cat data/overnight/dashboard.pid)`. Confirm
   `supervisor.jsonl` logs `exit` then `restart_scheduled` then `spawn`.
2. **Heartbeat-stale kill** — start the supervisor, then stop the heartbeat
   (e.g. set `DASHBOARD_DISABLE_HEARTBEAT=1` if implemented, or block file
   writes). Within ~75s the supervisor must log `heartbeat_stale` (twice)
   then `force_restart` then `spawn`.
3. **Clean shutdown** — Ctrl-C the supervisor. Confirm both children exit
   and both `.pid` files are removed.

## Cross-bot fate-sharing (BUG-014, partial mitigation)

The 5 bots share one Node event loop. Yesterday's overnight catastrophe was a
synchronous-stderr storm that blocked the loop for all 5 simultaneously. The
mitigation shipped today:

- All error reporting routes through `safeError(botId, …)` in
  `src/safe-error.js`, which rate-limits to 5 writes/sec/bot and writes
  asynchronously.
- The `process.on('uncaughtException' | 'unhandledRejection')` handlers use
  `safeError` and tag with `[fleet]`.

This addresses the failure shape (sync stderr storm starves event loop)
without the full subprocess refactor. The proper architectural fix — running
each bot in its own Node child process with IPC — remains deferred and is
tracked under BUG-014 in the backlog. Estimate: weeks-not-hours; needs a
significant rewrite of `BotManager` and the WebSocket aggregation layer.

## Common operations

- **Check fleet health**: `curl http://127.0.0.1:8080/api/server | jq`
- **Tail today's dev-server log**: `tail -f data/logs/dev-server.$(date +%F).log`
- **Manually snapshot a bot before risky surgery**:
  `curl -X POST http://127.0.0.1:8080/api/bots/<id>/snapshot`
- **List slot listener PIDs**:
  `for n in 1 2 3 4 5; do echo -n "slot$n: "; ./data/overnight/get-slot-pid.sh $n; done`
