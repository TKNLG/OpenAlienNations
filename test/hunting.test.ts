// Hunters: the hunting-ground job (0x2B) and the hunt itself, on real missions (needs AN_DATA).
// Spec: docs/game/units-and-jobs.md 7.3, docs/game/combat.md 14.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { loadMission, DATA } from './helpers/mission.ts';
import { Kind, SUB, Action, World, type Entity } from '../src/engine/world.ts';
import { LJ, HG, HV, HuntChild } from '../src/engine/logistics.ts';

const skip = !existsSync(`${DATA}/dv.odb`) && 'AN_DATA not set';
const HUNTER = 17;

const cellOf = (e: Entity): [number, number] => [Math.floor(e.x / SUB), Math.floor(e.y / SUB)];

function setup(mdb: string) {
  const { world: w, mission: m } = loadMission(mdb, 0, DATA, false);
  const me = m.humanRace, t = w.economy.towns.find(x => x.race === me)!;
  const isAnimal = (e: Entity) => e.kind === Kind.Nature && w.rules.get(e.oid)?.cls === 7;
  const animals = () => w.entities.filter(isAnimal);
  const nearestLiving = () => animals().filter(e => e.alive)
    .sort((a, b) => w.logistics.dist(...cellOf(a), t.x, t.y) - w.logistics.dist(...cellOf(b), t.x, t.y))[0];
  const hunter = () => { const u = w.spawnUnit(me, HUNTER, t.x + 2, t.y + 3, t.id); w.economy.joinTown(u, t); return u; };
  const job = (u: Entity) => (u.job ? w.sched.get(u.job) : undefined);
  return { w, me, t, animals, nearestLiving, hunter, job };
}

/** the torus offset b - a */
function off(w: World, a: number, b: number): number { const n = w.size; let d = (b - a) % n; if (d > n / 2) d -= n; if (d < -n / 2) d += n; return d; }

test('hunter cycle: order on an animal, kill, trips until empty, back to the spot, wait, next animal nearest the spot', { skip }, () => {
  const { w, me, animals, nearestLiving, hunter, job } = setup('Pimmons.mdb');
  const animal = nearestLiving();
  const u = hunter();
  const spot0 = cellOf(animal), full = animal.amount;
  w.schedule({ type: 'order', player: me, ids: [u.id], target: animal.id });
  w.step();

  // the order makes a hunting ground at the animal's cell with a harvest child, auto-continue off (7.3.1)
  const j = job(u)!;
  assert.equal(j.kind, LJ.Hunt);
  assert.deepEqual([j.data[HG.SX], j.data[HG.SY]], spot0);
  assert.equal(j.data[HG.Child], HuntChild.Harvest);
  assert.equal(j.data[HG.Harvest + HV.Target], animal.id);
  assert.equal(j.data[HG.Harvest + HV.Auto], 0);

  // kill, then up to 4 pieces per trip until the carcass is gone
  let pickups = 0, maxCarry = 0, prevCarry = 0, killedFirst = true;
  for (let i = 0; i < 4000 && w.get(animal.id); i++) {
    w.step();
    if (u.carryAmount > prevCarry) { pickups++; if (animal.alive) killedFirst = false; }
    prevCarry = u.carryAmount; maxCarry = Math.max(maxCarry, u.carryAmount);
  }
  assert.equal(w.get(animal.id), undefined, 'carcass used up');
  assert.ok(killedFirst, 'meat only taken from the carcass');
  assert.equal(maxCarry, 4);
  assert.equal(pickups, Math.ceil(full / 4), 'min(4, remaining) per trip');

  // the harvest ends at the store; the hunter walks back to the spot (T279) and waits there (T267)
  let walked = false;
  for (let i = 0; i < 600 && job(u)!.data[HG.Child] !== HuntChild.None; i++) {
    w.step();
    if (job(u)!.data[HG.Child] === HuntChild.Walk) walked = true;
  }
  assert.ok(walked, 'walked back');
  const d = job(u)!.data;
  assert.equal(job(u)!.kind, LJ.Hunt);
  assert.equal(d[HG.Child], HuntChild.None);
  const here = cellOf(u);
  assert.deepEqual([d[HG.SX], d[HG.SY]], here, 'spot re-anchored on the hunter');
  assert.ok(w.logistics.dist(...here, ...spot0) <= 2, `back at the spot ${here} (was ${spot0})`);

  // the next scan picks the animal nearest the spot within the hunter's 21 x 21 square (7.3.3)
  const R = w.rules.get(u.oid)!.radius;
  assert.equal(R, 10);
  let chosen: Entity | undefined, cells = new Map<number, [number, number]>(), at: [number, number] = here;
  const waitStart = w.tick;
  let firstScan = -1;
  for (let i = 0; i < 4000 && !chosen; i++) {
    cells = new Map(animals().map(e => [e.id, cellOf(e)]));
    at = cellOf(u);
    const sx = job(u)!.data[HG.SX], sy = job(u)!.data[HG.SY];
    w.step();
    const jd = job(u)!.data;
    if (jd[HG.Child] === HuntChild.Harvest) {
      chosen = w.get(jd[HG.Harvest + HV.Target]);
      firstScan = w.tick;
      const inSquare = [...cells].filter(([, [x, y]]) => Math.abs(off(w, at[0], x)) <= R && Math.abs(off(w, at[1], y)) <= R);
      const best = Math.min(...inSquare.map(([, c]) => w.logistics.dist(...c, sx, sy)));
      assert.ok(chosen && cells.has(chosen.id), 'an animal');
      assert.equal(w.logistics.dist(...cells.get(chosen!.id)!, sx, sy), best, 'nearest the spot');
      assert.equal(jd[HG.Harvest + HV.Auto], 0);
    }
  }
  assert.ok(chosen, 'found the next animal');
  assert.ok(firstScan - waitStart >= 20 - 1, 'first scan 20 ticks after arriving');
});

