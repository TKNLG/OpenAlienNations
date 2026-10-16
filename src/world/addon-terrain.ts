// Add-on ("AO") terrain: class table, stored terrain of the add-on maps, the run labelling that
// numbers islands, the island-id grid and the Gold cell flags.
// Spec: docs/formats/addon.md 8.2, 8.3, 8.5, 9.3.
//
// Two class numberings are kept per cell:
//   aoCls  the add-on class 0..10 of addon.md 8.3 (0 beach, 2..7 land, 9 open sea, 10 coastal water)
//   cls    the base-game class (CLASS_TILESET / CLASS_WATER / CLASS_PATH of terrain.ts) with the
//          same tile set, so the existing engine and renderer work unchanged: both water classes
//          map to CLASS_WATER, the `weg` classes to CLASS_PATH.
// `tile` is the variant within the class's tile set (as for generated terrain), not the global
// tile number stored in the map.

import { CLASS_PATH, CLASS_WATER, type Terrain } from './terrain.ts';
import type { StoredTerrain } from '../formats/mission.ts';

/** land classes of an add-on mission; the water class is the class with this number (addon.md 8.3) */
export const AO_LAND_CLASSES = 10;
export const AO_CLASS_BEACH = 0;
/** open sea: an ordinary static tile set (wasser1) */
export const AO_CLASS_SEA = 9;
/** coastal water: animated wasser1..4 with shoreline transition1..4 */
export const AO_CLASS_WATER = 10;
export const AO_CLASS_COUNT = 11;

/** tile set file (without .os) per add-on class (table 0x4BCB74 of addon.md 8.3) */
export const AO_CLASS_TILESET = [
  'weg', 'weg', 'schnee', 'rock', 'wiese', 'waldboden', 'gruenwald', 'gelbgras', 'weg', 'wasser1', 'wasser1',
] as const;

/** classes drawn as animated water with shoreline pieces (only the coastal ring, addon.md 8.3) */
export const AO_CLASS_ANIMATED: readonly boolean[] = AO_CLASS_TILESET.map((_, c) => c === AO_CLASS_WATER);
/** classes that are water (cell flag 0x20): tile >= first tile of class 9 */
export const AO_CLASS_IS_WATER: readonly boolean[] = AO_CLASS_TILESET.map((_, c) => c >= AO_CLASS_SEA);

/** tiles per tile set (addon.md 8.3) */
export const TILESET_TILES: Record<string, number> = {
  weg: 9, schnee: 18, rock: 16, wiese: 20, waldboden: 16, gruenwald: 16, gelbgras: 17, wasser1: 4,
};

/** first global tile number of each add-on class: 0 9 18 36 52 72 88 104 121 130 134 */
export const AO_CLASS_FIRST_TILE: readonly number[] = (() => {
  const out: number[] = [];
  let t = 0;
  for (const s of AO_CLASS_TILESET) { out.push(t); t += TILESET_TILES[s]; }
  return out;
})();
export const AO_TILE_COUNT = AO_CLASS_FIRST_TILE[AO_CLASS_COUNT - 1] + TILESET_TILES.wasser1;

/** add-on class -> base class with the same tile set (for the base engine and renderer) */
export const AO_TO_BASE_CLASS: readonly number[] = [CLASS_PATH, CLASS_PATH, 2, 3, 0, 4, 6, 1, CLASS_PATH, CLASS_WATER, CLASS_WATER];

/** heights of an add-on mission (addon.md 1.2): sea level and the class thresholds */
export const AO_SEA_LEVEL = 120;
export const AO_MOUNTAIN = 290;
export const AO_HIGHLAND = 250;
export const AO_HILL = 130;

/** Gold cell flag bits (addon.md 8.3, world-populate.md 2.1) */
export const CellFlag = {
  Unit: 0x02, Building: 0x04, Special: 0x08, Nature: 0x10, Water: 0x20, Steep: 0x40,
  Mountain: 0x100, Hill: 0x200, Low: 0x400, Territory: 0x1000, Land: 0x2000, FewLand: 0x4000,
  AnimatedWater: 0x8000, Beach: 0x10000,
} as const;

