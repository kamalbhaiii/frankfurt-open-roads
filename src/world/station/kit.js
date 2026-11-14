/**
 * Small geometry kit for the Hauptbahnhof: a triangle-soup mesh builder with vertex colours and
 * world-scaled UVs, and a collision builder that feeds the static trimesh (PhysicsMesh.push).
 * All coordinates are in the station's local frame (x = u along the tracks, z = v across, y up).
 */
import * as THREE from 'three';

const _v = new THREE.Vector3(),
  _n = new THREE.Vector3(),
  _m3 = new THREE.Matrix3();
const WHITE = new THREE.Color(1, 1, 1);

/** Triangle-soup builder: position, normal, uv, color. One builder = one merged mesh. */
export class MB {
  constructor() {
    this.p = [];
    this.n = [];
    this.uv = [];
    this.c = [];
  }
  get count() {
    return this.p.length / 3;
  }
  vert(x, y, z, nx, ny, nz, u, v, col = WHITE) {
    this.p.push(x, y, z);
    this.n.push(nx, ny, nz);
    this.uv.push(u, v);
    this.c.push(col.r, col.g, col.b);
  }
  /** Quad a-b-c-d (counter-clockwise seen from the front), flat normal, uvs per corner. */
  quad(a, b, c, d, uva, uvb, uvc, uvd, col) {
    const ux = b[0] - a[0],
      uy = b[1] - a[1],
      uz = b[2] - a[2];
    const vx = d[0] - a[0],
      vy = d[1] - a[1],
      vz = d[2] - a[2];
    _n.set(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx).normalize();
    const { x, y, z } = _n;
    for (const [p, t] of [
      [a, uva],
      [b, uvb],
      [c, uvc],
      [a, uva],
      [c, uvc],
      [d, uvd],
    ])
      this.vert(p[0], p[1], p[2], x, y, z, t[0], t[1], col);
  }
  /** Quad with uvs = world metres * s on the two in-plane axes. */
  quadW(a, b, c, d, s, col) {
    // choose the in-plane axes by the dominant normal
    const ux = b[0] - a[0],
      uy = b[1] - a[1],
      uz = b[2] - a[2];
    const vx = d[0] - a[0],
      vy = d[1] - a[1],
      vz = d[2] - a[2];
    const nx = Math.abs(uy * vz - uz * vy),
      ny = Math.abs(uz * vx - ux * vz),
      nz = Math.abs(ux * vy - uy * vx);
    const map = nx >= ny && nx >= nz ? (p) => [p[2] * s, p[1] * s] : nz >= ny ? (p) => [p[0] * s, p[1] * s] : (p) => [p[0] * s, p[2] * s];
    this.quad(a, b, c, d, map(a), map(b), map(c), map(d), col);
  }
  /**
   * Axis-aligned box. o: { s: uv scale (world uvs), col, skip: 'top,bottom,...', uv: [u0,v0,u1,v1] atlas rect for every face }
   */
  box(x0, x1, y0, y1, z0, z1, o = {}) {
    const s = o.s ?? 0.25,
      col = o.col,
      skip = o.skip || '';
    const P = (x, y, z) => [x, y, z];
    const faces = {
      top: [P(x0, y1, z1), P(x1, y1, z1), P(x1, y1, z0), P(x0, y1, z0)],
      bottom: [P(x0, y0, z0), P(x1, y0, z0), P(x1, y0, z1), P(x0, y0, z1)],
      px: [P(x1, y0, z1), P(x1, y0, z0), P(x1, y1, z0), P(x1, y1, z1)],
      nx: [P(x0, y0, z0), P(x0, y0, z1), P(x0, y1, z1), P(x0, y1, z0)],
      pz: [P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1)],
      nz: [P(x1, y0, z0), P(x0, y0, z0), P(x0, y1, z0), P(x1, y1, z0)],
    };
    for (const k in faces) {
      if (skip.includes(k)) continue;
      const f = faces[k];
      if (o.uv) {
        const [a, b, c, d] = o.uv;
        this.quad(f[0], f[1], f[2], f[3], [a, b], [c, b], [c, d], [a, d], col);
      } else this.quadW(f[0], f[1], f[2], f[3], s, col);
    }
  }
  /** Box rotated about Y around its centre (yaw in radians, local x/z). */
  boxR(cx, cy, cz, hx, hy, hz, yaw, o = {}) {
    const c = Math.cos(yaw),
      s = Math.sin(yaw);
    const start = this.p.length;
    this.box(-hx, hx, -hy, hy, -hz, hz, o);
    for (let i = start; i < this.p.length; i += 3) {
      const x = this.p[i],
        z = this.p[i + 2];
      this.p[i] = cx + x * c + z * s;
      this.p[i + 1] += cy;
      this.p[i + 2] = cz - x * s + z * c;
      const nx = this.n[i],
        nz = this.n[i + 2];
      this.n[i] = nx * c + nz * s;
      this.n[i + 2] = -nx * s + nz * c;
    }
  }
  /** Box between two points (a beam/strut) with square section r. */
  beam(ax, ay, az, bx, by, bz, r, o = {}) {
    const dx = bx - ax,
      dy = by - ay,
      dz = bz - az;
    const L = Math.hypot(dx, dy, dz);
    if (L < 1e-4) return;
    const g = new THREE.BoxGeometry(r, L, r);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(dx / L, dy / L, dz / L));
    const m = new THREE.Matrix4().compose(new THREE.Vector3((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2), q, new THREE.Vector3(1, 1, 1));
    this.geo(g, m, o.col, o.uv);
  }
  /** Cylinder (vertical) at x/z. */
  cyl(x, z, y0, y1, r, seg = 8, o = {}) {
    const g = new THREE.CylinderGeometry(o.r1 ?? r, r, y1 - y0, seg, 1, !!o.open);
    this.geo(g, new THREE.Matrix4().makeTranslation(x, (y0 + y1) / 2, z), o.col, o.uv);
  }
  /** Appends any BufferGeometry (indexed or not) transformed by m; uv: optional atlas rect to squash uvs into. */
  geo(g, m, col = WHITE, uvRect = null, uvScale = 1) {
    const src = g.index ? g.toNonIndexed() : g;
    const P = src.attributes.position,
      N = src.attributes.normal,
      T = src.attributes.uv;
    _m3.getNormalMatrix(m);
    for (let i = 0; i < P.count; i++) {
      _v.fromBufferAttribute(P, i).applyMatrix4(m);
      _n.fromBufferAttribute(N, i).applyMatrix3(_m3).normalize();
      let u = T ? T.getX(i) * uvScale : 0,
        v = T ? T.getY(i) * uvScale : 0;
      if (uvRect) {
        u = uvRect[0] + (uvRect[2] - uvRect[0]) * (T ? T.getX(i) : 0.5);
        v = uvRect[1] + (uvRect[3] - uvRect[1]) * (T ? T.getY(i) : 0.5);
      }
      this.vert(_v.x, _v.y, _v.z, _n.x, _n.y, _n.z, u, v, col);
    }
    g.dispose();
    if (src !== g) src.dispose();
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.computeBoundingSphere();
    return g;
  }
}

