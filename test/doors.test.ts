// Entering, leaving and births through the door; collapse with occupants; draw order.
// Spec: docs/game/units-and-jobs.md 4.4, 4.10, 11.3-11.4; docs/game/combat.md 10.3.1;
// docs/rendering/objects.md 4.1, 12; docs/rendering/unit-motion.md 7. The first tests need no game data.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { World, SUB, Kind, SNAPSHOT_VERSION, type Entity } from '../src/engine/world.ts';
import { MJ } from '../src/engine/motion.ts';
import { NJ } from '../src/engine/naval.ts';
import type { ObjectRule } from '../src/formats/odb.ts';
import type { Terrain } from '../src/world/terrain.ts';
import { drawOrder, DrawKind, type DrawItem } from '../src/client/draw-order.ts';
import { parseMdb } from '../src/formats/mission.ts';
import { parseOs } from '../src/formats/os.ts';
import { parseOdb } from '../src/formats/odb.ts';
import { generateTerrain, CLASS_TILESET } from '../src/world/terrain.ts';
import { generateWorld } from '../src/world/populate.ts';
import { DATA, setupOf } from './helpers/mission.ts';

// ---------------------------------------------------------------- a small synthetic world

const PORTER = 9, HOUSE = 50, LAB = 51;
function rules(): Map<number, ObjectRule> {
  const m = new Map<number, ObjectRule>();
  const base = { group: 0, name: '', sound: 0, soundFrame: 0, soundAction: 0, radius: 5, residents: 0, flags: 0, money: 0,
    garrison: 0, invention: -1, madeAt: -1, cost: [0, 0, 5, 0, 0, 0, 0, 0, 0], product: -1, amount: 0, slot: 0, needPop: 0,
    message: 0, weapon: -1, impact: 0, points: [] };
  m.set(PORTER, { ...base, id: PORTER, kind: 0, type: PORTER, sizeX: 1, sizeY: 1, doorDx: 0, doorDy: 0, hp: 50, cls: 0,
    stepTime: [5, 6, 7, 8], operator: -1 } as ObjectRule);
  // a 2x2 building with door (-1, +1) (entrance in front of the +y face) and one with (+1, -1)
  m.set(HOUSE, { ...base, id: HOUSE, kind: 1, type: HOUSE, sizeX: 2, sizeY: 2, doorDx: -1, doorDy: 1, hp: 100, cls: 0,
    stepTime: [0, 0, 0, 0], operator: -1 } as ObjectRule);
  m.set(LAB, { ...base, id: LAB, kind: 1, type: LAB, sizeX: 2, sizeY: 2, doorDx: 1, doorDy: -1, hp: 100, cls: 0,
    stepTime: [0, 0, 0, 0], operator: -1 } as ObjectRule);
  return m;
}
function flatTerrain(bits: number): Terrain {
  const n = 1 << bits;
  return { sizeBits: bits, size: n, height: new Uint16Array(n * n).fill(128), cls: new Uint8Array(n * n), tile: new Uint8Array(n * n) };
}
const cell = (e: Entity): [number, number] => [Math.floor(e.x / SUB), Math.floor(e.y / SUB)];
const jobKind = (w: World, e: Entity) => (e.job ? w.sched.get(e.job)?.kind ?? -1 : 0);

/** a world with one completed building at (20, 20) (footprint 19..20 x 19..20) */
function doorWorld(type = HOUSE) {
  const w = new World(flatTerrain(6), [], rules());
  const b = w.spawn({ cls: 1, group: 0, type, owner: -1, x: 20, y: 20, z: 0 });
  b.complete = true;
  const porter = (x: number, y: number) => w.spawn({ cls: 0, group: 0, type: PORTER, owner: -1, x, y, z: 0 });
  return { w, b, porter, entrance: w.logistics.entrance(b) };
}
/** step until the building's door opened; returns that tick */
function untilOpen(w: World, b: Entity): number {
  for (let i = 0; i < 40 && b.door === 0; i++) w.step();
  assert.ok(b.door > 0, 'the door opened');
  return w.tick;
}
const steps = (w: World, n: number) => { for (let i = 0; i < n; i++) w.step(); };

