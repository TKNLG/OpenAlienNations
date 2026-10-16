// Add-on (Gold Edition mission pack) gameplay: ships, harbours, transport, fishing, sea combat,
// goals 17..20, computer players, determinism and speed. Spec: docs/game/addon.md;
// integration: docs/architecture/integration-addon-gameplay.md.
// Needs the Gold Edition data folder: AN_GOLD (the tests skip when it is not set).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GOLD, HAS_GOLD, dataReader, rulesOf, loadAddonMission } from './helpers/mission.ts';
import { parseMdb, parseDvmFile, dvmLayout, type Goal } from '../src/formats/mission.ts';
import { addonTerrainFromStored, AO_CLASS_SEA, type AddonTerrain } from '../src/world/addon-terrain.ts';
import { World, SUB, type Entity, type WorldSetup } from '../src/engine/world.ts';
import { NJ } from '../src/engine/naval.ts';

const skip = !HAS_GOLD && 'AN_GOLD data not found';

const cell = (e: Entity): [number, number] => [Math.floor(e.x / SUB), Math.floor(e.y / SUB)];
const jobKind = (w: World, e: Entity) => (e.job ? w.sched.get(e.job)?.kind ?? -1 : -1);

/** an add-on mission's world built by hand: `allComputer` makes the human a computer player too */
function aoWorld(mdb: string, order: number, opt: { ai?: boolean; allComputer?: boolean; gold?: WorldSetup['gold'] } = {}) {
  const read = dataReader(GOLD);
  const m = parseMdb(read(mdb)!).find(x => x.order === order)!;
  const rules = rulesOf(GOLD, true);
  const file = parseDvmFile(read(m.mapFile)!, dvmLayout(m));
  const terrain = () => addonTerrainFromStored(file.terrain!);
  const setup: WorldSetup = {
    races: opt.allComputer ? m.races.map(r => ({ ...r, computer: true })) : m.races,
    costs: rules.inventions.map(l => l.map(i => i.cost)),
    prerequisites: rules.inventions.map(l => l.map(i => i.prerequisites)),
    goals: m.goals, weapons: rules.weapons, orders: file.extras.orders, lists: file.extras.lists,
    ai: opt.ai ?? false, gold: opt.gold,
  };
  const world = new World(terrain(), file.objects, rules.rules, setup);
  return { world, mission: m, rules, terrain };
}

/** nearest cell (to p) of the ship's sea body next to island k */
function shoreCell(w: World, ship: Entity, k: number, p: [number, number]): [number, number] {
  const n = w.size;
  const comp = (x: number, y: number) => w.naval.seaComp[((y & (n - 1)) << w.bits) | (x & (n - 1))];
  const c = comp(...cell(ship));
  let best: [number, number] = [0, 0], bd = Infinity;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if (comp(x, y) !== c || !w.naval.shipFree(x, y) || !w.naval.nearIsland(x, y, k)) continue;
    const d = w.logistics.dist(x, y, p[0], p[1]);
    if (d < bd) { bd = d; best = [x, y]; }
  }
  return best;
}

function runUntil(w: World, max: number, done: () => boolean): number {
  for (let i = 0; i < max; i++) { if (done()) return i; w.step(); }
  return done() ? max : -1;
}

// ---------------------------------------------------------------- world model

