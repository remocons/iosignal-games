// IOSignal game kit, server side. Every game serves the same few routes with it:
//   /join     JSON { url, lan, title }: the address players open (this PC's LAN IP, or publicUrl)
//   /qr.svg   a QR code of that address
//   /kit/*    the kit's browser files (kit.js, kit.css)
// No dependencies of its own: the game passes its 'qrcode' module in. The games import this file
// by relative path (../../game-kit/server.mjs), so the folder sits next to the games on ia too.

import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const KIT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const MIME = {
  '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8',
};

export function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a.address);
}

/**
 * title: the game's name for the join dialog. port(): the listening HTTP port (for the LAN address). publicUrl: the address behind a proxy, e.g. https://lab.iosignal.net/games/<name>/.
 * QRCode: the 'qrcode' package. Returns { handle(pathname, res) -> Promise<boolean>, joinUrl() }.
 */
export function createGameKit({ title, port, publicUrl, QRCode, qrColor = '#10213a' }) {
  const joinUrl = () => publicUrl || `http://${lanAddresses()[0] ?? 'localhost'}:${port()}`;
  const send = (res, status, type, body) => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(body);
  };

  async function handle(pathname, res) {
    if (pathname === '/join') {
      send(res, 200, MIME['.json'], JSON.stringify({ url: joinUrl(), lan: !publicUrl, title }));
      return true;
    }
    if (pathname === '/qr.svg') {
      const svg = await QRCode.toString(joinUrl(), { type: 'svg', margin: 1, color: { dark: qrColor, light: '#ffffff' } });
      send(res, 200, MIME['.svg'], svg);
      return true;
    }
    if (pathname.startsWith('/kit/')) {
      const file = path.join(KIT_DIR, decodeURIComponent(pathname.slice('/kit/'.length)));
      if (!file.startsWith(KIT_DIR + path.sep)) { send(res, 403, 'text/plain', 'Forbidden'); return true; }
      try {
        send(res, 200, MIME[path.extname(file)] || 'application/octet-stream', await readFile(file));
      } catch {
        send(res, 404, 'text/plain; charset=utf-8', '404 Not Found');
      }
      return true;
    }
    return false;
  }

  return { handle, joinUrl };
}
