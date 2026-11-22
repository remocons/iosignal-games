// 동물원 생존하기 — browser client.
// Draws the zoo from host snapshots and sends the stick, jump and mine buttons.
// Two views: play (camera follows your animal, joystick + buttons) and watch (?watch: whole map).
import {
  TAGS, RULES, W, H, P, B, M, R, FLAG, AVATARS, AVATAR_NAMES, BOT_NAMES, STAGE, STAGES,
  tileHeight, formatInput, screenToWorld, viewToWorld, setStage,
} from './shared.js';
import { Iso, drawGround, staticObjects, drawModel } from './voxel.js';
import { mountGameKit } from './kit/kit.js';

const $ = (id) => document.getElementById(id);
const EMOJI = ['🐥', '🐷', '🐰', '🐼', '🦊', '🐸', '🐧', '🐱'];
const BOT_EMOJI = { lion: '🦁', bear: '🐻', gorilla: '🦍', robot: '🤖', croc: '🐊' };
const HOW = { mine: ['💥', '지뢰가 터졌어요'], drown: ['💦', '물에 빠졌어요'], caught: ['😱', '잡혔어요'] };
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };

// ---------------------------------------------------------------- state
let mode = 'start';           // 'start' | 'play' | 'watch'
let camMode = 'follow';       // play: 'follow' | 'map'
let joined = false;
let myName = store.get('zoo.name') || '';
let myAvatar = Number(store.get('zoo.avatar') || Math.floor(Math.random() * AVATARS.length)) % AVATARS.length;
const roster = new Map();     // cid -> [cid, name, avatar, kind]
const players = new Map();    // cid -> display entity
const bots = new Map();       // id  -> display entity
let mines = [];
let snap = null;
const particles = [];
const feed = [];
let shake = 0;

