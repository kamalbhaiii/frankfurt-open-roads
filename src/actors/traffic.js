/**
 * Ambient traffic with German road rules. Kinematic AI vehicles follow the road graph:
 *   - keep right; multi-lane roads use every lane, with gap-checked lane changes
 *   - Tempo 30 in residential streets, 50 km/h elsewhere; smooth IDM car following (~1.8 s headway)
 *   - traffic lights with stop lines, amber decisions and a start-up reaction delay
 *   - unsignalised junctions: Vorfahrtstraße by road class, rechts vor links between minor
 *     roads, left turns yield to oncoming traffic, never block the junction box
 *   - stop for pedestrians at zebra crossings and for people crossing while turning
 *   - no U-turns except at dead ends; overtaking of double-parked vans / cyclists when clear
 *   - rush hour by Frankfurt time, lighter traffic at night, on Sundays and in the rain
 *   - cyclists, delivery vans, refuse trucks, emergency vehicles (others pull over)
 *   - dense kerbside parking (kinematic until the player comes close, then real physics cars)
 * Far vehicles are updated less often (AI LOD). Public transport lives in transit.js.
 */
import * as THREE from 'three';
import { ctx } from '../core/context.js';
import { QUALITY } from '../core/config.js';
import { rnd, clamp, lerp, wrapAngle, damp, hash, SpatialGrid } from '../core/math.js';
import { settings } from '../core/settings.js';
import {
  RoadNetwork,
  roadRank,
  speedLimit,
  classFromSpeed,
  lanesPerDir,
  laneLateral,
  turnKind,
  movementsConflict,
  frankfurtClock,
  trafficFactor,
} from '../world/roadNetwork.js';
import { pickKind } from './vehicles.js';
import { Transit } from './transit.js';

const UP = new THREE.Vector3(0, 1, 0);
const FWD = new THREE.Vector3(0, 0, 1);
const _q = new THREE.Quaternion(),
  _q2 = new THREE.Quaternion();
const _v1 = new THREE.Vector3(),
  _v2 = new THREE.Vector3();
const SPAWN_MIN = 140,
  SPAWN_MAX = 340,
  DESPAWN = 460;
const LOD_DIST = 240; // beyond this, AI runs every third step
const PARK_BUDGET = { low: 14, medium: 28, high: 42, ultra: 56 };
const PARK_RADIUS = { low: 85, medium: 115, high: 145, ultra: 175 };
const PARK_CLASS = { 6: 0.86, 5: 0.7, 4: 0.5, 3: 0.28 };
const _p0 = {},
  _p1 = {},
  _p1b = {},
  _p2 = {},
  _pose = {};

/** Is a vehicle kind available (model loaded)? Works before and after the vehicle-type registry lands. */
export function kindAvailable(kind) {
  if (!kind) return false;
  if (ctx.models?.[`car_${kind}`]) return true;
  try {
    if (typeof ctx.vehicles?.hasKind === 'function') return !!ctx.vehicles.hasKind(kind);
    if (ctx.vehicles?.types?.[kind]) return true;
  } catch {}
  return false;
}
/** First available kind of a list of candidate names (agent-defined names vary). */
export const firstKind = (names) => names.find(kindAvailable) || null;

/** Spawns a vehicle, returning null instead of throwing when the kind can't be built. */
export function spawnVehicle(kind, x, z, yaw, mode, opts) {
  try {
    const car = ctx.vehicles.spawn(kind, x, z, yaw, mode, opts);
    if (car.kind !== kind) {
      ctx.vehicles.remove(car);
      return null;
    }
    return car;
  } catch {
    return null;
  }
}

const KINDS = {
  bike: ['bicycle', 'bike', 'cyclist'],
  truck: ['truck', 'lorry', 'box_truck'],
  refuse: ['refuse', 'refuse_truck', 'garbage', 'garbage_truck', 'bin_lorry'],
  ambulance: ['ambulance', 'rtw'],
  fire: ['fire', 'firetruck', 'fire_engine', 'fireengine'],
};

/** IDM acceleration towards a leader `gap` metres ahead moving at `vl`. */
function idm(v, v0, gap, vl, T, a, b, s0) {
  const ss = s0 + Math.max(0, v * T + (v * (v - vl)) / (2 * Math.sqrt(a * b)));
  return a * (1 - Math.pow(v / Math.max(v0, 0.1), 4) - (ss / Math.max(gap, 0.1)) ** 2);
}

export class Traffic {
  constructor() {
    this.timer = 0;
    this.ready = false;
    this.step = 0;
    this.factor = 1;
    this.clock = { dow: 1, hour: 12 };
    this.buckets = new Map();
    this.jn = new Map();
    this.parked = new Set();
    this.crossings = [];
    this.evTimer = 120;
    this.stats = { cars: 0, parked: 0, bikes: 0, trams: 0, buses: 0, ms: 0, msAvg: 0 };
    this.transit = new Transit(this);
    ctx.transit = this.transit;
  }

  get target() {
    const district = ctx.player?.position && ctx.game?.district(ctx.player.position);
    // Keep a modest daytime traffic uplift around the station and retail core;
    // these districts draw workers, visitors and shoppers beyond their residents.
    const localFlow =
      ['Innenstadt', 'Bahnhofsviertel'].includes(district) && this.clock.hour >= 7 && this.clock.hour < 21 ? 1.08 : 1;
    return Math.round(QUALITY[ctx.quality].traffic * settings.get('trafficDensity') * this.factor * localFlow);
  }

  aiCars() {
    return ctx.vehicles.list.filter((c) => c.mode === 'ai' && c.ai && !c.ai.transit);
  }

  // ---------------------------------------------------------------- one-off preparation

