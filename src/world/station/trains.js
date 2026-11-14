/**
 * Show trains and coaches for the Hauptbahnhof: lofted car bodies (one livery atlas, one material),
 * instanced per car type. Parked consists stand at the platforms; one high-speed train arrives,
 * dwells and departs periodically on a kinematic body (so it still blocks the player).
 */
import * as THREE from 'three';
import { MB } from './kit.js';
import { LIVERY, liveryRect } from './textures.js';

const _m = new THREE.Matrix4(),
  _q = new THREE.Quaternion(),
  _p = new THREE.Vector3(),
  _s = new THREE.Vector3(1, 1, 1),
  YAXIS = new THREE.Vector3(0, 1, 0);

/**
 * Lofts a vehicle body along +x from 0 to L. prof: half profile [[z, y], ...] from the underside edge
 * up to the roof centre. sections: [[x, widthScale, heightScale], ...]. The livery row maps x -> u,
 * the profile up to the shoulder -> v. noseAt: +1 nose at x = L, -1 at x = 0 (sections are mirrored).
 */
function loft(mb, L, prof, sections, row, yb, shoulderIdx, mirrorLeft = false) {
  const [u0, v0, u1, v1] = liveryRect(row);
  // full ring: right half bottom -> top, then left half top -> bottom
  const ring = [...prof.map(([z, y]) => [z, y]), ...prof.slice(0, -1).reverse().map(([z, y]) => [-z, y])];
  // v along the profile: underside (v0) -> shoulder (v1) on both halves; roof stays at the top colour
  const n = prof.length;
  let total = 0;
  const acc = [0];
  for (let i = 1; i <= shoulderIdx; i++) acc.push((total += Math.hypot(prof[i][0] - prof[i - 1][0], prof[i][1] - prof[i - 1][1])));
  const vOf = (k) => {
    const i = k < n ? k : 2 * n - 2 - k;
    return i <= shoulderIdx ? v0 + (v1 - v0) * (acc[i] / total) * 0.995 : v1 - 0.002;
  };
  const pt = (sec, k) => {
    const [x, sw, sh] = sec;
    const [z, y] = ring[k];
    return [x, yb + (y - yb) * sh, z * sw];
  };
  for (let s = 0; s < sections.length - 1; s++) {
    const A = sections[s],
      B = sections[s + 1];
    const ua = u0 + (u1 - u0) * (A[0] / L),
      ub = u0 + (u1 - u0) * (B[0] / L);
    for (let k = 0; k < ring.length - 1; k++) {
      const a = pt(A, k),
        b = pt(B, k),
        c = pt(B, k + 1),
        d = pt(A, k + 1);
      // winding: outward normals (ring runs counter-clockwise seen from +x)
      const left = mirrorLeft && k >= n - 1;
      const pa = left ? u0 + u1 - ua : ua,
        pb = left ? u0 + u1 - ub : ub;
      mb.quad(a, b, c, d, [pa, vOf(k)], [pb, vOf(k)], [pb, vOf(k + 1)], [pa, vOf(k + 1)]);
    }
  }
  // end caps
  const cap = (sec, dir) => {
    const c0 = [sec[0], yb + (prof[n - 1][1] - yb) * sec[2] * 0.5, 0];
    const uv = [u0 + (u1 - u0) * (dir > 0 ? 0.995 : 0.005), v1 - 0.003];
    for (let k = 0; k < ring.length; k++) {
      const a = pt(sec, k),
        b = pt(sec, (k + 1) % ring.length);
      if (dir > 0) mb.quad(c0, b, a, a, uv, uv, uv, uv);
      else mb.quad(c0, a, b, b, uv, uv, uv, uv);
    }
  };
  cap(sections[0], -1);
  cap(sections[sections.length - 1], 1);
}

const RAIL_PROF = (hw, yb, yt) => [
  [hw * 0.94, yb],
  [hw, yb + 0.35],
  [hw, yt - 1.0],
  [hw * 0.95, yt - 0.45],
  [hw * 0.75, yt - 0.12],
  [0, yt],
];

/** Underframe boxes (bogies / wheels) mapped to the dark bottom of the livery row. */
function bogies(mb, xs, hw, row, y1 = 0.95) {
  const [u0, v0, u1] = liveryRect(row);
  const uv = [u0 + 0.5 * (u1 - u0), v0 + 0.002, u0 + 0.5 * (u1 - u0) + 0.001, v0 + 0.004];
  for (const x of xs) mb.box(x - 1.6, x + 1.6, 0.12, y1, -hw * 0.8, hw * 0.8, { uv });
}

