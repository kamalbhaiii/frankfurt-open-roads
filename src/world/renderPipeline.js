/**
 * Final frame rendering (HDR post-processing) and hardware adaptation.
 * OWNER: lighting/rendering agent.
 *
 * main.js calls: pipeline.render(), pipeline.resize(w, h), pipeline.update(dt).
 *
 * low tier:  one direct render to the canvas (renderer tone mapping, native MSAA).
 * medium+:   scene → HalfFloat target with a depth texture, then
 *            [GTAO from depth (high/ultra)] → [bloom (mip chain)] →
 *            composite (AO, sun-tinted aerial haze, ACES tone mapping, colour grade, vignette,
 *            dither) → [FXAA | SMAA] → canvas.
 *            On high/ultra the river's planar reflection is rendered first (water.js).
 * Every tier: adaptive resolution keeps the frame rate near QUALITY[tier].targetFps by
 * scaling the pixel ratio; if the minimum scale is not enough, effects are shed in order
 * (AO → planar reflections → bloom → shorter shadow range) and restored when there is headroom.
 *
 * The HTML HUD sits above the canvas and is unaffected; transparent particles and markers are
 * drawn in the main scene pass, so they keep their blending.
 */
import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js';
import { QUALITY } from '../core/config.js';
import { ctx } from '../core/context.js';
import { clamp, lerp } from '../core/math.js';
import { renderWaterReflection, disableWaterReflection } from './water.js';

/** Bloom that leaves its result in a texture instead of blending it into the input. */
class BloomTexturePass extends UnrealBloomPass {
  render(renderer, _writeBuffer, readBuffer) {
    const oldAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.getClearColor(this._oldClearColor);
    this._oldClearAlpha = renderer.getClearAlpha();
    renderer.setClearColor(this.clearColor, 0);
    this.highPassUniforms.tDiffuse.value = readBuffer.texture;
    this.highPassUniforms.luminosityThreshold.value = this.threshold;
    this._fsQuad.material = this.materialHighPassFilter;
    renderer.setRenderTarget(this.renderTargetBright);
    renderer.clear();
    this._fsQuad.render(renderer);
    let input = this.renderTargetBright;
    for (let i = 0; i < this.nMips; i++) {
      const m = this.separableBlurMaterials[i];
      this._fsQuad.material = m;
      m.uniforms.colorTexture.value = input.texture;
      m.uniforms.direction.value = UnrealBloomPass.BlurDirectionX;
      renderer.setRenderTarget(this.renderTargetsHorizontal[i]);
      renderer.clear();
      this._fsQuad.render(renderer);
      m.uniforms.colorTexture.value = this.renderTargetsHorizontal[i].texture;
      m.uniforms.direction.value = UnrealBloomPass.BlurDirectionY;
      renderer.setRenderTarget(this.renderTargetsVertical[i]);
      renderer.clear();
      this._fsQuad.render(renderer);
      input = this.renderTargetsVertical[i];
    }
    this._fsQuad.material = this.compositeMaterial;
    this.compositeMaterial.uniforms.bloomStrength.value = this.strength;
    this.compositeMaterial.uniforms.bloomRadius.value = this.radius;
    this.compositeMaterial.uniforms.bloomTintColors.value = this.bloomTintColors;
    renderer.setRenderTarget(this.renderTargetsHorizontal[0]);
    renderer.clear();
    this._fsQuad.render(renderer);
    renderer.setClearColor(this._oldClearColor, this._oldClearAlpha);
    renderer.autoClear = oldAutoClear;
  }
  get texture() {
    return this.renderTargetsHorizontal[0].texture;
  }
}

