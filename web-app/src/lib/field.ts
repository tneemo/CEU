// Two canvases carry the spatial language (port of web/js/field.js):
//  • Ambient — a sparse field of points drifting toward the viewer. It idles almost still and
//    accelerates while a model is generating, so the room itself reflects activity.
//  • History field — recent conversations as isometric towers on a floor grid; height encodes
//    length, the front row is the most recent. Hover to identify, click to reopen.
import type { Conversation } from "../api";
import { reducedMotion } from "./util";

/** clamp01 ramp, eased — used to fade things in/out instead of popping */
const ease = (t: number) => { const c = Math.max(0, Math.min(1, t)); return c * c * (3 - 2 * c); };

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

interface Pt { x: number; y: number; z: number; s: number }
interface Solid { x: number; y: number; z: number; sx: number; sy: number; sz: number; rx: number; ry: number; vx: number; vy: number; hole: boolean }
interface Orb { x: number; y: number; z: number; vx: number; vy: number; rgb: string; trail: [number, number][]; age: number }

const ORBS = ["255,77,106", "77,134,255", "69,240,138", "255,79,216", "255,214,102"];
// unit-cube topology: 8 vertices, 6 quads, outward normals
const VERTS: [number, number, number][] = [[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]];
const FACES: { v: number[]; n: [number, number, number]; shade: number }[] = [
  { v: [4,5,6,7], n: [0,0,1], shade: .5 }, { v: [1,0,3,2], n: [0,0,-1], shade: .3 },
  { v: [5,1,2,6], n: [1,0,0], shade: .34 }, { v: [0,4,7,3], n: [-1,0,0], shade: .62 },
  { v: [7,6,2,3], n: [0,1,0], shade: .22 }, { v: [0,1,5,4], n: [0,-1,0], shade: 1 },
];

/** Space: translucent glass solids (cubes and long bars) drifting toward the viewer, a few coloured
 *  light-orbs with comet trails, and a faint star field. Idles slow; speeds up while a model generates. */
export class Ambient {
  c: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  pts: Pt[] = [];
  solids: Solid[] = [];
  orbs: Orb[] = [];
  activity = 0;
  target = 0;
  enabled = true;
  running = false;
  last = 0;
  w = 0;
  h = 0;
  color = "200,215,255";
  cube = "150,168,255";
  light = false;
  private onVis = () => this.kick();

  constructor(canvas: HTMLCanvasElement) {
    this.c = canvas;
    this.ctx = canvas.getContext("2d")!;
    addEventListener("resize", this.resize);
    document.addEventListener("visibilitychange", this.onVis);
    this.resize();
  }

  destroy() {
    this.enabled = false;
    removeEventListener("resize", this.resize);
    document.removeEventListener("visibilitychange", this.onVis);
  }

  resize = () => {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    this.w = innerWidth;
    this.h = innerHeight;
    this.c.width = this.w * dpr;
    this.c.height = this.h * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const n = Math.min(90, Math.round((this.w * this.h) / 20000));
    while (this.pts.length < n) this.pts.push(this.spawn(Math.random()));
    this.pts.length = n;
    const m = this.w < 700 ? 8 : 13;
    while (this.solids.length < m) this.solids.push(this.spawnSolid(Math.random()));
    this.solids.length = m;
    while (this.orbs.length < ORBS.length) this.orbs.push(this.spawnOrb(this.orbs.length));
    this.refreshTheme();
  };

  spawn(z = 1): Pt {
    return { x: (Math.random() * 2 - 1) * 1.6, y: (Math.random() * 2 - 1) * 1.1, z: 0.08 + z * 0.92, s: Math.random() };
  }

  spawnSolid(z = 1): Solid {
    const bar = Math.random() < 0.3;
    const u = 0.09 + Math.random() * 0.16;
    return {
      x: (Math.random() * 2 - 1) * 1.7, y: (Math.random() * 2 - 1) * 1.1, z: 0.25 + z * 0.9,
      sx: bar ? u * (1.6 + Math.random() * 3) : u, sy: u * (bar ? 0.7 : 1), sz: u * (bar ? 0.7 : 1),
      rx: Math.random() * 6.28, ry: Math.random() * 6.28,
      vx: (Math.random() - 0.5) * 0.35, vy: (Math.random() - 0.5) * 0.45,
      hole: !bar && Math.random() < 0.25,
    };
  }

  spawnOrb(i: number): Orb {
    return { x: (Math.random() * 2 - 1) * 1.3, y: (Math.random() * 2 - 1) * 0.8, z: 0.5 + Math.random() * 0.6, vx: (Math.random() - 0.5) * 0.12, vy: (Math.random() - 0.5) * 0.12, rgb: ORBS[i % ORBS.length], trail: [], age: 0 };
  }

