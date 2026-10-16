// Unit motion: facing numbering, turning, step timing, one unit per cell, stepping aside, work
// positions, idle fidgets, animals, snapshots. Spec: docs/game/units-and-jobs.md 4.1, 4.6-4.9, 7.7;
// docs/rendering/unit-motion.md 1-4. The first tests need no game data.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { World, SUB, Kind, Action, type Entity } from '../src/engine/world.ts';
import { DIR_STEP, dirToward, turnOnce, turnStep } from '../src/engine/path.ts';
import { MJ, WS, WalkResult } from '../src/engine/motion.ts';
import type { ObjectRule } from '../src/formats/odb.ts';
import type { Terrain } from '../src/world/terrain.ts';
import type { MapObject } from '../src/formats/mission.ts';
import { loadMission, DATA } from './helpers/mission.ts';

function flatTerrain(bits: number): Terrain {
  const n = 1 << bits;
  return { sizeBits: bits, size: n, height: new Uint16Array(n * n).fill(128), cls: new Uint8Array(n * n), tile: new Uint8Array(n * n) };
}
const porter = (x: number, y: number, race = 0): MapObject => ({ cls: 0, group: race, type: 9, owner: 1, x, y, z: 0 });
const cell = (e: Entity): [number, number] => [Math.floor(e.x / SUB), Math.floor(e.y / SUB)];
const world = (objs: MapObject[], rules = new Map<number, ObjectRule>()) => new World(flatTerrain(6), objs, rules);
/** run until pred holds (max n ticks); returns the tick count used */
function until(w: World, pred: () => boolean, n = 2000): number {
  let i = 0;
  while (i < n && !pred()) { w.step(); i++; }
  return i;
}

// ---------------------------------------------------------------- facing (unit-motion.md 1)

test('facing numbering follows the spec table: clockwise on screen from up', {}, () => {
  // facing: grid step (dx, dy) (units-and-jobs.md 2, unit-motion.md 1.1)
  const table: [number, number][] = [[-1, -1], [-1, 0], [-1, 1], [0, 1], [1, 1], [1, 0], [1, -1], [0, -1]];
  assert.deepEqual(DIR_STEP, table);
  table.forEach(([dx, dy], d) => assert.equal(dirToward(dx, dy), d, `step ${dx},${dy}`));
  // screen direction: x right = (y - x) * 32, y down = (x + y) * 22 (world-projection.md)
  const screen = (d: number) => { const [dx, dy] = DIR_STEP[d]; return [(dy - dx) * 32, (dx + dy) * 22]; };
  assert.deepEqual(screen(0), [0, -44], '0 up');
  assert.deepEqual(screen(2), [64, 0], '2 right');
  assert.deepEqual(screen(4), [0, 44], '4 down');
  assert.deepEqual(screen(6), [-64, 0], '6 left');
  for (let d = 0; d < 8; d++) {   // clockwise: the cross product of consecutive directions is positive (screen y down)
    const [ax, ay] = screen(d), [bx, by] = screen((d + 1) % 8);
    assert.ok(ax * by - ay * bx > 0, `clockwise ${d} -> ${d + 1}`);
  }
  // builder spots (4.8): -x side faces 5, +x side 1, +y side 7, -y side 3, each toward the footprint
  assert.equal(dirToward(1, 0), 5); assert.equal(dirToward(-1, 0), 1);
  assert.equal(dirToward(0, -1), 7); assert.equal(dirToward(0, 1), 3);
});

test('direction toward a target uses 1:2 sectors in grid space; no delta keeps the facing', {}, () => {
  assert.equal(dirToward(0, 0), -1);
  assert.equal(dirToward(1, 2), 3, '|dy| >= 2|dx|');
  assert.equal(dirToward(-1, -2), 7);
  assert.equal(dirToward(2, 1), 5, '2|dy| <= |dx|');
  assert.equal(dirToward(-2, 1), 1);
  assert.equal(dirToward(2, 3), 4, 'diagonal sector');
  assert.equal(dirToward(-3, 2), 2);
  assert.equal(dirToward(-3, -2), 0);
  assert.equal(dirToward(3, -2), 6);
  assert.equal(dirToward(5, 9), 4, '9 < 10: still diagonal');
  assert.equal(dirToward(5, 10), 3);
});

