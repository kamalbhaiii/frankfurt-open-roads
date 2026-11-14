/**
 * Pedestrians. A pooled crowd is recycled around the player and walks pavements and
 * footpaths, turning the corner onto the next pavement at the end of a street.
 *   - crossings: people cross at zebra crossings (cars stop for them) and wait for the
 *     green man at signal-controlled crossings (Germans do), including footpaths that
 *     cross a road
 *   - crowds where they belong, by Frankfurt time: Zeil / Hauptwache shoppers (shops shut
 *     on Sundays), Römerberg tourists, Hauptbahnhof, Bankenviertel office workers at rush
 *     hour and lunch, Mainufer walkers and joggers when it's dry; fewer at night and in rain
 *   - couples and small groups walking together, people waiting at tram/bus stops (they
 *     board and alight), small groups standing and talking, people on benches
 *   - clothing style by area via randomPerson({style}) when available
 * They get knocked down by fast cars, flee from danger and act as crime witnesses.
 * Far pedestrians are updated less often (AI LOD).
 */
import { ctx } from '../core/context.js';
import { QUALITY, RC, roadWidth } from '../core/config.js';
import { rnd, clamp, lerp, offsetLine, wrapAngle, segDist, SpatialGrid } from '../core/math.js';
import { settings } from '../core/settings.js';
import { events } from '../core/events.js';
import { frankfurtClock, pedFactor, isRushHour } from '../world/roadNetwork.js';
import { signalState } from '../world/furniture.js';
import { randomPerson } from './characters.js';

const RECYCLE = 240;

/** Areas with their own crowd, located by street name (fallback: approximate world coords). */
const ZONES = [
  {
    id: 'shop',
    names: ['Zeil', 'An der Hauptwache', 'Große Bockenheimer Straße', 'Liebfrauenberg', 'Roßmarkt', 'Goetheplatz'],
    cls: [9, 10, 13],
    r: 170,
    at: [
      [343, -265],
      [620, -300],
    ],
  },
  {
    id: 'tourist',
    names: ['Römerberg', 'Markt', 'Eiserner Steg', 'Saalgasse'],
    cls: null,
    r: 150,
    at: [
      [568, 104],
      [697, 50],
    ],
  },
  { id: 'station', names: ['Am Hauptbahnhof'], cls: null, r: 170, at: [[-672, 428]] },
  {
    id: 'bank',
    names: ['Neue Mainzer Straße', 'Taunusanlage', 'Junghofstraße', 'Gallusanlage', 'Mainzer Landstraße'],
    cls: null,
    r: 260,
    at: [
      [-120, -110],
      [-300, -270],
    ],
  },
  {
    id: 'residential',
    names: ['Oeder Weg', 'Berger Straße', 'Grüneburgweg', 'Schweizer Straße', 'Ostendstraße', 'Arndtstraße'],
    cls: null,
    r: 300,
    // Nordend, Westend, Sachsenhausen and Ostend; weighted to residential density.
    at: [
      [1071, -1028],
      [-714, -918],
      [857, 907],
      [1571, -88],
    ],
  },
  {
    id: 'river',
    names: ['Mainkai', 'Schaumainkai', 'Untermainkai', 'Sachsenhäuser Ufer', 'Deutschherrnufer'],
    cls: null,
    r: 120,
    at: [
      [713, 221],
      [177, 713],
      [-134, 617],
    ],
  },
];

const playAny = (ch, names, fade = 0.25, speed = 1) => {
  for (const n of names)
    if (ch.actions?.[n]) {
      ch.play(n, fade, speed);
      return n;
    }
  return null;
};

export class Pedestrians {
  constructor() {
    this.list = [];
    this.pool = new Map(); // style -> detached characters ready for reuse
    this.spareCount = 0;
    this.grid = new SpatialGrid(25);
    this.paths = [];
    this.meta = [];
    this.recycleTimer = 0;
    this.linked = false;
    this.zones = [];
    this.clock = { dow: 1, hour: 12 };
    this.dens = 1;
    this.frame = 0;
    this.stats = { peds: 0, idle: 0, crossing: 0, ms: 0, msAvg: 0 };
  }

  /** Back-compat: the old flat spare list. */
  get spare() {
    return [...this.pool.values()].flat();
  }

  get target() {
    return Math.round(QUALITY[ctx.quality].peds * settings.get('pedDensity') * this.dens);
  }

