// Nations, towns and the town economy. Spec: docs/game/economy.md (section numbers below).
//
// Money belongs to the nation (player); towns own population, stock, needs and happiness.
// Everything periodic runs as scheduler jobs, with periods in ticks as in the original. Float
// accumulators use float32 (Math.fround) like the original, so rounding matches (8.2).

import type { Job } from './scheduler.ts';
import type { Scheduler } from './scheduler.ts';
import type { MsRand } from '../world/rand.ts';
import type { ObjectRule } from '../formats/odb.ts';
import { BuildingFlag } from '../formats/odb.ts';
import type { Goal } from '../formats/mission.ts';
import { goalCell } from '../formats/mission.ts';

const f32 = Math.fround;

/** goods indices (odb.md); luxuries are 6 + race */
export const Good = { Crop: 0, Wood: 1, Stone: 2, Food: 4 } as const;
export const GOODS = 9;
/** object types inside a race's group */
export const T = {
  Porter: 9, Founder: 10, Builder: 11, Criminal: 12, Soldier: 29,
  SmallHouse: 37, LargeHouse: 38, TownHall: 40, Warehouse: 41, Lab: 46, Library: 47, Bank: 49,
} as const;
const GOODS_GROUP = 6;

export const ROUND = 299;
export const JobKind = {
  Finance: 0x2c, Goals: 0x2d, Consumption: 1, TownStatus: 2, Research: 0x2e, House: 10,
} as const;

/** mentor (advisor) line ids used here (Mentor.tdb) */
export const Mentor = {
  LowMoney: 18, FoodScarce: 26, Famine: 27, Dissatisfied: 28, HappierFood: 42, SadderFood: 43,
  DecayMotivation: 71, NoMoney: 72,
  /** luxury needs: mentor#39..41 for goods 6..8 (5.4) */
  LuxuryNeed: 39,
} as const;

/**
 * The advisor time unit D (`DAT_004a5d7c`, economy.md 5.4, side-panel.md 1.1) in milliseconds of
 * the original's clock. Its value is not given by the spec (I): the need lines' interval is
 * rand() mod 2D + 2D, and the one line whose interval is documented with a number (mentor#81,
 * "2 x 60000 ms", units-and-jobs.md 7.7.1) suggests D = 60000 ms, i.e. 120..152.8 s.
 */
export const ADVISOR_UNIT_MS = 60000;
/** the advisor's usual minimum interval, 2 D = 120 s (side-panel.md 1.1.3) */
export const ADVISOR_REPEAT_MS = 2 * ADVISOR_UNIT_MS;

export interface Need { type: number; base: number; threshold: number; }

export interface Town {
  id: number;
  race: number;
  /** index into the race's pool of 10 town names (DV.tdb 142 + 10 x race) */
  nameIndex: number;
  /** settlement id used by the map's records */
  mapId: number;
  hall: number;
  x: number; y: number;
  alive: boolean;
  motivationPct: number;
  researchPct: number;
  population: number;
  capacity: number;
  /** invention being researched, -1 none */
  research: number;
  foodNow: number; foodPrev: number; foodRate: number;
  /**
   * crop conversion (7, town +0x5C/+0x68/+0x6C): the ring's percentage, a standing setting of
   * the town (0 = off); the delivery accumulator and divisor 100 / percent derived from it
   */
  cropPct: number;
  cropAcc: number; cropDiv: number;
  researchAcc: number;
  bonus: number;
  stock: number[];
  income: number; motivationSpent: number; researchSpent: number; overheads: number;
  crime: number; foodPct: number; needsPct: number; condition: number; happiness: number;
  needs: Need[];
  /** open needs: building type, or 1000 + luxury good */
  open: number[];
  homeless: number[];
  researchJob: number;
  /** logistics (units-and-jobs.md 5): worker requests [type, building], four transport lists */
  workerReqs: [number, number][];
  lists: number[][];
  rr: number[];
  dispatcher: number;
  /** units queued for training, per unit type */
  pending: Record<number, number>;
  /**
   * the town's criminal list in its order (combat.md 12.3 "The criminal list"): ids; criminals
   * not yet listed are appended in creation order when the list is read (Combat.criminalList)
   */
  criminals: number[];
}

export interface Player {
  race: number;
  computer: boolean;
  money: number;
  relations: number[];
  /** research progress per invention (float32) */
  progress: number[];
  costs: number[];
  /** town ids in founding order */
  towns: number[];
  disabled: number[];
  goals: Goal[];
  /** 0 playing, 1 won, -1 lost */
  outcome: number;
  /** all towns lost (combat.md 10.4) */
  defeated?: boolean;
  /** mission start goods, column 1 (mdb.md): given to a town founded in play when it is the first */
  startGoods?: number[];
}

export interface RaceSetupLite {
  race: number; present: boolean; computer: boolean; gold: number; relations: number[];
  startGoods: [number, number][]; researchLevel: number; preResearched: boolean[]; disabled: number[];
}

