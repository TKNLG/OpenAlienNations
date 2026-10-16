// A porter attacked on his way to a site flees with his own walks and then resumes his transport
// (docs/game/combat.md 7.3, 7.4; units-and-jobs.md 4.1, 4.2, 4.10, 5.8): the suspended job keeps
// its walk; back on his cell the walk goes on, elsewhere it ends at once and the go-to enters from
// where he stands. Either way the delivery happens. Needs AN_DATA.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { loadMission, DATA } from './helpers/mission.ts';
import { Kind, SUB, World, type Entity } from '../src/engine/world.ts';
import { LJ } from '../src/engine/logistics.ts';

const skip = !existsSync(`${DATA}/dv.odb`) && 'AN_DATA not set';
const SCHOOL = 55, PORTER = 9, FLEE = 0x26;
const TR = { Phase: 0, Requester: 3 } as const;
const cellOf = (e: Entity): [number, number] => [Math.floor(e.x / SUB), Math.floor(e.y / SUB)];
const kindOf = (w: World, u: Entity) => (u.job ? w.sched.get(u.job)?.kind ?? -1 : 0);

function schoolSite() {
  const { world: w, mission: m } = loadMission('Pimmons.mdb', 0, DATA, false);
  const me = m.humanRace, t = w.economy.towns.find(x => x.race === me)!;
  const r = w.rules.get((me << 16) | SCHOOL)!;
  let spot: [number, number] | null = null;
  for (let rad = 10; rad < 24 && !spot; rad++)
    for (let dy = -rad; dy <= rad && !spot; dy++)
      for (let dx = -rad; dx <= rad && !spot; dx++)
        if (Math.max(Math.abs(dx), Math.abs(dy)) === rad && w.logistics.canPlace(t, r, t.x + dx, t.y + dy)) spot = [t.x + dx, t.y + dy];
  assert.ok(spot, 'a place for the school');
  w.schedule({ type: 'build', player: me, town: t.id, building: SCHOOL, x: spot![0], y: spot![1] });
  w.step();
  const site = w.entities.find(e => (e.oid & 0xffff) === SCHOOL && e.owner === me)!;
  for (const g of new Set(site.needed)) t.stock[g] = Math.min(t.capacity, Math.max(t.stock[g], 20));
  return { w, me, t, site };
}

/** a porter carrying for the site, walking, at least 6 cells from its entrance */
function carrier(w: World, site: Entity): Entity {
  const [ex, ey] = w.logistics.entrance(site);
  for (let i = 0; i < 3000; i++) {
    w.step();
    for (const u of w.entities) {
      if (u.kind !== Kind.Unit || !u.job || u.inside >= 0 || u.carryAmount <= 0 || !u.path?.length) continue;
      const j = w.sched.get(u.job);
      if (!j || j.cancelled || j.kind !== LJ.Transport || j.data[TR.Requester] !== site.id || j.data[TR.Phase] !== 4) continue;
      const [x, y] = cellOf(u);
      // pausing the site keeps the delivered good in its local stock (no builder consumes it)
      if (w.logistics.dist(x, y, ex, ey) >= 6 && u.stepStart + u.stepTicks <= w.tick) { w.logistics.buildingAction(site, 'pause'); return u; }
    }
  }
  throw new Error('no porter on his way to the site');
}

/** an attacker of another race next to the porter (unarmed: nobody fights, the porter just flees) */
function attack(w: World, me: number, p: Entity): Entity {
  const [x, y] = cellOf(p);
  const a = w.spawnUnit((me + 1) % 3, PORTER, x + 2, y, -1);
  w.combat.attacked(p, a);
  return a;
}

/** step until the porter is done with this load; true if it went into the site */
function delivered(w: World, p: Entity, site: Entity, ticks: number): boolean {
  const g = p.carryGood;
  for (let i = 0; i < ticks; i++) {
    const before = site.local[g];
    w.step();
    if (!p.alive) return false;
    if (p.carryAmount === 0) return site.local[g] > before;
  }
  return false;
}

test('flee: first run 3 ticks after the strike; the transport keeps its walk; back home it walks on and delivers', { skip }, () => {
  const { w, me, site } = schoolSite();
  const p = carrier(w, site);
  const job = p.job, goal = [p.goalX, p.goalY], home = cellOf(p);
  attack(w, me, p);
  assert.equal(kindOf(w, p), FLEE);
  assert.equal(p.walks.length, 1, 'the transport\'s walk is kept for it');
  assert.equal(p.walks[0].job, job);
  assert.deepEqual([p.walks[0].goalX, p.walks[0].goalY], goal);
  assert.equal(p.path, null, 'the porter stands free for the flee\'s own walk');
  // (created between two ticks here, so its "3 ticks later" is the fourth step; in a game the
  // strike runs inside a tick)
  w.step(); w.step(); w.step();
  assert.ok(!p.path, 'no flee walk before its first run');
  w.step();
  assert.ok(p.path, 'the flee walk starts at the first run');
  assert.equal(p.walkMask, 1, 'planned around every unit (mask 0x3E)');
  // the flee runs out and back; then the transport is current again with its own walk
  for (let i = 0; i < 600 && p.job !== job; i++) w.step();
  assert.equal(p.job, job, 'the transport resumed');
  assert.deepEqual(cellOf(p), home, 'back on his cell');
  assert.equal(p.walks.length, 0);
  assert.deepEqual([p.goalX, p.goalY], goal, 'the old walk goes on toward its goal');
  assert.ok(delivered(w, p, site, 1500), 'the delivery happened');
});

test('flee cut short (the attacker dies on the way out): the old walk ends, the porter enters from where he is', { skip }, () => {
  const { w, me, site } = schoolSite();
  const p = carrier(w, site);
  const job = p.job, home = cellOf(p);
  const a = attack(w, me, p);
  for (let i = 0; i < 100; i++) {
    w.step();
    const [x, y] = cellOf(p);
    if (w.logistics.dist(x, y, home[0], home[1]) >= 3) break;
  }
  assert.ok(w.logistics.dist(...cellOf(p), home[0], home[1]) >= 3, 'he ran some cells');
  w.combat.die(a);
  for (let i = 0; i < 40 && p.job !== job; i++) w.step();
  assert.equal(p.job, job, 'the transport resumed');
  assert.ok(delivered(w, p, site, 1500), 'the delivery still happened');
});

test('flee: snapshot round trip while the transport\'s walk is kept aside continues identically', { skip }, () => {
  const { w, me, site } = schoolSite();
  const p = carrier(w, site);
  attack(w, me, p);
  for (let i = 0; i < 8; i++) w.step();
  assert.equal(p.walks.length, 1);
  assert.ok(p.path, 'fleeing with its own walk');
  const snap = JSON.parse(JSON.stringify(w.snapshot()));
  const tr = w.terrain;
  const copy = World.restore({ ...tr, height: tr.height.slice(), cls: tr.cls.slice(), tile: tr.tile.slice() }, snap, w.rules, w.weapons);
  assert.equal(copy.hash(), w.hash());
  for (let i = 0; i < 300; i++) { w.step(); copy.step(); }
  assert.equal(copy.hash(), w.hash());
});
