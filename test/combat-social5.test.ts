// Fidelity batch 5 (combat and social jobs): the line of fire's lagging stepper, the area scan
// through footprint cells, the priest healing himself, the patrol commands, map order records in
// file order, the scout job, the order's selection walk.
// Spec: docs/game/combat.md 3.4, 8.2, 8.3, 9.5, 13, 15; docs/game/units-and-jobs.md 3.2;
// docs/formats/dvm.md "Orders". Synthetic worlds, no game data needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, SUB, type Entity } from '../src/engine/world.ts';
import { CJ } from '../src/engine/combat.ts';
import { AiJob } from '../src/engine/ai-defs.ts';
import { MsRand } from '../src/world/rand.ts';
import type { ObjectRule } from '../src/formats/odb.ts';
import type { Weapon } from '../src/formats/wdb.ts';
import type { Terrain } from '../src/world/terrain.ts';
import type { MapObject } from '../src/formats/mission.ts';

const AMAZONS = 0, PIMMONS = 1;
const PORTER = 9, PRIEST = 22, SCOUT = 24, ARCHER = 29, FIGHTER = 30, CROSSBOW = 36;
const HUNTBOW = 5, LARGE = 53, TOWER = 60, HOUSE = 38;
const BOW = 0, XBOW = 1, SWORD = 2, HEAL = 3, SHORTBOW = 4;
const oid = (race: number, type: number) => ((race << 16) | type) >>> 0;

function weapons(): Weapon[] {
  const w = (index: number, kind: number, projectile: number, min: number, max: number, range: number, cooldown: number, hit: number): Weapon =>
    ({ index, kind, projectile, min, max, range, speed: 1000, cooldown, hit, name: '' });
  return [w(BOW, 2, 1, 10, 20, 6, 35, 95), w(XBOW, 2, 3, 15, 25, 8, 40, 95), w(SWORD, 1, -1, 5, 10, 0, 10, 90),
    w(HEAL, 3, -1, 7, 13, 0, 21, 100), w(SHORTBOW, 2, 1, 10, 20, 5, 40, 70)];
}

function rules(): Map<number, ObjectRule> {
  const m = new Map<number, ObjectRule>();
  const base = { name: '', sound: 0, soundFrame: 7, soundAction: 1, radius: 6, residents: 0, flags: 0, money: 0,
    garrison: 0, invention: -1, madeAt: -1, cost: [0, 0, 5, 0, 0, 0, 0, 0, 0], product: -1, amount: 0, slot: 0, needPop: 0,
    message: 0, weapon: -1, impact: 0, points: [] as [number, number][], operator: -1 };
  const unit = (race: number, type: number, cls: number, weapon: number, radius = 6) => m.set(oid(race, type), { ...base, id: oid(race, type), group: race, kind: 0, type,
    sizeX: 1, sizeY: 1, doorDx: 0, doorDy: 0, hp: 100, cls, weapon, radius, stepTime: [5, 6, 7, 8] } as ObjectRule);
  for (const race of [AMAZONS, PIMMONS]) {
    unit(race, PORTER, 0, -1); unit(race, SCOUT, 0, -1); unit(race, PRIEST, 0, HEAL, 5);
    unit(race, ARCHER, 2, BOW, 10); unit(race, CROSSBOW, 2, XBOW, 10); unit(race, FIGHTER, 1, SWORD, 10); unit(race, HUNTBOW, 2, SHORTBOW);
  }
  const pts = (l: [number, number][]) => [...l, ...new Array(8 - l.length).fill([0, 0])] as [number, number][];
  m.set(oid(PIMMONS, LARGE), { ...base, id: oid(PIMMONS, LARGE), group: PIMMONS, kind: 1, type: LARGE, sizeX: 3, sizeY: 3, doorDx: 1, doorDy: -2,
    hp: 800, cls: 6, garrison: 3, radius: 25, stepTime: [0, 0, 0, 0], points: pts([[216, 57], [137, 73], [151, 50]]) } as ObjectRule);
  m.set(oid(AMAZONS, TOWER), { ...base, id: oid(AMAZONS, TOWER), group: AMAZONS, kind: 1, type: TOWER, sizeX: 1, sizeY: 1, doorDx: 0, doorDy: -1,
    hp: 100000, cls: -1, stepTime: [0, 0, 0, 0] } as ObjectRule);
  m.set(oid(AMAZONS, HOUSE), { ...base, id: oid(AMAZONS, HOUSE), group: AMAZONS, kind: 1, type: HOUSE, sizeX: 3, sizeY: 3, doorDx: -1, doorDy: 1,
    hp: 350, cls: -1, stepTime: [0, 0, 0, 0] } as ObjectRule);
  return m;
}
function flatTerrain(bits: number, h = 128): Terrain {
  const n = 1 << bits;
  return { sizeBits: bits, size: n, height: new Uint16Array(n * n).fill(h), cls: new Uint8Array(n * n), tile: new Uint8Array(n * n) };
}
function world(objects: MapObject[] = [], orders?: { x1: number; y1: number; x2: number; y2: number }[]) {
  const w = new World(flatTerrain(7), objects, rules(), orders ? { races: [], costs: [], goals: [], orders, ai: false } : undefined);
  w.weapons = weapons();
  w.economy.ensurePlayer(AMAZONS); w.economy.ensurePlayer(PIMMONS);
  w.combat.setRelation(PIMMONS, AMAZONS, 1);
  return w;
}
const cell = (e: Entity): [number, number] => [Math.floor(e.x / SUB), Math.floor(e.y / SUB)];
const put = (e: Entity, x: number, y: number) => { e.x = x * SUB + SUB / 2; e.y = y * SUB + SUB / 2; };

