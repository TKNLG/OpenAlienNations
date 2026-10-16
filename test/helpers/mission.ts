// Loads a mission from the real game data for simulation tests (AN_DATA = the game's Data folder).

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { parseMdb, parseDvm, parseDvmExtras, parseDvmFile, dvmLayout, type Mission } from '../../src/formats/mission.ts';
import { parseWdb } from '../../src/formats/wdb.ts';
import { parseOs } from '../../src/formats/os.ts';
import { parseOdb } from '../../src/formats/odb.ts';
import { parseIdb } from '../../src/formats/idb.ts';
import { generateTerrain, CLASS_TILESET } from '../../src/world/terrain.ts';
import { World, type WorldSetup } from '../../src/engine/world.ts';
import { loadRules, type Rules, type ReadFile } from '../../src/formats/addon.ts';
import { addonTerrainFromStored, aoPickTables, type AddonTerrain } from '../../src/world/addon-terrain.ts';
import { generateIslandTerrain } from '../../src/world/island-gen.ts';

export const DATA = process.env.AN_DATA ?? '';
const RACE_DIRS = ['AMAZONS', 'PIMONS', 'SAJIKI'];

export function setupOf(m: Mission, data = DATA): WorldSetup {
  return {
    races: m.races,
    costs: RACE_DIRS.map(d => parseIdb(readFileSync(`${data}/${d}/DV.idb`)).map(i => i.cost)),
    prerequisites: RACE_DIRS.map(d => parseIdb(readFileSync(`${data}/${d}/DV.idb`)).map(i => i.prerequisites)),
    goals: m.goals,
    weapons: parseWdb(readFileSync(`${data}/dv.wdb`)),
    ...(m.mapFile ? (({ orders, lists }) => ({ orders, lists }))(parseDvmExtras(readFileSync(`${data}/${m.mapFile.replace(/\\/g, '/')}`))) : { orders: [] }),
  };
}

/** mission `order` (play position) of a campaign file */
/** `ai` false: the computer players stay passive (tests of single mechanics on missions with computer opponents) */
export function loadMission(mdb: string, order: number, data = DATA, ai = true): { world: World; mission: Mission } {
  const m = parseMdb(readFileSync(`${data}/${mdb}`)).find(x => x.order === order)!;
  const pick = CLASS_TILESET.map(name => parseOs(readFileSync(`${data}/${name}.os`)).pick);
  const terrain = generateTerrain(m.seed, m.sizeBits, pick);
  const objects = parseDvm(readFileSync(`${data}/${m.mapFile.replace(/\\/g, '/')}`));
  const rules = parseOdb(readFileSync(`${data}/dv.odb`));
  return { world: new World(terrain, objects, rules, { ...setupOf(m, data), ai }), mission: m };
}

// ---------------------------------------------------------------- Gold Edition / add-on missions
// AN_GOLD = the Gold Edition's data folder (base + mission pack); file names are matched
// case-insensitively like the original (docs/formats/addon.md 1.2).

export const GOLD = process.env.AN_GOLD ?? '';
export const HAS_GOLD = GOLD !== '' && existsSync(GOLD) && existsSync(`${GOLD}/dv.odb`);

/** case-insensitive file reader below a data folder; null for a missing file */
export function dataReader(dir: string): ReadFile {
  const listing = new Map<string, Map<string, string>>();
  const resolve = (rel: string): string | null => {
    let cur = dir;
    for (const part of rel.replace(/\\/g, '/').split('/').filter(Boolean)) {
      let m = listing.get(cur);
      if (!m) {
        m = new Map();
        try { for (const e of readdirSync(cur)) m.set(e.toLowerCase(), e); } catch { /* not a folder */ }
        listing.set(cur, m);
      }
      const hit = m.get(part.toLowerCase());
      if (!hit) return null;
      cur = `${cur}/${hit}`;
    }
    return cur;
  };
  return (rel: string) => {
    const p = resolve(rel);
    return p ? readFileSync(p) : null;
  };
}

const rulesCache = new Map<string, Rules>();
/** merged rule tables of a data folder (cached) */
export function rulesOf(data: string, addon: boolean): Rules {
  const key = `${data}|${addon}`;
  let r = rulesCache.get(key);
  if (!r) rulesCache.set(key, r = loadRules(dataReader(data), addon, { objects: false }));
  return r;
}

/** add-on tile lookups per add-on class */
export function addonPickTables(data = GOLD): Uint8Array[] {
  const read = dataReader(data);
  return aoPickTables(name => parseOs(read(`${name}.os`)!).pick);
}

/** island generator bound to the data's tile sets */
export function islandGenerator(data = GOLD): (seed: number, bits: number) => AddonTerrain {
  const pick = addonPickTables(data);
  return (s, b) => generateIslandTerrain(s, b, pick);
}

/**
 * Load an add-on campaign mission (`mdb` e.g. 'PimmonsAO.mdb', `order` = play position) from the
 * Gold data: stored terrain, merged rules, AO.idb research trees. The World runs in add-on mode
 * (detected from the AddonTerrain) and creates the ships' cargo inside them.
 */
export function loadAddonMission(mdb: string, order: number, data = GOLD, ai = true):
  { world: World; mission: Mission; terrain: AddonTerrain; rules: Rules } {
  const read = dataReader(data);
  const m = parseMdb(read(mdb)!).find(x => x.order === order)!;
  const rules = rulesOf(data, m.addon === true);
  const file = parseDvmFile(read(m.mapFile)!, dvmLayout(m));
  if (!file.terrain) throw new Error(`${m.mapFile}: no stored terrain (seed ${m.seed})`);
  const terrain = addonTerrainFromStored(file.terrain);
  const world = new World(terrain, file.objects, rules.rules, {
    races: m.races,
    costs: rules.inventions.map(l => l.map(i => i.cost)),
    prerequisites: rules.inventions.map(l => l.map(i => i.prerequisites)),
    goals: m.goals,
    weapons: rules.weapons,
    orders: file.extras.orders,
    lists: file.extras.lists,
    ai,
  });
  return { world, mission: m, terrain, rules };
}
