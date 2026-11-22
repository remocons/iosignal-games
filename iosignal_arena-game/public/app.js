// IOSignal Arena — web client.
// Renders the shared map from game host snapshots, sends keyboard/touch input,
// and turns game events into sound and visual feedback.
// `IO` is the global from /vendor/io.js (IOSignal browser IIFE build).

import { TAGS, COLS, ROWS, RULES, MAPS, COLORS, P, R, FLAG, isWall, formatInput, sanitizeName, expandSnapshot } from './protocol.js';
import { Sfx } from './sound.js';
import { mountGameKit } from './kit/kit.js';

const params = new URLSearchParams(location.search);
const WATCH = params.has('watch');
// Relative to the page, so the game also works under a proxy sub path (lab.iosignal.net/games/arena/ -> …/ws).
const pageWs = new URL('ws', location.href);
pageWs.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
const WS_URL = params.get('ws') || pageWs.href;

const $ = (id) => document.getElementById(id);
// IOSignal game kit: brand badge, connection chip (state, round trip, players), join dialog with QR.
const kit = mountGameKit({ title: 'Arena' });
const el = {
  cid: $('cid'), mapName: $('map-name'),
  timer: $('timer'), mute: $('mute'), board: $('board'), canvas: $('canvas'), banner: $('banner'),
  roundEnd: $('round-end'), podium: $('podium'), nextIn: $('next-in'), nextMap: $('next-map'),
  meSwatch: $('me-swatch'), meName: $('me-name'), meSub: $('me-sub'), dashMeter: $('dash-meter'), dashFill: $('dash-fill'),
  ranking: $('ranking'), log: $('log'), overlay: $('overlay'), form: $('join-form'), name: $('name'),
  watchBtn: $('watch-btn'), joinBtn: $('join-btn'), dpad: $('dpad'),
};
const ctx = el.canvas.getContext('2d');
const sfx = new Sfx();

// ---------------------------------------------------------------- state
let io = null;
let joined = false;
let myName = '';
let snap = null;            // latest snapshot from the game host, expanded to full P tuples
let wireSnap = null;        // same snapshot as received (dynamic fields only)
let roster = new Map();     // cid -> roster tuple (name, color, kind), from the retained TAGS.ROSTER
let lastSnapAt = 0;
let missingSince = 0;       // joined but not present in snapshots (game server restarted?)
const actors = new Map();   // cid -> render state (interpolated position, facing...)
const particles = [];
const floaters = [];
let shakeUntil = 0;
let tile = 32;
let mapLayer = null;        // pre-rendered walls/floor
let mapLayerKey = '';
let lastTickSecond = -1;
let lastHeartAt = 0;
let rankingDirtyAt = 0;

const me = () => (io && snap ? snap.p.find((p) => p[P.CID] === io.cid) : null);
const nameOf = (cid) => snap?.p.find((p) => p[P.CID] === cid)?.[P.NAME] ?? (cid ? cid.slice(0, 6) : '?');
const colorOf = (cid) => COLORS[snap?.p.find((p) => p[P.CID] === cid)?.[P.COLOR] ?? 0];

// ---------------------------------------------------------------- IOSignal
function send(op, ...args) {
  if (io?.stateName === 'ready') io.signal(TAGS.IN, formatInput(op, ...args));
}
const sendJoin = () => send('J', 'web', myName);

function connect() {
  io = new IO(WS_URL);
  kit.attach(io);
  io.on('ready', () => {
    el.cid.textContent = io.cid;
    io.subscribe(`${TAGS.ROSTER},${TAGS.STATE},${TAGS.EVT}`); // manual subscribe: repeat on every (re)connect
    if (joined) sendJoin();
  });
  io.on('error', (err) => console.warn('[io]', err));
  io.on('message', (tag, data) => {
    if (tag === TAGS.STATE) { wireSnap = data; onSnapshot(expandSnapshot(data, roster)); }
    else if (tag === TAGS.ROSTER) onRoster(data);
    else if (tag === TAGS.EVT) onEvent(data);
  });
}


setInterval(() => {
  if (!joined || io?.stateName !== 'ready') return;
  send('H');
  // Our player vanished from snapshots (e.g. server restart or timeout): join again.
  if (snap && !me()) {
    missingSince ||= Date.now();
    if (Date.now() - missingSince > 2500) { missingSince = 0; sendJoin(); }
  } else missingSince = 0;
}, RULES.HEARTBEAT_MS);