// ---------------------------------------------------------------- line of fire (3.4, 9.5)

test('line of fire: the lagging stepper (reach tables, lopsided shape, the (5, 5) example)', {}, () => {
  const w = world();
  const post = w.spawn({ cls: 1, group: PIMMONS, type: LARGE, owner: -1, x: 100, y: 100, z: 0 });
  const t = w.spawn({ cls: 0, group: AMAZONS, type: PORTER, owner: -1, x: 60, y: 60, z: 0 });
  w.motion.vacate(t);
  const O = 60;
  const inR = (dx: number, dy: number, wpn: Weapon, garrison = false) => { put(t, O + dx, O + dy); return w.combat.inRange(O, O, t, wpn, garrison ? post : undefined); };
  const count = (wpn: Weapon, garrison = false) => {
    let n = 0;
    for (let dx = -30; dx <= 30; dx++) for (let dy = -30; dy <= 30; dy++) if ((dx || dy) && inR(dx, dy, wpn, garrison)) n++;
    return n;
  };
  const [bow, xbow, , , short] = w.weapons;
  // cells in range, all quadrants (combat.md 3.4 table, 9.5 table)
  assert.equal(count(short), 104);
  assert.equal(count(bow), 136);
  assert.equal(count(xbow), 220);
  assert.equal(count(xbow, true), 816);
  // straight and diagonal reach
  assert.ok(inR(6, 0, bow) && !inR(7, 0, bow) && inR(0, 6, bow) && !inR(0, -7, bow));
  assert.ok(inR(5, 5, bow), 'R 6 diagonal: (5, 5) costs 2 + 3 + 3 + 3 = 11 < 12');
  assert.ok(!inR(6, 6, bow));
  assert.ok(inR(-5, 5, bow) && inR(5, -5, bow) && inR(-5, -5, bow));
  // the shape is lopsided between x and y (crossbow tower)
  assert.ok(inR(13, 7, xbow, true), '(13, 7) in range');
  assert.ok(!inR(7, 13, xbow, true), '(7, 13) out of range');
});

test('line of fire: no shot across the map seam; melee wraps; height rule +1 at a rise of 32, -1 at a drop of 17', {}, () => {
  const w = world();
  const [bow, , sword] = w.weapons;
  const n = w.size;
  const t = w.spawn({ cls: 0, group: AMAZONS, type: PORTER, owner: -1, x: n - 2, y: 60, z: 0 });
  assert.ok(!w.combat.inRange(1, 60, t, bow), 'three cells away across the seam: the walk runs the long way');
  assert.ok(w.combat.inRange(n - 5, 60, t, bow), 'the same distance inside the map');
  put(t, n - 1, 60);
  assert.ok(w.combat.inRange(0, 60, t, sword), 'melee adjacency wraps');
  // heights: y-major cells are priced against the shooter's own cell, x-major against the previous
  const h = w.terrain.height as Uint16Array;
  const idx = (x: number, y: number) => (y << w.bits) | x;
  for (let y = 61; y < 90; y++) for (let x = 40; x < 80; x++) h[idx(x, y)] = 128 + 64;
  const reach = (dx: number, dy: number) => { let r = 0; for (let k = 1; k < 20; k++) { put(t, 60 + dx * k, 60 + dy * k); if (w.combat.inRange(60, 60, t, bow)) r = k; else break; } return r; };
  assert.equal(reach(0, 1), 4, 'uphill along y: + 1 for every cell above the shooter');
  for (let y = 61; y < 90; y++) for (let x = 40; x < 80; x++) h[idx(x, y)] = 128;
  for (let y = 40; y < 80; y++) for (let x = 61; x < 90; x++) h[idx(x, y)] = 128 + 64;
  assert.equal(reach(1, 0), 6, 'uphill along x: only the one step up counts');
  for (let y = 40; y < 80; y++) for (let x = 61; x < 90; x++) h[idx(x, y)] = 128 - 17;
  assert.equal(reach(1, 0), 7, 'a drop of 17 costs - 1');
  for (let y = 40; y < 80; y++) for (let x = 61; x < 90; x++) h[idx(x, y)] = 128 - 16;
  assert.equal(reach(1, 0), 6, 'a drop of 16 costs nothing');
});

