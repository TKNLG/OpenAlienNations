// Re-training: any unit of the race may enter a training building (class 5) and stays inside,
// idle, as a pupil until an order retypes it, it is sent out or the building is lost. A queued
// order uses a pupil already inside instead of calling a porter. Spec: docs/game/units-and-jobs.md
// 4.4, 9.1; docs/ui/side-panel.md class 7 / class 9; ai-diplomacy-trade.md 1.8. Needs AN_DATA
// (real mission: Pimmons.mdb 4, the human Pimmons with a completed school).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { loadMission, loadAddonMission, DATA, GOLD, HAS_GOLD } from './helpers/mission.ts';
import { Kind, Action, type World, type Entity } from '../src/engine/world.ts';
import { T } from '../src/engine/economy.ts';
import { trainingView } from '../src/client/hud-pages.ts';

const skip = !existsSync(`${DATA}/dv.odb`) && 'AN_DATA not set';
const SCHOOL = 55, STONEMASON = 27, ARCHER = 29;

function mission() {
  const { world: w, mission: m } = loadMission('Pimmons.mdb', 4, DATA, false);
  const me = m.humanRace;
  const school = w.entities.find(e => e.kind === Kind.Building && e.owner === me && (e.oid & 0xffff) === SCHOOL && e.complete)!;
  assert.ok(school, 'a completed school');
  const t = w.economy.town(school.town)!;
  w.economy.players[me]!.money += 1000;
  return { w, me, school, t };
}
const steps = (w: World, n: number) => { for (let i = 0; i < n; i++) w.step(); };
const type = (u: Entity) => u.oid & 0xffff;
/** a new unit of `ty` of the town, standing a few cells from the school */
function unitNear(w: World, me: number, school: Entity, ty: number): Entity {
  const t = w.economy.town(school.town)!;
  const [ex, ey] = w.logistics.entrance(school);
  for (let r = 3; r < 12; r++)
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r || w.occupied(ex + dx, ey + dy)) continue;
        const u = w.spawnUnit(me, ty, ex + dx, ey + dy, t.id);
        w.economy.joinTown(u, t);
        return u;
      }
  throw new Error('no free cell');
}
function untilInside(w: World, u: Entity, b: Entity, max = 600): void {
  for (let i = 0; i < max && u.inside !== b.id; i++) w.step();
  assert.equal(u.inside, b.id, 'the unit went in');
}
const porterRequests = (w: World, school: Entity) => w.economy.town(school.town)!.workerReqs.filter(([ty, id]) => ty === T.Porter && id === school.id).length;

test('retrain: a builder ordered into the school stays inside, idle, listed as an occupant, until sent out', { skip }, () => {
  const { w, me, school } = mission();
  steps(w, 60);
  const before = w.logistics.occupants(school).length;
  const builder = unitNear(w, me, school, T.Builder);
  w.schedule({ type: 'order', player: me, ids: [builder.id], target: school.id });
  untilInside(w, builder, school);
  steps(w, 400);
  assert.equal(builder.inside, school.id, 'still inside 400 ticks later');
  assert.equal(builder.job, 0, 'no job: not sent straight back out');
  assert.equal(w.logistics.leaving(builder), false);
  assert.ok(w.logistics.occupants(school).includes(builder), 'in the occupant list');
  assert.equal(w.logistics.occupants(school).length, before + 1);
  assert.equal(w.ai.free(builder), false, 'a unit inside is not free for the dispatcher');
  // the training page counts him as a pupil: an empty queue still says "nobody in training"
  assert.equal(trainingView(school.queue, w.logistics.occupants(school).length, false, 0, 50, [], school.local).status, 'empty');
  // the inhabitants page lists him under his type; its send-out gets him out (4.11)
  w.schedule({ type: 'sendOut', player: me, building: school.id, unit: T.Builder });
  w.step();
  assert.ok(w.logistics.leaving(builder));
  for (let i = 0; i < 60 && builder.inside >= 0; i++) w.step();
  assert.equal(builder.inside, -1, 'outside after the send-out');
  assert.equal(type(builder), T.Builder, 'unchanged');
});

test('retrain: an order uses the pupil already inside (builder -> stonemason), no porter is called', { skip }, () => {
  const { w, me, school, t } = mission();
  steps(w, 60);
  assert.equal(w.logistics.occupants(school).length, 0, 'the school is empty');
  const builder = unitNear(w, me, school, T.Builder);
  builder.exp = 77; builder.rank = 1;
  const home = builder.home;
  w.schedule({ type: 'order', player: me, ids: [builder.id], target: school.id });
  untilInside(w, builder, school);
  const builders = w.economy.count(t, T.Builder, false);
  w.schedule({ type: 'train', player: me, building: school.id, unit: STONEMASON });
  w.step();
  assert.deepEqual(school.queue, [STONEMASON]);
  assert.equal(porterRequests(w, school), 0, 'orders before (0) < units inside (1): no porter request');
  // the slot is normal at once (a pupil is inside for it)
  assert.equal(trainingView(school.queue, w.logistics.occupants(school).length, !!school.trainStarted, school.trainProgress, 50, [], school.local).slots[0].dark, false);
  let done = -1;
  for (let i = 0; i < 400 && done < 0; i++) { w.step(); if (type(builder) === STONEMASON) done = i; }
  assert.ok(done >= 300 - 31 && done <= 330, `retyped after the 300-tick training (${done})`);
  assert.ok(w.logistics.leaving(builder), 'the trained unit is ejected');
  assert.equal(school.queue.length, 0);
  assert.equal(w.economy.count(t, T.Builder, false), builders - 1, 'one builder fewer');
  assert.equal(builder.exp, 77, 'experience kept by the retype');
  assert.equal(builder.rank, 1, 'rank kept');
  assert.equal(builder.home, home, 'home kept');
  for (let i = 0; i < 60 && builder.inside >= 0; i++) w.step();
  assert.equal(builder.inside, -1, 'comes out as a stonemason');
  // no porter was taken: the town's porters are all outside
  assert.ok(!w.entities.some(e => e.kind === Kind.Unit && e.town === t.id && type(e) === T.Porter && e.inside === school.id));
});