  /** Annotates the road graph (class, lanes, crossings, parking slots). Idempotent. */
  prepare() {
    if (this.ready) return;
    this.ready = true;
    const roads = ctx.roads;
    // match edges back to their OSM ways (shared vertices) for class/lanes/bridge
    const segKey = (p, q) => `${p[0]},${p[1]}|${q[0]},${q[1]}`;
    const byKey = new Map();
    for (const r of ctx.city?.roads || []) for (let i = 0; i < r.pts.length - 1; i++) byKey.set(segKey(r.pts[i], r.pts[i + 1]), r);
    for (const e of roads.edges) {
      const r = byKey.get(segKey(e.pts[0], e.pts[1]));
      if (e.cls == null) e.cls = r ? r.c : classFromSpeed(e.speed);
      if (!e.lanes && r?.lanes) e.lanes = r.lanes;
      e.bridge = !!r?.bridge;
      e.rank = roadRank(e.cls);
      e.limit = speedLimit(e.cls);
      e.nLanes = lanesPerDir(e);
      e.parkL = e.parkR = 0;
      e.cross = [];
      e.busStops = [];
      e.endYaw = [RoadNetwork.pose(e, -1, e.len - 0.5).yaw, RoadNetwork.pose(e, 1, e.len - 0.5).yaw];
    }
    // signalised nodes
    for (const n of roads.nodes) n.signal = !!ctx.furniture?.signalByKey?.get(n.key);
    // pedestrian crossings (zebra or signal-controlled Fußgängerfurt)
    const sigs = ctx.furniture?.signals || [];
    this.crossGrid = new SpatialGrid(40);
    for (const [x, z, ang, w] of ctx.streets?.cross || []) {
      const c = { x, z, ang, w, sig: null, g: 0, waiting: 0, on: 0, edge: null, s: 0 };
      let bd = 30;
      for (const s of sigs) {
        const d = Math.hypot(s.x - x, s.z - z);
        if (d < bd) {
          // group of the approach running along the crossed road
          const a = s.appr.find((ap) => Math.abs(Math.cos(ap.ang - ang)) > 0.7);
          if (a) {
            bd = d;
            c.sig = s;
            c.g = a.g;
          }
        }
      }
      const hit = roads.nearest(x, z, 6);
      if (hit) {
        c.edge = hit.edge;
        c.s = hit.s;
        hit.edge.cross.push(c);
      }
      this.crossings.push(c);
      this.crossGrid.insert(x, z, c);
    }
    this.transit.build();
    this.buildParking();
  }

  /** Kerbside parking slots along residential and side streets. */
  buildParking() {
    const roads = ctx.roads;
    const lampGrid = new SpatialGrid(20);
    for (const [x, z] of ctx.streets?.lamps || []) lampGrid.insert(x, z, [x, z]);
    for (const p of ctx.furniture?.poles || []) lampGrid.insert(p.x, p.z, [p.x, p.z]);
    const railGrid = this.transit.railGrid;
    this.slotGrid = new SpatialGrid(60);
    this.slots = [];
    const spawn = ctx.spawn || { x: 1e9, z: 1e9 };
    for (const e of roads.edges) {
      const prob = PARK_CLASS[e.cls];
      if (!prob || e.bridge || e.len < 22) continue;
      const need = e.oneway ? 3.2 : 5.2;
      let free = e.width - need;
      // sides: right then left (in the edge's +1 frame); on-road (2.1 m) or half on the kerb (1.0 m)
      const sides = [];
      for (const side of hash(e.id * 3.1) < 0.5 ? [1, -1] : [-1, 1]) {
        if (free >= 2.1 && e.cls !== 6) {
          sides.push({ side, kerb: false });
          free -= 2.1;
        } else if (free >= 1.0 && (e.cls === 6 || e.cls === 5)) {
          sides.push({ side, kerb: true });
          free -= 1.0;
        }
      }
      if (!sides.length) continue;
      const nA = roads.nodes[e.a],
        nB = roads.nodes[e.b];
      const endA = (nA.out.length >= 3 ? roads.junction(nA.id).r : 0) + 7,
        endB = (nB.out.length >= 3 ? roads.junction(nB.id).r : 0) + 7;
      for (const { side, kerb } of sides) {
        const lat = side * (kerb ? e.width / 2 + 0.05 : e.width / 2 - 1.15);
        if (side > 0) e.parkR = kerb ? 1.0 : 2.1;
        else e.parkL = kerb ? 1.0 : 2.1;
        for (let s = endA + 3; s < e.len - endB - 3; s += 5.8) {
          const h = hash(e.id * 17.3 + s * 0.71 + side);
          if (h < 0.1) continue; // driveway (Einfahrt) gap
          if (e.cross.some((c) => Math.abs(c.s - s) < c.w / 2 + 6)) continue;
          if (e.busStops.some((b) => Math.abs(b.s - s) < 18)) continue;
          // German parking: in the driving direction of that side
          const p = RoadNetwork.pose(e, 1, s, lat);
          const yaw = side > 0 ? p.yaw : wrapAngle(p.yaw + Math.PI);
          if (Math.hypot(p.x - spawn.x, p.z - spawn.z) < 60) continue;
          let blocked = false;
          for (const L of lampGrid.query(p.x, p.z, 4)) if (Math.hypot(L[0] - p.x, L[1] - p.z) < 3.0) blocked = true;
          for (const r of railGrid.query(p.x, p.z, 12)) if (Math.hypot(r[0] - p.x, r[1] - p.z) < 3.5) blocked = true;
          if (blocked) continue;
          const slot = { x: p.x, z: p.z, yaw, kerb, side, edge: e, s, car: null, want: hash(e.id * 7.7 + s * 1.37 + side * 3) < prob, seed: h };
          this.slots.push(slot);
          this.slotGrid.insert(p.x, p.z, slot);
        }
      }
    }
  }

  // ---------------------------------------------------------------- spawning

  /** Picks the next edge at the end node: German drivers don't U-turn except at dead ends. */
  chooseNext(ai) {
    const roads = ctx.roads;
    const nodeId = ai.dir > 0 ? ai.edge.b : ai.edge.a;
    if (ai.role === 'bus' && ai.busRoute) {
      const routed = this.transit.nextBusMove(ai, nodeId, this);
      if (routed) return routed;
    }
    const J = roads.junction(nodeId);
    const inLeg = J.byEdge.get(ai.edge.id);
    const opts = [];
    let total = 0;
    for (const m of roads.moves(nodeId, true)) {
      if (m.edge === ai.edge || m.edge.speed <= 0) continue;
      const out = J.byEdge.get(m.edge.id);
      const turn = inLeg && out ? turnKind(inLeg.bearing + Math.PI, out.bearing) : 'S';
      if (turn === 'U') continue;
      const rk = m.edge.rank ?? 1;
      let w = 1 + (rk >= (ai.edge.rank ?? 1) ? 2 : 0) + (turn === 'S' ? 1.5 : 0);
      if (ai.role === 'bus' || ai.role === 'ev') w *= rk >= 3 ? 4 : 0.15;
      else if (ai.role === 'bike') w *= rk >= 5 ? 0.15 : rk <= 2 ? 2 : 1;
      else if (ai.role === 'refuse') w *= rk <= 2 ? 5 : 0.3;
      opts.push({ edge: m.edge, dir: m.dir, turn, w });
      total += w;
    }
    if (opts.length) {
      let r = rnd() * total;
      for (const o of opts) if ((r -= o.w) <= 0) return o;
      return opts[0];
    }
    if (!ai.edge.oneway) return { edge: ai.edge, dir: -ai.dir, turn: 'U' }; // dead end: turn round
    return null;
  }