// ---------------------------------------------------------------- area scan (8.3)

test('area scan: a building is found through any footprint cell; a unit only on its cell, not inside', {}, () => {
  const w = world();
  // a 3x3 house with its anchor (max corner) at (66, 60): footprint x 64..66
  const house = w.spawn({ cls: 1, group: AMAZONS, type: HOUSE, owner: -1, x: 66, y: 60, z: 0 });
  const u = w.spawn({ cls: 0, group: AMAZONS, type: PORTER, owner: -1, x: 61, y: 60, z: 0 });
  // radius 5 around (60, 60): dx 4 is inside (16 < 25), the anchor at dx 6 is not
  const ids = w.combat.scan(60, 60, 5).map(e => e.id);
  assert.ok(ids.includes(house.id), 'found through the footprint cell (64, 60)');
  assert.ok(ids.includes(u.id));
  assert.ok(!w.combat.scan(60, 60, 4).some(e => e.id === house.id), 'no footprint cell in a radius-4 disc');
  w.motion.vacate(u); w.putInside(u, house);
  assert.ok(!w.combat.scan(60, 60, 5).some(e => e.id === u.id), 'a unit inside a building is off the map');
});

// ---------------------------------------------------------------- priest (13)

test('priest: a wounded priest on an auto heal job heals himself first; the child starts one run later', {}, () => {
  const w = world();
  const p = w.spawn({ cls: 0, group: AMAZONS, type: PRIEST, owner: -1, x: 60, y: 60, z: 0 });
  const other = w.spawn({ cls: 0, group: AMAZONS, type: PORTER, owner: -1, x: 62, y: 60, z: 0 });
  p.hp = 40; other.hp = 40;
  w.combat.startHeal(p, undefined, true, 1);
  const job = w.sched.get(p.job)!;
  w.step(); w.step();
  assert.equal(job.data[1], 2, 'a patient chosen, no child yet');
  assert.equal(job.data[2], p.id, 'himself: distance 0, no self test');
  for (let i = 0; i < 3; i++) w.step();
  assert.equal(job.data[1], 1, 'the attack child is made (3 ticks later), returns 1');
  let healed = false;
  for (let i = 0; i < 200 && !healed; i++) { w.step(); healed = p.hp > 40; }
  assert.ok(healed, 'he healed himself');
  assert.equal(other.hp, 40, 'the porter waits');
});

// ---------------------------------------------------------------- patrol commands (8.2)

test('patrol: the button makes a stationary guard at once (delay 2); each click appends one point, up to 8', {}, () => {
  const w = world();
  const s = w.spawn({ cls: 0, group: PIMMONS, type: FIGHTER, owner: -1, x: 60, y: 60, z: 0 });
  w.schedule({ type: 'patrol', player: PIMMONS, id: s.id });
  w.step();
  const j = w.sched.get(s.job)!;
  assert.equal(j.kind, CJ.Guard);
  assert.equal(j.data[0], 1, 'count 1: its own cell');
  assert.deepEqual([j.data[2], j.data[3]], [60, 60]);
  for (let k = 0; k < 9; k++) w.schedule({ type: 'patrolPoint', player: PIMMONS, id: s.id, x: 70 + k, y: 60 });
  w.step();
  assert.equal(j.data[0], 8, 'appended while the count is below 8');
  assert.deepEqual([j.data[4], j.data[5]], [70, 60]);
  assert.deepEqual([j.data[16], j.data[17]], [76, 60]);
});

// ---------------------------------------------------------------- map order records (8.2, dvm.md)

