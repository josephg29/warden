// DOM renderers — pure functions that produce HTML strings or patch existing nodes.
// Reused across the fleet grid, the decision stream, and the detail drawer.

import {
  PORT_TO_SLOT,
  clock, shortDuration, relTime,
  intCoord, coordTriplet,
  formatSkill, formatSkillPlain,
  ellipsis, inferTier, healthLevel,
  classifyBotState, slotLabel, sortBots, esc,
} from './util.js';

// ============================================================================
// Bot card
// ============================================================================

/**
 * Initial render — produces a card element with all subnodes.
 * Subnodes are cached on the card via a Map for cheap subsequent patching.
 */
export function buildBotCard(bot, kbdIndex) {
  const card = document.createElement('article');
  card.className = 'card';
  card.dataset.botId = bot.id;
  card.dataset.state = classifyBotState(bot);

  const slot   = slotLabel(bot);
  const slotN  = PORT_TO_SLOT[bot.port];
  const kbd    = slotN ?? kbdIndex;

  card.innerHTML = `
    <header class="card__head">
      <span class="card__dot" aria-hidden="true"></span>
      <div class="card__head-text">
        <span class="card__slot">${esc(slot)}</span>
        <span class="card__name">${esc(bot.name || '—')}</span>
      </div>
      <span class="card__tier" data-tier="" hidden>
        <svg class="card__tier__icon" viewBox="0 0 16 16" aria-hidden="true">
          <path fill="currentColor" d="M3 11l5-7 5 7-3 1-2-2-2 2z"/>
        </svg>
        <span class="card__tier__label">—</span>
      </span>
    </header>
    <div class="card__sub">
      <span class="card__sub__port">port ${esc(bot.port)}</span>
      <span class="card__sub__dot">·</span>
      <span class="card__sub__uptime">—</span>
    </div>
    <div class="card__map">
      <canvas></canvas>
      <span class="card__map__cardinal">N</span>
      <span class="card__map__ydepth">Y <strong>—</strong></span>
      <span class="card__map__coords mono">—</span>
    </div>
    <div class="card__vitals">
      <div class="vitals-bar vitals-bar--hp">
        <div class="vitals-bar__head">
          <span class="vitals-bar__label">HP</span>
          <span class="vitals-bar__value">—</span>
        </div>
        <div class="vitals-bar__track">
          <div class="vitals-bar__fill" style="width:0%"></div>
        </div>
      </div>
      <div class="vitals-bar vitals-bar--food">
        <div class="vitals-bar__head">
          <span class="vitals-bar__label">Food</span>
          <span class="vitals-bar__value">—</span>
        </div>
        <div class="vitals-bar__track">
          <div class="vitals-bar__fill" style="width:0%"></div>
        </div>
      </div>
    </div>
    <div class="card__skill">
      <span class="card__skill__icon" aria-hidden="true">${SKILL_ICON_DEFAULT}</span>
      <span class="card__skill__name mono">—</span>
      <span class="card__skill__time mono">—</span>
    </div>
    <div class="card__goal">
      <span class="card__goal__label">goal</span>
      <span class="card__goal__text">—</span>
    </div>
    <div class="card__decision">
      <div class="card__decision__head">
        <span>Last decision</span>
        <span class="card__decision__time">—</span>
      </div>
      <div class="card__decision__body">—</div>
    </div>
    ${kbd ? `<span class="card__kbd">${esc(String(kbd))}</span>` : ''}
  `;

  return card;
}

/**
 * Patch an existing card to reflect the latest bot snapshot.
 * Does not rebuild — only updates text/attribute fields that changed.
 */
