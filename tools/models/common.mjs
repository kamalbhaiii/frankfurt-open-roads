// Shared helpers for the model generators: exporter/optimiser pipeline, materials, primitives.
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, weld, quantize, meshopt, prune } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';
import fs from 'fs';
import { fileURLToPath } from 'url';

globalThis.FileReader = class { readAsArrayBuffer(b) { b.arrayBuffer().then(ab => { this.result = ab; this.onloadend && this.onloadend(); this.onload && this.onload({ target: this }); }); } readAsDataURL(b) { b.arrayBuffer().then(ab => { this.result = 'data:application/octet-stream;base64,' + Buffer.from(ab).toString('base64'); this.onloadend && this.onloadend(); }); } };
export const OUT = fileURLToPath(new URL('../../assets/models/', import.meta.url)); fs.mkdirSync(OUT, { recursive: true });
export const exporter = new GLTFExporter();
export async function save(name, obj, animations = []) {
  const ab = await exporter.parseAsync(obj, { binary: true, animations, onlyVisible: true });
  await MeshoptEncoder.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
  const doc = await io.readBinary(new Uint8Array(ab));
  await doc.transform(dedup(), weld(), prune(), quantize({ quantizePosition: 14, quantizeNormal: 10, quantizeColor: 16 }), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
  const bin = await io.writeBinary(doc);
  fs.writeFileSync(OUT + name, Buffer.from(bin)); console.log(name, (ab.byteLength / 1024).toFixed(0) + ' KB ->', (bin.byteLength / 1024).toFixed(0) + ' KB');
}
export const std = (name, color, o = {}) => { const m = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0, ...o }); m.name = name; return m; };
// merge geometries that share one material into a single mesh (keeps draw calls low)
export const isSpecial = (m) => m.transparent || m.emissiveIntensity > 0 || (m.emissive && m.emissive.getHex() !== 0) || /^lens_|headlight|taillight|indicator|siren|taxi_sign|glass/.test(m.name);
export const vcMats = {};
export function vcMat(kind) { if (!vcMats[kind]) { vcMats[kind] = kind === 'car' ? std('body_vc', 0xffffff, { vertexColors: true, roughness: 0.38, metalness: 0.35 }) : std('vc', 0xffffff, { vertexColors: true, roughness: 0.75 }); } return vcMats[kind]; }
export function colorize(g, c) { const n = g.attributes.position.count; const a = new Float32Array(n * 3); for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; } g.setAttribute('color', new THREE.Float32BufferAttribute(a, 3)); return g; }
export function bake(parts, name, kind = 'car') {
  const plain = [], special = [];
  for (const [g0, mat] of parts) { let g = g0; for (const k of Object.keys(g.attributes)) if (!['position', 'normal'].includes(k)) g.deleteAttribute(k); if (!g.index) g = mergeVertices(g); (isSpecial(mat) ? special : plain).push([g, mat]); }
  parts = special.concat(plain.length ? [[mergeGeometries(plain.map(([g, m]) => colorize(g, m.color))), vcMat(kind)]] : []);
  const byMat = new Map();
  for (const [g, mat] of parts) { if (!g.attributes.color && mat.vertexColors) continue; if (!byMat.has(mat)) byMat.set(mat, []); byMat.get(mat).push(g); }
  const grp = new THREE.Group(); grp.name = name;
  for (const [mat, gs] of byMat) { const mesh = new THREE.Mesh(mergeGeometries(gs), mat); mesh.name = name + '_' + mat.name; grp.add(mesh); }
  return grp;
}
export const box = (w, h, d, x, y, z, rx = 0, ry = 0, rz = 0) => { const g = new THREE.BoxGeometry(w, h, d); g.rotateX(rx); g.rotateY(ry); g.rotateZ(rz); g.translate(x, y, z); return g; };
export const rbox = (w, h, d, r, x, y, z) => { // rounded box via scaled sphere-ish blend
  const g = new THREE.BoxGeometry(w, h, d, 3, 3, 3); const p = g.attributes.position; const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i); const hx = w / 2 - r, hy = h / 2 - r, hz = d / 2 - r; const c = new THREE.Vector3(THREE.MathUtils.clamp(v.x, -hx, hx), THREE.MathUtils.clamp(v.y, -hy, hy), THREE.MathUtils.clamp(v.z, -hz, hz)); const n = v.clone().sub(c); if (n.lengthSq() > 1e-9) n.setLength(r); p.setXYZ(i, c.x + n.x + x, c.y + n.y + y, c.z + n.z + z); }
  g.computeVertexNormals(); return g;
};
export const cyl = (rt, rb, h, x, y, z, seg = 16, rx = 0, rz = 0) => { const g = new THREE.CylinderGeometry(rt, rb, h, seg); g.rotateX(rx); g.rotateZ(rz); g.translate(x, y, z); return g; };
export const sph = (r, sx, sy, sz, x, y, z, ws = 12, hs = 8) => { const g = new THREE.SphereGeometry(r, ws, hs); g.scale(sx, sy, sz); g.translate(x, y, z); return g; };

export { THREE, mergeGeometries, mergeVertices };
