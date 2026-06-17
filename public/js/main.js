// Mission Control v2 — bat cave orchestrator
// Wires REST + WebSocket data into the new fleet UI.

import { api } from './api.js';
import { connectWs } from './ws.js';
import {
  patchBotCard, buildStreamRow,
  renderFleetGrid, renderDrawerBody,
} from './render.js';
import { MiniMapPool } from './map.js';
import { pulseCard, pulseBrand, toast } from './fx.js';
import { StatsStore, rankBots, renderLeaderboard, persistRanks } from './leaderboard.js';
import {
  PORT_TO_SLOT, clock, shortDuration, ellipsis,
  formatSkillPlain, classifyBotState, sortBots, esc,
} from './util.js';

// ============================================================================
// state
// ============================================================================

const MAX_STREAM     = 200;
const MAX_DECISIONS  = 40;
const MAX_CHAT       = 40;
const HUD_UPDATE_MS  = 1000;
const CARD_UPDATE_MS = 1000;

const STREAM_LS_KEY = 'warden:stream:v1';
const STREAM_LS_MAX = 200;

const state = {
  bots:         new Map(),   // botId -> bot summary
  fullState:    new Map(),   // botId -> /api/bots/:id/state cache
  lastTick:     new Map(),   // botId -> latest world:tick entry (live coords/vitals)
  decisions:    new Map(),   // botId -> Decision[] newest first
  skillResults: new Map(),   // botId -> SkillResult[]
  chatByBot:    new Map(),   // botId -> chat lines
  memory:       new Map(),   // botId -> { contextBlock, state }
  worldTick:    null,
  server:       null,
  settings:     { hasCerebrasKey: false, cerebrasStatus: 'unknown' },
  filters:      new Set(['decide', 'skill_done', 'chat', 'error']),
  focusedBot:   null,        // bot id keyboard-focused
  drawerBot:    null,        // bot id whose detail is shown
  streamLines:  0,
  streamBuf:    [],          // recent events, newest first, capped to STREAM_LS_MAX
  wsStatus:     'connecting',
  bootedAt:     Date.now(),
};

const mapPool = new MiniMapPool();
const stats   = new StatsStore();
const elRefs = {};
const cardRefreshTimers = new Map();
let _leaderboardScheduled = false;

// ============================================================================
// boot
// ============================================================================

bindRefs();
bindNav();
boot();

function bindRefs() {
  Object.assign(elRefs, {
    grid:       document.getElementById('fleet-grid'),
    leaderboard:document.getElementById('leaderboard'),
    lbReset:    document.getElementById('lb-reset'),
    streamLog:  document.getElementById('stream-log'),
    streamCount:document.getElementById('stream-count'),
    streamClear:document.getElementById('stream-clear'),
    fleetHint:  document.getElementById('fleet-hint'),
    pillFleet:  document.getElementById('pill-fleet'),
    pillFleetV: document.getElementById('pill-fleet-value'),
    pillCereb:  document.getElementById('pill-cerebras'),
    pillCerebV: document.getElementById('pill-cerebras-value'),
    pillDisk:   document.getElementById('pill-disk'),
    pillDiskV:  document.getElementById('pill-disk-value'),
    pillWs:     document.getElementById('pill-ws'),
    pillWsV:    document.getElementById('pill-ws-value'),
    hudClock:   document.getElementById('hud-clock'),
    hudUptime:  document.getElementById('hud-uptime'),
    hudHelp:    document.getElementById('hud-help'),
    drawer:     document.getElementById('drawer'),
    drawerTitle:document.getElementById('drawer-title'),
    drawerSub:  document.getElementById('drawer-sub'),
    drawerDot:  document.getElementById('drawer-dot'),
    drawerBody: document.getElementById('drawer-body'),
    overlay:    document.getElementById('overlay-help'),
  });
}

