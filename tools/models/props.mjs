// Street prop generator. Exports makeLamp, makeTrafficLight, makeBarrier.
// Every non-emissive part is baked into one vertex-coloured mesh (see bake()), so extra materials cost
// nothing at draw time — the props are drawn as InstancedMeshes thousands of times.
import { THREE, std as std0, bake, box, cyl } from './common.mjs';
// plain (non-emissive) materials get emissiveIntensity 0 so bake() folds them into the shared vertex-colour mesh;
// materials with an emissive colour (lamp_lens, reflector) or a lens_ name stay separate meshes.
const std = (name, color, o = {}) => std0(name, color, { emissiveIntensity: o.emissive ? 1 : 0, ...o });
// =====================================================================================
// helpers
// =====================================================================================
// back faces for thin open shells (visors, hoods) so they read from both sides with a single-sided material
function dbl(g) {
  const b = g.index ? g.toNonIndexed() : g.clone(); const p = b.attributes.position, n = b.attributes.normal;
  for (let i = 0; i < p.count; i += 3) { // swap vertices 1 and 2 of every triangle and flip normals
    for (const a of [p, n]) { const x = a.getX(i + 1), y = a.getY(i + 1), z = a.getZ(i + 1); a.setXYZ(i + 1, a.getX(i + 2), a.getY(i + 2), a.getZ(i + 2)); a.setXYZ(i + 2, x, y, z); }
  }
  for (let i = 0; i < n.count; i++) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i));
  const f = g.index ? g.toNonIndexed() : g; return [f, b];
}
// profile in the (u = x, v = y) plane extruded along z from z0 to z1
function extrudeXY(pts, z0, z1) {
  const sh = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
  const g = new THREE.ExtrudeGeometry(sh, { depth: z1 - z0, bevelEnabled: false, curveSegments: 1 }); g.translate(0, 0, z0); return g;
}
// profile in the (u = z, v = y) plane extruded along x, centred on x = 0
function extrudeZY(pts, w) {
  const g = extrudeXY(pts.map(([z, y]) => [-z, y]), -w / 2, w / 2); g.rotateY(Math.PI / 2); return g; // (-z,y,x) -> rotY(90°) -> (x', y, z)
}
const tube = (pts, r, tseg, rseg) => new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts.map(p => new THREE.Vector3(...p))), tseg, r, rseg, false);

// =====================================================================================
// STREET LAMP — slim conical anthracite mast on a plinth, swept arm, flat LED luminaire over +Z
// =====================================================================================
export function makeLamp() {
  const metal = std('lamp_metal', 0x3c4246, { roughness: 0.45, metalness: 0.6 });
  const plinth = std('lamp_plinth', 0x2a2e31, { roughness: 0.6 });
  const head = std('lamp_head', 0x5b6267, { roughness: 0.4, metalness: 0.5 });
  const band = std('lamp_band', 0x8a9096, { roughness: 0.35, metalness: 0.7 });
  const lens = std('lamp_lens', 0xfff2d6, { emissive: 0xffd9a0, emissiveIntensity: 0.0, roughness: 0.2 });
  const parts = [];
  // plinth: wider octagonal foot with a service-door block, then a stepped collar
  parts.push([cyl(0.15, 0.17, 0.08, 0, 0.04, 0, 8), plinth]);
  parts.push([cyl(0.125, 0.14, 0.9, 0, 0.53, 0, 8), plinth]);
  parts.push([box(0.12, 0.34, 0.03, 0, 0.55, -0.128), metal]);                 // service door (faces away from road)
  parts.push([cyl(0.1, 0.125, 0.08, 0, 1.02, 0, 8), band]);
  // tapered mast up to the arm root
  parts.push([cyl(0.062, 0.095, 6.7, 0, 4.41, 0, 8), metal]);
  parts.push([cyl(0.068, 0.068, 0.12, 0, 4.2, 0, 8), band]);                   // banner/sign collar halfway up
  // arm: rises from the mast top and sweeps forward, rising slightly towards the head
  parts.push([tube([[0, 7.7, 0], [0, 8.2, 0.02], [0, 8.42, 0.3], [0, 8.48, 0.75], [0, 8.5, 1.02]], 0.055, 7, 6), metal]);
  parts.push([cyl(0.062, 0.062, 0.04, 0, 7.74, 0, 8), metal]);
  // LED luminaire: thin wedge body, thicker at the arm, tapering to a slim nose
  parts.push([extrudeZY([[0.95, 8.46], [1.0, 8.55], [1.62, 8.53], [1.92, 8.47], [1.95, 8.43], [1.88, 8.4], [1.0, 8.41], [0.95, 8.44]], 0.36), head]);
  parts.push([box(0.3, 0.02, 0.05, 0, 8.555, 1.3), band]);                       // top cooling rib
  // LED panel underneath (named lamp_lens; game drives its emissive at night). Centre ~1.45 m out.
  parts.push([box(0.28, 0.02, 0.72, 0, 8.398, 1.46), lens]);
  return bake(parts, 'prop_lamp', 'prop');
}

