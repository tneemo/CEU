// Two canvases carry the spatial language:
//  • Ambient — a sparse field of points drifting toward the viewer. It idles almost still and
//    accelerates while a model is generating, so the room itself reflects activity.
//  • History field — recent conversations as isometric towers on a floor grid; height encodes
//    length, the front row is the most recent. Hover to identify, click to reopen.
import { relTime, reducedMotion } from './util.js';

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export class Ambient {
  constructor(canvas) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d');
    this.pts = [];
    this.activity = 0;
    this.target = 0;
    this.enabled = true;
    this.running = false;
    this.last = 0;
    this.resize = this.resize.bind(this);
    this.frame = this.frame.bind(this);
    addEventListener('resize', this.resize);
    document.addEventListener('visibilitychange', () => this.kick());
    this.resize();
  }

  resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    this.w = innerWidth;
    this.h = innerHeight;
    this.c.width = this.w * dpr;
    this.c.height = this.h * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const n = Math.min(150, Math.round((this.w * this.h) / 12000));
    while (this.pts.length < n) this.pts.push(this.spawn(Math.random()));
    this.pts.length = n;
    this.color = cssVar('--particle') || '200,215,255';
    this.draw();
  }

  spawn(z = 1) {
    return { x: (Math.random() * 2 - 1) * 1.6, y: (Math.random() * 2 - 1) * 1.1, z: 0.08 + z * 0.92, s: Math.random() };
  }

  setActivity(a) { this.target = a; this.kick(); }
  setEnabled(on) { this.enabled = on; this.c.style.display = on ? '' : 'none'; this.kick(); }
  refreshTheme() { this.color = cssVar('--particle'); this.draw(); }

  kick() {
    if (this.running || !this.enabled || document.hidden || reducedMotion()) { this.draw(); return; }
    this.running = true;
    this.last = performance.now();
    requestAnimationFrame(this.frame);
  }

  frame(now) {
    if (!this.enabled || document.hidden) { this.running = false; return; }
    const dt = Math.min(0.1, (now - this.last) / 1000);
    if (dt < 1 / 32) { requestAnimationFrame(this.frame); return; } // ~30fps is plenty
    this.last = now;
    this.activity += (this.target - this.activity) * Math.min(1, dt * 1.6);
    const speed = 0.012 + this.activity * 0.11;
    for (const p of this.pts) {
      p.z -= speed * dt * (0.6 + p.s * 0.8);
      if (p.z < 0.08) Object.assign(p, this.spawn(1));
    }
    this.draw();
    requestAnimationFrame(this.frame);
  }

  draw() {
    const { ctx, w, h } = this;
    ctx.clearRect(0, 0, w, h);
    if (!this.enabled) return;
    const cx = w * 0.6, cy = h * 0.4, f = Math.min(w, h) * 0.42;
    const glow = 0.28 + this.activity * 0.25;
    for (const p of this.pts) {
      const sx = cx + (p.x / p.z) * f;
      const sy = cy + (p.y / p.z) * f;
      if (sx < -4 || sy < -4 || sx > w + 4 || sy > h + 4) continue;
      const near = 1 - p.z;
      const size = 0.6 + near * 1.8;
      ctx.fillStyle = `rgba(${this.color},${(near * near * glow + 0.02).toFixed(3)})`;
      ctx.fillRect(sx - size / 2, sy - size / 2, size, size);
    }
  }
}

// ------------------------------------------------------------------ history field

const COLS = 4, ROWS = 3;

