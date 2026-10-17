// Terrain brightness: per-corner grey level, 4-bit texels, the brightness factor and the
// software renderer's combine. Spec: docs/rendering/terrain-drawing.md "Brightness",
// docs/game/fog-of-war.md 5.1.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SHADE_EXPLORED, SHADE_UNEXPLORED, SHADE_VISIBLE, blendNibble, brightnessFactor, cornerGrey,
  smoothChannel, softwareChannel, softwarePixel, texelAt, texelNibble,
} from '../src/client/terrain-shade.ts';

test('corner grey level: L in sight or fog off, L >> 1 explored, 0 never explored', {}, () => {
  for (const L of [128, 161, 162, 191, 239]) {
    assert.equal(cornerGrey(L, SHADE_VISIBLE), L);
    assert.equal(cornerGrey(L, SHADE_EXPLORED), L >> 1);
    assert.equal(cornerGrey(L, SHADE_UNEXPLORED), 0);
  }
  // integer halving, not rounding
  assert.equal(cornerGrey(162, SHADE_EXPLORED), 81);
  assert.equal(cornerGrey(161, SHADE_EXPLORED), 80);
  assert.equal(cornerGrey(239, SHADE_EXPLORED), 119);
});

test('tile texels are cut to their top nibble', {}, () => {
  assert.equal(texelNibble(255), 15);
  assert.equal(texelNibble(0xF0), 15);
  assert.equal(texelNibble(0xEF), 14);
  assert.equal(texelNibble(0x0F), 0);
  assert.equal(texelNibble(0x80), 8);
  // same as v & 0xF0 in 8-bit terms
  for (let v = 0; v < 256; v++) assert.equal(texelNibble(v) << 4, v & 0xF0);
});

test('nearest texel: columns 0..63, rows 0..63.75', {}, () => {
  assert.deepEqual(texelAt(0, 0), [0, 0]);
  assert.deepEqual(texelAt(1, 1), [63, 63]);
  assert.deepEqual(texelAt(0.5, 0.5), [31, 31]);
  assert.deepEqual(texelAt(0.999, 0.995), [62, 63]);
});

test('transition blend: corner texels at the corners, 4-bit integer result', {}, () => {
  assert.equal(blendNibble(15, 0, 0, 0, 0, 0), 15);
  assert.equal(blendNibble(0, 15, 0, 0, 63, 0), 15);
  assert.equal(blendNibble(0, 0, 15, 0, 0, 63), 15);
  assert.equal(blendNibble(0, 0, 0, 15, 63, 63), 15);
  // centre-ish: (15 * 32 * 32 + 0 ...) / 3969 truncated
  assert.equal(blendNibble(15, 0, 0, 0, 31, 31), Math.floor(15 * 32 * 32 / 3969));
  assert.equal(blendNibble(7, 7, 7, 7, 20, 40), 7);
});

test('brightness factor is g / 256: absolute, not relative to flat ground', {}, () => {
  assert.equal(brightnessFactor(256), 1);
  assert.equal(brightnessFactor(128), 0.5);
  assert.ok(Math.abs(brightnessFactor(162) - 0.633) < 0.001);
  assert.ok(Math.abs(brightnessFactor(239) - 0.934) < 0.001);
  assert.ok(Math.abs(brightnessFactor(81) - 0.316) < 0.001);
  assert.equal(smoothChannel(255, 128), 127.5);
  assert.equal(smoothChannel(200, 0), 0);
});

test('software combine: (v & 0xF0) x g / 256, truncated to 5-6-5', {}, () => {
  // g a multiple of 4: no dither, exact 5-6-5 levels
  // white, g = 160: s = 40, p = 600: red 600 >> 5 = 18 -> 144, green 600 >> 4 = 37 -> 148
  assert.deepEqual(softwarePixel([255, 255, 255], 160), [144, 148, 144]);
  assert.deepEqual(softwarePixel([0, 0, 0], 239), [0, 0, 0]);
  assert.deepEqual(softwarePixel([255, 255, 255], 0), [0, 0, 0]);
  // flat ground, g = 162: s alternates 40 / 41 (mean 40.5): red (144 + 152) / 2, green (148 + 152) / 2
  assert.deepEqual(softwarePixel([255, 255, 255], 162), [148, 150, 148]);
  // never brighter than the formula, at most one 5-bit step (8) darker, for every texel and g
  for (let v = 0; v < 256; v += 5)
    for (let g = 0; g <= 239; g++) {
      const ideal = (v & 0xF0) * g / 256;
      const r = softwareChannel(texelNibble(v), g, 5), gr = softwareChannel(texelNibble(v), g, 6);
      assert.ok(r <= ideal + 1e-9 && r > ideal - 8, `red v=${v} g=${g}: ${r} vs ${ideal}`);
      assert.ok(gr <= ideal + 1e-9 && gr > ideal - 4, `green v=${v} g=${g}: ${gr} vs ${ideal}`);
    }
  // the low nibble of the tile byte never matters
  assert.deepEqual(softwarePixel([0x8F, 0x4F, 0xFF], 200), softwarePixel([0x80, 0x40, 0xF0], 200));
});
