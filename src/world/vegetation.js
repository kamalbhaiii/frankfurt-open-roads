/**
 * Greenery: park lawns, river-bank meadows, hedges, flower beds, grass tufts and trees.
 * OWNER: greenery agent. Entry point: buildVegetation(data, river, buildingIndex) -> treeColliders.
 *
 * Trees are five species typical for Frankfurt (Linde, Platane, Rosskastanie, Ahorn, Birke),
 * grown procedurally once per session with a space-colonisation algorithm (trunk + branch tubes
 * with a CC0 bark texture, alpha-tested leaf-cluster cards from a CC0 leaf atlas).
 * Three LODs: full mesh near, reduced mesh mid, camera-facing impostor far (all instanced,
 * dithered cross-fades). The impostor atlas is rendered from the near meshes at build time, so
 * it always matches the current season.
 *
 * Seasons follow the real month (debug override: ?month=0..11): fresh green in spring, deep
 * green in summer, species-specific autumn colours and thinning crowns in Oct/Nov, bare
 * branches (twig cards) Dec–Feb. Leaves sway in the wind (uniforms.uTime, ctx.env wind).
 *
 * Leaf atlas encoding (textures/vegetation/foliage_atlas.png, 4x2 cells of 512 px):
 * R = leaf detail luminance, G = per-leaf random id, B = wood (twig) flag, A = coverage.
 * Cells: 0 linden, 1 plane, 2 horse chestnut, 3 maple, 4 birch, 5 hedge (tiling), 6 grass, 7 flowers.
 */
import * as THREE from 'three';
import { ctx } from '../core/context.js';
import { RC, roadWidth, QUALITY, KERB } from '../core/config.js';
import { area, pip, openRing, offsetLine, lerp, bounds, segDist, SpatialGrid, createRng, hash } from '../core/math.js';
import { GeoBuilder, addFlatPoly } from './geometry.js';
import { uniforms } from './materials.js';
import { assets } from '../core/assets.js';

const TEX = 'textures/vegetation/';
const tex = {};
const loader = new THREE.TextureLoader();
const loadTex = (name, srgb, repeat) =>
  loader.loadAsync(TEX + name).then(
    (t) => {
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = 4;
      tex[name] = t;
    },
    () => {
      console.warn(`[vegetation] missing texture ${name}`);
      tex[name] = null;
    },
  );
assets.preload('vegetation', () =>
  Promise.all([
    loadTex('foliage_atlas.png', false, false),
    loadTex('bark_color.jpg', true, true),
    loadTex('bark_normal.jpg', false, true),
    loadTex('bark_plane_color.jpg', true, true),
    loadTex('grass_color.jpg', true, true),
  ]),
);

/** Local uniforms (shared by all greenery materials). */
const U = {
  uCam: { value: new THREE.Vector3() },
  uWind: { value: 0.4 },
  uCapture: { value: 0 },
  uSeason: { value: new THREE.Vector4(1, 0, 0, 1) }, // density, turn, litter, flowers
};

// ---------------------------------------------------------------- species & seasons
const SPECIES = [
  // h: height at scale 1; trunk: clear bole; cy/rx/ry: crown ellipsoid (fractions of h); trop: upward tropism
  { name: 'linden', cell: 0, h: 17, trunk: 3.0, cy: 0.6, rx: 0.27, ry: 0.36, trop: 0.35, trunkR: 0.3, card: 2.2, cards: 300, turn: 0, bark: 0x9a9088,
    summer: [0x3b5a1e, 0x6f8c2e], autumn: [0xc49a22, 0xe2c348] },
  { name: 'plane', cell: 1, h: 21, trunk: 3.4, cy: 0.6, rx: 0.34, ry: 0.32, trop: 0.12, trunkR: 0.42, card: 2.6, cards: 280, turn: -0.12, bark: 0xffffff,
    summer: [0x3a5722, 0x627f2c], autumn: [0x8e6b2c, 0xbf9a40] },
  { name: 'chestnut', cell: 2, h: 16, trunk: 2.6, cy: 0.57, rx: 0.36, ry: 0.36, trop: 0.08, trunkR: 0.36, card: 2.6, cards: 290, turn: 0.18, bark: 0x7d7064,
    summer: [0x2c4a18, 0x4d6c22], autumn: [0x8f4c1c, 0xc58a33] },
  { name: 'maple', cell: 3, h: 15, trunk: 2.6, cy: 0.6, rx: 0.34, ry: 0.34, trop: 0.18, trunkR: 0.3, card: 2.3, cards: 290, turn: 0.05, bark: 0x8a8480,
    summer: [0x395a1c, 0x6b8b2c], autumn: [0xc4401a, 0xe8a32a] },
  { name: 'birch', cell: 4, h: 16, trunk: 2.4, cy: 0.62, rx: 0.19, ry: 0.36, trop: 0.5, trunkR: 0.2, card: 1.7, cards: 330, turn: 0.12, bark: 0xffffff,
    summer: [0x4c6c22, 0x86a03c], autumn: [0xcfa526, 0xead14e], birch: true },
];
const SP = Object.fromEntries(SPECIES.map((s, i) => [s.name, i]));

function currentMonth() {
  const q = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('month') : null;
  return q != null && q !== '' && !isNaN(+q) ? ((+q % 12) + 12) % 12 : new Date().getMonth();
}
/** density of leaves kept, fraction turned to autumn colour, leaf litter on the ground, flowers in beds, spring freshness, lawn dryness */
const SEASONS = [
  [0, 1, 0.25, 0, 0, 0.55], // Jan
  [0, 1, 0.15, 0, 0, 0.5], // Feb
  [0.05, 0, 0.05, 0.4, 1, 0.3], // Mar (buds)
  [0.55, 0, 0, 0.8, 1, 0.05], // Apr
  [0.95, 0, 0, 1, 0.6, 0], // May
  [1, 0, 0, 1, 0, 0.05], // Jun
  [1, 0.02, 0, 1, 0, 0.2], // Jul
  [1, 0.05, 0, 1, 0, 0.3], // Aug
  [1, 0.12, 0.05, 1, 0, 0.2], // Sep
  [0.9, 0.55, 0.45, 0.8, 0, 0.15], // Oct
  [0.55, 0.92, 0.9, 0.6, 0, 0.25], // Nov
  [0, 1, 0.5, 0, 0, 0.45], // Dec
];

// ---------------------------------------------------------------- shader snippets
const GLSL_HASH = 'float vgHash(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }';
const VERT_HEAD = `
uniform float uTime; uniform float uWind; uniform vec3 uCam; uniform vec4 uLod;
varying vec2 vAtl; varying float vRand; varying float vFade;
${GLSL_HASH}`;
/** wind sway + LOD fade; position.y in tree space (metres). */
const VERT_BODY = (flutter) => `
#ifdef USE_INSTANCING
  vec3 ip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
#else
  vec3 ip = vec3(0.0);
#endif
  vRand = vgHash(ip.xz * 0.731 + 3.1);
  float dd = distance(ip.xz, uCam.xz);
  vFade = smoothstep(uLod.x, uLod.y, dd) * (1.0 - smoothstep(uLod.z, uLod.w, dd));
  vAtl = uv;
  float hh = max(0.0, position.y - 1.8);
  float sw = uWind * 0.0011 * hh * hh / (1.0 + 0.02 * hh * hh) * 6.0;
  float ph = vRand * 6.2831 + uTime * (0.8 + 0.35 * vRand);
  transformed.x += (sin(ph) + 0.4 * sin(ph * 2.3 + 1.0)) * sw;
  transformed.z += cos(ph * 0.83) * sw * 0.6;
  ${flutter ? 'transformed += normal * sin(uTime * (5.0 + 3.0 * vRand) + dot(position, vec3(2.1, 1.3, 1.7))) * 0.045 * uWind * step(2.0, position.y);' : ''}
`;
const FRAG_HEAD = `
uniform sampler2D uAtlas; uniform vec3 uS0; uniform vec3 uS1; uniform vec3 uA0; uniform vec3 uA1; uniform vec3 uBarkC;
uniform vec4 uSeason; uniform float uTurnOff; uniform float uSnow; uniform float uCapture;
varying vec2 vAtl; varying float vRand; varying float vFade;
${GLSL_HASH}`;
/** Sets diffuseColor from the atlas + seasonal palette; discards culled leaves. */
const FRAG_LEAF = `
  if (vFade < 0.999 && vFade <= vgHash(gl_FragCoord.xy)) discard;
  vec4 at = texture2D(uAtlas, vAtl);
  if (at.a < 0.5) discard;
  bool wood = at.b > 0.5;
  float id = at.g;
  float keep = fract(id * 7.31 + vRand * 0.53);
  if (!wood && keep > uSeason.x) discard;
  float tr = step(fract(id * 5.37 + vRand * 0.71) * 0.85 + vRand * 0.15, uSeason.y + uTurnOff);
  vec3 summer = mix(uS0, uS1, fract(id * 3.17 + vRand * 0.3));
  vec3 autumn = mix(uA0, uA1, fract(id * 2.31 + vRand * 0.6));
  vec3 lc = mix(summer, autumn, tr * step(0.001, uSeason.y + uTurnOff));
  vec3 col = wood ? uBarkC : lc;
  diffuseColor.rgb = col * (0.35 + at.r * 1.1);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.86, 0.88, 0.92), uSnow * 0.55 * (wood ? 1.0 : 0.6));
`;

