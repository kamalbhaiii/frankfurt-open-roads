// Precomputes real street geometry from the OSM extract:
//   asphalt carriageways (unioned, clean junctions), raised kerbed pavements (incl. medians/islands),
//   zebra crossings, street-lamp positions, signalised junctions with signal poles + stop lines, central dividers.
// Output: data/streets.json(.gz)   Run: node tools/build-streets.cjs
const fs = require('fs'); const zlib = require('zlib');
const src = fs.readFileSync(__dirname + '/../node_modules/jsts/dist/jsts.min.js', 'utf8');
const m = { exports: {} }; new Function('module', 'exports', 'window', 'self', src)(m, m.exports, globalThis, globalThis);
const jsts = Object.keys(m.exports).length ? m.exports : globalThis.jsts;
const gf = new jsts.geom.GeometryFactory();
const C = (x, z) => new jsts.geom.Coordinate(x, z);
const { BufferOp, BufferParameters } = jsts.operation.buffer;
const T0 = Date.now(); const log = (...a) => console.log(((Date.now() - T0) / 1000).toFixed(1) + 's', ...a);

const d = JSON.parse(fs.readFileSync(__dirname + '/../data/frankfurt_osm.json', 'utf8'));
const dec = (a, s) => { const pts = []; let x = 0, z = 0; for (let i = s; i < a.length; i += 2) { x += a[i]; z += a[i + 1]; pts.push([x / 2, z / 2]); } return pts; };
const clean = (pts) => { const o = []; for (const p of pts) { const l = o[o.length - 1]; if (!l || Math.hypot(p[0] - l[0], p[1] - l[1]) > 0.3) o.push(p); } return o; };
const RC = { 0: [14, 0, 16], 1: [12, 0, 15], 2: [11, 0, 13], 3: [9.5, 0, 12], 4: [8, 0, 11], 5: [6.5, 0, 9], 6: [6.5, 0, 8], 7: [4, 0, 0], 8: [5, 1, 0], 9: [6, 1, 0], 10: [2.6, 1, 0], 11: [2.2, 1, 0], 12: [2, 1, 0], 13: [2.4, 1, 0], 14: [7, 0, 12], 15: [7, 0, 12], 16: [7, 0, 11], 17: [7, 0, 10], 18: [7, 0, 9], 19: [3, 1, 0] };
const roadWidth = (r) => r.lanes && RC[r.c][1] === 0 ? Math.max(RC[r.c][0] * 0.6, r.lanes * 3.2 + 1) : RC[r.c][0];
const roads = d.r.map(a => ({ c: a[0], bridge: a[2], lanes: a[3], oneway: a[4], pts: clean(dec(a, 5)) })).filter(r => r.pts.length >= 2);
roads.forEach(r => r.w = roadWidth(r));
const area = (r) => { let s = 0; for (let i = 0; i < r.length; i++) { const a = r[i], b = r[(i + 1) % r.length]; s += a[0] * b[1] - b[0] * a[1]; } return s / 2; };
const water = d.w.map(a => clean(dec(a, 0))).filter(r => r.length > 6 && Math.abs(area(r)) > 30000);

const isAsphalt = (r) => (r.c <= 8 || (r.c >= 14 && r.c <= 18));
const isKerbed = (r) => (r.c <= 6 || (r.c >= 14 && r.c <= 18));
const line = (pts) => gf.createLineString(pts.map(p => C(p[0], p[1])));
const bp = new BufferParameters(3, BufferParameters.CAP_ROUND, BufferParameters.JOIN_ROUND, 5);
const buf = (g, dist) => BufferOp.bufferOp(g, dist, bp);
const unionAll = (geoms) => gf.createGeometryCollection(geoms).union();
const poly = (ring) => { const r = ring.slice(); if (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1]) r.push(r[0]); return gf.createPolygon(gf.createLinearRing(r.map(p => C(p[0], p[1])))); };

