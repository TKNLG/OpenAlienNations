// The computer players' navy in island free play (docs/game/ai-diplomacy-trade.md 9,
// docs/game/addon.md 8): shipyard and harbour targets, the fishing boat, the transport ship the
// naval planner takes over through its claim count (8.5), and founders carried across the sea
// (founding mission 1.12 step b: the mission ends once the founder is aboard).
// Needs the Gold Edition data folder (AN_GOLD).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GOLD, HAS_GOLD, dataReader, rulesOf } from './helpers/mission.ts';
import { parseMdb } from '../src/formats/mission.ts';
import { parseOs } from '../src/formats/os.ts';
import { CLASS_TILESET } from '../src/world/terrain.ts';
import { aoPickTables } from '../src/world/addon-terrain.ts';
import { buildGeneratedWorld } from '../src/world/free-play.ts';
import { animalTypeCount } from '../src/formats/addon.ts';
import { applyFreePlay, spDefaults } from '../src/client/frontend/freeplay.ts';
import { World, Kind, SUB, type Entity } from '../src/engine/world.ts';
import { NJ, NAVAL_GROUP } from '../src/engine/naval.ts';

const skip = !HAS_GOLD && 'AN_GOLD data not found';
const SHIPYARD = 63, HARBOUR = 62, FISHING = 64, TRANSPORT = 67, FOUNDER = 10;

/** island free play with all three races computer-controlled (the free-play menu's record 0) */
function islandFreePlay(seed: number, development: number): World {
  const read = dataReader(GOLD);
  const base = parseMdb(read('InfiniteAO.mdb')!)[0];
  const m0 = applyFreePlay(base, { ...spDefaults(), development, addon: true }, seed);
  const m = { ...m0, races: m0.races.map(r => ({ ...r, present: true, computer: true })) };
  const rules = rulesOf(GOLD, true);
  const pickOf = (n: string) => parseOs(read(`${n}.os`)!).pick;
  const hallOf = (race: number) => { const r = rules.rules.get(((race << 16) | 40) >>> 0); return r ? { sizeX: r.sizeX, sizeY: r.sizeY, radius: r.radius || 25 } : undefined; };
  const g = buildGeneratedWorld(m, { player: 0, hallOf, pick: CLASS_TILESET.map(pickOf), aoPick: aoPickTables(pickOf), animalTypes: animalTypeCount(rules.rules) });
  return new World(g.terrain, g.result.objects, rules.rules, {
    races: m.races, costs: rules.inventions.map(l => l.map(i => i.cost)), prerequisites: rules.inventions.map(l => l.map(i => i.prerequisites)),
    goals: m.goals, weapons: rules.weapons, orders: [], lists: g.result.lists,
  });
}

const cellOf = (e: Entity): [number, number] => [Math.floor(e.x / SUB), Math.floor(e.y / SUB)];
const type = (e: Entity) => e.oid & 0xffff;
const jobKind = (w: World, e: Entity) => (e.job ? w.sched.get(e.job)?.kind ?? 0 : 0);

test('island free play (Mittel): computer players build a shipyard, fish, train a transport the planner claims, and ferry a founder', { skip }, () => {
  const w = islandFreePlay(2, 1);
  const home = new Map<number, number>();
  for (const e of w.entities) if (e.kind === Kind.Unit && type(e) === FOUNDER) home.set(e.owner, w.islandAt(...cellOf(e)));
  assert.equal(new Set(home.values()).size, 3, 'every race starts on its own island');
  const seen = new Set<string>();
  let fishing = false, waited = false, aboard: Entity | null = null, landedAt = -1;
  for (let i = 0; i < 18000; i++) {
    w.step();
    if (i % 50) continue;
    for (const e of w.entities) {
      if (!e.alive || e.kind !== Kind.Unit || type(e) !== FOUNDER) continue;
      if (jobKind(w, e) === NJ.Wait) waited = true;
      const ship = e.inside >= 0 ? w.get(e.inside) : undefined;
      if (ship && w.isShip(ship)) {
        aboard ??= e;
        assert.equal(ship.group, NAVAL_GROUP, 'carried by the planner\'s transport');
      }
    }
    if (aboard && landedAt < 0 && aboard.inside < 0 && w.islandAt(...cellOf(aboard)) !== home.get(aboard.owner)) landedAt = i;
    if (i % 100) continue;
    for (const e of w.entities) {
      if (!e.alive) continue;
      const ty = type(e);
      if (e.kind === Kind.Building && (ty === HARBOUR || ty === SHIPYARD) && e.complete) seen.add(`${ty}`);
      if (e.kind === Kind.Unit && w.isShip(e)) {
        seen.add(`${ty}`);
        if (ty === FISHING && jobKind(w, e) === NJ.Fishing) fishing = true;
      }
    }
  }
  assert.ok(seen.has(`${SHIPYARD}`), 'a computer shipyard was completed');
  assert.ok(seen.has(`${HARBOUR}`), 'a computer harbour was completed');
  assert.ok(fishing, 'a computer fishing boat fished');
  // the planner's initial claim (claim[67] = 1) is part of the training want: a transport is
  // trained without any trade partner or ship request, and the planner takes it over (group 61)
  const claimed = [0, 1, 2].map(r => w.naval.planner(r)!).filter(pl => pl.ships.length > 0);
  assert.ok(claimed.length > 0, 'a planner owns a transport');
  for (const pl of claimed) {
    const ship = w.get(pl.ships[0].id)!;
    assert.equal(type(ship), TRANSPORT);
    assert.equal(ship.group, NAVAL_GROUP);
    assert.equal(pl.claim[TRANSPORT], 0, 'the claim is used up');
  }
  // founding across the sea (1.12, addon.md 8.4): the founder waited for a ship (job 0x3E), was
  // carried to another island, and the mission ended once he was aboard: he stands there idle in
  // group 54 and founds nothing
  assert.ok(waited, 'a founder waited for a ship');
  assert.ok(aboard && landedAt > 0, 'a founder was carried to another island');
  const f = aboard!;
  assert.ok(f.alive && f.inside < 0);
  assert.ok(w.islandAt(...cellOf(f)) !== home.get(f.owner), 'he stands on another island');
  assert.equal(f.group, 54, 'the founder keeps the founding group');
  assert.equal(f.job, 0, 'and has nothing to do');
  assert.ok(!w.economy.towns.some(t => t.race === f.owner && w.islandAt(t.x, t.y) !== home.get(f.owner)), 'no town on a foreign island');
});
