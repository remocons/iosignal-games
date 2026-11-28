import { version } from 'iosignal';
import { startZoo, lanAddresses } from './src/zoo-server.mjs';
import { serverLimitsFromEnv } from '../game-kit/server.mjs';

// HOST=127.0.0.1 keeps the port private behind a proxy (lab.iosignal.net/games/<name>/ runs it that way).
const HOST = process.env.HOST || undefined;
const PUBLIC_URL = process.env.PUBLIC_URL || undefined; // e.g. https://lab.iosignal.net/games/<name>/ for the QR code
const PORT = Number(process.env.PORT || 5190);
// CONG_PORT=off opens no TCP port for Arduino players (browsers only).
const CONG_PORT = process.env.CONG_PORT === 'off' ? null : Number(process.env.CONG_PORT || 55490);
const STAGE = Number(process.env.STAGE || 1) - 1; // first area, 1-based: STAGE=2 npm start
// DASHBOARD=off turns the status page off; DASHBOARD_TOKEN=... asks viewers for that token (8+ characters).
const dashboard = process.env.DASHBOARD === 'off' ? false
  : process.env.DASHBOARD_TOKEN ? { access: { token: process.env.DASHBOARD_TOKEN } } : true;
// IOSIGNAL_ANON_LIMITS, IOSIGNAL_CONNECTION_LIMITS: limits for a server open to anyone (game-kit); none by default.
const serverOptions = serverLimitsFromEnv();
const zoo = await startZoo({ listenHost: HOST, publicUrl: PUBLIC_URL, port: PORT, congPort: CONG_PORT, stage: STAGE, dashboard, serverOptions });
const lan = lanAddresses()[0];

console.log(`
IOSignal ${version} — 동물원 생존하기 (Zoo Survival)
  Play (phone)   http://localhost:${zoo.port}
  Whole map      http://localhost:${zoo.port}/?watch
  WebSocket      ws://localhost:${zoo.port}/ws
  Arduino TCP    port ${zoo.congPort}${dashboard ? `
  Dashboard      http://localhost:${zoo.port}/dashboard${dashboard.access ? '   (token)' : ''}` : ''}${lan ? `
  LAN            http://${lan}:${zoo.port}   (Arduino SERVER_HOST "${lan}")` : ''}
  Limits         ${serverOptions.quotas ? `anonymous ${JSON.stringify(serverOptions.quotas.anonymous)}` : 'none (IOSIGNAL_ANON_LIMITS)'}${serverOptions.connectionLimits ? `, per address ${JSON.stringify(serverOptions.connectionLimits)}` : ''}
`);

const stop = async () => { await zoo.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
