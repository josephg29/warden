// Leaderboard — score bots by tier reached, inventory richness,
// skill success rate, and connected uptime. Persisted across refreshes.
// Stats reset automatically when a bot's joinedAt changes (recycle).

import { inferTier, esc, sortBots } from './util.js';

const STATS_LS_KEY = 'warden:stats:v1';

const TIER_POINTS = {
  netherite: 16000,
  diamond:    8000,
  iron:       4000,
  gold:       2000,
  stone:      1000,
  wood:        400,
};

// uptime is capped — past this many minutes it stops adding points so
// the leaderboard doesn't ossify around whichever bot first connected.
const UPTIME_CAP_MIN = 240;
const DISCONNECT_PENALTY = 500;

/**
 * Mutable stats keyed by bot.id.
 * Shape: { [botId]: {
 *   joinedAt:        string|null   (mirror of bot.joinedAt at last reset)
 *   skillAttempts:   number
 *   skillSuccesses:  number
 *   skillFails:      number
 *   decisions:       number
 *   firstSeen:       number  (epoch ms)
 *   lastRank:        number|null  (used for delta arrows)
 * } }
 */
export class StatsStore {
  constructor() {
    this.byBot = new Map();
    this._loadFromLS();
    this._persistTimer = null;
  }

  _loadFromLS() {
    try {
      const raw = localStorage.getItem(STATS_LS_KEY);
      if (!raw) return;
      const obj = JSON.parse(raw);
      if (obj && typeof obj === 'object') {
        for (const [id, s] of Object.entries(obj)) this.byBot.set(id, s);
      }
    } catch { /* corrupt cache — start fresh */ }
  }

  _persistSoon() {
    if (this._persistTimer) return;
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      try {
        const obj = Object.fromEntries(this.byBot.entries());
        localStorage.setItem(STATS_LS_KEY, JSON.stringify(obj));
      } catch { /* full / disabled */ }
    }, 700);
  }

  _ensure(bot) {
    let s = this.byBot.get(bot.id);
    if (!s) {
      s = {
        joinedAt:       bot.joinedAt ?? null,
        skillAttempts:  0,
        skillSuccesses: 0,
        skillFails:     0,
        decisions:      0,
        firstSeen:      Date.now(),
        lastRank:       null,
      };
      this.byBot.set(bot.id, s);
    }
    // recycle detection: if joinedAt changed, reset counters but keep rank.
    if (bot.joinedAt && s.joinedAt && bot.joinedAt !== s.joinedAt) {
      s.joinedAt       = bot.joinedAt;
      s.skillAttempts  = 0;
      s.skillSuccesses = 0;
      s.skillFails     = 0;
      s.decisions      = 0;
      s.firstSeen      = Date.now();
    } else if (!s.joinedAt && bot.joinedAt) {
      s.joinedAt = bot.joinedAt;
    }
    return s;
  }

  recordDecision(bot) {
    const s = this._ensure(bot);
    s.decisions      += 1;
    s.skillAttempts  += 1;
    this._persistSoon();
  }

  recordSkillDone(bot, result) {
    const s = this._ensure(bot);
    const ok = result?.ok !== false;
    if (ok) s.skillSuccesses += 1;
    else    s.skillFails     += 1;
    this._persistSoon();
  }

  forget(botId) {
    this.byBot.delete(botId);
    this._persistSoon();
  }

  reset() {
    this.byBot.clear();
    try { localStorage.removeItem(STATS_LS_KEY); } catch { /* noop */ }
  }

  get(botId) { return this.byBot.get(botId) ?? null; }
  setRank(botId, rank) {
    const s = this.byBot.get(botId);
    if (s) { s.lastRank = rank; this._persistSoon(); }
  }
}

// ---------------------------------------------------------------------------
// scoring
// ---------------------------------------------------------------------------

/**
 * Compute one bot's score and breakdown.
 * @param {Object} bot       — bot summary from /api/bots
 * @param {Object} fullState — cached /api/bots/:id/state
 * @param {Object} stats     — entry from StatsStore
 */
