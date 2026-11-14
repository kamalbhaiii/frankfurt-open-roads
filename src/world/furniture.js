/**
 * Street furniture with physics: knockable street lamps, working traffic signals,
 * concrete central dividers and the German street scene (StVO signs, Frankfurt
 * street-name signs, Haltestellen with shelters, Litfaßsäulen, FES bins, benches,
 * bike stands, Poller, ticket machines, post boxes). All instanced/batched and
 * grouped into distance-culled tiles.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ctx } from '../core/context.js';
import { KERB, QUALITY, roadWidth } from '../core/config.js';
import { hash, SpatialGrid, createRng, pip, bounds, segDist, pointAlong, polylineLength } from '../core/math.js';

const UP = new THREE.Vector3(0, 1, 0);
const _m4 = new THREE.Matrix4(),
  _q = new THREE.Quaternion(),
  _p = new THREE.Vector3(),
  ONE = new THREE.Vector3(1, 1, 1);
const SIGNAL_CYCLE = 32;

/** Flattens a GLB prop into (geometry, material) pairs in model space. */
function propParts(name) {
  const root = ctx.models[name].scene;
  root.updateMatrixWorld(true);
  const out = [];
  root.traverse((o) => {
    if (!o.isMesh) return;
    const src = o.geometry;
    const g = new THREE.BufferGeometry();
    for (const k in src.attributes) {
      const a = src.attributes[k];
      const f = new Float32Array(a.count * a.itemSize);
      for (let i = 0; i < a.count; i++) for (let c = 0; c < a.itemSize; c++) f[i * a.itemSize + c] = a.getComponent(i, c);
      g.setAttribute(k, new THREE.BufferAttribute(f, a.itemSize));
    }
    if (src.index) g.setIndex(src.index.clone());
    g.applyMatrix4(o.matrixWorld);
    g.computeBoundingSphere();
    out.push({ g, m: o.material, name: o.name });
  });
  return out;
}

/** Axis-aligned bounds of [x, z] points (used for tile culling). */
function boundsOf(pts) {
  const b = bounds(pts);
  return { minx: b.minx - 4, maxx: b.maxx + 4, minz: b.minz - 4, maxz: b.maxz + 4 };
}

/** 0 green, 1 amber, 2 red for signal group g at time t. */
export function signalState(sig, g, t) {
  const c = (((t + sig.off) % SIGNAL_CYCLE) + SIGNAL_CYCLE) % SIGNAL_CYCLE;
  if (g === 0) return c < 13 ? 0 : c < 16 ? 1 : 2;
  return c < 16 ? 2 : c < 29 ? 0 : 1;
}

export class Furniture {
  constructor() {
    this.lamps = [];
    this.lampTiles = [];
    this.lampGrid = new SpatialGrid(20);
    this.activeLamps = [];
    this.signals = [];
    this.signalByKey = new Map();
    this.poles = [];

    this.sigTimer = 0;
    this.lampMaterial = null;
    this.sceneTiles = [];
    this.sceneStats = null;
  }

  build() {
    this.buildLamps();
    this.buildSignals();
    this.buildDividers();
    this.buildStreetScene();
  }

  /** Signs, stops and street clutter (see StreetScene below). */
  buildStreetScene() {
    const t0 = performance.now();
    try {
      const sc = new StreetScene(this);
      sc.place();
      const { tiles, signMat, adMat } = sc.buildMeshes();
      this.sceneTiles = tiles;
      this.signMaterial = signMat;
      this.posterMaterial = adMat;
      this.sceneStats = sc.count;
      console.info(`[furniture] street scene in ${(performance.now() - t0).toFixed(0)} ms`, JSON.stringify(sc.count));
    } catch (e) {
      console.warn('[furniture] street scene failed', e);
    }
  }

  buildLamps() {
    const { RAPIER, world, scene, streets } = ctx;
    const parts = propParts('prop_lamp');
    const tiles = new Map();
    for (const [x, z, yaw] of streets.lamps) {
      const k = `${Math.floor(x / 400)},${Math.floor(z / 400)}`;
      if (!tiles.has(k)) tiles.set(k, []);
      tiles.get(k).push([x, z, yaw]);
    }
    // All standing lamps share ONE fixed body (thousands of separate bodies made every physics
    // step ~3x slower); a lamp gets its own dynamic body only when a car knocks it over.
    this.lampStatic = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const _o = new THREE.Vector3();
    for (const list of tiles.values()) {
      const tile = { ims: [], cx: 0, cz: 0, ...boundsOf(list.map(([x, , z]) => [x, z])) };
      for (const p of parts) {
        if (p.m.name === 'lamp_lens') {
          this.lampMaterial = p.m;
          p.m.emissiveIntensity = 0;
        }
        const im = new THREE.InstancedMesh(p.g, p.m, list.length);
        im.castShadow = p.m.name !== 'lamp_lens';
        scene.add(im);
        tile.ims.push(im);
      }
      list.forEach(([x, z, yaw], i) => {
        tile.cx += x / list.length;
        tile.cz += z / list.length;
        _q.setFromAxisAngle(UP, yaw);
        const rot = { x: _q.x, y: _q.y, z: _q.z, w: _q.w };
        const head = _o.set(0, 0, 0.9).applyQuaternion(_q);
        const cols = [
          world.createCollider(
            RAPIER.ColliderDesc.cylinder(4.0, 0.12)
              .setTranslation(x, KERB + 0.01 + 4.0, z)
              .setRotation(rot)
              .setFriction(0.6),
            this.lampStatic,
          ),
          world.createCollider(
            RAPIER.ColliderDesc.cuboid(0.16, 0.08, 0.9)
              .setTranslation(x + head.x, KERB + 0.01 + 8.45, z + head.z)
              .setRotation(rot),
            this.lampStatic,
          ),
        ];
        const lamp = { body: null, cols, x, z, yaw, fallen: false, tile, i, dyn: false };
        this.lamps.push(lamp);
        this.lampGrid.insert(x, z, lamp);
        _p.set(x, KERB + 0.01, z);
        _m4.compose(_p, _q, ONE);
        for (const im of tile.ims) im.setMatrixAt(i, _m4);
      });
      for (const im of tile.ims) im.computeBoundingSphere();
      this.lampTiles.push(tile);
    }
  }

  buildSignals() {
    const { RAPIER, world, scene, streets } = ctx;
    const parts = propParts('prop_traffic_light');
    for (const s of streets.signals) {
      const k = `${Math.round(s.x)},${Math.round(s.z)}`;
      const sig = { x: s.x, z: s.z, k, off: hash(s.x * 0.37 + s.z) * SIGNAL_CYCLE, appr: [] };
      for (const a of s.a) {
        const [g, ang, px, pz, s0x, s0z, s1x, s1z] = a;
        const mx = (s0x + s1x) / 2,
          mz = (s0z + s1z) / 2;
        sig.appr.push({ g, ang, stopDist: Math.hypot(mx - s.x, mz - s.z), stopX: mx, stopZ: mz });
        this.poles.push({ x: px, z: pz, yaw: ang + Math.PI, sig, g });
      }
      this.signals.push(sig);
      this.signalByKey.set(k, sig);
    }
    const dark = new THREE.Color(0x111111);
    const lensMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.signalTiles = this.buildTiled(
      parts,
      this.poles,
      (q) => [q.x, KERB + 0.01, q.z, q.yaw, 1],
      (p) => (p.name.startsWith('lens_') ? lensMat : p.m),
    );
    for (const q of this.poles) for (const name of ['lens_red', 'lens_amber', 'lens_green']) q.tile.byName[name]?.setColorAt(q.i, dark);
    const fb = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    for (const q of this.poles) world.createCollider(RAPIER.ColliderDesc.cylinder(1.8, 0.09).setTranslation(q.x, KERB + 1.8, q.z), fb);
  }

