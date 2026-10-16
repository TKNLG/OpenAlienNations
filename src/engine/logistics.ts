// Unit jobs, porters, construction, production and gathering.
// Spec: docs/game/units-and-jobs.md (section numbers below); economy parts: docs/game/economy.md.
//
// Every behaviour is a scheduler job (plain data, saved with the game). A unit has at most one
// job (entity.job). Walking itself is done by the world's per-tick movement; a job that waits
// for a unit to arrive polls every tick. Entering a building goes through the building's door
// queue: only the head of the queue may enter, the others retry after 10 ticks (4.4).

import type { Job } from './scheduler.ts';
import type { World, Entity, BuildOrder } from './world.ts';
import { Kind, Action, SUB } from './world.ts';
import { T, Good, ADVISOR_REPEAT_MS, type Town } from './economy.ts';
import { BuildingFlag, type ObjectRule } from '../formats/odb.ts';
import { MAX_PLANS, WalkResult } from './motion.ts';
import { needsTerritory } from './territory.ts';
import { ring } from './ai-defs.ts';

export const LJ = {
  Dispatcher: 0x00, Leisure: 0x03, Transport: 0x05, Builder: 0x0c, Training: 0x12, Production: 0x13, Harvest: 0x16,
  Growth: 0x1d, Regrowth: 0x1e, Plant: 0x21, Operator: 0x22, Animal: 0x24, Respawn: 0x37, Answer: 0x3c,
  Found: 0x0e, Hunt: 0x2b, Leave: 0x0d, News: 0x1a,
} as const;
/** leave job data (units-and-jobs.md 4.10): the building left, runs so far, the eject's "sent out"
 *  flag (send-out command and DEAKTIVIEREN, 4.11; absent in older saves = cleared) */
const LV = { Building: 0, Runs: 1, SentOut: 2 } as const;
/** found-town job data (units-and-jobs.md 11.3) */
const FD = { Phase: 0, Hall: 1, Done: 2 } as const;
const LOGISTICS_KINDS = new Set<number>(Object.values(LJ));
export const isLogisticsJob = (kind: number) => LOGISTICS_KINDS.has(kind);

/** nature behaviour classes (odb.md 4) */
export const NC = { Animal: 7, Tree: 8, Bush: 9, CropA: 10, CropS: 12, Stone: 13 } as const;
const RUBBLE = 38;
/** growth stages of a planted tree, 599 ticks each (the original counts its sprite's frames) */
const TREE_STAGES = 5;
/** animals only walk a few cells: keep their path searches small */
const ANIMAL_PATH_NODES = 400;
const NATURE_GROUP = 6;
/** extra unit types used here */
const U = { Hunter: 17, Woodcutter: 19, NewsSeller: 20, Stonemason: 27, Merchant: 28 } as const;
const NEWS_STAND = 51;
/** `enter` result: the request answered "done" without entering (a news seller at any building but
 *  a news stand, request result 3, units-and-jobs.md 4.4 item 2): a success */
export const ENTER_DONE = -2;

/** transport request lists (5.1) */
export const List = { Training: 0, Construction: 1, Production: 2, Pickup: 3 } as const;

/** mentor lines */
const M = { BuildingDone: 1, NoBuilder: 9, OperatorArrived: 10, Stopped: 11, Trained: 13, NoPorter: 14, StoresFull: 17, NewTown: 19, AnimalsEat: 81 } as const;
const MAX_QUEUE = 5;
/** a walk ended by the arrival tolerance may enter a building from this far: the tolerance's own limit (4.1, 4.4) */
const NEAR_DOOR = MAX_PLANS;
const MAX_TOWNS = 10;

const GOODS = 9;
const NONE = -1;
/** rings 0..9 of the next-object search around the old target (7.1.1) */
const NEXT_RINGS = 9;
/** a harvest walk that cannot be planned: the time the original's 15 failed plans take (3 + ... + 17, 7.1.1 ours 2) */
const WALK_FAILED = 150;

export class Logistics {
  private w: World;
  constructor(w: World) { this.w = w; }

  // ---------------------------------------------------------------- geometry

  private cellOf(e: Entity): [number, number] { return [Math.floor(e.x / SUB), Math.floor(e.y / SUB)]; }

  /** torus distance d = max(|dx|,|dy|) + floor(min(|dx|,|dy|)/2) (2) */
  dist(ax: number, ay: number, bx: number, by: number): number {
    const n = this.w.size;
    let dx = Math.abs(ax - bx), dy = Math.abs(ay - by);
    if (dx > n / 2) dx = n - dx;
    if (dy > n / 2) dy = n - dy;
    return Math.max(dx, dy) + Math.floor(Math.min(dx, dy) / 2);
  }
  private distE(a: Entity, bx: number, by: number): number { const [x, y] = this.cellOf(a); return this.dist(x, y, bx, by); }

  entrance(b: Entity): [number, number] {
    const r = this.w.rules.get(b.oid);
    const [x, y] = this.cellOf(b), m = this.w.size - 1;
    return [(x + (r?.doorDx ?? 0)) & m, (y + (r?.doorDy ?? 1)) & m];
  }

  private rule(e: Entity): ObjectRule | undefined { return this.w.rules.get(e.oid); }
  private type(e: Entity): number { return e.oid & 0xffff; }
  private town(e: Entity): Town | undefined { return this.w.economy.town(e.town); }

  // ---------------------------------------------------------------- building stock

  /** town stock for a completed store, otherwise the building's local stock (2) */
  private isStore(b: Entity): boolean { return !!((this.rule(b)?.flags ?? 0) & BuildingFlag.TownStorage) && b.complete; }
  stockOf(b: Entity, good: number): number {
    if (this.isStore(b)) return this.town(b)?.stock[good] ?? 0;
    return b.local[good];
  }
  private take(b: Entity, good: number, n: number): void {
    if (this.isStore(b)) { const t = this.town(b); if (t) this.w.economy.removeGood(t, good, n); }
    else b.local[good] = Math.max(0, b.local[good] - n);
  }
  /** add goods; returns how many were stored (town stock is clamped to capacity) */
  private put(b: Entity, good: number, n: number): number {
    if (this.isStore(b)) { const t = this.town(b); return t ? this.w.economy.addGood(t, good, n) : 0; }
    b.local[good] += n;
    return n;
  }
  private room(b: Entity, good: number): number {
    if (this.isStore(b)) { const t = this.town(b); return t ? this.w.economy.space(t, good) : 0; }
    return Math.max(0, (this.rule(b)?.amount ?? 0) - b.local[good]);
  }

  /** best store of a town for a point: town hall or completed warehouse; score = distance + 2 x door queue (4.3) */
  nearestStore(t: Town, x: number, y: number): Entity | null {
    let best: Entity | null = null, bestScore = Infinity;
    for (const e of this.w.entities) {
      if (e.kind !== Kind.Building || e.town !== t.id || !e.complete) continue;
      const ty = this.type(e);
      if (ty !== T.TownHall && ty !== T.Warehouse) continue;
      const [ex, ey] = this.entrance(e);
      const s = this.dist(x, y, ex, ey) + 2 * e.doorQueue.length;
      if (s < bestScore) { best = e; bestScore = s; }
    }
    return best;
  }

  // ---------------------------------------------------------------- requests (5.1)

  requestTransport(t: Town, list: number, id: number): void {
    t.lists[list].push(id);
    this.wakeDispatcher(t);
  }
  requestWorker(t: Town, type: number, building: number): void {
    t.workerReqs.push([type, building]);
    this.wakeDispatcher(t);
  }
  private wakeDispatcher(t: Town): void {
    if (t.dispatcher && this.w.sched.get(t.dispatcher)) return;
    t.dispatcher = this.w.sched.create(LJ.Dispatcher, t.id, 1).id;
  }

  // ---------------------------------------------------------------- free units (5.4)

  /**
   * The free test (5.4, `0045aed0`): alive, the asked group id, and either outside with no job, or
   * on a leisure visit (+0x78 = -1) unless inside a building with a job. Also the computer
   * players' "free" unit (ai-diplomacy-trade.md 0, `0045b110`).
   */
  static free(u: Entity, group: number): boolean {
    return u.alive && u.group === group && ((u.job === 0 && u.inside < 0) || (u.idle === -1 && !(u.inside >= 0 && u.job !== 0)));
  }

  private isFree(u: Entity, t: Town, type: number, group = 0): boolean {
    return u.kind === Kind.Unit && u.town === t.id && (u.oid & 0xffff) === type && (u.oid >>> 16) === t.race && Logistics.free(u, group);
  }

  /**
   * The group whose porters haul (transport requests, leisure): 50, the porter gang, in a town of a
   * running computer player (ai-diplomacy-trade.md 1.10, 5.4 here); otherwise 0. Worker requests
   * (operators, builders, trainees) always take group 0 (ai-diplomacy-trade.md 1.7).
   */
  haulGroup(t: Town): number { return this.w.ai?.isComputer(t.race) ? 50 : 0; }

  /** nearest free unit of a type to a cell; stops early at a unit closer than 3 */
  private nearestFree(t: Town, type: number, x: number, y: number, taken?: Set<number>, group = 0): Entity | null {
    let best: Entity | null = null, bd = Infinity;
    for (const u of this.w.entities) {
      if (!this.isFree(u, t, type, group) || taken?.has(u.id)) continue;
      const d = this.distE(u, x, y);
      if (d < bd) { best = u; bd = d; if (d < 3) break; }
    }
    return best;
  }

  // ---------------------------------------------------------------- jobs

  runJob(job: Job): number {
    switch (job.kind) {
      case LJ.Dispatcher: return this.runDispatcher(job);
      case LJ.Transport: return this.runTransport(job);
      case LJ.Builder: return this.runBuilder(job);
      case LJ.Training: return this.runTraining(job);
      case LJ.Production: return this.runProduction(job);
      case LJ.Harvest: return this.runHarvest(job);
      case LJ.Growth: return this.runGrowth(job);
      case LJ.Regrowth: return this.runRegrowth(job);
      case LJ.Operator: return this.runOperator(job);
      case LJ.Plant: return this.runPlant(job);
      case LJ.Answer: return this.runAnswer(job);
      case LJ.Leisure: return this.runLeisure(job);
      case LJ.Animal: return this.runAnimal(job);
      case LJ.Respawn: return this.runRespawn(job);
      case LJ.Found: return this.runFound(job);
      case LJ.Hunt: return this.runHunt(job);
      case LJ.Leave: return this.runLeave(job);
      case LJ.News: return this.runNews(job);
      default: return 0;
    }
  }

  /** give a unit a new job, cancelling the old one */
  assign(u: Entity, kind: number, delay: number, data: number[]): Job {
    // the unit is on its way out of a building: the new job waits behind the leave job, blocked
    // for 5 ticks; a job already waiting there is cancelled (1.2 `00465650`)
    if (this.leaving(u)) {
      for (const id of u.suspended.splice(0)) {
        const sj = this.w.sched.get(id);
        if (sj && !sj.cancelled) { sj.cancelled = true; sj.hold = 0; this.cleanup(sj, u); this.dutyDropped(sj, u); }
      }
      u.idle = 0;
      const q = this.w.sched.create(kind, u.id, delay, data);
      q.hold = 5;
      u.suspended.push(q.id);
      return q;
    }
    this.cancelJob(u);
    const inside = u.inside >= 0 && this.w.get(u.inside)?.kind === Kind.Building && u.idle === -1;
    u.idle = 0;
    const j = this.w.sched.create(kind, u.id, delay, data);
    u.job = j.id;
    // called away from a leisure visit: the building ejects the unit, the new job waits behind the leave job
    if (inside) this.leave(u);
    return j;
  }

  /** end a unit's job early (new order, death); undoes reservations */
  cancelJob(u: Entity): void {
    u.charging = false;
    u.walks = [];
    this.abortEnter(u);
    for (const id of u.suspended.splice(0)) {
      const sj = this.w.sched.get(id);
      if (sj && !sj.cancelled) { sj.cancelled = true; sj.hold = 0; this.cleanup(sj, u); this.dutyDropped(sj, u); }
    }
    if (!u.job) return;
    const j = this.w.sched.get(u.job);
    u.job = 0;
    if (!j || j.cancelled) return;
    j.cancelled = true;
    this.cleanup(j, u);
    this.dutyDropped(j, u);
  }

  /**
   * A job destroyed before its normal end (cancelled by an order, a move, go home, `DEAKTIVIEREN`,
   * a replacing job, or the unit's death) that its building sent its operator out on
   * (units-and-jobs.md 8.5): when the job was under way (it had a child) or the unit died, the
   * building loses its stored operator and is deactivated (`0045ff30`); when the operator died,
   * the police station and the farm also file a worker request for his type.
   * Duty jobs: the officer's arrest job with a station (combat.md 12.3; its walk back is our go-to
   * job marked as duty), the farmer's plant job (7.6), the diplomat's errand
   * (ai-diplomacy-trade.md 3.4). The news round (8.6) never breaks the link: a dead seller only
   * files a worker request at his stand, which stays active with him as its stored operator.
   */
  private dutyDropped(j: Job, u: Entity): void {
    const d = j.data;
    if (j.kind === LJ.News) {
      const t = this.town(u);
      if (!u.alive && t && t.alive && this.w.get(d[NR.Stand])) this.requestWorker(t, this.type(u), d[NR.Stand]);
      return;
    }
    let bid = -1, request = false, underWay = true;
    if (j.kind === 0x18 && d[0]) { bid = d[0]; request = true; underWay = d[1] !== 0; }
    else if (j.kind === LJ.Answer && d[AN.Duty]) { bid = d[AN.Building]; request = true; }
    else if (j.kind === LJ.Plant) { bid = d[1]; request = true; }
    else if (j.kind === 0x38) bid = d[3];
    if (bid < 0 || (!underWay && u.alive)) return;
    const b = this.w.get(bid);
    if (!b || b.kind !== Kind.Building || !b.alive) return;
    this.deactivateBuilding(b);
    const t = this.town(u);
    if (request && !u.alive && t && t.alive) this.requestWorker(t, this.type(u), b.id);
  }

  // ---------------------------------------------------------------- helpers for combat

  /** start walking to a building's entrance (or an object) */
  walkTo(u: Entity, e: Entity): boolean { return this.goEntity(u, e); }
  /** try to enter a building now (door queue); false if not near or not first in the queue */
  /** one step of entering a building (4.10): -1 not at its door, 0 inside now, otherwise the ticks to the next call */
  enterNow(u: Entity, b: Entity): number { return this.near(u, b) ? this.enter(u, b) : -1; }
  /** walk into a building: an officer back to his station at the end of his arrest job (a duty walk, 8.5) */
  goHome(u: Entity, b: Entity): void { this.assign(u, LJ.Answer, 1, [0, b.id, u.oid & 0xffff, 1, 1]); }
  /** go to a building and enter it (go-to 0x07), first run after `delay` ticks; no request is re-filed on failure */
  goInto(u: Entity, b: Entity, delay: number): void { this.assign(u, LJ.Answer, delay, [0, b.id, u.oid & 0xffff, 1]); }

  private finish(u: Entity | undefined): number {
    if (!u) return 0;
    // the job was queued behind a leave job: it just ends, the leave job stays current
    if (this.leaving(u)) { u.ordered = false; return 0; }
    this.abortEnter(u);
    u.job = 0; u.ordered = false;
    if (this.w.combat) return this.w.combat.endUnitJob(u);
    if (u.inside < 0 && !u.path) this.setAction(u, Action.Idle);
    return 0;
  }

  private cleanup(j: Job, u: Entity): void {
    const d = j.data;
    if (j.kind === LJ.Transport) {
      // the destructor (`0047c160`, 5.5): a live requester that is not a completed store gets back
      // the good to fetch until it has been dropped at the destination (picked up or not: a killed
      // porter's load is lost, a live one keeps carrying it) and an output not yet taken; each goes
      // to the front of its list with one list-1 request (also for production inputs and outputs)
      const req = this.w.get(d[TR.Requester]);
      const t = req && req.alive && !this.isStore(req) ? this.town(req) : undefined;
      if (req && t) {
        if (d[TR.Fetch] >= 0) { req.needed.unshift(d[TR.Fetch]); this.requestTransport(t, List.Construction, req.id); }
        if (d[TR.Output] >= 0) { req.outputs.unshift(d[TR.Output]); this.requestTransport(t, List.Construction, req.id); }
      }
      d[TR.Fetch] = NONE; d[TR.Output] = NONE;
    } else if (j.kind === LJ.Harvest) {
      const n = this.w.get(d[HV.Target]);
      if (n && d[HV.Reserved]) n.reserved = Math.max(0, n.reserved - d[HV.Reserved]);
    } else if (j.kind === LJ.Hunt) {
      const n = d[HG.Child] === HuntChild.Harvest ? this.w.get(d[HG.Harvest + HV.Target]) : undefined;
      if (n && d[HG.Harvest + HV.Reserved]) n.reserved = Math.max(0, n.reserved - d[HG.Harvest + HV.Reserved]);
    } else if (j.kind === LJ.Builder) {
      this.builderLeft(u, d);
    } else if (j.kind === LJ.Found) {
      // an interrupted founding destroys the new town (11.6); unlike the original only the job's
      // own target hall, and only while it is a site or not yet active (the original uses the
      // founder's current town at deletion time, which can wipe out another town)
      const hall = this.w.get(d[FD.Hall]);
      if (!d[FD.Done] && u.inside < 0 && hall && hall.alive && !hall.active) this.w.combat.collapse(hall, true, true);
    } else if (j.kind === LJ.Answer) {
      const b = this.w.get(d[AN.Building]);
      const t = b && this.town(b);
      if (b && t && !d[AN.Done]) this.requestWorker(t, d[AN.Type], b.id);
    } else if (j.kind === LJ.Leave) {
      // a leave job that held the door open lets go of it
      const b = this.w.get(d[LV.Building]);
      if (b && d[LV.Runs] >= 1) this.doorDown(b, false);
    }
    for (const b of this.w.entities) if (b.doorQueue.length) b.doorQueue = b.doorQueue.filter(id => id !== u.id);
  }

