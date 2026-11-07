/**
 * Buildings: OSM footprints turned into recognisably German city blocks.
 * OWNER: buildings agent. Entry point: buildBuildings(data, phys, buildingIndex) -> landmarks.
 *
 * - Every building is classified by height, district and location into a facade style
 *   (Gründerzeit Altbau, 1950s, 1960s–70s ribbon blocks, modern, offices, glass towers,
 *   Altstadt half-timber, Gothic sandstone …) with a CC0 PBR wall material (plaster,
 *   red Main sandstone, brick, concrete, granite) and a tint.
 * - Walls are single quads; windows, frames, reveals, curtains, roller shutters, interiors,
 *   shop fronts and night lighting are drawn by the facade shader (no extra triangles).
 * - Roofs: pitched (gable / mansard, ridge parallel to the street, gable-to-street in the
 *   Altstadt, stepped gables on the Römer) where the footprint allows, else flat with a parapet.
 * - Landmarks: Messeturm pyramid, antenna masts (Main Tower, Commerzbank Tower), Commerzbank
 *   sky gardens, Westend Tower crown, Kaiserdom spire, church spires.
 * - Base geometry is merged into ~450 m chunks (one draw call each, also the static collider).
 *   Small details (cornices, dormers, chimneys, parapet caps, shop signs, awnings) live in
 *   225 m LOD chunks that are only drawn near the camera on medium+ quality.
 * Facade textures are packed into two texture arrays (colour, normal+roughness) so all
 * buildings still share one material.
 */
import * as THREE from 'three';
import { ctx } from '../core/context.js';
import { area, openRing, hash, pip, segDist } from '../core/math.js';
import { DISTRICTS, RC } from '../core/config.js';
import { assets } from '../core/assets.js';
import { uniforms } from './materials.js';

// ---------------------------------------------------------------- texture layers
/** [file prefix, tile size in metres] — index = layer id used by the shader. */
const LAYERS = [
  ['plaster', 2.0],
  ['sandstone', 3.0],
  ['brick', 1.0],
  ['concrete', 2.7],
  ['granite', 2.3],
  ['rooftiles', 2.6],
  ['slate', 2.2],
  ['flatroof', 2.1],
];
const L_PLASTER = 0,
  L_SAND = 1,
  L_BRICK = 2,
  L_CONC = 3,
  L_GRAN = 4,
  L_TILE = 5,
  L_SLATE = 6,
  L_FLAT = 7,
  L_SIGN = 8;
const NLAYERS = 10;

/** Shop signs drawn into the atlas (rows 0–15, two layers of 8). [text, background, text colour, font, awning colour] */
const SIGNS = [
  ['Apotheke', '#ffffff', '#c8102e', 'bold {px} Georgia, serif', null],
  ['Bäckerei', '#f3e3c3', '#6b3a1e', 'italic bold {px} Georgia, serif', '#b5651d'],
  ['Kiosk', '#1f4e8c', '#ffffff', 'bold {px} Arial, sans-serif', null],
  ['Café', '#2b2b2b', '#f0d9a0', 'italic {px} Georgia, serif', '#2f4f3a'],
  ['Friseur', '#f4f4f4', '#111111', '{px} Arial, sans-serif', null],
  ['Metzgerei', '#8c1c13', '#ffffff', 'bold {px} Georgia, serif', '#8c1c13'],
  ['Blumen', '#2f6b3a', '#ffffff', 'italic {px} Georgia, serif', '#2f6b3a'],
  ['Optiker', '#e8e8e8', '#1a1a1a', '{px} Arial, sans-serif', null],
  ['Buchhandlung', '#1d3557', '#f1faee', '{px} Georgia, serif', null],
  ['Imbiss', '#f2c200', '#b00000', 'bold {px} Arial, sans-serif', '#c0392b'],
  ['Apfelwein', '#3d2b1f', '#e9c46a', 'bold {px} Georgia, serif', '#6b4423'],
  ['Eiscafé', '#f7c6d9', '#7a1f4a', 'italic bold {px} Georgia, serif', '#d35d8a'],
  ['Reisebüro', '#0077b6', '#ffffff', '{px} Arial, sans-serif', null],
  ['Lotto · Tabak', '#ffd400', '#d00000', 'bold {px} Arial, sans-serif', null],
  ['Schuhe', '#111111', '#ffffff', '{px} Arial, sans-serif', null],
  ['A', '#c8102e', '#ffffff', 'bold {px} Georgia, serif', null], // Apotheke projecting sign
];

const TEX = { col: null, nrm: null, layer: [] };

const srgbToLin = (c) => {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};

async function loadBitmap(url) {
  const buf = await assets.bytes(url);
  if (!buf) return null;
  try {
    return await createImageBitmap(new Blob([buf]));
  } catch {
    return null;
  }
}

/** Draws the shop-sign atlas (8 rows per layer) on a canvas; alpha = lettering mask. */
function drawSigns(S, first) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  const mask = document.createElement('canvas');
  mask.width = mask.height = S;
  const m = mask.getContext('2d');
  m.fillStyle = '#000';
  m.fillRect(0, 0, S, S);
  const rh = S / 8;
  for (let r = 0; r < 8; r++) {
    const sg = SIGNS[first + r];
    if (!sg) continue;
    const [text, bg, fg, font] = sg;
    const y = r * rh;
    g.fillStyle = bg;
    g.fillRect(0, y, S, rh);
    if (text === 'A') {
      // square red Apotheke "A" logo on the left of the row
      g.fillStyle = '#ffffff';
      g.fillRect(rh * 0.08, y + rh * 0.08, rh * 0.84, rh * 0.84);
      g.fillStyle = bg;
      g.fillRect(rh * 0.14, y + rh * 0.14, rh * 0.72, rh * 0.72);
    } else {
      g.strokeStyle = fg;
      g.globalAlpha = 0.5;
      g.lineWidth = Math.max(1, rh * 0.04);
      g.strokeRect(rh * 0.08, y + rh * 0.1, S - rh * 0.16, rh * 0.8);
      g.globalAlpha = 1;
    }
    const px = Math.round(rh * (text === 'A' ? 0.62 : 0.56));
    for (const [c, col] of [
      [g, fg],
      [m, '#fff'],
    ]) {
      c.font = font.replace('{px}', `${px}px`);
      c.fillStyle = col;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      const cx = text === 'A' ? rh * 0.5 : S / 2;
      c.fillText(text, cx, y + rh * 0.54, text === 'A' ? rh : S * 0.86);
    }
  }
  return { cv, mask };
}

/** Builds the facade texture arrays (runs during the loading screen). */
async function buildTextureArrays() {
  const S = ctx.quality === 'ultra' ? 1024 : 512;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d', { willReadFrequently: true });
  const draw = (img) => {
    g.clearRect(0, 0, S, S);
    g.save();
    g.setTransform(1, 0, 0, -1, 0, S); // texture v points up
    g.drawImage(img, 0, 0, S, S);
    g.restore();
    return g.getImageData(0, 0, S, S).data;
  };
  const N = S * S * 4;
  const col = new Uint8Array(N * NLAYERS),
    nrm = new Uint8Array(N * NLAYERS);
  const imgs = await Promise.all(LAYERS.map(([n]) => Promise.all(['col', 'nrm', 'rgh'].map((k) => loadBitmap(`textures/buildings/${n}_${k}.jpg`)))));
  for (let l = 0; l < NLAYERS; l++) {
    const off = l * N;
    let cd = null,
      nd = null,
      rd = null;
    if (l < LAYERS.length) {
      const [c, n, r] = imgs[l];
      if (c) cd = draw(c).slice();
      if (n) nd = draw(n).slice();
      if (r) rd = draw(r).slice();
    } else {
      const { cv: sc, mask } = drawSigns(S, (l - L_SIGN) * 8);
      cd = draw(sc).slice();
      const md = draw(mask);
      for (let i = 0; i < S * S; i++) cd[i * 4 + 3] = md[i * 4];
    }
    let ar = 0,
      ag = 0,
      ab = 0,
      cnt = 0;
    for (let i = 0; i < S * S; i++) {
      const o = off + i * 4,
        k = i * 4;
      if (cd) {
        col[o] = cd[k];
        col[o + 1] = cd[k + 1];
        col[o + 2] = cd[k + 2];
        col[o + 3] = l >= L_SIGN ? cd[k + 3] : 255;
      } else {
        col[o] = col[o + 1] = col[o + 2] = 190;
        col[o + 3] = 255;
      }
      nrm[o] = nd ? nd[k] : 128;
      nrm[o + 1] = nd ? nd[k + 1] : 128;
      nrm[o + 2] = nd ? nd[k + 2] : 255;
      nrm[o + 3] = rd ? rd[k] : l >= L_SIGN ? 110 : 215;
      if ((i & 63) === 0) {
        ar += srgbToLin(col[o]);
        ag += srgbToLin(col[o + 1]);
        ab += srgbToLin(col[o + 2]);
        cnt++;
      }
    }
    TEX.layer[l] = new THREE.Vector4(ar / cnt, ag / cnt, ab / cnt, l < LAYERS.length ? LAYERS[l][1] : 1);
  }
  const mk = (data, srgb) => {
    const t = new THREE.DataArrayTexture(data, S, S, NLAYERS);
    t.format = THREE.RGBAFormat;
    t.type = THREE.UnsignedByteType;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = assets.maxAnisotropy;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.needsUpdate = true;
    return t;
  };
  TEX.col = mk(col, true);
  TEX.nrm = mk(nrm, false);
}
if (typeof document !== 'undefined') assets.preload('buildings', buildTextureArrays);

// ---------------------------------------------------------------- styles
const S_GZ = 0, // Gründerzeit Altbau
  S_PW = 1, // 1950s rebuild
  S_RIB = 2, // 1960s–70s ribbon windows
  S_MOD = 3, // modern residential
  S_OFF = 4, // office, punched windows + external blinds
  S_GLASS = 5, // curtain-wall tower
  S_FACH = 6, // Altstadt half-timber
  S_GOTH = 7, // Gothic sandstone (Römer, Dom)
  S_SHED = 8, // garages, halls
  S_STONE = 9, // stone-clad tower
  S_CMZ = 10; // Commerzbank Tower with sky gardens

/** cell = window spacing, fh = storey height, gH / gHs = ground floor height without / with shop. */
const STY = {
  [S_GZ]: { cell: 2.3, fh: 3.6, gH: 3.9, gHs: 4.3 },
  [S_PW]: { cell: 2.6, fh: 2.9, gH: 3.0, gHs: 3.7 },
  [S_RIB]: { cell: 1.4, fh: 3.0, gH: 3.2, gHs: 3.8 },
  [S_MOD]: { cell: 3.0, fh: 3.1, gH: 3.2, gHs: 3.9 },
  [S_OFF]: { cell: 1.5, fh: 3.6, gH: 4.5, gHs: 4.5 },
  [S_GLASS]: { cell: 1.5, fh: 3.8, gH: 6, gHs: 6 },
  [S_FACH]: { cell: 1.7, fh: 3.0, gH: 3.4, gHs: 3.7 },
  [S_GOTH]: { cell: 2.4, fh: 4.2, gH: 4.8, gHs: 4.8 },
  [S_SHED]: { cell: 5, fh: 4, gH: 99, gHs: 99 },
  [S_STONE]: { cell: 1.8, fh: 3.7, gH: 5.5, gHs: 5.5 },
  [S_CMZ]: { cell: 1.5, fh: 3.9, gH: 6, gHs: 6 },
};

