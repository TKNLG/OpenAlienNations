// Computer players. Spec: docs/game/ai-diplomacy-trade.md sections 1, 2, 3.5 and 4.6 (section
// numbers below). Integration: docs/architecture/integration-ai.md.
//
// Everything runs as scheduler jobs, like the original: per computer player a "think" job (0x30,
// every 150 ticks: strategy, founding, attacks, diplomacy), per computer town a planner (0x32),
// an economy job (0x33) and a military job (0x34) (see ai-town.ts), at most one attack army per
// player (0x35), founding missions (0x36, using the engine's founding, job 0x0E) and the
// scouts' explore job (0x28). All randomness comes from the world's one generator; all state is
// integer and lives in the `Ai` object's `players` / `towns` records (snapshot / restore / digest) plus the jobs' data.
//
// Unit group ids (entity.group) reserve units for a purpose, as in the original (section 0):
// 51 economy gangs and merchants, 52 town defence, 53 attack army, 54 founder on a mission.

import type { Job } from './scheduler.ts';
import type { World, Entity } from './world.ts';
import type { Town, Player } from './economy.ts';
import { runPlanner, runEconomy, runMilitary, newTownState, assignArmy, type AiTown } from './ai-town.ts';
import { Logistics } from './logistics.ts';

import { AiJob, Grp, U, B, KIND_UNIT, KIND_BUILDING, KIND_NATURE } from './ai-defs.ts';
import { NJ } from './naval.ts';

/** the engine's found-town job (units-and-jobs.md 3.1 kind 0x0E) */
const LJ_FOUND = 0x0e;
export { AiJob, isAiJob, Grp, U, B, ring } from './ai-defs.ts';

const SUBCELL = 256;
const isSoldier = (t: number) => t >= U.Archer && t <= U.LastSoldier;
/** army candidate types in collection order (2.3 step 3); the add-on adds the warships 65, 66 */
const CANDIDATES = [U.Hunter, 29, 30, 31, 32, 33, 34, 35, 36];
const LIGHT_WARSHIP = 65, HEAVY_WARSHIP = 66;
const CANDIDATES_AO = [...CANDIDATES, LIGHT_WARSHIP, HEAVY_WARSHIP];

/** the six strategy profiles (1.2): weights in 1/1000 */
interface Profile {
  w1: number; w2: number; cooldown: number;
  /** offensive troops: none when base < 0; K = (P - base) / div, / divOut while an army is out */
  base: number; div: number; divOut: number;
  /** founding: smallest town population above, number of towns below */
  foundPop: number; maxTowns: number;
}
export const PROFILES: Profile[] = [
  { w1: 1500, w2: 1000, cooldown: 10, base: 6, div: 5, divOut: 4, foundPop: 20, maxTowns: 4 },
  { w1: 750, w2: 300, cooldown: 15, base: 8, div: 6, divOut: 4, foundPop: 10, maxTowns: 8 },
  { w1: 1000, w2: 500, cooldown: 15, base: 8, div: 8, divOut: 5, foundPop: 30, maxTowns: 5 },
  { w1: 1000, w2: 500, cooldown: 15, base: 6, div: 6, divOut: 4, foundPop: 30, maxTowns: 5 },
  { w1: 0, w2: 0, cooldown: 15, base: -1, div: 1, divOut: 1, foundPop: 30, maxTowns: 5 },
  { w1: 1000, w2: 500, cooldown: 15, base: 6, div: 6, divOut: 4, foundPop: 30, maxTowns: 5 },
];
/** race multipliers (1.2): threat weights x num/den, attack cooldown x num/den */
const WEIGHT_FACTOR: [number, number][] = [[10, 13], [2, 3], [1, 1]];
const COOLDOWN_FACTOR: [number, number][] = [[15, 10], [2, 1], [1, 1]];

/** setup data the AI needs besides the world (from the mission and the map) */
export interface AiConfig {
  /** per race: profile 0..5, or -1 = random (mission race block +0x08 minus 1, mission.ts `aiProfile`) */
  profiles?: number[];
  /** per race and invention: prerequisite invention indices (DV.idb, idb-wdb.md) */
  prerequisites?: number[][][];
}

/** the AI state of one computer player */
export interface AiPlayer {
  race: number;
  profile: number;
  /** think job id */
  think: number;
  /** attack army: job id (0 = none), target town, members */
  army: number;
  armyTown: number;
  armyMembers: number[];
  /** tick of the last army run (cooldown, 2.4) */
  lastArmy: number;
  /** tick of the last diplomatic mission per race (3.5) */
  lastMission: number[];
  /**
   * Known towns (AI general +0x3C, 2.2 "Intruders", 2.4 profile 2): every town whose area a unit
   * of this player stepped into, any race, in id order; destroyed towns leave it
   */
  discovered: number[];
  /** research cursor of the race's invention table (1.11) */
  cursor: number;
  /** inventions ever selected by a town of the race ("started", invention byte +0x3C, 1.11), sorted */
  started: number[];
  /** running founding mission job id, 0 none */
  founding: number;
  /** no founding site left on the map */
  noSite: number;
}

export interface AiSnapshot {
  v: 1;
  prerequisites: number[][][];
  players: (AiPlayer | null)[];
  towns: (AiTown | null)[];
}

export class Ai {
  readonly w: World;
  prerequisites: number[][][] = [[], [], []];
  players: (AiPlayer | null)[] = [null, null, null];
  /** indexed by town id */
  towns: (AiTown | null)[] = [];

  constructor(w: World) { this.w = w; }

  // ---------------------------------------------------------------- setup

  /**
   * Start the computer players (1.1): a think job one tick later for every computer player that
   * has none yet, and the town jobs for every computer town with an active town hall. Safe to
   * call again (e.g. after a free-play populator added towns).
   */
  start(cfg: AiConfig = {}): void {
    if (cfg.prerequisites) this.prerequisites = [0, 1, 2].map(r => (cfg.prerequisites![r] ?? []).map(l => [...l]));
    const eco = this.w.economy;
    for (const p of eco.players) {
      if (!p || !p.computer || this.players[p.race]) continue;
      let profile = cfg.profiles?.[p.race] ?? -1;
      // 0 in the race block = random: drawn once in the think job's constructor (1.2)
      if (!(profile >= 0 && profile < PROFILES.length)) profile = this.rand() % 3;
      this.players[p.race] = {
        race: p.race, profile, think: this.w.sched.create(AiJob.Think, p.race, 1).id,
        army: 0, armyTown: -1, armyMembers: [], lastArmy: 0, lastMission: [0, 0, 0], discovered: [], cursor: 0, started: [],
        founding: 0, noSite: 0,
      };
      // add-on: the naval planner next to the think job (docs/game/addon.md 8.4)
      if (this.w.addon) this.w.naval.startPlanner(p.race);
      this.ensureTownJobs(p);
      // laboratories made active by the map loader, before the computer player existed: their
      // activation pick (1.11, `0045fa40`) is made now
      for (const id of p.towns) {
        const t = this.w.economy.towns[id];
        if (t && t.alive && this.w.entities.some(e => e.kind === KIND_BUILDING && e.town === t.id && e.alive && e.active && (e.oid & 0xffff) === B.Lab)) this.labActive(t);
      }
    }
  }