export function patchBotCard(card, bot, { decisions = [], lastSkill = null, currentSkill = null, fullState = null }) {
  if (!card || !bot) return;
  const state = classifyBotState(bot);
  card.dataset.state = state;

  // -- sub: uptime ---------------------------------------------------------
  const subUptime = card.querySelector('.card__sub__uptime');
  if (subUptime) {
    if (bot.joinedAt) {
      const ms = Date.now() - new Date(bot.joinedAt).getTime();
      subUptime.textContent = `joined ${shortDuration(ms)} ago`;
    } else {
      subUptime.textContent = '—';
    }
  }

  // -- coords ---------------------------------------------------------------
  const pos = fullState?.position ?? null;
  const coordsEl = card.querySelector('.card__map__coords');
  const ydepthEl = card.querySelector('.card__map__ydepth strong');
  if (coordsEl) coordsEl.textContent = pos ? coordTriplet(pos) : '—';
  if (ydepthEl) ydepthEl.textContent = pos ? intCoord(pos.y) : '—';

  // -- vitals ---------------------------------------------------------------
  const hp = fullState?.health ?? null;
  const food = fullState?.food ?? null;
  const hpFill = card.querySelector('.vitals-bar--hp .vitals-bar__fill');
  const hpVal  = card.querySelector('.vitals-bar--hp .vitals-bar__value');
  const fdFill = card.querySelector('.vitals-bar--food .vitals-bar__fill');
  const fdVal  = card.querySelector('.vitals-bar--food .vitals-bar__value');
  if (hpFill && hpVal) {
    const pct = hp != null ? Math.max(0, Math.min(100, (hp / 20) * 100)) : 0;
    hpFill.style.width = `${pct}%`;
    hpFill.dataset.level = healthLevel(hp);
    hpVal.textContent = hp != null ? `${Math.round(hp)}/20` : '—';
  }
  if (fdFill && fdVal) {
    const pct = food != null ? Math.max(0, Math.min(100, (food / 20) * 100)) : 0;
    fdFill.style.width = `${pct}%`;
    fdFill.dataset.level = healthLevel(food);
    fdVal.textContent = food != null ? `${Math.round(food)}/20` : '—';
  }

  // -- tier badge -----------------------------------------------------------
  const tier = inferTier(fullState?.inventory ?? []);
  const tierEl = card.querySelector('.card__tier');
  if (tierEl) {
    if (tier) {
      tierEl.hidden = false;
      tierEl.dataset.tier = tier;
      tierEl.querySelector('.card__tier__label').textContent = tier;
    } else {
      tierEl.hidden = true;
      tierEl.dataset.tier = '';
    }
  }

  // -- current skill --------------------------------------------------------
  const skill = currentSkill || lastSkill?.skill || null;
  const skillName = card.querySelector('.card__skill__name');
  const skillTime = card.querySelector('.card__skill__time');
  if (skillName) {
    if (skill) {
      skillName.innerHTML = formatSkill(skill);
      card.classList.add('is-thinking');
    } else {
      skillName.textContent = '—';
      card.classList.remove('is-thinking');
    }
  }
  if (skillTime) {
    const startedAt = currentSkill?.startedAt ?? null;
    if (startedAt) {
      skillTime.textContent = shortDuration(Date.now() - startedAt);
    } else if (lastSkill?.ts) {
      skillTime.textContent = relTime(lastSkill.ts);
    } else {
      skillTime.textContent = '—';
    }
  }

  // -- goal -----------------------------------------------------------------
  const goal = fullState?.memory?.state?.current_goal ?? null;
  const goalText = card.querySelector('.card__goal__text');
  if (goalText) goalText.textContent = goal ? ellipsis(String(goal), 180) : '—';

  // -- last decision --------------------------------------------------------
  const dec = decisions[0] ?? null;
  const decTimeEl = card.querySelector('.card__decision__time');
  const decBodyEl = card.querySelector('.card__decision__body');
  if (decTimeEl) decTimeEl.textContent = dec?.ts ? clock(dec.ts) : '—';
  if (decBodyEl) {
    if (dec) {
      const action = dec.action || dec.decision || null;
      if (action) decBodyEl.innerHTML = `<em>${esc(action.type || action.name || 'decide')}</em> ${esc(formatSkillPlain(action))}`;
      else if (dec.summary) decBodyEl.textContent = dec.summary;
      else decBodyEl.textContent = '—';
    } else if (bot.lastBrainError?.message) {
      decBodyEl.innerHTML = `<em style="color:var(--bad)">error</em> ${esc(ellipsis(bot.lastBrainError.message, 80))}`;
    } else {
      decBodyEl.textContent = '—';
    }
  }
}

// ============================================================================
// Stream — decision rows
// ============================================================================

/**
 * Build a single stream row.
 * @param {{type:'decide'|'skill_done'|'chat'|'error', ts:number, botName:string, body:string, detail?:string}} ev
 */
export function buildStreamRow(ev) {
  const row = document.createElement('div');
  row.className = 'stream__row';
  row.dataset.type = ev.type;
  row.dataset.botId = ev.botId || '';
  row.innerHTML = `
    <span class="t">${esc(clock(ev.ts))}</span>
    <span class="bot">${esc(ev.botName)}</span>
    <span class="ev">${esc(ev.type.replace('_', ' '))}</span>
    <span class="body">${ev.body}</span>
  `;
  return row;
}