test('Amazon huntress shoots from range and never melees', { skip }, () => {
  const { w, me, nearestLiving, hunter } = setup('Amazons.mdb');
  const u = hunter();
  const wpn = w.combat.weapon(u)!;
  assert.ok(wpn.projectile >= 0 && wpn.range > 0, 'a bow');
  const animal = nearestLiving();
  w.schedule({ type: 'order', player: me, ids: [u.id], target: animal.id });
  let strikes = 0, shots = 0, firstShot = -1;
  for (let i = 0; i < 3000 && animal.alive; i++) {
    const [ux, uy] = cellOf(u), [ax, ay] = cellOf(animal);
    w.step();
    const mine = w.effects.filter(f => f.kind === 'shot' && f.tick === w.tick && f.shooter === u.id);
    if (u.action === Action.Fight && u.actionTick === w.tick) {
      strikes++;
      assert.equal(mine.length, 1, 'every strike is a shot');
      const s = mine[0];
      assert.deepEqual([s.x, s.y], [ux, uy], 'from her cell');
      assert.equal(s.garrison, -1);
      if (firstShot < 0) firstShot = w.logistics.dist(ux, uy, ax, ay);
    }
    shots += mine.length;
  }
  assert.equal(animal.alive, false, 'killed');
  assert.ok(strikes > 0 && shots === strikes, `${strikes} strikes, ${shots} shots`);
  assert.ok(firstShot >= 2, `first shot from ${firstShot} cells`);
});