test('add-on mode: islands, ship grid, mountain limit, options; base maps unchanged', { skip }, () => {
  const { world: w, terrain } = aoWorld('AmazonsAO.mdb', 4);
  const t = w.terrain as AddonTerrain;
  assert.equal(w.addon, true);
  assert.equal(w.mountain, 290);
  assert.equal(w.typeWidth, 68);
  assert.equal(w.gold.shipyardTopUp, true);
  assert.equal(w.gold.fishHarvestBug, false);
  // ships may use exactly the open sea without objects
  for (let i = 0; i < t.aoCls.length; i++) {
    if (t.aoCls[i] !== AO_CLASS_SEA) assert.equal(w.shipBlocked[i], 1);
    else if (!w.buildingCells[i] && !w.natureAt[i]) assert.equal(w.shipBlocked[i], 0);
  }
  // every map ship stands on open sea, every map land unit on an island
  for (const e of w.entities) {
    if (e.kind !== 0 || e.inside >= 0) continue;
    const [x, y] = cell(e);
    if (w.isShip(e)) { assert.equal(w.islandAt(x, y), 0); assert.equal(w.naval.isSea(x, y), true); }
    else assert.ok(w.islandAt(x, y) > 0);
  }
  // a land unit cannot walk to another island: the walk fails at once (after the births of the
  // map's town halls and houses have come out of their doors, units-and-jobs.md 4.10)
  for (let i = 0; i < 40; i++) w.step();
  const scout = w.entities.find(e => e.kind === 0 && e.owner === 0 && !w.isShip(e) && e.inside < 0)!;
  const home = w.islandAt(...cell(scout));
  let other: [number, number] | null = null;
  for (let y = 0; y < w.size && !other; y++) for (let x = 0; x < w.size; x++) if (w.islandAt(x, y) > 0 && w.islandAt(x, y) !== home && !w.blocked[(y << w.bits) | x]) { other = [x, y]; break; }
  assert.equal(w.walk(scout, other![0], other![1]), false);
  assert.ok(terrain);
  // a base-style terrain keeps the base world
  const flat = { sizeBits: 5, size: 32, height: new Uint16Array(1024).fill(128), cls: new Uint8Array(1024), tile: new Uint8Array(1024) };
  const b = new World(flat, []);
  assert.equal(b.addon, false);
  assert.equal(b.shipBlocked.length, 0);
  assert.equal(b.mountain, 250);
  assert.equal(b.gold.pathFlag, false);
  assert.equal(b.gold.shipyardTopUp, false);
});

test('map cargo: created inside its transport after all units (goal object ids)', { skip }, () => {
  const { world: w } = aoWorld('AmazonsAO.mdb', 4);
  const ship = w.entities.find(e => w.isShip(e) && (e.oid & 0xffff) === 67 && cell(e)[0] === 63 && cell(e)[1] === 52)!;
  assert.equal(ship.passengers.length, 3);
  const scout = w.get(318 + 1)!;   // goal object #318 (creation index) = entity id 319
  assert.equal(scout.oid & 0xffff, 24);
  assert.equal(scout.inside, ship.id);
  assert.ok(ship.passengers.includes(scout.id));
  assert.equal(scout.town, ship.town);
  // created last: every other map object has a smaller id
  const cargo = new Set(w.entities.filter(e => w.isShip(e)).flatMap(e => e.passengers));
  const lastMap = Math.max(...w.entities.filter(e => !cargo.has(e.id)).map(e => e.id));
  for (const id of cargo) assert.ok(id > lastMap);
});

// ---------------------------------------------------------------- harbour and shipyard

test('shipyard trains a ship: the porter goes in, the ship comes out on open sea', { skip }, () => {
  const { world: w, mission: m } = aoWorld('SajikisAO.mdb', 2);
  const h = m.humanRace;
  const yard = w.entities.find(e => e.kind === 1 && e.owner === h && (e.oid & 0xffff) === 63)!;
  const t = w.economy.town(yard.town)!;
  assert.equal(w.logistics.trainState(t, yard, 67), 1);
  const porters = () => w.entities.filter(e => e.kind === 0 && e.town === t.id && (e.oid & 0xffff) === 9).length;
  const old = new Set(w.entities.filter(e => w.isShip(e)).map(e => e.id));
  const p0 = porters();
  w.schedule({ type: 'train', player: h, building: yard.id, unit: 67 });
  let ship: Entity | undefined;
  const ticks = runUntil(w, 4000, () => !!(ship = w.entities.find(e => w.isShip(e) && !old.has(e.id))));
  assert.ok(ticks > 0, 'a transport ship was launched');
  // duration: ceil(350 / 5) x 30 ticks of training after the porter arrived (addon.md 3.4)
  assert.ok(ticks >= 2100 && ticks < 3000, `trained in ${ticks} ticks`);
  const [x, y] = cell(ship!);
  assert.equal(ship!.inside, -1);
  assert.equal(w.naval.isSea(x, y), true, 'on open sea');
  assert.equal(w.shipBlocked[(y << w.bits) | x], 0);
  assert.ok(w.logistics.dist(x, y, ...cell(yard)) <= 6, 'next to the shipyard');
  assert.equal(porters(), p0 - 1, 'the porter was consumed');
  assert.equal(ship!.oid >>> 16, h);
  assert.equal(w.naval.capacity(ship!), 5);
});