// =====================================================================================
// TRAFFIC SIGNAL — German 3-aspect signal (Ampel) on a grey pole: modular black housing,
// black backplate with white contrast border, hoods, pedestrian head + yellow push-button box
// Lenses face +Z (game yaws the pole by approachAngle + PI), mounted at z≈0.275, y 3.42/3.11/2.80.
// =====================================================================================
export function makeTrafficLight() {
  const pole = std('signal_pole', 0x8a8f93, { roughness: 0.5, metalness: 0.5 });
  const housing = std('signal_housing', 0x18191b, { roughness: 0.55 });
  const white = std('signal_border', 0xe8e8e4, { roughness: 0.5 });
  const button = std('signal_button', 0xf0bd1c, { roughness: 0.5 });
  const pedRed = std('signal_ped_red', 0x4a0d0a, { roughness: 0.3 }), pedGreen = std('signal_ped_green', 0x0b3a1e, { roughness: 0.3 });
  const grp = new THREE.Group(); grp.name = 'prop_traffic_light';
  const parts = [];
  // pole with foot flange and cap
  parts.push([cyl(0.13, 0.14, 0.06, 0, 0.03, 0, 8), pole]);
  parts.push([cyl(0.068, 0.078, 3.6, 0, 1.8, 0, 8), pole]);
  parts.push([cyl(0.04, 0.074, 0.05, 0, 3.625, 0, 8), pole]);
  // two brackets holding the signal to the pole
  for (const y of [2.72, 3.48]) parts.push([box(0.08, 0.06, 0.12, 0, y, 0.07), housing]);
  // backplate (Kontrastblende): black plate + white border strips on the front face
  parts.push([box(0.5, 1.18, 0.02, 0, 3.11, 0.04), housing]);
  const bw = 0.035, bz = 0.052;
  parts.push([box(0.5, bw, 0.006, 0, 3.11 + 0.59 - bw / 2, bz), white], [box(0.5, bw, 0.006, 0, 3.11 - 0.59 + bw / 2, bz), white]);
  parts.push([box(bw, 1.18 - 2 * bw, 0.006, 0.25 - bw / 2, 3.11, bz), white], [box(bw, 1.18 - 2 * bw, 0.006, -0.25 + bw / 2, 3.11, bz), white]);
  // housing: three chambers with a slight seam between them, plus a top cap
  for (let i = 0; i < 3; i++) parts.push([box(0.3, 0.295, 0.22, 0, 3.42 - i * 0.31, 0.16), housing]);
  parts.push([box(0.26, 0.02, 0.2, 0, 3.11 + 0.155, 0.16), housing], [box(0.26, 0.02, 0.2, 0, 3.11 - 0.155, 0.16), housing]); // seam fillers (recessed)
  parts.push([box(0.32, 0.03, 0.24, 0, 3.585, 0.16), housing]);
  // hoods (Schuten) over each lens: open-bottom partial cylinders, double sided
  for (let i = 0; i < 3; i++) {
    const v = new THREE.CylinderGeometry(0.125, 0.125, 0.17, 7, 1, true, Math.PI - 1.9, 3.8); v.rotateX(Math.PI / 2); v.translate(0, 3.42 - i * 0.31, 0.355);
    for (const g of dbl(v)) parts.push([g, housing]);
  }
  // pedestrian signal head facing sideways (+X, across the crosswalk), with red/green figure windows
  parts.push([box(0.06, 0.06, 0.06, 0.09, 2.2, 0), housing]);
  parts.push([box(0.16, 0.44, 0.2, 0.19, 2.2, 0), housing]);
  parts.push([box(0.005, 0.16, 0.14, 0.272, 2.3, 0), pedRed], [box(0.005, 0.16, 0.14, 0.272, 2.1, 0), pedGreen]);
  parts.push([box(0.045, 0.015, 0.17, 0.292, 2.385, 0), housing], [box(0.045, 0.015, 0.17, 0.292, 2.185, 0), housing]); // small visors
  // yellow pedestrian push-button box (Anforderungstaster) on the pole
  parts.push([box(0.12, 0.22, 0.09, 0.105, 1.12, 0), button]);
  parts.push([box(0.01, 0.05, 0.05, 0.168, 1.1, 0), housing]);
  grp.add(...bake(parts, 'signal', 'prop').children);
  // lenses as separate named meshes so the game can light them (red top, amber, green bottom; facing +Z)
  for (const [i, n, c] of [[0, 'lens_red', 0x300000], [1, 'lens_amber', 0x302000], [2, 'lens_green', 0x002a10]]) {
    const g = cyl(0.1, 0.1, 0.02, 0, 3.42 - i * 0.31, 0.275, 12, Math.PI / 2);
    const m = new THREE.Mesh(g, std(n, c, { roughness: 0.2 })); m.name = n; grp.add(m);
  }
  return grp;
}

