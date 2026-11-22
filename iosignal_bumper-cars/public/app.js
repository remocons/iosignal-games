// 범퍼카 — browser client. Draws the rink from host snapshots, plays sparks and gentle sounds
// for host events, and sends the stick and buttons. ?watch = big screen (whole rink + QR).
import {
  TAGS, ARENA, RULES, PILLARS, COLORS, COLOR_NAMES, C, R, FLAG, formatInput,
} from './shared.js';
import { mountGameKit } from './kit/kit.js';

const $ = (id) => document.getElementById(id);
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const lerp = (a, b, k) => a + (b - a) * k;
const lerpAngle = (a, b, k) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * k;

// ---------------------------------------------------------------- state
let mode = 'start';   // 'start' | 'play' | 'watch'
let joined = false;
let myName = store.get('bump.name') || '';
let myColor = Number(store.get('bump.color') ?? Math.floor(Math.random() * COLORS.length)) % COLORS.length;
const roster = new Map();  // id -> [id, name, color, kind]
const cars = new Map();    // id -> display state
let balls = [], cones = [], prevBalls = [], prevCones = [], snapAt = 0;
const ballSpin = [0, 0, 0];
let snap = null;
const particles = [];
const floaters = [];
const feed = [];
let shake = 0;

// ---------------------------------------------------------------- canvas
const canvas = $('view');
const ctx = canvas.getContext('2d');
let cw = 0, ch = 0, dpr = 1;
function resize() {
  dpr = Math.min(2, devicePixelRatio || 1);
  cw = innerWidth; ch = innerHeight;
  canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr);
}
addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------- IOSignal
// Relative to the page, so the game also works under a proxy sub path (lab.iosignal.net/games/<name>/ -> …/ws).
const wsURL = new URL('ws', location.href);
wsURL.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
const io = new IO(wsURL.href);
const send = (op, ...args) => { if (io.stateName === 'ready') io.signal(TAGS.IN, formatInput(op, ...args)); };
const sendJoin = () => send('J', 'web', myName, myColor);
// IOSignal game kit: brand badge, connection chip (state, round trip, players), join dialog with QR.
const kit = mountGameKit({ io, title: '범퍼카' });
io.on('ready', () => {
  io.subscribe(`${TAGS.ROSTER},${TAGS.STATE},${TAGS.EVT}`);
  if (joined) sendJoin(); // a reconnect has a new CID
});
io.on('message', (tag, data) => {
  if (tag === TAGS.STATE) onSnapshot(data);
  else if (tag === TAGS.ROSTER) {
    roster.clear(); for (const r of data.c) roster.set(r[R.ID], r);
    kit.setRoster(data.c.map((r) => r[R.KIND]));
  }
  else if (tag === TAGS.EVT) for (const e of data.ev) onEvent(e);
});
setInterval(() => { if (joined) send('H'); }, RULES.HEARTBEAT_MS);

function onSnapshot(s) {
  const now = performance.now();
  const seen = new Set();
  for (const c of s.c) {
    const id = c[C.ID];
    seen.add(id);
    const x = c[C.X] / 100, y = c[C.Y] / 100, a = c[C.A] / 100;
    let e = cars.get(id);
    if (!e) { e = { x, y, a, fx: x, fy: y, fa: a, tx: x, ty: y, ta: a, t0: now, wob: 0 }; cars.set(id, e); }
    else { e.fx = e.x; e.fy = e.y; e.fa = e.a; e.tx = x; e.ty = y; e.ta = a; e.t0 = now; }
    e.flags = c[C.FLAGS]; e.score = c[C.SCORE]; e.combo = c[C.COMBO]; e.hits = c[C.HITS];
  }
  for (const id of cars.keys()) if (!seen.has(id)) cars.delete(id);
  prevBalls = balls.length ? balls.map((b) => [...b]) : s.b.map((b) => [b[0] / 100, b[1] / 100]);
  prevCones = cones.length ? cones.map((o) => [...o]) : s.o.map((o) => [o[0] / 100, o[1] / 100, o[2] / 100]);
  balls = s.b.map((b) => [b[0] / 100, b[1] / 100, b[2] / 100]);
  cones = s.o.map((o) => [o[0] / 100, o[1] / 100, o[2] / 100]);
  snapAt = now;
  snap = s;
  updateHud();
}

