// Savegames as the browser client writes them (src/client/saves.ts): the World snapshot plus fog and
// the mission record go through IndexedDB (structured clone) and the .ansave export (JSON). A busy
// mid-game world (computer players active, units mid-walk, a porter mid-flee with his transport's
// walk kept aside, a swordfighter mid-chase) must survive both and restore to the identical
// world, which then runs on identically. Older snapshots (version 7) still load. Needs AN_DATA.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { loadMission, DATA } from './helpers/mission.ts';
import { Kind, SUB, SNAPSHOT_VERSION, World, type Entity, type WorldSnapshot } from '../src/engine/world.ts';
import { newSaveId, type SaveGame } from '../src/client/saves.ts';

const skip = !existsSync(`${DATA}/dv.wdb`) && 'AN_DATA not set';
const SWORD = 31, PORTER = 9, FLEE = 0x26;

const cellOf = (e: Entity): [number, number] => [Math.floor(e.x / SUB), Math.floor(e.y / SUB)];
const kindOf = (w: World, u: Entity) => (u.job ? w.sched.get(u.job)?.kind ?? -1 : 0);

/** a free rectangle near (x, y): its left middle cell */
function freeArea(w: World, x: number, y: number, wd: number, h: number): [number, number] {
  for (let r = 0; r < 90; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
    let ok = true;
    for (let k = -1; k <= wd && ok; k++) for (let j = -h; j <= h && ok; j++) if (w.occupied(x + dx + k, y + dy + j) || !w.motion.free(x + dx + k, y + dy + j)) ok = false;
    if (ok) return [x + dx, y + dy];
  }
  throw new Error('no free area');
}

/** Pimmons vs Amazons with the computer player active, run until the towns are busy */
function aiWorld() {
  const { world: w, mission: m } = loadMission('Pimmons.mdb', 7, DATA, true);
  for (let i = 0; i < 2500; i++) w.step();
  return { w, m };
}

/** ... then a flee and a chase under way */
function busyWorld() {
  const { w, m } = aiWorld();
  const me = m.humanRace;
  const enemy = m.races.find(r => r.present && r.race !== me)!.race;
  const t = w.economy.towns.find(x => x.race === me)!;
  // our porters stand idle after their leisure visit (units-and-jobs.md 5.7): send them across town
  // on a go-to (not a player order, which would not flee)
  const far = w.entities.filter(e => e.kind === Kind.Building && e.owner === me && e.complete)
    .sort((a, b) => Math.hypot(b.x - t.x * SUB, b.y - t.y * SUB) - Math.hypot(a.x - t.x * SUB, a.y - t.y * SUB))[0];
  for (const e of w.entities.filter(e => e.kind === Kind.Unit && e.owner === me && e.alive && e.inside < 0 && !e.job && (e.oid & 0xffff) === PORTER))
    if (far) w.logistics.assign(e, 0x3c, 1, [0, far.id, PORTER, 1]);
  // a flee: one of our walking workers is struck by an (unarmed) enemy and runs, his walk kept aside
  let fleeing: Entity | undefined;
  for (let i = 0; i < 400 && !fleeing; i++) {
    w.step();
    const u = w.entities.find(e => e.kind === Kind.Unit && e.owner === me && e.alive && e.inside < 0 && e.job && e.path?.length && e.stepStart + e.stepTicks <= w.tick && kindOf(w, e) !== FLEE);
    if (!u) continue;
    const [ux, uy] = cellOf(u);
    const a = w.spawnUnit(enemy, PORTER, ux + 2, uy, -1);
    w.combat.attacked(u, a);
    if (kindOf(w, u) === FLEE && u.walks.length) fleeing = u;
  }
  assert.ok(fleeing, 'a worker flees with his walk kept aside');
  // a chase: an enemy porter walks away, a swordfighter is ordered onto it
  const [x, y] = freeArea(w, t.x + 12, t.y + 12, 38, 9);
  const sword = w.spawnUnit(me, SWORD, x, y, t.id);
  const prey = w.spawnUnit(enemy, PORTER, x + 9, y, -1);
  w.schedule({ type: 'move', player: enemy, ids: [prey.id], x: x + 36, y });
  w.schedule({ type: 'order', player: me, ids: [sword.id], target: prey.id });
  for (let i = 0; i < 20; i++) w.step();
  return { w, me, sword, prey, fleeing: fleeing! };
}

