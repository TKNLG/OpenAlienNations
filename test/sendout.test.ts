// Sending a unit out of a building (command 0x3A, our `sendOut`) and DEAKTIVIEREN through the same
// eject. Spec: docs/game/units-and-jobs.md 4.10 ("Putting the unit outside" step 4), 4.11;
// docs/ui/side-panel.md class 9 (building mode). Needs AN_DATA (real mission: Pimmons.mdb 4, the
// human Pimmons with an active laboratory, embassy, police station and tavern, operators inside).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { loadMission, DATA } from './helpers/mission.ts';
import { World, Kind, SUB, type Entity, type Command } from '../src/engine/world.ts';
import { T } from '../src/engine/economy.ts';
import { Rel, EMBASSY } from '../src/engine/diplomacy.ts';
import { CJ } from '../src/engine/combat.ts';

const skip = !existsSync(`${DATA}/dv.odb`) && 'AN_DATA not set';
const PIMMONS = 1, AMAZONS = 0;
const LAB = 46, TAVERN = 58, SCIENTIST = 23, LANDLORD = 18, DIPLOMAT = 13, SMALL_OUTPOST = 52, ARCHER = 29;

function mission() {
  const { world: w } = loadMission('Pimmons.mdb', 4, DATA, false);
  const building = (type: number, race = PIMMONS) => w.entities.find(e => e.kind === Kind.Building && e.owner === race && (e.oid & 0xffff) === type)!;
  const town = w.economy.towns.find(t => t.race === PIMMONS)!;
  return { w, building, town };
}
const steps = (w: World, n: number) => { for (let i = 0; i < n; i++) w.step(); };
const run = (w: World, cmd: Command) => { w.schedule(cmd); w.step(); };
const sendOut = (w: World, b: Entity, unit: number, player = PIMMONS) => run(w, { type: 'sendOut', player, building: b.id, unit });
const cell = (e: Entity): [number, number] => [Math.floor(e.x / SUB), Math.floor(e.y / SUB)];
/** a unit of `type` created and put inside `b` (entered now) */
function inside(w: World, b: Entity, type: number, race = PIMMONS): Entity {
  const u = w.spawn({ cls: 0, group: race, type, owner: -1, x: Math.floor(b.x / SUB), y: Math.floor(b.y / SUB), z: 0 });
  u.town = b.town;
  w.motion.vacate(u);
  w.putInside(u, b);
  return u;
}
/** step until the unit is outside; returns the ticks taken */
function untilOut(w: World, u: Entity, max = 60): number {
  for (let i = 1; i <= max; i++) { w.step(); if (u.inside < 0) return i; }
  throw new Error('the unit never came out');
}

test('sendOut: the first occupant of that type in entering order, one per command, out through the leave job', { skip }, () => {
  const { w } = mission();
  const house = w.entities.find(e => e.kind === Kind.Building && e.owner === PIMMONS && (e.oid & 0xffff) === T.SmallHouse)!;
  steps(w, 60);   // the porters born at map load are outside now
  assert.deepEqual(w.logistics.occupants(house).map(u => u.id), [], 'nobody inside');
  // entering order differs from id order
  const [a, b, c] = [0, 1, 2].map(() => w.spawn({ cls: 0, group: PIMMONS, type: T.Porter, owner: -1, x: 1, y: 1, z: 0 }));
  for (const u of [c, a, b]) { u.town = house.town; u.home = house.id; w.motion.vacate(u); w.putInside(u, house); }
  assert.deepEqual(w.logistics.occupants(house).map(u => u.id), [c.id, a.id, b.id], 'occupant list in entering order');

  // validation: another player's command, a unit type nobody has, a non-building: nothing
  sendOut(w, house, T.Porter, AMAZONS);
  run(w, { type: 'sendOut', player: PIMMONS, building: c.id, unit: T.Porter });
  sendOut(w, house, T.Builder);
  assert.equal(w.logistics.occupants(house).length, 3, 'refused commands change nothing');

  sendOut(w, house, T.Porter);
  assert.ok(w.logistics.leaving(c), 'the one inside longest is ejected');
  assert.ok(!w.logistics.leaving(a) && !w.logistics.leaving(b));
  assert.deepEqual(w.logistics.occupants(house).map(u => u.id), [a.id, b.id], 'it left the list at once');
  sendOut(w, house, T.Porter);
  assert.ok(w.logistics.leaving(a), 'the next command: the next one');
  const t = untilOut(w, c);
  assert.ok(t >= 18 && t <= 35, `put outside 20..35 ticks after the eject (${t + 2})`);
  assert.deepEqual(cell(c), w.logistics.entrance(house), 'on the entrance');
  assert.equal(c.home, house.id, 'a resident keeps its home');
  untilOut(w, a);
  assert.equal(b.inside, house.id, 'the third one stays inside');
  steps(w, 200);
  assert.equal(c.inside, -1, 'nothing sends it back in');
  assert.equal(house.active, true, 'a house has no operator: never deactivated');
});

