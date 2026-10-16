// Construction: consumption per work step, the site panel's numbers over the build, the builder's
// wait for the first listed good, pause and resume. Spec: docs/game/units-and-jobs.md 6.2, 6.3,
// 6.4, 6.8, 6.9, 6.10; docs/ui/side-panel.md 5.2 class 15. Needs AN_DATA.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { loadMission, DATA } from './helpers/mission.ts';
import { Kind, SUB, World, type Entity } from '../src/engine/world.ts';
import { LJ, BJ, List } from '../src/engine/logistics.ts';
import { siteView } from '../src/client/hud-pages.ts';

const skip = !existsSync(`${DATA}/dv.odb`) && 'AN_DATA not set';
const SCHOOL = 55, BUILDER = 11, WOOD = 1, STONE = 2;
const TR = { Requester: 3, Fetch: 4 } as const;
const cellOf = (e: Entity): [number, number] => [Math.floor(e.x / SUB), Math.floor(e.y / SUB)];
const jobOf = (w: World, u: Entity) => (u.job ? w.sched.get(u.job) : undefined);
const panel = (b: Entity) => siteView(b).materials.map(m => `${m.local}/${m.left}`).join(' ');
const requests = (w: World, b: Entity) => w.economy.towns.reduce((n, t) => n + t.lists.reduce((k, l) => k + l.filter(x => x === b.id).length, 0), 0);

/** Pimmons mission 0 without computer players: a school (wood 2, stone 4) ordered near the town hall */
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
  return { w, me, t, r, site };
}

/** the goods are "delivered" by hand: local stock set, needed list and transport requests withdrawn */
function deliverByHand(w: World, site: Entity, goods: Record<number, number>): void {
  for (const [g, n] of Object.entries(goods)) site.local[Number(g)] = n;
  site.needed = [];
  for (const t of w.economy.towns) t.lists = t.lists.map(l => l.filter(x => x !== site.id));
}

const buildersOn = (w: World, site: Entity) => w.entities.filter(u => u.kind === Kind.Unit && u.alive && (u.oid & 0xffff) === BUILDER
  && jobOf(w, u)?.kind === LJ.Builder && jobOf(w, u)!.data[BJ.Building] === site.id);

test('construction order: one list entry per good in good order; panel = local stock / still to consume', { skip }, () => {
  const { site } = schoolSite();
  assert.deepEqual(site.order!.list, [[WOOD, 2], [STONE, 4]]);
  assert.equal(site.order!.T, 6);
  assert.equal(panel(site), '0/2 0/4', 'nothing delivered: goods on the way or requested do not count');
  assert.equal(siteView(site).percent, 0);
});

test('consumption per work step: wood first, one unit before each work tick; the panel numbers fall as the site rises', { skip }, () => {
  const { w, r, site } = schoolSite();
  deliverByHand(w, site, { [WOOD]: 2, [STONE]: 4 });
  const seen: string[] = [];
  const events: string[] = [];
  let last = '', lastCounter = -1, lastR = site.order!.R;
  for (let i = 0; i < 4000 && !site.complete; i++) {
    w.step();
    if (site.complete) break;
    const p = `${panel(site)}|${siteView(site).percent}`;
    if (p !== last) { seen.push(p); last = p; }
    const o = site.order!;
    if (o.R !== lastR) { events.push('c'); lastR = o.R; }
    if (o.started && o.counter !== lastCounter) { if (lastCounter >= 0) events.push('w'); lastCounter = o.counter; }
  }
  assert.ok(site.complete, 'the school is finished');
  assert.equal(site.hp, r.hp);
  // consume, work tick, consume, work tick, ... six times, then the four work ticks without goods
  assert.equal(events.join(''), 'cwcwcwcwcwcwwwww'.slice(0, 15));   // the last work tick completes the site (no order left)
  assert.deepEqual(seen, [
    '2/2 4/4|0',
    '1/1 4/4|0', '1/1 4/4|10',
    '4/4|10', '4/4|20',
    '3/3|20', '3/3|30',
    '2/2|30', '2/2|40',
    '1/1|40', '1/1|50',
    '|50', '|60', '|70', '|80', '|90',
  ]);
  // the goods were used up, none left at the site
  assert.equal(site.local[WOOD] + site.local[STONE], 0);
});

