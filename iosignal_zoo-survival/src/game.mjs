// 동물원 생존하기 — authoritative game rules. No networking, so it can be unit-tested.
// The server feeds inputs and the clock in and publishes what comes out:
//   handleInput(cid, text, now), tick(now)   -> this.events (everyone), this.fx (Arduino feedback)
//   snapshot(now), roster()                  -> TAGS.STATE, TAGS.ROSTER
// cid is always the sender as the IOSignal server knows it (host 'message' from.cid).

import {
  RULES, BOTS, SPAWNS, STAGE, STAGES, AVATARS, W, H, setStage,
  tileAt, tileHeight, isSolid, isWater, parseInput, gridDir, cleanName, FLAG,
} from '../public/shared.js';

const dist = (a, b, x, y) => Math.hypot(a - x, b - y);
const r2 = (v) => Math.round(v * 100);
// 8 facings, 0 = +x, counter-clockwise in steps of 45 degrees (world axes).
const faceOf = (dx, dy) => (Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) + 8) % 8;

export class ZooGame {
  constructor({ random = Math.random, stage = 0 } = {}) {
    this.random = random;
    this.players = new Map(); // cid -> player
    this.phase = 'play';      // 'play' | 'next' (someone escaped; the next area loads at nextAt)
    this.nextAt = 0;
    this.escaper = null;
    setStage(stage);
    this.bots = this.makeBots();
    this.mines = [];          // { id, owner, x, y, armAt, expireAt }
    this.nextMineId = 1;
    this.events = [];         // [{ e, ... }] for TAGS.EVT
    this.fx = [];             // [[cid, word]] for Arduino players
    this.rosterDirty = true;
  }

  makeBots() {
    return BOTS.map((def, id) => ({
      id, def, type: def.type, x: def.home[0] + 0.5, y: def.home[1] + 0.5, face: 2,
      alive: true, deadUntil: 0, goal: null, wanderUntil: 0, chasing: false, moving: false,
    }));
  }

  // ---------------- areas ----------------
  // The first animal on an exit tile escapes: bonus, and after NEXT_MS everyone is in the next area.
  escape(p, now) {
    this.phase = 'next';
    this.nextAt = now + RULES.NEXT_MS;
    this.escaper = p.cid;
    p.score += RULES.ESCAPE;
    p.escapes = (p.escapes ?? 0) + 1;
    this.emit({ e: 'escape', cid: p.cid, name: p.name, stage: STAGE, next: (STAGE + 1) % STAGES.length });
    for (const q of this.players.values()) this.fxTo(q.cid, q === p ? 'escape' : 'next');
  }

  loadStage(i, now) {
    setStage(i);
    this.bots = this.makeBots();
    this.mines = [];
    this.phase = 'play';
    this.escaper = null;
    for (const p of this.players.values()) { p.alive = false; this.spawn(p, now); }
    this.emit({ e: 'stage', stage: STAGE, name: STAGES[STAGE].name });
    for (const p of this.players.values()) this.fxTo(p.cid, 'stage');
  }

  emit(evt) { this.events.push(evt); }
  fxTo(cid, word) {
    const p = this.players.get(cid);
    if (p && p.kind === 'ard') this.fx.push([cid, word]);
  }
  drain() {
    const out = { events: this.events, fx: this.fx };
    this.events = [];
    this.fx = [];
    return out;
  }

  // ---------------- players ----------------
  join(cid, kind, name, avatar, now) {
    let p = this.players.get(cid);
    if (p) { p.lastSeen = now; return p; }
    if (this.players.size >= RULES.MAX_PLAYERS) return null;
    p = {
      cid, kind, name, avatar, x: 0, y: 0, z: 0, face: 1, wx: 0, wy: 0, escapes: 0,
      alive: false, deadUntil: now, safeUntil: 0, jumpAt: -1e9, landAt: -1e9,
      score: 0, life: 0, best: 0, kills: 0, deaths: 0, mineAt: -1e9, lastSeen: now, nearAt: 0,
    };
    this.players.set(cid, p);
    this.spawn(p, now);
    this.rosterDirty = true;
    this.emit({ e: 'join', cid, name, kind, avatar });
    this.fxTo(cid, 'join');
    return p;
  }

  leave(cid, reason = 'leave') {
    const p = this.players.get(cid);
    if (!p) return false;
    this.players.delete(cid);
    this.mines = this.mines.filter((m) => m.owner !== cid);
    this.rosterDirty = true;
    this.emit({ e: 'leave', cid, name: p.name, reason });
    return true;
  }

