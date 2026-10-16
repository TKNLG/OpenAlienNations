// Computer towns: the planner (0x32), economy (0x33) and military (0x34) jobs.
// Spec: docs/game/ai-diplomacy-trade.md 1.3 to 1.11, 2.2 and 4.6 (section numbers below).
// Integration: docs/architecture/integration-ai.md.

import type { Job } from './scheduler.ts';
import type { Entity } from './world.ts';
import type { Town } from './economy.ts';
import type { Ai } from './ai.ts';
import { Grp, U, B, TYPES, KIND_UNIT, KIND_BUILDING, KIND_NATURE, ring } from './ai-defs.ts';
import { ShipType, HARBOUR, SHIPYARD, type Planner } from './naval.ts';
import { needsTerritory } from './territory.ts';

/** the AI state of one computer town (saved with the game) */
export interface AiTown {
  town: number;
  /** job ids of the planner, economy and military jobs (0 = none) */
  planner: number; economy: number; military: number;
  /** extra wants per object type (1.3): A economy gangs and merchants, B defence, C strategy and planner */
  A: number[]; B: number[]; C: number[];
  /** build queue: [type, priority, fixed anchor 0/1, x, y], sorted by priority (1.5) */
  build: number[][];
  /** training queue: [type, priority] (1.6) */
  train: number[][];
  /**
   * The town's type lists in the original's order (1.5, 1.7): creation order, except buildings the
   * AI moved to the back of their list (training round robin, outpost anchors). Flat pairs
   * [building id, order key]; buildings not listed have the key id x 65536.
   */
  moved: number[];
  /** units recorded as intruders (2.2): other races' units seen standing in the town's area */
  intruders: number[];
  /** military: under attack flag and defence reserve percent (2.2) */
  underAttack: number; reserve: number;
  /** a laboratory was active at the last check (1.11) */
  labSeen: number;
}

export function newTownState(town: number, width = TYPES): AiTown {
  const z = () => new Array<number>(width).fill(0);
  return { town, planner: 0, economy: 0, military: 0, A: z(), B: z(), C: z(), build: [], train: [], moved: [], intruders: [], underAttack: 0, reserve: 0, labSeen: 0 };
}

/** build priorities (table `004afee8`, 1.5) */
const BUILD_PRIO: Record<number, number> = {
  55: 2, 46: 4, 37: 5, 38: 5, 41: 7, 54: 7, 61: 7, 39: 8, 45: 9, 50: 11, 48: 12, 52: 12, 53: 12,
  43: 13, 49: 13, 56: 13, 42: 14, 44: 14, 57: 14, 60: 14, 47: 15, 51: 16, 58: 16, 59: 16,
  // add-on (table 0x4BD078, docs/game/addon.md 8.1)
  62: 8, 63: 4,
};
/** unit priorities (1.6) */
function unitPrio(t: number): number {
  switch (t) {
    case 9: return 1;
    case 11: return 2;
    case 19: case 27: return 3;
    case 14: return 5;
    case 23: return 6;
    case 13: case 25: return 10;
    case 17: case 21: return 12;
    case 29: return 13;
    case 10: case 26: return 15;
    case 64: return 12;   // add-on ships (addon.md 8.1): fishing boat 12, warships 14, transport 4
    case 67: return 4;
    default: return 14;
  }
}
/** essential workers per race (1.6 step 1) */
const ESSENTIAL = [[U.Woodcutter, U.Stonemason, U.Builder], [U.Stonemason, U.Woodcutter, U.Builder], [U.Builder, U.Stonemason, U.Woodcutter]];
/** gang factors wood / stone per race (1.8) */
const GANG_FACTOR = [[4, 2], [2, 4], [3, 3]];
const WOOD = 1, STONE = 2, IRON = 3, FOOD = 4;
/** nature classes (odb.md 4) */
const NC = { Animal: 7, Tree: 8, Bush: 9, Stone: 13 } as const;

// ---------------------------------------------------------------- census

/** one pass over the town's objects */
interface Census {
  /** buildings of each type: all (incl. sites), complete, active */
  all: number[]; done: number[]; active: number[];
  /** units of each type */
  units: number[];
  /** buildings (incl. sites) whose operator is that unit type */
  opBld: number[];
  sites: number; completed: number;
  /** all porters of the town (any group, inside or outside); free porters and builders of group 0 (section 0) */
  porters: number; freePorters: number; freeBuilders: number;
  /** porters in the town's porter gang (group 50, 1.10) */
  gang: number;
}

function census(ai: Ai, t: Town): Census {
  const W = ai.w.typeWidth;
  const z = () => new Array<number>(W).fill(0);
  const c: Census = { all: z(), done: z(), active: z(), units: z(), opBld: z(), sites: 0, completed: 0, porters: 0, freePorters: 0, freeBuilders: 0, gang: 0 };
  for (const e of ai.w.entities) {
    if (e.town !== t.id || (e.oid >>> 16) !== t.race || !e.alive) continue;
    const ty = e.oid & 0xffff;
    if (ty >= W) continue;
    if (e.kind === KIND_BUILDING) {
      c.all[ty]++;
      if (e.complete) { c.done[ty]++; c.completed++; } else c.sites++;
      if (e.active) c.active[ty]++;
      const op = ai.w.rules.get(e.oid)?.operator ?? -1;
      if (op >= 0 && op < W) c.opBld[op]++;
    } else if (e.kind === KIND_UNIT) {
      c.units[ty]++;
      if (ty === U.Porter) { c.porters++; if (e.group === Grp.Porters) c.gang++; if (ai.free(e)) c.freePorters++; }
      else if (ty === U.Builder && ai.free(e)) c.freeBuilders++;
    }
  }
  return c;
}

const pending = (t: Town, type: number) => t.pending[type] ?? 0;

