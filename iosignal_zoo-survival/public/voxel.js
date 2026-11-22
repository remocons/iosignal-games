// Isometric voxel drawing on a 2D canvas: boxes with a light top and two shaded sides,
// the zoo terrain, and small voxel animals and robots built from boxes.
import { MAP, W, H, tileHeight } from './shared.js';

// ---------------------------------------------------------------- colors
const shadeCache = new Map();
/** hex '#rrggbb' scaled by f (1 = same, <1 darker, >1 lighter). */
export function shade(hex, f) {
  const key = hex + f;
  let v = shadeCache.get(key);
  if (!v) {
    const n = parseInt(hex.slice(1), 16);
    const c = (s) => Math.max(0, Math.min(255, Math.round(((n >> s) & 255) * f)));
    v = `rgb(${c(16)},${c(8)},${c(0)})`;
    shadeCache.set(key, v);
  }
  return v;
}

export const PAL = {
  grass: '#8ed65a', grass2: '#84cc52', dirt: '#b57d4a', dirtDark: '#8f5f36',
  path: '#efd9a7', gate: '#f6c453', water: '#4cc3f3', waterDeep: '#2d9fd6', foam: '#bfefff',
  trunk: '#8a5a3a', leaf: '#43b04f', leaf2: '#63cf5e', rock: '#9ea4ab', bush: '#4fbf55',
  fence: '#d39b5a', plank: '#b98048', stair: '#d8cfbf',
};

// ---------------------------------------------------------------- projection
/**
 * World (x, y) are tiles on the ground, z is up (1 = one tile). The view can be turned by quarter
 * turns (turn 0-3): world -> view coordinates, then screen x = (vx - vy) * s,
 * screen y = (vx + vy) * s / 2 - z * s. Things with a larger vx + vy are nearer the viewer.
 */
export class Iso {
  constructor(ctx) { this.ctx = ctx; this.s = 32; this.ox = 0; this.oy = 0; this.turn = 0; }
  /** Map size as seen in this view. */
  get vw() { return this.turn % 2 ? H : W; }
  get vh() { return this.turn % 2 ? W : H; }
  toView(x, y) {
    switch (this.turn) {
      case 1: return [H - y, x];
      case 2: return [W - x, H - y];
      case 3: return [y, W - x];
      default: return [x, y];
    }
  }
  /** Depth key of a world point: larger is nearer. */
  key(x, y) { const [a, b] = this.toView(x, y); return a + b; }
  px(x, y) { const [a, b] = this.toView(x, y); return this.ox + (a - b) * this.s; }
  py(x, y, z) { const [a, b] = this.toView(x, y); return this.oy + (a + b) * this.s * 0.5 - z * this.s; }

  /** Box from world (x, y, z) with size (w, d, h). Draws the top and the two faces the viewer sees. */
  box(x, y, z, w, d, h, top, side = top, alpha = 1) {
    switch (this.turn) {
      case 1: [x, y, w, d] = [H - y - d, x, d, w]; break;
      case 2: [x, y] = [W - x - w, H - y - d]; break;
      case 3: [x, y, w, d] = [y, W - x - w, d, w]; break;
    }
    this.vbox(x, y, z, w, d, h, top, side, alpha);
  }