// ---------------------------------------------------------------- events: sparks, words, sound
const nameOf = (id) => roster.get(id)?.[R.NAME] ?? '?';
const colorOf = (id) => COLORS[roster.get(id)?.[R.COLOR] ?? 0];
const WHERE = { side: '옆구리!', rear: '뒤에서 쿵!', front: '정면 충돌!' };

function addFeed(html) {
  feed.unshift(html);
  feed.length = Math.min(feed.length, 12);
  if (mode === 'watch') $('feed').innerHTML = feed.map((f) => `<li>${f}</li>`).join('');
}

function onEvent(ev) {
  const x = ev.x / 100, y = ev.y / 100;
  const mineA = ev.a === io.cid, mineB = ev.b === io.cid;
  const vol = hearing(x, y);
  switch (ev.e) {
    case 'hit':
      if (ev.k === 'car') {
        sparks(x, y, Math.min(40, 10 + ev.p * 5), ['#fff6a8', '#ffd23f', '#ffffff', colorOf(ev.a)]);
        float(x, y - 0.6, `+${ev.pts}`, colorOf(ev.a), 1 + Math.min(1, ev.pts / 15));
        // Words only for the moments worth reading: a side or rear hit, or a combo.
        if (ev.where !== 'front' && (ev.pts >= 6 || ev.combo > 1)) float(x, y - 1.2, ev.combo > 1 ? `${WHERE[ev.where]} x${ev.combo}` : WHERE[ev.where], '#ffffff', 0.8);
        for (const id of [ev.a, ev.b]) { const c = cars.get(id); if (c) c.wob = 1; }
        sfx('bump', vol, ev.p);
        sfx('zap', vol * 0.6);
        if (ev.combo > 1 && mineA) sfx('combo', 1, ev.combo);
        if (mineA || mineB) shake = Math.max(shake, mineB ? 10 : 6);
        if (ev.pts >= 10 || ev.combo >= 3) addFeed(`💥 <b style="color:${colorOf(ev.a)}">${esc(nameOf(ev.a))}</b> → ${esc(nameOf(ev.b))} +${ev.pts}${ev.combo > 1 ? ` (콤보 x${ev.combo})` : ''}`);
      } else if (ev.k === 'ball') {
        sparks(x, y, 8, ['#ffffff', '#7ce7ff']);
        sfx('ball', vol, ev.p);
      } else if (ev.k === 'cone') {
        sparks(x, y, 6, ['#ff9f43', '#ffffff']);
        if (ev.pts) float(x, y - 0.5, '+1', '#ff9f43', 0.7);
        sfx('cone', vol);
      } else if (ev.k === 'wall') {
        sparks(x, y, 5, ['#ffffff', '#c9c9ff']);
        sfx('wall', vol * 0.7, ev.p);
      }
      break;
    case 'shot':
      float(x, y - 0.8, `⚽ 슛! +${ev.pts}`, colorOf(ev.a), 1.2);
      sfx('shot', vol);
      addFeed(`⚽ <b>${esc(nameOf(ev.a))}</b>의 공이 ${esc(nameOf(ev.b))}에게 명중! +${ev.pts}`);
      break;
    case 'boost': {
      const c = cars.get(ev.id);
      if (c) for (let i = 0; i < 12; i++) particles.push(puff(c.x - Math.cos(c.a) * 0.6, c.y - Math.sin(c.a) * 0.6, '#ffffff'));
      sfx('boost', ev.id === io.cid ? 1 : hearing(ev.x / 100, ev.y / 100) * 0.6);
      break;
    }
    case 'horn': {
      const c = cars.get(ev.id);
      if (c) float(c.x, c.y - 1.1, '빵!', '#ffffff', 0.9);
      sfx('horn', ev.id === io.cid ? 1 : c ? hearing(c.x, c.y) * 0.7 : 0.4);
      break;
    }
    case 'join': if (ev.kind !== 'bot') addFeed(`🚗 <b style="color:${COLORS[ev.color]}">${esc(ev.name)}</b> 입장`); break;
    case 'leave': if (ev.reason !== 'room') addFeed(`👋 ${esc(ev.name)} 퇴장`); break;
    case 'round':
      if (ev.ph === 'end') {
        showResult(ev.rank);
        sfx('fanfare', 1);
        addFeed(`🏁 판 끝! 1등 <b>${esc(ev.rank[0]?.name ?? '-')}</b>`);
      } else {
        $('result').hidden = true;
        addFeed('🎬 새 판 시작');
      }
      break;
  }
}

