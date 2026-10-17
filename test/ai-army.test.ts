// The computer players' attack army (docs/game/ai-diplomacy-trade.md 2.4, 2.5 "Joining and
// moving"): the candidate threshold gates only the creation and every candidate is sent; in the
// add-on, units join by island (one ship request per group on another island, at the join, not
// at every army run), waiting members are left alone by the tactics, and free warships sail in.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { loadMission, DATA, GOLD, HAS_GOLD, dataReader, rulesOf } from './helpers/mission.ts';
import { World, SUB, type Entity } from '../src/engine/world.ts';
import { Grp, AiJob } from '../src/engine/ai-defs.ts';
import { PROFILES, type AiPlayer } from '../src/engine/ai.ts';
import { NJ } from '../src/engine/naval.ts';
import { parseMdb } from '../src/formats/mission.ts';
import { parseOs } from '../src/formats/os.ts';
import { CLASS_TILESET } from '../src/world/terrain.ts';
import { aoPickTables } from '../src/world/addon-terrain.ts';
import { buildGeneratedWorld } from '../src/world/free-play.ts';
import { animalTypeCount } from '../src/formats/addon.ts';
import { applyFreePlay, spDefaults } from '../src/client/frontend/freeplay.ts';

const skip = !existsSync(`${DATA}/dv.odb`) && 'AN_DATA not set';
const skipGold = !HAS_GOLD && 'AN_GOLD data not found';
const HUNTER = 17, LIGHT_WARSHIP = 65;

// the AI's private parts used here
interface AiInternals {
  considerAttack(ps: AiPlayer, cands: Entity[], prof: unknown): void;
  joinArmy(ps: AiPlayer, cands: Entity[]): void;
}
const internals = (w: World) => w.ai as unknown as AiInternals;
const cellOf = (e: Entity): [number, number] => [Math.floor(e.x / SUB), Math.floor(e.y / SUB)];
const jobKind = (w: World, e: Entity) => (e.job ? w.sched.get(e.job)?.kind ?? 0 : 0);

/** free cells around (x, y) at a distance in [lo, hi) (Chebyshev rings), optionally on one island */
function cells(w: World, x: number, y: number, lo: number, hi: number, n: number, island?: number): [number, number][] {
  const out: [number, number][] = [];
  for (let r = lo; r < hi && out.length < n; r++) for (let dy = -r; dy <= r && out.length < n; dy++) for (let dx = -r; dx <= r && out.length < n; dx++) {
    if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
    const cx = (x + dx + w.size) % w.size, cy = (y + dy + w.size) % w.size;
    if (w.occupied(cx, cy) || !w.motion.free(cx, cy)) continue;
    if (island !== undefined && w.islandAt(cx, cy) !== island) continue;
    out.push([cx, cy]);
  }
  assert.equal(out.length, n, 'enough free cells');
  return out;
}

function player(race: number, profile: number): AiPlayer {
  return { race, profile, think: 0, army: 0, armyTown: -1, armyMembers: [], lastArmy: 0, lastMission: [0, 0, 0], discovered: [], cursor: 0, founding: 0, noSite: 0 };
}

test('profile 0 late in the game: a new army needs more than min(10, tick / 30000) free candidates and takes all of them; joining needs none (2.4)', { skip }, () => {
  const { world: w } = loadMission('Pimmons.mdb', 7, DATA, false);
  const human = w.ai.human();
  const ai = w.economy.players.find(p => p && p.computer && p.towns.length)!;
  assert.ok(human >= 0 && ai, 'a human and a computer player with a town');
  w.economy.players[ai.race]!.relations[human] = 0; w.economy.players[human]!.relations[ai.race] = 0;
  const home = w.economy.town(ai.towns[0])!;
  const ps = player(ai.race, 0);
  w.ai.players[ai.race] = ps;
  const hunters = cells(w, home.x, home.y, 3, 30, 12).map(([x, y]) => w.spawnUnit(ai.race, HUNTER, x, y, home.id));
  w.tick = 330000;   // min(10, 11) = 10: more than 10 candidates needed
  internals(w).considerAttack(ps, hunters.slice(0, 10), PROFILES[0]);
  assert.equal(ps.army, 0, '10 candidates: no army');
  internals(w).considerAttack(ps, hunters.slice(0, 11), PROFILES[0]);
  assert.ok(ps.army, '11 candidates: an army');
  assert.equal(ps.armyMembers.length, 11, 'every candidate joins, none is held back');
  assert.ok(hunters.slice(0, 11).every(u => u.group === Grp.Army));
  // a running army takes a single new candidate at the next think
  internals(w).joinArmy(ps, [hunters[11]]);
  assert.equal(ps.armyMembers.length, 12);
  assert.equal(hunters[11].group, Grp.Army);
});

