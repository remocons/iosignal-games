// Performance benchmark for game host <-> client traffic over IOSignal.
//   node scripts/perf.mjs            -> full run (~2 min), prints a report
//   node scripts/perf.mjs --quick    -> smaller load levels
// The arena runs in a child process (scripts/perf-server.mjs) so its CPU and
// event-loop delay are measured apart from these load-generating clients.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { performance } from 'node:perf_hooks';
import { IO, IOCongSocket } from 'iosignal';
import { TAGS, S, DIRS, isWall } from '../public/protocol.js';

const QUICK = process.argv.includes('--quick');
const LEVELS = QUICK
  ? [{ players: 2, watchers: 0 }, { players: 12, watchers: 50 }]
  : [
      { players: 2, watchers: 0 },
      { players: 12, watchers: 0 },
      { players: 12, watchers: 50 },
      { players: 12, watchers: 200 },
      { players: 12, watchers: 500 },
    ];

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 10000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await wait(10); }
  throw new Error('timeout');
};
function stats(a) {
  if (!a.length) return { n: 0 };
  const s = [...a].sort((x, y) => x - y);
  const q = (p) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
  const f = (v) => +v.toFixed(2);
  return { n: s.length, avg: f(s.reduce((x, y) => x + y, 0) / s.length), p50: f(q(50)), p95: f(q(95)), p99: f(q(99)), max: f(s[s.length - 1]) };
}
const fmt = (s) => (s.n ? `avg ${s.avg}  p50 ${s.p50}  p95 ${s.p95}  p99 ${s.p99}  max ${s.max}  (n=${s.n})` : 'no samples');

// ---------------------------------------------------------------- server
const child = spawn(process.execPath, [new URL('./perf-server.mjs', import.meta.url).pathname], { stdio: ['ignore', 'pipe', 'inherit'] });
let metrics = [];
const { port, congPort } = await new Promise((resolve, reject) => {
  createInterface({ input: child.stdout }).on('line', (line) => {
    if (line.startsWith('READY ')) { const [, p, c] = line.split(' '); resolve({ port: +p, congPort: +c }); }
    else if (line.startsWith('{')) metrics.push(JSON.parse(line));
  });
  child.on('exit', (code) => reject(new Error(`server exited ${code}`)));
});
const WS = `ws://127.0.0.1:${port}/ws`;
const all = [];
async function ws() { const c = new IO(WS); all.push(c); await until(() => c.stateName === 'ready'); return c; }
async function cong() { const c = new IOCongSocket(`cong://127.0.0.1:${congPort}`); all.push(c); await until(() => c.stateName === 'ready'); return c; }

const report = [];
const out = (s = '') => { console.log(s); report.push(s); };

// ---------------------------------------------------------------- 1. raw relay
// One-way time of a direct signal "<cid>@bench" through the IOSignal server (no game host).
async function relay(label, from, to, n = 400, gapMs = 5) {
  const lat = [];
  const onMsg = (_tag, data) => lat.push(performance.now() - Number(data));
  to.on('@bench', onMsg); // direct signals are emitted by tag, not as 'message'
  for (let i = 0; i < n; i++) { from.signal(`${to.cid}@bench`, String(performance.now())); await wait(gapMs); }
  await wait(300);
  to.removeListener('@bench', onMsg);
  out(`  ${label.padEnd(22)} ${fmt(stats(lat))}`);
  return stats(lat);
}

// Burst throughput: how many signals/s one sender can push through to one receiver.
async function throughput(label, from, to, n = 20000) {
  let got = 0, last = 0;
  const onMsg = () => { got++; last = performance.now(); };
  to.on('@tp', onMsg);
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    from.signal(`${to.cid}@tp`, 'x');
    if (i % 500 === 499) await wait(0);
  }
  await until(() => got >= n, 30000).catch(() => {});
  to.removeListener('@tp', onMsg);
  out(`  ${label.padEnd(22)} ${Math.round(got / ((last - t0) / 1000))} msg/s  (${got}/${n} delivered)`);
}

