// Aim cell of a projectile (docs/rendering/projectiles.md 1.1, docs/game/combat.md 4.1).
//
// The original tests four candidate cells built from the target's position (its footprint's max
// corner) and its two footprint sizes, in a fixed order, and keeps the first one with the
// smallest distance from the shooter's own cell. The sizes are used the wrong way round, so the
// candidates are the true footprint corners only for square footprints (a quirk kept as is).
// Distance: max(|dx|, |dy|) + floor(min(|dx|, |dy|) / 2) in whole cells, the deltas wrapped the
// short way; only a strictly smaller distance replaces the best, so ties go to the front corner.

/** candidate cells in test order; (x, y) = max corner, sizeX/sizeY = record footprint sizes */
export function aimCandidates(x: number, y: number, sizeX: number, sizeY: number): [number, number][] {
  return [
    [x, y],
    [x, y + 1 - sizeX],
    [x + 1 - sizeY, y + 1 - sizeX],
    [x + 1 - sizeY, y + sizeY - sizeX],
  ];
}

/** cell distance max + floor(min / 2) */
export function aimDistance(dx: number, dy: number): number {
  const a = Math.abs(dx), b = Math.abs(dy);
  return Math.max(a, b) + (Math.min(a, b) >> 1);
}

/**
 * The aim cell for a target at max corner (x, y) with footprint sizes sizeX x sizeY (1 x 1 for
 * units and other single-cell targets), seen from the shooter's cell (px, py). `wrap` maps a
 * coordinate difference to the short way round the map (identity if omitted). The result is not
 * wrapped.
 */
export function aimCell(x: number, y: number, sizeX: number, sizeY: number, px: number, py: number,
  wrap: (d: number) => number = d => d): [number, number] {
  const c = aimCandidates(x, y, Math.max(1, sizeX), Math.max(1, sizeY));
  let best = c[0], bd = aimDistance(wrap(c[0][0] - px), wrap(c[0][1] - py));
  for (let i = 1; i < c.length; i++) {
    const d = aimDistance(wrap(c[i][0] - px), wrap(c[i][1] - py));
    if (d < bd) { bd = d; best = c[i]; }
  }
  return [best[0], best[1]];
}
