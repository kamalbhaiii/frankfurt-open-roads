/**
 * Mission content: the story arc, street races and vehicle jobs.
 * Positions are resolved lazily from real Frankfurt landmarks once the world exists.
 */
import { ctx } from '../core/context.js';
import { SERVICES, toLocal } from '../core/config.js';
import { rnd } from '../core/math.js';
import { landmark, parkingSpot, kerbSpot, roadSpot, randomKerbSpot, geo } from './places.js';

const at = (fn) => () => fn();
const service = (id) => {
  const s = SERVICES.find((x) => x.id === id);
  const [x, z] = toLocal(s.lat, s.lon);
  return { x, z };
};
/** Lena's office: kerbside near the old Nikolaikirche on the Römerberg. */
const office = () => kerbSpot(landmark('Glockenturm der Alten Nikolaikirche').x - 30, landmark('Glockenturm der Alten Nikolaikirche').z);
const near = (p, dx, dz) => ({ x: p.x + dx, z: p.z + dz });

// ---------------------------------------------------------------- story
export const STORY = [
  {
    id: 'story1',
    type: 'story',
    title: 'First Day',
    contact: 'Lena',
    reward: 400,
    start: office,
    steps: () => [
      { type: 'say', text: 'Lena: So you’re the new driver. Kurier Hartmann moves anything, anywhere, no questions.', wait: 3.5 },
      { type: 'say', text: 'Lena: There’s a van round the corner. A client at the Westhafen Tower is waiting for it.', wait: 3.5 },
      {
        type: 'spawnVehicle',
        ref: 'van',
        kind: 'van',
        at: at(() => {
          const o = near(office(), 25, 10);
          return parkingSpot(o.x, o.z);
        }),
      },
      { type: 'enter', ref: 'van', text: 'Get in the delivery van.' },
      { type: 'timer', seconds: 240 },
      {
        type: 'deliver',
        ref: 'van',
        text: 'Deliver the van to the Westhafen Tower.',
        at: at(() => parkingSpot(landmark('Westhafen Tower').x, landmark('Westhafen Tower').z)),
      },
      { type: 'stopTimer' },
      { type: 'say', text: 'Lena: Right on time. Here’s your cut. I’ll call you.', wait: 2 },
    ],
  },
  {
    id: 'story2',
    type: 'story',
    title: 'Messe Express',
    contact: 'Lena',
    reward: 900,
    start: office,
    steps: () => [
      { type: 'say', text: 'Lena: A collector wants a very specific sports coupé. Its owner is in a meeting at the Messeturm.', wait: 3.5 },
      { type: 'say', text: 'Lena: Take it to the paint shop in Gallus before anyone notices it’s gone.', wait: 3 },
      { type: 'spawnVehicle', ref: 'coupe', kind: 'coupe', at: at(() => parkingSpot(landmark('Messeturm').x + 40, landmark('Messeturm').z + 30)) },
      { type: 'enter', ref: 'coupe', text: 'Steal the sports coupé at the Messeturm.' },
      { type: 'heat', level: 1 },
      { type: 'say', text: 'Lena: The alarm went off. Don’t lead the cops to my client!', wait: 0 },
      { type: 'timer', seconds: 200 },
      { type: 'loseHeat', text: 'Lose the police.' },
      {
        type: 'deliver',
        ref: 'coupe',
        text: 'Deliver the coupé to the paint shop in Gallus.',
        at: at(() => parkingSpot(geo(50.1043, 8.6512).x, geo(50.1043, 8.6512).z)),
      },
      { type: 'stopTimer' },
      { type: 'say', text: 'Lena: Clean work. The collector is very happy.', wait: 2 },
    ],
  },
  {
    id: 'story3',
    type: 'story',
    title: 'Blue Lights',
    contact: 'Lena',
    reward: 1600,
    start: office,
    steps: () => [
      { type: 'say', text: 'Lena: A film studio wants a real patrol car for a shoot. Don’t ask.', wait: 3 },
      { type: 'say', text: 'Lena: There’s one parked outside Polizeirevier West. Grab it, shake off the pursuit, bring it to the Main Plaza.', wait: 3.5 },
      { type: 'spawnVehicle', ref: 'cop', kind: 'police', at: at(() => parkingSpot(service('police_west').x, service('police_west').z)) },
      { type: 'enter', ref: 'cop', text: 'Take the patrol car outside Polizeirevier West.' },
      { type: 'heat', level: 2 },
      { type: 'loseHeat', text: 'Lose the police. Tip: a respray won’t work on a patrol car.' },
      {
        type: 'deliver',
        ref: 'cop',
        text: 'Bring the patrol car to the Main Plaza in Sachsenhausen.',
        at: at(() => parkingSpot(landmark('Lindner Hotel Frankfurt Main Plaza').x, landmark('Lindner Hotel Frankfurt Main Plaza').z)),
      },
      { type: 'say', text: 'Lena: That’s a wrap! You’re a natural.', wait: 2 },
    ],
  },
  {
    id: 'story4',
    type: 'story',
    title: 'Skyline',
    contact: 'Lena',
    reward: 3000,
    start: office,
    steps: () => [
      { type: 'say', text: 'Lena: Last job of the season. A VIP wants to see every tower of the skyline, and fast.', wait: 3.5 },
      { type: 'say', text: 'Lena: Grab any car. Hit every checkpoint before the clock runs out.', wait: 2.5 },
      { type: 'enter', any: true, text: 'Get a vehicle.' },
      { type: 'timer', seconds: 330 },
      {
        type: 'checkpoints',
        text: 'Show the VIP the skyline: drive through every checkpoint.',
        points: () =>
          ['Main Tower', 'Commerzbank Tower', 'Eurotower', 'MainTor Panorama', 'Messeturm', 'Westend Tower', 'OpernTurm', 'Nextower'].map((n) =>
            roadSpot(landmark(n).x, landmark(n).z),
          ),
      },
      { type: 'stopTimer' },
      { type: 'say', text: 'Lena: The VIP loved it. Frankfurt is yours. Thanks for driving with Kurier Hartmann.', wait: 3 },
    ],
  },
];

