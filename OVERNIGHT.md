# Overnight workflow

The single canonical procedure for starting, watching, and waking-up to a
5-parallel agora overnight run. If you find yourself doing more than this,
either the runbook is wrong or you're fighting an undetected failure mode —
in which case, it belongs in `data/overnight/watchdog.mjs#classifyHealth`,
not in your head.

> Origin: Test33 post-mortem (2026-05-08). Test33 sat in a
> `place_block(crafting_table)` loop for **11 hours** while two of the
> three watchdog detectors (`stuck_loop`, `phantom_craft_loop`) were
> silently broken — they were reading the pre-2a58406 brain shape and
> getting `undefined` on every check. Fix landed under OVN-017. This doc is
> the workflow that surrounds those detectors, so a single broken detector
> can't take down the whole observability layer again.

---

## Three layers, in plain terms

| Layer | What it watches | What kills it | What to do when it fires |
| --- | --- | --- | --- |
| **Supervisor** (`npm run overnight`) | Process liveness — dashboard + watchdog as Node processes | Repeated crashes inside 5 min | Read `data/overnight/supervisor.jsonl`; usually a code bug |
| **Watchdog** (auto-spawned by supervisor) | Bot behavior — disconnect, brain stalled, death loop, stuck loop, phantom craft, progress starvation | Dashboard down (TCP accept but HTTP hangs) | Watchdog `process.exit(2)` and the supervisor restarts it |
| **Observer** (Claude Code `/loop`) | The watchdog itself — does it still SEE the fleet? Are detectors firing on plausible signals? Is anyone restarting hourly? | You. The observer escalates to a human. | Read its summary, run `npm run observe`, decide |

Each layer assumes the layer below is broken. If the watchdog dies, the
supervisor restarts it. If the watchdog gets blinded by another shape
mismatch, the observer notices "no detector has fired in 8 hours but slot 5
has restarted 0 times and is still on Test33" and flags it.

---

## Startup — one command

```bash
cd mc-mission-control
npm run overnight
```

That's it. `overnight` is an alias for `supervisor` and spawns:

- `node src/index.js` — dashboard on :8080
- `node data/overnight/watchdog.mjs` — health sweeps every 60s
- `data/overnight/supervisor.jsonl` — restart history
- `data/overnight/{dashboard,watchdog}.{out,err}` — child stdio

Supervisor handles restart-on-exit (1s → 60s exponential backoff, reset
after 5 min uptime), heartbeat-stale SIGKILL of the dashboard if its
event loop wedges, and refuses to flap >5 restarts/5min.

### Pre-flight (do once per laptop boot)

```bash
# 1. Cerebras key — silently dies on 402, no error visible from the dashboard
curl -s -o /dev/null -w '%{http_code}\n' \
     -H "Authorization: Bearer $CEREBRAS_API_KEY" \
     https://api.cerebras.ai/v1/models
# Expect 200. Anything else: fleet will run, brains will silently freeze.

# 2. Cloudflared tunnel watcher (only if you want the live page accessible)
node scripts/cloudflared-watcher.mjs --log path/to/cloudflared.log &

# 3. Disk free — overnight needs ≥500 MB on C:
df -h /c | tail -1
```

If any of these fail, **don't start the run**. Fix it first. The fleet has
no recovery path for "no API key" or "disk full" — it just stalls all 5
brains within ~18s of each other.

---

## During the run — Claude Code observer

Once the supervisor is up, open a Claude Code session and run:

```
/loop 30m npm run observe
```

That schedules `npm run observe` (the human-readable fleet status) every
30 minutes inside the Claude Code session. The session synthesizes the
output into a one-paragraph status and flags anomalies.

### Why /loop and not a bare cron job

A cron job logs lines. A Claude Code session **interprets** them. The two
problems Test33 exposed are exactly the kind a literal log scraper misses:

- **Detector silently broken.** Watchdog kept logging clean sweeps but
  every detector returned "healthy" because the brain shape changed. A
  cron job that greps `unhealthy:true` would find nothing — same as today.
  Claude Code reads "slot 5 has been on Test33 with 0 restarts for 11
  hours" and asks "is that plausible for a fresh bot?" — which catches the
  miss.
- **Plausibility checks.** "0 restarts in 8 hours" can mean perfect health
  OR a totally blind watchdog. Distinguishing them needs context (is the
  bot making decisions? did it move? does the inventory look like 8 hours
  of progress?), which is what an LLM observer does well and a regex does
  not.

### The observer's contract

`npm run observe` exits with:

- `0` — all 5 slots healthy (per `classifyHealth`)
- `1` — one or more slots flagged
- `2` — dashboard unreachable

Output is one screen per slot: brain status, last-decision age, current
skill+args sig, recent decisions tracked, progress window (X ok / Y total),
and — if unhealthy — the reason, evidence, and a suggested next action.

For a machine-readable feed, use `npm run observe:json`.

### When the observer flags something

1. Read the suggestion line in the observer output.
2. Cross-check with the bot's memory: `cat data/memory/<botId>.json | head -100`
3. If the suggestion is "recycle slot": `curl -X POST http://127.0.0.1:8080/api/admin/slots/<n>/recycle`
4. If the suggestion is "check Cerebras key": run the curl ping above.
5. If the suggestion is unclear or wrong: **add a new detector**. Don't
   accumulate undocumented operator knowledge — that's how Test33
   happened.

---

## What went wrong with Test33 (and what each layer would now do)

