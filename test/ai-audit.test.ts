// Computer-player rules corrected by the 2026-10 audit (integration-ai.md 7a, needs AN_DATA).
// Spec: docs/game/ai-diplomacy-trade.md 0, 1.4, 1.7, 1.10, 1.15, 2.2, 2.5; units-and-jobs.md 9.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { loadMission, DATA } from './helpers/mission.ts';
import { Kind, type World, type Entity } from '../src/engine/world.ts';
import { Logistics } from '../src/engine/logistics.ts';
import { assignAttackers, assignArmy, anchor, snap, houseWanted, porterGang, runMilitary } from '../src/engine/ai-town.ts';
import { Grp, AiJob } from '../src/engine/ai-defs.ts';
import type { AiPlayer } from '../src/engine/ai.ts';
import type { Town } from '../src/engine/economy.ts';

const skip = !existsSync(`${DATA}/dv.odb`) && 'AN_DATA not set';
const PORTER = 9, BUILDER = 11, HUNTER = 17, ARCHER = 29, SCHOOL = 55, SMALL_OUTPOST = 52, LARGE_OUTPOST = 53, TOWN_HALL = 40, WAREHOUSE = 41, WATCHTOWER = 60;

/** a free cell near (x, y) */
function spot(w: World, x: number, y: number, k = 0): [number, number] {
  let n = 0;
  for (let r = 0; r < 40; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    if (Math.max(Math.abs(dx), Math.abs(dy)) !== r || w.occupied(x + dx, y + dy) || !w.motion.free(x + dx, y + dy)) continue;
    if (n++ === k) return [x + dx, y + dy];
  }
  throw new Error('no free cell');
}
const attackOf = (w: World, u: Entity): number => {
  const j = u.job ? w.sched.get(u.job) : undefined;
  return j && !j.cancelled && j.kind === 0x08 ? j.data[0] : 0;
};

test('A: a lost training building takes its queued orders out of the pending counts, no refund', { skip }, () => {
  const { world: w } = loadMission('Pimmons.mdb', 4, DATA, false);
  for (const path of ['collapse', 'destroy'] as const) {
    const school = w.entities.find(e => e.kind === Kind.Building && e.alive && e.complete && (e.oid & 0xffff) === SCHOOL && e.town >= 0)!;
    assert.ok(school, 'a school on the map');
    const t = w.economy.town(school.town)!;
    const p = w.economy.players[t.race]!;
    p.money = 10000;
    for (let g = 0; g < t.stock.length; g++) t.stock[g] = Math.max(t.stock[g], 20);
    const before = t.pending[11] ?? 0;   // builders
    assert.ok(w.logistics.train(school, 11) && w.logistics.train(school, 11), 'two builder orders');
    assert.equal(t.pending[11], before + 2);
    const money = p.money;
    if (path === 'collapse') w.combat.collapse(school, false);
    else w.destroyBuilding(school);
    assert.equal(t.pending[11] ?? 0, before, `${path}: pending count lowered once per queued order`);
    assert.equal(school.queue.length, 0);
    assert.equal(p.money, money, 'no refund');
    // the later removal (collapse phase 2) does not lower it again
    if (path === 'collapse') { w.destroyBuilding(school); assert.equal(t.pending[11] ?? 0, before); }
  }
});

test('B: the free-unit test (section 0, units-and-jobs.md 5.4)', { skip }, () => {
  const { world: w } = loadMission('Pimmons.mdb', 4, DATA, false);
  const t = w.economy.towns[0];
  const [x, y] = spot(w, t.x + 3, t.y + 3);
  const u = w.spawnUnit(t.race, PORTER, x, y, t.id);
  assert.ok(Logistics.free(u, 0), 'idle outside');
  assert.ok(!Logistics.free(u, Grp.Porters), 'another group');
  u.group = Grp.Porters;
  assert.ok(Logistics.free(u, Grp.Porters) && w.ai.free(u, Grp.Porters), 'the porter gang asks for group 50');
  u.group = 0;
  const house = w.entities.find(e => e.kind === Kind.Building && e.town === t.id && e.complete)!;
  // walking to a leisure visit (+0x78 = -1, outside, with its go-to job): free
  w.logistics.goInto(u, house, 1);
  u.idle = -1;
  assert.ok(u.job && Logistics.free(u, 0), 'on its way to a leisure visit');
  u.idle = 0;
  assert.ok(!Logistics.free(u, 0), 'any other job outside: not free');
  w.logistics.cancelJob(u);
  // inside on a leisure visit without a job: free; inside with a job: not
  w.putInside(u, house);
  u.idle = -1;
  assert.ok(Logistics.free(u, 0), 'visiting');
  u.idle = 0;
  assert.ok(!Logistics.free(u, 0), 'inside, not visiting');
});

