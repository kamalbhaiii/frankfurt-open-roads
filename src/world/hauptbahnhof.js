/**
 * Frankfurt (Main) Hauptbahnhof: a walkable model of the station replacing the generic OSM
 * footprints (see station/zones.js for the local frame and the exclusion zones).
 *
 *   - Empfangsgebäude on the Bahnhofsvorplatz: sandstone facade, central pavilion with the big
 *     arched window, clock, "HAUPTBAHNHOF" lettering and the Atlas group, wings, corner pavilions
 *   - five barrel-vaulted iron-and-glass train sheds (three big, two small) with trussed ribs,
 *     purlins, glazed gable aprons and the columns between the halls
 *   - Querbahnsteig (head concourse) with shops, live departure boards (Frankfurt game time),
 *     ticket machines, benches; open archways from the Vorplatz and from both side streets
 *   - 24 terminus tracks with platforms (low enough to step onto), buffer stops, numbers,
 *     platform displays, benches and lamps
 *   - parked show trains plus one high-speed train that arrives, dwells and departs
 *   - Fernbusterminal along the south wall (bays, shelters, parked coaches), taxi rank, bike racks
 *   - a small local crowd on the concourse and platforms
 *
 * Performance: everything is created at build time (materials, textures, meshes), merged per
 * material (exterior / interior groups) or instanced (ribs, train cars). No lights: interiors
 * glow at night through emissive intensities that follow uNight. Collision goes into the static
 * city trimesh (phys.push) before the physics world is built.
 */
import * as THREE from 'three';
import { ctx } from '../core/context.js';
import { rnd } from '../core/math.js';
import { frankfurtClock } from './roadNetwork.js';
import { randomPerson } from '../actors/characters.js';
import { HBF, STATION_YAW, fromUV } from './station/zones.js';
import { MB, CB, archWall, facadeMatrix, sideMatrix } from './station/kit.js';
import { stoneTexture, floorTexture, glassTexture, shopTexture, signTexture, liveryTexture, SIGN_UV, SHOP_COUNT, DepartureBoards } from './station/textures.js';
import { carGeometries, Fleet } from './station/trains.js';

const FL = 0.36; // station floor level (platforms + concourse): one easy step from the pavement
const C = (hex) => new THREE.Color(hex);
const COL = {
  white: C(0xffffff),
  stoneDark: C(0xbfb3a0),
  plinth: C(0x9d927f),
  slate: C(0x48525b),
  zinc: C(0x6e787c),
  iron: C(0x3f4d4b),
  ironLight: C(0x5d6b68),
  concrete: C(0x8d8981),
  ballast: C(0x544e47),
  asphalt: C(0x3a3c3f),
  edge: C(0xe8e6df),
  tactile: C(0xb9b4a8),
  yellow: C(0xe2c23a),
  red: C(0xb51d1d),
  wood: C(0x7a5232),
  bench: C(0x2f4a5c),
  patina: C(0x5d8a77),
  dark: C(0x222629),
  glassFrame: C(0x2c3436),
};
const HALL = { big: { s: 6, H: 28, apronW: 11, apronE: 17 }, small: { s: 5, H: 19.5, apronW: 9, apronE: 13 } };
const RIB_N = 20; // bays per shed
const LIT_DAY = new THREE.Color(0x8295a2);

/** Quads facing a principal axis. o.uv: atlas rect [u0, v0, u1, v1] (left/right as seen from the front), else world uvs * o.s. */
function wall(b, axis, sign, at, a0, a1, y0, y1, o = {}) {
  let P;
  if (axis === 'u')
    P =
      sign > 0
        ? [
            [at, y0, a1],
            [at, y0, a0],
            [at, y1, a0],
            [at, y1, a1],
          ]
        : [
            [at, y0, a0],
            [at, y0, a1],
            [at, y1, a1],
            [at, y1, a0],
          ];
  else
    P =
      sign > 0
        ? [
            [a0, y0, at],
            [a1, y0, at],
            [a1, y1, at],
            [a0, y1, at],
          ]
        : [
            [a1, y0, at],
            [a0, y0, at],
            [a0, y1, at],
            [a1, y1, at],
          ];
  if (o.uv) {
    const [U0, V0, U1, V1] = o.uv;
    b.quad(P[0], P[1], P[2], P[3], [U0, V0], [U1, V0], [U1, V1], [U0, V1], o.col);
  } else b.quadW(P[0], P[1], P[2], P[3], o.s ?? 0.25, o.col);
}
/** Horizontal quad facing up (or down) over u0..u1 x v0..v1. */
function flat(b, u0, u1, v0, v1, y, o = {}) {
  const s = o.s ?? 0.25;
  const P = o.down
    ? [
        [u0, y, v0],
        [u1, y, v0],
        [u1, y, v1],
        [u0, y, v1],
      ]
    : [
        [u0, y, v1],
        [u1, y, v1],
        [u1, y, v0],
        [u0, y, v0],
      ];
  if (o.uv) {
    const [U0, V0, U1, V1] = o.uv;
    b.quad(P[0], P[1], P[2], P[3], [U0, V0], [U1, V0], [U1, V1], [U0, V1], o.col);
  } else b.quad(P[0], P[1], P[2], P[3], [P[0][0] * s, P[0][2] * s], [P[1][0] * s, P[1][2] * s], [P[2][0] * s, P[2][2] * s], [P[3][0] * s, P[3][2] * s], o.col);
}

export class Hauptbahnhof {
  constructor() {
    this.q = { low: 0, medium: 1, high: 2, ultra: 3 }[ctx.quality] ?? 1;
    this.root = new THREE.Group();
    this.root.name = 'hauptbahnhof';
    this.root.rotation.y = STATION_YAW;
    this.interior = new THREE.Group();
    this.interior.name = 'hauptbahnhof-interior';
    this.root.add(this.interior);
    this.builders = new Map();
    this.cb = new CB();
    this.lastNight = -1;
    this.boardT = -10;
    this.clockTimer = 0;
    this.time = 0;
    const [cx, cz] = fromUV(-930, 6);
    this.centre = new THREE.Vector3(cx, 0, cz);
    this.crowd = [];
    this.taxis = [];
    this.taxiTimer = 0;
  }

  /** Builder for (group, material): 'ext' meshes are always shown, 'int' only near the station. */
  B(mat, group = 'ext') {
    const key = `${group}:${mat}`;
    let b = this.builders.get(key);
    if (!b) this.builders.set(key, (b = new MB()));
    return b;
  }

  build(phys) {
    this.makeMaterials();
    this.buildGround();
    this.buildPlatforms();
    this.buildSheds();
    this.buildReception();
    this.buildConcourse();
    this.buildTerminal();
    this.buildVorplatz();
    this.buildTrains();
    this.emitMeshes();
    this.buildCrowd();
    ctx.scene.add(this.root);
    this.root.updateMatrixWorld(true);
    // the warm-up render (main.js warmUpShaders) must upload every buffer and texture of the station,
    // not only compile its shaders: disable frustum culling until the first game update
    this.prewarm = [];
    this.root.traverse((o) => {
      if (o.isMesh && o.frustumCulled) {
        o.frustumCulled = false;
        this.prewarm.push(o);
      }
    });
    for (const k in this.mats) if (this.mats[k].map) ctx.renderer.initTexture?.(this.mats[k].map);
    phys.push(this.cb.toGeometry(this.root.matrixWorld));
    this.cb = null;
    this.boards.update(12, 0);
  }