  /** the three town jobs, started when the town hall is active (0045fa40): delays 1 / 16 / 33 */
  startTown(t: Town): AiTown {
    let s = this.towns[t.id];
    if (!s) { s = newTownState(t.id, this.w.typeWidth); while (this.towns.length <= t.id) this.towns.push(null); this.towns[t.id] = s; }
    const sch = this.w.sched;
    if (!this.live(s.planner)) s.planner = sch.create(AiJob.Planner, t.id, 1, [0]).id;
    if (!this.live(s.economy)) s.economy = sch.create(AiJob.Economy, t.id, 16, [0]).id;
    if (!this.live(s.military)) s.military = sch.create(AiJob.Military, t.id, 33, [0]).id;
    return s;
  }

  private ensureTownJobs(p: Player): void {
    for (const id of p.towns) {
      const t = this.w.economy.towns[id];
      if (!t || !t.alive) continue;
      const hall = this.w.get(t.hall);
      if (!hall || !hall.active) continue;
      const s = this.towns[t.id];
      if (!s || !this.live(s.planner) || !this.live(s.economy) || !this.live(s.military)) this.startTown(t);
    }
  }

  /** the map's point lists (1.13): forest, stone, bush regions, start candidates, start positions */
  points(k: number): [number, number][] { return this.w.lists[k] ?? []; }

  live(id: number): boolean { const j = id ? this.w.sched.get(id) : undefined; return !!j && !j.cancelled; }
  rand(): number { return this.w.rand.next(); }
  town(id: number): AiTown | null { return this.towns[id] ?? null; }
  isComputer(race: number): boolean { return !!this.players[race]; }

  /**
   * AI alert of the strike notification (`combat.md` 7 step 1, `00462e30` -> `0046cab0`): victim v
   * of a computer nation was struck at by a unit of another race while v stands in territory of its
   * own race; the attacker is recorded on the military job of the town owning that territory, one
   * record per strike (duplicates kept, 2.2 "Intruders").
   */
  alert(v: Entity, a: Entity): void {
    const race = v.oid >>> 16;
    if (!a.alive || !this.players[race]) return;
    const [x, y] = this.cell(v);
    const t = this.w.economy.town(this.w.territory.ownerAt(x, y));
    if (!t || !t.alive || t.race !== race) return;
    const s = this.towns[t.id];
    if (!s || !this.live(s.military)) return;
    (s.intruders ??= []).push(a.id);
  }

  /**
   * A unit stepped onto cell (x, y) (`World.stepTo`, the position setter `004621c0`; spec 2.2
   * "Intruders"): inside the area of a town of a computer nation other than its own it is recorded
   * on that town's military job (every step, duplicates kept); a unit of a computer nation adds
   * the area's town to its nation's known towns.
   */
  stepped(e: Entity, x: number, y: number): void {
    const t = this.w.economy.town(this.w.territory.ownerAt(x, y));
    if (!t) return;
    if (t.race !== e.owner && this.players[t.race] && e.alive) {
      const s = this.towns[t.id];
      if (s && this.live(s.military)) (s.intruders ??= []).push(e.id);
    }
    const ps = this.players[e.owner];
    if (ps && !ps.discovered.includes(t.id)) { ps.discovered.push(t.id); ps.discovered.sort((a, b) => a - b); }
  }

  /** a computer army holds its target town (town +0x38, spec 2.5): it stays in its nation's list */
  holdsTown(id: number): boolean {
    return this.players.some(p => !!p && p.armyTown === id && this.live(p.army));
  }

  // ---------------------------------------------------------------- research (1.11)

  /**
   * The race's pick (`00410490`): the cursor advances past every entry examined; the first
   * invention neither started nor complete whose prerequisites are all complete, -1 none.
   */
  private pickResearch(ps: AiPlayer): number {
    const eco = this.w.economy, p = eco.players[ps.race];
    if (!p) return -1;
    const pre = this.prerequisites[ps.race] ?? [];
    ps.started ??= [];
    while (ps.cursor < p.costs.length) {
      const i = ps.cursor++;
      if (ps.started.includes(i) || eco.researched(p, i)) continue;
      if ((pre[i] ?? []).every(q => eco.researched(p, q))) return i;
    }
    return -1;
  }

  /** select a project in a town (`0045a570`): marks the invention started for the race */
  private invent(ps: AiPlayer, t: Town, i: number): void {
    if (!ps.started.includes(i)) { ps.started.push(i); ps.started.sort((a, b) => a - b); }
    this.w.economy.selectResearch(t, i);
  }

  /**
   * A laboratory of computer town t became active (`0045fa40`, every activation): the race's
   * cursor goes back to 0 and the pick is selected, replacing a running project; no pick: nothing.
   */
  labActive(t: Town): void {
    const ps = this.players[t.race];
    if (!ps) return;
    ps.cursor = 0;
    const i = this.pickResearch(ps);
    if (i >= 0) this.invent(ps, t, i);
  }

  /**
   * Computer town t completed its project (`0046f490`, the research step): the pick is made first;
   * then the stonemason's, else the woodcutter's required invention if not invented and not the
   * pick, else the pick; nothing left: the town's project stays -1.
   */
  researchDone(t: Town): void {
    const ps = this.players[t.race];
    const p = this.w.economy.players[t.race];
    if (!ps || !p) return;
    const pick = this.pickResearch(ps);
    for (const ty of [U.Stonemason, U.Woodcutter]) {
      const i = this.w.rules.get(((t.race << 16) | ty) >>> 0)?.invention ?? -1;
      if (i >= 0 && !this.w.economy.researched(p, i) && i !== pick) { this.invent(ps, t, i); return; }
    }
    if (pick >= 0) this.invent(ps, t, pick);
  }

  // ---------------------------------------------------------------- jobs