function bindNav() {
  // stream filter chips
  document.querySelectorAll('.chip--toggle').forEach((chip) => {
    chip.addEventListener('click', () => {
      const f = chip.dataset.filter;
      if (state.filters.has(f)) { state.filters.delete(f); chip.classList.remove('is-on'); }
      else                       { state.filters.add(f);   chip.classList.add('is-on'); }
      applyStreamFilter();
    });
  });

  elRefs.streamClear.addEventListener('click', () => {
    elRefs.streamLog.replaceChildren();
    state.streamLines = 0;
    state.streamBuf = [];
    elRefs.streamCount.textContent = '0';
    try { localStorage.removeItem(STREAM_LS_KEY); } catch { /* noop */ }
  });

  elRefs.lbReset.addEventListener('click', () => {
    if (!confirm('Reset all bot stats? This clears decisions, success rates, and rank history.')) return;
    stats.reset();
    scheduleLeaderboardRefresh();
    toast('stats reset', 'ok');
  });

  // leaderboard tile click → open same drawer the card opens
  elRefs.leaderboard.addEventListener('click', (ev) => {
    const tile = ev.target.closest('.rank');
    if (!tile) return;
    openDrawer(tile.dataset.botId);
  });

  // grid clicks
  elRefs.grid.addEventListener('click', (ev) => {
    const card = ev.target.closest('.card');
    if (!card) return;
    openDrawer(card.dataset.botId);
  });

  // drawer close
  elRefs.drawer.addEventListener('click', (ev) => {
    if (ev.target.matches('[data-drawer-close]')) closeDrawer();
  });

  // drawer admin actions
  elRefs.drawerBody.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const botId  = btn.dataset.botId;
    const slotN  = btn.dataset.slotN;
    btn.disabled = true;
    try {
      if (action === 'snapshot')   { await fetch(`/api/bots/${botId}/snapshot`, { method: 'POST', headers: { 'content-type':'application/json' }, body: JSON.stringify({ reason:'manual' }) }); toast('snapshot saved', 'ok'); }
      else if (action === 'disconnect') { await api.disconnect(botId); toast('disconnect requested', 'info'); }
      else if (action === 'connect')    { await api.connect(botId);    toast('connect requested', 'info'); }
      else if (action === 'recycle')    {
        if (!confirm(`Recycle slot ${slotN}? This will snapshot → kill → wipe → respawn.`)) { btn.disabled = false; return; }
        toast(`recycling slot ${slotN}…`, 'info', 6000);
        const res = await fetch(`/api/admin/slots/${slotN}/recycle`, { method: 'POST', headers: { 'content-type':'application/json' }, body: JSON.stringify({ reason:'manual' }) });
        if (res.ok) { const j = await res.json(); toast(`slot ${slotN} recycled → Test${j.newTestNum ?? '?'}`, 'ok', 6000); }
        else        { toast(`recycle failed (${res.status})`, 'bad'); }
      }
      else if (action === 'copy-id')    { await navigator.clipboard.writeText(botId); toast('id copied', 'ok'); }
    } catch (err) {
      toast(err.message || 'action failed', 'bad');
    } finally {
      btn.disabled = false;
    }
  });

  // overlay close
  elRefs.overlay.addEventListener('click', (ev) => {
    if (ev.target.matches('[data-overlay-close]')) toggleHelp(false);
  });
  elRefs.hudHelp.addEventListener('click', () => toggleHelp(true));

  // keyboard
  document.addEventListener('keydown', onKey);
}

async function boot() {
  // restore the decision stream from localStorage so it survives refreshes
  restoreStream();

  // initial fetch — primes UI before WebSocket snapshot arrives
  try {
    const [{ bots }, srv, settings] = await Promise.all([
      api.list(),
      api.server.status().catch(() => null),
      api.settings.get().catch(() => null),
    ]);
    if (Array.isArray(bots)) {
      for (const b of bots) state.bots.set(b.id, b);
    }
    if (srv?.server) state.server = srv;
    if (settings?.settings) state.settings = { ...state.settings, ...settings.settings };
    renderFleet();
    refreshFullStates();
  } catch (err) {
    console.error('[boot]', err); // safe — boot diagnostics only
  }

  connectWs({
    onMessage: handleWs,
    onStatus:  handleWsStatus,
  });

  setInterval(tickHud, HUD_UPDATE_MS);
  setInterval(tickCards, CARD_UPDATE_MS);
  setInterval(pollCerebras, 60_000);
  pollCerebras();
}