test('the builder waits for the first listed good although the others lie at the site; a delivery ends the wait within 15 ticks', { skip }, () => {
  const { w, site } = schoolSite();
  deliverByHand(w, site, { [STONE]: 4 });
  let builder: Entity | undefined;
  for (let i = 0; i < 3000 && !builder; i++) {
    w.step();
    builder = buildersOn(w, site).find(u => { const d = jobOf(w, u)!.data; return d[BJ.Phase] === 2 && d[BJ.Step] === 2; });
  }
  assert.ok(builder, 'a builder waits at the site');
  assert.equal(site.order!.counter, site.order!.N + site.order!.step - (site.order!.N % site.order!.step), 'no work tick yet');
  for (let i = 0; i < 300; i++) w.step();
  assert.equal(site.local[STONE], 4, 'stone is not touched while wood is missing');
  assert.equal(jobOf(w, builder!)!.data[BJ.Step], 2, 'still waiting');
  assert.equal(panel(site), '0/2 4/4');
  site.local[WOOD] = 1;
  const t0 = w.tick;
  while (site.local[WOOD] === 1 && w.tick - t0 < 40) w.step();
  assert.equal(site.local[WOOD], 0, 'the wood is consumed');
  assert.ok(w.tick - t0 <= 15, `within 15 ticks (${w.tick - t0})`);
  assert.equal(panel(site), '0/1 4/4');
});

test('stall report reproduction: a builder waiting for wood on its way; the panel shows it missing (old panel: complete)', { skip }, () => {
  const { w, t, site } = schoolSite();
  // stone already at the site; the wood is carried from the store
  site.local[STONE] = 4;
  site.needed = site.needed.filter(g => g !== STONE);
  for (let k = 0; k < 4; k++) { const i = t.lists[List.Construction].indexOf(site.id); if (i >= 0) t.lists[List.Construction].splice(i, 1); }
  t.stock[WOOD] = Math.max(t.stock[WOOD], 5);
  let found = false;
  for (let i = 0; i < 4000 && !found; i++) {
    w.step();
    const waiting = buildersOn(w, site).some(u => { const d = jobOf(w, u)!.data; return d[BJ.Phase] === 2 && d[BJ.Step] === 2; });
    const carried = w.entities.some(u => { const j = jobOf(w, u); return j?.kind === LJ.Transport && j.data[TR.Requester] === site.id && j.data[TR.Fetch] === WOOD; });
    if (waiting && carried && site.local[WOOD] === 0 && !site.needed.includes(WOOD)) {
      found = true;
      // the old panel counted (cost - needed entries): wood 2/2, stone 4/4, "all present"
      const old = `${2 - site.needed.filter(g => g === WOOD).length}/2 ${4 - site.needed.filter(g => g === STONE).length}/4`;
      assert.equal(old, '2/2 4/4');
      assert.equal(panel(site), '0/2 4/4', 'the wood on its way is not shown as present');
    }
  }
  assert.ok(found, 'the builder waited while all wood was being carried');
  for (let i = 0; i < 4000 && !site.complete; i++) w.step();
  assert.ok(site.complete, 'the site is finished once the wood arrives');
});

test('after the go-to the builder walks to the +x spot first and makes his first construction call there', { skip }, () => {
  const { w, r, site } = schoolSite();
  deliverByHand(w, site, { [WOOD]: 2, [STONE]: 4 });
  for (let i = 0; i < 3000 && site.order!.R === site.order!.T; i++) w.step();
  assert.ok(site.order!.R < site.order!.T, 'the first good was consumed');
  const [u] = buildersOn(w, site);
  const [x, y] = cellOf(site), sx = Math.max(1, r.sizeX);
  assert.deepEqual(cellOf(u), [(x + 1) & (w.size - 1), (y - (sx >> 1)) & (w.size - 1)], 'on the +x spot');
});