// ---- asphalt
const asphaltRoads = roads.filter(isAsphalt);
log('roads', roads.length, 'asphalt', asphaltRoads.length);
const roadArea = unionAll(asphaltRoads.map(r => buf(line(r.pts), r.w / 2)));
log('road union done', roadArea.getNumGeometries());
// ---- pavements
const swOf = (r) => r.c <= 2 ? 4.2 : r.c <= 4 || r.c >= 14 ? 3.6 : 2.8;
let walk = unionAll(roads.filter(isKerbed).map(r => buf(line(r.pts), r.w / 2 + swOf(r))));
log('walk outer union');
walk = walk.difference(roadArea); log('minus road');
const river = unionAll(water.map(poly).map(p => p.buffer(0)));
walk = walk.difference(river); log('minus river');
const bridgeWalk = unionAll(roads.filter(r => r.bridge && isKerbed(r)).map(r => buf(line(r.pts), r.w / 2 + 2.2))).difference(roadArea);
walk = walk.union(bridgeWalk); log('plus bridge pavements');
// remove slivers
const keepBig = (g, minA) => { const out = []; for (let i = 0; i < g.getNumGeometries(); i++) { const p = g.getGeometryN(i); if (p.getArea() >= minA) out.push(p); } return gf.createMultiPolygon(out); };
walk = keepBig(walk, 4);

// ---- tile + simplify + encode
const TILE = 250;
const env = roadArea.getEnvelopeInternal();
const encRing = (coords) => { const o = []; let px = 0, pz = 0; for (let i = 0; i < coords.length - 1; i++) { const x = Math.round(coords[i].x * 10), z = Math.round(coords[i].y * 10); o.push(x - px, z - pz); px = x; pz = z; } return o; };
function tiles(g) {
  const out = [];
  for (let tx = Math.floor(env.getMinX() / TILE); tx <= Math.floor(env.getMaxX() / TILE); tx++) for (let tz = Math.floor(env.getMinY() / TILE); tz <= Math.floor(env.getMaxY() / TILE); tz++) {
    const rect = gf.toGeometry(new jsts.geom.Envelope(tx * TILE, (tx + 1) * TILE, tz * TILE, (tz + 1) * TILE));
    let part = g.intersection(rect); if (part.isEmpty()) continue;
    part = jsts.simplify.TopologyPreservingSimplifier.simplify(part, 0.12);
    const polys = [];
    for (let i = 0; i < part.getNumGeometries(); i++) {
      const p = part.getGeometryN(i); if (p.getGeometryType() !== 'Polygon' || p.getArea() < 1) continue;
      const rings = [encRing(p.getExteriorRing().getCoordinates())];
      for (let h = 0; h < p.getNumInteriorRing(); h++) { const hr = p.getInteriorRingN(h); if (Math.abs(jsts.algorithm.Area.ofRing(hr.getCoordinates())) > 0.5) rings.push(encRing(hr.getCoordinates())); }
      polys.push(rings);
    }
    if (polys.length) out.push(polys);
  }
  return out;
}
const roadTiles = tiles(roadArea); log('road tiles', roadTiles.length);
const walkTiles = tiles(walk); log('walk tiles', walkTiles.length);

// ---- spatial index of car-road segments
const segGrid = new Map(); const G = 40;
roads.forEach((r, ri) => { if (!isKerbed(r) && r.c !== 7) return; for (let i = 0; i < r.pts.length - 1; i++) { const a = r.pts[i], b = r.pts[i + 1]; const k = Math.floor((a[0] + b[0]) / 2 / G) + ',' + Math.floor((a[1] + b[1]) / 2 / G); if (!segGrid.has(k)) segGrid.set(k, []); segGrid.get(k).push([a, b, ri]); } });
const nearSegs = (x, z, rad = 1) => { const o = []; const gx = Math.floor(x / G), gz = Math.floor(z / G); for (let i = -rad; i <= rad; i++) for (let j = -rad; j <= rad; j++) for (const s of segGrid.get((gx + i) + ',' + (gz + j)) || []) o.push(s); return o; };
const segDist = (x, z, a, b) => { const dx = b[0] - a[0], dz = b[1] - a[1]; const l2 = dx * dx + dz * dz || 1; const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l2)); return Math.hypot(x - a[0] - dx * t, z - a[1] - dz * t); };
const { IndexedPointInAreaLocator } = jsts.algorithm.locate; const EXT = jsts.geom.Location.EXTERIOR;
const locW = new IndexedPointInAreaLocator(walk), locR = new IndexedPointInAreaLocator(roadArea);
const prepWalk = { contains: (pt) => locW.locate(pt.getCoordinate()) !== EXT };
const prepRoad = { intersects: (circle) => { const c = circle.getCentroid().getCoordinate(); for (let a = 0; a < 6.28; a += 0.79) { if (locR.locate(C(c.x + Math.cos(a) * 0.35, c.y + Math.sin(a) * 0.35)) !== EXT) return true; } return locR.locate(c) !== EXT; } };

