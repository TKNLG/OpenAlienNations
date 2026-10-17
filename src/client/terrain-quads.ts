// Corner layout of a terrain quad and the choice of what it shows (plain tile, shoreline tile or
// bilinear blend). Pure logic, no WebGL. Spec: docs/rendering/terrain-drawing.md
// ("Tiles belong to vertices", "Tile sets as the original numbers them", "Choosing what to draw").

/** a quad corner: vertex offset from the quad's cell (x, y) and texture position */
export interface QuadCorner { dx: number; dy: number; u: number; v: number }

/** corners c0..c3 in texture order: c0 bottom (x+1,y+1), c1 right (x,y+1), c2 left (x+1,y), c3 top (x,y) */
export const QUAD_CORNERS: readonly QuadCorner[] = [
  { dx: 1, dy: 1, u: 0, v: 0 },
  { dx: 0, dy: 1, u: 1, v: 0 },
  { dx: 1, dy: 0, u: 0, v: 1 },
  { dx: 0, dy: 0, u: 1, v: 1 },
];

/** corners in the order the four vertices of a quad are emitted: left, top, right, bottom */
export const QUAD_EMIT: readonly number[] = [2, 3, 1, 0];
/** the two triangles over the emitted vertices: (left, top, right) and (left, right, bottom),
 *  i.e. the quad is split along its left-right diagonal */
export const QUAD_TRIANGLES: readonly number[] = [0, 1, 2, 0, 2, 3];

/** set ids of the land tile sets (by file name) */
export const SET_ID: Readonly<Record<string, number>> = {
  weg: 0, schnee: 1, rock: 2, wiese: 3, waldboden: 4, gruenwald: 5, gelbgras: 6, wasser1: 7,
};
export const SET_WEG = 0;
/** the animated water class (all its corners show the same frame at any moment) */
export const SET_ANIMATED_WATER = 100;

/** raw shoreline table: per tile of transition1..4 one byte per entry, 1 = water */
export const SHORE_TABLE_RAW: readonly (readonly number[])[] = [
  [0, 1, 0, 1], [1, 1, 0, 0], [1, 0, 1, 0], [0, 0, 1, 1],
  [0, 1, 0, 0], [1, 0, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1],
  [1, 1, 0, 1], [1, 1, 1, 0], [1, 0, 1, 1], [0, 1, 1, 1],
  [1, 0, 0, 1], [0, 1, 1, 0],
];

/** water-corner mask per shoreline tile (bit k = corner ck is water); raw bytes b0..b3 are in
 *  corner order (b2, b0, b3, b1) */
export const SHORE_MASKS: readonly number[] = SHORE_TABLE_RAW.map(([b0, b1, b2, b3]) =>
  b2 | (b0 << 1) | (b3 << 2) | (b1 << 3));

/** shoreline tile for a water-corner mask, -1 for none (all land, all water) */
export function shoreTileOf(mask: number): number {
  return SHORE_MASKS.indexOf(mask);
}

export type QuadChoice =
  | { kind: 'single' }            // all corners in one set: corner c0's tile, unblended
  | { kind: 'shore'; tile: number } // shoreline tile of transition1..4
  | { kind: 'blend' };            // bilinear blend of the four corner tiles

/** what a quad shows, from its corners' set ids (c0..c3) */
export function chooseQuad(sets: readonly number[]): QuadChoice {
  if (sets[0] === sets[1] && sets[1] === sets[2] && sets[2] === sets[3]) return { kind: 'single' };
  let water = 0;
  for (let k = 0; k < 4; k++) {
    if (sets[k] === SET_ANIMATED_WATER) water |= 1 << k;
    else if (sets[k] !== SET_WEG) return { kind: 'blend' };
  }
  const tile = shoreTileOf(water);
  return tile >= 0 ? { kind: 'shore', tile } : { kind: 'blend' };
}
