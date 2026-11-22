// The original path planner and the move order. Spec: docs/game/units-and-jobs.md 3.2 (move
// order), 4.1 (planning, limit order, tolerance), 4.1.1 (the planner), docs/formats/odb.md 2.3
// (slope classes). No game data needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, SUB, type Entity } from '../src/engine/world.ts';
import { Planner, PLAN_CAP, PLAN_RUN, type PlanRequest } from '../src/engine/path.ts';
import { WS, WalkResult, MAX_PLANS } from '../src/engine/motion.ts';
import type { Terrain } from '../src/world/terrain.ts';
import type { MapObject } from '../src/formats/mission.ts';

function flatTerrain(bits: number): Terrain {
  const n = 1 << bits;
  return { sizeBits: bits, size: n, height: new Uint16Array(n * n).fill(128), cls: new Uint8Array(n * n), tile: new Uint8Array(n * n) };
}
const porter = (x: number, y: number, race = 0): MapObject => ({ cls: 0, group: race, type: 9, owner: 1, x, y, z: 0 });
const cell = (e: Entity): [number, number] => [Math.floor(e.x / SUB), Math.floor(e.y / SUB)];

/** a request on an open flat map of 2^bits cells for step times 5/6/7/8 */
function request(bits: number, sx: number, sy: number, gx: number, gy: number, over: Partial<PlanRequest> = {}): PlanRequest {
  const n = 1 << bits;
  return {
    sx, sy, gx, gy, steps: [5, 6, 7, 8], shift: 0, mode: 1, allUnits: false,
    blocked: new Uint8Array(n * n), pathFlag: new Uint8Array(n * n), height: new Uint16Array(n * n).fill(128),
    unitAt: () => false, ...over,
  };
}

test('planner: the two searches meet through the boost; the forward search ends on the goal (4.1.1)', {}, () => {
  // worked by hand: iteration 1 expands both roots, the backward neighbours of the start's
  // neighbours get priority / 4; iteration 2 expands (6,5) from both sides, and the forward node
  // on the goal (boosted by the backward root) heads its list; iteration 3 finds it
  const p = new Planner(6);
  assert.deepEqual(p.plan(request(6, 5, 5, 7, 5)), [[6, 5], [7, 5]]);
  assert.equal(p.iterations, 3);
  assert.deepEqual(p.plan(request(6, 5, 5, 5, 5)), [], 'start = goal: no path cells');
});

test('planner: never a partial path; a closed pocket fails fast through the empty backward list', {}, () => {
  const bits = 6, n = 64;
  const blocked = new Uint8Array(n * n);
  // a ring of walls round (40, 40)
  for (let d = -2; d <= 2; d++) {
    blocked[(38 << bits) | (40 + d)] = 1; blocked[(42 << bits) | (40 + d)] = 1;
    blocked[((40 + d) << bits) | 38] = 1; blocked[((40 + d) << bits) | 42] = 1;
  }
  const p = new Planner(bits);
  assert.equal(p.plan(request(bits, 5, 5, 40, 40, { blocked })), null);
  assert.ok(p.iterations < 20, `${p.iterations} iterations`);
});

test('planner: a search that has not reached its end within 2000 iterations fails after the 21st run', {}, () => {
  // two halves of a 128 map split by two walls (the map wraps): both searches keep open nodes
  const bits = 7, n = 128;
  const blocked = new Uint8Array(n * n);
  for (let y = 0; y < n; y++) { blocked[(y << bits) | 0] = 1; blocked[(y << bits) | 64] = 1; }
  const p = new Planner(bits);
  assert.equal(p.plan(request(bits, 30, 60, 100, 60, { blocked })), null);
  assert.equal(p.iterations, PLAN_CAP + PLAN_RUN, 'the counter passes 2000 only in the 21st run of 100');
});

test('planner: path cells cost half for units and four times the step for animals (4.1.1 step cost)', {}, () => {
  const bits = 6, n = 64;
  const pathFlag = new Uint8Array(n * n);
  for (let x = 4; x <= 30; x++) pathFlag[(11 << bits) | x] = 1;   // a worn path one row beside the straight line
  const onPath = (way: [number, number][]) => way.filter(([x, y]) => pathFlag[(y << bits) | x] === 1).length;
  const p = new Planner(bits);
  const unit = p.plan(request(bits, 5, 10, 28, 10, { pathFlag }))!;
  const animal = p.plan(request(bits, 5, 10, 28, 10, { pathFlag, shift: 2 }))!;
  assert.ok(onPath(unit) > unit.length / 2, `a porter takes the path (${onPath(unit)} of ${unit.length})`);
  assert.equal(onPath(animal), 0, 'an animal keeps off it');
});