// How loud an event is for this screen: near your car in play mode, everything softly when watching.
function hearing(x, y) {
  if (mode !== 'play') return 0.55;
  const me = cars.get(io.cid);
  if (!me) return 0.5;
  return Math.max(0.12, 1 - Math.hypot(me.x - x, me.y - y) / 14);
}

function sparks(x, y, n, colors) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, v = 2 + Math.random() * 6;
    particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0.25 + Math.random() * 0.35, max: 0.6, c: colors[i % colors.length], spark: true });
  }
}
function puff(x, y, c) {
  const a = Math.random() * Math.PI * 2;
  return { x, y, vx: Math.cos(a) * 0.8, vy: Math.sin(a) * 0.8, life: 0.5 + Math.random() * 0.3, max: 0.8, c, puff: true };
}
function float(x, y, text, color, size = 1) {
  floaters.push({ x, y, text, color, size, life: 1.1 });
  if (floaters.length > 10) floaters.splice(0, floaters.length - 10); // never a wall of text
}

// ---------------------------------------------------------------- sound (WebAudio, soft and short)
let actx = null, master = null;
let muted = store.get('bump.muted') === '1';
const lastSound = new Map();
$('soundBtn').textContent = muted ? '🔇' : '🔊';
$('soundBtn').addEventListener('click', () => {
  muted = !muted;
  store.set('bump.muted', muted ? '1' : '0');
  $('soundBtn').textContent = muted ? '🔇' : '🔊';
  if (!muted) sfx('ball', 1, 2);
});
// Browsers allow sound only after a click or tap: start the audio on the first one anywhere.
addEventListener('pointerdown', () => {
  if (muted) return;
  try { audio(); if (actx.state === 'suspended') actx.resume(); } catch { /* no audio */ }
}, { once: true });
function audio() {
  if (actx) return actx;
  actx = new AudioContext();
  // A gentle master: low volume and a compressor so many crashes never get loud.
  const comp = actx.createDynamicsCompressor();
  comp.threshold.value = -24; comp.ratio.value = 6;
  master = actx.createGain();
  master.gain.value = 0.22;
  master.connect(comp).connect(actx.destination);
  return actx;
}
function tone(type, f0, f1, dur, vol, delay = 0, filter = 0) {
  const t = actx.currentTime + delay;
  const o = actx.createOscillator(), g = actx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  let node = o.connect(g);
  if (filter) { const f = actx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = filter; node = g.connect(f); }
  node.connect(master);
  o.start(t); o.stop(t + dur + 0.02);
}
function noise(dur, vol, from, to, type = 'bandpass') {
  const t = actx.currentTime;
  const len = Math.floor(actx.sampleRate * dur);
  const buf = actx.createBuffer(1, len, actx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = actx.createBufferSource(), f = actx.createBiquadFilter(), g = actx.createGain();
  src.buffer = buf; f.type = type; f.Q.value = 2;
  f.frequency.setValueAtTime(from, t); f.frequency.exponentialRampToValueAtTime(to, t + dur);
  g.gain.value = vol;
  src.connect(f).connect(g).connect(master);
  src.start(t);
}
function sfx(kind, vol = 1, p = 2) {
  if (muted || vol <= 0.05) return;
  const now = performance.now();
  if (now - (lastSound.get(kind) ?? 0) < 60) return; // never a pile-up of the same sound
  lastSound.set(kind, now);
  try {
    audio();
    if (actx.state === 'suspended') actx.resume();
    const v = Math.min(1, vol);
    const j = 0.9 + Math.random() * 0.2;
    switch (kind) {
      case 'bump': { // a rubbery "boing", deeper for harder crashes
        const f = 260 * j - Math.min(120, p * 12);
        tone('sine', f, f * 0.45, 0.22, 0.55 * v);
        tone('triangle', f * 2, f, 0.08, 0.18 * v);
        break;
      }
      case 'zap': noise(0.07, 0.12 * v, 5000, 2500, 'highpass'); break;
      case 'ball': tone('triangle', 520 * j, 300, 0.13, 0.35 * v); break;
      case 'cone': tone('square', 950 * j, 700, 0.045, 0.06 * v, 0, 2000); break;
      case 'wall': tone('sine', 150 * j, 90, 0.14, 0.4 * v); break;
      case 'boost': noise(0.4, 0.18 * v, 350, 1800); break;
      case 'horn': tone('square', 440, 440, 0.16, 0.12 * v, 0, 1400); tone('square', 554, 554, 0.16, 0.1 * v, 0, 1400); break;
      case 'combo': { const n = Math.min(4, p); for (let i = 0; i < n; i++) tone('sine', 660 * Math.pow(1.26, i), 660 * Math.pow(1.26, i), 0.12, 0.18, i * 0.06); break; }
      case 'shot': tone('sine', 600, 1400, 0.25, 0.25 * v); break;
      case 'fanfare': [523, 659, 784, 1046].forEach((f, i) => tone('triangle', f, f, 0.22, 0.25, i * 0.12)); break;
    }
  } catch { /* no audio */ }
}

// ---------------------------------------------------------------- input
const stick = { x: 0, y: 0 };
const keys = new Set();
let joyActive = false, lastSent = '', lastSentAt = 0;
function pushStick() {
  if (!joined) return;
  let x = stick.x, y = stick.y;
  if (!joyActive) {
    x = (keys.has('right') ? 1 : 0) - (keys.has('left') ? 1 : 0);
    y = (keys.has('down') ? 1 : 0) - (keys.has('up') ? 1 : 0);
    const l = Math.hypot(x, y); if (l > 1) { x /= l; y /= l; }
  }
  const msg = `${Math.round(x * 10) * 10},${Math.round(y * 10) * 10}`;
  const now = performance.now();
  if (msg !== lastSent || (msg !== '0,0' && now - lastSentAt > 500)) {
    lastSent = msg; lastSentAt = now;
    send('W', ...msg.split(','));
  }
}
setInterval(pushStick, 60);
const joy = $('joy'), knob = $('knob');
function joyMove(e) {
  const r = joy.getBoundingClientRect(), R0 = r.width / 2 - 10;
  let dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
  const l = Math.hypot(dx, dy);
  if (l > R0) { dx *= R0 / l; dy *= R0 / l; }
  knob.style.transform = `translate(${dx}px, ${dy}px)`;
  stick.x = l < 8 ? 0 : dx / R0; stick.y = l < 8 ? 0 : dy / R0;
}
joy.addEventListener('pointerdown', (e) => { joy.setPointerCapture(e.pointerId); joyActive = true; joyMove(e); pushStick(); });
joy.addEventListener('pointermove', (e) => { if (joyActive) joyMove(e); });
const joyEnd = () => { joyActive = false; stick.x = stick.y = 0; knob.style.transform = ''; pushStick(); };
joy.addEventListener('pointerup', joyEnd);
joy.addEventListener('pointercancel', joyEnd);
for (const [id, op] of [['boostBtn', 'X'], ['hornBtn', 'K']]) {
  const el = $(id);
  el.addEventListener('pointerdown', (e) => { e.preventDefault(); el.classList.add('on'); send(op); });
  el.addEventListener('pointerup', () => el.classList.remove('on'));
  el.addEventListener('pointerleave', () => el.classList.remove('on'));
}
const KEYMAP = { ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down', ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right' };
addEventListener('keydown', (e) => {
  if (mode !== 'play' || e.target.tagName === 'INPUT') return;
  if (KEYMAP[e.code]) { keys.add(KEYMAP[e.code]); e.preventDefault(); pushStick(); }
  else if (e.code === 'Space' && !e.repeat) { send('X'); e.preventDefault(); }
  else if (e.code === 'KeyH' && !e.repeat) send('K');
});
addEventListener('keyup', (e) => { if (KEYMAP[e.code]) { keys.delete(KEYMAP[e.code]); pushStick(); } });
addEventListener('blur', () => { keys.clear(); joyEnd(); });

// ---------------------------------------------------------------- start / modes
$('name').value = myName;
$('colors').innerHTML = COLORS.map((c, i) =>
  `<button type="button" role="radio" data-i="${i}" title="${COLOR_NAMES[i]}" aria-label="${COLOR_NAMES[i]}" aria-checked="${i === myColor}" style="background:${c}"></button>`).join('');
$('colors').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  myColor = Number(b.dataset.i);
  for (const x of $('colors').children) x.setAttribute('aria-checked', String(x === b));
});
$('playBtn').addEventListener('click', () => {
  myName = $('name').value.trim();
  store.set('bump.name', myName); store.set('bump.color', String(myColor));
  joined = true;
  sendJoin();
  setMode('play');
  sfx('horn', 0.8);
});
$('watchBtn').addEventListener('click', () => setMode('watch'));
function setMode(m) {
  mode = m;
  $('start').hidden = m !== 'start';
  $('hud').hidden = m !== 'play';
  $('side').hidden = m !== 'watch';
  if (m === 'watch') {
    $('feed').innerHTML = feed.map((f) => `<li>${f}</li>`).join('');
  }
}
if (new URLSearchParams(location.search).has('watch')) setMode('watch');