  spawn(p, now) {
    // A free gate tile, a little jitter so players do not stack.
    const free = SPAWNS.filter(([x, y]) => ![...this.players.values()].some((o) => o !== p && o.alive && dist(o.x, o.y, x, y) < 0.6));
    const [x, y] = (free.length ? free : SPAWNS)[Math.floor(this.random() * (free.length || SPAWNS.length))];
    Object.assign(p, {
      x: x + (this.random() - 0.5) * 0.3, y: y + (this.random() - 0.5) * 0.3, z: 0,
      alive: true, safeUntil: now + RULES.SAFE_MS, life: 0, jumpAt: -1e9, landAt: -1e9, wx: 0, wy: 0,
    });
    this.emit({ e: 'spawn', cid: p.cid, x: r2(p.x), y: r2(p.y) });
    this.fxTo(p.cid, 'spawn');
  }

  kill(p, how, by, now) {
    if (!p.alive || now < p.safeUntil || this.phase !== 'play') return false;
    p.alive = false;
    p.deadUntil = now + RULES.RESPAWN_MS;
    p.deaths++;
    p.best = Math.max(p.best, p.life);
    this.emit({ e: 'die', cid: p.cid, name: p.name, how, by, x: r2(p.x), y: r2(p.y) });
    this.fxTo(p.cid, 'die');
    return true;
  }

  airborne(p) { return p.z > RULES.AIR_Z; }

  handleInput(cid, text, now) {
    const msg = parseInput(text);
    if (!cid || !msg) return false;
    const { op, args } = msg;
    if (op === 'J') {
      const kind = ['web', 'ard', 'bot'].includes(args[0]) ? args[0] : 'web';
      const avatar = Math.abs(parseInt(args[2], 10) || 0) % AVATARS.length;
      const fallback = (kind === 'ard' ? 'esp-' : '') + cid.replace(/\W/g, '').slice(-4);
      return !!this.join(cid, kind, cleanName(args[1], fallback), avatar, now);
    }
    const p = this.players.get(cid);
    if (!p) return false;
    p.lastSeen = now;
    if (op === 'L') return this.leave(cid);
    if (op === 'H') return false;
    if (op === 'W') {
      p.wx = Math.max(-100, Math.min(100, parseInt(args[0], 10) || 0)) / 100;
      p.wy = Math.max(-100, Math.min(100, parseInt(args[1], 10) || 0)) / 100;
      return false;
    }
    if (!p.alive) return false;
    if (op === 'U') return this.jump(p, now);
    if (op === 'B') return this.layMine(p, now);
    return false;
  }

  jump(p, now) {
    if (now < p.jumpAt + RULES.JUMP_MS + RULES.JUMP_GAP_MS) return false;
    p.jumpAt = now;
    this.emit({ e: 'jump', cid: p.cid });
    this.fxTo(p.cid, 'jump');
    return true;
  }

  layMine(p, now) {
    const own = this.mines.filter((m) => m.owner === p.cid).length;
    if (own >= RULES.MINE_MAX || now < p.mineAt + RULES.MINE_GAP_MS || this.airborne(p) || isWater(p.x, p.y)) {
      this.fxTo(p.cid, 'nomine');
      return false;
    }
    p.mineAt = now;
    this.mines.push({ id: this.nextMineId++, owner: p.cid, x: p.x, y: p.y, armAt: now + RULES.MINE_ARM_MS, expireAt: now + RULES.MINE_LIFE_MS });
    this.emit({ e: 'mine', cid: p.cid, x: r2(p.x), y: r2(p.y) });
    this.fxTo(p.cid, 'mine');
    return true;
  }

  // Can a body stand at (x, y), coming from ground height fromH? Walls and trees use the body radius.
  canStand(x, y, fromH, air, { water = false } = {}) {
    if (x < 0.3 || y < 0.3 || x > W - 0.3 || y > H - 0.3) return false;
    if (water) return isWater(x, y);
    const rr = RULES.RADIUS;
    for (const [ox, oy] of [[0, 0], [rr, rr], [rr, -rr], [-rr, rr], [-rr, -rr]]) {
      if (isSolid(x + ox, y + oy)) return false;
    }
    return tileHeight(x, y) - fromH <= (air ? 1.0 : RULES.STEP) + 1e-6;
  }

