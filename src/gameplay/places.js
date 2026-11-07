/**
 * Turns named places into usable world positions: road lanes for vehicles,
 * kerbside spots for people, landmark lookups.
 */
import { ctx } from '../core/context.js';
import { toLocal } from '../core/config.js';

/** Landmark by OSM name (tall buildings in the data set). */
export function landmark(name) {
  const n = ctx.city.names.find((p) => p.name === name);
  if (!n) throw new Error(`Unknown landmark: ${name}`);
  return { x: n.x, z: n.z };
}

/** World position for lat/lon. */
export function geo(lat, lon) {
  const [x, z] = toLocal(lat, lon);
  return { x, z };
}

function frame(hit) {
  const pts = hit.edge.pts,
    a = pts[hit.seg],
    b = pts[hit.seg + 1];
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  return { dx: (b[0] - a[0]) / L, dz: (b[1] - a[1]) / L };
}

/** Driving-lane position and heading on the nearest road (right-hand side). */
export function roadSpot(x, z, filter = (e) => e.speed >= 8) {
  const hit = ctx.roads.nearest(x, z, 400, filter) || ctx.roads.nearest(x, z, 800);
  const { dx, dz } = frame(hit);
  const off = hit.edge.oneway ? 0 : Math.min(hit.edge.width / 4 + 0.4, 3.2);
  return { x: hit.x - dz * off, z: hit.z + dx * off, yaw: Math.atan2(dx, dz), edge: hit.edge };
}

/** Parking spot at the kerb (right side, close to the pavement). */
export function parkingSpot(x, z) {
  const hit = ctx.roads.nearest(x, z, 400, (e) => e.speed > 0) || ctx.roads.nearest(x, z, 800);
  const { dx, dz } = frame(hit);
  const off = hit.edge.width / 2 - 1.2;
  return { x: hit.x - dz * off, z: hit.z + dx * off, yaw: Math.atan2(dx, dz) };
}

/** Pavement position next to the nearest road, on the side facing (x, z). */
export function kerbSpot(x, z) {
  const hit = ctx.roads.nearest(x, z, 400) || ctx.roads.nearest(x, z, 800);
  const { dx, dz } = frame(hit);
  const nx = -dz,
    nz = dx; // right normal
  const side = (x - hit.x) * nx + (z - hit.z) * nz >= 0 ? 1 : -1;
  const off = hit.edge.width / 2 + 1.8;
  return { x: hit.x + nx * off * side, z: hit.z + nz * off * side, yaw: Math.atan2(dx, dz) };
}

/** Random kerbside point at a distance band from (x, z). */
export function randomKerbSpot(x, z, rMin, rMax, rng = Math.random) {
  for (let t = 0; t < 20; t++) {
    const a = rng() * Math.PI * 2,
      r = rMin + (rMax - rMin) * rng();
    const px = x + Math.cos(a) * r,
      pz = z + Math.sin(a) * r;
    if (!inPlayArea(px, pz)) continue;
    const s = kerbSpot(px, pz);
    if (Math.hypot(s.x - x, s.z - z) >= rMin * 0.8) return s;
  }
  return kerbSpot(x + rMin, z);
}

/** Inner area of the map with complete street data (avoids the cropped edges). */
export const inPlayArea = (x, z) => x > -1850 && x < 2050 && z > -1500 && z < 1250;
