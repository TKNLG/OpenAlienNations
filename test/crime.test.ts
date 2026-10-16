// Criminals: never controllable, no vision, the criminal job's assault rhythm.
// Spec: docs/game/combat.md 12.1, 12.3, 12.6, 12.7; docs/game/economy.md 3.2, 5.5; docs/rendering/objects.md 8;
// docs/game/fog-of-war.md 3.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { loadMission, DATA, setupOf } from './helpers/mission.ts';
import { Kind, SUB, World } from '../src/engine/world.ts';
import { parseMdb } from '../src/formats/mission.ts';
import { parseOs } from '../src/formats/os.ts';
import { parseOdb } from '../src/formats/odb.ts';
import { generateTerrain, CLASS_TILESET } from '../src/world/terrain.ts';
import { generateWorld } from '../src/world/populate.ts';
import { applyFreePlay, spDefaults } from '../src/client/frontend/freeplay.ts';
import { Vision } from '../src/client/vision.ts';
import { commandableUnits, doubleClickUnit, sameTypeNear, Cat, alphaMask, compositeHit, targetUnderCursor, targetCategoryOf, TargetCat, type HitLayer } from '../src/client/picking.ts';

const skip = !existsSync(`${DATA}/dv.wdb`) && 'AN_DATA not set';
const CRIMINAL = 12, PORTER = 9, POLICE = 21, CJ_CRIMINAL = 0x17, CJ_ARREST = 0x18;

function setup() {
  const { world: w, mission: m } = loadMission('Pimmons.mdb', 0, DATA, false);
  const me = m.humanRace, t = w.economy.towns.find(x => x.race === me)!;
  return { w, me, t };
}

test('client: a criminal is inspect-only (no commands, double click selects nothing)', {}, () => {
  const P = 1, oid = (race: number, type: number) => ((race << 16) | type) >>> 0;
  const u = (id: number, race: number, type: number) => ({ id, kind: 0, owner: race, oid: oid(race, type) });
  const crim = u(1, P, CRIMINAL), porter = u(2, P, PORTER), porter2 = u(3, P, PORTER), foreign = u(4, 0, PORTER);
  assert.deepEqual(commandableUnits([crim], P), [], 'a selected own criminal cannot be commanded');
  assert.deepEqual(commandableUnits([porter, porter2], P).map(e => e.id), [2, 3]);
  // the frontmost unit decides a double click, whatever its owner, even behind a building
  assert.deepEqual(doubleClickUnit([{ id: 9, cat: Cat.OwnBuilding }, { id: 1, cat: Cat.OtherUnit }, { id: 2, cat: Cat.OwnUnit }]), { id: 1, cat: Cat.OtherUnit });
  assert.equal(doubleClickUnit([{ id: 9, cat: Cat.OwnBuilding }]), null);
  const near = [crim, porter, porter2, foreign].map((e, k) => ({ e, d: k }));
  assert.deepEqual(sameTypeNear(crim, near, P), { cat: -1, ids: [] }, 'double click on a criminal: empty');
  assert.deepEqual(sameTypeNear(porter, near, P), { cat: Cat.OwnUnit, ids: [2, 3] });
  // quirk: the race is not compared, a foreign porter's double click selects the own porters around it
  assert.deepEqual(sameTypeNear(foreign, near, P), { cat: Cat.OwnUnit, ids: [2, 3] });
  assert.deepEqual(sameTypeNear(porter, [{ e: porter, d: 0 }, { e: porter2, d: 6 }], P).ids, [2], 'radius 5');
});

test('engine: move, order and unit commands never reach a criminal; police may still be sent', { skip }, () => {
  const { w, me, t } = setup();
  const spot = w.freeSpiral(t.x + 6, t.y + 6, 10)!;
  const crim = w.spawnUnit(me, CRIMINAL, spot[0], spot[1], t.id);
  const porter = w.spawnUnit(me, PORTER, spot[0] + 2, spot[1], t.id);
  w.economy.joinTown(crim, t); w.economy.joinTown(porter, t);
  const job = crim.job;
  assert.equal(w.sched.get(job)?.kind, CJ_CRIMINAL);
  // a peer sends a move for the criminal and a porter: the porter walks, the criminal keeps its job
  w.schedule({ type: 'move', player: me, ids: [crim.id, porter.id], x: spot[0] + 12, y: spot[1] + 4 });
  w.schedule({ type: 'unit', player: me, ids: [crim.id], action: 'home' });
  w.step(); w.step();
  assert.equal(crim.job, job, 'the criminal job survives a move and a go-home');
  assert.equal(w.sched.get(crim.job)?.kind, CJ_CRIMINAL);
  assert.ok(!crim.ordered, 'not on a player order');
  assert.ok(porter.ordered && porter.path, 'the porter got its move');
  // an order naming a criminal is refused as a whole
  const p2 = w.spawnUnit(me, PORTER, spot[0], spot[1] + 2, t.id);
  w.economy.joinTown(p2, t);
  w.schedule({ type: 'order', player: me, ids: [crim.id, p2.id], target: porter.id });
  w.step(); w.step();
  assert.equal(crim.job, job);
  assert.ok(!p2.ordered, 'the order was refused');
  // the only interaction: an officer ordered onto the criminal gets an arrest job
  const officer = w.spawnUnit(me, POLICE, spot[0] + 3, spot[1] + 3, t.id);
  w.economy.joinTown(officer, t);
  w.schedule({ type: 'order', player: me, ids: [officer.id], target: crim.id });
  w.step(); w.step();
  assert.equal(w.sched.get(officer.job)?.kind, CJ_ARREST);
});