  private setAction(u: Entity, a: number): void {
    const act = a === Action.Walk && u.carryAmount > 0 ? Action.Carry : a;
    if (u.action !== act) { u.action = act as Entity['action']; u.actionTick = this.w.tick; }
  }

  // ---------------------------------------------------------------- walking and doors (4)

  /** start walking to a cell (public form of the jobs' walk, used by the add-on jobs) */
  walkToCell(u: Entity, x: number, y: number): boolean { return this.goCell(u, x, y); }

  /** goods dropped into a building (a harbour: the town stock, clamped; addon.md 3.3) */
  deliver(b: Entity, good: number, n: number): number {
    const stored = this.put(b, good, n);
    if (this.isStore(b) && stored < n) this.w.notify(b.owner, M.StoresFull, true, ADVISOR_REPEAT_MS);
    return stored;
  }

  /**
   * Add-on harbour and shipyard (door 0,0): the entrance is the footprint's max corner, a cell of
   * the building itself. Units reach "the nearest cell their mask allows" (addon.md 3.2), and
   * entering has no distance test in the original: here anything within 6 cells of the footprint.
   */
  doorInside(b: Entity): boolean {
    if (!this.w.addon || b.kind !== Kind.Building) return false;
    const r = this.rule(b);
    return !!r && r.doorDx === 0 && r.doorDy === 0;
  }

  /**
   * Start walking to a cell; true if a path exists (or already there). Planning does not change
   * the action: the walk (or carry) action comes with the first step (`World.stepTo`), so a strike
   * or work animation plays on until then (docs/architecture/simulation.md "Display contract").
   */
  private goCell(u: Entity, x: number, y: number): boolean {
    return this.w.follow(u, x, y);
  }
  /** go to an object (job 0x07): its entrance or cell, moved by the go-to target chooser (4.8) */
  private goEntity(u: Entity, e: Entity): boolean {
    const [px, py] = e.kind === Kind.Building ? this.entrance(e) : this.cellOf(e);
    if (this.doorInside(e) || this.w.isShip(u)) return this.goCell(u, px, py);
    const [x, y] = this.w.goalCell(px, py);
    return this.goCell(u, x, y);
  }
  /**
   * Close enough to work on a target (nature: adjacent, building: at the entrance). A walk that the
   * arrival tolerance ended a little short (4.1, e.g. in the crowd at a door) counts as arrived, as
   * in the original, where entering has no distance test.
   */
  private near(u: Entity, e: Entity): boolean {
    const [ux, uy] = this.cellOf(u);
    if (this.doorInside(e)) return this.w.naval.dockRange(u, e);
    if (e.kind === Kind.Building) {
      const [x, y] = this.entrance(e), d = this.dist(ux, uy, x, y);
      return d <= 1 || (d <= NEAR_DOOR && this.w.walkOk(u));
    }
    const [x, y] = this.cellOf(e);
    return this.dist(ux, uy, x, y) <= 1;
  }
  /**
   * May the unit ask to enter now? The go-to (0x07) and the enter job ignore how their walks ended
   * and measure no distance (4.2, 4.10): a unit whose walk failed (a jam, an unreachable door)
   * asks from where it stands. Only the add-on harbour / shipyard (door inside) and ships keep our
   * docking range test.
   */
  private atDoor(u: Entity, b: Entity): boolean {
    return this.doorInside(b) || this.w.isShip(u) ? this.near(u, b) : true;
  }
  /** within one cell on both axes (harvest phase 1, 4.8) */
  private adjacent(u: Entity, e: Entity): boolean {
    const [ux, uy] = this.cellOf(u), [x, y] = this.cellOf(e), n = this.w.size;
    let dx = Math.abs(ux - x), dy = Math.abs(uy - y);
    if (dx > n / 2) dx = n - dx;
    if (dy > n / 2) dy = n - dy;
    return dx <= 1 && dy <= 1;
  }

  // ---------------------------------------------------------------- entering and leaving (4.4, 4.10)

  /** door counter + 1; on 0 -> 1 the door-open message (0x2B, objects.md 4.1) */
  private doorUp(b: Entity): void {
    if (b.door++ === 0) b.doorOpen = this.w.tick;
  }
  /** door counter - 1; `always`: the message closes the door picture anyway (unit entered, unit
   *  placed outside), otherwise only when the counter reaches 0 (0x2C) */
  private doorDown(b: Entity, always: boolean): void {
    b.door = Math.max(0, b.door - 1);
    if (always || b.door === 0) b.doorShut = this.w.tick;
  }

  /** the unit's enter sequence is given up (job cancelled or ended): an admitted unit lets go of the door */
  abortEnter(u: Entity): void {
    if (u.entering < 0) return;
    const b = this.w.get(u.entering);
    if (b) {
      if (u.enterStep === 2) this.doorDown(b, false);
      if (b.doorQueue.length) b.doorQueue = b.doorQueue.filter(id => id !== u.id);
    }
    u.entering = -1; u.enterStep = 0;
  }

  /**
   * Entering a building (the go-to job's turn, then the enter job 0x0B; 4.4, 4.10 "Entering"), one
   * call per run of the caller's job. Returns 0 when the unit is inside now, otherwise the ticks
   * to the next call:
   * - the turn toward the building's anchor (front corner), at the turn costs of 4.6, then 1 tick
   *   to the first request;
   * - 10 while it is not the head of the door queue;
   * - 5 after admission: the door counter goes up (door opens on 0 -> 1) and a last step onto the
   *   entrance is planned if the unit stands off it; then (once that walk is over) "entered": the
   *   door closes, the unit leaves the queue and is taken off its cell.
   * A construction site has no door: no counter, no message, and the unit stays on the map.
   * Returns -1 when the building refuses the unit at its first request (`mayEnter`): the unit
   * is not queued and its enter sequence ends. Returns `ENTER_DONE` (-2) for a news seller at any
   * building but a news stand: done without entering, a success (4.4 item 2).
   */
  enter(u: Entity, b: Entity): number {
    if (u.entering !== b.id || (u.enterStep >= 2 && b.doorQueue[0] !== u.id)) {
      this.abortEnter(u);
      u.entering = b.id; u.enterStep = 0;
    }
    if (u.enterStep === 0) {
      if (!this.doorInside(b) && !this.w.isShip(u)) {
        const [ax, ay] = this.cellOf(b);
        const t = this.w.turnToward(u, ax, ay);
        if (t) return t;
      }
      u.enterStep = 1;
      return 1;
    }
    if (u.enterStep === 1) {
      b.doorQueue = b.doorQueue.filter(id => { const x = this.w.get(id); return !!x && x.job !== 0; });
      if (!b.doorQueue.includes(u.id)) {
        // a news seller asking at any building but a news stand is "done" at once, before the
        // queue and the may-enter test: he never enters (request result 3, 4.4 item 2, 8.6)
        if (this.type(u) === U.NewsSeller && this.type(b) !== NEWS_STAND && b.kind === Kind.Building) { this.abortEnter(u); return ENTER_DONE; }
        // the may-enter test runs only at the first request: a unit already queued is never
        // tested again (combat.md 9.1, capacity quirk)
        if (!this.mayEnter(u, b)) { this.abortEnter(u); return -1; }
        b.doorQueue.push(u.id);
      }
      if (b.doorQueue[0] !== u.id) return 10;
      // admitted: the door opens (completed buildings only), last step onto the entrance
      if (b.complete) { this.doorUp(b); u.enterStep = 2; } else u.enterStep = 3;
      if (!this.doorInside(b) && !this.w.isShip(u)) {
        const [ex, ey] = this.entrance(b);
        const [gx, gy] = this.w.goalCell(ex, ey), [ux, uy] = this.cellOf(u);
        if (ux !== gx || uy !== gy) this.goCell(u, gx, gy);
      }
      return 5;
    }
    // the last step's result is not checked: the unit enters wherever it stands
    if (u.path) return 1;
    b.doorQueue = b.doorQueue.filter(id => id !== u.id);
    const door = u.enterStep === 2;
    u.entering = -1; u.enterStep = 0;
    if (!door) return 0;                      // construction site: never taken off the map
    this.doorDown(b, true);                   // "unit entered": the door closes
    this.w.putInside(u, b);
    this.w.halt(u);
    this.w.motion.vacate(u);
    return 0;
  }

  /**
   * The may-enter test (`00460a10`, 4.4) for the cases our build refuses: a completed outpost
   * (class 6) admits only class-2 units of its race while its occupants are below its capacity
   * (+0xDC), plus (as any building) units on a transport job (combat.md 9.1); a training
   * building (class 5) refuses ships (Gold); an active building refuses a unit of its operator
   * type and race that is not its stored operator. Every other building admits everyone.
   */
  mayEnter(u: Entity, b: Entity): boolean {
    const r = this.rule(b);
    // Gold: a training building admits everyone except ships (addon.md 3.4, `00466cd0`)
    if (r && r.cls === 5 && b.kind === Kind.Building && this.w.isShip(u)) return false;
    if (r && r.residents > 0 && r.cls !== 5 && b.complete && b.kind === Kind.Building) return this.mayEnterResidence(u, b, r);
    // a unit of the building's operator type and race is admitted only while the building is not
    // active or as its stored operator (`00460a10`); units on a transport or builder job (our
    // gathering deliveries stand for a transport child) are admitted before that test. So a second
    // officer, farmer or news seller stays outside an active building, and a replacement seller
    // is refused by a stand that keeps its dead seller (8.6 "Death")
    if (r && b.kind === Kind.Building && b.complete && b.active && r.operator >= 0 && r.cls !== 5 && r.cls !== 6
      && this.type(u) === r.operator && (u.oid >>> 16) === (b.oid >>> 16) && u.id !== b.operatorId) {
      const k = this.mainJob(u)?.kind;
      if (k !== LJ.Transport && k !== LJ.Builder && k !== LJ.Harvest && k !== LJ.Hunt) return false;
    }
    if (!r || r.cls !== 6 || !b.complete || b.kind !== Kind.Building) return true;
    if (this.mainJob(u)?.kind === LJ.Transport) return true;
    return (u.oid >>> 16) === (b.oid >>> 16) && this.rule(u)?.cls === 2 && this.occupants(b).length < r.garrison;
  }

  /**
   * The may-enter test for a completed residence (houses, town hall; 4.4 "Residences"): units on a
   * transport or builder job (our harvest and hunting deliveries stand for the original's transport
   * child), the operator type while the building is inactive or as its stored operator (the
   * founder), porters at a visit building (houses); other races only on a trade or errand job.
   * Everyone else is refused at the door.
   */
  private mayEnterResidence(u: Entity, b: Entity, r: ObjectRule): boolean {
    const k = this.mainJob(u)?.kind;
    if ((u.oid >>> 16) !== (b.oid >>> 16)) return k === 0x20 || k === 0x38;
    if (k === LJ.Transport || k === LJ.Harvest || k === LJ.Hunt || k === LJ.Builder) return true;
    const ty = u.oid & 0xffff;
    if (ty === r.operator && (!b.active || u.id === b.operatorId)) return true;
    return ty === T.Porter && !!(r.flags & BuildingFlag.PortersVisit);
  }

  /** a class-2 unit inside an outpost (class 6) of its race: a garrison unit (combat.md 9.2, objects.md 13.1) */
  isGarrison(u: Entity, b: Entity): boolean {
    return u.kind === Kind.Unit && u.inside === b.id && this.rule(b)?.cls === 6 && this.rule(u)?.cls === 2;
  }

  /** the unit's current job is a leave job (0x0D) */
  leaving(u: Entity): boolean {
    if (!u.job) return false;
    const j = this.w.sched.get(u.job);
    return !!j && !j.cancelled && j.kind === LJ.Leave;
  }

  /** the unit's job, looking past a leave job to the job queued behind it (status, route and errand queries) */
  mainJob(u: Entity): Job | undefined {
    if (this.leaving(u)) {
      for (let k = u.suspended.length - 1; k >= 0; k--) {
        const j = this.w.sched.get(u.suspended[k]);
        if (j && !j.cancelled) return j;
      }
      return undefined;
    }
    const j = u.job ? this.w.sched.get(u.job) : undefined;
    return j && !j.cancelled ? j : undefined;
  }

  /** building a unit is on its way out of (leave job), -1 none */
  leavingFrom(u: Entity): number {
    if (!this.leaving(u)) return -1;
    return this.w.sched.get(u.job)!.data[LV.Building];
  }

  /**
   * The building's occupant list (+0x58, 4.10 step 6, 4.11): its units inside in the order they
   * entered (head = inside longest). A unit on its way out has left the list at its eject.
   */
  occupants(b: Entity): Entity[] {
    return this.w.entities.filter(u => u.kind === Kind.Unit && u.inside === b.id && !this.leaving(u))
      .sort((a, c) => a.enterSeq - c.enterSeq);
  }

  /**
   * Send-out (command 0x3A, `004520e0`, 4.11): the first occupant of unit type `type` (any race),
   * in entering order, is ejected with the "sent out" flag. Criminals are never sent out, nor the
   * founder of a town hall; nothing happens when no such occupant is inside. True when a unit was
   * ejected.
   */
  sendOut(b: Entity, type: number): boolean {
    if (b.kind !== Kind.Building || type === T.Criminal || (type === T.Founder && this.type(b) === T.TownHall)) return false;
    const u = this.occupants(b).find(o => this.type(o) === type);
    if (!u) return false;
    this.leave(u, true);
    return this.leaving(u);
  }

  /**
   * Deactivation (`0045ff30`, 4.11): the stored operator is released and the operator / visit job
   * cancelled (a production job stays, idle while the building is inactive); upkeep and store
   * capacity are removed and an embassy may reset its player's relations. No worker request is
   * filed: the building waits for a unit of its operator type to enter again.
   */
  deactivateBuilding(b: Entity): void {
    b.operatorId = -1;
    if (b.opJob) { this.w.sched.cancel(b.opJob); b.opJob = 0; }
    if (!b.active) return;
    // mentor#11 "Ein Gebäude hat seinen Betrieb eingestellt." for a living building (side-panel.md 1.1.3)
    if (b.alive) this.w.notify(b.owner, M.Stopped);
    this.w.economy.deactivate(b);
    this.w.diplomacy.embassyDeactivated(b);
  }

  /**
   * Eject a unit (building method +0x20, 4.10 "Ejecting"): it gets a leave job (0x0D) whose first
   * run comes 10 ticks later; a job it already had waits behind it (blocked for 5 ticks unless it
   * was blocked already) and resumes when the unit is outside. Nothing happens for a unit that is
   * not inside (construction sites never take units off the map) or already on its way out. A
   * ship's passenger is put ashore at once (add-on). `sentOut`: the eject's "sent out" flag
   * (send-out command, DEAKTIVIEREN), tested when the unit is put outside.
   */
  leave(u: Entity, sentOut = false): void {
    const b = this.w.get(u.inside);
    if (b && b.kind === Kind.Unit) { this.w.naval.disembark(u, b); return; }   // add-on: out of a ship
    if (u.inside < 0 || this.leaving(u)) return;
    if (!b) { const [x, y] = this.cellOf(u); u.inside = -1; this.w.place(u, x, y); return; }
    if (u.job) {
      const j = this.w.sched.get(u.job);
      if (j && !j.cancelled) { if (!j.hold) j.hold = 5; u.suspended.push(u.job); }
    }
    u.job = this.w.sched.create(LJ.Leave, u.id, 10, [b.id, 0, sentOut ? 1 : 0]).id;
  }

  /**
   * Eject the unit while its current job goes on behind the leave job, blocked `hold` ticks
   * (transport units: 10). True when the unit is now on its way out (the caller returns and is
   * resumed outside); false when it was not inside a building (a site), so the job goes on now.
   */
  private exitCurrent(u: Entity, hold: number): boolean {
    const b = this.w.get(u.inside);
    if (!b || b.kind !== Kind.Building) { if (b) this.leave(u); return false; }
    const j = u.job ? this.w.sched.get(u.job) : undefined;
    if (j && !j.cancelled && !j.hold) j.hold = hold;
    this.leave(u);
    return this.leaving(u);
  }

  /** the job ends with the unit inside: it comes out through the leave job, with no job after it */
  private leaveEnd(u: Entity): number {
    if (this.leaving(u)) { u.ordered = false; return 0; }
    const b = this.w.get(u.inside);
    if (b && b.kind === Kind.Building) { u.job = 0; u.ordered = false; this.leave(u); return 0; }
    this.leave(u);
    return this.finish(u);
  }