// ============================================================================
// websocket handlers
// ============================================================================

function handleWs(msg) {
  switch (msg.type) {
    case 'snapshot': {
      state.bots = new Map((msg.bots || []).map((b) => [b.id, b]));
      state.server = { ...state.server, ...(msg.server || {}) };
      if (msg.settings) state.settings = { ...state.settings, ...msg.settings };
      renderFleet();
      refreshFullStates();
      break;
    }
    case 'bot:upsert': {
      state.bots.set(msg.bot.id, msg.bot);
      ensureCardFor(msg.bot);
      patchCard(msg.bot.id, { reason: 'upsert' });
      if (msg.bot.state !== 'connected') mapPool.markOffline(msg.bot.id);
      scheduleLeaderboardRefresh();
      updateHud();
      break;
    }
    case 'bot:delete': {
      state.bots.delete(msg.id);
      state.decisions.delete(msg.id);
      state.skillResults.delete(msg.id);
      state.chatByBot.delete(msg.id);
      state.memory.delete(msg.id);
      stats.forget(msg.id);
      mapPool.detach(msg.id);
      renderFleet();
      scheduleLeaderboardRefresh();
      break;
    }
    case 'bot:decision': {
      const list = state.decisions.get(msg.botId) ?? [];
      list.unshift(msg.decision);
      if (list.length > MAX_DECISIONS) list.length = MAX_DECISIONS;
      state.decisions.set(msg.botId, list);
      const bot = state.bots.get(msg.botId);
      if (bot) stats.recordDecision(bot);
      patchCard(msg.botId, { reason: 'decision' });
      addStreamRow({
        type:    'decide',
        ts:      msg.decision.ts || Date.now(),
        botId:   msg.botId,
        botName: bot?.name || msg.botId,
        body:    formatDecisionBody(msg.decision),
      });
      pulseCard(msg.botId);
      pulseBrand();
      scheduleLeaderboardRefresh();
      if (state.drawerBot === msg.botId) refreshDrawer();
      break;
    }
    case 'bot:skill-done': {
      const list = state.skillResults.get(msg.botId) ?? [];
      list.unshift(msg.result);
      if (list.length > MAX_DECISIONS) list.length = MAX_DECISIONS;
      state.skillResults.set(msg.botId, list);
      const bot = state.bots.get(msg.botId);
      if (bot) stats.recordSkillDone(bot, msg.result);
      patchCard(msg.botId, { reason: 'skill_done' });
      const r = msg.result || {};
      const ok = r.ok !== false;
      const sub = r.reason || r.error || r.summary || (ok ? 'done' : 'failed');
      addStreamRow({
        type:    ok ? 'skill_done' : 'error',
        ts:      r.ts || Date.now(),
        botId:   msg.botId,
        botName: bot?.name || msg.botId,
        body:    `<em>${esc(r.name || r.skill || 'skill')}</em> ${esc(ellipsis(sub, 64))}`,
      });
      scheduleFullStateRefresh(msg.botId);
      scheduleLeaderboardRefresh();
      if (state.drawerBot === msg.botId) refreshDrawer();
      break;
    }
    case 'bot:memory-update': {
      state.memory.set(msg.botId, { contextBlock: msg.contextBlock, state: msg.state });
      patchCard(msg.botId, { reason: 'memory' });
      scheduleFullStateRefresh(msg.botId);
      if (state.drawerBot === msg.botId) refreshDrawer();
      break;
    }
    case 'bot:chat': {
      const list = state.chatByBot.get(msg.botId) ?? [];
      list.push({ username: msg.username, message: msg.message, ts: msg.ts });
      if (list.length > MAX_CHAT) list.shift();
      state.chatByBot.set(msg.botId, list);
      addStreamRow({
        type:    'chat',
        ts:      msg.ts || Date.now(),
        botId:   msg.botId,
        botName: state.bots.get(msg.botId)?.name || msg.botId,
        body:    `<em>${esc(msg.username || '?')}</em>: ${esc(ellipsis(msg.message || '', 96))}`,
      });
      if (state.drawerBot === msg.botId) refreshDrawer();
      break;
    }
    case 'world:tick': {
      state.worldTick = msg;
      mapPool.pushTick(msg);
      for (const b of (msg.bots || [])) {
        state.lastTick.set(b.id, { ...b, ts: msg.ts });
        patchCard(b.id, { reason: 'tick' });
      }
      break;
    }
    case 'server:status': {
      state.server = { ...state.server, server: msg.server };
      updateHud();
      break;
    }
    case 'settings:update': {
      state.settings = { ...state.settings, ...msg.settings };
      updateCerebrasPill();
      break;
    }
  }
}