/** what the economy needs from the world */
export interface EconomyHost {
  tick: number;
  readonly rules: Map<number, ObjectRule>;
  readonly rand: MsRand;
  readonly sched: Scheduler;
  readonly entities: EcoEntity[];
  get(id: number): EcoEntity | undefined;
  /** create a unit of `race`/`type` near the cell, belonging to `town` */
  spawnUnit(race: number, type: number, x: number, y: number, town: number): EcoEntity;
  /** a unit born inside building `b` and ejected through the leave job (units-and-jobs.md 4.10 "Births") */
  spawnInside?(race: number, type: number, b: EcoEntity, town: number): EcoEntity;
  /** a resident left building `b` (still alive): a running visit job ejects every occupant and
   *  ends (units-and-jobs.md 4.4 "Residences", `00461690`) */
  residentLeft?(b: EcoEntity): void;
  destroyBuilding(e: EcoEntity): void;
  /** a building's hit points ran out: it collapses */
  ruin(e: EcoEntity): void;
  /** advisor line (side-panel.md 1.1): `queue` = wait while another voice plays; `intervalMs` = the
   *  line's minimum interval (a repeat within it is dropped), 0 = none */
  notify(race: number, mentor: number, queue?: boolean, intervalMs?: number): void;
  /** arm a line's interval slot without saying it (`0045e170`, side-panel.md 1.1.1) */
  armAdvisor?(race: number, mentor: number): void;
  /** add-on mode (docs/game/addon.md): Gold storage rule, island goals */
  readonly addon?: boolean;
  /** island id of a cell (addon.md 2.4), 0 on water and on base maps */
  islandAt?(x: number, y: number): number;
  /** torus size, for the distance of goal 17 */
  readonly size?: number;
}

/** the entity fields the economy reads and writes */
export interface EcoEntity {
  id: number; kind: number; oid: number; owner: number;
  x: number; y: number;
  town: number; home: number; inside: number;
  hp: number; occupancy: number; complete: boolean; active: boolean;
  houseJob: number;
  /** false once a building is destroyed (collapsing) */
  alive?: boolean;
}

const KIND_UNIT = 0, KIND_BUILDING = 1;
const SUBCELL = 256;

export interface EconomySnapshot { players: (Player | null)[]; towns: Town[]; }

export class Economy {
  players: (Player | null)[] = [null, null, null];
  towns: Town[] = [];
  private host: EconomyHost;

  constructor(host: EconomyHost) { this.host = host; }

  private ruleOf(e: EcoEntity): ObjectRule | undefined { return this.host.rules.get(e.oid); }
  private typeOf(e: EcoEntity): number { return e.oid & 0xffff; }

  // ---------------------------------------------------------------- setup

  /** create the nations of a mission (2.1); inventions: research costs per race */
  setupPlayers(races: RaceSetupLite[], costs: number[][], goals: Goal[]): void {
    for (const r of races) {
      if (!r.present) continue;
      const c = costs[r.race] ?? [];
      const p: Player = {
        race: r.race, computer: r.computer, money: Math.max(0, r.gold), relations: [...r.relations],
        progress: c.map(() => 0), costs: [...c], towns: [], disabled: [...r.disabled],
        goals: r.computer ? [] : goals.map(g => ({ ...g })), outcome: 0,
        startGoods: r.startGoods.map(g => g[0] ?? 0),
      };
      // starting inventions (4.4.2), a union of: research level n (index <= n; the free-play
      // development level is folded into n by the front end), the pre-researched flags, the
      // inventions of disabled objects, and in add-on records the add-on extras of the level
      const done = new Set<number>();
      const n = r.researchLevel;
      for (let i = 0; i < c.length; i++) if ((n > 0 && i <= n) || r.preResearched[i]) done.add(i);
      for (const type of r.disabled) {
        const inv = this.host.rules.get(((r.race << 16) | type) >>> 0)?.invention ?? -1;
        if (inv >= 0) done.add(inv);
      }
      if (this.host.addon && n > 0) {
        done.add(30);
        if (n > 5) done.add(31);
        if (n > 15) done.add(32);
      }
      for (const i of done) if (i < c.length) p.progress[i] = c[i];
      this.players[r.race] = p;
    }
    for (const p of this.players) {
      if (!p) continue;
      this.host.sched.create(JobKind.Finance, p.race, ROUND);
      if (!p.computer) this.host.sched.create(JobKind.Goals, p.race, 50);
    }
  }

  ensurePlayer(race: number): Player {
    let p = this.players[race];
    if (!p) {
      p = { race, computer: true, money: 0, relations: [0, 0, 0], progress: [], costs: [], towns: [], disabled: [], goals: [], outcome: 0 };
      this.players[race] = p;
      this.host.sched.create(JobKind.Finance, race, ROUND);
    }
    return p;
  }