  build() {
    const { city } = ctx;
    const kerbed = city.roads.filter((r) => (r.c <= 6 || (r.c >= 14 && r.c <= 18)) && r.pts.length >= 2 && !r.bridge);
    for (const r of kerbed) {
      const w = roadWidth(r);
      for (const side of [-1, 1]) {
        this.paths.push(offsetLine(r.pts, side * (w / 2 + 1.3)));
        this.meta.push({ kind: 'pave', w: 1.6, links: [], gates: [], ends: [[], []] });
      }
    }
    for (const r of city.roads)
      if ((r.c === 9 || r.c === 10) && r.pts.length >= 2 && RC[r.c][1] === 1) {
        this.paths.push(r.pts);
        this.meta.push({ kind: r.c === 9 ? 'plaza' : 'foot', w: RC[r.c][0], links: [], gates: [], ends: [[], []] });
      }
    this.pathGrid = new SpatialGrid(80);
    this.vertGrid = new SpatialGrid(10);
    this.paths.forEach((pts, i) => {
      for (let j = 0; j < pts.length; j += 3) this.pathGrid.insert(pts[j][0], pts[j][1], i);
      for (let j = 0; j < pts.length; j++) this.vertGrid.insert(pts[j][0], pts[j][1], [i, j]);
    });
    // path ends continue onto a neighbouring path (round the corner) instead of turning back
    this.paths.forEach((pts, i) => {
      for (const end of [0, 1]) {
        const q = pts[end ? pts.length - 1 : 0];
        for (const [j, k] of this.vertGrid.query(q[0], q[1], 7)) {
          if (j === i) continue;
          const v = this.paths[j][k];
          if (Math.hypot(v[0] - q[0], v[1] - q[1]) < 7 && this.meta[i].ends[end].length < 4) this.meta[i].ends[end].push([j, k]);
        }
      }
    });
    // crowd zones located from street names
    for (const z of ZONES) {
      const pts = [];
      for (const r of city.roads) {
        if (!z.names.includes(r.name) || (z.cls && !z.cls.includes(r.c))) continue;
        for (let i = 0; i < r.pts.length; i += 2) pts.push(r.pts[i]);
      }
      const centres = [];
      if (pts.length) {
        // a few centres spread along the named streets
        const n = Math.min(6, Math.ceil(pts.length / 12));
        for (let k = 0; k < n; k++) centres.push(pts[Math.floor(((k + 0.5) / n) * pts.length)]);
      }
      this.zones.push({ ...z, centres: centres.length ? centres : z.at });
    }
  }

  /** Links pavements to crossings (needs ctx.traffic.crossings). */
  linkCrossings() {
    if (this.linked) return;
    this.linked = true;
    ctx.traffic?.prepare?.();
    const crossings = ctx.traffic?.crossings || [];
    const nearestOnPaths = (x, z, max, kinds) => {
      let best = null,
        bd = max;
      for (const i of new Set(this.pathGrid.query(x, z, 80))) {
        if (!kinds.includes(this.meta[i].kind)) continue;
        const pts = this.paths[i];
        for (let k = 0; k < pts.length - 1; k++) {
          const { d, t } = segDist(x, z, pts[k][0], pts[k][1], pts[k + 1][0], pts[k + 1][1]);
          if (d < bd) {
            bd = d;
            best = { path: i, k, t };
          }
        }
      }
      return best;
    };
    for (const c of crossings) {
      const px = Math.cos(c.ang),
        pz = -Math.sin(c.ang); // across the road
      const h = c.w / 2 + 1.3;
      const A = [c.x + px * h, c.z + pz * h],
        B = [c.x - px * h, c.z - pz * h];
      c.ends = [A, B];
      const la = nearestOnPaths(A[0], A[1], 4, ['pave']),
        lb = nearestOnPaths(B[0], B[1], 4, ['pave']);
      if (la && lb && la.path !== lb.path) {
        this.meta[la.path].links.push({ k: la.k, t: la.t, c, from: A, to: B, target: lb });
        this.meta[lb.path].links.push({ k: lb.k, t: lb.t, c, from: B, to: A, target: la });
      }
      // footpaths running across the road through the crossing get waiting gates
      for (const i of new Set(this.pathGrid.query(c.x, c.z, 80))) {
        const m = this.meta[i];
        if (m.kind === 'pave') continue;
        const pts = this.paths[i];
        for (let k = 0; k < pts.length - 1; k++) {
          const ax = pts[k][0],
            az = pts[k][1],
            bx = pts[k + 1][0],
            bz = pts[k + 1][1];
          const { d, t } = segDist(c.x, c.z, ax, az, bx, bz);
          if (d > 2) continue;
          const L = Math.hypot(bx - ax, bz - az) || 1;
          if (Math.abs(((bx - ax) * px + (bz - az) * pz) / L) < 0.5) continue;
          const hw = (c.w / 2 + 0.9) / L;
          m.gates.push({ k, tc: t, h: hw, c });
        }
      }
    }
  }

  // ---------------------------------------------------------------- crowd model

  updateClock() {
    if (!ctx.env?.date) return;
    this.clock = frankfurtClock(ctx.env.date);
    const w = ctx.env.weather || {};
    this.rain = w.rain || 0;
    this.sunny = (w.cloud ?? 0.5) < 0.55 && this.rain < 0.1 && (w.temp ?? 12) > 8;
    const focus = ctx.player?.position || ctx.spawn;
    const local = this.zoneWeight(focus.x, focus.z);
    this.dens = clamp(pedFactor(this.clock.dow, this.clock.hour) * (1 - clamp(this.rain, 0, 1) * 0.55) * clamp(0.65 + local.w * 0.3, 0.65, 1.6), 0.08, 1.6);
    // umbrellas when it rains (if the character supports one)
    const umb = this.rain > 0.25;
    if (umb !== this.umbrellas) {
      this.umbrellas = umb;
      for (const p of this.list) p.ch.setUmbrella?.(umb && p.style !== 'jogger' && rnd() < 0.8);
    }
  }

  zoneStrength(id) {
    const { dow, hour } = this.clock;
    const workday = dow >= 1 && dow <= 5;
    switch (id) {
      case 'shop':
        return dow === 0 ? (hour > 11 && hour < 19 ? 0.9 : 0.3) : hour > 9.5 && hour < 20.5 ? 3 : hour > 7 && hour < 22 ? 1 : 0.3;
      case 'tourist':
        return hour > 10 && hour < 19 ? (dow === 0 || dow === 6 ? 3 : 2.4) : hour > 8 && hour < 23 ? 1.1 : 0.3;
      case 'station':
        return isRushHour(dow, hour) ? 2.8 : hour > 5 && hour < 24 ? 1.6 : 0.7;
      case 'bank':
        return workday ? (isRushHour(dow, hour) ? 2.6 : hour > 11.8 && hour < 14 ? 2.2 : hour > 9 && hour < 18 ? 1.1 : 0.25) : 0.25;
      case 'residential':
        return workday ? (isRushHour(dow, hour) ? 1.15 : hour > 16 && hour < 20 ? 1.35 : 0.9) : hour > 9 && hour < 21 ? 1.35 : 0.7;
      case 'river':
        return this.sunny ? (hour > 7 && hour < 21 ? (dow === 0 || dow === 6 ? 2.8 : 2) : 0.4) : 0.5;
    }
    return 1;
  }