  /** Box already in view coordinates. */
  vbox(x, y, z, w, d, h, top, side = top, alpha = 1) {
    const c = this.ctx, s = this.s;
    const X = (a, b) => this.ox + (a - b) * s;
    const Y = (a, b, zz) => this.oy + (a + b) * s * 0.5 - zz * s;
    const x1 = x + w, y1 = y + d, z1 = z + h;
    if (alpha !== 1) c.globalAlpha = alpha;
    // +y face (lower left)
    c.fillStyle = shade(side, 0.82);
    c.beginPath();
    c.moveTo(X(x, y1), Y(x, y1, z)); c.lineTo(X(x1, y1), Y(x1, y1, z));
    c.lineTo(X(x1, y1), Y(x1, y1, z1)); c.lineTo(X(x, y1), Y(x, y1, z1));
    c.fill();
    // +x face (lower right)
    c.fillStyle = shade(side, 0.66);
    c.beginPath();
    c.moveTo(X(x1, y), Y(x1, y, z)); c.lineTo(X(x1, y1), Y(x1, y1, z));
    c.lineTo(X(x1, y1), Y(x1, y1, z1)); c.lineTo(X(x1, y), Y(x1, y, z1));
    c.fill();
    // top
    c.fillStyle = top.startsWith('#') ? shade(top, 1) : top;
    c.beginPath();
    c.moveTo(X(x, y), Y(x, y, z1)); c.lineTo(X(x1, y), Y(x1, y, z1));
    c.lineTo(X(x1, y1), Y(x1, y1, z1)); c.lineTo(X(x, y1), Y(x, y1, z1));
    c.fill();
    if (alpha !== 1) c.globalAlpha = 1;
  }

  /** Flat ellipse shadow on the ground. */
  shadow(x, y, z, r, a = 0.25) {
    const c = this.ctx;
    c.fillStyle = `rgba(0,0,0,${a})`;
    c.beginPath();
    c.ellipse(this.px(x, y), this.py(x, y, z), r * this.s, r * this.s * 0.5, 0, 0, Math.PI * 2);
    c.fill();
  }
}

// ---------------------------------------------------------------- terrain
const isWaterCh = (ch) => ch === '~' || ch === '-';
const ch = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? 'T' : MAP[y][x]);

// Tiles back to front for a view turn, per map.
const orders = new Map();
function tileOrder(iso) {
  const k = `${iso.turn}:${MAP[0]}:${MAP[1]}:${W}x${H}`;
  let o = orders.get(k);
  if (!o) {
    o = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) o.push([x, y, iso.key(x + 0.5, y + 0.5)]);
    o.sort((a, b) => a[2] - b[2]);
    orders.set(k, o);
  }
  return o;
}

/** Ground of every visible tile, drawn back to front. visible(x, y) -> bool for the tile. */
export function drawGround(iso, t, visible = () => true) {
  for (const [x, y] of tileOrder(iso)) {
    if (!visible(x, y)) continue;
    {
      const c = MAP[y][x];
      if (isWaterCh(c)) {
        const wave = Math.sin(t / 600 + x * 0.9 + y * 0.6) * 0.04;
        iso.box(x, y, -0.6, 1, 1, 0.38 + wave, (x + y) % 2 ? PAL.water : PAL.waterDeep, PAL.waterDeep);
        continue;
      }
      const h = tileHeight(x + 0.5, y + 0.5);
      if (c === 's' || c === 'S') { drawStairs(iso, x, y, h); continue; }
      if (c === 'E') { drawExit(iso, x, y, t); continue; }
      const top = c === ',' ? PAL.path : c === 'G' ? PAL.gate : c === '=' ? PAL.plank
        : (x + y) % 2 ? PAL.grass : PAL.grass2;
      if (c === '=') {
        iso.box(x, y, -0.6, 1, 1, 0.38, PAL.waterDeep);           // water under the bridge
        iso.box(x, y + 0.02, -0.12, 1, 0.96, 0.12, PAL.plank, PAL.trunk);
        for (let i = 1; i < 4; i++) iso.box(x + i * 0.25 - 0.01, y + 0.02, 0, 0.02, 0.96, 0.005, PAL.trunk);
        continue;
      }
      iso.box(x, y, -0.6, 1, 1, 0.6 + h, top, h > 0 ? PAL.dirt : PAL.dirt);
      if (c === 'G' && (x + y) % 2 === 0) iso.box(x + 0.35, y + 0.35, h, 0.3, 0.3, 0.02, '#ffffff');
    }
  }
}

