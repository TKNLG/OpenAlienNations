// HD side-panel pictures from the world sprites (src/client/icon-fit.ts): area resampling, the
// placement fit, and the measured placements against the real data (Gold: AN_GOLD).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { GOLD, HAS_GOLD } from './helpers/mission.ts';
import { parseOd, type ObjectDesc } from '../src/formats/od.ts';
import { parseGdIndex, decodeGdFrames, type GdIndex } from '../src/formats/gd.ts';
import {
  premultiply, unpremultiply, resampleArea, imageError, fitIcon, composeLayers, renderHd, hdFactor,
  iconSource, ICON_FIT_MAX_ERR, UI_ICON_SOURCES, type Img, type IconSource,
} from '../src/client/icon-fit.ts';

/** a deterministic picture with edges, gradients and transparency */
function synthetic(w: number, h: number): Img {
  const rgba = new Uint8Array(w * h * 4);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const inside = (x - w / 2) ** 2 / (w * w / 5) + (y - h / 2) ** 2 / (h * h / 5) < 1;
    if (!inside) continue;
    rgba[i] = (x * 7 + ((y >> 3) & 1) * 90) & 255;
    rgba[i + 1] = (y * 5 + rnd() * 40) & 255;
    rgba[i + 2] = ((x ^ y) * 3) & 255;
    rgba[i + 3] = x % 23 < 3 ? 120 : 255;
  }
  return premultiply(rgba, w, h);
}

test('area resampling keeps coverage and colour', {}, () => {
  const rgba = new Uint8Array(40 * 30 * 4);
  for (let i = 0; i < rgba.length; i += 4) { rgba[i] = 200; rgba[i + 1] = 100; rgba[i + 2] = 50; rgba[i + 3] = 255; }
  const src = premultiply(rgba, 40, 30);
  const out = resampleArea(src, 0.25, 0, 0, 10, 8);
  // fully covered pixels: same colour; the last row covers source rows 28..31 of which 2 exist
  assert.deepEqual([...out.px.slice(0, 4)].map(Math.round), [200, 100, 50, 255]);
  const last = out.px.slice((7 * 10) * 4, (7 * 10) * 4 + 4);
  assert.deepEqual([...last].map(v => Math.round(v)), [100, 50, 25, 128]);
  // total alpha is conserved: 40 x 30 source pixels -> 1200 * s^2 output pixels
  let a = 0;
  for (let i = 3; i < out.px.length; i += 4) a += out.px[i];
  assert.ok(Math.abs(a / 255 - 1200 * 0.25 * 0.25) < 1e-3);
  // half-pixel offset: the first column averages transparency and colour half and half
  const half = resampleArea(src, 0.25, 0.5, 0, 10, 8);
  assert.equal(Math.round(half.px[3]), 128);
  // premultiply / unpremultiply round trip
  const back = unpremultiply(src);
  assert.deepEqual([...back.slice(0, 4)], [200, 100, 50, 255]);
});

test('fitIcon recovers scale and sub-pixel offset of a shrunk picture', {}, () => {
  const src = synthetic(210, 190);
  for (const [s, ox, oy] of [[0.27, 3.3, -1.7], [0.22, -2.4, 4.6], [0.35, -12.1, -8.25]]) {
    const icon = resampleArea(src, s, ox, oy, 45, 45);
    const f = fitIcon(icon, src);
    assert.ok(Math.abs(f.s - s) < 0.002, `s ${f.s} vs ${s}`);
    assert.ok(Math.abs(f.ox - ox) < 0.15 && Math.abs(f.oy - oy) < 0.15, `offset ${f.ox},${f.oy} vs ${ox},${oy}`);
    assert.ok(f.err < 0.5, `err ${f.err}`);
  }
  // a different picture does not fit
  const other = synthetic(150, 220);
  const f = fitIcon(resampleArea(other, 0.3, 0, 0, 45, 45), src);
  assert.ok(f.err > ICON_FIT_MAX_ERR, `unrelated picture err ${f.err}`);
});

