import { version } from 'iosignal';
import { startBump, lanAddresses } from './src/bump-server.mjs';

// HOST=127.0.0.1 keeps the port private behind a proxy (lab.iosignal.net/games/<name>/ runs it that way).
const HOST = process.env.HOST || undefined;
const PUBLIC_URL = process.env.PUBLIC_URL || undefined; // e.g. https://lab.iosignal.net/games/<name>/ for the QR code
const PORT = Number(process.env.PORT || 5192);
// DASHBOARD=off turns the status page off; DASHBOARD_TOKEN=... asks viewers for that token (8+ characters).
const dashboard = process.env.DASHBOARD === 'off' ? false
  : process.env.DASHBOARD_TOKEN ? { access: { token: process.env.DASHBOARD_TOKEN } } : true;
const bump = await startBump({ listenHost: HOST, publicUrl: PUBLIC_URL, port: PORT, dashboard });
const lan = lanAddresses()[0];

console.log(`
IOSignal ${version} — 범퍼카 (Bumper Cars)
  Play (phone)   http://localhost:${bump.port}${lan ? `   LAN http://${lan}:${bump.port}` : ''}
  Big screen     http://localhost:${bump.port}/?watch
  WebSocket      ws://localhost:${bump.port}/ws${dashboard ? `
  Dashboard      http://localhost:${bump.port}/dashboard${dashboard.access ? '   (token)' : ''}` : ''}
`);

const stop = async () => { await bump.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
