// Game flow, towns and orders (fidelity batch 2): what "dead" means and when the result comes
// (docs/formats/mdb.md "Goals", docs/game/combat.md 10.4), the network-game win, city lookups of
// the goals, rehousing at town destruction, the rename command (units-and-jobs.md 11.2), repeated
// orders (3.2), store choice (4.3), the demolish test (11.6) and the research toggle
// (economy.md 4.4.1). Needs AN_DATA (Pimmons.mdb 4: human Pimmons, computer Amazons and Sajiki).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { loadMission, setupOf, DATA } from './helpers/mission.ts';
import { parseMdb, parseDvm } from '../src/formats/mission.ts';
import { parseOs } from '../src/formats/os.ts';
import { parseOdb } from '../src/formats/odb.ts';
import { generateTerrain, CLASS_TILESET } from '../src/world/terrain.ts';
import { World, Kind, SUB, type Entity } from '../src/engine/world.ts';
import { T, JobKind } from '../src/engine/economy.ts';

const skip = !existsSync(`${DATA}/dv.odb`) && 'AN_DATA not set';
const PIMMONS = 1;
const steps = (w: World, n: number) => { for (let i = 0; i < n; i++) w.step(); };
const cell = (e: Entity): [number, number] => [Math.floor(e.x / SUB), Math.floor(e.y / SUB)];
/** a save round trip on a copy of the terrain */
const roundTrip = (w: World) => {
  const tr = w.terrain;
  return World.restore({ ...tr, height: tr.height.slice(), cls: tr.cls.slice(), tile: tr.tile.slice() }, w.snapshot(), w.rules, w.weapons);
};

function mission(network = false) {
  if (!network) return loadMission('Pimmons.mdb', 4, DATA, false).world;
  const m = parseMdb(readFileSync(`${DATA}/Pimmons.mdb`)).find(x => x.order === 4)!;
  const pick = CLASS_TILESET.map(name => parseOs(readFileSync(`${DATA}/${name}.os`)).pick);
  const objects = parseDvm(readFileSync(`${DATA}/${m.mapFile.replace(/\\/g, '/')}`));
  const rules = parseOdb(readFileSync(`${DATA}/dv.odb`));
  return new World(generateTerrain(m.seed, m.sizeBits, pick), objects, rules, { ...setupOf(m), ai: false, network: true });
}

