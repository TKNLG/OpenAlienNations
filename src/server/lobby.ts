// Lobby + lockstep relay. The server never simulates: it groups players into rooms, keeps the
// race each member has claimed and the host's computer-player choices, starts the game for
// everyone at once, relays each player's per-tick command batches to all players, and compares
// state hashes to detect desyncs. Spec: docs/architecture/multiplayer.md.

import type { WsConnection } from './ws.ts';
import { RACES, type ClientMsg, type ServerMsg, type RoomInfo, type GameSetup, type Seat, type ErrorCode } from '../net/protocol.ts';

interface Client { id: string; name: string; ws: WsConnection; room: Room | null; slot: number; race: number; }

interface Room {
  id: string;
  name: string;
  host: Client;
  maxPlayers: number;
  setup: GameSetup;
  /** empty = open; never sent to anyone and never logged */
  password: string;
  /** per race: computer player (true) or nobody (false) when no member claims it */
  computer: boolean[];
  members: Client[];
  started: boolean;
  hashes: Map<number, Map<number, number>>; // tick -> slot -> hash
}

/** an error the client gets as `{ t: 'error', code, message }` */
class LobbyError extends Error {
  code: ErrorCode;
  constructor(code: ErrorCode, message: string) { super(message); this.code = code; }
}

let nextId = 1;

export class Lobby {
  private clients = new Set<Client>();
  private rooms = new Map<string, Room>();

