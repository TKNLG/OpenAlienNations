// Building placement: who tests what (docs/game/units-and-jobs.md 6.1.1, fog-of-war.md 6,
// economy.md 11.7, addon.md 3.1). The UI needs the grown footprint in sight for every building
// type; the mine, town hall, harbour and shipyard are exempt from the territory test only; the
// simulation tests neither fog nor territory.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { World, Kind, SUB, type Entity } from '../src/engine/world.ts';
import type { Town } from '../src/engine/economy.ts';
import type { ObjectRule } from '../src/formats/odb.ts';
import { loadMission, DATA, loadAddonMission, HAS_GOLD } from './helpers/mission.ts';
import { Vision } from '../src/client/vision.ts';
import { footprintInSight, placementAllowed, ghostAllowed } from '../src/client/placement.ts';

const skip = !existsSync(`${DATA}/dv.odb`) && 'AN_DATA not set';
const skipGold = !HAS_GOLD && 'AN_GOLD data not found';
const cell = (e: Entity) => [Math.floor(e.x / SUB), Math.floor(e.y / SUB)] as const;

/** a rule of the town's race, invented and affordable */
function ready(w: World, t: Town, type: number): ObjectRule {
  const r = w.rules.get(((t.race << 16) | type) >>> 0)!;
  t.stock.fill(99);
  const p = w.economy.players[t.race]!;
  if (r.invention >= 0) p.progress[r.invention] = p.costs[r.invention];
  return r;
}

/** set the grown footprint (max corner x, y) of r to one fog state: 0 unexplored, 1 explored, 2 in sight */
function paint(v: Vision, w: World, r: ObjectRule, x: number, y: number, state: 0 | 1 | 2): void {
  v.visible.fill(0); v.explored.fill(0);
  const fx = Math.max(1, r.sizeX), fy = Math.max(1, r.sizeY), n = w.size - 1;
  for (let dy = -1; dy <= fy; dy++) for (let dx = -1; dx <= fx; dx++) {
    const i = (((y - fy + 1 + dy) & n) << w.bits) | ((x - fx + 1 + dx) & n);
    v.explored[i] = state > 0 ? 1 : 0;
    v.visible[i] = state === 2 ? 1 : 0;
  }
}

/** first site outside the town's territory where the simulation's rule passes */
function siteOutside(w: World, t: Town, r: ObjectRule): [number, number] | null {
  for (let y = 0; y < w.size; y++) for (let x = 0; x < w.size; x++) {
    if (w.territory.ownerAt(x, y) !== -1) continue;   // -1: no territory
    if (w.logistics.canPlaceSite(t, r, x, y)) return [x, y];
  }
  return null;
}

/** the visibility rule for one exempt type outside the territory */
function checkFogRule(w: World, t: Town, r: ObjectRule, label: string): [number, number] {
  const site = siteOutside(w, t, r);
  assert.ok(site, `${label}: a site outside every territory`);
  const [x, y] = site!;
  assert.ok(w.logistics.canPlace(t, r, x, y), `${label}: no territory test`);
  const v = new Vision(w.size, w.bits);
  paint(v, w, r, x, y, 2);
  assert.equal(placementAllowed(w, t, r, x, y, v), true, `${label}: in sight outside the territory`);
  paint(v, w, r, x, y, 1);
  assert.equal(placementAllowed(w, t, r, x, y, v), false, `${label}: explored but fogged is refused`);
  paint(v, w, r, x, y, 0);
  assert.equal(placementAllowed(w, t, r, x, y, v), false, `${label}: unexplored is refused`);
  // one margin cell out of sight is enough to refuse
  paint(v, w, r, x, y, 2);
  v.visible[(((y + 1) & (w.size - 1)) << w.bits) | ((x + 1) & (w.size - 1))] = 0;
  assert.equal(footprintInSight(v, r, x, y), false, `${label}: the 1-cell margin counts`);
  // MAGICEYE switches fog drawing off, not the rule
  paint(v, w, r, x, y, 1);
  v.off = true;
  assert.equal(v.cellVisible(x, y), true, 'MAGICEYE draws everything');
  assert.equal(placementAllowed(w, t, r, x, y, v), false, `${label}: MAGICEYE does not lift the rule`);
  return [x, y];
}

