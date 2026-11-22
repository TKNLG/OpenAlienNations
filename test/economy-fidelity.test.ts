// Economy fidelity details (audit batch 4): sapling growth steps per tree type, the construction
// stage starting at 0, the training job's first run, production inputs ordered without counting
// goods on the way, tax income without clamp, the first bank / laboratory / library only, the town
// net truncated once, the happiness bonus flag cleared for every town.
// Spec: docs/game/units-and-jobs.md 6.3, 7.5, 8.2, 9; docs/game/economy.md 4.2, 4.4, 4.6, 5.5.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { loadMission, DATA } from './helpers/mission.ts';
import { World, Kind, SUB, type Entity } from '../src/engine/world.ts';
import { LJ, treeGrowthSteps } from '../src/engine/logistics.ts';
import { T, type Town } from '../src/engine/economy.ts';
import type { ObjectRule } from '../src/formats/odb.ts';
import type { Terrain } from '../src/world/terrain.ts';

const skip = !existsSync(`${DATA}/dv.odb`) && 'AN_DATA not set';
const f32 = Math.fround;

test('sapling growth: F steps of 599 ticks, F = frame count of the type\'s ST0 sprite (3, 6, 5, 6; palms 4)', {}, () => {
  assert.deepEqual([9, 10, 11, 12, 46, 47, 48, 49].map(treeGrowthSteps), [3, 6, 5, 6, 4, 4, 4, 4]);
  const N = 32;
  const terrain: Terrain = { sizeBits: 5, size: N, height: new Uint16Array(N * N).fill(128), cls: new Uint8Array(N * N).fill(1), tile: new Uint8Array(N * N) };
  const rules = new Map<number, ObjectRule>();
  for (const type of [9, 10, 11, 12]) {
    const id = (6 << 16) | type;
    rules.set(id, { id, group: 6, kind: 2, type, cls: 8, stepTime: [0, 0, 0, 0], hp: 10, amount: 6, product: 1, sizeX: 1, sizeY: 1 } as ObjectRule);
  }
  const w = new World(terrain, [], rules);
  const trees = [9, 10, 11, 12].map((type, k) => {
    const e = w.spawn({ cls: 2, group: 6, type, owner: -1, x: 4 + 4 * k, y: 8, z: 0 });
    e.amount = 0; e.standing = false; e.stage = 0;
    e.growJob = w.sched.create(LJ.Growth, e.id, 599, [0]).id;
    return e;
  });
  const t0 = w.tick;
  const full = new Map<Entity, number>(), stages = new Map<Entity, number[]>();
  for (let i = 0; i < 6 * 599 + 10; i++) {
    w.step();
    for (const e of trees) {
      if (!full.has(e) && e.standing) full.set(e, w.tick - t0);
      if (!full.has(e)) { const s = stages.get(e) ?? []; if (s[s.length - 1] !== e.stage) s.push(e.stage); stages.set(e, s); }
    }
  }
  const at = trees.map(e => full.get(e)!);
  // full after F x 599 ticks (relative to each other: the scheduler offset is the same for all)
  assert.deepEqual(at.map(a => a - at[0]), [0, 3 * 599, 2 * 599, 3 * 599]);
  for (const e of trees) {
    assert.equal(e.amount, e.full, 'full amount');
    assert.equal(e.growJob, 0);
    // stage shows frames 0, 1 .. F-1 as percentages of F
    const F = treeGrowthSteps(e.oid & 0xffff);
    assert.deepEqual(stages.get(e), Array.from({ length: F }, (_, c) => Math.trunc((c * 100) / F)));
  }
});

