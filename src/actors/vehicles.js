/**
 * Vehicles: GLB models on Rapier bodies. A vehicle is either
 *   'ai'      – kinematic, driven along the road network by the traffic system
 *   'parked'  – dynamic with a raycast vehicle controller, nobody driving
 *   'player'  – dynamic, driven by the player
 *   'pursuit' – dynamic, driven by police AI
 * Handles damage, smoke, lights, indicators, sirens and water.
 */
import * as THREE from 'three';
import { ctx } from '../core/context.js';
import { CAR_KINDS, CAR_PAINTS, WATER_Y, QUALITY } from '../core/config.js';
import { rnd, clamp, lerp, SpatialGrid } from '../core/math.js';
import { events } from '../core/events.js';
import { randomPerson } from './characters.js';
import { VEHICLE_TYPES } from './vehicleTypes.js';

/** Kinds whose livery is fixed (never resprayed). */
const FIXED_LIVERY = new Set(['taxi', 'police', 'van', 'bus', 'ambulance', 'tow']);

/**
 * Vehicle body materials. Vertex colour alpha holds a material class (cls / 15, see tools/models/cars.mjs CLS):
 * 1 paint (clear-coated on medium+), 2 chrome, 3 gloss black, 4 rubber, 5 interior, 6-10 lamps, 11 metal, 13 lens.
 * Back faces (seen through the glass) render as dark interior trim.
 */
function patchVehicleMaterial(m) {
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
#ifdef USE_COLOR_ALPHA
  float vCls = floor(vColor.a * 15.0 + 0.5);
  diffuseColor.a = opacity;
#else
  float vCls = 1.0;
#endif
  if (!gl_FrontFacing) { diffuseColor.rgb = vec3(0.035); vCls = 5.0; }`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
  roughnessFactor = vCls == 1.0 ? 0.32 : vCls == 2.0 ? 0.1 : vCls == 3.0 ? 0.22 : vCls == 4.0 ? 0.88 : vCls == 5.0 ? 0.9 : vCls == 11.0 ? 0.3 : vCls == 13.0 ? 0.08 : (vCls >= 6.0 && vCls <= 10.0) ? 0.15 : 0.7;`,
      )
      .replace(
        '#include <metalnessmap_fragment>',
        `#include <metalnessmap_fragment>
  metalnessFactor = vCls == 1.0 ? 0.3 : vCls == 2.0 ? 1.0 : vCls == 11.0 ? 0.85 : 0.0;`,
      );
    if (m.isMeshPhysicalMaterial)
      sh.fragmentShader = sh.fragmentShader.replace(
        '#include <lights_physical_fragment>',
        '#include <lights_physical_fragment>\n  material.clearcoat *= vCls == 1.0 ? 1.0 : 0.0;',
      );
  };
  m.customProgramCacheKey = () => (m.isMeshPhysicalMaterial ? 'vehicle-pbr-cc' : 'vehicle-pbr');
  return m;
}

/** Clear-coated (medium+) or plain PBR material for vertex-coloured vehicle meshes. */
export function bodyMaterial(src, doubleSide, quality = ctx.quality) {
  const physical = quality && quality !== 'low';
  const m = physical
    ? new THREE.MeshPhysicalMaterial({ vertexColors: true, clearcoat: 1, clearcoatRoughness: 0.06, envMapIntensity: 1.1 })
    : new THREE.MeshStandardMaterial({ vertexColors: true });
  m.name = src.name;
  if (doubleSide) m.side = THREE.DoubleSide;
  return patchVehicleMaterial(m);
}
let sharedGlass = null,
  sharedWheel = null;