const compositeShader = {
  uniforms: {
    tColor: { value: null },
    tDepth: { value: null },
    tAO: { value: null },
    tBloom: { value: null },
    uAO: { value: 0 },
    uBloom: { value: 0 },
    uExposure: { value: 1 },
    uProjInv: { value: new THREE.Matrix4() },
    uCamWorld: { value: new THREE.Matrix4() },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uHazeCol: { value: new THREE.Color() },
    uHaze: { value: 0 },
    uTint: { value: new THREE.Vector3(1, 1, 1) },
    uSat: { value: 1 },
    uContrast: { value: 1 },
    uVignette: { value: 0 },
    uRes: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
  fragmentShader: /* glsl */ `
varying vec2 vUv;
uniform sampler2D tColor; uniform highp sampler2D tDepth; uniform sampler2D tAO; uniform sampler2D tBloom;
uniform float uAO; uniform float uBloom; uniform float uExposure; uniform mat4 uProjInv; uniform mat4 uCamWorld;
uniform vec3 uSunDir; uniform vec3 uHazeCol; uniform float uHaze; uniform vec3 uTint; uniform float uSat; uniform float uContrast;
uniform float uVignette; uniform vec2 uRes;
// three.js ACESFilmicToneMapping (same curve as the direct-render low tier)
vec3 RRTAndODTFit(vec3 v){ vec3 a = v * (v + 0.0245786) - 0.000090537; vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081; return a / b; }
vec3 aces(vec3 color){
  const mat3 ACESInputMat = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
  const mat3 ACESOutputMat = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
  color *= uExposure / 0.6;
  color = ACESInputMat * color; color = RRTAndODTFit(color); color = ACESOutputMat * color;
  return clamp(color, 0.0, 1.0);
}
vec3 toSRGB(vec3 c){ return mix(c * 12.92, 1.055 * pow(c, vec3(0.41666)) - 0.055, step(0.0031308, c)); }
void main(){
  vec3 c = texture2D(tColor, vUv).rgb;
  float depth = texture2D(tDepth, vUv).r;
  if (depth < 1.0) {
    vec4 vp = uProjInv * vec4(vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    vec3 view = vp.xyz / vp.w;
    float dist = length(view);
    #ifdef USE_AO
    float ao = texture2D(tAO, vUv).r;
    c *= mix(1.0, ao, uAO * (1.0 - smoothstep(80.0, 260.0, dist)));
    #endif
    #ifdef USE_HAZE
    // aerial perspective: in-scattered sunlight grows with distance, strongest towards the sun
    vec3 dir = normalize(mat3(uCamWorld) * view);
    float mu = dot(dir, uSunDir);
    float g = 0.7; float hg = (1.0 - g*g) / pow(1.0 + g*g - 2.0*g*mu, 1.5) * 0.08;
    float amount = 1.0 - exp(-dist * uHaze);
    c += uHazeCol * amount * (0.25 + hg);
    #endif
  }
  #ifdef USE_BLOOM
  c += texture2D(tBloom, vUv).rgb * uBloom;
  #endif
  c = toSRGB(aces(c));
  // colour grade (display space): white balance, saturation, gentle contrast
  c *= uTint;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, uSat);
  c = clamp((c - 0.5) * uContrast + 0.5, 0.0, 1.0);
  vec2 q = vUv - 0.5; q.x *= uRes.x / uRes.y;
  c *= 1.0 - uVignette * smoothstep(0.35, 1.05, length(q));
  // dither against banding in the sky gradients
  c += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;
  gl_FragColor = vec4(c, 1.0);
}`,
};

export class RenderPipeline {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    renderer.info.autoReset = false;
    /** Adaptive resolution / quality (tests may switch it off for repeatable frames). */
    this.adaptive = true;
    this.scale = 1;
    this.shed = 0; // how many effects are currently switched off by the adaptive logic
    this.ft = 1 / 60;
    this.slowT = 0;
    this.fastT = 0;
    this.cool = 0;
    this.warm = 3;
    this.frame = 0;
    this.tier = null;
    this.configure();
  }

  get q() {
    return QUALITY[this.tier];
  }

  /** Effective switches after adaptive shedding. */
  get effects() {
    const q = this.q;
    const s = this.shed;
    return {
      ao: q.ao > 0 && s < 1,
      planar: q.reflections === 'planar' && s < 2,
      bloom: q.bloom > 0 && s < 3,
      shadowScale: s >= 4 ? 0.6 : 1,
    };
  }

  /** (Re)builds the post chain for the current tier. */
  configure() {
    this.dispose();
    this.tier = ctx.quality;
    const q = this.q;
    this.scale = 1;
    this.shed = 0;
    this.warm = 3;
    this.applyScale();
    if (!q.post) {
      this.post = false;
      disableWaterReflection();
      return;
    }
    this.post = true;
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const w = size.x,
      h = size.y;
    const depthTexture = new THREE.DepthTexture(w, h);
    depthTexture.type = THREE.UnsignedIntType;
    this.sceneRT = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthTexture, samples: 0 });
    this.sceneRT.texture.name = 'pipeline.scene';
    const mat = new THREE.ShaderMaterial({
      ...compositeShader,
      uniforms: THREE.UniformsUtils.clone(compositeShader.uniforms),
      depthTest: false,
      depthWrite: false,
      defines: {},
    });
    mat.uniforms.tColor.value = this.sceneRT.texture;
    mat.uniforms.tDepth.value = depthTexture;
    this.composite = new FullScreenQuad(mat);
    if (q.bloom > 0) {
      this.bloom = new BloomTexturePass(new THREE.Vector2(w, h), 1, 0.55, 1.6);
      mat.uniforms.tBloom.value = this.bloom.texture;
    }
    if (q.ao > 0) {
      this.gtao = new GTAOPass(this.scene, this.camera, Math.round(w * q.ao), Math.round(h * q.ao), { depthTexture });
      this.gtao.output = GTAOPass.OUTPUT.Off;
      this.gtao.updateGtaoMaterial({ radius: 1.6, distanceExponent: 1.5, thickness: 2.5, scale: 1.0, samples: 12, distanceFallOff: 1.0 });
      this.gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 8 });
      mat.uniforms.tAO.value = this.gtao.pdRenderTarget.texture;
    }
    if (q.aa === 'fxaa' || q.aa === 'smaa') {
      this.ldrRT = new THREE.WebGLRenderTarget(w, h, { depthBuffer: false });
      if (q.aa === 'smaa') {
        this.smaa = new SMAAPass();
        this.smaa.setSize(w, h);
        this.smaa.renderToScreen = true;
      } else {
        this.fxaa = new FullScreenQuad(
          new THREE.ShaderMaterial({ ...FXAAShader, uniforms: THREE.UniformsUtils.clone(FXAAShader.uniforms), depthTest: false, depthWrite: false }),
        );
        this.fxaa.material.uniforms.tDiffuse.value = this.ldrRT.texture;
        this.fxaa.material.uniforms.resolution.value.set(1 / w, 1 / h);
      }
    }
    this.updateDefines();
  }

  updateDefines() {
    if (!this.post) return;
    const e = this.effects;
    const m = this.composite.material;
    const d = {};
    if (this.gtao && e.ao) d.USE_AO = 1;
    if (this.bloom && e.bloom) d.USE_BLOOM = 1;
    if (this.q.haze) d.USE_HAZE = 1;
    const key = Object.keys(d).join();
    if (key !== this._defKey) {
      this._defKey = key;
      m.defines = d;
      m.needsUpdate = true;
    }
    if (!e.planar) disableWaterReflection();
    ctx.env?.setShadowScale?.(e.shadowScale);
  }

  dispose() {
    for (const k of ['sceneRT', 'ldrRT']) this[k]?.dispose();
    this.sceneRT?.depthTexture?.dispose();
    this.bloom?.dispose();
    this.gtao?.dispose();
    this.smaa?.dispose();
    this.composite?.dispose();
    this.fxaa?.dispose();
    this.sceneRT = this.ldrRT = this.bloom = this.gtao = this.smaa = this.composite = this.fxaa = null;
  }

  applyScale() {
    const pr = this.q.pr * this.scale;
    if (Math.abs(this.renderer.getPixelRatio() - pr) > 1e-3) {
      this.renderer.setPixelRatio(pr);
      this.resize();
    }
  }

  /** Called once per frame before render with the real frame time (for adaptive quality). */
  update(dt) {
    if (ctx.quality !== this.tier) this.configure();
    this.frame++;
    if (!this.adaptive || document.hidden || dt <= 0) return;
    if (this.warm > 0) {
      this.warm -= dt;
      this.ft = dt;
      return;
    }
    this.ft = lerp(this.ft, dt, 0.06);
    this.cool -= dt;
    const target = 1 / this.q.targetFps;
    const slow = this.ft > target * 1.15,
      fast = this.ft < target * 0.97;
    this.slowT = slow ? this.slowT + dt : 0;
    this.fastT = fast ? this.fastT + dt : 0;
    if (this.cool > 0) return;
    const q = this.q;
    if (this.slowT > 1.2) {
      this.slowT = 0;
      if (this.scale > q.minScale + 1e-3) {
        this.scale = Math.max(q.minScale, this.scale - (this.ft > target * 1.6 ? 0.15 : 0.08));
        this.applyScale();
        this.cool = 1.5;
      } else if (this.shed < 4) {
        this.shed++;
        this.updateDefines();
        this.cool = 3;
      }
      this.warm = 0.3;
    } else if (this.fastT > 4) {
      this.fastT = 0;
      if (this.shed > 0) {
        this.shed--;
        this.updateDefines();
      } else if (this.scale < 1) {
        this.scale = Math.min(1, this.scale + 0.05);
        this.applyScale();
      }
      this.cool = 2.5;
      this.warm = 0.3;
    }
  }

  /** Current adaptive state (for debugging / HUD). */
  get stats() {
    return { tier: this.tier, scale: this.scale, shed: this.shed, fps: 1 / this.ft, post: this.post };
  }

  render() {
    const { renderer, scene, camera } = this;
    renderer.info.reset();
    if (!this.post) {
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
      return;
    }
    const e = this.effects;
    const q = this.q;
    if (e.planar) renderWaterReflection(renderer, scene, camera, q.reflectionScale, q.reflectionEvery);
    renderer.setRenderTarget(this.sceneRT);
    renderer.render(scene, camera);
    if (this.gtao && e.ao) this.gtao.render(renderer, null, this.sceneRT);
    if (this.bloom && e.bloom) this.bloom.render(renderer, null, this.sceneRT);
    this.updateUniforms();
    const toScreen = !this.ldrRT;
    renderer.setRenderTarget(toScreen ? null : this.ldrRT);
    this.composite.render(renderer);
    if (this.smaa) this.smaa.render(renderer, null, this.ldrRT);
    else if (this.fxaa) {
      renderer.setRenderTarget(null);
      this.fxaa.render(renderer);
    }
  }

  updateUniforms() {
    const u = this.composite.material.uniforms;
    const env = ctx.env;
    const q = this.q;
    const cam = this.camera;
    u.uExposure.value = this.renderer.toneMappingExposure;
    u.uProjInv.value.copy(cam.projectionMatrixInverse);
    u.uCamWorld.value.copy(cam.matrixWorld);
    u.uAO.value = 0.85;
    u.uBloom.value = q.bloom;
    if (this.bloom) {
      // night: lamps, windows and headlights bloom more; day: only the sun and hot speculars
      const night = env?.night ?? 0;
      this.bloom.threshold = lerp(2.2, 1.3, night);
      this.bloom.strength = 1;
      u.uBloom.value = q.bloom * lerp(0.6, 0.9, night);
    }
    u.uVignette.value = q.vignette ?? 0;
    u.uRes.value.set(this.sceneRT.width, this.sceneRT.height);
    if (env) {
      const w = env.weather;
      const overcast = clamp(w.cloud * 0.8 + w.rain * 0.4 + w.fog * 0.3, 0, 1);
      u.uSunDir.value.copy(env.sunDir);
      u.uHazeCol.value.copy(env.hazeColor);
      u.uHaze.value = 0.00055 + w.fog * 0.0015;
      // natural, slightly cool German overcast palette; neutral in sun, warm-neutral at night
      const night = env.night;
      u.uTint.value.set(lerp(1, 0.975, overcast), 1, lerp(1, 1.025, overcast));
      u.uTint.value.lerp(new THREE.Vector3(1.0, 0.99, 1.0), night);
      u.uSat.value = lerp(1.04, 0.86, overcast) * lerp(1, 0.92, night);
      u.uContrast.value = lerp(1.05, 1.0, overcast);
    }
  }

  resize() {
    if (!this.post || !this.sceneRT) return;
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const w = size.x,
      h = size.y;
    this.sceneRT.setSize(w, h);
    this.ldrRT?.setSize(w, h);
    this.bloom?.setSize(w, h);
    if (this.gtao) this.gtao.setSize(Math.round(w * this.q.ao), Math.round(h * this.q.ao));
    this.smaa?.setSize(w, h);
    this.fxaa?.material.uniforms.resolution.value.set(1 / w, 1 / h);
  }
}

