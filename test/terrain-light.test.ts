// Terrain light: docs/formats/terrain-gen.md step 5 (worked values hand-computed from the spec)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lightValue, computeLight, relight, type Terrain } from '../src/world/terrain.ts';

test('light value matches the worked table of step 5', {}, () => {
  const rows: [number, number, number][] = [
    [0, 0, 162], [1, 0, 169], [-1, 0, 155], [2, 0, 175], [-2, 0, 147], [4, 0, 188], [-4, 0, 132],
    [8, 0, 210], [-8, 0, 128], [16, 0, 239], [32, 0, 239], [100, 0, 220], [-100, 0, 128],
    [224, 0, 191], [0, 4, 160], [0, -4, 160], [0, 8, 155], [0, 16, 138], [0, -16, 138],
    [0, 32, 128], [8, 8, 202], [-4, 4, 130], [20, 20, 200],
  ];
  for (const [d1, d2, l] of rows) assert.equal(lightValue(d1, d2), l, `D1 ${d1} D2 ${d2}`);
});

test('light: y slope symmetric, x slope not; always within 128..239', {}, () => {
  for (let d1 = -300; d1 <= 300; d1 += 7)
    for (let d2 = 0; d2 <= 300; d2 += 11) {
      const l = lightValue(d1, d2);
      assert.ok(l >= 128 && l <= 239);
      assert.equal(lightValue(d1, -d2), l);
    }
  assert.equal(lightValue(65535, 0), 162);
  assert.equal(lightValue(-65535, 65535), 128);
});

function grid(bits: number, f: (x: number, y: number) => number): Terrain {
  const n = 1 << bits, height = new Uint16Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) height[(y << bits) | x] = f(x, y);
  return { sizeBits: bits, size: n, height, cls: new Uint8Array(n * n), tile: new Uint8Array(n * n), randState: 0 } as Terrain;
}

test('light uses the four direct neighbours: D1 = left - right (x), D2 = y+1 - y-1', {}, () => {
  const bits = 4, at = (x: number, y: number) => (y << bits) | x;
  // falling towards +x by 4 per cell: D1 = +8 -> lit
  assert.equal(computeLight(grid(bits, (x) => 100 - 4 * x))[at(5, 5)], 210);
  // rising towards +x: D1 = -8 -> clamped dark
  assert.equal(computeLight(grid(bits, (x) => 100 + 4 * x))[at(5, 5)], 128);
  // slope along y only, either direction: D2 = ±8
  assert.equal(computeLight(grid(bits, (_x, y) => 100 + 4 * y))[at(5, 5)], 155);
  assert.equal(computeLight(grid(bits, (_x, y) => 100 - 4 * y))[at(5, 5)], 155);
  // flat
  assert.equal(computeLight(grid(bits, () => 77))[at(3, 9)], 162);
  // a single raised cell: its right neighbour (x+1) sees D1 = +16 (lit), its left neighbour -16,
  // the cells above/below see D2 = ±16, the raised cell itself is flat-lit
  const t = grid(bits, (x, y) => (x === 6 && y === 6 ? 116 : 100));
  const l = computeLight(t);
  assert.equal(l[at(7, 6)], 239);
  assert.equal(l[at(5, 6)], 128);
  assert.equal(l[at(6, 5)], 138);
  assert.equal(l[at(6, 7)], 138);
  assert.equal(l[at(6, 6)], 162);
  assert.equal(l[at(8, 6)], 162);
});

test('light neighbours wrap at the map edges; relight only touches its rectangle', {}, () => {
  const bits = 4, n = 16, at = (x: number, y: number) => (y << bits) | x;
  const t = grid(bits, (x, y) => (x === n - 1 && y === 0 ? 116 : 100));
  const l = computeLight(t);
  assert.equal(l[at(0, 0)], 239);       // left neighbour (x = -1) wraps to x = 15
  assert.equal(l[at(n - 1, n - 1)], 138); // y + 1 wraps to y = 0
  const out = new Uint8Array(n * n);
  relight(t, out, -1, -1, 0, 0);
  assert.equal(out[at(0, 0)], 239);
  assert.equal(out[at(n - 1, n - 1)], 138);
  assert.equal(out[at(1, 1)], 0);
});
