/**
 * Drivable road graph built from OSM ways. Ways are split at every shared vertex so
 * junctions in the middle of a way are real graph nodes. Used by:
 *   - traffic AI (edge following, turning at junctions, signals)
 *   - GPS (A* shortest route, respecting one-way streets)
 *   - spawning (nearest road point, random road positions)
 * Pure JS: no three.js dependency, unit-tested in tests/roadNetwork.test.mjs.
 */
import { SpatialGrid, segDist, polylineLength } from '../core/math.js';

const key = (p) => `${Math.round(p[0])},${Math.round(p[1])}`;

export class RoadNetwork {
  /**
   * @param {Array<{pts: number[][], oneway?: number|boolean, speed: number, width: number, name?: string, cls?: number, lanes?: number}>} ways
   */
  constructor(ways) {
    this.nodes = []; // {id, x, z, key, out: [{edge, dir}]}
    this.nodeByKey = new Map();
    this.edges = []; // {id, a, b, pts, len, speed, width, oneway, name}
    this.segGrid = new SpatialGrid(40);

    // count vertex usage to find junctions
    const uses = new Map();
    for (const w of ways) {
      w.pts.forEach((p, i) => {
        const k = key(p);
        const end = i === 0 || i === w.pts.length - 1;
        uses.set(k, (uses.get(k) || 0) + (end ? 2 : 1));
      });
    }
    const nodeFor = (p) => {
      const k = key(p);
      let n = this.nodeByKey.get(k);
      if (!n) {
        n = { id: this.nodes.length, x: p[0], z: p[1], key: k, out: [] };
        this.nodes.push(n);
        this.nodeByKey.set(k, n);
      }
      return n;
    };
    for (const w of ways) {
      if (w.pts.length < 2) continue;
      let start = 0;
      for (let i = 1; i < w.pts.length; i++) {
        const last = i === w.pts.length - 1;
        if (!last && (uses.get(key(w.pts[i])) || 0) < 2) continue;
        const pts = w.pts.slice(start, i + 1);
        start = i;
        const len = polylineLength(pts);
        if (len < 0.5) continue;
        const a = nodeFor(pts[0]),
          b = nodeFor(pts[pts.length - 1]);
        if (a === b) continue;
        const e = {
          id: this.edges.length,
          a: a.id,
          b: b.id,
          pts,
          len,
          speed: w.speed,
          width: w.width,
          oneway: !!w.oneway,
          name: w.name || '',
          cls: w.cls ?? null,
          lanes: w.lanes || 0,
        };
        this.edges.push(e);
        a.out.push({ edge: e, dir: 1 });
        b.out.push({ edge: e, dir: -1, reverseOnly: e.oneway });
        for (let j = 0; j < pts.length - 1; j++) {
          const p = pts[j],
            q = pts[j + 1];
          this.segGrid.insert((p[0] + q[0]) / 2, (p[1] + q[1]) / 2, [e, j]);
        }
      }
    }
  }

  /** Outgoing moves from a node. With respectOneway, one-way edges can't be driven backwards. */
  moves(nodeId, respectOneway = true) {
    return this.nodes[nodeId].out.filter((m) => !(respectOneway && m.reverseOnly));
  }

  /** Edge points in travel direction. */
  static path(edge, dir) {
    return dir > 0 ? edge.pts : edge.pts.slice().reverse();
  }

