/**
 * Skinned, animated characters (GLB from tools/models/characters.mjs) with per-instance outfits,
 * colours, body types, accessories, LOD and animation throttling.
 *
 * Clips: idle, walk (1.45 m/s), run (6 m/s), jump, swim, sit (car driver), fall (once), wave,
 *        jog (3 m/s), walk_senior (1.0 m/s), talking, phone, waiting, sitting (bench), cycling (5 m/s).
 *   play('walk') / play('run') are remapped per person (seniors -> walk_senior, joggers -> jog) and the
 *   time scale is corrected so feet stay planted; pass the same speed ratio as before (speed / 1.45).
 *   sitting: root at the bench centre on the ground, facing away from the backrest, seat top 0.48 m (BENCH_RIG).
 *   cycling: root placed like a driver (vehicles.setDriver) on the 'bicycle' vehicle; crank/saddle/grips in CYCLE_RIG.
 *
 * Each model holds every outfit part at two LODs in one vertex buffer; an instance draws only its
 * parts through a cached index buffer (1 draw call + 1 shadow call per person). Colours come from a
 * per-instance palette uniform (no per-instance vertex buffers).
 *
 * randomPerson(opts?)  opts.style: 'business' | 'tourist' | 'casual' | 'student' | 'senior' | 'jogger'
 *                      opts.area:  hint picking a style mix: 'business' | 'shopping' | 'oldtown' | 'park' |
 *                                  'campus' | 'residential' | 'station' (anything else = city mix)
 *                      opts.female: boolean, opts.weather: { temp, rain } (default ctx.env.weather)
 *   The returned Character has .style, .preferredSpeed (m/s), .senior, and accessory control:
 *   ch.setAccessory(name, on), ch.hasAccessory(name), ch.setUmbrella(on); ACCESSORIES lists the names.
 *   Umbrellas are a part of the same mesh (no extra material); with opts.autoUmbrella the person opens it
 *   by itself while ctx.env.weather.rain > 0.15 (pedestrians.js drives setUmbrella itself instead).
 */
import * as THREE from 'three';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { ctx } from '../core/context.js';
import { rnd } from '../core/math.js';

/** Accessories that can be toggled at runtime (part names in the model). */
export const ACCESSORIES = ['umbrella', 'phone', 'cup', 'briefcase', 'shopbag', 'backpack', 'crossbody', 'camera', 'headphones', 'glasses', 'scarf'];
export const STYLES = ['business', 'tourist', 'casual', 'student', 'senior', 'jogger'];
/** Bicycle geometry assumed by the cycling clip (metres, in character-root space, +Z forward). */
export const CYCLE_RIG = { bb: [0, 0.225, 0.29], crank: 0.16, saddle: [0, 0.92, 0.09], grips: [0.25, 0.965, 0.58], speed: 5 };
/** Bench used by the sit_bench clip: seat surface height above the root. */
export const BENCH_RIG = { seatY: 0.48 };

/** Police uniform colours. */
export const POLICE_COLORS = { top: 0x1f3a6e, jacket: 0x1b2f57, pants: 0x1b2433, shoes: 0x111111 };
/** The protagonist's outfit. */
export const PLAYER_COLORS = { skin: 0xd9a07a, hair: 0x2a1d14, top: 0xe0e0e0, jacket: 0x2d2f33, pants: 0x2a2f45, shoes: 0x1c1c1c };

// per quality: LOD switch distance, animation throttle distances (every 2nd / 4th frame)
const LODQ = {
  low: { lod: 9, t2: 25, t4: 50 },
  medium: { lod: 14, t2: 35, t4: 70 },
  high: { lod: 20, t2: 45, t4: 90 },
  ultra: { lod: 30, t2: 60, t4: 120 },
};
const ROUGH = {
  skin: 0.52,
  hair: 0.48,
  top: 0.85,
  jacket: 0.72,
  pants: 0.85,
  shoes: 0.42,
  eyes: 0.15,
  lips: 0.4,
  sole: 0.7,
  sclera: 0.2,
  accent: 0.82,
  hat: 0.85,
  bag: 0.55,
  metal: 0.32,
  legwear: 0.55,
  socks: 0.9,
  umbrella: 0.5,
  belt: 0.4,
  bike: 0.35,
};
const DEFAULT_OUTFIT = {
  character_male: ['core', 'torso', 'arms_jacket', 'jacket_open', 'legs_trousers', 'shoes_sneaker', 'hair_short'],
  character_female: ['core', 'torso', 'arms_jacket', 'jacket_open', 'legs_trousers', 'shoes_sneaker', 'hair_bob'],
};
// clips during which hand-held items are hidden / hold poses applied
const HIDE = {
  umbrella: ['jump', 'swim', 'sit', 'fall', 'cycling', 'sitting', 'wave', 'phone'],
  phone: ['jump', 'swim', 'sit', 'fall', 'cycling', 'wave'],
  cup: ['jump', 'swim', 'sit', 'fall', 'cycling', 'phone'],
  briefcase: ['swim', 'sit', 'cycling', 'sitting', 'talking', 'phone', 'waiting'],
  shopbag: ['swim', 'sit', 'cycling', 'sitting', 'talking', 'phone', 'waiting'],
  backpack: ['swim', 'sit'],
  crossbody: ['swim', 'sit'],
  camera: ['swim'],
};
const HOLD_CLIPS = new Set(['idle', 'walk', 'walk_senior', 'run', 'jog', 'waiting', 'talking']);
const BODIES = {
  slim: {
    spine: [0.92, 0.92],
    chest: [0.94, 0.94],
    hips: [0.94, 0.95],
    thigh: [0.92, 0.92],
    shin: [0.95, 0.95],
    upperarm: [0.92, 0.92],
    forearm: [0.94, 0.94],
    neck: [0.95, 0.95],
  },
  average: null,
  stocky: {
    spine: [1.1, 1.13],
    chest: [1.08, 1.08],
    hips: [1.07, 1.08],
    thigh: [1.08, 1.08],
    shin: [1.05, 1.05],
    upperarm: [1.1, 1.1],
    forearm: [1.06, 1.06],
    neck: [1.08, 1.08],
  },
  heavy: {
    spine: [1.2, 1.34],
    chest: [1.13, 1.2],
    hips: [1.15, 1.2],
    thigh: [1.15, 1.15],
    shin: [1.07, 1.07],
    upperarm: [1.16, 1.16],
    forearm: [1.1, 1.1],
    neck: [1.15, 1.15],
  },
};

