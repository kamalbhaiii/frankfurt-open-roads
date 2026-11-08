/**
 * Free-roam jobs and their depots.
 *
 * Vehicle jobs (press J in the vehicle, or accept a WhatsApp offer):
 *   taxi · courier (van) · bus driver · tow truck · ambulance
 * App jobs (started from the Uber app on the phone, any suitable vehicle):
 *   Uber ride · Uber Eats delivery
 *
 * A job is { id, title, vehicle, single?, generate(runner, opts) -> steps } run by MissionRunner.
 * Depots keep a job vehicle parked at fixed places (bus depot, hospitals, garages, restaurants).
 */
import { ctx } from '../core/context.js';
import { events } from '../core/events.js';
import { rnd } from '../core/math.js';
import { geo, kerbSpot, parkingSpot, randomKerbSpot, roadSpot } from './places.js';
import { randomPerson } from '../actors/characters.js';

/** Job vehicle kinds and the stand-in model used until a dedicated model exists. */
const FALLBACK_KIND = { bus: 'van', ambulance: 'van', tow: 'van', scooter: 'hatchback' };
export const JOB_VEHICLE_LABEL = { bus: 'Stadtbus', ambulance: 'Rettungswagen', tow: 'Abschleppwagen', scooter: 'Lieferroller' };

/** Kind a vehicle counts as for jobs (depot vehicles may use a stand-in model). */
export const jobKindOf = (car) => car?.jobKind ?? car?.kind;
/** Vehicles with a siren/beacon the horn key toggles. */
export const hasBeacon = (car) => !!car && (car.isPolice || ['ambulance', 'tow'].includes(jobKindOf(car)));

export function spawnJobVehicle(kind, x, z, yaw) {
  const model = ctx.models[`car_${kind}`] ? kind : FALLBACK_KIND[kind] || kind;
  const car = ctx.vehicles.spawn(model, x, z, yaw, 'parked', { driver: false });
  if (model !== kind) {
    car.jobKind = kind;
    car.label = JOB_VEHICLE_LABEL[kind] || car.label;
  }
  return car;
}

// ---------------------------------------------------------------- places
/** Fictional restaurants for Uber Eats (positions near busy streets). */
export const RESTAURANTS = [
  { name: 'Pizzeria Bella Napoli', lat: 50.1141, lon: 8.6838 },
  { name: 'Döner Palast', lat: 50.1078, lon: 8.6668 },
  { name: 'Sushi Mainhattan', lat: 50.1121, lon: 8.6725 },
  { name: 'Burgerwerk', lat: 50.1186, lon: 8.6872 },
  { name: 'Apfelwein Stube', lat: 50.1032, lon: 8.6878 },
  { name: 'Thai Garden', lat: 50.1162, lon: 8.6655 },
  { name: 'Curry Eck', lat: 50.1101, lon: 8.6952 },
];

const CUSTOMER_NAMES = ['Anna', 'Lukas', 'Mia', 'Felix', 'Sophie', 'Jonas', 'Emma', 'Leon', 'Hannah', 'Paul', 'Lea', 'Ben', 'Marie', 'Elias', 'Aylin', 'Mehmet', 'Sara', 'Tim'];
const PASSENGER_LINES = [
  'To the Alte Oper, please. I’m late!',
  'Quick, my train leaves in ten minutes.',
  'Take me somewhere with good Apfelwein.',
  'Just drive. I’ll tell you when.',
  'The Messe, and step on it!',
  'Careful, I get car sick.',
  'Do you know a good Grüne Soße place?',
];

const routeLength = (a, b) => ctx.roads.route(a.x, a.z, b.x, b.z, true)?.length ?? Math.hypot(b.x - a.x, b.z - a.z) * 1.4;
const nearestService = (kind, p) => ctx.services.nearest(kind, p.x, p.z);

/** Counts crashes of the player's vehicle between start() and stop() (for Uber ratings). */
function crashCounter() {
  let n = 0;
  const off = events.on('vehicle:crash', ({ car, impact }) => {
    if (car === ctx.player.vehicle && impact > 6) n++;
  });
  return { get count() { return n; }, stop: off };
}

