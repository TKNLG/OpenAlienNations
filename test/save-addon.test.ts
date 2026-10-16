// Savegames of generated and add-on maps (src/client/main.ts loadMission, makeSave): the terrain is
// not in the save, the client rebuilds it on load. Island free play re-rolls its seed almost every
// time; saves written before October 2026 kept the menu's start seed (the front end replaced the
// game's record with the session's), and the client rebuilt them from generate(start seed) alone:
// a different island under the saved buildings. world/free-play.ts rebuilds a save through the
// whole re-roll chain, so start-seed and final-seed records both give the original terrain.
// Needs the Gold data (AN_GOLD).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMdb, parseDvmFile, dvmLayout, type Mission } from '../src/formats/mission.ts';
import { parseOs } from '../src/formats/os.ts';
import { CLASS_TILESET, type Terrain } from '../src/world/terrain.ts';
import { aoPickTables, addonTerrainFromStored, type AddonTerrain } from '../src/world/addon-terrain.ts';
import { generateIslandTerrain } from '../src/world/island-gen.ts';
import { buildGeneratedWorld, isGeneratedWorld } from '../src/world/free-play.ts';
import { animalTypeCount } from '../src/formats/addon.ts';
import { World, Kind, SUB, SNAPSHOT_VERSION, type WorldSnapshot } from '../src/engine/world.ts';
import { applyFreePlay, spDefaults } from '../src/client/frontend/freeplay.ts';
import { newSaveId, type SaveGame } from '../src/client/saves.ts';
import { GOLD, HAS_GOLD, dataReader, rulesOf, loadAddonMission } from './helpers/mission.ts';

const skip = !HAS_GOLD && 'AN_GOLD data not found';
const FOUNDER = 10;

function spotNear(w: World, race: number, u: { x: number; y: number }): [number, number] {
  const ux = Math.floor(u.x / SUB), uy = Math.floor(u.y / SUB);
  for (let r = 3; r < 30; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
    if (w.logistics.canFound(race, ux + dx, uy + dy, true)) return [ux + dx, uy + dy];
  }
  throw new Error('no site');
}

/** the client's world construction for a record without a map file (main.ts loadMission) */
function clientWorld(m: Mission, player: number, snapshot?: WorldSnapshot) {
  const read = dataReader(GOLD);
  const rules = rulesOf(GOLD, !!m.addon);
  const pickOf = (n: string) => parseOs(read(`${n}.os`)!).pick;
  const hallOf = (race: number) => { const r = rules.rules.get(((race << 16) | 40) >>> 0); return r ? { sizeX: r.sizeX, sizeY: r.sizeY, radius: r.radius || 25 } : undefined; };
  assert.ok(isGeneratedWorld(m));
  const g = buildGeneratedWorld(m, {
    player, hallOf, pick: CLASS_TILESET.map(pickOf),
    aoPick: m.addon ? aoPickTables(pickOf) : undefined,
    animalTypes: m.addon ? animalTypeCount(rules.rules) : undefined,
  });
  const world = snapshot ? World.restore(g.terrain, snapshot, rules.rules, rules.weapons)
    : new World(g.terrain, g.result.objects, rules.rules, {
      races: m.races, costs: rules.inventions.map(l => l.map(i => i.cost)), prerequisites: rules.inventions.map(l => l.map(i => i.prerequisites)),
      goals: m.goals, weapons: rules.weapons, orders: [], lists: g.result.lists,
    });
  return { world, terrain: g.terrain, mission: g.seed !== m.seed ? { ...m, seed: g.seed } : m };
}

/** what the client stores (main.ts makeSave + app.ts doSave): snapshot with fog, the mission record */
function clientSave(w: World, campaign: string, index: number, player: number, missionData?: Mission): SaveGame {
  return {
    id: newSaveId(), name: 'Test', savedAt: 0, mission: { campaign, index }, player,
    snapshot: { ...w.snapshot(), fog: { explored: '5,7,3', seen: [1, 2, 3] } } as WorldSnapshot,
    missionData,
  };
}

/** IndexedDB (structured clone), then the .ansave export (JSON) */
const throughStorage = (s: SaveGame) => JSON.parse(JSON.stringify(structuredClone(s))) as SaveGame;

const same = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.prototype.every.call(a, (v: number, i: number) => v === b[i]);

