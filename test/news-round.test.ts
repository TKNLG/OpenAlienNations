// The news stand's operator, the news seller, on his round of the town's houses (job 0x1A).
// Spec: docs/game/units-and-jobs.md 8.6 (and 8.5 for the duty link); docs/game/economy.md 5.3.
// Needs AN_DATA (Pimmons.mdb 4: the human Pimmons with houses; a news stand is built here).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { loadMission, DATA } from './helpers/mission.ts';
import { World, Kind, SUB, type Command, type Entity } from '../src/engine/world.ts';
import { LJ, NR, NewsChild } from '../src/engine/logistics.ts';

const skip = !existsSync(`${DATA}/dv.odb`) && 'AN_DATA not set';
const PIMMONS = 1, STAND = 51, SELLER = 20, OPERATOR_JOB = 0x22, WORK = 2;

const run = (w: World, cmd: Command) => { w.schedule(cmd); w.step(); };
const until = (w: World, cond: () => boolean, max: number, what: string) => {
  for (let i = 0; i < max; i++) { if (cond()) return; w.step(); }
  assert.ok(cond(), `timed out: ${what}`);
};
const cell = (e: Entity): [number, number] => [Math.floor(e.x / SUB), Math.floor(e.y / SUB)];
const roundOf = (w: World, u: Entity) => { const j = w.logistics.mainJob(u); return j && j.kind === LJ.News ? j : undefined; };

/** a completed news stand near the Pimmon town, staffed by a seller the dispatcher sends in */
function staffed() {
  const { world: w } = loadMission('Pimmons.mdb', 4, DATA, false);
  const t = w.economy.towns.find(x => x.race === PIMMONS)!;
  const r = w.rules.get(((PIMMONS << 16) | STAND) >>> 0)!;
  let site: [number, number] | null = null;
  for (let d = 4; d <= 30 && !site; d++) for (const [dx, dy] of [[d, 0], [-d, 0], [0, d], [0, -d], [d, d], [-d, -d], [d, -d], [-d, d]]) {
    if (w.logistics.canPlace(t, r, t.x + dx, t.y + dy)) { site = [(t.x + dx) & (w.size - 1), (t.y + dy) & (w.size - 1)]; break; }
  }
  assert.ok(site, 'a site for the stand');
  const stand = w.logistics.placeBuilding(t, STAND, site![0], site![1])!;
  t.workerReqs = t.workerReqs.filter(([, b]) => b !== stand.id);
  t.lists.forEach((l, i) => { t.lists[i] = l.filter(id => id !== stand.id); });
  w.logistics.complete(stand);
  assert.equal(stand.active, false, 'no seller yet: inactive');
  assert.ok(t.workerReqs.some(([ty, b]) => ty === SELLER && b === stand.id), 'completion asks for a seller');
  const [sx, sy] = w.logistics.entrance(stand);
  const spot = w.freeSpiral(sx + 3, sy + 3, 10)!;
  const seller = w.spawnUnit(PIMMONS, SELLER, spot[0], spot[1], t.id);
  w.economy.joinTown(seller, t);
  until(w, () => stand.active, 600, 'the seller enters and activates the stand');
  assert.equal(stand.operatorId, seller.id);
  assert.equal(seller.inside, stand.id);
  assert.equal(w.sched.get(stand.opJob)?.kind, OPERATOR_JOB);
  const houses = w.logistics.newsHouses(t);
  assert.ok(houses.length >= 2, 'the town has houses');
  return { w, t, stand, seller, houses };
}

/** step until the seller is out on his round with a walk under way */
function outOnRound(w: World, seller: Entity) {
  until(w, () => seller.inside < 0 && !!roundOf(w, seller) && roundOf(w, seller)!.data[NR.Child] === NewsChild.Walking && !!seller.path?.length, 600, 'seller out on his round');
}