// ---------------------------------------------------------------- canvas
const canvas = $('view');
const ctx = canvas.getContext('2d');
const iso = new Iso(ctx);
let statics = staticObjects();
let cw = 0, ch = 0, dpr = 1;
function resize() {
  dpr = Math.min(2, window.devicePixelRatio || 1);
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
const sendJoin = () => send('J', 'web', myName, myAvatar);

// IOSignal game kit: brand badge, connection chip (state, round trip, players), join dialog with QR.
const kit = mountGameKit({ io, title: '동물원 생존하기' });
io.on('ready', () => {
  io.subscribe(`${TAGS.ROSTER},${TAGS.STATE},${TAGS.EVT}`);
  if (joined) sendJoin(); // a reconnect has a new CID: join again
});
io.on('message', (tag, data) => {
  if (tag === TAGS.STATE) onSnapshot(data);
  else if (tag === TAGS.ROSTER) {
    roster.clear(); for (const r of data.p) roster.set(r[R.CID], r);
    kit.setRoster(data.p.map((r) => r[R.KIND]));
  }
  else if (tag === TAGS.EVT) onEvent(data);
});
setInterval(() => { if (joined) send('H'); }, RULES.HEARTBEAT_MS);

// Entities move smoothly from where they are drawn to the newest snapshot position.
function track(map, key, x, y, z, extra) {
  const now = performance.now();
  let e = map.get(key);
  if (!e) {
    e = { x, y, z, fx: x, fy: y, fz: z, tx: x, ty: y, tz: z, t0: now, g: tileHeight(x, y) };
    map.set(key, e);
  } else {
    e.fx = e.x; e.fy = e.y; e.fz = e.z;
    e.tx = x; e.ty = y; e.tz = z; e.t0 = now;
    // A big jump (respawn) is not animated.
    if (Math.hypot(x - e.x, y - e.y) > 2) { e.fx = e.x = x; e.fy = e.y = y; e.g = tileHeight(x, y); }
  }
  Object.assign(e, extra, { seen: snapCount });
}
let snapCount = 0;

// A new area: new map, new bots. Everyone appears at its gate.
function enterStage(i) {
  setStage(i);
  statics = staticObjects();
  bots.clear();
  particles.length = 0;
  view.center = null;
  $('stage').textContent = `${STAGE + 1}. ${STAGES[STAGE].name}`;
}

// "Escaped! next area in 3 s" while the host is about to change areas.
function showBanner(s) {
  const el = $('banner');
  if (s.ph !== 'next') { el.hidden = true; return; }
  const who = s.esc === io.cid ? '내가' : `${esc(nameOf(s.esc))} 님이`;
  const next = STAGES[(s.st + 1) % STAGES.length].name;
  el.innerHTML = `🏁 ${who} 탈출했어요!<small>${Math.ceil(s.nx / 1000)}초 뒤 다음 공간: ${esc(next)}</small>`;
  el.hidden = false;
}
function onSnapshot(s) {
  if (s.st !== STAGE) enterStage(s.st);
  snap = s;
  snapCount++;
  for (const p of s.p) {
    track(players, p[P.CID], p[P.X] / 100, p[P.Y] / 100, p[P.Z] / 100,
      { face: p[P.FACE], flags: p[P.FLAGS], score: p[P.SCORE], life: p[P.LIFE], minesLeft: p[P.MINES] });
  }
  for (const b of s.b) {
    track(bots, b[B.ID], b[B.X] / 100, b[B.Y] / 100, 0, { type: b[B.TYPE], face: b[B.FACE], flags: b[B.FLAGS] });
  }
  for (const map of [players, bots]) for (const [k, e] of map) if (e.seen !== snapCount) map.delete(k);
  mines = s.m;
  showBanner(s);
  if (mode === 'watch') renderRank();
}

// ---------------------------------------------------------------- events
const nameOf = (cid) => roster.get(cid)?.[R.NAME] ?? cid?.slice(0, 5) ?? '?';
function addFeed(html) {
  feed.unshift(html);
  feed.length = Math.min(feed.length, 14);
  if (mode === 'watch') $('feed').innerHTML = feed.map((f) => `<li>${f}</li>`).join('');
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function onEvent(ev) {
  const mine = ev.cid === io.cid;
  switch (ev.e) {
    case 'join': addFeed(`${EMOJI[ev.avatar] ?? '🐾'} <b>${esc(ev.name)}</b> 입장${ev.kind === 'ard' ? ' 🔌' : ''}`); break;
    case 'leave': addFeed(`👋 <b>${esc(ev.name)}</b> 퇴장`); break;
    case 'jump': if (mine) sfx('jump'); break;
    case 'mine': if (mine) sfx('mine'); break;
    case 'boom': {
      burst(ev.x / 100, ev.y / 100, 0.2, ['#ff9f1c', '#ffd23f', '#5b5b5b', '#e63946'], 34, 4.5);
      const me = players.get(io.cid);
      const near = me ? Math.hypot(me.x - ev.x / 100, me.y - ev.y / 100) : 99;
      if (near < 6 || mode === 'watch') { sfx('boom'); shake = Math.max(shake, near < 3 ? 14 : 6); }
      break;
    }
    case 'die': {
      const [icon, text] = HOW[ev.how] ?? ['💀', '죽었어요'];
      const by = ev.how === 'mine' ? (ev.by === ev.cid ? ' (자기 지뢰)' : ev.by ? ` — ${esc(nameOf(ev.by))}의 지뢰` : '')
        : ev.how === 'caught' ? ` — ${BOT_EMOJI[ev.by] ?? ''} ${BOT_NAMES[ev.by] ?? ''}` : '';
      addFeed(`${icon} <b>${esc(ev.name)}</b> ${text}${by}`);
      const av = roster.get(ev.cid)?.[R.AVATAR] ?? 0;
      if (ev.how === 'drown') burst(ev.x / 100, ev.y / 100, 0, ['#bfefff', '#4cc3f3', '#ffffff'], 26, 3);
      else burst(ev.x / 100, ev.y / 100, 0.3, [AVATAR_COLOR[av], '#ffffff'], 18, 3);
      if (mine) {
        sfx(ev.how === 'drown' ? 'splash' : 'die');
        $('deadIcon').textContent = icon;
        $('deadText').textContent = text + (ev.how === 'caught' ? ` (${BOT_NAMES[ev.by] ?? ''})` : '');
        deadUntil = performance.now() + RULES.RESPAWN_MS;
        $('dead').hidden = false;
      }
      break;
    }
    case 'spawn': if (mine) { $('dead').hidden = true; deadUntil = 0; } break;
    case 'escape':
      addFeed(`🏁 <b>${esc(ev.name)}</b> 탈출! +${RULES.ESCAPE}`);
      sfx('escape');
      break;
    case 'stage':
      addFeed(`🗺️ 다음 공간: <b>${esc(ev.name)}</b>`);
      break;
    case 'botdie':
      addFeed(`💥 ${BOT_EMOJI[ev.type]} ${BOT_NAMES[ev.type]} 지뢰에 당함 — <b>${esc(nameOf(ev.by))}</b> +${RULES.BOT_KILL}`);
      burst(ev.x / 100, ev.y / 100, 0.3, ['#9aa3ab', '#e3b25a', '#ffffff'], 16, 3);
      break;
  }
}
const AVATAR_COLOR = ['#ffe14d', '#f7a8b8', '#ffffff', '#f7f7f7', '#f08a2c', '#4caf50', '#263238', '#9e9ea8'];
let deadUntil = 0;

function burst(x, y, z, colors, n, power) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, v = Math.random() * power;
    particles.push({ x, y, z: z + tileHeight(x, y), vx: Math.cos(a) * v * 0.6, vy: Math.sin(a) * v * 0.6,
      vz: 2 + Math.random() * power, c: colors[i % colors.length], s: 0.06 + Math.random() * 0.1, life: 0.9 + Math.random() * 0.6 });
  }
}