/**
 * Replaces vertex colours on a per-instance copy of the mesh geometry
 * (other attributes stay shared with the source model). Used for car paint.
 */
export function recolor(mesh, palette, overrides, tol = Infinity) {
  const g = mesh.geometry,
    src = g.attributes.color;
  if (!src) return;
  const names = Object.keys(palette);
  const from = names.map((n) => new THREE.Color(palette[n]));
  const to = names.map((n) => (overrides[n] != null ? new THREE.Color(overrides[n]) : null));
  const n = src.count,
    out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const r = src.getX(i),
      gg = src.getY(i),
      b = src.getZ(i);
    let best = -1,
      bd = tol;
    for (let k = 0; k < from.length; k++) {
      const d = Math.abs(r - from[k].r) + Math.abs(gg - from[k].g) + Math.abs(b - from[k].b);
      if (d < bd) {
        bd = d;
        best = k;
      }
    }
    const c = best >= 0 && to[best] ? to[best] : null;
    out[i * 3] = c ? c.r : r;
    out[i * 3 + 1] = c ? c.g : gg;
    out[i * 3 + 2] = c ? c.b : b;
  }
  const ng = new THREE.BufferGeometry();
  for (const k in g.attributes) ng.setAttribute(k, g.attributes[k]);
  ng.setIndex(g.index);
  ng.setAttribute('color', new THREE.BufferAttribute(out, 3));
  ng.boundingSphere = g.boundingSphere;
  ng.boundingBox = g.boundingBox;
  mesh.geometry = ng;
}

// ------------------------------------------------------------------------------------------------
// shared per-model data: part table per triangle, index-buffer cache per (lod, parts)
// ------------------------------------------------------------------------------------------------
const sources = new Map();
function source(kind) {
  let s = sources.get(kind);
  if (s) return s;
  const gltf = ctx.models[kind];
  let mesh = null;
  gltf.scene.traverse((o) => {
    if (o.isSkinnedMesh && !mesh) mesh = o;
  });
  const ud = mesh.userData;
  const g = mesh.geometry,
    ch = g.attributes._char,
    idx = g.index.array;
  const triCount = idx.length / 3,
    triPart = new Uint8Array(triCount);
  if (ch) for (let t = 0; t < triCount; t++) triPart[t] = Math.round(ch.getY(idx[t * 3]) * 255);
  const partId = Object.fromEntries((ud.parts || []).map((p, i) => [p, i]));
  const holds = {};
  for (const [name, q] of Object.entries(ud.holds || {}))
    holds[name] = Object.entries(q).map(([b, v]) => [THREE.PropertyBinding.sanitizeNodeName(b), new THREE.Quaternion().fromArray(v)]);
  s = { kind, mesh, ud, geo: g, idx, triPart, partId, holds, cache: new Map(), outfits: [], palKeys: ud.palKeys || Object.keys(ud.palette), hasParts: !!ch };
  sources.set(kind, s);
  return s;
}
function partGeometry(src, lod, ids) {
  const key = lod + ':' + ids.join(',');
  let g = src.cache.get(key);
  if (g) return g;
  const want = new Uint8Array(128);
  for (const id of ids) want[id + 64 * lod] = 1;
  const { idx, triPart } = src;
  let n = 0;
  for (let t = 0; t < triPart.length; t++) if (want[triPart[t]]) n++;
  const out = src.geo.attributes.position.count > 65535 ? new Uint32Array(n * 3) : new Uint16Array(n * 3);
  let k = 0;
  for (let t = 0; t < triPart.length; t++)
    if (want[triPart[t]]) {
      out[k++] = idx[t * 3];
      out[k++] = idx[t * 3 + 1];
      out[k++] = idx[t * 3 + 2];
    }
  g = new THREE.BufferGeometry();
  for (const a in src.geo.attributes) g.setAttribute(a, src.geo.attributes[a]);
  g.setIndex(new THREE.BufferAttribute(out, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.9, 0), 1.5);
  src.cache.set(key, g);
  return g;
}