test('turning: 45 degrees free, more costs one call per 45 degrees; 180 degrees counts by the spec rule', {}, () => {
  assert.deepEqual(turnOnce(2, 2), { dir: 2, cost: false });
  assert.deepEqual(turnOnce(2, 3), { dir: 3, cost: false });
  assert.deepEqual(turnOnce(0, 7), { dir: 7, cost: false });
  assert.deepEqual(turnOnce(0, 2), { dir: 1, cost: true });
  assert.deepEqual(turnOnce(1, 6), { dir: 0, cost: true }, 'short way round');
  // exactly 180: down when target > current, up when target < current (unit-motion.md 1.3)
  assert.deepEqual(turnOnce(0, 4), { dir: 7, cost: true });
  assert.deepEqual(turnOnce(5, 1), { dir: 6, cost: true });
  // the strike turn steps 45 degrees per call with the same direction rule (combat.md 4.1)
  assert.equal(turnStep(0, 4), 7); assert.equal(turnStep(6, 2), 7); assert.equal(turnStep(3, 4), 4);
});

test('turn delays before steps: 45 free, 90 one tick, 180 three ticks', {}, () => {
  // a porter at (10,10) walks east (+x, facing 5) with different start facings
  const firstStep = (dir: number) => {
    const w = world([porter(10, 10)]);
    const u = w.get(1)!;
    u.dir = dir;
    w.schedule({ type: 'move', player: 0, ids: [1], x: 15, y: 10 });
    until(w, () => u.stepStart > 0, 50);
    return u.stepStart;
  };
  const base = firstStep(4);       // 45 degrees off: free
  assert.equal(firstStep(5), base, 'already facing');
  assert.equal(firstStep(3), base + 1, '90 degrees');
  assert.equal(firstStep(2), base + 2, '135 degrees');
  assert.equal(firstStep(1), base + 3, '180 degrees');
  assert.equal(base, 1 + 3, 'the command applies on the next tick, the first step 3 ticks after planning');
});

test('a step moves the simulation position at once; the display gets start tick and duration D', {}, () => {
  const w = world([porter(10, 10)]);
  const u = w.get(1)!;
  u.dir = 5;
  u.dir = 4;
  w.schedule({ type: 'move', player: 0, ids: [1], x: 11, y: 11 });
  until(w, () => u.stepStart > 0, 50);
  const t0 = w.tick;
  // flat ground, default step time 5: diagonal floor(1.5 * 5) + 1 = 8, straight 5 + 1 = 6 (4.1)
  assert.deepEqual(cell(u), [11, 11]);
  assert.equal(u.x, 11 * SUB + SUB / 2, 'whole cell, no in-between position');
  assert.equal(u.stepStart, t0); assert.equal(u.stepTicks, 8);
  assert.equal(u.stepFromX, 10 * SUB + SUB / 2); assert.equal(u.stepFromY, 10 * SUB + SUB / 2);
  assert.equal(u.action, Action.Walk);
  for (let i = 0; i < 7; i++) { w.step(); assert.ok(u.path, 'the walk lasts D ticks'); }
  w.step();
  assert.equal(u.path, null, 'the walk ends D ticks after its last step started');
  assert.equal(w.tick, t0 + 8);
  assert.equal(u.action, Action.Idle);
  // a straight step: D = 6, and no further step comes before D ticks
  w.schedule({ type: 'move', player: 0, ids: [1], x: 11, y: 13 });
  until(w, () => u.stepStart > t0, 50);
  const t1 = w.tick;
  assert.deepEqual(cell(u), [11, 12]); assert.equal(u.stepTicks, 6);
  for (let i = 0; i < 5; i++) { w.step(); assert.deepEqual(cell(u), [11, 12]); }
  w.step();
  assert.deepEqual(cell(u), [11, 13]); assert.equal(u.stepStart, t1 + 6);
});

