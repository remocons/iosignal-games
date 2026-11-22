// Player bots for trying the game alone: they wander, jump now and then and lay mines.
//   node scripts/bots.mjs [count] [ws://host:port/ws]
import { IO } from 'iosignal';
import { TAGS, P, formatInput } from '../public/shared.js';

const count = Number(process.argv[2] || 3);
const url = process.argv[3] || 'ws://127.0.0.1:5190/ws';
const NAMES = ['봇토리', '삐약봇', '꿀꿀봇', '깡총봇', '냥봇', '펭봇'];
const bots = [];

for (let i = 0; i < count; i++) {
  const io = new IO(url);
  const name = NAMES[i % NAMES.length];
  let snap = null;
  let dir = [0, 0];
  const send = (op, ...a) => { if (io.stateName === 'ready') io.signal(TAGS.IN, formatInput(op, ...a)); };
  io.on('ready', () => {
    io.subscribe(TAGS.STATE);
    send('J', 'bot', name, (i * 3) % 8);
  });
  io.on('message', (tag, s) => { if (tag === TAGS.STATE) snap = s; });
  setInterval(() => {
    const me = snap?.p.find((p) => p[P.CID] === io.cid);
    if (!me) { send('J', 'bot', name, (i * 3) % 8); return; }
    if (Math.random() < 0.25) {
      const a = Math.random() * Math.PI * 2;
      dir = Math.random() < 0.15 ? [0, 0] : [Math.round(Math.cos(a) * 100), Math.round(Math.sin(a) * 100)];
      send('W', ...dir);
    }
    if (Math.random() < 0.12) send('U');
    if (Math.random() < 0.04) send('B');
  }, 400);
  setInterval(() => send('H'), 3000);
  bots.push(io);
}

console.log(`${count} bots -> ${url}  (Ctrl+C to stop)`);
process.on('SIGINT', () => {
  for (const b of bots) { if (b.stateName === 'ready') b.signal(TAGS.IN, 'L'); }
  setTimeout(() => process.exit(0), 200);
});
