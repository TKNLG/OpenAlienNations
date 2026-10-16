// Deterministic game world. Spec: docs/architecture/simulation.md
// Integer state only; advanced in fixed ticks by applying commands.

import type { Terrain } from '../world/terrain.ts';
import { CLASS_WATER, CLASS_PATH } from '../world/terrain.ts';
import type { MapObject } from '../formats/mission.ts';
import { objectId } from '../formats/mission.ts';
import { dirToward, PathSearcher } from './path.ts';
import type { ObjectRule } from '../formats/odb.ts';
import type { Goal } from '../formats/mission.ts';
import { MsRand } from '../world/rand.ts';
import { Scheduler, type SchedulerSnapshot } from './scheduler.ts';
import { Economy, T, type EconomySnapshot, type RaceSetupLite, type Town } from './economy.ts';
import { Logistics, isLogisticsJob, HV, HG } from './logistics.ts';
import { Combat, isCombatJob, type CombatEffect } from './combat.ts';
import { Trade, isTradeJob, type TradeCommand, type TradeSnapshot } from './trade.ts';
import { Diplomacy, isDiplomacyJob, type DiplomacyCommand, type DiplomacySnapshot } from './diplomacy.ts';
import { Ai, isAiJob, aiConfig, type AiSnapshot } from './ai.ts';
import type { Weapon } from '../formats/wdb.ts';
import type { MapOrder } from '../formats/mission.ts';
import { BuildingFlag } from '../formats/odb.ts';
import { Naval, isNavalJob, goldDefaults, ADDON_TYPES, type GoldOptions, type NavalSnapshot } from './naval.ts';
import { AO_CLASS_SEA, AO_MOUNTAIN, type AddonTerrain } from '../world/addon-terrain.ts';
import { Motion, isMotionJob, WS, WalkResult, type FidgetCommand } from './motion.ts';
import { ring } from './ai-defs.ts';
import { Territory, type TerritorySnapshot } from './territory.ts';
export type { GoldOptions } from './naval.ts';

export const SUB = 256;          // fixed-point sub-units per cell
/** normal game speed: about 10 ticks per second like the original (docs/game/economy.md 1.2) */
export const TICK_MS = 100;

export const Kind = { Unit: 0, Building: 1, Nature: 2 } as const;
export type Kind = (typeof Kind)[keyof typeof Kind];
export const Action = { Walk: 0, Fight: 1, Work: 2, Idle: 3, Carry: 4 } as const;
export type Action = (typeof Action)[keyof typeof Action];

export interface Entity {
  id: number;
  kind: Kind;
  oid: number;          // object id: group << 16 | type
  owner: number;        // player = race 0..2 (Amazons, Pimmons, Sajiki), -1 = nature
  town: number;         // town id (index in economy.towns), -1 = none
  home: number;         // units: building they live in, -1 = homeless / none
  inside: number;       // units: building they are inside (hidden), -1 = outside
  /** units: when they entered the building they are inside (World.enters at that moment); the
   *  building's occupant list is its units inside in this order (units-and-jobs.md 4.11) */
  enterSeq: number;
  hp: number;
  occupancy: number;    // buildings: residents living here
  complete: boolean;    // buildings: construction finished
  active: boolean;      // buildings: operating (upkeep, storage, jobs)
  houseJob: number;     // buildings: id of the running house job, 0 = none
  // units
  job: number;          // current job id, 0 = idle
  group: number;        // formation group, 0 = none
  carryGood: number;    // -1 = nothing
  carryAmount: number;
  // buildings
  local: number[];      // local stock per good (non-store buildings and sites)
  needed: number[];     // one entry per unit of goods still to be delivered
  outputs: number[];    // one entry per produced unit waiting to be collected
  doorQueue: number[];  // units waiting to enter; only the head may
  operatorId: number;   // the unit running the building, -1 none
  order: BuildOrder | null;
  prodJob: number;
  opJob: number;
  buildFrame: number;   // construction sprite frame 0..9
  paused: boolean;      // construction paused
  queue: number[];      // training orders (unit types), at most 5
  trainStarted: number;
  trainProgress: number;
  trainJob: number;
  doorTick: number;     // last tick a unit went through the door (display only, not hashed)
  /** buildings: door counter (+0xAC, units-and-jobs.md 4.4, 4.10): units holding the door open */
  door: number;
  /** buildings: ticks of the last door-open (0x2B) and door-close (unit entered / placed outside /
   *  0x2C) messages (objects.md 4.1); display only, not hashed */
  doorOpen: number;
  doorShut: number;
  /** units: building of the running enter sequence (4.10 "Entering"), -1 none; its step: 0 turn
   *  toward the anchor, 1 door queue, 2 admitted (door counted, last step under way) */
  entering: number;
  enterStep: number;
  idle: number;         // porters: leisure counter, -1 = on a leisure visit
  // combat (combat.md)
  cooldownUntil: number; // tick before which the unit may not strike again
  rank: number;          // 0..3
  exp: number;
  suspended: number[];   // jobs waiting behind the current one (resumed when it ends)
  charging: boolean;     // top-level attack walk: step time - 1
  ordered: boolean;      // current activity was ordered by the player
  collapseStage: number; // buildings: collapse animation stage
  alive: boolean;       // animals: false once hunted (a carcass)
  homeX: number; homeY: number;   // animals: home cell
  // nature
  amount: number;       // remaining yield
  reserved: number;     // promised to harvesters at work
  full: number;
  yieldGood: number;
  standing: boolean;    // grown tree, must be felled first
  stage: number;        // harvested fraction in percent (display)
  growJob: number;
  /** fixed-point position, always a cell centre (cell*SUB + SUB/2); a step moves it to the destination at once */
  x: number; y: number;
  dir: number;          // facing 0..7 (path.ts DIR_STEP: clockwise on screen from "up")
  action: Action;
  actionTick: number;   // tick the current action started (animation phase)
  /** idle animation (action 3 `ID`, units-and-jobs.md 4.9, 7.7): tick it started (-1 none) and its repeat count */
  idleTick: number;
  idleLoops: number;
  path: [number, number][] | null;
  // movement (motion.ts; display contract in docs/architecture/simulation.md)
  /** last step: previous cell centre (fixed-point, unwrapped: destination - from = the step's delta) */
  stepFromX: number;
  stepFromY: number;
  /** last step: tick it started and its duration D in ticks (0 = a teleport, no interpolation) */
  stepStart: number;
  stepTicks: number;
  /** tick the movement logic runs next (turn delays, step delays, waits) */
  moveAt: number;
  /** current walk: goal cell, search budget, plans so far (arrival tolerance, 15 = fail) */
  goalX: number; goalY: number;
  walkNodes: number;
  plans: number;
  /** motion.ts WS: 0 normal, 1 waiting to squeeze past a pushed unit, 2 mode-0 re-plan due, 3 mode-1 plan due (last search failed) */
  walkState: number;
  /** squeezing: the unit pushed aside, and how many pushes so far */
  squeeze: number;
  pushes: number;
  /** motion.ts WalkResult of the last walk: 0 running, 1 arrived, 2 stopped near (tolerance), 3 failed */
  walkResult: number;
  /** planning mask of the current walk: 0 = 0x3C (units only near the walker after a blocked
   *  step), 1 = 0x3E (every unit, the flee's outward walk; combat.md 7.3) */
  walkMask: number;
  /** the walks of jobs suspended behind the current one (combat.md 7.4): each job keeps its own
   *  walk and continues it when it becomes current again */
  walks: WalkSave[];
  /** ships: units on board in boarding order (docs/game/addon.md 5.1); [] for everything else */
  passengers: number[];
}

/** a suspended job's walk (its follow-path child in the original): goal, path, plan counter, state */
export interface WalkSave {
  job: number;
  path: [number, number][] | null;
  goalX: number; goalY: number;
  walkNodes: number; plans: number; walkState: number; squeeze: number; pushes: number;
  walkResult: number; walkMask: number;
}

/** construction / production order of a building (units-and-jobs.md 6.2, 8.2) */
export interface BuildOrder {
  kind: 'build' | 'produce' | 'train';
  type: number;
  T: number; R: number;
  list: [number, number][];
  started: number;
  N: number; step: number; counter: number; E: number; d: number; stage: number;
  builders: number[];
}

export type Command =
  | { type: 'move'; player: number; ids: number[]; x: number; y: number }
  | { type: 'sliders'; player: number; town: number; motivation: number; research: number }
  | { type: 'research'; player: number; town: number; invention: number }
  | { type: 'order'; player: number; ids: number[]; target: number }
  | { type: 'build'; player: number; town: number; building: number; x: number; y: number }
  | { type: 'unit'; player: number; ids: number[]; action: 'home' | 'drop'; town?: number }
  | { type: 'building'; player: number; id: number; action: 'demolish' | 'repair' | 'pause' | 'resume' | 'deactivate' }
  /** send the first occupant of unit type `unit` out of a building (command 0x3A, units-and-jobs.md 4.11) */
  | { type: 'sendOut'; player: number; building: number; unit: number }
  | { type: 'train'; player: number; building: number; unit: number }
  | { type: 'untrain'; player: number; building: number; index: number }
  /** crop conversion (command 0x57, economy.md 7): `percent` 0..100 sets the town's ring,
   *  CONVERT_NOW (255) converts the ring's share of the crop stock now */
  | { type: 'convert'; player: number; town: number; percent: number }
  | { type: 'patrol'; player: number; id: number; points: [number, number][] }
  | { type: 'found'; player: number; unit: number; x: number; y: number }
  /** add-on: send out the passengers of a transport ship (AUSSTEIGEN, docs/game/addon.md 5.3, 5.6);
   *  `unit` = a unit type to send out only that type, -1 or absent = everyone */
  | { type: 'unload'; player: number; ship: number; unit?: number }
  /** idle fidget (command 0x2A, units-and-jobs.md 4.9): sent by the viewing client's idle timer */
  | FidgetCommand
  | TradeCommand
  | DiplomacyCommand;