test('an ending army draws rand() once per living member (the walk-home delay, 2.5); a retreat draws no next tactic', { skip }, () => {
  const { world: w } = loadMission('Pimmons.mdb', 7, DATA, false);
  const tt = w.economy.towns[0];
  const ra = 1;
  w.economy.players[ra]!.relations[tt.race] = 0; w.economy.players[tt.race]!.relations[ra] = 0;
  // a strong defence in the circle: enemy power > 2 x the army's
  for (const [x, y] of cells(w, tt.x, tt.y, 4, 20, 10)) w.spawnUnit(tt.race, 29, x, y, tt.id);
  const members = cells(w, tt.x, tt.y, 20, 39, 3).map(([x, y]) => w.spawnUnit(ra, HUNTER, x, y, -1));
  for (const u of members) u.group = Grp.Army;
  const job = w.sched.create(AiJob.Army, ra, 1, [tt.id, tt.x, tt.y, 0]);
  const ps = player(ra, 0);
  Object.assign(ps, { army: job.id, armyTown: tt.id, armyMembers: members.map(u => u.id) });
  w.ai.players[ra] = ps;
  let draws = 0;
  const orig = w.ai.rand.bind(w.ai);
  w.ai.rand = () => { draws++; return orig(); };
  assert.equal(w.ai.runJob(job), 0, 'retreat');
  assert.equal(ps.army, 0);
  assert.equal(draws, 3, 'one draw per living member, nothing else');
  assert.ok(members.every(u => u.group === Grp.None));
});

test('an idle army member far from the target point gets its attack job at the army run wherever it stands; a walking one that far is left alone (2.5 step 6)', { skip }, () => {
  // regression (add-on save, Amazon army landed 70 cells from the human town hall): ours walked
  // such members in legs first, and a leg ending in the sea left the whole army idle for good
  const { world: w } = loadMission('Pimmons.mdb', 7, DATA, false);
  const tt = w.economy.towns[0];
  const ra = 1;
  w.economy.players[ra]!.relations[tt.race] = 0; w.economy.players[tt.race]!.relations[ra] = 0;
  const [fx, fy] = cells(w, tt.x, tt.y, 4, 12, 1)[0];
  w.spawnUnit(tt.race, 29, fx, fy, tt.id);   // a fighter near the town hall: bucket 0 of the skirmish
  const far: [number, number][] = [];
  for (const c of cells(w, tt.x, tt.y, 45, 70, 200)) {
    if (w.territory.ownerAt(c[0], c[1]) === tt.id) continue;
    far.push(c);
    if (far.length === 2) break;
  }
  assert.equal(far.length, 2, 'two free cells far from the target and outside its territory');
  const [idle, walking] = far.map(([x, y]) => w.spawnUnit(ra, HUNTER, x, y, -1));
  const [wx, wy] = cellOf(walking);
  assert.ok(w.walk(walking, wx + 3, wy, 2000) && walking.path, 'the second member walks');
  for (const u of [idle, walking]) u.group = Grp.Army;
  const job = w.sched.create(AiJob.Army, ra, 1, [tt.id, tt.x, tt.y, 1]);
  const ps = player(ra, 0);
  Object.assign(ps, { army: job.id, armyTown: tt.id, armyMembers: [idle.id, walking.id] });
  w.ai.players[ra] = ps;
  assert.equal(w.ai.runJob(job), 50, 'the skirmish ran');
  assert.equal(jobKind(w, idle), 0x08, 'the idle member attacks at once, from where it stands');
  assert.ok(jobKind(w, walking) !== 0x08, 'the walking member is left alone');
  assert.ok(walking.path, 'and keeps walking');
});

