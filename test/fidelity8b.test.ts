// Fidelity batch 8b: towns, movement, economy and add-on leftovers. Map load (dvm.md "Creation
// order": house porters, occupancy reset), house occupancy without a lower limit (economy.md 3.2),
// the order of a destroyed town's units (combat.md 10.4 step 3), the founder's order on an own
// town-hall site (units-and-jobs.md 3.2), the free test's block counter (5.4), the go-to's walk
// planning 1 tick later (4.2), embassy lines at map load (ai-diplomacy-trade.md 3.3), storage of
// producing buildings (economy.md 2.x "Capacity"), goal 17 and dead objects (addon.md 9.2),
// SajikisAO 8's goal ids (formats addon.md 7.3), island ids after the map objects (addon.md 2.4).
// Needs AN_DATA (Pimmons.mdb 4) and, for the add-on part, AN_GOLD.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { loadMission, loadAddonMission, DATA, HAS_GOLD } from './helpers/mission.ts';
import { World, Kind, SUB, type Entity } from '../src/engine/world.ts';
import { T } from '../src/engine/economy.ts';
import { Logistics, LJ } from '../src/engine/logistics.ts';
import { labelIslands, type AddonTerrain } from '../src/world/addon-terrain.ts';

const skip = !existsSync(`${DATA}/dv.odb`) && 'AN_DATA not set';
const skipGold = !HAS_GOLD && 'AN_GOLD not set';
const PIMMONS = 1;
const cell = (e: Entity): [number, number] => [Math.floor(e.x / SUB), Math.floor(e.y / SUB)];
const isHouse = (e: Entity) => e.kind === Kind.Building && ((e.oid & 0xffff) === T.SmallHouse || (e.oid & 0xffff) === T.LargeHouse);
const residents = (w: World, b: Entity) => w.entities.filter(u => u.kind === Kind.Unit && u.home === b.id);
const mission = () => loadMission('Pimmons.mdb', 4, DATA, false).world;

function freeNear(w: World, b: Entity, from = 3): [number, number] {
  const [ex, ey] = w.logistics.entrance(b);
  for (let r = from; r < 20; r++)
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r || w.occupied(ex + dx, ey + dy)) continue;
        const m = w.size - 1, x = (ex + dx) & m, y = (ey + dy) & m;
        if (w.entities.some(e => e.kind === Kind.Unit && e.inside < 0 && cell(e)[0] === x && cell(e)[1] === y)) continue;
        return [x, y];
      }
  throw new Error('no free cell');
}
function unitNear(w: World, race: number, b: Entity, type: number, townId = b.town): Entity {
  const [x, y] = freeNear(w, b);
  const u = w.spawnUnit(race, type, x, y, townId);
  w.economy.joinTown(u, w.economy.town(townId)!);
  return u;
}

// ---------------------------------------------------------------- map load

test('map load: every map house gets its porter, then its occupancy is reset, so it holds up to capacity + 1', { skip }, () => {
  const w = mission();
  const houses = w.entities.filter(isHouse);
  assert.ok(houses.length > 0);
  let over = 0;
  for (const h of houses) {
    const cap = w.rules.get(h.oid)!.residents;
    const n = residents(w, h).length;
    // the porter of the completion step is not counted in the occupancy
    assert.equal(n, h.occupancy + 1, `house ${h.id}: residents = occupancy + its porter`);
    assert.ok(h.occupancy <= cap);
    if (n > cap) over++;
  }
  assert.ok(over > 0, 'some map houses hold capacity + 1 residents');
});

test('a resident leaving lowers the occupancy without a lower limit (00461690)', { skip }, () => {
  const w = mission();
  const h = w.entities.find(e => isHouse(e) && e.occupancy === 0 && residents(w, e).length === 1);
  if (!h) throw new Error('a map house with only its uncounted porter');
  const porter = residents(w, h)[0];
  w.economy.leaveTown(porter);
  assert.equal(h.occupancy, -1);
});

test('embassies of the map: the human hears the computer embassy lines at tick 0', { skip }, () => {
  const w = mission();
  assert.equal(w.tick, 0);
  assert.ok(w.events.some(e => e.race === PIMMONS && e.mentor === 68 && e.tick === 0), 'mentor#68 (Amazons) to the Pimmons');
});