  /** Nearest point on any edge within `max` metres: {edge, seg, t, s (distance from edge start), x, z, d}. */
  nearest(x, z, max = 80, filter = null) {
    let best = null;
    for (let r = 40; r <= max * 2 && !best; r *= 2) {
      let bd = Math.min(max, r);
      for (const [e, j] of this.segGrid.query(x, z, r)) {
        if (filter && !filter(e)) continue;
        const p = e.pts[j],
          q = e.pts[j + 1];
        const { d, t } = segDist(x, z, p[0], p[1], q[0], q[1]);
        if (d < bd) {
          bd = d;
          best = { edge: e, seg: j, t, d, x: p[0] + (q[0] - p[0]) * t, z: p[1] + (q[1] - p[1]) * t };
        }
      }
    }
    if (best) {
      let s = 0;
      for (let j = 0; j < best.seg; j++) s += Math.hypot(best.edge.pts[j + 1][0] - best.edge.pts[j][0], best.edge.pts[j + 1][1] - best.edge.pts[j][1]);
      const p = best.edge.pts[best.seg],
        q = best.edge.pts[best.seg + 1];
      best.s = s + Math.hypot(q[0] - p[0], q[1] - p[1]) * best.t;
    }
    return best;
  }

  /**
   * A* route between two world points. Returns {points: [[x,z]...], length} or null.
   * @param {boolean} respectOneway  false for walking routes
   */
  route(fx, fz, tx, tz, respectOneway = true) {
    const from = this.nearest(fx, fz, 400),
      to = this.nearest(tx, tz, 400);
    if (!from || !to) return null;
    if (from.edge === to.edge) {
      const forward = to.s >= from.s;
      if (forward || !(respectOneway && from.edge.oneway)) {
        return { points: this.slice(from.edge, from.s, to.s), length: Math.abs(to.s - from.s) };
      }
    }
    // virtual start: from the snapped point we can reach edge.b (forward) or edge.a (if two-way)
    const N = this.nodes.length;
    const g = new Float64Array(N).fill(Infinity);
    const prev = new Int32Array(N).fill(-1);
    const prevEdge = new Array(N);
    const open = new MinHeap();
    const goal = this.nodes;
    const h = (n) => Math.hypot(goal[n].x - to.x, goal[n].z - to.z);
    const fe = from.edge;
    const seed = (node, cost) => {
      if (cost < g[node]) {
        g[node] = cost;
        prev[node] = -2;
        open.push(node, cost + h(node));
      }
    };
    seed(fe.b, fe.len - from.s);
    if (!(respectOneway && fe.oneway)) seed(fe.a, from.s);
    // goal costs: reaching to.edge.a then driving forward s, or to.edge.b then backwards
    const te = to.edge;
    const goalA = to.s,
      goalB = te.len - to.s;
    const canEndFromB = !(respectOneway && te.oneway);
    let best = Infinity,
      bestEnd = -1;
    const closed = new Uint8Array(N);
    while (open.size) {
      const n = open.pop();
      if (closed[n]) continue;
      closed[n] = 1;
      if (g[n] >= best) break;
      if (n === te.a && g[n] + goalA < best) {
        best = g[n] + goalA;
        bestEnd = n;
      }
      if (n === te.b && canEndFromB && g[n] + goalB < best) {
        best = g[n] + goalB;
        bestEnd = n;
      }
      for (const m of this.nodes[n].out) {
        if (respectOneway && m.reverseOnly) continue;
        const nb = m.dir > 0 ? m.edge.b : m.edge.a;
        const c = g[n] + m.edge.len;
        if (c < g[nb]) {
          g[nb] = c;
          prev[nb] = n;
          prevEdge[nb] = m;
          open.push(nb, c + h(nb));
        }
      }
    }
    if (bestEnd < 0) return null;
    // rebuild
    const chain = [];
    for (let n = bestEnd; prev[n] >= 0; n = prev[n]) chain.push(prevEdge[n]);
    chain.reverse();
    const startNode = chain.length ? (chain[0].dir > 0 ? chain[0].edge.a : chain[0].edge.b) : bestEnd;
    const points = startNode === fe.b ? this.slice(fe, from.s, fe.len) : this.slice(fe, from.s, 0);
    for (const m of chain) points.push(...RoadNetwork.path(m.edge, m.dir).slice(1));
    points.push(...(bestEnd === te.a ? this.slice(te, 0, to.s) : this.slice(te, te.len, to.s)).slice(1));
    return { points, length: best };
  }

