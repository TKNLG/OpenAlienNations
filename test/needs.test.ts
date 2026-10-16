// Town needs, births, criminals and happiness. Spec: docs/game/economy.md 3.2, 3.6, 5.3 to 5.6,
// 6 and the deviation list 12. Needs AN_DATA (Pimmons.mdb 0: town hall only; Pimmons.mdb 4: a
// Pimmon town of 16 with an active tavern and police station, operators inside).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { loadMission, DATA } from './helpers/mission.ts';
import { World, Kind, type Entity } from '../src/engine/world.ts';
import { T, type Town } from '../src/engine/economy.ts';
import { MsRand } from '../src/world/rand.ts';

const skip = !existsSync(`${DATA}/dv.odb`) && 'AN_DATA not set';
const PIMMONS = 1;
const TAVERN = 58, NEWS = 51, POLICE = 54, LANDLORD = 18, BRANDY = 7;
const steps = (w: World, n: number) => { for (let i = 0; i < n; i++) w.step(); };

function mission(n: number) {
  const { world: w } = loadMission('Pimmons.mdb', n, DATA, false);
  const town = w.economy.towns.find(t => t.race === PIMMONS)!;
  const building = (type: number) => w.entities.find(e => e.kind === Kind.Building && e.town === town.id && (e.oid & 0xffff) === type)!;
  return { w, town, building };
}
const threshold = (t: Town, type: number) => t.needs.find(n => n.type === type)!.threshold;

/** a completed (not yet active) building of the town on a free spot near the town hall (footprint
 *  grown by one free; no research, slope or territory test: the economy does not care) */
function place(w: World, t: Town, type: number): Entity {
  const r = w.rules.get(((t.race << 16) | type) >>> 0)!;
  const sx = Math.max(1, r.sizeX), sy = Math.max(1, r.sizeY);
  const free = (x: number, y: number) => {
    for (let dy = -1; dy <= sy; dy++) for (let dx = -1; dx <= sx; dx++) if (w.occupied(x - sx + 1 + dx, y - sy + 1 + dy)) return false;
    return true;
  };
  for (let rad = 3; rad < 30; rad++)
    for (let dy = -rad; dy <= rad; dy++)
      for (let dx = -rad; dx <= rad; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== rad || !free(t.x + dx, t.y + dy)) continue;
        const b = w.spawn({ cls: 1, group: t.race, type, owner: t.mapId, x: t.x + dx, y: t.y + dy, z: 0 });
        b.town = t.id; b.complete = true; b.hp = r.hp;
        return b;
      }
  throw new Error('no free place');
}

/** number of rand() draws a call makes (the world's generator is a plain LCG) */
function draws(w: World, f: () => void): number {
  const probe = new MsRand(w.rand.state);
  f();
  for (let n = 0; n < 10000; n++) { if (probe.state === w.rand.state) return n; probe.next(); }
  throw new Error('generator diverged');
}

test('need buildings: completion does not close the need; the operator entering does (x 2.2, at once)', { skip }, () => {
  const { w, town: t } = mission(0);
  const eco = w.economy;
  const tavern = place(w, t, TAVERN);
  t.population = 16;
  eco.evaluateNeeds(t);
  assert.deepEqual(t.open, [TAVERN]);
  eco.completed(tavern);
  assert.equal(threshold(t, TAVERN), 15, 'an unstaffed tavern raises nothing');
  eco.evaluateNeeds(t);
  assert.deepEqual(t.open, [TAVERN], 'and the need stays open');
  w.logistics.activate(tavern);   // the landlord is inside
  assert.equal(threshold(t, TAVERN), 33);
  assert.deepEqual(t.open, [], 'closed at activation, without waiting for a re-evaluation');
  // the list stays sorted by threshold: tavern 33 now after news stand 25 and police 31
  assert.deepEqual(t.needs.map(n => n.type).slice(0, 3), [NEWS, POLICE, TAVERN]);
});