export interface AddonTerrain extends Terrain {
  addon: true;
  /** add-on class 0..10 per cell */
  aoCls: Uint8Array;
  /** island id per cell (addon.md 8.5): the land label of 9.3 truncated to a byte, 0 on sea */
  island: Uint8Array;
}

/** the add-on class whose tile range contains a global tile number */
export function aoClassOfTile(tile: number): number {
  for (let c = AO_CLASS_COUNT - 1; c > 0; c--) if (tile >= AO_CLASS_FIRST_TILE[c]) return c;
  return 0;
}

/** 256-entry weighted tile lookups per add-on class, from a lookup per tile-set name */
export function aoPickTables(pickOf: (set: string) => Uint8Array): Uint8Array[] {
  return AO_CLASS_TILESET.map(s => pickOf(s));
}

/** wrap a stored map terrain (seed -2) into a Terrain (addon.md 8.2, 8.3) */
export function addonTerrainFromStored(st: StoredTerrain): AddonTerrain {
  const n = 1 << st.sizeBits, cells = n * n;
  const aoCls = new Uint8Array(cells), cls = new Uint8Array(cells), tile = new Uint8Array(cells);
  for (let i = 0; i < cells; i++) {
    const g = Math.min(st.tile[i], AO_TILE_COUNT - 1);
    const c = aoClassOfTile(g);
    aoCls[i] = c;
    cls[i] = AO_TO_BASE_CLASS[c];
    tile[i] = g - AO_CLASS_FIRST_TILE[c];
  }
  const t: AddonTerrain = {
    sizeBits: st.sizeBits, size: n, height: st.height.slice(), cls, tile, aoCls,
    island: new Uint8Array(cells), addon: true,
    // the generator never runs for seed -2; the stream is taken as srand(-2) with no draws (I)
    randState: -2 >>> 0,
  };
  labelIslands(t);
  return t;
}

/** build an AddonTerrain from add-on classes and variants (used by the island generator) */
export function makeAddonTerrain(sizeBits: number, height: Uint16Array, aoCls: Uint8Array, tile: Uint8Array, randState: number): AddonTerrain {
  const cls = new Uint8Array(aoCls.length);
  for (let i = 0; i < aoCls.length; i++) cls[i] = AO_TO_BASE_CLASS[aoCls[i]];
  const t: AddonTerrain = { sizeBits, size: 1 << sizeBits, height, cls, tile, aoCls, island: new Uint8Array(aoCls.length), addon: true, randState };
  labelIslands(t);
  return t;
}

/** global tile number of a cell (what an add-on map stores) */
export const globalTile = (t: AddonTerrain, i: number) => AO_CLASS_FIRST_TILE[t.aoCls[i]] + t.tile[i];

// ------------------------------------------------------------------ run labelling (9.3)

/** maximal horizontal runs of cells that satisfy a predicate, with their final labels */
export interface Runs {
  n: number;
  /** number of runs */
  length: number;
  y: Int32Array;
  x0: Int32Array;
  /** exclusive */
  x1: Int32Array;
  /** final label per run (1-based) */
  label: Int32Array;
  /** labels handed out (1..count); some may be unused */
  count: number;
  /** cells per label, index = label (0 unused) */
  size: Int32Array;
}

/**
 * The run labelling of addon.md 9.3, reproducing its label numbers: row scan with merges towards
 * the first overlapping run's label, then the horizontal and vertical wrap passes. Relabelling
 * "every run labelled M as L" is a directed union of M into L.
 */
