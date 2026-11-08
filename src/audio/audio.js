/**
 * Game audio. Recorded CC0 samples (public/audio/, loaded in the background) with
 * Web Audio synthesis as fallback until/unless they load:
 *  - player engine: idle + on-load loops per engine type (petrol / sport / diesel)
 *    crossfaded and pitched by a simulated gearbox rpm, tyre squeal, gear-change dips
 *  - positional world sounds relative to the camera (PannerNode, HRTF on high/ultra):
 *    nearby traffic engines, German two-tone sirens ("Martinshorn") with Doppler,
 *    horns, crashes of other cars, doors, trams, church bells
 *  - city ambience (see ambience.js), muffled when sitting in a car
 *  - footsteps on pavement / cobbles (Altstadt) / grass (parks)
 *  - UI cues and mission jingles (synthesised), radio (radio.js)
 * Routed through volume buses controlled by the settings.
 */
import { ctx } from '../core/context.js';
import { settings } from '../core/settings.js';
import { events } from '../core/events.js';
import { clamp, smooth } from '../core/math.js';
import { Radio } from './radio.js';
import { SoundBank } from './sounds.js';
import { Emitter, OneShots, setListener } from './spatial.js';
import { CityAmbience, posOf } from './ambience.js';
import { VoiceDirector } from './voices.js';

/** Engine character per vehicle kind. idle/max rpm, which loops, pitch and tone. */
const ENGINES = {
  petrol: { low: 'engine_idle', high: 'engine_high', idle: 800, max: 6200, pitch: 1, cutoff: 1, gain: 1, gears: [0, 22, 45, 72, 105, 145, 999] },
  police: { low: 'engine_idle', high: 'engine_high', idle: 750, max: 6000, pitch: 0.92, cutoff: 1, gain: 1.1, gears: [0, 25, 50, 80, 115, 160, 999] },
  sport: { low: 'engine_sport', high: 'engine_high', idle: 900, max: 7200, pitch: 1.12, cutoff: 1.4, gain: 1.15, gears: [0, 30, 60, 95, 135, 180, 999] },
  diesel: { low: 'engine_diesel', high: 'engine_high', idle: 750, max: 4400, pitch: 0.82, cutoff: 0.7, gain: 1.05, gears: [0, 18, 38, 62, 92, 130, 999] },
};
const engineFor = (car) => (car.kind === 'van' || car.kind === 'bus' || car.kind === 'truck' ? 'diesel' : car.sport ? 'sport' : car.isPolice ? 'police' : 'petrol');
const VOICES = { low: { npc: 1, siren: 1 }, medium: { npc: 2, siren: 2 }, high: { npc: 3, siren: 3 }, ultra: { npc: 4, siren: 3 } };

export class AudioManager {
  constructor() {
    this.ac = null;
    this.ready = false;
    this._crash = null;
    this.voice = new VoiceDirector();
    // Listeners registered before Game.wireEvents, so they run before game.onCrash → crash().
    events.on('vehicle:crash', ({ car }) => {
      this._crash = car;
    });
    events.on('vehicle:enter', ({ car }) => this.doors(car, 0.85));
    events.on('vehicle:exit', ({ car }) => this.doors(car, 0.6));
  }

