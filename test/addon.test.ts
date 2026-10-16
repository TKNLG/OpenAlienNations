// Gold Edition / mission pack ("AO") data and world generation. Spec: docs/formats/addon.md.
// Needs the Gold Edition data folder: AN_GOLD (the tests skip when it is not set).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseMdb, parseDvmFile, dvmLayout, goalCell, GoalType, type Mission } from '../src/formats/mission.ts';
import { loadRules, mapCreationOrder, animalTypeCount, ruleFiles } from '../src/formats/addon.ts';
import { parseIdb } from '../src/formats/idb.ts';
import {
  addonTerrainFromStored, labelLand, labelRuns, bodiesBySize, AO_CLASS_FIRST_TILE, AO_TILE_COUNT,
  AO_CLASS_SEA, AO_CLASS_WATER, AO_CLASS_BEACH, AO_CLASS_TILESET, AO_TO_BASE_CLASS, type AddonTerrain,
} from '../src/world/addon-terrain.ts';
import { CLASS_TILESET, CLASS_WATER } from '../src/world/terrain.ts';
import { generateIslandWorld } from '../src/world/island-populate.ts';
import { GOLD, HAS_GOLD, dataReader, rulesOf, islandGenerator, loadAddonMission } from './helpers/mission.ts';

const skip = !HAS_GOLD && 'AN_GOLD data not found';
const read = HAS_GOLD ? dataReader(GOLD) : () => null;
const mdb = (f: string) => parseMdb(read(f)!);

/** addon.md 8.6 for the 30 campaign maps: size, records, nature/buildings/units, cargo lengths,
 *  list sizes, camera, orders, sea %, island count and the largest island sizes */
const MAPS: Record<string, [number, number, string, string, string, string, number, number, number, number[]]> = {
  Amazon0AO: [128, 97, '67/16/14', '', '0,0,0,0,23', '3,73', 0, 52, 1, [7790]],
  Amazon1AO: [256, 358, '340/8/10', '1,5', '3,2,0,0,38', '8,11', 8, 91, 1, [5644]],
  Amazon2AO: [256, 534, '485/21/28', '0', '4,6,3,1,39', '209,224', 4, 80, 2, [8068, 5362]],
  Amazon3AO: [256, 758, '710/33/15', '', '5,4,10,0,74', '228,234', 8, 80, 4, [5377, 3252, 3054, 1372]],
  Amazon4AO: [128, 299, '225/9/65', '3,0', '0,0,0,0,9', '62,50', 58, 45, 5, [6945, 785, 687, 374]],
  Amazon5AO: [256, 844, '799/29/16', '5,5', '6,6,1,1,93', '221,241', 7, 72, 3, [9200, 4757, 4471]],
  Amazon6AO: [256, 609, '562/18/29', '5,2', '3,5,3,0,48', '221,61', 0, 81, 5, [4556, 4176, 3469, 96]],
  Amazon7AO: [256, 735, '668/32/35', '', '9,8,5,1,85', '197,0', 18, 79, 1, [13780]],
  Amazon8AO: [512, 2086, '1991/51/44', '', '10,10,9,1,3', '487,319', 30, 92, 3, [13522, 5456, 2298]],
  Amazon9AO: [256, 1093, '994/49/50', '', '11,10,13,1,24', '156,13', 23, 65, 3, [11404, 7422, 3990]],
  Pimmon0AO: [128, 225, '205/12/8', '', '3,3,1,0,3', '25,83', 4, 32, 1, [11085]],
  Pimmon1AO: [256, 520, '475/21/24', '0', '6,9,4,0,3', '170,201', 3, 53, 4, [17342, 7719, 5813, 11]],
  Pimmon2AO: [256, 389, '365/1/23', '1,5', '0,0,0,0,4', '106,235', 16, 89, 1, [7294]],
  Pimmon3AO: [256, 697, '647/30/20', '', '7,3,1,0,4', '7,13', 3, 82, 4, [4811, 4430, 2405, 79]],
  Pimmon4AO: [256, 797, '753/24/20', '', '7,6,4,2,4', '14,253', 12, 80, 7, [6995, 4927, 419]],
  Pimmon5AO: [256, 604, '552/27/25', '0', '5,6,3,1,5', '201,250', 16, 79, 2, [7151, 6557]],
  Pimmon6AO: [256, 1143, '1079/43/21', '', '18,19,8,2,4', '32,186', 13, 49, 1, [33484]],
  Pimmon7AO: [256, 900, '858/25/17', '', '6,15,9,0,3', '246,241', 7, 77, 6, [7424, 4954, 2858]],
  Pimmon8AO: [256, 1177, '1113/31/33', '5,5', '20,17,13,4,5', '207,30', 9, 43, 1, [37281]],
  Pimmon9AO: [512, 2029, '1931/38/60', '0', '14,18,10,3,4', '50,470', 31, 91, 7, [12541, 7450, 2746, 520]],
  Sajiki0AO: [256, 427, '405/12/10', '', '4,8,3,1,3', '8,90', 10, 73, 2, [12646, 5027]],
  Sajiki1AO: [128, 199, '162/24/13', '', '4,3,1,0,3', '57,59', 0, 57, 1, [7099]],
  Sajiki2AO: [256, 658, '613/20/25', '4,5', '4,5,4,0,5', '23,16', 10, 74, 3, [14058, 2601, 115]],
  Sajiki3AO: [256, 558, '523/21/14', '', '2,9,1,0,80', '208,242', 3, 85, 2, [5403, 4331]],
  Sajiki4AO: [256, 947, '892/36/19', '', '3,4,5,2,94', '54,20', 9, 81, 6, [4777, 4311, 2973, 372]],
  Sajiki5AO: [128, 529, '461/16/52', '0,0', '4,0,8,0,12', '63,19', 38, 21, 6, [12650, 239, 83]],
  Sajiki6AO: [256, 1181, '1085/47/49', '5,5', '10,7,6,1,60', '69,77', 33, 73, 3, [10082, 6510, 882]],
  Sajiki7AO: [256, 785, '719/22/44', '', '6,5,1,0,73', '160,90', 38, 81, 2, [8754, 3939]],
  Sajiki8AO: [512, 3604, '3475/48/81', '0,0,0', '15,5,5,1,3', '83,198', 18, 90, 4, [18070, 4568, 2823, 1698]],
  Sajiki9AO: [256, 700, '632/21/47', '5,5,5', '7,9,4,1,97', '24,78', 34, 84, 2, [10110, 110]],
};