  runJob(job: Job): number {
    switch (job.kind) {
      case AiJob.Think: return this.runThink(job);
      case AiJob.Planner: return runPlanner(this, job);
      case AiJob.Economy: return runEconomy(this, job);
      case AiJob.Military: return runMilitary(this, job);
      case AiJob.Army: return this.runArmy(job);
      case AiJob.Founding: return this.runFounding(job);
      case AiJob.Explore: return this.runExplore(job);
      default: return 0;
    }
  }

  // ---------------------------------------------------------------- geometry helpers

  cell(e: Entity): [number, number] { return [Math.floor(e.x / SUBCELL), Math.floor(e.y / SUBCELL)]; }
  dist(ax: number, ay: number, bx: number, by: number): number { return this.w.logistics.dist(ax, ay, bx, by); }
  distTo(e: Entity, x: number, y: number): number { const [ex, ey] = this.cell(e); return this.dist(ex, ey, x, y); }
  wrap(d: number): number { const n = this.w.size; return d > n / 2 ? d - n : d < -n / 2 ? d + n : d; }
  mask(v: number): number { return v & (this.w.size - 1); }

  /** the town hall's radius (25, odb.md): sets the "anywhere in town" search radius (1.5) */
  radius(t: Town): number {
    const hall = this.w.get(t.hall);
    return (hall && this.w.rules.get(hall.oid)?.radius) || 25;
  }

  /** start walking to a cell with one plan made at once (World.walk); true if a path exists (or already there) */
  walk(u: Entity, x: number, y: number): boolean {
    const ok = this.w.walk(u, this.mask(x), this.mask(y));
    if (ok && u.path && u.action !== 0) { u.action = 0; u.actionTick = this.w.tick; }
    return ok;
  }

  /**
   * One follow-path walk (job 0x06, `World.follow`, units-and-jobs.md 4.1) to a cell however far,
   * with the original planner and its re-plans; first run after `delay` ticks (0: planned in this
   * tick). False only where the walk fails at once (add-on: another island).
   */
  walkToward(u: Entity, x: number, y: number, delay = 0): boolean {
    const ok = this.w.follow(u, this.mask(x), this.mask(y), 0, delay);
    if (ok && u.path && u.action !== 0) { u.action = 0; u.actionTick = this.w.tick; }
    return ok;
  }

  /**
   * A unit gives up its reservation; with `home` it stops its job and walks back to the first free
   * cell of a spiral around its town's position (integration-ai.md 7 item 7)
   */
  release(u: Entity, home: boolean): void {
    u.group = Grp.None;
    if (!home) return;
    this.w.logistics.cancelJob(u);
    const t = this.w.economy.town(u.town);
    if (!t || u.inside >= 0) return;
    const [gx, gy] = this.w.freeSpiral(t.x, t.y, 24, u) ?? [t.x, t.y];
    this.walkToward(u, gx, gy);
  }

  /**
   * A "free" unit of group g (section 0, `0045b110`): alive, group id g, and either outside with no
   * job or on a leisure visit (unless inside a building with a job). The dispatcher's test.
   */
  free(u: Entity, g: number = Grp.None): boolean { return Logistics.free(u, g); }

  /**
   * The town's list of a building type (sites included) in the original's order: creation order,
   * buildings moved to the back by the AI (training round robin 1.7, outpost anchors 1.5) last.
   */
  list(t: Town, type: number): Entity[] {
    const s = this.towns[t.id];
    const keys = new Map<number, number>();
    if (s?.moved) for (let i = 0; i + 1 < s.moved.length; i += 2) keys.set(s.moved[i], s.moved[i + 1]);
    const out: Entity[] = [];
    for (const e of this.w.entities) {
      if (e.kind === KIND_BUILDING && e.town === t.id && e.alive && (e.oid & 0xffff) === type && (e.oid >>> 16) === t.race) out.push(e);
    }
    if (keys.size) {
      const key = (e: Entity) => keys.get(e.id) ?? e.id * 65536;
      out.sort((a, b) => key(a) - key(b));
    }
    return out;
  }

  /** move a building to the back of its type list (`0046c670`, `0046c1a0`) */
  moveToBack(t: Town, b: Entity): void {
    const s = this.towns[t.id];
    if (!s) return;
    s.moved ??= [];
    // forget buildings that are gone
    const kept: number[] = [];
    for (let i = 0; i + 1 < s.moved.length; i += 2) {
      const e = this.w.get(s.moved[i]);
      if (e && e.alive && e.id !== b.id) kept.push(s.moved[i], s.moved[i + 1]);
    }
    // after every object that exists now, before every object created later: ids are increasing
    let maxId = 0;
    for (const e of this.w.entities) if (e.id > maxId) maxId = e.id;
    let key = maxId * 65536 + 1;
    for (let i = 1; i < kept.length; i += 2) if (kept[i] >= key) key = kept[i] + 1;
    kept.push(b.id, key);
    s.moved = kept;
  }

  // ---------------------------------------------------------------- strength (2.1)

  private maxDamage(race: number, type: number): number {
    const r = this.w.rules.get(((race << 16) | type) >>> 0);
    return r && r.weapon >= 0 ? (this.w.weapons[r.weapon]?.max ?? 0) : 0;
  }

  /** 500 + weapon maxima of soldiers, hunters and saboteurs of the player's towns */
  strength(race: number): number {
    const eco = this.w.economy;
    const counts = new Array<number>(this.w.typeWidth).fill(0);
    for (const e of this.w.entities) {
      if (e.kind !== KIND_UNIT || e.owner !== race || (e.oid >>> 16) !== race || !e.alive) continue;
      const t = eco.town(e.town);
      if (!t || !t.alive || t.race !== race) continue;
      counts[e.oid & 0xffff]++;
    }
    let s = 500;
    for (let ty = U.Archer; ty <= U.LastSoldier; ty++) if (counts[ty]) s += counts[ty] * this.maxDamage(race, ty);
    s += counts[U.Hunter] * this.maxDamage(race, U.Hunter) + counts[U.Saboteur] * this.maxDamage(race, U.Saboteur);
    return s;
  }

  /** fight power of a unit (2.1, tactic 0): HP x 100 + maxDamage x 500 / cooldown; priests count 0 */
  power(e: Entity): number {
    if (e.kind !== KIND_UNIT || (e.oid & 0xffff) === U.Priest) return 0;
    const r = this.w.rules.get(e.oid);
    const wp = r && r.weapon >= 0 ? this.w.weapons[r.weapon] : undefined;
    if (!wp) return 0;
    return e.hp * 100 + Math.trunc((wp.max * 500) / Math.max(1, wp.cooldown));
  }