function handleWsStatus(status) {
  state.wsStatus = status;
  const pill = elRefs.pillWs;
  const val  = elRefs.pillWsV;
  if (status === 'connected')      { pill.dataset.state = 'connected'; val.textContent = 'live'; }
  else if (status === 'connecting'){ pill.dataset.state = 'warn';      val.textContent = 'connecting'; }
  else                              { pill.dataset.state = 'bad';       val.textContent = 'dark'; }
}

// ============================================================================
// fleet rendering
// ============================================================================

function renderFleet() {
  renderFleetGrid(elRefs.grid, [...state.bots.values()]);
  // attach maps for every bot card
  for (const card of elRefs.grid.querySelectorAll('.card')) {
    const id = card.dataset.botId;
    const canvas = card.querySelector('canvas');
    if (canvas) mapPool.attach(id, canvas);
    patchCard(id, { reason: 'render' });
  }
  scheduleLeaderboardRefresh();
  updateHud();
}

function scheduleLeaderboardRefresh() {
  if (_leaderboardScheduled) return;
  _leaderboardScheduled = true;
  requestAnimationFrame(() => {
    _leaderboardScheduled = false;
    refreshLeaderboard();
  });
}

function refreshLeaderboard() {
  // Show only currently-connected bots on the leaderboard. Offline bots are
  // hidden from the ranking, NOT removed: their records and persisted stats
  // (StatsStore, keyed by bot.id) are untouched and reappear when they reconnect.
  const online = [...state.bots.values()].filter((b) => b.state === 'connected');
  const ranked = rankBots(online, state.fullState, stats);
  renderLeaderboard(elRefs.leaderboard, ranked);
  // write the rank badge onto each card so #1 shows up there too
  const rankByBot = new Map(ranked.map((r) => [r.bot.id, r.rank]));
  for (const card of elRefs.grid.querySelectorAll('.card')) {
    const id = card.dataset.botId;
    const r = rankByBot.get(id);
    let badge = card.querySelector('.card__rank-badge');
    if (!r) { if (badge) badge.remove(); continue; }
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'card__rank-badge';
      card.appendChild(badge);
    }
    badge.dataset.rank = String(r);
    badge.textContent = `#${r}`;
  }
  persistRanks(ranked, stats);
}

function ensureCardFor(bot) {
  let card = elRefs.grid.querySelector(`.card[data-bot-id="${cssQuote(bot.id)}"]`);
  if (!card) {
    renderFleet();
    return;
  }
}

