// Mouse cursors: the executable's cursor resources (docs/ui/cursors.md 2) and the rules that pick
// one (4, 5). The resource tests need the real executables: the GOG Bin/AN.exe next to AN_DATA and
// the Gold bin/dvge.exe next to AN_GOLD; they are skipped when those are not set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { exeCursors, decodeCursor, peLayout, resourceSection, type CursorGroup } from '../src/formats/pe-cursors.ts';
import { Slot, SLOT_GROUP, worldCursor, selectionHasFighters, isFighterType, cursorFor, cssOf, type CursorState } from '../src/client/cursors.ts';

/** case-insensitive path below a folder; null when missing */
function findFile(dir: string, rel: string): string | null {
  let cur = dir;
  for (const part of rel.split('/')) {
    if (!existsSync(cur)) return null;
    const hit = readdirSync(cur).find(n => n.toLowerCase() === part.toLowerCase());
    if (!hit) return null;
    cur = join(cur, hit);
  }
  return cur;
}

const gogExe = process.env.AN_DATA ? findFile(dirname(process.env.AN_DATA), 'Bin/AN.exe') : null;
const goldExe = process.env.AN_GOLD ? findFile(dirname(process.env.AN_GOLD), 'bin/dvge.exe') : null;

/** expected per group id: image id, hotspot, bounding box of the visible art (2, table) */
const EXPECT: Record<number, { image: number; hot: [number, number]; box: [number, number] }> = {
  132: { image: 6, hot: [0, 0], box: [22, 22] },     // arrow
  133: { image: 7, hot: [0, 0], box: [22, 22] },     // sword
  129: { image: 3, hot: [15, 15], box: [28, 26] },   // side hand (unused)
  131: { image: 5, hot: [16, 13], box: [15, 19] },   // open palm
  130: { image: 4, hot: [15, 16], box: [17, 17] },   // crosshair
  128: { image: 2, hot: [16, 15], box: [31, 31] },   // patrol
};

function bbox(c: CursorGroup): [number, number, number, number] {
  let x0 = 99, y0 = 99, x1 = -1, y1 = -1;
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
    if (!c.rgba[(y * c.width + x) * 4 + 3]) continue;
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  return [x0, y0, x1, y1];
}

function checkExe(path: string): Map<number, CursorGroup> {
  const exe = readFileSync(path);
  const l = peLayout(exe.subarray(0, 4096));
  assert.ok(resourceSection(l), 'resource section found from the first 4 KB');
  const groups = exeCursors(exe);
  assert.deepEqual([...groups.keys()].sort(), [128, 129, 130, 131, 132, 133]);
  for (const [id, e] of Object.entries(EXPECT)) {
    const c = groups.get(Number(id))!;
    assert.equal(c.image, e.image, `group ${id} image`);
    assert.deepEqual([c.width, c.height], [32, 32], `group ${id} size`);
    assert.deepEqual([c.hotX, c.hotY], e.hot, `group ${id} hotspot`);
    assert.equal(c.inverted, 0, `group ${id} has no inverting pixels`);
    const [x0, y0, x1, y1] = bbox(c);
    assert.deepEqual([x1 - x0 + 1, y1 - y0 + 1], e.box, `group ${id} art size`);
    // only white art, black outline and transparency (2: monochrome)
    for (let i = 0; i < c.rgba.length; i += 4) {
      const a = c.rgba[i + 3], v = c.rgba[i];
      assert.ok(a === 0 || (a === 255 && (v === 0 || v === 255) && c.rgba[i + 1] === v && c.rgba[i + 2] === v), `group ${id} pixel ${i / 4}`);
    }
  }
  // arrow and sword: the tip is the hotspot (top-left pixel drawn)
  for (const g of [132, 133]) assert.ok(groups.get(g)!.rgba[3] === 255, `group ${g} tip at (0, 0)`);
  // crosshair: centre pixel transparent, white lines through it
  const cross = groups.get(130)!;
  assert.equal(cross.rgba[(16 * 32 + 15) * 4 + 3], 0, 'crosshair centre transparent');
  return groups;
}

test('GOG AN.exe: six cursor groups with the documented images and hotspots', { skip: !gogExe && 'AN_DATA not set' }, () => {
  checkExe(gogExe!);
});

test('Gold dvge.exe: the same six cursors, byte-identical images', { skip: !goldExe && 'AN_GOLD not set' }, () => {
  const gold = checkExe(goldExe!);
  if (gogExe) {
    const gog = exeCursors(readFileSync(gogExe));
    for (const g of SLOT_GROUP) assert.deepEqual([...gold.get(g)!.rgba], [...gog.get(g)!.rgba], `group ${g}`);
  }
});