const PAL = {
  plaster: ['#e9dcc0', '#e8d49a', '#e3b99c', '#d9c08e', '#cfd2bd', '#e7e1d3', '#d8b2a4', '#c9cfd2', '#efe6cf', '#d6c7a8', '#e2c6a0', '#c7d1c4'],
  sandRed: ['#a8644f', '#b0705a', '#9c5b48', '#b67d64'],
  sandYellow: ['#cdb58a', '#c4a77c', '#d2bf98'],
  brick: ['#9a4b37', '#8a4433', '#a65a3e', '#b8956a'],
  pw: ['#e6dcc4', '#dccf9e', '#cfd6c4', '#e4c9b0', '#d5d5cf', '#e9e3cf', '#c8cdd3', '#e0d2b4'],
  rib: ['#b9b5ac', '#a8a49b', '#c4bfb3', '#b0aba0'],
  mod: ['#efede8', '#e2e0db', '#c9c8c4', '#8b8f93', '#d9d2c4', '#f2efe6'],
  off: ['#a6a39c', '#8d8a85', '#c0bbb0', '#b5a48e', '#9a9a98'],
  glass: ['#5f7c8f', '#6f8a99', '#4e6878', '#7d97a6', '#5c7480', '#6b7f86'],
  fachInfill: ['#efe8d8', '#f1e6c8', '#e9dfd0', '#e8d6b8'],
  tile: ['#8c4a36', '#7a3f30', '#9a5a40', '#6e4a3e', '#84483a'],
  slate: ['#55585e', '#4a4d52', '#5f6266', '#45474b'],
  flat: ['#8a8884', '#7d7b77', '#96938c', '#6f6e6b'],
  roemer: ['#c98a6e', '#e4d8c2', '#d9a77f', '#c97b62', '#e8cfa6'],
};
const pick = (arr, r) => arr[Math.floor(r * arr.length) % arr.length];
const color = (hex) => new THREE.Color(hex);

/** Probability that a low-rise building in this district is a Gründerzeit Altbau, and shop density. */
const DISTRICT_MIX = {
  Westend: [0.78, 0.3],
  'Westend-Süd': [0.6, 0.35],
  Nordend: [0.8, 0.45],
  Sachsenhausen: [0.65, 0.45],
  Ostend: [0.45, 0.4],
  Bahnhofsviertel: [0.75, 0.75],
  Gallus: [0.4, 0.35],
  Gutleutviertel: [0.35, 0.3],
  Museumsufer: [0.7, 0.2],
  Innenstadt: [0.18, 0.8],
  Altstadt: [0.3, 0.7],
  Bankenviertel: [0.3, 0.45],
  Messe: [0.2, 0.25],
};

// ---------------------------------------------------------------- geometry builder
/** Compact vertex layout: pos f32, normal i8, colour u8, uv f32, info u8x4, window params f16x4. */
class FacadeBuilder {
  constructor() {
    this.p = [];
    this.n = [];
    this.c = [];
    this.uv = [];
    this.inf = [];
    this.win = [];
    this.i = [];
  }
  get count() {
    return this.p.length / 3;
  }
  v(x, y, z, nx, ny, nz, col, u, vv, inf, win) {
    this.p.push(x, y, z);
    this.n.push(Math.round(nx * 127), Math.round(ny * 127), Math.round(nz * 127));
    this.c.push(Math.round(col.r * 255), Math.round(col.g * 255), Math.round(col.b * 255));
    this.uv.push(u, vv);
    this.inf.push(inf[0], inf[1], inf[2], inf[3]);
    this.win.push(win[0], win[1], win[2], win[3]);
    return this.count - 1;
  }
  tri(a, b, c) {
    this.i.push(a, b, c);
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Int8Array(this.n), 3, true));
    g.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(this.c), 3, true));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('aInfo', new THREE.BufferAttribute(new Uint8Array(this.inf), 4));
    g.setAttribute('aWin', new THREE.Float16BufferAttribute(this.win, 4));
    g.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(this.i, 1) : new THREE.Uint16BufferAttribute(this.i, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

const K_FACADE = 0,
  K_TRIM = 1,
  K_FLAT = 2,
  K_ROOF = 3,
  K_SIGN = 4,
  K_AWNING = 5,
  K_LIGHT = 6,
  K_DORMER = 7,
  K_GLASS = 8,
  K_METAL = 9;
const NOWIN = [0, 3, 3, 0];
const info = (kind, layer, styleBits, seed, cellW = 2) => [kind * 16 + layer, styleBits, Math.floor(seed * 255), Math.max(0, Math.min(255, Math.round((cellW - 0.5) * 100)))];

/**
 * Convex polygon face (fan) with per-vertex [x, y, z, u, v] and optional per-vertex window
 * params; winding is fixed so the face looks along N.
 */
function face(gb, pts, N, col, inf, wins) {
  if (pts.length < 3) return;
  const a = pts[0],
    b = pts[1],
    c = pts[2];
  const ux = b[0] - a[0],
    uy = b[1] - a[1],
    uz = b[2] - a[2];
  const vx = c[0] - a[0],
    vy = c[1] - a[1],
    vz = c[2] - a[2];
  const cx = uy * vz - uz * vy,
    cy = uz * vx - ux * vz,
    cz = ux * vy - uy * vx;
  const flip = cx * N[0] + cy * N[1] + cz * N[2] < 0;
  const ids = pts.map((p, k) => gb.v(p[0], p[1], p[2], N[0], N[1], N[2], col, p[3] ?? 0, p[4] ?? 0, inf, wins ? wins[k] : NOWIN));
  for (let k = 1; k < ids.length - 1; k++) {
    if (flip) gb.tri(ids[0], ids[k + 1], ids[k]);
    else gb.tri(ids[0], ids[k], ids[k + 1]);
  }
}

/** Flat-normal triangles from a list of 3D vertices [x,y,z,u,v] and index triples, oriented up/outwards. */
function polyTris(gb, verts, tris, col, inf, wantUp = true) {
  for (const t of tris) {
    const a = verts[t[0]],
      b = verts[t[1]],
      c = verts[t[2]];
    const ux = b[0] - a[0],
      uy = b[1] - a[1],
      uz = b[2] - a[2];
    const vx = c[0] - a[0],
      vy = c[1] - a[1],
      vz = c[2] - a[2];
    let nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-9) continue;
    nx /= l;
    ny /= l;
    nz /= l;
    let order = [a, b, c];
    if ((ny < 0) === wantUp) {
      order = [a, c, b];
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    const ids = order.map((p) => gb.v(p[0], p[1], p[2], nx, ny, nz, col, p[3], p[4], inf, NOWIN));
    gb.tri(ids[0], ids[1], ids[2]);
  }
}

function triangulate(ring) {
  try {
    return THREE.ShapeUtils.triangulateShape(
      ring.map((p) => new THREE.Vector2(p[0], p[1])),
      [],
    );
  } catch {
    return [];
  }
}

/** Sutherland–Hodgman clip of a ring to s(p) = dot(p, A) in [lo, hi]. */
function clipStrip(ring, ax, az, lo, hi) {
  const clip = (poly, sign, lim) => {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const P = poly[i],
        Q = poly[(i + 1) % poly.length];
      const dp = sign * (P[0] * ax + P[1] * az - lim),
        dq = sign * (Q[0] * ax + Q[1] * az - lim);
      if (dp >= 0) out.push(P);
      if (dp >= 0 !== dq >= 0) {
        const t = dp / (dp - dq);
        out.push([P[0] + (Q[0] - P[0]) * t, P[1] + (Q[1] - P[1]) * t]);
      }
    }
    return out;
  };
  let p = clip(ring, 1, lo);
  if (p.length >= 3) p = clip(p, -1, hi);
  const o = [];
  for (const q of p) {
    const l = o[o.length - 1];
    if (!l || Math.hypot(q[0] - l[0], q[1] - l[1]) > 0.02) o.push(q);
  }
  if (o.length > 2 && Math.hypot(o[0][0] - o[o.length - 1][0], o[0][1] - o[o.length - 1][1]) < 0.02) o.pop();
  return o;
}

/** Oriented box (dir = unit x/z of the local x axis). */
function box(gb, x, y0, z, hx, hy, hz, dir, col, inf) {
  const [dx, dz] = dir;
  const px = -dz,
    pz = dx;
  const P = (a, b, y) => [x + dx * a + px * b, y, z + dz * a + pz * b];
  const y1 = y0 + hy * 2;
  const c = [P(-hx, -hz, 0), P(hx, -hz, 0), P(hx, hz, 0), P(-hx, hz, 0)];
  for (let k = 0; k < 4; k++) {
    const a = c[k],
      b = c[(k + 1) % 4];
    const ex = b[0] - a[0],
      ez = b[2] - a[2],
      l = Math.hypot(ex, ez) || 1;
    const N = [ez / l, 0, -ex / l];
    // make the normal point away from the box centre
    const mx = (a[0] + b[0]) / 2 - x,
      mz = (a[2] + b[2]) / 2 - z;
    if (N[0] * mx + N[2] * mz < 0) {
      N[0] = -N[0];
      N[2] = -N[2];
    }
    face(
      gb,
      [
        [a[0], y0, a[2], 0, y0],
        [b[0], y0, b[2], l, y0],
        [b[0], y1, b[2], l, y1],
        [a[0], y1, a[2], 0, y1],
      ],
      N,
      col,
      inf,
    );
  }
  face(
    gb,
    c.map((p) => [p[0], y1, p[2], p[0], p[2]]),
    [0, 1, 0],
    col,
    inf,
  );
}

/** Pyramid over a ring from y0 to an apex. */
function pyramid(gb, ring, y0, apex, col, inf) {
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i],
      b = ring[(i + 1) % ring.length];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 0.05) continue;
    const verts = [
      [a[0], y0, a[1], 0, 0],
      [b[0], y0, b[1], L, 0],
      [apex[0], apex[1], apex[2], L / 2, apex[1] - y0],
    ];
    polyTris(gb, verts, [[0, 1, 2]], col, inf, true);
  }
}

/** Tapered prism (cupola / penthouse): ring at y0 scaled by s1 at y1 around the centroid, capped. */
function taper(gb, ring, cx, cz, y0, y1, s1, col, inf, capInf) {
  const top = ring.map((p) => [cx + (p[0] - cx) * s1, cz + (p[1] - cz) * s1]);
  let per = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i],
      b = ring[(i + 1) % ring.length],
      ta = top[i],
      tb = top[(i + 1) % ring.length];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 0.05) continue;
    const nx = (b[1] - a[1]) / L,
      nz = -(b[0] - a[0]) / L;
    const k = (1 - s1) * Math.hypot((a[0] + b[0]) / 2 - cx, (a[1] + b[1]) / 2 - cz);
    const ny = k / Math.max(0.01, y1 - y0);
    const nl = Math.hypot(nx, ny, nz);
    face(
      gb,
      [
        [a[0], y0, a[1], per, y0],
        [b[0], y0, b[1], per + L, y0],
        [tb[0], y1, tb[1], per + L, y1],
        [ta[0], y1, ta[1], per, y1],
      ],
      [nx / nl, ny / nl, nz / nl],
      col,
      inf,
    );
    per += L;
  }
  const tris = triangulate(top);
  polyTris(
    gb,
    top.map((p) => [p[0], y1, p[1], p[0], p[1]]),
    tris,
    col,
    capInf || inf,
  );
}

/** Slim mast (antenna) with red/white bands and an aviation light. */
function mast(gb, x, z, y0, y1, r, redWhite, sd) {
  const seg = 8;
  const col = new THREE.Color(0.8, 0.8, 0.82);
  const inf = info(K_METAL, 0, 0, redWhite ? 0.9 : 0.1);
  for (let k = 0; k < seg; k++) {
    const a0 = (k / seg) * Math.PI * 2,
      a1 = ((k + 1) / seg) * Math.PI * 2;
    const am = (a0 + a1) / 2;
    const rt = r * 0.45;
    face(
      gb,
      [
        [x + Math.cos(a0) * r, y0, z + Math.sin(a0) * r, 0, y0],
        [x + Math.cos(a1) * r, y0, z + Math.sin(a1) * r, 1, y0],
        [x + Math.cos(a1) * rt, y1, z + Math.sin(a1) * rt, 1, y1],
        [x + Math.cos(a0) * rt, y1, z + Math.sin(a0) * rt, 0, y1],
      ],
      [Math.cos(am), 0, Math.sin(am)],
      col,
      inf,
    );
  }
  box(gb, x, y1, z, 0.45, 0.4, 0.45, [1, 0], new THREE.Color(1, 0.08, 0.04), info(K_LIGHT, 0, 0, sd));
}