// ------------------------------------------------------------------------------------------------
// material: palette uniform + baked AO + subtle cloth/skin breakup; one shader program for everyone
// ------------------------------------------------------------------------------------------------
function makeMaterial(src, colors) {
  const keys = src.palKeys,
    N = keys.length;
  const pal = keys.map((k) => new THREE.Color(colors[k] != null ? colors[k] : src.ud.palette[k]));
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, metalness: 0 });
  m.name = 'character';
  m.userData.uPal = { value: pal };
  const rough = keys.map((k) => (ROUGH[k] ?? 0.7).toFixed(2)).join(',');
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uPal = m.userData.uPal;
    sh.vertexShader = sh.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec4 _char;
uniform vec3 uPal[${N}];
const float CH_ROUGH[${N}] = float[${N}](${rough});
varying vec3 vChCol; varying float vChRough; varying vec3 vChObj; varying float vChCloth;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
int chI = int(_char.x * 31.0 + 0.5);
vChCol = uPal[chI] * mix(1.0, _char.z, 0.9) * mix(vec3(1.0), vec3(1.08, 0.86, 0.84), _char.w);
vChRough = CH_ROUGH[chI];
vChCloth = chI == 0 ? 0.35 : 1.0;
vChObj = position;`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vChCol; varying float vChRough; varying vec3 vChObj; varying float vChCloth;
float chHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float chNoise(vec3 x) { vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(chHash(i), chHash(i + vec3(1,0,0)), f.x), mix(chHash(i + vec3(0,1,0)), chHash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(chHash(i + vec3(0,0,1)), chHash(i + vec3(1,0,1)), f.x), mix(chHash(i + vec3(0,1,1)), chHash(i + vec3(1,1,1)), f.x), f.y), f.z); }`,
      )
      .replace('#include <color_fragment>', 'diffuseColor.rgb *= vChCol * (1.0 + vChCloth * 0.09 * (chNoise(vChObj * 22.0) - 0.5));')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = vChRough;');
  };
  m.customProgramCacheKey = () => 'character-' + N;
  return m;
}

// ------------------------------------------------------------------------------------------------
// Character
// ------------------------------------------------------------------------------------------------
let frameSeed = 0;
const _v = new THREE.Vector3();
export class Character {
  /**
   * @param {string} kind 'character_male' | 'character_female'
   * @param {object} [colors] palette overrides (skin, hair, top, jacket, pants, shoes, accent, hat, bag, ...)
   * @param {object} [opts] { parts: string[], accessories: string[], body: 'slim'|'average'|'stocky'|'heavy', style }
   */
  constructor(kind, colors = {}, opts = {}) {
    const src = ctx.models[kind];
    this.kind = kind;
    this.src = source(kind);
    this.root = skeletonClone(src.scene);
    this.root.traverse((c) => {
      if (c.isSkinnedMesh && !this.mesh) this.mesh = c;
    });
    const mesh = this.mesh;
    mesh.castShadow = true;
    mesh.material = makeMaterial(this.src, colors || {});
    this.colors = colors || {};
    this.style = opts.style || 'casual';
    this.senior = this.style === 'senior';
    this.preferredSpeed = opts.preferredSpeed || (this.style === 'jogger' ? 2.8 : this.senior ? 1.0 : 1.2 + rnd() * 0.4);
    this.autoUmbrella = !!opts.autoUmbrella;
    this.outfit = new Set(opts.parts || DEFAULT_OUTFIT[kind] || DEFAULT_OUTFIT.character_male);
    this.accessories = new Set(opts.accessories || []);
    this.bones = {};
    for (const b of mesh.skeleton.bones) this.bones[b.name] = b;
    if (opts.body && BODIES[opts.body]) this.setBody(opts.body);
    this.body = opts.body || 'average';
    this.lod = 0;
    this.lodKey = '';
    this.frame = frameSeed++;
    this.acc = 0;
    this.weatherT = rnd() * 2;
    this.mixer = new THREE.AnimationMixer(this.root);
    this.actions = {};
    for (const clip of src.animations) this.actions[clip.name] = this.mixer.clipAction(clip);
    const fall = this.actions.fall;
    if (fall) {
      fall.setLoop(THREE.LoopOnce, 1);
      fall.clampWhenFinished = true;
    }
    this.current = null;
    this.play('idle', 0);
    this.refresh();
  }

