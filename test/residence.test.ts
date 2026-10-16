// Residences (houses, town hall): who the door admits, what porters inside do (the shared job
// slot of the house job and the visit job), the eject-all when a resident leaves, and "go home"
// (command 0x20), which is a walk and enters nothing. Spec: docs/game/units-and-jobs.md 3.2,
// 4.4 "Residences", 5.7, 8.3. Needs AN_DATA (Pimmons.mdb 4: the human Pimmons with houses).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { loadMission, DATA } from './helpers/mission.ts';
import { Kind, SUB, type World, type Entity } from '../src/engine/world.ts';
import { T } from '../src/engine/economy.ts';

const skip = !existsSync(`${DATA}/dv.odb`) && 'AN_DATA not set';
const ARCHER = 29, WOODCUTTER = 19;

function mission() {
  const { world: w, mission: m } = loadMission('Pimmons.mdb', 4, DATA, false);
  const me = m.humanRace;
  const house = w.entities.find(e => e.kind === Kind.Building && e.owner === me && (e.oid & 0xffff) === T.SmallHouse && e.complete)!;
  const t = w.economy.town(house.town)!;
  const hall = w.get(t.hall)!;
  w.step();
  for (let i = 0; i < 60; i++) w.step();   // births at load are outside
  // no leisure visits (5.7): only the units of each test go in
  for (const j of w.sched.snapshot().slots.flat()) if (j.kind === 0x03) w.sched.cancel(j.id);
  for (const u of w.logistics.occupants(house)) w.logistics.leave(u);
  for (let i = 0; i < 60; i++) w.step();
  return { w, me, house, hall, t };
}
const steps = (w: World, n: number) => { for (let i = 0; i < n; i++) w.step(); };
const cell = (e: Entity): [number, number] => [Math.floor(e.x / SUB), Math.floor(e.y / SUB)];
function unitNear(w: World, me: number, b: Entity, ty: number): Entity {
  const t = w.economy.town(b.town)!;
  const [ex, ey] = w.logistics.entrance(b);
  for (let r = 3; r < 12; r++)
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r || w.occupied(ex + dx, ey + dy)) continue;
        if (w.entities.some(e => e.kind === Kind.Unit && e.alive && e.inside < 0 && cell(e)[0] === ((ex + dx) & (w.size - 1)) && cell(e)[1] === ((ey + dy) & (w.size - 1)))) continue;
        const u = w.spawnUnit(me, ty, ex + dx, ey + dy, t.id);
        w.economy.joinTown(u, t);
        return u;
      }
  throw new Error('no free cell');
}
const order = (w: World, me: number, u: Entity, b: Entity) => w.schedule({ type: 'order', player: me, ids: [u.id], target: b.id });
/** a full house: residents = places and its house job ended (4.4 "Residences") */
function makeFull(w: World, b: Entity): void {
  b.occupancy = w.rules.get(b.oid)!.residents;
  if (b.houseJob) { w.sched.cancel(b.houseJob); b.houseJob = 0; }
}

test('residence door: a builder, a gatherer or a soldier ordered into a house is refused and stays idle at the door', { skip }, () => {
  const { w, me, house } = mission();
  for (const ty of [T.Builder, WOODCUTTER, ARCHER]) {
    const u = unitNear(w, me, house, ty);
    order(w, me, u, house);
    let wasInside = false;
    for (let i = 0; i < 400; i++) { w.step(); if (u.inside >= 0) wasInside = true; }
    assert.equal(wasInside, false, `type ${ty} never got in`);
    assert.equal(u.job, 0, 'the go-to failed: no job');
    assert.ok(w.logistics.dist(...cell(u), ...w.logistics.entrance(house)) <= 2, 'standing at the door');
    assert.ok(!house.doorQueue.includes(u.id), 'not queued');
  }
  assert.equal(w.logistics.occupants(house).length, 0);
});

test('residence door: the town hall refuses porters and a second founder, admits its stored operator', { skip }, () => {
  const { w, me, hall } = mission();
  assert.ok(hall.active);
  const p = unitNear(w, me, hall, T.Porter);
  const f = unitNear(w, me, hall, T.Founder);
  order(w, me, p, hall); order(w, me, f, hall);
  let inside = false;
  for (let i = 0; i < 400; i++) { w.step(); if (p.inside >= 0 || f.inside >= 0) inside = true; }
  assert.equal(inside, false, 'neither entered');
  assert.equal(f.job, 0, 'the founder stands idle at the door (the refused porter is free for work)');
  assert.equal(w.logistics.mayEnter(f, hall), false, 'the founder is admitted only while the hall is inactive or as its operator');
  const op = w.get(hall.operatorId)!;
  assert.equal(w.logistics.mayEnter(op, hall), true, 'its stored operator may come back');
});

