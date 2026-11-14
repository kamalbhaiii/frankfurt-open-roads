/**
 * Public transport: trams on Frankfurt's real tram tracks (OSM rails tagged tram) and
 * buses on the main roads.
 *   - trams keep to the right-hand track of double-track lines, take gentle switches,
 *     slow for curves, stop at generated stops (~400 m apart) with a dwell time and have
 *     priority at junctions (road traffic yields to them; they ignore car signals)
 *   - buses are traffic AI vehicles (role 'bus') that pull in to the kerb at bus stops
 *   - people wait at stops and board / alight (see pedestrians.js)
 * Uses the 'tram' / 'bus' vehicle kinds when they exist; without them this does nothing.
 */
import * as THREE from 'three';
import { ctx } from '../core/context.js';
import { rnd, clamp, lerp, wrapAngle, damp, hash, segDist, SpatialGrid } from '../core/math.js';
import { RoadNetwork } from '../world/roadNetwork.js';
import { firstKind, spawnVehicle } from './traffic.js';
import { inStationArea } from '../world/station/zones.js';

const UP = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion();
const TRAMS = { low: 2, medium: 3, high: 4, ultra: 5 };
const BUSES = { low: 1, medium: 2, high: 2, ultra: 3 };
const TRAM_SPEED = 50 / 3.6;
const STOP_SPACING = 400;
const _a = {},
  _b = {},
  _c = {};

// Central sections of current RMV Metrobus lines. Stops are snapped to the
// street graph, then the road graph fills in the drivable path between them.
const BUS_CORRIDORS = [
  {
    line: 'M36',
    streets: [
      'Bornwiesenweg',
      'Eschersheimer Landstraße',
      'Alte Gasse',
      'Konstablerwache',
      'Börneplatz',
      'Schöne Aussicht',
      'Elisabethenstraße',
      'Affentorplatz',
      'Lokalbahnhof',
      'Darmstädter Landstraße',
    ],
  },
  {
    line: 'M32',
    streets: [
      'Hanauer Landstraße',
      'Ostendstraße',
      'Zeil',
      'Große Eschenheimer Straße',
      'Eschersheimer Landstraße',
      'Bockenheimer Landstraße',
      'Westendstraße',
    ],
  },
  { line: 'M34', streets: ['Mainzer Landstraße', 'Kaiserstraße', 'Taunusstraße', 'Zeil', 'Berger Straße'] },
  { line: 'M46', streets: ['Europa-Allee', 'Friedrich-Ebert-Anlage', 'Platz der Republik', 'Am Hauptbahnhof'] },
];

export class Transit {
  constructor(traffic) {
    this.traffic = traffic;
    this.trams = [];
    this.stops = []; // tram stops {x, z, yaw, platforms: [{x, z, yaw}], kind}
    this.busStops = [];
    this.busRoutes = [];
    this.nextBusRoute = 0;
    this.railGrid = new SpatialGrid(25);
    this.net = null;
    this.timer = 0;
  }

