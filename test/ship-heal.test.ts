// Gold Edition: a ship's HP is never restored (docs/game/addon.md 4.3). A priest's right-click on a
// damaged own ship and the help rule still give him a heal job (no class test), which can never
// strike because no land cell touches a ship; builders cannot repair ships either.
// Needs the Gold Edition data folder: AN_GOLD (the tests skip when it is not set).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GOLD, HAS_GOLD, dataReader, rulesOf } from './helpers/mission.ts';
import { parseMdb, parseDvmFile, dvmLayout } from '../src/formats/mission.ts';
import { addonTerrainFromStored } from '../src/world/addon-terrain.ts';
import { World, SUB, type Entity, type WorldSetup } from '../src/engine/world.ts';
import { CJ } from '../src/engine/combat.ts';

const skip = !HAS_GOLD && 'AN_GOLD data not found';
const cell = (e: Entity): [number, number] => [Math.floor(e.x / SUB), Math.floor(e.y / SUB)];
const jobKind = (w: World, e: Entity) => (e.job ? w.sched.get(e.job)?.kind ?? -1 : -1);

function pimmons(): { w: World; h: number } {
  const read = dataReader(GOLD);
  const m = parseMdb(read('PimmonsAO.mdb')!).find(x => x.order === 1)!;
  const rules = rulesOf(GOLD, true);
  const file = parseDvmFile(read(m.mapFile)!, dvmLayout(m));
  const setup: WorldSetup = {
    races: m.races, costs: rules.inventions.map(l => l.map(i => i.cost)),
    prerequisites: rules.inventions.map(l => l.map(i => i.prerequisites)),
    goals: m.goals, weapons: rules.weapons, orders: file.extras.orders, lists: file.extras.lists, ai: false,
  };
  const w = new World(addonTerrainFromStored(file.terrain!), file.objects, rules.rules, setup);
  w.combat.setRelation(1, 2, 3);
  for (let i = 0; i < 40; i++) w.step();
  return { w, h: m.humanRace };
}

/** the transport, brought to the open-sea cell nearest to the home town, and a land cell beside that */
function shipAtShore(w: World, h: number): { ship: Entity; land: [number, number] } {
  const ship = w.entities.find(e => w.isShip(e) && e.owner === h && (e.oid & 0xffff) === 67)!;
  const town = w.economy.towns.find(t => t.race === h)!;
  const home = w.islandAt(town.x, town.y);
  const n = w.size, m = n - 1;
  let best: [number, number] = [0, 0], bd = Infinity;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if (!w.naval.shipFree(x, y) || !w.naval.nearIsland(x, y, home)) continue;
    const d = w.logistics.dist(x, y, town.x & m, town.y & m);
    if (d < bd) { bd = d; best = [x, y]; }
  }
  w.schedule({ type: 'move', player: h, ids: [ship.id], x: best[0], y: best[1] });
  const t0 = w.tick;
  for (let i = 0; i < 4000 && !(w.tick > t0 + 2 && !ship.path); i++) w.step();
  const at = cell(ship);
  assert.ok(w.naval.nearIsland(at[0], at[1], home), 'the ship lies off the home island');
  // the nearest free land cell of the home island
  let land: [number, number] = [0, 0], ld = Infinity;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if (w.islandAt(x, y) !== home || w.occupied(x, y)) continue;
    const d = w.logistics.dist(x, y, at[0], at[1]);
    if (d < ld) { ld = d; land = [x, y]; }
  }
  assert.ok(ld >= 2, 'no land cell touches a ship');
  return { ship, land };
}

test('a priest ordered on a damaged own ship: heal job, but no strike, no move, no boarding; then it ends', { skip }, () => {
  const { w, h } = pimmons();
  const { ship, land } = shipAtShore(w, h);
  const max = w.rules.get(ship.oid)!.hp;
  ship.hp = max - 60;
  const priest = w.spawnUnit(ship.oid >>> 16, 22, land[0], land[1], ship.town);
  assert.equal(w.combat.mayAct(priest, ship), false, 'may-act refuses ships for a priest');
  const at = cell(priest);
  w.schedule({ type: 'order', player: h, ids: [priest.id], target: ship.id });
  w.step(); w.step();
  assert.equal(jobKind(w, priest), CJ.Heal, 'the order makes a heal job (no class test)');
  let ended = -1;
  for (let i = 0; i < 400; i++) {
    w.step();
    if (ended < 0 && jobKind(w, priest) !== CJ.Heal) ended = i;
  }
  assert.ok(ended >= 0, 'the heal job gives up');
  assert.equal(ship.hp, max - 60, 'the ship is not healed');
  assert.equal(priest.inside, -1, 'the priest did not board the transport');
  assert.equal(ship.passengers.includes(priest.id), false);
  assert.deepEqual(cell(priest), at, 'a failed search writes no path: the priest stays put');
});

test('an undamaged transport is boarded by a priest as by any unit', { skip }, () => {
  const { w, h } = pimmons();
  const { ship, land } = shipAtShore(w, h);
  const priest = w.spawnUnit(ship.oid >>> 16, 22, land[0], land[1], ship.town);
  w.schedule({ type: 'order', player: h, ids: [priest.id], target: ship.id });
  w.step(); w.step();
  assert.ok(jobKind(w, priest) !== CJ.Heal);
  for (let i = 0; i < 1500 && priest.inside !== ship.id; i++) w.step();
  assert.equal(priest.inside, ship.id, 'boarded');
});

test('help rule: a hit ship calls a nearby priest of its race; the heal job never heals it', { skip }, () => {
  const { w, h } = pimmons();
  const { ship, land } = shipAtShore(w, h);
  const max = w.rules.get(ship.oid)!.hp;
  ship.hp = max - 30;
  const priest = w.spawnUnit(ship.oid >>> 16, 22, land[0], land[1], ship.town);
  const foe = w.entities.find(e => e.kind === 0 && e.alive && (e.oid >>> 16) !== (ship.oid >>> 16) && (e.oid >>> 16) <= 2 && !w.isShip(e))!;
  assert.ok(foe, 'some foreign unit as the attacker');
  w.combat.attacked(ship, foe);
  assert.equal(jobKind(w, priest), CJ.Heal, 'the priest was called (no class test in the help rule)');
  for (let i = 0; i < 400; i++) w.step();
  assert.equal(ship.hp, max - 30, 'still damaged');
  assert.ok(jobKind(w, priest) !== CJ.Heal, 'the heal job gave up');
});

test('builders cannot repair ships: right-click is a go-to, the repair command needs a building', { skip }, () => {
  const { w, h } = pimmons();
  const { ship, land } = shipAtShore(w, h);
  const max = w.rules.get(ship.oid)!.hp;
  ship.hp = max - 40;
  const builder = w.spawnUnit(ship.oid >>> 16, 11, land[0], land[1], ship.town);
  w.schedule({ type: 'order', player: h, ids: [builder.id], target: ship.id });
  w.schedule({ type: 'building', player: h, id: ship.id, action: 'repair' });
  w.step(); w.step();
  assert.ok(jobKind(w, builder) !== 0x0c, 'no builder job on a ship');
  const town = w.economy.towns.find(t => t.id === ship.town)!;
  assert.equal(town.workerReqs.some(([, b]) => b === ship.id), false, 'no builder request for a ship');
  for (let i = 0; i < 2000; i++) w.step();
  assert.equal(ship.hp, max - 40, 'no repair, no regeneration, no healing while docked or idle');
});