test('harbour placement at the waterline; no foundation, no rubble; shipyard goods top-up', { skip }, () => {
  const { world: w, mission: m } = aoWorld('AmazonsAO.mdb', 3);
  const h = m.humanRace;
  const t = w.economy.towns.find(x => x.race === h && x.alive)!;
  const r = w.rules.get((h << 16) | 62)!;
  const sites: [number, number][] = [];
  for (let dy = -25; dy <= 25; dy++) for (let dx = -25; dx <= 25; dx++) {
    const x = (t.x + dx) & (w.size - 1), y = (t.y + dy) & (w.size - 1);
    if (w.logistics.canPlace(t, r, x, y)) sites.push([x, y]);
  }
  assert.ok(sites.length > 0, 'a shore site in the town area');
  // every accepted site: 1..6 land cells in the grown 5 x 5 footprint, the rest water
  for (const [x, y] of sites) {
    let land = 0;
    for (let dy = -3; dy <= 1; dy++) for (let dx = -3; dx <= 1; dx++) if (!w.naval.isWater(x + dx, y + dy)) land++;
    assert.ok(land >= 1 && land <= 6, `land ${land}`);
  }
  // inland: never
  assert.equal(w.logistics.canPlace(t, r, t.x, t.y), false);
  const [x, y] = sites[0];
  const heights = Array.from({ length: 25 }, (_, k) => w.heightAt(x - 3 + (k % 5), y - 3 + Math.floor(k / 5)));
  t.stock[1] = Math.max(t.stock[1], 20); t.stock[2] = Math.max(t.stock[2], 20);
  w.schedule({ type: 'build', player: h, town: t.id, building: 62, x, y });
  w.step();
  const site = w.entities.find(e => e.kind === 1 && (e.oid & 0xffff) === 62 && cell(e)[0] === x && cell(e)[1] === y)!;
  assert.ok(site && !site.complete);
  assert.deepEqual(Array.from({ length: 25 }, (_, k) => w.heightAt(x - 3 + (k % 5), y - 3 + Math.floor(k / 5))), heights, 'no foundation');
  // destroyed: no rubble
  w.combat.collapse(site, true);
  for (let i = 0; i < 30; i++) w.step();
  assert.equal(w.get(site.id), undefined);
  assert.equal(w.entities.some(e => e.kind === 2 && (e.oid & 0xffff) === 38 && w.logistics.dist(...cell(e), x, y) <= 3), false, 'no rubble');
  // the shipyard tops its goods up when placed (3.5)
  const ry = w.rules.get((h << 16) | 63)!;
  t.stock[1] = 0; t.stock[2] = 0;
  assert.equal(w.logistics.menuState(t, 63), w.economy.researched(w.economy.players[h]!, 30) ? 1 : 2);
  const yardSite = sites.find(([sx, sy]) => w.logistics.canPlace(t, ry, sx, sy));
  if (yardSite && w.logistics.menuState(t, 63) === 1) {
    const b = w.logistics.placeBuilding(t, 63, ...yardSite)!;
    assert.ok(b);
    assert.equal(t.stock[1], Math.min(t.capacity, 15));
    assert.equal(t.stock[2], Math.min(t.capacity, 15));
  }
});

// ---------------------------------------------------------------- transport ships

