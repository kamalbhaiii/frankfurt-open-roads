/**
 * Third-person camera with selectable distances, a hood/first-person view in cars,
 * look-behind, auto-centring behind vehicles, speed FOV kick and wall collision.
 */
import * as THREE from 'three';
import { ctx } from '../core/context.js';
import { WATER_Y } from '../core/config.js';
import { clamp, lerp, wrapAngle, damp } from '../core/math.js';
import { input } from '../core/input.js';
import { settings } from '../core/settings.js';

const FOOT_DIST = [3.6, 6, 9];
const CAR_DIST = [6.5, 9, 13, 0]; // 0 = first person
const _dir = new THREE.Vector3(),
  _tgt = new THREE.Vector3();

export class CameraRig {
  constructor() {
    this.yaw = Math.PI;
    this.pitch = 0.25;
    this.footMode = 1;
    this.carMode = 1;
    this.zoom = 0;
    this.target = new THREE.Vector3();
    this.pos = new THREE.Vector3();
    this.shake = 0;
    this.orbit = null; // cinematic orbit (death/arrest)
  }

  cycle() {
    if (ctx.player.vehicle) this.carMode = (this.carMode + 1) % CAR_DIST.length;
    else this.footMode = (this.footMode + 1) % FOOT_DIST.length;
  }

  /** Slow orbit around a point (death/arrest screens). */
  startOrbit(p) {
    this.orbit = { x: p.x, y: p.y, z: p.z, a: this.yaw };
  }
  stopOrbit() {
    this.orbit = null;
  }

  update(dt) {
    const camera = ctx.camera;
    const player = ctx.player;
    const look = input.takeLook();
    this.zoom = clamp(this.zoom + input.takeWheel() * 0.01, -2, 10);
    this.yaw -= look.x;
    this.pitch = clamp(this.pitch + look.y, -0.35, 1.2);

    if (this.orbit) {
      const o = this.orbit;
      o.a += dt * 0.25;
      camera.position.set(o.x + Math.sin(o.a) * 9, o.y + 4.5, o.z + Math.cos(o.a) * 9);
      camera.lookAt(o.x, o.y + 0.5, o.z);
      return;
    }

    const car = player.vehicle;
    let dist;
    if (car) {
      const p = car.body.translation();
      _tgt.set(p.x, p.y + 1.6, p.z);
      const mode = CAR_DIST[this.carMode];
      if (mode === 0) return this.firstPerson(car, dt);
      const idle = performance.now() - input.lastLookInput > 1500;
      if (idle && settings.get('autoCenterCamera')) {
        const want = car.yaw + Math.PI;
        const spd = Math.abs(car.kmh || 0);
        this.yaw += wrapAngle(want - this.yaw) * clamp(dt * (spd > 5 ? 2.5 : 0.6), 0, 1);
        this.pitch = lerp(this.pitch, 0.22, dt * 1.5);
      }
      dist = mode + this.zoom + clamp(Math.abs(car.kmh || 0) / 40, 0, 3);
    } else {
      const p = player.body.translation();
      _tgt.set(p.x, p.y + 0.9 - (player.swim ? 0.8 : 0), p.z);
      dist = Math.max(2, FOOT_DIST[this.footMode] + this.zoom);
    }
    if (this.target.lengthSq() === 0) this.target.copy(_tgt);
    this.target.lerp(_tgt, damp(14, dt));

    let yaw = this.yaw;
    if (input.down('lookBehind')) yaw += Math.PI;
    _dir.set(Math.sin(yaw) * Math.cos(this.pitch), Math.sin(this.pitch), Math.cos(yaw) * Math.cos(this.pitch));
    const exclude = car ? car.collider : player.collider;
    const hit = ctx.world.castRay(
      new ctx.RAPIER.Ray({ x: this.target.x, y: this.target.y, z: this.target.z }, { x: _dir.x, y: _dir.y, z: _dir.z }),
      dist,
      true,
      undefined,
      undefined,
      exclude,
    );
    const d = hit ? Math.max(1.2, hit.timeOfImpact - 0.3) : dist;
    this.pos.copy(this.target).addScaledVector(_dir, d);
    this.pos.y = Math.max(this.pos.y, player.swim ? WATER_Y + 0.4 : 0.4);
    camera.position.copy(this.pos);
    if (this.shake > 0) {
      this.shake = Math.max(0, this.shake - dt * 2);
      camera.position.x += (Math.random() - 0.5) * this.shake * 0.4;
      camera.position.y += (Math.random() - 0.5) * this.shake * 0.4;
    }
    camera.lookAt(this.target);
    this.applyFov(dt, car);
  }

  firstPerson(car, dt) {
    const camera = ctx.camera;
    const head = new THREE.Vector3(car.ud.seatX ?? 0.38, car.ud.seatY + 0.75 - car.H0, car.ud.seatZ - 0.15);
    car.mesh.localToWorld(head);
    camera.position.copy(head);
    const behind = input.down('lookBehind') ? Math.PI : 0;
    const yawOff = clamp(wrapAngle(this.yaw - (car.yaw + Math.PI)), -1.6, 1.6);
    const q = car.mesh.quaternion
      .clone()
      .multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(-this.pitch * 0.4 + 0.08, Math.PI + yawOff + behind, 0, 'YXZ')));
    camera.quaternion.copy(q);
    if (performance.now() - input.lastLookInput > 1500) this.yaw = lerp(this.yaw, car.yaw + Math.PI, damp(3, dt));
    this.applyFov(dt, car);
  }

  applyFov(dt, car) {
    const camera = ctx.camera;
    const base = settings.get('fov');
    const kick = car ? clamp((Math.abs(car.kmh || 0) - 60) / 120, 0, 1) * 10 : 0;
    const fov = lerp(camera.fov, base + kick, damp(4, dt));
    if (Math.abs(fov - camera.fov) > 0.01) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
  }

  /** Intro: slow orbit around the skyline behind the title menu. */
  intro(t, focus) {
    const a = t * 0.05 + 2.2,
      R = 650;
    ctx.camera.position.set(focus.x + Math.sin(a) * R, 230, focus.z + Math.cos(a) * R);
    ctx.camera.lookAt(focus.x, 90, focus.z);
  }
}