/* ------------------------------------------------------------------ hardware detection */

const TIERS = ['low', 'medium', 'high', 'ultra'];
const CACHE_KEY = 'fs.gpuTier.v2';

/** Tier from the GPU name; null when the name is unknown or masked. */
export function tierFromGpuName(gpu) {
  const s = gpu.toLowerCase();
  if (!s) return null;
  if (/swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/.test(s)) return 'low';
  if (/mali|adreno \d{3}\b|adreno\(tm\) \d{3}\b|powervr|apple gpu|videocore|tegra/.test(s)) return 'low';
  // NVIDIA
  if (/rtx\s*a?\d{4}|rtx \d{2}\d{2}/.test(s)) {
    const m = s.match(/rtx\s*(\d)0([5-9])0/);
    if (m) return +m[2] >= 7 ? 'ultra' : 'high';
    return 'high';
  }
  if (/gtx\s*16\d0|gtx\s*10[6-8]0|gtx\s*titan/.test(s)) return 'high';
  if (/gtx\s*10[3-5]0|gtx\s*9\d0|gtx\s*7\d0/.test(s)) return 'medium';
  if (/\bmx\s*\d{3}|geforce \d{3}m|gt \d{3,4}/.test(s)) return 'low';
  // AMD
  if (/rx\s*(6[89]\d0|7[89]\d0|9070)/.test(s)) return 'ultra';
  if (/rx\s*(5[67]\d0|6[5-7]\d0|7[67]\d0|9060|vega 56|vega 64)/.test(s)) return 'high';
  if (/rx\s*(4\d0|5[0-5]\d0|5[0-9]0|6[45]00)/.test(s)) return 'medium';
  if (/radeon.*(780m|880m|890m|8060s)/.test(s)) return 'medium';
  if (/radeon.*(680m|760m|740m|660m)/.test(s)) return 'medium';
  if (/radeon.*vega|radeon\(tm\) graphics|radeon graphics|radeon r[4-7]/.test(s)) return 'low';
  // Intel
  if (/arc\(tm\) a[57]\d0|arc a[57]\d0|arc\(tm\) b/.test(s)) return 'high';
  if (/arc\(tm\) a3|arc a3|arc\(tm\) graphics|iris\(r\) xe|iris xe/.test(s)) return 'medium';
  if (/intel|uhd|hd graphics|iris/.test(s)) return 'low';
  // Apple silicon (Chrome/ANGLE reports the chip)
  if (/apple m\d (max|ultra)/.test(s)) return 'ultra';
  if (/apple m\d/.test(s)) return 'high';
  // Qualcomm Snapdragon X laptops
  if (/adreno.*x1-8|adreno.*x2/.test(s)) return 'medium';
  if (/adreno.*x1/.test(s)) return 'low';
  return null;
}