test('transport: units board from the shore, sail to another island and unload there', { skip }, () => {
  const { world: w, mission: m } = aoWorld('PimmonsAO.mdb', 1);
  const h = m.humanRace;
  w.combat.setRelation(1, 2, 3);   // peace with the Sajiki: their outposts leave the ship alone
  for (let i = 0; i < 40; i++) w.step();   // births come out of their doors (units-and-jobs.md 4.10)
  const ship = w.entities.find(e => w.isShip(e) && e.owner === h && (e.oid & 0xffff) === 67)!;
  const town = w.economy.towns.find(t => t.race === h)!;
  const home = w.islandAt(town.x, town.y);
  const units = w.entities.filter(e => e.kind === 0 && e.owner === h && e.inside < 0 && !w.isShip(e) && w.islandAt(...cell(e)) === home).slice(0, 7);
  assert.equal(units.length, 7);
  const pickup = shoreCell(w, ship, home, cell(units[0]));
  w.schedule({ type: 'move', player: h, ids: [ship.id], x: pickup[0], y: pickup[1] });
  const t0 = w.tick;
  assert.ok(runUntil(w, 3000, () => w.tick > t0 + 2 && !ship.path) >= 0);
  assert.deepEqual(cell(ship), pickup);
  w.schedule({ type: 'order', player: h, ids: units.map(u => u.id), target: ship.id });
  runUntil(w, 1500, () => ship.passengers.length === 5);
  for (let i = 0; i < 200; i++) w.step();
  assert.equal(ship.passengers.length, 5, 'capacity 5');
  const aboard = units.filter(u => u.inside === ship.id);
  assert.equal(aboard.length, 5);
  assert.deepEqual(aboard.map(u => u.id).sort(), [...ship.passengers].sort());
  // passengers are hidden: not targetable, not scanned
  assert.equal(w.combat.valid(aboard[0]), false);
  assert.equal(w.combat.scan(...cell(ship), 3).includes(aboard[0]), false);
  // sail to the far island and send everyone out
  const drop = shoreCell(w, ship, 7, [104, 68]);
  w.schedule({ type: 'move', player: h, ids: [ship.id], x: drop[0], y: drop[1] });
  w.step();
  assert.ok(runUntil(w, 5000, () => !ship.path) >= 0);
  assert.deepEqual(cell(ship), drop);
  w.schedule({ type: 'unload', player: h, ship: ship.id });
  w.step();
  assert.equal(ship.passengers.length, 0, 'taken off the list at once');
  assert.ok(runUntil(w, 300, () => aboard.every(u => u.inside < 0)) >= 0);
  const cells = new Set<number>();
  for (const u of aboard) {
    const [x, y] = cell(u);
    assert.ok(w.islandAt(x, y) > 0 && w.islandAt(x, y) !== home, 'landed on another island');
    assert.ok(w.logistics.dist(x, y, ...drop) <= 5, 'within 5 rings');
    cells.add((y << w.bits) | x);
  }
  assert.equal(cells.size, aboard.length, 'each on its own cell');
});

test('unloading out at sea: the ship sails to the coast first (sail-to-coast job 0x3B)', { skip }, () => {
  const { world: w, mission: m } = aoWorld('PimmonsAO.mdb', 1);
  const h = m.humanRace;
  for (let i = 0; i < 40; i++) w.step();   // births come out of their doors (units-and-jobs.md 4.10)
  const ship = w.entities.find(e => w.isShip(e) && e.owner === h && (e.oid & 0xffff) === 67)!;
  const porter = w.entities.find(e => e.kind === 0 && e.owner === h && (e.oid & 0xffff) === 9 && e.inside < 0 && !e.job)!;
  w.naval.embark(porter, ship);
  const n = w.size;
  let far: [number, number] | null = null;
  for (let r = 1; r < 60 && !far; r++) for (const [dx, dy] of [[r, 0], [0, r], [-r, 0], [0, -r]]) {
    const x = (cell(ship)[0] + dx) & (n - 1), y = (cell(ship)[1] + dy) & (n - 1);
    let land = false;
    for (let yy = -6; yy <= 6 && !land; yy++) for (let xx = -6; xx <= 6; xx++) if (!w.naval.isWater(x + xx, y + yy)) { land = true; break; }
    if (!land && w.naval.shipFree(x, y)) { far = [x, y]; break; }
  }
  w.schedule({ type: 'move', player: h, ids: [ship.id], x: far![0], y: far![1] });
  const t0 = w.tick;
  runUntil(w, 3000, () => w.tick > t0 + 2 && !ship.path);
  w.schedule({ type: 'unload', player: h, ship: ship.id });
  let sailed = false;
  const t = runUntil(w, 2000, () => { if (jobKind(w, ship) === NJ.Sail) sailed = true; return porter.inside < 0; });
  assert.ok(t > 0 && sailed, 'the ship got a sail-to-coast job and the porter landed');
  assert.ok(w.islandAt(...cell(porter)) > 0);
});

