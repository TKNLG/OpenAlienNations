// Founding a town with the city founder (docs/game/units-and-jobs.md 11).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseMdb } from '../src/formats/mission.ts';
import { parseOs } from '../src/formats/os.ts';
import { parseOdb } from '../src/formats/odb.ts';
import { generateTerrain, CLASS_TILESET } from '../src/world/terrain.ts';
import { generateWorld } from '../src/world/populate.ts';
import { World, Kind, SUB } from '../src/engine/world.ts';
import { DATA, setupOf } from './helpers/mission.ts';

const skip = !DATA;

function freePlay(seed: number) {
  const m = parseMdb(readFileSync(`${DATA}/Infinite.mdb`))[1];   // Pimmons human
  const pick = CLASS_TILESET.map(name => parseOs(readFileSync(`${DATA}/${name}.os`)).pick);
  const races = m.races.map(r => ({ ...r, startGoods: r.startGoods.map((g, i) => (i <= 5 ? [20, g[1]] : g) as [number, number]) }));
  const gen = generateWorld(seed, 8, (s, b) => generateTerrain(s, b, pick), {
    resources: 1, players: races.filter(r => r.present).map(r => ({ race: r.race, computer: r.computer })),
  });
  const rules = parseOdb(readFileSync(`${DATA}/dv.odb`));
  const w = new World(gen.terrain, gen.result.objects, rules, { ...setupOf(m), races, orders: [], lists: gen.result.lists });
  return { w, human: m.humanRace };
}

function spotNear(w: World, race: number, u: { x: number; y: number }): [number, number] {
  const ux = Math.floor(u.x / SUB), uy = Math.floor(u.y / SUB);
  for (let r = 3; r < 30; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
    if (w.logistics.canFound(race, ux + dx, uy + dy, true)) return [ux + dx, uy + dy];
  }
  throw new Error('no site');
}

test('founding: a lone founder founds the first town and gets the start set', { skip }, () => {
  const { w, human } = freePlay(99);
  assert.equal(w.economy.towns.filter(t => t.race === human).length, 0);
  const founder = w.entities.find(e => e.kind === Kind.Unit && (e.oid >>> 16) === human && (e.oid & 0xffff) === 10)!;
  assert.ok(founder);
  const [x, y] = spotNear(w, human, founder);
  w.schedule({ type: 'found', player: human, unit: founder.id, x, y }, w.tick + 1);
  for (let i = 0; i < 400; i++) w.step();
  const t = w.economy.towns.find(t => t.race === human && t.alive)!;
  assert.ok(t, 'town exists');
  const hall = w.get(t.hall)!;
  assert.ok(hall.complete && hall.active, 'town hall complete and active');
  assert.equal(founder.inside, hall.id, 'founder lives in the town hall');
  assert.equal(t.population, 4, 'founder + builder + 2 porters');
  assert.equal(t.stock[1], 20, 'start goods from the mission table');
});

test('founding: an interrupted founding destroys the new town', { skip }, () => {
  const { w, human } = freePlay(99);
  const founder = w.entities.find(e => e.kind === Kind.Unit && (e.oid >>> 16) === human && (e.oid & 0xffff) === 10)!;
  const [x, y] = spotNear(w, human, founder);
  w.schedule({ type: 'found', player: human, unit: founder.id, x, y }, w.tick + 1);
  w.step(); w.step();
  assert.equal(w.economy.towns.filter(t => t.race === human && t.alive).length, 1);
  w.schedule({ type: 'move', player: human, ids: [founder.id], x: x + 10, y: y + 10 }, w.tick + 1);
  for (let i = 0; i < 40; i++) w.step();
  assert.equal(w.economy.towns.filter(t => t.race === human && t.alive).length, 0, 'site and town gone');
  assert.ok(w.economy.players[human]?.defeated, 'no town left: defeated');
});
