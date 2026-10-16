// Side-panel button looks (side-panel.md 3.1): a 50:50 mix with the look's tint colour, alpha kept.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tintRgba, lookOf, mixChannel, TINT_COLOUR } from '../src/client/ui-tint.ts';

const px = (...v: number[]) => new Uint8ClampedArray(v);

test('dim look: the sprite at half brightness, colours kept (not a black silhouette)', {}, () => {
  const p = px(200, 100, 50, 255, 255, 255, 255, 128);
  tintRgba(p, 'dim');
  assert.deepEqual([...p], [100, 50, 25, 255, 127, 127, 127, 128]);
});

test('hover look: mix with (150,150,255); off look: mix with (128,0,0); normal unchanged', {}, () => {
  assert.deepEqual(TINT_COLOUR.hover, [150, 150, 255]);
  const h = px(0, 0, 0, 255, 255, 255, 255, 255);
  tintRgba(h, 'hover');
  assert.deepEqual([...h], [75, 75, 127, 255, 202, 202, 254, 255]);
  const o = px(100, 100, 100, 7);
  tintRgba(o, 'off');
  assert.deepEqual([...o], [114, 50, 50, 7], 'alpha untouched');
  const n = px(1, 2, 3, 4);
  tintRgba(n, 'normal');
  assert.deepEqual([...n], [1, 2, 3, 4]);
  assert.equal(mixChannel(201, 150), 175);
});

test('look order: hover (clickable, not a picture), then dim (0x08 / 0x20), then off (0x10)', {}, () => {
  assert.equal(lookOf({}, true), 'hover');
  assert.equal(lookOf({ disabled: true }, true), 'dim', 'disabled: tooltip only, no hover look');
  assert.equal(lookOf({ dark: true }, true), 'hover', '0x20 alone stays clickable');
  assert.equal(lookOf({ off: true }, true), 'hover');
  assert.equal(lookOf({ picture: true }, true), 'normal', 'pictures have the hover look switched off');
  assert.equal(lookOf({ picture: true, off: true }, true), 'off');
  assert.equal(lookOf({ picture: true, dark: true }, false), 'dim');
  assert.equal(lookOf({ disabled: true, off: true }, false), 'dim');
});