// ---------------------------------------------------------------- the leave job

test('leave: the door opens 10 ticks after the eject, the unit is put on the entrance 10 ticks later facing 3', {}, () => {
  const { w, b, entrance } = doorWorld();
  const t0 = w.tick;
  const u = w.spawnInside(0, PORTER, b, -1);
  assert.equal(u.inside, b.id, 'born inside, not on the map');
  assert.equal(jobKind(w, u), 0x0d, 'ejected at once: leave job');
  const T = untilOpen(w, b);
  assert.ok(T - t0 === 10 || T - t0 === 11, `door opens 10 ticks after the eject (${T - t0})`);
  assert.equal(b.doorOpen, T);
  steps(w, 9);
  assert.equal(u.inside, b.id, 'still inside while the door is open');
  w.step();
  assert.equal(w.tick, T + 10);
  assert.equal(u.inside, -1);
  assert.deepEqual(cell(u), entrance, 'on the entrance cell');
  assert.equal(u.dir, 3, 'door x offset < 0: facing 3');
  assert.equal(b.door, 0);
  assert.equal(b.doorShut, T + 10, 'placing closes the door');
  assert.equal(u.job, 0, 'no job afterwards');
  assert.equal(u.stepTicks, 0, 'put down at once, no interpolation');
});

test('leave: door (+1, -1) gives facing 5', {}, () => {
  const { w, b, entrance } = doorWorld(LAB);
  const u = w.spawnInside(0, PORTER, b, -1);
  const T = untilOpen(w, b);
  steps(w, 10);
  assert.equal(w.tick, T + 10);
  assert.deepEqual(cell(u), entrance);
  assert.equal(u.dir, 5);
});

test('leave: an idle unit on the entrance is pushed without chaining; the leaving unit comes out 5 ticks later', {}, () => {
  const { w, b, porter, entrance: [ex, ey] } = doorWorld();
  const p = porter(ex, ey);              // idle on the entrance (19, 21)
  const a = porter(ex - 1, ey);          // idle on the first two step-aside candidates
  const c = porter(ex - 1, ey - 1);
  const u = w.spawnInside(0, PORTER, b, -1);
  const T = untilOpen(w, b);
  steps(w, 10);                          // run 2: the entrance is taken by an idle unit
  assert.equal(u.inside, b.id, 'not put on a taken cell');
  assert.equal(jobKind(w, p), MJ.StepAside, 'the idle unit is pushed');
  assert.equal(w.sched.get(p.job)!.data[0], -1, 'no requester (mask 0x3E)');
  steps(w, 4);
  // candidates (x-1,y) and (x-1,y-1) hold units, (x,y-1) and (x+1,y-1) are the footprint: (x+1, y)
  assert.deepEqual(cell(p), [ex + 1, ey], 'pushed to the first empty neighbour');
  assert.equal(a.job, 0); assert.equal(c.job, 0);
  assert.deepEqual(cell(a), [ex - 1, ey]); assert.deepEqual(cell(c), [ex - 1, ey - 1]);
  assert.equal(u.inside, b.id);
  w.step();
  assert.equal(w.tick, T + 15, 'second test 5 ticks later');
  assert.equal(u.inside, -1);
  assert.deepEqual(cell(u), [ex, ey]);
});