/** Car geometries by type (local: x along the car 0..L, y up from the rail head, z across). */
export function carGeometries() {
  const out = {};
  // high-speed middle car
  let mb = new MB();
  const iceProf = RAIL_PROF(1.45, 0.95, 3.9);
  loft(mb, 25, iceProf, [[0.3, 1, 1], [24.7, 1, 1]], LIVERY.ice, 0.95, 3, true);
  bogies(mb, [3.2, 21.8], 1.45, LIVERY.ice);
  out.iceMid = { geo: mb.build(), L: 25 };
  // high-speed power car with a long nose at x = L
  mb = new MB();
  const noseX = [0.3, 12, 14.5, 16.3, 17.7, 18.8, 19.5, 19.85];
  const noseW = [1, 1, 0.97, 0.91, 0.8, 0.64, 0.44, 0.22];
  const noseH = [1, 1, 0.94, 0.82, 0.66, 0.5, 0.36, 0.24];
  loft(
    mb,
    20,
    iceProf,
    noseX.map((x, i) => [x, noseW[i], noseH[i]]),
    LIVERY.iceCab,
    0.95,
    3,
  );
  bogies(mb, [3.2, 15.5], 1.45, LIVERY.iceCab);
  const [cu0, cv0, cu1] = liveryRect(LIVERY.iceCab);
  mb.box(6, 8.5, 3.9, 4.15, -0.4, 0.4, { uv: [cu0 + 0.5 * (cu1 - cu0), cv0 + 0.01, cu0 + 0.5 * (cu1 - cu0) + 0.001, cv0 + 0.012] }); // pantograph base
  mb.beam(7, 4.15, 0, 8.6, 5.2, 0, 0.08, { uv: [cu0, cv0 + 0.01, cu0 + 0.001, cv0 + 0.012] });
  mb.beam(8.6, 5.2, -0.9, 8.6, 5.2, 0.9, 0.08, { uv: [cu0, cv0 + 0.01, cu0 + 0.001, cv0 + 0.012] });
  out.iceCab = { geo: mb.build(), L: 20 };
  // double-deck cars: RE (DB Regio red) and Intercity 2 (white)
  for (const key of ['regio', 'ic2']) {
    mb = new MB();
    loft(mb, 26.8, RAIL_PROF(1.42, 0.5, 4.6), [[0.3, 1, 1], [26.5, 1, 1]], LIVERY[key], 0.5, 3, true);
    bogies(mb, [3, 23.8], 1.42, LIVERY[key], 0.55);
    out[key] = { geo: mb.build(), L: 26.8 };
  }
  // single-deck long-distance coach (FlixTrain)
  mb = new MB();
  loft(mb, 26.4, RAIL_PROF(1.42, 0.95, 4.0), [[0.3, 1, 1], [26.1, 1, 1]], LIVERY.flixCoach, 0.95, 3, true);
  bogies(mb, [3.2, 23.2], 1.42, LIVERY.flixCoach);
  out.flixCoach = { geo: mb.build(), L: 26.4 };
  // electric locomotives: DB red, FlixTrain green, IC white
  for (const key of ['loco', 'flixLoco', 'ic2Loco']) {
    mb = new MB();
    loft(
      mb,
      19,
      RAIL_PROF(1.5, 1.0, 4.2),
      [
        [0.3, 0.86, 0.94],
        [1.2, 1, 1],
        [17.8, 1, 1],
        [18.7, 0.86, 0.94],
      ],
      LIVERY[key],
      1.0,
      3,
      true,
    );
    bogies(mb, [4, 15], 1.5, LIVERY[key]);
    const [lu0, lv0] = liveryRect(LIVERY[key]);
    mb.beam(9.5, 4.2, 0, 11, 5.3, 0, 0.08, { uv: [lu0, lv0 + 0.01, lu0 + 0.001, lv0 + 0.012] });
    out[key] = { geo: mb.build(), L: 19 };
  }
  // EMU cars with rounded cab ends: S-Bahn Rhein-Main and DB Regio RB
  for (const key of ['sbahn', 'rb']) {
    mb = new MB();
    loft(
      mb,
      23,
      RAIL_PROF(1.48, 1.0, 3.95),
      [
        [0.2, 0.84, 0.86],
        [1.2, 0.97, 0.97],
        [2.2, 1, 1],
        [20.8, 1, 1],
        [21.8, 0.97, 0.97],
        [22.8, 0.84, 0.86],
      ],
      LIVERY[key],
      1.0,
      3,
      true,
    );
    bogies(mb, [3, 20], 1.48, LIVERY[key]);
    out[key] = { geo: mb.build(), L: 23 };
  }
  // long-distance coaches (symmetric livery; the left side is mirrored so the lettering reads correctly)
  for (const [key, row] of [
    ['flixbus', LIVERY.flixbus],
    ['blablabus', LIVERY.blablabus],
    ['regiojet', LIVERY.regiojet],
  ]) {
    mb = new MB();
    const prof = [
      [1.22, 0.45],
      [1.27, 0.7],
      [1.27, 3.2],
      [1.2, 3.62],
      [0.9, 3.75],
      [0, 3.78],
    ];
    loft(
      mb,
      13,
      prof,
      [
        [0.05, 0.96, 0.97],
        [0.4, 1, 1],
        [12.6, 1, 1],
        [12.95, 0.96, 0.97],
      ],
      row,
      0.45,
      3,
      true,
    );
    const [u0, v0] = liveryRect(row);
    const dark = [u0, v0 + 0.001, u0 + 0.001, v0 + 0.003];
    for (const x of [2.7, 9.2, 10.6]) for (const z of [-1.05, 1.05]) mb.box(x - 0.52, x + 0.52, 0, 1.04, z - 0.15, z + 0.15, { uv: dark });
    const g = mb.build();
    out[key] = { geo: g, L: 13 };
  }
  return out;
}

