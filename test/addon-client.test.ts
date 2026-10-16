// Client rules of the add-on: side-panel predicates, passengers by type, right-click intent
// (cursor), market pages of the harbour and the fog of passengers / foreign harbours.
// Spec: docs/architecture/integration-addon-gameplay.md 3..5. Needs the Gold data (AN_GOLD).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GOLD, HAS_GOLD, dataReader, rulesOf } from './helpers/mission.ts';
import { parseMdb, parseDvmFile, dvmLayout } from '../src/formats/mission.ts';
import { addonTerrainFromStored } from '../src/world/addon-terrain.ts';
import { World, SUB, type Entity } from '../src/engine/world.ts';
import { isShip, isTransport, isTrader, isMarketLike, canPatrol, hasHome, passengerTypes, orderIntent, capacity } from '../src/client/addon-ui.ts';
import { marketPagesAllowed } from '../src/client/hud-pages-trade.ts';
import { Vision } from '../src/client/vision.ts';

const skip = !HAS_GOLD && 'AN_GOLD data not found';
const cell = (e: Entity): [number, number] => [Math.floor(e.x / SUB), Math.floor(e.y / SUB)];
const type = (e: Entity) => e.oid & 0xffff;

function aoWorld(mdb: string, order: number) {
  const read = dataReader(GOLD);
  const m = parseMdb(read(mdb)!).find(x => x.order === order)!;
  const rules = rulesOf(GOLD, true);
  const file = parseDvmFile(read(m.mapFile)!, dvmLayout(m));
  const world = new World(addonTerrainFromStored(file.terrain!), file.objects, rules.rules, {
    races: m.races, costs: rules.inventions.map(l => l.map(i => i.cost)), goals: m.goals, weapons: rules.weapons,
    orders: file.extras.orders, lists: file.extras.lists, ai: false,
  });
  return { world, mission: m };
}

test('panel predicates: transports, traders, market-like buildings, patrol, no home for ships', { skip }, () => {
  const { world: w } = aoWorld('SajikisAO.mdb', 2);
  const ships = w.entities.filter(e => isShip(w, e));
  assert.ok(ships.length > 0);
  for (const s of ships) {
    assert.equal(isTransport(w, s), type(s) === 67);
    assert.equal(isTrader(w, s), type(s) === 67, 'flag 0x40 only on transports');
    assert.equal(canPatrol(w, s), type(s) === 65 || type(s) === 66);
    assert.equal(hasHome(w, s), false);
    assert.equal(capacity(w, s), type(s) === 67 ? 5 : 0);
  }
  const land = w.entities.find(e => e.kind === 0 && !isShip(w, e))!;
  assert.equal(hasHome(w, land), true);
  assert.equal(capacity(w, land), 0);
  const harbour = w.entities.find(e => e.kind === 1 && type(e) === 62)!;
  const yard = w.entities.find(e => e.kind === 1 && type(e) === 63)!;
  assert.equal(isMarketLike(w, harbour), true);
  assert.equal(isMarketLike(w, yard), false);
  // the own finished harbour opens VERKAUF / EINKAUF like a market
  assert.equal(marketPagesAllowed(w, harbour.owner, harbour), harbour.complete);
  // a merchant of any race is a trader
  for (const r of [0, 1, 2]) assert.ok(isTrader(w, { kind: 0, oid: (r << 16) | 28 } as Entity));
});

test('passengers by type in boarding order (AmazonsAO 4 cargo)', { skip }, () => {
  const { world: w } = aoWorld('AmazonsAO.mdb', 4);
  const ship = w.entities.find(e => isTransport(w, e) && e.passengers.length === 3)!;
  assert.ok(ship);
  const rows = passengerTypes(w, ship);
  assert.equal(rows.reduce((n, r) => n + r.count, 0), 3);
  assert.equal(rows[0].oid, w.get(ship.passengers[0])!.oid, 'first passenger first');
  for (const r of rows) assert.equal(r.count, ship.passengers.filter(id => w.get(id)!.oid === r.oid).length);
});

