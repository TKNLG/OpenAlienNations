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
import { Vision } from '../src/client/vision.ts';
import { footprintInSight, foundingAllowed } from '../src/client/placement.ts';

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

// The founder's GRUENDEN is a build button for type 40 (units-and-jobs.md 6.1.1 "Founding uses the
// same path", 11.1): the town hall needs the grown footprint in sight like every building. Explored
// but fogged land is refused exactly like unexplored land; the simulation never reads fog.
test('founding: the town hall needs the site in sight (no fog exemption); the simulation ignores fog', { skip }, () => {
  const { w, human } = freePlay(99);
  const founder = w.entities.find(e => e.kind === Kind.Unit && (e.oid >>> 16) === human && (e.oid & 0xffff) === 10)!;
  const hall = w.rules.get(((human << 16) | 40) >>> 0)!;
  const v = new Vision(w.size, w.bits);
  v.update(w, human, true);
  // a site near the founder that his own vision disc (radius 10) covers
  const ux = Math.floor(founder.x / SUB), uy = Math.floor(founder.y / SUB);
  let site: [number, number] | null = null;
  for (let r = 3; r < 9 && !site; r++) for (let dy = -r; dy <= r && !site; dy++) for (let dx = -r; dx <= r; dx++) {
    if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
    if (foundingAllowed(w, human, ux + dx, uy + dy, v)) { site = [(ux + dx) & (w.size - 1), (uy + dy) & (w.size - 1)]; break; }
  }
  assert.ok(site, 'a site in the founder\'s sight');
  const [x, y] = site!;
  assert.ok(footprintInSight(v, hall, x, y));
  // the founder walked away: the site stays explored but is no longer in sight
  v.visible.fill(0);
  assert.equal(v.explored[(y << w.bits) | x], 1, 'explored');
  assert.equal(foundingAllowed(w, human, x, y, v), false, 'explored but fogged: refused');
  // MAGICEYE only switches fog drawing off
  v.off = true;
  assert.equal(foundingAllowed(w, human, x, y, v), false, 'MAGICEYE does not lift it');
  v.off = false;
  // never explored
  v.explored.fill(0);
  assert.equal(foundingAllowed(w, human, x, y, v), false, 'unexplored: refused');
  // one margin cell out of sight is enough
  v.update(w, human, true);
  const fx = Math.max(1, hall.sizeX), fy = Math.max(1, hall.sizeY);
  v.visible[(((y - fy) & (w.size - 1)) << w.bits) | ((x - fx) & (w.size - 1))] = 0;
  assert.equal(foundingAllowed(w, human, x, y, v), false, 'the 1-cell margin counts');
  // the town-hall rule itself (territory etc.) is independent of fog
  assert.equal(w.logistics.canFound(human, x, y, true), true);
  // simulation: the found-town command is executed without any fog test, identically on a peer
  // that has the site in fog and on one that has never seen it (fog is display state only)
  const b = freePlay(99).w;
  for (const ww of [w, b]) {
    const f = ww.entities.find(e => e.kind === Kind.Unit && (e.oid >>> 16) === human && (e.oid & 0xffff) === 10)!;
    ww.schedule({ type: 'found', player: human, unit: f.id, x, y }, ww.tick + 1);
    ww.step(); ww.step();
    assert.equal(ww.economy.towns.filter(t => t.race === human && t.alive).length, 1, 'town founded');
  }
  assert.equal(w.hash(), b.hash());
});
