// Mouse selection in the world view: pixel-accurate hit test on the drawn pictures, selection
// categories and their priority, Shift/Ctrl and double click.
// Spec: docs/rendering/objects.md 8 (and fog-of-war.md 6: only drawn objects are candidates).
// Pure functions: the caller passes the drawn list of this frame.

/** alpha above which a sprite pixel counts as hit (8) */
export const HIT_ALPHA = 192;
/** a mouse-up whose drag rectangle is at most this many px in both directions is a click */
export const CLICK_PX = 3;
/** a click rectangle is grown by this many px on every side */
export const CLICK_GROW = 2;
/** double click: radius in cells and the most units it selects */
export const DOUBLE_RADIUS = 5;
export const DOUBLE_MS = 500;

/** 1 bit per pixel (row-major), set where alpha > HIT_ALPHA */
export function alphaMask(rgba: Uint8Array, w: number, h: number): Uint8Array {
  const m = new Uint8Array((w * h + 7) >> 3);
  for (let i = 0, n = w * h; i < n; i++) if (rgba[i * 4 + 3] > HIT_ALPHA) m[i >> 3] |= 1 << (i & 7);
  return m;
}

/** one layer of a drawn picture: mask and its offset from the object's screen origin in sprite px */
export interface HitLayer { mask: Uint8Array | undefined; w: number; h: number; ox: number; oy: number; }

/**
 * Does the composite picture (layers drawn in order, each layer's rectangle copied over what is
 * below, objects.md 2.1) have a hit pixel inside the screen rectangle [x0..x1] x [y0..y1]?
 * (X0, Y0) = screen position of the object's origin, zoom = screen px per sprite px.
 */
export function compositeHit(layers: readonly HitLayer[], X0: number, Y0: number, zoom: number,
  x0: number, y0: number, x1: number, y1: number): boolean {
  if (!layers.length) return false;
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (const l of layers) { bx0 = Math.min(bx0, l.ox); by0 = Math.min(by0, l.oy); bx1 = Math.max(bx1, l.ox + l.w - 1); by1 = Math.max(by1, l.oy + l.h - 1); }
  const px0 = Math.max(bx0, Math.floor((x0 - X0) / zoom)), px1 = Math.min(bx1, Math.floor((x1 - X0) / zoom));
  const py0 = Math.max(by0, Math.floor((y0 - Y0) / zoom)), py1 = Math.min(by1, Math.floor((y1 - Y0) / zoom));
  for (let py = py0; py <= py1; py++) {
    for (let px = px0; px <= px1; px++) {
      for (let k = layers.length - 1; k >= 0; k--) {
        const l = layers[k], u = px - l.ox, v = py - l.oy;
        if (u < 0 || v < 0 || u >= l.w || v >= l.h) continue;
        const i = v * l.w + u;
        if (l.mask && (l.mask[i >> 3] >> (i & 7)) & 1) return true;
        break;   // the topmost layer covering this pixel decides
      }
    }
  }
  return false;
}

/** selection categories in priority order (8) */
export const Cat = { OwnUnit: 0, OtherUnit: 1, Nature: 2, OwnBuilding: 3, ForeignBuilding: 4, Tree: 5 } as const;
export type Cat = (typeof Cat)[keyof typeof Cat];
export const CAT_MAX = [12, 1, 1, 1, 1, 1];

const KIND_UNIT = 0, KIND_BUILDING = 1;
const CRIMINAL = 12, TREE_CLASS = 8;

/**
 * Category of an object for the local player, or -1 when it can never be selected
 * (Gold fish: group 6, types 41..45).
 */
export function categoryOf(o: { kind: number; owner: number; oid: number }, cls: number, player: number): Cat | -1 {
  const group = o.oid >>> 16, type = o.oid & 0xffff;
  if (o.kind === KIND_UNIT) return o.owner === player && type !== CRIMINAL ? Cat.OwnUnit : Cat.OtherUnit;
  if (o.kind === KIND_BUILDING) return o.owner === player ? Cat.OwnBuilding : Cat.ForeignBuilding;
  if (group === 6 && type >= 41 && type <= 45) return -1;
  return cls === TREE_CLASS ? Cat.Tree : Cat.Nature;
}

export interface Hit { id: number; cat: Cat; }
export interface Selection { cat: Cat | -1; ids: number[]; }

/**
 * Hits in test order: the drawn list (back to front) is walked from the frontmost, last drawn
 * object backwards (8). `test` returns the hit of one object or null.
 */
export function frontToBack<T, H = Hit>(drawn: readonly T[], test: (o: T) => H | null): H[] {
  const out: H[] = [];
  for (let i = drawn.length - 1; i >= 0; i--) { const h = test(drawn[i]); if (h) out.push(h); }
  return out;
}

/**
 * Selection from the hits, frontmost first (frontToBack). A click takes only the first, i.e.
 * frontmost, hit per category; a box keeps the frontmost up to the category's maximum. The
 * result is the first non-empty category in priority order.
 */
export function chooseSelection(hits: readonly Hit[], click: boolean): Selection {
  const per: number[][] = CAT_MAX.map(() => []);
  for (const h of hits) {
    const l = per[h.cat];
    if (click && l.length) continue;
    if (l.length < CAT_MAX[h.cat] && !l.includes(h.id)) l.push(h.id);
  }
  const cat = per.findIndex(l => l.length > 0);
  return cat < 0 ? { cat: -1, ids: [] } : { cat: cat as Cat, ids: per[cat] };
}

