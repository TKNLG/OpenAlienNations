// A melee attacker chasing a target that walks away and then turns (docs/game/combat.md 3.3,
// 3.3.1, 3.5, 3.6; units-and-jobs.md 4.1): the running walk is never re-aimed because the target
// moved; while it runs, the plan for the next walk is searched again whenever its end no longer
// reaches the target, each search using one of the 5 per target; the 6th retargets, which drops the
// walk where the unit stands, and the next walk starts from there toward the target's new place.
// The chaser stops on the first cell next to the target and strikes. Needs AN_DATA.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { loadMission, DATA } from './helpers/mission.ts';
import { Action, SUB, World, type Entity } from '../src/engine/world.ts';

const skip = !existsSync(`${DATA}/dv.wdb`) && 'AN_DATA not set';
const SWORD = 31, PORTER = 9;
/** attack job data (combat.ts A): target, anchor, searches, auto, player, walk flag, plan */
const A = { Target: 0, Searches: 3, Walk: 6 } as const;

const cellOf = (e: Entity): [number, number] => [Math.floor(e.x / SUB), Math.floor(e.y / SUB)];

/** a free rectangle (w x h cells, no unit, building, nature object or water) near (x, y): its left middle cell */
function freeArea(w: World, x: number, y: number, wd: number, h: number): [number, number] {
  for (let r = 0; r < 90; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
    let ok = true;
    for (let k = -1; k <= wd && ok; k++) for (let j = -h; j <= h && ok; j++) if (w.occupied(x + dx + k, y + dy + j) || !w.motion.free(x + dx + k, y + dy + j)) ok = false;
    if (ok) return [x + dx, y + dy];
  }
  throw new Error('no free area');
}

interface Sample { tick: number; sx: number; sy: number; px: number; py: number; path: boolean; gx: number; gy: number; searches: number; walk: number; act: number; stepping: boolean }

function setup(turnAt: number) {
  const { world: w, mission: m } = loadMission('Pimmons.mdb', 7, DATA, false);   // Pimmons vs Amazons
  const me = m.humanRace;
  const enemy = m.races.find(r => r.present && r.race !== me)!.race;
  const t = w.economy.towns.find(x => x.race === me)!;
  const [x, y] = freeArea(w, t.x + 12, t.y + 12, 38, 9);
  const sword = w.spawnUnit(me, SWORD, x, y, t.id);
  const prey = w.spawnUnit(enemy, PORTER, x + 9, y, -1);
  // the prey walks east, away from the swordfighter, then turns north-east (its owner's move orders)
  w.schedule({ type: 'move', player: enemy, ids: [prey.id], x: x + 36, y });
  w.schedule({ type: 'move', player: enemy, ids: [prey.id], x: x + 30, y: y - 8 }, w.tick + turnAt + 1);
  w.schedule({ type: 'order', player: me, ids: [sword.id], target: prey.id });
  return { w, sword, prey };
}

function sample(w: World, sword: Entity, prey: Entity): Sample {
  const j = sword.job ? w.sched.get(sword.job) : undefined;
  const [sx, sy] = cellOf(sword), [px, py] = cellOf(prey), m = w.size - 1;
  return {
    tick: w.tick, sx, sy, px, py, path: !!sword.path, gx: sword.goalX & m, gy: sword.goalY & m,
    searches: j ? j.data[A.Searches] : -1, walk: j ? j.data[A.Walk] : -1, act: sword.action,
    stepping: sword.stepStart + sword.stepTicks > w.tick,
  };
}

function chase(turnAt: number) {
  const { w, sword, prey } = setup(turnAt);
  const log: Sample[] = [];
  for (let i = 0; i < 800 && prey.hp >= 50; i++) { w.step(); log.push(sample(w, sword, prey)); }
  return { w, sword, prey, log };
}

/** a snapshot of `w` restored into a new world */
function roundTrip(w: World, edit?: (snap: ReturnType<World['snapshot']>) => void): World {
  const snap = JSON.parse(JSON.stringify(w.snapshot()));
  edit?.(snap);
  const tr = w.terrain;
  return World.restore({ ...tr, height: tr.height.slice(), cls: tr.cls.slice(), tile: tr.tile.slice() }, snap, w.rules, w.weapons);
}

const cheb = (w: World, ax: number, ay: number, bx: number, by: number) => {
  const n = w.size, wrap = (d: number) => (d > n / 2 ? d - n : d < -n / 2 ? d + n : d);
  return Math.max(Math.abs(wrap(ax - bx)), Math.abs(wrap(ay - by)));
};