test('map orders: one record after the other in file order, a new guard per record, one draw per job made', {}, () => {
  const objects: MapObject[] = [
    { cls: 0, group: PIMMONS, type: FIGHTER, owner: -1, x: 40, y: 40, z: 0 },
    { cls: 0, group: PIMMONS, type: ARCHER, owner: -1, x: 50, y: 40, z: 0 },
    { cls: 0, group: PIMMONS, type: PORTER, owner: -1, x: 60, y: 40, z: 0 },
  ] as MapObject[];
  const orders = [
    { x1: 40, y1: 40, x2: 45, y2: 40 },
    { x1: 70, y1: 70, x2: 1, y2: 1 },      // no object on the source cell: skipped, no draw
    { x1: 60, y1: 40, x2: 90, y2: 90 },    // a porter, nothing on the target cell: skipped, no draw
    { x1: 40, y1: 40, x2: 40, y2: 46 },    // the same soldier again: a new guard job
    { x1: 50, y1: 40, x2: 50, y2: 40 },    // the target is his own cell: no same-cell test
  ];
  const plain = world(objects, []);
  const w = world(objects, orders);
  const r = new MsRand(plain.rand.state);
  r.next(); r.next(); r.next();
  assert.equal(w.rand.state, r.state, 'three jobs made, three draws');
  const [f, a] = [w.entities.find(e => (e.oid & 0xffff) === FIGHTER)!, w.entities.find(e => (e.oid & 0xffff) === ARCHER)!];
  const gf = w.sched.get(f.job)!, ga = w.sched.get(a.job)!;
  assert.equal(gf.kind, CJ.Guard);
  assert.deepEqual(gf.data.slice(0, 6), [2, 0, 40, 40, 40, 46], 'the second record made the current guard job');
  assert.deepEqual(ga.data.slice(0, 6), [2, 0, 50, 40, 50, 40], 'own cell twice');
});

// ---------------------------------------------------------------- scout job (15)

test('scout job: x, y, the spiral cell, one walk whose first run comes rand() % 5 + 1 ticks later', {}, () => {
  const w = world();
  const u = w.spawn({ cls: 0, group: PIMMONS, type: SCOUT, owner: -1, x: 60, y: 60, z: 0 });
  // the cell the first draw pair names is made impassable, so the spiral moves on to (x + 1, y - 1)
  const r = new MsRand(w.rand.state);
  const x = r.next() % w.size, y = r.next() % w.size, delay = r.next() % 5 + 1;
  w.blocked[(y << w.bits) | x] = 1;
  const j = w.sched.create(AiJob.Explore, u.id, 0, [0, 0, 0, 0]);
  u.job = j.id;
  w.step();
  assert.deepEqual([j.data[0], j.data[1]], [(x + 1) & (w.size - 1), (y - 1) & (w.size - 1)], 'the first free cell of the square spiral');
  assert.deepEqual([u.goalX, u.goalY], [j.data[0], j.data[1]]);
  assert.equal(u.plans, 0, `the walk has not planned yet (first run after ${delay})`);
  for (let i = 0; i < delay; i++) w.step();
  assert.ok(u.plans >= 1, 'planned at the walk job\'s first run');
});

// ---------------------------------------------------------------- the order's selection walk (units-and-jobs.md 3.2)

test('order: the selection in its order, stopping at the first unit inside a building', {}, () => {
  const w = world();
  const target = w.spawn({ cls: 1, group: AMAZONS, type: TOWER, owner: -1, x: 80, y: 60, z: 0 });
  target.complete = true;
  const house = w.spawn({ cls: 1, group: PIMMONS, type: LARGE, owner: -1, x: 40, y: 40, z: 0 });
  const mk = (x: number) => w.spawn({ cls: 0, group: PIMMONS, type: FIGHTER, owner: -1, x, y: 60, z: 0 });
  const a = mk(60), b = mk(61), inside = mk(62), c = mk(63);
  w.motion.vacate(inside); w.putInside(inside, house);
  w.schedule({ type: 'order', player: PIMMONS, ids: [b.id, a.id, inside.id, c.id], target: target.id });
  w.step();
  const kind = (e: Entity) => (e.job ? w.sched.get(e.job)?.kind : 0);
  assert.equal(kind(b), CJ.Attack);
  assert.equal(kind(a), CJ.Attack);
  assert.equal(kind(c), 0, 'after the unit inside: not processed');
  assert.deepEqual(cell(a), [60, 60]);
});

// ---------------------------------------------------------------- saves (snapshot version 22)

test('saves before version 22: a route job gets the first-leg marker (off) and the destination slot', {}, () => {
  const w = world();
  const u = w.spawn({ cls: 0, group: PIMMONS, type: PORTER, owner: -1, x: 60, y: 60, z: 0 });
  const j = w.sched.create(0x20, u.id, 5, [1, 0, 1, 0, -1, 0]);
  u.job = j.id;
  const snap = JSON.parse(JSON.stringify(w.snapshot()));
  snap.v = 21;
  const r = World.restore(w.terrain, snap, w.rules, w.weapons);
  assert.deepEqual(r.sched.get(j.id)!.data, [1, 0, 1, 0, -1, 0, 0, -1]);
});
