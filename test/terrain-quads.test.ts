// Terrain quad layout and shoreline choice per coast direction.
// Spec: docs/rendering/terrain-drawing.md ("Tiles belong to vertices", "Choosing what to draw").

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { Camera } from '../src/client/camera.ts';
import {
  QUAD_CORNERS, QUAD_EMIT, QUAD_TRIANGLES, SHORE_MASKS, SET_ID, SET_WEG, SET_ANIMATED_WATER, chooseQuad, shoreTileOf,
} from '../src/client/terrain-quads.ts';
import { parseOs } from '../src/formats/os.ts';

const W = SET_ANIMATED_WATER, L = SET_WEG;
/** screen position of quad corner k of cell (0, 0) on flat ground */
const screen = (k: number) => Camera.project(QUAD_CORNERS[k].dx, QUAD_CORNERS[k].dy, 128);

test('corners: c0 bottom, c1 right, c2 left, c3 top; texture (0,0) at the bottom', {}, () => {
  const [b, r, l, t] = [0, 1, 2, 3].map(screen);
  assert.ok(b[1] > r[1] && b[1] > l[1] && b[1] > t[1], 'c0 is the lowest corner');
  assert.ok(r[0] > b[0] && r[0] > t[0] && r[0] > l[0], 'c1 is the rightmost corner');
  assert.ok(l[0] < b[0] && l[0] < t[0], 'c2 is the leftmost corner');
  assert.ok(t[1] < r[1] && t[1] < l[1], 'c3 is the top corner');
  assert.deepEqual(QUAD_CORNERS.map(c => [c.u, c.v]), [[0, 0], [1, 0], [0, 1], [1, 1]]);
});

test('triangles: the quad is split along its left-right diagonal', {}, () => {
  assert.deepEqual(QUAD_EMIT, [2, 3, 1, 0]); // left, top, right, bottom
  const tri = (i: number) => QUAD_TRIANGLES.slice(i * 3, i * 3 + 3).map(e => QUAD_EMIT[e]).sort();
  assert.deepEqual(tri(0), [1, 2, 3]); // left, top, right
  assert.deepEqual(tri(1), [0, 1, 2]); // left, right, bottom
});

test('shoreline table: water corners per tile after the byte reorder', {}, () => {
  // bit k = corner ck is water
  assert.deepEqual(SHORE_MASKS, [
    0b1100, 0b1010, 0b0011, 0b0101,
    0b1000, 0b0010, 0b0001, 0b0100,
    0b1110, 0b1011, 0b0111, 0b1101,
    0b0110, 0b1001,
  ]);
  assert.equal(new Set(SHORE_MASKS).size, 14);
  assert.equal(shoreTileOf(0), -1);
  assert.equal(shoreTileOf(15), -1);
});

/** set ids c0..c3 of the quad at cell (0,0) when the vertices for which `water(x, y)` holds are water */
function quadSets(water: (x: number, y: number) => boolean): number[] {
  return QUAD_CORNERS.map(c => (water(c.dx, c.dy) ? W : L));
}

test('coast directions: each picks the tile whose water side faces the water', {}, () => {
  // straight coasts (water side in map terms; screen: +x down-left, +y down-right)
  const cases: [string, (x: number, y: number) => boolean, number][] = [
    ['water down-right (+y)', (_x, y) => y >= 1, 2],
    ['water up-left (-y)', (_x, y) => y <= 0, 0],
    ['water up-right (-x)', (x) => x <= 0, 1],
    ['water down-left (+x)', (x) => x >= 1, 3],
    // one water corner
    ['water at the bottom corner', (x, y) => x === 1 && y === 1, 6],
    ['water at the right corner', (x, y) => x === 0 && y === 1, 5],
    ['water at the left corner', (x, y) => x === 1 && y === 0, 7],
    ['water at the top corner', (x, y) => x === 0 && y === 0, 4],
    // one land corner
    ['land at the bottom corner', (x, y) => !(x === 1 && y === 1), 8],
    ['land at the left corner', (x, y) => !(x === 1 && y === 0), 9],
    ['land at the top corner', (x, y) => !(x === 0 && y === 0), 10],
    ['land at the right corner', (x, y) => !(x === 0 && y === 1), 11],
    // diagonal
    ['water left and right', (x, y) => x !== y, 12],
    ['water top and bottom', (x, y) => x === y, 13],
  ];
  for (const [name, water, tile] of cases) {
    const q = chooseQuad(quadSets(water));
    assert.deepEqual(q, { kind: 'shore', tile }, name);
    // the chosen tile's water corners are exactly the water vertices
    const mask = SHORE_MASKS[tile];
    QUAD_CORNERS.forEach((c, k) => assert.equal(!!(mask & (1 << k)), water(c.dx, c.dy), `${name}: corner c${k}`));
  }
});

test('quad choice: plain tile, blends and when no shoreline is drawn', {}, () => {
  assert.deepEqual(chooseQuad([W, W, W, W]), { kind: 'single' });
  assert.deepEqual(chooseQuad([SET_ID.wiese, SET_ID.wiese, SET_ID.wiese, SET_ID.wiese]), { kind: 'single' });
  assert.deepEqual(chooseQuad([SET_ID.wasser1, SET_ID.wasser1, SET_ID.wasser1, SET_ID.wasser1]), { kind: 'single' }, 'add-on open sea');
  assert.deepEqual(chooseQuad([SET_ID.wiese, SET_ID.weg, SET_ID.wiese, SET_ID.wiese]), { kind: 'blend' });
  // land that is not weg next to water: bilinear blend, no shoreline
  assert.deepEqual(chooseQuad([W, W, SET_ID.wiese, SET_ID.weg]), { kind: 'blend' });
  // add-on: open sea (static wasser1) next to the animated coastal ring is a blend of two water tiles
  assert.deepEqual(chooseQuad([SET_ID.wasser1, W, W, W]), { kind: 'blend' });
  assert.deepEqual(chooseQuad([SET_ID.wasser1, L, W, W]), { kind: 'blend' });
});

const DIRS = [process.env.AN_GOLD, process.env.AN_DATA].filter((d): d is string => !!d && existsSync(`${d}/transition1.os`));
test('shoreline table matches the water corners painted in transition1..4', { skip: DIRS.length === 0 && 'no game data' }, () => {
  for (const dir of DIRS)
    for (let f = 1; f <= 4; f++) {
      const set = parseOs(readFileSync(`${dir}/transition${f}.os`));
      assert.equal(set.tiles.length, 14);
      set.tiles.forEach((t, i) => {
        let mask = 0;
        QUAD_CORNERS.forEach((c, k) => {
          const px = c.u ? 59 : 4, py = c.v ? 59 : 4, o = (py * t.width + px) * 4;
          const r = t.rgba[o], g = t.rgba[o + 1], b = t.rgba[o + 2];
          if (b > r + 40 && b > g + 20) mask |= 1 << k;
        });
        assert.equal(mask, SHORE_MASKS[i], `${dir} transition${f} tile ${i}`);
      });
    }
});
