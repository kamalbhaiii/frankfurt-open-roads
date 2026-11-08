/**
 * Police response: pursuit cars that route through the street network to the player,
 * ram and box in, and officers who get out and chase on foot to make an arrest.
 */
import * as THREE from 'three';
import { ctx } from '../core/context.js';
import { rnd, clamp, wrapAngle, lerp } from '../core/math.js';
import { events } from '../core/events.js';
import { policeOfficer } from './characters.js';

const _v = new THREE.Vector3(),
  _q = new THREE.Quaternion();
const ARREST_TIME_FOOT = 1.4;
const ARREST_TIME_CAR = 3;

export class Police {
  constructor() {
    this.units = [];
    this.spawnTimer = 0;
    this.arrestProgress = 0;
  }

  get seesPlayer() {
    return this.units.some((u) => u.sees);
  }

  /** Police presence near a point (used to decide whether a crime was witnessed). */
  nearby(x, z, r = 110) {
    for (const c of ctx.vehicles.list) {
      if (!c.isPolice) continue;
      const p = c.body.translation();
      if (Math.hypot(p.x - x, p.z - z) < r) return true;
    }
    return this.units.some((u) => u.officer && Math.hypot(u.officer.x - x, u.officer.z - z) < r * 0.6);
  }

  spawnUnit(focus) {
    const roads = ctx.roads;
    for (let t = 0; t < 14; t++) {
      const a = rnd() * Math.PI * 2,
        r = lerp(110, 220, rnd());
      const hit = roads.nearest(focus.x + Math.cos(a) * r, focus.z + Math.sin(a) * r, 60, (e) => e.speed >= 8);
      if (!hit || ctx.traffic.inView(hit.x, hit.z) || ctx.traffic.occupied(hit.x, hit.z, 10)) continue;
      const pts = hit.edge.pts,
        q = pts[hit.seg + 1],
        p = pts[hit.seg];
      const yaw = Math.atan2(q[0] - p[0], q[1] - p[1]);
      const car = ctx.vehicles.spawn('police', hit.x, hit.z, yaw, 'pursuit', { driver: false });
      car.setDriver(policeOfficer());
      return this.engage(car);
    }
    return null;
  }

  engage(car) {
    if (car.mode === 'ai') car.makeDynamic('pursuit');
    car.mode = 'pursuit';
    car.siren = true;
    car.persistent = true;
    const unit = { car, route: null, routeT: 0, stuck: 0, reverse: 0, flipped: 0, officer: null, sees: false, leaving: false, leaveT: 0 };
    this.units.push(unit);
    return unit;
  }

  disengageAll() {
    for (const u of this.units) {
      u.leaving = true;
      u.leaveT = 0;
      u.car.siren = false;
      if (u.officer) this.returnOfficer(u);
    }
    this.arrestProgress = 0;
  }

  removeUnit(u) {
    if (u.officer) this.returnOfficer(u);
    this.units.splice(this.units.indexOf(u), 1);
    if (ctx.vehicles.list.includes(u.car)) ctx.vehicles.remove(u.car);
  }

  returnOfficer(u) {
    const o = u.officer;
    u.officer = null;
    if (!ctx.vehicles.list.includes(u.car)) {
      ctx.peds.reclaim(o.ch);
      return;
    }
    o.ch.detach();
    u.car.setDriver(o.ch);
  }

