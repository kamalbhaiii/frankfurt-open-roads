/**
 * World materials. Standard three.js materials patched with small shader chunks for
 * wet roads (puddles, gloss, rain ripples), snow cover and paving patterns.
 *
 *   uniforms                         shared uWet/uSnow/uNight/uTime (driven by the environment)
 *   groundMaterial(color, rough)     flat vertex-coloured surface that reacts to wet/snow
 *   worldMaterial(color, rough, frag) world-space procedural surface (frag edits diffuseColor using vWp)
 *   surfaceMaterial(name, opts)      CC0 PBR texture set from textures/streets/ with world-space UVs,
 *                                    anti-repetition (two-sample blend + macro variation), puddles, snow
 *   markingMaterial()                road paint / decal atlas (lines, arrows, manholes, gullies), worn paint
 *   railingMaterial(style)           alpha-tested procedural bridge railing ('rail' | 'lattice')
 *
 * OWNER: streets & ground agent.
 */
import * as THREE from 'three';
import { ctx } from '../core/context.js';
import { assets } from '../core/assets.js';

/** Uniforms shared by every patched material; updated by the environment system. */
export const uniforms = { uNight: { value: 0 }, uSnow: { value: 0 }, uWet: { value: 0 }, uTime: { value: 0 } };

/** Hash + value noise used by the procedural chunks (needs `vWp` only where callers use it). */
const NOISE = `
float hh(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f); return mix(mix(hh(i), hh(i+vec2(1,0)), f.x), mix(hh(i+vec2(0,1)), hh(i+vec2(1,1)), f.x), f.y); }`;

let keySeq = 0;
/** Unique program key per patched material variant (onBeforeCompile closures share their source text). */
const programKey = (m, key) => {
  m.customProgramCacheKey = () => key;
  return m;
};

const quality = () => ctx.quality || 'high';
const detailOn = () => quality() !== 'low';

export function groundMaterial(color, rough = 0.95, wetAffects = true) {
  const m = new THREE.MeshStandardMaterial({
    color,
    roughness: rough,
    vertexColors: true,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -2,
  });
  if (wetAffects) {
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, uniforms);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uWet; uniform float uSnow;')
        .replace(
          '#include <color_fragment>',
          '#include <color_fragment>\ndiffuseColor.rgb *= mix(1.0, 0.55, uWet); diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.9,0.92,0.96), uSnow*0.85);',
        )
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.12, uWet);');
    };
    programKey(m, 'groundMat');
  }
  return m;
}

/** World-space patterned surface (asphalt, paving, kerbs). `frag` modifies diffuseColor using vWp. */
export function worldMaterial(color, rough, frag) {
  const m = new THREE.MeshStandardMaterial({ color, roughness: rough, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWp;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWp = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vWp; uniform float uWet; uniform float uSnow;${NOISE}`)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
${frag}
diffuseColor.rgb *= mix(1.0, 0.55, uWet); diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.9,0.92,0.96), uSnow * 0.85);`,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.1, uWet);');
  };
  return programKey(m, `worldMat${keySeq++}`);
}

// ---------------------------------------------------------------- textured street surfaces

const TEX_DIR = 'textures/streets/';
const texSets = new Map();
/** Colour (+ normal/roughness on medium+) maps of one CC0 surface set, loaded once. */
function textureSet(name, detail) {
  const key = `${name}:${detail}`;
  if (!texSets.has(key)) {
    const t = (suf, srgb) => assets.texture(`${TEX_DIR}${name}_${suf}.jpg`, { srgb, repeat: true });
    texSets.set(key, { col: t('col', true), nrm: detail ? t('nrm', false) : null, rgh: detail ? t('rgh', false) : null });
  }
  return texSets.get(key);
}

