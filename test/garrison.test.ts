// Outposts and their garrison: who may enter, staying inside, the outpost job, garrison range,
// the turn before a shot, send-out and collapse, snapshots; the garrison's draw positions.
// Spec: docs/game/combat.md 9 (9.1-9.9), 4.1, 16; docs/game/units-and-jobs.md 4.4, 4.10, 4.11;
// docs/rendering/objects.md 13; docs/rendering/projectiles.md 2.6. The synthetic tests need no
// game data; the map-load test needs AN_DATA.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { World, SUB, Kind, type Entity } from '../src/engine/world.ts';
import { CJ, Combat, type CombatEffect } from '../src/engine/combat.ts';
import { dirToward } from '../src/engine/path.ts';
import { MJ } from '../src/engine/motion.ts';
import type { ObjectRule } from '../src/formats/odb.ts';
import type { Weapon } from '../src/formats/wdb.ts';
import type { Terrain } from '../src/world/terrain.ts';
import { garrisonList, garrisonSlot, garrisonFeet, garrisonLaunch, garrisonPoint } from '../src/client/garrison.ts';
import { loadMission, DATA } from './helpers/mission.ts';

// ---------------------------------------------------------------- a synthetic world

const AMAZONS = 0, PIMMONS = 1;
const PORTER = 9, DIPLOMAT = 13, ARCHER = 29, FIGHTER = 30, BOMBER = 32, CROSSBOW = 36;
const SMALL = 52, LARGE = 53, TOWER = 60;
const BOW = 0, XBOW = 1, SWORD = 2, BOMB = 3;
const oid = (race: number, type: number) => ((race << 16) | type) >>> 0;

function weapons(): Weapon[] {
  const w = (index: number, kind: number, projectile: number, min: number, max: number, range: number, cooldown: number, hit: number): Weapon =>
    ({ index, kind, projectile, min, max, range, speed: 1000, cooldown, hit, name: '' });
  return [w(BOW, 2, 1, 10, 20, 6, 35, 95), w(XBOW, 2, 3, 15, 25, 8, 40, 95), w(SWORD, 1, -1, 5, 10, 0, 10, 90), w(BOMB, 4, -1, 400, 800, 0, 10, 100)];
}

function rules(): Map<number, ObjectRule> {
  const m = new Map<number, ObjectRule>();
  const base = { name: '', sound: 0, soundFrame: 7, soundAction: 1, radius: 6, residents: 0, flags: 0, money: 0,
    garrison: 0, invention: -1, madeAt: -1, cost: [0, 0, 5, 0, 0, 0, 0, 0, 0], product: -1, amount: 0, slot: 0, needPop: 0,
    message: 0, weapon: -1, impact: 0, points: [] as [number, number][], operator: -1 };
  const unit = (race: number, type: number, cls: number, weapon: number) => m.set(oid(race, type), { ...base, id: oid(race, type), group: race, kind: 0, type,
    sizeX: 1, sizeY: 1, doorDx: 0, doorDy: 0, hp: 100, cls, weapon, stepTime: [5, 6, 7, 8] } as ObjectRule);
  for (const race of [AMAZONS, PIMMONS]) {
    unit(race, PORTER, 0, -1); unit(race, DIPLOMAT, 0, -1);
    unit(race, ARCHER, 2, BOW); unit(race, CROSSBOW, 2, XBOW); unit(race, BOMBER, 2, BOMB); unit(race, FIGHTER, 1, SWORD);
  }
  // Pimmon outposts (combat.md 9.1, objects.md 13.2): small 2x2 door (+1, -1), large 3x3 door (+1, -2)
  const pts = (l: [number, number][]) => [...l, ...new Array(8 - l.length).fill([0, 0])] as [number, number][];
  m.set(oid(PIMMONS, SMALL), { ...base, id: oid(PIMMONS, SMALL), group: PIMMONS, kind: 1, type: SMALL, sizeX: 2, sizeY: 2, doorDx: 1, doorDy: -1,
    hp: 600, cls: 6, garrison: 2, radius: 15, stepTime: [0, 0, 0, 0], points: pts([[151, 97], [178, 114], [164, 118], [147, 98], [199, 90]]) } as ObjectRule);
  m.set(oid(PIMMONS, LARGE), { ...base, id: oid(PIMMONS, LARGE), group: PIMMONS, kind: 1, type: LARGE, sizeX: 3, sizeY: 3, doorDx: 1, doorDy: -2,
    hp: 800, cls: 6, garrison: 3, radius: 25, stepTime: [0, 0, 0, 0], points: pts([[216, 57], [137, 73], [151, 50]]) } as ObjectRule);
  // a 1x1 building of the enemy: a target that does not move
  m.set(oid(AMAZONS, TOWER), { ...base, id: oid(AMAZONS, TOWER), group: AMAZONS, kind: 1, type: TOWER, sizeX: 1, sizeY: 1, doorDx: 0, doorDy: -1,
    hp: 100000, cls: -1, stepTime: [0, 0, 0, 0] } as ObjectRule);
  return m;
}
function flatTerrain(bits: number): Terrain {
  const n = 1 << bits;
  return { sizeBits: bits, size: n, height: new Uint16Array(n * n).fill(128), cls: new Uint8Array(n * n), tile: new Uint8Array(n * n) };
}
const cell = (e: Entity): [number, number] => [Math.floor(e.x / SUB), Math.floor(e.y / SUB)];
const jobKind = (w: World, e: Entity) => (e.job ? w.sched.get(e.job)?.kind ?? -1 : 0);
const steps = (w: World, n: number) => { for (let i = 0; i < n; i++) w.step(); };