export function labelRuns(sizeBits: number, pred: (i: number) => boolean): Runs {
  const n = 1 << sizeBits;
  let cap = 1024;
  let ry = new Int32Array(cap), rx0 = new Int32Array(cap), rx1 = new Int32Array(cap), rl = new Int32Array(cap);
  let len = 0;
  const parent: number[] = [0];
  const find = (l: number): number => {
    let r = l;
    while (parent[r] !== r) r = parent[r];
    while (parent[l] !== r) { const p = parent[l]; parent[l] = r; l = p; }
    return r;
  };
  const rowStart = new Int32Array(n + 1);
  let prevStart = 0, prevEnd = 0;
  for (let y = 0; y < n; y++) {
    rowStart[y] = len;
    const base = y << sizeBits;
    let x = 0;
    while (x < n) {
      if (!pred(base + x)) { x++; continue; }
      const x0 = x;
      while (x < n && pred(base + x)) x++;
      if (len === cap) {
        cap *= 2;
        const g = (a: Int32Array) => { const b = new Int32Array(cap); b.set(a); return b; };
        ry = g(ry); rx0 = g(rx0); rx1 = g(rx1); rl = g(rl);
      }
      let L = 0;
      for (let p = prevStart; p < prevEnd; p++) {
        if (!(rx0[p] < x && rx1[p] > x0)) continue;
        const M = find(rl[p]);
        if (L === 0) L = M;
        else if (M !== L) parent[M] = L;
      }
      if (L === 0) { L = parent.length; parent.push(L); }
      ry[len] = y; rx0[len] = x0; rx1[len] = x; rl[len] = L;
      len++;
    }
    prevStart = rowStart[y]; prevEnd = len;
  }
  rowStart[n] = len;
  // wrap passes, every run in list order
  const row0End = n > 1 ? rowStart[1] : len;
  for (let i = 0; i < len; i++) {
    const y = ry[i];
    if (rx0[i] === 0) {
      const last = rowStart[y + 1] - 1;
      if (rx1[last] === n) {
        const a = find(rl[i]), b = find(rl[last]);
        if (a !== b) parent[a] = b;
      }
    }
    if (y === n - 1) {
      for (let p = 0; p < row0End; p++) {
        if (!(rx0[p] < rx1[i] && rx1[p] > rx0[i])) continue;
        const a = find(rl[i]), b = find(rl[p]);
        if (a !== b) parent[a] = b;
      }
    }
  }
  const count = parent.length - 1;
  const size = new Int32Array(count + 1);
  const label = new Int32Array(len);
  for (let i = 0; i < len; i++) { const l = find(rl[i]); label[i] = l; size[l] += rx1[i] - rx0[i]; }
  return { n, length: len, y: ry.subarray(0, len), x0: rx0.subarray(0, len), x1: rx1.subarray(0, len), label, count, size };
}

/** (size, label) pairs sorted descending, size first, then label (addon.md 9.4); unused labels last */
export function bodiesBySize(r: Runs): { label: number; size: number }[] {
  const out: { label: number; size: number }[] = [];
  for (let l = 1; l <= r.count; l++) out.push({ label: l, size: r.size[l] });
  out.sort((a, b) => b.size - a.size || b.label - a.label);
  return out;
}

/** run indices per label, in list order */
export function runsByLabel(r: Runs): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (let i = 0; i < r.length; i++) {
    const l = r.label[i];
    let a = out.get(l);
    if (!a) out.set(l, a = []);
    a.push(i);
  }
  return out;
}

/** label the land (height > 120) of an add-on terrain */
export function labelLand(t: Terrain): Runs {
  const h = t.height;
  return labelRuns(t.sizeBits, i => h[i] > AO_SEA_LEVEL);
}

/** fill the island-id grid (addon.md 8.5) and return the land labelling */
export function labelIslands(t: AddonTerrain): Runs {
  const runs = labelLand(t);
  t.island.fill(0);
  for (let k = 0; k < runs.length; k++) {
    const base = runs.y[k] << t.sizeBits, id = runs.label[k] & 0xff;
    t.island.fill(id, base + runs.x0[k], base + runs.x1[k]);
  }
  return runs;
}

/**
 * Terrain part of a Gold cell's flag word in an add-on mission (addon.md 8.3): land / water,
 * animated water, beach, height bands with the add-on thresholds. Object bits are added by the caller.
 */
export function aoTerrainFlags(t: AddonTerrain, i: number): number {
  const c = t.aoCls[i], h = t.height[i];
  let f = AO_CLASS_IS_WATER[c] ? CellFlag.Water : CellFlag.Land;
  if (c === AO_CLASS_WATER) f |= CellFlag.AnimatedWater;
  if (c === AO_CLASS_BEACH) f |= CellFlag.Beach;
  f |= h > AO_MOUNTAIN ? CellFlag.Mountain : h >= AO_HILL ? CellFlag.Hill : CellFlag.Low;
  return f;
}
