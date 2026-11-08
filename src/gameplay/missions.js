/**
 * Activity runner for jobs and races. An activity is a list of steps executed in order;
 * jobs generate a new list each round (single-round jobs end after one). Step types:
 *   say {text, ms}                    – subtitle line
 *   spawnVehicle {ref, kind, at}      – mission vehicle (at: {x,z,yaw})
 *   enter {ref|kind|any, text}        – get into a vehicle
 *   goto {at, r, text, onFoot, inVehicle, maxKmh}
 *   deliver {ref, at, r, text}        – bring a mission vehicle somewhere
 *   loseHeat {text}                   – get the heat level to zero
 *   heat {level}                      – raises the heat level
 *   timer {seconds} / stopTimer       – mission clock, fails when it runs out
 *   checkpoints {points, text}        – race checkpoints
 *   countdown {}                      – 3-2-1 with controls locked
 *   reward {amount, text}             – pays out mid-job (taxi fares)
 *   wait {seconds, text, stopped}     – stand still for a while (boarding, loading)
 *   call {fn}                         – custom code
 */
import { ctx } from '../core/context.js';
import { events } from '../core/events.js';
import { settings, keyName } from '../core/settings.js';
import { formatMoney } from '../core/math.js';
import { roadSpot } from './places.js';
import { RACES } from './missionData.js';
import { JOBS, jobById, jobKindOf } from './jobs.js';

export class MissionRunner {
  constructor() {
    this.active = null;
    this.progress = { races: {}, jobsDone: 0, jobs: {} };
    this.giverMarkers = [];
    this.giverBlips = [];
    this.objective = '';
    this.timer = null;
  }

  /** Mission start points for the current progress. */
  setupWorld() {
    for (const m of this.giverMarkers) ctx.markers.remove(m);
    for (const b of this.giverBlips) ctx.blips.remove(b);
    this.giverMarkers = [];
    this.giverBlips = [];
    if (this.active) return;
    for (const race of RACES) {
      const at = race.start();
      this.giverMarkers.push(
        ctx.markers.add({ kind: 'beam', x: at.x, z: at.z, r: 4, color: 0xffffff, inVehicle: true, maxKmh: 30, onEnter: () => this.offer(race) }),
      );
      const best = this.progress.races[race.id];
      this.giverBlips.push(ctx.blips.add('race', at.x, at.z, { label: `Race: ${race.title}${best ? ` (best ${best.toFixed(1)} s)` : ''}`, short: false }));
    }
  }

  /** Walking/driving into a start marker launches the mission. */
  offer(def) {
    if (ctx.wanted.level > 0) {
      events.emit('help', { text: 'Lose the police before starting.' });
      return;
    }
    this.start(def);
  }

  /** J key: starts the job that belongs to the current vehicle, or stops the running job. */
  toggleJob() {
    if (this.active?.type === 'job') {
      this.end(false, 'Job stopped');
      return;
    }
    if (this.active) return;
    const car = ctx.player.vehicle;
    const job = car && JOBS.find((j) => j.vehicle === jobKindOf(car));
    if (!job) {
      events.emit('help', {
        text: `Jobs: press J in a taxi, courier van, bus, tow truck or ambulance (depots are on the map). Uber and Uber Eats are in the phone (${keyName(settings.get('bindings').phone[0])}).`,
      });
      return;
    }
    this.startJob(job.id);
  }

  /** Starts a job by id; opts are passed to the job's generator (e.g. an Uber request). */
  startJob(id, opts) {
    const def = jobById(id);
    if (!def || this.active) return false;
    if (ctx.wanted.level > 0) {
      events.emit('help', { text: 'Lose the police before starting a job.' });
      return false;
    }
    const car = ctx.player.vehicle;
    if (!car || (def.vehicle !== 'any' && jobKindOf(car) !== def.vehicle)) {
      events.emit('help', { text: `${def.title}: you need to be in the right vehicle.` });
      return false;
    }
    this.start(def, opts);
    return true;
  }