  /** Crowd weight at a point and the dominant zone there. */
  zoneWeight(x, z) {
    let w = 0.45,
      best = null,
      bw = 0;
    for (const zone of this.zones) {
      let f = 0;
      for (const c of zone.centres) f = Math.max(f, 1 - Math.hypot(c[0] - x, c[1] - z) / zone.r);
      if (f <= 0) continue;
      const v = f * this.zoneStrength(zone.id);
      w += v;
      if (v > bw) {
        bw = v;
        best = zone.id;
      }
    }
    return { w, zone: bw > 0.3 ? best : null };
  }

  styleFor(zone) {
    const { hour, dow } = this.clock;
    const r = rnd();
    switch (zone) {
      case 'bank':
        return dow >= 1 && dow <= 5 && hour > 6.5 && hour < 19.5 ? (r < 0.75 ? 'business' : 'casual') : 'casual';
      case 'tourist':
        return r < 0.6 ? 'tourist' : r < 0.8 ? 'casual' : 'senior';
      case 'shop':
        return r < 0.45 ? 'casual' : r < 0.65 ? 'student' : r < 0.8 ? 'tourist' : r < 0.9 ? 'senior' : 'business';
      case 'river':
        return this.sunny && r < 0.3 && (hour < 10 || hour > 17) ? 'jogger' : r < 0.6 ? 'casual' : r < 0.8 ? 'senior' : 'student';
      case 'station':
        return r < 0.3 ? 'business' : r < 0.6 ? 'casual' : r < 0.8 ? 'tourist' : 'student';
      case 'residential':
        // Approximate the citywide 16% 65+ share; younger residents use the
        // existing student outfit rather than an unmodelled child character.
        return r < 0.16 ? 'senior' : r < 0.38 ? 'student' : r < 0.56 ? 'business' : 'casual';
    }
    return hour < 11 && r < 0.25 ? 'senior' : r < 0.6 ? 'casual' : r < 0.8 ? 'student' : 'business';
  }

  getChar(style) {
    const list = this.pool.get(style);
    let ch = list?.pop();
    if (!ch && this.spareCount > 24) for (const l of this.pool.values()) if ((ch = l.pop())) break;
    if (ch) this.spareCount--;
    else {
      try {
        ch = randomPerson({ style });
      } catch {
        ch = randomPerson();
      }
      ch.pedStyle = style;
    }
    return ch;
  }

  // ---------------------------------------------------------------- spawning

  /** Spawns the initial crowd around a point. */
  populate(center) {
    this.linkCrossings();
    this.updateClock();
    for (let i = 0; i < this.target; i++) {
      if (rnd() < 0.15) this.spawnIdle(center, 10, RECYCLE * 0.7);
      else this.spawnNear(center, 10, RECYCLE * 0.8);
    }
  }

  newPed(ch, x, z, extra) {
    ch.root.scale.setScalar(0.94 + rnd() * 0.12);
    ctx.scene.add(ch.root);
    ch.root.position.set(x, 0, z);
    if (this.umbrellas && ch.pedStyle !== 'jogger') ch.setUmbrella?.(rnd() < 0.8);
    else ch.setUmbrella?.(false);
    const ped = {
      ch,
      mode: 'path',
      x,
      z,
      y: 0,
      yT: 0,
      ry: 0,
      speed: 1.3,
      yaw: rnd() * 6.28,
      down: 0,
      flee: 0,
      fleeYaw: 0,
      lat: 0.4,
      avoidSide: rnd() < 0.5 ? -1 : 1,
      style: ch.pedStyle,
      lodDt: 0,
      lodSeed: Math.floor(rnd() * 4),
      ...extra,
    };
    this.list.push(ped);
    return ped;
  }

  /** Picks a pavement/footpath point around `center`, weighted by the crowd zones. */
  pickPathPoint(center, rMin, rMax) {
    for (let t = 0; t < 14; t++) {
      const a = rnd() * Math.PI * 2,
        r = lerp(rMin, rMax, rnd());
      const x = center.x + Math.cos(a) * r,
        z = center.z + Math.sin(a) * r;
      const zw = this.zoneWeight(x, z);
      if (t < 10 && rnd() * 3.5 > zw.w) continue;
      const ids = [...this.pathGrid.query(x, z, 80)];
      if (!ids.length) continue;
      const path = rnd.pick(ids);
      const pts = this.paths[path];
      const k = Math.floor(rnd() * (pts.length - 1));
      return { path, pts, k, zone: zw.zone };
    }
    return null;
  }

