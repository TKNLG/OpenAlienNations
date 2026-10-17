// Ceasefire and peace during a fight (docs/game/ai-diplomacy-trade.md 3.8, 2.2, 2.5;
// docs/game/combat.md 2.2, 5.1, 11): a relation change only writes the table. Running attacks and
// impacts in flight go on, and the first impact of either side restores war; a computer army
// ends at its next run and its members walk the whole way home; a defence response keeps
// intruders of a ceasefire / peace race on its list without attacking them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { loadMission, DATA } from './helpers/mission.ts';
import { SUB, type World, type Entity } from '../src/engine/world.ts';
import { Grp, AiJob } from '../src/engine/ai-defs.ts';
import { runMilitary } from '../src/engine/ai-town.ts';
import type { AiPlayer } from '../src/engine/ai.ts';

const skip = !existsSync(`${DATA}/dv.odb`) && 'AN_DATA not set';
const HUNTER = 17, ARCHER = 29, SABOTEUR = 26, TOWN_HALL = 40, IMPACT = 0x15, ATTACK = 0x08;

function spot(w: World, x: number, y: number, k = 0): [number, number] {
  let n = 0;
  for (let r = 0; r < 40; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    if (Math.max(Math.abs(dx), Math.abs(dy)) !== r || w.occupied(x + dx, y + dy) || !w.motion.free(x + dx, y + dy)) continue;
    if (n++ === k) return [(x + dx) & (w.size - 1), (y + dy) & (w.size - 1)];
  }
  throw new Error('no free cell');
}
/** free cells around (x, y) at a ring distance in [lo, hi) */
function ring(w: World, x: number, y: number, lo: number, hi: number, n: number): [number, number][] {
  const out: [number, number][] = [];
  for (let r = lo; r < hi && out.length < n; r++) for (let dy = -r; dy <= r && out.length < n; dy++) for (let dx = -r; dx <= r && out.length < n; dx++) {
    if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
    const cx = (x + dx + w.size) % w.size, cy = (y + dy + w.size) % w.size;
    if (w.occupied(cx, cy) || !w.motion.free(cx, cy)) continue;
    out.push([cx, cy]);
  }
  assert.equal(out.length, n, 'enough free cells');
  return out;
}
const cellOf = (e: Entity): [number, number] => [Math.floor(e.x / SUB), Math.floor(e.y / SUB)];
const attackOf = (w: World, u: Entity): number => {
  const j = u.job ? w.sched.get(u.job) : undefined;
  return j && !j.cancelled && j.kind === ATTACK ? j.data[0] : 0;
};
const setRel = (w: World, a: number, b: number, s: number) => { w.economy.players[a]!.relations[b] = s; w.economy.players[b]!.relations[a] = s; };
const pendingImpact = (w: World, target: Entity) => [...w.sched.jobs()].some(j => !j.cancelled && j.kind === IMPACT && j.owner === target.id);
function player(race: number): AiPlayer {
  return { race, profile: 0, think: 0, army: 0, armyTown: -1, armyMembers: [], lastArmy: 0, lastMission: [0, 0, 0], discovered: [], cursor: 0, founding: 0, noSite: 0 };
}

/** Pimmons mission 7: the human town and a computer race with a town far away (76 cells) */
function setup(ai: boolean) {
  const { world: w } = loadMission('Pimmons.mdb', 7, DATA, ai);
  const human = w.ai.human();
  const tt = w.economy.towns.find(t => t && t.alive && t.race === human)!;
  const ra = [0, 1, 2].find(r => r !== human && w.economy.players[r]?.computer && w.economy.players[r]!.towns.length)!;
  setRel(w, human, ra, 1);
  return { w, human, tt, ra, home: w.economy.town(w.economy.players[ra]!.towns[0])! };
}

for (const state of [2, 3]) {
  test(`${state === 2 ? 'ceasefire' : 'peace'} agreed while a blow is under way: nothing is cancelled and the impact restores war (3.8, combat.md 5.1)`, { skip }, () => {
    const { w, human, tt, ra } = setup(false);
    const [hx, hy] = spot(w, tt.x + 6, tt.y + 6);
    const h = w.spawnUnit(human, ARCHER, hx, hy, tt.id);
    const a = w.spawnUnit(ra, ARCHER, ...spot(w, hx + 3, hy), -1);
    w.combat.startAttack(a, h, true, false, 1, false);
    let k = 0;
    for (; k < 200 && !pendingImpact(w, h); k++) w.step();
    assert.ok(k < 200, 'the computer archer shoots');
    w.diplomacy.decide(human, ra, state);
    assert.equal(w.diplomacy.relation(human, ra), state, 'the offer is in force at once');
    assert.equal(attackOf(w, a), h.id, 'the attacker keeps its attack job');
    assert.equal(attackOf(w, h), a.id, 'the victim answered the strike (help rule) and keeps that attack too');
    for (k = 0; k < 60 && pendingImpact(w, h); k++) w.step();
    assert.equal(w.diplomacy.relation(human, ra), 1, 'the arrow in flight lands and the pair is at war again');
  });
}

