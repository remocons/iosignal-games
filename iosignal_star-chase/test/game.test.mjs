// Rules without the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { StarGame } from '../src/game.mjs';
import { RULES } from '../public/shared.js';

test('join, move inside the board, score on the star', () => {
  const g = new StarGame(() => 0);
  assert.equal(g.input('?a', 'J,alice', 0), true);
  assert.equal(g.input('?a', 'J,again', 0), false, 'one join per connection');
  g.star = { x: 1, y: 0 };
  g.input('?a', 'M,-1,0', 0);
  assert.deepEqual(g.snapshot().p[0].slice(1, 3), [0, 0], 'the board edge stops you');
  g.input('?a', 'M,5,0', 0);                       // any number is one step
  assert.equal(g.players.get('?a').score, 1);
  assert.deepEqual(g.results, [['?a', { got: true, score: 1 }]]);
});

test('bad input and strangers are ignored; idle players time out', () => {
  const g = new StarGame(() => 0.5);
  assert.equal(g.input('?x', 'M,1,0', 0), false, 'move before join');
  assert.equal(g.input('?x', 'Z', 0), false, 'unknown op');
  g.input('?a', 'J,<b>x</b>', 0);
  assert.equal(g.players.get('?a').name, 'bxb', 'names keep letters, digits, space, _ and -');
  g.tick(RULES.TIMEOUT_MS + 1);
  assert.equal(g.players.size, 0);
});
