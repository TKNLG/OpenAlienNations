// Wild animals (and trees) coming back: the respawn manager, job 0x37.
// Spec: docs/game/units-and-jobs.md 7.5.1, 7.7, 7.3.8. Synthetic worlds, no game data needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, SUB, Kind, type Entity } from '../src/engine/world.ts';
import { LJ, AM } from '../src/engine/logistics.ts';
import { MsRand } from '../src/world/rand.ts';
import { CLASS_WATER } from '../src/world/terrain.ts';
import type { ObjectRule } from '../src/formats/odb.ts';
import type { Terrain } from '../src/world/terrain.ts';
import type { MapObject } from '../src/formats/mission.ts';

const FASTERATOR = 33, NECKTOR = 34, ECHSE = 35, TREE = 9, STONE = 30;
const ANIMALS = [FASTERATOR, NECKTOR, ECHSE];
function rules(): Map<number, ObjectRule> {
  const m = new Map<number, ObjectRule>();
  const id = (t: number) => (6 << 16) | t;
  for (const a of ANIMALS) m.set(id(a), { id: id(a), group: 6, kind: 2, type: a, cls: 7, stepTime: [5, 6, 7, 8], hp: 10, amount: 8, product: 4, sizeX: 1, sizeY: 1 } as ObjectRule);
  m.set(id(TREE), { id: id(TREE), group: 6, kind: 2, type: TREE, cls: 8, stepTime: [0, 0, 0, 0], hp: 10, amount: 6, product: 1, sizeX: 1, sizeY: 1 } as ObjectRule);
  m.set(id(STONE), { id: id(STONE), group: 6, kind: 2, type: STONE, cls: 13, stepTime: [0, 0, 0, 0], hp: 10, amount: 12, product: 2, sizeX: 1, sizeY: 1 } as ObjectRule);
  return m;
}
function flatTerrain(bits: number): Terrain {
  const n = 1 << bits;
  return { sizeBits: bits, size: n, height: new Uint16Array(n * n).fill(128), cls: new Uint8Array(n * n).fill(1), tile: new Uint8Array(n * n) };
}
const nat = (type: number, x: number, y: number): MapObject => ({ cls: 2, group: 6, type, owner: -1, x, y, z: 0 });
const cell = (e: Entity): [number, number] => [Math.floor(e.x / SUB), Math.floor(e.y / SUB)];
const animals = (w: World) => w.entities.filter(e => e.kind === Kind.Nature && w.rules.get(e.oid)?.cls === 7 && e.alive);
const typesOf = (es: Entity[]) => es.map(e => e.oid & 0xffff).sort((a, b) => a - b);

/** a hunter has carried the last food away: the carcass is used up (7.4) */
function useUp(w: World, a: Entity): void {
  a.alive = false; a.amount = 0;
  w.logistics.depleted(a);
}
/** step until the end of world tick t */
function stepTo(w: World, t: number): void { while (w.tick < t) w.step(); }

/** the square spiral of 4.8 written from the spec: centre, then ring k from (x+k, y-k): +y, -x, -y, +x */
function* spiral(x: number, y: number): Generator<[number, number]> {
  yield [x, y];
  for (let k = 1; ; k++) {
    for (let dy = -k; dy < k; dy++) yield [x + k, y + dy];
    for (let dx = k; dx > -k; dx--) yield [x + dx, y + k];
    for (let dy = k; dy > -k; dy--) yield [x - k, y + dy];
    for (let dx = -k; dx < k; dx++) yield [x + dx, y - k];
  }
}

/** the first cell of the spiral around (x0, y0) whose flags miss 0x1003F (base mode: no class-0 flag) */
function expectCell(w: World, x0: number, y0: number): [number, number] {
  const m = w.size - 1;
  for (const [x, y] of spiral(x0, y0)) {
    const i = (y & m) * w.size + (x & m);
    if (w.blocked[i] || w.pathFlag[i] || w.motion.unitOn(i)) continue;
    return [x & m, y & m];
  }
  throw new Error('unreachable');
}