// ---------------------------------------------------------------- 2. game load
// Random-walk players that send the same TEXT input as the web client.
function startPlayer(io, kind = 'bot') {
  let snap = null;
  io.on('message', (tag, s) => { if (tag === TAGS.STATE) snap = s; });
  io.subscribe(TAGS.STATE);
  io.signal(TAGS.IN, `J,${kind},p${io.cid.slice(-3)}`);
  const keys = Object.keys(DIRS);
  const send = (text) => { if (io.stateName === 'ready') io.signal(TAGS.IN, text); };
  const t1 = setInterval(() => send('H'), 2000);
  const t2 = setInterval(() => {
    const d = keys[Math.floor(Math.random() * 4)];
    send(`D,${d}`);
    setTimeout(() => send('D,0'), 100);
  }, 250 + Math.random() * 100);
  return () => { clearInterval(t1); clearInterval(t2); };
}

// Measurer: press a direction and time until a snapshot shows us on the new cell.
async function inputToSnapshot(io, samples) {
  let snap = null;
  let arrivals = [];
  let bytes = 0;
  let waiter = null; // { x0, y0, resolve }: resolved by the first snapshot that shows the move
  io.on('message', (tag, s) => {
    if (tag !== TAGS.STATE) return;
    const t = performance.now();
    snap = s;
    arrivals.push(t);
    bytes = Buffer.byteLength(JSON.stringify(s));
    const m = waiter && s.p.find((p) => p[S.CID] === io.cid);
    if (m && (m[S.X] !== waiter.x0 || m[S.Y] !== waiter.y0)) { waiter.resolve(t); waiter = null; }
  });
  io.subscribe(`${TAGS.STATE},${TAGS.EVT}`);
  io.signal(TAGS.IN, 'J,web,measure');
  const hb = setInterval(() => io.signal(TAGS.IN, 'H'), 2000);
  await until(() => snap?.p.some((p) => p[S.CID] === io.cid));
  arrivals = [];
  const lat = [];
  const meNow = () => snap.p.find((p) => p[S.CID] === io.cid);
  let tries = 0;
  while (lat.length < samples && tries++ < samples * 4) {
    await wait(180 + Math.random() * 60); // past STEP_MS so the next press may move at once
    const m = meNow();
    if (!m || snap.ph !== 'play' || (m[S.FLAGS] & 2)) continue; // missing / round end / stunned
    const open = Object.entries(DIRS).filter(([, [dx, dy]]) => !isWall(snap.map, m[S.X] + dx, m[S.Y] + dy)
      && !snap.p.some((o) => o[S.X] === m[S.X] + dx && o[S.Y] === m[S.Y] + dy));
    if (!open.length) continue;
    const [d] = open[Math.floor(Math.random() * open.length)];
    const [x0, y0] = [m[S.X], m[S.Y]];
    const moved = new Promise((resolve) => { waiter = { x0, y0, resolve }; });
    const t0 = performance.now();
    io.signal(TAGS.IN, `D,${d}`);
    io.signal(TAGS.IN, 'D,0');
    const t1 = await Promise.race([moved, wait(1000).then(() => null)]);
    waiter = null;
    if (t1) lat.push(t1 - t0); // else blocked by someone moving in: skip
  }
  clearInterval(hb);
  const gaps = arrivals.slice(1).map((t, i) => t - arrivals[i]);
  const rate = arrivals.length > 1 ? (arrivals.length - 1) / ((arrivals[arrivals.length - 1] - arrivals[0]) / 1000) : 0;
  return { lat: stats(lat), gaps: stats(gaps), bytes, rate };
}

async function snapshotFanout(watchers) {
  // Spread of arrival times of the same snapshot across all watchers.
  const seen = new Map(); // left(ms) -> [first, last, count]
  const handlers = watchers.map((w) => {
    const h = (tag, s) => {
      if (tag !== TAGS.STATE) return;
      const t = performance.now();
      const k = `${s.left}`;
      const e = seen.get(k);
      if (e) { e[1] = t; e[2]++; } else seen.set(k, [t, t, 1]);
    };
    w.on('message', h);
    return h;
  });
  await wait(3000);
  watchers.forEach((w, i) => w.removeListener('message', handlers[i]));
  const spread = [...seen.values()].filter((e) => e[2] === watchers.length).map((e) => e[1] - e[0]);
  return stats(spread);
}

