import test from 'node:test';
import assert from 'node:assert/strict';
import { ArenaGame } from '../src/game.mjs';
import { MAPS, COLS, ROWS, RULES, isWall, parseInput, formatInput, sanitizeName } from '../public/protocol.js';

test('maps are 21x15, walled and fully connected', () => {
  MAPS.forEach((map, mi) => {
    assert.equal(map.rows.length, ROWS, `${map.name} rows`);
    map.rows.forEach((r, y) => assert.equal(r.length, COLS, `${map.name} row ${y}`));
    for (let x = 0; x < COLS; x++) assert.ok(isWall(mi, x, 0) && isWall(mi, x, ROWS - 1));
    for (let y = 0; y < ROWS; y++) assert.ok(isWall(mi, 0, y) && isWall(mi, COLS - 1, y));
    const floor = [];
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) if (!isWall(mi, x, y)) floor.push(y * COLS + x);
    const seen = new Set([floor[0]]);
    const queue = [floor[0]];
    while (queue.length) {
      const c = queue.shift();
      const x = c % COLS, y = (c - x) / COLS;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const n = (y + dy) * COLS + x + dx;
        if (!isWall(mi, x + dx, y + dy) && !seen.has(n)) { seen.add(n); queue.push(n); }
      }
    }
    assert.equal(seen.size, floor.length, `${map.name} connected`);
  });
});

test('input parsing', () => {
  assert.deepEqual(parseInput(formatInput('D', 'U')), { op: 'D', args: ['U'] });
  assert.deepEqual(parseInput('H'), { op: 'H', args: [] });
  assert.equal(parseInput('nonsense'), null);
  assert.equal(parseInput('X,1'), null);
  assert.equal(parseInput('?ab1,D,U'), null); // the old "<cid>,OP" format is not accepted
  assert.equal(sanitizeName('<b>홍길동</b>!!'), 'b홍길동b');
});

function place(game, cid, x, y) {
  const p = game.players.get(cid);
  p.x = x; p.y = y;
  return p;
}

test('join, move one cell per tap, wall stays', () => {
  const g = new ArenaGame({ random: () => 0.5 });
  let now = 1000;
  g.handleInput('?a', 'J,web,alice', now);
  const a = place(g, '?a', 1, 1);
  g.coins.clear();
  g.handleInput('?a', 'D,R', now);
  g.handleInput('?a', 'D,0', now + 10);
  assert.deepEqual([a.x, a.y], [2, 1]);
  now += 500; g.tick(now);
  assert.deepEqual([a.x, a.y], [2, 1], 'released: no more steps');
  g.handleInput('?a', 'D,U', now); // wall above
  assert.deepEqual([a.x, a.y], [2, 1]);
});

test('coin pickup scores and respawns', () => {
  const g = new ArenaGame({ random: () => 0.3 });
  const now = 1000;
  g.handleInput('?a', 'J,ard,esp', now);
  place(g, '?a', 1, 1);
  g.coins.clear();
  g.coins.add(1 * COLS + 2);
  g.drain();
  g.handleInput('?a', 'D,R', now);
  const p = g.players.get('?a');
  assert.equal(p.score, 1);
  assert.equal(g.coins.size, 1, 'respawned');
  const { events, fx } = g.drain();
  assert.ok(events.some((e) => e.e === 'coin'));
  assert.deepEqual(fx, [['?a', 'coin']], 'arduino gets direct fx');
});

test('tagging transfers "it", gives bonus, invuln and stun', () => {
  const g = new ArenaGame({ random: () => 0 });
  let now = 1000;
  g.handleInput('?a', 'J,web,a', now);
  g.handleInput('?b', 'J,ard,b', now);
  now += RULES.INVULN_MS + 10;
  g.it = '?a';
  const a = place(g, '?a', 1, 1);
  const b = place(g, '?b', 2, 1);
  a.stunUntil = 0; b.invulnUntil = 0;
  g.drain();
  g.handleInput('?a', 'D,R', now);
  assert.equal(g.it, '?b');
  assert.equal(a.score, RULES.TAG_BONUS);
  assert.ok(a.invulnUntil > now && b.stunUntil > now);
  assert.deepEqual([a.x, b.x], [1, 2], 'nobody overlaps');
  const { fx } = g.drain();
  assert.deepEqual(fx, [['?b', 'it']]);
  // b is stunned and a is invulnerable -> no tag back
  g.handleInput('?b', 'D,L', now + 10);
  assert.equal(g.it, '?b');
});

test('dash moves up to 3 cells and has a cooldown', () => {
  const g = new ArenaGame({ random: () => 0.5 });
  const now = 1000;
  g.handleInput('?a', 'J,web,a', now);
  const a = place(g, '?a', 1, 3);
  g.coins.clear();
  a.face = 'R';
  g.handleInput('?a', 'A', now);
  assert.deepEqual([a.x, a.y], [4, 3]);
  g.handleInput('?a', 'A', now + 100);
  assert.deepEqual([a.x, a.y], [4, 3], 'cooldown');
});

test('timeout removes player and round cycles to next map', () => {
  const g = new ArenaGame();
  let now = 1000;
  g.handleInput('?a', 'J,web,a', now);
  g.handleInput('?b', 'J,web,b', now);
  assert.ok(g.it);
  now += RULES.TIMEOUT_MS + 1;
  g.handleInput('?a', 'H', now);
  g.tick(now);
  assert.equal(g.players.size, 1);
  assert.equal(g.it, null, 'no tagger with one player');
  g.handleInput('?a', 'H', g.phaseEndsAt);
  g.tick(g.phaseEndsAt);
  assert.equal(g.phase, 'end');
  const t = g.phaseEndsAt;
  g.handleInput('?a', 'H', t);
  g.tick(t);
  assert.equal(g.phase, 'play');
  assert.equal(g.mapIndex, 1);
});

test('arduino gets "start" before "it" on a new round', () => {
  const g = new ArenaGame({ random: () => 0 });
  g.handleInput('?a', 'J,ard,a', 1000);
  g.handleInput('?b', 'J,ard,b', 1000);
  g.drain();
  g.endRound(2000);
  g.drain();
  for (const cid of ['?a', '?b']) g.handleInput(cid, `H`, g.phaseEndsAt);
  g.tick(g.phaseEndsAt);
  const fx = g.drain().fx.map(([cid, t]) => `${cid}:${t}`);
  const it = g.it;
  assert.ok(fx.indexOf(`${it}:start`) < fx.indexOf(`${it}:it`), fx.join(' '));
});
