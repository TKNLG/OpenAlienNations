// Combat, death, crime and healing. Spec: docs/game/combat.md (section numbers below).
//
// Every attack is: chase (attack state) -> strike (turn, cooldown, fire) -> impact job that
// rolls hit and damage when the blow or projectile lands. Projectiles are display only: the
// impact always reaches its target if it is still valid. All randomness uses the world's one
// generator, in the order the spec lists (16.1).
//
// The attack state is embedded in the job that owns it (top-level attack, patrol, criminal,
// arrest, heal), at a fixed offset in that job's data, instead of separate child jobs.

import type { Job } from './scheduler.ts';
import type { World, Entity } from './world.ts';
import { Kind, Action, SUB } from './world.ts';
import { T, ADVISOR_REPEAT_MS, type Town } from './economy.ts';
import type { Weapon } from '../formats/wdb.ts';
import { WeaponKind } from '../formats/wdb.ts';
import { dirToward, turnStep } from './path.ts';
import { WalkResult } from './motion.ts';

export const CJ = {
  Attack: 0x08, Impact: 0x15, Criminal: 0x17, Arrest: 0x18, Escort: 0x19, GarrisonFire: 0x1b, Outpost: 0x1c,
  Collapse: 0x25, Flee: 0x26, Guard: 0x27, Heal: 0x29,
} as const;
const COMBAT_KINDS = new Set<number>(Object.values(CJ));
export const isCombatJob = (kind: number) => COMBAT_KINDS.has(kind);

const U = { Hunter: 17, Diplomat: 13, Police: 21, Priest: 22, Saboteur: 26, Merchant: 28 } as const;
const isSoldier = (type: number) => type >= 29 && type <= 36;
const NATURE_GROUP = 6;
const RUBBLE = 38;
const HELP_RADIUS = 12;
const LEASH = 29;
const MAX_SEARCHES = 5;
/** mentor lines */
const M = { TownAttacked: 20, TownDestroyed: 21, HallAttacked: 22, Defeated: 23, BuildingLost: 80 } as const;

/**
 * attack state slots, relative to the owner job's base offset (always the last part of the job's
 * data). Walk: the attack's own walk (the original's follow-path child, state 2) is under way.
 * Plan: a stored plan for the next walk (3.3.1): searched from (PX, PY), ending on the firing
 * position (GX, GY); its cells are planned again from (PX, PY) when the walk is made.
 */
const A = { Target: 0, AX: 1, AY: 2, Searches: 3, Auto: 4, Player: 5, Walk: 6, Plan: 7, PX: 8, PY: 9, GX: 10, GY: 11, Size: 12 } as const;
/** attack state size before snapshot version 9 (no walk flag, no stored plan) */
const A_SIZE_V8 = 6;
/** node budget of the firing-position search (3.5) */
const SEARCH_NODES = 2000;

/** a display event (projectile, death); not part of the simulation state */
export interface CombatEffect {
  kind: 'shot' | 'die' | 'collapse' | 'sound';
  tick: number;
  /** cells */
  x: number; y: number; tx?: number; ty?: number;
  /** shot: ticks until launch (animation to the sound frame) and flight time, in ticks */
  wait?: number; flight?: number;
  /** shot: projectile type (group 7); die: weapon index of the dead unit */
  type?: number;
  race?: number;
  /** shot: the shooting unit's id */
  shooter?: number;
  /** shot: the outpost building id when a garrison fired, else -1 */
  garrison?: number;
}

export class Combat {
  private w: World;
  constructor(w: World) { this.w = w; }

  // ---------------------------------------------------------------- basics

  private rule(e: Entity) { return this.w.rules.get(e.oid); }
  private type(e: Entity): number { return e.oid & 0xffff; }
  private race(e: Entity): number { return e.oid >>> 16; }
  private cell(e: Entity): [number, number] { return [Math.floor(e.x / SUB), Math.floor(e.y / SUB)]; }
  private dist(ax: number, ay: number, bx: number, by: number): number { return this.w.logistics.dist(ax, ay, bx, by); }
  private wrapD(d: number): number { const n = this.w.size; return d > n / 2 ? d - n : d < -n / 2 ? d + n : d; }

  weapon(e: Entity): Weapon | undefined {
    const r = this.rule(e);
    return r && r.weapon >= 0 ? this.w.weapons[r.weapon] : undefined;
  }

  /** target tier 0..2 (1.3): by type number only */
  tier(e: Entity): number {
    const t = this.type(e);
    if (t === 17 || t === 21 || t === 26 || isSoldier(t) || t === 52 || t === 53) return 0;
    if (t === 39 || t === 43 || t === 56) return 1;
    if (e.kind === Kind.Unit && t !== T.Criminal) return 1;
    return 2;
  }

  relation(a: number, b: number): number {
    if (a === b || a < 0 || b < 0) return -1;
    return this.w.economy.players[a]?.relations[b] ?? 0;
  }

  setRelation(a: number, b: number, state: number): void {
    const pa = this.w.economy.players[a], pb = this.w.economy.players[b];
    if (pa) pa.relations[b] = state;
    if (pb) pb.relations[a] = state;
    this.w.onRelation?.(a, b, state);
  }

  /** may unit u act on target t (2.1) */
  mayAct(u: Entity, t: Entity, ally = false): boolean {
    if (!t.alive || (t.kind !== Kind.Building && t.kind !== Kind.Unit && !(t.kind === Kind.Nature))) return false;
    if (!this.weapon(u)) return false;
    const ut = this.type(u);
    if (t.kind === Kind.Nature) {
      const cls = this.rule(t)?.cls;
      // the fishing boat acts on fish only, like the hunter on animals (addon.md 4.2)
      return (ut === U.Hunter && cls === 7) || (ut === 64 && cls === 15 && this.w.isShip(u));
    }
    const ur = this.race(u), tr = this.race(t);
    // priests never heal ships (addon.md 4.1, `0046b9a0`)
    if (ut === U.Priest && this.w.isShip(t)) return false;
    if (ur !== tr) {
      if (ut === U.Priest) return ally && t.kind === Kind.Unit && t.hp < (this.rule(t)?.hp ?? 0) && this.relation(ur, tr) === 3;
      if (ut === U.Saboteur) return t.kind === Kind.Building;
      if (ut === T.Criminal) return false;
      return true;
    }
    if (ut === T.Criminal) return t.kind === Kind.Unit && this.type(t) === T.Porter;
    if (ut === U.Police) return t.kind === Kind.Unit && this.type(t) === T.Criminal;
    if (ut === U.Priest) return t.kind === Kind.Unit && t.hp < (this.rule(t)?.hp ?? 0);
    return false;
  }

  /** target still attackable (3.2) */
  valid(t: Entity | undefined): t is Entity {
    if (!t || !t.alive || this.w.get(t.id) !== t) return false;
    if (t.kind === Kind.Unit) return t.inside < 0;
    if (t.kind === Kind.Nature) { const c = this.rule(t)?.cls; return c === 7 || c === 15; }
    return true;
  }

  // ---------------------------------------------------------------- range and line of fire (3.4)

  private footprint(t: Entity): [number, number, number, number] {
    const [x, y] = this.cell(t);
    if (t.kind !== Kind.Building) return [x, y, x, y];
    const r = this.rule(t);
    const sx = Math.max(1, r?.sizeX || 2), sy = Math.max(1, r?.sizeY || 2);
    return [x - sx + 1, y - sy + 1, x, y];
  }