test('respawn: an animal used up next to a forest comes back on the 21st manager run, same type, near the tree', {}, () => {
  const w = new World(flatTerrain(6), [nat(TREE, 30, 30), nat(NECKTOR, 31, 31)], rules());
  const a = animals(w)[0];
  stepTo(w, 1000);
  useUp(w, a);
  assert.equal(w.respawns.length, 1);
  assert.deepEqual({ ...w.respawns[0] }, { type: NECKTOR, cls: 7, x: cell(a)[0], y: cell(a)[1], radius: 10, countdown: 20 });
  // the manager runs in world ticks 299k + 1 from game start; filed during k = 3..4 -> 21st run is k = 24
  const runAt = 299 * 24 + 1;
  stepTo(w, runAt - 1);
  assert.equal(animals(w).length, 0, 'nothing before the 21st run');
  assert.equal(w.respawns[0].countdown, 0);
  const tree = w.entities.find(e => (e.oid & 0xffff) === TREE)!;
  const probe = new MsRand(w.rand.state);
  // nothing else draws in this world at that tick (no animal left), so the manager's draws are the next ones
  const x0 = cell(tree)[0] + (probe.next() % 7) - 3, y0 = cell(tree)[1] + (probe.next() % 7) - 3;
  const mode = probe.next() % 3, delay = probe.next() % 40 + 1;
  const want = expectCell(w, x0, y0);
  w.step();
  assert.equal(w.tick, runAt);
  const back = animals(w);
  assert.equal(back.length, 1, 'one animal back');
  assert.equal(back[0].oid & 0xffff, NECKTOR, 'of the same type');
  assert.deepEqual(cell(back[0]), want, 'first free spiral cell around tree + rand() % 7 - 3 on each axis, x drawn first');
  assert.deepEqual([back[0].homeX, back[0].homeY], want, 'home = the new cell');
  assert.equal(w.respawns.length, 0);
  // its animal job: first mode rand() % 3, then the delay rand() % 40 + 1 (7.7)
  const job = w.sched.get(back[0].job)!;
  assert.equal(job.kind, LJ.Animal);
  assert.equal(job.data[AM.Mode], mode);
  assert.equal(w.rand.state, probe.state, 'exactly four draws: x, y, mode, delay');
  // and it is an ordinary animal: it starts moving or idling once its delay is over
  stepTo(w, runAt + delay + 400);
  assert.ok(w.sched.get(back[0].job), 'the animal job keeps running');
});

test('respawn: the survivor must be a tree within the square radius 10; living animals do not count', {}, () => {
  // no tree at all, two other living animals right next to the dead one: nothing comes back
  const w = new World(flatTerrain(6), [nat(FASTERATOR, 20, 20), nat(FASTERATOR, 21, 20), nat(ECHSE, 22, 21)], rules());
  const dead = animals(w)[0];
  useUp(w, dead);
  stepTo(w, 299 * 22 + 1);
  assert.equal(animals(w).length, 2, 'no tree nearby: the animal is lost');
  assert.equal(w.respawns.length, 0, 'the entry is dropped anyway');

  // a tree 11 cells away on one axis is outside the square, one at (10, 10) diagonal is inside
  const far = new World(flatTerrain(6), [nat(TREE, 31, 20), nat(ECHSE, 20, 20)], rules());
  useUp(far, animals(far)[0]);
  stepTo(far, 299 * 22 + 1);
  assert.equal(animals(far).length, 0, 'tree 11 cells away: lost');
  const near = new World(flatTerrain(6), [nat(TREE, 30, 30), nat(ECHSE, 20, 20)], rules());
  useUp(near, animals(near)[0]);
  stepTo(near, 299 * 21 + 1);   // filed at tick 0: handled on the 21st run (before the new animal walks)
  assert.equal(animals(near).length, 1, 'tree at dx = dy = 10: inside the square');
  const [x, y] = cell(animals(near)[0]);
  assert.ok(Math.abs(x - 30) <= 3 && Math.abs(y - 30) <= 3, 'placed around that tree');
});

test('respawn: the nearest tree wins (max + min/2), ties to the first in row order', {}, () => {
  // dead animal at (20, 20); trees at (25, 20) d = 5, (24, 23) d = 4 + 1 = 5, (17, 24) d = 4 + 1 = 5, (20, 16) d = 4
  const w = new World(flatTerrain(6), [nat(TREE, 25, 20), nat(TREE, 24, 23), nat(TREE, 17, 24), nat(TREE, 20, 16), nat(ECHSE, 20, 20)], rules());
  useUp(w, animals(w)[0]);
  stepTo(w, 299 * 21);
  const probe = new MsRand(w.rand.state);
  const x0 = 20 + (probe.next() % 7) - 3, y0 = 16 + (probe.next() % 7) - 3;
  const want = expectCell(w, x0, y0);
  w.step();
  assert.deepEqual(cell(animals(w)[0]), want, 'placed around the tree at distance 4');

  // equal distances: the first in scan order (dy = -R first) is taken
  const t = new World(flatTerrain(6), [nat(TREE, 25, 22), nat(TREE, 15, 18), nat(ECHSE, 20, 20)], rules());
  useUp(t, animals(t)[0]);
  stepTo(t, 299 * 21);
  const p2 = new MsRand(t.rand.state);
  const x1 = 15 + (p2.next() % 7) - 3, y1 = 18 + (p2.next() % 7) - 3;
  const want1 = expectCell(t, x1, y1);
  t.step();
  assert.deepEqual(cell(animals(t)[0]), want1, 'tie (both d = 6): the tree in the earlier row (y = 18)');
});