test('pause: the builders lose their job, requests and needed list are withdrawn, no builder or porter comes; resume restores everything', { skip }, () => {
  const { w, me, t, site } = schoolSite();
  t.stock[WOOD] = Math.max(t.stock[WOOD], 10); t.stock[STONE] = Math.max(t.stock[STONE], 10);
  // a second builder for the town, so a free builder exists while the site is paused
  const extra = w.spawnUnit(me, BUILDER, t.x + 3, t.y + 3, t.id); w.economy.joinTown(extra, t);
  let b: Entity | undefined;
  for (let i = 0; i < 3000 && !(b = buildersOn(w, site)[0]); i++) w.step();
  assert.ok(b, 'a builder is on the site');
  for (let i = 0; i < 20; i++) w.step();
  w.schedule({ type: 'building', player: me, id: site.id, action: 'pause' });
  w.step();
  assert.equal(site.paused, true);
  assert.equal(b!.job, 0, 'the builder has no job');
  assert.deepEqual(site.order!.builders, [], 'off the builder list');
  assert.deepEqual(site.needed, [], 'needed list cleared');
  assert.equal(requests(w, site), 0, 'transport requests withdrawn');
  assert.ok(!t.workerReqs.some(([ty, id]) => ty === BUILDER && id === site.id), 'no builder request filed');
  const order = JSON.stringify(site.order!.list), counter = site.order!.counter;
  // transports already under way still deliver; nothing new is fetched, no builder comes
  for (let i = 0; i < 2500; i++) w.step();
  assert.equal(buildersOn(w, site).length, 0, 'no builder works the paused site');
  assert.equal(site.order!.counter, counter, 'no work tick');
  assert.equal(JSON.stringify(site.order!.list), order, 'nothing consumed');
  const carrying = w.entities.some(u => { const j = jobOf(w, u); return j?.kind === LJ.Transport && j.data[TR.Requester] === site.id; });
  assert.equal(carrying, false, 'no transport for the site');
  assert.equal(site.paused, true);
  const local = site.local.slice();
  // resume (the same toggling command): needed = still to consume - local stock, one request each, a builder request
  w.schedule({ type: 'building', player: me, id: site.id, action: 'resume' });
  w.step();
  assert.equal(site.paused, false);
  const want: number[] = [];
  for (const [g, left] of site.order!.list) for (let k = left - local[g]; k > 0; k--) want.push(g);
  assert.deepEqual(site.needed.slice().sort(), want.slice().sort());
  assert.ok(site.needed.length === 0 || requests(w, site) > 0 || w.entities.some(u => jobOf(w, u)?.kind === LJ.Transport));
  for (let i = 0; i < 6000 && !site.complete; i++) w.step();
  assert.ok(site.complete, 'the resumed site is finished');
});

test('pause is a toggle: a second "pause" resumes; a builder ordered onto a paused site builds from the local stock', { skip }, () => {
  const { w, me, t, site } = schoolSite();
  w.logistics.buildingAction(site, 'pause');
  assert.equal(site.paused, true);
  w.logistics.buildingAction(site, 'pause');
  assert.equal(site.paused, false, 'toggled back');
  assert.equal(site.needed.length, 6, 'all six units requested again');
  w.logistics.buildingAction(site, 'pause');
  assert.equal(site.paused, true);
  // goods at the site, then a player order: the construction step does not look at the pause
  site.local[WOOD] = 2; site.local[STONE] = 4;
  const u = w.spawnUnit(me, BUILDER, t.x + 3, t.y + 3, t.id); w.economy.joinTown(u, t);
  w.schedule({ type: 'order', player: me, ids: [u.id], target: site.id });
  for (let i = 0; i < 6000 && !site.complete; i++) w.step();
  assert.ok(site.complete, 'built while paused');
  assert.equal(requests(w, site), 0, 'no goods were requested for it');
});

// ---------------------------------------------------------------- the player's delivery order (3.2, 5.5, 5.8 item 10)

const WOODCUTTER = 19;
/** goods still owed to the site: needed entries + goods to fetch of transports under way for it */
const owed = (w: World, site: Entity, g: number) => site.needed.filter(x => x === g).length
  + w.entities.filter(u => u.kind === Kind.Unit && u.alive).reduce((n, u) => n + [u.job, ...u.suspended].filter(id => {
    const j = id ? w.sched.get(id) : undefined;
    return !!j && !j.cancelled && j.kind === LJ.Transport && j.data[TR.Requester] === site.id && j.data[TR.Fetch] === g;
  }).length, 0);

/** the school site with an empty town stock (nothing is fetched) and a woodcutter carrying one wood */
function carrierAtSchool() {
  const s = schoolSite();
  s.t.stock.fill(0);
  const u = s.w.spawnUnit(s.me, WOODCUTTER, s.t.x + 4, s.t.y + 4, s.t.id); s.w.economy.joinTown(u, s.t);
  u.carryGood = WOOD; u.carryAmount = 1;
  return { ...s, u };
}

