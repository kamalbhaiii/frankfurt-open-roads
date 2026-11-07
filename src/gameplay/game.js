/**
 * Game flow: state machine (title → playing ⇄ paused, hospital/arrest sequences),
 * crime handling, respawns, save/load and per-frame action handling.
 */
import { ctx } from '../core/context.js';
import { ECONOMY, STORAGE_KEYS, SAVE_SLOTS, DISTRICTS, FIXED_STEP } from '../core/config.js';
import { events } from '../core/events.js';
import { input } from '../core/input.js';
import { storage } from '../core/storage.js';
import { formatMoney } from '../core/math.js';
import { POSTCARD_COUNT } from './services.js';
import { STORY, RACES } from './missionData.js';
import { Stats } from './stats.js';

export const SAVE_VERSION = 1;

export class Game {
  constructor() {
    this.state = 'title'; // title | playing | paused | wasted | busted
    this.controlsLocked = false;
    this.cutscene = false;
    this.lastPoliceHit = 0;
    this.accumulator = 0;
  }

  get paused() {
    return this.state !== 'playing' && this.state !== 'wasted' && this.state !== 'busted';
  }

  wireEvents() {
    events.on('crime', (c) => this.onCrime(c));
    events.on('player:died', () => this.onDeath());
    events.on('player:arrested', () => this.onArrest());
    events.on('vehicle:crash', ({ car, impact }) => this.onCrash(car, impact));
    events.on('wanted:changed', ({ level, prev }) => {
      if (level > prev) ctx.audio.wantedUp();
      ctx.stats.max('maxWanted', level);
    });
  }

  onCrime({ type, x, z }) {
    const witnessedByPolice = ctx.police.nearby(x, z);
    const witnesses = ctx.peds.witnesses(x, z);
    ctx.wanted.report(type, { witnessedByPolice, witnesses });
  }

  onCrash(car, impact) {
    const player = ctx.player;
    const pp = car.body.translation();
    const cp = ctx.camera.position;
    if (Math.hypot(pp.x - cp.x, pp.z - cp.z) < 120) ctx.audio.crash(impact);
    ctx.peds.scare(pp.x, pp.z, 15);
    if (car !== player.vehicle) return;
    ctx.stats.add('crashes', 1);
    ctx.cameraRig.shake = Math.min(1, impact / 15);
    if (impact > 10) player.damage((impact - 10) * 2.2, 'crash');
    // rammed a patrol car?
    if (ctx.simTime - this.lastPoliceHit > 3) {
      const cop = ctx.vehicles.nearest(pp, 7, (c) => c.isPolice && c !== car);
      if (cop) {
        this.lastPoliceHit = ctx.simTime;
        events.emit('crime', { type: 'hitPolice', x: pp.x, z: pp.z });
      }
    }
  }

  onDeath() {
    if (this.state !== 'playing') return;
    this.state = 'wasted';
    this.controlsLocked = true;
    ctx.stats.add('timesWasted', 1);
    const player = ctx.player;
    if (player.vehicle) player.exitVehicle(true);
    player.knockdown = 6;
    player.kx = player.kz = 0;
    ctx.missions.abort('You were hospitalised.');
    this.sequence('HOSPITALISED', () => {
      const p = ctx.player.position;
      const h = ctx.services.nearest('hospital', p.x, p.z);
      const fee = Math.max(ECONOMY.hospitalMin, Math.round(ctx.player.money * ECONOMY.hospitalFee));
      this.respawnAt(h, fee, `Medical bill: ${formatMoney(Math.min(fee, ctx.player.money))}`);
    });
  }

  onArrest() {
    if (this.state !== 'playing') return;
    this.state = 'busted';
    this.controlsLocked = true;
    ctx.stats.add('timesBusted', 1);
    ctx.missions.abort('You were arrested.');
    const player = ctx.player;
    if (player.vehicle) player.exitVehicle(true);
    player.ch.play('idle', 0.2);
    this.sequence('ARRESTED', () => {
      const p = ctx.player.position;
      const st = ctx.services.nearest('police', p.x, p.z);
      const fee = Math.max(ECONOMY.arrestMin, Math.round(ctx.player.money * ECONOMY.arrestFee));
      this.respawnAt(st, fee, `Bail paid: ${formatMoney(Math.min(fee, ctx.player.money))}`);
    });
  }

  /** Slow motion + desaturated screen + big title, then fade and respawn. */
  sequence(title, respawn) {
    ctx.timeScale = 0.3;
    ctx.cameraRig.startOrbit(ctx.player.position);
    ctx.audio.death();
    ctx.hud.showDeath(title);
    setTimeout(() => {
      ctx.hud.fade(true);
      setTimeout(() => {
        respawn();
        ctx.timeScale = 1;
        ctx.cameraRig.stopOrbit();
        ctx.hud.hideDeath();
        this.state = 'playing';
        this.controlsLocked = false;
        setTimeout(() => ctx.hud.fade(false), 300);
      }, 900);
    }, 4200);
  }

  respawnAt(place, fee, note) {
    const player = ctx.player;
    if (player.vehicle) player.exitVehicle(true);
    ctx.wanted.clear();
    ctx.police.reset();
    player.health = 100;
    player.armor = 0;
    player.knockdown = 0;
    player.addMoney(-fee, 'Fee');
    player.teleport(place.x, place.z, place.yaw);
    ctx.cameraRig.yaw = place.yaw + Math.PI;
    if (ctx.env.timeMode !== 'real') ctx.env.advanceHours(3);
    events.emit('notify', { text: note, ms: 3500 });
  }

