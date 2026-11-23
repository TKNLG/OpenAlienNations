// HD art levels and the HD pack's content check (docs/ui/side-panel.md "HD art"): pack images are
// used only for pictures with the pixels they were made from (other language editions change some
// pictures under the same names, docs/game/editions.md); the setting has three levels and older
// boolean settings migrate; generated pictures are placed by their opaque box.
// The data-driven parts need AN_DATA (German GOG install); AN_DATA_EN (an English GOG install)
// additionally checks that its dressed Amazon portraits get no German pack image.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { DATA } from './helpers/mission.ts';
import { parseGdIndex, decodeGdFrames, pixelHash } from '../src/formats/gd.ts';
import { pickPackKey, type HdManifest } from '../src/client/hd-pack.ts';
import { migrate, type Settings } from '../src/client/frontend/settings.ts';
import { boxFit, worldSlot } from '../src/client/icon-fit.ts';

const MANIFEST = JSON.parse(readFileSync(new URL('../hd/manifest.json', import.meta.url), 'utf8')) as HdManifest;
const skip = !existsSync(`${DATA}/dv.gd`) && 'AN_DATA not set';
const EN = process.env.AN_DATA_EN;
const skipEn = !(EN && existsSync(`${EN}/dv.gd`)) && 'AN_DATA_EN not set';

test('pack lookup: the checksum decides, under any stored variant', {}, () => {
  const m: HdManifest = {
    scale: 4,
    items: { 'dv.gd|A|0|100': 'a100.webp', 'dv.gd|A|0|200': 'a200.webp', 'dv.gd|B|0|50': 'b.webp' },
    hash: { 'dv.gd|A|0|100': 'h1', 'dv.gd|A|0|200': 'h2', 'dv.gd|B|0|50': 'h3' },
  };
  assert.equal(pickPackKey(m, 'dv.gd', 'A', 0, 100, 'h1'), 'dv.gd|A|0|100');
  // same name and length, other pixels (an edition changed the picture): no pack image
  assert.equal(pickPackKey(m, 'dv.gd', 'B', 0, 50, 'other'), undefined);
  // stored with another length but the same pixels: the matching variant
  assert.equal(pickPackKey(m, 'dv.gd', 'A', 0, 999, 'h2'), 'dv.gd|A|0|200');
  assert.equal(pickPackKey(m, 'dv.gd', 'A', 1, 100, 'h1'), undefined);
  // a pack without checksums (older --hd folder): by key as before
  const old: HdManifest = { scale: 4, items: { 'dv.gd|A|0|100': 'a.webp' } };
  assert.equal(pickPackKey(old, 'dv.gd', 'A', 0, 100, 'anything'), 'dv.gd|A|0|100');
  assert.equal(pickPackKey(old, 'dv.gd', 'A', 0, 101, 'anything'), undefined);
});

test('pixelHash tells pictures apart and is stable', {}, () => {
  const a = new Uint8Array(45 * 45 * 4).fill(7), b = a.slice();
  b[1234] = 8;
  assert.equal(pixelHash(a), pixelHash(a.slice()));
  assert.ok(pixelHash(a) !== pixelHash(b));
  assert.ok(/^[0-9a-f]{16}$/.test(pixelHash(a)));
});

/** the portrait keys of the manifest and the decoded pictures of one install's dv.gd */
function portraits(dir: string) {
  const buf = readFileSync(`${dir}/dv.gd`);
  const idx = parseGdIndex(buf, statSync(`${dir}/dv.gd`).size);
  return Object.keys(MANIFEST.items).filter(k => k.startsWith('dv.gd|')).flatMap(k => {
    const [, name, frame] = k.split('|');
    const e = idx.byName.get(name);
    if (!e) return [];
    const px = decodeGdFrames(e, buf.subarray(e.dataOffset, e.dataOffset + e.dataLength))[+frame];
    return [{ key: k, name, frame: +frame, len: e.dataLength, hash: pixelHash(px) }];
  });
}

test('the shipped pack: every German portrait finds its own image (client and pack tool agree)', { skip }, () => {
  assert.ok(MANIFEST.hash, 'the manifest carries checksums');
  const list = portraits(DATA).filter(p => MANIFEST.items[`dv.gd|${p.name}|${p.frame}|${p.len}`]);
  assert.ok(list.length > 150);
  for (const p of list) assert.equal(pickPackKey(MANIFEST, 'dv.gd', p.name, p.frame, p.len, p.hash), `dv.gd|${p.name}|${p.frame}|${p.len}`, p.name);
});

test('English edition: the dressed Amazon portraits keep their own pictures', { skip: skipEn }, () => {
  const list = portraits(EN!);
  const used = list.filter(p => pickPackKey(MANIFEST, 'dv.gd', p.name, p.frame, p.len, p.hash));
  const refused = list.filter(p => !pickPackKey(MANIFEST, 'dv.gd', p.name, p.frame, p.len, p.hash)).map(p => p.name);
  assert.equal(refused.length, 14, refused.join(', '));
  assert.ok(refused.every(n => n.startsWith('BIAZ\\MI\\')));
  assert.ok(used.length > 140, 'unchanged pictures keep their HD image');
});

test('settings: the HD level and older boolean settings', {}, () => {
  const base = { hd: 'all' } as Settings;
  assert.equal(migrate({ ...base, hd: true as unknown as Settings['hd'] }).hd, 'all');
  assert.equal(migrate({ ...base, hd: false as unknown as Settings['hd'] }).hd, 'off');
  assert.equal(migrate({ ...base, hd: 'partly' }).hd, 'partly');
  assert.equal(migrate({ ...base, hd: 'nonsense' as unknown as Settings['hd'] }).hd, 'all');
});

test('box placement: largest fit, centred, standing on the bottom edge', {}, () => {
  // a 100 x 50 sprite box into a 40 x 40 picture box at (2, 3): width limits, s = 0.4
  const f = boxFit([2, 3, 42, 43], [10, 20, 110, 70]);
  assert.ok(Math.abs(f.s - 0.4) < 1e-9);
  assert.ok(Math.abs(f.s * 10 + f.ox - 2) < 1e-9, 'left edge');
  assert.ok(Math.abs(f.s * 110 + f.ox - 42) < 1e-9, 'right edge');
  assert.ok(Math.abs(f.s * 70 + f.oy - 43) < 1e-9, 'bottom edge');
  assert.equal(worldSlot(40), 1);
  assert.equal(worldSlot(65), 5);
  assert.equal(worldSlot(9), undefined);
});