test('leave: a pushed unit with no free neighbour stays; at the 5th run the unit takes the nearest free spiral cell', {}, () => {
  const { w, b, porter, entrance: [ex, ey] } = doorWorld();
  const p = porter(ex, ey);
  const ring = [[-1, 0], [-1, -1], [1, 0], [1, 1], [0, 1], [-1, 1]].map(([dx, dy]) => porter(ex + dx, ey + dy));
  const u = w.spawnInside(0, PORTER, b, -1);
  const T = untilOpen(w, b);
  const before = ring.map(cell);
  for (const k of [10, 15, 20]) {
    steps(w, w.tick < T + k ? T + k - w.tick : 0);
    assert.equal(u.inside, b.id, `still inside at +${k}`);
  }
  steps(w, 4);
  assert.deepEqual(cell(p), [ex, ey], 'no free neighbour: the pushed unit stays');
  ring.forEach((v, k) => { assert.deepEqual(cell(v), before[k], 'nobody else moves (no chain)'); assert.equal(v.job, 0); });
  const expect = w.freeSpiral(ex, ey, 24, u)!;
  w.step();
  assert.equal(w.tick, T + 25, 'run 5: 35 ticks after the eject');
  assert.equal(u.inside, -1);
  assert.deepEqual(cell(u), expect, 'first free cell of the square spiral (mask 0x3E)');
  assert.equal(Math.max(Math.abs(expect[0] - ex), Math.abs(expect[1] - ey)), 2, 'ring 1 is full: ring 2');
  for (const v of [p, ...ring]) assert.ok(cell(v).join() !== cell(u).join(), 'never on a taken cell');
});

test('leave: a busy unit on the entrance is waited for, not pushed', {}, () => {
  const { w, b, porter, entrance: [ex, ey] } = doorWorld();
  const v = porter(ex, ey);
  v.job = w.sched.create(NJ.Wait, v.id, 1).id;   // busy (waiting for a ship)
  const job = v.job;
  const u = w.spawnInside(0, PORTER, b, -1);
  const T = untilOpen(w, b);
  steps(w, 24);
  assert.equal(u.inside, b.id);
  assert.equal(v.job, job, 'not pushed');
  w.step();
  assert.equal(w.tick, T + 25);
  assert.equal(u.inside, -1);
  assert.ok(cell(u).join() !== [ex, ey].join(), 'not on the busy unit\'s cell');
  assert.deepEqual(cell(v), [ex, ey]);
});

test('leave: units ejected together come out one after another on separate cells', {}, () => {
  const { w, b, entrance: [ex, ey] } = doorWorld();
  const us = [0, 1, 2].map(() => w.spawnInside(0, PORTER, b, -1));
  const T = untilOpen(w, b);
  assert.equal(b.door, 3, 'the counter counts all three, the door opened once');
  const out: number[] = [];
  for (let i = 0; i < 30; i++) {
    w.step();
    for (const [k, u] of us.entries()) if (u.inside < 0 && out[k] === undefined) out[k] = w.tick - T;
  }
  assert.deepEqual([...out].sort((a, b) => a - b), [10, 15, 20], 'about 5 ticks apart');
  const cells = new Set(us.map(u => cell(u).join(',')));
  assert.equal(cells.size, 3, 'each on its own cell');
  assert.ok(us.some(u => cell(u)[0] === ex && cell(u)[1] === ey));
  assert.equal(b.door, 0);
});

// ---------------------------------------------------------------- collapse with occupants (combat.md 10.3.1)

test('collapse: Sfx_053 effect at phase 1; the frames wait until every occupant is out', {}, () => {
  const { w, b, entrance } = doorWorld();
  const occ = [0, 1].map(() => {
    const u = w.spawn({ cls: 0, group: 0, type: PORTER, owner: -1, x: entrance[0], y: entrance[1], z: 0 });
    w.motion.vacate(u); u.inside = b.id;
    return u;
  });
  w.effects.length = 0;
  w.combat.collapse(b, false);
  const fx = w.effects.filter(e => e.kind === 'collapse');
  assert.equal(fx.length, 1, 'one collapse event');
  assert.deepEqual([fx[0].x, fx[0].y, fx[0].type], [20, 20, 53]);
  assert.equal(b.collapseStage, 9);
  let lastOut = -1, gone = -1;
  for (let i = 0; i < 80 && gone < 0; i++) {
    w.step();
    if (occ.every(u => u.inside < 0) && lastOut < 0) lastOut = w.tick;
    if (occ.some(u => u.inside >= 0)) assert.equal(b.collapseStage, 9, 'frames wait for the occupants');
    if (!w.get(b.id)) gone = w.tick;
  }
  assert.ok(lastOut > 0 && gone > lastOut, 'the building goes after its occupants are out');
  assert.ok(gone - lastOut <= 20, `then frames 8..0 and gone (${gone - lastOut} ticks)`);
  assert.equal(new Set(occ.map(u => cell(u).join(','))).size, 2, 'occupants on separate cells');
  assert.equal(w.effects.filter(e => e.kind === 'collapse').length, 1, 'no second sound');
});

