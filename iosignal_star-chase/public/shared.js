// Shared by the server and the browser: tags, numbers, input format.
export const TAGS = {
  IN: 'star#in',         // client -> host: TEXT "OP,args"
  STATE: 'star#state',   // host -> all: snapshot, 10 Hz
  ROSTER: 'star#$roster',// host -> all: names ('$' = the server keeps the last one)
  YOU: 'star.you',       // host -> one: arrives as '@star.you'
};
export const RULES = { W: 20, H: 12, TICK_MS: 100, MAX_PLAYERS: 8, TIMEOUT_MS: 15000 };
// "J,<name>" join · "M,<dx>,<dy>" move one cell (-1..1) · "H" heartbeat
export const parseInput = (text) => {
  const [op, ...args] = String(text).slice(0, 64).split(',');
  return /^[JMH]$/.test(op) ? { op, args } : null;
};