test('the end of a walk does not cut a strike begun during its last step', {}, () => {
  const w = world([porter(10, 10)]);
  const u = w.get(1)!;
  u.dir = 5;
  w.schedule({ type: 'move', player: 0, ids: [1], x: 11, y: 10 });
  until(w, () => u.stepStart > 0, 50);
  u.action = Action.Fight; u.actionTick = w.tick + 1;   // a strike starts while the step is under way
  until(w, () => !u.path, 20);
  assert.equal(u.action, Action.Fight, 'the strike keeps playing (unit-motion.md 3)');
});

// ---------------------------------------------------------------- occupancy (4.7)

test('one unit per cell: an idle blocker steps aside (job 0x0F), the walker squeezes past', {}, () => {
  const w = world([porter(10, 10), porter(14, 10)]);
  const walker = w.get(1)!, idle = w.get(2)!;
  walker.dir = 5;
  w.schedule({ type: 'move', player: 0, ids: [1], x: 18, y: 10 });
  let pushed = false, squeezed = false;
  for (let i = 0; i < 300; i++) {
    w.step();
    assert.ok(cell(walker).join() !== cell(idle).join(), `tick ${w.tick}: never on the same cell`);
    if (idle.job && w.sched.get(idle.job)?.kind === MJ.StepAside) pushed = true;
    if (walker.walkState === WS.Squeeze) squeezed = true;
  }
  assert.ok(pushed, 'the idle unit got a step-aside job');
  assert.ok(squeezed, 'the walker waited for it');
  assert.deepEqual(cell(walker), [18, 10], 'the walker arrived');
  assert.equal(idle.job, 0, 'the pushed unit ends idle');
  const [ix, iy] = cell(idle);
  assert.ok(!(ix === 14 && iy === 10), 'it left its cell');
  // it moved to a cell next to its old one that was not a neighbour of the walker at (13,10)
  assert.ok(Math.max(Math.abs(ix - 14), Math.abs(iy - 10)) === 1 && Math.max(Math.abs(ix - 13), Math.abs(iy - 10)) > 1);
});

test('step aside chains: a pushed unit with no free cell pushes the next idle unit', {}, () => {
  // a corridor along y = 10 (water elsewhere) with a pocket at (11,11), (11,12): the walker comes from
  // x = 5; B on the corridor at (10,10) can only go to the pocket's first cell, where C stands, so it
  // pushes C on to (11,12)
  const t = flatTerrain(6);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) if (y !== 10 && !(x === 11 && (y === 11 || y === 12))) t.cls[(y << 6) | x] = 11;
  const w = new World(t, [porter(5, 10), porter(10, 10), porter(11, 11)]);
  const a = w.get(1)!;
  a.dir = 5;
  w.schedule({ type: 'move', player: 0, ids: [1], x: 20, y: 10 });
  const seen = new Set<number>();
  for (let i = 0; i < 600 && cell(a)[0] !== 20; i++) {
    w.step();
    for (const id of [2, 3]) { const v = w.get(id)!; if (v.job && w.sched.get(v.job)?.kind === MJ.StepAside) seen.add(id); }
    const cells = [1, 2, 3].map(id => cell(w.get(id)!).join());
    assert.equal(new Set(cells).size, 3, `tick ${w.tick}: one unit per cell`);
  }
  assert.ok(seen.has(2), 'the first idle unit was pushed');
  assert.ok(seen.has(3), 'and pushed the second one on');
  assert.deepEqual(cell(a), [20, 10], 'the walker got through');
  assert.deepEqual(cell(w.get(2)!), [11, 11]); assert.deepEqual(cell(w.get(3)!), [11, 12]);
});