test('a sunk transport takes its passengers along; ships are never healed', { skip }, () => {
  const { world: w } = aoWorld('AmazonsAO.mdb', 4);
  const ship = w.entities.find(e => w.isShip(e) && e.passengers.length === 3)!;
  const passengers = [...ship.passengers];
  w.combat.die(ship);
  assert.equal(w.get(ship.id), undefined);
  for (const id of passengers) assert.equal(w.get(id), undefined, 'passenger died with the ship');
  // goal 18 ("the scout is gone") now holds
  const p = w.economy.players[0]!;
  assert.equal(w.economy.goalMet(p, { type: 18, defeat: true, p1: 318, p2: 24, p3: 0 }), true);
  // priests may not heal a damaged ship
  const war = w.entities.find(e => w.isShip(e) && (e.oid & 0xffff) === 65)!;
  war.hp -= 50;
  const priest = w.spawnUnit(war.oid >>> 16, 22, 115, 80, war.town);
  assert.equal(w.combat.mayAct(priest, war), false);
});

// ---------------------------------------------------------------- fishing

test('fishing: a boat catches fish (each twice), delivers to the harbour, fish never return', { skip }, () => {
  const { world: w, mission: m } = aoWorld('SajikisAO.mdb', 2);
  const h = m.humanRace;
  const harb = w.entities.find(e => e.kind === 1 && e.owner === h && (e.oid & 0xffff) === 62)!;
  const t = w.economy.town(harb.town)!;
  const boat = w.spawnUnit(h, 64, ...w.logistics.entrance(harb), t.id);
  w.economy.joinTown(boat, t);
  assert.ok(w.naval.isSea(...cell(boat)));
  const fishes = () => w.entities.filter(e => w.naval.isFish(e));
  const n0 = fishes().length;
  const fish = fishes().sort((a, b) => w.logistics.dist(...cell(a), ...cell(harb)) - w.logistics.dist(...cell(b), ...cell(harb)))[0];
  const amount = w.rules.get(fish.oid)!.amount;
  // right-click on the fish: the fishing job (the original's harvest bug is off by default)
  w.schedule({ type: 'order', player: h, ids: [boat.id], target: fish.id });
  w.step(); w.step();
  assert.equal(jobKind(w, boat), NJ.Fishing);
  let produced = 0, catches = 0, last = 0;
  const foodBefore = () => t.foodNow;
  let f0 = foodBefore();
  for (let i = 0; i < 1500; i++) {
    w.step();
    if (boat.carryAmount > last) catches++;
    last = boat.carryAmount;
    if (t.foodNow > f0) { produced += t.foodNow - f0; f0 = t.foodNow; }
    if (t.foodNow < f0) f0 = t.foodNow;   // a new round started
  }
  assert.ok(catches >= 2, `${catches} catches`);
  assert.equal(w.get(fish.id), undefined, 'the fish is gone after the second catch');
  assert.ok(produced >= 2 * amount, `delivered ${produced} food`);
  assert.equal(jobKind(w, boat), NJ.Fishing, 'still fishing');
  assert.ok(fishes().length < n0);
  for (let i = 0; i < 3000; i++) w.step();
  assert.ok(w.respawns.every(r => r.cls !== 15), 'fish are never filed for respawn');
});

test('fishing boat on a fish with the original harvest bug: harvest job, endless delivery retries', { skip }, () => {
  const { world: w, mission: m } = aoWorld('SajikisAO.mdb', 2, { gold: { fishHarvestBug: true } });
  const h = m.humanRace;
  const harb = w.entities.find(e => e.kind === 1 && e.owner === h && (e.oid & 0xffff) === 62)!;
  const t = w.economy.town(harb.town)!;
  const boat = w.spawnUnit(h, 64, ...w.logistics.entrance(harb), t.id);
  w.economy.joinTown(boat, t);
  const fish = w.entities.filter(e => w.naval.isFish(e)).sort((a, b) => w.logistics.dist(...cell(a), ...cell(harb)) - w.logistics.dist(...cell(b), ...cell(harb)))[0];
  w.schedule({ type: 'order', player: h, ids: [boat.id], target: fish.id });
  for (let i = 0; i < 600; i++) w.step();
  assert.equal(jobKind(w, boat), 0x16, 'harvest job');
  assert.equal(fish.alive, false, 'the boat killed the fish');
  assert.ok(boat.carryAmount > 0, 'it carries food it can never deliver (the store is on land)');
});

// ---------------------------------------------------------------- sea combat