// =====================================================================================
// BARRIER — 3 m New-Jersey concrete section along Z with a steel rail on top and reflectors.
// Scaled on Z by the game, so detail runs along Z or is kept small.
// =====================================================================================
export function makeBarrier() {
  const concrete = std('concrete', 0xb9b5ac, { roughness: 0.95 }), dirt = std('concrete_dirt', 0x86837c, { roughness: 0.95 });
  const steel = std('rail', 0xa3aab0, { roughness: 0.35, metalness: 0.8 }), post = std('rail_post', 0x7d848a, { roughness: 0.4, metalness: 0.8 });
  const refl = std('reflector', 0xffffff, { emissive: 0xffffff, emissiveIntensity: 0.05 });
  const L = 1.48; // half length (small joint gap between sections)
  // grimy foot (vertical 75 mm toe) and the NJ profile above it: 55° lower slope, near-vertical upper face
  const foot = extrudeXY([[-0.3, 0], [0.3, 0], [0.3, 0.09], [-0.3, 0.09]], -L, L);
  const body = extrudeXY([[-0.3, 0.09], [0.3, 0.09], [0.29, 0.1], [0.17, 0.3], [0.1, 0.8], [0.08, 0.82], [-0.08, 0.82], [-0.1, 0.8], [-0.17, 0.3], [-0.29, 0.1]], -L + 0.01, L - 0.01);
  const parts = [[foot, dirt], [body, concrete]];
  // steel rail: rounded-ish rectangular tube along the top, on two short posts
  parts.push([extrudeXY([[-0.035, 0.885], [0.035, 0.885], [0.045, 0.9], [0.045, 0.935], [0.03, 0.95], [-0.03, 0.95], [-0.045, 0.935], [-0.045, 0.9]], -1.5, 1.5), steel]);
  for (const z of [-1.0, 1.0]) parts.push([box(0.05, 0.07, 0.05, 0, 0.85, z), post], [box(0.12, 0.012, 0.1, 0, 0.826, z), post]);
  // reflectors on both upper faces, tilted to the face slope (~7.9°)
  const tilt = Math.atan2(0.07, 0.5);
  for (const s of [-1, 1]) parts.push([box(0.012, 0.06, 0.12, s * 0.129, 0.62, 0, 0, 0, s * tilt), refl]);
  return bake(parts, 'prop_barrier', 'prop');
}