  /**
   * Leave job (0x0D, `0047a530`, 4.10): run 1 (10 ticks after the eject) opens the door; runs 2..5
   * (+20, +25, +30, +35) test the entrance cell. Free: the unit is put there. Taken by a unit
   * without a job: that unit is pushed aside (no requester, mask 0x3E) and the job polls again
   * after 5 ticks; taken by anything else: poll. At run 5 a still taken entrance is replaced by
   * the first free cell of the square spiral around it.
   */
  private runLeave(job: Job): number {
    const u = this.w.get(job.owner), d = job.data;
    const b = this.w.get(d[LV.Building]);
    // the same job type takes passengers off a ship (add-on, naval.ts)
    if ((b && b.kind === Kind.Unit) || d.length < 2) return this.w.naval.runJob(job);
    if (!u || !u.alive || u.job !== job.id) return 0;
    if (u.inside < 0) return this.endLeave(u);
    if (!b || b.kind !== Kind.Building) {
      // the building is gone: out on the nearest free cell around the stored position
      const [x, y] = this.cellOf(u);
      const c = this.w.freeSpiral(x, y, 24, u) ?? [x, y];
      this.putOutside(u, null, c[0], c[1]);
      return this.endLeave(u);
    }
    d[LV.Runs]++;
    if (d[LV.Runs] === 1) { this.doorUp(b); return 10; }
    const [ex, ey] = this.entrance(b);
    if (this.doorInside(b)) {
      // add-on harbour / shipyard (door 0,0): the entrance is a footprint cell; the nearest free
      // land cell of the unit's island (addon.md 3.2)
      u.inside = -1;
      this.w.place(u, ex, ey);
      this.putOutside(u, b, ...this.cellOf(u), d[LV.SentOut] === 1);
      return this.endLeave(u);
    }
    const m = this.w.size - 1, i = ((ey & m) << this.w.bits) | (ex & m);
    const v = this.w.motion.unitOn(i, u);
    const sentOut = d[LV.SentOut] === 1;
    if (!v && !this.w.blocked[i]) { this.putOutside(u, b, ex, ey, sentOut); return this.endLeave(u); }
    if (d[LV.Runs] < 5) {
      if (v && this.w.motion.isIdle(v)) this.w.motion.pushFromDoor(v, [i, i]);
      return 5;
    }
    const c = this.w.freeSpiral(ex, ey, 24, u);
    if (!c) return 5;                          // nowhere free at all: keep polling (our addition)
    this.putOutside(u, b, c[0], c[1], sentOut);
    return this.endLeave(u);
  }

  /**
   * Put a unit outside (`004613f0`, message 0x64): on the cell at once (no step), facing 3 when the
   * door's x offset is negative, otherwise 5; the door counter goes down (balancing the leave
   * job's first run) and the door picture closes; vision and the worn-path roll for the cell.
   * A unit of the building's operator type and race that was sent out (send-out command,
   * DEAKTIVIEREN) deactivates the building now (step 4, 4.11); the last unit out of an outpost
   * ends its garrison job.
   */
  private putOutside(u: Entity, b: Entity | null, x: number, y: number, sentOut = false): void {
    u.inside = -1;
    this.w.teleport(u, x, y);
    this.w.halt(u);
    if (b) {
      const r = this.rule(b);
      u.dir = (r?.doorDx ?? 0) < 0 ? 3 : 5;
      this.doorDown(b, true);
      if (r && b.alive) {
        if (sentOut && this.type(u) === r.operator && (u.oid >>> 16) === (b.oid >>> 16)) this.deactivateBuilding(b);
        // the last ranged unit out of an outpost ends its outpost job (combat.md 9.8)
        if (r.cls === 6 && this.rule(u)?.cls === 2 && b.opJob && !this.occupants(b).length) { this.w.sched.cancel(b.opJob); b.opJob = 0; }
      }
    }
    this.setAction(u, Action.Idle);
    this.w.wearPath(u, x, y);
  }

  /** the leave job is over: the job queued behind it (if any) becomes current and is unblocked */
  private endLeave(u: Entity): number {
    u.job = 0;
    return this.w.combat.endUnitJob(u);
  }

  // ---------------------------------------------------------------- dispatcher (5.2, 5.3)

  private runDispatcher(job: Job): number {
    const t = this.w.economy.town(job.owner);
    if (!t || !t.alive) return 0;
    const taken = new Set<number>();
    // A: worker requests
    const keep: [number, number][] = [];
    for (const [type, bid] of t.workerReqs) {
      const b = this.w.get(bid);
      if (!b) continue;
      const [ex, ey] = this.entrance(b);
      if (type === T.Builder) {
        const u = this.nearestFree(t, T.Builder, ex, ey, taken);
        if (!u) { keep.push([type, bid]); if (this.w.economy.count(t, T.Builder, false) === 0) this.w.notify(t.race, M.NoBuilder, true, ADVISOR_REPEAT_MS); continue; }
        // a site whose construction job is not blocked, or a damaged building; otherwise (a paused
        // site, full HP) the request is dropped without giving the free builder a job (5.2, 6.8)
        const needsWork = (!b.complete && !!b.order && !b.paused) || (b.complete && b.hp < (this.rule(b)?.hp ?? 0));
        if (!needsWork) continue;
        taken.add(u.id);
        this.startBuilder(u, b);
        continue;
      }
      if (type === T.Porter) {
        // trainees: only while more orders are queued than people inside (5.2)
        if (b.queue.length <= this.trainees(b).length) continue;
      } else if (b.complete && b.operatorId >= 0 && this.w.get(b.operatorId)?.inside === b.id) continue;
      const u = this.nearestFree(t, type, ex, ey, taken);
      if (!u) { keep.push([type, bid]); continue; }
      taken.add(u.id);
      this.assign(u, LJ.Answer, 1, [0, bid, type, 0]);
    }
    t.workerReqs = keep;

    // B: transport requests, weighted round robin 8:4:2:1 for the starting list
    if (t.lists.some(l => l.length)) {
      let start: number;
      if (t.rr[0] < 8) { start = 0; t.rr[0]++; }
      else if (t.rr[1] < 4) { start = 1; t.rr[1]++; }
      else if (t.rr[2] < 2) { start = 2; t.rr[2]++; }
      else { start = 3; t.rr = [0, 0, 0]; }
      let noPorter = false;
      for (let k = 0; k < 4 && !noPorter; k++) {
        const li = (start + k) % 4, list = t.lists[li];
        const rest: number[] = [];
        for (let i = 0; i < list.length; i++) {
          if (noPorter) { rest.push(list[i]); continue; }
          const r = li === List.Pickup ? this.dispatchNature(t, list[i], taken) : this.dispatchBuilding(t, list[i], taken);
          if (r === 'keep') rest.push(list[i]);
          else if (r === 'noporter') { rest.push(list[i]); noPorter = true; }
        }
        t.lists[li] = rest;
      }
      if (noPorter && this.w.economy.count(t, T.Porter, false) === 0) this.w.notify(t.race, M.NoPorter, true, ADVISOR_REPEAT_MS);
    }
    const pending = t.workerReqs.length > 0 || t.lists.some(l => l.length);
    if (!pending) t.dispatcher = 0;
    return pending ? 20 : 0;
  }

  private dispatchBuilding(t: Town, id: number, taken: Set<number>): 'done' | 'keep' | 'noporter' {
    const b = this.w.get(id);
    if (!b || b.kind !== Kind.Building) return 'done';
    if (!(!b.complete || b.active)) return 'keep';
    if (!b.needed.length && !b.outputs.length) return 'done';
    let src: Entity | null, dst: Entity | null;
    const [bx, by] = this.entrance(b);
    const gi = b.needed.findIndex(g => t.stock[g] > 0);
    if (gi >= 0) {
      const g = b.needed.splice(gi, 1)[0];
      b.needed.unshift(g);
      src = this.nearestStore(t, bx, by); dst = b;
    } else if (b.outputs.length) {
      src = b; dst = this.nearestStore(t, bx, by);
    } else {
      const lack = this.w.rules.get(((NATURE_GROUP << 16) | b.needed[0]) >>> 0)?.message ?? 0;
      if (lack > 0) this.w.notify(t.race, lack + (b.needed[0] === Good.Crop ? t.race : 0), true, ADVISOR_REPEAT_MS);
      return 'keep';
    }
    if (!src || !dst) return 'keep';
    const [sx, sy] = src.kind === Kind.Building ? this.entrance(src) : this.cellOf(src);
    const p = this.nearestFree(t, T.Porter, sx, sy, taken, this.haulGroup(t));
    if (!p) return 'noporter';
    taken.add(p.id);
    this.startTransport(p, dst, src, b);
    return 'done';
  }

  private dispatchNature(t: Town, id: number, taken: Set<number>): 'done' | 'keep' | 'noporter' {
    const n = this.w.get(id);
    if (!n || n.kind !== Kind.Nature) return 'done';
    if (n.amount - n.reserved <= 0) return 'keep';
    if (this.w.economy.space(t, n.yieldGood) < 1) return 'keep';
    const [x, y] = this.cellOf(n);
    const p = this.nearestFree(t, T.Porter, x, y, taken, this.haulGroup(t));
    if (!p) return 'noporter';
    taken.add(p.id);
    this.startHarvest(p, n, false);
    return 'done';
  }

  // ---------------------------------------------------------------- transport (5.5)

  /** source -1 = none (deliver what is carried) */
  startTransport(u: Entity, dest: Entity, source: Entity | null, requester: Entity | null): void {
    let fetch = NONE, output = NONE;
    if (requester) {
      if (source && this.isStore(source) && requester.needed.length) fetch = requester.needed.shift()!;
      if (requester.outputs.length) output = requester.outputs.shift()!;
    }
    const d = new Array(TR.Size).fill(0);
    d[TR.Phase] = source ? 0 : 3; d[TR.Dest] = dest.id; d[TR.Source] = source ? source.id : NONE;
    d[TR.Requester] = requester ? requester.id : NONE; d[TR.Fetch] = fetch; d[TR.Output] = output;
    this.assign(u, LJ.Transport, 5, d);
  }

  private runTransport(job: Job): number {
    const u = this.w.get(job.owner), d = job.data;
    if (!u) return 0;
    for (;;) {
      switch (d[TR.Phase]) {
        case 0: { // walk to source
          // the go-to (4.2): only a dead source (or, add-on, another island) ends the job here
          const src = this.w.get(d[TR.Source]);
          if (!src || !this.goEntity(u, src)) { this.cleanup(job, u); return this.finish(u); }
          d[TR.Phase] = 1;
          return 1;
        }
        case 1: { // arrive and enter the source, wherever the walk ended (4.2, 4.10)
          if (u.path) return 1;
          const src = this.w.get(d[TR.Source]);
          const dst = this.w.get(d[TR.Dest]);
          if (!src || !dst || !this.atDoor(u, src)) { this.cleanup(job, u); return this.finish(u); }
          const e = this.enter(u, src);
          if (e) return e;
          this.atSource(u, src, d);
          d[TR.Phase] = 2;
          // a transport unit is ejected at once; its job waits 10 ticks behind the leave job (4.10)
          if (this.exitCurrent(u, 10)) return 10;
          continue;
        }
        case 2: { // out of the source
          if (u.inside >= 0) { if (this.exitCurrent(u, 10)) return 10; }
          if (u.carryAmount === 0 && !this.w.naval.isTrader(u)) { this.cleanup(job, u); return this.finish(u); }
          d[TR.Phase] = 3;
          continue;
        }
        case 3: { // walk to the destination
          const dst = this.w.get(d[TR.Dest]);
          if (!dst || !this.goEntity(u, dst)) { this.cleanup(job, u); return this.finish(u); }
          d[TR.Phase] = 4;
          return 1;
        }
        case 4: { // enter the destination wherever the walk ended
          if (u.path) return 1;
          const dst = this.w.get(d[TR.Dest]);
          const src = d[TR.Source] >= 0 ? this.w.get(d[TR.Source]) : null;
          if (!dst || src === undefined || !this.atDoor(u, dst)) { this.cleanup(job, u); return this.finish(u); }
          const e = this.enter(u, dst);
          if (e) return e;
          const turned = this.atDestination(u, dst, d);
          // ejected at once (4.10): a delivery ends the job, a turned-round job waits behind the leave job
          if (!turned) return this.leaveEnd(u);
          d[TR.Phase] = 3;
          if (this.exitCurrent(u, 10)) return 10;
          continue;
        }
        case 5: return this.leaveEnd(u);
        case 6: d[TR.Phase] = 3; if (this.exitCurrent(u, 10)) return 10; continue;
        default: return this.finish(u);
      }
    }
  }

  private atSource(u: Entity, src: Entity, d: number[]): void {
    // put down anything carried (1 unit) if there is room
    if (u.carryAmount > 0) {
      if (this.room(src, u.carryGood) > 0) {
        this.put(src, u.carryGood, 1);
        if (!this.isStore(src)) { src.outputs.push(u.carryGood); const t = this.town(src); if (t) this.requestTransport(t, List.Construction, src.id); }
        u.carryAmount--;
        if (!u.carryAmount) u.carryGood = NONE;
      } else this.w.notify(u.owner, M.StoresFull, true, ADVISOR_REPEAT_MS);
    }
    // pick up 1 unit: the requested good, otherwise the output to collect
    // (the good to fetch stays set until it is dropped at the destination; an output is cleared when taken)
    let g = NONE, out = false;
    if (d[TR.Fetch] >= 0 && this.stockOf(src, d[TR.Fetch]) > 0) g = d[TR.Fetch];
    else if (d[TR.Output] >= 0 && this.stockOf(src, d[TR.Output]) > 0) { g = d[TR.Output]; out = true; }
    // the pickup happens whatever is still carried (a load the store had no room for): the good
    // becomes the picked one and the amount goes up by 1 (5.5 "At the source" step 2, quirk)
    if (g >= 0) {
      this.take(src, g, 1);
      u.carryGood = g; u.carryAmount++;
      if (out) d[TR.Output] = NONE;
    }
  }

  /** returns true when the job was turned round (an output taken back to a store) */
  private atDestination(u: Entity, b: Entity, d: number[]): boolean {
    if (u.carryAmount > 0) {
      const stored = this.put(b, u.carryGood, u.carryAmount);
      if (this.isStore(b) && stored < u.carryAmount) this.w.notify(u.owner, M.StoresFull, true, ADVISOR_REPEAT_MS);
      u.carryAmount = 0; u.carryGood = NONE;   // the town stock clamps; the excess is lost (economy.md 7)
    }
    // the goods are dropped: nothing is owed to the requester any more (5.5)
    d[TR.Fetch] = NONE;
    const t = this.town(b);
    if (d[TR.Output] >= 0 && this.stockOf(b, d[TR.Output]) > 0) {
      this.take(b, d[TR.Output], 1);
      u.carryGood = d[TR.Output]; u.carryAmount = 1; d[TR.Output] = NONE;
      const back = this.w.get(d[TR.Source]) ?? (t ? this.nearestStore(t, ...this.entrance(b)) : null);
      if (!back) return false;
      d[TR.Source] = b.id; d[TR.Dest] = back.id;
      return true;
    }
    if (b.outputs.length && (u.oid & 0xffff) === T.Porter && t) {
      const g = b.outputs.shift()!;
      if (this.stockOf(b, g) > 0) {
        this.take(b, g, 1);
        u.carryGood = g; u.carryAmount = 1;
        const store = this.nearestStore(t, ...this.entrance(b));
        if (store) { d[TR.Source] = b.id; d[TR.Dest] = store.id; d[TR.Output] = NONE; return true; }
      }
    }
    return false;
  }

  // ---------------------------------------------------------------- construction (6)

  /** place a construction site (6.1); returns the building or null */
  placeBuilding(t: Town, type: number, x: number, y: number): Entity | null {
    const r = this.w.rules.get(((t.race << 16) | type) >>> 0);
    if (!r || r.kind !== Kind.Building || !this.canPlaceSite(t, r, x, y)) return null;
    if (this.shipyardTopUp(type)) this.topUp(t, r);
    const b = this.w.spawn({ cls: 1, group: t.race, type, owner: t.mapId, x, y, z: 0 });
    b.town = t.id; b.complete = false; b.hp = Math.floor(r.hp / 10); b.buildFrame = 0;
    const list: [number, number][] = [];
    let total = 0;
    for (let g = 0; g < GOODS; g++) if (r.cost[g] > 0) { list.push([g, r.cost[g]]); total += r.cost[g]; for (let k = 0; k < r.cost[g]; k++) b.needed.push(g); }
    b.order = newOrder('build', type, total, list);
    for (let k = 0; k < total; k++) this.requestTransport(t, List.Construction, b.id);
    this.requestWorker(t, T.Builder, b.id);
    return b;
  }

  /** build menu state (odb.md 5): 1 ok, 2 invention missing, 3 goods missing, 4 unique exists, -1 not buildable */
  menuState(t: Town, type: number): number {
    const r = this.w.rules.get(((t.race << 16) | type) >>> 0);
    const p = this.w.economy.players[t.race];
    if (!r || r.kind !== Kind.Building || r.madeAt < 37) return -1;
    if (p?.disabled.includes(type)) return -1;
    if (r.invention >= 0 && p && !this.w.economy.researched(p, r.invention)) return 2;
    if ((r.flags & BuildingFlag.OnePerTown) && this.w.economy.count(t, type, false) > 0) return 4;
    if (this.shipyardTopUp(type)) return 1;   // the shipyard tops its goods up (addon.md 3.5)
    for (let g = 0; g <= 4; g++) if (t.stock[g] < r.cost[g]) return 3;
    return 1;
  }

