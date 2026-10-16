// End-to-end lockstep tests: real server (lobby + WebSocket), real WebSocket clients, each
// running its own World. All must end in the same state although they issue different commands
// at different times. Also: lobby rules (passwords, race claims, computer seats, starting before
// the session is full) and multiplayer free-play worlds with computer players (AN_DATA) and on
// islands (AN_GOLD). Spec: docs/architecture/multiplayer.md.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { existsSync } from 'node:fs';
import { acceptUpgrade } from '../src/server/ws.ts';
import { Lobby } from '../src/server/lobby.ts';
import { World, Kind } from '../src/engine/world.ts';
import { Lockstep } from '../src/net/lockstep.ts';
import type { ServerMsg, ClientMsg, GameSetup, Seat } from '../src/net/protocol.ts';
import { generateTerrain, CLASS_TILESET, type Terrain } from '../src/world/terrain.ts';
import { generateWorld } from '../src/world/populate.ts';
import { generateIslandWorld } from '../src/world/island-populate.ts';
import { parseMdb } from '../src/formats/mission.ts';
import { parseOs } from '../src/formats/os.ts';
import { animalTypeCount } from '../src/formats/addon.ts';
import { mpMission, slotRaces } from '../src/client/frontend/freeplay.ts';
import { DATA, GOLD, HAS_GOLD, dataReader, rulesOf, islandGenerator } from './helpers/mission.ts';

function flatTerrain(bits: number): Terrain {
  const n = 1 << bits;
  return { sizeBits: bits, size: n, height: new Uint16Array(n * n).fill(128), cls: new Uint8Array(n * n), tile: new Uint8Array(n * n) };
}

const units = [
  { cls: 0, group: 0, type: 9, owner: 1, x: 5, y: 5, z: 0 },
  { cls: 0, group: 0, type: 9, owner: 1, x: 6, y: 5, z: 0 },
  { cls: 0, group: 1, type: 9, owner: 2, x: 40, y: 40, z: 0 },
];

class TestClient {
  ws: WebSocket;
  inbox: ServerMsg[] = [];
  ls: Lockstep | null = null;
  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.onmessage = ev => {
      this.seen += String(ev.data);
      const m = JSON.parse(String(ev.data)) as ServerMsg;
      if (this.ls) this.ls.receive(m); else this.inbox.push(m);
      if (m.t === 'start') this.inbox.push(m);
    };
  }
  opened(): Promise<void> { return new Promise(r => { this.ws.onopen = () => r(); }); }
  send(m: ClientMsg): void { this.ws.send(JSON.stringify(m)); }
  async waitFor<T extends ServerMsg['t']>(t: T): Promise<Extract<ServerMsg, { t: T }>> {
    for (let i = 0; i < 400; i++) {
      const k = this.inbox.findIndex(m => m.t === t);
      if (k >= 0) return this.inbox.splice(k, 1)[0] as Extract<ServerMsg, { t: T }>;
      await new Promise(r => setTimeout(r, 5));
    }
    throw new Error(`timeout waiting for ${t}`);
  }
  /** the next message of type `t` that satisfies `ok` (earlier ones of that type are dropped) */
  async waitWhere<T extends ServerMsg['t']>(t: T, ok: (m: Extract<ServerMsg, { t: T }>) => boolean): Promise<Extract<ServerMsg, { t: T }>> {
    for (;;) {
      const m = await this.waitFor(t);
      if (ok(m)) return m;
    }
  }
  /** everything received so far, as one JSON text (to check what never reaches a client) */
  seen = '';
}

