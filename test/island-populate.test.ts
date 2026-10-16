// Add-on populator rules (docs/formats/addon.md 9.5, 10, 10.2.1, 10.2.2, 10.3) on synthetic run
// lists and terrains with a scripted rand() stream, plus the re-roll cycle handling on generated
// 256 maps (needs the Gold data for the tile tables).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MsRand } from '../src/world/rand.ts';
import { makeAddonTerrain, AO_CLASS_BEACH, AO_CLASS_SEA, AO_CLASS_WATER, type AddonTerrain } from '../src/world/addon-terrain.ts';
import { islandRunIndex, populateIslands, generateIslandWorld } from '../src/world/island-populate.ts';
import { HAS_GOLD, islandGenerator } from './helpers/mission.ts';

/** rand() that returns scripted values first, then continues with the MS C generator */
class ScriptRand extends MsRand {
  script: number[];
  used: number;
  extra: number;
  constructor(script: number[], seed = 1) {
    super(seed);
    this.script = script;
    this.used = 0;
    this.extra = 0;
  }
  override next(): number {
    if (this.used < this.script.length) return this.script[this.used++];
    this.extra++;
    return super.next();
  }
}

test('random island cell: the cyclic run walk equals (k - 1) mod m unless the body owns the first run', {}, () => {
  // literal transcription of the walk of addon.md 10: start on the first entry; per step move to
  // the next entry (wrapping) and count it if it belongs to the body; after k counted steps move
  // on until standing on a run of the body
  const walk = (owner: number[], body: number, k: number) => {
    let pos = 0, counted = 0;
    while (counted < k) { pos = (pos + 1) % owner.length; if (owner[pos] === body) counted++; }
    while (owner[pos] !== body) pos = (pos + 1) % owner.length;
    return pos;
  };
  const lists = [
    [1, 2, 1, 3, 3, 2, 1, 1, 2, 3, 1],
    [2, 2, 1, 1, 1, 2],
    [3, 1, 2],
    [1],
    [2, 1],
  ];
  for (const owner of lists)
    for (const body of new Set(owner)) {
      const of = owner.map((o, i) => (o === body ? i : -1)).filter(i => i >= 0);
      for (let k = 0; k < 1024; k++) assert.equal(of[islandRunIndex(k, of)], walk(owner, body, k), `list ${owner} body ${body} k ${k}`);
    }
  // spot checks: owner of the first run -> k mod m; otherwise (k - 1) mod m, k = 0 -> R0
  assert.equal(islandRunIndex(5, [0, 3, 7]), 2);
  assert.equal(islandRunIndex(5, [1, 3, 7]), 1);
  assert.equal(islandRunIndex(0, [1, 3, 7]), 0);
  assert.equal(islandRunIndex(1, [1, 3, 7]), 0);
});

// ---------------------------------------------------------------- synthetic 256 map
// Four rectangular islands: A (60 x 60, mountains above 290 except a flat 11 x 11 patch at
// x 40..50, y 30..40), B 55 x 55, C 50 x 50, D 46 x 46 (flat). A owns the first run of the list.
const BITS = 8, N = 1 << BITS;
const ISLANDS = [
  { x: 20, y: 10, w: 60, h: 60 },    // A, rows 10..69
  { x: 100, y: 10, w: 55, h: 55 },   // B
  { x: 20, y: 100, w: 50, h: 50 },   // C
  { x: 100, y: 100, w: 46, h: 46 },  // D
];

function synthTerrain(opt: { mountainA?: boolean; allBeach?: boolean }): AddonTerrain {
  const height = new Uint16Array(N * N).fill(120);
  ISLANDS.forEach((r, k) => {
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) height[y * N + x] = k === 0 && opt.mountainA ? 300 : 140;
  });
  if (opt.mountainA) for (let y = 30; y <= 40; y++) for (let x = 40; x <= 50; x++) height[y * N + x] = 200;
  const aoCls = new Uint8Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = y * N + x, land = height[i] > 120;
    let landNb = false, seaNb = false;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      if (height[((y + dy) & (N - 1)) * N + ((x + dx) & (N - 1))] > 120) landNb = true; else seaNb = true;
    }
    aoCls[i] = land ? (opt.allBeach || seaNb ? AO_CLASS_BEACH : height[i] > 290 ? 2 : 4) : landNb ? AO_CLASS_WATER : AO_CLASS_SEA;
  }
  return makeAddonTerrain(BITS, height, aoCls, new Uint8Array(N * N), 1);
}

// picks of "random island cell": [k, x offset] pairs of rand() values
const BAD_A = [0, 0];        // A, row 10, x 20: the footprint reaches into the sea
const FIT_A = [29, 29];      // A, row 39, x 49: the only T(9) site (and a T(4) site) on A
const FIT2_A = [28, 28];     // A, row 38, x 48: another T(4) site in the patch
const FIT_BCD = [31, 30];    // B/C/D (not owning the first run): run (31 - 1) = row y0 + 30, x x0 + 30
const repeat = (pair: number[], times: number) => Array.from({ length: times }, () => pair).flat();