  /** Must be called from a user gesture (browser autoplay policy). */
  init() {
    if (this.ac) {
      if (this.ac.state === 'suspended') this.ac.resume();
      return;
    }
    try {
      this.ac = new (window.AudioContext || window.webkitAudioContext)();
    } catch {
      return;
    }
    const ac = this.ac;
    this.master = ac.createGain();
    this.master.connect(ac.destination);
    this.buses = {};
    for (const b of ['sfx', 'radio', 'ambient', 'ui']) {
      this.buses[b] = ac.createGain();
      this.buses[b].connect(this.master);
    }
    // world sounds pass a lowpass so they are muffled inside a car
    this.ambientIn = ac.createBiquadFilter();
    this.ambientIn.type = 'lowpass';
    this.ambientIn.frequency.value = 20000;
    this.ambientIn.connect(this.buses.ambient);
    this.sfxIn = ac.createBiquadFilter();
    this.sfxIn.type = 'lowpass';
    this.sfxIn.frequency.value = 20000;
    this.sfxIn.connect(this.buses.sfx);
    this.bellBus = this.ambientIn;
    this.applyVolumes();
    events.on('settings:changed', ({ key }) => {
      if (key.endsWith('Volume')) this.applyVolumes();
    });

    const q = ctx.quality in VOICES ? ctx.quality : 'medium';
    this.voices = VOICES[q];
    this.hrtf = q === 'high' || q === 'ultra';
    this.shots = new OneShots(ac, this.hrtf, q === 'low' ? 10 : 16);

    // shared noise buffer
    const buf = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noise = buf;

    this.initSynth();

    // recorded engine layers (filled when samples load)
    this.eng = { out: ac.createGain(), lp: ac.createBiquadFilter(), low: null, high: null, profile: null, gear: 1, dip: 0 };
    this.eng.lp.type = 'lowpass';
    this.eng.lp.frequency.value = 3000;
    this.eng.out.gain.value = 0;
    this.eng.lp.connect(this.eng.out).connect(this.buses.sfx);
    this.npc = [];
    this.sirens = [];
    this.npcT = 0;

    this.radio = new Radio(ac, this.buses.radio);
    this.ambience = new CityAmbience(this);
    this.bank = new SoundBank(ac);
    this.ambience.bank = this.bank;
    this.bank.load().then(() => this.onLoaded());
    this.stepT = 0;
    this.ready = true;
  }

  /** Synthesised fallbacks (used until samples are decoded or if they fail). */
  initSynth() {
    const ac = this.ac;
    this.engine = { gain: ac.createGain(), o1: ac.createOscillator(), o2: ac.createOscillator(), lp: ac.createBiquadFilter(), nGain: ac.createGain() };
    const e = this.engine;
    e.o1.type = 'sawtooth';
    e.o2.type = 'square';
    e.lp.type = 'lowpass';
    e.lp.frequency.value = 700;
    e.gain.gain.value = 0;
    const sub = ac.createGain();
    sub.gain.value = 0.5;
    e.o1.connect(e.lp);
    e.o2.connect(sub).connect(e.lp);
    e.lp.connect(e.gain).connect(this.buses.sfx);
    const en = this.loopNoise(400, 'bandpass');
    en.out.connect(e.nGain).connect(e.gain);
    e.nGain.gain.value = 0.25;
    e.o1.start();
    e.o2.start();

    this.skid = this.loopNoise(2600, 'bandpass', 6);
    this.skid.out.connect(this.skid.gain).connect(this.buses.sfx);
    this.rain = this.loopNoise(1200, 'highpass');
    this.rain.out.connect(this.rain.gain).connect(this.ambientIn);
    this.city = this.loopNoise(220, 'lowpass');
    this.city.out.connect(this.city.gain).connect(this.ambientIn);

    // two-tone siren fallback (Martinshorn pitches a'–d'')
    this.siren = { osc: ac.createOscillator(), gain: ac.createGain(), lp: ac.createBiquadFilter() };
    this.siren.osc.type = 'square';
    this.siren.lp.type = 'lowpass';
    this.siren.lp.frequency.value = 1800;
    this.siren.gain.gain.value = 0;
    this.siren.osc.connect(this.siren.lp).connect(this.siren.gain).connect(this.sfxIn);
    this.siren.osc.start();
    this.weather = { rain: 0 };
  }

  onLoaded() {
    if (!this.ready) return;
    this.ambience.start();
    if (this.ambience.running) {
      const t = this.ac.currentTime;
      this.city.gain.gain.setTargetAtTime(0, t, 0.5);
      this.rain.gain.gain.setTargetAtTime(0, t, 0.5);
    }
    if (ctx.player?.vehicle) this.setEngineProfile(ctx.player.vehicle);
  }

  loopNoise(freq, type, q = 1) {
    const ac = this.ac;
    const src = ac.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const f = ac.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const gain = ac.createGain();
    gain.gain.value = 0;
    src.connect(f);
    src.start();
    return { src, out: f, gain, filter: f };
  }