  /** Polyline of an edge between distances s0 and s1 (either direction). */
  slice(edge, s0, s1) {
    const pts = edge.pts;
    const at = (s) => {
      let acc = 0;
      for (let i = 0; i < pts.length - 1; i++) {
        const L = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
        if (acc + L >= s || i === pts.length - 2) {
          const t = L ? Math.min(1, Math.max(0, (s - acc) / L)) : 0;
          return { i, p: [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t] };
        }
        acc += L;
      }
      return { i: pts.length - 2, p: pts[pts.length - 1] };
    };
    const A = at(s0),
      B = at(s1);
    const out = [A.p];
    if (s1 >= s0) for (let i = A.i + 1; i <= B.i; i++) out.push(pts[i]);
    else for (let i = A.i; i > B.i; i--) out.push(pts[i]);
    out.push(B.p);
    return out;
  }

  /**
   * Point on an edge in travel direction `dir` at distance `s`, shifted `lat` metres to
   * the right of travel. Allocation-free when `out` is given. {x, z, yaw}
   */
  static pose(edge, dir, s, lat = 0, out = {}) {
    let cum = edge.cum;
    const pts = edge.pts;
    if (!cum) {
      cum = edge.cum = new Float64Array(pts.length);
      for (let i = 1; i < pts.length; i++) cum[i] = cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    }
    const L = cum[cum.length - 1];
    const f = Math.min(L, Math.max(0, dir > 0 ? s : L - s)); // distance from pts[0]
    let lo = 0,
      hi = pts.length - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (cum[mid] <= f) lo = mid;
      else hi = mid - 1;
    }
    const a = pts[lo],
      b = pts[lo + 1];
    const segL = cum[lo + 1] - cum[lo] || 1;
    const t = (f - cum[lo]) / segL;
    let dx = (b[0] - a[0]) / segL,
      dz = (b[1] - a[1]) / segL;
    if (dir < 0) {
      dx = -dx;
      dz = -dz;
    }
    // right of travel direction is (-dz, dx)
    out.x = a[0] + (b[0] - a[0]) * t - dz * lat;
    out.z = a[1] + (b[1] - a[1]) * t + dx * lat;
    out.yaw = Math.atan2(dx, dz);
    return out;
  }

  /**
   * Junction layout and German right-of-way at a node (cached):
   *   kind 'none' (bend / dead end), 'rvl' (rechts vor links between minor roads) or
   *   'priority' (Vorfahrtstraße: the two most important legs form the priority road).
   * legs: {edge, bearing (outwards from the node), rank, canArrive, canLeave, inDir, outDir}
   */
  junction(nodeId) {
    const node = this.nodes[nodeId];
    if (node.jn) return node.jn;
    const legs = [];
    for (const m of node.out) {
      const e = m.edge;
      const d = Math.min(6, e.len * 0.5);
      const p = RoadNetwork.pose(e, m.dir, d);
      legs.push({
        edge: e,
        bearing: Math.atan2(p.x - node.x, p.z - node.z),
        rank: roadRank(e.cls ?? classFromSpeed(e.speed)),
        canLeave: !m.reverseOnly,
        canArrive: !(e.oneway && m.dir > 0),
        outDir: m.dir,
        inDir: -m.dir,
      });
    }
    const byEdge = new Map(legs.map((l) => [l.edge.id, l]));
    const r = Math.max(4, ...legs.map((l) => l.edge.width / 2 + 1));
    const jn = { legs, byEdge, r, kind: 'none', major: new Set() };
    if (legs.length >= 3) {
      const top = legs.reduce((a, b) => (b.rank > a.rank ? b : a));
      if (top.rank <= 2) jn.kind = 'rvl';
      else {
        jn.kind = 'priority';
        let partner = null,
          best = -Infinity;
        for (const l of legs) {
          if (l === top) continue;
          const score = l.rank * 10 - Math.cos(l.bearing - top.bearing) * 3;
          if (score > best) {
            best = score;
            partner = l;
          }
        }
        jn.major.add(top.edge.id);
        jn.major.add(partner.edge.id);
      }
    }
    node.jn = jn;
    return jn;
  }

  /**
   * Must a vehicle arriving on edge `myIn` and leaving on `myOut` give way to one
   * arriving on `oIn` and leaving on `oOut` at node `nodeId`?
   * Applies the StVO: lights (only the left-turn rule then), Vorfahrtstraße, rechts vor
   * links; only when the two movements actually cross or merge.
   */
  yieldsTo(nodeId, myIn, myOut, oIn, oOut, signalised = false) {
    if (myIn === oIn) return false;
    const J = this.junction(nodeId);
    if (J.kind === 'none' && !signalised) return false;
    const me = J.byEdge.get(myIn.id ?? myIn),
      meOut = J.byEdge.get(myOut.id ?? myOut),
      o = J.byEdge.get(oIn.id ?? oIn),
      oOutL = J.byEdge.get(oOut.id ?? oOut);
    if (!me || !meOut || !o || !oOutL) return false;
    const rel = wrap(o.bearing - (me.bearing + Math.PI));
    const myTurn = turnKind(me.bearing + Math.PI, meOut.bearing),
      oTurn = turnKind(o.bearing + Math.PI, oOutL.bearing);
    const fromRight = rel < -0.45 && rel > -2.7;
    const opposite = Math.abs(rel) < 0.75;
    const leftTurnRule = (myTurn === 'L' || myTurn === 'U') && opposite && oTurn !== 'L' && oTurn !== 'U';
    let pri;
    if (signalised) pri = leftTurnRule;
    else if (J.kind === 'priority') {
      const mM = J.major.has(me.edge.id),
        oM = J.major.has(o.edge.id);
      if (oM && !mM) pri = true;
      else if (mM && !oM) pri = false;
      else if (mM && oM) pri = !J.major.has(meOut.edge.id) && (myTurn === 'L' || myTurn === 'U') && oTurn !== 'L';
      else pri = fromRight || leftTurnRule;
    } else pri = fromRight || leftTurnRule;
    return pri && movementsConflict(J, me, meOut, o, oOutL);
  }

  /** A random edge, optionally weighted towards faster roads. */
  randomEdge(rng, minLen = 30) {
    for (let t = 0; t < 60; t++) {
      const e = this.edges[Math.floor(rng() * this.edges.length)];
      if (e.len >= minLen) return e;
    }
    return this.edges[0];
  }
}