  setActivity(a: number) {
    this.target = a;
    this.kick();
  }
  setEnabled(on: boolean) {
    this.enabled = on;
    this.c.style.display = on ? "" : "none";
    this.kick();
  }
  refreshTheme() {
    this.color = cssVar("--particle") || "200,215,255";
    this.cube = cssVar("--cube") || "150,168,255";
    this.light = document.documentElement.dataset.theme === "light";
    this.draw();
  }

  kick() {
    if (this.running || !this.enabled || document.hidden || reducedMotion()) {
      this.draw();
      return;
    }
    this.running = true;
    this.last = performance.now();
    requestAnimationFrame(this.frame);
  }

  frame = (now: number) => {
    if (!this.enabled || document.hidden) {
      this.running = false;
      return;
    }
    const dt = Math.min(0.1, (now - this.last) / 1000);
    if (dt < 1 / 32) {
      requestAnimationFrame(this.frame); // ~30fps is plenty
      return;
    }
    this.last = now;
    this.activity += (this.target - this.activity) * Math.min(1, dt * 1.6);
    // calm by design: generating only nudges the room (≈2x), it never whips it
    const boost = 1 + this.activity * 1.2;
    for (const p of this.pts) {
      p.z -= (0.008 + this.activity * 0.035) * dt * (0.6 + p.s * 0.8);
      if (p.z < 0.08) Object.assign(p, this.spawn(1));
    }
    for (const b of this.solids) {
      b.z -= 0.012 * boost * dt;
      b.rx += b.vx * dt * boost * 0.3;
      b.ry += b.vy * dt * boost * 0.3;
      if (b.z < 0.16) Object.assign(b, this.spawnSolid(1));
    }
    for (const o of this.orbs) {
      o.x += o.vx * dt * boost * 0.5;
      o.y += o.vy * dt * boost * 0.5;
      o.vx += (Math.random() - 0.5) * 0.02 * dt * boost;
      o.vy += (Math.random() - 0.5) * 0.02 * dt * boost;
      o.age += dt;
      o.trail.push([o.x, o.y]);
      while (o.trail.length > 26 + this.activity * 14) o.trail.shift();
      if (Math.abs(o.x) > 1.9 || Math.abs(o.y) > 1.25) Object.assign(o, this.spawnOrb(ORBS.indexOf(o.rgb)));
    }
    this.draw();
    requestAnimationFrame(this.frame);
  };

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
      const fade = ease((1 - p.z) / 0.12) * ease((p.z - 0.08) / 0.25);
      ctx.fillStyle = `rgba(${this.color},${((near * near * glow + 0.02) * fade).toFixed(3)})`;
      ctx.fillRect(sx - size / 2, sy - size / 2, size, size);
    }

    // solids, far to near
    const order = [...this.solids].sort((a, b) => b.z - a.z);
    for (const b of order) this.drawSolid(b, cx, cy, f);

    // orbs + comet trails
    ctx.globalCompositeOperation = this.light ? "source-over" : "lighter";
    for (const o of this.orbs) {
      const k = f / o.z;
      const oa = ease(o.age / 3) * ease((1.9 - Math.abs(o.x)) / 0.5) * ease((1.25 - Math.abs(o.y)) / 0.35);
      if (oa <= 0.004) continue;
      ctx.globalAlpha = oa;
      const r = (this.light ? 7 : 5) * (1.3 - o.z * 0.5);
      const pts = o.trail;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i], t = i / pts.length;
        ctx.strokeStyle = `rgba(${o.rgb},${(t * 0.55).toFixed(3)})`;
        ctx.lineWidth = 0.4 + t * 1.6;
        ctx.beginPath();
        ctx.moveTo(cx + a[0] * k, cy + a[1] * k);
        ctx.lineTo(cx + b[0] * k, cy + b[1] * k);
        ctx.stroke();
      }
      const x = cx + o.x * k, y = cy + o.y * k;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r * 4);
      g.addColorStop(0, "rgba(255,255,255,.95)");
      g.addColorStop(0.15, `rgba(${o.rgb},.9)`);
      g.addColorStop(1, `rgba(${o.rgb},0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r * 4, 0, 6.283);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  private drawSolid(b: Solid, cx: number, cy: number, f: number) {
    const { ctx } = this;
    const sa = Math.sin(b.rx), ca = Math.cos(b.rx), sb = Math.sin(b.ry), cb = Math.cos(b.ry);
    const rot = (x: number, y: number, z: number): [number, number, number] => {
      const y1 = y * ca - z * sa, z1 = y * sa + z * ca; // about X
      const x2 = x * cb + z1 * sb, z2 = -x * sb + z1 * cb; // about Y
      return [x2, y1, z2];
    };
    const P = VERTS.map(([x, y, z]) => {
      const [rx, ry, rz] = rot(x * b.sx, y * b.sy, z * b.sz);
      const zz = b.z + rz;
      return { x: cx + ((b.x + rx) / zz) * f, y: cy + ((b.y + ry) / zz) * f, z: zz };
    });
    // atmospheric perspective: far solids melt into the fog
    const depth = Math.max(0, Math.min(1, 1.15 - b.z));
    const fade = ease((1.15 - b.z) / 0.2) * ease((b.z - 0.16) / 0.3);
    const alpha = (0.16 + depth * 0.7) * fade;
    if (alpha < 0.004) return;
    const faces = FACES.map((fc) => {
      const [nx, ny, nz] = rot(...fc.n);
      const z = fc.v.reduce((s, i) => s + P[i].z, 0) / 4;
      return { fc, nz, z, ny, nx };
    })
      .filter((x) => x.nz < 0.02) // facing the camera
      .sort((p, q) => q.z - p.z);
    for (const { fc, nx, ny } of faces) {
      const lit = Math.max(0.12, Math.min(1, 0.55 + -ny * 0.35 - nx * 0.2 + fc.shade * 0.1));
      ctx.beginPath();
      fc.v.forEach((i, k) => (k ? ctx.lineTo(P[i].x, P[i].y) : ctx.moveTo(P[i].x, P[i].y)));
      ctx.closePath();
      ctx.fillStyle = this.light ? `rgba(255,255,255,${(alpha * 0.8 * lit).toFixed(3)})` : `rgba(${this.cube},${(alpha * lit * 0.85).toFixed(3)})`;
      ctx.fill();
      ctx.strokeStyle = this.light ? `rgba(40,140,230,${(alpha * 0.55).toFixed(3)})` : `rgba(220,232,255,${(alpha * 0.55).toFixed(3)})`;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    if (b.hole && faces.length) {
      // dark square window, like the hollow cubes in the boot art
      const q = faces[faces.length - 1].fc.v.map((i) => P[i]);
      const mx = q.reduce((s, p) => s + p.x, 0) / 4, my = q.reduce((s, p) => s + p.y, 0) / 4;
      ctx.beginPath();
      q.forEach((p, k) => {
        const x = mx + (p.x - mx) * 0.52, y = my + (p.y - my) * 0.52;
        if (k) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      });
      ctx.closePath();
      ctx.fillStyle = `rgba(4,6,40,${(alpha * 0.9).toFixed(3)})`;
      ctx.fill();
    }
  }
}

// ------------------------------------------------------------------ history field

const COLS = 4, ROWS = 3;
type P2 = [number, number];

interface Item {
  conv: Conversation;
  cell: P2;
  target: number;
  h: number;
  lift: number;
  delay: number;
  hit?: P2[];
}

export class HistoryField {
  c: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  onHover: (conv: Conversation | null, count: number) => void;
  onOpen: (id: string) => void;
  items: Item[] = [];
  hover = -1;
  raf = 0;
  t0 = 0;
  w = 0;
  h = 0;
  tw = 0;
  th = 0;
  ox = 0;
  oy = 0;
  colors: Record<string, string> = {};
  private ro: ResizeObserver;

  constructor(canvas: HTMLCanvasElement, { onOpen, onHover }: { onOpen: (id: string) => void; onHover: (c: Conversation | null, n: number) => void }) {
    this.c = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.onOpen = onOpen;
    this.onHover = onHover;
    canvas.addEventListener("pointermove", this.move);
    canvas.addEventListener("pointerleave", this.leave);
    canvas.addEventListener("click", this.click);
    this.ro = new ResizeObserver(() => this.layout());
    this.ro.observe(canvas);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.c.removeEventListener("pointermove", this.move);
    this.c.removeEventListener("pointerleave", this.leave);
    this.c.removeEventListener("click", this.click);
  }

  private leave = () => this.setHover(-1);
  private click = () => {
    if (this.hover >= 0) this.onOpen(this.items[this.hover].conv.id);
  };

  setData(convs: Conversation[]) {
    const recent = convs.slice(0, COLS * ROWS);
    const prev = new Map(this.items.map((it) => [it.conv.id, it]));
    // slot order: front-most cell first so the newest conversation sits closest
    const slots: P2[] = [];
    for (let i = 0; i < COLS; i++) for (let j = 0; j < ROWS; j++) slots.push([i, j]);
    slots.sort((a, b) => b[0] + b[1] - (a[0] + a[1]) || Math.abs(a[0] - a[1] - 0.5) - Math.abs(b[0] - b[1] - 0.5));
    this.items = recent.map((conv, k) => {
      const old = prev.get(conv.id);
      const target = 8 + Math.min(64, 13 * Math.log2((conv.message_count || 1) + 1));
      return { conv, cell: slots[k], target, h: old ? old.h : 0, lift: old ? old.lift : 0, delay: old ? 0 : k * 55 };
    });
    this.hover = -1;
    this.onHover(null, this.items.length);
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
    this.oy = this.h - ((COLS + ROWS) * this.th) / 2 - 14;
    const cube = cssVar("--cube") || "150,168,255";
    const light = document.documentElement.dataset.theme === "light";
    this.colors = {
      top: light ? "rgba(255,255,255,.95)" : `rgba(${cube},.92)`,
      left: light ? "rgba(255,255,255,.62)" : `rgba(${cube},.5)`,
      right: light ? "rgba(190,225,250,.7)" : `rgba(${cube},.28)`,
      line: light ? "rgba(255,255,255,.95)" : "rgba(225,235,255,.4)",
      floor: light ? "rgba(255,255,255,.55)" : "rgba(190,205,255,.16)",
      hover: light ? "#ffffff" : "rgba(255,255,255,.85)",
      accent: cssVar("--accent"),
    };
    this.draw();
  }

  iso(i: number, j: number): P2 {
    return [this.ox + ((i - j) * this.tw) / 2, this.oy + ((i + j) * this.th) / 2];
  }

  start() {
    cancelAnimationFrame(this.raf);
    this.t0 = performance.now();
    const step = (now: number) => {
      let moving = false;
      const rm = reducedMotion();
      this.items.forEach((it, k) => {
        if (now - this.t0 < it.delay && !rm) {
          moving = true;
          return;
        }
        const tl = k === this.hover ? 7 : 0;
        it.h += (it.target - it.h) * (rm ? 1 : 0.16);
        it.lift += (tl - it.lift) * (rm ? 1 : 0.22);
        if (Math.abs(it.target - it.h) > 0.3 || Math.abs(tl - it.lift) > 0.2) moving = true;
      });
      const streaming = this.items.some((it) => it.conv.streaming);
      this.draw(now);
      if (moving || streaming) this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  draw(now = performance.now()) {
    const { ctx, w, h } = this;
    if (!w) return;
    ctx.clearRect(0, 0, w, h);
    const C = this.colors;
    // floor grid
    ctx.strokeStyle = C.floor;
    ctx.lineWidth = 1;
    for (let i = 0; i <= COLS; i++) line(ctx, this.iso(i, 0), this.iso(i, ROWS));
    for (let j = 0; j <= ROWS; j++) line(ctx, this.iso(0, j), this.iso(COLS, j));

    const order = this.items.map((it, k) => [it, k] as const).sort((x, y) => x[0].cell[0] + x[0].cell[1] - (y[0].cell[0] + y[0].cell[1]));
    for (const [it, k] of order) {
      if (it.h < 0.5) continue;
      const [i, j] = it.cell;
      const inset = 0.2;
      const hh = it.h + it.lift;
      const lift = it.lift;
      const a = this.iso(i + inset, j + inset), b = this.iso(i + 1 - inset, j + inset);
      const c = this.iso(i + 1 - inset, j + 1 - inset), d = this.iso(i + inset, j + 1 - inset);
      const up = (p: P2): P2 => [p[0], p[1] - hh];
      const base = (p: P2): P2 => [p[0], p[1] - lift];
      const hot = k === this.hover;
      const pulse = it.conv.streaming ? 0.5 + 0.5 * Math.sin(now / 260) : 0;
      // shadow on floor when lifted
      if (lift > 0.5) face(ctx, [a, b, c, d], C.floor, null);
      if (hot || pulse) {
        ctx.shadowColor = C.accent;
        ctx.shadowBlur = hot ? 22 : 10 + pulse * 14;
      }
      face(ctx, [base(d), base(c), up(c), up(d)], C.left, hot ? C.hover : C.line);
      ctx.shadowBlur = 0;
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

  private move = (e: PointerEvent) => {
    const r = this.c.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    let found = -1;
    // test front-most first
    const order = this.items.map((it, k) => [it, k] as const).sort((p, q) => q[0].cell[0] + q[0].cell[1] - (p[0].cell[0] + p[0].cell[1]));
    for (const [it, k] of order) if (it.hit && inside(x, y, it.hit)) { found = k; break; }
    this.setHover(found);
  };

  setHover(k: number) {
    if (k === this.hover) return;
    this.hover = k;
    this.c.style.cursor = k >= 0 ? "pointer" : "default";
    this.onHover(k >= 0 ? this.items[k].conv : null, this.items.length);
    this.start();
  }

  refreshTheme() {
    this.layout();
  }
}

function line(ctx: CanvasRenderingContext2D, [x1, y1]: P2, [x2, y2]: P2) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function face(ctx: CanvasRenderingContext2D, pts: P2[], fill: string, stroke: string | null) {
  ctx.beginPath();
  ctx.moveTo(...pts[0]);
  for (const p of pts.slice(1)) ctx.lineTo(...p);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

function inside(x: number, y: number, poly: P2[]) {
  let ok = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) ok = !ok;
  }
  return ok;
}
