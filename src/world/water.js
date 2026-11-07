/**
 * River Main and small water bodies.
 * OWNER: lighting/rendering agent. Entry point: buildWater(river, smallWater).
 *
 * The surface is a MeshStandardMaterial (so it gets sun glints, shadows, fog and the
 * sky IBL with physically based fresnel) whose normal comes from two scrolling samples of
 * a tileable normal map flowing west with the river, plus rain ripples. On high/ultra the
 * river also gets a planar mirror pass (renderWaterReflection, called by the render pipeline)
 * that replaces the IBL radiance, distorted by the waves.
 */
import * as THREE from 'three';
import { ctx } from '../core/context.js';
import { WATER_Y } from '../core/config.js';
import { assets } from '../core/assets.js';
import { addFlatPoly, GeoBuilder } from './geometry.js';
import { uniforms } from './materials.js';

const shared = {
  tNormal: { value: null },
  tReflect: { value: null },
  uPlanar: { value: 0 },
  uReflMatrix: { value: new THREE.Matrix4() },
  uRain: { value: 0 },
};
const state = { river: null, ponds: null, rt: null, cam: new THREE.PerspectiveCamera(), frame: 0 };

/** Animated water surface; `planar` adds the mirror-texture path. */
function waterMaterial(planar) {
  const m = new THREE.MeshStandardMaterial({
    color: 0x1a2c28,
    roughness: 0.05,
    metalness: 0.0,
    vertexColors: true,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });
  if (planar) m.defines = { PLANAR: 1 };
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, shared, { uTime: uniforms.uTime });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWp; varying vec4 vRefl; uniform mat4 uReflMatrix;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWp = (modelMatrix*vec4(transformed,1.0)).xyz; vRefl = uReflMatrix * vec4(vWp, 1.0);');
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform float uTime; uniform float uRain; uniform float uPlanar; uniform sampler2D tNormal; uniform sampler2D tReflect; varying vec3 vWp; varying vec4 vRefl;',
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
// the Main flows west; two octaves of the normal map drift with it at different speeds
vec2 flowDir = vec2(-1.0, 0.12);
float t = uTime;
vec2 uvA = vWp.xz * 0.032 + flowDir * t * 0.011;
vec2 uvB = mat2(0.8, -0.6, 0.6, 0.8) * vWp.xz * 0.06 + flowDir * t * 0.026 + vec2(0.0, t * 0.004);
vec2 slope = (texture2D(tNormal, uvA).xy * 2.0 - 1.0) + (texture2D(tNormal, uvB).xy * 2.0 - 1.0) * 0.6;
// rain: fast, fine ripples
vec2 uvC = vWp.xz * 0.55 + vec2(t * 0.9, -t * 0.7);
slope += (texture2D(tNormal, uvC).xy * 2.0 - 1.0) * uRain * 0.9;
float wDist = length(vWp - cameraPosition);
float wFade = 1.0 / (1.0 + wDist * 0.006);
slope *= 0.15 * wFade + 0.035;
vec3 wn = normalize(vec3(slope.x, 1.0, slope.y));
normal = normalize((viewMatrix * vec4(wn, 0.0)).xyz);`,
      )
      .replace(
        '#include <lights_fragment_maps>',
        `#include <lights_fragment_maps>
#ifdef PLANAR
{
  vec2 ruv = vRefl.xy / vRefl.w + wn.xz * (0.06 * wFade + 0.01);
  vec3 refl = texture2D(tReflect, clamp(ruv, 0.001, 0.999)).rgb;
  radiance = mix(radiance, refl, uPlanar);
}
#endif`,
      );
  };
  m.customProgramCacheKey = () => (planar ? 'water-planar' : 'water');
  return m;
}

export function buildWater(river, smallWater) {
  const scene = ctx.scene;
  const tex = assets.texture('textures/water/normals.jpg', { srgb: false, repeat: true });
  shared.tNormal.value = tex;
  const white = new THREE.Color(0xffffff);
  const gr = new GeoBuilder();
  for (const r of river) addFlatPoly(gr, r, WATER_Y, white);
  ctx.mats.water = waterMaterial(true);
  const water = new THREE.Mesh(gr.build(), ctx.mats.water);
  water.receiveShadow = true;
  water.name = 'river';
  scene.add(water);
  state.river = water;
  if (smallWater.length) {
    const gp = new GeoBuilder();
    for (const r of smallWater) addFlatPoly(gp, r, 0.04, white);
    const ponds = new THREE.Mesh(gp.build(), waterMaterial(false));
    ponds.receiveShadow = true;
    ponds.name = 'ponds';
    scene.add(ponds);
    state.ponds = ponds;
  }
}

/** Per-frame weather inputs (called by environment.js). */
export function updateWater(_dt, env) {
  shared.uRain.value = env.weather.rain;
}