// ---------------------------------------------------------------- draw order (objects.md 12)

test('draw order: rows far to near, left to right; no height or id in the key', {}, () => {
  const items: DrawItem[] = [
    { kind: DrawKind.Unit, x: 5, y: 5 },     // row 10
    { kind: DrawKind.Unit, x: 3, y: 4 },     // row 7, col 1
    { kind: DrawKind.Nature, x: 4, y: 3 },   // row 7, col -1
    { kind: DrawKind.Effect, x: 4, y: 3 },   // after the object on its cell
    { kind: DrawKind.Unit, x: 0, y: 2 },     // row 2
  ];
  assert.deepEqual(drawOrder(items), [4, 2, 3, 1, 0]);
});

test('draw order: units in front of a building face are drawn after the building', {}, () => {
  // building anchor (10, 10), 3x2 footprint 8..10 x 9..10 (Pimmon town hall), door (-1, +1)
  const hall: DrawItem = { kind: DrawKind.Building, x: 10, y: 10, sx: 3, sy: 2 };
  const founder: DrawItem = { kind: DrawKind.Unit, x: 9, y: 11 };     // the entrance: same row as the corner, right after it
  const plusX: DrawItem = { kind: DrawKind.Unit, x: 11, y: 9 };       // in front of the +x face (row 20, before the corner)
  const plusY: DrawItem = { kind: DrawKind.Unit, x: 8, y: 11 };       // in front of the +y face (row 19): deferred
  const behind: DrawItem = { kind: DrawKind.Unit, x: 7, y: 9 };       // beside a back face: before
  const near: DrawItem = { kind: DrawKind.Unit, x: 11, y: 11 };       // in front of the corner: after (base order)
  const items = [founder, plusX, plusY, behind, near, hall];
  const order = drawOrder(items);
  const pos = (i: number) => order.indexOf(i);
  assert.ok(pos(0) > pos(5), 'the founder at the door is drawn over the hall');
  assert.ok(pos(1) > pos(5), '+x face: deferred after the hall');
  assert.ok(pos(2) > pos(5), '+y face: deferred after the hall');
  assert.ok(pos(3) < pos(5), 'behind: before the hall');
  assert.ok(pos(4) > pos(5));
  // deferred objects follow the building at once, in base order
  assert.deepEqual(order.slice(pos(5), pos(5) + 3), [5, 2, 1]);
  // without the exception the +y unit (row 19) would come before the hall (row 20)
  assert.ok(drawOrder([plusY, hall]).indexOf(0) === 1);
  // an effect on a face cell is never deferred
  assert.deepEqual(drawOrder([{ kind: DrawKind.Effect, x: 8, y: 11 }, hall]), [0, 1]);
});