/** the town's jobs only run while it lives and its town hall is active (0045ff30) */
function aliveTown(ai: Ai, job: Job, slot: 'planner' | 'economy' | 'military'): { t: Town; s: AiTown } | null {
  const t = ai.w.economy.town(job.owner);
  const s = ai.town(job.owner);
  if (!s || s[slot] !== job.id) return null;
  const hall = t ? ai.w.get(t.hall) : undefined;
  if (!t || !t.alive || !hall || !hall.active) { s[slot] = 0; return null; }
  return { t, s };
}

// ---------------------------------------------------------------- planner (0x32, 1.3)

export function runPlanner(ai: Ai, job: Job): number {
  const live = aliveTown(ai, job, 'planner');
  if (!live) return 0;
  const { t, s } = live;
  let c = census(ai, t);
  if ((job.data[0] & 1) === 0) buildTargets(ai, t, s, c);
  else { porterGang(ai, t); c = census(ai, t); trainingNeeds(ai, t, s, c); }
  job.data[0] = (job.data[0] + 1) & 1;
  if (placeOne(ai, t, s, c)) c = census(ai, t);
  trainOne(ai, t, s, c);
  return 50;
}

/** building targets (1.4, `0046b490`) */
function buildTargets(ai: Ai, t: Town, s: AiTown, c: Census): void {
  const builders = c.units[U.Builder] + pending(t, U.Builder);
  if (c.sites > 2 * builders) return;
  const w = ai.w, eco = w.economy, p = eco.players[t.race]!;
  const P = Math.max(1, t.population);
  const W = ai.w.typeWidth;
  const tg = new Array<number>(W).fill(0);
  const res = (ty: number) => w.rules.get(((t.race << 16) | ty) >>> 0)?.residents ?? 0;
  // housing from the type lists, construction sites included (1.4)
  const H = c.all[B.House] * res(B.House) + c.all[B.LargeHouse] * res(B.LargeHouse);
  const N = c.completed;
  // a new house: H < 150, O > 50 %, and the porter share under 50 %, or the free share under 5 %, or
  // no free porter, or (a free builder, P < 70 and at most 19 free places in both the stone and the
  // wood store) (1.4 house rule)
  const houseRule = () => houseWanted(H, P, c.porters, c.freePorters, c.freeBuilders, t.capacity - t.stock[STONE], t.capacity - t.stock[WOOD]);
  if (N <= 1) tg[B.School] = 1;
  else if (N === 2) { tg[B.School] = 1; tg[B.House] = 1; }
  else if (N === 3) { tg[B.School] = 1; tg[B.House] = 1; s.C[B.Lab] = 1; }
  else if (N === 4) { tg[B.School] = 1; tg[B.House] = 2; }
  else if (c.porters * 10 < t.population) {
    // porter shortage: keep everything as it is, one more house (applied to every race, see doc)
    for (let ty = 0; ty < W; ty++) tg[ty] = c.all[ty];
    tg[B.House] = c.all[B.House] + 1;
  } else {
    const firstTown = p.towns.find(id => eco.towns[id]?.alive) === t.id;
    tg[B.School] = 1;
    tg[B.House] = c.all[B.House] + (houseRule() ? 1 : 0);
    tg[B.LargeHouse] = c.all[B.LargeHouse];
    tg[B.Mine] = P > 60 ? 2 : P >= 26 ? 1 : 0;
    tg[B.Warehouse] = c.all[B.Mine] + (P > 25 ? 2 : P >= 16 ? 1 : 0);
    tg[B.Armoury] = c.all[B.Mine];
    tg[B.Farm] = P > 40 ? 2 : P >= 26 ? 1 : 0;
    tg[B.Luxury] = c.all[B.Farm];
    tg[B.Barracks] = P > 15 ? 1 : 0;
    tg[B.Embassy] = P > 15 && firstTown ? 1 : 0;
    tg[B.Police] = P >= 18 ? 1 : 0;
    tg[B.Market] = P > 20 ? 1 : 0;
    tg[B.Bank] = t.income > 110 ? 1 : 0;
    tg[B.Library] = t.researchSpent > 100 ? 1 : 0;
    tg[B.Watchtower] = Math.trunc(P / 20);
    tg[B.CreatureYard] = P > 40 && (t.id & 1) === 1 ? 1 : 0;
    tg[B.MageTower] = P > 40 && (t.id & 1) === 0 ? 1 : 0;
    if (w.addon) { tg[HARBOUR] = P > 19 ? 1 : 0; tg[SHIPYARD] = P > 14 ? 1 : 0; }   // addon.md 8.1
    // outposts while the area is small for the number of buildings
    if (w.territory.area(t.id) < (c.completed + c.sites) * 20 + 40) {
      if (w.logistics.menuState(t, B.LargeOutpost) === 1) tg[B.LargeOutpost] = c.all[B.LargeOutpost] + 1;
      else tg[B.SmallOutpost] = c.all[B.SmallOutpost] + 1;
    }
    // the most urgent open need (`0045a290`: the first entry of the open-need set if its threshold
    // is below the population): rand() is drawn first, then with chance 1/30 one more building of
    // that type when every existing one is active
    const need = urgentNeed(ai, t);
    if (need >= 0) {
      const roll = ai.rand() % 30;
      if (roll === 0 && need < W && c.all[need] === c.active[need]) tg[need] = c.all[need] + 1;
    }
  }
  for (const ty of buildingTypes(ai, t.race)) {
    const target = tg[ty] + s.C[ty];
    if (c.all[ty] < target && c.all[ty] === c.done[ty]) queueBuild(ai, t, s, c, ty);
  }
}

/**
 * The house rule (1.4, `0046b490` from `0x46b87d`): H housing places (type lists, sites included),
 * P = max(1, population), porters (all), free porters and free builders of group 0, free places in
 * the stone and the wood store. Occupancy O = P x 100 / H (H < 2 counts as 1).
 */
export function houseWanted(H: number, P: number, porters: number, freePorters: number, freeBuilders: number, stoneSpace: number, woodSpace: number): boolean {
  const O = Math.trunc((P * 100) / Math.max(1, H));
  if (!(H < 150 && O > 50)) return false;
  return Math.trunc((porters * 100) / P) < 50 || Math.trunc((freePorters * 100) / P) < 5 || freePorters === 0 ||
    (freeBuilders > 0 && P < 70 && stoneSpace <= 19 && woodSpace <= 19);
}