const CAMPAIGNS = ['AmazonsAO.mdb', 'PimmonsAO.mdb', 'SajikisAO.mdb'];
const campaignMissions = (): Mission[] => CAMPAIGNS.flatMap(mdb);

const terrainCache = new Map<string, { m: Mission; t: AddonTerrain; file: ReturnType<typeof parseDvmFile> }>();
function stored(m: Mission) {
  let e = terrainCache.get(m.mapFile);
  if (!e) {
    const file = parseDvmFile(read(m.mapFile)!, dvmLayout(m));
    terrainCache.set(m.mapFile, e = { m, file, t: addonTerrainFromStored(file.terrain!) });
  }
  return e;
}

test('AO mission files: flag, seeds, sizes, presets, goal parameters', { skip }, () => {
  const sets = CAMPAIGNS.map(mdb);
  for (const ms of sets) {
    assert.equal(ms.length, 10);
    ms.forEach((m, i) => {
      assert.equal(m.order, i, 'indices 0..9 in file order');
      assert.equal(m.addon, true);
      assert.equal(m.seed, -2);
      assert.ok(/AO\.dvm$/.test(m.mapFile));
      assert.equal(1 << m.sizeBits, MAPS[m.mapFile.replace('.dvm', '')][0]);
      for (const r of m.races) assert.equal(r.preResearched.length, 33);
    });
  }
  const inf = mdb('InfiniteAO.mdb');
  assert.equal(inf.length, 4);
  for (const m of inf) { assert.equal(m.addon, true); assert.equal(m.seed, -1); assert.equal(m.sizeBits, 9); assert.equal(m.mapFile, ''); }
  assert.deepEqual(inf[0].races.map(r => r.gold), [250, 250, 250]);
  // base records stay base missions; their invention words 30..32 are 0
  for (const f of ['Amazons.mdb', 'Pimmons.mdb', 'Sajikis.mdb', 'Tutorials.mdb', 'Infinite.mdb'])
    for (const m of mdb(f)) {
      assert.equal(m.addon, false, f);
      for (const r of m.races) assert.deepEqual(r.preResearched.slice(30), [false, false, false]);
    }
  // presets (addon.md 7.4)
  const [am, , sa] = sets;
  const R = (m: Mission, race: number) => m.races[race].preResearched.flatMap((v, i) => (v ? [i] : []));
  assert.deepEqual(R(am[2], 0), [0, 1, 2, 3, 4, 5, 6, 7, 8, 30]);
  assert.deepEqual(R(am[9], 0), Array.from({ length: 33 }, (_, i) => i));
  assert.deepEqual(R(am[7], 1), [...Array.from({ length: 23 }, (_, i) => i), 29, 30, 31, 32]);
  assert.equal(sa[3].races[2].gold, 1500);
  assert.equal(am[3].races[2].researchLevel, 21);
  assert.deepEqual(sa[0].races[1].disabled.sort(), [62, 66]);
  // new goal types
  const g = am[4].goals;
  assert.deepEqual(g.map(x => [x.type, x.defeat]), [[GoalType.ObjectNear, false], [GoalType.ObjectGone, true]]);
  assert.deepEqual([g[0].p1, goalCell(g[0].p2), g[0].p3], [318, [59, 101], 7]);
  assert.deepEqual([g[1].p1, g[1].p2], [318, 24]);
  assert.deepEqual(sa[2].goals.map(x => [x.type, x.p1, x.p2, x.p3]), [[19, 1, 52, 1], [19, 2, 52, 2], [19, 2, 63, 1]]);
  assert.deepEqual(am[0].goals[0], { type: GoalType.StockAtMost, defeat: true, p1: 4, p2: 5, p3: 1 });
});