/** Pimmons mission 0 without computer players: a site of `type` placed near the town hall (its invention granted) */
function site(type: number) {
  const { world: w, mission: m } = loadMission('Pimmons.mdb', 0, DATA, false);
  const me = m.humanRace, t = w.economy.towns.find(x => x.race === me)!;
  const r = w.rules.get((me << 16) | type)!;
  const p = w.economy.players[me]!;
  if (r.invention >= 0) p.progress[r.invention] = p.costs[r.invention];
  let spot: [number, number] | null = null;
  for (let rad = 5; rad < 25 && !spot; rad++)
    for (let dy = -rad; dy <= rad && !spot; dy++)
      for (let dx = -rad; dx <= rad && !spot; dx++)
        if (Math.max(Math.abs(dx), Math.abs(dy)) === rad && w.logistics.canPlace(t, r, t.x + dx, t.y + dy)) spot = [t.x + dx, t.y + dy];
  assert.ok(spot, 'a place for the site');
  w.schedule({ type: 'build', player: me, town: t.id, building: type, x: spot![0], y: spot![1] });
  w.step();
  const b = w.entities.find(e => (e.oid & 0xffff) === type && e.owner === me && !e.complete)!;
  assert.ok(b);
  return { w, me, t, r, b };
}

test('construction: the stage starts at 0, so a site with T > 10 gets 9 HP/frame steps, then completion adds d', { skip }, () => {
  const WAREHOUSE = 41;
  const { w, r, b } = site(WAREHOUSE);
  assert.equal(b.order!.T, 12);
  for (let g = 0; g < b.local.length; g++) b.local[g] = 0;
  b.local[1] = 4; b.local[2] = 8;
  b.needed = [];
  for (const t of w.economy.towns) t.lists = t.lists.map(l => l.filter(x => x !== b.id));
  const start = b.hp;
  const d = Math.trunc((r.hp - start) / 9);
  let steps = 0, last = b.hp, firstWorkCounted: boolean | null = null, lastCounter = -1;
  for (let i = 0; i < 6000 && !b.complete; i++) {
    w.step();
    const o = b.order;
    if (o && o.started && o.counter !== lastCounter) {
      if (lastCounter >= 0 && firstWorkCounted === null) firstWorkCounted = b.hp !== start;
      lastCounter = o.counter;
    }
    if (!b.complete && b.hp > last) steps++;
    last = b.hp;
  }
  assert.ok(b.complete, 'finished');
  assert.equal(firstWorkCounted, false, 'the first work tick (stage 0) does not count');
  assert.equal(steps, 9, '9 counted work ticks');
  assert.equal(b.buildFrame, 9);
  assert.equal(b.hp, Math.min(r.hp, start + 10 * d));
});

test('training: the first order of an idle building runs the training job 1 tick later', { skip }, () => {
  const { world: w, mission: m } = loadMission('Pimmons.mdb', 4, DATA, false);
  const me = m.humanRace, SCHOOL = 55, STONEMASON = 27;
  const school = w.entities.find(e => e.kind === Kind.Building && e.owner === me && (e.oid & 0xffff) === SCHOOL && e.complete)!;
  const t = w.economy.town(school.town)!;
  w.economy.players[me]!.money += 1000;
  for (let i = 0; i < 60; i++) w.step();
  // a pupil inside and the goods at hand
  const [ex, ey] = w.logistics.entrance(school);
  const spot = w.freeSpiral(ex + 3, ey + 3, 10)!;
  const u = w.spawnUnit(me, T.Porter, spot[0], spot[1], t.id);
  w.economy.joinTown(u, t);
  w.schedule({ type: 'order', player: me, ids: [u.id], target: school.id });
  for (let i = 0; i < 600 && u.inside !== school.id; i++) w.step();
  assert.equal(u.inside, school.id);
  for (let g = 0; g < school.local.length; g++) school.local[g] = 20;
  for (let g = 0; g < t.stock.length; g++) t.stock[g] = Math.max(t.stock[g], 20);
  assert.equal(school.trainJob && w.sched.get(school.trainJob) ? 1 : 0, 0, 'no training job yet');
  // the order command runs in the step of tick T; the training job's first run is in tick T + 1
  w.schedule({ type: 'train', player: me, building: school.id, unit: STONEMASON });
  w.step();
  assert.deepEqual(school.queue, [STONEMASON], 'ordered');
  assert.equal(school.trainStarted, 0);
  w.step();
  assert.equal(school.trainStarted, 1, 'started one tick after the order');
});

