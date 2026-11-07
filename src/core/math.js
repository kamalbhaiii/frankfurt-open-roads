/**
 * Pure math and 2D geometry helpers (no three.js dependency, unit-testable).
 * 2D points are [x, z] arrays in world metres.
 */

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const smooth = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
/** Wraps an angle to [-PI, PI]. */
export const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
/** Moves angle `a` towards `b` by fraction t along the shortest arc. */
export const lerpAngle = (a, b, t) => a + wrapAngle(b - a) * t;
/** Frame-rate independent exponential smoothing factor. */
export const damp = (rate, dt) => 1 - Math.exp(-rate * dt);

/** Deterministic Park–Miller PRNG. */
export function createRng(seed = 1337) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  const next = () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
  next.pick = (arr) => arr[Math.floor(next() * arr.length)];
  next.range = (a, b) => a + (b - a) * next();
  return next;
}
export const rnd = createRng(1337);

/** Stable hash of a number to [0, 1). */
export const hash = (n) => {
  const x = Math.sin(n * 127.1) * 43758.5453;
  return x - Math.floor(x);
};

/** Signed polygon area (positive = counter-clockwise in x/z). */
export function area(ring) {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

/** Point-in-polygon (even-odd rule). */
export function pip(x, z, ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}

/** Drops the duplicated closing vertex of a ring. */
export function openRing(ring) {
  const o = ring.slice();
  if (o.length > 1 && Math.hypot(o[0][0] - o[o.length - 1][0], o[0][1] - o[o.length - 1][1]) < 0.5) o.pop();
  return o;
}

export function bounds(ring) {
  let minx = Infinity,
    maxx = -Infinity,
    minz = Infinity,
    maxz = -Infinity;
  for (const p of ring) {
    if (p[0] < minx) minx = p[0];
    if (p[0] > maxx) maxx = p[0];
    if (p[1] < minz) minz = p[1];
    if (p[1] > maxz) maxz = p[1];
  }
  return { minx, maxx, minz, maxz };
}

/** Offsets a polyline sideways by `o` metres (positive = left of travel in x/z). */
export function offsetLine(pts, o) {
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const dx = b[0] - a[0],
      dz = b[1] - a[1];
    const l = Math.hypot(dx, dz) || 1;
    return [p[0] - (dz / l) * o, p[1] + (dx / l) * o];
  });
}

export function polylineLength(pts) {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return len;
}

/** Distance from point to segment, plus the clamped parameter t. */
export function segDist(x, z, ax, az, bx, bz) {
  const dx = bx - ax,
    dz = bz - az;
  const l2 = dx * dx + dz * dz || 1;
  const t = clamp(((x - ax) * dx + (z - az) * dz) / l2, 0, 1);
  return { d: Math.hypot(x - ax - dx * t, z - az - dz * t), t };
}

/** Point and heading at distance s along a polyline. */
export function pointAlong(pts, s) {
  let acc = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i],
      b = pts[i + 1];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (acc + L >= s || i === pts.length - 2) {
      const t = L > 0 ? clamp((s - acc) / L, 0, 1) : 0;
      return { x: a[0] + (b[0] - a[0]) * t, z: a[1] + (b[1] - a[1]) * t, dx: (b[0] - a[0]) / (L || 1), dz: (b[1] - a[1]) / (L || 1) };
    }
    acc += L;
  }
  const p = pts[pts.length - 1];
  return { x: p[0], z: p[1], dx: 0, dz: 1 };
}

/** Uniform grid for fast spatial lookup of items with x/z. */
export class SpatialGrid {
  constructor(cell = 50) {
    this.cell = cell;
    this.map = new Map();
  }
  key(x, z) {
    return `${Math.floor(x / this.cell)},${Math.floor(z / this.cell)}`;
  }
  insert(x, z, item) {
    const k = this.key(x, z);
    let list = this.map.get(k);
    if (!list) this.map.set(k, (list = []));
    list.push(item);
  }
  /** Iterates items in cells overlapping the radius around (x, z). */
  *query(x, z, r) {
    const c = this.cell;
    const x0 = Math.floor((x - r) / c),
      x1 = Math.floor((x + r) / c);
    const z0 = Math.floor((z - r) / c),
      z1 = Math.floor((z + r) / c);
    for (let i = x0; i <= x1; i++) {
      for (let j = z0; j <= z1; j++) {
        const list = this.map.get(`${i},${j}`);
        if (list) yield* list;
      }
    }
  }
}

/** Formats a money amount the way the HUD shows it. */
export const formatMoney = (v) => `€${Math.round(v).toLocaleString('de-DE')}`;
/** mm:ss */
export const formatClock = (sec) => {
  const s = Math.max(0, Math.ceil(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