test('news round: the seller visits every house in list order without entering, then walks back in', { skip }, () => {
  const { w, t, stand, seller, houses } = staffed();
  const startTick = w.tick;
  until(w, () => !!roundOf(w, seller), 200, 'operator job sends him out');
  assert.ok(w.tick - startTick >= 99, 'first operator run 100 ticks after the entry');
  assert.equal(stand.opJob, 0, 'the operator job ended');
  const visits: number[] = [];
  let lastTarget = -1;
  const animTicks: number[] = [];
  const expected = houses.filter(h => h.complete).map(h => h.id);
  for (let i = 0; i < 20000; i++) {
    const j = roundOf(w, seller);
    if (j && j.data[NR.Child] === NewsChild.Door) lastTarget = j.data[NR.Target];
    w.step();
    assert.ok(!houses.some(h => seller.inside === h.id), 'never inside a house');
    if (seller.action === WORK && roundOf(w, seller)) {
      // a new work cycle started: at the door of the house just asked
      if (!animTicks.includes(seller.actionTick)) {
        animTicks.push(seller.actionTick);
        visits.push(lastTarget);
        const h = w.get(lastTarget)!;
        const [ex, ey] = w.logistics.entrance(h), [ux, uy] = cell(seller);
        assert.ok(w.logistics.dist(ux, uy, ex, ey) <= 2, `at the door of house ${lastTarget}`);
      }
    }
    if (seller.inside === stand.id && !roundOf(w, seller) && !w.logistics.leaving(seller)) break;
  }
  assert.ok(expected.length >= 2);
  assert.deepEqual(visits, expected, 'each completed house once, small houses then large, in list order');
  if (process.env.NEWS_LOG) console.log(`houses ${expected.length}, animations at ${animTicks.join(',')}, back at ${w.tick}`);
  for (let k = 1; k < animTicks.length; k++) assert.ok(animTicks[k] - animTicks[k - 1] >= 21, '20 ticks at a house, then the next walk');
  assert.equal(seller.inside, stand.id, 'back inside');
  assert.equal(stand.active, true);
  assert.equal(stand.operatorId, seller.id);
  assert.equal(w.sched.get(stand.opJob)?.kind, OPERATOR_JOB, 'the entry restarts the operator job');
  assert.ok(!t.workerReqs.some(([ty]) => ty === SELLER));
  // and the next round starts 100 ticks later
  const back = w.tick;
  until(w, () => !!roundOf(w, seller), 200, 'next round');
  assert.ok(w.tick - back >= 99);
});

test('news round: the stand stays active, its need closed and its upkeep paid while the seller is out', { skip }, () => {
  const { w, t, stand, seller } = staffed();
  assert.ok(!t.open.includes(STAND), 'news need closed by the active stand');
  const overheads = t.overheads;
  outOnRound(w, seller);
  for (let i = 0; i < 300 && roundOf(w, seller); i++) {
    w.step();
    assert.equal(stand.active, true, 'active during the round');
    assert.equal(stand.operatorId, seller.id, 'still its operator');
    assert.ok(!t.open.includes(STAND), 'need stays closed');
    assert.equal(t.overheads, overheads, 'upkeep unchanged');
  }
});

test('news round: the round has no economic effect (happiness and needs as with the seller inside)', { skip }, () => {
  // two copies of the same town: in one the seller goes on his rounds, in the other the operator
  // job is removed so he stays inside; their economies stay identical
  const a = staffed(), b = staffed();
  w2Hold(b.w, b.stand);
  for (let i = 0; i < 3000; i++) { a.w.step(); b.w.step(); }
  assert.ok(a.w.logistics.newsHouses(a.t).length > 0 && b.seller.inside === b.stand.id);
  assert.equal(a.t.happiness, b.t.happiness);
  assert.equal(a.t.needsPct, b.t.needsPct);
  assert.deepEqual(a.t.open, b.t.open);
  assert.equal(a.t.population, b.t.population);
});
function w2Hold(w: World, stand: Entity) { w.sched.cancel(stand.opJob); stand.opJob = 0; }

test('news round: a seller killed on his round files a request; the stand keeps him and refuses a replacement', { skip }, () => {
  const { w, t, stand, seller } = staffed();
  outOnRound(w, seller);
  w.combat.die(seller);
  assert.equal(stand.active, true, 'the link is not broken');
  assert.equal(stand.operatorId, seller.id, 'the dead seller stays its stored operator');
  assert.ok(t.workerReqs.some(([ty, b]) => ty === SELLER && b === stand.id), 'a worker request for a seller');
  assert.ok(!t.open.includes(STAND), 'need still closed');
  // a replacement walks to the door and is refused (operator type, active building, not its operator)
  const [sx, sy] = w.logistics.entrance(stand);
  const spot = w.freeSpiral(sx + 2, sy + 2, 10)!;
  const repl = w.spawnUnit(PIMMONS, SELLER, spot[0], spot[1], t.id);
  w.economy.joinTown(repl, t);
  let sent = 0;
  for (let i = 0; i < 400; i++) { w.step(); assert.ok(repl.inside !== stand.id, 'refused at the door'); if (w.sched.get(repl.job)?.kind === LJ.Answer) sent++; }
  assert.ok(sent > 0, 'the request sent him');
  assert.ok(t.workerReqs.some(([ty, b]) => ty === SELLER && b === stand.id) || w.sched.get(repl.job)?.kind === LJ.Answer, 'the request is filed again after the refusal');
  assert.equal(stand.active, true);
  // DEAKTIVIEREN releases the dead operator; the next seller then enters and activates it
  run(w, { type: 'building', player: PIMMONS, id: stand.id, action: 'deactivate' });
  assert.equal(stand.active, false);
  assert.equal(stand.operatorId, -1);
  run(w, { type: 'order', player: PIMMONS, ids: [repl.id], target: stand.id });
  until(w, () => stand.active, 600, 'replacement activates the stand');
  assert.equal(stand.operatorId, repl.id);
});