test('a busy blocker on the goal: re-plan, and the arrival tolerance stops the walker next to it', {}, () => {
  const w = world([porter(10, 10), porter(15, 10)]);
  const walker = w.get(1)!, busy = w.get(2)!;
  busy.job = w.sched.create(0x7f, busy.id, 599).id;   // any job: not idle, not walking
  walker.dir = 5;
  w.schedule({ type: 'move', player: 0, ids: [1], x: 15, y: 10 });
  until(w, () => w.tick > 2 && !walker.path, 300);
  assert.deepEqual(cell(walker), [14, 10]);
  assert.equal(walker.walkResult, WalkResult.Near);
  assert.deepEqual(cell(busy), [15, 10], 'a busy unit is never pushed');
});

test('a walker waits for a moving blocker instead of planning round it', {}, () => {
  // two units walk the same way, one cell apart: the follower never re-plans
  const w = world([porter(10, 10), porter(11, 10)]);
  const f = w.get(1)!, l = w.get(2)!;
  f.dir = 5; l.dir = 5;
  w.schedule({ type: 'move', player: 0, ids: [2], x: 20, y: 10 });
  w.schedule({ type: 'move', player: 0, ids: [1], x: 19, y: 10 });
  until(w, () => !f.path && !l.path && w.tick > 5, 400);
  assert.deepEqual(cell(l), [20, 10]);
  assert.deepEqual(cell(f), [19, 10]);
  assert.equal(f.plans, 1, 'no re-plan');
});

test('nature objects block their cell: bushes, crops and animals alike', {}, () => {
  const rules = new Map<number, ObjectRule>();
  const rule = (type: number, cls: number) => rules.set((6 << 16) | type, { id: (6 << 16) | type, group: 6, kind: 2, type, cls, stepTime: [5, 6, 7, 8], hp: 10, amount: 5, product: 4 } as ObjectRule);
  rule(1, 9); rule(17, 10); rule(33, 7);
  const w = world([{ cls: 2, group: 6, type: 1, owner: -1, x: 3, y: 3, z: 0 }, { cls: 2, group: 6, type: 17, owner: -1, x: 4, y: 3, z: 0 },
    { cls: 2, group: 6, type: 33, owner: -1, x: 5, y: 3, z: 0 }], rules);
  for (const x of [3, 4, 5]) assert.equal(w.blocked[(3 << 6) | x], 1, `cell ${x},3`);
});

// ---------------------------------------------------------------- idle fidget (4.9) and animals (7.7)

test('fidget command: only idle units; turns with delays, then plays the idle action; carriers only turn', {}, () => {
  const w = world([porter(10, 10), porter(20, 20), porter(30, 30)]);
  const a = w.get(1)!, busy = w.get(2)!, carrier = w.get(3)!;
  a.dir = 7;
  busy.job = w.sched.create(0x7f, busy.id, 599).id;
  carrier.carryGood = 1; carrier.carryAmount = 1; carrier.dir = 3;
  w.schedule({ type: 'fidget', player: 1, unit: 1, dir: 3, play: true });   // any player (no owner test)
  w.schedule({ type: 'fidget', player: 0, unit: 2, dir: 0, play: true });
  w.schedule({ type: 'fidget', player: 0, unit: 3, dir: 5, play: true });
  w.schedule({ type: 'fidget', player: 0, unit: 1, dir: 9, play: true });   // invalid direction: ignored
  w.step();
  assert.equal(w.sched.get(a.job)?.kind, MJ.TurnIdle, 'job 0x1F');
  assert.equal(w.sched.get(busy.job)?.kind, 0x7f, 'a unit with a job ignores it');
  // 7 -> 3 is 180 degrees: three costed calls (7 > 3 counts up: 0, 1, 2), then the last 45 for free
  const dirs: number[] = [];
  for (let i = 0; i < 6; i++) { w.step(); dirs.push(a.dir); }
  assert.deepEqual(dirs, [0, 1, 2, 3, 3, 3]);
  assert.equal(a.job, 0, 'the job ends after the turn');
  assert.equal(a.action, Action.Idle);
  assert.equal(a.idleTick, a.actionTick, 'idle animation started');
  assert.equal(a.idleLoops, 0, 'one cycle');
  assert.equal(carrier.dir, 5);
  assert.equal(carrier.idleTick, -1, 'a carrying unit only turns');
  // a walking unit ignores it too
  w.schedule({ type: 'move', player: 0, ids: [1], x: 40, y: 10 });
  w.step();
  w.schedule({ type: 'fidget', player: 0, unit: 1, dir: 0, play: false });
  w.step();
  assert.equal(a.job, 0);
  // the next step cuts the idle animation
  until(w, () => a.stepStart > 0 && a.stepStart >= a.idleTick, 50);
  assert.equal(a.idleTick, -1);
});

