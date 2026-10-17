// Automatic engagement (docs/game/combat.md 8.4): who starts fighting without a click, the
// retarget after a kill around the body (3.6), player orders (7.2) and the guard's scan cadence
// (8.1). Base-game tests need AN_DATA, the ship test AN_GOLD.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { loadMission, loadAddonMission, DATA, HAS_GOLD } from './helpers/mission.ts';
import { Kind, SUB, type World, type Entity } from '../src/engine/world.ts';
import type { Job } from '../src/engine/scheduler.ts';

const skip = !existsSync(`${DATA}/dv.wdb`) && 'AN_DATA not set';
const skipGold = !HAS_GOLD && 'AN_GOLD data not found';

const cell = (e: Entity): [number, number] => [Math.floor(e.x / SUB), Math.floor(e.y / SUB)];
const job = (w: World, e: Entity): Job | undefined => (e.job ? w.sched.get(e.job) : undefined);
/** the target of the unit's top-level attack job, -1 none */
const target = (w: World, e: Entity): number => { const j = job(w, e); return j && j.kind === 0x08 ? j.data[0] : -1; };

/** a free block of w x h cells outside every territory, near a cell */
function freeBlock(w: World, x: number, y: number, bw: number, bh: number): [number, number] {
  const n = w.size;
  for (let r = 0; r < 60; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
    let ok = true;
    for (let j = -2; j <= bh + 2 && ok; j++) for (let k = -2; k <= bw + 2 && ok; k++) {
      const X = (x + dx + k) & (n - 1), Y = (y + dy + j) & (n - 1);
      if (w.occupied(X, Y) || w.blocked[(Y << w.bits) | X] || w.territory.ownerAt(X, Y) >= 0) ok = false;
    }
    if (ok) return [(x + dx) & (n - 1), (y + dy) & (n - 1)];
  }
  throw new Error('no free block');
}

function setup() {
  const { world: w, mission: m } = loadMission('Pimmons.mdb', 7, DATA, false);  // Pimmons vs Amazons, at war
  const me = m.humanRace;
  const enemy = m.races.find(r => r.present && r.race !== me)!.race;
  const t = w.economy.towns.find(x => x.race === me)!;
  const et = w.economy.towns.find(x => x.race === enemy)!;
  const [x, y] = freeBlock(w, t.x + 30, t.y + 30, 24, 12);
  return { w, me, enemy, t, et, x, y };
}

test('idle hostile groups outside territories never attack each other; one strike starts the fight on both sides', { skip }, () => {
  const { w, me, enemy, t, et, x, y } = setup();
  const types = [29, 30, 31, 33];
  const mine = types.map((ty, i) => w.spawnUnit(me, ty, x, y + 2 * i, t.id));
  const theirs = types.map((ty, i) => w.spawnUnit(enemy, ty, x + 6, y + 2 * i, et.id));
  for (let i = 0; i < 600; i++) w.step();
  for (const e of [...mine, ...theirs]) {
    assert.ok(w.get(e.id), 'nobody died');
    assert.equal(e.hp, w.rules.get(e.oid)!.hp, 'nobody was hit');
    assert.equal(target(w, e), -1, 'no attack job: idle units do not scan (8.4)');
  }
  // one order: the help rule pulls in every armed unit within 12 cells of each victim
  w.schedule({ type: 'order', player: me, ids: [mine[0].id], target: theirs[0].id });
  for (let i = 0; i < 30 && !mine.slice(1).every(e => target(w, e) >= 0); i++) w.step();
  for (const e of theirs) assert.equal(target(w, e), mine[0].id, 'the victim\'s friends attack the striker');
  for (const e of mine.slice(1)) assert.ok(theirs.some(o => o.id === target(w, e)), 'the striker\'s friends answer the counter-strikes');
  // and the fight goes on to the end: every kill is followed by a retarget (3.6)
  for (let i = 0; i < 3000 && mine.some(e => w.get(e.id)) && theirs.some(e => w.get(e.id)); i++) w.step();
  assert.ok(mine.every(e => !w.get(e.id)) || theirs.every(e => !w.get(e.id)), 'one group was wiped out');
});