/** the first entry of the town's open-need set if its threshold is strictly below the population, else -1 (`0045a290`) */
function urgentNeed(ai: Ai, t: Town): number {
  if (!t.open.length) return -1;
  const first = t.open[0];
  const th = first < 1000 ? t.needs.find(n => n.type === first)?.threshold
    : ai.w.economy.luxuryThresholds(t).find(([g]) => g === first - 1000)?.[1];
  return th !== undefined && th < t.population ? first : -1;
}

/** the race's buildable types in type order (made in the build menu) */
function buildingTypes(ai: Ai, race: number): number[] {
  return [...ai.w.rules.values()].filter(r => r.group === race && r.kind === KIND_BUILDING && r.madeAt >= 37 && r.type < ai.w.typeWidth)
    .map(r => r.type).sort((a, b) => a - b);
}
function unitTypes(ai: Ai, race: number): number[] {
  return [...ai.w.rules.values()].filter(r => r.group === race && r.kind === KIND_UNIT && r.madeAt >= 37 && r.type < ai.w.typeWidth && r.type !== U.Criminal)
    .map(r => r.type).sort((a, b) => a - b);
}

/**
 * Snapping (1.5, `0046ac30`): an explicit anchor is always replaced by the nearest block of the
 * town's territory border list, converted to its cell (2 x block), inside or outside alike;
 * distance wrapped max + min/2, strict "<" so the first border block wins ties. No territory
 * record (or an empty border list): (-1, -1), wrapped.
 */
export function snap(ai: Ai, t: Town, x: number, y: number): [number, number] {
  const ter = ai.w.territory, rec = ter.record(t.id);
  if (!rec || !rec.border.length) return [ai.mask(-1), ai.mask(-1)];
  let best = rec.border[0], bd = Infinity;
  for (const b of rec.border) {
    const bx = (b % ter.half) * 2, by = Math.floor(b / ter.half) * 2;
    const d = ai.dist(x, y, bx, by);
    if (d < bd) { bd = d; best = b; }
  }
  return [ai.mask((best % ter.half) * 2), ai.mask(Math.floor(best / ter.half) * 2)];
}

/** nearest region point of a list to the town (first wins ties), or null */
function nearestPoint(ai: Ai, t: Town, list: [number, number][]): [number, number] | null {
  let best: [number, number] | null = null, bd = Infinity;
  for (const [x, y] of list) { const d = ai.dist(x, y, t.x, t.y); if (d < bd) { bd = d; best = [x, y]; } }
  return best;
}

function firstBuilding(ai: Ai, t: Town, type: number): Entity | undefined {
  return ai.list(t, type)[0];
}

/**
 * The explicit anchor of an outpost, watchtower or warehouse request (1.5 "Where"), snapped.
 * `count`: the town's count of the type (sites included); `sign`: the outpost / tower draw (+-1).
 */
export function anchor(ai: Ai, t: Town, ty: number, count: number, sign: number): [number, number] {
  let x = t.x, y = t.y;
  if (ty === B.SmallOutpost || ty === B.LargeOutpost) {
    if ((count & 1) === 0) x += 50 * sign; else y += 50 * sign;
  } else if (ty === B.Watchtower) {
    if ((count & 1) === 0) { x += 50 * sign; y += 50 * sign; } else { x += 50 * sign; y -= 50 * sign; }
  } else if (ty === B.Warehouse) {
    // count 0 / 1: the nearest point of the region list (Amazons forest first, the others stone
    // first), cell (0, 0) for an empty list; count 2+: the first mine, else the town centre
    if (count < 2) [x, y] = nearestPoint(ai, t, ai.points((t.race === 0) === (count === 0) ? 0 : 1)) ?? [0, 0];
    else { const mine = firstBuilding(ai, t, B.Mine); if (mine) [x, y] = ai.cell(mine); }
  }
  return snap(ai, t, x, y);
}

/** queue a build request (1.5 "Queue"): sorted by priority, newest first among equals, one per type */
function queueBuild(ai: Ai, t: Town, s: AiTown, c: Census, type: number): void {
  const lg = ai.w.logistics;
  // outposts and watchtowers draw their sign before the menu-state and "already queued" tests (1.5)
  const sign = type === B.SmallOutpost || type === B.LargeOutpost || type === B.Watchtower ? (ai.rand() % 2 === 0 ? 1 : -1) : 1;
  if (s.build.some(r => r[0] === type) || lg.menuState(t, type) !== 1) return;
  let ty = type;
  // house substitution: a large house with chance 2/3
  if (type === B.House && lg.menuState(t, B.LargeHouse) === 1 && t.population > 20 && ai.rand() % 3 !== 0) ty = B.LargeHouse;
  if (ty !== type && s.build.some(r => r[0] === ty)) return;
  const fixed = ty === B.SmallOutpost || ty === B.LargeOutpost || ty === B.Watchtower || ty === B.Warehouse ? 1 : 0;
  const [x, y] = fixed ? anchor(ai, t, ty, c.all[ty], sign) : [t.x, t.y];
  // the AI build queue asks the build-menu check, which tops a shipyard's goods up (addon.md 3.5)
  if (ty === SHIPYARD && ai.w.addon && ai.w.gold.shipyardTopUp) {
    const r = ai.w.rules.get(((t.race << 16) | ty) >>> 0);
    if (r) lg.topUp(t, r);
  }
  const prio = BUILD_PRIO[ty] ?? 16;
  const i = s.build.findIndex(r => r[1] >= prio);
  const req = [ty, prio, fixed, x, y];
  if (i < 0) s.build.push(req); else s.build.splice(i, 0, req);
}