// The exit: a glowing pad with a gold frame, so it reads from far away.
function drawExit(iso, x, y, t) {
  const glow = 0.85 + Math.sin(t / 220) * 0.15;
  iso.box(x, y, -0.6, 1, 1, 0.6, '#7df9c6', PAL.dirt);
  iso.box(x + 0.15, y + 0.15, 0, 0.7, 0.7, 0.03, glow > 0.9 ? '#ffffff' : '#c6ffe9');
  iso.box(x + 0.05, y + 0.05, 0, 0.1, 0.1, 0.9, '#f2c14e');
  iso.box(x + 0.85, y + 0.85, 0, 0.1, 0.1, 0.9, '#f2c14e');
}

function drawStairs(iso, x, y, h) {
  // Steps go down toward the lower neighbour.
  const low = [[1, 0], [-1, 0], [0, 1], [0, -1]].find(([dx, dy]) => {
    const n = ch(x + dx, y + dy);
    return !isWaterCh(n) && Math.abs(tileHeight(x + dx + 0.5, y + dy + 0.5) - (h - 0.5)) < 0.01;
  }) || [1, 0];
  iso.box(x, y, -0.6, 1, 1, 0.6 + h - 0.5, PAL.stair, PAL.dirt);
  const [dx, dy] = low;
  for (let i = 0; i < 3; i++) {
    const f = (3 - i) / 3; // nearest step to the low side is lowest
    const zTop = h - 0.5 + (0.5 * (i + 1)) / 3;
    const bx = dx > 0 ? x : dx < 0 ? x + 1 - f : x;
    const by = dy > 0 ? y : dy < 0 ? y + 1 - f : y;
    const bw = dx ? f : 1, bd = dy ? f : 1;
    iso.box(bx, by, h - 0.5, bw, bd, zTop - (h - 0.5), PAL.stair, '#bdb3a2');
  }
}