/** a world with a Pimmon outpost (anchor 60, 60); relations Pimmons/Amazons `rel` (default war) */
function postWorld(type = SMALL, rel = 1) {
  const w = new World(flatTerrain(7), [], rules());
  w.weapons = weapons();
  w.economy.ensurePlayer(AMAZONS); w.economy.ensurePlayer(PIMMONS);
  w.combat.setRelation(PIMMONS, AMAZONS, rel);
  const post = w.spawn({ cls: 1, group: PIMMONS, type, owner: -1, x: 60, y: 60, z: 0 });
  post.complete = true;
  const unit = (race: number, t: number, x: number, y: number) => w.spawn({ cls: 0, group: race, type: t, owner: -1, x, y, z: 0 });
  const tower = (x: number, y: number) => { const b = w.spawn({ cls: 1, group: AMAZONS, type: TOWER, owner: -1, x, y, z: 0 }); b.complete = true; return b; };
  return { w, post, unit, tower, entrance: w.logistics.entrance(post) };
}
/** a unit of `type` put inside the outpost through the "entered" path, as at map load (anchor cell) */
function garrisoned(w: World, post: Entity, type = ARCHER, race = PIMMONS): Entity {
  const u = w.spawn({ cls: 0, group: race, type, owner: -1, x: Math.floor(post.x / SUB), y: Math.floor(post.y / SUB), z: 0 });
  w.motion.vacate(u);
  w.putInside(u, post);
  w.combat.startOutpost(post);
  return u;
}
/** step until `f` holds; returns the ticks taken */
function until(w: World, f: () => boolean, max = 400): number {
  for (let i = 1; i <= max; i++) { w.step(); if (f()) return i; }
  throw new Error('condition never met');
}

// ---------------------------------------------------------------- admission (9.1, units-and-jobs.md 4.4)

test('garrison: an archer walks in and stays inside with no job; the outpost job starts 20 ticks later', {}, () => {
  const { w, post, unit, tower, entrance } = postWorld();
  // an enemy in reach from the start: the first fire job marks the outpost job's first run
  const t = tower(60, 72);
  const a = unit(PIMMONS, ARCHER, entrance[0] + 3, entrance[1]);
  w.schedule({ type: 'order', player: PIMMONS, ids: [a.id], target: post.id });
  until(w, () => a.inside === post.id);
  const E = w.tick;
  assert.equal(a.job, 0, 'the unit inside has no job');
  assert.ok(post.opJob, 'the outpost job was created at the "entered" step');
  assert.equal(w.sched.get(post.opJob)?.kind, CJ.Outpost);
  assert.deepEqual(garrisonList(w, post).map(u => u.id), [a.id], 'it is in the garrison list (display flag 4)');
  const n = until(w, () => jobKind(w, a) === CJ.GarrisonFire);
  assert.equal(w.tick - E, 20, `first outpost run 20 ticks after entering (${w.tick - E})`);
  assert.equal(w.sched.get(a.job)!.data[0], t.id);
  assert.ok(n > 0);
  steps(w, 400);
  assert.equal(a.inside, post.id, 'a garrison stays (nothing ejects it)');
  assert.ok(post.opJob && !w.sched.get(post.opJob)!.cancelled, 'the outpost job runs on');
});

