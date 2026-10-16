// The builder at completion: he walks to the entrance cell and stands there idle; other builders
// on the site end through their own runs (repair branch, 1 coin). Spec: docs/game/units-and-jobs.md
// 6.4, 6.4.1, 4.10 (a leaving unit pushes the idle builder). Needs AN_DATA.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { loadMission, DATA } from './helpers/mission.ts';
import { Kind, SUB, Action, World, type Entity } from '../src/engine/world.ts';
import { LJ, BJ } from '../src/engine/logistics.ts';
import { MJ } from '../src/engine/motion.ts';
import { dirToward } from '../src/engine/path.ts';

const skip = !existsSync(`${DATA}/dv.odb`) && 'AN_DATA not set';
const SCHOOL = 55, BUILDER = 11, PORTER = 9;
const cellOf = (e: Entity): [number, number] => [Math.floor(e.x / SUB), Math.floor(e.y / SUB)];

/** Pimmons mission 0 without computer players: a school ordered next to the town hall */
function schoolSite(extraBuilder: boolean) {
  const { world: w, mission: m } = loadMission('Pimmons.mdb', 0, DATA, false);
  const me = m.humanRace, t = w.economy.towns.find(x => x.race === me)!;
  const r = w.rules.get((me << 16) | SCHOOL)!;
  let spot: [number, number] | null = null;
  for (let rad = 3; rad < 15 && !spot; rad++)
    for (let dy = -rad; dy <= rad && !spot; dy++)
      for (let dx = -rad; dx <= rad && !spot; dx++)
        if (Math.max(Math.abs(dx), Math.abs(dy)) === rad && w.logistics.canPlace(t, r, t.x + dx, t.y + dy)) spot = [t.x + dx, t.y + dy];
  if (!spot) throw new Error('no free place for the school');
  w.schedule({ type: 'build', player: me, town: t.id, building: SCHOOL, x: spot[0], y: spot[1] });
  w.step();
  const site = w.entities.find(e => (e.oid & 0xffff) === SCHOOL && e.owner === me)!;
  assert.ok(site && !site.complete);
  if (extraBuilder) {
    // the town's builder takes the site first; then a second one is ordered onto it
    for (let i = 0; i < 400 && !site.order?.builders.length; i++) w.step();
    assert.equal(site.order?.builders.length, 1);
    const b2 = w.spawnUnit(me, BUILDER, t.x + 3, t.y + 3, t.id);
    w.economy.joinTown(b2, t);
    w.schedule({ type: 'order', player: me, ids: [b2.id], target: site.id });
  }
  return { w, me, t, site };
}

/** step until the site is complete; returns the builders listed on it in the completing tick */
function untilComplete(w: World, site: Entity): number[] {
  for (let i = 0; i < 4000; i++) {
    const list = site.order?.builders.slice() ?? [];
    w.step();
    if (site.complete) return list;
  }
  throw new Error('site not completed');
}

const jobKind = (w: World, u: Entity) => (u.job ? w.sched.get(u.job)?.kind ?? -1 : 0);