test('sea battle: warships fire, take damage and sink', { skip }, () => {
  const { world: w, mission: m } = aoWorld('AmazonsAO.mdb', 5);
  const h = m.humanRace;
  const mine = w.entities.filter(e => w.isShip(e) && e.owner === h && (e.oid & 0xffff) === 65);
  const theirs = w.entities.filter(e => w.isShip(e) && e.owner !== h);
  const target = theirs.sort((a, b) => w.logistics.dist(...cell(a), ...cell(mine[0])) - w.logistics.dist(...cell(b), ...cell(mine[0])))[0];
  const hp0 = new Map([...mine, ...theirs].map(e => [e.id, e.hp]));
  w.schedule({ type: 'order', player: h, ids: mine.map(e => e.id), target: target.id });
  let shots = 0;
  const sunk = () => [...hp0.keys()].filter(id => !w.get(id));
  for (let i = 0; i < 3000 && sunk().length < 2; i++) {
    w.step();
    shots += w.effects.filter(f => f.kind === 'shot').length;
    w.effects.length = 0;
    for (const [id, hp] of hp0) { const e = w.get(id); if (e) { assert.ok(e.hp <= hp, 'no healing at sea'); hp0.set(id, e.hp); } }
  }
  assert.ok(shots > 0, 'cannons fired');
  assert.ok(target.hp < w.rules.get(target.oid)!.hp || !w.get(target.id), 'the target was hit');
  assert.ok(sunk().length >= 1, 'a ship sank');
  for (const id of sunk()) assert.equal(w.entities.some(e => e.id === id), false);
  // ships gain no rank
  for (const e of mine) if (w.get(e.id)) assert.equal(e.rank, 0);
});

// ---------------------------------------------------------------- goals

test('mission goals 17..20', { skip }, () => {
  const { world: w } = aoWorld('AmazonsAO.mdb', 4);
  const p = w.economy.players[0]!;
  const [g17, g18] = p.goals;
  assert.equal(g17.type, 17);
  assert.equal(w.economy.goalMet(p, g17), false, 'the scout is still on the ship');
  assert.equal(w.economy.goalMet(p, g18), false);
  // the scout stands next to the embassy at (59, 101)
  const scout = w.get(319)!;
  const ship = w.get(scout.inside)!;
  ship.passengers = ship.passengers.filter(id => id !== scout.id);
  scout.inside = -1;
  w.place(scout, 60, 103);
  assert.equal(w.economy.goalMet(p, g17), true);
  assert.equal(w.economy.goalMet(p, { ...g17, p3: 1 }), false, 'radius');
  assert.equal(w.economy.goalMet(p, { ...g18, p2: 23 }), true, 'type differs = destroyed');
  w.combat.die(scout);
  assert.equal(w.economy.goalMet(p, g17), false);
  assert.equal(w.economy.goalMet(p, g18), true);
  // the win/loss rule picks it up (loss)
  for (let i = 0; i < 60; i++) w.step();
  assert.equal(p.outcome, -1);

  // 19: objects of the settlements on an island; 20: stock at most
  const s = aoWorld('SajikisAO.mdb', 2).world;
  const ps = s.economy.players[2]!;
  const town = s.economy.towns.find(t => t.race === 2 && t.alive)!;
  const isl = s.islandAt(town.x, town.y);
  const g = (type: number, p1: number, p2: number, p3: number): Goal => ({ type, defeat: false, p1, p2, p3 });
  assert.equal(s.economy.goalMet(ps, g(19, isl, 63, 1)), true, 'the shipyard of the home town');
  assert.equal(s.economy.goalMet(ps, g(19, isl, 63, 2)), false);
  assert.equal(s.economy.goalMet(ps, g(19, isl === 2 ? 3 : 2, 63, 1)), false, 'no own settlement there');
  assert.equal(s.economy.goalMet(ps, g(19, 1, 52, 1)), false, 'SajikisAO 2: no cell has island id 1');
  town.stock[4] = 3;
  assert.equal(s.economy.goalMet(ps, g(20, 4, 5, 1)), true);
  town.stock[4] = 6;
  assert.equal(s.economy.goalMet(ps, g(20, 4, 5, 1)), false);
  assert.equal(s.economy.goalMet(ps, g(20, 4, 5, 9)), false, 'no such city');
});

// ---------------------------------------------------------------- sea trade