test('AO maps: all 32 files parse to the byte; objects, cargo, lists match addon.md 8.6', { skip }, () => {
  let records = 0, zOff = 0;
  for (const m of campaignMissions()) {
    const name = m.mapFile.replace('.dvm', '');
    const [size, count, split, cargo, lists, camera, orders] = MAPS[name];
    const { file, t } = stored(m);
    assert.equal(file.rest, 0, `${name} fully consumed`);
    assert.equal(t.size, size);
    assert.equal(file.objects.length, count, name);
    const nat = file.objects.filter(o => o.group === 6), rest = file.objects.filter(o => o.group !== 6);
    assert.equal(`${nat.length}/${rest.filter(o => o.cls === 1).length}/${rest.filter(o => o.cls === 0).length}`, split, name);
    assert.equal(file.objects.filter(o => o.cargo).map(o => o.cargo!.length).join(','), cargo, name);
    assert.ok(file.objects.every(o => !o.cargo || (o.type === 67 && o.cls === 0)));
    assert.equal(file.extras.lists.map(l => l.length).join(','), lists, name);
    assert.equal(file.extras.camera.join(','), camera, name);
    assert.equal(file.extras.orders.length, orders, name);
    records += count;
    for (const o of file.objects) if (o.z !== t.height[((o.y & (size - 1)) << t.sizeBits) | (o.x & (size - 1))]) zOff++;
  }
  assert.equal(records, 25482);
  assert.equal(zOff, 28, 'z equals the stored height in all but 28 records');
  // cargo contents: unit types of the ship's race (Amazons 4: the scout on the first transport)
  const am4 = stored(mdb('AmazonsAO.mdb')[4]).file.objects.filter(o => o.cargo);
  assert.deepEqual(am4.map(o => [o.x, o.y, o.cargo]), [[63, 52, [29, 29, 24]], [am4[1].x, am4[1].y, []]]);
  // the two unreferenced files
  const a9a = parseDvmFile(read('Amazon9AAO.dvm')!, { terrainBits: 8, cargo: true });
  assert.equal(a9a.rest, 0);
  assert.equal(a9a.objects.length, 307);
  const ao1 = parseDvmFile(read('AmazonAO1.dvm')!, { terrainBits: 8, cargo: false });
  assert.equal(ao1.rest, 0);
  assert.equal(ao1.objects.length, 41);
  assert.equal(ao1.extras.lists[0].length, 16461);
  assert.ok([64, 65, 66, 67].every(t => ao1.objects.some(o => o.type === t)));
});