function updateHud() {
  const s = snap;
  const sec = Math.ceil(s.left / 1000);
  $('timer').textContent = s.ph === 'play' ? `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}` : '결과';
  if (s.ph === 'result') $('nextIn').textContent = sec;
  if (mode === 'play') {
    const me = cars.get(io.cid);
    if (me) {
      $('score').textContent = me.score;
      $('comboChip').hidden = !(me.combo > 1);
      $('combo').textContent = `x${me.combo}`;
    }
  }
  if (mode === 'watch') {
    const rows = [...s.c].sort((a, b) => b[C.SCORE] - a[C.SCORE]);
    $('rank').innerHTML = rows.map((c) => {
      const r = roster.get(c[C.ID]);
      return `<li><span class="dot" style="background:${COLORS[r?.[R.COLOR] ?? 0]}"></span><span class="n">${esc(r?.[R.NAME] ?? '?')}${r?.[R.KIND] === 'bot' ? ' 🤖' : ''}</span><b>${c[C.SCORE]}</b></li>`;
    }).join('');
  }
}
function showResult(rank) {
  $('podium').innerHTML = rank.slice(0, 3).map((r, i) =>
    `<li>${['🥇', '🥈', '🥉'][i]} <span style="color:${COLORS[r.color]}">●</span> ${esc(r.name)}${r.kind === 'bot' ? ' 🤖' : ''}<b>${r.score}</b></li>`).join('');
  $('result').hidden = false;
}