  /** Builds the tram graph and generates tram and bus stops. */
  build() {
    const rails = (ctx.city?.rails || []).filter((r) => r.tram && r.pts.length >= 2);
    if (rails.length) {
      this.net = new RoadNetwork(rails.map((r) => ({ pts: r.pts, speed: TRAM_SPEED, width: 3, oneway: false })));
      for (const e of this.net.edges) {
        e.stops = [];
        for (let s = 0; s <= e.len; s += 3) {
          const p = RoadNetwork.pose(e, 1, s);
          this.railGrid.insert(p.x, p.z, [p.x, p.z, e.id]);
        }
      }
      // right-hand running: on a double track the oncoming track must be on our left
      for (const e of this.net.edges) {
        let side = 0;
        for (const s of [e.len * 0.3, e.len * 0.7]) {
          const m = RoadNetwork.pose(e, 1, s),
            r = RoadNetwork.pose(e, 1, s, 1);
          const rx = r.x - m.x,
            rz = r.z - m.z;
          for (const q of this.railGrid.query(m.x, m.z, 6)) {
            if (q[2] === e.id) continue;
            const d = Math.hypot(q[0] - m.x, q[1] - m.z);
            if (d < 1.5 || d > 6) continue;
            side += Math.sign((q[0] - m.x) * rx + (q[1] - m.z) * rz);
          }
        }
        e.pref = side > 0 ? -1 : side < 0 ? 1 : 0;
      }
      // stops: greedy, roughly every 400 m, mid-edge (away from switches)
      const cands = this.net.edges.filter((e) => e.len > 35).sort((a, b) => hash(a.id * 1.3) - hash(b.id * 1.3));
      for (const e of cands) {
        const m = RoadNetwork.pose(e, 1, e.len / 2);
        if (this.stops.some((s) => Math.hypot(s.x - m.x, s.z - m.z) < STOP_SPACING)) continue;
        this.stops.push({ x: m.x, z: m.z, yaw: m.yaw, platforms: [], kind: 'tram', waiting: 0 });
      }
      for (const st of this.stops) {
        const seen = new Set();
        for (const [e, j] of this.net.segGrid.query(st.x, st.z, 12)) {
          if (seen.has(e)) continue;
          const p = e.pts[j],
            q = e.pts[j + 1];
          const { d, t } = segDist(st.x, st.z, p[0], p[1], q[0], q[1]);
          if (d > 7) continue;
          seen.add(e);
          let s = 0;
          for (let k = 0; k < j; k++) s += Math.hypot(e.pts[k + 1][0] - e.pts[k][0], e.pts[k + 1][1] - e.pts[k][1]);
          s += Math.hypot(q[0] - p[0], q[1] - p[1]) * t;
          e.stops.push({ s, stop: st });
          // platform on the right of the preferred direction
          const dir = e.pref || 1;
          const sd = dir > 0 ? s : e.len - s;
          for (const off of [-6, 0, 6]) {
            const pl = RoadNetwork.pose(e, dir, clamp(sd + off, 0, e.len), 3.2);
            st.platforms.push({ x: pl.x, z: pl.z, yaw: wrapAngle(pl.yaw - Math.PI / 2) });
          }
        }
      }
    }
    this.buildBusRoutes();
    this.buildBusStops();
  }

  /** Build repeatable, graph-following paths through the mapped parts of RMV lines. */
  buildBusRoutes() {
    const roads = ctx.roads;
    for (const spec of BUS_CORRIDORS) {
      const anchors = [];
      let previous = null;
      for (const name of spec.streets) {
        const candidates = roads.edges.filter((e) => e.name === name && e.len > 8);
        if (!candidates.length) continue;
        candidates.sort((a, b) => {
          const pa = RoadNetwork.pose(a, 1, a.len / 2),
            pb = RoadNetwork.pose(b, 1, b.len / 2);
          return previous ? Math.hypot(pa.x - previous.x, pa.z - previous.z) - Math.hypot(pb.x - previous.x, pb.z - previous.z) : b.len - a.len;
        });
        const e = candidates[0],
          mid = RoadNetwork.pose(e, 1, e.len / 2);
        const ends = [RoadNetwork.pose(e, 1, 0), RoadNetwork.pose(e, 1, e.len)];
        const node =
          previous && Math.hypot(ends[0].x - previous.x, ends[0].z - previous.z) > Math.hypot(ends[1].x - previous.x, ends[1].z - previous.z)
            ? ends[1]
            : ends[0];
        if (!previous || Math.hypot(node.x - previous.x, node.z - previous.z) > 20) anchors.push({ name, point: [node.x, node.z], stopPoint: [mid.x, mid.z] });
        previous = node;
      }
      if (anchors.length < 3) continue;
      const steps = [],
        stops = [];
      const appendLeg = (from, to) => {
        const route = roads.route(from[0], from[1], to[0], to[1], true);
        if (!route?.edges) return false;
        for (const s of route.edges) if (!steps.length || steps.at(-1).edge !== s.edge || steps.at(-1).dir !== s.dir) steps.push(s);
        return true;
      };
      let connected = true;
      for (let i = 0; i < anchors.length - 1; i++) {
        const start = anchors[i].point,
          end = anchors[i + 1].point;
        connected = appendLeg(start, end) && connected;
      }
      // Return along a legal route to make a continuous service loop.
      connected = appendLeg(anchors.at(-1).point, anchors[0].point) && connected;
      if (!connected || steps.length < 4) continue;
      for (let i = 0; i < anchors.length; i++) {
        const anchor = anchors[i];
        const options = steps.filter((s) => s.edge.name === anchor.name);
        options.sort((a, b) => {
          const pa = RoadNetwork.pose(a.edge, a.dir, a.edge.len / 2),
            pb = RoadNetwork.pose(b.edge, b.dir, b.edge.len / 2);
          return Math.hypot(pa.x - anchor.stopPoint[0], pa.z - anchor.stopPoint[1]) - Math.hypot(pb.x - anchor.stopPoint[0], pb.z - anchor.stopPoint[1]);
        });
        const step = options[0];
        if (!step) continue;
        const hit = roads.nearest(anchor.stopPoint[0], anchor.stopPoint[1], 30, (e) => e === step.edge);
        if (!hit) continue;
        const s = step.dir > 0 ? hit.s : hit.edge.len - hit.s;
        stops.push({ line: spec.line, name: anchor.name, edge: hit.edge, dir: step.dir, s, sFwd: s, point: anchor.point });
      }
      if (stops.length >= 3) this.busRoutes.push({ line: spec.line, steps, stops });
    }
  }