test('garrison: refused units (wrong class, other race, a site) stand idle at the door', {}, () => {
  for (const [what, race, type, site] of [['fighter', PIMMONS, FIGHTER, false], ['porter', PIMMONS, PORTER, false],
    ['Amazon archer', AMAZONS, ARCHER, false], ['archer at a site', PIMMONS, ARCHER, true]] as const) {
    const { w, post, unit, entrance } = postWorld();
    if (site) post.complete = false;
    const u = unit(race, type, entrance[0] + 2, entrance[1] + 1);
    w.logistics.goInto(u, post, 1);
    until(w, () => u.job === 0 && !u.path, 200);
    steps(w, 30);
    assert.equal(u.inside, -1, `${what}: not admitted`);
    assert.equal(u.job, 0, `${what}: idle`);
    const [x, y] = cell(u);
    assert.ok(Math.abs(x - entrance[0]) <= 1 && Math.abs(y - entrance[1]) <= 1, `${what}: in front of the door`);
    assert.deepEqual(post.doorQueue, [], `${what}: not queued`);
    assert.equal(post.door, 0, `${what}: the door never opened`);
  }
});

test('garrison: the class-2 types and the capacity test at the first request', {}, () => {
  const { w, post } = postWorld();
  const mk = (race: number, type: number) => w.spawn({ cls: 0, group: race, type, owner: -1, x: 10, y: 10, z: 0 });
  assert.ok(w.logistics.mayEnter(mk(PIMMONS, ARCHER), post));
  assert.ok(w.logistics.mayEnter(mk(PIMMONS, CROSSBOW), post));
  assert.ok(w.logistics.mayEnter(mk(PIMMONS, BOMBER), post));
  assert.ok(!w.logistics.mayEnter(mk(PIMMONS, FIGHTER), post));
  assert.ok(!w.logistics.mayEnter(mk(AMAZONS, ARCHER), post));
  garrisoned(w, post); garrisoned(w, post);
  assert.ok(!w.logistics.mayEnter(mk(PIMMONS, ARCHER), post), 'full: 2 of 2');
});

test('garrison: a full outpost refuses at the first request; units queued before all get in (quirk)', {}, () => {
  // one after the other: the third archer asks when two are inside and is refused
  {
    const { w, post, unit, entrance } = postWorld();
    const [a, b, c] = [0, 1, 2].map(k => unit(PIMMONS, ARCHER, entrance[0] + 4 + 2 * k, entrance[1] + 3));
    for (const u of [a, b]) { w.logistics.goInto(u, post, 1); until(w, () => u.inside === post.id); }
    w.logistics.goInto(c, post, 1);
    until(w, () => c.job === 0, 300);
    steps(w, 20);
    assert.equal(c.inside, -1, 'the third is refused');
    assert.equal(w.logistics.occupants(post).length, 2);
  }
  // all three queue before the first is inside: the capacity was tested only once, all enter
  {
    const { w, post, unit, entrance } = postWorld();
    const us = [[1, 0], [1, 1], [2, 0]].map(([dx, dy]) => unit(PIMMONS, ARCHER, entrance[0] + dx, entrance[1] + dy));
    for (const u of us) w.logistics.goInto(u, post, 1);
    until(w, () => us.every(u => u.inside === post.id), 300);
    assert.equal(w.logistics.occupants(post).length, 3, 'three in a two-place outpost');
    assert.equal(garrisonList(w, post).length, 3);
  }
});

// ---------------------------------------------------------------- targets (9.3)