test('sendOut: criminals are refused everywhere, the founder in a town hall', { skip }, () => {
  const { w, building } = mission();
  const lab = building(LAB), hall = building(T.TownHall);
  const crook = inside(w, lab, T.Criminal);
  sendOut(w, lab, T.Criminal);
  assert.equal(w.logistics.leaving(crook), false, 'type 12 refused');
  assert.equal(crook.inside, lab.id);
  const founder = w.logistics.occupants(hall).find(u => (u.oid & 0xffff) === T.Founder)!;
  assert.ok(founder, 'the founder is inside his town hall');
  sendOut(w, hall, T.Founder);
  assert.equal(w.logistics.leaving(founder), false, 'founder refused in a town hall');
  steps(w, 50);
  assert.equal(founder.inside, hall.id);
  assert.equal(hall.active, true);
  // a founder elsewhere is just another occupant
  const other = inside(w, lab, T.Founder);
  sendOut(w, lab, T.Founder);
  assert.ok(w.logistics.leaving(other), 'a founder in another building can be sent out');
});

test('sendOut: the operator deactivates his building when he is put outside, not at the command', { skip }, () => {
  const { w, building, town } = mission();
  const lab = building(LAB);
  const op = w.get(lab.operatorId)!;
  assert.equal(op.oid & 0xffff, SCIENTIST);
  assert.equal(lab.active, true);
  const upkeep = w.rules.get(lab.oid)!.money;
  const overheads = town.overheads;
  sendOut(w, lab, SCIENTIST);
  assert.ok(w.logistics.leaving(op));
  assert.equal(lab.active, true, 'still active while he is on his way out');
  assert.equal(lab.operatorId, op.id);
  for (let i = 0; i < 60 && op.inside >= 0; i++) {
    w.step();
    if (op.inside >= 0) assert.equal(lab.active, true, 'active until the placement');
  }
  assert.equal(op.inside, -1);
  assert.equal(lab.active, false, 'deactivated at the placement');
  assert.equal(lab.operatorId, -1, 'the stored operator is released');
  assert.equal(town.overheads, overheads - upkeep, 'upkeep removed');
  assert.ok(!town.workerReqs.some(([ty, id]) => ty === SCIENTIST && id === lab.id), 'no worker request is filed');
  steps(w, 300);
  assert.equal(lab.active, false, 'stays inactive');
  assert.equal(op.inside, -1, 'the scientist does not go back by himself');
  // ordered back in, he activates it again (8.1)
  run(w, { type: 'order', player: PIMMONS, ids: [op.id], target: lab.id });
  for (let i = 0; i < 400 && !lab.active; i++) w.step();
  assert.equal(lab.active, true, 'reactivated by entering');
  assert.equal(lab.operatorId, op.id);
});