test('B: porter gang (1.10): 2 below 6 porters, else min(10, p / 2), n / 4 + 1 left outside', { skip }, () => {
  const { world: w } = loadMission('Pimmons.mdb', 4, DATA, false);
  const t = w.economy.towns[0];
  const porters = () => w.entities.filter(e => e.kind === Kind.Unit && e.town === t.id && (e.oid & 0xffff) === PORTER && (e.oid >>> 16) === t.race && e.alive);
  for (let i = 0; i < 16; i++) { const [x, y] = spot(w, t.x + 4, t.y + 4, i); w.economy.joinTown(w.spawnUnit(t.race, PORTER, x, y, t.id), t); }
  const all = porters();
  for (const e of all) e.group = 0;
  const free = all.filter(e => w.ai.free(e)).length;
  const p = all.length, n = p < 6 ? 2 : Math.min(10, p >> 1), reserve = n > 2 ? (n >> 2) + 1 : 0;
  porterGang(w.ai, t);
  const gang = all.filter(e => e.group === Grp.Porters).length;
  assert.equal(gang, Math.max(0, Math.min(n, free - reserve)), `p ${p} free ${free}: gang ${gang}`);
  assert.ok(all.filter(e => w.ai.free(e)).length >= reserve, 'the reserve stays free (trainees)');
  // the hauling group of a computer town is the gang, of a human town group 0
  w.ai.players[t.race] = w.ai.players[t.race] ?? { race: t.race } as never;
  assert.equal(w.logistics.haulGroup(t), Grp.Porters);
  // too large: the surplus is released
  for (const e of all) e.group = Grp.Porters;
  porterGang(w.ai, t);
  assert.equal(all.filter(e => e.group === Grp.Porters).length, n);
});

test('house rule (1.4): occupancy over 50 %, free share, free space at most 19', {}, () => {
  // P 20, H 30 (O 66): porters 50 %, 2 free porters (10 %), no free builder: no house
  assert.equal(houseWanted(30, 20, 10, 2, 0, 50, 50), false);
  assert.equal(houseWanted(30, 20, 9, 2, 0, 50, 50), true, 'porter share under 50 %');
  assert.equal(houseWanted(30, 20, 10, 0, 0, 50, 50), true, 'no free porter');
  assert.equal(houseWanted(30, 40, 20, 1, 0, 50, 50), true, 'free share 2 % < 5 %');
  // the store test: both stores with at most 19 free places
  assert.equal(houseWanted(30, 20, 10, 2, 1, 19, 19), true);
  assert.equal(houseWanted(30, 20, 10, 2, 1, 20, 19), false, '20 free places in the stone store');
  assert.equal(houseWanted(30, 20, 10, 2, 1, 19, 20), false, '20 free places in the wood store');
  assert.equal(houseWanted(30, 70, 10, 2, 1, 0, 0), true, 'porter share 14 %');
  // occupancy: 50 % is not enough, 51 % is
  assert.equal(houseWanted(40, 20, 0, 0, 0, 0, 0), false, 'O = 50');
  assert.equal(houseWanted(39, 20, 0, 0, 0, 0, 0), true, 'O = 51');
  assert.equal(houseWanted(150, 200, 0, 0, 0, 0, 0), false, 'H >= 150');
});

