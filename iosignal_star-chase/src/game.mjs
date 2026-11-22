// Rules only: no network, so tests can drive it directly.
import { RULES, parseInput } from '../public/shared.js';

export class StarGame {
  constructor(random = Math.random) {
    this.random = random;
    this.players = new Map(); // cid -> { name, x, y, score, seen }
    this.star = this.spot();
    this.rosterDirty = true;
    this.results = [];        // [cid, payload] for host.to()
  }
  spot() { return { x: Math.floor(this.random() * RULES.W), y: Math.floor(this.random() * RULES.H) }; }

  input(cid, text, now) {
    const msg = parseInput(text);
    if (!msg) return false;
    const p = this.players.get(cid);
    if (msg.op === 'J') {
      if (p || this.players.size >= RULES.MAX_PLAYERS) return false;
      const name = String(msg.args[0] ?? '').replace(/[^\p{L}\p{N} _-]/gu, '').slice(0, 10) || cid.slice(-4);
      this.players.set(cid, { name, ...this.spot(), score: 0, seen: now });
      this.rosterDirty = true;
      return true;
    }
    if (!p) return false;
    p.seen = now;
    if (msg.op === 'M') {
      const dx = Math.sign(Number(msg.args[0]) || 0), dy = Math.sign(Number(msg.args[1]) || 0);
      p.x = Math.max(0, Math.min(RULES.W - 1, p.x + dx));
      p.y = Math.max(0, Math.min(RULES.H - 1, p.y + dy));
      if (p.x === this.star.x && p.y === this.star.y) {
        p.score++;
        this.star = this.spot();
        this.results.push([cid, { got: true, score: p.score }]);
      }
    }
    return true;
  }
  leave(cid) { if (this.players.delete(cid)) this.rosterDirty = true; }
  tick(now) { for (const [cid, p] of this.players) if (now - p.seen > RULES.TIMEOUT_MS) this.leave(cid); }
  roster() { return { p: [...this.players].map(([cid, p]) => [cid, p.name]) }; }
  // Short arrays, not objects with long keys: every subscriber gets this 10 times a second.
  snapshot() { return { s: [this.star.x, this.star.y], p: [...this.players].map(([cid, p]) => [cid, p.x, p.y, p.score]) }; }
}
