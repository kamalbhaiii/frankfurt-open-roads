/**
 * Physically based sky: single-scattering atmosphere (Rayleigh + Mie + ozone, Nishita-style
 * ray march) baked into a small LUT whenever the sun moves, a dome that adds the sun and moon
 * discs, stars, city light pollution and weather-driven clouds lit by the transmitted sunlight,
 * plus camera-following rain/snow particles.
 *
 * The same atmosphere model runs on the CPU (a few rays) to give the fog/horizon colour and
 * the colour of the direct sunlight, so fog, sky and lighting always agree.
 * OWNER: lighting/rendering agent.
 */
import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { ctx } from '../core/context.js';
import { QUALITY } from '../core/config.js';
import { clamp, lerp, smooth } from '../core/math.js';
import { uniforms } from './materials.js';

/** Sun irradiance scale of the atmosphere model (tuned for ACES at exposure ~1). */
const SUN_E = 30;
const LUT_W = 96,
  LUT_H = 64;

/* ------------------------------------------------------------------ atmosphere (GLSL) */
const ATMOSPHERE_GLSL = /* glsl */ `
#define PI_A 3.14159265
const float RE = 6371.0, RA = 6471.0, HR = 8.0, HM = 1.2;
const vec3 BR = vec3(5.8e-3, 13.5e-3, 33.1e-3);
const vec3 BO = vec3(0.65e-3, 1.881e-3, 0.085e-3) * 2.5;
vec2 rsi(vec3 o, vec3 d, float r) {
  float b = dot(d, o), c = dot(o, o) - r * r, D = b * b - c;
  if (D < 0.0) return vec2(1e5, -1e5);
  D = sqrt(D);
  return vec2(-b - D, -b + D);
}
vec3 atmosphere(vec3 d, vec3 s, float haze) {
  float BM = 21e-3 * haze; const float g = 0.76;
  vec3 o = vec3(0.0, RE + 0.2, 0.0);
  vec2 p = rsi(o, d, RA); vec2 pe = rsi(o, d, RE);
  float tmax = p.y; if (pe.x > 0.0) tmax = min(tmax, pe.x);
  float ds = tmax / 16.0;
  float mu = dot(d, s);
  float pr = 3.0 / (16.0 * PI_A) * (1.0 + mu * mu);
  float pm = 3.0 / (8.0 * PI_A) * ((1.0 - g * g) * (1.0 + mu * mu)) / ((2.0 + g * g) * pow(1.0 + g * g - 2.0 * mu * g, 1.5));
  float odR = 0.0, odM = 0.0; vec3 tR = vec3(0.0), tM = vec3(0.0);
  for (int i = 0; i < 16; i++) {
    vec3 q = o + d * ((float(i) + 0.5) * ds);
    float h = length(q) - RE;
    float hr = exp(-h / HR) * ds, hm = exp(-h / HM) * ds;
    odR += hr; odM += hm;
    float sl = rsi(q, s, RA).y, dl = sl / 8.0, lR = 0.0, lM = 0.0; bool lit = true;
    for (int j = 0; j < 8; j++) {
      vec3 qq = q + s * ((float(j) + 0.5) * dl);
      float hh = length(qq) - RE;
      if (hh < 0.0) { lit = false; break; }
      lR += exp(-hh / HR) * dl; lM += exp(-hh / HM) * dl;
    }
    if (!lit) continue;
    vec3 att = exp(-(BM * 1.1 * (odM + lM) + (BR + BO) * (odR + lR)));
    tR += hr * att; tM += hm * att;
  }
  return pr * BR * tR + pm * BM * tM;
}`;

/* ------------------------------------------------------------------ atmosphere (CPU) */
const RE = 6371,
  RA = 6471;
const BR = [5.8e-3, 13.5e-3, 33.1e-3],
  BO = [0.65e-3 * 2.5, 1.881e-3 * 2.5, 0.085e-3 * 2.5];