  /** found a town at a town hall (2.2); `column` 0/1 = mission start goods column, -1 = none */
  foundTown(race: number, mapId: number, hall: EcoEntity, startGoods?: [number, number][], goodsNow = true): Town {
    const p = this.ensurePlayer(race);
    // name: the lowest of the race's ten names not used by a living town (units-and-jobs.md 11.2)
    const used = new Set(p.towns.map(id => this.towns[id]).filter(o => o?.alive).map(o => o.nameIndex));
    let nameIndex = 0;
    while (used.has(nameIndex) && nameIndex < 9) nameIndex++;
    const t: Town = {
      id: this.towns.length, race, nameIndex, mapId, hall: hall.id, x: Math.floor(hall.x / SUBCELL), y: Math.floor(hall.y / SUBCELL),
      alive: true, motivationPct: 0, researchPct: p.computer ? 40 : 0, population: 0, capacity: 0, research: -1,
      foodNow: 0, foodPrev: 0, foodRate: 0, cropPct: 0, cropAcc: 0, cropDiv: 0, researchAcc: 0, bonus: 0,
      stock: new Array(GOODS).fill(0), income: 0, motivationSpent: 0, researchSpent: 0, overheads: 0,
      crime: 0, foodPct: 100, needsPct: 100, condition: 100, happiness: 100,
      needs: [], open: [], homeless: [], researchJob: 0,
      workerReqs: [], lists: [[], [], [], []], rr: [0, 0, 0], dispatcher: 0, pending: {}, criminals: [],
    };
    // building needs (5.3): every building type of the race with a need threshold
    for (const r of this.host.rules.values()) {
      if (r.group === race && r.kind === KIND_BUILDING && r.needPop > 0) t.needs.push({ type: r.type, base: r.needPop, threshold: r.needPop });
    }
    t.needs.sort((a, b) => a.threshold - b.threshold || a.type - b.type);
    this.towns.push(t);
    p.towns.push(t.id);
    hall.town = t.id;
    // goods: first and second town of a race from the mission table (mdb.md); later ones 10/10/10
    const n = p.towns.length;
    if (!goodsNow) { /* founded in play: goods arrive at activation (startGoodsAtActivation) */ }
    else if (startGoods && n <= 2) for (let g = 0; g < GOODS; g++) t.stock[g] = startGoods[g]?.[n - 1] ?? 0;
    else if (n > 2) { t.stock[Good.Food] = 10; t.stock[Good.Wood] = 10; t.stock[Good.Stone] = 10; }
    const sch = this.host.sched;
    sch.create(JobKind.Consumption, t.id, ROUND, [0, 0, 0, 0]);
    sch.create(JobKind.TownStatus, t.id, 1, [0]);
    if (!p.computer) sch.create(0x03, t.id, 199);   // leisure visits for idle porters (units-and-jobs.md 5.7)
    return t;
  }

  /** a town founded in play gets its goods when its town hall becomes active (units-and-jobs.md
   *  11.4): column 1 of the mission table if it is the race's only town, else 10 wood/stone/food */
  startGoodsAtActivation(t: Town): void {
    const p = this.players[t.race];
    if (!p) return;
    t.stock.fill(0);
    if (p.towns.length <= 1) for (let g = 0; g < GOODS; g++) t.stock[g] = p.startGoods?.[g] ?? 0;
    else { t.stock[Good.Wood] = 10; t.stock[Good.Stone] = 10; t.stock[Good.Food] = 10; }
  }

  town(id: number): Town | undefined { return id >= 0 ? this.towns[id] : undefined; }

  /** the n-th (1-based) town of a race in founding order; 0 is treated as the first */
  nthTown(race: number, n: number): Town | undefined {
    const p = this.players[race];
    if (!p) return undefined;
    return this.towns[p.towns[Math.max(1, n) - 1]];
  }

  // ---------------------------------------------------------------- buildings

  /**
   * A building starts operating (2.3, 4.5, 7): upkeep, storage, house job; a town hall also
   * gets its builder and two porters. `fromMap`: placed by the map loader (no completion birth).
   */
  activate(b: EcoEntity): void {
    if (b.active) return;
    const t = this.town(b.town), r = this.ruleOf(b);
    if (!t || !r) return;
    b.active = true;
    t.overheads += r.money;
    if (this.addsCapacity(r)) t.capacity += r.amount;
    // a need building (tavern, news stand, police, temple, circus) closes its need when it becomes
    // active, i.e. when its operator is inside, not at completion (5.3, `00459e80`)
    if (this.isNeedBuilding(r)) this.needActivated(t, this.typeOf(b), r);
    if (this.typeOf(b) === T.TownHall && b.id === t.hall) {
      this.birth(b, T.Builder, false);
      this.birth(b, T.Porter, false);
      this.birth(b, T.Porter, false);
    }
    if (r.residents > 0 && !b.houseJob) b.houseJob = this.host.sched.create(JobKind.House, b.id, 599).id;
  }

  /** storage capacity: the store flag (GOG); in add-on games Gold's flag 0x10, so the harbour adds none (addon.md 1.2, 3.3) */
  private addsCapacity(r: ObjectRule): boolean {
    return this.host.addon ? (r.flags & 0x10) !== 0 : (r.flags & BuildingFlag.TownStorage) !== 0;
  }

  /** a building stops operating (destroyed or deactivated) */
  deactivate(b: EcoEntity): void {
    if (!b.active) return;
    const t = this.town(b.town), r = this.ruleOf(b);
    b.active = false;
    if (!t || !r) return;
    t.overheads -= r.money;
    // losing a store (economy.md 7): GOG tests the store flag and +0x120 not 0, so a market (0)
    // scales nothing; W = every warehouse in the town's type list, i.e. sites and the dying one too
    if (this.addsCapacity(r) && (this.host.addon || r.amount !== 0)) {
      t.capacity -= r.amount;
      const w = this.count(t, T.Warehouse, false);
      for (let g = 0; g < GOODS; g++) t.stock[g] = Math.trunc((t.stock[g] * w) / (w + 1));
    }
    if (this.isNeedBuilding(r)) this.needDeactivated(t, b, r);
  }

  /** a non-producing building with a need threshold (5.3) */
  private isNeedBuilding(r: ObjectRule): boolean { return r.needPop > 0 && r.product < 0; }

