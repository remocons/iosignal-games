// Two real clients through the server: join, move onto the star, and a forged state is dropped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { IO } from 'iosignal';
import { startStar } from '../src/star-server.mjs';
import { StarGame } from '../src/game.mjs';
import { TAGS } from '../public/shared.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 4000) => {
  for (const end = Date.now() + ms; Date.now() < end; await wait(20)) { const v = fn(); if (v) return v; }
  throw new Error('timeout');
};

test('two players, a point, and a forged state that never arrives', async () => {
  const game = new StarGame(() => 0); // star and players start at 0,0 ... then the star moves
  const s = await startStar({ port: 0, game });
  const url = `ws://127.0.0.1:${s.port}/ws`;
  const a = new IO(url), b = new IO(url);
  try {
    await until(() => a.stateName === 'ready' && b.stateName === 'ready');
    let snap = null, roster = null, you = null;
    b.on('message', (tag, d) => { if (tag === TAGS.STATE) snap = d; if (tag === TAGS.ROSTER) roster = d; });
    a.on('@' + TAGS.YOU, (tag, r) => { you = r; });
    b.subscribe(`${TAGS.STATE},${TAGS.ROSTER}`);
    a.signal(TAGS.IN, 'J,alice');
    b.signal(TAGS.IN, 'J,bob');
    await until(() => roster?.p.length === 2 && snap?.p.length === 2);
    // Put the star next to alice and step onto it.
    game.star = { x: 1, y: 0 };
    a.signal(TAGS.IN, 'M,1,0');
    await until(() => you?.got);
    assert.equal(you.score, 1);
    // A client cannot send the host's tags: bob never sees this.
    a.signal(TAGS.STATE, { fake: true });
    await wait(300);
    assert.equal(snap.fake, undefined);
    assert.ok(s.server.stats().counters.hostDenied >= 1);
  } finally {
    a.destroy(); b.destroy();
    await s.close();
  }
});
