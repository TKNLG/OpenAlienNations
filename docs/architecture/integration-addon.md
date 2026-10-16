# Integrating the add-on ("AO") data and world generation

What exists after the add-on data/world-generation pass, and exactly what the integration step has to
add in `world.ts`, `main.ts`, `data.ts`, the renderer and the front end to run an AO campaign
mission and InfiniteAO free play. Spec: [../formats/addon.md](../formats/addon.md); ship / harbour
gameplay is [../game/addon.md](../game/addon.md) and not covered here.

## 1. What is implemented

| file | content |
|---|---|
| `src/formats/mission.ts` (additive) | `Mission.addon?` (+0xA50 >= 1); `preResearched` now 33 flags (30..32 = +0xF8..+0x100); `GoalType` 17..20 and `goalCell(p2)`; `MapObject.cargo?`; `DvmLayout`, `dvmLayout(mission)`, `parseDvmFile(buf, layout)` -> `{ objects, terrain: StoredTerrain \| null, extras, rest }`; `parseDvm` / `parseDvmExtras` take an optional layout (without it they behave exactly as before) |
| `src/formats/addon.ts` | `ruleFiles(addon)` (file names per mode), `mergeOdb/Od/Wdb/Tdb`, `loadRules(read, addon)` / `loadRulesAsync(read, addon)` -> `Rules { rules, objects, weapons, strings, inventions, tableWidth }`, `animalTypeCount(rules)`, `mapCreationOrder(objects, rules)` (reference ids of 8.4), constants `AddonType`, `AddonClass`, `AddonFlag`, `AddonString` |
| `src/world/addon-terrain.ts` | add-on class table (`AO_CLASS_TILESET`, `AO_CLASS_FIRST_TILE`, `AO_CLASS_ANIMATED`, `AO_TO_BASE_CLASS`, heights), `AddonTerrain` (a `Terrain` with `aoCls`, `island`, `addon: true`), `addonTerrainFromStored(stored)`, `aoPickTables`, run labelling `labelRuns` (9.3, exact label numbers), `labelLand`, `labelIslands`, `bodiesBySize`, `runsByLabel`, Gold cell flags `aoTerrainFlags` / `CellFlag` |
| `src/world/island-gen.ts` | `generateIslandTerrain(seed, bits, aoPickTables)` (9.1..9.4) |
| `src/world/island-populate.ts` | `populateIslands(terrain, rand, opt)` (10.1..10.5) and `generateIslandWorld(seed, bits, generate, opt)` (re-roll loop 9.5); results extend `PopulateResult` (`ok, objects, lists, starts, randState` + `failure`, `islands`, `beachSkips`); `generateIslandWorld` returns only successful results (`rerolls`, `escapes`, section 7) |
| `test/helpers/mission.ts` (additive) | `GOLD` / `HAS_GOLD` (env `AN_GOLD`), `dataReader(dir)` (case-insensitive), `rulesOf`, `addonPickTables`, `islandGenerator`, `loadAddonMission(mdb, order)` |
| `test/addon.test.ts` | 10 tests, see section 8 |

### Two class numberings

An `AddonTerrain` is a normal `Terrain` whose **`cls` is in base-game numbering** (the base class
that uses the same tile set: beach / `weg` -> `CLASS_PATH` 10, wiese -> 0, gelbgras -> 1, schnee
2, rock 3, waldboden 4, gruenwald 6, both water classes -> `CLASS_WATER` 11) and whose `tile` is
the variant inside that tile set. So `World`, `TerrainRenderer` and `Minimap` accept it
unchanged; `CLASS_TILESET[cls[i]] === AO_CLASS_TILESET[aoCls[i]]` for every cell (tested).
`aoCls` keeps the add-on class (0 beach, 2..7 land, 9 open sea, 10 coastal water) for the things
the base numbering cannot express: static open sea vs. animated coastal ring, beach (cell flag
0x10000), fish placement. `island` is the island-id grid of 8.5 (goal 19, add-on placement
rules).

## 2. `data.ts` (client)