/** Collects collision triangles (local frame) and converts them to world space for the trimesh. */
export class CB {
  constructor() {
    this.v = [];
  }
  tri(a, b, c) {
    this.v.push(...a, ...b, ...c);
  }
  quad(a, b, c, d) {
    this.tri(a, b, c);
    this.tri(a, c, d);
  }
  box(x0, x1, y0, y1, z0, z1) {
    const p = (x, y, z) => [x, y, z];
    this.quad(p(x0, y1, z0), p(x0, y1, z1), p(x1, y1, z1), p(x1, y1, z0));
    this.quad(p(x0, y0, z0), p(x1, y0, z0), p(x1, y0, z1), p(x0, y0, z1));
    this.quad(p(x0, y0, z0), p(x0, y1, z0), p(x1, y1, z0), p(x1, y0, z0));
    this.quad(p(x0, y0, z1), p(x1, y0, z1), p(x1, y1, z1), p(x0, y1, z1));
    this.quad(p(x0, y0, z0), p(x0, y0, z1), p(x0, y1, z1), p(x0, y1, z0));
    this.quad(p(x1, y0, z0), p(x1, y1, z0), p(x1, y1, z1), p(x1, y0, z1));
  }
  /** Ramp: top surface rising from y0 at x0 to y1 at x1 (z0..z1), solid down to 0. */
  ramp(x0, x1, y0, y1, z0, z1) {
    const p = (x, y, z) => [x, y, z];
    this.quad(p(x0, y0, z0), p(x0, y0, z1), p(x1, y1, z1), p(x1, y1, z0));
    this.quad(p(x0, 0, z0), p(x0, y0, z0), p(x1, y1, z0), p(x1, 0, z0));
    this.quad(p(x0, 0, z1), p(x1, 0, z1), p(x1, y1, z1), p(x0, y0, z1));
    this.quad(p(x1, 0, z0), p(x1, y1, z0), p(x1, y1, z1), p(x1, 0, z1));
  }
  /** Walkable surface at height y split into step x step tiles (small triangles collide reliably). */
  grid(x0, x1, z0, z1, y, step = 8) {
    for (let x = x0; x < x1 - 1e-3; x += step)
      for (let z = z0; z < z1 - 1e-3; z += step) {
        const xa = Math.min(x + step, x1),
          za = Math.min(z + step, z1);
        this.quad([x, y, z], [x, y, za], [xa, y, za], [xa, y, z]);
      }
  }
  /** World-space BufferGeometry (position + index) for PhysicsMesh.push. */
  toGeometry(matrix) {
    const pos = new Float32Array(this.v.length);
    for (let i = 0; i < this.v.length; i += 3) {
      _v.set(this.v[i], this.v[i + 1], this.v[i + 2]).applyMatrix4(matrix);
      pos[i] = _v.x;
      pos[i + 1] = _v.y;
      pos[i + 2] = _v.z;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const idx = new Uint32Array(pos.length / 3);
    for (let i = 0; i < idx.length; i++) idx[i] = i;
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    return g;
  }
}

/**
 * Arch-shaped wall: a rectangle (w x h, centred on x = 0, from y = 0) with arched openings, extruded by
 * depth. Openings starting at y = 0 (doorways) are cut into the outline; the others become holes.
 */
export function archWall(w, h, holes, depth, curveSeg = 10) {
  const sh = new THREE.Shape();
  const notches = holes.filter((o) => o.y <= 0.001).sort((a, b) => a.x - b.x);
  sh.moveTo(-w / 2, 0);
  for (const o of notches) {
    const r = o.w / 2,
      round = o.round ?? true;
    const spring = round ? o.h - r : o.h;
    sh.lineTo(o.x - r, 0);
    sh.lineTo(o.x - r, spring);
    if (round) for (let i = 1; i < curveSeg; i++) sh.lineTo(o.x - r * Math.cos((Math.PI * i) / curveSeg), spring + r * Math.sin((Math.PI * i) / curveSeg));
    sh.lineTo(o.x + r, spring);
    sh.lineTo(o.x + r, 0);
  }
  sh.lineTo(w / 2, 0);
  sh.lineTo(w / 2, h);
  sh.lineTo(-w / 2, h);
  sh.lineTo(-w / 2, 0);
  for (const o of holes) if (o.y > 0.001) sh.holes.push(archPath(o.x, o.y, o.w, o.h, o.round ?? true, curveSeg));
  return new THREE.ExtrudeGeometry(sh, { depth, bevelEnabled: false, curveSegments: curveSeg });
}

/** Path of an opening: x centre, y bottom, width, total height; semicircular top if round. */
export function archPath(x, y, w, h, round = true, seg = 10) {
  const p = new THREE.Path();
  const r = w / 2;
  const spring = round ? y + h - r : y + h;
  p.moveTo(x - r, y);
  p.lineTo(x + r, y);
  p.lineTo(x + r, spring);
  if (round) for (let i = 1; i <= seg; i++) p.lineTo(x + r * Math.cos((Math.PI * i) / seg), spring + r * Math.sin((Math.PI * i) / seg));
  else p.lineTo(x - r, spring);
  p.lineTo(x - r, y);
  return p;
}

/**
 * Matrix that places an ExtrudeGeometry wall (shape in x/y, extruded along +z) on a facade plane
 * facing +u (local x): shape x -> -v, depth z -> u. uFront is the outer face.
 */
export function facadeMatrix(uFront, depth, vCentre, y0 = 0, facing = 1) {
  const m = new THREE.Matrix4();
  if (facing > 0) m.makeRotationY(Math.PI / 2).setPosition(uFront - depth, y0, vCentre);
  else m.makeRotationY(-Math.PI / 2).setPosition(uFront + depth, y0, vCentre);
  return m;
}

/** Matrix for a wall facing +v (south) or -v: shape x -> u. */
export function sideMatrix(vFront, depth, uCentre, y0 = 0, facing = 1) {
  const m = new THREE.Matrix4();
  if (facing > 0) m.makeTranslation(uCentre, y0, vFront - depth);
  else m.makeRotationY(Math.PI).setPosition(uCentre, y0, vFront + depth);
  return m;
}