// ============================================================================
// Fleet grid render
// ============================================================================

export function renderFleetGrid(container, bots) {
  const sorted = sortBots(bots);

  if (sorted.length === 0) {
    container.innerHTML = `<div class="fleet__empty">
      <div class="fleet__empty-glyph">
        <svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true">
          <circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>
        </svg>
      </div>
      <div class="fleet__empty-title">No bots configured</div>
      <div class="fleet__empty-sub">spawn a bot via the API to populate the fleet</div>
    </div>`;
    return;
  }

  // ensure every bot has a card; remove cards for bots that vanished
  const existing = new Map();
  for (const c of container.querySelectorAll('.card')) existing.set(c.dataset.botId, c);
  const placeholder = container.querySelector('.fleet__empty');
  if (placeholder) placeholder.remove();

  // build / preserve in sorted order
  const used = new Set();
  for (let i = 0; i < sorted.length; i++) {
    const bot = sorted[i];
    used.add(bot.id);
    let card = existing.get(bot.id);
    if (!card) {
      card = buildBotCard(bot, i + 1);
      container.appendChild(card);
    } else {
      if (container.children[i] !== card) container.insertBefore(card, container.children[i] || null);
    }
  }
  for (const [id, card] of existing.entries()) {
    if (!used.has(id)) card.remove();
  }
}

// ============================================================================
// Drawer body
// ============================================================================

export function renderDrawerBody(container, { bot, fullState, decisions, chat, memory }) {
  if (!bot) {
    container.innerHTML = `<div style="color:var(--ink-dim);padding:24px;text-align:center">no bot selected</div>`;
    return;
  }

  const pos      = fullState?.position ?? null;
  const goal     = fullState?.memory?.state?.current_goal ?? '—';
  const parent   = fullState?.memory?.state?.parent_goal ?? null;
  const tier     = inferTier(fullState?.inventory ?? []);
  const items    = fullState?.inventory ?? [];
  const chatRows = (chat ?? []).slice(-20);
  const ctxBlock = memory?.contextBlock ?? '';
  const slot     = PORT_TO_SLOT[bot.port];

  container.innerHTML = `
    <section class="dp">
      <div class="dp__head">
        <span>Vitals</span>
        <span class="dp__head__meta">${pos ? esc(coordTriplet(pos)) : '—'}</span>
      </div>
      <div class="dp__body">
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;font-family:var(--font-mono);font-size:var(--fs-xs)">
          <div>
            <div class="caps" style="color:var(--ink-dim)">HP</div>
            <div class="mono" style="font-size:var(--fs-md);color:var(--ink)">${fullState?.health != null ? Math.round(fullState.health) : '—'}/20</div>
          </div>
          <div>
            <div class="caps" style="color:var(--ink-dim)">Food</div>
            <div class="mono" style="font-size:var(--fs-md);color:var(--ink)">${fullState?.food != null ? Math.round(fullState.food) : '—'}/20</div>
          </div>
          <div>
            <div class="caps" style="color:var(--ink-dim)">Tier</div>
            <div class="mono" style="font-size:var(--fs-md);color:var(--ink)">${esc(tier ?? 'none')}</div>
          </div>
          <div>
            <div class="caps" style="color:var(--ink-dim)">State</div>
            <div class="mono" style="font-size:var(--fs-md);color:var(--ink)">${esc(bot.state)}</div>
          </div>
        </div>
        ${bot.lastBrainError?.message
          ? `<div style="margin-top:10px;padding:8px 10px;background:var(--bad-soft);border-left:2px solid var(--bad);border-radius:3px;font-family:var(--font-mono);font-size:var(--fs-2xs);color:var(--bad)">${esc(bot.lastBrainError.message)}</div>`
          : ''}
      </div>
    </section>

    <section class="dp">
      <div class="dp__head">
        <span>Goal</span>
        ${parent ? `<span class="dp__head__meta">parent · ${esc(ellipsis(String(parent), 60))}</span>` : ''}
      </div>
      <div class="dp__body">
        <div class="mono" style="font-size:var(--fs-sm);color:var(--ink);line-height:1.55">${esc(String(goal))}</div>
      </div>
    </section>

    <section class="dp">
      <div class="dp__head">
        <span>Decisions</span>
        <span class="dp__head__meta">${decisions.length} recent</span>
      </div>
      <div class="dp__body">
        ${renderDecList(decisions)}
      </div>
    </section>

    <section class="dp">
      <div class="dp__head">
        <span>Inventory</span>
        <span class="dp__head__meta">${items.length} items</span>
      </div>
      <div class="dp__body">
        ${renderInv(items)}
      </div>
    </section>

    <section class="dp">
      <div class="dp__head">
        <span>Memory · context block</span>
        <span class="dp__head__meta">verbatim LLM input</span>
      </div>
      <div class="dp__body">
        <div class="dp__pre">${esc(ellipsis(ctxBlock, 2400))}</div>
      </div>
    </section>

    <section class="dp">
      <div class="dp__head">
        <span>Recent chat</span>
        <span class="dp__head__meta">${chatRows.length} lines</span>
      </div>
      <div class="dp__body">
        ${renderChat(chatRows)}
      </div>
    </section>

    <section class="dp">
      <div class="dp__head">
        <span>Actions</span>
        <span class="dp__head__meta">${slot ? `slot ${slot}` : 'no slot'}</span>
      </div>
      <div class="dp__body">
        <div class="actions">
          <button class="btn" data-action="snapshot" data-bot-id="${esc(bot.id)}" title="freeze a record before recycle">
            Snapshot
          </button>
          ${bot.state === 'connected'
            ? `<button class="btn" data-action="disconnect" data-bot-id="${esc(bot.id)}">Disconnect</button>`
            : `<button class="btn btn--signal" data-action="connect" data-bot-id="${esc(bot.id)}">Connect</button>`}
          ${slot
            ? `<button class="btn btn--danger" data-action="recycle" data-slot-n="${esc(slot)}" title="snapshot → kill → wipe world → spawn">Recycle slot ${esc(slot)}</button>`
            : ''}
          <button class="btn" data-action="copy-id" data-bot-id="${esc(bot.id)}" title="copy bot id">Copy ID</button>
        </div>
      </div>
    </section>
  `;
}

