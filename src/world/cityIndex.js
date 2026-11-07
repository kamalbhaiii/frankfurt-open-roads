/**
 * Shared spatial indexes built with the city: the static physics mesh collector,
 * street-name lookup and point-in-building tests.
 */
import { pip, bounds, segDist, SpatialGrid } from '../core/math.js';

/** Collects triangles for the single static trimesh collider. */
export class PhysicsMesh {
  constructor() {
    this.v = [];
    this.i = [];
  }
  push(geo) {
    const pos = geo.attributes.position.array,
      idx = geo.index.array;
    const base = this.v.length / 3;
    for (let i = 0; i < pos.length; i++) this.v.push(pos[i]);
    for (let i = 0; i < idx.length; i++) this.i.push(idx[i] + base);
  }
}

/** Fast "which street am I on" lookups for the HUD. */
export class StreetIndex {
  constructor(roads) {
    this.grid = new SpatialGrid(60);
    for (const r of roads) {
      if (!r.name) continue;
      for (let i = 0; i < r.pts.length - 1; i++) {
        const a = r.pts[i],
          b = r.pts[i + 1];
        this.grid.insert((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, [a, b, r.name]);
      }
    }
  }
  nearest(x, z, max = 30) {
    let best = null,
      bd = max;
    for (const [a, b, n] of this.grid.query(x, z, 60)) {
      const { d } = segDist(x, z, a[0], a[1], b[0], b[1]);
      if (d < bd) {
        bd = d;
        best = n;
      }
    }
    return best;
  }
}

/** Point-in-building tests (used to keep trees and spawns out of buildings). */
export class BuildingIndex {
  constructor() {
    this.grid = new SpatialGrid(40);
  }
  add(ring) {
    const b = bounds(ring);
    const item = { ring, b };
    for (let x = Math.floor(b.minx / 40); x <= Math.floor(b.maxx / 40); x++) {
      for (let z = Math.floor(b.minz / 40); z <= Math.floor(b.maxz / 40); z++) this.grid.insert(x * 40 + 1, z * 40 + 1, item);
    }
  }
  inside(x, z, pad = 0) {
    for (const it of this.grid.query(x, z, 0)) {
      const b = it.b;
      if (x < b.minx - pad || x > b.maxx + pad || z < b.minz - pad || z > b.maxz + pad) continue;
      if (pip(x, z, it.ring)) return true;
      if (pad && (pip(x + pad, z, it.ring) || pip(x - pad, z, it.ring) || pip(x, z + pad, it.ring) || pip(x, z - pad, it.ring))) return true;
    }
    return false;
  }
}
