// per-card mini-map renderer
// each card has its own MiniMap instance — they are NOT a shared world,
// each bot is on its own Minecraft server. so each map is bot-centered
// and shows the bot's local trail.

import { hueFromId } from './util.js';

const TRAIL_MAX_POINTS = 60;
const TRAIL_MIN_MOVE   = 0.6;      // ignore points within 0.6 blocks
const VIEW_PADDING     = 8;        // blocks of viewport padding
const DEFAULT_RADIUS   = 32;       // half-extent of view when bot is still
const DPR_CAP          = 2;

export class MiniMap {
  constructor(canvas, { botId }) {
    this.canvas = canvas;
    this.ctx    = canvas.getContext('2d');
    this.botId  = botId;
    this.trail  = [];                  // [{x, z, ts}]
    this.pos    = null;                // current { x, y, z, yaw }
    this.last   = null;                // last seen pos
    this.alive  = false;
    this.hue    = hueFromId(botId);
    this.bounds = { minX: -DEFAULT_RADIUS, maxX: DEFAULT_RADIUS, minZ: -DEFAULT_RADIUS, maxZ: DEFAULT_RADIUS };
    this._dpr   = Math.min(window.devicePixelRatio || 1, DPR_CAP);
    this._sized = false;

    this._resize();
    if (typeof ResizeObserver === 'function') {
      this._ro = new ResizeObserver(() => this._resize());
      this._ro.observe(canvas);
    } else {
      window.addEventListener('resize', () => this._resize());
    }
  }

  destroy() {
    if (this._ro) try { this._ro.disconnect(); } catch { /* noop */ }
  }

  /**
   * Push a new position observation.
   * @param {{x:number,y:number,z:number,yaw?:number}} p
   * @param {boolean} alive whether bot is currently alive/connected
   */
  push(p, alive = true) {
    if (!p || p.x == null) return;
    this.alive = alive;
    this.pos   = p;

    const last = this.last;
    if (!last || Math.hypot(p.x - last.x, p.z - last.z) >= TRAIL_MIN_MOVE) {
      this.trail.push({ x: p.x, z: p.z, ts: Date.now() });
      if (this.trail.length > TRAIL_MAX_POINTS) this.trail.shift();
      this.last = { x: p.x, z: p.z };
    }
    this._recomputeBounds();
    this._draw();
  }

  setOffline() {
    this.alive = false;
    this._draw();
  }

  _recomputeBounds() {
    if (!this.pos) return;
    const xs = [this.pos.x];
    const zs = [this.pos.z];
    for (const p of this.trail) { xs.push(p.x); zs.push(p.z); }
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minZ = Math.min(...zs);
    const maxZ = Math.max(...zs);
    const w = Math.max(maxX - minX, 16) + VIEW_PADDING * 2;
    const h = Math.max(maxZ - minZ, 16) + VIEW_PADDING * 2;
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    const rect = this.canvas.getBoundingClientRect();
    const aspect = rect.width > 0 ? rect.width / rect.height : 16 / 9;
    let viewW = w;
    let viewH = h;
    if (viewW / viewH > aspect) viewH = viewW / aspect;
    else                        viewW = viewH * aspect;
    this.bounds = {
      minX: cx - viewW / 2,
      maxX: cx + viewW / 2,
      minZ: cz - viewH / 2,
      maxZ: cz + viewH / 2,
    };
  }

