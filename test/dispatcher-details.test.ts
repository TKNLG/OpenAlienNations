// Logistics details of the town dispatcher and the transport job (docs/game/units-and-jobs.md
// 5.2, 5.3, 5.5, 5.7): the free-porter list kept from the last transport pass and read by the
// leisure job, a porter already carrying the needed good goes straight to the site, the pickup
// rule at the source (no fallback to the output), outputs taken at the destination without a
// stock test, the order of checks for trainee requests and their delay, operator requests with the
// operator inside. Needs AN_DATA.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { loadMission, DATA } from './helpers/mission.ts';
import { Kind, World, type Entity } from '../src/engine/world.ts';
import { T } from '../src/engine/economy.ts';
import { LJ, List, Logistics } from '../src/engine/logistics.ts';

const skip = !existsSync(`${DATA}/dv.odb`) && 'AN_DATA not set';
const SCHOOL = 55, TAVERN = 58;
/** transport job data slots (logistics.ts TR) */
const TR = { Phase: 0, Dest: 1, Source: 2, Requester: 3, Fetch: 4, Output: 5 } as const;
const steps = (w: World, n: number) => { for (let i = 0; i < n; i++) w.step(); };
const type = (e: Entity) => e.oid & 0xffff;
const job = (w: World, u: Entity) => { const j = u.job ? w.sched.get(u.job) : undefined; return j && !j.cancelled ? j : undefined; };
/** a job still scheduled (a transport waits behind the leave job while its unit comes out, 4.10) */
const alive = (w: World, id: number) => { const j = w.sched.get(id); return !!j && !j.cancelled; };

/** Pimmons mission 0 without computer players: a school site placed, the dispatcher due next tick */
function schoolSite() {
  const { world: w, mission: m } = loadMission('Pimmons.mdb', 0, DATA, false);
  const me = m.humanRace, t = w.economy.towns.find(x => x.race === me)!;
  // the start set comes out of the town hall first (4.10): wait until every porter stands free
  const all = () => w.entities.filter(u => u.kind === Kind.Unit && u.town === t.id && type(u) === T.Porter);
  for (let i = 0; i < 400 && !all().every(u => Logistics.free(u, 0)); i++) w.step();
  assert.ok(all().every(u => Logistics.free(u, 0)), 'the porters are out');
  const r = w.rules.get((me << 16) | SCHOOL)!;
  let spot: [number, number] | null = null;
  for (let rad = 5; rad < 20 && !spot; rad++)
    for (let dy = -rad; dy <= rad && !spot; dy++)
      for (let dx = -rad; dx <= rad && !spot; dx++)
        if (Math.max(Math.abs(dx), Math.abs(dy)) === rad && w.logistics.canPlace(t, r, t.x + dx, t.y + dy)) spot = [t.x + dx, t.y + dy];
  assert.ok(spot, 'a place for the school');
  w.schedule({ type: 'build', player: me, town: t.id, building: SCHOOL, x: spot![0], y: spot![1] });
  w.step();
  const site = w.entities.find(e => type(e) === SCHOOL && e.owner === me)!;
  assert.ok(site && !site.complete);
  const porters = w.entities.filter(u => u.kind === Kind.Unit && u.town === t.id && type(u) === T.Porter);
  const hall = w.get(t.hall)!;
  return { w, me, t, site, porters, hall };
}

test('a porter already carrying the destination\'s first needed good goes straight there, without a source (5.3)', { skip }, () => {
  const { w, t, site, porters, hall } = schoolSite();
  for (const g of new Set(site.needed)) t.stock[g] = Math.max(t.stock[g], 5);
  const g = site.needed.find(x => t.stock[x] > 0)!;
  // every porter carries one unit of that good (left over from an interrupted transport)
  for (const p of porters) { p.carryGood = g; p.carryAmount = 1; }
  const needBefore = site.needed.filter(x => x === g).length;
  steps(w, 2);
  const direct = porters.map(p => ({ p, j: job(w, p) })).find(x => x.j?.kind === LJ.Transport && x.j.data[TR.Requester] === site.id);
  assert.ok(direct, 'a transport for the site');
  const d = direct!.j!.data;
  assert.equal(d[TR.Source], -1, 'no source: no stop at the store');
  assert.equal(d[TR.Fetch], g, 'the needed entry is still popped as the good to fetch');
  assert.ok(site.needed.filter(x => x === g).length < needBefore, 'popped from the needed list');
  const p = direct!.p;
  const stock = t.stock[g];
  let enteredHall = false;
  for (let i = 0; i < 1500 && p.carryAmount > 0; i++) { w.step(); if (p.inside === hall.id) enteredHall = true; }
  assert.equal(p.carryAmount, 0, 'delivered');
  assert.equal(enteredHall, false, 'never went into the store');
  assert.equal(t.stock[g], stock, 'nothing taken from the town stock for this trip');
});