function patchVert(sh, flutter) {
  sh.vertexShader = sh.vertexShader.replace('#include <common>', `#include <common>${VERT_HEAD}`).replace('#include <begin_vertex>', `#include <begin_vertex>${VERT_BODY(flutter)}`);
}
function lodUniforms() {
  return { uLod: { value: new THREE.Vector4(-2, -1, 1e6, 1e6 + 1) } };
}

/** Leaf-card material (one per species; palette in uniforms). */
function leafMaterial(sp, lod, depth = false) {
  const own = {
    uAtlas: { value: tex['foliage_atlas.png'] },
    uS0: { value: new THREE.Color(sp.summer[0]) },
    uS1: { value: new THREE.Color(sp.summer[1]) },
    uA0: { value: new THREE.Color(sp.autumn[0]) },
    uA1: { value: new THREE.Color(sp.autumn[1]) },
    uBarkC: { value: new THREE.Color(sp.birch ? 0x8a7a6a : 0x5a4a3c) },
    uTurnOff: { value: sp.turn || 0 },
    ...lod,
  };
  const m = depth
    ? new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking })
    : new THREE.MeshStandardMaterial({ roughness: 0.82, side: THREE.DoubleSide });
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms, U, own);
    patchVert(sh, true);
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>${FRAG_HEAD}`);
    if (depth) {
      sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>${FRAG_LEAF}`);
    } else {
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <map_fragment>', FRAG_LEAF)
        // foliage normals point out of the crown on both faces (no back-face flip)
        .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nnormal = normalize(vNormal);')
        // a little light passes through the leaves
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * 0.06;')
        .replace('#include <dithering_fragment>', '#include <dithering_fragment>\nif (uCapture > 0.5) gl_FragColor = vec4(diffuseColor.rgb, 1.0);');
    }
  };
  m.customProgramCacheKey = () => `veg-leaf-${depth}`;
  m.userData.own = own;
  return m;
}

/** Bark material (texture + normal map, birch gets its white bark with dark lenticels). */
function barkMaterial(sp, lod, depth = false) {
  const own = { ...lod };
  if (depth) {
    const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, uniforms, U, own);
      patchVert(sh, false);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>${FRAG_HEAD}`)
        .replace('#include <map_fragment>', 'if (vFade < 0.999 && vFade <= vgHash(gl_FragCoord.xy)) discard;');
    };
    m.customProgramCacheKey = () => 'veg-bark-depth';
    return m;
  }
  const plane = sp.name === 'plane';
  const m = new THREE.MeshStandardMaterial({
    map: (plane ? tex['bark_plane_color.jpg'] : tex['bark_color.jpg']) || null,
    normalMap: tex['bark_normal.jpg'] || null,
    normalScale: new THREE.Vector2(1.2, 1.2),
    color: sp.bark,
    roughness: 0.95,
  });
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms, U, own);
    patchVert(sh, false);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>${FRAG_HEAD}`)
      .replace(
        '#include <map_fragment>',
        `if (vFade < 0.999 && vFade <= vgHash(gl_FragCoord.xy)) discard;
#include <map_fragment>
${sp.birch ? 'float bl = dot(diffuseColor.rgb, vec3(0.333)); diffuseColor.rgb = mix(vec3(0.07,0.065,0.06), vec3(0.84,0.82,0.78), smoothstep(0.22, 0.34, bl + 0.12 * sin(vAtl.y * 9.0)));' : ''}
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.86, 0.88, 0.92), uSnow * 0.25);`,
      )
      .replace('#include <dithering_fragment>', '#include <dithering_fragment>\nif (uCapture > 0.5) gl_FragColor = vec4(diffuseColor.rgb, 1.0);');
  };
  m.customProgramCacheKey = () => `veg-bark-${sp.birch ? 'b' : 'n'}`;
  return m;
}