test('sea trade: a transport ship runs a route between harbours of two towns', { skip }, () => {
  const { world: w, mission: m } = aoWorld('AmazonsAO.mdb', 3);
  const h = m.humanRace;
  const mine = w.entities.find(e => e.kind === 1 && e.owner === h && (e.oid & 0xffff) === 62)!;
  const other = w.entities.find(e => e.kind === 1 && e.owner !== h && (e.oid & 0xffff) === 62)!;
  const A = w.economy.town(mine.town)!, B = w.economy.town(other.town)!;
  assert.ok(w.islandAt(A.x, A.y) !== w.islandAt(B.x, B.y), 'different islands');
  w.combat.setRelation(A.race, B.race, 3);
  const ship = w.spawnUnit(h, 67, ...w.logistics.entrance(mine), A.id);
  w.economy.joinTown(ship, A);
  assert.equal(w.trade.isTrader(ship), true);
  assert.deepEqual(w.trade.partners(A, false, 62).map(t => t.id), [B.id]);
  // merchants: only towns on their own island (none here)
  assert.deepEqual(w.trade.partners(A, false, 48, w.islandAt(A.x, A.y)).filter(t => t.id === B.id), []);
  w.trade.set(A.id, 1, 5, 1);                               // A sells wood
  w.trade.set(B.id, 1, 2, 1); w.trade.set(B.id, 1, 0, 100); // B buys wood
  const money0 = w.economy.players[A.race]!.money;
  w.schedule({ type: 'route', player: h, unit: ship.id, action: 'set', from: A.id, to: B.id });
  let loaded = false, unloaded = false;
  for (let i = 0; i < 2500; i++) {
    w.step();
    if (ship.carryAmount === 5 && ship.carryGood === 1) loaded = true;
    if (loaded && ship.carryAmount === 0) unloaded = true;
  }
  assert.ok(loaded && unloaded, 'loaded wood at home, unloaded it over sea');
  assert.equal(ship.inside, -1, 'a docking ship stays on the water');
  assert.ok(w.naval.isSea(...cell(ship)));
  assert.ok(w.economy.players[A.race]!.money > money0);
});

// ---------------------------------------------------------------- computer players

test('naval planner: a computer transport ferries waiting units to another island', { skip }, () => {
  const { world: w } = aoWorld('PimmonsAO.mdb', 5, { ai: true });
  // the training planner claims the transport on one of its runs (later since births come out
  // through the door, units-and-jobs.md 4.10)
  runUntil(w, 1000, () => w.tick >= 200 && (w.naval.planner(2)?.ships.length ?? 0) > 0);
  const pl = w.naval.planner(2)!;
  assert.ok(pl, 'the Sajiki have a planner');
  assert.equal(pl.ships.length, 1, 'the free transport was claimed');
  const ship = w.get(pl.ships[0].id)!;
  assert.equal(ship.group, 61);
  const t = w.economy.towns.find(x => x.race === 2 && x.alive)!;
  const home = w.islandAt(t.x, t.y);
  const units = w.entities.filter(e => e.kind === 0 && e.town === t.id && (e.oid & 0xffff) === 9 && e.inside < 0 && w.islandAt(...cell(e)) === home).slice(0, 2);
  const dest: [number, number] = [135, 0];
  assert.ok(w.islandAt(...dest) > 0 && w.islandAt(...dest) !== home);
  const req = w.naval.request(2, units.length, 0, ...cell(units[0]), ...dest);
  for (const u of units) { w.naval.addWaiting(2, req, u); assert.equal(jobKind(w, u), NJ.Wait); }
  const states = new Set<number>();
  runUntil(w, 6000, () => { states.add(pl.ships[0].state); return pl.ships[0].state === 1 && states.has(5); });
  assert.deepEqual([...states].sort(), [1, 2, 3, 4, 5]);
  for (const u of units) {
    assert.equal(u.inside, -1);
    assert.equal(w.islandAt(...cell(u)), w.islandAt(...dest), 'ferried over');
  }
});

