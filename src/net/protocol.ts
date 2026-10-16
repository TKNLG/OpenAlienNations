// Messages between browser clients and the server (JSON over WebSocket).
// Lockstep model: see docs/architecture/simulation.md and docs/architecture/multiplayer.md.

import type { Command } from '../engine/world.ts';

/** commands each client issues are executed this many ticks later (hides network latency) */
export const INPUT_DELAY_TICKS = 3;
/** clients report a state hash every this many ticks */
export const HASH_INTERVAL = 40;
/** races of a free-play session (Amazonen, Pimmons, Sajikis) */
export const RACES = 3;

export interface RoomInfo {
  id: string;
  name: string;
  host: string;
  /** `race`: the race the member has claimed in the lobby, -1 = none yet */
  players: { slot: number; name: string; race: number }[];
  /** most people that can join (the "Anzahl der Spieler" of the new-session screen) */
  maxPlayers: number;
  started: boolean;
  /** joining needs a password (the password itself never leaves the server) */
  locked: boolean;
  /** per race 0..2: what plays the race if no member claims it, chosen by the host:
   *  true = a computer player, false = nobody (our extension, docs/architecture/multiplayer.md) */
  computer: boolean[];
  /** what will be played: campaign mission or random map */
  setup: GameSetup;
}

export interface GameSetup {
  /** 'mission': a campaign map; 'random': generated map with seed */
  mode: 'mission' | 'random';
  campaign?: string;
  mission?: number;
  seed?: number;
  sizeBits?: number;
  /** free-play world parameters 0..2 (docs/ui/front-end.md 6): object density, research, stock */
  resources?: number;
  development?: number;
  stock?: number;
  /** Gold Edition island free play (InfiniteAO.mdb, docs/formats/addon.md 11.5: the AO flag of
   *  the original's start message) */
  addon?: boolean;
}

/** who plays a race in a started game. Humans carry their lockstep slot; computer players run
 *  inside every client's world (deterministic AI), so they need no slot and send nothing */
export type Seat =
  | { race: number; kind: 'human'; slot: number; name: string }
  | { race: number; kind: 'computer' }
  | { race: number; kind: 'empty' };

export type ClientMsg =
  | { t: 'hello'; name: string }
  | { t: 'list' }
  /** `password`: empty or absent = open session */
  | { t: 'create'; name: string; maxPlayers: number; setup: GameSetup; password?: string }
  | { t: 'join'; room: string; password?: string }
  | { t: 'leave' }
  /** claim a race in the lobby (-1 = give it back); refused if another member holds it */
  | { t: 'race'; race: number }
  /** host: computer player (true) or nobody (false) for each race no member claims */
  | { t: 'seats'; computer: boolean[] }
  | { t: 'start' }
  /** this player's commands for one tick (possibly empty) */
  | { t: 'cmds'; tick: number; cmds: Command[] }
  | { t: 'hash'; tick: number; hash: number }
  | { t: 'chat'; text: string };

/** machine-readable reason of an `error` the client reacts to */
export type ErrorCode = 'room' | 'full' | 'password' | 'race' | 'start';

export type ServerMsg =
  | { t: 'welcome'; id: string }
  | { t: 'rooms'; rooms: RoomInfo[] }
  | { t: 'room'; room: RoomInfo; you: number }
  | { t: 'left' }
  /** game starts: everyone uses the same setup; `players` = number of human slots, `you` = own
   *  slot; `seats` = one entry per race (random maps; mission games leave it empty) */
  | { t: 'start'; setup: GameSetup; players: number; you: number; seats: Seat[] }
  /** one player's commands for a tick, relayed to everyone (including the sender) */
  | { t: 'cmds'; slot: number; tick: number; cmds: Command[] }
  | { t: 'desync'; tick: number; hashes: Record<number, number> }
  | { t: 'gone'; slot: number }
  | { t: 'chat'; slot: number; name: string; text: string }
  | { t: 'error'; message: string; code?: ErrorCode };