/** what the client stores: SaveGame with fog and mission record (main.ts makeSave, app.ts doSave) */
function clientSave(w: World): SaveGame {
  return {
    id: newSaveId(), name: 'Test', savedAt: 0, mission: { campaign: 'pimmons', index: 7 }, player: 0,
    snapshot: { ...w.snapshot(), fog: { explored: '5,7,3', seen: [1, 2, 3] } } as WorldSnapshot,
  };
}

function restore(w: World, snap: WorldSnapshot): World {
  const tr = w.terrain;
  return World.restore({ ...tr, height: tr.height.slice(), cls: tr.cls.slice(), tile: tr.tile.slice() }, snap, w.rules, w.weapons);
}

test('savegame: a busy mid-game world survives structured clone (IndexedDB) and JSON (.ansave) and runs on identically', { skip }, () => {
  const { w, sword, prey, fleeing } = busyWorld();
  // the state the save is meant to cover
  assert.ok(w.ai.players.some(p => p), 'a computer player is active');
  assert.equal(kindOf(w, fleeing), FLEE, 'the worker is still fleeing');
  assert.ok(fleeing.walks.length > 0, 'his walk is still kept aside');
  assert.ok(prey.alive && sword.job && sword.path, 'the swordfighter is mid-chase');
  assert.ok(w.entities.filter(e => e.kind === Kind.Unit && e.path?.length).length > 5, 'units mid-walk');

  const save = clientSave(w);
  assert.equal(save.snapshot.v, SNAPSHOT_VERSION);
  const viaClone = structuredClone(save);
  const viaJson = JSON.parse(JSON.stringify(structuredClone(save))) as SaveGame;
  assert.deepEqual(viaJson, viaClone, 'JSON keeps everything structured clone keeps');
  const h = w.hash();
  const a = restore(w, viaClone.snapshot), b = restore(w, viaJson.snapshot);
  assert.equal(a.hash(), h, 'restored from the structured clone');
  assert.equal(b.hash(), h, 'restored from JSON');
  // a restored world snapshots to the same data again
  assert.deepEqual(JSON.parse(JSON.stringify(a.snapshot())), JSON.parse(JSON.stringify(w.snapshot())));
  for (let i = 0; i < 400; i++) { w.step(); a.step(); b.step(); }
  assert.equal(a.hash(), w.hash(), 'runs on identically');
  assert.equal(b.hash(), w.hash());
});

test('savegame: version 7 snapshots (no walk mask, no kept walks, no AI move/intruder records) still load and run', { skip }, () => {
  // (no kept walks then: before version 8 a unit had only its current walk)
  const { w } = aiWorld();
  assert.ok(w.entities.every(e => !e.walks.length));
  const snap = structuredClone(w.snapshot());
  snap.v = 7;
  for (const e of snap.entities as unknown as Record<string, unknown>[]) { delete e.walkMask; delete e.walks; }
  for (const t of (snap.ai?.towns ?? []) as unknown as (Record<string, unknown> | null)[]) if (t) { delete t.moved; delete t.intruders; }
  const r = restore(w, snap);
  for (const e of r.entities) { assert.ok(Array.isArray(e.walks)); assert.equal(typeof e.walkMask, 'number'); }
  for (let i = 0; i < 400; i++) r.step();
  assert.ok(r.tick > w.tick);
});

test('savegame ids: work without crypto.randomUUID (plain http on a LAN host is not a secure context)', {}, () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  assert.ok(UUID.test(newSaveId()));
  Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true });
  try {
    const ids = new Set(Array.from({ length: 100 }, () => newSaveId()));
    assert.equal(ids.size, 100);
    for (const id of ids) assert.ok(UUID.test(id), id);
  } finally { delete (crypto as unknown as Record<string, unknown>).randomUUID; }
  assert.equal(typeof crypto.randomUUID, 'function');
});
