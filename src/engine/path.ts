// The original's path planner (two searches at once) on the wrapping grid, plus facing helpers.
// Spec: docs/game/units-and-jobs.md 4.1.1 (planner), 4.6 (facing); docs/architecture/simulation.md

/**
 * Grid step (dx, dy) for each facing 0..7 (units-and-jobs.md 2 / 4.6, unit-motion.md 1.1): on screen
 * the facings run clockwise from "up": 0 up, 1 up-right, 2 right, 3 down-right, 4 down, 5 down-left,
 * 6 left, 7 up-left. The facing is also the sprite direction (slot = action * 8 + facing).
 */
export const DIR_STEP: readonly [number, number][] = [
  [-1, -1], [-1, 0], [-1, 1], [0, 1], [1, 1], [1, 0], [1, -1], [0, -1],
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

/** neighbour order of an expansion (4.1.1): (+1, -1), (-1, -1), (+1, +1), (-1, +1), (0, -1), (0, +1), (+1, 0), (-1, 0) */
const EXPAND_DX: readonly number[] = [1, -1, 1, -1, 0, 0, 1, -1];
const EXPAND_DY: readonly number[] = [-1, -1, 1, 1, -1, 1, 0, 0];

/** iterations per run, and the cap tested after each run (4.1.1) */
export const PLAN_RUN = 100;
export const PLAN_CAP = 2000;
/** a plan never makes more than 21 runs: at most 2 roots + 2100 iterations x 2 expansions x 8 nodes */
const NODE_CAP = 2 + (PLAN_CAP + PLAN_RUN) * 16;
const BUCKETS = 8192;
/** mode 0 adds the unit flag within this distance D of the start (4.1 "Two planning modes") */
const NEAR_UNITS = 32;

/** what one plan needs (units-and-jobs.md 4.1.1 "The request") */
export interface PlanRequest {
  sx: number; sy: number; gx: number; gy: number;
  /** step time per slope class 0..3 (record +0xC4) */
  steps: readonly number[];
  /** path shift: 0, animals 2 (a path cell costs step << shift, any other cell 2 x step) */
  shift: number;
  /** 1 ignore units, 0 avoid the units with D < 32 from the start */
  mode: number;
  /** every cell holding a unit is impassable (planning mask 0x3E, the flee's outward walk) */
  allUnits: boolean;
  /** cells whose flags meet the planning mask without the unit bit (!= 0 = impassable) */
  blocked: Uint8Array;
  /** path flag per cell (1 = paved) */
  pathFlag: Uint8Array;
  height: ArrayLike<number>;
  /** does a unit (other than the walker) stand on this cell; only asked when the unit bit is in the mask */
  unitAt: (i: number) => boolean;
}

/**
 * The original planner (`AStarIdle`, units-and-jobs.md 4.1.1), reproduced exactly: a forward
 * search from the start and a backward search from the goal, each until its best node stands on
 * its own far end; priority = moves + 4 x (step cost + D to the far end); the meeting boost; the
 * 8192-bucket duplicate check with its quirk; open lists in ascending priority, newest first among
 * equals (kept as two binary heaps keyed by priority and insertion sequence, with stale entries
 * skipped: the same order as the original's sorted lists); 100 iterations per run, failure once
 * the total passes 2000 after a run (a path found in that run is dropped); never a partial path.
 * Buffers are reused between plans on one map size.
 */
export class Planner {
  private bits: number;
  private size: number;
  // nodes
  private cell = new Int32Array(NODE_CAP);
  private moves = new Int32Array(NODE_CAP);
  private pri = new Int32Array(NODE_CAP);
  private parent = new Int32Array(NODE_CAP);
  private seq = new Int32Array(NODE_CAP);
  private hnext = new Int32Array(NODE_CAP);
  private dir = new Uint8Array(NODE_CAP);
  private closed = new Uint8Array(NODE_CAP);
  private count = 0;
  private seqNo = 0;
  // hash buckets (stamped, so a new plan starts empty without clearing)
  private bhead = new Int32Array(BUCKETS);
  private bstamp = new Uint32Array(BUCKETS);
  private stamp = 0;
  // open lists: heaps of (node, sequence, priority) per direction (0 backward, 1 forward)
  private heap: [OpenHeap, OpenHeap] = [new OpenHeap(), new OpenHeap()];
  // the current request
  private req!: PlanRequest;
  private start = 0;
  private goal = 0;
  /** iterations of the last plan (tests, statistics) */
  iterations = 0;

  constructor(bits: number) {
    this.bits = bits;
    this.size = 1 << bits;
  }

  /** the cells after the start up to and including the goal, or null (failure). Start = goal gives []. */
  plan(r: PlanRequest): [number, number][] | null {
    const m = this.size - 1, bits = this.bits;
    this.req = r;
    const start = this.start = ((r.sy & m) << bits) | (r.sx & m);
    const goal = this.goal = ((r.gy & m) << bits) | (r.gx & m);
    this.iterations = 0;
    if (start === goal) return [];
    if (++this.stamp === 0xffffffff) { this.stamp = 1; this.bstamp.fill(0); }
    this.count = 0; this.seqNo = 0;
    const hf = this.heap[1], hb = this.heap[0];
    hf.clear(); hb.clear();
    // the roots: forward on the start, backward on the goal, moves 0, priority 999999 (each is
    // alone in its list); forward goes into the hash first
    const f = this.node(start, 0, 999999, -1, 1);
    const b = this.node(goal, 0, 999999, -1, 0);
    this.hashFront(f); this.hashFront(b);
    hf.push(f, this.seq[f] = ++this.seqNo, 999999);
    hb.push(b, this.seq[b] = ++this.seqNo, 999999);
    let total = 0;
    for (;;) {
      // one run
      let found = -1, fh = this.head(1), bh = this.head(0);
      for (let k = 0; k < PLAN_RUN && fh >= 0 && bh >= 0 && found < 0; k++) {
        total++;
        if (this.cell[fh] === goal) found = fh;
        else if (this.cell[bh] === start) found = bh;
        else { this.expand(fh); this.expand(bh); }
        fh = this.head(1); bh = this.head(0);
      }
      this.iterations = total;
      if (total > PLAN_CAP || fh < 0 || bh < 0) return null;
      if (found >= 0) return this.path(found);
    }
  }

  /**
   * The attack job's firing-position search (combat.md 3.5, `004725e0` run in one-way mode): the
   * forward search alone, from the start toward the "goal" cell (the target footprint's centre,
   * used for the distance term and the step-cost exemption), with the same expansion, step cost,
   * insertion and open list as `plan`. Each iteration tests the head node with `test` first (the
   * range test from its cell); the first node that passes ends the search. 100 iterations per run,
   * failure once the total passes 2000 after a run (a node found in that run is dropped) or when
   * the open list is empty. The path is the start cell followed by the cells up to the found one
   * (just the start when the start itself passes); null on failure.
   */
  seek(r: PlanRequest, test: (x: number, y: number) => boolean): [number, number][] | null {
    const m = this.size - 1, bits = this.bits;
    this.req = r;
    const start = this.start = ((r.sy & m) << bits) | (r.sx & m);
    this.goal = ((r.gy & m) << bits) | (r.gx & m);
    this.iterations = 0;
    if (++this.stamp === 0xffffffff) { this.stamp = 1; this.bstamp.fill(0); }
    this.count = 0; this.seqNo = 0;
    const hf = this.heap[1];
    hf.clear(); this.heap[0].clear();
    // one root: forward, on the start (no backward search)
    const f = this.node(start, 0, 999999, -1, 1);
    this.hashFront(f);
    hf.push(f, this.seq[f] = ++this.seqNo, 999999);
    let total = 0;
    for (;;) {
      let found = -1, fh = this.head(1);
      for (let k = 0; k < PLAN_RUN && fh >= 0 && found < 0; k++) {
        total++;
        if (test(this.cell[fh] & m, this.cell[fh] >> bits)) found = fh;
        else this.expand(fh);
        fh = this.head(1);
      }
      this.iterations = total;
      if (total > PLAN_CAP || (found < 0 && fh < 0)) return null;
      if (found >= 0) return [[r.sx & m, r.sy & m], ...this.path(found)];
    }
  }

  // ------------------------------------------------------------------ internals

  private node(c: number, moves: number, pri: number, parent: number, dir: number): number {
    const n = this.count++;
    this.cell[n] = c; this.moves[n] = moves; this.pri[n] = pri; this.parent[n] = parent;
    this.dir[n] = dir; this.closed[n] = 0; this.hnext[n] = -1;
    return n;
  }

  private bucket(c: number): number {
    const m = this.size - 1;
    return (((c >> this.bits) * 256) + (c & m)) & (BUCKETS - 1);
  }

  private hashFront(n: number): void {
    const b = this.bucket(this.cell[n]);
    this.hnext[n] = this.bstamp[b] === this.stamp ? this.bhead[b] : -1;
    this.bhead[b] = n; this.bstamp[b] = this.stamp;
  }

  /** the head of an open list (lowest priority, newest among equals), -1 when empty */
  private head(d: number): number {
    const h = this.heap[d];
    while (h.size > 0) {
      const n = h.topNode();
      if (!this.closed[n] && this.seq[n] === h.topSeq()) return n;
      h.pop();
    }
    return -1;
  }

  /** D = 2 max(|dx|, |dy|) + min(|dx|, |dy|), wrapped */
  private dist(a: number, b: number): number {
    const n = this.size, m = n - 1, half = n >> 1;
    let dx = Math.abs((a & m) - (b & m)); if (dx > half) dx = n - dx;
    let dy = Math.abs((a >> this.bits) - (b >> this.bits)); if (dy > half) dy = n - dy;
    return dx > dy ? 2 * dx + dy : 2 * dy + dx;
  }

  /** step cost from cell a to its neighbour c; 0 = impassable (4.1.1 "Step cost") */
  private cost(a: number, c: number): number {
    const r = this.req;
    const end = c === this.start || c === this.goal;
    if (!end) {
      if (r.blocked[c]) return 0;
      if ((r.allUnits || (r.mode === 0 && this.dist(this.start, c) < NEAR_UNITS)) && r.unitAt(c)) return 0;
    }
    let cls = Math.abs((r.height[a] - r.height[c]) >> 4);
    if (cls > 3) cls = 3;
    const t = r.steps[cls] | 0;
    if (!t) return 0;
    return !end && r.pathFlag[c] === 1 ? t << r.shift : t << 1;
  }

  private expand(p: number): void {
    const bits = this.bits, m = this.size - 1;
    const pc = this.cell[p], px = pc & m, py = pc >> bits, d = this.dir[p];
    const far = d === 1 ? this.goal : this.start;
    for (let k = 0; k < 8; k++) {
      const dx = EXPAND_DX[k], dy = EXPAND_DY[k];
      const c = (((py + dy) & m) << bits) | ((px + dx) & m);
      const cost = this.cost(pc, c);
      if (!cost) continue;
      const moves = this.moves[p] + (dx !== 0 && dy !== 0 ? 3 : 2);
      const rating = cost + this.dist(c, far);
      this.insert(c, moves, moves + 4 * rating, p, d);
    }
    this.closed[p] = 1;
  }

  /** insertion with the duplicate check (4.1.1 "Insertion"); the new node is only kept when it goes in */
  private insert(c: number, moves: number, pri: number, parent: number, d: number): void {
    const b = this.bucket(c);
    let match = -1;
    for (let k = this.bstamp[b] === this.stamp ? this.bhead[b] : -1; k >= 0; k = this.hnext[k]) {
      if (this.cell[k] === c) match = k;
      if (this.dir[k] === d) break;
    }
    if (match >= 0 && this.dir[match] === d) {
      if (moves < this.moves[match]) {
        this.moves[match] = moves;
        this.parent[match] = parent;
        if (pri < this.pri[match]) this.pri[match] = pri;
      }
      if (this.closed[match]) return;
      // an open match is taken off its list and inserted again, changed or not
      this.heap[d].push(match, this.seq[match] = ++this.seqNo, this.pri[match]);
      return;
    }
    if (match >= 0) pri >>= 2;   // the other search was here: the meeting boost
    const n = this.node(c, moves, pri, parent, d);
    this.hashFront(n);
    this.heap[d].push(n, this.seq[n] = ++this.seqNo, pri);
  }

  private path(n: number): [number, number][] {
    const m = this.size - 1, bits = this.bits, out: [number, number][] = [];
    if (this.dir[n] === 1) {
      for (let k = n; this.parent[k] >= 0; k = this.parent[k]) out.push([this.cell[k] & m, this.cell[k] >> bits]);
      out.reverse();
    } else {
      for (let k = this.parent[n]; k >= 0; k = this.parent[k]) out.push([this.cell[k] & m, this.cell[k] >> bits]);
    }
    return out;
  }
}

/**
 * Binary min-heap of open-list entries: lower priority first, and among equal priorities the
 * higher (newer) insertion sequence first: the order of the original's sorted list, where a node
 * goes in front of the first node of greater or equal priority. Entries keep the priority they
 * were pushed with; outdated ones are skipped by the caller.
 */
class OpenHeap {
  private node: number[] = [];
  private sq: number[] = [];
  private pr: number[] = [];
  get size(): number { return this.node.length; }
  clear(): void { this.node.length = 0; this.sq.length = 0; this.pr.length = 0; }
  topNode(): number { return this.node[0]; }
  topSeq(): number { return this.sq[0]; }
  push(n: number, s: number, p: number): void {
    const node = this.node, sq = this.sq, pr = this.pr;
    let i = node.length;
    node.push(n); sq.push(s); pr.push(p);
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (!(p < pr[up] || (p === pr[up] && s > sq[up]))) break;
      node[i] = node[up]; sq[i] = sq[up]; pr[i] = pr[up];
      i = up;
    }
    node[i] = n; sq[i] = s; pr[i] = p;
  }
  pop(): void {
    const node = this.node, sq = this.sq, pr = this.pr;
    const last = node.length - 1;
    const n = node[last], s = sq[last], p = pr[last];
    node.pop(); sq.pop(); pr.pop();
    if (last === 0) return;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      if (l >= last) break;
      let c = l;
      const r = l + 1;
      if (r < last && (pr[r] < pr[l] || (pr[r] === pr[l] && sq[r] > sq[l]))) c = r;
      if (!(pr[c] < p || (pr[c] === p && sq[c] > s))) break;
      node[i] = node[c]; sq[i] = sq[c]; pr[i] = pr[c];
      i = c;
    }
    node[i] = n; sq[i] = s; pr[i] = p;
  }
}
