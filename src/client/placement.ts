// Client side of building placement: the UI's preview and click test.
// Spec: docs/game/units-and-jobs.md 6.1.1, docs/game/fog-of-war.md 6, docs/game/economy.md 11.7.
//
// The UI tests the type's mask plus the visibility bit: every cell of the footprint grown by one
// cell must be in sight of the local player, for every building type (mine, town hall, add-on
// harbour and shipyard included; their special status is the territory exemption, which lives in
// `Logistics.canPlace`). The founder's town hall (`GRUENDEN`) is a build button for type 40 in the
// original and gets the same sight test (`foundingAllowed`). Fog is per machine and not simulation
// state, so this test exists only here; the simulation re-checks the build and found-town commands
// without fog or territory (`canPlaceSite`, `canFound(..., false)`).

import type { World } from '../engine/world.ts';
import type { Town } from '../engine/economy.ts';
import type { ObjectRule } from '../formats/odb.ts';
import type { Vision } from './vision.ts';

const MINE = 50;
const TOWN_HALL = 40;

/**
 * Visibility part of the UI test: the footprint (max corner x, y) grown by one cell on every side
 * lies wholly in sight. It reads the vision layer itself, so the MAGICEYE cheat (fog drawing off)
 * does not lift it. Without a vision layer (no local player) everything counts as in sight.
 */
export function footprintInSight(v: Vision | null | undefined, r: { sizeX: number; sizeY: number }, x: number, y: number): boolean {
  if (!v) return true;
  const fx = Math.max(1, r.sizeX), fy = Math.max(1, r.sizeY);
  for (let dy = -1; dy <= fy; dy++) for (let dx = -1; dx <= fx; dx++) if (!v.cellInSight(x - fx + 1 + dx, y - fy + 1 + dy)) return false;
  return true;
}

/** the UI's click test for a building (not the town hall of a founding): placement rule, territory, in sight */
export function placementAllowed(w: World, t: Town, r: ObjectRule, x: number, y: number, v: Vision | null | undefined): boolean {
  return w.logistics.canPlace(t, r, x, y) && footprintInSight(v, r, x, y);
}

/**
 * The UI's click test (and ghost colour) for the founder's `GRUENDEN` town hall (units-and-jobs.md
 * 11.1, 6.1.1 "Founding uses the same path"): the town-hall rule (free area, slope, outside every
 * territory) plus the same sight test as every building. The founder has no fog exemption:
 * explored-but-fogged and unexplored cells are refused alike.
 */
export function foundingAllowed(w: World, race: number, x: number, y: number, v: Vision | null | undefined): boolean {
  const r = w.rules.get(((race << 16) | TOWN_HALL) >>> 0);
  return !!r && w.logistics.canFound(race, x, y, true) && footprintInSight(v, r, x, y);
}

/**
 * Ghost colour (green = true). Equal to the click test, except for the Gold mine preview quirk
 * (units-and-jobs.md 6.1.1): in add-on games, a mine whose test fails is still drawn green when the
 * cursor cell's island differs from the island of the current town's position. Only the colour;
 * the click keeps refusing.
 */
export function ghostAllowed(w: World, t: Town, r: ObjectRule, x: number, y: number, v: Vision | null | undefined): boolean {
  if (placementAllowed(w, t, r, x, y, v)) return true;
  return w.addon && r.type === MINE && w.islandAt(x, y) !== w.islandAt(t.x, t.y);
}