  /** Scales the body (bind matrices, so children/animation are unaffected). */
  setBody(type) {
    const sk = this.mesh.skeleton,
      spec = BODIES[type];
    sk.boneInverses = sk.boneInverses.map((m) => m.clone());
    if (spec)
      sk.bones.forEach((b, i) => {
        const base = b.name.replace(/[LR]$/, '');
        const f = spec[base];
        if (f) sk.boneInverses[i].premultiply(new THREE.Matrix4().makeScale(f[0], 1, f[1]));
      });
    this.body = type;
  }

  /** Shows/hides an accessory (see ACCESSORIES). */
  setAccessory(name, on = true) {
    if (on) this.accessories.add(name);
    else this.accessories.delete(name);
    this.refresh();
  }
  hasAccessory(name) {
    return this.accessories.has(name) || this.outfit.has(name);
  }
  setUmbrella(on) {
    this.setAccessory('umbrella', on);
  }

  /** Effective visible part list for the current clip. */
  visibleParts() {
    const clip = this.current;
    const out = [];
    for (const p of this.outfit) out.push(p);
    for (const a of this.accessories) {
      if (HIDE[a] && HIDE[a].includes(clip)) continue;
      out.push(a);
    }
    if (clip === 'phone' && !out.includes('phone')) out.push('phone');
    return out;
  }
  refresh() {
    const src = this.src;
    if (!src.hasParts) return;
    const ids = this.visibleParts()
      .map((p) => src.partId[p])
      .filter((x) => x != null)
      .sort((a, b) => a - b);
    const key = this.lod + ':' + ids.join(',');
    if (key === this.lodKey) return;
    this.lodKey = key;
    this.mesh.geometry = partGeometry(src, this.lod, ids);
    this.mesh.boundingSphere = this.mesh.geometry.boundingSphere;
    this.holding = null;
    for (const h of ['umbrella', 'phone', 'cup']) if (ids.includes(src.partId[h]) && src.holds[h]) (this.holding ||= []).push(h);
  }

  play(name, fade = 0.2, speed = 1) {
    let clip = name,
      sc = speed;
    if (name === 'walk' && this.senior && this.actions.walk_senior) {
      clip = 'walk_senior';
      sc = speed * 1.45;
    } else if (name === 'walk' && this.style === 'jogger' && speed * 1.45 > 2.2 && this.actions.jog) {
      clip = 'jog';
      sc = (speed * 1.45) / 3;
    } else if (name === 'run' && this.style === 'jogger' && speed * 6 < 4.5 && this.actions.jog) {
      clip = 'jog';
      sc = (speed * 6) / 3;
    }
    const a = this.actions[clip];
    if (!a) return;
    a.timeScale = sc;
    if (this.current === clip) return;
    a.reset().setEffectiveWeight(1).fadeIn(fade).play();
    if (this.current && this.actions[this.current]) this.actions[this.current].fadeOut(fade);
    this.current = clip;
    if (this.mesh) this.refresh();
  }

  update(dt) {
    const q = LODQ[ctx.quality] || LODQ.medium;
    let d = 0;
    if (ctx.camera) {
      _v.setFromMatrixPosition(this.root.matrixWorld);
      d = _v.distanceTo(ctx.camera.position);
      const lod = d > q.lod * (this.lod ? 0.9 : 1.1) ? 1 : 0;
      if (lod !== this.lod) {
        this.lod = lod;
        this.refresh();
      }
    }
    if (this.autoUmbrella) {
      this.weatherT -= dt;
      if (this.weatherT <= 0) {
        this.weatherT = 2 + rnd() * 2;
        const want = (ctx.env?.weather?.rain || 0) > 0.15;
        if (want !== this.accessories.has('umbrella')) this.setAccessory('umbrella', want);
      }
    }
    // far away: advance the animation every 2nd / 4th frame only
    this.acc += dt;
    const every = d > q.t4 ? 4 : d > q.t2 ? 2 : 1;
    if (++this.frame % every) return;
    this.mixer.update(this.acc);
    this.acc = 0;
    if (this.holding && HOLD_CLIPS.has(this.current)) {
      for (const h of this.holding)
        for (const [b, quat] of this.src.holds[h]) if (this.bones[b] && (h !== 'phone' || this.current !== 'talking')) this.bones[b].quaternion.copy(quat);
    }
    if (this.senior && this.current !== 'walk_senior' && this.current !== 'sit' && this.current !== 'fall') this.bones.chest?.quaternion.multiply(STOOP);
  }
  /**
   * Detaches the character. Geometry is intentionally not disposed: index buffers are cached and
   * shared with every other instance wearing the same outfit. Characters are pooled and reused.
   */
  detach() {
    this.root.parent?.remove(this.root);
  }
}
const STOOP = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.12, 0, 0));

