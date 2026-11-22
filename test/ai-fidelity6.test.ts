// Computer-player rules of fidelity batch 6 (docs/architecture/fidelity-audit.md, needs AN_DATA).
// Spec: docs/game/ai-diplomacy-trade.md 1.8, 1.10, 1.11, 1.12, 2.2, 2.4, 2.5, 3.5, 4.6.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { loadMission, DATA } from './helpers/mission.ts';
import { Kind, type World, type Entity } from '../src/engine/world.ts';
import { porterGang, runEconomy } from '../src/engine/ai-town.ts';
import { Grp, AiJob, U, B } from '../src/engine/ai-defs.ts';
import type { AiPlayer } from '../src/engine/ai.ts';
import type { Town } from '../src/engine/economy.ts';

const skip = !existsSync(`${DATA}/dv.odb`) && 'AN_DATA not set';

/** a free cell near (x, y) */
function spot(w: World, x: number, y: number, k = 0): [number, number] {
  let n = 0;
  for (let r = 0; r < 40; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    if (Math.max(Math.abs(dx), Math.abs(dy)) !== r || w.occupied(x + dx, y + dy) || !w.motion.free(x + dx, y + dy)) continue;
    if (n++ === k) return [x + dx, y + dy];
  }
  throw new Error('no free cell');
}

function player(race: number, profile: number): AiPlayer {
  return { race, profile, think: 0, army: 0, armyTown: -1, armyMembers: [], lastArmy: 0, lastMission: [0, 0, 0], discovered: [], cursor: 0,
    started: [], founding: 0, noSite: 0 };
}

/** Pimmons.mdb mission 4 with the Sajiki town run as a computer town (AI jobs not scheduled) */
function sajiki(profile = 4, race = 2) {
  const { world: w } = loadMission('Pimmons.mdb', 4, DATA, false);
  const t = w.economy.towns.find(x => x.race === race)!;
  w.economy.players[t.race]!.computer = true;
  const ps = player(t.race, profile);
  w.ai.players[t.race] = ps;
  const s = w.ai.startTown(t);
  return { w, t, ps, s };
}

// the private routines under test
type AiPrivate = {
  scouts(ps: AiPlayer, t: Town, s: unknown): void;
  considerAttack(ps: AiPlayer, cands: Entity[], prof: unknown): void;
  findSite(race: number): [number, number] | null;
  siteValid(race: number, x: number, y: number): boolean;
  diplomacy(ps: AiPlayer, prof: unknown): void;
};
const priv = (w: World) => w.ai as unknown as AiPrivate;

test('A1: profiles 3 and 5 cut the army from the front: the last candidates go (2.4)', { skip }, () => {
  const { w, t, ps } = sajiki(3);
  const human = w.ai.human();
  assert.ok(human >= 0 && w.ai.hostile(t.race, human), 'hostile to the human');
  const cands = [0, 1, 2, 3, 4].map(i => w.spawnUnit(t.race, U.Hunter, ...spot(w, t.x + 5, t.y + 5, i), t.id));
  // rand() mod 1, the cut (forced to 2: 1 + 1), the town index, the tactic, the delay
  const draws = [0, 1, 0, 0, 0];
  w.ai.rand = () => draws.shift() ?? 0;
  priv(w).considerAttack(ps, cands, { cooldown: 15 });
  assert.ok(ps.army, 'an army');
  assert.deepEqual(ps.armyMembers, [cands[3].id, cands[4].id], 'the last two candidates, in join order');
  assert.ok(cands.slice(0, 3).every(u => u.group === Grp.None), 'the first three stay free');
});

