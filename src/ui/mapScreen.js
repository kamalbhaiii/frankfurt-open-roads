/**
 * Full-screen interactive map (pause menu tab): drag to pan, wheel/pinch/buttons to
 * zoom, click to set or clear a waypoint, legend filters, hover labels.
 */
import { ctx } from '../core/context.js';
import { events } from '../core/events.js';
import { clamp } from '../core/math.js';
import { BLIP_STYLES } from '../gameplay/markers.js';
import { MAP_BOUNDS, LAND_COLOR, MapRenderer, drawBlip } from './mapRenderer.js';

const LEGEND = ['waypoint', 'objective', 'busdepot', 'taxirank', 'courierdepot', 'ambulancedepot', 'towdepot', 'scooterdepot', 'race', 'safehouse', 'hospital', 'police', 'garage', 'health', 'armor'];
const MIN_SCALE = 0.12,
  MAX_SCALE = 3;

export class MapScreen {
  constructor(renderer) {
    this.renderer = renderer;
    this.view = { x: 0, z: 0, scale: 0.35 };
    this.hidden = new Set();
    this.waypoint = null;
    this.el = null;
  }

  setWaypoint(x, z) {
    this.clearWaypoint(false);
    this.waypoint = ctx.blips.add('waypoint', x, z, { id: 'waypoint', route: true, short: false, label: 'Waypoint' });
    events.emit('waypoint:changed', { point: { x, z } });
    ctx.audio.uiSelect();
  }
  clearWaypoint(sound = true) {
    if (!this.waypoint) return;
    ctx.blips.remove(this.waypoint);
    this.waypoint = null;
    events.emit('waypoint:changed', { point: null });
    if (sound) ctx.audio.uiBack();
  }

  /** Builds the DOM into a container and starts listening. */
  mount(container) {
    container.innerHTML = `
      <div class="map-wrap">
        <div class="map-canvas" tabindex="0" aria-label="City map. Drag to pan, scroll to zoom, click to set a waypoint.">
          <canvas></canvas>
          <div class="map-tools">
            <button data-z="in" title="Zoom in">+</button>
            <button data-z="out" title="Zoom out">−</button>
            <button data-z="me" title="Centre on me">◎</button>
            <button data-z="clear" title="Clear waypoint">✕</button>
          </div>
          <div class="map-hint">Drag to pan · Scroll to zoom · Click to set a waypoint · Right-click to clear</div>
          <div class="map-tip hidden"></div>
        </div>
        <div class="map-side">
          <div class="section-title">Legend</div>
          <div class="legend"></div>
          <div class="section-title">Location</div>
          <div class="map-loc" style="font-size:13px;color:var(--muted);line-height:1.5"></div>
        </div>
      </div>`;
    this.el = container.querySelector('.map-canvas');
    this.canvas = this.el.querySelector('canvas');
    this.tip = this.el.querySelector('.map-tip');
    const legend = container.querySelector('.legend');
    for (const type of LEGEND) {
      const st = BLIP_STYLES[type];
      const b = document.createElement('button');
      b.className = `legend-item${this.hidden.has(type) ? ' off' : ''}`;
      b.innerHTML = `<span class="legend-dot" style="background:${st.color}">${type === 'waypoint' ? '◆' : st.glyph || ''}</span>${st.label}`;
      b.onclick = () => {
        if (this.hidden.has(type)) this.hidden.delete(type);
        else this.hidden.add(type);
        b.classList.toggle('off');
        this.draw();
      };
      legend.appendChild(b);
    }
    const p = ctx.player.position;
    container.querySelector('.map-loc').textContent = `${ctx.game.district(p)} · ${ctx.streetIndex.nearest(p.x, p.z) || 'off-road'}`;
    this.centerOnPlayer();
    this.bind();
    this.resize();
    this.el.focus();
  }

  centerOnPlayer() {
    const p = ctx.player.position;
    this.view.x = p.x;
    this.view.z = p.z;
    this.draw();
  }