// ---- junctions / signals
const key = (p) => Math.round(p[0]) + ',' + Math.round(p[1]);
const nodes = new Map();
roads.forEach((r, ri) => { if (!isKerbed(r)) return; for (const end of [0, 1]) { const p = end ? r.pts[r.pts.length - 1] : r.pts[0]; const k = key(p); if (!nodes.has(k)) nodes.set(k, { p, ends: [] }); nodes.get(k).ends.push({ ri, end }); } });
const signals = []; const usedSig = [];
for (const [k, n] of nodes) {
  if (n.ends.length < 3) continue;
  const major = n.ends.filter(e => roads[e.ri].c <= 4 || roads[e.ri].c >= 14).length; if (major < 2) continue;
  if (usedSig.some(q => Math.hypot(q[0] - n.p[0], q[1] - n.p[1]) < 30)) continue;
  usedSig.push(n.p);
  const maxW = Math.max(...n.ends.map(e => roads[e.ri].w));
  const appr = [];
  for (const e of n.ends) {
    const r = roads[e.ri]; if (r.bridge) continue;
    if (r.oneway && e.end === 0) continue; // traffic only leaves the junction on this way
    const pts = e.end ? r.pts.slice().reverse() : r.pts; // pts[0] = node
    let dx = pts[0][0] - pts[1][0], dz = pts[0][1] - pts[1][1]; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L; // direction INTO node
    const back = Math.min(maxW / 2 + 4, 14);
    const sx = pts[0][0] - dx * back, sz = pts[0][1] - dz * back;
    const rx = -dz, rz = dx; // right-hand side
    const off = r.oneway ? r.w / 2 : r.w / 2;
    const px = sx + rx * (off + 0.7), pz = sz + rz * (off + 0.7);
    // stop line spans the in-bound half (or whole width if one-way)
    const l0 = r.oneway ? -r.w / 2 + 0.3 : 0.2, l1 = r.w / 2 - 0.3;
    appr.push({ ang: Math.atan2(dx, dz), pole: [+px.toFixed(2), +pz.toFixed(2)], stop: [+(sx + rx * l0).toFixed(2), +(sz + rz * l0).toFixed(2), +(sx + rx * l1).toFixed(2), +(sz + rz * l1).toFixed(2)], cross: [+(sx - dx * -2.5).toFixed(2), +(sz - dz * -2.5).toFixed(2), r.w] });
  }
  if (appr.length < 2) continue;
  const axis = appr[0].ang;
  for (const a of appr) a.g = Math.abs(Math.cos(a.ang - axis)) > 0.7 ? 0 : 1;
  signals.push({ x: n.p[0], z: n.p[1], k, appr: appr.map(a => [a.g, +a.ang.toFixed(3), ...a.pole, ...a.stop]) , cross: appr.map(a => a.cross) });
}
log('signals', signals.length);

