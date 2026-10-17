// Deterministic 8-neighbour A* on a wrapping (toroidal) grid. Spec: docs/architecture/simulation.md

/**
 * Grid step (dx, dy) for each facing 0..7 (units-and-jobs.md 2 / 4.6, unit-motion.md 1.1): on screen
 * the facings run clockwise from "up": 0 up, 1 up-right, 2 right, 3 down-right, 4 down, 5 down-left,
 * 6 left, 7 up-left. The facing is also the sprite direction (slot = action * 8 + facing).
 */
export const DIR_STEP: readonly [number, number][] = [
  [-1, -1], [-1, 0], [-1, 1], [0, 1], [1, 1], [1, 0], [1, -1], [0, -1],
];

/** neighbour order of the A* expansion (independent of the facing numbering; keeps paths unchanged) */
const NEIGHBOURS: readonly [number, number][] = [
  [-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0],
];

/**
 * Facing toward a target at grid delta (dx, dy) (`004741d0`, unit-motion.md 1.2): sector borders at
 * a slope of 1 : 2 in grid space. -1 for a zero delta (the caller keeps its facing). For single
 * steps this is the DIR_STEP table.
 */
export function dirToward(dx: number, dy: number): number {
  if (dx === 0 && dy === 0) return -1;
  const ax = Math.abs(dx), ay = Math.abs(dy);
  if (ay >= 2 * ax) return dy > 0 ? 3 : 7;
  if (2 * ay <= ax) return dx < 0 ? 1 : 5;
  if (dx < 0) return dy > 0 ? 2 : 0;
  return dy > 0 ? 4 : 6;
}

/** facing of a grid delta; -1 for no delta (same as dirToward) */
export const dirOf = dirToward;

/**
 * One turn call (`00474260`, unit-motion.md 1.3): the facing after the call and whether the call
 * costs ticks. No difference: unchanged, free. 45 degrees: set at once, free. Otherwise one 45 degree
 * step the short way round, which costs ticks; for exactly 180 degrees the facing counts down when
 * want > cur and up when want < cur.
 */
export function turnOnce(cur: number, want: number): { dir: number; cost: boolean } {
  if (want < 0 || want === cur) return { dir: cur, cost: false };
  const diff = (want - cur + 8) & 7;
  if (diff === 1 || diff === 7) return { dir: want, cost: false };
  const s = diff === 4 ? (want > cur ? -1 : 1) : diff < 4 ? 1 : -1;
  return { dir: (cur + s + 8) & 7, cost: true };
}

/** the strike job's own turn (combat.md 4.1): always one 45 degree step, same direction rule as turnOnce */
export function turnStep(cur: number, want: number): number {
  if (want < 0 || want === cur) return cur;
  const diff = (want - cur + 8) & 7;
  const s = diff === 4 ? (want > cur ? -1 : 1) : diff < 4 ? 1 : -1;
  return (cur + s + 8) & 7;
}

/**
 * Find a path from (sx, sy) to (tx, ty). `blocked[i]` != 0 means impassable.
 * Returns the cells to visit after the start (start excluded), or null if unreachable within
 * `maxNodes` expansions. If the target itself is blocked, paths to the nearest reachable cell.
 */
export function findPath(blocked: Uint8Array, bits: number, sx: number, sy: number, tx: number, ty: number,
                         maxNodes = 40000): [number, number][] | null {
  const n = 1 << bits, mask = n - 1;
  const idx = (x: number, y: number) => ((y & mask) << bits) | (x & mask);
  const start = idx(sx, sy), goal = idx(tx, ty);
  if (start === goal) return [];

  // shortest wrapped delta for the heuristic
  const wd = (a: number, b: number) => { let d = Math.abs(a - b); if (d > n / 2) d = n - d; return d; };
  const h = (i: number) => {
    const dx = wd(i & mask, tx & mask), dy = wd(i >> bits, ty & mask);
    return 10 * Math.max(dx, dy) + 4 * Math.min(dx, dy);
  };

  const g = new Map<number, number>();
  const parent = new Map<number, number>();
  const closed = new Set<number>();
  const heap = new MinHeap();
  g.set(start, 0);
  heap.push(h(start), start);
  let best = start, bestH = h(start), expanded = 0;

  while (heap.size > 0 && expanded < maxNodes) {
    const cur = heap.pop();
    if (closed.has(cur)) continue;
    closed.add(cur);
    expanded++;
    if (cur === goal) { best = cur; break; }
    const ch = h(cur);
    if (ch < bestH) { bestH = ch; best = cur; }
    const cx = cur & mask, cy = cur >> bits, cg = g.get(cur)!;
    for (let d = 0; d < 8; d++) {
      const [dx, dy] = NEIGHBOURS[d];
      const ni = idx(cx + dx, cy + dy);
      // only the destination cell is tested: a diagonal step may pass between two blocked
      // orthogonal cells (units-and-jobs.md 4.1 "Diagonal steps cut corners")
      if (blocked[ni]) continue;
      const ng = cg + (dx !== 0 && dy !== 0 ? 14 : 10);
      const old = g.get(ni);
      if (old !== undefined && old <= ng) continue;
      g.set(ni, ng);
      parent.set(ni, cur);
      heap.push(ng + h(ni), ni);
    }
  }
  if (best === start) return null;
  const out: [number, number][] = [];
  for (let c = best; c !== start; c = parent.get(c)!) out.push([c & mask, c >> bits]);
  return out.reverse();
}