  spawnNear(center, rMin, rMax) {
    const at = this.pickPathPoint(center, rMin, rMax);
    if (!at) return null;
    const { path, pts, k, zone } = at;
    const style = this.styleFor(zone);
    const jog = style === 'jogger';
    const m = this.meta[path];
    const plaza = m.kind === 'plaza';
    const lead = this.newPed(this.getChar(style), pts[k][0], pts[k][1], {
      path,
      pts,
      i: k,
      dir: rnd() < 0.5 ? 1 : -1,
      t: rnd(),
      speed: jog ? 2.7 + rnd() * 0.7 : (style === 'senior' ? 0.95 : style === 'business' ? 1.4 : 1.2) + rnd() * 0.35 + (this.rain > 0.3 ? 0.2 : 0),
      lat: plaza ? (rnd() - 0.5) * (m.w - 1.4) : 0.25 + rnd() * 0.45,
    });
    if (!pts[k + lead.dir]) lead.dir *= -1;
    // couples and small groups walk together
    if (!jog && rnd() < (zone === 'tourist' ? 0.45 : zone === 'shop' || zone === 'river' ? 0.32 : 0.18) && this.list.length < this.target) {
      const n = zone === 'tourist' && rnd() < 0.4 ? 2 : 1;
      for (let g = 0; g < n; g++) {
        const f = this.newPed(this.getChar(zone === 'tourist' ? 'tourist' : this.styleFor(zone)), lead.x, lead.z, {
          path,
          pts,
          i: k,
          dir: lead.dir,
          t: lead.t,
          speed: lead.speed,
          leader: lead,
          side: g === 0 ? -0.75 : 0.75,
          back: g === 0 ? 0 : -0.6,
        });
        f.lat = lead.lat;
      }
    }
    return lead;
  }

  /** Someone standing still: waiting at a stop, chatting in a group, or on a bench. */
  spawnIdle(center, rMin, rMax) {
    const r = rnd();
    const stops = ctx.transit?.stopsNear?.(center.x, center.z, rMax) || [];
    if (r < 0.45 && stops.length) {
      const st = rnd.pick(stops);
      if (!st.platforms.length || Math.hypot(st.x - center.x, st.z - center.z) < rMin) return null;
      const pl = rnd.pick(st.platforms);
      const x = pl.x + (rnd() - 0.5) * 2.5,
        z = pl.z + (rnd() - 0.5) * 2.5;
      return this.newPed(this.getChar(this.styleFor(this.zoneWeight(x, z).zone)), x, z, {
        mode: 'idle',
        stop: st,
        yaw: pl.yaw + (rnd() - 0.5) * 0.8,
        idleT: 120 + rnd() * 200,
        clip: rnd() < 0.35 ? ['phone', 'waiting', 'idle'] : ['waiting', 'idle'],
      });
    }
    const benches = ctx.furniture?.benches || ctx.streets?.benches;
    if (r < 0.6 && benches?.length) {
      const near = [];
      for (const b of benches) {
        const bx = b.x ?? b[0],
          bz = b.z ?? b[1];
        const d = Math.hypot(bx - center.x, bz - center.z);
        if (d > rMin && d < rMax) near.push([bx, bz, b.yaw ?? b[2] ?? 0]);
        if (near.length > 30) break;
      }
      if (near.length) {
        const [bx, bz, yaw] = rnd.pick(near);
        const probe = this.getChar(this.styleFor(null));
        if (probe.actions?.sitting && !this.list.some((p) => p.bench && Math.hypot(p.x - bx, p.z - bz) < 0.7)) {
          return this.newPed(probe, bx, bz, { mode: 'idle', bench: true, yaw, idleT: 60 + rnd() * 160, clip: ['sitting'] });
        }
        this.reclaim(probe);
      }
    }
    // a small group standing and talking (plazas, shopping streets, tourist spots)
    const at = this.pickPathPoint(center, rMin, rMax);
    if (!at) return null;
    const q = at.pts[at.k];
    const n = 2 + (rnd() < 0.4 ? 1 : 0);
    let first = null;
    for (let g = 0; g < n; g++) {
      const a = (g / n) * Math.PI * 2 + rnd() * 0.3;
      const x = q[0] + Math.sin(a) * 0.65,
        z = q[1] + Math.cos(a) * 0.65;
      const p = this.newPed(this.getChar(this.styleFor(at.zone)), x, z, {
        mode: 'idle',
        yaw: a + Math.PI,
        idleT: 40 + rnd() * 100,
        clip: g === 0 ? ['talking', 'idle'] : ['talking', 'idle', 'wave'],
        path: at.path,
        pts: at.pts,
        i: at.k,
        dir: 1,
        t: 0,
        speed: 1.2 + rnd() * 0.3,
      });
      first ||= p;
    }
    return first;
  }

  /** Spawns a pedestrian walking away from a point (e.g. alighting at a stop). */
  spawnAt(x, z, style) {
    let best = null,
      bd = 15;
    for (const [i, j] of this.vertGrid.query(x, z, 15)) {
      const v = this.paths[i][j];
      const d = Math.hypot(v[0] - x, v[1] - z);
      if (d < bd && this.meta[i].kind !== 'plaza') {
        bd = d;
        best = [i, j];
      }
    }
    if (!best) return null;
    const [path, k] = best;
    const pts = this.paths[path];
    const p = this.newPed(this.getChar(style || this.styleFor(this.zoneWeight(x, z).zone)), x, z, {
      path,
      pts,
      i: k,
      dir: rnd() < 0.5 ? 1 : -1,
      t: 0,
      speed: 1.2 + rnd() * 0.4,
      mode: 'free',
      walkTo: [pts[k][0], pts[k][1]],
    });
    if (!pts[k + p.dir]) p.dir *= -1;
    return p;
  }

