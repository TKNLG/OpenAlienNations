// Aim cell of projectiles and the draw order of projectiles and impacts
// (docs/rendering/projectiles.md 1.1, 5.1; docs/rendering/objects.md 12.4).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aimCell, aimCandidates, aimDistance } from '../src/engine/aim.ts';
import { drawOrder, DrawKind, type DrawItem } from '../src/client/draw-order.ts';
import { Effects } from '../src/client/effects.ts';
import type { GameData } from '../src/client/data.ts';
import type { World } from '../src/engine/world.ts';

test('aim: distance is max + floor(min / 2) in whole cells', {}, () => {
  assert.equal(aimDistance(4, 1), 4);
  assert.equal(aimDistance(4, 0), 4);
  assert.equal(aimDistance(-3, 3), 4);
  assert.equal(aimDistance(1, -5), 5);
  assert.equal(aimDistance(2, 2), 3);
});

test('aim: candidates use the sizes transposed; square footprints give the four true corners', {}, () => {
  assert.deepEqual(aimCandidates(10, 20, 2, 2), [[10, 20], [10, 19], [9, 19], [9, 20]]);
  assert.deepEqual(aimCandidates(10, 20, 3, 3), [[10, 20], [10, 18], [8, 18], [8, 20]]);
  // 3x2 (size_x 3, size_y 2; footprint 8..10 x 19..20)
  assert.deepEqual(aimCandidates(10, 20, 3, 2), [[10, 20], [10, 18], [9, 18], [9, 19]]);
  // 2x3 (footprint 9..10 x 18..20)
  assert.deepEqual(aimCandidates(10, 20, 2, 3), [[10, 20], [10, 19], [8, 19], [8, 21]]);
  // 1x1: every candidate is the target's cell
  assert.deepEqual(aimCandidates(5, 6, 1, 1), [[5, 6], [5, 6], [5, 6], [5, 6]]);
});

test('aim: the examples of projectiles.md 1.1 (ties go to the front corner)', {}, () => {
  const rows: [number, number, [number, number], [number, number], [number, number]][] = [
    // shooter rel. (X, Y) = (0, 0)   2x2        3x2        2x3
    [4, 0, [0, 0], [0, 0], [0, 0]],
    [4, -1, [0, 0], [0, 0], [0, 0]],
    [3, -3, [0, 0], [0, -2], [0, 0]],
    [-1, 4, [0, 0], [0, 0], [-2, 1]],
    [-3, 3, [0, 0], [0, 0], [-2, 1]],
    [-5, 0, [-1, -1], [-1, -1], [-2, -1]],
    [0, -5, [0, -1], [0, -2], [0, -1]],
  ];
  for (const [px, py, a, b, c] of rows) {
    assert.deepEqual(aimCell(0, 0, 2, 2, px, py), a, `2x2 from (${px}, ${py})`);
    assert.deepEqual(aimCell(0, 0, 3, 2, px, py), b, `3x2 from (${px}, ${py})`);
    assert.deepEqual(aimCell(0, 0, 2, 3, px, py), c, `2x3 from (${px}, ${py})`);
  }
  // a unit (1x1) is aimed at its own cell
  assert.deepEqual(aimCell(7, 9, 1, 1, 0, 0), [7, 9]);
});

test('aim: deltas wrap the short way round the map', {}, () => {
  const n = 64;
  const wrap = (d: number) => (d > n / 2 ? d - n : d < -n / 2 ? d + n : d);
  // building at max corner (1, 1), 2x2 (footprint 0..1 x 0..1); shooter at (60, 1), four cells
  // beyond the x = 0 edge: candidates (0, 0) and (0, 1) are 4 away, the first of them wins
  assert.deepEqual(aimCell(1, 1, 2, 2, 60, 1, wrap), [0, 0]);
  // unwrapped every candidate is about 60 away and the front corner wins
  assert.deepEqual(aimCell(1, 1, 2, 2, 60, 1), [1, 1]);
});

