// 동물원 생존하기 (Zoo Survival) — shared by the browser and the Node game server.
// No dependencies, so both can import it as an ES module.

/** IOSignal tags. The game host (server.host('zoo')) owns every output tag. */
export const TAGS = {
  IN: 'zoo#in',          // client -> host (TEXT "OP,args"; the server tells the host who sent it)
  STATE: 'zoo#state',    // host -> all   (OBJECT snapshot, 20 Hz)
  ROSTER: 'zoo#$roster', // host -> all   (OBJECT names and animals; '$' = retained)
  EVT: 'zoo#evt',        // host -> all   (OBJECT events: deaths, explosions, joins, escapes)
  FX: '@fx',             // host -> one Arduino (TEXT feedback word)
};

export const RULES = {
  TICK_MS: 50,
  SPEED: 3.4,            // tiles per second at full stick
  JUMP_MS: 800,
  JUMP_H: 1.7,           // peak height in tiles: high enough to clear any animal or robot
  JUMP_GAP_MS: 150,      // after landing, before the next jump
  AIR_Z: 0.3,            // above this a player is in the air: no mines, no water
  RADIUS: 0.22,          // player body, for walls and trees
  STEP: 0.5,             // highest step up while walking (stairs); 1.0 in the air
  MINE_MAX: 3,
  MINE_GAP_MS: 1200,
  MINE_ARM_MS: 900,
  MINE_LIFE_MS: 60000,
  MINE_TRIGGER: 0.45,
  MINE_BLAST: 1.35,
  RESPAWN_MS: 3000,
  SAFE_MS: 2000,         // after spawning nothing can kill you
  TIMEOUT_MS: 15000,     // no input or heartbeat -> removed
  HEARTBEAT_MS: 3000,
  MAX_PLAYERS: 16,
  NEAR: 3,               // Arduino radar beep when a bot is this close
  BOT_KILL: 5,           // points for blowing up a bot
  PLAYER_KILL: 10,       // points for blowing up another player
  ESCAPE: 50,            // points for the first animal through the exit
  NEXT_MS: 4000,         // after an escape, everyone moves to the next area
};

/*
 Map legend (one character per tile)
   .  grass          ,  path           G  gate (spawn, bots stay out)   E  exit (escape!)
   T  tree           R  rock           b  bush          F  fence     (solid)
   ~  water (river, pond)   -  ditch (water, one tile: jump it)   =  bridge
   1  grass hill (height 1) 2  hill top (height 2)
   s  stairs 0 -> 1         S  stairs 1 -> 2

 Bots: zone [x0, y0, x1, y1] tiles they wander in; chase: how near a player must be;
 leash: how far from home they follow; tall: a jumping animal higher than this passes over it;
 water: swims only in water (crocodile).
*/
const lion = (home, zone) => ({ type: 'lion', home, zone, walk: 1.2, run: 2.6, chase: 4.5, leash: 9, catch: 0.55, tall: 0.8 });
const bear = (home, zone) => ({ type: 'bear', home, zone, walk: 1.0, run: 2.4, chase: 4, leash: 7, catch: 0.6, tall: 0.85 });
const gorilla = (home, zone) => ({ type: 'gorilla', home, zone, walk: 1.3, run: 2.5, chase: 4, leash: 8, catch: 0.55, tall: 1.0 });
const robot = (home, zone) => ({ type: 'robot', home, zone, walk: 1.4, run: 2.3, chase: 5, leash: 8, catch: 0.5, tall: 1.0 });
const croc = (home, zone) => ({ type: 'croc', home, zone, walk: 1.0, run: 2.0, chase: 3.5, leash: 12, catch: 0.75, tall: 0.35, water: true });

