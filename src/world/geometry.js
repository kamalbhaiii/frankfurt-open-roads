/**
 * Procedural geometry builders used to generate the city meshes.
 */
import * as THREE from 'three';

/** Accumulates vertices/indices and builds one BufferGeometry (keeps draw calls low). */
export class GeoBuilder {
  constructor(extra = []) {
    this.p = [];
    this.n = [];
    this.c = [];
    this.uv = [];
    this.i = [];
    this.extra = {};
    this.extraDef = extra;
    for (const [k] of extra) this.extra[k] = [];
  }
  get count() {
    return this.p.length / 3;
  }
  v(x, y, z, nx, ny, nz, col, u = 0, vv = 0, ex) {
    this.p.push(x, y, z);
    this.n.push(nx, ny, nz);
    this.c.push(col.r, col.g, col.b);
    this.uv.push(u, vv);
    if (ex) for (const k in ex) this.extra[k].push(...ex[k]);
    return this.p.length / 3 - 1;
  }
  tri(a, b, c) {
    this.i.push(a, b, c);
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    for (const [k, size] of this.extraDef) g.setAttribute(k, new THREE.Float32BufferAttribute(this.extra[k], size));
    g.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(this.i, 1) : new THREE.Uint16BufferAttribute(this.i, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/** Flat polygon (x/z ring) at height y with optional holes, facing up. */
export function addFlatPoly(gb, ring, y, col, holes = []) {
  const contour = ring.map((p) => new THREE.Vector2(p[0], p[1]));
  const hs = holes.map((h) => h.map((p) => new THREE.Vector2(p[0], p[1])));
  let tris;
  try {
    tris = THREE.ShapeUtils.triangulateShape(contour, hs);
  } catch {
    return;
  }
  const all = contour.concat(...hs);
  const base = gb.count;
  for (const v of all) gb.v(v.x, y, v.y, 0, 1, 0, col, v.x, v.y);
  for (const t of tris) {
    const a = all[t[0]],
      b = all[t[1]],
      c = all[t[2]];
    const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    if (cross > 0) gb.tri(base + t[0], base + t[2], base + t[1]);
    else gb.tri(base + t[0], base + t[1], base + t[2]);
  }
}

/** Flat ribbon of width w along a polyline. */
export function addRibbon(gb, pts, w, y, col, uScale = 1) {
  if (pts.length < 2) return;
  const h = w / 2;
  let dist = 0,
    prevL = -1,
    prevR = -1;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i],
      a = pts[Math.max(0, i - 1)],
      b = pts[Math.min(pts.length - 1, i + 1)];
    let dx = b[0] - a[0],
      dz = b[1] - a[1];
    const l = Math.hypot(dx, dz) || 1;
    dx /= l;
    dz /= l;
    let m = 1;
    if (i > 0 && i < pts.length - 1) {
      let d1x = p[0] - a[0],
        d1z = p[1] - a[1];
      const l1 = Math.hypot(d1x, d1z) || 1;
      d1x /= l1;
      d1z /= l1;
      m = 1 / Math.max(0.5, d1x * dx + d1z * dz);
    }
    if (i > 0) dist += Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]);
    const rx = -dz * h * m,
      rz = dx * h * m;
    const L = gb.v(p[0] - rx, y, p[1] - rz, 0, 1, 0, col, 0, dist * uScale);
    const R = gb.v(p[0] + rx, y, p[1] + rz, 0, 1, 0, col, 1, dist * uScale);
    if (prevL >= 0) {
      gb.tri(prevL, L, prevR);
      gb.tri(prevR, L, R);
    }
    prevL = L;
    prevR = R;
  }
}

/** Oriented box (yaw around Y). */
export function addBox(gb, cx, cy, cz, hx, hy, hz, yaw, col) {
  const c = Math.cos(yaw),
    s = Math.sin(yaw);
  const T = (x, y, z) => [cx + x * c + z * s, cy + y, cz - x * s + z * c];
  const R = (x, y, z) => [x * c + z * s, y, -x * s + z * c];
  const faces = [
    [
      [1, 0, 0],
      [0, 0, -1],
      [0, 1, 0],
    ],
    [
      [-1, 0, 0],
      [0, 0, 1],
      [0, 1, 0],
    ],
    [
      [0, 1, 0],
      [1, 0, 0],
      [0, 0, -1],
    ],
    [
      [0, -1, 0],
      [1, 0, 0],
      [0, 0, 1],
    ],
    [
      [0, 0, 1],
      [1, 0, 0],
      [0, 1, 0],
    ],
    [
      [0, 0, -1],
      [-1, 0, 0],
      [0, 1, 0],
    ],
  ];
  const E = [hx, hy, hz];
  for (const [n, u, v] of faces) {
    const nn = R(...n);
    const idx = [];
    for (const [su, sv] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ]) {
      const lp = [0, 1, 2].map((k) => n[k] * E[k] + u[k] * su * E[k] + v[k] * sv * E[k]);
      idx.push(gb.v(...T(...lp), ...nn, col));
    }
    gb.tri(idx[0], idx[1], idx[2]);
    gb.tri(idx[0], idx[2], idx[3]);
  }
}

/** Flat rectangle centred at c with its long axis along unit vector d. */
export function addQuad(gb, cx, cz, dx, dz, hl, hw, y, col) {
  const px = dz,
    pz = -dx;
  const P = [
    [-hl, -hw],
    [hl, -hw],
    [hl, hw],
    [-hl, hw],
  ].map(([a, b]) => [cx + dx * a + px * b, cz + dz * a + pz * b]);
  const ids = P.map((p) => gb.v(p[0], y, p[1], 0, 1, 0, col));
  const cr = (P[1][1] - P[0][1]) * (P[2][0] - P[0][0]) - (P[1][0] - P[0][0]) * (P[2][1] - P[0][1]);
  if (cr > 0) {
    gb.tri(ids[0], ids[1], ids[2]);
    gb.tri(ids[0], ids[2], ids[3]);
  } else {
    gb.tri(ids[0], ids[2], ids[1]);
    gb.tri(ids[0], ids[3], ids[2]);
  }
}

/** Dashed centre line along a polyline (3 m dash, 6 m gap). */
export function addDashes(gb, pts, y, col) {
  let carry = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i],
      b = pts[i + 1];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 0.1) continue;
    const dx = (b[0] - a[0]) / L,
      dz = (b[1] - a[1]) / L;
    for (let s = carry; s < L; s += 9) {
      const e = Math.min(L, s + 3);
      addRibbon(
        gb,
        [
          [a[0] + dx * s, a[1] + dz * s],
          [a[0] + dx * e, a[1] + dz * e],
        ],
        0.15,
        y,
        col,
      );
    }
    carry = (((carry - L) % 9) + 9) % 9;
  }
}