// ---------------------------------------------------------------- job rounds
function taxiRound() {
  const p = ctx.player.position;
  const pick = randomKerbSpot(p.x, p.z, 150, 450, rnd);
  const drop = randomKerbSpot(pick.x, pick.z, 450, 1300, rnd);
  const len = routeLength(pick, drop);
  const time = Math.round(len / 9 + 20);
  const fare = Math.round(8 + len * 0.018);
  return [
    { type: 'goto', text: 'Pick up the passenger.', at: () => pick, r: 6, inVehicle: true, maxKmh: 10 },
    { type: 'say', text: `Passenger: ${rnd.pick(PASSENGER_LINES)}`, wait: 0 },
    { type: 'timer', seconds: time },
    { type: 'call', fn: (r, a) => (a.legStart = ctx.simTime) },
    { type: 'goto', text: 'Drive the passenger to the destination.', at: () => drop, r: 6, inVehicle: true, maxKmh: 10 },
    { type: 'stopTimer' },
    {
      type: 'call',
      fn: (r, a) => {
        const bonus = Math.max(0, Math.round((time - (ctx.simTime - a.legStart)) * 0.6));
        r.pay(fare + bonus, bonus ? 'Taxi fare + tip' : 'Taxi fare');
      },
    },
  ];
}

function courierRound() {
  const p = ctx.player.position;
  const drop = randomKerbSpot(p.x, p.z, 400, 1200, rnd);
  const len = routeLength(p, drop);
  return [
    { type: 'timer', seconds: Math.round(len / 10 + 15) },
    { type: 'goto', text: 'Deliver the parcel before the time runs out.', at: () => drop, r: 6, inVehicle: true, maxKmh: 15 },
    { type: 'stopTimer' },
    { type: 'reward', amount: Math.round(15 + len * 0.02), text: 'Parcel delivered' },
  ];
}

/** Bus line: a run of stops along main roads, passengers board at each one. */
function busRound(runner) {
  const a = runner.active;
  a.line ||= rnd.pick(['30', '32', '36', '46', '64', 'M72']);
  const stops = [];
  let from = ctx.player.position;
  for (let i = 0; i < 5; i++) {
    const k = randomKerbSpot(from.x, from.z, 320, 600, rnd);
    const s = roadSpot(k.x, k.z, (e) => e.speed >= 9);
    stops.push({ ...s, name: ctx.streetIndex.nearest(s.x, s.z) || 'Haltestelle' });
    from = s;
  }
  const steps = [];
  stops.forEach((s, i) => {
    const len = routeLength(i ? stops[i - 1] : ctx.player.position, s);
    steps.push(
      { type: 'timer', seconds: Math.round(len / 7 + 25) },
      { type: 'goto', text: `Linie ${a.line}: drive to the stop “${s.name}” (${i + 1}/${stops.length}).`, at: () => s, r: 7, inVehicle: true, maxKmh: 6 },
      { type: 'stopTimer' },
      { type: 'wait', seconds: 4, text: `Passengers boarding at ${s.name}…`, stopped: true },
      { type: 'reward', amount: 6 + Math.floor(rnd() * 8), text: 'Bus fares' },
    );
  });
  return steps;
}