test('delivery order: an interrupted delivery gives the site its needed entry back; the site still gets every good (3.2, 5.5)', { skip }, () => {
  const { w, me, t, site, u } = carrierAtSchool();
  assert.equal(owed(w, site, WOOD), 2);
  w.schedule({ type: 'order', player: me, ids: [u.id], target: site.id });
  w.step();
  const j = jobOf(w, u)!;
  assert.equal(j.kind, LJ.Transport);
  assert.equal(j.data[TR.Requester], site.id, 'the site is the requester (constructor 0047bee0)');
  assert.equal(j.data[TR.Fetch], WOOD, 'the carried good is the good to fetch');
  assert.equal(site.needed.filter(g => g === WOOD).length, 1, 'the acceptance test removed one entry');
  assert.equal(owed(w, site, WOOD), 2, 'nothing lost: one entry needed, one under way');
  for (let i = 0; i < 6; i++) w.step();
  // the player moves him away before he arrives: the good goes back to the front, one list-1 request
  w.schedule({ type: 'move', player: me, ids: [u.id], x: t.x - 6, y: t.y - 6 });
  w.step();
  assert.ok(jobOf(w, u)?.kind !== LJ.Transport, 'the delivery ended');
  assert.equal(site.needed[0], WOOD, 're-filed at the front');
  assert.equal(site.needed.filter(g => g === WOOD).length, 2);
  assert.equal(owed(w, site, WOOD), 2);
  assert.equal(requests(w, site), 7, 'six requests of the placement + the re-filed one');
  assert.equal(u.carryAmount, 1, 'the carrier keeps his load');
  // ordered twice in a row: the second order re-files the first one's entry (net unchanged)
  w.schedule({ type: 'order', player: me, ids: [u.id], target: site.id });
  w.step();
  w.schedule({ type: 'order', player: me, ids: [u.id], target: site.id });
  w.step();
  assert.equal(owed(w, site, WOOD), 2);
  // now he delivers: one wood at the site, one still needed
  for (let i = 0; i < 1500 && u.carryAmount; i++) w.step();
  assert.equal(u.carryAmount, 0);
  assert.equal(site.local[WOOD], 1);
  assert.equal(site.needed.filter(g => g === WOOD).length, 1);
  assert.equal(panel(site), '1/2 0/4');
  // with goods in stock the rest arrives and the site is finished
  t.stock[WOOD] = 10; t.stock[STONE] = 10;
  for (let i = 0; i < 8000 && !site.complete; i++) w.step();
  assert.ok(site.complete, 'the site is finished');
});

test('old saves: a site whose needs were lost by an interrupted delivery order is re-filed on load (5.8 item 10)', { skip }, () => {
  const { w, me, site, u } = carrierAtSchool();
  w.schedule({ type: 'order', player: me, ids: [u.id], target: site.id });
  w.step();
  // the state the old build left: delivery under way without requester or good to fetch; the
  // needs of earlier interrupted deliveries lost (needed list and requests empty) while the
  // builder waits
  const snap = JSON.parse(JSON.stringify(w.snapshot()));
  snap.v = 12;
  const job = snap.sched.slots.flat().find((j: { id: number }) => j.id === u.job);
  job.data[TR.Requester] = -1; job.data[TR.Fetch] = -1;
  const s = snap.entities.find((e: Entity) => e.id === site.id);
  s.needed = [];
  for (const t of snap.economy.towns) t.lists = t.lists.map((l: number[]) => l.filter(x => x !== site.id));
  const r = World.restore(w.terrain, snap, w.rules, w.weapons);
  const site2 = r.get(site.id)!, u2 = r.get(u.id)!;
  const j2 = jobOf(r, u2)!;
  assert.equal(j2.data[TR.Requester], site.id, 'the delivery under way became an ordinary transport');
  assert.equal(j2.data[TR.Fetch], WOOD);
  assert.deepEqual(site2.needed, [WOOD, STONE, STONE, STONE, STONE], 'still to consume - local - under way');
  assert.equal(requests(r, site2), 5, 'one list-1 request each');
  // a current save is not touched
  const again = World.restore(r.terrain, JSON.parse(JSON.stringify(r.snapshot())), r.rules, r.weapons);
  assert.equal(again.get(site.id)!.needed.length, 5);
  assert.equal(requests(again, again.get(site.id)!), 5);
});