/** Sets the colour of every paint-class vertex (per-instance copy of the colour attribute). */
function repaint(mesh, hex) {
  const src = mesh.geometry.attributes.color;
  if (!src || src.itemSize !== 4) return;
  const c = new THREE.Color(hex),
    out = new Float32Array(src.count * 4);
  for (let i = 0; i < src.count; i++) {
    const a = src.getW(i),
      paint = Math.abs(a * 15 - 1) < 0.5;
    out[i * 4] = paint ? c.r : src.getX(i);
    out[i * 4 + 1] = paint ? c.g : src.getY(i);
    out[i * 4 + 2] = paint ? c.b : src.getZ(i);
    out[i * 4 + 3] = a;
  }
  if (!mesh.userData.ownGeometry) {
    const g = new THREE.BufferGeometry();
    for (const k in mesh.geometry.attributes) g.setAttribute(k, mesh.geometry.attributes[k]);
    g.setIndex(mesh.geometry.index);
    g.boundingSphere = mesh.geometry.boundingSphere;
    g.boundingBox = mesh.geometry.boundingBox;
    mesh.geometry = g;
    mesh.userData.ownGeometry = true;
  }
  mesh.geometry.setAttribute('color', new THREE.BufferAttribute(out, 4));
}

const PLATE_LETTERS = 'ABCDEFGHJKLMNPRSTUVWXYZ';
/** Random Frankfurt number plate, e.g. "F-KM 2741". */
export function randomPlate() {
  const n = 1 + Math.floor(rnd() * 2);
  let l = '';
  for (let i = 0; i < n; i++) l += PLATE_LETTERS[Math.floor(rnd() * PLATE_LETTERS.length)];
  return `F-${l} ${1 + Math.floor(rnd() * (n === 2 ? 999 : 9999))}`;
}