test('AO maps: stored terrain (sea flat at 120, class-10 ring, tile classes, islands)', { skip }, () => {
  for (const m of campaignMissions()) {
    const name = m.mapFile.replace('.dvm', '');
    const [, , , , , , , seaPct, islandCount, largest] = MAPS[name];
    const { t, file } = stored(m);
    const n = t.size, mask = n - 1, bits = t.sizeBits;
    let sea = 0;
    for (let i = 0; i < n * n; i++) {
      const c = t.aoCls[i], h = t.height[i];
      const g = file.terrain!.tile[i];
      assert.ok(g < AO_TILE_COUNT && g - AO_CLASS_FIRST_TILE[c] === t.tile[i]);
      assert.ok(c !== 1 && c !== 8, 'classes 1 and 8 never occur');
      assert.equal(t.cls[i], AO_TO_BASE_CLASS[c]);
      assert.equal(CLASS_TILESET[t.cls[i]], AO_CLASS_TILESET[c], 'engine class keeps the tile set');
      if (c >= AO_CLASS_SEA) {
        sea++;
        assert.equal(h, 120, `${name}: water is flat at 120`);
        assert.equal(t.cls[i], CLASS_WATER);
        const x = i & mask, y = i >> bits;
        let land = false;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++)
          if ((dx || dy) && t.height[(((y + dy) & mask) << bits) | ((x + dx) & mask)] > 120) land = true;
        assert.equal(c === AO_CLASS_WATER, land, `${name}: class 10 exactly on the coastal ring`);
        assert.equal(t.island[i], 0);
      } else {
        assert.ok(h > 120, `${name}: land above sea level`);
        assert.ok(t.island[i] > 0);
      }
    }
    assert.equal(Math.round((100 * sea) / (n * n)), seaPct, name);
    const isl = bodiesBySize(labelLand(t)).filter(b => b.size > 0);
    assert.equal(isl.length, islandCount, name);
    assert.deepEqual(isl.slice(0, largest.length).map(b => b.size), largest, name);
  }
});

/** naive transcription of addon.md 9.3 (relabel every run of the list) as a reference */
function naiveLabels(n: number, pred: (x: number, y: number) => boolean): number[] {
  const runs: { y: number; x0: number; x1: number; l: number }[] = [];
  const rows: number[][] = [];
  let count = 0;
  const relabel = (from: number, to: number) => { for (const r of runs) if (r.l === from) r.l = to; };
  for (let y = 0; y < n; y++) {
    rows.push([]);
    for (let x = 0; x < n;) {
      if (!pred(x, y)) { x++; continue; }
      const x0 = x;
      while (x < n && pred(x, y)) x++;
      const R = { y, x0, x1: x, l: 0 };
      const over = y > 0 ? rows[y - 1].map(i => runs[i]).filter(P => P.x0 < R.x1 && P.x1 > R.x0) : [];
      if (!over.length) R.l = ++count;
      else { R.l = over[0].l; for (const P of over.slice(1)) if (P.l !== R.l) relabel(P.l, R.l); }
      rows[y].push(runs.length);
      runs.push(R);
    }
  }
  for (const R of runs) {
    const row = rows[R.y], last = runs[row[row.length - 1]];
    if (R.x0 === 0 && last.x1 === n && last.l !== R.l) relabel(R.l, last.l);
    if (R.y === n - 1) for (const i of rows[0]) { const P = runs[i]; if (P.x0 < R.x1 && P.x1 > R.x0 && P.l !== R.l) relabel(R.l, P.l); }
  }
  return runs.map(r => r.l);
}