test('news round: a manual order cancels the round but keeps the link; ordered back in he starts again', { skip }, () => {
  const { w, t, stand, seller } = staffed();
  outOnRound(w, seller);
  const [x, y] = cell(seller);
  run(w, { type: 'move', player: PIMMONS, ids: [seller.id], x: x + 3, y });
  assert.equal(roundOf(w, seller), undefined, 'round cancelled');
  assert.equal(stand.active, true, 'still active');
  assert.equal(stand.operatorId, seller.id);
  assert.equal(stand.opJob, 0, 'no operator job: no further round');
  assert.ok(!t.workerReqs.some(([ty]) => ty === SELLER), 'no request');
  for (let i = 0; i < 400; i++) w.step();
  assert.equal(roundOf(w, seller), undefined);
  run(w, { type: 'order', player: PIMMONS, ids: [seller.id], target: stand.id });
  until(w, () => seller.inside === stand.id, 600, 'back in');
  assert.equal(w.sched.get(stand.opJob)?.kind, OPERATOR_JOB);
  until(w, () => !!roundOf(w, seller), 200, 'next round');
});

test('news seller ordered onto a house stands at its door and never enters', { skip }, () => {
  const { w, stand, seller, houses } = staffed();
  run(w, { type: 'sendOut', player: PIMMONS, building: stand.id, unit: SELLER });
  until(w, () => seller.inside < 0 && !w.logistics.leaving(seller), 100, 'out');
  assert.equal(stand.active, false, 'sent out: deactivated');
  const h = houses.find(x => x.complete)!;
  run(w, { type: 'order', player: PIMMONS, ids: [seller.id], target: h.id });
  until(w, () => seller.job === 0 && !seller.path, 1000, 'go-to over');
  assert.equal(seller.inside, -1, 'not inside the house');
  const [ex, ey] = w.logistics.entrance(h), [ux, uy] = cell(seller);
  assert.ok(w.logistics.dist(ux, uy, ex, ey) <= 2, 'at its door');
});

test('news round: deactivation while he is out releases him and ends the link', { skip }, () => {
  const { w, stand, seller } = staffed();
  outOnRound(w, seller);
  run(w, { type: 'building', player: PIMMONS, id: stand.id, action: 'deactivate' });
  assert.equal(stand.active, false);
  assert.equal(stand.operatorId, -1);
  assert.equal(roundOf(w, seller), undefined);
});

test('news round: snapshot / restore mid-round continues identically', { skip }, () => {
  const { w, stand, seller } = staffed();
  outOnRound(w, seller);
  for (let i = 0; i < 37; i++) w.step();
  assert.ok(roundOf(w, seller), 'still on the round');
  const snap = JSON.parse(JSON.stringify(w.snapshot()));
  const t = w.terrain;
  const c = World.restore({ ...t, height: t.height.slice(), cls: t.cls.slice(), tile: t.tile.slice() }, snap, w.rules, w.weapons);
  assert.equal(c.hash(), w.hash(), 'restored state hashes the same');
  for (let i = 0; i < 3000; i++) { w.step(); c.step(); }
  assert.equal(c.hash(), w.hash(), 'continues identically');
  const cs = c.get(seller.id)!;
  assert.equal(c.get(stand.id)!.active, true);
  assert.ok(roundOf(c, cs) || cs.inside === stand.id);
  // a version 10 save of a staffed stand whose operator job had ended gets a new one
  const w2 = staffed();
  w2Hold(w2.w, w2.stand);
  const old = JSON.parse(JSON.stringify(w2.w.snapshot()));
  old.v = 10;
  const t2 = w2.w.terrain;
  const m = World.restore({ ...t2, height: t2.height.slice(), cls: t2.cls.slice(), tile: t2.tile.slice() }, old, w2.w.rules, w2.w.weapons);
  const ms = m.get(w2.stand.id)!;
  assert.equal(m.sched.get(ms.opJob)?.kind, OPERATOR_JOB, 'migrated: operator job restarted');
  until(m, () => !!roundOf(m, m.get(w2.seller.id)!), 200, 'migrated stand sends its seller out');
});

test('news stand without houses keeps its seller inside and re-tests every 299 ticks', { skip }, () => {
  const { w, t, stand, seller, houses } = staffed();
  for (const h of houses) h.town = -1;          // the town loses its houses (lists empty)
  for (let i = 0; i < 1000; i++) { w.step(); assert.equal(seller.inside, stand.id); assert.equal(roundOf(w, seller), undefined); }
  assert.equal(w.sched.get(stand.opJob)?.kind, OPERATOR_JOB, 'the operator job keeps running');
  for (const h of houses) h.town = t.id;
  until(w, () => !!roundOf(w, seller), 320, 'a house again: sent out at the next run');
});

test('news round: no other unit kind or building is visited; status text kind', { skip }, () => {
  const { w, seller } = staffed();
  outOnRound(w, seller);
  const j = roundOf(w, seller)!;
  assert.equal(j.kind, 0x1a);
  const target = w.get(j.data[NR.Target])!;
  assert.equal(target.kind, Kind.Building);
  assert.ok([37, 38].includes(target.oid & 0xffff));
});