/** units of `race` in town t (hunters) and `n` hostile targets near them */
function fight(nUnits: number, nTargets: number) {
  const { world: w, mission: m } = loadMission('Pimmons.mdb', 7, DATA, false);
  const me = m.humanRace;
  const enemy = m.races.find(r => r.present && r.race !== me)!.race;
  const t = w.economy.towns.find(x => x.race === me)!;
  const [x, y] = spot(w, t.x + 10, t.y + 10);
  const units = Array.from({ length: nUnits }, (_, i) => w.spawnUnit(me, HUNTER, ...spot(w, x, y, i), t.id));
  const targets = Array.from({ length: nTargets }, (_, i) => w.spawnUnit(enemy, ARCHER, ...spot(w, x + 6, y, 20 + i), -1));
  return { w, units, targets };
}

test('C: the defence response uses every defender, three per intruder in turn, wrapping (2.2)', { skip }, () => {
  const { w, units, targets } = fight(7, 2);
  assignAttackers(w.ai, units, targets, () => 3, w.combat.tier(targets[0]));
  const on = targets.map(x => units.filter(u => attackOf(w, u) === x.id).length);
  assert.deepEqual(on, [4, 3], 'every defender attacks: 3, 3, then the first again');
  // one intruder: all of them on it
  const b = fight(5, 1);
  assignAttackers(b.w.ai, b.units, b.targets, () => 3, 0);
  assert.equal(b.units.filter(u => attackOf(b.w, u) === b.targets[0].id).length, 5);
  // a defender already attacking a target of the bucket's class keeps it and is not counted
  const c = fight(4, 2);
  c.w.combat.startAttack(c.units[0], c.targets[1], true, false, 1, false);
  assignAttackers(c.w.ai, c.units, c.targets, () => 3, 0);
  assert.equal(attackOf(c.w, c.units[0]), c.targets[1].id);
  assert.deepEqual(c.targets.map(x => c.units.filter(u => attackOf(c.w, u) === x.id).length), [3, 1]);
});

test('D, P: the army assigns every member, six per target, wrapping; refused attacks count (2.5)', { skip }, () => {
  const { w, units, targets } = fight(12, 2);
  assignArmy(w.ai, units, targets, 6, () => true);
  const on = targets.map(x => units.filter(u => attackOf(w, u) === x.id).length);
  assert.deepEqual(on, [6, 6], 'no member left idle: 6, then 6');
  // a member whose attack check refuses (an unarmed porter) is counted all the same
  const b = fight(7, 2);
  const t = b.w.economy.town(b.units[0].town)!;
  const porter = b.w.spawnUnit(t.race, PORTER, ...spot(b.w, t.x + 10, t.y + 10, 30), t.id);
  assignArmy(b.w.ai, [porter, ...b.units], b.targets, 6, () => true);
  assert.equal(attackOf(b.w, porter), 0, 'refused');
  assert.deepEqual(b.targets.map(x => b.units.filter(u => attackOf(b.w, u) === x.id).length), [5, 2], 'the porter took one of the six places');
});

/** an army of `race` (members spawned near the target town, group 53) on town tt with tactic d[3] */
function army(w: World, race: number, tt: Town, tactic: number, n: number) {
  const members = Array.from({ length: n }, (_, i) => w.spawnUnit(race, HUNTER, ...spot(w, tt.x + 6, tt.y + 6, 40 + i), -1));
  for (const u of members) u.group = Grp.Army;
  const job = w.sched.create(AiJob.Army, race, 1, [tt.id, tt.x, tt.y, tactic]);
  const ps: AiPlayer = { race, profile: 0, think: 0, army: job.id, armyTown: tt.id, armyMembers: members.map(u => u.id), lastArmy: 0,
    lastMission: [0, 0, 0], discovered: [], cursor: 0, founding: 0, noSite: 0 };
  w.ai.players[race] = ps;
  return { ps, job, members };
}
/** count rand() draws made through the AI */
function countDraws(w: World, value?: number): () => number {
  let n = 0;
  const orig = w.ai.rand.bind(w.ai);
  w.ai.rand = () => { n++; const r = orig(); return value ?? r; };
  return () => n;
}

