// Unit motion: path following step by step, turning, one unit per cell, stepping aside, idle
// fidgets. Spec: docs/game/units-and-jobs.md 4.1 (path following), 4.6 (facing and turning),
// 4.7 (cell occupancy, blocking, step aside), 4.9 (idle command), 7.7 (animals);
// docs/rendering/unit-motion.md (what the display gets).
//
// The original walks with a follow-path child job (0x06). Here walking stays the world's per-tick
// movement (jobs poll `entity.path`), but it follows the same rules: a run happens only when the
// entity's `moveAt` tick is reached, a step moves the simulation position to the destination cell
// at once and the next run comes D ticks later (D = the step delay, sent to the display), turns of
// more than 45 degrees cost ticks before a step, and a step never enters a cell that holds another
// unit. Step-aside (0x0F) and turn/idle (0x1F) are real scheduler jobs, as in the original.

import type { Job } from './scheduler.ts';
import type { World, Entity } from './world.ts';
import { dirToward, turnOnce } from './path.ts';
import { diagonalTicks } from '../formats/odb.ts';

export const MJ = { StepAside: 0x0f, TurnIdle: 0x1f } as const;
export const isMotionJob = (kind: number) => kind === MJ.StepAside || kind === MJ.TurnIdle;

/**
 * entity.walkState: normal path following; waiting to squeeze past a pushed unit (the step-aside
 * child of 4.7 case 2); a mode-0 re-plan due (avoid nearby units; only old saves and the
 * "planner still running" test of 4.7 case 3 see it, since our planner is synchronous); a mode-1
 * plan due (units ignored): the last search found nothing, so the next run plans again (4.1)
 */
export const WS = { Normal: 0, Squeeze: 1, Replan: 2, ReplanFree: 3 } as const;
/** entity.walkResult: how the last walk ended */
export const WalkResult = { Running: 0, Arrived: 1, Near: 2, Failed: 3 } as const;

/** a walk fails after this many plans (4.1) */
export const MAX_PLANS = 15;
const KIND_UNIT = 0;
const ACT_WALK = 0, ACT_IDLE = 3, ACT_CARRY = 4;
const SUBCELL = 256;
const DEFAULT_STEP: readonly number[] = [5, 6, 7, 8];
/** mode-0 plans keep out the units with 2 max(|dx|,|dy|) + min(|dx|,|dy|) < 32 around the walker (4.1) */
const NEAR_UNITS = 32;
/** cells the goal-side flood may visit before the search proper runs (see `closedAround`) */
const POCKET = 1500;
/** step-aside candidates in the original's order (4.7 step 5) */
const ASIDE: readonly [number, number][] = [[-1, 0], [-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1]];
/** step-aside job data: requester, pushed unit, pushes, start x, start y, forbidden cells... */
const SA = { Requester: 0, Pushed: 1, Pushes: 2, X: 3, Y: 4, Forbidden: 5 } as const;

/** the idle fidget command (0x2A, units-and-jobs.md 4.9); the client chooses dir/play with a display RNG */
export interface FidgetCommand { type: 'fidget'; player: number; unit: number; dir: number; play: boolean }

export class Motion {
  private w: World;
  /**
   * Unit per cell (entity id, 0 = none): units outside buildings, ships excluded (their mask has no
   * unit bit). Derived state: rebuilt from the entities at the start of every tick (lowest id wins
   * a shared cell) and kept current by the steps of that tick, so it never needs saving.
   */
  private unitAt: Int32Array;
  private marked: number[] = [];
  /** goal-side flood buffers (closedAround): visit stamps per cell and the queue */
  private floodSeen: Uint32Array;
  private floodStamp = 0;
  private floodQueue = new Int32Array(POCKET + 8);

  constructor(w: World) {
    this.w = w;
    this.unitAt = new Int32Array(w.size * w.size);
    this.floodSeen = new Uint32Array(w.size * w.size);
  }

  // ---------------------------------------------------------------- geometry

  private idx(x: number, y: number): number { const m = this.w.size - 1; return ((y & m) << this.w.bits) | (x & m); }
  private cellOf(e: Entity): [number, number] { return [Math.floor(e.x / SUBCELL), Math.floor(e.y / SUBCELL)]; }
  private wrap(d: number): number { const n = this.w.size; return d > n / 2 ? d - n : d < -n / 2 ? d + n : d; }

  // ---------------------------------------------------------------- occupancy (4.7)

  private onGrid(e: Entity): boolean { return e.kind === KIND_UNIT && e.inside < 0 && e.alive && !this.w.isShip(e); }

