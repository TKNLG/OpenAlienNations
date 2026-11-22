// Diplomacy and trade on a real mission (needs AN_DATA = the game's Data folder).
// Spec: docs/game/ai-diplomacy-trade.md sections 3 and 4.
//
// Pimmons.mdb mission 4 has a human Pimmon town and a computer Amazon town, both with an active
// embassy (diplomat inside) and an active market, at ceasefire. The modules are driven directly;
// until the World dispatches their jobs itself, the test routes job kinds 0x20 and 0x38 to them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { loadMission, DATA } from './helpers/mission.ts';
import { Kind, type World, type Entity } from '../src/engine/world.ts';
import type { Town } from '../src/engine/economy.ts';
import { Trade, isTradeJob, MF, MERCHANT } from '../src/engine/trade.ts';
import { Diplomacy, isDiplomacyJob, Rel, EMBASSY } from '../src/engine/diplomacy.ts';

const skip = !existsSync(`${DATA}/dv.odb`) && 'AN_DATA not set';
const AMAZONS = 0, PIMMONS = 1;

/** the world's own modules once integrated, otherwise new ones with a job-dispatch shim */
function attach(w: World): { trade: Trade; dip: Diplomacy } {
  const host = w as unknown as { trade?: Trade; diplomacy?: Diplomacy };
  if (host.trade && host.diplomacy) return { trade: host.trade, dip: host.diplomacy };
  const trade = new Trade(w), dip = new Diplomacy(w);
  const eco = w.economy, run = eco.runJob.bind(eco);
  eco.runJob = job => (isTradeJob(job.kind) ? trade.runJob(job) : isDiplomacyJob(job.kind) ? dip.runJob(job) : run(job));
  return { trade, dip };
}

function mission4() {
  const { world: w } = loadMission('Pimmons.mdb', 4, DATA, false);
  const { trade, dip } = attach(w);
  const town = (race: number) => w.economy.towns.find(t => t.race === race)!;
  const building = (race: number, type: number) => w.entities.find(e => e.kind === Kind.Building && e.owner === race && (e.oid & 0xffff) === type)!;
  return { w, trade, dip, pim: town(PIMMONS), ama: town(AMAZONS), embassy: (race: number) => building(race, EMBASSY) };
}

function stepUntil(w: World, done: () => boolean, max: number): number {
  for (let i = 0; i < max; i++) { if (done()) return i; w.step(); }
  throw new Error(`condition not reached in ${max} ticks`);
}

test('relations: initial table, first hit, embassy contact and closure', { skip }, () => {
  const { w, dip, embassy } = mission4();
  assert.equal(dip.relation(AMAZONS, PIMMONS), Rel.Ceasefire, 'Pimmons 4 starts at ceasefire (mdb.md)');
  assert.equal(dip.relation(PIMMONS, PIMMONS), -1);
  // being hit at ceasefire or peace means war (combat.md 11); at war nothing changes
  dip.onHit(AMAZONS, PIMMONS);
  assert.equal(dip.relation(PIMMONS, AMAZONS), Rel.War);
  assert.equal(w.economy.players[PIMMONS]!.relations[AMAZONS], Rel.War, 'kept symmetric');
  // closing the only embassy breaks all ties (3.3)
  const pe = embassy(PIMMONS);
  pe.active = false;
  dip.embassyDeactivated(pe);
  assert.equal(dip.relation(PIMMONS, AMAZONS), Rel.None);
  // re-opening it makes contact with the Amazons' active embassy: war
  pe.active = true;
  w.tick = 10;
  w.events = [];
  dip.embassyActivated(pe);
  assert.equal(dip.relation(PIMMONS, AMAZONS), Rel.War);
  assert.equal(dip.relation(PIMMONS, 2), Rel.None, 'the Sajiki have no embassy');
  assert.ok(!w.events.some(e => e.race === AMAZONS), 'computer players have no advisor');
  // the mission's table again, later write wins
  dip.initRelations([{ race: 0, relations: [0, 3, 1] }, { race: 1, relations: [2, 0, 0] }, { race: 2, relations: [3, 0, 0] }] as never);
  assert.equal(dip.relation(0, 1), 2, 'block 1 written after block 0');
  assert.equal(dip.relation(0, 2), 3, 'block 2 written last');
});

