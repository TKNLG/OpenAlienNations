// Economy and logistics on a real mission (needs AN_DATA = the game's Data folder).
// Checks the handbook's worked example: town hall + school, 4 residents -> +16 money per round.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { loadMission, DATA } from './helpers/mission.ts';
import { Kind, World } from '../src/engine/world.ts';
import { ROUND } from '../src/engine/economy.ts';

const skip = !existsSync(`${DATA}/dv.odb`) && 'AN_DATA not set';

test('town founding, round settlement and construction', { skip }, () => {
  const { world: w, mission: m } = loadMission('Pimmons.mdb', 0);
  const me = m.humanRace, eco = w.economy;
  const t = eco.towns.find(x => x.race === me)!;
  // founder inside the town hall, plus builder and two porters from the town hall's activation
  const types = w.entities.filter(e => e.kind === Kind.Unit && e.town === t.id).map(e => e.oid & 0xffff).sort((a, b) => a - b);
  assert.deepEqual(types, [9, 9, 10, 11]);
  assert.equal(t.population, 4);
  assert.equal(t.capacity, 25);
  const start = eco.players[me]!.money;
  for (let i = 0; i < ROUND + 1; i++) w.step();
  assert.equal(eco.players[me]!.money, start + 4 * 7 - 7, 'tax 28 - town hall upkeep 7');

  // a school next to the town hall: porters bring 2 wood + 4 stone, the builder builds it
  const r = w.rules.get((me << 16) | 55)!;
  let spot: [number, number] | null = null;
  for (let rad = 3; rad < 15 && !spot; rad++)
    for (let dy = -rad; dy <= rad && !spot; dy++)
      for (let dx = -rad; dx <= rad && !spot; dx++)
        if (Math.max(Math.abs(dx), Math.abs(dy)) === rad && w.logistics.canPlace(t, r, t.x + dx, t.y + dy)) spot = [t.x + dx, t.y + dy];
  if (!spot) throw new Error('no free place for the school');
  const wood = t.stock[1], stone = t.stock[2];
  w.schedule({ type: 'build', player: me, town: t.id, building: 55, x: spot[0], y: spot[1] });
  let school;
  for (let i = 0; i < 3000; i++) {
    w.step();
    school = w.entities.find(e => (e.oid & 0xffff) === 55 && e.owner === me);
    if (school?.complete) break;
  }
  if (!school?.complete) throw new Error('school not completed');
  assert.equal(school.hp, r.hp);
  assert.equal(t.stock[1], wood - 2);
  assert.equal(t.stock[2], stone - 4);
  assert.equal(t.overheads, 12);

  // the next settlement pays 28 - 12 = +16
  const before = eco.players[me]!.money;
  for (let i = 0; i < ROUND; i++) w.step();
  assert.equal(eco.players[me]!.money, before + 16);

  // training: a builder at the school costs 30 and consumes a porter (units-and-jobs.md 9)
  const porters = () => w.entities.filter(e => e.town === t.id && (e.oid & 0xffff) === 9).length;
  const builders = () => w.entities.filter(e => e.town === t.id && (e.oid & 0xffff) === 11).length;
  const p0 = porters(), b0 = builders(), m0 = eco.players[me]!.money;
  w.schedule({ type: 'train', player: me, building: school.id, unit: 11 });
  w.step();
  assert.equal(eco.players[me]!.money, m0 - 30);
  for (let i = 0; i < 900 && builders() === b0; i++) w.step();
  assert.equal(builders(), b0 + 1, 'builder trained');
  assert.equal(porters(), p0 - 1, 'porter consumed');
  assert.equal(school.queue.length, 0);

  // save and restore mid-game continues identically
  const snap = w.snapshot();
  const tr = w.terrain;   // the copy needs its own ground arrays (foundations and paths edit them)
  const copy = World.restore({ ...tr, height: tr.height.slice(), cls: tr.cls.slice(), tile: tr.tile.slice() }, JSON.parse(JSON.stringify(snap)), w.rules);
  for (let i = 0; i < 1500; i++) { w.step(); copy.step(); }
  assert.equal(copy.hash(), w.hash());
});