```ts
import { loadRulesAsync, ruleFiles, type Rules } from '../formats/addon.ts';
import { parseDvmFile, dvmLayout, type DvmFile } from '../formats/mission.ts';

export const CAMPAIGNS_AO: Campaign[] = [
  { id: 'amazons-ao', label: 'Amazonen', mdb: 'AmazonsAO.mdb', mapPrefix: 'Amazon' },
  { id: 'pimmons-ao', label: 'Pimmons', mdb: 'PimmonsAO.mdb', mapPrefix: 'Pimmon' },
  { id: 'sajiki-ao', label: 'Sajiki', mdb: 'SajikisAO.mdb', mapPrefix: 'Sajiki' },
];
export const FREEPLAY_AO: Campaign = { id: 'infinite-ao', label: 'Endlosspiel', mdb: 'InfiniteAO.mdb', mapPrefix: '' };

// in GameData
addon: Rules | null = null;            // merged tables, loaded on first AO mission
addonSprites: SpriteArchive | null = null;
hasAddon = false;                      // Gold install: Addon.odb exists (probe once at start-up)

async loadAddon(): Promise<Rules> {
  if (this.addon) return this.addon;
  const read = async (p: string) => { try { return await fetchBytes(`Data/${p}`); } catch { return null; } };
  this.addon = await loadRulesAsync(read, true);
  this.addonSprites = await SpriteArchive.open('Data/Addon.gd');
  return this.addon;
}
/** rules / weapons / research for a mission (base tables unless m.addon) */
async tablesFor(m: Mission) {
  if (!m.addon) return { rules: this.rules, objects: this.objects, weapons: this.weapons, inventions: this.inventions };
  const a = await this.loadAddon();
  return { rules: a.rules, objects: a.objects!, weapons: a.weapons, inventions: a.inventions };
}
async mapFile(m: Mission): Promise<DvmFile | null> {
  if (!m.mapFile) return null;
  return parseDvmFile(await fetchBytes(`Data/${m.mapFile.replace(/\\/g, '/')}`), dvmLayout(m));
}
```

- The server already resolves names case-insensitively, so `Data/...` works for the Gold `data`
  folder and `Amazons/AO.idb`. `ruleFiles(true)` lists every file name.
- The strings: `loadRulesAsync` also merges `Addon.tdb` (ids 325..330) when present, in both modes
  (the front end's DV.tdb loader in `frontend/assets.ts` should merge it the same way with
  `mergeTdb`).
- Sprites: `Addon.od` objects reference only `Addon.gd` names, so `looks.ts` needs a second
  archive: resolve a sprite name in `dv.gd` first, then in `Addon.gd` (addon.md 3.1). The terrain
  sets are the same 15 `.os` files as in base games; nothing new to load.
- **Base tables in a Gold install.** The Gold `dv.odb` carries the new flag bits (0x10, 0x20, 0x40,
  0x80); with the GOG data the base game is unchanged.

## 3. `main.ts` `loadMission`

Replace the terrain/objects part with an AO branch (sketch, names as in the current file):

```ts
import { addonTerrainFromStored, aoPickTables } from '../world/addon-terrain.ts';
import { generateIslandTerrain } from '../world/island-gen.ts';
import { generateIslandWorld } from '../world/island-populate.ts';
import { animalTypeCount } from '../formats/addon.ts';

const tables = await this.data.tablesFor(m);
let terrain: Terrain, populated: PopulateResult | null = null, file: DvmFile | null = null;
if (m.addon && m.seed === -2) {                       // AO campaign: terrain stored in the map
  file = await this.data.mapFile(m);
  terrain = addonTerrainFromStored(file!.terrain!);
} else if (isGeneratedWorld(m)) {                    // Infinite / InfiniteAO (single player and multiplayer)
  // world/free-play.ts buildGeneratedWorld: generateIslandWorld (add-on) or generateWorld (base),
  // for a new game AND for a save (its populated objects are then dropped)
  const g = buildGeneratedWorld(m, { player, humans, hallOf, pick, aoPick, animalTypes: animalTypeCount(tables.rules) });
  terrain = g.terrain; populated = g.result;
  if (g.seed !== m.seed) this.mission = { ...m, seed: g.seed };
} else { /* existing base code */ }
const objs = populated ? populated.objects : file ? file.objects : await this.data.map(m);
const extras = populated ? { lists: populated.lists, camera: [0, 0], orders: [] } : file ? file.extras : await this.data.mapExtras(m);
// World gets tables.rules / tables.weapons, costs and prerequisites from tables.inventions (33 per race)
```

- A save is rebuilt through the whole re-roll chain, never from `generate(m.seed)` alone. The
  island builder re-rolls almost every start seed (19 of 20 measured), and saves before October
  2026 kept the menu's start seed (the front end replaced the game's record with the session's):
  loaded from `generate(start seed)` they showed another island under the saved objects and
  ground edits (water wedges through the land, trees in the sea). The chain from the start seed
  ends on the final seed, the chain from the final seed succeeds on its first try, so old and new
  saves both get the original terrain (test/save-addon.test.ts). The front end now keeps the
  game's own record (`missionData ??= session.mission`).