test('fog: a criminal reveals nothing, a porter on the same cell does', { skip }, () => {
  const { w, me, t } = setup();
  const x = (t.x + (w.size >> 1)) & (w.size - 1), y = (t.y + (w.size >> 1)) & (w.size - 1);
  const crim = w.spawnUnit(me, CRIMINAL, x, y, t.id);
  const cx = Math.floor(crim.x / SUB), cy = Math.floor(crim.y / SUB);
  const v = new Vision(w.size, w.bits);
  v.update(w, me, true);
  let lit = 0;
  for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) if (v.cellVisible(cx + dx, cy + dy) || v.explored[(((cy + dy) & (w.size - 1)) << w.bits) | ((cx + dx) & (w.size - 1))]) lit++;
  assert.equal(lit, 0, 'no cell around the criminal is visible or explored');
  crim.alive = false;
  const porter = w.spawnUnit(me, PORTER, x, y, t.id);
  v.update(w, me, true);
  assert.ok(v.cellVisible(Math.floor(porter.x / SUB), Math.floor(porter.y / SUB)), 'a porter sees its cell');
});

test('criminal job: random own porters, stop at 10 HP lost, then a 50-tick pause', { skip }, () => {
  const { w, me, t } = setup();
  const spot = w.freeSpiral(t.x + 6, t.y + 6, 10)!;
  const crim = w.spawnUnit(me, CRIMINAL, spot[0], spot[1], t.id);
  w.economy.joinTown(crim, t);
  let last = 0, endedAt = -1, assaults = 0, hp0 = 0, victim = -1, maxLoss = 0;
  const N = 6000;
  for (let i = 0; i < N; i++) {
    w.step();
    const j = w.sched.get(crim.job)!;
    assert.equal(j.kind, CJ_CRIMINAL, 'the criminal job is never replaced (no flee here: nobody hits it)');
    const active = j.data[0];
    if (active && !last) {
      assaults++;
      victim = j.data[2]; hp0 = j.data[1];
      const v = w.get(victim);
      assert.ok(v && v.kind === Kind.Unit && v.town === t.id && (v.oid & 0xffff) === PORTER, 'only porters of its own town');
      if (endedAt >= 0) assert.ok(w.tick - endedAt >= 50, `50-tick pause (${w.tick - endedAt})`);
    }
    if (!active && last) {
      endedAt = w.tick;
      const v = w.get(victim);
      if (v) maxLoss = Math.max(maxLoss, hp0 - v.hp);
    }
    last = active;
  }
  assert.ok(assaults >= 10, `assaults ${assaults}`);
  // the stop comes at a loss of 10 or more; at most one strike already under way may land after it
  assert.ok(maxLoss <= 9 + 5 + 5, `loss per assault ${maxLoss}`);
  // never more often than one assault per 50 + 1 ticks, and in practice far fewer (12.7)
  assert.ok(assaults <= N / 51, `assaults ${assaults}`);
});

test('client: the right-click target is the criminal under the cursor, also with several criminals', {}, () => {
  const P = 1, oid = (type: number) => ((P << 16) | type) >>> 0;
  const box = (id: number, type: number, X0: number) => ({ id, kind: 0, owner: P, alive: true, oid: oid(type), X0, Y0: 100 });
  // three units drawn back to front: criminal A at x 100, criminal B at x 110 (overlapping A's right
  // half), the selected officer at x 120 in front of B's right part
  const drawn = [box(1, CRIMINAL, 100), box(2, CRIMINAL, 110), box(3, POLICE, 120)];
  const sq = alphaMask(new Uint8Array(16 * 16 * 4).fill(255), 16, 16);
  const layers: HitLayer[] = [{ mask: sq, w: 16, h: 16, ox: -8, oy: -16 }];
  const at = (x: number, sel: number[] = [3]) => targetUnderCursor(drawn,
    d => ({ id: d.id, kind: d.kind, owner: d.owner, alive: d.alive, cls: -1 }),
    d => compositeHit(layers, d.X0, d.Y0, 1, x - 2, 92, x + 2, 96), P, new Set(sel));
  assert.equal(at(94), 1, 'only A under the cursor');
  assert.equal(at(108), 2, 'A and B overlap: the frontmost, B');
  assert.equal(at(116), 2, 'the selected officer in front of B is no candidate');
  assert.equal(at(116, []), 3, 'an unselected own unit in front is (same category, frontmost)');
  assert.equal(at(140), -1, 'nothing: a move');
  assert.equal(targetCategoryOf({ kind: 0, owner: P }, -1, P), TargetCat.OwnUnit, 'an own criminal is an own-unit target');
});