test('animals: idle mode turns to 3 and plays ID3 eleven times, wander goals avoid occupied cells', {}, () => {
  const rules = new Map<number, ObjectRule>();
  rules.set((6 << 16) | 33, { id: (6 << 16) | 33, group: 6, kind: 2, type: 33, cls: 7, stepTime: [5, 6, 7, 8], hp: 10, amount: 4, product: 4 } as ObjectRule);
  const w = world([{ cls: 2, group: 6, type: 33, owner: -1, x: 20, y: 20, z: 0 }], rules);
  const a = w.get(1)!;
  let idled = false;
  for (let i = 0; i < 4000 && !idled; i++) {
    w.step();
    assert.equal(w.blocked[((a.y >> 8) << 6) | (a.x >> 8)], 1, 'the animal blocks its cell');
    if (a.idleTick === w.tick) {
      idled = true;
      assert.equal(a.dir, 3); assert.equal(a.idleLoops, 10);
      const at = cell(a);
      for (let k = 0; k < 49; k++) { w.step(); assert.deepEqual(cell(a), at, 'waits 50 ticks'); }
    }
  }
  assert.ok(idled);
});

// ---------------------------------------------------------------- snapshots

test('snapshot / restore mid-walk, mid-squeeze and mid-fidget continues identically', {}, () => {
  const make = () => {
    const w = world([porter(10, 10), porter(14, 10), porter(30, 30), porter(31, 30)]);
    w.get(1)!.dir = 5;
    w.schedule({ type: 'move', player: 0, ids: [1], x: 18, y: 10 }, 1);
    w.schedule({ type: 'fidget', player: 0, unit: 3, dir: 7, play: true }, 1);
    w.schedule({ type: 'move', player: 0, ids: [4], x: 30, y: 40 }, 2);
    return w;
  };
  for (const at of [20, 36, 40, 45]) {
    const a = make();
    for (let i = 0; i < at; i++) a.step();
    const b = World.restore(flatTerrain(6), JSON.parse(JSON.stringify(a.snapshot())));
    assert.equal(b.hash(), a.hash(), `restored at ${at}`);
    for (let i = 0; i < 200; i++) { a.step(); b.step(); assert.equal(b.hash(), a.hash(), `tick ${a.tick}`); }
  }
});

test('a version 3 save (units between cells) is migrated onto whole cells', {}, () => {
  const w = world([porter(10, 10)]);
  const snap = JSON.parse(JSON.stringify(w.snapshot()));
  snap.v = 3;
  const e = snap.entities[0];
  for (const k of ['stepStart', 'moveAt', 'goalX', 'goalY', 'walkNodes', 'plans', 'walkState', 'squeeze', 'pushes', 'walkResult', 'idleTick', 'idleLoops']) delete e[k];
  Object.assign(e, { x: 10 * SUB + 200, y: 10 * SUB + 128, path: [[11, 10], [12, 10]], stepFromX: 10 * SUB + 128, stepFromY: 10 * SUB + 128, stepT: 3, stepTicks: 6 });
  const r = World.restore(flatTerrain(6), snap);
  const u = r.get(1)!;
  assert.deepEqual(cell(u), [11, 10]);
  assert.equal(u.x, 11 * SUB + SUB / 2);
  until(r, () => !u.path, 50);
  assert.deepEqual(cell(u), [12, 10]);
});