  /** rebuild the unit grid from the entities (start of every tick) */
  rebuild(): void {
    const at = this.unitAt;
    for (const i of this.marked) at[i] = 0;
    this.marked.length = 0;
    for (const e of this.w.entities) {
      if (e.kind !== KIND_UNIT || e.inside >= 0 || !e.alive || this.w.isShip(e)) continue;
      const i = this.idx(Math.floor(e.x / SUBCELL), Math.floor(e.y / SUBCELL));
      if (at[i] === 0) { at[i] = e.id; this.marked.push(i); }
    }
  }

  occupy(e: Entity): void {
    if (!this.onGrid(e)) return;
    const i = this.idx(...this.cellOf(e));
    if (this.unitAt[i] === 0) { this.unitAt[i] = e.id; this.marked.push(i); }
  }

  vacate(e: Entity): void {
    if (e.kind !== KIND_UNIT) return;
    const i = this.idx(...this.cellOf(e));
    if (this.unitAt[i] === e.id) this.unitAt[i] = 0;
  }

  /** the unit standing on a cell (outside, not a ship), other than `self` */
  unitOn(i: number, self?: Entity): Entity | null {
    const id = this.unitAt[i];
    if (!id || (self && id === self.id)) return null;
    const b = this.w.get(id);
    if (!b || b.kind !== KIND_UNIT || b.inside >= 0 || !b.alive) return null;
    return this.idx(...this.cellOf(b)) === i ? b : null;
  }

  /** a cell whose flags miss 0x3E: no unit, building, nature object or water */
  free(x: number, y: number, self?: Entity): boolean {
    const i = this.idx(x, y);
    return this.w.blocked[i] === 0 && !this.unitOn(i, self);
  }

  /** an idle unit (no job, not walking): it can be pushed aside */
  isIdle(u: Entity): boolean { return u.kind === KIND_UNIT && u.job === 0 && !u.path; }

  // ---------------------------------------------------------------- turning and step times (4.1, 4.6)

  /** one turn call toward `want` (-1 = none); returns the delay in ticks (0 = done, step now) */
  turn(e: Entity, want: number): number {
    const r = turnOnce(e.dir, want);
    e.dir = r.dir;
    if (!r.cost) return 0;
    const st = this.w.rules.get(e.oid)?.stepTime[0] ?? 5;
    return Math.max(1, Math.floor(st / 4));
  }

  /**
   * Delay of a step from (cx, cy) to the neighbour (nx, ny): step_time of the height class, 1.5x
   * on a diagonal; path following adds 1, or takes 1 off onto a path cell or when charging (4.1).
   * 0 = the slope is impassable for this object.
   */
  stepDelay(e: Entity, cx: number, cy: number, nx: number, ny: number, follow: boolean): number {
    const steps = this.w.rules.get(e.oid)?.stepTime ?? DEFAULT_STEP;
    const h = this.w.terrain.height;
    const dh = Math.abs(h[this.idx(nx, ny)] - h[this.idx(cx, cy)]);
    const straight = steps[Math.min(3, Math.floor(dh / 16))];
    if (!straight) return 0;
    const diag = this.wrap(nx - cx) !== 0 && this.wrap(ny - cy) !== 0;
    const base = diag ? diagonalTicks(straight) : straight;
    if (!follow) return Math.max(1, base);
    const fast = e.charging || this.w.pathFlag[this.idx(nx, ny)] === 1;
    return Math.max(1, base + (fast ? -1 : 1));
  }

  // ---------------------------------------------------------------- path following (4.1, 4.7)

  /** the walk is over: stand, and remember how it ended */
  done(e: Entity, result: number): void {
    e.path = null;
    e.walkState = WS.Normal;
    e.squeeze = 0;
    e.walkResult = result;
    // only a movement action ends with the walk: a strike or work begun meanwhile keeps playing
    if (e.action === ACT_WALK || e.action === ACT_CARRY) { e.action = ACT_IDLE as Entity['action']; e.actionTick = this.w.tick; }
  }