test('engine: a manual police order ignores the clicked criminal; repeated orders cycle, criminals are beaten to death (combat.md 12.3)', { skip }, () => {
  const { w, me, t } = setup();
  assert.deepEqual(w.combat.criminalList(t), [], 'no criminals at the start');
  const spot = w.freeSpiral(t.x + 8, t.y + 8, 10)!;
  const a = w.spawnUnit(me, CRIMINAL, spot[0], spot[1], t.id);
  const b = w.spawnUnit(me, CRIMINAL, spot[0] + 3, spot[1] + 1, t.id);
  const officer = w.spawnUnit(me, POLICE, spot[0] + 1, spot[1] + 4, t.id);
  for (const u of [a, b, officer]) w.economy.joinTown(u, t);
  assert.deepEqual(w.combat.criminalList(t), [a.id, b.id], 'joined in creation order');
  const chased = () => {
    const j = w.sched.get(officer.job);
    assert.equal(j?.kind, CJ_ARREST);
    return j!.data[1] === 1 ? j!.data[2] : 0;
  };
  const order = (target: number) => {
    w.schedule({ type: 'order', player: me, ids: [officer.id], target });
    for (let i = 0; i < 3; i++) w.step();
    return chased();
  };
  // the job does not know the clicked criminal: it takes the list's first and moves it to the end
  assert.equal(order(b.id), a.id, 'first order onto B: the list head A is chased');
  assert.deepEqual(t.criminals, [b.id, a.id]);
  assert.equal(order(b.id), b.id, 'ordering again (onto B) switches to B');
  assert.deepEqual(t.criminals, [a.id, b.id]);
  assert.equal(order(b.id), a.id, 'and again cycles back to A');
  assert.equal(order(a.id), b.id, 'the clicked criminal does not matter');
  assert.ok(officer.ordered, 'a player order');
  // no station: no arrest, the officer beats B to death and then takes A
  a.hp = 2; b.hp = 2;
  let n = 0;
  while (b.alive && n++ < 3000) w.step();
  assert.ok(!b.alive, 'B was beaten to death, not arrested');
  for (let i = 0; i < 3; i++) w.step();
  if (a.alive) assert.equal(chased(), a.id, 'then A, without a new order');
  n = 0;
  while (a.alive && n++ < 3000) w.step();
  assert.ok(!a.alive, 'A dead too');
  for (let i = 0; i < 3; i++) w.step();
  assert.ok(w.sched.get(officer.job)?.kind !== CJ_ARREST, 'no criminal left and no station: the job ends');
  assert.deepEqual(w.combat.criminalList(t), []);
});

test('engine: an officer whose chase failed takes up his last criminal again when no free criminal is listed (combat.md 12.3)', { skip }, () => {
  const { w, me, t } = setup();
  const spot = w.freeSpiral(t.x + 8, t.y + 8, 10)!;
  const a = w.spawnUnit(me, CRIMINAL, spot[0], spot[1], t.id);
  const officer = w.spawnUnit(me, POLICE, spot[0] + 2, spot[1] + 2, t.id);
  for (const u of [a, officer]) w.economy.joinTown(u, t);
  w.schedule({ type: 'order', player: me, ids: [officer.id], target: a.id });
  for (let i = 0; i < 3; i++) w.step();
  const job = () => w.sched.get(officer.job)!;
  assert.equal(job().kind, CJ_ARREST);
  assert.equal(job().data[1], 1, 'chasing A');
  // A is put beyond the 29-cell leash: the chase fails, A is alive, the job keeps it
  const far = w.freeSpiral(a.x / SUB + 40, a.y / SUB, 10)!;
  w.teleport(a, far[0], far[1]);
  for (let i = 0; i < 6 && job().data[1] === 1; i++) w.step();
  assert.equal(job().data[1], 0, 'the chase ended');
  assert.equal(job().data[2], a.id, 'its criminal is kept (cleared only on death or arrest)');
  // A now walks to a jail (escort job): the list holds no free criminal, the officer takes A again
  a.job = w.sched.create(0x19, a.id, 50, [0, 0]).id;
  for (let i = 0; i < 3 && job().data[1] !== 1; i++) w.step();
  assert.equal(job().kind, CJ_ARREST, 'the job did not end');
  assert.equal(job().data[1], 1);
  assert.equal(job().data[2], a.id, 'chasing A again');
});