/** place at most one building (1.5 placement step, `0046c1a0`); true if a site was created */
function placeOne(ai: Ai, t: Town, s: AiTown, c: Census): boolean {
  if (!s.build.length || c.sites > c.units[U.Builder] + pending(t, U.Builder)) return false;
  const [type, , fixed, fx, fy] = s.build.shift()!;
  const w = ai.w;
  const r = w.rules.get(((t.race << 16) | type) >>> 0);
  if (!r) return false;
  const sx = Math.max(1, r.sizeX), sy = Math.max(1, r.sizeY);
  const padY = sy + 2 + (ai.rand() % 3), padX = sx + 2 + (ai.rand() % 3);
  let ax = fx, ay = fy, radius = 10;
  if (!fixed) {
    radius = 2 * ai.radius(t);
    // the town's outpost lists (sites included); the one used goes to the back of its own list
    const smalls = ai.list(t, B.SmallOutpost), larges = ai.list(t, B.LargeOutpost);
    let base: Entity | undefined;
    if (smalls.length && ai.rand() % 2 === 1) base = smalls[0];
    else if (larges.length) base = larges[0];
    if (base) ai.moveToBack(t, base);
    [ax, ay] = base ? ai.cell(base) : [t.x, t.y];
    ax += 4 - (ai.rand() % 9);
    ay += 4 - (ai.rand() % 9);
  }
  const mountainsOk = type === B.Mine || type === B.SmallOutpost || type === B.LargeOutpost;
  const shore = w.addon && (type === HARBOUR || type === SHIPYARD);
  const ter = w.territory, area = needsTerritory(type, w.addon);
  // Q is the padded rectangle's maximum corner; the building's anchor (its footprint's maximum
  // corner) is Q - (1, 1): one free cell on the maximum side, 1..3 on the minimum side (1.5 steps 5, 6)
  const fits = (qx: number, qy: number): boolean => {
    const bx = ai.mask(qx - 1), by = ai.mask(qy - 1);
    // the four corner blocks of the padded rectangle in the town's own territory (flag 0x800, economy.md 11.7)
    if (area && !ter.inTown(t.id, ai.mask(qx), ai.mask(qy), padX, padY)) return false;
    // harbour / shipyard: the shore site test with the padded rectangle (addon.md 3.1, 8.1)
    if (shore) return w.logistics.canPlaceShore(t, r, bx, by, [padX, padY]) && w.logistics.canPlace(t, r, bx, by);
    const x0 = qx - padX + 1, y0 = qy - padY + 1;
    for (let dy = 0; dy < padY; dy++) for (let dx = 0; dx < padX; dx++) {
      const x = x0 + dx, y = y0 + dy;
      // buildings, nature, water and (mask bit 0x02) units block; mountains except for mine and outposts
      if (w.occupied(x, y) || !w.motion.free(x, y)) return false;
      if (!mountainsOk && w.heightAt(x, y) > w.mountain) return false;
    }
    return w.logistics.canPlace(t, r, bx, by);
  };
  for (let k = 0; k <= radius >> 1; k++) {
    for (const [x, y] of ring(ax, ay, k)) {
      if (!fits(x, y)) continue;
      return !!w.logistics.placeBuilding(t, type, ai.mask(x - 1), ai.mask(y - 1));
    }
  }
  return false;
}

/** unit training needs (1.6, `0046b0f0`) */
function trainingNeeds(ai: Ai, t: Town, s: AiTown, c: Census): void {
  const w = ai.w, p = w.economy.players[t.race]!;
  const have = (ty: number) => c.units[ty] + pending(t, ty);
  const queued = (ty: number) => s.train.some(r => r[0] === ty);
  for (const ty of ESSENTIAL[t.race] ?? ESSENTIAL[0]) {
    if (have(ty) > 0) continue;
    let pick: number = ty;
    const inv = w.rules.get(((t.race << 16) | ty) >>> 0)?.invention ?? -1;
    if (inv >= 0 && !w.economy.researched(p, inv) && have(U.Scholar) === 0) pick = U.Scholar;
    if (!queued(pick)) s.train.unshift([pick, 0]);
    return;
  }
  if (s.train.length && s.train[0][1] === 0) return;
  // add-on: the naval planner's ships first (addon.md 8.5); its claim counts join every want
  const pl = w.addon ? w.naval.planner(t.race) : null;
  if (pl && navalNeeds(ai, t, s, pl)) return;
  const P = t.population;
  for (const ty of unitTypes(ai, t.race)) {
    let want = c.opBld[ty] + s.C[ty] + s.B[ty] + s.A[ty] + (pl?.claim[ty] ?? 0) - pending(t, ty) - c.units[ty];
    if (ty === U.Builder) want += 1 + (P > 20 ? 1 : 0);
    if (want <= 0 || queued(ty)) continue;
    const prio = unitPrio(ty);
    const i = s.train.findIndex(r => r[1] >= prio);
    if (i < 0) s.train.push([ty, prio]); else s.train.splice(i, 0, [ty, prio]);
  }
}

/**
 * The porter gang (1.10, `0046aed0`, every 100 ticks, before the training needs): wanted size n =
 * 2 below 6 porters, else min(10, porters / 2). Free group-0 porters join (town-list order), but
 * n / 4 + 1 of them stay outside when n > 2; a surplus is released (group 0). Only the gang hauls
 * in a computer town (logistics `haulGroup`); the other porters are the trainees (1.7).
 */
export function porterGang(ai: Ai, t: Town): void {
  const gang: Entity[] = [], free: Entity[] = [];
  let p = 0;
  for (const e of ai.w.entities) {
    if (e.kind !== KIND_UNIT || e.town !== t.id || (e.oid & 0xffff) !== U.Porter || (e.oid >>> 16) !== t.race || !e.alive) continue;
    p++;
    if (e.group === Grp.Porters) gang.push(e);
    else if (ai.free(e)) free.push(e);
  }
  const n = p < 6 ? 2 : Math.min(10, p >> 1);
  if (gang.length < n) {
    const reserve = n > 2 ? (n >> 2) + 1 : 0;
    let left = free.length;
    for (const e of free) {
      if (gang.length >= n || left <= reserve) break;
      e.group = Grp.Porters;
      gang.push(e);
      left--;
    }
  }
  while (gang.length > n) gang.pop()!.group = Grp.None;
}