test('chase: a target that runs and turns is followed and reached; walks are not re-aimed, re-plans count, the 6th retargets mid-walk', { skip }, () => {
  const { w, prey, log } = chase(40);
  // reached: the prey was hit, and the first strike came from a cell next to it
  assert.ok(prey.hp < 50, `the prey was hit (${log.length} ticks)`);
  const first = log.findIndex(s => s.act === Action.Fight);
  assert.ok(first > 0, 'a strike');
  const f = log[first];
  assert.ok(cheb(w, f.sx, f.sy, f.px, f.py) <= 1, `strike from next to the prey (${f.sx},${f.sy} vs ${f.px},${f.py})`);
  // the walk in progress is never re-aimed: a goal changes only after the walk has ended
  for (let i = 1; i < first; i++) {
    const a = log[i - 1], b = log[i];
    if (a.path && b.path && a.walk === 1 && b.walk === 1) assert.ok(a.gx === b.gx && a.gy === b.gy, `walk re-aimed at tick ${b.tick}`);
  }
  // the next walk's plan is searched again during a walk, when the target has moved (3.3.1 item 2)
  assert.ok(log.some((s, i) => i > 0 && s.path && log[i - 1].path && s.walk === 1 && s.searches > log[i - 1].searches), 'a re-plan during a walk');
  // the counter never exceeds 5; the 6th search retargets (3.6): the same prey again, counter reset
  assert.ok(log.every(s => s.searches <= 5));
  const resets = log.map((s, i) => (i > 0 && s.searches < log[i - 1].searches ? i : -1)).filter(i => i > 0 && i < first);
  assert.ok(resets.length >= 1, 'at least one retarget during the chase');
  // one of them dropped a walk short of its goal, at a step boundary: the unit stands where it is
  const dropped = resets.filter(i => log[i - 1].path && log[i - 1].walk === 1 && !log[i].path &&
    (log[i].sx !== log[i - 1].gx || log[i].sy !== log[i - 1].gy));
  assert.ok(dropped.length >= 1, `a walk dropped mid-way by the retarget (resets at ${resets.map(i => log[i].tick).join(', ')})`);
  for (const i of dropped) {
    assert.ok(!log[i].stepping, `dropped between steps at tick ${log[i].tick}`);
    // the next walk starts from that cell toward the prey's place now: its goal lies next to the prey
    const k = log.findIndex((s, j) => j > i && s.path && s.walk === 1);
    assert.ok(k > i, 'a new walk follows');
    const n = log[k];
    // a search 1 tick after the retarget, the walk 2 ticks after it (more if the prey moved on meanwhile)
    assert.ok(n.tick - log[i].tick >= 3, `walk ${n.tick - log[i].tick} ticks after the retarget`);
    assert.ok(log[k - 1].sx === log[i].sx && log[k - 1].sy === log[i].sy, 'it stood where the walk was dropped');
    assert.ok(cheb(w, n.gx, n.gy, n.px, n.py) <= 2, `new goal (${n.gx},${n.gy}) by the prey (${n.px},${n.py})`);
    assert.ok(cheb(w, n.gx, n.gy, log[i - 1].gx, log[i - 1].gy) > 0, 'the new walk aims elsewhere');
  }
});

test('chase: identical runs; a snapshot taken mid-walk with a stored plan restores to the same state', { skip }, () => {
  const a = chase(40), b = chase(40);
  assert.equal(a.w.hash(), b.w.hash());
  assert.deepEqual(a.log, b.log);
  const { w, sword } = setup(40);
  for (let i = 0; i < 400 && !(sword.path && w.sched.get(sword.job)?.data[A.Walk] === 1 && w.sched.get(sword.job)?.data[7] === 1); i++) w.step();
  assert.ok(sword.path, 'walking with a stored plan');
  const copy = roundTrip(w);
  assert.equal(copy.hash(), w.hash());
  for (let i = 0; i < 300; i++) { w.step(); copy.step(); }
  assert.equal(copy.hash(), w.hash());
});

test('chase: a version 8 save (6-slot attack state) is migrated and the chase goes on', { skip }, () => {
  const { w, sword, prey } = setup(40);
  for (let i = 0; i < 400 && !(sword.path && sword.stepStart + sword.stepTicks <= w.tick + 1); i++) w.step();
  assert.ok(sword.path, 'walking');
  const copy = roundTrip(w, snap => {
    snap.v = 8;
    for (const slot of snap.sched.slots) for (const j of slot) if (j.id === sword.job) j.data.length = 6;
  });
  const j = copy.sched.get(sword.job)!;
  assert.equal(j.data.length, 12, 'attack state grown to 12 slots');
  assert.equal(j.data[A.Walk], 1, 'the walk under way is the attack\'s');
  const p = copy.get(prey.id)!;
  for (let i = 0; i < 800 && p.hp >= 50; i++) copy.step();
  assert.ok(p.hp < 50, 'the prey is reached and hit');
});