/** Static objects (trees, rocks, bushes, fences) as drawables: { key, draw(iso) }. */
export function staticObjects() {
  const out = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = MAP[y][x];
      const h = tileHeight(x + 0.5, y + 0.5);
      const key = x + y + 1;
      const tx = x, ty = y;
      if (c === 'T') {
        const tall = ((x * 7 + y * 13) % 3) * 0.18;
        out.push({ key, x: tx, y: ty, draw: (iso, a = 1) => {
          iso.box(tx + 0.4, ty + 0.4, h, 0.2, 0.2, 0.45, PAL.trunk, PAL.trunk, a);
          iso.box(tx + 0.15, ty + 0.15, h + 0.45, 0.7, 0.7, 0.45 + tall, PAL.leaf, PAL.leaf, a);
          iso.box(tx + 0.27, ty + 0.27, h + 0.9 + tall, 0.46, 0.46, 0.3, PAL.leaf2, PAL.leaf2, a);
        } });
      } else if (c === 'R') {
        out.push({ key, x: tx, y: ty, draw: (iso, a = 1) => {
          iso.box(tx + 0.15, ty + 0.2, h, 0.7, 0.6, 0.4, PAL.rock, PAL.rock, a);
          iso.box(tx + 0.3, ty + 0.3, h + 0.4, 0.35, 0.35, 0.18, '#b4b9bf', '#b4b9bf', a);
        } });
      } else if (c === 'b') {
        out.push({ key, x: tx, y: ty, draw: (iso, a = 1) => {
          iso.box(tx + 0.15, ty + 0.15, h, 0.7, 0.7, 0.4, PAL.bush, PAL.bush, a);
          iso.box(tx + 0.5, ty + 0.25, h + 0.4, 0.2, 0.2, 0.1, '#ff6b8a', '#ff6b8a', a);
        } });
      } else if (c === 'F') {
        const along = ch(x - 1, y) === 'F' || ch(x + 1, y) === 'F';
        out.push({ key, x: tx, y: ty, draw: (iso, a = 1) => {
          if (along) {
            iso.box(tx + 0.05, ty + 0.45, h, 0.12, 0.12, 0.6, PAL.fence, PAL.fence, a);
            iso.box(tx + 0.55, ty + 0.45, h, 0.12, 0.12, 0.6, PAL.fence, PAL.fence, a);
            iso.box(tx, ty + 0.47, h + 0.18, 1, 0.08, 0.1, PAL.fence, PAL.fence, a);
            iso.box(tx, ty + 0.47, h + 0.42, 1, 0.08, 0.1, PAL.fence, PAL.fence, a);
          } else {
            iso.box(tx + 0.45, ty + 0.05, h, 0.12, 0.12, 0.6, PAL.fence, PAL.fence, a);
            iso.box(tx + 0.45, ty + 0.55, h, 0.12, 0.12, 0.6, PAL.fence, PAL.fence, a);
            iso.box(tx + 0.47, ty, h + 0.18, 0.08, 1, 0.1, PAL.fence, PAL.fence, a);
            iso.box(tx + 0.47, ty, h + 0.42, 0.08, 1, 0.1, PAL.fence, PAL.fence, a);
          }
        } });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- voxel models
// Boxes [x, y, z, w, d, h, color] in tile units, feet at (0, 0, 0), facing +x.
const box = (x, y, z, w, d, h, c) => [x, y, z, w, d, h, c];
const eyes = (fx, y0, z, c = '#1d1d1d', s = 0.06) => [box(fx, -y0 - s, z, 0.02, s, s, c), box(fx, y0, z, 0.02, s, s, c)];

export const MODELS = {
  chick: [
    box(-0.05, -0.1, 0, 0.08, 0.05, 0.08, '#ff9f1c'), box(-0.05, 0.05, 0, 0.08, 0.05, 0.08, '#ff9f1c'),
    box(-0.22, -0.2, 0.08, 0.44, 0.4, 0.42, '#ffe14d'),
    box(0.22, -0.06, 0.26, 0.1, 0.12, 0.07, '#ff9f1c'),
    box(-0.06, -0.05, 0.5, 0.16, 0.1, 0.1, '#e63946'),
    ...eyes(0.22, 0.08, 0.36),
  ],
  pig: [
    box(-0.2, -0.18, 0, 0.1, 0.1, 0.1, '#e88aa0'), box(0.1, -0.18, 0, 0.1, 0.1, 0.1, '#e88aa0'),
    box(-0.2, 0.08, 0, 0.1, 0.1, 0.1, '#e88aa0'), box(0.1, 0.08, 0, 0.1, 0.1, 0.1, '#e88aa0'),
    box(-0.26, -0.2, 0.1, 0.52, 0.4, 0.34, '#f7a8b8'),
    box(0.26, -0.09, 0.18, 0.07, 0.18, 0.12, '#f48fa7'),
    box(0.12, -0.2, 0.44, 0.08, 0.08, 0.08, '#e88aa0'), box(0.12, 0.12, 0.44, 0.08, 0.08, 0.08, '#e88aa0'),
    ...eyes(0.26, 0.1, 0.32),
  ],
  rabbit: [
    box(-0.2, -0.17, 0, 0.42, 0.34, 0.34, '#f4f4f4'),
    box(0.12, -0.14, 0.26, 0.2, 0.28, 0.22, '#ffffff'),
    box(0.14, -0.11, 0.48, 0.06, 0.07, 0.26, '#ffffff'), box(0.14, 0.04, 0.48, 0.06, 0.07, 0.26, '#ffffff'),
    box(0.15, -0.09, 0.52, 0.02, 0.03, 0.18, '#f7b6c8'), box(0.15, 0.06, 0.52, 0.02, 0.03, 0.18, '#f7b6c8'),
    box(-0.27, -0.06, 0.12, 0.08, 0.12, 0.12, '#ffffff'),
    ...eyes(0.32, 0.07, 0.36),
  ],
  panda: [
    box(-0.2, -0.18, 0, 0.1, 0.1, 0.12, '#222'), box(0.1, -0.18, 0, 0.1, 0.1, 0.12, '#222'),
    box(-0.2, 0.08, 0, 0.1, 0.1, 0.12, '#222'), box(0.1, 0.08, 0, 0.1, 0.1, 0.12, '#222'),
    box(-0.24, -0.2, 0.12, 0.48, 0.4, 0.36, '#f7f7f7'),
    box(-0.02, -0.21, 0.12, 0.12, 0.42, 0.16, '#222'),
    box(0.04, -0.2, 0.48, 0.1, 0.1, 0.1, '#222'), box(0.04, 0.1, 0.48, 0.1, 0.1, 0.1, '#222'),
    box(0.24, -0.15, 0.3, 0.02, 0.1, 0.1, '#222'), box(0.24, 0.05, 0.3, 0.02, 0.1, 0.1, '#222'),
    box(0.26, -0.13, 0.33, 0.01, 0.04, 0.04, '#fff'), box(0.26, 0.09, 0.33, 0.01, 0.04, 0.04, '#fff'),
  ],
  fox: [
    box(-0.2, -0.16, 0, 0.08, 0.08, 0.12, '#3a2a20'), box(0.12, -0.16, 0, 0.08, 0.08, 0.12, '#3a2a20'),
    box(-0.2, 0.08, 0, 0.08, 0.08, 0.12, '#3a2a20'), box(0.12, 0.08, 0, 0.08, 0.08, 0.12, '#3a2a20'),
    box(-0.24, -0.17, 0.12, 0.48, 0.34, 0.26, '#f08a2c'),
    box(0.14, -0.15, 0.28, 0.22, 0.3, 0.2, '#f08a2c'),
    box(0.36, -0.06, 0.28, 0.08, 0.12, 0.08, '#fff3e0'),
    box(0.16, -0.14, 0.48, 0.07, 0.08, 0.12, '#f08a2c'), box(0.16, 0.06, 0.48, 0.07, 0.08, 0.12, '#f08a2c'),
    box(-0.44, -0.07, 0.24, 0.22, 0.14, 0.14, '#f08a2c'), box(-0.5, -0.07, 0.24, 0.07, 0.14, 0.14, '#fff3e0'),
    ...eyes(0.36, 0.08, 0.4),
  ],
  frog: [
    box(-0.24, -0.22, 0, 0.48, 0.44, 0.22, '#4caf50'),
    box(0.02, -0.2, 0.22, 0.14, 0.12, 0.12, '#66cc66'), box(0.02, 0.08, 0.22, 0.14, 0.12, 0.12, '#66cc66'),
    box(0.15, -0.16, 0.26, 0.02, 0.06, 0.06, '#1d1d1d'), box(0.15, 0.12, 0.26, 0.02, 0.06, 0.06, '#1d1d1d'),
    box(0.24, -0.12, 0.08, 0.02, 0.24, 0.03, '#2e7d32'),
    box(-0.3, -0.28, 0, 0.14, 0.1, 0.06, '#388e3c'), box(-0.3, 0.18, 0, 0.14, 0.1, 0.06, '#388e3c'),
  ],
  penguin: [
    box(-0.04, -0.14, 0, 0.12, 0.1, 0.05, '#ff9f1c'), box(-0.04, 0.04, 0, 0.12, 0.1, 0.05, '#ff9f1c'),
    box(-0.18, -0.18, 0.05, 0.36, 0.36, 0.55, '#263238'),
    box(0.16, -0.12, 0.08, 0.03, 0.24, 0.38, '#ffffff'),
    box(0.18, -0.05, 0.44, 0.1, 0.1, 0.06, '#ff9f1c'),
    box(-0.06, -0.24, 0.18, 0.18, 0.06, 0.26, '#263238'), box(-0.06, 0.18, 0.18, 0.18, 0.06, 0.26, '#263238'),
    ...eyes(0.18, 0.06, 0.5, '#ffffff', 0.05),
  ],
  cat: [
    box(-0.2, -0.15, 0, 0.08, 0.08, 0.12, '#7d7d86'), box(0.12, -0.15, 0, 0.08, 0.08, 0.12, '#7d7d86'),
    box(-0.2, 0.07, 0, 0.08, 0.08, 0.12, '#7d7d86'), box(0.12, 0.07, 0, 0.08, 0.08, 0.12, '#7d7d86'),
    box(-0.22, -0.16, 0.12, 0.44, 0.32, 0.24, '#9e9ea8'),
    box(0.1, -0.16, 0.26, 0.24, 0.32, 0.22, '#9e9ea8'),
    box(0.16, -0.15, 0.48, 0.08, 0.08, 0.1, '#9e9ea8'), box(0.16, 0.07, 0.48, 0.08, 0.08, 0.1, '#9e9ea8'),
    box(-0.3, -0.04, 0.3, 0.08, 0.08, 0.28, '#9e9ea8'),
    ...eyes(0.34, 0.08, 0.38, '#2e7d32'),
    box(0.34, -0.03, 0.31, 0.02, 0.06, 0.04, '#f7a8b8'),
  ],
  lion: [
    box(-0.3, -0.2, 0, 0.12, 0.12, 0.22, '#c9963f'), box(0.18, -0.2, 0, 0.12, 0.12, 0.22, '#c9963f'),
    box(-0.3, 0.08, 0, 0.12, 0.12, 0.22, '#c9963f'), box(0.18, 0.08, 0, 0.12, 0.12, 0.22, '#c9963f'),
    box(-0.36, -0.22, 0.22, 0.66, 0.44, 0.32, '#e3b25a'),
    box(0.16, -0.3, 0.18, 0.3, 0.6, 0.56, '#8a4b1f'),
    box(0.36, -0.17, 0.26, 0.2, 0.34, 0.3, '#e3b25a'),
    box(0.56, -0.08, 0.28, 0.06, 0.16, 0.1, '#5a3a20'),
    box(-0.5, -0.04, 0.4, 0.16, 0.08, 0.08, '#e3b25a'), box(-0.56, -0.06, 0.38, 0.08, 0.12, 0.12, '#8a4b1f'),
    ...eyes(0.56, 0.08, 0.44),
  ],
  bear: [
    box(-0.32, -0.24, 0, 0.16, 0.16, 0.2, '#5d3a22'), box(0.16, -0.24, 0, 0.16, 0.16, 0.2, '#5d3a22'),
    box(-0.32, 0.08, 0, 0.16, 0.16, 0.2, '#5d3a22'), box(0.16, 0.08, 0, 0.16, 0.16, 0.2, '#5d3a22'),
    box(-0.38, -0.26, 0.2, 0.72, 0.52, 0.42, '#7b4b2a'),
    box(0.24, -0.2, 0.36, 0.3, 0.4, 0.34, '#7b4b2a'),
    box(0.54, -0.08, 0.4, 0.08, 0.16, 0.12, '#c49a6c'),
    box(0.28, -0.22, 0.7, 0.1, 0.1, 0.1, '#5d3a22'), box(0.28, 0.12, 0.7, 0.1, 0.1, 0.1, '#5d3a22'),
    ...eyes(0.54, 0.1, 0.56),
  ],
  gorilla: [
    box(-0.16, -0.2, 0, 0.14, 0.14, 0.24, '#2b2b2f'), box(-0.16, 0.06, 0, 0.14, 0.14, 0.24, '#2b2b2f'),
    box(-0.24, -0.26, 0.24, 0.42, 0.52, 0.42, '#3a3a40'),
    box(0.1, -0.38, 0.06, 0.16, 0.14, 0.5, '#3a3a40'), box(0.1, 0.24, 0.06, 0.16, 0.14, 0.5, '#3a3a40'),
    box(0.02, -0.14, 0.66, 0.28, 0.28, 0.26, '#3a3a40'),
    box(0.3, -0.1, 0.68, 0.06, 0.2, 0.14, '#6d6d75'),
    ...eyes(0.3, 0.06, 0.82, '#f2c14e', 0.05),
  ],
  robot: [
    box(-0.24, -0.26, 0, 0.48, 0.12, 0.14, '#333'), box(-0.24, 0.14, 0, 0.48, 0.12, 0.14, '#333'),
    box(-0.22, -0.2, 0.12, 0.44, 0.4, 0.4, '#c7ced6'),
    box(0.22, -0.12, 0.22, 0.02, 0.24, 0.12, '#ff5252'),
    box(-0.14, -0.14, 0.52, 0.3, 0.28, 0.22, '#dfe5ea'),
    box(0.16, -0.12, 0.58, 0.02, 0.24, 0.08, '#29e3ff'),
    box(-0.02, -0.02, 0.74, 0.04, 0.04, 0.16, '#777'), box(-0.04, -0.04, 0.9, 0.08, 0.08, 0.08, '#ff3b3b'),
    box(-0.03, -0.32, 0.26, 0.1, 0.1, 0.24, '#9aa3ab'), box(-0.03, 0.22, 0.26, 0.1, 0.1, 0.24, '#9aa3ab'),
  ],
  croc: [
    box(-0.5, -0.18, 0, 0.9, 0.36, 0.18, '#3d8b37'),
    box(0.4, -0.13, 0, 0.32, 0.26, 0.1, '#4ea345'),
    box(0.18, -0.15, 0.18, 0.1, 0.1, 0.08, '#4ea345'), box(0.18, 0.05, 0.18, 0.1, 0.1, 0.08, '#4ea345'),
    box(0.25, -0.13, 0.2, 0.03, 0.06, 0.05, '#f2e14e'), box(0.25, 0.07, 0.2, 0.03, 0.06, 0.05, '#f2e14e'),
    box(-0.72, -0.08, 0, 0.24, 0.16, 0.12, '#3d8b37'),
    box(0.6, -0.12, 0.1, 0.1, 0.02, 0.03, '#ffffff'), box(0.6, 0.1, 0.1, 0.1, 0.02, 0.03, '#ffffff'),
  ],
};

// 8 facings (0 = +x, counter-clockwise by 45°) snapped to the 4 axis rotations of the boxes.
function rotate(b, quarter) {
  const [x, y, z, w, d, h, c] = b;
  switch (quarter) {
    case 1: return [-(y + d), x, z, d, w, h, c];        // +y
    case 2: return [-(x + w), -(y + d), z, w, d, h, c]; // -x
    case 3: return [y, -(x + w), z, d, w, h, c];        // -y
    default: return b;
  }
}
/** A model standing at world (x, y) on ground height g, lifted by z. scale > 1 makes it bigger. */
export function drawModel(iso, name, x, y, g, z, face, { alpha = 1, scale = 1, squash = 1 } = {}) {
  // The model's boxes, turned with the view, then back to front in the view.
  const quarter = Math.round(((face ?? 0) % 8) / 2) % 4;
  const boxes = MODELS[name].map((b) => rotate(rotate(b, quarter), iso.turn));
  boxes.sort((a, b) => (a[0] + a[3] / 2 + a[1] + a[4] / 2) - (b[0] + b[3] / 2 + b[1] + b[4] / 2) || a[2] - b[2]);
  const [vx, vy] = iso.toView(x, y);
  for (const [bx, by, bz, w, d, h, c] of boxes) {
    iso.vbox(vx + bx * scale, vy + by * scale, g + z + bz * scale * squash, w * scale, d * scale, h * scale * squash, c, c, alpha);
  }
}