// ---------------------------------------------------------------- sound (WebAudio, no files)
let actx = null;
let muted = store.get('zoo.muted') === '1';
function sfx(kind) {
  if (muted) return;
  try {
    actx ??= new AudioContext();
    const tone = (f0, f1, dur, type = 'square', vol = 0.12, delay = 0) => {
      const t = actx.currentTime + delay;
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + dur);
      g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.connect(g).connect(actx.destination); o.start(t); o.stop(t + dur);
    };
    if (kind === 'jump') tone(380, 760, 0.14, 'square', 0.08);
    else if (kind === 'mine') { tone(220, 200, 0.06, 'square', 0.08); tone(330, 300, 0.06, 'square', 0.08, 0.08); }
    else if (kind === 'boom') { tone(160, 40, 0.5, 'sawtooth', 0.22); tone(90, 30, 0.6, 'square', 0.12); }
    else if (kind === 'die') tone(500, 90, 0.5, 'triangle', 0.18);
    else if (kind === 'splash') tone(900, 200, 0.35, 'sine', 0.15);
    else if (kind === 'escape') { tone(523, 523, 0.12, 'square', 0.1); tone(659, 659, 0.12, 'square', 0.1, 0.13); tone(784, 1046, 0.3, 'square', 0.1, 0.26); }
  } catch { /* no audio */ }
}

// ---------------------------------------------------------------- input
const stick = { x: 0, y: 0 };       // screen direction -1..1
const keys = new Set();
let joyActive = false;
let lastSent = '';
let lastSentAt = 0;

function pushStick() {
  if (!joined) return;
  let wx, wy;
  if (joyActive) {
    // The stick is in screen directions; the host wants map-grid directions for the view on screen.
    [wx, wy] = screenToWorld(stick.x, stick.y, iso.turn);
  } else {
    // Arrow keys go along the grid, like the Arduino buttons: up = up-right on the screen.
    let gx = (keys.has('right') ? 1 : 0) - (keys.has('left') ? 1 : 0);
    let gy = (keys.has('down') ? 1 : 0) - (keys.has('up') ? 1 : 0);
    const l = Math.hypot(gx, gy);
    if (l > 1) { gx /= l; gy /= l; }
    [wx, wy] = viewToWorld(gx, gy, iso.turn);
  }
  const msg = `${Math.round(wx * 10) * 10},${Math.round(wy * 10) * 10}`;
  const now = performance.now();
  if (msg !== lastSent || (msg !== '0,0' && now - lastSentAt > 500)) {
    lastSent = msg; lastSentAt = now;
    send('W', ...msg.split(','));
  }
}
setInterval(pushStick, 70);

const joy = $('joy'), knob = $('knob');
function joyMove(e) {
  const r = joy.getBoundingClientRect();
  const R0 = r.width / 2 - 10;
  let dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
  const l = Math.hypot(dx, dy);
  if (l > R0) { dx *= R0 / l; dy *= R0 / l; }
  knob.style.transform = `translate(${dx}px, ${dy}px)`;
  const dead = l < 8;
  stick.x = dead ? 0 : dx / R0; stick.y = dead ? 0 : dy / R0;
}
joy.addEventListener('pointerdown', (e) => { joy.setPointerCapture(e.pointerId); joyActive = true; joyMove(e); pushStick(); });
joy.addEventListener('pointermove', (e) => { if (joyActive) joyMove(e); });
const joyEnd = () => { joyActive = false; stick.x = stick.y = 0; knob.style.transform = ''; pushStick(); };
joy.addEventListener('pointerup', joyEnd);
joy.addEventListener('pointercancel', joyEnd);

