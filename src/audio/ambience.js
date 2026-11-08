/**
 * City soundscape: traffic bed following nearby traffic density, crowd murmur near
 * pedestrians, birds in parks by day, wind, Main riverside water, rain (outside vs
 * on the car roof), church bells striking the hour from the Kaiserdom/Paulskirche,
 * and trams (bells + pass-by, following real trams if the transit system exposes
 * them, otherwise occasional unseen trams along the tram rails).
 * Everything here goes to the ambient bus except tram/bell one-shots (positional).
 */
import { ctx } from '../core/context.js';
import { clamp, pip } from '../core/math.js';
import { Emitter } from './spatial.js';

const BED_NAMES = ['amb_traffic', 'amb_crowd', 'amb_birds', 'amb_wind', 'amb_water', 'rain_out', 'rain_car'];

/** Gets {x, y, z} from the various actor shapes used in the game. */
export function posOf(o) {
  if (!o) return null;
  if (o.destroyed) return null;
  if (o.body?.translation) {
    try {
      if (o.body.isValid && !o.body.isValid()) return null;
      return o.body.translation();
    } catch {
      // Traffic may be removed between audio emitter updates; its Rapier handle is freed.
      return null;
    }
  }
  if (o.position && o.position.x != null) return o.position;
  if (o.root?.position) return o.root.position;
  if (o.x != null && o.z != null) return { x: o.x, y: o.y ?? 1, z: o.z };
  return null;
}

export class CityAmbience {
  constructor(audio) {
    this.audio = audio;
    this.ac = audio.ac;
    this.bank = audio.bank;
    this.beds = {};
    this.geoReady = false;
    this.slowT = 0;
    this.levels = { birds: 0, water: 0, cobble: 0, park: 0 };
    this.lastHour = null;
    this.tramT = 40 + Math.random() * 60;
    this.tramVoice = null;
    this.bellCooldown = new WeakMap();
  }

  /** Called once buffers are loaded. Creates looping beds (all start silent). */
  start() {
    const ac = this.ac;
    for (const name of BED_NAMES) {
      const src = this.bank.source(name);
      if (!src || this.beds[name]) continue;
      const g = ac.createGain();
      g.gain.value = 0;
      src.connect(g).connect(this.audio.ambientIn);
      src.start(ac.currentTime, this.bank.startAt(name));
      this.beds[name] = { src, gain: g };
    }
  }

  get running() {
    return Object.keys(this.beds).length > 0;
  }