// ---- zebra crossings where footpaths cross carriageways
const crossings = [];
const addCross = (x, z, ang, w) => { if (crossings.some(c => Math.hypot(c[0] - x, c[1] - z) < 14)) return; crossings.push([+x.toFixed(2), +z.toFixed(2), +ang.toFixed(3), +w.toFixed(1)]); };
for (const s of signals) for (const c of s.cross) { /* signal approaches: crossing just before the junction box */ }
for (const r of roads) {
  if (r.c !== 10 && r.c !== 9 && r.c !== 11) continue;
  for (let i = 0; i < r.pts.length - 1; i++) {
    const a = r.pts[i], b = r.pts[i + 1];
    for (const [p, q, ri] of nearSegs((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, 1)) {
      const R = roads[ri]; if (R.c > 6 && !(R.c >= 14)) continue;
      const d1x = b[0] - a[0], d1z = b[1] - a[1], d2x = q[0] - p[0], d2z = q[1] - p[1];
      const den = d1x * d2z - d1z * d2x; if (Math.abs(den) < 1e-6) continue;
      const t = ((p[0] - a[0]) * d2z - (p[1] - a[1]) * d2x) / den, u = ((p[0] - a[0]) * d1z - (p[1] - a[1]) * d1x) / den;
      if (t < 0 || t > 1 || u < 0 || u > 1) continue;
      const cosA = Math.abs((d1x * d2x + d1z * d2z) / (Math.hypot(d1x, d1z) * Math.hypot(d2x, d2z))); if (cosA > 0.6) continue;
      addCross(a[0] + d1x * t, a[1] + d1z * t, Math.atan2(d2x, d2z), R.w);
    }
  }
}
// signals also get a crossing on each approach (German "Fußgängerfurt")
for (const s of signals) for (const a of s.appr) { const [g, ang, px, pz, s0x, s0z, s1x, s1z] = a; const dx = Math.sin(ang), dz = Math.cos(ang); const mx = (s0x + s1x) / 2, mz = (s0z + s1z) / 2; }
log('crossings', crossings.length);

// ---- street lamps on the pavement edge
const lamps = [];
for (const r of roads) {
  if (!isKerbed(r) || r.bridge) continue;
  const step = r.c <= 4 ? 30 : 36; let carry = 12, side = 1;
  for (let i = 0; i < r.pts.length - 1; i++) {
    const a = r.pts[i], b = r.pts[i + 1]; const L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 0.1) continue;
    const dx = (b[0] - a[0]) / L, dz = (b[1] - a[1]) / L;
    for (let s = carry; s < L; s += step) {
      const sides = r.c <= 3 ? [1, -1] : [side]; side = -side;
      for (const sd of sides) {
        const x = a[0] + dx * s + (-dz) * (r.w / 2 + 0.55) * sd, z = a[1] + dz * s + dx * (r.w / 2 + 0.55) * sd;
        if (!prepWalk.contains(gf.createPoint(C(x, z)))) continue;
        if (prepRoad.intersects(gf.createPoint(C(x, z)).buffer(0.35))) continue;
        if (lamps.some(l => Math.abs(l[0] - x) < 6 && Math.abs(l[1] - z) < 6)) continue;
        lamps.push([+x.toFixed(2), +z.toFixed(2), +Math.atan2(dz * sd, -dx * sd).toFixed(2)]);
      }
    }
    carry = ((carry - L) % step + step) % step;
  }
}
log('lamps', lamps.length);

// ---- central dividers on wide two-way roads
const dividers = [];
roads.forEach((r, ri) => {
  if (r.oneway || r.bridge || !(r.c <= 3 || (r.c >= 14 && r.c <= 16)) || r.w < 10.5) return;
  let len = 0; const cum = [0]; for (let i = 1; i < r.pts.length; i++) { len += Math.hypot(r.pts[i][0] - r.pts[i - 1][0], r.pts[i][1] - r.pts[i - 1][1]); cum.push(len); }
  if (len < 70) return;
  let cur = [];
  const flush = () => { if (cur.length >= 2) { let l = 0; for (let i = 1; i < cur.length; i++) l += Math.hypot(cur[i][0] - cur[i - 1][0], cur[i][1] - cur[i - 1][1]); if (l > 12) dividers.push(cur.flat().map(v => +v.toFixed(2))); } cur = []; };
  for (let s = 22; s < len - 22; s += 3) {
    let i = 0; while (i < cum.length - 2 && cum[i + 1] < s) i++;
    const t = (s - cum[i]) / ((cum[i + 1] - cum[i]) || 1); const x = r.pts[i][0] + (r.pts[i + 1][0] - r.pts[i][0]) * t, z = r.pts[i][1] + (r.pts[i + 1][1] - r.pts[i][1]) * t;
    const blocked = nearSegs(x, z, 1).some(([a, b, oi]) => oi !== ri && segDist(x, z, a, b) < roads[oi].w / 2 + 7) || crossings.some(c => Math.hypot(c[0] - x, c[1] - z) < 7);
    if (blocked) flush(); else cur.push([x, z]);
  }
  flush();
});
log('dividers', dividers.length);

const out = { tile: TILE, road: roadTiles, walk: walkTiles, cross: crossings, lamps, signals: signals.map(s => ({ x: +s.x.toFixed(2), z: +s.z.toFixed(2), a: s.appr })), div: dividers };
const json = JSON.stringify(out);
fs.writeFileSync(__dirname + '/../data/streets.json', json);
const gz = zlib.gzipSync(json, { level: 9 });
fs.writeFileSync(__dirname + '/../data/streets.json.gz', gz);

log('json', (json.length / 1e6).toFixed(2), 'MB, gz', (gz.length / 1e3).toFixed(0), 'KB');
