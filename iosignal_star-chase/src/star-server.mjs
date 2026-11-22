// Star Chase server, one process:
//   1) HTTP: the page (public/), the IOSignal browser client (/vendor/io.js) and the game kit (join, qr.svg, kit/*)
//   2) IOSignal Server on the same port, WebSocket /ws
//   3) Game host server.host('star'): the only place that judges. The rules are in src/game.mjs.
import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Server } from 'iosignal';
import QRCode from 'qrcode';
import { createGameKit } from '../../game-kit/server.mjs';
import { StarGame } from './game.mjs';
import { TAGS, RULES } from '../public/shared.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const VENDOR_IO = createRequire(import.meta.url).resolve('iosignal/browser/iife/io.js');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

/** port 0 = any free port (tests). publicUrl: the address players open behind a proxy (QR code). */
export async function startStar({ port = 5201, listenHost, publicUrl, game = new StarGame() } = {}) {
  const kit = createGameKit({ title: 'Star Chase', port: () => httpServer.address().port, publicUrl, QRCode });
  const httpServer = http.createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url || '/', 'http://localhost');
      if (await kit.handle(pathname, res)) return;
      const file = pathname === '/vendor/io.js' ? VENDOR_IO
        : path.join(PUBLIC_DIR, decodeURIComponent(pathname === '/' ? '/index.html' : pathname));
      if (file !== VENDOR_IO && !file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); res.end(); return; }
      const data = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(data);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
    }
  });

  const server = new Server({ httpServer, wsPath: '/ws' });
  const ready = new Promise((resolve) => server.once('ready', resolve));
  await new Promise((resolve, reject) => { httpServer.once('error', reject); httpServer.listen(port, listenHost, resolve); });
  await ready;

  // inbound: only the host receives it, with the sender's CID. own: only the host may send these.
  const host = server.host('star', { inbound: [TAGS.IN], own: [TAGS.STATE, TAGS.ROSTER, '@' + TAGS.YOU] });
  const flush = () => {
    if (game.rosterDirty) { game.rosterDirty = false; host.publish(TAGS.ROSTER, game.roster()); }
    for (const [cid, result] of game.results) host.to(cid, TAGS.YOU, result); // arrives as '@star.you'
    game.results = [];
  };
  // from.cid is the sender as the server knows it. Never trust a CID inside the payload.
  host.on('message', (from, tag, text) => { game.input(from.cid, String(text), Date.now()); flush(); });
  host.on('leave', (from) => { game.leave(from.cid); flush(); });
  host.on('error', (err) => console.error('[star]', err));
  host.loop(RULES.TICK_MS, (now) => { game.tick(now); flush(); host.publish(TAGS.STATE, game.snapshot()); });
  flush(); // the empty retained roster, so the first screens get one at once

  let closing;
  const close = () => (closing ??= new Promise((resolve) => {
    host.close();
    server.close(() => httpServer.close(() => resolve()));
    setTimeout(resolve, 1500).unref();
  }));
  return { port: httpServer.address().port, game, server, host, kit, close };
}