/** Shared wet / puddle / snow treatment. Expects col, rgh, nT (tangent-space normal), vWp, vWn, cavity. */
const WEATHER_GLSL = `
{
  float up = smoothstep(0.55, 0.9, vWn.y);
  float wet = uWet * mix(0.55, 1.0, up);
  float pn = vn(vWp.xz * 0.09 + 3.1) * 0.6 + vn(vWp.xz * 0.31 + 7.7) * 0.3 + vn(vWp.xz * 1.3) * 0.1;
  float puddle = smoothstep(0.6, 0.66, pn + cavity * 0.1) * smoothstep(0.3, 0.85, uWet) * uPuddles * up;
  col *= mix(1.0, uWetDark, wet);
  col *= mix(1.0, 0.8, puddle);
  rgh = mix(rgh, max(0.06, rgh * 0.32), wet);
  rgh = mix(rgh, 0.025, puddle);
  nT = normalize(mix(nT, vec3(0.0, 0.0, 1.0), max(puddle, wet * 0.45)));
#ifdef SURF_RIPPLES
  if (puddle > 0.01) {
    vec2 rp = vWp.xz * 2.2; vec2 ci = floor(rp); vec2 rr = vec2(0.0);
    for (int k = 0; k < 4; k++) {
      vec2 o = vec2(float(k / 2), float(k - (k / 2) * 2));
      vec2 c = ci + o; float h = hh(c);
      float ph = fract(uTime * 0.9 + h * 7.0);
      vec2 d = rp - (c + vec2(hh(c + 3.7), hh(c + 9.1)));
      float dl = length(d) + 1e-4;
      float ring = sin((dl - ph * 0.9) * 40.0) * smoothstep(0.12, 0.0, abs(dl - ph * 0.9)) * (1.0 - ph);
      rr += d / dl * ring;
    }
    nT = normalize(nT + vec3(rr * 0.35 * puddle * uWet, 0.0));
  }
#endif
  float snow = uSnow * smoothstep(0.45, 0.85, vWn.y) * (0.78 + 0.22 * vn(vWp.xz * 0.45));
  col = mix(col, vec3(0.9, 0.92, 0.96), snow * 0.9);
  rgh = mix(rgh, 0.8, snow);
  nT = normalize(mix(nT, vec3(0.0, 0.0, 1.0), snow));
}`;

/**
 * Textured street surface.
 * @param {string|null} name texture set in textures/streets/ (asphalt|slabs|setts|cobble|granite|sandstone) or null (procedural only)
 * @param {object} o
 *   scale: metres per texture repeat (number or [u, v]) · uv: 'world' (x/z) | 'attr' (uv attribute in metres) | 'tri' (box/wall projection)
 *   bomb: 'free' (random rotation, wide blend) | 'patch' (90° rotated patches, sharp seams) | 'none'
 *   tint · rough: [min, max] roughness · macro: brightness variation · normal: normal strength · puddles: 0..1
 *   wetDark: colour factor when wet · vertexColors · offset: [polygonOffsetFactor, units] · frag: GLSL editing col/rgh/nT/cavity
 */
