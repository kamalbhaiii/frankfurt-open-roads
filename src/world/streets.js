/**
 * Street surfaces from the precomputed street data: textured asphalt carriageways,
 * raised kerbed pavements (concrete slabs + granite kerbstones), and German road markings
 * (StVO/RMS): centre and lane lines (3 m dash / 6 m gap), edge lines, red cycle lanes,
 * Haltlinien, turn arrows and Fußgängerfurten at signals, zebra crossings, plus manhole
 * covers, gullies and tyre wear. Meshes are merged per 500 m super tile.
 * OWNER: streets & ground agent. Entry point: buildStreets(data, phys).
 */
import * as THREE from 'three';
import { ctx } from '../core/context.js';
import { KERB, RC, roadWidth } from '../core/config.js';
import { area, hash, offsetLine } from '../core/math.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { GeoBuilder, addFlatPoly } from './geometry.js';
import { surfaceMaterial, markingMaterial, atlasUV } from './materials.js';

const SUPER = 750;
const tileKey = (x, z) => `${Math.floor(x / SUPER)},${Math.floor(z / SUPER)}`;

/** Lazily created GeoBuilders keyed by super tile. */
export class TileBuckets {
  constructor(extra = []) {
    this.map = new Map();
    this.extra = extra;
  }
  at(x, z) {
    const k = tileKey(x, z);
    if (!this.map.has(k)) this.map.set(k, new GeoBuilder(this.extra));
    return this.map.get(k);
  }
  /** Adds one mesh per non-empty tile; returns the geometries (for physics). */
  emit(material, { shadow = true, order = 0 } = {}) {
    const out = [];
    for (const gb of this.map.values()) {
      if (!gb.count) continue;
      const geo = gb.build();
      const m = new THREE.Mesh(geo, material);
      m.receiveShadow = shadow;
      m.renderOrder = order;
      ctx.scene.add(m);
      out.push(geo);
    }
    return out;
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

/** Quad (4 points [x,y,z]) wound so its front face points along n. */
export function quadN(gb, P, n, col, UV, ex) {
  const ids = P.map((p, i) => gb.v(p[0], p[1], p[2], n[0], n[1], n[2], col, UV ? UV[i][0] : 0, UV ? UV[i][1] : 0, ex));
  const ax = P[1][0] - P[0][0],
    ay = P[1][1] - P[0][1],
    az = P[1][2] - P[0][2];
  const bx = P[2][0] - P[0][0],
    by = P[2][1] - P[0][1],
    bz = P[2][2] - P[0][2];
  const cx = ay * bz - az * by,
    cy = az * bx - ax * bz,
    cz = ax * by - ay * bx;
  if (cx * n[0] + cy * n[1] + cz * n[2] >= 0) {
    gb.tri(ids[0], ids[1], ids[2]);
    gb.tri(ids[0], ids[2], ids[3]);
  } else {
    gb.tri(ids[0], ids[2], ids[1]);
    gb.tri(ids[0], ids[3], ids[2]);
  }
}

// ---------------------------------------------------------------- decal helpers

const Y_DEC = 0.045;
const WHITE = new THREE.Color(0.93, 0.93, 0.9);
const RED = new THREE.Color(0.6, 0.17, 0.13);
const BLACK = new THREE.Color(0, 0, 0);
const IRON = new THREE.Color(1, 1, 1);

/** Flat decal centred at (cx, cz), long axis (len) along unit f, cell v runs along f, u along the right side. */
function decal(gb, cx, cz, fx, fz, len, wid, cell, col, op, wear, y = Y_DEC) {
  const rx = -fz,
    rz = fx;
  const [u0, v0, u1, v1] = atlasUV(cell);
  const hl = len / 2,
    hw = wid / 2;
  const P = [
    [cx - fx * hl - rx * hw, y, cz - fz * hl - rz * hw],
    [cx - fx * hl + rx * hw, y, cz - fz * hl + rz * hw],
    [cx + fx * hl + rx * hw, y, cz + fz * hl + rz * hw],
    [cx + fx * hl - rx * hw, y, cz + fz * hl - rz * hw],
  ];
  quadN(
    gb,
    P,
    [0, 1, 0],
    col,
    [
      [u0, v0],
      [u1, v0],
      [u1, v1],
      [u0, v1],
    ],
    { aDec: [op, wear] },
  );
}

/** Ribbon decal along a polyline; cell 'solid' for paint, 'tyre' maps u across the ribbon. */
function ribbonDecal(gb, pts, w, cell, col, op, wear, y = Y_DEC) {
  const [u0, v0, u1, v1] = atlasUV(cell);
  const vm = (v0 + v1) / 2;
  const um = (u0 + u1) / 2;
  const across = cell !== 'solid';
  strip(gb, pts, w, y, col, (side) => [across ? (side ? u1 : u0) : um, vm], { aDec: [op, wear] });
}

/**
 * Upward-facing flat ribbon along a polyline (mitred joints).
 * uvOf(side, dist) -> [u, v]; default u = 0..1 across, v = metres along.
 */
export function strip(gb, pts, w, y, col, uvOf = (side, d) => [side, d], ex) {
  if (pts.length < 2) return;
  const h = w / 2;
  let dist = 0;
  let pl = -1,
    pr = -1;
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
      const l1 = Math.hypot(p[0] - a[0], p[1] - a[1]) || 1;
      m = 1 / Math.max(0.5, ((p[0] - a[0]) / l1) * dx + ((p[1] - a[1]) / l1) * dz);
    }
    const rx = -dz * h * m,
      rz = dx * h * m;
    if (i > 0) dist += Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]);
    const L = gb.v(p[0] - rx, y, p[1] - rz, 0, 1, 0, col, ...uvOf(0, dist), ex);
    const R = gb.v(p[0] + rx, y, p[1] + rz, 0, 1, 0, col, ...uvOf(1, dist), ex);
    if (pl >= 0) {
      gb.tri(pl, pr, L);
      gb.tri(pr, R, L);
    }
    pl = L;
    pr = R;
  }
}

