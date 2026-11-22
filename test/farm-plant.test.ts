// Farms and farmers: the operator run draws the crop type, the plant job draws the cell in its first
// run outside and area-searches around it (mask 0x17F); with no cell the farmer walks straight back;
// the crop appears on the recorded cell once he is off it. Spec: docs/game/units-and-jobs.md 7.6,
// docs/formats/world-populate.md 2.3. Needs AN_DATA (Pimmons.mdb 2: an active, staffed farm).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { loadMission, DATA } from './helpers/mission.ts';
import { World, Kind, SUB, type Entity } from '../src/engine/world.ts';
import { LJ } from '../src/engine/logistics.ts';
import { MsRand } from '../src/world/rand.ts';
import type { Job } from '../src/engine/scheduler.ts';

const skip = !existsSync(`${DATA}/dv.odb`) && 'AN_DATA not set';
const FARM = 45;
const cellOf = (e: Entity): [number, number] => [Math.floor(e.x / SUB), Math.floor(e.y / SUB)];
type Private = { runOperator(j: Job): number; runPlant(j: Job): number };
const priv = (w: World) => w.logistics as unknown as Private;

function farmWorld() {
  const { world: w } = loadMission('Pimmons.mdb', 2, DATA, false);
  const farm = w.entities.find(e => e.kind === Kind.Building && (e.oid & 0xffff) === FARM && e.active)!;
  assert.ok(farm, 'an active farm');
  const farmer = w.get(farm.operatorId)!;
  assert.equal(farmer.inside, farm.id);
  const base = w.rules.get(farmer.oid)!.product;
  return { w, farm, farmer, base };
}
const isCrop = (e: Entity, base: number) => e.kind === Kind.Nature && (e.oid & 0xffff) >= base && (e.oid & 0xffff) <= base + 3;
function clearCrops(w: World, base: number): void {
  for (const e of [...w.entities]) if (isCrop(e, base)) w.removeEntity(e);
}
/** run the farm's operator job now (the scheduled copy is cancelled first) */
function operatorNow(w: World, farm: Entity): number {
  const j = w.sched.get(farm.opJob)!;
  assert.equal(j.kind, LJ.Operator);
  w.sched.cancel(j.id);
  return priv(w).runOperator(j);
}
const plantJob = (w: World, u: Entity) => [u.job, ...u.suspended].map(id => w.sched.get(id)).find(j => j?.kind === LJ.Plant);

/** the area search of world-populate.md 2.3 for 1x1, radius 2: the cell, ring 1 from (x+1, y-1), the corner of ring 2 */
function* areaOrder(x: number, y: number): Generator<[number, number]> {
  yield [x, y];
  for (let dy = -1; dy < 1; dy++) yield [x + 1, y + dy];
  for (let dx = 1; dx > -1; dx--) yield [x + dx, y + 1];
  for (let dy = 1; dy > -1; dy--) yield [x - 1, y + dy];
  for (let dx = -1; dx < 2; dx++) yield [x + dx, y - 1];
  yield [x + 2, y - 2];
}
/** mask 0x17F from the spec: path flag, unit, building, nature, water, slope (8 neighbours > 64), mountain */
function fits(w: World, x: number, y: number): boolean {
  const m = w.size - 1, at = (a: number, b: number) => ((b & m) << w.bits) | (a & m), i = at(x, y);
  if (w.blocked[i] || w.pathFlag[i] || w.motion.unitOn(i) || w.terrain.height[i] > w.mountain) return false;
  let lo = Infinity, hi = -Infinity;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy) { const h = w.terrain.height[at(x + dx, y + dy)]; lo = Math.min(lo, h); hi = Math.max(hi, h); }
  return hi - lo <= 64;
}

test('farm operator: one draw (the crop type), the plant job waits behind the leave job with no cell yet', { skip }, () => {
  const { w, farm, farmer, base } = farmWorld();
  clearCrops(w, base);
  const s0 = w.rand.state;
  assert.equal(operatorNow(w, farm), 0, 'the operator job ends');
  const p = new MsRand(s0), r = p.next();
  assert.equal(w.rand.state, p.state, 'exactly one rand() in the operator run');
  const j = plantJob(w, farmer)!;
  assert.ok(j, 'a plant job');
  assert.deepEqual(j.data, [0, farm.id, -1, -1, base + (r % 4), 0]);
  assert.ok(w.logistics.leaving(farmer), 'the farmer is on his way out');
  assert.equal(farm.active, true, 'the farm stays active');
});

test('farm operator: crops count on the disc dx² + dy² < 36 (not max + min/2 <= 6)', { skip }, () => {
  const { w, farm, farmer, base } = farmWorld();
  clearCrops(w, base);
  const [fx, fy] = cellOf(farm);
  // ten crops at distance max + min/2 <= 6 but dx² + dy² >= 36: they do not count
  const ring: [number, number][] = [[6, 0], [-6, 0], [0, 6], [0, -6], [6, 1], [-6, 1], [1, 6], [1, -6], [6, -1], [-6, -1], [-1, 6], [-1, -6]];
  let placed = 0;
  for (const [dx, dy] of ring) {
    if (placed === 10 || w.occupied(fx + dx, fy + dy) || w.motion.unitOn(((fy + dy) & (w.size - 1)) * w.size + ((fx + dx) & (w.size - 1)))) continue;
    w.spawn({ cls: 2, group: 6, type: base, owner: -1, x: fx + dx, y: fy + dy, z: 0 });
    placed++;
  }
  assert.equal(placed, 10);
  operatorNow(w, farm);
  assert.ok(plantJob(w, farmer), 'the farmer is sent out: none of them counts');
});