test('run labelling (9.3): same label numbers as a literal transcription; torus wrap', { skip }, () => {
  for (const name of ['SajikisAO.mdb', 'PimmonsAO.mdb']) for (const m of mdb(name).slice(0, 5)) {
    const { t } = stored(m);
    const runs = labelLand(t);
    assert.deepEqual(Array.from(runs.label), naiveLabels(t.size, (x, y) => t.height[(y << t.sizeBits) | x] > 120), m.mapFile);
  }
  // synthetic 128 map: a band across the x seam and one across the y seam join into one label each
  const bits = 7, n = 128;
  const cell = (x: number, y: number) => (x < 4 || x >= n - 4) && y > 50 && y < 60 || (y < 3 || y >= n - 3) && x > 20 && x < 30;
  const r = labelRuns(bits, i => cell(i & (n - 1), i >> bits));
  const used = new Set(Array.from(r.label));
  assert.equal(used.size, 2);
  assert.deepEqual(Array.from(r.label), naiveLabels(n, cell));
  // Sajiki 2 (goal 19 on islands 1 and 2): the Pimmon base island is 2, the home island 4;
  // label 1 is merged away by the horizontal wrap (see docs/architecture/integration-addon.md)
  const { t } = stored(mdb('SajikisAO.mdb')[2]);
  assert.equal(t.island[(251 << 8) | 235], 2);
  assert.equal(t.island[(104 << 8) | 11], 4);
  assert.ok(!t.island.includes(1));
});

test('rules merge: Addon.odb/od/wdb/tdb and AO.idb in add-on mode only', { skip }, () => {
  const base = loadRules(read, false), ao = loadRules(read, true);
  assert.equal(base.tableWidth, 62);
  assert.equal(ao.tableWidth, 68);
  const types = (r: typeof ao, g: number) => [...r.rules.values()].filter(x => x.group === g).map(x => x.type).sort((a, b) => a - b);
  for (const g of [0, 1, 2]) {
    assert.ok(types(base, g).every(t => t < 62));
    assert.deepEqual(types(ao, g).filter(t => t >= 62), [62, 63, 64, 65, 66, 67]);
    assert.equal(types(ao, g).length, types(base, g).length + 6);
  }
  assert.deepEqual(types(ao, 6).filter(t => t > 38), [39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51]);
  assert.ok(types(base, 6).every(t => t <= 38));
  assert.equal(ao.rules.size - base.rules.size, 31);
  const rule = (g: number, t: number) => ao.rules.get(((g << 16) | t) >>> 0)!;
  assert.deepEqual([rule(1, 63).sizeX, rule(1, 63).sizeY], [3, 2], 'Pimmon shipyard 3x2');
  assert.deepEqual([rule(0, 63).sizeX, rule(0, 63).sizeY], [3, 3]);
  assert.deepEqual([rule(0, 62).hp, rule(0, 62).flags, rule(0, 62).cls, rule(0, 62).invention, rule(0, 62).madeAt], [1000, 0x21, 4, 31, 40]);
  assert.deepEqual([rule(2, 66).hp, rule(2, 66).weapon, rule(2, 66).cls, rule(2, 66).madeAt, rule(2, 66).invention], [450, 24, 14, 63, 32]);
  assert.deepEqual([rule(1, 67).flags, rule(1, 67).garrison, rule(1, 67).weapon], [0x40, 5, -1]);
  assert.deepEqual([rule(6, 41).cls, rule(6, 46).cls, rule(6, 39).cls, rule(6, 50).cls], [15, 8, 7, -1]);
  assert.equal(animalTypeCount(base.rules), 5);
  assert.equal(animalTypeCount(ao.rules), 7);
  // weapons 0..20 + 21..27
  assert.equal(base.weapons.length, 21);
  assert.equal(ao.weapons.length, 28);
  assert.deepEqual(ao.weapons.slice(0, 21), base.weapons);
  assert.deepEqual([ao.weapons[22].min, ao.weapons[22].max, ao.weapons[22].range], [120, 220, 12]);
  assert.equal(ao.weapons[27].name, 'Angel');
  // sprites
  assert.ok(ao.objects!.size - base.objects!.size === 49);
  assert.ok(ao.objects!.has(((1 << 16) | 67) >>> 0) && !base.objects!.has(((1 << 16) | 67) >>> 0));
  // strings: Addon.tdb is loaded in both modes
  for (const r of [base, ao]) {
    assert.equal(r.strings.get(325), 'Addon:');
    assert.equal(r.strings.get(326), 'Addon Kampagnen');
    assert.equal(r.strings.get(329), 'An Bord');
  }
  // inventions: AO.idb = DV.idb + 3
  for (let race = 0; race < 3; race++) {
    assert.equal(base.inventions[race].length, 30);
    assert.equal(ao.inventions[race].length, 33);
    assert.deepEqual(ao.inventions[race].slice(0, 30), base.inventions[race]);
    assert.deepEqual(ao.inventions[race].slice(30).map(i => i.cost), [25, 60, 150]);
    assert.deepEqual(ao.inventions[race][31].prerequisites, [30]);
  }
  assert.equal(ao.inventions[0][30].name, 'Werft');
  assert.deepEqual(ruleFiles(true).idb, ['AMAZONS/AO.idb', 'PIMONS/AO.idb', 'SAJIKI/AO.idb']);
  assert.equal(parseIdb(read('Sajiki/AO.idb')!).length, 33);
});

