// 범퍼카 — authoritative physics and scoring. No networking, so it can be unit-tested.
// The server feeds inputs and the clock in and publishes what comes out:
//   handleInput(id, text, now), step(now)  -> this.events (sparks, sounds, scores)
//   snapshot(now), roster()                 -> TAGS.STATE, TAGS.ROSTER
// id is always the sender's CID as the IOSignal server knows it (host 'message' from.cid).

import {
  ARENA, RULES, PILLARS, CONES, BALLS, COLORS, BOT_NAMES, FLAG, parseInput, cleanName,
} from '../public/shared.js';

const r2 = (v) => Math.round(v * 100);
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export class BumperGame {
  constructor({ random = Math.random, bots = true } = {}) {
    this.random = random;
    this.useBots = bots;
    this.cars = new Map();     // id -> car (players and bots)
    this.balls = BALLS.map(([x, y]) => ({ kind: 'ball', x, y, vx: 0, vy: 0, r: RULES.BALL_R, m: RULES.BALL_MASS, spin: 0, last: null }));
    this.cones = CONES.map(([x, y], i) => ({ kind: 'cone', i, x, y, hx: x, hy: y, vx: 0, vy: 0, r: RULES.CONE_R, m: RULES.CONE_MASS, a: 0, hitAt: 0 }));
    this.events = [];
    this.rosterDirty = true;
    this.phase = 'play';       // 'play' | 'result'
    this.roundEnds = 0;
    this.resultEnds = 0;
    this.pairAt = new Map();   // "a|b" -> last scored hit time, so one crash scores once
    this.botSeq = 0;
    this.steps = 0;
  }

  emit(e) { this.events.push(e); }
  drain() { const e = this.events; this.events = []; return e; }

  // ---------------- cars ----------------
  freeSpot() {
    for (let i = 0; i < 40; i++) {
      const x = 1.5 + this.random() * (ARENA.W - 3), y = 1.5 + this.random() * (ARENA.H - 3);
      const clear = [...this.cars.values()].every((c) => Math.hypot(c.x - x, c.y - y) > 2)
        && PILLARS.every(([px, py, pr]) => Math.hypot(px - x, py - y) > pr + 1.2);
      if (clear) return [x, y];
    }
    return [2, 2];
  }

  addCar(id, kind, name, color, now) {
    const [x, y] = this.freeSpot();
    const car = {
      car: true, id, kind, name, color, x, y, vx: 0, vy: 0, a: Math.atan2(ARENA.H / 2 - y, ARENA.W / 2 - x),
      r: RULES.CAR_R, m: RULES.CAR_MASS, ix: 0, iy: 0, boostAt: -1e9, stunUntil: 0, hornAt: -1e9,
      score: 0, combo: 0, comboAt: -1e9, hits: 0, lastSeen: now,
      ai: kind === 'bot' ? { target: null, until: 0, backUntil: 0, from: null, avoid: null, avoidUntil: 0 } : null,
    };
    this.cars.set(id, car);
    this.rosterDirty = true;
    this.emit({ e: 'join', id, name, kind, color });
    return car;
  }

  join(id, name, color, now) {
    const old = this.cars.get(id);
    if (old) { old.lastSeen = now; return old; }
    if ([...this.cars.values()].filter((c) => c.kind !== 'bot').length >= RULES.MAX_PLAYERS) return null;
    return this.addCar(id, 'web', name, color, now);
  }

  leave(id, reason = 'leave') {
    const c = this.cars.get(id);
    if (!c) return false;
    this.cars.delete(id);
    this.rosterDirty = true;
    this.emit({ e: 'leave', id, name: c.name, reason });
    return true;
  }

  // Bots keep a lone driver company: SOLO_BOTS of them while exactly one person drives.
  // A second person sends them all home; an empty rink has none.
  balanceBots(now) {
    if (!this.useBots) return;
    const all = [...this.cars.values()];
    const bots = all.filter((c) => c.kind === 'bot');
    const want = all.length - bots.length === 1 ? RULES.SOLO_BOTS : 0;
    if (bots.length > want) {
      for (const b of bots.slice(want)) this.leave(b.id, 'room');
    } else if (bots.length < want) {
      const n = ++this.botSeq;
      const used = new Set(all.map((c) => c.color));
      const color = [...COLORS.keys()].find((i) => !used.has(i)) ?? n % COLORS.length;
      this.addCar(`bot${n}`, 'bot', BOT_NAMES[(n - 1) % BOT_NAMES.length], color, now);
    }
  }

  handleInput(id, text, now) {
    const msg = parseInput(text);
    if (!id || !msg) return false;
    const { op, args } = msg;
    if (op === 'J') {
      const color = Math.abs(parseInt(args[2], 10) || 0) % COLORS.length;
      return !!this.join(id, cleanName(args[1], 'car-' + id.replace(/\W/g, '').slice(-4)), color, now);
    }
    const c = this.cars.get(id);
    if (!c || c.kind === 'bot') return false;
    c.lastSeen = now;
    if (op === 'L') return this.leave(id);
    if (op === 'W') {
      c.ix = Math.max(-100, Math.min(100, parseInt(args[0], 10) || 0)) / 100;
      c.iy = Math.max(-100, Math.min(100, parseInt(args[1], 10) || 0)) / 100;
      return false;
    }
    if (op === 'X') return this.boost(c, now);
    if (op === 'K') return this.horn(c, now);
    return false;
  }

  boost(c, now) {
    if (now < c.boostAt + RULES.BOOST_GAP_MS) return false;
    c.boostAt = now;
    c.vx += Math.cos(c.a) * RULES.BOOST;
    c.vy += Math.sin(c.a) * RULES.BOOST;
    this.emit({ e: 'boost', id: c.id, x: r2(c.x), y: r2(c.y) });
    return true;
  }

  horn(c, now) {
    if (now < c.hornAt + 600) return false;
    c.hornAt = now;
    this.emit({ e: 'horn', id: c.id });
    return true;
  }

  // ---------------- bots ----------------
  think(bot, now) {
    const ai = bot.ai;
    // Just crashed: back away for a moment instead of grinding against the other car.
    if (now < ai.backUntil && ai.from) {
      const dx = bot.x - ai.from[0], dy = bot.y - ai.from[1], l = Math.hypot(dx, dy) || 1;
      bot.ix = dx / l; bot.iy = dy / l;
      return;
    }
    const others = [...this.cars.values()].filter((c) => c !== bot && !(c.id === ai.avoid && now < ai.avoidUntil));
    const gone = ai.target?.car && !this.cars.has(ai.target.id);
    const arrived = ai.target?.kind === 'spot' && Math.hypot(ai.target.x - bot.x, ai.target.y - bot.y) < 1.5;
    if (!ai.target || now > ai.until || gone || arrived) {
      const roll = this.random();
      if (roll < 0.15) ai.target = this.balls[Math.floor(this.random() * this.balls.length)];
      else if (roll < 0.3) {
        // Cruise somewhere else on the rink for a moment, so the cars do not all bunch up.
        ai.target = { kind: 'spot', x: 2 + this.random() * (ARENA.W - 4), y: 2 + this.random() * (ARENA.H - 4), vx: 0, vy: 0 };
      } else {
        // One of the two nearest cars, people a little preferred.
        const near = others
          .map((o) => [o, Math.hypot(o.x - bot.x, o.y - bot.y) * (o.kind === 'bot' ? 1.3 : 1)])
          .sort((p, q) => p[1] - q[1]).slice(0, 2);
        ai.target = near.length ? near[Math.floor(this.random() * near.length)][0] : null;
      }
      ai.until = now + 2000 + this.random() * 2500;
    }
    const t = ai.target;
    if (!t) { bot.ix = bot.iy = 0; return; }
    let dx = t.x + t.vx * 0.35 - bot.x, dy = t.y + t.vy * 0.35 - bot.y;
    // Steer round pillars ahead.
    for (const [px, py, pr] of PILLARS) {
      const ax = px - bot.x, ay = py - bot.y;
      const ahead = ax * Math.cos(bot.a) + ay * Math.sin(bot.a);
      const side = -ax * Math.sin(bot.a) + ay * Math.cos(bot.a);
      if (ahead > 0 && ahead < 2.4 && Math.abs(side) < pr + RULES.CAR_R + 0.2) {
        const s = side > 0 ? -1 : 1;
        dx += -Math.sin(bot.a) * s * 3; dy += Math.cos(bot.a) * s * 3;
      }
    }
    const len = Math.hypot(dx, dy) || 1;
    const sp = 0.75 + this.random() * 0.2;
    bot.ix = (dx / len) * sp; bot.iy = (dy / len) * sp;
    const dist = Math.hypot(t.x - bot.x, t.y - bot.y);
    const off = Math.abs(wrap(Math.atan2(dy, dx) - bot.a));
    if (t.car && dist < 4.5 && off < 0.3 && this.random() < 0.08) this.boost(bot, now);
  }

  // ---------------- physics ----------------
  drive(c, dt, now) {
    const mag = Math.min(1, Math.hypot(c.ix, c.iy));
    const driving = mag > 0.15 && now >= c.stunUntil;
    c.driving = driving;
    if (driving) {
      const want = Math.atan2(c.iy, c.ix);
      const diff = wrap(want - c.a);
      c.a = wrap(c.a + Math.max(-RULES.TURN * dt, Math.min(RULES.TURN * dt, diff)));
      const push = RULES.ACCEL * mag * Math.max(0.25, Math.cos(diff)) * dt;
      c.vx += Math.cos(c.a) * push; c.vy += Math.sin(c.a) * push;
    }
    // Grip: sideways speed fades fast, forward speed slowly.
    const hx = Math.cos(c.a), hy = Math.sin(c.a);
    const f = c.vx * hx + c.vy * hy;
    const s = -c.vx * hy + c.vy * hx;
    const s2 = s * Math.exp(-RULES.GRIP * dt);
    c.vx = f * hx - s2 * hy; c.vy = f * hy + s2 * hx;
    const drag = Math.exp(-RULES.DRAG * dt);
    c.vx *= drag; c.vy *= drag;
    const sp = Math.hypot(c.vx, c.vy);
    const cap = now - c.boostAt < 600 ? RULES.MAX_SPEED * 1.8 : RULES.MAX_SPEED;
    if (sp > cap) { c.vx *= cap / sp; c.vy *= cap / sp; }
  }

  bodies() { return [...this.cars.values(), ...this.balls, ...this.cones]; }

  walls(b) {
    const e = b.kind === 'ball' ? RULES.BALL_BOUNCE : RULES.WALL_BOUNCE;
    let hit = 0;
    if (b.x < b.r) { b.x = b.r; if (b.vx < 0) { hit = -b.vx; b.vx = -b.vx * e; } }
    if (b.x > ARENA.W - b.r) { b.x = ARENA.W - b.r; if (b.vx > 0) { hit = b.vx; b.vx = -b.vx * e; } }
    if (b.y < b.r) { b.y = b.r; if (b.vy < 0) { hit = Math.max(hit, -b.vy); b.vy = -b.vy * e; } }
    if (b.y > ARENA.H - b.r) { b.y = ARENA.H - b.r; if (b.vy > 0) { hit = Math.max(hit, b.vy); b.vy = -b.vy * e; } }
    for (const [px, py, pr] of PILLARS) {
      const dx = b.x - px, dy = b.y - py, d = Math.hypot(dx, dy), min = pr + b.r;
      if (d < min && d > 1e-6) {
        const nx = dx / d, ny = dy / d;
        b.x = px + nx * min; b.y = py + ny * min;
        const vn = b.vx * nx + b.vy * ny;
        if (vn < 0) { hit = Math.max(hit, -vn); b.vx -= (1 + e) * vn * nx; b.vy -= (1 + e) * vn * ny; }
      }
    }
    if (b.kind !== 'cone' && hit > 2) this.emit({ e: 'hit', k: 'wall', a: b.car ? b.id : null, x: r2(b.x), y: r2(b.y), p: r2(hit) / 100 });
  }

  collide(a, b, now) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const d = Math.hypot(dx, dy), min = a.r + b.r;
    if (d >= min || d < 1e-6) return;
    const nx = dx / d, ny = dy / d;
    const ia = 1 / a.m, ib = 1 / b.m;
    // Push apart.
    const push = (min - d) / (ia + ib);
    a.x -= nx * push * ia; a.y -= ny * push * ia;
    b.x += nx * push * ib; b.y += ny * push * ib;
    const rel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
    if (rel >= 0) return; // already parting
    const cars = a.car && b.car;
    // Approach speeds before the bounce: who drove into whom.
    const intoB = a.vx * nx + a.vy * ny;
    const intoA = -(b.vx * nx + b.vy * ny);
    const e = cars ? RULES.BOUNCE : a.kind === 'ball' || b.kind === 'ball' ? RULES.BALL_BOUNCE : 0.7;
    const j = (-(1 + e) * rel) / (ia + ib);
    a.vx -= j * ia * nx; a.vy -= j * ia * ny;
    b.vx += j * ib * nx; b.vy += j * ib * ny;
    const power = -rel;
    const cx = r2(a.x + nx * a.r), cy = r2(a.y + ny * a.r);
    if (cars) this.carHit(a, b, nx, ny, power, intoB, intoA, cx, cy, now);
    else this.thingHit(a, b, power, cx, cy, now);
  }

  // Car crash: the car driving into the other scores; side and rear hits and combos score more.
  carHit(a, b, nx, ny, power, intoB, intoA, x, y, now) {
    if (power < RULES.HIT_MIN) return;
    const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
    if (now - (this.pairAt.get(key) ?? -1e9) < 800) return;
    this.pairAt.set(key, now);
    const [hitter, victim, dir] = intoB >= intoA ? [a, b, 1] : [b, a, -1];
    const tx = nx * dir, ty = ny * dir;         // from hitter to victim
    const facing = Math.cos(victim.a) * tx + Math.sin(victim.a) * ty;
    const where = facing > 0.55 ? 'rear' : facing < -0.55 ? 'front' : 'side';
    hitter.combo = now - hitter.comboAt < RULES.COMBO_MS ? Math.min(RULES.COMBO_MAX, hitter.combo + 1) : 1;
    victim.combo = 0; // getting hit breaks your streak
    hitter.comboAt = now;
    // Harder is better, side and rear hits more, and each combo step adds 2.
    const mult = where === 'side' ? 1.5 : where === 'rear' ? 1.3 : 1;
    const pts = Math.min(RULES.HIT_MAX_PTS, Math.max(1, Math.round(power * 1.1 * mult) + (hitter.combo - 1) * 2));
    if (this.phase === 'play') { hitter.score += pts; hitter.hits++; }
    victim.stunUntil = now + 350;
    victim.a = wrap(victim.a + (this.random() - 0.5) * 1.2); // spun a little
    this.emit({ e: 'hit', k: 'car', a: hitter.id, b: victim.id, x, y, p: Math.round(power * 10) / 10, pts, where, combo: hitter.combo });
    if (victim.kind === 'bot' && this.random() < 0.1) this.horn(victim, now);
    // Bots: the hitter backs off and looks for someone else; the victim sometimes wants revenge.
    if (hitter.ai) Object.assign(hitter.ai, { backUntil: now + 650, from: [victim.x, victim.y], until: 0, avoid: victim.id, avoidUntil: now + 2500 });
    if (victim.ai) {
      Object.assign(victim.ai, { backUntil: now + 400, from: [hitter.x, hitter.y] });
      if (this.random() < 0.5) Object.assign(victim.ai, { target: hitter, until: now + 2500 });
    }
  }

  thingHit(a, b, power, x, y, now) {
    const car = a.car ? a : b.car ? b : null;
    const thing = car === a ? b : a;
    if (thing.kind === 'ball') {
      if (car) {
        thing.last = car.id;
        thing.spin += power * (this.random() < 0.5 ? -1 : 1);
        if (power > 1) this.emit({ e: 'hit', k: 'ball', a: car.id, x, y, p: Math.round(power * 10) / 10 });
        // A ball someone else sent flying into a car: a "shot" for whoever kicked it.
        const kicker = thing.prev && thing.prev !== car.id ? this.cars.get(thing.prev) : null;
        if (kicker && power > 2.5 && this.phase === 'play') {
          kicker.score += 5;
          this.emit({ e: 'shot', a: kicker.id, b: car.id, x, y, pts: 5 });
        }
        thing.prev = car.id;
      } else if (power > 1) {
        this.emit({ e: 'hit', k: 'ball', a: null, x, y, p: Math.round(power * 10) / 10 });
      }
    } else if (thing.kind === 'cone' && power > 1.5 && now - thing.hitAt > 500) {
      thing.hitAt = now;
      thing.a += (this.random() - 0.5) * 2;
      if (car && power > 2 && this.phase === 'play') car.score += 1;
      this.emit({ e: 'hit', k: 'cone', a: car?.id ?? null, x, y, p: Math.round(power * 10) / 10, pts: car && power > 2 ? 1 : 0 });
    }
  }

  step(now, dt = RULES.TICK_MS / 1000) {
    this.steps++;
    // Rounds
    if (!this.roundEnds) this.roundEnds = now + RULES.ROUND_MS;
    if (this.phase === 'play' && now >= this.roundEnds) {
      this.phase = 'result';
      this.resultEnds = now + RULES.RESULT_MS;
      this.emit({ e: 'round', ph: 'end', rank: this.ranking().slice(0, 5) });
    } else if (this.phase === 'result' && now >= this.resultEnds) {
      this.phase = 'play';
      this.roundEnds = now + RULES.ROUND_MS;
      for (const c of this.cars.values()) { c.score = 0; c.hits = 0; c.combo = 0; }
      this.emit({ e: 'round', ph: 'start' });
    }

    for (const c of [...this.cars.values()]) {
      if (c.kind !== 'bot' && now - c.lastSeen > RULES.TIMEOUT_MS) this.leave(c.id, 'timeout');
    }
    if (this.steps % 15 === 0) this.balanceBots(now);
    // Forget old crash pairs (cars that left, crashes long ago) so the table does not grow forever.
    if (this.steps % 300 === 0) for (const [k, at] of this.pairAt) if (now - at > 5000) this.pairAt.delete(k);

    for (const c of this.cars.values()) {
      if (c.ai) this.think(c, now);
      this.drive(c, dt, now);
    }
    for (const b of this.balls) {
      const k = Math.exp(-RULES.BALL_DRAG * dt);
      b.vx *= k; b.vy *= k; b.spin *= Math.exp(-0.8 * dt);
    }
    for (const o of this.cones) {
      const k = Math.exp(-RULES.CONE_DRAG * dt);
      o.vx = o.vx * k + (o.hx - o.x) * RULES.CONE_HOME * dt;
      o.vy = o.vy * k + (o.hy - o.y) * RULES.CONE_HOME * dt;
      o.a *= Math.exp(-1.5 * dt);
    }
    const all = this.bodies();
    for (const b of all) { b.x += b.vx * dt; b.y += b.vy * dt; }
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) this.collide(all[i], all[j], now);
    }
    for (const b of all) this.walls(b);
  }

  // ---------------- output ----------------
  snapshot(now) {
    return {
      t: now,
      ph: this.phase,
      left: Math.max(0, (this.phase === 'play' ? this.roundEnds : this.resultEnds) - now),
      c: [...this.cars.values()].map((c) => [
        c.id, r2(c.x), r2(c.y), r2(c.a),
        (now - c.boostAt < 500 ? FLAG.BOOST : 0) | (c.driving ? FLAG.DRIVING : 0)
          | (now < c.stunUntil ? FLAG.STUN : 0) | (now - c.hornAt < 400 ? FLAG.HORN : 0),
        c.score, now - c.comboAt < RULES.COMBO_MS ? c.combo : 0, c.hits,
      ]),
      b: this.balls.map((b) => [r2(b.x), r2(b.y), r2(b.spin)]),
      o: this.cones.map((o) => [r2(o.x), r2(o.y), r2(o.a)]),
    };
  }

  roster() {
    return { c: [...this.cars.values()].map((c) => [c.id, c.name, c.color, c.kind]) };
  }

  ranking() {
    return [...this.cars.values()].map((c) => ({ id: c.id, name: c.name, color: c.color, kind: c.kind, score: c.score, hits: c.hits }))
      .sort((a, b) => b.score - a.score);
  }
}
