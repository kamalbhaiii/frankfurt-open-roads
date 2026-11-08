/**
 * Positional audio helpers: listener follows the camera, emitters are pooled
 * PannerNode chains (source -> air-absorption lowpass -> gain -> panner -> bus).
 * Distance attenuation is computed here (not by the panner) so every sound can
 * use its own curve; the panner only places the sound (HRTF on high quality).
 * Doppler shift comes from the rate of change of the source distance.
 */
import { clamp } from '../core/math.js';

const SPEED_OF_SOUND = 343;

export function setListener(ac, cam) {
  const L = ac.listener;
  const p = cam.position;
  const e = cam.matrixWorld.elements;
  // camera looks down -Z; up is +Y (world space columns of the matrix)
  const fx = -e[8],
    fy = -e[9],
    fz = -e[10],
    ux = e[4],
    uy = e[5],
    uz = e[6];
  if (L.positionX) {
    const t = ac.currentTime;
    L.positionX.setTargetAtTime(p.x, t, 0.02);
    L.positionY.setTargetAtTime(p.y, t, 0.02);
    L.positionZ.setTargetAtTime(p.z, t, 0.02);
    L.forwardX.setTargetAtTime(fx, t, 0.02);
    L.forwardY.setTargetAtTime(fy, t, 0.02);
    L.forwardZ.setTargetAtTime(fz, t, 0.02);
    L.upX.setTargetAtTime(ux, t, 0.02);
    L.upY.setTargetAtTime(uy, t, 0.02);
    L.upZ.setTargetAtTime(uz, t, 0.02);
  } else {
    L.setPosition(p.x, p.y, p.z);
    L.setOrientation(fx, fy, fz, ux, uy, uz);
  }
}

/** A reusable positional chain. Sources are attached/replaced; the nodes persist. */
export class Emitter {
  constructor(ac, out, hrtf) {
    this.ac = ac;
    this.lp = ac.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.frequency.value = 18000;
    this.gain = ac.createGain();
    this.gain.gain.value = 0;
    this.panner = ac.createPanner();
    this.panner.panningModel = hrtf ? 'HRTF' : 'equalpower';
    this.panner.distanceModel = 'linear';
    this.panner.rolloffFactor = 0; // attenuation handled in setLevel
    this.lp.connect(this.gain).connect(this.panner).connect(out);
    this.src = null;
    this.owner = null;
    this.lastDist = null;
    this.doppler = 1;
  }

  /** Replaces the current source (fading the old one out). */
  attach(src, offset = 0) {
    this.detach();
    this.src = src;
    src.connect(this.lp);
    src.start(this.ac.currentTime, offset);
    this.lastDist = null;
    this.doppler = 1;
  }

  detach(fade = 0.08) {
    if (!this.src) {
      this.owner = null;
      return;
    }
    const s = this.src,
      t = this.ac.currentTime;
    this.gain.gain.cancelScheduledValues(t);
    this.gain.gain.setTargetAtTime(0, t, fade / 3);
    try {
      s.stop(t + fade);
    } catch {
      /* already stopped */
    }
    this.src = null;
    this.owner = null;
  }

  /**
   * Moves the emitter. Returns the distance to the listener position `lp`.
   * dt > 0 updates the Doppler factor (smoothed).
   */
  place(x, y, z, lp, dt) {
    const t = this.ac.currentTime;
    const P = this.panner;
    if (P.positionX) {
      P.positionX.setTargetAtTime(x, t, 0.03);
      P.positionY.setTargetAtTime(y, t, 0.03);
      P.positionZ.setTargetAtTime(z, t, 0.03);
    } else P.setPosition(x, y, z);
    const d = Math.hypot(x - lp.x, y - lp.y, z - lp.z);
    if (dt > 0 && this.lastDist != null) {
      const vr = clamp((d - this.lastDist) / dt, -60, 60); // + receding
      const target = SPEED_OF_SOUND / (SPEED_OF_SOUND + vr);
      this.doppler += (target - this.doppler) * clamp(dt * 6, 0, 1);
    }
    this.lastDist = d;
    return d;
  }

  /** Volume and air absorption for a distance (closer than `ref` = full). */
  setLevel(level, d, ref = 6, smooth = 0.06) {
    const t = this.ac.currentTime;
    const att = ref / Math.max(ref, d);
    this.gain.gain.setTargetAtTime(level * att, t, smooth);
    this.lp.frequency.setTargetAtTime(clamp(20000 - d * 28, 1800, 20000), t, 0.1);
  }
}

/** Fire-and-forget positional one-shots with a voice cap. */
export class OneShots {
  constructor(ac, hrtf, max = 14) {
    this.ac = ac;
    this.hrtf = hrtf;
    this.max = max;
    this.active = 0;
  }

  /**
   * Plays `src` (an unstarted AudioBufferSourceNode or OscillatorNode-chain output)
   * at `pos` (or non-positional when pos is null). Returns false when over budget.
   */
  play(src, { pos = null, listener = null, gain = 1, ref = 6, maxDist = 400, atten = true, out, offset = 0, dur = undefined, when = 0 }) {
    if (this.active >= this.max) return false;
    const ac = this.ac;
    let level = gain;
    const g = ac.createGain();
    let tail = g;
    if (pos) {
      const d = listener ? Math.hypot(pos.x - listener.x, (pos.y ?? 1) - listener.y, pos.z - listener.z) : 0;
      if (atten) {
        if (d > maxDist) return false;
        level *= (ref / Math.max(ref, d)) * clamp(1.2 - d / maxDist, 0, 1);
        if (level < 0.002) return false;
      }
      const lp = ac.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = clamp(20000 - d * 30, 1200, 20000);
      const p = ac.createPanner();
      p.panningModel = this.hrtf ? 'HRTF' : 'equalpower';
      p.rolloffFactor = 0;
      if (p.positionX) {
        p.positionX.value = pos.x;
        p.positionY.value = pos.y ?? 1;
        p.positionZ.value = pos.z;
      } else p.setPosition(pos.x, pos.y ?? 1, pos.z);
      src.connect(lp).connect(g).connect(p).connect(out);
      tail = p;
    } else src.connect(g).connect(out);
    g.gain.value = level;
    this.active++;
    src.onended = () => {
      this.active--;
      try {
        tail.disconnect();
      } catch {
        /* ignore */
      }
    };
    const t0 = ac.currentTime + when;
    if (dur != null) src.start(t0, offset, dur);
    else src.start(t0, offset);
    return true;
  }
}