// ---------------------------------------------------------------- city analysis helpers
function roadGrid(roads) {
  const C = 40;
  const grid = new Map();
  for (const r of roads) {
    const rc = RC[r.c];
    if (!rc || !r.pts || r.pts.length < 2) continue;
    const hw = rc[0] / 2,
      ped = rc[1] === 1;
    for (let i = 0; i < r.pts.length - 1; i++) {
      const a = r.pts[i],
        b = r.pts[i + 1];
      const seg = [a[0], a[1], b[0], b[1], hw, ped];
      const pad = hw + 16;
      for (let gx = Math.floor((Math.min(a[0], b[0]) - pad) / C); gx <= Math.floor((Math.max(a[0], b[0]) + pad) / C); gx++) {
        for (let gz = Math.floor((Math.min(a[1], b[1]) - pad) / C); gz <= Math.floor((Math.max(a[1], b[1]) + pad) / C); gz++) {
          const k = gx * 100003 + gz;
          let l = grid.get(k);
          if (!l) grid.set(k, (l = []));
          l.push(seg);
        }
      }
    }
  }
  return {
    /** Nearest road edge to (x, z): { d (distance to the carriageway edge), seg }. */
    near(x, z) {
      const l = grid.get(Math.floor(x / C) * 100003 + Math.floor(z / C));
      let best = null,
        bd = Infinity;
      if (l)
        for (const s of l) {
          const d = segDist(x, z, s[0], s[1], s[2], s[3]) - s[4];
          if (d < bd) {
            bd = d;
            best = s;
          }
        }
      return { d: bd, seg: best };
    },
  };
}

/** Minimum-area oriented rectangle axis of a ring (long axis direction). */
function longAxis(ring) {
  let best = null,
    bestA = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i],
      b = ring[(i + 1) % ring.length];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 0.5) continue;
    const ux = (b[0] - a[0]) / L,
      uz = (b[1] - a[1]) / L;
    let t0 = Infinity,
      t1 = -Infinity,
      s0 = Infinity,
      s1 = -Infinity;
    for (const p of ring) {
      const t = p[0] * ux + p[1] * uz,
        s = -p[0] * uz + p[1] * ux;
      t0 = Math.min(t0, t);
      t1 = Math.max(t1, t);
      s0 = Math.min(s0, s);
      s1 = Math.max(s1, s);
    }
    const A = (t1 - t0) * (s1 - s0);
    if (A < bestA) {
      bestA = A;
      best = t1 - t0 >= s1 - s0 ? [ux, uz] : [-uz, ux];
    }
  }
  return best || [1, 0];
}

// ---------------------------------------------------------------- roof profiles
/** Profile = [[distance from eave, rise], …]; flat beyond the last point. */
function profAt(prof, d) {
  if (d <= 0) return 0;
  for (let i = 1; i < prof.length; i++) {
    if (d <= prof[i][0]) {
      const [d0, y0] = prof[i - 1],
        [d1, y1] = prof[i];
      return y0 + ((y1 - y0) * (d - d0)) / (d1 - d0);
    }
  }
  return prof[prof.length - 1][1];
}
/** Inverse of profAt on the sloped part (returns null if the rise is never reached). */
function profInv(prof, rise) {
  for (let i = 1; i < prof.length; i++) {
    const [d0, y0] = prof[i - 1],
      [d1, y1] = prof[i];
    if (rise <= y1 && y1 > y0) return d0 + ((rise - y0) * (d1 - d0)) / (y1 - y0);
  }
  return null;
}
const gableProf = (k, maxRise) => [
  [0, 0],
  [maxRise / k, maxRise],
];
const mansardProf = () => [
  [0, 0],
  [1.3, 3.3],
  [1.3 + 2.0 / 0.45, 5.3],
];

