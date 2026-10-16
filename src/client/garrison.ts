// Garrison units drawn on top of their outpost (docs/rendering/objects.md 13). Display only: pure
// functions of the simulation state and the outpost's odb points, testable without a renderer.
//
// The display's garrison list (13.1) holds the class-2 units that entered an outpost (the
// "unit entered" message with flag 4), in order of entering, and keeps a unit that is on its way
// out until it is placed outside. In our build that is exactly: the units still inside the
// outpost with record class 2, ordered by their entry sequence (a unit with a leave job is still
// inside until `putOutside`). The slot of a unit is its index in that list.

import type { World, Entity } from '../engine/world.ts';
import { Kind } from '../engine/world.ts';

/** how far below its slot point a garrison unit's feet are drawn, in sprite-canvas pixels (13.2) */
export const GARRISON_DROP = 22;

/** the outpost's garrison list in slot order (empty for every other building) */
export function garrisonList(w: World, b: Entity): Entity[] {
  if (b.kind !== Kind.Building || w.rules.get(b.oid)?.cls !== 6) return [];
  return w.entities.filter(u => u.kind === Kind.Unit && u.alive && u.inside === b.id && w.rules.get(u.oid)?.cls === 2)
    .sort((a, c) => a.enterSeq - c.enterSeq || a.id - c.id);
}

/** a unit's slot in its outpost's garrison list, -1 when it is not part of one */
export function garrisonSlot(w: World, u: Entity): number {
  const b = u.inside >= 0 ? w.get(u.inside) : undefined;
  return b ? garrisonList(w, b).findIndex(v => v.id === u.id) : -1;
}

/** the outpost's point for slot k (odb +0x54 + 8k); a slot without a stored point reads (0, 0) */
export function garrisonPoint(points: readonly (readonly [number, number])[] | undefined, k: number): [number, number] {
  const p = k >= 0 && k < 8 ? points?.[k] : undefined;
  return p ? [p[0], p[1]] : [0, 0];
}

/**
 * Where slot k's feet go, relative to the outpost's ground point (the screen point of its anchor
 * cell), in zoom-1 pixels, y down (13.2): the building canvas pixel (points[k].x, points[k].y + 22)
 * with the canvas placed by its OD anchor, i.e. (points[k].x - anchorX, points[k].y + 22 - anchorY).
 */
export function garrisonFeet(points: readonly (readonly [number, number])[] | undefined, k: number, anchorX: number, anchorY: number): [number, number] {
  const [px, py] = garrisonPoint(points, k);
  return [px - anchorX, py + GARRISON_DROP - anchorY];
}

/**
 * Launch pixel offset of a garrison shot, outpost part (projectiles.md 2.6, objects.md 13.4):
 * outpost anchor - point[slot]. It lacks the +22 of the drawn position, so the shot leaves 22 px
 * above the drawn unit (a quirk of the original, kept).
 */
export function garrisonLaunch(points: readonly (readonly [number, number])[] | undefined, k: number, anchorX: number, anchorY: number): [number, number] {
  const [px, py] = garrisonPoint(points, k);
  return [anchorX - px, anchorY - py];
}