/** Short GPU fill/ALU benchmark: ms for a fixed amount of fragment work (lower is faster). */
function benchmark(renderer) {
  const rt = new THREE.WebGLRenderTarget(512, 512, { type: THREE.HalfFloatType, depthBuffer: false });
  const quad = new FullScreenQuad(
    new THREE.ShaderMaterial({
      uniforms: { uSeed: { value: 0 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `uniform float uSeed; varying vec2 vUv;
void main(){ vec2 p = vUv * 8.0 + uSeed; float a = 0.0;
  for (int i = 0; i < 96; i++) { p = vec2(p.x * 1.01 + sin(p.y), p.y * 0.99 + cos(p.x)); a += fract(p.x * p.y); }
  gl_FragColor = vec4(a / 96.0, p, 1.0); }`,
      depthTest: false,
      depthWrite: false,
    }),
  );
  const px = new Uint16Array(4);
  const prev = renderer.getRenderTarget();
  const run = (n) => {
    renderer.setRenderTarget(rt);
    for (let i = 0; i < n; i++) {
      quad.material.uniforms.uSeed.value = i * 0.1;
      quad.render(renderer);
    }
    renderer.readRenderTargetPixels(rt, 0, 0, 1, 1, px);
  };
  let ms = 1e9;
  try {
    run(1); // compile + warm up
    const t0 = performance.now();
    run(8);
    ms = performance.now() - t0;
  } catch {
    /* treat as unknown */
  }
  renderer.setRenderTarget(prev);
  rt.dispose();
  quad.dispose();
  quad.material.dispose();
  return ms;
}

/**
 * Picks a quality tier for this machine when the setting is 'auto'.
 * Uses the GPU name, WebGL capabilities, device memory/screen size and a short benchmark;
 * the result is cached per GPU. Returns one of 'low' | 'medium' | 'high' | 'ultra'.
 */
export function detectQuality(renderer) {
  const gl = renderer.getContext();
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const gpu = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER) || '');
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    if (c && c.gpu === gpu && TIERS.includes(c.tier)) return c.tier;
  } catch {
    /* no storage */
  }
  const byName = tierFromGpuName(gpu);
  const ms = benchmark(renderer);
  // calibrated loosely: fast desktop GPUs < 3 ms, mainstream iGPUs ~10-25 ms, software > 80 ms
  const byBench = ms < 3.5 ? 'ultra' : ms < 8 ? 'high' : ms < 22 ? 'medium' : 'low';
  let tier;
  if (byName) {
    // trust the name, but never more than one tier above what the benchmark shows
    tier = TIERS[Math.min(TIERS.indexOf(byName), TIERS.indexOf(byBench) + 1)];
  } else tier = byBench;
  // capability caps
  const caps = renderer.capabilities;
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  let cap = 3;
  if (!caps.isWebGL2 || !renderer.extensions.has('EXT_color_buffer_float')) cap = Math.min(cap, 0);
  if (caps.maxTextureSize < 8192) cap = Math.min(cap, 1);
  if (mobile) cap = Math.min(cap, 0);
  const mem = navigator.deviceMemory;
  if (mem && mem <= 4) cap = Math.min(cap, 1);
  if ((navigator.hardwareConcurrency || 8) <= 2) cap = Math.min(cap, 0);
  tier = TIERS[Math.min(TIERS.indexOf(tier), cap)];
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ gpu, tier, ms: Math.round(ms * 10) / 10 }));
  } catch {
    /* no storage */
  }
  console.info(`[quality] ${gpu} → ${tier} (name: ${byName ?? '?'}, bench ${ms.toFixed(1)} ms)`);
  return tier;
}