/** mission data the world needs besides the map objects */
export interface WorldSetup {
  races: RaceSetupLite[];
  /** research cost per invention, per race */
  costs: number[][];
  goals: Goal[];
  /** dv.wdb */
  weapons?: Weapon[];
  /** initial jobs from the map's trailing block */
  orders?: MapOrder[];
  /** the five point lists (dvm.md / world-populate.md): forest, stone, bush regions, start
   *  candidates, start positions; used by the computer players */
  lists?: [number, number][][];
  /** per race and invention: prerequisite invention indices (DV.idb), for the computer players' research */
  prerequisites?: number[][][];
  /** false: no computer players run (tests that need a quiet world) */
  ai?: boolean;
  /** add-on ("AO") mission (docs/game/addon.md); default: the terrain is an add-on terrain */
  addon?: boolean;
  /** Gold executable behaviour and add-on fidelity switches; defaults by mode (naval.ts goldDefaults) */
  gold?: Partial<GoldOptions>;
  /** fidelity switches of the base game */
  fidelity?: {
    /** territory block count never reset when a town is cleared (economy.md 11.5 quirk); default true */
    territoryCountQuirk?: boolean;
  };
}

/** an advisor message for a race (UI only, not part of the simulation state) */
/** advisor line for one nation's client (side-panel.md 1.1); queue = wait behind a playing voice instead of being dropped */
export interface WorldEvent { tick: number; race: number; mentor: number; queue: boolean; }

export interface ScheduledCommand { tick: number; seq: number; cmd: Command; }

/** 4: movement state (motion.ts), whole-cell positions; 5: town territory (territory.ts, economy.md 11);
 *  6: door counters and enter sequences (units-and-jobs.md 4.10); 7: need thresholds raised at
 *  activation, not completion (economy.md 5.3); 8: walks owned by suspended jobs, walk planning
 *  mask (units-and-jobs.md 4.1, combat.md 7.4); 9: the attack state's walk flag and stored plan
 *  (combat.md 3.3.1); 10: the towns' criminal lists (combat.md 12.3); 12: the towns' crop
 *  conversion ring (economy.md 7); 13: the player's delivery order is an ordinary transport for
 *  its site, lost site needs re-filed once (units-and-jobs.md 5.8 item 10); 14: the naval
 *  planner's ship counters bound boarding (addon.md 8.4); older saves are migrated on restore */
export const SNAPSHOT_VERSION = 14;
/** `convert` command value for UMWANDELN (the original's byte 0xFF) */
export const CONVERT_NOW = 255;
export interface WorldSnapshot {
  v: number;
  tick: number;
  nextId: number;
  seq: number;
  rand: number;
  entities: Entity[];
  queue: ScheduledCommand[];
  sched: SchedulerSnapshot;
  economy: EconomySnapshot;
  respawns: { type: number; cls: number; x: number; y: number; radius: number; countdown: number }[];
  respawnJob: number;
  trade?: TradeSnapshot;
  diplomacy?: DiplomacySnapshot;
  lists?: [number, number][][];
  ai?: AiSnapshot;
  /** terrain edits (foundations, worn paths; units-and-jobs.md 6.6, 4.5): [cell, height, class, tile, path] */
  ground?: number[][];
  groundRand?: number;
  /** add-on mode and options (absent in base games) */
  addon?: boolean;
  gold?: GoldOptions;
  naval?: NavalSnapshot;
  /** town territory (version 5); older saves rebuild it from the buildings */
  territory?: TerritorySnapshot;
  /** entries into buildings so far (Entity.enterSeq); absent in older saves */
  enters?: number;
  /** advisor lines said with a minimum interval: [race, mentor, tick last said] (display only) */
  advisor?: [number, number, number][];
}

export class World {
  tick = 0;
  readonly terrain: Terrain;
  readonly bits: number;
  readonly size: number;
  readonly blocked: Uint8Array;
  /** number of non-animal nature objects per cell (placement checks) */
  readonly natureAt: Uint8Array;
  /** cells covered by a building (line of fire, combat.md 3.4) */
  readonly buildingCells: Uint8Array;
  readonly entities: Entity[] = [];   // kept sorted by id
  private byId = new Map<number, Entity>();
  private nextId = 1;
  private queue: ScheduledCommand[] = [];
  private seq = 0;
  /** units that entered a building so far: the source of Entity.enterSeq (occupant order) */
  private enters = 0;
  readonly rand: MsRand;
  sched = new Scheduler();
  readonly economy: Economy;
  readonly logistics: Logistics;
  readonly combat: Combat;
  readonly trade: Trade;
  readonly diplomacy: Diplomacy;
  readonly ai: Ai;
  /** path flag per cell (units-and-jobs.md 4.1, 4.5): faster steps; generated shores have none */
  readonly pathFlag: Uint8Array;
  /** cells changed by foundations and worn paths (snapshot / hash) */
  private groundEdits = new Set<number>();
  /** cosmetic tile picks of foundations and paths: their own stream, so they never shift gameplay draws */
  readonly groundRand: MsRand;
  /** changed areas since the client last drained them: [x0, y0, x1, y1] */
  groundEvents: [number, number, number, number][] = [];
  /** the map's five point lists (WorldSetup.lists); static after loading */
  lists: [number, number][][] = [[], [], [], [], []];
  weapons: Weapon[] = [];
  /** display events since the client last drained them (projectiles, deaths) */
  effects: CombatEffect[] = [];
  /** hook for modules that react to diplomatic changes (trade) */
  onRelation?: (a: number, b: number, state: number) => void;
  /** exhausted trees/animals waiting to respawn (units-and-jobs.md 7.5) */
  respawns: { type: number; cls: number; x: number; y: number; radius: number; countdown: number }[] = [];
  respawnJob = 0;
  /** advisor messages since the client last drained them */
  events: WorldEvent[] = [];
  /** per nation and line: tick it was last said (the advisor's minimum-interval test, side-panel.md 1.1) */
  private advisorLast = new Map<number, number>();

  readonly rules: Map<number, ObjectRule>;
  /** add-on mode (docs/game/addon.md 0.1): islands, ships, harbours */
  readonly addon: boolean;
  /** Gold behaviour switches, resolved */
  gold: GoldOptions;
  /** island id per cell (addon.md 2.4), null on base maps */
  readonly island: Uint8Array | null;
  /** ship passability (mask 0xA01C, addon.md 2.3): 1 = not open sea, a building or a nature object; empty in base games */
  readonly shipBlocked: Uint8Array;
  /** mountain height limit (flag 0x100; mine, farm, worn paths): 250, 290 in add-on mode (addon.md 2.2) */
  readonly mountain: number;
  /** object types per group: 62, 68 in add-on mode (per-type tables, addon.md 10.1) */
  readonly typeWidth: number;
  readonly naval: Naval;
  /** path following, occupancy, stepping aside, fidgets (motion.ts) */
  readonly motion: Motion;
  /** town territory and border stones (economy.md 11) */
  readonly territory: Territory;
  private searcher: PathSearcher | null = null;

  constructor(terrain: Terrain, objects: MapObject[], rules: Map<number, ObjectRule> = new Map(), setup?: WorldSetup) {
    this.rules = rules;
    this.terrain = terrain;
    this.bits = terrain.sizeBits;
    this.size = terrain.size;
    this.blocked = new Uint8Array(this.size * this.size);
    this.natureAt = new Uint8Array(this.size * this.size);
    this.buildingCells = new Uint8Array(this.size * this.size);
    this.pathFlag = new Uint8Array(this.size * this.size);
    this.groundRand = new MsRand(((terrain.randState ?? 1) ^ 0x5eed1e) >>> 0);
    for (let i = 0; i < this.blocked.length; i++) if (terrain.cls[i] === CLASS_WATER) this.blocked[i] = 1;
    const ao = terrain as Partial<AddonTerrain>;
    this.addon = setup?.addon ?? (ao.addon === true && !!ao.island);
    this.gold = { ...goldDefaults(this.addon), ...(setup?.gold ?? {}) };
    this.island = this.addon && ao.island ? ao.island : null;
    this.mountain = this.addon ? AO_MOUNTAIN : 250;
    this.typeWidth = this.addon ? ADDON_TYPES : 62;
    this.shipBlocked = new Uint8Array(this.addon ? this.size * this.size : 0);
    if (this.addon) for (let i = 0; i < this.shipBlocked.length; i++) this.shipBlocked[i] = this.seaCell(i) ? 0 : 1;
    this.rand = new MsRand(terrain.randState ?? 1);
    this.territory = new Territory(this.size);
    if (setup?.fidelity?.territoryCountQuirk === false) this.territory.countQuirk = false;
    this.motion = new Motion(this);
    this.naval = new Naval(this);
    this.economy = new Economy(this);
    this.logistics = new Logistics(this);
    this.logistics.startRespawnManager();   // the global respawn manager exists from game start (units-and-jobs.md 7.5.1)
    this.combat = new Combat(this);
    this.trade = new Trade(this);
    this.diplomacy = new Diplomacy(this);
    this.ai = new Ai(this);
    if (setup?.weapons) this.weapons = setup.weapons;
    if (setup?.lists) this.lists = setup.lists.map(l => l.map(([x, y]) => [x, y] as [number, number]));
    if (setup) this.economy.setupPlayers(setup.races, setup.costs, setup.goals);
    if (objects.length) this.loadMap(objects, setup);
    // the relation table is rebuilt from the race blocks after the map objects exist; this also
    // undoes the "first contact = war" of embassies activated while loading (mdb.md "Relations")
    if (setup) this.diplomacy.initRelations(setup.races);
    // computer players start after the map and the relations exist (ai-diplomacy-trade.md 1.1)
    if (setup && setup.ai !== false) this.ai.start(aiConfig(setup.races, setup.prerequisites));
  }