Slot 5, botId `slot5bot`, 11h27m at `(-15, 84, -3)`, infinite
`place_block(crafting_table)` after a `craft(oak_planks)` succeeded
server-side but dropped the output because inventory was full.

| Layer | Then (broken) | Now (fixed) |
| --- | --- | --- |
| Supervisor | ✓ kept dashboard + watchdog alive | unchanged |
| Watchdog · `stuck_loop` | ✗ `decisionSig` read `d.skill` (undefined since 2a58406); `slot.recentDecisions` stayed `[]` forever | ✓ reads `d.action.skill` (and `d.skill` for legacy); detector fires after 10 identical decisions |
| Watchdog · `phantom_craft_loop` | ✗ read `lsr.ok` / `lsr.error` (also undefined since rewrite); detector blind to the exact failure | ✓ reads `lsr.outcome.ok` / `lsr.outcome.error`; would have caught the dropped-craft pattern within ~3 cycles |
| Watchdog · `progress_starvation` | ✗ didn't exist | ✓ new fallback detector — 30 decisions with 0 ok-outcomes flags as starvation regardless of sig encoding |
| Observer | ✗ didn't exist | ✓ Claude Code `/loop 30m npm run observe` would have surfaced "Test33 has been on slot 5 with 0 restarts for 11 hours, current sig=`place_block:{block:crafting_table}`, progress=0/30 ok" within the first hour |

The lesson: **never depend on a single detector** to catch a class of bug.
Detectors break silently when the shape they read changes. A second-line
behavior detector (`progress_starvation`) and a third-line plausibility
observer (Claude Code) make the system robust to detector drift.

---

## Adding a new detector — the procedure

When a new failure mode appears overnight:

1. Reproduce it from the bot's memory file (`data/memory/<botId>.json`)
   plus `data/overnight/overnight.jsonl`. Capture the exact shape of
   `lastDecision` and `lastSkillResult` you'll be matching on.
2. Add the detector to `data/overnight/watchdog.mjs#classifyHealth` with
   a descriptive `reason` string and a tunable threshold constant.
3. Add a test in `test/watchdog-detectors.test.mjs` that builds the bot
   state from the recorded shape and asserts the verdict. **No detector
   ships without a test.** Test33 happened because two detectors had no
   tests at all.
4. Map the new `reason` in `scripts/observe-fleet.mjs#suggestion()`.
5. Update the table above (`What went wrong with Test33`) — add a row
   describing what your detector would have caught.

---

## Deploying the OVN-017 fix to a running fleet

If the supervisor is already running with pre-OVN-017 code (i.e. you started
your run before the watchdog detector fix shipped), the patched detectors
won't take effect until the watchdog process restarts. Steps:

```bash
# 1. Confirm the fix is in your tree
npm test -- --test-name-pattern="OVN-017|stuck_loop|progress_starvation"
# Must show pass — otherwise pull the fix first.

# 2. Stop the running supervisor cleanly (Ctrl-C in its terminal). The
#    supervisor SIGINTs both children, waits up to 8s, and removes its
#    pid files. Wait for "supervisor_stopped" in supervisor.jsonl.

# 3. Sanity-check pid cleanup
ls data/overnight/*.pid 2>/dev/null   # should be empty

# 4. Restart with the new code
npm run overnight

# 5. Within 60s, the watchdog will sweep all 5 slots with the fixed
#    detector. If any slot is in a stuck_loop right now, it'll be
#    recycled inside the next ~50s. Tail overnight.jsonl to watch:
tail -f data/overnight/overnight.jsonl
```

You'll see `restart_begin / reason: "stuck_loop"` for any slot that was
silently looping — exactly what should have happened to Test33 hours ago.

## Smoke test before sleeping

Run this 5-line check before walking away:

```bash
cd mc-mission-control
npm test                                          # 11 detector tests must pass
npm run observe                                   # exit code 0; all 5 slots ok
curl -s http://127.0.0.1:8080/api/server | jq -r '.disk.freeMB' # ≥ 500
ls data/overnight/*.pid | wc -l                  # exactly 2 (dashboard + watchdog)
tail -1 data/overnight/supervisor.jsonl | jq -r '.event' # supervisor_start, not flap_detected
```

If all five lines are green, the fleet is in the best shape it can be in.
The observer takes it from there.

---

## Files & key paths

| Path | Purpose |
| --- | --- |
| `scripts/supervisor.mjs` | Process supervisor — `npm run overnight` |
| `data/overnight/watchdog.mjs` | Behavior watchdog with 7 detectors |
| `scripts/observe-fleet.mjs` | Human/JSON fleet status — `npm run observe[:json]` |
| `data/overnight/supervisor.jsonl` | Supervisor restart history |
| `data/overnight/overnight.jsonl` | Watchdog event log |
| `data/overnight/state.json` | Current slot state (testNum, javaPid, restartCount, recentDecisions, progressWindow) |
| `data/memory/<botId>.json` | Bot brain memory; primary forensic artifact |
| `test/watchdog-detectors.test.mjs` | Detector regression tests — must pass before every overnight |
| `RUNBOOK.md` | Operational runbook (manual interventions) |

---

## What this doc replaces

This doc replaces the implicit "I'll start the supervisor, set my alarm,
hope it's fine" pattern that produced the Test33 outage. Going forward:

1. `npm run overnight` — one command
2. `/loop 30m npm run observe` in Claude Code — automated supervision
3. `npm test` before every run — detector regression check
4. Add a detector + test for every new failure mode

Anything beyond those four steps is a sign the workflow itself needs
fixing — file it as an OVN bug.