test('retarget after a kill: the scan is centred on the body and takes the dead target\'s race (3.6)', { skip }, () => {
  const { w, me, enemy, t, et, x, y } = setup();
  // an archer 6 cells from a dying enemy porter; a second porter 11 cells beyond the body, i.e.
  // within sight + 3 = 13 of the body but 17 from the archer
  const archer = w.spawnUnit(me, 29, x, y + 5, t.id);
  const victim = w.spawnUnit(enemy, 9, x + 6, y + 5, et.id);
  const next = w.spawnUnit(enemy, 9, x + 17, y + 5, et.id);
  victim.hp = 1;
  const sight = w.rules.get(archer.oid)!.radius;
  assert.ok(w.logistics.dist(...cell(next), ...cell(victim)) < sight + 3 && w.logistics.dist(...cell(next), ...cell(archer)) > sight + 3);
  w.schedule({ type: 'order', player: me, ids: [archer.id], target: victim.id });
  let k = 0;
  for (; k < 400 && w.get(victim.id); k++) w.step();
  assert.equal(w.get(victim.id), undefined, 'the first porter died');
  for (let i = 0; i < 8; i++) w.step();
  const j = job(w, archer)!;
  assert.equal(j?.kind, 0x08, 'the attack goes on');
  assert.equal(j.data[0], next.id, 'retargeted to the porter near the body');
  assert.equal(j.data[5], 0, 'the player-order flag is cleared by the retarget');
});

test('retarget: the lowest tier present wins (a unit before a building), all within the circle', { skip }, () => {
  const { w, me, enemy, t, et, x, y } = setup();
  const archer = w.spawnUnit(me, 29, x, y + 5, t.id);
  const victim = w.spawnUnit(enemy, 9, x + 5, y + 5, et.id);
  victim.hp = 1;
  // an enemy criminal (tier 2) next to the body and an enemy porter (tier 1) farther away
  const crim = w.spawnUnit(enemy, 12, x + 6, y + 6, et.id);
  w.sched.cancel(crim.job); crim.job = 0;     // keep it standing (no criminal job)
  const porter = w.spawnUnit(enemy, 9, x + 12, y + 3, et.id);
  assert.equal(w.combat.tier(crim), 2);
  assert.equal(w.combat.tier(porter), 1);
  w.schedule({ type: 'order', player: me, ids: [archer.id], target: victim.id });
  for (let k = 0; k < 400 && w.get(victim.id); k++) w.step();
  for (let i = 0; i < 8; i++) w.step();
  assert.equal(target(w, archer), porter.id);
});

test('retaliation keeps a dead current target\'s tier until the attack has run again (7.2)', { skip }, () => {
  const { w, me, enemy, t, et, x, y } = setup();
  const sword = w.spawnUnit(me, 31, x, y, t.id);
  const porter = w.spawnUnit(enemy, 9, x + 1, y, et.id);           // tier 1
  const other = w.spawnUnit(enemy, 9, x + 3, y + 3, et.id);        // tier 1, the next "attacker"
  w.combat.startAttack(sword, porter, true, false, 5, false);
  w.combat.die(porter);
  assert.equal(w.get(porter.id), undefined);
  const before = sword.job;
  // a tier-1 attacker: the dead target's tier 1 <= 1, so the unit keeps its attack
  w.combat.retaliate(sword, other);
  assert.equal(sword.job, before, 'no switch: the dead target still counts as tier 1');
  // a tier-0 attacker makes it switch
  const soldier = w.spawnUnit(enemy, 31, x + 4, y + 4, et.id);
  w.combat.retaliate(sword, soldier);
  assert.equal(target(w, sword), soldier.id);
});