test('draw order: an impact on the front corner is drawn over the building, one on another corner behind it', {}, () => {
  const house: DrawItem = { kind: DrawKind.Building, x: 10, y: 10, sx: 2, sy: 2 };
  const front: DrawItem = { kind: DrawKind.Effect, x: 10, y: 10 };
  const left: DrawItem = { kind: DrawKind.Effect, x: 10, y: 9 };
  const right: DrawItem = { kind: DrawKind.Effect, x: 9, y: 10 };
  const order = drawOrder([front, left, right, house]);
  const pos = (i: number) => order.indexOf(i);
  assert.ok(pos(0) > pos(3), 'front corner: after the building');
  assert.ok(pos(1) < pos(3) && pos(2) < pos(3), 'side corners: before the building');
  // a unit in front of the +x face is deferred after the building; an effect there is not
  const unit: DrawItem = { kind: DrawKind.Unit, x: 11, y: 9 };
  const fx: DrawItem = { kind: DrawKind.Effect, x: 11, y: 9 };
  const o2 = drawOrder([unit, fx, house]);
  assert.ok(o2.indexOf(0) > o2.indexOf(2) && o2.indexOf(1) < o2.indexOf(2));
});

// ---------------------------------------------------------------- the client: projectile sort cell

const G7 = 7 << 16;
function fxData(): GameData {
  const entry = { name: 'P', frames: 4, left: 0, top: 0 };
  const rules = new Map<number, unknown>([
    [(G7 | 0) >>> 0, { type: 0, sound: 0, soundAction: 0, soundFrame: 1, impact: 17 }],
    [(G7 | 17) >>> 0, { type: 17, sound: 0, soundAction: 0, soundFrame: 1, impact: -1 }],
  ]);
  const objects = new Map<number, unknown>([
    [(G7 | 0) >>> 0, { anchorX: 50, anchorY: 30, slots: ['P'], layers: [[{ speed: -1 }]] }],
    [(G7 | 17) >>> 0, { anchorX: 40, anchorY: 40, slots: ['E'], layers: [[{ speed: 10 }]] }],
  ]);
  return { rules, objects, sprites: { entry: (n: string) => ({ ...entry, name: n, frames: n === 'E' ? 10 : 4 }) } } as unknown as GameData;
}

test('effects: a projectile is ordered at its aim cell for the whole flight, the impact at the aim cell', {}, () => {
  const fx = new Effects(fxData());
  const heights = new Map<string, number>([['20,20', 150]]);
  fx.height = (x, y) => heights.get(`${x},${y}`) ?? 100;
  const target = { id: 7, x: 20 * 256 + 128, y: 20 * 256 + 128 };
  const w = { effects: [{ kind: 'shot', tick: 0, x: 10, y: 20, tx: 19, ty: 20, wait: 0, flight: 9, type: 0, target: 7 }],
    get: (id: number) => (id === 7 ? target : undefined), terrain: { size: 64 }, entities: [] } as unknown as World;
  fx.drain(w, 0, 0);
  let sawFlight = false, sawImpact = false;
  for (let k = 0; k <= 30; k++) {
    const t = k * 0.1, wall = k * 95;
    for (const d of fx.update(t, wall, 64)) {
      assert.deepEqual([d.cx, d.cy], [19, 20], 'sorted at the aim cell');
      if (d.entry.name === 'P') {
        sawFlight = true;
        assert.ok(d.x > 10 && d.x <= 19.5 + 1e-9, `ground point ${d.x} between start and aim`);
        assert.ok(d.h !== undefined && d.h >= 100 && d.h <= 150, `height ${d.h}`);
      } else sawImpact = true;
    }
  }
  assert.ok(sawFlight, 'drawn in flight');
  assert.ok(sawImpact, 'impact effect drawn');
});

test('effects: the flight ends at the target\'s own height', {}, () => {
  const fx = new Effects(fxData());
  // aim cell (19, 20) on terrain 100, target anchor (20, 20) at 150
  fx.height = (x, y) => (x === 20 && y === 20 ? 150 : 100);
  const target = { id: 7, x: 20 * 256, y: 20 * 256 };
  const w = { effects: [{ kind: 'shot', tick: 0, x: 19, y: 30, tx: 19, ty: 20, wait: 0, flight: 9, type: 0, target: 7 }],
    get: (id: number) => (id === 7 ? target : undefined), terrain: { size: 64 }, entities: [] } as unknown as World;
  fx.drain(w, 0, 0);
  let last: number | undefined;
  for (let k = 0; k < 9; k++) for (const d of fx.update(k * 0.1, k * 95, 64)) if (d.entry.name === 'P') last = d.h;
  assert.ok(last !== undefined && last > 140, `close to the target's height near the end (${last})`);
});