function rsi(o, d, r) {
  const b = d[0] * o[0] + d[1] * o[1] + d[2] * o[2];
  const c = o[0] * o[0] + o[1] * o[1] + o[2] * o[2] - r * r;
  const D = b * b - c;
  if (D < 0) return [1e5, -1e5];
  const s = Math.sqrt(D);
  return [-b - s, -b + s];
}
/** Single-scattered sky radiance (linear RGB, before SUN_E) for view dir d and sun dir s. */
export function atmosphere(d, s, haze, out = [0, 0, 0], N = 10, M = 6) {
  const BM = 21e-3 * haze,
    g = 0.76;
  const o = [0, RE + 0.2, 0];
  const p = rsi(o, d, RA),
    pe = rsi(o, d, RE);
  let tmax = p[1];
  if (pe[0] > 0) tmax = Math.min(tmax, pe[0]);
  const ds = tmax / N;
  const mu = d[0] * s[0] + d[1] * s[1] + d[2] * s[2];
  const pr = (3 / (16 * Math.PI)) * (1 + mu * mu);
  const pm = ((3 / (8 * Math.PI)) * ((1 - g * g) * (1 + mu * mu))) / ((2 + g * g) * Math.pow(1 + g * g - 2 * mu * g, 1.5));
  let odR = 0,
    odM = 0;
  const tR = [0, 0, 0],
    tM = [0, 0, 0];
  const q = [0, 0, 0];
  for (let i = 0; i < N; i++) {
    const t = (i + 0.5) * ds;
    q[0] = o[0] + d[0] * t;
    q[1] = o[1] + d[1] * t;
    q[2] = o[2] + d[2] * t;
    const h = Math.hypot(q[0], q[1], q[2]) - RE;
    const hr = Math.exp(-h / 8) * ds,
      hm = Math.exp(-h / 1.2) * ds;
    odR += hr;
    odM += hm;
    const dl = rsi(q, s, RA)[1] / M;
    let lR = 0,
      lM = 0,
      lit = true;
    for (let j = 0; j < M; j++) {
      const tt = (j + 0.5) * dl;
      const hh = Math.hypot(q[0] + s[0] * tt, q[1] + s[1] * tt, q[2] + s[2] * tt) - RE;
      if (hh < 0) {
        lit = false;
        break;
      }
      lR += Math.exp(-hh / 8) * dl;
      lM += Math.exp(-hh / 1.2) * dl;
    }
    if (!lit) continue;
    for (let c = 0; c < 3; c++) {
      const att = Math.exp(-(BM * 1.1 * (odM + lM) + (BR[c] + BO[c]) * (odR + lR)));
      tR[c] += hr * att;
      tM[c] += hm * att;
    }
  }
  for (let c = 0; c < 3; c++) out[c] = pr * BR[c] * tR[c] + pm * BM * tM[c];
  return out;
}

/** Transmittance of the atmosphere from the ground towards direction s (sunlight colour). */
export function transmittance(s, haze, out = [0, 0, 0]) {
  const o = [0, RE + 0.2, 0];
  if (rsi(o, s, RE)[0] > 0) {
    out[0] = out[1] = out[2] = 0;
    return out;
  }
  const N = 12,
    dl = rsi(o, s, RA)[1] / N;
  let lR = 0,
    lM = 0;
  for (let j = 0; j < N; j++) {
    const t = (j + 0.5) * dl;
    const h = Math.hypot(o[0] + s[0] * t, o[1] + s[1] * t, o[2] + s[2] * t) - RE;
    lR += Math.exp(-h / 8) * dl;
    lM += Math.exp(-h / 1.2) * dl;
  }
  const BM = 21e-3 * haze;
  for (let c = 0; c < 3; c++) out[c] = Math.exp(-(BM * 1.1 * lM + (BR[c] + BO[c]) * lR));
  return out;
}