test('production inputs: need minus local stock, goods already requested are not subtracted (over-ordering)', { skip }, () => {
  const { world: w, mission: m } = loadMission('Pimmons.mdb', 0, DATA, false);
  const me = m.humanRace, t = w.economy.towns.find(x => x.race === me)!;
  const b = w.get(t.hall)!;
  const order = (w.logistics as unknown as { orderInputs(b: Entity, t: Town, product: number): void }).orderInputs.bind(w.logistics);
  b.needed = [];
  for (let g = 0; g < b.local.length; g++) b.local[g] = 0;
  const IRON = 3, WOOD = 1;   // iron: 2 wood per unit
  order(b, t, IRON);
  assert.equal(b.needed.filter(g => g === WOOD).length, 2);
  order(b, t, IRON);
  assert.equal(b.needed.filter(g => g === WOOD).length, 4, 'two more although two are on the way');
  b.local[WOOD] = 1;
  order(b, t, IRON);
  assert.equal(b.needed.filter(g => g === WOOD).length, 5, 'need 2 minus the 1 in stock');
});

test('tax income is not clamped; the net is truncated once; spendings stay 0 without income', { skip }, () => {
  const { world: w, mission: m } = loadMission('Pimmons.mdb', 0, DATA, false);
  const me = m.humanRace, t = w.economy.towns.find(x => x.race === me)!;
  const eco = w.economy as unknown as { townIncome(t: Town): number; townNet(t: Town, money: number): number };
  const pop = t.population;
  t.homeless = Array.from({ length: pop + 2 }, (_, i) => 100000 + i);
  assert.equal(eco.townIncome(t), -14, 'two more homeless than residents: 7 x -2');
  t.motivationPct = 50; t.researchPct = 50; t.researchAcc = 0;
  const ov = t.overheads;
  assert.equal(eco.townNet(t, 1000), -14 - ov);
  assert.equal(t.motivationSpent, 0);
  assert.equal(t.researchSpent, 0);
  // one truncation in double precision: float32 rounding would give 99999
  t.homeless = [];
  t.population = 14286; t.overheads = 0; t.motivationPct = 0;
  t.researchAcc = f32(0.7500000596046448);
  assert.equal(eco.townIncome(t), 100002);
  assert.equal(eco.townNet(t, 0), 99998);
  t.population = pop; t.overheads = ov;
});

test('happiness: the bonus flag is cleared for every town, also those the formula skips', { skip }, () => {
  const { world: w } = loadMission('Pimmons.mdb', 0, DATA, false);
  // a town that skips the formula (here: no population; computer towns likewise) loses a stale flag
  const t = w.economy.towns.find(x => !w.economy.players[x.race]?.computer)!;
  const pop = t.population;
  t.population = 0; t.bonus = 1;
  w.economy.updateHappiness(t);
  assert.equal(t.bonus, 0);
  t.population = pop;
});

test('bank, laboratory, library: only the first building of the type in the town counts', { skip }, () => {
  const { world: w, mission: m } = loadMission('Pimmons.mdb', 0, DATA, false);
  const me = m.humanRace, t = w.economy.towns.find(x => x.race === me)!;
  const hall = w.get(t.hall)!;
  const [hx, hy] = [Math.floor(hall.x / SUB), Math.floor(hall.y / SUB)];
  const mk = (dx: number, active: boolean) => {
    const e = w.spawn({ cls: 1, group: me, type: T.Bank, owner: me, x: hx + dx, y: hy + 12, z: 0 });
    e.town = t.id; e.complete = true; e.active = active;
    return e;
  };
  assert.equal(w.economy.firstActive(t, T.Bank), false);
  mk(0, false);
  mk(4, true);
  assert.equal(w.economy.firstActive(t, T.Bank), false, 'the second, active bank does not count');
});
