// Free-play / multiplayer world populator: nature, the five point lists, start positions and the
// players' start objects for maps without a map file. Spec: docs/formats/world-populate.md.
//
// Deviation (spec, implementation notes): the original reseeds from the clock; we continue the
// deterministic stream so every client builds the same world from (seed, settings). And the
// re-roll loop is real: `populate` reports failure when there are fewer start positions than
// players, and the caller then draws a new terrain seed from the returned stream.

import { MsRand } from './rand.ts';
import { CLASS_WATER, type Terrain } from './terrain.ts';
import type { MapObject } from '../formats/mission.ts';

const NATURE_GROUP = 6;
const F_OBJECT = 0x10, F_WATER = 0x20, F_STEEP = 0x40, F_MOUNTAIN = 0x100, F_HILL = 0x200, F_TERRITORY = 0x1000;
const MASK_FREE = 0x17e, MASK_SITE = 0x13e, MASK_AREA = 0x117e;
const CLUSTER_CELLS = 10000;
/** nature types 33..37 have behaviour class 7; the populator uses count - 1 of them (5 in the shipped data) */
const ANIMAL_TYPES = 5;

const TOWN_HALL = 40, FOUNDER = 10;

export interface PopulatePlayer {
  race: number;
  /** computer player: settlement with a finished town hall; else only a founder (spec 9) */
  computer: boolean;
  /** this race's town hall footprint and town radius (dv.odb); default `PopulateOptions.hall`.
   *  Multiplayer passes it per race, so the result never depends on which race a client plays */
  hall?: { sizeX: number; sizeY: number; radius: number };
}

export interface PopulateOptions {
  /** "Anzahl Rohstoffe" 0..2 */
  resources: number;
  /** race slots with a player, any order (placed in race order 0..2) */
  players: PopulatePlayer[];
  /** network game: every human player starts with a founder only (spec 9.4). Computer players
   *  in a network game are our extension (the original had none there): they start like in
   *  single player, with a finished town hall */
  network?: boolean;
  /** town hall footprint and town radius (dv.odb), for the territory test */
  hall?: { sizeX: number; sizeY: number; radius: number };
  /** give human players the computer start set (town hall, builder, porters) instead of a lone
   *  founder; used while founding new towns is not available */
  humanTownHall?: boolean;
}

export interface PopulateResult {
  ok: boolean;
  objects: MapObject[];
  /** forest, stone, bush regions, start candidates, (remaining) start positions */
  lists: [number, number][][];
  /** start cell per race (-1 entries for races without a player) */
  starts: ([number, number] | null)[];
  /** generator state after populating */
  randState: number;
}

