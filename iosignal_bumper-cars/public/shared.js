// 범퍼카 (Bumper Cars) — shared by the browser and the Node game server. No dependencies.

/** IOSignal tags. The game host (server.host('bump')) owns every output tag. */
export const TAGS = {
  IN: 'bump#in',          // client -> host (TEXT "OP,args"; the server tells the host who sent it)
  STATE: 'bump#state',    // host -> all   (OBJECT snapshot, 20 Hz)
  ROSTER: 'bump#$roster', // host -> all   (OBJECT names and colours; '$' = retained)
  EVT: 'bump#evt',        // host -> all   (OBJECT { ev: [...] } hits, boosts, horns, rounds)
};

/** The rink, in metres-ish units. (0, 0) is the top-left corner. */
export const ARENA = { W: 24, H: 16 };

export const RULES = {
  TICK_MS: 33,             // physics steps (about 30 a second)
  SNAP_EVERY: 2,           // a snapshot every 2nd step (about 15 a second)
  CAR_R: 0.62,             // car radius (the rubber ring)
  CAR_MASS: 1,
  ACCEL: 9,                // full stick
  MAX_SPEED: 6.5,
  TURN: 5.5,               // radians per second toward the stick
  DRAG: 1.1,               // per second
  GRIP: 5,                 // sideways friction per second (cars do not slide forever)
  BOOST: 6.5,              // instant speed added along the heading
  BOOST_GAP_MS: 2500,
  BOUNCE: 1.25,            // car-car restitution above 1: cushions throw cars apart
  WALL_BOUNCE: 0.75,
  BALL_R: 0.45, BALL_MASS: 0.35, BALL_DRAG: 0.35, BALL_BOUNCE: 0.95,
  CONE_R: 0.25, CONE_MASS: 0.15, CONE_DRAG: 2.5, CONE_HOME: 1.2,  // cones drift back home
  HIT_MIN: 1.4,            // closing speed below this is a nudge, not a hit
  COMBO_MS: 2000,          // hits within this keep the combo going; being hit breaks it
  COMBO_MAX: 9,
  HIT_MAX_PTS: 20,         // one crash never scores more than this
  ROUND_MS: 120000,
  RESULT_MS: 7000,
  MIN_CARS: 5,             // bot cars fill up to this many
  MAX_PLAYERS: 12,
  TIMEOUT_MS: 15000,
  HEARTBEAT_MS: 3000,
};

/** Fixed padded pillars: [x, y, r]. */
export const PILLARS = [[12, 8, 1.1], [6, 4.5, 0.7], [18, 11.5, 0.7]];
/** Cones start (and drift back) here. */
export const CONES = [[4, 12], [5, 12.6], [20, 4], [19, 3.4], [9, 13.5], [15, 2.5], [2.5, 8], [21.5, 8]];
/** Beach balls start here. */
export const BALLS = [[8, 8], [16, 8], [12, 3]];

export const COLORS = ['#ff5a5f', '#ffb400', '#00a699', '#3d7eff', '#a64dff', '#ff7ab6', '#2ec4b6', '#f77f00', '#8ac926', '#6a4c93', '#1982c4', '#e63946'];
export const COLOR_NAMES = ['빨강', '노랑', '초록', '파랑', '보라', '분홍', '민트', '주황', '연두', '자두', '하늘', '체리'];
export const BOT_NAMES = ['범퍼봇', '쿵쿵봇', '빵빵봇', '부릉봇', '띠용봇', '콩콩봇'];

/**
 * Input (TEXT):
 *   "J,<kind>,<name>,<color>"  join   kind: web | bot, color: 0-11
 *   "W,<x>,<y>"                steer: the direction to drive, -100..100 each (0,0 = coast)
 *   "X"                        boost      "K"  horn
 *   "H"                        heartbeat  "L"  leave
 */
export function formatInput(op, ...args) { return [op, ...args].join(','); }
export function parseInput(text) {
  if (typeof text !== 'string' || text.length > 60) return null;
  const [op, ...args] = text.split(',');
  if (!/^[JWXKHL]$/.test(op)) return null;
  return { op, args };
}

/** Snapshot tuples. Positions are hundredths of a unit, angles hundredths of a radian. */
export const C = { ID: 0, X: 1, Y: 2, A: 3, FLAGS: 4, SCORE: 5, COMBO: 6, HITS: 7 };
export const R = { ID: 0, NAME: 1, COLOR: 2, KIND: 3 };
export const FLAG = { BOOST: 1, DRIVING: 2, STUN: 4, HORN: 8 };

export function cleanName(name, fallback) {
  const clean = String(name ?? '').replace(/[^\p{L}\p{N}_\-]/gu, '').slice(0, 10);
  return clean || fallback;
}