  living(race: number): boolean {
    const p = this.w.economy.players[race];
    return !!p && !p.defeated && p.towns.some(id => this.w.economy.towns[id]?.alive);
  }

  /** "the local human player" (2.4): the first human player in race order, -1 none */
  human(): number {
    for (const p of this.w.economy.players) if (p && !p.computer) return p.race;
    return -1;
  }

  /** relation state 0 none, 1 war, 2 ceasefire, 3 peace */
  relation(a: number, b: number): number { return this.w.diplomacy.relation(a, b); }
  hostile(a: number, b: number): boolean { const r = this.relation(a, b); return r === 0 || r === 1; }

  // ---------------------------------------------------------------- the think job (0x30, 1.2, 2.3, 2.4, 3.5)

  private runThink(job: Job): number {
    const ps = this.players[job.owner];
    const p = this.w.economy.players[job.owner];
    if (!ps || !p) return 0;
    if (p.defeated) { if (ps.army) this.endArmy(ps); return 0; }
    this.ensureTownJobs(p);
    const towns = p.towns.map(id => this.w.economy.towns[id]).filter((t): t is Town => !!t && t.alive && !!this.towns[t.id]);
    // destroyed towns leave the known towns (`00459400`; the steps add towns, `stepped`)
    ps.discovered = ps.discovered.filter(id => this.w.economy.towns[id]?.alive);
    const prof = PROFILES[ps.profile];
    // order of work (0.1): diplomacy, then the strategy routine per town, then attack or join,
    // then founding
    this.diplomacy(ps, prof);
    const candidates: Entity[] = [];
    const pr = ps.profile;
    for (const t of towns) {
      const s = this.towns[t.id]!;
      // profile 0 keeps a quarter of its defence free once a town was not under attack (2.2)
      if (pr === 0 && !s.underAttack) s.reserve = 25;
      if (pr !== 3 && pr !== 5) this.scouts(ps, t, s);
      if (pr === 4) continue;
      this.troopWants(ps, t, s, prof);
      // army candidates (2.3 step 3, `00468b10`): free group-0 hunters first, then soldiers 29..36;
      // add-on mode: then the free light and heavy warships (`00470140`)
      for (const ty of this.w.addon ? CANDIDATES_AO : CANDIDATES) {
        for (const e of this.w.entities) {
          if (e.kind === KIND_UNIT && e.town === t.id && (e.oid & 0xffff) === ty && (e.oid >>> 16) === t.race && this.free(e)) candidates.push(e);
        }
      }
    }
    if (pr !== 4) {
      if (ps.army && this.live(ps.army)) this.joinArmy(ps, candidates);
      else { ps.army = 0; this.considerAttack(ps, candidates, prof); }
    }
    this.considerFounding(ps, towns, prof);
    return 150;
  }

  /** scout want C[24] and explorers (2.3 step 1) */
  private scouts(ps: AiPlayer, t: Town, s: AiTown): void {
    const P = t.population;
    let want = 0;
    if (ps.profile === 0 || ps.profile === 1) want = P < 13 ? Math.trunc(P / 6) : 2;
    else if (ps.profile === 2 || ps.profile === 4) want = P > 15 ? 1 : 0;
    s.C[U.Scout] = want;
    // `00468e10`: the list starts empty (its group test asks for 48, which no unit has), so up to
    // `want` MORE free group-0 scouts (town-list order, cut from the end) get an explore job every
    // think, first run 1 + rand() mod 5 each; a leisure visit is cancelled first. Exploring scouts
    // are not free, so in the long run every idle scout explores, those trained for watchtowers too.
    if (want <= 0) return;
    const free: Entity[] = [];
    for (const e of this.w.entities) {
      if (e.kind === KIND_UNIT && e.town === t.id && (e.oid & 0xffff) === U.Scout && (e.oid >>> 16) === t.race && this.free(e)) free.push(e);
    }
    for (const e of free.slice(0, want)) this.w.logistics.assign(e, AiJob.Explore, 1 + (this.rand() % 5), [0, 0, 0, 0]);
  }

  /** offensive troop wants (2.3 step 2, `00468a60`) */
  private troopWants(ps: AiPlayer, t: Town, s: AiTown, prof: Profile): void {
    if (prof.base < 0) return;
    const P = t.population;
    if (P <= prof.base) return;
    let K = Math.trunc((P - prof.base) / (ps.army ? prof.divOut : prof.div));
    for (let ty = U.LastSoldier; ty >= U.Archer; ty--) {
      if (!this.trainable(t, ty)) continue;
      const share = Math.trunc(K / 2);
      s.C[ty] = share;
      K -= share;
    }
    s.C[U.Hunter] = Math.min(5, K);
  }

  /**
   * A unit type can be ordered in this town now (2.2, 2.3): the **first** building of its training
   * type in the town's list (sites included) is active and the order check passes.
   */
  trainable(t: Town, type: number): boolean {
    const r = this.w.rules.get(((t.race << 16) | type) >>> 0);
    if (!r) return false;
    const first = this.list(t, r.madeAt)[0];
    return !!first && first.active && this.w.logistics.trainState(t, first, type) === 1;
  }

  // ---------------------------------------------------------------- founding (1.12)

  private considerFounding(ps: AiPlayer, towns: Town[], prof: Profile): void {
    if (!towns.length || ps.noSite || !this.points(3).length) return;
    let small = towns[0];
    for (const t of towns) if (t.population < small.population) small = t;
    const s = this.towns[small.id]!;
    if (small.population > prof.foundPop && towns.length < prof.maxTowns) {
      s.C[U.Founder] = 1;
      if (ps.founding && this.live(ps.founding)) return;
      const f = this.w.entities.find(e => e.kind === KIND_UNIT && e.town === small.id && (e.oid & 0xffff) === U.Founder &&
        (e.oid >>> 16) === small.race && this.free(e));
      if (f) ps.founding = this.w.sched.create(AiJob.Founding, ps.race, 1 + (this.rand() % 50), [small.id, 0, 0, 0, 0, ...(this.w.addon ? [0] : [])]).id;
    }
  }

  /** the unit stands in the town's territory (economy.md 11.7) */
  inTerritory(e: Entity, t: Town): boolean {
    const [x, y] = this.cell(e);
    return this.w.territory.ownerAt(x, y) === t.id;
  }

