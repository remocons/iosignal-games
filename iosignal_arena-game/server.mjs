import { version } from 'iosignal';
import { startArena, lanAddresses } from './src/arena-server.mjs';

const PORT = Number(process.env.PORT || 5178);
// CONG_PORT=off opens no TCP port for Arduino controllers (browsers only).
const CONG_PORT = process.env.CONG_PORT === 'off' ? null : Number(process.env.CONG_PORT || 55488);
// HOST=127.0.0.1 keeps the port private behind a proxy (lab.iosignal.net/games/<name>/ runs it that way).
const HOST = process.env.HOST || undefined;
const PUBLIC_URL = process.env.PUBLIC_URL || undefined; // e.g. https://lab.iosignal.net/games/arena/ for the QR code

// DASHBOARD=off turns the status page off; DASHBOARD_TOKEN=... asks viewers for that token (8+ characters).
const dashboard = process.env.DASHBOARD === 'off' ? false
  : process.env.DASHBOARD_TOKEN ? { access: { token: process.env.DASHBOARD_TOKEN } } : true;
const arena = await startArena({ port: PORT, listenHost: HOST, publicUrl: PUBLIC_URL, congPort: CONG_PORT, dashboard });
const lan = lanAddresses();

console.log(`\nIOSignal ${version} — Arena`);
console.log(`  Web app      http://localhost:${arena.port}`);
console.log(`  Watch screen http://localhost:${arena.port}/?watch`);
console.log(`  WebSocket    ws://localhost:${arena.port}/ws`);
console.log(`  Arduino TCP  port ${arena.congPort}`);
if (dashboard) console.log(`  Dashboard    http://localhost:${arena.port}/dashboard${dashboard.access ? '   (token)' : ''}`);
for (const ip of lan) console.log(`  LAN          http://${ip}:${arena.port}   (Arduino SERVER_HOST "${ip}")`);
console.log('');

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log('\nShutting down...');
  await arena.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
