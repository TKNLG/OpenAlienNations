// Leisure of idle porters (job 0x03) and how visitors get out again: the candidate filter (active
// buildings whose job slot is free or holds the visit job; never a house still running its house
// job), one house visitor per run, the visit job's 299-tick release, and what a released porter
// does. Spec: docs/game/units-and-jobs.md 4.4 "Residences", 5.7, 8.3. Needs AN_DATA
// (Pimmons.mdb 4: a Pimmon town with four small houses and an active tavern, landlord inside).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { loadMission, DATA } from './helpers/mission.ts';
import { Kind, SUB, type World, type Entity } from '../src/engine/world.ts';
import { T } from '../src/engine/economy.ts';

const skip = !existsSync(`${DATA}/dv.odb`) && 'AN_DATA not set';
const LEISURE = 0x03, GOTO = 0x3c, VISIT = 0x22, TAVERN = 58, CIRCUS = 57;
const LEISURE_TYPES = [T.SmallHouse, T.LargeHouse, CIRCUS, TAVERN];
const steps = (w: World, n: number) => { for (let i = 0; i < n; i++) w.step(); };
const type = (e: Entity) => e.oid & 0xffff;
const cell = (e: Entity): [number, number] => [Math.floor(e.x / SUB), Math.floor(e.y / SUB)];

function mission() {
  const { world: w, mission: m } = loadMission('Pimmons.mdb', 4, DATA, false);
  const me = m.humanRace;
  const t = w.economy.towns.find(x => x.race === me)!;
  const of = (ty: number) => w.entities.filter(e => e.kind === Kind.Building && e.town === t.id && type(e) === ty);
  return { w, me, t, houses: of(T.SmallHouse), tavern: of(TAVERN)[0] };
}
/** stop the town's leisure job, empty the visit buildings (tests of single visits) */
function quiet(w: World, bs: Entity[]) {
  steps(w, 60);
  for (const j of w.sched.snapshot().slots.flat()) if (j.kind === LEISURE) w.sched.cancel(j.id);
  for (const b of bs) for (const u of w.logistics.occupants(b)) if (type(u) === T.Porter) w.logistics.leave(u);
  steps(w, 60);
}
function porterNear(w: World, me: number, b: Entity): Entity {
  const t = w.economy.town(b.town)!;
  const [ex, ey] = w.logistics.entrance(b);
  for (let r = 3; r < 12; r++)
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r || w.occupied(ex + dx, ey + dy)) continue;
        const u = w.spawnUnit(me, T.Porter, ex + dx, ey + dy, t.id);
        w.economy.joinTown(u, t);
        return u;
      }
  throw new Error('no free cell');
}
/** what the leisure job does to a porter (5.7 step 3): a go-to that enters, +0x78 = -1 */
function sendOnVisit(w: World, u: Entity, b: Entity) {
  w.logistics.assign(u, GOTO, 1, [0, b.id, T.Porter, 1]);
  u.idle = -1;
}
function untilInside(w: World, u: Entity, b: Entity): number {
  for (let i = 0; i < 600 && u.inside !== b.id; i++) w.step();
  assert.equal(u.inside, b.id, 'entered');
  return w.tick;
}
const live = (w: World, id: number) => { const j = id ? w.sched.get(id) : undefined; return j && !j.cancelled ? j : undefined; };

test('leisure: targets are active buildings with a free or visit slot; a house still running its house job is never picked; one visitor per house and run', { skip }, () => {
  const { w, t } = mission();
  assert.ok(t.id >= 0);
  const last = new Map<number, number>();
  const perRun = new Map<string, number>();
  let houseVisits = 0, tavernVisits = 0, nonFullSeen = 0;
  for (let i = 0; i < 6000; i++) {
    w.step();
    for (const u of w.entities) {
      if (u.kind !== Kind.Unit || type(u) !== T.Porter || u.town !== t.id) continue;
      const j = live(w, u.job);
      if (!j || last.get(u.id) === j.id) continue;
      last.set(u.id, j.id);
      if (j.kind !== GOTO || u.idle !== -1) continue;            // not sent by the leisure job
      const b = w.get(j.data[1])!;
      assert.ok(LEISURE_TYPES.includes(type(b)), `a leisure building (${type(b)})`);
      assert.ok(b.active, 'active');
      assert.ok(!live(w, b.houseJob), 'never a house whose house job runs (not full)');
      const s = live(w, b.opJob);
      assert.ok(!s || s.kind === VISIT, 'slot free or holding the visit job');
      if (type(b) === TAVERN) tavernVisits++;
      else {
        houseVisits++;
        const k = `${w.tick}:${b.id}`;
        perRun.set(k, (perRun.get(k) ?? 0) + 1);
        assert.equal(perRun.get(k), 1, 'a house gets one leisure visitor per run');
      }
    }
    if (w.entities.some(b => b.kind === Kind.Building && b.town === t.id && type(b) === T.SmallHouse && live(w, b.houseJob))) nonFullSeen++;
  }
  assert.ok(nonFullSeen > 0, 'the test saw non-full houses');
  assert.ok(houseVisits > 0 && tavernVisits > 0, `visits happened (houses ${houseVisits}, tavern ${tavernVisits})`);
});