// ---------------------------------------------------------------- procedural tree growth
/** Space colonisation: returns nodes {p, parent, r, kids} plus crown centre. */
function growTree(sp, seed) {
  const rng = createRng(seed);
  const H = sp.h,
    cy = sp.cy * H,
    rx = sp.rx * H,
    ry = sp.ry * H;
  const att = [];
  while (att.length < 420) {
    const x = rng() * 2 - 1,
      y = rng() * 2 - 1,
      z = rng() * 2 - 1;
    const r = x * x + y * y + z * z;
    if (r > 1 || (r < 0.25 && rng() < 0.75)) continue;
    // flatter bottom, egg-shaped top for linden/birch
    const yy = y < 0 ? y * 0.85 : y * (sp.name === 'linden' || sp.name === 'birch' ? 1.1 : 0.95);
    const py = cy + yy * ry;
    if (py < sp.trunk + 1) continue;
    att.push([x * rx, py, z * rx]);
  }
  const nodes = [];
  const add = (p, parent) => nodes.push({ p, parent, kids: [], r: 0, d: parent >= 0 ? norm(sub(p, nodes[parent].p)) : [0, 1, 0] }) - 1;
  let cur = add([0, 0, 0], -1);
  const lean = [(rng() - 0.5) * 0.06, 1, (rng() - 0.5) * 0.06];
  const D = 0.55,
    Ri = 4.2,
    Rk = 1.1;
  for (let y = D; y <= sp.trunk; y += D) cur = add(add3(nodes[cur].p, scale(norm(lean), D)), cur);
  const alive = att.map(() => true);
  for (let it = 0; it < 160; it++) {
    const grid = new Map();
    const key = (p) => `${Math.floor(p[0] / Ri)},${Math.floor(p[1] / Ri)},${Math.floor(p[2] / Ri)}`;
    nodes.forEach((n, i) => {
      const k = key(n.p);
      (grid.get(k) || grid.set(k, []).get(k)).push(i);
    });
    const pull = new Map();
    let any = false;
    for (let a = 0; a < att.length; a++) {
      if (!alive[a]) continue;
      const p = att[a];
      const gx = Math.floor(p[0] / Ri),
        gy = Math.floor(p[1] / Ri),
        gz = Math.floor(p[2] / Ri);
      let best = -1,
        bd = Ri;
      for (let i = -1; i <= 1; i++)
        for (let j = -1; j <= 1; j++)
          for (let k = -1; k <= 1; k++) {
            const list = grid.get(`${gx + i},${gy + j},${gz + k}`);
            if (!list) continue;
            for (const ni of list) {
              const d = dist(nodes[ni].p, p);
              if (d < bd) (bd = d), (best = ni);
            }
          }
      if (best < 0) continue;
      any = true;
      if (bd < Rk) {
        alive[a] = false;
        continue;
      }
      const v = pull.get(best) || [0, 0, 0];
      const dv = norm(sub(p, nodes[best].p));
      pull.set(best, [v[0] + dv[0], v[1] + dv[1], v[2] + dv[2]]);
    }
    if (!any) {
      // crown not reached yet: extend the leader upwards
      if (att.some((_, i) => alive[i])) cur = add(add3(nodes[cur].p, [0, D, 0]), cur);
      else break;
      continue;
    }
    if (!pull.size) break;
    for (const [ni, v] of pull) {
      const n = nodes[ni];
      const dir = norm([v[0] + n.d[0] * 0.35, v[1] + n.d[1] * 0.35 + sp.trop * 0.5, v[2] + n.d[2] * 0.35]);
      const np = add3(n.p, scale(dir, D));
      // avoid duplicate growth into the same spot
      if (n.kids.some((k) => dist(nodes[k].p, np) < 0.05)) continue;
      const id = add(np, ni);
      n.kids.push(id);
    }
    if (nodes.length > 2600) break;
  }
  // fix kids for trunk nodes (added via add() without kids push)
  for (let i = 1; i < nodes.length; i++) {
    const pa = nodes[i].parent;
    if (!nodes[pa].kids.includes(i)) nodes[pa].kids.push(i);
  }
  // pipe-model radii
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    if (!n.kids.length) n.r = 0.012;
    else n.r = Math.pow(n.kids.reduce((s, k) => s + Math.pow(nodes[k].r, 2.3), 0), 1 / 2.3);
  }
  const k = sp.trunkR / nodes[0].r;
  for (const n of nodes) n.r = Math.max(0.01, n.r * Math.min(1, k * 1.0 + (1 - k) * 0)) * (n.r * k > 0.01 ? k : 1);
  for (const n of nodes) n.r = Math.max(n.r, 0.008);
  nodes[0].r *= 1.25;
  return { nodes, center: [0, cy, 0], rx, ry };
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const norm = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Branch tubes for all nodes thicker than minR. */
function buildBark(tree, minR, segs) {
  const { nodes } = tree;
  const pos = [],
    nrm = [],
    uvs = [],
    idx = [];
  const ringsOf = (r) => (r > 0.2 ? segs[0] : r > 0.07 ? segs[1] : r > 0.03 ? segs[2] : 3);
  const emitChain = (chain, startR) => {
    let vlen = 0,
      prevBase = -1,
      prevK = 0;
    for (let c = 0; c < chain.length; c++) {
      const n = nodes[chain[c]];
      const prev = nodes[chain[Math.max(0, c - 1)]],
        next = nodes[chain[Math.min(chain.length - 1, c + 1)]];
      const t = norm(sub(next.p, prev.p));
      const a = Math.abs(t[1]) < 0.95 ? [0, 1, 0] : [1, 0, 0];
      const b1 = norm(cross(t, a)),
        b2 = cross(t, b1);
      const r = c === 0 && startR ? startR : n.r;
      const k = ringsOf(nodes[chain[0]].r);
      if (c > 0) vlen += dist(n.p, prev.p);
      const base = pos.length / 3;
      const uRep = Math.max(1, Math.round((6.283 * r) / 0.45));
      for (let i = 0; i <= k; i++) {
        const ang = (i / k) * Math.PI * 2;
        const nx = b1[0] * Math.cos(ang) + b2[0] * Math.sin(ang),
          ny = b1[1] * Math.cos(ang) + b2[1] * Math.sin(ang),
          nz = b1[2] * Math.cos(ang) + b2[2] * Math.sin(ang);
        pos.push(n.p[0] + nx * r, n.p[1] + ny * r, n.p[2] + nz * r);
        nrm.push(nx, ny, nz);
        uvs.push((i / k) * uRep, vlen / 0.9);
      }
      if (prevBase >= 0 && prevK === k)
        for (let i = 0; i < k; i++) {
          idx.push(prevBase + i, base + i, prevBase + i + 1);
          idx.push(prevBase + i + 1, base + i, base + i + 1);
        }
      prevBase = base;
      prevK = k;
    }
  };
  // walk chains: main child continues, others start a new chain at the parent
  const stack = [[0, -1]];
  while (stack.length) {
    const [start, from] = stack.pop();
    const chain = from >= 0 ? [from, start] : [start];
    let n = start;
    for (;;) {
      const kids = nodes[n].kids.filter((k) => nodes[k].r >= minR);
      if (!kids.length) break;
      kids.sort((a, b) => nodes[b].r - nodes[a].r);
      for (let i = 1; i < kids.length; i++) stack.push([kids[i], n]);
      n = kids[0];
      chain.push(n);
    }
    if (chain.length >= 2) emitChain(chain, from >= 0 ? nodes[start].r * 1.05 : 0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  return g;
}

/** Leaf-cluster cards at the thin branch ends. */
function buildCards(tree, sp, count, sizeMul, seed) {
  const rng = createRng(seed);
  const { nodes, center } = tree;
  const cand = [];
  for (let i = 0; i < nodes.length; i++) if (nodes[i].r < 0.035 && nodes[i].p[1] > sp.trunk + 0.5) cand.push(i);
  for (let i = cand.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [cand[i], cand[j]] = [cand[j], cand[i]];
  }
  const pos = [],
    nrm = [],
    uvs = [],
    idx = [];
  const cu = (sp.cell % 4) * 0.25,
    cv = 1 - (Math.floor(sp.cell / 4) + 1) * 0.5;
  const n = Math.min(count, cand.length);
  for (let c = 0; c < n; c++) {
    const nd = nodes[cand[c]];
    const out = norm(sub(nd.p, center));
    let A = norm([nd.d[0] * 0.5 + out[0] * 0.6, nd.d[1] * 0.5 + out[1] * 0.6 + (sp.birch ? -0.55 : 0.1), nd.d[2] * 0.5 + out[2] * 0.6]);
    const rnd3 = norm([rng() - 0.5, rng() - 0.5, rng() - 0.5]);
    let R = cross(A, rnd3);
    if (Math.hypot(...R) < 0.1) R = cross(A, [0, 1, 0]);
    R = norm(R);
    const S = sp.card * sizeMul * (0.75 + rng() * 0.5);
    const B = sub(nd.p, scale(A, S * 0.15));
    const quad = [
      add3(B, scale(R, -S / 2)),
      add3(B, scale(R, S / 2)),
      add3(add3(B, scale(A, S)), scale(R, S / 2)),
      add3(add3(B, scale(A, S)), scale(R, -S / 2)),
    ];
    const uvq = [
      [cu + 0.002, cv + 0.002],
      [cu + 0.248, cv + 0.002],
      [cu + 0.248, cv + 0.498],
      [cu + 0.002, cv + 0.498],
    ];
    const base = pos.length / 3;
    for (let q = 0; q < 4; q++) {
      const v = quad[q];
      const sn = norm(sub(v, center));
      const nn = norm([sn[0], sn[1] * 0.8 + 0.35, sn[2]]);
      pos.push(...v);
      nrm.push(...nn);
      uvs.push(...uvq[q]);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  return g;
}

// ---------------------------------------------------------------- quality presets
const LOD_Q = {
  low: { near: 16, mid: 90, band: 4, segs: [6, 4, 3], minR0: 0.05, minR1: 0.12, cards0: 0.55, cards1: 0.18, tufts: 0, shadowsMid: false, imp: 256 },
  medium: { near: 34, mid: 150, band: 6, segs: [7, 5, 3], minR0: 0.03, minR1: 0.09, cards0: 0.8, cards1: 0.22, tufts: 0, shadowsMid: true, imp: 384 },
  high: { near: 55, mid: 220, band: 8, segs: [9, 6, 4], minR0: 0.022, minR1: 0.07, cards0: 1, cards1: 0.25, tufts: 1, shadowsMid: true, imp: 512 },
  ultra: { near: 80, mid: 300, band: 10, segs: [10, 6, 4], minR0: 0.018, minR1: 0.06, cards0: 1.15, cards1: 0.3, tufts: 1.6, shadowsMid: true, imp: 512 },
};

// ---------------------------------------------------------------- entry point
export function buildVegetation(data, river, buildingIndex) {
  const q = LOD_Q[ctx.quality] || LOD_Q.medium;
  const month = currentMonth();
  const S = SEASONS[month];
  U.uSeason.value.set(S[0], S[1], S[2], S[3]);
  const fresh = S[4];
  if (fresh > 0)
    for (const sp of SPECIES) {
      // spring: light, yellowish fresh green
      sp.summer = sp.summer.map((c) => new THREE.Color(c).lerp(new THREE.Color(0x9bbf3c), 0.45 * fresh).getHex());
    }
  const env = buildEnvIndex(data, river, buildingIndex);
  const lawns = buildLawns(data, river, env, S);
  const trees = placeTrees(data, env, lawns);
  buildTreePits(trees, S);
  buildHedges(data, env, lawns);
  buildFlowerBeds(lawns, env, trees, S);
  buildCanopyMap(trees, lawns);
  const sys = buildTreeSystem(trees, q);
  const tufts = q.tufts > 0 ? buildTufts(lawns, env, q) : null;
  ctx.vegetation = {
    trees,
    month,
    update(camPos) {
      sys.update(camPos);
      tufts?.update(camPos);
    },
  };
  return trees.map((t) => [t.x, t.z, (SPECIES[t.sp].trunkR * t.s) / 0.25]);
}

/** Spatial indexes for placement checks (roads, footpaths, lamps, river, buildings). */
function buildEnvIndex(data, river, buildingIndex) {
  const carSegs = new SpatialGrid(40),
    pathSegs = new SpatialGrid(40);
  for (const r of data.roads) {
    const car = RC[r.c][1] === 0;
    const hw = roadWidth(r) / 2;
    for (let i = 0; i < r.pts.length - 1; i++) {
      const a = r.pts[i],
        b = r.pts[i + 1];
      (car ? carSegs : pathSegs).insert((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, [a, b, hw, r]);
    }
  }
  const rails = new SpatialGrid(40);
  for (const r of data.rails)
    for (let i = 0; i < r.pts.length - 1; i++) {
      const a = r.pts[i],
        b = r.pts[i + 1];
      rails.insert((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, [a, b, r.tram ? 1.6 : 2.4]);
    }
  const lamps = new SpatialGrid(20);
  for (const [x, z] of ctx.streets?.lamps || []) lamps.insert(x, z, [x, z]);
  const near = (grid, x, z, pad, qr = 40) => {
    for (const [a, b, hw] of grid.query(x, z, qr)) if (segDist(x, z, a[0], a[1], b[0], b[1]).d < hw + pad) return true;
    return false;
  };
  const riverB = river.map(bounds);
  return {
    carSegs,
    pathSegs,
    nearRoad: (x, z, pad) => near(carSegs, x, z, pad),
    nearPath: (x, z, pad) => near(pathSegs, x, z, pad),
    nearRail: (x, z, pad) => near(rails, x, z, pad),
    nearLamp: (x, z, r) => {
      for (const [lx, lz] of lamps.query(x, z, r + 2)) if (Math.hypot(lx - x, lz - z) < r) return true;
      return false;
    },
    inRiver: (x, z) => river.some((rg, i) => x >= riverB[i].minx && x <= riverB[i].maxx && z >= riverB[i].minz && z <= riverB[i].maxz && pip(x, z, rg)),
    inBuilding: (x, z, pad) => buildingIndex.inside(x, z, pad),
  };
}

// ---------------------------------------------------------------- lawns + river meadows
function buildLawns(data, river, env, S) {
  const polys = [];
  for (const r of data.parks) {
    const rr = openRing(r);
    if (rr.length >= 3 && Math.abs(area(rr)) > 40) polys.push({ ring: rr, b: bounds(rr), park: true });
  }
  const lawnGrid = new SpatialGrid(100);
  const index = (p) => {
    for (let x = Math.floor(p.b.minx / 100); x <= Math.floor(p.b.maxx / 100); x++)
      for (let z = Math.floor(p.b.minz / 100); z <= Math.floor(p.b.maxz / 100); z++) lawnGrid.insert(x * 100 + 1, z * 100 + 1, p);
  };
  polys.forEach(index);
  const inLawn = (x, z) => {
    for (const p of lawnGrid.query(x, z, 0)) if (x >= p.b.minx && x <= p.b.maxx && z >= p.b.minz && z <= p.b.maxz && pip(x, z, p.ring)) return p;
    return null;
  };
  const gp = new GeoBuilder();
  const white = new THREE.Color(1, 1, 1);
  for (const p of polys) addFlatPoly(gp, p.ring, 0.025, white);

  // Mainufer: meadow strips between the quay promenade and the embankment road
  const meadows = [];
  for (const rg of river) {
    const ring = area(rg) < 0 ? rg.slice().reverse() : rg; // CCW: outward normal is to the right
    const samples = [];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i],
        b = ring[(i + 1) % ring.length];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const n = Math.max(1, Math.round(L / 5));
      for (let k = 0; k < n; k++) {
        const t = k / n;
        const x = a[0] + (b[0] - a[0]) * t,
          z = a[1] + (b[1] - a[1]) * t;
        const nx = (b[1] - a[1]) / L,
          nz = -(b[0] - a[0]) / L;
        samples.push([x, z, nx, nz]);
      }
    }
    // smooth normals
    for (let i = 0; i < samples.length; i++) {
      const p = samples[(i - 1 + samples.length) % samples.length],
        nn = samples[(i + 1) % samples.length];
      const sx = p[2] + samples[i][2] * 2 + nn[2],
        sz = p[3] + samples[i][3] * 2 + nn[3];
      const l = Math.hypot(sx, sz) || 1;
      samples[i].push(sx / l, sz / l);
    }
    const start = 4.5;
    const widths = samples.map(([x, z, , , nx, nz]) => {
      // the far side must be dry land
      if (env.inRiver(x + nx * 2, z + nz * 2)) return 0;
      let w = start;
      for (let d = start; d <= 42; d += 1.5) {
        const px = x + nx * d,
          pz = z + nz * d;
        if (env.inRiver(px, pz) || env.nearRoad(px, pz, 3) || env.inBuilding(px, pz, 2) || env.nearRail(px, pz, 2) || inLawn(px, pz)) break;
        w = d;
      }
      return w - start >= 5 ? w : 0;
    });
    let strip = [];
    const flush = () => {
      if (strip.length >= 3) meadows.push(strip);
      strip = [];
    };
    for (let i = 0; i < samples.length; i++) {
      if (!widths[i]) {
        flush();
        continue;
      }
      // limit width jumps so the outline stays smooth
      strip.push([samples[i], widths[i]]);
    }
    flush();
  }
  for (const strip of meadows) {
    const inner = [],
      outer = [];
    for (let i = 0; i < strip.length; i++) {
      const [[x, z, , , nx, nz], w] = strip[i];
      const ws = Math.min(w, ...strip.slice(Math.max(0, i - 1), i + 2).map((s) => s[1]));
      inner.push([x + nx * 4.5, z + nz * 4.5]);
      outer.push([x + nx * ws, z + nz * ws]);
    }
    const ring = inner.concat(outer.reverse());
    if (Math.abs(area(ring)) < 80) continue;
    const p = { ring, b: bounds(ring), park: false, meadow: true, inner };
    polys.push(p);
    index(p);
    addFlatPoly(gp, ring, 0.024, white);
  }

  const m = lawnMaterial(S);
  const mesh = new THREE.Mesh(gp.build(), m);
  mesh.receiveShadow = true;
  ctx.scene.add(mesh);
  ctx.mats.park = m;
  return { polys, inLawn, meadows: polys.filter((p) => p.meadow) };
}

const canopyU = { uCanopy: { value: null }, uCanopyB: { value: new THREE.Vector4(-4200, -4200, 8400, 8400) } };

/** Grass texture with macro variation, mowing stripes, canopy shade and autumn leaf litter. */
function lawnMaterial(S) {
  const m = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.96,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -2,
  });
  const own = { uGrass: { value: tex['grass_color.jpg'] }, uDry: { value: S[5] }, ...canopyU };
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms, U, own);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWp;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWp = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vWp; uniform sampler2D uGrass; uniform sampler2D uCanopy; uniform vec4 uCanopyB; uniform float uDry;
uniform float uWet; uniform float uSnow; uniform vec4 uSeason;
${GLSL_HASH}
float vgN(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f); return mix(mix(vgHash(i), vgHash(i+vec2(1,0)), f.x), mix(vgHash(i+vec2(0,1)), vgHash(i+vec2(1,1)), f.x), f.y); }`,
      )
      .replace(
        '#include <map_fragment>',
        `vec2 gp = vWp.xz;
vec3 g1 = texture2D(uGrass, gp / 3.1).rgb;
vec3 g2 = texture2D(uGrass, mat2(0.8, -0.6, 0.6, 0.8) * gp / 7.7 + 0.37).rgb;
vec3 gcol = mix(g1, g2, 0.45);
float macro = vgN(gp / 23.0) * 0.6 + vgN(gp / 7.0) * 0.4;
float dry = smoothstep(0.55, 0.85, vgN(gp / 41.0 + 7.0)) * 0.6 + uDry;
gcol *= 0.78 + 0.42 * macro;
gcol = mix(gcol, gcol * vec3(1.25, 1.08, 0.62), clamp(dry, 0.0, 1.0) * 0.7);
float stripe = step(0.5, fract(dot(gp, vec2(0.6, 0.8)) / 5.0));
gcol *= 0.96 + 0.06 * stripe * (1.0 - uDry);
vec2 cuv = (gp - uCanopyB.xy) / uCanopyB.zw;
float can = texture2D(uCanopy, cuv).r;
gcol *= 1.0 - 0.28 * can * uSeason.x;
float lit = uSeason.z * smoothstep(0.08, 0.7, can);
float lf = vgN(gp * 2.6) * 0.55 + vgN(gp * 9.0) * 0.45;
float cover = smoothstep(0.75 - lit * 0.6, 0.85 - lit * 0.6, lf);
vec3 leafc = mix(vec3(0.42, 0.22, 0.06), vec3(0.62, 0.42, 0.08), vgN(gp * 5.3));
gcol = mix(gcol, leafc, cover * step(0.01, lit));
diffuseColor.rgb *= gcol;
diffuseColor.rgb *= mix(1.0, 0.6, uWet);
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.9, 0.92, 0.96), uSnow * 0.9);`,
      );
  };
  m.customProgramCacheKey = () => 'veg-lawn';
  return m;
}

// ---------------------------------------------------------------- tree placement
function pickStreetSpecies(name, kai) {
  if (kai) return SP.plane;
  const h = hash(name ? [...name].reduce((s, c) => s * 31 + c.charCodeAt(0), 7) % 100000 : 3.3);
  return h < 0.36 ? SP.linden : h < 0.62 ? SP.plane : h < 0.8 ? SP.maple : h < 0.93 ? SP.chestnut : SP.birch;
}

function placeTrees(data, env, lawns) {
  const density = QUALITY[ctx.quality]?.trees ?? 0.7;
  const rng = createRng(4711);
  const trees = [];
  const occ = new SpatialGrid(20);
  const free = (x, z, r) => {
    for (const t of occ.query(x, z, r + 8)) if (Math.hypot(t.x - x, t.z - z) < r) return false;
    return true;
  };
  const push = (t) => {
    trees.push(t);
    occ.insert(t.x, t.z, t);
  };
  const okGround = (x, z, pathPad) =>
    !env.inRiver(x, z) && !env.inBuilding(x, z, 2.5) && !env.nearRoad(x, z, 2.5) && !env.nearPath(x, z, pathPad) && !env.nearRail(x, z, 2.5);

  // avenue trees: one species per street, regular spacing, on the pavement
  const spacing = { low: 13, medium: 11, high: 10, ultra: 9.5 }[ctx.quality] || 11;
  for (const r of data.roads) {
    if (!(r.c <= 4 || r.c === 14) || r.bridge || r.pts.length < 2) continue;
    if (r.c === 4 && !/kai|ufer|allee|anlage|ring|straße/i.test(r.name)) continue;
    const kai = /kai|ufer/i.test(r.name);
    const sp = pickStreetSpecies(r.name, kai);
    const off = roadWidth(r) / 2 + 2.1;
    for (const side of [-1, 1]) {
      const line = offsetLine(r.pts, side * off);
      let carry = spacing * 0.5;
      for (let i = 0; i < line.length - 1; i++) {
        const a = line[i],
          b = line[i + 1];
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        for (let s = carry; s < L; s += spacing) {
          const x = a[0] + ((b[0] - a[0]) * s) / L,
            z = a[1] + ((b[1] - a[1]) * s) / L;
          if (env.inRiver(x, z) || env.inBuilding(x, z, 1.5)) continue;
          if (env.nearRoad(x, z, 1.3) || env.nearLamp(x, z, 3.5) || env.nearRail(x, z, 1.5) || !free(x, z, 6)) continue;
          const onLawn = !!lawns.inLawn(x, z);
          push({ x, z, sp, s: 0.72 + rng() * 0.26, rot: rng() * 6.283, avenue: !onLawn });
        }
        carry = (((carry - L) % spacing) + spacing) % spacing;
      }
    }
  }

  // Mainufer: rows of old plane trees along the meadows
  for (const m of lawns.meadows) {
    const line = m.inner;
    for (let i = 0; i < line.length; i += 2) {
      const [x0, z0] = line[i];
      const j = Math.min(line.length - 1, i + 1);
      const dx = line[j][0] - x0,
        dz = line[j][1] - z0,
        L = Math.hypot(dx, dz) || 1;
      // outward from the river = to the right of the CCW ring
      const nx = dz / L,
        nz = -dx / L;
      const d = 6 + rng() * 5;
      const x = x0 + nx * d,
        z = z0 + nz * d;
      if (pip(x, z, m.ring) && okGround(x, z, 2.0) && free(x, z, 9)) push({ x, z, sp: rng() < 0.85 ? SP.plane : SP.linden, s: 0.95 + rng() * 0.3, rot: rng() * 6.283 });
    }
  }

  // parks: groves of one species plus solitary trees, kept off the paths
  lawns.polys.forEach((p, pi) => {
    if (!p.park) return;
    const A = Math.abs(area(p.ring));
    const target = Math.min(900, Math.floor((A / 300) * density));
    if (!target) return;
    const prng = createRng(1000 + pi);
    const groves = Math.max(1, Math.round(target / 14));
    const mix = [SP.linden, SP.chestnut, SP.maple, SP.birch, SP.plane, SP.linden, SP.chestnut];
    let made = 0,
      tries = 0;
    const b = p.b;
    const centres = [];
    for (let g = 0; g < groves * 3 && centres.length < groves; g++) {
      const x = lerp(b.minx, b.maxx, prng()),
        z = lerp(b.minz, b.maxz, prng());
      if (pip(x, z, p.ring)) centres.push({ x, z, sp: mix[Math.floor(prng() * mix.length)], r: 10 + prng() * 18 });
    }
    while (made < target && tries < target * 8) {
      tries++;
      let x, z, sp;
      if (centres.length && prng() < 0.8) {
        const c = centres[Math.floor(prng() * centres.length)];
        const a = prng() * 6.283,
          rr = Math.sqrt(prng()) * c.r;
        x = c.x + Math.cos(a) * rr;
        z = c.z + Math.sin(a) * rr;
        sp = prng() < 0.85 ? c.sp : mix[Math.floor(prng() * mix.length)];
      } else {
        x = lerp(b.minx, b.maxx, prng());
        z = lerp(b.minz, b.maxz, prng());
        sp = mix[Math.floor(prng() * mix.length)];
      }
      if (!pip(x, z, p.ring) || !okGround(x, z, 2.2) || !free(x, z, sp === SP.birch ? 4.5 : 7)) continue;
      push({ x, z, sp, s: 0.8 + prng() * 0.45, rot: prng() * 6.283 });
      made++;
    }
  });
  return trees;
}

// ---------------------------------------------------------------- tree LOD system
function buildTreeSystem(trees, q) {
  const N = trees.length;
  const group = new THREE.Group();
  group.name = 'trees';
  ctx.scene.add(group);
  const shadows = !!QUALITY[ctx.quality]?.shadows;
  // per-tree instance matrices
  const mats = new Float32Array(N * 16);
  const m4 = new THREE.Matrix4(),
    qq = new THREE.Quaternion(),
    sv = new THREE.Vector3(),
    pv = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);
  const grid = new SpatialGrid(60);
  trees.forEach((t, i) => {
    const r = hash(i * 1.37 + 0.5);
    qq.setFromAxisAngle(UP, t.rot);
    sv.set(t.s * (0.9 + r * 0.2), t.s * (0.88 + hash(i + 7.1) * 0.24), t.s * (0.9 + hash(i * 3.3) * 0.2));
    pv.set(t.x, t.avenue ? KERB : 0, t.z);
    m4.compose(pv, qq, sv);
    m4.toArray(mats, i * 16);
    grid.insert(t.x, t.z, i);
  });

  const lod0 = new THREE.Vector4(-2, -1, q.near, q.near + q.band);
  const lod1 = new THREE.Vector4(q.near, q.near + q.band, q.mid, q.mid + q.band);
  const lodImp = new THREE.Vector4(q.mid, q.mid + q.band, 1e6, 1e6 + 1);
  const L0 = { uLod: { value: lod0 } },
    L1 = { uLod: { value: lod1 } };
  const perSpecies = SPECIES.map((sp, si) => {
    const tree = growTree(sp, 97 + si * 13);
    const g0b = buildBark(tree, q.minR0, q.segs);
    const g0l = buildCards(tree, sp, Math.round(sp.cards * q.cards0), 1, 11 + si);
    const g1b = buildBark(tree, q.minR1, [6, 4, 3]);
    const g1l = buildCards(tree, sp, Math.round(sp.cards * q.cards1), 1.75, 23 + si);
    const max = Math.min(N, 2000);
    const mk = (geo, mat, depth, castShadow) => {
      const im = new THREE.InstancedMesh(geo, mat, max);
      im.count = 0;
      im.frustumCulled = false;
      im.castShadow = castShadow && shadows;
      im.receiveShadow = true;
      if (depth) im.customDepthMaterial = depth;
      group.add(im);
      return im;
    };
    const lm0 = leafMaterial(sp, L0),
      lm1 = leafMaterial(sp, L1);
    const r = {
      tree,
      bark0: mk(g0b, barkMaterial(sp, L0), barkMaterial(sp, L0, true), true),
      leaf0: mk(g0l, lm0, leafMaterial(sp, L0, true), true),
      bark1: mk(g1b, barkMaterial(sp, L1), barkMaterial(sp, L1, true), q.shadowsMid),
      leaf1: mk(g1l, lm1, leafMaterial(sp, L1, true), q.shadowsMid),
      tris: [g0b, g0l, g1b, g1l].map((g) => g.index.count / 3),
    };
    // tree bounds for the impostor
    g0l.computeBoundingBox();
    g0b.computeBoundingBox();
    const bb = g0l.boundingBox.clone().union(g0b.boundingBox);
    r.w = Math.max(-bb.min.x, bb.max.x, -bb.min.z, bb.max.z) * 2 * 1.02;
    r.h = bb.max.y * 1.02;
    return r;
  });
  console.info(
    `[vegetation] ${N} trees, tris per tree LOD0/LOD1:`,
    perSpecies.map((p) => `${p.tris[0] + p.tris[1]}/${p.tris[2] + p.tris[3]}`).join(' '),
  );

  // ---- impostor atlas rendered from the LOD0 meshes (albedo, current season)
  const cell = q.imp;
  const rt = new THREE.WebGLRenderTarget(cell * SPECIES.length, cell, { generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter });
  {
    const renderer = ctx.renderer;
    const scene = new THREE.Scene();
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
    const prevRT = renderer.getRenderTarget();
    const prevClear = renderer.getClearColor(new THREE.Color()),
      prevAlpha = renderer.getClearAlpha();
    const prevAuto = renderer.autoClear;
    const prevShadow = renderer.shadowMap.enabled;
    U.uCapture.value = 1;
    U.uWind.value = 0;
    U.uCam.value.set(0, 0, 0);
    renderer.autoClear = false;
    renderer.setRenderTarget(rt);
    renderer.setClearColor(0x2a3320, 0);
    renderer.clear();
    perSpecies.forEach((p, si) => {
      scene.clear();
      for (const k of ['bark0', 'leaf0']) {
        const src = p[k];
        const im = new THREE.InstancedMesh(src.geometry, src.material, 1);
        im.setMatrixAt(0, new THREE.Matrix4());
        im.frustumCulled = false;
        scene.add(im);
      }
      cam.left = -p.w / 2;
      cam.right = p.w / 2;
      cam.top = p.h;
      cam.bottom = 0;
      cam.position.set(0, 0, 60);
      cam.lookAt(0, 0, 0);
      cam.position.set(0, p.h * 0.18, 60);
      cam.updateProjectionMatrix();
      rt.viewport.set(si * cell, 0, cell, cell);
      rt.scissor.set(si * cell, 0, cell, cell);
      rt.scissorTest = true;
      renderer.setRenderTarget(rt);
      renderer.render(scene, cam);
    });
    rt.scissorTest = false;
    renderer.setRenderTarget(prevRT);
    renderer.setClearColor(prevClear, prevAlpha);
    renderer.autoClear = prevAuto;
    renderer.shadowMap.enabled = prevShadow;
    U.uCapture.value = 0;
  }
  // impostor instances: all trees
  const impGeo = new THREE.InstancedBufferGeometry();
  impGeo.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0], 3));
  impGeo.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
  impGeo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  impGeo.setIndex([0, 1, 2, 0, 2, 3]);
  const aImp = new Float32Array(N * 4);
  trees.forEach((t, i) => {
    const p = perSpecies[t.sp];
    const sy = mats[i * 16 + 5] !== undefined ? Math.hypot(mats[i * 16 + 4], mats[i * 16 + 5], mats[i * 16 + 6]) : t.s;
    aImp.set([t.sp, p.w * t.s, p.h * sy, hash(i * 0.77)], i * 4);
  });
  impGeo.setAttribute('aImp', new THREE.InstancedBufferAttribute(aImp, 4));
  const impMat = new THREE.MeshStandardMaterial({ roughness: 0.9, map: rt.texture, alphaTest: 0.5 });
  const impOwn = { uLod: { value: lodImp }, uCells: { value: SPECIES.length } };
  impMat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms, U, impOwn);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\nattribute vec4 aImp; uniform vec3 uCam; uniform vec4 uLod; uniform float uCells; varying float vFade; varying vec2 vLuv;`)
      .replace(
        '#include <begin_vertex>',
        `vec3 ip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
float dd = distance(ip.xz, uCam.xz);
vFade = smoothstep(uLod.x, uLod.y, dd) * (1.0 - smoothstep(uLod.z, uLod.w, dd));
vec3 toC = uCam - ip; toC.y = 0.0; toC = normalize(toC + vec3(1e-4, 0.0, 0.0));
vec3 right = vec3(toC.z, 0.0, -toC.x);
vec3 transformed = right * position.x * aImp.y + vec3(0.0, position.y * aImp.z, 0.0);
vLuv = uv;
${'' /* instanceMatrix is applied after; neutralise its rotation/scale below */}`,
      )
      .replace('#include <project_vertex>', 'vec4 mvPosition = viewMatrix * vec4(ip + transformed, 1.0);\nif (vFade <= 0.001) mvPosition = vec4(0.0, 0.0, 2.0, 1.0);\ngl_Position = projectionMatrix * mvPosition;')
      .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 0.0, 1.0);')
      .replace('#include <defaultnormal_vertex>', 'vec3 transformedNormal = normalMatrix * objectNormal;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n#ifdef USE_MAP\nvMapUv = vec2((aImp.x + 0.004 + uv.x * 0.992) / uCells, uv.y * 0.995);\n#endif');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying float vFade; varying vec2 vLuv; uniform float uSnow;\n${GLSL_HASH}`)
      .replace('#include <map_fragment>', '#include <map_fragment>\nif (vFade < 0.999 && vFade <= vgHash(gl_FragCoord.xy)) discard;\ndiffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.86,0.88,0.92), uSnow * 0.4);')
      .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nnormal = normalize(vec3((vLuv.x - 0.5) * 1.4, (vLuv.y - 0.45) * 1.1 + 0.25, 0.85));');
  };
  impMat.customProgramCacheKey = () => 'veg-impostor';
  const imp = new THREE.InstancedMesh(impGeo, impMat, Math.max(1, N));
  imp.instanceMatrix.array.set(mats);
  imp.instanceMatrix.needsUpdate = true;
  imp.count = N;
  imp.frustumCulled = false;
  imp.receiveShadow = false;
  group.add(imp);

  // ---- per-frame LOD selection (near/mid instances rebuilt from the spatial grid)
  const frustum = new THREE.Frustum(),
    pm = new THREE.Matrix4(),
    sph = new THREE.Sphere();
  let lastFrame = -1;
  const counts = SPECIES.map(() => [0, 0]);
  const update = (camPos) => {
    const cam = ctx.camera;
    const cp = camPos || cam.position;
    U.uCam.value.copy(cp);
    U.uWind.value = Math.min(2.5, 0.25 + (ctx.env?.weather?.wind ?? 3) * 0.12);
    pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    frustum.setFromProjectionMatrix(pm);
    for (const c of counts) c[0] = c[1] = 0;
    const far = q.mid + q.band;
    for (const i of grid.query(cp.x, cp.z, far)) {
      const t = trees[i];
      const d = Math.hypot(t.x - cp.x, t.z - cp.z);
      if (d > far) continue;
      const p = perSpecies[t.sp];
      sph.center.set(t.x, p.h * t.s * 0.55, t.z);
      sph.radius = p.h * t.s * 0.65;
      if (d > 25 && !frustum.intersectsSphere(sph)) continue;
      const c = counts[t.sp];
      if (d < q.near + q.band && c[0] < p.bark0.instanceMatrix.count) {
        p.bark0.instanceMatrix.array.set(mats.subarray(i * 16, i * 16 + 16), c[0] * 16);
        c[0]++;
      }
      if (d > q.near && c[1] < p.bark1.instanceMatrix.count) {
        p.bark1.instanceMatrix.array.set(mats.subarray(i * 16, i * 16 + 16), c[1] * 16);
        c[1]++;
      }
    }
    perSpecies.forEach((p, si) => {
      const [n0, n1] = counts[si];
      for (const [a, b, n] of [
        [p.bark0, p.leaf0, n0],
        [p.bark1, p.leaf1, n1],
      ]) {
        a.count = b.count = n;
        a.visible = b.visible = n > 0;
        if (n) {
          b.instanceMatrix.array.set(a.instanceMatrix.array.subarray(0, n * 16));
          a.instanceMatrix.clearUpdateRanges();
          b.instanceMatrix.clearUpdateRanges();
          a.instanceMatrix.addUpdateRange(0, n * 16);
          b.instanceMatrix.addUpdateRange(0, n * 16);
          a.instanceMatrix.needsUpdate = b.instanceMatrix.needsUpdate = true;
        }
      }
    });
  };
  // self-driven: runs once per rendered frame (main pass) before most objects are drawn
  imp.onBeforeRender = (renderer) => {
    const f = renderer.info.render.frame;
    if (f === lastFrame) return;
    lastFrame = f;
    update();
  };
  if (N) update(ctx.camera.position);
  return { update, perSpecies, imp };
}

// ---------------------------------------------------------------- tree pits + pavement leaf litter
function buildTreePits(trees, S) {
  const gb = new GeoBuilder();
  const c = new THREE.Color(1, 1, 1);
  for (const t of trees) {
    if (!t.avenue) continue;
    const R = S[2] > 0.05 ? 2.3 : 0.85;
    const ca = Math.cos(t.rot),
      sa = Math.sin(t.rot);
    const base = gb.count;
    for (const [u, v] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ])
      gb.v(t.x + (u * ca - v * sa) * R, KERB + 0.008, t.z + (u * sa + v * ca) * R, 0, 1, 0, c, u * R, v * R);
    gb.tri(base, base + 2, base + 1);
    gb.tri(base, base + 3, base + 2);
  }
  if (!gb.count) return;
  const m = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0.0, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6 });
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms, U);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vL;').replace('#include <uv_vertex>', '#include <uv_vertex>\nvL = uv;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec2 vL; uniform vec4 uSeason; uniform float uSnow; uniform float uWet;\n${GLSL_HASH}
float vgN(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f); return mix(mix(vgHash(i), vgHash(i+vec2(1,0)), f.x), mix(vgHash(i+vec2(0,1)), vgHash(i+vec2(1,1)), f.x), f.y); }`)
      .replace(
        '#include <map_fragment>',
        `vec2 a = abs(vL);
float m = max(a.x, a.y);
vec3 col;
if (m < 0.8) {
  // cast-iron tree grate: concentric slots around the trunk opening
  float r = length(vL);
  float slot = step(0.5, fract(r * 9.0)) * step(0.32, r);
  float rib = step(0.9, fract(atan(vL.y, vL.x) * 1.909));
  col = r < 0.32 ? vec3(0.16, 0.12, 0.09) * (0.7 + 0.6 * vgHash(floor(vL * 40.0))) : mix(vec3(0.07, 0.07, 0.075), vec3(0.03), max(slot, rib) * (1.0 - rib));
} else if (m < 0.86) {
  col = vec3(0.55, 0.54, 0.52); // granite edging
} else {
  float lit = uSeason.z * smoothstep(2.3, 0.9, length(vL));
  float lf = vgN(vL * 6.0) * 0.5 + vgN(vL * 17.0) * 0.5;
  if (lf < 1.0 - lit * 0.75) discard;
  col = mix(vec3(0.45, 0.24, 0.06), vec3(0.66, 0.46, 0.1), vgN(vL * 11.0 + 3.0));
}
diffuseColor.rgb = col * mix(1.0, 0.6, uWet);
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.9, 0.92, 0.96), uSnow * 0.8);`,
      );
  };
  m.customProgramCacheKey = () => 'veg-pit';
  const mesh = new THREE.Mesh(gb.build(), m);
  mesh.receiveShadow = true;
  ctx.scene.add(mesh);
}