test('Pimmon hunter stabs from an adjacent cell, no projectile', { skip }, () => {
  const { w, me, nearestLiving, hunter } = setup('Pimmons.mdb');
  const u = hunter();
  const wpn = w.combat.weapon(u)!;
  assert.ok(wpn.projectile < 0 && wpn.range === 0, 'a spear (melee)');
  const animal = nearestLiving();
  w.schedule({ type: 'order', player: me, ids: [u.id], target: animal.id });
  let strikes = 0;
  for (let i = 0; i < 3000 && animal.alive; i++) {
    const [ux, uy] = cellOf(u), [ax, ay] = cellOf(animal);
    w.step();
    assert.equal(w.effects.filter(f => f.kind === 'shot' && f.shooter === u.id).length, 0, 'no shot');
    if (u.action === Action.Fight && u.actionTick === w.tick) {
      strikes++;
      assert.ok(Math.abs(off(w, ux, ax)) <= 1 && Math.abs(off(w, uy, ay)) <= 1, 'adjacent');
    }
  }
  assert.equal(animal.alive, false, 'killed');
  assert.ok(strikes > 0);
});

test('hunting ground without animals: walks to the spot and rescans for ever', { skip }, () => {
  const { w, t, animals, hunter, job } = setup('Pimmons.mdb');
  for (const a of animals()) w.removeEntity(a);
  const u = hunter();
  // as a map order: a spot away from the hunter and no target (7.3.1)
  const [hx, hy] = cellOf(u);
  w.logistics.startHunt(u, hx - 8, hy - 8, null, 1);
  let walked = false;
  for (let i = 0; i < 300; i++) { w.step(); if (job(u)?.data[HG.Child] === HuntChild.Walk) walked = true; }
  assert.ok(walked, 'walked to the spot');
  const here = cellOf(u), d = job(u)!.data;
  assert.equal(job(u)!.kind, LJ.Hunt);
  assert.equal(d[HG.Child], HuntChild.None);
  assert.deepEqual([d[HG.SX], d[HG.SY]], here);
  assert.ok(w.logistics.dist(...here, hx - 8, hy - 8) <= 2);
  for (let i = 0; i < 1000; i++) w.step();
  assert.equal(job(u)?.kind, LJ.Hunt, 'never gives up');
  assert.deepEqual(cellOf(u), here, 'stands still');
  assert.equal(job(u)!.data[HG.Child], HuntChild.None);

  // an animal entering his square is seen at the next 20-tick scan
  let spot: [number, number] | null = null;
  for (let r = 4; r < 9 && !spot; r++) if (!w.occupied(here[0] + r, here[1]) && w.motion.free(here[0] + r, here[1])) spot = [here[0] + r, here[1]];
  assert.ok(spot, 'room for an animal');
  const hare = w.spawn({ cls: 2, group: 6, type: 37, owner: -1, x: spot![0] & (w.size - 1), y: spot![1] & (w.size - 1), z: 0 });
  let seen = -1;
  for (let i = 0; i < 25 && seen < 0; i++) { w.step(); if (job(u)!.data[HG.Child] === HuntChild.Harvest) seen = i; }
  assert.ok(seen >= 0, 'noticed within 20 ticks');
  assert.equal(job(u)!.data[HG.Harvest + HV.Target], hare.id);
  void t;
});

test('hunting ground survives a snapshot round trip', { skip }, () => {
  const { w, me, nearestLiving, hunter, job } = setup('Amazons.mdb');
  const u = hunter();
  w.schedule({ type: 'order', player: me, ids: [u.id], target: nearestLiving().id });
  for (let i = 0; i < 60; i++) w.step();
  assert.equal(job(u)?.kind, LJ.Hunt);
  const tr = w.terrain;
  const copy = World.restore({ ...tr, height: tr.height.slice(), cls: tr.cls.slice(), tile: tr.tile.slice() }, JSON.parse(JSON.stringify(w.snapshot())), w.rules, w.weapons);
  assert.equal(copy.hash(), w.hash());
  for (let i = 0; i < 1500; i++) { w.step(); copy.step(); }
  assert.equal(copy.hash(), w.hash());
  const cu = copy.get(u.id)!;
  assert.deepEqual(copy.sched.get(cu.job)?.data, job(u)?.data);
});

// ---------------------------------------------------------------- from the killing strike to the first step (7.3.4, 7.3.9 items 7-10)

