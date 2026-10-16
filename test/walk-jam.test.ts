// Head-on meetings and jams (docs/game/units-and-jobs.md 4.1 "Two planning modes", 4.7 "Head-on
// meetings and jams", 4.2, 4.10): a failed search is retried, re-plans after a blocked step keep
// out the units nearby, the arrival tolerance grows with every plan, and the go-to / enter jobs
// ignore how their walks ended. Two porters meeting in a corridor one cell wide therefore both
// deliver. The first tests need no game data.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { World, SUB, type Entity } from '../src/engine/world.ts';
import { WS, WalkResult, MAX_PLANS } from '../src/engine/motion.ts';
import { Good } from '../src/engine/economy.ts';
import type { Terrain } from '../src/world/terrain.ts';
import type { MapObject } from '../src/formats/mission.ts';
import { loadMission, DATA } from './helpers/mission.ts';

const WATER = 11;
const skip = !existsSync(`${DATA}/dv.odb`) && 'AN_DATA not set';
const cell = (e: Entity): [number, number] => [Math.floor(e.x / SUB), Math.floor(e.y / SUB)];
const porter = (x: number, y: number): MapObject => ({ cls: 0, group: 0, type: 9, owner: 1, x, y, z: 0 });

/** flat 64x64 map, water everywhere except the row y = 10 between x = 2 and x = 40 */
function corridor(): Terrain {
  const n = 64, cls = new Uint8Array(n * n).fill(WATER);
  for (let x = 2; x <= 40; x++) cls[(10 << 6) | x] = 0;
  return { sizeBits: 6, size: n, height: new Uint16Array(n * n).fill(128), cls, tile: new Uint8Array(n * n) };
}

test('a search that finds nothing does not fail the walk: it is retried until the 15-plan limit', {}, () => {
  const w = new World(corridor(), [porter(5, 10)]);
  const u = w.get(1)!;
  assert.equal(w.follow(u, 30, 30), true, 'the walk is set up');
  assert.ok(u.path && u.path.length === 0 && u.walkState === WS.ReplanFree, 'no path yet, a plan is due');
  let t = 0;
  while (u.path && t < 2000) { w.step(); t++; }
  assert.equal(u.walkResult, WalkResult.Failed);
  assert.equal(u.plans, MAX_PLANS, 'every plan was used');
  // plans cost 3, 4, 5, ... ticks: about 3 + 4 + ... + 17
  assert.ok(t >= 140 && t <= 160, `ended after ${t} ticks`);
  assert.deepEqual(cell(u), [5, 10], 'it never moved: a way that does not reach the goal is no path');
});

test('two walkers head-on in a corridor one cell wide: re-plans fail, plans grow, both walks end', {}, () => {
  const w = new World(corridor(), [porter(5, 10), porter(25, 10)]);
  const a = w.get(1)!, b = w.get(2)!;
  a.dir = 5; b.dir = 1;
  w.follow(a, 30, 10);
  w.follow(b, 3, 10);
  let maxA = 0, maxB = 0, ticks = 0;
  for (; ticks < 1000 && (a.path || b.path); ticks++) {
    w.step();
    assert.ok(cell(a).join() !== cell(b).join(), `tick ${w.tick}: never on one cell`);
    maxA = Math.max(maxA, a.plans); maxB = Math.max(maxB, b.plans);
  }
  assert.ok(!a.path && !b.path, 'no lasting deadlock');
  assert.ok(maxA > 2 && maxB > 2, `both re-planned (${maxA}, ${maxB})`);
  assert.ok(ticks < 400, `a jam costs time, not the walk (${ticks} ticks)`);
});

test('mode-0 re-plans keep out the units near the walker: in open ground it walks round a stuck walker', {}, () => {
  // B stands on A's way and walks into a wall (its next cell blocked): A plans round it
  const n = 64, cls = new Uint8Array(n * n);
  const t: Terrain = { sizeBits: 6, size: n, height: new Uint16Array(n * n).fill(128), cls, tile: new Uint8Array(n * n) };
  const w = new World(t, [porter(10, 10), porter(14, 10), porter(14, 9)]);
  const a = w.get(1)!, b = w.get(2)!, c = w.get(3)!;
  a.dir = 5;
  // B is "walking" toward C's cell, and C is busy: B cannot step, so A re-plans in mode 0
  c.job = w.sched.create(0x7f, c.id, 599).id;
  b.job = w.sched.create(0x7f, b.id, 599).id;
  w.follow(b, 14, 9);
  w.follow(a, 20, 10);
  let detour = false;
  for (let i = 0; i < 200 && a.path; i++) {
    w.step();
    const [x, y] = cell(a);
    if (x >= 13 && x <= 15 && y !== 10) detour = true;
  }
  assert.deepEqual(cell(a), [20, 10], 'A arrived');
  assert.ok(detour, 'A went round B');
});

