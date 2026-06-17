// transient UI effects — toasts, card pulses, flash hints
// no DOM topology changes here; assumes DOM was set up by render.js

const reduced = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const FLASH_CLASS = 'is-flash';

/**
 * Briefly pulse the brand mark — a single global "heartbeat" hint that
 * something on the fleet just moved. Coalesces rapid bursts.
 */
let _brandFlashTimer = null;
export function pulseBrand() {
  if (reduced()) return;
  const mark = document.querySelector('.hud__mark');
  if (!mark) return;
  if (_brandFlashTimer) return; // coalesce — at most every 220ms
  mark.style.filter = 'drop-shadow(0 0 12px rgba(255,181,71,0.85))';
  _brandFlashTimer = setTimeout(() => {
    mark.style.filter = '';
    _brandFlashTimer = null;
  }, 220);
}

/**
 * Briefly pulse a bot card after a fresh decision or skill result.
 */
export function pulseCard(botId) {
  if (reduced()) return;
  const card = document.querySelector(`.card[data-bot-id="${cssQuote(botId)}"]`);
  if (!card) return;
  card.classList.remove(FLASH_CLASS);
  // force reflow so the animation can restart
  void card.offsetWidth;
  card.classList.add(FLASH_CLASS);
  setTimeout(() => card.classList.remove(FLASH_CLASS), 800);
}

/**
 * Toast a transient message.
 * @param {string} text
 * @param {'info'|'ok'|'bad'} kind
 * @param {number} ttlMs
 */
export function toast(text, kind = 'info', ttlMs = 3200) {
  const root = document.getElementById('toast-root');
  if (!root) return;
  const node = document.createElement('div');
  node.className = `toast toast--${kind}`;
  node.textContent = text;
  root.appendChild(node);

  setTimeout(() => {
    node.style.transition = 'opacity 220ms ease, transform 220ms ease';
    node.style.opacity = '0';
    node.style.transform = 'translateY(8px)';
    setTimeout(() => node.remove(), 260);
  }, ttlMs);
}

/**
 * Escape a string for use as a CSS attribute value selector.
 */
function cssQuote(s) {
  return String(s).replace(/(["\\])/g, '\\$1');
}