// ---------------------------------------------------------------- facade material
const FRAG_COMMON = /* glsl */ `
uniform float uNight; uniform float uSnow; uniform float uWet; uniform float uTime;
uniform highp sampler2DArray tFacCol; uniform highp sampler2DArray tFacNrm;
uniform vec4 uLayer[${NLAYERS}];
flat varying vec4 vInfo; varying vec4 vWin; varying vec2 vMUv; varying vec3 vWN;
vec3 gEmit; float gRough; float gMetal; vec3 gNT; mat3 gTBN;
float h21(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }

// Interior mapping: room behind the window (x across, y up from the floor, z into the building).
vec3 roomColor(vec2 p, vec3 Vt, float rw, float rh, float rd, float rs, int rt, float lit) {
  vec3 d = -Vt; d.z = min(d.z, -0.08);
  vec3 o = vec3(p, 0.0);
  float sx = d.x >= 0.0 ? 1.0 : -1.0;
  float tx = (sx * rw * 0.5 - o.x) / (sx * max(abs(d.x), 1e-4));
  float ty = d.y >= 0.0 ? (rh - o.y) / max(d.y, 1e-4) : o.y / max(-d.y, 1e-4);
  float tz = rd / -d.z;
  float t = min(tx, min(ty, tz));
  vec3 hp = o + d * t;
  vec3 wallC = mix(vec3(0.82, 0.77, 0.68), vec3(0.68, 0.74, 0.78), fract(rs * 3.7));
  if (rt == 1) wallC = vec3(0.78, 0.79, 0.80);
  if (rt == 2) wallC = vec3(0.93, 0.92, 0.9);
  vec3 c;
  if (t == tz) {
    c = wallC;
    if (rt == 0) {
      if (hp.y < 0.85 && abs(hp.x) < rw * 0.32) c = mix(vec3(0.38, 0.22, 0.16), vec3(0.22, 0.28, 0.4), fract(rs * 7.0));
      if (hp.y > 1.35 && hp.y < 1.95 && abs(hp.x - (rs - 0.5) * rw * 0.3) < 0.3) c = vec3(0.25, 0.3, 0.42);
    } else if (rt == 2) {
      float row = floor(hp.y / 0.42); float sh = fract(hp.y / 0.42);
      vec3 prod = vec3(h21(vec2(floor(hp.x * 5.0), row) + rs), h21(vec2(floor(hp.x * 5.0) + 3.0, row + rs)), h21(vec2(row, floor(hp.x * 5.0)) + rs * 2.0));
      c = sh < 0.1 ? vec3(0.55) : mix(wallC, prod * 0.8 + 0.1, step(0.3, sh) * step(hp.y, 2.3));
    } else if (hp.y < 1.0 && abs(hp.x) < rw * 0.42) c = vec3(0.42, 0.4, 0.37);
  } else if (t == tx) {
    c = wallC * 0.8;
    if (rt == 0 && hp.y < 2.0 && hp.z < -rd * 0.45 && fract(rs * 13.0) > 0.5) c = vec3(0.42, 0.3, 0.2);
    if (rt == 2 && hp.y < 2.2) c = mix(c, vec3(h21(vec2(floor(hp.z * 3.0), floor(hp.y / 0.42)) + rs)), 0.5);
  } else if (d.y < 0.0) {
    c = rt == 1 ? vec3(0.27, 0.29, 0.33) : (rt == 2 ? vec3(0.72, 0.7, 0.66) : vec3(0.38, 0.25, 0.15) * (0.85 + 0.15 * step(0.5, fract(hp.x * 4.0))));
  } else {
    c = vec3(0.9);
    if (lit > 0.0) {
      if (rt >= 1) c += 3.0 * step(0.55, fract(hp.z / 1.8)) * step(abs(fract(hp.x / 1.5) - 0.5), 0.14);
      else c += 4.0 * smoothstep(0.4, 0.0, length(vec2(hp.x, hp.z + rd * 0.5)));
    }
  }
  return c * (0.45 + 0.55 * exp(-t * 0.22));
}

vec3 facade(vec3 wallCol, vec3 tint, vec3 Vt, int kind, int layer, int style, bool shop, bool street, float seed, float cellW) {
  float y = vMUv.y; float cx = vWin.x; float fh = max(vWin.y, 0.5); float gH = vWin.z;
  float cid = floor(cx); float lx = (fract(cx) - 0.5) * cellW;
  bool dorm = kind == 7;
  bool ground = !dorm && y < gH;
  float fl = dorm ? 60.0 : (ground ? -1.0 : floor((y - gH) / fh));
  float base = dorm ? gH : (ground ? 0.0 : gH + fl * fh);
  float flH = dorm ? fh : (ground ? gH : fh);
  float ly = y - base;
  // local wall top (gables): slope of vWin.w along u
  vec2 dU = vec2(dFdx(vMUv.x), dFdy(vMUv.x)), dV = vec2(dFdx(y), dFdy(y)), dT = vec2(dFdx(vWin.w), dFdy(vWin.w));
  float det = dU.x * dV.y - dU.y * dV.x;
  float slope = abs(det) > 1e-10 ? (dT.x * dV.y - dT.y * dV.x) / det : 0.0;
  slope = clamp(slope, -4.0, 4.0);
  float topC = vWin.w - lx * slope;
  vec2 id = vec2(cid, fl);
  float r1 = h21(id + seed * 91.7), r2 = h21(id.yx * 1.31 + seed * 17.3 + 4.1), r3 = h21(id * 0.71 + seed * 5.1 + 9.3);

  // ---- style parameters
  float hw = min(0.62, cellW * 0.3), yb = 0.95, yt = flH - 0.62, depth = 0.2, fw = 0.06;
  int mull = 1; vec3 frameCol = vec3(0.9); int room = 0; bool trims = false;
  float glassMetal = 0.2; vec3 glassTint = vec3(0.03, 0.035, 0.04); float raffP = 0.0; bool door = false; bool garage = false;
  bool glassWall = false; bool arcade = false; bool gothic = false; bool beams = false;
  vec3 shutterCol = mix(vec3(0.85, 0.83, 0.78), vec3(0.55, 0.56, 0.57), step(0.5, seed));
  if (style == 0) { trims = true; }
  else if (style == 1) { hw = min(0.72, cellW * 0.3); yb = 0.9; yt = flH - 0.45; depth = 0.12; mull = 2; frameCol = seed > 0.6 ? vec3(0.3, 0.2, 0.12) : vec3(0.9); }
  else if (style == 2) { hw = cellW * 0.5 - 0.1; yb = 0.95; yt = flH - 0.32; depth = 0.1; mull = 0; frameCol = vec3(0.22, 0.16, 0.1); room = seed > 0.5 ? 1 : 0; raffP = 0.3; }
  else if (style == 3) { hw = min(1.1, cellW * 0.38); yb = 0.45; yt = flH - 0.35; depth = 0.15; mull = 2; frameCol = vec3(0.16); }
  else if (style == 4) { hw = cellW * 0.5 - 0.2; yb = 0.8; yt = flH - 0.55; depth = 0.2; mull = 0; frameCol = vec3(0.55); room = 1; raffP = 0.45; glassTint = vec3(0.04, 0.05, 0.06); glassMetal = 0.35; }
  else if (style == 5 || style == 10) { hw = cellW * 0.5 - 0.025; yb = 0.0; yt = flH - 0.8; depth = 0.02; fw = 0.035; mull = 0; frameCol = vec3(0.5, 0.53, 0.56); room = 1; glassTint = tint * 0.55; glassMetal = 0.8; glassWall = true; raffP = 0.12; }
  else if (style == 6) { hw = min(0.42, cellW * 0.27); yb = 0.85; yt = flH - 0.42; depth = 0.06; mull = 3; beams = true; }
  else if (style == 7) { hw = min(0.5, cellW * 0.22); yb = 1.0; yt = flH - 0.6; depth = 0.3; mull = 3; frameCol = vec3(0.15); gothic = true; trims = true; }
  else if (style == 8) { hw = 1.0; yb = 1.3; yt = min(flH - 0.4, 2.4); depth = 0.1; mull = 2; frameCol = vec3(0.5); if (r1 > 0.35) hw = 0.0; }
  else if (style == 9) { hw = cellW * 0.5 - 0.32; yb = 0.55; yt = flH - 0.4; depth = 0.28; mull = 0; frameCol = vec3(0.2); room = 1; glassTint = vec3(0.06, 0.09, 0.12); glassMetal = 0.55; }
  bool office = room == 1;
  if (ground) {
    if (shop) { hw = cellW * 0.5 - 0.22; yb = 0.45; yt = gH - 1.0; depth = 0.14; mull = 0; frameCol = vec3(0.12); room = 2; door = r1 < 0.3; if (door) yb = 0.02; trims = false; }
    else if (style == 4 || style == 5 || style == 9 || style == 10) { hw = cellW * 0.5 - 0.06; yb = 0.05; yt = gH - 0.7; depth = 0.05; mull = 0; room = 1; frameCol = vec3(0.25); }
    else if (style == 7) { arcade = true; }
    else if (style == 8) { garage = street && r1 > 0.55; if (garage) { hw = cellW * 0.5 - 0.7; yb = 0.0; yt = 2.4; } }
    else {
      hw = min(hw, 0.58); yb = 1.35; yt = gH - 0.55;
      if (street && r1 < 0.2) { door = true; hw = 0.68; yb = 0.0; yt = min(2.9, gH - 0.35); }
    }
  }
  if (dorm) { hw = cellW * 0.5 - 0.14; yb = 0.15; yt = flH - 0.15; depth = 0.08; mull = 1; }

  // ---- night lighting
  float night = uNight;
  float litP = office ? 0.5 : 0.38;
  float lit = office ? step(h21(vec2(fl, floor(cid / 6.0)) + seed * 3.1), litP) : step(r3, litP);
  vec3 litCol = office ? vec3(0.82, 0.9, 1.0) : mix(vec3(1.0, 0.68, 0.38), vec3(1.0, 0.84, 0.6), r2);

  // ---- far-away average (windows smaller than a pixel)
  float px = max(fwidth(cx), fwidth(y) / flH);
  float aa = clamp(1.6 - px * 3.0, 0.0, 1.0);
  float winFrac = clamp((2.0 * hw / cellW) * ((yt - yb) / flH), 0.0, 1.0);
  float okFar = step(base + yt, vWin.w + 0.2);
  vec2 idF = vec2(floor(cid / 3.0), fl);
  float litF = office ? lit : step(h21(idF + seed * 7.0), litP);
  vec3 farCol = mix(wallCol, glassWall ? tint * 0.45 : vec3(0.05, 0.06, 0.07), winFrac * 0.85 * okFar);
  if (ground && shop) farCol = mix(wallCol, vec3(0.25), 0.6);
  vec3 farEmit = litCol * litF * winFrac * okFar * night * 0.9;
  if (ground && shop) farEmit = vec3(1.0, 0.85, 0.65) * winFrac * (0.25 + night);
  if (aa <= 0.0) { gEmit = farEmit; if (glassWall) { gMetal = 0.7 * okFar; gRough = 0.15; } return farCol; }

  // ---- detailed facade
  vec3 c = wallCol;
  vec3 trimCol = layer == 2 ? vec3(0.78, 0.7, 0.58) * (wallCol / max(tint, vec3(0.05))) : min(wallCol * 1.16 + 0.05, vec3(1.0));
  float dTop = (base + yt) - (topC - abs(slope) * hw);
  bool fits = dorm || (ly >= 0.0 && dTop < 0.02);
  if (glassWall && !ground) {
    c = tint * 0.42; gMetal = 0.7; gRough = 0.16; gNT = vec3(0.0, 0.0, 1.0);
    if (abs(abs(lx) - cellW * 0.5) < 0.045) { c = frameCol; gMetal = 0.8; gRough = 0.35; }
    if (y > vWin.w + 0.3) { c = tint * 0.5; }
  }
  // Gründerzeit / Gothic plaster ornaments
  if (trims && fits && !ground) {
    float sx = abs(lx);
    if (sx < hw + 0.17 && ly > yb - 0.1 && ly < yt + 0.17) c = trimCol;
    if (sx < hw + 0.25 && ly > yb - 0.17 && ly < yb - 0.03) { c = trimCol * 1.04; gNT = normalize(vec3(0.0, 0.7, 0.7)); }
    if (sx < hw + 0.22 && ly > yb - 0.32 && ly <= yb - 0.17) c *= 0.8;
    float py = ly - (yt + 0.17);
    if (fl == 0.0 && py > 0.0 && py < 0.5 * (1.0 - sx / (hw + 0.32))) c = py < 0.06 ? trimCol * 0.8 : trimCol;
    if (fl == 1.0 && py > 0.0 && py < 0.2 && sx < hw + 0.3) { c = trimCol; if (py < 0.05) c *= 0.78; }
  }
  if ((style == 0 || style == 7) && !dorm) {
    float bY = y - gH;
    if (bY > 0.0 && bY < 0.32) { c = trimCol; gNT = normalize(vec3(0.0, bY > 0.22 ? 0.6 : 0.0, 1.0)); }
    else if (bY > -0.14 && bY <= 0.0) c *= 0.72;
    if (ground && !shop) c *= 0.93 + 0.07 * step(0.07, fract(y / 0.45));
  }
  // half-timbering (Fachwerk)
  if (beams && !ground) {
    vec3 beam = seed > 0.5 ? vec3(0.27, 0.11, 0.07) : vec3(0.12, 0.09, 0.07);
    float hwb = hw + 0.09; float sx = abs(lx);
    bool b = abs(sx - cellW * 0.5) < 0.09 || ly < 0.18 || ly > flH - 0.14;
    if (fits) {
      b = b || (abs(sx - hwb) < 0.07 && ly > yb - 0.1 && ly < yt + 0.1);
      b = b || (sx < hwb && (abs(ly - (yb - 0.05)) < 0.06 || abs(ly - (yt + 0.05)) < 0.06));
      if (sx < hwb && ly < yb - 0.1 && ly > 0.18) {
        float a = (ly - 0.18) / max(yb - 0.28, 0.1) * 2.0 - 1.0; float xx = lx / hwb;
        b = b || abs(xx - a) * hwb < 0.07 || abs(xx + a) * hwb < 0.07;
      }
    } else {
      float a = fract(ly / flH) * 2.0 - 1.0; b = b || abs(lx / (cellW * 0.5) - a) * cellW * 0.5 < 0.08;
    }
    if (b) { c = beam * (0.75 + 0.25 * wallCol / max(tint, vec3(0.05))); gRough = 0.75; gNT = vec3(0.0, 0.0, 1.0); }
  }
  // Gothic arcade on the ground floor (Römer)
  if (arcade) {
    float aw = cellW * 0.5 - 0.35; float at = gH - 0.5;
    bool inA = abs(lx) < aw && (ly < at - aw || length(vec2(lx, ly - (at - aw))) < aw);
    if (inA) { c = vec3(0.07, 0.06, 0.05) + vec3(0.35, 0.22, 0.1) * night * 0.4; gEmit = vec3(1.0, 0.7, 0.4) * night * 0.25; gRough = 0.9; gNT = vec3(0.0, 0.0, 1.0); }
    return mix(farCol, c, aa);
  }
  if (garage) {
    if (abs(lx) < hw && ly < yt) { c = vec3(0.62, 0.63, 0.64) * (0.85 + 0.15 * step(0.5, fract(ly * 6.0))); gNT = vec3(0.0, 0.0, 1.0); gRough = 0.5; }
    return mix(farCol, c, aa);
  }
  bool inOpen = fits && hw > 0.0 && abs(lx) < hw && ly > yb && ly < yt;
  float ys = yt - 1.732 * hw;
  if (gothic && inOpen && ly > ys) inOpen = length(vec2(lx + hw, ly - ys)) < 2.0 * hw && length(vec2(lx - hw, ly - ys)) < 2.0 * hw;
  if (inOpen && door && !shop) {
    // wooden entrance door with a glazed transom
    float tr = yt - 0.55;
    if (ly < tr) {
      vec3 wood = mix(vec3(0.28, 0.16, 0.09), vec3(0.18, 0.2, 0.22), step(0.6, seed));
      c = wood * (0.85 + 0.15 * step(abs(lx), 0.03));
      if (abs(abs(lx) - hw * 0.5) < hw * 0.35 && (abs(ly - tr * 0.3) < tr * 0.22 || abs(ly - tr * 0.72) < tr * 0.2)) c *= 0.82;
      gRough = 0.55; gNT = vec3(0.0, 0.0, 1.0);
      return mix(farCol, c, aa);
    }
    yb = tr + 0.06; mull = 2;
  }
  if (!inOpen) { gEmit = vec3(0.0); return mix(farCol, c, aa); }
  // ---- recessed window: reveal or glass
  vec2 bp = vec2(lx, ly) - Vt.xy / max(Vt.z, 0.2) * depth;
  bool backIn = abs(bp.x) < hw && bp.y > yb && bp.y < yt;
  if (gothic && backIn && bp.y > ys) backIn = length(vec2(bp.x + hw, bp.y - ys)) < 2.0 * hw && length(vec2(bp.x - hw, bp.y - ys)) < 2.0 * hw;
  vec3 revealCol = trims ? trimCol : (glassWall ? frameCol : wallCol);
  if (!backIn) {
    float ox = abs(bp.x) - hw; float oyT = bp.y - yt; float oyB = yb - bp.y;
    if (ox > max(oyT, oyB)) { gNT = vec3(-sign(bp.x), 0.0, 0.0); c = revealCol * 0.85; }
    else if (oyT > oyB) { gNT = vec3(0.0, -1.0, 0.0); c = revealCol * 0.7; }
    else { gNT = vec3(0.0, 1.0, 0.0); c = revealCol; }
    gRough = 0.8; gMetal = 0.0; gEmit = vec3(0.0);
    return mix(farCol, c, aa);
  }
  // frame and mullions
  float dE = min(hw - abs(bp.x), min(bp.y - yb, yt - bp.y));
  bool fr = dE < fw;
  float tY = yb + (yt - yb) * 0.7;
  if (mull == 1) fr = fr || abs(bp.x) < fw * 0.5 || abs(bp.y - tY) < fw * 0.5;
  else if (mull == 2) fr = fr || abs(bp.x) < fw * 0.5;
  else if (mull == 3) fr = fr || abs(bp.x) < fw * 0.4 || abs(fract((bp.y - yb) / ((yt - yb) / 3.0)) - 0.5) > 0.5 - fw * 0.4 / ((yt - yb) / 3.0);
  if (shop && ground) fr = fr || abs(bp.y - (yt - 0.45)) < 0.03;
  if (fr) { gNT = vec3(0.0, 0.0, 1.0); gRough = 0.4; gMetal = glassWall ? 0.8 : 0.0; gEmit = vec3(0.0); return mix(farCol, frameCol, aa); }
  // coverings: net curtains, roller shutters, drapes, external blinds
  float cover = 0.0; vec3 coverCol = vec3(0.0); float coverLit = 0.0; float coverMetal = 0.0;
  if (room == 0) {
    if (r2 < 0.32) { cover = 0.7; coverCol = vec3(0.86, 0.85, 0.8) * (0.82 + 0.18 * sin(bp.x * 38.0 + r1 * 6.0)); coverLit = 1.0; }
    else if (r2 < 0.52) {
      float dn = mix(0.15, 1.0, r1 * r1);
      if (bp.y > yt - (yt - yb) * dn) { cover = 1.0; coverCol = shutterCol * (0.8 + 0.2 * step(0.45, fract(bp.y * 22.0))); }
    } else if (r2 < 0.64 && abs(bp.x) > hw * 0.55) { cover = 0.96; coverCol = mix(vec3(0.6, 0.15, 0.12), vec3(0.75, 0.68, 0.5), r1); coverLit = 0.6; }
  } else if (room == 1 && r2 < raffP) {
    float dn = mix(0.2, 1.0, r1);
    if (bp.y > yt - (yt - yb) * dn) { cover = 1.0; coverCol = vec3(0.6, 0.62, 0.64) * (0.78 + 0.22 * step(0.5, fract(bp.y * 12.0))); coverMetal = 0.5; }
  }
  float rd = room == 1 ? 6.0 : (room == 2 ? 5.0 : 4.0);
  vec3 inter;
  bool garden = false;
  if (style == 10 && !ground) {
    float sector = floor(mod(atan(vWN.z, vWN.x) / 2.0944 + 3.3, 3.0));
    garden = mod(floor(fl / 4.0), 3.0) == sector;
  }
  #if FAC_Q > 0
  inter = roomColor(bp, Vt, cellW, flH, rd, r1, room, lit);
  #else
  inter = room == 2 ? vec3(0.8) : vec3(0.35);
  #endif
  if (garden) { vec2 q = floor(vec2(bp.x * 3.0 + cid * 2.0, y * 2.0)); inter = vec3(0.12, 0.3, 0.1) * (0.5 + h21(q)) * 2.0; }
  float dayK = room == 2 ? 0.45 : (garden ? 0.5 : 0.13);
  float litK = room == 2 ? 1.4 : lit * 1.15;
  vec3 gEm = inter * dayK * (1.0 - night) + inter * litK * night * (room == 2 ? vec3(1.0, 0.88, 0.7) : litCol) + inter * 0.01;
  vec3 gc = glassTint;
  c = mix(gc, coverCol, cover);
  gEmit = mix(gEm, coverCol * litCol * lit * night * 0.9 * coverLit + gEm * 0.15, cover);
  gRough = mix(0.04, 0.6, cover);
  gMetal = mix(glassMetal, coverMetal, cover);
  gNT = vec3(0.0, 0.0, 1.0);
  return mix(farCol, c, aa);
}
`;

