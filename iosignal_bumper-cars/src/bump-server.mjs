// 범퍼카 server, one process:
//   1) HTTP static server for the web app (public/), /vendor/io.js, the join address and QR code
//   2) IOSignal Server: WebSocket /ws, and its status page /dashboard (iosignal 9.14.0)
//   3) Game host server.host('bump'): the rink inside the IOSignal server. Inputs on TAGS.IN reach
//      only the host, each with the sender's CID as the server knows it; clients cannot send the
//      host's output tags. Physics and scoring are in src/game.mjs.

import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Server, version } from 'iosignal';
import QRCode from 'qrcode';
import { createGameKit, lanAddresses } from '../../game-kit/server.mjs';
import { BumperGame } from './game.mjs';
import { TAGS, RULES } from '../public/shared.js';

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
 * port 0 = any free port (tests). dashboard: false, true or iosignal dashboard options.
 * Resolves with { port, game, host, ioServer, close() }.
 */
export async function startBump({ listenHost, publicUrl, port = 5192, log = console.log, game = new BumperGame(), dashboard = true } = {}) {
  let ioServer;
  // publicUrl: the address players open when the game runs behind a proxy (QR code and join text).
  const kit = createGameKit({ title: '범퍼카', port: () => httpServer.address().port, publicUrl, QRCode, qrColor: '#1b1d3a' });
  const httpServer = http.createServer(async (req, res) => {
    if (ioServer?.dashboard?.handle(req, res)) return; // /dashboard and /dashboard/io.js
    try {
      const { pathname } = new URL(req.url || '/', 'http://localhost');
      if (await kit.handle(pathname, res)) return; // join, qr.svg, kit/* (IOSignal game kit)
      if (pathname === '/healthz') {
        const c = ioServer.stats().counters;
        res.writeHead(200, { 'Content-Type': MIME['.json'] });
        res.end(JSON.stringify({
          ok: true, iosignal: version, cars: game.cars.size, phase: game.phase,
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

  ioServer = new Server({ httpServer, wsPath: WS_PATH, dashboard });
  const ready = new Promise((resolve) => ioServer.once('ready', resolve));
  await new Promise((resolve, reject) => { httpServer.once('error', reject); httpServer.listen(port, listenHost, resolve); });
  await ready;

  // ---------------- game host ----------------
  const host = ioServer.host('bump', { inbound: [TAGS.IN], own: [TAGS.STATE, TAGS.ROSTER, TAGS.EVT] });

  const flush = () => {
    if (game.rosterDirty) {
      game.rosterDirty = false;
      host.publish(TAGS.ROSTER, game.roster());
    }
    const ev = game.drain();
    if (ev.length) host.publish(TAGS.EVT, { ev }); // one message per step, however many crashes
    for (const e of ev) {
      if (e.e === 'join' && e.kind !== 'bot') log(`[bump] + ${e.name} ${e.id}`);
      if (e.e === 'leave' && e.reason !== 'room') log(`[bump] - ${e.name} ${e.id} (${e.reason})`);
    }
  };

  // from.cid: the sender as the server knows it. The text holds only "OP,args".
  host.on('message', (from, tag, payload) => {
    game.handleInput(from.cid, typeof payload === 'string' ? payload : String(payload), Date.now());
  });
  host.on('leave', (from) => { game.leave(from.cid, 'close'); });
  host.on('error', (err) => log('[bump] handler error', err?.message || err));
  ioServer.on('host:denied', (remote, tag) => log(`[bump] dropped ${remote.cid} -> ${tag} (host-owned tag)`));

  // host.loop: like setInterval, and the dashboard shows its tick timing.
  let n = 0;
  host.loop(RULES.TICK_MS, (now) => {
    game.step(now);
    flush();
    if (++n % RULES.SNAP_EVERY === 0) host.publish(TAGS.STATE, game.snapshot(now));
    if (n % 30 === 0) {
      const top = game.ranking()[0];
      const cars = [...game.cars.values()];
      host.report({
        phase: game.phase === 'play' ? '경기 중' : '결과',
        left: `${Math.ceil(Math.max(0, (game.phase === 'play' ? game.roundEnds : game.resultEnds) - now) / 1000)}초`,
        players: cars.filter((c) => c.kind !== 'bot').length,
        bots: cars.filter((c) => c.kind === 'bot').length,
        leader: top ? `${top.name} ${top.score}` : '-',
      });
    }
  });
  flush();

  const actualPort = httpServer.address().port;
  let closing;
  const close = () => (closing ??= new Promise((resolve) => {
    host.close(); // stops the loop too
    ioServer.close(() => httpServer.close(() => resolve()));
    setTimeout(resolve, 1500).unref();
  }));
  return { port: actualPort, game, host, ioServer, close };
}