test('diplomat carries a peace offer; refusal; war is always accepted', { skip }, () => {
  const { w, dip, embassy } = mission4();
  const pe = embassy(PIMMONS), ae = embassy(AMAZONS);
  const diplomat = w.get(pe.operatorId)!;
  assert.equal(diplomat.inside, pe.id);
  const offer = (state: number) => dip.apply({ type: 'diplomacy', player: PIMMONS, action: 'offer', embassy: pe.id, race: AMAZONS, state });
  const home = () => diplomat.job === 0 && diplomat.inside === pe.id;

  offer(Rel.Peace);
  w.step(); w.step();   // a job created with delay 1 runs in the second tick
  assert.ok(w.logistics.leaving(diplomat), 'the embassy ejects him (leave job, units-and-jobs.md 4.10)');
  for (let i = 0; i < 20; i++) w.step();   // door opens after 10 ticks, he is put outside 10 ticks later
  assert.equal(diplomat.inside, -1, 'he leaves on the errand');
  assert.equal(pe.active, true, 'an errand does not deactivate the embassy');
  assert.deepEqual(dip.errand(PIMMONS), { diplomat: diplomat.id, target: AMAZONS, state: Rel.Peace, decided: false });
  stepUntil(w, () => diplomat.inside === ae.id, 6000);
  const tIn = w.tick;
  assert.equal(dip.relation(PIMMONS, AMAZONS), Rel.Ceasefire, 'in, not decided yet');
  // the host embassy's operator job ejects him 100 ticks after he entered (3.3); the errand stays
  // blocked inside until the leave job has put him outside, then decides (3.4 step 3)
  stepUntil(w, () => w.logistics.leaving(diplomat), 200);
  assert.equal(w.tick - tIn, 100, 'ejected by the host embassy 100 ticks after entering');
  assert.equal(dip.relation(PIMMONS, AMAZONS), Rel.Ceasefire, 'not decided while inside');
  stepUntil(w, () => dip.relation(PIMMONS, AMAZONS) === Rel.Peace, 60);
  assert.equal(diplomat.inside, -1, 'decided once he is outside');
  assert.ok(w.tick - tIn >= 120 && w.tick - tIn <= 130, `decided ${w.tick - tIn} ticks after entering`);
  assert.ok(w.events.some(e => e.race === PIMMONS && e.mentor === 47 + AMAZONS), 'mentor#47+target');
  stepUntil(w, home, 6000);

  // the Amazons refuse ceasefire offers... but a ceasefire offered to a peace partner is a downgrade, always accepted
  dip.setAccept(AMAZONS, PIMMONS, 'ceasefire', false);
  assert.equal(dip.accepts(AMAZONS, PIMMONS, Rel.Ceasefire), true);
  dip.setAccept(AMAZONS, PIMMONS, 'peace', false);
  dip.setRelation(PIMMONS, AMAZONS, Rel.Ceasefire);
  offer(Rel.Peace);
  stepUntil(w, () => diplomat.inside === ae.id, 6000);
  stepUntil(w, () => w.events.some(e => e.race === PIMMONS && e.mentor === 44 + AMAZONS), 200);
  assert.equal(dip.relation(PIMMONS, AMAZONS), Rel.Ceasefire, 'peace refused');
  stepUntil(w, home, 6000);

  offer(Rel.War);
  stepUntil(w, () => dip.relation(PIMMONS, AMAZONS) === Rel.War, 6000);
  assert.ok(w.events.some(e => e.race === PIMMONS && e.mentor === 56 + AMAZONS));

  // recall (3.4 step 6): the errand is cancelled, so the embassy loses him and is deactivated; it
  // is the Pimmons' last embassy, so every relation drops to 0; walking back in activates it anew
  // and first contact means war
  stepUntil(w, home, 6000);
  const recall = () => dip.apply({ type: 'diplomacy', player: PIMMONS, action: 'recall', embassy: pe.id });
  recall();
  w.step();
  assert.equal(diplomat.job, 0, 'no errand: a recall does nothing');
  assert.equal(pe.active, true);
  dip.setRelation(PIMMONS, AMAZONS, Rel.Peace);
  offer(Rel.Peace);
  for (let i = 0; i < 30; i++) w.step();
  assert.equal(diplomat.inside, -1, 'out on the errand');
  w.events.length = 0;
  recall();
  assert.equal(dip.errand(PIMMONS), null, 'the errand is gone');
  assert.equal(pe.active, false, 'the embassy lost its diplomat');
  assert.equal(pe.operatorId, -1);
  assert.equal(dip.relation(PIMMONS, AMAZONS), Rel.None, 'last embassy closed: relations reset');
  assert.ok(w.events.some(e => e.race === PIMMONS && e.mentor === 11), 'mentor#11 "Betrieb eingestellt"');
  stepUntil(w, () => diplomat.inside === pe.id, 3000);
  assert.equal(pe.active, true, 'back inside: active again');
  assert.equal(pe.operatorId, diplomat.id);
  assert.equal(dip.relation(PIMMONS, AMAZONS), Rel.War, 'first contact: war');
  stepUntil(w, home, 3000);

  // a recall while he is still inside his embassy right after the offer: the same
  dip.setRelation(PIMMONS, AMAZONS, Rel.Peace);
  offer(Rel.Peace);
  w.step(); w.step();
  assert.equal(diplomat.inside, pe.id);
  recall();
  assert.equal(pe.active, false);
  assert.equal(dip.relation(PIMMONS, AMAZONS), Rel.None);
  stepUntil(w, () => pe.active, 3000);
  assert.equal(dip.relation(PIMMONS, AMAZONS), Rel.War);
  stepUntil(w, home, 3000);

  // commands of other players or on foreign embassies are ignored
  dip.apply({ type: 'diplomacy', player: AMAZONS, action: 'offer', embassy: pe.id, race: PIMMONS, state: Rel.Peace });
  w.step();
  assert.equal(diplomat.job, 0);
  // the check boxes toggle (command 0x5A, 3.5): the value sent is not used
  dip.apply({ type: 'diplomacy', player: PIMMONS, action: 'accept', race: AMAZONS, kind: 'peace', value: false });
  assert.equal(dip.acceptPeace[PIMMONS][AMAZONS], 0);
  dip.apply({ type: 'diplomacy', player: PIMMONS, action: 'accept', race: AMAZONS, kind: 'peace', value: false });
  assert.equal(dip.acceptPeace[PIMMONS][AMAZONS], 1, 'a second click turns it back on');
  dip.apply({ type: 'diplomacy', player: PIMMONS, action: 'accept', race: AMAZONS, kind: 'ceasefire', value: true });
  assert.equal(dip.acceptCeasefire[PIMMONS][AMAZONS], 0);
});