export function surfaceMaterial(name, o = {}) {
  const detail = detailOn();
  const ripples = quality() === 'high' || quality() === 'ultra';
  const bomb = ripples ? (o.bomb ?? 'free') : 'none'; // second texture sample only on high/ultra
  const sc = Array.isArray(o.scale) ? o.scale : [o.scale ?? 2, o.scale ?? 2];
  const m = new THREE.MeshStandardMaterial({ color: o.tint ?? 0xffffff, roughness: 1, metalness: o.metal ?? 0, vertexColors: !!o.vertexColors, side: o.side ?? THREE.FrontSide });
  if (o.offset) {
    m.polygonOffset = true;
    m.polygonOffsetFactor = o.offset[0];
    m.polygonOffsetUnits = o.offset[1];
  }
  const set = name ? textureSet(name, detail) : null;
  const u = {
    tCol: { value: set?.col ?? null },
    tNrm: { value: set?.nrm ?? null },
    tRgh: { value: set?.rgh ?? null },
    uInvScale: { value: new THREE.Vector2(1 / sc[0], 1 / sc[1]) },
    uRough: { value: new THREE.Vector2(...(o.rough ?? [0.75, 0.95])) },
    uMacro: { value: o.macro ?? 0.12 },
    uNrm: { value: o.normal ?? 1 },
    uPuddles: { value: o.puddles ?? 0 },
    uWetDark: { value: o.wetDark ?? 0.6 },
  };
  m.userData.surface = u;
  const defs = [];
  if (set) defs.push('#define SURF_TEX');
  if (set && detail) defs.push('#define SURF_DETAIL');
  if (ripples && (o.puddles ?? 0) > 0) defs.push('#define SURF_RIPPLES');
  defs.push(`#define SURF_UV_${(o.uv ?? 'world').toUpperCase()}`);
  if (bomb !== 'none') defs.push(`#define SURF_BOMB ${bomb === 'free' ? 1 : 2}`);
  const header = defs.join('\n');
  const frag = o.frag ?? '';
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${header}\nvarying vec3 vWp; varying vec3 vWn; varying vec2 vSUv;`)
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vWp = (modelMatrix * vec4(transformed, 1.0)).xyz;
vWn = normalize(mat3(modelMatrix) * objectNormal);
#ifdef SURF_UV_ATTR
vSUv = uv;
#else
vSUv = vWp.xz;
#endif`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
${header}
varying vec3 vWp; varying vec3 vWn; varying vec2 vSUv;
uniform float uWet; uniform float uSnow; uniform float uTime;
uniform sampler2D tCol; uniform sampler2D tNrm; uniform sampler2D tRgh;
uniform vec2 uInvScale; uniform vec2 uRough; uniform float uMacro; uniform float uNrm; uniform float uPuddles; uniform float uWetDark;
${NOISE}
vec3 surfPerturb(vec3 eye, vec3 N, vec3 mapN, vec2 uv) {
  vec3 q0 = dFdx(eye), q1 = dFdy(eye); vec2 st0 = dFdx(uv), st1 = dFdy(uv);
  vec3 q1perp = cross(q1, N), q0perp = cross(N, q0);
  vec3 T = q1perp * st0.x + q0perp * st1.x, B = q1perp * st0.y + q0perp * st1.y;
  float det = max(dot(T, T), dot(B, B)); float s = det == 0.0 ? 0.0 : inversesqrt(det);
  return normalize(T * (mapN.x * s) + B * (mapN.y * s) + N * mapN.z);
}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
#ifdef SURF_UV_TRI
vec2 suvM = abs(vWn.y) > 0.7 ? vWp.xz : (abs(vWn.x) > abs(vWn.z) ? vec2(vWp.z, vWp.y) : vec2(vWp.x, vWp.y));
#else
vec2 suvM = vSUv;
#endif
vec2 suv = suvM * uInvScale;
vec3 col = vec3(1.0); float rgh = 0.5 * (uRough.x + uRough.y); vec3 nT = vec3(0.0, 0.0, 1.0); float cavity = 0.0;
#ifdef SURF_TEX
{
  vec4 cA = texture(tCol, suv);
#ifdef SURF_DETAIL
  vec3 nA = texture(tNrm, suv).xyz * 2.0 - 1.0; float rA = texture(tRgh, suv).g;
#endif
#ifdef SURF_BOMB
#if SURF_BOMB == 1
  const mat2 R = mat2(0.5403, 0.8415, -0.8415, 0.5403); vec2 uvB = R * suv + vec2(0.37, 0.71);
  float w = smoothstep(0.3, 0.7, vn(vWp.xz * 0.06 + vWp.y * 0.06 + 11.0));
#else
  const mat2 R = mat2(0.0, 1.0, -1.0, 0.0); vec2 uvB = R * suv;
  float w = smoothstep(0.47, 0.53, vn(vWp.xz * 0.11 + vWp.y * 0.11 + 5.0));
#endif
  vec4 cB = texture(tCol, uvB);
  vec3 mean = textureLod(tCol, vec2(0.5), 12.0).rgb;
  col = mean + (mix(cA.rgb, cB.rgb, w) - mean) / max(0.71, sqrt(w * w + (1.0 - w) * (1.0 - w)));
#ifdef SURF_DETAIL
  vec3 nB = texture(tNrm, uvB).xyz * 2.0 - 1.0; nB.xy = transpose(R) * nB.xy;
  nA = mix(nA, nB, w); rA = mix(rA, texture(tRgh, uvB).g, w);
#endif
#else
  col = cA.rgb;
#endif
  float lum = dot(col, vec3(0.333));
  float lumMean = dot(textureLod(tCol, vec2(0.5), 12.0).rgb, vec3(0.333));
  cavity = clamp((lumMean - lum) * 4.0, 0.0, 1.0);
#ifdef SURF_DETAIL
  nT = normalize(vec3(nA.xy * uNrm, max(nA.z, 0.05)));
  rgh = mix(uRough.x, uRough.y, rA);
#endif
}
#endif
col *= 1.0 + uMacro * ((vn(vWp.xz * 0.013 + vWp.y * 0.013) * 0.6 + vn(vWp.xz * 0.06 + 2.0) * 0.4) * 2.0 - 1.0);
${frag}
${WEATHER_GLSL}
diffuseColor.rgb *= col;`,
      )
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = clamp(rgh, 0.02, 1.0);')
      .replace(
        '#include <normal_fragment_maps>',
        `#ifdef SURF_DETAIL
normal = surfPerturb(-vViewPosition, normal, nT, suv);
#endif`,
      );
  };
  return programKey(m, `surf:${name}:${header}:${frag}`);
}