test('planner: mode 0 keeps out units near the start only; start and goal are never blocked', {}, () => {
  const bits = 6;
  const units = new Set<number>([(10 << bits) | 6, (10 << bits) | 20]);
  const unitAt = (i: number) => units.has(i);
  const p = new Planner(bits);
  // mode 1 ignores units: the straight way
  const free = p.plan(request(bits, 5, 10, 25, 10, { unitAt }))!;
  assert.ok(free.some(([x, y]) => x === 6 && y === 10));
  // mode 0: the unit next to the start (D = 2 < 32) is avoided; a unit farther than D 32 is not
  const near = p.plan(request(bits, 5, 10, 25, 10, { unitAt, mode: 0 }))!;
  assert.ok(!near.some(([x, y]) => x === 6 && y === 10), 'the neighbour unit is avoided');
  units.add((10 << bits) | 23);   // D from the start = 2 * 18 = 36: ignored
  const far = p.plan(request(bits, 5, 10, 25, 10, { unitAt, mode: 0 }))!;
  assert.ok(far.some(([x, y]) => x === 23 && y === 10), 'a unit beyond D 32 does not count');
  // a unit on the goal: still a way to it
  units.add((10 << bits) | 25);
  const goal = p.plan(request(bits, 5, 10, 25, 10, { unitAt, mode: 0, allUnits: true }))!;
  assert.deepEqual(goal[goal.length - 1], [25, 10]);
});

test('slope classes are asymmetric: a rise of 1 is class 1, a drop needs 16 (odb.md 2.3)', {}, () => {
  const t = flatTerrain(6);
  const h = (x: number, y: number, v: number) => { t.height[(y << 6) | x] = v; };
  h(11, 10, 129);   // one up from 128
  h(12, 10, 113);   // 16 down from 129
  const w = new World(t, [porter(10, 10)]);
  const u = w.get(1)!;
  // follow-path delay = step_time[class] + 1 (4.1); default step times 5/6/7/8
  assert.equal(w.motion.stepDelay(u, 10, 10, 11, 10, true), 7, 'rise of 1: class 1');
  assert.equal(w.motion.stepDelay(u, 11, 10, 10, 10, true), 6, 'drop of 1: class 0');
  assert.equal(w.motion.stepDelay(u, 11, 10, 12, 10, true), 7, 'drop of 16: class 1');
  assert.equal(w.motion.stepDelay(u, 12, 10, 11, 10, true), 7, 'rise of 16: class 1');
});

test('a plan is made at the end of the tick that asked for it (M16); the walker reads it at its next run', {}, () => {
  const w = new World(flatTerrain(6), [porter(10, 10)]);
  const u = w.get(1)!;
  w.follow(u, 20, 10);
  assert.equal(u.walkState, WS.Planning, 'the planner is running during this tick');
  assert.deepEqual(u.path, []);
  w.step();
  assert.equal(u.walkState, WS.Normal);
  assert.equal(u.path!.length, 10, 'the plan arrived');
  assert.equal(u.moveAt, 3, 'first step 3 ticks after the request');
});

test('the 15-plan limit is tested before the arrival tolerance (M13)', {}, () => {
  const w = new World(flatTerrain(6), [porter(10, 10), porter(11, 10)]);
  const u = w.get(1)!;
  w.follow(u, 25, 10);
  w.step();
  // within the tolerance of a walk that has used up its plans: it fails
  u.plans = MAX_PLANS; u.goalX = 12; u.goalY = 10;
  w.motion.replan(u, 0);
  assert.equal(u.walkResult, WalkResult.Failed);
  // one plan fewer: the tolerance ends it as arrived near
  w.follow(u, 25, 10); w.step();
  u.plans = MAX_PLANS - 1; u.goalX = 12; u.goalY = 10;
  w.motion.replan(u, 0);
  assert.equal(u.walkResult, WalkResult.Near);
});

test('move order (3.2): each unit its own spiral cell, a unit on the click stays, the walk plans 1 tick after the order', {}, () => {
  const w = new World(flatTerrain(6), [porter(10, 10), porter(11, 10), porter(12, 10), porter(30, 30)]);
  const [a, b, c, d] = [1, 2, 3, 4].map(id => w.get(id)!);
  w.schedule({ type: 'move', player: 0, ids: [1, 2, 3, 4], x: 30, y: 30 }, 1);
  w.step();   // tick 1: the command
  // the click (30,30) holds unit 4: it is left alone; the others take the click's spiral cells in
  // order, skipping the occupied click itself: (31,29), (31,30), (31,31)
  assert.deepEqual([a, b, c].map(e => [e.goalX, e.goalY]), [[31, 29], [31, 30], [31, 31]]);
  assert.equal(d.path, null, 'the unit on the click got no walk');
  assert.ok([a, b, c].every(e => e.walkState === WS.ReplanFree && e.plans === 0 && e.moveAt === 2), 'first run 1 tick later');
  w.step();   // tick 2: the walk's first run plans
  assert.ok([a, b, c].every(e => e.walkState === WS.Normal && e.plans === 1 && e.path!.length > 0 && e.moveAt === 5));
  // the same order again: the running walks are not restarted
  const before = a.moveAt;
  w.schedule({ type: 'move', player: 0, ids: [1], x: 30, y: 30 }, 3);
  w.step();
  assert.equal(a.moveAt, before);
  assert.equal(a.plans, 1);
  let n = 0;
  while ((a.path || b.path || c.path) && n++ < 400) w.step();
  assert.ok(!a.path && !b.path && !c.path, 'the walks ended');
  assert.equal(new Set([a, b, c, d].map(e => cell(e).join())).size, 4, 'one unit per cell');
  for (const e of [a, b, c]) assert.ok(w.logistics.dist(...cell(e), e.goalX, e.goalY) <= 2, `unit ${e.id} at its cell or stopped by the tolerance`);
});