  applyVolumes() {
    if (!this.ac) return;
    const t = this.ac.currentTime;
    this.master.gain.setTargetAtTime(settings.get('masterVolume'), t, 0.05);
    this.buses.sfx.gain.setTargetAtTime(settings.get('sfxVolume'), t, 0.05);
    this.buses.ui.gain.setTargetAtTime(settings.get('sfxVolume'), t, 0.05);
    this.buses.radio.gain.setTargetAtTime(settings.get('radioVolume'), t, 0.05);
    this.buses.ambient.gain.setTargetAtTime(settings.get('ambientVolume'), t, 0.05);
  }

  /** Mutes gameplay audio while paused (UI and radio keep playing). */
  setPaused(p) {
    if (!this.ready) return;
    if (p) this.voice.stop();
    const t = this.ac.currentTime;
    this.buses.sfx.gain.setTargetAtTime(p ? 0 : settings.get('sfxVolume'), t, 0.05);
    this.buses.ambient.gain.setTargetAtTime(p ? 0 : settings.get('ambientVolume'), t, 0.05);
    this.buses.radio.gain.setTargetAtTime((p ? 0.35 : 1) * settings.get('radioVolume'), t, 0.1);
  }

  setWeather(w) {
    if (!this.ready) return;
    this.weather = w;
    if (this.ambience.running) return; // recorded rain is driven in ambience.update
    this.rain.gain.gain.setTargetAtTime(w.rain * 0.06, this.ac.currentTime, 0.5);
  }

  // ---------------------------------------------------------------- player engine
  setEngineProfile(car) {
    const name = engineFor(car);
    const E = this.eng;
    if (E.profile === name && E.low) return;
    const P = ENGINES[name];
    for (const k of ['low', 'high']) {
      if (E[k]) {
        try {
          E[k].src.stop();
        } catch {
          /* ignore */
        }
        E[k].gain.disconnect();
        E[k] = null;
      }
      const src = this.bank.source(P[k]);
      if (!src) continue;
      const g = this.ac.createGain();
      g.gain.value = 0;
      src.connect(g).connect(E.lp);
      src.start(this.ac.currentTime, this.bank.startAt(P[k]));
      E[k] = { src, gain: g };
    }
    E.profile = E.low && E.high ? name : null;
    E.P = P;
  }

