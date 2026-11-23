// A go-to whose target dies stops the unit on the spot, and a destroyed site sends its builders
// away (docs/game/units-and-jobs.md 4.2 "A target that dies stops the unit on the spot", 6.4
// "Site destroyed or demolished"). Needs AN_DATA.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { loadMission, DATA } from './helpers/mission.ts';
import { Kind, SUB, World, type Entity } from '../src/engine/world.ts';
import { LJ, BJ } from '../src/engine/logistics.ts';

const skip = !existsSync(`${DATA}/dv.odb`) && 'AN_DATA not set';
const SCHOOL = 55, BUILDER = 11, PORTER = 9;
const cellOf = (e: Entity): [number, number] => [Math.floor(e.x / SUB), Math.floor(e.y / SUB)];
const jobOf = (w: World, u: Entity) => (u.job ? w.sched.get(u.job) : undefined);
const cheb = (a: [number, number], b: [number, number]) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));

/** Pimmons mission 0 without computer players: a school site ordered `minRad`+ cells from the hall */
function schoolSite(minRad: number) {
  const { world: w, mission: m } = loadMission('Pimmons.mdb', 0, DATA, false);
  const me = m.humanRace, t = w.economy.towns.find(x => x.race === me)!;
  const r = w.rules.get((me << 16) | SCHOOL)!;
  let spot: [number, number] | null = null;
  for (let rad = minRad; rad < minRad + 20 && !spot; rad++)
    for (let dy = -rad; dy <= rad && !spot; dy++)
      for (let dx = -rad; dx <= rad && !spot; dx++)
        if (Math.max(Math.abs(dx), Math.abs(dy)) === rad && w.logistics.canPlace(t, r, t.x + dx, t.y + dy)) spot = [t.x + dx, t.y + dy];
  assert.ok(spot, 'a place for the school');
  w.schedule({ type: 'build', player: me, town: t.id, building: SCHOOL, x: spot![0], y: spot![1] });
  w.step();
  const site = w.entities.find(e => (e.oid & 0xffff) === SCHOOL && e.owner === me)!;
  assert.ok(site && !site.complete);
  return { w, me, t, site };
}

const onSite = (w: World, u: Entity, site: Entity) => { const j = jobOf(w, u); return !!j && !j.cancelled && j.kind === LJ.Builder && j.data[BJ.Building] === site.id; };
const builderRequests = (w: World, site: Entity) => w.economy.towns.reduce((n, t) => n + t.workerReqs.filter(([ty, b]) => ty === BUILDER && b === site.id).length, 0);

test('a builder walking to a demolished site stops within about a second where he is, and nobody is sent again', { skip }, () => {
  const { w, me, site } = schoolSite(12);
  const entrance = w.logistics.entrance(site);
  let builder: Entity | undefined;
  for (let i = 0; i < 600 && !builder; i++) {
    w.step();
    builder = w.entities.find(u => u.kind === Kind.Unit && (u.oid & 0xffff) === BUILDER && onSite(w, u, site) && !!u.path && cheb(cellOf(u), entrance) > 6);
  }
  assert.ok(builder, 'a builder is on his way to the site, still more than 6 cells off');
  const at = cellOf(builder!);
  w.schedule({ type: 'building', player: me, id: site.id, action: 'demolish' }, w.tick + 1);
  // the construction job's next slot is at most 10 ticks after the death; a step under way ends
  for (let i = 0; i < 25; i++) w.step();
  assert.equal(onSite(w, builder!, site), false, 'the builder job is gone');
  assert.ok(!builder!.path, 'he stands still');
  assert.ok(cheb(cellOf(builder!), at) <= 2, `he stopped near where he was (${cellOf(builder!)} vs ${at})`);
  assert.ok(cheb(cellOf(builder!), entrance) > 3, 'he did not walk on to the site');
  for (let i = 0; i < 60; i++) w.step();
  assert.equal(w.get(site.id), undefined, 'the site is gone');
  assert.equal(builderRequests(w, site), 0, 'no builder is called to the dead site');
  assert.ok(!builder!.path && !onSite(w, builder!, site));
});