  resize() {
    if (!this.el) return;
    const r = this.el.getBoundingClientRect();
    const dpr = Math.min(devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    this.dpr = dpr;
    this.draw();
  }

  screenToWorld(sx, sy) {
    const v = this.view;
    const W = this.canvas.width / this.dpr,
      H = this.canvas.height / this.dpr;
    return { x: v.x + (sx - W / 2) / v.scale, z: v.z + (sy - H / 2) / v.scale };
  }
  worldToScreen(x, z) {
    const v = this.view;
    const W = this.canvas.width / this.dpr,
      H = this.canvas.height / this.dpr;
    return [(x - v.x) * v.scale + W / 2, (z - v.z) * v.scale + H / 2];
  }

  zoomAt(factor, sx, sy) {
    const before = this.screenToWorld(sx, sy);
    this.view.scale = clamp(this.view.scale * factor, MIN_SCALE, MAX_SCALE);
    const after = this.screenToWorld(sx, sy);
    this.view.x += before.x - after.x;
    this.view.z += before.z - after.z;
    this.clampView();
    this.draw();
  }

  clampView() {
    const B = MAP_BOUNDS;
    this.view.x = clamp(this.view.x, B.minx, B.maxx);
    this.view.z = clamp(this.view.z, B.minz, B.maxz);
  }

  bind() {
    const el = this.el;
    const local = (e) => {
      const r = el.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    const pointers = new Map();
    let drag = null,
      moved = 0,
      pinch = null;
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, local(e));
      if (pointers.size === 1) {
        drag = { start: local(e), view: { ...this.view } };
        moved = 0;
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), scale: this.view.scale };
        drag = null;
      }
      el.classList.add('dragging');
    });
    el.addEventListener('pointermove', (e) => {
      const [sx, sy] = local(e);
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, [sx, sy]);
      if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        const target = clamp((pinch.scale * d) / pinch.d, MIN_SCALE, MAX_SCALE);
        this.zoomAt(target / this.view.scale, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
        return;
      }
      if (drag) {
        const dx = sx - drag.start[0],
          dy = sy - drag.start[1];
        moved = Math.max(moved, Math.hypot(dx, dy));
        this.view.x = drag.view.x - dx / this.view.scale;
        this.view.z = drag.view.z - dy / this.view.scale;
        this.clampView();
        this.draw();
      } else this.hover(sx, sy);
    });
    const up = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      el.classList.remove('dragging');
      if (drag && moved < 6 && e.button === 0) {
        const [sx, sy] = local(e);
        this.clickAt(sx, sy);
      }
      drag = null;
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.clearWaypoint();
      this.draw();
    });
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const [sx, sy] = local(e);
        this.zoomAt(e.deltaY < 0 ? 1.18 : 1 / 1.18, sx, sy);
      },
      { passive: false },
    );
    el.addEventListener('keydown', (e) => {
      const step = 80 / this.view.scale;
      const W = this.canvas.width / this.dpr,
        H = this.canvas.height / this.dpr;
      const k = e.code;
      if (k === 'ArrowLeft' || k === 'KeyA') this.view.x -= step;
      else if (k === 'ArrowRight' || k === 'KeyD') this.view.x += step;
      else if (k === 'ArrowUp' || k === 'KeyW') this.view.z -= step;
      else if (k === 'ArrowDown' || k === 'KeyS') this.view.z += step;
      else if (k === 'Equal' || k === 'NumpadAdd') return this.zoomAt(1.25, W / 2, H / 2);
      else if (k === 'Minus' || k === 'NumpadSubtract') return this.zoomAt(0.8, W / 2, H / 2);
      else if (k === 'Enter' || k === 'Space') return this.clickAt(W / 2, H / 2);
      else if (k === 'Backspace' || k === 'Delete') {
        this.clearWaypoint();
        return this.draw();
      } else return;
      e.preventDefault();
      this.clampView();
      this.draw();
    });
    this.el.querySelector('.map-tools').addEventListener('click', (e) => {
      const z = e.target.closest('button')?.dataset.z;
      const W = this.canvas.width / this.dpr,
        H = this.canvas.height / this.dpr;
      if (z === 'in') this.zoomAt(1.4, W / 2, H / 2);
      else if (z === 'out') this.zoomAt(1 / 1.4, W / 2, H / 2);
      else if (z === 'me') this.centerOnPlayer();
      else if (z === 'clear') {
        this.clearWaypoint();
        this.draw();
      }
      e.stopPropagation();
    });
    this.el.querySelector('.map-tools').addEventListener('pointerdown', (e) => e.stopPropagation());
    this.onResize = () => this.resize();
    addEventListener('resize', this.onResize);
  }

  unmount() {
    removeEventListener('resize', this.onResize);
    this.el = null;
  }

  clickAt(sx, sy) {
    if (this.waypoint) {
      const [wx, wy] = this.worldToScreen(this.waypoint.x, this.waypoint.z);
      if (Math.hypot(wx - sx, wy - sy) < 14) {
        this.clearWaypoint();
        this.draw();
        return;
      }
    }
    const w = this.screenToWorld(sx, sy);
    const snap = ctx.roads.nearest(w.x, w.z, 200);
    this.setWaypoint(snap ? snap.x : w.x, snap ? snap.z : w.z);
    ctx.gps.update(0);
    this.draw();
  }

  hover(sx, sy) {
    let best = null,
      bd = 14;
    for (const b of ctx.blips.list.values()) {
      if (!b.map || this.hidden.has(b.type)) continue;
      const [x, y] = this.worldToScreen(b.x, b.z);
      const d = Math.hypot(x - sx, y - sy);
      if (d < bd) {
        bd = d;
        best = b;
      }
    }
    let text = best?.label;
    if (!text && this.view.scale > 0.6) {
      const w = this.screenToWorld(sx, sy);
      text = ctx.streetIndex.nearest(w.x, w.z, 12);
    }
    if (text) {
      this.tip.textContent = text;
      this.tip.style.left = `${sx}px`;
      this.tip.style.top = `${sy}px`;
      this.tip.classList.remove('hidden');
    } else this.tip.classList.add('hidden');
  }

  draw() {
    if (!this.el) return;
    const g = this.canvas.getContext('2d');
    const v = this.view,
      dpr = this.dpr;
    const W = this.canvas.width / dpr,
      H = this.canvas.height / dpr;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = LAND_COLOR;
    g.fillRect(0, 0, W, H);
    g.save();
    g.translate(W / 2, H / 2);
    g.scale(v.scale, v.scale);
    g.translate(-v.x, -v.z);
    const hw = W / 2 / v.scale,
      hh = H / 2 / v.scale;
    this.renderer.drawBase(g, v.scale, { minx: v.x - hw, maxx: v.x + hw, minz: v.z - hh, maxz: v.z + hh }, v.scale > 0.3);
    if (ctx.gps.route) MapRenderer.drawRoute(g, ctx.gps.route.points, v.scale, ctx.gps.color);
    g.restore();
    // district labels when zoomed out
    if (v.scale < 0.7) {
      g.font = "italic 800 15px 'Barlow Condensed', sans-serif";
      g.textAlign = 'center';
      g.fillStyle = 'rgba(255,255,255,0.4)';
      for (const d of ctx.districts) {
        const [x, y] = this.worldToScreen(d.x, d.z);
        g.fillText(d.n.toUpperCase(), x, y);
      }
    }
    for (const b of ctx.blips.list.values()) {
      if (!b.map || this.hidden.has(b.type)) continue;
      const [x, y] = this.worldToScreen(b.x, b.z);
      if (x < -20 || y < -20 || x > W + 20 || y > H + 20) continue;
      drawBlip(g, b.type, x, y, 18);
    }
    for (const u of ctx.police.units) {
      const p = u.officer || u.car.body.translation();
      const [x, y] = this.worldToScreen(p.x, p.z);
      drawBlip(g, 'cop', x, y, 20);
    }
    const P = ctx.player.position;
    const [px, py] = this.worldToScreen(P.x, P.z);
    const heading = ctx.player.vehicle ? ctx.player.vehicle.yaw : ctx.player.yaw;
    drawBlip(g, 'player', px, py, 22, { rotation: Math.PI - heading });
    // scale bar
    const metres = [50, 100, 250, 500, 1000].find((m) => m * v.scale > 70) || 1000;
    g.fillStyle = 'rgba(255,255,255,0.8)';
    g.fillRect(W - 24 - metres * v.scale, H - 22, metres * v.scale, 3);
    g.font = '12px Barlow, sans-serif';
    g.textAlign = 'right';
    g.fillText(metres >= 1000 ? `${metres / 1000} km` : `${metres} m`, W - 24, H - 28);
  }
}