// ------------------------------------------------------------------------------------------------
// random people
// ------------------------------------------------------------------------------------------------
const wpick = (list) => {
  // [[value, weight], ...]
  let t = 0;
  for (const e of list) t += e[1];
  let r = rnd() * t;
  for (const e of list) if ((r -= e[1]) <= 0) return e[0];
  return list[list.length - 1][0];
};
const chance = (p) => rnd() < p;
const SKIN = [
  [0xf1c7a5, 22],
  [0xe8b996, 22],
  [0xd9a07a, 18],
  [0xc68e6a, 12],
  [0xa86f4c, 10],
  [0x8d5a3b, 8],
  [0x5c3a24, 8],
];
const HAIR = [
  [0x3a2618, 22],
  [0x5a3a22, 18],
  [0x161210, 18],
  [0x8a6440, 12],
  [0xb8935a, 10],
  [0x9c7a4c, 10],
  [0x7a3a1e, 6],
  [0x5a2a36, 2],
];
const HAIR_OLD = [
  [0xb8b4ae, 3],
  [0xd6d3cc, 3],
  [0x8e8a84, 2],
  [0x6e665e, 1],
];
const NEUTRAL = [0x2d2f33, 0x1c2a3d, 0x3b3e44, 0x4a3b2b, 0x6b6e70, 0x111214, 0x2f4a3a, 0x5a4a3a, 0xa8865a, 0x3d5a80, 0x7a2222, 0x8a8478];
const TOPS = [0xe8e6e0, 0x8a8c90, 0x1e1e20, 0x22304a, 0x8a2b2b, 0x4a6a4a, 0xc9a040, 0x8fb0d0, 0xd09aa8, 0x2d6d6d, 0xcbbba0, 0x5a4a6a, 0xe0d0b8];
const SHIRTS = [0xf2f2f0, 0xc8d8ea, 0xe9e4dc, 0xd8c8d0, 0xf0ece4];
const SUITS = [0x23262b, 0x1b2333, 0x3a3d42, 0x2e3440, 0x4a4d52, 0x15161a, 0x3a3530];
const ACCENT = [0x7a1f2b, 0xb8a080, 0x3a4a6a, 0x5a6a4a, 0x8a5a7a, 0xc0b8b0, 0x2a2a2e, 0xa04a2a, 0x1f3a6e, 0xd0c8b8];
const JEANS = [0x2a3550, 0x3a4a66, 0x4f6283, 0x1e2433, 0x2a2a2a, 0x8a7a5a, 0x5a4a3a, 0x6b6b70, 0x3a3a40];
const SPORT = [0xd8402a, 0x2a6ad8, 0x1e1e20, 0xe8e8e4, 0x30a070, 0xe0c020, 0xd04080, 0x404a5a];
const BAGS = [0x1e1e20, 0x3a2a1e, 0x4a5a3a, 0x2a3a5a, 0x8a2a2a, 0x6a6a6e, 0x7a5a3a];
const UMBR = [0x111214, 0x1c2a3d, 0x7a1f2b, 0x2f4a3a, 0xc9a040, 0x6b6e70, 0x3a6aa0];
const pick = (a) => rnd.pick(a);

function weatherNow(w) {
  const e = w || ctx.env?.weather || {};
  return { temp: e.temp ?? 12, rain: e.rain ?? 0 };
}
const AREAS = {
  business: [
    ['business', 0.6],
    ['casual', 0.18],
    ['student', 0.05],
    ['tourist', 0.07],
    ['senior', 0.07],
    ['jogger', 0.03],
  ],
  shopping: [
    ['casual', 0.42],
    ['business', 0.1],
    ['student', 0.15],
    ['tourist', 0.15],
    ['senior', 0.16],
    ['jogger', 0.02],
  ],
  oldtown: [
    ['tourist', 0.42],
    ['casual', 0.25],
    ['senior', 0.15],
    ['business', 0.08],
    ['student', 0.08],
    ['jogger', 0.02],
  ],
  park: [
    ['casual', 0.35],
    ['jogger', 0.22],
    ['senior', 0.18],
    ['student', 0.12],
    ['tourist', 0.13],
  ],
  campus: [
    ['student', 0.6],
    ['casual', 0.25],
    ['business', 0.05],
    ['senior', 0.05],
    ['jogger', 0.05],
  ],
  residential: [
    ['casual', 0.45],
    ['senior', 0.25],
    ['student', 0.12],
    ['business', 0.1],
    ['jogger', 0.08],
  ],
  station: [
    ['casual', 0.35],
    ['business', 0.22],
    ['tourist', 0.18],
    ['student', 0.15],
    ['senior', 0.1],
  ],
  city: [
    ['casual', 0.34],
    ['business', 0.17],
    ['student', 0.14],
    ['tourist', 0.12],
    ['senior', 0.18],
    ['jogger', 0.05],
  ],
};