test('player orders: a move-order walk neither retaliates nor flees; idle, guard and go-home units react (7.2)', { skip }, () => {
  const { w, me, enemy, t, et, x, y } = setup();
  const walker = w.spawnUnit(me, 31, x, y, t.id);
  const porterWalking = w.spawnUnit(me, 9, x, y + 2, t.id);
  const idle = w.spawnUnit(me, 31, x + 2, y + 4, t.id);
  const guard = w.spawnUnit(me, 30, x + 3, y + 6, t.id);
  const enemyArcher = w.spawnUnit(enemy, 29, x + 8, y + 3, et.id);
  w.schedule({ type: 'move', player: me, ids: [walker.id, porterWalking.id], x: x + 14, y: y });
  w.schedule({ type: 'patrol', player: me, id: guard.id, points: [] });
  for (let i = 0; i < 4; i++) w.step();
  assert.ok(walker.path && porterWalking.path, 'both are walking their move order');
  assert.equal(w.combat.isPlayerOrder(walker), true);
  assert.equal(w.combat.isPlayerOrder(guard), false, 'the patrol button does not mark its guard job');
  w.combat.attacked(porterWalking, enemyArcher);
  assert.equal(job(w, porterWalking)?.kind, undefined, 'no flee on a move order');
  assert.ok(porterWalking.path, 'the porter walks on');
  assert.equal(target(w, walker), -1, 'no retaliation on a move order');
  assert.equal(target(w, idle), enemyArcher.id, 'the idle soldier answers');
  assert.equal(target(w, guard), enemyArcher.id, 'the patrolling soldier answers with a top-level attack');
  assert.equal(guard.suspended.length, 1, 'its guard job waits behind the attack');
  // at the goal the walk (and the order) is over: the unit reacts again
  for (let i = 0; i < 400 && walker.path; i++) w.step();
  assert.equal(walker.path, null);
  assert.equal(w.combat.isPlayerOrder(walker), false);
  const another = w.spawnUnit(enemy, 29, x + 20, y, et.id);
  w.combat.attacked(walker, another);
  assert.equal(target(w, walker), another.id);
  // the go-home walk is no player order: an unarmed unit flees from it
  const homer = w.spawnUnit(me, 9, x + 4, y + 9, t.id);
  w.schedule({ type: 'unit', player: me, ids: [homer.id], action: 'home', town: t.id });
  for (let i = 0; i < 3; i++) w.step();
  assert.ok(homer.path, 'walking home');
  w.combat.attacked(homer, another);
  assert.equal(job(w, homer)?.kind, 0x26, 'flees');
});

