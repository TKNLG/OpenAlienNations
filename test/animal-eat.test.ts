// Animals eating bushes and crops: the eat child (job 0x2A). Spec: docs/game/units-and-jobs.md 7.7,
// 7.7.1, 7.4; docs/rendering/unit-motion.md 4.3. Synthetic worlds, no game data needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, SUB, type Entity } from '../src/engine/world.ts';
import { LJ, AM, EatPhase, AnimalMode } from '../src/engine/logistics.ts';
import { MsRand } from '../src/world/rand.ts';
import type { ObjectRule } from '../src/formats/odb.ts';
import type { Terrain } from '../src/world/terrain.ts';
import type { MapObject } from '../src/formats/mission.ts';

const ANIMAL = 33, BUSH = 1, CROP = 17, STONE = 30;
function rules(): Map<number, ObjectRule> {
  const m = new Map<number, ObjectRule>();
  const id = (t: number) => (6 << 16) | t;
  m.set(id(ANIMAL), { id: id(ANIMAL), group: 6, kind: 2, type: ANIMAL, cls: 7, stepTime: [5, 6, 7, 8], hp: 10, amount: 4, product: 4, sizeX: 1, sizeY: 1 } as ObjectRule);
  m.set(id(BUSH), { id: id(BUSH), group: 6, kind: 2, type: BUSH, cls: 9, stepTime: [0, 0, 0, 0], hp: 10, amount: 5, product: 4, sizeX: 1, sizeY: 1 } as ObjectRule);
  m.set(id(CROP), { id: id(CROP), group: 6, kind: 2, type: CROP, cls: 10, stepTime: [0, 0, 0, 0], hp: 10, amount: 1, product: 5, sizeX: 1, sizeY: 1 } as ObjectRule);
  m.set(id(STONE), { id: id(STONE), group: 6, kind: 2, type: STONE, cls: 13, stepTime: [0, 0, 0, 0], hp: 10, amount: 12, product: 2, sizeX: 1, sizeY: 1 } as ObjectRule);
  return m;
}
function flatTerrain(bits: number): Terrain {
  const n = 1 << bits;
  return { sizeBits: bits, size: n, height: new Uint16Array(n * n).fill(128), cls: new Uint8Array(n * n), tile: new Uint8Array(n * n) };
}
const nat = (type: number, x: number, y: number): MapObject => ({ cls: 2, group: 6, type, owner: -1, x, y, z: 0 });
const cell = (e: Entity): [number, number] => [Math.floor(e.x / SUB), Math.floor(e.y / SUB)];

/** a world with an animal at (20, 20) and the given food; the animal's job is replaced by mode 2 (eat), due next tick */
function eatWorld(objs: MapObject[]) {
  const w = new World(flatTerrain(6), [nat(ANIMAL, 20, 20), ...objs], rules());
  const a = w.entities.find(e => (e.oid & 0xffff) === ANIMAL)!;
  w.sched.cancel(a.job);
  a.job = w.sched.create(LJ.Animal, a.id, 0, [AnimalMode.Eat, -1, 0, 0, 0]).id;   // runs in the next step
  const job = () => w.sched.get(a.job)!;
  return { w, a, job };
}
/** set the simulation rand so that its next draw mod 3 is 0 (the 1-in-3 roll takes the candidate) */
function rollZero(w: World): void {
  for (let s = 1; ; s++) { if (new MsRand(s).next() % 3 === 0) { w.rand.state = s; return; } }
}

test('eat: walk to exactly (x, y - 1), turn to 3, reserve 1, ID3 repeat 99; the bite 100 ticks later; wander 1 tick after', {}, () => {
  const { w, a, job } = eatWorld([nat(BUSH, 24, 23)]);
  const bush = w.entities.find(e => (e.oid & 0xffff) === BUSH)!;
  rollZero(w);
  w.step();
  const E = w.tick;
  assert.equal(job().data[AM.Food], bush.id, 'the bush was chosen');
  assert.equal(job().data[AM.Phase], EatPhase.Check);
  assert.equal(a.path, null);
  w.step();                                   // E+1: the eat child's phase 0
  assert.equal(job().data[AM.Phase], EatPhase.Plan);
  assert.equal(a.path, null);
  w.step();                                   // E+2: the follow-path child plans
  assert.ok(a.path && a.path.length);
  assert.equal(a.moveAt, E + 5);
  assert.deepEqual([a.goalX, a.goalY], [24, 22], 'the eating place is (x, y - 1)');
  let T = -1;
  for (let i = 0; i < 200 && T < 0; i++) {
    w.step();
    if (job().data[AM.Phase] === EatPhase.Bite) T = w.tick;
    else assert.equal(bush.reserved, 0, 'nothing reserved before the turn is done');
  }
  assert.ok(T > 0, 'eating');
  assert.deepEqual(cell(a), [24, 22]);
  assert.equal(a.dir, 3, 'facing 3, toward the bush');
  assert.equal(bush.reserved, 1);
  assert.equal(bush.amount, 5);
  assert.equal(a.action, 3); assert.equal(a.idleTick, T); assert.equal(a.actionTick, T); assert.equal(a.idleLoops, 99);
  for (let i = 0; i < 99; i++) { w.step(); assert.equal(bush.amount, 5); assert.deepEqual(cell(a), [24, 22]); }
  w.step();                                   // T+100: the bite
  assert.equal(w.tick, T + 100);
  assert.equal(bush.amount, 4); assert.equal(bush.reserved, 0);
  assert.equal(bush.stage, 20, 'the depletion update ran');
  assert.equal(job().data[AM.Mode], AnimalMode.Wander);
  assert.equal(job().data[AM.Running], 0);
  assert.equal(a.idleTick, T, 'the ID3 row runs on until the next walk');
  w.step();                                   // T+101: the wander walk starts
  assert.equal(job().data[AM.Running], 1);
});

