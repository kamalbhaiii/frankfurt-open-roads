/**
 * 2D map drawing shared by the minimap and the full-screen map.
 * Geometry is cached as Path2D objects in world metres, split into square tiles so
 * only the tiles in view are drawn (sharp at any zoom, cheap enough for every frame).
 */
import { RC, roadWidth } from '../core/config.js';
import { bounds } from '../core/math.js';
import { BLIP_STYLES } from '../gameplay/markers.js';
import { stationFootprint, fromUV, HBF } from '../world/station/zones.js';

export const MAP_BOUNDS = { minx: -2100, maxx: 2300, minz: -1750, maxz: 1500 };
const TILE = 300;
const COLORS = {
  land: '#1c2630',
  water: '#26476a',
  park: '#22402f',
  building: '#2c3843',
  tallBuilding: '#3a4856',
  minor: '#4b5866',
  major: '#8996a3',
  path: '#34404b',
  rail: '#5a4f45',
};
const LAYERS = ['water', 'parks', 'path', 'rails', 'buildings', 'tall', 'minor', 'major'];

export class MapRenderer {
  constructor(city) {
    this.tiles = new Map();
    const tileKeys = (b) => {
      const out = [];
      for (let x = Math.floor(b.minx / TILE); x <= Math.floor(b.maxx / TILE); x++)
        for (let z = Math.floor(b.minz / TILE); z <= Math.floor(b.maxz / TILE); z++) out.push(`${x},${z}`);
      return out;
    };
    const tile = (k) => {
      let t = this.tiles.get(k);
      if (!t) {
        t = {};
        for (const l of LAYERS) t[l] = new Path2D();
        this.tiles.set(k, t);
      }
      return t;
    };
    const addRing = (layer, pts) => {
      for (const k of tileKeys(bounds(pts))) {
        const p = tile(k)[layer];
        pts.forEach((q, i) => (i ? p.lineTo(q[0], q[1]) : p.moveTo(q[0], q[1])));
        p.closePath();
      }
    };
    const addLine = (layer, pts) => {
      for (const k of tileKeys(bounds(pts))) {
        const p = tile(k)[layer];
        pts.forEach((q, i) => (i ? p.lineTo(q[0], q[1]) : p.moveTo(q[0], q[1])));
      }
    };
    for (const r of city.water) addRing('water', r);
    for (const r of city.parks) addRing('parks', r);
    // the Hauptbahnhof replaces its OSM footprints: draw the real station outline instead
    for (const b of city.buildings) if (b.pts.length > 2 && !stationFootprint(b.pts)) addRing(b.h > 60 ? 'tall' : 'buildings', b.pts);
    const uv = (pts) => pts.map(([u, v]) => fromUV(u, v));
    addRing('tall', uv([[HBF.hallW, HBF.vN], [HBF.front, HBF.vN], [HBF.front, HBF.vS], [HBF.hallW, HBF.vS]]));
    const t = HBF.terminal;
    addRing('path', uv([[t.u0, t.v0], [t.u1, t.v0], [t.u1, t.v1], [t.u0, t.v1]]));
    for (const r of city.rails) addLine('rails', r.pts);
    this.majorW = 12;
    for (const r of city.roads) {
      if (r.pts.length < 2) continue;
      const kind = RC[r.c][1];
      const cls = kind ? 'path' : r.c <= 3 || r.c === 14 ? 'major' : 'minor';
      if (cls === 'major') this.majorW = Math.max(this.majorW, Math.min(16, roadWidth(r)));
      addLine(cls, r.pts);
    }
  }

  /**
   * Draws the map. `g` must already have the world→screen transform applied;
   * `view` is the visible world rectangle {minx, maxx, minz, maxz}; scale = px per metre.
   */
  drawBase(g, scale, view, detail = true) {
    const keys = [];
    for (let x = Math.floor(view.minx / TILE); x <= Math.floor(view.maxx / TILE); x++) {
      for (let z = Math.floor(view.minz / TILE); z <= Math.floor(view.maxz / TILE); z++) {
        const t = this.tiles.get(`${x},${z}`);
        if (t) keys.push(t);
      }
    }
    const minW = 1.2 / scale;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    const fill = (layer, color) => {
      g.fillStyle = color;
      for (const t of keys) g.fill(t[layer]);
    };
    const stroke = (layer, color, w) => {
      g.strokeStyle = color;
      g.lineWidth = w;
      for (const t of keys) g.stroke(t[layer]);
    };
    fill('water', COLORS.water);
    fill('parks', COLORS.park);
    if (detail) stroke('path', COLORS.path, Math.max(2.5, minW));
    stroke('rails', COLORS.rail, Math.max(2, minW));
    fill('buildings', COLORS.building);
    fill('tall', COLORS.tallBuilding);
    stroke('minor', COLORS.minor, Math.max(7, minW * 1.5));
    stroke('major', COLORS.major, Math.max(this.majorW, minW * 2.2));
  }

  /** Route polyline in world coordinates. */
  static drawRoute(g, pts, scale, color) {
    if (!pts || pts.length < 2) return;
    g.save();
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.beginPath();
    pts.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])));
    g.strokeStyle = 'rgba(0,0,0,0.55)';
    g.lineWidth = 9 / scale;
    g.stroke();
    g.strokeStyle = color;
    g.lineWidth = 5 / scale;
    g.stroke();
    g.restore();
  }
}

export const LAND_COLOR = COLORS.land;

/** Draws a blip icon centred at (x, y) in screen pixels. */
export function drawBlip(g, type, x, y, size = 16, opts = {}) {
  const st = BLIP_STYLES[type] || { color: '#fff', glyph: '?' };
  g.save();
  g.translate(x, y);
  if (type === 'player') {
    g.rotate(opts.rotation || 0);
    g.fillStyle = '#fff';
    g.strokeStyle = '#000';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(0, -size * 0.65);
    g.lineTo(size * 0.45, size * 0.5);
    g.lineTo(0, size * 0.22);
    g.lineTo(-size * 0.45, size * 0.5);
    g.closePath();
    g.fill();
    g.stroke();
  } else if (type === 'cop') {
    const on = Math.sin(performance.now() / 120) > 0;
    g.fillStyle = on ? '#3d7bff' : '#ff3b3b';
    g.strokeStyle = '#000';
    g.lineWidth = 1.5;
    g.beginPath();
    g.arc(0, 0, size * 0.32, 0, Math.PI * 2);
    g.fill();
    g.stroke();
  } else {
    const r = size / 2;
    g.fillStyle = 'rgba(0,0,0,0.6)';
    g.beginPath();
    g.arc(0, 0, r + 1.5, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = st.color;
    g.beginPath();
    if (type === 'waypoint') {
      g.moveTo(0, -r);
      g.lineTo(r, 0);
      g.lineTo(0, r);
      g.lineTo(-r, 0);
      g.closePath();
    } else g.arc(0, 0, r, 0, Math.PI * 2);
    g.fill();
    if (st.glyph && type !== 'waypoint') {
      g.fillStyle = '#111';
      g.font = `800 ${Math.round(size * 0.72)}px 'Barlow Condensed', 'Arial Narrow', sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(st.glyph, 0, size * 0.04);
    }
  }
  g.restore();
}
