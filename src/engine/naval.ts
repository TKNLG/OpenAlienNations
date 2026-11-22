// Add-on (Gold Edition mission pack) gameplay: ships, islands, boarding and unloading, the
// sail-to-coast job, fishing, docking at harbours and the computer players' naval planner.
// Spec: docs/game/addon.md (section numbers below); integration:
// docs/architecture/integration-addon-gameplay.md.
//
// Everything here is inert outside add-on mode (World.addon false): no ship types exist in the
// base rule tables, the island grid is absent and the planner is never started.
//
// Ships are ordinary units with behaviour class 14. They move on their own passability grid
// (World.shipBlocked: everything but open sea, plus buildings and nature objects, 2.3) and never
// enter anything: docking at a harbour (5.8) is a door-queue turn without leaving the cell.
// Passengers of a transport ship have `inside` = the ship's id and are listed in the ship's
// `passengers` (in boarding order, 5.1).

import type { Job } from './scheduler.ts';
import type { World, Entity } from './world.ts';
import { ring } from './ai-defs.ts';

export const NJ = {
  /** go to a transport ship and board it (go-to job 0x07 with the transport branch, 5.2) */
  Board: 0x07,
  /** leave a ship (leave job 0x0D, ship branch 5.3) */
  LeaveShip: 0x0d,
  /** fishing (6.2) */
  Fishing: 0x3a,
  /** sail to coast (5.4) */
  Sail: 0x3b,
  /** computer players' naval planner (8.4), owner = race */
  Planner: 0x3d,
  /** wait for a ship (8.4): only returns 500 */
  Wait: 0x3e,
} as const;
const NAVAL_KINDS = new Set<number>(Object.values(NJ));
export const isNavalJob = (kind: number) => NAVAL_KINDS.has(kind);

/** behaviour classes (odb +0xC0, 1.1) */
export const SHIP_CLASS = 14, FISH_CLASS = 15;
export const ShipType = { Fishing: 64, Light: 65, Heavy: 66, Transport: 67 } as const;
export const HARBOUR = 62, SHIPYARD = 63;
/** reservation group of the planner's ships (8.4, `00471fd0`) */
export const NAVAL_GROUP = 61;
/** record flag 0x40: trader (merchants, transport ships; 1.2) */
export const TRADER_FLAG = 0x40;
/** per-type tables of an add-on game (10.1) */
export const ADDON_TYPES = 68;

const SUBCELL = 256;
const KIND_UNIT = 0, KIND_BUILDING = 1, KIND_NATURE = 2;
const ACT_WALK = 0, ACT_WORK = 2, ACT_IDLE = 3;
const FOOD = 4;

/** the go-to target chooser's orthogonal candidates after the cell itself: N, W, S, E (units-and-jobs.md 4.8) */
const GOTO4: readonly [number, number][] = [[0, -1], [-1, 0], [0, 1], [1, 0]];

/** the 20 "near" cells of a ship (2.4, table 0x4BCD30), in the original's order */
export const NEAR20: readonly [number, number][] = [
  [-1, 0], [-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1],
  [-1, 2], [0, 2], [1, 2], [-1, -2], [0, -2], [1, -2], [2, -1], [2, 0], [2, 1], [-2, 0], [-2, 1], [-2, -1],
];

/**
 * Gold executable behaviour that differs from the GOG `AN.exe` (10) and the add-on's fidelity
 * switches (12). `World` resolves every field: defaults are the GOG behaviour in base missions and
 * the Gold behaviour in add-on missions.
 */
export interface GoldOptions {
  /** worn paths by unit record flag 0x80 instead of the type list (10.1, all modes in Gold) */
  pathFlag: boolean;
  /** respawn rejects class-0 cells: meadow in base mode, beach and paths in add-on mode (10.2) */
  class0Respawn: boolean;
  /** the AI economy job is skipped while the town capacity is 0 (10.4) */
  aiCapacitySkip: boolean;
  /** the shipyard tops up its own missing goods when placed (3.5) */
  shipyardTopUp: boolean;
  /** each fish is caught twice (6.2 quirk) */
  fishTwice: boolean;
  /** right-click of a fishing boat on a fish starts the original's endless harvest loop (6.3);
   *  false: it starts the fishing job on that fish */
  fishHarvestBug: boolean;
  /** units of any race may board any transport ship (5.2 quirk) */
  foreignBoarding: boolean;
}

export function goldDefaults(addon: boolean): GoldOptions {
  return {
    pathFlag: addon, class0Respawn: addon, aiCapacitySkip: addon, shipyardTopUp: addon,
    fishTwice: true, fishHarvestBug: false, foreignBoarding: true,
  };
}

/** sail-to-coast job data (5.4): target island, given cell, landing cell, flag, walking (slot 7 unused since v20) */
const SA = { Island: 0, GX: 1, GY: 2, LX: 3, LY: 4, LandSet: 5, Walking: 6, Size: 8 } as const;
/**
 * fishing job data (6.2): fish, grounds, phase, walking (1 under way, 2 child made but not started),
 * harbour, (unused), started (the search ran), the fish's record id (its catch, 6.2 "Catch")
 */
const FI = { Fish: 0, GX: 1, GY: 2, Phase: 3, Walking: 4, Harbour: 5, WX: 6, WY: 7, Started: 8, FishOid: 9, Size: 10 } as const;
/** boarding job data (5.2): ship, phase (BP), walk target, asked (the first door request was made) */
const BO = { Ship: 0, Phase: 1, TX: 2, TY: 3, Asked: 4, Size: 5 } as const;
/** boarding phases: choose the cell, walking there, turning, at the door, the admitted unit's last walk */
const BP = { Choose: 0, Walk: 1, Turn: 2, Knock: 3, Enter: 4 } as const;

// ---------------------------------------------------------------- planner state (8.4)

export interface PlannerShip { id: number; state: number; req: number; counter: number; timer: number; }
export interface PlannerRequest {
  id: number; state: number; px: number; py: number; dx: number; dy: number;
  /** units still waiting to be sent to a ship, in list order */
  waiting: number[];
  goods: number;
  /** waiting units that left the world: id, last x, last y (the boarding step still re-aims the ship there, 8.4) */
  gone?: number[];
}
export interface Planner {
  race: number;
  job: number;
  /** the nation's transport ships by id (ascending) */
  ships: PlannerShip[];
  requests: PlannerRequest[];
  nextReq: number;
  /** per type: existing ungrouped ships to take over (+0x54) / to have trained (+0x164) */
  claim: number[];
  build: number[];
}
export interface NavalSnapshot { planners: (Planner | null)[] }