test('A2: every think sends up to w MORE free scouts exploring (2.3)', { skip }, () => {
  const { w, t, ps, s } = sajiki(0);
  t.population = 12;   // profile 0: w = P / 6 = 2
  const scouts = [0, 1, 2, 3, 4].map(i => w.spawnUnit(t.race, U.Scout, ...spot(w, t.x + 4, t.y + 4, i), t.id));
  const exploring = () => scouts.filter(u => u.job && w.sched.get(u.job)?.kind === AiJob.Explore).length;
  let draws = 0;
  const orig = w.ai.rand.bind(w.ai);
  w.ai.rand = () => { draws++; return orig(); };
  priv(w).scouts(ps, t, s);
  assert.equal(exploring(), 2, 'first think: two');
  assert.equal(draws, 2, 'one rand() per scout sent');
  priv(w).scouts(ps, t, s);
  assert.equal(exploring(), 4, 'second think: two more, although two already explore');
  priv(w).scouts(ps, t, s);
  assert.equal(exploring(), 5, 'third think: the last one');
});

test('A3: the founding site search is the radius-20 ring walk around each start candidate (1.12)', { skip }, () => {
  const { w, t } = sajiki();
  const cands = w.lists[3] ?? [];
  assert.ok(cands.length, 'start candidates');
  const want = (() => {
    for (const [px, py] of cands) {
      const c = w.naval.siteSearch(px, py, 20, (x, y) => priv(w).siteValid(t.race, x, y));
      if (c) return c;
    }
    return null;
  })();
  assert.deepEqual(priv(w).findSite(t.race), want);
  // the walk reaches 10 cells only: rings 1..9 plus the corner of ring 10
  const seen: [number, number][] = [];
  w.naval.siteSearch(100, 100, 20, (x, y) => { seen.push([x, y]); return false; });
  assert.equal(seen.length, 1 + [1, 2, 3, 4, 5, 6, 7, 8, 9].reduce((a, h) => a + 8 * h, 0) + 1);
  assert.deepEqual(seen[seen.length - 1], [110, 90]);
  assert.ok(seen.every(([x, y]) => Math.max(Math.abs(x - 100), Math.abs(y - 100)) <= 10));
});

test('A4: a foreign unit is recorded on every cell step inside a computer town\'s area, duplicates kept (2.2)', { skip }, () => {
  const { w, t, ps, s } = sajiki();
  s.intruders = [];
  const enemyRace = t.race === 0 ? 1 : 0;
  const [x, y] = spot(w, t.x + 3, t.y + 3);
  assert.equal(w.territory.ownerAt(x, y), t.id, 'inside the area');
  const e = w.spawnUnit(enemyRace, U.Hunter, x, y, -1);
  assert.deepEqual(s.intruders, [], 'placing records nothing');
  const [x2, y2] = spot(w, x, y, 1);
  w.stepTo(e, x2, y2, 6);
  w.stepTo(e, x, y, 6);
  assert.deepEqual(s.intruders, [e.id, e.id], 'one record per step');
  // the town's own units are not recorded; a computer unit learns the towns it steps into
  const own = w.spawnUnit(t.race, U.Porter, ...spot(w, t.x + 3, t.y + 3, 2), t.id);
  const ox = Math.floor(own.x / 256), oy = Math.floor(own.y / 256);
  ps.discovered = [];
  w.stepTo(own, ox, oy, 6);
  assert.deepEqual(s.intruders, [e.id, e.id]);
  assert.deepEqual(ps.discovered, [t.id], 'known town');
});