// ---------------------------------------------------------------- hedges (hornbeam / privet)
function buildHedges(data, env, lawns) {
  const segs = [];
  lawns.polys.forEach((p, pi) => {
    if (!p.park || hash(pi * 3.7) > 0.6 || Math.abs(area(p.ring)) < 600) return;
    const ring = area(p.ring) < 0 ? p.ring.slice().reverse() : p.ring;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i],
        b = ring[(i + 1) % ring.length];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (L < 4) continue;
      // inset towards the park interior (left of a CCW ring)
      const nx = -(b[1] - a[1]) / L,
        nz = (b[0] - a[0]) / L;
      const n = Math.floor(L / 2);
      for (let k = 0; k < n; k++) {
        const t = (k + 0.5) / n;
        const x = a[0] + (b[0] - a[0]) * t + nx * 1.3,
          z = a[1] + (b[1] - a[1]) * t + nz * 1.3;
        if (!env.nearRoad(x, z, 9)) continue;
        if (env.nearRoad(x, z, 1.2) || env.nearPath(x, z, 1.6) || env.inBuilding(x, z, 0.8) || env.inRiver(x, z) || env.nearRail(x, z, 1.5)) continue;
        segs.push([x, z, Math.atan2(b[0] - a[0], b[1] - a[1]), L / n]);
      }
    }
  });
  if (!segs.length) return;
  // unit hedge block: 1 x 1 x 1, plus fringe cards on top and sides
  const box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  // UVs in metres for the tiling hedge cell
  const bp = box.attributes.position,
    bn = box.attributes.normal,
    buv = box.attributes.uv;
  for (let i = 0; i < bp.count; i++) {
    const ax = Math.abs(bn.getX(i)),
      ay = Math.abs(bn.getY(i));
    buv.setXY(i, ax > 0.5 ? bp.getZ(i) : bp.getX(i), ay > 0.5 ? bp.getZ(i) : bp.getY(i));
  }
  const H = 1.25,
    W = 0.95;
  const blocks = new THREE.InstancedMesh(box, hedgeMaterial(), segs.length);
  const m4 = new THREE.Matrix4(),
    qq = new THREE.Quaternion(),
    sv = new THREE.Vector3(),
    pv = new THREE.Vector3();
  segs.forEach(([x, z, yaw, len], i) => {
    qq.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    sv.set(W, H * (0.95 + hash(i * 0.31) * 0.1), len + 0.06);
    pv.set(x, 0, z);
    m4.compose(pv, qq, sv);
    blocks.setMatrixAt(i, m4);
  });
  blocks.castShadow = !!QUALITY[ctx.quality]?.shadows;
  blocks.receiveShadow = true;
  ctx.scene.add(blocks);
}