test('cursor decoding: AND/XOR pixel rule, bottom-up rows, palette colours, inversion', {}, () => {
  // 32 x 32 1-bpp cursor: hotspot (3, 4); top row: pixel 0 white, 1 black, 2 transparent, 3 inverted
  const w = 32, h = 32, stride = 4;
  const buf = new Uint8Array(4 + 40 + 8 + stride * h * 2);
  const v = new DataView(buf.buffer);
  v.setUint16(0, 3, true); v.setUint16(2, 4, true);
  v.setUint32(4, 40, true); v.setInt32(8, w, true); v.setInt32(12, h * 2, true);
  v.setUint16(16, 1, true); v.setUint16(18, 1, true);
  buf.set([0, 0, 0, 0, 255, 255, 255, 0], 44);              // palette: black, white
  const xor = 52, and = xor + stride * h;
  buf.fill(0xff, and, and + stride * h);                     // everything transparent ...
  const top = h - 1;                                         // ... except the top row (stored last)
  buf[xor + top * stride] = 0b10010000;                      // colour: pixel 0 white, pixel 3 white
  buf[and + top * stride] = 0b00111111;                      // mask: pixels 0, 1 opaque; 2.. transparent
  const c = decodeCursor(buf);
  assert.deepEqual([c.width, c.height, c.hotX, c.hotY], [32, 32, 3, 4]);
  assert.deepEqual([...c.rgba.subarray(0, 16)], [255, 255, 255, 255, 0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 255]);
  assert.equal(c.inverted, 1);
  assert.equal(c.rgba[(1 * 32) * 4 + 3], 0, 'second row transparent');
});

test('world-view rule: patrol first, then own fighters, else the arrow (4)', {}, () => {
  assert.equal(worldCursor(true, true), Slot.Patrol);
  assert.equal(worldCursor(true, false), Slot.Patrol);
  assert.equal(worldCursor(false, true), Slot.Sword);
  assert.equal(worldCursor(false, false), Slot.Arrow);
});

test('fighters: hunter, saboteur, soldiers; Gold also the warships 65, 66 (4)', {}, () => {
  const fighters = [17, 26, 29, 30, 31, 32, 33, 34, 35, 36];
  for (let t = 0; t < 80; t++) {
    assert.equal(isFighterType(t, false), fighters.includes(t), `GOG type ${t}`);
    assert.equal(isFighterType(t, true), fighters.includes(t) || t === 65 || t === 66, `Gold type ${t}`);
  }
  const u = (race: number, type: number, owner = race) => ({ owner, oid: ((race << 16) | type) >>> 0 });
  const P = 1;
  assert.equal(selectionHasFighters([], P, false), false, 'nothing selected');
  assert.equal(selectionHasFighters([u(P, 0), u(P, 0), u(P, 30)], P, false), true, 'porters and one soldier');
  assert.equal(selectionHasFighters([u(P, 0), u(P, 22), u(P, 21)], P, false), false, 'porter, priest, police');
  assert.equal(selectionHasFighters([u(P, 12)], P, false), false, 'own criminal');
  assert.equal(selectionHasFighters([u(2, 30)], P, false), false, 'foreign soldier');
  assert.equal(selectionHasFighters([u(2, 0), u(P, 30)], P, false), false, 'first object foreign');
  assert.equal(selectionHasFighters([u(P, 17)], P, false), true, 'hunter');
  assert.equal(selectionHasFighters([u(P, 26)], P, false), true, 'saboteur');
  assert.equal(selectionHasFighters([u(P, 65)], P, false), false, 'warship in GOG rules');
  assert.equal(selectionHasFighters([u(P, 66)], P, true), true, 'warship in Gold');
  assert.equal(selectionHasFighters([u(P, 67), u(P, 64)], P, true), false, 'transport ship, fishing boat');
});

test('every situation (5, 7): areas, placement hides, minimap crosshair and palm', {}, () => {
  const s = (o: Partial<CursorState>): CursorState => ({ area: 'world', placement: false, patrol: false, fighters: false, minimapDrag: false, ...o });
  assert.equal(cursorFor(s({})), Slot.Arrow);
  assert.equal(cursorFor(s({ fighters: true })), Slot.Sword);
  assert.equal(cursorFor(s({ fighters: true, patrol: true })), Slot.Patrol);
  assert.equal(cursorFor(s({ placement: true, fighters: true })), 'none');
  assert.equal(cursorFor(s({ area: 'panel', placement: true })), Slot.Arrow, 'placement: arrow over the panel');
  assert.equal(cursorFor(s({ area: 'panel', patrol: true, fighters: true })), Slot.Arrow);
  assert.equal(cursorFor(s({ area: 'minimap' })), Slot.Cross);
  assert.equal(cursorFor(s({ area: 'minimap', minimapDrag: true })), Slot.Palm);
  assert.equal(cursorFor(s({ area: 'menu', fighters: true })), Slot.Arrow);
  assert.equal(cursorFor(s({ area: 'video' })), 'none');
  assert.equal(cursorFor(s({ area: 'loading' })), 'none');
  assert.equal(cssOf('none'), 'none');
  assert.equal(cssOf(Slot.Sword), 'var(--cur-sword, crosshair)');
  assert.equal(cssOf(Slot.Arrow), 'var(--cur-arrow, default)');
  assert.equal(cssOf(Slot.Patrol), 'var(--cur-patrol, cell)');
  assert.equal(cssOf(Slot.Palm), 'var(--cur-palm, grabbing)');
});