test('HD rendering: device scale, capped at 4x and at the sprite resolution', {}, () => {
  assert.equal(hdFactor(1.875, 0.25), 1.875);
  assert.equal(hdFactor(8, 0.2), 4);
  assert.equal(hdFactor(3, 0.5), 2);
  assert.equal(hdFactor(0.5, 0.3), 1);
  const src = synthetic(210, 190);
  const fit = { s: 0.27, ox: 3.3, oy: -1.7, err: 0 };
  const hd = renderHd(src, fit, 45, 45, 2);
  assert.equal(hd.w, 90); assert.equal(hd.h, 90);
  // shrinking the HD picture by 2 gives the 1x picture
  const down = resampleArea(hd, 0.5, 0, 0, 45, 45);
  assert.ok(imageError(down, resampleArea(src, 0.27, 3.3, -1.7, 45, 45)) < 0.01);
});

// ---------------------------------------------------------------- real data

function archives(dir: string): { b: Uint8Array; gd: GdIndex }[] {
  return ['dv.gd', 'Addon.gd'].filter(n => existsSync(`${dir}/${n}`)).map(n => {
    const b = new Uint8Array(readFileSync(`${dir}/${n}`));
    return { b, gd: parseGdIndex(b, b.length) };
  });
}

test('measured placements reproduce the original pictures', { skip: !HAS_GOLD && 'AN_GOLD data not found' }, () => {
  const od = parseOd(new Uint8Array(readFileSync(`${GOLD}/dv.OD`)));
  for (const [k, v] of parseOd(new Uint8Array(readFileSync(`${GOLD}/Addon.od`)))) od.set(k, v);
  const arcs = archives(GOLD);
  const frame0 = (name: string, autoOpaque = false, list = arcs, f = 0) => {
    for (const a of list) {
      const e = a.gd.byName.get(name);
      if (e) return { e, px: decodeGdFrames(e, a.b.subarray(e.dataOffset, e.dataOffset + e.dataLength), f, false, autoOpaque)[f] };
    }
    throw new Error(`missing ${name}`);
  };
  const source = (d: ObjectDesc, slot: number, frames: number[] = []) => composeLayers(d.layers[slot]!.map((l, i) => {
    const { e, px } = frame0(l.name, false, arcs, frames[i] ?? 0);
    return { left: e.left, top: e.top, w: e.width, h: e.height, rgba: px };
  }));
  const check = (icon: Img, d: ObjectDesc, src: IconSource) => {
    const pic = source(d, src.slot, src.frames);
    return imageError(resampleArea(pic.img, src.s, src.ox + src.s * pic.left, src.oy + src.s * pic.top, icon.w, icon.h), icon);
  };
  let used = 0, kept = 0;
  for (let race = 0; race < 3; race++) for (let type = 9; type <= 67; type++) {
    const mi = od.get(((race + 3) << 16) | type);
    if (!mi) continue;
    const src = iconSource(race, type);
    if (!src) { kept++; continue; }
    const { e, px } = frame0(mi.slots[0]!);
    const err = check(premultiply(px, e.width, e.height), od.get((race << 16) | type)!, src);
    assert.ok(err <= 9, `${mi.slots[0]}: error ${err.toFixed(2)}`);
    used++;
  }
  assert.equal(used, 71);
  assert.equal(used + kept, 3 * 59);   // types 9..67 of every race
  // a Sajiki picture that is a separate render: no placement reproduces it
  const saj = frame0(od.get((5 << 16) | 37)!.slots[0]!);
  const f = fitIcon(premultiply(saj.px, saj.e.width, saj.e.height), source(od.get((2 << 16) | 37)!, 1).img);
  assert.ok(f.err > ICON_FIT_MAX_ERR, `Sajiki house err ${f.err}`);
  // interface.gd pictures (tree, palm)
  for (const race of ['Amazons', 'Pimons', 'Sajiki']) {
    const b = new Uint8Array(readFileSync(`${GOLD}/${race}/interface.gd`));
    const ui = [{ b, gd: parseGdIndex(b, b.length) }];
    for (const u of UI_ICON_SOURCES) {
      const { e, px } = frame0(u.name, true, ui);
      const err = check(premultiply(px, e.width, e.height), od.get(u.oid)!, u);
      assert.ok(err <= 4, `${race} ${u.name}: error ${err.toFixed(2)}`);
    }
  }
});