  update(dt) {
    const wanted = ctx.wanted;
    const player = ctx.player;
    const focus = player.position;

    // escalate: recruit nearby patrol cars, spawn more units
    if (wanted.level > 0) {
      for (const c of ctx.vehicles.list) {
        if (c.isPolice && c.mode === 'ai' && this.units.length < wanted.desiredUnits + 1) {
          const p = c.body.translation();
          if (Math.hypot(p.x - focus.x, p.z - focus.z) < 90) this.engage(c);
        }
      }
      this.spawnTimer -= dt;
      const active = this.units.filter((u) => !u.leaving).length;
      if (active < wanted.desiredUnits && this.spawnTimer <= 0) {
        this.spawnTimer = 4;
        this.spawnUnit(focus);
      }
    } else if (this.units.some((u) => !u.leaving)) this.disengageAll();

    let closeForArrest = false;
    const searchR = wanted.searchRadius;
    const eye = { x: focus.x, y: focus.y + 1.5, z: focus.z };
    for (const u of this.units.slice()) {
      const car = u.car;
      if (!ctx.vehicles.list.includes(car) || car === player.vehicle) {
        // destroyed, despawned or stolen by the player
        if (car === player.vehicle) car.siren = false;
        this.units.splice(this.units.indexOf(u), 1);
        if (u.officer) ctx.peds.reclaim(u.officer.ch);
        continue;
      }
      const p = car.body.translation();
      const dist = Math.hypot(p.x - focus.x, p.z - focus.z);
      // wrecked units drop out (out of sight) so a fresh unit can be sent
      if (car.dead && !u.leaving) {
        u.deadT = (u.deadT || 0) + dt;
        if (u.officer) this.updateOfficer(u, dt);
        else car.idle();
        if (u.deadT > 4 && (dist > 60 || !ctx.traffic.inView(p.x, p.z))) {
          car.siren = false;
          car.persistent = false;
          if (u.officer) this.returnOfficer(u);
          this.units.splice(this.units.indexOf(u), 1);
        }
        continue;
      }
      if (u.leaving) {
        u.leaveT += dt;
        this.driveTo(u, p.x + Math.sin(car.yaw) * 60, p.z + Math.cos(car.yaw) * 60, 40, dt);
        if ((dist > 160 && !ctx.traffic.inView(p.x, p.z)) || u.leaveT > 40) this.removeUnit(u);
        continue;
      }
      // can this unit see the player?
      const from = u.officer ? { x: u.officer.x, y: 1.6, z: u.officer.z } : { x: p.x, y: p.y + 1.4, z: p.z };
      const d = Math.hypot(from.x - focus.x, from.z - focus.z);
      u.sees = d < searchR && (d < 35 || ctx.physics.lineOfSight(from, eye));
      if (dist > 600) {
        this.removeUnit(u);
        continue;
      }

      if (u.officer) {
        this.updateOfficer(u, dt);
        if (Math.hypot(u.officer.x - focus.x, u.officer.z - focus.z) < 1.8 && !player.vehicle) closeForArrest = true;
        car.idle();
        continue;
      }
      // pursuit driving
      const pv = player.vehicle ? player.vehicle.body.linvel() : { x: 0, z: 0 };
      let tx = focus.x + pv.x * 0.6,
        tz = focus.z + pv.z * 0.6;
      if (dist > 45) {
        u.routeT -= dt;
        if (u.routeT <= 0 || !u.route) {
          u.routeT = 1.5;
          u.route = ctx.roads.route(p.x, p.z, focus.x, focus.z, false);
        }
        // short lookahead keeps the car on the carriageway instead of cutting across pavements
        const look = this.lookahead(u.route, p, 6 + Math.abs(car.kmh) * 0.08);
        const far = this.lookahead(u.route, p, 28 + Math.abs(car.kmh) * 0.2);
        if (look && far) {
          const turn = Math.abs(wrapAngle(Math.atan2(far[0] - look[0], far[1] - look[1]) - car.yaw));
          u.cornerKmh = 120 - 85 * clamp(turn / 1.2, 0, 1);
        } else u.cornerKmh = 120;
        if (look) {
          tx = look[0];
          tz = look[1];
        }
      }
      const playerSlow = player.vehicle ? Math.abs(player.vehicle.kmh) < 6 : true;
      // drive only a little faster than the player: flat-out city pursuits end in wrecks
      const playerKmh = player.vehicle ? Math.abs(player.vehicle.kmh || 0) : 0;
      const maxKmh = dist < 20 && playerSlow ? 10 : Math.min(u.cornerKmh ?? 120, Math.max(65, playerKmh + 25));
      this.driveTo(u, tx, tz, maxKmh, dt);
      if (player.vehicle && dist < 7 && playerSlow) closeForArrest = true;
      // on foot and close: officer gets out
      if (!player.vehicle && dist < 22 && Math.abs(car.kmh) < 12 && !player.swim) this.deployOfficer(u);
    }

    // arrest progress
    if (closeForArrest && !player.dead && wanted.level > 0) {
      this.arrestProgress += dt;
      const need = player.vehicle ? ARREST_TIME_CAR : ARREST_TIME_FOOT;
      if (this.arrestProgress >= need) {
        this.arrestProgress = 0;
        events.emit('player:arrested', {});
      }
    } else this.arrestProgress = Math.max(0, this.arrestProgress - dt * 2);
  }