test('need buildings: the landlord leaving re-opens the need, his return closes it (Pimmons.mdb 4)', { skip }, () => {
  const { w, town: t, building } = mission(4);
  const tavern = building(TAVERN);
  assert.ok(tavern.active);
  assert.equal(t.population, 16);
  assert.equal(threshold(t, TAVERN), 33);
  const landlord = w.get(tavern.operatorId)!;
  assert.equal(landlord.oid & 0xffff, LANDLORD);
  w.schedule({ type: 'sendOut', player: PIMMONS, building: tavern.id, unit: LANDLORD });
  for (let i = 0; i < 60 && landlord.inside >= 0; i++) w.step();
  assert.equal(landlord.inside, -1);
  assert.equal(tavern.active, false);
  assert.equal(threshold(t, TAVERN), 15, 'reset to base x 2.2^(1 - 1)');
  assert.ok(t.open.includes(TAVERN), 're-evaluated at once: population 16 >= 15');
  steps(w, 50);
  assert.equal(t.happiness, 83, 'one open need');
  // back in: activation closes the need in that same tick
  w.schedule({ type: 'order', player: PIMMONS, ids: [landlord.id], target: tavern.id });
  let i = 0;
  for (; i < 400 && !tavern.active; i++) { w.step(); if (!tavern.active) assert.ok(t.open.includes(TAVERN)); }
  assert.ok(tavern.active, 'the landlord went back in');
  assert.equal(threshold(t, TAVERN), 33);
  assert.ok(!t.open.includes(TAVERN));
  steps(w, 50);
  assert.equal(t.happiness, 100);
});

test('need buildings: destruction resets the threshold from the remaining count and re-checks', { skip }, () => {
  const { w, town: t } = mission(0);
  const eco = w.economy;
  const a = place(w, t, TAVERN), b = place(w, t, TAVERN);
  w.logistics.activate(a); w.logistics.activate(b);
  assert.equal(threshold(t, TAVERN), 72, '15 -> 33 -> 72');
  t.population = 40;
  eco.evaluateNeeds(t);
  assert.ok(!t.open.includes(TAVERN));
  w.combat.collapse(a, true);
  assert.equal(threshold(t, TAVERN), 33, 'the collapsing tavern still counts: 15 x 2.2^(2 - 1)');
  assert.ok(t.open.includes(TAVERN), 'population 40 >= 33: re-opened by the re-evaluation');
  // the police station of mission 4: destroyed, its need (base 31) re-opens only at 31
  const m4 = mission(4);
  const police = m4.building(POLICE);
  assert.equal(threshold(m4.town, POLICE), 68);
  m4.w.combat.collapse(police, true);
  assert.equal(threshold(m4.town, POLICE), 31);
  assert.ok(!m4.town.open.includes(POLICE), 'population 16 < 31');
});

test('type change (training, jail release) re-evaluates the needs twice, the first time one lower', { skip }, () => {
  const { w, town: t } = mission(0);
  const eco = w.economy;
  t.population = 30;
  eco.evaluateNeeds(t);
  assert.deepEqual(t.open, [NEWS, TAVERN, 1000 + BRANDY]);
  t.stock[BRANDY] = 3;   // delivered: the luxury need stays open until the next re-evaluation
  steps(w, 1);
  assert.ok(t.open.includes(1000 + BRANDY));
  const porter = w.entities.find(e => e.kind === Kind.Unit && e.town === t.id && (e.oid & 0xffff) === T.Porter)!;
  // first evaluation at 29: tavern and news open (2 draws), brandy closed; second at 30: 2 draws
  const n = draws(w, () => eco.changeType(porter, ((PIMMONS << 16) | T.Builder) >>> 0));
  assert.equal(n, 4);
  assert.equal(porter.oid & 0xffff, T.Builder);
  assert.equal(t.population, 30);
  assert.deepEqual(t.open, [NEWS, TAVERN]);
});

test('needs check: one rand() per open need; the advisor line with its minimum interval', { skip }, () => {
  const { w, town: t } = mission(0);
  const eco = w.economy;
  t.population = 14;
  assert.equal(draws(w, () => eco.evaluateNeeds(t)), 0);
  t.population = 26;
  w.events.length = 0;
  assert.equal(draws(w, () => eco.evaluateNeeds(t)), 2, 'tavern and news stand');
  assert.deepEqual(w.events.map(e => e.mentor), [29, 32]);
  assert.ok(w.events.every(e => e.queue && e.race === PIMMONS));
  eco.evaluateNeeds(t);
  assert.equal(w.events.length, 2, 'said again within the interval: dropped');
  w.tick += 1530;   // > 152.8 s, the longest interval rand() mod 120000 + 120000 ms can give
  eco.evaluateNeeds(t);
  assert.deepEqual(w.events.map(e => e.mentor), [29, 32, 29, 32]);
  // a computer town draws the same numbers but has no advisor
  const ai = mission(4);
  const amazons = ai.w.economy.towns.find(x => x.race === 0)!;
  amazons.population = 20;
  ai.w.events.length = 0;
  assert.equal(draws(ai.w, () => ai.w.economy.evaluateNeeds(amazons)), 1);
  assert.equal(ai.w.events.length, 0);
});

