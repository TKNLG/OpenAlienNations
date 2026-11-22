// Fidelity batch 8a (November 2026): the attack job's firing-position search (combat.md 3.5), the
// town's porter list in join order (12.1), the guard's scan from the new step's cell (8.1), the
// computer player's founding site test and circle list (ai-diplomacy-trade.md 1.12), the market
// site unload (4.4), and the snapshot of a stored plan. Data-driven tests need AN_DATA.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { loadMission, DATA } from './helpers/mission.ts';
import { World, Kind, SUB, type Entity } from '../src/engine/world.ts';
import { Planner, type PlanRequest } from '../src/engine/path.ts';
import { T } from '../src/engine/economy.ts';
import { MF } from '../src/engine/trade.ts';

const skip = !existsSync(`${DATA}/dv.wdb`) && 'AN_DATA not set';
const cell = (e: Entity): [number, number] => [Math.floor(e.x / SUB), Math.floor(e.y / SUB)];

/** an open 64 x 64 grid: flat, nothing blocked, no paths, no units */
function grid(over: Partial<PlanRequest> = {}): PlanRequest {
  const n = 64 * 64;
  return {
    sx: 10, sy: 10, gx: 30, gy: 10, steps: [8, 10, 12, 14], shift: 1, mode: 0, allUnits: false,
    blocked: new Uint8Array(n), pathFlag: new Uint8Array(n), height: new Uint16Array(n), unitAt: () => false, ...over,
  };
}

test('firing-position search: one forward search that stops at the first cell passing the range test (3.5)', {}, () => {
  const p = new Planner(6);
  // a melee goal: the 8-neighbourhood of (30, 10)
  const adj = (x: number, y: number) => Math.abs(x - 30) <= 1 && Math.abs(y - 10) <= 1 && !(x === 30 && y === 10);
  const path = p.seek(grid(), adj)!;
  assert.deepEqual(path[0], [10, 10], 'the start cell comes first');
  assert.deepEqual(path[path.length - 1], [29, 10], 'the first neighbour cell reached on the straight line');
  assert.equal(path.length, 20);
  for (let i = 1; i < path.length; i++) assert.equal(Math.abs(path[i][0] - path[i - 1][0]) <= 1 && Math.abs(path[i][1] - path[i - 1][1]) <= 1, true);
  // the start itself passes: the path is the start cell alone
  assert.deepEqual(p.seek(grid(), () => true), [[10, 10]]);
  // a unit on the straight way within D < 32 of the start is an obstacle (mode 0), one farther away is not
  const u = (i: number) => i === ((10 << 6) | 14) || i === ((10 << 6) | 26);
  const around = p.seek(grid({ unitAt: u }), adj)!;
  assert.ok(!around.some(([x, y]) => x === 14 && y === 10), 'goes round the near unit');
  // nothing passes: the open list runs empty on a closed pocket, or the 2000 cap fails it
  const walls = new Uint8Array(64 * 64);
  for (let k = 8; k <= 12; k++) { walls[(8 << 6) | k] = 1; walls[(12 << 6) | k] = 1; walls[(k << 6) | 8] = 1; walls[(k << 6) | 12] = 1; }
  assert.equal(p.seek(grid({ blocked: walls }), adj), null);
  assert.equal(p.seek(grid(), () => false), null);
  assert.ok(p.iterations > 2000);
});

test('worn paths do not draw the firing-position search (path shift 1, 3.5)', {}, () => {
  const p = new Planner(6);
  const pathFlag = new Uint8Array(64 * 64);
  // a paved detour one row below the straight line
  for (let x = 10; x <= 30; x++) pathFlag[(11 << 6) | x] = 1;
  const adj = (x: number, y: number) => Math.abs(x - 30) <= 1 && Math.abs(y - 10) <= 1 && !(x === 30 && y === 10);
  const path = p.seek(grid({ pathFlag }), adj)!;
  assert.ok(path.every(([, y]) => y === 10), 'the straight way, as on open ground');
});