export class Naval {
  private w: World;
  /** connected bodies of open sea (4-connected on the torus, static terrain), 0 = not open sea */
  readonly seaComp: Int32Array;
  planners: (Planner | null)[] = [null, null, null];
  /** resolved goal of the last successful ship walk (jobs that test arrival read it) */
  private goal: [number, number] = [0, 0];

  constructor(w: World) {
    this.w = w;
    this.seaComp = w.addon ? labelSea(w) : new Int32Array(0);
  }

  // ---------------------------------------------------------------- basics

  private m(v: number): number { return v & (this.w.size - 1); }
  private idx(x: number, y: number): number { return (this.m(y) << this.w.bits) | this.m(x); }
  cellOf(e: Entity): [number, number] { return [Math.floor(e.x / SUBCELL), Math.floor(e.y / SUBCELL)]; }
  private dist(ax: number, ay: number, bx: number, by: number): number { return this.w.logistics.dist(ax, ay, bx, by); }
  private type(e: Entity): number { return e.oid & 0xffff; }
  private race(e: Entity): number { return e.oid >>> 16; }

  isShip(e: Entity): boolean { return e.kind === KIND_UNIT && this.w.rules.get(e.oid)?.cls === SHIP_CLASS; }
  /** passenger capacity (record +0xDC) of a ship; 0 for everything else */
  capacity(e: Entity): number { return this.isShip(e) ? Math.max(0, this.w.rules.get(e.oid)?.garrison ?? 0) : 0; }
  isFish(e: Entity): boolean { return e.kind === KIND_NATURE && this.w.rules.get(e.oid)?.cls === FISH_CLASS; }
  isTrader(e: Entity): boolean { return e.kind === KIND_UNIT && (this.type(e) === 28 || ((this.w.rules.get(e.oid)?.flags ?? 0) & TRADER_FLAG) !== 0); }

  /** island id of a cell (2.4); 0 for water and on base maps */
  island(x: number, y: number): number { return this.w.island ? this.w.island[this.idx(x, y)] : 0; }
  islandOf(e: Entity): number { const [x, y] = this.cellOf(e); return this.island(x, y); }
  /** open sea, not land and not coastal water (terrain only) */
  isSea(x: number, y: number): boolean { return this.seaComp.length > 0 && this.seaComp[this.idx(x, y)] > 0; }
  /** a ship may stand here and path through (mask 0xA01C, objects included) */
  shipFree(x: number, y: number): boolean { return this.w.addon && this.w.shipBlocked[this.idx(x, y)] === 0; }
  /** terrain water (flag 0x20): open sea or coastal water */
  isWater(x: number, y: number): boolean { return this.w.terrain.cls[this.idx(x, y)] === 11; }

  /** the first of the 20 near cells of (x, y) on island `isl` (2.4, `00485cf0`) */
  nearIsland(x: number, y: number, isl: number): [number, number] | null {
    if (isl === 0) return null;
    for (const [dx, dy] of NEAR20) if (this.island(x + dx, y + dy) === isl) return [this.m(x + dx), this.m(y + dy)];
    return null;
  }

  /**
   * Site-search ring walk (`0044ed90`, world-populate.md 2.3): the centre, then rings outward;
   * scale 2 above radius 15; stops after the corner of the first ring with h x s >= R.
   */
  siteSearch(cx: number, cy: number, R: number, test: (x: number, y: number) => boolean): [number, number] | null {
    if (test(this.m(cx), this.m(cy))) return [this.m(cx), this.m(cy)];
    const s = R > 15 ? 2 : 1;
    for (let h = 1; ; h++) {
      if (h * s >= R) { const x = this.m(cx + h), y = this.m(cy - h); return test(x, y) ? [x, y] : null; }
      for (const [x, y] of ring(cx, cy, h)) if (test(this.m(x), this.m(y))) return [this.m(x), this.m(y)];
    }
  }

  /** nearest-cell spiral (`004853c0`): centre first, then rings 1..R in ring order */
  spiral(cx: number, cy: number, R: number, test: (x: number, y: number) => boolean): [number, number] | null {
    for (let h = 0; h <= R; h++) for (const [x, y] of ring(cx, cy, h)) if (test(this.m(x), this.m(y))) return [this.m(x), this.m(y)];
    return null;
  }

  /** cells holding a unit standing outside (ships included), for the "no unit" tests */
  private unitCells(except?: Entity): Set<number> {
    const s = new Set<number>();
    for (const e of this.w.entities) {
      if (e.kind !== KIND_UNIT || e.inside >= 0 || e === except) continue;
      const [x, y] = this.cellOf(e);
      s.add(this.idx(x, y));
    }
    return s;
  }

  // ---------------------------------------------------------------- ship movement (2.3, 4.1)

  /**
   * Plan a ship's walk to an object or point (go-to target chooser `00485dc0` + follow path 0x06
   * with the ship mask). A land destination fails at once (2.5: the ship's island is 0). A water
   * cell the ship may not use is replaced like every go-to target: the cell, then its four
   * orthogonal neighbours (N, W, S, E), then the nearest usable cell of an unlimited spiral, of any
   * sea body; a cell in another sea body than the ship's fails at once (the planner would fail).
   */
  walkShip(e: Entity, x: number, y: number): boolean {
    const w = this.w;
    let gx = this.m(x), gy = this.m(y);
    if (this.island(gx, gy) !== 0) return false;
    if (w.shipBlocked[this.idx(gx, gy)]) {
      const c = GOTO4.map(([dx, dy]) => [this.m(gx + dx), this.m(gy + dy)] as [number, number]).find(([px, py]) => w.shipBlocked[this.idx(px, py)] === 0)
        ?? this.spiral(gx, gy, w.size >> 1, (px, py) => w.shipBlocked[this.idx(px, py)] === 0);
      if (!c) return false;
      [gx, gy] = c;
    }
    return this.followShip(e, gx, gy);
  }