- A save of an AO mission must store `mission.addon` (it is in `missionData` already if the whole
  record is saved) so the restore takes the same branch and tables. `World.restore` replays the
  ground edits onto `cls` only; `aoCls` keeps the original class (only the water/beach distinction
  is read from it, which ground edits never change).
- **Loading screen** `LOADING_B`, briefing art `BRIEFINGSCREENAO` etc. for `m.addon` (addon.md
  3.2, 11.3); `ruleFiles(addon).loading` names the loading screen.
- Free-play start camera: as base (centre on the human's founder).

## 4. `world.ts` / engine

> **Done by the gameplay pass:** items 1 (cargo), 2 (ids: goals use entity `p1 + 1`), 3 (goals
> 17..20), 4 (ships on water) and 5 (mountain 290) below are implemented; see
> [integration-addon-gameplay.md](integration-addon-gameplay.md).

What `World.loadMap` already does right (checked against `mapCreationOrder` on AmazonsAO 0,
AmazonsAO 4, PimmonsAO 1, SajikisAO 8): the sequence of created objects is **identical** to
addon.md 8.4 (nature, town halls + founder + builder + 2 porters, other buildings with operator /
house porter / outpost archers, units), including the 17 house porters of SajikisAO 8.

Differences and additions needed:

1. **Ship cargo is not created** (addon.md 8.2, 8.4 step 5). After the units loop, before
   housing / orders:
   ```ts
   const ships: [Entity, MapObject][] = [];      // collect in the units loop: if (o.cargo) ships.push([u, o])
   for (const [ship, o] of ships) for (const type of o.cargo!) {
     const c = this.spawnUnit(o.group, type, Math.floor(ship.x / SUB), Math.floor(ship.y / SUB), ship.town);
     c.inside = ship.id;                         // "created inside the ship", belongs to its player / settlement
     const t = this.economy.town(ship.town); if (t) this.economy.joinTown(c, t);
   }
   ```
   (do not move cargo into houses; the passenger rules are the gameplay spec's.) Without this,
   AmazonsAO 4 (#318) and PimmonsAO 2 (#393) lose their goal objects.
2. **Object ids.** `nextId` starts at 1, the original at 0: goal object `#p1` (types 17/18) is
   **entity id `p1 + 1`** as long as nothing else is created first (the AO smoke test asserts
   `e.id === creationIndex + 1` for every entity). Either start `nextId` at 0 for new worlds or
   add 1 in the goal evaluator. Note the original reuses ids from a free list; for goals only the
   load-time ids matter.
3. **Goals 17..20** in `Economy.goalMet` (addon.md 7.2):
   ```ts
   case 17: { const e = host.get(g.p1 + 1); if (!e || !e.alive) return false;
              const [x, y] = goalCell(g.p2); return torusDist(cellX(e), cellY(e), x, y) <= g.p3; }
   case 18: { const e = host.get(g.p1 + 1); return !e || !e.alive || (e.oid & 0xffff) !== g.p2; }
   case 19: { let n = 0;                                   // own settlements on island p1
              for (const t of this.towns) if (t.alive && t.race === me && island[cell(t.x, t.y)] === g.p1)
                n += this.objects(me, t, g.p2, false);
              return n >= g.p3; }
   case 20: { const t = this.nthTown(me, g.p3); return !!t && t.stock[g.p1] <= g.p2; }
   ```
   `island` = `(terrain as AddonTerrain).island` (all zeros / absent on base terrains: goal 19 is
   then false). Torus distance: `max(|dx|,|dy|) + min(|dx|,|dy|) / 2`, both axes wrapped. The
   settlement position for goal 19 is the town's own position (`t.x, t.y`).
4. **Ships on water.** `blocked` marks every `CLASS_WATER` cell, so ships (class 14) stand on
   blocked cells and their path searches fail at the node limit: AmazonsAO 4 (11 warships) runs at
   about 30 ms per tick with the AI on, mostly in `findPath`. Ships need their own passability (water
   cells free, land blocked) and harbours/shipyards as the land-water interface; the gameplay spec
   decides the rules. Until then, skip `walk()` for units whose rule class is 14.
5. **Height thresholds** of AO missions (addon.md 1.2, 8.3): mountain 290 (cell flag 0x100), 250,
   130, sea level 120. `world.ts` uses `>= 250` for worn paths and the hill bands are elsewhere;
   in AO missions use 290 where the base uses 250 as the mountain limit.
6. **Beach = `CLASS_PATH`** in the engine numbering. `foundation()` and `wearPath()` skip re-tiling
   cells whose `cls` is already `CLASS_PATH`, so a foundation on beach does not set `pathFlag`.
   If beach should not count as a paved path, test `pathFlag[i]` instead of `cls === CLASS_PATH` in
   those two places; the visual result is the same (`weg` tiles).
7. Research tables now have 33 inventions in AO missions; `Economy.setupPlayers` already loops over
   the cost table and reads `preResearched[i]`, so 30..32 work as soon as `costs` come from
   `Rules.inventions`.
8. Gold cell flag 0x10000 (beach) and the area-test result 0x4000 (footprint without enough land)
   are add-on placement rules for harbour/shipyard (gameplay spec); `aoTerrainFlags` provides the
   terrain part of the flag word.
9. The group-6 rule of dvm.md (every group-6 record is nature whatever its class) is not applied by
   `loadMap` (`o.cls === 2`); no shipped map, base or AO, has a group-6 record with another class,
   so it has no effect today. `mapCreationOrder` applies it.

## 5. Renderer

Works unchanged (engine `cls` + `tile`). The one visible difference to the original: the open
sea (class 9) is animated like the coastal ring. To draw it static as the original does (addon.md
8.3 rendering note), in `TerrainRenderer.buildChunk`:

```ts
const ao = (t as Partial<AddonTerrain>).aoCls;
if (water === 15) {
  layers.fill(waterBase + t.tile[cv[0]]);
  // open sea: static wasser1 unless a corner belongs to the animated coastal ring
  anim = ao && cv.every(i => ao[i] === AO_CLASS_SEA) ? 0 : waterPerFrame;
}
```

Shoreline pieces (`water !== 0 && water !== 15`) only occur next to class-10 cells, which is what
the spec asks for. Mixed class-9/10 quads are treated as animated water (spec open point).

## 6. Front end

- Single-player menu: button `#326 "Addon Kampagnen"` at (230,380)-(565,410) -> race selection
  (`RASSENWAHLAO`) -> mission list (`MISSIONSAUSWAHL`) of `CAMPAIGNS_AO[race]`; progress counter per
  add-on campaign, which the rebuild should save (addon.md 11.6).
- World parameters: new row `#325 "Addon:"` (230,290)-(470,320) with `#205/#204` toggle; with it
  on, size Klein is not selectable (wraps to Mittel) and free play loads `InfiniteAO.mdb` (record =
  race) with `applyFreePlay` unchanged (`addon: true` survives the spread).
- Multiplayer: the start message carries the AO flag (`GameSetup.addon`) next to size and seed;
  clients run the same `generateIslandWorld` from the host's seed (the populator continues the
  terrain stream, so host and clients agree without a clock). See multiplayer.md "Add-on".
- Briefing layout for AO records: addon.md 11.3 table.

## 7. Deviations, interpretations and open points

Code review against `dvge.exe` (October 2026, addon.md 10 now states the exact rules). The
review found the deviations below in `island-populate.ts`; each one changed the `rand()` stream
(so every later object differed from the original for the same seed), the fourth one also the
amounts. **All are fixed** (October 2026, tests in `test/island-populate.test.ts`):

1. **Random island cell** (addon.md 10, `00490db0`), *fixed*: `islandRunIndex(k, runs)` takes run
   `k mod m` when the body owns the first entry of the run list (or k = 0), else `(k - 1) mod m`
   (land and open sea alike). Tested against a literal transcription of the walk on synthetic
   run lists for every k = 0..1023.
2. **10.2.1**, *fixed*: c0..c100 are picked and tested, the first fitting one of c0..c99 is
   taken, the builder fails after c100 even if it fits (scripted-stream test: c99 taken, c100
   fails after exactly 202 draws).
3. **10.2.2**, *fixed*: 51 picks per attempt (c0..c50), c50 is tested but never taken (scripted
   test: a fitting c50 is skipped, attempt 1's c0 becomes the first candidate).
4. **Beach in the cluster placer** (addon.md 10.3), *fixed*: acceptance draw, 0x17E test, weight
   draws, choice and decrement of the kind happen as usual; on a beach cell nothing is created
   (no type or constructor draw). `IslandPopulateResult.beachSkips` counts these per kind (test:
   on an all-beach synthetic world the clusters count trees, animals, bushes and stones but place
   no land object).
5. **Animal constructor draws**, *fixed*: two draws after the type (`% 3` wander job, then
   `% 40 + 1` delay; world-populate.md 5.1), in `island-populate.ts` and in the base
   `populate.ts` (no base test encoded populate output, so no expectation changed).
6. 10.2.2's "more than 8 candidates" counting only step 2's own candidates is correct (C).
7. **Fish** draw no extra random number on creation: correct (class 15, no constructor draw).
8. **10.4 fallback (128 maps only, not reachable from the menu)**, *fixed*: each attempt tests
   c0..c100 and stops at the first fit; the builder fails when c100 fits (counter = 100); when all
   101 fail the unfitting c100 is the candidate for the distance test; accepted second and third
   starts are inserted at the **front** of list 3 (slot 0 gets the third start, slot 2 the T(7)
   start). Our only addition: the T(7) search for the first start (no limit in the original) fails
   the builder after 1,000,000 picks instead of hanging (`FALLBACK_T7_LIMIT`). Not covered by a
   test (reviewed only).

After the fixes the populator matches the analyst's transcription of the original rules object
by object (92 seed/size/resource combinations on 256 and 512 maps compared: same final seed, same
objects, same stream state). Start-island statistics with the fixed populator (seeds 1..100 on
256 maps, 1..30 on 512; slot 0 / 1 / 2; "stone" = units in stone objects on the island):

| map, r | median land cells | median stone | no stone patch | at most one | stone < 100 |
|---|---|---|---|---|---|
| 256, Wenig | 7401 / 4707 / 3197 | 320 / 180 / 102 | 4 / 7 / 9 % | 6 / 18 / 24 % | 8 / 25 / 50 % |
| 256, Mittel | same | 556 / 364 / 204 | 0 / 2 / 5 % | 1 / 7 / 21 % | 3 / 7 / 23 % |
| 256, Viel | same | 1072 / 658 / 366 | 0 / 0 / 3 % | 0 / 6 / 14 % | 0 / 5 / 10 % |
| 512, Wenig | 23227 / 13035 / 8431 | 1080 / 534 / 260 | 0 / 0 / 3 % | 0 / 0 / 3 % | 0 / 0 / 13 % |
| 512, Viel | same | 3644 / 1872 / 1022 | 0 | 0 | 0 |

(256 maps: 17.5 re-rolls per seed on average for seeds 1..100; smallest start island 2225 cells.
The addon.md 10.2 table differs in detail (other seed set or an earlier variant); its
shape is the same.)

Everything else of 9.1..10.5 in the code matches the C reading: F/S budgets and the "stop when
either is 0" loop, the `k` switch with its `rand() % 25` gates, cluster counts and spreads, T(9)
and T(4) footprints and border range, list handling, fish counts and order, the re-roll seed
`rand()` from the populator's stream, slot order of the starts and the 6 x 6 placement search.
Between the terrain generator and the populator the original draws no random numbers (checked:
none of the functions called in between reaches `rand()`), so continuing the terrain stream is
right.

**How the island generator is validated.** Only by reading the code: the self-tests (section 8)
check determinism and the structural rules, not output of the original. The stored campaign
maps cannot serve as a reference: a search over all 32768 seeds (land mask of 9.2 against each
of the 28 maps of size 128 and 256) found no seed with better than about 90 % agreement on a
128 map and 87 % on a 256 map, about what any island map scores against a sea-heavy one; the
maps were not made from a 15-bit seed of this generator, or were reworked by hand. A strong check
is possible with an **original savegame** of an add-on free game: the savegame writes the whole
cell array (`0044fea0`: size, mask, then n x n x 8 bytes with height, tile and class) and all
objects. From the heights the terrain seed can be found by brute force over 0..32767 (exact
height match), which then checks 9.1..9.4 and the tile choice cell by cell, and the nature
objects of a save made right at the start check the populator object by object. In multiplayer
the host also sends the final seed (5-byte message `0xFD` + seed), which a capture could provide.

- **Stored terrain stream**: for seed -2 nothing is generated; `randState` is taken as
  `srand(-2)` with no draws (inferred; only facings and AI draws follow from it).
- **Re-roll and cycles (our deviation, fixed October 2026)**: `generateIslandWorld` follows the
  original chain `seed = rand()` without a limit (addon.md 9.5) and **never returns a failed
  result**. 512 maps need no re-roll for most seeds (50..110 ms); 256 maps re-roll often (17.5
  times on average for seeds 1..100). 0.12 % of 256-map start seeds (e.g. 1003, 1214, 2016, 3345)
  run into one of the two 3-seed cycles of failing seeds, where the original hangs. Ours: when
  the next seed of the chain was already tried in this call, it continues with the escape seed
  `(seed0 + j) & 0x7FFFFFFF` (seed0 = start seed, j = 1, 2, ... escapes, skipping tried seeds)
  and follows the original chain from there. Chains without a cycle are exactly the original's.
  The function is pure in (seed, size, options), so multiplayer clients (which all run it from
  the host's seed) reach the same final seed, and `main.ts` stores the final seed in the mission
  so a save rebuilds the same terrain. Measured: 1003 -> 1004, 1214 -> 26957, 2016 -> 2017,
  3345 -> 30723, one escape each, about 120 ms. The function only throws (no world at all) if
  100,000 seeds fail, which the menu options cannot cause. The base `generateWorld` got the same
  treatment (it returned the failed result after 20 tries; never observed on 300 seeds).
- **SajikisAO 2 "Insel-Beschlagnahmung" cannot be won as specified.** Its win goals are
  `19(island 1, type 52, 1)`, `19(2, 52, 2)`, `19(2, 63, 1)`. With the labelling of 9.3 the map's
  islands are 4 (home island, 14058 cells), **2** (the Pimmon supply base, 2601 cells, matching the
  briefing's "2 kleine Außenposten, eine Werft") and 22 (115 cells); label 1 (the run at x = 0 of
  row 0) is merged into 2 by the horizontal wrap pass, so no cell has island id 1 and the first
  goal is never true. No variant of the merge directions produces both ids 1 and 2 either. Either
  the original's island grid differs from 9.3 or the record has a data bug (the 3.03 patch lists a
  fix for this mission). Needs a check against the original before relying on goal 19.
- SajikisAO 8 goal ids and SajikisAO 4's win/lose sense: as in addon.md 7.3 (the data resolves
  #3563..3571 to the outpost/house objects, the patrol ships are #3580..3588; tested).
- Terrain light for AO maps uses `computeLight` (not bit-exact, as for base terrain).
- `Addon.tdb` is merged in base mode too (as the original); with GOG data it is simply absent.

## 8. Tests (`test/addon.test.ts`, data from `AN_GOLD`, skipped without it)

1. AO `.mdb` files: flag, seeds, sizes, 33 preset flags, research levels, disabled pairs, goal
   parameters of types 17..20; base files stay `addon: false` with zero flags 30..32.
2. All 32 AO maps parse to the last byte; records, nature/buildings/units, cargo lengths, list
   sizes, camera and orders equal the addon.md 8.6 table; 25,482 records with z = stored height
   in all but 28; the two unreferenced files with their special layouts.
3. Stored terrain: water flat at 120 and land above, class 10 exactly on the coastal ring,
   classes 1/8 unused, engine class keeps the tile set, sea share and island sizes as in 8.6.
4. Run labelling equals a literal list-relabelling transcription of 9.3 (same label numbers) on
   ten maps and on a synthetic torus case; the SajikisAO 2 island ids above.
5. Rules merge: types 62..67 per race, nature 39..51, 31 new records, Pimmon shipyard 3 x 2,
   weapons 21..27, 49 new OD objects, strings 325..330, AO.idb = DV.idb + 3, animal count 5 / 7.
6. Creation order: every goal object id of addon.md 7.3 resolves to the described object.
7. Smoke: AmazonsAO 0 in the existing `World` (ids = creation index + 1, 300 ticks with AI).
8. Island generator determinism (terrain hashes, objects, lists, stream state).
9. Island world constraints on 256 and 512 maps: 9.4 class rules, one ocean, island grid = labels,
   three starts on the three largest islands, one object per cell, nature off water / beach /
   mountains, fish only in open sea, no base trees or rubble, lists filled.
10. Generation time for five 512 maps (logged; average must stay below 1.5 s, measured 55..110 ms).
11. `test/island-populate.test.ts`: random-cell walk vs `islandRunIndex` on synthetic run lists;
    10.2.1 (c99 taken, c100 fails) and 10.2.2 (c50 never taken) with a scripted `rand()` on a
    synthetic four-island 256 map; beach counting (10.3) on an all-beach synthetic map; cycling
    seeds 1003, 1214, 2016, 3345 give valid, deterministic worlds equal to the world of their final
    seed, and a non-cycling seed uses no escape.