const press = (el, fn) => el.addEventListener('pointerdown', (e) => { e.preventDefault(); el.classList.add('on'); fn(); });
for (const el of [$('jumpBtn'), $('mineBtn')]) {
  el.addEventListener('pointerup', () => el.classList.remove('on'));
  el.addEventListener('pointerleave', () => el.classList.remove('on'));
}
press($('jumpBtn'), () => send('U'));
press($('mineBtn'), () => send('B'));

const KEYMAP = { ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down', ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right' };
addEventListener('keydown', (e) => {
  if (mode !== 'play' || e.target.tagName === 'INPUT') return;
  if (KEYMAP[e.code]) { keys.add(KEYMAP[e.code]); e.preventDefault(); pushStick(); }
  else if (e.code === 'Space' && !e.repeat) { send('U'); e.preventDefault(); }
  else if ((e.code === 'KeyE' || e.code === 'KeyX') && !e.repeat) send('B');
  else if (e.code === 'KeyM' && !e.repeat) toggleCam();
});
addEventListener('keyup', (e) => { if (KEYMAP[e.code]) { keys.delete(KEYMAP[e.code]); pushStick(); } });
addEventListener('blur', () => { keys.clear(); joyEnd(); });

function toggleCam() {
  camMode = camMode === 'follow' ? 'map' : 'follow';
  $('camBtn').textContent = camMode === 'follow' ? '전체 맵' : '내 동물';
}
$('camBtn').addEventListener('click', toggleCam);

// ---------------------------------------------------------------- start screen
$('name').value = myName;
$('avatars').innerHTML = AVATARS.map((a, i) =>
  `<button type="button" role="radio" data-i="${i}" aria-checked="${i === myAvatar}">${EMOJI[i]}<small>${AVATAR_NAMES[i]}</small></button>`).join('');
$('avatars').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  myAvatar = Number(b.dataset.i);
  for (const x of $('avatars').children) x.setAttribute('aria-checked', String(x === b));
});
$('playBtn').addEventListener('click', () => {
  myName = $('name').value.trim();
  store.set('zoo.name', myName); store.set('zoo.avatar', String(myAvatar));
  joined = true;
  sendJoin();
  setMode('play');
  sfx('jump');
});
$('watchBtn').addEventListener('click', () => setMode('watch'));

function setMode(m) {
  mode = m;
  $('start').hidden = m !== 'start';
  $('hud').hidden = m !== 'play';
  $('camBtn').hidden = m !== 'play';
  $('side').hidden = m !== 'watch';
  if (m === 'watch') {
    $('feed').innerHTML = feed.map((f) => `<li>${f}</li>`).join('');
    renderRank();
  }
}
if (new URLSearchParams(location.search).has('watch')) setMode('watch');

function renderRank() {
  if (!snap) return;
  const rows = [...snap.p].sort((a, b) => b[P.SCORE] - a[P.SCORE]).slice(0, 12);
  $('rank').innerHTML = rows.map((p) => {
    const r = roster.get(p[P.CID]);
    const dead = p[P.FLAGS] & FLAG.DEAD;
    return `<li><span>${EMOJI[r?.[R.AVATAR]] ?? '🐾'}</span><span class="n">${esc(r?.[R.NAME] ?? p[P.CID])}${r?.[R.KIND] === 'ard' ? ' 🔌' : ''}${dead ? ' 💀' : ''}</span><b>${p[P.SCORE]}</b></li>`;
  }).join('') || '<li class="n">아직 아무도 없어요</li>';
}

// ---------------------------------------------------------------- camera
// view.center: the view point (view coordinates) in the middle of the screen; null = whole map.
// view.zoom multiplies the fitted (whole map) or follow scale.
const view = { zoom: Number(store.get('zoo.zoom')) || 1, center: null };
iso.turn = Number(store.get('zoo.turn')) % 4 || 0;
let camX = W / 2, camY = H / 2, camG = 0;