function hedgeMaterial() {
  const own = {
    uAtlas: { value: tex['foliage_atlas.png'] },
    // hornbeam: green in summer, keeps dry brown leaves through winter
    uS0: { value: new THREE.Color(0x2f4a1a) },
    uS1: { value: new THREE.Color(0x52702a) },
    uA0: { value: new THREE.Color(0x7a5528) },
    uA1: { value: new THREE.Color(0xa07a3a) },
  };
  const m = new THREE.MeshStandardMaterial({ roughness: 0.9 });
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms, U, own);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vH; varying vec3 vHp;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvH = uv;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvHp = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\nvarying vec2 vH; varying vec3 vHp; uniform sampler2D uAtlas; uniform vec3 uS0; uniform vec3 uS1; uniform vec3 uA0; uniform vec3 uA1; uniform vec4 uSeason; uniform float uSnow;`,
      )
      .replace(
        '#include <map_fragment>',
        `vec2 hp = vec2(vHp.x + vHp.z, vHp.y + (vHp.x - vHp.z) * 0.37) / 1.4;
vec4 at = texture2D(uAtlas, vec2(0.25 + fract(hp.x) * 0.25, fract(hp.y) * 0.5));
float id = at.g;
float winter = step(0.5, uSeason.y) * (1.0 - uSeason.x);
float tr = step(fract(id * 5.37), uSeason.y * 0.8 + winter);
vec3 c = mix(mix(uS0, uS1, fract(id * 3.17)), mix(uA0, uA1, fract(id * 2.3)), tr);
diffuseColor.rgb = c * (0.3 + at.r * 1.15);
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.88, 0.9, 0.94), uSnow * smoothstep(0.2, 0.9, normal.y + 0.3) * 0.8);`,
      );
  };
  m.customProgramCacheKey = () => 'veg-hedge';
  return m;
}

// ---------------------------------------------------------------- flower beds
function crossCard(cellIdx, w, h) {
  const cu = (cellIdx % 4) * 0.25,
    cv = 1 - (Math.floor(cellIdx / 4) + 1) * 0.5;
  const pos = [],
    nrm = [],
    uv = [],
    idx = [];
  for (const a of [0, Math.PI / 2]) {
    const dx = Math.cos(a) * w * 0.5,
      dz = Math.sin(a) * w * 0.5;
    const b = pos.length / 3;
    pos.push(-dx, 0, -dz, dx, 0, dz, dx, h, dz, -dx, h, -dz);
    for (let i = 0; i < 4; i++) nrm.push(0, 1, 0);
    uv.push(cu + 0.002, cv + 0.002, cu + 0.248, cv + 0.002, cu + 0.248, cv + 0.498, cu + 0.002, cv + 0.498);
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

function smallPlantMaterial(palette, lodFar, flowers) {
  const own = {
    uAtlas: { value: tex['foliage_atlas.png'] },
    uS0: { value: new THREE.Color(palette[0]) },
    uS1: { value: new THREE.Color(palette[1]) },
    uA0: { value: new THREE.Color(palette[2]) },
    uA1: { value: new THREE.Color(palette[3]) },
    uBarkC: { value: new THREE.Color(0x4a6a24) },
    uTurnOff: { value: 0 },
    uLod: { value: new THREE.Vector4(-2, -1, lodFar, lodFar + 8) },
  };
  const m = new THREE.MeshStandardMaterial({ roughness: 0.85, side: THREE.DoubleSide });
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms, U, own);
    patchVert(sh, false);
    sh.vertexShader = sh.vertexShader.replace('float hh = max(0.0, position.y - 1.8);', 'float hh = position.y * 6.0;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>${FRAG_HEAD}`)
      .replace(
        '#include <map_fragment>',
        flowers
          ? `if (vFade < 0.999 && vFade <= vgHash(gl_FragCoord.xy)) discard;
vec4 at = texture2D(uAtlas, vAtl);
if (at.a < 0.5) discard;
float id = at.g;
vec3 col;
if (id > 0.55) {
  if (fract(id * 3.7 + vRand) > uSeason.w) discard;
  float k = fract(id * 4.1 + vRand * 0.7);
  col = k < 0.25 ? uA0 : k < 0.5 ? uA1 : k < 0.75 ? uS1 : vec3(0.85, 0.82, 0.78);
} else col = uS0 * (0.8 + 0.4 * fract(id * 9.1));
diffuseColor.rgb = col * (0.4 + at.r * 1.0);`
          : FRAG_LEAF,
      )
      .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nnormal = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);');
  };
  m.customProgramCacheKey = () => `veg-small-${flowers}`;
  return m;
}