// ---------------------------------------------------------------- road paint / decal atlas

const ATLAS_SIZE = 1024;
/** Atlas cells in pixels [x, y, w, h] (canvas coordinates, y down). Arrows point to the cell top. */
export const ATLAS = {
  solid: [8, 8, 48, 48],
  tyre: [72, 8, 240, 48],
  S: [8, 80, 112, 368],
  L: [136, 80, 112, 368],
  R: [264, 80, 112, 368],
  SL: [392, 80, 112, 368],
  SR: [520, 80, 112, 368],
  bike: [648, 80, 240, 240],
  manhole: [8, 472, 240, 240],
  gully: [264, 472, 240, 160],
  valve: [520, 472, 112, 112],
  BUS: [648, 336, 240, 368],
};

/** UV rectangle of an atlas cell: [u0, v0, u1, v1] (v up). */
export function atlasUV(cell) {
  const [x, y, w, h] = ATLAS[cell];
  return [x / ATLAS_SIZE, 1 - (y + h) / ATLAS_SIZE, (x + w) / ATLAS_SIZE, 1 - y / ATLAS_SIZE];
}

function drawAtlas() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = ATLAS_SIZE;
  const g = cv.getContext('2d');
  g.fillStyle = '#fff';
  const cell = (k) => ATLAS[k];
  {
    const [x, y, w, h] = cell('solid');
    g.fillRect(x - 6, y - 6, w + 12, h + 12);
  }
  {
    // tyre wear band: two wheel paths and a faint oil strip in the lane centre (u across the lane)
    const [x, y, w, h] = cell('tyre');
    for (let i = 0; i < w; i++) {
      const u = i / (w - 1);
      const gs = (c, s) => Math.exp(-((u - c) ** 2) / (2 * s * s));
      const a = Math.min(1, 0.85 * (gs(0.24, 0.07) + gs(0.76, 0.07)) + 0.55 * gs(0.5, 0.05));
      g.fillStyle = `rgba(0,0,0,${a.toFixed(3)})`;
      g.fillRect(x + i, y - 6, 1, h + 12);
    }
  }
  // German direction arrows (RMS): long shaft, broad head; cell 112 x 368 px ≈ 1.2 m x 5 m
  const arrow = (k, moves) => {
    const [x, y, w, h] = cell(k);
    const cx = x + w / 2;
    g.save();
    g.fillStyle = '#fff';
    g.strokeStyle = '#fff';
    g.lineCap = 'butt';
    const shaftW = 16;
    const head = (px, py, ang, len = 74, wid = 70) => {
      g.save();
      g.translate(px, py);
      g.rotate(ang);
      g.beginPath();
      g.moveTo(0, -len);
      g.lineTo(wid / 2, 0);
      g.lineTo(-wid / 2, 0);
      g.closePath();
      g.fill();
      g.restore();
    };
    const straight = moves.includes('S');
    const bottom = y + h - 4;
    const top = y + 8;
    if (straight) {
      g.fillRect(cx - shaftW / 2, top + 70, shaftW, bottom - top - 70);
      head(cx, top + 74, 0, 74, 62);
    } else g.fillRect(cx - shaftW / 2, y + h * 0.42, shaftW, bottom - (y + h * 0.42));
    for (const side of moves.filter((m) => m !== 'S')) {
      const s = side === 'L' ? -1 : 1;
      const by = straight ? y + h * 0.62 : y + h * 0.42;
      g.lineWidth = shaftW;
      g.beginPath();
      g.moveTo(cx, by + 30);
      g.quadraticCurveTo(cx, by - 20, cx + s * 26, by - 44);
      g.stroke();
      head(cx + s * 24, by - 42, s * 0.85, 52, 50);
    }
    g.restore();
  };
  arrow('S', ['S']);
  arrow('L', ['L']);
  arrow('R', ['R']);
  arrow('SL', ['S', 'L']);
  arrow('SR', ['S', 'R']);
  {
    // bicycle pictogram (Radfahrstreifen); front wheel towards the cell top
    const [x, y, w, h] = cell('bike');
    g.save();
    g.translate(x + w / 2, y + h / 2);
    g.rotate(-Math.PI / 2);
    g.strokeStyle = '#fff';
    g.lineWidth = 12;
    for (const sx of [-58, 58]) {
      g.beginPath();
      g.arc(sx, 22, 40, 0, Math.PI * 2);
      g.stroke();
    }
    g.beginPath();
    g.moveTo(-58, 22);
    g.lineTo(-10, 22);
    g.lineTo(30, -26);
    g.lineTo(-24, -26);
    g.lineTo(-58, 22);
    g.moveTo(-10, 22);
    g.lineTo(-30, -44);
    g.moveTo(-44, -44);
    g.lineTo(-16, -44);
    g.moveTo(58, 22);
    g.lineTo(36, -46);
    g.lineTo(18, -50);
    g.stroke();
    g.restore();
  }
  {
    // cast-iron manhole cover (Schachtabdeckung DN 625) with frame and raised pattern
    const [x, y, w] = cell('manhole');
    const cx = x + w / 2,
      cy = y + w / 2,
      R = w / 2 - 2;
    g.fillStyle = '#6d6a66';
    g.beginPath();
    g.arc(cx, cy, R, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#3c3b3a';
    g.beginPath();
    g.arc(cx, cy, R * 0.82, 0, Math.PI * 2);
    g.fill();
    g.save();
    g.beginPath();
    g.arc(cx, cy, R * 0.78, 0, Math.PI * 2);
    g.clip();
    g.fillStyle = '#5a5855';
    for (let i = -12; i <= 12; i++)
      for (let j = -12; j <= 12; j++) if ((i + j) % 2 === 0) g.fillRect(cx + i * 10 - 3, cy + j * 10 - 3, 6, 6);
    g.fillStyle = '#4a4846';
    g.fillRect(cx - R, cy - 9, 2 * R, 18);
    g.fillRect(cx - 9, cy - R, 18, 2 * R);
    g.restore();
    g.fillStyle = '#2a2a2a';
    for (const a of [0.6, 3.74]) {
      g.beginPath();
      g.ellipse(cx + Math.cos(a) * R * 0.6, cy + Math.sin(a) * R * 0.6, 9, 5, a, 0, Math.PI * 2);
      g.fill();
    }
  }
  {
    // street gully grate (Straßenablauf 500 x 300) — slots run across the kerb line
    const [x, y, w, h] = cell('gully');
    g.fillStyle = '#5f5d5a';
    g.fillRect(x, y, w, h);
    g.fillStyle = '#3a3937';
    g.fillRect(x + 12, y + 12, w - 24, h - 24);
    g.fillStyle = '#0c0c0c';
    for (let i = 0; i < 11; i++) g.fillRect(x + 22 + i * 18.5, y + 22, 10, h - 44);
  }
  {
    // small round valve cap (Hydrant / Schieberkappe)
    const [x, y, w] = cell('valve');
    const cx = x + w / 2,
      cy = y + w / 2;
    g.fillStyle = '#5d5a56';
    g.beginPath();
    g.arc(cx, cy, w / 2 - 2, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#34322f';
    g.beginPath();
    g.arc(cx, cy, w / 2 - 14, 0, Math.PI * 2);
    g.fill();
  }
  {
    // "BUS" lane lettering, stretched along the lane (letters stacked from the bottom)
    const [x, y, w, h] = cell('BUS');
    g.save();
    g.fillStyle = '#fff';
    g.font = 'bold 150px Arial, Helvetica, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const letters = ['B', 'U', 'S'];
    letters.forEach((ch, i) => {
      g.save();
      g.translate(x + w / 2, y + h - (i + 0.5) * (h / 3));
      g.scale(1.25, 0.8);
      g.fillText(ch, 0, 0);
      g.restore();
    });
    g.restore();
  }
  return cv;
}

let atlasTex = null;
export function markingAtlas() {
  if (!atlasTex) {
    atlasTex = new THREE.CanvasTexture(drawAtlas());
    atlasTex.colorSpace = THREE.SRGBColorSpace;
    atlasTex.anisotropy = assets.maxAnisotropy;
    atlasTex.generateMipmaps = true;
    atlasTex.minFilter = THREE.LinearMipmapLinearFilter;
  }
  return atlasTex;
}

/**
 * Road paint and flat decals. Geometry needs uv (atlas), color (tint) and aDec = (opacity, wear).
 * Paint wears in world space, disappears under snow and turns glossy when wet.
 */
export function markingMaterial() {
  const m = new THREE.MeshStandardMaterial({
    map: markingAtlas(),
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    roughness: 0.55,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -8,
  });
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 aDec; varying vec2 vDec; varying vec3 vWp;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvDec = aDec; vWp = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec2 vDec; varying vec3 vWp; uniform float uWet; uniform float uSnow;${NOISE}`)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
{
  float wn = vn(vWp.xz * 0.9) * 0.55 + vn(vWp.xz * 4.0) * 0.3 + hh(floor(vWp.xz * 30.0)) * 0.15;
  float worn = vDec.y * smoothstep(0.42, 0.8, wn);
  diffuseColor.a *= vDec.x * (1.0 - worn) * (1.0 - uSnow * 0.92);
  diffuseColor.rgb *= mix(1.0, 0.86, vDec.y * vn(vWp.xz * 0.35));
  diffuseColor.rgb *= mix(1.0, 0.72, uWet);
}`,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.08, uWet);');
  };
  return programKey(m, 'marking');
}

