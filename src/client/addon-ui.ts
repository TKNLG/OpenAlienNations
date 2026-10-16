// Client-side rules of the add-on (Gold Edition mission pack) that the side panel, the cursor and
// the selection need: which objects are transport ships, traders and market-like buildings, the
// passengers of a ship by type, and what a right-click would do (the order, and the cursor of the
// optional cursor-hints mode).
// Spec: docs/architecture/integration-addon-gameplay.md 3, 4; docs/game/addon.md 1.2, 4.2, 5.6.
// Pure functions of the world: no DOM, so they are tested in node (test/addon-client.test.ts).

import type { World, Entity } from '../engine/world.ts';

const KIND_UNIT = 0, KIND_BUILDING = 1, KIND_NATURE = 2;
const MERCHANT = 28, MARKET = 48;
const PRIEST = 22;
/** record flags (+0xB8, addon.md 1.2) */
const FLAG_MARKET_LIKE = 0x20, FLAG_TRADER = 0x40;
const SHIP_CLASS = 14, FISH_CLASS = 15;
export const SHIP = { Fishing: 64, Light: 65, Heavy: 66, Transport: 67 } as const;

const type = (e: Entity) => e.oid & 0xffff;
const race = (e: Entity) => e.oid >>> 16;

/** a ship (unit with behaviour class 14) */
export function isShip(w: World, e: Entity): boolean {
  return e.kind === KIND_UNIT && w.rules.get(e.oid)?.cls === SHIP_CLASS;
}

/** a ship that carries passengers (capacity +0xDC > 0: the transport, type 67) */
export function isTransport(w: World, e: Entity): boolean {
  return isShip(w, e) && (w.rules.get(e.oid)?.garrison ?? 0) > 0;
}

/** passenger capacity of a ship, 0 for everything else */
export function capacity(w: World, e: Entity): number {
  return isShip(w, e) ? Math.max(0, w.rules.get(e.oid)?.garrison ?? 0) : 0;
}

/** a trader: merchant (type 28) or any unit with record flag 0x40 (transport ships) */
export function isTrader(w: World, e: Entity): boolean {
  return e.kind === KIND_UNIT && (type(e) === MERCHANT || ((w.rules.get(e.oid)?.flags ?? 0) & FLAG_TRADER) !== 0);
}

/** market-like building: the market (type 48) or record flag 0x20 (the harbour) */
export function isMarketLike(w: World, e: Entity): boolean {
  return e.kind === KIND_BUILDING && (type(e) === MARKET || ((w.rules.get(e.oid)?.flags ?? 0) & FLAG_MARKET_LIKE) !== 0);
}

/** the building a trader trades at: market for merchants, harbour for ships (addon.md 5.7) */
export function terminalOf(e: Entity): number { return type(e) === MERCHANT ? MARKET : 62; }

/** ships never gain rank and have no home (addon.md 4.1): no experience badge, no MOVEHOME */
export function hasHome(w: World, e: Entity): boolean { return !isShip(w, e); }

/** PATROL: land soldiers 29..36 and the warships 65, 66 (addon.md 4.1) */
export function canPatrol(w: World, e: Entity): boolean {
  const t = type(e);
  return (t >= 29 && t <= 36) || (isShip(w, e) && (t === SHIP.Light || t === SHIP.Heavy));
}

/** passengers of a ship grouped by unit object id, in boarding order of each type's first passenger */
export function passengerTypes(w: World, ship: Entity): { oid: number; count: number }[] {
  const out: { oid: number; count: number }[] = [];
  for (const id of ship.passengers) {
    const p = w.get(id);
    if (!p) continue;
    const row = out.find(r => r.oid === p.oid);
    if (row) row.count++;
    else out.push({ oid: p.oid, count: 1 });
  }
  return out;
}

/** what a right-click on `target` (null = open ground or water) would do with these units */
export type Intent = 'none' | 'move' | 'order' | 'harvest' | 'board' | 'attack';
const RANK: Record<Intent, number> = { none: 0, move: 1, order: 2, harvest: 3, board: 4, attack: 5 };

/**
 * The cursor of a right-click (integration-addon-gameplay.md 4), mirroring the engine's order
 * rules (`Logistics.order`, `Combat.order`, `Naval.boardOrder`) for each unit; the strongest
 * intent of the selection wins (attack > board > harvest > order > move).
 */
export function orderIntent(w: World, player: number, units: Entity[], target: Entity | null): Intent {
  const own = units.filter(u => u.kind === KIND_UNIT && u.owner === player && u.inside < 0 && u.alive);
  if (!own.length) return 'none';
  if (!target || own.some(u => u.id === target.id)) return 'move';
  let best: Intent = 'move';
  for (const u of own) {
    const i = unitIntent(w, u, target);
    if (RANK[i] > RANK[best]) best = i;
  }
  return best;
}

function unitIntent(w: World, u: Entity, target: Entity): Intent {
  const ship = isShip(w, u);
  if (target.kind === KIND_NATURE) {
    if (ship) return type(u) === SHIP.Fishing && w.rules.get(target.oid)?.cls === FISH_CLASS ? 'harvest' : 'move';
    if (w.logistics.canHarvest(u, target)) return 'harvest';
    // hunters act on animals through the combat rules
    return w.combat.mayAct(u, target) ? 'harvest' : 'move';
  }
  if (target.kind === KIND_UNIT && target.inside >= 0) return 'move';
  // combat first (Combat.order): an armed unit of another race attacks
  if (race(target) !== race(u) && type(u) !== PRIEST && w.combat.weapon(u) && w.combat.mayAct(u, target)) return 'attack';
  // boarding a transport ship (Naval.boardOrder): land units only, room left
  if (w.addon && !ship && capacity(w, target) > 0) return w.naval.mayEnter(target, u) ? 'board' : 'move';
  if (ship) return 'move';   // a ship sails next to the target
  if (target.kind === KIND_BUILDING && target.owner === u.owner) return 'order';
  if (target.kind === KIND_UNIT && race(target) === race(u) && type(u) === PRIEST && target.hp < (w.rules.get(target.oid)?.hp ?? 0) && !isShip(w, target)) return 'order';
  return 'move';
}

/**
 * CSS cursor per intent: only for the enhanced-mode "cursor hints" option (settings cursorHints). The
 * original's cursor never depends on the target (docs/ui/cursors.md 4, 7.1); there 'none' and
 * 'move' keep the selection-based cursor (null). Attack uses the game's sword when it was read
 * from the executable (client/cursors.ts), the rest are CSS keywords of our own.
 */
export const INTENT_CURSOR: Record<Intent, string | null> = {
  none: null, move: null, order: 'pointer', harvest: 'cell', board: 'alias', attack: 'var(--cur-sword, crosshair)',
};