  /** 5.3 activation (`00459e80`): threshold x 2.2 (truncated), re-sorted; the need is closed at once.
   *  A "one per town" building's entry leaves the list instead. */
  private needActivated(t: Town, type: number, r: ObjectRule): void {
    const i = t.needs.findIndex(n => n.type === type);
    if (i >= 0) {
      if (r.flags & BuildingFlag.OnePerTown) t.needs.splice(i, 1);
      else { t.needs[i].threshold = Math.trunc(t.needs[i].threshold * 2.2); this.sortNeeds(t); }
    }
    t.open = t.open.filter(o => o !== type);
  }

  /** 5.3 deactivation (`00459fd0`): the threshold is reset to base x 2.2^(count - 1), count = the
   *  town's objects of that type at this moment, the leaving building included (I: sites and
   *  collapsing ones included, as in the town's type list); then the needs are re-evaluated */
  private needDeactivated(t: Town, b: EcoEntity, r: ObjectRule): void {
    const type = this.typeOf(b);
    let n = 1;
    for (const e of this.host.entities) if (e !== b && e.kind === KIND_BUILDING && e.town === t.id && e.oid === b.oid) n++;
    let need = t.needs.find(x => x.type === type);
    if (!need) { need = { type, base: r.needPop, threshold: r.needPop }; t.needs.push(need); }
    need.threshold = need.base;
    for (let k = 0; k < n - 1; k++) need.threshold = Math.trunc(need.threshold * 2.2);
    this.sortNeeds(t);
    this.evaluateNeeds(t);
  }

  private sortNeeds(t: Town): void { t.needs.sort((a, b) => a.threshold - b.threshold || a.type - b.type); }

  /**
   * Saves before version 7 raised a need's threshold at completion and closed it only at the next
   * re-evaluation: recompute every threshold from the active buildings (5.3) and drop building
   * needs the new thresholds close. No random numbers are drawn.
   */
  migrateNeeds(): void {
    for (const t of this.towns) {
      for (const need of t.needs) {
        let n = 0;
        for (const e of this.host.entities) if (e.kind === KIND_BUILDING && e.town === t.id && e.active && (e.oid & 0xffff) === need.type && (e.oid >>> 16) === t.race) n++;
        need.threshold = need.base;
        for (let k = 0; k < n; k++) need.threshold = Math.trunc(need.threshold * 2.2);
      }
      this.sortNeeds(t);
      t.open = t.open.filter(o => { const need = t.needs.find(x => x.type === o); return !need || t.population >= need.threshold; });
    }
  }

  /**
   * A building finished construction (3.2, `004602d0`): a residence moves homeless in, then, if it
   * is not full, one birth roll. Need buildings do nothing here (5.3: only activation counts). The
   * town hall's completion gives no birth.
   */
  completed(b: EcoEntity): void {
    const t = this.town(b.town), r = this.ruleOf(b);
    if (!t || !r) return;
    b.complete = true;
    if (r.residents > 0 && this.typeOf(b) !== T.TownHall) {
      this.rehouse(b);
      if (b.occupancy < r.residents && this.birthRoll(t)) this.birth(b, T.Porter, true);
    }
  }

  // ---------------------------------------------------------------- population (3)

  /** birth routine (3.2); returns the new unit or null when the building is full */
  birth(b: EcoEntity, type: number, _rolled: boolean): EcoEntity | null {
    const t = this.town(b.town), r = this.ruleOf(b);
    if (!t || !r || b.occupancy >= r.residents) return null;
    b.occupancy++;
    const p = this.players[t.race];
    const d = p?.computer ? 36 : t.happiness < 90 ? 9 : 18;
    const unitType = t.population !== 0 && t.population % d === 0 ? T.Criminal : type;
    // born inside (resident, not on the map) and ejected through the leave job (units-and-jobs.md 4.10)
    const [dx, dy] = [r.doorDx, r.doorDy];
    const u = this.host.spawnInside ? this.host.spawnInside(t.race, unitType, b, t.id)
      : this.host.spawnUnit(t.race, unitType, Math.floor(b.x / SUBCELL) + dx, Math.floor(b.y / SUBCELL) + dy, t.id);
    u.home = b.id;
    this.joinTown(u, t);
    return u;
  }

  private birthRoll(t: Town): boolean {
    const h = t.happiness;
    if (h >= 80) return true;
    return this.host.rand.next() % (10 - Math.trunc(h / 10)) === 0;
  }

  /** a unit becomes a resident of a town (population + needs) */
  joinTown(u: EcoEntity, t: Town): void {
    u.town = t.id;
    t.population++;
    this.evaluateNeeds(t);
  }

  /**
   * A unit changes its type (`00464840`: training, release from jail): it is removed from the
   * town and added again, so the needs are re-evaluated twice, the first time with the
   * population one lower (3.1, 5.4).
   */
  changeType(u: EcoEntity, oid: number): void {
    const t = this.town(u.town);
    if (t) { t.population--; this.evaluateNeeds(t); }
    u.oid = oid;
    if (t) { t.population++; this.evaluateNeeds(t); }
  }

  leaveTown(u: EcoEntity): void {
    const t = this.town(u.town);
    if (!t) return;
    t.population--;
    t.homeless = t.homeless.filter(id => id !== u.id);
    if (u.home >= 0) this.leaveHome(u);
    u.town = -1;
    this.evaluateNeeds(t);
  }

  /** move a unit into a building with free resident places */
  moveIn(u: EcoEntity, b: EcoEntity): boolean {
    const r = this.ruleOf(b);
    if (!r || b.occupancy >= r.residents) return false;
    b.occupancy++;
    u.home = b.id;
    return true;
  }