async function startServer(): Promise<{ server: Server; url: string }> {
  const lobby = new Lobby();
  const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
  server.on('upgrade', (req, socket: Socket) => { const ws = acceptUpgrade(req, socket); if (ws) lobby.connect(ws); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  return { server, url: `ws://127.0.0.1:${(server.address() as { port: number }).port}/ws` };
}

async function clients(url: string, names: string[]): Promise<TestClient[]> {
  const cs = names.map(() => new TestClient(url));
  await Promise.all(cs.map(c => c.opened()));
  cs.forEach((c, i) => c.send({ t: 'hello', name: names[i] }));
  return cs;
}

async function stop(server: Server, cs: TestClient[]): Promise<void> {
  for (const c of cs) c.ws.close();
  await new Promise<void>(r => server.close(() => r()));
}

/** step all lockstep clients to `target`; `orders(ls)` may issue commands before each step */
async function drive(ls: Lockstep[], target: number, orders: (l: Lockstep) => void = () => {}): Promise<void> {
  let guard = 0;
  while (ls.some(l => l.world.tick < target) && guard++ < 1_000_000) {
    let progressed = false;
    for (const l of ls) {
      if (l.world.tick >= target) continue;
      orders(l);
      if (l.step()) progressed = true;
    }
    if (!progressed) await new Promise(r => setTimeout(r, 1));
  }
}

test('two clients stay in sync through the server', { skip: typeof WebSocket === 'undefined' && 'no WebSocket client' }, async () => {
  const { server, url } = await startServer();
  const [a, b] = await clients(url, ['A', 'B']);
  a.send({ t: 'create', name: 'Test', maxPlayers: 2, setup: { mode: 'mission', campaign: 'test', mission: 0 } }); // no race claims needed
  const room = await a.waitFor('room');
  b.send({ t: 'join', room: room.room.id });
  await b.waitFor('room');
  a.send({ t: 'start' });
  const sa = await a.waitFor('start'), sb = await b.waitFor('start');
  assert.equal(sa.players, 2);

  for (const [c, s] of [[a, sa], [b, sb]] as const) {
    c.ls = new Lockstep(new World(flatTerrain(6), units), s.you, s.players, m => c.send(m));
    for (const m of c.inbox.splice(0)) c.ls.receive(m);
  }
  const la = a.ls!, lb = b.ls!;

  // drive both clients until both reach tick 600; issue orders at different moments
  const target = 900;
  let guard = 0;
  while ((la.world.tick < target || lb.world.tick < target) && guard++ < 100000) {
    if (la.world.tick === 10 && la.slot === 0) la.issue({ type: 'move', player: 0, ids: [1, 2], x: 30, y: 20 });
    if (lb.world.tick === 37) lb.issue({ type: 'move', player: 1, ids: [3], x: 3, y: 60 });
    let progressed = false;
    if (la.world.tick < target && la.step()) progressed = true;
    if (lb.world.tick < target && lb.step()) progressed = true;
    if (!progressed) await new Promise(r => setTimeout(r, 1));
  }
  assert.equal(la.world.tick, target);
  assert.equal(lb.world.tick, target);
  assert.equal(la.world.hash(), lb.world.hash(), 'worlds diverged');
  assert.equal(la.desync, null);
  const u1 = la.world.get(1)!, u3 = lb.world.get(3)!;
  // unit 1 may end one cell short: it squeezes past unit 2 standing on its path, and the re-plan's
  // arrival tolerance (units-and-jobs.md 4.1, 4.7) ends the walk there
  assert.ok(Math.abs(Math.floor(u1.x / 256) - 30) <= 1 && Math.abs(Math.floor(u1.y / 256) - 20) <= 1, 'unit 1 at its target');
  assert.equal(Math.floor(u3.y / 256), 60);

  await stop(server, [a, b]);
});

// ---------------------------------------------------------------- lobby rules

const RANDOM: GameSetup = { mode: 'random', seed: 77, sizeBits: 7, resources: 1, development: 2, stock: 2 };

test('lobby: password-protected session', { skip: typeof WebSocket === 'undefined' && 'no WebSocket client' }, async () => {
  const { server, url } = await startServer();
  const [a, b, c] = await clients(url, ['Anna', 'Bert', 'Carl']);
  a.send({ t: 'create', name: 'Geheim', maxPlayers: 3, setup: RANDOM, password: 'sesam öffne dich' });
  const room = (await a.waitFor('room')).room;
  assert.equal(room.locked, true);
  b.send({ t: 'list' });
  const listed = (await b.waitFor('rooms')).rooms.find(r => r.id === room.id)!;
  assert.equal(listed.locked, true, 'the session list marks protected sessions');
  // no password, wrong password: refused; the right one: in
  b.send({ t: 'join', room: room.id });
  assert.equal((await b.waitFor('error')).code, 'password');
  b.send({ t: 'join', room: room.id, password: 'sesam' });
  assert.equal((await b.waitFor('error')).code, 'password');
  b.send({ t: 'join', room: room.id, password: 'sesam öffne dich' });
  const joined = await b.waitFor('room');
  assert.equal(joined.room.players.length, 2);
  assert.equal(joined.you, 1);
  // an open session needs none
  c.send({ t: 'create', name: 'Offen', maxPlayers: 2, setup: RANDOM });
  assert.equal((await c.waitFor('room')).room.locked, false);
  await a.waitWhere('room', m => m.room.players.length === 2);
  for (const x of [a, b, c]) assert.ok(!x.seen.includes('sesam'), 'the password never reaches a client');
  await stop(server, [a, b, c]);
});

test('lobby: races, computer seats, start with 2 of 3', { skip: typeof WebSocket === 'undefined' && 'no WebSocket client' }, async () => {
  const { server, url } = await startServer();
  const [a, b] = await clients(url, ['Anna', 'Bert']);
  a.send({ t: 'create', name: 'Drei', maxPlayers: 3, setup: RANDOM });
  const id = (await a.waitFor('room')).room.id;
  b.send({ t: 'join', room: id });
  await b.waitFor('room');
  // no race yet: no start
  a.send({ t: 'start' });
  assert.equal((await a.waitFor('error')).code, 'start');
  a.send({ t: 'race', race: 1 });
  await b.waitWhere('room', m => m.room.players[0].race === 1);
  b.send({ t: 'race', race: 1 });
  assert.equal((await b.waitFor('error')).code, 'race', 'a race is claimed once');
  b.send({ t: 'race', race: 2 });
  await a.waitWhere('room', m => m.room.players[1].race === 2);
  // only the host sets computer seats
  b.send({ t: 'seats', computer: [true, false, false] });
  a.send({ t: 'seats', computer: [true, false, false] });
  const r = await b.waitWhere('room', m => m.room.computer[0]);
  assert.deepEqual(r.room.computer, [true, false, false]);
  assert.equal(r.room.players.length, 2, 'not full: maxPlayers 3, two members');
  a.send({ t: 'start' });
  const sa = await a.waitFor('start'), sb = await b.waitFor('start');
  assert.equal(sa.players, 2);
  assert.deepEqual([sa.you, sb.you], [0, 1]);
  const want: Seat[] = [
    { race: 0, kind: 'computer' },
    { race: 1, kind: 'human', slot: 0, name: 'Anna' },
    { race: 2, kind: 'human', slot: 1, name: 'Bert' },
  ];
  assert.deepEqual(sa.seats, want);
  assert.deepEqual(sb.seats, want);
  await stop(server, [a, b]);
});

test('lobby: one human needs a computer opponent', { skip: typeof WebSocket === 'undefined' && 'no WebSocket client' }, async () => {
  const { server, url } = await startServer();
  const [a] = await clients(url, ['Solo']);
  a.send({ t: 'create', name: 'Allein', maxPlayers: 2, setup: RANDOM });
  await a.waitFor('room');
  a.send({ t: 'race', race: 0 });
  await a.waitWhere('room', m => m.room.players[0].race === 0);
  a.send({ t: 'start' });
  assert.equal((await a.waitFor('error')).code, 'start', 'one race alone does not start');
  a.send({ t: 'seats', computer: [false, false, true] });
  await a.waitWhere('room', m => m.room.computer[2]);
  a.send({ t: 'start' });
  const st = await a.waitFor('start');
  assert.equal(st.players, 1);
  assert.deepEqual(st.seats.map(x => x.kind), ['human', 'empty', 'computer']);
  await stop(server, [a]);
});

// ---------------------------------------------------------------- free play with computer players

/** what loadMission (client/main.ts) builds for a multiplayer free-play start message; `local` =
 *  the race this client plays, which must not change the world */
function mpWorld(setup: GameSetup, seats: Seat[], local: number): World {
  const addon = !!setup.addon, data = addon ? GOLD : DATA, read = dataReader(data);
  const base = parseMdb(read(addon ? 'InfiniteAO.mdb' : 'Infinite.mdb')!)[0];
  const m = mpMission(base, setup, seats);
  const humans = slotRaces(seats);
  assert.ok(humans.includes(local));
  const rules = rulesOf(data, addon);
  const races = m.races.map(r => ({ ...r, computer: r.present && !humans.includes(r.race) }));
  const hallOf = (race: number) => { const h = rules.rules.get(((race << 16) | 40) >>> 0)!; return { sizeX: h.sizeX, sizeY: h.sizeY, radius: h.radius || 25 }; };
  const players = races.filter(r => r.present).map(r => ({ race: r.race, computer: r.computer, hall: hallOf(r.race) }));
  const opt = { resources: m.resources ?? 2, players, network: true, hall: hallOf(local), humanTownHall: false };
  const g = addon
    ? generateIslandWorld(m.seed, m.sizeBits, islandGenerator(GOLD), { ...opt, animalTypes: animalTypeCount(rules.rules) })
    : generateWorld(m.seed, m.sizeBits, (sd, b) => generateTerrain(sd, b, CLASS_TILESET.map(n => parseOs(read(`${n}.os`)!).pick)), opt);
  return new World(g.terrain, g.result.objects, rules.rules, {
    races, costs: rules.inventions.map(l => l.map(i => i.cost)), prerequisites: rules.inventions.map(l => l.map(i => i.prerequisites)),
    goals: m.goals, weapons: rules.weapons, orders: [], lists: g.result.lists,
  });
}

/** lobby -> start -> one World per client -> lockstep to `ticks`; returns the clients' lockstep drivers */
async function playMp(setup: GameSetup, ticks: number, ordered: (race: number, x: number, y: number) => void = () => {}): Promise<{ ls: Lockstep[]; seats: Seat[] }> {
  const { server, url } = await startServer();
  const [a, b] = await clients(url, ['Anna', 'Bert']);
  a.send({ t: 'create', name: 'KI', maxPlayers: 3, setup, password: 'x' });
  const id = (await a.waitFor('room')).room.id;
  b.send({ t: 'join', room: id, password: 'x' });
  await b.waitFor('room');
  a.send({ t: 'race', race: 2 });
  b.send({ t: 'race', race: 0 });
  a.send({ t: 'seats', computer: [false, true, false] });
  await a.waitWhere('room', m => m.room.players.every(p => p.race >= 0) && m.room.computer[1]);
  a.send({ t: 'start' });
  const starts = [await a.waitFor('start'), await b.waitFor('start')];
  const ls = [a, b].map((c, i) => {
    const s = starts[i];
    const races = slotRaces(s.seats);
    c.ls = new Lockstep(mpWorld(s.setup, s.seats, races[s.you]), s.you, s.players, m => c.send(m), races);
    for (const m of c.inbox.splice(0)) c.ls.receive(m);
    return c.ls;
  });
  // each human sends its founder somewhere at a different moment
  await drive(ls, ticks, l => {
    const w = l.world, race = slotRaces(starts[0].seats)[l.slot];
    if (w.tick !== 20 + 17 * l.slot) return;
    const f = w.entities.find(e => e.kind === Kind.Unit && (e.oid >>> 16) === race);
    if (!f) return;
    ordered(race, Math.floor(f.x / 256), Math.floor(f.y / 256));
    l.issue({ type: 'move', player: race, ids: [f.id], x: Math.floor(f.x / 256) + 5, y: Math.floor(f.y / 256) + 3 });
  });
  await stop(server, [a, b]);
  return { ls, seats: starts[0].seats };
}

const noData = !existsSync(`${DATA}/dv.odb`) && 'AN_DATA not set';

test('lockstep: 2 humans + 1 computer player stay in sync', { skip: (typeof WebSocket === 'undefined' && 'no WebSocket client') || noData }, async () => {
  const TICKS = 3000;
  const moved = new Map<number, [number, number]>();
  const { ls, seats } = await playMp({ ...RANDOM, seed: 4711, sizeBits: 8 }, TICKS, (race, x, y) => moved.set(race, [x, y]));
  assert.deepEqual(seats.map(x => x.kind), ['human', 'computer', 'human']);
  const [la, lb] = ls;
  assert.equal(la.world.tick, TICKS);
  assert.equal(lb.world.tick, TICKS);
  assert.equal(la.desync, null);
  assert.equal(lb.desync, null);
  assert.equal(la.world.hash(), lb.world.hash(), 'worlds diverged');
  const w = la.world;
  // the computer Pimmons start with a finished town hall and build up; the humans with a founder
  const owned = (race: number, kind: number) => w.entities.filter(e => e.alive && e.kind === kind && (e.oid >>> 16) === race && e.owner >= 0).length;
  assert.ok(w.economy.towns.some(t => t.race === 1 && t.alive), 'computer town exists');
  assert.ok(owned(1, Kind.Building) >= 2, `computer player builds (${owned(1, Kind.Building)} buildings)`);
  assert.ok(!w.economy.towns.some(t => t.race === 0 || t.race === 2), 'humans have no town before founding one');
  // the humans' orders went through the lockstep: both founders left their start cells
  for (const race of [0, 2]) {
    const f = w.entities.find(e => e.kind === Kind.Unit && (e.oid >>> 16) === race)!;
    const start = moved.get(race)!;
    assert.ok(Math.floor(f.x / 256) !== start[0] || Math.floor(f.y / 256) !== start[1], `founder of race ${race} moved`);
  }
});

test('lockstep: island free play starts identically on every client', { skip: (typeof WebSocket === 'undefined' && 'no WebSocket client') || (!HAS_GOLD && 'AN_GOLD not set') }, async () => {
  const setup: GameSetup = { ...RANDOM, seed: 1234, sizeBits: 8, addon: true };
  const seats: Seat[] = [{ race: 0, kind: 'human', slot: 1, name: 'B' }, { race: 1, kind: 'computer' }, { race: 2, kind: 'human', slot: 0, name: 'A' }];
  // whichever race a client plays, the start world is the same
  const w0 = mpWorld(setup, seats, 0), w2 = mpWorld(setup, seats, 2);
  assert.equal(w0.addon, true);
  assert.equal(w0.hash(), w2.hash());
  assert.equal(w0.entities.length, w2.entities.length);
  const { ls } = await playMp(setup, 600);
  assert.equal(ls[0].world.addon, true);
  assert.ok(ls[0].world.economy.towns.some(t => t.race === 1 && t.alive), 'the computer player has its town hall');
  assert.equal(ls[0].world.hash(), ls[1].world.hash(), 'island worlds diverged');
  assert.equal(ls[0].desync, null);
});
