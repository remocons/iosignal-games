import test from 'node:test';
import assert from 'node:assert/strict';
import { ZooGame } from '../src/game.mjs';
import {
  MAP, W, H, BOTS, SPAWNS, EXITS, RULES, STAGES, STAGE, setStage, tileAt, isSolid, isWater, tileHeight,
  parseInput, screenToWorld, viewToWorld,
} from '../public/shared.js';

// A game with every bot away, and a player placed by hand.
function setup(now = 1000) {
  const g = new ZooGame({ random: () => 0.5 });
  for (const b of g.bots) { b.alive = false; b.deadUntil = Infinity; }
  return g;
}
function place(g, cid, x, y, now) {
  g.handleInput(cid, `J,web,${cid.slice(1)},0`, now);
  const p = g.players.get(cid);
  Object.assign(p, { x, y, safeUntil: 0 });
  return p;
}
const run = (g, from, ms) => { let t = from; for (; t < from + ms; t += RULES.TICK_MS) g.tick(t); return t; };
const DOWN = ['0', '100'];   // grid +y at full speed
const RIGHT = ['100', '0'];  // grid +x

test('map: rectangular, walled, every bot home and spawn usable, ditch is one tile', () => {
  assert.ok(MAP.every((r) => r.length === W));
  // Closed borders: trees, or the river flowing in at the top.
  for (let x = 0; x < W; x++) { assert.ok(isSolid(x, 0) || isWater(x, 0)); assert.ok(isSolid(x, H - 1)); }
  for (let y = 0; y < H; y++) { assert.ok(isSolid(0, y)); assert.ok(isSolid(W - 1, y)); }
  assert.ok(SPAWNS.length >= 6);
  for (const [x, y] of SPAWNS) assert.ok(!isSolid(x, y) && !isWater(x, y));
  for (const b of BOTS) {
    const [x, y] = b.home;
    assert.equal(b.water ? isWater(x, y) : !isSolid(x, y) && !isWater(x, y), true, `${b.type} home`);
  }
  assert.equal(tileAt(17, 18), "-");
  for (let x = 18; x <= 30; x++) { // column 17 is where the river feeds the ditch
    assert.equal(tileAt(x, 18), '-');
    assert.ok(!isWater(x, 17) && !isWater(x, 19), 'the ditch has land on both sides');
  }
  assert.equal(tileHeight(21.5, 3.5), 0.5, 'stairs');
  assert.equal(tileHeight(25.5, 3.5), 2, 'hill top');
});

// Walk (step <= 0.5 up) or jump over one water tile in a straight line (<= 1 up).
function reachable() {
  const start = [Math.floor(SPAWNS[0][0]), Math.floor(SPAWNS[0][1])];
  const seen = new Set([start.join()]);
  const q = [start];
  while (q.length) {
    const [x, y] = q.pop();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      for (const [n, lim] of [[1, 0.5], [2, 1]]) {
        const nx = x + dx * n, ny = y + dy * n;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        if (isSolid(nx + 0.5, ny + 0.5) || isWater(nx + 0.5, ny + 0.5)) continue;
        if (n === 2 && !isWater(x + dx + 0.5, y + dy + 0.5)) continue;
        if (tileHeight(nx + 0.5, ny + 0.5) - tileHeight(x + 0.5, y + 0.5) > lim) continue;
        if (!seen.has(`${nx},${ny}`)) { seen.add(`${nx},${ny}`); q.push([nx, ny]); }
      }
    }
  }
  return seen;
}

test('every area: walled, gates, an exit you can reach, bots at home', () => {
  try {
    STAGES.forEach((stage, i) => {
      setStage(i);
      assert.equal(STAGE, i);
      assert.ok(MAP.every((r) => r.length === W), `${stage.name} rows`);
      for (let y = 0; y < H; y++) assert.ok(isSolid(0, y) && isSolid(W - 1, y), `${stage.name} side walls`);
      for (let x = 0; x < W; x++) assert.ok((isSolid(x, 0) || isWater(x, 0)) && isSolid(x, H - 1), `${stage.name} top/bottom`);
      assert.ok(SPAWNS.length >= 6, `${stage.name} gate`);
      assert.ok(EXITS.length >= 1, `${stage.name} exit`);
      const seen = reachable();
      assert.ok(EXITS.some(([x, y]) => seen.has(`${Math.floor(x)},${Math.floor(y)}`)), `${stage.name}: exit reachable`);
      for (const b of BOTS) {
        const [x, y] = b.home;
        const ok = b.water ? isWater(x + 0.5, y + 0.5) : !isSolid(x + 0.5, y + 0.5) && !isWater(x + 0.5, y + 0.5);
        assert.ok(ok, `${stage.name} ${b.type} home ${x},${y}`);
      }
    });
  } finally { setStage(0); }
});