  start(def, opts) {
    if (this.active) return;
    this.active = {
      def,
      type: def.type,
      steps: [],
      opts,
      index: -1,
      cleanup: [],
      onFrame: null,
      refs: {},
      markers: [],
      blips: [],
      earned: 0,
      round: 0,
      startTime: ctx.simTime,
    };
    if (def.type === 'job') this.active.refs.jobCar = ctx.player.vehicle;
    this.active.steps = def.type === 'job' ? def.generate(this, opts) : def.steps(this);
    this.setupWorld();
    events.emit('mission:start', { mission: def });
    this.next();
  }

  get step() {
    return this.active?.steps[this.active.index];
  }

  next() {
    const a = this.active;
    if (!a) return;
    this.clearStepWorld();
    a.index++;
    const s = a.steps[a.index];
    if (!s) {
      if (a.type === 'job') {
        a.round++;
        if (a.def.single) {
          this.end(true);
          return;
        }
        a.steps = a.def.generate(this, a.opts);
        a.index = -1;
        this.next();
        return;
      }
      this.end(true);
      return;
    }
    s.state = {};
    this.enterStep(s);
  }

  clearStepWorld() {
    const a = this.active;
    if (!a) return;
    for (const m of a.markers) ctx.markers.remove(m);
    for (const b of a.blips) ctx.blips.remove(b);
    a.markers = [];
    a.blips = [];
  }

  marker(opts) {
    const m = ctx.markers.add(opts);
    this.active.markers.push(m);
    return m;
  }
  blip(type, x, z, opts = {}) {
    const b = ctx.blips.add(type, x, z, opts);
    this.active.blips.push(b);
    return b;
  }
  /** Pays out during a job (fares, tips). */
  pay(amount, text) {
    this.enterStep({ type: 'reward', amount, text, state: {} });
  }
  setObjective(text) {
    this.objective = text;
    events.emit('objective', { text });
  }

  enterStep(s) {
    const a = this.active;
    switch (s.type) {
      case 'say':
        events.emit('subtitle', { text: s.text, ms: s.ms || 4500 });
        s.state.t = s.wait ?? 0;
        break;
      case 'spawnVehicle': {
        const at = s.at();
        const car = ctx.vehicles.spawn(s.kind, at.x, at.z, at.yaw, 'parked', { driver: false });
        car.persistent = true;
        a.refs[s.ref] = car;
        break;
      }
      case 'enter':
        this.setObjective(s.text);
        break;
      case 'goto': {
        const at = s.at(a);
        s.state.at = at;
        this.setObjective(s.text);
        this.marker({
          kind: s.inVehicle ? 'checkpoint' : 'beam',
          x: at.x,
          z: at.z,
          r: s.r || (s.inVehicle ? 5 : 1.6),
          color: 0xf3c544,
          onFoot: !!s.onFoot,
          inVehicle: !!s.inVehicle,
          maxKmh: s.maxKmh ?? Infinity,
          onEnter: () => (s.state.done = true),
        });
        this.blip('objective', at.x, at.z, { route: true, label: 'Objective' });
        break;
      }
      case 'deliver': {
        const at = s.at(a);
        s.state.at = at;
        break;
      }
      case 'loseHeat':
        this.setObjective(s.text || 'Lose the police.');
        break;
      case 'heat':
        ctx.wanted.setMinLevel(s.level);
        break;
      case 'timer':
        this.timer = s.seconds;
        break;
      case 'stopTimer':
        this.timer = null;
        break;
      case 'checkpoints':
        s.state.i = 0;
        this.setObjective(s.text || 'Drive through the checkpoints.');
        this.placeCheckpoint(s);
        break;
      case 'countdown':
        s.state.t = 3.99;
        ctx.game.controlsLocked = true;
        break;
      case 'reward':
        ctx.player.addMoney(s.amount, s.text || 'Job');
        a.earned += s.amount;
        events.emit('notify', { text: `${s.text || 'Fare'} ${formatMoney(s.amount)}` });
        ctx.audio.cash();
        break;
      case 'call':
        s.fn(this, a);
        break;
      case 'wait':
        s.state.t = s.seconds;
        this.setObjective(s.text);
        break;
      default:
        break;
    }
  }