test('garrison: targets only races at war or without contact; diplomats never; the first in scan order', {}, () => {
  for (const [rel, shoots] of [[0, true], [1, true], [2, false], [3, false]] as const) {
    const { w, post, unit } = postWorld(SMALL, rel);
    const a = garrisoned(w, post);
    const p = unit(AMAZONS, PORTER, 60, 66);
    until(w, () => w.sched.get(post.opJob) !== undefined && w.tick > 21, 40);
    assert.equal(jobKind(w, a) === CJ.GarrisonFire, shoots, `relation ${rel}`);
    if (shoots) assert.equal(w.sched.get(a.job)!.data[0], p.id);
  }
  {
    const { w, post, unit } = postWorld();
    const a = garrisoned(w, post);
    unit(AMAZONS, DIPLOMAT, 60, 65);             // a diplomat is dropped, even at war
    unit(PIMMONS, PORTER, 60, 66);               // the own race is dropped
    const p1 = unit(AMAZONS, PORTER, 60, 67);    // first remaining candidate (ascending id)
    unit(AMAZONS, PORTER, 60, 64);               // nearer, but later in scan order
    steps(w, 22);
    assert.equal(jobKind(w, a), CJ.GarrisonFire);
    assert.equal(w.sched.get(a.job)!.data[0], p1.id, 'scan order, not the nearest');
  }
});

test('garrison: the outpost job never ends by itself and cancels other jobs of its idle soldiers', {}, () => {
  const { w, post } = postWorld();
  const a = garrisoned(w, post);
  steps(w, 25);
  assert.equal(a.job, 0, 'no target: idle');
  // an idle-turn (fidget) job given to the unit inside is cancelled by the next outpost run
  a.job = w.sched.create(MJ.TurnIdle, a.id, 30, [5, 0, 0]).id;
  steps(w, 20);
  assert.equal(a.job, 0, 'the other job was cancelled');
  assert.equal(a.inside, post.id, 'never ejected');
  steps(w, 300);
  assert.ok(post.opJob && w.sched.get(post.opJob) && !w.sched.get(post.opJob)!.cancelled, 'runs every 20 ticks, also without targets');
});

// ---------------------------------------------------------------- range (9.5)

test('garrison range: E = 1.5 R; archer 13 straight / 9 diagonal, crossbow 17 / 12; the origin cell counts', {}, () => {
  const { w, post, unit } = postWorld(LARGE);
  const [bow, xbow] = [w.weapons[BOW], w.weapons[XBOW]];
  assert.deepEqual([5, 6, 8, 0].map(Combat.garrisonBonus), [7, 9, 12, 0]);
  const reach = (wpn: Weapon, dx: number, dy: number) => {
    let n = 0;
    for (let k = 1; k < 30; k++) {
      const t = unit(AMAZONS, PORTER, 30 + dx * k, 30 + dy * k);
      const ok = w.combat.inRange(30, 30, t, wpn, post);
      w.removeEntity(t);
      if (!ok) break;
      n = k;
    }
    return n;
  };
  assert.equal(reach(bow, 1, 0), 13); assert.equal(reach(bow, 0, -1), 13); assert.equal(reach(bow, 1, 1), 9); assert.equal(reach(bow, -1, 1), 9);
  assert.equal(reach(xbow, 1, 0), 17); assert.equal(reach(xbow, 1, 1), 12);
  // buildings in the way do not block a garrison shot
  const t = unit(AMAZONS, PORTER, 40, 30);
  w.spawn({ cls: 1, group: AMAZONS, type: TOWER, owner: -1, x: 35, y: 30, z: 0 });
  assert.ok(w.combat.inRange(30, 30, t, bow, post));
  assert.ok(!w.combat.inRange(30, 30, t, bow), 'on the ground the building blocks (3.4)');
  // range-0 weapons (bomb carriers): adjacency from a tower too
  const bomb = w.weapons[BOMB];
  const n1 = unit(AMAZONS, PORTER, 51, 50), n2 = unit(AMAZONS, PORTER, 52, 50);
  assert.ok(w.combat.inRange(50, 50, n1, bomb, post));
  assert.ok(!w.combat.inRange(50, 50, n2, bomb, post));
});

test('garrison range: the scan disc limits a crossbow in a small outpost to 14 straight / 10 diagonal', {}, () => {
  const probe = (type: number, dx: number, dy: number) => {
    const { w, post, tower } = postWorld(type);
    const a = garrisoned(w, post, CROSSBOW);
    tower(60 + dx, 60 + dy);
    steps(w, 22);
    return jobKind(w, a) === CJ.GarrisonFire;
  };
  assert.ok(probe(SMALL, 14, 0)); assert.ok(!probe(SMALL, 15, 0));
  assert.ok(probe(SMALL, 10, 10)); assert.ok(!probe(SMALL, 11, 11));
  // the large outpost's disc (25) leaves the crossbow its full reach
  assert.ok(probe(LARGE, 17, 0)); assert.ok(!probe(LARGE, 18, 0));
  assert.ok(probe(LARGE, -12, -12)); assert.ok(!probe(LARGE, -13, -13));
});