/** Binary min-heap keyed by priority. */
class MinHeap {
  constructor() {
    this.items = [];
    this.prio = [];
  }
  get size() {
    return this.items.length;
  }
  push(item, p) {
    const a = this.items,
      q = this.prio;
    a.push(item);
    q.push(p);
    let i = a.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (q[parent] <= q[i]) break;
      [a[i], a[parent]] = [a[parent], a[i]];
      [q[i], q[parent]] = [q[parent], q[i]];
      i = parent;
    }
  }
  pop() {
    const a = this.items,
      q = this.prio;
    const top = a[0];
    const lastI = a.pop(),
      lastP = q.pop();
    if (a.length) {
      a[0] = lastI;
      q[0] = lastP;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1,
          r = l + 1;
        let m = i;
        if (l < a.length && q[l] < q[m]) m = l;
        if (r < a.length && q[r] < q[m]) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        [q[i], q[m]] = [q[m], q[i]];
        i = m;
      }
    }
    return top;
  }
}

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/** Right-of-way rank of an OSM road class (see RC in config.js): higher wins. */
const CLASS_RANK = { 0: 7, 1: 6, 2: 5, 3: 4, 14: 4, 15: 4, 4: 3, 16: 3, 17: 3, 5: 2, 18: 1, 6: 1, 7: 0 };
export const roadRank = (cls) => CLASS_RANK[cls] ?? 1;