  /**
   * Follow path (0x06) of a ship to exactly (x, y), with no target chooser (the sail-to-coast and
   * fishing children, 5.4, 6.2). The goal is never blocked in planning, so a blocked goal (coastal
   * water, a fish) is approached and the walk ends next to it by the arrival tolerance (a success,
   * `units-and-jobs.md` 4.1). A goal of open sea in another body fails at once.
   */
  followShip(e: Entity, x: number, y: number): boolean {
    const w = this.w;
    const [cx, cy] = this.cellOf(e);
    const gx = this.m(x), gy = this.m(y);
    if (this.island(gx, gy) !== 0) return false;
    const comp = this.seaComp[this.idx(cx, cy)], gc = this.seaComp[this.idx(gx, gy)];
    if (comp > 0 && gc > 0 && gc !== comp) return false;
    this.goal = [gx, gy];
    if (cx === gx && cy === gy) { w.setPath(e, null, gx, gy); return true; }
    // the original planner with the ship grid and the ship's step times (units-and-jobs.md 4.1.1)
    const path = w.plan(e, cx, cy, gx, gy);
    if (!path) return false;
    w.setPath(e, path, gx, gy);
    if (e.path && e.action !== ACT_WALK) { e.action = ACT_WALK as Entity['action']; e.actionTick = w.tick; }
    return true;
  }

  /** the cell a ship's last successful walk heads for */
  lastGoal(): [number, number] { return [this.goal[0], this.goal[1]]; }

  /** firing position for a ship (combat 7: the attacker's own mask): nearest usable sea cell to the target, up to the weapon range */
  approach(e: Entity, tx: number, ty: number, range: number): boolean {
    if (this.shipFree(tx, ty)) return this.walkShip(e, tx, ty);
    const comp = this.seaComp[this.idx(...this.cellOf(e))];
    const c = this.spiral(tx, ty, Math.max(2, range), (x, y) => this.w.shipBlocked[this.idx(x, y)] === 0 && (comp === 0 || this.seaComp[this.idx(x, y)] === comp));
    return !!c && this.walkShip(e, c[0], c[1]);
  }

  /** n distinct cells for ships of a move order: spiral with the ship's blocking mask (units included) */
  shipTargets(x: number, y: number, n: number, ships: Entity[]): [number, number][] {
    const busy = this.unitCells();
    for (const s of ships) { const [sx, sy] = this.cellOf(s); busy.delete(this.idx(sx, sy)); }
    const out: [number, number][] = [];
    for (let h = 0; out.length < n && h < 24; h++) {
      for (const [px, py] of ring(x, y, h)) {
        if (out.length >= n) break;
        const i = this.idx(px, py);
        if (this.w.shipBlocked[i] || busy.has(i)) continue;
        busy.add(i);
        out.push([this.m(px), this.m(py)]);
      }
    }
    return out;
  }

  /**
   * Put a ship on the first cell of the spiral (`004853c0`, no radius limit) that its mask 0xA01E
   * allows, units included (the shipyard launch at the leave job's run 5, 3.4; map ships)
   */
  placeShip(e: Entity, x: number, y: number): void {
    const busy = this.unitCells(e);
    const c = this.spiral(x, y, this.w.size >> 1, (px, py) => this.w.shipBlocked[this.idx(px, py)] === 0 && !busy.has(this.idx(px, py))) ?? [this.m(x), this.m(y)];
    this.w.teleport(e, c[0], c[1]);
    this.w.halt(e);
  }

  // ---------------------------------------------------------------- jobs

  runJob(job: Job): number {
    switch (job.kind) {
      case NJ.Board: return this.runBoard(job);
      case NJ.LeaveShip: return this.runLeaveShip(job);
      case NJ.Sail: return this.runSail(job);
      case NJ.Fishing: return this.runFishing(job);
      case NJ.Planner: return this.runPlanner(job);
      case NJ.Wait: return this.w.get(job.owner)?.job === job.id ? 500 : 0;
      default: return 0;
    }
  }

  /** a unit's job is over: resume a job suspended behind it (like every unit job) */
  private finish(u: Entity | undefined): number {
    if (!u) return 0;
    u.job = 0; u.ordered = false;
    return this.w.combat.endUnitJob(u);
  }

  // ---------------------------------------------------------------- boarding (5.1, 5.2)

  /** container "may enter" (`0046b5c0`): room left and the entrant is not a ship; no race test */
  mayEnter(ship: Entity, u: Entity): boolean {
    if (!this.isShip(ship) || this.isShip(u) || !ship.alive) return false;
    if (!this.w.gold.foreignBoarding && this.race(u) !== this.race(ship)) return false;
    return ship.passengers.length < this.capacity(ship);
  }

  /** right-click of an own unit on a transport ship that it did not attack (5.2); true if handled */
  boardOrder(u: Entity, target: Entity): boolean {
    if (!this.w.addon || this.capacity(target) <= 0 || this.isShip(u) || u.inside >= 0) return false;
    if (!this.mayEnter(target, u)) return false;
    this.startBoard(u, target, 1, true);
    return true;
  }

  /**
   * A go-to job at a transport ship (5.2). The job is set directly (the player's order, the
   * planner's boarding step): the old job is cancelled, nobody is ejected and +0x78 is kept (5.1).
   * Making the job re-aims the ship (go-to constructor): see `reaim`. `player`: a player order.
   */
  startBoard(u: Entity, ship: Entity, delay: number, player = false): void {
    const d = new Array<number>(BO.Size).fill(0);
    d[BO.Ship] = ship.id;
    this.setJob(u, NJ.Board, delay, d);
    u.ordered = player;
    const [ux, uy] = this.cellOf(u);
    this.reaim(ship, ux, uy);
  }

  /**
   * The go-to constructor's re-aim (5.2): a transport ship's current job is cancelled and it sails
   * to the coast of the unit's island (0x3B toward the unit's cell, first run after 1 tick). Also
   * on a foreign ship (quirk) and for a dead unit's last cell (8.4).
   */
  private reaim(ship: Entity, x: number, y: number): void {
    if (ship.alive && this.type(ship) === ShipType.Transport) this.startSail(ship, x, y, 1);
  }

  /** set a unit's job directly (no eject, +0x78 kept): the old job is cancelled */
  private setJob(u: Entity, kind: number, delay: number, data: number[]): void {
    this.w.logistics.cancelJob(u);
    u.ordered = false;
    u.job = this.w.sched.create(kind, u.id, delay, data).id;
  }

