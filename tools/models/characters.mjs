// Character generator: skinned, rigged humanoids with outfit/hair/accessory variants + animation clips.
// Exports makeCharacter(female), PAL_KEYS, PARTS.
//
// One SkinnedMesh per gender (single skin, 21 bones). The vertex buffer holds every variant ("part") at
// two levels of detail; the game builds per-outfit index buffers from the part ids, so an instance draws
// only its own clothes/hair/accessories in one draw call.
// Vertex attributes:
//   color      exactly one entry of mesh.userData.palette (legacy contract / nearest-match recolouring)
//   _CHAR      custom vec4 (three.js attribute "_char"): x = palette index / 31 (order: userData.palKeys),
//              y = (part + 64 * lod) / 255, z = baked ambient occlusion, w = skin redness (nose / ears)
// Rig: hips > spine > chest > neck > head, chest > shoulder > upperarm > forearm > hand,
// hips > thigh > shin > foot > toe. Rest pose: standing, arms straight down, facing +Z, feet at y=0.
// Clips are sampled by posing the real bones; walk/run/idle/sit use two-bone IK so planted feet stay fixed
// (walk authored for 1.45 m/s, run 6 m/s, jog 3 m/s, walk_senior 1.0 m/s, cycle 5 m/s).
// Hand-held accessories (umbrella, phone, cup) are authored in a "hold" arm pose whose local bone
// rotations are exported in userData.holds; the game applies them on top of the clips while shown.
import { THREE, mergeVertices } from './common.mjs';

const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;
const gauss = (x, m, s) => Math.exp(-0.5 * ((x - m) / s) ** 2);

export const PAL_KEYS = ['skin', 'hair', 'top', 'jacket', 'pants', 'shoes', 'eyes', 'lips', 'sole', 'sclera', 'accent', 'hat', 'bag', 'metal', 'legwear', 'socks', 'umbrella', 'belt', 'bike'];
export const PARTS = ['core', 'torso', 'arms_top', 'arms_short', 'arms_jacket', 'arms_puffer', 'legs_trousers', 'legs_shorts', 'legs_skirt', 'legs_tights',
  'jacket_open', 'suit', 'collar', 'tie', 'coat', 'puffer', 'hoodie', 'shoes_sneaker', 'shoes_dress', 'shoes_boot',
  'hair_short', 'hair_side', 'hair_buzz', 'hair_bald', 'hair_curly', 'hair_bob', 'hair_long', 'hair_ponytail', 'hair_bun', 'hair_pixie', 'beard', 'mustache',
  'hat_beanie', 'hat_cap', 'hat_flatcap', 'hat_sunhat', 'hat_peak', 'glasses', 'scarf', 'backpack', 'crossbody', 'briefcase', 'shopbag', 'cup', 'phone', 'camera', 'umbrella', 'headphones', 'bicycle'];
const PID = Object.fromEntries(PARTS.map((p, i) => [p, i]));
const BASE_PARTS = ['core', 'torso', 'arms_top', 'legs_trousers', 'shoes_sneaker'].map((p) => PID[p]);

// ---------------------------------------------------------------------------------------------
// mesh builder: indexed geometry with position / normal / colour-name / skin weights / part / lod
// ---------------------------------------------------------------------------------------------
class Builder {
  constructor() { this.pos = []; this.nrm = []; this.col = []; this.w = []; this.idx = []; this.part = []; this.lod = []; this.red = []; this.P = { part: 0, lod: 0, red: 0 }; }
  vert(p, n, col, w) {
    this.pos.push(p.x, p.y, p.z); this.nrm.push(n.x, n.y, n.z); this.col.push(col); this.w.push(w);
    this.part.push(this.P.part); this.lod.push(this.P.lod); this.red.push(this.P.red); return this.pos.length / 3 - 1;
  }
  at(part, fn, red = 0) { const o = this.P.part, r = this.P.red; this.P.part = PID[part]; this.P.red = red; if (this.P.part == null) throw new Error('part ' + part); fn(); this.P.part = o; this.P.red = r; }
  // triangle with winding chosen so the face normal agrees with the vertex normals
  tri(a, b, c) {
    const P = (i) => V3(this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]);
    const N = (i) => V3(this.nrm[i * 3], this.nrm[i * 3 + 1], this.nrm[i * 3 + 2]);
    const pa = P(a), fn = P(b).sub(pa).cross(P(c).sub(pa));
    if (fn.lengthSq() < 1e-14) return;
    if (fn.dot(N(a).add(N(b)).add(N(c))) < 0) this.idx.push(a, c, b); else this.idx.push(a, b, c);
  }
  // rows: [{ pts: Vector3[], col, w: weights | (p)=>weights, red? }]; row k's colour paints segment k..k+1
  loft(rows, closed = true, inward = false) {
    const R = rows.length, m = rows[0].pts.length;
    const P = (i, j) => rows[Math.max(0, Math.min(R - 1, i))].pts[closed ? (j + m) % m : Math.max(0, Math.min(m - 1, j))];
    const nr = rows.map((row, i) => {
      const c = row.pts.reduce((a, p) => a.add(p), V3()).multiplyScalar(1 / m);
      const spread = row.pts.reduce((a, p) => Math.max(a, p.distanceTo(c)), 0);
      return row.pts.map((p, j) => {
        const du = P(i, j + 1).clone().sub(P(i, j - 1)), dv = P(i + 1, j).clone().sub(P(i - 1, j));
        let n = du.cross(dv);
        if (spread < 1e-4 || n.lengthSq() < 1e-12) { // collapsed (cap) row: point along the axis
          const other = rows[i === 0 ? 1 : R - 2].pts.reduce((a, q) => a.add(q), V3()).multiplyScalar(1 / m);
          n = c.clone().sub(other);
        } else if (n.dot(p.clone().sub(c)) < 0) n.negate();
        return inward ? n.normalize().negate() : n.normalize();
      });
    });
    const cache = new Map();
    const v = (i, j, col) => {
      const k = i + '|' + j + '|' + col; if (cache.has(k)) return cache.get(k);
      const row = rows[i], p = row.pts[j]; const r0 = this.P.red; if (row.red != null) this.P.red = row.red;
      const id = this.vert(p, nr[i][j], col, typeof row.w === 'function' ? row.w(p) : row.w); this.P.red = r0; cache.set(k, id); return id;
    };
    for (let i = 0; i < R - 1; i++) {
      const col = rows[i].col;
      for (let j = 0; j < (closed ? m : m - 1); j++) {
        const j2 = (j + 1) % m;
        const a = v(i, j, col), b = v(i + 1, j, col), c = v(i + 1, j2, col), d = v(i, j2, col);
        this.tri(a, b, c); this.tri(a, c, d);
      }
    }
  }
  // any three.js geometry (uv dropped, welded); w: weights | (p)=>weights
  geo(g, col, w) {
    g = g.clone(); for (const k of Object.keys(g.attributes)) if (k !== 'position') g.deleteAttribute(k);
    g = mergeVertices(g.index ? g.toNonIndexed() : g); g.computeVertexNormals();
    const p = g.attributes.position, n = g.attributes.normal, map = [];
    for (let i = 0; i < p.count; i++) { const q = V3().fromBufferAttribute(p, i); map.push(this.vert(q, V3().fromBufferAttribute(n, i), col, typeof w === 'function' ? w(q) : w)); }
    const ix = g.index.array; for (let i = 0; i < ix.length; i += 3) this.idx.push(map[ix[i]], map[ix[i + 1]], map[ix[i + 2]]);
  }
  // tube along a polyline (rings perpendicular to the path); rads: number | number[]; flat: squash factor of the ring's 2nd axis
  tube(pts, rads, n, col, w, { cap0 = true, cap1 = true, flat = 1, up = null } = {}) {
    const rows = [], R = (i) => (Array.isArray(rads) ? rads[i] : rads);
    let ref = up ? up.clone() : V3(0, 0, 1);
    for (let i = 0; i < pts.length; i++) {
      const t = pts[Math.min(i + 1, pts.length - 1)].clone().sub(pts[Math.max(i - 1, 0)]).normalize();
      if (Math.abs(t.dot(ref)) > 0.95) ref = Math.abs(t.y) < 0.9 ? V3(0, 1, 0) : V3(1, 0, 0);
      const u = V3().crossVectors(t, ref).normalize(), vv = V3().crossVectors(u, t).normalize();
      const ring = [];
      for (let j = 0; j < n; j++) { const a = (j / n) * Math.PI * 2; ring.push(pts[i].clone().addScaledVector(u, Math.cos(a) * R(i)).addScaledVector(vv, Math.sin(a) * R(i) * flat)); }
      rows.push({ pts: ring, col, w });
    }
    if (cap0) rows.unshift({ pts: rows[0].pts.map(() => pts[0].clone()), col, w });
    if (cap1) rows.push({ pts: rows[0].pts.map(() => pts[pts.length - 1].clone()), col, w });
    this.loft(rows);
  }
  build(palette, boneIndex, ao) {
    const n = this.pos.length / 3, col = new Float32Array(n * 3), si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
    const ch = new Float32Array(n * 4);
    const cols = Object.fromEntries(Object.entries(palette).map(([k, h]) => [k, new THREE.Color(h)]));
    for (let i = 0; i < n; i++) {
      const c = cols[this.col[i]]; if (!c) throw new Error('no palette colour ' + this.col[i]);
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      ch[i * 4] = PAL_KEYS.indexOf(this.col[i]) / 31; ch[i * 4 + 1] = (this.part[i] + 64 * this.lod[i]) / 255; ch[i * 4 + 2] = ao[i]; ch[i * 4 + 3] = this.red[i];
      const ws = [...this.w[i]].filter(e => e[1] > 1e-3).sort((a, b) => b[1] - a[1]).slice(0, 4); const tot = ws.reduce((a, e) => a + e[1], 0);
      ws.forEach(([b, w], k) => { si[i * 4 + k] = boneIndex(b); sw[i * 4 + k] = w / tot; });
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute('char', new THREE.Float32BufferAttribute(ch, 4));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4)); g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
    g.setIndex(this.idx); g.computeBoundingBox(); g.computeBoundingSphere(); return g;
  }
}
// smooth weights along a chain: bones[k] lies above joints[k] = [v, halfBlend], bones[k+1] below
function chainW(v, bones, joints) {
  const t = joints.map(([jv, b]) => sstep(jv + b, jv - b, v));
  return bones.map((b, k) => [b, (k === 0 ? 1 : t[k - 1]) * (k === bones.length - 1 ? 1 : 1 - t[k])]).filter(e => e[1] > 1e-3);
}
// horizontal ring (XZ plane) at height y; theta = 0 is the front (+Z). open: leaves a front gap of +-a0
function ringXZ(cx, y, cz, rx, rzF, rzB, n, e = 1, a0 = 0) {
  const pts = []; const cnt = a0 ? n + 1 : n;
  for (let j = 0; j < cnt; j++) {
    const th = a0 ? a0 + (2 * Math.PI - 2 * a0) * j / n : 2 * Math.PI * j / n;
    const s = Math.sin(th), c = Math.cos(th), ps = Math.sign(s) * Math.abs(s) ** e, pc = Math.sign(c) * Math.abs(c) ** e;
    pts.push(V3(cx + rx * ps, y, cz + (c > 0 ? rzF : rzB) * pc));
  }
  return pts;
}
// rounded box
function rbox2(w, h, d, r, seg = 2) {
  const g = new THREE.BoxGeometry(w, h, d, seg, seg, seg); const p = g.attributes.position; const v = V3();
  for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i); const hx = w / 2 - r, hy = h / 2 - r, hz = d / 2 - r;
    const c = V3(Math.max(-hx, Math.min(hx, v.x)), Math.max(-hy, Math.min(hy, v.y)), Math.max(-hz, Math.min(hz, v.z))); const n = v.clone().sub(c); if (n.lengthSq() > 1e-12) n.setLength(r); p.setXYZ(i, c.x + n.x, c.y + n.y, c.z + n.z); }
  return g;
}
const at = (g, x, y, z) => { g.translate(x, y, z); return g; };
const sph = (r, sx, sy, sz, ws = 10, hs = 8) => { const g = new THREE.SphereGeometry(r, ws, hs); g.scale(sx, sy, sz); return g; };
const cylAB = (a, b, r0, r1, seg = 8) => { // cylinder from point a to point b
  const d = b.clone().sub(a), L = d.length(); const g = new THREE.CylinderGeometry(r1, r0, L, seg, 1);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(V3(0, 1, 0), d.normalize())); g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2); return g;
};

// ---------------------------------------------------------------------------------------------
// baked ambient occlusion: voxelise the base outfit, march short rays from every vertex
// ---------------------------------------------------------------------------------------------
function bakeAO(B) {
  const vs = 0.01, ox = -0.8, oy = -0.05, oz = -0.95, nx = 160, ny = 235, nz = 190;
  const grid = new Uint8Array(nx * ny * nz);
  const cell = (x, y, z) => { const i = Math.floor((x - ox) / vs), j = Math.floor((y - oy) / vs), k = Math.floor((z - oz) / vs); return i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz ? -1 : (j * nz + k) * nx + i; };
  const P = B.pos, base = new Set(BASE_PARTS);
  for (let t = 0; t < B.idx.length; t += 3) {
    const a = B.idx[t], b = B.idx[t + 1], c = B.idx[t + 2];
    if (B.lod[a] !== 0 || !base.has(B.part[a])) continue;
    const A = V3(P[a * 3], P[a * 3 + 1], P[a * 3 + 2]), Bv = V3(P[b * 3], P[b * 3 + 1], P[b * 3 + 2]), C = V3(P[c * 3], P[c * 3 + 1], P[c * 3 + 2]);
    const steps = Math.ceil(Math.max(A.distanceTo(Bv), A.distanceTo(C), Bv.distanceTo(C)) / (vs * 0.6)) + 1;
    for (let i = 0; i <= steps; i++) for (let j = 0; j <= steps - i; j++) {
      const u = i / steps, v = j / steps, w = 1 - u - v;
      const k = cell(A.x * w + Bv.x * u + C.x * v, A.y * w + Bv.y * u + C.y * v, A.z * w + Bv.z * u + C.z * v); if (k >= 0) grid[k] = 1;
    }
  }
  const dirs = []; for (let i = 0; i < 40; i++) { const y = 1 - (2 * (i + 0.5)) / 40, r = Math.sqrt(1 - y * y), ph = i * 2.39996; dirs.push(V3(Math.cos(ph) * r, y, Math.sin(ph) * r)); }
  const n = B.pos.length / 3, ao = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = V3(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]), nn = V3(B.nrm[i * 3], B.nrm[i * 3 + 1], B.nrm[i * 3 + 2]);
    let occ = 0, tot = 0;
    for (const d of dirs) {
      const c = d.dot(nn); if (c < 0.3) continue; tot += c;
      for (let t = 0.03; t < 0.26; t += 0.012) { const k = cell(p.x + d.x * t, p.y + d.y * t, p.z + d.z * t); if (k >= 0 && grid[k]) { occ += c * (1 - t / 0.3); break; } }
    }
    let a = tot ? 1 - Math.min(0.75, (occ / tot) * 1.15) : 1;
    a *= 0.8 + 0.2 * sstep(0.0, 0.4, p.y); // ground proximity
    ao[i] = a;
  }
  // smooth twice over the triangle graph
  for (let it = 0; it < 2; it++) {
    const s = new Float32Array(n), c = new Float32Array(n);
    for (let t = 0; t < B.idx.length; t += 3) for (let k = 0; k < 3; k++) { const a = B.idx[t + k]; for (let m = 0; m < 3; m++) { const b = B.idx[t + m]; s[a] += ao[b]; c[a]++; } }
    for (let i = 0; i < n; i++) if (c[i]) ao[i] = s[i] / c[i];
  }
  return ao;
}