test('garrison-fire: range from the soldier\'s own stored cell (quirk): no shot at the far edge for a walked-in unit', {}, () => {
  const { w, post, unit, tower, entrance } = postWorld();
  const a = unit(PIMMONS, ARCHER, entrance[0] + 1, entrance[1]);
  w.logistics.goInto(a, post, 1);
  until(w, () => a.inside === post.id);
  assert.deepEqual(cell(a), entrance, 'it keeps the cell it entered from');
  // 13 cells beyond the anchor on the far side: in reach of the anchor, 14 from the entrance
  tower(60 - 13, 60);
  const shots: CombatEffect[] = [];
  for (let i = 0; i < 120; i++) { w.step(); shots.push(...w.effects.splice(0).filter(e => e.kind === 'shot')); }
  assert.equal(shots.length, 0, 'never fires');
  assert.equal(a.inside, post.id);
});

// ---------------------------------------------------------------- the shot (9.7)

test('garrison shot: the soldier turns 45 degrees per 2 ticks toward the target, measured from the outpost, then fires', {}, () => {
  const { w, post, tower } = postWorld();
  const a = garrisoned(w, post);
  const t = tower(60, 70);
  const want = dirToward(0, 10);
  a.dir = (want + 4) % 8;                         // four steps away
  const created = until(w, () => jobKind(w, a) === CJ.GarrisonFire) + 0;
  const T0 = w.tick;
  const dirs: number[] = [];
  let shot: CombatEffect | undefined;
  for (let i = 0; i < 30 && !shot; i++) {
    w.step();
    dirs.push(a.dir);
    shot = w.effects.splice(0).find(e => e.kind === 'shot');
  }
  assert.ok(created > 0 && shot, 'it fired');
  // fire job runs at +1 (creates the strike child), strike from +2: 4 turns of 2 ticks, then the shot
  assert.equal(shot!.tick - T0, 1 + 1 + 4 * 2, `shot ${shot!.tick - T0} ticks after the fire job was created`);
  assert.equal(a.dir, want);
  assert.equal(new Set(dirs).size, 5, 'four single steps');
  assert.equal(shot!.garrison, post.id);
  assert.deepEqual([shot!.x, shot!.y], cell(post), 'on screen the shot starts at the outpost');
  assert.deepEqual([shot!.tx, shot!.ty], cell(t));
  // the same cooldown as on the ground: the next shot 36..53 ticks later
  let next: CombatEffect | undefined;
  for (let i = 0; i < 80 && !next; i++) { w.step(); next = w.effects.splice(0).find(e => e.kind === 'shot'); }
  assert.ok(next && next.tick - shot!.tick >= 36 && next.tick - shot!.tick <= 53, `interval ${next && next.tick - shot!.tick}`);
});

test('garrison shot: the help rule names the outpost; the victim\'s friends attack the building', {}, () => {
  const { w, post, unit } = postWorld();
  garrisoned(w, post);
  const v = unit(AMAZONS, PORTER, 60, 68);
  const f = unit(AMAZONS, FIGHTER, 62, 70);
  until(w, () => jobKind(w, f) === CJ.Attack, 100);
  assert.equal(w.sched.get(f.job)!.data[0], post.id, 'the friend attacks the outpost, not the soldier inside');
  assert.ok(v);
});

test('garrison: a bomb carrier blows up an adjacent enemy and dies inside the outpost', {}, () => {
  const { w, post, tower } = postWorld();
  const b = garrisoned(w, post, BOMBER);
  const t = tower(61, 60);                         // next to the anchor and to the anchor-stored carrier
  const hp0 = t.hp;
  until(w, () => !b.alive, 100);
  assert.ok(t.hp <= hp0 - 400, 'the target took 400..800');
  assert.equal(w.get(b.id), undefined);
  assert.deepEqual(garrisonList(w, post), []);
});