const whole = () => mode !== 'play' || camMode === 'map';
function viewArea() {
  const side = mode === 'watch' && cw > 760 ? 270 : 0;
  return { x: 10, y: 56, w: cw - side - 20, h: ch - 66 };
}
function setCamera(dt) {
  if (whole()) {
    const A = viewArea();
    const fit = Math.max(8, Math.min(A.w / (iso.vw + iso.vh + 1), A.h / ((iso.vw + iso.vh) / 2 + 3.5)));
    iso.s = fit * view.zoom;
    const c = view.center ?? [iso.vw / 2 - 0.8, iso.vh / 2 - 0.8];
    iso.ox = A.x + A.w / 2 - (c[0] - c[1]) * iso.s;
    iso.oy = A.y + A.h / 2 - (c[0] + c[1]) * iso.s * 0.5;
    return;
  }
  const me = players.get(io.cid);
  if (me) {
    const k = Math.min(1, dt * 6);
    camX += (me.x - camX) * k; camY += (me.y - camY) * k; camG += (me.g - camG) * k;
  }
  iso.s = Math.max(24, Math.min(58, Math.min(cw, ch) / 9)) * view.zoom;
  const [vx, vy] = iso.toView(camX, camY);
  iso.ox = cw / 2 - (vx - vy) * iso.s;
  iso.oy = ch * 0.5 - (vx + vy) * iso.s * 0.5 + camG * iso.s;
}

/** Screen point -> view coordinates on the ground. */
function screenToView(sx, sy) {
  const a = (sx - iso.ox) / iso.s, b = ((sy - iso.oy) * 2) / iso.s;
  return [(a + b) / 2, (b - a) / 2];
}
function currentCenter() {
  const A = viewArea();
  return screenToView(A.x + A.w / 2, A.y + A.h / 2);
}

function setZoom(z, at) {
  const nz = Math.max(0.5, Math.min(4, z));
  if (whole() && at) {
    // Keep the ground point under the mouse where it is.
    const u = screenToView(at[0], at[1]);
    view.zoom = nz;
    setCamera(0);
    const after = iso.s;
    const A = viewArea();
    const ex = at[0] - (A.x + A.w / 2), ey = at[1] - (A.y + A.h / 2);
    const a = ex / after, b = (ey * 2) / after;
    view.center = [u[0] - (a + b) / 2, u[1] - (b - a) / 2];
  } else {
    view.zoom = nz;
  }
  store.set('zoo.zoom', String(view.zoom));
}
function turnView(d) {
  iso.turn = (((iso.turn + d) % 4) + 4) % 4;
  view.center = null;
  store.set('zoo.turn', String(iso.turn));
  pushStick();
}
function resetView() { view.zoom = 1; view.center = null; store.set('zoo.zoom', '1'); }

// Mouse: wheel zooms at the cursor, drag pans (whole map), right-drag or Shift+drag turns the view.
let drag = null;
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const d = Math.max(-100, Math.min(100, e.deltaMode ? e.deltaY * 40 : e.deltaY)); // at most ~16% a step
  setZoom(view.zoom * Math.exp(-d * 0.0015), [e.clientX, e.clientY]);
}, { passive: false });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'touch') return;
  canvas.setPointerCapture(e.pointerId);
  drag = { x: e.clientX, y: e.clientY, turn: e.button === 2 || e.shiftKey, acc: 0, center: whole() ? currentCenter() : null };
  canvas.style.cursor = drag.turn ? 'ew-resize' : 'grabbing';
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (drag.turn) {
    // Every 90 px sideways is a quarter turn.
    const steps = Math.trunc(dx / 90) - drag.acc;
    if (steps) { turnView(steps); drag.acc += steps; }
  } else if (drag.center) {
    const a = -dx / iso.s, b = (-dy * 2) / iso.s;
    view.center = [drag.center[0] + (a + b) / 2, drag.center[1] + (b - a) / 2];
  }
});
const dragEnd = () => { drag = null; canvas.style.cursor = ''; };
canvas.addEventListener('pointerup', dragEnd);
canvas.addEventListener('pointercancel', dragEnd);
canvas.addEventListener('dblclick', resetView);
$('zoomIn').addEventListener('click', () => setZoom(view.zoom * 1.25, whole() ? [cw / 2, ch / 2] : null));
$('zoomOut').addEventListener('click', () => setZoom(view.zoom / 1.25, whole() ? [cw / 2, ch / 2] : null));
$('turnL').addEventListener('click', () => turnView(-1));
$('turnR').addEventListener('click', () => turnView(1));
$('viewReset').addEventListener('click', resetView);

