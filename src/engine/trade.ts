// Markets, market settings and merchants' trade routes.
// Spec: docs/game/ai-diplomacy-trade.md section 4 (section numbers below), docs/ui/side-panel.md
// 5.5 (market and trade route pages), docs/game/units-and-jobs.md 4.4 (door queue).
//
// Market settings are per town and per good (the table at town +0x4EC, 4.2), kept here as plain
// integer arrays indexed by town id. A town without an entry has the initial settings; entries
// are only created by commands, so reading never changes the state. A merchant (unit type 28)
// runs the route job (kind 0x20) between the markets of two towns and trades on entering them.

import type { Job } from './scheduler.ts';
import type { World, Entity } from './world.ts';
import type { Town } from './economy.ts';
import { BuildingFlag } from '../formats/odb.ts';
import { cellOf, enterDoor, goLost, leaveQueues, nearEntity, nearestTo, setIdle, stopWalking, walkDelay, walkToEntity } from './visit.ts';

export const TradeJob = { Route: 0x20 } as const;
export const isTradeJob = (kind: number) => kind === TradeJob.Route;

export const MARKET = 48;
export const MERCHANT = 28;
/** add-on: the sea traders' terminal (docs/game/addon.md 5.7) */
export const HARBOUR = 62;
/** a merchant carries up to 5 units of one good (4.4) */
export const CARRY_MAX = 5;
export const GOODS = 9;
const PEACE = 3;
const GOODS_GROUP = 6;
const KIND_UNIT = 0, KIND_BUILDING = 1;
/** stock limits accepted from commands (the panel's sliders go to the storage capacity) */
const MAX_STOCK_SETTING = 100000;

/** the six fields of one good's market record, in record order (4.2) */
export const MF = { MaxStock: 0, MaxPrice: 1, Buy: 2, MinStock: 3, MinPrice: 4, Sell: 5 } as const;
export const RECORD = 6;
export type MarketField = 'maxStock' | 'maxPrice' | 'buy' | 'minStock' | 'minPrice' | 'sell';
const FIELD_INDEX: Record<MarketField, number> = { maxStock: 0, maxPrice: 1, buy: 2, minStock: 3, minPrice: 4, sell: 5 };

/**
 * Route job data slots (4.4 "Fields"): Leg = the target town (0 A, 1 B; the original's +0x30),
 * First = the first-leg marker (+0x2C set: the leg starts at A's market as its source), Market =
 * the market of the stop under way, Dest = the first leg's destination market while its source
 * stop runs (-1 otherwise).
 */
const RT = { Phase: 0, From: 1, To: 2, Leg: 3, Market: 4, Paused: 5, First: 6, Dest: 7, Size: 8 } as const;
/**
 * Route phases. State 0 (trading): Go = no leg child, Next = a leg stop chosen whose walk is not
 * made yet, Arrive = walking to / entering the stop's market. State 1 (homeward after a peace
 * loss): HomeGo = no child yet, Home = the go-to to A's market. Inside: saves before version 22
 * (the merchant waited inside a market before leaving).
 */
const PH = { Go: 0, Arrive: 1, Inside: 2, Home: 3, HomeGo: 4, Next: 5 } as const;
/** route job size before snapshot version 22 */
export const ROUTE_SIZE_V21 = 6;

export type TradeCommand =
  /** set one field of one good's market settings of an own town (4.2; `00452290`, `00452c50`) */
  | { type: 'market'; player: number; town: number; good: number; field: MarketField; value: number }
  /**
   * Trade route of an own merchant (4.4): `set` with both towns replaces his job and starts at
   * once; with one end (-1 = keep the stored one) a paused route is kept with that end. `start`
   * restarts a route whose two ends are known, `stop` pauses it.
   */
  | { type: 'route'; player: number; unit: number; action: 'set'; from: number; to: number }
  | { type: 'route'; player: number; unit: number; action: 'start' | 'stop' };

export interface TradeSnapshot { markets: (number[] | null)[] }

