// Spawn simple bot players so one person can try the multiplayer game.
//   npm run bots            -> 3 bots on ws://localhost:5178/ws
//   node scripts/bots.mjs 5 ws://192.168.0.10:5178/ws
// Bots are ordinary IOSignal clients that send the same TEXT input as everyone else.

import { IO } from 'iosignal';
import { TAGS, COLS, ROWS, DIRS, S, isWall } from '../public/protocol.js';

const COUNT = Number(process.argv[2] || 3);
const URL = process.argv[3] || 'ws://localhost:5178/ws';
const NAMES = ['봇토리', '삐약', '두더지', '뭉치', '번개', '콩떡', '호두', '구름'];

/** BFS: first step direction from (sx,sy) toward the nearest cell where goal(x,y) is true. */
function firstStep(map, sx, sy, goal, blocked) {
  const prev = new Map();
  const start = sy * COLS + sx;
  const queue = [start];
  prev.set(start, null);
  while (queue.length) {
    const c = queue.shift();
    const x = c % COLS, y = (c - x) / COLS;
    if (c !== start && goal(x, y)) {
      let cur = c;
      while (prev.get(cur) !== start) cur = prev.get(cur);
      const cx = cur % COLS, cy = (cur - cx) / COLS;
      return Object.keys(DIRS).find((k) => sx + DIRS[k][0] === cx && sy + DIRS[k][1] === cy);
    }
    for (const [dx, dy] of Object.values(DIRS)) {
      const nx = x + dx, ny = y + dy, n = ny * COLS + nx;
      if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS || prev.has(n) || isWall(map, nx, ny)) continue;
      if (blocked(nx, ny) && !goal(nx, ny)) continue;
      prev.set(n, c);
      queue.push(n);
    }
  }
  return null;
}

function bot(i) {
  const io = new IO(URL);
  let snap = null;
  io.on('ready', () => {
    io.subscribe(TAGS.STATE);
    io.signal(TAGS.IN, `J,bot,${NAMES[i % NAMES.length]}`);
  });
  io.on('message', (tag, s) => { if (tag === TAGS.STATE) snap = s; });
  setInterval(() => { if (io.stateName === 'ready') io.signal(TAGS.IN, 'H'); }, 2000);

  setInterval(() => {
    if (!snap || io.stateName !== 'ready' || snap.ph !== 'play') return;
    const me = snap.p.find((p) => p[S.CID] === io.cid);
    if (!me) { io.signal(TAGS.IN, `J,bot,${NAMES[i % NAMES.length]}`); return; }
    const [x, y] = [me[S.X], me[S.Y]];
    const others = snap.p.filter((p) => p !== me);
    const occupied = (cx, cy) => others.some((p) => p[S.X] === cx && p[S.Y] === cy);
    const it = snap.p.find((p) => p[S.CID] === snap.it);
    let dir;
    if (snap.it === io.cid) {
      dir = firstStep(snap.map, x, y, (cx, cy) => occupied(cx, cy), () => false);
      if (Math.random() < 0.08) io.signal(TAGS.IN, 'A');
    } else if (it && Math.abs(it[S.X] - x) + Math.abs(it[S.Y] - y) <= 3) {
      // flee: pick the open neighbour farthest from the tagger
      const opts = Object.entries(DIRS).filter(([, [dx, dy]]) => !isWall(snap.map, x + dx, y + dy) && !occupied(x + dx, y + dy));
      opts.sort((a, b) => {
        const da = Math.abs(it[S.X] - x - a[1][0]) + Math.abs(it[S.Y] - y - a[1][1]);
        const db = Math.abs(it[S.X] - x - b[1][0]) + Math.abs(it[S.Y] - y - b[1][1]);
        return db - da;
      });
      dir = opts[0]?.[0];
    } else {
      const coins = new Set(snap.c);
      dir = firstStep(snap.map, x, y, (cx, cy) => coins.has(cy * COLS + cx), occupied);
    }
    if (Math.random() < 0.15) dir = Object.keys(DIRS)[Math.floor(Math.random() * 4)];
    if (dir) {
      io.signal(TAGS.IN, `D,${dir}`);
      io.signal(TAGS.IN, 'D,0');
    }
  }, 260 + i * 20);
  return io;
}

const bots = Array.from({ length: COUNT }, (_, i) => bot(i));
console.log(`${COUNT} bots -> ${URL} (Ctrl+C to stop)`);
process.on('SIGINT', () => {
  for (const b of bots) { if (b.stateName === 'ready') b.signal(TAGS.IN, 'L'); }
  setTimeout(() => { bots.forEach((b) => b.destroy()); process.exit(0); }, 200);
});