test('computer players build a harbour and a shipyard and keep a fishing boat (20000 ticks)', { skip }, () => {
  // AmazonsAO 8: on mission 5 the harbour only comes once a wood-starved town has grown past 19
  // people, which the turn and planning delays of unit motion (units-and-jobs.md 4.1, 4.6) push
  // beyond 20000 ticks; mission 8 shows the same naval behaviour early
  const { world: w } = aoWorld('AmazonsAO.mdb', 8, { ai: true, allComputer: true });
  const before = new Set(w.entities.filter(e => e.kind === 1 && (e.oid & 0xffff) >= 62).map(e => e.id));
  const seen = new Set<string>();
  let fishing = false;
  const t0 = performance.now();
  for (let i = 0; i < 20000; i++) {
    w.step();
    if (i % 100 !== 0) continue;
    for (const e of w.entities) {
      const ty = e.oid & 0xffff;
      if (e.kind === 1 && (ty === 62 || ty === 63) && !before.has(e.id)) seen.add(`${ty}${e.complete ? 'done' : ''}`);
      if (w.isShip(e) && ty === 64 && jobKind(w, e) === NJ.Fishing) fishing = true;
    }
  }
  console.log(`AmazonsAO 8, all computer: ${((performance.now() - t0) / 20000).toFixed(3)} ms/tick, new: ${[...seen].join(' ')}`);
  assert.ok(seen.has('62done'), 'a harbour was built');
  assert.ok(seen.has('63'), 'a shipyard was placed');
  assert.ok(fishing, 'a computer fishing boat fished');
  assert.ok([0, 1, 2].some(r => w.naval.planner(r)), 'planners run');
});

// ---------------------------------------------------------------- determinism and speed

function scenario(w: World, h: number, ticks: number, stopAt = -1): World {
  // a transport boards, a fishing boat fishes, the AI runs
  const ship = w.entities.find(e => w.isShip(e) && e.owner === h && (e.oid & 0xffff) === 67)!;
  for (let i = 0; i < ticks; i++) {
    if (w.tick === 5) {
      const units = w.entities.filter(e => e.kind === 0 && e.owner === h && e.inside < 0 && !w.isShip(e)).slice(0, 3);
      w.schedule({ type: 'move', player: h, ids: [ship.id], x: 185, y: 175 });
      w.schedule({ type: 'order', player: h, ids: units.map(u => u.id), target: ship.id }, w.tick + 80);
      w.schedule({ type: 'move', player: h, ids: [ship.id], x: 150, y: 150 }, w.tick + 600);
      w.schedule({ type: 'unload', player: h, ship: ship.id }, w.tick + 1200);
    }
    if (w.tick === stopAt) return w;
    w.step();
  }
  return w;
}

test('determinism: two runs agree; snapshot / restore mid-run continues identically', { skip }, () => {
  const make = () => aoWorld('PimmonsAO.mdb', 1, { ai: true });
  const a = scenario(make().world, 1, 2500), b = scenario(make().world, 1, 2500);
  assert.equal(a.hash(), b.hash());
  // snapshot with passengers aboard and the planner / AI running
  const c = make();
  scenario(c.world, 1, 3000, 700);
  const ship = c.world.entities.find(e => c.world.isShip(e) && e.owner === 1 && (e.oid & 0xffff) === 67)!;
  assert.ok(ship.passengers.length > 0, 'passengers aboard at the snapshot');
  const snap = JSON.parse(JSON.stringify(c.world.snapshot()));
  assert.equal(snap.addon, true);
  const r = World.restore(c.terrain(), snap, c.rules.rules, c.rules.weapons);
  assert.equal(r.addon, true);
  assert.equal(r.hash(), c.world.hash());
  for (let i = 0; i < 1500; i++) { c.world.step(); r.step(); }
  assert.equal(r.hash(), c.world.hash());
  // and through a further unload command after the restore
  for (const w of [c.world, r]) { w.schedule({ type: 'unload', player: 1, ship: ship.id }); for (let i = 0; i < 300; i++) w.step(); }
  assert.equal(r.hash(), c.world.hash());
});

test('speed: AmazonsAO 4 with computer players stays below 1 ms per tick', { skip }, () => {
  const { world: w } = loadAddonMission('AmazonsAO.mdb', 4, GOLD, true);
  for (let i = 0; i < 200; i++) w.step();
  const t0 = performance.now();
  const N = 5000;
  for (let i = 0; i < N; i++) w.step();
  const ms = (performance.now() - t0) / N;
  console.log(`AmazonsAO 4: ${ms.toFixed(3)} ms/tick (${w.entities.length} entities)`);
  assert.ok(ms < 1, `${ms.toFixed(3)} ms/tick`);
});