  buildDividers() {
    const { RAPIER, world, scene, streets } = ctx;
    const parts = propParts('prop_barrier');
    const secs = [];
    for (const d of streets.div) {
      for (let i = 0; i + 3 < d.length; i += 2) {
        const ax = d[i],
          az = d[i + 1],
          bx = d[i + 2],
          bz = d[i + 3];
        const L = Math.hypot(bx - ax, bz - az);
        if (L >= 0.5) secs.push([(ax + bx) / 2, (az + bz) / 2, Math.atan2(bx - ax, bz - az), L / 3]);
      }
    }
    this.barrierTiles = this.buildTiled(
      parts,
      secs.map(([x, z, yaw, sl]) => ({ x, z, yaw, sl })),
      (s) => [s.x, 0.035, s.z, s.yaw, s.sl],
      (p) => p.m,
    );
    const fb = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    for (const [x, z, yaw, sl] of secs) {
      _q.setFromAxisAngle(UP, yaw);
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(0.3, 0.48, 1.5 * sl)
          .setTranslation(x, 0.5, z)
          .setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w }),
        fb,
      );
    }
  }

  /**
   * Instances a prop for many items, grouped into 400 m tiles so far tiles can be culled.
   * Each item gets `tile` and `i` (its instance index in that tile).
   * place(item) -> [x, y, z, yaw, zScale]; material(part) -> material for that part.
   */
  buildTiled(parts, items, place, material) {
    const groups = new Map();
    for (const it of items) {
      const k = `${Math.floor(it.x / 400)},${Math.floor(it.z / 400)}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(it);
    }
    const tiles = [];
    const sc = new THREE.Vector3();
    for (const list of groups.values()) {
      const tile = { ims: [], byName: {}, cx: 0, cz: 0, ...boundsOf(list.map((it) => [it.x, it.z])) };
      for (const p of parts) {
        const mat = material(p);
        const im = new THREE.InstancedMesh(p.g, mat, list.length);
        im.castShadow = mat === p.m;
        im.receiveShadow = true;
        tile.ims.push(im);
        tile.byName[p.name] = im;
        ctx.scene.add(im);
      }
      list.forEach((it, i) => {
        const [x, y, z, yaw, zs] = place(it);
        tile.cx += x / list.length;
        tile.cz += z / list.length;
        it.tile = tile;
        it.i = i;
        _q.setFromAxisAngle(UP, yaw);
        _p.set(x, y, z);
        _m4.compose(_p, _q, sc.set(1, 1, zs));
        for (const im of tile.ims) im.setMatrixAt(i, _m4);
      });
      for (const im of tile.ims) im.computeBoundingSphere();
      tiles.push(tile);
    }
    return tiles;
  }

  /** Signal state for a car driving with heading `yaw` towards junction key `k`. */
  signalFor(key, yaw, t) {
    const sig = this.signalByKey.get(key);
    if (!sig) return null;
    let best = null,
      bd = 0.9;
    for (const a of sig.appr) {
      const d = Math.abs(Math.atan2(Math.sin(a.ang - yaw), Math.cos(a.ang - yaw)));
      if (d < bd) {
        bd = d;
        best = a;
      }
    }
    return best ? { state: signalState(sig, best.g, t), stopDist: best.stopDist } : null;
  }

  /** Hides prop tiles beyond the quality's furniture draw distance (distance to the tile's bounding box). */
  cull(cam) {
    const far = QUALITY[ctx.quality].furnitureDistance;
    const dist = (t) => Math.hypot(Math.max(t.minx - cam.x, 0, cam.x - t.maxx), Math.max(t.minz - cam.z, 0, cam.z - t.maxz));
    for (const tiles of [this.lampTiles, this.signalTiles, this.barrierTiles]) {
      for (const t of tiles) {
        const v = dist(t) < far;
        for (const im of t.ims) im.visible = v;
      }
    }
    // small street clutter is cut a little earlier than lamps and signals
    const farScene = far * 0.8;
    for (const t of this.sceneTiles) {
      const v = dist(t) < farScene;
      for (const o of t.objs) o.visible = v;
    }
  }

  /** Knocks over lamps hit by moving dynamic vehicles and animates fallen ones. */
  /** Replaces a standing lamp's static colliders with its own dynamic body. */
  detachLamp(L) {
    const { RAPIER, world } = ctx;
    for (const c of L.cols) ctx.physics.removeStatic(c);
    L.cols = [];
    _q.setFromAxisAngle(UP, L.yaw);
    L.body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(L.x, KERB + 0.01, L.z)
        .setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w })
        .setAngularDamping(0.3),
    );
    world.createCollider(RAPIER.ColliderDesc.cylinder(4.0, 0.12).setTranslation(0, 4.0, 0).setDensity(820).setFriction(0.6), L.body);
    world.createCollider(RAPIER.ColliderDesc.cuboid(0.16, 0.08, 0.9).setTranslation(0, 8.45, 0.9).setDensity(200), L.body);
  }

  update(dt, vehicles) {
    for (const car of vehicles) {
      if (car.mode === 'ai' || car.dead) continue;
      const v = car.body.linvel();
      const spd = Math.hypot(v.x, v.z);
      if (spd < 3) continue;
      const p = car.body.translation();
      const c = Math.cos(car.yaw),
        s = Math.sin(car.yaw);
      for (const L of this.lampGrid.query(p.x, p.z, 8)) {
        if (L.dyn) continue;
        const dx = L.x - p.x,
          dz = L.z - p.z;
        const lx = dx * c - dz * s,
          lz = dx * s + dz * c;
        if (Math.abs(lx) < car.width / 2 + 0.3 && Math.abs(lz) < car.length / 2 + 0.4 + spd * 0.06) {
          L.dyn = true;
          if (L.binItem?.bm) L.binItem.bm.setVisibleAt(L.binItem.id, false);
          this.detachLamp(L);
          L.body.applyImpulseAtPoint({ x: v.x * 140, y: 0, z: v.z * 140 }, { x: L.x, y: 2.5, z: L.z }, true);
          this.activeLamps.push(L);
          car.body.setLinvel({ x: v.x * 0.8, y: v.y, z: v.z * 0.8 }, true);
          car.onImpact?.(spd * 0.35);
        }
      }
    }
    for (const L of this.activeLamps) {
      if (L.body.isSleeping() && L.slept) continue;
      L.slept = L.body.isSleeping();
      const t = L.body.translation(),
        r = L.body.rotation();
      _p.set(t.x, t.y, t.z);
      _q.set(r.x, r.y, r.z, r.w);
      _m4.compose(_p, _q, ONE);
      for (const im of L.tile.ims) {
        im.setMatrixAt(L.i, _m4);
        im.instanceMatrix.needsUpdate = true;
      }
      L.fallen = UP.clone().applyQuaternion(_q).y < 0.9;
    }

    this.sigTimer += dt;
    if (this.sigTimer < 0.25) return;
    // retro-reflective signs and back-lit City-Light posters at night
    const night = ctx.uniforms?.uNight?.value ?? 0;
    if (this.signMaterial) this.signMaterial.emissiveIntensity = night * 0.2;
    if (this.posterMaterial) this.posterMaterial.emissiveIntensity = 0.05 + night * 0.9;
    this.sigTimer = 0;
    const RED = new THREE.Color(3.2, 0.15, 0.08),
      AMB = new THREE.Color(3.0, 1.6, 0.1),
      GRN = new THREE.Color(0.2, 2.8, 0.9),
      OFF = new THREE.Color(0.07, 0.07, 0.07);
    const t = ctx.simTime;
    for (const p of this.poles) {
      if (!p.tile.ims[0].visible) continue;
      const s = signalState(p.sig, p.g, t);
      const L = p.tile.byName;
      L.lens_red?.setColorAt(p.i, s === 2 ? RED : OFF);
      L.lens_amber?.setColorAt(p.i, s === 1 ? AMB : OFF);
      L.lens_green?.setColorAt(p.i, s === 0 ? GRN : OFF);
    }
    for (const tile of this.signalTiles) {
      if (!tile.ims[0].visible) continue;
      for (const k of ['lens_red', 'lens_amber', 'lens_green']) if (tile.byName[k]?.instanceColor) tile.byName[k].instanceColor.needsUpdate = true;
    }
  }
}

// =====================================================================================
// German street scene: StVO traffic signs, Frankfurt street-name signs, bus/tram stops,
// Litfaßsäulen, FES bins, benches, bike racks, bollards, ticket machines, post boxes and
// utility cabinets. Everything is generated at runtime (geometry + canvas texture atlases),
// placed on the pavement from the OSM roads and drawn per 200 m tile:
// one BatchedMesh for the solid props + one merged mesh each for signs, name blades,
// posters and shelter glass.
// =====================================================================================

/** Clutter density per quality tier (signs and stops are always placed). */
const DENSITY = { low: 0.5, medium: 0.75, high: 1, ultra: 1.2 };
const SCENE_TILE = 200;
const FONT = 'Bahnschrift, "DIN Alternate", "DIN 1451 Std", "Roboto Condensed", "Arial Narrow", Arial, sans-serif';

/** Traffic sign atlas cells (Verkehrszeichen nach StVO). */
export const SIGN = {
  GIVEWAY: 0, // 205 Vorfahrt gewähren
  STOP: 1, // 206 Halt. Vorfahrt gewähren
  PRIO_ROAD: 2, // 306 Vorfahrtstraße
  PRIO: 3, // 301 Vorfahrt
  V30: 4, // 274 Tempo 30
  V50: 5, // 274 Tempo 50
  ZONE30: 6, // 274.1 Tempo-30-Zone
  ZONE30_END: 7, // 274.2 Ende Tempo-30-Zone
  ONEWAY_R: 8, // 220 Einbahnstraße (rechtsweisend)
  ONEWAY_L: 9, // 220 Einbahnstraße (linksweisend)
  NO_ENTRY: 10, // 267 Verbot der Einfahrt
  ZEBRA: 11, // 350 Fußgängerüberweg
  NO_STOP: 12, // 283 Absolutes Haltverbot
  NO_PARK: 13, // 286 Eingeschränktes Haltverbot
  PARK: 14, // 314 Parken + Zusatzzeichen Parkschein
  BUS: 15, // 224 Haltestelle
  PED_ZONE: 16, // 242.1 Fußgängerzone
  LIVING: 17, // 325.1 Verkehrsberuhigter Bereich
  LIVING_END: 18, // 325.2 Ende verkehrsberuhigter Bereich
  PED_ZONE_END: 19, // 242.2 Ende Fußgängerzone
  WORK: 20, // Temporary transit works / game content under construction
};
/** [plate size (m), fraction of the plate height the shape covers] per cell. */
const SIGN_DIM = [
  [1.0, 0.78],
  [0.7, 0.94],
  [0.75, 0.94],
  [1.0, 0.78],
  [0.65, 0.92],
  [0.65, 0.92],
  [0.8, 0.94],
  [0.8, 0.94],
  [1.0, 0.34],
  [1.0, 0.34],
  [0.65, 0.92],
  [0.7, 0.88],
  [0.65, 0.92],
  [0.65, 0.92],
  [0.75, 0.97],
  [0.5, 0.92],
  [0.8, 0.94],
  [0.9, 0.64],
  [0.9, 0.64],
  [0.8, 0.94],
  [1.35, 0.94],
];

function roundPoly(g, pts, r) {
  g.beginPath();
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i + n - 1) % n],
      p1 = pts[i],
      p2 = pts[(i + 1) % n];
    if (!i) g.moveTo((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2);
    g.arcTo(p1[0], p1[1], (p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2, r);
  }
  g.closePath();
}
const scalePts = (pts, k) => {
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length,
    cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  return pts.map(([x, y]) => [cx + (x - cx) * k, cy + (y - cy) * k]);
};

/** Draws the StVO sign atlas (8 x 4 cells of 256 px) procedurally. */
function drawSignAtlas() {
  const C = 256;
  const cv = document.createElement('canvas');
  cv.width = 8 * C;
  cv.height = 4 * C;
  const g = cv.getContext('2d');
  const RED = '#c4101f',
    BLUE = '#0d58a6',
    YEL = '#f5b301',
    GRN = '#16783a',
    WH = '#f6f6f3',
    BK = '#151515',
    GREY = '#8b8b8b';
  const cell = (i, fn) => {
    g.save();
    g.translate((i % 8) * C, Math.floor(i / 8) * C);
    g.beginPath();
    g.rect(0, 0, C, C);
    g.clip();
    fn();
    g.restore();
  };
  const text = (s, x, y, size, col, maxW, weight = 700) => {
    g.fillStyle = col;
    g.font = `${weight} ${size}px ${FONT}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(s, x, y, maxW);
  };
  const circle = (r, col, x = 128, y = 128) => {
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fillStyle = col;
    g.fill();
  };
  const shape = (pts, col, k = 1, r = 14) => {
    roundPoly(g, scalePts(pts, k), r * k);
    g.fillStyle = col;
    g.fill();
  };
  const rrect = (x, y, w, h, r, fill, stroke, lw = 0) => {
    g.beginPath();
    g.roundRect(x, y, w, h, r);
    if (fill) {
      g.fillStyle = fill;
      g.fill();
    }
    if (stroke) {
      g.lineWidth = lw;
      g.strokeStyle = stroke;
      g.stroke();
    }
  };
  const speed = (n, x = 128, y = 128, R = 118, red = RED, ink = BK) => {
    circle(R, WH, x, y);
    circle(R * 0.95, red, x, y);
    circle(R * 0.75, WH, x, y);
    text(String(n), x, y + R * 0.07, R * 0.98, ink, R * 1.25);
  };
  const figure = (x, y, s, col) => {
    g.strokeStyle = col;
    g.fillStyle = col;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.lineWidth = 9 * s;
    g.beginPath();
    g.arc(x + 3 * s, y - 50 * s, 9 * s, 0, Math.PI * 2);
    g.fill();
    g.beginPath();
    g.moveTo(x + 1 * s, y - 36 * s);
    g.lineTo(x - 2 * s, y + 2 * s);
    g.lineTo(x - 15 * s, y + 34 * s);
    g.moveTo(x - 2 * s, y + 2 * s);
    g.lineTo(x + 13 * s, y + 32 * s);
    g.moveTo(x - 16 * s, y - 6 * s);
    g.lineTo(x + 1 * s, y - 28 * s);
    g.lineTo(x + 16 * s, y - 10 * s);
    g.stroke();
  };
  const triDown = [
      [14, 36],
      [242, 36],
      [128, 234],
    ],
    triUp = [
      [128, 22],
      [242, 220],
      [14, 220],
    ];
  const endLines = () => {
    g.save();
    g.beginPath();
    g.roundRect(30, 8, 196, 240, 14);
    g.clip();
    g.strokeStyle = BK;
    g.lineWidth = 3;
    for (let i = -2; i <= 2; i++) {
      g.beginPath();
      g.moveTo(30 + i * 14, 248);
      g.lineTo(226 + i * 14, 8);
      g.stroke();
    }
    g.restore();
  };

  cell(SIGN.GIVEWAY, () => {
    shape(triDown, WH, 1, 16);
    shape(triDown, RED, 0.94, 15);
    shape(triDown, WH, 0.6, 8);
  });
  cell(SIGN.STOP, () => {
    const oct = (r) => Array.from({ length: 8 }, (_, i) => [128 + r * Math.cos((i + 0.5) * (Math.PI / 4)), 128 + r * Math.sin((i + 0.5) * (Math.PI / 4))]);
    shape(oct(124), WH, 1, 6);
    shape(oct(116), RED, 1, 6);
    text('STOP', 128, 132, 78, WH, 200);
  });
  cell(SIGN.PRIO_ROAD, () => {
    const dia = (r) => [
      [128, 128 - r],
      [128 + r, 128],
      [128, 128 + r],
      [128 - r, 128],
    ];
    shape(dia(122), WH, 1, 10);
    roundPoly(g, dia(116), 8);
    g.lineWidth = 3;
    g.strokeStyle = BK;
    g.stroke();
    shape(dia(74), YEL, 1, 5);
  });
  cell(SIGN.PRIO, () => {
    shape(triUp, WH, 1, 16);
    shape(triUp, RED, 0.94, 15);
    shape(triUp, WH, 0.6, 8);
    g.fillStyle = BK;
    g.fillRect(119, 98, 18, 94);
    g.fillRect(102, 141, 52, 8);
  });
  cell(SIGN.V30, () => speed(30));
  cell(SIGN.V50, () => speed(50));
  for (const [i, end] of [
    [SIGN.ZONE30, false],
    [SIGN.ZONE30_END, true],
  ]) {
    cell(i, () => {
      rrect(30, 8, 196, 240, 14, WH, BK, 6);
      const ink = end ? GREY : BK;
      speed(30, 128, 98, 72, end ? GREY : RED, ink);
      text('ZONE', 128, 210, 62, ink, 170);
      if (end) endLines();
    });
  }
  cell(SIGN.WORK, () => {
    rrect(8, 20, 240, 216, 8, '#f2b51b', BK, 10);
    g.fillStyle = BK;
    for (let x = -30; x < 286; x += 46) {
      g.beginPath();
      g.moveTo(x, 20);
      g.lineTo(x + 22, 20);
      g.lineTo(x - 20, 76);
      g.lineTo(x - 42, 76);
      g.closePath();
      g.fill();
    }
    text('BAUSTELLE', 128, 126, 39, BK, 220, 800);
    text('IM AUFBAU', 128, 170, 30, BK, 220, 800);
    rrect(18, 194, 220, 30, 3, BK);
    text('KEIN ZUGANG', 128, 209, 21, WH, 210, 800);
  });
  for (const [i, flip] of [
    [SIGN.ONEWAY_R, false],
    [SIGN.ONEWAY_L, true],
  ]) {
    cell(i, () => {
      rrect(6, 86, 244, 84, 8, BK, WH, 4);
      const arrow = [
        [24, 110],
        [176, 110],
        [176, 96],
        [236, 128],
        [176, 160],
        [176, 146],
        [24, 146],
      ].map(([x, y]) => [flip ? 256 - x : x, y]);
      g.beginPath();
      arrow.forEach(([x, y], k) => (k ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.closePath();
      g.fillStyle = WH;
      g.fill();
      text('Einbahnstraße', flip ? 156 : 100, 129, 27, BK, 146, 600);
    });
  }
  cell(SIGN.NO_ENTRY, () => {
    circle(120, WH);
    circle(114, RED);
    g.fillStyle = WH;
    g.fillRect(50, 110, 156, 36);
  });
  cell(SIGN.ZEBRA, () => {
    rrect(12, 12, 232, 232, 16, WH);
    rrect(18, 18, 220, 220, 12, BLUE);
    shape(
      [
        [128, 34],
        [226, 212],
        [30, 212],
      ],
      WH,
      1,
      10,
    );
    g.fillStyle = BK;
    for (let k = 0; k < 4; k++) g.fillRect(86 + k * 22, 192, 13, 9);
    figure(128, 150, 0.95, BK);
  });
  for (const [i, both] of [
    [SIGN.NO_STOP, true],
    [SIGN.NO_PARK, false],
  ]) {
    cell(i, () => {
      circle(120, WH);
      circle(114, RED);
      circle(88, BLUE);
      g.save();
      g.beginPath();
      g.arc(128, 128, 88, 0, Math.PI * 2);
      g.clip();
      g.strokeStyle = RED;
      g.lineWidth = 22;
      g.beginPath();
      g.moveTo(60, 60);
      g.lineTo(196, 196);
      if (both) {
        g.moveTo(196, 60);
        g.lineTo(60, 196);
      }
      g.stroke();
      g.restore();
    });
  }
  cell(SIGN.PARK, () => {
    rrect(26, 4, 204, 184, 12, WH);
    rrect(32, 10, 192, 172, 9, BLUE);
    text('P', 128, 102, 168, WH, 180);
    rrect(30, 194, 196, 58, 8, WH, BK, 4);
    text('Parkschein', 128, 212, 30, BK, 180, 600);
    text('Mo–Sa 9–19 h', 128, 238, 22, BK, 180, 500);
  });
  cell(SIGN.BUS, () => {
    circle(120, GRN);
    circle(100, YEL);
    text('H', 128, 136, 156, GRN, 160);
  });
  for (const [i, end] of [
    [SIGN.PED_ZONE, false],
    [SIGN.PED_ZONE_END, true],
  ]) {
    cell(i, () => {
      rrect(30, 8, 196, 240, 14, WH, BK, 6);
      const ink = end ? GREY : BK;
      circle(70, end ? GREY : BLUE, 128, 98);
      figure(108, 112, 0.72, WH);
      figure(146, 118, 0.5, WH);
      text('ZONE', 128, 210, 62, ink, 170);
      if (end) endLines();
    });
  }
  for (const [i, end] of [
    [SIGN.LIVING, false],
    [SIGN.LIVING_END, true],
  ]) {
    cell(i, () => {
      rrect(6, 46, 244, 164, 12, WH);
      rrect(12, 52, 232, 152, 9, BLUE);
      g.fillStyle = WH;
      g.fillRect(24, 120, 44, 70);
      g.beginPath();
      g.moveTo(18, 122);
      g.lineTo(46, 88);
      g.lineTo(74, 122);
      g.fill();
      figure(104, 152, 0.62, WH);
      figure(132, 168, 0.4, WH);
      circle(6, WH, 150, 186);
      g.fillStyle = WH;
      g.beginPath();
      g.roundRect(166, 158, 66, 22, 6);
      g.roundRect(180, 142, 36, 20, 6);
      g.fill();
      circle(7, BLUE, 180, 182);
      circle(7, BLUE, 218, 182);
      if (end) {
        g.strokeStyle = RED;
        g.lineWidth = 14;
        g.beginPath();
        g.moveTo(16, 198);
        g.lineTo(240, 58);
        g.stroke();
      }
    });
  }
  return cv;
}

/** Fictional poster designs for shelters and Litfaßsäulen: [top colour, bottom colour, headline, line, decoration]. */
const POSTERS = [
  ['#ff9a1f', '#d9420b', 'SOMMER AM MAIN', 'Uferfest · 3 Tage Musik', 'sun'],
  ['#2f7d32', '#14451a', 'APFELWEIN', 'Frisch gekeltert in Sachsenhausen', 'apple'],
  ['#14213d', '#05070f', 'DER LETZTE ZUG', 'Ab Donnerstag im Kino', 'stars'],
  ['#6a2c91', '#2b0f40', 'MUSEUMSNACHT', 'Samstag · 19–2 Uhr', 'circles'],
  ['#e0101f', '#a00010', 'SALE –50%', 'Nur diese Woche', 'big'],
  ['#111111', '#2a0030', 'LIVE: NACHTFALTER', 'Konzert · 12.12.', 'circles'],
  ['#0f4fa8', '#0a2b5c', 'MAINBANK', 'Ihr Konto. Ihre Stadt.', 'skyline'],
  ['#8e1020', '#4a0610', 'SCHAUSPIEL', 'Neue Saison · Tickets', 'curtain'],
  ['#00897b', '#00544b', 'EINFACH EINSTEIGEN', 'Bus & Bahn für alle', 'bars'],
  ['#f2e6c9', '#d8c49a', 'HERBSTMODE', 'Neu eingetroffen', 'stripe'],
  ['#ffd400', '#ffb000', 'WÄHLEN GEHEN!', 'Ihre Stimme zählt', 'bars'],
  ['#1c1c1c', '#3a3a3a', 'TIERPARK', 'Ein Tag voller Abenteuer', 'sun'],
];
const POSTER_W = 256,
  POSTER_H = 341;
/** 4 x 3 poster atlas (256 x 341 px cells) on a 1024 canvas. */
function drawPosterAtlas() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 1024;
  const g = cv.getContext('2d');
  const W = POSTER_W,
    H = POSTER_H;
  POSTERS.forEach(([c1, c2, head, sub, deco], i) => {
    g.save();
    g.translate((i % 4) * W, Math.floor(i / 4) * H);
    const gr = g.createLinearGradient(0, 0, 0, H);
    gr.addColorStop(0, c1);
    gr.addColorStop(1, c2);
    g.fillStyle = gr;
    g.fillRect(0, 0, W, H);
    const light = /^#f/.test(c1);
    const ink = light ? '#1a1a1a' : '#ffffff';
    g.globalAlpha = 0.85;
    if (deco === 'sun' || deco === 'apple') {
      g.fillStyle = deco === 'sun' ? '#ffe36b' : '#d7261e';
      g.beginPath();
      g.arc(128, 120, 70, 0, Math.PI * 2);
      g.fill();
      if (deco === 'apple') {
        g.fillStyle = '#5a3a1a';
        g.fillRect(124, 40, 8, 26);
      }
    } else if (deco === 'stars') {
      g.fillStyle = '#ffffff';
      for (let k = 0; k < 40; k++) g.fillRect(hash(k * 3.1 + i) * W, hash(k * 7.7 + i) * 200, 2, 2);
      g.fillStyle = '#e8b04a';
      g.fillRect(40, 150, 176, 6);
    } else if (deco === 'circles') {
      for (let k = 0; k < 6; k++) {
        g.fillStyle = `hsl(${(hash(k + i * 9) * 360) | 0},80%,60%)`;
        g.beginPath();
        g.arc(hash(k * 1.7 + i) * W, 40 + hash(k * 2.3 + i) * 180, 20 + hash(k * 5.1) * 40, 0, Math.PI * 2);
        g.fill();
      }
    } else if (deco === 'big') {
      g.fillStyle = '#ffffff';
      g.font = `800 120px ${FONT}`;
      g.textAlign = 'center';
      g.fillText('%', 128, 190);
    } else if (deco === 'skyline') {
      g.fillStyle = '#7fb3ff';
      for (let k = 0; k < 9; k++) {
        const h = 60 + hash(k * 4.4 + 1) * 150;
        g.fillRect(10 + k * 27, 230 - h, 22, h);
      }
    } else if (deco === 'curtain') {
      for (let k = 0; k < 8; k++) {
        g.fillStyle = k % 2 ? '#b0182c' : '#6d0a16';
        g.fillRect(k * 32, 0, 32, 230);
      }
    } else if (deco === 'bars') {
      g.fillStyle = light ? '#1a1a1a' : '#ffffff';
      for (let k = 0; k < 5; k++) g.fillRect(0, 30 + k * 36, W * (0.4 + hash(k + i) * 0.6), 14);
    } else if (deco === 'stripe') {
      g.fillStyle = '#5b3a29';
      g.beginPath();
      g.ellipse(128, 130, 40, 100, 0, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;
    g.fillStyle = ink;
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    g.font = `800 34px ${FONT}`;
    g.fillText(head, 128, 270, 236);
    g.font = `500 18px ${FONT}`;
    g.fillText(sub, 128, 300, 236);
    g.fillStyle = light ? 'rgba(0,0,0,0.75)' : 'rgba(255,255,255,0.85)';
    g.fillRect(16, 318, 224, 2);
    g.restore();
  });
  return cv;
}

/**
 * Street-name atlas: one 256 x 40 slot per name, greyscale (text/border white on black);
 * the material tints it Frankfurt blue/white. Returns slot UVs and blade lengths.
 */
function drawNameAtlas(names) {
  const SW = 256,
    SH = 40,
    cols = 8;
  const rows = Math.max(1, Math.ceil(names.length / cols));
  const cv = document.createElement('canvas');
  cv.width = SW * cols;
  cv.height = rows * SH;
  const g = cv.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, cv.width, cv.height);
  const slots = new Map();
  names.forEach((name, i) => {
    const x0 = (i % cols) * SW,
      y0 = Math.floor(i / cols) * SH;
    g.font = `600 27px ${FONT}`;
    const w = g.measureText(name).width || 1;
    const len = Math.min(1.6, Math.max(0.62, w * 0.005 + 0.2));
    const sx = Math.min(1.28 / len, (SW - 18) / w);
    g.strokeStyle = '#fff';
    g.lineWidth = 2;
    g.beginPath();
    g.roundRect(x0 + 4, y0 + 4, SW - 8, SH - 8, 4);
    g.stroke();
    g.save();
    g.translate(x0 + SW / 2, y0 + SH / 2 + 1.5);
    g.scale(sx, 1);
    g.fillStyle = '#fff';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(name, 0, 0);
    g.restore();
    slots.set(name, { u0: (x0 + 0.5) / cv.width, u1: (x0 + SW - 0.5) / cv.width, vt: (y0 + 0.5) / cv.height, vb: (y0 + SH - 0.5) / cv.height, len });
  });
  const px = g.getImageData(0, 0, cv.width, cv.height).data;
  const r8 = new Uint8Array(cv.width * cv.height);
  for (let i = 0; i < r8.length; i++) r8[i] = px[i * 4];
  const tex = new THREE.DataTexture(r8, cv.width, cv.height, THREE.RedFormat, THREE.UnsignedByteType);
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return { tex, slots };
}

// ---------- runtime prop kit: vertex-coloured, indexed geometries (position, normal, color) ----------
const _col = new THREE.Color();
function kpart(g, hex) {
  for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
  _col.setHex(hex);
  const n = g.attributes.position.count,
    a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    a[i * 3] = _col.r;
    a[i * 3 + 1] = _col.g;
    a[i * 3 + 2] = _col.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}
const KB = (w, h, d, x, y, z, hex, rx = 0) => {
  const g = new THREE.BoxGeometry(w, h, d);
  g.rotateX(rx);
  g.translate(x, y, z);
  return kpart(g, hex);
};
const KC = (rt, rb, h, x, y, z, hex, seg = 10, rz = 0) => {
  const g = new THREE.CylinderGeometry(rt, rb, h, seg);
  g.rotateZ(rz);
  g.translate(x, y, z);
  return kpart(g, hex);
};
const _up = new THREE.Vector3(0, 1, 0);
const KL = (a, b, r, hex, seg = 5) => {
  const va = new THREE.Vector3(...a),
    d = new THREE.Vector3(...b).sub(va);
  const g = new THREE.CylinderGeometry(r, r, d.length(), seg, 1, true);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(_up, d.clone().normalize()));
  g.translate(va.x + d.x / 2, va.y + d.y / 2, va.z + d.z / 2);
  return kpart(g, hex);
};
const KT = (R, r, x, y, z, hex, arc = Math.PI * 2, rs = 4, ts = 14) => {
  const g = new THREE.TorusGeometry(R, r, rs, ts, arc);
  g.rotateY(Math.PI / 2);
  g.translate(x, y, z);
  return kpart(g, hex);
};
const KS = (r, sy, x, y, z, hex) => {
  const g = new THREE.SphereGeometry(r, 12, 5, 0, Math.PI * 2, 0, Math.PI / 2);
  g.scale(1, sy, 1);
  g.translate(x, y, z);
  return kpart(g, hex);
};

const GALV = 0xa2a7ab,
  ANTH = 0x30353a,
  FES = 0xe8611a,
  WOOD = 0x8a5a34,
  STEEL = 0xb7bcc0,
  TYRE = 0x1a1a1a,
  WHITE = 0xf0f0ee,
  POST_YEL = 0xf5c400,
  BEIGE = 0xc9c4b3,
  LITFASS = 0x21402e;

/** Builds the prop kit. Local frame: ground at y = 0, +Z faces the carriageway, X runs along the kerb. */
function buildKit() {
  const K = {};
  // galvanised sign post, 1 m tall (scaled on Y per post)
  K.pole = [KC(0.032, 0.032, 1, 0, 0.5, 0, GALV, 8)];
  // Temporary high-visibility closure for rail and station areas under construction.
  K.workBarrier = [
    KB(0.22, 0.07, 0.52, -1.05, 0.06, 0, ANTH),
    KB(0.22, 0.07, 0.52, 1.05, 0.06, 0, ANTH),
    KB(0.12, 0.76, 0.12, -1.05, 0.43, 0, ANTH),
    KB(0.12, 0.76, 0.12, 1.05, 0.43, 0, ANTH),
    KB(2.8, 0.56, 0.1, 0, 0.82, 0, POST_YEL),
    ...[-1.08, -0.72, -0.36, 0, 0.36, 0.72, 1.08].map((x) => KB(0.14, 0.52, 0.025, x, 0.82, 0.064, ANTH)),
    ...[-1.32, 1.32].map((x) => KB(0.16, 0.14, 0.16, x, 1.18, 0, 0xff6b00)),
  ];
  // bus/tram stop pole with timetable case facing the pavement
  K.hpole = [
    KC(0.045, 0.05, 3.0, 0, 1.5, 0, 0x8c9296, 8),
    KB(0.5, 0.66, 0.07, 0, 1.55, -0.08, 0x52595e),
    KB(0.44, 0.58, 0.01, 0, 1.55, -0.12, 0xe9ebe6),
    KB(0.44, 0.07, 0.012, 0, 1.78, -0.122, 0x16783a),
  ];
  // glass shelter: anthracite frame, roof, bench, City-Light poster case at +X (glass and posters are separate meshes)
  K.shelter = [
    ...[-1.98, 0, 1.98].map((x) => KB(0.07, 2.4, 0.07, x, 1.2, -0.7, ANTH)),
    KB(0.07, 2.4, 0.07, -1.98, 1.2, 0.45, ANTH),
    KB(4.3, 0.1, 1.8, 0, 2.45, -0.05, 0x3d4247),
    KB(4.32, 0.04, 1.82, 0, 2.52, -0.05, 0xb9bcbf),
    KB(4.0, 0.06, 0.05, 0, 0.17, -0.7, ANTH),
    KB(4.0, 0.06, 0.05, 0, 2.36, -0.7, ANTH),
    KB(1.6, 0.05, 0.36, -0.6, 0.48, -0.48, WOOD),
    KB(0.05, 0.46, 0.3, -1.35, 0.24, -0.5, ANTH),
    KB(0.05, 0.46, 0.3, 0.15, 0.24, -0.5, ANTH),
    KB(0.16, 2.1, 1.3, 1.98, 1.15, -0.05, ANTH),
    KB(0.17, 0.08, 1.31, 1.98, 0.14, -0.05, 0x24282b),
  ];
  // Litfaßsäule: dark green plinth, cornice and dome; the poster drum is a separate mesh
  K.litfass = [
    KC(0.7, 0.72, 0.18, 0, 0.09, 0, LITFASS, 20),
    KC(0.64, 0.68, 0.14, 0, 0.25, 0, LITFASS, 20),
    KC(0.6, 0.6, 2.3, 0, 1.45, 0, 0x2a2a2a, 20),
    KC(0.7, 0.64, 0.12, 0, 2.62, 0, LITFASS, 20),
    KC(0.74, 0.7, 0.08, 0, 2.72, 0, LITFASS, 20),
    KS(0.66, 0.5, 0, 2.76, 0, LITFASS),
    KC(0.03, 0.05, 0.22, 0, 3.18, 0, 0xb39a52, 6),
  ];
  // FES orange litter bin on a post, and a variant clamped to a lamp mast
  const binBody = (y, z) => [
    KC(0.22, 0.2, 0.62, 0, y, z, FES, 12),
    KC(0.225, 0.225, 0.05, 0, y + 0.31, z, 0x2b2b2b, 12),
    KC(0.15, 0.15, 0.02, 0, y + 0.34, z, 0x111111, 10),
    KB(0.16, 0.05, 0.03, 0, y + 0.1, z + 0.21, WHITE),
  ];
  K.bin = [KC(0.035, 0.035, 1.12, 0, 0.56, -0.25, GALV, 6), KB(0.06, 0.4, 0.06, 0, 0.8, -0.22, GALV), ...binBody(0.78, 0)];
  K.binLamp = [KB(0.08, 0.08, 0.2, 0, 1.0, -0.22, GALV), ...binBody(0.85, 0)];
  // bench: cast legs, wooden seat and backrest slats; faces +Z
  K.bench = [
    ...[-0.75, 0.75].flatMap((x) => [KB(0.06, 0.44, 0.5, x, 0.22, 0, ANTH), KB(0.06, 0.45, 0.06, x, 0.66, -0.24, ANTH, -0.25)]),
    ...[-0.18, -0.07, 0.04, 0.15].map((z) => KB(1.8, 0.035, 0.09, 0, 0.46, z, WOOD)),
    ...[0.62, 0.74, 0.86].map((y) => KB(1.8, 0.09, 0.03, 0, y, -0.26 - (y - 0.6) * 0.25, WOOD, -0.25)),
  ];
  // Kreuzberger Bügel bike stand (arch in the Y-Z plane)
  K.rack = [
    KC(0.024, 0.024, 0.45, 0, 0.225, -0.4, STEEL, 6),
    KC(0.024, 0.024, 0.45, 0, 0.225, 0.4, STEEL, 6),
    KT(0.4, 0.024, 0, 0.45, 0, STEEL, Math.PI, 4, 8),
  ];
  // city bike with mudguards; the frame is white so an instance colour tints it
  const wr = 0.33;
  K.bike = [
    KT(wr, 0.022, 0, wr + 0.02, -0.52, TYRE),
    KT(wr, 0.022, 0, wr + 0.02, 0.52, TYRE),
    KT(wr + 0.04, 0.012, 0, wr + 0.02, -0.52, 0xc0c4c6, Math.PI * 0.75, 3, 6),
    KT(wr + 0.04, 0.012, 0, wr + 0.02, 0.52, 0xc0c4c6, Math.PI * 0.75, 3, 6),
    KL([0, 0.32, -0.04], [0, 0.82, -0.22], 0.018, WHITE),
    KL([0, 0.82, -0.22], [0, 0.82, 0.36], 0.018, WHITE),
    KL([0, 0.32, -0.04], [0, 0.7, 0.4], 0.02, WHITE),
    KL([0, 0.32, -0.04], [0, 0.35, -0.52], 0.012, WHITE),
    KL([0, 0.8, -0.2], [0, 0.35, -0.52], 0.012, WHITE),
    KL([0, 0.88, 0.36], [0, 0.35, 0.52], 0.014, 0x5a5f63),
    KL([0, 0.82, -0.22], [0, 0.96, -0.28], 0.013, 0x5a5f63),
    KB(0.12, 0.05, 0.24, 0, 0.99, -0.29, 0x161616),
    KL([0, 0.88, 0.36], [0, 1.02, 0.32], 0.014, 0x5a5f63),
    KL([-0.28, 1.03, 0.28], [0.28, 1.03, 0.28], 0.013, 0x2a2a2a),
    KB(0.18, 0.02, 0.32, 0, 0.74, -0.58, 0x2a2a2a),
  ];
  // Poller (anthracite with a reflective white ring)
  K.bollard = [KC(0.08, 0.085, 0.86, 0, 0.43, 0, ANTH, 10), KC(0.082, 0.082, 0.06, 0, 0.74, 0, WHITE, 10), KS(0.08, 0.5, 0, 0.86, 0, ANTH)];
  // Parkscheinautomat: front (display, slots) faces -Z, towards the pavement
  K.meter = [
    KB(0.3, 0.08, 0.24, 0, 0.04, 0, 0x4a4f53),
    KB(0.36, 1.25, 0.26, 0, 0.7, 0, 0x7f898f),
    KB(0.4, 0.06, 0.3, 0, 1.35, 0, 0x3b4146),
    KB(0.3, 0.22, 0.01, 0, 1.18, -0.131, 0x1f56a8),
    KB(0.12, 0.14, 0.012, 0, 1.18, -0.135, WHITE),
    KB(0.22, 0.12, 0.01, 0, 0.98, -0.131, 0x203a2a),
    KB(0.05, 0.05, 0.012, 0.1, 0.84, -0.133, 0xe0b000),
    KB(0.2, 0.06, 0.012, 0, 0.62, -0.133, 0x222222),
  ];
  // yellow post box on a short post; slot faces -Z
  K.postbox = [
    KC(0.04, 0.04, 0.8, 0, 0.4, 0.05, ANTH, 6),
    KB(0.42, 0.52, 0.3, 0, 1.04, 0, POST_YEL),
    KC(0.15, 0.15, 0.42, 0, 1.3, 0, POST_YEL, 12, Math.PI / 2),
    KB(0.26, 0.03, 0.012, 0, 1.18, -0.152, 0x111111),
    KB(0.1, 0.06, 0.012, 0, 1.02, -0.152, 0x111111),
  ];
  // grey-beige utility cabinet (Verteilerkasten)
  K.cabinet = [
    KB(0.82, 0.1, 0.34, 0, 0.05, 0, 0x8f8b80),
    KB(0.8, 1.05, 0.32, 0, 0.62, 0, BEIGE),
    KB(0.86, 0.04, 0.38, 0, 1.16, 0, 0xb5b0a0),
    KB(0.01, 0.95, 0.33, 0, 0.62, 0, 0x8f8b80),
  ];
  const out = {};
  for (const k in K) {
    const g = mergeGeometries(K[k]);
    g.computeBoundingSphere();
    g.computeBoundingBox();
    out[k] = g;
  }
  return out;
}

/** Collects quads into one BufferGeometry (position, normal, uv, index). */
class QuadBuilder {
  constructor() {
    this.p = [];
    this.n = [];
    this.u = [];
    this.i = [];
  }
  /** Centre c, half right vector r, half up vector up, normal nn, uv rect (u0,v0 at -r-up .. u1,v1 at +r+up). */
  quad(c, r, up, nn, u0, v0, u1, v1) {
    const b = this.p.length / 3;
    for (const [sr, su, uu, vv] of [
      [-1, -1, u0, v0],
      [1, -1, u1, v0],
      [1, 1, u1, v1],
      [-1, 1, u0, v1],
    ]) {
      this.p.push(c[0] + r[0] * sr + up[0] * su, c[1] + r[1] * sr + up[1] * su, c[2] + r[2] * sr + up[2] * su);
      this.n.push(nn[0], nn[1], nn[2]);
      this.u.push(uu, vv);
    }
    this.i.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  build() {
    if (!this.i.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.u, 2));
    g.setIndex(this.i);
    g.computeBoundingSphere();
    return g;
  }
}

/** Streets data stores rings delta-encoded in decimetres. */
function decRings(poly) {
  return poly.map((r) => {
    const o = [];
    let x = 0,
      z = 0;
    for (let i = 0; i < r.length; i += 2) {
      x += r[i];
      z += r[i + 1];
      o.push([x / 10, z / 10]);
    }
    return o;
  });
}

const isArmRoad = (c) => c <= 6 || c === 8 || (c >= 14 && c <= 18);
const isKerbedCar = (c) => c <= 6 || (c >= 14 && c <= 18);
/** 0 = most important (primary) … 5 = living street. */
const rankOf = (c) => (c <= 2 ? 0 : c === 3 ? 1 : c === 4 || c >= 14 ? 2 : c === 5 ? 3 : c === 6 ? 4 : 5);
const yawOf = (dx, dz) => Math.atan2(dx, dz);
const BIKE_COLS = [0x1b1b1b, 0xf2f2f2, 0x2b4f8f, 0x8e1b1b, 0x2f6b3a, 0x9aa3a8, 0xd9c7a0, 0x5b2a6e, 0xe2b818];

/**
 * Decides where everything goes and builds the tiled meshes. Items stay on the pavement
 * (kerb-side furniture zone), off the carriageway, clear of lamps, signal poles, zebra
 * crossings, trees and building walls (tested against the static Rapier world).
 */
class StreetScene {
  constructor(furn) {
    const { streets, city, RAPIER } = ctx;
    this.furn = furn;
    this.dens = DENSITY[ctx.quality] ?? 0.75;
    this.rng = createRng(5101);
    this.kit = [];
    this.signs = [];
    this.names = [];
    this.glass = [];
    this.ads = [];
    this.colliders = [];
    this.count = {};
    this.ball = new Map();
    this.idRot = { x: 0, y: 0, z: 0, w: 1 };
    this.RAPIER = RAPIER;
    // pavement polygons
    this.pave = new SpatialGrid(50);
    for (const tile of streets.walk) {
      for (const poly of tile) {
        const rings = decRings(poly);
        const b = bounds(rings[0]);
        const it = { rings, b };
        for (let x = Math.floor(b.minx / 50); x <= Math.floor(b.maxx / 50); x++) {
          for (let z = Math.floor(b.minz / 50); z <= Math.floor(b.maxz / 50); z++) this.pave.insert(x * 50 + 1, z * 50 + 1, it);
        }
      }
    }
    // carriageway segments (split to <= 20 m so a 25 m query radius always finds them)
    this.segs = new SpatialGrid(30);
    for (const r of city.roads) {
      if (!(r.c <= 8 || (r.c >= 14 && r.c <= 18)) || r.pts.length < 2) continue;
      const hw = roadWidth(r) / 2;
      for (let i = 0; i < r.pts.length - 1; i++) {
        const a = r.pts[i],
          b = r.pts[i + 1];
        const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 20));
        for (let k = 0; k < n; k++) {
          const ax = a[0] + ((b[0] - a[0]) * k) / n,
            az = a[1] + ((b[1] - a[1]) * k) / n;
          const bx = a[0] + ((b[0] - a[0]) * (k + 1)) / n,
            bz = a[1] + ((b[1] - a[1]) * (k + 1)) / n;
          this.segs.insert((ax + bx) / 2, (az + bz) / 2, [ax, az, bx, bz, hw, r]);
        }
      }
    }
    this.crossGrid = new SpatialGrid(30);
    for (const c of streets.cross) this.crossGrid.insert(c[0], c[1], c);
    this.occ = new SpatialGrid(10);
    for (const L of furn.lamps) this.claim(L.x, L.z, 0.4);
    for (const q of furn.poles) this.claim(q.x, q.z, 0.45);
    this.sigGrid = new SpatialGrid(50);
    for (const s of streets.signals) this.sigGrid.insert(s.x, s.z, s);
    this.nodeGrid = new SpatialGrid(30);
    this.stopGrid = new SpatialGrid(100);
    this.namePairs = new SpatialGrid(60);
  }

  // ---------- spatial tests ----------
  onPave(x, z) {
    for (const it of this.pave.query(x, z, 0)) {
      const b = it.b;
      if (x < b.minx || x > b.maxx || z < b.minz || z > b.maxz) continue;
      if (!pip(x, z, it.rings[0])) continue;
      let hole = false;
      for (let h = 1; h < it.rings.length && !hole; h++) hole = pip(x, z, it.rings[h]);
      if (!hole) return true;
    }
    return false;
  }
  /** Distance from (x, z) to the nearest carriageway edge (negative = on the road). */
  roadDist(x, z) {
    let best = Infinity;
    for (const [ax, az, bx, bz, hw] of this.segs.query(x, z, 25)) {
      const d = segDist(x, z, ax, az, bx, bz).d - hw;
      if (d < best) best = d;
    }
    return best;
  }
  near(grid, x, z, d) {
    for (const o of grid.query(x, z, d)) if (Math.hypot(o.x - x, o.z - z) < d) return true;
    return false;
  }
  free(x, z, r) {
    for (const o of this.occ.query(x, z, r + 3)) if (Math.hypot(o.x - x, o.z - z) < r + o.r) return false;
    return true;
  }
  claim(x, z, r) {
    this.occ.insert(x, z, { x, z, r });
  }
  nearCross(x, z, pad = 0) {
    for (const [cx, cz, ang, w] of this.crossGrid.query(x, z, 30)) {
      const dx = Math.sin(ang),
        dz = Math.cos(ang);
      const rx = x - cx,
        rz = z - cz;
      if (Math.abs(rx * dx + rz * dz) < 2.6 + pad && Math.abs(rx * dz - rz * dx) < w / 2 + 4.5) return true;
    }
    return false;
  }
  /** True if a ball at (x, z) touches static geometry (building walls, trees, poles). */
  solid(x, y, z, r) {
    let shape = this.ball.get(r);
    if (!shape) this.ball.set(r, (shape = new this.RAPIER.Ball(r)));
    return ctx.world.intersectionWithShape({ x, y: y + r + 0.15, z }, this.idRot, shape) != null;
  }
  /** Full check for a round footprint of radius r. o: { ped, y, margin, zebra } */
  ok(x, z, r, o = {}) {
    if (!this.free(x, z, r)) return false;
    if (!o.zebra && this.nearCross(x, z, r)) return false;
    if (o.ped) {
      if (this.roadDist(x, z) < (o.margin ?? 0.9) + r) return false;
    } else {
      if (!this.onPave(x, z)) return false;
      if (r > 0.25) {
        const k = r * 0.85;
        if (!this.onPave(x + k, z) || !this.onPave(x - k, z) || !this.onPave(x, z + k) || !this.onPave(x, z - k)) return false;
      }
      if (this.roadDist(x, z) < (o.margin ?? 0.3) + r) return false;
    }
    return !this.solid(x, o.y ?? KERB, z, Math.max(0.12, r));
  }
  groundAt(x, z) {
    const y = ctx.physics.groundY(x, z);
    return y > -0.1 && y < 0.4 ? y : null;
  }

  // ---------- emitters ----------
  add(kind, x, y, z, yaw, extra = {}) {
    const it = { kind, x, y, z, yaw, sy: 1, ...extra };
    this.kit.push(it);
    this.count[kind] = (this.count[kind] || 0) + 1;
    return it;
  }
  cyl(x, y, z, r, hh) {
    this.colliders.push(['c', x, y + hh, z, r, hh]);
  }
  box(x, y, z, yaw, hx, hy, hz) {
    this.colliders.push(['b', x, y + hy, z, yaw, hx, hy, hz]);
  }
  /** Sign post with plates stacked top → bottom, facing yaw; `back` cells are mounted on the reverse side. */
  post(x, z, y, yaw, cells, back = null) {
    let h = 2.15;
    const placed = [];
    for (let k = cells.length - 1; k >= 0; k--) {
      const [S, vf] = SIGN_DIM[cells[k]];
      placed.push([cells[k], h + (S * vf) / 2, k]);
      h += S * vf + 0.05;
    }
    const top = h - 0.03;
    this.add('pole', x, y, z, yaw, { sy: top });
    this.cyl(x, y, z, 0.05, top / 2);
    const fx = Math.sin(yaw),
      fz = Math.cos(yaw);
    for (const [cell, cy, k] of placed) {
      this.signs.push({ x: x + fx * 0.045, y: y + cy, z: z + fz * 0.045, yaw, cell });
      if (back) this.signs.push({ x: x - fx * 0.045, y: y + cy, z: z - fz * 0.045, yaw: yaw + Math.PI, cell: back[k] });
    }
    this.count.signs = (this.count.signs || 0) + cells.length + (back ? back.length : 0);
    this.claim(x, z, 0.35);
  }
  /** Frankfurt street-name post: blades = [[name, dirX, dirZ], …], each blade runs along its street. */
  namePost(x, z, y, blades) {
    const top = 2.6;
    this.add('pole', x, y, z, 0, { sy: top + 0.02 });
    this.cyl(x, y, z, 0.05, top / 2);
    blades.forEach(([name, dx, dz], k) => this.names.push({ x, y: y + top + 0.1 + k * 0.205, z, yaw: Math.atan2(-dz, dx), name }));
    this.count.nameSigns = (this.count.nameSigns || 0) + 1;
    this.claim(x, z, 0.35);
  }
  /** Tries a few positions along a path for a sign post (side +1 = right of the path direction). */
  tryPost(path, s0, side, off, len, faceFn, cells, back) {
    for (const ds of [0, 1.5, 3, 4.5, 6, 8]) {
      const s = s0 + ds;
      if (s > len - 2) return false;
      const p = pointAlong(path, s);
      const q = { x: p.x - p.dz * side * off, z: p.z + p.dx * side * off, dx: p.dx, dz: p.dz };
      if (!this.ok(q.x, q.z, 0.22, { margin: 0.25 })) continue;
      this.post(q.x, q.z, KERB, faceFn(q), cells, back);
      return true;
    }
    return false;
  }

  // ---------- placement passes ----------
  place() {
    ctx.world.step(); // static colliders become queryable after the first step (nothing dynamic exists yet)
    this.junctions();
    this.crossings();
    this.stops();
    if (!ctx.station) this.transitWorksites(); // the real Hbf replaces the placeholder work zone
    this.midBlock();
    this.pedZones();
    this.lampBins();
  }

  /** Mark the unfinished rail terminus as a deliberate work zone (Frankfurt Hbf). */
  transitWorksites() {
    // The stop/crowd reference point is the forecourt. Rail alignments sit about
    // 120 m west of it, so anchor the works to the actual track throat.
    const station = { x: -777, z: 492 };
    const placed = [];
    for (const rail of ctx.city.rails || []) {
      if (rail.tram || rail.bridge || rail.pts.length < 2) continue;
      let best = null;
      for (let i = 0; i < rail.pts.length - 1; i++) {
        const a = rail.pts[i],
          b = rail.pts[i + 1];
        const dx = b[0] - a[0],
          dz = b[1] - a[1];
        const length = Math.hypot(dx, dz);
        const steps = Math.max(1, Math.ceil(length / 4));
        for (let j = 0; j <= steps; j++) {
          const t = j / steps;
          const x = a[0] + dx * t,
            z = a[1] + dz * t;
          const d = Math.hypot(x - station.x, z - station.z);
          if (d > 95 || (best && d >= best.d) || this.roadDist(x, z) < 4.5) continue;
          best = { d, x, z, yaw: yawOf(dx, dz) };
        }
      }
      if (!best || best.d > 95 || placed.some((p) => Math.hypot(p.x - best.x, p.z - best.z) < 2.8)) continue;
      // Keep the closure on rail land and away from streets and existing structures.
      const y = this.groundAt(best.x, best.z);
      if (y == null || this.solid(best.x, y + 0.4, best.z, 1.1)) continue;
      const yaw = best.yaw + Math.PI / 2;
      this.add('workBarrier', best.x, y, best.z, yaw);
      this.box(best.x, y, best.z, yaw, 1.4, 0.55, 0.12);
      const facing = best.yaw + Math.PI;
      this.post(best.x, best.z, y, facing, [SIGN.WORK], [SIGN.WORK]);
      placed.push(best);
      if (placed.length >= 12) break;
    }
    this.count.transitWorksites = placed.length;
  }

  junctions() {
    const vmap = new Map();
    for (const r of ctx.city.roads) {
      if (!isArmRoad(r.c) || r.pts.length < 2) continue;
      r.pts.forEach((p, i) => {
        const k = `${p[0]},${p[1]}`;
        if (!vmap.has(k)) vmap.set(k, []);
        vmap.get(k).push([r, i]);
      });
    }
    const junctions = [];
    for (const list of vmap.values()) {
      let n = 0;
      for (const [r, i] of list) n += i === 0 || i === r.pts.length - 1 ? 1 : 2;
      if (n < 3) continue;
      const node = list[0][0].pts[list[0][1]];
      const arms = [];
      let bridge = false;
      for (const [r, i] of list) {
        if (r.bridge) bridge = true;
        for (const dir of [-1, 1]) {
          if ((dir < 0 && i === 0) || (dir > 0 && i === r.pts.length - 1)) continue;
          const path = dir > 0 ? r.pts.slice(i) : r.pts.slice(0, i + 1).reverse();
          const len = polylineLength(path);
          if (len < 1) continue;
          const q = pointAlong(path, Math.min(8, len));
          const L = Math.hypot(q.x - node[0], q.z - node[1]) || 1;
          arms.push({
            r,
            path,
            len,
            hw: roadWidth(r) / 2,
            dx: (q.x - node[0]) / L,
            dz: (q.z - node[1]) / L,
            flow: !r.oneway ? 'both' : dir > 0 ? 'out' : 'in',
          });
        }
      }
      if (bridge || arms.length < 3) continue;
      junctions.push({ x: node[0], z: node[1], arms });
      this.nodeGrid.insert(node[0], node[1], { x: node[0], z: node[1] });
    }
    this.count.junctions = junctions.length;
    const done = new SpatialGrid(30);
    for (const J of junctions) {
      const crowded = this.near(done, J.x, J.z, 14);
      done.insert(J.x, J.z, J);
      const signal = this.near(this.sigGrid, J.x, J.z, 30);
      this.nameSign(J);
      this.cornerItems(J, signal);
      if (!signal && !crowded) this.prioritySigns(J);
    }
  }

  /** Vorfahrt signs, Tempo-30 / verkehrsberuhigt zones, one-way streets at an unsignalised junction. */
  prioritySigns(J) {
    const { arms } = J;
    const rng = this.rng;
    const best = Math.min(...arms.map((a) => rankOf(a.r.c)));
    const s0 = Math.max(...arms.map((a) => a.hw)) + 3;
    const opposite = (cands) => {
      let pair = null,
        bd = 2;
      for (let i = 0; i < cands.length; i++) {
        for (let j = i + 1; j < cands.length; j++) {
          const d = cands[i].dx * cands[j].dx + cands[i].dz * cands[j].dz;
          if (d < bd) {
            bd = d;
            pair = [cands[i], cands[j]];
          }
        }
      }
      return pair || cands.slice(0, 2);
    };
    let main = arms.filter((a) => rankOf(a.r.c) === best);
    if (main.length === arms.length)
      main = best >= 4 ? [] : opposite(arms); // equal residential streets: rechts vor links
    else if (main.length === 1) {
      let o = null,
        bd = 2;
      for (const a of arms) {
        if (a === main[0]) continue;
        const d = a.dx * main[0].dx + a.dz * main[0].dz;
        if (d < bd) {
          bd = d;
          o = a;
        }
      }
      main.push(o);
    } else if (main.length > 2) main = opposite(main);
    const faceOut = (q) => yawOf(q.dx, q.dz),
      faceIn = (q) => yawOf(-q.dx, -q.dz);
    for (const a of arms) {
      const isMain = main.includes(a);
      const c = a.r.c;
      const zoneEntry = isMain ? -1 : c === 6 && best <= 2 ? SIGN.ZONE30 : c === 8 && best < 5 ? SIGN.LIVING : -1;
      const zoneEnd = zoneEntry === SIGN.ZONE30 ? SIGN.ZONE30_END : zoneEntry === SIGN.LIVING ? SIGN.LIVING_END : -1;
      // approach (traffic driving towards the junction): right-hand kerb, plates facing the drivers
      if (a.flow !== 'out') {
        const cells = [];
        if (main.length && !isMain) cells.push(rankOf(c) >= 3 && rng() < 0.15 ? SIGN.STOP : SIGN.GIVEWAY);
        else if (main.length && rng() < 0.45) cells.push(rng() < 0.75 ? SIGN.PRIO_ROAD : SIGN.PRIO);
        if (zoneEnd >= 0) cells.push(zoneEnd);
        if (cells.length) this.tryPost(a.path, s0, -1, a.hw + 0.55, a.len, faceOut, cells);
      }
      // traffic turning into the arm from the junction
      if (a.flow === 'in') this.tryPost(a.path, s0 + 1, 1, a.hw + 0.55, a.len, faceIn, [SIGN.NO_ENTRY]);
      else if (zoneEntry >= 0) this.tryPost(a.path, s0 + 2, 1, a.hw + 0.55, a.len, faceIn, [zoneEntry]);
      else if (isMain && rankOf(c) <= 2 && rng() < 0.18) this.tryPost(a.path, s0 + 12, 1, a.hw + 0.55, a.len, faceIn, [SIGN.V50]);
      else if (c === 6 && rng() < 0.08) this.tryPost(a.path, s0 + 10, 1, a.hw + 0.55, a.len, faceIn, [SIGN.V30]);
      if (a.flow === 'out') {
        // Einbahnstraße: plates parallel to the street, arrow pointing along the traffic
        this.tryPost(a.path, Math.max(4, s0 * 0.7), 1, a.hw + 0.55, a.len, (q) => yawOf(-q.dz, q.dx), [SIGN.ONEWAY_R], [SIGN.ONEWAY_L]);
      }
    }
  }

  nameSign(J) {
    const named = J.arms.filter((a) => a.r.name && isKerbedCar(a.r.c));
    if (named.length < 2) return;
    named.sort((a, b) => rankOf(a.r.c) - rankOf(b.r.c));
    const A = named[0];
    let B = null,
      bc = 0.4;
    for (const b of named) {
      if (b.r.name === A.r.name) continue;
      const c = Math.abs(A.dx * b.dz - A.dz * b.dx);
      if (c > bc) {
        bc = c;
        B = b;
      }
    }
    if (!B) return;
    const key = [A.r.name, B.r.name].sort().join('|');
    for (const o of this.namePairs.query(J.x, J.z, 60)) if (o.key === key && Math.hypot(o.x - J.x, o.z - J.z) < 60) return;
    let nx = -A.dz,
      nz = A.dx;
    if (nx * B.dx + nz * B.dz < 0) {
      nx = -nx;
      nz = -nz;
    }
    for (let k = 0; k < 7; k++) {
      const s = B.hw + 1.4 + k * 1.2;
      if (s > A.len - 1) break;
      const p = pointAlong(A.path, s);
      const x = p.x + nx * (A.hw + 0.6),
        z = p.z + nz * (A.hw + 0.6);
      if (!this.ok(x, z, 0.25, { margin: 0.25 })) continue;
      this.namePost(x, z, KERB, [
        [B.r.name, B.dx, B.dz],
        [A.r.name, A.dx, A.dz],
      ]);
      this.namePairs.insert(J.x, J.z, { key, x: J.x, z: J.z });
      return;
    }
  }

  /** Corner furniture at a junction: Litfaßsäule, cabinets, bike stands, bins, bollards, post box. */
  cornerItems(J, signal) {
    const rng = this.rng,
      D = this.dens;
    const arms = J.arms.filter((a) => isKerbedCar(a.r.c)).sort((a, b) => Math.atan2(a.dx, a.dz) - Math.atan2(b.dx, b.dz));
    if (arms.length < 2) return;
    const best = Math.min(...arms.map((a) => rankOf(a.r.c)));
    for (let i = 0; i < arms.length; i++) {
      const A = arms[i],
        B = arms[(i + 1) % arms.length];
      let nx = -A.dz,
        nz = A.dx;
      if (nx * B.dx + nz * B.dz < 0) {
        nx = -nx;
        nz = -nz;
      }
      const spot = (along, off) => {
        const p = pointAlong(A.path, Math.min(A.len - 1, B.hw + along));
        return { x: p.x + nx * (A.hw + off), z: p.z + nz * (A.hw + off) };
      };
      const faceRoad = yawOf(-nx, -nz);
      if (best <= 2 && rng() < 0.2 * D) {
        const q = spot(4.5, 1.6);
        if (this.ok(q.x, q.z, 0.75, { margin: 0.6 })) this.litfass(q.x, KERB, q.z);
      }
      if (rng() < 0.22 * D) {
        const q = spot(7 + rng() * 6, 0.75);
        if (this.ok(q.x, q.z, 0.45)) this.cabinet(q.x, KERB, q.z, faceRoad);
      }
      if (rng() < (best >= 3 ? 0.35 : 0.15) * D) this.bikeGroup(A.path, A.hw + 1.0, B.hw + 6 + rng() * 6, nx, nz);
      if (rng() < 0.3 * D) {
        const q = spot(3 + rng() * 4, 0.7);
        if (this.ok(q.x, q.z, 0.3)) this.bin(q.x, KERB, q.z, faceRoad);
      }
      if (rng() < 0.05 * D) {
        const q = spot(9 + rng() * 5, 0.75);
        if (this.ok(q.x, q.z, 0.35)) this.postbox(q.x, KERB, q.z, faceRoad);
      }
      if (best <= 2 && !signal && rng() < 0.25 * D) {
        // Poller along the corner kerb (keeps cars off the pavement)
        for (let k = 0; k < 3; k++) {
          const q = spot(1.5 + k * 1.5, 0.4);
          if (this.ok(q.x, q.z, 0.12, { margin: 0.15 })) this.bollard(q.x, KERB, q.z);
        }
      }
    }
  }

  /** Fußgängerüberweg signs on both kerbs in front of every zebra crossing. */
  crossings() {
    for (const [x, z, ang, w] of ctx.streets.cross) {
      const tx = Math.sin(ang),
        tz = Math.cos(ang);
      const px = tz,
        pz = -tx;
      for (const s of [1, -1]) {
        for (const ds of [2.4, 3.4, 4.6]) {
          const qx = x - px * s * (w / 2 + 0.6) - tx * s * ds,
            qz = z - pz * s * (w / 2 + 0.6) - tz * s * ds;
          if (!this.ok(qx, qz, 0.22, { zebra: true, margin: 0.2 })) continue;
          this.post(qx, qz, KERB, yawOf(-tx * s, -tz * s), [SIGN.ZEBRA]);
          break;
        }
      }
    }
  }

  /** Bus stops along main roads and tram stops where tram tracks run inside a street. */
  stops() {
    const rng = this.rng;
    for (const rail of ctx.city.rails) {
      if (!rail.tram || rail.bridge || rail.pts.length < 2) continue;
      const len = polylineLength(rail.pts);
      for (let s = 30; s < len - 30; s += 40) {
        const p = pointAlong(rail.pts, s);
        if (this.near(this.stopGrid, p.x, p.z, 420) || this.near(this.nodeGrid, p.x, p.z, 30)) continue;
        let road = null;
        for (const [ax, az, bx, bz, hw, r] of this.segs.query(p.x, p.z, 25)) {
          if (!isKerbedCar(r.c) || r.bridge) continue;
          const L = Math.hypot(bx - ax, bz - az) || 1;
          if (Math.abs(((bx - ax) * p.dx + (bz - az) * p.dz) / L) < 0.85) continue;
          if (segDist(p.x, p.z, ax, az, bx, bz).d < hw) road = r;
        }
        if (!road) continue;
        const rs = this.projectOn(road, p.x, p.z);
        let n = 0;
        for (const side of [1, -1]) if (this.stop(road, rs + side * 6, side, true)) n++;
        if (n) {
          this.stopGrid.insert(p.x, p.z, { x: p.x, z: p.z });
          this.count.tramStops = (this.count.tramStops || 0) + 1;
        }
      }
    }
    for (const r of ctx.city.roads) {
      if (!(r.c >= 2 && r.c <= 4) || r.bridge || r.pts.length < 2) continue;
      const len = polylineLength(r.pts);
      for (let s = 30; s < len - 30; s += 40) {
        const p = pointAlong(r.pts, s);
        if (this.near(this.stopGrid, p.x, p.z, 340) || this.near(this.nodeGrid, p.x, p.z, 28) || rng() < 0.4) continue;
        let n = 0;
        if (this.stop(r, s, 1)) n++;
        if (!r.oneway && this.stop(r, s - 18, -1)) n++;
        if (n) {
          this.stopGrid.insert(p.x, p.z, { x: p.x, z: p.z });
          this.count.busStops = (this.count.busStops || 0) + 1;
        }
      }
    }
  }
  projectOn(r, x, z) {
    let acc = 0,
      best = 0,
      bd = Infinity;
    for (let i = 0; i < r.pts.length - 1; i++) {
      const a = r.pts[i],
        b = r.pts[i + 1];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const { d, t } = segDist(x, z, a[0], a[1], b[0], b[1]);
      if (d < bd) {
        bd = d;
        best = acc + t * L;
      }
      acc += L;
    }
    return best;
  }

  /** One Haltestelle on the given side of road r at distance s: H pole, glass shelter (if it fits), bin. */
  stop(r, s, side, underConstruction = false) {
    const len = polylineLength(r.pts);
    if (s < 8 || s > len - 8) return false;
    const hw = roadWidth(r) / 2;
    const p = pointAlong(r.pts, s);
    const nx = -p.dz * side,
      nz = p.dx * side; // towards the pavement
    const ax = p.dx * side,
      az = p.dz * side; // traffic direction on this side
    let hp = null;
    for (const ds of [3.4, 4.6, 2.2, 5.8]) {
      const x = p.x + nx * (hw + 0.6) + ax * ds,
        z = p.z + nz * (hw + 0.6) + az * ds;
      if (this.ok(x, z, 0.25, { margin: 0.25 })) {
        hp = [x, z];
        break;
      }
    }
    if (!hp) return false;
    const yawA = yawOf(-ax, -az);
    this.add('hpole', hp[0], KERB, hp[1], yawOf(-nx, -nz));
    this.cyl(hp[0], KERB, hp[1], 0.07, 1.5);
    const stopSign = underConstruction ? SIGN.WORK : SIGN.BUS;
    this.signs.push({ x: hp[0] - ax * 0.05, y: KERB + 2.72, z: hp[1] - az * 0.05, yaw: yawA, cell: stopSign });
    this.signs.push({ x: hp[0] + ax * 0.05, y: KERB + 2.72, z: hp[1] + az * 0.05, yaw: yawA + Math.PI, cell: stopSign });
    this.claim(hp[0], hp[1], 0.4);
    // shelter: front edge 0.9 m behind the kerb, open towards the road
    const cx = p.x + nx * (hw + 1.75),
      cz = p.z + nz * (hw + 1.75);
    const yaw = yawOf(-nx, -nz);
    const lx = Math.cos(yaw),
      lz = -Math.sin(yaw); // local +X
    let fits = true;
    for (const u of [-2.1, -1, 0, 1, 2.1]) {
      for (const v of [-0.85, 0.75]) {
        const x = cx + lx * u - nx * v,
          z = cz + lz * u - nz * v;
        if (!this.onPave(x, z) || this.roadDist(x, z) < 0.4 || this.nearCross(x, z)) fits = false;
      }
    }
    if (fits) {
      for (const u of [-1.5, 0, 1.5]) if (!this.free(cx + lx * u, cz + lz * u, 0.95) || this.solid(cx + lx * u, KERB, cz + lz * u, 0.75)) fits = false;
    }
    if (fits) {
      this.add('shelter', cx, KERB, cz, yaw);
      this.glass.push({ x: cx, y: KERB, z: cz, yaw });
      this.ads.push({ type: 'panel', x: cx, y: KERB, z: cz, yaw, cell: Math.floor(this.rng() * POSTERS.length) });
      this.box(cx + nx * 0.7, KERB, cz + nz * 0.7, yaw, 2.0, 1.2, 0.05); // back wall (local z = -0.7)
      this.box(cx + lx * 1.98, KERB, cz + lz * 1.98, yaw, 0.08, 1.05, 0.65);
      this.box(cx - lx * 1.98, KERB, cz - lz * 1.98, yaw, 0.04, 1.05, 0.55);
      for (const u of [-1.5, 0, 1.5]) this.claim(cx + lx * u, cz + lz * u, 0.95);
      this.count.shelters = (this.count.shelters || 0) + 1;
    }
    const bx = p.x + nx * (hw + 0.7) - ax * 3.2,
      bz = p.z + nz * (hw + 0.7) - az * 3.2;
    if (this.ok(bx, bz, 0.3)) this.bin(bx, KERB, bz, yaw);
    return true;
  }

  /** Mid-block furniture along kerbed streets. */
  midBlock() {
    const rng = this.rng,
      D = this.dens;
    for (const r of ctx.city.roads) {
      if (!isKerbedCar(r.c) || r.bridge || r.pts.length < 2) continue;
      const len = polylineLength(r.pts);
      if (len < 40) continue;
      const hw = roadWidth(r) / 2;
      const main = rankOf(r.c) <= 2;
      for (const side of [1, -1]) {
        for (let s = 16 + rng() * 6; s < len - 16; s += 6 + rng() * 3) {
          const p = pointAlong(r.pts, s);
          if (this.near(this.nodeGrid, p.x, p.z, 16)) continue;
          const nx = -p.dz * side,
            nz = p.dx * side;
          const faceRoad = yawOf(-nx, -nz);
          // traffic on this side drives +dir (right-hand traffic); one-way streets only +dir
          const faceTraffic = side > 0 || r.oneway ? yawOf(-p.dx, -p.dz) : yawOf(p.dx, p.dz);
          const at = (off) => [p.x + nx * (hw + off), p.z + nz * (hw + off)];
          const u = rng();
          const W = main ? [0.03, 0.022, 0.012, 0.012, 0.01, 0.005] : [0.026, 0.022, 0.025, 0.015, 0.012, 0.004];
          let k = -1;
          for (let i = 0, acc = 0; i < W.length && k < 0; i++) if (u < (acc += W[i] * D)) k = i;
          if (main) {
            if (k === 0) {
              const [x, z] = at(0.7);
              if (this.ok(x, z, 0.3)) this.bin(x, KERB, z, faceRoad);
            } else if (k === 1) {
              const [x, z] = at(0.55);
              if (this.ok(x, z, 0.22, { margin: 0.25 })) this.post(x, z, KERB, faceTraffic, [rng() < 0.6 ? SIGN.NO_STOP : SIGN.NO_PARK]);
            } else if (k === 2) {
              const [x, z] = at(0.75);
              if (this.ok(x, z, 0.45)) this.cabinet(x, KERB, z, faceRoad);
            } else if (k === 3) {
              const [x, z] = at(1.0);
              if (this.ok(x, z, 0.95)) this.bench(x, KERB, z, yawOf(nx, nz));
            } else if (k === 4) this.bikeGroup(r.pts, hw + 1.0, s, nx, nz);
            else if (k === 5) {
              const [x, z] = at(1.6);
              if (this.ok(x, z, 0.75, { margin: 0.6 })) this.litfass(x, KERB, z);
            }
          } else if (k === 0) {
            // Parkscheinautomat with the Parken sign next to it
            const [x, z] = at(0.6);
            const sx = x + p.dx * 1.6,
              sz = z + p.dz * 1.6;
            if (this.ok(x, z, 0.3) && this.ok(sx, sz, 0.22, { margin: 0.25 })) {
              this.put('meter', x, KERB, z, faceRoad, 0.3);
              this.box(x, KERB, z, faceRoad, 0.2, 0.68, 0.15);
              this.post(sx, sz, KERB, faceTraffic, [SIGN.PARK]);
            }
          } else if (k === 1) {
            const [x, z] = at(0.7);
            if (this.ok(x, z, 0.3)) this.bin(x, KERB, z, faceRoad);
          } else if (k === 2) this.bikeGroup(r.pts, hw + 1.0, s, nx, nz);
          else if (k === 3) {
            const [x, z] = at(0.75);
            if (this.ok(x, z, 0.45)) this.cabinet(x, KERB, z, faceRoad);
          } else if (k === 4) {
            const [x, z] = at(0.55);
            if (this.ok(x, z, 0.22, { margin: 0.25 })) this.post(x, z, KERB, faceTraffic, [SIGN.NO_PARK]);
          } else if (k === 5) {
            const [x, z] = at(0.75);
            if (this.ok(x, z, 0.35)) this.postbox(x, KERB, z, faceRoad);
          }
        }
      }
    }
  }

  /** Pedestrian zones (Zeil, Kaiserstraße …): benches, bins, bike stands, Litfaßsäulen, bollards at the entrances. */
  pedZones() {
    const rng = this.rng,
      D = this.dens;
    for (const r of ctx.city.roads) {
      if (r.c !== 9 || r.bridge || r.pts.length < 2) continue;
      const len = polylineLength(r.pts);
      const hw = roadWidth(r) / 2;
      for (const side of [1, -1]) {
        for (let s = 6 + rng() * 6; s < len - 4; s += 7 + rng() * 5) {
          const p = pointAlong(r.pts, s);
          const nx = -p.dz * side,
            nz = p.dx * side;
          const x = p.x + nx * (hw - 0.9),
            z = p.z + nz * (hw - 0.9);
          const u = rng();
          const kind = u < 0.2 * D ? 'bench' : u < 0.34 * D ? 'bin' : u < 0.4 * D ? 'bikes' : u < 0.43 * D ? 'litfass' : null;
          if (!kind) continue;
          const face = yawOf(-nx, -nz);
          if (kind === 'bikes') {
            this.bikeGroup(r.pts, hw - 1.7, s, nx, nz, true);
            continue;
          }
          if (kind === 'litfass') {
            if (hw < 4) continue;
            const lx = p.x + nx * (hw - 2.2),
              lz = p.z + nz * (hw - 2.2);
            const ly = this.groundAt(lx, lz);
            if (ly != null && this.ok(lx, lz, 0.75, { ped: true, y: ly })) this.litfass(lx, ly, lz);
            continue;
          }
          const y = this.groundAt(x, z);
          if (y == null) continue;
          if (kind === 'bench' && this.ok(x, z, 0.95, { ped: true, y })) this.bench(x, y, z, face);
          else if (kind === 'bin' && this.ok(x, z, 0.3, { ped: true, y })) this.bin(x, y, z, face);
        }
      }
      // entrances: a row of bollards where the zone meets a carriageway, plus the Fußgängerzone sign
      for (const end of [0, 1]) {
        const path = end ? r.pts.slice().reverse() : r.pts;
        if (this.roadDist(path[0][0], path[0][1]) > 3) continue;
        for (let s = 0.5; s < Math.min(15, len - 1); s += 0.5) {
          const p = pointAlong(path, s);
          if (this.roadDist(p.x, p.z) < 1.3) continue;
          const nx = -p.dz,
            nz = p.dx;
          const n = Math.max(2, Math.floor((hw * 2 - 1) / 1.6));
          for (let k = 0; k < n; k++) {
            const t = (k - (n - 1) / 2) * 1.6;
            const x = p.x + nx * t,
              z = p.z + nz * t;
            const y = this.groundAt(x, z);
            if (y != null && this.ok(x, z, 0.12, { ped: true, y, margin: 0.6 })) this.bollard(x, y, z);
          }
          const sx = p.x + nx * (hw - 0.4) + p.dx * 0.8,
            sz = p.z + nz * (hw - 0.4) + p.dz * 0.8;
          const sy = this.groundAt(sx, sz);
          if (sy != null && this.ok(sx, sz, 0.22, { ped: true, y: sy, margin: 0.4 }))
            this.post(sx, sz, sy, yawOf(-p.dx, -p.dz), [SIGN.PED_ZONE], [SIGN.PED_ZONE_END]);
          break;
        }
      }
    }
  }

  /** FES bins clamped to some lamp masts (hidden again when the lamp gets knocked over). */
  lampBins() {
    for (const L of this.furn.lamps) {
      if (this.rng() > 0.1 * this.dens) continue;
      const x = L.x - Math.sin(L.yaw) * 0.31,
        z = L.z - Math.cos(L.yaw) * 0.31;
      if (this.nearCross(x, z) || !this.onPave(x, z)) continue;
      L.binItem = this.add('binLamp', x, KERB, z, L.yaw);
    }
  }

  // ---------- composite props ----------
  put(kind, x, y, z, yaw, r) {
    this.add(kind, x, y, z, yaw);
    this.claim(x, z, r);
  }
  bin(x, y, z, yaw) {
    this.put('bin', x, y, z, yaw, 0.3);
    this.cyl(x, y, z, 0.24, 0.55);
  }
  bollard(x, y, z) {
    this.put('bollard', x, y, z, 0, 0.15);
    this.cyl(x, y, z, 0.1, 0.45);
  }
  bench(x, y, z, yaw) {
    this.put('bench', x, y, z, yaw, 0.95);
    this.box(x, y, z, yaw, 0.9, 0.45, 0.28);
  }
  cabinet(x, y, z, yaw) {
    this.put('cabinet', x, y, z, yaw, 0.45);
    this.box(x, y, z, yaw, 0.42, 0.6, 0.18);
  }
  postbox(x, y, z, yaw) {
    this.put('postbox', x, y, z, yaw, 0.35);
    this.box(x, y, z, yaw, 0.22, 0.7, 0.17);
  }
  litfass(x, y, z) {
    const yaw = this.rng() * Math.PI * 2;
    this.put('litfass', x, y, z, yaw, 0.8);
    this.cyl(x, y, z, 0.7, 1.5);
    this.ads.push({ type: 'column', x, y, z, yaw, cell: Math.floor(this.rng() * POSTERS.length) });
  }
  /** 2–5 Kreuzberger Bügel perpendicular to the kerb along a path (off = distance from its centreline), some with bikes. */
  bikeGroup(path, off, s, nx, nz, ped = false) {
    const n = 2 + Math.floor(this.rng() * 4);
    const yaw = yawOf(nx, nz);
    const placed = [];
    for (let k = 0; k < n; k++) {
      const p = pointAlong(path, s + k);
      const x = p.x + nx * off,
        z = p.z + nz * off;
      const y = ped ? this.groundAt(x, z) : KERB;
      if (y == null || !this.ok(x, z, 0.45, { ped, y, margin: ped ? 0.9 : 0.25 })) break;
      placed.push([x, y, z, p]);
      this.claim(x, z, 0.45);
    }
    if (placed.length < 2) return;
    for (const [x, y, z, p] of placed) {
      this.add('rack', x, y, z, yaw);
      if (this.rng() < 0.6) {
        const sd = this.rng() < 0.5 ? 1 : -1;
        this.add('bike', x + p.dx * 0.3 * sd, y, z + p.dz * 0.3 * sd, yaw + (this.rng() - 0.5) * 0.08, {
          col: BIKE_COLS[Math.floor(this.rng() * BIKE_COLS.length)],
        });
      }
    }
    const [x0, y0, z0] = placed[0],
      [x1, , z1] = placed[placed.length - 1];
    this.box((x0 + x1) / 2, y0, (z0 + z1) / 2, yawOf(x1 - x0, z1 - z0), 0.45, 0.45, Math.hypot(x1 - x0, z1 - z0) / 2 + 0.1);
  }

  // ---------- meshes ----------
  /** Builds the tiled meshes and the static colliders. Returns { tiles, mats }. */
  buildMeshes() {
    const { scene, world, RAPIER } = ctx;
    const aniso = QUALITY[ctx.quality]?.anisotropy ?? 4;
    const kitGeo = buildKit();
    const kitMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.15 });
    kitMat.name = 'furniture_kit';
    const signTex = new THREE.CanvasTexture(drawSignAtlas());
    signTex.colorSpace = THREE.SRGBColorSpace;
    signTex.anisotropy = aniso;
    const signMat = new THREE.MeshStandardMaterial({ map: signTex, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.45, metalness: 0.1 });
    signMat.emissive.set(0xffffff);
    signMat.emissiveMap = signTex;
    signMat.emissiveIntensity = 0;
    signMat.name = 'furniture_signs';
    // back of the plates: plain grey aluminium
    signMat.onBeforeCompile = (s) => {
      s.fragmentShader = s.fragmentShader
        .replace('#include <map_fragment>', '#include <map_fragment>\nif (!gl_FrontFacing) diffuseColor.rgb = vec3(0.36, 0.37, 0.38);')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\nif (!gl_FrontFacing) totalEmissiveRadiance = vec3(0.0);');
    };
    const names = [...new Set(this.names.map((n) => n.name))];
    const { tex: nameTex, slots } = drawNameAtlas(names);
    nameTex.anisotropy = aniso;
    const nameMat = new THREE.MeshStandardMaterial({ map: nameTex, roughness: 0.4, metalness: 0.1 });
    nameMat.name = 'furniture_street_names';
    nameMat.onBeforeCompile = (s) => {
      s.fragmentShader = s.fragmentShader.replace(
        '#include <map_fragment>',
        'diffuseColor.rgb *= mix(vec3(0.004, 0.035, 0.2), vec3(0.9), texture2D(map, vMapUv).r);',
      );
    };
    const adTex = new THREE.CanvasTexture(drawPosterAtlas());
    adTex.colorSpace = THREE.SRGBColorSpace;
    adTex.anisotropy = aniso;
    const adMat = new THREE.MeshStandardMaterial({ map: adTex, emissiveMap: adTex, roughness: 0.3, metalness: 0 });
    adMat.emissive.set(0xffffff);
    adMat.emissiveIntensity = 0.05;
    adMat.name = 'furniture_posters';
    const glassMat = new THREE.MeshStandardMaterial({
      color: 0xd5e6ec,
      transparent: true,
      opacity: 0.22,
      roughness: 0.05,
      metalness: 0.2,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    glassMat.name = 'furniture_glass';

    const groups = new Map();
    const tileOf = (x, z) => {
      const k = `${Math.floor(x / SCENE_TILE)},${Math.floor(z / SCENE_TILE)}`;
      let t = groups.get(k);
      if (!t) groups.set(k, (t = { kit: [], signs: [], names: [], glass: [], ads: [], minx: Infinity, maxx: -Infinity, minz: Infinity, maxz: -Infinity }));
      t.minx = Math.min(t.minx, x);
      t.maxx = Math.max(t.maxx, x);
      t.minz = Math.min(t.minz, z);
      t.maxz = Math.max(t.maxz, z);
      return t;
    };
    for (const k of ['kit', 'signs', 'names', 'glass', 'ads']) for (const it of this[k]) tileOf(it.x, it.z)[k].push(it);

    const m4 = new THREE.Matrix4(),
      q = new THREE.Quaternion(),
      p = new THREE.Vector3(),
      sc = new THREE.Vector3(),
      white = new THREE.Color(1, 1, 1),
      c = new THREE.Color();
    const tiles = [];
    const stats = { batches: 0, meshes: 0, tris: 0 };
    for (const t of groups.values()) {
      const objs = [];
      if (t.kit.length) {
        const kinds = [...new Set(t.kit.map((it) => it.kind))];
        let nv = 0,
          ni = 0;
        for (const k of kinds) {
          nv += kitGeo[k].attributes.position.count;
          ni += kitGeo[k].index.count;
        }
        const bm = new THREE.BatchedMesh(t.kit.length, nv, ni, kitMat);
        bm.sortObjects = false;
        const gid = {};
        for (const k of kinds) gid[k] = bm.addGeometry(kitGeo[k]);
        const colored = t.kit.some((it) => it.col != null);
        for (const it of t.kit) {
          const id = bm.addInstance(gid[it.kind]);
          q.setFromAxisAngle(UP, it.yaw);
          m4.compose(p.set(it.x, it.y, it.z), q, sc.set(1, it.sy, 1));
          bm.setMatrixAt(id, m4);
          if (colored) bm.setColorAt(id, it.col != null ? c.setHex(it.col) : white);
          it.bm = bm;
          it.id = id;
          stats.tris += kitGeo[it.kind].index.count / 3;
        }
        bm.computeBoundingBox();
        bm.computeBoundingSphere();
        bm.castShadow = true;
        bm.receiveShadow = true;
        objs.push(bm);
        stats.batches++;
      }
      if (t.signs.length) {
        const qb = new QuadBuilder();
        for (const s of t.signs) {
          const S = SIGN_DIM[s.cell][0] / 2,
            co = Math.cos(s.yaw),
            si = Math.sin(s.yaw);
          const col = s.cell % 8,
            row = Math.floor(s.cell / 8);
          qb.quad([s.x, s.y, s.z], [co * S, 0, -si * S], [0, S, 0], [si, 0, co], col / 8, 1 - (row + 1) / 4, (col + 1) / 8, 1 - row / 4);
        }
        const m = new THREE.Mesh(qb.build(), signMat);
        m.castShadow = true;
        objs.push(m);
      }
      if (t.names.length) {
        const qb = new QuadBuilder();
        const T = 0.0125,
          H = 0.1;
        for (const n of t.names) {
          const sl = slots.get(n.name);
          const L = sl.len / 2,
            co = Math.cos(n.yaw),
            si = Math.sin(n.yaw);
          const r = [co * L, 0, -si * L],
            nr = [-co * L, 0, si * L],
            nn = [si, 0, co],
            up = [0, H, 0];
          const C = (ox, oy, oz) => [n.x + ox, n.y + oy, n.z + oz];
          qb.quad(C(si * T, 0, co * T), r, up, nn, sl.u0, sl.vb, sl.u1, sl.vt);
          qb.quad(C(-si * T, 0, -co * T), nr, up, [-si, 0, -co], sl.u0, sl.vb, sl.u1, sl.vt);
          qb.quad(C(0, H, 0), r, [-si * T, 0, -co * T], [0, 1, 0], sl.u0, sl.vt, sl.u0, sl.vt);
          qb.quad(C(0, -H, 0), r, [si * T, 0, co * T], [0, -1, 0], sl.u0, sl.vt, sl.u0, sl.vt);
          qb.quad(C(co * L, 0, -si * L), [-si * T, 0, -co * T], up, [co, 0, -si], sl.u0, sl.vt, sl.u0, sl.vt);
          qb.quad(C(-co * L, 0, si * L), [si * T, 0, co * T], up, [-co, 0, si], sl.u0, sl.vt, sl.u0, sl.vt);
        }
        const m = new THREE.Mesh(qb.build(), nameMat);
        m.castShadow = true;
        objs.push(m);
      }
      if (t.glass.length) {
        const qb = new QuadBuilder();
        for (const g of t.glass) {
          const co = Math.cos(g.yaw),
            si = Math.sin(g.yaw);
          const W = (lx, ly, lz) => [g.x + lx * co + lz * si, g.y + ly, g.z - lx * si + lz * co];
          const X = [co, 0, -si],
            Z = [si, 0, co];
          const mul = (v, k) => [v[0] * k, v[1] * k, v[2] * k];
          qb.quad(W(0, 1.25, -0.7), mul(X, 1.95), [0, 1.05, 0], Z, 0, 0, 0, 0);
          qb.quad(W(-1.98, 1.25, -0.12), mul(Z, 0.55), [0, 1.05, 0], mul(X, -1), 0, 0, 0, 0);
        }
        const m = new THREE.Mesh(qb.build(), glassMat);
        m.renderOrder = 2;
        objs.push(m);
      }
      if (t.ads.length) {
        const qb = new QuadBuilder();
        const uvOf = (cell) => {
          const col = cell % 4,
            row = Math.floor(cell / 4);
          return [col * 0.25, 1 - ((row + 1) * POSTER_H) / 1024, (col + 1) * 0.25, 1 - (row * POSTER_H) / 1024];
        };
        for (const a of t.ads) {
          const co = Math.cos(a.yaw),
            si = Math.sin(a.yaw);
          if (a.type === 'panel') {
            const W = (lx, ly, lz) => [a.x + lx * co + lz * si, a.y + ly, a.z - lx * si + lz * co];
            const [u0, v0, u1, v1] = uvOf(a.cell),
              [w0, x0, w1, x1] = uvOf((a.cell + 5) % POSTERS.length);
            qb.quad(W(2.062, 1.2, -0.05), [-si * 0.58, 0, -co * 0.58], [0, 0.88, 0], [co, 0, -si], u0, v0, u1, v1);
            qb.quad(W(1.898, 1.2, -0.05), [si * 0.58, 0, co * 0.58], [0, 0.88, 0], [-co, 0, si], w0, x0, w1, x1);
          } else {
            const R = 0.605,
              N = 24,
              step = (Math.PI * 2) / N;
            for (let k = 0; k < N; k++) {
              const am = a.yaw + (k + 0.5) * step,
                sa = Math.sin(am),
                ca = Math.cos(am);
              const Rc = R * Math.cos(step / 2),
                hwid = R * Math.sin(step / 2);
              const [u0, v0, u1, v1] = uvOf((a.cell + Math.floor(k / 8)) % POSTERS.length);
              const j = k % 8;
              qb.quad(
                [a.x + sa * Rc, a.y + 1.44, a.z + ca * Rc],
                [ca * hwid, 0, -sa * hwid],
                [0, 1.1, 0],
                [sa, 0, ca],
                u0 + ((u1 - u0) * j) / 8,
                v0,
                u0 + ((u1 - u0) * (j + 1)) / 8,
                v1,
              );
            }
          }
        }
        const m = new THREE.Mesh(qb.build(), adMat);
        m.receiveShadow = true;
        objs.push(m);
      }
      for (const o of objs) {
        if (!o.isBatchedMesh) {
          o.receiveShadow = true;
          stats.meshes++;
          stats.tris += o.geometry.index.count / 3;
        }
        scene.add(o);
      }
      tiles.push({ objs, minx: t.minx - 3, maxx: t.maxx + 3, minz: t.minz - 3, maxz: t.maxz + 3 });
    }
    // static colliders (cheap primitives on one fixed body)
    const fb = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    for (const cd of this.colliders) {
      if (cd[0] === 'c') {
        const [, x, y, z, r, hh] = cd;
        world.createCollider(RAPIER.ColliderDesc.cylinder(hh, r).setTranslation(x, y, z), fb);
      } else {
        const [, x, y, z, yaw, hx, hy, hz] = cd;
        q.setFromAxisAngle(UP, yaw);
        world.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(x, y, z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }), fb);
      }
    }
    this.count.colliders = this.colliders.length;
    this.count.names = names.length;
    Object.assign(this.count, { tiles: tiles.length, ...stats });
    return { tiles, signMat, adMat };
  }
}