test('residence: a porter ordered into a house that is not full stays inside, no visit job (the house job holds the slot)', { skip }, () => {
  const { w, me, house } = mission();
  if (!house.houseJob) house.houseJob = w.sched.create(0x0a, house.id, 599).id;
  house.occupancy = 0;
  const p = unitNear(w, me, house, T.Porter);
  order(w, me, p, house);
  for (let i = 0; i < 400 && p.inside < 0; i++) w.step();
  assert.equal(p.inside, house.id, 'admitted');
  assert.equal(house.opJob, 0, 'no visit job while the house job runs');
  steps(w, 700);
  assert.equal(p.inside, house.id, 'still inside');
  assert.equal(p.job, 0);
  assert.equal(w.ai.free(p), false, 'ordered in, not a leisure visitor: not free');
  assert.ok(w.logistics.occupants(house).includes(p), 'listed (inhabitants page)');
  assert.ok(p.home !== house.id, 'a visitor is no resident');
});

test('residence: in a full house the visit job lets the last porter out every 299 ticks', { skip }, () => {
  const { w, me, house } = mission();
  makeFull(w, house);
  const a = unitNear(w, me, house, T.Porter), b = unitNear(w, me, house, T.Porter);
  order(w, me, a, house);
  for (let i = 0; i < 400 && a.inside < 0; i++) w.step();
  assert.equal(a.inside, house.id);
  assert.ok(house.opJob, 'the visit job started');
  order(w, me, b, house);
  for (let i = 0; i < 400 && b.inside < 0; i++) w.step();
  assert.equal(b.inside, house.id);
  let first: Entity | undefined;
  for (let i = 0; i < 400 && !first; i++) { w.step(); first = [a, b].find(u => w.logistics.leaving(u)); }
  assert.equal(first, b, 'the last porter of the occupant list goes first');
  for (let i = 0; i < 400 && a.inside >= 0; i++) w.step();
  assert.equal(a.inside, -1, 'the other one 299 ticks later');
  steps(w, 40);
  assert.equal(house.opJob, 0, 'the job ends with the house empty');
});

test('residence: a resident leaving ejects every occupant while a visit job runs, then the house job restarts', { skip }, () => {
  const { w, me, house } = mission();
  makeFull(w, house);
  const a = unitNear(w, me, house, T.Porter);
  order(w, me, a, house);
  for (let i = 0; i < 400 && a.inside < 0; i++) w.step();
  assert.ok(house.opJob);
  const resident = w.entities.find(e => e.kind === Kind.Unit && e.home === house.id) ?? (() => {
    const r = unitNear(w, me, house, T.Porter); r.home = house.id; return r;
  })();
  w.economy.leaveHome(resident);
  assert.ok(w.logistics.leaving(a), 'the visitor is ejected at once');
  assert.equal(house.opJob, 0, 'the visit job ended');
  assert.ok(house.houseJob, 'the house job runs again');
});

test('go home (0x20): a walk to the first free cell around the current town hall, entering nothing', { skip }, () => {
  const { w, me, hall, t, house } = mission();
  const u = unitNear(w, me, house, T.Builder);
  const home = u.home;
  w.schedule({ type: 'unit', player: me, ids: [u.id], action: 'home', town: t.id });
  let entered = false;
  for (let i = 0; i < 1500; i++) { w.step(); if (u.inside >= 0) entered = true; if (!u.path && w.logistics.dist(...cell(u), t.x, t.y) <= 1) break; }
  assert.equal(entered, false, 'never inside');
  const [x, y] = cell(u);
  assert.ok(w.logistics.dist(x, y, t.x, t.y) <= 3, `next to the hall's anchor (${x},${y} vs ${t.x},${t.y})`);
  assert.equal(u.job, 0, 'idle on arrival');
  assert.equal(u.home, home, 'home unchanged');
  assert.equal(hall.doorQueue.includes(u.id), false);
  // ignored without a current town of the player's own
  const v = unitNear(w, me, house, T.Builder);
  const before = cell(v);
  w.schedule({ type: 'unit', player: me, ids: [v.id], action: 'home', town: 999 });
  steps(w, 30);
  assert.deepEqual(cell(v), before, 'no current town: nothing');
});