test('creation order (8.4): goal object ids resolve as in addon.md 7.3', { skip }, () => {
  const rules = rulesOf(GOLD, true).rules;
  const order = (f: string, i: number) => mapCreationOrder(stored(mdb(f)[i]).file.objects, rules);
  const at = (o: ReturnType<typeof order>, id: number) => [o[id].role, o[id].group, o[id].type, o[id].x, o[id].y];
  assert.deepEqual(at(order('AmazonsAO.mdb', 4), 318), ['cargo', 0, 24, 63, 52]);
  assert.deepEqual(at(order('PimmonsAO.mdb', 1), 563), ['map', 1, 67, 185, 165]);
  assert.deepEqual(at(order('PimmonsAO.mdb', 2), 393), ['cargo', 1, 10, 102, 235]);
  assert.deepEqual(at(order('PimmonsAO.mdb', 5), 584), ['map', 1, 63, 204, 0]);
  assert.deepEqual(at(order('PimmonsAO.mdb', 6), 1115), ['map', 0, 39, 222, 168]);
  const s0 = order('SajikisAO.mdb', 0);
  assert.deepEqual([445, 446, 447, 448, 451].map(id => s0[id].type), [65, 65, 65, 65, 66]);
  assert.deepEqual([990, 991].map(id => at(order('SajikisAO.mdb', 4), id).slice(0, 3)), [['map', 1, 65], ['map', 1, 65]]);
  assert.deepEqual(at(order('SajikisAO.mdb', 5), 559).slice(0, 3), ['map', 2, 24]);
  const s8 = order('SajikisAO.mdb', 8);
  assert.equal(s8.filter(c => c.role === 'housePorter').length, 17);
  assert.ok(s8.slice(3580, 3589).every(c => c.role === 'map' && c.group === 0 && (c.type === 65 || c.type === 66)), 'the patrol ships are 17 ids later');
});

test('AO mission runs in the existing World (smoke)', { skip }, () => {
  const { world, mission, rules } = loadAddonMission('AmazonsAO.mdb', 0, GOLD, true);
  const ref = mapCreationOrder(stored(mission).file.objects, rules.rules);
  assert.equal(world.entities.length, ref.length);
  world.entities.forEach((e, i) => {
    assert.equal(e.id, ref[i].id + 1, 'engine ids are creation index + 1');
    assert.equal(e.oid & 0xffff, ref[i].type);
  });
  for (let i = 0; i < 300; i++) world.step();
  assert.ok(world.economy.towns.some(t => t.alive && t.race === 0));
});

// ---------------------------------------------------------------- InfiniteAO generator

const gen = HAS_GOLD ? islandGenerator() : null;
const sha = (b: ArrayBufferView) => createHash('sha256').update(new Uint8Array(b.buffer, b.byteOffset, b.byteLength)).digest('hex');
const PLAYERS = [{ race: 0, computer: false }, { race: 1, computer: true }, { race: 2, computer: true }];

function islandWorld(seed: number, bits: number, resources = 1) {
  return generateIslandWorld(seed, bits, gen!, { resources, players: PLAYERS, animalTypes: 7 });
}

test('island generator: deterministic terrain and population', { skip }, () => {
  for (const [seed, bits] of [[4242, 8], [1, 9]]) {
    const a = islandWorld(seed, bits), b = islandWorld(seed, bits);
    assert.equal(a.result.ok, true);
    assert.equal(a.seed, b.seed);
    for (const k of ['height', 'aoCls', 'cls', 'tile', 'island'] as const) assert.equal(sha(a.terrain[k]), sha(b.terrain[k]), k);
    assert.deepEqual(a.result.objects, b.result.objects);
    assert.deepEqual(a.result.lists, b.result.lists);
    assert.equal(a.terrain.randState, b.terrain.randState);
  }
  // the terrain alone is a pure function of the seed; different seeds differ
  assert.ok(sha(gen!(1, 8).height) !== sha(gen!(2, 8).height));
});

