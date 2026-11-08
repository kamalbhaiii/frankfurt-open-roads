// Vehicle generator (owner: vehicles agent). Exports CARS (specs) and makeCar(spec) -> THREE.Group.
// Run only through `node tools/make-models.mjs cars` (writes assets/models/car_<id>.glb for every entry of CARS).
//
// CONTRACT (every drivable vehicle; src/actors/vehicles.js, player, police, traffic and missions rely on it)
//   * +Z forward, +Y up, ground at y = 0, +X = the vehicle's LEFT side (left-hand drive, driver at x = +0.38).
//   * Wheel hub pivots are nodes named wheel_FL / wheel_FR / wheel_RL / wheel_RR (y = wheel radius).
//     The game steers them with rotation.y and spins them with rotation.x.
//   * Materials: body_vc (vertex-coloured opaque body incl. interior), glass, headlight, taillight,
//     indicator_L, indicator_R, optional siren / taxi_sign, wheel_vc, plate (UV 0..1 per plate, the game
//     paints a German number plate atlas onto it), optional decal (UVs into the per-model lettering atlas
//     described by userData.decals).
//   * Root userData: {type, label, length, width, height, wheelRadius, mass, sill, power, paint, seatY, seatZ}
//     plus seatX (driver seat x), category, drivable, decals, sirenColors, physTrack (scooter: raycast wheel track).
//   * All meshes live under the child node 'lod0'.
//
// Vertex colours are RGBA: rgb = linear colour, a = material class / 15 (see CLS) so a single mesh can hold
// paint (clear-coated + metallic flakes at runtime), chrome, gloss/matte plastics, rubber, interior and lamps.
//
// Modelling: each body is a signed distance field built from a side profile (spline), a cross-section
// (half-width per height), plan-view corner rounding and wheel-arch cut-outs, blended with smooth max.
// It is meshed with surface nets, projected onto the exact surface (smooth normals), split into parts by
// region fields (glass, lamps, grille, livery ...) whose borders are snapped onto the exact region outline,
// and every part is simplified with meshoptimizer (borders locked, so outlines stay crisp).
import { THREE, mergeGeometries, std } from './common.mjs';
import { MeshoptSimplifier } from 'meshoptimizer';

await MeshoptSimplifier.ready;

const { clamp, lerp } = THREE.MathUtils;
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const smax = (a, b, k) => { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.max(a, b) + h * h * k * 0.25; };

/** Material classes stored in vertex-colour alpha (a = cls / 15). Keep in sync with src/actors/vehicles.js. */
export const CLS = { matte: 0, paint: 1, chrome: 2, gloss: 3, rubber: 4, interior: 5, head: 6, tail: 7, ind: 8, siren: 9, sign: 10, metal: 11, darkglass: 12, reverse: 13 };
const col = (hex, cls) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b, cls / 15]; };
function paintGeo(g, rgba) {
  const n = g.attributes.position.count, a = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) a.set(rgba, i * 4);
  g.setAttribute('color', new THREE.Float32BufferAttribute(a, 4));
  return g;
}
function prep(g, keepUv = false) {
  for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'color', ...(keepUv ? ['uv'] : [])].includes(k)) g.deleteAttribute(k);
  if (!g.attributes.normal) g.computeVertexNormals();
  if (!g.index) { const n = g.attributes.position.count, ix = new Uint32Array(n); for (let i = 0; i < n; i++) ix[i] = i; g.setIndex(new THREE.BufferAttribute(ix, 1)); }
  return g;
}

// ------------------------------------------------------------------------------------------------
// curves & tables
/** Catmull-Rom through [a, b, sharp?] points; sharp points break the curve (corners). */
function spline(pts, seg = 6) {
  const out = [];
  const run = (r) => {
    const n = r.length;
    for (let i = 0; i < n - 1; i++) {
      const p0 = r[Math.max(i - 1, 0)], p1 = r[i], p2 = r[i + 1], p3 = r[Math.min(i + 2, n - 1)];
      for (let s = 0; s < seg; s++) {
        const t = s / seg, t2 = t * t, t3 = t2 * t;
        const f = (k) => 0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3);
        out.push([f(0), f(1)]);
      }
    }
  };
  let r = [pts[0]];
  for (let i = 1; i < pts.length; i++) { r.push(pts[i]); if (pts[i][2] || i === pts.length - 1) { run(r); r = [pts[i]]; } }
  out.push([pts[pts.length - 1][0], pts[pts.length - 1][1]]);
  return out;
}
function table(v0, v1, step, fn) { const n = Math.ceil((v1 - v0) / step) + 1, a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = fn(v0 + i * step); return { v0, step, n, a }; }
function look(T, v) {
  const t = (v - T.v0) / T.step; if (!(t >= 0 && t <= T.n - 1)) return NaN;
  const i = Math.min(Math.floor(t), T.n - 2), f = t - i, a = T.a[i], b = T.a[i + 1];
  if (a !== a || b !== b) return f < 0.5 ? a : b;
  return a + (b - a) * f;
}
const lookC = (T, v) => look(T, clamp(v, T.v0, T.v0 + T.step * (T.n - 1)));
function normTable(T) { return table(T.v0, T.v0 + T.step * (T.n - 1), T.step, (v) => { const s = (look(T, v + T.step) - look(T, v - T.step)) / (2 * T.step); return s === s ? 1 / Math.sqrt(1 + s * s) : 1; }); }

/** Side profile: closed polygon in (z, y) -> scanline tables + approximate signed distance. */
function profile(poly, step = 0.004) {
  let zmin = Infinity, zmax = -Infinity, ymin = Infinity, ymax = -Infinity;
  for (const [z, y] of poly) { zmin = Math.min(zmin, z); zmax = Math.max(zmax, z); ymin = Math.min(ymin, y); ymax = Math.max(ymax, y); }
  const scan = (v, ax) => {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      if ((a[ax] <= v) !== (b[ax] <= v)) { const t = (v - a[ax]) / (b[ax] - a[ax]), w = a[1 - ax] + t * (b[1 - ax] - a[1 - ax]); lo = Math.min(lo, w); hi = Math.max(hi, w); }
    }
    return hi === -Infinity ? [NaN, NaN] : [lo, hi];
  };
  const top = table(zmin, zmax, step, (z) => scan(z, 0)[1]), bot = table(zmin, zmax, step, (z) => scan(z, 0)[0]);
  const front = table(ymin, ymax, step, (y) => scan(y, 1)[1]), rear = table(ymin, ymax, step, (y) => scan(y, 1)[0]);
  const tN = normTable(top), bN = normTable(bot), fN = normTable(front), rN = normTable(rear);
  const P = { zmin, zmax, ymin, ymax, top, bot, front, rear };
  P.dist = (z, y) => {
    const t = look(top, z), f = look(front, y);
    if (t !== t) {
      if (f !== f) return Math.hypot(Math.max(z - zmax, zmin - z, 0), Math.max(y - ymax, ymin - y, 0)) + 0.001;
      return Math.max(z - f, look(rear, y) - z);
    }
    let d = Math.max((y - t) * look(tN, z), (look(bot, z) - y) * look(bN, z));
    if (f === f) d = Math.max(d, (z - f) * look(fN, y), (look(rear, y) - z) * look(rN, y));
    return d;
  };
  P.topAt = (z) => lookC(top, z); P.frontAt = (y) => lookC(front, y); P.rearAt = (y) => lookC(rear, y);
  return P;
}

// ------------------------------------------------------------------------------------------------
// body SDF
/**
 * d: { poly, sec: [[y, halfWidth]...], hw0, wedge, cl/ch: plan corner radii {fx, fz, rx, rz} below/above the
 * switch heights ySwF / ySwR, noseTop, tailTop, bowF, bowR, k0, k1, kY, arches: [{z, y, R}], flare }
 */
function makeBody(d) {
  const P = profile(spline(d.poly, d.seg ?? 6));
  const sp = spline(d.sec, 6).sort((a, b) => a[0] - b[0]);
  const SEC = table(sp[0][0], sp[sp.length - 1][0], 0.004, (y) => { let i = 0; while (i < sp.length - 2 && sp[i + 1][0] < y) i++; const a = sp[i], b = sp[i + 1]; return lerp(a[1], b[1], clamp((y - a[0]) / ((b[0] - a[0]) || 1), 0, 1)); });
  const W2 = d.hw0, arches = d.arches || [];
  const zBow = (z, ax) => { const u = (ax / W2) ** 2; return z > 0 ? z + (d.bowF || 0) * u * sstep(0, P.zmax, z) : z - (d.bowR || 0) * u * sstep(0, -P.zmin, -z); };
  const corner = (dd, rx, rz) => { if (dd >= rz) return 0; const q = 1 - Math.max(dd, 0) / rz; return rx * (1 - Math.sqrt(Math.max(0, 1 - q * q))); };
  const hwAt = (y, zb) => {
    let hw = lookC(SEC, y + (d.wedge || 0) * zb);
    const lowF = y < d.ySwF, lowR = y < d.ySwR, cf = lowF ? d.cl : d.ch, cr = lowR ? d.cl : d.ch;
    const fr = P.frontAt(lowF ? Math.min(y, d.noseTop) : y), rr = P.rearAt(lowR ? Math.min(y, d.tailTop) : y);
    if (fr === fr) hw -= corner(fr - zb, cf.fx, cf.fz);
    if (rr === rr) hw -= corner(zb - rr, cr.rx, cr.rz);
    if (d.taperF) hw -= d.taperF * sstep(0, 1, zb / P.zmax) ** 2;
    if (d.taperR) hw -= d.taperR * sstep(0, 1, zb / P.zmin) ** 2;
    if (d.flare) for (const a of arches) { const u = (zb - a.z) / (a.R + 0.25); if (Math.abs(u) < 1) hw += d.flare * (1 - u * u) ** 2 * sstep(a.y - 0.25, a.y, y) * (1 - sstep(a.y + a.R - 0.02, a.y + a.R + 0.16, y)); }
    return hw;
  };
  const kAt = (y) => lerp(d.k0, d.k1, sstep(d.kY - 0.05, d.kY + 0.08, y));
  const f = (x, y, z) => {
    const ax = Math.abs(x), zb = zBow(z, ax);
    let v = smax(P.dist(zb, y), ax - hwAt(y, zb), kAt(y));
    for (const a of arches) v = smax(v, a.R - Math.hypot(z - a.z, y - a.y), 0.025);
    if (d.extraF) v = d.extraF(v, x, y, z);
    return v;
  };
  return { f, P, hwAt, zBow, d };
}