test('gathering: woodcutter fells a tree, hunter brings an animal home', { skip }, () => {
  const { world: w, mission: m } = loadMission('Pimmons.mdb', 0);
  const me = m.humanRace, t = w.economy.towns.find(x => x.race === me)!;
  const nearest = (cls: number) => w.entities
    .filter(e => e.kind === Kind.Nature && w.rules.get(e.oid)?.cls === cls && (cls !== 7 || e.alive))
    .sort((a, b) => w.logistics.dist(a.x >> 8, a.y >> 8, t.x, t.y) - w.logistics.dist(b.x >> 8, b.y >> 8, t.x, t.y))[0];
  const add = (type: number) => { const u = w.spawnUnit(me, type, t.x + 2, t.y + 3, t.id); w.economy.joinTown(u, t); return u; };

  const tree = nearest(8);
  const woodcutter = add(19);
  const wood0 = t.stock[1], amount = tree.amount;
  w.schedule({ type: 'order', player: me, ids: [woodcutter.id], target: tree.id });
  for (let i = 0; i < 6000 && t.stock[1] < wood0 + amount; i++) w.step();
  assert.equal(t.stock[1], wood0 + amount, "all the tree's wood delivered");
  assert.equal(w.get(tree.id), undefined, 'felled tree removed');
  assert.equal(w.respawns.length > 0, true, 'tree filed for respawn');

  const animal = nearest(7);
  const hunter = add(17);
  const food0 = t.stock[4];
  w.schedule({ type: 'order', player: me, ids: [hunter.id], target: animal.id });
  for (let i = 0; i < 6000 && t.stock[4] <= food0; i++) w.step();
  assert.equal(animal.alive, false, 'animal killed');
  assert.ok(t.stock[4] > food0, 'food delivered');
});

test('crop conversion ring: a standing town setting; deliveries convert, UMWANDELN converts the ring share now (economy.md 7)', { skip }, () => {
  const { world: w, mission: m } = loadMission('Pimmons.mdb', 0, DATA, false);
  const me = m.humanRace, eco = w.economy, t = eco.towns.find(x => x.race === me)!;
  const CROP = 0, FOOD = 4;
  t.stock[CROP] = 0; t.stock[FOOD] = 0;
  assert.equal(t.cropPct, 0, 'a new town converts nothing');
  eco.addGood(t, CROP, 3);
  assert.deepEqual([t.stock[CROP], t.stock[FOOD]], [3, 0], 'ring off: a crop delivery is stored as it is');
  // moving the ring sends its value (0041b7a0 -> 00452b40): divisor 100 / 50 = 2, accumulator 1
  w.schedule({ type: 'convert', player: me, town: t.id, percent: 50 });
  w.step(); w.step();
  assert.deepEqual([t.cropPct, t.cropDiv, t.cropAcc], [50, 2, 1]);
  // 3 crops: accumulator 4, n = trunc(min(4 / 2, space)) = 2 -> 4 food, 1 crop to the stock
  const food0 = t.foodNow;
  eco.addGood(t, CROP, 3);
  assert.deepEqual([t.stock[CROP], t.stock[FOOD], t.cropAcc], [4, 4, 0]);
  assert.equal(t.foodNow - food0, 4, 'converted food counts as produced this round');
  eco.addGood(t, CROP, 1);
  assert.deepEqual([t.stock[CROP], t.stock[FOOD], t.cropAcc], [5, 4, 1], 'below one divisor: stored, accumulated');
  // a full food store converts nothing; the backlog is converted once there is room, even beyond
  // the delivery itself (taken from the crop stock)
  t.stock[FOOD] = t.capacity;
  for (let i = 0; i < 4; i++) eco.addGood(t, CROP, 1);
  assert.deepEqual([t.stock[CROP], t.cropAcc], [9, 5]);
  t.stock[FOOD] = t.capacity - 6;
  eco.addGood(t, CROP, 1);
  // accumulator 6, n = trunc(min(3, 6)) = 3: food + 6, crop + 1 - 3
  assert.deepEqual([t.stock[CROP], t.stock[FOOD], t.cropAcc], [7, t.capacity, 0]);
  // UMWANDELN (value 0xFF): n = min(trunc(7 x 50 / 100), trunc(food space / 2)) = min(3, 3)
  t.stock[FOOD] = t.capacity - 7;
  w.schedule({ type: 'convert', player: me, town: t.id, percent: 255 });
  w.step(); w.step();
  assert.deepEqual([t.stock[CROP], t.stock[FOOD], t.cropPct], [4, t.capacity - 1, 50], 'the ring stays where it was');
  // off again
  w.schedule({ type: 'convert', player: me, town: t.id, percent: 0 });
  w.step(); w.step();
  assert.deepEqual([t.cropPct, t.cropDiv, t.cropAcc], [0, 0, 0]);
  // a version-11 save (no ring) restores with the ring off
  w.schedule({ type: 'convert', player: me, town: t.id, percent: 25 });
  w.step(); w.step();
  const snap = w.snapshot();
  const tr = w.terrain;
  const terrain = () => ({ ...tr, height: tr.height.slice(), cls: tr.cls.slice(), tile: tr.tile.slice() });
  const r = World.restore(terrain(), snap, w.rules, w.weapons);
  assert.equal(r.economy.towns.find(x => x.id === t.id)!.cropPct, 25, 'the ring is saved');
  const old = JSON.parse(JSON.stringify(snap));
  old.v = 11;
  for (const x of old.economy.towns) { delete x.cropPct; delete x.cropDiv; delete x.cropAcc; }
  const o = World.restore(terrain(), old, w.rules, w.weapons).economy.towns.find(x => x.id === t.id)!;
  assert.deepEqual([o.cropPct, o.cropDiv, o.cropAcc], [0, 0, 0]);
});
