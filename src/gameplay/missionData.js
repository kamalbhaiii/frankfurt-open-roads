/**
 * Street races (free-roam activities). Jobs live in jobs.js.
 * Positions are resolved lazily from real Frankfurt landmarks once the world exists.
 */
import { ctx } from '../core/context.js';
import { landmark, roadSpot } from './places.js';

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