test('escape: the first animal on the exit scores, then everyone is in the next area', () => {
  const g = setup();
  const [ex, ey] = EXITS[0];
  const a = place(g, '?a', ex - 1, ey, 1000);
  const b = place(g, '?b', 4.5, 20.5, 1000);
  g.mines.push({ id: 1, owner: '?b', x: 10, y: 10, armAt: 0, expireAt: Infinity });
  g.handleInput('?a', `W,${RIGHT}`, 1000);
  run(g, 1000, 400);
  assert.equal(g.phase, 'next');
  assert.equal(g.escaper, '?a');
  assert.ok(a.score >= RULES.ESCAPE);
  const ev = g.drain().events.find((e) => e.e === 'escape');
  assert.equal(ev.next, 1);
  b.x = 25.5; b.y = 17.7;                         // into the ditch: nobody dies between areas
  g.tick(1500);
  assert.equal(b.alive, true);
  assert.equal(g.snapshot(1500).ph, 'next');

  g.tick(1400 + RULES.NEXT_MS + 10);
  assert.equal(STAGE, 1);
  assert.equal(g.phase, 'play');
  assert.equal(g.mines.length, 0);
  assert.deepEqual(g.bots.map((x) => x.type), STAGES[1].bots.map((x) => x.type));
  for (const p of [a, b]) {
    assert.equal(p.alive, true);
    assert.equal(tileAt(p.x, p.y), 'G', 'everyone starts at the new gate');
  }
  assert.equal(g.snapshot(9000).st, 1);
  assert.ok(g.drain().events.some((e) => e.e === 'stage' && e.stage === 1));
  setStage(0);
});

test('input parsing and screen-to-world sticks', () => {
  assert.deepEqual(parseInput('W,10,-20'), { op: 'W', args: ['10', '-20'] });
  assert.equal(parseInput('M,10,-20'), null, 'the old screen-direction input is gone');
  assert.equal(parseInput('?ab,M,1,1'), null);
  assert.equal(parseInput('X'), null);
  const [ux, uy] = screenToWorld(0, -1); // screen up
  assert.ok(ux < 0 && uy < 0 && Math.abs(ux - uy) < 1e-9);
  const [rx, ry] = screenToWorld(1, 0);  // screen right
  assert.ok(rx > 0 && ry < 0);
  assert.deepEqual(screenToWorld(0, 0), [0, 0]);
  // A turned view: the same stick means another grid direction; half a turn is the opposite.
  const [tx, ty] = screenToWorld(0, -1, 2);
  assert.ok(Math.abs(tx + ux) < 1e-9 && Math.abs(ty + uy) < 1e-9);
  const [qx, qy] = screenToWorld(0, -1, 1);
  assert.ok(Math.abs(qx * ux + qy * uy) < 1e-9, 'a quarter turn is perpendicular');
  // Arrow keys / Arduino buttons follow the grid of the view; turned views turn them too.
  assert.deepEqual(viewToWorld(0, -1, 0), [0, -1]);
  assert.deepEqual(viewToWorld(1, 0, 0), [1, 0]);
  for (let turn = 0; turn < 4; turn++) {
    // "up" on the keys = the stick pushed to the screen's up-right (2, -1).
    const [a, b] = viewToWorld(0, -1, turn);
    const [c, d] = screenToWorld(2 / Math.sqrt(5), -1 / Math.sqrt(5), turn);
    assert.ok(Math.abs(a - c) < 1e-9 && Math.abs(b - d) < 1e-9, `turn ${turn}`);
  }
  const [dx, dy] = screenToWorld(-1, 0.5);
  assert.ok(Math.abs(dx) < 1e-9 && Math.abs(dy - 1) < 1e-9);
});

