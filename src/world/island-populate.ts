// Add-on free-play populator (InfiniteAO.mdb without a map file): resources and start positions
// per island, fish in the open sea, then the players' start objects; can fail, which re-rolls the
// terrain seed. Spec: docs/formats/addon.md 10 (and 9.5), world-populate.md 2, 5, 9.
//
// Unlike the base populator there is no clock reseed: the rand() stream continues from the island
// generator, so terrain and nature both follow from the seed. Results have the shape of
// populate.ts's PopulateResult so the client can use them the same way.

import { MsRand } from './rand.ts';
import {
  labelLand, labelRuns, bodiesBySize, runsByLabel, aoTerrainFlags, CellFlag, AO_CLASS_SEA,
  type AddonTerrain, type Runs,
} from './addon-terrain.ts';
import type { PopulateOptions, PopulateResult } from './populate.ts';
import type { MapObject } from '../formats/mission.ts';

const NATURE_GROUP = 6;
const MASK_FREE = 0x17e, MASK_AREA = 0x117e;
const CLUSTER_CELLS = 10000;
const BIG_ISLAND = 2000;
const TOWN_HALL = 40, FOUNDER = 10;
const FISH_BODY = 500;
/** our guard for the unlimited T(7) search of the 128-map fallback (10.4) */
const FALLBACK_T7_LIMIT = 1_000_000;

export interface IslandPopulateOptions extends PopulateOptions {
  /** behaviour-class-7 nature records of the merged rules (7 with Addon.odb: 33..37, 39, 40) */
  animalTypes?: number;
}

export interface IslandPopulateResult extends PopulateResult {
  /** why the builder failed (the original's debug texts), empty on success */
  failure: string;
  /** land labelling (island ids, addon.md 8.5) and the islands sorted by size */
  islands: { label: number; size: number }[];
  /** objects the cluster placer counted but did not create because the cell was beach (10.3) */
  beachSkips: { trees: number; animals: number; bushes: number; stones: number };
}

/**
 * Run chosen by "random island cell" (C 00490db0, addon.md 10) for `k = rand() & 0x3FF`, as an
 * index into `of` (the body's run indices in list order). The walk starts on the list's first
 * entry and counts a run after moving onto it, so the result is `k mod m` when the body owns the
 * first entry of the run list (or k = 0), else `(k - 1) mod m`.
 */
export function islandRunIndex(k: number, of: readonly number[]): number {
  const m = of.length;
  return of[0] === 0 || k === 0 ? k % m : (k - 1) % m;
}