test('market settings: initial values, commands, ranges', { skip }, () => {
  const { w, trade, pim, ama } = mission4();
  assert.equal(trade.get(pim.id, 4, MF.MaxStock), 25);
  assert.equal(trade.get(pim.id, 4, MF.MinPrice), 5, 'food base price');
  assert.equal(trade.get(pim.id, 5, MF.MaxPrice), 60, 'weapons base price');
  assert.equal(trade.get(pim.id, 4, MF.Sell), 0);
  assert.equal(trade.table.length, 0, 'reading creates nothing');
  const set = (player: number, town: Town, field: 'minPrice' | 'sell' | 'minStock', value: number) =>
    trade.apply({ type: 'market', player, town: town.id, good: 4, field, value });
  set(PIMMONS, pim, 'minPrice', 999);
  assert.equal(trade.get(pim.id, 4, MF.MinPrice), 10, 'price slider goes to 2 x base');
  set(PIMMONS, pim, 'sell', 7);
  assert.equal(trade.get(pim.id, 4, MF.Sell), 1);
  set(PIMMONS, pim, 'minStock', -3);
  assert.equal(trade.get(pim.id, 4, MF.MinStock), 0);
  set(PIMMONS, ama, 'sell', 1);
  assert.equal(trade.get(ama.id, 4, MF.Sell), 0, 'foreign markets cannot be changed');
  // snapshot round trip keeps the digest
  const copy = new Trade(w);
  copy.restore(JSON.parse(JSON.stringify(trade.snapshot())));
  const dig = (t: Trade) => { const out: number[] = []; t.digest(v => out.push(v)); return out.join(','); };
  assert.equal(dig(copy), dig(trade));
});