test('10.2.1: the start search takes the first fitting one of c0..c99 and fails after c100 even if it fits', {}, () => {
  const t = synthTerrain({ mountainA: true });
  // c99 fits: taken
  let rand = new ScriptRand([...repeat(BAD_A, 99), ...FIT_A, ...repeat(FIT_BCD, 2)]);
  let r = populateIslands(t, rand, { resources: 1, players: [], animalTypes: 7 });
  assert.equal(r.ok, true, r.failure);
  assert.equal(rand.used, rand.script.length);
  // the (k - 1) rule puts B's start on row 40 and C's on row 130 (k mod m would give 41 / 131)
  assert.deepEqual(r.lists[4], [[49, 39], [130, 40], [50, 130]]);
  // c100 fits: picked and tested (two rand() each for c0..c100), but the builder fails
  rand = new ScriptRand([...repeat(BAD_A, 100), ...FIT_A]);
  r = populateIslands(t, rand, { resources: 1, players: [], animalTypes: 7 });
  assert.equal(r.ok, false);
  assert.equal(r.failure, 'Sowas. Riesen-Insel und kein Startpunkt.');
  assert.equal(rand.used, 202);
  assert.equal(rand.extra, 0, 'nothing drawn after c100');
});

test('10.2.2: an attempt picks c0..c50, c50 is never taken', {}, () => {
  const t = synthTerrain({ mountainA: true });
  // starts c0 on A, B, C (the three largest); then on A: attempt 0 = 50 failing picks + a
  // fitting c50 (not taken), attempt 1 starts with another fitting cell (taken)
  const rand = new ScriptRand([...FIT_A, ...repeat(FIT_BCD, 2), ...repeat(BAD_A, 50), ...FIT_A, ...FIT2_A]);
  const r = populateIslands(t, rand, { resources: 1, players: [], animalTypes: 7 });
  assert.equal(r.ok, true, r.failure);
  assert.equal(rand.used, rand.script.length);
  assert.deepEqual(r.lists[3][0], [48, 38], 'the first candidate comes from attempt 1, not from c50 of attempt 0');
});

test('10.3: a beach cell counts the chosen object but creates nothing', {}, () => {
  // every land cell is beach: clusters draw and count, but no nature object appears on land
  const t = synthTerrain({ allBeach: true });
  const r = populateIslands(t, new MsRand(4711), { resources: 1, players: [], animalTypes: 7 });
  assert.equal(r.ok, true, r.failure);
  assert.ok(r.lists[0].length > 0 && r.lists[1].length > 0, 'forest and stone patches were placed');
  const landNature = r.objects.filter(o => o.group === 6 && !(o.type >= 41 && o.type <= 45));
  assert.equal(landNature.length, 0);
  const s = r.beachSkips;
  assert.ok(s.trees > 0 && s.animals > 0 && s.bushes > 0 && s.stones > 0, JSON.stringify(s));
  assert.ok(r.objects.some(o => o.type >= 41 && o.type <= 45), 'fish still placed');
});

// ---------------------------------------------------------------- re-roll cycles (addon.md 9.5)
const skip = !HAS_GOLD && 'AN_GOLD data not found';
const PLAYERS = [{ race: 0, computer: false }, { race: 1, computer: true }, { race: 2, computer: true }];

test('re-roll: seeds whose chain cycles produce a valid world, deterministically', { skip }, () => {
  const gen = islandGenerator();
  const world = (seed: number) => generateIslandWorld(seed, 8, gen, { resources: 1, players: PLAYERS, animalTypes: 7 });
  for (const seed of [1003, 1214, 2016, 3345]) {
    const a = world(seed);
    assert.equal(a.result.ok, true);
    assert.ok(a.escapes >= 1, `seed ${seed} runs into a cycle`);
    assert.ok(a.result.islands.filter(b => b.size >= 2000).length >= 4);
    assert.ok(a.result.starts.every(s => s !== null));
    assert.ok(a.result.objects.filter(o => o.group !== 6).length === 3, 'player start objects');
    const b = world(seed);
    assert.equal(b.seed, a.seed);
    assert.deepEqual(b.result.objects, a.result.objects);
    assert.equal(b.terrain.randState, a.terrain.randState);
    // a save or a joining client rebuilds the terrain from the final seed
    const c = world(a.seed);
    assert.equal(c.seed, a.seed);
    assert.deepEqual(c.result.objects, a.result.objects);
  }
  // a chain without a cycle is the original's: no escape
  assert.equal(world(4242).escapes, 0);
});