  /**
   * One run of the follow-path job (0x06, `00480410`, 4.1); called when entity.moveAt is reached
   * and it has a path (an empty path = a plan is due or the last step is still under way). Order:
   * the step-aside child first, then success on the goal, a due plan, the path's next cell.
   */
  run(e: Entity): void {
    const w = this.w;
    if (e.walkState === WS.Squeeze) { this.squeezeRun(e); return; }
    const path = e.path!;
    const [cx, cy] = this.cellOf(e);
    if (cx === e.goalX && cy === e.goalY) { this.done(e, WalkResult.Arrived); return; }
    if (e.walkState === WS.Replan) { this.replan(e, 0); return; }
    if (e.walkState === WS.ReplanFree) { this.replan(e, 1); return; }
    while (path.length && (path[0][0] & (w.size - 1)) === cx && (path[0][1] & (w.size - 1)) === cy) path.shift();
    if (!path.length) { this.done(e, WalkResult.Near); return; }
    const [nx, ny] = path[0];
    const dx = this.wrap(nx - cx), dy = this.wrap(ny - cy);
    // the next path cell must be a neighbour; otherwise (the unit was moved while its walk was
    // suspended, combat.md 7.4) the walk ends at once without success
    if (dx < -1 || dx > 1 || dy < -1 || dy > 1) { this.done(e, WalkResult.Failed); return; }
    const t = this.turn(e, dirToward(dx, dy));
    if (t) { e.moveAt = w.tick + t; return; }
    const i = this.idx(nx, ny);
    const ship = w.isShip(e);
    // the map changed since planning (a building, nature object, ...): re-plan avoiding nearby units
    if (ship ? w.shipBlocked[i] : w.blocked[i]) { this.replan(e, 0); return; }
    if (!ship) {
      const b = this.unitOn(i, e);
      if (b) { this.blockedBy(e, b, i); return; }
    }
    const D = this.stepDelay(e, cx, cy, nx, ny, true);
    if (!D) { this.done(e, WalkResult.Failed); return; }
    w.stepTo(e, nx, ny, D);
    path.shift();
    e.moveAt = w.tick + D;
  }

  /**
   * Start a follow-path walk (4.1) to (gx, gy): the first plan (mode 1, units ignored unless the
   * walk's mask includes them) counts as plan 1, and the first step comes 3 ticks later, never
   * before the last step is over. A search that finds nothing does not fail the walk: the next
   * run plans again. On the goal already: the walk is over at once (path null, arrived).
   * `mask` 1: every plan of this walk keeps out all units (the flee's outward walk, mask 0x3E,
   * combat.md 7.3).
   */
  start(e: Entity, gx: number, gy: number, nodes: number, mask: number): void {
    const w = this.w, m = w.size - 1;
    const [cx, cy] = this.cellOf(e);
    e.goalX = gx & m; e.goalY = gy & m;
    e.walkNodes = nodes;
    e.walkMask = mask;
    e.walkState = WS.Normal;
    e.squeeze = 0; e.pushes = 0;
    e.moveAt = Math.max(e.stepStart + e.stepTicks, w.tick + 3);
    if (cx === e.goalX && cy === e.goalY) { e.path = null; e.plans = 1; e.walkResult = WalkResult.Arrived; return; }
    e.plans = 1;
    e.walkResult = WalkResult.Running;
    const path = this.search(e, cx, cy, 1);
    if (path && path.length) e.path = path;
    else { e.path = []; e.walkState = WS.ReplanFree; }
  }

  /**
   * Plan (`0047fc00`): the arrival tolerance ends the walk when the goal is no farther than the
   * number of plans so far; after 15 plans the walk fails. Mode 0 (after a blocked step) keeps out
   * the units near the walker, mode 1 (after a failed search) ignores units. A search that finds
   * nothing leaves the walk waiting for a mode-1 plan at its next run. Each plan costs 3 + the
   * old plan count ticks. Ships and animals keep failing at once when nothing is found.
   */
  replan(e: Entity, mode: number): void {
    const w = this.w;
    e.walkState = WS.Normal;
    e.squeeze = 0;
    const [cx, cy] = this.cellOf(e);
    const d = w.logistics.dist(cx, cy, e.goalX, e.goalY);
    if (d === 0) { this.done(e, WalkResult.Arrived); return; }
    if (d <= e.plans) { this.done(e, WalkResult.Near); return; }
    if (e.plans >= MAX_PLANS) { this.done(e, WalkResult.Failed); return; }
    const old = e.plans++;
    const ship = w.isShip(e);
    const path = ship ? w.findPathOn(w.shipBlocked, cx, cy, e.goalX, e.goalY, e.walkNodes) : this.search(e, cx, cy, mode);
    e.moveAt = w.tick + 3 + old;
    if (path && path.length) { e.path = path; return; }
    if (ship || e.kind !== KIND_UNIT) { this.done(e, WalkResult.Failed); return; }
    e.path = [];
    e.walkState = WS.ReplanFree;
  }