export function scoreBot(bot, fullState, stats) {
  const inventory = fullState?.inventory ?? [];
  const tier      = inferTier(inventory);
  const tierPoints = TIER_POINTS[tier] ?? 0;

  // inventory points — total stacks count, capped per item to prevent
  // exploit by hoarding one block type.
  let itemPoints = 0;
  const unique = new Set();
  for (const it of inventory) {
    if (!it?.name) continue;
    unique.add(it.name);
    itemPoints += Math.min(it.count || 0, 64);
  }
  const varietyPoints = unique.size * 20;

  const attempts   = stats?.skillAttempts ?? 0;
  const successes  = stats?.skillSuccesses ?? 0;
  const successRate = attempts > 0 ? successes / attempts : 0;
  // up to 400 points for a perfect success rate, requires at least 5
  // attempts to register fully (so 1/1 doesn't pin the leaderboard).
  const sampleWeight = Math.min(attempts / 5, 1);
  const successPoints = Math.round(successRate * 400 * sampleWeight);

  let uptimeMin = 0;
  if (bot.state === 'connected' && bot.joinedAt) {
    uptimeMin = Math.min(
      (Date.now() - new Date(bot.joinedAt).getTime()) / 60000,
      UPTIME_CAP_MIN,
    );
  }
  const uptimePoints = Math.round(uptimeMin);

  const disconnectPenalty = bot.state !== 'connected' ? DISCONNECT_PENALTY : 0;

  const total = tierPoints + itemPoints + varietyPoints + successPoints + uptimePoints - disconnectPenalty;
  return {
    total: Math.max(0, total),
    tier,
    breakdown: {
      tierPoints,
      itemPoints,
      varietyPoints,
      successPoints,
      uptimePoints,
      successRate,
      attempts,
      successes,
      uptimeMin: Math.round(uptimeMin),
      penalty: disconnectPenalty,
    },
  };
}

/**
 * Rank bots — returns array of { bot, score, rank, delta }.
 * @param {Iterable} bots
 * @param {Map} fullStateMap   botId -> /state cache
 * @param {StatsStore} stats
 */
export function rankBots(bots, fullStateMap, stats) {
  const all = sortBots([...bots]);
  const scored = all.map((bot) => ({
    bot,
    score: scoreBot(bot, fullStateMap.get(bot.id) ?? null, stats.get(bot.id)),
  }));
  scored.sort((a, b) => b.score.total - a.score.total);
  return scored.map((row, i) => {
    const rank = i + 1;
    const prevRank = stats.get(row.bot.id)?.lastRank ?? null;
    const delta = prevRank == null ? 0 : prevRank - rank;
    return { ...row, rank, delta };
  });
}

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------

export function renderLeaderboard(container, ranked) {
  if (!container) return;
  if (!ranked.length) {
    container.innerHTML = `<li style="grid-column:1/-1;text-align:center;color:var(--ink-dim);padding:18px;font-family:var(--font-mono);font-size:var(--fs-2xs)">no bots — no ranking yet</li>`;
    return;
  }
  container.innerHTML = ranked.map(({ bot, score, rank, delta }) => {
    const tier = score.tier || 'none';
    const disconnected = bot.state !== 'connected' ? '1' : '0';
    const arrow = delta > 0 ? '▲' : delta < 0 ? '▼' : '—';
    const dir   = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
    return `
      <li class="rank" data-rank="${rank}" data-disconnected="${disconnected}" data-bot-id="${esc(bot.id)}">
        <span class="rank__num">${rank}</span>
        <div class="rank__body">
          <span class="rank__name">${esc(bot.name || bot.id)}</span>
          <div class="rank__meta">
            <span class="rank__tier" data-tier="${esc(tier)}">${esc(tier)}</span>
            <span class="rank__score">${score.total.toLocaleString()}</span>
            <span class="rank__delta" data-dir="${dir}" title="rank change">${arrow}${delta !== 0 ? Math.abs(delta) : ''}</span>
          </div>
        </div>
      </li>
    `;
  }).join('');
}

/**
 * After rendering, write each bot's current rank back into stats so the next
 * render can show a delta arrow.
 */
export function persistRanks(ranked, stats) {
  for (const { bot, rank } of ranked) stats.setRank(bot.id, rank);
}