  _resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) return;
    const dpr = this._dpr;
    this.canvas.width  = Math.floor(rect.width  * dpr);
    this.canvas.height = Math.floor(rect.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._sized = true;
    this._draw();
  }

  _xz(x, z) {
    const rect = this.canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    const { minX, maxX, minZ, maxZ } = this.bounds;
    const px = ((x - minX) / (maxX - minX)) * w;
    const pz = ((z - minZ) / (maxZ - minZ)) * h;
    return [px, pz];
  }

  _draw() {
    if (!this._sized) return;
    const ctx = this.ctx;
    const rect = this.canvas.getBoundingClientRect();
    const W = rect.width;
    const H = rect.height;
    ctx.clearRect(0, 0, W, H);

    this._drawGrid(ctx, W, H);

    if (this.trail.length > 1) {
      const hue = this.hue;
      for (let i = 1; i < this.trail.length; i++) {
        const a = this.trail[i - 1];
        const b = this.trail[i];
        const [ax, az] = this._xz(a.x, a.z);
        const [bx, bz] = this._xz(b.x, b.z);
        const t = i / this.trail.length;
        ctx.strokeStyle = `hsla(${hue}, 70%, 65%, ${0.06 + 0.55 * t})`;
        ctx.lineWidth = 1 + t * 0.5;
        ctx.beginPath();
        ctx.moveTo(ax, az);
        ctx.lineTo(bx, bz);
        ctx.stroke();
      }
    }

    if (this.pos) {
      const [px, pz] = this._xz(this.pos.x, this.pos.z);
      const hue = this.hue;

      if (this.alive) {
        const t = (Date.now() % 2400) / 2400;
        const r = 4 + 8 * t;
        ctx.strokeStyle = `hsla(${hue}, 80%, 70%, ${0.4 * (1 - t)})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(px, pz, r, 0, Math.PI * 2);
        ctx.stroke();
      }

      if (this.pos.yaw != null) {
        const yaw = this.pos.yaw + Math.PI / 2;
        ctx.fillStyle = this.alive
          ? `hsla(${hue}, 80%, 70%, 0.22)`
          : 'rgba(110,119,133,0.18)';
        ctx.beginPath();
        ctx.moveTo(px, pz);
        const spread = Math.PI / 3.5;
        const reach  = 18;
        ctx.arc(px, pz, reach, yaw - spread, yaw + spread);
        ctx.closePath();
        ctx.fill();
      }

      const dotColor = this.alive ? `hsl(${hue}, 80%, 70%)` : 'rgba(110,119,133,0.7)';
      ctx.fillStyle = dotColor;
      ctx.beginPath();
      ctx.arc(px, pz, 3.2, 0, Math.PI * 2);
      ctx.fill();
      if (this.alive) {
        ctx.shadowColor = dotColor;
        ctx.shadowBlur  = 8;
        ctx.beginPath();
        ctx.arc(px, pz, 1.8, 0, Math.PI * 2);
        ctx.fillStyle = '#fff';
        ctx.fill();
        ctx.shadowBlur = 0;
      }
    }

    if (this.pos) {
      ctx.strokeStyle = 'rgba(255,255,255,0.04)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(W / 2 - 6, H / 2); ctx.lineTo(W / 2 + 6, H / 2);
      ctx.moveTo(W / 2, H / 2 - 6); ctx.lineTo(W / 2, H / 2 + 6);
      ctx.stroke();
    }
  }

  _drawGrid(ctx, W, H) {
    const { minX, maxX, minZ, maxZ } = this.bounds;
    const span = maxX - minX;
    let step = 16;
    while (span / step > 8) step *= 2;
    while (span / step < 3) step /= 2;
    if (step < 4) step = 4;

    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 1;

    const firstX = Math.ceil(minX / step) * step;
    for (let gx = firstX; gx <= maxX; gx += step) {
      const [x] = this._xz(gx, minZ);
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, H);
      ctx.stroke();
    }
    const firstZ = Math.ceil(minZ / step) * step;
    for (let gz = firstZ; gz <= maxZ; gz += step) {
      const [, z] = this._xz(minX, gz);
      ctx.beginPath();
      ctx.moveTo(0, z + 0.5);
      ctx.lineTo(W, z + 0.5);
      ctx.stroke();
    }

    if (0 >= minX && 0 <= maxX && 0 >= minZ && 0 <= maxZ) {
      const [ox, oz] = this._xz(0, 0);
      ctx.strokeStyle = 'rgba(255,181,71,0.18)';
      ctx.beginPath();
      ctx.arc(ox, oz, 4, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

/**
 * Pool of MiniMap instances keyed by botId.
 * Drives a single rAF loop so the pulsing rings stay smooth.
 */
export class MiniMapPool {
  constructor() {
    this.maps = new Map();
    this._loop = this._loop.bind(this);
    this._loop();
  }

  attach(botId, canvas) {
    const existing = this.maps.get(botId);
    if (existing && existing.canvas === canvas) return existing;
    if (existing) existing.destroy();
    const m = new MiniMap(canvas, { botId });
    this.maps.set(botId, m);
    return m;
  }

  detach(botId) {
    const m = this.maps.get(botId);
    if (m) { m.destroy(); this.maps.delete(botId); }
  }

  get(botId) { return this.maps.get(botId); }

  pushTick(tick) {
    if (!tick || !Array.isArray(tick.bots)) return;
    for (const b of tick.bots) {
      const m = this.maps.get(b.id);
      if (m) m.push(b, true);
    }
  }

  markOffline(botId) {
    const m = this.maps.get(botId);
    if (m) m.setOffline();
  }

  _loop() {
    for (const m of this.maps.values()) {
      if (m.alive && m.pos) m._draw();
    }
    requestAnimationFrame(this._loop);
  }
}