  buildBusStops() {
    for (const route of this.busRoutes)
      for (const spec of route.stops) {
        const e = spec.edge,
          dir = spec.dir,
          sT = spec.s;
        if (!e.busStops) e.busStops = [];
        const kerb = e.width / 2;
        const pl = RoadNetwork.pose(e, dir, sT, kerb + 1.4);
        if (inStationArea(pl.x, pl.z)) continue; // keep the Hauptbahnhof / Fernbusterminal clear
        const stop = { edge: e, dir, s: sT, sFwd: sT, x: pl.x, z: pl.z, name: spec.name, line: route.line, kind: 'bus', waiting: 0, platforms: [] };
        for (const off of [-4, 0, 4]) {
          const at = sT + off;
          const q = RoadNetwork.pose(e, dir, clamp(at, 0, e.len), kerb + 1.4);
          stop.platforms.push({ x: q.x, z: q.z, yaw: wrapAngle(q.yaw - Math.PI / 2) });
        }
        e.busStops.push({ s: sT, stop });
        this.busStops.push(stop);
      }
  }

  nextBusMove(ai, nodeId, traffic) {
    const route = ai.busRoute;
    if (!route?.steps?.length) return null;
    const i = ai.busRouteIndex ?? 0;
    const cur = route.steps[i % route.steps.length];
    if (cur.edge !== ai.edge || cur.dir !== ai.dir) return null;
    const next = route.steps[(i + 1) % route.steps.length];
    const turn = traffic.turnFor(ai, next.edge, next.dir, nodeId);
    return { edge: next.edge, dir: next.dir, turn };
  }

  spawnBusNear(center, kind, avoidView = true) {
    for (let r = 0; r < this.busRoutes.length; r++) {
      const routeIndex = (this.nextBusRoute + r) % this.busRoutes.length;
      const route = this.busRoutes[routeIndex];
      for (let i = 0; i < route.steps.length; i++) {
        const { edge, dir } = route.steps[i];
        const p = RoadNetwork.pose(edge, dir, edge.len * 0.5);
        const d = Math.hypot(p.x - center.x, p.z - center.z);
        if (d < 150 || d > 360 || (avoidView && this.traffic.inView(p.x, p.z)) || this.traffic.occupied(p.x, p.z, 14)) continue;
        const car = this.traffic.spawnAt(edge, dir, edge.len * 0.5, kind, 'bus');
        if (!car) return null;
        car.ai.busRoute = route;
        car.ai.busRouteIndex = i;
        car.ai.busLine = route.line;
        car.busLine = route.line;
        this.traffic.planNext(car.ai);
        this.nextBusRoute = (routeIndex + 1) % this.busRoutes.length;
        return car;
      }
    }
    return null;
  }