function checkWorld(w: ReturnType<typeof islandWorld>) {
  const t = w.terrain, n = t.size, mask = n - 1, bits = t.sizeBits;
  const at = (x: number, y: number) => ((y & mask) << bits) | (x & mask);
  // terrain rules of 9.4
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = at(x, y), c = t.aoCls[i], h = t.height[i];
    let landNb = false, seaNb = false;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy) { if (t.height[at(x + dx, y + dy)] > 120) landNb = true; else seaNb = true; }
    if (c >= AO_CLASS_SEA) { assert.equal(h, 120); assert.equal(c === AO_CLASS_WATER, landNb); }
    else {
      assert.ok(h > 120);
      if (c === AO_CLASS_BEACH) assert.ok(seaNb);
      else if (c === 2) assert.ok(h > 290);
    }
  }
  // exactly one water body (the ocean); every land cell carries its island id
  const water = bodiesBySize(labelRuns(bits, i => t.height[i] <= 120)).filter(b => b.size > 0);
  assert.equal(water.length, 1, 'inland lakes are filled');
  const land = labelLand(t);
  for (let k = 0; k < land.length; k++) assert.equal(t.island[(land.y[k] << bits) + land.x0[k]], land.label[k] & 0xff);
  // islands and starts: three different big islands, the three largest, in slot order
  const r = w.result, big = r.islands.filter(b => b.size >= 2000);
  assert.ok(big.length >= 4);
  const starts = r.starts as [number, number][];
  assert.equal(starts.length, 3);
  const isl = starts.map(([x, y]) => t.island[at(x, y)]);
  assert.equal(new Set(isl).size, 3);
  assert.deepEqual(isl.sort(), big.slice(0, 3).map(b => b.label & 0xff).sort());
  // objects: one per cell, nature off water and beach, fish on open sea only
  const cells = new Set<number>();
  for (const o of r.objects) {
    const i = at(o.x, o.y);
    assert.ok(!cells.has(i), 'one object per cell');
    cells.add(i);
    if (o.group !== 6) continue;
    if (o.type >= 41 && o.type <= 45) assert.equal(t.aoCls[i], AO_CLASS_SEA, 'fish in open sea');
    else {
      assert.ok(t.aoCls[i] < AO_CLASS_SEA && t.aoCls[i] !== AO_CLASS_BEACH && t.height[i] <= 290, 'nature on inland, below 291');
      assert.ok([9, 10, 11, 12, 38].indexOf(o.type) < 0, 'no base trees or rubble');
    }
  }
  const count = (lo: number, hi: number) => r.objects.filter(o => o.group === 6 && o.type >= lo && o.type <= hi).length;
  assert.ok(count(46, 49) > 100 && count(41, 45) > 100 && count(29, 32) > 10 && count(33, 40) > 10);
  assert.equal(r.objects.filter(o => o.group !== 6).length, 3);
  assert.ok(r.lists[0].length > 0 && r.lists[1].length > 0 && r.lists[3].length > 0 && r.lists[4].length === 0);
}

test('island world: terrain classes, islands, starts and nature constraints', { skip }, () => {
  for (const [seed, bits] of [[2, 8], [4242, 8], [1, 9], [777, 9]]) checkWorld(islandWorld(seed, bits));
  // fewer than four islands of 2000 cells on 256/512 maps: re-rolled until there are
  const w = islandWorld(1, 8);
  assert.ok(w.rerolls > 0 && w.seed !== 1);
});

test('island world: generation time for 512 maps', { skip }, () => {
  const times: number[] = [];
  for (const seed of [11, 12, 13, 14, 15]) {
    const t0 = performance.now();
    const w = islandWorld(seed, 9, 2);
    times.push(performance.now() - t0);
    assert.equal(w.result.ok, true);
  }
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  console.log(`InfiniteAO 512: ${times.map(t => t.toFixed(0)).join(' / ')} ms`);
  assert.ok(avg < 1500, `average ${avg.toFixed(0)} ms`);
});
