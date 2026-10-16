// .os terrain tile sets. Spec: docs/formats/os-dvf-tdb.md

import { Bin } from './bin.ts';

export interface TerrainTile {
  width: number;
  height: number;
  weight: number;
  /** RGBA, opaque */
  rgba: Uint8Array;
}

export interface TerrainSet {
  tiles: TerrainTile[];
  /** 256-entry weighted lookup: random byte -> tile index */
  pick: Uint8Array;
}

export function parseOs(buf: Uint8Array): TerrainSet {
  const b = new Bin(buf);
  const count = b.u32(4);
  const tiles: TerrainTile[] = [];
  let off = 8;
  for (let i = 0; i < count; i++) {
    const w = b.u32(off + 16), h = b.u32(off + 20), weight = b.u32(off + 32);
    off += 36;
    const rgba = new Uint8Array(w * h * 4);
    for (let p = 0; p < w * h; p++) {
      rgba[p * 4] = buf[off + p * 4 + 2];
      rgba[p * 4 + 1] = buf[off + p * 4 + 1];
      rgba[p * 4 + 2] = buf[off + p * 4];
      rgba[p * 4 + 3] = 255;
    }
    off += w * h * 4;
    tiles.push({ width: w, height: h, weight, rgba });
  }
  return { tiles, pick: buildPickTable(tiles.map(t => t.weight)) };
}

/** Tile i owns entries [floor(256*W_{<i}/W), floor(256*W_{<=i}/W)). */
export function buildPickTable(weights: number[]): Uint8Array {
  const total = weights.reduce((a, w) => a + w, 0);
  const table = new Uint8Array(256);
  let cum = 0, prev = 0;
  weights.forEach((w, i) => {
    cum += w;
    const end = Math.floor((cum * 256) / total);
    table.fill(i, prev, end);
    prev = end;
  });
  return table;
}