  /** All stops (tram + bus) within r of a point. */
  stopsNear(x, z, r) {
    const out = [];
    for (const s of this.stops) if (Math.hypot(s.x - x, s.z - z) < r) out.push(s);
    for (const s of this.busStops) if (Math.hypot(s.x - x, s.z - z) < r) out.push(s);
    return out;
  }

  populate(center) {
    for (let i = 0; i < TRAMS[ctx.quality]; i++) this.spawnTram(center, 60, 450, false);
    this.manage(center);
  }

  // ---------------------------------------------------------------- trams

  spawnTram(center, rMin, rMax, avoidView = true) {
    const kind = firstKind(['tram']);
    if (!kind || !this.net) return null;
    for (let t = 0; t < 16; t++) {
      const a = rnd() * Math.PI * 2,
        r = lerp(rMin, rMax, rnd());
      const hit = this.net.nearest(center.x + Math.cos(a) * r, center.z + Math.sin(a) * r, 120, (e) => e.len > 40);
      if (!hit) continue;
      if (avoidView && this.traffic.inView(hit.x, hit.z)) continue;
      if (this.trams.some((c) => Math.hypot(c.body.translation().x - hit.x, c.body.translation().z - hit.z) < 80)) continue;
      if (this.traffic.occupied(hit.x, hit.z, 14)) continue;
      const e = hit.edge;
      const dir = e.pref || (rnd() < 0.5 ? 1 : -1);
      const s = clamp(dir > 0 ? hit.s : e.len - hit.s, 1, e.len - 1);
      const p = RoadNetwork.pose(e, dir, s);
      const car = spawnVehicle(kind, p.x, p.z, p.yaw, 'ai');
      if (!car) return null;
      car.ai = null;
      car.transit = true;
      car.speed = 0;
      car.rail = { edge: e, dir, s, next: null, prev: null, dwell: 0, served: null, stuck: 0 };
      car.rail.next = this.railNext(car.rail);
      this.trams.push(car);
      return car;
    }
    return null;
  }

  railNext(r) {
    const node = r.dir > 0 ? r.edge.b : r.edge.a;
    const endYaw = RoadNetwork.pose(r.edge, r.dir, r.edge.len - 0.5).yaw;
    const opts = [];
    let total = 0;
    for (const m of this.net.moves(node, false)) {
      if (m.edge === r.edge) continue;
      const y = RoadNetwork.pose(m.edge, m.dir, Math.min(3, m.edge.len)).yaw;
      const dev = Math.abs(wrapAngle(y - endYaw));
      if (dev > 0.7) continue; // no switch takes a tram round a sharp corner
      const w = (m.edge.pref === 0 || m.edge.pref === m.dir ? 5 : 0.2) * (1.2 - dev);
      opts.push({ edge: m.edge, dir: m.dir, dev, w });
      total += w;
    }
    if (!opts.length) return null;
    let x = rnd() * total;
    for (const o of opts) if ((x -= o.w) <= 0) return o;
    return opts[0];
  }

  /** Point on the track `d` metres from the tram's reference along its path (handles neighbouring edges). */
  railPoint(r, d, out) {
    if (d > r.edge.len && r.next) return RoadNetwork.pose(r.next.edge, r.next.dir, Math.min(d - r.edge.len, r.next.edge.len), 0, out);
    if (d < 0 && r.prev) return RoadNetwork.pose(r.prev.edge, r.prev.dir, Math.max(0, r.prev.edge.len + d), 0, out);
    return RoadNetwork.pose(r.edge, r.dir, clamp(d, 0, r.edge.len), 0, out);
  }