test('worked example 6.3: the buyer price ceiling, payment at the sale price', { skip }, () => {
  const { w, trade, dip, pim, ama } = mission4();
  dip.setRelation(PIMMONS, AMAZONS, Rel.Peace);
  // human Pimmon town A: food 40, sell on, min stock 15, min price 10
  pim.capacity = 50; pim.stock[4] = 40;
  trade.set(pim.id, 4, MF.Sell, 1); trade.set(pim.id, 4, MF.MinStock, 15); trade.set(pim.id, 4, MF.MinPrice, 10);
  // computer Amazon town D: capacity 50, food 8; the AI rule (4.6) gives buy on, max stock 37, max price 4
  ama.capacity = 50; ama.stock.fill(0); ama.stock[4] = 8;
  trade.computerSettings(ama);
  assert.equal(trade.get(ama.id, 4, MF.Buy), 1);
  assert.equal(trade.get(ama.id, 4, MF.MaxStock), 37);
  assert.equal(trade.get(ama.id, 4, MF.MaxPrice), 4);
  const u = w.spawnUnit(PIMMONS, MERCHANT, pim.x, pim.y + 3, pim.id);
  const money = () => [w.economy.players[PIMMONS]!.money, w.economy.players[AMAZONS]!.money];
  const [h0, a0] = money();
  assert.equal(trade.exchange(u, pim, ama, true), -1, '(4 - 10) x 5 < 0: nothing loaded');
  assert.equal(u.carryAmount, 0);
  trade.set(pim.id, 4, MF.MinPrice, 3);
  assert.equal(trade.exchange(u, pim, ama, true), 4);
  assert.deepEqual([u.carryGood, u.carryAmount], [4, 5]);
  assert.equal(pim.stock[4], 35);
  assert.deepEqual(money(), [h0 + 15, a0], 'the human receives 3 x 5, the computer pays nothing');
  // at D he unloads min(5, 37 - 8) = 5 food
  trade.exchange(u, ama, pim, false);
  assert.equal(ama.stock[4], 13);
  assert.equal(u.carryAmount, 0);
  // the reverse direction, human buyer: limited by his money, paid at D's sale price
  trade.set(ama.id, 1, MF.Sell, 1); trade.set(ama.id, 1, MF.MinPrice, 10);
  ama.stock[1] = 30;
  trade.set(pim.id, 1, MF.Buy, 1); trade.set(pim.id, 1, MF.MaxStock, 40);
  w.economy.players[PIMMONS]!.money = 25;
  const a1 = w.economy.players[AMAZONS]!.money;
  assert.equal(trade.exchange(u, ama, pim, false), 1);
  assert.equal(u.carryAmount, 2, '25 / 10 = 2 units affordable');
  assert.deepEqual(money(), [5, a1 + 20]);
});