  /**
   * The go-to job at a transport ship and its enter job (5.2, 5.1): walk to the shore cell near
   * the ship (failure ignored), turn, ask at the door (may-enter only at the first request), and
   * once admitted walk to the land cell nearest the ship and enter whether or not that walk
   * succeeded ("entered" admits while passengers <= capacity: a sixth passenger, quirk).
   */
  private runBoard(job: Job): number {
    const u = this.w.get(job.owner), d = job.data;
    if (!u || !u.alive || u.job !== job.id) return 0;
    const ship = this.w.get(d[BO.Ship]);
    if (!ship || !ship.alive || u.inside >= 0) { this.leaveQueue(ship, u); return this.finish(u); }
    const [sx, sy] = this.cellOf(ship);
    switch (d[BO.Phase]) {
      case BP.Choose: {
        const c = this.nearIsland(sx, sy, this.islandOf(u)) ?? this.landingOf(ship);
        if (!c) return 5;   // no shore cell next to the ship: wait (5.2 step 2)
        d[BO.TX] = c[0]; d[BO.TY] = c[1];
        // the walk's result is not read: a walk that cannot even start goes straight to the door
        d[BO.Phase] = this.w.logistics.walkToCell(u, c[0], c[1]) ? BP.Walk : BP.Turn;
        return 1;
      }
      case BP.Walk:
        if (u.path) return 1;
        d[BO.Phase] = BP.Turn;
        return 1;
      case BP.Turn: {
        const t = this.w.turnToward(u, sx, sy);
        if (t) return t;
        d[BO.Phase] = BP.Knock;
        return 1;
      }
      case BP.Knock: {
        // request entry (`0046b3d0`): the may-enter test only at the first request
        // entries leave the queue with their enter job (its destructor `004844e0`): ours keeps only
        // units still on a boarding job at this ship
        ship.doorQueue = ship.doorQueue.filter(id => {
          const x = this.w.get(id), j = x?.job ? this.w.sched.get(x.job) : undefined;
          return !!x && x.alive && !!j && !j.cancelled && j.kind === NJ.Board && j.data[BO.Ship] === ship.id;
        });
        if (!d[BO.Asked] && !ship.doorQueue.includes(u.id)) {
          if (!this.mayEnter(ship, u)) return this.finish(u);   // refused: the go-to fails
          ship.doorQueue.push(u.id);
        }
        d[BO.Asked] = 1;
        if (ship.doorQueue[0] !== u.id) return 10;
        const [ux, uy] = this.cellOf(u);
        const computer = !!this.w.economy.players[ship.owner]?.computer;
        // a human player's ship: the head waits at the door until it is closer than 4
        if (!computer && this.dist(ux, uy, sx, sy) >= 4) return 10;
        // admitted: walk to the land cell nearest the ship (spiral, planning mask: units ignored)
        const c = this.spiral(sx, sy, this.w.size >> 1, (x, y) => this.w.blocked[this.idx(x, y)] === 0);
        if (c && (c[0] !== ux || c[1] !== uy)) this.w.follow(u, c[0], c[1], 0, 5);
        d[BO.Phase] = BP.Enter;
        return 5;
      }
      default: {
        if (u.path) return 1;
        this.embark(u, ship);
        this.leaveQueue(ship, u);
        return this.finish(u);
      }
    }
  }

  /** "entered" (`0046b5f0`): the unit is inside the ship while passengers <= capacity; false: not taken in */
  embark(u: Entity, ship: Entity): boolean {
    if (ship.passengers.length > this.capacity(ship)) return false;
    u.inside = ship.id;
    ship.passengers.push(u.id);
    this.w.halt(u);
    this.w.motion.vacate(u);
    u.action = ACT_IDLE as Entity['action']; u.actionTick = this.w.tick;
    return true;
  }

  private leaveQueue(ship: Entity | undefined, u: Entity): void {
    if (ship && ship.doorQueue.length) ship.doorQueue = ship.doorQueue.filter(id => id !== u.id);
  }

  /** the landing cell of a ship's sail-to-coast job, when it has one (5.2 step 2) */
  private landingOf(ship: Entity): [number, number] | null {
    const j = ship.job ? this.w.sched.get(ship.job) : undefined;
    if (!j || j.cancelled || j.kind !== NJ.Sail || !j.data[SA.LandSet]) return null;
    return [j.data[SA.LX], j.data[SA.LY]];
  }

  // ---------------------------------------------------------------- unloading (5.3)

  /**
   * "Send out" (`00457b70`, AUSSTEIGEN): every passenger of type `type` (-1 = all) is ejected.
   */
  unload(ship: Entity, type = -1): number {
    let n = 0;
    for (const id of [...ship.passengers]) {
      const p = this.w.get(id);
      if (!p || (type >= 0 && this.type(p) !== type)) continue;
      this.eject(p, ship);
      n++;
    }
    return n;
  }

  /**
   * The ship's eject (`0046b8c0`, 5.1): off the passenger list, a leave job whose first run comes
   * 10 ticks later, the current job waiting behind it (5 ticks blocked). Every way out of a ship
   * goes through here (5.3).
   */
  eject(p: Entity, ship: Entity): void {
    ship.passengers = ship.passengers.filter(x => x !== p.id);
    if (p.job) this.w.combat.suspend(p);
    p.job = this.w.sched.create(NJ.LeaveShip, p.id, 10, [ship.id]).id;
  }

  /** unloading cell test (`00484a30`): land, no unit / building / nature; a jobless unit standing there is told to step aside */
  private unloadOk(u: Entity, x: number, y: number, units: Map<number, Entity>): boolean {
    const i = this.idx(x, y), w = this.w;
    if (this.isWater(x, y)) return false;
    const v = units.get(i);
    if (v) {
      if (v !== u && this.w.motion.isIdle(v)) this.w.motion.push(v, u, [i]);
      return false;
    }
    return w.blocked[i] === 0 && w.natureAt[i] === 0 && w.buildingCells[i] === 0;
  }

  /**
   * Leave job, ship branch (5.3): every run, the nearest land cell within 5 of the ship; found: the
   * passenger is put there (place method `0046b770`: facing 5) and a job behind the leave job
   * resumes. Not found: a ship without a job sails toward the nearest cell the passenger could
   * stand on; poll again after 50 ticks. A passenger is never put on water.
   */
  private runLeaveShip(job: Job): number {
    const u = this.w.get(job.owner);
    if (!u || u.job !== job.id) return 0;
    const ship = this.w.get(job.data[0]);
    if (u.inside !== job.data[0]) return this.finish(u);
    if (!ship || !ship.alive) { this.w.combat.die(u); return 0; }
    const [sx, sy] = this.cellOf(ship);
    const units = new Map<number, Entity>();
    for (const e of this.w.entities) if (e.kind === KIND_UNIT && e.inside < 0 && e.alive) { const [x, y] = this.cellOf(e); units.set(this.idx(x, y), e); }
    const c = this.siteSearch(sx, sy, 5, (x, y) => this.unloadOk(u, x, y, units));
    if (c) {
      u.inside = -1;
      this.w.teleport(u, c[0], c[1]);
      this.w.halt(u);
      u.dir = 5;
      u.action = ACT_IDLE as Entity['action']; u.actionTick = this.w.tick;
      this.w.wearPath(u, c[0], c[1]);
      return this.finish(u);
    }
    // no land in reach: the idle ship sails to the nearest cell the passenger could stand on
    // (spiral with the passenger's mask 0x3E: no water, unit, building or nature; no radius limit)
    if (!ship.job) {
      const s = this.spiral(sx, sy, this.w.size >> 1, (x, y) => !this.isWater(x, y) && this.w.blocked[this.idx(x, y)] === 0 && !units.has(this.idx(x, y)));
      if (s) this.startSail(ship, s[0], s[1], 1);
    }
    return 50;
  }