function patchCard(botId, { reason } = {}) {
  const bot = state.bots.get(botId);
  if (!bot) return;
  const card = elRefs.grid.querySelector(`.card[data-bot-id="${cssQuote(botId)}"]`);
  if (!card) return;
  const decisions    = state.decisions.get(botId)    ?? [];
  const lastSkill    = state.skillResults.get(botId)?.[0] ?? null;
  const cached       = state.fullState.get(botId)    ?? null;
  const tick         = state.lastTick.get(botId)     ?? null;

  // overlay live tick data onto the cached fullState — coords + vitals move
  // every second, but inventory/memory only refresh on skill-done.
  const fullState = cached || tick ? {
    ...(cached || {}),
    position: tick
      ? { x: tick.x, y: tick.y, z: tick.z, yaw: tick.yaw ?? 0 }
      : cached?.position ?? null,
    health: tick?.health ?? cached?.health ?? null,
    food:   tick?.food   ?? cached?.food   ?? null,
  } : null;

  const currentSkill = cached?.currentSkill ?? null;
  patchBotCard(card, bot, { decisions, lastSkill, currentSkill, fullState });
}

// ============================================================================
// full state caching
// ============================================================================

async function refreshFullStates() {
  const ids = [...state.bots.keys()];
  await Promise.all(ids.map(async (id) => {
    try {
      const s = await api.botState(id);
      state.fullState.set(id, s);
      patchCard(id, { reason: 'refresh' });
    } catch { /* silent — endpoint may 500 transiently */ }
  }));
  scheduleLeaderboardRefresh();
}

function scheduleFullStateRefresh(botId, delay = 400) {
  const prev = cardRefreshTimers.get(botId);
  if (prev) clearTimeout(prev);
  const t = setTimeout(async () => {
    try {
      const s = await api.botState(botId);
      state.fullState.set(botId, s);
      patchCard(botId, { reason: 'refresh-debounced' });
      scheduleLeaderboardRefresh();
      if (state.drawerBot === botId) refreshDrawer();
    } catch { /* noop */ }
    cardRefreshTimers.delete(botId);
  }, delay);
  cardRefreshTimers.set(botId, t);
}

// ============================================================================
// HUD ticks
// ============================================================================

function tickHud() {
  elRefs.hudClock.textContent = clock();
  const fleetMs = fleetUptimeMs();
  elRefs.hudUptime.textContent = fleetMs != null
    ? `fleet ${shortDuration(fleetMs)}`
    : 'fleet offline';
  updateHud();
}

function fleetUptimeMs() {
  let earliest = null;
  for (const b of state.bots.values()) {
    if (b.state !== 'connected' || !b.joinedAt) continue;
    const t = new Date(b.joinedAt).getTime();
    if (Number.isFinite(t) && (earliest == null || t < earliest)) earliest = t;
  }
  return earliest != null ? Date.now() - earliest : null;
}

function updateHud() {
  // fleet count
  const connected = [...state.bots.values()].filter((b) => b.state === 'connected').length;
  const total = state.bots.size;
  elRefs.pillFleetV.textContent = `${connected}/${total}`;
  elRefs.pillFleet.dataset.state = connected === total && total > 0 ? 'ok' : connected > 0 ? 'warn' : 'bad';

  // disk
  const diskMB = state.server?.diskFreeMB ?? state.server?.disk?.freeMB ?? null;
  if (diskMB != null) {
    elRefs.pillDiskV.textContent = formatDisk(diskMB);
    elRefs.pillDisk.dataset.state = diskMB < 500 ? 'bad' : diskMB < 2000 ? 'warn' : 'ok';
  } else {
    elRefs.pillDiskV.textContent = '— GB';
    elRefs.pillDisk.dataset.state = 'idle';
  }

  // fleet hint
  if (elRefs.fleetHint) {
    const focus = state.focusedBot ? `focused: ${state.bots.get(state.focusedBot)?.name ?? '—'}` : null;
    elRefs.fleetHint.textContent = focus
      ? `${total} bots · ${focus} · press Enter for detail · J/K to cycle`
      : `${total} bots · click for detail · press 1–${Math.min(total, 8)} to focus`;
  }
}