  /** the garrison's range bonus E = trunc(1.5 R), in integers R x 3 / 2 (9.5, 16.5); 0 for range-0 weapons */
  static garrisonBonus(range: number): number { return range > 0 ? Math.trunc((range * 3) / 2) : 0; }

  /**
   * In range from a cell (3.4). `fromBuilding`: the garrison variant (9.5, `004709b0` called with a
   * building id): bonus E = 1.5 R, quick reject and budget 3E, buildings never block, the origin
   * cell is charged like every other cell. Range-0 weapons (melee, heal, bomb) always use the
   * adjacency test, also from a tower.
   */
  inRange(ox: number, oy: number, t: Entity, wpn: Weapon, fromBuilding?: Entity): boolean {
    const [x0, y0, x1, y1] = this.footprint(t);
    const inFoot = (x: number, y: number) => {
      const dx = this.wrapD(x - x0), dy = this.wrapD(y - y0);
      return dx >= 0 && dx <= x1 - x0 && dy >= 0 && dy <= y1 - y0;
    };
    if (wpn.range <= 0) {
      const dx0 = this.wrapD(ox - x0), dy0 = this.wrapD(oy - y0);
      return dx0 >= -1 && dx0 <= x1 - x0 + 1 && dy0 >= -1 && dy0 <= y1 - y0 + 1;
    }
    const reach = fromBuilding ? 3 * Combat.garrisonBonus(wpn.range) : 2 * wpn.range;
    const budget = reach + Math.floor(Math.max(x1 - x0, y1 - y0) / 2);
    const cx = x0 + Math.floor((x1 - x0) / 2), cy = y0 + Math.floor((y1 - y0) / 2);
    const tx = ox + this.wrapD(cx - ox), ty = oy + this.wrapD(cy - oy);
    if (this.dist(ox, oy, tx, ty) > reach) return false;
    // Bresenham walk from the shooter to the footprint centre; from a tower the origin cell costs 2
    const ddx = Math.abs(tx - ox), ddy = Math.abs(ty - oy), sxs = tx > ox ? 1 : -1, sys = ty > oy ? 1 : -1;
    let err = ddx - ddy, x = ox, y = oy, cost = fromBuilding ? 2 : 0;
    let prevH = this.w.heightAt(x, y);
    for (let guard = 0; guard < 200; guard++) {
      if (x === tx && y === ty) break;
      const e2 = 2 * err;
      let stepX = false, stepY = false;
      if (e2 > -ddy) { err -= ddy; x += sxs; stepX = true; }
      if (e2 < ddx) { err += ddx; y += sys; stepY = true; }
      if (inFoot(x, y)) break;
      const i = ((y & (this.w.size - 1)) << this.w.bits) | (x & (this.w.size - 1));
      if (!fromBuilding && this.w.buildingAt(i)) return false;
      cost += stepX && stepY ? 3 : 2;
      const h = this.w.heightAt(x, y);
      if (h - prevH >= 32) cost++; else if (prevH - h >= 32) cost--;
      prevH = h;
      if (cost >= budget) return false;
    }
    return cost < budget;
  }

  // ---------------------------------------------------------------- the attack state (3)

  /** fill an attack state into job data at `base` */
  initAttack(d: number[], base: number, target: Entity, auto: boolean, player: boolean): void {
    const [x, y] = this.cell(target);
    d[base + A.Target] = target.id; d[base + A.AX] = x; d[base + A.AY] = y;
    d[base + A.Searches] = 0; d[base + A.Auto] = auto ? 1 : 0; d[base + A.Player] = player ? 1 : 0;
    d[base + A.Walk] = 0; d[base + A.Plan] = 0;
    d[base + A.PX] = 0; d[base + A.PY] = 0; d[base + A.GX] = 0; d[base + A.GY] = 0;
  }

  /**
   * one run of an attack (3.3): returns the next delay, or 0 when the attack is over.
   * `top`: the attack is the unit's top-level job (charging step bonus).
   *
   * A moving target (3.3.1): a running walk is never re-aimed; it ends in range (checked after
   * every step), at its own goal, or by a retarget. While it runs, a plan for the next walk is kept
   * ready (searched again whenever its end no longer reaches the target), and every such search
   * uses one of the 5 per target; the 6th retargets, which drops the walk where the unit stands.
   */
  attackStep(u: Entity, d: number[], base: number, top: boolean): number {
    if (!u.alive) return 0;
    let t = this.w.get(d[base + A.Target]);
    if (!this.valid(t)) {
      t = this.retarget(u, d, base);
      if (!t) return this.endAttack(u, d, base);
    }
    const [tx, ty] = this.cell(t!);
    if (this.dist(tx, ty, d[base + A.AX], d[base + A.AY]) > LEASH) return this.endAttack(u, d, base);
    const wpn = this.weapon(u);
    if (!wpn) return this.endAttack(u, d, base);
    // the range is tested only once a step has been fully played (3.3 "Timing of that test"): the
    // original's attack job runs D ticks after each step started, never inside a step
    const tick = this.w.tick;
    const stepEnd = u.stepStart + u.stepTicks;
    if (stepEnd > tick && u.stepTicks > 0) { if (u.path) u.charging = top; return stepEnd - tick; }
    if (this.w.isShip(u)) return this.shipStep(u, d, base, t!, wpn, top);
    // the attack's walk (its follow-path child) runs again only after the walk's own delay (a turn,
    // a wait for a blocker, a re-plan): the attack job runs at the delays the child returns
    if (d[base + A.Walk] && u.path && u.moveAt > tick) { u.charging = top; return u.moveAt - tick; }
    // the walk has ended (the child returned 0, 3.3 step 5): after a failed walk the stored plan is
    // dropped. Our walk ended at the motion run after the last job run, so this run is the
    // original's next one (1 tick later) and goes on at once.
    if (d[base + A.Walk] && !u.path) {
      d[base + A.Walk] = 0;
      u.charging = false;
      if (u.walkResult === WalkResult.Failed) d[base + A.Plan] = 0;
    }
    const walking = d[base + A.Walk] === 1;
    const [ux, uy] = this.cell(u);
    if (this.inRange(ux, uy, t!, wpn)) {
      // the walk child is dropped and the strike begins; a stored plan is kept (3.3 step 4)
      this.stopWalk(u);
      d[base + A.Walk] = 0;
      u.charging = false;
      return this.strike(u, t!, wpn, ux, uy);
    }
    const planOk = d[base + A.Plan] === 1 && this.inRange(d[base + A.GX], d[base + A.GY], t!, wpn);
    if (!planOk) {
      // search for a firing position from here (3.5), also while walking: the walk goes on
      if (d[base + A.Searches] >= MAX_SEARCHES) {
        // the 6th search: retarget (3.6), which drops the walk where the unit stands
        const nt = this.retarget(u, d, base);
        return nt ? 1 : this.endAttack(u, d, base);
      }
      d[base + A.Searches]++;
      this.plan(u, d, base, t!, wpn);
      if (walking) { u.charging = top; return 1; }
      return 2;
    }
    if (walking) { u.charging = top; return 1; }
    // a walk from the stored plan; its first turn or step comes now (units-and-jobs.md 4.1)
    this.walkPlan(u, d, base);
    if (!u.path) return 1;          // nothing to walk: the empty walk succeeded at once
    d[base + A.Walk] = 1;
    // the walk action comes with the first step (World.stepTo), so a strike plays on until then
    u.charging = top;
    return 1;
  }