test('paused site: a delivery under way still lands in the local stock, a delivery order is refused at the door; resume re-files only what is missing (6.8, 4.4)', { skip }, () => {
  const { w, me, t, site, u } = carrierAtSchool();
  // a delivery under way when the pause comes
  w.schedule({ type: 'order', player: me, ids: [u.id], target: site.id });
  w.step();
  w.schedule({ type: 'building', player: me, id: site.id, action: 'pause' });
  w.step();
  assert.equal(site.paused, true);
  assert.deepEqual(site.needed, []);
  assert.equal(jobOf(w, u)?.kind, LJ.Transport, 'the pause does not touch a transport under way');
  for (let i = 0; i < 1500 && u.carryAmount; i++) w.step();
  assert.equal(site.local[WOOD], 1, 'delivered into the local stock while paused');
  // a second carrier ordered to the paused site: nothing is needed, so no transport; the site's
  // door admits only builders and transports: he stands idle in front of it with his load
  const v = w.spawnUnit(me, WOODCUTTER, t.x + 4, t.y + 5, t.id); w.economy.joinTown(v, t);
  v.carryGood = WOOD; v.carryAmount = 1;
  w.schedule({ type: 'order', player: me, ids: [v.id], target: site.id });
  w.step();
  assert.ok(jobOf(w, v)?.kind !== LJ.Transport, 'no delivery transport');
  assert.equal(w.logistics.mayEnter(v, site), false, 'the site door refuses a unit on a go-to');
  assert.equal(w.logistics.mayEnter(u, site), false, 'and an idle carrier');
  for (let i = 0; i < 600 && v.job; i++) w.step();
  assert.equal(v.job, 0, 'refused at the door: no job');
  assert.equal(v.carryAmount, 1, 'still carrying');
  assert.equal(site.local[WOOD], 1, 'nothing more delivered');
  // resume: still to consume (wood 2, stone 4) - local (wood 1)
  w.schedule({ type: 'building', player: me, id: site.id, action: 'resume' });
  w.step();
  assert.deepEqual(site.needed.slice().sort(), [WOOD, STONE, STONE, STONE, STONE].sort());
  assert.equal(requests(w, site), 5);
  // now the order is accepted
  w.schedule({ type: 'order', player: me, ids: [v.id], target: site.id });
  w.step();
  assert.equal(jobOf(w, v)?.kind, LJ.Transport);
  for (let i = 0; i < 1500 && v.carryAmount; i++) w.step();
  assert.equal(site.local[WOOD], 2);
});

test('drop goods (WEGWERFEN, command 0x53) during a delivery: the job ends and the site gets its need back; only the first selected unit drops (3.2)', { skip }, () => {
  const { w, me, site, u } = carrierAtSchool();
  w.schedule({ type: 'order', player: me, ids: [u.id], target: site.id });
  for (let i = 0; i < 4; i++) w.step();
  assert.equal(jobOf(w, u)?.kind, LJ.Transport);
  assert.equal(site.needed.filter(g => g === WOOD).length, 1);
  const before = requests(w, site);
  w.schedule({ type: 'unit', player: me, ids: [u.id], action: 'drop' });
  w.step();
  assert.equal(u.carryAmount, 0, 'the load is gone');
  assert.equal(u.job, 0, 'the delivery is cancelled');
  assert.equal(site.needed[0], WOOD, 'the good to fetch is re-filed at the front');
  assert.equal(owed(w, site, WOOD), 2, 'no need lost');
  assert.equal(requests(w, site), before + 1, 'one list-1 request');
  for (let i = 0; i < 300; i++) w.step();
  assert.equal(site.local[WOOD], 0, 'nothing was delivered');
  // only the first selected unit drops; a unit without a load is not touched
  const [ux, uy] = cellOf(u);
  const a = w.spawnUnit(me, WOODCUTTER, ux + 2, uy, u.town), b = w.spawnUnit(me, WOODCUTTER, ux + 3, uy, u.town);
  a.carryGood = WOOD; a.carryAmount = 1; b.carryGood = WOOD; b.carryAmount = 1;
  w.schedule({ type: 'unit', player: me, ids: [a.id, b.id], action: 'drop' });
  w.step();
  assert.equal(a.carryAmount, 0);
  assert.equal(b.carryAmount, 1, 'the second selected unit keeps its load');
});