/**
 * Apply Shift/Ctrl (8): with a modifier and the same category, the current selection is kept and
 * extended (capped); Ctrl on a single already-selected object removes it. Otherwise the new
 * selection replaces the old one. An empty new selection clears (unless a modifier is held).
 */
export function combineSelection(cur: Selection, next: Selection, shift: boolean, ctrl: boolean): Selection {
  const mod = shift || ctrl;
  if (!mod) return next;
  if (next.cat === -1) return cur;
  if (next.cat !== cur.cat) return next;
  if (ctrl && next.ids.length === 1 && cur.ids.includes(next.ids[0])) {
    const ids = cur.ids.filter(id => id !== next.ids[0]);
    return { cat: ids.length ? cur.cat : -1, ids };
  }
  const ids = [...cur.ids];
  for (const id of next.ids) if (!ids.includes(id) && ids.length < CAT_MAX[cur.cat]) ids.push(id);
  return { cat: cur.cat, ids };
}

/**
 * Right-click target categories in priority order (objects.md 8.1): foreign unit, own unit,
 * nature (not trees), foreign building, own building, tree. Unlike selection (8), fish are
 * candidates (fishing boats target them).
 */
export const TargetCat = { ForeignUnit: 0, OwnUnit: 1, Nature: 2, ForeignBuilding: 3, OwnBuilding: 4, Tree: 5 } as const;
export type TargetCat = (typeof TargetCat)[keyof typeof TargetCat];

export function targetCategoryOf(o: { kind: number; owner: number }, cls: number, player: number): TargetCat {
  if (o.kind === KIND_UNIT) return o.owner === player ? TargetCat.OwnUnit : TargetCat.ForeignUnit;
  if (o.kind === KIND_BUILDING) return o.owner === player ? TargetCat.OwnBuilding : TargetCat.ForeignBuilding;
  return cls === TREE_CLASS ? TargetCat.Tree : TargetCat.Nature;
}

/**
 * The right-click target from the pixel hits, frontmost first (frontToBack): the frontmost hit of
 * the first non-empty category in priority order, or -1 (then the click is a move, 8.1).
 */
export function chooseTarget(hits: readonly { id: number; cat: TargetCat }[]): number {
  let best: { id: number; cat: TargetCat } | null = null;
  for (const h of hits) if (!best || h.cat < best.cat) best = h;
  return best ? best.id : -1;
}

/**
 * The right-click target under the cursor (objects.md 8.1): the drawn list (back to front) is
 * tested front to back; dead units and the selected units themselves are no candidates (ours, so a
 * unit standing at the door does not hide its building); `hit` is the pixel test of one object.
 * An own criminal is an ordinary own-unit candidate, so the criminal under the cursor is returned
 * (combat.md 12.6). Returns the id, or -1 for none (a move).
 */
export function targetUnderCursor<D>(drawn: readonly D[], info: (d: D) => { id: number; kind: number; owner: number; alive: boolean; cls: number },
  hit: (d: D) => boolean, player: number, selected: ReadonlySet<number>): number {
  return chooseTarget(frontToBack(drawn, d => {
    const o = info(d);
    if (o.kind === KIND_UNIT && (!o.alive || selected.has(o.id))) return null;
    return hit(d) ? { id: o.id, cat: targetCategoryOf(o, o.cls, player) } : null;
  }));
}

/**
 * The units a right-click (world view or minimap) commands (objects.md 8.1, combat.md 12.6):
 * only own units of the "own units" category, so never criminals, foreign units or anything
 * selected for inspection only.
 */
export function commandableUnits<T extends { kind: number; owner: number; oid: number }>(sel: readonly T[], player: number): T[] {
  return sel.filter(e => categoryOf(e, -1, player) === Cat.OwnUnit);
}

/**
 * Double click (objects.md 8, `00440e40`): the frontmost **unit** hit, of any owner, whatever
 * stands in front of it; null when no unit was hit. Hits are frontmost first (frontToBack).
 */
export function doubleClickUnit(hits: readonly Hit[]): Hit | null {
  for (const h of hits) if (h.cat === Cat.OwnUnit || h.cat === Cat.OtherUnit) return h;
  return null;
}

/**
 * Double click: own non-criminal units whose record type number equals the anchor's (the race
 * is not compared), drawn, within DOUBLE_RADIUS cells of it, nearest first, up to 12. A criminal
 * anchor gives nothing (the selection then ends empty without Shift/Ctrl).
 */
export function sameTypeNear<T extends { id: number; kind: number; owner: number; oid: number }>(
  anchor: T, units: readonly { e: T; d: number }[], player: number): Selection {
  const type = anchor.oid & 0xffff;
  if (type === CRIMINAL) return { cat: -1, ids: [] };
  const ids = units
    .filter(x => x.e.kind === KIND_UNIT && (x.e.oid & 0xffff) === type && categoryOf(x.e, -1, player) === Cat.OwnUnit && x.d <= DOUBLE_RADIUS)
    .sort((a, b) => a.d - b.d)
    .slice(0, CAT_MAX[Cat.OwnUnit])
    .map(x => x.e.id);
  return ids.length ? { cat: Cat.OwnUnit, ids } : { cat: -1, ids: [] };
}