// ---------------------------------------------------------------- camera
const cam = { s: 30, ox: 0, oy: 0, x: ARENA.W / 2, y: ARENA.H / 2 };
function setCamera(dt) {
  const side = mode === 'watch' && cw > 760 ? 270 : 0;
  const me = mode === 'play' ? cars.get(io.cid) : null;
  if (!me) {
    const w = cw - side - 30, h = ch - 80;
    cam.s = Math.min(w / (ARENA.W + 1.6), h / (ARENA.H + 1.6));
    cam.x = ARENA.W / 2; cam.y = ARENA.H / 2;
    cam.ox = 15 + w / 2 - cam.x * cam.s;
    cam.oy = 60 + h / 2 - cam.y * cam.s;
    return;
  }
  // Follow your car, a bit ahead of it, but keep the rink in view.
  cam.s = Math.max(26, Math.min(56, Math.min(cw, ch) / 11));
  const k = Math.min(1, dt * 5);
  cam.x = lerp(cam.x, me.x + Math.cos(me.a) * 1.2, k);
  cam.y = lerp(cam.y, me.y + Math.sin(me.a) * 1.2, k);
  const halfW = cw / 2 / cam.s, halfH = ch / 2 / cam.s;
  const cx = ARENA.W < halfW * 2 - 2 ? ARENA.W / 2 : Math.max(halfW - 1, Math.min(ARENA.W - halfW + 1, cam.x));
  const cy = ARENA.H < halfH * 2 - 2 ? ARENA.H / 2 : Math.max(halfH - 1.5, Math.min(ARENA.H - halfH + 2.5, cam.y));
  cam.ox = cw / 2 - cx * cam.s;
  cam.oy = ch / 2 - cy * cam.s;
}
const SX = (x) => cam.ox + x * cam.s;
const SY = (y) => cam.oy + y * cam.s;

