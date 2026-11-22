import { version } from 'iosignal';
import { startStar } from './src/star-server.mjs';
import { lanAddresses } from '../game-kit/server.mjs';

const PORT = Number(process.env.PORT || 5201);
const HOST = process.env.HOST || undefined;             // HOST=127.0.0.1 behind a proxy
const PUBLIC_URL = process.env.PUBLIC_URL || undefined; // the address in the QR code behind a proxy

const star = await startStar({ port: PORT, listenHost: HOST, publicUrl: PUBLIC_URL });
const lan = lanAddresses()[0];
console.log(`
IOSignal ${version} — Star Chase
  Play       http://localhost:${star.port}${lan ? `
  Phones     http://${lan}:${star.port}   (same Wi-Fi, or scan the QR from 📱 참여하기)` : ''}
`);

const stop = async () => { await star.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