test('walking: trees block, stairs climb, cliffs need a jump', () => {
  const g = setup();
  const p = place(g, '?a', 4.5, 9.5, 1000);      // tree at (3, 9) to the left
  g.handleInput('?a', 'W,-100,0', 1000);        // grid -x
  run(g, 1000, 600);
  assert.ok(p.x > 4 - RULES.RADIUS - 0.01, 'stopped at the tree');
  const q = place(g, '?b', 20.5, 4.5, 1000);    // stairs at (21, 4), hill beyond
  g.handleInput('?b', `W,${RIGHT}`, 1000);
  run(g, 1000, 800);
  assert.ok(tileHeight(q.x, q.y) >= 1, 'walked up the stairs onto the hill');
  const c = place(g, '?c', 23.5, 7.5, 1000);    // below the hill edge at row 6 (height 1), no stairs
  g.handleInput('?c', 'W,-70,-70', 1000);       // grid -x -y
  run(g, 1000, 600);
  assert.equal(tileHeight(c.x, c.y), 0, 'a 1-high cliff blocks walking');
});

test('water drowns, a jump crosses the one-tile ditch', () => {
  const g = setup();
  const a = place(g, '?a', 25.5, 17.7, 1000);
  g.handleInput('?a', `W,${DOWN}`, 1000);
  run(g, 1000, 600);
  assert.equal(a.alive, false);
  assert.ok(g.drain().events.some((e) => e.e === 'die' && e.how === 'drown'));

  const b = place(g, '?b', 22.5, 17.75, 2000);
  g.handleInput('?b', `W,${DOWN}`, 2000);
  g.handleInput('?b', 'U', 2000);
  run(g, 2000, RULES.JUMP_MS + 100);
  g.handleInput('?b', 'W,0,0', 3000);
  assert.equal(b.alive, true);
  assert.ok(b.y > 19, 'landed on the far side');
});

test('mines: arm, blow up whoever steps on them, credit the owner; jumping over is safe', () => {
  const g = setup();
  const a = place(g, '?a', 10.5, 20.5, 1000);
  assert.equal(g.handleInput('?a', 'B', 1000), true);
  assert.equal(g.handleInput('?a', 'B', 1100), false, 'mine gap');
  a.x = 14.5;                                    // walk away
  const b = place(g, '?b', 10.5, 20.5, 1000);    // standing on it before it is armed
  g.tick(1500);
  assert.equal(b.alive, true, 'not armed yet');
  b.x = 9.0;
  g.tick(1000 + RULES.MINE_ARM_MS + 50);
  assert.equal(g.mines.length, 1);

  // Jump over it.
  g.handleInput('?b', `W,${RIGHT}`, 2000);
  g.handleInput('?b', 'U', 2000);
  run(g, 2000, 400);
  assert.equal(b.alive, true);
  assert.equal(g.mines.length, 1, 'still there');
  g.handleInput('?b', 'W,0,0', 2400);
  run(g, 2400, 500);

  // Walk onto it.
  b.x = 10.0; b.y = 20.5;
  g.handleInput('?b', `W,${RIGHT}`, 3000);
  run(g, 3000, 400);
  assert.equal(b.alive, false);
  assert.equal(g.mines.length, 0);
  assert.equal(a.kills, 1);
  assert.ok(a.score >= RULES.PLAYER_KILL);
  assert.ok(g.drain().events.some((e) => e.e === 'boom'));
});

test('mine limit; mines go with a player who leaves', () => {
  const g = setup();
  const a = place(g, '?a', 10.5, 20.5, 1000);
  let t = 1000;
  for (let i = 0; i < 4; i++) { a.x = 8.5 + i; g.handleInput('?a', 'B', t); t += RULES.MINE_GAP_MS; }
  assert.equal(g.mines.length, RULES.MINE_MAX);
  g.leave('?a');
  assert.equal(g.mines.length, 0);
});

