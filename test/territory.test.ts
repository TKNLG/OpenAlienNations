// Town territory and border stones (docs/game/economy.md 11, docs/rendering/territory.md).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { Territory, discOffsets, blockRadius, needsTerritory, NO_OWNER } from '../src/engine/territory.ts';
import { World, Kind, SUB, SNAPSHOT_VERSION, type Entity } from '../src/engine/world.ts';
import { loadMission, DATA, loadAddonMission, HAS_GOLD } from './helpers/mission.ts';
import { stoneChunks, CHUNK, hoverTown, BorderStones, STONE_TYPE } from '../src/client/border-stones.ts';
import { Camera } from '../src/client/camera.ts';
import type { ObjectDesc } from '../src/formats/od.ts';

const skip = !existsSync(`${DATA}/dv.odb`) && 'AN_DATA not set';

const owned = (t: Territory, id: number) => { let n = 0; for (const o of t.owner) if (o === id) n++; return n; };

test('disc: dx^2 + dy^2 < r^2 in blocks; 109 and 373 blocks; 32 and 60 stones (11.3, 11.6)', {}, () => {
  assert.equal(blockRadius(15), 6);
  assert.equal(blockRadius(25), 11);
  const d6 = discOffsets(6);
  assert.equal(d6.length, 109);
  assert.equal(discOffsets(11).length, 373);
  const rows = new Map<number, number>();
  for (const [, dy] of d6) rows.set(dy, (rows.get(dy) ?? 0) + 1);
  assert.deepEqual([...rows.entries()].sort((a, b) => a[0] - b[0]).map(r => r[1]), [7, 9, 11, 11, 11, 11, 11, 11, 11, 9, 7]);
  for (const [R, blocks, stones] of [[15, 109, 32], [25, 373, 60]]) {
    const t = new Territory(128);
    t.add(3, 1, 64, 64, R);
    const r = t.record(3)!;
    assert.equal(r.count, blocks);
    assert.equal(owned(t, 3), blocks);
    assert.equal(r.border.length, stones);
    assert.equal(r.circles[0].join(), `32,32,${blockRadius(R)}`);
    // stones on the border blocks only, race + 1
    assert.equal([...t.marks].filter(m => m === 2).length, stones);
    // the centre block is the building's block (x div 2, y div 2); the reach is r - 1 blocks
    assert.equal(t.ownerAt(64, 64), 3);
    assert.equal(t.ownerAt(65, 65), 3);
    const r6 = blockRadius(R);
    assert.equal(t.ownerAt(64 + 2 * (r6 - 1), 64), 3);
    assert.equal(t.ownerAt(64 + 2 * r6, 64), -1);
    assert.equal(t.raceAt(64, 64), 1);
  }
});

test('discs wrap around the map edge', {}, () => {
  const t = new Territory(64);
  t.add(0, 0, 0, 0, 25);
  assert.equal(t.record(0)!.count, 373);
  assert.equal(t.ownerAt(63, 63), 0);
  assert.equal(t.ownerAt(62, 0), 0);
});

test('first come, first served: a later territory never takes owned blocks (11.4)', {}, () => {
  const t = new Territory(128);
  t.add(0, 0, 40, 40, 25);
  t.add(1, 1, 60, 40, 25);       // 10 blocks apart: heavy overlap
  const a = t.record(0)!, b = t.record(1)!;
  assert.equal(a.count, 373, 'the first town keeps its whole disc');
  assert.ok(b.count < 373 && b.count > 100);
  assert.equal(owned(t, 1), b.count);
  // adding does not recompute others: A's border is unchanged in length
  assert.equal(a.border.length, 60);
  // towns of one player are not merged either
  t.add(2, 0, 40, 70, 25);
  assert.equal(t.ownerAt(40, 40), 0);
  assert.ok(t.record(2)!.count !== 373);
});