/** Builds a random outfit for a style. Returns { female, parts, accessories, colors, body, autoUmbrella }. */
function makeOutfit(style, female, w) {
  const cold = w.temp < 9,
    warm = w.temp > 19;
  const P = new Set(['core', 'torso']);
  const A = new Set();
  const senior = style === 'senior';
  const skin = wpick(SKIN);
  const sc = new THREE.Color(skin);
  const C = {
    skin,
    hair: senior
      ? wpick(HAIR_OLD)
      : skin === 0x5c3a24 || skin === 0x8d5a3b
        ? wpick([
            [0x161210, 4],
            [0x2a1d14, 2],
          ])
        : wpick(HAIR),
    lips: new THREE.Color(sc.r * 0.82, sc.g * 0.6, sc.b * 0.58).getHex(),
    eyes: pick([0x3a2a1c, 0x2a1a10, 0x4a6a8a, 0x5a6a4a, 0x3a2a1c]),
    top: pick(TOPS),
    jacket: pick(NEUTRAL),
    pants: pick(JEANS),
    shoes: pick([0x1c1c1c, 0x3a2416, 0xe8e8e4, 0x6a6a6e]),
    accent: pick(ACCENT),
    hat: pick([0x2a2a2e, 0x4a3b2b, 0x6b6e70, 0x1c2a3d, 0x8a1c1c, 0x3a4a3a]),
    bag: pick(BAGS),
    belt: pick([0x2a1a12, 0x141210, 0x4a3020]),
    legwear: chance(0.5) ? new THREE.Color(sc.r * 0.92, sc.g * 0.85, sc.b * 0.82).getHex() : pick([0x1a1a1e, 0x2a2228, 0x3a3030]),
    socks: pick([0x2a2a2e, 0xe0e0e0, 0x5a5a60]),
    umbrella: pick(UMBR),
    bike: pick([0x2f5a4a, 0x1c1c1c, 0x8a1c1c, 0xd8d8d8, 0x2a3a5a, 0x6a8aa0]),
  };
  let body = wpick(
    senior
      ? [
          ['slim', 2],
          ['average', 4],
          ['stocky', 3],
          ['heavy', 2],
        ]
      : [
          ['slim', 3],
          ['average', 5],
          ['stocky', 2],
          ['heavy', 1],
        ],
  );
  // ---- clothes by style ----
  const outer = (list) => {
    const o = wpick(list);
    if (o) P.add(o);
    P.add(o ? (o === 'puffer' ? 'arms_puffer' : 'arms_jacket') : warm ? 'arms_short' : 'arms_top');
    if (o === 'suit' || o === 'coat') P.add('collar');
    return o;
  };
  const legs = (pTrousers = 1) => {
    if (female && chance(warm ? 0.45 : cold ? 0.15 : 0.3) && style !== 'jogger') {
      P.add('legs_skirt');
      C.pants = pick([...SUITS, 0x6a2a3a, 0x8a7a5a, 0x2a3a5a, 0x5a5a60, 0xb8a080]);
    } else if (warm && chance(style === 'tourist' ? 0.6 : 0.35) && style !== 'business' && style !== 'senior') {
      P.add('legs_shorts');
      C.pants = pick([0x8a7a5a, 0x4f6283, 0x5a5a4a, 0x2a3550, 0xcbbba0, 0x3a4a3a]);
    } else if (chance(pTrousers)) P.add('legs_trousers');
    else P.add('legs_trousers');
  };
  const shoes = (list) => P.add(wpick(list));
  switch (style) {
    case 'business': {
      const suit = pick(SUITS);
      C.jacket = suit;
      C.pants = chance(0.85) ? suit : pick(SUITS);
      C.top = pick(SHIRTS);
      outer(
        cold
          ? [
              ['coat', 6],
              ['suit', 2],
              ['puffer', 1],
            ]
          : [
              ['suit', 8],
              ['coat', w.temp < 13 ? 3 : 0.5],
              [null, warm ? 2 : 0.5],
            ],
      );
      if (cold && P.has('coat')) C.jacket = pick([0x23262b, 0x1b2333, 0x3a3d42, 0x8a7458, 0x5a4a3a, 0x15161a]);
      if (!female && (P.has('suit') || P.has('coat')) && chance(0.6)) P.add('tie');
      if (female && chance(0.35)) {
        P.add('legs_skirt');
        C.legwear = pick([0x1a1a1e, 0x2a2228, C.legwear]);
      } else P.add('legs_trousers');
      shoes([
        ['shoes_dress', 8],
        ['shoes_boot', cold ? 2 : 0.3],
      ]);
      C.shoes = pick([0x1a1412, 0x3a2416, 0x4a2c1a, 0x141210]);
      if (chance(0.4)) A.add(chance(0.6) ? 'briefcase' : 'crossbody');
      if (chance(0.12)) A.add('cup');
      if (chance(0.3)) A.add('glasses');
      if (cold && chance(0.4)) A.add('scarf');
      C.bag = pick([0x1e1e20, 0x3a2a1e, 0x2a1a12]);
      break;
    }
    case 'tourist': {
      C.top = pick([...TOPS, 0xe8e6e0, 0x8fb0d0]);
      C.jacket = pick([0x3d5a80, 0x8a1c1c, 0x2f4a3a, 0xc9a040, 0x6b6e70, 0x1c2a3d, 0xd8cbb4, 0x4a7a9a]);
      outer(
        cold
          ? [
              ['puffer', 4],
              ['jacket_open', 3],
              ['coat', 1],
            ]
          : warm
            ? [
                [null, 6],
                ['jacket_open', 1],
              ]
            : [
                ['jacket_open', 5],
                [null, 2],
                ['hoodie', 1],
              ],
      );
      legs();
      shoes([
        ['shoes_sneaker', 7],
        ['shoes_boot', 2],
      ]);
      if (chance(0.55)) A.add('camera');
      if (chance(0.45)) A.add('backpack');
      else if (chance(0.4)) A.add('crossbody');
      if (chance(warm ? 0.5 : 0.15)) P.add(warm && chance(0.5) ? 'hat_sunhat' : 'hat_cap');
      if (chance(warm ? 0.45 : 0.15)) A.add('glasses');
      if (chance(0.1)) A.add('phone');
      if (warm) C.hat = pick([0xd8c8a0, 0xe8e6e0, 0x2a3a5a, 0x8a1c1c, 0xc9b896]);
      break;
    }
    case 'student': {
      outer(
        cold
          ? [
              ['puffer', 4],
              ['jacket_open', 3],
              ['hoodie', 2],
              ['coat', 1],
            ]
          : warm
            ? [
                [null, 6],
                ['hoodie', 1],
              ]
            : [
                ['hoodie', 4],
                ['jacket_open', 4],
                [null, 2],
              ],
      );
      if (P.has('hoodie')) C.jacket = pick([...TOPS, ...NEUTRAL]);
      legs();
      shoes([
        ['shoes_sneaker', 9],
        ['shoes_boot', 2],
      ]);
      if (chance(0.8)) A.add('backpack');
      if (chance(0.25)) A.add('headphones');
      if (chance(0.2)) A.add('phone');
      if (chance(0.15)) A.add('cup');
      if (chance(cold ? 0.35 : 0.15)) P.add(cold ? 'hat_beanie' : 'hat_cap');
      if (chance(0.2)) A.add('glasses');
      break;
    }
    case 'senior': {
      C.jacket = pick([0x4a3b2b, 0x5a5048, 0x3b3e44, 0x2d3a4a, 0x6b6050, 0x8a8478, 0x3a4a3a, 0x7a6a58]);
      C.top = pick([...SHIRTS, 0xcbbba0, 0x8a8c90, 0x6a5a5a]);
      C.pants = pick([0x3a3a40, 0x5a5048, 0x4a4a52, 0x2a3040, 0x6b6b70, 0x8a7a5a]);
      outer(
        cold
          ? [
              ['coat', 6],
              ['puffer', 2],
            ]
          : warm
            ? [
                [null, 4],
                ['jacket_open', 2],
              ]
            : [
                ['coat', 3],
                ['jacket_open', 4],
                ['suit', 1],
              ],
      );
      legs();
      shoes([
        ['shoes_dress', 5],
        ['shoes_boot', 3],
        ['shoes_sneaker', 2],
      ]);
      C.shoes = pick([0x1a1412, 0x3a2416, 0x4a2c1a, 0x6a6a6e]);
      if (chance(0.6)) A.add('glasses');
      if (!female && chance(cold ? 0.55 : 0.35)) P.add('hat_flatcap');
      if (female && cold && chance(0.3)) P.add('hat_beanie');
      if (chance(0.25)) A.add('shopbag');
      if (cold && chance(0.45)) A.add('scarf');
      C.bag = pick([0xb08a5a, 0x3a2a1e, 0xe0e0dc, 0x6a2a2a]);
      break;
    }
    case 'jogger': {
      C.top = pick(SPORT);
      C.jacket = pick(SPORT);
      C.pants = pick([0x1e1e20, 0x2a2a30, 0x2a3550, 0x404a5a]);
      if (cold) {
        P.add(chance(0.5) ? 'hoodie' : 'puffer');
        P.add(P.has('puffer') ? 'arms_puffer' : 'arms_jacket');
      } else P.add(warm || chance(0.4) ? 'arms_short' : 'arms_top');
      P.add(warm && chance(0.6) ? 'legs_shorts' : 'legs_tights');
      if (P.has('legs_shorts')) C.socks = pick([0xe8e8e4, 0x1e1e20]);
      shoes([['shoes_sneaker', 1]]);
      C.shoes = pick([0xe8e8e4, 0x2a3a5a, 0xd8402a, 0x1c1c1c, 0x30a070]);
      C.sole = 0xf0f0ec;
      if (chance(0.45)) A.add('headphones');
      if (chance(cold ? 0.4 : 0.2)) P.add(cold ? 'hat_beanie' : 'hat_cap');
      body = wpick([
        ['slim', 5],
        ['average', 4],
        ['stocky', 1],
      ]);
      break;
    }
    default: {
      // casual
      outer(
        cold
          ? [
              ['puffer', 4],
              ['coat', 3],
              ['jacket_open', 3],
              ['hoodie', 1],
            ]
          : warm
            ? [
                [null, 8],
                ['jacket_open', 1],
              ]
            : [
                ['jacket_open', 6],
                [null, 2],
                ['hoodie', 2],
                ['coat', 1],
              ],
      );
      legs();
      shoes([
        ['shoes_sneaker', 6],
        ['shoes_boot', cold ? 4 : 1.5],
        ['shoes_dress', 1.5],
      ]);
      if (chance(0.2)) A.add('crossbody');
      if (chance(0.15)) A.add('shopbag');
      if (chance(0.12)) A.add('phone');
      if (chance(0.1)) A.add('cup');
      if (chance(0.1)) A.add('headphones');
      if (chance(0.15)) A.add('backpack');
      if (chance(cold ? 0.3 : 0.08)) P.add(cold ? 'hat_beanie' : 'hat_cap');
      if (chance(0.25)) A.add('glasses');
      if (cold && chance(0.4)) A.add('scarf');
    }
  }
  if (cold && style !== 'jogger' && !A.has('scarf') && chance(0.25)) A.add('scarf');
  // ---- hair ----
  const hat = [...P].find((p) => p.startsWith('hat_'));
  let hair;
  if (female) {
    hair = senior
      ? wpick([
          ['hair_bob', 4],
          ['hair_pixie', 4],
          ['hair_bun', 3],
        ])
      : style === 'jogger'
        ? wpick([
            ['hair_ponytail', 6],
            ['hair_bun', 2],
            ['hair_pixie', 1],
          ])
        : wpick([
            ['hair_bob', 5],
            ['hair_long', 6],
            ['hair_ponytail', 4],
            ['hair_bun', 2],
            ['hair_pixie', 2],
          ]);
    if (hat && hair === 'hair_bun') hair = 'hair_long';
  } else {
    hair = senior
      ? wpick([
          ['hair_bald', 5],
          ['hair_short', 3],
          ['hair_side', 3],
        ])
      : style === 'business'
        ? wpick([
            ['hair_side', 5],
            ['hair_short', 4],
            ['hair_buzz', 1],
            ['hair_bald', 1],
          ])
        : wpick([
            ['hair_short', 5],
            ['hair_side', 3],
            ['hair_buzz', 2],
            ['hair_curly', 1.5],
            ['hair_bald', 0.7],
          ]);
    if (hat && hair === 'hair_curly') hair = 'hair_short';
    if (chance(senior ? 0.3 : style === 'business' ? 0.12 : 0.22)) P.add('beard');
    else if (chance(senior ? 0.15 : 0.04)) P.add('mustache');
  }
  P.add(hair);
  if (!P.has('legs_trousers') && !P.has('legs_shorts') && !P.has('legs_skirt') && !P.has('legs_tights')) P.add('legs_trousers');
  if (![...P].some((p) => p.startsWith('shoes_'))) P.add('shoes_sneaker');
  if (C.pants === C.jacket && !P.has('suit')) C.jacket = pick(NEUTRAL);
  const autoUmbrella = style !== 'jogger' && chance(0.6);
  return { female, parts: [...P], accessories: [...A], colors: C, body, autoUmbrella };
}

