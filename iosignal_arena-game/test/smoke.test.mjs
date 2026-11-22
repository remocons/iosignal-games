// End-to-end over real sockets: a WebSocket client (like the browser) and a
// CongSocket TCP client that sends exactly the TEXT the ESP32 sketch sends.
import test from 'node:test';
import assert from 'node:assert/strict';
import { IO, IOCongSocket } from 'iosignal';
import { startArena } from '../src/arena-server.mjs';
import { TAGS, S } from '../public/protocol.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await wait(20); }
  throw new Error('timeout');
};

test('web + arduino clients play through IOSignal', async () => {
  const arena = await startArena({ port: 0, congPort: 0, log: () => {} });
  const web = new IO(`ws://127.0.0.1:${arena.port}/ws`);
  const ard = new IOCongSocket(`cong://127.0.0.1:${arena.congPort}`);
  try {
    let snap = null;
    let roster = null;
    const events = [];
    const fx = [];
    web.on('message', (tag, data) => {
      if (tag === TAGS.STATE) snap = data;
      if (tag === TAGS.EVT) events.push(data);
      if (tag === TAGS.ROSTER) roster = data;
    });
    ard.on('@fx', (_tag, text) => fx.push(text)); // direct signal, no subscription
    await until(() => web.stateName === 'ready' && ard.stateName === 'ready');
    web.subscribe(`${TAGS.ROSTER},${TAGS.STATE},${TAGS.EVT}`);
    await wait(150);

    web.signal(TAGS.IN, 'J,web,alice');
    ard.signal(TAGS.IN, 'J,ard,esp-c3'); // same as snprintf in the sketch

    await until(() => snap && snap.p.length === 2);
    assert.ok(events.some((e) => e.e === 'join' && e.kind === 'ard'));
    await until(() => fx.includes('join'));
    assert.ok(snap.it, 'a tagger is chosen with two players');
    assert.equal(snap.p[0].length, 6, 'snapshot carries dynamic fields only');
    await until(() => roster?.p.length === 2);
    assert.ok(roster.p.some(([cid, name, , kind]) => cid === ard.cid && name === 'esp-c3' && kind === 'ard'));

    // A late subscriber gets the retained roster at once, without waiting for a change.
    const late = new IO(`ws://127.0.0.1:${arena.port}/ws`);
    try {
      let lateRoster = null;
      late.on('message', (tag, data) => { if (tag === TAGS.ROSTER) lateRoster = data; });
      await until(() => late.stateName === 'ready');
      late.subscribe(TAGS.ROSTER);
      await until(() => lateRoster?.p.length === 2, 1000);
    } finally { late.destroy(); }

    // Arduino moves: press then release whichever direction is open.
    const me = () => snap.p.find((p) => p[S.CID] === ard.cid);
    await wait(1100); // the first tagger is frozen for RULES.STUN_MS
    const before = [me()[S.X], me()[S.Y]];
    for (const d of ['U', 'D', 'L', 'R']) {
      ard.signal(TAGS.IN, `D,${d}`);
      ard.signal(TAGS.IN, 'D,0');
      await wait(200);
      if (me()[S.X] !== before[0] || me()[S.Y] !== before[1]) break;
    }
    assert.notDeepEqual([me()[S.X], me()[S.Y]], before, 'arduino moved on the shared map');

    // The status page and its data: the arena host with its loop timing and report.
    assert.equal((await fetch(`http://127.0.0.1:${arena.port}/dashboard`)).status, 200);
    const dash = [];
    ard.on('@iosignal.dashboard', (_t, m) => dash.push(m));
    ard.signal('iosignal.dashboard#in', { op: 'hello' });
    await until(() => dash.some((m) => m.type === 'tick' && m.hosts.some((h) => h.name === 'arena' && h.loops.length && h.report.map)), 4000);

    // Leave
    web.signal(TAGS.IN, 'L');
    await until(() => snap.p.length === 1);
  } finally {
    web.destroy();
    ard.destroy?.();
    ard.close?.();
    await arena.close();
  }
});

test('the host knows who sent each input: no playing for others, no forged state', async () => {
  const arena = await startArena({ port: 0, congPort: 0, log: () => {} });
  const alice = new IO(`ws://127.0.0.1:${arena.port}/ws`);
  const mallory = new IO(`ws://127.0.0.1:${arena.port}/ws`);
  try {
    let snap = null;
    const states = [];
    alice.on('message', (tag, data) => {
      if (tag === TAGS.STATE) { snap = data; states.push(data); }
    });
    await until(() => alice.stateName === 'ready' && mallory.stateName === 'ready');
    alice.subscribe(`${TAGS.STATE},${TAGS.EVT}`);
    await wait(100);
    alice.signal(TAGS.IN, 'J,web,alice');
    mallory.signal(TAGS.IN, 'J,web,mallory');
    await until(() => snap && snap.p.length === 2);

    // The payload cannot name another player: "<cid>,L" is not an input, "L" is mallory's own.
    const before = arena.game.players.get(alice.cid).lastSeen;
    mallory.signal(TAGS.IN, `${alice.cid},L`);
    mallory.signal(TAGS.IN, 'L');
    await until(() => snap.p.length === 1);
    assert.ok(arena.game.players.has(alice.cid), 'alice is still playing');
    assert.equal(arena.game.players.has(mallory.cid), false, 'mallory left herself');
    assert.equal(arena.game.players.get(alice.cid).lastSeen, before);

    // Clients cannot publish the host's tags.
    mallory.signal(TAGS.STATE, { p: [], fake: true });
    mallory.signal(`${alice.cid}${TAGS.FX}`, 'win');
    await wait(200);
    assert.equal(states.some((s) => s.fake), false);

    // A closed connection leaves at once (not after RULES.TIMEOUT_MS).
    mallory.signal(TAGS.IN, 'J,web,mallory');
    await until(() => snap.p.length === 2);
    const t = Date.now();
    mallory.destroy();
    await until(() => snap.p.length === 1, 2000);
    assert.ok(Date.now() - t < 2000);
  } finally {
    alice.destroy();
    mallory.destroy();
    await arena.close();
  }
});