  // ---- geography (computed lazily once the city exists)
  buildGeo() {
    const city = ctx.city;
    if (!city) return;
    this.geoReady = true;
    const ringBounds = (r) => {
      let x0 = Infinity,
        z0 = Infinity,
        x1 = -Infinity,
        z1 = -Infinity;
      for (const [x, z] of r) {
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        z0 = Math.min(z0, z);
        z1 = Math.max(z1, z);
      }
      return { r, x0, z0, x1, z1 };
    };
    this.parks = (city.parks || []).filter((r) => r.length > 2).map(ringBounds);
    // river edge samples every ~12 m
    this.waterPts = [];
    for (const ring of ctx.riverRings?.length ? ctx.riverRings : city.water || []) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i],
          b = ring[(i + 1) % ring.length];
        const ax = a[0] ?? a.x,
          az = a[1] ?? a.y ?? a.z,
          bx = b[0] ?? b.x,
          bz = b[1] ?? b.y ?? b.z;
        const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 12));
        for (let k = 0; k < n; k++) this.waterPts.push(ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n);
      }
    }
    this.tramRails = (city.rails || []).filter((r) => r.tram && r.pts.length > 1).map((r) => r.pts);
    const find = (re) => (city.names || []).find((n) => re.test(n.name));
    // The OSM extract may not label the churches; derive them from the Alte Nikolaikirche
    // on the Römerberg (Dom ≈ 180 m E / 55 m N of it, Paulskirche ≈ 135 m W / 145 m N;
    // world x = east, z = south), else use their known positions in this extract.
    const niko = find(/Nikolaikirche/i);
    const base = niko || { x: 605, z: 129 };
    const dom = find(/Kaiserdom|Bartholom|^Dom\b/i) || { x: base.x + 180, z: base.z - 55 };
    const paul = find(/Paulskirche/i) || { x: base.x - 135, z: base.z - 145 };
    const roemer = find(/Römerberg|Römer\b|Roemer/i) || base;
    this.churches = [
      { x: dom.x, z: dom.z, y: 60, rate: 0.72, gain: 1 }, // big Gloriosa-like bell
      { x: paul.x, z: paul.z, y: 35, rate: 1.0, gain: 0.7 },
    ];
    this.oldTown = { x: roemer.x, z: roemer.z };
  }

  inPark(x, z) {
    for (const p of this.parks) if (x >= p.x0 && x <= p.x1 && z >= p.z0 && z <= p.z1 && pip(x, z, p.r)) return true;
    return false;
  }

  waterDist(x, z) {
    let best = Infinity;
    const w = this.waterPts;
    for (let i = 0; i < w.length; i += 2) {
      const dx = w[i] - x,
        dz = w[i + 1] - z;
      const d = dx * dx + dz * dz;
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  }

  /** Surface under the player for footsteps. */
  surface(x, z) {
    if (!this.geoReady) return 'pavement';
    if (this.levels.park > 0.9 || this.inPark(x, z)) return 'grass';
    const o = this.oldTown;
    if (o && Math.hypot(x - o.x, z - o.z) < 170) return 'cobble';
    return 'pavement';
  }

  /** Slow (1 Hz) environment probes. */
  probe(lp) {
    const { x, z } = lp;
    let park = this.inPark(x, z) ? 1 : 0;
    if (!park) {
      for (const [ox, oz] of [
        [45, 0],
        [-45, 0],
        [0, 45],
        [0, -45],
      ])
        if (this.inPark(x + ox, z + oz)) park += 0.2;
    }
    this.levels.park = Math.min(1, park);
    const wd = this.waterPts.length ? this.waterDist(x, z) : Infinity;
    this.levels.water = clamp(1 - (wd - 8) / 70, 0, 1);
  }

  update(dt, lp, { inCar, interior }) {
    if (!this.running) return;
    if (!this.geoReady) this.buildGeo();
    if (!this.geoReady) return;
    const t = this.ac.currentTime;
    this.slowT -= dt;
    if (this.slowT <= 0) {
      this.slowT = 1;
      this.probe(lp);
      this.checkBells();
    }
    const env = ctx.env || {};
    const w = env.weather || { rain: 0, wind: 3 };
    const day = env.dayFactor ?? 1;
    const hour = env.date ? env.date.getHours() + env.date.getMinutes() / 60 : 12;
    // night quietness: deep night 1-5 h is the quietest
    const nightQuiet = hour >= 1 && hour < 5 ? 0.35 : hour >= 23 || hour < 1 || (hour >= 5 && hour < 6.5) ? 0.6 : 1;

    // traffic density around the listener
    let dens = 0;
    for (const c of ctx.vehicles?.list || []) {
      const p = posOf(c);
      if (!p) continue;
      const d = Math.hypot(p.x - lp.x, p.z - lp.z);
      if (d < 140) dens += (1 - d / 140) * (0.35 + Math.min(Math.abs(c.kmh || 0), 60) / 60);
    }
    let crowd = 0;
    for (const p of ctx.peds?.list || []) {
      const d = Math.hypot(p.x - lp.x, p.z - lp.z);
      if (d < 45) crowd += 1 - d / 45;
    }
    const rain = w.rain || 0;
    const set = (name, v, tc = 1.2) => this.beds[name]?.gain.gain.setTargetAtTime(v, t, tc);
    set('amb_traffic', (0.05 + 0.1 * clamp(dens / 6, 0, 1.4)) * (0.45 + 0.55 * day) * nightQuiet);
    set('amb_crowd', clamp(crowd / 8, 0, 1) * 0.16 * (0.3 + 0.7 * day) * (1 - 0.6 * rain) * nightQuiet);
    const month = env.date ? env.date.getMonth() : 5;
    const season = month >= 3 && month <= 8 ? 1 : month === 2 || month === 9 ? 0.6 : 0.3;
    set('amb_birds', this.levels.park * clamp(day * 1.4 - 0.2, 0, 1) * (1 - rain) * season * 0.22, 2);
    const wind = clamp(((w.wind ?? 3) - 1.5) / 12, 0, 1);
    const height = clamp((lp.y - 15) / 120, 0, 1); // rooftops and bridges are windier
    set('amb_wind', clamp(0.02 + wind * 0.22 + height * 0.15, 0, 0.35) * (inCar ? 0.5 : 1), 1.5);
    set('amb_water', this.levels.water * 0.2 * (1 - 0.5 * rain), 1.5);
    set('rain_out', rain * (inCar ? 0.06 : 0.22), 0.8);
    set('rain_car', inCar ? rain * (interior ? 0.32 : 0.2) : 0, 0.5);

    this.updateTrams(dt, lp);
  }

  // ---- church bells striking the hour (game clock = real time in "real" mode)
  checkBells() {
    const d = ctx.env?.date;
    if (!d || ctx.game?.paused) return;
    const h = d.getHours();
    if (this.lastHour == null) {
      this.lastHour = h;
      return;
    }
    if (h === this.lastHour) return;
    this.lastHour = h;
    if (d.getMinutes() > 2) return; // time skip (sleep, arrest): don't ring late
    this.strikeHour(h);
  }

  /** Rings `h` strikes (12-hour count) from each church; Paulskirche answers slightly later. */
  strikeHour(h) {
    if (!this.bank.has('church_bell')) return;
    const n = h % 12 || 12;
    const lp = ctx.camera.position;
    const churches = this.churches.length ? this.churches : [{ x: lp.x - 600, z: lp.z, y: 60, rate: 0.75, gain: 0.6 }];
    churches.forEach((c, ci) => {
      const d = Math.hypot(c.x - lp.x, c.z - lp.z);
      // big bells carry far: gentle falloff over ~2.5 km
      const g = c.gain * 0.55 * clamp(1 - d / 2500, 0.05, 1) ** 1.3;
      for (let i = 0; i < n; i++) {
        const src = this.bank.source('church_bell', c.rate * (1 + (Math.random() - 0.5) * 0.004));
        this.audio.shots.play(src, {
          pos: { x: c.x, y: c.y, z: c.z },
          listener: lp,
          atten: false,
          gain: g,
          out: this.audio.bellBus,
          offset: this.bank.startAt('church_bell'),
          when: 0.5 + ci * 1.3 + i * (2.6 / c.rate) * 0.85,
        });
      }
    });
  }

  // ---- trams
  trams() {
    const T = ctx.transit;
    const list = T?.trams || T?.list || T?.vehicles || [];
    const out = Array.isArray(list) ? list.slice() : [];
    for (const c of ctx.vehicles?.list || []) if (c.kind === 'tram') out.push(c);
    return out;
  }

  updateTrams(dt, lp) {
    if (!this.bank.has('tram_pass')) return;
    const real = this.trams();
    if (real.length) {
      // follow the nearest real tram
      let best = null,
        bd = 140;
      for (const tr of real) {
        const p = posOf(tr);
        if (!p) continue;
        const d = Math.hypot(p.x - lp.x, p.z - lp.z);
        if (d < bd) {
          bd = d;
          best = tr;
        }
        // bell when a moving tram is close to the listener
        const speed = Math.abs(tr.speed ?? tr.kmh ?? 0);
        if (d < 30 && speed > 0.5 && !(this.bellCooldown.get(tr) > ctx.simTime)) {
          this.bellCooldown.set(tr, ctx.simTime + 25 + Math.random() * 30);
          this.audio.positional('tram_bell', p, 0.9, { ref: 10 });
        }
      }
      const v = this.tramVoice;
      if (best && (!v || v.owner !== best)) this.attachTram(best, null);
      if (this.tramVoice?.src) {
        const p = posOf(this.tramVoice.owner);
        if (!p || bd >= 140) this.tramVoice.detach(1);
        else this.placeTram(p, lp, dt);
      }
      return;
    }
    // no tram entities: occasional unseen tram along a nearby tram line
    if (this.tramVoice?.virtual) {
      const tv = this.tramVoice;
      tv.s += tv.speed * dt;
      const p = this.along(tv.line, tv.s);
      if (!p || ctx.simTime > tv.until) {
        tv.detach(1);
        this.tramVoice = null;
      } else this.placeTram(p, lp, dt);
      return;
    }
    this.tramT -= dt;
    if (this.tramT > 0 || !this.tramRails?.length) return;
    this.tramT = 50 + Math.random() * 90;
    // closest rail point
    let best = null,
      bd = 160;
    for (const line of this.tramRails) {
      let s = 0;
      for (let i = 0; i < line.length; i++) {
        if (i) s += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
        const d = Math.hypot(line[i][0] - lp.x, line[i][1] - lp.z);
        if (d < bd) {
          bd = d;
          best = { line, s };
        }
      }
    }
    // keep unseen trams at a distance (behind buildings), never right next to the player
    if (!best || bd < 35) return;
    const dir = Math.random() < 0.5 ? 1 : -1;
    const speed = 8 * dir;
    this.attachTram(null, { line: best.line, s: best.s - speed * 11, speed });
    if (Math.random() < 0.5) {
      const p = this.along(best.line, best.s - speed * 3);
      if (p) setTimeout(() => this.audio.positional('tram_bell', p, 0.6, { ref: 10 }), 7000);
    }
  }

  attachTram(owner, virt) {
    const ac = this.ac;
    if (!this.tramVoice) this.tramVoice = new Emitter(ac, this.audio.sfxIn, this.audio.hrtf);
    const v = this.tramVoice;
    const src = this.bank.source('tram_pass', 0.95 + Math.random() * 0.1);
    v.attach(src, this.bank.startAt('tram_pass') + (owner ? 6 : 0));
    v.owner = owner;
    v.virtual = !!virt;
    if (virt) Object.assign(v, virt, { until: ctx.simTime + 21 });
    src.onended = () => {
      if (this.tramVoice === v && v.src === src) {
        v.src = null;
        v.owner = owner ? { done: true } : null;
      }
    };
  }

  placeTram(p, lp, dt) {
    const v = this.tramVoice;
    const d = v.place(p.x, 2, p.z, lp, dt);
    v.setLevel(0.9, d, 12);
    if (v.src) v.src.playbackRate.setTargetAtTime(v.doppler, this.ac.currentTime, 0.1);
  }

  along(line, s) {
    if (s < 0) return null;
    for (let i = 1; i < line.length; i++) {
      const l = Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
      if (s <= l) {
        const k = s / (l || 1);
        return { x: line[i - 1][0] + (line[i][0] - line[i - 1][0]) * k, y: 2, z: line[i - 1][1] + (line[i][1] - line[i - 1][1]) * k };
      }
      s -= l;
    }
    return null;
  }
}