  movePlayer(p, dt, now) {
    const t = (now - p.jumpAt) / RULES.JUMP_MS;
    p.z = t >= 0 && t < 1 ? RULES.JUMP_H * 4 * t * (1 - t) : 0;
    const [wx, wy] = gridDir(p.wx, p.wy);
    if (wx === 0 && wy === 0) { p.moving = false; return; }
    p.moving = true;
    p.face = faceOf(wx, wy);
    const step = RULES.SPEED * dt;
    const air = this.airborne(p);
    const fromH = tileHeight(p.x, p.y);
    // Slide along walls: x and y separately.
    if (this.canStand(p.x + wx * step, p.y, fromH, air)) p.x += wx * step;
    if (this.canStand(p.x, p.y + wy * step, tileHeight(p.x, p.y), air)) p.y += wy * step;
  }

  // ---------------- bots ----------------
  botGoal(bot, now) {
    const d = bot.def;
    let best = null;
    let bestD = d.chase;
    for (const p of this.players.values()) {
      if (!p.alive || now < p.safeUntil || tileAt(p.x, p.y) === 'G') continue; // the gate is a safe zone
      if (dist(p.x, p.y, d.home[0] + 0.5, d.home[1] + 0.5) > d.leash) continue;
      const pd = dist(p.x, p.y, bot.x, bot.y);
      if (pd < bestD) { bestD = pd; best = p; }
    }
    if (best) { bot.chasing = true; return [best.x, best.y]; }
    bot.chasing = false;
    if (!bot.goal || now > bot.wanderUntil || dist(bot.x, bot.y, ...bot.goal) < 0.3) {
      const [x0, y0, x1, y1] = d.zone;
      for (let i = 0; i < 20; i++) {
        const gx = x0 + Math.floor(this.random() * (x1 - x0 + 1)) + 0.5;
        const gy = y0 + Math.floor(this.random() * (y1 - y0 + 1)) + 0.5;
        if (d.water ? isWater(gx, gy) : (!isSolid(gx, gy) && !isWater(gx, gy) && tileAt(gx, gy) !== 'G')) { bot.goal = [gx, gy]; break; }
      }
      bot.wanderUntil = now + 2000 + this.random() * 3000;
    }
    return bot.goal;
  }

  moveBot(bot, dt, now) {
    const d = bot.def;
    const goal = this.botGoal(bot, now);
    bot.moving = false;
    if (!goal) return;
    const gd = dist(goal[0], goal[1], bot.x, bot.y);
    if (gd < 0.05) return;
    const base = Math.atan2(goal[1] - bot.y, goal[0] - bot.x);
    const step = Math.min(gd, (bot.chasing ? d.run : d.walk) * dt);
    const fromH = tileHeight(bot.x, bot.y);
    for (const turn of [0, 0.6, -0.6, 1.2, -1.2, 1.8, -1.8]) {
      const a = base + turn;
      const nx = bot.x + Math.cos(a) * step;
      const ny = bot.y + Math.sin(a) * step;
      const ok = d.water ? isWater(nx, ny) : this.canStand(nx, ny, fromH, false) && !isWater(nx, ny) && tileAt(nx, ny) !== 'G';
      if (ok) {
        bot.x = nx; bot.y = ny;
        bot.face = faceOf(Math.cos(a), Math.sin(a));
        bot.moving = true;
        return;
      }
    }
    bot.wanderUntil = 0; // stuck: pick another place
  }

  // ---------------- mines ----------------
  explode(mine, now) {
    this.emit({ e: 'boom', x: r2(mine.x), y: r2(mine.y), by: mine.owner });
    const owner = this.players.get(mine.owner);
    for (const p of this.players.values()) {
      if (p.z > 0.6 || dist(p.x, p.y, mine.x, mine.y) > RULES.MINE_BLAST) continue;
      if (this.kill(p, 'mine', mine.owner, now) && owner && p !== owner) {
        owner.score += RULES.PLAYER_KILL;
        owner.kills++;
      }
    }
    for (const b of this.bots) {
      if (!b.alive || b.def.water || dist(b.x, b.y, mine.x, mine.y) > RULES.MINE_BLAST) continue;
      b.alive = false;
      b.deadUntil = now + 6000;
      this.emit({ e: 'botdie', id: b.id, type: b.type, by: mine.owner, x: r2(b.x), y: r2(b.y) });
      if (owner) { owner.score += RULES.BOT_KILL; owner.kills++; }
    }
    if (owner) this.fxTo(owner.cid, 'boom');
  }