/** Is the tile (x, y) on screen (with room for hills and trees)? */
function tileVisible(x, y) {
  const sx = iso.px(x + 0.5, y + 0.5), sy = iso.py(x + 0.5, y + 0.5, 0);
  const m = iso.s * 2.5;
  return sx > -m && sx < cw + m && sy > -m && sy < ch + m * 1.6;
}

// ---------------------------------------------------------------- frame
let lastT = performance.now();
function frame(t) {
  const dt = Math.min(0.1, (t - lastT) / 1000);
  lastT = t;

  // positions
  for (const map of [players, bots]) {
    for (const e of map.values()) {
      const k = Math.min(1, (t - e.t0) / RULES.TICK_MS);
      e.x = e.fx + (e.tx - e.fx) * k; e.y = e.fy + (e.ty - e.fy) * k; e.z = e.fz + (e.tz - e.fz) * k;
      e.g += (tileHeight(e.x, e.y) - e.g) * Math.min(1, dt * 14);
    }
  }
  for (let i = particles.length - 1; i >= 0; i--) {
    const q = particles[i];
    q.life -= dt; q.vz -= 12 * dt;
    q.x += q.vx * dt; q.y += q.vy * dt; q.z += q.vz * dt;
    if (q.z < tileHeight(q.x, q.y)) { q.z = tileHeight(q.x, q.y); q.vz *= -0.3; q.vx *= 0.6; q.vy *= 0.6; }
    if (q.life <= 0) particles.splice(i, 1);
  }

  setCamera(dt);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const sky = ctx.createLinearGradient(0, 0, 0, ch);
  sky.addColorStop(0, '#8fd3f7'); sky.addColorStop(1, '#c9ecff');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, cw, ch);
  if (shake > 0) {
    ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
    shake = Math.max(0, shake - dt * 40);
  }

  drawGround(iso, t, tileVisible);

  // Everything standing on the ground, back to front.
  const list = [];
  // A tree or fence just in front of an animal is drawn see-through, so nobody hides behind it.
  const bodies = [...players.values()].filter((p) => !(p.flags & FLAG.DEAD));
  for (const o of statics) {
    if (!tileVisible(o.x, o.y)) continue;
    const key = iso.key(o.x + 0.5, o.y + 0.5);
    const ox = iso.px(o.x + 0.5, o.y + 0.5);
    const front = bodies.some((p) => {
      const d = key - iso.key(p.x, p.y);
      return d > 0 && d < 3 && Math.abs(ox - iso.px(p.x, p.y)) < 1.3 * iso.s;
    });
    list.push({ key, draw: front ? (i) => o.draw(i, 0.38) : (i) => o.draw(i) });
  }
  for (const m of mines) {
    const x = m[M.X] / 100, y = m[M.Y] / 100;
    list.push({ key: iso.key(x, y), draw: () => drawMine(x, y, m, t) });
  }
  for (const b of bots.values()) {
    if (b.flags & FLAG.DEAD) continue;
    list.push({ key: iso.key(b.x, b.y), draw: () => drawBot(b, t) });
  }
  for (const [cid, p] of players) {
    if (p.flags & FLAG.DEAD) continue;
    list.push({ key: iso.key(p.x, p.y), draw: () => drawPlayer(cid, p, t) });
  }
  for (const q of particles) list.push({ key: iso.key(q.x, q.y), draw: () => iso.box(q.x - q.s / 2, q.y - q.s / 2, q.z, q.s, q.s, q.s, q.c, q.c, Math.min(1, q.life * 2)) });
  list.sort((a, b) => a.key - b.key);
  for (const o of list) o.draw(iso);

  drawLabels(t);
  updateHud(t);
  requestAnimationFrame(frame);
}