test('house job: the filling birth returns 599, the job ends at its next run; a vacancy keeps the phase', { skip }, () => {
  const { w, town: t } = mission(0);
  const eco = w.economy;
  t.stock[4] = 25;
  const house = place(w, t, T.SmallHouse);
  house.occupancy = 2;
  eco.activate(house);
  const job = house.houseJob;
  assert.ok(job);
  const births: number[] = [];
  const run = (n: number) => { for (let i = 0; i < n; i++) { const o = house.occupancy; w.step(); if (house.occupancy > o) births.push(w.tick); } };
  run(600);
  assert.equal(births.length, 1);
  assert.equal(house.occupancy, 3);
  assert.equal(house.houseJob, job, 'still running after the birth that filled the house');
  assert.ok(w.sched.get(job));
  // a resident leaves within the 599 ticks: no new job, the old phase refills the place
  const newborn = w.entities.find(e => e.kind === Kind.Unit && e.home === house.id)!;
  eco.leaveHome(newborn);
  assert.equal(house.houseJob, job);
  run(599);
  assert.equal(births.length, 2);
  assert.equal(births[1] - births[0], 599);
  // full: the next run ends the job; a later vacancy creates a new job 599 ticks out
  run(599);
  assert.equal(house.houseJob, 0);
  const resident = w.entities.find(e => e.kind === Kind.Unit && e.home === house.id)!;
  eco.leaveHome(resident);
  assert.ok(house.houseJob !== 0);
  const left = w.tick;
  run(600);
  assert.equal(births.length, 3);
  assert.ok(births[2] - left === 599 || births[2] - left === 600, `${births[2] - left}`);
});

test('house completion: the chance roll only for a house that is not full after rehousing', { skip }, () => {
  const { w, town: t } = mission(0);
  const eco = w.economy;
  t.happiness = 50;   // h < 80: a roll draws one rand()
  // the builder and the two porters (living in the town hall) become homeless
  const three = w.entities.filter(e => e.kind === Kind.Unit && e.town === t.id && ((e.oid & 0xffff) === T.Porter || (e.oid & 0xffff) === T.Builder));
  assert.equal(three.length, 3);
  for (const u of three) if (u.home >= 0) eco.leaveHome(u);
  t.homeless = three.map(u => u.id);
  const full = place(w, t, T.SmallHouse);
  assert.equal(draws(w, () => eco.completed(full)), 0);
  assert.equal(full.occupancy, 3);
  const empty = place(w, t, T.SmallHouse);
  assert.equal(draws(w, () => eco.completed(empty)), 1);
  t.happiness = 80;
  const third = place(w, t, T.SmallHouse);
  assert.equal(draws(w, () => eco.completed(third)), 0, 'h >= 80: certain, no draw');
  assert.equal(third.occupancy, 1);
});

test('criminal births: the population before the birth divisible by 9 (h < 90) or 18 (h >= 90)', { skip }, () => {
  const { w, town: t } = mission(0);
  const eco = w.economy;
  const house = place(w, t, T.LargeHouse);
  const born = (pop: number, h: number) => {
    house.occupancy = 0;
    t.population = pop; t.happiness = h;
    return eco.birth(house, T.Porter, true)!.oid & 0xffff;
  };
  assert.equal(born(18, 100), T.Criminal, 'the 19th resident: always');
  assert.equal(born(18, 50), T.Criminal);
  assert.equal(born(9, 100), T.Porter, 'the 10th resident of a content town');
  assert.equal(born(9, 90), T.Porter);
  assert.equal(born(9, 89), T.Criminal, 'h < 90');
  assert.equal(born(27, 95), T.Porter);
  assert.equal(born(27, 70), T.Criminal);
  assert.equal(born(36, 100), T.Criminal);
  assert.equal(born(17, 50), T.Porter);
  assert.equal(born(0, 0), T.Porter, 'P = 0 never');
  // the stored happiness counts, not the current state: open needs lower it only at the next update
  t.population = 9; t.happiness = 100; t.open = [TAVERN, NEWS];
  house.occupancy = 0;
  assert.equal(eco.birth(house, T.Porter, true)!.oid & 0xffff, T.Porter);
  // a computer town: 36
  const m4 = mission(4);
  const sajiki = m4.w.economy.towns.find(x => x.race === 2)!;
  const hall = m4.w.get(sajiki.hall)!;
  const unit = (pop: number) => { hall.occupancy = 0; sajiki.population = pop; return m4.w.economy.birth(hall, T.Porter, true)!.oid & 0xffff; };
  assert.equal(unit(18), T.Porter);
  assert.equal(unit(36), T.Criminal);
});