  private shipyardTopUp(type: number): boolean { return this.w.addon && this.w.gold.shipyardTopUp && type === 63; }

  /**
   * The shipyard's goods top-up (addon.md 3.5): every good 0..4 below the cost gains 15, clamped to
   * the capacity; food also counts as produced this round. Raw material would go through the crop
   * conversion (never on shipped data: the shipyard costs none), here it is added like the others.
   */
  topUp(t: Town, r: ObjectRule): void {
    for (let g = 0; g <= 4; g++) {
      if (t.stock[g] >= r.cost[g]) continue;
      if (g === Good.Food) t.foodNow += 15;
      t.stock[g] = Math.min(t.capacity, t.stock[g] + 15);
    }
  }

  /**
   * Placement test of the UI and the AI (click test `00447cd0`): the simulation's site test plus,
   * for every building whose mask has flag 0x800, the territory test of economy.md 11.7: the four
   * corner blocks lie in the town's own territory. Exempt: the mine (0x67E), the town hall (0x107E),
   * the add-on harbour and shipyard (0x405E).
   */
  canPlace(t: Town, r: ObjectRule, x: number, y: number): boolean {
    if (!this.canPlaceSite(t, r, x, y)) return false;
    return !needsTerritory(r.type, this.w.addon) || this.w.territory.inTown(t.id, x, y, Math.max(1, r.sizeX), Math.max(1, r.sizeY));
  }

  /**
   * Placement rule of the simulation (6.1, `00451780`): footprint grown by one free of buildings,
   * nature and water; not too steep. The simulation does not test the territory (economy.md 11.7).
   */
  canPlaceSite(t: Town, r: ObjectRule, x: number, y: number): boolean {
    const st = this.menuState(t, r.type);
    if (st !== 1 && st !== 3) return false;
    if (this.w.addon && (r.type === 62 || r.type === 63)) return this.canPlaceShore(t, r, x, y);
    const sx = Math.max(1, r.sizeX), sy = Math.max(1, r.sizeY), w = this.w;
    for (let dy = -1; dy <= sy; dy++) for (let dx = -1; dx <= sx; dx++) {
      if (w.occupied(x - sx + 1 + dx, y - sy + 1 + dy)) return false;
    }
    let lo = Infinity, hi = -Infinity;
    for (let dy = -2; dy <= sy + 1; dy++) for (let dx = -2; dx <= sx + 1; dx++) {
      if (dy > -2 && dy < sy + 1 && dx > -2 && dx < sx + 1) continue;
      const h = w.heightAt(x - sx + 1 + dx, y - sy + 1 + dy);
      lo = Math.min(lo, h); hi = Math.max(hi, h);
    }
    if (hi - lo > 64) return false;
    const h = w.heightAt(x, y);
    if (r.type === 50 && h <= w.mountain) return false;      // mine: mountains only (290 in add-on mode)
    if (r.type === 45 && h > w.mountain) return false;       // farm: not on mountains
    return true;
  }

  /**
   * Harbour / shipyard placement (addon.md 3.1, mask 0x405E): the footprint grown by one holds no
   * building, nature object or unit, and between 1 and size_y + 3 land cells (flag 0x4000); water
   * and low land are allowed; the slope ring as for every building; no territory test (0x405E has no
   * 0x800, economy.md 11.7). `padded`:
   * the AI's site test with its padded rectangle (limit padded height + 1, no mountains).
   */
  canPlaceShore(t: Town, r: ObjectRule, x: number, y: number, padded?: [number, number]): boolean {
    const w = this.w;
    const sx = Math.max(1, r.sizeX), sy = Math.max(1, r.sizeY);
    // the AI's padded rectangle has its maximum corner one cell beyond the anchor (ai-diplomacy-trade.md 1.5 step 6)
    const [ax, ay, aw, ah] = padded ? [x + 2 - padded[0], y + 2 - padded[1], padded[0], padded[1]] : [x - sx, y - sy, sx + 2, sy + 2];
    const n = w.size - 1;
    let land = 0;
    for (let dy = 0; dy < ah; dy++) for (let dx = 0; dx < aw; dx++) {
      const i = (((ay + dy) & n) << w.bits) | ((ax + dx) & n);
      if (w.buildingCells[i] || w.natureAt[i] || (w.blocked[i] && w.terrain.cls[i] !== 11)) return false;
      if (padded && w.terrain.height[i] > w.mountain) return false;
      if (w.terrain.cls[i] !== 11) land++;
    }
    if (land < 1 || land > (padded ? ah + 1 : sy + 3)) return false;
    let lo = Infinity, hi = -Infinity;
    for (let dy = -2; dy <= sy + 1; dy++) for (let dx = -2; dx <= sx + 1; dx++) {
      if (dy > -2 && dy < sy + 1 && dx > -2 && dx < sx + 1) continue;
      const h = w.heightAt(x - sx + 1 + dx, y - sy + 1 + dy);
      lo = Math.min(lo, h); hi = Math.max(hi, h);
    }
    if (hi - lo > 64) return false;
    // no unit in the grown footprint (ships included)
    for (const e of w.entities) {
      if (e.kind !== Kind.Unit || e.inside >= 0) continue;
      const [ex, ey] = this.cellOf(e);
      const ddx = (ex - ax) & n, ddy = (ey - ay) & n;
      if (ddx < aw && ddy < ah) return false;
    }
    return true;
  }

  /** a builder job on a site (first phase 2: waiting for material) or a repair (first phase 0: turn, then the repair branch) */
  private startBuilder(u: Entity, b: Entity): void {
    this.assign(u, LJ.Builder, 1, [0, b.id, 3, b.complete ? 0 : 2, 0, 0]);
  }

  /**
   * Builder job (0x0C, 6.4). Our phases: 0 go to the site, 1 walking there, 2 at work (d[BJ.Step]
   * is the original's builder phase: 0 turn and call the step, 1 work, 2 waiting for material,
   * 3 relocate), 3 walking to the next spot, 4 the walk to the entrance was created (6.4.1),
   * 5 walking to the entrance. Completion does not touch the other builders on the site: each
   * notices at its own next run (the 6.4.1 table, including the 1-coin repair tick).
   */
  private runBuilder(job: Job): number {
    const u = this.w.get(job.owner), d = job.data;
    if (!u) return 0;
    const b = this.w.get(d[BJ.Building]);
    const r = b && this.rule(b);
    if (!b || !r) return this.finish(u);
    switch (d[BJ.Phase]) {
      case 0: // walk to the entrance first
        if (!this.goEntity(u, b)) return this.builderToDoor(d);
        if (!b.complete && b.order && !b.order.builders.includes(u.id)) b.order.builders.push(u.id);
        d[BJ.Phase] = 1;
        return 1;
      case 1: // the go-to ignores how its walk ended (4.2)
        if (u.path) return 1;
        // a successful go-to sets phase 3: walk on to the first spot (+x side) before the first
        // construction call (6.4); harbour and shipyard: the builder never walks round
        d[BJ.Phase] = this.doorInside(b) ? 2 : 3; d[BJ.Walking] = 0;
        return 1;
      case 3: { // walk to the next spot around the building
        if (!d[BJ.Walking]) {
          d[BJ.Spot] = (d[BJ.Spot] + 1) % 4;
          const [sx, sy] = this.spotAround(b, d[BJ.Spot]);
          this.setAction(u, Action.Idle);   // the stop message before relocating
          // a plain walk to the spot (no go-to adjustment), then the spot's fixed facing (4.8)
          d[BJ.Face] = SPOT_FACING[d[BJ.Spot]] + 1;
          if (!this.goCell(u, sx, sy)) return this.builderToDoor(d);
          if (u.path) { d[BJ.Walking] = 1; return 1; }
        }
        if (u.path) return 1;
        d[BJ.Walking] = 0;
        if (u.walkResult === WalkResult.Failed) return this.builderToDoor(d);
        d[BJ.Phase] = 2; d[BJ.Step] = 0;
        return 1;
      }
      case 4: { // the follow-path child's first run (C+1): plan to the entrance cell itself
        d[BJ.Phase] = 5;
        const [ex, ey] = this.entrance(b);
        if (!this.goCell(u, ex, ey) || !u.path) return this.builderDone(u, d);
        return 1;
      }
      case 5: // walking to the entrance; the job ends with the walk (stop message, idle)
        if (u.path) return 1;
        return this.builderDone(u, d);
      default: { // 2: face the building (the entrance) or the spot's facing, then work
        const site = !b.complete && !!b.order;
        // waiting for material on a building that is no longer a site: walk to the door (6.4.1)
        if (!site && d[BJ.Step] === 2) return this.builderToDoor(d);
        const [bx, by] = this.cellOf(b);
        // harbour and shipyard: face the centre; the builder never walks round (addon.md 3.2)
        const stay = this.doorInside(b);
        if (stay) this.w.face(u, bx - (Math.max(1, r.sizeX) >> 1), by - (Math.max(1, r.sizeY) >> 1));
        else {
          const t = d[BJ.Face] ? this.w.motion.turn(u, d[BJ.Face] - 1) : this.w.turnToward(u, bx, by);
          if (t) return t;
        }
        if (!site) {
          // repair branch (6.4): work animation on and 10 ticks, then the repair tick
          if (d[BJ.Step] !== 1) { this.setAction(u, Action.Work); d[BJ.Step] = 1; return 10; }
          const p = this.w.economy.players[b.owner];
          if (!p || p.money <= 0) return this.builderToDoor(d);
          p.money -= 1;
          b.hp = Math.min(r.hp, b.hp + 20);
          if (b.hp >= r.hp) return this.builderToDoor(d);
          if (stay) return 30;
          d[BJ.Phase] = 3; d[BJ.Walking] = 0; d[BJ.Step] = 0;
          return 20;
        }
        const res = this.constructionStep(b, d);
        // the completing builder: the work animation loops on until the first step of the walk
        if (res === 'done') return this.builderToDoor(d);
        this.setAction(u, d[BJ.Step] === 2 ? Action.Idle : Action.Work);
        if (d[BJ.Step] === 3 && stay) { d[BJ.Step] = 0; return 30; }
        if (d[BJ.Step] === 3) { d[BJ.Phase] = 3; d[BJ.Walking] = 0; }
        return 15;
      }
    }
  }

  /** phase 4 (6.4.1): a plain follow-path child to the entrance cell; its first run is the next tick */
  private builderToDoor(d: number[]): number {
    d[BJ.Phase] = 4; d[BJ.Walking] = 0;
    return 1;
  }

  /** the builder job ends (destructor `00477b90`): off the builder list, the stop message; he stays idle where he is */
  private builderDone(u: Entity, d: number[]): number {
    this.builderLeft(u, d);
    return this.finish(u);
  }

  /** a builder leaves the site's builder list; an unfinished site with no builder left files a new request (6.4) */
  private builderLeft(u: Entity, d: number[]): void {
    const b = this.w.get(d[BJ.Building]);
    // the destructor (`00477b90`) acts only while the site's construction job is not blocked: on a
    // paused site the builder stays listed (a stale entry) and nothing is filed (6.4, 6.8)
    if (b && !b.complete && b.order && !b.paused) {
      b.order.builders = b.order.builders.filter(id => id !== u.id);
      if (!b.order.builders.length) { const t = this.town(b); if (t) this.requestWorker(t, T.Builder, b.id); }
    }
    if (u.action === Action.Work) this.setAction(u, Action.Idle);
  }

  /**
   * Builder spots (`00478350`, 4.8): the middle cell of each side of the footprint ring, cycled
   * +x, +y, -y, -x. The +x spot takes its y offset from size_x (quirk of the original).
   */
  private spotAround(b: Entity, k: number): [number, number] {
    const r = this.rule(b)!;
    const [x, y] = this.cellOf(b), sx = Math.max(1, r.sizeX), sy = Math.max(1, r.sizeY);
    const m = this.w.size - 1;
    const spots: [number, number][] = [
      [x + 1, y - (sx >> 1)], [x - (sx >> 1), y + 1], [x - (sx >> 1), y - sy], [x - sx, y - (sy >> 1)],
    ];
    const [a, c] = spots[k];
    return [a & m, c & m];
  }

  /** one construction call (6.3); d[BJ.Step] is the builder's material phase */
  private constructionStep(b: Entity, d: number[]): 'done' | 'work' {
    const o = b.order!;
    const r = this.rule(b)!;
    if (!o.started) {
      o.started = 1;
      o.N = Math.max(o.T, 10);
      o.step = o.T ? Math.trunc(o.N / o.T) : 1;
      o.counter = o.N + o.step - (o.N % o.step);
      o.E = o.step - (o.N % o.step);
      o.d = Math.trunc((r.hp - b.hp) / 9);
      o.stage = -1;
    }
    // consume a good
    if ((d[BJ.Step] === 0 || d[BJ.Step] === 2) && o.list.length && o.counter % o.step === 0) {
      const g = o.list[0][0];
      if (b.local[g] <= 0) { d[BJ.Step] = 2; return 'work'; }
      d[BJ.Step] = 1;
      b.local[g]--; o.R--;
      if (--o.list[0][1] === 0) o.list.shift();
      return 'work';
    }
    if (d[BJ.Step] === 1 || !o.list.length) {
      o.counter--;
      if (o.counter % o.step === 0 && o.list.length) d[BJ.Step] = 3;
      let counts = true;
      if (o.T > 10) {
        const s = Math.min(9, Math.floor(((o.T - o.R) * 10) / o.T));
        counts = s !== o.stage;
        o.stage = s;
      }
      if (counts) { b.hp = Math.min(r.hp, b.hp + o.d); b.buildFrame = Math.min(9, b.buildFrame + 1); }
      if (o.counter <= o.E) {
        b.hp = Math.min(r.hp, b.hp + o.d);
        this.complete(b);
        return 'done';
      }
    }
    return 'work';
  }

  /** construction finished (6.5) */
  complete(b: Entity): void {
    const r = this.rule(b)!, t = this.town(b);
    // the builders on the site are not told: each ends through its own next run (6.4.1)
    b.order = null;
    b.needed = [];
    if (this.type(b) === T.TownHall) b.hp = r.hp;
    if (!t) { b.complete = true; return; }
    this.w.economy.completed(b);
    if (r.cls === 6) this.w.claimTerritory(b);   // outposts broadcast their territory (6.5, economy.md 11.2)
    this.w.notify(t.race, M.BuildingDone);
    if (r.operator >= 0) this.requestWorker(t, r.operator, b.id);
    else this.activate(b);
    // a computer town asks for one archer per garrison place (`004602d0`, combat.md 9.2)
    if (r.cls === 6 && this.w.ai.isComputer(t.race)) for (let k = 0; k < r.garrison; k++) this.requestWorker(t, T.Soldier, b.id);
  }

  /** a building starts operating: economy part + production (8.1) */
  activate(b: Entity): void {
    const was = b.active;
    this.w.economy.activate(b);
    if (!was && b.active) this.w.diplomacy.embassyActivated(b);
    const r = this.rule(b);
    if (!r || r.product < 0 || b.prodJob) return;
    const t = this.town(b);
    b.order = newOrder('produce', r.product, 0, []);
    if (t) this.orderInputs(b, t, r.product);
    b.prodJob = this.w.sched.create(LJ.Production, b.id, 1).id;
  }

  // ---------------------------------------------------------------- production (8.2)

  private inputs(product: number): number[] {
    const g = this.w.rules.get(((NATURE_GROUP << 16) | product) >>> 0);
    return g ? g.cost : new Array(GOODS).fill(0);
  }

  /** request the inputs missing for one run (net of stock and of what is already on its way) */
  private orderInputs(b: Entity, t: Town, product: number): void {
    const need = this.inputs(product);
    for (let g = 0; g < GOODS; g++) {
      const missing = need[g] - b.local[g] - b.needed.filter(x => x === g).length;
      for (let k = 0; k < missing; k++) { b.needed.push(g); this.requestTransport(t, List.Production, b.id); }
    }
  }

  private runProduction(job: Job): number {
    const b = this.w.get(job.owner);
    if (!b || b.kind !== Kind.Building || !b.order) { if (b) b.prodJob = 0; return 0; }
    if (!b.active) return 30;
    const o = b.order, t = this.town(b);
    if (!t) return 30;
    if (o.counter > 0) {
      if (--o.counter === 0) {
        b.local[o.type]++;
        b.outputs.push(o.type);
        this.requestTransport(t, List.Production, b.id);
        o.started = 0;
        this.orderInputs(b, t, o.type);
      }
      return 30;
    }
    const need = this.inputs(o.type);
    for (let g = 0; g < GOODS; g++) if (b.local[g] < need[g]) return 30;
    for (let g = 0; g < GOODS; g++) b.local[g] -= need[g];
    o.started = 1; o.counter = 10;
    this.orderInputs(b, t, o.type);
    return 30;
  }

  // ---------------------------------------------------------------- gathering (7)

  /** may this unit type harvest this nature object (odb.md 4 "Harvest rule") */
  canHarvest(u: Entity, n: Entity): boolean {
    if (n.kind !== Kind.Nature) return false;
    const ut = u.oid & 0xffff, race = u.oid >>> 16, nt = n.oid & 0xffff, cls = this.rule(n)?.cls ?? -1;
    if (ut === T.Porter) return cls === NC.Bush || cls === NC.CropA + race || nt === RUBBLE;
    if (ut === U.Hunter) return cls === NC.Animal;
    if (ut === U.Woodcutter) return cls === NC.Tree;
    if (ut === U.Stonemason) return cls === NC.Stone || nt === RUBBLE;
    if (ut === 64 && this.w.isShip(u)) return cls === 15;   // fishing boat on a fish (addon.md 4.2)
    return false;
  }

