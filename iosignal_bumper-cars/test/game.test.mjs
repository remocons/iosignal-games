import test from 'node:test';
import assert from 'node:assert/strict';
import { BumperGame } from '../src/game.mjs';
import { RULES, ARENA, CONES, parseInput } from '../public/shared.js';

const run = (g, from, ms) => { let t = from; for (; t < from + ms; t += RULES.TICK_MS) g.step(t); return t; };
function rink() { return new BumperGame({ bots: false, random: () => 0.5 }); }
function car(g, id, x, y, a = 0, now = 1000) {
  const c = g.join(id, id.slice(1), 0, now);
  Object.assign(c, { x, y, a, vx: 0, vy: 0 });
  return c;
}

test('input parsing', () => {
  assert.deepEqual(parseInput('W,100,-50'), { op: 'W', args: ['100', '-50'] });
  assert.deepEqual(parseInput('X'), { op: 'X', args: [] });
  assert.equal(parseInput('?a,W,1,1'), null);
  assert.equal(parseInput('Q'), null);
});

test('driving: the car turns toward the stick and speeds up, but not past the top speed', () => {
  const g = rink();
  const c = car(g, '?a', 4, 4, 0);
  g.handleInput('?a', 'W,0,100', 1000);       // steer down (+y)
  run(g, 1000, 2000);
  assert.ok(Math.abs(c.a - Math.PI / 2) < 0.1, 'facing down');
  assert.ok(c.y > 6, 'moved down');
  assert.ok(Math.hypot(c.vx, c.vy) <= RULES.MAX_SPEED + 1e-9);
  g.handleInput('?a', 'W,0,0', 3000);         // let go: it rolls to a stop
  run(g, 3000, 4000);
  assert.ok(Math.hypot(c.vx, c.vy) < 0.2);
});

test('boost has a cool-down', () => {
  const g = rink();
  const c = car(g, '?a', 4, 4, 0);
  assert.equal(g.handleInput('?a', 'X', 1000), true);
  assert.ok(c.vx > RULES.BOOST * 0.9);
  assert.equal(g.handleInput('?a', 'X', 1500), false);
  assert.equal(g.handleInput('?a', 'X', 1000 + RULES.BOOST_GAP_MS), true);
});

test('a side crash: the driver who hits scores more, the other is spun and pushed away', () => {
  const g = rink();
  const a = car(g, '?a', 3, 10, 0);             // y = 10: a clear lane (no cones, balls or pillars)
  const b = car(g, '?b', 6, 10, Math.PI / 2);  // b faces down: a hits its side
  g.handleInput('?a', 'W,100,0', 1000);
  run(g, 1000, 900);
  const hits = g.drain().filter((e) => e.e === 'hit' && e.k === 'car');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].a, '?a');
  assert.equal(hits[0].b, '?b');
  assert.equal(hits[0].where, 'side');
  assert.ok(a.score >= 5 && b.score === 0);
  assert.ok(b.vx > 1 || b.x > 7, 'b was thrown along the hit');
});

test('combos: quick hits stack, getting hit breaks the streak, one crash scores once', () => {
  const g = rink();
  const a = car(g, '?a', 3, 10, 0);
  car(g, '?b', 4.4, 10, Math.PI / 2);
  car(g, '?c', 3, 3, 0);
  const crash = (now) => {
    // a drives straight into b at 4 units/s
    Object.assign(a, { x: 3, y: 10, vx: 4, vy: 0, a: 0 });
    const b = g.cars.get('?b');
    Object.assign(b, { x: 4.4, y: 10, vx: 0, vy: 0 });
    run(g, now, 300);
  };
  crash(1000);
  crash(2000);                                  // after the pair cool-down, within COMBO_MS
  assert.equal(a.combo, 2);
  const scored = g.drain().filter((e) => e.e === 'hit' && e.k === 'car');
  assert.equal(scored.length, 2, 'each crash once, not every step of contact');
  assert.equal(scored[1].combo, 2);
  assert.ok(scored[1].pts > scored[0].pts, 'the combo scores more');
  // c rams a: a's combo is gone
  const c = g.cars.get('?c');
  Object.assign(c, { x: a.x, y: a.y - 1.3, vx: 0, vy: 5, a: Math.PI / 2 });
  run(g, 3000, 300);
  assert.equal(a.combo, 0);
});