/** island free play, all three races computer players (as in ai-navy.test.ts) */
function islandFreePlay(seed: number): World {
  const read = dataReader(GOLD);
  const base = parseMdb(read('InfiniteAO.mdb')!)[0];
  const m0 = applyFreePlay(base, { ...spDefaults(), development: 1, addon: true }, seed);
  const m = { ...m0, races: m0.races.map(r => ({ ...r, present: true, computer: true })) };
  const rules = rulesOf(GOLD, true);
  const pickOf = (n: string) => parseOs(read(`${n}.os`)!).pick;
  const hallOf = (race: number) => { const r = rules.rules.get(((race << 16) | 40) >>> 0); return r ? { sizeX: r.sizeX, sizeY: r.sizeY, radius: r.radius || 25 } : undefined; };
  const g = buildGeneratedWorld(m, { player: 0, hallOf, pick: CLASS_TILESET.map(pickOf), aoPick: aoPickTables(pickOf), animalTypes: animalTypeCount(rules.rules) });
  return new World(g.terrain, g.result.objects, rules.rules, {
    races: m.races, costs: rules.inventions.map(l => l.map(i => i.cost)), prerequisites: rules.inventions.map(l => l.map(i => i.prerequisites)),
    goals: m.goals, weapons: rules.weapons, orders: [], lists: g.result.lists,
  });
}

test('add-on: units join by island; one ship request per group on another island at the join; the army runs leave waiting members alone and request nothing more (2.5)', { skip: skipGold }, () => {
  const w = islandFreePlay(1);
  w.step();
  const [ra, rt] = [1, 0];
  const home = w.economy.towns.find(t => t.alive && t.race === ra)!;
  const tt = w.economy.towns.find(t => t.alive && t.race === rt)!;
  const [hi, ti] = [w.islandAt(home.x, home.y), w.islandAt(tt.x, tt.y)];
  assert.ok(hi > 0 && ti > 0 && hi !== ti, 'attacker and target on different islands');
  const atHome = cells(w, home.x, home.y, 3, 20, 3, hi).map(([x, y]) => w.spawnUnit(ra, HUNTER, x, y, home.id));
  const ashore = cells(w, tt.x, tt.y, 26, 36, 1, ti).map(([x, y]) => w.spawnUnit(ra, HUNTER, x, y, home.id));
  const pl = w.naval.planner(ra)!;
  assert.ok(pl, 'the nation has a naval planner');
  const before = pl.requests.length;
  const job = w.sched.create(AiJob.Army, ra, 1, [tt.id, tt.x, tt.y, 1]);
  const ps = player(ra, 0);
  Object.assign(ps, { army: job.id, armyTown: tt.id });
  w.ai.players[ra] = ps;
  internals(w).joinArmy(ps, [...atHome, ...ashore]);
  assert.equal(pl.requests.length, before + 1, 'one request for the group on the home island');
  const req = pl.requests[pl.requests.length - 1];
  assert.deepEqual([req.dx, req.dy], [tt.x, tt.y], 'destination = the target point');
  assert.deepEqual([req.px, req.py], cellOf(atHome[0]), 'pickup = the first member of the group');
  assert.deepEqual([...req.waiting].sort((a, b) => a - b), atHome.map(u => u.id).sort((a, b) => a - b));
  assert.ok(atHome.every(u => jobKind(w, u) === NJ.Wait), 'the group waits for the ship (job 0x3E)');
  assert.ok(ashore[0].path, 'the member on the target island, farther than 20 cells, walks in');
  // army runs (both tactics): no further request, waiting members keep waiting
  for (const tactic of [0, 1]) {
    job.data[3] = tactic;
    w.ai.runJob(job);
    assert.equal(pl.requests.length, before + 1, `tactic ${tactic}: no new request`);
    if (!ps.army) break;   // a retreat or a success ends the army: the waiting members walk home
    assert.ok(atHome.every(u => jobKind(w, u) === NJ.Wait || jobKind(w, u) === NJ.Board), `tactic ${tactic}: still waiting`);
  }
});