  // ---------------------------------------------------------------- sail to coast (0x3B, 5.4)

  startSail(ship: Entity, x: number, y: number, delay: number): void {
    const d = new Array<number>(SA.Size).fill(0);
    d[SA.Island] = this.island(x, y); d[SA.GX] = this.m(x); d[SA.GY] = this.m(y);
    this.w.logistics.assign(ship, NJ.Sail, delay, d);
  }

  /** `0044cb40`: water, no unit / building / nature, a near cell on the island (coastal water allowed) */
  private coastOk(x: number, y: number, isl: number, units: Set<number>): boolean {
    const i = this.idx(x, y);
    if (!this.isWater(x, y) || units.has(i) || this.w.buildingCells[i] || this.w.natureAt[i]) return false;
    return !!this.nearIsland(x, y, isl);
  }

  /**
   * Sail to coast (0x3B, 5.4). Step 1: a near cell on the target island ends the job. Step 2: a
   * sea cell with a near cell on the island (ring search 32, `0044cb40`; coastal water allowed),
   * else the first cell of an unlimited spiral around the given cell that the ship mask 0xA01E
   * allows (units included); a follow path to exactly that cell. When it ends: failure fails the
   * job, success returns 1 and step 1 runs again. No round limit.
   */
  private runSail(job: Job): number {
    const ship = this.w.get(job.owner), d = job.data;
    if (!ship || !ship.alive || ship.job !== job.id) return 0;
    if (d[SA.Walking]) {
      if (ship.path) return 1;
      d[SA.Walking] = 0;
      // the follow-path child ended: a coastal landing cell ends it next to the cell, a success
      if (!this.w.walkOk(ship)) return this.finish(ship);
      return 1;
    }
    const [sx, sy] = this.cellOf(ship);
    // step 1: a near cell on the target island is the landing cell: done
    const near = this.nearIsland(sx, sy, d[SA.Island]);
    if (near) { d[SA.LX] = near[0]; d[SA.LY] = near[1]; d[SA.LandSet] = 1; return this.finish(ship); }
    // step 2
    const units = this.unitCells(ship);
    const c = this.siteSearch(sx, sy, 32, (x, y) => this.coastOk(x, y, d[SA.Island], units)) ??
      this.spiral(d[SA.GX], d[SA.GY], this.w.size >> 1, (x, y) => this.shipFree(x, y) && !units.has(this.idx(x, y)));
    if (!c) return this.finish(ship);
    d[SA.LX] = c[0]; d[SA.LY] = c[1]; d[SA.LandSet] = 1;
    if (!this.followShip(ship, c[0], c[1])) return this.finish(ship);
    d[SA.Walking] = 1;
    return 2;
  }

  // ---------------------------------------------------------------- fishing (0x3A, 6)

  /**
   * The fishing job with grounds (x, y) (move order 6.1, AI 8.3), or on a fish (`fish`); replaces
   * the current job. As in the original's constructors the search (6.2), with its rand() draws and
   * the creation of the path child, runs now; the child starts walking at the job's first run.
   */
  startFishing(boat: Entity, x: number, y: number, delay: number, fish = 0): void {
    const d = new Array<number>(FI.Size).fill(0);
    d[FI.Fish] = fish; d[FI.GX] = this.m(x); d[FI.GY] = this.m(y);
    this.fishSearch(d);
    d[FI.Started] = 1;
    this.w.logistics.assign(boat, NJ.Fishing, delay, d);
  }

  /** search predicate (`00482f30`): a fish type, existing, with amount not all reserved */
  private catchable(e: Entity | undefined): e is Entity {
    if (!e || this.w.get(e.id) !== e || e.kind !== KIND_NATURE) return false;
    const t = this.type(e);
    return (e.oid >>> 16) === 6 && t >= 41 && t <= 45 && e.amount !== e.reserved;
  }

  /**
   * The fish search (`004834e0`): with no fish, or one that is gone, a fish within 10 rings of the
   * grounds; else up to 10 random cells around the grounds (two rand() each, x first), the first
   * water cell becoming the new grounds. A fish found moves the grounds to its cell. Then the
   * follow-path child to the grounds is made (it starts at the job's next run); phase 0.
   */
  private fishSearch(d: number[]): void {
    let fish = d[FI.Fish] ? this.w.get(d[FI.Fish]) : undefined;
    if (!fish) {
      fish = undefined; d[FI.Fish] = 0;
      const byCell = new Map<number, Entity>();
      for (const e of this.w.entities) if (e.kind === KIND_NATURE && this.catchable(e)) {
        const [x, y] = this.cellOf(e), i = this.idx(x, y);
        if (!byCell.has(i)) byCell.set(i, e);
      }
      const c = this.spiral(d[FI.GX], d[FI.GY], 10, (x, y) => byCell.has(this.idx(x, y)));
      if (c) fish = byCell.get(this.idx(c[0], c[1]));
    }
    if (!fish) {
      for (let k = 0; k < 10; k++) {
        const x = this.m(d[FI.GX] + 4 - (this.w.rand.next() % 9));
        const y = this.m(d[FI.GY] + 4 - (this.w.rand.next() % 9));
        if (this.isWater(x, y)) { d[FI.GX] = x; d[FI.GY] = y; break; }
      }
    } else {
      d[FI.Fish] = fish.id;
      d[FI.FishOid] = fish.oid;
      [d[FI.GX], d[FI.GY]] = this.cellOf(fish);
    }
    d[FI.Phase] = 0;
    d[FI.Walking] = 2;
  }