// ---------------------------------------------------------------- leaving (9.8, 9.9)

test('garrison: send-out ejects the first one in; it stays drawn on the tower until placed; the last ranged unit out ends the job', {}, () => {
  const { w, post } = postWorld();
  const a = garrisoned(w, post), b = garrisoned(w, post);
  const job = post.opJob;
  w.schedule({ type: 'sendOut', player: PIMMONS, building: post.id, unit: ARCHER });
  w.step();
  assert.ok(w.logistics.leaving(a) && !w.logistics.leaving(b), 'first in, first out');
  assert.deepEqual(w.logistics.occupants(post).map(u => u.id), [b.id], 'out of the occupant list at once');
  assert.deepEqual(garrisonList(w, post).map(u => u.id), [a.id, b.id], 'still drawn in its slot');
  assert.equal(garrisonSlot(w, b), 1);
  until(w, () => a.inside < 0, 60);
  assert.deepEqual(garrisonList(w, post).map(u => u.id), [b.id], 'slots close up when it is placed');
  assert.equal(garrisonSlot(w, b), 0);
  assert.equal(a.job, 0, 'idle at the door');
  assert.deepEqual(cell(a), w.logistics.entrance(post));
  assert.equal(post.opJob, job, 'a ranged unit is still inside');
  w.schedule({ type: 'sendOut', player: PIMMONS, building: post.id, unit: ARCHER });
  until(w, () => b.inside < 0, 60);
  assert.equal(post.opJob, 0, 'the last ranged unit out: the outpost job is cancelled');
  steps(w, 200);
  assert.equal(a.inside, -1, 'never sent back in');
});

test('garrison: a non-ranged unit put outside does not end the outpost job', {}, () => {
  const { w, post } = postWorld();
  const p = w.spawn({ cls: 0, group: PIMMONS, type: PORTER, owner: -1, x: 60, y: 60, z: 0 });
  w.motion.vacate(p); w.putInside(p, post);
  w.combat.startOutpost(post);
  const job = post.opJob;
  w.logistics.leave(p);
  until(w, () => p.inside < 0, 60);
  assert.equal(post.opJob, job);
  steps(w, 60);
  assert.ok(w.sched.get(job) && !w.sched.get(job)!.cancelled, 'it runs on with nobody inside');
});

test('garrison: a collapse ejects everyone unhurt in entering order; the outpost job ends', {}, () => {
  const { w, post } = postWorld(LARGE);
  const us = [garrisoned(w, post), garrisoned(w, post, CROSSBOW), garrisoned(w, post)];
  const hp = us.map(u => u.hp);
  const job = post.opJob;
  w.combat.collapse(post, false);
  assert.ok(!w.sched.get(job) || w.sched.get(job)!.cancelled, 'the outpost job is cancelled with the building job');
  // ejected in occupant order (their leave jobs); the placement order then follows our LIFO wheel
  // (units-and-jobs.md 4.10 "Our build")
  const leaveIds = us.map(u => u.job);
  assert.ok(us.every(u => w.logistics.leaving(u)));
  assert.deepEqual([...leaveIds].sort((x, y) => x - y), leaveIds, 'ejected in entering order');
  assert.deepEqual(garrisonList(w, post).map(u => u.id), us.map(u => u.id), 'still drawn on the tower');
  until(w, () => us.every(u => u.inside < 0), 80);
  assert.deepEqual(us.map(u => u.hp), hp, 'unhurt');
  steps(w, 20);   // a unit placed first may have been pushed aside by the next one
  assert.ok(us.every(u => u.alive && u.job === 0), 'alive and idle outside');
});

// ---------------------------------------------------------------- lockstep

test('garrison: identical runs give identical hashes; a snapshot mid-fight restores to the same state', {}, () => {
  const play = () => {
    const { w, post, unit, entrance } = postWorld(LARGE);
    const as = [0, 1].map(k => unit(PIMMONS, ARCHER, entrance[0] + 3 + k, entrance[1] + 2));
    w.schedule({ type: 'order', player: PIMMONS, ids: as.map(a => a.id), target: post.id });
    for (let k = 0; k < 4; k++) unit(AMAZONS, PORTER, 60 + 3 * k, 75);
    unit(AMAZONS, FIGHTER, 75, 62);
    steps(w, 150);
    return w;
  };
  const a = play(), b = play();
  assert.equal(a.hash(), b.hash());
  const snap = JSON.parse(JSON.stringify(a.snapshot()));
  const c = World.restore(flatTerrain(7), snap, a.rules, a.weapons);
  assert.equal(c.hash(), a.hash(), 'restored: same hash');
  steps(a, 200); steps(c, 200);
  assert.equal(c.hash(), a.hash(), 'and the same afterwards');
});