  updateEngine(car, dt, t, interior) {
    const E = this.eng;
    if (E.profile !== engineFor(car) || !E.low) this.setEngineProfile(car);
    const useSamples = !!E.profile;
    const kmh = Math.abs(car.kmh || 0);
    const load = clamp(car.engineLoad || 0, 0, 1);
    const P = E.P || ENGINES.petrol;
    // simulated gearbox: rpm rises within each gear band
    const G = P.gears;
    let g = 1;
    while (kmh > G[g] && g < G.length - 1) g++;
    const k = clamp((kmh - G[g - 1]) / (G[g] - G[g - 1]), 0, 1);
    let rpm = P.idle + (P.max * 0.85 - P.idle) * (0.12 + 0.88 * k) * (g === 1 ? k + 0.25 * load : 1);
    if (kmh < 2) rpm = P.idle + load * (P.max * 0.45 - P.idle); // revving on the spot
    rpm = clamp(rpm, P.idle, P.max);
    E.rpm = E.rpm == null ? rpm : E.rpm + (rpm - E.rpm) * clamp(dt * 8, 0, 1);
    if (g > E.gear && kmh > 5) E.dip = 0.18; // short torque dip on upshift
    E.gear = g;
    E.dip = Math.max(0, E.dip - dt);
    const r = E.rpm;

    if (useSamples) {
      const x = smooth(0, 1, (r - P.idle) / (2600 - P.idle));
      const lowRate = clamp((r / P.idle) * 0.95 * P.pitch, 0.6, 2.6);
      const highRate = clamp((r / 3060) * P.pitch, 0.4, 2.3);
      E.low.src.playbackRate.setTargetAtTime(lowRate, t, 0.04);
      E.high.src.playbackRate.setTargetAtTime(highRate, t, 0.04);
      E.low.gain.gain.setTargetAtTime(Math.cos((x * Math.PI) / 2) * 0.9, t, 0.06);
      E.high.gain.gain.setTargetAtTime(Math.sin((x * Math.PI) / 2) * (0.55 + 0.45 * load), t, 0.06);
      const cut = (900 + (r / P.max) * 3800 + load * 1800) * P.cutoff * (interior ? 0.55 : 1);
      E.lp.frequency.setTargetAtTime(cut, t, 0.06);
      const vol = (0.28 + 0.16 * load) * P.gain * (E.dip > 0 ? 0.6 : 1) * (interior ? 0.8 : 1);
      E.out.gain.setTargetAtTime(vol, t, E.dip > 0 ? 0.02 : 0.08);
      this.engine.gain.gain.setTargetAtTime(0, t, 0.1);
    } else {
      const e = this.engine;
      const f = (r / 30) * 1.6 * P.pitch;
      e.o1.frequency.setTargetAtTime(f, t, 0.05);
      e.o2.frequency.setTargetAtTime(f / 2, t, 0.05);
      e.lp.frequency.setTargetAtTime(500 + (r / P.max) * 1400 + load * 600, t, 0.08);
      e.gain.gain.setTargetAtTime(0.045 + load * 0.03, t, 0.1);
    }
    // tyre squeal from sideways slip
    const v = car.body.linvel();
    const side = Math.abs(v.x * Math.cos(car.yaw) - v.z * Math.sin(car.yaw));
    const squeal = clamp((side - 3.5) / 8, 0, 1);
    if (this.bank.has('tyre_squeal')) {
      if (!this.squeal) {
        const src = this.bank.source('tyre_squeal');
        const g = this.ac.createGain();
        g.gain.value = 0;
        src.connect(g).connect(this.buses.sfx);
        src.start(t, this.bank.startAt('tyre_squeal'));
        this.squeal = { src, gain: g };
      }
      this.squeal.gain.gain.setTargetAtTime(squeal * 0.45, t, 0.05);
      this.squeal.src.playbackRate.setTargetAtTime(0.9 + squeal * 0.15, t, 0.1);
    } else this.skid.gain.gain.setTargetAtTime(squeal * 0.05, t, 0.05);
  }

  stopEngine(t) {
    this.engine.gain.gain.setTargetAtTime(0, t, 0.15);
    this.eng.out.gain.setTargetAtTime(0, t, 0.25);
    this.skid.gain.gain.setTargetAtTime(0, t, 0.05);
    if (this.squeal) this.squeal.gain.gain.setTargetAtTime(0, t, 0.05);
    this.eng.rpm = null;
  }