window.addEventListener('pagehide', () => { if (joined) send('L'); io?.stop(); });

// ---------------------------------------------------------------- input
const KEYMAP = { ArrowUp: 'U', ArrowDown: 'D', ArrowLeft: 'L', ArrowRight: 'R', KeyW: 'U', KeyS: 'D', KeyA: 'L', KeyD: 'R' };
const held = [];            // stack of held directions (last pressed wins)
let sentDir = '0';

function syncDir() {
  const d = held.length ? held[held.length - 1] : '0';
  if (d !== sentDir) { sentDir = d; send('D', d); }
}
function press(d) { if (!held.includes(d)) { held.push(d); syncDir(); } }
function release(d) { const i = held.indexOf(d); if (i >= 0) { held.splice(i, 1); syncDir(); } }
function action() {
  const m = me();
  if (m && m[P.DASH] > 0) sfx.play('nodash');
  send('A');
}

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.code === 'KeyM') { toggleMute(); return; }
  if (!joined) return;
  const d = KEYMAP[e.code];
  if (d) { e.preventDefault(); if (!e.repeat) press(d); }
  if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) action(); }
});
window.addEventListener('keyup', (e) => { const d = KEYMAP[e.code]; if (d) release(d); });
window.addEventListener('blur', () => { held.length = 0; syncDir(); });

// touch d-pad
el.dpad.querySelectorAll('button').forEach((b) => {
  const d = b.dataset.dir;
  b.addEventListener('pointerdown', (e) => {
    e.preventDefault(); sfx.unlock(); b.setPointerCapture(e.pointerId); b.classList.add('on');
    if (d) press(d); else action();
  });
  const up = () => { b.classList.remove('on'); if (d) release(d); };
  b.addEventListener('pointerup', up);
  b.addEventListener('pointercancel', up);
});

function toggleMute() {
  sfx.unlock();
  el.mute.textContent = sfx.toggleMute() ? '🔇' : '🔊';
}
el.mute.addEventListener('click', toggleMute);

// ---------------------------------------------------------------- join overlay
el.name.value = (() => { try { return localStorage.getItem('arena.name') || ''; } catch { return ''; } })();
if (WATCH) {
  document.body.classList.add('watch');
  el.joinBtn.hidden = true;
  el.name.parentElement.hidden = true;
  el.watchBtn.textContent = '관전 화면 시작 (효과음 켜기)';
  el.watchBtn.className = 'primary';
}

el.form.addEventListener('submit', (e) => {
  e.preventDefault();
  sfx.unlock();
  myName = sanitizeName(el.name.value, '');
  try { localStorage.setItem('arena.name', myName); } catch { /* private mode */ }
  joined = true;
  el.overlay.hidden = true;
  if (io?.stateName === 'ready') sendJoin();
});
el.watchBtn.addEventListener('click', () => {
  sfx.unlock();
  el.overlay.hidden = true;
  document.body.classList.add('watch');
});

// ---------------------------------------------------------------- snapshot & events
function onRoster(r) {
  roster = new Map(r.p.map((t) => [t[R.CID], t]));
  kit.setRoster(r.p.map((t) => t[R.KIND]));
  if (wireSnap) { snap = expandSnapshot(wireSnap, roster); renderHud(); }
}

function onSnapshot(s) {
  const prevMap = snap?.map;
  snap = s;
  lastSnapAt = performance.now();
  const seen = new Set();
  for (const p of s.p) {
    const cid = p[P.CID];
    seen.add(cid);
    let a = actors.get(cid);
    if (!a) {
      a = { rx: p[P.X], ry: p[P.Y], face: 'D', born: performance.now() };
      actors.set(cid, a);
    }
    if (p[P.X] !== a.tx || p[P.Y] !== a.ty) {
      if (a.tx !== undefined) {
        const dx = p[P.X] - a.tx, dy = p[P.Y] - a.ty;
        if (Math.abs(dx) + Math.abs(dy) > 4) { a.rx = p[P.X]; a.ry = p[P.Y]; } // respawn: jump
        else if (Math.abs(dx) > Math.abs(dy)) a.face = dx > 0 ? 'R' : 'L';
        else if (dy) a.face = dy > 0 ? 'D' : 'U';
      }
      a.tx = p[P.X]; a.ty = p[P.Y];
    }
  }
  for (const cid of actors.keys()) if (!seen.has(cid)) actors.delete(cid);
  if (prevMap !== s.map) mapLayerKey = '';

  // countdown beeps for the last 5 seconds
  const sec = Math.ceil(s.left / 1000);
  if (s.ph === 'play' && sec <= 5 && sec > 0 && sec !== lastTickSecond) sfx.play('tick');
  lastTickSecond = sec;

  if (performance.now() - rankingDirtyAt > 250) { rankingDirtyAt = performance.now(); renderHud(); }
}