  lookahead(route, p, dist) {
    if (!route || route.points.length < 2) return null;
    const pts = route.points;
    let best = 0,
      bd = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const d = Math.hypot(pts[i][0] - p.x, pts[i][1] - p.z);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    let acc = 0;
    for (let i = best; i < pts.length - 1; i++) {
      acc += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
      if (acc >= dist) return pts[i + 1];
    }
    return pts[pts.length - 1];
  }

  /** Simple steering controller for police cars. */
  driveTo(u, tx, tz, maxKmh, dt) {
    const car = u.car;
    if (car.dead) {
      car.idle();
      return;
    }
    const p = car.body.translation();
    const want = Math.atan2(tx - p.x, tz - p.z);
    const err = wrapAngle(want - car.yaw);
    // flipped?
    const r = car.body.rotation();
    _v.set(0, 1, 0).applyQuaternion(_q.set(r.x, r.y, r.z, r.w));
    if (_v.y < 0.4) {
      u.flipped += dt;
      if (u.flipped > 2.5) {
        u.flipped = 0;
        _q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), car.yaw);
        car.body.setTranslation({ x: p.x, y: p.y + 1.2, z: p.z }, true);
        car.body.setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w }, true);
        car.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      }
    } else u.flipped = 0;
    const kmh = car.kmh || 0;
    if (u.reverse > 0) {
      u.reverse -= dt;
      car.drive(-1, err > 0 ? 1 : -1, false, dt);
      return;
    }
    let throttle = clamp(1 - Math.abs(err) * 0.6, 0.25, 1);
    if (Math.abs(kmh) > maxKmh) throttle = -0.6;
    // positive err = target to the left; drive() expects positive = right
    const steer = clamp(-err * 2.2, -1, 1);
    car.drive(throttle, steer, Math.abs(err) > 1.4 && Math.abs(kmh) > 35, dt);
    if (Math.abs(kmh) < 3 && throttle > 0) {
      u.stuck += dt;
      if (u.stuck > 2) {
        u.stuck = 0;
        u.reverse = 1.4;
      }
    } else u.stuck = 0;
  }

  deployOfficer(u) {
    if (u.officer || !u.car.driver) return;
    const ch = u.car.takeDriver();
    const door = u.car.doorPosition(1);
    ctx.scene.add(ch.root);
    u.officer = { ch, x: door.x, z: door.z, y: 0, yaw: u.car.yaw, groundT: 0 };
  }

  updateOfficer(u, dt) {
    const o = u.officer;
    const player = ctx.player;
    const target = player.position;
    const d = Math.hypot(target.x - o.x, target.z - o.z);
    // player drove off: back to the car
    if (player.vehicle && d > 15) {
      const cp = u.car.body.translation();
      const dc = Math.hypot(cp.x - o.x, cp.z - o.z);
      if (dc < 2) {
        this.returnOfficer(u);
        return;
      }
      this.moveOfficer(o, cp.x, cp.z, 6, dt);
      return;
    }
    if (d > 1.3) this.moveOfficer(o, target.x, target.z, 6.2, dt);
    else {
      o.ch.play('idle', 0.2);
      o.ch.update(dt);
    }
  }

  moveOfficer(o, tx, tz, speed, dt) {
    const want = Math.atan2(tx - o.x, tz - o.z);
    o.yaw += wrapAngle(want - o.yaw) * clamp(dt * 8, 0, 1);
    o.x += Math.sin(o.yaw) * speed * dt;
    o.z += Math.cos(o.yaw) * speed * dt;
    o.groundT -= dt;
    if (o.groundT <= 0) {
      o.y = ctx.physics.groundY(o.x, o.z);
      o.groundT = 0.25;
    }
    o.ch.root.position.set(o.x, o.y, o.z);
    o.ch.root.rotation.y = o.yaw;
    o.ch.play('run', 0.2, speed / 6);
    o.ch.update(dt);
  }

  /** Removes every unit immediately (respawn after arrest/hospital). */
  reset() {
    for (const u of this.units.slice()) this.removeUnit(u);
    this.arrestProgress = 0;
  }
}