test('plant job, first run outside: coin and offset for x, then for y; area search radius 2; walks to the found cell', { skip }, () => {
  const { w, farm, farmer, base } = farmWorld();
  clearCrops(w, base);
  operatorNow(w, farm);
  const j = plantJob(w, farmer)!;
  for (let i = 0; i < 100 && (farmer.inside >= 0 || farmer.job !== j.id); i++) w.step();
  assert.ok(farmer.inside < 0 && farmer.job === j.id && j.data[0] === 0, 'outside, plant job current, not run yet');
  const s0 = w.rand.state;
  priv(w).runPlant(j);
  const p = new MsRand(s0), m = w.size - 1;
  const [fx, fy] = cellOf(farm);
  const pick = (c: number) => (p.next() % 2 === 0 ? c + (p.next() % 3) : c - (p.next() % 3) - 2);
  const x = pick(fx) & m, y = pick(fy) & m;
  assert.equal(w.rand.state, p.state, 'four draws');
  let want: [number, number] | null = null;
  for (const [cx, cy] of areaOrder(x, y)) if (fits(w, cx, cy)) { want = [cx & m, cy & m]; break; }
  assert.ok(want, 'this map has a free cell there');
  assert.equal(j.data[0], 1);
  assert.deepEqual([farmer.goalX, farmer.goalY], want);
});

test('plant job: no cell fits -> the farmer walks straight back in, no crop; the operator job restarts', { skip }, () => {
  const { w, farm, farmer, base } = farmWorld();
  clearCrops(w, base);
  const [fx, fy] = cellOf(farm);
  // every cell around the farm carries the path flag (0x01)
  for (let dy = -12; dy <= 12; dy++) for (let dx = -12; dx <= 12; dx++) w.pathFlag[((fy + dy) & (w.size - 1)) * w.size + ((fx + dx) & (w.size - 1))] = 1;
  operatorNow(w, farm);
  const j = plantJob(w, farmer)!;
  for (let i = 0; i < 200 && j.data[0] === 0; i++) w.step();
  assert.equal(farmer.inside, -1, 'he came out');
  assert.equal(j.data[0] >= 2, true, 'straight to the walk back');
  assert.equal(j.data[5], 1, 'planted flag set: no crop');
  for (let i = 0; i < 400 && farmer.inside !== farm.id; i++) w.step();
  assert.equal(farmer.inside, farm.id, 'back inside');
  assert.equal(w.entities.filter(e => isCrop(e, base)).length, 0, 'no crop');
  assert.ok(farm.opJob && w.sched.get(farm.opJob)?.kind === LJ.Operator, 'the operator job runs again');
});

test('plant job: the crop appears on the recorded cell in the first run after the farmer is off it, on the walk back', { skip }, () => {
  const { w, farm, farmer, base } = farmWorld();
  clearCrops(w, base);
  operatorNow(w, farm);
  const j = plantJob(w, farmer)!;
  let made: Entity | undefined;
  let prev = { phase: -1, cell: [-1, -1] as [number, number] };
  for (let i = 0; i < 2000 && !made; i++) {
    prev = { phase: j.data[0], cell: cellOf(farmer) };
    w.step();
    made = w.entities.find(e => isCrop(e, base));
  }
  assert.ok(made, 'a crop was planted');
  assert.equal(prev.phase, 3, 'during the walk back');
  assert.deepEqual(cellOf(made!), [j.data[2], j.data[3]], 'on the recorded cell');
  const [ux, uy] = cellOf(farmer);
  assert.ok(ux !== j.data[2] || uy !== j.data[3], 'the farmer is off it');
  assert.equal(made!.amount, 0);
  assert.ok(made!.growJob, 'it grows');
  assert.equal(j.data[5], 1);
  assert.equal(made!.oid & 0xffff, j.data[4], 'of the type drawn by the operator');
});

test('old saves (before version 16): a running plant job is mapped onto the new phases', { skip }, () => {
  const { w, farm, farmer, base } = farmWorld();
  clearCrops(w, base);
  operatorNow(w, farm);
  const j = plantJob(w, farmer)!;
  const snap = w.snapshot();
  snap.v = 15;
  const old = snap.sched.slots.flat().find(x => x.id === j.id)!;
  old.data = [2, farm.id, 7, 9, base + 1];   // old layout: working at (7, 9), the crop not made yet
  const tr = w.terrain;
  const r = World.restore({ ...tr, height: tr.height.slice(), cls: tr.cls.slice(), tile: tr.tile.slice() }, snap, w.rules, w.weapons);
  const [x, y] = cellOf(r.get(farmer.id)!);
  assert.deepEqual(r.sched.get(j.id)!.data, [2, farm.id, x, y, base + 1, 0], 'walk back next; the crop comes when he steps off');
});