/** Tow truck: hook up a broken-down car and bring it to the nearest garage. */
function towRound() {
  const p = ctx.player.position;
  const spot = randomKerbSpot(p.x, p.z, 300, 900, rnd);
  const park = parkingSpot(spot.x, spot.z);
  let wreck = null;
  return [
    {
      type: 'call',
      fn: (r, a) => {
        wreck = ctx.vehicles.spawn(rnd.pick(['sedan', 'hatchback', 'estate', 'suv']), park.x, park.z, park.yaw, 'parked', { driver: false });
        wreck.persistent = true;
        wreck.health = 380;
        wreck.indicator = 2; // hazard lights
        a.cleanup.push(() => {
          if (wreck && ctx.vehicles.list.includes(wreck)) {
            wreck.persistent = false;
            wreck.indicator = 0;
          }
        });
      },
    },
    { type: 'goto', text: 'A car broke down. Drive to it.', at: () => park, r: 9, inVehicle: true, maxKmh: 6 },
    { type: 'wait', seconds: 3, text: 'Hooking up the car…', stopped: true },
    {
      type: 'call',
      fn: (r, a) => {
        const truck = a.refs.jobCar;
        const load = wreck.model.clone(true);
        load.scale.setScalar(0.92);
        load.position.set(0, truck.ud.height * 0.42, -truck.length * 0.22);
        truck.model.add(load);
        ctx.vehicles.remove(wreck);
        wreck = null;
        a.cleanup.push(() => truck.model.remove(load));
        a.towLoad = load;
      },
    },
    {
      type: 'call',
      fn: (r, a) => {
        const g = nearestService('garage', ctx.player.position);
        a.dropAt = g.drive;
        a.dropLen = routeLength(ctx.player.position, g.drive);
      },
    },
    { type: 'goto', text: 'Tow the car to the garage.', at: (a) => a.dropAt, r: 7, inVehicle: true, maxKmh: 10 },
    { type: 'wait', seconds: 2, text: 'Unloading…', stopped: true },
    {
      type: 'call',
      fn: (r, a) => {
        a.refs.jobCar.model.remove(a.towLoad);
        r.pay(Math.round(45 + a.dropLen * 0.04), 'Towing job');
      },
    },
  ];
}

/** Ambulance: reach the patient, then rush them to the nearest hospital. */
function ambulanceRound() {
  const p = ctx.player.position;
  const spot = randomKerbSpot(p.x, p.z, 300, 1000, rnd);
  let patient = null;
  const reach = Math.round(routeLength(p, spot) / 10 + 25);
  return [
    {
      type: 'call',
      fn: (r, a) => {
        patient = randomPerson();
        patient.root.position.set(spot.x, ctx.physics.groundY(spot.x, spot.z), spot.z);
        patient.root.rotation.y = rnd() * Math.PI * 2;
        ctx.scene.add(patient.root);
        patient.play('fall', 0);
        a.onFrame = (dt) => patient?.update(dt);
        a.cleanup.push(() => patient && ctx.peds.reclaim(patient));
      },
    },
    { type: 'say', text: 'Leitstelle: Emergency call! Person injured, please respond.', wait: 0 },
    { type: 'timer', seconds: reach },
    { type: 'goto', text: 'Drive to the patient. Siren: H.', at: () => spot, r: 8, inVehicle: true, maxKmh: 8 },
    { type: 'stopTimer' },
    { type: 'wait', seconds: 3, text: 'Loading the patient…', stopped: true },
    {
      type: 'call',
      fn: (r, a) => {
        ctx.peds.reclaim(patient);
        patient = null;
        const h = nearestService('hospital', ctx.player.position);
        a.dropAt = h.drive;
        a.dropTime = Math.round(routeLength(ctx.player.position, h.drive) / 11 + 25);
        a.legStart = ctx.simTime;
      },
    },
    { type: 'call', fn: (r, a) => r.enterStep({ type: 'timer', seconds: a.dropTime, state: {} }) },
    { type: 'goto', text: 'Take the patient to the hospital.', at: (a) => a.dropAt, r: 8, inVehicle: true, maxKmh: 10 },
    { type: 'stopTimer' },
    {
      type: 'call',
      fn: (r, a) => {
        const bonus = Math.max(0, Math.round((a.dropTime - (ctx.simTime - a.legStart)) * 1.2));
        r.pay(70 + bonus, bonus ? 'Patient delivered + bonus' : 'Patient delivered');
      },
    },
  ];
}

/** Uber ride: one accepted request (see the Uber app). Rated 1–5 stars. */
function uberRide(_runner, req) {
  let crashes = null;
  return [
    {
      type: 'call',
      fn: (r, a) => {
        crashes = crashCounter();
        a.cleanup.push(() => crashes.stop());
      },
    },
    { type: 'goto', text: `Uber: pick up ${req.name}.`, at: () => req.pick, r: 6, inVehicle: true, maxKmh: 10 },
    { type: 'say', text: `${req.name}: ${rnd.pick(PASSENGER_LINES)}`, wait: 0 },
    { type: 'call', fn: (r, a) => (a.legStart = ctx.simTime) },
    { type: 'timer', seconds: req.eta },
    { type: 'goto', text: `Uber: drive ${req.name} to the destination.`, at: () => req.drop, r: 6, inVehicle: true, maxKmh: 10 },
    { type: 'stopTimer' },
    {
      type: 'call',
      fn: (r, a) => {
        const late = Math.max(0, ctx.simTime - a.legStart - req.eta * 0.75);
        const stars = Math.max(1, Math.min(5, Math.round(5 - crashes.count * 0.8 - late / 30)));
        const tip = stars === 5 ? Math.round(req.fare * 0.2) : 0;
        r.pay(req.fare + tip, tip ? 'Uber fare + tip' : 'Uber fare');
        events.emit('uber:completed', { kind: 'ride', stars, fare: req.fare + tip, name: req.name });
      },
    },
  ];
}