  startHarvest(u: Entity, n: Entity, auto: boolean, delay = 1): void {
    this.assign(u, LJ.Harvest, delay, this.harvestData(u, n, auto));
  }

  /** a fresh harvest state on `n`: phase 2 first (deliver) when the unit carries something (7.1) */
  private harvestData(u: Entity, n: Entity, auto: boolean): number[] {
    const d = new Array(HV.Size).fill(0);
    d[HV.Phase] = u.carryAmount > 0 ? 2 : 0; d[HV.Target] = n.id; d[HV.Auto] = auto ? 1 : 0;
    d[HV.Class] = this.rule(n)?.cls ?? -1; d[HV.Type] = n.oid & 0xffff;
    return d;
  }

  // ---------------------------------------------------------------- hunting ground (7.3)

  /**
   * Give a hunter his hunting-ground job (0x2B, 7.3.1) with the spot (sx, sy). `animal`: the
   * player's right-click target, which becomes the first harvest child (auto-continue off);
   * null for a map order (no child: he walks to the spot and scans).
   */
  startHunt(u: Entity, sx: number, sy: number, animal: Entity | null, delay: number): void {
    const d = new Array(HG.Size).fill(0);
    const m = this.w.size - 1;
    d[HG.SX] = sx & m; d[HG.SY] = sy & m;
    if (animal) {
      d[HG.Child] = HuntChild.Harvest;
      const h = this.harvestData(u, animal, false);
      for (let i = 0; i < HV.Size; i++) d[HG.Harvest + i] = h[i];
    }
    this.assign(u, LJ.Hunt, delay, d);
  }

  /** one run of the hunting-ground job (7.3.2) */
  private runHunt(job: Job): number {
    const u = this.w.get(job.owner), d = job.data;
    if (!u || !u.alive) return 0;
    if (d[HG.Child] === HuntChild.Harvest) {
      const h = d.slice(HG.Harvest, HG.Harvest + HV.Size);
      const r = this.harvestStep(u, h);
      for (let i = 0; i < HV.Size; i++) d[HG.Harvest + i] = h[i];
      if (r > 0) return r;
      // the animal is used up, the chase failed or there is no store: back to the spot
      for (let i = 0; i < HV.Size; i++) d[HG.Harvest + i] = 0;
      if (!u.path && u.action !== Action.Fight) this.setAction(u, Action.Idle);
      return this.huntWalkBack(u, d);
    }
    if (d[HG.Child] === HuntChild.Walk) {
      if (u.path) return 1;
      // the spot becomes wherever the walk really ended
      const [x, y] = this.cellOf(u);
      d[HG.SX] = x; d[HG.SY] = y;
      d[HG.Child] = HuntChild.None;
      return 20;
    }
    // no child: too far from the spot (a map-order hunter's first run) -> walk there
    if (this.distE(u, d[HG.SX], d[HG.SY]) > 4) return this.huntWalkBack(u, d);
    const a = this.scanAnimal(u, d[HG.SX], d[HG.SY]);
    if (!a) return 20;
    const h = this.harvestData(u, a, false);
    for (let i = 0; i < HV.Size; i++) d[HG.Harvest + i] = h[i];
    d[HG.Child] = HuntChild.Harvest;
    return 5;
  }

  /** the walk back: the first free cell (mask 0x3E) of the spiral around the spot becomes the spot (7.3.2 A) */
  private huntWalkBack(u: Entity, d: number[]): number {
    const c = this.w.freeSpiral(d[HG.SX], d[HG.SY], 16, u);
    if (c) { d[HG.SX] = c[0]; d[HG.SY] = c[1]; this.goCell(u, c[0], c[1]); }
    d[HG.Child] = HuntChild.Walk;
    return 5;
  }

  /**
   * The animal scan (7.3.3): class-7 objects (living or carcass) in the square of the hunter's
   * sight around his own cell; the one nearest the spot wins, ties to the first in scan order
   * (rows dy = -R..R, within a row dx = -R..R).
   */
  private scanAnimal(u: Entity, sx: number, sy: number): Entity | null {
    const R = this.rule(u)?.radius || 10;
    const [ux, uy] = this.cellOf(u), n = this.w.size;
    const wrap = (v: number) => { v %= n; if (v > n / 2) v -= n; else if (v < -n / 2) v += n; return v; };
    let best: Entity | null = null, bd = Infinity, bk = Infinity;
    for (const e of this.w.entities) {
      if (e.kind !== Kind.Nature || this.rule(e)?.cls !== NC.Animal) continue;
      const [x, y] = this.cellOf(e);
      const dx = wrap(x - ux), dy = wrap(y - uy);
      if (Math.abs(dx) > R || Math.abs(dy) > R) continue;
      const dd = this.dist(x, y, sx, sy), k = (dy + R) * (2 * R + 1) + (dx + R);
      if (dd < bd || (dd === bd && k < bk)) { best = e; bd = dd; bk = k; }
    }
    return best;
  }

  /**
   * The next-object search (7.1.1): the first usable object (same class, some amount not
   * reserved, and one this unit may harvest) in the square spiral of rings 0..9 around the old
   * target's cell. Ring r starts at (x+r, y-r) and runs +y, then -x, then -y, then +x. The
   * distance to the unit plays no part.
   */
  private nextTarget(u: Entity, d: number[]): Entity | null {
    const ox = d[HV.TX], oy = d[HV.TY], size = this.w.size;
    const wrap = (v: number) => { v = ((v % size) + size) % size; return v > size / 2 ? v - size : v; };
    let best: Entity | null = null, bk = Infinity;
    for (const e of this.w.entities) {
      if (e.kind !== Kind.Nature || e.amount - e.reserved <= 0) continue;
      if ((this.rule(e)?.cls ?? -2) !== d[HV.Class] && !(d[HV.Type] === RUBBLE && (e.oid & 0xffff) === RUBBLE)) continue;
      if (d[HV.Type] === RUBBLE && (e.oid & 0xffff) !== RUBBLE) continue;
      if (!this.canHarvest(u, e)) continue;
      const [x, y] = this.cellOf(e);
      const dx = wrap(x - ox), dy = wrap(y - oy), r = Math.max(Math.abs(dx), Math.abs(dy));
      if (r > NEXT_RINGS) continue;
      const i = r === 0 ? 0
        : dx === r && dy < r ? dy + r
        : dy === r && dx > -r ? 3 * r - dx
        : dx === -r && dy > -r ? 5 * r - dy
        : 7 * r + dx;
      const k = r * 100 + i;
      if (k < bk) { best = e; bk = k; }
    }
    return best;
  }

  private runHarvest(job: Job): number {
    const u = this.w.get(job.owner);
    if (!u) return 0;
    const r = this.harvestStep(u, job.data);
    return r > 0 ? r : this.finish(u);
  }

  /** one run of a harvest (7.1) on its state `d`; 0 = the harvest is over (the caller ends the job) */
  private harvestStep(u: Entity, d: number[]): number {
    let n = this.w.get(d[HV.Target]);
    if (n) { const [x, y] = this.cellOf(n); d[HV.TX] = x; d[HV.TY] = y; }
    const phase = d[HV.Phase];
    // the target was removed (7.1): with auto-continue the next-object search around its last
    // cell (7.1.1); a delivery under way goes on either way (phases 3, 4); phase 2 still settles
    // the work on the old target
    if (!n && d[HV.Target] !== NONE && phase !== 2) {
      n = (d[HV.Auto] ? this.nextTarget(u, d) : null) ?? undefined;
      d[HV.Target] = n ? n.id : NONE;
      if (n) {
        const [x, y] = this.cellOf(n); d[HV.TX] = x; d[HV.TY] = y;
        if (phase !== 3 && phase !== 4) d[HV.Phase] = 0;
      }
    }
    if (!n && phase !== 2 && phase !== 3 && phase !== 4) {
      if (u.path && phase === 1) this.w.stopWalk(u);   // the go-to child is dropped with the job
      return 0;
    }
    switch (d[HV.Phase]) {
      case 0: // approach (7.1 phase 0): a living animal is hunted first (attack, combat.md 14)
        d[HV.Spot] = 0; d[HV.Trips] = 0;
        if (n!.alive && this.rule(n!)?.cls === NC.Animal && !this.w.isShip(u)) {
          if (!this.w.combat.weapon(u)) return 0;   // nothing to hunt with (every hunter record has a weapon)
          this.w.combat.initAttack(d, HV.Attack, n!, true, false);
          d[HV.Phase] = 7;
          return 1;
        }
        d[HV.Phase] = 1;
        if (!this.goEntity(u, n!)) {
          if (this.w.isShip(u)) return 0;
          // no path: the walk ends without success after its plans; then the arrival test (7.1.1 ours 2)
          return WALK_FAILED;
        }
        return 1;
      case 7: { // hunting: chase and strike until the animal is a carcass, then go to it
        const r = this.w.combat.attackStep(u, d, HV.Attack, false);
        if (r > 0) return r;
        if (!n) return 0;
        // still living: the chase was given up (leash, 5 plans); a new attack from where it is now (7.3.4)
        if (n.alive) { this.w.combat.initAttack(d, HV.Attack, n, true, false); return 1; }
        // the carcass: the go-to child is created now (K) and runs next tick; nothing is sent to
        // the display, so the strike plays on (7.3.4 "From the killing strike")
        d[HV.Phase] = 8;
        return 1;
      }
      case 8: { // K+1: the go-to picks its target cell (4.8; the attack slots are free now)
        const [px, py] = this.cellOf(n!);
        const [gx, gy] = this.w.isShip(u) ? [px, py] : this.w.goalCell(px, py);
        d[HV.Attack + 1] = gx; d[HV.Attack + 2] = gy;
        d[HV.Phase] = 9;
        return 1;
      }
      case 9: // K+2: the follow-path child's first run plans; the first step comes 3 ticks later (K+5)
        if (!this.goCell(u, d[HV.Attack + 1], d[HV.Attack + 2])) return 0;
        d[HV.Phase] = 1;
        return 1;
      case 1: { // the walk has ended (successful or not); start working
        if (u.path) return 1;
        // usable test (7.1.1): nothing left that is not promised to another worker -> next object
        if (n!.amount - n!.reserved <= 0) {
          if (!d[HV.Auto]) return 0;
          const next = this.nextTarget(u, d);
          if (!next) return 0;
          d[HV.Target] = next.id; d[HV.Phase] = 0;
          return 1;
        }
        // a living animal is only ever killed by the attack (phase 0); there is no shortcut on arrival
        if (n!.alive && this.rule(n!)?.cls === NC.Animal) { d[HV.Phase] = 0; return 1; }
        if (this.w.isShip(u) ? !this.near(u, n!) : !this.adjacent(u, n!)) {
          if (this.w.isShip(u)) return 0;
          // not within one cell: walk to the first free cell of the spiral around the target (4.8;
          // units count, the walker's own cell too) and test again after that walk, without limit
          const [nx, ny] = this.cellOf(n!);
          const c = this.w.freeSpiral(nx, ny, 24);
          if (!c || !this.goCell(u, c[0], c[1])) return WALK_FAILED;
          return 1;
        }
        if (n!.alive && this.rule(n!)?.cls === 15) n!.alive = false;   // the boat's one hit kills the fish (addon.md 6.3)
        // phase 6 of the original: turn to face the target (4.6), one turn call per run
        const [nx, ny] = this.cellOf(n!);
        const t = this.w.isShip(u) ? (this.w.face(u, nx, ny), 0) : this.w.turnToward(u, nx, ny);
        if (t) return t;
        d[HV.Spot] = 0;
        if (n!.standing) { this.setAction(u, Action.Work); d[HV.Phase] = 6; return 100; }
        d[HV.Phase] = 5;
        return 1;
      }
      case 6: // the tree falls (fall animation, 25 ticks)
        if (n!.standing) { n!.standing = false; n!.action = Action.Work; n!.actionTick = this.w.tick; }
        this.setAction(u, Action.Idle);
        d[HV.Phase] = 5;
        return 25;
      case 5: { // work one unit (hunters take up to 4 at once)
        const free = n!.amount - n!.reserved;
        if (free <= 0) { d[HV.Phase] = 1; return 1; }   // taken meanwhile: the usable test again (7.1.1 ours 4)
        const take = (u.oid & 0xffff) === U.Hunter ? Math.min(4, free) : 1;
        n!.reserved += take; d[HV.Reserved] = take; d[HV.Amount] = take;
        d[HV.Good] = n!.yieldGood;
        if ((u.oid & 0xffff) === U.Hunter) { d[HV.Phase] = 2; return 1; }
        this.setAction(u, Action.Work);
        d[HV.Phase] = 2;
        return 100;
      }
      case 2: { // the work ends: take the goods, deliver to the nearest store
        if (n) {
          n.reserved = Math.max(0, n.reserved - d[HV.Reserved]);
          n.amount = Math.max(0, n.amount - d[HV.Amount]);
          this.depleted(n);
        }
        const took = d[HV.Amount];
        if (took > 0) { u.carryGood = d[HV.Good]; u.carryAmount += took; }
        d[HV.Reserved] = 0; d[HV.Amount] = 0;
        // a hunter with no store at all ends the harvest still carrying the meat (7.3.4 step 7)
        if (took > 0 && (u.oid & 0xffff) === U.Hunter && !this.anyStore(u)) return 0;
        d[HV.Phase] = 3;
        return this.deliverStart(u, d);
      }
      case 3: return this.deliverStep(u, d);
      case 4: { // delivered (or failed): continue, outside again
        if (u.inside >= 0 && this.exitCurrent(u, 5)) return 5;
        if (u.carryAmount > 0) { d[HV.Trips]++; d[HV.Phase] = 3; d[HV.Store] = NONE; return Math.min(5 * d[HV.Trips], 25) + 2; }
        // back to the target (replaced at the top of the run if it was removed); the usable test
        // comes on arrival (7.1 phase 3)
        if (!n) return 0;
        d[HV.Phase] = 0;
        return 1;
      }
      default: return 0;
    }
  }

  private anyStore(u: Entity): boolean {
    const t = this.town(u);
    const [x, y] = this.cellOf(u);
    return !!t && !!this.nearestStore(t, x, y);
  }

  /** free deliveries go to the store nearest the gatherer (5.6) */
  private deliverStart(u: Entity, d: number[]): number {
    const t = this.town(u);
    const [x, y] = this.cellOf(u);
    const s = t ? this.nearestStore(t, x, y) : null;
    if (!s) { d[HV.Phase] = 4; return 100; }
    d[HV.Store] = s.id;
    if (!this.goEntity(u, s)) { d[HV.Phase] = 4; return 100; }
    this.setAction(u, Action.Walk);
    return 1;
  }

  private deliverStep(u: Entity, d: number[]): number {
    if (d[HV.Store] === NONE) return this.deliverStart(u, d);
    if (u.path) return 1;
    const s = this.w.get(d[HV.Store]);
    // the delivery transport's go-to ignores how its walk ended (4.2, 5.5)
    if (!s || !this.atDoor(u, s)) { d[HV.Phase] = 4; return 1; }
    const e = this.enter(u, s);
    if (e) return e;
    if (u.carryAmount > 0) {
      const stored = this.put(s, u.carryGood, u.carryAmount);
      if (stored < u.carryAmount) this.w.notify(u.owner, M.StoresFull, true, ADVISOR_REPEAT_MS);
      u.carryAmount = 0; u.carryGood = NONE;
    }
    d[HV.Phase] = 4;
    // ejected at once; the harvest goes on behind the leave job, 10 ticks blocked (4.10)
    return this.exitCurrent(u, 10) ? 10 : 1;
  }

  /** a nature object lost some of its amount (7.4) */
  depleted(n: Entity): void {
    const r = this.rule(n);
    if (!r) return;
    const full = Math.max(1, n.full);
    n.stage = Math.trunc(((full - n.amount) * 100) / full);
    if (n.amount > 0) return;
    if (r.cls === NC.Bush) {
      if (!n.growJob) {
        const c = 20 + (this.w.rand.next() % 5);
        n.growJob = this.w.sched.create(LJ.Regrowth, n.id, 299, [c, c]).id;
      }
      return;
    }
    if (r.cls === NC.Animal || r.cls === NC.Tree) this.fileRespawn(n, r.cls);
    this.w.removeEntity(n);
  }

  private runRegrowth(job: Job): number {
    const n = this.w.get(job.owner);
    if (!n) return 0;
    if (--job.data[0] > 0) return 299;
    job.data[0] = job.data[1];
    n.amount = Math.min(n.full, n.amount + 1);
    n.stage = Math.trunc(((n.full - n.amount) * 100) / Math.max(1, n.full));
    if (n.amount >= n.full) { n.growJob = 0; return 0; }
    return 299;
  }

  private runGrowth(job: Job): number {
    const n = this.w.get(job.owner);
    if (!n) return 0;
    if (this.rule(n)?.cls === NC.Tree) {
      // a planted tree grows one stage every 599 ticks; then it is full and standing (7.5)
      job.data[0] = (job.data[0] ?? 0) + 1;
      n.stage = Math.trunc((job.data[0] * 100) / TREE_STAGES);
      if (job.data[0] < TREE_STAGES) return 599;
      n.amount = n.full; n.standing = true; n.growJob = 0; n.stage = 0;
      return 0;
    }
    // crops ripen after 599 ticks: 1 raw material, picked up by a porter (7.5)
    n.amount = 1; n.full = 1; n.stage = 0; n.growJob = 0;
    return 0;
  }