/** Basic random clothing colours (legacy helper). */
export function randomColors(female) {
  return makeOutfit('casual', female, weatherNow()).colors;
}

/**
 * A random member of the public. opts: { style, area, female, weather } (all optional).
 * Outfits are drawn from a bounded pool per model so index buffers stay shared.
 */
export function randomPerson(opts = {}) {
  const style = opts.style || wpick(AREAS[opts.area] || AREAS.city);
  const female = opts.female ?? rnd() < 0.5;
  const kind = female ? 'character_female' : 'character_male';
  const src = source(kind);
  const w = weatherNow(opts.weather);
  const o = makeOutfit(style, female, w);
  // bounded variety of part sets: after 60 distinct outfits, mostly reuse a matching one (colours stay random)
  const key = o.parts.slice().sort().join(',');
  if (!src.outfits.includes(key)) {
    if (src.outfits.length >= 60 && rnd() < 0.85) {
      const same = src.outfitStyle?.[style];
      if (same?.length) o.parts = rnd.pick(same).split(',');
    } else {
      src.outfits.push(key);
      ((src.outfitStyle ||= {})[style] ||= []).push(key);
    }
  }
  const ch = new Character(kind, o.colors, { parts: o.parts, accessories: o.accessories, body: o.body, style, autoUmbrella: !!opts.autoUmbrella });
  return ch;
}

export function policeOfficer() {
  const female = rnd() < 0.3;
  const kind = female ? 'character_female' : 'character_male';
  const o = makeOutfit('casual', female, weatherNow());
  const parts = [
    'core',
    'torso',
    'suit',
    'collar',
    'arms_jacket',
    'legs_trousers',
    'shoes_boot',
    'hat_peak',
    female ? 'hair_bun' : rnd.pick(['hair_short', 'hair_buzz']),
  ];
  return new Character(
    kind,
    { ...o.colors, ...POLICE_COLORS, top: 0xc8d4e4, hat: 0x1b2433, accent: 0x2a3a6a, belt: 0x111111 },
    { parts, body: rnd.pick(['average', 'stocky', 'slim']), style: 'police' },
  );
}

// handy for debugging / previews from the console: ctx.player.ch.constructor.random()
Character.random = randomPerson;
Character.police = policeOfficer;
