// Starting inventions (docs/game/economy.md 4.4.2): the free-play development setting
// ("Entwicklungsstufe", docs/ui/front-end.md 6.2) and, in add-on records, the add-on inventions
// 30 Werft, 31 Hafen, 32 heavy warship that the research-level routine adds (docs/formats/addon.md 6).
// Needs the Gold Edition data folder (AN_GOLD); the base records are read from it too.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GOLD, HAS_GOLD, dataReader, rulesOf, islandGenerator, loadAddonMission } from './helpers/mission.ts';
import { parseMdb, type Mission, type MapObject } from '../src/formats/mission.ts';
import { parseOs } from '../src/formats/os.ts';
import { generateTerrain, CLASS_TILESET } from '../src/world/terrain.ts';
import { World, Kind } from '../src/engine/world.ts';
import { applyFreePlay, mpMission, spDefaults } from '../src/client/frontend/freeplay.ts';
import type { GameSetup, Seat } from '../src/net/protocol.ts';

const skip = !HAS_GOLD && 'AN_GOLD data not found';
const HARBOUR = 62, SHIPYARD = 63, FISHING_BOAT = 64, LIGHT_WARSHIP = 65, HEAVY_WARSHIP = 66, TRANSPORT = 67;
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

/** economy.md 4.4.2 table: researched inventions per development setting */
const EXPECTED_AO: number[][] = [[], [...range(0, 12), 30, 31], [...range(0, 20), 30, 31, 32]];
const EXPECTED_BASE: number[][] = [[], range(0, 12), range(0, 20)];
/** availability of the add-on objects per development setting (no research needed) */
const AVAILABLE: Record<number, boolean[]> = {
  [HARBOUR]: [false, true, true],
  [SHIPYARD]: [false, true, true],
  [FISHING_BOAT]: [false, true, true],
  [TRANSPORT]: [false, true, true],
  [LIGHT_WARSHIP]: [false, false, true],
  [HEAVY_WARSHIP]: [false, false, true],
};

const researchedSet = (w: World, race: number) => {
  const p = w.economy.players[race]!;
  return p.costs.map((_, i) => i).filter(i => w.economy.researched(p, i));
};

/** a free-play world with a finished town hall and shipyard for every present race */
function freePlayWorld(m: Mission, addon: boolean, races = m.races): World {
  const rules = rulesOf(GOLD, addon);
  let terrain;
  if (addon) terrain = islandGenerator(GOLD)(4242, 8);
  else {
    const read = dataReader(GOLD);
    terrain = generateTerrain(77, 7, CLASS_TILESET.map(n => parseOs(read(`${n}.os`)!).pick));
  }
  // land cells far enough apart for three towns
  const land: [number, number][] = [];
  const island = (terrain as { island?: Uint8Array }).island;
  for (let y = 8; y < terrain.size - 8 && land.length < 3; y += 3) for (let x = 8; x < terrain.size - 8 && land.length < 3; x += 3) {
    const i = y * terrain.size + x;
    if (island ? island[i] === 0 : terrain.cls[i] === 0) continue;
    if (land.every(([lx, ly]) => Math.abs(lx - x) + Math.abs(ly - y) > 40)) land.push([x, y]);
  }
  const objects: MapObject[] = [];
  races.filter(r => r.present).forEach((r, k) => {
    const [x, y] = land[k];
    objects.push({ cls: 1, group: r.race, type: 40, owner: 1, x, y, z: 0 });
    if (addon) objects.push({ cls: 1, group: r.race, type: SHIPYARD, owner: 1, x: x + 6, y, z: 0 });
  });
  return new World(terrain, objects, rules.rules, {
    races, costs: rules.inventions.map(l => l.map(i => i.cost)), prerequisites: rules.inventions.map(l => l.map(i => i.prerequisites)),
    goals: m.goals, weapons: rules.weapons, orders: [], ai: false,
  });
}