  /**
   * A town site (1.12 step 2): the engine's founding test with the territory rule (flag 0x1000,
   * economy.md 11.7), and the disc the new town hall would claim (radius 25, `0045dc10`) clear of
   * every territory too.
   */
  private siteValid(race: number, x: number, y: number): boolean {
    if (!this.w.logistics.canFound(race, this.mask(x), this.mask(y), true)) return false;
    const R = this.w.rules.get(((race << 16) | B.TownHall) >>> 0)?.radius || 25;
    return this.w.territory.discFree(this.mask(x), this.mask(y), R);
  }

  /**
   * The founding site (1.12 step 3): around each start candidate in file order the site-search
   * ring walk with radius 20 (`00449c00`, world-populate.md 2.3: the candidate, rings 1..9, the
   * corner of ring 10); the first valid cell wins.
   */
  private findSite(race: number): [number, number] | null {
    for (const [px, py] of this.points(3)) {
      const c = this.w.naval.siteSearch(px, py, 20, (x, y) => this.siteValid(race, x, y));
      if (c) return c;
    }
    return null;
  }

  /**
   * Founding mission (0x36, every 50 ticks; 1.12 run order a..f): data [town, founder, x, y, has
   * target] plus, in the add-on, [ship request]. A founder inside a building or aboard a ship ends
   * the mission and keeps group 54 (step b, quirk: he never founds and blocks the town's founding).
   */
  private runFounding(job: Job): number {
    const ps = this.players[job.owner];
    const d = job.data;
    if (!ps) return 0;
    const end = (f?: Entity) => { if (f && f.group === Grp.Founder) f.group = Grp.None; if (ps.founding === job.id) ps.founding = 0; return 0; };
    const t = this.w.economy.town(d[0]);
    if (!t || !t.alive) return end();
    if (!d[1]) {
      const f = this.w.entities.find(e => e.kind === KIND_UNIT && e.town === t.id && (e.oid & 0xffff) === U.Founder &&
        (e.oid >>> 16) === t.race && this.free(e));
      if (!f) return end();
      f.group = Grp.Founder;
      d[1] = f.id;
    }
    const f = this.w.get(d[1]);
    if (!f || !f.alive || (f.oid & 0xffff) !== U.Founder || f.group !== Grp.Founder) return end(f);
    // b: inside a building or a ship: the mission ends, the founder stays in group 54
    if (f.inside >= 0) { if (ps.founding === job.id) ps.founding = 0; return 0; }
    // c: the target is no longer valid: look for a new one; the founder's job (and a ship request) is dropped
    if (!d[4] || !this.siteValid(ps.race, d[2], d[3])) {
      const site = this.findSite(ps.race);
      if (!site) { ps.noSite = 1; return end(f); }
      [d[2], d[3]] = site; d[4] = 1;
      const j = f.job ? this.w.sched.get(f.job) : undefined;
      if (j && !j.cancelled) {
        if (j.kind === NJ.Wait && d[5]) this.w.naval.cancelRequest(ps.race, d[5]);
        this.w.logistics.cancelJob(f);
      }
      if (f.path) this.w.halt(f);
      if (d[5] !== undefined) d[5] = 0;
      return 50;
    }
    const dist = this.distTo(f, d[2], d[3]);
    // d: 8..15 cells from the site: found the town (the engine's founding, units-and-jobs.md 11)
    if (dist >= 8 && dist <= 15) {
      const j = f.job ? this.w.sched.get(f.job) : undefined;
      if (j && !j.cancelled && j.kind === LJ_FOUND) return 50;
      f.group = Grp.None;
      if (this.w.logistics.found(f, d[2], d[3])) {
        const s = this.towns[t.id];
        if (s) s.C[U.Founder] = 0;
        return end();
      }
      f.group = Grp.Founder;
      d[4] = 0;   // taken meanwhile: look again next run
      return 50;
    }
    // e: busy (a job, or a walk under way)
    if (f.job || f.path) return 50;
    // f: a free cell 8..15 from the site (30-ring search); another island: ask for a ship
    const c = this.approachCell(d[2], d[3]);
    if (!c) return 50;
    if (this.w.addon) {
      const here = this.w.islandAt(...this.cell(f)), there = this.w.islandAt(c[0], c[1]);
      if (here !== there) {
        const [fx, fy] = this.cell(f);
        d[5] = this.w.naval.request(ps.race, 1, 0, fx, fy, c[0], c[1]);
        if (d[5]) this.w.naval.addWaiting(ps.race, d[5], f);
        return 50;
      }
    }
    // a follow-path walk to it, first run after 5 ticks (spec 1.12 step f)
    this.walkToward(f, c[0], c[1], 5);
    return 50;
  }

  /**
   * The founder's goal (1.12 step f, `0046ef70`): the 30-ring site search around the site
   * (world-populate.md 2.3) for a cell that is free land and 8..15 cells from it.
   */
  private approachCell(x: number, y: number): [number, number] | null {
    return this.w.naval.siteSearch(x, y, 30, (px, py) => {
      const dist = this.dist(px, py, x, y);
      if (dist < 8 || dist > 15 || this.w.blocked[(py << this.w.bits) | px]) return false;
      return !this.w.addon || this.w.islandAt(px, py) !== 0;
    });
  }

  // ---------------------------------------------------------------- scouts (0x28)

  /**
   * The scout job (0x28, combat.md 15): while its walk runs, the walk's delays are the job's (a
   * step, a turn, a wait). When the walk has ended (any result): x = rand, y = rand, the first cell
   * of the square spiral around (x, y) free for the path mask (0x3C, units do not count), one
   * follow-path walk there whose first run (first plan) comes rand() % 5 + 1 ticks later, which is
   * also the job's delay. Data [x, y, has target, legs]: the goal cell and 1 while a walk was made.
   */
  private runExplore(job: Job): number {
    const u = this.w.get(job.owner), d = job.data;
    if (!u || u.job !== job.id) return 0;
    if (u.path) {
      if (this.w.isShip(u)) return 10;
      const tick = this.w.tick, stepEnd = u.stepStart + u.stepTicks;
      if (u.stepTicks > 0 && stepEnd > tick) return stepEnd - tick;
      return u.moveAt > tick ? Math.min(599, u.moveAt - tick) : 1;
    }
    if (this.w.isShip(u)) return this.exploreShip(u);
    const x = this.rand() % this.w.size, y = this.rand() % this.w.size;
    const c = this.w.naval.spiral(x, y, this.w.size, (px, py) => this.w.blocked[(this.mask(py) << this.w.bits) | this.mask(px)] === 0);
    const delay = 1 + (this.rand() % 5);
    d[0] = c ? c[0] : x; d[1] = c ? c[1] : y; d[2] = 0; d[3] = 0;
    if (c && this.w.follow(u, c[0], c[1], 0, delay)) d[2] = 1;
    return delay;
  }