test('eat: only the cell (x, y - 1) counts; a candidate without it draws no rand(); the area is dx^2 + dy^2 < 100', {}, () => {
  // the bush's (x, y - 1) holds a stone: no candidate, even with every other neighbour free
  let s = eatWorld([nat(BUSH, 24, 23), nat(STONE, 24, 22)]);
  s.w.rand.state = 12345;
  s.w.step();
  assert.equal(s.job().data[AM.Food], -1, 'not chosen');
  assert.ok(s.job().data[AM.Mode] !== AnimalMode.Eat, 'nothing found: wander or idle next');
  assert.equal(s.w.rand.state, (() => { const r = new MsRand(12345); r.next(); return r.state; })(), 'only the mode draw');
  // (7, 7) from home: 98 < 100, a candidate; (8, 6): 100, not one
  s = eatWorld([nat(BUSH, 27, 27)]);
  rollZero(s.w); s.w.step();
  assert.ok(s.job().data[AM.Food] > 0);
  s = eatWorld([nat(BUSH, 28, 26)]);
  rollZero(s.w); s.w.step();
  assert.equal(s.job().data[AM.Food], -1);
  // the 1-in-3 roll failing skips the candidate
  s = eatWorld([nat(BUSH, 24, 23)]);
  for (let k = 1; ; k++) if (new MsRand(k).next() % 3 !== 0) { s.w.rand.state = k; break; }
  s.w.step();
  assert.equal(s.job().data[AM.Food], -1);
});

test('eat: no tolerance at arrival; a taken eating place ends the child without success', {}, () => {
  const { w, a, job } = eatWorld([nat(BUSH, 24, 23)]);
  const bush = w.entities.find(e => (e.oid & 0xffff) === BUSH)!;
  rollZero(w);
  w.step();
  // a stone appears on the eating place before the child's first run
  w.spawn(nat(STONE, 24, 22));
  w.step();
  assert.equal(job().data[AM.Mode], AnimalMode.Wander, 'ended without success: wander');
  assert.equal(job().data[AM.Running], 0);
  assert.equal(bush.reserved, 0); assert.equal(bush.amount, 5);
  assert.equal(a.path, null);
});

test('eat: killed mid-meal releases the reservation and nothing is eaten', {}, () => {
  const { w, a, job } = eatWorld([nat(BUSH, 24, 23)]);
  const bush = w.entities.find(e => (e.oid & 0xffff) === BUSH)!;
  rollZero(w);
  for (let i = 0; i < 300 && job().data[AM.Phase] !== EatPhase.Bite; i++) w.step();
  assert.equal(bush.reserved, 1);
  for (let i = 0; i < 30; i++) w.step();
  w.logistics.killAnimal(a);
  assert.equal(bush.reserved, 0);
  for (let i = 0; i < 200; i++) w.step();
  assert.equal(bush.amount, 5);
  assert.equal(bush.reserved, 0);
});

test('eat: a crop draws mentor#81 for its race, at most once per 120 s; a crop at 0 is removed', {}, () => {
  const { w, job } = eatWorld([nat(CROP, 24, 23), nat(CROP, 22, 23)]);
  const crops = w.entities.filter(e => (e.oid & 0xffff) === CROP);
  const mentors = () => w.events.filter(e => e.mentor === 81 && e.race === 0).length;
  for (let meal = 0; meal < 2; meal++) {
    job().data[AM.Mode] = AnimalMode.Eat; job().data[AM.Running] = 0;
    rollZero(w);
    // let the next run of the animal job choose
    for (let i = 0; i < 400 && job().data[AM.Mode] === AnimalMode.Eat && !job().data[AM.Running]; i++) { rollZero(w); w.step(); }
    for (let i = 0; i < 400 && job().data[AM.Mode] === AnimalMode.Eat; i++) w.step();
  }
  assert.equal(crops.filter(c => w.get(c.id)).length, 0, 'both crops eaten and removed');
  assert.equal(mentors(), 1, 'mentor#81 once within 120 s');
});

test('eat: snapshot round trip mid-meal continues identically', {}, () => {
  const { w, job } = eatWorld([nat(BUSH, 24, 23)]);
  rollZero(w);
  for (let i = 0; i < 300 && job().data[AM.Phase] !== EatPhase.Bite; i++) w.step();
  for (let i = 0; i < 20; i++) w.step();
  const copy = World.restore(flatTerrain(6), JSON.parse(JSON.stringify(w.snapshot())), w.rules);
  assert.equal(copy.hash(), w.hash());
  for (let i = 0; i < 600; i++) { w.step(); copy.step(); }
  assert.equal(copy.hash(), w.hash());
  assert.equal(copy.entities.find(e => (e.oid & 0xffff) === BUSH)!.amount, w.entities.find(e => (e.oid & 0xffff) === BUSH)!.amount);
  assert.ok(w.entities.find(e => (e.oid & 0xffff) === BUSH)!.amount < 5);
});