function onEvent(ev) {
  const mine = (cid) => io && cid === io.cid;
  switch (ev.e) {
    case 'join':
      log(`<b style="color:${COLORS[ev.color]}">${esc(ev.name)}</b> ${ev.kind === 'ard' ? '🔌 아두이노' : ''} 입장`);
      sfx.play('join');
      break;
    case 'leave':
      log(`<b>${esc(ev.name)}</b> ${ev.reason === 'leave' ? '퇴장' : '연결 끊김'}`);
      sfx.play('leave');
      break;
    case 'coin':
      sfx.play('coin', mine(ev.cid));
      burst(ev.x, ev.y, '#ffd166', 12);
      floater(ev.x, ev.y, '+1', colorOf(ev.cid));
      break;
    case 'tag':
      if (!ev.to) { log('혼자 남아 술래가 없습니다'); break; } // tagger cleared (only one player left)
      sfx.play('tag', mine(ev.to) || mine(ev.from));
      burst(ev.x, ev.y, '#ff3b5c', 26);
      floater(ev.x, ev.y, '👑 술래!', '#ff3b5c');
      log(ev.from
        ? `<b>${esc(nameOf(ev.from))}</b> → <b>${esc(nameOf(ev.to))}</b> 태그! 👑`
        : `<b>${esc(nameOf(ev.to))}</b> 첫 술래 👑`);
      if (mine(ev.to)) { banner('👑 당신이 술래! 다른 사람을 잡으세요', 'danger'); shake(450); flash(); }
      else if (mine(ev.from)) { banner('태그 성공! +3 · 잠시 무적', 'good'); sfx.play('free'); }
      break;
    case 'bump':
      if (mine(ev.a) || mine(ev.b)) { sfx.play('bump', true); shake(120); }
      burst(ev.x, ev.y, '#ffffff', 6);
      break;
    case 'dash':
      sfx.play('dash', mine(ev.cid));
      trail(ev.from, ev.to, colorOf(ev.cid));
      break;
    case 'round':
      if (ev.phase === 'start') {
        el.roundEnd.hidden = true;
        sfx.play('start');
        banner(`라운드 시작 — ${MAPS[ev.map].name}`, '');
        log(`🏁 새 라운드: <b>${MAPS[ev.map].name}</b>`);
      } else {
        sfx.play('end');
        showPodium(ev.ranking);
      }
      break;
    default:
  }
}

// ---------------------------------------------------------------- HUD
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function log(html) {
  const li = document.createElement('li');
  const t = new Date();
  li.innerHTML = `<span>${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}</span> ${html}`;
  el.log.prepend(li);
  while (el.log.children.length > 30) el.log.lastChild.remove();
}

let bannerTimer = 0;
function banner(text, kind) {
  el.banner.textContent = text;
  el.banner.className = `banner ${kind}`;
  el.banner.hidden = false;
  el.banner.style.animation = 'none'; void el.banner.offsetWidth; el.banner.style.animation = '';
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => { el.banner.hidden = true; }, 2200);
}

function showPodium(ranking) {
  const medals = ['🥇', '🥈', '🥉'];
  el.podium.innerHTML = ranking.slice(0, 6).map((r, i) => `
    <li class="${io && r.cid === io.cid ? 'me' : ''}">
      <span>${medals[i] || `${i + 1}.`}</span>
      <span class="sw" style="width:14px;height:14px;border-radius:50%;background:${COLORS[r.color]}"></span>
      <span>${esc(r.name)} ${r.kind === 'ard' ? '🔌' : ''}</span>
      <span class="score">${r.score}</span>
    </li>`).join('') || '<li>참가자 없음</li>';
  el.nextMap.textContent = MAPS[((snap?.map ?? 0) + 1) % MAPS.length].name;
  el.roundEnd.hidden = false;
}