/** Consists: list of [type, flipped] from the front (east, platform head) to the back. */
export const CONSISTS = {
  ice: [['iceCab', false], ['iceMid'], ['iceMid'], ['iceMid'], ['iceMid'], ['iceMid'], ['iceCab', true]],
  flix: [['flixLoco'], ['flixCoach'], ['flixCoach'], ['flixCoach'], ['flixCoach'], ['flixCoach']],
  ic2: [['ic2'], ['ic2'], ['ic2'], ['ic2'], ['ic2Loco']],
  re: [['regio'], ['regio'], ['regio'], ['regio'], ['loco']],
  rb: [['rb'], ['rb'], ['rb']],
  sbahn: [['sbahn'], ['sbahn'], ['sbahn'], ['sbahn'], ['sbahn'], ['sbahn']],
};

/**
 * Instanced train fleet. add(kind, uFront, v) places a parked consist; addMover() reserves a
 * consist whose matrices are rewritten each frame. All in the station's local frame.
 */
export class Fleet {
  constructor(geos, material, maxPer = 40) {
    this.geos = geos;
    this.meshes = {};
    this.counts = {};
    for (const k in geos) {
      const m = new THREE.InstancedMesh(geos[k].geo, material, maxPer);
      m.count = 0;
      m.castShadow = true;
      m.receiveShadow = true;
      m.name = `hbf-${k}`;
      this.meshes[k] = m;
      this.counts[k] = 0;
    }
  }
  /** Places the consist with its front at uFront running west. Returns the slots + length. */
  add(kind, uFront, v, y = 0) {
    const slots = [];
    let u = uFront;
    for (const [type, flip] of CONSISTS[kind]) {
      const L = this.geos[type].L;
      const i = this.counts[type]++;
      const mesh = this.meshes[type];
      mesh.count = this.counts[type];
      slots.push({ mesh, i, L, flip: !!flip, off: uFront - u });
      this.setCar(mesh, i, u, v, y, L, !!flip);
      u -= L + 0.6;
    }
    return { slots, length: uFront - u };
  }
  /** One coach (bus) parked with its front at +u or rotated by yaw (local). */
  addVehicle(type, u, v, yaw) {
    const i = this.counts[type]++;
    const mesh = this.meshes[type];
    mesh.count = this.counts[type];
    _q.setFromAxisAngle(YAXIS, yaw);
    _p.set(u, 0, v);
    _m.compose(_p, _q, _s);
    // geometry runs 0..L along x: shift so (u, v) is the centre
    const L = this.geos[type].L;
    const off = new THREE.Matrix4().makeTranslation(-L / 2, 0, 0);
    _m.multiply(off);
    mesh.setMatrixAt(i, _m);
    mesh.instanceMatrix.needsUpdate = true;
  }
  /** Car occupying [u - L, u] (front at u, facing +u), or flipped (nose at the back). */
  setCar(mesh, i, uFront, v, y, L, flip) {
    if (flip) _q.setFromAxisAngle(YAXIS, Math.PI);
    else _q.identity();
    _p.set(flip ? uFront : uFront - L, y, v);
    _m.compose(_p, _q, _s);
    mesh.setMatrixAt(i, _m);
    mesh.instanceMatrix.needsUpdate = true;
  }
  /** Moves a consist returned by add() so its front is at uFront. */
  move(train, uFront, v, visible = true) {
    for (const s of train.slots) {
      const u = uFront - s.off;
      if (visible) this.setCar(s.mesh, s.i, u, v, 0, s.L, s.flip);
      else {
        _m.makeScale(0, 0, 0);
        s.mesh.setMatrixAt(s.i, _m);
        s.mesh.instanceMatrix.needsUpdate = true;
      }
    }
  }
}