  /** create the map's objects in the original's order (docs/formats/dvm.md "Creation order") */
  private loadMap(objects: MapObject[], setup?: WorldSetup): void {
    const eco = this.economy;
    const halls: MapObject[] = [], buildings: MapObject[] = [], units: MapObject[] = [];
    for (const o of objects) {
      if (o.cls === 2) { const n = this.spawn(o); if (this.rules.get(n.oid)?.cls === 7) this.logistics.startAnimal(n); }
      else if (o.cls === 1 && o.type === T.TownHall) halls.push(o);
      else if (o.cls === 1) buildings.push(o);
      else units.push(o);
    }
    const townOf = (race: number, mapId: number) => eco.towns.find(t => t.race === race && t.mapId === mapId);
    const toHouse: Entity[] = [];
    // town halls found towns; the founder lives inside
    for (const o of halls) {
      const hall = this.spawn(o);
      const goods = setup?.races.find(r => r.race === o.group)?.startGoods;
      const t = eco.foundTown(o.group, o.owner, hall, goods);
      this.claimTerritory(hall);   // the town hall's territory comes with its object (economy.md 11.2)
      hall.complete = true;
      this.operatorInside(hall, t);
      this.logistics.activate(hall);
    }
    for (const o of buildings) {
      const t = townOf(o.group, o.owner);
      if (!t) continue;
      const b = this.spawn(o);
      b.town = t.id;
      b.complete = true;
      const op = this.operatorInside(b, t);
      if (op) toHouse.push(op);
      // map buildings go through completion too: need thresholds, and a house gets its porter
      // (dvm.md "Creation order", correction from dvge.exe)
      eco.completed(b);
      const r = this.rules.get(b.oid);
      if (r && r.cls === 6) this.claimTerritory(b);   // outposts placed complete by the map loader (11.2)
      if (r && r.cls === 6) {
        // +0xDC archers created on the outpost's own cell (its anchor), inside it, each with a
        // random facing (one rand() per unit), through the "entered" step (combat.md 9.2, 16.1)
        for (let k = 0; k < r.garrison; k++) {
          const s = this.spawn({ cls: 0, group: o.group, type: T.Soldier, owner: -1, x: Math.floor(b.x / SUB), y: Math.floor(b.y / SUB), z: 0 });
          this.motion.vacate(s);
          s.town = t.id;
          this.putInside(s, b);
          s.dir = this.rand.next() % 8;
          eco.joinTown(s, t);
          toHouse.push(s);
        }
        if (r.garrison > 0) this.combat.startOutpost(b);
      }
      if (!r || r.operator < 0 || op) this.logistics.activate(b);
    }
    const ships: [Entity, MapObject][] = [];
    for (const o of units) {
      const u = this.spawn(o);
      u.dir = this.rand.next() % 8;
      const t = townOf(o.group, o.owner);
      if (t) { eco.joinTown(u, t); toHouse.push(u); }
      if (o.type === T.Criminal) this.combat.startCriminal(u);
      if (o.cargo && o.cargo.length) ships.push([u, o]);
    }
    // add-on: the cargo of transport ships, created inside them after all other units (addon.md 5.1;
    // docs/formats/addon.md 8.2, 8.4); not housed
    for (const [ship, o] of ships) {
      for (const type of o.cargo!) {
        const c = this.spawn({ cls: 0, group: o.group, type, owner: -1, x: Math.floor(ship.x / SUB), y: Math.floor(ship.y / SUB), z: 0 });
        c.inside = ship.id;
        ship.passengers.push(c.id);
        const t = eco.town(ship.town);
        if (t) eco.joinTown(c, t);
        c.town = ship.town;
        if (type === T.Criminal) this.combat.startCriminal(c);
      }
    }
    // housing: move units into houses of their town that still have room
    for (const u of toHouse) {
      const house = this.entities.find(b => b.kind === Kind.Building && b.town === u.town &&
        ((b.oid & 0xffff) === T.SmallHouse || (b.oid & 0xffff) === T.LargeHouse) &&
        b.occupancy < (this.rules.get(b.oid)?.residents ?? 0));
      if (house) eco.moveIn(u, house);
    }
    // the loader re-evaluates every town's needs once more at the end (economy.md 5.4, `00411200`)
    for (const t of eco.towns) eco.evaluateNeeds(t);
    if (setup?.orders) this.applyOrders(setup.orders);
  }

  /** initial jobs from the map (dvm.md "Orders") */
  private applyOrders(orders: MapOrder[]): void {
    const m = this.size - 1;
    const at = (x: number, y: number, kind?: number) => this.entities.find(e =>
      (kind === undefined || e.kind === kind) && (Math.floor(e.x / SUB) & m) === (x & m) && (Math.floor(e.y / SUB) & m) === (y & m));
    const waypoints = new Map<Entity, [number, number][]>();
    for (const o of orders) {
      const src = at(o.x1, o.y1, Kind.Unit);
      if (!src) continue;
      const type = src.oid & 0xffff;
      if (type >= 29 && type <= 36) {
        const l = waypoints.get(src) ?? [];
        if (l.length < 7 && !((o.x2 & m) === (o.x1 & m) && (o.y2 & m) === (o.y1 & m))) l.push([o.x2 & m, o.y2 & m]);
        waypoints.set(src, l);
      } else if (type === 17) {
        // a hunter: hunting ground at the order cell, no target yet (units-and-jobs.md 7.3.1)
        this.logistics.startHunt(src, o.x2 & m, o.y2 & m, null, 1 + (this.rand.next() % 5));
      } else {
        const obj = at(o.x2, o.y2, Kind.Nature);
        if (obj && this.logistics.canHarvest(src, obj)) this.logistics.startHarvest(src, obj, true, 1 + (this.rand.next() % 5));
      }
    }
    for (const [u, pts] of waypoints) this.combat.startGuard(u, pts, 1 + (this.rand.next() % 5));
  }

  /** the building's resident worker (odb operator type), created inside */
  private operatorInside(b: Entity, t: Town): Entity | null {
    const r = this.rules.get(b.oid);
    if (!r || r.operator < 0) return null;
    const u = this.spawnUnit(t.race, r.operator, Math.floor(b.x / SUB), Math.floor(b.y / SUB), t.id);
    this.putInside(u, b);
    b.operatorId = u.id;
    this.economy.joinTown(u, t);
    if (r.flags & BuildingFlag.OperatorInside) b.opJob = this.sched.create(0x22, b.id, 100).id;
    return u;
  }

  /** a unit is now inside a building, appended to its occupant list (units-and-jobs.md 4.10 step 6, 4.11) */
  putInside(u: Entity, b: Entity): void {
    u.inside = b.id;
    u.enterSeq = ++this.enters;
  }

  /** create a unit on (or next to) a cell */
  spawnUnit(race: number, type: number, x: number, y: number, town: number): Entity {
    if (this.addon && this.rules.get(objectId(race, type))?.cls === 14) {
      // a ship: on the nearest open-sea cell without a unit (addon.md 3.4)
      const s = this.spawn({ cls: 0, group: race, type, owner: -1, x: x & (this.size - 1), y: y & (this.size - 1), z: 0 });
      this.naval.placeShip(s, x, y);
      s.town = town;
      return s;
    }
    const [cx, cy] = this.blocked[this.cell(x, y)] ? this.spreadTargets(x, y, 1)[0] : [x & (this.size - 1), y & (this.size - 1)];
    const e = this.spawn({ cls: 0, group: race, type, owner: -1, x: cx, y: cy, z: 0 });
    e.town = town;
    if (type === T.Criminal) this.combat.startCriminal(e);
    return e;
  }

  /**
   * A unit born inside a building (births `00460830`, units-and-jobs.md 4.10 "Births"): its
   * position is the entrance cell, but it is not put on the map (no cell, not drawn); unless it is
   * of the building's operator type or the building is an outpost, the building ejects it at once
   * through the leave job, so it appears 20..35 ticks later.
   */
  /** economy hook: a resident left its house (units-and-jobs.md 4.4 "Residences") */
  residentLeft(b: Entity): void { this.logistics.residentLeft(b); }

  spawnInside(race: number, type: number, b: Entity, town: number): Entity {
    const [x, y] = this.logistics.entrance(b);
    const e = this.spawn({ cls: 0, group: race, type, owner: -1, x, y, z: 0 });
    this.motion.vacate(e);
    this.putInside(e, b);
    e.town = town;
    if (type === T.Criminal) this.combat.startCriminal(e);
    const r = this.rules.get(b.oid);
    if (!r || (r.operator !== type && r.cls !== 6)) this.logistics.leave(e);
    return e;
  }

