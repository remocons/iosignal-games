// 동물원 생존하기 server, one process:
//   1) HTTP static server for the web app (public/) and /vendor/io.js (IOSignal browser bundle)
//   2) IOSignal Server: WebSocket /ws for browsers, TCP congPort for Arduino, status page /dashboard
//   3) Game host server.host('zoo'): the game inside the IOSignal server. Inputs on TAGS.IN reach
//      only the host, each with the sender's CID as the server knows it; clients cannot send the
//      host's output tags. The rules are in src/game.mjs.

import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Server, version } from 'iosignal';
import QRCode from 'qrcode';
import { createGameKit, lanAddresses } from '../../game-kit/server.mjs';
import { ZooGame } from './game.mjs';
import { TAGS, RULES, STAGE, STAGES } from '../public/shared.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const VENDOR_IO = createRequire(import.meta.url).resolve('iosignal/browser/iife/io.js');
const WS_PATH = '/ws';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png',
};

export { lanAddresses };

/**
 * port / congPort 0 = any free port (tests). dashboard: false, true or iosignal dashboard options.
 * Resolves with { port, congPort, game, host, ioServer, close() }.
 */
export async function startZoo({ listenHost, publicUrl, port = 5190, congPort = 55490, log = console.log, stage = 0, game = new ZooGame({ stage }), dashboard = true } = {}) {
  let ioServer;
  const httpServer = http.createServer(async (req, res) => {
    if (ioServer?.dashboard?.handle(req, res)) return; // /dashboard and /dashboard/io.js
    try {
      const { pathname } = new URL(req.url || '/', 'http://localhost');
      if (await kit.handle(pathname, res)) return; // join, qr.svg, kit/* (IOSignal game kit)
      if (pathname === '/healthz') {
        const c = ioServer.stats().counters;
        res.writeHead(200, { 'Content-Type': MIME['.json'] });
        res.end(JSON.stringify({
          ok: true, iosignal: version, players: game.players.size, mines: game.mines.length,
          host: { inbound: c.hostInbound, denied: c.hostDenied, rejected: c.hostRejected },
        }));
        return;
      }
      const file = pathname === '/vendor/io.js' ? VENDOR_IO
        : path.join(PUBLIC_DIR, decodeURIComponent(pathname === '/' ? '/index.html' : pathname));
      if (file !== VENDOR_IO && !file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); res.end(); return; }
      const data = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(data);
    } catch (err) {
      const notFound = err?.code === 'ENOENT' || err?.code === 'EISDIR';
      if (!notFound) console.error('[http]', err);
      res.writeHead(notFound ? 404 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(notFound ? '404 Not Found' : '500 Internal Server Error');
    }
  });

  // publicUrl: the address players open when the game runs behind a proxy (QR code and join text).
  const kit = createGameKit({ title: '동물원 생존하기', port: () => httpServer.address().port, publicUrl, QRCode, qrColor: '#1d2b3a' });
  ioServer = new Server({ httpServer, wsPath: WS_PATH, congPort, dashboard });
  const ready = new Promise((resolve) => ioServer.once('ready', resolve));
  await new Promise((resolve, reject) => { httpServer.once('error', reject); httpServer.listen(port, listenHost, resolve); });
  await ready;

  // ---------------- game host ----------------
  const host = ioServer.host('zoo', {
    inbound: [TAGS.IN],
    own: [TAGS.STATE, TAGS.ROSTER, TAGS.EVT, TAGS.FX],
  });

  const flush = () => {
    if (game.rosterDirty) {
      game.rosterDirty = false;
      host.publish(TAGS.ROSTER, game.roster());
    }
    const { events, fx } = game.drain();
    for (const evt of events) {
      host.publish(TAGS.EVT, evt);
      if (evt.e === 'join') log(`[zoo] + ${evt.name} (${evt.kind}) ${evt.cid}`);
      if (evt.e === 'leave') log(`[zoo] - ${evt.name} ${evt.cid} (${evt.reason})`);
      if (evt.e === 'die') log(`[zoo] ✝ ${evt.name}: ${evt.how}${evt.by ? ' by ' + evt.by : ''}`);
    }
    for (const [cid, word] of fx) host.to(cid, TAGS.FX.slice(1), word); // the device receives "@fx"
  };

  // from.cid: the sender as the server knows it. The text holds only "OP,args".
  host.on('message', (from, tag, payload) => {
    game.handleInput(from.cid, typeof payload === 'string' ? payload : String(payload), Date.now());
    flush();
  });
  host.on('leave', (from) => { if (game.leave(from.cid, 'close')) flush(); });
  host.on('error', (err) => log('[zoo] handler error', err?.message || err));
  ioServer.on('host:denied', (remote, tag) => log(`[zoo] dropped ${remote.cid} -> ${tag} (host-owned tag)`));

  // host.loop: like setInterval, and the dashboard shows its tick timing.
  let n = 0;
  host.loop(RULES.TICK_MS, (now) => {
    game.tick(now);
    flush();
    host.publish(TAGS.STATE, game.snapshot(now));
    if (++n % 20 === 0) {
      const players = [...game.players.values()];
      const top = players.slice().sort((a, b) => b.score - a.score)[0];
      host.report({
        area: `${STAGE + 1}. ${STAGES[STAGE].name}`,
        phase: game.phase === 'next' ? '탈출! 다음 공간으로' : '진행 중',
        alive: `${players.filter((p) => p.alive).length}/${players.length}`,
        mines: game.mines.length,
        bots: `${game.bots.filter((b) => b.alive).length}/${game.bots.length}`,
        leader: top ? `${top.name} ${Math.floor(top.score)}` : '-',
      });
    }
  });
  flush(); // the empty retained roster

  const actualPort = httpServer.address().port;
  let closing;
  const close = () => (closing ??= new Promise((resolve) => {
    host.close(); // stops the loop too
    ioServer.close(() => httpServer.close(() => resolve()));
    setTimeout(resolve, 1500).unref();
  }));
  return { port: actualPort, congPort: ioServer.congPort, game, host, ioServer, close };
}