test('start research: add-on free play grants Werft and Hafen from Mittel, the heavy warship with Hoch', { skip }, () => {
  const records = parseMdb(dataReader(GOLD)('InfiniteAO.mdb')!);
  for (const human of [0, 1, 2]) {
    for (const development of [0, 1, 2]) {
      const m = applyFreePlay(records[human], { ...spDefaults(), development, addon: true }, 1);
      const w = freePlayWorld(m, true);
      assert.ok(w.addon);
      for (const race of [0, 1, 2]) {
        const what = `human ${human}, race ${race}${race === human ? '' : ' (computer)'}, development ${development}`;
        assert.deepEqual(researchedSet(w, race), EXPECTED_AO[development], what);
        const t = w.economy.towns.find(x => x.race === race)!;
        const yard = w.entities.find(e => e.kind === Kind.Building && e.owner === race && (e.oid & 0xffff) === SHIPYARD)!;
        assert.ok(t && yard, what);
        for (const type of [HARBOUR, SHIPYARD]) {
          const st = w.logistics.menuState(t, type);
          assert.equal(st !== 2, AVAILABLE[type][development], `${what}: building ${type} menu state ${st}`);
        }
        for (const type of [FISHING_BOAT, LIGHT_WARSHIP, HEAVY_WARSHIP, TRANSPORT]) {
          const st = w.logistics.trainState(t, yard, type);
          assert.ok(st !== -1, `${what}: ship ${type} is trained at the shipyard`);
          assert.equal(st !== 2, AVAILABLE[type][development], `${what}: ship ${type} train state ${st}`);
        }
      }
    }
  }
});

test('start research: base free play keeps index <= 12 / 20 and nothing else', { skip }, () => {
  const records = parseMdb(dataReader(GOLD)('Infinite.mdb')!);
  for (const development of [0, 1, 2]) {
    const m = applyFreePlay(records[1], { ...spDefaults(), development }, 1);
    const w = freePlayWorld(m, false);
    assert.ok(!w.addon);
    for (const race of [0, 1, 2]) {
      assert.equal(w.economy.players[race]!.costs.length, 30);
      assert.deepEqual(researchedSet(w, race), EXPECTED_BASE[development], `race ${race}, development ${development}`);
    }
  }
});

test('start research: add-on multiplayer applies the same table to humans and computer players', { skip }, () => {
  const base = parseMdb(dataReader(GOLD)('InfiniteAO.mdb')!)[0];
  const seats: Seat[] = [
    { kind: 'human', slot: 0, race: 2, name: 'A' },
    { kind: 'computer', race: 1 },
    { kind: 'human', slot: 1, race: 0, name: 'B' },
  ];
  for (const development of [0, 1, 2]) {
    const setup: GameSetup = { mode: 'random', seed: 5, sizeBits: 8, resources: 2, development, stock: 2, addon: true };
    const m = mpMission(base, setup, seats);
    const w = freePlayWorld(m, true, m.races);
    for (const race of [0, 1, 2]) assert.deepEqual(researchedSet(w, race), EXPECTED_AO[development], `race ${race}, development ${development}`);
  }
});

test('start research: add-on campaign levels add 30..32, disabled objects mark their invention', { skip }, () => {
  // PimmonsAO 1: Pimmons L7, Sajiki L10, both R[0-3] -> 0..7 / 0..10 plus 30, 31
  {
    const { world: w } = loadAddonMission('PimmonsAO.mdb', 1, GOLD, false);
    assert.deepEqual(researchedSet(w, 1), [...range(0, 7), 30, 31]);
    assert.deepEqual(researchedSet(w, 2), [...range(0, 10), 30, 31]);
  }
  // AmazonsAO 3: Sajiki L21 also gets 32
  {
    const { world: w } = loadAddonMission('AmazonsAO.mdb', 3, GOLD, false);
    assert.deepEqual(researchedSet(w, 2), [...range(0, 21), 30, 31, 32]);
    assert.deepEqual(researchedSet(w, 0), [...range(0, 11), 30, 31]);   // R[0-11,30-31], level 0
  }
  // AmazonsAO 0: harbour 62 disabled -> its invention 31 counts as researched; no level, no 30
  {
    const { world: w } = loadAddonMission('AmazonsAO.mdb', 0, GOLD, false);
    assert.deepEqual(researchedSet(w, 0), [0, 1, 2, 6, 31]);
    const t = w.economy.towns.find(x => x.race === 0)!;
    assert.equal(w.logistics.menuState(t, HARBOUR), -1, 'the harbour stays disabled');
    assert.equal(w.logistics.menuState(t, SHIPYARD) === 2, true, 'the shipyard still needs research');
  }
});