  placeCheckpoint(s) {
    const a = this.active;
    for (const m of a.markers) ctx.markers.remove(m);
    for (const b of a.blips) ctx.blips.remove(b);
    a.markers = [];
    a.blips = [];
    const pts = s.points(a);
    s.state.points = pts;
    const i = s.state.i;
    const p = pts[i];
    const last = i === pts.length - 1;
    this.marker({ kind: 'checkpoint', x: p.x, z: p.z, r: 7, color: last ? 0xffffff : 0xf3c544, onEnter: () => (s.state.hit = true) });
    this.blip('objective', p.x, p.z, { route: true, label: last ? 'Finish' : `Checkpoint ${i + 1}/${pts.length}` });
    if (pts[i + 1]) {
      const q = pts[i + 1];
      this.marker({ kind: 'checkpoint', x: q.x, z: q.z, r: 7, color: 0x8a7a3a });
      this.blip('objective', q.x, q.z, { label: 'Next checkpoint' });
    }
  }

  /** Per-frame update. */
  update(dt) {
    const a = this.active;
    if (!a) return;
    a.onFrame?.(dt);
    if (this.timer != null) {
      this.timer -= dt;
      if (this.timer <= 0) {
        this.timer = null;
        this.fail('You ran out of time.');
        return;
      }
    }
    // wrecked/sunk mission vehicles
    for (const k in a.refs) {
      const car = a.refs[k];
      if (!car || k === 'jobCar') continue;
      if (car.dead || car.sinkT > 2) {
        this.fail(`The ${car.label.toLowerCase()} was wrecked.`);
        return;
      }
    }
    if (a.type === 'job') {
      const car = a.refs.jobCar;
      if (!ctx.vehicles.list.includes(car) || car.dead) return this.end(false, 'Your vehicle was wrecked.');
      if (ctx.player.vehicle !== car) {
        a.outT = (a.outT || 0) + dt;
        this.setObjective(`Get back in your ${car.label.toLowerCase()} to continue the job.`);
        if (a.outT > 20) return this.end(false, 'You left your vehicle.');
        return;
      }
      a.outT = 0;
    }
    const s = this.step;
    if (!s) return;
    if (this.tickStep(s, dt)) this.next();
  }

  tickStep(s, dt) {
    const a = this.active;
    const player = ctx.player;
    switch (s.type) {
      case 'say':
        s.state.t -= dt;
        return s.state.t <= 0;
      case 'enter': {
        const car = s.ref ? a.refs[s.ref] : null;
        if (car && !s.state.blip) {
          s.state.blip = this.blip('vehicle', 0, 0, { route: true, label: car.label });
        }
        if (s.state.blip && car) {
          const p = car.body.translation();
          s.state.blip.x = p.x;
          s.state.blip.z = p.z;
        }
        const v = player.vehicle;
        const ok = car ? v === car : s.kind ? v?.kind === s.kind : !!v;
        if (ok && s.state.blip) {
          ctx.blips.remove(s.state.blip);
          s.state.blip = null;
        }
        return ok;
      }
      case 'goto':
        if (s.state.done && s.maxKmh != null && player.vehicle && Math.abs(player.vehicle.kmh) > s.maxKmh) return false;
        return !!s.state.done;
      case 'deliver': {
        const car = a.refs[s.ref];
        const inCar = player.vehicle === car;
        if (inCar !== s.state.inCar) {
          s.state.inCar = inCar;
          this.clearStepWorld();
          if (inCar) {
            this.setObjective(s.text);
            this.marker({
              kind: 'checkpoint',
              x: s.state.at.x,
              z: s.state.at.z,
              r: s.r || 5,
              color: 0xf3c544,
              inVehicle: true,
              maxKmh: 25,
              onEnter: () => (s.state.done = true),
            });
            this.blip('objective', s.state.at.x, s.state.at.z, { route: true, label: 'Destination' });
          } else {
            this.setObjective(`Get back in the ${car.label.toLowerCase()}.`);
            s.state.carBlip = this.blip('vehicle', 0, 0, { route: true, label: car.label });
          }
        }
        if (!inCar && s.state.carBlip) {
          const p = car.body.translation();
          s.state.carBlip.x = p.x;
          s.state.carBlip.z = p.z;
        }
        return inCar && !!s.state.done;
      }
      case 'loseHeat':
        return ctx.wanted.level === 0;
      case 'wait': {
        const v = player.vehicle;
        if (s.stopped && v && Math.abs(v.kmh || 0) > 3) return false;
        s.state.t -= dt;
        return s.state.t <= 0;
      }
      case 'checkpoints':
        if (s.state.hit) {
          s.state.hit = false;
          ctx.audio.checkpoint();
          s.state.i++;
          if (s.state.i >= s.state.points.length) return true;
          this.placeCheckpoint(s);
        }
        return false;
      case 'countdown': {
        const prev = Math.ceil(s.state.t);
        s.state.t -= dt;
        const now = Math.ceil(s.state.t);
        if (now !== prev && now > 0) {
          events.emit('bigtext', { text: String(now), ms: 800 });
          ctx.audio.tone(660, 0.15, 'square', 0.05);
        }
        if (s.state.t <= 0) {
          events.emit('bigtext', { text: 'GO!', ms: 900 });
          ctx.audio.tone(1320, 0.3, 'square', 0.06);
          ctx.game.controlsLocked = false;
          return true;
        }
        return false;
      }
      default:
        return true;
    }
  }