  // ---------------------------------------------------------------- operators, farms (7.6, 8.3)

  /** a unit walks to a building and enters it (worker request answer / plain go-to-and-enter) */
  private runAnswer(job: Job): number {
    const u = this.w.get(job.owner), d = job.data;
    if (!u) return 0;
    const b = this.w.get(d[AN.Building]);
    if (d[AN.Phase] === 2) return this.leaveEnd(u);
    if (!b) return this.finish(u);
    if (d[AN.Phase] === 0) {
      if (!this.goEntity(u, b)) { this.cleanup(job, u); return this.finish(u); }
      d[AN.Phase] = 1;
      return 1;
    }
    if (u.path) return 1;
    // the go-to ignores how its walk ended and enters from where the unit stands (4.2, 4.10)
    if (!this.atDoor(u, b)) { this.cleanup(job, u); return this.finish(u); }
    const e = this.enter(u, b);
    // a news seller at a house, a school...: "done" without entering, he stands at the door (8.6)
    if (e === ENTER_DONE) { d[AN.Done] = 1; return this.finish(u); }
    // refused at the door (an outpost, combat.md 9.1): the job fails, the unit stands idle there
    if (e < 0) { this.cleanup(job, u); return this.finish(u); }
    if (e) return e;
    d[AN.Done] = 1;
    this.entered(u, b);
    if (u.job === job.id) u.job = 0;
    return 0;
  }

  /** a job of another module has put the unit inside: run the entry rules (4.4 "unit entered") */
  unitEntered(u: Entity, b: Entity): void { this.entered(u, b); }

  /** what happens when a unit has entered a building (4.4 "unit entered") */
  private entered(u: Entity, b: Entity): void {
    const r = this.rule(b), t = this.town(b);
    // an operator walking back into his own active building stays inside (an officer back from a
    // hunt, a diplomat sent home); a staffed building restarts its operator job (8.5, `00460ed0`)
    if (b.operatorId === u.id && b.active) { u.job = 0; this.setAction(u, Action.Idle); this.operatorBack(b); return; }
    if (r && t && b.complete && !b.active && (u.oid & 0xffff) === r.operator && (u.oid >>> 16) === t.race) {
      b.operatorId = u.id;
      this.activate(b);
      this.w.notify(t.race, M.OperatorArrived);
      if (r.flags & BuildingFlag.OperatorInside) this.startOperatorJob(b, r);
      return;
    }
    // resettling: entering a building of another town of the same race moves the unit there (3.4)
    if (t && u.town !== t.id && (u.oid >>> 16) === t.race) {
      const old = this.town(u);
      if (old) this.w.economy.leaveTown(u);
      this.w.economy.joinTown(u, t);
      t.homeless.push(u.id);
    }
    // a porter in a visit building (houses, tavern, circus, temple) stays: a leisure visitor or one
    // ordered in. The visit job starts only when the building's job slot is free; a house that is
    // not full holds its house job there (4.4 "Residences", 5.7, 8.3)
    if (r && b.complete && (r.flags & BuildingFlag.PortersVisit) && (u.oid & 0xffff) === T.Porter) {
      u.job = 0; u.ordered = false;
      this.setAction(u, Action.Idle);
      if (!this.slotJob(b)) b.opJob = this.w.sched.create(LJ.Operator, b.id, 299).id;
      return;
    }
    // a training building (class 5) keeps everybody of its race who enters, whatever the unit type
    // and whether or not an order is queued: the unit joins the occupant list, idle, and stays
    // until an order retypes it, it is sent out or the building is lost (4.4, 9.1)
    if (r && t && r.cls === 5 && b.complete && (u.oid >>> 16) === t.race) {
      u.job = 0; u.ordered = false;
      this.setAction(u, Action.Idle);
      if (b.queue.length) this.ensureTrainingJob(b);
      return;
    }
    // a ranged unit in an outpost of its race stays as its garrison with no job; the outpost job
    // starts 20 ticks later if it is not running (combat.md 9.2)
    if (r && r.cls === 6 && b.complete && this.isGarrison(u, b) && (u.oid >>> 16) === (b.oid >>> 16)) {
      u.job = 0; u.ordered = false;
      this.setAction(u, Action.Idle);
      this.w.combat.startOutpost(b);
      return;
    }
    // anyone else just comes out again
    const j = this.w.sched.create(LJ.Answer, u.id, 10, [2, b.id, 0, 1]);
    u.job = j.id;
  }

  /**
   * The stored operator re-entered his active building (`00460ed0`): a staffed building's
   * operator job is replaced by a new one, first run after 100 ticks (8.5).
   */
  operatorBack(b: Entity): void {
    const r = this.rule(b);
    if (!r || !(r.flags & BuildingFlag.OperatorInside)) return;
    if (b.opJob) this.w.sched.cancel(b.opJob);
    b.opJob = this.w.sched.create(LJ.Operator, b.id, 100).id;
  }

  /**
   * The building's job slot (+0x30) as far as visits are concerned (4.4 "Residences", 5.7): the
   * running house job (0x0A) or operator / visit job (0x22, or an outpost job), undefined when free.
   */
  private slotJob(b: Entity): Job | undefined {
    for (const id of [b.houseJob, b.opJob]) {
      const j = id ? this.w.sched.get(id) : undefined;
      if (j && !j.cancelled) return j;
    }
    return undefined;
  }

  private startOperatorJob(b: Entity, _r: ObjectRule): void {
    if (!b.opJob) b.opJob = this.w.sched.create(LJ.Operator, b.id, 100).id;
  }

  private runOperator(job: Job): number {
    const b = this.w.get(job.owner);
    const r = b && this.rule(b);
    if (!b || !r) return 0;
    // visit buildings (houses, tavern, circus, temple; none is staffed): no occupant ends the job;
    // otherwise the last porter of the occupant list is let out (his idle counter untouched: a
    // leisure visitor stays at -1, 5.7 "After leaving"), again after 299 ticks while anyone (the
    // tavern's operator too) is inside; a run without a porter ends the job (8.3)
    if ((r.flags & BuildingFlag.PortersVisit) && !(r.flags & BuildingFlag.OperatorInside)) {
      const end = () => { if (b.opJob === job.id) b.opJob = 0; return 0; };
      const inside = this.occupants(b);
      const v = inside.filter(u => (u.oid & 0xffff) === T.Porter).pop();
      if (!v) return end();
      if (v.job) this.cancelJob(v);
      this.leave(v);
      return this.occupants(b).length ? 299 : end();
    }
    if (!b.active) { b.opJob = 0; return 0; }
    if ((b.oid & 0xffff) === 54) {   // police station: send the officer after criminals (combat.md 12.2)
      if (this.w.combat.policeDispatch(b)) { b.opJob = 0; return 0; }
      return 50;
    }
    if (this.type(b) === NEWS_STAND && r.operator === U.NewsSeller) return this.newsDispatch(b, job);
    const op = this.w.get(b.operatorId);
    if (!op || op.inside !== b.id) { b.opJob = 0; return 0; }
    const opRule = this.rule(op);
    // farms: plant while fewer than 10 crops grow within radius 6 (7.6)
    if (opRule && opRule.product >= 0 && (b.oid & 0xffff) === 45) {
      const base = opRule.product;
      const [fx, fy] = this.cellOf(b);
      let crops = 0;
      for (const e of this.w.entities) {
        if (e.kind !== Kind.Nature) continue;
        const ty = e.oid & 0xffff;
        if (ty >= base && ty <= base + 3) { const [x, y] = this.cellOf(e); if (this.dist(x, y, fx, fy) <= 6) crops++; }
      }
      if (crops < 10) {
        const pick = (c: number) => (this.w.rand.next() % 2 === 0 ? c + (this.w.rand.next() % 3) : c - (this.w.rand.next() % 3) - 2);
        const px = pick(fx), py = pick(fy);
        const type = base + (this.w.rand.next() % 4);
        if (!this.w.occupied(px, py)) {
          const j = this.w.sched.create(LJ.Plant, op.id, 1, [0, b.id, px & (this.w.size - 1), py & (this.w.size - 1), type]);
          op.job = j.id;
          this.leave(op);   // the plant job waits behind the leave job
          b.opJob = 0;
          return 0;
        }
      }
      return 99;
    }
    return 0;
  }

  private runPlant(job: Job): number {
    const u = this.w.get(job.owner), d = job.data;
    if (!u) return 0;
    const farm = this.w.get(d[1]);
    switch (d[0]) {
      case 0:
        if (!this.goCell(u, d[2], d[3])) { d[0] = 3; return 1; }
        d[0] = 1; return 1;
      case 1: {
        if (u.path) return 1;
        this.setAction(u, Action.Work);
        d[0] = 2; return 50;
      }
      case 2: {
        // the work time is up: the stop message ends the work animation (unit-motion.md 3)
        this.setAction(u, Action.Idle);
        const [x, y] = this.cellOf(u);
        if (!this.w.occupied(x, y) && farm) {
          const crop = this.w.spawn({ cls: 2, group: NATURE_GROUP, type: d[4], owner: -1, x, y, z: 0 });
          crop.amount = 0; crop.full = 1; crop.stage = 100; crop.actionTick = this.w.tick;
          crop.growJob = this.w.sched.create(LJ.Growth, crop.id, 599).id;
          const t = this.town(farm);
          if (t) this.requestTransport(t, List.Pickup, crop.id);
        }
        d[0] = 3; return 1;
      }
      case 3:
        if (!farm || !this.goEntity(u, farm)) return this.finish(u);
        d[0] = 4; return 1;
      default: {
        if (u.path) return 1;
        if (!farm || !this.near(u, farm)) return this.finish(u);
        const e = this.enter(u, farm);
        if (e) return e;
        u.job = 0;
        const r = this.rule(farm);
        if (r && farm.active && !farm.opJob) farm.opJob = this.w.sched.create(LJ.Operator, farm.id, 100).id;
        return 0;
      }
    }
  }

  // ---------------------------------------------------------------- the news round (8.6)

  /** save games before version 11: restart the operator job of every active stand with its seller inside */
  migrateNewsStands(): void {
    for (const b of this.w.entities) {
      if (b.kind !== Kind.Building || this.type(b) !== NEWS_STAND || !b.alive || !b.complete || !b.active) continue;
      const op = this.w.get(b.operatorId);
      if (!op || op.inside !== b.id) continue;
      const j = b.opJob ? this.w.sched.get(b.opJob) : undefined;
      if (j && !j.cancelled) continue;
      b.opJob = this.w.sched.create(LJ.Operator, b.id, 100).id;
    }
  }

  /**
   * The houses a news seller of town `t` visits, in round order: the town's small houses (37), then
   * its large houses (38), each list in the order the buildings joined the town (sites included;
   * a collapsing house stays until phase 2 of its destruction).
   */
  newsHouses(t: Town | undefined): Entity[] {
    if (!t) return [];
    const small: Entity[] = [], large: Entity[] = [];
    for (const e of this.w.entities) {
      if (e.kind !== Kind.Building || e.town !== t.id) continue;
      const ty = this.type(e);
      if (ty === T.SmallHouse) small.push(e); else if (ty === T.LargeHouse) large.push(e);
    }
    return small.concat(large);
  }

  /**
   * Operator job of a news stand (8.3 case 20, period 299): its first occupant (in practice the
   * seller) is sent on a news round when his town has a house; the round starts 1 tick later,
   * behind his leave job (plain eject: the stand stays active, 8.5), and the operator job ends.
   */
  private newsDispatch(b: Entity, job: Job): number {
    const first = this.occupants(b)[0];
    if (!first) { b.opJob = 0; return 0; }
    if (!this.newsHouses(this.town(first)).length) return 299;
    this.cancelJob(first);
    first.idle = 0;
    first.job = this.w.sched.create(LJ.News, first.id, 1, [NewsChild.None, 0, b.id, -1]).id;
    this.leave(first);
    if (b.opJob === job.id) b.opJob = 0;
    return 0;
  }

  /**
   * News round (job 0x1A, 8.6): the seller walks to every house of his town in turn (a go-to that
   * ends "done" at the door), plays his work row once there and waits 20 ticks, then walks back
   * into his stand, whose entry restarts the operator job. No economic effect.
   */
  private runNews(job: Job): number {
    const u = this.w.get(job.owner), d = job.data;
    if (!u || !u.alive) return 0;
    const stand = this.w.get(d[NR.Stand]);
    const standAlive = !!stand && stand.alive;
    if (d[NR.Child] !== NewsChild.None) {
      const r = this.newsChild(u, job);
      if (r > 0) return r;
      if (r === NEWS_INSIDE) {
        // back in the stand: the entry rules ran (operator job restarted); the round is over
        if (u.job === job.id) u.job = 0;
        return 0;
      }
      d[NR.Child] = NewsChild.None; d[NR.Target] = -1;
      if (r === NEWS_FAILED) return 20;
      // at the house: the work row once, facing it (action message, repeat count 0)
      u.action = Action.Work; u.actionTick = this.w.tick; u.idleTick = -1;
      const n = this.newsHouses(this.town(u)).length;
      if (d[NR.Index] >= n && standAlive) { d[NR.Child] = NewsChild.Created; d[NR.Target] = stand!.id; }
      return 20;
    }
    const houses = this.newsHouses(this.town(u));
    const i = d[NR.Index];
    if (i < houses.length) {
      d[NR.Index] = i + 1;
      const h = houses[i];
      if (!h.complete && h.alive) return 1;   // a construction site: skipped
      d[NR.Child] = NewsChild.Created; d[NR.Target] = h.id;
      return 1;
    }
    if (!standAlive) return this.finish(u);
    d[NR.Child] = NewsChild.Created; d[NR.Target] = stand!.id;
    return 1;
  }

  /**
   * The round's go-to child (4.2): walk to the target's door, turn, ask to enter. Returns the
   * ticks to the next run, or NEWS_DONE (a house answered "done"), NEWS_FAILED (the target died
   * or refused him), NEWS_INSIDE (he entered the stand).
   */
  private newsChild(u: Entity, job: Job): number {
    const d = job.data;
    const b = this.w.get(d[NR.Target]);
    if (!b || !b.alive) { this.abortEnter(u); this.w.stopWalk(u); return NEWS_FAILED; }
    if (d[NR.Child] === NewsChild.Created) {
      // the walk's result is not read: a failed plan leads to the turn and the request from here
      this.goEntity(u, b);
      d[NR.Child] = NewsChild.Walking;
      return 1;
    }
    if (d[NR.Child] === NewsChild.Walking) {
      if (u.path) return 1;
      d[NR.Child] = NewsChild.Door;
    }
    if (!this.atDoor(u, b)) return NEWS_FAILED;
    const e = this.enter(u, b);
    if (e === ENTER_DONE) return NEWS_DONE;
    if (e < 0) return NEWS_FAILED;
    if (e > 0) return e;
    this.entered(u, b);
    return NEWS_INSIDE;
  }

  /**
   * A resident left its home `b` (`00461690`, 4.4 "Residences"): if the building's job slot holds
   * a visit job, every occupant is ejected (occupant order) and the visit job ends; the economy
   * then starts the house job again.
   */
  residentLeft(b: Entity): void {
    if (!b.opJob) return;
    const j = this.w.sched.get(b.opJob);
    if (!j || j.cancelled || j.kind !== LJ.Operator) return;
    for (const u of this.occupants(b)) this.leave(u);
    this.w.sched.cancel(b.opJob);
    b.opJob = 0;
  }

  // ---------------------------------------------------------------- training (9)

  /** units inside a training building waiting to be trained (everyone but the operator) */
  trainees(b: Entity): Entity[] {
    return this.occupants(b).filter(u => u.id !== b.operatorId);
  }

  /** training order check (odb.md 3): 1 ok, -1 wrong building, 2 invention, 6 money, 3 goods, 5 town limit */
  trainState(t: Town, b: Entity, type: number): number {
    const r = this.w.rules.get(((t.race << 16) | type) >>> 0);
    const p = this.w.economy.players[t.race];
    if (!r || r.kind !== Kind.Unit || !p || r.madeAt !== (b.oid & 0xffff) || p.disabled.includes(type)) return -1;
    if (r.invention >= 0 && !this.w.economy.researched(p, r.invention)) return 2;
    if (type === T.Founder && p.towns.length >= MAX_TOWNS) return 5;
    if (p.money < r.money) return 6;
    for (let g = 0; g < GOODS; g++) if (t.stock[g] < r.cost[g]) return 3;
    return 1;
  }

  /** queue a unit for training (charges the price at once) */
  train(b: Entity, type: number): boolean {
    const t = this.town(b);
    if (!t || !b.complete || b.queue.length >= MAX_QUEUE) return false;
    const st = this.trainState(t, b, type);
    if (st !== 1 && st !== 3) return false;
    const r = this.w.rules.get(((t.race << 16) | type) >>> 0)!;
    const p = this.w.economy.players[t.race]!;
    p.money = Math.max(0, p.money - r.money);
    if (p.money < 6 && !p.computer) this.w.notify(t.race, 18, true, ADVISOR_REPEAT_MS);
    const before = b.queue.length;
    b.queue.push(type);
    t.pending[type] = (t.pending[type] ?? 0) + 1;
    this.orderTrainingGoods(b, t);
    if (type !== T.Porter && before >= this.trainees(b).length) this.requestWorker(t, T.Porter, b.id);
    this.ensureTrainingJob(b);
    return true;
  }