test('walls and pillars bounce cars back', () => {
  const g = rink();
  const c = car(g, '?a', ARENA.W - 1.2, 12, 0);
  c.vx = 5;
  run(g, 1000, 300);
  assert.ok(c.x <= ARENA.W - c.r + 1e-9);
  assert.ok(c.vx < 0, 'bounced off the wall');
  const p = car(g, '?b', 9, 8, 0);              // centre pillar at (12, 8)
  p.vx = 5;
  run(g, 2000, 900);
  assert.ok(p.x < 12 - 1.1 - p.r + 0.05, 'never inside the pillar');
});

test('balls fly and a ball shot into another car scores for the kicker', () => {
  const g = rink();
  const ball = g.balls[0];
  Object.assign(ball, { x: 5, y: 14, vx: 0, vy: 0 });
  const a = car(g, '?a', 3.9, 14, 0);
  const b = car(g, '?b', 9, 14, 0);
  Object.assign(a, { vx: 6 });
  run(g, 1000, 1500);
  const ev = g.drain();
  assert.ok(ev.some((e) => e.e === 'hit' && e.k === 'ball' && e.a === '?a'));
  assert.ok(ev.some((e) => e.e === 'shot' && e.a === '?a' && e.b === '?b'), 'the ball hit b');
  assert.ok(a.score >= 5);
  void b;
});

test('cones get knocked and drift back home', () => {
  const g = rink();
  const cone = g.cones[0];
  Object.assign(cone, { vx: 3, vy: 0 });
  run(g, 1000, 600);
  assert.ok(Math.hypot(cone.x - CONES[0][0], cone.y - CONES[0][1]) > 0.3);
  run(g, 2000, 8000);
  assert.ok(Math.hypot(cone.x - CONES[0][0], cone.y - CONES[0][1]) < 0.15, 'back home');
});

test('bots fill the rink and make room for people', () => {
  const g = new BumperGame({ random: () => 0.37 });
  let t = run(g, 1000, 3000);
  assert.equal(g.cars.size, RULES.MIN_CARS);
  assert.ok([...g.cars.values()].every((c) => c.kind === 'bot'));
  g.join('?a', 'alice', 0, t);
  g.join('?b', 'bob', 1, t);
  t = run(g, t, 3000);
  assert.equal(g.cars.size, RULES.MIN_CARS);
  assert.equal([...g.cars.values()].filter((c) => c.kind === 'bot').length, RULES.MIN_CARS - 2);
  // bots cannot be driven from outside
  assert.equal(g.handleInput('bot1', 'X', t), false);
});

test('rounds: results, then scores reset', () => {
  const g = rink();
  const a = car(g, '?a', 4, 4);
  a.score = 30;
  g.step(1000);
  a.lastSeen = 1000 + RULES.ROUND_MS;            // still playing (heartbeats)
  g.step(1000 + RULES.ROUND_MS);
  assert.equal(g.phase, 'result');
  const end = g.drain().find((e) => e.e === 'round' && e.ph === 'end');
  assert.equal(end.rank[0].id, '?a');
  assert.equal(end.rank[0].score, 30);
  a.lastSeen = 1000 + RULES.ROUND_MS + RULES.RESULT_MS;
  g.step(1000 + RULES.ROUND_MS + RULES.RESULT_MS);
  assert.equal(g.phase, 'play');
  assert.equal(a.score, 0);
});

test('the crash-pair table does not grow forever', () => {
  const g = rink();
  for (let i = 0; i < 500; i++) g.pairAt.set(`?x${i}|?y${i}`, 1000);
  run(g, 1000, RULES.TICK_MS * 301);
  run(g, 7000, RULES.TICK_MS * 301);
  assert.equal(g.pairAt.size, 0);
});

test('snapshot is small; idle players time out', () => {
  const g = new BumperGame();
  run(g, 1000, 2000);
  g.join('?a', 'alice', 0, 3000);
  const s = g.snapshot(3000);
  assert.ok(JSON.stringify(s).length < 900);
  assert.equal(s.c.length, RULES.MIN_CARS);
  g.step(3000 + RULES.TIMEOUT_MS + 1);
  assert.equal(g.cars.has('?a'), false);
});
