#!/usr/bin/env node
// Overnight fleet morning report. ESM, Node >= 18, no deps.
// Usage: node scripts/morning-report.mjs [--html]

import { readFile, readdir, writeFile, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = dirname(dirname(__filename));
const DATA = join(ROOT, 'data');
const OVN = join(DATA, 'overnight');

const PALETTE = {
  bg: '#0e1116',
  text: '#e6edf3',
  accent: '#ffb454',
  accent2: '#79c0ff',
  bad: '#ff7b72',
  good: '#7ee787',
  line: '#2a323d',
};

// ---------- I/O helpers (never throw) ----------

async function safeRead(path) {
  try { return await readFile(path, 'utf8'); } catch { return null; }
}

async function readJsonl(path) {
  const txt = await safeRead(path);
  if (!txt) return [];
  const out = [];
  for (const line of txt.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch { /* skip malformed */ }
  }
  return out;
}

async function readJson(path) {
  const txt = await safeRead(path);
  if (!txt) return null;
  try { return JSON.parse(txt); } catch { return null; }
}

async function listFiles(dir) {
  try { return await readdir(dir); } catch { return []; }
}

// ---------- collectors ----------

export async function loadBotMemories() {
  // Spec mentions data/bots/*/memory.jsonl; this repo uses data/memory/<botId>.json.
  // Try both, prefer either that exists.
  const result = {};
  const botsDir = join(DATA, 'bots');
  for (const entry of await listFiles(botsDir)) {
    const memPath = join(botsDir, entry, 'memory.jsonl');
    const records = await readJsonl(memPath);
    if (records.length) result[entry] = records;
  }
  const memDir = join(DATA, 'memory');
  for (const file of await listFiles(memDir)) {
    if (!file.endsWith('.json')) continue;
    const botId = file.replace(/\.json$/, '');
    if (result[botId]) continue;
    const obj = await readJson(join(memDir, file));
    if (obj) result[botId] = [obj];
  }
  return result;
}

async function loadEventsLogs() {
  // Brain events live under data/logs/<sessionId>/events.jsonl — this is the
  // only source for structured craft/death/decision records.
  const logsDir = join(DATA, 'logs');
  const sessions = await listFiles(logsDir);
  const events = [];
  for (const s of sessions) {
    const p = join(logsDir, s, 'events.jsonl');
    const rows = await readJsonl(p);
    for (const r of rows) events.push(r);
  }
  return events;
}

function readSlotLogTail(slot) {
  // Slot logs are large server logs; we only scan for death lines so a tail
  // would still match. Read whole file but bail on missing.
  const p = join(OVN, `mc-slot${slot}.log`);
  return safeRead(p);
}

// ---------- aggregations ----------

export function aggregateCrafts(events) {
  // crafts by item with per-bot breakdown + total counts
  const byItem = new Map(); // item -> { total, byBot: Map }
  const firstCraftPerBot = new Map();
  for (const ev of events) {
    if (!ev || ev.type !== 'brain:skill_done') continue;
    const d = ev.data;
    if (!d || d.skill !== 'craft') continue;
    if (!d.outcome || d.outcome.ok !== true) continue;
    const item = d.args && d.args.item ? String(d.args.item) : 'unknown';
    let qty = 1;
    if (d.outcome.crafted) {
      const m = String(d.outcome.crafted).match(/^(\d+)x\s/);
      if (m) qty = parseInt(m[1], 10);
    } else if (d.args && typeof d.args.count === 'number') {
      qty = d.args.count;
    }
    if (!byItem.has(item)) byItem.set(item, { total: 0, byBot: new Map() });
    const slot = byItem.get(item);
    slot.total += qty;
    const bot = ev.botId || 'unknown';
    slot.byBot.set(bot, (slot.byBot.get(bot) || 0) + qty);
    if (!firstCraftPerBot.has(bot)) {
      firstCraftPerBot.set(bot, { ts: ev.ts, item });
    }
  }
  return { byItem, firstCraftPerBot };
}

export function aggregateDeaths(events) {
  const list = [];
  const locCounts = new Map();
  for (const ev of events) {
    if (!ev || ev.type !== 'brain:death') continue;
    const loc = ev.location;
    const key = loc ? `${loc.x},${loc.y},${loc.z}` : 'unknown';
    locCounts.set(key, (locCounts.get(key) || 0) + 1);
    list.push({ ts: ev.ts, botId: ev.botId, name: ev.name, location: loc });
  }
  const topLocations = [...locCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  return { count: list.length, byBot: groupCount(list, (d) => d.botId || 'unknown'), topLocations, list };
}

export function aggregateRestartReasons(overnightEvents) {
  const counts = new Map();
  for (const ev of overnightEvents) {
    if (!ev || ev.event !== 'restart_begin') continue;
    const r = ev.reason || 'unknown';
    counts.set(r, (counts.get(r) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

export function aggregateBrainStatus(overnightEvents, state) {
  // Categorise restart triggers into running/llm_backoff/stalled/disconnected.
  const tally = { running: 0, llm_backoff: 0, stalled: 0, disconnected: 0 };
  for (const ev of overnightEvents) {
    if (!ev || ev.event !== 'restart_begin') continue;
    const evi = ev.evidence || {};
    const errMsg = evi.lastBrainError && evi.lastBrainError.message
      ? String(evi.lastBrainError.message).toLowerCase()
      : '';
    if (errMsg.includes('rate-limited') || errMsg.includes('429') || errMsg.includes('backoff')) {
      tally.llm_backoff++;
    } else if (ev.reason === 'brain_stalled' || evi.brainStatus === 'stalled') {
      tally.stalled++;
    } else if (ev.reason === 'mass_disconnect' || ev.reason === 'disconnected_too_long') {
      tally.disconnected++;
    } else {
      tally.running++;
    }
  }
  // Current snapshot from state.json
  const snapshot = { connected: 0, disconnected: 0 };
  if (state && Array.isArray(state.slots)) {
    for (const s of state.slots) {
      if (s.disconnectedSince) snapshot.disconnected++;
      else snapshot.connected++;
    }
  }
  return { triggerTally: tally, snapshot };
}

export function topSignatures(state, events, n = 10) {
  // Use state.json recentDecisions + brain:decision events.
  const counts = new Map();
  if (state && Array.isArray(state.slots)) {
    for (const s of state.slots) {
      const recent = Array.isArray(s.recentDecisions) ? s.recentDecisions : [];
      for (const d of recent) {
        if (!d || !d.sig) continue;
        counts.set(d.sig, (counts.get(d.sig) || 0) + 1);
      }
    }
  }
  for (const ev of events) {
    if (!ev || ev.type !== 'brain:decision') continue;
    const action = ev.data && ev.data.action;
    if (!action || !action.type) continue;
    let argsStr = '{}';
    try { argsStr = JSON.stringify(action.args || {}); } catch { /* keep default */ }
    const sig = `${action.type}:${argsStr}`;
    counts.set(sig, (counts.get(sig) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

export function aggregateSupervisor(supEvents) {
  let force_restart = 0;
  let exit_1 = 0;
  for (const ev of supEvents) {
    if (!ev) continue;
    if (ev.event === 'force_restart') force_restart++;
    if (ev.event === 'exit' && ev.exitCode === 1) exit_1++;
  }
  return { force_restart, exit_1 };
}

export function timeToFirstCraftPerBot(events, state) {
  // First craft event's ts minus the earliest event we have for that bot.
  const firstSeen = new Map();
  const firstCraft = new Map();
  for (const ev of events) {
    if (!ev || !ev.botId || !ev.ts) continue;
    const t = Date.parse(ev.ts);
    if (Number.isNaN(t)) continue;
    if (!firstSeen.has(ev.botId) || t < firstSeen.get(ev.botId)) {
      firstSeen.set(ev.botId, t);
    }
    if (ev.type === 'brain:skill_done'
      && ev.data && ev.data.skill === 'craft'
      && ev.data.outcome && ev.data.outcome.ok === true) {
      if (!firstCraft.has(ev.botId)) firstCraft.set(ev.botId, t);
    }
  }
  const out = [];
  const allBots = new Set([...firstSeen.keys()]);
  if (state && Array.isArray(state.slots)) {
    for (const s of state.slots) if (s.botId) allBots.add(s.botId);
  }
  for (const bot of allBots) {
    const seen = firstSeen.get(bot);
    const craft = firstCraft.get(bot);
    out.push({
      botId: bot,
      firstCraftMs: craft && seen ? craft - seen : null,
    });
  }
  return out.sort((a, b) => {
    if (a.firstCraftMs === null) return 1;
    if (b.firstCraftMs === null) return -1;
    return a.firstCraftMs - b.firstCraftMs;
  });
}

function groupCount(items, keyFn) {
  const m = new Map();
  for (const it of items) {
    const k = keyFn(it);
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

function fmtDuration(ms) {
  if (ms === null || ms === undefined) return 'never';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h${rm}m`;
}

// ---------- text report ----------

function renderText(report) {
  const lines = [];
  const pad = (s) => `  ${s}`;
  lines.push('═══ MORNING REPORT ═══');
  lines.push('');
  lines.push(`wooden_pickaxe crafted: ${report.woodenPickaxes}`);
  lines.push(`sticks crafted:         ${report.sticks}`);
  lines.push('');
  lines.push('── Crafts by item ──');
  for (const [item, info] of report.crafts.byItem) {
    lines.push(`${item}: ${info.total}`);
    for (const [bot, n] of [...info.byBot.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(pad(`${bot}: ${n}`));
    }
  }
  if (report.crafts.byItem.size === 0) lines.push('  (none)');
  lines.push('');
  lines.push('── Restart reasons ──');
  for (const [reason, n] of report.restartReasons) {
    lines.push(`${reason}: ${n}`);
  }
  if (report.restartReasons.length === 0) lines.push('  (none)');
  lines.push('');
  lines.push('── Top 10 repeated skill signatures ──');
  for (const [sig, n] of report.topSigs) {
    lines.push(`${n}x  ${sig}`);
  }
  lines.push('');
  lines.push('── Brain status (restart triggers) ──');
  const t = report.brainStatus.triggerTally;
  lines.push(`running: ${t.running}  llm_backoff: ${t.llm_backoff}  stalled: ${t.stalled}  disconnected: ${t.disconnected}`);
  const snap = report.brainStatus.snapshot;
  lines.push(`current slots — connected: ${snap.connected}  disconnected: ${snap.disconnected}`);
  lines.push('');
  lines.push(`── Deaths (${report.deaths.count}) ──`);
  for (const [loc, n] of report.deaths.topLocations) {
    lines.push(`${n}x  @${loc}`);
  }
  lines.push('');
  lines.push('── Time to first craft ──');
  for (const r of report.firstCraftPerBot) {
    lines.push(`${r.botId}: ${fmtDuration(r.firstCraftMs)}`);
  }
  lines.push('');
  lines.push('── Supervisor ──');
  lines.push(`force_restart: ${report.supervisor.force_restart}`);
  lines.push(`exit code 1:   ${report.supervisor.exit_1}`);
  return lines.join('\n');
}

// ---------- html report ----------

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderHtml(report, dateStr) {
  const p = PALETTE;
  const section = (title, body) => `
    <section>
      <h2>${escapeHtml(title)}</h2>
      ${body}
    </section>`;
  const rows = (pairs) => pairs.length
    ? `<table>${pairs.map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td class="num">${escapeHtml(String(v))}</td></tr>`).join('')}</table>`
    : '<p class="muted">(none)</p>';

  const craftsBody = [...report.crafts.byItem].length
    ? [...report.crafts.byItem].map(([item, info]) => {
        const botRows = [...info.byBot.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([b, n]) => `<tr><td>${escapeHtml(b)}</td><td class="num">${n}</td></tr>`).join('');
        return `<details><summary><span class="item">${escapeHtml(item)}</span> <span class="num accent">${info.total}</span></summary><table>${botRows}</table></details>`;
      }).join('')
    : '<p class="muted">(none)</p>';

  const t = report.brainStatus.triggerTally;
  const snap = report.brainStatus.snapshot;
  const brainBody = `
    <div class="pillrow">
      <span class="pill good">running ${t.running}</span>
      <span class="pill accent2">llm_backoff ${t.llm_backoff}</span>
      <span class="pill accent">stalled ${t.stalled}</span>
      <span class="pill bad">disconnected ${t.disconnected}</span>
    </div>
    <p class="muted">current — connected: ${snap.connected}, disconnected: ${snap.disconnected}</p>`;

  const sigsBody = report.topSigs.length
    ? `<table>${report.topSigs.map(([sig, n]) => `<tr><td class="num">${n}×</td><td><code>${escapeHtml(sig)}</code></td></tr>`).join('')}</table>`
    : '<p class="muted">(none)</p>';

  const deathsBody = `
    <p>Total deaths: <span class="num accent">${report.deaths.count}</span></p>
    ${report.deaths.topLocations.length
      ? `<table>${report.deaths.topLocations.map(([loc, n]) => `<tr><td class="num">${n}×</td><td><code>@${escapeHtml(loc)}</code></td></tr>`).join('')}</table>`
      : '<p class="muted">(none)</p>'}`;

  const firstCraftBody = `<table>${report.firstCraftPerBot.map(r =>
    `<tr><td>${escapeHtml(r.botId)}</td><td class="num ${r.firstCraftMs === null ? 'bad' : 'good'}">${escapeHtml(fmtDuration(r.firstCraftMs))}</td></tr>`
  ).join('')}</table>`;

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Morning Report ${escapeHtml(dateStr)}</title>
<style>
  :root {
    --bg: ${p.bg}; --text: ${p.text}; --accent: ${p.accent}; --accent2: ${p.accent2};
    --bad: ${p.bad}; --good: ${p.good}; --line: ${p.line};
  }
  html, body { background: var(--bg); color: var(--text); margin: 0; }
  body { font-family: 'JetBrains Mono', 'Consolas', 'Menlo', ui-monospace, monospace;
         padding: 24px; max-width: 980px; margin: 0 auto; line-height: 1.5; }
  h1 { color: var(--accent); border-bottom: 1px solid var(--line); padding-bottom: 8px; }
  h2 { color: var(--accent2); margin-top: 32px; border-bottom: 1px solid var(--line); padding-bottom: 4px; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 4px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .accent { color: var(--accent); }
  .accent2 { color: var(--accent2); }
  .good { color: var(--good); }
  .bad { color: var(--bad); }
  .muted { color: #6e7681; }
  details { margin: 8px 0; padding: 4px 8px; border: 1px solid var(--line); border-radius: 4px; }
  summary { cursor: pointer; }
  summary .item { color: var(--accent2); }
  code { background: rgba(255,255,255,0.04); padding: 1px 4px; border-radius: 3px; }
  .pillrow { display: flex; gap: 8px; flex-wrap: wrap; }
  .pill { padding: 4px 10px; border-radius: 12px; border: 1px solid var(--line); font-size: 0.9em; }
  .pill.good { color: var(--good); border-color: var(--good); }
  .pill.bad { color: var(--bad); border-color: var(--bad); }
  .pill.accent { color: var(--accent); border-color: var(--accent); }
  .pill.accent2 { color: var(--accent2); border-color: var(--accent2); }
</style></head><body>
<h1>Morning Report — ${escapeHtml(dateStr)}</h1>
<p>wooden_pickaxe: <span class="num accent">${report.woodenPickaxes}</span>
   &nbsp;|&nbsp; sticks: <span class="num accent">${report.sticks}</span></p>
${section('Crafts by item', craftsBody)}
${section('Restart reasons', rows(report.restartReasons))}
${section('Top 10 repeated skill signatures', sigsBody)}
${section('Brain status', brainBody)}
${section('Deaths', deathsBody)}
${section('Time to first craft (per bot)', firstCraftBody)}
${section('Supervisor', rows([['force_restart', report.supervisor.force_restart], ['exit code 1', report.supervisor.exit_1]]))}
</body></html>`;
}

// ---------- main ----------

export async function buildReport() {
  const [overnight, supervisor, state, _manual, events, _memories] = await Promise.all([
    readJsonl(join(OVN, 'overnight.jsonl')),
    readJsonl(join(OVN, 'supervisor.jsonl')),
    readJson(join(OVN, 'state.json')),
    readJsonl(join(OVN, 'manual-restarts.jsonl')),
    loadEventsLogs(),
    loadBotMemories(),
  ]);
  // Force a tail read on slot logs so the file is at least exercised; we use
  // them only as a presence signal — crafts/deaths come from events.jsonl.
  for (let i = 1; i <= 8; i++) await readSlotLogTail(i);

  const crafts = aggregateCrafts(events);
  const woodenPickaxes = crafts.byItem.get('wooden_pickaxe')?.total || 0;
  const sticks = (crafts.byItem.get('stick')?.total || 0)
                + (crafts.byItem.get('sticks')?.total || 0);
  const restartReasons = aggregateRestartReasons(overnight);
  const topSigs = topSignatures(state, events, 10);
  const brainStatus = aggregateBrainStatus(overnight, state);
  const deaths = aggregateDeaths(events);
  const firstCraftPerBot = timeToFirstCraftPerBot(events, state);
  const supervisorStats = aggregateSupervisor(supervisor);

  return {
    woodenPickaxes, sticks,
    crafts, restartReasons, topSigs, brainStatus, deaths,
    firstCraftPerBot,
    supervisor: supervisorStats,
  };
}

async function main() {
  const wantHtml = process.argv.includes('--html');
  const report = await buildReport();
  process.stdout.write(renderText(report) + '\n');
  if (wantHtml) {
    const date = new Date().toISOString().slice(0, 10);
    const outDir = join(OVN, 'reports');
    try { await mkdir(outDir, { recursive: true }); } catch {}
    const outFile = join(outDir, `morning-${date}.html`);
    await writeFile(outFile, renderHtml(report, date), 'utf8');
    process.stdout.write(`\nHTML report → ${outFile}\n`);
  }
}

// Run only when invoked directly (not when imported by tests).
const invoked = process.argv[1] ? process.argv[1].replace(/\\/g, '/') : '';
if (invoked && import.meta.url.endsWith(invoked.split('/').slice(-2).join('/'))) {
  main().catch((err) => {
    process.stderr.write(`morning-report failed: ${err && err.message ? err.message : err}\n`);
    process.exit(0);
  });
}