test('at the source only the good to fetch is picked up; none in stock: nothing, the job fails and re-files (5.5)', { skip }, () => {
  const { w, t, site, porters } = schoolSite();
  assert.ok(porters.length >= 2, 'two porters');
  const g = site.needed[0];
  const h = [0, 1, 2, 3, 4, 5, 6, 7, 8].find(x => x !== g)!;
  // two requests for the last unit of g; the site also has outputs h, and the store holds h
  for (let k = 0; k < 9; k++) t.stock[k] = 0;
  t.stock[g] = 1; t.stock[h] = 3;
  site.needed = [g, g];
  site.outputs = [h, h];
  site.local[h] = 2;
  t.lists = [[], [site.id, site.id], [], []];
  steps(w, 2);
  const runs = porters.map(p => ({ p, j: job(w, p) })).filter(x => x.j?.kind === LJ.Transport && x.j.data[TR.Requester] === site.id);
  assert.equal(runs.length, 2, 'two porters sent for the last unit');
  assert.ok(runs.every(x => x.j!.data[TR.Fetch] === g && x.j!.data[TR.Output] === h), 'each fetches g and collects h');
  const carried = new Map<number, Set<number>>();
  let atEnd: { needed: number[]; outputs: number[]; list1: boolean; stock: number } | null = null;
  for (let i = 0; i < 1500 && runs.some(x => alive(w, x.j!.id)); i++) {
    const before = runs.map(x => alive(w, x.j!.id));
    w.step();
    runs.forEach(({ p, j }, k) => {
      if (before[k] && !alive(w, j!.id) && !carried.has(p.id) && !atEnd)
        atEnd = { needed: site.needed.slice(), outputs: site.outputs.slice(), list1: t.lists[List.Construction].includes(site.id), stock: t.stock[g] };
      if (!alive(w, j!.id) || p.carryAmount <= 0 || p.inside >= 0) return;
      const s = carried.get(p.id) ?? new Set(); s.add(p.carryGood); carried.set(p.id, s);
    });
  }
  // one delivered g (and took an h back to the store); the other came out of the store empty
  const empty = runs.filter(x => !carried.has(x.p.id));
  assert.equal(empty.length, 1, 'one porter picked up nothing (no fallback to the output h in the store)');
  const e = atEnd as { needed: number[]; outputs: number[]; list1: boolean; stock: number } | null;
  assert.ok(e, 'his job ended');
  assert.equal(e!.stock, 0);
  assert.equal(e!.needed[0], g, 'the need is re-filed at the front');
  assert.equal(e!.outputs[0], h, 'the output is re-filed too');
  assert.ok(e!.list1, 'with a list-1 request');
});

test('an output taken at the destination: no stock test, the store becomes destination and requester (5.5)', { skip }, () => {
  const { w, t, site, porters, hall } = schoolSite();
  const g = site.needed[0];
  const h = [0, 1, 2, 3, 4, 5, 6, 7, 8].find(x => x !== g)!;
  t.stock[g] = 5;
  site.needed = [g];
  site.outputs = [h];
  site.local[h] = 0;   // no stock behind the output entry
  t.lists = [[], [site.id], [], []];
  steps(w, 2);
  const run = porters.map(p => ({ p, j: job(w, p) })).find(x => x.j?.kind === LJ.Transport && x.j.data[TR.Requester] === site.id)!;
  assert.ok(run, 'a combined trip');
  const d = run.j!.data;
  for (let i = 0; i < 1500 && !(run.p.carryGood === h && run.p.carryAmount > 0); i++) w.step();
  assert.equal(run.p.carryGood, h, 'the output was taken anyway');
  assert.equal(site.local[h], -1, 'the local stock went below 0');
  assert.equal(d[TR.Dest], hall.id, 'turned round to the store');
  assert.equal(d[TR.Requester], hall.id, 'which is now the requester');
  assert.equal(d[TR.Fetch], h, 'the collected output is the good to fetch');
  const stock = t.stock[h];
  for (let i = 0; i < 1500 && alive(w, run.j!.id); i++) w.step();
  assert.equal(t.stock[h], stock + 1, 'delivered to the store');
});