test('A6: the army goes on after its target town fell, against that race around the old town hall (2.5)', { skip }, () => {
  const { world: w } = loadMission('Pimmons.mdb', 7, DATA, false);
  const tt = w.economy.towns[0];
  const race = 1;
  assert.ok(w.ai.hostile(race, tt.race));
  const members = [0, 1, 2, 3].map(i => w.spawnUnit(race, U.Hunter, ...spot(w, tt.x + 6, tt.y + 6, 40 + i), -1));
  for (const u of members) u.group = Grp.Army;
  const job = w.sched.create(AiJob.Army, race, 1, [tt.id, tt.x, tt.y, 1]);
  const ps = player(race, 0);
  ps.army = job.id; ps.armyTown = tt.id; ps.armyMembers = members.map(u => u.id);
  w.ai.players[race] = ps;
  w.combat.destroyTown(tt);
  assert.ok(!tt.alive, 'the town fell');
  // a survivor of that race standing near the old town hall (a refugee, another town's unit)
  const other = w.economy.towns.find(o => o.alive && o.race === tt.race);
  const survivor = w.spawnUnit(tt.race, U.Hunter, ...spot(w, tt.x + 3, tt.y + 3), other ? other.id : -1);
  assert.equal(w.ai.runJob(job), 50, 'the army runs on');
  assert.equal(ps.army, job.id);
  assert.ok(members.some(u => u.job && w.sched.get(u.job)?.kind === 0x08 && w.sched.get(u.job)!.data[0] === survivor.id), 'it attacks the survivor');
  // the army holds the town: it stays in its nation's list
  w.economy.releaseTowns();
  assert.ok(w.economy.players[tt.race]!.towns.includes(tt.id), 'held by the army');
  // nothing of that race left in the circle: success, the army ends
  w.combat.die(survivor);
  for (const e of w.combat.scan(tt.x, tt.y, 40)) if (e.kind === Kind.Unit && (e.oid >>> 16) === tt.race) w.combat.die(e);
  job.data[3] = 1;
  assert.equal(w.ai.runJob(job), 0, 'ends as a success');
  assert.equal(ps.army, 0);
});

test('1.11: research is chosen at the laboratory\'s activation and the completion; started = ever selected', { skip }, () => {
  const { w, t, ps } = sajiki(4, 0);   // the Amazon computer town has an active laboratory
  const p = w.economy.players[t.race]!;
  // the data gives each race only one of the two; give both for the test (stonemason 5, woodcutter 7)
  const sm = 5, wc = 7;
  w.rules.get(((t.race << 16) | U.Stonemason) >>> 0)!.invention = sm;
  w.rules.get(((t.race << 16) | U.Woodcutter) >>> 0)!.invention = wc;
  w.ai.prerequisites = [[], [], []];
  for (let i = 0; i < p.progress.length; i++) p.progress[i] = 0;
  // activation: cursor 0, the first open entry is selected at once
  t.research = -1;
  w.ai.labActive(t);
  assert.equal(t.research, 0);
  assert.deepEqual(ps.started, [0]);
  assert.equal(ps.cursor, 1);
  // a second activation resets the cursor; entry 0 is started now, so entry 1 replaces it
  w.ai.labActive(t);
  assert.equal(t.research, 1);
  assert.deepEqual(ps.started, [0, 1]);
  // completion with the pick equal to the stonemason's invention: the woodcutter's comes first
  p.progress[1] = p.costs[1];
  ps.cursor = sm;
  t.research = -1;
  w.ai.researchDone(t);
  assert.equal(t.research, wc, 'pick = stonemason invention: woodcutter override');
  assert.equal(ps.cursor, sm + 1, 'the pick advanced the cursor');
  // the economy's research step calls the completion itself (needs the town's first laboratory active)
  assert.ok(w.economy.firstActive(t, B.Lab), 'an active laboratory');
  const job = w.sched.get(t.researchJob)!;
  p.progress[wc] = p.costs[wc] - 0.001;
  t.researchSpent = 100; p.money = 100000;
  w.economy.runJob(job);
  assert.ok(w.economy.researched(p, wc));
  assert.equal(t.research, sm, 'next: the stonemason override (not invented, not the pick)');
});