  /**
   * One path search from (cx, cy) to the walk's goal on the land grid. Units are kept out by the
   * planning mode (4.1): mode 0 those within 2 max + min < 32 of the walker, the walk mask 1 all
   * of them. The start and goal cells are never blocked, whatever stands on them (a walk onto a
   * tree or a footprint cell is then stopped next to it by the arrival tolerance). Null when the
   * goal cannot be reached: our A* returns a partial way toward the nearest cell it reached, but
   * the original's planner has no partial result.
   */
  private search(e: Entity, cx: number, cy: number, mode: number): [number, number][] | null {
    const w = this.w, grid = w.blocked;
    const si = this.idx(cx, cy), gi = this.idx(e.goalX, e.goalY);
    const set: number[] = [];
    const block = (i: number) => {
      if (i === si || i === gi || grid[i] !== 0 || !this.unitOn(i, e)) return;
      grid[i] = 1; set.push(i);
    };
    if (e.kind === KIND_UNIT && !w.isShip(e)) {
      if (e.walkMask) for (const i of this.marked) block(i);
      else if (mode === 0) {
        for (let dy = -15; dy <= 15; dy++) for (let dx = -15; dx <= 15; dx++) {
          const ax = Math.abs(dx), ay = Math.abs(dy);
          if (2 * Math.max(ax, ay) + Math.min(ax, ay) < NEAR_UNITS) block(this.idx(cx + dx, cy + dy));
        }
      }
    }
    const sOld = grid[si], gOld = grid[gi];
    grid[si] = 0; grid[gi] = 0;
    let path: [number, number][] | null;
    try {
      path = this.closedAround(gi, si) ? null : w.findPathOn(grid, cx, cy, e.goalX, e.goalY, e.walkNodes);
    } finally {
      grid[si] = sOld; grid[gi] = gOld;
      for (const i of set) grid[i] = 0;
    }
    if (path && path.length) {
      const [lx, ly] = path[path.length - 1];
      if (this.idx(lx, ly) !== gi) return null;
    }
    return path;
  }

  /**
   * Is the goal in a closed pocket of the grid (fewer than POCKET cells) that does not hold the
   * start? Then no search can reach it, and it fails at once (the original's planner also searches
   * from the goal's end, 4.1). Only a shortcut: the A* would fail the same way, after its whole
   * node budget. Steps as in the A*: 8 neighbours, no diagonal past a blocked orthogonal cell.
   */
  private closedAround(gi: number, si: number): boolean {
    const grid = this.w.blocked, seen = this.floodSeen, q = this.floodQueue;
    const bits = this.w.bits, m = this.w.size - 1;
    if (++this.floodStamp === 0xffffffff) { this.floodStamp = 1; seen.fill(0); }
    const st = this.floodStamp;
    let head = 0, tail = 0;
    q[tail++] = gi; seen[gi] = st;
    while (head < tail) {
      const c = q[head++];
      const x = c & m, y = c >> bits;
      for (const [dx, dy] of ASIDE) {
        const n = (((y + dy) & m) << bits) | ((x + dx) & m);
        if (seen[n] === st || grid[n]) continue;
        if (dx !== 0 && dy !== 0 && (grid[(y << bits) | ((x + dx) & m)] || grid[(((y + dy) & m) << bits) | x])) continue;
        if (n === si) return false;
        if (tail >= POCKET) return false;
        seen[n] = st; q[tail++] = n;
      }
    }
    return true;
  }

  /**
   * The next step is blocked by unit b (4.7 "A blocked step"): an idle unit is pushed aside (case
   * 2); a walking unit is waited for while it can step on (its raw step time + 1) or while its
   * planner runs (3 ticks); anything else (a unit that is stuck, has no path, squeezes past
   * someone, or is busy) makes the walker re-plan in mode 0 (cases 3 and 4).
   */
  private blockedBy(e: Entity, b: Entity, i: number): void {
    const w = this.w;
    if (this.isIdle(b)) { this.startSqueeze(e, b, i); return; }
    if (b.path && b.walkState !== WS.Squeeze) {
      if (b.walkState === WS.Replan) { e.moveAt = w.tick + 3; return; }
      if (b.walkState === WS.Normal && b.path.length && this.canStep(b)) {
        const [bx, by] = this.cellOf(b), [nx, ny] = b.path[0];
        e.moveAt = w.tick + this.stepDelay(b, bx, by, nx, ny, false) + 1;
        return;
      }
    }
    this.replan(e, 0);
  }