test('free-porter list: kept from the last transport pass; the leisure job reads only that list (5.3, 5.7)', { skip }, () => {
  const { w, t, porters } = schoolSite();
  steps(w, 2);   // the first transport pass
  const listed = new Set(t.freePorters);
  for (const id of listed) assert.ok(Logistics.free(w.get(id)!, 0), 'listed porters were free');
  // a free porter who is not on the list (free after the pass) is no leisure candidate
  const extra = w.spawnUnit(t.race, T.Porter, t.x + 3, t.y + 3, t.id);
  w.economy.joinTown(extra, t);
  extra.idle = 5;
  t.lists = [[], [], [], []];
  const leisure = { id: -1, kind: LJ.Leisure, owner: t.id, hold: 0, cancelled: false, data: [] };
  const rand = w.rand.state;
  t.freePorters = [];
  assert.equal(w.logistics.runJob(leisure), 199);
  assert.equal(extra.idle, 5, 'an empty list: nobody is looked at');
  assert.equal(w.rand.state, rand, 'and nothing is drawn');
  // on the list (and idle long enough) he is: the counter goes up and the category is drawn
  t.freePorters = [extra.id];
  w.logistics.runJob(leisure);
  assert.ok(extra.idle === 6 || extra.idle === -1, 'handled');
  assert.ok(w.rand.state !== rand, 'rand() drawn');
  // a unit that is no longer a porter leaves the list
  const other = porters[0];
  const oldOid = other.oid;
  other.oid = (other.oid & 0xffff0000) | T.Builder;
  t.freePorters = [other.id];
  w.logistics.runJob(leisure);
  assert.deepEqual(t.freePorters, [], 'non-porters are dropped from the list');
  other.oid = oldOid;
});

test('free-porter list and its migration survive save / restore (snapshot 19)', { skip }, () => {
  const { w, t } = schoolSite();
  steps(w, 30);
  t.freePorters = t.freePorters.slice(0, 1);
  const snap = w.snapshot();
  const back = World.restore(w.terrain, snap, w.rules, w.weapons);
  assert.deepEqual(back.economy.town(t.id)!.freePorters, t.freePorters);
  assert.equal(back.hash(), w.hash());
  const old = JSON.parse(JSON.stringify(snap));
  old.v = 18;
  for (const x of old.economy.towns) delete x.freePorters;
  const mig = World.restore(w.terrain, old, w.rules, w.weapons);
  const free = mig.entities.filter(u => u.kind === Kind.Unit && u.town === t.id && type(u) === T.Porter && Logistics.free(u, 0)).map(u => u.id);
  assert.deepEqual(mig.economy.town(t.id)!.freePorters, free, 'an old save starts with the porters free now');
});

test('trainee request: searched first, kept while no porter is free even if not needed any more; delay 5 (5.2)', { skip }, () => {
  const { w, t, site, porters } = schoolSite();
  w.logistics.complete(site);
  assert.ok(site.complete && site.active, 'the school is active');
  const pupil = [...w.rules.values()].find(r => r.kind === Kind.Unit && r.group === t.race && r.madeAt === SCHOOL && r.type !== T.Porter)!;
  assert.ok(pupil, 'a type trained at the school');
  t.lists = [[], [], [], []];
  // nobody free: every porter in another group
  for (const p of porters) p.group = 7;
  w.economy.players[t.race]!.money = 10000;
  assert.ok(w.logistics.train(site, pupil.type));
  const req = () => t.workerReqs.filter(([ty, b]) => ty === T.Porter && b === site.id).length;
  assert.equal(req(), 1, 'a porter request is filed');
  steps(w, 45);
  assert.equal(req(), 1, 'kept while no porter is free');
  w.logistics.cancelTraining(site, 0);
  assert.equal(site.queue.length, 0);
  steps(w, 45);
  assert.equal(req(), 1, 'still kept: the search comes first');
  // one porter free again: found, the training has no unfilled order, he gets nothing; dropped
  const p = porters[0];
  p.group = 0;
  steps(w, 25);
  assert.equal(req(), 0, 'dropped at the first run that finds a free porter');
  assert.equal(p.job, 0, 'the porter got no job');
  // a new order: the porter is sent with first delay 5
  assert.ok(w.logistics.train(site, pupil.type));
  let created = -1;
  for (let i = 0; i < 25 && created < 0; i++) { w.step(); const j = job(w, p); if (j?.kind === LJ.Answer) created = w.tick; }
  assert.ok(created >= 0, 'an answer-request job');
  const j = job(w, p)!;
  let first = -1;
  for (let i = 0; i < 10 && first < 0; i++) { w.step(); if (j.data[0] !== 0) first = w.tick; }
  assert.equal(first - created, 5, 'first run 5 ticks after the dispatcher gave it');
});

test('operator request for a building whose operator is inside is not dropped: a free unit of that type is sent (5.2)', { skip }, () => {
  const { world: w, mission: m } = loadMission('Pimmons.mdb', 4, DATA, false);
  const t = w.economy.towns.find(x => x.race === m.humanRace)!;
  const tavern = w.entities.find(e => e.kind === Kind.Building && e.town === t.id && type(e) === TAVERN)!;
  assert.ok(tavern.active, 'the landlord is inside');
  const op = w.rules.get(tavern.oid)!.operator;
  const u = w.spawnUnit(t.race, op, t.x + 4, t.y + 4, t.id);
  w.economy.joinTown(u, t);
  w.logistics.requestWorker(t, op, tavern.id);
  let sent = false;
  for (let i = 0; i < 30 && !sent; i++) { w.step(); const j = job(w, u); if (j?.kind === LJ.Answer && j.data[1] === tavern.id) sent = true; }
  assert.ok(sent, 'the free unit is sent to the active building');
});
