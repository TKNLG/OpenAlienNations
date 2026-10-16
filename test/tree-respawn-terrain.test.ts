// Where new trees can appear: respawned trees and the mountain (mine) ground.
// Spec: docs/game/units-and-jobs.md 7.5.1, 7.5.2; docs/formats/world-populate.md 5.
// The original's respawn spiral tests the flags 0x1003F only; the mountain flag 0x100 is not among
// them, so a respawned tree may stand on a cell a mine could use. Populated trees never do.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, SUB, Kind, type Entity } from '../src/engine/world.ts';
import { MsRand } from '../src/world/rand.ts';
import { CLASS_WATER, CLASS_TILESET } from '../src/world/terrain.ts';
import type { ObjectRule } from '../src/formats/odb.ts';
import type { Terrain } from '../src/world/terrain.ts';
import type { MapObject } from '../src/formats/mission.ts';
import { DATA, rulesOf, dataReader } from './helpers/mission.ts';
import { existsSync } from 'node:fs';
import { parseMdb } from '../src/formats/mission.ts';
import { parseOs } from '../src/formats/os.ts';
import { buildGeneratedWorld } from '../src/world/free-play.ts';
import { animalTypeCount } from '../src/formats/addon.ts';
import { applyFreePlay, spDefaults } from '../src/client/frontend/freeplay.ts';

const TREE = 9;
const N = 64, MOUNTAIN_X = 31;   // cells with x >= 31 (up to 46) are mountain: height 300, rock
function rules(): Map<number, ObjectRule> {
  const m = new Map<number, ObjectRule>();
  const id = (6 << 16) | TREE;
  m.set(id, { id, group: 6, kind: 2, type: TREE, cls: 8, stepTime: [0, 0, 0, 0], hp: 10, amount: 6, product: 1, sizeX: 1, sizeY: 1 } as ObjectRule);
  return m;
}
function terrain(): Terrain {
  const t: Terrain = { sizeBits: 6, size: N, height: new Uint16Array(N * N).fill(128), cls: new Uint8Array(N * N).fill(1), tile: new Uint8Array(N * N) };
  for (let y = 0; y < N; y++) for (let x = MOUNTAIN_X; x < MOUNTAIN_X + 16; x++) { t.height[y * N + x] = 300; t.cls[y * N + x] = 3; }
  return t;
}
const nat = (x: number, y: number): MapObject => ({ cls: 2, group: 6, type: TREE, owner: -1, x, y, z: 0 });
const cell = (e: Entity): [number, number] => [Math.floor(e.x / SUB), Math.floor(e.y / SUB)];
const trees = (w: World) => w.entities.filter(e => e.kind === Kind.Nature && e.alive && w.rules.get(e.oid)?.cls === 8);
const onMountain = (w: World) => trees(w).filter(e => { const [x, y] = cell(e); return w.terrain.height[y * w.size + x] > w.mountain; });
function fell(w: World, e: Entity): void { e.amount = 0; w.logistics.depleted(e); }
function stepTo(w: World, t: number): void { while (w.tick < t) w.step(); }

/** the square spiral of 4.8 from the spec: centre, then ring k from (x+k, y-k): +y, -x, -y, +x */
function* spiral(x: number, y: number): Generator<[number, number]> {
  yield [x, y];
  for (let k = 1; ; k++) {
    for (let dy = -k; dy < k; dy++) yield [x + k, y + dy];
    for (let dx = k; dx > -k; dx--) yield [x + dx, y + k];
    for (let dy = k; dy > -k; dy--) yield [x - k, y + dy];
    for (let dx = -k; dx < k; dx++) yield [x + dx, y - k];
  }
}
/** the first spiral cell whose flags miss 0x1003F (base mode): no path flag, unit, building, nature, water; height not tested */
function expectCell(w: World, x0: number, y0: number): [number, number] {
  const m = w.size - 1;
  for (const [x, y] of spiral(x0, y0)) {
    const i = (y & m) * w.size + (x & m);
    if (w.blocked[i] || w.pathFlag[i] || w.motion.unitOn(i)) continue;
    return [x & m, y & m];
  }
  throw new Error('unreachable');
}