test('builder at completion: walks to the entrance (plan C+1, first step >= C+4), works until the first step, ends idle there', { skip }, () => {
  const { w, me, site } = schoolSite(false);
  const list = untilComplete(w, site);
  const C = w.tick;
  assert.equal(list.length, 1);
  const u = w.get(list[0])!;
  const [ex, ey] = w.logistics.entrance(site);
  // C: the job goes on (walk child created), the work animation keeps looping, nothing moved yet
  assert.equal(jobKind(w, u), LJ.Builder, 'not cancelled by the completion');
  assert.equal(u.action, Action.Work, 'still the work animation');
  assert.equal(u.path, null);
  const startCell = cellOf(u), startDir = u.dir;
  if (startCell[0] === ex && startCell[1] === ey) {
    // already on the entrance: ends at C+1 and stops working at once, keeping the spot's facing
    w.step();
    assert.equal(u.job, 0);
    assert.equal(u.action, Action.Idle);
    assert.equal(u.dir, startDir);
    return;
  }
  // C+1: the follow-path child plans; the first step 3 ticks later at the earliest
  w.step();
  assert.ok(u.path && u.path.length, 'path planned at C+1');
  assert.equal(u.moveAt, C + 4);
  assert.equal(u.action, Action.Work, 'planning does not change the action');
  let first = -1;
  for (let i = 0; i < 20 && first < 0; i++) {
    if (u.stepStart > C) { first = u.stepStart; break; }
    assert.equal(u.action, Action.Work, `work animation until the first step (tick ${w.tick})`);
    w.step();
  }
  assert.ok(first >= C + 4 && first <= C + 8, `first step at C+${first - C}`);
  assert.equal(u.action, Action.Walk, 'the step message ends the work animation');
  for (let i = 0; i < 200 && u.job; i++) w.step();
  assert.equal(u.job, 0, 'the builder job ended with the walk');
  assert.deepEqual(cellOf(u), [ex, ey], 'on the entrance cell');
  assert.equal(u.action, Action.Idle, 'stop message: standing pose');
  // facing of the last step (a plain follow-path: no final turn)
  const ddx = Math.round((u.x - u.stepFromX) / SUB), ddy = Math.round((u.y - u.stepFromY) / SUB);
  assert.equal(u.dir, dirToward(ddx, ddy));
  // afterwards: idle on the entrance, no job, until the dispatcher has work for him
  for (let i = 0; i < 60; i++) { w.step(); assert.equal(u.job, 0); assert.deepEqual(cellOf(u), [ex, ey]); }

  // a unit leaving the school finds the entrance taken: the idle builder is pushed aside (4.10)
  const p = w.spawnInside(me, PORTER, site, site.town);
  let pushed = false;
  for (let i = 0; i < 60 && p.inside >= 0; i++) {
    w.step();
    if (jobKind(w, u) === MJ.StepAside) pushed = true;
  }
  assert.ok(pushed, 'the builder got a step-aside job');
  assert.equal(p.inside, -1, 'the leaving unit is out');
  assert.deepEqual(cellOf(p), [ex, ey], 'on the entrance');
  assert.ok(cellOf(u)[0] !== ex || cellOf(u)[1] !== ey, 'the builder stepped aside');
  assert.equal(w.logistics.dist(...cellOf(u), ex, ey), 1);
});

test('other builders on the site end through their own runs: repair branch with 1 coin, then the walk to the door', { skip }, () => {
  const { w, me, site } = schoolSite(true);
  const list = untilComplete(w, site);
  assert.equal(list.length, 2, 'two builders on the site');
  const all = list.map(id => w.get(id)!);
  // nobody is cancelled by the completion
  for (const u of all) assert.equal(jobKind(w, u), LJ.Builder);
  const p = w.economy.players[me]!;
  const [ex, ey] = w.logistics.entrance(site);
  let paid = 0;
  for (let i = 0; i < 300 && all.some(u => u.job && jobKind(w, u) === LJ.Builder); i++) {
    const before = all.map(u => (jobKind(w, u) === LJ.Builder ? [...w.sched.get(u.job)!.data] : null));
    const money = p.money;
    w.step();
    all.forEach((u, k) => {
      const d0 = before[k];
      const j = jobKind(w, u) === LJ.Builder ? w.sched.get(u.job)! : undefined;
      // the repair tick of a builder who was at work (phase 2, step 1) pays 1 coin and sends him to the door
      if (d0 && d0[BJ.Phase] === 2 && d0[BJ.Step] === 1 && j && j.data[BJ.Phase] === 4) {
        assert.equal(money - p.money, 1, 'one coin for the repair tick on a full building');
        paid++;
      }
    });
  }
  for (const u of all) {
    assert.ok(jobKind(w, u) !== LJ.Builder, 'every builder job ended');
    // at the door: on it, one short (arrival tolerance next to a busy unit), or pushed aside by the other builder
    assert.ok(w.logistics.dist(...cellOf(u), ex, ey) <= 2, `builder ${u.id} ended at the door (${cellOf(u)} vs ${[ex, ey]})`);
    assert.equal(u.action, Action.Idle);
  }
  assert.ok(paid <= 1, 'only the other builder can pay');
  assert.equal(paid, 1, 'the second builder paid for one repair tick');
  assert.equal(site.hp, w.rules.get(site.oid)!.hp);
});

test('builder door walk: snapshot round trip right after completion continues identically', { skip }, () => {
  const { w, site } = schoolSite(true);
  untilComplete(w, site);
  w.step();
  const snap = JSON.parse(JSON.stringify(w.snapshot()));
  const tr = w.terrain;
  const copy = World.restore({ ...tr, height: tr.height.slice(), cls: tr.cls.slice(), tile: tr.tile.slice() }, snap, w.rules);
  for (let i = 0; i < 400; i++) { w.step(); copy.step(); }
  assert.equal(copy.hash(), w.hash());
  assert.ok(w.entities.some(e => e.kind === Kind.Unit && (e.oid & 0xffff) === BUILDER));
});
