#!/usr/bin/env node
// OVN-018: human-readable fleet status snapshot.
//
// Pairs with the `agora-observe` Claude Code skill (~/.claude/skills/) and
// the `npm run overnight` startup command. Replaces the implicit
// "I'll check it in the morning" pattern that let Test33 sit in a
// place_block(crafting_table) loop for 11 hours unnoticed.
//
// Two output modes:
//
//   --json    machine-readable; the Claude Code observer loop consumes this
//             on a schedule and flags anomalies.
//   (none)    human-readable; one screen per slot with verdict, evidence,
//             and the suggested next action.
//
// Exit code:
//   0   all 5 slots healthy
//   1   one or more slots flagged (operator should investigate)
//   2   dashboard unreachable (supervisor / process-level issue)
//
// The intent is that this is the ONE command an operator runs to know
// whether to keep sleeping. Anything more involved than this should be
// added as a new detector in watchdog.mjs#classifyHealth, not here.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { __testing as wdTesting } from '../data/overnight/watchdog.mjs';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT  = path.resolve(path.dirname(__filename), '..');
const STATE_FILE = path.join(REPO_ROOT, 'data', 'overnight', 'state.json');
const DASHBOARD  = process.env.DASHBOARD ?? 'http://127.0.0.1:8080';

const { classifyHealth, decisionSig } = wdTesting;

function parseArgs(argv) {
  const out = { json: false };
  for (const a of argv) {
    if (a === '--json') out.json = true;
    else if (a === '-h' || a === '--help') {
      process.stdout.write('observe-fleet [--json]\n');
      process.exit(0);
    }
  }
  return out;
}

async function readState() {
  const raw = await fs.readFile(STATE_FILE, 'utf8');
  return JSON.parse(raw.replace(/^﻿/, ''));
}

async function api(url) {
  const res = await fetch(`${DASHBOARD}${url}`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status} ${url}`);
  return res.status === 404 ? null : res.json();
}

function suggestion(reason) {
  switch (reason) {
    case 'java_process_dead':       return 'restart slot via POST /api/admin/slots/<n>/recycle';
    case 'disconnected_too_long':   return 'check Mineflayer reconnect logs in data/overnight/mc-slot<n>.log.err';
    case 'brain_stalled':           return 'check Cerebras key (curl ping) — brain stalls silently on 402/429';
    case 'death_loop':              return 'wipe world; bot is in a fatal terrain pocket';
    case 'stuck_loop':              return 'recycle slot; bot is repeating the same skill+args with no progress';
    case 'phantom_craft_loop':      return 'recycle slot; craft outputs dropping due to full inventory — needs auto-pickup fix';
    case 'progress_starvation':     return 'recycle slot; 30+ decisions with zero successes (this is the Test33 mode)';
    default:                        return 'recycle slot and inspect data/memory/<botId>.json';
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  let state;
  try {
    state = await readState();
  } catch (e) {
    if (opts.json) process.stdout.write(JSON.stringify({ ok: false, error: 'state_unreadable', message: String(e) }) + '\n');
    else console.error(`fleet state unreadable: ${e.message}`);
    process.exit(2);
  }

  const now = Date.now();
  const slots = [];
  let anyUnhealthy = false;

  for (const slot of state.slots) {
    let stateRes, decisionRes;
    try {
      stateRes    = await api(`/api/bots/${slot.botId}/state`);
      decisionRes = await api(`/api/bots/${slot.botId}/decision`);
    } catch (e) {
      slots.push({ slot: slot.slot, botId: slot.botId, testNum: slot.testNum, unhealthy: true, reason: 'dashboard_unreachable', evidence: { error: String(e) }, suggestion: 'check supervisor + dashboard pid; supervisor.jsonl has the spawn/exit history' });
      anyUnhealthy = true;
      continue;
    }

    const verdict = classifyHealth({ state: stateRes ?? {}, decision: decisionRes, slot, now });

    // Surface the current sig + recent count even when healthy — useful at a glance.
    const lastSig = decisionRes?.lastDecision ? decisionSig(decisionRes.lastDecision) : null;

    slots.push({
      slot:          slot.slot,
      botId:         slot.botId,
      testNum:       slot.testNum,
      port:          slot.port,
      restartCount:  slot.restartCount ?? 0,
      brainStatus:   stateRes?.brainStatus ?? null,
      lastDecisionAgeS: stateRes?.lastDecisionAgeS ?? null,
      currentSig:    lastSig,
      recentDecisionsCount: (slot.recentDecisions ?? []).length,
      progressOks:   (slot.progressWindow ?? []).filter((p) => p.ok).length,
      progressTotal: (slot.progressWindow ?? []).length,
      unhealthy:     verdict.unhealthy,
      reason:        verdict.reason ?? null,
      evidence:      verdict.evidence ?? null,
      suggestion:    verdict.unhealthy ? suggestion(verdict.reason) : null,
    });
    if (verdict.unhealthy) anyUnhealthy = true;
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify({ ok: !anyUnhealthy, ts: new Date().toISOString(), slots }, null, 2) + '\n');
  } else {
    const banner = anyUnhealthy ? '⚠ FLEET DEGRADED' : '✓ fleet healthy';
    process.stdout.write(`${banner}    ${new Date().toISOString()}\n\n`);
    for (const s of slots) {
      const head = `slot ${s.slot}  Test${s.testNum}  ${s.botId}  :${s.port}   restarts=${s.restartCount}`;
      process.stdout.write(`${head}\n`);
      process.stdout.write(`  brain=${s.brainStatus ?? 'unknown'}   last decision ${s.lastDecisionAgeS ?? '?'}s ago   sig=${s.currentSig ?? 'none'}\n`);
      process.stdout.write(`  decisions tracked=${s.recentDecisionsCount}   progress=${s.progressOks}/${s.progressTotal} ok\n`);
      if (s.unhealthy) {
        process.stdout.write(`  ⚠ ${s.reason}\n`);
        process.stdout.write(`     evidence: ${JSON.stringify(s.evidence)}\n`);
        process.stdout.write(`     suggestion: ${s.suggestion}\n`);
      }
      process.stdout.write('\n');
    }
  }

  process.exit(anyUnhealthy ? 1 : 0);
}

main().catch((e) => {
  console.error('observe-fleet crash:', e);
  process.exit(2);
});