// ---------------------------------------------------------------------------------------------
// pose machinery (shared by holds, accessories authored in a pose and the clips)
// ---------------------------------------------------------------------------------------------
function makePoser(bones, S) {
  const names = Object.keys(bones), hips = bones.hips, hy = 0.98 * S;
  const len = (n) => bones[n].position.length();
  const Ehelper = new THREE.Euler(), Q = () => new THREE.Quaternion();
  const qE = (x = 0, y = 0, z = 0) => Q().setFromEuler(Ehelper.set(x, y, z, 'XYZ'));
  const wq = (n) => bones[n].getWorldQuaternion(Q()), wpos = (n) => bones[n].getWorldPosition(V3());
  const basisQ = (X, Y, Z) => Q().setFromRotationMatrix(new THREE.Matrix4().makeBasis(X, Y, Z));
  const ah = 0.07 * S, heelOff = 0.075 * S, ballOff = 0.12 * S, toeH = 0.03 * S;
  // two-bone IK. upper/lower bones hang along -Y in rest; bendSign=+1: joint points toward pole (knee), -1: away (elbow)
  function twoBone(up, lo, end, target, pole, bendSign) {
    bones[up].parent.updateMatrixWorld(true);
    const A = wpos(up), L1 = len(lo), L2 = len(end);
    const D = target.clone().sub(A); let d = D.length(); const dir = D.normalize();
    d = Math.min(Math.max(d, Math.abs(L1 - L2) + 1e-3), (L1 + L2) * 0.9995);
    const pn = pole.clone().sub(dir.clone().multiplyScalar(pole.dot(dir))).normalize();
    const ca = (L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), sa = Math.sqrt(Math.max(0, 1 - ca * ca));
    const K = A.clone().add(dir.clone().multiplyScalar(L1 * ca)).add(pn.clone().multiplyScalar(L1 * sa)), T = A.clone().add(dir.clone().multiplyScalar(d));
    const Y1 = A.clone().sub(K).normalize(); let Z1 = pn.clone().multiplyScalar(bendSign); Z1.sub(Y1.clone().multiplyScalar(Z1.dot(Y1))).normalize();
    const X1 = Y1.clone().cross(Z1).normalize(); Z1 = X1.clone().cross(Y1);
    const qU = basisQ(X1, Y1, Z1); bones[up].quaternion.copy(wq(bones[up].parent.name).invert().multiply(qU));
    const Y2 = K.clone().sub(T).normalize(), Z2 = X1.clone().cross(Y2).normalize();
    const qL = basisQ(X1, Y2, Z2); bones[lo].quaternion.copy(qU.clone().invert().multiply(qL));
    bones[up].updateMatrixWorld(true);
    return qL;
  }
  const rotX = (v, a) => V3(v.x, v.y * Math.cos(a) - v.z * Math.sin(a), v.y * Math.sin(a) + v.z * Math.cos(a));
  const footAt = (x, g, a) => { // g: ankle z when the foot is flat; a: pitch (+ = toes down / heel up)
    if (a < 0) return V3(x, 0, g - heelOff).add(rotX(V3(0, ah, heelOff), a));
    return V3(x, toeH, g + ballOff).add(rotX(V3(0, ah - toeH, -ballOff), a));
  };
  // pose: { pos:[x,y,z], r:{ bone:[ex,ey,ez] }, legs:{ L:{ ankle, pitch, toe, yaw, pole } }, arms:{ L:{ wrist, pole } }, after:{ bone:[e] } }
  function apply(pose) {
    for (const n of names) bones[n].quaternion.identity();
    hips.position.set(...pose.pos);
    for (const [n, e] of Object.entries(pose.r || {})) bones[n].quaternion.copy(qE(...e));
    hips.updateMatrixWorld(true);
    for (const [sd, L] of Object.entries(pose.legs || {})) {
      const yaw = L.yaw || 0;
      const pole = L.pole || V3(Math.sin(yaw) + (sd === 'L' ? 0.08 : -0.08), 0, Math.cos(yaw)).normalize();
      const qS = twoBone('thigh.' + sd, 'shin.' + sd, 'foot.' + sd, L.ankle, pole, 1);
      const qF = qE(0, yaw, 0).multiply(qE(L.pitch || 0, 0, 0));
      bones['foot.' + sd].quaternion.copy(qS.invert().multiply(qF));
      bones['toe.' + sd].quaternion.copy(qE(L.toe || 0, 0, 0));
    }
    for (const [sd, A] of Object.entries(pose.arms || {})) twoBone('upperarm.' + sd, 'forearm.' + sd, 'hand.' + sd, A.wrist, A.pole, -1);
    for (const [n, e] of Object.entries(pose.after || {})) bones[n].quaternion.copy(qE(...e));
    hips.updateMatrixWorld(true);
  }
  function rest() { for (const n of names) bones[n].quaternion.identity(); hips.position.set(0, hy, 0); hips.updateMatrixWorld(true); }
  function hipsLimit(pose, sd, ankle) {
    const hq = qE(...(pose.r?.hips || [0, 0, 0])), off = bones['thigh.' + sd].position.clone().applyQuaternion(hq);
    const R = (len('shin.' + sd) + len('foot.' + sd)) * 0.985;
    const dx = pose.pos[0] + off.x - ankle.x, dz = pose.pos[2] + off.z - ankle.z;
    return ankle.y - off.y + Math.sqrt(Math.max(0, R * R - dx * dx - dz * dz));
  }
  function clip(name, dur, n, fn) {
    const times = [], tr = new Map(); const prev = {};
    for (let i = 0; i <= n; i++) {
      const u = i / n; times.push(dur * u); apply(fn(u));
      if (!tr.has('pos')) tr.set('pos', []); tr.get('pos').push(hips.position.x, hips.position.y, hips.position.z);
      for (const b of names) {
        const q = bones[b].quaternion.clone(); if (prev[b] && prev[b].dot(q) < 0) q.set(-q.x, -q.y, -q.z, -q.w); prev[b] = q;
        if (!tr.has(b)) tr.set(b, []); tr.get(b).push(q.x, q.y, q.z, q.w);
      }
    }
    const kt = [];
    for (const [b, vals] of tr) {
      if (b === 'pos') kt.push(new THREE.VectorKeyframeTrack('hips.position', times, vals));
      else {
        let still = true; for (let i = 0; i < vals.length; i += 4) if (Math.abs(vals[i + 3]) < 0.99999) { still = false; break; }
        if (!still || b === 'hips') kt.push(new THREE.QuaternionKeyframeTrack(b + '.quaternion', times, vals));
      }
    }
    return new THREE.AnimationClip(name, dur, kt);
  }
  return { bones, names, hips, hy, S, qE, apply, rest, hipsLimit, clip, footAt, wpos };
}

// ---------------------------------------------------------------------------------------------
// rigs shared with the game (male scale; female is the same rig scaled by 0.96)
// ---------------------------------------------------------------------------------------------
// bicycle: root on the ground under the crank axle, facing +Z
export const CYCLE_RIG = { bb: [0, 0.28, 0], crank: 0.17, saddle: [0, 0.92, -0.2], grips: [0.27, 1.03, 0.27], rearAxle: [0, 0.35, -0.55], frontAxle: [0, 0.35, 0.6], wheelR: 0.35, speed: 5 };
// bench: root on the ground right below the hip point (≈0.15 m behind the seat's front edge), facing away from the backrest
export const BENCH_RIG = { seatY: 0.45 };

// arm hold poses: wrist target (character space, male scale) + elbow pole
const HOLDS = {
  umbrella: { sd: 'R', wrist: [-0.15, 1.15, 0.27], pole: [-1, -0.5, -0.5] },
  phone: { sd: 'R', wrist: [-0.07, 1.13, 0.26], pole: [-1, -0.7, -0.2], extra: { neck: [0.18, 0, 0], head: [0.28, 0, 0] } },
  cup: { sd: 'L', wrist: [0.16, 1.07, 0.24], pole: [1, -0.6, -0.3] },
};
function holdPose(name, S) { const h = HOLDS[name]; return { pos: [0, 0.98 * S, 0], arms: { [h.sd]: { wrist: V3(...h.wrist).multiplyScalar(S), pole: V3(...h.pole).normalize() } } }; }
function cyclePose(P, u) {
  const { S, hy } = P, TAU = Math.PI * 2, sin = Math.sin, cos = Math.cos;
  const bb = V3(0, CYCLE_RIG.bb[1] * S, 0), cr = CYCLE_RIG.crank * S;
  const pose = { pos: [0, hy + 0.02 * S, -0.17 * S], r: {
    hips: [0.22, 0, 0], spine: [0.1 + 0.01 * sin(2 * u * TAU), 0, 0], chest: [0.08, 0.02 * sin(u * TAU), 0], neck: [-0.18, 0, 0], head: [-0.15, 0.08 * sin(u * TAU * 0.5), 0],
  } };
  pose.legs = {};
  for (const [sd, sx, ph] of [['L', 1, 0], ['R', -1, 0.5]]) {
    const a = (u + ph) * TAU; // 0 = crank forward-horizontal
    const pedal = bb.clone().add(V3(0, sin(a) * cr, cos(a) * cr));
    const pitch = -0.12 + 0.22 * sin(a + 0.6);
    pose.legs[sd] = { ankle: pedal.clone().add(V3(sx * 0.11 * S, 0.075 * S, -0.06 * S)), pitch, pole: V3(sx * 0.12, 0.3, 1).normalize() };
  }
  const g = CYCLE_RIG.grips;
  pose.arms = { L: { wrist: V3(g[0] * S, g[1] * S, g[2] * S), pole: V3(0.6, -0.6, -0.5).normalize() }, R: { wrist: V3(-g[0] * S, g[1] * S, g[2] * S), pole: V3(-0.6, -0.6, -0.5).normalize() } };
  pose.after = { 'hand.L': [-1.3, 0, -0.2], 'hand.R': [-1.3, 0, 0.2] };
  return pose;
}

// ---------------------------------------------------------------------------------------------
// CHARACTER
// ---------------------------------------------------------------------------------------------
export function makeCharacter(female) {
  const S = female ? 0.96 : 1;
  const bones = {};
  const mk = (name, parent, x, y, z) => { const b = new THREE.Bone(); b.name = name; b.position.set(x * S, y * S, z * S); if (parent) bones[parent].add(b); bones[name] = b; return b; };
  const hipW = female ? 0.098 : 0.095, shW = female ? 0.168 : 0.19;
  mk('hips', null, 0, 0.98, 0); mk('spine', 'hips', 0, 0.1, 0); mk('chest', 'spine', 0, 0.2, 0); mk('neck', 'chest', 0, 0.19, 0); mk('head', 'neck', 0, 0.1, 0);
  for (const [sd, sx] of [['L', 1], ['R', -1]]) {
    mk('shoulder.' + sd, 'chest', sx * 0.035, 0.14, -0.005); mk('upperarm.' + sd, 'shoulder.' + sd, sx * (shW - 0.035), 0.015, 0.005);
    mk('forearm.' + sd, 'upperarm.' + sd, 0, -0.285, 0); mk('hand.' + sd, 'forearm.' + sd, 0, -0.255, 0);
    mk('thigh.' + sd, 'hips', sx * hipW, -0.07, 0); mk('shin.' + sd, 'thigh.' + sd, 0, -0.42, 0); mk('foot.' + sd, 'shin.' + sd, 0, -0.42, 0); mk('toe.' + sd, 'foot.' + sd, 0, -0.04, 0.12);
  }
  const order = Object.keys(bones); const bi = (n) => { const i = order.indexOf(n); if (i < 0) throw new Error('bone ' + n); return i; };
  const root = bones.hips; const grp = new THREE.Group(); grp.add(root); root.updateMatrixWorld(true);
  const P = makePoser(bones, S);

  // hold poses: local arm rotations + matrix taking geometry authored in the posed world back to rest
  const holds = {}, holdM = {};
  for (const name of Object.keys(HOLDS)) {
    const h = HOLDS[name]; P.apply(holdPose(name, S));
    const q = {};
    for (const b of ['shoulder.', 'upperarm.', 'forearm.', 'hand.']) q[b + h.sd] = bones[b + h.sd].quaternion.toArray().map((v) => +v.toFixed(5));
    for (const [b, e] of Object.entries(h.extra || {})) q[b] = P.qE(...e).toArray().map((v) => +v.toFixed(5));
    holds[name] = q;
    const hand = bones['hand.' + h.sd]; const posed = hand.matrixWorld.clone(); P.rest(); const restM = hand.matrixWorld.clone();
    holdM[name] = { M: restM.multiply(posed.clone().invert()), posed };
  }
  P.apply(cyclePose(P, 0)); const hipsCycle = bones.hips.matrixWorld.clone(); P.rest();
  const bikeM = bones.hips.matrixWorld.clone().multiply(hipsCycle.invert());
  P.rest();
  const wp = (n) => V3().setFromMatrixPosition(bones[n].matrixWorld);

  const palette = female
    ? { skin: 0xc99272, hair: 0x5a3a22, top: 0xa83a4a, jacket: 0xd8cbb4, pants: 0x2a2f45, shoes: 0x6b3a2a, eyes: 0x4a3322, lips: 0xb0605a, sole: 0xe8e4dc, sclera: 0xf3f0ea,
      accent: 0x7a1f2b, hat: 0x2e3a4a, bag: 0x3a2e24, metal: 0x1e1f22, legwear: 0xb08068, socks: 0x2a2a2e, umbrella: 0x1a2a40, belt: 0x2a1a12, bike: 0x2f5a4a }
    : { skin: 0xc99272, hair: 0x2b2018, top: 0x24456e, jacket: 0x3b3e44, pants: 0x4a5a78, shoes: 0x4a3020, eyes: 0x3a2a1c, lips: 0xa86a5e, sole: 0xe8e4dc, sclera: 0xf3f0ea,
      accent: 0x7a1f2b, hat: 0x2e3a4a, bag: 0x3a2e24, metal: 0x1e1f22, legwear: 0xb08068, socks: 0x2a2a2e, umbrella: 0x1a2a40, belt: 0x2a1a12, bike: 0x2f5a4a };
  const B = new Builder();
  for (const lod of [0, 1]) { B.P.lod = lod; buildBody(B, { S, female, bones, wp, holdM, bikeM, lod, shW }); }
  const ao = bakeAO(B);
  const geo = B.build(palette, bi, ao);
  const mesh = new THREE.SkinnedMesh(geo, new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.75, metalness: 0, name: 'vc' }));
  mesh.material.name = 'vc';
  const lodTris = [0, 0]; for (let t = 0; t < B.idx.length; t += 3) lodTris[B.lod[B.idx[t]]]++;
  mesh.userData = { palette, palKeys: PAL_KEYS, parts: PARTS, holds, lodTris, rigs: { cycle: CYCLE_RIG, bench: BENCH_RIG, scale: S } };
  mesh.name = female ? 'woman' : 'man';
  const skeleton = new THREE.Skeleton(order.map(n => bones[n]));
  grp.name = female ? 'character_female' : 'character_male'; grp.add(mesh); mesh.bind(skeleton);
  mesh.castShadow = true;
  const clips = makeClips(P, female);
  P.rest();
  // per-part statistics
  const stat = {}; for (let t = 0; t < B.idx.length; t += 3) { const v = B.idx[t]; const k = PARTS[B.part[v]] + (B.lod[v] ? '/1' : ''); stat[k] = (stat[k] || 0) + 1; }
  console.log(grp.name, 'verts', B.pos.length / 3, 'tris', B.idx.length / 3, 'lod tris', lodTris.join('/'));
  if (process.env.CHAR_STATS) console.log(stat);
  return { grp, clips };
}