  // ---------------- clock ----------------
  tick(now, dt = RULES.TICK_MS / 1000) {
    if (this.phase === 'next' && now >= this.nextAt) this.loadStage(STAGE + 1, now);
    for (const p of [...this.players.values()]) {
      if (now - p.lastSeen > RULES.TIMEOUT_MS) { this.leave(p.cid, 'timeout'); continue; }
      if (!p.alive) {
        if (now >= p.deadUntil) this.spawn(p, now);
        continue;
      }
      this.movePlayer(p, dt, now);
      p.life += dt;
      p.score += dt;
      if (!this.airborne(p) && isWater(p.x, p.y)) this.kill(p, 'drown', null, now);
      if (p.alive && this.phase === 'play' && tileAt(p.x, p.y) === 'E') this.escape(p, now);
    }
    if (this.phase === 'next') return; // the area is won: bots and mines rest until the next one

    for (const b of this.bots) {
      if (!b.alive) {
        if (now >= b.deadUntil) {
          Object.assign(b, { alive: true, x: b.def.home[0] + 0.5, y: b.def.home[1] + 0.5, goal: null });
          this.emit({ e: 'botback', id: b.id, type: b.type });
        }
        continue;
      }
      this.moveBot(b, dt, now);
      for (const p of this.players.values()) {
        // A jump higher than the animal passes over it.
        if (p.alive && p.z < b.def.tall && dist(p.x, p.y, b.x, b.y) < b.def.catch) this.kill(p, 'caught', b.type, now);
      }
    }

    // Mines: armed ones go off under anything on the ground (the owner too). Jumping over is safe.
    const left = [];
    for (const m of this.mines) {
      if (now >= m.expireAt) continue;
      let boom = false;
      if (now >= m.armAt) {
        for (const p of this.players.values()) {
          if (p.alive && !this.airborne(p) && dist(p.x, p.y, m.x, m.y) < RULES.MINE_TRIGGER) boom = true;
        }
        for (const b of this.bots) {
          if (b.alive && !b.def.water && dist(b.x, b.y, m.x, m.y) < RULES.MINE_TRIGGER) boom = true;
        }
      }
      if (boom) this.explode(m, now);
      else left.push(m);
    }
    this.mines = left;

    // Arduino radar: a beep when a bot is near.
    for (const p of this.players.values()) {
      if (p.kind !== 'ard' || !p.alive || now - p.nearAt < 1200) continue;
      if (this.bots.some((b) => b.alive && dist(b.x, b.y, p.x, p.y) < RULES.NEAR)) {
        p.nearAt = now;
        this.fxTo(p.cid, 'near');
      }
    }
  }

  // ---------------- output ----------------
  snapshot(now) {
    const owners = [...this.players.keys()];
    return {
      t: now,
      st: STAGE,                                   // area index (STAGES in shared.js)
      ph: this.phase,
      nx: this.phase === 'next' ? this.nextAt - now : 0, // ms until the next area
      esc: this.escaper,
      p: [...this.players.values()].map((p) => [
        p.cid, r2(p.x), r2(p.y), r2(p.z), p.face,
        (p.alive ? 0 : FLAG.DEAD) | (now < p.safeUntil ? FLAG.SAFE : 0) | (p.moving ? FLAG.MOVING : 0)
          | (this.escaper === p.cid ? FLAG.ESCAPED : 0),
        Math.floor(p.score), Math.floor(p.life),
        RULES.MINE_MAX - this.mines.filter((m) => m.owner === p.cid).length,
      ]),
      b: this.bots.map((b) => [b.id, b.type, r2(b.x), r2(b.y), b.face,
        (b.alive ? 0 : FLAG.DEAD) | (b.moving ? FLAG.MOVING : 0) | (b.chasing ? FLAG.CHASING : 0)]),
      m: this.mines.map((m) => [m.id, r2(m.x), r2(m.y), now >= m.armAt ? 1 : 0, owners.indexOf(m.owner)]),
    };
  }

  roster() {
    return { p: [...this.players.values()].map((p) => [p.cid, p.name, p.avatar, p.kind]) };
  }

  ranking() {
    return [...this.players.values()]
      .map((p) => ({ cid: p.cid, name: p.name, score: Math.floor(p.score), kills: p.kills, deaths: p.deaths, best: Math.floor(Math.max(p.best, p.life)) }))
      .sort((a, b) => b.score - a.score);
  }
}