test('a ceasefire before any blow holds: the army ends at its next run and nobody strikes for 3000 ticks (2.5, 3.8)', { skip }, () => {
  const { w, human, tt, ra, home } = setup(true);
  ring(w, tt.x, tt.y, 3, 8, 6).forEach(([x, y]) => w.spawnUnit(human, ARCHER, x, y, tt.id));
  const members = ring(w, tt.x, tt.y, 30, 36, 8).map(([x, y], i) => w.spawnUnit(ra, i < 4 ? ARCHER : HUNTER, x, y, home.id));
  for (const u of members) u.group = Grp.Army;
  const job = w.sched.create(AiJob.Army, ra, 1, [tt.id, tt.x, tt.y, 1]);
  const ps = w.ai.players[ra]!;
  Object.assign(ps, { army: job.id, armyTown: tt.id, armyMembers: members.map(u => u.id) });
  let hits = 0;
  const orig = w.sched.create.bind(w.sched);
  w.sched.create = (kind, owner, delay, data) => {
    const t = w.get(owner);
    if (kind === IMPACT && t && t.kind !== 2 && data && (t.oid >>> 16) !== data[3]) hits++;
    return orig(kind, owner, delay, data);
  };
  const t0 = w.tick;
  while (w.tick < t0 + 60) w.step();
  assert.equal(hits, 0, 'no contact yet');
  w.diplomacy.decide(human, ra, 2);
  while (w.tick < t0 + 120) w.step();
  assert.equal(ps.army, 0, 'the army ended at its next run');
  assert.ok(members.every(u => u.group !== Grp.Army && attackOf(w, u) === 0), 'no member attacks');
  while (w.tick < t0 + 1060) w.step();
  w.diplomacy.decide(human, ra, 3);
  while (w.tick < t0 + 3060) w.step();
  assert.equal(hits, 0, 'no strike by either side');
  assert.equal(w.diplomacy.relation(human, ra), 3, 'peace holds');
});

test('the members of an ended army walk the whole way home, not one 32-cell leg (2.5 last bullet)', { skip }, () => {
  const { w, tt, ra, home } = setup(false);
  setRel(w, w.ai.human(), ra, 2);
  const members = ring(w, tt.x, tt.y, 8, 14, 4).map(([x, y]) => w.spawnUnit(ra, HUNTER, x, y, home.id));
  for (const u of members) { u.group = Grp.Army; w.combat.startAttack(u, w.ai.list(tt, TOWN_HALL)[0], true, false, 1, false); }
  const dist = (u: Entity) => w.logistics.dist(...cellOf(u), home.x, home.y);
  assert.ok(members.every(u => dist(u) > 40), 'far from home');
  const job = w.sched.create(AiJob.Army, ra, 1, [tt.id, tt.x, tt.y, 1]);
  const ps = player(ra);
  Object.assign(ps, { army: job.id, armyTown: tt.id, armyMembers: members.map(u => u.id) });
  w.ai.players[ra] = ps;
  assert.equal(w.ai.runJob(job), 0, 'ceasefire: the army run ends the army');
  assert.equal(ps.army, 0);
  for (const u of members) {
    assert.equal(u.group, Grp.None);
    assert.equal(attackOf(w, u), 0, 'its attack job is cancelled');
    assert.ok(w.logistics.dist(u.goalX, u.goalY, home.x, home.y) <= 24, 'the walk goes to a cell next to the home town');
  }
  for (let k = 0; k < 4000 && members.some(u => u.path); k++) w.step();
  for (const u of members) assert.ok(dist(u) <= 26, `member ${u.id} arrived home (${dist(u)} cells off)`);
});

test('intruders of a race at ceasefire or peace stay on the list unattacked; back at war the response takes them (2.2)', { skip }, () => {
  const { world: w } = loadMission('Pimmons.mdb', 4, DATA, false);
  const t = w.economy.towns.find(x => x.race === 2)!;   // the Sajiki town
  w.ai.players[t.race] = w.ai.players[t.race] ?? player(t.race);
  const s = w.ai.startTown(t);
  const hall = w.ai.list(t, TOWN_HALL)[0];
  const enemyRace = t.race === 0 ? 1 : 0;
  setRel(w, enemyRace, t.race, 2);
  const enemy = w.spawnUnit(enemyRace, HUNTER, ...spot(w, t.x + 30, t.y + 30), -1);
  w.combat.startAttack(enemy, hall, true, false, 1, false);
  s.intruders = [enemy.id];
  const def = w.spawnUnit(t.race, HUNTER, ...spot(w, t.x + 4, t.y + 4), t.id);
  w.economy.joinTown(def, t);
  const job = w.sched.get(s.military)!;
  job.data[0] = 1;
  runMilitary(w.ai, job);
  assert.equal(attackOf(w, def), 0, 'not attacked under ceasefire');
  assert.deepEqual(s.intruders, [enemy.id], 'but kept on the list');
  setRel(w, enemyRace, t.race, 1);
  job.data[0] = 1;
  runMilitary(w.ai, job);
  assert.equal(attackOf(w, def), enemy.id, 'at war again: the defender attacks the kept intruder');
});

test('the bomb of a dead carrier still declares war (5.1: steps 3..6 follow every weapon routine)', { skip }, () => {
  const { w, human, tt, ra } = setup(false);
  setRel(w, human, ra, 3);
  const hall = w.ai.list(tt, TOWN_HALL)[0];
  const s = w.spawnUnit(ra, SABOTEUR, ...spot(w, tt.x + 6, tt.y + 6), -1);
  const wpn = w.combat.weapon(s)!;
  assert.equal(wpn.kind, 4, 'a bomb');
  w.sched.create(IMPACT, hall.id, 2, [s.id, wpn.index, 0, ra, SABOTEUR, 0]);
  w.combat.die(s);
  const hp = hall.hp;
  for (let k = 0; k < 4; k++) w.step();
  assert.equal(hall.hp, hp, 'no damage');
  assert.equal(w.diplomacy.relation(human, ra), 1, 'war');
});