function buildFlowerBeds(lawns, env, trees, S) {
  const rng = createRng(99);
  const occ = new SpatialGrid(30);
  for (const t of trees) occ.insert(t.x, t.z, t);
  const beds = [];
  lawns.polys.forEach((p) => {
    if (!p.park) return;
    const A = Math.abs(area(p.ring));
    if (A < 2500) return;
    const n = Math.min(4, Math.floor(A / 9000) + 1);
    for (let k = 0, tries = 0; k < n && tries < 40; tries++) {
      const x = lerp(p.b.minx, p.b.maxx, rng()),
        z = lerp(p.b.minz, p.b.maxz, rng());
      const r = 2 + rng() * 2.5;
      if (!pip(x, z, p.ring) || env.nearPath(x, z, r + 0.5) || env.nearRoad(x, z, r + 2) || env.inBuilding(x, z, r + 1)) continue;
      let blocked = false;
      for (const t of occ.query(x, z, r + 6)) if (Math.hypot(t.x - x, t.z - z) < r + 3) blocked = true;
      if (blocked || !pathNearby(env, x, z, r + 7)) continue;
      beds.push([x, z, r]);
      k++;
    }
  });
  if (!beds.length) return;
  const gb = new GeoBuilder();
  const soil = new THREE.Color(0x3b2a1e);
  const edge = new THREE.Color(0x8d8a80);
  for (const [x, z, r] of beds) {
    const ring = [],
      ring2 = [];
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      ring.push([x + Math.cos(a) * r, z + Math.sin(a) * r * 0.8]);
      ring2.push([x + Math.cos(a) * (r + 0.25), z + Math.sin(a) * (r + 0.25) * 0.8]);
    }
    addFlatPoly(gb, ring2, 0.05, edge);
    addFlatPoly(gb, ring, 0.07, soil);
  }
  const bedMesh = new THREE.Mesh(gb.build(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }));
  bedMesh.receiveShadow = true;
  ctx.scene.add(bedMesh);
  if (S[3] <= 0.01) return;
  const plants = [];
  for (const [x, z, r] of beds) {
    const n = Math.round(r * r * 5);
    for (let i = 0; i < n; i++) {
      const a = rng() * 6.283,
        d = Math.sqrt(rng()) * (r - 0.25);
      plants.push([x + Math.cos(a) * d, z + Math.sin(a) * d * 0.8, rng()]);
    }
  }
  // pansies, tulips, salvia, white alyssum (colours picked per blossom)
  const mat = smallPlantMaterial([0x355a1d, 0xe2c21e, 0xb0182a, 0x5b2a8c], 140, true);
  const im = new THREE.InstancedMesh(crossCard(7, 0.7, 0.55), mat, plants.length);
  const m4 = new THREE.Matrix4(),
    qq = new THREE.Quaternion(),
    sv = new THREE.Vector3(),
    pv = new THREE.Vector3();
  plants.forEach(([x, z, r], i) => {
    qq.setFromAxisAngle(new THREE.Vector3(0, 1, 0), r * 6.283);
    sv.setScalar(0.8 + r * 0.5);
    pv.set(x, 0.06, z);
    m4.compose(pv, qq, sv);
    im.setMatrixAt(i, m4);
  });
  im.frustumCulled = true;
  im.computeBoundingSphere?.();
  ctx.scene.add(im);
}
function pathNearby(env, x, z, r) {
  for (const [a, b, hw] of env.pathSegs.query(x, z, r + 20)) if (segDist(x, z, a[0], a[1], b[0], b[1]).d < r + hw) return true;
  return false;
}