test('O, P: the assault attacks bucket 0 only: one important building, the outposts, tier-0 units of the target race (2.5)', { skip }, () => {
  for (const draw of [1, 0]) {
    const { world: w } = loadMission('Pimmons.mdb', 7, DATA, false);
    const tt = w.economy.towns[0];   // Amazons: barracks, two small outposts, houses
    assert.ok(w.ai.hostile(1, tt.race));
    const hunter = w.spawnUnit(tt.race, HUNTER, ...spot(w, tt.x + 5, tt.y + 5), tt.id);
    const civil = [PORTER, BUILDER].map((ty, i) => w.spawnUnit(tt.race, ty, ...spot(w, tt.x + 5, tt.y + 5, 10 + i), tt.id));
    const { ps, job, members } = army(w, 1, tt, 0, 12);   // six soldiers stand in the circle: no retreat
    const house = w.ai.list(tt, 37)[0];
    const important = w.ai.list(tt, 39)[0];
    assert.ok(house && important, 'a house and a barracks');
    // m0 attacks a house (class 2 > bucket 0: re-assigned), m1 the hunter (class 0 = bucket: rand() mod 10)
    w.combat.startAttack(members[0], house, true, false, 1, false);
    w.combat.startAttack(members[1], hunter, true, false, 1, false);
    const draws = countDraws(w, draw);
    assert.equal(w.ai.runJob(job), 50, 'the army goes on');
    assert.equal(ps.army, job.id);
    assert.equal(draws(), 2, 'one keep draw (equal class) and the next tactic');
    const allowed = new Set([important.id, hunter.id, ...w.ai.list(tt, SMALL_OUTPOST).map(e => e.id), ...w.ai.list(tt, LARGE_OUTPOST).map(e => e.id),
      ...w.combat.scan(tt.x, tt.y, 40).filter(e => e.kind === Kind.Unit && (e.oid >>> 16) === tt.race && w.combat.tier(e) === 0).map(e => e.id)]);
    for (const u of members) assert.ok(allowed.has(attackOf(w, u)), `member ${u.id} on bucket 0 (${attackOf(w, u)})`);
    for (const c of civil) assert.ok(members.every(u => attackOf(w, u) !== c.id), 'civilians are never attacked');
    const onImp = members.filter(u => attackOf(w, u) === important.id);
    assert.equal(onImp.length, 6, 'six on the important building');
    assert.ok(w.ai.list(tt, 39).slice(1).every(b => members.every(u => attackOf(w, u) !== b.id)), 'only one building of the important type');
    if (draw === 1) {
      assert.equal(attackOf(w, members[1]), hunter.id, 'rand() mod 10 != 0: kept, not counted');
      assert.deepEqual(onImp.map(u => u.id), [members[0], ...members.slice(2, 7)].map(u => u.id));
    } else {
      assert.deepEqual(onImp.map(u => u.id), members.slice(0, 6).map(u => u.id), 'rand() mod 10 = 0: re-assigned');
    }
  }
});

test('Q: the important town hall is attacked by a small army, which does not end (2.5)', { skip }, () => {
  const { world: w } = loadMission('Pimmons.mdb', 4, DATA, false);
  const tt = w.economy.towns.find(x => x.race === 2)!;   // the Sajiki town: a town hall only
  const hall = w.ai.list(tt, TOWN_HALL)[0];
  w.economy.players[0]!.relations[2] = 0; w.economy.players[2]!.relations[0] = 0;
  const { ps, job, members } = army(w, 0, tt, 0, 3);
  assert.equal(w.ai.runJob(job), 50);
  assert.equal(ps.army, job.id, 'not a success while the town stands');
  assert.ok(members.every(u => attackOf(w, u) === hall.id));
});