test('retrain: porter is an order of its own; a soldier inside becomes a porter; a porter order never calls a porter', { skip }, () => {
  const { w, me, school } = mission();
  steps(w, 60);
  // an empty school: a porter order waits for a pupil ("Warte auf Schüler"), no request
  w.schedule({ type: 'train', player: me, building: school.id, unit: T.Porter });
  w.step();
  assert.deepEqual(school.queue, [T.Porter]);
  assert.equal(porterRequests(w, school), 0, 'a porter order files no porter request');
  steps(w, 200);
  assert.equal(school.queue.length, 1, 'nothing happens without a pupil');
  assert.equal(trainingView(school.queue, 0, false, 0, 50, [], school.local).status, 'pupil');
  const archer = unitNear(w, me, school, ARCHER);
  w.schedule({ type: 'order', player: me, ids: [archer.id], target: school.id });
  untilInside(w, archer, school);
  let done = false;
  for (let i = 0; i < 400 && !done; i++) { w.step(); done = type(archer) === T.Porter; }
  assert.ok(done, 'the archer is retrained into a porter');
  assert.equal(archer.hp, w.rules.get(archer.oid)!.hp, 'HP of the new type');
});

test('retrain: a porter entering a school with nothing queued stays inside too', { skip }, () => {
  const { w, me, school } = mission();
  steps(w, 60);
  const p = unitNear(w, me, school, T.Porter);
  w.schedule({ type: 'order', player: me, ids: [p.id], target: school.id });
  untilInside(w, p, school);
  steps(w, 300);
  assert.equal(p.inside, school.id);
  assert.equal(p.job, 0);
  assert.equal(p.action, Action.Idle);
});

test('retrain: a released AI gang member walks into the school and waits there as a pupil (ai 1.8)', { skip }, () => {
  const { w, me, school } = mission();
  steps(w, 60);
  const wc = unitNear(w, me, school, 19);   // woodcutter
  w.logistics.goInto(wc, school, 1);
  untilInside(w, wc, school);
  steps(w, 300);
  assert.equal(wc.inside, school.id, 'not left standing at the door');
  assert.ok(w.logistics.trainees(school).includes(wc), 'available as a trainee');
  // a "porter" order (the AI's school flush) retypes it
  assert.ok(w.logistics.train(school, T.Porter));
  for (let i = 0; i < 400 && type(wc) !== T.Porter; i++) w.step();
  assert.equal(type(wc), T.Porter);
});

test('retrain (Gold): the shipyard keeps a builder as its pupil and turns him into a boat; ships are refused at class-5 doors', { skip: !HAS_GOLD && 'AN_GOLD data not found' }, () => {
  const { world: w, mission: m } = loadAddonMission('SajikisAO.mdb', 2, GOLD, false);
  const me = m.humanRace;
  const yard = w.entities.find(e => e.kind === Kind.Building && e.owner === me && (e.oid & 0xffff) === 63 && e.complete)!;
  const school = w.entities.find(e => e.kind === Kind.Building && e.owner === me && (e.oid & 0xffff) === SCHOOL && e.complete)!;
  assert.ok(yard && school);
  const t = w.economy.town(yard.town)!;
  w.economy.players[me]!.money += 5000;
  for (let g = 0; g < t.stock.length; g++) t.stock[g] += 50;
  steps(w, 60);
  const builder = unitNear(w, me, yard, T.Builder);
  w.schedule({ type: 'order', player: me, ids: [builder.id], target: yard.id });
  untilInside(w, builder, yard, 1200);
  steps(w, 100);
  assert.equal(builder.inside, yard.id, 'stays inside the shipyard');
  const st = w.logistics.trainState(t, yard, 64);
  assert.ok(st === 1 || st === 3, `a fishing boat can be ordered (${st})`);
  assert.ok(w.logistics.train(yard, 64));
  assert.equal(porterRequests(w, yard), 0, 'the pupil inside covers the order');
  for (let g = 0; g < t.stock.length; g++) yard.local[g] += 20;   // the goods, without waiting for porters
  for (let i = 0; i < 900 && type(builder) !== 64; i++) w.step();
  assert.equal(type(builder), 64, 'the builder became a fishing boat');
  assert.ok(w.isShip(builder));
  // a ship never enters a training building (addon.md 3.4)
  assert.equal(w.logistics.mayEnter(builder, school), false);
  assert.equal(w.logistics.mayEnter(builder, yard), false);
});
