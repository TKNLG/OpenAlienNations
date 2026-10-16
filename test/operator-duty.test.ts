// Operators out on their building's own duty stay linked to it; a dropped duty job breaks the link.
// Spec: docs/game/units-and-jobs.md 8.5; docs/game/combat.md 12.2, 12.3; docs/game/ai-diplomacy-trade.md 3.4.
// Needs AN_DATA (Pimmons.mdb 4: the human Pimmons with an active police station and embassy).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { loadMission, DATA } from './helpers/mission.ts';
import { World, Kind, SUB, type Command } from '../src/engine/world.ts';
import { Rel, EMBASSY } from '../src/engine/diplomacy.ts';

const skip = !existsSync(`${DATA}/dv.odb`) && 'AN_DATA not set';
const PIMMONS = 1, AMAZONS = 0, POLICE_STATION = 54, POLICE = 21, CRIMINAL = 12, CJ_ARREST = 0x18;

function mission() {
  const { world: w } = loadMission('Pimmons.mdb', 4, DATA, false);
  const building = (type: number) => w.entities.find(e => e.kind === Kind.Building && e.owner === PIMMONS && (e.oid & 0xffff) === type)!;
  const town = w.economy.towns.find(t => t.race === PIMMONS)!;
  return { w, building, town };
}
const run = (w: World, cmd: Command) => { w.schedule(cmd); w.step(); };
const until = (w: World, cond: () => boolean, max: number, what: string) => {
  for (let i = 0; i < max; i++) { if (cond()) return; w.step(); }
  assert.ok(cond(), `timed out: ${what}`);
};

/** a station with its officer inside and one criminal of the town near it; returns once the officer is out hunting */
function hunt() {
  const { w, building, town } = mission();
  const st = building(POLICE_STATION);
  const officer = w.get(st.operatorId)!;
  assert.equal(officer.oid & 0xffff, POLICE);
  assert.equal(officer.inside, st.id);
  assert.ok(st.active);
  const spot = w.freeSpiral(Math.floor(st.x / SUB) + 5, Math.floor(st.y / SUB) + 5, 10)!;
  const crim = w.spawnUnit(PIMMONS, CRIMINAL, spot[0], spot[1], town.id);
  w.economy.joinTown(crim, town);
  until(w, () => officer.inside < 0 && w.sched.get(officer.job)?.kind === CJ_ARREST && w.sched.get(officer.job)!.data[1] === 1, 400, 'officer out hunting');
  return { w, st, officer, crim, town };
}

test('police: the station stays active while its officer hunts; he comes back and the operator job restarts', { skip }, () => {
  const { w, st, officer, crim } = hunt();
  for (let i = 0; i < 20; i++) {
    w.step();
    assert.equal(st.active, true, 'still active during the hunt');
    assert.equal(st.operatorId, officer.id, 'still its operator');
  }
  crim.hp = 41;   // one more blow and he is arrested (80% of 50)
  until(w, () => officer.inside === st.id && !w.logistics.leaving(officer), 3000, 'officer back inside');
  assert.equal(st.active, true);
  assert.equal(st.operatorId, officer.id);
  assert.ok(st.opJob, 'the operator job runs again');
  assert.equal(w.sched.get(st.opJob)?.kind, 0x22);
});

test('police: a manual order to the officer on duty breaks the link: the station is inactive, no request', { skip }, () => {
  const { w, st, officer, town } = hunt();
  const [x, y] = [Math.floor(officer.x / SUB) + 3, Math.floor(officer.y / SUB)];
  run(w, { type: 'move', player: PIMMONS, ids: [officer.id], x, y });
  assert.equal(st.active, false, 'deactivated');
  assert.equal(st.operatorId, -1, 'no stored operator');
  assert.equal(st.opJob, 0);
  assert.ok(!town.workerReqs.some(([ty, b]) => ty === POLICE && b === st.id), 'no worker request');
  // ordered back in, he activates it again (8.1)
  run(w, { type: 'order', player: PIMMONS, ids: [officer.id], target: st.id });
  until(w, () => st.active, 600, 'reactivated');
  assert.equal(st.operatorId, officer.id);
});

test('police: an officer killed on duty: the station is deactivated and asks for a new officer', { skip }, () => {
  const { w, st, officer, town } = hunt();
  w.combat.die(officer);
  assert.equal(st.active, false);
  assert.equal(st.operatorId, -1);
  assert.ok(town.workerReqs.some(([ty, b]) => ty === POLICE && b === st.id), 'worker request for a police officer');
});

test('diplomat: the embassy stays active during an errand; a manual order on the way breaks the link', { skip }, () => {
  const { w, building } = mission();
  const pe = building(EMBASSY);
  const d = w.get(pe.operatorId)!;
  assert.equal(w.diplomacy.relation(PIMMONS, AMAZONS), Rel.Ceasefire);
  w.diplomacy.offer(pe, AMAZONS, Rel.Peace);
  until(w, () => d.inside < 0 && !!d.path, 200, 'diplomat on his way');
  for (let i = 0; i < 20; i++) { w.step(); assert.equal(pe.active, true, 'active during the errand'); assert.equal(pe.operatorId, d.id); }
  run(w, { type: 'move', player: PIMMONS, ids: [d.id], x: Math.floor(d.x / SUB) + 2, y: Math.floor(d.y / SUB) });
  assert.equal(pe.active, false, 'the embassy lost its diplomat');
  assert.equal(pe.operatorId, -1);
  assert.equal(w.diplomacy.relation(PIMMONS, AMAZONS), Rel.None, 'its only embassy: relations reset');
  assert.equal(w.diplomacy.diplomatOf(pe), null);
});

test('diplomat: a completed errand ends inside the active embassy with its operator job restarted', { skip }, () => {
  const { w, building } = mission();
  const pe = building(EMBASSY);
  const d = w.get(pe.operatorId)!;
  w.diplomacy.offer(pe, AMAZONS, Rel.Peace);
  until(w, () => d.inside < 0, 200, 'out');
  until(w, () => d.inside === pe.id && !d.job, 6000, 'back home');
  assert.equal(pe.active, true);
  assert.equal(pe.operatorId, d.id);
  assert.ok(pe.opJob, 'operator job (ejects foreign visitors) runs again');
});


test('diplomat: a second offer while he is out closes the embassy until he walks back in (quirk)', { skip }, () => {
  const { w, building } = mission();
  const pe = building(EMBASSY);
  const d = w.get(pe.operatorId)!;
  w.diplomacy.offer(pe, AMAZONS, Rel.Peace);
  until(w, () => d.inside < 0 && !!d.path, 200, 'diplomat on his way');
  assert.equal(w.diplomacy.offer(pe, AMAZONS, Rel.War), true, 'a second offer is accepted');
  assert.equal(pe.active, false, 'the old errand died under way: the embassy is closed');
  assert.equal(pe.operatorId, -1);
  until(w, () => d.inside === pe.id && !d.job, 6000, 'back home');
  assert.equal(pe.active, true, 'his entry activates it again');
  assert.equal(pe.operatorId, d.id);
});
