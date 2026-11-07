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
import { recolor, randomPerson } from './characters.js';

const SUSPENSION = 0.32;
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
    this.model = src.clone(true);
    const fixedLivery = kind === 'taxi' || kind === 'police' || kind === 'van';
    this.paint = fixedLivery ? null : (paint ?? rnd.pick(CAR_PAINTS));
    const matCache = new Map();
    this.model.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.receiveShadow = false;
      const m = o.material;
      if (!matCache.has(m)) matCache.set(m, m.clone());
      o.material = matCache.get(m);
      if (m.name === 'body_vc') {
        this.bodyMesh = o;
        if (this.paint != null) recolor(o, { paint: ud.paint }, { paint: this.paint }, 0.05);
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
      vc.addWheel({ x: w.position.x, y: 0, z: w.position.z }, { x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }, SUSPENSION, this.ud.wheelRadius);
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
    ch.root.position.set(0.38, this.ud.seatY + 0.2 - 0.98, this.ud.seatZ - 0.05);
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
    const steerMax = lerp(0.6, 0.18, clamp(Math.abs(kmh) / 140, 0, 1));
    this.steer = lerp(this.steer, -steerInput * steerMax, clamp(dt * 7, 0, 1));
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
    const drag = 0.9 * Math.hypot(lv.x, lv.z);
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
    recolor(this.bodyMesh, { paint: this.paint }, { paint: next }, 0.05);
    this.paint = next;
  }

  /** Physics-side update for dynamic vehicles (call every fixed step). */
  step(dt) {
    if (!this.vc) return;
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
      if (this.siren) L.siren.emissive.setHex(Math.sin(t * 11) > 0 ? 0x2050ff : 0xff2020);
      else L.siren.emissive.setHex(0x2050ff);
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
    if (this.spot) this.spot.intensity = isPlayerCar && !this.dead ? night * 60 : 0;
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
  ensureSpotlight() {
    if (this.spot) return;
    this.spot = new THREE.SpotLight(0xfff0d8, 0, 70, 0.55, 0.5, 1.2);
    this.spot.position.set(0, 0, this.length / 2);
    this.spot.target.position.set(0, -0.8, this.length / 2 + 12);
    this.mesh.add(this.spot, this.spot.target);
  }

  destroy() {
    // the controller references the body, so it must go first
    if (this.vc) ctx.world.removeVehicleController(this.vc);
    ctx.world.removeRigidBody(this.body);
    this.destroyed = true;
    ctx.scene.remove(this.mesh);
    for (const m of this.materials) m.dispose();
    if (this.driver) ctx.peds?.reclaim(this.takeDriver());
  }
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
      if (filter && !filter(c)) continue;
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