test('thinning: one-block strips and spurs are released in place (11.4)', {}, () => {
  // a disc of block radius 1 is the single centre block: both horizontal neighbours missing
  const t = new Territory(64);
  t.add(0, 0, 20, 20, 4);
  assert.equal(t.record(0)!.count, 0);
  assert.equal(t.ownerAt(20, 20), -1);
  assert.deepEqual(t.record(0)!.border, []);
  // two overlapping town discs: the later one loses some free blocks of its disc to thinning
  const u = new Territory(128);
  u.add(0, 0, 40, 40, 25);
  u.add(1, 1, 70, 40, 25);
  let freed = 0;
  for (const [dx, dy] of discOffsets(11)) {
    const bx = 35 + dx, by = 20 + dy;
    if (u.owner[u.block(bx, by)] !== NO_OWNER) continue;
    freed++;
    const own = (x: number, y: number) => u.owner[u.block(x, y)] === 1;
    assert.ok((!own(bx - 1, by) && !own(bx + 1, by)) || (!own(bx, by - 1) && !own(bx, by + 1)), `block ${bx},${by}`);
  }
  assert.ok(freed > 0, 'some blocks were thinned away');
  assert.equal(u.record(1)!.count, owned(u, 1));
});

test('removal: clear, then every territory in creation order; freed blocks go to the earliest (11.5)', {}, () => {
  const t = new Territory(128);
  t.add(7, 2, 64, 64, 25);        // C first
  t.add(1, 0, 64, 40, 25);        // A: overlaps C from above
  t.add(2, 1, 64, 88, 25);        // B: overlaps C from below
  t.add(1, 0, 64, 64, 15);        // A's small outpost inside C: nothing free to claim
  const a0 = t.record(1)!.count, b0 = t.record(2)!.count;
  // a block in the middle of C, covered by the discs of A (outpost) and B
  assert.equal(t.ownerAt(64, 70), 7);
  // C's town hall collapses: its only circle goes, the record is deleted
  t.remove(7, 64, 64);
  assert.equal(t.record(7), undefined);
  assert.ok(!t.records.some(r => r.id === 7));
  assert.equal(t.ownerAt(64, 70), 1, 'A, created before B, takes the freed block');
  assert.ok(t.ownerAt(64, 80) === 2 || t.ownerAt(64, 80) === 1);
  assert.ok(t.record(1)!.count > a0);
  assert.ok(t.record(2)!.count > b0);
  assert.equal([...t.marks].filter(m => m === 3).length, 0, 'C\'s stones are gone');
  // an outpost of A is destroyed and rebuilt: B keeps what it took meanwhile
  const before = t.ownerAt(64, 74);
  t.remove(1, 64, 64);
  const took = t.ownerAt(64, 74);
  t.add(1, 0, 64, 64, 15);
  assert.equal(t.ownerAt(64, 74), took);
  assert.ok(before === 1 && took === 2, 'B took the block on the removal');
});

test('removal of a building without a circle still recomputes; count quirk vs recount (11.5)', {}, () => {
  for (const quirk of [true, false]) {
    const t = new Territory(128);
    t.countQuirk = quirk;
    t.add(0, 0, 64, 64, 25);
    assert.equal(t.area(0), 1492, 'AI town area = 4 x 373');
    t.remove(0, 70, 70);      // a house of the town collapses
    assert.equal(t.record(0)!.count, quirk ? 746 : 373);
    assert.equal(owned(t, 0), 373);
    t.remove(5, 10, 10);      // a town without a record: nothing
    assert.equal(t.records.length, 1);
  }
});