/** training execution (1.7, `0046c670`): at most one order per run */
function trainOne(ai: Ai, t: Town, s: AiTown, c: Census): void {
  const w = ai.w;
  // the gate: a free group-0 porter (the trainee) and a non-empty porter gang
  if (c.freePorters < 1 || c.gang < 1) {
    if (c.gang < 2) flushSchools(ai, t);
    return;
  }
  while (s.train.length) {
    const [type] = s.train.shift()!;
    const r = w.rules.get(((t.race << 16) | type) >>> 0);
    if (!r) continue;
    // the first building of the town's list that is not a site and passes the order check; the
    // check does not test the 5-order limit, so a full building silently refuses and the request
    // is consumed all the same; the building goes to the back of the list (round robin)
    for (const b of ai.list(t, r.madeAt)) {
      if (!b.complete || w.logistics.trainState(t, b, type) !== 1) continue;
      w.logistics.train(b, type);
      ai.moveToBack(t, b);
      return;
    }
  }
}

/**
 * No free porter or no gang, and fewer than 2 gang porters: every completed school queues one
 * porter order per occupant not covered by its orders (1.7 third bullet, I: flushes stuck
 * occupants back out as porters).
 */
function flushSchools(ai: Ai, t: Town): void {
  const lg = ai.w.logistics;
  for (const b of ai.list(t, B.School)) {
    if (!b.complete) continue;
    for (let k = lg.trainees(b).length - b.queue.length; k > 0; k--) if (!lg.train(b, U.Porter)) break;
  }
}

/**
 * The naval planner's part of the training needs (addon.md 8.5, `004740c0`): for 65, 66, 67 the
 * town's ungrouped ships of that type are registered (build count first, then claim count, one
 * walk over the town's list); a type whose build count stays above 0 is put at the front of the
 * training queue (priority 0) unless queued, and the training needs end there for this phase.
 */
function navalNeeds(ai: Ai, t: Town, s: AiTown, pl: Planner): boolean {
  const w = ai.w;
  let naval = false;
  for (const ty of [ShipType.Light, ShipType.Heavy, ShipType.Transport]) {
    for (const e of w.entities) {
      if (pl.build[ty] <= 0 && pl.claim[ty] <= 0) break;
      if (e.kind !== KIND_UNIT || e.town !== t.id || (e.oid & 0xffff) !== ty || (e.oid >>> 16) !== t.race || !e.alive || e.group !== Grp.None) continue;
      w.naval.registerShip(t.race, e);
    }
    if (pl.build[ty] <= 0) continue;
    naval = true;
    if (!s.train.some(r => r[0] === ty)) s.train.unshift([ty, 0]);
  }
  return naval;
}

// ---------------------------------------------------------------- economy (0x33, 1.8)

export function runEconomy(ai: Ai, job: Job): number {
  const live = aliveTown(ai, job, 'economy');
  if (!live) return 0;
  const { t, s } = live;
  // Gold: skipped while the town has no storage capacity (addon.md 10.4)
  if (ai.w.gold.aiCapacitySkip && t.capacity === 0) return 50;
  research(ai, t, s);
  const phase = job.data[0] % 3;
  if (phase === 0) { gather(ai, t, s); sliders(ai, t); }
  else if (phase === 1) gangs(ai, t, s);
  else markets(ai, t, s);
  job.data[0] = (phase + 1) % 3;
  return 50;
}

function gangOf(ai: Ai, t: Town, type: number): Entity[] {
  return ai.w.entities.filter(e => e.kind === KIND_UNIT && e.town === t.id && (e.oid & 0xffff) === type && (e.oid >>> 16) === t.race &&
    e.alive && e.group === Grp.Economy);
}

/** resize a gang: fill from free units, release the surplus (`0046e960`) */
function resize(ai: Ai, t: Town, type: number, n: number): Entity[] {
  const g = gangOf(ai, t, type);
  if (g.length < n) {
    for (const e of ai.w.entities) {
      if (g.length >= n) break;
      if (e.kind === KIND_UNIT && e.town === t.id && (e.oid & 0xffff) === type && (e.oid >>> 16) === t.race && e.alive && ai.free(e)) {
        e.group = Grp.Economy;
        g.push(e);
      }
    }
  }
  // released members get group 0 and, if the town has a school, a go-into job to its first school
  // (1.8, I: to be retrained there)
  while (g.length > n) {
    const e = g.pop()!;
    e.group = Grp.None;
    const school = ai.list(t, B.School)[0];
    if (school && !ai.w.isShip(e)) ai.w.logistics.goInto(e, school, 1);
  }
  return g;
}

/** gang sizes (phase 1, `0046ebc0`) */
function gangs(ai: Ai, t: Town, s: AiTown): void {
  const P = t.population;
  const g = P >= 16 ? 2 : 1;
  const [fw, fs] = GANG_FACTOR[t.race] ?? [3, 3];
  const wood = Math.max(1, Math.trunc((fw * g) / 2)), stone = Math.max(1, Math.trunc((fs * g) / 2));
  const hunters = Math.min(3, Math.trunc(P / 10));
  s.A[U.Woodcutter] = wood; s.A[U.Stonemason] = stone; s.A[U.Hunter] = hunters;
  resize(ai, t, U.Woodcutter, wood);
  resize(ai, t, U.Stonemason, stone);
  const h = resize(ai, t, U.Hunter, hunters);
  // bush porters only while the hunter gang is empty (from free group-0 porters, not the porter gang)
  resize(ai, t, U.Porter, h.length ? 0 : Math.min(2, Math.trunc(P / 5)));
  if (ai.w.addon) {
    // add-on gangs (addon.md 8.2): one fishing boat, one wandering warship above 20 people
    s.A[ShipType.Fishing] = 1;
    s.A[ShipType.Light] = P > 20 ? 1 : 0;
    resize(ai, t, ShipType.Fishing, s.A[ShipType.Fishing]);
    for (const e of resize(ai, t, ShipType.Light, s.A[ShipType.Light])) {
      if (e.job === 0 && e.inside < 0) ai.w.logistics.assign(e, 0x28, 1 + (ai.rand() % 5), [0, 0, 0, 0]);
    }
  }
}