/** Best guess of the road class from the AI cruise speed (when ways carry no class). */
export function classFromSpeed(speed) {
  if (speed >= 13) return 2;
  if (speed >= 12) return 3;
  if (speed >= 10) return 4;
  if (speed >= 9) return 5;
  return 6;
}

/** Speed limit in m/s: Tempo 30 in residential streets, 50 km/h elsewhere in town. */
export function speedLimit(cls) {
  if (cls === 6 || cls === 5 || cls === 18 || cls === 7) return 30 / 3.6;
  if (cls === 0) return 80 / 3.6;
  if (cls === 1) return 60 / 3.6;
  return 50 / 3.6;
}

/** Travel lanes per direction of an edge (OSM lanes tag, otherwise from the width). */
export function lanesPerDir(edge) {
  if (edge.lanes > 0) return Math.max(1, Math.min(3, edge.oneway ? edge.lanes : Math.floor(edge.lanes / 2)));
  if (edge.oneway) return edge.width >= 8 ? 2 : 1;
  return edge.width >= 11 ? 2 : 1;
}

/**
 * Lateral offset (metres right of the travel direction, from the edge centre line)
 * of lane `lane` (0 = the right-most lane). parkL/parkR (in the edge's +1 frame)
 * narrow the carriageway where cars are parked at the kerb.
 */
export function laneLateral(edge, dir, lane, parkL = 0, parkR = 0) {
  const n = lanesPerDir(edge);
  const L = -edge.width / 2 + parkL,
    R = edge.width / 2 - parkR;
  const j = Math.min(n - 1, Math.max(0, lane));
  if (edge.oneway) {
    const w = (R - L) / n;
    return R - w * (j + 0.5);
  }
  const mid = (L + R) / 2;
  const w = Math.min(3.6, (R - mid) / n);
  // +1 lanes lie between mid and R; -1 lanes between L and mid (mirrored)
  return dir > 0 ? mid + w * (n - j - 0.5) : -(mid - w * (n - j - 0.5));
}

/** 'S' straight, 'L' left, 'R' right or 'U' (U-turn) from arrival to departure heading (yaw). */
export function turnKind(inYaw, outYaw) {
  const d = wrap(outYaw - inYaw);
  if (Math.abs(d) > 2.6) return 'U';
  if (d > 0.5) return 'L';
  if (d < -0.5) return 'R';
  return 'S';
}

/** Do two movements through a junction cross or merge? (straight-segment approximation) */
export function movementsConflict(J, inA, outA, inB, outB) {
  if (inA === inB) return false;
  if (outA === outB) return true;
  const r = J.r,
    lane = 1.6;
  const seg = (inL, outL) => {
    const h = inL.bearing + Math.PI; // arrival heading
    const ux = Math.sin(inL.bearing),
      uz = Math.cos(inL.bearing);
    const vx = Math.sin(outL.bearing),
      vz = Math.cos(outL.bearing);
    return [ux * r - Math.cos(h) * lane, uz * r + Math.sin(h) * lane, vx * r - Math.cos(outL.bearing) * lane, vz * r + Math.sin(outL.bearing) * lane];
  };
  const [ax, az, bx, bz] = seg(inA, outA);
  const [cx, cz, dx, dz] = seg(inB, outB);
  const d1x = bx - ax,
    d1z = bz - az,
    d2x = dx - cx,
    d2z = dz - cz;
  const den = d1x * d2z - d1z * d2x;
  if (Math.abs(den) < 1e-9) return false;
  const t = ((cx - ax) * d2z - (cz - az) * d2x) / den,
    u = ((cx - ax) * d1z - (cz - az) * d1x) / den;
  return t >= -0.05 && t <= 1.05 && u >= -0.05 && u <= 1.05;
}

// ---------------------------------------------------------------- city rhythm