  /** A tram or bus has stopped: people waiting there board, a few get off. */
  transitArrive(stop, vehicle) {
    const vp = vehicle.body.translation();
    for (const p of this.list) if (p.stop === stop && p.mode === 'idle') p.board = { x: vp.x, z: vp.z, t: 4 };
    const focus = ctx.player?.position;
    if (!focus || Math.hypot(vp.x - focus.x, vp.z - focus.z) > 160 || this.list.length > this.target + 6) return;
    const n = Math.floor(rnd() * 3);
    for (let i = 0; i < n; i++) {
      const pl = rnd.pick(stop.platforms.length ? stop.platforms : [{ x: stop.x, z: stop.z }]);
      this.spawnAt(pl.x + (rnd() - 0.5) * 2, pl.z + (rnd() - 0.5) * 2);
    }
  }

  /** Adds an existing character (e.g. a dragged-out driver) as a fleeing pedestrian. */
  addFleeing(ch, x, z, yaw) {
    ctx.scene.add(ch.root);
    ch.root.position.set(x, 0, z);
    const ped = { ch, mode: 'free', x, z, y: 0, yT: 0, ry: 0, yaw, flee: 7, fleeYaw: yaw, speed: 4.2, down: 0, lodDt: 0, lodSeed: 0 };
    this.list.push(ped);
    return ped;
  }

  /** Takes back a character that is no longer needed. */
  reclaim(ch) {
    if (!ch) return;
    ch.detach();
    ch.setUmbrella?.(false);
    const style = ch.pedStyle || 'casual';
    let l = this.pool.get(style);
    if (!l) this.pool.set(style, (l = []));
    l.push(ch);
    this.spareCount++;
  }

  remove(ped) {
    const i = this.list.indexOf(ped);
    if (i >= 0) this.list.splice(i, 1);
    this.reclaim(ped.ch);
  }

  near(x, z, r) {
    return this.grid.query(x, z, r);
  }