export function populateIslands(t: AddonTerrain, rand: MsRand, opt: IslandPopulateOptions): IslandPopulateResult {
  const n = t.size, mask = n - 1, bits = t.sizeBits, r = Math.max(0, Math.min(2, opt.resources | 0));
  const animalTypes = opt.animalTypes ?? 7;
  const wrap = (v: number) => v & mask;
  const at = (x: number, y: number) => (wrap(y) << bits) | wrap(x);
  const objFlags = new Int32Array(n * n);
  const objects: MapObject[] = [];
  const lists: [number, number][][] = [[], [], [], [], []];
  const territory: [number, number, number][] = [];
  const starts: ([number, number] | null)[] = [null, null, null];
  const beachSkips = { trees: 0, animals: 0, bushes: 0, stones: 0 };

  const flags = (x: number, y: number) => { const i = at(x, y); return aoTerrainFlags(t, i) | objFlags[i]; };
  const heightOf = (x: number, y: number) => t.height[at(x, y)];
  const axis = (a: number, b: number) => { const d = a - b, alt = d >= 0 ? d - n : d + n; return Math.min(Math.abs(d), Math.abs(alt)); };
  const dist = (ax: number, ay: number, bx: number, by: number) => {
    const dx = axis(wrap(ax), wrap(bx)), dy = axis(wrap(ay), wrap(by));
    return Math.max(dx, dy) + (Math.min(dx, dy) >> 1);
  };

  const land = labelLand(t);
  const islands = bodiesBySize(land).filter(b => b.size > 0);
  const landRuns = runsByLabel(land);
  const fail = (failure: string): IslandPopulateResult =>
    ({ ok: false, failure, objects, lists, starts, randState: rand.state, islands, beachSkips });

  /** "random island cell" (C 00490db0): k = rand() & 0x3FF picks a run of the body by the
   *  cyclic walk of addon.md 10 (islandRunIndex); then a random cell of that run */
  const randomCell = (runs: Runs, of: number[]): [number, number] => {
    const k = rand.next() & 0x3ff;
    const run = of[islandRunIndex(k, of)];
    const x0 = runs.x0[run], x1 = runs.x1[run];
    return [x0 + (rand.next() % (x1 - x0)), runs.y[run]];
  };
  const islandCell = (label: number) => randomCell(land, landRuns.get(label)!);

  /** site test T(w): w x w footprint with maximum corner (x, y) free of 0x17E, ring range <= 64 */
  const siteFits = (x: number, y: number, w: number) => {
    let f = 0;
    for (let dy = 0; dy < w; dy++) for (let dx = 0; dx < w; dx++) f |= flags(x - dx, y - dy);
    if (f & MASK_FREE) return false;
    let lo = Infinity, hi = -Infinity;
    for (let dy = -1; dy <= w; dy++) for (let dx = -1; dx <= w; dx++) {
      if (dx >= 0 && dx < w && dy >= 0 && dy < w) continue;
      const hv = heightOf(x - dx, y - dy);
      if (hv < lo) lo = hv;
      if (hv > hi) hi = hv;
    }
    return hi - lo <= 64;
  };

  const place = (type: number, x: number, y: number) => {
    objFlags[at(x, y)] |= CellFlag.Nature;
    objects.push({ cls: 2, group: NATURE_GROUP, type, owner: -1, x: wrap(x), y: wrap(y), z: heightOf(x, y) });
  };

  /** ring walk of world-populate.md 2.3 (corner of ring h first, then +y, -x, -y, +x) */
  const ringWalk = (cx: number, cy: number, withCentre: boolean, visit: (x: number, y: number, h: number) => boolean): void => {
    if (withCentre && visit(wrap(cx), wrap(cy), 0)) return;
    const dirs: [number, number][] = [[0, 1], [-1, 0], [0, -1], [1, 0]];
    for (let h = 1; ; h++) {
      let x = cx + h, y = cy - h;
      if (visit(wrap(x), wrap(y), h)) return;
      for (const [dx, dy] of dirs)
        for (let k = 0; k < 2 * h; k++) {
          x += dx; y += dy;
          if (visit(wrap(x), wrap(y), h)) return;
        }
    }
  };

  /** cluster placer, Gold add-on variant (addon.md 10.3): no terrain bias; a beach cell is
   *  tested late (weights drawn, kind chosen and counted, then nothing created); palms, aloe /
   *  venus among the bushes, all animal types */
  const cluster = (cx: number, cy: number, T: number, A: number, B: number, S: number, spread: number) => {
    let tested = 0;
    ringWalk(cx, cy, false, (x, y) => {
      if (T === 0 && A === 0 && B === 0 && S === 0) return true;
      if (++tested > CLUSTER_CELLS) return true;
      const d = dist(x, y, cx, cy), f = flags(x, y);
      if (rand.next() % (d + spread) !== 0 || (f & MASK_FREE) !== 0) return false;
      const wT = T ? rand.next() % (T + 1) : -2;
      const wA = A ? rand.next() % (A + 1) : -2;
      const wB = B ? rand.next() % (B + 1) : -2;
      const wS = S ? rand.next() % (S + 1) : -2;
      // the chosen count is decremented first; on a beach cell nothing is created (no type draw)
      const beach = (f & CellFlag.Beach) !== 0;
      if (wA > wT && wA > wB && wA > wS && A > 0) {
        A--;
        if (beach) { beachSkips.animals++; return false; }
        let type = 33 + rand.next() % animalTypes;
        if (type === 38) type = 40;   // rubble -> crab
        place(type, x, y);
        rand.next();                  // constructor: wander job rand() % 3 (world-populate.md 5.1)
        rand.next();                  // constructor: its delay rand() % 40 + 1
      } else if (wB > wT && wB > wS && B > 0) {
        B--;
        if (beach) { beachSkips.bushes++; return false; }
        const k = rand.next() % 6;
        place(k < 4 ? 13 + k : k === 4 ? 50 : 51, x, y);
      } else if (wS > wB && S > 0) {
        S--;
        if (beach) { beachSkips.stones++; return false; }
        place(29 + (rand.next() & 3), x, y);
      } else if (T > 0) {
        T--;
        if (beach) { beachSkips.trees++; return false; }
        place(46 + (rand.next() & 3), x, y);
      }
      return false;
    });
  };

  // ---------------------------------------------------------------- 10.1 islands
  const big = islands.filter(b => b.size >= BIG_ISLAND);
  if (big.length >= 4) {
    // 10.2.1 one start per each of the three largest islands, T(9): cells c0..c100 are picked
    // and tested, the first fitting one of c0..c99 is taken; after c100 the builder fails even
    // if it fits
    for (let k = 0; k < 3; k++) {
      let found: [number, number] | null = null;
      for (let tries = 0; tries <= 100; tries++) {
        const [x, y] = islandCell(big[k].label);
        if (siteFits(x, y, 9)) { if (tries < 100) found = [x, y]; break; }
      }
      if (!found) return fail('Sowas. Riesen-Insel und kein Startpunkt.');
      lists[3].push(found);
    }
    // 10.2.2 more start candidates on every big island
    for (const isl of big) {
      let foundHere = 0;
      for (let counter = 200; counter > 80; counter -= 5) {
        if (foundHere > 8) break;
        for (let attempt = 0; attempt < 50; attempt++) {
          // cells c0..c50 (51 picks when all fail): the first fitting one of c0..c49 is taken,
          // c50 is picked and tested but never taken
          for (let k = 0; k <= 50; k++) {
            const [x, y] = islandCell(isl.label);
            if (siteFits(x, y, 4)) { if (k < 50) { lists[3].push([x, y]); foundHere++; } break; }
          }
        }
      }
    }
  } else {
    // 10.4 fallback, only for 128 maps
    if (n !== 128) return fail('Zu wenige grosse Inseln.');
    if (!islands.length || islands[0].size <= BIG_ISLAND) return fail('Zu wenige grosse Inseln.');
    const L = islands[0].label;
    // first start: T(7), no limit in the original; our guard (FALLBACK_T7_LIMIT, deviation) fails
    // the builder instead of hanging on an island without such a site
    let first: [number, number] | null = null;
    for (let tries = 0; tries < FALLBACK_T7_LIMIT; tries++) {
      const [x, y] = islandCell(L);
      if (siteFits(x, y, 7)) { first = [x, y]; break; }
    }
    if (!first) return fail('Kein T(7)-Startpunkt (Schutzgrenze)');
    lists[3].push(first);
    let D = 300, rejected = 0, accepted = 0;
    while (accepted < 2) {
      // one attempt: c0, c1, ... until a cell fits or c100 was tested; the counter ends at the
      // fitting cell's index, or 101 when all fail. Exactly 100 (c100 fits) fails the builder;
      // when all fail the unfitting c100 is the candidate
      let c: [number, number] = [0, 0], counter = 0;
      for (; counter <= 100; counter++) {
        c = islandCell(L);
        if (siteFits(c[0], c[1], 4)) break;
      }
      if (counter === 100) return fail('Zu wenige Punkte gefunden');
      if (lists[3].every(([sx, sy]) => dist(c[0], c[1], sx, sy) > D)) {
        lists[3].unshift(c); accepted++; D = 300; rejected = 0;   // inserted at the front of list 3
      } else if (++rejected % 50 === 0) {
        D -= 5;
        if (D <= 70) return fail('Zu wenige Punkte gefunden');
      }
    }
  }
  // 10.2.3 the first three candidates become the start positions (slot order)
  lists[4].push(...lists[3].splice(0, 3));

  // 10.2.4 resources per big island
  const F_DIV = [850, 700, 550][r], S_DIV = [700, 600, 350][r];
  for (const isl of big) {
    let F = Math.max(1, Math.trunc(isl.size / F_DIV)), S = Math.max(1, Math.trunc(isl.size / S_DIV));
    while (F > 0 && S > 0) {
      const [x, y] = islandCell(isl.label);
      const k = rand.next() % (20 - 3 * r);
      if (k === 0) { if (rand.next() % 25 === 0) cluster(x, y, 0, 0, rand.next() % 3 + 1, 0, 3); }
      else if (k === 1) { if (rand.next() % 25 === 0) cluster(x, y, 0, 0, 0, rand.next() % 3 + 1, 5); }
      else if (k === 2) { if (rand.next() % 25 === 0) cluster(x, y, rand.next() % 3 + 1, 0, 0, 0, 5); }
      else if (k === 3) {
        lists[0].push([x, y]); lists[2].push([x, y]);
        const a = rand.next() & 3, b = rand.next() & 3, c = rand.next();
        cluster(x, y, c % 10 + 15 + 8 * r, b + 3, a + 2 + 2 * r, 0, 2);
        F--;
      } else if (k === 4) {
        if ((flags(x, y) & MASK_FREE) === 0) {
          const a = rand.next() & 3, b = rand.next() & 1;
          cluster(x, y, b, 0, 0, a + 2 + 2 * r, 3);
          lists[1].push([x, y]);
          S--;
        }
      }
    }
  }

  // 10.2.5 fish in every open-sea body of >= 500 cells, in label order
  const sea = labelRuns(bits, i => t.aoCls[i] === AO_CLASS_SEA);
  const seaRuns = runsByLabel(sea);
  const N_DIV = [50, 100, 200][r];
  for (let l = 1; l <= sea.count; l++) {
    const size = sea.size[l];
    if (size < FISH_BODY) continue;
    const of = seaRuns.get(l)!;
    let N = Math.max(1, Math.trunc(size / N_DIV));
    while (N > 0) {
      const [x, y] = randomCell(sea, of);
      if (objFlags[at(x, y)] & 0x1e) continue;
      place(41 + rand.next() % 5, x, y);
      N--;
    }
  }

  // 10.5 players: world-populate.md 9 unchanged (list 4 in slot order, 6 x 6 area search)
  const inTerritory = (x: number, y: number) => territory.some(([tx, ty, rad]) => dist(x, y, tx, ty) <= rad);
  const areaFits = (W: number, H: number) => (x: number, y: number) => {
    let f = 0;
    for (let dy = 0; dy < H; dy++) for (let dx = 0; dx < W; dx++) f |= flags(x - dx, y - dy);
    let lo = Infinity, hi = -Infinity;
    for (let dy = -1; dy <= H; dy++) for (let dx = -1; dx <= W; dx++) {
      if (dx >= 0 && dx < W && dy >= 0 && dy < H) continue;
      const hv = heightOf(x - dx, y - dy);
      if (hv < lo) lo = hv;
      if (hv > hi) hi = hv;
    }
    if (hi - lo > 64) f |= CellFlag.Steep;
    if (inTerritory(x, y) || inTerritory(x - W, y) || inTerritory(x, y - H) || inTerritory(x - W, y - H)) f |= CellFlag.Territory;
    return (f & MASK_AREA) === 0;
  };
  /** area search (world-populate.md 2.3): rings with h*s < R, then one more corner */
  const areaSearch = (cx: number, cy: number, W: number, H: number, R: number): [number, number] | null => {
    const s = W > 1 && H > 1 ? 2 : 1, fits = areaFits(W, H);
    let found: [number, number] | null = null;
    ringWalk(cx, cy, true, (x, y, h) => {
      if (fits(x, y)) { found = [x, y]; return true; }
      return h * s >= R;
    });
    return found;
  };

  const players = [...opt.players].sort((a, b) => a.race - b.race);
  if (lists[4].length < players.length) return fail('Zu wenige Startpunkte.');
  const hall0 = opt.hall ?? { sizeX: 4, sizeY: 4, radius: 25 };
  for (const p of players) {
    let [px, py] = lists[4].shift()!;
    const f = areaSearch(px, py, 6, 6, n >> 1);
    if (f) [px, py] = f;
    px = wrap(px); py = wrap(py);
    // computer players get their hall in network games too (our extension, populate.ts `network`)
    if (p.computer || opt.humanTownHall) {
      const hall = p.hall ?? hall0;
      const hx = wrap(px - 1), hy = wrap(py - 1);
      objects.push({ cls: 1, group: p.race, type: TOWN_HALL, owner: p.race, x: hx, y: hy, z: heightOf(hx, hy) });
      for (let dy = 0; dy < hall.sizeY; dy++) for (let dx = 0; dx < hall.sizeX; dx++) objFlags[at(hx - dx, hy - dy)] |= CellFlag.Building;
      territory.push([hx, hy, hall.radius]);
      starts[p.race] = [hx, hy];
    } else {
      objects.push({ cls: 0, group: p.race, type: FOUNDER, owner: -1, x: px, y: py, z: heightOf(px, py) });
      rand.next(); // facing
      starts[p.race] = [px, py];
    }
  }
  return { ok: true, failure: '', objects, lists, starts, randState: rand.state, islands, beachSkips };
}