test('draw order: an object touching two buildings goes with the later one; equal rows: the one at (x, y - 1)', {}, () => {
  const a: DrawItem = { kind: DrawKind.Building, x: 4, y: 6, sx: 2, sy: 2 };   // footprint 3..4 x 5..6
  const b: DrawItem = { kind: DrawKind.Building, x: 6, y: 5, sx: 2, sy: 3 };   // footprint 5..6 x 3..5
  const u: DrawItem = { kind: DrawKind.Unit, x: 5, y: 6 };                     // up-right (4,6)? corner of a; up-left (5,5): b's
  // (4, 6) is a's anchor (does not count), (5, 5) is a non-corner cell of b
  let order = drawOrder([a, b, u]);
  assert.equal(order[order.indexOf(1) + 1], 2, 'deferred after b');
  const c: DrawItem = { kind: DrawKind.Building, x: 4, y: 8, sx: 2, sy: 3 };   // footprint 3..4 x 6..8: (4, 7) counts for (5, 7)
  const d: DrawItem = { kind: DrawKind.Building, x: 7, y: 6, sx: 3, sy: 1 };   // footprint 5..7 x 6: (5, 6) counts for (5, 7)
  const v: DrawItem = { kind: DrawKind.Unit, x: 5, y: 7 };
  order = drawOrder([c, d, v]);
  // anchors: c row 12, d row 13 -> the later one, d
  assert.equal(order[order.indexOf(1) + 1], 2);
});

// ---------------------------------------------------------------- founding: entering and births (real data)

const skip = !DATA;

function freePlay(seed: number) {
  const m = parseMdb(readFileSync(`${DATA}/Infinite.mdb`))[1];   // Pimmons human
  const pick = CLASS_TILESET.map(name => parseOs(readFileSync(`${DATA}/${name}.os`)).pick);
  const races = m.races.map(r => ({ ...r, startGoods: r.startGoods.map((g, i) => (i <= 5 ? [20, g[1]] : g) as [number, number]) }));
  const gen = generateWorld(seed, 8, (s, b) => generateTerrain(s, b, pick), {
    resources: 1, players: races.filter(r => r.present).map(r => ({ race: r.race, computer: r.computer })),
  });
  const rls = parseOdb(readFileSync(`${DATA}/dv.odb`));
  const w = new World(gen.terrain, gen.result.objects, rls, { ...setupOf(m), races, orders: [], lists: gen.result.lists });
  return { w, human: m.humanRace };
}
function startFounding(seed: number) {
  const { w, human } = freePlay(seed);
  const f = w.entities.find(e => e.kind === Kind.Unit && (e.oid >>> 16) === human && (e.oid & 0xffff) === 10)!;
  const [ux, uy] = cell(f);
  let site: [number, number] | null = null;
  for (let r = 3; r < 30 && !site; r++) for (let dy = -r; dy <= r && !site; dy++) for (let dx = -r; dx <= r && !site; dx++) {
    if (Math.max(Math.abs(dx), Math.abs(dy)) === r && w.logistics.canFound(human, ux + dx, uy + dy, true)) site = [ux + dx, uy + dy];
  }
  w.schedule({ type: 'found', player: human, unit: f.id, x: site![0], y: site![1] }, w.tick + 1);
  return { w, human, f };
}

test('founding: the founder turns at the door, is admitted with the door opening and vanishes 5 ticks later', { skip }, () => {
  const { w, human, f } = startFounding(99);
  let hall: Entity | undefined, A = -1, admitted = -1, entered = -1, dirAtAdmission = -1;
  let entrance: [number, number] = [0, 0];
  for (let i = 0; i < 600 && entered < 0; i++) {
    w.step();
    hall ??= w.entities.find(e => e.kind === Kind.Building && (e.oid >>> 16) === human && (e.oid & 0xffff) === 40);
    if (!hall) continue;
    entrance = w.logistics.entrance(hall);
    if (A < 0 && hall.complete) A = w.tick;
    if (admitted < 0 && hall.door > 0) { admitted = w.tick; dirAtAdmission = f.dir; assert.equal(f.inside, -1, 'still outside, door opening'); }
    if (entered < 0 && f.inside === hall.id) entered = w.tick;
    if (A >= 0 && f.inside < 0) assert.deepEqual(cell(f), entrance, 'he never leaves the entrance cell');
  }
  assert.ok(A > 0 && admitted > 0 && entered > 0);
  const T = admitted - A - 24;
  assert.ok(T >= 0 && T <= 3, `admitted at A + 24 + T with T = 0..3 turn ticks (${admitted - A})`);
  assert.equal(entered - admitted, 5, 'vanishes 5 ticks after the door opened');
  assert.equal(dirAtAdmission, 6, 'door (-1, +1): turned toward the anchor, facing 6');
  assert.equal(hall!.doorOpen, admitted);
});