/* ------------------------------------------------------------------ sky dome shader */
const skyFragment = (detail) => /* glsl */ `
varying vec3 vDir;
uniform sampler2D tLut; uniform vec3 sunDir; uniform vec3 moonDir; uniform vec3 sunTrans;
uniform float cloud; uniform float rain; uniform float fog; uniform float uTime; uniform vec3 fogCol; uniform float flash;
uniform vec2 windOff; uniform vec3 cloudSun; uniform vec3 cloudAmb; uniform vec3 nightCol; uniform vec3 cityGlow;
uniform float night; uniform vec3 groundCol; uniform float skyGain;
float h(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
float n2(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f); return mix(mix(h(i),h(i+vec2(1,0)),f.x), mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x), f.y); }
float fbm(vec2 p){ float v=0.0, a=0.5; for(int i=0;i<${detail};i++){ v+=a*n2(p); p=mat2(1.6,1.2,-1.2,1.6)*p+vec2(1.7,9.2); a*=0.5; } return v; }
float fbm3(vec2 p){ float v=0.0, a=0.5; for(int i=0;i<3;i++){ v+=a*n2(p); p=mat2(1.6,1.2,-1.2,1.6)*p+vec2(1.7,9.2); a*=0.5; } return v; }
vec3 lut(vec3 d){
  vec2 sxz = sunDir.xz; float sl = length(sxz); vec2 dxz = d.xz; float dl = length(dxz);
  float c = (sl > 1e-4 && dl > 1e-4) ? dot(dxz / dl, sxz / sl) : 1.0;
  float az = acos(clamp(c, -1.0, 1.0)) / 3.14159265;
  float el = asin(clamp(d.y, -1.0, 1.0)) / 1.5707963;
  vec2 uv = vec2(sqrt(az), 0.5 + 0.5 * sign(el) * sqrt(abs(el)));
  return texture2D(tLut, uv).rgb;
}
float cloudDensity(vec2 cp, float cov){ return smoothstep(cov, cov + 0.32, fbm(cp)); }
void main(){
  vec3 d = normalize(vDir);
  float hy = d.y;
  vec3 dd = vec3(d.x, max(d.y, 0.0), d.z);
  vec3 col = lut(normalize(dd + vec3(0.0, 0.002, 0.0))) * skyGain;
  // multiple-scattering fill: zenith light scattered back towards the horizon
  vec3 zen = lut(vec3(0.0, 1.0, 0.0)) * skyGain;
  col += zen * 0.55 * (1.0 - hy * 0.6);
  // night sky, moonlight and light pollution of the city (strongest at the horizon)
  float moonUp = smoothstep(-0.05, 0.3, moonDir.y);
  col += night * (nightCol + vec3(0.006, 0.010, 0.022) * moonUp + cityGlow * exp(-max(hy, 0.0) * 5.0));
  float sd = dot(d, sunDir);
  float md = dot(d, moonDir);
  float clearSky = 1.0 - smoothstep(0.55, 0.95, cloud);
  // stars, hidden by city glow near the horizon
  if (hy > 0.0) {
    vec2 sp = floor(d.xz / (hy + 0.25) * 240.0);
    float st = step(0.9972, h(sp)) * night * clearSky * smoothstep(0.08, 0.45, hy);
    col += vec3(st) * (0.035 + 0.025 * sin(uTime * 3.0 + h(sp) * 40.0)) * (0.5 + h(sp + 7.0));
  }
  // sun disc (HDR, drives bloom) and moon disc
  float disc = smoothstep(0.99996, 0.99999, sd);
  vec3 sunCol = sunTrans * 60.0 * disc;
  vec3 moonCol = vec3(0.32, 0.34, 0.38) * smoothstep(0.99985, 0.9999, md) * (1.0 - smoothstep(-0.05, 0.2, sunDir.y));
  col += (sunCol + moonCol) * step(0.0, hy);
  // clouds: a curved layer with fbm density, light-march towards the sun for self shadowing
  if (hy > 0.0) {
    vec2 cp = d.xz / (hy + 0.09) * 1.15 + windOff;
    float cov = mix(0.66, 0.0, cloud);
    #if ${detail} >= 5
    cp += vec2(fbm3(cp*0.5 + 3.1), fbm3(cp*0.5 - 1.7)) * 0.9;
    #endif
    float dens = cloudDensity(cp, cov);
    float alpha = dens * smoothstep(0.0, 0.1, hy);
    if (alpha > 0.002) {
      vec2 toSun = normalize(sunDir.xz + 1e-4) * 0.11;
      #if ${detail} >= 4
      float sh = cloudDensity(cp + toSun, cov) + cloudDensity(cp + toSun * 2.2, cov) * 0.6;
      #else
      float sh = cloudDensity(cp + toSun * 1.5, cov) * 1.4;
      #endif
      float thick = clamp(cloud * 0.7 + rain * 0.6, 0.0, 1.0);
      float lightT = exp(-sh * (1.4 + thick * 2.5));
      float phase = 0.5 + 2.2 * pow(max(sd, 0.0), 7.0) + 0.6 * pow(max(sd, 0.0), 40.0) * (1.0 - dens);
      vec3 cc = cloudSun * lightT * phase * (1.0 - thick * 0.75) + cloudAmb * (1.0 - dens * 0.35 * (0.5 + thick));
      cc += cityGlow * night * (1.6 + 2.0 * cloud) * dens;
      cc *= 1.0 - rain * 0.35;
      // distant clouds fade into the haze of the horizon
      float far = 1.0 - exp(-0.05 / max(hy, 0.01));
      cc = mix(cc, col, far * 0.6);
      col = mix(col, cc, alpha * (0.55 + 0.45 * (1.0 - far)));
    }
  }
  // overcast/fog: the whole sky goes towards the fog colour; below the horizon the ground haze
  col = mix(col, fogCol, clamp(fog * 0.9, 0.0, 0.92));
  #ifdef ENV_MAP
  col = mix(col, groundCol, smoothstep(0.0, -0.08, hy));
  #else
  col = mix(col, fogCol, smoothstep(0.045, -0.015, hy));
  #endif
  col += vec3(0.75, 0.8, 1.0) * flash;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/**
 * The sky system: LUT bake, the dome around the camera and an environment-map copy of the
 * dome (with a ground hemisphere) that environment.js turns into the IBL via PMREMGenerator.
 */
export class SkySystem {
  constructor() {
    const q = QUALITY[ctx.quality];
    this.lutTarget = new THREE.WebGLRenderTarget(LUT_W, LUT_H, {
      type: THREE.HalfFloatType,
      depthBuffer: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
    });
    this.lutQuad = new FullScreenQuad(
      new THREE.ShaderMaterial({
        uniforms: { uSun: { value: new THREE.Vector3(0, 1, 0) }, uHaze: { value: 1 } },
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
        fragmentShader: `${ATMOSPHERE_GLSL}