test('builders at work on a destroyed site are sent away at the construction job\'s next 10-tick slot', { skip }, () => {
  const { w, me, site } = schoolSite(5);
  const placed = site.order!.placed!;
  let builder: Entity | undefined;
  for (let i = 0; i < 2000 && !builder; i++) {
    w.step();
    builder = w.entities.find(u => u.kind === Kind.Unit && (u.oid & 0xffff) === BUILDER && onSite(w, u, site) && !u.path && cheb(cellOf(u), w.logistics.entrance(site)) <= 3);
  }
  assert.ok(builder, 'a builder works at the site');
  w.schedule({ type: 'building', player: me, id: site.id, action: 'demolish' }, w.tick + 1);
  w.step();
  const death = w.tick - 1;
  assert.equal(site.alive, false);
  const first = placed + 10;
  const slot = death < first ? first : first + 10 * (Math.floor((death - first) / 10) + 1);
  let gone = -1;
  for (let i = 0; i < 20 && gone < 0; i++) { w.step(); if (!onSite(w, builder!, site)) gone = w.tick - 1; }
  assert.ok(gone > death && gone <= slot, `dismissed by the slot (death ${death}, slot ${slot}, gone ${gone})`);
  assert.ok(gone - death <= 10);
});

test('a unit ordered into a building stops on the spot when the building is demolished', { skip }, () => {
  const { w, me, t, site: target } = schoolSite(12);
  const entrance = w.logistics.entrance(target);
  // a porter next to the town hall, on the far side from the site
  let spawned: Entity | undefined;
  for (let r = 3; r < 12 && !spawned; r++) {
    const x = t.x - Math.sign(entrance[0] - t.x) * r, y = t.y - Math.sign(entrance[1] - t.y) * r;
    if (w.motion.free(x, y)) spawned = w.spawnUnit(me, PORTER, x, y, t.id);
  }
  assert.ok(spawned, 'a porter outside');
  const porter = spawned!;
  assert.ok(cheb(cellOf(porter), entrance) >= 8, 'far enough for a walk');
  w.schedule({ type: 'order', player: me, ids: [porter.id], target: target.id }, w.tick + 1);
  for (let i = 0; i < 30; i++) w.step();
  assert.equal(jobOf(w, porter)?.kind, LJ.Answer, 'the go-to into the site');
  assert.ok(porter.path, 'walking to the building');
  const at = cellOf(porter);
  w.schedule({ type: 'building', player: me, id: target.id, action: 'demolish' }, w.tick + 1);
  for (let i = 0; i < 20; i++) w.step();
  assert.ok(!porter.path, 'stopped');
  assert.ok(cheb(cellOf(porter), at) <= 2, 'on the spot (a step under way is finished)');
  assert.ok(cheb(cellOf(porter), entrance) > 3, 'not at the door');
  const j = jobOf(w, porter);
  assert.ok(!j || j.kind !== LJ.Answer, 'the go-to is over');
});

test('saves keep the site\'s placement tick (snapshot 26); older sites restore with 0', { skip }, () => {
  const { w, site } = schoolSite(5);
  for (let i = 0; i < 7; i++) w.step();
  const snap = w.snapshot();
  const b = World.restore(w.terrain, snap, w.rules, w.weapons);
  assert.equal(b.get(site.id)!.order!.placed, site.order!.placed);
  assert.equal(b.hash(), w.hash());
  const old = JSON.parse(JSON.stringify(snap));
  old.v = 25;
  for (const e of old.entities) if (e.order) delete e.order.placed;
  const c = World.restore(w.terrain, old, w.rules, w.weapons);
  assert.equal(c.get(site.id)!.order!.placed, 0);
});
