// Minimap formulas: docs/ui/side-panel.md 6.1 and 6.3
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markerRadius, groundImage, MM } from '../src/client/minimap.ts';

test('viewport marker radius matches the table of 6.3', {}, () => {
  const rows: [number, number, number[]][] = [
    [832, 16, [17, 9, 5]], [832, 40, [26, 14, 8]], [832, 64, [64, 33, 17]],
    [608, 16, [13, 7, 4]], [608, 40, [19, 10, 6]], [608, 64, [48, 25, 13]],
  ];
  for (const [w, v, rs] of rows) [128, 256, 512].forEach((n, k) => assert.equal(markerRadius(w, 80 - v, n), rs[k], `w ${w} v ${v} map ${n}`));
});

test('ground image: flat single-colour map gives the flat shade, blurred and quantised', {}, () => {
  const n = 256, bits = 8;
  const tile = { width: 2, height: 2, weight: 1, rgba: new Uint8Array([100, 200, 40, 255, 100, 200, 40, 255, 100, 200, 40, 255, 100, 200, 40, 255]) };
  const sets = new Map([['wiese', { tiles: [tile] }]]) as never;
  const t = { sizeBits: bits, size: n, height: new Uint16Array(n * n).fill(128), cls: new Uint8Array(n * n), tile: new Uint8Array(n * n) } as never;
  const g = groundImage(t, sets);
  assert.equal(g.length, MM * MM * 3);
  // 100*192/255 = 75 -> & 0xf8 = 72; 200*192/255 = 150 -> & 0xfc = 148; 40*192/255 = 30 -> & 0xf8 = 24
  assert.deepEqual([g[0], g[1], g[2]], [72, 148, 24]);
});