  /** Everyone within radius runs away from (x, z). */
  scare(x, z, r = 18) {
    for (const p of this.list) {
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < r && !p.down) {
        p.flee = 5 + rnd() * 3;
        p.fleeYaw = Math.atan2(p.x - x, p.z - z);
        p.leader = null;
        p.cross = null;
        p.hold = null;
        if (p.mode === 'idle' || p.mode === 'cross') p.mode = p.pts ? 'path' : 'free';
      }
    }
  }

  /** Number of pedestrians within r that could witness a crime. */
  witnesses(x, z, r = 25) {
    let n = 0;
    for (const p of this.grid.query(x, z, r)) if (!p.down && Math.hypot(p.x - x, p.z - z) < r) n++;
    return n;
  }

  // ---------------------------------------------------------------- crossings

  /** May a pedestrian start crossing now? Green man / no car that can't stop any more. */
  crossingOk(c, speed) {
    const crossT = (c.w + 2.6) / Math.max(speed, 0.8) + 1;
    if (c.sig) {
      const t = ctx.simTime;
      return signalState(c.sig, c.g, t) === 2 && signalState(c.sig, c.g, t + crossT) === 2;
    }
    for (const o of ctx.vehicles.grid.query(c.x, c.z, 40)) {
      if (o.destroyed) continue;
      let v;
      if (o.mode === 'ai') v = o.speed || 0;
      else {
        const lv = o.body.linvel();
        v = Math.hypot(lv.x, lv.z);
      }
      const q = o.body.translation();
      const dx = c.x - q.x,
        dz = c.z - q.z;
      const fx = Math.sin(o.yaw),
        fz = Math.cos(o.yaw);
      const along = dx * fx + dz * fz;
      const side = Math.abs(dx * fz - dz * fx);
      if (side > c.w / 2 + 1.5) continue; // parallel to the crossing, not driving through it
      if (Math.abs(along) < o.length / 2 + 1.5) return false; // standing on the crossing
      if (along < 0 || v < 0.5) continue;
      const room = along - o.length / 2 - 3;
      if (room < 3 || (v * v) / (2 * room) > 3.2) return false;
    }
    return true;
  }

  // ---------------------------------------------------------------- update

  update(dt, focus) {
    const t0 = performance.now();
    this.linkCrossings();
    this.frame++;
    const cam = ctx.camera.position;
    this.grid.map.clear();
    for (const p of this.list) this.grid.insert(p.x, p.z, p);
    for (const c of ctx.traffic?.crossings || []) c.waiting = c.on = 0;

    // recycle far pedestrians to keep the crowd around the player
    this.recycleTimer -= dt;
    if (this.recycleTimer <= 0) {
      this.recycleTimer = 1;
      this.updateClock();
      for (const p of this.list.slice()) {
        const d = Math.hypot(p.x - focus.x, p.z - focus.z);
        const over = this.list.length > this.target * 1.15 && d > 120 && !p.leader;
        if (d > RECYCLE || (p.mode === 'idle' && p.idleT <= 0 && d > 90) || (over && rnd() < 0.1)) this.remove(p);
      }
      for (const p of this.list) if (p.leader && !this.list.includes(p.leader)) this.detachFollower(p);
      const idle = this.list.filter((p) => p.mode === 'idle').length;
      for (let i = this.list.length; i < this.target && i < this.list.length + 4; i++) {
        if (idle < this.target * 0.15 && rnd() < 0.4) this.spawnIdle(focus, 110, RECYCLE - 30);
        else this.spawnNear(focus, 120, RECYCLE - 20);
      }
    }

    const playerCarHits = ctx.vehicles.list.filter((c) => c.mode !== 'ai' && Math.hypot(c.body.linvel().x, c.body.linvel().z) > 4);
    const pedDist = QUALITY[ctx.quality].pedDistance;
    let idleN = 0,
      crossN = 0;
    for (const p of this.list.slice()) {
      const far = Math.hypot(p.x - cam.x, p.z - cam.z) > pedDist;
      p.ch.root.visible = !far;
      if (p.mode === 'idle') idleN++;
      if (p.cross || p.onCross) crossN++;
      if (p.down > 0) {
        this.fallen(p, dt);
        continue;
      }
      // AI LOD: invisible pedestrians think every fourth frame
      p.lodDt += dt;
      if (far && !p.cross && !p.hold && (this.frame + p.lodSeed) % 4 && p.flee <= 0) continue;
      const sdt = Math.min(p.lodDt, 0.25);
      p.lodDt = 0;
      const sp = this.move(p, sdt);
      if (p.removed) continue;
      if (!Number.isFinite(p.x) || !Number.isFinite(p.z) || !Number.isFinite(p.yaw)) {
        this.nan = { mode: p.mode, lat: p.lat, t: p.t, i: p.i, leader: !!p.leader, cross: p.cross?.phase };
        this.remove(p);
        continue;
      }
      if (far) continue;
      p.ry -= sdt;
      if (p.ry <= 0) {
        p.yT = ctx.physics.groundY(p.x, p.z);
        p.ry = 0.3 + rnd() * 0.3;
      }
      p.y = lerp(p.y, p.yT, clamp(sdt * 10, 0, 1));
      p.ch.root.position.set(p.x, p.y, p.z);
      p.ch.root.rotation.y = p.yaw;
      if (sp > 2.5) playAny(p.ch, p.style === 'jogger' && sp < 3.6 ? ['jog', 'run'] : ['run'], 0.2, p.style === 'jogger' ? sp / 3 : sp / 6);
      else if (sp > 0.2) p.ch.play('walk', 0.25, sp / 1.45);
      else if (p.mode === 'idle' && p.clip) playAny(p.ch, p.clip, 0.4);
      else playAny(p.ch, p.waitClip || ['idle'], 0.3);
      p.ch.update(sdt);

      for (const car of playerCarHits) {
        const c = car.body.translation();
        if (Math.hypot(c.x - p.x, c.z - p.z) > 2.6) continue;
        const v = car.body.linvel();
        const sv = Math.hypot(v.x, v.z);
        p.down = 2.6;
        p.vy = 3 + sv * 0.15;
        p.vx = v.x * 0.6;
        p.vz = v.z * 0.6;
        p.yaw = Math.atan2(v.x, v.z) + Math.PI;
        p.ch.root.rotation.y = p.yaw;
        p.leader = null;
        p.cross = p.hold = p.onCross = null;
        this.scare(p.x, p.z, 20);
        if (car === ctx.player.vehicle) {
          ctx.stats.add('pedsHit', 1);
          events.emit('crime', { type: 'hitPed', x: p.x, z: p.z });
        }
        break;
      }
    }
    const ms = performance.now() - t0;
    const s = this.stats;
    s.peds = this.list.length;
    s.idle = idleN;
    s.crossing = crossN;
    s.target = this.target;
    s.ms = ms;
    s.msAvg = lerp(s.msAvg, ms, 0.02);
  }

  fallen(p, dt) {
    p.down -= dt;
    p.vy -= 9.8 * dt;
    p.x += p.vx * dt;
    p.z += p.vz * dt;
    p.y = Math.max(p.yT, p.y + p.vy * dt);
    p.vx *= 0.96;
    p.vz *= 0.96;
    p.ch.root.position.set(p.x, p.y, p.z);
    p.ch.play('fall', 0.1);
    p.ch.update(dt);
    if (p.down <= 0) {
      p.down = 0;
      p.flee = 5;
      p.fleeYaw = p.yaw;
      if (p.mode === 'path' || p.mode === 'idle' || p.mode === 'cross') p.mode = 'free';
    }
  }

  detachFollower(p) {
    p.leader = null;
    if (p.pts) {
      p.mode = 'path';
      this.rejoinPath(p);
    } else p.mode = 'free';
  }

  /** Moves one pedestrian; returns its speed (for the animation). */
  move(p, dt) {
    p.waitClip = null;
    if (p.flee > 0) {
      p.flee -= dt;
      const sp = 4.2;
      p.yaw += wrapAngle(p.fleeYaw - p.yaw) * clamp(dt * 6, 0, 1);
      p.x += Math.sin(p.yaw) * sp * dt;
      p.z += Math.cos(p.yaw) * sp * dt;
      if (p.flee <= 0 && p.pts) {
        p.mode = 'path';
        this.rejoinPath(p);
      }
      return sp;
    }
    // followers keep pace beside their companion
    const L = p.leader;
    if (L) {
      if (L.down || L.flee > 0 || !L.pts) {
        this.detachFollower(p);
        return 0;
      }
      const rx = -Math.cos(L.yaw),
        rz = Math.sin(L.yaw);
      const tx = L.x + rx * p.side + Math.sin(L.yaw) * (p.back || 0),
        tz = L.z + rz * p.side + Math.cos(L.yaw) * (p.back || 0);
      const d = Math.hypot(tx - p.x, tz - p.z);
      const k = clamp(dt * 4, 0, 1);
      p.x = lerp(p.x, tx, k);
      p.z = lerp(p.z, tz, k);
      p.yaw += wrapAngle((d > 0.6 ? Math.atan2(tx - p.x, tz - p.z) : L.yaw) - p.yaw) * clamp(dt * 6, 0, 1);
      p.pts = L.pts;
      p.path = L.path;
      p.i = L.i;
      p.dir = L.dir;
      p.t = L.t;
      if (L.cross || L.onCross) p.onCross = L.cross?.c || L.onCross;
      else p.onCross = null;
      if (p.onCross && L.lastSp > 0.2) p.onCross.on++;
      return L.lastSp ?? 0;
    }
    let sp = 0;
    if (p.mode === 'idle') sp = this.moveIdle(p, dt);
    else if (p.mode === 'cross') sp = this.moveCross(p, dt);
    else if (p.mode === 'free') {
      if (p.walkTo) {
        const dx = p.walkTo[0] - p.x,
          dz = p.walkTo[1] - p.z;
        const d = Math.hypot(dx, dz);
        if (d < 0.5) {
          p.walkTo = null;
          p.mode = 'path';
          p.t = 0;
        } else {
          sp = p.speed;
          p.yaw += wrapAngle(Math.atan2(dx, dz) - p.yaw) * clamp(dt * 6, 0, 1);
          p.x += (dx / d) * sp * dt;
          p.z += (dz / d) * sp * dt;
        }
      }
    } else sp = this.movePath(p, dt);
    if (sp > 0.1 && p.mode !== 'cross') this.avoidCrowd(p, dt);
    p.lastSp = sp;
    return sp;
  }

  /** A gentle shoulder check and sidestep keeps walkers from marching through one another. */
  avoidCrowd(p, dt) {
    let push = 0;
    const rightX = -Math.cos(p.yaw),
      rightZ = Math.sin(p.yaw);
    for (const q of this.grid.query(p.x, p.z, 1.35)) {
      if (q === p || q.leader === p || p.leader === q || q.down > 0) continue;
      const dx = p.x - q.x,
        dz = p.z - q.z,
        d2 = dx * dx + dz * dz;
      if (d2 < 0.01 || d2 > 1.82) continue;
      const f = (1.35 - Math.sqrt(d2)) / 1.35;
      const side = dx * rightX + dz * rightZ;
      push += (Math.abs(side) > 0.12 ? Math.sign(side) : p.avoidSide) * f;
    }
    if (!push || !p.pts) return;
    const m = this.meta[p.path];
    const lo = m?.kind === 'plaza' ? -m.w / 2 + 0.5 : 0.18;
    const hi = m?.kind === 'plaza' ? m.w / 2 - 0.5 : 1.15;
    p.lat = clamp(p.lat + push * dt * 0.8, lo, hi);
  }

  moveIdle(p, dt) {
    p.idleT -= dt;
    if (p.board) {
      // walk to the tram/bus door and get in
      const dx = p.board.x - p.x,
        dz = p.board.z - p.z;
      const d = Math.hypot(dx, dz);
      p.board.t -= dt;
      if (d < 1.6 || p.board.t <= 0) {
        p.removed = true;
        this.remove(p);
        return 0;
      }
      p.yaw += wrapAngle(Math.atan2(dx, dz) - p.yaw) * clamp(dt * 6, 0, 1);
      p.x += (dx / d) * 1.3 * dt;
      p.z += (dz / d) * 1.3 * dt;
      return 1.3;
    }
    if (p.idleT <= 0 && p.pts && !p.stop) {
      // the chat is over: walk on
      p.mode = 'path';
      p.clip = null;
      this.rejoinPath(p);
      p.dir = rnd() < 0.5 ? 1 : -1;
      if (!p.pts[p.i + p.dir]) p.dir *= -1;
    }
    return 0;
  }

  /** Pavement → kerb → wait → across → join the opposite pavement. */
  moveCross(p, dt) {
    const cr = p.cross;
    const c = cr.c;
    const goTo = (x, z, speed) => {
      const dx = x - p.x,
        dz = z - p.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.25) return true;
      const st = Math.min(d, speed * dt);
      p.x += (dx / d) * st;
      p.z += (dz / d) * st;
      p.yaw += wrapAngle(Math.atan2(dx, dz) - p.yaw) * clamp(dt * 7, 0, 1);
      return false;
    };
    if (cr.phase === 'to') {
      if (goTo(cr.from[0] + cr.off[0], cr.from[1] + cr.off[1], p.speed)) cr.phase = 'wait';
      return p.speed;
    }
    if (cr.phase === 'wait') {
      c.waiting++;
      cr.waitT = (cr.waitT || 0) + dt;
      p.yaw += wrapAngle(Math.atan2(cr.to[0] - p.x, cr.to[1] - p.z) - p.yaw) * clamp(dt * 4, 0, 1);
      cr.check -= dt;
      if (cr.check <= 0) {
        cr.check = 0.3;
        if (this.crossingOk(c, p.speed)) cr.phase = 'walk';
        else if (cr.waitT > 90) {
          // give up and walk on
          p.cross = null;
          p.mode = 'path';
          this.rejoinPath(p);
          return 0;
        }
      }
      p.waitClip = c.sig && cr.waitT > 8 && p.style !== 'jogger' ? ['phone', 'waiting', 'idle'] : ['waiting', 'idle'];
      return 0;
    }
    // walking across
    c.on++;
    if (goTo(cr.to[0] + cr.off[0], cr.to[1] + cr.off[1], p.speed * 1.1)) {
      const tg = cr.target;
      p.path = tg.path;
      p.pts = this.paths[tg.path];
      p.dir = rnd() < 0.5 ? 1 : -1;
      if (p.dir > 0) {
        p.i = tg.k;
        p.t = tg.t;
      } else {
        p.i = tg.k + 1;
        p.t = 1 - tg.t;
      }
      p.cooldown = 25;
      p.cross = null;
      p.mode = 'path';
    }
    return p.speed * 1.1;
  }

  movePath(p, dt) {
    p.pauseCooldown = Math.max(0, (p.pauseCooldown || 0) - dt);
    if (p.pauseT > 0) {
      p.pauseT = Math.max(0, p.pauseT - dt);
      p.waitClip = p.style === 'business' ? ['phone', 'idle'] : ['idle', 'waiting'];
      return 0;
    }
    const pts = p.pts;
    let a = pts[p.i],
      b = pts[p.i + p.dir];
    if (!b) {
      p.dir *= -1;
      b = pts[p.i + p.dir];
      if (!b) return 0;
    }
    const m = this.meta[p.path];
    const seg = p.dir > 0 ? p.i : p.i - 1;
    const uOld = p.dir > 0 ? p.t : 1 - p.t;
    // footpath gate: wait at the kerb until we may cross
    if (p.hold) {
      const g = p.hold;
      g.c.waiting++;
      p.holdT = (p.holdT || 0) - dt;
      if (p.holdT <= 0) {
        p.holdT = 0.3;
        if (this.crossingOk(g.c, p.speed)) {
          p.onCross = g.c;
          p.hold = null;
        }
      }
      this.placeOnPath(p, a, b, dt);
      p.waitClip = ['waiting', 'idle'];
      return 0;
    }
    const sp = p.speed;
    const Ls = Math.hypot(b[0] - a[0], b[1] - a[1]) || 0.01;
    p.t += (sp * dt) / Ls;
    const uNew = p.dir > 0 ? Math.min(p.t, 1) : 1 - Math.min(p.t, 1);
    p.cooldown = (p.cooldown || 0) - dt;
    if (m) {
      for (const g of m.gates) {
        if (g.k !== seg) continue;
        const edge = p.dir > 0 ? g.tc - g.h : g.tc + g.h;
        const crossedGate = p.dir > 0 ? uOld < edge && uNew >= edge : uOld > edge && uNew <= edge;
        if (crossedGate && p.onCross !== g.c) {
          p.t = p.dir > 0 ? edge : 1 - edge;
          p.hold = g;
          p.holdT = 0;
          this.placeOnPath(p, a, b, dt);
          return 0;
        }
      }
      if (p.onCross) {
        const g = m.gates.find((q) => q.c === p.onCross && q.k === seg);
        if (!g || Math.abs(uNew - g.tc) > g.h + 0.02) p.onCross = null;
        else p.onCross.on++;
      }
      // pavement → zebra crossing: some people cross to the other side
      if (m.links.length && p.cooldown <= 0) {
        for (const l of m.links) {
          if (l.k !== seg) continue;
          const passed = p.dir > 0 ? uOld < l.t && uNew >= l.t : uOld > l.t && uNew <= l.t;
          if (!passed) continue;
          p.cooldown = 8;
          if (rnd() < 0.45) {
            const ox = (rnd() - 0.5) * Math.min(1.6, l.c.w * 0.15);
            const ax = Math.sin(l.c.ang) * ox,
              az = Math.cos(l.c.ang) * ox;
            p.mode = 'cross';
            p.cross = { c: l.c, phase: 'to', from: l.from, to: l.to, target: l.target, check: 0, off: [ax, az] };
            return sp;
          }
        }
      }
    }
    if (p.t >= 1) {
      p.t = 0;
      p.i += p.dir;
      if (p.i + p.dir < 0 || p.i + p.dir >= pts.length) {
        // end of this path: round the corner onto a neighbouring one, or turn back
        const ends = m?.ends[p.dir > 0 ? 1 : 0];
        if (ends?.length && rnd() < 0.8) {
          const [j, k] = rnd.pick(ends);
          p.path = j;
          p.pts = this.paths[j];
          p.i = k;
          p.dir = k === 0 ? 1 : k === p.pts.length - 1 ? -1 : rnd() < 0.5 ? 1 : -1;
          const mm = this.meta[j];
          p.lat = mm.kind === 'plaza' ? (rnd() - 0.5) * (mm.w - 1.4) : 0.25 + rnd() * 0.45;
        } else p.dir *= -1;
        // People occasionally stop to check a phone, look into a shop, or orient
        // themselves at the end of a block instead of moving at constant speed.
        if (p.style !== 'jogger' && (p.pauseCooldown || 0) <= 0 && rnd() < (p.style === 'tourist' ? 0.2 : 0.08)) {
          p.pauseT = 1.1 + rnd() * (p.style === 'tourist' ? 3.8 : 2.4);
          p.pauseCooldown = 35 + rnd() * 55;
        }
      }
      a = p.pts[p.i];
      b = p.pts[p.i + p.dir];
      if (!b) return 0;
    }
    this.placeOnPath(p, a, b, dt);
    return sp;
  }

  placeOnPath(p, a, b, dt) {
    const dx = b[0] - a[0],
      dz = b[1] - a[1],
      l = Math.hypot(dx, dz) || 1;
    const t = clamp(p.t, 0, 1);
    // right of travel is (-dz, dx)
    p.x = lerp(a[0], b[0], t) - (dz / l) * p.lat;
    p.z = lerp(a[1], b[1], t) + (dx / l) * p.lat;
    p.yaw += wrapAngle(Math.atan2(dx, dz) - p.yaw) * clamp(dt * 8, 0, 1);
  }

  rejoinPath(p) {
    if (!p.pts) {
      p.mode = 'free';
      return;
    }
    let best = 0,
      bd = Infinity;
    p.pts.forEach((q, i) => {
      const d = Math.hypot(q[0] - p.x, q[1] - p.z);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    if (bd > 12) {
      p.mode = 'free';
      return;
    }
    p.i = Math.min(best, p.pts.length - 2);
    p.dir = 1;
    p.t = 0;
    p.lat ??= 0.4;
  }
}