  /**
   * Territory message "add a circle" of a building (economy.md 11.2): a town hall when its object
   * is created (site included), an outpost (class 6) when it is completed. Radius = odb +0xB0.
   */
  claimTerritory(b: Entity): void {
    const t = this.economy.town(b.town);
    if (!t) return;
    const r = this.rules.get(b.oid);
    const R = r?.radius ?? ((b.oid & 0xffff) === T.TownHall ? 25 : 0);
    this.territory.add(t.id, b.oid >>> 16, Math.floor(b.x / SUB), Math.floor(b.y / SUB), R);
  }

  /** phase 2 of a building's destruction (combat.md 10.3): also withdraws its territory (economy.md 11.5) */
  destroyBuilding(e: Entity): void {
    if (e.town >= 0) this.territory.remove(e.town, Math.floor(e.x / SUB), Math.floor(e.y / SUB));
    const was = e.active;
    // any removal path: queued training orders leave the pending counts (units-and-jobs.md 9)
    this.logistics.dropTraining(e);
    this.economy.deactivate(e);
    if (was) this.diplomacy.embassyDeactivated(e);
    for (const u of this.entities) {
      if (u.home === e.id) {
        u.home = -1;
        const t = this.economy.town(u.town);
        if (t) t.homeless.push(u.id);
      }
      if (u.inside === e.id) u.inside = -1;
    }
    this.remove(e);
  }

  /** remove an object from the world (harvested nature, destroyed building, dead unit) */
  removeEntity(e: Entity): void {
    if (e.kind === Kind.Building) { this.destroyBuilding(e); return; }
    if (e.kind === Kind.Unit) { this.logistics.cancelJob(e); this.naval.unitGone(e); this.economy.leaveTown(e); }
    this.remove(e);
  }

  /** island id of a cell (addon.md 2.4): 0 on water and on base maps */
  islandAt(x: number, y: number): number { return this.island ? this.island[this.cell(x, y)] : 0; }

  /** a ship (behaviour class 14, add-on) */
  isShip(e: Entity): boolean { return this.addon && e.kind === Kind.Unit && this.rules.get(e.oid)?.cls === 14; }

  /** open sea (not land, not coastal water) by terrain (addon.md 2.2) */
  private seaCell(i: number): boolean {
    const ao = (this.terrain as Partial<AddonTerrain>).aoCls;
    return ao ? ao[i] === AO_CLASS_SEA : this.terrain.cls[i] === CLASS_WATER;
  }

  /** A* on a grid of this world's size (path.ts findPath, reusable buffers) */
  findPathOn(grid: Uint8Array, sx: number, sy: number, tx: number, ty: number, maxNodes = 40000): [number, number][] | null {
    this.searcher ??= new PathSearcher(this.bits);
    return this.searcher.find(grid, sx, sy, tx, ty, maxNodes);
  }

  /**
   * Plan a walk to a cell with one search; false when that search finds nothing (and the old walk
   * is kept). Used where one search decides (the attack's firing position, animals, the computer
   * players' legs); the jobs that walk with the original's follow-path job use `follow`.
   */
  walk(e: Entity, x: number, y: number, maxNodes = 6000): boolean {
    if (this.addon && e.kind === Kind.Unit) {
      // ships cross whole seas: a larger search budget for ordinary walks (searches are cheap on the ship grid)
      if (this.isShip(e)) return this.naval.walkShip(e, x, y, maxNodes >= 6000 ? 30000 : maxNodes);
      return this.walkLand(e, x, y, maxNodes);
    }
    const [cx, cy] = [Math.floor(e.x / SUB), Math.floor(e.y / SUB)];
    const m = this.size - 1;
    if (cx === (x & m) && cy === (y & m)) { this.setPath(e, null, x, y, maxNodes); return true; }
    const path = this.findPathOn(this.blocked, cx, cy, x, y, maxNodes);
    if (!path) return false;
    this.setPath(e, path, x, y, maxNodes);
    return true;
  }

  /**
   * The way `walk` would plan for e from (sx, sy) to (x, y), without walking it: units ignored,
   * the add-on land goal rules applied (the attack's stored plan, combat.md 3.3.1). Cells after the
   * start; [] on the goal; null: no way.
   */
  planPath(e: Entity, sx: number, sy: number, x: number, y: number, maxNodes: number): [number, number][] | null {
    const m = this.size - 1;
    let gx = x & m, gy = y & m;
    if (this.addon && e.kind === Kind.Unit) {
      const g = this.landGoal(e, gx, gy);
      if (!g) return null;
      [gx, gy] = g;
    }
    if ((sx & m) === gx && (sy & m) === gy) return [];
    return this.findPathOn(this.blocked, sx & m, sy & m, gx, gy, maxNodes);
  }

  /**
   * The follow-path job (0x06, units-and-jobs.md 4.1) to a cell: a search that finds nothing does
   * not fail the walk; it is planned again (units ignored) at its next run, until the arrival
   * tolerance or the 15-plan limit ends it. `mask` 1: every plan keeps out all units (combat.md
   * 7.3). False only where the original's walk fails at once: add-on land walks toward another
   * island or with no land cell near the target (addon.md 2.5); ships keep their one search.
   */
  follow(e: Entity, x: number, y: number, maxNodes = 6000, mask = 0): boolean {
    if (this.isShip(e)) return this.walk(e, x, y, maxNodes);
    let gx = x & (this.size - 1), gy = y & (this.size - 1);
    if (this.addon && e.kind === Kind.Unit) {
      const g = this.landGoal(e, gx, gy);
      if (!g) return false;
      [gx, gy] = g;
    }
    this.motion.start(e, gx, gy, maxNodes, mask);
    return true;
  }

  /**
   * Start a walk along a planned path (the follow-path job, units-and-jobs.md 4.1). The first step
   * comes 3 ticks after the plan (the original's planning delay), and never before the previous
   * step's duration is over. `path` null or empty: the unit is already there.
   */
  setPath(e: Entity, path: [number, number][] | null, gx: number, gy: number, nodes: number): void {
    const m = this.size - 1;
    e.path = path && path.length ? path : null;
    e.goalX = gx & m; e.goalY = gy & m;
    e.walkNodes = nodes;
    e.plans = 1;
    e.walkState = WS.Normal;
    e.walkMask = 0;
    e.squeeze = 0; e.pushes = 0;
    e.walkResult = e.path ? WalkResult.Running : WalkResult.Arrived;
    e.moveAt = Math.max(e.stepStart + e.stepTicks, this.tick + 3);
  }

  /** drop the walk at once (entering a building, boarding, death); the position stays */
  halt(e: Entity): void {
    e.path = null;
    e.walkState = WS.Normal;
    e.squeeze = 0;
  }

  /** stop walking: a unit whose last step is still under way stands when it ends, otherwise at once */
  stopWalk(e: Entity): void {
    if (!e.path) return;
    const end = e.stepStart + e.stepTicks;
    if (this.tick < end) { e.path = []; e.walkState = WS.Normal; e.squeeze = 0; e.moveAt = end; }
    else this.motion.done(e, WalkResult.Arrived);
  }

  /** has the unit's last walk ended without failing (reached its goal, or stopped near it by the tolerance) */
  walkOk(e: Entity): boolean { return !e.path && (e.walkResult === WalkResult.Arrived || e.walkResult === WalkResult.Near); }

  /**
   * A job is suspended behind a new one (combat.md 7.4): its walk (goal, path, plan counter, step-
   * aside state, last result) is kept for it and the unit stands free for the new job's own walk.
   * `job` 0: a walk without a job (a plain move order).
   */
  stashWalk(e: Entity, job: number): void {
    if (!job && !e.path) return;
    e.walks = e.walks.filter(s => s.job !== job);
    e.walks.push({
      job, path: e.path ? e.path.map(([x, y]) => [x, y] as [number, number]) : null, goalX: e.goalX, goalY: e.goalY,
      walkNodes: e.walkNodes, plans: e.plans, walkState: e.walkState, squeeze: e.squeeze, pushes: e.pushes,
      walkResult: e.walkResult, walkMask: e.walkMask,
    });
    if (e.path) { e.path = null; e.walkState = WS.Normal; e.squeeze = 0; }
  }

  /**
   * A suspended job becomes current again: its own walk continues (from the cell where the unit
   * stands now; if that is no longer next to the stored path, the walk ends at once without
   * success, units-and-jobs.md 4.1). The first run comes when the last step is over, at least 1
   * tick later. Walks kept for jobs no longer suspended are dropped.
   */
  resumeWalk(e: Entity, job: number): void {
    const k = e.walks.findIndex(s => s.job === job);
    if (k >= 0) {
      const s = e.walks[k];
      e.walks.splice(k, 1);
      e.path = s.path; e.goalX = s.goalX; e.goalY = s.goalY; e.walkNodes = s.walkNodes; e.plans = s.plans;
      e.walkState = s.walkState; e.squeeze = s.squeeze; e.pushes = s.pushes; e.walkResult = s.walkResult; e.walkMask = s.walkMask;
      if (e.path) e.moveAt = Math.max(e.stepStart + e.stepTicks, this.tick + 1);
    }
    if (e.walks.length) e.walks = e.walks.filter(s => s.job === 0 || e.suspended.includes(s.job));
  }

