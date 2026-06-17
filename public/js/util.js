// pure helpers — no DOM, no state

export const PORT_TO_SLOT = {
  25565: 1, 25566: 2, 25567: 3, 25568: 4,
  25569: 5, 25570: 6, 25571: 7, 25572: 8,
};

/**
 * @param {number} ts epoch ms
 * @returns {string} HH:MM:SS
 */
export function clock(ts = Date.now()) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * @param {number} ms duration in milliseconds
 */
export function shortDuration(ms) {
  if (!ms || ms < 0) return '0s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 ? ` ${s % 60}s` : ''}`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 ? ` ${m % 60}m` : ''}`;
}

/**
 * @param {number} ts epoch ms — how long ago, compact form
 */
export function relTime(ts) {
  if (!ts) return '—';
  return shortDuration(Date.now() - ts) + ' ago';
}

/**
 * @param {number} n
 */
export function intCoord(n) {
  if (n == null || Number.isNaN(n)) return '—';
  return String(Math.round(n));
}

/**
 * @param {{x:number,y:number,z:number}} pos
 */
export function coordTriplet(pos) {
  if (!pos) return '—';
  return `${intCoord(pos.x)} · ${intCoord(pos.y)} · ${intCoord(pos.z)}`;
}

/**
 * Truncate a long string with an ellipsis, keep mono-friendly.
 */
export function ellipsis(s, max = 80) {
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Infer the bot's tier from its inventory.
 * Looks at the best pickaxe present.
 * `inventory` is the array of items returned by getFullState().
 */
export function inferTier(inventory) {
  if (!Array.isArray(inventory)) return null;
  const names = new Set(inventory.map((i) => (i?.name || '').toLowerCase()));

  const has = (n) => names.has(n);
  if (has('netherite_pickaxe')) return 'netherite';
  if (has('diamond_pickaxe'))   return 'diamond';
  if (has('iron_pickaxe'))      return 'iron';
  if (has('golden_pickaxe'))    return 'gold';
  if (has('stone_pickaxe'))     return 'stone';
  if (has('wooden_pickaxe'))    return 'wood';

  return null;
}

/**
 * Pretty-format a skill name + args into HTML for direct injection.
 * Escapes user-controlled content; the only HTML produced is a wrapper span.
 */
export function formatSkill(skill) {
  if (!skill) return '—';
  const name = skill.name || skill.skill || skill.type || 'unknown';
  const args = skill.args || skill.input || {};
  const argText = Object.entries(args)
    .filter(([_, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => {
      if (typeof v === 'object') return `${k}=…`;
      const sv = String(v);
      return `${k}=${sv.length > 16 ? sv.slice(0, 15) + '…' : sv}`;
    })
    .join(' ');
  return argText
    ? `${esc(name)} <span class="arg">(${esc(argText)})</span>`
    : esc(name);
}

/**
 * Plain text version of formatSkill (no HTML).
 */
export function formatSkillPlain(skill) {
  if (!skill) return '—';
  const name = skill.name || skill.skill || skill.type || 'unknown';
  const args = skill.args || skill.input || {};
  const argText = Object.entries(args)
    .filter(([_, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${typeof v === 'object' ? '…' : v}`)
    .join(' ');
  return argText ? `${name}(${argText})` : name;
}

/**
 * Classify health/food level for color thresholds.
 */
export function healthLevel(value, max = 20) {
  if (value == null) return 'unknown';
  const pct = value / max;
  if (pct <= 0.25) return 'critical';
  if (pct <= 0.5)  return 'low';
  return 'ok';
}

/**
 * Map a bot's high-level visible state.
 * Returns one of: alive | idle | error | disconnected
 */
export function classifyBotState(bot) {
  if (!bot) return 'disconnected';
  if (bot.state !== 'connected') return 'disconnected';

  const err = bot.lastBrainError;
  const ageS = bot.lastDecisionAgeS;

  if (err && err.message) return 'error';
  if (ageS != null && ageS > 60) return 'idle';
  return 'alive';
}

/**
 * Stable HSL hue from a string (used for trail color etc.).
 */
export function hueFromId(str) {
  let h = 0;
  for (let i = 0; i < (str || '').length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return ((h % 360) + 360) % 360;
}

/**
 * Sort bots by slot if we can infer it, else alphabetically.
 */
export function sortBots(bots) {
  return bots.slice().sort((a, b) => {
    const sa = PORT_TO_SLOT[a.port] ?? 99;
    const sb = PORT_TO_SLOT[b.port] ?? 99;
    if (sa !== sb) return sa - sb;
    return (a.name || '').localeCompare(b.name || '');
  });
}

/**
 * Mini-string for the human bot label, including slot.
 */
export function slotLabel(bot) {
  const slot = PORT_TO_SLOT[bot.port];
  if (!slot) return `port ${bot.port}`;
  return `slot ${slot}`;
}

/**
 * Escape HTML in user-provided strings.
 */
export function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