/**
 * The same search as `findPath` (same expansion order, ties and result) with typed-array
 * bookkeeping that is reused between searches on one grid size: much cheaper for many searches.
 */
export class PathSearcher {
  private bits: number;
  private g: Int32Array;
  private parent: Int32Array;
  /** per cell: stamp of the search that set g / closed it */
  private seen: Uint32Array;
  private shut: Uint32Array;
  private stamp = 0;
  private heap = new MinHeap();

  constructor(bits: number) {
    this.bits = bits;
    const n = 1 << (2 * bits);
    this.g = new Int32Array(n); this.parent = new Int32Array(n);
    this.seen = new Uint32Array(n); this.shut = new Uint32Array(n);
  }

  find(blocked: Uint8Array, sx: number, sy: number, tx: number, ty: number, maxNodes = 40000): [number, number][] | null {
    const bits = this.bits, n = 1 << bits, mask = n - 1;
    const idx = (x: number, y: number) => ((y & mask) << bits) | (x & mask);
    const start = idx(sx, sy), goal = idx(tx, ty);
    if (start === goal) return [];
    if (++this.stamp === 0xffffffff) { this.stamp = 1; this.seen.fill(0); this.shut.fill(0); }
    const st = this.stamp, g = this.g, parent = this.parent, seen = this.seen, shut = this.shut;
    const gx = tx & mask, gy = ty & mask, half = n / 2;
    const h = (i: number) => {
      let dx = Math.abs((i & mask) - gx); if (dx > half) dx = n - dx;
      let dy = Math.abs((i >> bits) - gy); if (dy > half) dy = n - dy;
      return dx > dy ? 10 * dx + 4 * dy : 10 * dy + 4 * dx;
    };
    const heap = this.heap;
    heap.clear();
    g[start] = 0; seen[start] = st;
    heap.push(h(start), start);
    let best = start, bestH = h(start), expanded = 0;
    while (heap.size > 0 && expanded < maxNodes) {
      const cur = heap.pop();
      if (shut[cur] === st) continue;
      shut[cur] = st;
      expanded++;
      if (cur === goal) { best = cur; break; }
      const ch = h(cur);
      if (ch < bestH) { bestH = ch; best = cur; }
      const cx = cur & mask, cy = cur >> bits, cg = g[cur];
      for (let d = 0; d < 8; d++) {
        const [dx, dy] = NEIGHBOURS[d];
        const ni = idx(cx + dx, cy + dy);
        if (blocked[ni]) continue;   // the destination only: diagonals cut corners (4.1)
        const ng = cg + (dx !== 0 && dy !== 0 ? 14 : 10);
        if (seen[ni] === st && g[ni] <= ng) continue;
        g[ni] = ng; seen[ni] = st;
        parent[ni] = cur;
        heap.push(ng + h(ni), ni);
      }
    }
    if (best === start) return null;
    const out: [number, number][] = [];
    for (let c = best; c !== start; c = parent[c]) out.push([c & mask, c >> bits]);
    return out.reverse();
  }
}

/** binary min-heap of (priority, value); ties pop in insertion order */
class MinHeap {
  private pri: number[] = [];
  private seq: number[] = [];
  private val: number[] = [];
  private counter = 0;
  get size(): number { return this.val.length; }
  clear(): void { this.pri.length = 0; this.seq.length = 0; this.val.length = 0; this.counter = 0; }
  push(p: number, v: number): void {
    this.pri.push(p); this.seq.push(this.counter++); this.val.push(v);
    let i = this.val.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(i, parent)) break;
      this.swap(i, parent); i = parent;
    }
  }
  pop(): number {
    const top = this.val[0];
    const last = this.val.length - 1;
    this.swap(0, last);
    this.pri.pop(); this.seq.pop(); this.val.pop();
    let i = 0;
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      if (l < this.val.length && this.less(l, m)) m = l;
      if (r < this.val.length && this.less(r, m)) m = r;
      if (m === i) break;
      this.swap(i, m); i = m;
    }
    return top;
  }
  private less(a: number, b: number): boolean {
    return this.pri[a] < this.pri[b] || (this.pri[a] === this.pri[b] && this.seq[a] < this.seq[b]);
  }
  private swap(a: number, b: number): void {
    [this.pri[a], this.pri[b]] = [this.pri[b], this.pri[a]];
    [this.seq[a], this.seq[b]] = [this.seq[b], this.seq[a]];
    [this.val[a], this.val[b]] = [this.val[b], this.val[a]];
  }
}
