// Real sockets: a WebSocket player (like a phone) and a CongSocket TCP player that sends exactly
// the TEXT the ESP8266 sketch sends, through the IOSignal server and its 'zoo' host.
import test from 'node:test';
import assert from 'node:assert/strict';
import { IO, IOCongSocket } from 'iosignal';
import { startZoo } from '../src/zoo-server.mjs';
import { TAGS, P } from '../public/shared.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await wait(20); }
  throw new Error('timeout');
};

test('phone and Arduino play through the zoo host', async () => {
  const zoo = await startZoo({ port: 0, congPort: 0, log: () => {} });
  for (const b of zoo.game.bots) { b.alive = false; b.deadUntil = Infinity; } // keep the test calm
  const web = new IO(`ws://127.0.0.1:${zoo.port}/ws`);
  const ard = new IOCongSocket(`cong://127.0.0.1:${zoo.congPort}`);
  try {
    let snap = null, roster = null;
    const events = [], fx = [];
    web.on('message', (tag, data) => {
      if (tag === TAGS.STATE) snap = data;
      if (tag === TAGS.ROSTER) roster = data;
      if (tag === TAGS.EVT) events.push(data);
    });
    ard.on('@fx', (_t, word) => fx.push(word)); // direct signal, no subscription
    await until(() => web.stateName === 'ready' && ard.stateName === 'ready');
    web.subscribe(`${TAGS.ROSTER},${TAGS.STATE},${TAGS.EVT}`);
    await wait(100);

    web.signal(TAGS.IN, 'J,web,alice,2');
    ard.signal(TAGS.IN, 'J,ard,esp-c0de');           // same as snprintf in the sketch
    await until(() => snap?.p.length === 2);
    await until(() => roster?.p.some((r) => r[0] === ard.cid && r[1] === 'esp-c0de' && r[3] === 'ard'));
    await until(() => fx.includes('join') && fx.includes('spawn'));

    // Arduino walks (grid +x) and jumps; its position changes in the snapshots.
    const me = () => snap.p.find((p) => p[P.CID] === ard.cid);
    const before = [me()[P.X], me()[P.Y]];
    ard.signal(TAGS.IN, 'W,100,0');            // RIGHT button: grid +x
    ard.signal(TAGS.IN, 'U');
    await until(() => me()[P.Z] > 0);
    await wait(300);
    ard.signal(TAGS.IN, 'W,0,0');
    assert.notDeepEqual([me()[P.X], me()[P.Y]], before);
    await until(() => fx.includes('jump'));

    // A mine from the phone shows in the snapshot with its owner.
    web.signal(TAGS.IN, 'B');
    await until(() => snap.m.length === 1);
    assert.equal(snap.p[snap.m[0][4]][P.CID], web.cid);

    // The payload cannot name another player, and clients cannot write the host's tags.
    web.signal(TAGS.IN, `${ard.cid},L`);
    web.signal(TAGS.STATE, { p: [], fake: true });
    web.signal(`${ard.cid}@fx`, 'die');
    await wait(300);
    assert.equal(snap.p.length, 2);
    assert.equal(snap.fake, undefined);
    assert.equal(fx.includes('die'), false);
    assert.equal(zoo.ioServer.stats().counters.hostDenied, 2);

    // The watch screen's join address and QR code.
    const join = await (await fetch(`http://127.0.0.1:${zoo.port}/join`)).json();
    assert.match(join.url, new RegExp(`^http://[^/]+:${zoo.port}$`));
    const qr = await fetch(`http://127.0.0.1:${zoo.port}/qr.svg`);
    assert.equal(qr.headers.get('content-type'), 'image/svg+xml');
    assert.match(await qr.text(), /^<svg/);

    // The status page and its data: the zoo host with its loop timing and report.
    assert.equal((await fetch(`http://127.0.0.1:${zoo.port}/dashboard`)).status, 200);
    const dash = [];
    web.on('@iosignal.dashboard', (_t, m) => dash.push(m));
    web.signal('iosignal.dashboard#in', { op: 'hello' });
    await until(() => dash.some((m) => m.type === 'tick' && m.hosts.some((h) => h.name === 'zoo' && h.loops.length && h.report.area)), 4000);

    // Closing the Arduino connection removes it at once.
    ard.destroy?.(); ard.close?.();
    await until(() => snap.p.length === 1, 2000);
    assert.ok(events.some((e) => e.e === 'leave' && e.reason === 'close'));
  } finally {
    web.destroy();
    ard.destroy?.(); ard.close?.();
    await zoo.close();
  }
});
