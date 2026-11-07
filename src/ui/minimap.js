/**
 * HUD minimap: rotating (or north-up) radar with the GPS route, blips clamped to
 * the edge, police units and a speed-dependent zoom.
 */
import { ctx } from '../core/context.js';
import { settings } from '../core/settings.js';
import { clamp, lerp } from '../core/math.js';
import { LAND_COLOR, MapRenderer, drawBlip } from './mapRenderer.js';

export class Minimap {
  constructor(canvas, renderer) {
    this.canvas = canvas;
    this.g = canvas.getContext('2d');
    this.renderer = renderer;
    this.zoom = 1.6;
  }

  draw() {
    const { g, canvas } = this;
    const W = canvas.width,
      H = canvas.height;
    const player = ctx.player;
    const P = player.position;
    const car = player.vehicle;
    const rotate = settings.get('minimapRotate');
    // rotating so the camera's view direction points up the screen
    const rot = rotate ? ctx.cameraRig.yaw : 0;
    const kmh = car ? Math.abs(car.kmh || 0) : 0;
    this.zoom = lerp(this.zoom, car ? clamp(0.9 - kmh / 260, 0.45, 0.9) : 1.3, 0.05);
    const scale = this.zoom * (W / 240); // px per metre

    g.save();
    g.clearRect(0, 0, W, H);
    g.beginPath();
    g.roundRect(0, 0, W, H, 16);
    g.clip();
    g.fillStyle = LAND_COLOR;
    g.fillRect(0, 0, W, H);
    // player sits slightly below centre so you see more ahead
    const cx = W / 2,
      cy = H * 0.6;
    g.translate(cx, cy);
    g.rotate(rot);
    g.scale(scale, scale);
    g.translate(-P.x, -P.z);
    const reach = Math.hypot(W, H) / scale;
    this.renderer.drawBase(g, scale, { minx: P.x - reach, maxx: P.x + reach, minz: P.z - reach, maxz: P.z + reach }, scale > 1.2);
    if (ctx.gps.route) MapRenderer.drawRoute(g, ctx.gps.route.points, scale, ctx.gps.color);
    g.restore();

    // blips (screen space, clamped to the edge)
    const cs = Math.cos(rot),
      sn = Math.sin(rot);
    const toScreen = (x, z) => {
      const dx = (x - P.x) * scale,
        dz = (z - P.z) * scale;
      return [cx + dx * cs - dz * sn, cy + dx * sn + dz * cs];
    };
    g.save();
    g.beginPath();
    g.roundRect(0, 0, W, H, 16);
    g.clip();
    const pad = 14;
    for (const b of ctx.blips.list.values()) {
      if (!b.minimap) continue;
      let [sx, sy] = toScreen(b.x, b.z);
      const inside = sx > pad && sx < W - pad && sy > pad && sy < H - pad;
      if (!inside) {
        if (b.short && b.type !== 'waypoint') continue;
        sx = clamp(sx, pad, W - pad);
        sy = clamp(sy, pad, H - pad);
      }
      drawBlip(g, b.type, sx, sy, 20);
    }
    for (const u of ctx.police.units) {
      const p = u.officer || u.car.body.translation();
      const [sx, sy] = toScreen(p.x, p.z);
      if (sx > 0 && sx < W && sy > 0 && sy < H) drawBlip(g, 'cop', sx, sy, 22);
    }
    // heat search radius
    if (ctx.wanted.level > 0) {
      g.strokeStyle = ctx.wanted.searching ? 'rgba(61,123,255,0.5)' : 'rgba(255,59,59,0.5)';
      g.lineWidth = 3;
      g.beginPath();
      g.arc(cx, cy, ctx.wanted.searchRadius * scale, 0, Math.PI * 2);
      g.stroke();
    }
    const heading = car ? car.yaw : player.yaw;
    drawBlip(g, 'player', cx, cy, 22, { rotation: Math.PI - heading + rot });
    // north marker on the edge (north is -z in world space)
    const e = 16;
    const tx = Math.abs(sn) > 1e-4 ? (sn > 0 ? W - e - cx : cx - e) / Math.abs(sn) : Infinity;
    const ty = Math.abs(cs) > 1e-4 ? (cs > 0 ? cy - e : H - e - cy) / Math.abs(cs) : Infinity;
    const t = Math.min(tx, ty);
    g.fillStyle = '#fff';
    g.font = "800 22px 'Barlow Condensed', sans-serif";
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('N', cx + sn * t, cy - cs * t);
    g.restore();
  }
}