// ---------------------------------------------------------------- work positions on a real mission (4.8)

const skip = !existsSync(`${DATA}/dv.odb`) && 'AN_DATA not set';

test('woodcutters spread round one tree: each works from its own cell next to it', { skip }, () => {
  const { world: w, mission: m } = loadMission('Pimmons.mdb', 0);
  const me = m.humanRace, t = w.economy.towns.find(x => x.race === me)!;
  const tree = w.entities.filter(e => e.kind === Kind.Nature && w.rules.get(e.oid)?.cls === 8)
    .sort((a, b) => w.logistics.dist(a.x >> 8, a.y >> 8, t.x, t.y) - w.logistics.dist(b.x >> 8, b.y >> 8, t.x, t.y))[0];
  const cutters: Entity[] = [];
  for (let k = 0; k < 3; k++) { const u = w.spawnUnit(me, 19, t.x + 2 + k, t.y + 3, t.id); w.economy.joinTown(u, t); cutters.push(u); }
  w.schedule({ type: 'order', player: me, ids: cutters.map(u => u.id), target: tree.id });
  const at = new Map<number, [number, number]>();
  for (let i = 0; i < 1500 && at.size < 3; i++) {
    w.step();
    for (const u of cutters) if (!at.has(u.id) && u.action === Action.Work) at.set(u.id, cell(u));
  }
  assert.equal(at.size, 3, 'all three work');
  const [tx, ty] = cell(tree);
  const cells = [...at.values()];
  assert.equal(new Set(cells.map(c => c.join())).size, 3, `distinct cells ${JSON.stringify(cells)}`);
  for (const [x, y] of cells) {
    assert.ok(Math.max(Math.abs(x - tx), Math.abs(y - ty)) === 1, `next to the tree at ${tx},${ty}: ${x},${y}`);
  }
  // each faces the tree
  for (const u of cutters) { const [x, y] = at.get(u.id)!; assert.equal(dirToward(tx - x, ty - y), u.dir); }
});

test('police strikes are not cut off before their sound frame; the arrest job reads T271', { skip }, () => {
  const { world: w, mission: m } = loadMission('Pimmons.mdb', 0, DATA, false);   // no foreign units about
  const me = m.humanRace, t = w.economy.towns.find(x => x.race === me)!;
  const spot = w.freeSpiral(t.x + 6, t.y + 6, 10)!;
  const officer = w.spawnUnit(me, 21, spot[0], spot[1], t.id);
  const crim = w.spawnUnit(me, 12, spot[0] + 3, spot[1], t.id);
  w.economy.joinTown(officer, t); w.economy.joinTown(crim, t);
  w.schedule({ type: 'order', player: me, ids: [officer.id], target: crim.id });
  const r = w.rules.get(officer.oid)!;
  const soundAt = (r.soundFrame * 10) / 7;   // ticks from the strike's start to its sound frame (unit-motion.md 3, 5)
  // only a step (the chase) may stop a strike before its sound frame (unit-motion.md 3), never the
  // end of a walk, the end of the attack or the planning of a walk
  let strikes = 0, cut = 0, start = -1;
  for (let i = 0; i < 3000 && crim.alive && w.get(crim.id); i++) {
    w.step();
    if (officer.action === Action.Fight && officer.actionTick !== start) { start = officer.actionTick; strikes++; }
    else if (start >= 0 && officer.actionTick !== start) {
      if (w.tick - start < soundAt && officer.stepStart !== officer.actionTick) cut++;
      start = -1;
    }
    if (officer.job) assert.equal(w.sched.get(officer.job)?.kind, 0x18, 'the arrest job stays the top-level job (status T271)');
  }
  assert.ok(strikes >= 3, `strikes ${strikes}`);
  assert.equal(cut, 0, 'no strike replaced before its sound frame');
});
