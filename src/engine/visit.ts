// Walking to and entering buildings, for the unit jobs that live outside Logistics (trade route
// 0x20, operator errand 0x38). Same rules as Logistics' own jobs: walking is done by the world's
// per-tick movement, and entering goes through the building's one-at-a-time door queue
// (docs/game/units-and-jobs.md 4.2, 4.4).

import type { World, Entity } from './world.ts';
import { MAX_PLANS } from './motion.ts';

const SUBCELL = 256;
const KIND_BUILDING = 1;
/** animation actions (od-odb.md): walk, idle, carry */
const ACT_WALK = 0, ACT_IDLE = 3, ACT_CARRY = 4;

export function cellOf(e: Entity): [number, number] { return [Math.floor(e.x / SUBCELL), Math.floor(e.y / SUBCELL)]; }

/** set the unit's animation action; walking while carrying plays the carry action (units-and-jobs.md 3.3) */
export function setAction(w: World, u: Entity, a: number): void {
  const act = a === ACT_WALK && u.carryAmount > 0 ? ACT_CARRY : a;
  if (u.action !== act) { u.action = act as Entity['action']; u.actionTick = w.tick; }
}
export const setIdle = (w: World, u: Entity) => setAction(w, u, ACT_IDLE);

/** start walking to a cell; true if a path exists (or the unit is already there) */
export function walkTo(w: World, u: Entity, x: number, y: number): boolean {
  const ok = w.walk(u, x, y);
  if (ok && u.path) setAction(w, u, ACT_WALK);
  return ok;
}

/** go to an object: a building's entrance, otherwise the object's cell, moved by the go-to target chooser (4.2, 4.8) */
export function walkToEntity(w: World, u: Entity, e: Entity): boolean {
  const [px, py] = e.kind === KIND_BUILDING ? w.logistics.entrance(e) : cellOf(e);
  if (w.logistics.doorInside(e) || w.isShip(u)) return walkTo(w, u, px, py);
  const [x, y] = w.goalCell(px, py);
  return walkTo(w, u, x, y);
}

/**
 * Close enough to enter (at a building's entrance) or to act on an object (adjacent). A walk the
 * arrival tolerance ended a little short of a door counts as arrived (4.1; entering has no distance test).
 */
export function nearEntity(w: World, u: Entity, e: Entity): boolean {
  if (w.logistics.doorInside(e)) return w.naval.dockRange(u, e);   // add-on harbour / shipyard
  const [ux, uy] = cellOf(u);
  const [x, y] = e.kind === KIND_BUILDING ? w.logistics.entrance(e) : cellOf(e);
  const d = w.logistics.dist(ux, uy, x, y);
  return d <= 1 || (e.kind === KIND_BUILDING && d <= MAX_PLANS && w.walkOk(u));
}

/**
 * Entering (4.4, 4.10): the turn toward the building's anchor, the door queue (only the head may
 * enter, the others ask again after 10 ticks), admission (the door opens) and 5 ticks later the
 * unit is inside. One call per job run: 0 = inside now, otherwise the ticks to the next call.
 */
export function enterDoor(w: World, u: Entity, b: Entity): number {
  if (w.isShip(u)) return w.naval.dock(u, b) ? 0 : 10;   // a ship docks without leaving its cell (addon.md 5.8)
  return w.logistics.enter(u, b);
}

/**
 * Leave the building the unit is in (4.10): the building ejects it, the running job waits behind
 * the leave job. True when the unit is now on its way out (the job returns and resumes outside).
 */
export function exitBuilding(w: World, u: Entity): boolean {
  if (u.inside < 0) return false;
  w.logistics.leave(u);
  return w.logistics.leaving(u);
}

/** take the unit out of any door queue it waits in */
export function leaveQueues(w: World, u: Entity): void {
  for (const b of w.entities) if (b.doorQueue.length) b.doorQueue = b.doorQueue.filter(id => id !== u.id);
}

/** stop walking: a unit in the middle of a step finishes that step, then stands */
export function stopWalking(w: World, u: Entity): void { w.stopWalk(u); }

/** nearest of a list of buildings to a cell (torus distance, first one wins ties) */
export function nearestTo(w: World, list: Entity[], x: number, y: number): Entity | null {
  let best: Entity | null = null, bd = Infinity;
  for (const b of list) {
    const [bx, by] = cellOf(b);
    const d = w.logistics.dist(x, y, bx, by);
    if (d < bd) { best = b; bd = d; }
  }
  return best;
}