const FRAG_MAIN = /* glsl */ `
#include <color_fragment>
vec3 tint = diffuseColor.rgb;
gEmit = vec3(0.0); gRough = 0.85; gMetal = 0.0; gNT = vec3(0.0, 0.0, 1.0);
int ix = int(vInfo.x + 0.5); int kind = ix / 16; int layer = ix - kind * 16;
int sty = int(vInfo.y + 0.5); int style = sty - (sty / 16) * 16; bool shop = (sty / 16) % 2 == 1; bool street = (sty / 32) % 2 == 1;
float seed = vInfo.z / 255.0; float cellW = 0.5 + vInfo.w / 100.0;
vec4 LY = uLayer[layer];
vec2 tuv = kind == 4 ? vMUv : vMUv / LY.w;
vec4 tc = texture(tFacCol, vec3(tuv, float(layer)));
#if FAC_Q > 0
vec4 tn = texture(tFacNrm, vec3(tuv, float(layer)));
gNT = normalize(tn.xyz * 2.0 - 1.0); gRough = tn.a;
#endif
vec3 wallCol = tint * tc.rgb / max(LY.rgb, vec3(0.03));
vec3 Nv = normalize(vNormal);
vec3 q1 = dFdx(-vViewPosition), q2 = dFdy(-vViewPosition); vec2 s1 = dFdx(vMUv), s2 = dFdy(vMUv);
vec3 q2p = cross(q2, Nv), q1p = cross(Nv, q1);
vec3 Tv = q2p * s1.x + q1p * s2.x; vec3 Bv = q2p * s1.y + q1p * s2.y;
float tl = max(dot(Tv, Tv), 1e-24), bl = max(dot(Bv, Bv), 1e-24);
float im = inversesqrt(max(tl, bl));
gTBN = mat3(Tv * im, Bv * im, Nv);
vec3 Vv = normalize(vViewPosition);
vec3 Vt = vec3(dot(Vv, Tv * inversesqrt(tl)), dot(Vv, Bv * inversesqrt(bl)), dot(Vv, Nv));
vec3 col = wallCol;
if (kind == 0 || kind == 7) col = facade(wallCol, tint, Vt, kind, layer, style, shop, street, seed, cellW);
else if (kind == 2 || kind == 3) {
  float up = smoothstep(0.25, 0.7, normalize(vWN).y);
  col = mix(col, vec3(0.92, 0.94, 0.98), uSnow * up); gRough = mix(gRough, 0.6, uSnow * up);
} else if (kind == 4) { col = tc.rgb; gNT = vec3(0.0, 0.0, 1.0); gRough = 0.45; gEmit = tc.rgb * (tc.a * 2.4 + 0.12) * uNight; }
else if (kind == 5) { float st = step(0.5, fract(vMUv.x / 0.32)); col = mix(tint, vec3(0.93, 0.92, 0.88), st); gNT = vec3(0.0, 0.0, 1.0); gRough = 0.85; }
else if (kind == 6) { float bl2 = step(0.5, fract(uTime * 0.6 + seed)); col = tint * 0.4; gEmit = tint * (0.6 + 6.0 * uNight) * (0.35 + 0.65 * bl2); gNT = vec3(0.0, 0.0, 1.0); }
else if (kind == 8) { col = tint * 0.55; gMetal = 0.85; gRough = 0.1; gNT = vec3(0.0, 0.0, 1.0); }
else if (kind == 9) { float band = step(0.5, fract(vMUv.y / 9.0)); col = seed > 0.5 ? mix(vec3(0.75, 0.08, 0.06), vec3(0.92), band) : tint; gMetal = 0.5; gRough = 0.4; gNT = vec3(0.0, 0.0, 1.0); }
col *= mix(1.0, 0.72, uWet * (1.0 - step(0.5, gMetal)));
gRough = mix(gRough, gRough * 0.55, uWet);
diffuseColor.rgb = col;
`;