function renderHud() {
  if (!snap) return;
  el.mapName.textContent = MAPS[snap.map].name;
  const sec = Math.ceil(snap.left / 1000);
  el.timer.textContent = snap.ph === 'play' ? `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}` : '대기';
  el.timer.classList.toggle('hurry', snap.ph === 'play' && sec <= 10);
  if (snap.ph === 'end') el.nextIn.textContent = sec;
  else el.roundEnd.hidden = true;

  const sorted = [...snap.p].sort((a, b) => b[P.SCORE] - a[P.SCORE]);
  el.ranking.innerHTML = sorted.map((p) => {
    const isMe = io && p[P.CID] === io.cid;
    const isIt = p[P.CID] === snap.it;
    return `<li class="${isMe ? 'me' : ''} ${isIt ? 'it' : ''}">
      <span class="sw" style="background:${COLORS[p[P.COLOR]]}"></span>
      <span class="nm">${isIt ? '👑 ' : ''}${esc(p[P.NAME])}${isMe ? ' (나)' : ''} ${p[P.KIND] === 'ard' ? '🔌' : ''}</span>
      <span class="pos">${p[P.X]},${p[P.Y]}</span>
      <span class="sc">${p[P.SCORE]}</span>
    </li>`;
  }).join('');

  const m = me();
  if (m) {
    el.meSwatch.style.background = COLORS[m[P.COLOR]];
    el.meName.textContent = m[P.NAME];
    el.meSub.textContent = `${snap.it === m[P.CID] ? '👑 술래 · ' : ''}점수 ${m[P.SCORE]} · 위치 (${m[P.X]}, ${m[P.Y]})`;
  } else if (!joined) {
    el.meName.textContent = '관전 중';
    el.meSub.textContent = `${snap.p.length}명 플레이 중`;
  }
}

// ---------------------------------------------------------------- effects
function burst(x, y, color, n) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const s = 1.5 + Math.random() * 4;
    particles.push({ x: x + 0.5, y: y + 0.5, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 1, color });
  }
}
function trail(from, to, color) {
  for (let i = 0; i <= 12; i++) {
    const t = i / 12;
    particles.push({ x: from[0] + (to[0] - from[0]) * t + 0.5, y: from[1] + (to[1] - from[1]) * t + 0.5, vx: 0, vy: 0, life: 0.6 + t * 0.4, color });
  }
}
function floater(x, y, text, color) { floaters.push({ x: x + 0.5, y: y + 0.2, text, color, life: 1 }); }
function shake(ms) { shakeUntil = performance.now() + ms; }
function flash() { el.board.classList.add('flash'); setTimeout(() => el.board.classList.remove('flash'), 400); }

// ---------------------------------------------------------------- rendering
function resize() {
  const r = el.board.getBoundingClientRect();
  const narrow = window.innerWidth <= 860;
  const availW = r.width - (narrow ? 8 : 28);
  const availH = narrow ? window.innerHeight * 0.62 : r.height - 28;
  tile = Math.max(14, Math.floor(Math.min(availW / COLS, availH / ROWS)));
  const dpr = window.devicePixelRatio || 1;
  el.canvas.style.width = `${COLS * tile}px`;
  el.canvas.style.height = `${ROWS * tile}px`;
  el.canvas.width = COLS * tile * dpr;
  el.canvas.height = ROWS * tile * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  mapLayerKey = '';
}
new ResizeObserver(resize).observe(el.board);
window.addEventListener('resize', resize);

function buildMapLayer(mapIndex) {
  const c = document.createElement('canvas');
  const dpr = window.devicePixelRatio || 1;
  c.width = COLS * tile * dpr; c.height = ROWS * tile * dpr;
  const g = c.getContext('2d');
  g.scale(dpr, dpr);
  g.fillStyle = '#0f1326';
  g.fillRect(0, 0, COLS * tile, ROWS * tile);
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const px = x * tile, py = y * tile;
      if (isWall(mapIndex, x, y)) {
        g.fillStyle = '#2b3266';
        g.fillRect(px, py, tile, tile);
        g.fillStyle = '#3c4590';
        g.fillRect(px + 2, py + 2, tile - 4, tile * 0.4);
        g.fillStyle = '#1d2249';
        g.fillRect(px + 2, py + tile * 0.62, tile - 4, tile * 0.34);
      } else {
        g.fillStyle = (x + y) % 2 ? '#121732' : '#141a39';
        g.fillRect(px, py, tile, tile);
      }
    }
  }
  return c;
}