export class HistoryField {
  constructor(canvas, label, { onOpen }) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d');
    this.label = label;
    this.onOpen = onOpen;
    this.items = [];
    this.hover = -1;
    this.anim = 0;
    this.raf = 0;
    this.t0 = 0;
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerleave', () => this.setHover(-1));
    canvas.addEventListener('click', () => { if (this.hover >= 0) this.onOpen(this.items[this.hover].conv.id); });
    new ResizeObserver(() => this.layout()).observe(canvas);
  }

  setData(convs) {
    const recent = convs.slice(0, COLS * ROWS);
    const prev = new Map(this.items.map((it) => [it.conv.id, it]));
    // slot order: front-most cell first so the newest conversation sits closest
    const slots = [];
    for (let i = 0; i < COLS; i++) for (let j = 0; j < ROWS; j++) slots.push([i, j]);
    slots.sort((a, b) => (b[0] + b[1]) - (a[0] + a[1]) || Math.abs(a[0] - a[1] - 0.5) - Math.abs(b[0] - b[1] - 0.5));
    this.items = recent.map((conv, k) => {
      const old = prev.get(conv.id);
      const target = 8 + Math.min(64, 13 * Math.log2((conv.message_count || 1) + 1));
      return { conv, cell: slots[k], target, h: old ? old.h : 0, lift: old ? old.lift : 0, delay: old ? 0 : k * 55 };
    });
    this.hover = -1;
    this.idle();
    this.layout();
    this.start();
  }

  layout() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const r = this.c.getBoundingClientRect();
    if (!r.width) return;
    this.w = r.width;
    this.h = r.height;
    this.c.width = r.width * dpr;
    this.c.height = r.height * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.tw = Math.min(86, this.w / 5.4);
    this.th = this.tw / 2;
    this.ox = this.w / 2 + ((ROWS - COLS) * this.tw) / 4;
    this.oy = this.h - (COLS + ROWS) * this.th / 2 - 14;
    this.colors = {
      top: cssVar('--plane-4'), left: cssVar('--plane-3'), right: cssVar('--plane-2'),
      line: cssVar('--line-2'), floor: cssVar('--line'), hover: cssVar('--line-3'), accent: cssVar('--accent'),
    };
    this.draw();
  }

  iso(i, j) {
    return [this.ox + (i - j) * this.tw / 2, this.oy + (i + j) * this.th / 2];
  }

  start() {
    cancelAnimationFrame(this.raf);
    this.t0 = performance.now();
    const step = (now) => {
      let moving = false;
      for (const [k, it] of this.items.entries()) {
        if (now - this.t0 < it.delay && !reducedMotion()) { moving = true; continue; }
        const tl = k === this.hover ? 7 : 0;
        const rate = reducedMotion() ? 1 : 0.16;
        it.h += (it.target - it.h) * rate;
        it.lift += (tl - it.lift) * (reducedMotion() ? 1 : 0.22);
        if (Math.abs(it.target - it.h) > 0.3 || Math.abs(tl - it.lift) > 0.2) moving = true;
      }
      const streaming = this.items.some((it) => it.conv.streaming);
      this.draw(now);
      if (moving || streaming) this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  polygon(it) {
    const [i, j] = it.cell;
    const inset = 0.2;
    const hh = it.h + it.lift;
    const a = this.iso(i + inset, j + inset), b = this.iso(i + 1 - inset, j + inset);
    const c = this.iso(i + 1 - inset, j + 1 - inset), d = this.iso(i + inset, j + 1 - inset);
    return { a, b, c, d, hh, lift: it.lift };
  }

  draw(now = performance.now()) {
    const { ctx, w, h } = this;
    if (!w) return;
    ctx.clearRect(0, 0, w, h);
    const C = this.colors;
    // floor grid
    ctx.strokeStyle = C.floor;
    ctx.lineWidth = 1;
    for (let i = 0; i <= COLS; i++) { const [x1, y1] = this.iso(i, 0), [x2, y2] = this.iso(i, ROWS); ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); }
    for (let j = 0; j <= ROWS; j++) { const [x1, y1] = this.iso(0, j), [x2, y2] = this.iso(COLS, j); ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); }

    const order = this.items.map((it, k) => [it, k]).sort((x, y) => (x[0].cell[0] + x[0].cell[1]) - (y[0].cell[0] + y[0].cell[1]));
    for (const [it, k] of order) {
      if (it.h < 0.5) continue;
      const { a, b, c, d, hh, lift } = this.polygon(it);
      const up = (p) => [p[0], p[1] - hh];
      const hot = k === this.hover;
      const pulse = it.conv.streaming ? 0.5 + 0.5 * Math.sin(now / 260) : 0;
      // shadow on floor when lifted
      if (lift > 0.5) {
        ctx.fillStyle = C.floor;
        ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.lineTo(...c); ctx.lineTo(...d); ctx.closePath(); ctx.fill();
      }
      const base = (p) => [p[0], p[1] - lift];
      // left face (d → c)
      face(ctx, [base(d), base(c), up(c), up(d)], C.left, hot ? C.hover : C.line);
      // right face (b → c)
      face(ctx, [base(c), base(b), up(b), up(c)], C.right, hot ? C.hover : C.line);
      // top — hover reads through the lift + shadow above (spatial, not colored);
      // only a live generation gets a colored pulse, never a hover/selection state
      face(ctx, [up(a), up(b), up(c), up(d)], C.top, hot ? C.hover : C.line);
      if (pulse) {
        ctx.globalAlpha = pulse * 0.35;
        face(ctx, [up(a), up(b), up(c), up(d)], C.accent, null);
        ctx.globalAlpha = 1;
      }
      it.hit = [base(d), base(c), base(b), up(b), up(a), up(d)];
    }
  }

  move(e) {
    const r = this.c.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    let found = -1;
    // test front-most first
    const order = this.items.map((it, k) => [it, k]).sort((p, q) => (q[0].cell[0] + q[0].cell[1]) - (p[0].cell[0] + p[0].cell[1]));
    for (const [it, k] of order) if (it.hit && inside(x, y, it.hit)) { found = k; break; }
    this.setHover(found);
  }

  setHover(k) {
    if (k === this.hover) return;
    this.hover = k;
    this.c.style.cursor = k >= 0 ? 'pointer' : 'default';
    if (k >= 0) {
      const c = this.items[k].conv;
      this.label.innerHTML = '';
      const b = document.createElement('b');
      b.textContent = c.title || 'Nova conversa';
      this.label.append(b, `${relTime(c.updated_at)} · ${c.message_count} mensage${c.message_count === 1 ? 'm' : 'ns'}`);
    } else this.idle();
    this.start();
  }

  idle() {
    const n = this.items.length;
    this.label.textContent = n ? `${n === 1 ? 'Conversa recente' : `${n} conversas recentes`} — altura indica o tamanho` : '';
  }

  refreshTheme() { this.layout(); }
}

function face(ctx, pts, fill, stroke) {
  ctx.beginPath();
  ctx.moveTo(...pts[0]);
  for (const p of pts.slice(1)) ctx.lineTo(...p);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
}

function inside(x, y, poly) {
  let ok = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) ok = !ok;
  }
  return ok;
}