  // ------------------------------------------------------------------ materials
  makeMaterials() {
    const env = 0.6;
    this.boards = new DepartureBoards();
    const glassTex = glassTexture();
    this.mats = {
      stone: new THREE.MeshStandardMaterial({ map: stoneTexture(), color: 0xfff0dc, vertexColors: true, roughness: 0.88, envMapIntensity: env, emissive: 0xfff0dc, emissiveIntensity: 0 }),
      lit: new THREE.MeshStandardMaterial({ color: 0x8295a2, roughness: 0.15, metalness: 0.3, emissive: 0xffc982, emissiveIntensity: 0, envMapIntensity: 1 }),
      plain: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, envMapIntensity: env, emissive: 0x6e655a, emissiveIntensity: 0 }),
      iron: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.45, envMapIntensity: env, emissive: 0x5a5448, emissiveIntensity: 0 }),
      skin: new THREE.MeshStandardMaterial({ color: 0x6f797c, roughness: 0.6, metalness: 0.35, side: THREE.DoubleSide, envMapIntensity: env, emissive: 0x4a4339, emissiveIntensity: 0 }),
      glass: new THREE.MeshStandardMaterial({
        map: glassTex,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        roughness: 0.12,
        metalness: 0.2,
        envMapIntensity: 1,
        forceSinglePass: true, // one pass for the double-sided roof glass
      }),
      floor: new THREE.MeshStandardMaterial({ map: floorTexture(), vertexColors: true, roughness: 0.32, emissive: 0xfff1da, emissiveIntensity: 0, envMapIntensity: env }),
      shops: new THREE.MeshStandardMaterial({ map: shopTexture(), roughness: 0.35, emissive: 0xffffff, emissiveIntensity: 0.25 }),
      signs: new THREE.MeshBasicMaterial({ map: signTexture(), alphaTest: 0.5, side: THREE.DoubleSide }),
      boards: new THREE.MeshBasicMaterial({ map: this.boards.texture }),
      lamp: new THREE.MeshBasicMaterial({ color: 0xfff2d6 }),
      livery: new THREE.MeshStandardMaterial({ map: liveryTexture(), roughness: 0.4, metalness: 0.15, envMapIntensity: 0.9, emissive: 0xffffff, emissiveIntensity: 0 }),
    };
    this.mats.floor.emissiveMap = this.mats.floor.map;
    this.mats.shops.emissiveMap = this.mats.shops.map;
    this.mats.stone.emissiveMap = this.mats.stone.map;
    this.mats.livery.emissiveMap = this.mats.livery.map;
    for (const k in this.mats) this.mats[k].name = `hbf-${k}`;
  }

  // ------------------------------------------------------------------ ground, track bed
  buildGround() {
    const p = this.B('plain');
    // ballast under the sheds (the OSM rails draw their own ballast strips on top)
    flat(p, HBF.platW - 6, HBF.bufferU + 1, HBF.vN, HBF.vS, 0.012, { col: COL.ballast });
  }

  // ------------------------------------------------------------------ platforms, buffer stops
  buildPlatforms() {
    const T = HBF.tracks;
    const plats = [];
    plats.push([HBF.vN + 0.6, T[0] - 1.65]);
    for (let i = 0; i < T.length - 1; i++) if (T[i + 1] - T[i] >= 9) plats.push([T[i] + 1.65, T[i + 1] - 1.65]);
    plats.push([T[T.length - 1] + 1.65, HBF.vS - 0.6]);
    this.platforms = plats;
    const f = this.B('floor'),
      p = this.B('plain'),
      ip = this.B('plain', 'int'),
      iron = this.B('iron', 'int'),
      lamp = this.B('lamp', 'int'),
      signs = this.B('signs', 'int'),
      boards = this.B('boards', 'int');
    const u0 = HBF.platW,
      u1 = HBF.bufferU + 3;
    for (const [v0, v1] of plats) {
      // body + top
      flat(f, u0, u1, v0, v1, FL, { s: 0.5 });
      wall(p, 'v', -1, v0, u0, u1, 0, FL, { col: COL.concrete });
      wall(p, 'v', 1, v1, u0, u1, 0, FL, { col: COL.concrete });
      // edge coping, tactile strip and the white safety line on both edges
      for (const [e, d] of [
        [v0, 1],
        [v1, -1],
      ]) {
        const a = e,
          b = e + d * 0.35;
        flat(p, u0, u1, Math.min(a, b), Math.max(a, b), FL + 0.004, { col: COL.edge });
        const t0 = e + d * 0.55,
          t1 = e + d * 0.85;
        flat(p, u0, u1, Math.min(t0, t1), Math.max(t0, t1), FL + 0.004, { col: COL.tactile });
        const w0 = e + d * 0.95,
          w1 = e + d * 1.03;
        flat(p, u0, u1, Math.min(w0, w1), Math.max(w0, w1), FL + 0.004, { col: COL.white });
      }
      // west-end ramp down to the track bed (visual + collision)
      const r0 = u0 - 6;
      p.quad([r0, 0.01, v1], [u0, FL, v1], [u0, FL, v0], [r0, 0.01, v0], [0, 0], [1, 0], [1, 1], [0, 1], COL.concrete);
      this.cb.box(u0, u1 + 0.5, 0, FL, v0, v1);
      this.cb.ramp(r0, u0, 0.01, FL, v0, v1);
      // furniture along the platform
      const vc = (v0 + v1) / 2,
        w = v1 - v0;
      const colLine = HBF.halls.some(([a]) => Math.abs(a - vc) < 1.5);
      const off = colLine ? 2.2 : 0;
      if (w > 5) {
        const benchStep = [60, 40, 30, 28][this.q];
        for (let u = u1 - 20; u > u0 + 8; u -= benchStep) this.bench(ip, iron, u, vc + off, 0);
        const lampStep = [40, 28, 22, 20][this.q];
        for (let u = u1 - 8; u > u0 + 4; u -= lampStep) {
          const lv = vc - off;
          iron.cyl(u, lv, FL, FL + 4.2, 0.07, 6, { col: COL.iron });
          iron.box(u - 0.6, u + 0.6, FL + 4.1, FL + 4.25, lv - 0.12, lv + 0.12, { col: COL.iron });
          lamp.box(u - 0.55, u + 0.55, FL + 4.0, FL + 4.1, lv - 0.09, lv + 0.09);
        }
        // station-name signs (double-sided) on posts
        for (let u = u1 - 45; u > u0 + 20; u -= 60) {
          const sv = vc + (colLine ? -off : 1.2);
          iron.cyl(u - 1.4, sv, FL, FL + 3.6, 0.06, 6, { col: COL.iron });
          iron.cyl(u + 1.4, sv, FL, FL + 3.6, 0.06, 6, { col: COL.iron });
          wall(signs, 'v', 1, sv + 0.03, u - 1.6, u + 1.6, FL + 2.8, FL + 3.6, { uv: SIGN_UV.hbfSign });
          wall(signs, 'v', -1, sv - 0.03, u - 1.6, u + 1.6, FL + 2.8, FL + 3.6, { uv: SIGN_UV.hbfSign });
        }
        // bins
        for (let u = u1 - 30; u > u0 + 8; u -= 50) ip.cyl(u, vc - off + 0.9, FL, FL + 0.85, 0.25, 8, { col: COL.dark });
      }
    }
    // platform heads: number sign + live display per track, buffer stops
    T.forEach((t, i) => {
      // which side is the platform? the nearer platform edge
      const pl = plats.reduce((best, pq) => {
        const d = Math.min(Math.abs(pq[0] - t), Math.abs(pq[1] - t));
        return !best || d < best.d ? { d, pq } : best;
      }, null).pq;
      const side = pl[0] > t ? 1 : -1;
      const sv = t + side * 3.0;
      const su = HBF.bufferU - 8;
      iron.cyl(su, sv, FL, FL + 4.9, 0.08, 6, { col: COL.iron });
      iron.box(su - 0.1, su + 0.1, FL + 3.15, FL + 4.95, sv - 1.35, sv + 1.35, { col: COL.iron });
      wall(boards, 'u', 1, su + 0.11, sv - 1.3, sv + 1.3, FL + 3.25, FL + 3.95, { uv: DepartureBoards.trackUV(i) });
      wall(boards, 'u', -1, su - 0.11, sv - 1.3, sv + 1.3, FL + 3.25, FL + 3.95, { uv: DepartureBoards.trackUV(i) });
      wall(signs, 'u', 1, su + 0.12, sv - 0.4, sv + 0.4, FL + 4.05, FL + 4.85, { uv: SIGN_UV.platform(i) });
      wall(signs, 'u', -1, su - 0.12, sv - 0.4, sv + 0.4, FL + 4.05, FL + 4.85, { uv: SIGN_UV.platform(i) });
      // buffer stop at the real end of the track
      const end = t === -98 ? -974 : HBF.bufferU;
      p.box(end + 0.2, end + 3.2, 0, 0.9, t - 1.3, t + 1.3, { col: COL.concrete });
      p.box(end - 0.5, end + 0.2, 0.85, 1.25, t - 1.45, t + 1.45, { col: COL.red });
      for (const s of [-0.85, 0.85]) p.box(end - 1.0, end - 0.5, 0.95, 1.15, t + s - 0.2, t + s + 0.2, { col: COL.dark });
      lamp.box(end + 0.4, end + 0.7, 1.25, 1.45, t - 0.15, t + 0.15);
      this.cb.box(end - 1.0, end + 3.2, 0, 1.25, t - 1.45, t + 1.45);
    });
  }

  bench(p, iron, u, v, yaw) {
    // seat along u (people sit facing +v / -v alternately)
    const y = FL;
    p.box(u - 1.0, u + 1.0, y + 0.42, y + 0.47, v - 0.25, v + 0.25, { col: COL.bench });
    p.box(u - 1.0, u + 1.0, y + 0.5, y + 0.85, v - 0.03, v + 0.03, { col: COL.bench });
    for (const s of [-0.8, 0.8]) iron.box(u + s - 0.04, u + s + 0.04, y, y + 0.85, v - 0.25, v + 0.25, { col: COL.iron });
    void yaw;
  }

  // ------------------------------------------------------------------ train sheds
  buildSheds() {
    const glass = this.B('glass'),
      skin = this.B('skin'),
      iron = this.B('iron'),
      stone = this.B('stone');
    const u0 = HBF.hallW,
      u1 = HBF.hallE;
    const SEG = this.q === 0 ? 16 : 24;
    const ribs = { big: [], small: [] };
    for (const [a, b, type] of HBF.halls) {
      const { s, H, apronW, apronE } = HALL[type];
      const c = (a + b) / 2,
        w = (b - a) / 2;
      const at = (phi, inset = 0) => [c - Math.cos(phi) * (w - inset), s + Math.sin(phi) * (H - s - inset)];
      // roof skin: zinc on the flanks, a glazed band over the middle
      let arc = 0;
      for (let k = 0; k < SEG; k++) {
        const p0 = at((Math.PI * k) / SEG),
          p1 = at((Math.PI * (k + 1)) / SEG);
        const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
        const mid = Math.cos((Math.PI * (k + 0.5)) / SEG);
        const isGlass = Math.abs(mid) < 0.62;
        const tgt = isGlass ? glass : skin;
        const A = [u0, p0[1], p0[0]],
          B = [u1, p0[1], p0[0]],
          Cq = [u1, p1[1], p1[0]],
          D = [u0, p1[1], p1[0]];
        if (isGlass) tgt.quad(A, D, Cq, B, [u0 / 3, arc / 3], [u0 / 3, (arc + len) / 3], [u1 / 3, (arc + len) / 3], [u1 / 3, arc / 3]);
        else tgt.quad(A, D, Cq, B, [0, 0], [0, 1], [1, 1], [1, 0]);
        arc += len;
      }
      // ridge lantern (raised glazed roof ridge)
      iron.box(u0, u1, H + 0.05, H + 0.35, c - 2.2, c + 2.2, { col: COL.ironLight });
      // purlins
      for (let k = 1; k < 8; k++) {
        const [z, y] = at((Math.PI * k) / 8, 0.25);
        iron.box(u0, u1, y - 0.15, y + 0.15, z - 0.12, z + 0.12, { col: COL.iron });
      }
      // ribs (instanced below) at each bay line, gable ends included
      for (let k = 0; k <= RIB_N; k++) ribs[type].push([u0 + ((u1 - u0) * k) / RIB_N, c]);
      // glazed gable aprons at both ends (open below for the trains)
      for (const [ue, yA] of [
        [u0, apronW],
        [u1 - 0.4, apronE],
      ]) {
        const pts = [];
        const phiA = Math.asin(Math.min(1, (yA - s) / (H - s)));
        const n = 18;
        for (let k = 0; k <= n; k++) pts.push(at(phiA + ((Math.PI - 2 * phiA) * k) / n));
        const zc = c,
          yc = (yA + H) / 2;
        for (let k = 0; k < n; k++) {
          const P0 = [ue, pts[k][1], pts[k][0]],
            P1 = [ue, pts[k + 1][1], pts[k + 1][0]],
            M = [ue, yc, zc];
          glass.quad(M, P0, P1, P1, [zc / 3, yc / 3], [P0[2] / 3, P0[1] / 3], [P1[2] / 3, P1[1] / 3], [P1[2] / 3, P1[1] / 3]);
        }
        // bottom of the apron: a strong girder; mullions
        const zl = pts[0][0],
          zr = pts[n][0];
        iron.box(ue - 0.35, ue + 0.35, yA - 0.6, yA, Math.min(zl, zr), Math.max(zl, zr), { col: COL.iron });
        for (let z = Math.min(zl, zr) + 3; z < Math.max(zl, zr) - 1; z += 3) {
          const t = (z - c) / w;
          const top = s + Math.sqrt(Math.max(0, 1 - t * t)) * (H - s);
          iron.box(ue - 0.12, ue + 0.12, yA, top, z - 0.08, z + 0.08, { col: COL.iron });
        }
        if (ue === u0) {
          const z0 = Math.min(zl, zr),
            z1 = Math.max(zl, zr);
          iron.box(ue - 0.12, ue + 0.12, yA + (H - yA) * 0.45, yA + (H - yA) * 0.45 + 0.2, z0, z1, { col: COL.iron });
        }
      }
    }
    // columns + valley gutters on the hall boundaries
    const bounds = [-77, -22, 35, 90];
    for (const v of bounds) {
      iron.box(u0, u1, 5.4, 6.2, v - 0.7, v + 0.7, { col: COL.iron });
      for (let k = 0; k <= RIB_N; k++) {
        const u = u0 + ((u1 - u0) * k) / RIB_N;
        iron.box(u - 0.35, u + 0.35, 0, 5.6, v - 0.35, v + 0.35, { col: COL.iron });
        iron.box(u - 0.55, u + 0.55, 0, 0.5, v - 0.55, v + 0.55, { col: COL.ironLight });
        iron.box(u - 0.6, u + 0.6, 5.2, 5.6, v - 0.8, v + 0.8, { col: COL.ironLight });
        this.cb.box(u - 0.4, u + 0.4, 0, 5.6, v - 0.4, v + 0.4);
      }
    }
    // outer side walls with arched windows (north v = vN, south v = vS); the concourse part has a doorway
    for (const [vf, dir] of [
      [HBF.vN, -1],
      [HBF.vS, 1],
    ]) {
      const L = HBF.bufferU - 5 - u0; // shed part
      const holes = [];
      for (let k = 0; k < RIB_N - 3; k++) holes.push({ x: -L / 2 + 4.67 + k * 9.35, y: 1.4, w: 3.6, h: 3.8 });
      const g = archWall(L, 5.6, holes, 1.0);
      stone.geo(g, sideMatrix(vf + dir * 1.0, 1.0, u0 + L / 2, 0, dir), COL.white, null, 0.25);
      wall(glass, 'v', dir, vf + dir * 0.5, u0, u0 + L, 1.4, 5.2, { s: 1 / 3 });
      this.cb.box(u0, u0 + L, 0, 5.6, Math.min(vf, vf + dir * 1.0), Math.max(vf, vf + dir * 1.0));
      // concourse part: a tall wall with an open arched doorway, steps outside
      const ua = u0 + L,
        ub = HBF.hallE,
        Lc = ub - ua;
      const dc = (ua + ub) / 2;
      const gc = archWall(Lc, 11, [{ x: dir > 0 ? 0 : 0, y: 0, w: 7, h: 7.5 }], 1.2);
      stone.geo(gc, sideMatrix(vf + dir * 1.2, 1.2, dc, 0, dir), COL.white, null, 0.25);
      this.cb.box(ua, dc - 3.5, 0, 11, Math.min(vf, vf + dir * 1.2), Math.max(vf, vf + dir * 1.2));
      this.cb.box(dc + 3.5, ub, 0, 11, Math.min(vf, vf + dir * 1.2), Math.max(vf, vf + dir * 1.2));
      // floor through the doorway + two steps outside
      const f = this.B('floor');
      const vIn = vf,
        vOut = vf + dir * 1.2;
      flat(f, dc - 3.5, dc + 3.5, Math.min(vIn, vOut), Math.max(vIn, vOut), FL, { s: 0.5 });
      this.cb.box(dc - 3.5, dc + 3.5, 0, FL, Math.min(vIn, vOut), Math.max(vIn, vOut));
      for (const [k, y] of [
        [0, 0.24],
        [1, 0.12],
      ]) {
        const a = vOut + dir * k * 0.45,
          b = vOut + dir * (k + 1) * 0.45;
        stone.box(dc - 4, dc + 4, 0, y, Math.min(a, b), Math.max(a, b), { col: COL.stoneDark });
        this.cb.box(dc - 4, dc + 4, 0, y, Math.min(a, b), Math.max(a, b));
      }
      // a station sign over the doorway
      wall(this.B('signs'), 'v', dir, vf + dir * 1.25, dc - 3.2, dc + 3.2, 8.2, 9.8, { uv: SIGN_UV.hbfSign });
      // wall top cornice
      stone.box(u0, ub, 5.6, 6.1, Math.min(vf, vf + dir * 1.3), Math.max(vf, vf + dir * 1.3), { col: COL.stoneDark });
    }
    this.ribGeos = { big: this.ribGeometry('big'), small: this.ribGeometry('small') };
    this.ribPlaces = ribs;
  }

  /** One trussed arch rib in its own frame (x = 0 plane, z across the hall centred on 0). */
  ribGeometry(type) {
    const { s, H } = HALL[type];
    const w = type === 'big' ? 27.5 : 17;
    const mb = new MB();
    const n = [12, 16, 20, 22][this.q];
    const depth = type === 'big' ? 1.3 : 0.9;
    const pt = (phi, inset) => [-Math.cos(phi) * (w - inset), s + Math.sin(phi) * (H - s - inset)];
    const col = COL.iron;
    for (let k = 0; k < n; k++) {
      const a = pt((Math.PI * k) / n, 0.35),
        b = pt((Math.PI * (k + 1)) / n, 0.35);
      mb.beam(0, a[1], a[0], 0, b[1], b[0], 0.42, { col });
      if (this.q > 0) {
        const c = pt((Math.PI * k) / n, 0.35 + depth),
          d = pt((Math.PI * (k + 1)) / n, 0.35 + depth);
        mb.beam(0, c[1], c[0], 0, d[1], d[0], 0.26, { col });
        mb.beam(0, a[1], a[0], 0, d[1], d[0], 0.12, { col });
        mb.beam(0, c[1], c[0], 0, c[1], c[0], 0.12, { col });
        mb.beam(0, a[1], a[0], 0, c[1], c[0], 0.14, { col });
      }
    }
    return mb.build();
  }

  // ------------------------------------------------------------------ reception building
  buildReception() {
    const stone = this.B('stone'),
      lit = this.B('lit'),
      plain = this.B('plain'),
      iron = this.B('iron'),
      glass = this.B('glass'),
      signs = this.B('signs');
    const back = HBF.hallE,
      front = HBF.front;
    const cv = 6.5; // axis of the central hall
    const pv0 = cv - 20.5,
      pv1 = cv + 20.5; // central pavilion
    const pf = front + 6; // the pavilion projects towards the Vorplatz
    const archW = 25,
      archH = 27;
    // ---- central pavilion front wall with the great arch
    stone.geo(archWall(pv1 - pv0, 31, [{ x: 0, y: 0, w: archW, h: archH }], 1.6, 18), facadeMatrix(pf, 1.6, cv), COL.white, null, 0.25);
    // plinth + pilasters + cornice
    stone.box(pf, pf + 0.5, 0, 1.4, pv0, cv - archW / 2, { col: COL.plinth });
    stone.box(pf, pf + 0.5, 0, 1.4, cv + archW / 2, pv1, { col: COL.plinth });
    for (const v of [pv0 + 1.4, pv0 + 5.2, pv1 - 1.4, pv1 - 5.2]) stone.box(pf, pf + 0.6, 1.4, 30, v - 0.7, v + 0.7, { col: COL.stoneDark });
    stone.box(pf - 0.2, pf + 1.0, 30, 31.2, pv0 - 0.6, pv1 + 0.6, { col: COL.stoneDark });
    stone.box(back, pf, 31, 33.5, pv0, pv1, { col: COL.white });
    stone.box(pf - 0.2, pf + 0.8, 33.5, 34.2, pv0 - 0.4, pv1 + 0.4, { col: COL.stoneDark });
    // arch voussoirs (a raised band around the arch)
    const ring = new THREE.Shape();
    const R = archW / 2;
    const sp = archH - R;
    ring.moveTo(R + 0.8, sp);
    for (let k = 0; k <= 24; k++) ring.lineTo((R + 0.8) * Math.cos((Math.PI * k) / 24), sp + (R + 0.8) * Math.sin((Math.PI * k) / 24));
    ring.lineTo(-R, sp);
    for (let k = 24; k >= 0; k--) ring.lineTo(R * Math.cos((Math.PI * k) / 24), sp + R * Math.sin((Math.PI * k) / 24));
    stone.geo(new THREE.ExtrudeGeometry(ring, { depth: 0.5, bevelEnabled: false }), facadeMatrix(pf + 0.5, 0.5, cv), COL.stoneDark, null, 0.25);
    // the arched window (glass) and its iron tracery; the doorways below stay open
    const winY = 7.8;
    const win = new THREE.Shape();
    win.moveTo(-R, winY);
    win.lineTo(R, winY);
    win.lineTo(R, sp);
    for (let k = 1; k <= 24; k++) win.lineTo(R * Math.cos((Math.PI * k) / 24), sp + R * Math.sin((Math.PI * k) / 24));
    win.lineTo(-R, winY);
    glass.geo(new THREE.ShapeGeometry(win, 24), facadeMatrix(pf - 0.9, 0, cv), COL.white, null, 1 / 3);
    const archTop = (x) => sp + Math.sqrt(Math.max(0, R * R - x * x));
    for (let x = -R + 2.5; x < R - 0.5; x += 2.5) iron.box(pf - 1.0, pf - 0.75, winY, archTop(x), cv - x - 0.09, cv - x + 0.09, { col: COL.glassFrame });
    for (const y of [11.5, 15.5, 19.5, 23.5]) {
      const hx = Math.sqrt(Math.max(0, R * R - Math.max(0, y - sp) ** 2));
      iron.box(pf - 1.0, pf - 0.75, y - 0.1, y + 0.1, cv - hx, cv + hx, { col: COL.glassFrame });
    }
    // doorway piers + lintel (three open portals)
    const bay = (archW - 2 * 1.4) / 3;
    for (const k of [1, 2]) {
      const v = cv - R + k * bay + (k - 1) * 1.4;
      stone.box(pf - 1.8, pf + 0.2, 0, winY, v, v + 1.4, { col: COL.stoneDark });
      this.cb.box(pf - 1.8, pf + 0.2, 0, winY, v, v + 1.4);
    }
    stone.box(pf - 1.9, pf + 0.3, winY - 0.8, winY, cv - R, cv + R, { col: COL.stoneDark });
    // ---- pavilion side walls + interior of the entrance hall
    stone.box(back, pf - 1.6, 0, 31, pv0, pv0 + 4, { col: COL.white });
    stone.box(back, pf - 1.6, 0, 31, pv1 - 4, pv1, { col: COL.white });
    this.cb.box(back, pf, 0, 31, pv0, cv - R);
    this.cb.box(back, pf, 0, 31, cv + R, pv1);
    // inner faces get arcades
    for (const [v, d] of [
      [pv0 + 4, 1],
      [pv1 - 4, -1],
    ]) {
      for (let u = back + 4; u < pf - 4; u += 6) {
        lit.box(u - 1.6, u + 1.6, FL + 0.3, FL + 5.5, Math.min(v, v + d * 0.05), Math.max(v, v + d * 0.05));
        stone.box(u - 2.2, u + 2.2, FL + 5.5, FL + 6.2, Math.min(v, v + d * 0.25), Math.max(v, v + d * 0.25), { col: COL.stoneDark });
      }
    }
    // entrance hall floor, ceiling and roof
    const f = this.B('floor');
    flat(f, back, pf - 1.6, pv0 + 4, pv1 - 4, FL, { s: 0.5 });
    this.cb.box(back, pf - 1.6, 0, FL, pv0 + 4, pv1 - 4);
    // floor in the portals + the two front steps
    flat(f, pf - 1.6, pf + 0.3, cv - R, cv + R, FL, { s: 0.5 });
    this.cb.box(pf - 1.6, pf + 0.3, 0, FL, cv - R, cv + R);
    for (const [k, y] of [
      [0, 0.24],
      [1, 0.12],
    ]) {
      const a = pf + 0.3 + k * 0.5;
      stone.box(a, a + 0.5, 0, y, cv - R - 1, cv + R + 1, { col: COL.stoneDark });
      this.cb.box(a, a + 0.5, 0, y, cv - R - 1, cv + R + 1);
    }
    flat(stone, back, pf, pv0, pv1, 29.6, { down: true, col: COL.stoneDark });
    // barrel roof over the central hall (slate)
    const RS = 14;
    for (let k = 0; k < RS; k++) {
      const a0 = (Math.PI * k) / RS,
        a1 = (Math.PI * (k + 1)) / RS;
      const z0 = cv - Math.cos(a0) * 20.5,
        z1 = cv - Math.cos(a1) * 20.5;
      const y0 = 33.5 + Math.sin(a0) * 7,
        y1 = 33.5 + Math.sin(a1) * 7;
      plain.quad([back, y0, z0], [back, y1, z1], [pf - 1.5, y1, z1], [pf - 1.5, y0, z0], [0, 0], [0, 1], [1, 1], [1, 0], COL.slate);
    }
    // back wall of the pavilion towards the concourse (big arch opening)
    stone.geo(archWall(pv1 - pv0, 33.5, [{ x: 0, y: 0, w: 33, h: 26 }], 1.2, 18), facadeMatrix(back, 1.2, cv, 0, -1), COL.white, null, 0.25);
    // ---- lunette gable with the clock and the Atlas group
    const lun = new THREE.Shape();
    const LR = 11;
    lun.moveTo(-LR, 0);
    for (let k = 0; k <= 24; k++) lun.lineTo(-LR * Math.cos((Math.PI * k) / 24), LR * 0.85 * Math.sin((Math.PI * k) / 24));
    lun.lineTo(-LR, 0);
    stone.geo(new THREE.ExtrudeGeometry(lun, { depth: 1.4, bevelEnabled: false, curveSegments: 12 }), facadeMatrix(pf + 0.4, 1.4, cv, 34.2), COL.white, null, 0.25);
    // gable rim
    for (let k = 0; k < 24; k++) {
      const a = (Math.PI * k) / 24,
        b = (Math.PI * (k + 1)) / 24;
      stone.beam(pf + 0.5, 34.2 + LR * 0.85 * Math.sin(a), cv - LR * Math.cos(a), pf + 0.5, 34.2 + LR * 0.85 * Math.sin(b), cv - LR * Math.cos(b), 0.6, { col: COL.stoneDark });
    }
    // clock: dial (sign atlas) + hands (separate meshes so they can turn)
    const clockY = 38.6,
      clockR = 2.4,
      cu = pf + 0.48;
    const dial = new THREE.CircleGeometry(clockR, 32);
    signs.geo(dial, new THREE.Matrix4().makeRotationY(Math.PI / 2).setPosition(cu, clockY, cv), COL.white, SIGN_UV.clock);
    stone.geo(new THREE.TorusGeometry(clockR + 0.2, 0.25, 6, 32), new THREE.Matrix4().makeRotationY(Math.PI / 2).setPosition(cu, clockY, cv), COL.stoneDark, null, 1);
    const handGeo = (len, wdt) => {
      const g = new THREE.BoxGeometry(0.08, len, wdt);
      g.translate(0, len / 2 - 0.2, 0);
      return g;
    };
    this.handH = new THREE.Mesh(handGeo(clockR * 0.55, 0.22), this.mats.lamp);
    this.handM = new THREE.Mesh(handGeo(clockR * 0.85, 0.14), this.mats.lamp);
    for (const h of [this.handH, this.handM]) {
      h.material = this.handMat ||= new THREE.MeshBasicMaterial({ color: 0x1b1b1b, name: 'hbf-hands' });
      h.position.set(cu + 0.1, clockY, cv);
      this.root.add(h);
    }
    // Atlas carrying the globe, flanked by two allegorical figures (stylised bronze)
    const pat = { col: COL.patina };
    const ax = pf - 0.4,
      ay = 34.2 + LR * 0.85;
    stone.box(ax - 1.6, ax + 1.6, ay - 0.6, ay + 0.6, cv - 1.6, cv + 1.6, { col: COL.stoneDark });
    plain.box(ax - 0.5, ax + 0.5, ay + 0.6, ay + 2.0, cv - 0.75, cv + 0.75, pat); // legs (kneeling block)
    plain.box(ax - 0.45, ax + 0.45, ay + 2.0, ay + 3.6, cv - 0.65, cv + 0.65, pat); // torso
    plain.geo(new THREE.SphereGeometry(0.42, 10, 8), new THREE.Matrix4().makeTranslation(ax + 0.15, ay + 3.95, cv), COL.patina);
    plain.beam(ax, ay + 3.4, cv - 0.6, ax, ay + 4.9, cv - 1.4, 0.32, pat);
    plain.beam(ax, ay + 3.4, cv + 0.6, ax, ay + 4.9, cv + 1.4, 0.32, pat);
    plain.geo(new THREE.SphereGeometry(2.0, 18, 12), new THREE.Matrix4().makeTranslation(ax - 0.2, ay + 6.6, cv), COL.patina);
    plain.geo(new THREE.TorusGeometry(2.05, 0.08, 4, 24), new THREE.Matrix4().makeTranslation(ax - 0.2, ay + 6.6, cv).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2.4)), COL.dark);
    plain.geo(new THREE.TorusGeometry(2.05, 0.08, 4, 24), new THREE.Matrix4().makeTranslation(ax - 0.2, ay + 6.6, cv).multiply(new THREE.Matrix4().makeRotationY(0.6)), COL.dark);
    for (const s of [-1, 1]) {
      const fv = cv + s * 16,
        fy = 34.2 + 1.0;
      stone.box(ax - 1.2, ax + 1.2, fy - 1, fy - 0.2, fv - 1.6, fv + 1.6, { col: COL.stoneDark });
      plain.box(ax - 0.5, ax + 0.5, fy - 0.2, fy + 0.6, fv - 1.4, fv + 1.4, pat); // reclining body
      plain.beam(ax, fy + 0.3, fv - s * 0.8, ax, fy + 1.8, fv - s * 0.2, 0.55, pat); // torso
      plain.geo(new THREE.SphereGeometry(0.33, 8, 6), new THREE.Matrix4().makeTranslation(ax, fy + 2.2, fv - s * 0.1), COL.patina);
      plain.beam(ax, fy + 1.6, fv - s * 0.2, ax + 0.2, fy + 2.8, fv - s * 0.9, 0.18, pat); // raised arm
    }
    // HAUPTBAHNHOF lettering between the arch and the cornice
    wall(signs, 'u', 1, pf + 0.62, cv - 8, cv + 8, 27.95, 29.95, { uv: SIGN_UV.lettering });
    // ---- wings
    const wingH = 19;
    for (const [v0, v1] of [
      [-62, pv0],
      [pv1, 75],
    ]) {
      const W = v1 - v0,
        vc = (v0 + v1) / 2;
      const nb = Math.round(W / 6.6);
      const holes = [];
      for (let k = 0; k < nb; k++) {
        const x = -W / 2 + (W / nb) * (k + 0.5);
        holes.push({ x, y: 1.6, w: 3.4, h: 6.4 }, { x, y: 10.2, w: 2.2, h: 3.4, round: false }, { x, y: 14.8, w: 2.2, h: 2.6, round: false });
      }
      stone.geo(archWall(W, wingH, holes, 1.0, 8), facadeMatrix(front, 1.0, vc), COL.white, null, 0.25);
      wall(lit, 'u', 1, front - 1.02, v0, v1, 0.5, wingH - 0.5, {});
      stone.box(front, front + 0.5, 0, 1.4, v0, v1, { col: COL.plinth });
      stone.box(front, front + 0.35, 8.6, 9.3, v0, v1, { col: COL.stoneDark });
      stone.box(front - 0.2, front + 0.8, wingH - 0.6, wingH + 0.3, v0, v1, { col: COL.stoneDark });
      for (let k = 0; k <= nb; k++) {
        const v = v0 + (W / nb) * k;
        stone.box(front, front + 0.3, 1.4, wingH - 0.6, v - 0.45, v + 0.45, { col: COL.stoneDark });
      }
      // body (sides/back visible from the concourse and over the shed roofs)
      stone.box(back, front - 1.0, 0, wingH, v0, v1, { skip: 'px,top,bottom' });
      flat(stone, back, front, v0, v1, wingH, { col: COL.stoneDark });
      this.cb.box(back, front + 0.5, 0, wingH, v0, v1);
      this.mansard(plain, back, front, v0, v1, wingH, 6);
      // dormers
      if (this.q > 0)
        for (let k = 0; k < nb; k++) {
          const v = v0 + (W / nb) * (k + 0.5);
          plain.box(front - 3.2, front - 1.8, wingH + 1.2, wingH + 3.4, v - 0.9, v + 0.9, { col: COL.slate });
          lit.box(front - 1.85, front - 1.75, wingH + 1.5, wingH + 3.0, v - 0.6, v + 0.6);
        }
    }
    // ---- corner pavilions with towers
    for (const [v0, v1, tv] of [
      [-80, -62, -77],
      [75, 93, 90],
    ]) {
      const W = v1 - v0,
        vc = (v0 + v1) / 2,
        pfr = front + 3,
        H = 25;
      const holes = [
        { x: 0, y: 1.6, w: 5, h: 10 },
        { x: -5.2, y: 3, w: 2.2, h: 5 },
        { x: 5.2, y: 3, w: 2.2, h: 5 },
        { x: 0, y: 15, w: 4, h: 4.5 },
        { x: -5.2, y: 15, w: 2.2, h: 3.5, round: false },
        { x: 5.2, y: 15, w: 2.2, h: 3.5, round: false },
      ];
      stone.geo(archWall(W, H, holes, 1.0, 10), facadeMatrix(pfr, 1.0, vc), COL.white, null, 0.25);
      wall(lit, 'u', 1, pfr - 1.02, v0, v1, 0.5, H - 0.5, {});
      stone.box(back - 2, pfr - 1.0, 0, H, v0, v1, { skip: 'px,top,bottom' });
      stone.box(pfr - 0.2, pfr + 0.8, H - 0.7, H + 0.3, v0 - 0.4, v1 + 0.4, { col: COL.stoneDark });
      for (const v of [v0 + 0.7, v1 - 0.7]) stone.box(pfr, pfr + 0.5, 0, H - 0.7, v - 0.7, v + 0.7, { col: COL.stoneDark });
      this.cb.box(back - 2, pfr + 0.5, 0, H, v0, v1);
      // hipped roof
      this.hipRoof(plain, back - 2, pfr, v0, v1, H + 0.3, 6);
      // tower on the outer corner
      const t0 = tv - 3,
        t1 = tv + 3,
        tu1 = pfr - 1,
        tu0 = tu1 - 6;
      stone.box(tu0, tu1, H, H + 9, t0, t1, { col: COL.white });
      lit.box(tu1 + 0.01, tu1 + 0.05, H + 3, H + 6.5, tv - 1, tv + 1);
      stone.box(tu0 - 0.3, tu1 + 0.3, H + 9, H + 9.6, t0 - 0.3, t1 + 0.3, { col: COL.stoneDark });
      this.pyramid(plain, tu0 - 0.2, tu1 + 0.2, t0 - 0.2, t1 + 0.2, H + 9.6, 7, COL.slate);
      iron.cyl((tu0 + tu1) / 2, tv, H + 16.4, H + 18.5, 0.06, 6, { col: COL.iron });
    }
    // ---- outer head buildings for the two small halls (lower, plainer)
    for (const [v0, v1] of [
      [HBF.vN - 1, -80],
      [93, HBF.vS + 1],
    ]) {
      const W = v1 - v0,
        vc = (v0 + v1) / 2,
        fr = back + 17,
        H = 14;
      const nb = 4;
      const holes = [];
      for (let k = 0; k < nb; k++) {
        const x = -W / 2 + (W / nb) * (k + 0.5);
        holes.push({ x, y: 1.6, w: 3, h: 5 }, { x, y: 8.6, w: 2.2, h: 3, round: false });
      }
      stone.geo(archWall(W, H, holes, 1.0, 8), facadeMatrix(fr, 1.0, vc), COL.white, null, 0.25);
      wall(lit, 'u', 1, fr - 1.02, v0, v1, 0.5, H - 0.5, {});
      stone.box(back, fr - 1, 0, H, v0, v1, { skip: 'px,bottom' });
      stone.box(fr - 0.2, fr + 0.6, H - 0.5, H + 0.4, v0, v1, { col: COL.stoneDark });
      this.cb.box(back, fr, 0, H, v0, v1);
    }
  }

  mansard(b, u0, u1, v0, v1, y, h) {
    const i = 3.4;
    const col = COL.slate;
    const P = (u, yy, v) => [u, yy, v];
    // front slope (+u), back slope (-u), flat top, end faces
    b.quad(P(u1, y, v1), P(u1, y, v0), P(u1 - i, y + h, v0), P(u1 - i, y + h, v1), [0, 0], [1, 0], [1, 1], [0, 1], col);
    b.quad(P(u0, y, v0), P(u0, y, v1), P(u0 + i, y + h, v1), P(u0 + i, y + h, v0), [0, 0], [1, 0], [1, 1], [0, 1], col);
    flat(b, u0 + i, u1 - i, v0, v1, y + h, { col });
    for (const [v, d] of [
      [v0, -1],
      [v1, 1],
    ]) {
      const a = P(u0, y, v),
        bq = P(u1, y, v),
        c = P(u1 - i, y + h, v),
        dq = P(u0 + i, y + h, v);
      if (d > 0) b.quad(a, bq, c, dq, [0, 0], [1, 0], [1, 1], [0, 1], col);
      else b.quad(bq, a, dq, c, [0, 0], [1, 0], [1, 1], [0, 1], col);
    }
  }

  hipRoof(b, u0, u1, v0, v1, y, h) {
    const col = COL.slate;
    const im = Math.min(u1 - u0, v1 - v0) * 0.35;
    const T = [
      [u0 + im, y + h, v0 + im],
      [u1 - im, y + h, v0 + im],
      [u1 - im, y + h, v1 - im],
      [u0 + im, y + h, v1 - im],
    ];
    const Bq = [
      [u0, y, v0],
      [u1, y, v0],
      [u1, y, v1],
      [u0, y, v1],
    ];
    const uv = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    for (let k = 0; k < 4; k++) {
      const n = (k + 1) % 4;
      b.quad(Bq[n], Bq[k], T[k], T[n], ...uv, col);
    }
    flat(b, T[0][0], T[1][0], T[0][2], T[2][2], y + h, { col });
  }

  pyramid(b, u0, u1, v0, v1, y, h, col) {
    const apex = [(u0 + u1) / 2, y + h, (v0 + v1) / 2];
    const Bq = [
      [u0, y, v0],
      [u1, y, v0],
      [u1, y, v1],
      [u0, y, v1],
    ];
    for (let k = 0; k < 4; k++) {
      const n = (k + 1) % 4;
      b.quad(Bq[n], Bq[k], apex, apex, [0, 0], [1, 0], [0.5, 1], [0.5, 1], col);
    }
  }

  // ------------------------------------------------------------------ concourse (Querbahnsteig)
  buildConcourse() {
    const f = this.B('floor'),
      shops = this.B('shops', 'int'),
      boards = this.B('boards', 'int'),
      iron = this.B('iron', 'int'),
      p = this.B('plain', 'int'),
      lamp = this.B('lamp', 'int'),
      signs = this.B('signs', 'int');
    const u0 = HBF.bufferU + 3,
      u1 = HBF.hallE;
    flat(f, u0, u1, HBF.vN, HBF.vS, FL, { s: 0.5 });
    wall(this.B('plain'), 'u', -1, u0, HBF.vN, HBF.vS, 0, FL, { col: COL.concrete });
    this.cb.box(u0, u1, 0, FL, HBF.vN, HBF.vS);
    // shop fronts on the back walls of the reception building (facing the platforms)
    const fronts = [];
    for (const [v0, v1] of [
      [-62, -14],
      [27, 75],
      [HBF.vN - 1, -80],
      [93, HBF.vS + 1],
    ]) {
      const n = Math.max(1, Math.floor((v1 - v0) / 11));
      const w = (v1 - v0) / n;
      for (let k = 0; k < n; k++) fronts.push([v0 + k * w + 0.6, v0 + (k + 1) * w - 0.6]);
    }
    fronts.forEach(([v0, v1], i) => {
      const s = i % SHOP_COUNT;
      const uv = [(s % 4) * 0.25, 1 - (Math.floor(s / 4) + 1) * 0.5, (s % 4) * 0.25 + 0.25, 1 - Math.floor(s / 4) * 0.5];
      wall(shops, 'u', -1, u1 - 0.05, v0, v1, FL, FL + 4.6, { uv });
      p.box(u1 - 0.9, u1 - 0.05, FL + 4.6, FL + 4.85, v0 - 0.2, v1 + 0.2, { col: COL.dark });
    });
    // corner pavilion back walls get travel-centre glazing
    for (const [v0, v1] of [
      [-80, -62],
      [75, 93],
    ])
      wall(shops, 'u', -1, u1 - 2.05, v0 + 0.6, v1 - 0.6, FL, FL + 4.6, { uv: [0.5, 0.5, 0.75, 1] });
    // big departure boards hanging over the concourse (double-sided)
    const bigUV = DepartureBoards.bigUV();
    const hang = (uc, vc, w, h, y0) => {
      wall(boards, 'u', 1, uc + 0.16, vc - w / 2, vc + w / 2, y0, y0 + h, { uv: bigUV });
      wall(boards, 'u', -1, uc - 0.16, vc - w / 2, vc + w / 2, y0, y0 + h, { uv: bigUV });
      p.box(uc - 0.15, uc + 0.15, y0 - 0.25, y0 + h + 0.25, vc - w / 2 - 0.25, vc + w / 2 + 0.25, { col: COL.dark });
      for (const s of [-1, 1]) iron.box(uc - 0.04, uc + 0.04, y0 + h, 24, vc + s * (w / 2 - 0.5) - 0.04, vc + s * (w / 2 - 0.5) + 0.04, { col: COL.iron });
    };
    const um = (u0 + u1) / 2;
    hang(um, 6.5, 13, 4.06, 6.2);
    if (this.q > 0) {
      hang(um, -48, 8, 2.5, 5.5);
      hang(um, 62, 8, 2.5, 5.5);
    }
    // ticket machines, info pillars, benches, bins, lamps
    const machines = [-30, -26, 40, 44, 100, -95];
    for (const v of machines) {
      p.box(u1 - 6.6, u1 - 6.0, FL, FL + 1.8, v - 0.45, v + 0.45, { col: COL.red });
      wall(signs, 'u', -1, u1 - 6.62, v - 0.4, v + 0.4, FL + 0.9, FL + 1.75, { uv: SIGN_UV.machine });
      this.cb.box(u1 - 6.6, u1 - 6.0, FL, FL + 1.8, v - 0.45, v + 0.45);
    }
    for (const v of [-58, 18, 78]) {
      p.cyl(um, v, FL, FL + 2.6, 0.5, 10, { col: COL.white });
      wall(signs, 'u', 1, um + 0.52, v - 0.45, v + 0.45, FL + 1.2, FL + 2.2, { uv: SIGN_UV.info });
      wall(signs, 'u', -1, um - 0.52, v - 0.45, v + 0.45, FL + 1.2, FL + 2.2, { uv: SIGN_UV.info });
      this.cb.box(um - 0.5, um + 0.5, FL, FL + 2.6, v - 0.5, v + 0.5);
    }
    if (this.q > 0) for (const v of [-40, -6, 30, 52, 88]) this.bench(p, iron, um + 4, v, 0);
    // pendant lamps under the shed roofs
    for (let v = HBF.vN + 8; v < HBF.vS - 4; v += this.q === 0 ? 24 : 12) {
      iron.box(um - 0.02, um + 0.02, 7.6, 14, v - 0.02, v + 0.02, { col: COL.iron });
      lamp.cyl(um, v, 7.3, 7.6, 0.55, 12, { col: COL.white });
      p.cyl(um, v, 7.6, 7.75, 0.62, 12, { col: COL.dark });
    }
  }

  // ------------------------------------------------------------------ Fernbusterminal
  buildTerminal() {
    const { u0, u1, v0, v1 } = HBF.terminal;
    const f = this.B('floor'),
      plain = this.B('plain'),
      iron = this.B('iron'),
      glass = this.B('glass'),
      signs = this.B('signs'),
      lamp = this.B('lamp');
    const isl = v0 + 4.6; // waiting platform along the wall
    flat(f, u0, u1, v0 + 0.6, isl, 0.15, { s: 0.5, col: COL.stoneDark });
    wall(plain, 'v', 1, isl, u0, u1, 0, 0.15, { col: COL.edge });
    wall(plain, 'u', -1, u0, v0 + 0.6, isl, 0, 0.15, { col: COL.edge });
    this.cb.box(u0, u1, 0, 0.15, v0 + 0.6, isl);
    flat(plain, u0 - 4, u1 + 2, isl, v1 - 0.8, 0.018, { col: COL.asphalt });
    this.cb.grid(u0 - 4, u1 + 6, isl, v1 - 0.8, 0.018);
    // pavement strips outside the side doors
    this.cb.grid(HBF.bufferU - 6, HBF.hallE + 4, HBF.vN - 14, HBF.vN - 1, 0.02);
    this.cb.grid(u1 - 2, HBF.hallE + 4, HBF.vS + 1, v1 - 0.8, 0.02);
    // bay markings
    const nb = 8,
      pitch = (u1 - u0) / nb;
    this.bays = [];
    for (let k = 0; k < nb; k++) {
      const uc = u0 + pitch * (k + 0.5);
      this.bays.push(uc);
      for (const s of [-1, 1]) flat(plain, uc + s * pitch * 0.5 - 0.06, uc + s * pitch * 0.5 + 0.06, isl + 0.2, isl + 3.6, 0.022, { col: COL.yellow });
      // shelter: posts, glass roof and back panel, bench, bay number
      const sv0 = v0 + 1.0,
        sv1 = isl - 0.6;
      for (const du of [-3.6, 3.6]) for (const sv of [sv0, sv1]) iron.cyl(uc + du, sv, 0.15, 3.0, 0.06, 6, { col: COL.iron });
      iron.box(uc - 4, uc + 4, 2.95, 3.1, sv0 - 0.4, sv1 + 0.5, { col: COL.iron });
      flat(glass, uc - 3.9, uc + 3.9, sv0 - 0.3, sv1 + 0.4, 3.12, { s: 1 / 3 });
      wall(glass, 'v', 1, sv0 + 0.02, uc - 3.6, uc + 3.6, 0.4, 2.6, { s: 1 / 3 });
      plain.box(uc - 2, uc + 2, 0.55, 0.6, sv0 + 0.1, sv0 + 0.55, { col: COL.bench });
      iron.cyl(uc + pitch * 0.5 - 0.6, sv1 + 0.3, 0.15, 3.3, 0.05, 6, { col: COL.iron });
      wall(signs, 'v', 1, sv1 + 0.36, uc + pitch * 0.5 - 1.0, uc + pitch * 0.5 - 0.2, 2.6, 3.4, { uv: SIGN_UV.bay(k) });
      wall(signs, 'v', -1, sv1 + 0.24, uc + pitch * 0.5 - 1.0, uc + pitch * 0.5 - 0.2, 2.6, 3.4, { uv: SIGN_UV.bay(k) });
      lamp.box(uc - 2.5, uc + 2.5, 2.88, 2.94, sv0 + 0.6, sv0 + 0.75);
    }
    // big sign on the station wall + a pylon at the street
    wall(signs, 'v', 1, HBF.vS + 1.06, (u0 + u1) / 2 - 7, (u0 + u1) / 2 + 7, 6.6, 10.1, { uv: SIGN_UV.busSign });
    const pu = u1 - 2;
    iron.box(pu - 0.15, pu + 0.15, 0, 5.4, v1 - 2.3, v1 - 2.0, { col: COL.iron });
    iron.box(pu - 3.2, pu + 3.2, 3.6, 5.4, v1 - 2.25, v1 - 2.05, { col: COL.iron });
    wall(signs, 'u', 1, pu + 0.16, v1 - 2.95, v1 - 1.35, 3.0, 5.6, { uv: SIGN_UV.busSign });
    wall(signs, 'v', 1, v1 - 2.03, pu - 3.1, pu + 3.1, 3.65, 5.35, { uv: SIGN_UV.busSign });
    wall(signs, 'v', -1, v1 - 2.27, pu - 3.1, pu + 3.1, 3.65, 5.35, { uv: SIGN_UV.busSign });
  }

  // ------------------------------------------------------------------ Bahnhofsvorplatz
  buildVorplatz() {
    const f = this.B('floor'),
      iron = this.B('iron'),
      plain = this.B('plain'),
      signs = this.B('signs');
    const u0 = HBF.front + 7.5,
      u1 = HBF.front + 34;
    flat(f, HBF.front + 0.4, u1, -80, 95, 0.028, { s: 0.35, col: COL.stoneDark });
    this.cb.grid(HBF.front - 2, HBF.front + 61, -82, 97, 0.028);
    void u0;
    // bike racks (Fahrradbügel) along the north part of the forecourt
    for (let k = 0; k < (this.q === 0 ? 8 : 16); k++) {
      const v = -66 + k * 1.2,
        u = HBF.front + 10;
      iron.beam(u - 0.4, 0.03, v, u - 0.4, 0.8, v, 0.05, { col: COL.zinc });
      iron.beam(u + 0.4, 0.03, v, u + 0.4, 0.8, v, 0.05, { col: COL.zinc });
      iron.beam(u - 0.4, 0.8, v, u + 0.4, 0.8, v, 0.05, { col: COL.zinc });
      if (k % 3 !== 2) {
        // a parked bicycle (simple frame + wheels)
        plain.geo(new THREE.TorusGeometry(0.33, 0.03, 4, 12), new THREE.Matrix4().makeTranslation(u - 0.55, 0.36, v + 0.25), COL.dark);
        plain.geo(new THREE.TorusGeometry(0.33, 0.03, 4, 12), new THREE.Matrix4().makeTranslation(u + 0.5, 0.36, v + 0.25), COL.dark);
        plain.beam(u - 0.55, 0.36, v + 0.25, u + 0.1, 0.85, v + 0.25, 0.04, { col: [COL.red, COL.bench, COL.patina][k % 3] });
        plain.beam(u + 0.1, 0.85, v + 0.25, u + 0.5, 0.36, v + 0.25, 0.04, { col: [COL.red, COL.bench, COL.patina][k % 3] });
      }
    }
    // taxi rank sign at the front of the service road
    const tu = HBF.front + 62,
      tv = 12;
    iron.cyl(tu, tv, 0, 3.2, 0.05, 6, { col: COL.zinc });
    plain.box(tu - 0.04, tu + 0.04, 2.5, 3.1, tv - 0.3, tv + 0.3, { col: COL.yellow });
    // station-name sign on the forecourt
    const su = HBF.front + 22;
    iron.cyl(su, -40, 0, 4.2, 0.08, 6, { col: COL.iron });
    iron.cyl(su, -36, 0, 4.2, 0.08, 6, { col: COL.iron });
    wall(signs, 'u', 1, su + 0.1, -40.2, -35.8, 3.0, 4.1, { uv: SIGN_UV.hbfSign });
    wall(signs, 'u', -1, su - 0.1, -40.2, -35.8, 3.0, 4.1, { uv: SIGN_UV.hbfSign });
    this.taxiSlots = [18, 25.5, 33].map((v) => {
      const [x, z] = fromUV(-789.6, v);
      const [dx, dz] = fromUV(0, 1);
      return { x, z, yaw: Math.atan2(dx, dz), car: null };
    });
  }

  // ------------------------------------------------------------------ trains + coaches
  buildTrains() {
    const geos = carGeometries();
    this.fleet = new Fleet(geos, this.mats.livery, 48);
    const T = HBF.tracks;
    const front = HBF.bufferU - 4;
    // parked consists: [track index, kind, distance from the buffer stop]
    const parked = [
      [2, 'ice', 6],
      [5, 're', 12],
      [8, 'flix', 5],
      [11, 'sbahn', 8],
      [13, 'ic2', 9],
      [16, 'rb', 7],
      [19, 'ice', 6],
      [21, 'sbahn', 15],
      [23, 're', 30],
    ];
    const n = [5, 7, 9, 9][this.q];
    for (const [ti, kind, gap] of parked.slice(0, n)) {
      const t = this.fleet.add(kind, front - gap, T[ti]);
      this.cb.box(front - gap - t.length, front - gap, 0.5, 4.2, T[ti] - 1.45, T[ti] + 1.45);
    }
    // the train that comes and goes (on the track nearest v = -43, straight out to the west)
    this.mover = { track: T[6], train: this.fleet.add('ice', front - 3, T[6]), phase: 0, t: 30, u: front - 3, vis: true, body: null };
    this.mover.length = this.mover.train.length;
    // coaches at the Fernbusterminal
    const liveries = ['flixbus', 'blablabus', 'flixbus', 'regiojet', 'flixbus'];
    const isl = HBF.terminal.v0 + 4.6;
    [0, 1, 3, 4, 6].forEach((b, i) => {
      const u = this.bays[b],
        v = isl + 1.9;
      this.fleet.addVehicle(liveries[i], u, v, 0);
      this.cb.box(u - 6.5, u + 6.5, 0.3, 3.7, v - 1.3, v + 1.3);
    });
    // culling: bounds over the placed cars; the moving train's track (out to u = -1530) is included
    const reach = new THREE.Sphere(new THREE.Vector3((-1530 + front) / 2, 2, T[6]), (front + 1530) / 2 + 4);
    for (const k in this.fleet.meshes) {
      const m = this.fleet.meshes[k];
      m.computeBoundingSphere();
      if (k === 'iceCab' || k === 'iceMid') m.boundingSphere.union(reach);
      m.frustumCulled = true;
      if (!m.count) continue; // car type not used at this quality level: no empty draw
      this.root.add(m);
    }
  }

  // ------------------------------------------------------------------ meshes
  emitMeshes() {
    const shadowsExt = { stone: true, plain: true, iron: true, skin: true, livery: true };
    for (const [key, b] of this.builders) {
      if (!b.count) continue;
      const [group, mat] = key.split(':');
      const m = new THREE.Mesh(b.build(), this.mats[mat]);
      m.name = `hbf-${group}-${mat}`;
      m.receiveShadow = mat !== 'glass' && mat !== 'signs' && mat !== 'boards' && mat !== 'lamp';
      m.castShadow = group === 'ext' && !!shadowsExt[mat];
      if (mat === 'glass') m.renderOrder = 2;
      (group === 'int' ? this.interior : this.root).add(m);
    }
    this.builders.clear();
    // instanced ribs
    for (const type of ['big', 'small']) {
      const list = this.ribPlaces[type];
      const im = new THREE.InstancedMesh(this.ribGeos[type], this.mats.iron, list.length);
      const m = new THREE.Matrix4();
      list.forEach(([u, c], i) => im.setMatrixAt(i, m.makeTranslation(u, 0, c)));
      im.castShadow = this.q >= 2;
      im.receiveShadow = true;
      im.name = `hbf-ribs-${type}`;
      im.computeBoundingSphere();
      this.root.add(im);
    }
  }

  // ------------------------------------------------------------------ crowd
  buildCrowd() {
    const n = [8, 16, 24, 32][this.q];
    const plats = this.platforms.filter(([a, b]) => b - a > 5);
    this.walkPlats = plats;
    for (let i = 0; i < n; i++) {
      let ch;
      try {
        ch = randomPerson();
      } catch {
        continue;
      }
      const a = { ch, u: 0, v: 0, path: [], wait: rnd() * 8, plat: null, speed: ch.preferredSpeed || 1.3 };
      if (i % 3 === 0) {
        a.plat = plats[i % plats.length];
        a.u = HBF.platW + 20 + rnd() * 140;
        a.v = this.platV(a.plat);
      } else {
        [a.u, a.v] = this.concoursePoint();
      }
      ch.root.position.set(a.u, FL, a.v);
      ch.root.rotation.y = rnd() * Math.PI * 2;
      ch.play(rnd() < 0.5 ? 'idle' : 'waiting', 0);
      ch.update(rnd());
      this.interior.add(ch.root);
      this.crowd.push(a);
    }
  }

  concoursePoint() {
    return [HBF.bufferU + 5 + rnd() * 21, HBF.vN + 4 + rnd() * (HBF.vS - HBF.vN - 8)];
  }
  platV(pl) {
    const vc = (pl[0] + pl[1]) / 2;
    const col = HBF.halls.some(([a]) => Math.abs(a - vc) < 1.5);
    const half = (pl[1] - pl[0]) / 2 - 1.4;
    let v = vc + (rnd() * 2 - 1) * half;
    if (col && Math.abs(v - vc) < 1) v = vc + (v < vc ? -1.6 : 1.6);
    return v;
  }

  planWalk(a) {
    const head = HBF.bufferU - 4,
      edge = HBF.bufferU + 4.5;
    if (a.plat) {
      // back to the concourse along the platform
      a.path = [[head, a.v], [edge, a.v], this.concoursePoint()];
      a.plat = null;
    } else if (rnd() < 0.4) {
      const pl = this.walkPlats[Math.floor(rnd() * this.walkPlats.length)];
      const v = this.platV(pl);
      a.path = [[edge, v], [head, v], [HBF.platW + 15 + rnd() * 140, v]];
      a.plat = pl;
    } else a.path = [this.concoursePoint()];
  }

  updateCrowd(dt) {
    for (const a of this.crowd) {
      const ch = a.ch;
      if (a.wait > 0) {
        a.wait -= dt;
        if (a.wait <= 0) this.planWalk(a);
        ch.update(dt);
        continue;
      }
      const tgt = a.path[0];
      if (!tgt) {
        a.wait = 4 + rnd() * 18;
        ch.play(rnd() < 0.3 ? 'phone' : rnd() < 0.5 ? 'waiting' : 'idle', 0.3);
        ch.update(dt);
        continue;
      }
      const du = tgt[0] - a.u,
        dv = tgt[1] - a.v;
      const d = Math.hypot(du, dv);
      const step = a.speed * dt;
      if (d <= step) {
        a.u = tgt[0];
        a.v = tgt[1];
        a.path.shift();
      } else {
        a.u += (du / d) * step;
        a.v += (dv / d) * step;
        ch.root.rotation.y = Math.atan2(du, dv);
      }
      ch.play('walk', 0.25, a.speed / 1.35);
      ch.root.position.set(a.u, FL, a.v);
      ch.update(dt);
    }
  }

  // ------------------------------------------------------------------ runtime
  update(dt) {
    this.time += dt;
    if (this.prewarm) {
      for (const o of this.prewarm) o.frustumCulled = true;
      this.prewarm = null;
    }
    const cam = ctx.camera.position;
    const dist = Math.hypot(cam.x - this.centre.x, cam.z - this.centre.z);
    const near = dist < 420;
    this.interior.visible = near;
    // night glow (no lights: emissive intensities only, no shader changes)
    const night = ctx.uniforms?.uNight.value ?? 0;
    if (Math.abs(night - this.lastNight) > 0.01) {
      this.lastNight = night;
      this.mats.lit.emissiveIntensity = night * 0.85;
      this.mats.lit.color.setScalar(1 - night * 0.75).multiply(LIT_DAY);
      this.mats.floor.emissiveIntensity = night * 0.4;
      this.mats.stone.emissiveIntensity = night * 0.09; // floodlit facade / lit interior walls
      this.mats.plain.emissiveIntensity = night * 0.25;
      this.mats.iron.emissiveIntensity = night * 0.3;
      this.mats.skin.emissiveIntensity = night * 0.22;
      this.mats.livery.emissiveIntensity = night * 0.12;
      this.mats.shops.emissiveIntensity = 0.25 + night * 0.75;
      this.mats.signs.color.setScalar(1 - night * 0.35);
      this.mats.boards.color.setScalar(1);
    }
    // clock + boards (Frankfurt time)
    this.clockTimer -= dt;
    const date = this.clockTimer <= 0 ? ctx.env?.date : null;
    if (date) {
      this.clockTimer = 0.5;
      const { hour } = frankfurtClock(date);
      const h = Math.floor(hour),
        m = Math.floor((hour - h) * 60);
      this.handM.rotation.x = -(m / 60) * Math.PI * 2;
      this.handH.rotation.x = -(((h % 12) + m / 60) / 12) * Math.PI * 2;
      if (near && this.time - this.boardT > 4) {
        this.boardT = this.time;
        this.boards.update(h, m);
      }
    }
    this.updateMover(dt, near);
    if (dist < 260) this.updateCrowd(dt);
    this.updateTaxis(dt, dist);
    this.addBlips();
  }

  /** Arrive (decelerate) - dwell - depart (accelerate) - absent, on a kinematic collider. */
  updateMover(dt, near) {
    const M = this.mover;
    const stop = HBF.bufferU - 4 - 3,
      far = -1360;
    const ARR = 42,
      DWELL = 95,
      DEP = 45,
      GONE = 50;
    M.t += dt;
    let u = stop,
      vis = true;
    if (M.phase === 0) {
      // arriving
      const k = Math.min(1, M.t / ARR);
      u = far + (stop - far) * (1 - (1 - k) * (1 - k));
      if (M.t >= ARR) [M.phase, M.t] = [1, 0];
    } else if (M.phase === 1) {
      if (M.t >= DWELL) [M.phase, M.t] = [2, 0];
    } else if (M.phase === 2) {
      const k = Math.min(1, M.t / DEP);
      u = stop + (far - stop) * k * k;
      if (M.t >= DEP) [M.phase, M.t] = [3, 0];
    } else {
      vis = false;
      u = far;
      if (M.t >= GONE) [M.phase, M.t] = [0, 0];
    }
    if (Math.abs(u - M.u) > 0.001 || vis !== M.vis) this.fleet.move(M.train, u, M.track, vis);
    M.u = u;
    M.vis = vis;
    void near;
    // kinematic collider following the train
    const { world, RAPIER } = ctx;
    if (!world) return;
    if (!M.body) {
      const [x, z] = fromUV(u - M.length / 2, M.track);
      M.body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(x, 2.4, z).setRotation(this.yawQuat()));
      world.createCollider(RAPIER.ColliderDesc.cuboid(M.length / 2, 1.9, 1.45), M.body);
    }
    const [x, z] = vis ? fromUV(u - M.length / 2, M.track) : fromUV(far - 400, M.track);
    M.body.setNextKinematicTranslation({ x, y: 2.4, z });
  }

  yawQuat() {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), STATION_YAW);
    return { x: q.x, y: q.y, z: q.z, w: q.w };
  }

  /** Keeps a few parked taxis at the rank when the player is around (not in view: spawned at a distance). */
  updateTaxis(dt, dist) {
    this.taxiTimer -= dt;
    if (this.taxiTimer > 0 || !ctx.vehicles || !this.taxiSlots) return;
    this.taxiTimer = 2;
    for (const s of this.taxiSlots) {
      if (s.car && (s.car.destroyed || !ctx.vehicles.list.includes(s.car))) s.car = null;
      if (!s.car && dist > 140 && dist < 300 && !ctx.traffic?.occupied(s.x, s.z, 3.5)) {
        s.car = ctx.vehicles.spawn('taxi', s.x, s.z, s.yaw, 'parked', { driver: false });
      }
    }
  }

  addBlips() {
    if (this.blips || !ctx.blips) return;
    const [hx, hz] = fromUV(HBF.front + 8, 6.5);
    const [bx, bz] = fromUV((HBF.terminal.u0 + HBF.terminal.u1) / 2, HBF.terminal.v0 + 8);
    this.blips = [ctx.blips.add('station', hx, hz, { id: 'hbf', short: false }), ctx.blips.add('busterminal', bx, bz, { id: 'fernbus', short: false })];
  }

  /** World position inside the station (for tests / teleports): u, v local. */
  static world(u, v) {
    const [x, z] = fromUV(u, v);
    return { x, z };
  }
}

/** Builds the station (call after buildCity, before Physics.build: collision goes into phys). */
export function buildHauptbahnhof(phys) {
  const st = new Hauptbahnhof();
  st.build(phys);
  ctx.station = st;
  return st;
}