uniform vec3 uSun; uniform float uHaze; varying vec2 vUv;
void main(){
  float az = vUv.x * vUv.x * 3.14159265;
  float v = vUv.y * 2.0 - 1.0; float el = sign(v) * v * v * 1.5707963;
  // local frame: the sun lies in the y/z plane (azimuth 0)
  vec3 d = vec3(sin(az) * cos(el), sin(el), cos(az) * cos(el));
  float se = asin(clamp(uSun.y, -1.0, 1.0));
  vec3 s = vec3(0.0, sin(se), cos(se));
  gl_FragColor = vec4(atmosphere(d, s, uHaze), 1.0);
}`,
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.lutKey = '';
    this.uniforms = {
      tLut: { value: this.lutTarget.texture },
      sunDir: { value: new THREE.Vector3(0, 1, 0) },
      moonDir: { value: new THREE.Vector3(0, -1, 0) },
      sunTrans: { value: new THREE.Color(1, 1, 1) },
      cloud: { value: 0.3 },
      rain: { value: 0 },
      fog: { value: 0 },
      uTime: uniforms.uTime,
      fogCol: { value: new THREE.Color() },
      flash: { value: 0 },
      windOff: { value: new THREE.Vector2() },
      cloudSun: { value: new THREE.Color() },
      cloudAmb: { value: new THREE.Color() },
      nightCol: { value: new THREE.Color(0.003, 0.0045, 0.01) },
      cityGlow: { value: new THREE.Color(0.055, 0.034, 0.018) },
      night: { value: 0 },
      groundCol: { value: new THREE.Color(0.1, 0.1, 0.1) },
      skyGain: { value: SUN_E },
    };
    const make = (env) =>
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        depthTest: false,
        fog: false,
        defines: env ? { ENV_MAP: 1 } : {},
        uniforms: this.uniforms,
        vertexShader: 'varying vec3 vDir; void main(){ vDir = position; vec4 p = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_Position = p.xyww; }',
        fragmentShader: skyFragment(env ? 3 : q.cloudDetail ?? 5),
      });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), make(false));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1;
    this.mesh.name = 'sky';
    ctx.scene.add(this.mesh);
    // copy of the dome for image-based lighting (rendered by PMREMGenerator.fromScene)
    this.envScene = new THREE.Scene();
    const envMat = make(true);
    envMat.toneMapped = false;
    const envDome = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), envMat);
    envDome.frustumCulled = false;
    envDome.scale.setScalar(50);
    this.envScene.add(envDome);
    this._a = [0, 0, 0];
    this._b = [0, 0, 0];
    this._s = [0, 0, 0];
  }

  /** Re-bakes the atmosphere LUT when the sun or the haze changed noticeably. */
  bake(renderer, sunDir, haze) {
    const key = `${Math.round(Math.asin(clamp(sunDir.y, -1, 1)) * 1200)}:${Math.round(haze * 40)}`;
    if (key === this.lutKey) return false;
    this.lutKey = key;
    const m = this.lutQuad.material.uniforms;
    m.uSun.value.copy(sunDir);
    m.uHaze.value = haze;
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.lutTarget);
    this.lutQuad.render(renderer);
    renderer.setRenderTarget(prev);
    return true;
  }

  /**
   * CPU colours from the same model: horizon (fog) colour, sky zenith colour and the
   * transmitted sun colour. Values are linear and already scaled by SUN_E.
   */
  colors(sunDir, haze, out) {
    const s = this._s;
    s[0] = sunDir.x;
    s[1] = sunDir.y;
    s[2] = sunDir.z;
    const a = this._a,
      b = this._b;
    // horizon average: towards the sun, across and away from it, 3° above the horizon
    const el = 0.05,
      ce = Math.cos(el),
      se = Math.sin(el);
    const sl = Math.hypot(s[0], s[2]) || 1;
    const sx = s[0] / sl,
      sz = s[2] / sl;
    let r = 0,
      g = 0,
      bl = 0;
    const W = [0.3, 0.25, 0.25, 0.2];
    const dirs = [
      [sx, sz],
      [-sz, sx],
      [sz, -sx],
      [-sx, -sz],
    ];
    dirs.forEach(([x, z], i) => {
      atmosphere([x * ce, se, z * ce], s, haze, a, 8, 5);
      r += a[0] * W[i];
      g += a[1] * W[i];
      bl += a[2] * W[i];
    });
    atmosphere([0, 1, 0], s, haze, b, 8, 5);
    // multiple-scattering fill as in the shader
    out.horizon.setRGB((r + b[0] * 0.5) * SUN_E, (g + b[1] * 0.5) * SUN_E, (bl + b[2] * 0.5) * SUN_E);
    out.zenith.setRGB(b[0] * SUN_E * 1.45, b[1] * SUN_E * 1.45, b[2] * SUN_E * 1.45);
    transmittance(s, haze, a);
    // the sun sinks into the earth's shadow: soften the cut-off around the horizon
    const fade = smooth(-0.035, 0.02, sunDir.y);
    out.sun.setRGB(a[0] * fade, a[1] * fade, a[2] * fade);
    return out;
  }

  /** Per-frame uniforms. */
  update(camera) {
    this.mesh.position.copy(camera.position);
    this.mesh.scale.setScalar(camera.far * 0.9);
  }
}

/** Rain streaks and snowflakes in a box that wraps around the camera. */
export function buildPrecipitation() {
  const make = (n, line) => {
    const per = line ? 2 : 1;
    const g = new THREE.BufferGeometry();
    const p = new Float32Array(n * per * 3),
      e = new Float32Array(n * per);
    for (let i = 0; i < n; i++) {
      const x = Math.random(),
        y = Math.random(),
        z = Math.random();
      for (let k = 0; k < per; k++) {
        const j = i * per + k;
        p.set([x, y, z], j * 3);
        e[j] = k;
      }
    }
    g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    g.setAttribute('aEnd', new THREE.BufferAttribute(e, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    return g;
  };
  const material = (snow) =>
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        uTime: uniforms.uTime,
        uCam: { value: new THREE.Vector3() },
        uWind: { value: new THREE.Vector2() },
        uAmt: { value: 0 },
        uLight: { value: new THREE.Color(1, 1, 1) },
      },
      vertexShader: `attribute float aEnd; uniform float uTime; uniform vec3 uCam; uniform vec2 uWind; uniform float uAmt; varying float vA;