/**
 * Hunt one animal and watch the timeline: every strike starts only after the last step was fully
 * played (range test D ticks after the step, combat.md 3.3); the attack ends at K, the first chain
 * run at or after the impact I (a multiple of 5 after the strike S); the go-to picks its cell at
 * K+1, the path is planned at K+2 and the first step comes at K+5 (plus turn ticks); the strike
 * action is not cut by the planning.
 */
function killTimeline(mdb: string) {
  const { w, me, nearestLiving, hunter, job } = setup(mdb);
  const u = hunter();
  const animal = nearestLiving();
  // a standing animal (its job stopped), so that the chase ends with the hunter in place and the
  // timeline after the strike is exact
  if (animal.job) { w.sched.cancel(animal.job); animal.job = 0; }
  w.halt(animal);
  w.schedule({ type: 'order', player: me, ids: [u.id], target: animal.id });
  let S = -1, I = -1, K = -1, strikes = 0;
  const phase = () => { const j = job(u); return j && j.kind === LJ.Hunt && j.data[HG.Child] === HuntChild.Harvest ? j.data[HG.Harvest + HV.Phase] : -1; };
  for (let i = 0; i < 4000 && K < 0; i++) {
    w.step();
    if (u.action === Action.Fight && u.actionTick === w.tick) {
      strikes++;
      S = w.tick;
      assert.ok(w.tick >= u.stepStart + u.stepTicks, `strike at ${w.tick} while a step (${u.stepStart}+${u.stepTicks}) is still drawn`);
    }
    if (I < 0 && !animal.alive) I = w.tick;
    if (phase() === 8) K = w.tick;
  }
  assert.ok(strikes > 0 && I > 0 && K > 0, `strikes ${strikes}, impact ${I}, attack end ${K}`);
  assert.equal(u.actionTick, S, 'the last strike is the killing one');
  // K: the hunter's 5-tick polls after the strike; the first one at or after the impact (the impact
  // job runs first when both fall in one tick)
  assert.equal((K - S) % 5, 0, `K - S = ${K - S}`);
  assert.ok(K >= I && K - 5 <= I, `K ${K}, I ${I}`);
  const dirK = u.dir;
  // K: nothing sent to the display: the strike action stays
  assert.equal(u.action, Action.Fight); assert.equal(u.path, null);
  w.step();   // K+1: go-to target chosen
  assert.equal(phase(), 9); assert.equal(u.path, null); assert.equal(u.action, Action.Fight);
  w.step();   // K+2: the path is planned; the first step 3 ticks later
  assert.equal(phase(), 1);
  assert.equal(u.action, Action.Fight, 'planning does not cut the strike');
  assert.equal(u.actionTick, S);
  if (!u.path) return { K, S, I, first: -1 };   // already on the goal
  assert.equal(u.moveAt, K + 5);
  let first = -1;
  for (let i = 0; i < 12 && first < 0; i++) {
    if (u.stepStart > K) { first = u.stepStart; break; }
    assert.equal(u.action, Action.Fight, `strike action kept until the first step (tick ${w.tick})`);
    w.step();
  }
  assert.ok(first >= K + 5 && first <= K + 8, `first step at K+${first - K}`);
  assert.ok(u.action !== Action.Fight, 'the step ends the strike');
  void dirK;
  return { K, S, I, first };
}

test('hunter after the kill (Amazon bow): attack ends at S+15, first step at K+5, strike never cut', { skip }, () => {
  const r = killTimeline('Amazons.mdb');
  // impact 11..15 ticks after the strike: the 5-tick polls give K = S+15
  assert.equal(r.K - r.S, 15, `K - S = ${r.K - r.S} (impact at S+${r.I - r.S})`);
});

test('hunter after the kill (Pimmon spear): attack ends at S+10, first step at K+5', { skip }, () => {
  const r = killTimeline('Pimmons.mdb');
  assert.equal(r.K - r.S, 10, `K - S = ${r.K - r.S} (impact at S+${r.I - r.S})`);
});
