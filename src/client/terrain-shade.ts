// Terrain brightness: the per-corner grey level, the 4-bit tile texels and how the original's
// default (software) renderer combines them. Pure reference logic, no WebGL; the terrain shader
// (terrain-renderer.ts) implements exactly these rules on the GPU.
// Spec: docs/rendering/terrain-drawing.md "Brightness", docs/game/fog-of-war.md 5.1.

/** fog shade per map vertex as Vision.shade stores it (vision.ts) */
export const SHADE_UNEXPLORED = 0, SHADE_EXPLORED = 128, SHADE_VISIBLE = 255;

/**
 * Grey level g of one terrain corner, folded in before anything is interpolated: L when the
 * vertex is in sight (or fog is off: shade 255 everywhere), L >> 1 when explored but not in
 * sight, 0 when never explored.
 */
export function cornerGrey(light: number, shade: number): number {
  if (shade >= SHADE_VISIBLE) return light;
  if (shade >= SHADE_EXPLORED) return light >> 1;
  return 0;
}

/** a tile texel channel cut to its top nibble at load: c = v >> 4 (0..15) */
export function texelNibble(v: number): number {
  return v >> 4;
}

/** texel (s, t) the software rasteriser picks at texture position (u, v) in 0..1: the per-corner
 *  texel positions span 0..63 (columns) and 0..63.75 (rows); nearest texel, no filtering */
export function texelAt(u: number, v: number): [number, number] {
  const c = (x: number) => Math.min(63, Math.max(0, Math.floor(x)));
  return [c(u * 63), c(v * 63.75)];
}

/**
 * One channel of the cached bilinear transition texel (s, t) from the four corner tiles' 4-bit
 * channels (terrain-drawing.md "Choosing what to draw"): weights (63-s)(63-t), s(63-t), (63-s)t,
 * st; the weight sum is always 63 * 63; integer division, stored as 4 bits.
 */
export function blendNibble(c0: number, c1: number, c2: number, c3: number, s: number, t: number): number {
  return Math.floor((c0 * (63 - s) * (63 - t) + c1 * s * (63 - t) + c2 * (63 - s) * t + c3 * s * t) / 3969);
}

/** brightness factor on the tile colour: out = tile x g / 256 (g = 256 would be the unshaded tile) */
export function brightnessFactor(g: number): number {
  return g / 256;
}

/**
 * The software renderer's screen value of one channel, in 8-bit terms, for a 4-bit texel channel
 * c and grey level g. Per pixel the light has 6 bits, s = g / 4 on average (the horizontal
 * error-diffusion dither makes a run of pixels alternate between floor(g / 4) and floor(g / 4) + 1
 * with exactly that mean); p = c x s; the 16-bit screen keeps the top `bits` bits of the 10-bit p
 * (5 for red and blue, 6 for green: truncation). Returned is the run average of the dithered output
 * (no dither pattern drawn), each 5-/6-bit level shown as level << (8 - bits).
 */
export function softwareChannel(c: number, g: number, bits: 5 | 6): number {
  const sf = g / 4, s0 = Math.floor(sf), ph = sf - s0;
  const shift = 10 - bits, up = 8 - bits;
  const q = (s: number) => ((c * s) >> shift) << up;
  return q(s0) * (1 - ph) + q(s0 + 1) * ph;
}

/** the software renderer's colour for a full 8-bit tile texel (r, g, b) at grey level g */
export function softwarePixel(rgb: readonly number[], g: number): [number, number, number] {
  return [
    softwareChannel(texelNibble(rgb[0]), g, 5),
    softwareChannel(texelNibble(rgb[1]), g, 6),
    softwareChannel(texelNibble(rgb[2]), g, 5),
  ];
}

/** "Glattes Gelände" (enhanced): full 8-bit texel, same brightness rule, no truncation */
export function smoothChannel(v: number, g: number): number {
  return v * brightnessFactor(g);
}
