/**
 * In-car radio with generative music stations, scheduled ahead of time on the
 * Web Audio clock. Each station evolves its pattern every few bars.
 */
import { events } from '../core/events.js';

const midi = (n) => 440 * 2 ** ((n - 69) / 12);

export const STATIONS = [
  { id: 'off', name: 'Radio off' },
  { id: 'techno', name: 'Mainhattan 128', genre: 'Techno', bpm: 128 },
  { id: 'lounge', name: 'Apfelwein Lounge', genre: 'Lo-fi', bpm: 78 },
  { id: 'synth', name: 'Nachtschicht FM', genre: 'Synthwave', bpm: 100 },
];

export class Radio {
  constructor(ac, out) {
    this.ac = ac;
    this.out = ac.createGain();
    this.out.gain.value = 0;
    this.out.connect(out);
    this.index = 1;
    this.active = false;
    this.nextTime = 0;
    this.step = 0;
    this.timer = null;
    const buf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noise = buf;
    this.newPatterns();
  }

  get station() {
    return STATIONS[this.index];
  }

  next() {
    this.index = (this.index + 1) % STATIONS.length;
    this.step = 0;
    this.newPatterns();
    events.emit('radio:changed', { station: this.station });
  }

  setActive(on) {
    const want = on && this.station.id !== 'off';
    if (want === this.active) return;
    this.active = want;
    const t = this.ac.currentTime;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setTargetAtTime(want ? 1 : 0, t, 0.15);
    if (want) {
      this.nextTime = t + 0.1;
      if (!this.timer) this.timer = setInterval(() => this.schedule(), 40);
    } else if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  newPatterns() {
    const r = Math.random;
    const scale = [0, 3, 5, 7, 10, 12, 15];
    this.pat = {
      bass: Array.from({ length: 16 }, () => (r() < 0.55 ? scale[Math.floor(r() * 4)] : null)),
      acid: Array.from({ length: 16 }, () => (r() < 0.6 ? scale[Math.floor(r() * scale.length)] : null)),
      root: [45, 41, 43, 48][Math.floor(r() * 4)],
      prog: [
        [0, 3, 7, 10],
        [-4, 0, 3, 7],
        [-2, 2, 5, 9],
        [-7, -3, 0, 5],
      ],
      lead: Array.from({ length: 16 }, () => (r() < 0.4 ? scale[Math.floor(r() * scale.length)] + 12 : null)),
    };
  }

  // ---- instruments
  env(gain, t, a, d, peak) {
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(peak, t + a);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
  }
  kick(t, g = 0.5) {
    const o = this.ac.createOscillator(),
      v = this.ac.createGain();
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    this.env(v, t, 0.003, 0.28, g);
    o.connect(v).connect(this.out);
    o.start(t);
    o.stop(t + 0.35);
  }
  hat(t, g = 0.06, dur = 0.05) {
    const s = this.ac.createBufferSource(),
      f = this.ac.createBiquadFilter(),
      v = this.ac.createGain();
    s.buffer = this.noise;
    f.type = 'highpass';
    f.frequency.value = 7000;
    this.env(v, t, 0.002, dur, g);
    s.connect(f).connect(v).connect(this.out);
    s.start(t, Math.random() * 0.5);
    s.stop(t + dur + 0.05);
  }
  snare(t, g = 0.12) {
    const s = this.ac.createBufferSource(),
      f = this.ac.createBiquadFilter(),
      v = this.ac.createGain();
    s.buffer = this.noise;
    f.type = 'bandpass';
    f.frequency.value = 1800;
    this.env(v, t, 0.002, 0.16, g);
    s.connect(f).connect(v).connect(this.out);
    s.start(t, Math.random() * 0.5);
    s.stop(t + 0.25);
  }
  synth(t, note, dur, { type = 'sawtooth', cutoff = 1200, q = 1, g = 0.08, sweep = 0 } = {}) {
    const o = this.ac.createOscillator(),
      f = this.ac.createBiquadFilter(),
      v = this.ac.createGain();
    o.type = type;
    o.frequency.value = midi(note);
    f.type = 'lowpass';
    f.Q.value = q;
    f.frequency.setValueAtTime(cutoff + sweep, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(80, cutoff), t + dur);
    this.env(v, t, 0.01, dur, g);
    o.connect(f).connect(v).connect(this.out);
    o.start(t);
    o.stop(t + dur + 0.05);
  }
  pad(t, notes, dur, g = 0.025) {
    for (const n of notes) this.synth(t, n, dur, { type: 'triangle', cutoff: 1800, g });
  }

  schedule() {
    const ac = this.ac;
    const st = this.station;
    if (!this.active || !st.bpm) return;
    const sixteenth = 60 / st.bpm / 4;
    while (this.nextTime < ac.currentTime + 0.25) {
      this.play(st.id, this.step, this.nextTime, sixteenth);
      this.nextTime += sixteenth;
      this.step++;
      if (this.step % 128 === 0) this.newPatterns();
    }
  }

  play(id, step, t, s16) {
    const i = step % 16,
      bar = Math.floor(step / 16);
    const P = this.pat;
    if (id === 'techno') {
      if (i % 4 === 0) this.kick(t, 0.55);
      if (i % 4 === 2) this.hat(t, 0.08, 0.06);
      if (i % 2 === 1) this.hat(t, 0.03, 0.03);
      if (i === 4 || i === 12) this.snare(t, bar % 4 === 3 ? 0.1 : 0.05);
      if (P.bass[i] != null && i % 4 !== 0) this.synth(t, P.root - 12 + P.bass[i], s16 * 1.5, { cutoff: 300, g: 0.12 });
      if (bar % 8 >= 2 && P.acid[i] != null) {
        const sweep = 600 + 500 * Math.sin(step / 40);
        this.synth(t, P.root + P.acid[i], s16 * 0.9, { cutoff: 260, q: 12, g: 0.05, sweep });
      }
    } else if (id === 'lounge') {
      const chord = P.prog[bar % 4];
      if (i === 0)
        this.pad(
          t,
          chord.map((c) => P.root + 12 + c),
          s16 * 15,
          0.03,
        );
      if (i === 0 || i === 10) this.kick(t, 0.3);
      if (i === 4 || i === 12) this.snare(t, 0.06);
      if (i % 2 === 0) this.hat(t, 0.02 + (i % 4 === 2 ? 0.015 : 0), 0.04);
      if (i === 0 || i === 7) this.synth(t, P.root - 12 + chord[0], s16 * 5, { type: 'sine', cutoff: 400, g: 0.12 });
      if (P.lead[i] != null && bar % 4 >= 2) this.synth(t, P.root + 12 + P.lead[i], s16 * 2, { type: 'triangle', cutoff: 2400, g: 0.03 });
      if (Math.random() < 0.15) this.hat(t, 0.01, 0.01); // vinyl crackle
    } else if (id === 'synth') {
      const chord = P.prog[bar % 4];
      if (i === 0)
        this.pad(
          t,
          chord.map((c) => P.root + 12 + c),
          s16 * 16,
          0.022,
        );
      if (i % 4 === 0) this.kick(t, 0.45);
      if (i === 4 || i === 12) this.snare(t, 0.12);
      if (i % 2 === 0) this.hat(t, 0.03, 0.04);
      this.synth(t, P.root - 12 + chord[0] + (i % 2 ? 12 : 0), s16 * 0.9, { cutoff: 700, g: 0.06 });
      if (P.lead[i] != null && bar % 8 >= 4) this.synth(t, P.root + 12 + P.lead[i], s16 * 3, { type: 'square', cutoff: 1800, g: 0.025 });
    }
  }
}