  /** can a walking unit take its next step now */
  private canStep(b: Entity): boolean {
    const [bx, by] = this.cellOf(b), [nx, ny] = b.path![0];
    const dx = this.wrap(nx - bx), dy = this.wrap(ny - by);
    if (dx < -1 || dx > 1 || dy < -1 || dy > 1) return false;
    const i = this.idx(nx, ny);
    return this.w.blocked[i] === 0 && !this.unitOn(i, b) && this.stepDelay(b, bx, by, nx, ny, false) > 0;
  }

  /**
   * Cells an idle unit pushed by walker e may not move to: e's neighbours except the blocked cell,
   * e's next two path cells after it, e's own cell, and the pushed unit's own (the blocked) cell.
   */
  private squeezeList(e: Entity, i: number): number[] {
    const [cx, cy] = this.cellOf(e);
    const out: number[] = [];
    for (const [dx, dy] of ASIDE) { const c = this.idx(cx + dx, cy + dy); if (c !== i) out.push(c); }
    const p = e.path!;
    for (let k = 1; k <= 2 && k < p.length; k++) out.push(this.idx(p[k][0], p[k][1]));
    out.push(this.idx(cx, cy), i);
    return out;
  }

  private startSqueeze(e: Entity, b: Entity, i: number): void {
    e.walkState = WS.Squeeze;
    e.squeeze = b.id;
    e.pushes = 1;
    this.push(b, e, this.squeezeList(e, i));
    e.moveAt = this.w.tick + 1;
  }

  /**
   * The walker's step-aside child (4.7 case 2): it waits in 5-tick polls until the pushed unit is
   * gone, then steps into the freed cell (raw step time) and goes on along the rest of its old
   * path, with no plan counted. Another idle unit there is pushed in turn (more than 4 pushes
   * fail); a busy unit, a blocked cell or an impassable slope fails the child: re-plan in mode 0.
   */
  private squeezeRun(e: Entity): void {
    const w = this.w;
    const path = e.path!;
    if (!path.length) { this.replan(e, 0); return; }
    const p = e.squeeze ? w.get(e.squeeze) : undefined;
    if (p && this.pushedFor(p, e)) { e.moveAt = w.tick + 5; return; }
    e.squeeze = 0;
    const [cx, cy] = this.cellOf(e), [nx, ny] = path[0];
    const dx = this.wrap(nx - cx), dy = this.wrap(ny - cy);
    const i = this.idx(nx, ny);
    if (dx < -1 || dx > 1 || dy < -1 || dy > 1 || w.blocked[i]) { this.replan(e, 0); return; }
    const b = this.unitOn(i, e);
    if (!b) {
      const D = this.stepDelay(e, cx, cy, nx, ny, false);
      if (!D) { this.replan(e, 0); return; }
      const t = this.turn(e, dirToward(dx, dy));
      if (t) { e.moveAt = w.tick + t; return; }
      w.stepTo(e, nx, ny, D);
      path.shift();
      // the walker goes on along the rest of its old path
      e.walkState = WS.Normal;
      e.pushes = 0;
      e.moveAt = w.tick + D;
      return;
    }
    if (this.isIdle(b) && e.pushes <= 4) {
      e.pushes++;
      e.squeeze = b.id;
      this.push(b, e, this.squeezeList(e, i));
      e.moveAt = w.tick + 5;
      return;
    }
    this.replan(e, 0);
  }

  /** does p still run a step-aside job for `requester` without having moved */
  private pushedFor(p: Entity, requester: Entity): boolean {
    if (!p.alive || !p.job || p.inside >= 0) return false;
    const j = this.w.sched.get(p.job);
    if (!j || j.cancelled || j.kind !== MJ.StepAside || j.data[SA.Requester] !== requester.id) return false;
    const [x, y] = this.cellOf(p);
    return x === j.data[SA.X] && y === j.data[SA.Y];
  }

  /** give idle unit v a step-aside job (0x0F) for `requester`, scheduled after 1 tick as its current job */
  push(v: Entity, requester: Entity, forbidden: number[]): void {
    const [x, y] = this.cellOf(v);
    v.job = this.w.sched.create(MJ.StepAside, v.id, 1, [requester.id, 0, 0, x, y, ...forbidden]).id;
  }

