// Add-on free-play terrain generator (InfiniteAO.mdb, seed -1): diamond-square heights, inland
// lakes filled, beach / land / sea classes, tile choice. Spec: docs/formats/addon.md 9.
// Every rand() is the MS C runtime generator, in the documented order (bit-exact intent).

import { MsRand } from './rand.ts';
import {
  labelRuns, bodiesBySize, makeAddonTerrain, AO_SEA_LEVEL, AO_MOUNTAIN, AO_HIGHLAND,
  AO_CLASS_SEA, AO_CLASS_WATER, AO_CLASS_BEACH, type AddonTerrain,
} from './addon-terrain.ts';

const LATTICE = 32;

/**
 * Generate an add-on island terrain. `pickTables[c]` = 256-entry weighted tile lookup of add-on
 * class c (see aoPickTables). The returned randState continues into the island populator.
 */
export function generateIslandTerrain(seed: number, sizeBits: number, pickTables: Uint8Array[]): AddonTerrain {
  const n = 1 << sizeBits, mask = n - 1;
  const rnd = new MsRand(seed);
  const h = new Int32Array(n * n);
  const idx = (x: number, y: number) => ((y & mask) << sizeBits) | (x & mask);

  // 9.2.1 coarse lattice (x outer, y inner)
  let lo = 0x2000, hi = 0;
  for (let x = 0; x < n; x += LATTICE)
    for (let y = 0; y < n; y += LATTICE) {
      let v = rnd.next() & 0x1fff;
      if (v < 0x1000) v = 0x1000;
      h[idx(x, y)] = v;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  // 9.2.2 normalise to 0..384 with a 32-bit float scale
  const scale = hi > lo ? Math.fround(384 / (hi - lo)) : 0;
  for (let x = 0; x < n; x += LATTICE)
    for (let y = 0; y < n; y += LATTICE) {
      const i = idx(x, y);
      h[i] = Math.trunc((h[i] - lo) * scale);
    }
  // 9.2.3 refinement
  let A = 128.0;
  const decay = Math.pow(2.0, -1.1);
  for (let s = LATTICE; s !== 0; s >>= 1) {
    let r = Math.trunc(A + 0.5);
    if (r === 0 || s < 2) r = 1;
    const half = s >> 1, rh = r >> 1;
    const noise = (sum: number) => {
      const v = (rnd.next() % r) + (sum >> 2) - rh;
      return v < 0 ? 0 : v > 32767 ? 32767 : v;
    };
    for (let y = 0; y < n; y += s)
      for (let x = 0; x < n; x += s)
        h[idx(x + half, y + half)] = noise(h[idx(x, y)] + h[idx(x + s, y)] + h[idx(x, y + s)] + h[idx(x + s, y + s)]);
    for (let y = 0; y < n; y += s)
      for (let x = 0; x < n; x += s) {
        h[idx(x + half, y)] = noise(h[idx(x, y)] + h[idx(x + s, y)] + h[idx(x + half, y - half)] + h[idx(x + half, y + half)]);
        h[idx(x, y + half)] = noise(h[idx(x, y)] + h[idx(x, y + s)] + h[idx(x - half, y + half)] + h[idx(x + half, y + half)]);
      }
    A = A * decay;
  }

  const height = new Uint16Array(n * n);
  for (let i = 0; i < n * n; i++) height[i] = h[i];
  const cls = new Uint8Array(n * n);   // add-on classes, all 0

  // 9.4.1/2 water bodies: everything but the ocean becomes low land of class 4..7
  const water = labelRuns(sizeBits, i => height[i] <= AO_SEA_LEVEL);
  const bodies = bodiesBySize(water);
  const ocean = bodies.length && bodies[0].size > 0 ? bodies[0].label : -1;
  for (let k = 0; k < water.length; k++) {
    const l = water.label[k];
    if (l === ocean) continue;
    const base = water.y[k] << sizeBits;
    for (let x = water.x0[k]; x < water.x1[k]; x++) {
      height[base + x] = AO_SEA_LEVEL + 1 + (rnd.next() & 3);
      cls[base + x] = 4 + (l & 3);
    }
  }
  // 9.4.3 classes of the remaining cells, in index order
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const i = (y << sizeBits) | x;
      if (cls[i] !== 0) continue;
      const hv = height[i];
      let landNb = false, seaNb = false;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          if (height[idx(x + dx, y + dy)] > AO_SEA_LEVEL) landNb = true; else seaNb = true;
        }
      if (hv > AO_SEA_LEVEL) {
        cls[i] = seaNb ? AO_CLASS_BEACH : hv > AO_MOUNTAIN ? 2 : hv > AO_HIGHLAND ? 5 : 4;
      } else {
        cls[i] = landNb ? AO_CLASS_WATER : AO_CLASS_SEA;
        height[i] = AO_SEA_LEVEL;
      }
    }

  // tile choice (terrain-gen.md step 4): rows y outer, x inner, one rand() & 0xFF per cell
  const tile = new Uint8Array(n * n);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const i = (y << sizeBits) | x;
      tile[i] = pickTables[cls[i]][rnd.next() & 0xff];
    }

  return makeAddonTerrain(sizeBits, height, cls, tile, rnd.state);
}