let berlinFmt = null;
/** Weekday (0 = Sunday) and decimal hour in Frankfurt (Europe/Berlin), whatever the PC's time zone. */
export function frankfurtClock(date) {
  try {
    berlinFmt ??= new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });
    let wd = 'Mon',
      h = 0,
      m = 0;
    for (const p of berlinFmt.formatToParts(date)) {
      if (p.type === 'weekday') wd = p.value;
      else if (p.type === 'hour') h = +p.value;
      else if (p.type === 'minute') m = +p.value;
    }
    return { dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd), hour: (h % 24) + m / 60 };
  } catch {
    return { dow: date.getDay(), hour: date.getHours() + date.getMinutes() / 60 };
  }
}

// hourly traffic volume relative to the configured density (Berufsverkehr peaks 7–9 and 16–19)
const TRAFFIC_WEEKDAY = [0.3, 0.22, 0.2, 0.2, 0.25, 0.4, 0.7, 1.15, 1.25, 1.0, 0.88, 0.9, 0.95, 0.95, 0.92, 1.0, 1.15, 1.25, 1.2, 0.95, 0.75, 0.6, 0.5, 0.4];
const TRAFFIC_SAT = [0.4, 0.32, 0.25, 0.2, 0.2, 0.25, 0.35, 0.5, 0.65, 0.8, 0.9, 0.95, 1.0, 1.0, 0.95, 0.95, 0.9, 0.85, 0.8, 0.75, 0.65, 0.6, 0.55, 0.45];
const TRAFFIC_SUN = [0.45, 0.35, 0.28, 0.22, 0.2, 0.2, 0.25, 0.3, 0.35, 0.42, 0.5, 0.55, 0.58, 0.6, 0.6, 0.6, 0.6, 0.6, 0.58, 0.55, 0.5, 0.45, 0.4, 0.35];
// pedestrians: shops close at 20:00 and stay shut on Sundays
const PEDS_WEEKDAY = [0.15, 0.1, 0.07, 0.05, 0.05, 0.1, 0.3, 0.7, 0.9, 0.8, 0.85, 0.95, 1.1, 1.05, 0.95, 0.95, 1.0, 1.1, 1.05, 0.85, 0.65, 0.5, 0.35, 0.22];
const PEDS_SAT = [0.3, 0.22, 0.15, 0.08, 0.05, 0.06, 0.12, 0.25, 0.45, 0.75, 1.0, 1.15, 1.2, 1.2, 1.2, 1.15, 1.1, 1.0, 0.9, 0.75, 0.65, 0.55, 0.45, 0.38];
const PEDS_SUN = [0.3, 0.22, 0.15, 0.08, 0.05, 0.05, 0.08, 0.15, 0.25, 0.4, 0.55, 0.65, 0.7, 0.75, 0.75, 0.75, 0.72, 0.65, 0.55, 0.45, 0.35, 0.28, 0.22, 0.18];
const hourly = (table, hour) => {
  const h = ((hour % 24) + 24) % 24,
    i = Math.floor(h),
    f = h - i;
  return table[i] * (1 - f) + table[(i + 1) % 24] * f;
};

/** Traffic volume factor for a Frankfurt weekday (0 = Sunday) and hour. */
export const trafficFactor = (dow, hour) => hourly(dow === 0 ? TRAFFIC_SUN : dow === 6 ? TRAFFIC_SAT : TRAFFIC_WEEKDAY, hour);
/** Pedestrian volume factor for a Frankfurt weekday and hour. */
export const pedFactor = (dow, hour) => hourly(dow === 0 ? PEDS_SUN : dow === 6 ? PEDS_SAT : PEDS_WEEKDAY, hour);
/** Is this the weekday Berufsverkehr (rush hour)? */
export const isRushHour = (dow, hour) => dow >= 1 && dow <= 5 && ((hour >= 7 && hour < 9.5) || (hour >= 16 && hour < 19));
