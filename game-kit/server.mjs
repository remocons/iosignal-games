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

/**
 * Server limits from environment variables, for a game you run where anyone can reach it. A game
 * server limits nothing unless asked (iosignal 10.3.0 and later); the operator turns limits on:
 *   IOSIGNAL_ANON_LIMITS="msgPerSec=100,maxMessageBytes=262144"  limits for players that do not log in
 *     (maxMessageBytes, fanout, msgPerSec, bytesPerSec, maxSubscriptions, deliveriesPerSec)
 *   IOSIGNAL_CONNECTION_LIMITS="maxPerAddress=200,newPerAddressPerMin=300"  per public address
 *     (newPerAddressPerMin, failedPerAddressPerMin, maxPerAddress, msgPerAddressPerSec, bytesPerAddressPerSec)
 * Returns Server options to spread into new Server({ ... }); {} when neither is set. Behind a proxy the
 * address is the X-Forwarded-For client (the Server trusts it from loopback and private peers).
 */
export function serverLimitsFromEnv(env = process.env) {
  const list = (name) => {
    const text = env[name];
    if (!text) return null;
    const limits = {};
    for (const part of text.split(',').map((s) => s.trim()).filter(Boolean)) {
      const [key, value, ...rest] = part.split('=');
      const number = Number(value);
      if (!key || rest.length || !(value === 'null' || (Number.isSafeInteger(number) && number >= 0))) {
        throw new RangeError(`${name}: use name=value pairs with integers, e.g. msgPerSec=100 (got ${part})`);
      }
      limits[key] = value === 'null' ? null : number;
    }
    return limits;
  };
  const options = {};
  const anonymous = list('IOSIGNAL_ANON_LIMITS');
  if (anonymous) Object.assign(options, { quotas: { anonymous }, anonymousQuota: 'anonymous' });
  const connectionLimits = list('IOSIGNAL_CONNECTION_LIMITS');
  if (connectionLimits) options.connectionLimits = connectionLimits;
  return options;
}