// ---------------------------------------------------------------- town destruction order

test('town destruction: units by the race\'s unit record order (33 before 32), then creation order', { skip }, () => {
  const w = mission();
  const t1 = w.economy.towns.find(o => o.race === PIMMONS && o.alive)!;
  const hall1 = w.get(t1.hall)!;
  const [hx, hy] = freeNear(w, hall1);
  const hall2 = w.spawn({ cls: 1, group: PIMMONS, type: T.TownHall, owner: -1, x: (hx + 30) & (w.size - 1), y: hy, z: 0 });
  const t2 = w.economy.foundTown(PIMMONS, 99, hall2);
  // created in this order: 32, 9, 33, 9
  const types = [32, T.Porter, 33, T.Porter];
  const units = types.map(ty => unitNear(w, PIMMONS, hall1, ty, t2.id));
  for (const h of w.entities.filter(e => isHouse(e) && e.town === t1.id)) h.occupancy = w.rules.get(h.oid)!.residents;
  t1.homeless = [];
  w.combat.destroyTown(t2);
  assert.deepEqual(t1.homeless, [units[1].id, units[3].id, units[2].id, units[0].id], 'porters (9), then 33, then 32');
});

// ---------------------------------------------------------------- founder order

test('founder right-clicking an own town-hall site gets a found-town job toward it', { skip }, () => {
  const w = mission();
  const t1 = w.economy.towns.find(o => o.race === PIMMONS && o.alive)!;
  const hall1 = w.get(t1.hall)!;
  const a = unitNear(w, PIMMONS, hall1, T.Founder);
  const b = unitNear(w, PIMMONS, hall1, T.Founder);
  // a site for founder a, far enough away
  let site: Entity | undefined;
  const [fx, fy] = freeNear(w, hall1, 14);
  for (let k = 0; k < 40 && !site; k++) {
    if (w.logistics.found(a, fx + 30 + k, fy)) site = w.entities.find(e => e.kind === Kind.Building && (e.oid & 0xffff) === T.TownHall && !e.complete && e.alive);
  }
  if (!site) throw new Error('no town-hall site');
  w.schedule({ type: 'order', player: PIMMONS, ids: [b.id], target: site.id });
  w.step();
  const j = w.sched.get(b.job)!;
  assert.equal(j.kind, LJ.Found);
  assert.equal(j.data[1], site.id);
  assert.ok(b.ordered);
  assert.ok(site.alive, 'b had no found-town job: nothing destroyed');
});

// ---------------------------------------------------------------- free test (5.4)

test('free test: a leisure visitor inside is free when his current job is blocked, not when it runs', { skip }, () => {
  const w = mission();
  const t1 = w.economy.towns.find(o => o.race === PIMMONS && o.alive)!;
  const hall = w.get(t1.hall)!;
  const u = unitNear(w, PIMMONS, hall, T.Porter);
  const look = w.logistics.jobOf;
  u.idle = -1; u.inside = hall.id;
  const j = w.sched.create(LJ.Leave, u.id, 10, []);
  u.job = j.id;
  assert.equal(Logistics.free(u, 0, look), false, 'unblocked job inside: not free');
  j.hold = 5;
  assert.equal(Logistics.free(u, 0, look), true, 'blocked job inside: free');
  assert.equal(w.ai.free(u, 0), true, 'the computer players use the same test');
  u.idle = 0;
  assert.equal(Logistics.free(u, 0, look), false, 'not on a visit');
});

// ---------------------------------------------------------------- go-to timing (4.2)

test('go-to: the walk plans in its first run 1 tick later; standing on the goal ends it at that run', { skip }, () => {
  const w = mission();
  const t1 = w.economy.towns.find(o => o.race === PIMMONS && o.alive)!;
  const hall = w.get(t1.hall)!;
  const u = unitNear(w, PIMMONS, hall, T.Porter);
  w.logistics.walkTo(u, hall);
  assert.equal(u.plans, 0, 'no plan in the go-to\'s own run');
  assert.ok(u.path, 'the walk is running');
  w.step();
  assert.equal(u.plans, 1, 'planned in the walk\'s first run');
  // a unit on its goal cell: a delayed walk ends at its first run, not at once
  const v = unitNear(w, PIMMONS, hall, T.Porter);
  const [x, y] = cell(v);
  w.follow(v, x, y, 0, 1);
  assert.ok(v.path, 'still running until its first run');
  w.step();
  assert.equal(v.path, null);
  assert.ok(w.walkOk(v));
});

