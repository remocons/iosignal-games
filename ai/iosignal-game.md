# Building a multiplayer game with IOSignal — context for AI assistants

Give this whole file to your AI assistant (Claude, ChatGPT, Copilot, Cursor, …) before asking it to build or change a game. It states the rules, the exact API and a tested layout, so the assistant does not have to guess. Written against `iosignal` **9.23.0** (Node.js 22.16 or later). Source: https://github.com/remocons/iosignal-games/blob/main/ai/iosignal-game.md

**For the assistant:** follow the MUST rules in section 2 exactly. When something here does not cover a question, read the docs (https://docs.iosignal.net/llms.txt) or the installed package's types and source; do not invent API. Ask the user before changing the tag design once it is agreed.

## 1. What you are building

IOSignal is a real-time messaging library: one package gives a Node.js **server** (broker) and **clients** for browsers, Node.js and Arduino. Clients `subscribe` to tags and `signal` (send) to tags. A multiplayer game adds one thing: a **game host**, `server.host(name, …)`, that runs **inside the server process** and is the only place where rules are judged.

```
 phones / PCs (browser) ── WebSocket /ws ──┐
 Arduino controllers ───── TCP (optional) ─┤
                                           IOSignal Server  (same Node.js process and port as the web page)
                                            └─ server.host('<game>')  judges: moves, collisions, score, rounds
```

- The game runs on **your own server**. A host cannot run on the public broker `io.iosignal.net`.
- Typical shape: a big screen shows the whole game (`?watch`), each person plays on a phone that joined by QR code. No app install.
- Reference games (same structure, all tested): https://github.com/remocons/iosignal-games — start from `iosignal_star-chase` (about 220 lines in all), then look at `iosignal_bumper-cars` (physics loop, bots), `iosignal_zoo-survival` (big state, Arduino), `iosignal_arena-game` (Arduino buttons with feedback).

## 2. Rules (MUST)

1. **Clients send intent, the host decides.** A client sends "I pressed right" or "stick at 30°", never "I am at x=5" or "I scored". Position, collisions, score, timers and winners are computed only in the host.
2. **Identity comes from `from.cid`.** The host's `message` handler gets `from.cid`, set by the server for that connection. Never read a player id from the payload.
3. **Every tag the host sends is in `own`.** Then clients cannot forge the scoreboard or state; the server drops such messages (`server.stats().counters.hostDenied`).
4. **Rules live in a network-free module** (`src/game.mjs`): plain class, inputs and time (`now`) as arguments, outputs as return values or queued events. The server file only wires it to the host. This makes rules unit-testable.
5. **Send little, send on purpose.** Inputs on change (or a slow heartbeat), never every animation frame. Snapshots at a fixed rate (10–30 Hz) as short arrays. Anonymous connections may send about **100 messages per second** by default (`msgPerSec`); over the limit, messages are dropped silently.
6. **Handle reconnects and leaves.** An anonymous client gets a **new CID after reconnecting**: subscribe and send the join again in every `ready` handler. Remove a player on the host's `leave` event, and also time out players who stop sending (a heartbeat every few seconds).
7. **One port.** Serve the page, the IOSignal WebSocket (`/ws`) and the browser client file from one HTTP server. Build the WebSocket URL relative to the page (section 5) so the game works behind a proxy path.
8. **Validate every input.** Parse with a strict format, clamp numbers, cap name length and characters, ignore unknown ops and input from players who have not joined.

## 3. Tags

Use the game name as a prefix. This set covers most games:

| Tag | Direction | Payload | Notes |
|---|---|---|---|
| `<game>#in` | client → host (`inbound`) | TEXT `"OP,arg,arg"` | Only the host receives it. Short ops: `J` join, `M` move, `A` action, `H` heartbeat |
| `<game>#state` | host → all (`own`) | OBJECT snapshot | Sent by `host.loop`, 10–30 Hz |
| `<game>#$roster` | host → all (`own`) | OBJECT names, colours, kinds | `$` = the server keeps the last value, so late screens get it at once. Send only when it changes |
| `<game>#evt` | host → all (`own`) | OBJECT `{ ev: [...] }` | One message per tick with that tick's events (hits, joins, round end) for effects and sounds |
| `@<game>.you` | host → one (`own`) | OBJECT | `host.to(cid, '<game>.you', …)`; the client receives tag `'@<game>.you'` without subscribing |

- Host tags are global channel tags (`<name>#<topic>`) or `@<topic>`. A leading `#` (home channel) or a leading `$` is not allowed in `inbound`/`own`.
- `inbound` and `own` may end in `*` for prefixes (rooms: `room:*`).
- Tags and subscription lists are at most 255 bytes.

## 4. Server API (Node.js)

```js
import http from 'node:http';
import { Server } from 'iosignal';

const httpServer = http.createServer(handler);            // serves the page, /vendor/io.js and game-kit routes
const server = new Server({ httpServer, wsPath: '/ws' }); // add congPort: 55488 for Arduino over TCP, dashboard: true for /dashboard
const ready = new Promise((r) => server.once('ready', r));
await new Promise((r) => httpServer.listen(port, r));
await ready;

const host = server.host('star', {
  inbound: ['star#in'],                                   // required
  own: ['star#state', 'star#$roster', '@star.you'],
});
host.on('message', (from, tag, payload) => { /* from.cid, from.authorized, from.nick … payload: string or object */ });
host.on('leave', (from, reason) => { /* a connection that had sent input closed */ });
host.on('error', (err) => console.error(err));            // exceptions thrown in your handlers
host.loop(100, (now) => { /* game tick; the dashboard shows its timing */ });  // returns a stop function
host.publish('star#state', snapshot);                     // to every subscriber; returns the delivery count
host.to(cid, 'star.you', { score: 3 });                   // to one connection; arrives as '@star.you'
host.report({ players: 3, leader: 'alice 12' });          // values shown on the dashboard (up to 20)
host.close();                                             // also done by server.close(callback)
```

- `server.stats().counters`: `hostInbound`, `hostRejected`, `hostDenied`. `server.on('host:denied', (remote, tag, hostName) => …)` logs forgery attempts.
- Serve the browser client file from the package: `createRequire(import.meta.url).resolve('iosignal/browser/iife/io.js')` at `/vendor/io.js` (defines global `IO`). An ES module build is `iosignal/browser/esm/io.js`.

## 5. Client API

Browser (`<script src="vendor/io.js"></script>` then a module script):

```js
const ws = new URL('ws', location.href);                  // relative: works at / and behind /games/<name>/
ws.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
const io = new IO(ws.href);

io.on('ready', () => {                                    // after every (re)connect; io.cid is new each time
  io.subscribe('star#state,star#$roster');                // comma-separated list
  if (joined) io.signal('star#in', `J,${name}`);
});
io.on('change', () => showConnection(io.stateName));      // 'ready' when connected
io.on('message', (tag, data) => { /* subscribed tags */ });
io.on('@star.you', (tag, data) => { /* direct, no subscribe needed */ });
io.signal('star#in', 'M,1,0');                            // only when io.stateName === 'ready'
const ms = await io.pingServer();                         // round trip in ms (the game kit shows it)
```

- Node.js (tests, bots): `import { IO } from 'iosignal'`, same API; close with `io.destroy()`.
- Payload: a string is sent as TEXT, a plain object as OBJECT (JSON). Keep each message small; the server's limit is `io.quota.maxMessageBytes` after `ready`.
- Arduino: `io.signal("star#in", "M,1,0");` and receive `@star.you` in `onMessage`. Arduino receive buffers are small (80 bytes by default): send it short TEXT through `host.to`, not the full snapshot.

## 6. Project layout

Copy this layout (it is `iosignal_star-chase`):

```
my-game/
  package.json        "type": "module", deps: iosignal 9.23.0 (+ qrcode for the game kit), scripts: start, test
  server.mjs          entry: reads PORT, HOST, PUBLIC_URL; calls startGame(); prints the LAN address
  src/game.mjs        rules only (MUST 4)
  src/<game>-server.mjs   HTTP + Server + host: wires inputs to rules and publishes results
  public/shared.js    TAGS, RULES (numbers), input parser — imported by server and browser
  public/index.html   page and client script (or public/app.js)
  test/game.test.mjs  rules
  test/smoke.test.mjs real sockets: two clients, a join, a scored point, a forged tag that is dropped
```

The host wiring in `src/<game>-server.mjs` stays short:

```js
const flush = () => {
  if (game.rosterDirty) { game.rosterDirty = false; host.publish(TAGS.ROSTER, game.roster()); }
  for (const [cid, result] of game.results) host.to(cid, TAGS.YOU, result);
  game.results = [];
};
host.on('message', (from, tag, text) => { game.input(from.cid, String(text), Date.now()); flush(); });
host.on('leave', (from) => { game.leave(from.cid); flush(); });
host.loop(RULES.TICK_MS, (now) => { game.tick(now); flush(); host.publish(TAGS.STATE, game.snapshot()); });
```

Snapshot shape: arrays with index constants, integers where possible (e.g. coordinates × 100), short keys. Example: `{ s: [x, y], p: [[cid, x, y, score], …] }` and in `shared.js` `export const P = { CID: 0, X: 1, Y: 2, SCORE: 3 }`. Interpolate between snapshots on the client for smooth motion.

## 7. Game kit (optional, recommended)

`game-kit/` in the same repository gives every game the same IOSignal look: a brand badge, a connection chip (state, round trip, players), a 📱 join button with QR code and share, and a QR card for the big screen. Keep the folder next to your game folder.

```js
// server
import QRCode from 'qrcode';
import { createGameKit } from '../../game-kit/server.mjs';
const kit = createGameKit({ title: 'My Game', port: () => httpServer.address().port, publicUrl, QRCode });
// first thing in the HTTP handler:
if (await kit.handle(pathname, res)) return;              // serves join, qr.svg, kit/*
```

```html
<link rel="stylesheet" href="kit/kit.css">
<header><a data-iok="brand"></a> My Game <span data-iok="net"></span> <button data-iok="join"></button></header>
<aside><div data-iok="card"></div></aside>                <!-- big screen: QR to join -->
<script type="module">
  import { mountGameKit } from './kit/kit.js';
  const kit = mountGameKit({ io, title: 'My Game' });
  // on each roster: kit.setRoster(players.map((p) => p.kind));   // 'web' | 'ard' | 'bot'
</script>
```

## 8. Testing

- `npm test` runs `node --test test/*.test.mjs`.
- Rules: construct the game with a fixed `random` and explicit `now`; assert scores, edges, timeouts and that bad input returns false.
- Sockets: start the server on `port: 0`, connect two `IO` clients to `ws://127.0.0.1:<port>/ws`, wait until both `stateName === 'ready'`, join, act, and assert what arrives. Also send a host-owned tag from a client and assert it never arrives and `hostDenied` grew. Always `destroy()` clients and `await close()` in `finally`.
- Bots for manual play: a script that opens N `IO` clients and sends random or simple-AI inputs.

## 9. Common mistakes

| Mistake | Instead |
|---|---|
| The client moves its own avatar and sends its position | Send the input; draw what the snapshot says (predict locally only for feel) |
| A player id or name inside the input decides who acted | Use `from.cid` |
| Sending input every `requestAnimationFrame` | Send on change, plus a heartbeat every 2–3 s |
| Subscribing once at start | Subscribe and re-join inside `on('ready')` |
| State objects with long keys at 30 Hz | Arrays + index constants, rounded integers |
| `ws://localhost:…` hard-coded in the page | Build the URL relative to `location.href` |
| Forgetting `own` for an output tag | Every host output tag goes in `own`; test that a forged one is dropped |
| Hosting the game on `io.iosignal.net` | Run your own `Server`; the host lives in that process |
| `requestAnimationFrame(frame)` at the end of `frame` | Call it first, so one exception does not stop drawing |

## 10. Before you say it is done

- [ ] `npm test` passes, including a socket test with two clients and a forged-tag check.
- [ ] Two browser windows (or a phone and a PC) play together; closing one removes that player.
- [ ] Reloading a page rejoins as a new player without errors.
- [ ] Inputs are rate-limited by design (on change + heartbeat).
- [ ] The README says how to run it, which port, and what the tags are.

## 11. Running it for others

- Local network: `npm start`, open the printed LAN address on phones (same Wi-Fi), or scan the QR from the join button.
- Behind a reverse proxy at a sub path: run with `HOST=127.0.0.1 PORT=<port> PUBLIC_URL=https://example.com/games/<name>/`, proxy both `/games/<name>/` and its WebSocket `/games/<name>/ws` to that port. Pages already use relative URLs.
- Arduino players need the TCP port (`congPort`) reachable on the local network.

Docs: https://docs.iosignal.net/docs/game (Korean, the reference) · https://docs.iosignal.net/en/docs/game · server API: https://docs.iosignal.net/docs/reference/server-api#host