test('R: the skirmish re-assigns only away from class > 0 in bucket 0, without a rand() draw (2.5)', { skip }, () => {
  const { world: w } = loadMission('Pimmons.mdb', 7, DATA, false);
  const tt = w.economy.towns[0];
  const hunter = w.spawnUnit(tt.race, HUNTER, ...spot(w, tt.x + 5, tt.y + 5), tt.id);
  const porter = w.spawnUnit(tt.race, PORTER, ...spot(w, tt.x + 5, tt.y + 5, 10), tt.id);
  const post = w.ai.list(tt, SMALL_OUTPOST)[0];
  const { job, members } = army(w, 1, tt, 1, 4);
  w.combat.startAttack(members[0], porter, true, false, 1, false);   // class 1: re-assigned
  w.combat.startAttack(members[1], post, true, false, 1, false);     // class 0: kept
  const draws = countDraws(w);
  assert.equal(w.ai.runJob(job), 50);
  assert.equal(draws(), 1, 'only the next tactic');
  assert.equal(attackOf(w, members[1]), post.id, 'kept');
  const fighter = (id: number) => { const e = w.get(id); const ty = e ? e.oid & 0xffff : -1; return ty === HUNTER || ty === 21 || (ty >= 29 && ty <= 36); };
  for (const u of [members[0], members[2], members[3]]) assert.ok(fighter(attackOf(w, u)), 'on a fighter');
  assert.ok(members.every(u => attackOf(w, u) !== porter.id));
  void hunter;
});

test('S: explicit anchors snap to the nearest border block, also from inside; warehouse anchors (1.5)', { skip }, () => {
  const { world: w } = loadMission('Pimmons.mdb', 4, DATA, false);
  const ter = w.territory;
  for (const t of w.economy.towns) {
    const border = ter.record(t.id)!.border.map(b => [(b % ter.half) * 2, Math.floor(b / ter.half) * 2] as [number, number]);
    const nearest = (x: number, y: number) => {
      let best = border[0], bd = Infinity;
      for (const c of border) { const d = w.ai.dist(x, y, c[0], c[1]); if (d < bd) { bd = d; best = c; } }
      return [w.ai.mask(best[0]), w.ai.mask(best[1])];
    };
    assert.equal(ter.ownerAt(t.x, t.y), t.id, 'the centre lies inside');
    assert.deepEqual(snap(w.ai, t, t.x, t.y), nearest(t.x, t.y), 'an inside point moves to the border');
    assert.ok(snap(w.ai, t, t.x, t.y).join() !== `${t.x},${t.y}`);
    assert.deepEqual(anchor(w.ai, t, SMALL_OUTPOST, 0, -1), nearest(t.x - 50, t.y));
    assert.deepEqual(anchor(w.ai, t, LARGE_OUTPOST, 1, 1), nearest(t.x, t.y + 50));
    assert.deepEqual(anchor(w.ai, t, WATCHTOWER, 1, 1), nearest(t.x + 50, t.y - 50));
    // warehouses: count 0 / 1 the nearest point of the forest / stone list (Amazons forest first)
    for (const n of [0, 1]) {
      const list = w.lists[(t.race === 0) === (n === 0) ? 0 : 1]!;
      let best = list[0], bd = Infinity;
      for (const p of list) { const d = w.ai.dist(p[0], p[1], t.x, t.y); if (d < bd) { bd = d; best = p; } }
      assert.deepEqual(anchor(w.ai, t, WAREHOUSE, n, 1), nearest(best[0], best[1]), `race ${t.race} warehouse ${n}`);
    }
    // count 2: the first mine, else the town centre
    assert.deepEqual(anchor(w.ai, t, WAREHOUSE, 2, 1), nearest(t.x, t.y));
  }
  // an empty region list: cell (0, 0), snapped
  const t = w.economy.towns[0];
  const saved = w.lists[1];
  w.lists[1] = [];
  assert.deepEqual(anchor(w.ai, t, WAREHOUSE, 0, 1), snap(w.ai, t, 0, 0));
  w.lists[1] = saved;
});