/** a merchant's route as the panel shows it */
export interface RouteInfo { from: number; to: number; leg: number; paused: boolean }

export class Trade {
  private w: World;
  /** market settings per town id: 9 x 6 integers, or null for the initial ones */
  table: (number[] | null)[] = [];

  constructor(w: World) { this.w = w; }

  // ---------------------------------------------------------------- settings (4.2)

  /** base price of a good (goods record +0xD4, odb.md A.3) */
  basePrice(good: number): number { return Math.max(0, this.w.rules.get(((GOODS_GROUP << 16) | good) >>> 0)?.money ?? 0); }

  /** initial settings: max stock 25, max price = base, buy off, min stock 0, min price = base, sell off */
  private initial(): number[] {
    const out: number[] = [];
    for (let g = 0; g < GOODS; g++) { const b = this.basePrice(g); out.push(25, b, 0, 0, b, 0); }
    return out;
  }

  /** one field of a town's settings (read only; does not create an entry) */
  get(town: number, good: number, field: number): number {
    const m = this.table[town];
    if (m) return m[good * RECORD + field];
    if (field === MF.MaxStock) return 25;
    if (field === MF.MaxPrice || field === MF.MinPrice) return this.basePrice(good);
    return 0;
  }

  private ensure(town: number): number[] {
    while (this.table.length <= town) this.table.push(null);
    return (this.table[town] ??= this.initial());
  }

  /** write one field, clamped to the panel's ranges: stocks 0.., prices 0..2 x base, flags 0/1 */
  set(town: number, good: number, field: number, value: number): void {
    if (!(good >= 0 && good < GOODS) || !(field >= 0 && field < RECORD)) return;
    let v = Math.trunc(Number(value) || 0);
    if (field === MF.Buy || field === MF.Sell) v = v ? 1 : 0;
    else if (field === MF.MaxPrice || field === MF.MinPrice) v = Math.max(0, Math.min(2 * this.basePrice(good), v));
    else v = Math.max(0, Math.min(MAX_STOCK_SETTING, v));
    this.ensure(town)[good * RECORD + field] = v;
  }

  private buys(t: Town, g: number): boolean { return this.get(t.id, g, MF.Buy) !== 0; }
  private sells(t: Town, g: number): boolean { return this.get(t.id, g, MF.Sell) !== 0; }

  // ---------------------------------------------------------------- markets and partners (4.1, 4.3)

  /** markets (or, for sea traders, harbours) of a town in id order (`any state` includes construction sites) */
  marketsOf(t: Town, activeOnly: boolean, terminal = MARKET): Entity[] {
    return this.w.entities.filter(b => b.kind === KIND_BUILDING && (b.oid & 0xffff) === terminal && b.town === t.id && b.owner === t.race && (!activeOnly || b.active));
  }
  hasActiveMarket(t: Town, terminal = MARKET): boolean {
    for (const b of this.w.entities) if (b.kind === KIND_BUILDING && (b.oid & 0xffff) === terminal && b.town === t.id && b.owner === t.race && b.active) return true;
    return false;
  }

  /** a trader: type 28, or record flag 0x40 (add-on transport ships, addon.md 1.2) */
  isTrader(u: Entity): boolean { return u.kind === KIND_UNIT && ((u.oid & 0xffff) === MERCHANT || this.w.naval.isTrader(u)); }
  /** the trader's terminal building: market for merchants, harbour for everyone else (5.7) */
  terminal(u: Entity): number { return (u.oid & 0xffff) === MERCHANT ? MARKET : HARBOUR; }
  /** add-on merchants trade only with towns on their own island (5.7); -1 = any */
  private islandFilter(u: Entity): number {
    if (!this.w.addon || this.terminal(u) !== MARKET) return -1;
    const [x, y] = cellOf(u);
    return this.w.islandAt(x, y);
  }