/** Uber Eats: pick up at a restaurant, deliver to the customer while it's hot. */
function eatsOrder(runner, req) {
  return [
    { type: 'goto', text: `Uber Eats: collect the order at ${req.restaurant.name}.`, at: () => req.pick, r: 6, inVehicle: true, maxKmh: 8 },
    { type: 'wait', seconds: 3, text: 'Collecting the order…', stopped: true },
    { type: 'timer', seconds: req.eta },
    { type: 'call', fn: (r, a) => (a.legStart = ctx.simTime) },
    { type: 'goto', text: `Uber Eats: deliver to ${req.name} before it gets cold.`, at: () => req.drop, r: 6, inVehicle: true, maxKmh: 8 },
    { type: 'stopTimer' },
    {
      type: 'call',
      fn: (r, a) => {
        const left = req.eta - (ctx.simTime - a.legStart);
        const stars = left > req.eta * 0.4 ? 5 : left > req.eta * 0.15 ? 4 : 3;
        const tip = stars === 5 ? 3 + Math.floor(rnd() * 5) : 0;
        r.pay(req.fare + tip, tip ? 'Uber Eats + tip' : 'Uber Eats delivery');
        events.emit('uber:completed', { kind: 'eats', stars, fare: req.fare + tip, name: req.name });
      },
    },
  ];
}

// ---------------------------------------------------------------- requests (Uber app)
/** A ride request near the player. */
export function makeRideRequest() {
  const p = ctx.player.position;
  const pick = randomKerbSpot(p.x, p.z, 120, 500, rnd);
  const drop = randomKerbSpot(pick.x, pick.z, 500, 1600, rnd);
  const len = routeLength(pick, drop);
  return {
    kind: 'ride',
    name: rnd.pick(CUSTOMER_NAMES),
    rating: (4.3 + rnd() * 0.7).toFixed(1),
    pick,
    drop,
    pickDist: Math.hypot(pick.x - p.x, pick.z - p.z),
    tripKm: len / 1000,
    eta: Math.round(len / 8 + 30),
    fare: Math.round(6 + len * 0.016),
    dropName: ctx.streetIndex.nearest(drop.x, drop.z) || ctx.game.district(drop),
  };
}

/** An Uber Eats order from a nearby restaurant. */
export function makeEatsRequest() {
  const p = ctx.player.position;
  const byDist = RESTAURANTS.map((r) => ({ r, at: geo(r.lat, r.lon) })).sort((a, b) => Math.hypot(a.at.x - p.x, a.at.z - p.z) - Math.hypot(b.at.x - p.x, b.at.z - p.z));
  const { r: restaurant, at } = rnd.pick(byDist.slice(0, 3));
  const pick = kerbSpot(at.x, at.z);
  const drop = randomKerbSpot(pick.x, pick.z, 300, 1100, rnd);
  const len = routeLength(pick, drop);
  return {
    kind: 'eats',
    name: rnd.pick(CUSTOMER_NAMES),
    restaurant,
    pick,
    drop,
    pickDist: Math.hypot(pick.x - p.x, pick.z - p.z),
    tripKm: len / 1000,
    eta: Math.round(len / 7 + 40),
    fare: Math.round(4 + len * 0.004),
    dropName: ctx.streetIndex.nearest(drop.x, drop.z) || ctx.game.district(drop),
  };
}

