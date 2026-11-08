/**
 * Rapier world with the static city collider (one trimesh), river bed, map
 * boundary walls, bridges and tree trunks.
 *
 * Collider streaming: the city has ~20,000 small static colliders (lamps, poles, bins,
 * trees …). Keeping them all in the world made every physics step several times slower,
 * so only those within STREAM_RADIUS of the player exist; the rest are added/removed as
 * the player moves. Nothing far away can touch them anyway.
 */
import * as THREE from 'three';
import { ctx } from '../core/context.js';
import { BED_Y } from '../core/config.js';
import { SpatialGrid } from '../core/math.js';

const STREAM_RADIUS = 170;
const STREAM_KEEP = 210; // hysteresis so colliders don't flicker at the edge

export class Physics {
  constructor() {
    this.streamGrid = new SpatialGrid(60);
    this.streamActive = new Set();
    this.streamTimer = 0;
  }

  /**
   * Registers streamed colliders at (x, z). descs() returns fresh ColliderDescs (world space,
   * for a body at the origin); body is the fixed body they attach to. Returns an entry.
   */
  streamAdd(x, z, body, descs) {
    const e = { x, z, body, descs, cols: null, removed: false };
    this.streamGrid.insert(x, z, e);
    return e;
  }

  /** Removes a static collider for good, whether it is currently streamed in or not. */
  removeStatic(collider) {
    const e = this.entryByHandle?.get(collider.handle);
    if (e) this.streamRemove(e);
    else if (ctx.world.getCollider(collider.handle)) ctx.world.removeCollider(collider, false);
  }

  /** Permanently removes a streamed entry (e.g. a lamp that was knocked over). */
  streamRemove(e) {
    if (!e || e.removed) return;
    e.removed = true;
    this.deactivate(e);
  }

  activate(e) {
    if (e.cols || e.removed) return;
    e.cols = e.descs().map((d) => ctx.world.createCollider(d, e.body));
    this.streamActive.add(e);
  }
  deactivate(e) {
    if (!e.cols) return;
    for (const c of e.cols) ctx.world.removeCollider(c, false);
    e.cols = null;
    this.streamActive.delete(e);
  }

  /**
   * Moves every small static collider that exists so far into the stream
   * (call once after all static furniture was built).
   */
  streamStatics() {
    const { world, RAPIER } = ctx;
    const take = [];
    world.forEachCollider((c) => {
      const b = c.parent();
      if (!b || b.bodyType() !== RAPIER.RigidBodyType.Fixed) return;
      const sh = c.shape;
      let ext;
      if (sh.halfExtents) ext = Math.max(sh.halfExtents.x, sh.halfExtents.y, sh.halfExtents.z);
      else if (sh.halfHeight != null) ext = Math.max(sh.halfHeight, sh.radius);
      else if (sh.radius != null) ext = sh.radius;
      else return; // trimesh etc. stay
      if (ext > 8) return; // large pieces (bridges, river bed, walls) stay
      const t = b.translation();
      if (Math.abs(t.x) + Math.abs(t.y) + Math.abs(t.z) > 1e-3 || b.rotation().w < 0.9999) return; // only bodies at the origin
      take.push(c);
    });
    /** original collider handle -> stream entry (so owners can still remove "their" collider) */
    this.entryByHandle = new Map();
    for (const c of take) {
      const shape = c.shape,
        p = c.translation(),
        r = c.rotation(),
        fr = c.friction(),
        re = c.restitution(),
        body = c.parent();
      const e = this.streamAdd(p.x, p.z, body, () => [
        new RAPIER.ColliderDesc(shape).setTranslation(p.x, p.y, p.z).setRotation(r).setFriction(fr).setRestitution(re),
      ]);
      this.entryByHandle.set(c.handle, e);
      world.removeCollider(c, false);
    }
    this.streamed = take.length;
  }

  /** Adds colliders near the player and drops far ones (cheap; runs a few times a second). */
  updateStream(dt, focus) {
    this.streamTimer -= dt;
    if (this.streamTimer > 0) return;
    this.streamTimer = 0.25;
    for (const e of this.streamGrid.query(focus.x, focus.z, STREAM_RADIUS)) {
      if (!e.cols && !e.removed && Math.hypot(e.x - focus.x, e.z - focus.z) < STREAM_RADIUS) this.activate(e);
    }
    for (const e of [...this.streamActive]) if (Math.hypot(e.x - focus.x, e.z - focus.z) > STREAM_KEEP) this.deactivate(e);
  }

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