  private runFishing(job: Job): number {
    const boat = this.w.get(job.owner), d = job.data;
    if (!boat || !boat.alive || boat.job !== job.id) return 0;
    // saves before version 20: the search had not run at creation
    if (!d[FI.Started]) { d[FI.Started] = 1; this.fishSearch(d); }
    if (d[FI.Walking] === 2) {
      // the path child made by the search starts: a follow path to exactly the grounds (a fish's
      // cell or coastal water ends the walk next to it, 6.2)
      d[FI.Walking] = 0;
      if (!this.followShip(boat, d[FI.GX], d[FI.GY])) return this.endFishing(boat);
      d[FI.Walking] = 1;
      return 1;
    }
    if (d[FI.Walking]) {
      if (boat.path) return 1;
      d[FI.Walking] = 0;
      // the child ended with failure: the job fails
      if (d[FI.Phase] === 2) {
        const h = this.w.get(d[FI.Harbour]);
        if (!h || !h.alive || !this.dockRange(boat, h)) return this.endFishing(boat);
      } else if (!this.w.walkOk(boat)) return this.endFishing(boat);
    }
    switch (d[FI.Phase]) {
      case 0: {
        // the fish is set and still in the world (its alive byte)
        const fish = d[FI.Fish] ? this.w.get(d[FI.Fish]) : undefined;
        if (fish) {
          this.w.face(boat, ...this.cellOf(fish));
          boat.action = ACT_WORK as Entity['action']; boat.actionTick = this.w.tick;
          d[FI.Phase] = 1;
          return 50 + (this.w.rand.next() % 50);
        }
        // a new search; its child starts at the next run, 50 ticks later
        this.fishSearch(d);
        return 50;
      }
      case 1: return this.fishCatch(boat, d);
      case 2: {
        // docked at the harbour: the transport child drops the catch into the town stock
        const h = this.w.get(d[FI.Harbour]);
        if (!h || !h.alive) return this.endFishing(boat);
        // the transport child's first request at the door: "stores full" when the town has no room
        // for the catch (may-enter test, side-panel.md 1.1.6 (a)); docking goes on
        if (!h.doorQueue.includes(boat.id)) this.w.logistics.storesFullAtDoor(boat, h, true);
        if (!this.dock(boat, h)) return 10;
        this.dropCargo(boat, h);
        // the harbour has ejected the boat (`dock`): held 35 ticks by the leave job (5.8); the
        // transport child has ended, so the phase-2 step runs now: stop fishing, a new search (its
        // walk waits for the leave job)
        if (boat.action === ACT_WORK) { boat.action = ACT_IDLE as Entity['action']; boat.actionTick = this.w.tick; }
        this.fishSearch(d);
        return 1;
      }
      default: return this.endFishing(boat);
    }
  }

  /** fishing phase for the status line (6.2): 0 T327 "to the fishing grounds", 1 T328 "fishing", 2 delivering; -1 not fishing */
  fishingPhase(boat: Entity): number {
    const j = boat.job ? this.w.sched.get(boat.job) : undefined;
    return j && !j.cancelled && j.kind === NJ.Fishing ? j.data[FI.Phase] : -1;
  }

  private endFishing(boat: Entity): number {
    if (boat.action === ACT_WORK) { boat.action = ACT_IDLE as Entity['action']; boat.actionTick = this.w.tick; }
    return this.finish(boat);
  }

  /**
   * Catch (6.2), with no test of the fish: the fish record's amount is added to the load and the
   * fish's die is called (a living fish only loses its living flag, see GoldOptions.fishTwice; one
   * already removed is not touched). Every boat holding the fish catches it.
   */
  private fishCatch(boat: Entity, d: number[]): number {
    boat.action = ACT_IDLE as Entity['action']; boat.actionTick = this.w.tick;
    const fish = d[FI.Fish] ? this.w.get(d[FI.Fish]) : undefined;
    const oid = fish ? fish.oid : (d[FI.FishOid] ?? 0);
    const r = oid ? this.w.rules.get(oid) : undefined;
    if (!r) {
      // a save before version 20 whose fish is gone: nothing known to catch, search again
      this.fishSearch(d);
      return 50;
    }
    boat.carryGood = r.product ?? FOOD;
    boat.carryAmount += Math.max(0, r.amount ?? fish?.amount ?? 0);
    d[FI.Fish] = 0;
    if (fish) {
      if (fish.alive && this.w.gold.fishTwice) fish.alive = false;
      else this.w.removeEntity(fish);
    }
    d[FI.Phase] = 2;
    const h = this.harbourOf(boat);
    if (!h) return this.finish(boat);   // no harbour: the job fails, the boat keeps its load
    d[FI.Harbour] = h.id;
    if (!this.walkShip(boat, ...this.w.logistics.entrance(h))) return this.endFishing(boat);
    d[FI.Walking] = 1;
    return 1;
  }

  /** the town's harbour nearest to the unit, any state (`00460db0`) */
  harbourOf(u: Entity): Entity | null {
    const [x, y] = this.cellOf(u);
    let best: Entity | null = null, bd = Infinity;
    for (const b of this.w.entities) {
      if (b.kind !== KIND_BUILDING || b.town !== u.town || this.type(b) !== HARBOUR || this.race(b) !== this.race(u) || !b.alive) continue;
      const [hx, hy] = this.cellOf(b);
      const dd = this.dist(x, y, hx, hy);
      if (dd < bd) { best = b; bd = dd; }
    }
    return best;
  }

  // ---------------------------------------------------------------- docking (5.8)

  /** close enough to dock: the original has no distance test, we accept 6 cells around the footprint */
  dockRange(ship: Entity, b: Entity): boolean {
    const r = this.w.rules.get(b.oid);
    const [bx, by] = this.cellOf(b), [x, y] = this.cellOf(ship);
    const sx = Math.max(1, r?.sizeX || 2), sy = Math.max(1, r?.sizeY || 2), n = this.w.size;
    const wd = (d: number) => (d > n / 2 ? d - n : d < -n / 2 ? d + n : d);
    const dx = wd(x - bx), dy = wd(y - by);
    const ox = dx > 0 ? dx : dx < -(sx - 1) ? -(sx - 1) - dx : 0;
    const oy = dy > 0 ? dy : dy < -(sy - 1) ? -(sy - 1) - dy : 0;
    return Math.max(ox, oy) <= 6;
  }

  /**
   * The building's door queue for a ship: true when it is its turn (docked: the caller moves the
   * goods now). The ship never leaves its cell; the harbour ejects it at once, so its current job
   * waits behind a 35-tick leave job (5.8, `dockHold`).
   */
  dock(ship: Entity, b: Entity): boolean {
    b.doorQueue = b.doorQueue.filter(id => { const x = this.w.get(id); return !!x && x.job !== 0; });
    if (!b.doorQueue.includes(ship.id)) b.doorQueue.push(ship.id);
    if (b.doorQueue[0] !== ship.id) return false;
    b.doorQueue.shift();
    b.doorTick = this.w.tick;
    this.w.halt(ship);
    this.dockHold(ship, b);
    return true;
  }