  /** may goods move between the two races: same race, or peace (4.3) */
  open(a: number, b: number): boolean {
    if (a === b) return true;
    const eco = this.w.economy;
    return (eco.players[a]?.relations[b] ?? eco.players[b]?.relations[a] ?? 0) === PEACE;
  }

  /**
   * Possible partners of town t1 (4.3): other living towns with an active market of the own race
   * or a race at peace. `aiTest`: also require a good that t1 buys and t2 sells or the reverse.
   * Returned in town id order.
   */
  partners(t1: Town, aiTest = false, terminal = MARKET, island = -1): Town[] {
    return this.w.economy.towns.filter(t2 => {
      if (t2.id === t1.id || !t2.alive || !this.open(t1.race, t2.race) || !this.hasActiveMarket(t2, terminal)) return false;
      if (island >= 0 && this.w.islandAt(t2.x, t2.y) !== island) return false;
      if (!aiTest) return true;
      for (let g = 0; g < GOODS; g++) {
        if ((this.buys(t1, g) && this.sells(t2, g)) || (this.sells(t1, g) && this.buys(t2, g))) return true;
      }
      return false;
    });
  }

  /**
   * The trade route page's lists (`00456fc0`, ui/side-panel.md 5.5 class 13): per race, up to 10
   * towns of the own race or of a race at peace with an active market (harbour for ships), in the
   * player's town-list order. No town is excluded (the trader's own town is listed too) and there
   * is no flag test. Add-on merchants only see towns on their island (addon.md 5.7).
   */
  partnerLists(race: number, trader?: Entity): Town[][] {
    const out: Town[][] = [[], [], []];
    const eco = this.w.economy;
    const term = trader ? this.terminal(trader) : MARKET, isl = trader ? this.islandFilter(trader) : -1;
    for (let r = 0; r < out.length; r++) {
      if (!this.open(race, r)) continue;
      for (const id of eco.players[r]?.towns ?? []) {
        const t = eco.town(id);
        if (!t || !t.alive || t.race !== r || !this.hasActiveMarket(t, term)) continue;
        if (isl >= 0 && this.w.islandAt(t.x, t.y) !== isl) continue;
        if (out[r].length < 10) out[r].push(t);
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- commands

  apply(cmd: TradeCommand): void {
    if (cmd.type === 'market') {
      const t = this.w.economy.town(Math.trunc(cmd.town));
      const f = FIELD_INDEX[cmd.field];
      const good = Math.trunc(Number(cmd.good));
      // the market pages offer goods 1..8 only; good 0 (raw material / crop) is never traded (4.2)
      if (!t || !t.alive || t.race !== cmd.player || f === undefined || !(good >= 1 && good < GOODS)) return;
      this.set(t.id, good, f, cmd.value);
      return;
    }
    const u = this.w.get(cmd.unit);
    if (!u || u.kind !== KIND_UNIT || u.owner !== cmd.player || !this.isTrader(u)) return;
    if (u.inside >= 0 && this.w.get(u.inside)?.kind === KIND_UNIT) return;   // on board a ship
    if (cmd.action === 'set') this.setRoute(u, Math.trunc(cmd.from), Math.trunc(cmd.to));
    else if (cmd.action === 'start') { const r = this.routeOf(u); if (r && r.from >= 0 && r.to >= 0) this.startRoute(u, r.from, r.to, false); }
    else this.stopRoute(u);
  }

  /** saves before version 22: the route job gets the first-leg marker (off) and the destination slot */
  migrateRoutesV21(jobs: Iterable<Job>): void {
    for (const j of jobs) if (j.kind === TradeJob.Route && j.data.length === ROUTE_SIZE_V21) j.data.push(0, -1);
  }

  private routeJob(u: Entity): Job | undefined {
    const j = this.w.logistics.mainJob(u);   // also while it waits behind a leave job
    return j && j.kind === TradeJob.Route ? j : undefined;
  }

  /** the merchant's route (running or paused), or null */
  routeOf(u: Entity): RouteInfo | null {
    const j = this.routeJob(u);
    if (!j) return null;
    return { from: j.data[RT.From], to: j.data[RT.To], leg: j.data[RT.Leg], paused: j.data[RT.Paused] === 1 };
  }

  /**
   * Route ends as the command finds them (`004522d0`): A an own town, B a town of any player. No
   * test of life or peace here: the job's runs end or turn the route (4.4 "Each run"). Add-on
   * merchants only reach towns on their island (addon.md 5.7).
   */
  private validEnd(u: Entity, id: number, origin: boolean): boolean {
    const t = this.w.economy.town(id);
    if (!t) return false;
    const isl = this.islandFilter(u);
    if (!origin && isl >= 0 && this.w.islandAt(t.x, t.y) !== isl) return false;
    return !origin || t.race === u.owner;
  }

  /**
   * The route command (4.4 "Route command"): both ends make a new route job, first run after 1
   * tick. One end (-1 = not given): a running or paused route job is kept and only that end is
   * replaced (A also sets the first-leg marker, B also the current target), so a running route is
   * redirected; without a route job a new one with only that end is made, paused (blocked 599).
   */
  setRoute(u: Entity, from: number, to: number): void {
    if (from >= 0 && !this.validEnd(u, from, true)) return;
    if (to >= 0 && !this.validEnd(u, to, false)) return;
    if (from >= 0 && to >= 0) { this.startRoute(u, from, to, false); return; }
    if (from < 0 && to < 0) return;
    // the test is on the current job: behind a leave job the route is replaced by a new paused one
    let j = this.currentRoute(u);
    if (!j) {
      this.startRoute(u, -1, -1, true, 599);
      j = this.routeJob(u)!;
    }
    const d = j.data;
    if (from >= 0) { d[RT.From] = from; d[RT.First] = 1; }
    if (to >= 0) { d[RT.To] = to; d[RT.Leg] = 1; }
  }

  /**
   * new route job: replaces the merchant's job; running routes start at once (4.4 "Start");
   * `delay`: first run (the computer's merchants get theirs through the job hand-out with 5, 4.6)
   */
  startRoute(u: Entity, from: number, to: number, paused: boolean, delay = 1): void {
    if (u.inside >= 0) this.w.logistics.leave(u);
    const d = new Array<number>(RT.Size).fill(0);
    // target B, first leg from A's market (`0047cd10`)
    d[RT.Phase] = PH.Go; d[RT.From] = from; d[RT.To] = to; d[RT.Leg] = 1; d[RT.Market] = -1; d[RT.Paused] = paused ? 1 : 0;
    d[RT.First] = 1; d[RT.Dest] = -1;
    this.w.logistics.assign(u, TradeJob.Route, delay, d);
    if (paused) stopWalking(this.w, u);
  }

  /** the merchant's current job if it is the route job (not while a leave job is current) */
  private currentRoute(u: Entity): Job | undefined {
    const j = u.job ? this.w.sched.get(u.job) : undefined;
    return j && !j.cancelled && j.kind === TradeJob.Route ? j : undefined;
  }

  /**
   * "Handelsroute stoppen" (`00452620`): the job is kept but blocked (polled every 599 ticks), only
   * when it is his current job: while he is on his way out of a market the command does nothing.
   */
  stopRoute(u: Entity): void {
    const j = this.currentRoute(u);
    if (!j || j.data[RT.Paused]) return;
    j.data[RT.Paused] = 1;
    leaveQueues(this.w, u);
    if (u.inside >= 0) this.w.logistics.leave(u);
    stopWalking(this.w, u);
  }

  // ---------------------------------------------------------------- the route job (0x20, 4.4)

  /**
   * The route job (0x20, 4.4 "Each run"): A or B gone ends it; a lost peace with B drops the leg on
   * the spot and turns him to A's nearest market (state 1); both checks on every run, mid-walk
   * too. A leg is a go-to into the target town's nearest market, the first leg starting with A's
   * market as its source stop. Each stop's walk outcome is ignored (he asks at the door where he
   * stands); entering trades and the market ejects him at once, the job blocked until he is out.
   * A leg that ends, whatever its result, flips the target (after the first leg: A).
   */
  runJob(job: Job): number {
    if (job.kind !== TradeJob.Route) return 0;
    const u = this.w.get(job.owner), d = job.data;
    if (!u) return 0;
    if (d[RT.Paused]) return 599;
    const eco = this.w.economy;
    const a = eco.town(d[RT.From]), b = eco.town(d[RT.To]);
    if (!a || !a.alive || !b || !b.alive) { this.dropLeg(u); return this.finish(u); }
    const term = this.terminal(u);
    const homeward = d[RT.Phase] === PH.Home || d[RT.Phase] === PH.HomeGo;
    if (!homeward && b.race !== u.owner && !this.open(u.owner, b.race)) {
      this.dropLeg(u);
      d[RT.Phase] = PH.HomeGo;
    }
    for (;;) {
      switch (d[RT.Phase]) {
        case PH.Go: {
          const m = nearestTo(this.w, this.marketsOf(d[RT.Leg] ? b : a, false, term), ...cellOf(u));
          // no market in the town he heads for: the route ends, a merchant walks home (T5)
          if (!m) return this.walkHome(u);
          const src = d[RT.First] ? nearestTo(this.w, this.marketsOf(a, false, term), ...cellOf(u)) : null;
          if (src) { d[RT.Market] = src.id; d[RT.Dest] = m.id; } else { d[RT.Market] = m.id; d[RT.Dest] = -1; }
          d[RT.Phase] = PH.Next;
          continue;
        }
        case PH.Next: {
          const m = this.w.get(d[RT.Market]);
          if (!m || !m.alive) return this.legEnd(d);
          walkToEntity(this.w, u, m);   // the go-to does not look at how its walk ends
          d[RT.Phase] = PH.Arrive;
          return 1;
        }
        case PH.Arrive: {
          // the go-to's alive test (units-and-jobs.md 4.2): a dead market stops him, the leg fails
          if (goLost(this.w, u, this.w.get(d[RT.Market]))) { this.dropLeg(u); return this.legEnd(d); }
          if (u.path) return walkDelay(this.w, u);
          const m = this.w.get(d[RT.Market]);
          if (!m || !m.alive || !nearEntity(this.w, u, m)) { this.dropLeg(u); return this.legEnd(d); }
          const e = enterDoor(this.w, u, m);
          if (e > 0) return e;
          if (e < 0) return this.legEnd(d);            // refused at the door: the leg fails
          // entered: the trade, then the market ejects him at once; the route job is blocked
          // (+4 = 10) until the leave job is over (4.4 "Entering a market", T4)
          const here = eco.town(m.town);
          if (here) this.exchange(u, here, here.id === a.id ? b : a, here.id === a.id, m);
          if (u.inside >= 0) job.hold = 10;
          this.w.logistics.leave(u);
          if (!this.w.logistics.leaving(u)) job.hold = 0;
          if (d[RT.Dest] >= 0) { d[RT.Market] = d[RT.Dest]; d[RT.Dest] = -1; d[RT.Phase] = PH.Next; return 1; }
          return this.legEnd(d);
        }
        case PH.Inside:                                 // a save from before version 22
          this.w.logistics.leave(u);
          d[RT.Leg] ^= 1;
          d[RT.Phase] = PH.Go;
          return 1;
        case PH.HomeGo: {
          // state 1: a go-to into A's nearest market; the route ends when it ends
          const m = nearestTo(this.w, this.marketsOf(a, false, term), ...cellOf(u));
          if (!m) return this.walkHome(u);
          walkToEntity(this.w, u, m);
          d[RT.Market] = m.id;
          d[RT.Phase] = PH.Home;
          return 1;
        }
        case PH.Home:
          if (goLost(this.w, u, this.w.get(d[RT.Market]))) return this.finish(u);
          // an own-race merchant is not admitted at his market: the go-to ends at its door
          if (u.path) return walkDelay(this.w, u);
          return this.finish(u);
        default: return this.finish(u);
      }
    }
  }

  /** a leg child ended, whatever its result (4.4 step 6): the first leg's target becomes A, later legs flip */
  private legEnd(d: number[]): number {
    if (d[RT.First]) { d[RT.First] = 0; d[RT.Leg] = 0; } else d[RT.Leg] ^= 1;
    d[RT.Phase] = PH.Go;
    d[RT.Dest] = -1;
    return 1;
  }

  /** the leg child is deleted: its walk and its place in a door queue go */
  private dropLeg(u: Entity): void {
    leaveQueues(this.w, u);
    this.w.logistics.abortEnter(u);
    if (u.inside < 0) stopWalking(this.w, u);
  }

  private finish(u: Entity): number {
    u.job = 0;
    if (u.inside < 0 && !u.path) setIdle(this.w, u);
    return 0;
  }

  /**
   * The route ends because the town he heads for has no market (T5): a merchant gets a plain move
   * (first run after 1 tick) to the first cell of the square spiral around his own town's position
   * that is free for his movement mask (0x3E); any other trader just stops.
   */
  private walkHome(u: Entity): number {
    this.finish(u);
    if ((u.oid & 0xffff) !== MERCHANT || u.inside >= 0) return 0;
    const t = this.w.economy.town(u.town);
    if (!t) return 0;
    const c = this.w.freeSpiral(t.x, t.y, this.w.size, u);
    if (c) this.w.follow(u, c[0], c[1], 0, 1);
    return 0;
  }

  /**
   * Trading on entering a market of town M; D is the other end of the route (4.4 "At a market").
   * `atOrigin`: M is the route's origin A. `bld`: the market building entered. Returns the good
   * loaded (-1 none).
   */
  exchange(u: Entity, m: Town, dTown: Town, atOrigin: boolean, bld?: Entity): number {
    const eco = this.w.economy;
    // 1. unload into M's stock if M buys the carried good; no money here
    if (u.carryAmount > 0 && u.carryGood >= 0 && this.buys(m, u.carryGood)) {
      const g = u.carryGood;
      const n = Math.min(u.carryAmount, Math.max(0, this.get(m.id, g, MF.MaxStock) - m.stock[g]));
      // a market under construction (or one without the store flag) takes the goods into its own
      // slots, those of the delivered building materials, without a cap (4.4 step 1)
      const local = !!bld && (!bld.complete || !((this.w.rules.get(bld.oid)?.flags ?? 0) & BuildingFlag.TownStorage));
      if (n > 0 && local) {
        bld!.local[g] = (bld!.local[g] ?? 0) + n;
        u.carryAmount -= n;
        if (!u.carryAmount) u.carryGood = -1;
      } else if (n > 0) {
        eco.addGood(m, g, n);                    // clamped to the capacity, the excess is lost (4.1)
        u.carryAmount -= n;
        if (!u.carryAmount) u.carryGood = -1;
      }
    }
    // 2. choose a good: M sells, D buys, M has stock
    const races = m.race !== dTown.race;
    let best = -1, bestN = 0, bestV = -Infinity;
    for (let g = 0; g < GOODS; g++) {
      if (!this.sells(m, g) || !this.buys(dTown, g) || m.stock[g] <= 0) continue;
      const want = Math.max(0, this.get(dTown.id, g, MF.MaxStock) - dTown.stock[g]);
      const n = Math.min(CARRY_MAX, Math.max(0, m.stock[g] - this.get(m.id, g, MF.MinStock)), want);
      if (n === 0) continue;
      let v: number;
      if (atOrigin && races) {
        v = (this.get(dTown.id, g, MF.MaxPrice) - this.get(m.id, g, MF.MinPrice)) * n;
        if (v < 0) continue;                    // the buyer's price ceiling protects it
      } else v = want;                          // no price test (destination, own-race routes)
      if (v >= bestV) { best = g; bestN = n; bestV = v; }   // later goods win ties
    }
    if (best < 0) return -1;
    // 3. load: a different load is thrown away; paid at M's minimum sale price
    if (u.carryAmount > 0 && u.carryGood !== best) { u.carryAmount = 0; u.carryGood = -1; }
    let n = Math.min(bestN, CARRY_MAX - u.carryAmount);
    const price = this.get(m.id, best, MF.MinPrice);
    const seller = eco.players[m.race], buyer = eco.players[dTown.race];
    const buyerHuman = !!buyer && !buyer.computer;
    if (races && buyerHuman && price !== 0) n = Math.min(n, Math.floor(buyer.money / price));
    // n = 0 (no room, no money): the chosen good is still set, nothing moves (4.4 step 3)
    if (n <= 0) { u.carryGood = best; return -1; }
    if (races) {
      if (seller) seller.money += price * n;
      if (buyerHuman) buyer.money = Math.max(0, buyer.money - price * n);   // computer imports are free
    }
    eco.removeGood(m, best, n);
    u.carryGood = best;
    u.carryAmount += n;
    return best;
  }

  // ---------------------------------------------------------------- computer markets (4.6)

  /**
   * Market settings of a computer town, written every 150 ticks by the AI economy job (phase 2)
   * while the town has an active market. Goods 1..8; the merchant assignment of 4.6 is AI code.
   */
  computerSettings(t: Town, terminal = MARKET): void {
    if (!this.hasActiveMarket(t, terminal)) return;
    const C = t.capacity;
    for (let g = 1; g < GOODS; g++) {
      const S = Math.min(t.stock[g], C);
      const e = C > 0 ? Math.trunc(((C - S) * 100) / C) : 0;
      const base = this.basePrice(g);
      const put = (f: number, v: number) => this.set(t.id, g, f, v);
      if (g === 6 + t.race) {
        if (S >= 9) { put(MF.Sell, 1); put(MF.Buy, 0); put(MF.MinStock, 5); put(MF.MinPrice, Math.trunc((base * (e + 50)) / 100)); }
        else if (S < 5) { put(MF.Sell, 0); put(MF.Buy, 0); }
      } else if (S < 20) {
        put(MF.Buy, 1); put(MF.Sell, 0); put(MF.MaxStock, Math.trunc((C * 75) / 100)); put(MF.MaxPrice, Math.trunc((base * (e + 12)) / 100));
      } else if (S > 20 || e < 25) {
        put(MF.Sell, 1); put(MF.Buy, 0); put(MF.MinStock, Math.trunc((C * 25) / 100)); put(MF.MinPrice, Math.trunc((base * (e + 88)) / 100));
      } else {
        if (e > 40) put(MF.Sell, 0);
        if (e < 60) put(MF.Buy, 0);
      }
    }
  }

  // ---------------------------------------------------------------- state

  /**
   * A route job holds a reference on each of its two towns until it is deleted (`0047cd10`,
   * combat.md 10.4 "Lifetime of a town object"): a destroyed town it names stays in its nation's list.
   */
  holdsTown(id: number): boolean {
    for (const j of this.w.sched.jobs()) if (j.kind === TradeJob.Route && (j.data[RT.From] === id || j.data[RT.To] === id)) return true;
    return false;
  }

  snapshot(): TradeSnapshot { return { markets: this.table.map(m => (m ? [...m] : null)) }; }

  /** saves from before good 0 was locked may hold its flags set: cleared (4.2 "Rebuild") */
  restore(s: TradeSnapshot | undefined): void {
    this.table = s ? s.markets.map(m => (m ? [...m] : null)) : [];
    for (const m of this.table) if (m) { m[MF.Buy] = 0; m[MF.Sell] = 0; }
  }

  digest(mix: (v: number) => void): void {
    mix(this.table.length);
    for (const m of this.table) {
      if (!m) { mix(-1); continue; }
      for (const v of m) mix(v);
    }
  }
}
