// Authoritative game logic for IOSignal Arena (coin tag in a grid maze).
// Pure state machine: no networking here, so it can be unit-tested.
// The server feeds inputs in and broadcasts what comes out:
//   handleInput(cid, text, now) / tick(now) -> push events into this.events / this.fx
//     (cid: the sender as the IOSignal server knows it, never taken from the text)
//   snapshot(now)                       -> object for TAGS.STATE (dynamic fields only)
//   roster()                            -> object for TAGS.ROSTER (static player info)
//   dirty / rosterDirty                 -> set when the next snapshot / roster should go out now

import { COLS, ROWS, RULES, DIRS, MAPS, COLORS, FLAG, isWall, parseInput, sanitizeName } from '../public/protocol.js';

export class ArenaGame {
  constructor({ random = Math.random } = {}) {
    this.random = random;
    this.players = new Map(); // cid -> player
    this.mapIndex = 0;
    this.phase = 'play';      // 'play' | 'end'
    this.phaseEndsAt = 0;
    this.it = null;           // cid of the tagger
    this.coins = new Set();   // cell index y*COLS+x
    this.nextPenaltyAt = 0;
    this.events = [];         // [{ e, ... }] for TAGS.EVT (all clients)
    this.fx = [];             // [[cid, text]] direct feedback for Arduino devices
    this.lastNearAt = new Map();
    this.started = false;
    this.dirty = false;       // visible state changed since the last snapshot
    this.rosterDirty = true;  // players joined/left/renamed since the last roster
  }

  // ---------- helpers ----------
  emit(evt) { this.events.push(evt); this.dirty = true; }

  fxTo(cid, text) {
    const p = this.players.get(cid);
    if (p && p.kind === 'ard') this.fx.push([cid, text]);
  }

  fxAll(text) { for (const p of this.players.values()) this.fxTo(p.cid, text); }

  drain() {
    const out = { events: this.events, fx: this.fx };
    this.events = [];
    this.fx = [];
    return out;
  }

  playerAt(x, y, except) {
    for (const p of this.players.values()) {
      if (p !== except && p.x === x && p.y === y) return p;
    }
    return null;
  }