  /**
   * The harbour ejects a docked ship (5.8): the building's leave job (first run 10 ticks later,
   * data flag 3 = docked) holds it 35 ticks with its current job waiting behind (blocked 5); the
   * ship keeps its cell (Logistics.runLeave).
   */
  dockHold(ship: Entity, b: Entity): void {
    if (ship.job) this.w.combat.suspend(ship);
    ship.job = this.w.sched.create(NJ.LeaveShip, ship.id, 10, [b.id, 0, 0, 1]).id;
  }

  /** transport drop at a harbour: everything goes into the town stock, clamped (3.3) */
  dropCargo(ship: Entity, b: Entity): void {
    if (ship.carryAmount <= 0) return;
    this.w.logistics.deliver(b, ship.carryGood, ship.carryAmount);
    ship.carryAmount = 0; ship.carryGood = -1;
  }

  // ---------------------------------------------------------------- deaths

  /** a unit leaves the world: a ship takes everyone on board with it (5.1), the planner forgets it */
  unitGone(e: Entity): void {
    if (!this.w.addon) return;
    // a unit waiting for a planner's ship: its last cell is kept for the boarding step (8.4)
    for (const pl of this.planners) if (pl) for (const r of pl.requests) {
      if (r.state < 3 && r.waiting.includes(e.id)) { const [x, y] = this.cellOf(e); (r.gone ??= []).push(e.id, x, y); }
    }
    if (e.inside >= 0) {
      const c = this.w.get(e.inside);
      if (c && c.kind === KIND_UNIT) c.passengers = c.passengers.filter(id => id !== e.id);
    }
    if (!this.isShip(e)) return;
    const aboard = [...e.passengers];
    for (const o of this.w.entities) if (o.kind === KIND_UNIT && o.inside === e.id && !aboard.includes(o.id)) aboard.push(o.id);
    e.passengers = [];
    for (const id of aboard) {
      const p = this.w.get(id);
      if (!p || !p.alive) continue;
      p.x = e.x; p.y = e.y;
      this.w.combat.die(p);
    }
    if (e.group === NAVAL_GROUP) this.shipLost(e);
  }

  // ---------------------------------------------------------------- naval planner (0x3D, 8.4)

  /** a computer nation gets its planner next to its think job (`00462e10`), first run after 10 ticks */
  startPlanner(race: number): void {
    if (!this.w.addon || this.planners[race]) return;
    const claim = new Array<number>(ADDON_TYPES).fill(0);
    claim[ShipType.Transport] = 1;
    this.planners[race] = {
      race, job: this.w.sched.create(NJ.Planner, race, 10).id, ships: [], requests: [], nextReq: 1,
      claim, build: new Array<number>(ADDON_TYPES).fill(0),
    };
  }

  planner(race: number): Planner | null { return this.planners[race] ?? null; }

  /**
   * New transport request (`00472630`); returns its id, 0 when refused or empty. Flag 1 (the army's
   * default) is refused while the planner holds more than 50 requests; served requests are never
   * forgotten, so they count too (8.4). The idle ships are assigned at once (id order) until the
   * units and goods are covered; such a ship keeps its counter (boarding step, 8.4).
   */
  request(race: number, units: number, goods: number, px: number, py: number, dx: number, dy: number, flags = 0): number {
    const pl = this.planners[race];
    if (!pl || (units <= 0 && goods <= 0)) return 0;
    if ((flags & 1) && pl.requests.length > 50) return 0;
    const r: PlannerRequest = { id: pl.nextReq++, state: 2, px: this.m(px), py: this.m(py), dx: this.m(dx), dy: this.m(dy), waiting: [], goods };
    pl.requests.push(r);
    let n = units, g = goods;
    for (const s of pl.ships) {
      if (n <= 0 && g <= 0) break;
      const ship = this.w.get(s.id);
      if (s.state !== 1 || !ship || !ship.alive) continue;
      n = Math.max(0, n - this.capacity(ship)); g = Math.max(0, g - 5);
      s.state = 2; s.req = r.id;
      this.startSail(ship, r.px, r.py, 5);
    }
    return r.id;
  }

  /** a unit waits for a request's ship (`00471f40`): it gets the wait job 0x3E */
  addWaiting(race: number, req: number, u: Entity): void {
    const r = this.planners[race]?.requests.find(x => x.id === req);
    if (!r) return;
    if (!r.waiting.includes(u.id)) r.waiting.push(u.id);
    // set directly, like the original (no eject, +0x78 kept)
    this.setJob(u, NJ.Wait, 5, []);
  }

  /** the request still runs (not served or cancelled) */
  requestOpen(race: number, req: number): boolean {
    const r = this.planners[race]?.requests.find(x => x.id === req);
    return !!r && r.state < 3;
  }

  /**
   * Cancel a request (`00472f90`): it is removed, and every ship working for it becomes idle
   * whatever its state (a ship under way keeps its job and passengers).
   */
  cancelRequest(race: number, req: number): void {
    const pl = this.planners[race];
    if (!pl) return;
    pl.requests = pl.requests.filter(r => r.id !== req);
    for (const s of pl.ships) if (s.req === req) s.state = 1;
  }

  /**
   * Register a ship with the planner (`00471fd0`): build count first, else claim; group 61, idle,
   * counter 100. The ship's current job is left running (8.4).
   */
  registerShip(race: number, ship: Entity): boolean {
    const pl = this.planners[race];
    if (!pl || ship.group !== 0) return false;
    const t = this.type(ship);
    if (pl.build[t] > 0) pl.build[t]--;
    else if (pl.claim[t] > 0) pl.claim[t]--;
    else return false;
    ship.group = NAVAL_GROUP;
    pl.ships.push({ id: ship.id, state: 1, req: 0, counter: 100, timer: 0 });
    pl.ships.sort((a, b) => a.id - b.id);
    return true;
  }

  /** a group-61 ship died (`00472160`): dropped; the next free ship of its type is taken over */
  private shipLost(e: Entity): void {
    const pl = this.planners[e.owner];
    if (!pl) return;
    pl.ships = pl.ships.filter(s => s.id !== e.id);
    pl.claim[this.type(e)] = 1;
  }