test('leisure: a tavern visitor is let out 299 ticks after he entered, then stands outside idle and takes no further visit', { skip }, () => {
  const { w, me, t, tavern, houses } = mission();
  assert.ok(tavern.active, 'the landlord is inside');
  quiet(w, [tavern, ...houses]);
  const u = porterNear(w, me, tavern);
  sendOnVisit(w, u, tavern);
  const e = untilInside(w, u, tavern);
  assert.ok(live(w, tavern.opJob)?.kind === VISIT, 'the visit job started');
  assert.equal(u.job, 0, 'no job inside');
  let out = -1;
  for (let i = 0; i < 400 && out < 0; i++) { w.step(); if (w.logistics.leaving(u)) out = w.tick; }
  assert.equal(out - e, 299, 'ejected by the visit job 299 ticks after entering');
  for (let i = 0; i < 60 && u.inside >= 0; i++) w.step();
  assert.equal(u.inside, -1, 'outside');
  assert.ok(w.logistics.dist(...cell(u), ...w.logistics.entrance(tavern)) <= 2, 'at the door');
  assert.equal(u.idle, -1, 'the visit leaves +0x78 at -1');
  assert.ok(live(w, tavern.opJob), 'the landlord is still inside: the job runs once more');
  steps(w, 300);
  assert.equal(tavern.opJob, 0, 'and then ends');
  // the leisure job skips him until he has had a job; he stays free for work
  w.sched.create(LEISURE, t.id, 1);
  let again = false;
  for (let i = 0; i < 1500; i++) { w.step(); if (u.inside >= 0 && u.idle === -1) again = true; }
  assert.equal(again, false, 'no new visit by himself');
  assert.equal(w.ai.free(u) || u.job !== 0, true, 'free for the dispatcher (or already at work)');
});

test('leisure: a visitor in his own home that is not full stays until the house is full and another visitor comes; then both leave, one per 299 ticks', { skip }, () => {
  const { w, me, houses, tavern } = mission();
  quiet(w, [tavern, ...houses]);
  const house = houses[0];
  if (!live(w, house.houseJob)) house.houseJob = w.sched.create(0x0a, house.id, 599).id;
  house.occupancy = 0;
  const p = porterNear(w, me, house);
  p.home = house.id;
  sendOnVisit(w, p, house);
  untilInside(w, p, house);
  assert.equal(house.opJob, 0, 'no visit job while the house job holds the slot');
  steps(w, 1000);
  assert.equal(p.inside, house.id, 'still inside');
  assert.equal(w.ai.free(p), true, 'a leisure visitor inside is free for work');
  // the house fills up: its house job ends, the house becomes a leisure target, a visitor comes
  house.occupancy = w.rules.get(house.oid)!.residents;
  w.sched.cancel(house.houseJob); house.houseJob = 0;
  const q = porterNear(w, me, house);
  sendOnVisit(w, q, house);
  const e = untilInside(w, q, house);
  assert.ok(live(w, house.opJob)?.kind === VISIT, 'the visit job started');
  const outAt = new Map<number, number>();
  for (let i = 0; i < 700 && outAt.size < 2; i++) {
    w.step();
    for (const u of [p, q]) if (!outAt.has(u.id) && w.logistics.leaving(u)) outAt.set(u.id, w.tick - e);
  }
  assert.equal(outAt.get(q.id), 299, 'the last one in goes first');
  assert.equal(outAt.get(p.id), 598, 'the home owner 299 ticks later');
  steps(w, 60);
  assert.equal(house.opJob, 0, 'empty: the visit job ended');
  assert.ok(p.inside < 0 && q.inside < 0);
});

test('leisure: in a long run nobody stays inside a leisure building for good', { skip }, () => {
  const { w, t } = mission();
  const since = new Map<number, number>();
  let visits = 0, longest = 0;
  const porters = () => w.entities.filter(u => u.kind === Kind.Unit && u.alive && type(u) === T.Porter && u.town === t.id).length;
  for (let i = 0; i < 20000; i++) {
    w.step();
    for (const u of w.entities) {
      if (u.kind !== Kind.Unit || type(u) !== T.Porter) continue;
      const b = u.inside >= 0 ? w.get(u.inside) : undefined;
      const inL = !!b && b.kind === Kind.Building && LEISURE_TYPES.includes(type(b));
      if (inL && !since.has(u.id)) { since.set(u.id, w.tick); visits++; }
      if (!inL && since.has(u.id)) { longest = Math.max(longest, w.tick - since.get(u.id)!); since.delete(u.id); }
    }
  }
  // the visit job lets one porter out per 299 ticks, so a stay is bounded by the porters there
  const bound = 299 * porters() + 100;
  assert.ok(visits > 0, 'porters went on visits');
  assert.ok(longest <= bound, `longest stay ${longest} <= ${bound}`);
  for (const [id, s] of since) assert.ok(w.tick - s <= bound, `unit ${id} inside since ${s}`);
});