  // ---------------------------------------------------------------- world voices
  /** Nearby traffic engines and sirens, assigned to pooled emitters. */
  updateWorld(dt, lp, player) {
    const t = this.ac.currentTime;
    const list = ctx.vehicles?.list || [];
    this.npcT -= dt;
    if (this.npcT <= 0) {
      this.npcT = 0.25;
      const near = [];
      const sir = [];
      for (const c of list) {
        if (c.dead) continue;
        const p = posOf(c);
        if (!p) continue;
        const d = Math.hypot(p.x - lp.x, p.z - lp.z);
        if (c.siren && d < 650) sir.push({ c, d });
        if (c !== player.vehicle && d < 55 && (Math.abs(c.kmh || 0) > 3 || c.mode === 'ai')) near.push({ c, d });
      }
      near.sort((a, b) => a.d - b.d);
      sir.sort((a, b) => a.d - b.d);
      this.assign(this.npc, near.slice(0, this.voices.npc), (c) => this.npcSource(c));
      this.assign(this.sirens, sir.slice(0, this.voices.siren), (c) => this.bank.source('siren_de', 0.97 + ((list.indexOf(c) * 7) % 7) * 0.01));
    }
    for (const v of this.npc) {
      if (!v.src || !v.owner) continue;
      const p = posOf(v.owner);
      if (!p) {
        v.detach(0.12);
        continue;
      }
      const d = v.place(p.x, p.y, p.z, lp, dt);
      const kmh = Math.abs(v.owner.kmh || 0);
      const diesel = engineFor(v.owner) === 'diesel';
      const base = diesel ? 0.75 + kmh / 110 : 0.5 + kmh / 85;
      v.src.playbackRate.setTargetAtTime(clamp(base, 0.4, 2) * v.doppler, t, 0.08);
      v.setLevel(0.18 + 0.4 * Math.min(kmh, 70) / 70, d, 5);
    }
    let nearestSiren = Infinity;
    for (const v of this.sirens) {
      if (!v.src || !v.owner) continue;
      const p = posOf(v.owner);
      if (!p) {
        v.detach(0.12);
        continue;
      }
      const d = v.place(p.x, p.y + 1.5, p.z, lp, dt);
      nearestSiren = Math.min(nearestSiren, d);
      v.src.playbackRate.setTargetAtTime(v.rate * v.doppler, t, 0.05);
      // sirens are loud and carry far; extra falloff so they fade out by ~600 m
      v.setLevel(0.75 * clamp(1.1 - d / 600, 0, 1), d, 14);
    }
    // synthesised siren fallback (nearest only, not positional)
    if (!this.bank.has('siren_de')) {
      let sd = Infinity;
      for (const c of list) {
        if (!c.siren) continue;
        const p = posOf(c);
        sd = Math.min(sd, Math.hypot(p.x - lp.x, p.z - lp.z));
      }
      const sv = sd < Infinity ? clamp(1 - sd / 300, 0, 1) ** 1.5 : 0;
      const hi = Math.floor((ctx.simTime || 0) / 0.8) % 2;
      this.siren.osc.frequency.setTargetAtTime(hi ? 621 : 464, t, 0.01);
      this.siren.gain.gain.setTargetAtTime(sv * 0.03, t, 0.1);
    } else this.siren.gain.gain.setTargetAtTime(0, t, 0.1);
    this.nearestSiren = nearestSiren;
  }

  npcSource(c) {
    const name = engineFor(c) === 'diesel' ? 'engine_diesel' : Math.abs(c.kmh || 0) > 12 ? 'engine_high' : 'engine_idle';
    return this.bank.source(name);
  }

  /** Keeps emitters on the same owners when possible; reassigns the rest. */
  assign(pool, wanted, make) {
    const owners = new Set(wanted.map((w) => w.c));
    for (const v of pool) if (v.owner && !owners.has(v.owner)) v.detach(0.25);
    const have = new Set(pool.filter((v) => v.owner).map((v) => v.owner));
    for (const { c } of wanted) {
      if (have.has(c)) continue;
      let v = pool.find((e) => !e.owner);
      if (!v) {
        v = new Emitter(this.ac, this.sfxIn, this.hrtf);
        pool.push(v);
      }
      const src = make(c);
      if (!src) continue;
      v.rate = src.playbackRate.value;
      const name = src.buffer === this.bank.buf.siren_de ? 'siren_de' : null;
      v.attach(src, name ? this.bank.startAt(name) : src.loopStart + Math.random() * (src.loopEnd - src.loopStart));
      v.owner = c;
    }
  }