test('a job given by the dispatcher after a move order is no player order', { skip }, () => {
  const { w, me, t, x, y } = setup();
  const u = w.spawnUnit(me, 31, x, y, t.id);
  w.schedule({ type: 'move', player: me, ids: [u.id], x: x + 3, y });
  w.step();
  assert.ok(u.path && w.combat.isPlayerOrder(u));
  for (let i = 0; i < 200 && u.path; i++) w.step();
  assert.equal(u.ordered, true);
  w.logistics.assign(u, 0x05, 5, [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(w.combat.isPlayerOrder(u), false);
  w.logistics.cancelJob(u);
});

test('guard: while walking its patrol the scan comes once per step, never inside a step (8.1)', { skip }, () => {
  const { w, me, t, x, y } = setup();
  const s = w.spawnUnit(me, 30, x, y, t.id);
  w.schedule({ type: 'patrol', player: me, id: s.id, points: [[x + 12, y]] });
  // the guard's scans are its calls of the target chooser
  const scans: number[] = [];
  const orig = w.combat.choose.bind(w.combat);
  w.combat.choose = (c: Entity, cands: Entity[], race: number, tier: number) => {
    if (c.id === s.id && s.path) {
      scans.push(w.tick);
      assert.ok(s.stepTicks === 0 || w.tick >= s.stepStart + s.stepTicks, `tick ${w.tick}: inside a step (${s.stepStart} + ${s.stepTicks})`);
    }
    return orig(c, cands, race, tier);
  };
  let steps = 0, last = -1;
  for (let i = 0; i < 200; i++) {
    w.step();
    if (s.stepStart !== last && s.stepStart > 0) { steps++; last = s.stepStart; }
  }
  assert.ok(scans.length >= 8, `scans while walking: ${scans.length}`);
  // one per run of the walk (each step, plus each turn at the ends of the patrol), not per tick
  assert.ok(scans.length <= 2 * steps && scans.length < 100, `${scans.length} scans for ${steps} steps`);
});

test('ships: a warship that sinks a land unit retargets to the next one of that race near the body (Gold)', { skip: skipGold }, () => {
  const { world: w, mission: m } = loadAddonMission('AmazonsAO.mdb', 5, undefined, false);
  const h = m.humanRace, en = 2;
  const ship = w.entities.find(e => w.isShip(e) && e.owner === h && (e.oid & 0xffff) === 65)!;
  const [sx, sy] = cell(ship);
  const n = w.size;
  const lands: [number, number, number][] = [];
  for (let y = sy - 16; y <= sy + 16; y++) for (let x = sx - 16; x <= sx + 16; x++) {
    const X = x & (n - 1), Y = y & (n - 1);
    if (w.blocked[(Y << w.bits) | X] || w.occupied(X, Y) || w.territory.ownerAt(X, Y) >= 0) continue;
    lands.push([X, Y, w.logistics.dist(X, Y, sx, sy)]);
  }
  lands.sort((a, b) => a[2] - b[2] || a[1] - b[1] || a[0] - b[0]);
  const et = w.economy.towns.find(t => t.race === en)!;
  const a = w.spawnUnit(en, 9, lands[0][0], lands[0][1], et.id);
  const b = w.spawnUnit(en, 9, lands[2][0], lands[2][1], et.id);
  assert.ok(w.logistics.dist(...cell(a), ...cell(b)) < w.rules.get(ship.oid)!.radius + 3);
  w.schedule({ type: 'order', player: h, ids: [ship.id], target: a.id });
  for (let i = 0; i < 1500 && w.get(a.id); i++) w.step();
  assert.equal(w.get(a.id), undefined, 'the first one died');
  for (let i = 0; i < 8; i++) w.step();
  assert.equal(target(w, ship), b.id, 'the ship goes on with the next one');
  assert.equal(Kind.Unit, b.kind);
});

test('an attack on a target on another island never ends: 5 failed searches, then the retarget takes it again (3.5, 3.6); an equal-tier attacker is ignored meanwhile (7.2) (Gold)', { skip: skipGold }, () => {
  // the original's rules (C, Gold 0x47bc00, 0x46b32c): what kept the Sajiki defenders of a
  // play-test save from fighting back; see combat.md 7.2 "Attacks across the water"
  const { world: w, mission: m } = loadAddonMission('AmazonsAO.mdb', 5, undefined, false);
  const h = m.humanRace, en = m.races.find(r => r.present && r.race !== h)!.race;
  const n = w.size;
  const land = (X: number, Y: number) => !w.blocked[(Y << w.bits) | X] && !w.occupied(X, Y) && w.territory.ownerAt(X, Y) < 0 && w.islandAt(X, Y) > 0;
  const lonely = (X: number, Y: number) => w.combat.scan(X, Y, 14).every(e => e.kind === Kind.Nature || (e.oid >>> 16) > 2);
  let P: [number, number] | undefined, Q: [number, number] | undefined;
  for (let i = 0; i < n * n && !(P && Q); i += 7) {
    const X = i & (n - 1), Y = i >> w.bits;
    if (!land(X, Y) || !land((X + 1) & (n - 1), Y) || !lonely(X, Y)) continue;
    if (!P) P = [X, Y];
    else if (w.islandAt(X, Y) !== w.islandAt(...P)) Q = [X, Y];
  }
  assert.ok(P && Q, 'two quiet land cells on different islands');
  const sword = w.spawnUnit(h, 31, P[0], P[1], -1);                 // melee, tier 0
  const far = w.spawnUnit(en, 17, Q[0], Q[1], -1);                  // a hunter over the water, tier 0
  w.combat.startAttack(sword, far, true, false, 1, false);
  for (let i = 0; i < 400; i++) w.step();
  assert.equal(target(w, sword), far.id, 'still attacking the unreachable hunter (retargeted onto it again)');
  assert.deepEqual(cell(sword), P, 'without moving');
  // a tier-0 striker next to it: 7.2 keeps the current target (its tier 0 <= 0)
  const striker = w.spawnUnit(en, 31, (P[0] + 1) & (n - 1), P[1], -1);
  w.combat.attacked(sword, striker);
  assert.equal(target(w, sword), far.id, 'no answer to the striker, not even as the victim');
});