  /** request the goods of all queued orders that are neither in the building nor on their way */
  private orderTrainingGoods(b: Entity, t: Town): void {
    for (let g = 0; g < GOODS; g++) {
      let need = 0;
      b.queue.forEach((type, i) => { if (i > 0 || !b.trainStarted) need += this.w.rules.get(((t.race << 16) | type) >>> 0)?.cost[g] ?? 0; });
      const missing = need - b.local[g] - b.needed.filter(x => x === g).length;
      for (let k = 0; k < missing; k++) { b.needed.push(g); this.requestTransport(t, List.Training, b.id); }
    }
  }

  /** cancel queued order `index`: refund the price (an order in progress loses its goods) */
  cancelTraining(b: Entity, index: number): void {
    const t = this.town(b);
    if (!t || index < 0 || index >= b.queue.length) return;
    const type = b.queue.splice(index, 1)[0];
    const r = this.w.rules.get(((t.race << 16) | type) >>> 0);
    const p = this.w.economy.players[t.race];
    if (r && p) p.money += r.money;
    t.pending[type] = Math.max(0, (t.pending[type] ?? 1) - 1);
    if (index === 0) { b.trainStarted = 0; b.trainProgress = 0; }
  }

  /**
   * A training building is lost (9 "Lost building", `004761e0`): its training job is deleted and
   * the job's destructor lowers the town's pending count once for every order still queued
   * (clamped at 0), without refund. Safe to call twice (the queue is empty afterwards).
   */
  dropTraining(b: Entity): void {
    if (b.trainJob) { this.w.sched.cancel(b.trainJob); b.trainJob = 0; }
    const t = this.town(b);
    if (t) for (const type of b.queue) t.pending[type] = Math.max(0, (t.pending[type] ?? 1) - 1);
    b.queue = [];
    b.trainStarted = 0; b.trainProgress = 0;
  }

  private ensureTrainingJob(b: Entity): void {
    if (!b.trainJob || !this.w.sched.get(b.trainJob)) b.trainJob = this.w.sched.create(LJ.Training, b.id, 30).id;
  }

  private runTraining(job: Job): number {
    const b = this.w.get(job.owner);
    if (!b || !b.queue.length) { if (b) b.trainJob = 0; return 0; }
    const t = this.town(b);
    if (!t || !b.active) return 30;
    const type = b.queue[0];
    const r = this.w.rules.get(((t.race << 16) | type) >>> 0);
    if (!r) { b.queue.shift(); return 30; }
    const student = this.trainees(b)[0];
    if (!student) return 30;
    if (!b.trainStarted) {
      for (let g = 0; g < GOODS; g++) if (b.local[g] < r.cost[g]) return 30;
      for (let g = 0; g < GOODS; g++) b.local[g] -= r.cost[g];
      b.trainStarted = 1; b.trainProgress = 0;
      return 30;
    }
    b.trainProgress += 5;
    if (b.trainProgress < r.hp) return 30;
    // done: the first occupant becomes the new unit (the porter is consumed)
    b.queue.shift();
    b.trainStarted = 0; b.trainProgress = 0;
    t.pending[type] = Math.max(0, (t.pending[type] ?? 1) - 1);
    // a type change re-evaluates the needs twice (economy.md 5.4, `00464840`)
    this.w.economy.changeType(student, ((t.race << 16) | type) >>> 0);
    student.hp = r.hp;
    student.carryAmount = 0; student.carryGood = NONE;
    // a ship comes out on the nearest open-sea cell without a unit (addon.md 3.4)
    if (this.w.isShip(student)) { b.doorTick = this.w.tick; this.w.naval.launch(student, b); }
    else this.leave(student);
    this.w.notify(t.race, M.Trained);
    return b.queue.length ? 30 : (b.trainJob = 0, 0);
  }

  // ---------------------------------------------------------------- panel commands

  /** unit commands from the info page */
  unitAction(u: Entity, action: string, town?: Town): void {
    if (action === 'drop') { u.carryAmount = 0; u.carryGood = NONE; this.setAction(u, u.path ? Action.Walk : Action.Idle); return; }
    // go home (command 0x20, 3.2): a walk to the first cell of the 4.8 spiral around the current
    // town's position (its hall's anchor) that misses the path mask; it enters nothing
    if (action === 'home') {
      if (this.w.isShip(u) || u.inside >= 0 || (u.oid & 0xffff) === T.Criminal) return;
      const t = town ?? this.town(u);
      if (!t || !t.alive) return;
      this.cancelJob(u);
      const m = this.w.size - 1;
      let goal: [number, number] = [t.x & m, t.y & m];
      search: for (let k = 0; k <= 32; k++) for (const [px, py] of ring(t.x, t.y, k)) if (!this.w.occupied(px, py)) { goal = [px & m, py & m]; break search; }
      u.ordered = true;
      if (!this.goCell(u, goal[0], goal[1])) this.setAction(u, Action.Idle);
    }
  }

  /** building commands from the info page */
  buildingAction(b: Entity, action: string): void {
    const t = this.town(b), r = this.rule(b);
    if (!t || !r) return;
    if (action === 'repair') { if (b.complete && b.hp < r.hp) this.requestWorker(t, T.Builder, b.id); return; }
    // one toggling command (`00452d20` / `0045f490`, 6.8): the original's command carries no direction
    if (action === 'pause' || action === 'resume') { this.togglePause(b, t); return; }
    if (action === 'deactivate') { this.deaktivieren(b, r); return; }
    // mentor#80 comes at the end of the collapse (phase 2), not here (side-panel.md 1.1.3)
    if (action === 'demolish') this.demolish(b);
  }

  /**
   * `DEAKTIVIEREN` (command 8, `00450860`, 4.11): the first occupant of the building's operator
   * type (any race) is ejected with the "sent out" flag, so the building is deactivated when he is
   * put outside. Without such an occupant, a stored operator who is outside (an errand) has his
   * current job cancelled (behind a leave job: the job queued there), is released, and the
   * building is deactivated at once. Refused for the town hall (the UI disables it).
   */
  private deaktivieren(b: Entity, r: ObjectRule): void {
    if (this.type(b) === T.TownHall || !b.complete) return;
    const first = r.operator >= 0 ? this.occupants(b).find(u => this.type(u) === r.operator) : undefined;
    if (first) { this.leave(first, true); return; }
    if (b.operatorId < 0) return;
    const op = this.w.get(b.operatorId);
    // a stored operator that died on duty (a news seller, 8.6 "Death"): released, deactivated
    if (!op || op.kind !== Kind.Unit || !op.alive) { this.deactivateBuilding(b); return; }
    if (this.leaving(op)) {
      for (const id of op.suspended.splice(0)) {
        const sj = this.w.sched.get(id);
        if (sj && !sj.cancelled) { sj.cancelled = true; sj.hold = 0; this.cleanup(sj, op); }
      }
    } else {
      this.cancelJob(op);
      this.w.stopWalk(op);
      this.w.combat.endUnitJob(op);
      // our addition: a diplomat whose errand is cancelled inside a foreign embassy comes out
      if (op.inside >= 0 && op.inside !== b.id) this.leave(op);
    }
    this.deactivateBuilding(b);
  }

  /** pause / resume construction (6.8): only a site (a building with a construction order) */
  private togglePause(b: Entity, t: Town): void {
    if (b.complete || !b.order || b.order.kind !== 'build') return;
    if (!b.paused) this.pauseSite(b, t); else this.resumeSite(b, t);
  }

  /**
   * Pause (`004758c0`, 6.8): the construction job is blocked; every listed builder whose current
   * job is the builder job on this site loses it at once (off the list, no new request, he stops
   * where he is); every transport request for the site is withdrawn and the needed list cleared.
   * Transports under way, the local stock and the order are kept.
   */
  private pauseSite(b: Entity, t: Town): void {
    const o = b.order!;
    b.paused = true;
    for (const id of o.builders.slice()) {
      const u = this.w.get(id);
      const j = u?.job ? this.w.sched.get(u.job) : undefined;
      if (!u || !j || j.cancelled || j.kind !== LJ.Builder || j.data[BJ.Building] !== b.id) continue;
      o.builders = o.builders.filter(x => x !== id);
      this.cancelJob(u);
      this.w.stopWalk(u);
      this.w.combat.endUnitJob(u);
    }
    for (let li = 0; li < t.lists.length; li++) if (t.lists[li].includes(b.id)) t.lists[li] = t.lists[li].filter(x => x !== b.id);
    b.needed = [];
  }

  /**
   * Resume (`00475990`, 6.8): unblocked, one builder request, and for each good still to consume
   * (amount - local stock) needed entries appended with one list-1 request each.
   */
  private resumeSite(b: Entity, t: Town): void {
    b.paused = false;
    this.requestWorker(t, T.Builder, b.id);
    for (const [g, left] of b.order!.list) {
      for (let k = left - b.local[g]; k > 0; k--) { b.needed.push(g); this.requestTransport(t, List.Construction, b.id); }
    }
  }

  /** tear a building down: it collapses like a destroyed one and leaves rubble (combat.md 10.3) */
  demolish(b: Entity): void {
    const t = this.town(b);
    if (t && b.queue.length) for (let i = b.queue.length - 1; i >= 0; i--) this.cancelTraining(b, i);
    this.w.combat.collapse(b, true);
  }


  // ---------------------------------------------------------------- founding a town (11)

  /**
   * Town-hall site test for founding (11.1 / 11.2): footprint grown by one free of buildings,
   * nature and water; ring at distance 2 within 64 height; with `territory`, the four corner
   * points outside every territory (flag 0x1000, economy.md 11.7). The player's preview also needs
   * the cells in sight.
   */
  canFound(race: number, x: number, y: number, territory: boolean): boolean {
    const r = this.w.rules.get(((race << 16) | T.TownHall) >>> 0);
    if (!r) return false;
    const sx = Math.max(1, r.sizeX), sy = Math.max(1, r.sizeY), w = this.w;
    for (let dy = -1; dy <= sy; dy++) for (let dx = -1; dx <= sx; dx++) if (w.occupied(x - sx + 1 + dx, y - sy + 1 + dy)) return false;
    let lo = Infinity, hi = -Infinity;
    for (let dy = -2; dy <= sy + 1; dy++) for (let dx = -2; dx <= sx + 1; dx++) {
      if (dy > -2 && dy < sy + 1 && dx > -2 && dx < sx + 1) continue;
      const h = w.heightAt(x - sx + 1 + dx, y - sy + 1 + dy);
      lo = Math.min(lo, h); hi = Math.max(hi, h);
    }
    if (hi - lo > 64) return false;
    if (territory && !w.territory.outsideAll(x, y, r.sizeX, r.sizeY)) return false;
    return true;
  }

  /** "found town" command (11.2): new town + town-hall site at (x, y), the founder walks there */
  found(u: Entity, x: number, y: number): boolean {
    const race = u.oid >>> 16;
    if (u.inside >= 0 || (u.oid & 0xffff) !== T.Founder || !u.alive) return false;
    const p = this.w.economy.players[race];
    if (p && p.towns.filter(id => this.w.economy.towns[id]?.alive).length >= MAX_TOWNS) return false;
    if (!this.canFound(race, x, y, false)) return false;
    const r = this.w.rules.get(((race << 16) | T.TownHall) >>> 0)!;
    this.cancelJob(u);
    const m = this.w.size - 1;
    const mapId = 1000 + this.w.economy.towns.length;
    const hall = this.w.spawn({ cls: 1, group: race, type: T.TownHall, owner: mapId, x: x & m, y: y & m, z: 0 });
    hall.complete = false; hall.hp = Math.floor(r.hp / 10); hall.buildFrame = 0;
    const t = this.w.economy.foundTown(race, mapId, hall, undefined, false);
    hall.town = t.id;
    this.w.claimTerritory(hall);   // a town-hall site already has its territory (economy.md 11.2)
    if (u.home >= 0) this.w.economy.leaveHome(u);
    if (this.town(u)) this.w.economy.leaveTown(u);
    this.w.economy.joinTown(u, t);
    this.assign(u, LJ.Found, 1, [0, hall.id, 0]);
    return true;
  }

  /** job 0x0E (11.3): walk to the site, complete it on arrival, enter 20 ticks later */
  private runFound(job: Job): number {
    const u = this.w.get(job.owner), d = job.data;
    if (!u) return 0;
    const hall = this.w.get(d[FD.Hall]);
    const fail = () => { this.cleanup(job, u); return this.finish(u); };
    if (!hall || !hall.alive) return fail();
    if (d[FD.Phase] === 0) {
      if (!this.goEntity(u, hall)) return fail();
      d[FD.Phase] = 1;
      return 1;
    }
    if (d[FD.Phase] === 1) {
      if (u.path) return 1;
      if (!this.near(u, hall)) return fail();
      // arrival: the site is complete at once, no goods and no builder needed
      const r = this.rule(hall);
      hall.complete = true; hall.hp = r?.hp ?? hall.hp; hall.buildFrame = 0;
      this.setAction(u, Action.Work);
      this.w.notify(u.oid >>> 16, M.NewTown);
      d[FD.Phase] = 2;
      return 20;
    }
    // then a go-to child to the hall (1 tick), its plan (1 tick; he stands on the goal), the turn
    // toward the hall's anchor, the request 1 tick later, admission and 5 ticks (4.10 worked example)
    if (d[FD.Phase] === 2) { d[FD.Phase] = 3; return 1; }
    if (d[FD.Phase] === 3) {
      if (!this.goEntity(u, hall)) return fail();
      d[FD.Phase] = 4;
      return 1;
    }
    if (d[FD.Phase] === 4) {
      if (u.path) return 1;
      if (!this.near(u, hall)) { d[FD.Phase] = 3; return 5; }
      d[FD.Phase] = 5;
      return 1;
    }
    const e = this.enter(u, hall);
    if (e) return e;
    d[FD.Done] = 1;
    const t = this.town(hall);
    this.entered(u, hall);
    if (t && hall.active) this.w.economy.startGoodsAtActivation(t);
    u.job = 0;
    return 0;
  }

  // ---------------------------------------------------------------- wild animals (7.7)

  startAnimal(n: Entity): void {
    n.homeX = Math.floor(n.x / SUB); n.homeY = Math.floor(n.y / SUB);
    // the constructor draws the first mode rand() % 3 (0 wander, 1 idle, 2 eat), then the delay (7.7)
    const mode = this.w.rand.next() % 3;
    n.job = this.w.sched.create(LJ.Animal, n.id, 1 + (this.w.rand.next() % 40), [mode, -1, 0, 0, 0]).id;
  }

  /**
   * Animal job (0x24, 7.7): one mode at a time. Wander: walk to the first free cell (0x3E) of the
   * spiral around a random point near home. Idle: turn to 3, play ID3 for 11 cycles, wait 50 ticks.
   * Eat: the eat child (0x2A, 7.7.1) on a bush or crop near home. Then the next mode by rand().
   */
  private runAnimal(job: Job): number {
    const n = this.w.get(job.owner);
    if (!n || !n.alive) { if (n) n.job = 0; return 0; }
    const d = job.data, w = this.w, rand = () => w.rand.next();
    if (d[AM.Running]) {
      if (d[AM.Mode] === AnimalMode.Wander) {
        if (n.path) return 1;
        d[AM.Running] = 0;
        d[AM.Mode] = rand() % 2 === 0 ? AnimalMode.Idle : AnimalMode.Eat;
        return 1;
      }
      if (d[AM.Mode] === AnimalMode.Idle) {
        const t = w.motion.turn(n, 3);
        if (t) return t;
        w.motion.playIdle(n, 10);
        d[AM.Running] = 0;
        d[AM.Mode] = rand() % 2 === 0 ? AnimalMode.Wander : AnimalMode.Eat;
        return 50;
      }
      const r = this.eatStep(n, d);
      if (r > 0) return r;
      // the eat child ended (with or without success): wander, 1 tick later
      d[AM.Food] = -1; d[AM.Running] = 0; d[AM.Phase] = 0; d[AM.Reserved] = 0;
      d[AM.Mode] = AnimalMode.Wander;
      return 1;
    }
    if (d[AM.Mode] === AnimalMode.Wander) {
      const x = n.homeX + (rand() % 15) - 7, y = n.homeY + (rand() % 15) - 7;
      const c = w.freeSpiral(x, y, 8);
      if (c && w.walk(n, c[0], c[1], ANIMAL_PATH_NODES) && n.path) { d[AM.Running] = 1; return 1; }
      return 25 + (rand() % 25);   // nothing started
    }
    if (d[AM.Mode] === AnimalMode.Idle) { d[AM.Running] = 1; return 1; }
    // eat (mode 2): bushes and crops with dx^2 + dy^2 < 100 around home, in ascending id order,
    // with unreserved amount and a free eating cell (x, y - 1); only those draw rand(), 1 in 3
    const sz = w.size;
    const wrap = (v: number) => { v %= sz; if (v > sz / 2) v -= sz; else if (v < -sz / 2) v += sz; return v; };
    for (const e of this.foodSources()) {
      if (e.amount - e.reserved <= 0) continue;
      const [x, y] = this.cellOf(e);
      const dx = wrap(x - n.homeX), dy = wrap(y - n.homeY);
      if (dx * dx + dy * dy >= 100) continue;
      if (!w.motion.free(x, y - 1, n)) continue;
      if (rand() % 3 !== 0) continue;
      // the eat child is created; its first run is the next tick
      d[AM.Food] = e.id; d[AM.Running] = 1; d[AM.Phase] = EatPhase.Check; d[AM.Reserved] = 0;
      return 1;
    }
    d[AM.Mode] = rand() % 2 === 0 ? AnimalMode.Wander : AnimalMode.Idle;
    return 5;
  }

