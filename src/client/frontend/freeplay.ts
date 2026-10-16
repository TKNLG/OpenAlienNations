// Free-play ("Endlosspiel" / "Erschaffe eine Welt") parameters and their mapping onto the
// Infinite.mdb record. Spec: docs/ui/front-end.md 6.

import type { Mission } from '../../formats/mission.ts';
import type { GameSetup, Seat } from '../../net/protocol.ts';
import type { Campaign } from '../data.ts';

/** Infinite.mdb (mode 4): record 0..2 = free play with race 0..2 as the human, 3 = multiplayer */
export const FREEPLAY_CAMPAIGN: Campaign = { id: 'infinite', label: 'Endlosspiel', mdb: 'Infinite.mdb', mapPrefix: '' };

export interface FreePlayParams {
  /** 0 Klein, 1 Mittel, 2 Groß */
  size: number;
  /** 0 Wenig, 1 Mittel, 2 Viel (object density for the world populator) */
  resources: number;
  /** 0 Niedrig, 1 Mittel, 2 Hoch */
  development: number;
  /** 0 Niedrig, 1 Mittel, 2 Hoch */
  stock: number;
  /** multiplayer only: 2..3 */
  players: number;
  /** Gold Edition: island free play (InfiniteAO.mdb, docs/formats/addon.md 11.4) */
  addon?: boolean;
}

/** 6.1 defaults */
export const spDefaults = (): FreePlayParams => ({ size: 1, resources: 2, development: 0, stock: 0, players: 2 });
export const mpDefaults = (): FreePlayParams => ({ size: 1, resources: 2, development: 2, stock: 2, players: 2 });

/** size bits per world size: 128, 256, 512 cells (6.2) */
export const SIZE_BITS = [7, 8, 9];
const STOCK_GOLD = [300, 3000, 10000], STOCK_GOODS = [15, 20, 25];
const RESEARCH_LEVEL = [0, 12, 20];

/** a fresh terrain seed. The original draws 0..32767; we use 31 bits from the browser's CSPRNG */
export function randomSeed(): number {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0] & 0x7fffffff;
}

/**
 * The free-play record with the menu overrides applied (6.2): size bits, seed, stock (start gold
 * and goods 0..5 of the first town-hall column in all three race blocks) and development
 * (research level 12 / 20 for every player, in addition to the record's own level).
 */
export function applyFreePlay(base: Mission, p: FreePlayParams, seed: number): Mission {
  return {
    ...base,
    seed,
    resources: p.resources,
    sizeBits: SIZE_BITS[p.size] ?? 8,
    races: base.races.map(r => ({
      ...r,
      gold: STOCK_GOLD[p.stock],
      startGoods: r.startGoods.map((g, i) => (i <= 5 ? [STOCK_GOODS[p.stock], g[1]] : [g[0], g[1]]) as [number, number]),
      researchLevel: Math.max(r.researchLevel, RESEARCH_LEVEL[p.development]),
    })),
  };
}

/**
 * The record of a multiplayer free-play game, built by every client from the start message alone
 * (docs/architecture/multiplayer.md "Start"): record 0 of Infinite.mdb / InfiniteAO.mdb (`base`)
 * with the host's world parameters (6.2), no mission goals (the last survivor wins), and the race
 * blocks set from the seats: a human or computer seat is present (computer flag set for computer
 * seats), an empty seat is absent. The record's own human/computer flags are ignored, so all
 * clients build the identical World whatever race they play.
 */
export function mpMission(base: Mission, setup: GameSetup, seats: Seat[]): Mission {
  const p: FreePlayParams = { size: 1, resources: setup.resources ?? 2, development: setup.development ?? 2, stock: setup.stock ?? 2, players: 0 };
  const fp = applyFreePlay(base, p, setup.seed ?? 1);
  const kind = (race: number) => seats.find(s => s.race === race)?.kind ?? 'empty';
  const humans = slotRaces(seats);
  return {
    ...fp,
    sizeBits: setup.sizeBits ?? fp.sizeBits,
    goals: [],
    humanRace: humans[0] ?? -1,
    races: fp.races.map(r => ({ ...r, present: kind(r.race) !== 'empty', computer: kind(r.race) === 'computer' })),
  };
}

/** race of each human lockstep slot (slot order) */
export function slotRaces(seats: Seat[]): number[] {
  const humans = seats.filter((s): s is Extract<Seat, { kind: 'human' }> => s.kind === 'human').sort((a, b) => a.slot - b.slot);
  return humans.map(s => s.race);
}