  /**
   * Add-on land walk: follow path fails at once toward another island (addon.md 2.5); a target on
   * water or on a building is replaced by the nearest free land cell of the unit's island (the
   * go-to target chooser `00485dc0`), so no search runs over the whole island for a cell it can
   * never reach.
   */
  private walkLand(e: Entity, x: number, y: number, maxNodes: number): boolean {
    const [cx, cy] = [Math.floor(e.x / SUB), Math.floor(e.y / SUB)];
    const g = this.landGoal(e, x & (this.size - 1), y & (this.size - 1));
    if (!g) return false;
    const [gx, gy] = g;
    if (cx === gx && cy === gy) { this.setPath(e, null, gx, gy, maxNodes); return true; }
    const path = this.findPathOn(this.blocked, cx, cy, gx, gy, maxNodes);
    if (!path) return false;
    this.setPath(e, path, gx, gy, maxNodes);
    return true;
  }

  /** the add-on land walk's goal (walkLand): null toward another island or with no land cell near a water or building target */
  private landGoal(e: Entity, gx: number, gy: number): [number, number] | null {
    const [cx, cy] = [Math.floor(e.x / SUB), Math.floor(e.y / SUB)];
    if (cx === gx && cy === gy) return [gx, gy];
    const isl = this.island!, home = isl[this.cell(cx, cy)];
    const gi = this.cell(gx, gy);
    if (isl[gi] !== 0 && home !== 0 && isl[gi] !== home) return null;
    if (this.blocked[gi] && (this.terrain.cls[gi] === CLASS_WATER || this.buildingCells[gi])) {
      const c = this.naval.spiral(gx, gy, 6, (px, py) => { const i = this.cell(px, py); return !this.blocked[i] && (home === 0 || isl[i] === home); });
      if (!c) return null;   // e.g. a melee unit after a ship out at sea (addon.md 7): nothing to walk to
      return c;
    }
    return [gx, gy];
  }

  /** put a unit on a cell (or the nearest free one) at once: no step, no interpolation */
  place(e: Entity, x: number, y: number): void {
    if (this.isShip(e)) { this.naval.placeShip(e, x, y); return; }
    let [cx, cy] = this.blocked[this.cell(x, y)] ? this.spreadTargets(x, y, 1)[0] : [x & (this.size - 1), y & (this.size - 1)];
    if (this.addon && e.kind === Kind.Unit && this.blocked[this.cell(x, y)]) {
      // add-on: the nearest free land cell, on the island the unit was on when possible (a harbour's
      // entrance lies in the water, addon.md 3.2)
      const isl = this.island![this.cell(Math.floor(e.x / SUB), Math.floor(e.y / SUB))];
      const c = this.naval.spiral(x, y, 24, (px, py) => { const i = this.cell(px, py); return !this.blocked[i] && (isl === 0 || this.island![i] === isl); });
      if (c) [cx, cy] = c;
    }
    this.teleport(e, cx, cy);
    this.halt(e);
  }

  /** move an object to a cell without a step (placing, launching); keeps occupancy and blocking current */
  teleport(e: Entity, x: number, y: number): void {
    const m = this.size - 1;
    const onMap = e.kind === Kind.Unit ? e.inside < 0 : true;
    if (e.kind === Kind.Nature) this.unmarkBlocked(e); else if (onMap) this.motion.vacate(e);
    e.x = (x & m) * SUB + SUB / 2; e.y = (y & m) * SUB + SUB / 2;
    if (e.kind === Kind.Nature) this.markBlocked(e); else this.motion.occupy(e);
    e.stepFromX = e.x; e.stepFromY = e.y; e.stepStart = this.tick; e.stepTicks = 0;
  }

  /**
   * One step to a neighbouring cell (units-and-jobs.md 4.1, `004621c0`): the position, the cell
   * occupancy and (for an animal) the nature blocking move to the destination at once; the display
   * gets the start tick and the duration D and interpolates. A step stops any running action and
   * shows the base movement action (walk, or carry with goods).
   */
  stepTo(e: Entity, nx: number, ny: number, D: number): void {
    const m = this.size - 1;
    nx &= m; ny &= m;
    const ox = e.x, oy = e.y;
    if (e.kind === Kind.Nature) this.unmarkBlocked(e); else this.motion.vacate(e);
    const tx = nx * SUB + SUB / 2, ty = ny * SUB + SUB / 2, span = this.size * SUB;
    e.x = tx; e.y = ty;
    e.stepFromX = tx + wrapDelta(ox - tx, span); e.stepFromY = ty + wrapDelta(oy - ty, span);
    if (e.kind === Kind.Nature) this.markBlocked(e); else this.motion.occupy(e);
    e.stepStart = this.tick; e.stepTicks = D;
    const act = e.kind === Kind.Unit && e.carryAmount > 0 ? Action.Carry : Action.Walk;
    if (e.action !== act) { e.action = act; e.actionTick = this.tick; }
    e.idleTick = -1;
    if (e.kind === Kind.Unit) this.wearPath(e, nx, ny);
  }

  /** face a cell at once (no turn delay): only where the original sets the facing directly */
  face(e: Entity, x: number, y: number): void {
    const cx = Math.floor(e.x / SUB), cy = Math.floor(e.y / SUB);
    const want = dirToward(wrapDelta((x & (this.size - 1)) - cx, this.size), wrapDelta((y & (this.size - 1)) - cy, this.size));
    if (want >= 0) e.dir = want;
  }

  /** one turn call toward a cell (4.6): returns the delay; 0 = facing it now */
  turnToward(e: Entity, x: number, y: number): number {
    const cx = Math.floor(e.x / SUB), cy = Math.floor(e.y / SUB);
    return this.motion.turn(e, dirToward(wrapDelta((x & (this.size - 1)) - cx, this.size), wrapDelta((y & (this.size - 1)) - cy, this.size)));
  }

  /**
   * Go-to target cell (`0047b030`, units-and-jobs.md 4.8): the point itself, then N, W, S, E; the
   * first one the planner may enter (units do not count). Otherwise the nearest such cell by rings.
   */
  goalCell(x: number, y: number): [number, number] {
    const m = this.size - 1;
    for (const [dx, dy] of GOTO_CANDIDATES) if (!this.blocked[this.cell(x + dx, y + dy)]) return [(x + dx) & m, (y + dy) & m];
    for (let r = 1; r <= 16; r++) for (const [px, py] of ring(x, y, r)) if (!this.blocked[this.cell(px, py)]) return [px & m, py & m];
    return [x & m, y & m];
  }

  /** first cell of the square spiral around (x, y) without unit, building, nature or water (mask 0x3E, 4.8) */
  freeSpiral(x: number, y: number, maxRing: number, self?: Entity): [number, number] | null {
    const m = this.size - 1;
    for (let r = 0; r <= maxRing; r++) for (const [px, py] of ring(x, y, r)) if (this.motion.free(px, py, self)) return [px & m, py & m];
    return null;
  }

  /** cell has water, a building or a (non-animal) nature object */
  occupied(x: number, y: number): boolean {
    const i = this.cell(x, y);
    return this.terrain.cls[i] === CLASS_WATER || this.blocked[i] === 1 || this.natureAt[i] > 0;
  }


  heightAt(x: number, y: number): number { return this.terrain.height[this.cell(x, y)]; }
  buildingAt(i: number): boolean { return this.buildingCells[i] === 1; }

  /** a display event (not simulation state) */
  effect(e: CombatEffect): void {
    this.effects.push(e);
    if (this.effects.length > 256) this.effects.splice(0, this.effects.length - 256);
  }

  /** a building is ruined (decay, damage): collapses in two phases (combat.md 10.3) */
  ruin(e: Entity): void { this.combat.collapse(e, true); }

  private remove(e: Entity): void {
    const i = this.entities.indexOf(e);
    if (i >= 0) this.entities.splice(i, 1);
    this.byId.delete(e.id);
    this.unmarkBlocked(e);
    this.motion.vacate(e);
    // attacks naming it keep its last cell, race and tier for their retarget (combat.md 3.6)
    if (e.kind !== Kind.Nature) this.combat.targetGone(e);
  }

  rebuildBlocked(): void {
    for (let i = 0; i < this.blocked.length; i++) this.blocked[i] = this.terrain.cls[i] === CLASS_WATER ? 1 : 0;
    this.natureAt.fill(0);
    this.buildingCells.fill(0);
    for (const e of this.entities) this.markBlocked(e);
  }

  /**
   * The nation's advisor filter (side-panel.md 1.1.1): line `mentor` is sent to the nation's client
   * unless `intervalMs` > 0 and the line's slot was last let through (or armed) less than
   * `intervalMs` ago. Only a call with an interval stamps the slot. Time is ticks x TICK_MS, so
   * the choice is deterministic. Display only: nothing in the simulation reads it.
   */
  notify(race: number, mentor: number, queue = true, intervalMs = 0): void {
    const key = race * 1024 + mentor;
    if (intervalMs > 0) {
      const last = this.advisorLast.get(key);
      if (last !== undefined && (this.tick - last) * TICK_MS < intervalMs) return;
      this.advisorLast.set(key, this.tick);
    }
    this.events.push({ tick: this.tick, race, mentor, queue });
    if (this.events.length > 64) this.events.splice(0, this.events.length - 64);
  }

  /** arm a line's slot (`0045e170`, side-panel.md 1.1.1): it counts as said now, nothing is said */
  armAdvisor(race: number, mentor: number): void {
    this.advisorLast.set(race * 1024 + mentor, this.tick);
  }

  private cell(x: number, y: number): number {
    const m = this.size - 1;
    return ((y & m) << this.bits) | (x & m);
  }