/** every per-cell layer the simulation, the renderer and the minimap read */
function sameGround(a: World, b: World, what: string): void {
  const ta = a.terrain as Terrain & Partial<AddonTerrain>, tb = b.terrain as Terrain & Partial<AddonTerrain>;
  assert.equal(tb.size, ta.size, `${what}: size`);
  for (const k of ['height', 'cls', 'tile', 'aoCls', 'island'] as const) {
    if (!ta[k] && !tb[k]) continue;
    assert.ok(same(ta[k]!, tb[k]!), `${what}: terrain.${k}`);
  }
  assert.equal(b.addon, a.addon, `${what}: add-on mode`);
  assert.ok(same(a.blocked, b.blocked), `${what}: blocked`);
  assert.ok(same(a.pathFlag, b.pathFlag), `${what}: path flags`);
  assert.ok(same(a.shipBlocked, b.shipBlocked), `${what}: ship passability`);
  if (a.island) assert.ok(b.island && same(a.island, b.island), `${what}: island ids`);
}

function roundTrip(campaign: string, base: Mission, startSeed: number, ticks: number) {
  const player = base.humanRace >= 0 ? base.humanRace : 0;
  const m0 = applyFreePlay(base, spDefaults(), startSeed);
  const { world: w, mission: m } = clientWorld(m0, player);
  // the player founds his town (foundations change the ground: saved terrain edits)
  const founder = w.entities.find(e => e.kind === Kind.Unit && e.owner === player && (e.oid & 0xffff) === FOUNDER)!;
  assert.ok(founder, 'the player starts with a founder');
  const [x, y] = spotNear(w, player, founder);
  w.schedule({ type: 'found', player, unit: founder.id, x, y }, w.tick + 1);
  for (let i = 0; i < ticks; i++) w.step();
  assert.ok(w.economy.towns.some(t => t.race === player && t.alive), 'the player has a town');
  assert.ok(w.snapshot().ground!.length > 0, 'the save carries terrain edits');
  const h = w.hash();
  // a save of this build keeps the game's record (final seed); an older one the start record
  for (const [what, rec] of [['final-seed record', m], ['start-seed record (older save)', m0]] as const) {
    const save = throughStorage(clientSave(w, campaign, player, player, rec));
    const r = clientWorld(save.missionData!, save.player, save.snapshot);
    sameGround(w, r.world, what);
    assert.equal(r.mission.seed, m.seed, `${what}: the record is corrected to the final seed`);
    assert.equal(r.world.hash(), h, `${what}: world hash`);
    // older snapshot versions differ only in migrated state, never in the ground
    const v10 = clientWorld(save.missionData!, save.player, { ...save.snapshot, v: 10 });
    sameGround(w, v10.world, `${what}, version 10`);
    for (let i = 0; i < 150; i++) r.world.step();
  }
  return { w, m, m0 };
}

test('save: island free play (Gold) restores the generated islands from the final and from the start seed', { skip }, () => {
  const base = parseMdb(dataReader(GOLD)('InfiniteAO.mdb')!)[0];
  assert.ok(base.addon && !base.mapFile);
  const { w, m, m0 } = roundTrip('infinite-ao', base, 59859, 400);
  assert.ok(m.seed !== m0.seed, 'the island builder re-rolled the seed (the case older saves got wrong)');
  // the old load path: the island of the start seed is not the one played on
  const pick = aoPickTables(n => parseOs(dataReader(GOLD)(`${n}.os`)!).pick);
  const old = generateIslandTerrain(m0.seed, m0.sizeBits, pick);
  assert.ok(!same(old.height, w.terrain.height));
  // the restored world runs on identically
  const save = throughStorage(clientSave(w, 'infinite-ao', 0, 0, m));
  const r = clientWorld(save.missionData!, 0, save.snapshot).world;
  for (let i = 0; i < 200; i++) { w.step(); r.step(); }
  assert.equal(r.hash(), w.hash());
});

test('save: base free play restores the generated world', { skip }, () => {
  // (the base world builder seldom re-rolls; the save goes through the same chain)
  const base = parseMdb(dataReader(GOLD)('Infinite.mdb')!)[0];
  assert.ok(!base.addon && !base.mapFile);
  roundTrip('infinite', base, 99, 300);
});

test('save: add-on campaign map (stored terrain) restores the ground and the world', { skip }, () => {
  const { world: w, mission: m } = loadAddonMission('PimmonsAO.mdb', 1);
  assert.equal(m.seed, -2);
  for (let i = 0; i < 400; i++) w.step();
  const save = throughStorage(clientSave(w, 'pimmons-ao', 0, m.humanRace));
  assert.equal(save.snapshot.v, SNAPSHOT_VERSION);
  // the client rebuilds the terrain from the map file
  const file = parseDvmFile(dataReader(GOLD)(m.mapFile)!, dvmLayout(m));
  const r = World.restore(addonTerrainFromStored(file.terrain!), save.snapshot, w.rules, w.weapons);
  sameGround(w, r, 'add-on campaign');
  assert.equal(r.hash(), w.hash());
  for (let i = 0; i < 200; i++) { w.step(); r.step(); }
  assert.equal(r.hash(), w.hash());
});