/**
 * Generate and populate an add-on free-play world; on failure draw `seed = rand()` from the
 * continuing stream and start again (addon.md 9.5). The original has no limit and never uses a
 * failed result; neither does this function: it returns only a successful population.
 *
 * Deviation (ours): the original chain can run into a cycle of failing seeds (addon.md 9.5:
 * 10253 -> 2016 -> 13201 and 3345 -> 29624 -> 21134 on 256 maps), where the original hangs. When
 * the next seed of the chain is one this call already tried, we continue instead with the
 * **escape seed** `(seed0 + j) & 0x7FFFFFFF` (seed0 = the start seed, j = 1, 2, ... counting
 * escapes, skipping seeds already tried) and follow the original chain from there. Every chain
 * that does not cycle is the original's, so all other seeds give the original's world; the
 * result is a pure function of (seed, size, options), so multiplayer clients reach the same
 * final seed. `maxTries` only guards against options no seed can satisfy: then it throws.
 */
export function generateIslandWorld(seed: number, sizeBits: number, generate: (seed: number, bits: number) => AddonTerrain,
  opt: IslandPopulateOptions, maxTries = 100000): { terrain: AddonTerrain; seed: number; result: IslandPopulateResult; rerolls: number; escapes: number } {
  const tried = new Set<number>();
  let s = seed, escapes = 0;
  for (let tries = 0; tries < maxTries; tries++) {
    tried.add(s);
    const terrain = generate(s, sizeBits);
    const rand = new MsRand(terrain.randState ?? s);
    const result = populateIslands(terrain, rand, opt);
    if (result.ok) {
      terrain.randState = result.randState;
      return { terrain, seed: s, result, rerolls: tries, escapes };
    }
    s = rand.next();
    // a repeated seed means the chain is in a cycle the original would loop in forever
    while (tried.has(s)) s = (seed + ++escapes) & 0x7fffffff;
  }
  throw new Error(`generateIslandWorld: no successful world after ${maxTries} seeds (start seed ${seed})`);
}
