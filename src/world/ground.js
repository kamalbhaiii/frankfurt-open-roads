/**
 * Ground plane with the river cut out, sandstone quay walls with granite coping, paved
 * footpaths and pedestrian zones (Kopfsteinpflaster in the Altstadt), carriageways/pavements/
 * markings (via streets.js), bridges (decks, piers, railings) and rail/tram lines.
 * OWNER: streets & ground agent. Entry point: buildGround(data, phys) -> {river, smallWater, bridgeColliders}.
 */
import * as THREE from 'three';
import { ctx } from '../core/context.js';
import { RC, roadWidth, BED_Y, WATER_Y } from '../core/config.js';
import { area, pip, openRing, offsetLine } from '../core/math.js';
import { GeoBuilder, addFlatPoly, addBox } from './geometry.js';
import { surfaceMaterial, railMaterial, railingMaterial } from './materials.js';
import { buildStreets, TileBuckets, quadN, strip as addRibbon } from './streets.js';

/** Altstadt (Römerberg / Alte Nikolaikirche): cobbled lanes and squares. */
function altstadtZone(data) {
  const n = (data.names || []).find((p) => /Nikolaikirche/.test(p.name));
  const c = n ? { x: n.x + 40, z: n.z - 35 } : { x: 645, z: 95 };
  return (x, z) => Math.hypot(x - c.x, z - c.z) < 200;
}