// ---------------------------------------------------------------- map load (9.2)

const skip = !existsSync(`${DATA}/dv.odb`) && 'AN_DATA not set';

test('map load: +0xDC archers inside each outpost on its own cell, random facings, outpost job running', { skip }, () => {
  const { world: w } = loadMission('Pimmons.mdb', 5, DATA, false);
  const posts = w.entities.filter(e => e.kind === Kind.Building && (e.oid & 0xffff) === SMALL);
  assert.equal(posts.length, 2);
  const dirs: number[] = [];
  for (const p of posts) {
    const g = garrisonList(w, p);
    assert.equal(g.length, w.rules.get(p.oid)!.garrison);
    for (const u of g) {
      assert.equal(u.oid & 0xffff, ARCHER);
      assert.deepEqual(cell(u), cell(p), 'created on the outpost\'s own cell');
      assert.equal(u.town, p.town);
      dirs.push(u.dir);
    }
    assert.equal(w.sched.get(p.opJob)?.kind, CJ.Outpost);
  }
  assert.ok(dirs.every(d => d >= 0 && d < 8));
  steps(w, 300);
  for (const p of posts) assert.equal(w.logistics.occupants(p).length, 2, 'they stay');
});

// ---------------------------------------------------------------- display (objects.md 13, projectiles.md 2.6)

test('garrison draw positions: feet on canvas pixel (points[k].x, points[k].y + 22); launch 22 px above', {}, () => {
  const amazonSmall: [number, number][] = [[155, 87], [201, 88], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0]];
  // the table of objects.md 13.2: Amazon small, OD anchor (172, 207): slot 0 -17 / 98 up, slot 1 +29 / 97 up
  assert.deepEqual(garrisonFeet(amazonSmall, 0, 172, 207), [-17, -98]);
  assert.deepEqual(garrisonFeet(amazonSmall, 1, 172, 207), [29, -97]);
  // a slot without a stored point reads (0, 0): feet at canvas pixel (0, 22)
  assert.deepEqual(garrisonFeet(amazonSmall, 2, 172, 207), [-172, 22 - 207]);
  assert.deepEqual(garrisonPoint(amazonSmall, 9), [0, 0]);
  // Sajiki large (148, 214): slot 2 = (208, 72) -> +60, 120 up; Pimmon large (176, 205): slot 0 (216, 57) -> +40, 126 up
  assert.deepEqual(garrisonFeet([[176, 86], [147, 113], [208, 72]], 2, 148, 214), [60, -120]);
  assert.deepEqual(garrisonFeet([[216, 57]], 0, 176, 205), [40, -126]);
  // the launch offset (anchor - point) lacks the +22: 22 px above the drawn feet
  const [lx, ly] = garrisonLaunch(amazonSmall, 0, 172, 207), [fx, fy] = garrisonFeet(amazonSmall, 0, 172, 207);
  assert.equal(-lx, fx);
  assert.equal(-ly, fy - 22);
});

test('garrison list: only class-2 units of an outpost, in entering order, including one on its way out', {}, () => {
  const { w, post } = postWorld();
  const b = garrisoned(w, post), a = garrisoned(w, post);
  assert.ok(a.id > b.id);
  const order = garrisonList(w, post).map(u => u.id);
  assert.deepEqual(order, [b.id, a.id]);
  const p = w.spawn({ cls: 0, group: PIMMONS, type: PORTER, owner: -1, x: 60, y: 60, z: 0 });
  w.motion.vacate(p); w.putInside(p, post);
  assert.deepEqual(garrisonList(w, post).map(u => u.id), order, 'a porter is not part of the garrison');
  w.logistics.leave(b);
  assert.deepEqual(garrisonList(w, post).map(u => u.id), order, 'on its way out: keeps its slot');
});