void main(){ float B = 50.0; vec3 r = position;
  float sp = ${snow ? '2.2' : '17.0'};
  vec3 p = r * B; p.y = mod(p.y - uTime*sp, B);
  p.xz += uWind * (B - p.y) * ${snow ? '0.25' : '0.06'};
  ${snow ? 'p.x += sin(uTime*1.3 + r.z*40.0)*0.8; p.z += cos(uTime*1.1 + r.x*40.0)*0.8;' : ''}
  vec3 wp = floor(uCam/B)*B + p - vec3(B*0.5, B*0.35, B*0.5);
  vec3 rel = wp - uCam; rel = mod(rel + B*0.5, B) - B*0.5; wp = uCam + rel;
  ${snow ? '' : 'wp += aEnd * vec3(uWind.x*0.05, 0.6, uWind.y*0.05);'}
  vA = step(fract(r.x*91.7+r.z*13.1), uAmt) * (1.0 - smoothstep(18.0, 25.0, length(rel)));
  gl_Position = projectionMatrix * viewMatrix * vec4(wp,1.0); gl_PointSize = ${snow ? '3.0' : '1.0'} * 300.0 / max(gl_Position.w, 1.0);
}`,
      // linear output: tone mapping and sRGB encoding happen with the rest of the scene
      fragmentShader: `uniform vec3 uLight; varying float vA; void main(){ if (vA < 0.01) discard; gl_FragColor = vec4(vec3(${snow ? '0.9' : '0.55,0.6,0.68'})*uLight, vA * ${snow ? '0.9' : '0.4'});
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`,
    });
  const n = QUALITY[ctx.quality].rain;
  const rain = new THREE.LineSegments(make(n, true), material(false));
  const snow = new THREE.Points(make(n / 2, false), material(true));
  rain.frustumCulled = snow.frustumCulled = false;
  rain.name = 'rain';
  snow.name = 'snow';
  ctx.scene.add(rain, snow);
  return { rain, snow };
}

/**
 * Horizon/fog colour for callers that do not have the sky system (kept for compatibility):
 * approximates the CPU model with a few lerps.
 */
export function horizonColor(sa, cloud, rain, out = new THREE.Color()) {
  const day = smooth(-0.14, 0.22, sa),
    sunset = 1 - smooth(0, 0.32, Math.abs(sa + 0.03));
  out.setRGB(lerp(0.02, 0.62, day), lerp(0.03, 0.72, day), lerp(0.06, 0.85, day));
  out.lerp(new THREE.Color(1.0, 0.55, 0.3), sunset * 0.45);
  const g = new THREE.Color(lerp(0.03, 0.55, day), lerp(0.035, 0.58, day), lerp(0.045, 0.62, day));
  out.lerp(g, clamp((cloud * 0.85 + rain * 0.3) * 0.8, 0, 0.92));
  return out;
}