/**
 * Gathering orders and free goods (phase 0, `0046e6b0`, `0046e260`): for wood, stone and food
 * with room in the stock, the nearest object within 20 cells of the town centre, else around the
 * nearest region points (at most 59 cells away, 10 cells around each); every idle gang member
 * gets a harvest job with auto-continue on it.
 */
function gather(ai: Ai, t: Town, _s: AiTown): void {
  const w = ai.w, eco = w.economy;
  const cap = t.capacity;
  const wanted = (good: number) => t.stock[good] < cap - 5;
  const want = [NC.Tree, NC.Stone, NC.Animal, NC.Bush].filter(cl => wanted(cl === NC.Tree ? WOOD : cl === NC.Stone ? STONE : FOOD));
  // nature objects up to 69 cells from the centre, per class, in id order
  const near: Record<number, Entity[]> = {};
  if (want.length) {
    for (const cl of want) near[cl] = [];
    for (const e of w.entities) {
      if (e.kind !== KIND_NATURE || e.amount - e.reserved <= 0) continue;
      const cl = w.rules.get(e.oid)?.cls ?? -1;
      const l = near[cl];
      if (!l) continue;
      if (ai.distTo(e, t.x, t.y) <= 69) l.push(e);
    }
  }
  const nearest = (l: Entity[], x: number, y: number, r: number): Entity | null => {
    let best: Entity | null = null, bd = r + 1;
    for (const e of l) { const d = ai.distTo(e, x, y); if (d < bd) { bd = d; best = e; } }
    return best;
  };
  const find = (cl: number): Entity | null => {
    const l = near[cl];
    if (!l) return null;
    const hit = nearest(l, t.x, t.y, 20);
    if (hit) return hit;
    const list = ai.points(cl === NC.Stone ? 1 : cl === NC.Bush ? 2 : 0)
      .map(([x, y], i) => ({ x, y, i, d: ai.dist(x, y, t.x, t.y) }))
      .filter(p => p.d <= 59)
      .sort((a, b) => a.d - b.d || a.i - b.i);
    for (const pt of list) { const h = nearest(l, pt.x, pt.y, 10); if (h) return h; }
    return null;
  };
  const send = (type: number, cl: number): boolean => {
    const g = gangOf(ai, t, type);
    if (!g.length || !wanted(cl === NC.Tree ? WOOD : cl === NC.Stone ? STONE : FOOD)) return false;
    const obj = find(cl);
    if (!obj) return false;
    for (const u of g) if (u.job === 0 && u.inside < 0 && w.logistics.canHarvest(u, obj)) w.logistics.startHarvest(u, obj, true);
    return true;
  };
  // AI fishing (addon.md 8.3): each boat of the gang gets new grounds on a random water cell
  if (w.addon && eco.space(t, FOOD) > 5) {
    for (const boat of gangOf(ai, t, ShipType.Fishing)) {
      if (boat.inside >= 0) continue;
      let x = 0, y = 0, water = false;
      for (let k = 0; k < 41 && !water; k++) {
        x = ai.rand() % w.size; y = ai.rand() % w.size;
        water = w.islandAt(x, y) === 0;
      }
      if (water) w.naval.startFishing(boat, x, y, 5);
    }
  }
  const woodOk = send(U.Woodcutter, NC.Tree);
  const stoneOk = send(U.Stonemason, NC.Stone);
  const huntOk = send(U.Hunter, NC.Animal);
  const bushOk = send(U.Porter, NC.Bush);
  // free goods for the computer (1.8)
  let woodGift = false;
  if (eco.space(t, WOOD) > 5 && !woodOk && t.stock[WOOD] === 0) { t.stock[WOOD] = Math.min(2, cap); woodGift = true; }
  if (eco.space(t, STONE) > 5 && !stoneOk && t.stock[STONE] === 0) t.stock[STONE] = Math.min(2, cap);
  if (eco.space(t, FOOD) > 5 && !huntOk && !bushOk) eco.addGood(t, FOOD, 2);
  if (eco.space(t, IRON) > 5 && t.stock[WOOD] >= 2 && gangOf(ai, t, U.Woodcutter).length && !woodGift && ai.rand() % 10 !== 0) {
    t.stock[IRON] += 1; t.stock[WOOD] -= 2;
  }
}

/** motivation 0; research from the money left after overheads and a reserve (1.9, `0046e180`) */
function sliders(ai: Ai, t: Town): void {
  const p = ai.w.economy.players[t.race]!;
  t.motivationPct = 0;
  const I = t.income;
  if (I <= 0 || t.research < 0 || ai.w.economy.count(t, B.Lab) === 0) { t.researchPct = 0; return; }
  const M = p.money;
  const reserve = M < 150 ? Math.trunc(I / 3) : M < 250 ? Math.trunc(I / 5) : M < 600 ? Math.trunc(I / 10) : 0;
  t.researchPct = Math.max(0, Math.min(100, Math.trunc(((I - t.overheads - reserve) * 100) / I)));
}

/** research choice (1.11): cursor over the race's invention table, overrides after a completion */
function research(ai: Ai, t: Town, s: AiTown): void {
  const w = ai.w, eco = w.economy, p = eco.players[t.race]!, ps = ai.players[t.race];
  if (!ps) return;
  const labActive = eco.count(t, B.Lab) > 0;
  if (!labActive) { s.labSeen = 0; return; }
  if (t.research >= 0) { s.labSeen = 1; return; }
  const pick = (): number => {
    const pre = ai.prerequisites[t.race] ?? [];
    while (ps.cursor < p.costs.length) {
      const i = ps.cursor++;
      if (eco.researched(p, i) || p.progress[i] > 0 || eco.towns.some(o => o.alive && o.race === t.race && o.research === i)) continue;
      if ((pre[i] ?? []).every(q => eco.researched(p, q))) return i;
    }
    return -1;
  };
  let topic: number;
  if (!s.labSeen) { s.labSeen = 1; ps.cursor = 0; topic = pick(); }
  else {
    // a project was completed: the stonemason's, then the woodcutter's invention first
    const inv = (ty: number) => w.rules.get(((t.race << 16) | ty) >>> 0)?.invention ?? -1;
    const cand = pick();
    const sm = inv(U.Stonemason), wc = inv(U.Woodcutter);
    topic = sm >= 0 && !eco.researched(p, sm) ? sm : wc >= 0 && !eco.researched(p, wc) ? wc : cand;
  }
  if (topic >= 0) eco.selectResearch(t, topic);
}

