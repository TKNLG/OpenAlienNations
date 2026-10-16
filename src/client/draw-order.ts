// Draw order of world objects (docs/rendering/objects.md 12). Display only: a pure function of
// the objects' anchor cells, so it can be tested without a renderer.
//
// Base order (12.2): rows of equal x + y from far (small) to near (large), within a row left to
// right on screen (increasing y - x). Height, sprite size and kind are not part of the key.
// Exception (12.3): a unit or nature object whose up-right (x - 1, y) or up-left (x, y - 1)
// neighbour is a non-corner footprint cell of a building that is drawn later is deferred and
// drawn right after that building. Effects are drawn in base order at their cell, after the
// object anchored there, and are never deferred (12.4).

export const DrawKind = { Unit: 0, Building: 1, Nature: 2, Effect: 3 } as const;

export interface DrawItem {
  /** DrawKind */
  kind: number;
  /**
   * Anchor cell, unwrapped relative to the camera so that rows never wrap round the torus: a unit's
   * cell (the destination of the current step while walking), a nature object's cell, a
   * building's footprint max corner (its front corner on screen), an effect's cell.
   */
  x: number; y: number;
  /** buildings: footprint size (cells x - sx + 1 .. x by y - sy + 1 .. y) */
  sx?: number; sy?: number;
}

const key = (x: number, y: number) => (x + 0x8000) * 0x10000 + (y + 0x8000);

/** the item indices in draw order, back to front */
export function drawOrder(items: readonly DrawItem[]): number[] {
  const n = items.length;
  // base order; an effect comes after the object on its cell; equal keys keep the input order
  const base = Array.from({ length: n }, (_, i) => i).sort((a, b) => {
    const p = items[a], q = items[b];
    return (p.x + p.y) - (q.x + q.y) || (p.y - p.x) - (q.y - q.x) ||
      (p.kind === DrawKind.Effect ? 1 : 0) - (q.kind === DrawKind.Effect ? 1 : 0) || a - b;
  });
  const rank = new Int32Array(n);
  base.forEach((i, r) => { rank[i] = r; });
  // footprint cells other than the front corner -> building
  const foot = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const b = items[i];
    if (b.kind !== DrawKind.Building) continue;
    const sx = Math.max(1, b.sx ?? 1), sy = Math.max(1, b.sy ?? 1);
    for (let dx = 0; dx < sx; dx++) for (let dy = 0; dy < sy; dy++) if (dx || dy) foot.set(key(b.x - dx, b.y - dy), i);
  }
  const deferred = new Map<number, number[]>();
  const isDeferred = new Uint8Array(n);
  if (foot.size) {
    for (const i of base) {
      const o = items[i];
      if (o.kind === DrawKind.Building || o.kind === DrawKind.Effect) continue;
      // a neighbour counts only if its building comes later; one already drawn (the cell right
      // after the front corner in the same row) changes nothing
      let right = foot.get(key(o.x - 1, o.y)), left = foot.get(key(o.x, o.y - 1));
      if (right !== undefined && rank[right] < rank[i]) right = undefined;
      if (left !== undefined && rank[left] < rank[i]) left = undefined;
      let b: number | undefined;
      if (right !== undefined && left !== undefined && right !== left) {
        const r = items[right], l = items[left];
        b = r.x + r.y > l.x + l.y ? right : left;   // the later building; equal sums: the one at (x, y - 1)
      } else b = right ?? left;
      if (b === undefined) continue;
      isDeferred[i] = 1;
      const list = deferred.get(b);
      if (list) list.push(i); else deferred.set(b, [i]);
    }
  }
  const out: number[] = [];
  for (const i of base) {
    if (isDeferred[i]) continue;
    out.push(i);
    const list = deferred.get(i);
    if (list) for (const j of list) out.push(j);
  }
  return out;
}
