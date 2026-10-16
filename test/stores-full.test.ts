// Storage capacity and the advisor line 17 "Deine Lager sind voll!" (economy.md 7,
// side-panel.md 1.1.6, units-and-jobs.md 4.4 / 5.5). Needs AN_DATA.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { loadMission, DATA } from './helpers/mission.ts';
import { Kind, SUB, TICK_MS, type World, type Entity } from '../src/engine/world.ts';
import { Good, ADVISOR_REPEAT_MS, type Town } from '../src/engine/economy.ts';

const skip = !existsSync(`${DATA}/dv.odb`) && 'AN_DATA not set';
const STONEMASON = 27, STONE = 29, STONE_CLASS = 13, WAREHOUSE = 41, MARKET = 48, PORTER = 9;
const FULL = 17, IRON = 3, WEAPONS = 5;
const cell = (e: Entity): [number, number] => [Math.floor(e.x / SUB), Math.floor(e.y / SUB)];

/** a completed building of the town on a free spot near the town hall */
function place(w: World, t: Town, type: number): Entity {
  const r = w.rules.get(((t.race << 16) | type) >>> 0)!;
  const sx = Math.max(1, r.sizeX), sy = Math.max(1, r.sizeY);
  const free = (x: number, y: number) => {
    for (let dy = -1; dy <= sy; dy++) for (let dx = -1; dx <= sx; dx++) if (w.occupied(x - sx + 1 + dx, y - sy + 1 + dy)) return false;
    return true;
  };
  for (let rad = 4; rad < 40; rad++)
    for (let dy = -rad; dy <= rad; dy++)
      for (let dx = -rad; dx <= rad; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== rad || !free(t.x + dx, t.y + dy)) continue;
        const b = w.spawn({ cls: 1, group: t.race, type, owner: t.race, x: t.x + dx, y: t.y + dy, z: 0 });
        b.town = t.id; b.complete = true; b.hp = r.hp;
        return b;
      }
  throw new Error('no free place');
}

/** a free square near the town hall with no stone near it */
function clearing(w: World, tx: number, ty: number): [number, number] {
  const stones = w.entities.filter(e => e.kind === Kind.Nature && w.rules.get(e.oid)?.cls === STONE_CLASS).map(cell);
  for (let r = 8; r < 40; r++)
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = tx + dx, y = ty + dy;
        if (stones.some(([sx, sy]) => Math.max(Math.abs(sx - x), Math.abs(sy - y)) <= 14)) continue;
        let ok = true;
        for (let j = -4; j <= 4 && ok; j++) for (let i = -4; i <= 4 && ok; i++) if (w.occupied(x + i, y + j)) ok = false;
        if (ok) return [x, y];
      }
  throw new Error('no clearing');
}

/** Pimmons mission 0, passive computers: the human town with `warehouses` active warehouses */
function town(warehouses: number) {
  const { world: w, mission: m } = loadMission('Pimmons.mdb', 0, DATA, false);
  const me = m.humanRace, t = w.economy.towns.find(x => x.race === me)!;
  const stores: Entity[] = [];
  for (let k = 0; k < warehouses; k++) { const b = place(w, t, WAREHOUSE); w.economy.activate(b); stores.push(b); }
  w.events.length = 0;
  return { w, me, t, stores };
}
const said = (w: World, race: number, id = FULL) => w.events.filter(e => e.race === race && e.mentor === id).length;

/** a stonemason harvests a 3-stone rock next to the town and delivers it to the nearest store */
function harvestStone(w: World, me: number, t: Town, amount = 3): void {
  const [x, y] = clearing(w, t.x, t.y);
  const s = w.spawn({ cls: 2, group: 6, type: STONE, owner: 0, x, y, z: 0 });
  s.amount = amount;
  const u = w.spawnUnit(me, STONEMASON, x - 2, y + 1, t.id);
  w.economy.joinTown(u, t);
  w.schedule({ type: 'order', player: me, ids: [u.id], target: s.id });
  for (let i = 0; i < 8000; i++) { w.step(); if (i > 5 && !u.job) break; }
  assert.equal(w.get(s.id), undefined, 'the stone is used up');
}

