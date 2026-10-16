// Mouse cursors: the game's six Windows cursors, read at runtime from the player's own executable,
// and the rules that pick one. Spec: docs/ui/cursors.md (2 resources, 4 world-view rule, 5 every
// situation, 7 rebuild guidance).
//
// The art becomes CSS cursors (`url(png) hx hy, <keyword>`) published as custom properties on
// :root (--cur-arrow, --cur-sword, ...). Elements use `var(--cur-x, <keyword>)`, so without the
// executable they fall back to CSS keywords (7, table). Windows drew the cursors unscaled at
// 32 x 32 screen pixels; they stay at their native size here (no UI scaling).
//
// The decision functions at the top are pure (no DOM) and tested in node (test/cursors.test.ts).

import { peLayout, resourceSection, cursorGroups, type CursorImage } from '../formats/pe-cursors.ts';

/** cursor slots in load order (2): every rule chooses by slot */
export const Slot = { Arrow: 0, Sword: 1, Hand: 2, Palm: 3, Cross: 4, Patrol: 5 } as const;
export type Slot = (typeof Slot)[keyof typeof Slot];
/** resource group id of each slot (2, table) */
export const SLOT_GROUP: readonly number[] = [132, 133, 129, 131, 130, 128];
/** CSS keyword when the executable is not available (7, table); slot 2 is never used */
export const SLOT_FALLBACK: readonly string[] = ['default', 'crosshair', 'pointer', 'grabbing', 'crosshair', 'cell'];
const SLOT_VAR = ['--cur-arrow', '--cur-sword', '--cur-hand', '--cur-palm', '--cur-cross', '--cur-patrol'];

/** CSS value of a slot: the extracted cursor once loaded, else the keyword */
export const cursorCss = (slot: Slot): string => `var(${SLOT_VAR[slot]}, ${SLOT_FALLBACK[slot]})`;

// ---------------------------------------------------------------- rules (pure)

/** fighter types of the sword rule (4): hunter 17, saboteur 26, soldiers 29..36; Gold also 65, 66 */
export function isFighterType(type: number, gold: boolean): boolean {
  return type === 17 || type === 26 || (type >= 29 && type <= 36) || (gold && (type === 65 || type === 66));
}

/**
 * Rule 4.2: something is selected, the first selected object is the local player's, and at least
 * one selected object has a fighter type (the record type, whatever the object's kind).
 */
export function selectionHasFighters(sel: readonly { owner: number; oid: number }[], player: number, gold: boolean): boolean {
  if (!sel.length || sel[0].owner !== player) return false;
  return sel.some(e => isFighterType(e.oid & 0xffff, gold));
}

/** the world-view rule (4): patrol mode, else sword with own fighters, else the arrow */
export function worldCursor(patrol: boolean, fighters: boolean): Slot {
  if (patrol) return Slot.Patrol;
  if (fighters) return Slot.Sword;
  return Slot.Arrow;
}

/** where the mouse is (5) */
export type CursorArea = 'world' | 'panel' | 'minimap' | 'menu' | 'video' | 'loading';

export interface CursorState {
  area: CursorArea;
  /** building placement or town-hall founding (5.4) */
  placement: boolean;
  /** patrol-target mode (5.3) */
  patrol: boolean;
  /** rule 4.2 holds for the current selection */
  fighters: boolean;
  /** minimap grab-scroll running (5.2) */
  minimapDrag: boolean;
}

/** the cursor of a situation (5): a slot, or 'none' (hidden) */
export function cursorFor(s: CursorState): Slot | 'none' {
  switch (s.area) {
    case 'video': case 'loading': return 'none';
    case 'menu': case 'panel': return Slot.Arrow;
    case 'minimap': return s.minimapDrag ? Slot.Palm : Slot.Cross;
    case 'world': return s.placement ? 'none' : worldCursor(s.patrol, s.fighters);
  }
}

/** CSS value of a cursorFor() result */
export const cssOf = (c: Slot | 'none'): string => (c === 'none' ? 'none' : cursorCss(c));

// ---------------------------------------------------------------- art (browser)

/** executables to try, relative to the game folder (7: GOG Bin/AN.exe, Gold bin/dvge.exe) */
export const EXE_CANDIDATES = ['Bin/AN.exe', 'bin/dvge.exe'];

/** extracted cursors by slot, once loaded */
export const cursorImages: (CursorImage | null)[] = [null, null, null, null, null, null];

async function fetchRange(path: string, start: number, end: number): Promise<Uint8Array> {
  const r = await fetch(`/game/${path}`, { headers: { Range: `bytes=${start}-${end}` } });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  const b = new Uint8Array(await r.arrayBuffer());
  // a server without range support sends the whole file
  return r.status === 206 ? b : b.subarray(start, end + 1);
}

/** the six cursors of one executable by slot (range reads: headers, then the resource section) */
async function readExe(path: string): Promise<(CursorImage | null)[]> {
  const head = await fetchRange(path, 0, 4095);
  const l = peLayout(head);
  const s = resourceSection(l);
  if (!s) throw new Error(`${path}: no resources`);
  const groups = cursorGroups(await fetchRange(path, s.offset, s.offset + s.size - 1), s.rva, l.resRva);
  return SLOT_GROUP.map(g => groups.get(g) ?? null);
}

/** PNG data URL of a cursor image (canvas) */
function pngUrl(c: CursorImage): string {
  const cv = document.createElement('canvas');
  cv.width = c.width; cv.height = c.height;
  const ctx = cv.getContext('2d')!;
  const img = ctx.createImageData(c.width, c.height);
  img.data.set(c.rgba);
  ctx.putImageData(img, 0, 0);
  return cv.toDataURL('image/png');
}

/** CSS cursor value of an extracted image: `url(...) hx hy, keyword` */
export function cursorValue(c: CursorImage, fallback: string): string {
  const hx = Math.min(c.hotX, c.width - 1), hy = Math.min(c.hotY, c.height - 1);
  return `url("${pngUrl(c)}") ${hx} ${hy}, ${fallback}`;
}

/**
 * Read the cursors from the game's executable and publish them as :root custom properties.
 * `paths`: candidate executables relative to the game folder (the server lists the ones it has).
 * Resolves to false when none had them; the CSS keywords stay in effect then.
 */
export async function loadCursors(paths: readonly string[] = EXE_CANDIDATES): Promise<boolean> {
  for (const path of paths) {
    try {
      const imgs = await readExe(path);
      if (!imgs[Slot.Arrow]) continue;
      const root = document.documentElement.style;
      imgs.forEach((c, slot) => {
        cursorImages[slot] = c;
        if (c) root.setProperty(SLOT_VAR[slot], cursorValue(c, SLOT_FALLBACK[slot]));
      });
      return true;
    } catch { /* not there or not an executable with cursors: try the next */ }
  }
  return false;
}
