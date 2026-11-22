// IOSignal Arena — shared protocol (used by the browser AND the Node game server).
// Keep this file dependency-free so both environments can import it as an ES module.

/** IOSignal tags */
export const TAGS = {
  IN: 'arena#in',       // every client -> game host   (TEXT "OP,args..."; the server tells the host who sent it)
  STATE: 'arena#state', // game host -> all            (OBJECT snapshot: 15 Hz + right after a change)
  ROSTER: 'arena#$roster', // game host -> all         (OBJECT static player info; '$' = retained, new subscribers get it at once)
  EVT: 'arena#evt',     // game host -> all            (OBJECT game events for sound/effects)
  FX: '@fx',            // game host -> one device     (TEXT, direct signal; the device receives tag "@fx")
};
// Only the game host may send STATE, ROSTER, EVT and FX: the server drops them from clients.

export const COLS = 21;
export const ROWS = 15;

/** Game rules. All times are milliseconds. */
export const RULES = {
  STEP_MS: 140,            // one cell per 140 ms while a direction is held
  DASH_CELLS: 3,
  DASH_COOLDOWN_MS: 4000,
  INVULN_MS: 1500,         // the player who passed the tag cannot be tagged back
  STUN_MS: 1000,           // the new tagger is frozen for a moment
  ROUND_MS: 90000,
  END_MS: 7000,            // ranking screen between rounds
  COINS: 10,
  IT_PENALTY_MS: 2000,     // tagger loses 1 point every 2 s
  TAG_BONUS: 3,
  TIMEOUT_MS: 6000,        // no input/heartbeat for 6 s -> removed
  HEARTBEAT_MS: 2000,
  SNAPSHOT_MS: 66,         // ~15 snapshots per second when nothing changes
  SNAPSHOT_MIN_MS: 16,     // a change is sent at once, but at most one snapshot per 16 ms
  NEAR_CELLS: 3,           // Arduino "radar" beep when the tagger is this close
  MAX_PLAYERS: 12,
};

export const COLORS = [
  '#4cc9f0', '#f72585', '#b8f35d', '#ffb703', '#9b5de5', '#2ec4b6',
  '#ff7b54', '#f15bb5', '#00bbf9', '#fee440', '#8ac926', '#e0aaff',
];

export const DIRS = { U: [0, -1], D: [0, 1], L: [-1, 0], R: [1, 0] };

// '#' wall, '.' floor. Every map is 21 x 15 and fully connected (checked by tests).
export const MAPS = [
  {
    name: 'Classic',
    rows: [
      '#####################',
      '#.........#.........#',
      '#.###.###.#.###.###.#',
      '#...................#',
      '#.###.#.#####.#.###.#',
      '#.....#...#...#.....#',
      '###.#.###.#.###.#.###',
      '#...#...........#...#',
      '###.#.###.#.###.#.###',
      '#.....#...#...#.....#',
      '#.###.#.#####.#.###.#',
      '#...................#',
      '#.###.###.#.###.###.#',
      '#.........#.........#',
      '#####################',
    ],
  },
  {
    name: 'Rooms',
    rows: [
      '#####################',
      '#...#.........#.....#',
      '#.#.#.#######.#.###.#',
      '#.#.....#.........#.#',
      '#.#####.#.#####.#.#.#',
      '#.......#.....#.#...#',
      '#.###.#####.#.#.###.#',
      '#.....#.....#.......#',
      '#.###.#.#####.###.#.#',
      '#...#.#.......#...#.#',
      '###.#.###.###.#.###.#',
      '#...#.....#.......#.#',
      '#.#####.#.#.#####.#.#',
      '#.......#...........#',
      '#####################',
    ],
  },
  {
    name: 'Cross',
    rows: [
      '#####################',
      '#.........#.........#',
      '#.#######.#.#######.#',
      '#.#.....#...#.....#.#',
      '#.#.###.#####.###.#.#',
      '#...#.............#.#',
      '###.#.###.#.###.#.#.#',
      '#.........#.........#',
      '#.#.#.###.#.###.#.###',
      '#.#.............#...#',
      '#.#.###.#####.###.#.#',
      '#.#.....#...#.....#.#',
      '#.#######.#.#######.#',
      '#.........#.........#',
      '#####################',
    ],
  },
];

export function isWall(mapIndex, x, y) {
  const map = MAPS[mapIndex % MAPS.length];
  if (x < 0 || y < 0 || x >= COLS || y >= ROWS) return true;
  return map.rows[y][x] === '#';
}

/**
 * Input wire format (TEXT, so an Arduino can build it with snprintf):
 *   "J,<kind>,<name>"   join   kind: web | ard | bot
 *   "D,<U|D|L|R|0>"     held direction (0 = released)
 *   "A"                 action (dash)
 *   "H"                 heartbeat
 *   "L"                 leave
 * The sender is not in the payload: the IOSignal server hands each input to the game host
 * together with the CID of the connection that sent it, so nobody can play for someone else.
 */
export function formatInput(op, ...args) {
  return [op, ...args].join(',');
}

const OP = /^[JDAHL]$/;

/** Returns { op, args } or null. */
export function parseInput(text) {
  if (typeof text !== 'string' || text.length > 120) return null;
  const [op, ...args] = text.split(',');
  if (!OP.test(op)) return null;
  return { op, args };
}

export function sanitizeName(name, fallback = 'player') {
  const clean = String(name ?? '')
    .replace(/[^\p{L}\p{N}_\-]/gu, '')
    .slice(0, 12);
  return clean || fallback;
}

/** Wire snapshot player tuple (dynamic fields only): [cid, x, y, score, flags, dashLeftMs] */
export const S = { CID: 0, X: 1, Y: 2, SCORE: 3, FLAGS: 4, DASH: 5 };
/** Roster tuple (static fields, TAGS.ROSTER): [cid, name, colorIndex, kind] */
export const R = { CID: 0, NAME: 1, COLOR: 2, KIND: 3 };
/** Full player tuple after expandSnapshot(): [cid, name, colorIndex, kind, x, y, score, flags, dashLeftMs] */
export const P = { CID: 0, NAME: 1, COLOR: 2, KIND: 3, X: 4, Y: 5, SCORE: 6, FLAGS: 7, DASH: 8 };

/** Join a wire snapshot with the roster (Map cid -> roster tuple) into full P tuples. */
export function expandSnapshot(s, roster) {
  return {
    ...s,
    p: s.p.map(([cid, x, y, score, flags, dash]) => {
      const r = roster.get(cid);
      return [cid, r ? r[R.NAME] : cid.slice(0, 6), r ? r[R.COLOR] : 0, r ? r[R.KIND] : 'web', x, y, score, flags, dash];
    }),
  };
}
export const FLAG = { INVULN: 1, STUN: 2 };
