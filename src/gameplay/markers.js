/**
 * World markers (glowing cylinders, checkpoint beams, spinning pickups) and the
 * blip registry that the minimap and the full map draw from.
 */
import * as THREE from 'three';
import { ctx } from '../core/context.js';

/** Blip styles: colour + glyph drawn by the map renderer. */
export const BLIP_STYLES = {
  player: { color: '#ffffff', label: 'You' },
  waypoint: { color: '#c86bff', glyph: '◆', label: 'Waypoint' },
  story: { color: '#f3c544', glyph: 'L', label: 'Story mission' },
  objective: { color: '#f3c544', glyph: '●', label: 'Objective' },
  vehicle: { color: '#4fb3ff', glyph: '▲', label: 'Mission vehicle' },
  race: { color: '#ffffff', glyph: '⚑', label: 'Street race' },
  hospital: { color: '#e5484d', glyph: '+', label: 'Hospital' },
  police: { color: '#3d7bff', glyph: 'P', label: 'Police station' },
  garage: { color: '#46c37b', glyph: 'R', label: 'Respray & repair' },
  safehouse: { color: '#ffffff', glyph: '⌂', label: 'Safehouse (save)' },
  job: { color: '#7ad7f0', glyph: '★', label: 'Job' },
  health: { color: '#46c37b', glyph: '♥', label: 'Health' },
  armor: { color: '#3d9bff', glyph: '◈', label: 'Armour' },
  cop: { color: '#3d7bff', glyph: '', label: 'Police unit' },
};

export class Blips {
  constructor() {
    this.list = new Map();
    this.seq = 0;
  }
  add(type, x, z, opts = {}) {
    const id = opts.id || `b${++this.seq}`;
    const b = {
      id,
      type,
      x,
      z,
      label: opts.label || BLIP_STYLES[type]?.label || type,
      short: opts.short ?? true,
      route: !!opts.route,
      minimap: opts.minimap ?? true,
      map: opts.map ?? true,
      flash: !!opts.flash,
    };
    this.list.set(id, b);
    return b;
  }
  remove(b) {
    if (b) this.list.delete(typeof b === 'string' ? b : b.id);
  }
  /** The blip GPS should route to (mission objectives win over the waypoint). */
  routeTarget() {
    let wp = null;
    for (const b of this.list.values()) {
      if (b.route && b.type !== 'waypoint') return b;
      if (b.type === 'waypoint') wp = b;
    }
    return wp;
  }
}

const beamGeo = new THREE.CylinderGeometry(1, 1, 1, 32, 1, true).translate(0, 0.5, 0);
const ringGeo = new THREE.RingGeometry(0.85, 1, 48).rotateX(-Math.PI / 2);

function glowMaterial(color, opacity) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    uniforms: { uColor: { value: new THREE.Color(color) }, uOpacity: { value: opacity }, uTime: { value: 0 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader:
      'uniform vec3 uColor; uniform float uOpacity; uniform float uTime; varying vec2 vUv; void main(){ float a = pow(1.0 - vUv.y, 1.6) * uOpacity * (0.8 + 0.2*sin(uTime*3.0)); gl_FragColor = vec4(uColor * a, a); }',
  });
}

function pickupMesh(kind) {
  const g = new THREE.Group();
  if (kind === 'health') {
    const m = new THREE.MeshStandardMaterial({ color: 0x2ecc71, emissive: 0x1a7a40, emissiveIntensity: 0.8 });
    g.add(new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.18, 0.18), m), new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.55, 0.18), m));
  } else if (kind === 'armor') {
    const m = new THREE.MeshStandardMaterial({ color: 0x3d7bff, emissive: 0x1a3a90, emissiveIntensity: 0.8, metalness: 0.3, roughness: 0.4 });
    g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.22, 0.5, 6), m));
  } else if (kind === 'postcard') {
    const m = new THREE.MeshStandardMaterial({ color: 0xffe08a, emissive: 0xd4a017, emissiveIntensity: 0.6, side: THREE.DoubleSide });
    const card = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.4), m);
    const stamp = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 0.14), new THREE.MeshBasicMaterial({ color: 0xc0392b, side: THREE.DoubleSide }));
    stamp.position.set(0.2, 0.1, 0.002);
    g.add(card, stamp);
  }
  return g;
}

/**
 * 3D markers. Each marker can carry a trigger:
 *   {kind: 'beam'|'ring'|'pickup', x, z, r, color, onFoot, inVehicle, maxKmh, onEnter(marker)}
 */
export class Markers {
  constructor() {
    this.list = [];
  }
  add(opts) {
    const m = { r: 3, color: 0xf3c544, height: 1.4, onFoot: false, inVehicle: false, maxKmh: Infinity, inside: false, ...opts };
    const y = ctx.physics.groundY(m.x, m.z);
    m.y = y;
    const grp = new THREE.Group();
    grp.position.set(m.x, y + 0.02, m.z);
    if (m.kind === 'pickup') {
      m.mesh = pickupMesh(m.pickup);
      m.mesh.position.y = 1;
      grp.add(m.mesh);
      m.r = m.r || 1.2;
    } else {
      m.material = glowMaterial(m.color, m.kind === 'checkpoint' ? 0.55 : 0.4);
      const beam = new THREE.Mesh(beamGeo, m.material);
      beam.scale.set(m.r, m.kind === 'checkpoint' ? 14 : m.height, m.r);
      const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: m.color, transparent: true, opacity: 0.8, depthWrite: false }));
      ring.scale.setScalar(m.r);
      ring.position.y = 0.05;
      grp.add(beam, ring);
    }
    ctx.scene.add(grp);
    m.group = grp;
    this.list.push(m);
    return m;
  }
  remove(m) {
    if (!m) return;
    const i = this.list.indexOf(m);
    if (i >= 0) this.list.splice(i, 1);
    ctx.scene.remove(m.group);
    m.material?.dispose();
  }
  update(dt) {
    const player = ctx.player;
    const p = player.position;
    const t = ctx.simTime;
    for (const m of this.list.slice()) {
      if (m.material) m.material.uniforms.uTime.value = t;
      if (m.mesh) {
        m.mesh.rotation.y += dt * 2;
        m.mesh.position.y = 1 + Math.sin(t * 2.5) * 0.12;
      }
      m.group.visible = !m.hidden;
      if (m.hidden || !m.onEnter) continue;
      const d = Math.hypot(p.x - m.x, p.z - m.z);
      let ok = d < m.r && Math.abs(p.y - m.y) < 6;
      if (m.onFoot && player.vehicle) ok = false;
      if (m.inVehicle && !player.vehicle) ok = false;
      if (ok && player.vehicle && Math.abs(player.vehicle.kmh) > m.maxKmh) ok = false;
      if (ok && !m.inside) {
        m.inside = true;
        m.onEnter(m);
      } else if (!ok) m.inside = false;
    }
  }
  clear(filter = () => true) {
    for (const m of this.list.slice()) if (filter(m)) this.remove(m);
  }
}
