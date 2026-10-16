// Seeded terrain generation. Spec: docs/formats/terrain-gen.md
// Must stay bit-exact: every rand() call in the documented order.

import { MsRand } from './rand.ts';

export const CLASS_WATER = 11;
export const CLASS_PATH = 10;
export const CLASS_COUNT = 12;

/** tile set file (without .os) per terrain class */
export const CLASS_TILESET = [
  'wiese', 'gelbgras', 'schnee', 'rock', 'waldboden', 'waldboden',
  'gruenwald', 'waldboden', 'gelbgras', 'gruenwald', 'weg', 'wasser1',
] as const;

export interface Terrain {
  sizeBits: number;
  size: number;
  height: Uint16Array;
  cls: Uint8Array;
  /** tile index within the class's tile set */
  tile: Uint8Array;
  /** shared random generator state after generation; the map loader continues this stream */
  randState?: number;
}

/** pickTables[cls] = 256-entry weighted lookup of that class's tile set */
export function generateTerrain(seed: number, sizeBits: number, pickTables: Uint8Array[]): Terrain {
  const n = 1 << sizeBits, mask = n - 1;
  const rnd = new MsRand(seed);
  const height = new Uint16Array(n * n);
  const cls = new Uint8Array(n * n);
  const idx = (x: number, y: number) => ((y & mask) << sizeBits) | (x & mask);

  for (let i = 0; i < n * n; i++) cls[i] = (((i >> sizeBits) & i) & 1) | 8;

  // hills
  for (let k = (n >> 4) * (n >> 4); k > 0; k--) {
    let x = rnd.next() & mask, y = rnd.next() & mask;
    const steps = rnd.next() & 7;
    let r = rnd.next() & 31;
    const variant = cls[idx(x, y)] & 1;
    for (let s = 0; s < steps; s++) {
      const R = 6 * r;
      for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          const d2 = dx * dx + dy * dy;
          const v = d2 < 64 ? 2 * r - ((d2 * r) >> 6) : Math.trunc((r << 6) / d2);
          if (v === 0) continue;
          const i = idx(x + dx, y + dy);
          const h = (height[i] + Math.trunc((v * 4) / 5)) & 0xffff;
          height[i] = h;
          const band = h > 250 ? 2 : h > 200 ? 4 : h > 130 ? 6 : 0;
          if (band !== (cls[i] & 0xfe)) cls[i] = band + variant;
        }
      }
      const rr = r | 1;
      x = (x + (rnd.next() % rr) - (r >> 1)) | 0;
      y = (y + (rnd.next() % rr) - (r >> 1)) | 0;
      r = r - 15 + (rnd.next() % 31);
      r = r < 0 ? 0 : r > 31 ? 31 : r;
    }
  }

  // lakes
  for (let k = (n >> 6) * (n >> 6); k > 0; k--) {
    const rad = (rnd.next() % 3) + 2;
    const R = rad + 1;
    let x = 0, y = 0, level = 0;
    do {
      x = rnd.next() & mask;
      y = rnd.next() & mask;
      level = lakeLevel(height, cls, x, y, R, idx);
    } while (level === 0);
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const d2 = dx * dx + dy * dy;
        if (d2 > R * R) continue;
        const i = idx(x + dx, y + dy);
        height[i] = level;
        if (d2 <= rad * rad && ((dx !== rad && dy !== rad) || (rnd.next() & 1) !== 0)) cls[i] = CLASS_WATER;
      }
    }
    const E = rad + 5;
    for (let dy = -E; dy <= E; dy++) {
      for (let dx = -E; dx <= E; dx++) {
        const cx = x + dx, cy = y + dy;
        if (cls[idx(cx, cy)] === CLASS_WATER) continue;
        let shore = false;
        for (let ay = -1; ay <= 1 && !shore; ay++)
          for (let ax = -1; ax <= 1; ax++)
            if ((ax || ay) && cls[idx(cx + ax, cy + ay)] === CLASS_WATER) { shore = true; break; }
        if (shore) cls[idx(cx, cy)] = CLASS_PATH;
      }
    }
  }

  // tile choice
  const tile = new Uint8Array(n * n);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const t = rnd.next() & 0xff;
      const i = (y << sizeBits) | x;
      tile[i] = pickTables[cls[i]][t];
    }

  return { sizeBits, size: n, height, cls, tile, randState: rnd.state };
}

function lakeLevel(height: Uint16Array, cls: Uint8Array, x: number, y: number, R: number,
                   idx: (x: number, y: number) => number): number {
  let lo = 0x7fff, hi = 0;
  for (let dy = -R; dy <= R; dy++)
    for (let dx = -R; dx <= R; dx++) {
      const i = idx(x + dx, y + dy);
      const h = height[i];
      if (h < lo) lo = h;
      if (h > hi) hi = h;
      if (h > 250 || cls[i] === CLASS_WATER) return 0;
    }
  return hi - lo > 20 ? 0 : lo;
}

/**
 * Per-vertex shading 128..239 (162 = flat), from the height slope against a fixed sun.
 * Rendering only; not bit-exact with the original (see spec step 5).
 */
export function computeLight(t: Terrain): Uint8Array {
  const out = new Uint8Array(t.size * t.size);
  relight(t, out, 0, 0, t.size - 1, t.size - 1);
  return out;
}

/** recompute the light of cells x0..x1, y0..y1 (wrapped) after height changes */
export function relight(t: Terrain, out: Uint8Array, x0: number, y0: number, x1: number, y1: number): void {
  const mask = t.size - 1, bits = t.sizeBits;
  const h = (x: number, y: number) => t.height[((y & mask) << bits) | (x & mask)];
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const e = h(x + 1, y) - h(x - 1, y);
      const f = h(x, y + 1) - h(x, y - 1);
      const len = Math.sqrt(e * e + f * f + 1024);
      const dot = (-e / len + 32 / len) * Math.SQRT1_2; // light from -x, above
      const v = Math.trunc(dot * 320 - 64);
      out[((y & mask) << bits) | (x & mask)] = v < 128 ? 128 : v > 239 ? 239 : v;
    }
}