test('DEAKTIVIEREN ejects the first operator-type occupant with the "sent out" flag', { skip }, () => {
  const { w, building } = mission();
  const tavern = building(TAVERN);
  const op = w.get(tavern.operatorId)!;
  assert.equal(op.oid & 0xffff, LANDLORD);
  assert.equal(op.inside, tavern.id);
  run(w, { type: 'building', player: PIMMONS, id: tavern.id, action: 'deactivate' });
  assert.ok(w.logistics.leaving(op), 'ejected through the leave job');
  assert.equal(tavern.active, true, 'not yet');
  untilOut(w, op);
  assert.equal(tavern.active, false, 'deactivated when he is put outside');
  assert.equal(tavern.operatorId, -1);
  assert.equal(tavern.opJob, 0, 'its operator / visit job is cancelled');
  // the town hall cannot be deactivated
  const hall = building(T.TownHall);
  run(w, { type: 'building', player: PIMMONS, id: hall.id, action: 'deactivate' });
  assert.ok(!w.logistics.occupants(hall).some(u => w.logistics.leaving(u)) && hall.active);
});

test('DEAKTIVIEREN on an operator who is outside: his job is cancelled, the building deactivated at once', { skip }, () => {
  const { w, building } = mission();
  const pe = building(EMBASSY);
  const d = w.get(pe.operatorId)!;
  w.diplomacy.offer(pe, AMAZONS, Rel.Peace);
  for (let i = 0; i < 80 && d.inside >= 0; i++) w.step();
  assert.equal(d.inside, -1, 'out on an errand');
  assert.ok(d.job, 'with a job');
  run(w, { type: 'building', player: PIMMONS, id: pe.id, action: 'deactivate' });
  assert.equal(pe.active, false, 'deactivated at once');
  assert.equal(pe.operatorId, -1, 'released');
  assert.equal(d.job, 0, 'errand cancelled');
  assert.equal(w.diplomacy.relation(PIMMONS, AMAZONS), Rel.None, 'the last embassy: relations reset');
});

test('sendOut: the diplomat closes the embassy (T312) and the relations are reset at placement', { skip }, () => {
  const { w, building } = mission();
  const pe = building(EMBASSY);
  const d = w.get(pe.operatorId)!;
  assert.equal(d.oid & 0xffff, DIPLOMAT);
  assert.equal(w.diplomacy.relation(PIMMONS, AMAZONS), Rel.Ceasefire);
  sendOut(w, pe, DIPLOMAT);
  assert.ok(w.logistics.leaving(d));
  assert.equal(w.diplomacy.relation(PIMMONS, AMAZONS), Rel.Ceasefire, 'unchanged while he is on his way out');
  untilOut(w, d);
  assert.equal(pe.active, false, 'embassy closed');
  assert.equal(w.diplomacy.relation(PIMMONS, AMAZONS), Rel.None, 'the only embassy: every relation back to 0');
  assert.equal(w.diplomacy.diplomatOf(pe), null, 'no diplomat any more');
});

test('sendOut: a foreign diplomat visiting the embassy comes out without closing it', { skip }, () => {
  const { w, building } = mission();
  const pe = building(EMBASSY);
  const d = w.get(pe.operatorId)!;
  w.diplomacy.offer(pe, AMAZONS, Rel.Peace);
  for (let i = 0; i < 80 && d.inside >= 0; i++) w.step();
  assert.equal(d.inside, -1, 'our diplomat is away on an errand');
  const guest = inside(w, pe, DIPLOMAT, AMAZONS);
  sendOut(w, pe, DIPLOMAT);
  assert.ok(w.logistics.leaving(guest), 'the guest (operator type, other race) is ejected');
  untilOut(w, guest);
  assert.equal(pe.active, true, 'other race: no deactivation');
  assert.equal(pe.operatorId, d.id, 'our diplomat is still the operator');
});