test('founding: builder and two porters are born inside and come out one after another on distinct cells', { skip }, () => {
  const { w, human, f } = startFounding(99);
  let hall: Entity | undefined, E = -1;
  const outAt = new Map<number, number>();
  let births: Entity[] = [];
  for (let i = 0; i < 700; i++) {
    w.step();
    hall ??= w.entities.find(e => e.kind === Kind.Building && (e.oid >>> 16) === human && (e.oid & 0xffff) === 40);
    if (hall && E < 0 && f.inside === hall.id) {
      E = w.tick;
      births = w.entities.filter(e => e.kind === Kind.Unit && e.home === hall!.id);
      assert.deepEqual(births.map(u => u.oid & 0xffff), [11, 9, 9], 'builder, porter, porter');
      for (const u of births) assert.equal(u.inside, hall.id, 'born inside, not drawn');
    }
    for (const u of births) if (u.inside < 0 && !outAt.has(u.id)) { outAt.set(u.id, w.tick - E); assert.deepEqual(cell(u), w.logistics.entrance(hall!), 'put on the entrance'); }
    if (E > 0 && w.tick === E + 10) assert.equal(hall!.doorOpen, E + 10, 'the door opens 10 ticks after the founder vanished');
    if (outAt.size === 3 && w.tick > E + 31) break;
  }
  assert.equal(outAt.get(births[0].id), 20, 'the builder (first birth) comes out first, 20 ticks after the entry');
  assert.deepEqual([...outAt.values()].sort((a, b) => a - b), [20, 25, 30], 'E+20, E+25, E+30');
  const cells = births.map(u => cell(u).join(','));
  assert.equal(new Set(cells).size, 3, 'three distinct cells');
  const t = w.economy.towns.find(x => x.race === human && x.alive)!;
  assert.equal(t.population, 4);
});

test('doors: snapshot round trip while units are on their way out; determinism', { skip }, () => {
  const run = () => startFounding(99);
  const a = run(), b = run();
  let snapAt = -1;
  for (let i = 0; i < 400; i++) {
    a.w.step(); b.w.step();
    if (snapAt < 0 && a.w.entities.some(e => e.kind === Kind.Unit && a.w.logistics.leaving(e) && e.inside >= 0)) { snapAt = a.w.tick + 3; }
    if (a.w.tick === snapAt) break;
  }
  assert.ok(snapAt > 0, 'births on their way out');
  assert.equal(a.w.hash(), b.w.hash(), 'identical runs, identical hashes');
  const snap = JSON.parse(JSON.stringify(a.w.snapshot()));
  assert.equal(snap.v, SNAPSHOT_VERSION);
  const t = a.w.terrain;
  const c = World.restore({ ...t, height: t.height.slice(), cls: t.cls.slice(), tile: t.tile.slice() }, snap, a.w.rules, a.w.weapons);
  assert.equal(c.hash(), a.w.hash(), 'restored world hashes the same');
  for (let i = 0; i < 200; i++) { a.w.step(); c.step(); }
  assert.equal(c.hash(), a.w.hash(), 'and runs on identically');
  // a version 5 save: door counters and enter state default
  const old = JSON.parse(JSON.stringify(a.w.snapshot()));
  old.v = 5;
  for (const e of old.entities) { delete e.door; delete e.entering; delete e.enterStep; }
  const m = World.restore({ ...t, height: t.height.slice(), cls: t.cls.slice(), tile: t.tile.slice() }, old, a.w.rules, a.w.weapons);
  assert.ok(m.entities.every(e => e.door === 0 && e.entering === -1));
  for (let i = 0; i < 50; i++) m.step();
});