// ---------------------------------------------------------------- storage of producing buildings

test('activation: a store-flagged building that produces something adds no storage (E19)', { skip }, () => {
  const w = mission();
  const t1 = w.economy.towns.find(o => o.race === PIMMONS && o.alive)!;
  const hall = w.get(t1.hall)!;
  const oid = ((PIMMONS << 16) | T.Warehouse) >>> 0;
  const r = w.rules.get(oid)!;
  const [x, y] = freeNear(w, hall, 8);
  const wh = w.spawn({ cls: 1, group: PIMMONS, type: T.Warehouse, owner: -1, x, y, z: 0 });
  wh.town = t1.id; wh.complete = true;
  const before = t1.capacity;
  w.rules.set(oid, { ...r, product: 3 });
  try { w.economy.activate(wh); } finally { w.rules.set(oid, r); }
  assert.equal(t1.capacity, before, 'no storage from a producing building');
});

// ---------------------------------------------------------------- add-on

test('SajikisAO 8: the lose goals point at the outpost and houses (house porters counted); the warships are 17 later', { skip: skipGold }, () => {
  const { world: w, mission: m } = loadAddonMission('SajikisAO.mdb', 8, undefined, false);
  const obj = (id: number) => w.get(id + 1)!;   // object #id = entity id + 1
  const ids = m.goals.filter(g => g.type === 17).map(g => g.p1);
  assert.deepEqual(ids, [3563, 3564, 3565, 3566, 3567, 3568, 3569, 3570, 3571]);
  assert.equal(obj(3563).oid & 0xffff, 53, 'an outpost');
  assert.equal(obj(3567).oid & 0xffff, T.SmallHouse);
  assert.equal(obj(3568).oid & 0xffff, T.Porter, 'its porter, created at load');
  for (let id = 3580; id <= 3588; id++) assert.ok([65, 66].includes(obj(id).oid & 0xffff), `#${id} a warship`);
  const p = w.economy.players[2]!;
  for (const g of m.goals.filter(g => g.type === 17)) assert.equal(w.economy.goalMet(p, g), false);
});

test('goal 17: a dead object still counts while it is in the world', { skip: skipGold }, () => {
  const { world: w } = loadAddonMission('SajikisAO.mdb', 8, undefined, false);
  const e = w.get(3564 + 1)!;   // an archer
  const [x, y] = cell(e);
  const g = { type: 17, defeat: false, p1: 3564, p2: (x << 16) | y, p3: 0 };
  const p = w.economy.players[0]!;
  assert.equal(w.economy.goalMet(p, g), true);
  e.alive = false;
  assert.equal(w.economy.goalMet(p, g), true, 'dead but not yet removed');
});

test('island ids are labelled after the map objects; the cells that differ are saved (snapshot 23)', { skip: skipGold }, () => {
  const { world: w } = loadAddonMission('SajikisAO.mdb', 2, undefined, false);
  const t = w.terrain as AddonTerrain;
  const copy = { ...t, island: new Uint8Array(t.island.length) } as AddonTerrain;
  labelIslands(copy);
  assert.deepEqual(copy.island, w.island, 'the labels match the heights after the foundations');
  // an edited label survives a save
  const edits = (w as unknown as { islandEdits: [number, number][] }).islandEdits;
  const i = w.island!.findIndex(v => v !== 0);
  edits.push([i, 77]); w.island![i] = 77;
  const snap = JSON.parse(JSON.stringify(w.snapshot()));
  assert.ok(snap.v >= 23);
  const fresh = loadAddonMission('SajikisAO.mdb', 2, undefined, false).terrain;
  const r = World.restore(fresh, snap, w.rules, w.weapons);
  assert.equal(r.island![i], 77);
  assert.equal(r.hash(), w.hash());
  // a version-22 save keeps the bare labels
  delete snap.islandEdits; snap.v = 22;
  const old = World.restore(loadAddonMission('SajikisAO.mdb', 2, undefined, false).terrain, snap, w.rules, w.weapons);
  assert.ok(old.island![i] !== 77);
});
