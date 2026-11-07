/**
 * Rapier world with the static city collider (one trimesh), river bed, map
 * boundary walls, bridges and tree trunks.
 */
import * as THREE from 'three';
import { ctx } from '../core/context.js';
import { BED_Y } from '../core/config.js';

export class Physics {
  build(cityResult) {
    const { RAPIER } = ctx;
    const world = (ctx.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 }));
    const fixed = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const { physics, bridgeColliders, treeColliders } = cityResult;
    world.createCollider(RAPIER.ColliderDesc.trimesh(new Float32Array(physics.v), new Uint32Array(physics.i)).setFriction(0.8), fixed);
    physics.v = physics.i = null;
    world.createCollider(RAPIER.ColliderDesc.cuboid(5000, 1, 5000).setTranslation(0, BED_Y - 1, 0), fixed);
    for (const [x, z, hx, hz] of [
      [0, 3600, 3600, 1],
      [0, -3600, 3600, 1],
      [3600, 0, 1, 3600],
      [-3600, 0, 1, 3600],
    ]) {
      world.createCollider(RAPIER.ColliderDesc.cuboid(hx, 60, hz).setTranslation(x, 50, z), fixed);
    }
    const q = new THREE.Quaternion(),
      up = new THREE.Vector3(0, 1, 0);
    for (const b of bridgeColliders) {
      q.setFromAxisAngle(up, b.yaw);
      world.createCollider(RAPIER.ColliderDesc.cuboid(b.hx, b.hy, b.hz).setTranslation(b.x, b.y, b.z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }), fixed);
    }
    for (const [x, z, s] of treeColliders) world.createCollider(RAPIER.ColliderDesc.cylinder(2, 0.25 * s + 0.05).setTranslation(x, 2, z), fixed);
    this.ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  }

  /** Height of the static ground (pavement, road, bridge) at x/z. */
  groundY(x, z) {
    const { world, RAPIER } = ctx;
    this.ray.origin = { x, y: 2.5, z };
    this.ray.dir = { x: 0, y: -1, z: 0 };
    const h = world.castRay(this.ray, 4, true, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC | RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC);
    return h ? 2.5 - h.timeOfImpact : 0;
  }

  /** True if the straight line between two points is free of static geometry. */
  lineOfSight(a, b) {
    const { world, RAPIER } = ctx;
    const dx = b.x - a.x,
      dy = b.y - a.y,
      dz = b.z - a.z;
    const L = Math.hypot(dx, dy, dz);
    if (L < 0.1) return true;
    const ray = new RAPIER.Ray({ x: a.x, y: a.y, z: a.z }, { x: dx / L, y: dy / L, z: dz / L });
    const hit = world.castRay(ray, L, true, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC | RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC);
    return !hit;
  }

  step(dt) {
    ctx.world.timestep = dt;
    ctx.world.step();
  }
}