test('sendOut: soldiers out of an outpost; the last one ends the garrison job', { skip }, () => {
  const { w, building } = mission();
  const hall = building(T.TownHall);
  // a small outpost on free ground near the Pimmon town
  const [hx, hy] = [Math.floor(hall.x / SUB), Math.floor(hall.y / SUB)];
  let spot: [number, number] | null = null;
  for (let r = 6; r < 30 && !spot; r++) for (let dy = -r; dy <= r && !spot; dy++) for (let dx = -r; dx <= r && !spot; dx++) {
    let ok = true;
    for (let y = -3; y <= 2 && ok; y++) for (let x = -3; x <= 2 && ok; x++) if (w.occupied(hx + dx + x, hy + dy + y)) ok = false;
    if (ok) spot = [hx + dx, hy + dy];
  }
  assert.ok(spot, 'free ground');
  const post = w.spawn({ cls: 1, group: PIMMONS, type: SMALL_OUTPOST, owner: -1, x: spot![0], y: spot![1], z: 0 });
  post.town = hall.town; post.complete = true;
  const s1 = inside(w, post, ARCHER), s2 = inside(w, post, ARCHER);
  w.combat.startOutpost(post);
  const job = post.opJob;
  assert.equal(w.sched.get(job)?.kind, CJ.Outpost);
  sendOut(w, post, ARCHER);
  assert.ok(w.logistics.leaving(s1) && !w.logistics.leaving(s2), 'first in, first out');
  untilOut(w, s1);
  assert.equal(post.opJob, job, 'one soldier left: the garrison job goes on');
  assert.ok(!w.sched.get(job)!.cancelled);
  sendOut(w, post, ARCHER);
  assert.ok(w.logistics.leaving(s2));
  untilOut(w, s2);
  assert.equal(post.opJob, 0, 'the last one out: garrison job over');
  assert.ok(!w.sched.get(job) || w.sched.get(job)!.cancelled);
  steps(w, 100);
  assert.equal(s1.inside, -1); assert.equal(s2.inside, -1);
});

test('sendOut: lockstep: identical runs, the "sent out" flag survives a snapshot', { skip }, () => {
  const play = () => {
    const { w, building } = mission();
    const lab = building(LAB);
    steps(w, 5);
    w.schedule({ type: 'sendOut', player: PIMMONS, building: lab.id, unit: SCIENTIST }, w.tick + 3);
    steps(w, 10);   // the scientist is on his way out
    return { w, lab };
  };
  const a = play(), b = play();
  assert.equal(a.w.hash(), b.w.hash(), 'identical runs, identical hashes');
  const op = a.w.get(a.lab.operatorId)!;
  assert.ok(a.w.logistics.leaving(op) && a.lab.active);
  const snap = JSON.parse(JSON.stringify(a.w.snapshot()));
  const t = a.w.terrain;
  const c = World.restore({ ...t, height: t.height.slice(), cls: t.cls.slice(), tile: t.tile.slice() }, snap, a.w.rules, a.w.weapons);
  assert.equal(c.hash(), a.w.hash(), 'restored: same hash');
  steps(a.w, 40); steps(c, 40);
  assert.equal(c.hash(), a.w.hash(), 'and runs on identically');
  assert.equal(c.get(a.lab.id)!.active, false, 'the restored leave job still deactivates at placement');
  assert.equal(a.lab.active, false);
  // the entering order (occupant list) is part of the saved state
  assert.ok(snap.enters > 0, 'entry counter saved');
  const inHall = (snap.entities as Entity[]).filter(e => e.inside >= 0 && e.enterSeq > 0);
  assert.ok(inHall.length > 0, 'entry order saved per unit');
});

test('sendOut: a pupil out of a school; the next occupant takes its place, no porter request', { skip }, () => {
  const { w, building, town } = mission();
  const school = building(55);
  const p1 = inside(w, school, T.Porter), p2 = inside(w, school, T.Porter);
  school.queue.push(T.Builder);
  school.trainStarted = 1; school.trainProgress = 40;
  const reqs = town.workerReqs.length;
  assert.equal(w.logistics.trainees(school)[0], p1, 'the head of the list is the pupil');
  sendOut(w, school, T.Porter);
  assert.ok(w.logistics.leaving(p1), 'sending out a porter takes that pupil out');
  assert.equal(w.logistics.trainees(school)[0], p2, 'the next occupant is retyped in its place');
  assert.ok(school.trainProgress >= 40, 'the progress is kept');
  assert.equal(town.workerReqs.length, reqs, 'no new porter request');
});