/** market settings and merchants (phase 2, 4.6, `0046dd50`) */
function markets(ai: Ai, t: Town, s: AiTown): void {
  marketPass(ai, t, s, 48, U.Merchant);
  // add-on: a second pass for harbours and transport ships (addon.md 8.6)
  if (ai.w.addon) marketPass(ai, t, s, HARBOUR, ShipType.Transport);
}

function marketPass(ai: Ai, t: Town, s: AiTown, terminal: number, unit: number): void {
  const trade = ai.w.trade;
  if (!trade.hasActiveMarket(t, terminal)) { s.A[unit] = 0; return; }
  trade.computerSettings(t, terminal);
  // merchants: partners on the town's island in add-on games; ships: any island (5.7)
  const island = ai.w.addon && terminal === 48 ? ai.w.islandAt(t.x, t.y) : -1;
  const partners = trade.partners(t, true, terminal, island);
  s.A[unit] = partners.length;
  for (const u of ai.w.entities) {
    if (u.kind !== KIND_UNIT || u.town !== t.id || (u.oid & 0xffff) !== unit || (u.oid >>> 16) !== t.race || !u.alive) continue;
    if (u.inside >= 0 && ai.w.get(u.inside)?.kind === KIND_UNIT) continue;   // on board a ship
    if (u.group !== Grp.None && u.group !== Grp.Economy) continue;
    if (u.group === Grp.None && u.job !== 0 && !trade.routeOf(u)) continue;
    if (!partners.length) { if (u.group === Grp.Economy) ai.release(u, true); continue; }
    u.group = Grp.Economy;
    const route = trade.routeOf(u);
    if (route && !route.paused && route.from === t.id && partners.some(o => o.id === route.to)) continue;
    trade.startRoute(u, t.id, partners[0].id, false);
  }
}

// ---------------------------------------------------------------- military (0x34, 2.2)

export function runMilitary(ai: Ai, job: Job): number {
  const live = aliveTown(ai, job, 'military');
  if (!live) return 0;
  const { t, s } = live;
  record(ai, t, s);
  const c = census(ai, t);
  let soldiers = 0;
  for (let ty = U.Archer; ty <= U.LastSoldier; ty++) soldiers += c.units[ty];
  // only while the town has a barracks (any state), soldiers or hunters; the phase only advances
  // in such runs (0.1)
  if (!c.all[B.Barracks] && !soldiers && !c.units[U.Hunter]) return 50;
  const phase = job.data[0] & 1;
  job.data[0] = phase ^ 1;
  if (phase === 0) defenceTargets(ai, t, s, c);
  else respond(ai, t, s);
  return 50;
}

/**
 * Intruder records (2.2, `004621c0` -> `0046cab0`): the original records every unit that steps
 * into the town's area. Ours polls every military run: units of other races standing in the
 * town's territory are added (once, in id order).
 */
function record(ai: Ai, t: Town, s: AiTown): void {
  // dead or removed units leave the records (they would be dropped by the next response anyway)
  s.intruders = (s.intruders ?? []).filter(id => ai.w.get(id)?.alive);
  const have = new Set(s.intruders);
  for (const e of ai.w.entities) {
    if (e.kind !== KIND_UNIT || !e.alive || e.inside >= 0 || (e.oid >>> 16) === t.race || have.has(e.id)) continue;
    if (ai.inTerritory(e, t)) s.intruders.push(e.id);
  }
}

/** first-run delay of every attack job made by the AI routines (`00465650`, called with 5) */
export const AI_ATTACK_DELAY = 5;

const DEFENDER_TYPES = [U.Hunter, 29, 30, 31, 32, 33, 34, 35, 36];
const ofType = (ai: Ai, t: Town, e: Entity, ty: number) =>
  e.kind === KIND_UNIT && e.town === t.id && (e.oid & 0xffff) === ty && (e.oid >>> 16) === t.race && e.alive;

/** targets and the defence group (phase 0, `0046cb20`; the outpost refill `0046cfd0` never fires) */
function defenceTargets(ai: Ai, t: Town, s: AiTown, c: Census): void {
  const w = ai.w;
  const gar = (ty: number) => w.rules.get(((t.race << 16) | ty) >>> 0)?.garrison ?? 0;
  s.B.fill(0);
  s.B[U.Archer] = c.all[B.LargeOutpost] * gar(B.LargeOutpost) + c.all[B.SmallOutpost] * gar(B.SmallOutpost);
  let b = Math.trunc(t.population / 10);
  if (c.porters > 15) b += Math.trunc((c.porters - 15) / 4);
  for (let ty = U.LastSoldier; ty >= U.Archer; ty--) {
    if (!ai.trainable(t, ty)) continue;
    const share = Math.trunc(b / 2);
    s.B[ty] += share;
    b -= share;
  }
  s.B[U.Hunter] = Math.min(6, b);
  // keep (100 - reserve) % of each target in the defence group: members are the type's group-52
  // units outside buildings (any job); missing ones come from group-0 units outside (any job);
  // extras get group 0. Group-52 units inside (a garrison) are not counted.
  for (const ty of DEFENDER_TYPES) {
    const keep = Math.trunc((s.B[ty] * (100 - s.reserve)) / 100);
    const g = w.entities.filter(e => ofType(ai, t, e, ty) && e.group === Grp.Defence && e.inside < 0);
    if (g.length < keep) {
      for (const e of w.entities) {
        if (g.length >= keep) break;
        if (ofType(ai, t, e, ty) && e.group === Grp.None && e.inside < 0) { e.group = Grp.Defence; g.push(e); }
      }
    }
    while (g.length > keep) g.pop()!.group = Grp.None;
  }
  // The outpost refill compares occupants with the record's resident places (+0xB4), which are 0
  // for outposts: no archer is ever sent and no rand() drawn (2.2). Garrisons come only from the
  // completion requests (1.7).
}