test('mine outside the territory: placeable only in sight, not in explored fog or unexplored land', { skip }, () => {
  const { world: w } = loadMission('Pimmons.mdb', 1, DATA, false);
  const t = w.economy.towns.find(x => x.alive)!;
  checkFogRule(w, t, ready(w, t, 50), 'mine');
});

test('other buildings unchanged: territory and sight both needed', { skip }, () => {
  const { world: w } = loadMission('Pimmons.mdb', 1, DATA, false);
  const t = w.economy.towns.find(x => x.alive)!;
  const house = ready(w, t, 37);
  const v = new Vision(w.size, w.bits);
  // inside the territory: in sight yes, fogged no
  let inside: [number, number] | null = null;
  for (let d = 3; d < 20 && !inside; d++) for (const [dx, dy] of [[d, 0], [-d, 0], [0, d], [0, -d]]) {
    if (w.logistics.canPlace(t, house, t.x + dx, t.y + dy)) { inside = [(t.x + dx) & (w.size - 1), (t.y + dy) & (w.size - 1)]; break; }
  }
  assert.ok(inside, 'a house site inside the town area');
  paint(v, w, house, ...inside!, 2);
  assert.equal(placementAllowed(w, t, house, ...inside!, v), true);
  paint(v, w, house, ...inside!, 1);
  assert.equal(placementAllowed(w, t, house, ...inside!, v), false);
  // outside the territory: refused even in sight
  const out = siteOutside(w, t, house)!;
  paint(v, w, house, ...out, 2);
  assert.equal(placementAllowed(w, t, house, ...out, v), false);
  // ghost colour equals the click test on base maps
  assert.equal(ghostAllowed(w, t, house, ...out, v), false);
  paint(v, w, house, ...inside!, 2);
  assert.equal(ghostAllowed(w, t, house, ...inside!, v), true);
});

test('the simulation executes a build command without fog or territory test (same on every peer)', { skip }, () => {
  const a = loadMission('Pimmons.mdb', 1, DATA, false).world;
  const b = loadMission('Pimmons.mdb', 1, DATA, false).world;
  const ta = a.economy.towns.find(x => x.alive)!, tb = b.economy.towns.find(x => x.id === ta.id)!;
  const ra = ready(a, ta, 50); ready(b, tb, 50);
  const [x, y] = siteOutside(a, ta, ra)!;
  // peer a has the site in explored fog, peer b has never seen it: display state only
  const va = new Vision(a.size, a.bits);
  va.update(a, ta.race, true);
  paint(va, a, ra, x, y, 1);
  for (const w of [a, b]) {
    const t = w === a ? ta : tb;
    w.schedule({ type: 'build', player: t.race, town: t.id, building: 50, x, y });
    w.step();
    assert.ok(w.entities.some(e => e.kind === Kind.Building && (e.oid & 0xffff) === 50 && cell(e)[0] === x && cell(e)[1] === y), 'mine site placed');
  }
  assert.equal(a.hash(), b.hash());
});

test('add-on harbour and shipyard outside the territory: in sight only; mine ghost island quirk', { skip: skipGold }, () => {
  const { world: w, mission: m } = loadAddonMission('AmazonsAO.mdb', 3, undefined, false);
  const t = w.economy.towns.find(x => x.alive && x.race === m.humanRace)!;
  checkFogRule(w, t, ready(w, t, 62), 'harbour');
  checkFogRule(w, t, ready(w, t, 63), 'shipyard');
  // Gold mine preview quirk: a failing mine is drawn green when the cursor is on another island
  // (or the sea); the click test still refuses
  const mine = ready(w, t, 50);
  const v = new Vision(w.size, w.bits);
  const home = w.islandAt(t.x, t.y);
  let other: [number, number] | null = null, same: [number, number] | null = null;
  for (let y = 0; y < w.size && (!other || !same); y += 2) for (let x = 0; x < w.size; x += 2) {
    if (w.logistics.canPlaceSite(t, mine, x, y)) continue;
    if (!other && w.islandAt(x, y) !== home) other = [x, y];
    if (!same && w.islandAt(x, y) === home) same = [x, y];
  }
  assert.ok(other && same);
  paint(v, w, mine, ...other!, 2);
  assert.equal(placementAllowed(w, t, mine, ...other!, v), false);
  assert.equal(ghostAllowed(w, t, mine, ...other!, v), true, 'green ghost on another island');
  paint(v, w, mine, ...same!, 2);
  assert.equal(ghostAllowed(w, t, mine, ...same!, v), false, 'red on the own island');
});
