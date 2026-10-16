// A transport that ends early gives its requester the good back (docs/game/units-and-jobs.md 5.5
// "Early end of a transport", 6.7): the good to fetch goes back to the front of the site's needed
// list with one list-1 request until it has been dropped at the destination, picked up or not.
// A killed porter's load is lost (no pile); a live one keeps carrying it and puts it back at his
// next transport from a store. Needs AN_DATA.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { loadMission, DATA } from './helpers/mission.ts';
import { Kind, type Entity, type World } from '../src/engine/world.ts';
import { LJ, List } from '../src/engine/logistics.ts';

const skip = !existsSync(`${DATA}/dv.odb`) && 'AN_DATA not set';
const SCHOOL = 55;
/** transport job data slots (logistics.ts TR) */
const TR = { Phase: 0, Dest: 1, Source: 2, Requester: 3, Fetch: 4, Output: 5 } as const;

/** Pimmons mission 0 without computer players: a school site near the town hall, goods in stock */
function schoolSite() {
  const { world: w, mission: m } = loadMission('Pimmons.mdb', 0, DATA, false);
  const me = m.humanRace, t = w.economy.towns.find(x => x.race === me)!;
  const r = w.rules.get((me << 16) | SCHOOL)!;
  let spot: [number, number] | null = null;
  for (let rad = 5; rad < 20 && !spot; rad++)
    for (let dy = -rad; dy <= rad && !spot; dy++)
      for (let dx = -rad; dx <= rad && !spot; dx++)
        if (Math.max(Math.abs(dx), Math.abs(dy)) === rad && w.logistics.canPlace(t, r, t.x + dx, t.y + dy)) spot = [t.x + dx, t.y + dy];
  assert.ok(spot, 'a place for the school');
  w.schedule({ type: 'build', player: me, town: t.id, building: SCHOOL, x: spot![0], y: spot![1] });
  w.step();
  const site = w.entities.find(e => (e.oid & 0xffff) === SCHOOL && e.owner === me)!;
  assert.ok(site && !site.complete);
  // enough of every needed good, so a lost unit can be made good
  for (const g of new Set(site.needed)) t.stock[g] = Math.min(t.capacity, Math.max(t.stock[g], site.needed.filter(x => x === g).length + 5));
  return { w, me, t, site };
}

/** step until a porter carries a good for the site out of the store (phase 3/4); returns him and his job data */
function carrierFor(w: World, site: Entity): { p: Entity; d: number[] } {
  for (let i = 0; i < 3000; i++) {
    w.step();
    for (const u of w.entities) {
      if (u.kind !== Kind.Unit || !u.job || u.inside >= 0 || u.carryAmount <= 0) continue;
      const j = w.sched.get(u.job);
      if (j && !j.cancelled && j.kind === LJ.Transport && j.data[TR.Requester] === site.id && j.data[TR.Phase] >= 3 && u.path?.length) return { p: u, d: j.data };
    }
  }
  throw new Error('no porter carrying for the site');
}

const requests = (list: number[], id: number) => list.filter(x => x === id).length;

test('a porter killed after the pickup: the good is lost, the site gets its need back and is finished', { skip }, () => {
  const { w, t, site } = schoolSite();
  const { p, d } = carrierFor(w, site);
  const good = p.carryGood;
  assert.equal(d[TR.Fetch], good, 'the good to fetch stays set while it is carried');
  const needed = site.needed.length, reqs = requests(t.lists[List.Construction], site.id);
  const stock = t.stock[good];
  const nature = w.entities.filter(e => e.kind === Kind.Nature).length;
  w.combat.die(p);
  assert.equal(site.needed[0], good, 'the good is back at the front of the needed list');
  assert.equal(site.needed.length, needed + 1);
  assert.equal(requests(t.lists[List.Construction], site.id), reqs + 1, 'one list-1 request');
  assert.equal(t.stock[good], stock, 'the stock does not get the unit back');
  assert.equal(w.entities.filter(e => e.kind === Kind.Nature).length, nature, 'no goods pile');
  for (let i = 0; i < 12000 && !site.complete; i++) w.step();
  assert.ok(site.complete, 'the site is finished');
});

test('a porter whose transport is cancelled after the pickup keeps carrying; the need is re-filed and the good comes back', { skip }, () => {
  const { w, me, t, site } = schoolSite();
  const { p, d } = carrierFor(w, site);
  const good = p.carryGood;
  const needed = site.needed.length;
  // a player order replaces the transport (here: walk a few cells away)
  const [x, y] = [Math.floor(p.x / 256), Math.floor(p.y / 256)];
  w.schedule({ type: 'move', player: me, ids: [p.id], x: x + 2, y: y + 2 });
  w.step();
  assert.equal(p.carryAmount, 1, 'he still carries the good');
  assert.equal(p.carryGood, good);
  assert.equal(site.needed.length, needed + 1, 'the need is re-filed');
  assert.equal(site.needed[0], good);
  assert.ok(d[TR.Fetch] < 0, 'the job owes nothing any more');
  // he is a free porter: his next transport from a store puts the good down there first
  let back = false;
  for (let i = 0; i < 6000 && !(back && site.complete); i++) {
    w.step();
    if (!back && p.carryAmount === 0) back = true;
  }
  assert.ok(back, 'the carried good went back into the economy');
  assert.ok(site.complete, 'the site is finished');
  assert.equal(t.race, me);
});