  turnFor(ai, edge, dir, nodeId) {
    const J = ctx.roads.junction(nodeId);
    const inLeg = J.byEdge.get(ai.edge.id), out = J.byEdge.get(edge.id);
    return inLeg && out ? turnKind(inLeg.bearing + Math.PI, out.bearing) : 'S';
  }

  /** Lateral position (right of travel) the vehicle aims for on (edge, dir, lane). */
  laneLat(ai, edge, dir, lane) {
    if (ai.role === 'bike') {
      const kerb = edge.width / 2 - (dir > 0 ? edge.parkR : edge.parkL);
      return kerb - 0.75;
    }
    return laneLateral(edge, dir, lane, edge.parkL, edge.parkR);
  }

  place(car, edge, dir, s, role = 'car') {
    const lane = Math.floor(rnd() * edge.nLanes);
    const ai = {
      edge,
      dir,
      s,
      next: null,
      role,
      lane,
      lat: 0,
      latT: 0,
      latX: 0, // extra lateral shift (overtaking, pull over, kerb stops)
      v0f: role === 'bike' ? 0.42 + rnd() * 0.12 : 0.9 + rnd() * 0.16,
      T: 1.5 + rnd() * 0.6,
      seed: rnd(),
      committed: -1,
      jnNode: -1,
      held: false,
      wait: 0,
      react: 0,
      stuck: 0,
      lod: 0,
      lodDt: 0,
    };
    ai.lat = ai.latT = this.laneLat(ai, edge, dir, lane);
    car.ai = ai;
    this.planNext(ai);
    const p = RoadNetwork.pose(edge, dir, s, ai.lat);
    car.yaw = p.yaw;
    car.speed = Math.min(edge.limit ?? edge.speed, 8) * 0.8;
    car.body.setTranslation({ x: p.x, y: car.H0 + 0.035, z: p.z }, true);
    _q.setFromAxisAngle(UP, p.yaw);
    car.body.setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w }, true);
  }

  planNext(ai) {
    ai.next = this.chooseNext(ai);
    ai.committed = -1;
    ai.held = false;
    ai.wait = 0;
    ai.lastSig = null;
    ai.react = 0;
    if (ai.next) {
      const n = ai.next;
      ai.nextLane = n.turn === 'R' ? 0 : n.turn === 'L' ? n.edge.nLanes - 1 : Math.min(ai.lane, n.edge.nLanes - 1);
    }
  }

  spawnAt(edge, dir, s, kind = pickKind(), role = 'car') {
    const p = RoadNetwork.pose(edge, dir, s);
    const car = spawnVehicle(kind, p.x, p.z, p.yaw, 'ai') || ctx.vehicles.spawn(pickKind(['police']), p.x, p.z, p.yaw, 'ai');
    this.place(car, edge, dir, s, role);
    if (car.isPolice) car.patrol = true;
    if (role === 'bike' && car.driver?.actions?.cycling) car.driver.play('cycling', 0);
    return car;
  }

  /** Initial population spread across the network around a point. */
  populate(center) {
    this.prepare();
    this.updateClock();
    for (let i = 0; i < this.target; i++) this.trySpawnNear(center, 30, SPAWN_MAX, false);
    this.manageParking(center, true);
    this.transit.populate(center);
  }

  trySpawnNear(center, rMin, rMax, avoidView = true, kind = null, role = 'car') {
    this.prepare();
    const roads = ctx.roads;
    const filter =
      role === 'bike'
        ? (e) => e.rank <= 4 && e.len > 25 && !e.bridge
        : role === 'bus' || role === 'ev'
          ? (e) => e.rank >= 3 && e.len > 40
          : (e) => e.speed >= 8 && e.len > 25;
    for (let t = 0; t < 12; t++) {
      const a = rnd() * Math.PI * 2,
        r = lerp(rMin, rMax, rnd());
      const x = center.x + Math.cos(a) * r,
        z = center.z + Math.sin(a) * r;
      const hit = roads.nearest(x, z, 60, filter);
      if (!hit) continue;
      if (avoidView && this.inView(hit.x, hit.z)) continue;
      const dir = hit.edge.oneway ? 1 : rnd() < 0.5 ? 1 : -1;
      const s = dir > 0 ? hit.s : hit.edge.len - hit.s;
      if (this.occupied(hit.x, hit.z, 12)) continue;
      return this.spawnAt(hit.edge, dir, clamp(s, 2, hit.edge.len - 2), kind || this.pickTrafficKind(), role);
    }
    return null;
  }

  pickTrafficKind() {
    const { dow, hour } = this.clock;
    if (dow >= 1 && dow <= 6 && hour > 6 && hour < 19 && rnd() < 0.05) {
      const t = firstKind(KINDS.truck);
      if (t) return t;
    }
    return pickKind();
  }

  occupied(x, z, r) {
    for (const c of ctx.vehicles.grid.query(x, z, r)) {
      if (c.destroyed) continue;
      const p = c.body.translation();
      if (Math.hypot(p.x - x, p.z - z) < r) return true;
    }
    return false;
  }

  inView(x, z) {
    const cam = ctx.camera;
    const v = _v1.set(x, 1, z).project(cam);
    return v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1 && cam.position.distanceTo(_v2.set(x, 1, z)) < 260;
  }

  updateClock() {
    const date = ctx.env?.date;
    if (!date) return;
    this.clock = frankfurtClock(date);
    const rain = ctx.env.weather?.rain || 0;
    // a little more traffic in the rain (people take the car), clamped
    this.factor = clamp(trafficFactor(this.clock.dow, this.clock.hour) * (1 + rain * 0.1), 0.15, 1.3);
  }

  // ---------------------------------------------------------------- population management

  /** Population management (runs twice a second). */
  manage(focus) {
    this.updateClock();
    const ai = this.aiCars();
    let cars = 0,
      bikes = 0;
    for (const car of ai) {
      const p = car.body.translation();
      const d = Math.hypot(p.x - focus.x, p.z - focus.z);
      const stuckOut = car.ai.stuck > 45 && !this.inView(p.x, p.z);
      const evDone = car.ai.role === 'ev' && (d > 420 || car.ai.life > 120) && !this.inView(p.x, p.z);
      if ((d > DESPAWN || stuckOut || evDone) && !car.persistent) {
        ctx.vehicles.remove(car);
        continue;
      }
      if (car.ai.role === 'bike') bikes++;
      else if (car.ai.role === 'car' || car.ai.role === 'delivery') cars++;
    }
    // abandoned parked cars far away are cleaned up as well
    for (const car of ctx.vehicles.list.slice()) {
      if (car.mode !== 'parked' || car.persistent || car === ctx.player.lastCar) continue;
      const p = car.body.translation();
      const d = Math.hypot(p.x - focus.x, p.z - focus.z);
      const mine = car.kerbSlot && !car.lastTouched;
      if ((d > DESPAWN + 150 || (mine && d > PARK_RADIUS[ctx.quality] + 70)) && !this.inView(p.x, p.z)) {
        if (car.kerbSlot) car.kerbSlot.car = null;
        this.parked.delete(car);
        ctx.vehicles.remove(car);
      }
    }
    for (let i = cars; i < this.target && i < cars + 3; i++) this.trySpawnNear(focus, SPAWN_MIN, SPAWN_MAX, true);
    // cyclists in daylight and dry weather
    const day = this.clock.hour > 6 && this.clock.hour < 21.5;
    const rain = ctx.env?.weather?.rain || 0;
    const bikeKind = firstKind(KINDS.bike);
    const bikeTarget = bikeKind ? Math.round(this.target * (day ? 0.15 : 0.04) * (1 - clamp(rain * 1.5, 0, 0.8))) : 0;
    if (bikes < bikeTarget) this.trySpawnNear(focus, SPAWN_MIN * 0.7, SPAWN_MAX * 0.8, true, bikeKind, 'bike');
    this.manageSpecials(focus, ai);
    this.manageParking(focus, false);
  }

  /** Delivery vans in second row, the morning refuse round, emergency vehicles. */
  manageSpecials(focus, ai) {
    const { dow, hour } = this.clock;
    const work = dow >= 1 && dow <= 6 && hour > 7 && hour < 19;
    // delivery vans stop with hazards for a while (Lieferverkehr in zweiter Reihe)
    if (work && rnd() < 0.08) {
      const vans = ai.filter((c) => c.kind === 'van' && c.ai.role === 'car' && !c.ai.deliver && c.ai.edge.rank <= 3 && c.ai.edge.len - c.ai.s > 50);
      const active = ai.filter((c) => c.ai.deliver).length;
      if (vans.length && active < 2) {
        const v = rnd.pick(vans);
        v.ai.role = 'delivery';
        v.ai.deliver = { s: v.ai.s + 20 + rnd() * 20, dur: 20 + rnd() * 35, t: 0 };
      }
    }
    // refuse collection in residential streets on weekday mornings
    const refuseKind = firstKind(KINDS.refuse);
    if (refuseKind && dow >= 1 && dow <= 5 && hour > 6 && hour < 11 && !ai.some((c) => c.ai.role === 'refuse') && rnd() < 0.1) {
      const car = this.trySpawnNear(focus, 120, 220, true, refuseKind, 'refuse');
      if (car) car.ai.v0f = 0.5;
    }
    // emergency vehicle with siren every few minutes
    this.evTimer -= 0.5;
    if (this.evTimer <= 0) {
      this.evTimer = 150 + rnd() * 200;
      const kind = firstKind(rnd() < 0.75 ? KINDS.ambulance : KINDS.fire) || firstKind(KINDS.ambulance) || 'police';
      const car = this.trySpawnNear(focus, 200, 300, true, kind, 'ev');
      if (car) {
        car.siren = true;
        car.patrol = false;
        car.ai.v0f = 1.3;
        car.ai.T = 1.0;
        car.ai.life = 0;
      }
    }
  }

  /** Fills kerbside slots near the player with (kinematic) parked cars. */
  manageParking(focus, initial) {
    if (!this.slotGrid) return;
    const R = PARK_RADIUS[ctx.quality],
      budget = PARK_BUDGET[ctx.quality];
    // release slots whose car is gone, moved or far away
    for (const car of [...this.parked]) {
      const slot = car.kerbSlot;
      if (car.destroyed) {
        this.parked.delete(car);
        if (slot) slot.car = null;
        continue;
      }
      const p = car.body.translation();
      if (slot && Math.hypot(p.x - slot.x, p.z - slot.z) > 3) {
        slot.car = null; // driven away / pushed: no longer this slot's car
        car.kerbSlot = null;
        this.parked.delete(car);
        continue;
      }
      if (car.mode === 'ai' && Math.hypot(p.x - focus.x, p.z - focus.z) > R + 40) {
        slot.car = null;
        this.parked.delete(car);
        ctx.vehicles.remove(car);
      }
    }
    if (this.parked.size >= budget) return;
    const cand = [];
    for (const slot of this.slotGrid.query(focus.x, focus.z, R)) {
      if (!slot.want || slot.car) continue;
      const d = Math.hypot(slot.x - focus.x, slot.z - focus.z);
      if (d < R) cand.push([d, slot]);
    }
    cand.sort((a, b) => a[0] - b[0]);
    let n = 0;
    for (const [d, slot] of cand) {
      if (this.parked.size >= budget || n >= (initial ? budget : 3)) break;
      if (!initial && d < 70 && this.inView(slot.x, slot.z)) continue;
      if (this.occupied(slot.x, slot.z, 3.2)) continue;
      const kind = pickKind(['police', 'taxi']);
      const car = spawnVehicle(kind, slot.x, slot.z, slot.yaw, 'ai', { driver: false });
      if (!car) continue;
      n++;
      car.kerbSlot = slot;
      car.ai = null;
      car.speed = 0;
      // parked cars have their lights off (restored when they become physics cars)
      car.savedLights = car.lights;
      car.lights = {};
      for (const k of ['headlight', 'taillight', 'indicator_L', 'indicator_R'])
        if (car.savedLights[k]) car.savedLights[k].emissiveIntensity = k === 'taillight' ? 0.05 : 0;
      if (slot.kerb) {
        // half up on the pavement (aufgesetztes Parken): roll towards the road
        _q.setFromAxisAngle(UP, slot.yaw);
        _q2.setFromAxisAngle(FWD, 0.09 * (slot.side > 0 ? 1 : -1) * (Math.cos(slot.yaw - RoadNetwork.pose(slot.edge, 1, slot.s).yaw) > 0 ? 1 : -1));
        _q.multiply(_q2);
        car.body.setTranslation({ x: slot.x, y: car.H0 + 0.11, z: slot.z }, true);
        car.body.setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w }, true);
      }
      slot.car = car;
      this.parked.add(car);
    }
  }

  /** Kinematic parked cars turn into real physics cars when something could touch them. */
  promoteParked() {
    if (!this.parked.size) return;
    const movers = [];
    const pp = ctx.player.position;
    movers.push([pp.x, pp.z, 14 + Math.abs(ctx.player.vehicle?.kmh || 0) / 3.6]);
    for (const c of ctx.vehicles.list) {
      if (c.mode !== 'pursuit' && c.mode !== 'player') continue;
      const p = c.body.translation();
      movers.push([p.x, p.z, 10 + Math.abs(c.kmh || 0) / 3.6]);
    }
    for (const car of this.parked) {
      if (car.mode !== 'ai' || car.destroyed) continue;
      const p = car.body.translation();
      for (const [x, z, r] of movers) {
        if (Math.abs(p.x - x) < r && Math.abs(p.z - z) < r && Math.hypot(p.x - x, p.z - z) < r) {
          if (car.savedLights) car.lights = car.savedLights;
          car.makeDynamic('parked');
          break;
        }
      }
    }
  }

  // ---------------------------------------------------------------- per-step AI

  update(dt, focus) {
    const t0 = performance.now();
    this.prepare();
    this.timer -= dt;
    if (this.timer <= 0) {
      this.timer = 0.5;
      this.manage(focus);
    }
    this.step++;
    this.promoteParked();
    // buckets of vehicles per (edge, direction) and per junction
    const buckets = this.buckets,
      jn = this.jn;
    buckets.clear();
    jn.clear();
    const active = [];
    for (const car of ctx.vehicles.list) {
      if (car.mode !== 'ai' || !car.ai || car.destroyed) continue;
      const ai = car.ai;
      active.push(car);
      const k = ai.edge.id * 2 + (ai.dir > 0 ? 1 : 0);
      let b = buckets.get(k);
      if (!b) buckets.set(k, (b = []));
      b.push(car);
      const rem = ai.edge.len - ai.s;
      if (ai.next && rem < 45) {
        const node = ai.dir > 0 ? ai.edge.b : ai.edge.a;
        this.jnPush(node, { car, inE: ai.edge, outE: ai.next.edge, dist: rem, eta: rem / Math.max(car.speed, 1), inside: ai.committed === node });
      }
      if (ai.jnNode >= 0 && ai.prevEdge && ai.s < 12) this.jnPush(ai.jnNode, { car, inE: ai.prevEdge, outE: ai.edge, dist: 0, eta: 0, inside: true });
    }
    const sirens = active.filter((c) => c.siren);
    const t = ctx.simTime;
    let n = 0;
    for (const car of active) {
      const ai = car.ai;
      const p = car.body.translation();
      // AI LOD: far cars think every third step with a longer dt
      const far = Math.abs(p.x - focus.x) + Math.abs(p.z - focus.z) > LOD_DIST * 1.2;
      ai.lodDt += dt;
      if (far && ((this.step + ai.seed * 3) | 0) % 3) continue;
      const step = Math.min(ai.lodDt, 0.1);
      ai.lodDt = 0;
      this.drive(car, step, p, t, sirens);
      n++;
    }
    this.transit.update(dt, focus);
    const ms = performance.now() - t0;
    const s = this.stats;
    s.ms = ms;
    s.msAvg = lerp(s.msAvg, ms, 0.02);
    s.cars = active.length;
    s.thinking = n;
    s.parked = this.parked.size;
    s.bikes = active.filter((c) => c.ai.role === 'bike').length;
    s.trams = this.transit.trams.length;
    s.buses = active.filter((c) => c.ai.role === 'bus').length;
  }

  jnPush(node, entry) {
    let l = this.jn.get(node);
    if (!l) this.jn.set(node, (l = []));
    l.push(entry);
  }

  /** Nearest vehicle ahead in the same (edge, dir) flow and on the planned next edge. */
  pathLeader(car, ai, res) {
    const myHalf = car.length / 2;
    const scan = (list, offset) => {
      if (!list) return;
      for (const o of list) {
        if (o === car) continue;
        const oa = o.ai;
        const ds = oa.s + offset - ai.s;
        if (ds <= 0 || ds > 80) continue;
        const latGap = Math.abs(oa.lat + oa.latX - (ai.lat + ai.latX));
        const extra = oa.role === 'bike' || ai.role === 'bike' ? 1.0 : 0.25;
        if (latGap > (car.width + o.width) / 2 + extra) continue;
        const gap = ds - myHalf - o.length / 2;
        if (gap < res.gap) {
          res.gap = gap;
          res.vl = o.speed;
          res.car = o;
        }
      }
    };
    scan(this.buckets.get(ai.edge.id * 2 + (ai.dir > 0 ? 1 : 0)), 0);
    if (ai.next) scan(this.buckets.get(ai.next.edge.id * 2 + (ai.next.dir > 0 ? 1 : 0)), ai.edge.len);
    // oncoming vehicle in my lane (overtaking)
    const opp = this.buckets.get(ai.edge.id * 2 + (ai.dir > 0 ? 0 : 1));
    if (opp)
      for (const o of opp) {
        const ds = ai.edge.len - o.ai.s - ai.s;
        if (ds <= 0 || ds > 60) continue;
        if (Math.abs(-(o.ai.lat + o.ai.latX) - (ai.lat + ai.latX)) > (car.width + o.width) / 2 + 0.2) continue;
        const gap = ds - myHalf - o.length / 2;
        if (gap < res.gap) {
          res.gap = gap;
          res.vl = -o.speed;
          res.car = o;
        }
      }
  }

  /** Geometric look-ahead for everything not in the lane flow (player, parked, crossing, trams, peds). */
  corridor(car, ai, p, fx, fz, res) {
    const halfW = car.width / 2;
    const myHalf = car.length / 2;
    const look = 10 + car.speed * 2.2;
    const test = (x, z, w, maxAhead, half, vl) => {
      const dx = x - p.x,
        dz = z - p.z;
      const ahead = dx * fx + dz * fz;
      if (ahead <= 0 || ahead > maxAhead) return;
      if (Math.abs(dx * fz - dz * fx) > halfW + w) return;
      const gap = ahead - myHalf - half;
      if (gap < res.gap) {
        res.gap = gap;
        res.vl = vl;
      }
    };
    const myEdge = ai.edge,
      nextEdge = ai.next?.edge;
    for (const o of ctx.vehicles.grid.query(p.x + fx * 10, p.z + fz * 10, 22)) {
      if (o === car || o.destroyed) continue;
      const oa = o.ai;
      if (oa && o.mode === 'ai' && (oa.edge === myEdge || oa.edge === nextEdge)) continue; // lane flow handles these
      const q = o.body.translation();
      const ofx = Math.sin(o.yaw),
        ofz = Math.cos(o.yaw);
      const cosH = fx * ofx + fz * ofz;
      if (o.mode === 'ai') {
        if (oa && cosH < -0.6) continue; // oncoming traffic stays in its lane
        const parkedStatic = !oa && !o.rail;
        const maxA = parkedStatic ? 8 : oa ? 13 : look;
        const vl = (o.speed || 0) * cosH;
        if (o.length > 7) {
          // long vehicles (trams, buses): sample along the body, plus where a tram will be shortly
          const half = o.length / 2;
          const reach = o.rail ? (o.speed || 0) * 2.5 : 0;
          for (let k = -half; k <= half + reach; k += 2.5) test(q.x + ofx * k, q.z + ofz * k, o.width / 2 + 0.3, Math.max(maxA, 18), 1.2, k > half ? 0 : vl);
        } else test(q.x, q.z, o.width / 2 + (parkedStatic ? 0.05 : 0.3), maxA, o.length / 2, vl);
      } else {
        const v = o.body.linvel();
        test(q.x, q.z, o.width / 2 + 0.35, look, o.length / 2, v.x * fx + v.z * fz);
      }
    }
    const pp = ctx.player.position;
    if (!ctx.player.vehicle) test(pp.x, pp.z, 0.5, 16, 0.3, 0);
    for (const pd of ctx.peds.near(p.x + fx * 8, p.z + fz * 8, 14)) if (!pd.down && !pd.inside) test(pd.x, pd.z, 0.6, 16, 0.3, 0);
  }

  drive(car, dt, p, t, sirens) {
    const ai = car.ai;
    const edge = ai.edge,
      roads = ctx.roads;
    const fx = Math.sin(car.yaw),
      fz = Math.cos(car.yaw);
    const rain = ctx.env?.weather?.rain || 0;
    const role = ai.role;
    const isEv = role === 'ev';
    ai.life = (ai.life || 0) + dt;

    // desired speed: limit, driver temperament, weather, turn ahead
    let v0 = (edge.limit ?? edge.speed) * ai.v0f * (1 - rain * 0.12);
    if (role === 'bike') v0 = 4.2 + ai.seed * 2.2;
    const remaining = edge.len - ai.s;
    const next = ai.next;
    const nodeId = ai.dir > 0 ? edge.b : edge.a;
    const node = roads.nodes[nodeId];
    const J = roads.junction(nodeId);
    const Rc = this.cornerR(J, edge, next);
    if (next) {
      const vt = next.turn === 'R' ? 4.5 : next.turn === 'L' ? 6 : next.turn === 'U' ? 2.2 : J.kind === 'none' ? this.bendSpeed(edge, next) : v0;
      v0 = Math.min(v0, Math.sqrt(vt * vt + 2 * 1.6 * Math.max(0, remaining - Rc)));
      car.indicator = next.turn !== 'S' && remaining < 40 && J.kind !== 'none' ? (next.turn === 'R' ? 1 : -1) : 0;
    } else car.indicator = 0;
    if (ai.prevTurn && ai.s < 6 && ai.prevTurn !== 'S') car.indicator = ai.prevTurn === 'R' ? 1 : -1;

    const T = ai.T * (1 + rain * 0.3);
    const A = role === 'bus' || role === 'refuse' ? 1.0 : role === 'bike' ? 0.9 : 1.5;
    const B = 2.4;
    let acc = A * (1 - Math.pow(car.speed / Math.max(v0, 0.1), 4));
    const stopAt = (d, s0 = 0.4) => {
      if (d < 60) acc = Math.min(acc, idm(car.speed, v0, Math.max(d, 0.05) + s0, 0, 0, A, B, s0));
    };

    // ---- leaders
    const res = { gap: Infinity, vl: 0, car: null };
    this.pathLeader(car, ai, res);
    const flowLeader = res.car;
    const flowGap = res.gap;
    this.corridor(car, ai, p, fx, fz, res);
    if (res.gap < 90) acc = Math.min(acc, idm(car.speed, v0, Math.max(res.gap, 0.05), res.vl, T, A, B, role === 'bike' ? 1.2 : 2.2));

    // ---- junction: lights, right of way, box clear
    ai.held = false;
    let holdReason = null;
    if (next && J.kind !== 'none' && ai.committed !== nodeId) {
      const sig = node.signal ? ctx.furniture.signalFor(node.key, edge.endYaw[ai.dir > 0 ? 1 : 0], t) : null;
      const dStop = remaining - (sig ? sig.stopDist : J.r) - car.length / 2 - 0.5;
      if (dStop < 45) {
        if (dStop < -1.5) ai.committed = nodeId;
        else {
          if (sig && !isEv) {
            if (sig.state === 2 || (sig.state === 1 && (car.speed * car.speed) / (2 * Math.max(dStop, 0.1)) < 3.8)) holdReason = 'signal';
            else if (ai.lastSig === 'signal') {
              if (car.speed < 0.5) ai.react = 0.5 + rnd() * 0.8; // Anfahren nach Grün
              ai.lastSig = null;
            }
          }
          if (ai.react > 0) {
            ai.react -= dt;
            holdReason ||= 'react';
          }
          if (!holdReason) holdReason = this.rightOfWay(car, ai, nodeId, J, !!sig, isEv);
          if (!holdReason && this.exitBlocked(car, ai)) holdReason = 'exit';
          if (isEv && holdReason !== 'box') holdReason = null;
          if (holdReason) {
            ai.held = true;
            stopAt(dStop);
          } else if (dStop < 0.6) {
            ai.committed = nodeId;
            // mark as inside for everyone deciding after us this step
            const l = this.jn.get(nodeId);
            const me = l?.find((e) => e.car === car);
            if (me) me.inside = true;
          }
        }
      }
      if (holdReason === 'signal') ai.lastSig = 'signal';
    }
    if (isEv && node.signal && remaining < 30) v0 = Math.min(v0, 7);
    ai.wait = ai.held && car.speed < 0.5 ? ai.wait + dt : 0;

    // ---- zebra crossings ahead (current and next edge)
    this.crossingsAhead(car, ai, edge, ai.dir, -ai.s, stopAt);
    if (next) this.crossingsAhead(car, ai, next.edge, next.dir, remaining, stopAt, 15);

    // ---- role specifics: bus stops, deliveries, refuse round
    let latX = 0;
    if (role === 'bus') latX = this.transit.busLogic(car, ai, dt, stopAt);
    else if (ai.deliver) latX = this.deliveryLogic(car, ai, dt, stopAt);
    else if (role === 'refuse') latX = this.refuseLogic(car, ai, dt, stopAt);

    // ---- emergency vehicles nearby: pull over to the right and slow down
    if (!isEv && sirens.length) {
      for (const ev of sirens) {
        const q = ev.body.translation();
        const dx = p.x - q.x,
          dz = p.z - q.z;
        const d = Math.hypot(dx, dz);
        if (d < 60 && Math.sin(ev.yaw) * fx + Math.cos(ev.yaw) * fz > 0.3) {
          latX = Math.max(latX, 1.1);
          v0 = Math.min(v0, 2.5);
          acc = Math.min(acc, A * (1 - Math.pow(car.speed / 2.5, 4)));
          car.indicator = 1;
        }
      }
    }
    if (isEv) latX = -0.9;

    // ---- overtaking stopped vans / slow cyclists on two-way streets when the oncoming lane is clear
    if (role !== 'bike' && !isEv && flowLeader && flowGap < 14) {
      const la = flowLeader.ai;
      const slow = la.role === 'bike' || la.deliver?.t > 0 || (la.role === 'refuse' && flowLeader.speed < 0.5) || (la.role === 'bus' && la.dwell > 0);
      ai.follow = slow ? (ai.follow || 0) + dt : 0;
      if (slow && ai.follow > 2 && !edge.oneway && edge.nLanes === 1 && remaining > 40 && this.oncomingClear(ai, 70)) ai.passing = flowLeader;
    } else if (!flowLeader) ai.follow = 0;
    if (ai.passing) {
      const la = ai.passing.ai;
      if (!la || la.edge !== edge || la.s < ai.s - ai.passing.length - 4 || remaining < 15) ai.passing = null;
      else latX = Math.min(latX, -(car.width + ai.passing.width) / 2 - 1.2 + Math.abs(la.lat + la.latX - ai.lat));
    }

    // ---- lane changes on multi-lane roads
    if (edge.nLanes > 1 && role !== 'bike' && !ai.passing) this.laneChoice(car, ai, remaining, flowLeader, flowGap, v0);

    // integrate speed
    acc = clamp(acc, -9, A);
    car.speed = Math.max(0, car.speed + acc * dt);
    if (car.speed < 0.05 && acc <= 0) car.speed = 0;
    ai.stuck = car.speed < 0.2 ? ai.stuck + dt : 0;
    ai.s += car.speed * dt;
    // lateral motion: lane target plus extra shift, at a speed-dependent rate
    ai.latT = this.laneLat(ai, edge, ai.dir, ai.lane);
    const rate = (0.3 + car.speed * 0.12) * dt;
    ai.lat += clamp(ai.latT - ai.lat, -rate, rate);
    ai.latX += clamp(latX - ai.latX, -rate * 1.4, rate * 1.4);

    // ---- pose: on the edge, or a Bézier round the corner into the next edge
    let pose;
    const lat = ai.lat + ai.latX;
    if (next && ai.s > edge.len - Rc && Rc > 0.5) {
      const R2 = Math.min(Rc, next.edge.len / 2);
      const u = (ai.s - (edge.len - Rc)) / (Rc + R2);
      const nLat = this.laneLat(ai, next.edge, next.dir, ai.nextLane ?? 0);
      if (u >= 1) {
        this.advance(car, ai.s - edge.len, nLat);
        pose = RoadNetwork.pose(ai.edge, ai.dir, ai.s, ai.lat + ai.latX, _pose);
      } else {
        const a0 = RoadNetwork.pose(edge, ai.dir, edge.len - Rc, lat, _p0);
        const a1 = RoadNetwork.pose(edge, ai.dir, edge.len, lat, _p1);
        const b1 = RoadNetwork.pose(next.edge, next.dir, 0, nLat, _p1b);
        const b2 = RoadNetwork.pose(next.edge, next.dir, R2, nLat, _p2);
        const cx = (a1.x + b1.x) / 2,
          cz = (a1.z + b1.z) / 2;
        const k = 1 - u;
        const x = k * k * a0.x + 2 * k * u * cx + u * u * b2.x;
        const z = k * k * a0.z + 2 * k * u * cz + u * u * b2.z;
        const dx = 2 * k * (cx - a0.x) + 2 * u * (b2.x - cx),
          dz = 2 * k * (cz - a0.z) + 2 * u * (b2.z - cz);
        pose = _pose;
        pose.x = x;
        pose.z = z;
        pose.yaw = Math.atan2(dx, dz);
      }
    } else {
      if (ai.s >= edge.len) this.advance(car, ai.s - edge.len, next ? this.laneLat(ai, next.edge, next.dir, ai.nextLane ?? 0) : ai.lat);
      pose = RoadNetwork.pose(ai.edge, ai.dir, ai.s, ai.lat + ai.latX, _pose);
    }
    if (car.speed > 0.05 || Math.abs(wrapAngle(pose.yaw - car.yaw)) > 0.02) car.yaw += wrapAngle(pose.yaw - car.yaw) * damp(10, dt);
    const nx = lerp(p.x, pose.x, damp(14, dt)),
      nz = lerp(p.z, pose.z, damp(14, dt));
    car.body.setNextKinematicTranslation({ x: nx, y: car.H0 + 0.035, z: nz });
    _q.setFromAxisAngle(UP, car.yaw);
    car.body.setNextKinematicRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w });
    car.braking = acc < -0.6 || (car.speed < 0.3 && ai.held);
    car.wheelSpin += (car.speed * dt) / (car.ud?.wheelRadius || 0.33);
    car.kmh = car.speed * 3.6;
    if (ai.deliver?.t > 0 || (role === 'refuse' && ai.stopT > 0)) car.indicator = 2;
    if (ai.laneBlink > 0) {
      ai.laneBlink -= dt;
      car.indicator = ai.laneDir;
    }

    // horn at a blocking player
    if (res.gap < 3 && car.speed < 0.5 && !ai.held) {
      ai.blocked = (ai.blocked || 0) + dt;
      const pp = ctx.player.position;
      if (ai.blocked > 4 && Math.hypot(pp.x - p.x, pp.z - p.z) < 14) {
        ctx.audio?.horn?.(p, 0.5);
        ai.blocked = -3;
      }
    } else ai.blocked = 0;
  }

  cornerR(J, edge, next) {
    if (!next) return 0;
    const base = J.kind === 'none' ? 5 : clamp(J.r + 1.5, 5, 12);
    return Math.min(base, edge.len / 2, next.edge.len / 2);
  }

  bendSpeed(edge, next) {
    const d = Math.abs(wrapAngle(RoadNetwork.pose(next.edge, next.dir, Math.min(4, next.edge.len)).yaw - edge.endYaw[next.dir > 0 ? 1 : 0]));
    return clamp(15 - d * 9, 4, 15);
  }

  /** German right of way at the junction ahead; returns a hold reason or null. */
  rightOfWay(car, ai, nodeId, J, signalised, isEv) {
    const list = this.jn.get(nodeId);
    if (!list) return null;
    const roads = ctx.roads;
    const myIn = ai.edge,
      myOut = ai.next.edge;
    const inL = J.byEdge.get(myIn.id),
      outL = J.byEdge.get(myOut.id);
    let blockers = 0,
      allStopped = true;
    for (const b of list) {
      if (b.car === car || b.inE === myIn) continue;
      const bIn = J.byEdge.get(b.inE.id),
        bOut = J.byEdge.get(b.outE.id);
      if (!bIn || !bOut || !inL || !outL) continue;
      if (b.inside) {
        if (movementsConflict(J, inL, outL, bIn, bOut)) return 'box';
        continue;
      }
      if (isEv) continue;
      if (b.car.ai?.held && b.car.speed < 0.5 && (signalised || b.car.ai.wait < ai.wait)) continue;
      if (b.eta > 5 || b.dist > 45) continue;
      if (b.car.ai?.role === 'ev' || roads.yieldsTo(nodeId, myIn, myOut, b.inE, b.outE, signalised)) {
        blockers++;
        if (b.car.speed > 0.4) allStopped = false;
      }
    }
    if (!blockers) return null;
    // everybody waits for everybody (four cars at a rechts-vor-links junction): the longest waiter goes
    if (allStopped && ai.wait > 3 + ai.seed * 2) return null;
    return 'yield';
  }

  /** Don't enter the junction if the exit is jammed (keep the box clear). */
  exitBlocked(car, ai) {
    const list = this.buckets.get(ai.next.edge.id * 2 + (ai.next.dir > 0 ? 1 : 0));
    if (!list) return false;
    for (const o of list)
      if (o !== car && o.ai.s < car.length + 2 && o.speed < 1.5 && Math.abs(o.ai.lat - this.laneLat(ai, ai.next.edge, ai.next.dir, ai.nextLane ?? 0)) < 2.2)
        return true;
    return false;
  }

  /** Stops for pedestrians waiting at / walking on crossings ahead on an edge. */
  crossingsAhead(car, ai, edge, dir, offset, stopAt, maxS = Infinity) {
    for (const c of edge.cross) {
      const sAlong = dir > 0 ? c.s : edge.len - c.s;
      if (sAlong > maxS) continue;
      const d = offset + sAlong - c.w / 2 - 1.2 - car.length / 2;
      if (d < -1 || d > 45) continue;
      const busy = c.sig ? c.on > 0 : c.on > 0 || c.waiting > 0;
      if (!busy) continue;
      // only brake if it is still possible to stop comfortably (otherwise the pedestrian waits)
      if (c.on === 0 && (car.speed * car.speed) / (2 * Math.max(d, 0.1)) > 4.5) continue;
      stopAt(d, 0.3);
    }
  }

  oncomingClear(ai, dist) {
    const opp = this.buckets.get(ai.edge.id * 2 + (ai.dir > 0 ? 0 : 1));
    if (!opp) return true;
    for (const o of opp) {
      const ds = ai.edge.len - o.ai.s - ai.s;
      if (ds > -5 && ds < dist) return false;
    }
    return true;
  }

  /** Lane selection on multi-lane roads: get in lane for turns, overtake slow traffic. */
  laneChoice(car, ai, remaining, leader, gap, v0) {
    const n = ai.edge.nLanes;
    ai.laneT = (ai.laneT || 0) - 1;
    if (ai.laneBlink > 0 || ai.laneT > 0) return;
    ai.laneT = 30 + ai.seed * 30; // re-think every ~half second
    let want = ai.lane;
    if (ai.next && remaining < 110 && remaining > 15) want = ai.next.turn === 'R' ? 0 : ai.next.turn === 'L' ? n - 1 : ai.lane;
    else if (leader && gap < 30 && leader.speed < v0 * 0.7 && remaining > 60) want = ai.lane + (ai.lane < n - 1 ? 1 : -1);
    else if (ai.lane > 0 && remaining > 80 && ai.seed < 0.6) want = ai.lane - 1; // Rechtsfahrgebot
    want = clamp(want, 0, n - 1);
    if (want === ai.lane) return;
    const step = want > ai.lane ? 1 : -1;
    const target = ai.lane + step;
    const lat = this.laneLat(ai, ai.edge, ai.dir, target);
    const list = this.buckets.get(ai.edge.id * 2 + (ai.dir > 0 ? 1 : 0)) || [];
    for (const o of list) {
      if (o === car) continue;
      if (Math.abs(o.ai.lat - lat) > 2) continue;
      const ds = o.ai.s - ai.s;
      if (ds > -12 - car.speed && ds < 10 + car.speed * 0.8) return; // gap too small
    }
    ai.lane = target;
    ai.laneBlink = 2.2;
    ai.laneDir = step > 0 ? -1 : 1; // towards the centre is a left change
  }

  deliveryLogic(car, ai, dt, stopAt) {
    const dv = ai.deliver;
    if (dv.t <= 0) {
      if (ai.edge.len - ai.s < 25) {
        ai.deliver = null;
        ai.role = 'car';
        return 0;
      }
      stopAt(dv.s - ai.s, 0.2);
      if (dv.s - ai.s < 1 && car.speed < 0.3) dv.t = dv.dur;
      return dv.s - ai.s < 25 ? 1.0 : 0;
    }
    dv.t -= dt;
    stopAt(0, 0);
    if (dv.t <= 0) {
      ai.deliver = null;
      ai.role = 'car';
    }
    return 1.0;
  }

  refuseLogic(car, ai, dt, stopAt) {
    if (ai.stopT > 0) {
      ai.stopT -= dt;
      stopAt(0, 0);
      if (ai.stopT <= 0) ai.nextStopS = ai.s + 20 + rnd() * 15;
      return 0.6;
    }
    if (ai.nextStopS == null || ai.nextStopS < ai.s - 5) ai.nextStopS = ai.s + 15 + rnd() * 15;
    if (ai.edge.rank <= 2 && ai.nextStopS < ai.edge.len - 15) {
      stopAt(ai.nextStopS - ai.s, 0.2);
      if (ai.nextStopS - ai.s < 1 && car.speed < 0.3) ai.stopT = 7 + rnd() * 6;
    }
    return 0.4;
  }

  advance(car, sOffset, nLat) {
    const ai = car.ai;
    const nxt = ai.next || this.chooseNext(ai);
    if (!nxt) {
      // dead-end one-way: start afresh somewhere out of sight
      const p = car.body.translation();
      if (!this.inView(p.x, p.z)) {
        const e = ctx.roads.randomEdge(rnd);
        this.place(car, e, 1, 1, ai.role);
      } else {
        ai.s = ai.edge.len;
        car.speed = 0;
      }
      return;
    }
    const node = ai.dir > 0 ? ai.edge.b : ai.edge.a;
    if (ai.busRoute) {
      const nextIndex = (ai.busRouteIndex + 1) % ai.busRoute.steps.length;
      const expected = ai.busRoute.steps[nextIndex];
      if (expected?.edge === nxt.edge && expected.dir === nxt.dir) ai.busRouteIndex = nextIndex;
    }
    ai.prevEdge = ai.edge;
    ai.prevTurn = nxt.turn;
    ai.jnNode = node;
    ai.edge = nxt.edge;
    ai.dir = nxt.dir;
    ai.s = sOffset;
    ai.lane = ai.nextLane ?? 0;
    ai.lat = nLat ?? this.laneLat(ai, ai.edge, ai.dir, ai.lane);
    ai.passing = null;
    ai.busServed = null;
    this.planNext(ai);
  }
}