  /**
   * Push by a unit leaving a building (leave job 0x0D, units-and-jobs.md 4.10): a step-aside job
   * with **no requester** and the leaving unit's movement mask 0x3E, so a cell holding any unit is
   * no candidate and the push never chains. Requester -1 marks this mode in the job data.
   */
  pushFromDoor(v: Entity, forbidden: number[]): void {
    const [x, y] = this.cellOf(v);
    v.job = this.w.sched.create(MJ.StepAside, v.id, 1, [-1, 0, 0, x, y, ...forbidden]).id;
  }

  // ---------------------------------------------------------------- jobs

  runJob(job: Job): number {
    if (job.kind === MJ.StepAside) return this.runStepAside(job);
    if (job.kind === MJ.TurnIdle) return this.runTurnIdle(job);
    return 0;
  }

  /** step aside (0x0F, `0047df70`): move to the first free neighbour, or push the next idle unit */
  private runStepAside(job: Job): number {
    const w = this.w, d = job.data;
    const v = w.get(job.owner);
    const end = (): number => {
      if (v && v.job === job.id) {
        v.job = 0;
        if (!v.path && (v.action === ACT_WALK || v.action === ACT_CARRY)) { v.action = ACT_IDLE as Entity['action']; v.actionTick = w.tick; }
      }
      return 0;
    };
    if (!v || !v.alive || v.inside >= 0 || v.job !== job.id) return end();
    // requester -1: pushed by a leaving unit, no requester and mask 0x3E (pushFromDoor)
    const strict = d[SA.Requester] < 0;
    if (!strict) { const r = w.get(d[SA.Requester]); if (!r || !r.alive) return end(); }
    const [x, y] = this.cellOf(v);
    if (x !== d[SA.X] || y !== d[SA.Y]) return end();                     // moved: success
    if (d[SA.Pushed]) {
      const p = w.get(d[SA.Pushed]);
      if (p && this.pushedFor(p, v)) return 5;
      d[SA.Pushed] = 0;
    }
    if (d[SA.Pushes] > 4) return end();
    let idle: Entity | null = null;
    for (const [dx, dy] of ASIDE) {
      const c = this.idx(x + dx, y + dy);
      if (w.blocked[c] || d.indexOf(c, SA.Forbidden) >= 0) continue;
      const b = this.unitOn(c, v);
      if (!b) {
        const D = this.stepDelay(v, x, y, x + dx, y + dy, false);
        if (!D) continue;
        const t = this.turn(v, dirToward(dx, dy));
        if (t) return t;
        w.stepTo(v, x + dx, y + dy, D);
        return D;
      }
      if (!strict && !idle && this.isIdle(b)) idle = b;
    }
    if (idle) {
      const [ix, iy] = this.cellOf(idle);
      this.push(idle, v, [...d.slice(SA.Forbidden), this.idx(ix, iy)]);
      d[SA.Pushed] = idle.id;
      d[SA.Pushes]++;
      return 5;
    }
    return end();
  }

  /** turn / idle (0x1F, `0047f030`): turn toward the direction, then optionally play the idle action */
  private runTurnIdle(job: Job): number {
    const w = this.w, d = job.data;
    const u = w.get(job.owner);
    if (!u || !u.alive || u.job !== job.id) return 0;
    const t = this.turn(u, d[0]);
    if (t) return t;
    if (d[1]) this.playIdle(u, d[2]);
    u.job = 0;
    return 0;
  }

  /** start the idle action (3, `ID`) with a repeat count (0 = one cycle); cut by the next step or action */
  playIdle(e: Entity, loops: number): void {
    e.action = ACT_IDLE as Entity['action'];
    e.actionTick = this.w.tick;
    e.idleTick = this.w.tick;
    e.idleLoops = loops;
  }

  /**
   * Idle fidget command (0x2A, `00452000`, units-and-jobs.md 4.9): only for a unit without a job
   * (and, here, not walking, since our plain moves have no job); a carrying unit only turns. No
   * owner test, like the original. Ships are skipped (Gold excludes types 64..67).
   */
  fidget(cmd: FidgetCommand): void {
    const w = this.w;
    const u = w.get(Math.trunc(Number(cmd.unit)));
    const dir = Math.trunc(Number(cmd.dir));
    if (!u || u.kind !== KIND_UNIT || !u.alive || u.inside >= 0 || u.job !== 0 || u.path || w.isShip(u)) return;
    if (!(dir >= 0 && dir <= 7)) return;
    const play = cmd.play === true && u.carryAmount <= 0;
    u.job = w.sched.create(MJ.TurnIdle, u.id, 1, [dir, play ? 1 : 0, 0]).id;
  }
}
