/**
 * Fixed services and collectibles: hospitals and police stations (respawn points),
 * respray garages, the safehouse (save + sleep), health/armour pickups and the
 * 25 hidden postcards.
 */
import { ctx } from '../core/context.js';
import { SERVICES, ECONOMY, toLocal } from '../core/config.js';
import { events } from '../core/events.js';
import { createRng, formatMoney } from '../core/math.js';
import { kerbSpot, parkingSpot } from './places.js';

export const POSTCARD_COUNT = 25;
const PICKUP_RESPAWN = 120;

export class Services {
  constructor() {
    this.places = [];
    this.pickups = [];
    this.postcards = [];
    this.found = new Set();
  }

  build() {
    for (const s of SERVICES) {
      const [lx, lz] = toLocal(s.lat, s.lon);
      const foot = kerbSpot(lx, lz);
      const drive = parkingSpot(lx, lz);
      const place = { ...s, x: foot.x, z: foot.z, yaw: foot.yaw, drive };
      this.places.push(place);
      ctx.blips.add(s.kind, foot.x, foot.z, { label: s.name, short: s.kind !== 'garage' });
      if (s.kind === 'garage') {
        ctx.markers.add({ kind: 'beam', x: drive.x, z: drive.z, r: 3.5, color: 0x46c37b, inVehicle: true, maxKmh: 15, onEnter: () => this.respray(place) });
      } else if (s.kind === 'safehouse') {
        ctx.markers.add({ kind: 'beam', x: foot.x, z: foot.z, r: 1.4, color: 0xffffff, onFoot: true, onEnter: () => events.emit('safehouse', { place }) });
      } else if (s.kind === 'hospital') {
        this.addPickup('health', foot.x + Math.sin(foot.yaw) * 4, foot.z + Math.cos(foot.yaw) * 4);
      } else if (s.kind === 'police') {
        this.addPickup('armor', foot.x + Math.sin(foot.yaw) * 4, foot.z + Math.cos(foot.yaw) * 4);
      }
    }
    // a few extra health packs around the centre
    const rng = createRng(4242);
    for (let i = 0; i < 6; i++) {
      const p = kerbSpot(-1200 + rng() * 2400, -1100 + rng() * 2000);
      this.addPickup('health', p.x, p.z);
    }
    // postcards: tucked next to the skyline's towers (deterministic)
    const towers = ctx.city.names.slice().sort((a, b) => a.name.localeCompare(b.name));
    const prng = createRng(2025);
    for (let i = 0; i < POSTCARD_COUNT && towers.length; i++) {
      const t = towers.splice(Math.floor(prng() * towers.length), 1)[0];
      const p = kerbSpot(t.x + (prng() - 0.5) * 30, t.z + (prng() - 0.5) * 30);
      const id = `pc${i}`;
      const m = ctx.markers.add({ kind: 'pickup', pickup: 'postcard', x: p.x, z: p.z, r: 1.4, onEnter: () => this.collectPostcard(id, m), label: t.name });
      this.postcards.push({ id, marker: m, name: t.name });
    }
  }

  addPickup(kind, x, z) {
    const pk = { kind, x, z, respawn: 0 };
    pk.marker = ctx.markers.add({ kind: 'pickup', pickup: kind, x, z, r: 1.3, onEnter: () => this.collect(pk) });
    this.pickups.push(pk);
  }

  collect(pk) {
    const p = ctx.player;
    if (pk.respawn > 0) return;
    if (pk.kind === 'health') {
      if (p.health >= 100) return;
      p.heal(100);
      events.emit('notify', { text: 'Health restored' });
    } else {
      if (p.armor >= 100) return;
      p.armor = 100;
      events.emit('notify', { text: 'Armour' });
    }
    ctx.audio.pickup();
    pk.respawn = PICKUP_RESPAWN;
    pk.marker.hidden = true;
  }

  collectPostcard(id, marker) {
    if (this.found.has(id)) return;
    this.found.add(id);
    marker.hidden = true;
    ctx.stats.values.postcards = this.found.size;
    ctx.player.addMoney(100, 'Postcard');
    ctx.audio.pickup();
    const n = this.found.size;
    events.emit('notify', { text: `Postcard ${n}/${POSTCARD_COUNT}`, ms: 2500 });
    if (n === POSTCARD_COUNT) {
      ctx.player.addMoney(2500, 'All postcards');
      events.emit('bigtext', { text: 'ALL POSTCARDS FOUND · €2.500', ms: 4000 });
    }
  }

  respray(place) {
    const p = ctx.player;
    const car = p.vehicle;
    if (!car) return;
    if (car.isPolice) {
      events.emit('help', { text: 'They won’t touch a patrol car here.' });
      return;
    }
    const cost = ctx.wanted.level > 0 ? ECONOMY.respray : car.health < 1000 ? ECONOMY.repair : 0;
    if (!cost) {
      events.emit('help', { text: `${place.name}: your car is already in perfect shape.` });
      return;
    }
    if (p.money < cost) {
      events.emit('help', { text: `${place.name}: you need ${formatMoney(cost)}.` });
      return;
    }
    if (ctx.police.units.some((u) => u.sees && Math.hypot(u.car.position.x - car.position.x, u.car.position.z - car.position.z) < 45)) {
      events.emit('help', { text: 'The police are watching. Lose them first.' });
      return;
    }
    ctx.game.fadeAction(() => {
      p.addMoney(-cost, 'Respray');
      car.repair();
      if (ctx.wanted.level > 0) {
        car.respray();
        ctx.wanted.clear();
        ctx.police.disengageAll();
      }
      events.emit('notify', { text: `New paint, no questions · ${formatMoney(cost)}`, ms: 2500 });
      ctx.audio.cash();
    });
  }

  nearest(kind, x, z) {
    let best = null,
      bd = Infinity;
    for (const p of this.places) {
      if (p.kind !== kind) continue;
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    return best;
  }

  update(dt) {
    for (const pk of this.pickups) {
      if (pk.respawn > 0) {
        pk.respawn -= dt;
        if (pk.respawn <= 0) pk.marker.hidden = false;
      }
    }
  }

  serialize() {
    return { postcards: [...this.found] };
  }
  restore(data) {
    this.found = new Set(data?.postcards || []);
    for (const pc of this.postcards) pc.marker.hidden = this.found.has(pc.id);
    ctx.stats.values.postcards = this.found.size;
  }
}
