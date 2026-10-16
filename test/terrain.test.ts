// Checks the TypeScript terrain generator byte-for-byte against reference hashes produced by
// the independently written, map-validated Python prototype (tools/terrain_proto.py).
// Needs the game data: set AN_DATA to the game's Data folder. Skipped otherwise.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseMdb } from '../src/formats/mission.ts';
import { parseOs } from '../src/formats/os.ts';
import { generateTerrain, CLASS_TILESET } from '../src/world/terrain.ts';

const DATA = process.env.AN_DATA ?? '';
const ref = JSON.parse(readFileSync(new URL('./terrain-ref.json', import.meta.url), 'utf8')) as
  Record<string, { seed: number; bits: number; cls: string; tile: string; height: string }>;

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

test('terrain matches the validated prototype', { skip: !existsSync(`${DATA}/dv.gd`) && 'AN_DATA not set' }, () => {
  const pick = CLASS_TILESET.map(name => parseOs(readFileSync(`${DATA}/${name}.os`)).pick);
  for (const [key, r] of Object.entries(ref)) {
    const [mdb, no] = key.split('#');
    const m = parseMdb(readFileSync(`${DATA}/${mdb}`))[Number(no)];
    assert.equal(m.seed, r.seed, key);
    assert.equal(m.sizeBits, r.bits, key);
    const t = generateTerrain(m.seed, m.sizeBits, pick);
    assert.equal(sha(t.cls), r.cls, `${key} classes`);
    assert.equal(sha(new Uint8Array(t.height.buffer)), r.height, `${key} heights`);
    assert.equal(sha(t.tile), r.tile, `${key} tiles`);
  }
});
