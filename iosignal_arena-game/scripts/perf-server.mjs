// Arena server for scripts/perf.mjs: runs in its own process so its CPU and
// event-loop delay are measured without the load generator in the way.
// Prints "READY <port> <congPort>" then one JSON metrics line per second.
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { startArena } from '../src/arena-server.mjs';
import { RULES } from '../public/protocol.js';

if (process.env.SNAPSHOT_MIN_MS) RULES.SNAPSHOT_MIN_MS = Number(process.env.SNAPSHOT_MIN_MS); // compare rate caps

// No quotas: since iosignal 10.3.0 a Server limits nothing by default, so the raw relay benchmarks measure IOSignal itself.
const arena = await startArena({ port: 0, congPort: 0, log: () => {} });

// Time the game host's per-snapshot work (build object + JSON encode inside IOSignal).
const game = arena.game;
const origSnapshot = game.snapshot.bind(game);
let snapNs = 0, snapCount = 0, snapBytes = 0;
game.snapshot = (now) => {
  const t = performance.now();
  const s = origSnapshot(now);
  snapBytes = Buffer.byteLength(JSON.stringify(s));
  snapNs += performance.now() - t;
  snapCount++;
  return s;
};

const eld = monitorEventLoopDelay({ resolution: 5 });
eld.enable();
let lastCpu = process.cpuUsage();
let lastT = performance.now();
console.log(`READY ${arena.port} ${arena.congPort}`);

setInterval(() => {
  const cpu = process.cpuUsage(lastCpu);
  const t = performance.now();
  const ms = t - lastT;
  console.log(JSON.stringify({
    cpu: +(((cpu.user + cpu.system) / 1000 / ms) * 100).toFixed(1),
    eldP50: +(eld.percentile(50) / 1e6).toFixed(2),
    eldP99: +(eld.percentile(99) / 1e6).toFixed(2),
    eldMax: +(eld.max / 1e6).toFixed(2),
    rssMB: +(process.memoryUsage().rss / 1048576).toFixed(1),
    players: game.players.size,
    snapMs: snapCount ? +(snapNs / snapCount).toFixed(3) : 0,
    snapBytes,
  }));
  eld.reset();
  lastCpu = process.cpuUsage();
  lastT = t;
  snapNs = 0; snapCount = 0;
}, 1000);

process.on('SIGTERM', async () => { await arena.close(); process.exit(0); });