  freeCells() {
    const cells = [];
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        if (!isWall(this.mapIndex, x, y) && !this.playerAt(x, y) && !this.coins.has(y * COLS + x)) cells.push([x, y]);
      }
    }
    return cells;
  }

  /** Pick the free cell farthest from other players (with a bit of randomness). */
  spawnCell(except) {
    const cells = this.freeCells();
    const others = [...this.players.values()].filter((p) => p !== except && p.x >= 0);
    let best = cells[0];
    let bestScore = -1;
    for (const [x, y] of cells) {
      const d = others.length ? Math.min(...others.map((o) => Math.abs(o.x - x) + Math.abs(o.y - y))) : 10;
      const score = d + this.random() * 4;
      if (score > bestScore) { bestScore = score; best = [x, y]; }
    }
    return best;
  }

  spawnCoin() {
    const cells = this.freeCells();
    if (!cells.length) return;
    const [x, y] = cells[Math.floor(this.random() * cells.length)];
    this.coins.add(y * COLS + x);
  }

  freeColor() {
    const used = new Set([...this.players.values()].map((p) => p.color));
    for (let i = 0; i < COLORS.length; i++) if (!used.has(i)) return i;
    return Math.floor(this.random() * COLORS.length);
  }

  // ---------- round flow ----------
  startRound(now, nextMap = false) {
    if (nextMap) this.mapIndex = (this.mapIndex + 1) % MAPS.length;
    this.phase = 'play';
    this.phaseEndsAt = now + RULES.ROUND_MS;
    this.coins.clear();
    for (const p of this.players.values()) { p.x = -1; p.y = -1; }
    for (const p of this.players.values()) {
      [p.x, p.y] = this.spawnCell(p);
      Object.assign(p, { score: 0, dir: null, pending: null, nextMove: now, dashReadyAt: now, invulnUntil: 0, stunUntil: 0 });
    }
    for (let i = 0; i < RULES.COINS; i++) this.spawnCoin();
    this.it = null;
    this.nextPenaltyAt = now + RULES.IT_PENALTY_MS;
    this.started = true;
    this.emit({ e: 'round', phase: 'start', map: this.mapIndex });
    this.fxAll('start'); // before 'it', so the device resets first and then learns who is the tagger
    this.ensureTagger(now);
  }

  endRound(now) {
    this.phase = 'end';
    this.phaseEndsAt = now + RULES.END_MS;
    const ranking = [...this.players.values()]
      .sort((a, b) => b.score - a.score)
      .map((p) => ({ cid: p.cid, name: p.name, color: p.color, kind: p.kind, score: p.score }));
    this.emit({ e: 'round', phase: 'end', ranking });
    ranking.forEach((r, i) => this.fxTo(r.cid, i === 0 && r.score > 0 ? 'win' : 'end'));
    for (const p of this.players.values()) { p.dir = null; p.pending = null; }
  }

  ensureTagger(now) {
    if (this.players.size < 2) { // nobody to chase: no tagger
      if (this.it) { this.fxTo(this.it, 'free'); this.emit({ e: 'tag', from: null, to: null }); }
      this.it = null;
      return;
    }
    if (this.it && this.players.has(this.it)) return;
    this.it = null;
    if (this.phase !== 'play') return;
    const list = [...this.players.values()];
    const pick = list[Math.floor(this.random() * list.length)];
    this.setTagger(pick, null, now);
  }

  setTagger(target, from, now) {
    const prev = this.it;
    this.it = target.cid;
    target.stunUntil = now + RULES.STUN_MS;
    target.dir = null; target.pending = null;
    this.emit({ e: 'tag', from: from ? from.cid : null, to: target.cid, x: target.x, y: target.y });
    this.fxTo(target.cid, 'it');
    if (prev && prev !== target.cid) this.fxTo(prev, 'free');
  }

  // ---------- players ----------
  join(cid, kind, name, now) {
    let p = this.players.get(cid);
    if (p) {
      if (p.name !== name || p.kind !== kind) this.rosterDirty = true;
      p.name = name; p.kind = kind; p.lastSeen = now;
      return p;
    }
    if (this.players.size >= RULES.MAX_PLAYERS) return null;
    p = { cid, kind, name, color: this.freeColor(), x: -1, y: -1, score: 0, face: 'D',
      dir: null, pending: null, nextMove: now, dashReadyAt: now, invulnUntil: now + RULES.INVULN_MS, stunUntil: 0, lastSeen: now };
    this.players.set(cid, p);
    this.rosterDirty = true;
    [p.x, p.y] = this.spawnCell(p);
    if (!this.started) this.startRound(now);
    this.emit({ e: 'join', cid, name, kind, color: p.color });
    this.fxTo(cid, 'join');
    this.ensureTagger(now);
    return p;
  }

  leave(cid, now, reason = 'leave') {
    const p = this.players.get(cid);
    if (!p) return;
    this.players.delete(cid);
    this.rosterDirty = true;
    this.lastNearAt.delete(cid);
    this.emit({ e: 'leave', cid, name: p.name, reason });
    if (this.it === cid) { this.it = null; this.ensureTagger(now); }
  }

  // ---------- movement ----------
  /** Try to move one cell. Returns 'move' | 'wall' | 'block' | 'tag'. */
  step(p, dirKey, now, quiet = false) {
    const [dx, dy] = DIRS[dirKey];
    const nx = p.x + dx;
    const ny = p.y + dy;
    p.face = dirKey;
    if (isWall(this.mapIndex, nx, ny)) {
      if (!quiet) this.fxTo(p.cid, 'wall');
      return 'wall';
    }
    const other = this.playerAt(nx, ny, p);
    if (other) {
      const pIsIt = this.it === p.cid;
      const oIsIt = this.it === other.cid;
      if (pIsIt && other.invulnUntil <= now) {
        this.tag(p, other, now);
        return 'tag';
      }
      if (oIsIt && p.invulnUntil <= now && other.stunUntil <= now) {
        this.tag(other, p, now);
        return 'tag';
      }
      this.emit({ e: 'bump', a: p.cid, b: other.cid, x: nx, y: ny });
      this.fxTo(p.cid, 'bump');
      this.fxTo(other.cid, 'bump');
      return 'block';
    }
    p.x = nx; p.y = ny;
    this.dirty = true;
    const idx = ny * COLS + nx;
    if (this.coins.has(idx)) {
      this.coins.delete(idx);
      p.score += 1;
      this.emit({ e: 'coin', cid: p.cid, x: nx, y: ny, score: p.score });
      this.fxTo(p.cid, 'coin');
      this.spawnCoin();
    }
    return 'move';
  }

  tag(tagger, target, now) {
    tagger.score += RULES.TAG_BONUS;
    tagger.invulnUntil = now + RULES.INVULN_MS;
    this.setTagger(target, tagger, now);
  }

  dash(p, now) {
    if (now < p.dashReadyAt || now < p.stunUntil) { this.fxTo(p.cid, 'nodash'); return; }
    p.dashReadyAt = now + RULES.DASH_COOLDOWN_MS;
    const from = [p.x, p.y];
    for (let i = 0; i < RULES.DASH_CELLS; i++) {
      if (this.step(p, p.face, now, true) !== 'move') break;
    }
    p.nextMove = now + RULES.STEP_MS;
    this.emit({ e: 'dash', cid: p.cid, from, to: [p.x, p.y] });
    this.fxTo(p.cid, 'dash');
  }

  tryMove(p, now) {
    if (this.phase !== 'play' || now < p.stunUntil || now < p.nextMove) return;
    const d = p.pending || p.dir;
    if (!d) return;
    p.pending = null;
    this.step(p, d, now);
    p.nextMove = now + RULES.STEP_MS;
  }

  // ---------- input ----------
  handleInput(cid, text, now) {
    const msg = parseInput(text);
    if (!cid || !msg) return false;
    const { op, args } = msg;
    if (op === 'J') {
      const kind = ['web', 'ard', 'bot'].includes(args[0]) ? args[0] : 'web';
      const name = sanitizeName(args.slice(1).join(''), (kind === 'ard' ? 'esp-' : 'p-') + cid.replace(/\W/g, '').slice(-4));
      return !!this.join(cid, kind, name, now);
    }
    const p = this.players.get(cid);
    if (!p) return false;
    p.lastSeen = now;
    if (op === 'L') { this.leave(cid, now); return true; }
    if (op === 'H') return true;
    if (this.phase !== 'play') return true;
    if (op === 'D') {
      const d = args[0];
      if (DIRS[d]) {
        p.dir = d; p.face = d; p.pending = d; // pending guarantees one step for a quick tap
        this.tryMove(p, now);
      } else {
        p.dir = null;
      }
      return true;
    }
    if (op === 'A') { this.dash(p, now); return true; }
    return false;
  }

  // ---------- clock ----------
  tick(now) {
    for (const p of [...this.players.values()]) {
      if (now - p.lastSeen > RULES.TIMEOUT_MS) this.leave(p.cid, now, 'timeout');
    }
    if (!this.started) return;

    if (this.phase === 'end') {
      if (now >= this.phaseEndsAt) this.startRound(now, true);
      return;
    }
    if (now >= this.phaseEndsAt) { this.endRound(now); return; }

    for (const p of this.players.values()) this.tryMove(p, now);

    this.ensureTagger(now);
    if (now >= this.nextPenaltyAt) {
      this.nextPenaltyAt = now + RULES.IT_PENALTY_MS;
      const it = this.players.get(this.it);
      if (it && it.score > 0) { it.score -= 1; this.dirty = true; }
    }

    // "Radar" for screenless Arduino players: beep when the tagger is close.
    const it = this.players.get(this.it);
    if (it) {
      for (const p of this.players.values()) {
        if (p === it || p.kind !== 'ard') continue;
        const d = Math.abs(p.x - it.x) + Math.abs(p.y - it.y);
        const last = this.lastNearAt.get(p.cid) || 0;
        if (d <= RULES.NEAR_CELLS && now - last > 700) {
          this.lastNearAt.set(p.cid, now);
          this.fxTo(p.cid, 'near');
        }
      }
    }
  }

  snapshot(now) {
    const p = [];
    for (const pl of this.players.values()) {
      const flags = (pl.invulnUntil > now ? FLAG.INVULN : 0) | (pl.stunUntil > now ? FLAG.STUN : 0);
      p.push([pl.cid, pl.x, pl.y, pl.score, flags, Math.max(0, pl.dashReadyAt - now)]);
    }
    return {
      ph: this.phase,
      map: this.mapIndex,
      left: Math.max(0, this.phaseEndsAt - now),
      it: this.it,
      p,
      c: [...this.coins],
    };
  }

  roster() {
    return { p: [...this.players.values()].map((pl) => [pl.cid, pl.name, pl.color, pl.kind]) };
  }
}