// ---------------------------------------------------------------- drawing
function drawRink(t) {
  const s = cam.s;
  // Floor: glossy dark rink with big tiles and a centre star.
  const fx = SX(0), fy = SY(0), fw = ARENA.W * s, fh = ARENA.H * s;
  const g = ctx.createLinearGradient(fx, fy, fx + fw, fy + fh);
  g.addColorStop(0, '#2b2f63'); g.addColorStop(1, '#22264f');
  ctx.fillStyle = g;
  ctx.fillRect(fx, fy, fw, fh);
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  for (let x = 2; x < ARENA.W; x += 2) { ctx.beginPath(); ctx.moveTo(SX(x), fy); ctx.lineTo(SX(x), fy + fh); ctx.stroke(); }
  for (let y = 2; y < ARENA.H; y += 2) { ctx.beginPath(); ctx.moveTo(fx, SY(y)); ctx.lineTo(fx + fw, SY(y)); ctx.stroke(); }
  ctx.fillStyle = 'rgba(255,255,255,0.04)';
  ctx.beginPath(); ctx.arc(SX(12), SY(8), 4.2 * s, 0, Math.PI * 2); ctx.fill();
  // Lights along the ceiling reflected on the floor.
  for (let i = 0; i < 6; i++) {
    const lx = SX(2 + i * 4), ly = SY(ARENA.H / 2);
    const rg = ctx.createRadialGradient(lx, ly, 0, lx, ly, 3 * s);
    const hue = (i * 60 + t / 40) % 360;
    rg.addColorStop(0, `hsla(${hue},90%,70%,0.10)`); rg.addColorStop(1, 'hsla(0,0%,0%,0)');
    ctx.fillStyle = rg; ctx.fillRect(lx - 3 * s, ly - 3 * s, 6 * s, 6 * s);
  }
  // Padded wall: red and white stripes, a little 3D lip.
  const pad = 0.45 * s;
  ctx.save();
  ctx.beginPath();
  ctx.rect(fx - pad, fy - pad, fw + pad * 2, fh + pad * 2);
  ctx.rect(fx, fy, fw, fh);
  ctx.clip('evenodd');
  ctx.fillStyle = '#f2f2f7';
  ctx.fillRect(fx - pad, fy - pad, fw + pad * 2, fh + pad * 2);
  ctx.fillStyle = '#ff4d5a';
  const step = 1.2 * s;
  for (let d = -fh - pad * 2; d < fw + fh + pad * 4; d += step * 2) {
    ctx.beginPath();
    ctx.moveTo(fx - pad + d, fy - pad); ctx.lineTo(fx - pad + d + step, fy - pad);
    ctx.lineTo(fx - pad + d + step - fh - pad * 2, fy + fh + pad); ctx.lineTo(fx - pad + d - fh - pad * 2, fy + fh + pad);
    ctx.fill();
  }
  ctx.restore();
  ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 3;
  ctx.strokeRect(fx, fy, fw, fh);
}

function shadow(x, y, r) {
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath(); ctx.ellipse(SX(x) + r * cam.s * 0.15, SY(y) + r * cam.s * 0.25, r * cam.s, r * cam.s * 0.92, 0, 0, Math.PI * 2); ctx.fill();
}

