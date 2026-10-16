// Terrain and start objects of a map without a map file: free play (Infinite.mdb, island free play
// InfiniteAO.mdb) and multiplayer random maps (docs/formats/world-populate.md, docs/formats/addon.md
// 9, 10). One function for starting a game and for loading a save, so both build the same terrain.
//
// The world builder re-rolls the seed until the populator succeeds (island maps almost always do).
// A save keeps the final seed in its mission record, but saves written before October 2026 kept the
// menu's start seed. Both lead to the same world: from the start seed the re-roll chain is
// deterministic and ends on the final seed, from the final seed the first try succeeds. A save is
// therefore always rebuilt through the whole chain, never from `generate(seed)` alone.

import type { Mission } from '../formats/mission.ts';
import { generateTerrain, type Terrain } from './terrain.ts';
import { generateWorld, type PopulateResult } from './populate.ts';
import { generateIslandTerrain } from './island-gen.ts';
import { generateIslandWorld } from './island-populate.ts';

export type HallSize = { sizeX: number; sizeY: number; radius: number };

export interface FreePlayOptions {
  /** the local player's race (its town hall is the populator's default footprint) */
  player: number;
  /** multiplayer: race of each human slot (every client builds the same world) */
  humans?: number[];
  /** town hall footprint and town radius of a race (rules), undefined when unknown */
  hallOf: (race: number) => HallSize | undefined;
  /** base tile lookups per class (CLASS_TILESET order) */
  pick: Uint8Array[];
  /** add-on tile lookups per add-on class (aoPickTables); needed for add-on records */
  aoPick?: Uint8Array[];
  /** behaviour-class-7 nature records of the merged rules (animalTypeCount) */
  animalTypes?: number;
}

/** a record whose terrain comes from the world builder (no map file, a resource setting or add-on) */
export function isGeneratedWorld(m: Mission): boolean {
  return !m.mapFile && (m.addon ? m.seed !== -2 : m.resources !== undefined);
}

/**
 * Terrain, start objects and final seed of a generated world (`isGeneratedWorld`). The mission's
 * race flags are taken as they are unless `humans` names the human races (multiplayer).
 */
export function buildGeneratedWorld(m: Mission, o: FreePlayOptions): { terrain: Terrain; result: PopulateResult; seed: number } {
  const races = m.races.map(r => (o.humans ? { ...r, computer: r.present && !o.humans.includes(r.race) } : r));
  const players = races.filter(r => r.present).map(r => ({ race: r.race, computer: r.computer, hall: o.humans && o.hallOf(r.race) }));
  const common = { players, network: !!o.humans, hall: o.hallOf(o.player), humanTownHall: false };
  if (m.addon) {
    const aoPick = o.aoPick;
    if (!aoPick) throw new Error('buildGeneratedWorld: add-on tile sets missing');
    const g = generateIslandWorld(m.seed, m.sizeBits, (s, b) => generateIslandTerrain(s, b, aoPick), {
      ...common, resources: m.resources ?? 2, animalTypes: o.animalTypes,
    });
    return { terrain: g.terrain, result: g.result, seed: g.seed };
  }
  const g = generateWorld(m.seed, m.sizeBits, (s, b) => generateTerrain(s, b, o.pick), { ...common, resources: m.resources ?? 2 });
  return { terrain: g.terrain, result: g.result, seed: g.seed };
}
