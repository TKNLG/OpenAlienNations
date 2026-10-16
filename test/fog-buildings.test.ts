// Which buildings lift the fog of war, and when. Spec: docs/game/fog-of-war.md 3.1 (sources,
// activation, anchor-cell discs) and 13 (seen flags come from new discs, on any footprint cell).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { SUB, type World, type Entity } from '../src/engine/world.ts';
import type { Town } from '../src/engine/economy.ts';
import type { ObjectRule } from '../src/formats/odb.ts';
import { loadMission, loadAddonMission, DATA, GOLD, HAS_GOLD } from './helpers/mission.ts';
import { Vision } from '../src/client/vision.ts';

const skip = !existsSync(`${DATA}/dv.odb`) && 'AN_DATA not set';
const skipGold = !HAS_GOLD && 'AN_GOLD data not found';
const PORTER = 9, MINER = 27, MINE = 50, HARBOUR = 62, SHIPYARD = 63;

const cell = (e: Entity): [number, number] => [Math.floor(e.x / SUB), Math.floor(e.y / SUB)];
/** the rule of a type for a race, its invention researched (the build menu allows it) */
function rule(w: World, race: number, type: number): ObjectRule {
  const r = w.rules.get(((race << 16) | type) >>> 0)!;
  const p = w.economy.players[race];
  if (p && r.invention >= 0) p.progress[r.invention] = p.costs[r.invention];
  return r;
}
const idx = (w: World, x: number, y: number) => ((y & (w.size - 1)) << w.bits) | (x & (w.size - 1));

/** cells of the vision disc of radius r around (x, y): dx^2 + dy^2 < r^2, wrapped (fog-of-war.md 2) */
function disc(w: World, x: number, y: number, r: number): Set<number> {
  const out = new Set<number>();
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy < r * r) out.add(idx(w, x + dx, y + dy));
  return out;
}

/** the cells that turned visible between two snapshots of the visible layer */
function gained(before: Uint8Array, after: Uint8Array): Set<number> {
  const out = new Set<number>();
  for (let i = 0; i < after.length; i++) if (after[i] && !before[i]) out.add(i);
  return out;
}

/** a site for `r` whose anchor lies in [dmin, dmax] cells (Chebyshev) of (cx, cy), out of sight */
function siteNear(w: World, t: Town, r: ObjectRule, cx: number, cy: number, dmin: number, dmax: number, v?: Vision): [number, number] | null {
  for (let d = dmin; d <= dmax; d++) for (let dy = -d; dy <= d; dy++) for (let dx = -d; dx <= d; dx++) {
    if (Math.max(Math.abs(dx), Math.abs(dy)) !== d) continue;
    const x = (cx + dx) & (w.size - 1), y = (cy + dy) & (w.size - 1);
    if (v && v.visible[idx(w, x, y)]) continue;
    if (w.logistics.canPlaceSite(t, r, x, y)) return [x, y];
  }
  return null;
}

/** first site outside every territory where the simulation's site rule passes */
function siteOutside(w: World, t: Town, r: ObjectRule): [number, number] | null {
  for (let y = 0; y < w.size; y++) for (let x = 0; x < w.size; x++) {
    if (w.territory.ownerAt(x, y) !== -1) continue;
    if (w.logistics.canPlaceSite(t, r, x, y)) return [x, y];
  }
  return null;
}

test('mine (radius 8): a site sees nothing, completion only explores, the miner inside lights the disc', { skip }, () => {
  const { world: w, mission: m } = loadMission('Pimmons.mdb', 1, DATA, false);
  const t = w.economy.towns.find(x => x.alive && x.race === m.humanRace)!, me = t.race;
  const r = rule(w, me, MINE);
  assert.equal(r.radius, 8);
  const site = siteOutside(w, t, r)!;
  assert.ok(site, 'a mine site outside the territory');
  const v = new Vision(w.size, w.bits);
  v.update(w, me, true);
  const before = v.visible.slice(), exploredBefore = v.explored.slice();
  const b = w.logistics.placeBuilding(t, MINE, ...site)!;
  const [ax, ay] = cell(b);
  v.update(w, me, true);
  assert.deepEqual(v.visible, before, 'a construction site gives no vision');
  w.logistics.complete(b);
  assert.equal(b.active, false, 'waits for its miner');
  v.update(w, me, true);
  assert.deepEqual(v.visible, before, 'completed without its miner: not in sight');
  for (const i of disc(w, ax, ay, 8)) assert.equal(v.explored[i], 1, 'completion explores the 8-disc');
  assert.equal(v.explored[idx(w, ax + 8, ay)], exploredBefore[idx(w, ax + 8, ay)], 'r - 1 cells along the axis');
  // the miner enters: active, the disc around the anchor (max corner) is in sight
  const miner = w.spawnUnit(me, MINER, ax + 1, ay + 1, t.id);
  w.motion.vacate(miner); w.putInside(miner, b); w.logistics.unitEntered(miner, b);
  assert.equal(b.active, true);
  v.update(w, me, true);
  const lit = gained(before, v.visible), d = disc(w, ax, ay, 8);
  assert.equal(d.size, 193);
  for (const i of d) assert.equal(v.visible[i], 1);
  for (const i of lit) assert.ok(d.has(i), 'nothing outside the disc');
  assert.equal(v.cellVisible(ax + 7, ay), true);
  // deactivated: the disc is gone, the explored state stays
  w.logistics.deactivateBuilding(b);
  v.update(w, me, true);
  assert.deepEqual(v.visible, before);
  assert.equal(v.explored[idx(w, ax + 7, ay)], 1);
});