/** a free cell near a building's entrance with no unit on it */
function freeNear(w: World, b: Entity): [number, number] {
  const [ex, ey] = w.logistics.entrance(b);
  for (let r = 3; r < 14; r++)
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

// ---------------------------------------------------------------- dead, defeat and the result

test('dead = the last living town destroyed; the result comes from the goal job, not at once', { skip }, () => {
  const w = mission();
  const p = w.economy.players[PIMMONS]!;
  // no units, no buildings left is not "dead"
  for (const e of [...w.entities]) if (e.owner === PIMMONS && e.kind === Kind.Unit) w.combat.die(e);
  steps(w, 120);
  assert.equal(w.economy.dead(PIMMONS), false, 'units gone, town alive: not dead');
  assert.equal(p.outcome, 0);
  // the last town destroyed: dead at once, "lost" at the next goal run (<= 50 ticks)
  const t = w.economy.towns.find(o => o.race === PIMMONS && o.alive)!;
  w.combat.destroyTown(t);
  assert.equal(w.economy.dead(PIMMONS), true);
  assert.equal(p.defeated, true);
  assert.equal(p.outcome, 0, 'the defeat itself sets no result');
  let n = 0;
  while (p.outcome === 0 && n < 60) { w.step(); n++; }
  assert.equal(p.outcome, -1);
  assert.ok(n <= 50, `lost after ${n} ticks`);
  // the finance job of the defeated nation is cancelled
  assert.equal([...w.sched.jobs()].some(j => j.kind === JobKind.Finance && j.owner === PIMMONS && !j.cancelled), false);
});

test('goal 13 sees a computer nation dead as soon as its last town is destroyed', { skip }, () => {
  const w = mission();
  const p = w.economy.players[PIMMONS]!;
  const g = { type: 13, defeat: false, p1: 0, p2: 0, p3: 0 };
  assert.equal(w.economy.goalMet(p, g), false);
  w.combat.destroyTown(w.economy.towns.find(o => o.race === 0 && o.alive)!);
  assert.equal(w.economy.goalMet(p, g), true, 'units and buildings still dying, but dead');
});

test('network game: mission goals ignored, "won" once every other nation is dead', { skip }, () => {
  const w = mission(true);
  const p = w.economy.players[PIMMONS]!;
  assert.ok(p.goals.length > 0, 'the record has goals');
  // a loss condition that holds: ignored in a network game
  p.goals.push({ type: 16, defeat: true, p1: 0, p2: 0, p3: 0 });
  steps(w, 120);
  assert.equal(p.outcome, 0);
  w.combat.destroyTown(w.economy.towns.find(o => o.race === 0 && o.alive)!);
  steps(w, 60);
  assert.equal(p.outcome, 0, 'the Sajiki are still alive');
  w.combat.destroyTown(w.economy.towns.find(o => o.race === 2 && o.alive)!);
  steps(w, 51);
  assert.equal(p.outcome, 1, 'last nation alive');
  // the flag survives a save
  const r = roundTrip(w);
  assert.equal(r.economy.network, true);
  assert.equal(r.hash(), w.hash());
});

test('single player: the same loss condition decides', { skip }, () => {
  const w = mission();
  const p = w.economy.players[PIMMONS]!;
  p.goals.push({ type: 16, defeat: true, p1: 0, p2: 0, p3: 0 });
  steps(w, 51);
  assert.equal(p.outcome, -1);
});

// ---------------------------------------------------------------- goals: city lookups

test('goals naming a missing city or city 0 are false (types 12 and 15 included)', { skip }, () => {
  const w = mission();
  const eco = w.economy, p = eco.players[PIMMONS]!;
  assert.equal(eco.nthTown(PIMMONS, 0), undefined);
  assert.equal(eco.nthTown(PIMMONS, -1), undefined);
  assert.ok(eco.nthTown(PIMMONS, 1));
  assert.equal(eco.nthTown(PIMMONS, 2), undefined);
  const NOTHING = 61;   // no object of this type exists
  for (const p3 of [0, 2, 9]) {
    assert.equal(eco.goalMet(p, { type: 12, defeat: false, p1: 0, p2: NOTHING, p3 }), false, `12, city ${p3}`);
    assert.equal(eco.goalMet(p, { type: 15, defeat: false, p1: NOTHING, p2: 5, p3 }), false, `15, city ${p3}`);
    assert.equal(eco.goalMet(p, { type: 1, defeat: false, p1: 0, p2: 0, p3 }), false, `1, city ${p3}`);
  }
  // city 1 exists: 12 and 15 are true for a type it does not have
  assert.equal(eco.goalMet(p, { type: 12, defeat: false, p1: 0, p2: NOTHING, p3: 1 }), true);
  assert.equal(eco.goalMet(p, { type: 15, defeat: false, p1: NOTHING, p2: 5, p3: 1 }), true);
  // goal 2 counts finished objects; none finished is false even for p2 = 0
  assert.equal(eco.goalMet(p, { type: 2, defeat: false, p1: NOTHING, p2: 0, p3: 1 }), false);
  assert.equal(eco.goalMet(p, { type: 2, defeat: false, p1: T.TownHall, p2: 0, p3: 1 }), true);
});

// ---------------------------------------------------------------- rehousing at destruction

test('town destruction: the units move to the nearest town and its small houses take them at once', { skip }, () => {
  const w = mission();
  const t1 = w.economy.towns.find(o => o.race === PIMMONS && o.alive)!;
  const hall1 = w.get(t1.hall)!;
  // a second town: a hall object and its town record
  const [hx, hy] = freeNear(w, hall1);
  const hall2 = w.spawn({ cls: 1, group: PIMMONS, type: T.TownHall, owner: -1, x: (hx + 30) & (w.size - 1), y: hy, z: 0 });
  const t2 = w.economy.foundTown(PIMMONS, 99, hall2);
  const units = [0, 1, 2, 3].map(() => unitNear(w, PIMMONS, hall1, T.Porter, t2.id));
  for (const u of units) assert.equal(u.town, t2.id);
  // the houses of town 1 in list order: two free places in the first one, none elsewhere
  const houses = w.entities.filter(e => e.kind === Kind.Building && e.town === t1.id && (e.oid & 0xffff) === T.SmallHouse);
  const cap = w.rules.get(houses[0].oid)!.residents;
  for (const h of houses) h.occupancy = cap;
  houses[0].occupancy = cap - 2;
  t1.homeless = [];
  w.combat.destroyTown(t2);
  for (const u of units) assert.equal(u.town, t1.id, 'moved to the nearest town');
  assert.equal(houses[0].occupancy, cap, 'housed at once');
  assert.deepEqual(units.map(u => u.home), [houses[0].id, houses[0].id, -1, -1], 'in homeless order');
  assert.deepEqual(t1.homeless, [units[2].id, units[3].id], 'the rest wait for a house job');
  for (const u of units.slice(0, 2)) assert.ok(u.inside !== houses[0].id, 'they do not walk in');
});

// ---------------------------------------------------------------- rename (command 0x4B)

test('rename: the own living town takes the name; saved and hashed; others ignored', { skip }, () => {
  const w = mission();
  const t = w.economy.towns.find(o => o.race === PIMMONS && o.alive)!;
  const other = w.economy.towns.find(o => o.race === 0 && o.alive)!;
  const h0 = w.hash();
  w.schedule({ type: 'rename', player: PIMMONS, town: t.id, name: 'Neustadt' });
  w.schedule({ type: 'rename', player: PIMMONS, town: other.id, name: 'Fremd' });
  w.step();
  assert.equal(t.name, 'Neustadt');
  assert.equal(other.name, undefined, 'a foreign town is not renamed');
  assert.equal(t.nameIndex, 0, 'the name index stays');
  assert.ok(w.hash() !== h0, "the name is hashed");
  w.schedule({ type: 'rename', player: PIMMONS, town: t.id, name: 'x'.repeat(40) + '\0rest' });
  w.step();
  assert.equal(t.name, 'x'.repeat(31), 'cut at 31 characters');
  const r = roundTrip(w);
  assert.equal(r.economy.town(t.id)!.name, 'x'.repeat(31));
  assert.equal(r.hash(), w.hash());
});

// ---------------------------------------------------------------- repeated orders (3.2)

test('repeated orders: a running ordered harvest or go-to on the same target is not restarted', { skip }, () => {
  const w = mission();
  const t = w.economy.towns.find(o => o.race === PIMMONS && o.alive)!;
  const hall = w.get(t.hall)!;
  const WOODCUTTER = 19;
  const u = unitNear(w, PIMMONS, hall, WOODCUTTER);
  const [ux, uy] = cell(u);
  const trees = w.entities.filter(e => e.kind === Kind.Nature && w.logistics.canHarvest(u, e))
    .sort((a, b) => w.logistics.dist(ux, uy, ...cell(a)) - w.logistics.dist(ux, uy, ...cell(b)));
  const order = (target: Entity, who = u) => { w.schedule({ type: 'order', player: PIMMONS, ids: [who.id], target: target.id }); w.step(); };
  order(trees[0]);
  const j = u.job;
  assert.ok(j && w.sched.get(j)!.kind === 0x16);
  steps(w, 5);
  order(trees[0]);
  assert.equal(u.job, j, 'same harvest job kept');
  order(trees[1]);
  assert.ok(u.job !== j, 'another target: a new job');

  // a go-to to a nature object the unit cannot harvest: a walk without a job
  const porter = unitNear(w, PIMMONS, hall, T.Porter);
  const [px, py] = cell(porter);
  const far = trees.filter(e => w.logistics.dist(px, py, ...cell(e)) > 12)[0];
  order(far, porter);
  assert.equal(porter.job, 0);
  assert.equal(porter.goTarget, far.id);
  steps(w, 4);
  const path = porter.path, goal = [porter.goalX, porter.goalY];
  assert.ok(path);
  order(far, porter);
  assert.equal(porter.path, path, 'the walk goes on unchanged');
  assert.deepEqual([porter.goalX, porter.goalY], goal);
  // a move clears it: the next order on the target starts a new walk
  w.schedule({ type: 'move', player: PIMMONS, ids: [porter.id], x: px, y: py + 3 }); w.step();
  assert.equal(porter.goTarget, 0);
  order(far, porter);
  assert.equal(porter.goTarget, far.id);
});

test('repeated orders: an ordered attack on the same target keeps its state', { skip }, () => {
  const w = mission();
  const t = w.economy.towns.find(o => o.race === PIMMONS && o.alive)!;
  const hall = w.get(t.hall)!;
  const ARCHER = 29;
  const u = unitNear(w, PIMMONS, hall, ARCHER);
  const enemyTown = w.economy.towns.find(o => o.race === 0 && o.alive)!;
  const foe = unitNear(w, 0, hall, T.Porter, enemyTown.id);
  const order = () => { w.schedule({ type: 'order', player: PIMMONS, ids: [u.id], target: foe.id }); w.step(); };
  order();
  const j = u.job;
  assert.ok(j && w.sched.get(j)!.kind === 0x08);
  steps(w, 3);
  const data = [...w.sched.get(j)!.data];
  order();
  assert.equal(u.job, j, 'same attack job');
  assert.deepEqual(w.sched.get(j)!.data.slice(0, 4), data.slice(0, 4), 'target and search counter kept');
});

// ---------------------------------------------------------------- store choice (4.3)

test('store choice: first town hall in any state, warehouses by anchor distance, strict <', { skip }, () => {
  const w = mission();
  const t = w.economy.towns.find(o => o.race === PIMMONS && o.alive)!;
  const hall = w.get(t.hall)!;
  const [hx, hy] = cell(hall);
  assert.equal(w.logistics.nearestStore(t, hx + 40, hy), hall, 'no warehouse: the hall');
  hall.complete = false;
  assert.equal(w.logistics.nearestStore(t, hx + 40, hy), hall, 'a town-hall site counts');
  hall.complete = true;
  const wh = w.spawn({ cls: 1, group: PIMMONS, type: T.Warehouse, owner: -1, x: (hx + 20) & (w.size - 1), y: hy, z: 0 });
  wh.town = t.id; wh.complete = true;
  const [wx, wy] = cell(wh);
  assert.equal(w.logistics.nearestStore(t, wx + 1, wy), wh, 'nearer to the warehouse anchor');
  // equal scores: the hall stays
  const mid = (hx + wx) / 2;
  if (Number.isInteger(mid)) assert.equal(w.logistics.nearestStore(t, mid, hy), hall);
  wh.complete = false;
  assert.equal(w.logistics.nearestStore(t, wx + 1, wy), hall, 'a warehouse site is no store');
});

// ---------------------------------------------------------------- demolish (11.6)

test('demolish: refused while the town hall is dead', { skip }, () => {
  const w = mission();
  const t = w.economy.towns.find(o => o.race === PIMMONS && o.alive)!;
  const hall = w.get(t.hall)!;
  const house = w.entities.find(e => e.kind === Kind.Building && e.town === t.id && (e.oid & 0xffff) === T.SmallHouse)!;
  hall.alive = false;
  w.schedule({ type: 'building', player: PIMMONS, id: house.id, action: 'demolish' }); w.step();
  assert.equal(house.alive, true, 'refused');
  hall.alive = true;
  w.schedule({ type: 'building', player: PIMMONS, id: house.id, action: 'demolish' }); w.step();
  assert.equal(house.alive, false, 'collapsing');
});

// ---------------------------------------------------------------- research toggle (4.4.1)

test('research: choosing the running project stops it (it stays chosen); another choice restarts the job', { skip }, () => {
  const w = mission();
  const t = w.economy.towns.find(o => o.race === PIMMONS && o.alive)!;
  const p = w.economy.players[PIMMONS]!;
  const open = p.costs.map((_, i) => i).filter(i => !w.economy.researched(p, i));
  const [a, b] = open;
  const research = (inv: number) => { w.schedule({ type: 'research', player: PIMMONS, town: t.id, invention: inv }); w.step(); };
  research(a);
  const j1 = t.researchJob;
  assert.ok(j1 && w.sched.get(j1));
  research(a);
  assert.equal(t.researchJob, 0, 'the job is cancelled');
  assert.equal(t.research, a, 'the project stays chosen');
  research(a);
  assert.ok(t.researchJob && t.researchJob !== j1, 'chosen again: a new job');
  const j2 = t.researchJob;
  steps(w, 10);
  research(b);
  assert.equal(t.research, b);
  assert.ok(t.researchJob !== j2 && w.sched.get(j2)?.cancelled !== false, 'switching restarts the job');
});

// ---------------------------------------------------------------- mentor#14 (side-panel.md 1.1.3)

test('"keine freien Träger": only when no porter exists or none has a job other than a harvest', { skip }, () => {
  const w = mission();
  const t = w.economy.towns.find(o => o.race === PIMMONS && o.alive)!;
  const line = (freeClears: boolean) => (w.logistics as unknown as { noFreePorterLine(t: unknown, f: boolean, g: number): boolean }).noFreePorterLine(t, freeClears, 0);
  const porters = w.entities.filter(e => e.kind === Kind.Unit && e.town === t.id && (e.oid & 0xffff) === T.Porter);
  assert.ok(porters.length >= 2);
  const give = (u: Entity, kind: number) => { w.logistics.cancelJob(u); u.job = w.sched.create(kind, u.id, 500, new Array(30).fill(0)).id; };
  for (const u of porters) give(u, 0x16);
  assert.equal(line(false), true, 'every porter harvests');
  assert.equal(line(true), true);
  give(porters[0], 0x05);
  assert.equal(line(false), false, 'one porter carries: no line');
  give(porters[0], 0x16);
  w.logistics.cancelJob(porters[1]); porters[1].job = 0;
  if (porters[1].inside < 0 && porters[1].group === 0) {
    assert.equal(line(false), true, 'a free porter does not clear the worker-request flag');
    assert.equal(line(true), false, 'but clears the transport flag');
  }
  // a town without porters always says it
  for (const u of porters) w.economy.leaveTown(u);
  give(porters[0], 0x05);
  assert.equal(line(false), true, 'no porter at all');
});