  /** Fade to black, run fn, fade back (garages, sleeping). */
  fadeAction(fn) {
    this.controlsLocked = true;
    ctx.hud.fade(true);
    setTimeout(() => {
      fn();
      setTimeout(() => {
        ctx.hud.fade(false);
        this.controlsLocked = false;
      }, 400);
    }, 600);
  }

  /** Discrete per-frame actions (edge-triggered input). */
  handleActions() {
    if (input.pressed('pause')) {
      ctx.menus.openPause();
      return;
    }
    if (input.pressed('map')) {
      ctx.menus.openPause('map');
      return;
    }
    if (this.state !== 'playing' || this.controlsLocked) return;
    const player = ctx.player;
    if (input.pressed('vehicle')) {
      if (player.vehicle) player.exitVehicle();
      else if (!player.enterVehicle()) events.emit('notify', { text: 'No vehicle nearby' });
    }
    if (input.pressed('horn') && player.vehicle) {
      if (player.vehicle.isPolice) player.vehicle.siren = !player.vehicle.siren;
      else ctx.audio.horn(null, 1);
      const p = player.position;
      ctx.peds.scare(p.x, p.z, 14);
    }
    if (input.pressed('camera')) ctx.cameraRig.cycle();
    if (input.pressed('radio') && player.vehicle && ctx.audio.radio) ctx.audio.radio.next();
    if (input.pressed('job')) ctx.missions.toggleJob();
    if (input.pressed('unstuck')) player.unstuck();
    if (input.pressed('timeSpeed')) ctx.env.cycleTimeMode();
  }

  /** Fixed-timestep simulation. */
  simulate(dt) {
    this.accumulator += dt;
    let n = 0;
    while (this.accumulator >= FIXED_STEP && n < 4) {
      ctx.player.step(FIXED_STEP);
      ctx.traffic.update(FIXED_STEP, ctx.player.position);
      ctx.vehicles.step(FIXED_STEP);
      ctx.physics.step(FIXED_STEP);
      this.accumulator -= FIXED_STEP;
      ctx.simTime += FIXED_STEP;
      n++;
    }
    if (n === 4) this.accumulator = 0;
  }

  // ---------------------------------------------------------------- save / load
  completion() {
    const m = ctx.missions.progress;
    const story = Math.min(m.story, STORY.length) / STORY.length;
    const races = RACES.filter((r) => m.races[r.id]).length / RACES.length;
    const cards = ctx.services.found.size / POSTCARD_COUNT;
    const jobs = Math.min(m.jobsDone, 15) / 15;
    return Math.round((story * 0.45 + races * 0.15 + cards * 0.25 + jobs * 0.15) * 100);
  }

  district(p) {
    let best = DISTRICTS[0],
      bd = Infinity;
    for (const d of DISTRICTS) {
      const dd = Math.hypot(d.x - p.x, d.z - p.z);
      if (dd < bd) {
        bd = dd;
        best = d;
      }
    }
    return best.n;
  }

  serialize() {
    const player = ctx.player;
    const p = player.position;
    return {
      version: SAVE_VERSION,
      savedAt: Date.now(),
      label: `${this.district(p)} · ${this.completion()}% · ${formatMoney(player.money)}`,
      gameTime: ctx.env.gameTime,
      player: { x: p.x, z: p.z, yaw: player.vehicle ? player.vehicle.yaw : player.yaw, health: player.health, armor: player.armor, money: player.money },
      missions: ctx.missions.serialize(),
      services: ctx.services.serialize(),
      stats: ctx.stats.values,
    };
  }

  save(slot) {
    if (ctx.wanted.level > 0) {
      events.emit('help', { text: 'You can’t save while the police are after you.' });
      return false;
    }
    const ok = storage.set(STORAGE_KEYS.save(slot), this.serialize());
    events.emit('notify', { text: ok ? 'Game saved' : 'Saving is unavailable in this browser', ms: 2000 });
    return ok;
  }

  autosave() {
    if (ctx.wanted.level === 0) storage.set(STORAGE_KEYS.save('auto'), this.serialize());
  }

  listSaves() {
    const out = [];
    for (const slot of ['auto', ...Array.from({ length: SAVE_SLOTS }, (_, i) => String(i + 1))]) out.push({ slot, data: storage.get(STORAGE_KEYS.save(slot)) });
    return out;
  }

  latestSave() {
    return this.listSaves()
      .filter((s) => s.data?.version === SAVE_VERSION)
      .sort((a, b) => b.data.savedAt - a.data.savedAt)[0];
  }

  load(data) {
    if (!data || data.version !== SAVE_VERSION) return false;
    const player = ctx.player;
    ctx.wanted.clear();
    ctx.police.reset();
    ctx.missions.abort('');
    player.health = data.player.health;
    player.armor = data.player.armor;
    player.money = data.player.money;
    player.teleport(data.player.x, data.player.z, data.player.yaw);
    ctx.cameraRig.yaw = data.player.yaw + Math.PI;
    ctx.stats = new Stats(data.stats);
    ctx.services.restore(data.services);
    ctx.missions.restore(data.missions);
    if (ctx.env.timeMode !== 'real') ctx.env.gameTime = data.gameTime;
    return true;
  }

  newGame() {
    const player = ctx.player;
    ctx.stats = new Stats();
    player.health = 100;
    player.armor = 0;
    player.money = ECONOMY.startMoney;
    const s = ctx.spawn;
    player.teleport(s.x, s.z, s.yaw);
    ctx.cameraRig.yaw = s.yaw + Math.PI;
    ctx.services.restore({});
    ctx.missions.restore({});
  }
}