// ------------------------------------------------------------------------------------------------
// meshing
function grad(f, x, y, z, e) {
  const gx = f(x + e, y, z) - f(x - e, y, z), gy = f(x, y + e, z) - f(x, y - e, z), gz = f(x, y, z + e) - f(x, y, z - e);
  return [gx / (2 * e), gy / (2 * e), gz / (2 * e)];
}
/** Naive surface nets over [b0, b1] with cell size h; returns projected vertices, smooth normals, triangles. */
function nets(f, b0, b1, h) {
  const nx = Math.ceil((b1[0] - b0[0]) / h) + 1, ny = Math.ceil((b1[1] - b0[1]) / h) + 1, nz = Math.ceil((b1[2] - b0[2]) / h) + 1;
  const V = new Float32Array(nx * ny * nz);
  // coarse pre-pass (every 4th node): far from the surface the fine values are copied from the coarse grid
  const S = 4, mx = Math.ceil((nx - 1) / S) + 1, my = Math.ceil((ny - 1) / S) + 1, mz = Math.ceil((nz - 1) / S) + 1, Cg = new Float32Array(mx * my * mz);
  for (let k = 0; k < mz; k++) for (let j = 0; j < my; j++) for (let i = 0; i < mx; i++) Cg[(k * my + j) * mx + i] = f(b0[0] + i * S * h, b0[1] + j * S * h, b0[2] + k * S * h);
  const far = S * h * 2.2;
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const c = Cg[(Math.round(k / S) * my + Math.round(j / S)) * mx + Math.round(i / S)];
    V[(k * ny + j) * nx + i] = Math.abs(c) > far ? c : f(b0[0] + i * h, b0[1] + j * h, b0[2] + k * h);
  }
  const cx = nx - 1, cy = ny - 1, cz = nz - 1, cell = new Int32Array(cx * cy * cz).fill(-1);
  const pos = [];
  const E = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const cv = new Float32Array(8);
  for (let k = 0; k < cz; k++) for (let j = 0; j < cy; j++) for (let i = 0; i < cx; i++) {
    let m = 0;
    for (let c = 0; c < 8; c++) { const v = V[((k + (c >> 2)) * ny + j + ((c >> 1) & 1)) * nx + i + (c & 1)]; cv[c] = v; if (v < 0) m |= 1 << c; }
    if (m === 0 || m === 255) continue;
    let sx = 0, sy = 0, sz = 0, n = 0;
    for (const [a, b] of E) {
      if ((cv[a] < 0) === (cv[b] < 0)) continue;
      const t = cv[a] / (cv[a] - cv[b]);
      sx += (a & 1) + t * ((b & 1) - (a & 1)); sy += ((a >> 1) & 1) + t * (((b >> 1) & 1) - ((a >> 1) & 1)); sz += (a >> 2) + t * ((b >> 2) - (a >> 2)); n++;
    }
    cell[(k * cy + j) * cx + i] = pos.length / 3;
    pos.push(b0[0] + (i + sx / n) * h, b0[1] + (j + sy / n) * h, b0[2] + (k + sz / n) * h);
  }
  const C = (i, j, k) => cell[(k * cy + j) * cx + i];
  const tris = [];
  const quad = (a, b, c, d) => { if (a < 0 || b < 0 || c < 0 || d < 0) return; tris.push(a, b, c, a, c, d); };
  for (let k = 1; k < nz - 1; k++) for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const p = (k * ny + j) * nx + i, s = V[p] < 0;
    if (i < nx - 1 && s !== (V[p + 1] < 0)) quad(C(i, j - 1, k - 1), C(i, j, k - 1), C(i, j, k), C(i, j - 1, k));
    if (j < ny - 1 && s !== (V[p + nx] < 0)) quad(C(i - 1, j, k - 1), C(i, j, k - 1), C(i, j, k), C(i - 1, j, k));
    if (k < nz - 1 && s !== (V[p + nx * ny] < 0)) quad(C(i - 1, j - 1, k), C(i, j - 1, k), C(i, j, k), C(i - 1, j, k));
  }
  // project onto the surface, smooth normals from the field gradient
  const n = pos.length / 3, P = new Float32Array(pos), N = new Float32Array(n * 3), e = h * 0.25;
  for (let v = 0; v < n; v++) {
    let x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2], g = [0, 1, 0];
    for (let it = 0; it < 4; it++) {
      const val = f(x, y, z); g = grad(f, x, y, z, e); const gg = g[0] * g[0] + g[1] * g[1] + g[2] * g[2] || 1;
      let sx = (val * g[0]) / gg, sy = (val * g[1]) / gg, sz = (val * g[2]) / gg; const sl = Math.hypot(sx, sy, sz);
      if (sl > h * 0.6) { sx *= (h * 0.6) / sl; sy *= (h * 0.6) / sl; sz *= (h * 0.6) / sl; }
      x -= sx; y -= sy; z -= sz;
    }
    const gl = Math.hypot(g[0], g[1], g[2]) || 1;
    P.set([x, y, z], v * 3); N.set([g[0] / gl, g[1] / gl, g[2] / gl], v * 3);
  }
  const I = new Uint32Array(tris);
  orient(P, N, I);
  return { P, N, I };
}
function orient(P, N, I) {
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
    if (fx * (N[a] + N[b] + N[c]) + fy * (N[a + 1] + N[b + 1] + N[c + 1]) + fz * (N[a + 2] + N[b + 2] + N[c + 2]) < 0) { const s = I[t + 1]; I[t + 1] = I[t + 2]; I[t + 2] = s; }
  }
}

/**
 * Splits a mesh into named parts. regions: [{part, g(x, y, z, nx, ny, nz)}] in priority order (g < 0 inside);
 * triangles outside every region get `def`. Vertices on a border are snapped onto the outline of the
 * higher-priority region and re-projected onto the surface.
 */
function partition(M, f, regions, def, h, snap = true) {
  const { P, N, I } = M, nv = P.length / 3, nt = I.length / 3;
  const tp = new Int16Array(nt);
  for (let t = 0; t < nt; t++) {
    let x = 0, y = 0, z = 0, a = 0, b = 0, c = 0;
    for (let k = 0; k < 3; k++) { const v = I[t * 3 + k] * 3; x += P[v]; y += P[v + 1]; z += P[v + 2]; a += N[v]; b += N[v + 1]; c += N[v + 2]; }
    const l = Math.hypot(a, b, c) || 1;
    let r = 0; for (; r < regions.length; r++) if (regions[r].g(x / 3, y / 3, z / 3, a / l, b / l, c / l) < 0) break;
    tp[t] = r; // regions.length = default
  }
  if (snap) {
    const best = new Int16Array(nv).fill(32767), multi = new Uint8Array(nv), first = new Int16Array(nv).fill(-1);
    for (let t = 0; t < nt; t++) for (let k = 0; k < 3; k++) { const v = I[t * 3 + k]; if (first[v] < 0) first[v] = tp[t]; else if (first[v] !== tp[t]) multi[v] = 1; best[v] = Math.min(best[v], tp[t]); }
    const e = 0.002;
    for (let v = 0; v < nv; v++) {
      if (!multi[v] || best[v] >= regions.length) continue;
      const g = regions[best[v]].g, nx = N[v * 3], ny = N[v * 3 + 1], nz = N[v * 3 + 2];
      let x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
      const x0 = x, y0 = y, z0 = z;
      for (let it = 0; it < 5; it++) {
        const gv = g(x, y, z, nx, ny, nz);
        let gx = (g(x + e, y, z, nx, ny, nz) - g(x - e, y, z, nx, ny, nz)) / (2 * e), gy = (g(x, y + e, z, nx, ny, nz) - g(x, y - e, z, nx, ny, nz)) / (2 * e), gz = (g(x, y, z + e, nx, ny, nz) - g(x, y, z - e, nx, ny, nz)) / (2 * e);
        const dn = gx * nx + gy * ny + gz * nz; gx -= dn * nx; gy -= dn * ny; gz -= dn * nz; // move along the surface
        const gg = gx * gx + gy * gy + gz * gz; if (gg < 1e-8) break;
        x -= (gv * gx) / gg; y -= (gv * gy) / gg; z -= (gv * gz) / gg;
        const fv = f(x, y, z), fg = grad(f, x, y, z, h * 0.25), fl = fg[0] ** 2 + fg[1] ** 2 + fg[2] ** 2 || 1;
        x -= (fv * fg[0]) / fl; y -= (fv * fg[1]) / fl; z -= (fv * fg[2]) / fl;
      }
      if (Math.hypot(x - x0, y - y0, z - z0) < h * 1.6) P.set([x, y, z], v * 3);
    }
  }
  const parts = new Map();
  for (let t = 0; t < nt; t++) {
    const name = tp[t] < regions.length ? regions[tp[t]].part : def;
    if (!parts.has(name)) parts.set(name, { map: new Map(), P: [], N: [], I: [] });
    const p = parts.get(name);
    for (let k = 0; k < 3; k++) {
      const v = I[t * 3 + k]; let w = p.map.get(v);
      if (w === undefined) { w = p.P.length / 3; p.map.set(v, w); p.P.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]); p.N.push(N[v * 3], N[v * 3 + 1], N[v * 3 + 2]); }
      p.I.push(w);
    }
  }
  return parts;
}

/** meshoptimizer simplification with locked borders; returns an indexed BufferGeometry (position, normal). */
function simplify(p, err, lock = true, attrs = null, weights = null, target = 0) {
  const P = new Float32Array(p.P), N = new Float32Array(p.N), I = new Uint32Array(p.I);
  const A = attrs || N, aw = weights || [0.4, 0.4, 0.4], stride = A.length / (P.length / 3);
  const [out] = MeshoptSimplifier.simplifyWithAttributes(I, P, 3, A, stride, aw, null, target, err, lock ? ['LockBorder', 'ErrorAbsolute'] : ['ErrorAbsolute']);
  const remap = new Map(), pos = [], nrm = [], at = [], idx = [];
  for (const v of out) {
    let w = remap.get(v);
    if (w === undefined) { w = pos.length / 3; remap.set(v, w); pos.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]); nrm.push(N[v * 3], N[v * 3 + 1], N[v * 3 + 2]); if (attrs) for (let s = 0; s < stride; s++) at.push(A[v * stride + s]); }
    idx.push(w);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3)); g.setIndex(idx);
  if (attrs) g.userData.attr = at;
  return g;
}

/** First surface hit of the field along a ray (o + t*dir). Returns {p, n} or null. */
function cast(f, o, dir, max = 4) {
  let t = 0, prev = f(o[0], o[1], o[2]);
  const at = (t) => [o[0] + dir[0] * t, o[1] + dir[1] * t, o[2] + dir[2] * t];
  for (; t < max; t += 0.008) {
    const q = at(t + 0.008), v = f(q[0], q[1], q[2]);
    if (v < 0 && prev >= 0) {
      let a = t, b = t + 0.008;
      for (let i = 0; i < 24; i++) { const m = (a + b) / 2, r = at(m); if (f(r[0], r[1], r[2]) < 0) b = m; else a = m; }
      const p = at((a + b) / 2), g = grad(f, p[0], p[1], p[2], 0.003), l = Math.hypot(...g) || 1;
      return { p, n: [g[0] / l, g[1] / l, g[2] / l] };
    }
    prev = v;
  }
  return null;
}