test('bots catch players; a fresh spawn is safe; a bot hit by a mine comes back', () => {
  const g = new ZooGame({ random: () => 0.5 });
  const lion = g.bots[0];
  const p = place(g, '?a', lion.x + 0.3, lion.y, 1000);
  g.tick(1050);
  assert.equal(p.alive, false);
  const ev = g.drain().events.find((e) => e.e === 'die');
  assert.equal(ev.how, 'caught');
  assert.equal(ev.by, 'lion');

  g.tick(1000 + RULES.RESPAWN_MS + 100);       // respawned at the gate, safe for a while
  assert.equal(p.alive, true);
  assert.ok(p.safeUntil > 1000 + RULES.RESPAWN_MS);

  const robot = g.bots.find((b) => b.type === 'robot');
  g.mines.push({ id: 99, owner: '?a', x: robot.x, y: robot.y, armAt: 0, expireAt: Infinity });
  g.tick(5000);
  assert.equal(robot.alive, false);
  assert.ok(g.drain().events.some((e) => e.e === 'botdie' && e.type === 'robot'));
  g.tick(5000 + 6100);
  assert.equal(robot.alive, true);
});

test('a jump clears an animal; standing next to it does not', () => {
  for (const type of ['lion', 'gorilla', 'robot']) {
    const g = new ZooGame({ random: () => 0.5 });
    const bot = g.bots.filter((b) => b.type === type).at(-1); // the second lion has open ground behind it
    for (const b of g.bots) if (b !== bot) { b.alive = false; b.deadUntil = Infinity; }
    bot.def = { ...bot.def, walk: 0, run: 0 };       // keep it still
    // Run straight over it with a jump timed so the peak is above it.
    const p = place(g, '?a', bot.x - 1.36, bot.y, 1000);
    g.handleInput('?a', `W,${RIGHT}`, 1000);
    g.handleInput('?a', 'U', 1000);
    run(g, 1000, RULES.JUMP_MS);
    g.handleInput('?a', 'W,0,0', 1000 + RULES.JUMP_MS);
    assert.equal(p.alive, true, `jumped over the ${type}`);
    assert.ok(p.x > bot.x + 0.5, 'landed on the far side');
    const q = place(g, '?b', bot.x - 0.3, bot.y, 2000);
    g.tick(2000);
    assert.equal(q.alive, false, `caught by the ${type} on the ground`);
  }
  for (const def of BOTS) assert.ok(RULES.JUMP_H > def.tall + 0.3, `${def.type} can be jumped`);
});

test('the gate is a safe zone: bots do not chase there or step on it', () => {
  const g = new ZooGame({ random: () => 0.5 });
  const gorilla = g.bots.find((b) => b.type === 'gorilla');
  for (const b of g.bots) if (b !== gorilla) { b.alive = false; b.deadUntil = Infinity; }
  const p = place(g, '?a', 4.5, 19.5, 1000);    // gate tile
  Object.assign(gorilla, { x: 4.5, y: 18.4, goal: null });
  run(g, 1000, 3000);
  assert.equal(p.alive, true);
  assert.notEqual(tileAt(gorilla.x, gorilla.y), 'G');
  p.y = 18.6; p.x = 6.5;                          // off the gate, next to the gorilla
  Object.assign(gorilla, { x: 6.5, y: 17.9 });
  run(g, 4000, 600);
  assert.equal(p.alive, false, 'off the gate it is fair game');
});

test('snapshot and roster', () => {
  const g = setup();
  place(g, '?a', 4.5, 20.5, 1000);
  g.handleInput('?a', 'B', 1000);
  const s = g.snapshot(1000);
  assert.equal(s.p.length, 1);
  assert.equal(s.p[0][0], '?a');
  assert.equal(s.b.length, BOTS.length);
  assert.equal(s.m.length, 1);
  assert.equal(s.m[0][4], 0, 'owner index into p');
  assert.deepEqual(g.roster().p[0], ['?a', 'a', 0, 'web']);
  assert.ok(JSON.stringify(s).length < 1000);
});

test('idle players time out', () => {
  const g = setup();
  place(g, '?a', 4.5, 20.5, 1000);
  g.tick(1000 + RULES.TIMEOUT_MS + 1);
  assert.equal(g.players.size, 0);
});