// ---------------------------------------------------------------------------------------------
// BODY + VARIANTS (called once per level of detail)
// ---------------------------------------------------------------------------------------------
function buildBody(B, { S, female, bones, wp, holdM, bikeM, lod }) {
  const hi = lod === 0;
  const s = (x) => x * S;
  const one = (b) => [[b, 1]];
  const NT = hi ? 20 : 8, NL = hi ? 12 : 6; // ring segments: torso, limbs
  const Hd = wp('head');

  // ---------------- torso profile ----------------
  // [y, rx, rzF, rzB, cz] (male units, scaled by S)
  const TT = female ? [
    [0.835, 0.03, 0.03, 0.03, 0], [0.86, 0.12, 0.076, 0.086, -0.006], [0.9, 0.165, 0.09, 0.105, -0.01], [0.95, 0.172, 0.088, 0.104, -0.01], [1.0, 0.16, 0.082, 0.094, -0.008],
    [1.03, 0.148, 0.078, 0.088, -0.006], [1.08, 0.132, 0.075, 0.082, 0], [1.14, 0.132, 0.077, 0.083, 0], [1.2, 0.142, 0.083, 0.086, 0], [1.26, 0.152, 0.088, 0.088, 0],
    [1.31, 0.156, 0.09, 0.088, 0], [1.36, 0.158, 0.086, 0.086, 0], [1.4, 0.156, 0.08, 0.082, 0], [1.43, 0.146, 0.072, 0.075, -0.004], [1.455, 0.12, 0.062, 0.065, -0.006],
    [1.475, 0.084, 0.052, 0.056, -0.008], [1.49, 0.053, 0.045, 0.048, -0.008]]
    : [
    [0.835, 0.03, 0.03, 0.03, 0], [0.86, 0.115, 0.075, 0.08, -0.005], [0.9, 0.152, 0.088, 0.098, -0.008], [0.95, 0.162, 0.09, 0.1, -0.008], [1.0, 0.158, 0.087, 0.094, -0.006],
    [1.03, 0.153, 0.085, 0.09, -0.005], [1.08, 0.149, 0.086, 0.088, 0], [1.14, 0.152, 0.09, 0.09, 0], [1.2, 0.16, 0.096, 0.094, 0], [1.26, 0.17, 0.101, 0.097, 0],
    [1.31, 0.177, 0.102, 0.097, 0], [1.36, 0.18, 0.098, 0.095, 0], [1.4, 0.178, 0.092, 0.09, 0], [1.43, 0.165, 0.082, 0.082, -0.004], [1.455, 0.135, 0.07, 0.072, -0.006],
    [1.475, 0.095, 0.058, 0.062, -0.008], [1.49, 0.06, 0.05, 0.052, -0.008]];
  const prof = (y) => {
    if (y <= 0.9) { // below the hips (coat / skirt hems): flare from the hip row
      const k = (0.9 - y); const p = prof(0.9001); return { rx: p.rx * (1 + k * 0.3), rzF: p.rzF * (1 + k * 0.45), rzB: p.rzB * (1 + k * 0.35), cz: p.cz };
    }
    let i = 0; while (i < TT.length - 2 && TT[i + 1][0] < y) i++;
    const a = TT[i], b = TT[i + 1], t = Math.min(1, Math.max(0, (y - a[0]) / (b[0] - a[0])));
    return { rx: lerp(a[1], b[1], t), rzF: lerp(a[2], b[2], t), rzB: lerp(a[3], b[3], t), cz: lerp(a[4], b[4], t) };
  };
  const frontBump = (x, y) => (female ? 0.03 * gauss(y, 1.3, 0.045) * (gauss(x, 0.082, 0.045) + gauss(x, -0.082, 0.045)) : 0.007 * gauss(y, 1.32, 0.04) * (gauss(x, 0.08, 0.05) + gauss(x, -0.08, 0.05)))
    + 0.005 * gauss(y, 1.06, 0.05) * gauss(x, 0, 0.08);
  const backBump = (x, y) => (female ? 0.028 : 0.018) * gauss(y, 0.925, 0.045) * (gauss(x, 0.07, 0.055) + gauss(x, -0.07, 0.055)) + 0.006 * gauss(y, 1.33, 0.04) * (gauss(x, 0.08, 0.04) + gauss(x, -0.08, 0.04));
  // point on the torso surface (+grow outward); th = 0 front
  const tPt = (y, th, grow = 0, bump = 1, yRaw = false) => {
    const p = prof(y), sn = Math.sin(th), c = Math.cos(th), e = 0.85;
    const ps = Math.sign(sn) * Math.abs(sn) ** e, pc = Math.sign(c) * Math.abs(c) ** e, rz = c > 0 ? p.rzF : p.rzB;
    let x = p.rx * ps, z = rz * pc;
    const bz = y > 0.84 ? (c > 0 ? frontBump(x, y) : -backBump(x, y)) * bump * Math.abs(c) : 0;
    const nx = x / (p.rx * p.rx), nz = z / (rz * rz), nl = Math.hypot(nx, nz) || 1;
    x += (nx / nl) * grow; z += (nz / nl) * grow + bz;
    return V3(s(x), yRaw ? y : s(y), s(p.cz + z));
  };
  const tRing = (y, n, grow, a0 = 0, bump = 1) => { const pts = [], cnt = a0 ? n + 1 : n; for (let j = 0; j < cnt; j++) pts.push(tPt(y, a0 ? a0 + (2 * Math.PI - 2 * a0) * j / n : 2 * Math.PI * j / n, grow, bump)); return pts; };
  const torsoW0 = (p) => chainW(p.y, ['chest', 'spine', 'hips'], [[s(1.2), s(0.07)], [s(1.03), s(0.05)]]);
  const skirtW = (p, amount = 0.65) => { // hips blended into the thighs toward the hem
    const k = sstep(s(0.92), s(0.55), p.y) * amount; if (k <= 0) return torsoW0(p);
    const sl = sstep(-s(0.06), s(0.06), p.x);
    return [...torsoW0(p).map(([b, w]) => [b, w * (1 - k)]), ['thigh.L', k * sl], ['thigh.R', k * (1 - sl)]];
  };

  // ---------------- core: neck, head, face, hands ----------------
  const neckW = (p) => chainW(p.y, ['head', 'neck', 'chest'], [[s(1.575), s(0.02)], [s(1.485), s(0.025)]]);
  const HR = female ? [0.077, 0.11, 0.096] : [0.08, 0.116, 0.1];
  const hc = V3(0, Hd.y + s(0.093), s(0.012));
  const skull = (u, grow = 0, sculpt = true) => {
    let x = u.x * HR[0], y = u.y * HR[1], z = u.z * HR[2];
    if (u.y < 0) x *= 1 - (female ? 0.3 : 0.22) * sstep(0, 1, -u.y);
    if (u.z > 0.55) z = HR[2] * (0.55 + (u.z - 0.55) * 0.55);
    if (u.z < 0) z *= u.y < 0 ? 1 - 0.3 * sstep(0, 0.9, -u.y) : 1.05;
    if (u.z > 0 && u.y < -0.55) z += HR[2] * 0.08 * sstep(0.55, 0.9, -u.y);
    if (sculpt && u.z > 0) {
      for (const sx of [-1, 1]) z -= HR[2] * 0.07 * Math.exp(-(((u.x - sx * 0.36) / 0.15) ** 2 + ((u.y - 0.1) / 0.11) ** 2)); // eye sockets
      z += HR[2] * 0.035 * gauss(u.y, 0.27, 0.07) * sstep(0.55, 0.85, u.z); // brow ridge
      x *= 1 + 0.05 * gauss(u.y, -0.05, 0.13) * sstep(0.1, 0.6, u.z); // cheekbones
      if (!female) x *= 1 + 0.06 * gauss(u.y, -0.55, 0.15) * sstep(-0.2, 0.3, u.z); // jaw angle
    }
    const p = V3(x, y, z); if (grow) p.add(p.clone().normalize().multiplyScalar(grow));
    return p.multiplyScalar(S).add(hc);
  };
  const dir = (x, y) => V3(x, y, Math.sqrt(Math.max(0, 1 - x * x - y * y)));
  const feature = (g, col, p, red = 0) => { g.translate(p.x, p.y, p.z); const r0 = B.P.red; B.P.red = red; B.geo(g, col, one('head')); B.P.red = r0; };
  // hairline (u.y of the edge) by azimuth |phi| (0 front, pi back)
  const lerpTab = (tab, a) => { let i = 0; while (i < tab.length - 2 && tab[i + 1][0] < a) i++; const t = Math.min(1, Math.max(0, (a - tab[i][0]) / (tab[i + 1][0] - tab[i][0]))); return lerp(tab[i][1], tab[i + 1][1], sstep(0, 1, t)); };
  const HAIRLINE = [[0, female ? 0.46 : 0.5], [0.55, 0.42], [0.95, 0.3], [1.15, 0.12], [1.27, -0.12], [1.4, 0.24], [1.57, 0.32], [1.8, 0.2], [2.1, -0.12], [2.6, -0.42], [Math.PI, -0.52]];
  // cap over the head from an edge (u.y per |phi|) to the crown. grow(u, t, phi) ; colour fn(t)
  const cap = (edge, grow, col, { n = hi ? 28 : 10, R = hi ? 9 : 4, phi0 = 0, phi1 = 2 * Math.PI, top = Math.PI / 2, w = one('head') } = {}) => {
    const rows = [], open = phi1 - phi0 < 2 * Math.PI - 1e-6, m = open ? n + 1 : n;
    for (let i = 0; i <= R; i++) {
      const t = i / R, pts = [];
      for (let j = 0; j < m; j++) {
        const ph = phi0 + (phi1 - phi0) * j / n, a = Math.abs(Math.atan2(Math.sin(ph), Math.cos(ph)));
        const e0 = Math.asin(Math.max(-0.99, Math.min(0.99, typeof edge === 'function' ? edge(a, ph) : edge)));
        const e = lerp(e0, top, t ** 0.85);
        const u = V3(Math.cos(e) * Math.sin(ph), Math.sin(e), Math.cos(e) * Math.cos(ph));
        pts.push(skull(u, grow(u, t, ph), false));
      }
      rows.push({ pts, col: typeof col === 'function' ? col(t) : col, w });
    }
    B.loft(rows, !open);
  };

  B.at('core', () => {
    // neck
    B.loft([[1.43, 0.056], [1.5, 0.05], [1.56, 0.046], [1.6, 0.047], [1.63, 0.032]].map(([y, r]) => ({ pts: ringXZ(0, s(y), s(-0.008), s(r * (female ? 0.88 : 1)), s(r * 0.95), s(r), hi ? 12 : 6), col: 'skin', w: neckW })));
    // head
    { const g = new THREE.SphereGeometry(1, hi ? 32 : 12, hi ? 22 : 9); const p = g.attributes.position;
      for (let i = 0; i < p.count; i++) { const q = skull(V3().fromBufferAttribute(p, i), 0, hi); p.setXYZ(i, q.x, q.y, q.z); }
      const r0 = B.P.red; B.P.red = 0.08; B.geo(g, 'skin', one('head')); B.P.red = r0; }
    // cheeks blush (subtle overlay inside the skin colour via redness on a second shell is costly; use redness on ears/nose/lips instead)
    for (const sx of [-1, 1]) {
      const ear = sph(s(0.028), 0.36, 1, 0.66, hi ? 8 : 5, hi ? 6 : 4); ear.rotateY(sx * 0.35); ear.rotateX(-0.1);
      feature(ear, 'skin', V3(sx * s(HR[0] + 0.004), hc.y - s(0.006), hc.z - s(0.012)), 0.45);
      if (hi) { // eyes: sclera, iris, upper lid; brows
        const c = skull(dir(sx * 0.36, 0.1), 0, true).add(V3(0, 0, -s(0.009)));
        feature(sph(s(0.0125), 1, 0.92, 0.75, 10, 8), 'sclera', c.clone());
        feature(sph(s(0.0062), 1, 1, 0.45, 8, 6), 'eyes', c.clone().add(V3(0, 0, s(0.0088))));
        const lid = new THREE.SphereGeometry(s(0.0138), 10, 5, 0, Math.PI * 2, 0, 1.15); lid.scale(1.05, 0.95, 0.85); lid.rotateX(0.35);
        feature(lid, 'skin', c.clone().add(V3(0, s(0.0008), 0)), 0.15);
        const br = [dir(sx * 0.17, 0.26), dir(sx * 0.35, 0.3), dir(sx * 0.53, 0.25)].map((u) => skull(u, s(0.003), true));
        B.tube(br, [s(0.0034), s(female ? 0.0026 : 0.0042), s(0.002)], 5, 'hair', one('head'), { flat: 0.45 });
      }
    }
    if (hi) {
      // nose: bridge -> tip -> under the tip, plus nostril wings
      const nb = skull(dir(0, 0.14), 0, true), nt = skull(dir(0, -0.2), 0, true).add(V3(0, 0, s(female ? 0.019 : 0.023))), nu = skull(dir(0, -0.3), 0, true).add(V3(0, 0, s(0.004)));
      const r0 = B.P.red; B.P.red = 0.3;
      B.tube([nb, nb.clone().lerp(nt, 0.5).add(V3(0, 0, s(0.003))), nt, nu], [s(0.006), s(0.0075), s(0.0105), s(0.006)], 7, 'skin', one('head'), { flat: 0.8 });
      B.P.red = r0;
      for (const sx of [-1, 1]) feature(sph(s(0.0095), 1, 0.8, 0.9, 8, 6), 'skin', skull(dir(sx * 0.13, -0.26), 0, true).add(V3(0, 0, s(0.005))), 0.3);
      feature(sph(s(0.021), 1, female ? 0.34 : 0.27, 0.36, 10, 6), 'lips', skull(dir(0, -0.42), 0, true).add(V3(0, s(0.003), -s(0.002))));
      feature(sph(s(0.019), 1, female ? 0.38 : 0.31, 0.4, 10, 6), 'lips', skull(dir(0, -0.5), 0, true).add(V3(0, s(0.001), -s(0.003))));
    } else {
      const ng = new THREE.ConeGeometry(s(0.016), s(0.05), 4); ng.rotateY(Math.PI / 4); ng.rotateX(0.35); feature(ng, 'skin', skull(dir(0, -0.08)).add(V3(0, 0, s(0.004))), 0.3);
    }
    // hands (palm faces the thigh): wrist, palm, fingers, thumb
    for (const [sd, sx] of [['L', 1], ['R', -1]]) {
      const ha = wp('hand.' + sd), fa = wp('forearm.' + sd), hk = female ? 0.9 : 1, hw = one('hand.' + sd);
      const wristW = (p) => chainW(p.y, ['forearm.' + sd, 'hand.' + sd], [[ha.y, s(0.02)]]);
      void fa;
      B.loft([[0.05, 0.02, 0.025], [0.0, 0.023, 0.03], [-0.03, 0.019, 0.034]].map(([dy, rx, rz]) => ({ pts: ringXZ(ha.x, ha.y + s(dy), 0, s(rx * hk), s(rz * hk), s(rz * hk), hi ? 9 : 6), col: 'skin', w: wristW })));
      const palm = rbox2(s(0.03 * hk), s(0.088 * hk), s(0.08 * hk), s(0.012), hi ? 2 : 1); palm.translate(ha.x, ha.y - s(0.068 * hk), s(0.004)); B.geo(palm, 'skin', hw);
      if (hi) {
        const fz = [0.028, 0.009, -0.01, -0.027], fl = [0.075, 0.083, 0.078, 0.062];
        for (let f = 0; f < 4; f++) {
          let p = V3(ha.x - sx * s(0.002), ha.y - s(0.108 * hk), s((fz[f] + 0.004) * hk)); const pts = [p.clone()]; let ang = 0;
          for (const [frac, da] of [[0.45, 0.22], [0.3, 0.5], [0.25, 0.45]]) { ang += da; p = p.clone().add(V3(-sx * Math.sin(ang), -Math.cos(ang), 0).multiplyScalar(s(fl[f] * frac * hk))); pts.push(p.clone()); }
          B.tube(pts, [s(0.0095 * hk), s(0.009 * hk), s(0.0082 * hk), s(0.007 * hk)], 6, 'skin', hw, { cap0: false });
        }
        const t0 = V3(ha.x - sx * s(0.008), ha.y - s(0.03), s(0.034 * hk)), t1 = t0.clone().add(V3(-sx * 0.012, -0.03, 0.022).multiplyScalar(S * hk)), t2 = t1.clone().add(V3(-sx * 0.014, -0.026, 0.008).multiplyScalar(S * hk));
        B.tube([t0, t1, t2], [s(0.012 * hk), s(0.0105 * hk), s(0.0085 * hk)], 6, 'skin', hw);
      } else {
        const fing = rbox2(s(0.026 * hk), s(0.07 * hk), s(0.072 * hk), s(0.011), 1); fing.rotateZ(sx * 0.18); fing.translate(ha.x - sx * s(0.008), ha.y - s(0.14 * hk), s(0.008)); B.geo(fing, 'skin', hw);
      }
    }
  });

  // ---------------- torso (top + trouser waist + belt) ----------------
  const TROWS = [0.835, 0.86, 0.9, 0.95, 0.985, 1.0, 1.03, 1.045, 1.08, 1.14, 1.2, 1.26, 1.31, 1.36, 1.4, 1.43, 1.455, 1.475, 1.49];
  const trowsLo = [0.835, 0.9, 1.0, 1.03, 1.14, 1.26, 1.36, 1.43, 1.475, 1.49];
  const torsoCol = (y) => (y < 0.995 ? 'pants' : y < 1.03 ? 'belt' : 'top');
  B.at('torso', () => B.loft((hi ? TROWS : trowsLo).map((y) => ({ pts: tRing(y, NT, 0), col: torsoCol(y + 0.001), w: torsoW0 }))));

  // ---------------- outer torso shells ----------------
  // rows: [y, grow, a0, colour?]; open loft unless every a0 is 0
  const shell = (rows, w, { double = false, bump = 0.75, col = 'jacket', ridge = null, n = NT } = {}) => {
    const closed = rows.every((r) => !r[2]);
    const mk2 = (sign) => rows.map(([y, g, a0, c]) => {
      const gg = g + (ridge ? ridge(y) : 0) + sign;
      return { pts: closed ? tRing(y, n, gg, 0, bump) : tRing(y, n, gg, Math.max(a0, 0.004), bump), col: c || col, w };
    });
    B.loft(mk2(0), closed);
    if (double) B.loft(mk2(-0.004), closed, true);
  };
  const lowRes = (rows) => (hi ? rows : rows.filter((r, i) => i === 0 || i === rows.length - 1 || i % 2 === 0));
  // open casual jacket (zip / buttons undone)
  B.at('jacket_open', () => {
    shell(lowRes([[0.86, 0.016, 0.24], [0.9, 0.016, 0.22], [0.97, 0.015, 0.2], [1.05, 0.014, 0.21], [1.14, 0.013, 0.26], [1.22, 0.013, 0.33], [1.3, 0.013, 0.42], [1.37, 0.013, 0.52],
      [1.42, 0.013, 0.64], [1.455, 0.014, 0.78], [1.48, 0.016, 0.9], [1.5, 0.018, 1.0]]), torsoW0, { double: true });
    // stand collar
    const collar = (k) => [[1.475, 0.084, 0.072, 1.15], [1.51, 0.075, 0.066, 1.2], [1.54, 0.07, 0.063, 1.3]].map(([y, rx, rz, a0]) =>
      ({ pts: ringXZ(0, s(y), s(-0.012), s(rx * k), s(rz * k), s(rz * k), hi ? 12 : 6, 1, a0), col: 'jacket', w: one('chest') }));
    B.loft(collar(1), false); B.loft(collar(0.95), false, true);
  });
  // suit / blazer: closed below the button, V neck with lapels; also the police tunic
  const vNeck = (y, lo, top) => (y < lo ? 0.004 : lerp(0.06, top, sstep(lo, 1.47, y)));
  B.at('suit', () => {
    const rows = [0.86, 0.9, 0.96, 1.02, 1.08, 1.14, 1.2, 1.26, 1.32, 1.37, 1.41, 1.44, 1.465, 1.485];
    shell(lowRes(rows.map((y) => [y, 0.012 + (y < 0.95 ? 0.004 : 0), vNeck(y, 1.13, 1.05)])), torsoW0, { double: true });
    if (hi) for (const sd of [1, -1]) { // lapels
      const rowsL = rows.filter((y) => y >= 1.14).map((y) => { const a0 = vNeck(y, 1.13, 1.05), wdt = lerp(0.1, 0.3, sstep(1.14, 1.42, y)) * (y > 1.45 ? 0.6 : 1); const pts = [];
        for (let j = 0; j <= 3; j++) { const th = sd > 0 ? a0 + wdt * j / 3 : -a0 - wdt * j / 3; pts.push(tPt(y, th, 0.0185, 0.75)); } return { pts, col: 'jacket', w: torsoW0 }; });
      B.loft(rowsL, false);
      for (const by of [1.03, 1.1]) { const p = tPt(by, 0, 0.016, 0.75); feature0(sph(s(0.007), 1, 1, 0.4, 6, 4), 'metal', p, torsoW0); }
      void sd;
    }
  });
  function feature0(g, col, p, w) { g.translate(p.x, p.y, p.z); B.geo(g, col, w); }
  // shirt collar (under suit / coat)
  B.at('collar', () => {
    const rows = (k) => [[1.46, 0.074, 0.064, 0.32], [1.5, 0.066, 0.06, 0.3], [1.525, 0.064, 0.058, 0.3]].map(([y, rx, rz, a0]) => ({ pts: ringXZ(0, s(y), s(-0.01), s(rx * k), s(rz * k), s(rz * k), hi ? 14 : 6, 1, a0), col: 'top', w: neckW }));
    B.loft(rows(1), false); B.loft(rows(0.96), false, true);
    // folded points
    if (hi) for (const sx of [-1, 1]) { const g = new THREE.BufferGeometry().setFromPoints([V3(sx * 0.012, 1.505, 0.064), V3(sx * 0.05, 1.5, 0.05), V3(sx * 0.03, 1.455, 0.075)].map((p) => p.multiplyScalar(S)));
      g.setIndex([0, 1, 2]); const g2 = g.clone(); g2.setIndex([0, 2, 1]); B.geo(g, 'top', one('chest')); B.geo(g2, 'top', one('chest')); }
  });
  B.at('tie', () => {
    const ys = hi ? [1.445, 1.43, 1.38, 1.3, 1.22, 1.14, 1.1] : [1.445, 1.3, 1.1];
    const wd = (y) => (y > 1.425 ? 0.018 : lerp(0.02, 0.037, sstep(1.42, 1.12, y)) * (y < 1.105 ? 0.4 : 1));
    const rows = ys.map((y) => { const c = tPt(y, 0, 0.005, 1); const w2 = s(wd(y)); return { pts: [V3(-w2, c.y, c.z), V3(0, c.y, c.z + s(0.004)), V3(w2, c.y, c.z), V3(0, c.y, c.z - s(0.002))], col: 'accent', w: torsoW0 }; });
    B.loft(rows, true);
    const k = tPt(1.452, 0, 0.008, 1); feature0(sph(s(0.014), 1, 0.9, 0.6, 6, 5), 'accent', k, one('chest'));
  });
  // long coat to the knees, slit at the front below the waist, wide lapels
  B.at('coat', () => {
    const rows = [0.5, 0.58, 0.68, 0.78, 0.86, 0.92, 0.98, 1.04, 1.1, 1.16, 1.22, 1.28, 1.34, 1.39, 1.43, 1.46, 1.485];
    shell(lowRes(rows.map((y) => [y, 0.024, y < 0.96 ? lerp(0.12, 0.03, sstep(0.55, 0.96, y)) : vNeck(y, 1.18, 0.95)])), (p) => skirtW(p, 0.6), { double: true });
    // upturned collar
    const collar = (k) => [[1.465, 0.1, 0.085, 0.75], [1.52, 0.088, 0.077, 0.8], [1.56, 0.083, 0.073, 0.9]].map(([y, rx, rz, a0]) =>
      ({ pts: ringXZ(0, s(y), s(-0.014), s(rx * k), s(rz * k), s(rz * k), hi ? 14 : 6, 1, a0), col: 'jacket', w: one('chest') }));
    B.loft(collar(1), false); B.loft(collar(0.95), false, true);
  });
  // quilted puffer jacket with a high collar
  B.at('puffer', () => {
    const ys = []; for (let y = 0.84; y <= 1.47; y += hi ? 0.0225 : 0.09) ys.push(y); ys.push(1.485);
    shell(ys.map((y) => [y, 0.03, 0]), torsoW0, { ridge: (y) => 0.009 * (0.5 - 0.5 * Math.cos(2 * Math.PI * (y - 0.84) / 0.09)), bump: 0.5 });
    B.loft([[1.44, 0.11, 0.1, 0.1], [1.48, 0.1, 0.092, 0.095], [1.55, 0.088, 0.082, 0.085], [1.57, 0.08, 0.075, 0.078], [1.56, 0.072, 0.066, 0.07]].map(([y, rx, f, b]) =>
      ({ pts: ringXZ(0, s(y), s(-0.012), s(rx), s(f), s(b), hi ? 14 : 6), col: 'jacket', w: neckW })));
  });
  // hoodie: closed, hood folded on the back, kangaroo pocket, drawstrings
  B.at('hoodie', () => {
    shell(lowRes([0.86, 0.9, 0.96, 1.02, 1.08, 1.14, 1.2, 1.26, 1.32, 1.37, 1.41, 1.44, 1.465, 1.485].map((y) => [y, 0.013, 0])), torsoW0, { bump: 0.7 });
    const hood = sph(s(0.1), 1.25, 0.75, 0.62, hi ? 12 : 6, hi ? 8 : 4); feature0(hood, 'jacket', V3(0, s(1.49), s(-0.085)), (p) => chainW(p.y, ['neck', 'chest'], [[s(1.5), s(0.03)]]));
    if (hi) {
      const pk = []; for (const y of [0.9, 0.96, 1.02]) { const pts = []; for (let j = 0; j <= 6; j++) pts.push(tPt(y, -0.7 + 1.4 * j / 6, 0.019, 0.7)); pk.push({ pts, col: 'jacket', w: torsoW0 }); }
      B.loft(pk, false);
      for (const sx of [-1, 1]) { const a = tPt(1.455, sx * 0.25, 0.018), b = tPt(1.33, sx * 0.22, 0.017); B.tube([a, b], s(0.003), 4, 'sole', torsoW0); }
    }
  });

  // ---------------- arms ----------------
  // [dy below the shoulder joint, r, inward x offset]
  const SLEEVE = [[-0.04, 0.0, 0.03], [-0.034, 0.034, 0.024], [-0.012, 0.054, 0.01], [0.02, 0.061, 0.0], [0.05, 0.058, 0.002], [0.14, 0.05, 0.003],
    [0.25, 0.046, 0.002], [0.29, 0.045, 0.0], [0.36, 0.045, 0.0], [0.47, 0.039, 0.0], [0.52, 0.041, 0.0], [0.53, 0.026, 0.0]];
  const SKINARM = [[0.16, 0.041, 0.002], [0.25, 0.037, 0.001], [0.29, 0.034, 0], [0.36, 0.036, 0], [0.45, 0.03, 0], [0.52, 0.025, 0], [0.54, 0.02, 0]];
  const arm = (sd, sx, rows, col, k, ridge = 0) => {
    const ua = wp('upperarm.' + sd);
    const armW = (p) => chainW(p.y, ['shoulder.' + sd, 'upperarm.' + sd, 'forearm.' + sd], [[ua.y, s(0.035)], [wp('forearm.' + sd).y, s(0.045)]]);
    const kk = (female ? 0.86 : 1) * k; const rr = hi ? rows : rows.filter((r, i) => i % 2 === 0 || i === rows.length - 1 || i < 3);
    B.loft(rr.map(([dy, r, xi], i) => { const rad = r * kk + (ridge && i > 2 && i < rr.length - 2 ? ridge * (i % 2) : 0);
      return { pts: ringXZ(ua.x - sx * s(xi), ua.y - s(dy), 0, s(rad), s(rad * 0.95), s(rad * 1.02), NL), col: typeof col === 'function' ? col(dy) : col, w: armW }; }));
  };
  for (const [sd, sx] of [['L', 1], ['R', -1]]) {
    B.at('arms_jacket', () => arm(sd, sx, SLEEVE, 'jacket', 1));
    B.at('arms_top', () => arm(sd, sx, SLEEVE.map(([d, r, x]) => [d, d > 0.5 && d < 0.53 ? r * 0.92 : r * 0.94, x]), 'top', 0.93));
    B.at('arms_puffer', () => arm(sd, sx, SLEEVE.map(([d, r, x]) => [d, r ? r + 0.012 : 0, x]), 'jacket', 1.08, hi ? 0.006 : 0));
    B.at('arms_short', () => {
      arm(sd, sx, [...SLEEVE.slice(0, 6), [0.2, 0.05, 0.003], [0.205, 0.04, 0.002]], 'top', 0.95);
      arm(sd, sx, SKINARM, 'skin', 1);
    });
  }

  // ---------------- legs ----------------
  for (const [sd, sx] of [['L', 1], ['R', -1]]) {
    const th = wp('thigh.' + sd), kn = wp('shin.' + sd), ft = wp('foot.' + sd);
    const legW = (p) => chainW(p.y, ['hips', 'thigh.' + sd, 'shin.' + sd], [[s(0.86), s(0.05)], [kn.y, s(0.05)]]);
    const fk = female ? 1.04 : 1;
    const legLoft = (rows, colFn, k = 1) => {
      const rr = hi ? rows : rows.filter((r, i) => i % 2 === 0 || i === rows.length - 1);
      B.loft(rr.map(([y, r, f, b, xo]) => ({ pts: ringXZ(th.x + sx * s(xo), s(y), 0, s(r * fk * k), s(f * fk * k), s(b * fk * k), NL), col: colFn(y), w: legW })));
    };
    // [y, r, rzF, rzB, x offset outward]
    const TROUSER = [[0.98, 0.08, 0.08, 0.08, 0], [0.9, 0.093, 0.09, 0.094, 0.004], [0.8, 0.085, 0.081, 0.085, 0.003], [0.68, 0.072, 0.068, 0.07, 0], [0.56, 0.062, 0.06, 0.06, -0.004],
      [0.49, 0.059, 0.059, 0.057, -0.005], [0.42, 0.058, 0.055, 0.064, -0.004], [0.33, 0.054, 0.051, 0.059, -0.002], [0.22, 0.052, 0.05, 0.052, 0], [0.14, 0.055, 0.056, 0.057, 0],
      [0.1, 0.059, 0.061, 0.061, 0], [0.1, 0.036, 0.036, 0.036, 0]];
    const BARE = [[0.98, 0.078, 0.078, 0.078, 0], [0.9, 0.086, 0.083, 0.088, 0.004], [0.78, 0.075, 0.072, 0.076, 0.002], [0.64, 0.062, 0.06, 0.06, 0], [0.53, 0.05, 0.052, 0.049, -0.004],
      [0.47, 0.047, 0.05, 0.048, -0.005], [0.4, 0.047, 0.045, 0.058, -0.004], [0.33, 0.045, 0.041, 0.055, -0.002], [0.24, 0.036, 0.035, 0.038, 0], [0.16, 0.03, 0.031, 0.032, 0],
      [0.1, 0.031, 0.033, 0.034, 0], [0.09, 0.02, 0.02, 0.02, 0]];
    B.at('legs_trousers', () => legLoft(TROUSER, () => 'pants'));
    B.at('legs_tights', () => legLoft(BARE, (y) => (y < 0.13 ? 'socks' : 'pants'), 1.03));
    B.at('legs_skirt', () => legLoft(BARE, (y) => (y < 0.13 ? 'shoes' : 'legwear'), 1.01));
    B.at('legs_shorts', () => {
      const top = TROUSER.slice(0, 5).map(([y, r, f, b, x]) => [y, r + 0.006, f + 0.006, b + 0.006, x]);
      legLoft([...top, [0.545, 0.068, 0.066, 0.066, -0.004], [0.54, 0.05, 0.052, 0.049, -0.004], ...BARE.slice(5)], (y) => (y > 0.541 ? 'pants' : y < 0.15 ? 'socks' : 'skin'));
    });
    // shoes: upper lofted heel -> toe [z, half width, yBottom, yTop]
    const footW = (p) => chainW(-p.z, ['toe.' + sd, 'foot.' + sd], [[-s(0.115), s(0.025)]]);
    const fs = female ? 0.92 : 1;
    const shoe = (rows, soleCol, soleH, colUpper = 'shoes') => {
      const rr = hi ? rows : rows.filter((r, i) => i % 2 === 0 || i === rows.length - 1);
      B.loft(rr.map(([z, hw, yb, yt]) => {
        const pts = []; const m = hi ? 10 : 6;
        for (let j = 0; j < m; j++) { const a = 2 * Math.PI * j / m, c = Math.cos(a), sn = Math.sin(a); const cy = (yb + yt) / 2, ry = (yt - yb) / 2;
          pts.push(V3(ft.x + s(hw * fs) * sn * (c < 0 ? 1 : 0.92), s(cy + ry * (c > 0 ? c : -(Math.abs(c) ** 0.35))), s(z * fs))); }
        return { pts, col: colUpper, w: footW };
      }));
      const sole = rbox2(s(0.094 * fs), s(soleH), s(0.286 * fs), s(Math.min(soleH / 2 - 0.001, 0.008)), 1); sole.translate(ft.x, s(soleH / 2), s(0.062 * fs)); B.geo(sole, soleCol, footW);
    };
    const SNEAK = [[-0.083, 0.004, 0.035, 0.05], [-0.078, 0.025, 0.02, 0.087], [-0.06, 0.04, 0.018, 0.11], [-0.02, 0.044, 0.018, 0.114], [0.03, 0.046, 0.018, 0.098],
      [0.08, 0.049, 0.018, 0.074], [0.13, 0.048, 0.018, 0.06], [0.175, 0.041, 0.018, 0.05], [0.198, 0.025, 0.02, 0.04], [0.206, 0.004, 0.024, 0.034]];
    B.at('shoes_sneaker', () => shoe(SNEAK, 'sole', 0.024));
    B.at('shoes_dress', () => shoe([[-0.08, 0.004, 0.03, 0.045], [-0.076, 0.024, 0.012, 0.08], [-0.058, 0.037, 0.011, 0.1], [-0.02, 0.04, 0.011, 0.1], [0.03, 0.042, 0.011, 0.085],
      [0.08, 0.044, 0.011, 0.062], [0.13, 0.04, 0.011, 0.048], [0.175, 0.032, 0.011, 0.038], [0.2, 0.018, 0.012, 0.03], [0.212, 0.003, 0.016, 0.024]], 'belt', 0.012));
    B.at('shoes_boot', () => {
      shoe(SNEAK.map(([z, w, yb, yt]) => [z, w + 0.003, yb, yt + 0.006]), 'belt', 0.022);
      B.loft([[0.1, 0.05], [0.14, 0.052], [0.2, 0.054], [0.215, 0.056], [0.215, 0.04]].map(([y, r]) => ({ pts: ringXZ(ft.x, s(y), s(-0.008), s(r * fs), s(r * fs), s(r * fs), NL), col: 'shoes', w: (p) => chainW(p.y, ['shin.' + sd, 'foot.' + sd], [[s(0.12), s(0.04)]]) })));
    });
    // bicycle pedal under the ball of the foot
    B.at('bicycle', () => { const pd = rbox2(s(0.1), s(0.02), s(0.07), s(0.005), 1); pd.translate(ft.x, -s(0.012), s(0.11)); B.geo(pd, 'metal', footW); });
  }
  // skirt (worn with legs_skirt): waist to knee, hem follows the thighs
  B.at('legs_skirt', () => {
    const rows = hi ? [1.03, 0.98, 0.92, 0.86, 0.78, 0.7, 0.62, 0.55] : [1.03, 0.9, 0.7, 0.55];
    B.loft(rows.map((y) => ({ pts: tRing(y, NT, 0.008 + (y < 0.9 ? 0.02 * sstep(0.9, 0.55, y) : 0), 0, 0.8), col: 'pants', w: (p) => skirtW(p, 0.7) })));
    B.loft(rows.map((y) => ({ pts: tRing(y, NT, 0.004 + (y < 0.9 ? 0.02 * sstep(0.9, 0.55, y) : 0), 0, 0.8), col: 'pants', w: (p) => skirtW(p, 0.7) })), true, true);
  });

  // ---------------- hair ----------------
  const hairline = (a) => lerpTab(HAIRLINE, a);
  const noise = (ph, t, f = 7) => Math.sin(ph * f + 1.3) * Math.sin(t * 9 + ph * 2.1);
  const edgeFade = (t, g, base = 0.0012) => base + g * sstep(0, 0.16, t);
  if (!female) {
    B.at('hair_short', () => cap(hairline, (u, t, ph) => s(edgeFade(t, 0.009 + 0.011 * sstep(0.3, 0.9, u.y) * sstep(-0.3, 0.6, u.z) + 0.0025 * noise(ph, t, 9))), 'hair'));
    B.at('hair_side', () => cap(hairline, (u, t, ph) => s(edgeFade(t, 0.013 + 0.016 * sstep(0.2, 0.9, u.y) + 0.007 * sstep(-0.6, 0.8, u.x) + 0.008 * sstep(0.4, 0.9, u.z) * sstep(0.2, 0.7, u.y) + 0.002 * noise(ph, t))), 'hair'));
    B.at('hair_buzz', () => cap(hairline, (u, t) => s(edgeFade(t, 0.0028, 0.0009)), 'hair'));
    B.at('hair_bald', () => cap((a) => Math.min(hairline(a), 0.25), (u, t) => s(edgeFade(Math.min(t, 1 - t), 0.006)), 'hair', { phi0: 1.05, phi1: 2 * Math.PI - 1.05, top: Math.asin(0.36) }));
    B.at('hair_curly', () => cap((a) => hairline(a) - 0.04, (u, t, ph) => s(edgeFade(t, 0.022 + 0.012 * sstep(0.2, 0.9, u.y) + 0.006 * Math.sin(ph * 11) * Math.sin(t * 17))), 'hair', { R: hi ? 12 : 4, n: hi ? 34 : 10 }));
    B.at('beard', () => {
      const edgeTop = (a) => lerpTab([[0, -0.56], [0.22, -0.5], [0.45, -0.2], [0.8, -0.05], [1.2, 0.0], [1.35, -0.1]], a);
      const rows = [], m = hi ? 22 : 8, R = hi ? 6 : 2;
      for (let i = 0; i <= R; i++) { const t = i / R, pts = [];
        for (let j = 0; j <= m; j++) { const ph = -1.32 + 2.64 * j / m, a = Math.abs(ph), y0 = edgeTop(a), y1 = lerp(-0.97, -0.7, sstep(0.9, 1.32, a)); const y = lerp(y0, y1, t);
          const u = V3(Math.sqrt(1 - y * y) * Math.sin(ph), y, Math.sqrt(1 - y * y) * Math.cos(ph)); pts.push(skull(u, s(0.0015 + 0.006 * Math.sin(Math.PI * Math.min(1, t * 1.15 + 0.08))), hi)); }
        rows.push({ pts, col: 'hair', w: one('head') }); }
      B.loft(rows, false);
    });
    B.at('mustache', () => { if (!hi) return; const pts = [dir(-0.2, -0.38), dir(-0.08, -0.33), dir(0.08, -0.33), dir(0.2, -0.38)].map((u) => skull(u, s(0.006), true)); B.tube(pts, [s(0.004), s(0.006), s(0.006), s(0.004)], 6, 'hair', one('head'), { flat: 0.6 }); });
  } else {
    const fCap = (extra = 0) => cap((a) => hairline(a), (u, t, ph) => s(edgeFade(t, 0.011 + extra + 0.009 * sstep(0.2, 0.9, u.y) + 0.004 * sstep(-0.5, 0.8, -u.x) + 0.0015 * noise(ph, t))), 'hair');
    const fringe = () => { if (!hi && lod) { /* keep low */ } const fg = new THREE.SphereGeometry(s(0.062), hi ? 10 : 6, hi ? 6 : 4, 0, Math.PI * 2, 0, Math.PI / 2); fg.scale(1.35, 0.5, 0.62); fg.rotateZ(0.28); fg.rotateX(0.55);
      feature(fg, 'hair', skull(dir(0.17, 0.6)).add(V3(0, s(0.006), -s(0.012)))); };
    const hang = (rows, w = one('head')) => { for (const [k, inw] of [[1, false], [0.95, true]]) B.loft(rows.map(([dy, rx, rz, cz, a0]) => ({ pts: ringXZ(0, hc.y + s(dy), hc.z + s(cz), s(rx * k), s(rz * 0.9 * k), s(rz * k), hi ? 14 : 7, 0.9, a0), col: 'hair', w })), false, inw); };
    B.at('hair_bob', () => { fCap(0.002); fringe(); hang([[0.03, 0.094, 0.101, 0.012, 1.15], [-0.04, 0.098, 0.105, 0.0, 1.08], [-0.11, 0.101, 0.105, -0.012, 1.02], [-0.18, 0.106, 0.1, -0.022, 1.0], [-0.22, 0.103, 0.09, -0.026, 1.0], [-0.235, 0.085, 0.07, -0.02, 1.05]]); });
    B.at('hair_long', () => {
      fCap(0.002); fringe();
      const lw = (p) => chainW(p.y, ['head', 'chest'], [[hc.y - s(0.17), s(0.06)]]);
      hang([[0.03, 0.094, 0.101, 0.012, 1.2], [-0.05, 0.099, 0.105, -0.004, 1.15], [-0.13, 0.104, 0.106, -0.018, 1.1], [-0.2, 0.112, 0.104, -0.035, 1.2], [-0.26, 0.135, 0.1, -0.06, 1.55],
        [-0.33, 0.13, 0.09, -0.07, 1.75], [-0.4, 0.12, 0.08, -0.075, 1.85], [-0.45, 0.1, 0.06, -0.075, 1.95]], lw);
    });
    B.at('hair_ponytail', () => {
      cap(hairline, (u, t, ph) => s(edgeFade(t, 0.007 + 0.004 * sstep(0.3, 0.9, u.y) + 0.001 * noise(ph, t))), 'hair');
      const b = skull(V3(0, 0.25, -0.97).normalize(), s(0.01));
      feature(sph(s(0.016), 1, 1, 1, 6, 5), 'accent', b.clone());
      B.tube([b, b.clone().add(V3(0, -0.02, -0.045).multiplyScalar(S)), b.clone().add(V3(0, -0.1, -0.06).multiplyScalar(S)), b.clone().add(V3(0, -0.2, -0.05).multiplyScalar(S)), b.clone().add(V3(0, -0.25, -0.04).multiplyScalar(S))],
        [s(0.017), s(0.028), s(0.03), s(0.02), s(0.006)], hi ? 8 : 5, 'hair', one('head'));
    });
    B.at('hair_bun', () => { cap(hairline, (u, t, ph) => s(edgeFade(t, 0.008 + 0.005 * sstep(0.3, 0.9, u.y) + 0.001 * noise(ph, t))), 'hair');
      feature(sph(s(0.042), 1, 0.85, 0.95, hi ? 12 : 6, hi ? 9 : 5), 'hair', skull(V3(0, 0.6, -0.8).normalize(), s(0.03))); });
    B.at('hair_pixie', () => { cap((a) => hairline(a) - 0.05 * gauss(a, 0, 0.5), (u, t, ph) => s(edgeFade(t, 0.013 + 0.012 * sstep(0.2, 0.9, u.y) + 0.008 * sstep(0.3, 0.9, u.z) + 0.002 * noise(ph, t, 11))), 'hair'); fringe(); });
  }

  // ---------------- hats ----------------
  const tab = (rows) => (a) => lerpTab(rows, a);
  B.at('hat_beanie', () => cap(tab([[0, 0.34], [1.2, 0.2], [1.6, 0.14], [Math.PI, -0.12]]), (u, t) => s(0.03 + 0.008 * sstep(0.5, 1, u.y) + (t < 0.22 ? 0.007 : 0)), 'hat'));
  const bill = (len, droop, wdt, y0, col, gz = 0.03) => { // peak in front of a cap
    const rows = []; const m = hi ? 10 : 4;
    for (const [k, inw] of [[0, false], [0.003, true]]) {
      const r2 = []; for (const t of [0, 1]) { const pts = []; for (let j = 0; j <= m; j++) { const ph = -wdt + 2 * wdt * j / m, y = y0; const u = V3(Math.cos(Math.asin(y)) * Math.sin(ph), y, Math.cos(Math.asin(y)) * Math.cos(ph));
        const p = skull(u, s(gz), false); const out = V3(Math.sin(ph), 0, Math.cos(ph)); p.addScaledVector(out, s(len * t * (1 - 0.35 * (Math.abs(ph) / wdt) ** 2))); p.y -= s(droop * t + k); pts.push(p); } r2.push({ pts, col, w: one('head') }); }
      B.loft(r2, false, inw); rows.push(r2);
    }
  };
  B.at('hat_cap', () => { cap(tab([[0, 0.4], [1.3, 0.16], [Math.PI, 0.02]]), (u) => s(0.026 + 0.005 * sstep(0.5, 1, u.y)), 'hat'); bill(0.075, 0.015, 0.85, 0.4, 'hat', 0.026); });
  B.at('hat_flatcap', () => { cap(tab([[0, 0.33], [1.3, 0.12], [Math.PI, -0.05]]), (u, t) => { const g = 0.02 + 0.012 * sstep(0.3, 0.9, u.z) * sstep(0.3, 0.9, u.y); return s(g * (1 - 0.3 * t)); }, 'hat'); bill(0.045, 0.02, 0.8, 0.33, 'hat', 0.02); });
  B.at('hat_sunhat', () => {
    cap(0.2, (u) => s(0.03 + 0.01 * sstep(0.6, 1, u.y)), 'hat');
    const m = hi ? 24 : 10; for (const inw of [false, true]) { const rows = [];
      for (const [dr, dy] of [[0, 0], [0.05, -0.012], [0.095, -0.03]]) { const pts = []; for (let j = 0; j < m; j++) { const ph = 2 * Math.PI * j / m; const u = V3(Math.cos(Math.asin(0.2)) * Math.sin(ph), 0.2, Math.cos(Math.asin(0.2)) * Math.cos(ph));
        const p = skull(u, s(0.03), false); p.addScaledVector(V3(Math.sin(ph), 0, Math.cos(ph)), s(dr)); p.y += s(dy) - (inw ? s(0.003) : 0); pts.push(p); } rows.push({ pts, col: 'hat', w: one('head') }); }
      B.loft(rows, true, inw); }
  });
  B.at('hat_peak', () => { cap(tab([[0, 0.36], [1.4, 0.2], [Math.PI, 0.08]]), (u, t) => s(0.03 + 0.03 * sstep(0.3, 1, t) * (0.6 + 0.4 * u.z)), (t) => (t < 0.25 ? 'accent' : 'hat'), { R: hi ? 8 : 4 }); bill(0.06, 0.02, 0.9, 0.36, 'metal', 0.032); });

  // ---------------- face / neck accessories ----------------
  B.at('glasses', () => {
    if (!hi) { const g = new THREE.BoxGeometry(s(0.12), s(0.012), s(0.01)); feature(g, 'metal', skull(dir(0, 0.1)).add(V3(0, 0, s(0.012)))); return; }
    const cs = []; for (const sx of [-1, 1]) { const c = skull(dir(sx * 0.36, 0.08), 0, true).add(V3(0, 0, s(0.017))); cs.push(c);
      const r = new THREE.TorusGeometry(s(0.02), s(0.0018), 4, 14); r.scale(1.1, 0.85, 1); feature(r, 'metal', c.clone());
      const tp = skull(dir(sx * 0.98, 0.08)).add(V3(sx * s(0.004), 0, 0)); B.tube([c.clone().add(V3(sx * s(0.022), 0, 0)), tp, tp.clone().add(V3(0, -s(0.012), -s(0.03)))], s(0.0016), 4, 'metal', one('head')); }
    B.tube([cs[0].clone().add(V3(s(0.02), 0, 0)), cs[1].clone().add(V3(-s(0.02), 0, 0))], s(0.0018), 4, 'metal', one('head'), { cap0: false, cap1: false });
  });
  B.at('headphones', () => {
    const pts = []; for (let i = 0; i <= (hi ? 10 : 4); i++) { const a = -Math.PI / 2 + Math.PI * i / (hi ? 10 : 4); pts.push(skull(V3(Math.sin(a), Math.cos(a), -0.05).normalize(), s(0.024), false)); }
    B.tube(pts, s(0.007), hi ? 6 : 4, 'metal', one('head'), { flat: 0.4 });
    for (const sx of [-1, 1]) feature(sph(s(0.034), 0.6, 1, 1, hi ? 10 : 6, hi ? 8 : 4), 'metal', V3(sx * s(HR[0] + 0.012), hc.y - s(0.008), hc.z - s(0.012)));
  });
  B.at('scarf', () => {
    const W = (p) => chainW(p.y, ['neck', 'chest'], [[s(1.5), s(0.03)]]);
    const ring = []; const m = hi ? 16 : 8; for (let j = 0; j <= m; j++) { const a = 2 * Math.PI * j / m; ring.push(V3(s(0.072 * Math.sin(a)), s(1.485 + 0.012 * Math.cos(a)), s(-0.006 + 0.068 * Math.cos(a)))); }
    B.tube(ring, s(0.027), hi ? 8 : 5, 'accent', W, { cap0: false, cap1: false, up: V3(0, 1, 0) });
    const tail = (hi ? [1.47, 1.42, 1.36, 1.3, 1.24] : [1.47, 1.36, 1.24]).map((y, i) => tPt(y, 0.22 - i * 0.02, 0.035 + (y > 1.44 ? 0.02 : 0)));
    B.tube(tail, s(0.022), hi ? 6 : 4, 'accent', torsoW0, { flat: 0.35 });
  });

  // ---------------- bags & carried things ----------------
  B.at('backpack', () => {
    const bw = (p) => chainW(p.y, ['chest', 'spine'], [[s(1.2), s(0.06)]]);
    const back = tPt(1.24, Math.PI, 0.0).z;
    const g = rbox2(s(0.28), s(0.38), s(0.13), s(0.035), hi ? 3 : 1); g.translate(0, s(1.24), back - s(0.072)); B.geo(g, 'bag', bw);
    if (hi) { const pk = rbox2(s(0.2), s(0.14), s(0.04), s(0.015), 2); pk.translate(0, s(1.12), back - s(0.15)); B.geo(pk, 'bag', bw); }
    for (const sx of [-1, 1]) {
      const pts = [V3(sx * s(0.08), s(1.41), back - s(0.03)), V3(sx * s(0.09), s(1.475), s(-0.03)), tPt(1.42, sx * 0.55, 0.02), tPt(1.3, sx * 0.85, 0.02), tPt(1.17, sx * 1.35, 0.02), V3(sx * s(0.11), s(1.1), back - s(0.02))];
      B.tube(pts, s(0.012), 4, 'bag', torsoW0, { flat: 0.35 });
    }
  });
  B.at('crossbody', () => {
    const fr = [], bk = []; const N = hi ? 8 : 3;
    for (let i = 0; i <= N; i++) { const t = i / N, y = lerp(1.46, 0.98, t), th = lerp(-0.95, 1.1, t); fr.push(tPt(y, th * (t > 0 ? 1 : 1), 0.022)); bk.push(tPt(y, Math.PI - th * 0.95 + (t > 0.95 ? 0 : 0), 0.02)); }
    B.tube(fr, s(0.01), 4, 'bag', torsoW0, { flat: 0.3 }); B.tube(bk, s(0.01), 4, 'bag', torsoW0, { flat: 0.3 });
    const p = tPt(0.93, 1.25, 0.05); const g = rbox2(s(0.08), s(0.17), s(0.21), s(0.02), hi ? 2 : 1); g.rotateY(0.6); g.translate(p.x, p.y, p.z); B.geo(g, 'bag', one('hips'));
  });
  const handHang = (sd, g, col) => { const ha = wp('hand.' + sd); g.translate(ha.x, ha.y, ha.z); B.geo(g, col, one('hand.' + sd)); };
  B.at('briefcase', () => {
    const g = rbox2(s(0.085), s(0.31), s(0.42), s(0.012), hi ? 2 : 1); g.translate(0, s(-0.27), s(0.02)); handHang('L', g, 'bag');
    if (hi) { const h = new THREE.TorusGeometry(s(0.04), s(0.007), 4, 8, Math.PI); h.rotateY(Math.PI / 2); h.translate(0, s(-0.115), s(0.02)); handHang('L', h, 'metal'); }
  });
  B.at('shopbag', () => {
    const g = new THREE.BoxGeometry(s(0.13), s(0.33), s(0.27)); g.translate(0, s(-0.3), s(0.0)); handHang('L', g, 'bag');
    for (const z of [-0.06, 0.06]) { const h = new THREE.TorusGeometry(s(0.045), s(0.004), 3, 6, Math.PI); h.rotateY(Math.PI / 2); h.translate(0, s(-0.13), s(z)); handHang('L', h, 'bag'); }
  });
  const inHold = (name, g, col) => { g.applyMatrix4(holdM[name].M); B.geo(g, col, one('hand.' + HOLDS[name].sd)); };
  const grip = (name) => { const h = HOLDS[name]; const sx = h.sd === 'L' ? 1 : -1; return V3(-sx * 0.012 * S, -0.075 * S, 0.01 * S).applyMatrix4(holdM[name].posed); };
  B.at('cup', () => { const c = grip('cup'); const g = new THREE.CylinderGeometry(s(0.043), s(0.033), s(0.13), hi ? 12 : 6); g.translate(c.x, c.y + s(0.03), c.z); inHold('cup', g, 'sole');
    const l = new THREE.CylinderGeometry(s(0.046), s(0.046), s(0.012), hi ? 12 : 6); l.translate(c.x, c.y + s(0.1), c.z); inHold('cup', l, 'metal');
    if (hi) { const sl = new THREE.CylinderGeometry(s(0.0425), s(0.038), s(0.05), 12, 1, true); sl.translate(c.x, c.y + s(0.025), c.z); inHold('cup', sl, 'bag'); } });
  B.at('phone', () => { const c = grip('phone').add(V3(0, s(0.035), s(0.01))); const g = rbox2(s(0.072), s(0.15), s(0.009), s(0.004), 1);
    const eye = V3(0, s(1.62), s(0.06)); const m = new THREE.Matrix4().lookAt(c, eye, V3(0, 1, 0)); g.applyMatrix4(m); g.translate(c.x, c.y, c.z); inHold('phone', g, 'metal'); });
  B.at('umbrella', () => {
    const c = grip('umbrella'), top = c.clone().add(V3(0, s(0.86), 0)), m = hi ? 8 : 6;
    inHold('umbrella', cylAB(c.clone().add(V3(0, -s(0.1), 0)), top.clone().add(V3(0, s(0.04), 0)), s(0.007), s(0.006), 5), 'metal');
    if (hi) { const j = new THREE.TorusGeometry(s(0.03), s(0.008), 4, 8, Math.PI); j.rotateZ(Math.PI); j.translate(c.x, c.y - s(0.1), c.z + s(0.03)); j.rotateY(0); inHold('umbrella', j, 'metal'); }
    for (const inw of [false, true]) { const rows = [];
      for (const [r, dy] of [[0, 0.04], [0.2, -0.02], [0.4, -0.11], [0.52, -0.2]]) { const pts = []; for (let k = 0; k < m * (hi ? 2 : 1); k++) { const a = 2 * Math.PI * k / (m * (hi ? 2 : 1)); const sc = hi && k % 2 ? 0.94 : 1;
        pts.push(V3(top.x + Math.sin(a) * s(r) * sc, top.y + s(dy) - (inw ? s(0.004) : 0) + (hi && k % 2 && r > 0.45 ? s(0.015) : 0), top.z + Math.cos(a) * s(r) * sc)); }
        rows.push({ pts, col: 'umbrella', w: one('hand.R') }); }
      const g = new THREE.BufferGeometry(); const pos = [], idx = []; const mm = rows[0].pts.length;
      rows.forEach((r) => r.pts.forEach((p) => pos.push(p.x, p.y, p.z)));
      for (let i = 0; i < rows.length - 1; i++) for (let j = 0; j < mm; j++) { const a = i * mm + j, b = (i + 1) * mm + j, cc = (i + 1) * mm + (j + 1) % mm, d = i * mm + (j + 1) % mm; if (inw) idx.push(a, cc, b, a, d, cc); else idx.push(a, b, cc, a, cc, d); }
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); inHold('umbrella', g, 'umbrella'); }
  });
  B.at('camera', () => {
    const p = tPt(1.22, 0, 0.06); const g = rbox2(s(0.12), s(0.075), s(0.05), s(0.01), 1); g.translate(p.x, p.y, p.z); B.geo(g, 'metal', torsoW0);
    const l = new THREE.CylinderGeometry(s(0.026), s(0.028), s(0.05), hi ? 10 : 6); l.rotateX(Math.PI / 2); l.translate(p.x, p.y - s(0.005), p.z + s(0.045)); B.geo(l, 'metal', torsoW0);
    for (const sx of [-1, 1]) B.tube([V3(p.x + sx * s(0.055), p.y + s(0.02), p.z), tPt(1.36, sx * 0.45, 0.012), V3(sx * s(0.06), s(1.475), s(-0.03)), V3(0, s(1.47), s(-0.075))], s(0.004), 4, 'metal', torsoW0, { flat: 0.4 });
  });
  // ---------------- bicycle (authored in the cycle pose, rigid on the hips) ----------------
  B.at('bicycle', () => {
    const R = CYCLE_RIG, v = (a) => V3(a[0] * S, a[1] * S, a[2] * S), add = (g, col) => { g.applyMatrix4(bikeM); B.geo(g, col, one('hips')); };
    const tub = (a, b, r, col = 'bike') => add(cylAB(a, b, s(r), s(r), hi ? 6 : 4), col);
    const bb = v(R.bb), ra = v(R.rearAxle), fa = v(R.frontAxle), st = V3(0, s(0.84), s(-0.17)), ht0 = V3(0, s(0.62), s(0.42)), ht1 = V3(0, s(0.8), s(0.38));
    for (const ax of [ra, fa]) {
      const t = new THREE.TorusGeometry(s(R.wheelR - 0.02), s(0.02), hi ? 6 : 3, hi ? 28 : 12); t.rotateY(Math.PI / 2); t.translate(ax.x, ax.y, ax.z); add(t, 'metal');
      const rim = new THREE.TorusGeometry(s(R.wheelR - 0.045), s(0.008), 3, hi ? 24 : 10); rim.rotateY(Math.PI / 2); rim.translate(ax.x, ax.y, ax.z); add(rim, 'sole');
      if (hi) for (let k = 0; k < 8; k++) { const a = k * Math.PI / 8; tub(ax.clone().add(V3(0, Math.sin(a), Math.cos(a)).multiplyScalar(s(0.3))), ax.clone().add(V3(0, -Math.sin(a), -Math.cos(a)).multiplyScalar(s(0.3))), 0.0015, 'sole'); }
      const fender = new THREE.TorusGeometry(s(R.wheelR + 0.015), s(0.012), 3, hi ? 12 : 6, Math.PI * 0.9); fender.rotateY(Math.PI / 2); fender.rotateX(ax === ra ? -0.1 : 0.15); fender.translate(ax.x, ax.y, ax.z); add(fender, 'bike');
    }
    tub(bb, st, 0.017); tub(bb, ht0, 0.02); tub(V3(0, s(0.5), s(-0.1)), ht0.clone().lerp(ht1, 0.3), 0.016); tub(ht0, ht1, 0.022);
    for (const sx of [-1, 1]) { tub(bb.clone().setX(sx * s(0.04)), ra.clone().setX(sx * s(0.05)), 0.009); tub(st.clone().setX(sx * s(0.02)), ra.clone().setX(sx * s(0.05)), 0.008); tub(ht0.clone().setX(sx * s(0.02)), fa.clone().setX(sx * s(0.045)), 0.01); }
    const sp = v(R.saddle); tub(st, sp.clone().add(V3(0, -s(0.02), 0)), 0.012, 'metal');
    const sad = rbox2(s(0.15), s(0.05), s(0.26), s(0.02), 1); sad.translate(sp.x, sp.y - s(0.02), sp.z + s(0.01)); add(sad, 'metal');
    const g = R.grips, stem = V3(0, s(g[1] - 0.02), s(g[2] + 0.06)); tub(ht1, stem, 0.013, 'metal');
    const pts = [V3(-s(g[0]), s(g[1]), s(g[2])), V3(-s(0.12), s(g[1] - 0.01), s(g[2] + 0.08)), stem, V3(s(0.12), s(g[1] - 0.01), s(g[2] + 0.08)), V3(s(g[0]), s(g[1]), s(g[2]))];
    for (let i = 0; i < pts.length - 1; i++) tub(pts[i], pts[i + 1], 0.011, 'metal');
    for (const sx of [-1, 1]) tub(V3(sx * s(g[0] - 0.05), s(g[1]), s(g[2])), V3(sx * s(g[0] + 0.03), s(g[1]), s(g[2])), 0.016, 'belt');
    const ring = new THREE.CylinderGeometry(s(0.1), s(0.1), s(0.006), hi ? 16 : 8); ring.rotateZ(Math.PI / 2); ring.translate(-s(0.05), bb.y, bb.z); add(ring, 'metal');
    // rear rack
    tub(V3(-s(0.07), s(0.78), s(-0.3)), V3(-s(0.07), s(0.78), s(-0.72)), 0.006, 'metal'); tub(V3(s(0.07), s(0.78), s(-0.3)), V3(s(0.07), s(0.78), s(-0.72)), 0.006, 'metal');
    for (const sx of [-1, 1]) tub(V3(sx * s(0.07), s(0.78), s(-0.68)), ra.clone().setX(sx * s(0.06)), 0.006, 'metal');
  });
}

