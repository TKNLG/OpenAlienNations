// Client-side lockstep driver. Spec: docs/architecture/multiplayer.md
//
// Every tick T, each client sends the commands its player issued, to be executed at
// T + INPUT_DELAY_TICKS. A client may only simulate tick T once it holds the batches of all
// players for T. Commands are applied in slot order, so all clients stay identical.

import type { World, Command } from '../engine/world.ts';
import { INPUT_DELAY_TICKS, HASH_INTERVAL, type ClientMsg, type ServerMsg } from './protocol.ts';

export class Lockstep {
  readonly world: World;
  readonly slot: number;
  private players: number;
  private send: (m: ClientMsg) => void;
  private batches = new Map<number, Map<number, Command[]>>(); // tick -> slot -> cmds
  private gone = new Set<number>();
  private local: Command[] = [];
  private sentUpTo: number;
  /** set when the server reports diverging state hashes */
  desync: { tick: number; hashes: Record<number, number> } | null = null;

  /** race controlled by each slot (commands carry the race as player id) */
  private slotRace: number[];

  constructor(world: World, slot: number, players: number, send: (m: ClientMsg) => void, slotRace?: number[]) {
    this.slotRace = slotRace ?? Array.from({ length: players }, (_, i) => i);
    this.world = world;
    this.slot = slot;
    this.players = players;
    this.send = send;
    this.sentUpTo = world.tick + INPUT_DELAY_TICKS; // ticks up to here have implicit empty batches
  }

  /** queue a command issued by the local player; it is sent with the next batch */
  issue(cmd: Command): void { this.local.push({ ...cmd, player: this.slotRace[this.slot] }); }

  receive(m: ServerMsg): void {
    if (m.t === 'cmds') {
      let at = this.batches.get(m.tick);
      if (!at) { at = new Map(); this.batches.set(m.tick, at); }
      at.set(m.slot, m.cmds);
    } else if (m.t === 'gone') {
      this.gone.add(m.slot);
    } else if (m.t === 'desync') {
      this.desync = { tick: m.tick, hashes: m.hashes };
    }
  }

  /** true when every player's commands for the next tick are known */
  canStep(): boolean {
    const t = this.world.tick + 1;
    if (t <= INPUT_DELAY_TICKS) return true;
    const at = this.batches.get(t);
    for (let s = 0; s < this.players; s++) if (!this.gone.has(s) && !at?.has(s)) return false;
    return true;
  }

  /** send this client's batch for the tick that is INPUT_DELAY_TICKS ahead (once per tick) */
  flush(): void {
    const target = this.world.tick + 1 + INPUT_DELAY_TICKS;
    while (this.sentUpTo < target) {
      this.sentUpTo++;
      const cmds = this.sentUpTo === target ? this.local.splice(0) : [];
      this.send({ t: 'cmds', tick: this.sentUpTo, cmds });
    }
  }

  /** advance one tick if possible; returns false while waiting for other players */
  step(): boolean {
    this.flush();
    if (!this.canStep()) return false;
    const t = this.world.tick + 1;
    const at = this.batches.get(t);
    if (at) {
      for (let s = 0; s < this.players; s++) {
        for (const c of at.get(s) ?? []) this.world.schedule({ ...c, player: this.slotRace[s] }, t);
      }
      this.batches.delete(t);
    }
    this.world.step();
    if (this.world.tick % HASH_INTERVAL === 0) this.send({ t: 'hash', tick: this.world.tick, hash: this.world.hash() });
    return true;
  }
}