test('porter list: join order, a retyped unit goes to the end (12.1, 12.4)', { skip }, () => {
  const { world: w } = loadMission('Pimmons.mdb', 4, DATA, false);
  const t = w.economy.towns.find(x => x.race === 1)!;
  const list = () => w.economy.porterList(t, w.entities, id => w.get(id)).map(e => e.id);
  const before = list();
  assert.ok(before.length >= 2);
  const first = w.get(before[0])!;
  w.economy.changeType(first, ((1 << 16) | T.Criminal) >>> 0);
  assert.ok(!list().includes(first.id), 'a criminal is not a porter');
  w.economy.changeType(first, ((1 << 16) | T.Porter) >>> 0);
  const after = list();
  assert.equal(after[after.length - 1], first.id, 'the released prisoner is the newest porter');
  assert.deepEqual(after.slice(0, -1), before.slice(1));
  // the list survives a save and a version-23 save starts from entity order
  const snap = JSON.parse(JSON.stringify(w.snapshot()));
  const tr = w.terrain;
  const fresh = () => ({ ...tr, height: tr.height.slice(), cls: tr.cls.slice(), tile: tr.tile.slice() });
  const r = World.restore(fresh(), snap, w.rules, w.weapons);
  assert.deepEqual(r.economy.towns[t.id].porters, after);
  const old = JSON.parse(JSON.stringify(snap)); old.v = 23;
  const o = World.restore(fresh(), old, w.rules, w.weapons);
  assert.equal(o.economy.towns[t.id].porters[0], before[0], 'entity order');
});

test('attack plan: the stored path survives a save; a version-23 plan is dropped (3.3.1, 3.5)', { skip }, () => {
  const { world: w, mission: m } = loadMission('Pimmons.mdb', 7, DATA, false);
  const me = m.humanRace;
  const enemy = m.races.find(r => r.present && r.race !== me)!.race;
  const t = w.economy.towns.find(x => x.race === me)!;
  const et = w.economy.towns.find(x => x.race === enemy)!;
  const a = w.spawnUnit(me, 30, t.x + 20, t.y + 20, t.id);
  const v = w.spawnUnit(enemy, 9, t.x + 28, t.y + 20, et.id);
  w.schedule({ type: 'order', player: me, ids: [a.id], target: v.id });
  let j = undefined as ReturnType<typeof w.sched.get>;
  for (let i = 0; i < 20; i++) {
    w.step();
    j = a.job ? w.sched.get(a.job) : undefined;
    if (j && j.data.length > 12) break;
  }
  assert.ok(j && j.kind === 0x08 && j.data.length > 12, 'a stored plan with its path behind the state');
  const tr = w.terrain;
  const fresh = () => ({ ...tr, height: tr.height.slice(), cls: tr.cls.slice(), tile: tr.tile.slice() });
  const snap = JSON.parse(JSON.stringify(w.snapshot()));
  const r = World.restore(fresh(), snap, w.rules, w.weapons);
  assert.equal(r.hash(), w.hash());
  for (let i = 0; i < 40; i++) { w.step(); r.step(); }
  assert.equal(r.hash(), w.hash());
  const old = JSON.parse(JSON.stringify(snap)); old.v = 23;
  const o = World.restore(fresh(), old, w.rules, w.weapons);
  const oj = o.sched.get(j!.id)!;
  assert.equal(oj.data.length, 12);
  assert.equal(oj.data[7], 0, 'plan dropped');
  assert.ok(cell(a));
});

test('computer founding: the circle list is the outline of the town-hall radius (1.12)', { skip }, () => {
  const { world: w } = loadMission('Pimmons.mdb', 4, DATA, false);
  const circle = (w.ai as unknown as { hallCircle(race: number): [number, number][] }).hallCircle(1);
  assert.equal(circle.length, 140);
  assert.deepEqual(circle.slice(0, 4), [[25, 0], [-25, 0], [0, -25], [0, 25]]);
  for (const [dx, dy] of circle) {
    const r = Math.sqrt(dx * dx + dy * dy);
    assert.ok(r > 23.5 && r < 25.5, `(${dx}, ${dy}) lies on the outline`);
  }
});

test('a foreign merchant unloads into a market site\'s own goods slots (4.4)', { skip }, () => {
  const { world: w } = loadMission('Pimmons.mdb', 4, DATA, false);
  const t = w.economy.towns.find(x => x.race === 1)!;
  const other = w.economy.towns.find(x => x.race !== 1) ?? t;
  const site = w.spawn({ cls: 1, group: 1, type: 48, owner: t.mapId, x: t.x + 6, y: t.y + 6, z: 0 });
  site.town = t.id; site.complete = false;
  const u = w.spawnUnit(other.race, 28, t.x + 8, t.y + 8, other.id);
  u.carryGood = 3; u.carryAmount = 4;
  const g = 3;
  // M buys the good with room for it
  w.trade.set(t.id, g, MF.Buy, 1);
  w.trade.set(t.id, g, MF.MaxStock, t.stock[g] + 10);
  const stock = t.stock[g];
  const local = site.local[g] ?? 0;
  w.trade.exchange(u, t, other, false, site);
  assert.equal(t.stock[g], stock, 'the town stock does not change');
  assert.ok((site.local[g] ?? 0) > local, 'the site took the goods');
  assert.equal(Kind.Building, site.kind);
});
