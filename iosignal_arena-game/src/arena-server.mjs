// IOSignal Arena server:
//   1) HTTP static server for the web app (public/) + /vendor/io.js (IOSignal browser IIFE)
//   2) IOSignal Server on the same port (WebSocket /ws) and a TCP port for Arduino (congPort)
//   3) Game host (server.host): the game state inside the IOSignal server. Inputs on TAGS.IN reach
//      only the host, each with the sender's CID as the server knows it; clients cannot send the
//      host's output tags. All game rules live in src/game.mjs.

import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Server, version } from 'iosignal';
import QRCode from 'qrcode';
import { createGameKit, lanAddresses } from '../../game-kit/server.mjs';
import { ArenaGame } from './game.mjs';
import { TAGS, RULES, MAPS } from '../public/protocol.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const require = createRequire(import.meta.url);
const VENDOR_IO = require.resolve('iosignal/browser/iife/io.js');
const WS_PATH = '/ws';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function staticHandler(getStatus, kit) {
  return async (req, res) => {
    try {
      const { pathname } = new URL(req.url || '/', 'http://localhost');
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD' });
        res.end();
        return;
      }
      if (await kit.handle(pathname, res)) return; // join, qr.svg, kit/* (IOSignal game kit)
      if (pathname === '/healthz') {
        res.writeHead(200, { 'Content-Type': MIME['.json'] });
        res.end(JSON.stringify(getStatus()));
        return;
      }
      let filePath;
      if (pathname === '/vendor/io.js') {
        filePath = VENDOR_IO;
      } else {
        const rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
        filePath = path.join(PUBLIC_DIR, rel);
        if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
          res.writeHead(403);
          res.end('Forbidden');
          return;
        }
      }
      const data = await readFile(filePath);
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch (err) {
      const notFound = err?.code === 'ENOENT' || err?.code === 'EISDIR';
      if (!notFound) console.error('[http]', err);
      res.writeHead(notFound ? 404 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(notFound ? '404 Not Found' : '500 Internal Server Error');
    }
  };
}

export { lanAddresses };

/**
 * Start everything. port/congPort 0 = pick a free port (used by tests).
 * quotas: IOSignal quota profiles passed to the Server (none by default: unlimited since iosignal 10.3.0).
 * Resolves with { port, congPort, game, close() }.
 */
// dashboard: false, true or iosignal dashboard options (the status page /dashboard, iosignal 9.14.0).
// publicUrl: the address players open behind a proxy (join dialog and QR code).
export async function startArena({ port = 5178, listenHost, publicUrl, congPort = 55488, log = console.log, logMessages = false, quotas, dashboard = true } = {}) {
  const game = new ArenaGame();
  let host = null;

  const serveStatic = staticHandler(() => ({
    ok: true, iosignal: version, ws: WS_PATH, congPort: ioServer.congPort,
    players: game.players.size, phase: game.phase, map: MAPS[game.mapIndex].name, host: host?.name ?? null,
  }), createGameKit({ title: 'Arena', port: () => httpServer.address().port, publicUrl, QRCode }));
  const httpServer = http.createServer((req, res) => {
    if (ioServer.dashboard?.handle(req, res)) return; // /dashboard and /dashboard/io.js
    serveStatic(req, res);
  });

  const ioServer = new Server({ httpServer, wsPath: WS_PATH, congPort, logMessages, quotas, dashboard });
  const ioReady = new Promise((resolve) => ioServer.on('ready', resolve));
  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, listenHost, resolve); // listenHost: undefined listens on every interface
  });
  await ioReady;
  const actualPort = httpServer.address().port;

  // ---------------- Game host ----------------
  host = ioServer.host('arena', {
    inbound: [TAGS.IN],
    own: [TAGS.STATE, TAGS.ROSTER, TAGS.EVT, TAGS.FX],
  });

  // Snapshots go out right after a visible change (at most one per SNAPSHOT_MIN_MS)
  // and otherwise every SNAPSHOT_MS so timers and flags keep updating.
  let snapTimer = null;
  let lastSnapAt = 0;
  const scheduleSnapshot = (delay) => {
    clearTimeout(snapTimer);
    snapTimer = setTimeout(sendSnapshot, delay);
  };
  function sendSnapshot() {
    const now = Date.now();
    if (game.players.size) host.publish(TAGS.STATE, game.snapshot(now));
    lastSnapAt = now;
    game.dirty = false;
    scheduleSnapshot(RULES.SNAPSHOT_MS);
  }

  const flush = () => {
    // Roster before events and snapshots, so clients get names first.
    if (game.rosterDirty) {
      game.rosterDirty = false;
      host.publish(TAGS.ROSTER, game.roster());
    }
    const { events, fx } = game.drain();
    for (const evt of events) {
      host.publish(TAGS.EVT, evt);
      if (evt.e === 'join') log(`[game] + ${evt.name} (${evt.kind}) ${evt.cid}`);
      if (evt.e === 'leave') log(`[game] - ${evt.name} ${evt.cid} (${evt.reason})`);
      if (evt.e === 'round' && evt.phase === 'start') log(`[game] round start: ${MAPS[evt.map].name}`);
    }
    for (const [cid, text] of fx) host.to(cid, TAGS.FX.slice(1), text); // the device receives "@fx"
    if (game.dirty) scheduleSnapshot(Math.max(0, lastSnapAt + RULES.SNAPSHOT_MIN_MS - Date.now()));
  };

  // from.cid is the sender's connection as the server knows it; the text holds only "OP,args".
  host.on('message', (from, tag, payload) => {
    if (game.handleInput(from.cid, typeof payload === 'string' ? payload : String(payload), Date.now())) flush();
  });
  // A player's connection closed: remove at once instead of waiting for RULES.TIMEOUT_MS.
  host.on('leave', (from) => {
    if (!game.players.has(from.cid)) return;
    game.leave(from.cid, Date.now(), 'close');
    flush();
  });
  host.on('error', (err) => log('[game] handler error', err?.message || err));

  // host.loop: like setInterval, and the dashboard shows its tick timing.
  let ticks = 0;
  host.loop(30, (now) => {
    game.tick(now);
    flush();
    if (++ticks % 30 === 0) {
      const it = game.it ? game.players.get(game.it) : null;
      const top = [...game.players.values()].sort((a, b) => b.score - a.score)[0];
      host.report({
        map: MAPS[game.mapIndex].name,
        phase: game.phase === 'play' ? '경기 중' : '순위 발표',
        left: `${Math.ceil(Math.max(0, game.phaseEndsAt - now) / 1000)}초`,
        players: game.players.size,
        tagger: it ? it.name : '-',
        coins: game.coins.size,
        leader: top ? `${top.name} ${top.score}` : '-',
      });
    }
  });
  flush(); // the empty retained roster, so the first subscribers get one at once
  scheduleSnapshot(RULES.SNAPSHOT_MS);
  log('[game] host ready: arena');

  let closing;
  const close = () => (closing ??= new Promise((resolve) => {
    clearTimeout(snapTimer);
    host.close();
    ioServer.close(() => httpServer.close(() => resolve()));
    setTimeout(resolve, 1500).unref();
  }));

  return { port: actualPort, congPort: ioServer.congPort, game, ioServer, close };
}