/**
 * A free-play start (Infinite.mdb record 1, race 1 human, town hall standing) grown by small houses
 * ordered two at a time, with building material kept in stock. `food`: kept at 20 (fed), or taken
 * away at the start (hungry). Returns every birth of the town with the population before it, the
 * stored happiness and the newborn's type.
 */
function growTown(food: 'fed' | 'hungry', untilPop: number, maxTicks: number) {
  const base = parseMdb(readFileSync(`${DATA}/Infinite.mdb`))[1];
  const m = applyFreePlay(base, spDefaults(), 777);
  const pick = CLASS_TILESET.map(name => parseOs(readFileSync(`${DATA}/${name}.os`)).pick);
  const gen = generateWorld(777, m.sizeBits, (s, b) => generateTerrain(s, b, pick), {
    resources: 2, players: [{ race: 0, computer: true }, { race: 1, computer: false }, { race: 2, computer: true }], humanTownHall: true,
  });
  const w = new World(gen.terrain, gen.result.objects, parseOdb(readFileSync(`${DATA}/dv.odb`)), { ...setupOf(m), orders: [], ai: false });
  const me = 1, eco = w.economy, t = eco.towns.find(x => x.race === me && x.alive)!;
  if (food === 'hungry') t.stock[4] = 0;
  const births: { P: number; h: number; food: number; crim: boolean }[] = [];
  const birth = eco.birth.bind(eco);
  eco.birth = (b, type, rolled) => {
    const P = t.population, h = t.happiness, f = t.foodPct;
    const u = birth(b, type, rolled);
    if (u && u.town === t.id) births.push({ P, h, food: f, crim: (u.oid & 0xffff) === CRIMINAL });
    return u;
  };
  const house = w.rules.get((me << 16) | 37)!;
  let ordered = 0;
  for (let i = 0; i < maxTicks && t.population < untilPop; i++) {
    if (i % 50 === 0) {
      t.stock[1] = Math.max(t.stock[1], 20); t.stock[2] = Math.max(t.stock[2], 20);
      if (food === 'fed') t.stock[4] = Math.max(t.stock[4], 20);
      const sites = w.entities.filter(e => e.kind === Kind.Building && e.town === t.id && (e.oid & 0xffff) === 37 && !e.complete).length;
      if (ordered < 14 && sites < 2) {
        let done = false;
        for (let r = 3; r < 25 && !done; r++) for (let dy = -r; dy <= r && !done; dy++) for (let dx = -r; dx <= r && !done; dx++)
          if (Math.max(Math.abs(dx), Math.abs(dy)) === r && w.logistics.canPlace(t, house, t.x + dx, t.y + dy)) {
            w.schedule({ type: 'build', player: me, town: t.id, building: 37, x: t.x + dx, y: t.y + dy });
            ordered++; done = true;
          }
      }
    }
    w.step();
  }
  return { births, t };
}

test('sim: early criminals follow the birth rule only: a fed town\'s first is its 19th resident, a starving town\'s its 10th (economy.md 3.2)', { skip }, () => {
  const fed = growTown('fed', 21, 9000);
  assert.ok(fed.t.population >= 21, `the fed town grew (${fed.t.population})`);
  // every birth: criminal exactly when the population before it is a multiple of 9 (h < 90) or 18
  for (const b of [...fed.births]) assert.equal(b.crim, b.P % (b.h < 90 ? 9 : 18) === 0, `P ${b.P}, h ${b.h}`);
  const at9 = fed.births.find(b => b.P === 9)!;
  assert.ok(at9 && !at9.crim && at9.h === 100, 'fed, no open need, no criminal: h 100 at the 10th birth, a porter');
  assert.deepEqual(fed.births.filter(b => b.crim).map(b => b.P), [18], 'one criminal up to 21 residents: the 19th');

  const hungry = growTown('hungry', 12, 15000);
  assert.ok(hungry.t.population >= 12, `the hungry town grew (${hungry.t.population})`);
  for (const b of hungry.births) assert.equal(b.crim, b.P % (b.h < 90 ? 9 : 18) === 0, `P ${b.P}, h ${b.h}`);
  const h9 = hungry.births.find(b => b.P === 9)!;
  assert.ok(h9.crim && h9.food === 0 && h9.h < 90, `no food in stock: h ${h9.h} at the 10th birth, a criminal`);
  assert.deepEqual(hungry.births.filter(b => b.crim).map(b => b.P), [9], 'and only that one up to 12 residents');
});