test('radius-0 buildings never see: a completed, active house adds nothing', { skip }, () => {
  const { world: w, mission: m } = loadMission('Pimmons.mdb', 1, DATA, false);
  const t = w.economy.towns.find(x => x.alive && x.race === m.humanRace)!, me = t.race;
  const r = rule(w, me, 37);
  assert.equal(r.radius, 0);
  assert.equal(r.operator, -1);
  const site = siteNear(w, t, r, t.x, t.y, 4, 30)!;
  const v = new Vision(w.size, w.bits);
  v.update(w, me, true);
  const vis = v.visible.slice(), ex = v.explored.slice();
  const b = w.logistics.placeBuilding(t, 37, ...site)!;
  w.logistics.complete(b);
  assert.equal(b.active, true, 'no operator: active at completion');
  v.update(w, me, true);
  assert.deepEqual(v.visible, vis);
  assert.deepEqual(v.explored, ex);
});

test('seen comes from new discs: a site inside a standing disc stays unseen until a unit moves in; any footprint cell counts', { skip }, () => {
  const { world: w, mission: m } = loadMission('Pimmons.mdb', 1, DATA, false);
  const t = w.economy.towns.find(x => x.alive && x.race === m.humanRace)!, me = t.race;
  const mine = w.logistics.placeBuilding(t, MINE, ...siteOutside(w, t, rule(w, me, MINE))!)!;
  w.logistics.complete(mine);
  const miner = w.spawnUnit(me, MINER, ...cell(mine), t.id);
  w.motion.vacate(miner); w.putInside(miner, mine); w.logistics.unitEntered(miner, mine);
  const v = new Vision(w.size, w.bits);
  v.update(w, me, true);
  // a house site inside the mine's standing disc: in sight, but not "seen" (5.2 quirk)
  const house = rule(w, me, 37);
  const [mx, my] = cell(mine);
  const hs = siteNear(w, t, house, mx, my, 3, 5)!;
  assert.ok(hs, 'a house site inside the mine disc');
  const h = w.logistics.placeBuilding(t, 37, ...hs)!;
  v.update(w, me, true);
  assert.equal(v.cellInSight(...hs), true);
  assert.equal(v.seen.has(h.id), false, 'no new disc covered it');
  assert.equal(v.drawState(h, house), 2, 'drawn while in sight');
  // a porter steps in: its new disc marks the site seen
  const p = w.spawnUnit(me, PORTER, hs[0] + 2, hs[1], t.id);
  p.x = (hs[0] + 2) * SUB + SUB / 2; p.y = hs[1] * SUB + SUB / 2;
  v.update(w, me, true);
  assert.equal(v.seen.has(h.id), true);
  // footprint: a disc touching only the minimum corner of a building marks it seen
  const fx = Math.max(1, house.sizeX);
  assert.ok(fx >= 2, 'a house at least 2 cells wide');
  const far = siteNear(w, t, house, mx + 60, my + 60, 0, 60, v)!;
  assert.ok(far, 'a house site out of sight');
  const h2 = w.logistics.placeBuilding(t, 37, ...far)!;
  v.update(w, me, true);
  assert.equal(v.seen.has(h2.id), false);
  // porter radius 5 reaches 4 cells: at (minX - 4, anchor y) it covers footprint column minX, not the anchor
  const minX = far[0] - fx + 1;
  p.x = (minX - 4) * SUB + SUB / 2; p.y = far[1] * SUB + SUB / 2;
  v.update(w, me, true);
  assert.equal(v.cellInSight(minX, far[1]), true);
  assert.equal(v.cellInSight(far[0], far[1]), false, 'the anchor stays out of sight');
  assert.equal(v.seen.has(h2.id), true, 'a footprint cell under a new disc');
});

test('add-on harbour sees radius 6 from completion; the shipyard (radius 0) never lifts fog', { skip: skipGold }, () => {
  for (const type of [HARBOUR, SHIPYARD]) {
    const { world: w, mission: m } = loadAddonMission('AmazonsAO.mdb', 3, GOLD, false);
    const me = m.humanRace;
    const t = w.economy.towns.find(x => x.race === me && x.alive)!;
    const r = rule(w, me, type);
    assert.equal(r.radius, type === HARBOUR ? 6 : 0);
    assert.equal(r.operator, -1);
    let site: [number, number] | null = null;
    for (let dy = -40; dy <= 40 && !site; dy++) for (let dx = -40; dx <= 40; dx++) {
      const x = (t.x + dx) & (w.size - 1), y = (t.y + dy) & (w.size - 1);
      if (w.logistics.canPlaceSite(t, r, x, y)) { site = [x, y]; break; }
    }
    assert.ok(site, 'a shore site');
    const v = new Vision(w.size, w.bits);
    v.update(w, me, true);
    const vis = v.visible.slice(), ex = v.explored.slice();
    const b = w.logistics.placeBuilding(t, type, ...site!)!;
    v.update(w, me, true);
    assert.deepEqual(v.visible, vis, 'a site gives no vision');
    w.logistics.complete(b);
    assert.equal(b.active, true, 'no operator: active at completion');
    v.update(w, me, true);
    const [ax, ay] = cell(b);
    if (type === SHIPYARD) {
      assert.deepEqual(v.visible, vis, 'the shipyard sees nothing');
      assert.deepEqual(v.explored, ex, 'and its completion explores nothing');
    } else {
      const d = disc(w, ax, ay, 6);
      assert.equal(d.size, 109);
      for (const i of d) assert.equal(v.visible[i], 1, 'the harbour disc around its anchor is in sight');
      for (const i of gained(vis, v.visible)) assert.ok(d.has(i));
      assert.equal(v.cellVisible(ax + 5, ay), true);
      assert.equal(v.cellVisible(ax - 5, ay), true);
      w.logistics.deactivateBuilding(b);
      v.update(w, me, true);
      assert.deepEqual(v.visible, vis, 'inactive: no disc');
    }
  }
});