/** the target of a unit's running attack job */
function attackTarget(ai: Ai, u: Entity): Entity | undefined {
  const j = u.job ? ai.w.sched.get(u.job) : undefined;
  return j && !j.cancelled && j.kind === 0x08 ? ai.w.get(j.data[0]) : undefined;
}

/** response to intruders (phase 1, `0046d3a0`) */
function respond(ai: Ai, t: Town, s: AiTown): void {
  const w = ai.w;
  // defenders: hunters, then soldiers 29..36; per type its group-52 units outside (any job), then
  // its free group-0 units (section 0)
  const defenders: Entity[] = [];
  for (const ty of DEFENDER_TYPES) {
    for (const e of w.entities) if (ofType(ai, t, e, ty) && e.group === Grp.Defence && e.inside < 0) defenders.push(e);
    for (const e of w.entities) if (ofType(ai, t, e, ty) && ai.free(e)) defenders.push(e);
  }
  // intruders: dropped when dead or when they fail the test (no attack job: standing in the town's
  // area, not a diplomat or merchant; with an attack job: attacking an object of this town's race);
  // the hostile ones are sorted into three buckets by their target class
  const buckets: Entity[][] = [[], [], []];
  const keep: number[] = [];
  for (const id of s.intruders ?? []) {
    const e = w.get(id);
    if (!e || !e.alive || e.kind !== KIND_UNIT) continue;
    const race = e.oid >>> 16, ty = e.oid & 0xffff;
    const tg = attackTarget(ai, e);
    const ok = tg ? tg.kind !== KIND_NATURE && (tg.oid >>> 16) === t.race
      : e.inside < 0 && ai.inTerritory(e, t) && ty !== U.Diplomat && ty !== U.Merchant;
    if (!ok || race > 2 || !ai.hostile(t.race, race)) continue;
    keep.push(id);
    if (w.combat.valid(e)) buckets[Math.min(2, w.combat.tier(e))].push(e);
  }
  s.intruders = keep;
  const k = buckets.findIndex(l => l.length > 0);
  if (k < 0) {
    s.underAttack = 0;
    // with chance 1/10 defenders outside the town's area without a job walk back to the centre
    // +-20 cells, first run after 5 + rand() mod 10 (three draws each; ours walks at once)
    if (ai.rand() % 10 === 0) {
      for (const d of defenders) {
        if (!d.alive || d.inside >= 0 || d.job || ai.inTerritory(d, t)) continue;
        const x = t.x + (ai.rand() % 41) - 20, y = t.y + (ai.rand() % 41) - 20;
        ai.rand();
        ai.walkToward(d, x, y);
      }
    }
    return;
  }
  s.underAttack = 1;
  assignAttackers(ai, defenders, buckets[k], () => 3, k);
}

/**
 * Target assignment of the defence response (2.2): every defender in list order is handled once.
 * A defender attacking a target of a class at most the bucket's (`keepClass`) keeps it and is not
 * counted; every other one has its job cancelled, gets an attack job on the current target if the
 * attack check allows it, and is counted; after cap(target) counted defenders the next target
 * becomes current, wrapping to the first after the last, so every defender ends up attacking.
 */
export function assignAttackers(ai: Ai, units: Entity[], targets: Entity[], cap: (e: Entity) => number, keepClass: number): void {
  const w = ai.w;
  if (!targets.length) return;
  let i = 0, n = 0;
  for (const u of units) {
    const x = targets[i];
    const cur = attackTarget(ai, u);
    if (cur && w.combat.valid(cur) && w.combat.tier(cur) <= keepClass) continue;
    w.logistics.cancelJob(u);
    // AI attack jobs first run 5 ticks later (`00465650` with delay 5)
    if (w.combat.mayAct(u, x)) w.combat.startAttack(u, x, true, false, AI_ATTACK_DELAY, false);
    if (++n >= cap(x)) { n = 0; i = (i + 1) % targets.length; }
  }
}

/**
 * Target assignment of the army (2.5 step 6, both tactics), members in army order, current target
 * the first of the bucket, counter 0:
 * - a member with an attack job is re-assigned (counted) when `reassign(class of its target)`
 *   says so (assault: class above the bucket's, or equal and rand() mod 10 = 0, drawn only when
 *   equal; skirmish: bucket 0 and class above 0, no draw); otherwise it keeps its target, not counted;
 * - any other member: `far(u)` true leaves it (not counted); else its job is cancelled and it is
 *   assigned (counted);
 * - "assigned": an attack job on the current target if the attack check allows it; counted
 *   whether or not it was allowed (a refused member keeps its old attack job);
 * - after `perTarget` counted members (6 - bucket, or 3) the next target becomes current, wrapping.
 */
export function assignArmy(ai: Ai, members: Entity[], targets: Entity[], perTarget: number, reassign: (cls: number) => boolean,
  far?: (u: Entity) => boolean): void {
  const w = ai.w;
  if (!targets.length) return;
  let i = 0, n = 0;
  for (const u of members) {
    const x = targets[i];
    const cur = attackTarget(ai, u);
    if (cur && w.combat.valid(cur)) {
      if (!reassign(w.combat.tier(cur))) continue;
    } else {
      if (far?.(u)) continue;
      w.logistics.cancelJob(u);
    }
    // AI attack jobs first run 5 ticks later (`00465650` with delay 5)
    if (w.combat.mayAct(u, x)) w.combat.startAttack(u, x, true, false, AI_ATTACK_DELAY, false);
    if (++n >= perTarget) { n = 0; i = (i + 1) % targets.length; }
  }
}