/** The one material shared by all building chunks (base and detail). */
function facadeMaterial(q) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.0 });
  m.defines = { FAC_Q: q };
  m.customProgramCacheKey = () => `facade${q}`;
  const layerU = { value: Array.from({ length: NLAYERS }, (_, i) => TEX.layer[i] || new THREE.Vector4(0.5, 0.5, 0.5, i < LAYERS.length ? LAYERS[i][1] : 1)) };
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.uniforms.tFacCol = { value: TEX.col };
    sh.uniforms.tFacNrm = { value: TEX.nrm };
    sh.uniforms.uLayer = layerU;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aInfo; attribute vec4 aWin;\nflat varying vec4 vInfo; varying vec4 vWin; varying vec2 vMUv; varying vec3 vWN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvInfo = aInfo; vWin = aWin; vMUv = uv; vWN = normal;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_COMMON}`)
      .replace('#include <color_fragment>', FRAG_MAIN)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = gRough;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = gMetal;')
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nnormal = normalize(gTBN * gNT);')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += gEmit;');
  };
  return m;
}

/** Fallback 1×1 arrays if the preload did not run (e.g. tests). */
function ensureTextures() {
  if (TEX.col) return;
  const mk = (rgba) => {
    const d = new Uint8Array(4 * NLAYERS);
    for (let l = 0; l < NLAYERS; l++) d.set(rgba, l * 4);
    const t = new THREE.DataArrayTexture(d, 1, 1, NLAYERS);
    t.needsUpdate = true;
    return t;
  };
  TEX.col = mk([200, 200, 200, 255]);
  TEX.nrm = mk([128, 128, 255, 215]);
  for (let l = 0; l < NLAYERS; l++) TEX.layer[l] = new THREE.Vector4(0.58, 0.58, 0.58, l < LAYERS.length ? LAYERS[l][1] : 1);
}

// ---------------------------------------------------------------- classification
function classify(rec, env) {
  const { h, mh, A } = rec;
  const r = (k) => hash(rec.bi * 1.37 + k * 7.13);
  rec.parapet = 0;
  rec.roof = 'flat';
  rec.roofLayer = L_FLAT;
  rec.roofCol = color(pick(PAL.flat, r(1)));
  rec.gLayer = null;
  const osm = rec.osmCol;
  const tall = h >= 60 || (h >= 45 && h - mh >= 30);
  if (rec.hero === 'dom') {
    rec.style = S_GOTH;
    rec.layer = L_SAND;
    rec.col = color(pick(PAL.sandRed, r(2)));
    if (h < 35 && A > 100 && mh === 0) {
      rec.roof = 'pitched';
      rec.roofLayer = L_SLATE;
      rec.roofCol = color('#4d5157');
      rec.profile = gableProf(1.6, 14);
    }
    return;
  }
  if (rec.hero === 'roemer') {
    rec.style = S_GOTH;
    rec.layer = L_PLASTER;
    rec.col = color(PAL.roemer[rec.bi % PAL.roemer.length]);
    rec.gLayer = L_SAND;
    rec.gCol = color('#a9705c');
    rec.roof = 'pitched';
    rec.roofLayer = L_SLATE;
    rec.roofCol = color('#4c4f55');
    rec.profile = gableProf(1.7, 16);
    rec.stepped = true;
    rec.gableToStreet = true;
    return;
  }
  if (tall) {
    let glass = r(3) < 0.7;
    if (osm) {
      const hsl = {};
      osm.getHSL(hsl);
      glass = !(hsl.l > 0.75 || (osm.r > osm.b + 0.06 && hsl.l > 0.3));
    }
    if (rec.hero === 'cmz') {
      rec.style = S_CMZ;
      rec.layer = L_GRAN;
      rec.col = color('#7f949f');
    } else if (rec.hero === 'euro') {
      rec.style = S_OFF;
      rec.layer = L_CONC;
      rec.col = color('#d4d6d6');
    } else if (glass) {
      rec.style = S_GLASS;
      rec.layer = L_GRAN;
      rec.col = osm ? osm.clone().lerp(color(pick(PAL.glass, r(4))), 0.5) : color(pick(PAL.glass, r(4)));
    } else {
      rec.style = S_STONE;
      rec.layer = L_GRAN;
      rec.col = osm ? osm.clone() : color(pick(PAL.off, r(4)));
    }
    rec.parapet = 1.2;
    return;
  }
  if (h < 7.5) {
    rec.style = S_SHED;
    rec.layer = r(5) < 0.5 ? L_CONC : L_PLASTER;
    rec.col = color(rec.layer === L_CONC ? pick(PAL.rib, r(6)) : pick(PAL.pw, r(6)));
    rec.parapet = 0.4;
    return;
  }
  if (rec.altstadt) {
    const k = r(7);
    rec.gableToStreet = true;
    rec.roof = 'pitched';
    rec.roofLayer = L_SLATE;
    rec.roofCol = color(pick(PAL.slate, r(8)));
    rec.profile = gableProf(1.5 + r(9) * 0.4, 13);
    if (k < 0.5) {
      rec.style = S_FACH;
      rec.layer = L_PLASTER;
      rec.col = color(pick(PAL.fachInfill, r(10)));
      rec.gLayer = L_SAND;
      rec.gCol = color(pick(PAL.sandRed, r(11)));
    } else {
      rec.style = S_GZ;
      rec.layer = k < 0.8 ? L_PLASTER : L_SAND;
      rec.col = color(k < 0.8 ? pick(PAL.plaster, r(10)) : pick(PAL.sandRed, r(10)));
      rec.gLayer = L_SAND;
      rec.gCol = color(pick(PAL.sandRed, r(11)));
    }
    return;
  }
  const officeLike = h > 24 || A > 2500;
  if (officeLike) {
    const k = r(12);
    if (k < 0.4) {
      rec.style = S_OFF;
      rec.layer = r(13) < 0.5 ? L_GRAN : L_CONC;
      rec.col = color(pick(PAL.off, r(14)));
    } else if (k < 0.7) {
      rec.style = S_RIB;
      rec.layer = L_CONC;
      rec.col = color(pick(PAL.rib, r(14)));
    } else if (k < 0.85) {
      rec.style = S_GLASS;
      rec.layer = L_GRAN;
      rec.col = color(pick(PAL.glass, r(14)));
    } else {
      rec.style = S_PW;
      rec.layer = L_PLASTER;
      rec.col = color(pick(PAL.pw, r(14)));
    }
    rec.parapet = 0.9;
    return;
  }
  if (r(15) < env.pG) {
    rec.style = S_GZ;
    const m = r(16);
    if (m < 0.58) {
      rec.layer = L_PLASTER;
      rec.col = color(pick(PAL.plaster, r(17)));
      if (osm) rec.col.lerp(osm, 0.35);
      rec.gLayer = L_SAND;
      rec.gCol = color(r(18) < 0.6 ? pick(PAL.sandRed, r(19)) : pick(PAL.sandYellow, r(19)));
    } else if (m < 0.85) {
      rec.layer = L_SAND;
      rec.col = color(r(18) < 0.75 ? pick(PAL.sandRed, r(17)) : pick(PAL.sandYellow, r(17)));
    } else {
      rec.layer = L_BRICK;
      rec.col = color(pick(PAL.brick, r(17)));
      rec.gLayer = L_SAND;
      rec.gCol = color(pick(PAL.sandYellow, r(19)));
    }
    rec.roof = 'pitched';
    if (r(20) < 0.5) {
      rec.profile = mansardProf();
      rec.roofLayer = L_SLATE;
      rec.roofCol = color(pick(PAL.slate, r(21)));
    } else {
      rec.profile = gableProf(0.95 + r(22) * 0.25, 7);
      rec.roofLayer = L_TILE;
      rec.roofCol = color(pick(PAL.tile, r(21)));
    }
    return;
  }
  const k = r(23);
  if (k < 0.5) {
    rec.style = S_PW;
    rec.layer = L_PLASTER;
    rec.col = color(pick(PAL.pw, r(24)));
    if (osm) rec.col.lerp(osm, 0.3);
    if (r(25) < 0.45) {
      rec.roof = 'pitched';
      rec.profile = gableProf(0.6, 4.5);
      rec.roofLayer = L_TILE;
      rec.roofCol = color(pick(PAL.tile, r(26)));
    } else rec.parapet = 0.6;
  } else if (k < 0.78) {
    rec.style = S_RIB;
    rec.layer = L_CONC;
    rec.col = color(pick(PAL.rib, r(24)));
    rec.parapet = 0.8;
  } else {
    rec.style = S_MOD;
    rec.layer = L_PLASTER;
    rec.col = color(pick(PAL.mod, r(24)));
    rec.parapet = 0.7;
  }
}

// ---------------------------------------------------------------- main entry
export function buildBuildings(data, phys, buildingIndex) {
  ensureTextures();
  const scene = ctx.scene;
  const quality = ctx.quality || 'medium';
  const qi = { low: 0, medium: 1, high: 2, ultra: 3 }[quality] ?? 1;
  const detailDist = [0, 300, 480, 720][qi];
  const landmarks = [];
  const roads = roadGrid(data.roads || []);
  const names = data.names || [];
  const nameAt = (n) => names.find((x) => x.name === n);
  const nik = nameAt('Glockenturm der Alten Nikolaikirche') || { x: 604.5, z: 129 };
  const roemerC = { x: nik.x - 48, z: nik.z - 2 };
  const domC = { x: nik.x + 178, z: nik.z - 67 };
  const districts = (DISTRICTS || []).map((d) => ({ x: d.x, z: d.z, mix: DISTRICT_MIX[d.n] || [0.5, 0.4] }));

  // ---- pass 1: footprints
  const recs = [];
  data.buildings.forEach((b, bi) => {
    let ring = openRing(b.pts);
    if (ring.length < 3) return;
    const A = area(ring);
    if (Math.abs(A) < 4) return;
    if (A < 0) ring = ring.slice().reverse();
    buildingIndex.add(ring);
    let cx = 0,
      cz = 0;
    for (const p of ring) {
      cx += p[0];
      cz += p[1];
    }
    cx /= ring.length;
    cz /= ring.length;
    let osmCol = null;
    if (b.col >= 0) {
      try {
        osmCol = new THREE.Color().setStyle(String(data.pal[b.col]).split(/[;,]/)[0].trim());
      } catch {
        osmCol = null;
      }
    }
    const rw = String(data.pal[b.col] || '').includes('red');
    recs.push({ bi, ring, A: Math.abs(A), cx, cz, h: Math.max(b.h, b.mh + 2.5), mh: b.mh, sd: hash(bi + 0.5), osmCol, redWhite: rw });
  });

  // ---- landmarks / hero tagging
  const near = (p, r) => recs.filter((q) => Math.hypot(q.cx - p.x, q.cz - p.z) < r);
  const tallest = (list) => list.reduce((a, b) => (!a || b.h > a.h ? b : a), null);
  for (const q of recs) {
    if (q.A < 25 && q.h - q.mh > 12 && q.h > 30) q.hero = 'mast';
  }
  // Kaiserdom: the tallest part near the expected position and everything around it
  const domTop = tallest(near(domC, 45).filter((q) => q.h > 60));
  if (domTop) {
    for (const q of near({ x: domTop.cx + 15, z: domTop.cz }, 55)) {
      q.hero = 'dom';
      if (q.mh > 0 && q.A < 30) q.top = 'spire';
      else if (q.mh > 0 && q.h - q.mh < 12 && q.A < 120) q.top = 'cupola';
    }
  }
  const messe = nameAt('Messeturm');
  if (messe) {
    const parts = near(messe, 40);
    const top = tallest(parts.filter((q) => q.ring.length <= 6));
    if (top) {
      const below = parts.filter((q) => q !== top && q.h < top.h).reduce((m, q) => Math.max(m, q.h), 0);
      top.hero = 'pyramid';
      top.pyrBase = below || top.h * 0.86;
    }
  }
  const cmz = nameAt('Commerzbank Tower');
  if (cmz) for (const q of near(cmz, 45)) if (!q.hero && q.h >= 50) q.hero = 'cmz';
  const euro = nameAt('Eurotower');
  if (euro) for (const q of near(euro, 35)) if (!q.hero && q.h >= 60) q.hero = 'euro';
  const wt = nameAt('Westend Tower');
  if (wt) {
    const t = tallest(near(wt, 90).filter((q) => !q.hero && q.h > 120));
    if (t) t.crown = true;
  }
  const namedTowers = names.filter((n) => n.h >= 60);
  for (const q of recs) {
    if (Math.hypot(q.cx - roemerC.x, q.cz - roemerC.z) < 30 && q.h < 25 && !q.hero) q.hero = 'roemer';
    else if (!q.hero && q.cx > nik.x - 10 && q.cx < nik.x + 125 && q.cz > nik.z - 112 && q.cz < nik.z - 18 && q.A < 450 && q.h < 26 && q.h > 7) q.altstadt = true;
    // generic church / tower spires: slender, mid-height parts
    if (!q.hero && q.mh === 0 && q.A < 150 && q.h > 22 && q.h < 120 && q.h / Math.sqrt(q.A) > 3.2) q.top = 'spire-body';
    q.nearNamed = namedTowers.some((n) => Math.hypot(n.x - q.cx, n.z - q.cz) < 70);
  }

  // ---- pass 2: classification, walls, roofs
  const chunks = new Map(),
    details = new Map();
  const CH = 450,
    CHD = 225;
  const getGB = (map, size, x, z) => {
    const key = `${Math.floor(x / size)},${Math.floor(z / size)}`;
    let gb = map.get(key);
    if (!gb) map.set(key, (gb = new FacadeBuilder()));
    return gb;
  };
  for (const rec of recs) {
    const gb = getGB(chunks, CH, rec.cx, rec.cz);
    const gd = detailDist > 0 ? getGB(details, CHD, rec.cx, rec.cz) : null;
    // district
    let best = null,
      bd = Infinity;
    for (const d of districts) {
      const dd = Math.hypot(d.x - rec.cx, d.z - rec.cz);
      if (dd < bd) {
        bd = dd;
        best = d;
      }
    }
    const env = { pG: best ? best.mix[0] : 0.5, pShop: best ? best.mix[1] : 0.4 };
    classify(rec, env);
    if (rec.h > 60) landmarks.push({ x: rec.cx, z: rec.cz, h: rec.h });
    try {
      buildOne(rec, gb, gd, env, roads, buildingIndex);
    } catch (e) {
      console.warn('[buildings] failed', rec.bi, e);
    }
  }

  // ---- meshes
  const mat = (ctx.mats.building = facadeMaterial(qi === 0 ? 0 : qi === 1 ? 1 : 2));
  for (const gb of chunks.values()) {
    if (!gb.count) continue;
    const g = gb.build();
    const m = new THREE.Mesh(g, mat);
    m.castShadow = m.receiveShadow = true;
    m.name = 'buildings';
    scene.add(m);
    phys.push(g);
  }
  for (const [key, gd] of details) {
    if (!gd.count) continue;
    const [kx, kz] = key.split(',').map(Number);
    const cx = (kx + 0.5) * CHD,
      cz = (kz + 0.5) * CHD;
    const g = gd.build();
    const m = new THREE.Mesh(g, mat);
    m.position.set(-cx, 0, -cz);
    m.castShadow = qi >= 2;
    m.receiveShadow = true;
    m.name = 'building-details';
    const lod = new THREE.LOD();
    lod.position.set(cx, 0, cz);
    lod.addLevel(m, 0);
    lod.addLevel(new THREE.Object3D(), detailDist);
    scene.add(lod);
  }
  return landmarks;
}

// ---------------------------------------------------------------- per-building geometry
function buildOne(rec, gb, gd, env, roads, buildingIndex) {
  const { ring, h, mh, cx, cz, sd } = rec;
  const n = ring.length;
  if (rec.hero === 'mast') {
    const r = Math.max(0.35, Math.min(1.6, Math.sqrt(rec.A / Math.PI)));
    mast(gb, cx, cz, mh, h, r, rec.redWhite || h > 150, sd);
    return;
  }
  if (rec.hero === 'pyramid') {
    // Messeturm: glazed pyramid roof with an aviation light on the apex
    pyramid(gb, ring, rec.pyrBase, [cx, h, cz], color('#5b3b35'), info(K_GLASS, 0, 0, sd));
    box(gb, cx, h - 0.2, cz, 0.5, 0.5, 0.5, [1, 0], new THREE.Color(1, 0.08, 0.04), info(K_LIGHT, 0, 0, sd));
    return;
  }
  if (rec.top === 'spire' && rec.hero === 'dom') {
    pyramid(gb, ring, mh, [cx, h, cz], color('#9c5b48'), info(K_TRIM, L_SAND, S_GOTH, sd));
    return;
  }
  if (rec.top === 'cupola') {
    taper(gb, ring, cx, cz, mh, h, 0.45, color('#a8644f'), info(K_TRIM, L_SAND, S_GOTH, sd));
    return;
  }
  const st = STY[rec.style];
  const spireBody = rec.top === 'spire-body' || (rec.top === 'spire' && rec.hero !== 'dom');
  const spireH = spireBody ? Math.min(0.42 * (h - mh), 2.4 * Math.sqrt(rec.A)) : 0;
  const bodyH = h - spireH;

  // ---- per-wall analysis: party walls, street frontage
  const walls = [];
  let streetLen = 0,
    streetDir = null,
    pedSt = false;
  for (let i = 0; i < n; i++) {
    const a = ring[i],
      c = ring[(i + 1) % n];
    const dx = c[0] - a[0],
      dz = c[1] - a[1],
      L = Math.hypot(dx, dz);
    const w = { a, c, L, nx: L ? dz / L : 0, nz: L ? -dx / L : 0, party: false, street: false };
    walls.push(w);
    if (L < 0.05) continue;
    const mx = (a[0] + c[0]) / 2,
      mz = (a[1] + c[1]) / 2;
    if (h < 45 && buildingIndex.inside(mx + w.nx * 0.7, mz + w.nz * 0.7)) {
      w.party = true;
      continue;
    }
    for (const d of [1.5, 4, 8, 13]) {
      const r = roads.near(mx + w.nx * d, mz + w.nz * d);
      if (r.d < 1.2) {
        const s = r.seg;
        const sl = Math.hypot(s[2] - s[0], s[3] - s[1]) || 1;
        if (Math.abs(((s[2] - s[0]) * dx + (s[3] - s[1]) * dz) / (sl * L)) > 0.5) {
          w.street = true;
          w.ped = s[5];
          if (L > streetLen) {
            streetLen = L;
            streetDir = [dx / L, dz / L];
          }
          if (s[5]) pedSt = true;
        }
        break;
      }
    }
  }
  // ---- shops
  const shopStyle = [S_GZ, S_PW, S_RIB, S_MOD, S_FACH, S_OFF].includes(rec.style);
  const buildingShop = shopStyle && hash(rec.bi * 3.3 + 1.1) < (pedSt ? 0.92 : env.pShop);
  // ---- floors
  const shop = buildingShop && walls.some((w) => w.street);
  let gH = shop ? st.gHs : st.gH;
  let fh = st.fh;
  const margin = rec.roof === 'pitched' ? 0.45 : 0.6;
  const avail = Math.max(0.5, bodyH - margin - gH);
  if (rec.style === S_SHED || bodyH - margin < gH + fh * 0.6) {
    gH = rec.style === S_SHED ? 99 : Math.max(2.5, bodyH - margin);
    fh = Math.max(2.5, bodyH - margin);
  } else {
    const nf = Math.max(1, Math.round(avail / fh));
    fh = avail / nf;
  }
  if (rec.style === S_SHED) fh = Math.max(2.6, bodyH);

  // ---- roof axis / profile
  let prof = rec.roof === 'pitched' && !spireBody ? rec.profile : null;
  let ax = 0,
    az = 0,
    smin = 0,
    smax = 0,
    cuts = [];
  if (prof) {
    if (rec.A < 40 || rec.A > 2600 || n > 40) prof = null;
  }
  if (prof) {
    let rdir = streetDir || longAxis(ring);
    if (rec.hero === 'roemer') rdir = [1, 0];
    else if (rec.gableToStreet && streetDir) rdir = [-streetDir[1], streetDir[0]];
    ax = -rdir[1];
    az = rdir[0];
    smin = Infinity;
    smax = -Infinity;
    for (const p of ring) {
      const s = p[0] * ax + p[1] * az;
      smin = Math.min(smin, s);
      smax = Math.max(smax, s);
    }
    const w = smax - smin;
    if (w > 34 || w < 3) prof = null;
    else {
      const set = new Set();
      for (let i = 1; i < prof.length; i++) {
        const d = prof[i][0];
        if (d < w / 2 - 0.05) {
          set.add(smin + d);
          set.add(smax - d);
        }
      }
      if (prof[prof.length - 1][0] > w / 2) set.add((smin + smax) / 2);
      cuts = [...set].sort((a, b) => a - b);
    }
  }
  const sOf = (x, z) => x * ax + z * az;
  const topAt = prof ? (x, z) => bodyH + profAt(prof, Math.min(sOf(x, z) - smin, smax - sOf(x, z))) : () => bodyH + (spireBody ? 0 : rec.parapet);
  const ridgeRise = prof ? profAt(prof, (smax - smin) / 2) : 0;

  // ---- walls
  const uOff = Math.floor(sd * 40) * 1.7;
  let per = 0;
  const seedB = hash(rec.bi * 0.77);
  for (let i = 0; i < n; i++) {
    const w = walls[i];
    const { a, c, L } = w;
    if (L < 0.05) continue;
    const N = [w.nx, 0, w.nz];
    const winOK = !w.party && L >= 1.6;
    const ncell = winOK ? Math.max(1, Math.round(L / st.cell)) : 1;
    const cellW = winOK ? L / ncell : 2;
    const cx0 = Math.floor(hash(rec.bi * 1.9 + i * 3.7) * 40);
    const wShop = shop && w.street && L > 3;
    const bits = rec.style | (wShop ? 16 : 0) | (w.street ? 32 : 0);
    const kind = winOK ? K_FACADE : K_TRIM;
    // split points along the edge (roof profile kinks)
    const ts = [0];
    if (prof) {
      const sa = sOf(a[0], a[1]),
        sc = sOf(c[0], c[1]);
      if (Math.abs(sc - sa) > 1e-6) {
        for (const k of cuts) {
          const t = (k - sa) / (sc - sa);
          if (t > 1e-4 && t < 1 - 1e-4) ts.push(t);
        }
      }
    }
    ts.push(1);
    ts.sort((x, y) => x - y);
    const P = (t) => [a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t];
    const bands = [];
    if (rec.gLayer != null && gH < bodyH - 1 && gH > mh + 0.5) {
      bands.push([mh, gH, rec.gLayer, rec.gCol]);
      bands.push([gH, null, rec.layer, rec.col]);
    } else bands.push([mh, null, rec.layer, rec.col]);
    for (const [y0, y1, layer, col] of bands) {
      const inf = info(kind, layer, bits, seedB, cellW);
      for (let k = 0; k < ts.length - 1; k++) {
        const t0 = ts[k],
          t1 = ts[k + 1];
        const p0 = P(t0),
          p1 = P(t1);
        let top0 = y1 ?? topAt(p0[0], p0[1]),
          top1 = y1 ?? topAt(p1[0], p1[1]);
        const stepped = rec.stepped && y1 == null && (top0 > bodyH + 0.3 || top1 > bodyH + 0.3);
        if (stepped) top0 = top1 = bodyH;
        const win0 = [cx0 + t0 * ncell, fh, gH, (y1 == null && !stepped ? top0 : topAt(p0[0], p0[1])) - margin];
        const win1 = [cx0 + t1 * ncell, fh, gH, (y1 == null && !stepped ? top1 : topAt(p1[0], p1[1])) - margin];
        face(
          gb,
          [
            [p0[0], y0, p0[1], uOff + per + t0 * L, y0],
            [p1[0], y0, p1[1], uOff + per + t1 * L, y0],
            [p1[0], top1, p1[1], uOff + per + t1 * L, top1],
            [p0[0], top0, p0[1], uOff + per + t0 * L, top0],
          ],
          N,
          col,
          inf,
          [win0, win1, win1, win0],
        );
        if (stepped) {
          // Römer stepped gable: a staircase above the roof line (front and back faces)
          const f0 = topAt(p0[0], p0[1]),
            f1 = topAt(p1[0], p1[1]);
          const ns = Math.max(1, Math.round(Math.abs(f1 - f0) / 1.15));
          for (let j = 0; j < ns; j++) {
            const ta = j / ns,
              tb = (j + 1) / ns;
            const q0 = [p0[0] + (p1[0] - p0[0]) * ta, p0[1] + (p1[1] - p0[1]) * ta],
              q1 = [p0[0] + (p1[0] - p0[0]) * tb, p0[1] + (p1[1] - p0[1]) * tb];
            const yTop = Math.max(f0 + (f1 - f0) * ta, f0 + (f1 - f0) * tb) + 0.35;
            const ua = uOff + per + (t0 + (t1 - t0) * ta) * L,
              ub = uOff + per + (t0 + (t1 - t0) * tb) * L;
            const cA = cx0 + (t0 + (t1 - t0) * ta) * ncell,
              cB = cx0 + (t0 + (t1 - t0) * tb) * ncell;
            const wA = [cA, fh, gH, yTop - 0.5],
              wB = [cB, fh, gH, yTop - 0.5];
            const quad = [
              [q0[0], bodyH, q0[1], ua, bodyH],
              [q1[0], bodyH, q1[1], ub, bodyH],
              [q1[0], yTop, q1[1], ub, yTop],
              [q0[0], yTop, q0[1], ua, yTop],
            ];
            face(gb, quad, N, col, inf, [wA, wB, wB, wA]);
            face(gb, quad, [-N[0], 0, -N[2]], col, info(K_TRIM, layer, bits, seedB), [wA, wB, wB, wA]);
            face(
              gb,
              [
                [q0[0], yTop, q0[1], ua, 0],
                [q1[0], yTop, q1[1], ub, 0],
                [q1[0] - N[0] * 0.4, yTop, q1[1] - N[2] * 0.4, ub, 0.4],
                [q0[0] - N[0] * 0.4, yTop, q0[1] - N[2] * 0.4, ua, 0.4],
              ],
              [0, 1, 0],
              col,
              info(K_TRIM, L_SAND, bits, seedB),
            );
          }
        }
      }
    }
    // ---- detail geometry for this wall
    if (gd) wallDetail(gd, rec, w, i, { bodyH, gH, prof, topAt, per, uOff, wShop, cellW, ncell, cx0, ts, P, seedB, bits, ridgeRise });
    per += L;
  }

  // ---- underside of floating parts
  if (mh > 0.5) {
    const tris = triangulate(ring);
    polyTris(
      gb,
      ring.map((p) => [p[0], mh, p[1], p[0], p[1]]),
      tris,
      rec.col,
      info(K_TRIM, rec.layer, 0, sd),
      false,
    );
  }

  // ---- roofs
  const roofInf = info(prof ? K_ROOF : K_FLAT, prof ? rec.roofLayer : L_FLAT, 0, sd);
  if (spireBody) {
    const roofCol = hash(rec.bi * 5.5) < 0.35 ? color('#5f8f7c') : color('#4a4d52');
    pyramid(gb, ring, bodyH, [cx, h, cz], roofCol, info(K_ROOF, L_SLATE, 0, sd));
  } else if (prof) {
    const bounds = [smin, ...cuts, smax];
    const rx = -az,
      rz = ax;
    for (let k = 0; k < bounds.length - 1; k++) {
      const lo = bounds[k],
        hi = bounds[k + 1];
      if (hi - lo < 0.02) continue;
      const poly = clipStrip(ring, ax, az, lo, hi);
      if (poly.length < 3) continue;
      const mid = (lo + hi) / 2;
      const dd = Math.min(mid - smin, smax - mid);
      const kSlope = (profAt(prof, dd + 0.01) - profAt(prof, dd - 0.01)) / 0.02;
      const sec = Math.sqrt(1 + kSlope * kSlope);
      const sgn = mid - smin < smax - mid ? 1 : -1;
      const verts = poly.map((p) => {
        const y = topAt(p[0], p[1]);
        const s = sOf(p[0], p[1]);
        return [p[0], y, p[1], p[0] * rx + p[1] * rz, kSlope > 0.05 ? sgn * s * sec : s];
      });
      polyTris(gb, verts, triangulate(poly), rec.roofCol, roofInf);
    }
  } else {
    const tris = triangulate(ring);
    polyTris(
      gb,
      ring.map((p) => [p[0], bodyH, p[1], p[0], p[1]]),
      tris,
      rec.roofCol,
      roofInf,
    );
    // tower roof crowns: plant-room penthouse, glass crown, antenna or crown fins
    if (rec.style === S_GLASS || rec.style === S_STONE || rec.style === S_OFF || rec.style === S_CMZ) {
      if (rec.h >= 60 && !rec.nearNamed && rec.A > 250) {
        const s = Math.max(0.45, 1 - 5 / Math.sqrt(rec.A));
        taper(gb, ring, cx, cz, bodyH, bodyH + 4 + hash(rec.bi) * 3, s, color('#8a8c8e'), info(K_TRIM, L_CONC, 0, sd), info(K_FLAT, L_FLAT, 0, sd));
      }
    }
  }
  if (rec.crown) crown(gb, ring, cx, cz, bodyH);

  // ---- roof details (dormers, chimneys)
  if (gd && prof) roofDetail(gd, rec, { ax, az, smin, smax, prof, bodyH, topAt, walls, gH, fh, ridgeRise, cellW: STY[rec.style].cell });
  if (gd && !prof && rec.parapet > 0 && !spireBody) parapetCaps(gd, rec, walls, bodyH);
}

/** Westend Tower: ring of white fins flaring outwards above the roof. */
function crown(gb, ring, cx, cz, y0) {
  const per = [];
  let tot = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i],
      b = ring[(i + 1) % ring.length];
    per.push(tot);
    tot += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  const nf = 36;
  const col = color('#e8eaec');
  for (let k = 0; k < nf; k++) {
    const d = (k / nf) * tot;
    let
      i = 0;
    while (i < ring.length - 1 && per[i + 1] <= d) i++;
    const a = ring[i],
      b = ring[(i + 1) % ring.length];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const t = (d - per[i]) / L;
    const x = a[0] + (b[0] - a[0]) * t,
      z = a[1] + (b[1] - a[1]) * t;
    const ox = x - cx,
      oz = z - cz,
      ol = Math.hypot(ox, oz) || 1;
    const dx = ox / ol,
      dz = oz / ol;
    const px = -dz * 0.5,
      pz = dx * 0.5;
    const quad = [
      [x - px, y0, z - pz, 0, y0],
      [x + px, y0, z + pz, 1, y0],
      [x + px + dx * 5, y0 + 22, z + pz + dz * 5, 1, y0 + 22],
      [x - px + dx * 5, y0 + 22, z - pz + dz * 5, 0, y0 + 22],
    ];
    face(gb, quad, [dx, 0, dz], col, info(K_METAL, 0, 0, 0.1));
    face(gb, quad, [-dx, 0, -dz], col, info(K_METAL, 0, 0, 0.1));
  }
}

/** Cornices, floor bands, shop signs and awnings for one wall (detail LOD). */
function wallDetail(gd, rec, w, wi, o) {
  const { a, c, L, nx, nz } = w;
  const dx = (c[0] - a[0]) / L,
    dz = (c[1] - a[1]) / L;
  const sd = rec.sd;
  const trimCol = rec.layer === L_PLASTER ? rec.col.clone().lerp(new THREE.Color(1, 1, 1), 0.35) : rec.col.clone().multiplyScalar(1.08);
  const trimInf = info(K_TRIM, rec.layer === L_BRICK ? L_SAND : rec.layer, 0, sd);
  const strip = (p0, p1, y0, y1, out, slopeTop) => {
    // protruding band: front, underside, top
    const e0 = [p0[0] - dx * out, p0[1] - dz * out],
      e1 = [p1[0] + dx * out, p1[1] + dz * out];
    const f0 = [e0[0] + nx * out, e0[1] + nz * out],
      f1 = [e1[0] + nx * out, e1[1] + nz * out];
    const ll = Math.hypot(e1[0] - e0[0], e1[1] - e0[1]);
    face(
      gd,
      [
        [f0[0], y0, f0[1], 0, y0],
        [f1[0], y0, f1[1], ll, y0],
        [f1[0], y1, f1[1], ll, y1],
        [f0[0], y1, f0[1], 0, y1],
      ],
      [nx, 0, nz],
      trimCol,
      trimInf,
    );
    face(
      gd,
      [
        [e0[0], y0, e0[1], 0, 0],
        [e1[0], y0, e1[1], ll, 0],
        [f1[0], y0, f1[1], ll, out],
        [f0[0], y0, f0[1], 0, out],
      ],
      [0, -1, 0],
      trimCol.clone().multiplyScalar(0.8),
      trimInf,
    );
    const yt = y1 + (slopeTop || 0);
    const ny = out,
      nyy = Math.hypot(ny, slopeTop || 0) || 1;
    face(
      gd,
      [
        [f0[0], y1, f0[1], 0, 0],
        [f1[0], y1, f1[1], ll, 0],
        [e1[0], yt, e1[1], ll, out],
        [e0[0], yt, e0[1], 0, out],
      ],
      [(nx * (slopeTop || 0)) / nyy, ny / nyy, (nz * (slopeTop || 0)) / nyy],
      trimCol,
      trimInf,
    );
  };
  const ornate = rec.style === S_GZ || rec.style === S_GOTH || rec.style === S_FACH;
  if (!w.party && L > 1) {
    // eave cornice on sub-segments that sit at the eave height
    for (let k = 0; k < o.ts.length - 1; k++) {
      const p0 = o.P(o.ts[k]),
        p1 = o.P(o.ts[k + 1]);
      const t0 = o.topAt(p0[0], p0[1]),
        t1 = o.topAt(p1[0], p1[1]);
      const atEave = Math.abs(t0 - o.bodyH) < 0.05 && Math.abs(t1 - o.bodyH) < 0.05;
      if (!atEave) continue;
      if (o.prof && ornate) strip(p0, p1, o.bodyH - 0.55, o.bodyH - 0.05, 0.42, 0.25);
      else if (o.prof) strip(p0, p1, o.bodyH - 0.3, o.bodyH - 0.02, 0.3, 0.12);
      else if (ornate) strip(p0, p1, o.bodyH - 0.6, o.bodyH, 0.4, 0);
    }
    // floor band above the ground floor
    if ((rec.style === S_GZ || rec.style === S_GOTH) && o.gH < o.bodyH - 2) strip(a, c, o.gH, o.gH + 0.3, 0.12, 0.08);
  }
  // shop sign + awning + Apotheke cross sign
  if (o.wShop && L >= 3.5) {
    const type = Math.floor(hash(rec.bi * 9.1 + wi * 1.3) * 15);
    const sg = SIGNS[type];
    const sw = Math.min(L * 0.7, 5.5),
      shh = 0.55;
    const mid = 0.5;
    const mx = a[0] + (c[0] - a[0]) * mid,
      mz = a[1] + (c[1] - a[1]) * mid;
    const y0 = o.gH - 0.85,
      y1 = y0 + shh;
    const off = 0.08;
    const aspect = Math.min(8, sw / shh);
    const u0 = 0.5 - aspect / 16,
      u1 = 0.5 + aspect / 16;
    const layer = L_SIGN + Math.floor(type / 8);
    const row = type % 8;
    const v0 = 1 - (row + 1) / 8 + 0.004,
      v1 = 1 - row / 8 - 0.004;
    const sx0 = mx - dx * sw * 0.5 + nx * off,
      sz0 = mz - dz * sw * 0.5 + nz * off;
    const sx1 = mx + dx * sw * 0.5 + nx * off,
      sz1 = mz + dz * sw * 0.5 + nz * off;
    face(
      gd,
      [
        [sx0, y0, sz0, u0, v0],
        [sx1, y0, sz1, u1, v0],
        [sx1, y1, sz1, u1, v1],
        [sx0, y1, sz0, u0, v1],
      ],
      [nx, 0, nz],
      new THREE.Color(1, 1, 1),
      info(K_SIGN, layer, 0, sd),
    );
    if (sg[4]) {
      // fabric awning below the sign
      const ya = y0 - 0.12,
        out = 1.3,
        drop = 0.55;
      const ac = color(sg[4]);
      const q = [
        [sx0, ya, sz0, 0, 0],
        [sx1, ya, sz1, sw, 0],
        [sx1 + nx * out, ya - drop, sz1 + nz * out, sw, 1],
        [sx0 + nx * out, ya - drop, sz0 + nz * out, 0, 1],
      ];
      const nl = Math.hypot(drop, out);
      face(gd, q, [(nx * drop) / nl, out / nl, (nz * drop) / nl], ac, info(K_AWNING, 0, 0, sd));
      face(gd, q, [(-nx * drop) / nl, -out / nl, (-nz * drop) / nl], ac.clone().multiplyScalar(0.6), info(K_AWNING, 0, 0, sd));
    }
    if (type === 0) {
      // projecting red "A" at the end of the frontage
      const ex = sx1 + dx * 0.4,
        ez = sz1 + dz * 0.4;
      const ya = o.gH + 0.2;
      const s = 0.7;
      const uA = 0.0,
        uB = 1 / 8;
      const vA = 1 - 8 / 8 + 0.004,
        vB = 1 - 7 / 8 - 0.004;
      const q = [
        [ex + nx * 0.15, ya, ez + nz * 0.15, uA, vA],
        [ex + nx * (0.15 + s), ya, ez + nz * (0.15 + s), uB, vA],
        [ex + nx * (0.15 + s), ya + s, ez + nz * (0.15 + s), uB, vB],
        [ex + nx * 0.15, ya + s, ez + nz * 0.15, uA, vB],
      ];
      face(gd, q, [dx, 0, dz], new THREE.Color(1, 1, 1), info(K_SIGN, L_SIGN + 1, 0, sd));
      face(gd, q, [-dx, 0, -dz], new THREE.Color(1, 1, 1), info(K_SIGN, L_SIGN + 1, 0, sd));
    }
  }
}

/** Inner face and coping of flat-roof parapets (detail LOD). */
function parapetCaps(gd, rec, walls, bodyH) {
  const top = bodyH + rec.parapet;
  const col = rec.style === S_GLASS || rec.style === S_CMZ ? color('#7d8287') : rec.col.clone().multiplyScalar(0.92);
  const inf = info(K_TRIM, rec.style === S_GLASS || rec.style === S_CMZ ? L_CONC : rec.layer, 0, rec.sd);
  for (const w of walls) {
    if (w.L < 0.3 || w.party) continue;
    const { a, c, nx, nz, L } = w;
    const t = 0.25;
    const ia = [a[0] - nx * t, a[1] - nz * t],
      ic = [c[0] - nx * t, c[1] - nz * t];
    face(
      gd,
      [
        [ia[0], bodyH, ia[1], 0, bodyH],
        [ic[0], bodyH, ic[1], L, bodyH],
        [ic[0], top, ic[1], L, top],
        [ia[0], top, ia[1], 0, top],
      ],
      [-nx, 0, -nz],
      col,
      inf,
    );
    face(
      gd,
      [
        [a[0], top, a[1], 0, 0],
        [c[0], top, c[1], L, 0],
        [ic[0], top, ic[1], L, t],
        [ia[0], top, ia[1], 0, t],
      ],
      [0, 1, 0],
      col,
      inf,
    );
  }
}

/** Dormers along eave walls and brick chimneys on pitched roofs (detail LOD). */
function roofDetail(gd, rec, o) {
  const { ax, az, smin, smax, prof, bodyH, topAt, walls } = o;
  const rx = -az,
    rz = ax;
  const w = smax - smin;
  const sd = rec.sd;
  const roofCol = rec.roofCol;
  const roofInf = info(K_ROOF, rec.roofLayer, 0, sd);
  const mans = prof.length > 2;
  // dormers
  if (rec.style !== S_GOTH && w > 6 && o.ridgeRise > 2.5) {
    const d0 = mans ? 0.35 : 0.9;
    const hd = mans ? 2.1 : 1.6;
    const base = bodyH + profAt(prof, d0) - 0.15;
    const yT = base + hd;
    const dTop = profInv(prof, yT + 0.1 - bodyH);
    if (dTop != null && dTop < w / 2 - 0.3) {
      for (const wl of walls) {
        if (wl.party || wl.L < 4.5) continue;
        const dx = (wl.c[0] - wl.a[0]) / wl.L,
          dz = (wl.c[1] - wl.a[1]) / wl.L;
        if (Math.abs(dx * rx + dz * rz) < 0.97) continue;
        const sA = wl.a[0] * ax + wl.a[1] * az;
        if (Math.abs(topAt(wl.a[0], wl.a[1]) - bodyH) > 0.05 || Math.abs(topAt(wl.c[0], wl.c[1]) - bodyH) > 0.05) continue;
        // inward direction towards the ridge
        const inS = sA - smin < smax - sA ? 1 : -1;
        const ix = ax * inS,
          iz = az * inS;
        const nd = Math.floor((wl.L - 1.5) / 3.0);
        if (nd < 1) continue;
        const span = wl.L / nd;
        const dw = Math.min(1.5, span * 0.5) / 2;
        for (let k = 0; k < nd; k++) {
          if (hash(rec.bi * 2.1 + k * 0.7 + wl.L) < 0.2) continue;
          const t = (k + 0.5) * span;
          const px = wl.a[0] + dx * t,
            pz = wl.a[1] + dz * t;
          const fx = px + ix * d0,
            fz = pz + iz * d0;
          const bx = px + ix * dTop,
            bz = pz + iz * dTop;
          if (!pip(bx, bz, rec.ring)) continue;
          const L0 = [fx - dx * dw, fz - dz * dw],
            L1 = [fx + dx * dw, fz + dz * dw];
          const inf = info(K_DORMER, rec.layer === L_BRICK ? L_PLASTER : rec.layer, rec.style, sd, dw * 2);
          const wv = [
            [0, hd, base, yT],
            [1, hd, base, yT],
          ];
          face(
            gd,
            [
              [L0[0], base, L0[1], 0, base],
              [L1[0], base, L1[1], dw * 2, base],
              [L1[0], yT, L1[1], dw * 2, yT],
              [L0[0], yT, L0[1], 0, yT],
            ],
            [-ix, 0, -iz],
            rec.layer === L_BRICK ? color('#e7e1d3') : rec.col,
            inf,
            [wv[0], wv[1], wv[1], wv[0]],
          );
          for (const sgn of [-1, 1]) {
            const sx = fx + dx * dw * sgn,
              sz = fz + dz * dw * sgn;
            const tri = [
              [sx, base, sz, 0, base],
              [sx, yT, sz, 0, yT],
              [sx + ix * (dTop - d0), yT, sz + iz * (dTop - d0), dTop - d0, yT],
            ];
            face(gd, tri, [dx * sgn, 0, dz * sgn], rec.col.clone().multiplyScalar(0.9), info(K_TRIM, rec.roofLayer, 0, sd));
          }
          const ov = 0.18;
          const r0 = [fx - ix * ov - dx * (dw + ov), fz - iz * ov - dz * (dw + ov)],
            r1 = [fx - ix * ov + dx * (dw + ov), fz - iz * ov + dz * (dw + ov)];
          face(
            gd,
            [
              [r0[0], yT, r0[1], 0, 0],
              [r1[0], yT, r1[1], dw * 2, 0],
              [r1[0] + ix * (dTop - d0 + ov), yT + 0.12, r1[1] + iz * (dTop - d0 + ov), dw * 2, dTop - d0],
              [r0[0] + ix * (dTop - d0 + ov), yT + 0.12, r0[1] + iz * (dTop - d0 + ov), 0, dTop - d0],
            ],
            [0, 1, 0],
            roofCol,
            roofInf,
          );
        }
      }
    }
  }
  // chimneys near the ridge
  const sMid = (smin + smax) / 2;
  let t0 = Infinity,
    t1 = -Infinity;
  for (const p of rec.ring) {
    const t = p[0] * rx + p[1] * rz;
    t0 = Math.min(t0, t);
    t1 = Math.max(t1, t);
  }
  const nc = t1 - t0 > 14 ? 2 : 1;
  for (let k = 0; k < nc; k++) {
    const tt = t0 + (t1 - t0) * (0.2 + 0.6 * hash(rec.bi * 4.4 + k * 1.7));
    const so = sMid + (hash(rec.bi * 6.1 + k) - 0.5) * Math.min(3, w * 0.3);
    const x = rx * tt + ax * so,
      z = rz * tt + az * so;
    if (!pip(x, z, rec.ring)) continue;
    const y0 = topAt(x, z) - 0.6;
    const yTop = bodyH + o.ridgeRise + 0.9;
    box(gd, x, y0, z, 0.35, (yTop - y0) / 2, 0.45, [rx, rz], color('#8a4a3a'), info(K_TRIM, L_BRICK, 0, rec.sd));
  }
}
