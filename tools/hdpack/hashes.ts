// Adds the content checksum (src/formats/gd.ts pixelHash) of every HD pack image's source picture
// to hd/manifest.json ("hash": {key: hex}). The client uses a pack image only for a picture with
// that exact checksum, under any of the entry's variants (docs/ui/side-panel.md "HD art").
// Decoding follows the client: menu backgrounds opaque, interface/menu art auto-opaque, world
// portraits plain.
//   node --experimental-strip-types tools/hdpack/hashes.ts --game <Data folder> [--game ...] [--manifest hd/manifest.json]
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseGdIndex, decodeGdFrames, pixelHash, type GdEntry } from '../../src/formats/gd.ts';

const OPAQUE = new Set(['MAINMENU', 'RASSENWAHL', 'BRIEFINGSCREEN', 'LOADING']);
const args = process.argv.slice(2);
const games: string[] = [];
let manPath = 'hd/manifest.json';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--game') games.push(args[++i]);
  else if (args[i] === '--manifest') manPath = args[++i];
}
if (!games.length) { console.error('usage: hashes.ts --game <Data folder> [--game ...]'); process.exit(1); }

/** case-insensitive path inside a Data folder */
function find(dir: string, rel: string): string | undefined {
  let cur = dir;
  for (const part of rel.split('/')) {
    const hit = readdirSync(cur).find(n => n.toLowerCase() === part.toLowerCase());
    if (!hit) return undefined;
    cur = join(cur, hit);
  }
  return cur;
}

const man = JSON.parse(readFileSync(manPath, 'utf8')) as { items: Record<string, string>; hash?: Record<string, string> };
const hash: Record<string, string> = man.hash ?? {};
const archives = new Map<string, { buf: Uint8Array; byName: Map<string, GdEntry> }[]>();
function sources(arc: string) {
  let list = archives.get(arc);
  if (!list) {
    list = [];
    for (const g of games) {
      const p = find(g, arc);
      if (!p) continue;
      const buf = readFileSync(p);
      list.push({ buf, byName: parseGdIndex(buf, statSync(p).size).byName });
    }
    archives.set(arc, list);
  }
  return list;
}
let done = 0, missing = 0;
for (const key of Object.keys(man.items)) {
  const [arc, name, frame, len] = key.split('|');
  const world = arc === 'dv.gd' || arc === 'addon.gd';
  const src = sources(arc).find(s => String(s.byName.get(name)?.dataLength) === len);
  const e = src?.byName.get(name);
  if (!src || !e) { missing++; continue; }
  const f = Number(frame);
  const frames = decodeGdFrames(e, src.buf.subarray(e.dataOffset, e.dataOffset + e.dataLength), e.frames - 1, !world && OPAQUE.has(name), !world);
  hash[key] = pixelHash(frames[f]);
  done++;
}
man.hash = hash;
// the format build_hdpack.py writes (json.dump indent=0, sort_keys=True)
const sortDeep = (v: unknown): unknown => (v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v as object).sort().map(k => [k, sortDeep((v as Record<string, unknown>)[k])])) : v);
writeFileSync(manPath, JSON.stringify(sortDeep(man), null, 1).replace(/^ +/gm, ''));
console.log(`hashed ${done} pack images, ${missing} without a source in the given installs`);