  connect(ws: WsConnection): void {
    const c: Client = { id: `p${nextId++}`, name: 'Spieler', ws, room: null, slot: -1, race: -1 };
    this.clients.add(c);
    ws.onMessage = text => {
      let msg: ClientMsg;
      try { msg = JSON.parse(text) as ClientMsg; } catch { return; }
      try { this.handle(c, msg); } catch (err) {
        if (err instanceof LobbyError) this.send(c, { t: 'error', code: err.code, message: err.message });
        else this.send(c, { t: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    };
    ws.onClose = () => { this.leave(c); this.clients.delete(c); };
    this.send(c, { t: 'welcome', id: c.id });
  }

  private send(c: Client, m: ServerMsg): void { c.ws.send(JSON.stringify(m)); }
  private broadcast(r: Room, m: ServerMsg): void { const s = JSON.stringify(m); for (const c of r.members) c.ws.send(s); }

  private info(r: Room): RoomInfo {
    return {
      id: r.id, name: r.name, host: r.host.name, maxPlayers: r.maxPlayers, started: r.started, setup: r.setup,
      locked: r.password !== '', computer: [...r.computer],
      players: r.members.map(m => ({ slot: m.slot, name: m.name, race: m.race })),
    };
  }

  /** every member gets the new room state */
  private update(r: Room): void { for (const p of r.members) this.send(p, { t: 'room', room: this.info(r), you: p.slot }); }

  private handle(c: Client, m: ClientMsg): void {
    switch (m.t) {
      case 'hello':
        c.name = String(m.name).slice(0, 24) || 'Spieler';
        if (c.room && !c.room.started) this.update(c.room);
        break;
      case 'list':
        this.send(c, { t: 'rooms', rooms: [...this.rooms.values()].filter(r => !r.started).map(r => this.info(r)) });
        break;
      case 'create': {
        this.leave(c);
        const r: Room = {
          id: `r${nextId++}`, name: String(m.name).slice(0, 40) || 'Spiel', host: c,
          maxPlayers: Math.max(1, Math.min(8, m.maxPlayers | 0)), setup: m.setup,
          password: typeof m.password === 'string' ? m.password.slice(0, 64) : '',
          computer: Array.from({ length: RACES }, () => false),
          members: [], started: false, hashes: new Map(),
        };
        this.rooms.set(r.id, r);
        this.addTo(r, c);
        break;
      }
      case 'join': {
        const r = this.rooms.get(m.room);
        if (!r || r.started) throw new LobbyError('room', 'Raum nicht verfügbar');
        if (r.members.includes(c)) return;
        if (r.password !== '' && (typeof m.password !== 'string' || m.password !== r.password)) throw new LobbyError('password', 'Falsches Passwort');
        if (r.members.length >= r.maxPlayers) throw new LobbyError('full', 'Raum ist voll');
        this.leave(c);
        this.addTo(r, c);
        break;
      }
      case 'leave':
        this.leave(c);
        this.send(c, { t: 'left' });
        break;
      case 'race': {
        const r = c.room;
        if (!r || r.started) return;
        const race = m.race | 0;
        if (race === c.race) { this.update(r); return; }
        if (race < -1 || race >= RACES) throw new LobbyError('race', 'Unbekanntes Volk');
        if (race >= 0 && r.members.some(p => p !== c && p.race === race)) {
          this.send(c, { t: 'room', room: this.info(r), you: c.slot });
          throw new LobbyError('race', 'Volk schon vergeben');
        }
        c.race = race;
        this.update(r);
        break;
      }
      case 'seats': {
        const r = c.room;
        if (!r || r.host !== c || r.started || !Array.isArray(m.computer)) return;
        for (let i = 0; i < RACES; i++) r.computer[i] = m.computer[i] === true;
        this.update(r);
        break;
      }
      case 'start': {
        const r = c.room;
        if (!r || r.host !== c || r.started) return;
        const seats = r.setup.mode === 'random' ? this.seats(r) : [];
        r.started = true;
        r.members.forEach((p, i) => { p.slot = i; });
        for (const s of seats) if (s.kind === 'human') s.slot = r.members.findIndex(p => p.race === s.race);
        for (const p of r.members) this.send(p, { t: 'start', setup: r.setup, players: r.members.length, you: p.slot, seats });
        break;
      }
      case 'cmds': {
        const r = c.room;
        if (!r || !r.started) return;
        this.broadcast(r, { t: 'cmds', slot: c.slot, tick: m.tick | 0, cmds: Array.isArray(m.cmds) ? m.cmds : [] });
        break;
      }
      case 'hash': {
        const r = c.room;
        if (!r || !r.started) return;
        let at = r.hashes.get(m.tick);
        if (!at) { at = new Map(); r.hashes.set(m.tick, at); }
        at.set(c.slot, m.hash >>> 0);
        if (at.size === r.members.length) {
          if (new Set(at.values()).size > 1) this.broadcast(r, { t: 'desync', tick: m.tick, hashes: Object.fromEntries(at) });
          r.hashes.delete(m.tick);
        }
        break;
      }
      case 'chat':
        if (c.room) this.broadcast(c.room, { t: 'chat', slot: c.slot, name: c.name, text: String(m.text).slice(0, 300) });
        break;
    }
  }

  /** who plays each race; throws unless every member has a race and at least two races play */
  private seats(r: Room): Seat[] {
    if (r.members.some(p => p.race < 0)) throw new LobbyError('start', 'Nicht alle Spieler haben ein Volk gewählt');
    const seats: Seat[] = [];
    for (let race = 0; race < RACES; race++) {
      const p = r.members.find(q => q.race === race);
      seats.push(p ? { race, kind: 'human', slot: p.slot, name: p.name } : { race, kind: r.computer[race] ? 'computer' : 'empty' });
    }
    if (seats.filter(s => s.kind !== 'empty').length < 2) throw new LobbyError('start', 'Mindestens zwei Völker müssen mitspielen');
    return seats;
  }

  private addTo(r: Room, c: Client): void {
    c.room = r;
    c.slot = r.members.length;
    c.race = -1;
    r.members.push(c);
    this.update(r);
  }

  private leave(c: Client): void {
    const r = c.room;
    if (!r) return;
    r.members = r.members.filter(m => m !== c);
    c.room = null;
    c.race = -1;
    if (r.started) this.broadcast(r, { t: 'gone', slot: c.slot });
    if (r.members.length === 0) { this.rooms.delete(r.id); return; }
    if (r.host === c) r.host = r.members[0];
    if (!r.started) {
      r.members.forEach((p, i) => { p.slot = i; });
      this.update(r);
    }
  }
}