async function pollCerebras() {
  try {
    const { settings } = await api.settings.get();
    state.settings = { ...state.settings, ...settings };
    updateCerebrasPill();
  } catch { /* offline */ }

  // also use the most recent bot error: any "callLLM" or "402" error means it's down
  const anyLLMErr = [...state.bots.values()].some((b) => {
    const m = b.lastBrainError?.message || '';
    return /callLLM|LLM call|aborted/.test(m);
  });
  if (anyLLMErr) {
    elRefs.pillCereb.dataset.state = 'bad';
    elRefs.pillCerebV.textContent = 'aborted';
  }
}

function updateCerebrasPill() {
  if (state.settings?.cerebrasStatus === 'ok') {
    elRefs.pillCereb.dataset.state = 'ok';
    elRefs.pillCerebV.textContent = 'live';
  } else if (state.settings?.hasCerebrasKey) {
    elRefs.pillCereb.dataset.state = 'warn';
    elRefs.pillCerebV.textContent = 'key set';
  } else {
    elRefs.pillCereb.dataset.state = 'bad';
    elRefs.pillCerebV.textContent = 'no key';
  }
}

function formatDisk(mb) {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

// ============================================================================
// stream
// ============================================================================

function addStreamRow(ev) {
  const row = buildStreamRow(ev);
  if (!state.filters.has(ev.type)) row.hidden = true;
  elRefs.streamLog.prepend(row);
  state.streamLines += 1;
  elRefs.streamCount.textContent = state.streamLines.toString();
  while (elRefs.streamLog.children.length > MAX_STREAM) elRefs.streamLog.lastElementChild.remove();

  // persist (newest first, capped). Cheap O(1) push + occasional trim.
  state.streamBuf.unshift(ev);
  if (state.streamBuf.length > STREAM_LS_MAX) state.streamBuf.length = STREAM_LS_MAX;
  persistStreamSoon();
}

let _persistTimer = null;
function persistStreamSoon() {
  if (_persistTimer) return;
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    try {
      localStorage.setItem(STREAM_LS_KEY, JSON.stringify(state.streamBuf));
    } catch { /* localStorage may be full or disabled */ }
  }, 500);
}

function restoreStream() {
  try {
    const raw = localStorage.getItem(STREAM_LS_KEY);
    if (!raw) return;
    const events = JSON.parse(raw);
    if (!Array.isArray(events)) return;
    // events are newest-first; render in that order so DOM matches
    for (const ev of events) {
      const row = buildStreamRow(ev);
      row.dataset.persisted = '1';
      if (!state.filters.has(ev.type)) row.hidden = true;
      elRefs.streamLog.appendChild(row);
    }
    state.streamBuf = events;
    state.streamLines = events.length;
    elRefs.streamCount.textContent = events.length.toString();
  } catch { /* corrupt cache — ignore */ }
}

function applyStreamFilter() {
  for (const row of elRefs.streamLog.querySelectorAll('.stream__row')) {
    row.hidden = !state.filters.has(row.dataset.type);
  }
}

function formatDecisionBody(decision) {
  const action = decision.action || decision.decision || null;
  if (action) return `<em>${esc(action.type || 'decide')}</em> ${esc(formatSkillPlain(action))}`;
  if (decision.summary) return esc(decision.summary);
  return '—';
}

// ============================================================================
// drawer
// ============================================================================

function openDrawer(botId) {
  state.drawerBot = botId;
  elRefs.drawer.setAttribute('aria-hidden', 'false');
  refreshDrawer();
}

function closeDrawer() {
  state.drawerBot = null;
  elRefs.drawer.setAttribute('aria-hidden', 'true');
}