// ------------------------------------------------------------------------------------------------
// primitive helpers (all return geometries with position + normal)
function rbox(w, h, d, r) {
  const g = new THREE.BoxGeometry(w, h, d, 3, 3, 3), p = g.attributes.position, v = new THREE.Vector3(), c = new THREE.Vector3();
  r = Math.min(r, w / 2 - 0.001, h / 2 - 0.001, d / 2 - 0.001);
  const hx = w / 2 - r, hy = h / 2 - r, hz = d / 2 - r;
  for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i); c.set(clamp(v.x, -hx, hx), clamp(v.y, -hy, hy), clamp(v.z, -hz, hz)); const n = v.clone().sub(c); if (n.lengthSq() > 1e-9) n.setLength(r); p.setXYZ(i, c.x + n.x, c.y + n.y, c.z + n.z); }
  g.deleteAttribute('uv'); g.deleteAttribute('normal');
  const m = new THREE.BufferGeometry(); m.setAttribute('position', g.attributes.position); m.setIndex(g.index);
  const out = mergeVerts(m); out.computeVertexNormals(); return out;
}
function mergeVerts(g) { // weld by position only
  const p = g.attributes.position, map = new Map(), pos = [], idx = [], src = g.index ? g.index.array : [...Array(p.count).keys()];
  for (const i of src) { const k = `${p.getX(i).toFixed(5)},${p.getY(i).toFixed(5)},${p.getZ(i).toFixed(5)}`; let w = map.get(k); if (w === undefined) { w = pos.length / 3; map.set(k, w); pos.push(p.getX(i), p.getY(i), p.getZ(i)); } idx.push(w); }
  const o = new THREE.BufferGeometry(); o.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); o.setIndex(idx); return o;
}
const T = (g, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) => { g.rotateX(rx); g.rotateY(ry); g.rotateZ(rz); g.translate(x, y, z); return g; };
const rb = (w, h, d, r, x, y, z, rx = 0, ry = 0, rz = 0) => T(rbox(w, h, d, r), x, y, z, rx, ry, rz);
const box = (w, h, d, x, y, z, rx = 0, ry = 0, rz = 0) => { const g = new THREE.BoxGeometry(w, h, d); g.deleteAttribute('uv'); return T(g, x, y, z, rx, ry, rz); };
const cyl = (rt, rb_, h, x, y, z, seg = 16, rx = 0, rz = 0, open = false) => { const g = new THREE.CylinderGeometry(rt, rb_, h, seg, 1, open); g.deleteAttribute('uv'); return T(g, x, y, z, rx, 0, rz); };
const flipG = (g) => { const ix = g.index.array; for (let i = 0; i < ix.length; i += 3) { const t = ix[i + 1]; ix[i + 1] = ix[i + 2]; ix[i + 2] = t; } g.computeVertexNormals(); return g; };
/** Ribbon along a polyline of surface points, lifted along the normals. */
function ribbon(pts, nrms, w, lift = 0.0015, hgt = 0) {
  const pos = [], idx = [], nn = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(i - 1, 0)], b = pts[Math.min(i + 1, pts.length - 1)], n = nrms[i];
    const t = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]).normalize(), N = new THREE.Vector3(...n), s = new THREE.Vector3().crossVectors(t, N).normalize().multiplyScalar(w / 2);
    const p = new THREE.Vector3(...pts[i]).addScaledVector(N, lift + hgt);
    pos.push(p.x + s.x, p.y + s.y, p.z + s.z, p.x - s.x, p.y - s.y, p.z - s.z); nn.push(...n, ...n);
    if (i) { const k = (i - 1) * 2; idx.push(k, k + 1, k + 3, k, k + 3, k + 2); }
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nn, 3)); g.setIndex(idx);
  // make it face outward
  const P = g.attributes.position.array, N = g.attributes.normal.array, I = g.index.array; orient(P, N, I);
  return g;
}
/** Textured quad centred at p facing outward normal n (u to the viewer's right), for plates and lettering. */
function quadUV(p, n, w, h, uv = [0, 0, 1, 1], up = [0, 1, 0]) {
  const N = new THREE.Vector3(...n).normalize(), U = new THREE.Vector3(...up); U.addScaledVector(N, -U.dot(N)).normalize();
  const R = new THREE.Vector3().crossVectors(U, N).normalize(), C = new THREE.Vector3(...p);
  const c = (sx, sy) => C.clone().addScaledVector(R, (sx * w) / 2).addScaledVector(U, (sy * h) / 2);
  const v = [c(-1, -1), c(1, -1), c(1, 1), c(-1, 1)];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v.flatMap((q) => [q.x, q.y, q.z]), 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute([...N.toArray(), ...N.toArray(), ...N.toArray(), ...N.toArray()], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([uv[0], uv[1], uv[2], uv[1], uv[2], uv[3], uv[0], uv[3]], 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

// 2D shape fields for regions --------------------------------------------------------------------
/** Convex polygon (CCW or CW) signed distance-ish field with rounded corners (radius r). */
function poly2(pts, r = 0) {
  const n = pts.length; let area = 0; for (let i = 0; i < n; i++) { const a = pts[i], b = pts[(i + 1) % n]; area += a[0] * b[1] - b[0] * a[1]; }
  const s = area > 0 ? 1 : -1;
  const E = pts.map((a, i) => { const b = pts[(i + 1) % n], dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy); return [a[0], a[1], (s * dy) / l, (-s * dx) / l]; });
  return (u, v) => { let d = -Infinity; for (const [ax, ay, nx, ny] of E) { const e = (u - ax) * nx + (v - ay) * ny + r; d = r ? smax(d, e, r * 2) : Math.max(d, e); } return d - r; };
}

// ------------------------------------------------------------------------------------------------
// shared part palette: part name -> [colour, class]
const BASE_PARTS = {
  trim: [0x0a0b0c, CLS.gloss], black: [0x111214, CLS.matte], under: [0x0c0c0d, CLS.matte], liner: [0x0d0d0e, CLS.matte], mesh: [0x151618, CLS.matte],
  grille: [0x0b0c0d, CLS.gloss], chrome: [0xd8dde2, CLS.chrome], metal: [0x9aa1a8, CLS.metal], reverse: [0xe8eaec, CLS.reverse], amber: [0xd27a12, CLS.ind],
  redrefl: [0x6a0b0b, CLS.gloss], mirror: [0x56606a, CLS.chrome], clad: [0x1c1d20, CLS.matte], frit: [0x08090a, CLS.gloss], rubber: [0x141414, CLS.rubber],
};
const LIGHT_MATS = {
  headlight: () => std('headlight', 0xd3dbe2, { roughness: 0.06, metalness: 0.55, emissive: 0xfff4dd, emissiveIntensity: 0.15 }),
  taillight: () => std('taillight', 0x7a0606, { roughness: 0.12, emissive: 0xff1a12, emissiveIntensity: 0.25 }),
  indicator_L: () => std('indicator_L', 0xc9740f, { roughness: 0.15, emissive: 0xff8a00, emissiveIntensity: 0 }),
  indicator_R: () => std('indicator_R', 0xc9740e, { roughness: 0.15, emissive: 0xff8a00, emissiveIntensity: 0 }),
  siren: () => std('siren', 0x1030ff, { emissive: 0x2050ff, emissiveIntensity: 0.4, roughness: 0.2, transparent: true, opacity: 0.9 }),
  taxi_sign: () => std('taxi_sign', 0xfff3b0, { emissive: 0xffd24a, emissiveIntensity: 0.6, roughness: 0.3 }),
};

// ------------------------------------------------------------------------------------------------
// WHEELS (one vertex-coloured mesh per wheel; axle along X)
function wheelGeo(s, lod = 0) {
  const r = s.r, w = s.tyreW, ri = r * (s.rimRatio ?? 0.68), ox = w / 2, seg = lod ? 12 : 32;
  const C = { tyre: col(0x161616, CLS.rubber), rim: col(s.rim ?? 0xb9bec4, s.rimCls ?? CLS.metal), dark: col(0x26292d, CLS.matte), disc: col(0x6d6f72, CLS.metal), cap: col(0x1b1d20, CLS.gloss), nut: col(0xa0a6ac, CLS.chrome) };
  const parts = [];
  const add = (g, c) => parts.push(paintGeo(prep(g), c));
  const ax = (g) => { g.rotateZ(Math.PI / 2); return g; };
  const prof = [[ri - 0.005, -w * 0.42], [ri + 0.02, -w * 0.5], [r - 0.05, -w * 0.5], [r - 0.018, -w * 0.46], [r - 0.004, -w * 0.38], [r, -w * 0.28], [r, w * 0.28], [r - 0.004, w * 0.38], [r - 0.018, w * 0.46], [r - 0.05, w * 0.5], [ri + 0.02, w * 0.5], [ri - 0.005, w * 0.42]];
  const tyre = new THREE.LatheGeometry(prof.map(([a, b]) => new THREE.Vector2(a, b)), seg); tyre.deleteAttribute('uv'); tyre.rotateZ(Math.PI / 2); add(tyre, C.tyre);
  if (lod) { add(ax(cyl(ri, ri, w * 0.9, 0, 0, 0, seg)), C.rim); return mergeGeometries(parts); }
  add(flipG(prep(ax(cyl(ri, ri, w * 0.84, 0, 0, 0, 28, 0, 0, true)))), C.dark);
  add(ax(cyl(ri * 0.98, ri * 0.98, 0.012, 0, 0, 0, 28)).translate(-w * 0.18, 0, 0), C.dark);
  add(ax(cyl(r * 0.5, r * 0.5, 0.025, 0, 0, 0, 24)).translate(-w * 0.05, 0, 0), C.disc);
  const lip = new THREE.TorusGeometry(ri - 0.004, 0.013, 6, 36); lip.deleteAttribute('uv'); lip.rotateY(Math.PI / 2); lip.translate(ox * 0.86, 0, 0); add(lip, C.rim);
  const style = s.rimStyle ?? 'spoke5', hubR = style === 'steel' || style === 'truck' ? ri * 0.55 : 0.07;
  const spoke = (a, len, wIn, wOut, thick, xo, skew = 0) => {
    const g = new THREE.BoxGeometry(thick, len, 1, 1, 2, 1); g.deleteAttribute('uv'); const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) { const t = p.getY(i) / len + 0.5; p.setZ(i, p.getZ(i) * lerp(wIn, wOut, t) + skew * t); p.setX(i, p.getX(i) - t * t * 0.03); }
    g.translate(0, hubR * 0.8 + len / 2, 0); g.rotateX(a); g.translate(xo, 0, 0); g.computeVertexNormals(); add(g, C.rim);
  };
  const sLen = ri - hubR * 0.8 - 0.01, sx = ox * 0.8;
  if (style === 'spoke5') for (let i = 0; i < 5; i++) spoke((i / 5) * Math.PI * 2, sLen, 0.06, 0.1, 0.035, sx);
  if (style === 'twin5') for (let i = 0; i < 5; i++) for (const o of [-0.12, 0.12]) spoke((i / 5) * Math.PI * 2 + o, sLen, 0.04, 0.05, 0.035, sx);
  if (style === 'multi10') for (let i = 0; i < 10; i++) spoke((i / 10) * Math.PI * 2, sLen, 0.028, 0.045, 0.03, sx, 0.03);
  if (style === 'aero') { for (let i = 0; i < 6; i++) spoke((i / 6) * Math.PI * 2, sLen, 0.06, 0.13, 0.03, sx); add(ax(cyl(ri * 0.95, ri * 0.95, 0.01, 0, 0, 0, 28)).translate(sx - 0.03, 0, 0), C.dark); }
  if (style === 'steel' || style === 'truck') {
    add(ax(cyl(ri * 0.97, ri * 0.9, 0.03, 0, 0, 0, 28)).translate(sx - 0.01, 0, 0), C.rim);
    const nh = style === 'truck' ? 10 : 8;
    for (let i = 0; i < nh; i++) { const a = (i / nh) * Math.PI * 2; add(ax(cyl(0.028, 0.028, 0.035, 0, 0, 0, 8)).translate(sx - 0.004, Math.cos(a) * ri * 0.72, Math.sin(a) * ri * 0.72), C.dark); }
  }
  add(ax(cyl(hubR, hubR * 1.1, 0.04, 0, 0, 0, 20)).translate(sx, 0, 0), C.rim);
  add(ax(cyl(0.035, 0.035, 0.012, 0, 0, 0, 14)).translate(sx + 0.022, 0, 0), C.cap);
  for (let i = 0; i < 5; i++) { const a = (i / 5) * Math.PI * 2 + 0.3; add(ax(cyl(0.011, 0.011, 0.014, 0, 0, 0, 6)).translate(sx + 0.02, Math.cos(a) * hubR * 0.65, Math.sin(a) * hubR * 0.65), C.nut); }
  return mergeGeometries(parts);
}

// ------------------------------------------------------------------------------------------------
// ASSEMBLER
export const DECAL_ROWS = 8;
/**
 * Builds a vehicle from a spec. s.bodies(s) -> [{ B (makeBody result or {f}), b0, b1, regions, def, cell }].
 * s.details(X) adds overlays through the X helpers. Returns the THREE.Group following the contract.
 */
function build(s) {
  const bodies = s.bodies ? s.bodies(s) : [];
  const fU = (x, y, z) => { let v = 1; for (const b of bodies) v = Math.min(v, b.B.f(x, y, z)); return v; };
  const palette = { ...BASE_PARTS, paint: [s.color, CLS.paint], ...(s.parts || {}) };
  const rgba = (part) => { const c = Array.isArray(part) ? part : palette[part]; if (!c) throw new Error('unknown part ' + part); return c.length === 4 ? c : col(c[0], c[1]); };
  const bodyGeos = [], lightGeos = {}, glassGeos = [], plateGeos = [], decalGeos = [];
  const add = (g, part) => bodyGeos.push(paintGeo(prep(g), rgba(part)));
  const addLight = (g, mat) => (lightGeos[mat] ||= []).push(prep(g));
  for (const b of bodies) {
    const h = b.cell ?? s.cell ?? 0.016;
    const M = nets(b.B.f, b.b0, b.b1, h);
    const parts = partition(M, b.B.f, b.regions, b.def ?? 'paint', h);
    for (const [name, p] of parts) {
      if (name === 'void') continue;
      const g = simplify(p, s.err ?? 0.003);
      if (name === 'glass') glassGeos.push(g);
      else if (LIGHT_MATS[name]) addLight(g, name);
      else add(g, name);
    }
  }
  const X = {
    s, f: fU, bodies, B: bodies[0]?.B, add, addLight, palette, rgba,
    glass: (g) => glassGeos.push(prep(g)),
    cast: (o, d, max) => cast(fU, o, d, max),
    /** surface point seen from the side (sx = +1 left / -1 right) at (y, z) */
    side: (sx, y, z) => cast(fU, [sx * (s.W / 2 + 0.4), y, z], [-sx, 0, 0], s.W),
    top: (x, z, y0 = s.H + 0.5) => cast(fU, [x, y0, z], [0, -1, 0], y0 + 0.1),
    end: (end, x, y) => cast(fU, [x, y, end * (s.L / 2 + 0.4)], [0, 0, -end], s.L),
    plate: (end, y, x = 0) => {
      const hit = X.end(end, x, y); if (!hit) return;
      const z = hit.p[2] + end * 0.012;
      add(rb(0.54, 0.125, 0.02, 0.005, x, y, z - end * 0.008), 'black');
      plateGeos.push(quadUV([x, y, z + end * 0.0025], [0, 0, end], 0.52, 0.11, end > 0 ? [0, 0.5, 1, 1] : [0, 0, 1, 0.5]));
    },
    plateAt: (end, x, y, z) => { add(rb(0.54, 0.125, 0.02, 0.005, x, y, z - end * 0.008), 'black'); plateGeos.push(quadUV([x, y, z + end * 0.0025], [0, 0, end], 0.52, 0.11, end > 0 ? [0, 0.5, 1, 1] : [0, 0, 1, 0.5])); },
    /** lettering decal (text drawn at runtime into the model's decal atlas; row = index in s.decals) */
    decal: (row, p, n, w, h, up) => { const uw = Math.min(1, w / h / 8); decalGeos.push(quadUV(p, n, w, h, [0.5 - uw / 2, 1 - (row + 1) / DECAL_ROWS, 0.5 + uw / 2, 1 - row / DECAL_ROWS], up)); },
    /** decal glued on the side surface (sx side) centred at (y, z) */
    sideDecal: (row, sx, y, z, w, h) => { const hit = X.side(sx, y, z); if (hit) X.decal(row, [hit.p[0] + sx * 0.006, y, z], [sx, 0, 0], w, h); },
    ribbonSide: (sx, z, y0, y1, w, part, n = 10, lift) => {
      const pts = [], ns = [];
      for (let i = 0; i <= n; i++) { const hh = X.side(sx, lerp(y0, y1, i / n), z); if (hh) { pts.push(hh.p); ns.push(hh.n); } }
      if (pts.length > 1) add(ribbon(pts, ns, w, lift), part);
    },
    /** project a polyline onto the surface along dir and add a ribbon */
    ribbonLine: (pts3, w, part, dir, lift) => {
      const pts = [], ns = [];
      for (const q of pts3) { const hh = cast(fU, [q[0] - dir[0] * 1.5, q[1] - dir[1] * 1.5, q[2] - dir[2] * 1.5], dir, 3); if (hh) { pts.push(hh.p); ns.push(hh.n); } }
      if (pts.length > 1) add(ribbon(pts, ns, w, lift), part);
    },
  };
  s.details?.(X);
  if (s.interior) interior(X, s.interior);

  // ---------------- assemble ----------------
  const car = new THREE.Group(); car.name = 'car_' + s.id;
  const lod0 = new THREE.Group(); lod0.name = 'lod0';
  const body = new THREE.Mesh(mergeGeometries(bodyGeos), std('body_vc', 0xffffff, { vertexColors: true, roughness: 0.5, metalness: 0.1 })); body.name = 'body'; lod0.add(body);
  if (glassGeos.length) { const gl = new THREE.Mesh(mergeGeometries(glassGeos), std('glass', 0x0b1219, { roughness: 0.03, metalness: 0.2, transparent: true, opacity: 0.6 })); gl.name = 'glass'; lod0.add(gl); }
  for (const [m, gs] of Object.entries(lightGeos)) { const mat = LIGHT_MATS[m](); if (m === 'siren' && s.ud?.sirenColors) { mat.color.setHex(s.ud.sirenColors[0]); mat.emissive.setHex(s.ud.sirenColors[0]); } const mesh = new THREE.Mesh(mergeGeometries(gs), mat); mesh.name = m; lod0.add(mesh); }
  if (plateGeos.length) { const pm = new THREE.Mesh(mergeGeometries(plateGeos), std('plate', 0xf2f2ee, { roughness: 0.35 })); pm.name = 'plate'; lod0.add(pm); }
  if (decalGeos.length) { const dm = new THREE.Mesh(mergeGeometries(decalGeos), std('decal', 0xffffff, { roughness: 0.4, transparent: true, alphaTest: 0.5 })); dm.name = 'decal'; lod0.add(dm); }
  const wGeo = wheelGeo(s);
  const wMat = std('wheel_vc', 0xffffff, { vertexColors: true, roughness: 0.5, metalness: 0.3 });
  const wx = s.wheelX ?? s.W / 2 - s.tyreW / 2 - 0.04;
  const wheels = s.wheels ?? [['wheel_FL', wx, s.axles[0]], ['wheel_FR', -wx, s.axles[0]], ['wheel_RL', wx, s.axles[1]], ['wheel_RR', -wx, s.axles[1]], ...(s.extraWheels?.(wx) || [])];
  for (const [n, x, z] of wheels) {
    const wg = new THREE.Group(); wg.name = n; wg.position.set(x, s.r, z);
    const wm = new THREE.Mesh(wGeo, wMat); wm.name = n + '_mesh'; if (x < 0) wm.rotation.y = Math.PI; wg.add(wm); car.add(wg);
  }
  car.add(lod0);
  car.userData = {
    type: s.id, label: s.label, category: s.category ?? 'car', drivable: s.drivable !== false, length: s.L, width: s.W, height: s.H, wheelRadius: s.r, mass: s.mass,
    sill: s.sillUD ?? 0.3, power: s.power ?? 1, paint: s.color, seatX: s.seatX ?? 0.38, seatY: s.seatY ?? (s.interior ? s.interior.seatY - 0.135 : 0.52), seatZ: s.seatZ ?? (s.interior ? s.interior.seatZ - 0.04 : 0), decals: s.decals || [], ...(s.ud || {}),
  };
  return car;
}

// ------------------------------------------------------------------------------------------------
// INTERIOR (cars): o: {seatZ, seatY (cushion top), dashZ, dashY, inW, rear, rearZ, seat, seat2, cover:[z0, z1, y]}
function interior(X, o) {
  const { add } = X, seat = col(o.seat ?? 0x2e2c2a, CLS.interior), seat2 = col(o.seat2 ?? 0x232325, CLS.interior), dash = col(0x18191b, CLS.interior), scr = col(0x0c141c, CLS.gloss), alu = col(0x8a8f95, CLS.metal);
  const sy = o.seatY, sz = o.seatZ, inW = o.inW;
  for (const sx of [-1, 1]) {
    const x = sx * 0.38;
    add(rb(0.5, 0.12, 0.52, 0.05, x, sy - 0.06, sz), seat);
    add(rb(0.3, 0.02, 0.4, 0.008, x, sy, sz), seat2);
    add(box(0.2, Math.max(0.05, sy - 0.25), 0.32, x, (sy + 0.2) / 2 - 0.05, sz), dash);
    add(rb(0.5, 0.62, 0.13, 0.06, x, sy + 0.28, sz - 0.29, -0.2), seat);
    add(rb(0.3, 0.46, 0.02, 0.008, x, sy + 0.28, sz - 0.22, -0.2), seat2);
    add(rb(0.26, 0.17, 0.1, 0.04, x, sy + 0.68, sz - 0.4, -0.12), seat);
  }
  if (o.dashZ != null) {
    const dz = o.dashZ, dy = o.dashY;
    add(rb(inW * 2 - 0.04, 0.26, 0.55, 0.09, 0, dy - 0.13, dz + 0.1), dash);
    add(rb(0.4, 0.08, 0.2, 0.04, 0.38, dy, dz - 0.12), dash);
    add(box(0.3, 0.17, 0.015, -0.02, dy + 0.06, dz - 0.16, -0.3), scr);
    add(box(inW * 2 - 0.3, 0.02, 0.03, 0, dy - 0.04, dz - 0.18), alu);
    const swZ = dz - 0.3, swY = dy - 0.06;
    const sw = new THREE.TorusGeometry(0.18, 0.02, 8, 28); sw.deleteAttribute('uv'); sw.rotateX(0.38); sw.translate(0.38, swY, swZ); add(sw, dash);
    add(rb(0.3, 0.04, 0.04, 0.015, 0.38, swY, swZ, 0.38), dash);
    add(rb(0.09, 0.08, 0.05, 0.02, 0.38, swY - 0.01, swZ + 0.01, 0.38), dash);
    add(rb(0.22, 0.2, Math.max(0.2, dz - sz - 0.2), 0.04, 0, sy - 0.05, (dz + sz) / 2 - 0.05), dash);
    add(rb(0.04, 0.08, 0.06, 0.015, 0, sy + 0.08, sz + 0.3), alu);
  }
  if (o.rear) {
    const rz = o.rearZ;
    add(rb(inW * 2 - 0.1, 0.14, 0.5, 0.05, 0, sy - 0.05, rz), seat);
    add(rb(inW * 2 - 0.1, 0.56, 0.13, 0.06, 0, sy + 0.24, rz - 0.28, -0.22), seat);
    for (const x of [-0.4, 0.4]) add(rb(0.24, 0.14, 0.09, 0.035, x, sy + 0.6, rz - 0.36, -0.12), seat);
  }
  if (o.cover) add(box(inW * 2 - 0.1, 0.02, o.cover[1] - o.cover[0], 0, o.cover[2], (o.cover[0] + o.cover[1]) / 2), dash);
}

// ------------------------------------------------------------------------------------------------
// PASSENGER CARS
/** Standard car body: SDF definition + region list from the spec's profile/section/lamp/window data. */
function carBody(s) {
  const F = s.L / 2, R = -s.L / 2, p = s.p;
  const arches = s.axles.map((z) => ({ z, y: s.r, R: s.r + (p.archGap ?? 0.065) }));
  const B = makeBody({
    poly: p.poly, sec: p.sec, hw0: s.W / 2, wedge: p.wedge ?? 0.012, cl: p.cl, ch: p.ch, ySwF: p.cowlY, ySwR: p.deckY, noseTop: p.noseTop, tailTop: p.tailTop,
    bowF: p.bowF ?? 0.1, bowR: p.bowR ?? 0.07, k0: p.k0 ?? 0.03, k1: p.k1 ?? 0.06, kY: p.beltY, arches, flare: p.flare ?? 0.012, taperF: p.taperF ?? 0.03, taperR: p.taperR ?? 0.02,
  });
  const P = B.P, w = p.win, L = p.lamps;
  const belt = (z) => p.beltY - (p.wedge ?? 0.012) * z;
  const hwS = (x, y, z) => B.hwAt(y, B.zBow(z, Math.abs(x)));
  // windows
  const gSide = (x, y, z, nx) => {
    let g = smax(belt(z) + (w.bot ?? 0.03) - y, y - (P.topAt(z) - w.topOff), 0.03);
    g = smax(g, z - (P.frontAt(Math.min(y, w.wsTop)) - w.aOff), 0.05);
    g = smax(g, P.rearAt(Math.min(y, w.rwTop)) + w.cOff - z, 0.05);
    for (const q of w.pillars || []) g = smax(g, q.w - Math.abs(z - q.z - (q.slant ?? 0) * (y - p.beltY)), 0.02);
    return Math.max(g, (0.3 - Math.abs(nx)) * 0.3);
  };
  const gWs = (x, y, z, nx, ny, nz) => Math.max(smax(p.cowlY + (w.wsBot ?? 0.03) - y, w.wsZ != null ? w.wsZ - z : y - w.wsTop, 0.02), Math.abs(x) - (hwS(x, y, z) - w.pw), -z, (0.15 - nz) * 0.3);
  const gRw = (x, y, z, nx, ny, nz) => Math.max(smax(w.rwBot - y, w.rwZ != null ? z - w.rwZ : y - w.rwTop, 0.02), Math.abs(x) - (hwS(x, y, z) - (w.pwR ?? w.pw)), z, (0.15 + nz) * 0.3);
  const gGlass = (x, y, z, nx, ny, nz) => Math.min(gSide(x, y, z, nx), gWs(x, y, z, nx, ny, nz), gRw(x, y, z, nx, ny, nz));
  // lamps (front-/rear-view shapes in |x|, y, limited in depth from the nose / tail)
  const fz = (y) => P.frontAt(y), rz = (y) => P.rearAt(y);
  const head = poly2(L.head, 0.012), tail = poly2(L.tail, 0.012), grille = L.grille && poly2(L.grille, 0.02), intake = L.intake && poly2(L.intake, 0.03);
  const gHead = (x, y, z) => Math.max(head(Math.abs(x), y), fz(y) - L.headDepth - z);
  const gTail = (x, y, z) => Math.max(tail(Math.abs(x), y), z - (rz(y) + L.tailDepth));
  const regions = [
    { part: 'indicator_L', g: (x, y, z) => Math.max(gHead(x, y, z), L.indX - x) },
    { part: 'indicator_R', g: (x, y, z) => Math.max(gHead(x, y, z), L.indX + x) },
    { part: 'headlight', g: gHead },
    { part: 'trim', g: (x, y, z) => gHead(x, y, z) - 0.008 },
    { part: 'indicator_L', g: (x, y, z) => Math.max(gTail(x, y, z), y - L.tailIndY, -x) },
    { part: 'indicator_R', g: (x, y, z) => Math.max(gTail(x, y, z), y - L.tailIndY, x) },
    { part: 'reverse', g: (x, y, z) => Math.max(gTail(x, y, z), Math.abs(x) - L.revX) },
    { part: 'taillight', g: gTail },
    ...(grille ? [{ part: 'grille', g: (x, y, z) => Math.max(grille(Math.abs(x), y), fz(y) - 0.3 - z) }, { part: L.grilleFrame ?? 'chrome', g: (x, y, z) => Math.max(grille(Math.abs(x), y) - 0.014, fz(y) - 0.3 - z) }] : []),
    ...(intake ? [{ part: 'mesh', g: (x, y, z) => Math.max(intake(Math.abs(x), y), fz(y) - 0.3 - z) }] : []),
    ...(p.regions?.(B, { belt, hwS }) || []),
    { part: 'glass', g: gGlass },
    { part: w.frame ?? 'trim', g: (x, y, z, nx, ny, nz) => gGlass(x, y, z, nx, ny, nz) - (w.frameW ?? 0.022) },
    ...(p.livery?.(B, { belt, hwS }) || []),
    { part: 'liner', g: (x, y, z) => Math.min(...arches.map((a) => Math.hypot(z - a.z, y - a.y) - a.R - 0.012)) },
    { part: p.lowerPart ?? 'black', g: (x, y) => y - (p.lowY ?? 0.2) },
  ];
  const b0 = [-s.W / 2 - 0.06, 0.05, R - 0.06], b1 = [s.W / 2 + 0.06, s.H + 0.08, F + 0.06];
  return [{ B, b0, b1, regions, def: 'paint' }];
}

/** Standard car overlays: mirrors, handles, panel seams, wipers, antenna, plates, exhausts, rails. */
function carDetails(X) {
  const { s, add, B } = X, p = s.p, P = B.P, belt = (z) => p.beltY - (p.wedge ?? 0.012) * z;
  // panel seams (doors) and door handles
  const seams = p.seams || [];
  for (const sx of [-1, 1]) {
    for (const z of seams) X.ribbonSide(sx, z, (p.lowY ?? 0.2) + 0.06, belt(z) + 0.03, 0.005, 'trim', 12);
    for (const z of p.handles || []) {
      const y = belt(z) - 0.075, h = X.side(sx, y, z); if (!h) continue;
      add(rb(0.03, 0.026, 0.17, 0.012, h.p[0] + sx * 0.008, y, z), p.handlePart ?? 'paint');
      add(rb(0.008, 0.04, 0.19, 0.003, h.p[0] + sx * 0.001, y, z), 'trim');
    }
    // mirrors
    const zm = p.mirrorZ, ym = belt(zm) + 0.1, hm = X.side(sx, belt(zm) + 0.03, zm);
    if (hm) {
      const x0 = hm.p[0];
      add(rb(0.06, 0.06, 0.14, 0.02, x0 + sx * 0.02, belt(zm) + 0.04, zm), 'trim');
      add(rb(0.2, 0.12, 0.11, 0.045, x0 + sx * 0.12, ym, zm, 0, sx * -0.12, sx * 0.04), p.mirrorPart ?? 'paint');
      add(rb(0.17, 0.095, 0.01, 0.02, x0 + sx * 0.12, ym, zm - 0.052, 0, sx * -0.12), 'mirror');
      X.addLight(rb(0.1, 0.014, 0.04, 0.006, x0 + sx * 0.16, ym - 0.056, zm + 0.025), sx > 0 ? 'indicator_L' : 'indicator_R');
    }
  }
  // wipers on the scuttle
  const zw = P.frontAt(p.cowlY + 0.05) - 0.03;
  if (!p.noWipers) for (const x0 of [0.42, -0.12]) X.ribbonLine([...Array(7)].map((_, i) => [x0 + 0.27 - i * 0.09, 0, zw - i * 0.012]), 0.016, 'trim', [0, -1, 0], 0.012);
  // shark-fin antenna
  if (p.antennaZ != null) { const h = X.top(0, p.antennaZ); if (h) { const g = rbox(0.06, 0.07, 0.2, 0.03); const q = g.attributes.position; for (let i = 0; i < q.count; i++) { const k = (q.getZ(i) + 0.1) / 0.2; q.setY(i, 0.035 + (q.getY(i) - 0.035) * (1 - 0.7 * k)); } g.computeVertexNormals(); g.translate(0, h.p[1] - 0.005, p.antennaZ); add(g, 'trim'); } }
  // plates
  X.plate(1, p.plateF); X.plate(-1, p.plateR);
  // exhaust tips
  for (const x of p.exhaust || []) { const h = X.end(-1, x, (p.lowY ?? 0.2) + 0.06); if (h) { add(cyl(0.035, 0.035, 0.08, x, (p.lowY ?? 0.2) + 0.06, h.p[2] + 0.02, 14, Math.PI / 2), 'chrome'); add(cyl(0.026, 0.026, 0.081, x, (p.lowY ?? 0.2) + 0.06, h.p[2] + 0.021, 12, Math.PI / 2), 'under'); } }
  // roof rails
  if (p.rails) {
    for (const sx of [-1, 1]) {
      const pts = [], ns = [];
      for (let i = 0; i <= 14; i++) { const z = lerp(p.rails[0], p.rails[1], i / 14), h = X.top(sx * p.rails[2], z); if (h) { pts.push([h.p[0], h.p[1] + 0.045, h.p[2]]); ns.push([0, 1, 0]); } }
      if (pts.length > 2) {
        const curve = new THREE.CatmullRomCurve3(pts.map((q) => new THREE.Vector3(...q)));
        const tg = new THREE.TubeGeometry(curve, 24, 0.017, 6); tg.deleteAttribute('uv'); add(tg, p.railPart ?? 'chrome');
        for (const t of [0.04, 0.5, 0.96]) { const q = curve.getPoint(t); add(rb(0.035, 0.06, 0.08, 0.012, q.x, q.y - 0.03, q.z), 'trim'); }
      }
    }
  }
  // third brake light
  if (p.cbl) { const h = X.top(0, p.cbl[0]); if (h) X.addLight(rb(0.3, 0.025, 0.03, 0.01, 0, h.p[1] + p.cbl[1], p.cbl[0]), 'taillight'); }
  p.extra?.(X);
}

// --- shared profiles -------------------------------------------------------------------------------
const SEDAN_P = {
  poly: [[2.2, 0.16, 1], [2.42, 0.24], [2.475, 0.42], [2.465, 0.6], [2.4, 0.7], [2.2, 0.76], [1.6, 0.85], [0.95, 0.935, 1], [0.6, 1.08], [0.25, 1.3], [0.0, 1.41], [-0.4, 1.45], [-0.85, 1.42], [-1.2, 1.31], [-1.62, 1.04, 1],
    [-2.0, 1.0], [-2.32, 0.98], [-2.44, 0.92], [-2.475, 0.76], [-2.47, 0.5], [-2.42, 0.25], [-2.2, 0.16, 1], [0, 0.15, 1], [2.2, 0.16, 1]],
  sec: [[0.12, 0.8], [0.2, 0.88], [0.3, 0.915], [0.55, 0.935], [0.78, 0.93], [0.9, 0.915], [0.96, 0.895], [0.99, 0.855], [1.05, 0.82], [1.3, 0.72], [1.42, 0.64], [1.5, 0.5]],
  beltY: 0.97, cowlY: 0.94, deckY: 1.03, noseTop: 0.72, tailTop: 0.95, cl: { fx: 0.3, fz: 0.42, rx: 0.24, rz: 0.3 }, ch: { fx: 0.12, fz: 0.25, rx: 0.12, rz: 0.25 },
  win: { aOff: 0.3, cOff: 0.28, topOff: 0.06, wsTop: 1.36, rwBot: 1.07, rwTop: 1.38, pw: 0.05, pillars: [{ z: -0.15, w: 0.045, slant: 0.1 }] },
  lamps: { head: [[0.4, 0.6], [0.43, 0.68], [1.1, 0.74], [1.1, 0.62]], headDepth: 0.42, indX: 0.82, tail: [[0.42, 0.84], [0.44, 0.93], [1.1, 0.95], [1.1, 0.82]], tailDepth: 0.32, tailIndY: 0.855, revX: 0.52,
    grille: [[0, 0.46], [0, 0.66], [0.36, 0.66], [0.33, 0.46]], intake: [[0, 0.24], [0, 0.34], [0.6, 0.36], [0.62, 0.24]] },
  seams: [1.08, -0.15, -1.0], handles: [0.3, -0.62], mirrorZ: 0.78, antennaZ: -0.9, plateF: 0.38, plateR: 0.62, exhaust: [-0.6, 0.6], cbl: [-1.45, -0.04], lowY: 0.2,
};
const SEDAN_I = { seatZ: 0.12, seatY: 0.55, dashZ: 0.85, dashY: 0.92, inW: 0.72, rear: true, rearZ: -0.78, seat: 0x3a2e26, seat2: 0x2c241e };
const ESTATE_P = {
  ...SEDAN_P,
  poly: [[2.2, 0.16, 1], [2.42, 0.24], [2.475, 0.42], [2.465, 0.6], [2.4, 0.7], [2.2, 0.76], [1.6, 0.85], [0.95, 0.935, 1], [0.6, 1.08], [0.25, 1.3], [0.0, 1.42], [-0.6, 1.47], [-1.4, 1.465], [-2.0, 1.43], [-2.3, 1.34, 1],
    [-2.42, 1.0], [-2.475, 0.78], [-2.47, 0.5], [-2.42, 0.25], [-2.2, 0.16, 1], [0, 0.15, 1], [2.2, 0.16, 1]],
  deckY: 1.0, tailTop: 0.98, ch: { fx: 0.12, fz: 0.25, rx: 0.1, rz: 0.12 },
  win: { aOff: 0.3, cOff: 0.3, topOff: 0.06, wsTop: 1.37, rwBot: 1.02, rwTop: 1.39, pw: 0.06, pillars: [{ z: -0.15, w: 0.045, slant: 0.1 }, { z: -1.22, w: 0.05, slant: -0.15 }] },
  lamps: { ...SEDAN_P.lamps, tail: [[0.5, 0.86], [0.52, 0.98], [1.1, 1.0], [1.1, 0.84]], tailIndY: 0.88, revX: 0.6 },
  rails: [-0.15, -2.05, 0.56], antennaZ: null, cbl: [-2.28, -0.03], plateR: 0.66, seams: [1.08, -0.15, -1.05],
};
const ESTATE_I = { ...SEDAN_I, cover: [-2.25, -1.2, 1.0] };

/** Simple SDF body with custom regions (cabs, boxes). */
function simpleBody(o) {
  const B = makeBody({ wedge: 0, bowF: 0.03, bowR: 0, k0: 0.025, k1: 0.03, kY: 1, taperF: 0, taperR: 0, flare: 0, ySwF: 9, ySwR: 9, noseTop: 9, tailTop: 9, ...o.def });
  return { B, b0: o.b0, b1: o.b1, regions: o.regions(B), def: o.defPart ?? 'paint', cell: o.cell };
}
/** Front lamp/grille/glass regions shared by cabs. */
function cabRegions(B, o) {
  const P = B.P, fz = (y) => P.frontAt(y), head = poly2(o.head, 0.012), grille = o.grille && poly2(o.grille, 0.02), side = poly2(o.side, 0.03);
  const gHead = (x, y, z) => Math.max(head(Math.abs(x), y), fz(y) - o.headDepth - z);
  const hwS = (x, y, z) => B.hwAt(y, B.zBow(z, Math.abs(x)));
  const gWs = (x, y, z, nx, ny, nz) => Math.max(smax(o.wsBot - y, y - o.wsTop, 0.03), Math.abs(x) - (hwS(x, y, z) - (o.pw ?? 0.08)), (0.3 - nz) * 0.3);
  const gSide = (x, y, z, nx) => Math.max(side(z, y), (0.5 - Math.abs(nx)) * 0.3);
  const gGlass = (x, y, z, nx, ny, nz) => Math.min(gWs(x, y, z, nx, ny, nz), gSide(x, y, z, nx));
  return [
    { part: 'indicator_L', g: (x, y, z) => Math.max(gHead(x, y, z), o.indX - x) },
    { part: 'indicator_R', g: (x, y, z) => Math.max(gHead(x, y, z), o.indX + x) },
    { part: 'headlight', g: gHead },
    { part: 'trim', g: (x, y, z) => gHead(x, y, z) - 0.01 },
    ...(grille ? [{ part: o.grillePart ?? 'grille', g: (x, y, z) => Math.max(grille(Math.abs(x), y), fz(y) - 0.25 - z) }] : []),
    ...(o.pre || []),
    { part: 'glass', g: gGlass },
    { part: 'trim', g: (x, y, z, nx, ny, nz) => gGlass(x, y, z, nx, ny, nz) - 0.03 },
    ...(o.livery || []),
    ...(o.arches || []).map((a) => ({ part: 'liner', g: (x, y, z) => Math.hypot(z - a.z, y - a.y) - a.R - 0.015 })),
    { part: 'black', g: (x, y) => y - o.lowY },
  ];
}
const band = (y0, y1, part, side = 0.5) => ({ part, g: (x, y, z, nx) => Math.max(y0 - y, y - y1, (side - Math.abs(nx)) * 0.3) });

// --- bus -------------------------------------------------------------------------------------------
const BUS_DOORS = [[5.12, 0.55], [0.9, 0.6], [-4.15, 0.55]];
const BUS = {
  id: 'bus', label: 'Stadtbus', category: 'bus', L: 12, W: 2.55, H: 3.0, r: 0.5, tyreW: 0.3, axles: [3.3, -2.6], color: 0xeef0f1, mass: 12000, power: 0.5, sillUD: 0.5,
  rimStyle: 'truck', rim: 0xc5c9cd, rimRatio: 0.6, wheelX: 1.07, cell: 0.03, err: 0.003, seatX: 0.38, seatY: 0.95, seatZ: 5.05,
  parts: { livTeal: [0x006b7d, CLS.paint], seat: [0x2a3b58, CLS.interior], floor: [0x34373a, CLS.interior], pole: [0xd6b21c, CLS.gloss] },
  bodies: carBody, details: (X) => { carDetails(X); busDetails(X); },
  p: {
    poly: [[5.85, 0.3, 1], [5.97, 0.4], [6.0, 0.7], [5.98, 1.1], [5.97, 2.0], [5.92, 2.75], [5.75, 2.95], [5.3, 3.0], [-5.7, 3.0], [-5.93, 2.9], [-5.99, 2.5], [-6.0, 0.7], [-5.96, 0.4], [-5.85, 0.3, 1], [0, 0.3, 1], [5.85, 0.3, 1]],
    sec: [[0.3, 1.2], [0.36, 1.255], [0.5, 1.275], [2.6, 1.275], [2.85, 1.25], [2.97, 1.15], [3.05, 0.8]], wedge: 0, flare: 0, archGap: 0.08,
    beltY: 1.15, cowlY: 0.92, deckY: 9, noseTop: 9, tailTop: 9, bowF: 0.12, bowR: 0.05, k0: 0.03, k1: 0.05, taperF: 0, taperR: 0,
    cl: { fx: 0.22, fz: 0.25, rx: 0.15, rz: 0.15 }, ch: { fx: 0.22, fz: 0.25, rx: 0.15, rz: 0.15 },
    win: { aOff: 0.22, cOff: 0.3, topOff: 0.45, bot: 0.0, wsTop: 2.72, wsBot: 0.04, rwBot: 1.95, rwTop: 2.7, pw: 0.1, frameW: 0.04,
      pillars: [4.35, 3.05, 1.75, -0.2, -1.45, -2.7, -3.95, -5.0].map((z) => ({ z, w: 0.05 })) },
    lamps: { head: [[0.72, 0.52], [0.72, 0.7], [1.4, 0.72], [1.4, 0.52]], headDepth: 0.22, indX: 1.08, tail: [[0.95, 0.55], [0.95, 1.25], [1.4, 1.25], [1.4, 0.55]], tailDepth: 0.15, tailIndY: 0.75, revX: 1.02 },
    regions: (B) => {
      const P = B.P, dest = poly2([[0, 2.77], [0, 2.92], [0.95, 2.92], [0.95, 2.77]], 0.02);
      const door = (x, y, z, nx) => Math.min(...BUS_DOORS.map(([c, w]) => Math.max(Math.abs(z - c) - w, 0.42 - y, y - 2.62, x + 0.4, (0.5 - Math.abs(nx)) * 0.3)));
      return [
        { part: 'taxi_sign', g: (x, y, z, nx, ny, nz) => Math.max(dest(Math.abs(x), y), P.frontAt(y) - 0.3 - z, (0.3 - nz) * 0.3) },
        { part: 'taxi_sign', g: (x, y, z) => Math.max(Math.abs(z - 3.9) - 0.6, Math.abs(y - 2.72) - 0.08, x + 0.5) },
        { part: 'glass', g: door },
        { part: 'trim', g: (x, y, z, nx) => door(x, y, z, nx) - 0.04 },
      ];
    },
    livery: () => [{ part: 'livTeal', g: (x, y) => y - 0.82 }, band(2.62, 2.7, 'livTeal')],
    seams: [], handles: [], mirrorZ: 5.75, antennaZ: null, plateF: 0.45, plateR: 0.5, exhaust: [], lowY: 0.42, noWipers: true,
  },
};
function busDetails(X) {
  const { add } = X;
  add(rb(1.9, 0.26, 2.4, 0.08, 0, 3.08, 0.8), 'paint'); // roof AC unit
  add(rb(1.6, 0.18, 1.6, 0.06, 0, 3.05, -4.6), 'paint'); // engine/roof pod
  for (const [c, w] of BUS_DOORS) { X.ribbonSide(-1, c, 0.45, 2.6, 0.012, 'trim', 8, 0.003); add(rb(0.03, 1.6, 0.03, 0.01, -1.24, 1.5, c - w * 0.5), 'pole'); add(rb(0.03, 1.6, 0.03, 0.01, -1.24, 1.5, c + w * 0.5), 'pole'); }
  add(box(2.4, 0.06, 11.4, 0, 0.42, 0), 'floor');
  for (let z = 3.9; z > -5.6; z -= 0.78) {
    for (const sx of [-1, 1]) {
      if (sx < 0 && BUS_DOORS.some(([c, w]) => Math.abs(z - c) < w + 0.35)) continue;
      add(rb(0.85, 0.1, 0.42, 0.03, sx * 0.72, 0.92, z), 'seat'); add(rb(0.85, 0.5, 0.08, 0.03, sx * 0.72, 1.2, z - 0.22, -0.12), 'seat');
    }
    add(cyl(0.018, 0.018, 1.9, 0.3, 1.4, z, 6), 'pole');
  }
  // driver area
  interior(X, { seatZ: 5.1, seatY: 1.09, inW: 1.15 });
  add(rb(1.3, 0.35, 0.5, 0.06, 0.55, 1.15, 5.6), [0.07, 0.07, 0.075, CLS.interior / 15]);
  const sw = new THREE.TorusGeometry(0.24, 0.022, 8, 28); sw.deleteAttribute('uv'); sw.rotateX(1.0); sw.translate(0.38, 1.35, 5.45); add(sw, 'black');
  for (const sx of [-1, 1]) { add(cyl(0.02, 0.02, 0.6, sx * 1.45, 2.45, 5.85, 6, 0, Math.PI / 2), 'black'); add(rb(0.08, 0.38, 0.22, 0.03, sx * 1.72, 2.25, 5.85), 'black'); }
}

// --- ambulance (Rettungswagen) --------------------------------------------------------------------
const CAB_POLY = [[3.25, 0.3, 1], [3.42, 0.38], [3.45, 0.55], [3.44, 0.78], [3.36, 0.95], [3.15, 1.05], [2.8, 1.12], [2.55, 1.18, 1], [2.2, 1.55], [1.9, 1.95], [1.6, 2.2], [1.3, 2.22], [1.15, 2.2, 1], [1.15, 0.3, 1], [3.25, 0.3, 1]];
const AMB = {
  id: 'ambulance', label: 'Rettungswagen', category: 'emergency', L: 6.9, W: 2.25, H: 2.85, r: 0.37, tyreW: 0.22, axles: [2.25, -1.55], color: 0xf4f5f4, mass: 4000, power: 0.75, sillUD: 0.45,
  rimStyle: 'steel', rim: 0xc5c9cd, rimRatio: 0.62, wheelX: 0.86, cell: 0.022, err: 0.0025, seatX: 0.38,
  interior: { seatZ: 1.72, seatY: 0.98, dashZ: 2.12, dashY: 1.28, inW: 0.85 },
  parts: { livRed: [0xd9231a, CLS.paint], livYel: [0xf0b400, CLS.paint] },
  ud: { sirenColors: [0x2050ff, 0x2050ff] },
  bodies: () => {
    const arF = { z: 2.25, y: 0.37, R: 0.44 }, arR = { z: -1.55, y: 0.37, R: 0.44 };
    const cab = simpleBody({
      def: { poly: CAB_POLY, sec: [[0.3, 0.9], [0.4, 0.97], [0.6, 1.0], [1.15, 1.0], [1.6, 0.96], [2.0, 0.9], [2.2, 0.84], [2.3, 0.6]], hw0: 1.0, cl: { fx: 0.25, fz: 0.3, rx: 0.05, rz: 0.05 }, ch: { fx: 0.2, fz: 0.3, rx: 0.05, rz: 0.05 }, arches: [arF] },
      b0: [-1.06, 0.25, 1.1], b1: [1.06, 2.28, 3.5],
      regions: (B) => cabRegions(B, { head: [[0.5, 0.8], [0.53, 0.95], [1.2, 0.98], [1.2, 0.82]], headDepth: 0.4, indX: 0.86, grille: [[0, 0.6], [0, 0.92], [0.42, 0.92], [0.4, 0.6]], wsBot: 1.22, wsTop: 2.08,
        side: [[1.4, 1.22], [1.4, 2.08], [1.75, 2.08], [2.4, 1.22]], arches: [arF], lowY: 0.5, livery: [band(0.95, 1.12, 'livRed')] }),
    });
    const bat = (row, part) => ({ part, g: (x, y, z, nx) => { const c = Math.sin((Math.PI * (z + 4)) / 0.55) * (y - 1.15) * (row ? 1 : -1); return Math.max(Math.abs(y - 1.15) - 0.25, c * 4, (0.5 - Math.abs(nx)) * 0.3); } });
    const box_ = simpleBody({
      def: { poly: [[1.25, 0.45, 1], [1.32, 0.55], [1.32, 2.75], [1.24, 2.85], [-3.35, 2.85], [-3.45, 2.75], [-3.45, 0.55], [-3.4, 0.45, 1], [1.25, 0.45, 1]], sec: [[0.45, 1.06], [0.55, 1.12], [2.7, 1.12], [2.82, 1.06], [2.9, 0.8]], hw0: 1.12,
        cl: { fx: 0.06, fz: 0.06, rx: 0.06, rz: 0.06 }, ch: { fx: 0.06, fz: 0.06, rx: 0.06, rz: 0.06 }, arches: [arR], bowF: 0 },
      b0: [-1.18, 0.4, -3.5], b1: [1.18, 2.9, 1.38], cell: 0.026,
      regions: () => {
        const tail = poly2([[0.82, 0.55], [0.84, 1.25], [1.2, 1.25], [1.2, 0.55]], 0.01), gT = (x, y, z) => Math.max(tail(Math.abs(x), y), z - (-3.45 + 0.12));
        const win = (x, y, z, nx, ny, nz) => Math.min(Math.max(Math.abs(z + 0.1) - 0.45, Math.abs(y - 2.05) - 0.3, -x, (0.5 - Math.abs(nx)) * 0.3), Math.max(Math.abs(Math.abs(x) - 0.45) - 0.36, Math.abs(y - 2.05) - 0.35, (0.5 + nz) * 0.3));
        return [
          { part: 'indicator_L', g: (x, y, z) => Math.max(gT(x, y, z), y - 0.75, -x) }, { part: 'indicator_R', g: (x, y, z) => Math.max(gT(x, y, z), y - 0.75, x) },
          { part: 'reverse', g: (x, y, z) => Math.max(gT(x, y, z), Math.abs(x) - 0.92) }, { part: 'taillight', g: gT },
          { part: 'glass', g: win }, { part: 'trim', g: (...a) => win(...a) - 0.03 },
          bat(0, 'livRed'), bat(1, 'livYel'), band(2.55, 2.66, 'livRed', 0.3),
          { part: 'liner', g: (x, y, z) => Math.hypot(z - arR.z, y - arR.y) - arR.R - 0.015 }, { part: 'black', g: (x, y) => y - 0.5 },
        ];
      },
    });
    return [cab, box_];
  },
  details: (X) => {
    const { add } = X;
    X.addLight(rb(1.5, 0.11, 0.26, 0.05, 0, 2.92, 1.12), 'siren'); add(rb(1.6, 0.05, 0.3, 0.02, 0, 2.86, 1.12), 'black');
    for (const sx of [-1, 1]) { X.addLight(rb(0.18, 0.1, 0.12, 0.04, sx * 0.95, 2.9, -3.3), 'siren'); X.addLight(box(0.12, 0.04, 0.02, sx * 0.2, 0.86, 3.46), 'siren'); }
    X.plate(1, 0.45); X.plate(-1, 0.5);
    for (const sx of [-1, 1]) { const h = X.side(sx, 1.42, 2.3); if (h) { add(rb(0.05, 0.05, 0.2, 0.02, h.p[0] + sx * 0.08, 1.42, 2.3), 'black'); add(rb(0.07, 0.38, 0.22, 0.03, sx * 1.2, 1.55, 2.32), 'black'); } }
    add(rb(0.04, 1.8, 0.03, 0.01, -1.125, 1.5, -0.4), 'trim'); X.ribbonSide(-1, -1.0, 0.55, 2.4, 0.01, 'trim', 6);
    add(box(0.012, 1.75, 0.01, 0, 1.45, -3.455), 'trim');
  },
};

// --- tow truck (Abschleppwagen, 7.5 t, flatbed) -------------------------------------------------
const TOW = {
  id: 'tow', label: 'Abschleppwagen', category: 'truck', L: 7.6, W: 2.3, H: 2.95, r: 0.42, tyreW: 0.26, axles: [2.95, -1.25], color: 0xe2661b, mass: 7000, power: 0.7, sillUD: 0.55,
  rimStyle: 'truck', rim: 0xd2d5d8, rimRatio: 0.6, wheelX: 0.95, cell: 0.024, err: 0.0025, seatX: 0.38,
  interior: { seatZ: 2.72, seatY: 1.55, dashZ: 3.4, dashY: 1.8, inW: 1.0 },
  parts: { bed: [0x8c9196, CLS.metal], frame: [0x1a1b1d, CLS.matte], stripe: [0xf2f2f0, CLS.paint] },
  ud: { sirenColors: [0xff9a00, 0xffb400] },
  bodies: () => {
    const arF = { z: 2.95, y: 0.42, R: 0.5 };
    const cab = simpleBody({
      def: { poly: [[3.65, 0.45, 1], [3.8, 0.55], [3.82, 1.0], [3.8, 1.55], [3.72, 2.4], [3.6, 2.66], [3.38, 2.76], [2.2, 2.76], [2.05, 2.7], [2.0, 2.5], [2.0, 0.5, 1], [3.65, 0.45, 1]],
        sec: [[0.45, 1.06], [0.55, 1.13], [2.4, 1.13], [2.62, 1.07], [2.8, 0.8]], hw0: 1.13, cl: { fx: 0.12, fz: 0.12, rx: 0.05, rz: 0.05 }, ch: { fx: 0.12, fz: 0.12, rx: 0.05, rz: 0.05 }, arches: [arF], bowF: 0.04 },
      b0: [-1.2, 0.4, 1.95], b1: [1.2, 2.82, 3.88],
      regions: (B) => cabRegions(B, { head: [[0.62, 0.56], [0.62, 0.72], [1.05, 0.74], [1.05, 0.56]], headDepth: 0.25, indX: 0.88, grille: [[0, 0.86], [0, 1.4], [0.72, 1.4], [0.72, 0.86]], wsBot: 1.62, wsTop: 2.5,
        side: [[2.2, 1.66], [2.2, 2.42], [3.4, 2.42], [3.55, 1.66]], arches: [arF], lowY: 0.5, livery: [band(1.45, 1.53, 'stripe')] }),
    });
    return [cab];
  },
  details: (X) => {
    const { add } = X;
    add(box(0.9, 0.25, 5.9, 0, 0.75, -0.9), 'frame'); // chassis rails
    add(rb(2.3, 0.12, 5.6, 0.02, 0, 1.18, -1.0, 0.02), 'bed'); // tilting plateau
    for (const sx of [-1, 1]) { add(rb(0.06, 0.14, 5.6, 0.01, sx * 1.15, 1.28, -1.0, 0.02), 'paint'); add(rb(0.6, 0.06, 1.3, 0.03, sx * 0.95, 1.02, -1.25), 'frame'); }
    add(rb(2.3, 1.3, 0.08, 0.02, 0, 1.9, 1.75), 'bed'); for (let i = 0; i < 4; i++) add(box(2.2, 0.04, 0.1, 0, 1.4 + i * 0.3, 1.78), 'frame'); // headboard
    add(rb(0.5, 0.35, 0.5, 0.05, 0, 1.4, 1.35), 'frame'); add(cyl(0.12, 0.12, 0.45, 0, 1.45, 1.05, 14, 0, Math.PI / 2), 'chrome'); // winch
    add(box(2.0, 0.12, 0.12, 0, 0.5, -3.75), 'frame'); // underride bar
    X.addLight(rb(1.5, 0.11, 0.28, 0.05, 0, 2.84, 3.0), 'siren'); add(rb(1.6, 0.05, 0.3, 0.02, 0, 2.78, 3.0), 'black');
    for (const sx of [-1, 1]) {
      X.addLight(rb(0.22, 0.1, 0.03, 0.02, sx * 0.85, 0.74, -3.79), 'taillight'); X.addLight(rb(0.12, 0.1, 0.03, 0.02, sx * 1.04, 0.74, -3.79), sx > 0 ? 'indicator_L' : 'indicator_R');
      add(rb(0.38, 0.14, 0.05, 0.02, sx * 0.92, 0.74, -3.76), 'frame');
      const h = X.side(sx, 2.0, 3.6); if (h) { add(rb(0.06, 0.06, 0.25, 0.02, h.p[0] + sx * 0.1, 2.0, 3.55), 'black'); add(rb(0.07, 0.42, 0.24, 0.03, sx * 1.3, 2.05, 3.55), 'black'); }
    }
    X.plate(1, 0.45); X.plateAt(-1, 0, 0.55, -3.81);
  },
};

// --- delivery scooter -----------------------------------------------------------------------------
const SCOOTER = {
  id: 'scooter', label: 'Lieferroller', category: 'scooter', L: 1.85, W: 0.72, H: 1.3, r: 0.23, tyreW: 0.055, axles: [0.62, -0.6], color: 0x2f5f8a, mass: 200, power: 0.8, sillUD: 0.28,
  rimStyle: 'spoke5', rim: 0x3a3d42, rimRatio: 0.6, seatX: 0, seatY: 0.69, seatZ: -0.2, ud: { physTrack: 0.6 },
  wheels: [['wheel_FL', 0.029, 0.62], ['wheel_FR', -0.029, 0.62], ['wheel_RL', 0.029, -0.6], ['wheel_RR', -0.029, -0.6]],
  parts: { box: [0xe0581c, CLS.gloss], seatP: [0x151515, CLS.interior] },
  details: (X) => {
    const { add } = X;
    add(rb(0.34, 0.08, 0.72, 0.03, 0, 0.33, 0.0), 'paint'); // footboard
    add(rb(0.38, 0.34, 0.78, 0.13, 0, 0.56, -0.38), 'paint'); // rear body
    add(rb(0.3, 0.1, 0.62, 0.045, 0, 0.78, -0.28), 'seatP');
    add(rb(0.44, 0.66, 0.12, 0.055, 0, 0.66, 0.45, -0.22), 'paint'); // leg shield
    add(rb(0.16, 0.07, 0.4, 0.03, 0, 0.5, 0.64), 'paint'); // front mudguard
    for (const sx of [-1, 1]) add(cyl(0.018, 0.018, 0.5, sx * 0.075, 0.42, 0.66, 8, -0.3), 'chrome'); // fork
    add(cyl(0.03, 0.03, 0.5, 0, 0.86, 0.56, 8, -0.3), 'black'); // steering column
    add(rb(0.62, 0.035, 0.04, 0.015, 0, 1.08, 0.5), 'black');
    add(rb(0.26, 0.12, 0.16, 0.05, 0, 1.05, 0.56), 'paint');
    X.addLight(rb(0.14, 0.07, 0.03, 0.02, 0, 1.03, 0.645), 'headlight');
    X.glass(rb(0.3, 0.3, 0.012, 0.02, 0, 1.25, 0.6, -0.35));
    for (const sx of [-1, 1]) {
      X.addLight(rb(0.04, 0.03, 0.05, 0.01, sx * 0.33, 1.08, 0.5), sx > 0 ? 'indicator_L' : 'indicator_R');
      X.addLight(rb(0.05, 0.03, 0.04, 0.01, sx * 0.14, 0.62, -0.79), sx > 0 ? 'indicator_L' : 'indicator_R');
      add(cyl(0.008, 0.008, 0.25, sx * 0.27, 1.2, 0.5, 6), 'black'); add(rb(0.08, 0.05, 0.01, 0.01, sx * 0.27, 1.32, 0.5), 'chrome');
    }
    X.addLight(rb(0.16, 0.06, 0.03, 0.02, 0, 0.66, -0.78), 'taillight');
    add(rb(0.5, 0.03, 0.42, 0.01, 0, 0.84, -0.58), 'black'); // rack
    add(rb(0.48, 0.44, 0.46, 0.04, 0, 1.08, -0.58), 'box'); add(rb(0.49, 0.03, 0.47, 0.01, 0, 1.24, -0.58), 'black');
    add(cyl(0.025, 0.03, 0.35, -0.16, 0.3, -0.55, 10, Math.PI / 2), 'chrome');
  },
};

/** Common car spec builder. */
function car(o) {
  const s = { category: 'car', bodies: carBody, details: carDetails, cell: 0.016, ...o };
  return s;
}
const roofBar = (z, siren) => (X) => {
  const h = X.top(0, z); if (!h) return; const y = h.p[1];
  if (siren) { X.add(rb(1.2, 0.05, 0.3, 0.02, 0, y + 0.03, z), 'black'); for (const sx of [-1, 1]) X.addLight(rb(0.4, 0.1, 0.26, 0.04, sx * 0.38, y + 0.1, z), 'siren'); X.add(rb(0.36, 0.09, 0.24, 0.03, 0, y + 0.095, z), 'black'); }
  else { X.add(rb(0.62, 0.035, 0.24, 0.012, 0, y + 0.02, z), 'black'); const g = new THREE.CylinderGeometry(0.1, 0.12, 0.6, 4, 1); g.deleteAttribute('uv'); g.rotateY(Math.PI / 4); g.rotateZ(Math.PI / 2); g.scale(1, 0.95, 0.9); g.translate(0, y + 0.12, z); g.computeVertexNormals(); X.addLight(g, 'taxi_sign'); }
};

export const CARS = [
  car({ id: 'sedan', label: 'Limousine', L: 4.95, W: 1.87, H: 1.45, r: 0.335, tyreW: 0.235, axles: [1.6, -1.34], color: 0x1f2b3e, mass: 1600, power: 1.05, rimStyle: 'twin5', interior: SEDAN_I, p: SEDAN_P }),
  car({ id: 'taxi', label: 'Taxi', L: 4.95, W: 1.87, H: 1.46, r: 0.335, tyreW: 0.235, axles: [1.6, -1.34], color: 0xe6d7b0, mass: 1650, power: 0.95, rimStyle: 'aero', rim: 0xa9aeb4, interior: { ...SEDAN_I, seat: 0x232325, seat2: 0x303034 },
    p: { ...SEDAN_P, extra: roofBar(-0.3, false) } }),
  car({ id: 'hatchback', label: 'Kompaktwagen', L: 4.26, W: 1.79, H: 1.46, r: 0.32, tyreW: 0.215, axles: [1.27, -1.36], color: 0xb3261e, mass: 1250, power: 0.9, rimStyle: 'aero', rim: 0xd0d4d8,
    interior: { seatZ: 0.0, seatY: 0.56, dashZ: 0.62, dashY: 0.93, inW: 0.69, rear: true, rearZ: -0.85 },
    p: { ...SEDAN_P,
      poly: [[1.9, 0.17, 1], [2.08, 0.24], [2.13, 0.42], [2.12, 0.58], [2.05, 0.68], [1.85, 0.75], [1.3, 0.86], [0.78, 0.95, 1], [0.45, 1.12], [0.1, 1.36], [-0.15, 1.44], [-0.7, 1.46], [-1.3, 1.43], [-1.7, 1.36], [-1.95, 1.2, 1],
        [-2.08, 0.98], [-2.13, 0.8], [-2.12, 0.5], [-2.08, 0.26], [-1.9, 0.17, 1], [0, 0.16, 1], [1.9, 0.17, 1]],
      sec: [[0.12, 0.77], [0.2, 0.85], [0.3, 0.875], [0.55, 0.895], [0.78, 0.89], [0.9, 0.875], [0.96, 0.855], [0.99, 0.82], [1.05, 0.79], [1.3, 0.7], [1.42, 0.63], [1.5, 0.5]],
      deckY: 1.0, tailTop: 0.98, ch: { fx: 0.12, fz: 0.25, rx: 0.12, rz: 0.15 },
      win: { aOff: 0.28, cOff: 0.34, topOff: 0.06, wsTop: 1.38, rwBot: 1.03, rwTop: 1.38, pw: 0.06, pillars: [{ z: -0.22, w: 0.045, slant: 0.1 }] },
      lamps: { ...SEDAN_P.lamps, head: [[0.38, 0.6], [0.41, 0.68], [1.1, 0.73], [1.1, 0.62]], tail: [[0.52, 0.88], [0.54, 1.0], [1.1, 1.0], [1.1, 0.86]], tailIndY: 0.9, revX: 0.6, grille: [[0, 0.5], [0, 0.62], [0.32, 0.62], [0.3, 0.5]] },
      seams: [0.86, -0.22, -0.98], handles: [0.15, -0.66], mirrorZ: 0.6, antennaZ: -1.3, plateR: 0.66, exhaust: [-0.5], cbl: [-1.88, -0.03] } }),
  car({ id: 'estate', label: 'Kombi', L: 4.95, W: 1.87, H: 1.48, r: 0.335, tyreW: 0.235, axles: [1.6, -1.34], color: 0x4b5a3c, mass: 1700, power: 1, rimStyle: 'twin5', interior: ESTATE_I, p: ESTATE_P }),
  car({ id: 'suv', label: 'SUV', L: 4.75, W: 1.93, H: 1.7, r: 0.37, tyreW: 0.255, axles: [1.5, -1.35], color: 0x2d2f33, mass: 2100, power: 1.15, rimStyle: 'twin5', rimRatio: 0.64, rim: 0x6a6e74,
    interior: { seatZ: 0.05, seatY: 0.8, dashZ: 0.82, dashY: 1.14, inW: 0.75, rear: true, rearZ: -0.85, seat: 0x6b5644, seat2: 0x4f4034, cover: [-2.15, -1.3, 1.2] },
    parts: { clad: [0x1c1d20, CLS.matte] },
    p: { ...ESTATE_P,
      poly: [[2.15, 0.3, 1], [2.33, 0.38], [2.375, 0.58], [2.36, 0.8], [2.28, 0.9], [2.05, 0.96], [1.5, 1.05], [0.95, 1.12, 1], [0.6, 1.32], [0.3, 1.56], [0, 1.65], [-0.6, 1.7], [-1.6, 1.68], [-2.1, 1.62], [-2.3, 1.5, 1],
        [-2.35, 1.15], [-2.375, 0.9], [-2.37, 0.6], [-2.32, 0.38], [-2.15, 0.3, 1], [0, 0.28, 1], [2.15, 0.3, 1]],
      sec: [[0.27, 0.84], [0.35, 0.92], [0.5, 0.955], [0.75, 0.965], [0.95, 0.96], [1.08, 0.945], [1.14, 0.925], [1.17, 0.885], [1.23, 0.85], [1.5, 0.76], [1.64, 0.68], [1.75, 0.5]],
      beltY: 1.15, cowlY: 1.12, deckY: 1.15, noseTop: 0.92, tailTop: 1.12, flare: 0.02, archGap: 0.07,
      win: { aOff: 0.3, cOff: 0.3, topOff: 0.07, wsTop: 1.6, rwBot: 1.2, rwTop: 1.62, pw: 0.06, pillars: [{ z: -0.15, w: 0.05, slant: 0.1 }, { z: -1.3, w: 0.06, slant: -0.15 }] },
      lamps: { head: [[0.42, 0.82], [0.45, 0.9], [1.2, 0.95], [1.2, 0.83]], headDepth: 0.42, indX: 0.86, tail: [[0.5, 1.05], [0.52, 1.15], [1.2, 1.18], [1.2, 1.03]], tailDepth: 0.32, tailIndY: 1.07, revX: 0.6,
        grille: [[0, 0.58], [0, 0.88], [0.4, 0.88], [0.38, 0.58]], intake: [[0, 0.4], [0, 0.5], [0.65, 0.52], [0.67, 0.4]] },
      livery: () => [{ part: 'clad', g: (x, y, z) => Math.min(...[1.5, -1.35].map((az) => Math.hypot(z - az, y - 0.37) - 0.5)) }],
      lowerPart: 'clad', lowY: 0.42, seams: [1.0, -0.15, -1.05], handles: [0.3, -0.62], mirrorZ: 0.7, plateF: 0.52, plateR: 0.85, rails: [-0.1, -2.0, 0.6], railPart: 'trim', cbl: [-2.25, -0.03], exhaust: [-0.6, 0.6] } }),
  car({ id: 'coupe', label: 'Sportcoupé', L: 4.6, W: 1.9, H: 1.3, r: 0.35, tyreW: 0.275, axles: [1.45, -1.25], color: 0xc9cbd0, mass: 1450, power: 1.6, rimStyle: 'multi10', rimRatio: 0.74, rim: 0x3a3d42,
    interior: { seatZ: -0.2, seatY: 0.45, dashZ: 0.52, dashY: 0.8, inW: 0.72, seat: 0x7a1d18, seat2: 0x1c1c1e },
    p: { ...SEDAN_P,
      poly: [[2.05, 0.13, 1], [2.25, 0.2], [2.3, 0.36], [2.28, 0.52], [2.2, 0.6], [2.0, 0.66], [1.3, 0.78], [0.75, 0.86, 1], [0.4, 1.02], [0.05, 1.24], [-0.35, 1.3], [-0.75, 1.27], [-1.25, 1.12], [-1.75, 0.95, 1],
        [-2.1, 0.92], [-2.28, 0.88], [-2.3, 0.72], [-2.28, 0.45], [-2.22, 0.22], [-2.05, 0.13, 1], [0, 0.12, 1], [2.05, 0.13, 1]],
      sec: [[0.1, 0.82], [0.18, 0.9], [0.3, 0.94], [0.5, 0.95], [0.7, 0.945], [0.82, 0.93], [0.87, 0.9], [0.9, 0.86], [0.96, 0.82], [1.18, 0.7], [1.28, 0.6], [1.35, 0.4]],
      beltY: 0.88, cowlY: 0.86, deckY: 0.95, noseTop: 0.62, tailTop: 0.9, flare: 0.022, cl: { fx: 0.32, fz: 0.45, rx: 0.26, rz: 0.32 }, ch: { fx: 0.14, fz: 0.3, rx: 0.14, rz: 0.3 },
      win: { aOff: 0.3, cOff: 0.25, topOff: 0.06, wsTop: 1.24, rwBot: 0.98, rwTop: 1.26, pw: 0.05, pillars: [] },
      lamps: { head: [[0.4, 0.53], [0.43, 0.6], [1.1, 0.66], [1.1, 0.55]], headDepth: 0.42, indX: 0.84, tail: [[0.3, 0.78], [0.32, 0.86], [1.1, 0.89], [1.1, 0.76]], tailDepth: 0.3, tailIndY: 0.79, revX: 0.42,
        grille: [[0, 0.4], [0, 0.56], [0.3, 0.56], [0.28, 0.4]], intake: [[0, 0.18], [0, 0.3], [0.7, 0.32], [0.72, 0.18]] },
      seams: [0.98, -0.4], handles: [-0.28], mirrorZ: 0.5, antennaZ: null, plateF: 0.3, plateR: 0.55, exhaust: [-0.75, -0.62, 0.62, 0.75], cbl: null, lowY: 0.17 } }),
  car({ id: 'van', label: 'Transporter', L: 5.0, W: 1.95, H: 1.98, r: 0.35, tyreW: 0.225, axles: [1.65, -1.6], color: 0xf1f1ee, mass: 2400, power: 0.85, rimStyle: 'steel', rimRatio: 0.62, rim: 0xb9bdc2,
    interior: { seatZ: 1.0, seatY: 0.98, dashZ: 1.55, dashY: 1.27, inW: 0.8 }, parts: { livRed: [0xd13b2a, CLS.paint] },
    p: { ...SEDAN_P,
      poly: [[2.3, 0.22, 1], [2.46, 0.3], [2.5, 0.5], [2.49, 0.72], [2.42, 0.88], [2.25, 0.98], [1.95, 1.05], [1.7, 1.12, 1], [1.35, 1.45], [1.0, 1.78], [0.7, 1.93], [0.2, 1.98], [-1.5, 1.98], [-2.35, 1.96], [-2.48, 1.88, 1],
        [-2.5, 1.2], [-2.5, 0.5], [-2.46, 0.3], [-2.3, 0.22, 1], [0, 0.21, 1], [2.3, 0.22, 1]],
      sec: [[0.2, 0.88], [0.3, 0.95], [0.5, 0.975], [1.0, 0.975], [1.1, 0.97], [1.15, 0.96], [1.6, 0.94], [1.9, 0.9], [1.98, 0.85], [2.05, 0.6]], wedge: 0, bowR: 0.02,
      beltY: 1.12, cowlY: 1.12, deckY: 1.9, noseTop: 0.95, tailTop: 1.9, cl: { fx: 0.25, fz: 0.3, rx: 0.08, rz: 0.08 }, ch: { fx: 0.2, fz: 0.25, rx: 0.08, rz: 0.08 },
      win: { aOff: 0.25, cOff: 0.3, topOff: 0.12, wsTop: 1.86, rwBot: 1.25, rwTop: 1.85, pw: 0.12, pillars: [{ z: -1.25, w: 1.75 }] },
      lamps: { head: [[0.45, 0.82], [0.48, 0.94], [1.2, 0.98], [1.2, 0.84]], headDepth: 0.4, indX: 0.86, tail: [[0.82, 0.6], [0.84, 1.15], [1.2, 1.15], [1.2, 0.6]], tailDepth: 0.12, tailIndY: 0.75, revX: 0.88,
        grille: [[0, 0.62], [0, 0.92], [0.45, 0.92], [0.43, 0.62]], intake: [[0, 0.3], [0, 0.44], [0.6, 0.45], [0.62, 0.3]] },
      livery: () => [band(0.93, 1.0, 'livRed')],
      seams: [1.08, 0.35, -0.95], handles: [0.6, -0.15], mirrorZ: 1.25, antennaZ: null, plateF: 0.45, plateR: 0.5, exhaust: [-0.6], cbl: [-2.2, -0.04], lowY: 0.32,
      extra: (X) => { X.add(box(1.7, 1.2, 0.05, 0, 1.0, 0.5), [0.09, 0.09, 0.09, CLS.interior / 15]); X.add(box(0.012, 1.55, 0.01, 0, 1.15, -2.505), 'trim'); } } }),
  car({ id: 'police', label: 'Polizei', L: 4.95, W: 1.87, H: 1.48, r: 0.335, tyreW: 0.235, axles: [1.6, -1.34], color: 0xc9ced3, mass: 1750, power: 1.25, rimStyle: 'spoke5', rim: 0xaab0b6, interior: { ...ESTATE_I, seat: 0x2b2c2f, seat2: 0x1f2022 },
    parts: { livBlue: [0x1d4aa0, CLS.paint] },
    p: { ...ESTATE_P, mirrorPart: 'livBlue',
      livery: (_b, { belt }) => [{ part: 'livBlue', g: (x, y, z, nx) => Math.max(y - (belt(z) - 0.1), 0.34 - y, (0.6 - Math.abs(nx)) * 0.3) }],
      extra: (X) => { roofBar(-0.1, true)(X); for (const sx of [-1, 1]) X.addLight(box(0.1, 0.03, 0.02, sx * 0.25, 0.44, 2.48), 'siren'); } } }),
  BUS, AMB, TOW, SCOOTER,
];

export function makeCar(s) { return build(s); }