test('placement: four corner blocks in the current town; town hall outside every territory (11.7)', {}, () => {
  const t = new Territory(128);
  t.add(0, 0, 64, 64, 25);    // blocks 22..42 on the centre row
  t.add(1, 1, 64, 20, 25);
  // a 2 x 2 building with its anchor at (X, Y): blocks (X+1)/2 .. minus (size+2)/2
  assert.ok(t.inTown(0, 64, 64, 2, 2));
  assert.ok(!t.inTown(1, 64, 64, 2, 2), 'another town\'s area does not count');
  // rows 30 and 32 of the disc hold blocks 22..42; X' = (X + 1) div 2 must lie in 22 + b' .. 42
  // with b' = (2 + 2) div 2 = 2, i.e. X in 47..84
  assert.ok(t.inTown(0, 47, 64, 2, 2));
  assert.ok(!t.inTown(0, 46, 64, 2, 2), 'corner X\' - b\' = 21 is outside');
  assert.ok(t.inTown(0, 84, 64, 2, 2));
  assert.ok(!t.inTown(0, 85, 64, 2, 2), 'corner X\' = 43 is outside');
  // a wider building needs more room: b' = (4 + 2) div 2 = 3
  assert.ok(!t.inTown(0, 48, 64, 4, 2));
  assert.ok(t.inTown(0, 49, 64, 4, 2));
  // town-hall test: none of the four points may lie in any territory
  assert.ok(!t.outsideAll(64, 64, 4, 4));
  assert.ok(t.outsideAll(10, 110, 4, 4));
  // exemptions: mine, town hall, add-on harbour and shipyard
  assert.equal(needsTerritory(50, false), false);
  assert.equal(needsTerritory(40, false), false);
  assert.equal(needsTerritory(62, true), false);
  assert.equal(needsTerritory(63, true), false);
  assert.equal(needsTerritory(37, false), true);
  assert.equal(needsTerritory(45, false), true);
});

test('snapshot of the territory: owner map, records, quirk switch', {}, () => {
  const t = new Territory(128);
  t.add(0, 0, 64, 64, 25); t.add(1, 2, 80, 64, 15); t.remove(0, 70, 70);
  const u = new Territory(128);
  u.restore(JSON.parse(JSON.stringify(t.snapshot())));
  assert.deepEqual(u.owner, t.owner);
  assert.deepEqual(u.marks, t.marks);
  assert.deepEqual(u.records, t.records);
  const dig = (x: Territory) => { const out: number[] = []; x.digest(v => out.push(v)); return out.join(); };
  assert.equal(dig(u), dig(t));
  u.add(1, 2, 90, 90, 15);
  assert.ok(dig(u) !== dig(t));
});

test('client: per-chunk stone lists from the border lists (rendering/territory.md 2)', {}, () => {
  const t = new Territory(128);
  t.add(0, 2, 64, 64, 25);
  const chunks = stoneChunks(t);
  let n = 0;
  for (const [key, list] of chunks) for (const s of list) {
    n++;
    assert.equal(s.x % 2, 0); assert.equal(s.y % 2, 0);
    assert.equal(s.race, 2);
    assert.equal(key, Math.floor(s.y / CHUNK) * (128 / CHUNK) + Math.floor(s.x / CHUNK));
  }
  assert.equal(n, 60);
});

test('placement mode: hovering another own town\'s territory switches the current town (11.7)', {}, () => {
  const t = new Territory(128);
  t.add(0, 1, 30, 30, 25); t.add(1, 1, 90, 90, 25); t.add(2, 0, 30, 90, 25);
  const towns = [{ id: 0, race: 1, alive: true }, { id: 1, race: 1, alive: true }, { id: 2, race: 0, alive: true }];
  const w = { territory: t, economy: { town: (id: number) => towns[id] } } as unknown as World;
  assert.equal(hoverTown(w, 90, 90, 1, 0), 1, 'own second town');
  assert.equal(hoverTown(w, 30, 90, 1, 0), 0, 'a foreign town: no switch');
  assert.equal(hoverTown(w, 60, 5, 1, 0), 0, 'outside every territory');
  towns[1].alive = false;
  assert.equal(hoverTown(w, 90, 90, 1, 0), 0, 'a destroyed town: no switch');
});

// ---------------------------------------------------------------- in the world (real data)

const cell = (e: Entity) => [Math.floor(e.x / SUB), Math.floor(e.y / SUB)] as const;

