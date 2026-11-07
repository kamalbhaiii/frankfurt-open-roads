/**
 * The player: on-foot character controller (walk, sprint, jump, swim, climb out),
 * entering/exiting/carjacking vehicles, health and money.
 */
import * as THREE from 'three';
import { ctx } from '../core/context.js';
import { WATER_Y, ECONOMY } from '../core/config.js';
import { clamp, lerp, pip, wrapAngle } from '../core/math.js';
import { input } from '../core/input.js';
import { events } from '../core/events.js';
import { Character, PLAYER_COLORS } from './characters.js';

const _v = new THREE.Vector3(),
  _q = new THREE.Quaternion();
export const MAX_HEALTH = 100;
export const MAX_ARMOR = 100;

export class Player {
  constructor() {
    this.health = MAX_HEALTH;
    this.armor = 0;
    this.money = ECONOMY.startMoney;
    this.vehicle = null;
    this.lastCar = null;
    this.yaw = 0;
    this.vy = 0;
    this.grounded = false;
    this.swim = false;
    this.air = 0;
    this.knockdown = 0;
    this.regenDelay = 0;
    this.speed = 0;
    this.prompt = '';
  }

  create(x, z, yaw) {
    const { RAPIER, world, scene } = ctx;
    this.body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(x, 1.0, z));
    this.collider = world.createCollider(RAPIER.ColliderDesc.capsule(0.55, 0.32).setFriction(0.5), this.body);
    const cc = (this.cc = world.createCharacterController(0.04));
    cc.enableAutostep(0.45, 0.2, false);
    cc.enableSnapToGround(0.4);
    cc.setMaxSlopeClimbAngle((50 * Math.PI) / 180);
    cc.setApplyImpulsesToDynamicBodies(true);
    cc.setCharacterMass(80);
    this.ch = new Character('character_male', PLAYER_COLORS);
    scene.add(this.ch.root);
    this.yaw = yaw;
  }

  get position() {
    return this.vehicle ? this.vehicle.body.translation() : this.body.translation();
  }
  get dead() {
    return this.health <= 0;
  }

  addMoney(amount, reason = '') {
    this.money = Math.max(0, this.money + amount);
    if (amount > 0) ctx.stats.add('moneyEarned', amount);
    events.emit('money', { amount, reason });
  }

  damage(amount, source = '') {
    if (this.dead || ctx.game?.cutscene) return;
    let a = amount;
    if (this.armor > 0) {
      const absorbed = Math.min(this.armor, a * 0.7);
      this.armor -= absorbed;
      a -= absorbed;
    }
    this.health = Math.max(0, this.health - a);
    this.regenDelay = 8;
    events.emit('player:damage', { amount, source });
    if (this.health <= 0) events.emit('player:died', { source });
  }

  heal(amount) {
    this.health = Math.min(MAX_HEALTH, this.health + amount);
  }

  /** Moves the player (on foot) to a position. */
  teleport(x, z, yaw = this.yaw, y = 1.2) {
    if (this.vehicle) this.exitVehicle(true);
    this.body.setTranslation({ x, y, z }, true);
    this.body.setNextKinematicTranslation({ x, y, z });
    this.vy = 0;
    this.yaw = yaw;
    this.ch.root.position.set(x, y - 0.87, z);
  }

  /** Fixed-step update while on foot. */
  stepOnFoot(dt) {
    const p = this.body.translation();
    if (this.knockdown > 0) {
      this.knockdown -= dt;
      this.vy -= 22 * dt;
      this.cc.computeColliderMovement(this.collider, { x: this.kx * dt, y: this.vy * dt, z: this.kz * dt });
      const m = this.cc.computedMovement();
      this.kx *= 0.94;
      this.kz *= 0.94;
      if (this.cc.computedGrounded() && this.vy < 0) this.vy = 0;
      this.body.setNextKinematicTranslation({ x: p.x + m.x, y: p.y + m.y, z: p.z + m.z });
      this.ch.root.position.set(p.x + m.x, p.y + m.y - 0.87, p.z + m.z);
      this.ch.play('fall', 0.1);
      return;
    }
    const { f, r } = ctx.game.controlsLocked ? { f: 0, r: 0 } : input.axes();
    const run = input.down('sprint');
    const camYaw = ctx.cameraRig.yaw;
    const fx = -Math.sin(camYaw),
      fz = -Math.cos(camYaw);
    let mx = fx * f + -fz * r,
      mz = fz * f + fx * r;
    const ml = Math.hypot(mx, mz);
    if (ml > 1) {
      mx /= ml;
      mz /= ml;
    }
    const inRiver = p.y < -0.5 && ctx.riverRings.some((rr) => pip(p.x, p.z, rr));
    this.swim = inRiver && p.y < WATER_Y + 0.4;
    const speed = this.swim ? 2.2 : run ? 7.5 : 3.6;
    if (this.swim) {
      this.vy = lerp(this.vy, (WATER_Y - 0.55 - p.y) * 3, clamp(dt * 4, 0, 1));
      if (input.down('jump')) {
        // climb out onto the quay wall
        const dir = { x: mx || fx, y: 0, z: mz || fz };
        const dl = Math.hypot(dir.x, dir.z) || 1;
        dir.x /= dl;
        dir.z /= dl;
        const hit = ctx.world.castRay(new ctx.RAPIER.Ray({ x: p.x, y: p.y, z: p.z }, dir), 2.5, true, undefined, undefined, this.collider);
        if (hit) {
          const d2 = hit.timeOfImpact + 1.0;
          this.body.setTranslation({ x: p.x + dir.x * d2, y: 1.3, z: p.z + dir.z * d2 }, true);
          this.vy = 0;
          events.emit('notify', { text: 'Climbed out' });
          return;
        }
      }
    } else {
      this.vy -= 22 * dt;
      if (this.grounded) {
        this.vy = Math.max(this.vy, -2);
        if (input.down('jump') && !ctx.game.controlsLocked) this.vy = 7.2;
      }
    }
    const desired = { x: mx * speed * dt, y: this.vy * dt, z: mz * speed * dt };
    this.cc.computeColliderMovement(this.collider, desired);
    const m = this.cc.computedMovement();
    const wasGrounded = this.grounded;
    this.grounded = this.cc.computedGrounded();
    if (this.grounded && !wasGrounded && this.vy < -14) this.damage((-this.vy - 14) * 7, 'fall');
    if (this.grounded && this.vy < 0) this.vy = 0;
    if (!this.grounded && desired.y > 0 && m.y < desired.y * 0.5) this.vy = 0;
    this.body.setNextKinematicTranslation({ x: p.x + m.x, y: p.y + m.y, z: p.z + m.z });
    if (ml > 0.05) this.yaw += wrapAngle(Math.atan2(mx, mz) - this.yaw) * clamp(dt * 12, 0, 1);
    const hs = Math.hypot(m.x, m.z) / Math.max(dt, 1e-4);
    this.speed = hs;
    this.air = this.grounded ? 0 : this.air + dt;
    this.ch.root.position.set(p.x + m.x, this.swim ? WATER_Y - 0.95 : p.y + m.y - 0.87, p.z + m.z);
    this.ch.root.rotation.y = this.yaw;
    if (this.swim) this.ch.play('swim', 0.3);
    else if (this.air > 0.18) this.ch.play('jump', 0.15);
    else if (hs > 4.5) this.ch.play('run', 0.2, hs / 6.5);
    else if (hs > 0.3) this.ch.play('walk', 0.2, hs / 1.5);
    else this.ch.play('idle', 0.3);
    ctx.stats.add('distanceWalked', hs * dt);
  }

  /** Fixed-step update while driving. */
  stepDriving(dt) {
    const car = this.vehicle;
    const { f, r } = ctx.game.controlsLocked ? { f: 0, r: 0 } : input.axes();
    car.drive(f, r, input.down('jump') && !ctx.game.controlsLocked, dt);
    const p = car.body.translation();
    // keep the (hidden) on-foot body near the car so it never blocks traffic
    this.body.setNextKinematicTranslation({ x: p.x, y: p.y + 3, z: p.z });
    const kmh = Math.abs(car.kmh);
    ctx.stats.add('distanceDriven', (kmh / 3.6) * dt);
    ctx.stats.max('topSpeed', kmh);
    if (car.sinkT > 2.5) {
      this.exitVehicle(true);
      events.emit('notify', { text: 'Your car sank in the Main!', ms: 2500 });
    }
  }

  step(dt) {
    if (this.dead && this.knockdown <= 0) return;
    if (this.vehicle) this.stepDriving(dt);
    else this.stepOnFoot(dt);
  }

  /** Per-frame: animations, health regen, being hit by cars, interaction prompt. */
  update(dt) {
    if (!this.vehicle) this.ch.update(dt);
    if (this.dead) return;
    this.regenDelay -= dt;
    if (this.regenDelay <= 0 && this.health < MAX_HEALTH * 0.5) this.heal(dt * 2);
    if (!this.vehicle && this.knockdown <= 0) this.checkHitByCars();
    this.prompt = '';
    if (!this.vehicle) {
      const c = this.nearestEnterable();
      if (c) this.prompt = `${input.isTouch ? 'Tap 🚗' : 'Press F'} to ${c.mode === 'ai' ? 'carjack' : 'enter'} the ${c.label}`;
      if (this.swim) this.prompt = input.isTouch ? 'Swim to the quay wall and tap Jump to climb out' : 'Swim to the quay wall and press Space to climb out';
    }
  }

  checkHitByCars() {
    const p = this.body.translation();
    for (const car of ctx.vehicles.grid.query(p.x, p.z, 6)) {
      const c = car.body.translation();
      if (Math.abs(c.y - p.y) > 2.5) continue;
      // distance in the car's frame
      const dx = p.x - c.x,
        dz = p.z - c.z;
      const cs = Math.cos(car.yaw),
        sn = Math.sin(car.yaw);
      const lx = dx * cs - dz * sn,
        lz = dx * sn + dz * cs;
      if (Math.abs(lx) > car.width / 2 + 0.35 || Math.abs(lz) > car.length / 2 + 0.35) continue;
      const v = car.mode === 'ai' ? { x: Math.sin(car.yaw) * car.speed, z: Math.cos(car.yaw) * car.speed } : car.body.linvel();
      const sp = Math.hypot(v.x, v.z);
      if (sp < 4) continue;
      this.knockdown = 1.6;
      this.vy = 3 + sp * 0.2;
      this.kx = v.x * 0.7;
      this.kz = v.z * 0.7;
      this.damage(sp * 2.6, 'vehicle');
      return;
    }
  }

  nearestEnterable() {
    const p = this.body.translation();
    return ctx.vehicles.nearest(p, 4.5, (c) => !c.dead || c.mode !== 'ai');
  }

  /** Enter the nearest vehicle, pulling out any driver. */
  enterVehicle(car = this.nearestEnterable()) {
    if (!car || this.vehicle || this.swim || this.knockdown > 0) return false;
    const wasAi = car.mode === 'ai' || car.mode === 'pursuit';
    if (wasAi) car.makeDynamic('player');
    if (car.driver) {
      const ch = car.takeDriver();
      const door = car.doorPosition(1);
      ctx.peds.addFleeing(ch, door.x, door.z, car.yaw + Math.PI / 2);
      ctx.peds.scare(door.x, door.z, 15);
      ctx.stats.add('carsStolen', 1);
      events.emit('crime', { type: car.isPolice ? 'stealPolice' : 'carjack', x: door.x, z: door.z });
    } else if (car.isPolice && car !== this.lastCar) {
      events.emit('crime', { type: 'stealPolice', x: car.position.x, z: car.position.z });
    }
    car.mode = 'player';
    car.persistent = true;
    car.lastTouched = ctx.simTime;
    car.body.wakeUp();
    car.ensureSpotlight();
    if (this.lastCar && this.lastCar !== car && this.lastCar.mode === 'parked') this.lastCar.persistent = false;
    this.vehicle = this.lastCar = car;
    ctx.scene.remove(this.ch.root);
    car.model.add(this.ch.root);
    this.ch.root.position.set(0.38, car.ud.seatY + 0.2 - 0.98, car.ud.seatZ - 0.05);
    this.ch.root.rotation.set(0, 0, 0);
    this.ch.play('sit', 0.1);
    events.emit('vehicle:enter', { car });
    return true;
  }

  /** Leave the vehicle on the driver's side (or the other side if blocked). */
  exitVehicle(force = false) {
    const car = this.vehicle;
    if (!car) return;
    const kmh = Math.abs(car.kmh || 0);
    if (!force && kmh > 25) return; // GTA-style: slow down before getting out
    const p = car.body.translation(),
      r = car.body.rotation();
    _q.set(r.x, r.y, r.z, r.w);
    const side = _v
      .set(1, 0, 0)
      .applyQuaternion(_q)
      .multiplyScalar(car.width / 2 + 0.9);
    let ex = p.x + side.x,
      ez = p.z + side.z;
    const len = side.length();
    const hit = ctx.world.castRay(
      new ctx.RAPIER.Ray({ x: p.x, y: p.y + 0.3, z: p.z }, { x: side.x / len, y: 0, z: side.z / len }),
      len + 0.4,
      true,
      undefined,
      undefined,
      car.collider,
    );
    if (hit) {
      ex = p.x - side.x;
      ez = p.z - side.z;
    }
    this.body.setTranslation({ x: ex, y: Math.max(p.y, WATER_Y) + 0.5, z: ez }, true);
    this.vy = 0;
    car.model.remove(this.ch.root);
    ctx.scene.add(this.ch.root);
    this.yaw = car.yaw;
    this.vehicle = null;
    car.mode = 'parked';
    car.siren = false;
    car.indicator = 0;
    car.idle();
    if (car.spot) car.spot.intensity = 0;
    events.emit('vehicle:exit', { car });
  }

  /** Flips the car upright or moves the player out of the river. */
  unstuck() {
    if (this.vehicle) {
      const car = this.vehicle;
      const p = car.body.translation();
      if (p.y < -1) {
        const hit = ctx.roads.nearest(p.x, p.z, 400);
        if (hit) car.body.setTranslation({ x: hit.x, y: 1.4, z: hit.z }, true);
      } else car.body.setTranslation({ x: p.x, y: p.y + 1.2, z: p.z }, true);
      _q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), car.yaw);
      car.body.setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w }, true);
      car.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      car.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      car.sinkT = 0;
      events.emit('notify', { text: 'Vehicle reset' });
    } else {
      const p = this.body.translation();
      if (this.swim || p.y < -1) {
        const hit = ctx.roads.nearest(p.x, p.z, 400);
        if (hit) {
          const off = hit.edge.width / 2 + 1.6;
          const pts = hit.edge.pts,
            q = pts[hit.seg + 1],
            a = pts[hit.seg];
          const L = Math.hypot(q[0] - a[0], q[1] - a[1]) || 1;
          this.teleport(hit.x - ((q[1] - a[1]) / L) * off, hit.z + ((q[0] - a[0]) / L) * off);
          events.emit('notify', { text: 'Back on dry land' });
        }
      }
    }
  }
}