test('respawn: the spiral skips path, water, nature and unit cells and never gives up', {}, () => {
  // block a 13 x 13 area around the tree: water on the left half, path flags on the right half,
  // stones on the row y = 37; the only free cells start outside it
  const t2 = flatTerrain(6);
  const objs: MapObject[] = [nat(TREE, 30, 30), nat(ECHSE, 32, 32)];
  for (let y = 24; y <= 36; y++) for (let x = 24; x <= 29; x++) t2.cls[y * 64 + x] = CLASS_WATER;
  for (let x = 24; x <= 36; x++) objs.push(nat(STONE, x, 37));
  const w = new World(t2, objs, rules());
  for (let y = 24; y <= 36; y++) for (let x = 30; x <= 36; x++) if (!(x === 30 && y === 30)) w.pathFlag[y * 64 + x] = 1;
  // keep the animal's own walks out of the way: use it up at once
  useUp(w, animals(w)[0]);
  stepTo(w, 299 * 21);
  const probe = new MsRand(w.rand.state);
  const x0 = 30 + (probe.next() % 7) - 3, y0 = 30 + (probe.next() % 7) - 3;
  const blockedCell = (x: number, y: number) => {
    const i = (y & 63) * 64 + (x & 63);
    return t2.cls[i] === CLASS_WATER || w.pathFlag[i] === 1 || w.natureAt[i] > 0 || w.blocked[i] === 1;
  };
  let want: [number, number] | null = null;
  for (const [x, y] of spiral(x0, y0)) if (!blockedCell(x, y)) { want = [x & 63, y & 63]; break; }
  w.step();
  const back = animals(w);
  assert.equal(back.length, 1, 'still created, further out');
  assert.deepEqual(cell(back[0]), want);
  const [bx, by] = want!;
  assert.ok(bx < 24 || bx > 36 || by < 24 || by > 37, 'outside the blocked area');
});

test('respawn: Gold class-0 cells (flag 0x10000) are skipped, not a reason to give up', {}, () => {
  const t = flatTerrain(6);
  for (let y = 22; y <= 38; y++) for (let x = 22; x <= 38; x++) t.cls[y * 64 + x] = 0;   // class 0 around the tree
  const w = new World(t, [nat(TREE, 30, 30), nat(ECHSE, 31, 31)], rules());
  w.gold = { ...w.gold, class0Respawn: true };
  useUp(w, animals(w)[0]);
  stepTo(w, 299 * 21 + 1);
  const back = animals(w);
  assert.equal(back.length, 1);
  const [x, y] = cell(back[0]);
  assert.ok(t.cls[y * 64 + x] !== 0, 'not on a class-0 cell');
  // AN.exe (base default) never sets the flag: the same set-up respawns within +-3 of the tree
  const b = new World(t, [nat(TREE, 30, 30), nat(ECHSE, 31, 31)], rules());
  useUp(b, animals(b)[0]);
  stepTo(b, 299 * 21 + 1);
  const [bx, by] = cell(animals(b)[0]);
  assert.ok(Math.abs(bx - 30) <= 3 && Math.abs(by - 30) <= 3);
});

test('respawn: a hunted-out forest recovers to its starting population and types, never more', {}, () => {
  const objs: MapObject[] = [];
  for (let y = 10; y < 30; y += 3) for (let x = 10; x < 30; x += 3) objs.push(nat(TREE, x, y));
  const start: [number, number, number][] = [[12, 12, FASTERATOR], [17, 14, NECKTOR], [22, 20, ECHSE], [14, 25, FASTERATOR], [26, 26, NECKTOR], [20, 11, ECHSE]];
  for (const [x, y, ty] of start) objs.push(nat(ty, x, y));
  const w = new World(flatTerrain(6), objs, rules());
  const cap = animals(w).length, types0 = typesOf(animals(w));
  assert.equal(cap, 6);
  // the hunters take them one after another over a few minutes
  for (const a of animals(w)) { stepTo(w, w.tick + 400); useUp(w, a); }
  assert.equal(animals(w).length, 0);
  assert.equal(w.respawns.length, 6);
  assert.ok(w.respawns.every((r, i, l) => i === 0 || l[i - 1].countdown <= r.countdown), 'sorted by countdown');
  let most = 0;
  for (let i = 0; i < 299 * 30; i++) { w.step(); most = Math.max(most, animals(w).length); }
  assert.equal(animals(w).length, cap, 'back to the starting head count');
  assert.deepEqual(typesOf(animals(w)), types0, 'same species mix');
  assert.equal(most, cap, 'never more than before');
  assert.equal(w.respawns.length, 0);
  // and again: the replacements are ordinary animals and are replaced in turn
  for (const a of animals(w)) useUp(w, a);
  for (let i = 0; i < 299 * 22; i++) w.step();
  assert.equal(animals(w).length, cap);
});