// ---------------------------------------------------------------- races
function raceCheckpoints(names) {
  const pts = names.map((n) => landmark(n));
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const r = ctx.roads.route(pts[i].x, pts[i].z, pts[i + 1].x, pts[i + 1].z, true);
    if (!r) continue;
    let acc = 0;
    for (let j = 1; j < r.points.length; j++) {
      acc += Math.hypot(r.points[j][0] - r.points[j - 1][0], r.points[j][1] - r.points[j - 1][1]);
      if (acc > 190) {
        out.push({ x: r.points[j][0], z: r.points[j][1] });
        acc = 0;
      }
    }
    const end = r.points[r.points.length - 1];
    out.push({ x: end[0], z: end[1] });
  }
  return out;
}

function race(id, title, names, medals, rewards) {
  let cache = null;
  const cps = () => (cache ||= raceCheckpoints(names));
  return {
    id,
    type: 'race',
    title,
    medals,
    rewards,
    start: () => roadSpot(landmark(names[0]).x, landmark(names[0]).z),
    steps: () => [
      { type: 'say', text: `${title}: gold ${medals[0]} s · silver ${medals[1]} s · bronze ${medals[2]} s`, wait: 0, ms: 5000 },
      { type: 'countdown' },
      { type: 'call', fn: (r, a) => (a.raceStart = ctx.simTime) },
      { type: 'timer', seconds: medals[2] + 25 },
      { type: 'checkpoints', text: `${title}: hit every checkpoint.`, points: cps },
      { type: 'stopTimer' },
    ],
  };
}

export const RACES = [
  race(
    'race_main',
    'Mainufer Sprint',
    ['Westhafen Tower', 'MainTor Panorama', 'Glockenturm der Alten Nikolaikirche', 'Lindner Hotel Frankfurt Main Plaza'],
    [95, 120, 150],
    [800, 400, 200],
  ),
  race(
    'race_banks',
    'Bankenviertel Circuit',
    ['Messeturm', 'Trianon', 'OpernTurm', 'Nextower', 'Eurotower', 'Westend Tower'],
    [120, 150, 190],
    [1000, 500, 250],
  ),
];

// ---------------------------------------------------------------- jobs
const PASSENGER_LINES = [
  'To the Alte Oper, please. I’m late!',
  'Quick, my train leaves in ten minutes.',
  'Take me somewhere with good Apfelwein.',
  'Just drive. I’ll tell you when.',
  'The Messe, and step on it!',
  'Careful, I get car sick.',
  'Do you know a good Grüne Soße place?',
];

function taxiRound() {
  const p = ctx.player.position;
  const pick = randomKerbSpot(p.x, p.z, 150, 450, rnd);
  const drop = randomKerbSpot(pick.x, pick.z, 450, 1300, rnd);
  const route = ctx.roads.route(pick.x, pick.z, drop.x, drop.z, true);
  const len = route ? route.length : Math.hypot(drop.x - pick.x, drop.z - pick.z) * 1.4;
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
        const used = ctx.simTime - a.legStart;
        const bonus = Math.max(0, Math.round((time - used) * 0.6));
        r.enterStep({ type: 'reward', amount: fare + bonus, text: bonus ? `Fare + tip` : 'Fare', state: {} });
      },
    },
  ];
}

function deliveryRound() {
  const p = ctx.player.position;
  const drop = randomKerbSpot(p.x, p.z, 400, 1200, rnd);
  const route = ctx.roads.route(p.x, p.z, drop.x, drop.z, true);
  const len = route ? route.length : 800;
  const time = Math.round(len / 10 + 15);
  const pay = Math.round(15 + len * 0.02);
  return [
    { type: 'timer', seconds: time },
    { type: 'goto', text: 'Deliver the parcel before the time runs out.', at: () => drop, r: 6, inVehicle: true, maxKmh: 15 },
    { type: 'stopTimer' },
    { type: 'reward', amount: pay, text: 'Delivery' },
  ];
}

export const JOBS = [
  { id: 'job_taxi', type: 'job', title: 'Taxi driver', vehicle: 'taxi', generate: taxiRound },
  { id: 'job_delivery', type: 'job', title: 'Parcel courier', vehicle: 'van', generate: deliveryRound },
];