  // ---------------------------------------------------------------- per frame
  update(dt) {
    if (!this.ready) return;
    const t = this.ac.currentTime;
    const player = ctx.player;
    const car = player.vehicle;
    const cam = ctx.camera;
    if (cam) setListener(this.ac, cam);
    const lp = cam ? cam.position : player.position;
    const interior = !!car && ctx.cameraRig?.carMode === 3;
    const inCar = !!car;
    // muffle the outside world inside a car
    this.ambientIn.frequency.setTargetAtTime(interior ? 1300 : inCar ? 4500 : 20000, t, 0.15);
    this.sfxIn.frequency.setTargetAtTime(interior ? 2200 : inCar ? 7000 : 20000, t, 0.15);
    const paused = !!ctx.game?.paused;

    if (car && !car.dead) this.updateEngine(car, dt, t, interior);
    else {
      this.stopEngine(t);
      if (!paused && !player.swim && player.grounded && player.speed > 0.8) this.footsteps(dt, player);
      else if (!paused && player.swim && player.speed > 0.5) {
        this.stepT -= dt * 0.9;
        if (this.stepT <= 0) {
          this.stepT = 1;
          this.burst(0.05, 900 + Math.random() * 500, 0.35, 'bandpass');
        }
      }
    }
    if (!paused) this.updateWorld(dt, lp, player);
    if (!paused) this.voice.update(dt);
    if (this.ambience.running) this.ambience.update(paused ? 0 : dt, lp, { inCar, interior });
    else this.city.gain.gain.setTargetAtTime(0.03 + 0.03 * (ctx.env?.dayFactor ?? 1), t, 1);
    this.radio.setActive(!!car && !paused);
  }

  footsteps(dt, player) {
    const run = player.speed > 4.5;
    this.stepT -= dt * (run ? 2.7 : 1.85);
    if (this.stepT > 0) return;
    this.stepT = 1;
    const p = player.position;
    const surf = this.ambience.surface(p.x, p.z);
    const name = `step_${surf}`;
    if (this.bank.has(name)) {
      const [off, dur] = this.bank.sprite(name);
      const src = this.bank.source(name, 0.92 + Math.random() * 0.16);
      this.shots.play(src, { out: this.buses.sfx, gain: (run ? 0.55 : 0.36) * (surf === 'grass' ? 0.9 : 1), offset: off, dur });
    } else this.click(run ? 0.05 : 0.03, 1800 + Math.random() * 600, 0.04);
  }

  // ---------------------------------------------------------------- one-shots
  /** Plays a sample at a world position (relative to the camera). */
  positional(name, pos, gain = 1, opts = {}) {
    if (!this.ready || !this.bank.has(name)) return false;
    const src = this.bank.source(name, opts.rate ?? 0.96 + Math.random() * 0.08);
    return this.shots.play(src, {
      pos: pos ? { x: pos.x, y: pos.y ?? 1, z: pos.z } : null,
      listener: ctx.camera?.position,
      gain,
      ref: opts.ref ?? 6,
      maxDist: opts.maxDist ?? 400,
      out: opts.out || this.sfxIn,
      offset: this.bank.startAt(name),
      when: opts.when || 0,
    });
  }

  doors(car, gap) {
    if (!this.ready || !car) return;
    const p = posOf(car);
    this.positional('door_open', p, 0.6, { ref: 4 });
    this.positional('door_close', p, 0.8, { ref: 4, when: gap });
  }

  /** One-shot noise burst through a filter. */
  burst(gain, freq, dur, type = 'lowpass', bus = 'sfx') {
    if (!this.ready) return;
    const ac = this.ac;
    const s = ac.createBufferSource();
    s.buffer = this.noise;
    const f = ac.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    const g = ac.createGain();
    g.gain.setValueAtTime(gain, ac.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + dur);
    s.connect(f).connect(g).connect(this.buses[bus]);
    s.start(ac.currentTime, Math.random());
    s.stop(ac.currentTime + dur + 0.05);
  }
  click(gain, freq, dur) {
    this.burst(gain, freq, dur, 'bandpass');
  }
  tone(freq, dur, type = 'sine', gain = 0.06, bus = 'ui', when = 0) {
    if (!this.ready) return;
    const ac = this.ac;
    const t0 = ac.currentTime + when;
    const o = ac.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(this.buses[bus]);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }

  /** Crash at the car reported by the last 'vehicle:crash' event (positional). */
  crash(impact, pos = null) {
    if (!this.ready) return;
    const car = this._crash;
    this._crash = null;
    const p = pos || posOf(car) || ctx.camera?.position;
    const k = clamp(impact / 20, 0.2, 1);
    if (this.bank.has('crash_heavy')) {
      const out = car && car === ctx.player.vehicle ? this.buses.sfx : this.sfxIn;
      const o = { ref: 8, out };
      if (impact < 6) this.positional(Math.random() < 0.5 ? 'crash_light' : 'crash_clank', p, 0.5 + k * 0.4, o);
      else {
        this.positional('crash_heavy', p, 0.55 + k * 0.45, { ...o, rate: 0.9 + Math.random() * 0.2 });
        if (impact > 14) this.positional('crash_glass', p, 0.5 * k, o);
        else this.positional('crash_clank', p, 0.4, o);
      }
      return;
    }
    this.burst(0.5 * k, 900, 0.35 + k * 0.4);
    this.burst(0.4 * k, 140, 0.6);
  }
  horn(pos, gain = 1) {
    if (!this.ready) return;
    const own = !pos;
    const p = pos || posOf(ctx.player.vehicle) || ctx.player.position;
    if (this.bank.has('horn')) {
      this.positional('horn', p, (own ? 0.6 : 0.75) * gain, { ref: 6, maxDist: 160, out: own ? this.buses.sfx : this.sfxIn, rate: own ? 1 : 0.92 + Math.random() * 0.16 });
      return;
    }
    const pp = ctx.player.position;
    const d = pos ? Math.hypot(pos.x - pp.x, pos.z - pp.z) : 0;
    const v = clamp(1 - d / 80, 0, 1) * gain;
    if (v <= 0) return;
    this.tone(415, 0.45, 'square', 0.04 * v, 'sfx');
    this.tone(520, 0.45, 'square', 0.04 * v, 'sfx');
  }
  thunder() {
    if (!this.ready) return;
    if (this.bank.has('thunder')) {
      const src = this.bank.source('thunder', 0.8 + Math.random() * 0.3);
      this.shots.play(src, { out: this.ambientIn, gain: 0.5 + Math.random() * 0.4, offset: this.bank.startAt('thunder') });
      return;
    }
    this.burst(0.5, 180, 3.5);
  }
  // UI cues
  uiMove() {
    this.tone(880, 0.05, 'triangle', 0.02);
  }
  uiSelect() {
    this.tone(1320, 0.08, 'triangle', 0.035);
  }
  uiBack() {
    this.tone(520, 0.08, 'triangle', 0.03);
  }
  pickup() {
    [988, 1319].forEach((f, i) => this.tone(f, 0.12, 'triangle', 0.05, 'ui', i * 0.07));
  }
  cash() {
    [1568, 2093, 2637].forEach((f, i) => this.tone(f, 0.1, 'square', 0.025, 'ui', i * 0.05));
  }
  missionPassed() {
    [523, 659, 784, 1047, 784, 1047].forEach((f, i) => this.tone(f, 0.35, 'triangle', 0.06, 'ui', i * 0.11));
  }
  missionFailed() {
    [392, 330, 262].forEach((f, i) => this.tone(f, 0.45, 'sawtooth', 0.035, 'ui', i * 0.18));
  }
  wantedUp() {
    [660, 880].forEach((f, i) => this.tone(f, 0.12, 'square', 0.03, 'ui', i * 0.08));
  }
  checkpoint() {
    this.tone(1175, 0.15, 'triangle', 0.05);
  }
  death() {
    this.burst(0.3, 80, 2.5);
    [220, 196, 147].forEach((f, i) => this.tone(f, 0.8, 'sine', 0.06, 'ui', i * 0.35));
  }

  /** Debug/test summary of what is playing. */
  debugInfo() {
    if (!this.ready) return { ready: false };
    return {
      ready: true,
      state: this.ac.state,
      samples: this.bank.loaded,
      engine: this.eng.profile,
      rpm: Math.round(this.eng.rpm || 0),
      npcVoices: this.npc.filter((v) => v.owner).length,
      sirenVoices: this.sirens.filter((v) => v.owner).length,
      nearestSiren: this.nearestSiren,
      oneShots: this.shots.active,
      beds: Object.fromEntries(Object.entries(this.ambience.beds).map(([k, b]) => [k, +b.gain.gain.value.toFixed(3)])),
      levels: this.ambience.levels,
      churches: this.ambience.churches?.length ?? 0,
      tram: !!this.ambience.tramVoice?.src,
    };
  }
}