  /** create an object; ids only grow, and entities stay sorted by id */
  spawn(o: MapObject): Entity {
    const kind = o.cls === 0 ? Kind.Unit : o.cls === 1 ? Kind.Building : Kind.Nature;
    const oid = objectId(o.group, o.type);
    const e: Entity = {
      id: this.nextId++, kind, oid,
      owner: kind === Kind.Nature ? -1 : o.group, town: -1, home: -1, inside: -1, enterSeq: 0,
      hp: this.rules.get(oid)?.hp ?? 0, occupancy: 0, complete: kind !== Kind.Building, active: false, houseJob: 0,
      job: 0, group: 0, carryGood: -1, carryAmount: 0,
      local: kind === Kind.Building ? new Array(9).fill(0) : [], needed: [], outputs: [], doorQueue: [], operatorId: -1,
      order: null, prodJob: 0, opJob: 0, buildFrame: kind === Kind.Building ? 9 : 0,
      paused: false, queue: [], trainStarted: 0, trainProgress: 0, trainJob: 0, doorTick: -1000,
      door: 0, doorOpen: -1000, doorShut: -1000, entering: -1, enterStep: 0,
      idle: 0, alive: true, homeX: o.x, homeY: o.y,
      cooldownUntil: -1000, rank: 0, exp: 0, suspended: [], walks: [], charging: false, ordered: false, collapseStage: -1,
      amount: 0, reserved: 0, full: 0, yieldGood: -1, standing: false, stage: 0, growJob: 0,
      x: o.x * SUB + SUB / 2, y: o.y * SUB + SUB / 2, dir: 3,
      action: Action.Idle, actionTick: 0, idleTick: -1, idleLoops: 0, path: null,
      ...movementDefaults(o.x * SUB + SUB / 2, o.y * SUB + SUB / 2, o.x, o.y), passengers: [],
    };
    if (kind === Kind.Nature) {
      const r = this.rules.get(oid);
      e.amount = e.full = Math.max(0, r?.amount ?? 0);
      e.yieldGood = r?.product ?? -1;
      e.standing = r?.cls === 8;
    }
    this.entities.push(e);
    this.byId.set(e.id, e);
    if (kind === Kind.Building) this.foundation(e);
    this.markBlocked(e);
    this.motion.occupy(e);
    return e;
  }

  /**
   * Foundation (units-and-jobs.md 6.6): a new building levels the footprint grown by one cell to
   * the average height of that outer ring and paves it with path tiles. Permanent.
   */
  private foundation(b: Entity): void {
    const r = this.rules.get(b.oid);
    if (!r) return;
    const type = b.oid & 0xffff;
    if (type === 62 || type === 63) return;   // add-on harbour and shipyard stand at the waterline
    const sx = Math.max(1, r.sizeX), sy = Math.max(1, r.sizeY);
    const x = Math.floor(b.x / SUB), y = Math.floor(b.y / SUB);
    const t = this.terrain;
    let sum = 0, cnt = 0;
    for (let yy = y - sy; yy <= y + 1; yy++) for (let xx = x - sx; xx <= x + 1; xx++) {
      const inner = xx > x - sx && xx <= x && yy > y - sy && yy <= y;
      if (inner) continue;
      sum += t.height[this.cell(xx, yy)]; cnt++;
    }
    const h = Math.floor(sum / cnt);
    for (let xx = x + 1; xx >= x - sx; xx--) for (let yy = y + 1; yy >= y - sy; yy--) {
      const i = this.cell(xx, yy);
      t.height[i] = h;
      if (t.cls[i] !== CLASS_PATH) { t.cls[i] = CLASS_PATH; t.tile[i] = this.groundRand.next() % 8; this.pathFlag[i] = 1; }
      this.groundEdits.add(i);
    }
    this.groundEvents.push([x - sx - 1, y - sy - 1, x + 2, y + 2]);
  }

  /** worn paths (4.5): a unit of a hauling or fighting type may pave the cell it steps onto */
  wearPath(e: Entity, x: number, y: number): void {
    if (this.gold.pathFlag) {
      // Gold: record flag 0x80, the roll is drawn only for flagged units (4.5 "Gold Edition")
      if (!((this.rules.get(e.oid)?.flags ?? 0) & 0x80)) return;
      if (this.groundRand.next() % 10 !== 0) return;
    } else {
      if (this.groundRand.next() % 10 !== 0) return;
      const type = e.oid & 0xffff;
      if (!(type === 9 || type === 17 || type === 19 || type === 27 || type === 28 || (type >= 29 && type <= 36))) return;
    }
    const i = this.cell(x, y), t = this.terrain;
    if (t.height[i] >= this.mountain || t.cls[i] === CLASS_PATH) return;
    t.cls[i] = CLASS_PATH; t.tile[i] = this.groundRand.next() % 8; this.pathFlag[i] = 1;
    this.groundEdits.add(i);
    this.groundEvents.push([x, y, x, y]);
  }

  /** the cells an object blocks (buildings: footprint; every nature object, animals and carcasses too: its cell, 4.7) */
  private blockCells(e: Entity, fn: (i: number) => void): void {
    const cx = Math.floor(e.x / SUB), cy = Math.floor(e.y / SUB);
    if (e.kind === Kind.Building) {
      // footprint covers x - sizeX + 1 .. x and y - sizeY + 1 .. y (odb.md 2.2)
      const r = this.rules.get(e.oid);
      const sx = r?.sizeX || 2, sy = r?.sizeY || 2;
      for (let dy = 0; dy < sy; dy++)
        for (let dx = 0; dx < sx; dx++) fn(this.cell(cx - dx, cy - dy));
    } else if (e.kind === Kind.Nature) {
      fn(this.cell(cx, cy));
    }
  }

  private markBlocked(e: Entity): void {
    this.blockCells(e, i => { this.blocked[i] = 1; if (e.kind === Kind.Building) this.buildingCells[i] = 1; if (this.addon) this.shipBlocked[i] = 1; });
    if (e.kind === Kind.Nature && this.rules.get(e.oid)?.cls !== 7) {
      const i = this.cell(Math.floor(e.x / SUB), Math.floor(e.y / SUB));
      this.natureAt[i]++;
      if (this.addon) this.shipBlocked[i] = 1;
    }
  }

  private unmarkBlocked(e: Entity): void {
    this.blockCells(e, i => { this.blocked[i] = this.terrain.cls[i] === CLASS_WATER ? 1 : 0; if (e.kind === Kind.Building) this.buildingCells[i] = 0; if (this.addon) this.refreshShipCell(i); });
    if (e.kind === Kind.Nature && this.rules.get(e.oid)?.cls !== 7) {
      const i = this.cell(Math.floor(e.x / SUB), Math.floor(e.y / SUB));
      if (this.natureAt[i] > 0) this.natureAt[i]--;
      if (this.addon) this.refreshShipCell(i);
    }
  }

  private refreshShipCell(i: number): void {
    this.shipBlocked[i] = !this.seaCell(i) || this.buildingCells[i] || this.natureAt[i] > 0 ? 1 : 0;
  }


  get(id: number): Entity | undefined { return this.byId.get(id); }

  /** queue a command for a future tick (default: the next one) */
  schedule(cmd: Command, tick = this.tick + 1): void {
    this.queue.push({ tick, seq: this.seq++, cmd });
  }

  step(): void {
    this.tick++;
    this.motion.rebuild();
    const due = this.queue.filter(c => c.tick <= this.tick)
      .sort((a, b) => a.cmd.player - b.cmd.player || a.seq - b.seq);
    this.queue = this.queue.filter(c => c.tick > this.tick);
    for (const c of due) this.apply(c.cmd);
    this.sched.tick(job => (isMotionJob(job.kind) ? this.motion.runJob(job)
      : isCombatJob(job.kind) ? this.combat.runJob(job)
      : isLogisticsJob(job.kind) ? this.logistics.runJob(job)
      : isTradeJob(job.kind) ? this.trade.runJob(job)
      : isDiplomacyJob(job.kind) ? this.diplomacy.runJob(job)
      : isAiJob(job.kind) ? this.ai.runJob(job)
      : isNavalJob(job.kind) ? this.naval.runJob(job)
      : this.economy.runJob(job)));
    const t = this.tick;
    for (const e of this.entities) {
      if (e.path && e.moveAt <= t && (e.kind === Kind.Nature || (e.kind === Kind.Unit && e.inside < 0))) this.motion.run(e);
    }
  }

  /** the town a command may change: it must belong to the commanding player */
  private ownTown(player: number, id: number): Town | undefined {
    const t = this.economy.town(id);
    return t && t.alive && t.race === player ? t : undefined;
  }

