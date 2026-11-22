// Browser E2E: two player windows + one watch window + a fake Arduino (CongSocket TCP)
// + two bots. Verifies everyone shares the same map/state and saves screenshots.
//   npm run test:browser          (set CHROME_PATH to use an installed Chrome)
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { IOCongSocket } from 'iosignal';
import { startArena } from '../src/arena-server.mjs';
import { TAGS } from '../public/protocol.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(__dirname, '..', 'screenshots');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadChromium() {
  try {
    const { chromium } = await import('playwright');
    return { chromium, opts: {} };
  } catch {
    const { chromium } = await import('playwright-core');
    if (!process.env.CHROME_PATH) throw new Error('Set CHROME_PATH to a Chrome/Chromium executable.');
    return { chromium, opts: { executablePath: process.env.CHROME_PATH } };
  }
}

function check(cond, msg) {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

const arena = await startArena({ port: 0, congPort: 0, log: () => {} });
const base = `http://127.0.0.1:${arena.port}`;
console.log(`arena on ${base}, cong ${arena.congPort}`);
await mkdir(SHOTS, { recursive: true });

const { chromium, opts } = await loadChromium();
const browser = await chromium.launch(opts);
const bots = spawn(process.execPath, [path.join(__dirname, 'bots.mjs'), '2', `ws://127.0.0.1:${arena.port}/ws`], { stdio: 'ignore' });
let ard;
try {
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const ctxW = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  const w = await ctxW.newPage();
  const errors = [];
  for (const p of [a, b, w]) p.on('pageerror', (e) => errors.push(e.message));

  await a.goto(base);
  await b.goto(base);
  await w.goto(`${base}/?watch`);
  await a.fill('#name', '앨리스');
  await a.click('#join-btn');
  await b.fill('#name', 'Bob');
  await b.click('#join-btn');
  await w.click('#watch-btn');

  // Fake ESP32-C3: exactly the strings the sketch sends over TCP.
  ard = new IOCongSocket(`cong://127.0.0.1:${arena.congPort}`);
  const fx = [];
  ard.on('@fx', (_t, text) => fx.push(text));
  await new Promise((r) => ard.on('ready', r));
  ard.signal(TAGS.IN, 'J,ard,esp-c3');
  setInterval(() => ard.signal(TAGS.IN, 'H'), 2000).unref();

  await a.waitForFunction(() => document.querySelectorAll('#ranking li').length === 5, null, { timeout: 8000 });
  check(true, 'player A sees 5 players (2 web + 1 arduino + 2 bots)');
  const countW = await w.$$eval('#ranking li', (l) => l.length);
  check(countW === 5, 'watch screen sees the same 5 players');
  check(fx.includes('join'), 'arduino received direct @fx "join"');
  check((await a.textContent('#ranking')).includes('🔌'), 'arduino player is marked 🔌 on the web');

  // A moves with the keyboard
  const posA = async () => (await a.textContent('#me-sub')).match(/\((\d+), (\d+)\)/)?.slice(1).join(',');
  const before = await posA();
  for (const key of ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp']) {
    await a.keyboard.down(key); await wait(500); await a.keyboard.up(key); await wait(300);
    if ((await posA()) !== before) break;
  }
  const after = await posA();
  check(after !== before, `keyboard movement A ${before} -> ${after}`);
  await wait(400);
  const seenByB = await b.$$eval('#ranking li', (l) => l.find((li) => li.textContent.includes('앨리스'))?.querySelector('.pos')?.textContent);
  check(seenByB === after, `B sees A at the same cell (${seenByB})`);

  // Arduino moves (hold for 600 ms) and the web shows it
  const ardPos = async () => w.$$eval('#ranking li', (l) => l.find((li) => li.textContent.includes('esp-c3'))?.querySelector('.pos')?.textContent);
  const ardBefore = await ardPos();
  for (const d of ['U', 'D', 'L', 'R']) {
    ard.signal(TAGS.IN, `D,${d}`); await wait(600);
    ard.signal(TAGS.IN, 'D,0'); await wait(300);
    if ((await ardPos()) !== ardBefore) break;
  }
  check((await ardPos()) !== ardBefore, `arduino moved on every screen ${ardBefore} -> ${await ardPos()}`);

  await a.keyboard.press('Space');
  await wait(200);
  check(await a.$eval('#dash-meter', (e) => e.classList.contains('cool')), 'dash starts the cooldown meter');

  check(await a.$eval('#ranking', (e) => e.textContent.includes('👑')), 'a tagger (👑) exists');
  await wait(3000); // let bots run around for nicer screenshots
  await a.screenshot({ path: path.join(SHOTS, 'player-a.png') });
  await b.screenshot({ path: path.join(SHOTS, 'player-b.png') });
  await w.screenshot({ path: path.join(SHOTS, 'watch.png') });

  // mobile layout
  const m = await (await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })).newPage();
  await m.goto(base);
  await m.fill('#name', '모바일');
  await m.click('#join-btn');
  await m.waitForFunction(() => document.querySelectorAll('#ranking li').length === 6, null, { timeout: 8000 });
  check(await m.$eval('#dpad', (e) => getComputedStyle(e).display !== 'none'), 'touch D-pad visible on mobile');
  const noHScroll = await m.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  check(noHScroll, 'no horizontal scroll at 390px');
  await wait(500);
  await m.screenshot({ path: path.join(SHOTS, 'mobile.png') });

  // join screen
  const j = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await j.goto(base);
  await wait(600);
  await j.screenshot({ path: path.join(SHOTS, 'join.png') });

  check(errors.length === 0, `no page errors ${errors.join(' | ')}`);
  console.log('\nBrowser E2E passed. Screenshots in screenshots/');
} finally {
  bots.kill('SIGINT');
  ard?.destroy?.();
  await browser.close();
  await arena.close();
}
process.exit(0);