// ---------------------------------------------------------------------------------------------
// CLIPS
// ---------------------------------------------------------------------------------------------
function makeClips(P, female) {
  const { S, hy, clip, hipsLimit, footAt } = P;
  const TAU = Math.PI * 2, sin = Math.sin, cos = Math.cos, max = Math.max;
  const armOut = female ? 0.07 : 0.09, fx = { L: 0.105 * S, R: -0.105 * S };

  // ------------------------------- locomotion -------------------------------
  function gait(o) {
    const D = o.v * o.dur;
    const stance = (sd, f) => {
      const t = f / o.beta, g = o.g0 * S - D * f;
      let a = 0;
      if (t < o.h1) a = o.hs * (1 - sstep(0, 1, t / o.h1));
      else if (t > o.h2) a = o.to * ((t - o.h2) / (1 - o.h2)) ** 1.5;
      return { ankle: footAt(fx[sd] * o.width, g, a), pitch: a, toe: a > 0 ? -a : 0, planted: true };
    };
    const herm = (p0, m0, p1, m1, t) => { const t2 = t * t, t3 = t2 * t; return (2 * t3 - 3 * t2 + 1) * p0 + (t3 - 2 * t2 + t) * m0 + (-2 * t3 + 3 * t2) * p1 + (t3 - t2) * m1; };
    const leg = (sd, f) => {
      if (f < o.beta) return stance(sd, f);
      const w = (f - o.beta) / (1 - o.beta), A = stance(sd, o.beta - 1e-6), Bp = stance(sd, 0);
      const m = -o.v * o.dur * (1 - o.beta) * o.tan;
      const z = herm(A.ankle.z, m, Bp.ankle.z, m, w);
      const y = lerp(A.ankle.y, Bp.ankle.y, w) + o.lift * S * sin(Math.PI * w ** o.liftSkew) ** 1.3;
      const pitch = w < o.pm ? lerp(o.to, o.swingPitch, sstep(0, 1, w / o.pm)) : lerp(o.swingPitch, o.hs, sstep(0, 1, (w - o.pm) / (1 - o.pm)));
      return { ankle: V3(fx[sd] * o.width, y, z), pitch, toe: lerp(-o.to, 0, sstep(0, 0.35, w)), planted: false };
    };
    return (u) => {
      const p = u * TAU, legs = { L: leg('L', u % 1), R: leg('R', (u + 0.5) % 1) };
      const roll = o.roll * sin(p - o.rollLag), sw = o.sway * S * sin(p - o.rollLag);
      const pose = { pos: [sw, hy + o.yBase * S + o.bob * S * cos(2 * (p - o.bobAt * TAU)), o.zBob * S * cos(2 * (p - o.bobAt * TAU))], r: {
        hips: [o.lean, -o.yaw * cos(p), roll],
        spine: [o.spineLean, o.yaw * 0.6 * cos(p), -roll * 0.6], chest: [o.chestLean, o.yaw * 0.9 * cos(p - 0.2), -roll * 0.5],
        neck: [-o.headComp * 0.5, -o.yaw * 0.4 * cos(p), 0], head: [-o.headComp * 0.5 - 0.02 * cos(2 * p), -o.yaw * 0.4 * cos(p), roll * 0.3],
        'shoulder.L': [-0.05 * cos(p), 0.04 * cos(p), 0], 'shoulder.R': [0.05 * cos(p), 0.04 * cos(p), 0],
      } };
      for (const [sd, sg] of [['L', 1], ['R', -1]]) {
        const sa = sg * cos(p - o.armLag);
        pose.r['upperarm.' + sd] = [o.armBias + o.arm * sa, 0, sg * (armOut + o.armOutX)];
        pose.r['forearm.' + sd] = [o.elbow - o.elbowSwing * max(0, -sa), sg * o.foreTwist, 0];
        pose.r['hand.' + sd] = [0.05, 0, -sg * 0.1];
      }
      for (const sd of ['L', 'R']) pose.pos[1] = Math.min(pose.pos[1], hipsLimit(pose, sd, legs[sd].ankle));
      pose.legs = legs; return pose;
    };
  }
  const walk = clip('walk', 0.92, 46, gait({ v: 1.45, dur: 0.92, beta: 0.6, h1: 0.14, h2: 0.5, hs: -0.32, to: 0.7, g0: 0.32, width: 0.95, tan: 1, lift: 0.06, liftSkew: 0.8, swingPitch: 0.1, pm: 0.45,
    roll: female ? 0.075 : 0.05, rollLag: 0.5, sway: female ? 0.022 : 0.016, yBase: -0.004, bob: 0.012, bobAt: 0.15, zBob: 0.008, yaw: female ? 0.1 : 0.08, lean: 0.03, spineLean: 0.01, chestLean: 0.0, headComp: 0.03,
    arm: female ? 0.32 : 0.38, armLag: 0.25, armBias: -0.02, armOutX: 0.0, elbow: -0.22, elbowSwing: 0.32, foreTwist: 0 }));
  const run = clip('run', 0.64, 40, gait({ v: 6, dur: 0.64, beta: 0.27, h1: 0.12, h2: 0.42, hs: -0.12, to: 1.0, g0: 0.42, width: 0.65, tan: 1, lift: 0.36, liftSkew: 0.7, swingPitch: 0.75, pm: 0.55,
    roll: 0.035, rollLag: 0.6, sway: 0.008, yBase: -0.035, bob: 0.03, bobAt: 0.38, zBob: 0.0, yaw: 0.12, lean: 0.1, spineLean: 0.06, chestLean: 0.04, headComp: 0.2,
    arm: 0.62, armLag: 0.15, armBias: -0.2, armOutX: 0.06, elbow: -1.45, elbowSwing: 0.25, foreTwist: 0.15 }));
  // jog: 3 m/s, 0.72 s per cycle
  const jog = clip('jog', 0.72, 36, gait({ v: 3, dur: 0.72, beta: 0.38, h1: 0.15, h2: 0.45, hs: -0.2, to: 0.8, g0: 0.36, width: 0.8, tan: 1, lift: 0.16, liftSkew: 0.75, swingPitch: 0.45, pm: 0.5,
    roll: 0.04, rollLag: 0.55, sway: 0.012, yBase: -0.02, bob: 0.022, bobAt: 0.3, zBob: 0, yaw: 0.1, lean: 0.06, spineLean: 0.03, chestLean: 0.02, headComp: 0.1,
    arm: 0.45, armLag: 0.2, armBias: -0.12, armOutX: 0.04, elbow: -1.3, elbowSwing: 0.2, foreTwist: 0.12 }));
  // senior walk: 1.0 m/s, short steps, stooped
  const walkSenior = clip('walk_senior', 1.1, 44, gait({ v: 1.0, dur: 1.1, beta: 0.64, h1: 0.12, h2: 0.55, hs: -0.18, to: 0.42, g0: 0.27, width: 1.08, tan: 1, lift: 0.045, liftSkew: 0.8, swingPitch: 0.05, pm: 0.45,
    roll: 0.045, rollLag: 0.5, sway: 0.024, yBase: -0.018, bob: 0.008, bobAt: 0.15, zBob: 0.006, yaw: 0.06, lean: 0.08, spineLean: 0.07, chestLean: 0.1, headComp: -0.16,
    arm: 0.17, armLag: 0.25, armBias: -0.06, armOutX: 0.02, elbow: -0.35, elbowSwing: 0.12, foreTwist: 0 }));

  // standing base (feet apart, slight weight shift)
  const stand = (shift, extra = {}) => ({
    pos: [0.022 * S * shift, hy - 0.012 * S - 0.006 * S * Math.abs(shift), 0],
    legs: { L: { ankle: V3(0.11 * S, 0.07 * S, 0.015 * S), yaw: 0.12 }, R: { ankle: V3(-0.11 * S, 0.07 * S, -0.01 * S), yaw: -0.14 } }, ...extra,
  });
  const idle = clip('idle', 6, 48, (u) => {
    const p = u * TAU, shift = sin(p), br = sin(2 * p), look = sin(p + 0.7);
    return stand(shift, { r: {
      hips: [0.01, 0.03 * shift, 0.035 * shift], spine: [-0.01 * br, -0.02 * shift, -0.025 * shift], chest: [-0.015 * br, -0.01 * shift, -0.015 * shift],
      neck: [0.02, 0.06 * look, 0.01 * shift], head: [0.03 + 0.02 * sin(3 * p), 0.1 * look + 0.04 * sin(2 * p + 1), 0],
      'shoulder.L': [0, 0, 0.025 * br], 'shoulder.R': [0, 0, -0.025 * br],
      'upperarm.L': [0.02 * br, 0, armOut + 0.01 + 0.01 * br], 'upperarm.R': [0.02 * br, 0, -armOut - 0.01 - 0.01 * br],
      'forearm.L': [-0.14 - 0.02 * shift, 0.1, 0], 'forearm.R': [-0.14 + 0.02 * shift, -0.1, 0], 'hand.L': [0.06, 0, -0.08], 'hand.R': [0.06, 0, 0.08],
    } });
  });
  // talk: standing conversation with beat gestures, nods and glances
  const talk = clip('talk', 4, 48, (u) => {
    const p = u * TAU, shift = 0.6 * sin(p), g1 = max(0, sin(2 * p)) ** 1.5, g2 = max(0, sin(3 * p + 2)) ** 2;
    const pose = stand(shift, { r: {
      hips: [0.01, 0.04 * shift, 0.03 * shift], spine: [0.0, -0.03 * shift + 0.04 * g1, -0.02 * shift], chest: [-0.01, 0.05 * g1 - 0.02, 0],
      neck: [0.02 + 0.05 * sin(4 * p) * g1, 0.08 * sin(p), 0.02 * sin(2 * p)], head: [0.02 + 0.06 * sin(4 * p + 0.5), 0.1 * sin(p + 0.4), 0.04 * sin(2 * p)],
      'shoulder.L': [0, 0, 0.03 * g2], 'shoulder.R': [0, 0, -0.04 * g1],
    } });
    pose.arms = {
      R: { wrist: V3((-0.2 + 0.03 * g1) * S, (0.98 + 0.13 * g1) * S, (0.16 + 0.1 * g1) * S), pole: V3(-1, -0.5, -0.6).normalize() },
      L: { wrist: V3((0.2 - 0.03 * g2) * S, (0.93 + 0.1 * g2) * S, (0.1 + 0.1 * g2) * S), pole: V3(1, -0.5, -0.6).normalize() },
    };
    pose.after = { 'hand.R': [-0.4 * g1, 0.6 * g1, 0.1], 'hand.L': [-0.3 * g2, -0.5 * g2, -0.1] };
    return pose;
  });
  // phone: looking down at a phone held in the right hand (same arm pose as the "phone" hold), left hand helping
  const phone = clip('phone', 5, 40, (u) => {
    const p = u * TAU, shift = 0.5 * sin(p), h = HOLDS.phone;
    const pose = stand(shift, { r: {
      hips: [0.01, 0.03 * shift, 0.03 * shift], spine: [0.02, 0, -0.02 * shift], chest: [0.03, 0, -0.01 * shift],
      neck: [0.2, 0.02 * sin(p), 0], head: [0.3 + 0.03 * sin(3 * p), 0.03 * sin(2 * p), 0],
    } });
    pose.arms = { R: { wrist: V3(...h.wrist).multiplyScalar(S), pole: V3(...h.pole).normalize() },
      L: { wrist: V3((0.02 + 0.01 * sin(5 * p)) * S, 1.11 * S, (0.25 + 0.005 * sin(7 * p)) * S), pole: V3(1, -0.7, -0.2).normalize() } };
    pose.after = { 'hand.L': [-0.6, -0.9, 0] };
    return pose;
  });
  // wait: impatient weight shifting, looking around, checking the watch
  const wait = clip('wait', 8, 64, (u) => {
    const p = u * TAU, shift = sin(p) * 1.4, watch = sstep(0.52, 0.6, u) * (1 - sstep(0.72, 0.8, u)), look = sin(p * 2 + 0.5) * (1 - watch);
    const pose = stand(shift, { r: {
      hips: [0.01, 0.05 * shift, 0.05 * shift], spine: [0, -0.03 * shift, -0.035 * shift], chest: [0, -0.02 * shift, -0.02 * shift],
      neck: [0.03 + 0.15 * watch, 0.18 * look + 0.15 * watch, 0], head: [0.03 + 0.2 * watch, 0.25 * look + 0.2 * watch, 0.03 * look],
      'shoulder.R': [0, 0, -0.02], 'upperarm.R': [0.03, 0, -armOut - 0.02], 'forearm.R': [-0.2, -0.1, 0], 'hand.R': [0.06, 0, 0.08],
    } });
    pose.arms = { L: { wrist: V3(lerp(0.2, 0.05, watch) * S, lerp(0.93, 1.2, watch) * S, lerp(0.07, 0.26, watch) * S), pole: V3(1, -0.4, -0.5).normalize() } };
    pose.after = { 'hand.L': [lerp(0.06, -0.2, watch), lerp(0, 1.2, watch), -0.08] };
    return pose;
  });
  // sit_bench: seat surface at BENCH_RIG.seatY above the root, hips over the root, hands on the thighs
  const sitBench = clip('sit_bench', 6, 36, (u) => {
    const p = u * TAU, br = sin(2 * p);
    const pose = { pos: [0, BENCH_RIG.seatY + 0.085 * S, 0], r: {
      hips: [-0.12, 0, 0], spine: [0.06 - 0.01 * br, 0, 0], chest: [0.05 - 0.01 * br, 0.03 * sin(p), 0], neck: [0.04, 0.1 * sin(p + 0.5), 0], head: [0.04 + 0.03 * sin(2 * p), 0.18 * sin(p + 0.9), 0],
    } };
    pose.legs = { L: { ankle: V3(0.13 * S, 0.07 * S, 0.47 * S), pitch: 0, yaw: 0.12, pole: V3(0.2, 0.4, 1).normalize() }, R: { ankle: V3(-0.12 * S, 0.07 * S, 0.43 * S), pitch: 0, yaw: -0.1, pole: V3(-0.2, 0.4, 1).normalize() } };
    pose.arms = { L: { wrist: V3(0.15 * S, (BENCH_RIG.seatY + 0.17) + 0.005 * br, 0.27 * S), pole: V3(1, 0.1, -1).normalize() }, R: { wrist: V3(-0.15 * S, (BENCH_RIG.seatY + 0.17) + 0.005 * br, 0.25 * S), pole: V3(-1, 0.1, -1).normalize() } };
    pose.after = { 'hand.L': [-1.2, 0, 0.2], 'hand.R': [-1.2, 0, -0.2] };
    return pose;
  });
  const cycle = clip('cycle', 1.0, 24, (u) => cyclePose(P, u));

  const jump = clip('jump', 1.2, 12, (u) => {
    const p = u * TAU, k = 0.06 * sin(p);
    return { pos: [0, hy + 0.04 * S, 0], r: {
      hips: [0.06, 0, 0], spine: [0.1 + k * 0.5, 0, 0], chest: [0.04, 0, 0], neck: [-0.05, 0, 0], head: [-0.1, 0, 0],
      'thigh.L': [-1.0 - k, 0, 0.06], 'shin.L': [1.4 + k, 0, 0], 'foot.L': [0.35, 0, 0], 'thigh.R': [-0.3 + k, 0, -0.06], 'shin.R': [0.85, 0, 0], 'foot.R': [0.45, 0, 0],
      'shoulder.L': [0, 0, 0.1], 'shoulder.R': [0, 0, -0.1],
      'upperarm.L': [-0.7 - k, 0, 0.55], 'upperarm.R': [0.3 + k, 0, -0.6], 'forearm.L': [-0.7, 0, 0], 'forearm.R': [-0.5, 0, 0], 'hand.L': [0, 0, -0.1], 'hand.R': [0, 0, 0.1],
    } };
  });
  const swim = clip('swim', 1.6, 32, (u) => {
    const pose = { pos: [0, hy - 0.1 * S, 0], r: {} }, r = pose.r;
    const rollA = 0.38 * sin(u * TAU - 0.4);
    r.hips = [1.42, rollA, 0]; r.spine = [-0.06, 0.1 * sin(u * TAU - 0.4), 0]; r.chest = [-0.04, 0.12 * sin(u * TAU - 0.4), 0];
    const breathe = max(0, sin(u * TAU - 0.9)) ** 2;
    r.neck = [-0.55, -0.35 * breathe - 0.15 * rollA, 0]; r.head = [-0.35, -0.6 * breathe - 0.2 * rollA, 0];
    for (const [sd, sg, ph] of [['L', 1, 0], ['R', -1, 0.5]]) {
      const w = (u + ph) % 1, a = TAU * (w + 0.07 * sin(TAU * w));
      const rec = max(0, sin(a));
      r['shoulder.' + sd] = [-0.25 * max(0, -cos(a)), 0, sg * 0.15 * rec];
      r['upperarm.' + sd] = [a, 0, sg * (0.2 + 0.55 * rec)];
      r['forearm.' + sd] = [-(0.25 + 1.3 * rec * rec + 0.4 * max(0, -sin(a))), 0, 0];
      r['hand.' + sd] = [0.2, 0, 0];
    }
    for (const [sd, sg] of [['L', 1], ['R', -1]]) { const k = sg * sin(u * TAU * 3); r['thigh.' + sd] = [0.25 * k - 0.05, 0, sg * 0.04]; r['shin.' + sd] = [0.25 + 0.25 * max(0, k), 0, 0]; r['foot.' + sd] = [1.15, 0, 0]; r['toe.' + sd] = [0.2, 0, 0]; }
    return pose;
  });
  // sit: driving pose (root ~0.78 m below seatY), hands on the wheel, feet on the pedals
  const sit = clip('sit', 4, 16, (u) => {
    const p = u * TAU;
    const pose = { pos: [0, hy - 0.045 * S, 0.1 * S], r: {
      hips: [-0.6, 0, 0], spine: [0.1, 0, 0], chest: [0.12, 0, 0], neck: [0.1, 0.06 * sin(p), 0], head: [0.12 + 0.02 * sin(2 * p), 0.1 * sin(p) * sin(p * 0.5), 0],
      'shoulder.L': [-0.15, -0.25, 0.04], 'shoulder.R': [-0.15, 0.25, -0.04],
    } };
    const wy = 1.46 * S, wz = 0.55 * S;
    pose.legs = { L: { ankle: V3(0.13 * S, 0.53 * S, 0.66 * S), pitch: -0.75, yaw: 0.08 }, R: { ankle: V3(-0.13 * S, 0.53 * S + 0.02 * S * sin(p), 0.68 * S), pitch: -0.75 - 0.08 * sin(p), yaw: -0.08 } };
    pose.arms = { L: { wrist: V3(0.15 * S, wy, wz), pole: V3(0.6, -1, -0.3).normalize() }, R: { wrist: V3(-0.15 * S, wy, wz), pole: V3(-0.6, -1, -0.3).normalize() } };
    pose.after = { 'hand.L': [-0.9, 0, -0.35], 'hand.R': [-0.9, 0, 0.35] };
    return pose;
  });
  const fall = clip('fall', 3, 45, (u) => {
    const t = u * 3;
    const k = sstep(0, 0.65, t), hit = sstep(0.55, 0.68, t) * (1 - sstep(0.68, 0.95, t)), settle = sstep(0.7, 1.4, t), br = 0.02 * sin(t * 4) * settle;
    const pose = { pos: [0.04 * S * k, lerp(hy, 0.14 * S, k ** 1.6) + 0.03 * S * hit, -0.55 * S * sstep(0, 0.75, t)], r: {} }, r = pose.r;
    const flail = sin(t * 9) * (1 - settle) * sstep(0, 0.2, t);
    r.hips = [lerp(0, -1.46, k ** 1.3), 0.15 * k, 0.08 * k];
    r.spine = [lerp(0.25 * sstep(0, 0.15, t), 0.02, k) + br, 0, 0]; r.chest = [lerp(0.2 * sstep(0, 0.15, t), -0.04, k) - br, 0, 0];
    r.neck = [lerp(0.35, 0.1 - 0.22 * settle, k), lerp(0, 0.5, settle), 0]; r.head = [lerp(0.3, 0.1 - 0.1 * settle, k), lerp(0, 0.45, settle), 0];
    r['shoulder.L'] = [0, 0, 0.1 * k]; r['shoulder.R'] = [0, 0, -0.1 * k];
    r['upperarm.L'] = [lerp(-0.9, 0.2, settle) + 0.3 * flail, 0, lerp(0.6, 1.25, k)]; r['upperarm.R'] = [lerp(-1.2, 0.2, settle) - 0.3 * flail, 0, lerp(-0.9, -0.75, k)];
    r['forearm.L'] = [lerp(-0.8, -0.1, settle), 0, 0.45 * settle]; r['forearm.R'] = [lerp(-0.4, -0.1, settle), 0, -1.0 * settle];
    r['hand.L'] = [0, 1.2 * settle, 0]; r['hand.R'] = [0, -1.2 * settle, 0];
    r['thigh.L'] = [lerp(-0.5, -0.2, settle) * k, 0, 0.16 * k]; r['shin.L'] = [lerp(0.3, 0.08, settle) + 0.5 * k * (1 - settle), 0, 0];
    r['thigh.R'] = [lerp(-0.9, -0.55, settle) * k - 0.3 * (1 - k) * sstep(0, 0.2, t), 0, -0.12 * k]; r['shin.R'] = [lerp(0.5, 1.0, settle) * sstep(0, 0.4, t), 0, 0];
    r['foot.L'] = [0.25 * settle, 0.3 * settle, 0]; r['foot.R'] = [0.2 * settle, 0, 0];
    return pose;
  });
  const wave = clip('wave', 1.2, 16, (u) => {
    const p = u * TAU;
    return { pos: [-0.012 * S, hy - 0.006 * S, 0], r: {
      hips: [0, 0.05, -0.03], spine: [0, -0.04, 0.03], chest: [0, -0.04, 0.02], neck: [0, -0.05, 0], head: [0.03, -0.1, 0.06],
      'shoulder.R': [0, 0, -0.18], 'upperarm.R': [-0.25, 0, -1.25], 'forearm.R': [0, 0, -1.5 + 0.38 * sin(p)], 'hand.R': [0.1, 0, -0.1 + 0.2 * sin(p - 0.6)],
      'upperarm.L': [0.03, 0, armOut + 0.02], 'forearm.L': [-0.15, 0.1, 0], 'hand.L': [0.06, 0, -0.08],
    }, legs: { L: { ankle: V3(0.11 * S, 0.07 * S, 0.01 * S), yaw: 0.1 }, R: { ankle: V3(-0.11 * S, 0.07 * S, 0), yaw: -0.12 } } };
  });

  return [idle, walk, run, jump, swim, sit, fall, wave, jog, walkSenior, talk, phone, wait, sitBench, cycle];
}