function drawMine(x, y, m, t) {
  const g = tileHeight(x, y);
  const own = snap && snap.p[m[M.OWNER]]?.[P.CID] === io.cid;
  iso.box(x - 0.13, y - 0.13, g, 0.26, 0.26, 0.06, '#3b3f45');
  const blink = m[M.ARMED] ? (Math.floor(t / 250) % 2 ? '#ff2d2d' : '#7a1010') : '#9aa3ab';
  iso.box(x - 0.04, y - 0.04, g + 0.06, 0.08, 0.08, 0.05, blink);
  if (own) iso.box(x - 0.17, y - 0.17, g, 0.34, 0.34, 0.01, '#ffd23f');
}

function drawBot(b, t) {
  const bob = b.flags & FLAG.MOVING ? Math.abs(Math.sin(t / 110 + b.x)) * 0.05 : 0;
  const water = b.type === 'croc';
  const g = water ? -0.28 : b.g;
  iso.shadow(b.x, b.y, g, water ? 0.5 : 0.36, water ? 0.12 : 0.22);
  drawModel(iso, b.type, b.x, b.y, g, bob, b.face, { scale: b.type === 'robot' ? 1 : 1.05 });
}

function drawPlayer(cid, p, t) {
  const r = roster.get(cid);
  const model = AVATARS[r?.[R.AVATAR] ?? 0];
  const me = cid === io.cid;
  const bob = p.flags & FLAG.MOVING && p.z < 0.05 ? Math.abs(Math.sin(t / 90 + p.x * 3)) * 0.06 : 0;
  const safe = p.flags & FLAG.SAFE;
  iso.shadow(p.x, p.y, p.g, 0.3 - Math.min(0.15, p.z * 0.12), 0.25);
  if (me) {
    const c = iso.ctx;
    c.strokeStyle = 'rgba(255,255,255,0.9)'; c.lineWidth = 2;
    c.beginPath();
    c.ellipse(iso.px(p.x, p.y), iso.py(p.x, p.y, p.g), 0.42 * iso.s, 0.21 * iso.s, 0, 0, Math.PI * 2);
    c.stroke();
  }
  const squash = p.z > 0.05 ? 1.12 : 1;
  drawModel(iso, model, p.x, p.y, p.g, p.z + bob, p.face, {
    alpha: safe && Math.floor(t / 120) % 2 ? 0.45 : 1, squash, scale: 1.1,
  });
}

function drawLabels(t) {
  const c = ctx;
  c.textAlign = 'center';
  c.font = `700 ${Math.max(10, Math.min(14, iso.s * 0.42))}px system-ui, sans-serif`;
  for (const [cid, p] of players) {
    if (p.flags & FLAG.DEAD) continue;
    const r = roster.get(cid);
    const me = cid === io.cid;
    const sx = iso.px(p.x, p.y), sy = iso.py(p.x, p.y, p.g + p.z + 0.95);
    const text = (me ? '▼ ' : '') + (r?.[R.NAME] ?? cid) + (r?.[R.KIND] === 'ard' ? ' 🔌' : '');
    const w = c.measureText(text).width + 10;
    c.fillStyle = me ? 'rgba(255,138,61,0.95)' : 'rgba(255,255,255,0.85)';
    c.beginPath(); c.roundRect(sx - w / 2, sy - 14, w, 18, 6); c.fill();
    c.fillStyle = me ? '#fff' : '#1d2b3a';
    c.fillText(text, sx, sy);
  }
  for (const b of bots.values()) {
    if (!(b.flags & FLAG.CHASING) || b.flags & FLAG.DEAD) continue;
    const sx = iso.px(b.x, b.y), sy = iso.py(b.x, b.y, b.g + 1.1) + Math.sin(t / 100) * 2;
    c.fillStyle = '#ff3b3b';
    c.font = `900 ${Math.max(14, iso.s * 0.6)}px system-ui, sans-serif`;
    c.fillText('!', sx, sy);
  }
}

function updateHud(t) {
  if (mode !== 'play') return;
  const me = players.get(io.cid);
  if (me) {
    $('score').textContent = me.score ?? 0;
    $('life').textContent = me.life ?? 0;
    const left = me.minesLeft ?? RULES.MINE_MAX;
    $('mines').textContent = '●'.repeat(left) + '○'.repeat(RULES.MINE_MAX - left);
    $('mineBtn').disabled = left <= 0;
  }
  if (deadUntil) $('respawn').textContent = Math.max(0, Math.ceil((deadUntil - t) / 1000));
}

requestAnimationFrame(frame);