  /**
   * The explore job of a ship (the AI's patrolling warship, addon.md 8.2): a random map cell, the
   * nearest cell of a square spiral around it that the ship may use, one walk there; the next
   * round after rand() % 5 + 1 ticks once the walk is over (arrived, or no way to another sea).
   */
  private exploreShip(u: Entity): number {
    const x = this.rand() % this.w.size, y = this.rand() % this.w.size;
    const c = this.w.naval.spiral(x, y, this.w.size >> 1, (px, py) => this.w.shipBlocked[(this.mask(py) << this.w.bits) | this.mask(px)] === 0);
    if (c) this.walk(u, c[0], c[1]);
    return 1 + (this.rand() % 5);
  }

  // ---------------------------------------------------------------- attacks (2.4, 2.5)

  private considerAttack(ps: AiPlayer, cands: Entity[], prof: Profile): void {
    const human = this.human();
    if (human < 0) return;
    const hostile = this.hostile(ps.race, human);
    const tick = this.w.tick;
    const n = cands.length;
    const cooled = tick - ps.lastArmy > Math.trunc((prof.cooldown * COOLDOWN_FACTOR[ps.race][0]) / COOLDOWN_FACTOR[ps.race][1]);
    const me = this.strength(ps.race);
    const others = [0, 1, 2].filter(r => r !== ps.race && this.living(r));
    const firstTown = (race: number) => this.w.economy.players[race]!.towns.map(id => this.w.economy.towns[id]).find(t => t?.alive);
    const humanTowns = () => (this.w.economy.players[human]?.towns ?? []).map(id => this.w.economy.towns[id]).filter((t): t is Town => !!t && t.alive);
    let target: Town | undefined;
    let size = n;
    switch (ps.profile) {
      case 0: {
        if (!(n > Math.min(10, Math.trunc(tick / 30000)) && cooled && hostile)) return;
        const r = others.find(o => this.strength(o) * 5 < me * 10 || tick < 54000);
        if (r !== undefined) target = firstTown(r);
        break;
      }
      case 1: {
        if (!(n > Math.min(20, Math.trunc(tick / 20000)) && cooled && hostile)) return;
        const r = others.find(o => this.strength(o) < me);
        if (r !== undefined) target = firstTown(r);
        break;
      }
      case 2: {
        if (!(n > Math.min(20, Math.trunc(tick / 30000)) && cooled && hostile)) return;
        if (!(me * 2 > this.strength(human) * 3)) return;
        target = ps.discovered.map(id => this.w.economy.towns[id]).find(t => !!t && t.alive && t.race === human);
        break;
      }
      case 3: {
        if (n <= 2) return;
        // rand() mod 1 (always 0: passes), then the cut, both before the hostility test (2.4)
        if (this.rand() % 1 !== 0) return;
        size = this.rand() % 3 + 1;
        if (!hostile) return;
        const ht = humanTowns();
        if (!ht.length) return;
        target = ht[this.rand() % ht.length];
        break;
      }
      case 5: {
        const k = tick < 60000 ? 1 : Math.min(15, Math.trunc(tick / 20000) + 4);
        if (n <= k + 1) return;
        size = k + this.rand() % 3;
        if (!hostile) return;
        const ht = humanTowns();
        if (!ht.length) return;
        target = ht[this.rand() % ht.length];
        break;
      }
      default: return;
    }
    if (!target) return;
    // the cut erases candidates from the front: the army keeps the LAST `size` (2.4)
    const members = cands.slice(Math.max(0, n - size));
    if (!members.length) return;
    ps.armyTown = target.id;
    ps.armyMembers = [];
    ps.lastArmy = tick;
    // the tactic (rand() & 1, in the army's constructor), the join, then the first run rand() mod 50
    // (the join draws nothing, so the delay can be drawn before the job is created)
    const tactic = this.rand() & 1;
    const delay = this.rand() % 50;
    ps.army = this.w.sched.create(AiJob.Army, ps.race, delay, [target.id, target.x, target.y, tactic]).id;
    this.joinArmy(ps, members);
  }

  /**
   * Candidates join the army (`00465ad0`; Gold `0046c050`, spec 2.5 "Joining and moving"): group
   * 53; a member farther than 20 cells from the target point walks there on its own. Add-on mode:
   * joining warships sail to the nearest ship cell of the target town; the land units are grouped
   * by island, the group on the target's island walks as in the base game, every other group makes
   * one transport request (pickup = its first member, destination = the target point) and its
   * members wait for the ship (job 0x3E), whatever the request's result.
   */
  private joinArmy(ps: AiPlayer, cands: Entity[]): void {
    const t = this.w.economy.town(ps.armyTown);
    if (!t) return;
    const joined: Entity[] = [];
    for (const u of cands) {
      if (u.group !== Grp.None) continue;
      u.group = Grp.Army;
      ps.armyMembers.push(u.id);   // join order (`00465ad0`)
      joined.push(u);
    }
    // `00465ad0` (units-and-jobs.md 4.7): a member farther than 20 from the target point walks to
    // the first cell of the 4.8 spiral around it whose flags miss 0x3E (one cell for the whole
    // join: nobody moves before the walks start), first run after 2 ticks
    let spot: [number, number] | null = null;
    const walkIn = (u: Entity) => {
      if (this.distTo(u, t.x, t.y) <= 20) return;
      spot ??= this.w.freeSpiral(t.x, t.y, this.w.size >> 1) ?? [t.x, t.y];
      this.w.logistics.cancelJob(u);
      this.walkToward(u, spot[0], spot[1], 2);
    };
    if (!this.w.addon) { for (const u of joined) walkIn(u); return; }
    const groups = new Map<number, Entity[]>();
    for (const u of joined) {
      if (this.w.isShip(u)) { this.sailToTown(u, t); continue; }
      const isl = this.w.islandAt(...this.cell(u));
      const g = groups.get(isl);
      if (g) g.push(u); else groups.set(isl, [u]);
    }
    if (!this.w.naval.planner(ps.race)) return;
    const target = this.w.islandAt(t.x, t.y);
    for (const isl of [...groups.keys()].sort((a, b) => a - b)) {
      const g = groups.get(isl)!;
      if (isl === target) { for (const u of g) walkIn(u); continue; }
      const [px, py] = this.cell(g[0]);
      // the request record's default flags (1): refused while the planner holds > 50 requests
      const req = this.w.naval.request(ps.race, g.length, 0, px, py, t.x, t.y, 1);
      for (const u of g) {
        if (req) this.w.naval.addWaiting(ps.race, req, u);
        else this.w.logistics.assign(u, NJ.Wait, 5, []);
      }
    }
  }