  /**
   * The firing-position search (3.5) from the unit's cell, done at once (lockstep rule): the plan
   * ends on the first cell of the way from which the target is in range now. Melee walks toward a
   * free cell next to the target (meleeSpot) and keeps that cell as the end. No way to any such
   * cell: no plan (the next run searches again, using up another search).
   */
  private plan(u: Entity, d: number[], base: number, t: Entity, wpn: Weapon): void {
    d[base + A.Plan] = 0;
    const [ux, uy] = this.cell(u), [tx, ty] = this.cell(t);
    const spot = wpn.range === 0 ? this.meleeSpot(u, t) : null;
    const [gx, gy] = spot ?? [tx, ty];
    const path = this.w.planPath(u, ux, uy, gx, gy, SEARCH_NODES);
    if (!path || !path.length) return;
    const [lx, ly] = path[path.length - 1];
    let end = spot && lx === spot[0] && ly === spot[1] ? path.length - 1 : -1;
    for (let i = 0; i < path.length && end < 0; i++) if (this.inRange(path[i][0], path[i][1], t, wpn)) end = i;
    if (end < 0) return;
    d[base + A.Plan] = 1;
    d[base + A.PX] = ux; d[base + A.PY] = uy;
    d[base + A.GX] = path[end][0]; d[base + A.GY] = path[end][1];
  }

  /**
   * Make the attack's walk from the stored plan (`0047f320`, 3.3.1 join rule): the stored way is the
   * search's start cell followed by its cells; the walk takes the part after the first stored cell
   * that has the unit's x or its y. The follow-path rules then apply (a first cell that is not a
   * neighbour fails the walk at once). The plan is used up.
   */
  private walkPlan(u: Entity, d: number[], base: number): void {
    d[base + A.Plan] = 0;
    const m = this.w.size - 1;
    const px = d[base + A.PX], py = d[base + A.PY], gx = d[base + A.GX], gy = d[base + A.GY];
    const way: [number, number][] = [[px, py], ...(this.w.planPath(u, px, py, gx, gy, SEARCH_NODES) ?? [])];
    const [ux, uy] = this.cell(u);
    const k = way.findIndex(([x, y]) => (x & m) === ux || (y & m) === uy);
    const rest = k < 0 ? [] : way.slice(k + 1);
    this.w.setPath(u, rest, gx, gy, SEARCH_NODES);
    // made and run in the attack's run: no planning delay (units-and-jobs.md 4.1)
    if (u.path) u.moveAt = Math.max(u.stepStart + u.stepTicks, this.w.tick);
  }

  /** a ship's chase: one walk per search toward a firing position on open sea (addon.md 7) */
  private shipStep(u: Entity, d: number[], base: number, t: Entity, wpn: Weapon, top: boolean): number {
    const [ux, uy] = this.cell(u), [tx, ty] = this.cell(t);
    if (this.inRange(ux, uy, t, wpn)) {
      this.stopWalk(u);
      u.charging = false;
      return this.strike(u, t, wpn, ux, uy);
    }
    if (u.path) { u.charging = top; return 1; }
    if (d[base + A.Searches] >= MAX_SEARCHES) {
      const nt = this.retarget(u, d, base);
      return nt ? 1 : 0;
    }
    d[base + A.Searches]++;
    const walked = this.w.naval.approach(u, tx, ty, wpn.range);
    if ((!walked || !u.path) && !u.path) { const nt = this.retarget(u, d, base); return nt ? 1 : 0; }
    u.charging = top;
    return 2;
  }

  /**
   * Saves before version 9 hold the 6-slot attack state: add the walk flag (set when the unit is
   * walking, as the old state machine read it) and an empty plan. `harvest`, `hunt`: the attack
   * state's offset in the harvest (0x16) and hunting-ground (0x2B) job data.
   */
  migrateV8(jobs: Iterable<Job>, harvest: number, hunt: number): void {
    const bases = new Map<number, number>([
      [CJ.Attack, 0], [CJ.Guard, GD.Attack], [CJ.Criminal, CR.Attack], [CJ.Arrest, 2], [CJ.Heal, 2], [0x16, harvest], [0x2b, hunt],
    ]);
    for (const j of jobs) {
      const base = bases.get(j.kind);
      if (base === undefined || j.data.length !== base + A_SIZE_V8) continue;
      const u = this.w.get(j.owner);
      j.data.push(u && u.path && u.job === j.id ? 1 : 0, 0, 0, 0, 0, 0);
    }
  }

  /** the attack is over (leash, no target, no weapon): its walk ends with it; returns 0 */
  private endAttack(u: Entity, d: number[], base: number): number {
    this.stopWalk(u);
    d[base + A.Walk] = 0; d[base + A.Plan] = 0;
    u.charging = false;
    return 0;
  }