test('add-on: army requests (flag 1) are refused once the planner holds more than 50 requests, served ones included; the members wait anyway; founding requests are not refused (addon.md 8.4)', { skip: skipGold }, () => {
  const w = islandFreePlay(1);
  w.step();
  const [ra, rt] = [1, 0];
  const home = w.economy.towns.find(t => t.alive && t.race === ra)!;
  const tt = w.economy.towns.find(t => t.alive && t.race === rt)!;
  const hi = w.islandAt(home.x, home.y);
  const pl = w.naval.planner(ra)!;
  // 51 requests, all served: the planner keeps every one of them
  while (pl.requests.length < 51) w.naval.request(ra, 1, 0, home.x, home.y, tt.x, tt.y);
  for (const r of pl.requests) r.state = 3;
  w.naval.runJob(w.sched.get(pl.job)!);
  assert.equal(pl.requests.length, 51, 'served requests are not forgotten');
  // the army's join: its request is refused, the group waits all the same
  const group = cells(w, home.x, home.y, 3, 20, 2, hi).map(([x, y]) => w.spawnUnit(ra, HUNTER, x, y, home.id));
  const job = w.sched.create(AiJob.Army, ra, 1, [tt.id, tt.x, tt.y, 0]);
  const ps = player(ra, 0);
  Object.assign(ps, { army: job.id, armyTown: tt.id });
  w.ai.players[ra] = ps;
  internals(w).joinArmy(ps, group);
  assert.equal(pl.requests.length, 51, 'the army request was refused');
  assert.ok(group.every(u => jobKind(w, u) === NJ.Wait), 'its members wait for a ship that never comes');
  assert.equal(w.naval.request(ra, 1, 0, home.x, home.y, tt.x, tt.y, 1), 0, 'flag 1: refused');
  assert.ok(w.naval.request(ra, 1, 0, home.x, home.y, tt.x, tt.y, 0) > 0, 'flags 0 (founding): accepted');
});

test('add-on: a free warship is an army candidate and sails towards the target town when it joins (2.3, 2.5)', { skip: skipGold }, () => {
  const w = islandFreePlay(1);
  w.step();
  const ra = 1;
  const home = w.economy.towns.find(t => t.alive && t.race === ra)!;
  const tt = w.economy.towns.find(t => t.alive && t.race === 0)!;
  const sea = w.naval.spiral(home.x, home.y, 60, (x, y) => w.shipBlocked[(y << w.bits) | x] === 0)!;
  assert.ok(sea, 'open sea near the home town');
  const ship = w.spawnUnit(ra, LIGHT_WARSHIP, sea[0], sea[1], home.id);
  assert.ok(w.isShip(ship) && ship.group === Grp.None && !ship.job);
  // the think collects it with the hunters and soldiers (free group 0)
  const real = w.ai.players[ra]!;
  let cands: Entity[] = [];
  const ai = internals(w);
  ai.considerAttack = (_ps, c) => { cands = c; };
  ai.joinArmy = (_ps, c) => { cands = c; };
  w.ai.runJob(w.sched.get(real.think)!);
  assert.ok(cands.includes(ship), 'the free warship is a candidate');
  assert.equal(cands[cands.length - 1], ship, 'after the hunters and soldiers');
  delete (ai as Partial<AiInternals>).considerAttack;
  delete (ai as Partial<AiInternals>).joinArmy;
  const ps = player(ra, 0);
  w.ai.players[ra] = ps;
  const job = w.sched.create(AiJob.Army, ra, 1, [tt.id, tt.x, tt.y, 0]);
  Object.assign(ps, { army: job.id, armyTown: tt.id });
  internals(w).joinArmy(ps, [ship]);
  assert.equal(ship.group, Grp.Army);
  assert.ok(ps.armyMembers.includes(ship.id));
  assert.ok(ship.path, 'sailing');
  const [gx, gy] = [ship.path ? w.naval.lastGoal()[0] : -1, ship.path ? w.naval.lastGoal()[1] : -1];
  assert.equal(w.islandAt(gx, gy), 0, 'to a water cell');
  assert.ok(Math.max(Math.abs(gx - tt.x), Math.abs(gy - tt.y)) < Math.max(Math.abs(sea[0] - tt.x), Math.abs(sea[1] - tt.y)), 'towards the target town');
});