  leaveHome(u: EcoEntity): void {
    const b = this.host.get(u.home);
    u.home = -1;
    if (!b) return;
    b.occupancy = Math.max(0, b.occupancy - 1);
    if (b.alive !== false) this.host.residentLeft?.(b);
    // a resident leaving re-arms the house job of a building that is still alive (3.2, `00461690`);
    // a running job keeps its phase
    if (!b.houseJob && b.alive !== false) b.houseJob = this.host.sched.create(JobKind.House, b.id, 599).id;
  }

  /** move homeless units in while there is room (3.3) */
  private rehouse(b: EcoEntity): void {
    const t = this.town(b.town), r = this.ruleOf(b);
    if (!t || !r) return;
    while (t.homeless.length && b.occupancy < r.residents) {
      const u = this.host.get(t.homeless.shift()!);
      if (!u || u.town !== t.id) continue;
      this.moveIn(u, b);
    }
  }

  /** house job (3.2, `004749e0` -> `004606e0`): rehouse; a full building ends the job, otherwise
   *  one birth roll and 599 ticks to the next run, also when this birth has filled the building */
  private runHouse(job: Job): number {
    const b = this.host.get(job.owner);
    const r = b && this.ruleOf(b);
    if (!b || !r || b.alive === false) { if (b) b.houseJob = 0; return 0; }
    const t = this.town(b.town);
    if (!t) { b.houseJob = 0; return 0; }
    this.rehouse(b);
    if (b.occupancy >= r.residents) { b.houseJob = 0; return 0; }
    if (this.birthRoll(t)) this.birth(b, T.Porter, true);
    return 599;
  }

  // ---------------------------------------------------------------- needs (5.3, 5.4)

  luxuryThresholds(t: Town): [number, number][] {
    const out: [number, number][] = [];
    let f = 1.5;
    for (let i = 0; i < 3; i++) {
      if (!this.players[i]) continue;
      const base = this.host.rules.get(((GOODS_GROUP << 16) | (6 + i)) >>> 0)?.needPop || 30;
      if (i === t.race) out.push([6 + i, base]);
      else { out.push([6 + i, Math.trunc(base * f)]); f += 1; }
    }
    return out;
  }

  /**
   * Re-evaluate the open needs (5.4, `0045a2c0`): building needs in list order, then the luxuries.
   * Every need that is open after its test queues its advisor line with the interval
   * rand() mod 2D + 2D: one rand() per open need on every evaluation, for every town (the
   * advisor itself, absent for computer players, only says the line).
   */
  evaluateNeeds(t: Town): void {
    const open = new Set(t.open);
    for (const n of t.needs) {
      if (t.population < n.threshold) { open.delete(n.type); continue; }
      open.add(n.type);
      this.announceNeed(t, this.host.rules.get(((t.race << 16) | n.type) >>> 0)?.message ?? 0);
    }
    for (const [good, th] of this.luxuryThresholds(t)) {
      if (t.population < th || t.stock[good] > 0) { open.delete(1000 + good); continue; }
      open.add(1000 + good);
      this.announceNeed(t, Mentor.LuxuryNeed + good - 6);
    }
    t.open = [...open].sort((a, b) => a - b);
  }

  private announceNeed(t: Town, mentor: number): void {
    const interval = (this.host.rand.next() % (2 * ADVISOR_UNIT_MS)) + 2 * ADVISOR_UNIT_MS;
    const p = this.players[t.race];
    if (p && !p.computer && mentor > 0) this.host.notify(t.race, mentor, true, interval);
  }

  // ---------------------------------------------------------------- storage (7)

  /**
   * Add goods to the town stock (7, `0046e820`). A crop delivery with the ring on (7 "Crop
   * conversion") first feeds the accumulator; n = trunc(min(accumulator / divisor, food space))
   * crops become 2n food (capped by the space) and are taken off the delivery. n is not capped by
   * the delivery: an accumulator that grew while the food store was full converts the backlog,
   * which comes out of the crop stock (ours keeps that stock at 0 or more).
   */
  addGood(t: Town, good: number, amount: number): number {
    if (good === Good.Food) t.foodNow += amount;
    if (good === Good.Crop && t.cropDiv !== 0) {
      t.cropAcc = f32(t.cropAcc + amount);
      if (t.cropAcc >= t.cropDiv) {
        const space = t.capacity - t.stock[Good.Food];
        const n = Math.trunc(Math.min(t.cropAcc / t.cropDiv, space));
        const food = Math.min(2 * n, space);
        t.stock[Good.Food] += food;
        t.foodNow += food;
        amount -= n;
        t.cropAcc = f32(t.cropAcc - n * t.cropDiv);
      }
    }
    const before = t.stock[good];
    t.stock[good] = Math.max(0, Math.min(before + amount, t.capacity));
    return t.stock[good] - before;
  }

  /**
   * The conversion ring (command 0x57 with a percentage, `00452b40`): a standing setting of the
   * town. Divisor = 100 / percent (float32), accumulator = half a divisor; 0 switches it off.
   */
  setCropRing(t: Town, percent: number): void {
    t.cropPct = percent;
    if (percent === 0) { t.cropDiv = 0; t.cropAcc = 0; return; }
    const div = 100 / percent;
    t.cropDiv = f32(div);
    t.cropAcc = f32(div * 0.5);
  }