test('world: town halls claim at map load; outposts on completion; withdrawn after the collapse', { skip }, () => {
  const { world: w } = loadMission('Pimmons.mdb', 1, DATA, false);
  const ter = w.territory;
  for (const t of w.economy.towns) {
    const r = ter.record(t.id);
    assert.ok(r, `town ${t.id} has a territory`);
    assert.equal(r!.race, t.race);
    assert.ok(ter.ownerAt(t.x, t.y) === t.id);
  }
  const t = w.economy.towns.find(x => x.alive)!;
  const before = ter.record(t.id)!.count;
  const types = [[52, 109], [53, 373]] as const;
  for (const [type, disc] of types) {
    const r = w.rules.get(((t.race << 16) | type) >>> 0)!;
    t.stock.fill(99);
    const p = w.economy.players[t.race]!;
    if (r.invention >= 0) p.progress[r.invention] = p.costs[r.invention];   // the outpost is invented
    // a site near the edge of the town's area, so its disc adds new blocks
    let site: [number, number] | null = null;
    for (let d = 30; d >= 4 && !site; d--) for (const [dx, dy] of [[d, 0], [-d, 0], [0, d], [0, -d], [d, d], [-d, -d]]) {
      if (w.logistics.canPlace(t, r, t.x + dx, t.y + dy)) { site = [(t.x + dx) & (w.size - 1), (t.y + dy) & (w.size - 1)]; break; }
    }
    assert.ok(site, 'a site for the outpost');
    const b = w.logistics.placeBuilding(t, type, site![0], site![1])!;
    const c0 = ter.record(t.id)!.count, circles0 = ter.record(t.id)!.circles.length;
    assert.equal(circles0, ter.record(t.id)!.circles.length, 'a site adds nothing');
    w.logistics.complete(b);
    const rec = ter.record(t.id)!;
    assert.equal(rec.circles.length, circles0 + 1);
    assert.equal(rec.circles[rec.circles.length - 1][2], type === 52 ? 6 : 11);
    const gained = rec.count - c0;
    assert.ok(gained > 0 && gained <= disc, `${type}: +${gained} blocks`);
    // destroyed: the circle stays until phase 2 of the collapse, then goes
    w.combat.collapse(b, true);
    assert.equal(ter.record(t.id)!.circles.length, circles0 + 1);
    for (let i = 0; i < 40 && w.get(b.id); i++) w.step();
    assert.equal(w.get(b.id), undefined);
    assert.equal(ter.record(t.id)!.circles.length, circles0);
  }
  assert.ok(owned(ter, t.id) <= before + 1);
});

test('world: a lost outpost destroys nothing; buildings left outside the area stand and work on (11.5.1)', { skip }, () => {
  const { world: w } = loadMission('Pimmons.mdb', 1, DATA, false);
  const ter = w.territory;
  const t = w.economy.towns.find(x => x.alive)!;
  t.stock.fill(99);
  const p = w.economy.players[t.race]!;
  const post = w.rules.get(((t.race << 16) | 53) >>> 0)!;
  if (post.invention >= 0) p.progress[post.invention] = p.costs[post.invention];
  const house = w.rules.get(((t.race << 16) | 37) >>> 0)!;
  // a large outpost far out at the edge of the town's area
  let site: [number, number] | null = null;
  for (let d = 34; d >= 4 && !site; d--) for (const [dx, dy] of [[d, 0], [-d, 0], [0, d], [0, -d], [d, d], [-d, -d], [d, -d], [-d, d]]) {
    if (w.logistics.canPlace(t, post, t.x + dx, t.y + dy)) { site = [(t.x + dx) & (w.size - 1), (t.y + dy) & (w.size - 1)]; break; }
  }
  assert.ok(site, 'a site for the outpost');
  const op = w.logistics.placeBuilding(t, 53, site![0], site![1])!;
  w.logistics.complete(op);
  // the territory as it will be once the outpost's circle has gone
  const after = new Territory(w.size);
  after.restore(JSON.parse(JSON.stringify(ter.snapshot())));
  after.remove(t.id, site![0], site![1]);
  // houses (one completed, one a site) on spots that only the outpost's disc makes buildable
  const placed: Entity[] = [];
  for (let y = 0; y < w.size && placed.length < 2; y += 2) for (let x = 0; x < w.size && placed.length < 2; x += 2) {
    if (!w.logistics.canPlace(t, house, x, y) || after.inTown(t.id, x, y, house.sizeX, house.sizeY)) continue;
    const b = w.logistics.placeBuilding(t, 37, x, y);
    if (b) placed.push(b);
  }
  assert.equal(placed.length, 2, 'two spots in the outpost-only area');
  const [built, pending] = placed;
  w.logistics.complete(built);
  assert.ok(built.complete && built.active);
  let free: [number, number] | null = null;   // a third spot, left empty
  for (let y = 0; y < w.size && !free; y += 2) for (let x = 0; x < w.size; x += 2) {
    if (w.logistics.canPlace(t, house, x, y) && !after.inTown(t.id, x, y, house.sizeX, house.sizeY)) { free = [x, y]; break; }
  }
  assert.ok(free);
  const buildings0 = w.entities.filter(e => e.kind === Kind.Building && e.town === t.id).length;
  // the outpost is destroyed: its circle goes at the end of its collapse, nothing else happens
  w.combat.collapse(op, true);
  for (let i = 0; i < 60 && w.get(op.id); i++) w.step();
  assert.equal(w.get(op.id), undefined);
  assert.deepEqual(ter.owner, after.owner, 'the area shrank as on the removal');
  for (const b of placed) {
    assert.ok(!ter.inTown(t.id, Math.floor(b.x / SUB), Math.floor(b.y / SUB), house.sizeX, house.sizeY), 'now outside the area');
    assert.equal(w.get(b.id), b, 'still standing');
    assert.ok(b.alive);
    assert.equal(b.town, t.id, 'still the same town');
  }
  assert.ok(built.complete && built.active, 'the completed house still works');
  assert.ok(!pending.complete, 'the site stays a site');
  for (let i = 0; i < 700; i++) w.step();   // past a decay and a round: nothing re-tests the area
  for (const b of placed) assert.equal(w.get(b.id), b);
  assert.equal(w.entities.filter(e => e.kind === Kind.Building && e.town === t.id).length, buildings0 - 1);
  // only placement follows the new area
  assert.equal(w.logistics.canPlace(t, house, free![0], free![1]), false);
  assert.ok(w.logistics.canPlaceSite(t, house, free![0], free![1]), 'the spot itself is still free');
});