// ---------------------------------------------------------------- canopy map (lawn shade + leaf litter)
function buildCanopyMap(trees) {
  const R = 1024,
    E = 8400,
    o = -4200;
  const data = new Float32Array(R * R);
  const px = E / R;
  for (const t of trees) {
    const sp = SPECIES[t.sp];
    const rad = sp.rx * sp.h * t.s * 1.15;
    const cx = (t.x - o) / px,
      cz = (t.z - o) / px,
      rr = rad / px;
    for (let j = Math.floor(cz - rr); j <= Math.ceil(cz + rr); j++)
      for (let i = Math.floor(cx - rr); i <= Math.ceil(cx + rr); i++) {
        if (i < 0 || j < 0 || i >= R || j >= R) continue;
        const d = Math.hypot(i + 0.5 - cx, j + 0.5 - cz) / rr;
        if (d < 1) data[j * R + i] = Math.min(1, data[j * R + i] + (1 - d * d) * 0.8);
      }
  }
  const u8 = new Uint8Array(R * R);
  for (let i = 0; i < u8.length; i++) u8[i] = data[i] * 255;
  const t = new THREE.DataTexture(u8, R, R, THREE.RedFormat, THREE.UnsignedByteType);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  canopyU.uCanopy.value = t;
}

// ---------------------------------------------------------------- grass tufts near the camera (high/ultra)
function buildTufts(lawns, env, q) {
  const CELL = 12,
    RAD = 36,
    PER = Math.round(26 * q.tufts);
  const max = Math.ceil(((RAD * 2) / CELL + 1) ** 2) * PER;
  const mat = smallPlantMaterial([0x3d5e1e, 0x6d8a2c, 0x8a8a3a, 0xa09048], RAD - 6, false);
  const im = new THREE.InstancedMesh(crossCard(6, 0.55, 0.42), mat, max);
  im.count = 0;
  im.frustumCulled = false;
  im.receiveShadow = true;
  ctx.scene.add(im);
  const cache = new Map();
  const m4 = new THREE.Matrix4(),
    qq = new THREE.Quaternion(),
    sv = new THREE.Vector3(),
    pv = new THREE.Vector3();
  const cellTufts = (cx, cz) => {
    const key = `${cx},${cz}`;
    if (cache.has(key)) return cache.get(key);
    const rng = createRng((cx * 73856093) ^ (cz * 19349663) || 1);
    const out = [];
    for (let i = 0; i < PER * 2 && out.length < PER; i++) {
      const x = (cx + rng()) * CELL,
        z = (cz + rng()) * CELL;
      const r = rng();
      if (!lawns.inLawn(x, z) || env.nearPath(x, z, 0.6) || env.nearRoad(x, z, 1)) continue;
      qq.setFromAxisAngle(new THREE.Vector3(0, 1, 0), r * 6.283);
      sv.set(0.8 + r * 0.6, 0.6 + r * 0.8, 0.8 + r * 0.6);
      pv.set(x, 0.02, z);
      m4.compose(pv, qq, sv);
      out.push(m4.toArray(new Float32Array(16)));
    }
    if (cache.size > 400) cache.clear();
    cache.set(key, out);
    return out;
  };
  let lastKey = '';
  return {
    update(cp) {
      if (cp.y > 40) {
        im.visible = false;
        return;
      }
      im.visible = true;
      const kx = Math.floor(cp.x / 4),
        kz = Math.floor(cp.z / 4);
      const key = `${kx},${kz}`;
      if (key === lastKey) return;
      lastKey = key;
      let n = 0;
      const c0x = Math.floor((cp.x - RAD) / CELL),
        c1x = Math.floor((cp.x + RAD) / CELL);
      const c0z = Math.floor((cp.z - RAD) / CELL),
        c1z = Math.floor((cp.z + RAD) / CELL);
      for (let i = c0x; i <= c1x; i++)
        for (let j = c0z; j <= c1z; j++)
          for (const a of cellTufts(i, j)) {
            if (n >= max) break;
            im.instanceMatrix.array.set(a, n * 16);
            n++;
          }
      im.count = n;
      im.instanceMatrix.needsUpdate = true;
    },
  };
}