  driveTram(car, dt) {
    const r = car.rail;
    const e = r.edge;
    const remaining = e.len - r.s;
    let v0 = TRAM_SPEED * (1 - (ctx.env?.weather?.rain || 0) * 0.1);
    if (r.next && r.next.dev > 0.2) v0 = Math.min(v0, Math.sqrt(16 + 2 * 0.9 * Math.max(0, remaining - 4)));
    const A = 1.0,
      B = 1.6;
    let acc = A * (1 - Math.pow(car.speed / v0, 4));
    const stopAt = (d) => {
      const g = Math.max(d, 0.05) + 0.3;
      acc = Math.min(acc, A * (1 - (car.speed / v0) ** 4 - ((0.3 + (car.speed * car.speed) / (2 * Math.sqrt(A * B))) / g) ** 2));
    };
    // stops
    if (r.dwell > 0) {
      r.dwell -= dt;
      stopAt(0);
      car.indicator = 0;
    } else {
      for (const st of e.stops) {
        if (r.served === st.stop) continue;
        const d = (r.dir > 0 ? st.s : e.len - st.s) - r.s;
        if (d < -1 || d > 80) continue;
        stopAt(d);
        if (d < 0.8 && car.speed < 0.4) {
          r.dwell = 14 + rnd() * 10;
          r.served = st.stop;
          ctx.peds?.transitArrive?.(st.stop, car);
        }
      }
    }
    // obstacles ahead of the front: road vehicles, other trams, people
    const half = car.length / 2;
    const f = this.railPoint(r, r.s + half, _a);
    const fx = Math.sin(f.yaw),
      fz = Math.cos(f.yaw);
    let gap = Infinity,
      vl = 0;
    const test = (x, z, w, len, v) => {
      const dx = x - f.x,
        dz = z - f.z;
      const ahead = dx * fx + dz * fz;
      if (ahead < -0.5 || ahead > 30) return;
      if (Math.abs(dx * fz - dz * fx) > 1.3 + w) return;
      const g = ahead - len;
      if (g < gap) {
        gap = g;
        vl = v;
      }
    };
    for (const o of ctx.vehicles.grid.query(f.x + fx * 12, f.z + fz * 12, 22)) {
      if (o === car || o.destroyed) continue;
      const q = o.body.translation();
      const ofx = Math.sin(o.yaw),
        ofz = Math.cos(o.yaw);
      const hl = o.length / 2;
      const v = (o.mode === 'ai' ? o.speed || 0 : Math.hypot(o.body.linvel().x, o.body.linvel().z)) * (fx * ofx + fz * ofz);
      for (let k = -hl; k <= hl; k += Math.max(1.5, hl)) test(q.x + ofx * k, q.z + ofz * k, o.width / 2, 0.5, v);
    }
    for (const pd of ctx.peds.near(f.x + fx * 10, f.z + fz * 10, 16)) if (!pd.down) test(pd.x, pd.z, 0.4, 0.3, 0);
    const pp = ctx.player.position;
    if (!ctx.player.vehicle) test(pp.x, pp.z, 0.4, 0.3, 0);
    if (gap < 40) {
      const ss = 3 + Math.max(0, car.speed * 1.2 + (car.speed * (car.speed - vl)) / (2 * Math.sqrt(A * B)));
      acc = Math.min(acc, A * (1 - (car.speed / v0) ** 4 - (ss / Math.max(gap, 0.1)) ** 2));
      if (gap < 12 && car.speed > 1) car.bell = (car.bell || 0) + dt;
    }
    car.speed = Math.max(0, car.speed + clamp(acc, -6, A) * dt);
    if (car.speed < 0.05 && acc <= 0) car.speed = 0;
    r.stuck = car.speed < 0.1 && r.dwell <= 0 ? r.stuck + dt : 0;
    r.s += car.speed * dt;
    if (r.s >= e.len) {
      if (!r.next) {
        r.s = e.len;
        car.speed = 0;
        r.end = true;
      } else {
        r.s -= e.len;
        r.prev = { edge: r.edge, dir: r.dir };
        r.edge = r.next.edge;
        r.dir = r.next.dir;
        r.next = this.railNext(r);
        r.served = null;
      }
    }
    // pose: centre on the track, heading along the chord between the bogies
    const c = this.railPoint(r, r.s, _b);
    const fr = this.railPoint(r, r.s + half * 0.7, _a),
      rr = this.railPoint(r, r.s - half * 0.7, _c);
    const yaw = Math.atan2(fr.x - rr.x, fr.z - rr.z);
    car.yaw += wrapAngle(yaw - car.yaw) * damp(12, dt);
    const p = car.body.translation();
    if (!Number.isFinite(c.x + c.z + car.yaw)) {
      this.nan = { edge: r.edge.id, s: r.s, speed: car.speed };
      r.stuck = 99;
      r.end = true;
      car.speed = 0;
      car.yaw = 0;
      return;
    }
    car.body.setNextKinematicTranslation({ x: lerp(p.x, c.x, damp(16, dt)), y: car.H0 + 0.035, z: lerp(p.z, c.z, damp(16, dt)) });
    _q.setFromAxisAngle(UP, car.yaw);
    car.body.setNextKinematicRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w });
    car.braking = acc < -0.4 || car.speed < 0.2;
    car.wheelSpin += (car.speed * dt) / (car.ud?.wheelRadius || 0.4);
    car.kmh = car.speed * 3.6;
  }

  // ---------------------------------------------------------------- buses

  /** Bus behaviour inside the traffic AI: stop at bus stops, pull in to the kerb. Returns the extra lateral shift. */
  busLogic(car, ai, dt, stopAt) {
    const e = ai.edge;
    const kerb = e.width / 2 - (ai.dir > 0 ? e.parkR : e.parkL);
    const shift = Math.max(0, kerb - 1.5 - ai.lat);
    if (ai.dwell > 0) {
      ai.dwell -= dt;
      stopAt(0, 0);
      car.indicator = ai.dwell < 3 ? -1 : 0; // indicate before pulling out
      return ai.dwell < 1 ? 0 : shift;
    }
    for (const b of e.busStops) {
      const st = b.stop;
      if (st.dir !== ai.dir || st.line !== ai.busLine || ai.busServed === st) continue;
      const d = st.s - ai.s;
      if (d < -1 || d > 70) continue;
      stopAt(d, 0.2);
      if (d < 40) car.indicator = 1;
      if (d < 1 && car.speed < 0.3) {
        ai.dwell = 10 + rnd() * 8;
        ai.busServed = st;
        ctx.peds?.transitArrive?.(st, car);
      }
      return d < 35 ? shift : 0;
    }
    return 0;
  }

  // ---------------------------------------------------------------- population

  manage(focus) {
    const tr = this.traffic;
    // trams: despawn far ones / ones stuck at the end of the mapped network
    for (const car of this.trams.slice()) {
      if (car.destroyed || car.mode !== 'ai') {
        this.trams.splice(this.trams.indexOf(car), 1); // carjacked or removed: no longer ours
        continue;
      }
      const p = car.body.translation();
      const d = Math.hypot(p.x - focus.x, p.z - focus.z);
      if ((d > 750 || car.rail.end || car.rail.stuck > 40) && !tr.inView(p.x, p.z)) {
        this.trams.splice(this.trams.indexOf(car), 1);
        ctx.vehicles.remove(car);
      }
    }
    if (this.trams.length < TRAMS[ctx.quality]) this.spawnTram(focus, 200, 550, true);
    // buses
    const busKind = firstKind(['bus']);
    if (!busKind) return;
    let buses = 0;
    for (const car of ctx.vehicles.list.slice()) {
      if (car.mode !== 'ai' || car.ai?.role !== 'bus') continue;
      const p = car.body.translation();
      if ((Math.hypot(p.x - focus.x, p.z - focus.z) > 480 || car.ai.stuck > 45) && !tr.inView(p.x, p.z)) ctx.vehicles.remove(car);
      else buses++;
    }
    if (buses < BUSES[ctx.quality]) {
      const car = this.spawnBusNear(focus, busKind, true);
      if (car) {
        car.ai.transit = true;
        car.ai.v0f = 0.9;
      }
    }
  }

  update(dt, focus) {
    this.timer -= dt;
    if (this.timer <= 0) {
      this.timer = 1;
      this.manage(focus);
    }
    for (const car of this.trams) if (car.mode === 'ai' && !car.destroyed) this.driveTram(car, dt);
  }
}