/** Canvas texture: front plate in the top half, rear plate in the bottom half (matches the plate UVs). */
function plateTexture(text) {
  const cv = document.createElement('canvas');
  cv.width = 256;
  cv.height = 128;
  const g = cv.getContext('2d');
  const [city, rest] = text.split('-');
  for (const y0 of [0, 64]) {
    g.fillStyle = '#111';
    g.fillRect(0, y0, 256, 64);
    g.fillStyle = '#f4f4f0';
    g.fillRect(3, y0 + 3, 250, 58);
    g.fillStyle = '#1d3f9e';
    g.fillRect(3, y0 + 3, 24, 58);
    g.fillStyle = '#f5d000';
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      g.fillRect(15 + Math.cos(a) * 7 - 1, y0 + 20 + Math.sin(a) * 7 - 1, 2, 2);
    }
    g.fillStyle = '#fff';
    g.font = 'bold 15px Arial, sans-serif';
    g.textAlign = 'center';
    g.fillText('D', 15, y0 + 52);
    g.fillStyle = '#111';
    g.font = 'bold 46px "Arial Narrow", "Roboto Condensed", Arial, sans-serif';
    g.textAlign = 'left';
    const cw = g.measureText(city).width * 0.82;
    g.save();
    g.translate(36, y0 + 50);
    g.scale(0.82, 1);
    g.fillText(city, 0, 0);
    g.fillText(rest, (cw + 30) / 0.82, 0);
    g.restore();
    const sx = 36 + cw + 15;
    g.fillStyle = '#2a7a3a';
    g.beginPath();
    g.arc(sx, y0 + 22, 8, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#b02a2a';
    g.beginPath();
    g.arc(sx, y0 + 42, 7, 0, Math.PI * 2);
    g.fill();
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

const SUSPENSION = 0.32;
const SIREN_BLUE = [0x2050ff, 0x3a64ff]; // German blue lights
const UP = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3(),
  _q = new THREE.Quaternion();
export const MAX_HEALTH = 1000;

export function pickKind(exclude = []) {
  let total = 0;
  for (const k in CAR_KINDS) if (!exclude.includes(k)) total += CAR_KINDS[k];
  let r = rnd() * total;
  for (const k in CAR_KINDS) {
    if (exclude.includes(k)) continue;
    r -= CAR_KINDS[k];
    if (r <= 0) return k;
  }
  return 'sedan';
}

/** Pooled smoke puffs for damaged vehicles. */
class SmokeSystem {
  constructor(n = 220) {
    this.n = n;
    this.i = 0;
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(n * 3).fill(-9999);
    this.age = new Float32Array(n).fill(99);
    this.vel = new Float32Array(n * 3);
    this.dark = new Float32Array(n);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('aAge', new THREE.BufferAttribute(this.age, 1));
    g.setAttribute('aDark', new THREE.BufferAttribute(this.dark, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    const m = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      vertexShader:
        'attribute float aAge; attribute float aDark; varying float vA; varying float vD; void main(){ vA = aAge; vD = aDark; vec4 mv = modelViewMatrix * vec4(position,1.0); gl_Position = projectionMatrix * mv; gl_PointSize = (40.0 + aAge * 90.0) / max(-mv.z, 1.0) * 6.0; }',
      fragmentShader:
        'varying float vA; varying float vD; void main(){ if (vA > 2.5) discard; float d = length(gl_PointCoord - 0.5); if (d > 0.5) discard; float a = (1.0 - d*2.0) * (1.0 - vA/2.5) * 0.45; gl_FragColor = vec4(vec3(mix(0.72, 0.12, vD)), a); }',
    });
    this.points = new THREE.Points(g, m);
    this.points.frustumCulled = false;
    ctx.scene.add(this.points);
  }
  emit(x, y, z, dark) {
    const i = this.i++ % this.n;
    this.pos.set([x, y, z], i * 3);
    this.vel.set([(Math.random() - 0.5) * 0.6, 1.2 + Math.random(), (Math.random() - 0.5) * 0.6], i * 3);
    this.age[i] = 0;
    this.dark[i] = dark;
  }
  update(dt) {
    for (let i = 0; i < this.n; i++) {
      if (this.age[i] > 2.5) continue;
      this.age[i] += dt;
      for (let k = 0; k < 3; k++) this.pos[i * 3 + k] += this.vel[i * 3 + k] * dt;
    }
    const g = this.points.geometry;
    g.attributes.position.needsUpdate = g.attributes.aAge.needsUpdate = g.attributes.aDark.needsUpdate = true;
  }
}

export class Vehicle {
  constructor(kind, x, z, yaw, mode = 'parked', { paint = null, driver = true } = {}) {
    const { RAPIER, world, scene, models } = ctx;
    const src = models[`car_${kind}`].scene.children[0];
    const ud = src.userData;
    this.kind = kind;
    this.ud = ud;
    this.label = ud.label;
    this.width = ud.width;
    this.length = ud.length;
    this.sport = kind === 'coupe';
    this.isPolice = kind === 'police';
    this.type = VEHICLE_TYPES[kind] || null;
    this.drivable = ud.drivable !== false;
    this.model = src.clone(true);
    this.paint = FIXED_LIVERY.has(kind) ? null : (paint ?? rnd.pick(CAR_PAINTS));
    this.plateText = randomPlate();
    const matCache = new Map();
    this.model.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.receiveShadow = false;
      const m = o.material;
      if (m.name === 'glass') {
        if (!sharedGlass) {
          sharedGlass = m.clone();
          Object.assign(sharedGlass, { opacity: 0.5, roughness: 0.02, metalness: 0.1, envMapIntensity: 1.6 });
          sharedGlass.color.setHex(0x0c1419);
        }
        o.material = sharedGlass;
        o.castShadow = false;
        return;
      }
      if (m.name === 'wheel_vc') {
        sharedWheel ||= bodyMaterial(m, false);
        o.material = sharedWheel;
        return;
      }
      if (!matCache.has(m)) matCache.set(m, m.name === 'body_vc' ? bodyMaterial(m, true) : m.clone());
      o.material = matCache.get(m);
      if (m.name === 'body_vc') {
        this.bodyMesh = o;
        if (this.paint != null) repaint(o, this.paint);
      }
      if (m.name === 'plate') {
        this.plateTex = plateTexture(this.plateText);
        o.material.map = this.plateTex;
        o.material.color.setHex(0xffffff);
        o.castShadow = false;
      }
    });
    this.materials = [...matCache.values()];
    this.lights = {};
    for (const m of this.materials) this.lights[m.name] = m;
    this.H0 = ud.wheelRadius + SUSPENSION;
    this.model.position.y = -this.H0;
    this.mesh = new THREE.Group();
    this.mesh.add(this.model);
    scene.add(this.mesh);
    this.wheels = ['wheel_FL', 'wheel_FR', 'wheel_RL', 'wheel_RR'].map((n) => {
      const w = this.model.getObjectByName(n);
      w.rotation.order = 'YXZ';
      return w;
    });

    this.mode = mode;
    this.yaw = yaw;
    this.speed = 0; // AI speed (m/s)
    this.kmh = 0;
    this.steer = 0;
    this.health = MAX_HEALTH;
    this.siren = false;
    this.indicator = 0; // -1 left, 1 right, 2 hazards
    this.braking = false;
    this.sinkT = 0;
    this.wheelSpin = 0;
    this.prevVel = { x: 0, y: 0, z: 0 };
    this.impactCooldown = 0;
    this.smokeT = 0;
    this.lastTouched = 0; // simTime when the player last used it
    this.persistent = false; // mission vehicles are never despawned

    _q.setFromAxisAngle(UP, yaw);
    const rot = { x: _q.x, y: _q.y, z: _q.z, w: _q.w };
    if (mode === 'ai')
      this.body = world.createRigidBody(
        RAPIER.RigidBodyDesc.kinematicPositionBased()
          .setTranslation(x, this.H0 + 0.035, z)
          .setRotation(rot),
      );
    else
      this.body = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(x, this.H0 + 0.08, z)
          .setRotation(rot)
          .setLinearDamping(0.05)
          .setAngularDamping(0.6)
          .setCcdEnabled(true),
      );
    const top = ud.height * 0.9,
      hy = (top - ud.sill) / 2,
      hx = ud.width / 2 - 0.03,
      hz = ud.length / 2 - 0.06;
    this.collider = world.createCollider(
      RAPIER.ColliderDesc.cuboid(hx, hy, hz)
        .setTranslation(0, ud.sill + hy - this.H0, 0)
        .setDensity(ud.mass / (8 * hx * hy * hz))
        .setFriction(0.4)
        .setRestitution(0.05),
      this.body,
    );
    if (mode !== 'ai') this.addController();
    if (mode === 'ai' && driver) this.setDriver(randomPerson());
  }

  get dead() {
    return this.health <= 0;
  }
  get position() {
    return this.body.translation();
  }

  addController() {
    const vc = ctx.world.createVehicleController(this.body);
    vc.setIndexForwardAxis = 2; // Rapier names this setter "setIndexForwardAxis"
    vc.indexUpAxis = 1;
    for (const w of this.wheels)
      vc.addWheel(
        { x: this.ud.physTrack ? (Math.sign(w.position.x) * this.ud.physTrack) / 2 : w.position.x, y: 0, z: w.position.z },
        { x: 0, y: -1, z: 0 },
        { x: -1, y: 0, z: 0 },
        SUSPENSION,
        this.ud.wheelRadius,
      );
    for (let i = 0; i < 4; i++) {
      vc.setWheelSuspensionStiffness(i, 34);
      vc.setWheelSuspensionCompression(i, 3.4);
      vc.setWheelSuspensionRelaxation(i, 4.4);
      vc.setWheelMaxSuspensionTravel(i, 0.28);
      vc.setWheelMaxSuspensionForce(i, this.ud.mass * 60);
      vc.setWheelFrictionSlip(i, this.sport ? 2.7 : 2.2);
      vc.setWheelSideFrictionStiffness(i, 1.0);
    }
    this.vc = vc;
  }

  /** Switches a kinematic traffic car to a physics car (carjacked, crashed into, pursuit). */
  makeDynamic(newMode = 'parked') {
    if (this.mode !== 'ai') {
      this.mode = newMode;
      return;
    }
    const lv = { x: Math.sin(this.yaw) * this.speed, y: 0, z: Math.cos(this.yaw) * this.speed };
    this.body.setBodyType(ctx.RAPIER.RigidBodyType.Dynamic, true);
    this.body.enableCcd(true);
    this.body.setAngularDamping(0.6);
    this.body.setLinvel(lv, true);
    this.prevVel = lv;
    this.mode = newMode;
    this.ai = null;
    this.addController();
  }

  setDriver(ch) {
    this.driver = ch;
    if (!ch) return;
    this.model.add(ch.root);
    ch.root.position.set(this.ud.seatX ?? 0.38, this.ud.seatY + 0.2 - 0.98, this.ud.seatZ - 0.05);
    ch.root.rotation.set(0, 0, 0);
    ch.play('sit', 0);
  }
  /** Removes the driver character and returns it (caller places it in the world). */
  takeDriver() {
    const ch = this.driver;
    if (!ch) return null;
    this.driver = null;
    this.model.remove(ch.root);
    return ch;
  }
  /** World position of the driver's door. */
  doorPosition(side = 1) {
    const p = this.position;
    _v.set(side * (this.width / 2 + 0.8), 0, 0).applyAxisAngle(UP, this.yaw);
    return { x: p.x + _v.x, z: p.z + _v.z };
  }

  /**
   * Applies driver input to a dynamic vehicle.
   * throttle/steer in [-1, 1]; handbrake boolean.
   */
  drive(throttle, steerInput, handbrake, dt) {
    const vc = this.vc;
    if (!vc) return;
    const kmh = vc.currentVehicleSpeed() * 3.6;
    const healthFactor = this.health < MAX_HEALTH * 0.25 ? 0.55 : 1;
    const maxF = this.ud.mass * 4.3 * (this.ud.power || 1) * healthFactor;
    let engine = 0,
      brake = 0;
    if (throttle > 0) {
      engine = kmh < -2 ? 0 : maxF * throttle;
      if (kmh < -2) brake = 30;
    } else if (throttle < 0) {
      if (kmh > 3) brake = (this.ud.mass / 32) * -throttle;
      else engine = -maxF * 0.6 * -throttle;
    }
    if (handbrake) brake = this.ud.mass / 22;
    if (this.dead) engine = 0;
    // Near full steering lock is useful when parking, but makes the car twitchy
    // at road speed. Reduce the wheel angle and steering response progressively.
    const roadSpeed = Math.abs(kmh);
    const steerMax = lerp(0.58, 0.105, clamp((roadSpeed - 8) / 92, 0, 1));
    const steerRate = lerp(6.5, 3.2, clamp(roadSpeed / 100, 0, 1));
    this.steer = lerp(this.steer, -steerInput * steerMax, clamp(dt * steerRate, 0, 1));
    if (this.body.translation().y < WATER_Y + 0.3) engine = 0;
    for (let i = 0; i < 4; i++) {
      vc.setWheelEngineForce(i, i >= 2 ? engine : 0); // rear-wheel drive
      vc.setWheelBrake(i, brake * (i >= 2 && handbrake ? 1.5 : 1));
      vc.setWheelSteering(i, i < 2 ? this.steer : 0);
      vc.setWheelFrictionSlip(i, handbrake && i >= 2 ? 1.1 : this.sport ? 2.7 : 2.2);
    }
    this.braking = brake > 0;
    this.kmh = kmh;
    this.engineLoad = Math.abs(throttle);
    // automatic indicators while turning at low speed
    if (this.indicator !== 2) this.indicator = Math.abs(steerInput) > 0.5 && Math.abs(kmh) < 40 ? (steerInput < 0 ? -1 : 1) : 0;
    const lv = this.body.linvel();
    // Rolling and aerodynamic resistance: enough to coast down naturally without
    // acting like a permanent brake at motorway speed.
    const drag = 0.035 + 0.014 * Math.hypot(lv.x, lv.z);
    this.body.applyImpulse({ x: -lv.x * drag * dt, y: 0, z: -lv.z * drag * dt }, true);
  }

  idle() {
    if (!this.vc) return;
    for (let i = 0; i < 4; i++) {
      this.vc.setWheelEngineForce(i, 0);
      this.vc.setWheelBrake(i, 10);
      this.vc.setWheelSteering(i, 0);
    }
    this.braking = false;
    this.engineLoad = 0;
  }

  /** Called with an impact strength in m/s of sudden velocity change. */
  onImpact(impact) {
    if (this.impactCooldown > 0 || impact < 4) return;
    this.impactCooldown = 0.35;
    const dmg = (impact - 3) ** 1.5 * 9;
    this.health = Math.max(0, this.health - dmg);
    events.emit('vehicle:crash', { car: this, impact });
  }

  repair() {
    this.health = MAX_HEALTH;
  }

  respray() {
    if (this.paint == null || !this.bodyMesh) return;
    const next = rnd.pick(CAR_PAINTS.filter((c) => c !== this.paint));
    repaint(this.bodyMesh, next);
    this.paint = next;
  }

  /** Physics-side update for dynamic vehicles (call every fixed step). */
  step(dt) {
    if (!this.vc) return;
    // parked cars at rest need no suspension raycasts
    if (this.mode === 'parked' && this.body.isSleeping()) return;
    this.vc.updateVehicle(dt);
    this.impactCooldown = Math.max(0, this.impactCooldown - dt);
    const v = this.body.linvel();
    const dvx = v.x - this.prevVel.x,
      dvy = v.y - this.prevVel.y,
      dvz = v.z - this.prevVel.z;
    // ignore gravity-scale vertical changes; a crash is a sudden horizontal velocity change
    const impact = Math.hypot(dvx, dvz) + Math.max(0, Math.abs(dvy) - 2) * 0.5;
    if (impact > 4) this.onImpact(impact);
    this.prevVel = { x: v.x, y: v.y, z: v.z };
    const p = this.body.translation();
    if (p.y < WATER_Y + 0.4) {
      this.body.setLinvel({ x: v.x * (1 - dt * 1.5), y: Math.max(v.y, -1.5), z: v.z * (1 - dt * 1.5) }, true);
      this.sinkT += dt;
    } else this.sinkT = 0;
  }

  /** Visual sync: transforms, wheels, lights. */
  sync(dt, camPos, night, isPlayerCar) {
    const p = this.body.translation(),
      r = this.body.rotation();
    const visible = Math.hypot(p.x - camPos.x, p.z - camPos.z) < QUALITY[ctx.quality].carDistance || isPlayerCar;
    this.mesh.visible = visible;
    if (this.mode !== 'ai') {
      _v.set(0, 0, 1).applyQuaternion(_q.set(r.x, r.y, r.z, r.w));
      this.yaw = Math.atan2(_v.x, _v.z);
    }
    if (!visible) return;
    this.mesh.position.set(p.x, p.y, p.z);
    this.mesh.quaternion.set(r.x, r.y, r.z, r.w);
    const L = this.lights;
    const t = ctx.simTime;
    if (L.headlight) L.headlight.emissiveIntensity = this.dead ? 0 : 0.15 + night * 3.0 + (isPlayerCar ? 0.3 : 0);
    if (L.taillight) L.taillight.emissiveIntensity = this.braking ? 2.6 : 0.25 + night * 0.9;
    const blink = Math.sin(t * 9) > 0 ? 3 : 0;
    if (L.indicator_L) L.indicator_L.emissiveIntensity = this.indicator === -1 || this.indicator === 2 ? blink : 0;
    if (L.indicator_R) L.indicator_R.emissiveIntensity = this.indicator === 1 || this.indicator === 2 ? blink : 0;
    if (L.siren) {
      L.siren.emissiveIntensity = this.siren ? (Math.sin(t * 22) > 0 ? 5 : 0.2) : 0.3;
      const sc = this.ud.sirenColors || SIREN_BLUE;
      L.siren.emissive.setHex(this.siren && Math.sin(t * 11) <= 0 ? sc[1] : sc[0]);
    }
    if (L.taxi_sign) L.taxi_sign.emissiveIntensity = 0.4 + night * 1.5;
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      if (this.vc) {
        w.position.y = this.H0 - (this.vc.wheelSuspensionLength(i) ?? SUSPENSION);
        w.rotation.y = this.vc.wheelSteering(i) || 0;
        w.rotation.x = this.vc.wheelRotation(i) || 0;
      } else {
        w.position.y = this.ud.wheelRadius;
        w.rotation.y = 0;
        w.rotation.x = this.wheelSpin;
      }
    }
    if (this.spot) {
      // the shared headlight stays a direct child of the scene (see sharedHeadlight) and follows the car
      const spot = this.spot;
      spot.intensity = isPlayerCar && !this.dead ? night * 60 : 0;
      if (isPlayerCar) {
        this.mesh.updateMatrixWorld();
        this.mesh.localToWorld(spot.position.set(0, 0, this.length / 2));
        this.mesh.localToWorld(spot.target.position.set(0, -0.8, this.length / 2 + 12));
        spot.target.updateMatrixWorld();
      }
    }
    this.driver?.update(dt);
    // damage smoke from the bonnet
    if (this.health < MAX_HEALTH * 0.45) {
      this.smokeT -= dt;
      const rate = this.dead ? 0.05 : this.health < MAX_HEALTH * 0.2 ? 0.1 : 0.22;
      if (this.smokeT <= 0) {
        this.smokeT = rate;
        _v.set(0, this.ud.height * 0.6, this.length / 2 - 0.8).applyQuaternion(this.mesh.quaternion);
        ctx.vehicles.smoke.emit(p.x + _v.x, p.y + _v.y, p.z + _v.z, this.health < MAX_HEALTH * 0.2 ? 1 : 0.3);
      }
    }
  }

  /** Headlight spot (only the player's car gets one). */
  /**
   * Moves the single shared headlight spot onto this car. One spot exists for the whole game
   * (created at startup): adding a new light later would make every material recompile.
   */
  ensureSpotlight() {
    if (this.spot) return;
    const spot = sharedHeadlight();
    if (spot.owner && spot.owner !== this) spot.owner.spot = null;
    spot.owner = this;
    this.spot = spot;
  }

  destroy() {
    if (this.spot) {
      // release the shared headlight (it stays in the scene, switched off)
      this.spot.intensity = 0;
      this.spot.owner = null;
      this.spot = null;
    }
    // the controller references the body, so it must go first
    if (this.vc) ctx.world.removeVehicleController(this.vc);
    ctx.world.removeRigidBody(this.body);
    this.destroyed = true;
    ctx.scene.remove(this.mesh);
    for (const m of this.materials) m.dispose();
    this.plateTex?.dispose();
    if (this.driver) ctx.peds?.reclaim(this.takeDriver());
  }
}

