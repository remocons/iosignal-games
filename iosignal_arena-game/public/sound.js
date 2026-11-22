// Tiny WebAudio synthesizer: every effect is generated, no audio files needed.
// Browsers only allow audio after a user gesture, so call unlock() from a click/key handler.

export class Sfx {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muted = false;
  }

  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.35;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.35;
    return this.muted;
  }

  get ready() { return this.ctx && !this.muted; }

  tone(freq, start, dur, { type = 'square', vol = 0.3, to = null } = {}) {
    const { ctx } = this;
    const t = ctx.currentTime + start;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (to) osc.frequency.exponentialRampToValueAtTime(to, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  noise(start, dur, { vol = 0.25, from = 3000, to = 300 } = {}) {
    const { ctx } = this;
    const t = ctx.currentTime + start;
    const len = Math.ceil(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(from, t);
    filter.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filter).connect(g).connect(this.master);
    src.start(t);
  }

  // `mine` = the effect concerns the local player -> louder / richer.
  play(name, mine = false) {
    if (!this.ready) return;
    const v = mine ? 1 : 0.45;
    switch (name) {
      case 'coin':
        this.tone(988, 0, 0.08, { vol: 0.25 * v });
        this.tone(1319, 0.07, 0.18, { vol: 0.25 * v });
        break;
      case 'tag': // siren
        this.tone(880, 0, 0.18, { type: 'sawtooth', vol: 0.22 * v, to: 440 });
        this.tone(440, 0.18, 0.22, { type: 'sawtooth', vol: 0.22 * v, to: 990 });
        break;
      case 'free':
        this.tone(523, 0, 0.1, { type: 'triangle', vol: 0.3 });
        this.tone(784, 0.09, 0.2, { type: 'triangle', vol: 0.3 });
        break;
      case 'dash':
        this.noise(0, 0.25, { vol: 0.3 * v, from: 600, to: 4000 });
        break;
      case 'bump':
        this.tone(140, 0, 0.12, { type: 'sine', vol: 0.5 * v, to: 60 });
        break;
      case 'wall':
        this.tone(90, 0, 0.06, { type: 'square', vol: 0.12 });
        break;
      case 'join':
        [523, 659, 784].forEach((f, i) => this.tone(f, i * 0.07, 0.2, { type: 'triangle', vol: 0.18 }));
        break;
      case 'leave':
        [659, 523, 392].forEach((f, i) => this.tone(f, i * 0.07, 0.18, { type: 'triangle', vol: 0.12 }));
        break;
      case 'start':
        [392, 523, 659, 784].forEach((f, i) => this.tone(f, i * 0.09, 0.18, { vol: 0.16 }));
        break;
      case 'end':
        [784, 659, 784, 1047].forEach((f, i) => this.tone(f, i * 0.13, i === 3 ? 0.5 : 0.12, { vol: 0.2 }));
        break;
      case 'tick':
        this.tone(1500, 0, 0.04, { type: 'square', vol: 0.12 });
        break;
      case 'heart': // danger: tagger is near
        this.tone(70, 0, 0.09, { type: 'sine', vol: 0.6 });
        this.tone(60, 0.14, 0.1, { type: 'sine', vol: 0.45 });
        break;
      case 'nodash':
        this.tone(200, 0, 0.07, { type: 'square', vol: 0.1 });
        break;
      default:
    }
  }
}