async function refreshDrawer() {
  const id = state.drawerBot;
  if (!id) return;
  const bot = state.bots.get(id);
  if (!bot) { closeDrawer(); return; }

  elRefs.drawerTitle.textContent = bot.name || id;
  const slot = PORT_TO_SLOT[bot.port];
  elRefs.drawerSub.textContent = slot ? `slot ${slot} · ${bot.host}:${bot.port}` : `${bot.host}:${bot.port}`;
  const st = classifyBotState(bot);
  elRefs.drawerDot.style.background = ({
    alive: 'var(--alive)', idle: 'var(--idle)', error: 'var(--warn)', disconnected: 'var(--bad)',
  })[st];
  elRefs.drawerDot.style.boxShadow = ({
    alive: '0 0 8px var(--alive-edge)', idle: 'none', error: '0 0 8px rgba(241,177,76,0.4)', disconnected: 'none',
  })[st];

  // refresh full state if we don't have it
  let fullState = state.fullState.get(id);
  if (!fullState) {
    try { fullState = await api.botState(id); state.fullState.set(id, fullState); }
    catch { /* noop */ }
  }
  let memory = state.memory.get(id);
  if (!memory && fullState?.memory) memory = fullState.memory;

  renderDrawerBody(elRefs.drawerBody, {
    bot,
    fullState,
    decisions: state.decisions.get(id) ?? [],
    chat:      state.chatByBot.get(id) ?? [],
    memory,
  });
}

// ============================================================================
// help overlay
// ============================================================================

function toggleHelp(show) {
  const open = show ?? elRefs.overlay.getAttribute('aria-hidden') === 'true';
  elRefs.overlay.setAttribute('aria-hidden', open ? 'false' : 'true');
}

// ============================================================================
// keyboard
// ============================================================================

function onKey(ev) {
  const tag = (ev.target?.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea') return;

  // numeric 1..8 — focus that bot
  if (ev.key >= '1' && ev.key <= '8') {
    const idx = Number(ev.key) - 1;
    const sorted = sortBots([...state.bots.values()]);
    const bot = sorted[idx];
    if (bot) { state.focusedBot = bot.id; updateFocusVisual(); }
    return;
  }

  if (ev.key === 'j' || ev.key === 'J' || ev.key === 'k' || ev.key === 'K') {
    cycleFocus(ev.key === 'j' || ev.key === 'J' ? 1 : -1);
    return;
  }
  if (ev.key === 'Enter' && state.focusedBot) { openDrawer(state.focusedBot); return; }
  if (ev.key === 'Escape') {
    if (elRefs.overlay.getAttribute('aria-hidden') === 'false') toggleHelp(false);
    else if (state.drawerBot) closeDrawer();
    return;
  }
  if (ev.key === '?' || (ev.shiftKey && ev.key === '/')) { toggleHelp(); return; }
  if (ev.key === 'c' || ev.key === 'C') { elRefs.streamClear.click(); return; }
}

function cycleFocus(dir) {
  const sorted = sortBots([...state.bots.values()]);
  if (!sorted.length) return;
  let idx = sorted.findIndex((b) => b.id === state.focusedBot);
  idx = (idx + dir + sorted.length) % sorted.length;
  if (idx < 0) idx = sorted.length - 1;
  state.focusedBot = sorted[idx].id;
  updateFocusVisual();
}

function updateFocusVisual() {
  for (const c of elRefs.grid.querySelectorAll('.card')) {
    c.classList.toggle('is-focused', c.dataset.botId === state.focusedBot);
  }
  const f = state.focusedBot ? elRefs.grid.querySelector(`.card[data-bot-id="${cssQuote(state.focusedBot)}"]`) : null;
  if (f) f.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  updateHud();
}

// ============================================================================
// per-card duration ticker (current skill / last decision)
// ============================================================================

function tickCards() {
  for (const id of state.bots.keys()) patchCard(id, { reason: 'tick' });
}

// ============================================================================
// utils
// ============================================================================

function cssQuote(s) {
  return String(s).replace(/(["\\])/g, '\\$1');
}