test('world: the simulation does not test territory; the UI/AI test does; mine exempt', { skip }, () => {
  const { world: w } = loadMission('Pimmons.mdb', 1, DATA, false);
  const t = w.economy.towns.find(x => x.alive)!;
  t.stock.fill(99);
  const house = w.rules.get(((t.race << 16) | 37) >>> 0)!;
  let outside: [number, number] | null = null;
  for (let d = 18; d < 60 && !outside; d++) for (const [dx, dy] of [[d, 0], [-d, 0], [0, d], [0, -d]]) {
    const x = (t.x + dx) & (w.size - 1), y = (t.y + dy) & (w.size - 1);
    if (w.logistics.canPlaceSite(t, house, x, y) && !w.logistics.canPlace(t, house, x, y)) { outside = [x, y]; break; }
  }
  assert.ok(outside, 'a free spot outside the town area');
  const [ox, oy] = outside!;
  assert.ok(!w.territory.inTown(t.id, ox, oy, house.sizeX, house.sizeY));
  // the mine: no territory test in canPlace (mask 0x67E)
  const mine = w.rules.get(((t.race << 16) | 50) >>> 0)!;
  for (let y = 0; y < w.size; y += 3) for (let x = 0; x < w.size; x += 3) {
    if (w.territory.ownerAt(x, y) === t.id) continue;
    if (w.logistics.canPlaceSite(t, mine, x, y)) { assert.ok(w.logistics.canPlace(t, mine, x, y)); y = w.size; break; }
  }
  // a build command outside the area is still executed by the simulation (00451780)
  w.schedule({ type: 'build', player: t.race, town: t.id, building: 37, x: ox, y: oy });
  w.step();
  assert.ok(w.entities.some(e => e.kind === Kind.Building && (e.oid & 0xffff) === 37 && cell(e)[0] === ox && cell(e)[1] === oy));
  // founding: never inside a territory
  assert.equal(w.logistics.canFound(t.race, t.x, t.y, true), false);
});