test('happiness: computed only with an active town hall; one open need and food -> 83 (< 90)', { skip }, () => {
  const { w, town: t } = mission(0);
  const eco = w.economy;
  const hall = w.get(t.hall)!;
  t.open = [TAVERN];
  t.stock[4] = 20;
  hall.active = false;
  eco.updateHappiness(t);
  assert.equal(t.happiness, 100, 'complete but not active: no computation');
  hall.active = true;
  eco.updateHappiness(t);
  assert.equal(t.happiness, 83);
  assert.equal(t.needsPct, 50);
});

test('needs state: snapshot and restore continue identically; version-6 saves are migrated', { skip }, () => {
  const { w, town: t, building } = mission(4);
  const tavern = building(TAVERN);
  w.schedule({ type: 'sendOut', player: PIMMONS, building: tavern.id, unit: LANDLORD });
  steps(w, 100);
  assert.ok(t.open.includes(TAVERN));
  const snap = w.snapshot();
  const tr = w.terrain;
  const fresh = () => ({ ...tr, height: tr.height.slice(), cls: tr.cls.slice(), tile: tr.tile.slice() });
  const copy = World.restore(fresh(), JSON.parse(JSON.stringify(snap)), w.rules);
  assert.equal(copy.hash(), w.hash());
  steps(w, 1500); steps(copy, 1500);
  assert.equal(copy.hash(), w.hash());
  assert.deepEqual(copy.economy.towns[t.id].open, t.open);
  // a version-6 save: the old rule had raised the tavern's threshold at completion, unstaffed
  const old = JSON.parse(JSON.stringify(snap));
  old.v = 6;
  delete old.advisor;
  const ot = old.economy.towns[t.id];
  ot.needs.find((n: { type: number }) => n.type === TAVERN).threshold = 33;
  ot.open = ot.open.filter((o: number) => o !== TAVERN);
  const migrated = World.restore(fresh(), old, w.rules);
  const mt = migrated.economy.towns[t.id];
  assert.equal(mt.needs.find(n => n.type === TAVERN)!.threshold, 15, 'no active tavern');
  assert.equal(mt.needs.find(n => n.type === POLICE)!.threshold, 68, 'one active police station');
  migrated.step();
});

test('house job phase survives snapshot and restore', { skip }, () => {
  const { w, town: t } = mission(0);
  const house = place(w, t, T.SmallHouse);
  w.economy.activate(house);
  steps(w, 300);
  const copy = World.restore({ ...w.terrain, height: w.terrain.height.slice(), cls: w.terrain.cls.slice(), tile: w.terrain.tile.slice() }, JSON.parse(JSON.stringify(w.snapshot())), w.rules);
  steps(w, 1300); steps(copy, 1300);
  assert.equal(house.occupancy, 2);
  assert.equal(copy.get(house.id)!.occupancy, 2);
  assert.equal(copy.hash(), w.hash());
});

test('training goes through the type change (needs re-evaluated) (Pimmons.mdb 4)', { skip }, () => {
  const { w, town: t, building } = mission(4);
  const eco = w.economy;
  const school = building(55);
  assert.ok(school.active);
  const calls: number[] = [];
  const orig = eco.changeType.bind(eco);
  eco.changeType = (u, oid) => { calls.push(oid & 0xffff); orig(u, oid); };
  const evals = { n: 0 };
  const ev = eco.evaluateNeeds.bind(eco);
  eco.evaluateNeeds = (x: Town) => { if (x === t) evals.n++; ev(x); };
  const pop = t.population;
  w.schedule({ type: 'train', player: PIMMONS, building: school.id, unit: T.Builder });
  for (let i = 0; i < 3000 && !calls.length; i++) w.step();
  assert.deepEqual(calls, [T.Builder]);
  assert.equal(t.population, pop);
  assert.ok(evals.n >= 2);
});