test('respawn: list order (new entries in front of equal countdowns), trees too, and the run grid', {}, () => {
  const w = new World(flatTerrain(6), [nat(TREE, 10, 10), nat(TREE, 40, 40), nat(ECHSE, 12, 12), nat(NECKTOR, 42, 42)], rules());
  const job = w.sched.get(w.respawnJob)!;
  assert.equal(job.kind, LJ.Respawn, 'the manager exists from game start');
  stepTo(w, 50);
  const [e, n] = [animals(w).find(a => (a.oid & 0xffff) === ECHSE)!, animals(w).find(a => (a.oid & 0xffff) === NECKTOR)!];
  useUp(w, e); useUp(w, n);
  assert.deepEqual(w.respawns.map(r => r.type), [NECKTOR, ECHSE], 'newest first among equal countdowns');
  const tree = w.entities.find(t => (t.oid & 0xffff) === TREE)!;
  tree.amount = 0; w.logistics.depleted(tree);
  assert.deepEqual(w.respawns.map(r => [r.cls, r.radius, r.countdown]), [[7, 10, 20], [7, 10, 20], [8, 15, 40]]);
  stepTo(w, 300);
  assert.deepEqual(w.respawns.map(r => r.countdown), [19, 19, 39], 'first run at tick 300');
  stepTo(w, 598);
  assert.deepEqual(w.respawns.map(r => r.countdown), [19, 19, 39]);
  w.step();
  assert.deepEqual(w.respawns.map(r => r.countdown), [18, 18, 38], 'every 299 ticks');
});

test('respawn: deterministic across snapshot / restore while entries are pending', {}, () => {
  const objs: MapObject[] = [];
  for (let y = 8; y < 40; y += 4) for (let x = 8; x < 40; x += 4) objs.push(nat(TREE, x, y));
  for (let i = 0; i < 8; i++) objs.push(nat(ANIMALS[i % 3], 10 + i * 3, 12 + (i * 7) % 20));
  const terrain = flatTerrain(6);
  const w = new World(terrain, objs, rules());
  stepTo(w, 700);
  for (const a of animals(w).slice(0, 5)) { useUp(w, a); stepTo(w, w.tick + 650); }
  assert.ok(w.respawns.length > 0);
  const snap = JSON.parse(JSON.stringify(w.snapshot()));
  const copy = World.restore({ ...terrain, height: terrain.height.slice(), cls: terrain.cls.slice(), tile: terrain.tile.slice() }, snap, w.rules);
  assert.equal(copy.respawnJob, w.respawnJob);
  for (let i = 0; i < 299 * 24; i++) { w.step(); copy.step(); }
  assert.equal(copy.hash(), w.hash());
  assert.deepEqual(copy.respawns, w.respawns);
  assert.deepEqual(animals(copy).map(cell), animals(w).map(cell));
  assert.equal(animals(w).length, 8, 'all back');
});

test('respawn: a save without a running manager gets one on the 299k + 1 grid', {}, () => {
  const terrain = flatTerrain(6);
  const w = new World(terrain, [nat(TREE, 10, 10), nat(ECHSE, 12, 12)], rules());
  stepTo(w, 1234);
  const snap = JSON.parse(JSON.stringify(w.snapshot()));
  // an older save: the manager only ran while it had entries
  for (const slot of snap.sched.slots) for (let i = slot.length - 1; i >= 0; i--) if (slot[i].kind === LJ.Respawn) slot.splice(i, 1);
  snap.respawnJob = 0;
  snap.respawns = [{ type: ECHSE, cls: 7, x: 12, y: 12, radius: 10, countdown: 1 }];
  const r = World.restore(terrain, snap, w.rules);
  assert.ok(r.sched.get(r.respawnJob));
  stepTo(r, 299 * 5 + 1);
  assert.equal(r.respawns[0].countdown, 0, 'ran at tick 1496');
  stepTo(r, 299 * 6);
  assert.equal(r.respawns.length, 1);
  r.step();
  assert.equal(r.respawns.length, 0, 'handled at tick 1795');
});
