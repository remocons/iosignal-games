// Real sockets: two phones drive through the IOSignal server and its 'bump' host.
import test from 'node:test';
import assert from 'node:assert/strict';
import { IO } from 'iosignal';
import { startBump } from '../src/bump-server.mjs';
import { BumperGame } from '../src/game.mjs';
import { TAGS, C } from '../public/shared.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await wait(20); }
  throw new Error('timeout');
};

test('two phones crash through the bump host', async () => {
  const bump = await startBump({ port: 0, log: () => {}, game: new BumperGame({ bots: false }) });
  const url = `ws://127.0.0.1:${bump.port}/ws`;
  const a = new IO(url), b = new IO(url);
  try {
    let snap = null, roster = null;
    const events = [];
    a.on('message', (tag, d) => {
      if (tag === TAGS.STATE) snap = d;
      if (tag === TAGS.ROSTER) roster = d;
      if (tag === TAGS.EVT) events.push(...d.ev);
    });
    await until(() => a.stateName === 'ready' && b.stateName === 'ready');
    a.subscribe(`${TAGS.ROSTER},${TAGS.STATE},${TAGS.EVT}`);
    await wait(100);
    a.signal(TAGS.IN, 'J,web,alice,0');
    b.signal(TAGS.IN, 'J,web,bob,3');
    await until(() => snap?.c.length === 2 && roster?.c.length === 2);

    // Put them nose to side and let alice drive in.
    const ca = bump.game.cars.get(a.cid), cb = bump.game.cars.get(b.cid);
    Object.assign(ca, { x: 4, y: 10, a: 0, vx: 0, vy: 0 }); // y = 10: a clear lane
    Object.assign(cb, { x: 7, y: 10, a: Math.PI / 2, vx: 0, vy: 0 });
    a.signal(TAGS.IN, 'W,100,0');
    await until(() => events.some((e) => e.e === 'hit' && e.k === 'car'));
    const hit = events.find((e) => e.e === 'hit' && e.k === 'car');
    assert.equal(hit.a, a.cid);
    await until(() => snap.c.find((c) => c[C.ID] === a.cid)[C.SCORE] > 0);

    // Forged output never reaches anyone; the payload cannot drive someone else's car.
    b.signal(TAGS.STATE, { c: [], fake: true });
    b.signal(TAGS.EVT, { ev: [{ e: 'round', ph: 'end', rank: [] }] });
    b.signal(TAGS.IN, `${a.cid},X`);
    await wait(300);
    assert.equal(snap.fake, undefined);
    assert.equal(events.some((e) => e.e === 'round'), false);
    assert.equal(bump.ioServer.stats().counters.hostDenied, 2);

    // Big screen: join address and QR code.
    const join = await (await fetch(`http://127.0.0.1:${bump.port}/join`)).json();
    assert.match(join.url, new RegExp(`:${bump.port}$`));
    assert.match(await (await fetch(`http://127.0.0.1:${bump.port}/qr.svg`)).text(), /^<svg/);
    // IOSignal game kit files, and nothing outside the kit folder.
    const kitJs = await fetch(`http://127.0.0.1:${bump.port}/kit/kit.js`);
    assert.equal(kitJs.status, 200);
    assert.match(await kitJs.text(), /export function mountGameKit/);
    assert.equal(join.title, '범퍼카');
    assert.notEqual((await fetch(`http://127.0.0.1:${bump.port}/kit/..%2Fserver.mjs`)).status, 200);

    // The status page and its data: the bump host with its loop timing and report.
    assert.equal((await fetch(`http://127.0.0.1:${bump.port}/dashboard`)).status, 200);
    const dash = [];
    b.on('@iosignal.dashboard', (_t, m) => dash.push(m));
    b.signal('iosignal.dashboard#in', { op: 'hello' });
    await until(() => dash.some((m) => m.type === 'tick' && m.hosts.some((h) => h.name === 'bump' && h.loops.length && h.report.phase)), 4000);

    // Leaving: the car is gone at once.
    b.destroy();
    await until(() => snap.c.length === 1, 2000);
  } finally {
    a.destroy(); b.destroy();
    await bump.close();
  }
});