function drawPillar([x, y, r]) {
  const s = cam.s;
  shadow(x, y, r);
  ctx.save();
  ctx.translate(SX(x), SY(y));
  const rings = ['#ffd23f', '#3d7eff', '#ffd23f', '#3d7eff'];
  rings.forEach((c, i) => { ctx.fillStyle = c; ctx.beginPath(); ctx.arc(0, 0, r * s * (1 - i * 0.22), 0, Math.PI * 2); ctx.fill(); });
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.beginPath(); ctx.arc(-r * s * 0.3, -r * s * 0.3, r * s * 0.25, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function drawCone([x, y, a]) {
  const s = cam.s, r = RULES.CONE_R;
  shadow(x, y, r);
  ctx.save();
  ctx.translate(SX(x), SY(y)); ctx.rotate(a);
  ctx.fillStyle = '#ff8c1a'; ctx.beginPath(); ctx.arc(0, 0, r * s, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(0, 0, r * s * 0.62, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#ff8c1a'; ctx.beginPath(); ctx.arc(0, 0, r * s * 0.35, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function drawBall(x, y, rot) {
  const s = cam.s, r = RULES.BALL_R;
  shadow(x, y, r);
  ctx.save();
  ctx.translate(SX(x), SY(y)); ctx.rotate(rot);
  const segs = ['#ff5a5f', '#ffffff', '#3d7eff', '#ffffff', '#ffd23f', '#ffffff'];
  segs.forEach((c, i) => {
    ctx.fillStyle = c; ctx.beginPath(); ctx.moveTo(0, 0);
    ctx.arc(0, 0, r * s, (i / 6) * Math.PI * 2, ((i + 1) / 6) * Math.PI * 2); ctx.fill();
  });
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.beginPath(); ctx.arc(-r * s * 0.3, -r * s * 0.35, r * s * 0.3, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function drawCar(id, c, t) {
  const s = cam.s, r = RULES.CAR_R;
  const color = colorOf(id);
  const me = id === io.cid;
  c.wob = Math.max(0, (c.wob ?? 0) - 0.05);
  const wob = Math.sin(t / 30) * c.wob * 0.12;
  shadow(c.x, c.y, r);
  ctx.save();
  ctx.translate(SX(c.x), SY(c.y));
  if (me) { // a soft ring under your own car
    ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(0, 0, (r + 0.2) * s, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.rotate(c.a + wob);
  ctx.scale(1 + c.wob * 0.08, 1 - c.wob * 0.08);
  // rubber bumper ring
  ctx.fillStyle = '#2d2d36'; ctx.beginPath(); ctx.arc(0, 0, r * s, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#4a4a58'; ctx.lineWidth = Math.max(1, s * 0.05);
  ctx.beginPath(); ctx.arc(0, 0, r * s * 0.9, 0, Math.PI * 2); ctx.stroke();
  // body
  const bw = r * s * 1.45, bh = r * s * 1.2;
  const body = ctx.createLinearGradient(0, -bh / 2, 0, bh / 2);
  body.addColorStop(0, color); body.addColorStop(1, shadeColor(color, 0.7));
  ctx.fillStyle = body;
  ctx.beginPath(); ctx.roundRect(-bw / 2, -bh / 2, bw, bh, bh * 0.35); ctx.fill();
  // nose stripe and headlights
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.beginPath(); ctx.roundRect(bw * 0.3, -bh * 0.08, bw * 0.16, bh * 0.16, 2); ctx.fill();
  ctx.fillStyle = '#fff6a8';
  ctx.beginPath(); ctx.arc(bw * 0.42, -bh * 0.3, s * 0.06, 0, Math.PI * 2); ctx.arc(bw * 0.42, bh * 0.3, s * 0.06, 0, Math.PI * 2); ctx.fill();
  // seat and driver
  ctx.fillStyle = shadeColor(color, 0.5);
  ctx.beginPath(); ctx.roundRect(-bw * 0.28, -bh * 0.3, bw * 0.34, bh * 0.6, 4); ctx.fill();
  ctx.fillStyle = '#ffd7b0';
  ctx.beginPath(); ctx.arc(-bw * 0.08, 0, s * 0.17, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(-bw * 0.12, 0, s * 0.17, Math.PI * 0.5, Math.PI * 1.5); ctx.fill(); // helmet
  // pole with a spark at the top (sparkles while driving)
  ctx.fillStyle = '#c9c9d6';
  ctx.fillRect(-bw * 0.48, -s * 0.03, s * 0.12, s * 0.06);
  const on = c.flags & FLAG.DRIVING;
  ctx.fillStyle = on && Math.floor(t / 70) % 2 ? '#fffbcf' : '#9a9ab0';
  ctx.beginPath(); ctx.arc(-bw * 0.5, 0, s * (on ? 0.09 : 0.06), 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  if (c.flags & FLAG.BOOST) for (let i = 0; i < 2; i++) particles.push(flame(c));
  if (c.flags & FLAG.STUN) { // little stars
    for (let i = 0; i < 3; i++) {
      const a = t / 150 + (i * Math.PI * 2) / 3;
      ctx.fillStyle = '#ffe14d';
      ctx.font = `${Math.round(s * 0.35)}px system-ui`;
      ctx.fillText('★', SX(c.x) + Math.cos(a) * s * 0.55, SY(c.y) - s * 0.7 + Math.sin(a) * s * 0.2);
    }
  }
}
function flame(c) {
  const bx = c.x - Math.cos(c.a) * 0.7, by = c.y - Math.sin(c.a) * 0.7;
  return { x: bx, y: by, vx: -Math.cos(c.a) * 3 + (Math.random() - 0.5), vy: -Math.sin(c.a) * 3 + (Math.random() - 0.5),
    life: 0.25, max: 0.25, c: Math.random() < 0.5 ? '#ffb703' : '#ff5a5f', puff: true };
}
function shadeColor(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const c = (v) => Math.round(Math.min(255, v * f));
  return `rgb(${c(n >> 16)},${c((n >> 8) & 255)},${c(n & 255)})`;
}

function drawLabels() {
  ctx.textAlign = 'center';
  ctx.font = `700 ${Math.max(10, Math.min(14, cam.s * 0.42))}px system-ui, sans-serif`;
  for (const [id, c] of cars) {
    const r = roster.get(id);
    const me = id === io.cid;
    const text = (me ? '▼ ' : '') + (r?.[R.NAME] ?? '?') + (c.combo > 1 ? ` x${c.combo}` : '');
    const sx = SX(c.x), sy = SY(c.y) - RULES.CAR_R * cam.s - 8;
    const w = ctx.measureText(text).width + 10;
    ctx.fillStyle = me ? 'rgba(255,90,95,0.95)' : 'rgba(255,255,255,0.85)';
    ctx.beginPath(); ctx.roundRect(sx - w / 2, sy - 14, w, 18, 6); ctx.fill();
    ctx.fillStyle = me ? '#fff' : '#1d2140';
    ctx.fillText(text, sx, sy);
  }
}

// ---------------------------------------------------------------- frame
let lastT = performance.now();
function frame(t) {
  const dt = Math.min(0.1, (t - lastT) / 1000);
  lastT = t;
  const k = Math.min(1, (t - snapAt) / (RULES.TICK_MS * RULES.SNAP_EVERY));
  for (const c of cars.values()) {
    const kk = Math.min(1, (t - c.t0) / (RULES.TICK_MS * RULES.SNAP_EVERY));
    c.x = lerp(c.fx, c.tx, kk); c.y = lerp(c.fy, c.ty, kk); c.a = lerpAngle(c.fa, c.ta, kk);
  }
  balls.forEach((b, i) => { ballSpin[i] += (b[2] ?? 0) * dt; });
  for (let i = particles.length - 1; i >= 0; i--) {
    const q = particles[i];
    q.life -= dt; q.x += q.vx * dt; q.y += q.vy * dt; q.vx *= 0.9; q.vy *= 0.9;
    if (q.life <= 0) particles.splice(i, 1);
  }
  for (let i = floaters.length - 1; i >= 0; i--) {
    floaters[i].life -= dt; floaters[i].y -= dt * 0.8;
    if (floaters[i].life <= 0) floaters.splice(i, 1);
  }

  setCamera(dt);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#1b1d3a';
  ctx.fillRect(0, 0, cw, ch);
  if (shake > 0) { ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake); shake = Math.max(0, shake - dt * 45); }

  drawRink(t);
  cones.forEach((o, i) => { const p = prevCones[i] ?? o; drawCone([lerp(p[0], o[0], k), lerp(p[1], o[1], k), o[2]]); });
  balls.forEach((b, i) => { const p = prevBalls[i] ?? b; drawBall(lerp(p[0], b[0], k), lerp(p[1], b[1], k), ballSpin[i]); });
  for (const p of PILLARS) drawPillar(p);
  for (const q of particles) if (q.puff) {
    ctx.globalAlpha = Math.max(0, q.life / q.max) * 0.7;
    ctx.fillStyle = q.c;
    ctx.beginPath(); ctx.arc(SX(q.x), SY(q.y), cam.s * 0.12 * (1.5 - q.life / q.max), 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;
  for (const [id, c] of cars) drawCar(id, c, t);
  // sparks: short bright streaks
  ctx.lineCap = 'round';
  for (const q of particles) if (q.spark) {
    ctx.globalAlpha = Math.max(0, q.life / q.max);
    ctx.strokeStyle = q.c; ctx.lineWidth = Math.max(1.5, cam.s * 0.06);
    ctx.beginPath(); ctx.moveTo(SX(q.x), SY(q.y)); ctx.lineTo(SX(q.x - q.vx * 0.04), SY(q.y - q.vy * 0.04)); ctx.stroke();
  }
  ctx.globalAlpha = 1;
  drawLabels();
  ctx.textAlign = 'center';
  for (const f of floaters) {
    ctx.globalAlpha = Math.min(1, f.life * 2);
    ctx.font = `900 ${Math.round(cam.s * 0.5 * f.size)}px system-ui, sans-serif`;
    ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.strokeText(f.text, SX(f.x), SY(f.y));
    ctx.fillStyle = f.color; ctx.fillText(f.text, SX(f.x), SY(f.y));
  }
  ctx.globalAlpha = 1;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