test('a merchant runs a route between the two markets and stops when peace ends', { skip }, () => {
  const { w, trade, dip, pim, ama } = mission4();
  dip.setRelation(PIMMONS, AMAZONS, Rel.Peace);
  assert.deepEqual(trade.partners(pim).map(t => t.id), [ama.id]);
  assert.deepEqual(trade.partners(pim, true), [], 'the AI flag test: nobody buys or sells yet');
  trade.set(pim.id, 1, MF.Sell, 1); trade.set(pim.id, 1, MF.MinPrice, 4);
  trade.set(ama.id, 1, MF.Buy, 1); trade.set(ama.id, 1, MF.MaxStock, 25); trade.set(ama.id, 1, MF.MaxPrice, 6);
  const u: Entity = w.spawnUnit(PIMMONS, MERCHANT, pim.x + 2, pim.y + 4, pim.id);
  w.economy.joinTown(u, pim);
  // one end only: a paused route (blocked 599); the other end keeps the paused job (4.4)
  trade.apply({ type: 'route', player: PIMMONS, unit: u.id, action: 'set', from: pim.id, to: -1 });
  assert.deepEqual(trade.routeOf(u), { from: pim.id, to: -1, leg: 1, paused: true });
  const job0 = u.job;
  trade.apply({ type: 'route', player: PIMMONS, unit: u.id, action: 'set', from: -1, to: ama.id });
  assert.deepEqual(trade.routeOf(u), { from: pim.id, to: ama.id, leg: 1, paused: true });
  assert.equal(u.job, job0, 'the paused route job is kept');
  trade.apply({ type: 'route', player: PIMMONS, unit: u.id, action: 'start' });
  assert.equal(trade.routeOf(u)?.paused, false);
  const wood0 = pim.stock[1], amaWood0 = ama.stock[1], m0 = w.economy.players[PIMMONS]!.money;
  stepUntil(w, () => u.carryAmount > 0, 3000);
  assert.deepEqual([u.carryGood, u.carryAmount], [1, 5]);
  assert.equal(pim.stock[1], wood0 - 5);
  assert.equal(w.economy.players[PIMMONS]!.money, m0 + 20, '5 wood at 4');
  stepUntil(w, () => ama.stock[1] > amaWood0, 8000);
  assert.equal(ama.stock[1], amaWood0 + 5);
  assert.equal(u.carryAmount, 0);
  // the market ejected him at once (T4); "stop" does nothing while he is on his way out (T7)
  assert.ok(w.logistics.leaving(u), 'ejected right after the trade');
  trade.apply({ type: 'route', player: PIMMONS, unit: u.id, action: 'stop' });
  assert.equal(trade.routeOf(u)?.paused, false, 'ignored while leaving');
  stepUntil(w, () => !w.logistics.leaving(u) && u.inside < 0, 200);
  // stop and start
  trade.apply({ type: 'route', player: PIMMONS, unit: u.id, action: 'stop' });
  assert.equal(trade.routeOf(u)?.paused, true);
  for (let i = 0; i < 50; i++) w.step();
  assert.equal(u.path, null, 'a paused merchant stands');
  trade.apply({ type: 'route', player: PIMMONS, unit: u.id, action: 'start' });
  // a town click on the running route keeps it running and redirects it (4.4 "Route command")
  stepUntil(w, () => !!u.path, 600);
  const job1 = u.job;
  trade.apply({ type: 'route', player: PIMMONS, unit: u.id, action: 'set', from: -1, to: ama.id });
  assert.equal(u.job, job1, 'the running route job is kept');
  assert.deepEqual(trade.routeOf(u), { from: pim.id, to: ama.id, leg: 1, paused: false }, 'redirected to B');
  // peace ends: at his next run (mid-walk) he turns round to his own market and the route ends there
  stepUntil(w, () => !!u.path && u.inside < 0, 3000);
  dip.setRelation(PIMMONS, AMAZONS, Rel.Ceasefire);
  for (let i = 0; i < 30; i++) w.step();
  assert.ok(trade.routeOf(u) === null || (u.job !== 0 && u.path !== null), 'turned round on the spot');
  stepUntil(w, () => u.job === 0, 8000);
  assert.equal(trade.routeOf(u), null);
  // no peace test in the command: the route is made, and its first run turns him home (4.4)
  trade.apply({ type: 'route', player: PIMMONS, unit: u.id, action: 'set', from: pim.id, to: ama.id });
  assert.ok(trade.routeOf(u) !== null, 'made without a peace test');
  stepUntil(w, () => u.job === 0, 8000);
  assert.equal(trade.routeOf(u), null, 'ended at A');
  // foreign merchants are refused
  trade.apply({ type: 'route', player: AMAZONS, unit: u.id, action: 'set', from: pim.id, to: -1 });
  assert.equal(trade.routeOf(u), null);
});

test('deterministic: two runs with the same commands end in the same state', { skip }, () => {
  const run = () => {
    const { w, trade, dip, pim, ama, embassy } = mission4();
    const pe = embassy(PIMMONS);
    dip.apply({ type: 'diplomacy', player: PIMMONS, action: 'offer', embassy: pe.id, race: AMAZONS, state: Rel.Peace });
    trade.set(pim.id, 2, MF.Sell, 1); trade.set(ama.id, 2, MF.Buy, 1);
    const u = w.spawnUnit(PIMMONS, MERCHANT, pim.x + 2, pim.y + 4, pim.id);
    w.economy.joinTown(u, pim);
    let started = false;
    for (let i = 0; i < 4000; i++) {
      if (!started && dip.relation(PIMMONS, AMAZONS) === Rel.Peace) {
        trade.apply({ type: 'route', player: PIMMONS, unit: u.id, action: 'set', from: pim.id, to: ama.id });
        started = true;
      }
      w.step();
    }
    const out: number[] = [w.hash()];
    trade.digest(v => out.push(v)); dip.digest(v => out.push(v));
    const snap = { t: trade.snapshot(), d: dip.snapshot() };
    const t2 = new Trade(w), d2 = new Diplomacy(w);
    t2.restore(JSON.parse(JSON.stringify(snap.t))); d2.restore(JSON.parse(JSON.stringify(snap.d)));
    const again: number[] = [w.hash()];
    t2.digest(v => again.push(v)); d2.digest(v => again.push(v));
    assert.deepEqual(again, out, 'snapshot round trip');
    return { out, started };
  };
  const a = run(), b = run();
  assert.ok(a.started, 'peace was made');
  assert.deepEqual(a.out, b.out);
});