const _plane = new THREE.Plane(),
  _clip = new THREE.Vector4(),
  _q = new THREE.Vector4(),
  _camPos = new THREE.Vector3(),
  _target = new THREE.Vector3(),
  _view = new THREE.Vector3(),
  _rot = new THREE.Matrix4(),
  _lookAt = new THREE.Vector3(),
  _normal = new THREE.Vector3(0, 1, 0),
  _mirror = new THREE.Vector3(0, WATER_Y, 0),
  _frustum = new THREE.Frustum(),
  _pv = new THREE.Matrix4(),
  _box = new THREE.Box3();

/**
 * Renders the planar reflection of the river (high/ultra). `scale` is the reflection
 * resolution relative to the drawing buffer; `every` renders it only every N frames.
 * Returns false when the river is not visible or reflections are off.
 */
export function renderWaterReflection(renderer, scene, camera, scale, every = 1) {
  const river = state.river;
  if (!river || !scale) {
    shared.uPlanar.value = 0;
    return false;
  }
  _camPos.setFromMatrixPosition(camera.matrixWorld);
  if (_camPos.y < WATER_Y + 0.2) {
    shared.uPlanar.value = 0;
    return false;
  }
  _pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  _frustum.setFromProjectionMatrix(_pv);
  if (!river.geometry.boundingBox) river.geometry.computeBoundingBox();
  _box.copy(river.geometry.boundingBox).applyMatrix4(river.matrixWorld);
  if (!_frustum.intersectsBox(_box)) return false;
  shared.uPlanar.value = 1;
  if (state.frame++ % Math.max(1, every) !== 0 && state.rt) return true;

  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const w = Math.max(64, Math.round(size.x * scale)),
    h = Math.max(64, Math.round(size.y * scale));
  if (!state.rt) state.rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType });
  else if (state.rt.width !== w || state.rt.height !== h) state.rt.setSize(w, h);
  shared.tReflect.value = state.rt.texture;

  // mirrored virtual camera (as in three/examples Reflector)
  const cam = state.cam;
  _rot.extractRotation(camera.matrixWorld);
  _view.subVectors(_mirror, _camPos);
  _view.reflect(_normal).negate().add(_mirror);
  _lookAt.set(0, 0, -1).applyMatrix4(_rot).add(_camPos);
  _target.subVectors(_mirror, _lookAt).reflect(_normal).negate().add(_mirror);
  cam.position.copy(_view);
  cam.up.set(0, 1, 0).applyMatrix4(_rot).reflect(_normal);
  cam.lookAt(_target);
  cam.far = camera.far;
  cam.layers.mask = camera.layers.mask;
  cam.updateMatrixWorld();
  cam.projectionMatrix.copy(camera.projectionMatrix);
  shared.uReflMatrix.value.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
  shared.uReflMatrix.value.multiply(cam.projectionMatrix).multiply(cam.matrixWorldInverse);
  // oblique near plane = water plane, so nothing under water ends up in the reflection
  _plane.setFromNormalAndCoplanarPoint(_normal, _mirror).applyMatrix4(cam.matrixWorldInverse);
  _clip.set(_plane.normal.x, _plane.normal.y, _plane.normal.z, _plane.constant);
  const p = cam.projectionMatrix;
  _q.x = (Math.sign(_clip.x) + p.elements[8]) / p.elements[0];
  _q.y = (Math.sign(_clip.y) + p.elements[9]) / p.elements[5];
  _q.z = -1.0;
  _q.w = (1.0 + p.elements[10]) / p.elements[14];
  _clip.multiplyScalar(2.0 / _clip.dot(_q));
  p.elements[2] = _clip.x;
  p.elements[6] = _clip.y;
  p.elements[10] = _clip.z + 1.0 - 0.05;
  p.elements[14] = _clip.w;
  cam.projectionMatrixInverse.copy(p).invert();

  const hidden = [river, state.ponds, scene.getObjectByName('rain'), scene.getObjectByName('snow')].filter((o) => o && o.visible);
  for (const o of hidden) o.visible = false;
  const prevRT = renderer.getRenderTarget();
  const autoUpdate = renderer.shadowMap.autoUpdate;
  renderer.shadowMap.autoUpdate = false;
  renderer.setRenderTarget(state.rt);
  renderer.clear();
  renderer.render(scene, cam);
  renderer.shadowMap.autoUpdate = autoUpdate;
  renderer.setRenderTarget(prevRT);
  for (const o of hidden) o.visible = true;
  return true;
}

/** Turns the planar reflection off (lower tiers / adaptive quality). */
export function disableWaterReflection() {
  shared.uPlanar.value = 0;
  if (state.rt) {
    state.rt.dispose();
    state.rt = null;
  }
}