  /**
   * UMWANDELN (command 0x57 with 0xFF, `00452b9e`): convert the ring's percentage of the crop
   * stock now, n = min(trunc(crop x percent / 100), trunc(food space / 2)); 2n food, also counted
   * as food produced this round.
   */
  convertNow(t: Town): void {
    const n = Math.min(Math.trunc((t.stock[Good.Crop] * t.cropPct) / 100), Math.trunc((t.capacity - t.stock[Good.Food]) / 2));
    t.stock[Good.Crop] = Math.max(0, t.stock[Good.Crop] - n);
    t.foodNow += 2 * n;
    t.stock[Good.Food] = Math.min(t.stock[Good.Food] + 2 * n, t.capacity);
  }

  removeGood(t: Town, good: number, amount: number): void {
    t.stock[good] = Math.max(0, t.stock[good] - amount);
  }

  space(t: Town, good: number): number { return Math.max(0, t.capacity - t.stock[good]); }

  // ---------------------------------------------------------------- jobs

  runJob(job: Job): number {
    switch (job.kind) {
      case JobKind.Finance: return this.runFinance(job);
      case JobKind.Goals: return this.runGoals(job);
      case JobKind.Consumption: return this.runConsumption(job);
      case JobKind.TownStatus: return this.runTownStatus(job);
      case JobKind.Research: return this.runResearch(job);
      case JobKind.House: return this.runHouse(job);
      default: return 0;
    }
  }

  /** count completed, active objects of a type in a town */
  count(t: Town, type: number, activeOnly = true): number {
    let n = 0;
    for (const e of this.host.entities) {
      if (e.town === t.id && (e.oid & 0xffff) === type && (e.oid >>> 16) === t.race && (!activeOnly || e.kind !== KIND_BUILDING || e.active)) n++;
    }
    return n;
  }

  /** 4.1 to 4.6: settle all towns of a player once per round */
  private runFinance(job: Job): number {
    const p = this.players[job.owner];
    if (!p) return 0;
    let sum = 0;
    for (const id of p.towns) {
      const t = this.towns[id];
      if (!t.alive) continue;
      sum += this.townNet(t, p.money);
      t.researchAcc = 0;
    }
    p.money = Math.max(0, p.money + sum);
    if (!p.computer && p.money < 6) this.host.notify(p.race, Mentor.LowMoney, true, ADVISOR_REPEAT_MS);
    return ROUND;
  }

  /** 4.2: tax income of a town from its current population */
  private townIncome(t: Town): number {
    const homeless = t.homeless.length;
    const criminals = this.count(t, T.Criminal, false);
    const income = 7 * Math.max(0, t.population - homeless - criminals);
    return this.count(t, T.Bank) > 0 ? Math.trunc(income * 1.5) : income;
  }

  /**
   * The finance page's figures (side-panel.md 5.4): income, slider amounts M and R and upkeep,
   * recomputed from the current population without touching the simulation, plus whether each
   * spending row is actually being spent. Research is spent only while a project runs (or with
   * the slider at 0); otherwise the page shows R in parentheses and 0 (economy.md 4.4.1).
   */
  financeView(t: Town): { income: number; motivation: number; research: number; overheads: number; motivationSpent: boolean; researchSpent: boolean } {
    const income = this.townIncome(t);
    const motivation = income > 0 ? Math.trunc((t.motivationPct * income) / 100) : 0;
    const research = income > 0 ? Math.trunc((t.researchPct * income) / 100) : 0;
    return {
      income, motivation, research, overheads: t.overheads,
      motivationSpent: t.motivationPct === 0 || t.bonus !== 0,
      researchSpent: t.researchPct === 0 || t.research >= 0,
    };
  }

  private townNet(t: Town, money: number): number {
    const income = this.townIncome(t);
    t.income = income;
    let available = money;
    const m = Math.trunc((t.motivationPct * income) / 100);
    let paidM = 0;
    if (income > 0 && (t.happiness < 100 || t.bonus) && m < available) { paidM = m; available -= m; }
    const net = Math.trunc(f32(f32(income - paidM) - f32(4 * t.researchAcc) - t.overheads));
    t.motivationSpent = m;
    t.researchSpent = Math.trunc((t.researchPct * income) / 100);
    return net;
  }

  /** 5.1, 5.2: food and luxury consumption every round */
  private runConsumption(job: Job): number {
    const t = this.towns[job.owner];
    if (!t || !t.alive) return 0;
    const d = job.data;
    d[0] = f32(d[0] + f32(t.population * f32(0.2)));
    const eaten = Math.trunc(d[0]);
    // statistics: food produced (average of this and last round)
    t.foodRate = f32((t.foodNow + t.foodPrev) / 2);
    t.foodPrev = t.foodNow; t.foodNow = 0;
    if (t.population === 0) return ROUND;
    for (const [good, th] of this.luxuryThresholds(t)) {
      const slot = 1 + (good - 6);
      if (t.population >= th) {
        d[slot] = f32(d[slot] + f32(d[0] * f32(0.0625)));
        const n = Math.trunc(d[slot]);
        if (n > 0) { d[slot] = Math.max(0, f32(d[slot] - n)); this.removeGood(t, good, n); }
      }
    }
    if (eaten > 0) { d[0] = f32(d[0] - eaten); this.removeGood(t, Good.Food, eaten); }
    return ROUND;
  }

  /** 5.5, 5.8: happiness every 50 ticks, decay and condition every 12th run */
  private runTownStatus(job: Job): number {
    const t = this.towns[job.owner];
    if (!t || !t.alive) return 0;
    this.updateHappiness(t);
    job.data[0] = (job.data[0] + 1) % 12;
    if (job.data[0] === 0) this.decay(t);
    return 50;
  }