  /** a joining warship sails to the first cell of a spiral around the target town that a ship may use (`0046c050`) */
  private sailToTown(u: Entity, t: Town): void {
    this.w.logistics.cancelJob(u);
    const c = this.w.naval.spiral(t.x, t.y, this.w.size >> 1, (px, py) => this.w.shipBlocked[(this.mask(py) << this.w.bits) | this.mask(px)] === 0);
    if (c) this.walk(u, c[0], c[1]);
  }

  /**
   * Every surviving member is released and walks home; the player's army slot is cleared
   * (`004657c0`, spec 2.5 last bullet): group 0, its current job cancelled, one follow-path walk
   * to the first free cell of a spiral around its home town, however far (not a leg: no job would
   * issue the next one). The original's walk starts after rand() mod 10 + 2 ticks: one draw per
   * living member, in member order.
   */
  private endArmy(ps: AiPlayer): number {
    for (const id of ps.armyMembers) {
      const u = this.w.get(id);
      if (!u || u.group !== Grp.Army) continue;
      const delay = u.alive ? (this.rand() % 10) + 2 : 0;
      this.release(u, false);
      this.w.logistics.cancelJob(u);
      const t = this.w.economy.town(u.town);
      if (!t || u.inside >= 0) continue;
      const [gx, gy] = this.w.freeSpiral(t.x, t.y, 24, u) ?? [t.x, t.y];
      this.walkToward(u, gx, gy, delay);
    }
    ps.armyMembers = [];
    ps.army = 0;
    ps.armyTown = -1;
    return 0;
  }

  /** the army (0x35, every 50 ticks): data [target town, x, y, tactic] */
  private runArmy(job: Job): number {
    const ps = this.players[job.owner], d = job.data;
    if (!ps || ps.army !== job.id) return 0;
    // only the relation ends a running army: after its target town fell it goes on around the
    // stored target point against that race (2.5 "When the target town falls")
    const tt = this.w.economy.town(d[0]);
    if (!tt || !this.hostile(ps.race, tt.race)) return this.endArmy(ps);
    ps.lastArmy = this.w.tick;
    const members: Entity[] = [];
    for (const id of ps.armyMembers) {
      const u = this.w.get(id);
      if (u && u.alive && u.group === Grp.Army && u.owner === ps.race) members.push(u);
    }
    ps.armyMembers = members.map(u => u.id);
    if (!members.length) return this.endArmy(ps);
    const [x, y] = [d[1], d[2]];
    const R = 40;
    // candidates: alive objects of a race 0..2; with a target town (always, here) only those of
    // the target town's race, without a relation test (2.5 step 3)
    const ofTarget = (e: Entity) => e.kind !== KIND_NATURE && e.alive && (e.oid >>> 16) === tt.race;
    const near = this.w.combat.scan(x, y, R).filter(ofTarget);
    const tier = (e: Entity) => this.w.combat.tier(e);
    let targets: Entity[];
    let perTarget: number;
    let reassign: (cc: number) => boolean;
    if (d[3] === 0) {
      // assault (`00466020`): the circle plus all of the town's outposts, barracks, magic buildings
      // and creature yards; bucket 0 first gets ONE building, the first of the important list
      const extra = this.w.entities.filter(e => e.kind === KIND_BUILDING && e.town === tt.id && ofTarget(e) &&
        ([B.SmallOutpost, B.LargeOutpost, B.Barracks, B.MageTower, B.CreatureYard] as number[]).includes(e.oid & 0xffff));
      const set = new Map<number, Entity>();
      for (const e of [...near, ...extra]) set.set(e.id, e);
      let important: Entity | undefined;
      for (const ty of [B.Barracks, B.School, B.Lab, B.LargeOutpost, B.SmallOutpost, B.TownHall]) { important = this.list(tt, ty)[0]; if (important) break; }
      const buckets: Entity[][] = [[], [], [], []];
      if (important) { buckets[0].push(important); set.delete(important.id); }
      // town halls among the candidates are set aside while the army has fewer than 10 members
      // (the important town hall above is attacked by any army)
      for (const e of [...set.values()].sort((a, b) => a.id - b.id)) {
        if (members.length < 10 && e.kind === KIND_BUILDING && (e.oid & 0xffff) === B.TownHall) continue;
        buckets[Math.min(3, tier(e))].push(e);
      }
      let enemy = 0, mine = 0;
      for (const l of buckets) for (const e of l) enemy += this.power(e);
      for (const u of members) mine += this.power(u);
      if (enemy > 2 * mine) return this.endArmy(ps);   // retreat
      const b = [0, 1, 2].find(k => buckets[k].length > 0) ?? -1;
      targets = b < 0 ? [] : buckets[b];
      // six per target in bucket 0 (counter > 5 - bucket); re-assign when the running target's
      // class is above the bucket's, or equal and rand() mod 10 = 0 (drawn only when equal)
      perTarget = 6 - b;
      reassign = cc => cc > b || (cc === b && this.rand() % 10 === 0);
    } else {
      // skirmish (`00466e20`): bucket 0 hunters, police, soldiers; bucket 1 every other unit
      const units = near.filter(e => e.kind === KIND_UNIT);
      const fighter = (e: Entity) => { const ty = e.oid & 0xffff; return ty === U.Hunter || ty === U.Police || isSoldier(ty); };
      const f = units.filter(fighter);
      const b = f.length ? 0 : 1;
      targets = b === 0 ? f : units;
      // three per target; a running attack is re-assigned only in bucket 0 when its class is
      // above 0; no rand() draw
      perTarget = 3;
      reassign = cc => b === 0 && cc > 0;
    }
    if (!targets.length) return this.endArmy(ps);   // success
    // members without an attack job (2.5 step 6): one with another job (walking, waiting for or
    // walking to a ship) is taken only within 40 cells of the target point or inside the target
    // town's territory, otherwise left alone; an idle one (no job, not walking) gets its attack
    // job wherever it stands, its own walk takes it to the target (0x46dd07; the former leg walk
    // of deviation T is gone: a leg ending in the sea left landed members idle for good).
    // Members aboard a transport are skipped and not counted (Gold); members inside another
    // building are skipped too (ours).
    const far = (u: Entity): boolean => {
      const [ux, uy] = this.cell(u);
      if (this.dist(ux, uy, x, y) < R || this.w.territory.ownerAt(ux, uy) === tt.id) return false;
      const j = u.job ? this.w.sched.get(u.job) : undefined;
      return (!!j && !j.cancelled) || !!u.path;
    };
    assignArmy(this, members.filter(u => u.inside < 0), targets, perTarget, reassign, far);
    d[3] = this.rand() & 1;
    return 50;
  }