test('E, M: the military job never refills outposts and advances only in working runs (2.2, 0.1)', { skip }, () => {
  const { world: w } = loadMission('Pimmons.mdb', 4, DATA, false);
  const t = w.economy.towns.find(x => x.race === 2)!;   // the Sajiki town: a town hall only
  const s = w.ai.startTown(t);
  const job = w.sched.get(s.military)!;
  // nothing military: the phase does not advance
  job.data[0] = 0;
  runMilitary(w.ai, job);
  assert.equal(job.data[0], 0, 'no barracks, soldier or hunter: the phase stays');
  // an active outpost with room and two idle defence archers outside
  const [px, py] = spot(w, t.x + 8, t.y + 8);
  const post = w.spawn({ cls: 1, group: t.race, type: SMALL_OUTPOST, owner: -1, x: px, y: py, z: 0 });
  post.town = t.id; post.complete = true; post.active = true;
  const archers = [0, 1].map(i => { const a = w.spawnUnit(t.race, ARCHER, ...spot(w, t.x + 3, t.y + 3, i), t.id); w.economy.joinTown(a, t); a.group = Grp.Defence; return a; });
  const rand = w.rand.state;
  runMilitary(w.ai, job);
  assert.equal(job.data[0], 1, 'phase 0 ran');
  assert.ok(archers.every(a => a.job === 0), 'no archer is sent into the outpost');
  assert.equal(w.rand.state, rand, 'no rand() drawn by the dead refill');
});

test('strike alert (combat.md 7 step 1): an attacker of a computer town is recorded even outside its territory; the response attacks it', { skip }, () => {
  const { world: w } = loadMission('Pimmons.mdb', 4, DATA, false);
  const t = w.economy.towns.find(x => x.race === 2)!;   // the Sajiki town
  w.ai.players[t.race] = w.ai.players[t.race] ?? { race: t.race, profile: 4, think: 0, army: 0, armyTown: -1, armyMembers: [], lastArmy: 0,
    lastMission: [0, 0, 0], discovered: [], cursor: 0, founding: 0, noSite: 0 } as AiPlayer;
  const s = w.ai.startTown(t);
  s.intruders = [];
  const hall = w.ai.list(t, TOWN_HALL)[0];
  const enemyRace = t.race === 0 ? 1 : 0;
  w.economy.players[enemyRace]!.relations[t.race] = 0; w.economy.players[t.race]!.relations[enemyRace] = 0;
  // the attacker stands outside every territory
  let ex = t.x + 30, ey = t.y + 30;
  while (w.territory.ownerAt(ex, ey) >= 0) { ex += 3; ey += 3; }
  const enemy = w.spawnUnit(enemyRace, HUNTER, ...spot(w, ex, ey), -1);
  assert.equal(w.territory.ownerAt(...w.ai.cell(enemy)), -1, 'outside');
  w.combat.attacked(hall, enemy);
  assert.deepEqual(s.intruders, [enemy.id], 'recorded by the strike');
  w.combat.attacked(hall, enemy);
  assert.deepEqual(s.intruders, [enemy.id], 'once');
  // a victim standing outside its own territory raises no alert
  const out = w.spawnUnit(t.race, PORTER, ...spot(w, ex, ey, 3), t.id);
  const other = w.spawnUnit(enemyRace, HUNTER, ...spot(w, ex, ey, 6), -1);
  w.combat.attacked(out, other);
  assert.ok(!s.intruders.includes(other.id));
  // the response (phase 1) sends the town's hunter at the recorded attacker, first run after 5 ticks
  w.combat.startAttack(enemy, hall, true, false, 1, false);
  const def = w.spawnUnit(t.race, HUNTER, ...spot(w, t.x + 4, t.y + 4), t.id);
  w.economy.joinTown(def, t);
  const job = w.sched.get(s.military)!;
  job.data[0] = 1;
  const delays: number[] = [];
  const create = w.sched.create.bind(w.sched);
  w.sched.create = (kind, owner, delay, data) => { if (kind === 0x08) delays.push(delay); return create(kind, owner, delay, data); };
  runMilitary(w.ai, job);
  w.sched.create = create;
  assert.equal(attackOf(w, def), enemy.id, 'the defender attacks the recorded attacker');
  assert.deepEqual(delays, [5], 'AI attack jobs start 5 ticks later (00465650)');
});