/** Steel rail heads / tram grooves (vertex colour picks bright head vs dark groove). */
export function railMaterial() {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.85, roughness: 0.32, polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -10 });
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uWet; uniform float uSnow;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.88,0.9,0.94), uSnow*0.6);')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.12, uWet);');
  };
  return programKey(m, 'railMetal');
}

/**
 * Alpha-tested procedural bridge railing drawn on vertical quads (uv = metres along, metres up).
 * 'rail': steel posts every 2 m, top + bottom rail and slim balusters; 'lattice': riveted diamond truss.
 */
export function railingMaterial(style = 'rail', color = 0x3d4448) {
  const m = new THREE.MeshStandardMaterial({ color, metalness: 0.55, roughness: 0.5, side: THREE.DoubleSide, alphaTest: 0.5 });
  const pattern =
    style === 'lattice'
      ? `float a = 0.0; vec2 p = vUv;
  float d1 = abs(fract((p.x + p.y) / 1.3) - 0.5), d2 = abs(fract((p.x - p.y) / 1.3) - 0.5);
  a = max(step(d1, 0.035), step(d2, 0.035));
  a = max(a, step(p.y, 0.12)); a = max(a, step(1.18, p.y));
  a = max(a, step(abs(fract(p.x / 2.6) - 0.5), 0.025));`
      : `float a = 0.0; vec2 p = vUv;
  a = max(step(1.0, p.y), step(p.y, 0.1));
  a = max(a, step(abs(fract(p.x / 2.0) - 0.5), 0.025));
  a = max(a, step(abs(fract(p.x / 0.13) - 0.5), 0.09) * step(p.y, 1.0));`;
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vUv;').replace('#include <uv_vertex>', '#include <uv_vertex>\nvUv = uv;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vUv; uniform float uWet; uniform float uSnow;')
      .replace(
        '#include <alphatest_fragment>',
        `{ ${pattern}
  diffuseColor.a = a; }
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.9,0.92,0.96), uSnow * step(0.95, vUv.y) * 0.8);
#include <alphatest_fragment>`,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.15, uWet);');
  };
  return programKey(m, `railing:${style}`);
}