export const STAGES = [
  {
    name: '동물원 광장',
    rows: [
      'TTTTTTTTTTTTTT~~~TTTTTTTTTTTTTTT',
      'T......b......~~~.....1111111EET',
      'T.FFFFFFFFFF..~~~.....1111111..T',
      'T.F........F..~~~....s1112111..T',
      'T.F..T.....F..===....s111S111..T',
      'T.F.....T...,.~~~....s1111111..T',
      'T.F........F..~~~.......1111...T',
      'T.FFFFF..FFF..~~~...b..........T',
      'T.......,,,,,,===,,,,,,,,,,....T',
      'T..T....,.....~~~.....T....T...T',
      'T.......,..T..~~~..........b...T',
      'T..b....,.....~~~~~~~..........T',
      'T.......,.....~~~~~~~...RR.....T',
      'T.......,,,,,,=======,,,,......T',
      'T.......,.....~~~~~~~...,......T',
      'T...T...,......~~~~.....,...T..T',
      'T.......,.......~~......,......T',
      'T.......,..b.....~......,......T',
      'T.......,........--------------T',
      'T..GGG..,.....T.........,......T',
      'T..GGG..,,,,,,,,,,,,,,,,,..RR..T',
      'T..GGG..........b........T.....T',
      'T..............................T',
      'TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT',
    ],
    bots: [
      lion([4, 4], [3, 3, 10, 6]), lion([6, 5], [3, 3, 10, 6]),
      bear([25, 2], [22, 1, 28, 6]),
      gorilla([5, 12], [1, 9, 12, 17]),
      robot([20, 21], [17, 19, 30, 22]), robot([29, 21], [17, 19, 30, 22]),
      croc([17, 11], [14, 0, 20, 17]),
    ],
  },
  {
    name: '악어 늪지',
    rows: [
      'TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT',
      'TEE..T......T..............T...T',
      'TEE......T........T............T',
      'T..,,,,,,,,,,,,,,,,,,,,,,,,,,..T',
      'T..........b..........b........T',
      'T~~~~~==~~~~~~~~~~~~~~~~==~~~~~T',
      'T~~~~~==~~~~~~~~~~~~~~~~==~~~~~T',
      'T...T..........,.....T.........T',
      'T.........T....,............T..T',
      'T--------------,---------------T',
      'T...........T..,...s11111......T',
      'T..T...R.......,...s11111.R....T',
      'T.......T......,...........T...T',
      'T~~~~~~~~~~~~~~==~~~~~~~~~~~~~~T',
      'T~~~~~~~~~~~~~~==~~~~~~~~~~~~~~T',
      'T.b............,..R.....b....T.T',
      'T....T.........,...............T',
      'T.........-----,---------------T',
      'T.....b........,....T..........T',
      'T........T.....,..........GGG..T',
      'T...R..........,,,,,,,,,,,GGG..T',
      'T...........T.............GGG..T',
      'T......................T.......T',
      'TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT',
    ],
    bots: [
      croc([12, 5], [1, 5, 30, 6]), croc([25, 13], [1, 13, 30, 14]),
      gorilla([8, 1], [3, 1, 14, 4]),
      lion([8, 11], [1, 10, 14, 12]), lion([22, 15], [17, 15, 29, 16]),
      robot([20, 21], [17, 18, 24, 22]),
    ],
  },
  {
    name: '로봇 공장',
    rows: [
      'TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT',
      'T.......F...............F....EET',
      'T.....b.F.....R.........F....EET',
      'T..T....F.........~~~~..F......T',
      'T.......F..T......~~,,,,,,,,,..T',
      'T...R...F.........~~~~..F......T',
      'T.......F...............F......T',
      'T.......F..R....F.......F...R..T',
      'T....T..F.......F.......F......T',
      'T.......F...,,,,,,,,,,,,F....T.T',
      'T.......F.......F.......F......T',
      'T.......F.......F.....R.F......T',
      'T.,,,,,,,,,,,,,,F.......F111111T',
      'T.......F.......F..T....F1122S1T',
      'T.......F.b.....F.......F112211T',
      'T.T.....F....T..F...R...F111111T',
      'T.......F.......F.......Fss....T',
      'T.....R.........F..............T',
      'T........-------F..........b...T',
      'T.GGG...........F....T.........T',
      'T.GGG...........F..........T...T',
      'T.GGG.......T...F..b...........T',
      'T...............F..............T',
      'TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT',
    ],
    bots: [
      robot([4, 6], [1, 1, 7, 11]), robot([12, 5], [9, 1, 15, 11]), robot([20, 7], [17, 6, 23, 11]),
      robot([12, 15], [9, 13, 15, 17]), robot([20, 19], [17, 17, 30, 22]),
      bear([26, 13], [25, 12, 30, 15]),
      croc([18, 3], [18, 3, 21, 5]),
    ],
  },
];

// The current area. Live bindings: modules that import MAP, W, H, ... see the new values after setStage().
export let STAGE = 0;
export let MAP = STAGES[0].rows;
export let W = MAP[0].length;
export let H = MAP.length;
export let BOTS = STAGES[0].bots;
export let SPAWNS = [];
export let EXITS = [];

export function setStage(i) {
  STAGE = ((i % STAGES.length) + STAGES.length) % STAGES.length;
  MAP = STAGES[STAGE].rows;
  W = MAP[0].length;
  H = MAP.length;
  BOTS = STAGES[STAGE].bots;
  SPAWNS = [];
  EXITS = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (MAP[y][x] === 'G') SPAWNS.push([x + 0.5, y + 0.5]);
      if (MAP[y][x] === 'E') EXITS.push([x + 0.5, y + 0.5]);
    }
  }
  return STAGE;
}
setStage(0);

