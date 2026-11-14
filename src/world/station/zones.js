/**
 * Frankfurt (Main) Hauptbahnhof: the station's local frame and its exclusion zones.
 *
 * The OSM train-shed halls are rotated about 30° from the world axes. Everything of the
 * station is built in a local frame (u, v):
 *   u runs along the tracks, growing towards the east (the reception building / Vorplatz),
 *   v runs across the tracks, growing towards the south (Mannheimer Straße).
 * World x/z = rotation of (u, v) about the origin, so a THREE.Group with rotation.y = STATION_YAW
 * maps local (u, y, v) straight to world coordinates.
 *
 * Plain module (no three.js) so buildings.js / traffic.js / transit.js can import it cheaply.
 */

// unit vector of the hall long sides in world x/z (from the OSM footprints)
const UX = 0.8560644452749259,
  UZ = -0.5168690990339174;
export const STATION_YAW = Math.atan2(-UZ, UX);

/** World (x, z) -> local [u, v]. */
export const toUV = (x, z) => [x * UX + z * UZ, x * -UZ + z * UX];
/** Local (u, v) -> world [x, z]. */
export const fromUV = (u, v) => [u * UX + v * -UZ, u * UZ + v * UX];

/** Key lines of the station in local metres. */
export const HBF = {
  hallW: -1076, // west gables of the train sheds
  hallE: -889, // east end of the sheds = back wall of the reception building
  front: -858, // reception facade along the Bahnhofsvorplatz
  bufferU: -920, // buffer stops
  platW: -1095, // west end of the platforms
  vN: -111, // north wall
  vS: 123, // south wall
  // hall boundaries north -> south: small, big, big, big, small
  halls: [
    [-111, -77, 'small'],
    [-77, -22, 'big'],
    [-22, 35, 'big'],
    [35, 90, 'big'],
    [90, 123, 'small'],
  ],
  // track centre lines inside the sheds (from the OSM rails)
  tracks: [-98, -93, -81, -71, -61, -55, -43, -37, -25, -18, -6, 1, 13, 20, 32, 40, 52, 58, 70, 74, 86, 94, 107, 113],
  terminal: { u0: -1062, u1: -914, v0: 124, v1: 142 }, // Fernbusterminal strip along the south wall
};

const inRect = (u, v, u0, u1, v0, v1) => u >= u0 && u <= u1 && v >= v0 && v <= v1;

/** True if an OSM footprint belongs to the station (its centroid is inside the station block). */
export function stationFootprint(ring) {
  let cx = 0,
    cz = 0;
  for (const p of ring) {
    cx += p[0];
    cz += p[1];
  }
  const [u, v] = toUV(cx / ring.length, cz / ring.length);
  return inRect(u, v, -1080, -800, -115, 142);
}

/** Footprint rings (world x/z) that keep trees and spawns out of the station and the bus terminal. */
export const STATION_RINGS = [
  [
    [-1078, -113],
    [-850, -113],
    [-850, 142],
    [-1078, 142],
  ].map(([u, v]) => fromUV(u, v)),
];

/** True inside the station building or the Fernbusterminal (no parked cars, no bus stops here). */
export function inStationArea(x, z) {
  const [u, v] = toUV(x, z);
  return inRect(u, v, -1080, -852, -113, 142);
}