test('1.8 / 1.10: gangs keep join order, release the oldest member, and count dead members until a search', { skip }, () => {
  const { w, t, s } = sajiki();
  // porter gang: join order, the surplus leaves from the front
  const porters = [0, 1, 2, 3].map(i => w.spawnUnit(t.race, U.Porter, ...spot(w, t.x + 6, t.y + 6, i), t.id));
  for (const e of w.entities) if (e.kind === Kind.Unit && e.town === t.id && (e.oid & 0xffff) === U.Porter) e.group = Grp.None;
  s.porters = [];
  const reversed = [...porters].reverse();
  for (const e of reversed) { e.group = Grp.Porters; s.porters.push(e.id); }
  porterGang(w.ai, t);
  const n = s.porters.length;
  assert.ok(n < reversed.length, 'the gang is cut');
  assert.deepEqual(s.porters, reversed.slice(reversed.length - n).map(e => e.id), 'the first joined left first');
  assert.ok(reversed.slice(0, reversed.length - n).every(e => e.group === Grp.None));
  // woodcutter gang (Sajiki below P 16: one): the front leaves first; a dead member stays counted
  t.population = 10;
  for (const e of w.entities) if (e.kind === Kind.Unit && e.town === t.id && (e.oid & 0xffff) === U.Woodcutter) e.group = Grp.Defence;   // keep the map's woodcutters out
  const wc = [0, 1, 2, 3].map(i => w.spawnUnit(t.race, U.Woodcutter, ...spot(w, t.x + 7, t.y + 7, 10 + i), t.id));
  for (const e of wc.slice(0, 3)) e.group = Grp.Economy;
  s.gangs = { [U.Woodcutter]: [wc[0].id, wc[1].id, wc[2].id] };
  w.combat.die(wc[0]);
  const job = w.sched.get(s.economy)!;
  job.data[0] = 1; runEconomy(w.ai, job);
  assert.deepEqual(s.gangs[U.Woodcutter], [wc[2].id], 'the two first entries left (the dead one dropped)');
  assert.equal(wc[1].group, Grp.None);
  w.combat.die(wc[2]);
  job.data[0] = 1; runEconomy(w.ai, job);
  assert.deepEqual(s.gangs[U.Woodcutter], [wc[2].id], 'the dead member still fills the place');
  assert.equal(wc[3].group, Grp.None, 'no free woodcutter joins');
});

test('4.6: merchants without a partner only lose their group, the route goes on; no active first market: nothing (A kept)', { skip }, () => {
  const { w, t, s } = sajiki();
  const job = w.sched.get(s.economy)!;
  const runMarkets = () => { job.data[0] = 2; runEconomy(w.ai, job); };
  const m = w.spawnUnit(t.race, U.Merchant, ...spot(w, t.x + 5, t.y + 5), t.id);
  const other = w.economy.towns.find(o => o.id !== t.id && o.alive)!;
  w.trade.startRoute(m, t.id, other.id, false);
  const route = m.job;
  m.group = Grp.Economy;
  const markets = w.ai.list(t, B.Market);
  if (!markets.length || !markets[0].active) {
    s.A[U.Merchant] = 7;
    runMarkets();
    assert.equal(s.A[U.Merchant], 7, 'no active first market: the want keeps its value');
    assert.equal(m.group, Grp.Economy);
    return;
  }
  // with an active market and no partner (every other town hostile): group 0, the route stays
  for (const o of w.economy.players) if (o && o.race !== t.race) { o.relations[t.race] = 0; w.economy.players[t.race]!.relations[o.race] = 0; }
  runMarkets();
  assert.equal(s.A[U.Merchant], 0);
  assert.equal(m.group, Grp.None);
  assert.equal(m.job, route, 'the route is kept');
});

test('3.5: a townless living player is evaluated too (flags, rand() draw)', { skip }, () => {
  const { w, t, ps } = sajiki(0);
  const human = w.ai.human();
  const hp = w.economy.players[human]!;
  const saved = hp.towns;
  hp.towns = [];
  assert.ok(!w.ai.living(human) && !hp.defeated, 'alive without a town');
  w.tick = 7000;
  let draws = 0;
  const orig = w.ai.rand.bind(w.ai);
  w.ai.rand = () => { draws++; return orig(); };
  const others = [0, 1, 2].filter(r => r !== t.race && w.economy.players[r] && !w.economy.players[r]!.defeated).length;
  priv(w).diplomacy(ps, { w1: 1500, w2: 1000 });
  assert.equal(draws, others, 'one rand() per other alive player after tick 6001');
  hp.towns = saved;
});
