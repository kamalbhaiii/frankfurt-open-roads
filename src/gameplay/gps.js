/**
 * GPS: keeps a road route from the player to the active target (mission objective
 * or the player's waypoint) and reroutes when the player leaves it.
 */
import { ctx } from '../core/context.js';
import { segDist } from '../core/math.js';

export class Gps {
  constructor() {
    this.route = null;
    this.target = null;
    this.timer = 0;
    this.color = '#c86bff';
    this.distance = 0;
  }

  offRoute(p) {
    const pts = this.route?.points;
    if (!pts) return true;
    let best = Infinity;
    for (let i = 0; i < pts.length - 1; i++) best = Math.min(best, segDist(p.x, p.z, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]).d);
    return best > 25;
  }

  update(dt) {
    const target = ctx.blips.routeTarget();
    const p = ctx.player.position;
    if (!target) {
      this.route = null;
      this.target = null;
      return;
    }
    this.color = target.type === 'waypoint' ? '#c86bff' : target.type === 'vehicle' ? '#4fb3ff' : '#f3c544';
    const moved = !this.target || this.target !== target || Math.hypot(this.tx - target.x, this.tz - target.z) > 15;
    this.timer -= dt;
    if (moved || (this.timer <= 0 && this.offRoute(p))) {
      this.timer = 1.5;
      this.target = target;
      this.tx = target.x;
      this.tz = target.z;
      this.route = ctx.roads.route(p.x, p.z, target.x, target.z, !!ctx.player.vehicle);
      if (this.route) {
        this.route.points.unshift([p.x, p.z]);
        this.route.points.push([target.x, target.z]);
      }
    }
    this.distance = Math.hypot(target.x - p.x, target.z - p.z);
    if (this.route) {
      // trim the part already driven
      const pts = this.route.points;
      let cut = 0;
      for (let i = 1; i < Math.min(pts.length - 1, 12); i++) if (Math.hypot(pts[i][0] - p.x, pts[i][1] - p.z) < 12) cut = i;
      if (cut) pts.splice(0, cut);
      pts[0] = [p.x, p.z];
      let len = 0;
      for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      this.distance = len;
    }
    // reached the waypoint: clear it
    if (target.type === 'waypoint' && Math.hypot(target.x - p.x, target.z - p.z) < 18) {
      ctx.map.clearWaypoint();
      ctx.audio.checkpoint();
    }
  }
}