// ---------------------------------------------------------------- with game data

/** Pimmons mission 0 without computer players; a paused school site a few cells from the town hall */
function setup() {
  const { world: w, mission: m } = loadMission('Pimmons.mdb', 0, DATA, false);
  const me = m.humanRace, t = w.economy.towns.find(x => x.race === me)!;
  const hall = w.get(t.hall)!;
  const r = w.rules.get((me << 16) | 55)!;
  let spot: [number, number] | null = null;
  for (let rad = 9; rad < 20 && !spot; rad++)
    for (let dy = -rad; dy <= rad && !spot; dy++)
      for (let dx = -rad; dx <= rad && !spot; dx++)
        if (Math.max(Math.abs(dx), Math.abs(dy)) === rad && w.logistics.canPlace(t, r, t.x + dx, t.y + dy)) spot = [t.x + dx, t.y + dy];
  assert.ok(spot, 'a place for the school');
  w.schedule({ type: 'build', player: me, town: t.id, building: 55, x: spot![0], y: spot![1] });
  w.step();
  const site = w.entities.find(e => (e.oid & 0xffff) === 55 && e.owner === me)!;
  w.logistics.buildingAction(site, 'pause');   // no other traffic for the site
  return { w, me, t, hall, site };
}

test('two porters meet head-on in a one-cell corridor between a store and a site: both deliveries happen', { skip }, () => {
  const { w, me, t, hall, site } = setup();
  const size = w.size, m = size - 1, idx = (x: number, y: number) => ((y & m) << w.bits) | (x & m);
  const [hx, hy] = w.goalCell(...w.logistics.entrance(hall));
  const [sx, sy] = w.goalCell(...w.logistics.entrance(site));
  const path = w.findPathOn(w.blocked, hx, hy, sx, sy)!;
  assert.ok(path && path.length >= 8, `a way of some length (${path?.length})`);
  // water round the way: a corridor one cell wide (cells of buildings, nature and units stay); a
  // diagonal step gets an orthogonal cell beside it, since no step cuts a corner next to water
  const cells: [number, number][] = [[hx, hy]];
  for (const [x, y] of path) {
    const [px, py] = cells[cells.length - 1];
    if (x !== px && y !== py) cells.push(w.blocked[idx(x, py)] ? [px, y] : [x, py]);
    cells.push([x, y]);
  }
  const way = new Set(cells.map(([x, y]) => idx(x, y)));
  for (const [px, py] of cells) {
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const i = idx(px + dx, py + dy);
      if (way.has(i) || w.blocked[i] || w.motion.unitOn(i)) continue;
      w.terrain.cls[i] = WATER; w.blocked[i] = 1;
    }
  }
  // the town's other units keep off the corridor
  for (const e of w.entities) if (e.kind === 0 && e.inside < 0) { const [x, y] = cell(e); if (way.has(idx(x, y))) w.place(e, x + 40, y + 40); }
  const [ax, ay] = path[1], [bx, by] = path[path.length - 3];
  const A = w.spawnUnit(me, 9, ax, ay, t.id); w.economy.joinTown(A, t);
  const B = w.spawnUnit(me, 9, bx, by, t.id); w.economy.joinTown(B, t);
  A.carryGood = Good.Wood; A.carryAmount = 1;
  B.carryGood = Good.Stone; B.carryAmount = 1;
  t.stock[Good.Stone] = Math.min(t.stock[Good.Stone], t.capacity - 5);
  const siteWood = site.local[Good.Wood], hallStone = t.stock[Good.Stone];
  w.logistics.startTransport(A, site, null, null);
  w.logistics.startTransport(B, hall, null, null);
  const jobA = A.job, jobB = B.job;
  let plans = 0, ticks = 0;
  const active = () => (A.job === jobA || A.carryAmount > 0) || (B.job === jobB || B.carryAmount > 0);
  for (; ticks < 3000 && active(); ticks++) {
    w.step();
    plans = Math.max(plans, A.plans, B.plans);
    if (A.inside < 0 && B.inside < 0) assert.ok(cell(A).join() !== cell(B).join(), `tick ${w.tick}: one unit per cell`);
  }
  assert.equal(A.carryAmount, 0, 'A delivered');
  assert.equal(B.carryAmount, 0, 'B delivered');
  assert.equal(site.local[Good.Wood], siteWood + 1, 'the wood is in the site');
  assert.equal(t.stock[Good.Stone], hallStone + 1, 'the stone is in the town stock');
  assert.ok(plans >= 2, `they were in each other's way (${plans} plans)`);
  assert.ok(ticks < 1500, `the jam cost time, not the goods (${ticks} ticks)`);
  assert.ok(A.job !== jobA && B.job !== jobB, 'both transports are over');
});