  private apply(cmd: Command): void {
    if (cmd.type === 'sliders') {
      const t = this.ownTown(cmd.player, cmd.town);
      if (!t) return;
      const m = clampInt(cmd.motivation, 0, 100), r = clampInt(cmd.research, 0, 100);
      if (m + r > 100) return;   // the two shares may not exceed the income (handbook)
      t.motivationPct = m; t.researchPct = r;
      return;
    }
    if (cmd.type === 'research') {
      const t = this.ownTown(cmd.player, cmd.town);
      if (t) {
        this.economy.selectResearch(t, Math.trunc(cmd.invention));
        // mentor#16 "Du investierst nichts in Forschung!", unqueued (side-panel.md 1.1.3, `00450910`)
        if (cmd.invention >= 0 && (t.researchPct === 0 || t.researchSpent < 1)) this.notify(t.race, 16, false);
      }
      return;
    }
    if (cmd.type === 'order') {
      const target = this.byId.get(cmd.target);
      if (!target) return;
      const units = [...cmd.ids].sort((a, b) => a - b).map(id => this.byId.get(id))
        .filter((e): e is Entity => !!e && e.kind === Kind.Unit && e.owner === cmd.player && e.inside < 0 && e.id !== target.id);
      // an order naming a criminal is refused as a whole (`00450bb0` stops at it; combat.md 12.6)
      if (units.some(u => (u.oid & 0xffff) === T.Criminal)) return;
      this.logistics.order(units, target);
      // every job the order made is a player order (`00450bb0`, combat.md 7.2); set after the jobs
      // were made, since a new job clears the mark
      for (const u of units) u.ordered = true;
      return;
    }
    if (cmd.type === 'unit') {
      // go home acts on the first selected unit only, toward the player's current town (units-and-jobs.md 3.2)
      // drop goods also acts on the first selected unit only (command 0x53, units-and-jobs.md 3.2)
      if (cmd.action === 'drop') {
        const u = this.byId.get(cmd.ids[0]);
        if (u && u.kind === Kind.Unit && u.owner === cmd.player && (u.oid & 0xffff) !== T.Criminal) this.logistics.unitAction(u, 'drop');
        return;
      }
      if (cmd.action === 'home') {
        const u = this.byId.get(cmd.ids[0]);
        const t = cmd.town === undefined ? undefined : this.ownTown(cmd.player, cmd.town);
        if (u && u.kind === Kind.Unit && u.owner === cmd.player && (cmd.town === undefined || t)) this.logistics.unitAction(u, 'home', t);
        return;
      }
      for (const id of [...cmd.ids].sort((a, b) => a - b)) {
        const u = this.byId.get(id);
        // criminals have no unit-page buttons and are never commanded (combat.md 12.6)
        if (u && u.kind === Kind.Unit && u.owner === cmd.player && (u.oid & 0xffff) !== T.Criminal) this.logistics.unitAction(u, cmd.action);
      }
      return;
    }
    if (cmd.type === 'building' || cmd.type === 'train' || cmd.type === 'untrain') {
      const b = this.byId.get(cmd.type === 'building' ? cmd.id : cmd.building);
      if (!b || b.kind !== Kind.Building || b.owner !== cmd.player) return;
      if (cmd.type === 'building') this.logistics.buildingAction(b, cmd.action);
      else if (cmd.type === 'train') this.logistics.train(b, Math.trunc(cmd.unit));
      else this.logistics.cancelTraining(b, Math.trunc(cmd.index));
      return;
    }
    if (cmd.type === 'found') {
      const u = this.byId.get(cmd.unit);
      if (u && u.kind === Kind.Unit && u.owner === cmd.player) this.logistics.found(u, Math.trunc(cmd.x), Math.trunc(cmd.y));
      return;
    }
    if (cmd.type === 'fidget') { this.motion.fidget(cmd); return; }
    if (cmd.type === 'market' || cmd.type === 'route') { this.trade.apply(cmd); return; }
    if (cmd.type === 'diplomacy') { this.diplomacy.apply(cmd); return; }
    if (cmd.type === 'sendOut') {
      // our form of command 0x3A (units-and-jobs.md 4.11 "Our build"): the building travels in the
      // command and is validated (own, alive, a building); criminals and a town hall's founder are refused
      const b = this.byId.get(cmd.building), type = Math.trunc(Number(cmd.unit));
      if (!b || b.kind !== Kind.Building || b.owner !== cmd.player || !b.alive || !(type >= 0)) return;
      this.logistics.sendOut(b, type);
      return;
    }
    if (cmd.type === 'unload') {
      const s = this.byId.get(cmd.ship);
      if (s && this.isShip(s) && s.owner === cmd.player && s.passengers.length) this.naval.unload(s, Math.trunc(cmd.unit ?? -1));
      return;
    }
    if (cmd.type === 'patrol') {
      const u = this.byId.get(cmd.id);
      const pt = u ? u.oid & 0xffff : 0;
      // PATROL: land soldiers 29..36 and the warships 65, 66 (addon.md 4.1)
      if (u && u.kind === Kind.Unit && u.owner === cmd.player && u.inside < 0 && ((pt >= 29 && pt <= 36) || (this.isShip(u) && (pt === 65 || pt === 66)))) {
        this.combat.startGuard(u, cmd.points.slice(0, 7).map(([x, y]) => [Math.trunc(x), Math.trunc(y)] as [number, number]), 2);
      }
      return;
    }
    if (cmd.type === 'convert') {
      // command 0x57 (`00452b40`): 255 = UMWANDELN, convert the ring's share of the crop stock
      // now; any other value sets the ring, a standing setting of the town (economy.md 7)
      const t = this.ownTown(cmd.player, cmd.town);
      if (t && cmd.percent === CONVERT_NOW) this.economy.convertNow(t);
      else if (t) this.economy.setCropRing(t, clampInt(cmd.percent, 0, 100));
      return;
    }
    if (cmd.type === 'build') {
      const t = this.ownTown(cmd.player, cmd.town);
      // the placing nation's advisor: mentor#79 "Gebäude wird errichtet.", not queued (side-panel.md 1.1)
      if (t && this.logistics.placeBuilding(t, Math.trunc(cmd.building), Math.trunc(cmd.x) & (this.size - 1), Math.trunc(cmd.y) & (this.size - 1))) this.notify(t.race, 79, false);
      return;
    }
    if (cmd.type === 'move') {
      let ids = [...cmd.ids].sort((a, b) => a - b)
        // each unit on its own: own, a unit, not a criminal, not inside (`00451170`, combat.md 12.6)
        .filter(id => { const e = this.byId.get(id); return e && e.kind === Kind.Unit && e.owner === cmd.player && e.inside < 0 && (e.oid & 0xffff) !== T.Criminal; });
      if (this.addon) {
        const ships = ids.map(id => this.byId.get(id)!).filter(e => this.isShip(e));
        if (ships.length) { ids = ids.filter(id => !this.isShip(this.byId.get(id)!)); this.moveShips(ships, Math.trunc(cmd.x), Math.trunc(cmd.y)); }
      }
      const targets = this.spreadTargets(cmd.x, cmd.y, ids.length);
      ids.forEach((id, k) => {
        const e = this.byId.get(id)!;
        this.logistics.cancelJob(e);
        e.ordered = true;
        const [gx, gy] = targets[k];
        // the unit is always on a whole cell: a step under way only delays the first new step (setPath)
        const [cx, cy] = [Math.floor(e.x / SUB), Math.floor(e.y / SUB)];
        const path = this.findPathOn(this.blocked, cx, cy, gx, gy);
        if (path) this.setPath(e, path, gx, gy, 40000);
        else this.stopWalk(e);
      });
    }
  }

  /** move order for ships (addon.md 4.1): a free sea cell each; a fishing boat gets a fishing job there (6.1) */
  private moveShips(ships: Entity[], x: number, y: number): void {
    const targets = this.naval.shipTargets(x, y, ships.length, ships);
    ships.forEach((e, k) => {
      this.logistics.cancelJob(e);
      e.ordered = true;
      const t = targets[k];
      if (!t) return;
      if ((e.oid & 0xffff) === 64) { this.naval.startFishing(e, t[0], t[1], 1); return; }
      this.naval.walkShip(e, t[0], t[1]);
    });
  }

  /** n distinct free cells around (x, y), nearest first (rings of growing radius, fixed order) */
  private spreadTargets(x: number, y: number, n: number): [number, number][] {
    const out: [number, number][] = [];
    for (let r = 0; out.length < n && r < 24; r++) {
      for (let dy = -r; dy <= r && out.length < n; dy++)
        for (let dx = -r; dx <= r && out.length < n; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          if (!this.blocked[this.cell(x + dx, y + dy)]) out.push([(x + dx) & (this.size - 1), (y + dy) & (this.size - 1)]);
        }
    }
    while (out.length < n) out.push([x, y]);
    return out;
  }

  /** complete, versioned simulation state (terrain is rebuilt from the mission seed) */
  snapshot(): WorldSnapshot {
    return {
      v: SNAPSHOT_VERSION, tick: this.tick, nextId: this.nextId, seq: this.seq, rand: this.rand.state,
      entities: JSON.parse(JSON.stringify(this.entities)) as Entity[],
      queue: this.queue.map(q => ({ tick: q.tick, seq: q.seq, cmd: q.cmd })),
      sched: this.sched.snapshot(),
      economy: this.economy.snapshot(),
      respawns: this.respawns.map(r => ({ ...r })), respawnJob: this.respawnJob,
      trade: this.trade.snapshot(), diplomacy: this.diplomacy.snapshot(),
      lists: this.lists.map(l => l.map(([x, y]) => [x, y] as [number, number])),
      ai: this.ai.snapshot(),
      ground: [...this.groundEdits].sort((a, b) => a - b).map(i => [i, this.terrain.height[i], this.terrain.cls[i], this.terrain.tile[i], this.pathFlag[i]]),
      groundRand: this.groundRand.state,
      territory: this.territory.snapshot(),
      enters: this.enters,
      advisor: [...this.advisorLast].sort((a, b) => a[0] - b[0]).map(([k, t]) => [Math.floor(k / 1024), k % 1024, t] as [number, number, number]),
      ...(this.addon ? { addon: true, gold: { ...this.gold }, naval: this.naval.snapshot() } : {}),
    };
  }