test('capacity: 25 per active store and per good type (hall + 5 warehouses = 150 / Typ)', { skip }, () => {
  const { w, t } = town(5);
  assert.equal(t.capacity, 150);
  const before = [...t.stock];
  for (let g = 0; g < 9; g++) {
    t.stock[g] = 140;
    assert.equal(w.economy.space(t, g), 10, `good ${g}: the room is per good`);
    assert.equal(w.economy.addGood(t, g, 20), 10, 'clamped to the capacity');
    assert.equal(t.stock[g], 150);
  }
  t.stock.splice(0, 9, ...before);
});

test('line 17: several warehouses, stocks above the base 25 but below the capacity: no line', { skip }, () => {
  const { w, me, t } = town(5);
  // the player's report: wood 16, stone 40, iron 2, weapons 25, food 8
  t.stock[Good.Wood] = 16; t.stock[Good.Stone] = 40; t.stock[IRON] = 2; t.stock[WEAPONS] = 25; t.stock[Good.Food] = 8;
  harvestStone(w, me, t);
  assert.equal(t.stock[Good.Stone], 43, 'all three stones stored');
  assert.equal(said(w, me), 0, 'no "stores full" below the real capacity');
});

test('line 17: said when the carried good has reached the capacity (per good; once per 120 s; entry allowed)', { skip }, () => {
  const { w, me, t } = town(2);
  assert.equal(t.capacity, 75);
  // another good full does not count
  t.stock[Good.Wood] = 75; t.stock[Good.Stone] = 10;
  harvestStone(w, me, t, 2);
  assert.equal(said(w, me), 0, 'wood full, a stone delivery: no line');
  assert.equal(t.stock[Good.Stone], 12);
  // the delivered good full: the line, at the door, queued; the load is still dropped (lost)
  t.stock[Good.Stone] = 75;
  harvestStone(w, me, t, 2);
  const e = w.events.filter(x => x.mentor === FULL);
  assert.equal(e.length, 1, 'once: the second trip falls within the 120 s interval');
  assert.equal(e[0].race, me);
  assert.equal(e[0].queue, true);
  assert.equal(t.stock[Good.Stone], 75, 'clamped, the excess is lost');
  // 120 s later it may come again
  w.tick += ADVISOR_REPEAT_MS / TICK_MS;
  harvestStone(w, me, t, 1);
  assert.equal(said(w, me), 2);
});

test('line 17: a harvested crop converted to food on delivery says nothing (the old false "stores full")', { skip }, () => {
  const { w, me, t } = town(1);
  // the conversion ring at 100 %: every delivered crop becomes 2 food, the crop stock stays 0
  w.schedule({ type: 'convert', player: me, town: t.id, percent: 100 });
  w.step();
  t.stock[Good.Crop] = 0; t.stock[Good.Food] = 8;
  // a ripe crop of the town's race (cocoa / mushrooms / maggots: the last growth stage)
  let x = t.x + 6;
  const y = t.y + 6;
  while (w.occupied(x, y)) x++;
  const crop = w.spawn({ cls: 2, group: 6, type: 20 + 4 * me, owner: 0, x, y, z: 0 });
  crop.amount = 1;
  const u = w.spawnUnit(me, PORTER, x - 2, y, t.id);
  w.economy.joinTown(u, t);
  w.events.length = 0;
  w.schedule({ type: 'order', player: me, ids: [u.id], target: crop.id });
  for (let i = 0; i < 3000; i++) { w.step(); if (i > 5 && !u.job) break; }
  assert.equal(w.get(crop.id), undefined, 'harvested');
  assert.deepEqual([t.stock[Good.Crop], t.stock[Good.Food]], [0, 10], 'converted: 1 crop -> 2 food');
  assert.equal(said(w, me), 0, 'no "stores full": the room was there');
});