  /**
   * One run of the eat child (job 0x2A, 7.7.1); 0 = it ended. The eating place is only the cell
   * (x, y - 1) of the food; the animal must stand exactly there, turns to 3, reserves 1 unit, plays
   * ID3 with repeat count 99, and 100 ticks later takes the bite.
   */
  private eatStep(n: Entity, d: number[]): number {
    const w = this.w, food = w.get(d[AM.Food]);
    const live = !!food && food.kind === Kind.Nature;
    const m = w.size - 1;
    // an old save (no phase slot) was walking to its food
    const phase = d[AM.Phase] ?? EatPhase.Walk;
    switch (phase) {
      case EatPhase.Check: { // +1: the eating cell must still be free; the follow-path child is created
        if (!live) return 0;
        const [x, y] = this.cellOf(food!);
        if (!w.motion.free(x, y - 1, n)) return 0;
        d[AM.Phase] = EatPhase.Plan;
        return 1;
      }
      case EatPhase.Plan: { // the follow-path child's first run: plan to exactly that cell
        if (!live) return 0;
        const [x, y] = this.cellOf(food!);
        if (!w.walk(n, x, y - 1, ANIMAL_PATH_NODES)) return 0;
        d[AM.Phase] = EatPhase.Walk;
        return n.path ? 1 : this.eatStep(n, d);
      }
      case EatPhase.Walk: { // walking; on arrival only the exact cell counts (no tolerance)
        if (n.path) return 1;
        if (!live) return 0;
        const [x, y] = this.cellOf(food!), [ax, ay] = this.cellOf(n);
        if (ax !== x || ay !== ((y - 1) & m)) return 0;
        d[AM.Phase] = EatPhase.Turn;
        return 1;
      }
      case EatPhase.Turn: { // turn to 3, then reserve 1 and play ID3 (repeat 99)
        const t = w.motion.turn(n, 3);
        if (t) return t;
        if (!live || food!.amount - food!.reserved <= 0) return 0;
        food!.reserved++;
        d[AM.Reserved] = 1;
        w.motion.playIdle(n, 99);
        const cls = this.rule(food!)?.cls ?? -1;
        if (cls >= NC.CropA && cls <= NC.CropS) this.cropEaten(cls - NC.CropA);
        d[AM.Phase] = EatPhase.Bite;
        return 100;
      }
      case EatPhase.Bite: { // +100: unreserve, amount - 1, the depletion update
        if (live && d[AM.Reserved]) {
          food!.reserved = Math.max(0, food!.reserved - 1);
          food!.amount = Math.max(0, food!.amount - 1);
          d[AM.Reserved] = 0;
          this.depleted(food!);
        }
        d[AM.Reserved] = 0;
        return 0;
      }
      default: return 0;
    }
  }

  /** mentor#81 "animals eat plantations" for the crop's nation, queued, interval 2 D = 120 s (7.7.1, side-panel.md 1.1.3) */
  private cropEaten(race: number): void {
    this.w.notify(race, M.AnimalsEat, true, ADVISOR_REPEAT_MS);
  }

  /** an animal job ends early (death): its eat child's reservation is released, nothing is eaten (7.7.1) */
  private releaseEat(n: Entity): void {
    const j = n.job ? this.w.sched.get(n.job) : undefined;
    if (!j || j.kind !== LJ.Animal) return;
    const d = j.data;
    if (d[AM.Mode] === AnimalMode.Eat && d[AM.Running] && d[AM.Reserved]) {
      const food = this.w.get(d[AM.Food]);
      if (food) food.reserved = Math.max(0, food.reserved - 1);
      d[AM.Reserved] = 0;
    }
  }

  /** bushes and crops (what animals eat) in ascending id order; rebuilt whenever the entity set changed */
  private foodCache: { key: string; list: Entity[] } = { key: '', list: [] };
  private foodSources(): Entity[] {
    const es = this.w.entities;
    // ids only grow: the count and the last id identify the entity set
    const key = `${es.length}:${es.length ? es[es.length - 1].id : 0}`;
    if (key !== this.foodCache.key) {
      this.foodCache = { key, list: es.filter(e => {
        if (e.kind !== Kind.Nature) return false;
        const cls = this.rule(e)?.cls ?? -1;
        return cls === NC.Bush || (cls >= NC.CropA && cls <= NC.CropS);
      }) };
    }
    return this.foodCache.list;
  }

  killAnimal(n: Entity): void {
    n.alive = false;
    this.releaseEat(n);
    // death cry (combat.md 10.2): sound 61 for the hare, 62 for the other animals
    const [cx, cy] = this.cellOf(n);
    this.w.effect({ kind: 'sound', tick: this.w.tick, x: cx, y: cy, type: (n.oid & 0xffff) === 37 ? 61 : 62 });
    if (n.job) { this.w.sched.cancel(n.job); n.job = 0; }
    this.w.halt(n);
    n.action = Action.Idle; n.actionTick = this.w.tick;
  }

  // ---------------------------------------------------------------- respawning (7.5)

  /** Gold cell flag 0x10000: a class-0 tile (meadow in base mode; beach and paths in add-on mode) */
  private class0(x: number, y: number): boolean {
    const m = this.w.size - 1, i = ((y & m) << this.w.bits) | (x & m);
    const ao = (this.w.terrain as { aoCls?: Uint8Array }).aoCls;
    if (this.w.addon && ao) return ao[i] === 0 || this.w.pathFlag[i] === 1;
    return this.w.terrain.cls[i] === 0;
  }

  /** the respawn manager (7.5.1): one global job created at game start, first run 299 ticks later */
  startRespawnManager(): void {
    this.w.respawnJob = this.w.sched.create(LJ.Respawn, -1, 299).id;
  }

  /**
   * A restored world without a running manager (older saves) gets one on the original's grid: it
   * runs in the world ticks 299k + 1 (300, 599, ...). Called outside a step, where a job scheduled
   * with delay d runs in tick `tick + d + 1`.
   */
  ensureRespawnManager(): void {
    if (this.w.respawnJob && this.w.sched.get(this.w.respawnJob)) return;
    this.w.respawnJob = this.w.sched.create(LJ.Respawn, -1, (299 - (this.w.tick % 299)) % 299).id;
  }

  /**
   * File an exhausted animal or tree (7.5.1): inserted in front of the first entry whose countdown
   * is >= its own, so the list stays sorted ascending and the newest of equal countdowns comes first.
   */
  private fileRespawn(n: Entity, cls: number): void {
    const [x, y] = this.cellOf(n);
    const r = { type: n.oid & 0xffff, cls, x, y, radius: cls === NC.Animal ? 10 : 15, countdown: cls === NC.Animal ? 20 : 40 };
    const list = this.w.respawns;
    let at = 0;
    while (at < list.length && list[at].countdown < r.countdown) at++;
    list.splice(at, 0, r);
  }

  /**
   * The respawn survivor scan (7.3.3 with class 8): the tree nearest (x, y) in the square of radius
   * R around it, ties to the first in scan order (rows dy = -R..R, within a row dx = -R..R).
   */
  private scanTree(x: number, y: number, R: number): Entity | null {
    const n = this.w.size;
    const wrap = (v: number) => { v %= n; if (v > n / 2) v -= n; else if (v < -n / 2) v += n; return v; };
    let best: Entity | null = null, bd = Infinity, bk = Infinity;
    for (const e of this.w.entities) {
      if (e.kind !== Kind.Nature || this.rule(e)?.cls !== NC.Tree) continue;
      const [ex, ey] = this.cellOf(e);
      const dx = wrap(ex - x), dy = wrap(ey - y);
      if (Math.abs(dx) > R || Math.abs(dy) > R) continue;
      const dd = this.dist(ex, ey, x, y), k = (dy + R) * (2 * R + 1) + (dx + R);
      if (dd < bd || (dd === bd && k < bk)) { best = e; bd = dd; bk = k; }
    }
    return best;
  }

  /** a cell whose flags miss 0x1003F: path, unit, building, nature, water (and Gold's class-0 flag) */
  respawnFree(x: number, y: number): boolean {
    const m = this.w.size - 1, i = ((y & m) << this.w.bits) | (x & m);
    if (!this.w.motion.free(x & m, y & m) || this.w.pathFlag[i] === 1) return false;
    return !(this.w.gold.class0Respawn && this.class0(x, y));   // flag 0x10000 (addon.md 10.2)
  }

  /** one run of the respawn manager (7.5.1): handle the due entries at the front, then count down */
  private runRespawn(_job: Job): number {
    const list = this.w.respawns, m = this.w.size - 1;
    while (list.length && list[0].countdown === 0) {
      const r = list.shift()!;
      const tree = this.scanTree(r.x, r.y, r.radius);   // class 8 for animals too
      if (!tree) continue;
      const [tx, ty] = this.cellOf(tree);
      const x0 = tx + (this.w.rand.next() % 7) - 3;
      const y0 = ty + (this.w.rand.next() % 7) - 3;
      // square spiral (4.8) without limit to the first cell that misses 0x1003F
      let c: [number, number] | null = null;
      for (let k = 0; !c && k <= this.w.size; k++) for (const [px, py] of ring(x0, y0, k)) if (this.respawnFree(px, py)) { c = [px & m, py & m]; break; }
      if (!c) continue;
      const e = this.w.spawn({ cls: 2, group: NATURE_GROUP, type: r.type, owner: -1, x: c[0], y: c[1], z: 0 });
      if (r.cls === NC.Tree) {   // planted small
        e.amount = 0; e.standing = false; e.stage = 0; e.actionTick = this.w.tick;
        e.growJob = this.w.sched.create(LJ.Growth, e.id, 599, [0]).id;
      }
      // a new animal is constructed like one placed at map load (`004638d0`, 7.7)
      if (r.cls === NC.Animal) this.startAnimal(e);
    }
    for (const r of list) r.countdown--;
    return 299;
  }

  // ---------------------------------------------------------------- leisure (5.7)

  private runLeisure(job: Job): number {
    const t = this.w.economy.town(job.owner);
    if (!t || !t.alive) return 0;
    // candidates, listed once per run in the town's per-type order: active buildings whose job slot
    // is free or holds an operator / visit job (0x22). A house still running its house job (not
    // full) is never a target, nor an unstaffed tavern or circus (`0045b1d0`)
    const list = (ty: number) => this.w.entities.filter(b => {
      if (b.kind !== Kind.Building || b.town !== t.id || (b.oid & 0xffff) !== ty || !b.complete || !b.active) return false;
      const j = this.slotJob(b);
      return !j || j.kind === LJ.Operator;
    });
    const cats = [[...list(T.SmallHouse), ...list(T.LargeHouse)], list(58), list(57)];
    // the town's free-porter list: the porter gang in a computer town (5.4)
    const group = this.haulGroup(t);
    for (const u of this.w.entities) {
      if (!this.isFree(u, t, T.Porter, group) || u.inside >= 0 || u.idle === -1 || u.job) continue;
      if (++u.idle <= 1) continue;
      const places = cats[this.w.rand.next() % 3];
      if (!places.length) continue;
      const k = this.w.rand.next() % places.length;
      const b = places[k];
      this.assign(u, LJ.Answer, 1 + (this.w.rand.next() % 70), [0, b.id, T.Porter, 1]);
      u.idle = -1;
      // a building with resident places (the houses) gets one leisure visitor per run
      if ((this.rule(b)?.residents ?? 0) !== 0) places.splice(k, 1);
    }
    return 199;
  }

  // ---------------------------------------------------------------- orders (3.2)

  /**
   * Right-click with a ship that did not attack (addon.md 4.1, 6.1, 6.3): a fishing boat on a fish
   * fishes there (or, with the original's bug, harvests it); anything else: sail next to it.
   */
  private shipOrder(u: Entity, target: Entity): void {
    if (target.kind === Kind.Nature && this.w.naval.isFish(target) && (u.oid & 0xffff) === 64) {
      if (this.w.gold.fishHarvestBug) { this.startHarvest(u, target, true); return; }
      const [x, y] = this.cellOf(target);
      this.w.naval.startFishing(u, x, y, 1, target.id);
      return;
    }
    this.cancelJob(u);
    const [x, y] = target.kind === Kind.Building ? this.entrance(target) : this.cellOf(target);
    this.w.naval.approach(u, x, y, 2);
  }

  /** right-click on a target object for the selected units */
  order(units: Entity[], target: Entity): void {
    for (const u of units) {
      const ut = u.oid & 0xffff;
      if (this.w.combat.order(u, target)) continue;
      if (this.w.addon) {
        if (this.w.naval.boardOrder(u, target)) continue;           // boarding a transport ship (addon.md 5.2)
        if (this.w.isShip(u)) { this.shipOrder(u, target); continue; }
      }
      if (target.kind === Kind.Nature) {
        // a hunter's order on an animal makes the animal's cell his hunting ground (7.3.1)
        if (this.canHarvest(u, target) && ut === U.Hunter) { const [x, y] = this.cellOf(target); this.startHunt(u, x, y, target, 1); }
        else if (this.canHarvest(u, target)) this.startHarvest(u, target, true);
        else { this.cancelJob(u); this.goEntity(u, target); }
        continue;
      }
      if (target.kind === Kind.Building && target.owner === u.owner) {
        const r = this.rule(target);
        if (ut === T.Builder && r && (!target.complete || target.hp < r.hp)) {
          const t = this.town(target);
          if (t) t.workerReqs = t.workerReqs.filter(([ty, b]) => !(ty === T.Builder && b === target.id));
          this.startBuilder(u, target);
          continue;
        }
        if (u.carryAmount > 0 && (this.isStore(target) || target.needed.includes(u.carryGood))) {
          const i = target.needed.indexOf(u.carryGood);
          if (i >= 0 && !this.isStore(target)) target.needed.splice(i, 1);
          this.startTransport(u, target, null, null);
          continue;
        }
        this.assign(u, LJ.Answer, 1, [0, target.id, ut, 1]);
        continue;
      }
      this.cancelJob(u);
      const [x, y] = this.cellOf(target);
      this.goCell(u, x, y);
    }
  }
}

/** animal job data and modes (7.7) */
/** animal job data (7.7): mode, the eat child's food, a child is running, the eat child's phase and reservation */
export const AM = { Mode: 0, Food: 1, Running: 2, Phase: 3, Reserved: 4 } as const;
/** eat child phases (7.7.1): our Check/Plan = the original's phase 0 and the path child's first run */
export const EatPhase = { Check: 0, Plan: 1, Walk: 2, Turn: 3, Bite: 4 } as const;
export const AnimalMode = { Wander: 0, Idle: 1, Eat: 2 } as const;
/** the cells next to a bush or crop an animal eats from: N, W, S, E, then the diagonals */

/** job data slots */
/** transport job data; slots 6 and 7 (once "fetched" / "output taken" flags) are no longer used: the good to fetch stays set until delivered, an output is cleared when taken (5.5) */
const TR = { Phase: 0, Dest: 1, Source: 2, Requester: 3, Fetch: 4, Output: 5, Size: 8 } as const;
/** harvest job data; Attack: a hunter's attack state (combat.ts initAttack, 12 slots; 6 before snapshot version 9) */
export const HV = { Phase: 0, Target: 1, Good: 2, Amount: 3, Trips: 4, Auto: 5, Class: 6, Type: 7, Reserved: 8, Store: 9, TX: 10, TY: 11, Spot: 12, Attack: 13, Size: 25 } as const;
/** hunting-ground job data (7.3): the child running, the spot, then the harvest child's state (HV) */
export const HG = { Child: 0, SX: 1, SY: 2, Harvest: 3, Size: 3 + HV.Size } as const;
export const HuntChild = { None: 0, Harvest: 1, Walk: 2 } as const;
/** builder job data; Face: the facing to work in + 1 (0 = toward the building) */
/** builder job data (6.4); phases in `runBuilder` */
export const BJ = { Phase: 0, Building: 1, Spot: 2, Step: 3, Walking: 4, Face: 5 } as const;
/** facing of a builder at each spot of spotAround: toward the footprint (4.8) */
const SPOT_FACING = [1, 7, 3, 5] as const;
/** go-to job data; Duty = an operator's walk back from a duty job (the original's go-to child of it, 8.5) */
const AN = { Phase: 0, Building: 1, Type: 2, Done: 3, Duty: 4 } as const;
/** news round data (8.6): the go-to child's phase, the index into the house lists, the stand, the child's target */
export const NR = { Child: 0, Index: 1, Stand: 2, Target: 3 } as const;
/** phases of the round's go-to child: none, created (plans at its first run), walking, at the door */
export const NewsChild = { None: 0, Created: 1, Walking: 2, Door: 3 } as const;
const NEWS_DONE = 0, NEWS_FAILED = -1, NEWS_INSIDE = -2;

export function newOrder(kind: BuildOrder['kind'], type: number, total: number, list: [number, number][]): BuildOrder {
  return { kind, type, T: total, R: total, list, started: 0, N: 0, step: 1, counter: 0, E: 0, d: 0, stage: -1, builders: [] };
}

