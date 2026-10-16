// Determinism and pathfinding tests for the simulation core (no game data needed).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, SUB } from '../src/engine/world.ts';
import { findPath } from '../src/engine/path.ts';
import type { Terrain } from '../src/world/terrain.ts';
import type { MapObject } from '../src/formats/mission.ts';

function flatTerrain(bits: number): Terrain {
  const n = 1 << bits;
  return { sizeBits: bits, size: n, height: new Uint16Array(n * n).fill(128), cls: new Uint8Array(n * n), tile: new Uint8Array(n * n) };
}

// owner = race (group); settlement id 1
const unit = (x: number, y: number, race = 0): MapObject => ({ cls: 0, group: race, type: 9, owner: 1, x, y, z: 0 });

test('path goes around a wall', { skip: false }, () => {
  const bits = 5, n = 32;
  const blocked = new Uint8Array(n * n);
  for (let y = 2; y < 30; y++) blocked[(y << bits) | 10] = 1; // vertical wall at x = 10
  const p = findPath(blocked, bits, 5, 15, 15, 15)!;
  assert.ok(p, 'path found');
  const last = p[p.length - 1];
  assert.equal(last[0], 15); assert.equal(last[1], 15);
  for (const [x, y] of p) assert.equal(blocked[(y << bits) | x], 0, `path crosses wall at ${x},${y}`);
});

test('path uses wrap-around when shorter', { skip: false }, () => {
  const bits = 5;
  const p = findPath(new Uint8Array(1024), bits, 1, 1, 30, 1)!;
  assert.equal(p.length, 3); // 1 -> 0 -> 31 -> 30
});

test('identical commands give identical state (lockstep determinism)', { skip: false }, () => {
  const run = () => {
    const w = new World(flatTerrain(6), [unit(5, 5), unit(6, 5), unit(20, 20, 1)]);
    w.schedule({ type: 'move', player: 0, ids: [1, 2], x: 40, y: 30 }, 3);
    w.schedule({ type: 'move', player: 1, ids: [3], x: 2, y: 60 }, 3);
    w.schedule({ type: 'move', player: 0, ids: [3], x: 9, y: 9 }, 4); // not owner: ignored
    const hashes: number[] = [];
    for (let i = 0; i < 900; i++) { w.step(); if (i % 50 === 0) hashes.push(w.hash()); }
    return { hashes, e1: w.get(1)!, e3: w.get(3)! };
  };
  const a = run(), b = run();
  assert.deepEqual(a.hashes, b.hashes);
  assert.equal(Math.floor(a.e1.x / SUB), 40);
  assert.equal(Math.floor(a.e1.y / SUB), 30);
  assert.equal(Math.floor(a.e3.x / SUB), 2);
  assert.equal(Math.floor(a.e3.y / SUB), 60);
});

test('snapshot + restore continues identically', { skip: false }, () => {
  const make = () => new World(flatTerrain(6), [unit(5, 5), unit(6, 5), unit(20, 20, 1)]);
  const a = make();
  a.schedule({ type: 'move', player: 0, ids: [1, 2], x: 40, y: 30 }, 3);
  for (let i = 0; i < 60; i++) a.step();
  const snap = JSON.parse(JSON.stringify(a.snapshot()));
  const b = World.restore(flatTerrain(6), snap);
  assert.equal(b.hash(), a.hash());
  for (let i = 0; i < 200; i++) { a.step(); b.step(); }
  assert.equal(b.hash(), a.hash());
});