  updateHappiness(t: Town): void {
    const p = this.players[t.race];
    const hall = this.host.get(t.hall);
    // only for human towns with population whose first town hall is active (5.5)
    if (!p || p.computer || t.population <= 0 || !hall || !hall.active) {
      t.crime = 0; t.foodPct = 100; t.needsPct = 100; t.happiness = 100;
      return;
    }
    const before = t.happiness;
    const criminals = this.count(t, T.Criminal, false);
    t.crime = Math.trunc((criminals * 100) / t.population);
    t.foodPct = Math.min(100, Math.trunc((t.stock[Good.Food] * 100) / Math.max(1, Math.trunc(t.population / 5))));
    t.needsPct = Math.trunc(100 / (t.open.length + 1));
    let h = Math.trunc((t.needsPct - t.crime + 100 + t.foodPct) / 3);
    t.bonus = 0;
    if (h < 100 && t.income !== 0) {
      t.bonus = 1;
      h = Math.min(100, h + Math.trunc((t.motivationSpent * 100) / t.income));
    }
    t.happiness = h;
    // advisor lines (5.7, side-panel.md 1.1.3): each with 2 D, arming the others of the group;
    // mentor#28 "dissatisfied" is never said (its branch is unreachable in the original)
    if (t.foodPct < 100) {
      this.host.notify(t.race, t.foodPct < 50 ? Mentor.Famine : Mentor.FoodScarce, true, ADVISOR_REPEAT_MS);
      this.armAdvisor(t.race, Mentor.HappierFood, Mentor.SadderFood, Mentor.Dissatisfied);
    } else if (h > before) {
      this.host.notify(t.race, Mentor.HappierFood, true, ADVISOR_REPEAT_MS);
      this.armAdvisor(t.race, Mentor.SadderFood, Mentor.Dissatisfied);
    } else if (h < before) {
      this.host.notify(t.race, Mentor.SadderFood, true, ADVISOR_REPEAT_MS);
      this.armAdvisor(t.race, Mentor.HappierFood, Mentor.Dissatisfied);
    }
  }

  private armAdvisor(race: number, ...lines: number[]): void {
    for (const l of lines) this.host.armAdvisor?.(race, l);
  }

  private decay(t: Town): void {
    const p = this.players[t.race]!;
    if (!p.computer) {
      if (p.money === 0) this.host.notify(t.race, Mentor.NoMoney, true, ADVISOR_REPEAT_MS);
      else if (t.happiness <= 49) this.host.notify(t.race, Mentor.DecayMotivation, true, ADVISOR_REPEAT_MS);
    }
    let sum = 0, n = 0;
    for (const e of [...this.host.entities]) {
      if (e.kind !== KIND_BUILDING || e.town !== t.id) continue;
      const r = this.ruleOf(e);
      if (!r || r.hp <= 0) continue;
      if ((t.happiness < 50 || p.money === 0) && e.hp > Math.trunc(r.hp / 10)) {
        e.hp = Math.min(r.hp, e.hp - (t.happiness < 30 ? 4 : 2));
        if (e.hp < 1) { this.host.ruin(e); continue; }
      }
      sum += e.complete ? Math.trunc((e.hp * 100) / r.hp) : 100;
      n++;
    }
    t.condition = n ? Math.trunc(sum / n) : 100;
  }

  // ---------------------------------------------------------------- research (4.4)

  selectResearch(t: Town, invention: number): void {
    const p = this.players[t.race];
    if (!p) return;
    if (invention >= 0 && (invention >= p.costs.length || this.researched(p, invention))) return;
    t.research = invention;
    if (invention >= 0 && !(t.researchJob && this.host.sched.get(t.researchJob))) {
      t.researchJob = this.host.sched.create(JobKind.Research, t.id, 30).id;
    }
  }

  researched(p: Player, i: number): boolean { return p.costs[i] !== undefined && p.progress[i] >= p.costs[i]; }

  private runResearch(job: Job): number {
    const t = this.towns[job.owner];
    if (!t || !t.alive || t.research < 0) { if (t) t.researchJob = 0; return 0; }
    const p = this.players[t.race]!;
    const r = t.researchSpent;
    if (r < p.money && this.count(t, T.Lab) > 0) {
      let s = f32(r * f32(0.025));
      if (this.count(t, T.Library) > 0) s = f32(s * f32(1.5));
      const i = t.research;
      p.progress[i] = Math.min(p.costs[i], f32(p.progress[i] + s));
      t.researchAcc = f32(t.researchAcc + s);
      if (this.researched(p, i)) {
        for (const o of this.towns) if (o.race === t.race && o.research === i) o.research = -1;
        if (!p.computer) this.host.notify(t.race, 15);   // mentor#15 "Forschung abgeschlossen."
        t.researchJob = 0;
        return 0;
      }
    }
    return 30;
  }

  // ---------------------------------------------------------------- goals (mdb.md "Goals")

  private runGoals(job: Job): number {
    const p = this.players[job.owner];
    if (!p || p.outcome !== 0) return 0;
    if (this.dead(p.race)) { p.outcome = -1; return 0; }
    const wins = p.goals.filter(g => !g.defeat), losses = p.goals.filter(g => g.defeat);
    if (losses.some(g => this.goalMet(p, g))) { p.outcome = -1; return 0; }
    if (wins.length && wins.every(g => this.goalMet(p, g))) { p.outcome = 1; return 0; }
    return 50;
  }