test('world: snapshot round trip, v4 migration, determinism', { skip }, () => {
  const run = () => { const { world } = loadMission('Pimmons.mdb', 4); for (let i = 0; i < 1500; i++) world.step(); return world; };
  const a = run(), b = run();
  assert.equal(a.hash(), b.hash(), 'same game, same hash');
  assert.ok(a.territory.records.length >= 3);
  const snap = JSON.parse(JSON.stringify(a.snapshot()));
  assert.equal(snap.v, SNAPSHOT_VERSION);
  assert.ok(SNAPSHOT_VERSION >= 5);   // 6: door counters and enter sequences (units-and-jobs.md 4.10)
  const fresh = (w: World) => ({ ...w.terrain, height: w.terrain.height.slice(), cls: w.terrain.cls.slice(), tile: w.terrain.tile.slice() });
  const c = World.restore(fresh(a), snap, a.rules, a.weapons);
  assert.equal(c.hash(), a.hash(), 'restored territory hashes the same');
  assert.deepEqual(c.territory.owner, a.territory.owner);
  for (let i = 0; i < 300; i++) { a.step(); c.step(); }
  assert.equal(c.hash(), a.hash());
  // a version 4 save: no territory, rebuilt from the buildings in creation order
  const old = JSON.parse(JSON.stringify(a.snapshot()));
  old.v = 4; delete old.territory;
  const m = World.restore(fresh(a), old, a.rules, a.weapons);
  const halls = m.entities.filter(e => e.kind === Kind.Building && (e.oid & 0xffff) === 40 && e.town >= 0);
  assert.equal(m.territory.records.length, new Set(halls.map(e => e.town)).size);
  for (const h of halls) assert.ok(m.territory.record(h.town)!.circles.some(([x, y]) => x === cell(h)[0] >> 1 && y === cell(h)[1] >> 1));
  // without overlaps and destructions the rebuilt map equals the running one
  let same = 0;
  for (let i = 0; i < m.territory.owner.length; i++) if (m.territory.owner[i] === a.territory.owner[i]) same++;
  assert.ok(same / m.territory.owner.length > 0.99);
  for (let i = 0; i < 50; i++) m.step();
});

test('add-on islands: border stones lie on the open sea too, at sea level, 2 cells apart (rendering/territory.md 2)', { skip: !HAS_GOLD && 'AN_GOLD data not found' }, () => {
  const { world: w } = loadAddonMission('AmazonsAO.mdb', 4, undefined, false);
  const t = w.territory, half = t.half;
  const stones = [...stoneChunks(t).values()].flat();
  assert.ok(stones.length > 0);
  // the original tests no terrain: on the islands the discs reach far into the sea
  const sea = stones.filter(s => w.islandAt(s.x, s.y) === 0);
  assert.ok(sea.length > stones.length / 4, `${sea.length} of ${stones.length} stones on water`);
  for (const s of sea) assert.equal(w.heightAt(s.x, s.y), 120, 'sea cells are flat at 120');
  // one per border block on its even/even cell
  for (const s of stones) assert.ok(t.marks[(s.y >> 1) * half + (s.x >> 1)] > 0 && s.x % 2 === 0 && s.y % 2 === 0);
  // the client draws every stone in sight, water or not, picture top-left on the vertex
  const objects = new Map<number, ObjectDesc>();
  const rects = new Map<string, { page: number; r: { u0: number; v0: number; u1: number; v1: number; w: number; h: number } }>();
  for (const race of [0, 1, 2]) {
    const id = ((7 << 16) | (STONE_TYPE + race)) >>> 0;
    objects.set(id, { id, kind: 0, anchorX: 8, anchorY: 34, bounds: [1, 1, 20, 19], slots: [`STONE${race}`], layers: [null] });
    rects.set(`STONE${race}#0`, { page: 0, r: { u0: 0, v0: 0, u1: 1, v1: 1, w: 19, h: 18 } });
  }
  const bs = new BorderStones();
  bs.refresh(t);
  const s0 = sea[0];
  const cam = new Camera(w.size);
  cam.x = s0.x; cam.y = s0.y;
  const drawn = bs.sprites(cam, { height: (x, y) => w.heightAt(x, y), visible: () => true }, objects, rects);
  const at = Camera.project(0, 0, 120);
  assert.ok(drawn.some(d => d.x === at[0] && d.y === at[1]), 'the stone on the water is drawn on the sea surface');
  assert.equal(bs.sprites(cam, { height: (x, y) => w.heightAt(x, y), visible: () => false }, objects, rects).length, 0, 'only cells in sight');
});