  fail(reason) {
    if (!this.active) return;
    const def = this.active.def;
    if (def.type === 'job') return this.end(false, reason);
    this.cleanup();
    events.emit('mission:failed', { mission: def, reason });
    ctx.audio.missionFailed();
    this.setupWorld();
  }

  end(passed, reason = '') {
    const a = this.active;
    if (!a) return;
    const def = a.def;
    let reward = 0;
    if (def.type === 'job') {
      ctx.stats.add('jobsDone', a.round);
      this.progress.jobsDone += a.round;
      const js = (this.progress.jobs[def.id] ||= { done: 0, earned: 0 });
      js.done += a.round;
      js.earned += a.earned;
      if (!def.single) events.emit('mission:ended', { mission: def, text: `${def.title} finished · ${a.round} completed · ${formatMoney(a.earned)} earned`, reason });
      else if (!passed) events.emit('mission:ended', { mission: def, text: `${def.title} cancelled`, reason });
    } else if (passed) {
      if (def.type === 'race') {
        const time = ctx.simTime - a.raceStart;
        const best = this.progress.races[def.id];
        if (!best || time < best) this.progress.races[def.id] = time;
        const medal = def.medals.findIndex((m) => time <= m);
        reward = medal >= 0 ? def.rewards[medal] : 0;
        if (medal === 0) ctx.stats.add('racesWon', 1);
        a.resultText = `${time.toFixed(1)} s · ${['Gold', 'Silver', 'Bronze'][medal] || 'No medal'}`;
      }
      if (reward) ctx.player.addMoney(reward, def.title);
      events.emit('mission:passed', { mission: def, reward, text: a.resultText });
      ctx.audio.missionPassed();
    }
    this.cleanup();
    this.setupWorld();
  }

  cleanup() {
    const a = this.active;
    if (!a) return;
    this.clearStepWorld();
    for (const fn of a.cleanup) {
      try {
        fn();
      } catch (e) {
        console.warn('[missions] cleanup failed', e);
      }
    }
    this.timer = null;
    ctx.game.controlsLocked = false;
    for (const k in a.refs) {
      const car = a.refs[k];
      if (car && car !== ctx.player.vehicle && k !== 'jobCar') car.persistent = false;
    }
    this.active = null;
    this.objective = '';
    events.emit('objective', { text: '' });
  }

  /** Called when the player dies or is arrested. */
  abort(reason) {
    if (!this.active) return;
    if (this.active.type === 'job') this.end(false, reason);
    else this.fail(reason);
  }

  serialize() {
    return { ...this.progress };
  }
  restore(p) {
    this.progress = { races: {}, jobsDone: 0, jobs: {}, ...(p || {}) };
    this.setupWorld();
  }
}

/** Helper for mission data: road spot near a point. */
export const lane = (x, z) => roadSpot(x, z);
