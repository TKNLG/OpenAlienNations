// Free-play world populator (docs/formats/world-populate.md) on generated terrain.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseMdb } from '../src/formats/mission.ts';
import { parseOs } from '../src/formats/os.ts';
import { parseOdb } from '../src/formats/odb.ts';
import { generateTerrain, CLASS_TILESET, CLASS_WATER } from '../src/world/terrain.ts';
import { generateWorld } from '../src/world/populate.ts';
import { World } from '../src/engine/world.ts';
import { DATA, setupOf } from './helpers/mission.ts';

const skip = !DATA;

function build(seed: number, bits: number, resources: number) {
  const pick = CLASS_TILESET.map(name => parseOs(readFileSync(`${DATA}/${name}.os`)).pick);
  return generateWorld(seed, bits, (s, b) => generateTerrain(s, b, pick), {
    resources,
    players: [{ race: 0, computer: true }, { race: 1, computer: false }, { race: 2, computer: true }],
    humanTownHall: true,
  });
}

test('populator: nature on free land, start positions far apart, deterministic', { skip }, () => {
  for (const bits of [7, 8, 9]) {
    const t0 = performance.now();
    const a = build(1234, bits, 2);
    const ms = performance.now() - t0;
    const b = build(1234, bits, 2);
    assert.equal(a.result.ok, true);
    assert.deepEqual(a.result.objects, b.result.objects);
    const n = a.terrain.size, mask = n - 1;
    const nature = a.result.objects.filter(o => o.cls === 2);
    const cells = new Set<number>();
    for (const o of nature) {
      const i = ((o.y & mask) << a.terrain.sizeBits) | (o.x & mask);
      assert.ok(a.terrain.cls[i] !== CLASS_WATER, 'no nature on water');
      assert.ok(a.terrain.height[i] <= 250, 'no nature on mountains');
      assert.ok(!cells.has(i), 'one object per cell');
      cells.add(i);
    }
    const kinds = (lo: number, hi: number) => nature.filter(o => o.type >= lo && o.type <= hi).length;
    const starts = a.result.starts.filter(s => s) as [number, number][];
    assert.equal(starts.length, 3);
    const axis = (d: number) => Math.min(Math.abs(d), n - Math.abs(d));
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) {
      const dx = axis(starts[i][0] - starts[j][0]), dy = axis(starts[i][1] - starts[j][1]);
      assert.ok(Math.max(dx, dy) + (Math.min(dx, dy) >> 1) > n / 3 - 10, 'starts far apart');
    }
    console.log(`n=${n} seed=${a.seed}: trees ${kinds(9, 12)} bushes ${kinds(13, 16)} stones ${kinds(29, 32)} animals ${kinds(33, 37)}, ${ms.toFixed(0)} ms`);
    assert.ok(kinds(9, 12) > 20 && kinds(29, 32) > 5 && kinds(13, 16) > 5 && kinds(33, 36) > 3);
  }
});

test('populator: free-play world starts with a working town per race', { skip }, () => {
  const m = parseMdb(readFileSync(`${DATA}/Infinite.mdb`))[1];
  const gen = build(777, 8, 1);
  const rules = parseOdb(readFileSync(`${DATA}/dv.odb`));
  const w = new World(gen.terrain, gen.result.objects, rules, { ...setupOf(m), orders: [] });
  const towns = w.economy.towns.filter(t => t.alive);
  assert.equal(towns.length, 3);
  for (let i = 0; i < 1500; i++) w.step();
  for (const t of towns) assert.ok(t.population >= 4, `town of race ${t.race} has its start set`);
});
