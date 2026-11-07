/**
 * Recorded sound bank (CC0 recordings in public/audio/, see CREDITS.md there).
 * Files are loaded in the background after the AudioContext exists; anything
 * missing simply stays null and the AudioManager falls back to synthesis.
 *
 * Loops are stored with 0.1 s of pre/post-roll (the end of the loop before it,
 * the start after it), so the loop window stays seamless even when a decoder
 * keeps the MP3 encoder delay (Chrome does, ~1105 samples).
 */
import { assets } from '../core/assets.js';

const LAME_DELAY = 1105;

/** name -> { loop: [start, length] (s, in the file), sr (file rate), sprite: [[start, dur], ...] } */
export const SOUNDS = {
  engine_idle: { loop: [0.1, 4], sr: 24000 },
  engine_sport: { loop: [0.1, 4], sr: 24000 },
  engine_diesel: { loop: [0.1, 4], sr: 24000 },
  engine_high: { loop: [0.1, 4], sr: 24000 },
  tyre_squeal: { loop: [0.1, 2], sr: 32000 },
  siren_de: { loop: [0.1, 6.4], sr: 32000 },
  crash_heavy: { sr: 32000 },
  crash_glass: { sr: 32000 },
  crash_light: { sr: 32000 },
  crash_clank: { sr: 32000 },
  door_open: { sr: 32000 },
  door_close: { sr: 32000 },
  horn: { sr: 32000 },
  thunder: { sr: 24000 },
  church_bell: { sr: 32000 },
  tram_bell: { sr: 32000 },
  tram_pass: { sr: 24000 },
  step_pavement: { sr: 32000, sprite: [0, 0.35, 0.7, 1.05, 1.4, 1.75, 2.1, 2.45].map((s) => [s, 0.28]) },
  step_cobble: { sr: 32000, sprite: [0, 0.35, 0.7, 1.05, 1.4, 1.75].map((s) => [s, 0.28]) },
  step_grass: { sr: 32000, sprite: [0, 0.35, 0.7, 1.05, 1.4, 1.75].map((s) => [s, 0.28]) },
  amb_traffic: { loop: [0.1, 20], sr: 32000 },
  amb_crowd: { loop: [0.1, 18], sr: 32000 },
  amb_birds: { loop: [0.1, 12], sr: 32000 },
  amb_wind: { loop: [0.1, 18], sr: 24000 },
  amb_water: { loop: [0.1, 16], sr: 24000 },
  rain_out: { loop: [0.1, 14], sr: 32000 },
  rain_car: { loop: [0.1, 12], sr: 32000 },
};

/** Decoded buffers + timing corrections. */
export class SoundBank {
  constructor(ac) {
    this.ac = ac;
    this.buf = {};
    /** seconds of encoder delay left in the decoded data, per sound */
    this.off = {};
    this.loaded = 0;
  }

  /** Starts loading everything; never throws, never blocks. */
  load(base = 'audio/') {
    const jobs = Object.keys(SOUNDS).map((name) =>
      Promise.resolve(assets.bytes(`${base}${name}.mp3`))
        .then((bytes) => (bytes ? this.ac.decodeAudioData(bytes.slice(0)) : null))
        .then((b) => {
          if (!b) return;
          this.buf[name] = b;
          this.off[name] = this.delayOf(name, b);
          this.loaded++;
        })
        .catch(() => {}),
    );
    this.done = Promise.all(jobs);
    return this.done;
  }

  /** Decoders that ignore the (absent) gapless header leave LAME's delay at the start. */
  delayOf(name, b) {
    const s = SOUNDS[name];
    const d = LAME_DELAY / s.sr;
    if (!s.loop) return b.duration > 0.06 ? d * 0.9 : 0;
    const expected = s.loop[0] * 2 + s.loop[1];
    return b.duration - expected > d * 0.8 ? d : 0;
  }

  has(name) {
    return !!this.buf[name];
  }

  /** Creates a (not yet started) source; loops get their loop window set. */
  source(name, rate = 1) {
    const b = this.buf[name];
    if (!b) return null;
    const src = this.ac.createBufferSource();
    src.buffer = b;
    src.playbackRate.value = rate;
    const s = SOUNDS[name];
    if (s.loop) {
      src.loop = true;
      src.loopStart = s.loop[0] + this.off[name];
      src.loopEnd = src.loopStart + s.loop[1];
    }
    return src;
  }

  /** Start offset (s) for a loop (random phase) or one-shot (skip encoder delay). */
  startAt(name, randomPhase = true) {
    const s = SOUNDS[name];
    if (s.loop) return s.loop[0] + this.off[name] + (randomPhase ? Math.random() * s.loop[1] : 0);
    return this.off[name] || 0;
  }

  /** [offset, duration] of a random sprite slice. */
  sprite(name) {
    const s = SOUNDS[name];
    const [o, d] = s.sprite[Math.floor(Math.random() * s.sprite.length)];
    return [o + (this.off[name] || 0), d];
  }
}