export function buildGround(data, phys) {
  const scene = ctx.scene;
  const mats = ctx.mats;
  const bridgeColliders = [];
  const isRiver = (r) => r.length > 6 && Math.abs(area(r)) > 30000;
  const river = data.water.filter(isRiver).map(openRing);
  const smallWater = data.water.filter((r) => !isRiver(r)).map(openRing);
  ctx.riverRings = river;
  const inAltstadt = altstadtZone(data);
  const white = new THREE.Color(1, 1, 1);

  // ---- ground: small grey paving (courtyards, plazas) with macro variation
  const E = 4200;
  const gGround = new GeoBuilder();
  addFlatPoly(
    gGround,
    [
      [-E, -E],
      [E, -E],
      [E, E],
      [-E, E],
    ],
    0,
    white,
    river,
  );
  const groundGeo = gGround.build();
  mats.ground = surfaceMaterial('slabs', { scale: 1.8, tint: 0xc4c2be, rough: [0.75, 0.97], bomb: 'patch', macro: 0.16, puddles: 0.7 });
  const ground = new THREE.Mesh(groundGeo, mats.ground);
  ground.receiveShadow = true;
  scene.add(ground);
  phys.push(groundGeo);

  // ---- quay walls: Main sandstone (uv = metres along / up), darker wet band at the waterline, granite coping
  const gw = new GeoBuilder(),
    gCope = new GeoBuilder();
  for (const r of river) {
    const ring = area(r) < 0 ? r.slice().reverse() : r;
    // which side of the edges is water? (majority vote over a few edges)
    let vote = 0;
    for (let i = 0; i < ring.length && i < 40; i += 2) {
      const a = ring[i],
        c = ring[(i + 1) % ring.length];
      const L = Math.hypot(c[0] - a[0], c[1] - a[1]) || 1;
      const nx = -(c[1] - a[1]) / L,
        nz = (c[0] - a[0]) / L;
      vote += pip((a[0] + c[0]) / 2 + nx * 0.6, (a[1] + c[1]) / 2 + nz * 0.6, r) ? 1 : -1;
    }
    const land = vote >= 0 ? -1 : 1; // multiply the normal by this to point inland
    let s = 0;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i],
        c = ring[(i + 1) % ring.length];
      const dx = c[0] - a[0],
        dz = c[1] - a[1],
        L = Math.hypot(dx, dz);
      if (L < 0.05) continue;
      const nx = -dz / L,
        nz = dx / L;
      quadN(
        gw,
        [
          [a[0], BED_Y, a[1]],
          [c[0], BED_Y, c[1]],
          [c[0], 0, c[1]],
          [a[0], 0, a[1]],
        ],
        [-nx * land, 0, -nz * land],
        white,
        [
          [s, BED_Y],
          [s + L, BED_Y],
          [s + L, 0],
          [s, 0],
        ],
      );
      const ix = nx * land * 0.55,
        iz = nz * land * 0.55;
      quadN(
        gCope,
        [
          [a[0], 0.025, a[1]],
          [c[0], 0.025, c[1]],
          [c[0] + ix, 0.025, c[1] + iz],
          [a[0] + ix, 0.025, a[1] + iz],
        ],
        [0, 1, 0],
        white,
        [
          [s, 0],
          [s + L, 0],
          [s + L, 0.55],
          [s, 0.55],
        ],
      );
      s += L;
    }
  }
  const wallGeo = gw.build();
  const wallMat = surfaceMaterial('sandstone', {
    scale: 4,
    uv: 'attr',
    tint: 0xd9b8a4,
    rough: [0.7, 0.98],
    bomb: 'none',
    macro: 0.12,
    side: THREE.DoubleSide,
    wetDark: 0.7,
    frag: `{ float wl = ${WATER_Y.toFixed(2)};
  float band = smoothstep(wl + 1.6, wl + 0.2, vWp.y);
  col *= mix(1.0, 0.55, band); col = mix(col, col * vec3(0.75, 0.85, 0.7), smoothstep(wl + 0.4, wl - 0.4, vWp.y));
  col *= 1.0 - 0.25 * smoothstep(0.6, 0.9, vn(vec2(vSUv.x * 0.7, vWp.y * 0.15))) * band; }`,
  });
  const wallMesh = new THREE.Mesh(wallGeo, wallMat);
  wallMesh.receiveShadow = true;
  scene.add(wallMesh);
  phys.push(wallGeo);
  const copeMat = surfaceMaterial('granite', { scale: 3, uv: 'attr', tint: 0xcfcac4, rough: [0.55, 0.85], bomb: 'none', offset: [-2, -4] });
  const cope = new THREE.Mesh(gCope.build(), copeMat);
  cope.receiveShadow = true;
  scene.add(cope);

  // ---- footpaths and pedestrian zones (ribbons), cobbles on Altstadt lanes
  mats.cobble = surfaceMaterial('cobble', { scale: 1.2, tint: 0xc8c6c2, rough: [0.55, 0.95], bomb: 'free', macro: 0.14, puddles: 1, wetDark: 0.55, offset: [-2, -4] });
  mats.ped = mats.path = surfaceMaterial('slabs', { scale: 1.8, vertexColors: true, tint: 0xd2d0cc, rough: [0.7, 0.95], bomb: 'patch', macro: 0.1, puddles: 0.6, offset: [-1, -2] });
  const bCob = new TileBuckets(),
    bPath = new TileBuckets();
  const cRed = new THREE.Color(0.95, 0.5, 0.42),
    cGrey = new THREE.Color(0.95, 0.93, 0.9);

  // car-road nodes, to trim cobble overlays where they meet asphalt roads
  const nk = (p) => `${Math.round(p[0] * 2)},${Math.round(p[1] * 2)}`;
  const isCob = (r) => [6, 7, 8].includes(r.c) && !r.bridge && inAltstadt(r.pts[0][0], r.pts[0][1]) && inAltstadt(r.pts.at(-1)[0], r.pts.at(-1)[1]);
  const asphaltAt = new Map();
  for (const r of data.roads) {
    if (r.pts.length < 2 || RC[r.c][1] !== 0 || isCob(r)) continue;
    for (const p of [r.pts[0], r.pts.at(-1)]) asphaltAt.set(nk(p), Math.max(asphaltAt.get(nk(p)) || 0, roadWidth(r)));
  }
  const trimLine = (pts, t0, t1) => {
    const cut = (p, t) => {
      // drop t metres from the start of p
      const o = [];
      let acc = 0;
      for (let i = 0; i < p.length - 1; i++) {
        const a = p[i],
          b = p[i + 1];
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (!o.length && acc + L > t) {
          const k = (t - acc) / (L || 1);
          o.push([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k]);
        }
        if (o.length) o.push(b);
        acc += L;
      }
      return o;
    };
    let p = t0 ? cut(pts, t0) : pts;
    if (t1 && p.length >= 2) p = cut(p.slice().reverse(), t1).reverse();
    return p;
  };

  for (const r of data.roads) {
    if (r.pts.length < 2) continue;
    const w = roadWidth(r),
      kind = RC[r.c][1];
    const x = r.pts[0][0],
      z = r.pts[0][1];
    if (kind === 0) {
      if (isCob(r)) {
        const p = trimLine(r.pts, (asphaltAt.get(nk(r.pts[0])) || 0) / 2, (asphaltAt.get(nk(r.pts.at(-1))) || 0) / 2);
        if (p.length >= 2) addRibbon(bCob.at(x, z), p, w, 0.04, white);
      }
      continue;
    }
    if (r.c === 8) continue;
    if (r.c === 9) addRibbon((inAltstadt(x, z) && !r.bridge ? bCob : bPath).at(x, z), r.pts, w, 0.03, white);
    else if (r.c === 11) addRibbon(bPath.at(x, z), r.pts, w, 0.032, cRed);
    else if (r.c === 12) addRibbon(bPath.at(x, z), r.pts, w, 0.031, cGrey);
    else addRibbon((inAltstadt(x, z) && !r.bridge ? bCob : bPath).at(x, z), r.pts, w, 0.03, white);
  }
  bCob.emit(mats.cobble);
  bPath.emit(mats.path);

  buildStreets(data, phys);

  // ---- bridges: decks (sandstone road bridges / steel footbridges), piers, coping + railings
  const bDeck = new GeoBuilder(),
    bSteel = new GeoBuilder(),
    bCope = new GeoBuilder(),
    bRail = new GeoBuilder(),
    bLattice = new GeoBuilder();
  const overRiver = (x, z) => river.some((r) => pip(x, z, r));
  const piers = [];
  const addBridge = (pts, w, foot) => {
    let run = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i],
        b = pts[i + 1];
      const mx = (a[0] + b[0]) / 2,
        mz = (a[1] + b[1]) / 2;
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (L < 0.2) continue;
      if (!(overRiver(mx, mz) || overRiver(a[0], a[1]) || overRiver(b[0], b[1]))) continue;
      const yaw = Math.atan2(b[0] - a[0], b[1] - a[1]);
      const fx = (b[0] - a[0]) / L,
        fz = (b[1] - a[1]) / L;
      const bw = w / 2 + (w > 5 ? 2.6 : 0.4);
      addBox(foot ? bSteel : bDeck, mx, -0.6, mz, bw, 0.6, L / 2 + 0.6, yaw, white);
      bridgeColliders.push({ x: mx, y: -0.6, z: mz, hx: bw, hy: 0.6, hz: L / 2 + 0.6, yaw });
      // river piers every ~45 m (shared by parallel ways)
      for (let t = (45 - (run % 45)) % 45; t < L; t += 45) {
        const px = a[0] + fx * t,
          pz = a[1] + fz * t;
        if (!overRiver(px, pz) || piers.some((p) => Math.hypot(p[0] - px, p[1] - pz) < 22)) continue;
        piers.push([px, pz]);
        const hy = (-1.2 - BED_Y) / 2;
        addBox(bDeck, px, BED_Y + hy, pz, bw + 0.6, hy, foot ? 0.9 : 1.6, yaw, white);
        bridgeColliders.push({ x: px, y: BED_Y + hy, z: pz, hx: bw + 0.6, hy, hz: foot ? 0.9 : 1.6, yaw });
      }
      run += L;
      for (const s of [-1, 1]) {
        const ox = Math.cos(yaw) * s * (bw + 0.15),
          oz = -Math.sin(yaw) * s * (bw + 0.15);
        if (!overRiver(mx + ox, mz + oz)) continue;
        // collider keeps the old solid parapet volume; visuals: granite coping + steel railing
        bridgeColliders.push({ x: mx + ox, y: 0.7, z: mz + oz, hx: 0.2, hy: 0.55, hz: L / 2 + 0.3, yaw });
        addBox(bCope, mx + ox, 0.15, mz + oz, 0.22, 0.15, L / 2 + 0.3, yaw, white);
        const h0 = 0.3,
          h1 = foot ? 1.6 : 1.25;
        const ax = a[0] + ox - fx * 0.3,
          az = a[1] + oz - fz * 0.3,
          cx = b[0] + ox + fx * 0.3,
          cz = b[1] + oz + fz * 0.3;
        const u0 = run - L - 0.3,
          u1 = run + 0.3;
        quadN(
          foot ? bLattice : bRail,
          [
            [ax, h0, az],
            [cx, h0, cz],
            [cx, h1, cz],
            [ax, h1, az],
          ],
          [Math.cos(yaw) * s, 0, -Math.sin(yaw) * s],
          white,
          [
            [u0, 0],
            [u1, 0],
            [u1, h1 - h0],
            [u0, h1 - h0],
          ],
        );
      }
    }
  };
  for (const r of data.roads) if (r.bridge) addBridge(r.pts, roadWidth(r), RC[r.c][1] === 1);
  for (const r of data.rails) if (r.bridge) addBridge(r.pts, r.tram ? 4 : 6, false);
  const deckMat = surfaceMaterial('sandstone', { uv: 'tri', scale: 4, tint: 0xd0ad98, rough: [0.7, 0.98], bomb: 'none', macro: 0.1 });
  const steelMat = new THREE.MeshStandardMaterial({ color: 0x4a5560, metalness: 0.6, roughness: 0.55 });
  const copeBrMat = surfaceMaterial('granite', { uv: 'tri', scale: 3, tint: 0xd2cec8, rough: [0.55, 0.85], bomb: 'none' });
  for (const [gb, m] of [
    [bDeck, deckMat],
    [bSteel, steelMat],
    [bCope, copeBrMat],
    [bRail, railingMaterial('rail', 0x3a4046)],
    [bLattice, railingMaterial('lattice', 0x5b6a72)],
  ]) {
    if (!gb.count) continue;
    const me = new THREE.Mesh(gb.build(), m);
    me.castShadow = me.receiveShadow = true;
    scene.add(me);
  }

  // ---- rail lines: ballast + sleepers for railways, granite-sett beds with grooved rails for trams
  const bBallast = new TileBuckets(),
    bTram = new TileBuckets(),
    bRails = new TileBuckets();
  const cHead = new THREE.Color(0.78, 0.78, 0.8),
    cGroove = new THREE.Color(0.02, 0.02, 0.02),
    cSide = new THREE.Color(0.35, 0.33, 0.31);
  const G = 0.7175; // half standard gauge
  for (const r of data.rails) {
    const x = r.pts[0][0],
      z = r.pts[0][1];
    const gr = bRails.at(x, z);
    if (r.tram) {
      addRibbon(bTram.at(x, z), r.pts, 2.7, 0.04, white);
      for (const s of [-1, 1]) {
        addRibbon(gr, offsetLine(r.pts, s * (G + 0.01)), 0.065, 0.047, cHead);
        addRibbon(gr, offsetLine(r.pts, s * (G - 0.04)), 0.036, 0.047, cGroove);
        addRibbon(gr, offsetLine(r.pts, s * (G - 0.068)), 0.02, 0.047, cSide);
      }
    } else {
      addRibbon(bBallast.at(x, z), r.pts, 3.4, 0.028, white);
      for (const s of [-1, 1]) addRibbon(gr, offsetLine(r.pts, s * G), 0.075, 0.075, cHead);
    }
  }
  const ballastMat = surfaceMaterial(null, {
    uv: 'attr',
    scale: 1,
    rough: [0.9, 0.95],
    macro: 0.08,
    offset: [-1, -3],
    frag: `{ vec2 p = vSUv; float g = hh(floor(vWp.xz * 16.0)) * 0.55 + vn(vWp.xz * 3.0) * 0.45;
  col = mix(vec3(0.36, 0.33, 0.3), vec3(0.6, 0.57, 0.52), g);
  float sl = step(abs(fract(p.y / 0.6) - 0.5), 0.21) * step(abs(p.x - 0.5), 0.37);
  col = mix(col, vec3(0.52, 0.5, 0.48) * (0.85 + 0.15 * vn(vWp.xz * 4.0)), sl);
  col *= 1.0 - 0.25 * smoothstep(0.3, 0.5, abs(p.x - 0.5)); cavity = 1.0 - g; }`,
  });
  const tramMat = surfaceMaterial('granite', { uv: 'attr', scale: [0.6 / 2.7, 0.6], tint: 0xbab6b0, rough: [0.55, 0.9], bomb: 'none', macro: 0.1, puddles: 0.6, offset: [-2, -5] });
  bBallast.emit(ballastMat);
  bTram.emit(tramMat);
  bRails.emit(railMaterial(), { shadow: false });
  return { river, smallWater, bridgeColliders };
}