  private runPlanner(job: Job): number {
    const pl = this.planners[job.owner];
    if (!pl || pl.job !== job.id) return 0;
    const p = this.w.economy.players[pl.race];
    if (!p || p.defeated) return 0;
    const reqOf = (id: number) => pl.requests.find(r => r.id === id);
    // ship pass (id order); the idle list holds the ships that were idle when the pass met them
    const idle: PlannerShip[] = [];
    for (const s of pl.ships) {
      const ship = this.w.get(s.id);
      if (!ship || !ship.alive) continue;
      switch (s.state) {
        case 1:
          idle.push(s);
          break;
        case 2:
          if (!ship.job) { s.state = 3; s.timer = 0; this.boardingStep(ship, s, reqOf(s.req)); }
          break;
        case 3:
          if (++s.timer > 50) {
            s.state = 4;
            const r = reqOf(s.req);
            if (r) this.startSail(ship, r.dx, r.dy, 5);
            else this.w.logistics.cancelJob(ship);
          }
          break;
        case 4:
          if (!ship.job) { s.state = 5; s.timer = 0; this.unload(ship, -1); }
          break;
        case 5:
          if (++s.timer > 50) s.state = 1;
          break;
      }
    }
    // serve the open requests (id order), at most one idle ship each per run
    let unserved = 0;
    for (const r of pl.requests) {
      if (r.state >= 3) continue;
      // unsigned 32-bit sum and comparison: a ship with 6 aboard adds 0xFFFFFFFF (8.4, quirk)
      let free = 0;
      for (const s of pl.ships) {
        if (s.state !== 2 || s.req !== r.id) continue;
        const ship = this.w.get(s.id);
        if (ship) free = (free + this.capacity(ship) - ship.passengers.length) >>> 0;
      }
      if (free >= r.waiting.length) continue;
      const s = idle.shift();
      if (!s) { unserved++; continue; }
      s.state = 2; s.req = r.id; s.counter = 100;
      this.startSail(this.w.get(s.id)!, r.px, r.py, 5);
    }
    if (unserved > 3) { pl.build[ShipType.Transport] = unserved >> 1; pl.claim[ShipType.Transport] = unserved - (unserved >> 1); }
    else if (pl.ships.length < unserved) pl.claim[ShipType.Transport] = 1;
    // served requests stay (8.4): they count for the 50-request refusal; only a cancel removes one
    return 10;
  }

  /**
   * Boarding step (`00472940`): n = counter - passengers. Below 1 the ship leaves for the
   * destination at once. Otherwise (a counter of 100 restarts at 0) the first n entries of the
   * waiting list are sent to the ship in list order, each raising the counter, with no test of
   * the unit (8.4): every entry's go-to re-aims the ship at the unit's cell, a dead unit's last
   * cell included. Ours gives no job to a dead unit, nor to one inside a building or another ship
   * (how the original's job runs from inside is not traced); they are re-aimed at and counted.
   */
  private boardingStep(ship: Entity, s: PlannerShip, r: PlannerRequest | undefined): void {
    let n = s.counter - ship.passengers.length;
    if (n < 1) {
      s.state = 4;
      if (r) this.startSail(ship, r.dx, r.dy, 5);
      else this.w.logistics.cancelJob(ship);
      return;
    }
    if (s.counter === 100) s.counter = 0;
    if (!r) return;
    while (n > 0 && r.waiting.length) {
      const id = r.waiting.shift()!;
      const u = this.w.get(id);
      if (u && u.alive && u.inside < 0) this.startBoard(u, ship, 5);
      else if (u) this.reaim(ship, ...this.cellOf(u));
      else {
        const g = r.gone ?? [];
        for (let k = 0; k + 2 < g.length; k += 3) if (g[k] === id) { this.reaim(ship, g[k + 1], g[k + 2]); g.splice(k, 3); break; }
      }
      n--; s.counter++;
    }
    if (!r.waiting.length) { r.state = 3; delete r.gone; }
  }

  // ---------------------------------------------------------------- state

  snapshot(): NavalSnapshot { return JSON.parse(JSON.stringify({ planners: this.planners })) as NavalSnapshot; }

  restore(s: NavalSnapshot | undefined): void {
    this.planners = s ? (JSON.parse(JSON.stringify(s.planners)) as (Planner | null)[]) : [null, null, null];
  }

  /** saves before version 14: the ship counter limited nothing; it starts at 100 as on registration */
  migrateCounters(): void {
    for (const pl of this.planners) if (pl) for (const sh of pl.ships) sh.counter = 100;
  }

  /** saves before version 21: fishing jobs get the fish's record id (FI.FishOid) */
  migrateFishingJobs(): void {
    for (const j of this.w.sched.jobs()) {
      if (j.kind !== NJ.Fishing || j.cancelled) continue;
      while (j.data.length < FI.Size) j.data.push(0);
      const f = j.data[FI.Fish] ? this.w.get(j.data[FI.Fish]) : undefined;
      if (f) j.data[FI.FishOid] = f.oid;
    }
  }

  digest(mix: (v: number) => void): void {
    for (const pl of this.planners) {
      if (!pl) continue;
      mix(pl.race); mix(pl.job); mix(pl.nextReq);
      for (const s of pl.ships) { mix(s.id); mix(s.state); mix(s.req); mix(s.timer); mix(s.counter); }
      for (const r of pl.requests) {
        mix(r.id); mix(r.state); mix(r.px); mix(r.py); mix(r.dx); mix(r.dy); for (const u of r.waiting) mix(u);
        if (r.gone?.length) { mix(-3); for (const v of r.gone) mix(v); }
      }
      for (let t = 64; t < ADDON_TYPES; t++) { mix(pl.claim[t]); mix(pl.build[t]); }
    }
  }
}

// ---------------------------------------------------------------- geometry helpers

/**
 * 8-connected bodies of open sea on the torus (static terrain; buildings and fish ignored): ships
 * cut diagonal corners like units, so two open-sea cells meeting only at a corner are one body
 * (integration-addon-gameplay.md 7 "Sea bodies", fidelity audit A7)
 */
function labelSea(w: World): Int32Array {
  const n = w.size, bits = w.bits, mask = n - 1;
  const ao = (w.terrain as { aoCls?: Uint8Array }).aoCls;
  const comp = new Int32Array(n * n);
  const sea = (i: number) => (ao ? ao[i] === 9 : w.terrain.cls[i] === 11);
  let label = 0;
  const stack: number[] = [];
  for (let i = 0; i < n * n; i++) {
    if (comp[i] || !sea(i)) continue;
    label++;
    comp[i] = label;
    stack.push(i);
    while (stack.length) {
      const c = stack.pop()!;
      const x = c & mask, y = c >> bits;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const j = (((y + dy) & mask) << bits) | ((x + dx) & mask);
        if (!comp[j] && sea(j)) { comp[j] = label; stack.push(j); }
      }
    }
  }
  return comp;
}