// ---------------------------------------------------------------- definitions
export const JOBS = [
  { id: 'taxi', type: 'job', title: 'Taxi driver', vehicle: 'taxi', generate: taxiRound },
  { id: 'courier', type: 'job', title: 'Parcel courier', vehicle: 'van', generate: courierRound },
  { id: 'bus', type: 'job', title: 'Bus driver', vehicle: 'bus', generate: busRound },
  { id: 'tow', type: 'job', title: 'Tow truck driver', vehicle: 'tow', generate: towRound },
  { id: 'ambulance', type: 'job', title: 'Paramedic', vehicle: 'ambulance', generate: ambulanceRound },
  { id: 'uber', type: 'job', title: 'Uber ride', vehicle: 'any', single: true, generate: uberRide },
  { id: 'eats', type: 'job', title: 'Uber Eats', vehicle: 'any', single: true, generate: eatsOrder },
];
export const jobById = (id) => JOBS.find((j) => j.id === id);

/** Vehicles that can't do Uber rides (Uber Eats accepts anything). */
export const canDoUber = (car) => !!car && !['bus', 'tow', 'ambulance', 'scooter', 'police', 'van'].includes(jobKindOf(car));

// ---------------------------------------------------------------- depots
/**
 * Fixed places where a job vehicle waits. A vehicle is respawned out of sight
 * when the old one was taken away, wrecked or recycled.
 */
export class Depots {
  constructor() {
    this.list = [];
    this.timer = 0;
  }

  build() {
    const add = (kind, label, x, z, blip) => {
      const s = parkingSpot(x, z);
      const d = { kind, label, x: s.x, z: s.z, yaw: s.yaw, car: null };
      d.blip = ctx.blips.add(blip, s.x, s.z, { label, short: true });
      this.list.push(d);
      this.respawn(d);
    };
    const bus = geo(50.1073, 8.6642);
    add('bus', 'Bus depot · Linie 30–64', bus.x, bus.z, 'busdepot');
    const taxi = geo(50.1083, 8.6694);
    add('taxi', 'Taxi rank', taxi.x, taxi.z, 'taxirank');
    const van = geo(50.1124, 8.6962);
    add('van', 'Courier depot', van.x, van.z, 'courierdepot');
    for (const p of ctx.services.places) {
      if (p.kind === 'hospital') add('ambulance', `Rettungswache · ${p.name}`, p.drive.x + 6, p.drive.z, 'ambulancedepot');
      if (p.kind === 'garage') add('tow', `Abschleppdienst · ${p.name}`, p.drive.x - 8, p.drive.z, 'towdepot');
    }
    for (const r of RESTAURANTS.slice(0, 3)) {
      const at = geo(r.lat, r.lon);
      add('scooter', `${r.name} · delivery scooter`, at.x, at.z, 'scooterdepot');
    }
  }

  respawn(d) {
    const car = spawnJobVehicle(d.kind, d.x, d.z, d.yaw);
    car.persistent = true;
    car.depot = d;
    d.car = car;
  }

  /** Runs a few times per second: replaces depot vehicles that are gone. */
  update(dt) {
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 3;
    const p = ctx.player.position;
    for (const d of this.list) {
      const car = d.car;
      const gone = !car || !ctx.vehicles.list.includes(car) || car.dead || Math.hypot(car.position.x - d.x, car.position.z - d.z) > 40;
      if (!gone) continue;
      if (car && car !== ctx.player.vehicle && car !== ctx.player.lastCar && ctx.vehicles.list.includes(car)) car.persistent = false;
      if (car && (car === ctx.player.vehicle || car === ctx.player.lastCar)) car.depot = null;
      // don't pop a vehicle into view
      if (Math.hypot(p.x - d.x, p.z - d.z) < 70 || ctx.traffic.inView(d.x, d.z)) continue;
      if (ctx.traffic.occupied(d.x, d.z, 4)) continue;
      this.respawn(d);
    }
  }

  /** Nearest depot for a vehicle kind (for WhatsApp offers / waypoints). */
  nearest(kind, from = ctx.player.position) {
    let best = null,
      bd = Infinity;
    for (const d of this.list) {
      if (d.kind !== kind) continue;
      const dd = Math.hypot(d.x - from.x, d.z - from.z);
      if (dd < bd) {
        bd = dd;
        best = d;
      }
    }
    return best;
  }
}

