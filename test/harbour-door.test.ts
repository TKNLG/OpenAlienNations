// Gold add-on: land units leaving a harbour or shipyard (door offset (0, 0): the entrance is the
// building's own max corner). Spec: docs/game/addon.md 3.7, docs/game/units-and-jobs.md 4.10.
// Needs the Gold Edition data folder: AN_GOLD (the tests skip when it is not set).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GOLD, HAS_GOLD, dataReader, rulesOf } from './helpers/mission.ts';
import { parseMdb, parseDvmFile, dvmLayout } from '../src/formats/mission.ts';
import { addonTerrainFromStored } from '../src/world/addon-terrain.ts';
import { World, SUB, Kind, type Entity, type WorldSetup } from '../src/engine/world.ts';

const skip = !HAS_GOLD && 'AN_GOLD data not found';
const cell = (e: Entity): [number, number] => [Math.floor(e.x / SUB), Math.floor(e.y / SUB)];

/** AmazonsAO mission 3: the Amazon shipyard and harbour on the coast (the reported scene) */
function aoWorld() {
  const read = dataReader(GOLD);
  const m = parseMdb(read('AmazonsAO.mdb')!).find(x => x.order === 3)!;
  const rules = rulesOf(GOLD, true);
  const file = parseDvmFile(read(m.mapFile)!, dvmLayout(m));
  const setup: WorldSetup = {
    races: m.races, costs: rules.inventions.map(l => l.map(i => i.cost)),
    prerequisites: rules.inventions.map(l => l.map(i => i.prerequisites)), goals: m.goals,
    weapons: rules.weapons, orders: file.extras.orders, lists: file.extras.lists, ai: false,
  };
  const w = new World(addonTerrainFromStored(file.terrain!), file.objects, rules.rules, setup);
  const h = m.humanRace;
  const own = (type: number) => w.entities.find(e => e.kind === Kind.Building && e.owner === h && (e.oid & 0xffff) === type && e.complete)!;
  return { w, h, yard: own(63), harbour: own(62) };
}

/** land units outside, by cell: every cell holding two or more */
function stacks(w: World): number[][] {
  const at = new Map<number, number[]>();
  for (const e of w.entities) {
    if (e.kind !== Kind.Unit || !e.alive || e.inside >= 0 || w.isShip(e)) continue;
    const [x, y] = cell(e), k = (y << w.bits) | x;
    const l = at.get(k);
    if (l) l.push(e.id); else at.set(k, [e.id]);
  }
  return [...at.values()].filter(l => l.length > 1);
}

/** the first `n` cells of the square spiral around (x, y) (units-and-jobs.md 4.8) that pass `ok` */
function spiralCells(w: World, x: number, y: number, n: number, ok: (x: number, y: number) => boolean): string[] {
  const out: string[] = [], m = w.size - 1;
  for (let k = 0; out.length < n && k < 24; k++) {
    const ring: [number, number][] = [];
    if (k === 0) ring.push([x, y]);
    else {
      for (let dy = -k; dy < k; dy++) ring.push([x + k, y + dy]);
      for (let dx = k; dx > -k; dx--) ring.push([x + dx, y + k]);
      for (let dy = k; dy > -k; dy--) ring.push([x - k, y + dy]);
      for (let dx = -k; dx < k; dx++) ring.push([x + dx, y - k]);
    }
    for (const [px, py] of ring) if (out.length < n && ok(px & m, py & m)) out.push(`${px & m},${py & m}`);
  }
  return out;
}

test('shipyard: porters delivering in a row come out 35 ticks after the eject, one per shore cell', { skip }, () => {
  const { w, h, yard } = aoWorld();
  assert.ok(yard, 'the Amazon shipyard');
  const r = w.rules.get(yard.oid)!;
  assert.deepEqual([r.doorDx, r.doorDy], [0, 0], 'door (0, 0)');
  assert.deepEqual(w.logistics.entrance(yard), cell(yard), 'the entrance is the max corner');
  const t = w.economy.town(yard.town)!;
  for (let g = 0; g < t.stock.length; g++) t.stock[g] = Math.max(t.stock[g], 30);
  for (const ty of [64, 64, 67, 64, 64, 67]) w.schedule({ type: 'train', player: h, building: yard.id, unit: ty });
  const ejected = new Map<number, number>(), out: { id: number; tick: number; at: [number, number]; dir: number }[] = [];
  const was = new Map<number, boolean>();
  for (let i = 0; i < 4000; i++) {
    w.step();
    for (const e of w.entities) {
      if (e.kind !== Kind.Unit || w.isShip(e)) continue;
      const inYard = e.inside === yard.id;
      if (inYard && w.logistics.leaving(e) && !ejected.has(e.id)) ejected.set(e.id, w.tick);
      if (was.get(e.id) && !inYard && e.inside < 0 && ejected.has(e.id)) {
        out.push({ id: e.id, tick: w.tick - ejected.get(e.id)!, at: cell(e), dir: e.dir });
        ejected.delete(e.id);
      }
      was.set(e.id, inYard);
    }
    assert.deepEqual(stacks(w), [], `no two units on one cell (tick ${w.tick})`);
  }
  assert.ok(out.length >= 4, `several porters delivered and left (${out.length})`);
  for (const o of out) {
    assert.equal(o.tick, 35, 'put outside at run 5, 35 ticks after the eject');
    assert.equal(o.dir, 5, 'facing 5 (door x offset 0)');
    const i = (o.at[1] << w.bits) | o.at[0];
    assert.equal(w.naval.isWater(...o.at), false, 'on land');
    assert.equal(w.buildingAt(i), false, 'not on the footprint');
  }
});

test('harbour and shipyard: units ejected together take the first free spiral cells; an idle unit there is not pushed', { skip }, () => {
  for (const which of ['harbour', 'yard'] as const) {
    const { w, h, harbour, yard } = aoWorld();
    const b = which === 'harbour' ? harbour : yard;
    assert.ok(b, which);
    const [ax, ay] = cell(b);
    const free = (x: number, y: number) => w.motion.free(x, y);
    // an idle porter on the first free cell of the spiral stays there
    const first = spiralCells(w, ax, ay, 1, free)[0].split(',').map(Number) as [number, number];
    const idle = w.spawnUnit(h, 9, first[0], first[1], b.town);
    w.step();
    const units: Entity[] = [];
    for (let k = 0; k < 4; k++) {
      const u = w.spawnInside(h, 9, b, b.town);
      units.push(u);
    }
    for (const u of units) if (!w.logistics.leaving(u)) w.logistics.leave(u);
    const expected = spiralCells(w, ax, ay, 4, free);
    const t0 = w.tick;
    for (let i = 0; i < 40; i++) {
      w.step();
      assert.deepEqual(stacks(w), [], `no two units on one cell (tick ${w.tick})`);
      if (w.tick - t0 < 35) assert.ok(units.every(u => u.inside === b.id), 'nobody out before run 5');
    }
    assert.ok(units.every(u => u.inside < 0), 'all out after 35 ticks');
    assert.deepEqual(cell(idle), first, 'the idle unit was not pushed');
    assert.deepEqual(units.map(u => cell(u).join(',')).sort(), [...expected].sort(), `${which}: the next free spiral cells`);
  }
});