const HEIGHT = { '1': 1, '2': 2, s: 0.5, S: 1.5 };
const SOLID = new Set(['T', 'R', 'b', 'F']);
const WATER = new Set(['~', '-']);

export function tileAt(x, y) {
  const tx = Math.floor(x), ty = Math.floor(y);
  if (tx < 0 || ty < 0 || tx >= W || ty >= H) return 'T';
  return MAP[ty][tx];
}
export const tileHeight = (x, y) => HEIGHT[tileAt(x, y)] ?? 0;
export const isSolid = (x, y) => SOLID.has(tileAt(x, y));
export const isWater = (x, y) => WATER.has(tileAt(x, y));

export const BOT_NAMES = { lion: '사자', bear: '곰', gorilla: '고릴라', robot: '경비 로봇', croc: '악어' };

/** Player animals (voxel models in voxel.js). */
export const AVATARS = ['chick', 'pig', 'rabbit', 'panda', 'fox', 'frog', 'penguin', 'cat'];
export const AVATAR_NAMES = ['병아리', '돼지', '토끼', '판다', '여우', '개구리', '펭귄', '고양이'];

/**
 * Input (TEXT, so an Arduino can build it with snprintf):
 *   "J,<kind>,<name>,<avatar>"  join   kind: web | ard | bot, avatar: 0-7
 *   "W,<wx>,<wy>"               move along the MAP GRID: x and y -100..100 (0,0 = stop).
 *                               Browsers turn their stick into this for the view they show;
 *                               Arduino buttons: up (0,-100) right (100,0) down (0,100) left (-100,0).
 *   "U"                         jump
 *   "B"                         lay a mine
 *   "H"                         heartbeat
 *   "L"                         leave
 */
export function formatInput(op, ...args) {
  return [op, ...args].join(',');
}
export function parseInput(text) {
  if (typeof text !== 'string' || text.length > 80) return null;
  const [op, ...args] = text.split(',');
  if (!/^[JWUBHL]$/.test(op)) return null;
  return { op, args };
}

/** A grid vector -1..1 in each axis -> length 0..1 in the same direction. */
export function gridDir(wx, wy) {
  const len = Math.hypot(wx, wy);
  return len > 1e-6 ? [wx / Math.max(1, len), wy / Math.max(1, len)] : [0, 0];
}

/**
 * Screen stick -> grid direction for an isometric view turned by `turn` quarter turns.
 * Screen x = (vx - vy), screen y = (vx + vy) / 2 in view coordinates; the view is the map
 * turned (see Iso in voxel.js). Returns [wx, wy] with length 0..1.
 */
export function screenToWorld(sx, sy, turn = 0) {
  let vx = sx + 2 * sy;
  let vy = 2 * sy - sx;
  const len = Math.hypot(vx, vy);
  const mag = Math.min(1, Math.hypot(sx, sy));
  if (len < 1e-6) return [0, 0];
  return viewToWorld((vx / len) * mag, (vy / len) * mag, turn);
}

/**
 * A direction along the grid of the view on screen -> the map grid. Arrow keys and Arduino buttons
 * move along the grid: up (0,-1) is up-right on the screen, right (1,0) down-right.
 */
export function viewToWorld(vx, vy, turn = 0) {
  switch (((turn % 4) + 4) % 4) {
    case 1: return [vy, -vx];
    case 2: return [-vx, -vy];
    case 3: return [-vy, vx];
    default: return [vx, vy];
  }
}

/** Snapshot tuples. Positions are hundredths of a tile. */
export const P = { CID: 0, X: 1, Y: 2, Z: 3, FACE: 4, FLAGS: 5, SCORE: 6, LIFE: 7, MINES: 8 };
export const B = { ID: 0, TYPE: 1, X: 2, Y: 3, FACE: 4, FLAGS: 5 };
export const M = { ID: 0, X: 1, Y: 2, ARMED: 3, OWNER: 4 };
export const R = { CID: 0, NAME: 1, AVATAR: 2, KIND: 3 };
export const FLAG = { DEAD: 1, SAFE: 2, MOVING: 4, CHASING: 8, ESCAPED: 16 };

export function cleanName(name, fallback) {
  const clean = String(name ?? '').replace(/[^\p{L}\p{N}_\-]/gu, '').slice(0, 10);
  return clean || fallback;
}