function renderDecList(decisions) {
  if (!decisions.length) {
    return `<div style="color:var(--ink-dim);font-family:var(--font-mono);font-size:var(--fs-2xs);padding:4px 0">no decisions yet</div>`;
  }
  const rows = decisions.slice(0, 20).map((d) => {
    const action = d.action || d.decision || null;
    const t = clock(d.ts);
    if (action) {
      return `<div class="dec-list__row" data-kind="${esc(action.type || 'decide')}">
        <span class="t">${esc(t)}</span>
        <span class="body"><em>${esc(action.type || 'decide')}</em> ${esc(formatSkillPlain(action))}</span>
      </div>`;
    }
    if (d.summary) {
      return `<div class="dec-list__row" data-kind="info">
        <span class="t">${esc(t)}</span>
        <span class="body">${esc(d.summary)}</span>
      </div>`;
    }
    return '';
  }).join('');
  return `<div class="dec-list">${rows}</div>`;
}

function renderChat(rows) {
  if (!rows.length) {
    return `<div class="chat-list__empty">no chat yet — bot is alone on its server</div>`;
  }
  return `<div class="chat-list">${
    rows.map((r) => `
      <div class="chat-list__row">
        <span class="t">${esc(clock(r.ts))}</span>
        <span class="u">${esc(r.username || r.from || '—')}</span>
        <span class="m">${esc(r.message || r.text || '')}</span>
      </div>
    `).join('')
  }</div>`;
}

function renderInv(items) {
  // first 36 slots (main + hotbar). pad blanks.
  const slots = [];
  for (let i = 0; i < 36; i++) {
    const item = items.find((it) => it?.slot === i) || items[i];
    if (item && item.name) {
      const label = String(item.name).replace(/^minecraft:/, '').replace(/_/g, ' ');
      const qty = item.count > 1 ? `<span class="qty">${esc(item.count)}</span>` : '';
      slots.push(`<div class="inv__slot" title="${esc(label)} ×${esc(item.count || 1)}">
        <span class="inv__slot__name">${esc(label)}</span>${qty}
      </div>`);
    } else {
      slots.push(`<div class="inv__slot is-empty">·</div>`);
    }
  }
  return `<div class="inv">${slots.join('')}</div>`;
}

// ============================================================================
// constants — icons
// ============================================================================

const SKILL_ICON_DEFAULT = `<svg viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
  <circle cx="7" cy="7" r="2.4"/>
  <circle cx="7" cy="7" r="5.5" opacity="0.45"/>
</svg>`;