/** Cumulative distances of a polyline. */
function cumul(pts) {
  const c = [0];
  for (let i = 1; i < pts.length; i++) c.push(c[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return c;
}
function at(pts, cum, s) {
  let i = 1;
  while (i < pts.length - 1 && cum[i] < s) i++;
  const t = Math.min(1, Math.max(0, (s - cum[i - 1]) / (cum[i] - cum[i - 1] || 1)));
  const a = pts[i - 1],
    b = pts[i];
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  return { x: a[0] + (b[0] - a[0]) * t, z: a[1] + (b[1] - a[1]) * t, fx: (b[0] - a[0]) / L, fz: (b[1] - a[1]) / L };
}
/** Part of a polyline between distances s0..s1. */
function sub(pts, cum, s0, s1) {
  const o = [];
  const p0 = at(pts, cum, s0);
  o.push([p0.x, p0.z]);
  for (let i = 1; i < pts.length - 1; i++) if (cum[i] > s0 && cum[i] < s1) o.push(pts[i]);
  const p1 = at(pts, cum, s1);
  o.push([p1.x, p1.z]);
  return o;
}

// ---------------------------------------------------------------- road classes

const isCar = (r) => RC[r.c][1] === 0;
const isMarked = (r) => [2, 3, 4, 5, 14, 15, 16, 17, 18].includes(r.c);
const isKerbed = (r) => r.c <= 6 || (r.c >= 14 && r.c <= 18);

/** Lane layout of a road (offsets from the centre line, positive = right of travel). */
function layout(r) {
  const w = roadWidth(r);
  const oneway = !!r.oneway;
  const dirW = oneway ? w : w / 2;
  const lanesDir = r.lanes ? Math.max(1, oneway ? r.lanes : Math.round(r.lanes / 2)) : Math.max(1, Math.floor(dirW / 3.6));
  const bike = isMarked(r) && !r.bridge && r.c <= 4 && oneway && dirW - lanesDir * 3.0 >= 1.75 ? 1.6 : 0;
  return { w, oneway, dirW, lanesDir, bike };
}

export function buildStreets(data, phys) {
  const { streets, mats } = ctx;
  const q = ctx.quality || 'high';
  const detail = q !== 'low';

  // ---- materials
  mats.asphalt = surfaceMaterial('asphalt', {
    scale: 3.6,
    tint: 0xbfc0c4,
    rough: [0.62, 0.95],
    macro: 0.1,
    puddles: 1,
    wetDark: 0.5,
    offset: [-1, -2],
    // repair patches with a dark bitumen seam, slightly fresher (darker) asphalt
    frag: `{ float pv = vn(vWp.xz * 0.075 + 40.0) * 0.7 + vn(vWp.xz * 0.6) * 0.3;
  float patchM = smoothstep(0.735, 0.745, pv) * step(0.55, vn(vWp.xz * 0.012 + 9.0));
  float seam = smoothstep(0.012, 0.0, abs(pv - 0.74)) * step(0.55, vn(vWp.xz * 0.012 + 9.0));
  col *= mix(1.0, 0.8, patchM); col *= mix(1.0, 0.72, seam); rgh = mix(rgh, 0.97, patchM * 0.5);
  cavity = max(cavity, patchM * 0.6); }`,
  });
  mats.pave = surfaceMaterial('slabs', { scale: 1.8, tint: 0xd2d0cc, rough: [0.7, 0.95], bomb: 'patch', macro: 0.1, puddles: 0.6, offset: [-1, -2] });
  mats.kerb = surfaceMaterial('granite', { scale: 3, uv: 'attr', tint: 0xd8d6d2, rough: [0.55, 0.85], bomb: 'none', macro: 0.06, offset: [-2, -3] });
  mats.mark = markingMaterial();

  // ---- carriageways
  const roadB = new TileBuckets();
  for (const tile of streets.road) {
    for (const poly of tile) {
      const rs = decRings(poly);
      addFlatPoly(roadB.at(rs[0][0][0], rs[0][0][1]), rs[0], 0.035, WHITE, rs.slice(1));
    }
  }
  roadB.emit(mats.asphalt);

  // ---- raised pavements with granite kerbstones (vertical face, small bevel, top strip)
  const paveB = new TileBuckets(),
    kerbB = new TileBuckets();
  const white = new THREE.Color(1, 1, 1);
  const BEV = 0.02,
    KW = 0.18;
  for (const tile of streets.walk) {
    for (const poly of tile) {
      const rs = decRings(poly);
      const x0 = rs[0][0][0],
        z0 = rs[0][0][1];
      addFlatPoly(paveB.at(x0, z0), rs[0], KERB, white, rs.slice(1));
      const gk = kerbB.at(x0, z0);
      rs.forEach((ring, ri) => {
        const sg = (ri ? -1 : 1) * Math.sign(area(ring));
        let s = 0;
        for (let i = 0; i < ring.length; i++) {
          const a = ring[i],
            b = ring[(i + 1) % ring.length];
          const dx = b[0] - a[0],
            dz = b[1] - a[1],
            L = Math.hypot(dx, dz);
          if (L < 0.05) continue;
          const nx = (sg * dz) / L,
            nz = (-sg * dx) / L; // outward, towards the carriageway
          const s1 = s + L;
          const yb = KERB - BEV;
          quadN(
            gk,
            [
              [a[0], 0, a[1]],
              [b[0], 0, b[1]],
              [b[0], yb, b[1]],
              [a[0], yb, a[1]],
            ],
            [nx, 0, nz],
            white,
            [
              [s, 0],
              [s1, 0],
              [s1, yb],
              [s, yb],
            ],
          );
          const bx = -nx * BEV,
            bz = -nz * BEV,
            k = Math.SQRT1_2;
          quadN(
            gk,
            [
              [a[0], yb, a[1]],
              [b[0], yb, b[1]],
              [b[0] + bx, KERB + 0.003, b[1] + bz],
              [a[0] + bx, KERB + 0.003, a[1] + bz],
            ],
            [nx * k, k, nz * k],
            white,
            [
              [s, yb],
              [s1, yb],
              [s1, KERB + 0.02],
              [s, KERB + 0.02],
            ],
          );
          const kx = -nx * KW,
            kz = -nz * KW;
          quadN(
            gk,
            [
              [a[0] + bx, KERB + 0.003, a[1] + bz],
              [b[0] + bx, KERB + 0.003, b[1] + bz],
              [b[0] + kx, KERB + 0.003, b[1] + kz],
              [a[0] + kx, KERB + 0.003, a[1] + kz],
            ],
            [0, 1, 0],
            white,
            [
              [s, 0.2],
              [s1, 0.2],
              [s1, 0.2 + KW],
              [s, 0.2 + KW],
            ],
          );
          s = s1;
        }
      });
    }
  }
  for (const g of paveB.emit(mats.pave)) phys.push(g);
  for (const g of kerbB.emit(mats.kerb)) phys.push(g);

  buildMarkings(data, detail);
}

// ---------------------------------------------------------------- markings

function buildMarkings(data, detail) {
  const { streets, mats } = ctx;
  const dec = new TileBuckets([['aDec', 2]]);
  const tyres = new TileBuckets([['aDec', 2]]);
  const roads = data.roads.filter((r) => r.pts.length >= 2 && isCar(r));

  // junction nodes: endpoints shared by 3+ car ways get the lines trimmed back
  const nk = (p) => `${Math.round(p[0] * 2)},${Math.round(p[1] * 2)}`;
  const nodes = new Map();
  for (const r of roads) {
    for (const end of [0, 1]) {
      const p = end ? r.pts[r.pts.length - 1] : r.pts[0];
      const k = nk(p);
      if (!nodes.has(k)) nodes.set(k, { ends: [], maxW: 0, signal: false });
      const n = nodes.get(k);
      n.ends.push({ r, end });
      n.maxW = Math.max(n.maxW, roadWidth(r));
    }
  }
  for (const s of streets.signals) {
    const n = nodes.get(nk([s.x, s.z]));
    if (n) n.signal = true;
  }
  const trimAt = (p) => {
    const n = nodes.get(nk(p));
    if (!n || n.ends.length < 3) return 0;
    return n.signal ? Math.min(n.maxW / 2 + 4, 14) + 0.6 : n.maxW / 2 + 1.5;
  };

  // crossings (zebras) block lines nearby
  const crossGrid = new Map();
  const cg = (x, z) => `${Math.floor(x / 40)},${Math.floor(z / 40)}`;
  for (const c of streets.cross) {
    const k = cg(c[0], c[1]);
    if (!crossGrid.has(k)) crossGrid.set(k, []);
    crossGrid.get(k).push(c);
  }
  const nearCross = (x, z, d) => {
    const gx = Math.floor(x / 40),
      gz = Math.floor(z / 40);
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++) for (const c of crossGrid.get(`${gx + i},${gz + j}`) || []) if (Math.hypot(c[0] - x, c[1] - z) < d) return true;
    return false;
  };

  /** Draws a (dashed) line at lateral offset o between trimmed distances. */
  const line = (pts, o, from, to, width, dash, gap, col = WHITE, op = 0.95, wear = 0.55) => {
    const lp = o ? offsetLine(pts, o) : pts;
    const cum = cumul(lp);
    const scale = cum[cum.length - 1] / (cumul(pts).at(-1) || 1);
    const a = from * scale,
      b = to * scale;
    if (b - a < 1) return;
    const step = dash + gap;
    for (let s = a; s < b; s += gap ? step : b - a) {
      const e = Math.min(b, s + (gap ? dash : b - a));
      if (e - s < 0.3) continue;
      const mid = at(lp, cum, (s + e) / 2);
      if (nearCross(mid.x, mid.z, gap ? 3.2 : 2.6)) {
        if (!gap) {
          // split solid lines around crossings
          for (let t = s; t < e; t += 4) {
            const tt = Math.min(e, t + 4);
            const m2 = at(lp, cum, (t + tt) / 2);
            if (!nearCross(m2.x, m2.z, 2.6)) ribbonDecal(dec.at(m2.x, m2.z), sub(lp, cum, t, tt), width, 'solid', col, op, wear);
          }
        }
        continue;
      }
      ribbonDecal(dec.at(mid.x, mid.z), sub(lp, cum, s, e), width, 'solid', col, op, wear);
    }
  };

  for (const r of roads) {
    const pts = r.pts;
    const cum = cumul(pts);
    const len = cum[cum.length - 1];
    const from = trimAt(pts[0]),
      to = len - trimAt(pts[pts.length - 1]);
    if (to - from < 2) continue;
    const L = layout(r);
    const { w, oneway, dirW, lanesDir, bike } = L;
    const h = hash(Math.round(pts[0][0] * 7 + pts[0][1] * 13));

    // tyre wear bands along every lane (medium+)
    if (detail && r.c !== 7) {
      const lanes = [];
      if (oneway) for (let i = 0; i < lanesDir; i++) lanes.push(-w / 2 + ((i + 0.5) * (w - bike)) / lanesDir);
      else
        for (let i = 0; i < lanesDir; i++) {
          const o = ((i + 0.5) * (dirW - bike)) / lanesDir;
          lanes.push(o, -o);
        }
      for (const o of lanes) {
        const lp = offsetLine(pts, o);
        const lc = cumul(lp);
        const f = from * (lc.at(-1) / len),
          t = to * (lc.at(-1) / len);
        for (let s = f; s < t; s += 40) {
          const e = Math.min(t, s + 40);
          const m = at(lp, lc, (s + e) / 2);
          ribbonDecal(tyres.at(m.x, m.z), sub(lp, lc, s, e), 2.4, 'tyre', BLACK, 0.3, 0, Y_DEC - 0.002);
        }
      }
    }

    if (isMarked(r)) {
      // centre line: solid (Fahrstreifenbegrenzung) on primary roads, else broken (Leitlinie 3 m / 6 m)
      if (!oneway && w >= 7) {
        if (r.c === 2 || r.c === 14) line(pts, 0, from, to, 0.15, 0, 0);
        else line(pts, 0, from, to, 0.12, 3, 6);
      }
      // lane separators
      if (lanesDir >= 2) {
        const left = oneway ? -w / 2 : 0,
          right = dirW - bike - (oneway ? w / 2 : 0);
        for (let i = 1; i < lanesDir; i++) {
          const o = oneway ? left + ((right - left) * i) / lanesDir : ((dirW - bike) * i) / lanesDir;
          line(pts, o, from, to, 0.12, 3, 6);
          if (!oneway) line(pts, -o, from, to, 0.12, 3, 6);
        }
      }
      // red cycle lane (Radfahrstreifen) with a Breitstrich and pictograms
      if (bike) {
        const inner = w / 2 - 0.3 - bike;
        const lp = offsetLine(pts, w / 2 - 0.3 - bike / 2);
        const lc = cumul(lp);
        const k = lc.at(-1) / len;
        for (let s = from * k; s < to * k; s += 30) {
          const e = Math.min(to * k, s + 30);
          const m = at(lp, lc, (s + e) / 2);
          ribbonDecal(dec.at(m.x, m.z), sub(lp, lc, s, e), bike, 'solid', RED, 0.82, 0.35, Y_DEC - 0.001);
        }
        line(pts, inner - 0.125, from, to, 0.25, 0, 0);
        for (let s = from * k + 6; s < to * k - 3; s += 55) {
          const m = at(lp, lc, s);
          decal(dec.at(m.x, m.z), m.x, m.z, m.fx, m.fz, 1.5, 1.2, 'bike', WHITE, 0.95, 0.5);
        }
      } else if (r.c === 2 && w >= 10) {
        // edge lines on wide main roads
        line(pts, w / 2 - 0.4, from, to, 0.12, 0, 0);
        if (!oneway) line(pts, -(w / 2 - 0.4), from, to, 0.12, 0, 0);
        else line(pts, -(w / 2 - 0.4), from, to, 0.12, 0, 0);
      }
    }

    // street furniture in the asphalt: manhole covers, valve caps, gullies (medium+)
    if (detail && !r.bridge && r.c !== 7) {
      let s = from + 8 + h * 25;
      let i = 0;
      while (s < to - 4) {
        const hs = hash(i * 31 + Math.round(s) + Math.round(pts[0][0]));
        const lane = oneway ? 0 : ((hs < 0.5 ? 1 : -1) * dirW) / 2;
        const o = hs > 0.8 ? 0 : lane;
        const lp = o ? offsetLine(pts, o) : pts;
        const m = at(lp, cumul(lp), s * (cumul(lp).at(-1) / len));
        if (!nearCross(m.x, m.z, 3)) decal(dec.at(m.x, m.z), m.x, m.z, m.fx, m.fz, 0.8, 0.8, 'manhole', IRON, 1, 0);
        if (hs > 0.55) {
          const side = hs > 0.77 ? 1 : -1;
          const vp = at(pts, cum, Math.min(to, s + 7));
          const vx = vp.x - vp.fz * side * (w / 2 - 0.7),
            vz = vp.z + vp.fx * side * (w / 2 - 0.7);
          decal(dec.at(vx, vz), vx, vz, vp.fx, vp.fz, 0.24, 0.24, 'valve', IRON, 1, 0);
        }
        s += 38 + hs * 34;
        i++;
      }
      if (isKerbed(r)) {
        for (const side of oneway || w < 6 ? [1, -1] : [1, -1]) {
          for (let g = from + 4 + h * 10; g < to - 2; g += 24 + hash(g * 3.1) * 10) {
            const p = at(pts, cum, g);
            const gx = p.x - p.fz * side * (w / 2 - 0.22),
              gz = p.z + p.fx * side * (w / 2 - 0.22);
            if (nearCross(gx, gz, 3)) continue;
            // long side along the kerb, slots across it
            decal(dec.at(gx, gz), gx, gz, -p.fz, p.fx, 0.34, 0.52, 'gully', IRON, 1, 0);
          }
        }
      }
    }
  }

  // ---- signalised junctions: Haltlinie, Fußgängerfurt, turn arrows
  for (const s of streets.signals) {
    const n = nodes.get(nk([s.x, s.z]));
    const legs = s.a.map((a) => [-Math.sin(a[1]), -Math.cos(a[1])]); // outward directions
    for (const a of s.a) {
      const [, ang, , , s0x, s0z, s1x, s1z] = a;
      const fx = Math.sin(ang),
        fz = Math.cos(ang); // into the junction
      const rx = -fz,
        rz = fx;
      const SL = Math.hypot(s1x - s0x, s1z - s0z) || 1;
      ribbonDecal(
        dec.at(s0x, s0z),
        [
          [s0x, s0z],
          [s1x, s1z],
        ],
        0.4,
        'solid',
        WHITE,
        0.95,
        0.45,
      );
      // matching road (outward end at this node)
      let road = null,
        best = -2;
      for (const e of n?.ends || []) {
        const p = e.end ? e.r.pts.slice().reverse() : e.r.pts;
        const dx = p[1][0] - p[0][0],
          dz = p[1][1] - p[0][1],
          l = Math.hypot(dx, dz) || 1;
        const d = (-fx * dx - fz * dz) / l;
        if (d > best) {
          best = d;
          road = e.r;
        }
      }
      const L = road ? layout(road) : { w: 2 * SL + 1, oneway: false, dirW: SL + 0.5, lanesDir: 1, bike: 0 };
      // centre of the road at the stop line
      const cx = s1x - rx * (L.w / 2 - 0.3),
        cz = s1z - rz * (L.w / 2 - 0.3);
      // pedestrian Furt: two broken lines across the whole carriageway just past the stop line
      for (const dd of [0.7, 3.7]) {
        const px = cx + fx * dd,
          pz = cz + fz * dd;
        const half = L.w / 2 - 0.3;
        for (let t = -half; t < half - 0.3; t += 0.7) {
          const mx = px + rx * (t + 0.25),
            mz = pz + rz * (t + 0.25);
          decal(dec.at(mx, mz), mx, mz, rx, rz, 0.5, 0.15, 'solid', WHITE, 0.95, 0.5);
        }
      }
      // turn arrows
      const moves = new Set();
      for (const [ex, ez] of legs) {
        if (Math.abs(ex + fx) + Math.abs(ez + fz) < 0.05) continue; // our own leg
        const dot = ex * fx + ez * fz,
          side = ex * rx + ez * rz;
        if (dot > 0.8) moves.add('S');
        else if (dot > -0.6) moves.add(side > 0 ? 'R' : 'L');
      }
      if (!moves.size) continue;
      const n2 = L.lanesDir;
      const left = L.oneway ? -L.w / 2 : 0,
        right = L.dirW - L.bike - (L.oneway ? L.w / 2 : 0);
      const types = [];
      if (n2 === 1) {
        if (moves.size === 3) continue;
        types.push(moves.has('S') ? (moves.has('L') ? 'SL' : moves.has('R') ? 'SR' : 'S') : moves.has('L') ? 'L' : 'R');
      } else {
        for (let i = 0; i < n2; i++) {
          if (i === 0) types.push(moves.has('L') ? (n2 === 2 && moves.has('S') ? 'SL' : 'L') : 'S');
          else if (i === n2 - 1) types.push(moves.has('R') ? (moves.has('S') ? 'SR' : 'R') : 'S');
          else types.push('S');
        }
      }
      const roadLen = road ? cumul(road.pts).at(-1) : 30;
      for (let i = 0; i < n2; i++) {
        const o = left + ((i + 0.5) * (right - left)) / n2;
        for (const back of roadLen > 55 ? [4.5, 26] : roadLen > 20 ? [4.5] : []) {
          const ax = cx + rx * o - fx * back,
            az = cz + rz * o - fz * back;
          decal(dec.at(ax, az), ax, az, fx, fz, 5, 1.3, types[i], WHITE, 0.95, 0.5);
        }
      }
    }
  }

  // ---- zebra crossings (Zebrastreifen: 0.5 m stripes, 0.5 m gaps, 4 m long)
  for (const [x, z, ang, w] of streets.cross) {
    const dx = Math.sin(ang),
      dz = Math.cos(ang);
    const px = dz,
      pz = -dx;
    const n = Math.max(2, Math.floor((w - 0.6) / 1.0));
    for (let i = 0; i < n; i++) {
      const t = -((n - 1) * 1.0) / 2 + i * 1.0;
      decal(dec.at(x, z), x + px * t, z + pz * t, dx, dz, 4, 0.5, 'solid', WHITE, 0.97, 0.45);
    }
  }

  // one paint mesh per tile: tyre wear first so the paint draws over it
  for (const [k, gb] of dec.map) {
    const t = tyres.map.get(k);
    const parts = [t?.count ? t.build() : null, gb.count ? gb.build() : null].filter(Boolean);
    if (!parts.length) continue;
    const geo = parts.length > 1 ? mergeGeometries(parts) : parts[0];
    const me = new THREE.Mesh(geo, mats.mark);
    me.receiveShadow = true;
    me.renderOrder = 1;
    ctx.scene.add(me);
  }
}