  /** rebuild a world from a snapshot taken on the same mission */
  static restore(terrain: Terrain, snap: WorldSnapshot, rules: Map<number, ObjectRule> = new Map(), weapons: Weapon[] = []): World {
    if (snap.v !== SNAPSHOT_VERSION && snap.v !== 2 && snap.v !== 3 && snap.v !== 4 && snap.v !== 5 && snap.v !== 6 && snap.v !== 7 && snap.v !== 8 && snap.v !== 9 && snap.v !== 10 && snap.v !== 11 && snap.v !== 12 && snap.v !== 13) throw new Error(`Spielstand-Version ${snap.v} wird nicht unterstützt`);
    const w = new World(terrain, [], rules);
    w.weapons = weapons;
    // terrain edits go onto the freshly generated terrain before anything reads it
    for (const [i, h, c, tl, p] of snap.ground ?? []) {
      terrain.height[i] = h; terrain.cls[i] = c; terrain.tile[i] = tl; w.pathFlag[i] = p; w.groundEdits.add(i);
    }
    if (snap.groundRand !== undefined) w.groundRand.state = snap.groundRand;
    if (snap.gold) w.gold = { ...w.gold, ...snap.gold };
    for (const e of JSON.parse(JSON.stringify(snap.entities)) as Entity[]) {
      const copy: Entity = e;
      copy.passengers ??= [];
      copy.enterSeq ??= 0;
      copy.walks ??= []; copy.walkMask ??= 0;
      if (snap.v < 4) migrateMovement(copy, snap.tick, w.size);
      // before version 6: no door counter, no enter sequence (a unit inside stays inside; units on
      // their way out were already placed by the old immediate leave)
      if (snap.v < 6) { copy.door = 0; copy.doorOpen = -1000; copy.doorShut = -1000; copy.entering = -1; copy.enterStep = 0; }
      w.entities.push(copy);
      w.byId.set(copy.id, copy);
      w.markBlocked(copy);
    }
    w.entities.sort((a, b) => a.id - b.id);
    w.tick = snap.tick; w.nextId = snap.nextId; w.seq = snap.seq; w.enters = snap.enters ?? 0;
    w.rand.state = snap.rand;
    w.queue = snap.queue.map(q => ({ ...q }));
    w.sched = Scheduler.restore(snap.sched);
    w.economy.restore(snap.economy);
    // before version 7 need thresholds were raised at completion (economy.md 5.3)
    if (snap.v < 7) w.economy.migrateNeeds();
    // before version 9 the attack state had no walk flag and no stored plan (combat.md 3.3.1)
    if (snap.v < 9) w.combat.migrateV8(w.sched.jobs(), HV.Attack, HG.Harvest + HV.Attack);
    // before version 10 the towns kept no criminal list: it is rebuilt in creation order, the
    // order the old build used (combat.md 12.3)
    if (snap.v < 10) for (const t of w.economy.towns) t.criminals ??= [];
    // before version 11 a news stand's operator job ended after its first run (no news round,
    // units-and-jobs.md 8.6): a staffed, active stand gets a new one, first run after 100 ticks
    if (snap.v < 11) w.logistics.migrateNewsStands();
    // before version 12 the ring was not kept (only "convert now" existed, the divisor stayed 0):
    // the ring starts off, as in a new town
    if (snap.v < 12) for (const t of w.economy.towns) { t.cropPct ??= 0; t.cropDiv ??= 0; t.cropAcc ??= 0; }
    // before version 13 a delivery order that did not happen lost its site's needed entry, which
    // could leave a site waiting for ever (units-and-jobs.md 5.8 item 10): re-file what is missing
    if (snap.v < 13) w.logistics.refileLostSiteNeeds();
    for (const [race, mentor, t] of snap.advisor ?? []) w.advisorLast.set(race * 1024 + mentor, t);
    w.respawns = snap.respawns.map(r => ({ ...r })); w.respawnJob = snap.respawnJob;
    w.logistics.ensureRespawnManager();   // saves from before October 2026 ran it only while it had entries
    w.trade.restore(snap.trade); w.diplomacy.restore(snap.diplomacy); w.ai.restore(snap.ai); w.naval.restore(snap.naval);
    // before version 14 the planner's ship counter limited nothing: every ship starts at 100 (addon.md 8.4)
    if (snap.v < 14) w.naval.migrateCounters();
    if (snap.lists) w.lists = snap.lists.map(l => l.map(([x, y]) => [x, y] as [number, number]));
    if (snap.territory) w.territory.restore(snap.territory);
    else w.migrateTerritory();
    return w;
  }

  /**
   * Saves before version 5 have no territory: rebuild it from the buildings in creation (id)
   * order, every town hall (sites too) and every completed outpost. The original's ownership
   * depends on the order of past adds and removals, which a save without the map cannot give
   * back, so overlapping territories may be split differently than in the running game (deviation).
   */
  private migrateTerritory(): void {
    this.territory.reset();
    for (const e of this.entities) {
      if (e.kind !== Kind.Building || e.town < 0) continue;
      const type = e.oid & 0xffff, r = this.rules.get(e.oid);
      if (type === T.TownHall || (r?.cls === 6 && e.complete)) this.claimTerritory(e);
    }
  }

  /** 32-bit FNV-1a over the full simulation state, for desync detection */
  hash(): number {
    let h = 0x811c9dc5;
    const mix = (v: number) => {
      for (let k = 0; k < 4; k++) { h ^= (v >>> (k * 8)) & 0xff; h = Math.imul(h, 0x01000193); }
    };
    mix(this.tick); mix(this.rand.state); mix(this.enters);
    for (const e of this.entities) {
      mix(e.id); mix(e.oid); mix(e.owner); mix(e.town); mix(e.home); mix(e.inside); mix(e.enterSeq); mix(e.hp); mix(e.occupancy);
      mix(e.x); mix(e.y); mix(e.dir); mix(e.action); mix(e.actionTick); mix(e.idleTick);
      mix(e.path ? e.path.length : -1); mix(e.stepStart); mix(e.stepTicks); mix(e.moveAt);
      mix(e.plans); mix(e.walkState); mix(e.squeeze); mix(e.walkResult); mix(e.walkMask);
      if (e.walks.length) { mix(-9); for (const k of e.walks) { mix(k.job); mix(k.path ? k.path.length : -1); mix(k.plans); mix(k.goalX); mix(k.goalY); mix(k.walkState); } }
      mix(e.job); mix(e.idle); mix(e.alive ? 1 : 0); mix(e.carryGood); mix(e.cooldownUntil); mix(e.exp); mix(e.suspended.length); mix(e.carryAmount); mix(e.amount); mix(e.reserved);
      mix(e.needed.length); mix(e.outputs.length); mix(e.doorQueue.length); mix(e.door); mix(e.entering); mix(e.enterStep); mix(e.queue.length); mix(e.trainProgress);
      for (const v of e.local) mix(v);
      if (e.passengers.length) { mix(-7); for (const v of e.passengers) mix(v); }
    }
    this.sched.digest(mix);
    this.economy.digest(mix);
    this.trade.digest(mix);
    this.diplomacy.digest(mix);
    this.ai.digest(mix);
    this.naval.digest(mix);
    this.territory.digest(mix);
    mix(this.groundEdits.size); mix(this.groundRand.state);
    // order-independent (a restored world lists the edits sorted)
    let g = 0;
    for (const i of this.groundEdits) g = (g + Math.imul(i + 1, 0x9e3779b1) + Math.imul(this.terrain.height[i] * 16 + this.terrain.cls[i] * 2 + this.pathFlag[i] + 1, 0x85ebca6b)) | 0;
    mix(g);
    return h >>> 0;
  }
}

const clampInt = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.trunc(Number(v) || 0)));
const wrapDelta = (d: number, n: number) => (d > n / 2 ? d - n : d < -n / 2 ? d + n : d);

/** go-to target candidates (4.8): the point, then N (y-1), W (x-1), S (y+1), E (x+1) */
const GOTO_CANDIDATES: readonly [number, number][] = [[0, 0], [0, -1], [-1, 0], [0, 1], [1, 0]];

/**
 * Save games before version 4 kept units between cells while stepping: put such a unit on the
 * step's destination (the original's model: the simulation position moves at the step's start) and
 * fill the movement fields.
 */
function migrateMovement(e: Entity, tick: number, size: number): void {
  const old = e as Entity & { stepT?: number };
  const m = size - 1;
  let x = Math.floor(e.x / SUB) & m, y = Math.floor(e.y / SUB) & m;
  const stepping = (old.stepTicks ?? 0) > 0 && e.path && e.path.length > 0;
  if (stepping) { [x, y] = e.path!.shift()!; x &= m; y &= m; if (!e.path!.length) e.path = []; }
  e.x = x * SUB + SUB / 2; e.y = y * SUB + SUB / 2;
  const left = stepping ? Math.max(1, (old.stepTicks ?? 0) - (old.stepT ?? 0)) : 0;
  delete old.stepT;
  const goal = e.path && e.path.length ? e.path[e.path.length - 1] : [x, y];
  Object.assign(e, movementDefaults(e.x, e.y, goal[0], goal[1]));
  e.idleTick ??= -1; e.idleLoops ??= 0;
  e.plans = 1; e.walkNodes = 6000;
  e.moveAt = tick + left;
  if (stepping) { e.stepStart = tick - 1; e.stepTicks = left + 1; }
}

/** movement fields of a new entity standing on a cell (fixed-point centre px, py; cell x, y) */
function movementDefaults(px: number, py: number, x: number, y: number) {
  return {
    stepFromX: px, stepFromY: py, stepStart: -1000, stepTicks: 0, moveAt: 0,
    goalX: x, goalY: y, walkNodes: 0, plans: 0, walkState: 0, squeeze: 0, pushes: 0, walkResult: 0, walkMask: 0,
  };
}