let lastFrame = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  const W = COLS * tile, H = ROWS * tile;
  ctx.save();
  ctx.clearRect(0, 0, W, H);
  if (now < shakeUntil) ctx.translate((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8);

  const mapIndex = snap?.map ?? 0;
  const key = `${mapIndex}:${tile}`;
  if (key !== mapLayerKey) { mapLayer = buildMapLayer(mapIndex); mapLayerKey = key; }
  ctx.drawImage(mapLayer, 0, 0, W, H);

  if (snap) {
    drawCoins(now);
    drawPlayers(now, dt);
    dangerFx(now);
  } else {
    ctx.fillStyle = '#8a90b8';
    ctx.font = `${Math.round(tile * 0.6)}px system-ui`;
    ctx.textAlign = 'center';
    ctx.fillText('게임 서버 대기 중…', W / 2, H / 2);
  }
  drawParticles(dt);
  ctx.restore();
  updateDashMeter();
  requestAnimationFrame(frame);
}

function drawCoins(now) {
  for (const idx of snap.c) {
    const x = idx % COLS, y = (idx - x) / COLS;
    const cx = (x + 0.5) * tile, cy = (y + 0.5) * tile + Math.sin(now / 250 + idx) * tile * 0.05;
    const w = Math.abs(Math.cos(now / 400 + idx)) * tile * 0.22 + tile * 0.06;
    ctx.fillStyle = '#ffb703';
    ctx.beginPath(); ctx.ellipse(cx, cy, w, tile * 0.24, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#ffe08a';
    ctx.beginPath(); ctx.ellipse(cx - w * 0.25, cy - tile * 0.06, w * 0.35, tile * 0.09, 0, 0, Math.PI * 2); ctx.fill();
  }
}

function drawPlayers(now, dt) {
  const k = Math.min(1, dt * 16);
  const myCid = io?.cid;
  const list = [...snap.p].sort((a, b) => (a[P.CID] === myCid) - (b[P.CID] === myCid)); // me on top
  for (const p of list) {
    const cid = p[P.CID];
    const a = actors.get(cid);
    if (!a) continue;
    a.rx += (a.tx - a.rx) * k;
    a.ry += (a.ty - a.ry) * k;
    const cx = (a.rx + 0.5) * tile, cy = (a.ry + 0.5) * tile;
    const r = tile * 0.36;
    const color = COLORS[p[P.COLOR]];
    const isIt = cid === snap.it;
    const isMe = cid === myCid;
    const flags = p[P.FLAGS];

    if (isIt) { // pulsing red aura
      const pr = r * (1.5 + Math.sin(now / 120) * 0.2);
      const g = ctx.createRadialGradient(cx, cy, r * 0.5, cx, cy, pr);
      g.addColorStop(0, 'rgba(255,59,92,.65)'); g.addColorStop(1, 'rgba(255,59,92,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(cx, cy, pr, 0, Math.PI * 2); ctx.fill();
    }
    if (isMe) { // locator ring
      ctx.strokeStyle = 'rgba(255,255,255,.35)';
      ctx.lineWidth = 2;
      const rr = r * (1.4 + ((now / 900) % 1) * 0.9);
      ctx.globalAlpha = 1 - ((now / 900) % 1);
      ctx.beginPath(); ctx.arc(cx, cy, rr, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 1;
    }

    ctx.globalAlpha = flags & FLAG.INVULN ? 0.45 + 0.4 * Math.abs(Math.sin(now / 70)) : 1;
    // body
    ctx.fillStyle = 'rgba(0,0,0,.35)';
    ctx.beginPath(); ctx.ellipse(cx, cy + r * 0.85, r * 0.8, r * 0.25, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = isMe ? 3 : 1.5;
    ctx.strokeStyle = isMe ? '#ffffff' : 'rgba(0,0,0,.5)';
    ctx.stroke();
    // eyes look where the player moved last
    const [fx, fy] = { U: [0, -1], D: [0, 1], L: [-1, 0], R: [1, 0] }[a.face];
    for (const side of [-1, 1]) {
      const ex = cx + fx * r * 0.3 + (fy ? side * r * 0.32 : 0);
      const ey = cy + fy * r * 0.3 + (fx ? side * r * 0.32 : 0) - r * 0.1;
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(ex, ey, r * 0.2, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#111';
      ctx.beginPath(); ctx.arc(ex + fx * r * 0.08, ey + fy * r * 0.08, r * 0.1, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;

    ctx.textAlign = 'center';
    if (isIt) {
      ctx.font = `${Math.round(tile * 0.5)}px system-ui`;
      ctx.fillText('👑', cx, cy - r - 2);
    }
    if (flags & FLAG.STUN) {
      ctx.font = `${Math.round(tile * 0.32)}px system-ui`;
      for (let i = 0; i < 3; i++) {
        const ang = now / 200 + (i * Math.PI * 2) / 3;
        ctx.fillText('★', cx + Math.cos(ang) * r, cy - r * 0.9 + Math.sin(ang) * r * 0.3);
      }
    }
    // name tag
    const label = `${p[P.KIND] === 'ard' ? '🔌' : ''}${p[P.NAME]}`;
    ctx.font = `600 ${Math.max(10, Math.round(tile * 0.3))}px system-ui`;
    const tw = ctx.measureText(label).width + 8;
    const ty = cy + r + tile * 0.32;
    ctx.fillStyle = 'rgba(5,7,16,.75)';
    ctx.fillRect(cx - tw / 2, ty - tile * 0.2, tw, tile * 0.36);
    ctx.fillStyle = isMe ? '#fff' : color;
    ctx.fillText(label, cx, ty + tile * 0.07);
    if (isMe) { // bouncing "나" marker
      const by = cy - r - tile * (isIt ? 0.75 : 0.3) - Math.abs(Math.sin(now / 220)) * tile * 0.15;
      ctx.fillStyle = '#fff';
      ctx.font = `800 ${Math.round(tile * 0.3)}px system-ui`;
      ctx.fillText('▼ 나', cx, by);
    }
  }
}

function dangerFx(now) {
  const m = me();
  if (!m || !snap.it || snap.it === m[P.CID] || snap.ph !== 'play') return;
  const it = snap.p.find((p) => p[P.CID] === snap.it);
  if (!it) return;
  const d = Math.abs(it[P.X] - m[P.X]) + Math.abs(it[P.Y] - m[P.Y]);
  if (d > RULES.NEAR_CELLS) return;
  const W = COLS * tile, H = ROWS * tile;
  const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.7);
  g.addColorStop(0, 'rgba(255,0,40,0)');
  g.addColorStop(1, `rgba(255,0,40,${0.25 + 0.1 * Math.sin(now / 100)})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  if (now - lastHeartAt > 260 + d * 160) { lastHeartAt = now; sfx.play('heart'); }
}

function drawParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const q = particles[i];
    q.x += q.vx * dt; q.y += q.vy * dt; q.vx *= 0.9; q.vy *= 0.9;
    q.life -= dt * 1.6;
    if (q.life <= 0) { particles.splice(i, 1); continue; }
    ctx.globalAlpha = q.life;
    ctx.fillStyle = q.color;
    ctx.beginPath(); ctx.arc(q.x * tile, q.y * tile, tile * 0.08 * q.life + 1, 0, Math.PI * 2); ctx.fill();
  }
  ctx.textAlign = 'center';
  for (let i = floaters.length - 1; i >= 0; i--) {
    const f = floaters[i];
    f.y -= dt * 1.2; f.life -= dt * 0.9;
    if (f.life <= 0) { floaters.splice(i, 1); continue; }
    ctx.globalAlpha = Math.min(1, f.life * 1.5);
    ctx.font = `800 ${Math.round(tile * 0.45)}px system-ui`;
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.7)';
    ctx.strokeText(f.text, f.x * tile, f.y * tile);
    ctx.fillStyle = f.color;
    ctx.fillText(f.text, f.x * tile, f.y * tile);
  }
  ctx.globalAlpha = 1;
}

function updateDashMeter() {
  const m = me();
  if (!m) return;
  const left = Math.max(0, m[P.DASH] - (performance.now() - lastSnapAt));
  el.dashFill.style.width = `${100 - (left / RULES.DASH_COOLDOWN_MS) * 100}%`;
  el.dashMeter.classList.toggle('cool', left > 0);
}

// ---------------------------------------------------------------- start
resize();
connect();
requestAnimationFrame(frame);
if (!WATCH) el.name.focus();
