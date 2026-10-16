// Combat on a real mission (needs AN_DATA). Spec: docs/game/combat.md

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { loadMission, DATA } from './helpers/mission.ts';
import { Kind, SUB, type World, type Entity } from '../src/engine/world.ts';

const skip = !existsSync(`${DATA}/dv.wdb`) && 'AN_DATA not set';

/** a free, flat spot near a cell */
function freeSpot(w: World, x: number, y: number): [number, number] {
  for (let r = 0; r < 30; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
    let ok = true;
    for (let k = -1; k <= 8 && ok; k++) for (let j = -1; j <= 1 && ok; j++) if (w.occupied(x + dx + k, y + dy + j)) ok = false;
    if (ok) return [x + dx, y + dy];
  }
  throw new Error('no free spot');
}

function setup() {
  const { world: w, mission: m } = loadMission('Pimmons.mdb', 7, DATA, false);  // Das Trainingslager: Pimmons vs Amazons
  const me = m.humanRace;
  const enemy = m.races.find(r => r.present && r.race !== me)!.race;
  const t = w.economy.towns.find(x => x.race === me)!;
  return { w, me, enemy, t };
}

test('duel: a swordfighter beats an archer it attacks', { skip }, () => {
  const { w, me, enemy, t } = setup();
  const [x, y] = freeSpot(w, t.x + 12, t.y + 12);
  const sword = w.spawnUnit(me, 31, x, y, t.id);
  const archer = w.spawnUnit(enemy, 29, x + 6, y, -1);
  w.schedule({ type: 'order', player: me, ids: [sword.id], target: archer.id });
  let i = 0;
  for (; i < 3000 && sword.alive && archer.alive; i++) w.step();
  assert.ok(!archer.alive || !sword.alive, 'one of them died');
  assert.ok(sword.alive, 'the swordfighter won');
  assert.ok(sword.exp >= 200, `experience ${sword.exp}`);
  assert.equal(w.get(archer.id), undefined, 'the dead archer is removed');
});

test('hammer men demolish an enemy building, rubble is left', { skip }, () => {
  const { w, me, enemy, t } = setup();
  const target = w.entities.find(e => e.kind === Kind.Building && e.owner === enemy && e.complete && (e.oid & 0xffff) !== 40 &&
    (w.rules.get(e.oid)?.cost[2] ?? 0) > 0)!;
  const r = w.rules.get(target.oid)!;
  const [bx, by] = [Math.floor(target.x / SUB), Math.floor(target.y / SUB)];
  // one unit per cell (units-and-jobs.md 4.7): the men start on free cells next to the footprint,
  // so the defenders do not catch them on the way round
  const men: Entity[] = [];
  const sx = Math.max(1, r.sizeX), sy = Math.max(1, r.sizeY);
  for (let y = by - sy; y <= by + 1 && men.length < 4; y++) for (let x = bx - sx; x <= bx + 1 && men.length < 4; x++) {
    if (x > bx - sx && x <= bx && y > by - sy && y <= by) continue;
    if (w.motion.free(x, y)) men.push(w.spawnUnit(me, 30, x, y, t.id));
  }
  assert.equal(men.length, 4);
  w.schedule({ type: 'order', player: me, ids: men.map(u => u.id), target: target.id });
  for (let i = 0; i < 4000 && w.get(target.id); i++) w.step();
  assert.equal(w.get(target.id), undefined, `${r.name} destroyed`);
  const rubble = w.entities.filter(e => (e.oid & 0xffff) === 38 && w.logistics.dist(e.x >> 8, e.y >> 8, bx, by) <= 3);
  assert.equal(rubble.reduce((s, e) => s + e.amount, 0), r.cost[2], 'rubble = stone cost');
});

test('a criminal assaults porters of its town', { skip }, () => {
  const { w, me, t } = setup();
  const crim = w.spawnUnit(me, 12, t.x + 2, t.y + 3, t.id);
  w.economy.joinTown(crim, t);
  const porters = () => w.entities.filter(e => e.kind === Kind.Unit && e.town === t.id && (e.oid & 0xffff) === 9);
  const hp0 = porters().reduce((s, p) => s + p.hp, 0);
  for (let i = 0; i < 1500; i++) w.step();
  const hp1 = porters().reduce((s, p) => s + p.hp, 0);
  assert.ok(hp1 < hp0, `porters hurt (${hp0} -> ${hp1})`);
});

test('combat is deterministic', { skip }, () => {
  const run = () => {
    const { w, me, enemy, t } = setup();
    const [x, y] = freeSpot(w, t.x + 12, t.y + 12);
    const a = w.spawnUnit(me, 29, x, y, t.id), b = w.spawnUnit(enemy, 31, x + 5, y + 2, -1);
    w.schedule({ type: 'order', player: me, ids: [a.id], target: b.id });
    for (let i = 0; i < 800; i++) w.step();
    return w.hash();
  };
  assert.equal(run(), run());
});