  /** a race is dead when it has neither buildings nor units */
  dead(race: number): boolean {
    for (const e of this.host.entities) if (e.owner === race && (e.kind === KIND_UNIT || e.kind === KIND_BUILDING)) return false;
    return true;
  }

  private objects(race: number, t: Town | undefined, type: number, completeOnly: boolean): number {
    if (!t) return 0;
    let n = 0;
    for (const e of this.host.entities) {
      if (e.town !== t.id || e.owner !== race || (e.oid & 0xffff) !== type) continue;
      if (completeOnly && e.kind === KIND_BUILDING && !e.complete) continue;
      n++;
    }
    return n;
  }

  goalMet(p: Player, g: Goal): boolean {
    const me = p.race;
    switch (g.type) {
      case 1: { const t = this.nthTown(me, g.p3); return !!t && t.stock[g.p1] >= g.p2; }
      case 2: return this.objects(me, this.nthTown(me, g.p3), g.p1, true) >= g.p2;
      case 3: {
        const t = this.nthTown(me, g.p2);
        if (!t) return false;
        let n = 0;
        for (const e of this.host.entities) if (e.town === t.id && e.kind === KIND_BUILDING && e.complete) n++;
        return n >= g.p1;
      }
      case 4: return this.objects(me, this.nthTown(me, g.p3), g.p1, false) >= g.p2;
      case 5: { const t = this.nthTown(me, g.p2); return !!t && t.population >= g.p1; }
      case 6: { const t = this.nthTown(me, g.p2); return !!t && t.crime <= g.p1; }
      case 7: { const t = this.nthTown(me, g.p2); return !!t && t.happiness >= g.p1; }
      case 8: { const t = this.nthTown(me, g.p2); return !!t && t.open.length <= g.p1; }
      case 9: { const t = this.nthTown(me, g.p2); return !!t && t.open.length >= g.p1; }
      case 10: { const t = this.nthTown(me, g.p2); return !!t && t.happiness <= g.p1; }
      case 11: return p.relations[g.p1] === g.p2;
      case 12: return this.objects(g.p1, this.nthTown(g.p1, g.p3), g.p2, false) === 0;
      case 13: return !this.players[g.p1] || this.dead(g.p1);
      case 14: { const t = this.nthTown(1, g.p3); return !!t && t.stock[g.p1] >= g.p2; }
      case 15: return this.objects(me, this.nthTown(me, g.p3), g.p1, false) <= g.p2;
      case 16: return p.money >= g.p1;
      // Gold Edition goals (docs/game/addon.md 9.2, docs/formats/addon.md 7.2). Goal object ids are
      // creation indices from 0; our entity ids start at 1, so object #p1 is entity p1 + 1.
      case 17: {
        const e = this.host.get(g.p1 + 1);
        if (!e || (e as { alive?: boolean }).alive === false) return false;
        const [x, y] = goalCell(g.p2);
        return this.torusDist(Math.floor(e.x / SUBCELL), Math.floor(e.y / SUBCELL), x, y) <= g.p3;
      }
      case 18: {
        const e = this.host.get(g.p1 + 1);
        return !e || (e as { alive?: boolean }).alive === false || (e.oid & 0xffff) !== g.p2;
      }
      case 19: {
        let n = 0;
        for (const id of p.towns) {
          const t = this.towns[id];
          if (!t || !t.alive || (this.host.islandAt?.(t.x, t.y) ?? 0) !== g.p1 || g.p1 === 0) continue;
          n += this.objects(me, t, g.p2, false);
        }
        return n >= g.p3;
      }
      case 20: { const t = this.nthTown(me, g.p3); return !!t && t.stock[g.p1] <= g.p2; }
      default: return false;
    }
  }

  /** torus distance max + min / 2, both axes wrapped (world-populate.md 2.2) */
  private torusDist(ax: number, ay: number, bx: number, by: number): number {
    const n = this.host.size ?? 1 << 30;
    let dx = Math.abs(ax - bx), dy = Math.abs(ay - by);
    if (dx > n / 2) dx = n - dx;
    if (dy > n / 2) dy = n - dy;
    return Math.max(dx, dy) + Math.floor(Math.min(dx, dy) / 2);
  }

  // ---------------------------------------------------------------- state

  snapshot(): EconomySnapshot {
    return structuredCloneLite({ players: this.players, towns: this.towns });
  }

  restore(s: EconomySnapshot): void {
    const c = structuredCloneLite(s);
    this.players = c.players; this.towns = c.towns;
  }

  digest(mix: (v: number) => void): void {
    for (const p of this.players) {
      if (!p) { mix(-1); continue; }
      mix(p.money); mix(p.outcome);
      for (const v of p.progress) mix(Math.round(v * 4096));
    }
    for (const t of this.towns) {
      mix(t.population); mix(t.happiness); mix(t.capacity); mix(t.overheads); mix(t.income);
      mix(Math.round(t.researchAcc * 4096)); mix(t.open.length);
      for (const s of t.stock) mix(s);
      mix(t.criminals.length); for (const id of t.criminals) mix(id);
      mix(t.cropPct); mix(Math.round(t.cropAcc * 4096));
    }
  }
}

function structuredCloneLite<T>(v: T): T { return JSON.parse(JSON.stringify(v)) as T; }