  /**
   * Nearest cell (to the attacker) in the target's footprint grown by one that a unit could stand
   * on now: no building, nature object, water or other unit (4.7). Several melee attackers thus
   * spread round their target instead of queueing for one cell. null: none free.
   */
  private meleeSpot(u: Entity, t: Entity): [number, number] | null {
    const [x0, y0, x1, y1] = this.footprint(t);
    const [ux, uy] = this.cell(u), m = this.w.size - 1;
    let best: [number, number] | null = null, bd = Infinity;
    for (let y = y0 - 1; y <= y1 + 1; y++) for (let x = x0 - 1; x <= x1 + 1; x++) {
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1) continue;
      if (!this.w.motion.free(x, y, u)) continue;
      const d = this.dist(ux, uy, x & m, y & m);
      if (d < bd) { bd = d; best = [x & m, y & m]; }
    }
    return best;
  }

  private stopWalk(u: Entity): void {
    if (!u.path) return;
    // a step under way ends, then the unit stands
    this.w.stopWalk(u);
    u.charging = false;
  }

  /** retarget after the target was lost (3.6) */
  private retarget(u: Entity, d: number[], base: number): Entity | undefined {
    // state, walk child, search and stored plan are cleared first; the walk stops where the unit stands
    d[base + A.Searches] = 0;
    if (d[base + A.Walk]) { this.stopWalk(u); d[base + A.Walk] = 0; }
    d[base + A.Plan] = 0;
    if (!d[base + A.Auto]) return undefined;
    const old = this.w.get(d[base + A.Target]);
    const [ox, oy] = old ? this.cell(old) : this.cell(u);
    const r = (this.rule(u)?.radius ?? 5) + 3;
    const race = old && old.kind !== Kind.Nature ? this.race(old) : -2;
    if (race < 0) return undefined;
    const t = this.choose(u, this.scan(ox, oy, r), race, 2);
    if (!t) return undefined;
    d[base + A.Target] = t.id; d[base + A.Player] = 0;
    return t;
  }

  // ---------------------------------------------------------------- strike (4)

  /**
   * Turn, wait for the cooldown, fire (4.1); returns the next delay. (ox, oy): the attacker's own
   * stored cell, used for the aim corner and the flight time. `garrison`: the outpost the shooter
   * sits in (9.7): the facing is measured from its anchor cell, the projectile starts there on
   * screen, and the help rule names the building as the attacker.
   */
  strike(u: Entity, t: Entity, wpn: Weapon, ox: number, oy: number, garrison?: Entity): number {
    if (u.carryAmount > 0) { u.carryAmount = 0; u.carryGood = -1; }
    const [tx, ty] = this.cell(t);
    const [fx, fy] = garrison ? this.cell(garrison) : [ox, oy];
    // one 45 degree step per run, the short way (180 degrees: unit-motion.md 1.3), even for 45 degrees
    const want = dirToward(this.wrapD(tx - fx), this.wrapD(ty - fy));
    if (want >= 0 && want !== u.dir) {
      u.dir = turnStep(u.dir, want);
      const st = this.rule(u)?.stepTime[0] ?? 5;
      return st < 4 ? 1 : Math.floor(st / 2);
    }
    const tick = this.w.tick;
    if (tick - u.cooldownUntil < wpn.cooldown) {
      return Math.max(1, Math.min(5, wpn.cooldown - (tick - u.cooldownUntil)));
    }
    // fire
    const r = this.rule(u)!;
    const a = Math.floor((r.soundFrame * 1000) / 7);
    const priest = this.type(u) === U.Priest;
    u.action = priest || wpn.kind === WeaponKind.Heal ? Action.Work : Action.Fight;
    u.actionTick = tick;
    if (t.kind !== Kind.Nature && !priest && wpn.kind !== WeaponKind.Heal && (t.kind === Kind.Building || t.inside < 0)) {
      this.attacked(t, u, garrison);
    }
    let f = 0;
    if (wpn.projectile >= 0) {
      // nearest footprint corner; distance in 1/64 cells (the original does not wrap: we do)
      const [x0, y0, x1, y1] = this.footprint(t);
      const ax = Math.abs(this.wrapD(x0 - ox)) < Math.abs(this.wrapD(x1 - ox)) ? x0 : x1;
      const ay = Math.abs(this.wrapD(y0 - oy)) < Math.abs(this.wrapD(y1 - oy)) ? y0 : y1;
      const dx = Math.abs(this.wrapD(ax - ox)) * 64, dy = Math.abs(this.wrapD(ay - oy)) * 64;
      const d64 = Math.max(dx, dy) + Math.floor(Math.min(dx, dy) / 2);
      f = Math.floor((d64 * 1000) / Math.max(1, wpn.speed));
      // on screen the shot starts at the shooter's cell, or at its outpost's cell (projectiles.md 2.6)
      this.w.effect({ kind: 'shot', tick, x: fx, y: fy, tx: ax, ty: ay, wait: a / 100, flight: f / 100, type: wpn.projectile, race: this.race(u), shooter: u.id, garrison: garrison ? garrison.id : -1 });
    }
    const delay = Math.floor((f + a) / 100) + 1;
    this.w.sched.create(CJ.Impact, t.id, Math.min(599, delay), [u.id, wpn.index, u.rank, this.race(u), this.type(u), this.rule(u)?.hp ?? 0]);
    const jitter = this.w.rand.next() % (Math.floor(wpn.cooldown / 2) + 1);
    u.cooldownUntil = tick + jitter + 1;
    return Math.max(1, Math.min(5, wpn.cooldown - (tick - u.cooldownUntil)));
  }

  // ---------------------------------------------------------------- impact (5)

  private runImpact(job: Job): number {
    const t = this.w.get(job.owner);
    const [attackerId, wIndex, rank, aRace, aType] = job.data;
    if (!t || !t.alive || t.hp <= 0) return 0;
    const wpn = this.w.weapons[wIndex];
    if (!wpn) return 0;
    const attacker = this.w.get(attackerId);
    const maxHp = this.rule(t)?.hp ?? t.hp;
    const h0 = t.hp;
    if (wpn.kind === WeaponKind.Heal) {
      t.hp = Math.min(maxHp, t.hp + wpn.min + this.w.rand.next() % Math.max(1, wpn.max - wpn.min));
    } else if (wpn.kind === WeaponKind.Bomb) {
      if (!attacker || !attacker.alive) return 0;
      if (this.w.rand.next() % 100 < wpn.hit) {
        t.hp -= wpn.min + this.w.rand.next() % (wpn.max - wpn.min + 1);
        if (t.hp < 1) { t.hp = 0; this.die(t); }
      }
      this.die(attacker);
    } else {
      if (this.w.rand.next() % 100 < wpn.hit) {
        let dmg = wpn.min + this.w.rand.next() % (wpn.max - wpn.min + 1);
        if (rank === 1) dmg = Math.trunc((dmg * 125) / 100);
        else if (rank === 2) dmg = Math.trunc((dmg * 150) / 100);
        else if (rank === 3) dmg = dmg * 2;
        t.hp -= dmg;
        if (t.hp > maxHp) t.hp = maxHp;
        else if (t.hp < 1) { t.hp = 0; this.die(t); }
      }
    }
    const dealt = h0 - Math.max(0, t.hp);
    // experience (5.3)
    if (attacker && attacker.alive && dealt > 0 && t.kind !== Kind.Nature && (isSoldier(aType) || aType === U.Police || aType === U.Hunter)) {
      const earned = t.kind === Kind.Building ? Math.floor(dealt / 2) : t.kind === Kind.Unit && isSoldier(this.type(t)) ? 2 * dealt : dealt;
      attacker.exp += earned;
      const H = this.rule(attacker)?.hp ?? 1;
      attacker.rank = attacker.exp > 18 * H ? 3 : attacker.exp > 6 * H ? 2 : attacker.exp > 2 * H ? 1 : 0;
    }
    // advisor (5 step 5, side-panel.md 1.1.3): every impact on a building that was alive, whatever
    // the damage; #20 and #22 each at most once per 2 D = 120 s
    if (t.kind === Kind.Building) this.w.notify(this.race(t), this.type(t) === T.TownHall ? M.HallAttacked : M.TownAttacked, true, ADVISOR_REPEAT_MS);
    // diplomacy (5.1 step 6, 11): hitting a race at ceasefire or peace means war
    if (t.kind !== Kind.Nature) {
      const st = this.relation(this.race(t), aRace);
      if (st === 2 || st === 3) this.setRelation(this.race(t), aRace, 1);
    }
    return 0;
  }

  // ---------------------------------------------------------------- reactions (7)

  /** circle scan dx^2 + dy^2 < r^2 for units and buildings, ascending id (8.3, 16.3) */
  scan(cx: number, cy: number, r: number): Entity[] {
    const out: Entity[] = [];
    const r2 = r * r;
    for (const e of this.w.entities) {
      if (e.kind === Kind.Nature || !e.alive || (e.kind === Kind.Unit && e.inside >= 0)) continue;
      const [x, y] = this.cell(e);
      const dx = this.wrapD(x - cx), dy = this.wrapD(y - cy);
      if (dx * dx + dy * dy < r2) out.push(e);
    }
    return out;
  }

  /** victim v was struck at by a (7); a garrison shooter's building stands in for it in the help rule (9.7) */
  attacked(v: Entity, a: Entity, building?: Entity): void {
    if (this.race(v) !== this.race(a)) {
      // AI alert first (the unit itself, not its outpost), then the help rule
      if (v.kind !== Kind.Nature && this.race(v) >= 0 && this.race(v) <= 2) this.w.ai.alert(v, a);
      this.help(v, building ?? a);
    }
    if (v.kind === Kind.Unit) {
      const vt = this.type(v);
      if ((!this.weapon(v) || vt === U.Priest || vt === T.Criminal) && !this.isPlayerOrder(v)) this.flee(v, a);
    }
  }

  private help(v: Entity, a: Entity): void {
    const [vx, vy] = this.cell(v);
    const vRace = this.race(v);
    for (const x of this.scan(vx, vy, HELP_RADIUS)) {
      if (x.kind !== Kind.Unit) continue;
      const xt = this.type(x), xr = this.race(x);
      if (xr === vRace && xt !== U.Priest && this.weapon(x)) { this.retaliate(x, a); continue; }
      if (xt === U.Priest && v.kind === Kind.Unit && !this.w.isShip(v) && v.hp < (this.rule(v)?.hp ?? 0) && x.id !== v.id &&
          (xr === vRace || this.relation(xr, vRace) === 3)) {
        const cur = x.job ? this.w.sched.get(x.job) : undefined;
        if (cur?.kind === CJ.Heal || this.isPlayerOrder(x)) continue;
        this.w.logistics.cancelJob(x);
        this.startHeal(x, v, true, 1);
      }
    }
  }

  /** retaliation rule (7.2) */
  retaliate(x: Entity, a: Entity): void {
    if (!this.weapon(x) || !this.mayAct(x, a)) return;
    const cur = x.job ? this.w.sched.get(x.job) : undefined;
    if (cur && cur.kind === CJ.Attack) {
      const curT = this.w.get(cur.data[A.Target]);
      if (cur.data[A.Target] === a.id) return;
      if (curT && this.tier(curT) <= this.tier(a)) return;
      if (cur.data[A.Player]) {
        const aj = a.job ? this.w.sched.get(a.job) : undefined;
        if (!(aj && aj.kind === CJ.Attack && aj.data[A.Target] === x.id)) return;
      }
    } else if (this.isPlayerOrder(x)) return;
    this.startAttack(x, a, true, false, 1, true);
  }

  private isPlayerOrder(u: Entity): boolean {
    const j = u.job ? this.w.sched.get(u.job) : undefined;
    return !!j && j.kind === CJ.Attack && j.data[A.Player] === 1 ||
      !!j && (j.kind === 0x16 || j.kind === 0x05 || j.kind === 0x3c || j.kind === 0x0c) && u.ordered;
  }

  /** flee job (7.3): data [attacker, homeX, homeY, phase]; its first run comes 3 ticks after the strike */
  private flee(v: Entity, a: Entity): void {
    const [x, y] = this.cell(v);
    this.suspend(v);
    v.job = this.w.sched.create(CJ.Flee, v.id, 3, [a.id, x, y, 0]).id;
  }

  /**
   * Flee (0x26, 7.3) with its own walks: out to (sight + 3) from the attacker, planned around
   * every unit (mask 0x3E); then, 50 ticks after that walk ended (any result), back to the home
   * cell (mask 0x3C); then the suspended job resumes (7.4). V or A dead at any run: success, and
   * V stops where it is.
   */
  private runFlee(job: Job): number {
    const v = this.w.get(job.owner), d = job.data;
    if (!v || !v.alive) return 0;
    const a = this.w.get(d[0]);
    if (!a || !a.alive) { this.w.stopWalk(v); return this.endUnitJob(v); }
    if (d[3] === 0) {
      const [vx, vy] = this.cell(v), [ax, ay] = this.cell(a);
      const dx = this.wrapD(vx - ax), dy = this.wrapD(vy - ay);
      const dd = Math.max(1, Math.max(Math.abs(dx), Math.abs(dy)) + Math.floor(Math.min(Math.abs(dx), Math.abs(dy)) / 2));
      const sight = this.rule(a)?.radius ?? 5;
      if (dd >= sight + 2) return this.endUnitJob(v);
      const m = this.w.size - 1;
      const px = (ax + Math.trunc((dx * (sight + 3)) / dd)) & m, py = (ay + Math.trunc((dy * (sight + 3)) / dd)) & m;
      this.w.follow(v, px, py, 2000, 1);
      d[3] = 1;
      return 1;
    }
    if (v.path) return 1;
    if (d[3] === 1) {
      d[3] = 2;
      v.action = Action.Idle; v.actionTick = this.w.tick;
      return 50;
    }
    if (d[3] === 2) {
      this.w.follow(v, d[1], d[2], 2000, 0);
      d[3] = 3;
      return 1;
    }
    return this.endUnitJob(v);
  }

  // ---------------------------------------------------------------- top-level jobs

  /** the unit's current job waits (5-tick holds) behind a new one, resuming when it ends (3.1) */
  suspend(u: Entity): void {
    // the suspended job keeps its own walk (7.4); a plain move walk (no job) is kept as job 0
    if (!u.job) { this.w.stashWalk(u, 0); return; }
    const j = this.w.sched.get(u.job);
    if (j && !j.cancelled) { j.hold = 5; u.suspended.push(u.job); this.w.stashWalk(u, u.job); }
    u.job = 0;
  }

  /** end a combat job of a unit: resume a suspended job if any; returns 0 */
  endUnitJob(u: Entity): number {
    u.job = 0;
    u.charging = false;
    while (u.suspended.length) {
      const id = u.suspended.pop()!;
      const j = this.w.sched.get(id);
      if (j && !j.cancelled) { j.hold = 0; u.job = id; break; }
    }
    // the resumed job's own walk goes on (7.4); with nothing to resume, a suspended plain move
    if (u.walks.length) this.w.resumeWalk(u, u.job);
    // a strike plays its one cycle to the end on the display (unit-motion.md 3): only a lasting
    // action (walk, work) is reset here
    if (!u.job && !u.path && u.action !== Action.Fight && u.action !== Action.Idle) { u.action = Action.Idle; u.actionTick = this.w.tick; }
    return 0;
  }

  /** start an attack job: data = attack state */
  startAttack(u: Entity, t: Entity, auto: boolean, player: boolean, delay: number, suspendCurrent: boolean): void {
    if (suspendCurrent) this.suspend(u); else this.w.logistics.cancelJob(u);
    const d = new Array(A.Size).fill(0);
    this.initAttack(d, 0, t, auto, player);
    u.job = this.w.sched.create(CJ.Attack, u.id, delay, d).id;
  }

  private runAttack(job: Job): number {
    const u = this.w.get(job.owner);
    if (!u) return 0;
    const r = this.attackStep(u, job.data, 0, true);
    if (r > 0) return r;
    return this.endUnitJob(u);
  }

  // ---------------------------------------------------------------- patrol / guard (8)

  /** guard job data: [count, index, wx0, wy0 .. wx7, wy7, attacking, attack state...] */
  startGuard(u: Entity, points: [number, number][], delay: number): void {
    this.w.logistics.cancelJob(u);
    const [x, y] = this.cell(u);
    const pts = [[x, y] as [number, number], ...points].slice(0, 8);
    const d = new Array(GD.Attack + A.Size).fill(0);
    d[GD.Count] = pts.length; d[GD.Index] = 0;
    pts.forEach(([px, py], i) => { d[GD.Points + 2 * i] = px & (this.w.size - 1); d[GD.Points + 2 * i + 1] = py & (this.w.size - 1); });
    u.job = this.w.sched.create(CJ.Guard, u.id, delay, d).id;
  }

  /** add a waypoint to a guard job (up to 8) */
  addWaypoint(u: Entity, x: number, y: number): void {
    const j = u.job ? this.w.sched.get(u.job) : undefined;
    if (!j || j.kind !== CJ.Guard || j.data[GD.Count] >= 8) return;
    const k = j.data[GD.Count]++;
    j.data[GD.Points + 2 * k] = x & (this.w.size - 1); j.data[GD.Points + 2 * k + 1] = y & (this.w.size - 1);
  }

  private runGuard(job: Job): number {
    const u = this.w.get(job.owner), d = job.data;
    if (!u || !u.alive) return 0;
    if (d[GD.Attacking]) {
      const r = this.attackStep(u, d, GD.Attack, false);
      if (r > 0) return r;
      d[GD.Attacking] = 0;
      d[GD.Walking] = 0;
    }
    // scan sight + 1 for enemies of nations at war or without contact, tier <= 1 (8.1)
    const [x, y] = this.cell(u);
    const t = this.choose(u, this.scan(x, y, (this.rule(u)?.radius ?? 10) + 1), -1, 1);
    if (t) {
      this.stopWalk(u);
      this.initAttack(d, GD.Attack, t, true, false);
      d[GD.Attacking] = 1;
      return 1;
    }
    if (u.path) return 1;
    if (d[GD.Walking]) { d[GD.Index] = (d[GD.Index] + 1) % Math.max(1, d[GD.Count]); d[GD.Walking] = 0; }
    const i = d[GD.Index];
    const wx = d[GD.Points + 2 * i], wy = d[GD.Points + 2 * i + 1];
    if (x !== wx || y !== wy) {
      this.w.walk(u, wx, wy, 6000);
    } else if (u.action !== Action.Idle) { u.action = Action.Idle; u.actionTick = this.w.tick; }
    d[GD.Walking] = 1;
    return 3;
  }

  /**
   * target chooser (8.3): race filter -1 = nations at war or without contact, else that race;
   * returns the best candidate of the lowest tier present
   */
  choose(c: Entity, cands: Entity[], raceFilter: number, maxTier: number): Entity | undefined {
    const cw = this.weapon(c);
    if (!cw) return undefined;
    const cRace = this.race(c);
    const [cx, cy] = this.cell(c);
    let tierCap = maxTier, best: Entity | undefined, bestScore = -1, bestTier = 99;
    for (const t of cands) {
      if (!t.alive || !this.mayAct(c, t)) continue;
      const tt = this.type(t);
      if (t.kind === Kind.Unit && (tt === U.Merchant || tt === U.Diplomat)) continue;
      const tr = this.race(t);
      if (raceFilter === -1) { const st = this.relation(cRace, tr); if (st !== 0 && st !== 1) continue; }
      else if (tr !== raceFilter) continue;
      const tier = this.tier(t);
      if (tier > tierCap) continue;
      tierCap = tier;
      const [tx, ty] = this.cell(t);
      const dist = this.dist(cx, cy, tx, ty);
      let score = dist <= cw.range + 2 ? 2 : 1;
      if (dist <= cw.range) score += 2;
      if (t.hp > cw.min) score++;
      const tw = t.kind === Kind.Unit ? this.weapon(t) : undefined;
      if (tw && tw.max >= 151 && cw.max >= 81) score += 3;
      else if (tw && tw.max >= 71 && cw.max >= 31) score += 2;
      else if (tw && tw.max > 20) score++;
      if (tier < bestTier || score > bestScore) { best = t; bestScore = score; bestTier = tier; }
    }
    return best;
  }

  // ---------------------------------------------------------------- outposts (9)

  /** the outpost job (0x1C) is created and first runs 20 ticks later unless it already runs (9.2 step 3) */
  startOutpost(b: Entity): void {
    const j = b.opJob ? this.w.sched.get(b.opJob) : undefined;
    if (!j || j.cancelled) b.opJob = this.w.sched.create(CJ.Outpost, b.id, 20).id;
  }

  /**
   * Outpost job (0x1C, 9.3), every 20 ticks until it is cancelled (last ranged unit put outside,
   * collapse): idle soldiers in occupant order have any other job cancelled; one scan of the
   * outpost's radius around its anchor; each idle soldier gets a garrison-fire job on the first
   * candidate of a race at war or without contact (diplomats dropped) in garrison range of the
   * anchor.
   */
  private runOutpost(job: Job): number {
    const b = this.w.get(job.owner);
    if (!b || !b.alive || b.opJob !== job.id) return 0;
    const idle: Entity[] = [];
    for (const u of this.w.logistics.occupants(b)) {
      if (!isSoldier(this.type(u))) continue;
      const j = u.job ? this.w.sched.get(u.job) : undefined;
      if (j && !j.cancelled && j.kind === CJ.GarrisonFire) continue;
      if (u.job || u.suspended.length) this.w.logistics.cancelJob(u);
      idle.push(u);
    }
    if (!idle.length) return 20;
    const [x, y] = this.cell(b);
    const cands = this.scan(x, y, this.rule(b)?.radius ?? 15);
    for (const s of idle) {
      const wpn = this.weapon(s);
      if (!wpn) continue;
      const sr = this.race(s);
      for (let k = 0; k < cands.length; k++) {
        const c = cands[k];
        const st = this.relation(sr, this.race(c));
        if ((st !== 0 && st !== 1) || (c.kind === Kind.Unit && this.type(c) === U.Diplomat)) { cands.splice(k--, 1); continue; }
        if (!this.inRange(x, y, c, wpn, b)) continue;
        s.job = this.w.sched.create(CJ.GarrisonFire, s.id, 1, [c.id, b.id, Combat.garrisonBonus(wpn.range), 0]).id;
        break;
      }
    }
    return 20;
  }

  /**
   * Garrison-fire job (0x1B, 9.6): data [target, outpost, E, strike child running]. Ends when the
   * target is dead (its alive flag only) or out of garrison range of the soldier's own stored cell
   * (quirk: the outpost job measures from the anchor); otherwise a strike child (created on the
   * first in-range run, which returns 1) runs with the outpost as the facing origin.
   */
  private runGarrisonFire(job: Job): number {
    const u = this.w.get(job.owner), d = job.data;
    if (!u || !u.alive || u.job !== job.id) return 0;
    const b = this.w.get(d[1]);
    const t = this.w.get(d[0]);
    const wpn = this.weapon(u);
    // ours: a unit no longer inside its outpost (sent out, collapse) does not go on shooting
    if (!b || b.kind !== Kind.Building || u.inside !== b.id || !wpn) { u.job = 0; return 0; }
    if (!t || !t.alive) { u.job = 0; return 0; }
    const [ux, uy] = this.cell(u);
    if (!this.inRange(ux, uy, t, wpn, b)) { u.job = 0; return 0; }
    if (!d[3]) { d[3] = 1; return 1; }
    return this.strike(u, t, wpn, ux, uy, b);
  }

  // ---------------------------------------------------------------- death (10)

  /** an object's hit points reached 0 */
  die(e: Entity): void {
    if (!e.alive) return;
    if (e.kind === Kind.Unit) {
      e.alive = false;
      const [x, y] = this.cell(e);
      this.w.effect({ kind: 'die', tick: this.w.tick, x, y, race: this.race(e), type: this.rule(e)?.weapon ?? -1 });
      this.w.removeEntity(e);
    } else if (e.kind === Kind.Building) this.collapse(e, true);
    else if (this.rule(e)?.cls === 7) this.w.logistics.killAnimal(e);
    else this.w.removeEntity(e);
  }

  /** building destruction, phase 1 (10.3) */
  collapse(b: Entity, announce: boolean, noRubble = false): void {
    if (!b.alive) return;
    b.alive = false;
    const r = this.rule(b);
    const t = this.w.economy.town(b.town);
    let stone = r?.cost[2] ?? 0, k = 9;
    if (!b.complete) {
      const o = b.order;
      const owed = b.needed.filter(g => g === 2).length;
      stone = Math.max(0, stone - owed - (b.local[2] ?? 0)) + (b.local[2] ?? 0);
      k = o && o.T ? Math.trunc(((o.T - o.R) * 10) / o.T) : 0;
      if (this.type(b) === T.TownHall) k = 0;
    } else this.w.economy.deactivate(b);
    if (noRubble) stone = 0;   // a cancelled founding (units-and-jobs.md 11.6)
    // the training job is deleted: its destructor drops the queued orders from the town's pending
    // counts, no refund (units-and-jobs.md 9 "Lost building")
    this.w.logistics.dropTraining(b);
    for (const id of [b.prodJob, b.opJob, b.houseJob]) if (id) this.w.sched.cancel(id);
    b.prodJob = b.opJob = b.houseJob = 0;
    // occupants come out alive, in occupant (entry) order, through their leave jobs; units already
    // on their way out keep theirs (units-and-jobs.md 4.10)
    for (const u of this.w.logistics.occupants(b)) {
      this.w.logistics.cancelJob(u); this.w.logistics.leave(u); u.idle = 0;
    }
    b.collapseStage = k;
    b.complete = false; b.buildFrame = k;
    // message 0x49: the display shows BU0 at stage k and plays Sfx_053 once if the building is
    // drawn (10.3.1); a display event, not simulation state
    const [cx, cy] = this.cell(b);
    this.w.effect({ kind: 'collapse', tick: this.w.tick, x: cx, y: cy, type: 53 });
    this.w.sched.create(CJ.Collapse, b.id, 0, [k, stone, announce && !!t?.alive ? 1 : 0]);
  }

  private runCollapse(job: Job): number {
    const b = this.w.get(job.owner);
    if (!b) return 0;
    // the frames wait while ejected occupants are still on their leave job (10.3, 10.3.1)
    if (this.w.entities.some(u => u.kind === Kind.Unit && this.w.logistics.leavingFrom(u) === b.id)) return 10;
    if (job.data[0] > 0) { job.data[0]--; b.buildFrame = job.data[0]; b.collapseStage = job.data[0]; return 1; }
    this.destroyed(b, job.data[1], job.data[2] === 1);
    return 0;
  }

  /** phase 2 (10.3): residents homeless, rubble, town hall loss */
  private destroyed(b: Entity, stone: number, announce: boolean): void {
    const t = this.w.economy.town(b.town);
    const r = this.rule(b);
    const [bx, by] = this.cell(b);
    if (t?.alive && announce) this.w.notify(t.race, M.BuildingLost);
    this.w.destroyBuilding(b);
    if (t && this.type(b) === T.TownHall && b.id === t.hall) this.destroyTown(t);
    // rubble piles over the footprint; harbours and shipyards leave none (addon.md 3.6)
    if (stone > 0 && r && !(this.w.addon && (this.type(b) === 62 || this.type(b) === 63))) {
      const sx = Math.max(1, r.sizeX || 2), sy = Math.max(1, r.sizeY || 2);
      let a = Math.floor(stone / (sx * sy));
      if (a < 3) a = Math.min(stone, 3);
      let rest = stone;
      for (let dx = 0; dx < sx && rest > 0; dx++) for (let dy = 0; dy < sy && rest > 0; dy++) {
        const x = bx - dx, y = by - dy;
        if (this.w.occupied(x, y)) continue;
        const pile = Math.min(a, rest);
        rest -= pile;
        const m = this.w.size - 1;
        const n = this.w.spawn({ cls: 2, group: NATURE_GROUP, type: RUBBLE, owner: -1, x: x & m, y: y & m, z: 0 });
        n.amount = pile; n.full = Math.max(pile, 3);
        if (t?.alive) this.w.logistics.requestTransport(t, 3, n.id);
      }
    }
  }

  /** town destruction (10.4) */
  destroyTown(t: Town): void {
    if (!t.alive) return;
    t.alive = false;
    const eco = this.w.economy;
    const p = eco.players[t.race];
    this.w.notify(t.race, M.TownDestroyed);
    const others = eco.towns.filter(o => o.alive && o.race === t.race && this.w.get(o.hall)?.alive);
    const nearest = others.sort((a, b) => this.dist(a.x, a.y, t.x, t.y) - this.dist(b.x, b.y, t.x, t.y))[0];
    for (const u of [...this.w.entities]) {
      if (u.kind !== Kind.Unit || u.town !== t.id) continue;
      this.w.logistics.cancelJob(u);
      if (nearest) { eco.leaveTown(u); eco.joinTown(u, nearest); nearest.homeless.push(u.id); }
      else this.die(u);
    }
    for (const b of [...this.w.entities]) if (b.kind === Kind.Building && b.town === t.id && b.alive) this.collapse(b, false);
    if (p && !eco.towns.some(o => o.alive && o.race === t.race)) {
      p.outcome = p.outcome || -1;
      p.defeated = true;
      for (const o of eco.players) if (o && o.race !== t.race) this.w.notify(o.race, M.Defeated + t.race);
    }
  }

  // ---------------------------------------------------------------- crime and police (12)

  startCriminal(u: Entity): void {
    u.job = this.w.sched.create(CJ.Criminal, u.id, 50, new Array(CR.Attack + A.Size).fill(0)).id;
  }

  private runCriminal(job: Job): number {
    const u = this.w.get(job.owner), d = job.data;
    if (!u || !u.alive || this.type(u) !== T.Criminal) return 0;
    if (!d[CR.Active]) {
      const porters = this.w.entities.filter(e => e.kind === Kind.Unit && e.town === u.town && this.type(e) === T.Porter && e.alive);
      if (!porters.length) return 50;
      const v = porters[this.w.rand.next() % porters.length];
      this.initAttack(d, CR.Attack, v, false, false);
      d[CR.Active] = 1; d[CR.Hp0] = v.hp;
    }
    // the attack runs first; the 10-HP stop is tested after it (12.1 step 2)
    const r = this.attackStep(u, d, CR.Attack, false);
    const v = this.w.get(d[CR.Attack + A.Target]);
    if (r > 0 && v && d[CR.Hp0] - v.hp <= 9) return r;
    d[CR.Active] = 0;
    this.stopWalk(u);
    return 50;
  }

  /** police station: send the officer after criminals (12.2); called by the operator job every 50 ticks */
  policeDispatch(b: Entity): boolean {
    const t = this.w.economy.town(b.town);
    if (!t) return false;
    const criminal = this.w.entities.find(e => e.kind === Kind.Unit && e.town === t.id && this.type(e) === T.Criminal && e.alive && e.inside < 0);
    const officer = this.w.get(b.operatorId);
    if (!criminal || !officer || officer.inside !== b.id) return false;
    // he stays the station's operator: the plain eject does not deactivate it (12.2, units-and-jobs.md 8.5)
    officer.job = this.w.sched.create(CJ.Arrest, officer.id, 1, [b.id, 0, ...new Array(A.Size).fill(0)]).id;
    this.w.logistics.leave(officer);   // the arrest job waits behind the leave job (units-and-jobs.md 4.10)
    return true;
  }

  /**
   * The town's criminal list (12.3 "The criminal list"): its ids in list order, without the dead
   * and those no longer criminals of this town; criminals not yet in it are appended in creation
   * (entity) order, which is the order they joined the town. The pruned list is stored back.
   */
  criminalList(t: Town): number[] {
    const isCrim = (e: Entity | undefined): e is Entity => !!e && e.kind === Kind.Unit && e.alive && e.town === t.id && this.type(e) === T.Criminal;
    const list = (t.criminals ?? []).filter(id => isCrim(this.w.get(id)));
    const have = new Set(list);
    for (const e of this.w.entities) if (isCrim(e) && !have.has(e.id)) list.push(e.id);
    t.criminals = list;
    return list;
  }

  /**
   * The arrest job's pick (12.3 step 1): the first criminal of the officer's town that is alive and
   * not being escorted, moved to the end of the list when the list holds two or more.
   */
  private pickCriminal(u: Entity): Entity | undefined {
    const t = this.w.economy.town(u.town);
    if (!t) return undefined;
    const list = this.criminalList(t);
    for (let i = 0; i < list.length; i++) {
      const c = this.w.get(list[i])!;
      if (c.job && this.w.sched.get(c.job)?.kind === CJ.Escort) continue;
      if (list.length > 1) { list.splice(i, 1); list.push(c.id); }
      return c;
    }
    return undefined;
  }

  /** arrest job data: [station (0 = none), attacking, attack state...] */
  startArrest(officer: Entity, station: number): void {
    this.w.logistics.cancelJob(officer);
    officer.job = this.w.sched.create(CJ.Arrest, officer.id, 1, [station, 0, ...new Array(A.Size).fill(0)]).id;
  }

  private runArrest(job: Job): number {
    const u = this.w.get(job.owner), d = job.data;
    if (!u || !u.alive) return 0;
    const station = d[0] ? this.w.get(d[0]) : undefined;
    if (d[1] === 2) { // walking home
      if (u.path) return 1;
      if (station) { u.job = 0; this.w.logistics.goHome(u, station); return 0; }
      return this.endUnitJob(u);
    }
    if (d[1] === 1) {
      // the attack child runs first; the arrest test follows a run that did not end it (12.3 step 2)
      const r = this.attackStep(u, d, 2, false);
      const c = this.w.get(d[2 + A.Target]);
      if (r === 0) {
        // the criminal died or the chase failed: the next pick comes one tick later (12.3 step 3).
        // The job forgets its criminal only when it is dead (`0047ba4a`)
        if (!c || !c.alive) d[2 + A.Target] = 0;
        d[1] = 0;
        return 1;
      }
      if (station && c && c.alive && c.hp <= Math.trunc(((this.rule(c)?.hp ?? 50) * 80) / 100)) {
        // arrest: the criminal walks into the station by itself (12.4); the child is dropped and
        // the job runs again after the child's delay, with no criminal
        this.w.logistics.cancelJob(c);
        c.job = this.w.sched.create(CJ.Escort, c.id, 1, [station.id, 0]).id;
        d[1] = 0; d[2 + A.Target] = 0;
        this.stopWalk(u);
      }
      return r;
    }
    // the clicked criminal of a manual order is not known to the job: it picks by itself (12.3).
    // With no free criminal in the list it takes up its last one again if that is alive (12.3)
    const last = d[2 + A.Target] ? this.w.get(d[2 + A.Target]) : undefined;
    const c = this.pickCriminal(u) ?? (last && last.alive ? last : undefined);
    if (!c) {
      if (!station) return this.endUnitJob(u);
      d[1] = 2;
      this.w.logistics.walkTo(u, station);
      return 1;
    }
    this.initAttack(d, 2, c, false, false);
    d[1] = 1;
    return 1;
  }

  private runEscort(job: Job): number {
    const c = this.w.get(job.owner), d = job.data;
    if (!c || !c.alive) return 0;
    const st = this.w.get(d[0]);
    if (!st) { c.job = 0; return 0; }
    if (d[1] === 0) { this.w.logistics.walkTo(c, st); d[1] = 1; return 1; }
    if (d[1] === 1) {
      if (c.path) return 1;
      const e = this.w.logistics.enterNow(c, st);
      if (e < 0) { c.job = 0; return 0; }
      if (e > 0) return e;
      d[1] = 2;
      return 599;
    }
    // released as a porter (12.4 step 3)
    if (c.inside === st.id) {
      // a type change: the needs are re-evaluated twice (economy.md 5.4, `00464840`)
      this.w.economy.changeType(c, ((this.race(c) << 16) | T.Porter) >>> 0);
      c.hp = this.rule(c)?.hp ?? 50;
      c.job = 0;
      this.w.logistics.leave(c);
      return 0;
    }
    c.job = 0;
    return 0;
  }

  // ---------------------------------------------------------------- healing (13)

  /** heal job data: [auto, active, attack state...]; owner = priest */
  startHeal(priest: Entity, patient: Entity | undefined, auto: boolean, delay: number): void {
    const d = [auto ? 1 : 0, 0, ...new Array(A.Size).fill(0)];
    if (patient) { this.initAttack(d, 2, patient, false, false); d[1] = 1; }
    priest.job = this.w.sched.create(CJ.Heal, priest.id, delay, d).id;
  }

  private runHeal(job: Job): number {
    const u = this.w.get(job.owner), d = job.data;
    if (!u || !u.alive) return 0;
    const p = d[1] ? this.w.get(d[2 + A.Target]) : undefined;
    if (d[1] && (!p || !p.alive || p.hp >= (this.rule(p)?.hp ?? 0))) { d[1] = 0; this.stopWalk(u); return 3; }
    if (d[1]) {
      const r = this.attackStep(u, d, 2, false);
      if (r > 0) return r;
      d[1] = 0;
      return 3;
    }
    if (!d[0]) return this.endUnitJob(u);
    // next patient: the nearest wounded unit within sight
    const [x, y] = this.cell(u);
    let best: Entity | undefined, bd = Infinity;
    for (const e of this.scan(x, y, this.rule(u)?.radius ?? 5)) {
      if (e.kind !== Kind.Unit || e.id === u.id || !this.mayAct(u, e)) continue;
      const [ex, ey] = this.cell(e);
      const dd = this.dist(x, y, ex, ey);
      if (dd < bd) { best = e; bd = dd; }
    }
    if (!best) return this.endUnitJob(u);
    this.initAttack(d, 2, best, false, false);
    d[1] = 1;
    return 3;
  }

  // ---------------------------------------------------------------- dispatch

  runJob(job: Job): number {
    switch (job.kind) {
      case CJ.Attack: return this.runAttack(job);
      case CJ.Impact: return this.runImpact(job);
      case CJ.Criminal: return this.runCriminal(job);
      case CJ.Arrest: return this.runArrest(job);
      case CJ.Escort: return this.runEscort(job);
      case CJ.GarrisonFire: return this.runGarrisonFire(job);
      case CJ.Outpost: return this.runOutpost(job);
      case CJ.Collapse: return this.runCollapse(job);
      case CJ.Flee: return this.runFlee(job);
      case CJ.Guard: return this.runGuard(job);
      case CJ.Heal: return this.runHeal(job);
      default: return 0;
    }
  }

  /** right-click order handling for combat cases (3.2); true if handled */
  order(u: Entity, target: Entity): boolean {
    const ut = this.type(u);
    if (target.kind === Kind.Nature) return false;
    const sameRace = this.race(target) === this.race(u);
    if (ut === U.Priest && target.kind === Kind.Unit && !this.w.isShip(target) && target.hp < (this.rule(target)?.hp ?? 0) && sameRace) {
      this.w.logistics.cancelJob(u);
      this.startHeal(u, target, true, 1);
      return true;
    }
    if (ut === U.Police && sameRace && target.kind === Kind.Unit && this.type(target) === T.Criminal) {
      // no station and no target: every order starts a new job, which picks the town's first free
      // criminal and rotates it to the end, so repeated orders cycle through them (12.3)
      this.startArrest(u, 0);
      return true;
    }
    if (!sameRace && this.weapon(u) && ut !== U.Priest && this.mayAct(u, target)) {
      this.startAttack(u, target, true, true, 1, false);
      return true;
    }
    return false;
  }
}

/** guard job data slots */
const GD = { Count: 0, Index: 1, Points: 2, Walking: 18, Attacking: 19, Attack: 20 } as const;
/** criminal job data slots */
const CR = { Active: 0, Hp0: 1, Attack: 2 } as const;