export function populate(t: Terrain, rand: MsRand, opt: PopulateOptions): PopulateResult {
  const n = t.size, mask = n - 1, bits = t.sizeBits, r = Math.max(0, Math.min(2, opt.resources | 0));
  const wrap = (v: number) => v & mask;
  const at = (x: number, y: number) => (wrap(y) << bits) | wrap(x);
  const occupied = new Uint8Array(n * n);
  const objects: MapObject[] = [];
  const lists: [number, number][][] = [[], [], [], [], []];
  const territory: [number, number, number][] = [];

  const heightOf = (x: number, y: number) => t.height[at(x, y)];
  const flags = (x: number, y: number): number => {
    const i = at(x, y), h = t.height[i];
    let f = 0;
    if (occupied[i]) f |= F_OBJECT;
    if (t.cls[i] === CLASS_WATER) f |= F_WATER;
    f |= h > 250 ? F_MOUNTAIN : h >= 130 ? F_HILL : 0x400;
    return f;
  };
  const axis = (a: number, b: number) => {
    const d = a - b, alt = d >= 0 ? d - n : d + n;
    return Math.min(Math.abs(d), Math.abs(alt));
  };
  /** 2.2 octagonal torus distance */
  const dist = (ax: number, ay: number, bx: number, by: number) => {
    const dx = axis(wrap(ax), wrap(bx)), dy = axis(wrap(ay), wrap(by));
    return Math.max(dx, dy) + (Math.min(dx, dy) >> 1);
  };

  /**
   * 2.3 ring walk around (cx, cy): ring h starts at its corner (cx+h, cy-h), then 2h steps each
   * in +y, -x, -y, +x (the corner is visited twice). `visit` returns true to stop; `ring` is h.
   */
  const ringWalk = (cx: number, cy: number, withCentre: boolean, visit: (x: number, y: number, h: number) => boolean): [number, number] | null => {
    if (withCentre && visit(wrap(cx), wrap(cy), 0)) return [wrap(cx), wrap(cy)];
    for (let h = 1; ; h++) {
      let x = cx + h, y = cy - h;
      if (visit(wrap(x), wrap(y), h)) return [wrap(x), wrap(y)];
      const dirs: [number, number][] = [[0, 1], [-1, 0], [0, -1], [1, 0]];
      for (const [dx, dy] of dirs) {
        for (let k = 0; k < 2 * h; k++) {
          x += dx; y += dy;
          if (visit(wrap(x), wrap(y), h)) return [wrap(x), wrap(y)];
        }
      }
    }
  };

  /** search with a stop radius (2.3): rings with h*s < R completely, then one more corner */
  const search = (cx: number, cy: number, R: number, s: number, fits: (x: number, y: number) => boolean): [number, number] | null => {
    let found: [number, number] | null = null, gaveUp = false;
    ringWalk(cx, cy, true, (x, y, h) => {
      if (fits(x, y)) { found = [x, y]; return true; }
      if (h * s >= R) { gaveUp = true; return true; }
      return false;
    });
    return gaveUp ? null : found;
  };

  /** 2.4 cluster site test: S x S square with (x, y) as its maximum corner; slope ignored */
  const siteFits = (S: number) => (x: number, y: number) => {
    let f = 0;
    for (let dy = 0; dy < S; dy++) for (let dx = 0; dx < S; dx++) f |= flags(x - dx, y - dy);
    return (f & MASK_SITE) === 0;
  };

  const inTerritory = (x: number, y: number) => territory.some(([tx, ty, rad]) => dist(x, y, tx, ty) <= rad);
  /** 2.4 area test: footprint W x H, ring height range <= 64, territory at the four corners */
  const areaFits = (W: number, H: number) => (x: number, y: number) => {
    let f = 0;
    for (let dy = 0; dy < H; dy++) for (let dx = 0; dx < W; dx++) f |= flags(x - dx, y - dy);
    let lo = Infinity, hi = -Infinity;
    for (let dy = -1; dy <= H; dy++) for (let dx = -1; dx <= W; dx++) {
      if (dx >= 0 && dx < W && dy >= 0 && dy < H) continue;
      const h = heightOf(x - dx, y - dy);
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
    if (hi - lo > 64) f |= F_STEEP;
    if (inTerritory(x, y) || inTerritory(x - W, y) || inTerritory(x, y - H) || inTerritory(x - W, y - H)) f |= F_TERRITORY;
    return (f & MASK_AREA) === 0;
  };
  const areaSearch = (cx: number, cy: number, W: number, H: number, R: number) =>
    search(cx, cy, R, W > 1 && H > 1 ? 2 : 1, areaFits(W, H));

  const place = (type: number, x: number, y: number) => {
    occupied[at(x, y)] = 1;
    objects.push({ cls: 2, group: NATURE_GROUP, type, owner: -1, x: wrap(x), y: wrap(y), z: heightOf(x, y) });
  };

  /** 5: cluster placer */
  const cluster = (cx: number, cy: number, T: number, A: number, B: number, S: number, spread: number) => {
    let tested = 0;
    ringWalk(cx, cy, false, (x, y) => {
      if (T === 0 && A === 0 && B === 0 && S === 0) return true;
      if (++tested > CLUSTER_CELLS) return true;
      const d = dist(x, y, cx, cy), f = flags(x, y);
      if (rand.next() % (d + spread) !== 0 || (f & MASK_FREE) !== 0) return false;
      let wT = T ? rand.next() % (T + 1) : -2;
      let wA = A ? rand.next() % (A + 1) : -2;
      let wB = B ? rand.next() % (B + 1) : -2;
      let wS = S ? rand.next() % (S + 1) : -2;
      if (f & F_HILL) wS *= 2; else { wT *= 2; wA *= 2; wB *= 2; }
      if (wA > wT && wA > wB && wA > wS && A > 0) {
        A--; place(33 + rand.next() % (ANIMAL_TYPES - 1), x, y);
        rand.next(); // constructor: wander job rand() % 3 (5.1)
        rand.next(); // constructor: its delay rand() % 40 + 1
      } else if (wB > wT && wB > wS && B > 0) {
        B--; place(13 + (rand.next() & 3), x, y);
      } else if (wS > wB && S > 0) {
        S--; place(29 + (rand.next() & 3), x, y);
      } else if (T > 0) {
        T--; place(9 + (rand.next() & 3), x, y);
      }
      return false;
    });
  };

  // ---------------------------------------------------------------- 4. resource sites
  const sites = n === 128 ? r + 4 : 2 * r + 6;
  for (let k = 0; k < sites; k++) {
    const x = (rand.next() % (n / 8)) * 8, y = (rand.next() % (n / 8)) * 8;
    let all = true;
    const forest = search(x, y, 15, 1, siteFits(13));
    if (forest) {
      const a = rand.next(), tt = rand.next(), b = rand.next();
      cluster(forest[0], forest[1], tt % 5 + 5 + 10 * r, a % 3 + 1 + 3 * r, b % 3, 0, 2);
      lists[0].push(forest);
    } else all = false;
    rand.next(); // discarded (4.3)
    const bush = search(x, y, 15, 1, siteFits(7));
    if (bush) {
      const b = rand.next(), tt = rand.next(), s = rand.next();
      cluster(bush[0], bush[1], tt % 3, 0, b % 3 + 4 + 3 * r, s & 1, 1);
      lists[2].push(bush);
    } else all = false;
    const stone = search(x, y, 25, 2, siteFits(9));
    if (stone) {
      const s = rand.next(), tt = rand.next();
      cluster(stone[0], stone[1], tt % 3, 0, 0, s % 3 + 3 + 3 * r, 3);
      lists[1].push(stone);
    } else all = false;
    if (all) lists[3].push([x, y]);
  }

  // ---------------------------------------------------------------- 6. scatter passes
  const rowStep = 48 + 36 * r;
  for (let y = 0; y < n; y += rowStep) {
    for (let x = 0; x < n;) {
      const j = rand.next() % 48;
      const ly = y + j < n - 1 ? y + rand.next() % 48 : n - 1;
      if (!(flags(x, y) & F_MOUNTAIN)) {
        if ((rand.next() & 1) === 0) {
          if ((flags(x, ly) & MASK_FREE) === 0) {
            const a = rand.next() & 3, b = rand.next() & 1;
            cluster(x, ly, b, 0, 0, a + 2 + 2 * r, 3);
            lists[1].push([x, wrap(ly)]);
          }
        } else {
          lists[0].push([x, wrap(ly)]); lists[2].push([x, wrap(ly)]);
          const a = rand.next() & 3, b = rand.next() & 3, c = rand.next();
          cluster(x, ly, c % 10 + 15 + 8 * r, b + 3, a + 2 + 2 * r, 0, 2);
        }
      }
      x += rand.next() % 48 + 48 + 36 * r;
    }
  }
  for (let y = 0; y < n; y += 12) {
    for (let x = 0; x < n;) {
      const j = rand.next() % 12;
      const ly = y + j < n - 1 ? y + rand.next() % 12 : n - 1;
      if (!(flags(x, y) & F_MOUNTAIN)) {
        const k = rand.next() % (10 - 3 * r);
        if (k === 0) cluster(x, ly, 0, 0, rand.next() % 3 + 1, 0, 3);
        else if (k === 1) cluster(x, ly, 0, 0, 0, rand.next() % 3 + 1, 5);
        else if (k === 2) cluster(x, ly, rand.next() % 3 + 1, 0, 0, 0, 5);
      }
      x += 12 + rand.next() % 12;
    }
  }

  // ---------------------------------------------------------------- 7. start positions
  for (const [cx, cy] of lists[3]) {
    let d = 32767;
    for (const [sx, sy] of lists[4]) d = Math.min(d, dist(cx, cy, sx, sy));
    if (d <= Math.trunc(n / 3)) continue;
    const f = areaSearch(cx, cy, 9, 9, 35);
    if (f) lists[4].push([f[0] - 3, f[1] - 3]);
  }

  // ---------------------------------------------------------------- 9. players
  const starts: ([number, number] | null)[] = [null, null, null];
  const players = [...opt.players].sort((a, b) => a.race - b.race);
  if (lists[4].length < players.length) return { ok: false, objects, lists, starts, randState: rand.state };
  const hall0 = opt.hall ?? { sizeX: 4, sizeY: 4, radius: 25 };
  for (const p of players) {
    let [px, py] = lists[4].shift()!;
    const f = areaSearch(px, py, 6, 6, n >> 1);
    if (f) [px, py] = f;
    px = wrap(px); py = wrap(py);
    const town = p.race;   // map id of the settlement: one per race at the start
    if (p.computer || opt.humanTownHall) {
      // the 6 x 6 area is the hall's footprint plus its free ring: place the hall's maximum corner one in
      const hall = p.hall ?? hall0;
      const hx = wrap(px - 1), hy = wrap(py - 1);
      objects.push({ cls: 1, group: p.race, type: TOWN_HALL, owner: town, x: hx, y: hy, z: heightOf(hx, hy) });
      for (let dy = 0; dy < hall.sizeY; dy++) for (let dx = 0; dx < hall.sizeX; dx++) occupied[at(hx - dx, hy - dy)] = 1;
      territory.push([hx, hy, hall.radius]);
      // the founder is created inside by the map loader; the builder and two porters are born
      // when the town hall becomes active (economy.md 2.3)
      starts[p.race] = [hx, hy];
    } else {
      objects.push({ cls: 0, group: p.race, type: FOUNDER, owner: -1, x: px, y: py, z: heightOf(px, py) });
      rand.next(); // facing (the map loader draws its own; kept for the call order of 10.8)
      starts[p.race] = [px, py];
    }
  }
  return { ok: true, objects, lists, starts, randState: rand.state };
}

/**
 * Generate terrain and populate it, re-rolling the terrain seed until every player has a start
 * (our deviation, see the implementation notes; the original never re-rolls). Never returns a
 * failed population: a repeated seed (a cycle of the chain) continues from `(seed0 + j) &
 * 0x7FFFFFFF` (j = escape count, skipping tried seeds), as generateIslandWorld does; `maxTries`
 * only guards against options no seed can satisfy, and then throws.
 */
export function generateWorld(seed: number, sizeBits: number, generate: (seed: number, bits: number) => Terrain, opt: PopulateOptions,
  maxTries = 10000): { terrain: Terrain; seed: number; result: PopulateResult } {
  const tried = new Set<number>();
  let s = seed, escapes = 0;
  for (let tries = 0; tries < maxTries; tries++) {
    tried.add(s);
    const terrain = generate(s, sizeBits);
    const rand = new MsRand(terrain.randState ?? s);
    const result = populate(terrain, rand, opt);
    if (result.ok) {
      terrain.randState = result.randState;
      return { terrain, seed: s, result };
    }
    s = rand.next();
    while (tried.has(s)) s = (seed + ++escapes) & 0x7fffffff;
  }
  throw new Error(`generateWorld: no successful world after ${maxTries} seeds (start seed ${seed})`);
}