test('right-click intent: board, fish, attack ships, move', { skip }, () => {
  const { world: w, mission: m } = aoWorld('SajikisAO.mdb', 2);
  const h = m.humanRace;
  const ship = w.entities.find(e => isTransport(w, e) && e.owner === h)!;
  const porter = w.entities.find(e => e.kind === 0 && e.owner === h && type(e) === 9 && e.inside < 0)!;
  // own land units on an own transport with room: board
  assert.equal(orderIntent(w, h, [porter], ship), 'board');
  assert.equal(orderIntent(w, h, [porter], null), 'move');
  // a full ship: nothing to board (the engine would refuse), ships cannot board ships
  const saved = ship.passengers;
  ship.passengers = [1, 2, 3, 4, 5];
  assert.equal(orderIntent(w, h, [porter], ship), 'move');
  ship.passengers = saved;
  const other = w.entities.find(e => isTransport(w, e) && e.owner === h && e !== ship)!;
  assert.equal(orderIntent(w, h, [other], ship), 'move');
  // nothing own selected: no intent
  const enemyShip = w.entities.find(e => isShip(w, e) && e.owner !== h)!;
  assert.equal(orderIntent(w, h, [enemyShip], ship), 'none');
  // a warship on a hostile ship: attack (as for land targets)
  const fish = w.entities.find(e => e.kind === 2 && type(e) >= 41 && type(e) <= 45)!;
  const boat = w.spawnUnit(h, 64, ...cell(ship), ship.town);
  assert.ok(isShip(w, boat), 'the spawned fishing boat is a ship');
  assert.equal(orderIntent(w, h, [boat], fish), 'harvest', 'fishing boat on a fish');
  assert.equal(orderIntent(w, h, [ship], fish), 'move', 'a transport just sails there');
  assert.equal(orderIntent(w, h, [porter], fish), 'move', 'a porter cannot fish');
  const war = w.spawnUnit(h, 65, ...cell(ship), ship.town);
  assert.equal(orderIntent(w, h, [war], enemyShip), 'attack');
  assert.equal(orderIntent(w, h, [porter, war], enemyShip), 'attack', 'the strongest intent wins');
  // passengers cannot be targeted
  const p = w.entities.find(e => e.kind === 0 && e.inside >= 0 && isShip(w, w.get(e.inside)!));
  if (p) assert.equal(orderIntent(w, h, [war], p), 'move');
});

test('fog: passengers see nothing, ships see their radius, a foreign harbour at peace radius 6', { skip }, () => {
  const { world: w, mission: m } = aoWorld('AmazonsAO.mdb', 3);
  const h = m.humanRace;
  const foreign = w.entities.find(e => e.kind === 1 && type(e) === 62 && e.owner !== h && e.active)!;
  assert.ok(foreign, 'a foreign harbour on the map');
  const r = w.rules.get(foreign.oid)!;
  assert.equal(r.radius, 6);
  const v = new Vision(w.size, w.bits);
  // remove own sight near the harbour: only own objects far away
  const [fx, fy] = cell(foreign);
  const ownNear = w.entities.some(e => e.owner === h && w.logistics.dist(...cell(e), fx, fy) < 20);
  w.combat.setRelation(h, foreign.owner, 1);
  v.update(w, h, true);
  if (!ownNear) assert.equal(v.cellVisible(fx, fy), false, 'at war: not seen');
  w.combat.setRelation(h, foreign.owner, 3);
  v.update(w, h, true);
  assert.equal(v.cellVisible(fx, fy), true, 'at peace: the harbour gives vision');
  assert.equal(v.cellVisible(fx + 5, fy), true);
  // a ship sees its record radius; its passengers add nothing
  const { world: w2, mission: m2 } = aoWorld('AmazonsAO.mdb', 4);
  const ship = w2.entities.find(e => isTransport(w2, e) && e.owner === m2.humanRace && e.passengers.length)!;
  const v2 = new Vision(w2.size, w2.bits);
  v2.update(w2, m2.humanRace, true);
  const [sx, sy] = cell(ship);
  const rad = w2.rules.get(ship.oid)!.radius;
  assert.equal(v2.cellVisible(sx + rad - 1, sy), true);
  const before = v2.visible.reduce((n, x) => n + x, 0);
  for (const id of ship.passengers) w2.get(id)!.x += 40 * SUB;   // passengers elsewhere: still no vision
  v2.update(w2, m2.humanRace, true);
  assert.equal(v2.visible.reduce((n, x) => n + x, 0), before);
});