test('line 17 door test: per good, store vs local stock, construction sites and other races never', { skip }, () => {
  const { w, me, t } = town(1);
  const hall = w.get(t.hall)!;
  const u = w.spawnUnit(me, PORTER, t.x + 2, t.y + 3, t.id);
  w.economy.joinTown(u, t);
  u.carryGood = IRON; u.carryAmount = 1;
  t.stock[IRON] = t.capacity - 1;
  w.logistics.storesFullAtDoor(u, hall, true);
  assert.equal(said(w, me), 0, 'one unit of room left');
  t.stock[IRON] = t.capacity;
  w.logistics.storesFullAtDoor(u, hall, false);
  assert.equal(said(w, me), 0, 'not delivering: no line');
  u.carryAmount = 0;
  w.logistics.storesFullAtDoor(u, hall, true);
  assert.equal(said(w, me), 0, 'carrying nothing: no line');
  u.carryAmount = 1;
  const site = place(w, t, WAREHOUSE);
  site.complete = false;
  w.logistics.storesFullAtDoor(u, site, true);
  assert.equal(said(w, me), 0, 'a construction site never says it');
  const other = w.spawnUnit((me + 1) % 3, PORTER, t.x + 3, t.y + 3, -1);
  other.carryGood = IRON; other.carryAmount = 1;
  w.logistics.storesFullAtDoor(other, hall, true);
  assert.equal(w.events.filter(e => e.mentor === FULL).length, 0, 'another race: never');
  // a producer: its own local stock against its +0x120 (10)
  const armoury = place(w, t, 61);
  u.carryGood = Good.Wood;
  armoury.local[Good.Wood] = 9;
  w.logistics.storesFullAtDoor(u, armoury, true);
  assert.equal(said(w, me), 0, 'local room left (the town stock does not matter)');
  armoury.local[Good.Wood] = 10;
  w.logistics.storesFullAtDoor(u, armoury, true);
  assert.equal(said(w, me), 1, 'local stock at the producer\'s capacity');
  w.tick += ADVISOR_REPEAT_MS / TICK_MS;
  u.carryGood = IRON;
  w.logistics.storesFullAtDoor(u, hall, true);
  assert.equal(said(w, me), 2, 'the town stock of the carried good at the capacity');
});

test('porter at the source with no room: line 17 and the leftover unit is lost (5.5 step 1)', { skip }, () => {
  const { w, me, t } = town(0);
  const hall = w.get(t.hall)!;
  const u = w.spawnUnit(me, PORTER, t.x + 2, t.y + 3, t.id);
  w.economy.joinTown(u, t);
  u.carryGood = Good.Wood; u.carryAmount = 1;
  t.stock[Good.Wood] = t.capacity;
  t.stock[Good.Stone] = 5;
  // transport data: phase, destination, source, requester, good to fetch (stone), output (none)
  const d = [0, -1, hall.id, -1, Good.Stone, -1, 0, 0];
  (w.logistics as unknown as { atSource(u: Entity, src: Entity, d: number[]): void }).atSource(u, hall, d);
  assert.equal(said(w, me), 1);
  assert.equal(t.stock[Good.Wood], t.capacity);
  assert.deepEqual([u.carryGood, u.carryAmount], [Good.Stone, 1], 'the wood is gone, one stone picked up');
  assert.equal(t.stock[Good.Stone], 4);
});

test('losing a store: stocks x W/(W+1) with the dying warehouse counted; a market scales nothing', { skip }, () => {
  {
    const { w, t, stores } = town(2);
    t.stock[Good.Wood] = 60; t.stock[Good.Stone] = 7;
    w.economy.deactivate(stores[0]);
    assert.equal(t.capacity, 50);
    assert.deepEqual([t.stock[Good.Wood], t.stock[Good.Stone]], [40, 4], 'one of two warehouses: 2/3 kept');
  }
  {
    const { w, t, stores } = town(1);
    t.stock[Good.Wood] = 40;
    w.economy.deactivate(stores[0]);
    assert.equal(t.capacity, 25);
    assert.equal(t.stock[Good.Wood], 20, 'the only warehouse: 1/2 kept');
  }
  {
    const { w, t } = town(0);
    const m = place(w, t, MARKET);
    w.economy.activate(m);
    assert.equal(t.capacity, 25, 'a market adds no capacity');
    t.stock[Good.Wood] = 20;
    w.economy.deactivate(m);
    assert.equal(t.stock[Good.Wood], 20, 'a market (+0x120 = 0) scales nothing');
  }
});