try {
  out(`# IOSignal Arena performance  (${new Date().toISOString()}, node ${process.version}, ${QUICK ? 'quick' : 'full'}${process.env.SNAPSHOT_MIN_MS ? `, SNAPSHOT_MIN_MS=${process.env.SNAPSHOT_MIN_MS}` : ''})`);
  out('');
  out('## 1. Raw IOSignal relay (direct signal, one-way ms, idle server)');
  const a = await ws(), b = await ws(), c = await cong();
  await relay('WS -> WS', a, b);
  await relay('WS -> TCP(Cong)', a, c);
  await relay('TCP(Cong) -> WS', c, a);
  await relay('WS -> WS (burst, 0ms)', a, b, 400, 0);
  out('');
  out('## 2. Raw relay throughput (1 sender -> 1 receiver, TEXT "x")');
  await throughput('WS -> WS', a, b);
  await throughput('TCP(Cong) -> WS', c, a, 5000);
  out('');

  out('## 3. Game loop under load');
  out('input->snapshot = press a key until a STATE snapshot shows the move (includes 0-66ms snapshot wait)');
  const players = [];
  const watchers = [];
  const stops = [];
  const measurer = await ws();
  const results = [];
  for (const lv of LEVELS) {
    while (players.length < lv.players - 1) { const p = await ws(); stops.push(startPlayer(p)); players.push(p); }
    while (watchers.length < lv.watchers) {
      const batch = await Promise.all(Array.from({ length: Math.min(50, lv.watchers - watchers.length) }, ws));
      batch.forEach((w) => w.subscribe(`${TAGS.STATE},${TAGS.EVT}`));
      watchers.push(...batch);
    }
    await wait(1500);
    metrics = [];
    const r = await inputToSnapshot(measurer, QUICK ? 25 : 50);
    const fan = watchers.length ? await snapshotFanout(watchers) : { n: 0 };
    const direct = [];
    const ping = (_tag, data) => direct.push(performance.now() - Number(data));
    b.on('@bench', ping);
    for (let i = 0; i < 100; i++) { a.signal(`${b.cid}@bench`, String(performance.now())); await wait(10); }
    await wait(200);
    b.removeListener('@bench', ping);
    const m = metrics.slice(1);
    const avg = (k) => (m.length ? +(m.reduce((s, x) => s + x[k], 0) / m.length).toFixed(2) : 0);
    const peak = (k) => (m.length ? Math.max(...m.map((x) => x[k])) : 0);
    const row = {
      ...lv,
      clients: lv.players + lv.watchers + 3,
      inputP50: r.lat.p50, inputP95: r.lat.p95, inputMax: r.lat.max,
      gapP50: r.gaps.p50, gapP99: r.gaps.p99, gapMax: r.gaps.max,
      fanP50: fan.p50 ?? '-', fanMax: fan.max ?? '-',
      directP50: stats(direct).p50, directP99: stats(direct).p99,
      cpu: avg('cpu'), eldP99: peak('eldP99'), snapMs: avg('snapMs'), snapBytes: r.bytes,
      rate: +r.rate.toFixed(1),
      outKBs: Math.round((r.bytes * (lv.players + lv.watchers) * r.rate) / 1024), // subscribers = players + watchers
    };
    results.push(row);
    out('');
    out(`### players ${lv.players}, watchers ${lv.watchers}`);
    out(`  input -> snapshot     ${fmt(r.lat)}`);
    out(`  snapshot interval     ${fmt(r.gaps)}  (target 66)`);
    out(`  fan-out spread        ${fmt(fan)}  (first -> last watcher, same snapshot)`);
    out(`  direct relay          ${fmt(stats(direct))}`);
    out(`  server cpu ${row.cpu}%  eventloop p99 ${row.eldP99}ms  snapshot build+JSON ${row.snapMs}ms  snapshot ${r.bytes}B x ${row.rate}/s  ~${row.outKBs} KB/s out`);
  }
  stops.forEach((s) => s());

  out('');
  out('## Summary');
  out('| players | watchers | input→snap p50 / p95 (ms) | snap interval p50 / p99 | snap/s | fan-out spread max | relay p50 / p99 | server CPU | ELD p99 | snapshot B | out KB/s |');
  out('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    out(`| ${r.players} | ${r.watchers} | ${r.inputP50} / ${r.inputP95} | ${r.gapP50} / ${r.gapP99} | ${r.rate} | ${r.fanMax} | ${r.directP50} / ${r.directP99} | ${r.cpu}% | ${r.eldP99} | ${r.snapBytes} | ${r.outKBs} |`);
  }
} finally {
  all.forEach((c) => { try { c.destroy?.(); c.close?.(); } catch {} });
  child.kill('SIGTERM');
  setTimeout(() => process.exit(0), 500).unref();
}