let headlight = null;
/**
 * The player's single headlight spot. It is always a direct, visible child of the scene:
 * if a light ever stops being counted (removed, or inside a hidden car), every material
 * in the city recompiles at once, which froze the game for seconds on integrated GPUs.
 */
export function sharedHeadlight() {
  if (!headlight) {
    headlight = new THREE.SpotLight(0xfff0d8, 0, 70, 0.55, 0.5, 1.2);
    headlight.position.set(0, -50, 0);
    ctx.scene.add(headlight, headlight.target);
  }
  return headlight;
}

export class VehicleManager {
  constructor() {
    this.list = [];
    this.smoke = new SmokeSystem();
    this.grid = new SpatialGrid(30);
  }
  spawn(kind, x, z, yaw, mode = 'parked', opts) {
    const car = new Vehicle(kind, x, z, yaw, mode, opts);
    this.list.push(car);
    return car;
  }
  remove(car) {
    const i = this.list.indexOf(car);
    if (i >= 0) this.list.splice(i, 1);
    car.destroy();
    // the grid is rebuilt once per frame; drop the removed car now so nothing touches its freed body
    this.index();
  }
  nearest(p, max = 4.5, filter = null) {
    let best = null,
      bd = max;
    for (const c of this.list) {
      if (!c.drivable || (filter && !filter(c))) continue;
      const q = c.body.translation();
      const d = Math.hypot(q.x - p.x, q.z - p.z);
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
    return best;
  }
  /** Rebuilds the spatial grid used by AI look-ahead (call once per frame). */
  index() {
    this.grid.map.clear();
    for (const c of this.list) {
      const p = c.body.translation();
      this.grid.insert(p.x, p.z, c);
    }
  }
  step(dt) {
    for (const c of this.list) c.step(dt);
  }
  sync(dt, camPos, night, playerCar) {
    for (const c of this.list) c.sync(dt, camPos, night, c === playerCar);
    this.smoke.update(dt);
  }
}
