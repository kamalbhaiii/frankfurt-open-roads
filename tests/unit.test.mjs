/**
 * Unit tests for pure game logic (no browser needed): node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clamp, wrapAngle, area, pip, segDist, pointAlong, polylineLength, SpatialGrid, createRng, formatClock } from '../src/core/math.js';
import { RoadNetwork } from '../src/world/roadNetwork.js';
import { WantedSystem } from '../src/gameplay/wanted.js';
import { WANTED } from '../src/core/config.js';

test('math helpers', () => {
  assert.equal(clamp(5, 0, 3), 3);
  assert.ok(Math.abs(wrapAngle(3 * Math.PI) - Math.PI) < 1e-9 || Math.abs(wrapAngle(3 * Math.PI) + Math.PI) < 1e-9);
  const sq = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ];
  assert.equal(area(sq), 100);
  assert.ok(pip(5, 5, sq));
  assert.ok(!pip(15, 5, sq));
  assert.equal(segDist(5, 3, 0, 0, 10, 0).d, 3);
  assert.equal(
    polylineLength([
      [0, 0],
      [3, 4],
      [3, 10],
    ]),
    11,
  );
  const p = pointAlong(
    [
      [0, 0],
      [10, 0],
    ],
    4,
  );
  assert.deepEqual([p.x, p.z], [4, 0]);
  assert.equal(formatClock(75), '1:15');
});

test('seeded rng is deterministic', () => {
  const a = createRng(42),
    b = createRng(42);
  for (let i = 0; i < 10; i++) assert.equal(a(), b());
});

test('spatial grid query', () => {
  const g = new SpatialGrid(10);
  g.insert(1, 1, 'a');
  g.insert(55, 55, 'b');
  assert.deepEqual([...g.query(0, 0, 5)], ['a']);
});

// A small grid of streets:  A(0,0) — B(100,0) — C(200,0)
//                                     |
//                                    D(100,100)
// plus a one-way street C → D.
const ways = [
  {
    pts: [
      [0, 0],
      [100, 0],
      [200, 0],
    ],
    speed: 10,
    width: 8,
  },
  {
    pts: [
      [100, 0],
      [100, 100],
    ],
    speed: 10,
    width: 8,
  },
  {
    pts: [
      [200, 0],
      [200, 100],
      [100, 100],
    ],
    speed: 10,
    width: 8,
    oneway: 1,
  },
];

test('road network splits ways at shared junctions', () => {
  const net = new RoadNetwork(ways);
  // way 1 is split at B, so 2 + 1 + 1 edges
  assert.equal(net.edges.length, 4);
  const b = net.nodeByKey.get('100,0');
  assert.equal(b.out.length, 3);
});

test('A* route respects one-way streets', () => {
  const net = new RoadNetwork(ways);
  // driving D → C: the one-way street runs C → D, so we must go D → B → C (200 m)
  const r = net.route(100, 100, 200, 0, true);
  assert.ok(r);
  assert.ok(Math.abs(r.length - 200) < 1, `length ${r.length}`);
  // from the middle of the one-way street (150,100) to C(200,0):
  // driving must follow it to D then D → B → C (50 + 100 + 100 = 250 m),
  // walking may go back against the one-way direction (50 + 100 = 150 m)
  assert.ok(Math.abs(net.route(150, 100, 200, 0, true).length - 250) < 1);
  assert.ok(Math.abs(net.route(150, 100, 200, 0, false).length - 150) < 1);
});

test('nearest road point', () => {
  const net = new RoadNetwork(ways);
  const n = net.nearest(50, 5);
  assert.ok(Math.abs(n.d - 5) < 1e-9);
  assert.ok(Math.abs(n.x - 50) < 1e-9);
});

test('wanted: unwitnessed carjack gives no heat, witnessed raises level', () => {
  const w = new WantedSystem(WANTED);
  w.report('carjack', { witnesses: 0 });
  assert.equal(w.level, 0);
  w.report('carjack', { witnesses: 2 });
  assert.equal(w.level, 1);
  w.report('stealPolice', { witnessedByPolice: true });
  assert.ok(w.level >= 2);
});

test('wanted: heat is lost after the cooldown out of sight', () => {
  const events = [];
  const w = new WantedSystem(WANTED, (t, p) => events.push([t, p]));
  w.setMinLevel(2);
  assert.equal(w.level, 2);
  w.update(5, false);
  assert.ok(w.searching);
  w.update(1, true); // spotted again resets the timer
  assert.equal(w.unseen, 0);
  for (let i = 0; i < 40; i++) w.update(1, false);
  assert.equal(w.level, 0);
  assert.deepEqual(
    events.map((e) => e[1].level),
    [2, 0],
  );
});

// ---------------------------------------------------------------- traffic rules (agent: traffic)
import { laneLateral, lanesPerDir, turnKind, speedLimit, trafficFactor, pedFactor, frankfurtClock } from '../src/world/roadNetwork.js';

// a cross-roads at X(0,0) with legs N(0,-100) E(100,0) S(0,100) W(-100,0)
const crossWays = (nsCls, ewCls) => [
  {
    pts: [
      [0, -100],
      [0, 0],
      [0, 100],
    ],
    speed: 9,
    width: 7,
    cls: nsCls,
  },
  {
    pts: [
      [-100, 0],
      [0, 0],
      [100, 0],
    ],
    speed: 9,
    width: 7,
    cls: ewCls,
  },
];
const legEdge = (net, x, z) => net.edges.find((e) => e.pts.some((p) => p[0] === x && p[1] === z));

test('traffic: rechts vor links between residential streets', () => {
  const net = new RoadNetwork(crossWays(6, 6));
  const X = net.nodeByKey.get('0,0').id;
  const S = legEdge(net, 0, 100),
    N = legEdge(net, 0, -100),
    E = legEdge(net, 100, 0),
    W = legEdge(net, -100, 0);
  assert.equal(net.junction(X).kind, 'rvl');
  // driving north (S → N) the east leg is on the right (z = -lat, x = east)
  assert.equal(net.yieldsTo(X, S, N, E, W), true);
  // the car from the east (driving west) must give way to us: we come from its right
  assert.equal(net.yieldsTo(X, E, W, S, N), false);
  // from the left: no need to wait
  assert.equal(net.yieldsTo(X, S, N, W, E), false);
  // left turn yields to oncoming straight traffic
  assert.equal(net.yieldsTo(X, S, W, N, S), true);
  // two right turns from opposite legs don't conflict
  assert.equal(net.yieldsTo(X, S, E, N, W), false);
});

test('traffic: Vorfahrtstraße beats rechts vor links', () => {
  const net = new RoadNetwork(crossWays(3, 6)); // N–S is a secondary road, E–W residential
  const X = net.nodeByKey.get('0,0').id;
  const S = legEdge(net, 0, 100),
    N = legEdge(net, 0, -100),
    E = legEdge(net, 100, 0),
    W = legEdge(net, -100, 0);
  assert.equal(net.junction(X).kind, 'priority');
  // on the priority road we don't yield to the car from the right
  assert.equal(net.yieldsTo(X, S, N, E, W), false);
  // the side street yields to the priority road, from either side
  assert.equal(net.yieldsTo(X, W, E, S, N), true);
  assert.equal(net.yieldsTo(X, E, W, N, S), true);
  // signals: only the left-turn rule applies
  assert.equal(net.yieldsTo(X, W, E, S, N, true), false);
});

test('traffic: lanes keep right and speed limits', () => {
  const two = { width: 7, oneway: false, lanes: 0 };
  assert.ok(laneLateral(two, 1, 0) > 0 && laneLateral(two, -1, 0) > 0, 'right-hand traffic both ways');
  const wide = { width: 14, oneway: false, lanes: 4 };
  assert.equal(lanesPerDir(wide), 2);
  assert.ok(laneLateral(wide, 1, 0) > laneLateral(wide, 1, 1), 'lane 0 is the right-most');
  const one = { width: 8, oneway: true, lanes: 2 };
  assert.ok(laneLateral(one, 1, 0) > 0 && laneLateral(one, 1, 1) < 0);
  assert.equal(turnKind(0, Math.PI / 2), 'L');
  assert.equal(turnKind(0, -Math.PI / 2), 'R');
  assert.equal(turnKind(0, Math.PI), 'U');
  assert.equal(Math.round(speedLimit(6) * 3.6), 30);
  assert.equal(Math.round(speedLimit(3) * 3.6), 50);
});

test('traffic: rush hour and quiet Sunday mornings', () => {
  assert.ok(trafficFactor(2, 8) > trafficFactor(2, 12));
  assert.ok(trafficFactor(2, 17.5) > trafficFactor(2, 21));
  assert.ok(trafficFactor(0, 8) < trafficFactor(2, 8) * 0.5);
  assert.ok(trafficFactor(3, 3) < 0.3);
  assert.ok(pedFactor(6, 13) > pedFactor(0, 13), 'shops are shut on Sundays');
  // 06:30 UTC on a Monday in November is 07:30 in Frankfurt
  const c = frankfurtClock(new Date(Date.UTC(2026, 10, 9, 6, 30)));
  assert.equal(c.dow, 1);
  assert.equal(c.hour, 7.5);
});