  // ---------------------------------------------------------------- diplomacy (3.5)

  private diplomacy(ps: AiPlayer, prof: Profile): void {
    const eco = this.w.economy, dip = this.w.diplomacy;
    const me = ps.race;
    const S = this.strength(me);
    const [fn, fd] = WEIGHT_FACTOR[me];
    const p = eco.players[me]!;
    for (let i = 0; i < 3; i++) {
      // every other present, alive player, with or without a town (`004687a0`)
      const other = eco.players[i];
      if (i === me || !other || other.defeated) continue;
      // the time test and its rand() draw come first
      const due = this.w.tick - ps.lastMission[i] > 6000 && this.rand() % 15 === 0;
      const Si = this.strength(i);
      // S_i > w x S with w = profile weight / 1000 x race factor, compared exactly in integers
      const above = (wt: number) => Si * 1000 * fd > wt * fn * S;
      const atLeast = (wt: number) => Si * 1000 * fd >= wt * fn * S;
      const desired = above(prof.w1) ? 3 : atLeast(prof.w2) ? 2 : 1;
      dip.setAccept(me, i, 'peace', desired === 3);
      dip.setAccept(me, i, 'ceasefire', desired >= 2);
      if (!due) continue;
      const cur = this.relation(me, i);
      if (desired === cur || cur === 0) continue;
      // the first entry of the town list (a destroyed one not yet freed too) and its first embassy,
      // which must be active with its diplomat inside
      const first = eco.town(p.towns[0] ?? -1);
      if (!first) continue;
      const emb = this.list(first, B.Embassy)[0];
      const dipl = emb && emb.active ? this.w.get(emb.operatorId) : undefined;
      if (!emb || !dipl || dipl.inside !== emb.id) continue;
      if (dip.offer(emb, i, desired)) ps.lastMission[i] = this.w.tick;
    }
  }

  // ---------------------------------------------------------------- state

  snapshot(): AiSnapshot {
    return JSON.parse(JSON.stringify({ v: 1, prerequisites: this.prerequisites, players: this.players, towns: this.towns })) as AiSnapshot;
  }

  /**
   * `v`: the world snapshot version. Before version 20 (fidelity batch 6): no gang lists (rebuilt
   * from the groups on first use, creation order), no "started" set (taken as: some progress, or
   * selected by a town of the race now), and research was chosen by polling (`labSeen`): a town
   * left waiting for that poll gets its choice now.
   */
  restore(s: AiSnapshot | undefined, v = 20): void {
    if (!s) { this.players = [null, null, null]; this.towns = []; return; }
    const c = JSON.parse(JSON.stringify(s)) as AiSnapshot;
    const pending: [number, number][] = [];
    // saves before the 2026-10 audit: per-town round-robin counters instead of list order, no intruder records
    for (const t of c.towns) {
      if (!t) continue;
      const old = t as AiTown & { rr?: number[]; outRot?: number; labSeen?: number };
      delete old.rr; delete old.outRot;
      t.moved ??= [];
      t.intruders ??= [];
      t.gangs ??= {};
      t.porters ??= [];
      if (old.labSeen !== undefined) { if (v < 20) pending.push([t.town, old.labSeen]); delete old.labSeen; }
    }
    this.prerequisites = c.prerequisites; this.players = c.players; this.towns = c.towns;
    const eco = this.w.economy;
    for (const ps of this.players) {
      if (!ps || ps.started) continue;
      const p = eco.players[ps.race];
      ps.started = [];
      if (p) for (let i = 0; i < p.costs.length; i++) {
        if (p.progress[i] > 0 || eco.towns.some(o => o.alive && o.race === ps.race && o.research === i)) ps.started.push(i);
      }
    }
    for (const [id, seen] of pending) {
      const t = eco.towns[id];
      if (!t || !t.alive || t.research >= 0 || !this.players[t.race] || !this.w.entities.some(e => e.kind === KIND_BUILDING && e.town === id && e.alive && e.active && (e.oid & 0xffff) === B.Lab)) continue;
      if (seen) this.researchDone(t); else this.labActive(t);
    }
  }

  digest(mix: (v: number) => void): void {
    for (const p of this.players) {
      if (!p) { mix(-1); continue; }
      mix(p.race); mix(p.profile); mix(p.think); mix(p.army); mix(p.armyTown); mix(p.lastArmy); mix(p.cursor); mix(p.founding); mix(p.noSite);
      for (const v of p.armyMembers) mix(v);
      for (const v of p.lastMission) mix(v);
      mix(-2); for (const v of p.discovered) mix(v);
      mix(-3); for (const v of p.started ?? []) mix(v);
    }
    for (const s of this.towns) {
      if (!s) { mix(-1); continue; }
      mix(s.town); mix(s.planner); mix(s.economy); mix(s.military); mix(s.underAttack); mix(s.reserve);
      for (const arr of [s.A, s.B, s.C, s.moved ?? [], s.intruders ?? [], s.porters ?? []]) { mix(arr.length); for (const v of arr) mix(v); }
      for (const k of Object.keys(s.gangs ?? {}).map(Number).sort((a, b) => a - b)) { mix(k); mix(s.gangs[k].length); for (const v of s.gangs[k]) mix(v); }
      for (const r of s.build) for (const v of r) mix(v);
      for (const r of s.train) for (const v of r) mix(v);
    }
    // the reservation groups live on the entities, which World.hash() does not mix
    for (const e of this.w.entities) if (e.group) { mix(e.id); mix(e.group); }
  }
}

/** AI configuration from a mission setup (race blocks with `aiProfile`) plus the research trees */
export function aiConfig(races: { race: number; aiProfile?: number }[], prerequisites?: number[][][]): AiConfig {
  const profiles = [-1, -1, -1];
  for (const r of races) if (r.race >= 0 && r.race < 3) profiles[r.race] = r.aiProfile ?? -1;
  return { profiles, prerequisites };
}