test('tree respawn: the mountain flag (mine ground) does not block; low ground paved around the survivor sends the tree uphill', {}, () => {
  // survivor at (30, 30), felled tree at (29, 30); all low ground around them is paved (path flag),
  // as around a busy town; the mountain starts at x = 31 and is never paved (4.5)
  const w = new World(terrain(), [nat(30, 30), nat(29, 30)], rules());
  for (let y = 20; y <= 40; y++) for (let x = 20; x < MOUNTAIN_X; x++) w.pathFlag[y * N + x] = 1;
  const felled = trees(w).find(e => cell(e)[0] === 29)!;
  fell(w, felled);
  assert.equal(w.respawns.length, 1);
  assert.equal(w.respawns[0].countdown, 40);
  // filed at tick 0: handled on the 41st run (world tick 299 * 41 + 1)
  stepTo(w, 299 * 41);
  assert.equal(trees(w).length, 1);
  const probe = new MsRand(w.rand.state);
  const x0 = 30 + (probe.next() % 7) - 3, y0 = 30 + (probe.next() % 7) - 3;
  const want = expectCell(w, x0, y0);
  w.step();
  const back = trees(w).find(e => cell(e)[0] !== 30 || cell(e)[1] !== 30)!;
  assert.ok(back, 'a small tree is back');
  assert.deepEqual(cell(back), want, 'first spiral cell missing 0x1003F around the jittered survivor cell');
  assert.ok(w.terrain.height[want[1] * N + want[0]] > w.mountain, 'it stands on mountain (mine) ground');
  assert.equal(back.standing, false, 'planted small');
  assert.equal(w.rand.state, probe.state, 'two draws: x, y');
});

test('tree respawn next to an ore field: count of trees on mountain cells before and after felling the edge', {}, () => {
  // a forest on low ground (x 24..30) right at a mountain (x >= 31); fell the three columns next to
  // the mountain five times over, waiting for the respawns each time
  const objs: MapObject[] = [];
  for (let y = 20; y < 44; y++) for (let x = 24; x < MOUNTAIN_X; x++) if ((x + y) % 2 === 0) objs.push(nat(x, y));
  const w = new World(terrain(), objs, rules());
  const total = trees(w).length;
  assert.equal(onMountain(w).length, 0, 'none on the mountain at the start');
  for (let round = 0; round < 5; round++) {
    for (const e of trees(w)) if (cell(e)[0] >= 28 && cell(e)[0] < MOUNTAIN_X && e.standing) fell(w, e);
    stepTo(w, w.tick + 299 * 45);
    assert.equal(trees(w).length, total, 'one tree back per felled tree (a survivor is always within 15)');
    for (const e of trees(w)) {
      const [x, y] = cell(e), i = y * N + x;
      assert.ok(w.terrain.cls[i] !== CLASS_WATER && !w.pathFlag[i], 'never on water or paved cells');
    }
  }
  // original behaviour (7.5.2): some of the respawned trees stand on the ore field
  assert.ok(onMountain(w).length > 0, `trees on mountain cells after felling: ${onMountain(w).length}`);
});

const skip = (!DATA || !existsSync(`${DATA}/dv.odb`)) && 'AN_DATA not set';
test('free-play populator: no tree starts on a mountain (mine) cell', { skip }, () => {
  const read = dataReader(DATA);
  const rules = rulesOf(DATA, false);
  const pickOf = (n: string) => parseOs(read(`${n}.os`)!).pick;
  const hallOf = (race: number) => { const r = rules.rules.get(((race << 16) | 40) >>> 0); return r ? { sizeX: r.sizeX, sizeY: r.sizeY, radius: r.radius || 25 } : undefined; };
  for (const seed of [1, 3, 7]) {
    const base = parseMdb(read('Infinite.mdb')!)[0];
    const m = applyFreePlay(base, { ...spDefaults(), addon: false }, seed);
    const g = buildGeneratedWorld(m, { player: 0, hallOf, pick: CLASS_TILESET.map(pickOf), animalTypes: animalTypeCount(rules.rules) });
    const n = g.terrain.size;
    const treeTypes = new Set([9, 10, 11, 12]);
    const ts = g.result.objects.filter(o => o.cls === 2 && treeTypes.has(o.type));
    assert.ok(ts.length > 100, `seed ${seed}: a populated map`);
    const high = ts.filter(o => g.terrain.height[(o.y & (n - 1)) * n + (o.x & (n - 1))] > 250);
    assert.equal(high.length, 0, `seed ${seed}: populated trees avoid 0x100`);
  }
});
