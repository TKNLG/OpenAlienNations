// Gold Edition / mission pack ("AO") data loading: which files a mission reads and how the add-on
// files are merged into the base tables. Spec: docs/formats/addon.md 1.2, 2, 3, 4, 5, 6.
//
// The add-on files use the base formats; each is loaded a second time into the same table:
//   rules       dv.odb   + Addon.odb  (by (group, type); table width 62 -> 68 types per group)
//   sprites     dv.OD    + Addon.od   (by object id); dv.gd + Addon.gd (names resolved across both)
//   weapons     dv.wdb   + addon.wdb  (by the record's index field: 0..20 + 21..27)
//   strings     DV.tdb   + Addon.tdb  (ids 325..330; loaded in base AND add-on games)
//   inventions  <race>/DV.idb (30)  ->  <race>/AO.idb (33) instead
// File names are matched case-insensitively by the original; the `read` callbacks below get the
// canonical names and must resolve case themselves (the server and test helpers do).

import { parseOdb, type ObjectRule } from './odb.ts';
import { parseOd, type ObjectDesc } from './od.ts';
import { parseWdb, type Weapon } from './wdb.ts';
import { parseTdb } from './tdb.ts';
import { parseIdb, type Invention } from './idb.ts';
import type { MapObject } from './mission.ts';

/** object types per group: base missions 0..61, add-on missions 0..67 (addon.md 1.2, 2) */
export const BASE_TABLE_WIDTH = 62;
export const ADDON_TABLE_WIDTH = 68;

/** race folders (case differs between installs: GOG `AMAZONS`, Gold `Amazons`) */
export const RACE_DIRS = ['AMAZONS', 'PIMONS', 'SAJIKI'] as const;

/** data files (relative to the data folder) read by a base or an add-on mission */
export function ruleFiles(addon: boolean) {
  return {
    odb: addon ? ['dv.odb', 'Addon.odb'] : ['dv.odb'],
    od: addon ? ['dv.OD', 'Addon.od'] : ['dv.OD'],
    gd: addon ? ['dv.gd', 'Addon.gd'] : ['dv.gd'],
    wdb: addon ? ['dv.wdb', 'addon.wdb'] : ['dv.wdb'],
    /** Addon.tdb is loaded at start-up in every game when present (addon.md 5) */
    tdb: ['DV.tdb', 'Addon.tdb'],
    idb: RACE_DIRS.map(d => `${d}/${addon ? 'AO.idb' : 'DV.idb'}`),
    /** loading screen and briefing art (mainmenu.gd entries, addon.md 3.2) */
    loading: addon ? 'LOADING_B' : 'LOADING',
  };
}

/** new type numbers (addon.md 2.1) */
export const AddonType = {
  Harbour: 62, Shipyard: 63, FishingBoat: 64, SmallWarship: 65, LargeWarship: 66, Transport: 67,
  Gecko: 39, Crab: 40, FishFirst: 41, FishLast: 45, PalmFirst: 46, PalmLast: 49, Aloe: 50, Venus: 51,
} as const;

/** new behaviour classes (odb +0xC0, addon.md 2.3, 2.4) */
export const AddonClass = { Ship: 14, Fish: 15 } as const;

/** new building/unit flag bits (odb +0xB8, addon.md 2.5) */
export const AddonFlag = { AddsCapacity: 0x10, TradingPost: 0x20, Carrier: 0x40, WearsPaths: 0x80 } as const;

/** add-on strings (Addon.tdb, addon.md 5) */
export const AddonString = { AddonToggle: 325, AddonCampaigns: 326, ToFishingGrounds: 327, Fishing: 328, OnBoard: 329, Unload: 330 } as const;

/**
 * Second load of an odb file into the same table: records are added by (group, type), a record
 * whose type is not below the table width is dropped (addon.md 2). Returns a new map.
 */
export function mergeOdb(base: Map<number, ObjectRule>, extra: Map<number, ObjectRule>, width = ADDON_TABLE_WIDTH): Map<number, ObjectRule> {
  const out = new Map<number, ObjectRule>();
  for (const [id, r] of base) if (r.type >= 0 && r.type < width) out.set(id, r);
  for (const [id, r] of extra) if (r.type >= 0 && r.type < width) out.set(id, r);
  return out;
}

/** second load of an .OD file: object descriptions added by object id (addon.md 3.1) */
export function mergeOd(base: Map<number, ObjectDesc>, extra: Map<number, ObjectDesc>): Map<number, ObjectDesc> {
  const out = new Map(base);
  for (const [id, d] of extra) out.set(id, d);
  return out;
}

/** second load of a .wdb file: each record is stored at its index field (addon.md 4) */
export function mergeWdb(base: Weapon[], extra: Weapon[]): Weapon[] {
  const out = base.slice();
  extra.forEach((w, i) => { if (w) out[i] = w; });
  return out;
}

/** Addon.tdb loaded after DV.tdb into the same string table (addon.md 5) */
export function mergeTdb(base: Map<number, string>, extra: Map<number, string>): Map<number, string> {
  const out = new Map(base);
  for (const [id, s] of extra) out.set(id, s);
  return out;
}

/** number of nature records with behaviour class 7 (animals): 5 base, 7 add-on (addon.md 10.3) */
export function animalTypeCount(rules: Map<number, ObjectRule>): number {
  let n = 0;
  for (const r of rules.values()) if (r.group === 6 && r.kind === 2 && r.cls === 7) n++;
  return n;
}

export interface Rules {
  addon: boolean;
  /** types per group (62 / 68) */
  tableWidth: number;
  rules: Map<number, ObjectRule>;
  /** null when the .OD files were not requested */
  objects: Map<number, ObjectDesc> | null;
  weapons: Weapon[];
  strings: Map<number, string>;
  /** per race 0 Amazons, 1 Pimmons, 2 Sajiki: 30 (DV.idb) or 33 (AO.idb) inventions */
  inventions: Invention[][];
}

/** file reader relative to the data folder; returns null for a missing file */
export type ReadFile = (path: string) => Uint8Array | null;
export type ReadFileAsync = (path: string) => Promise<Uint8Array | null>;

export interface LoadRulesOptions {
  /** also parse the .OD sprite descriptions (default true) */
  objects?: boolean;
}

function need(name: string, b: Uint8Array | null): Uint8Array {
  if (!b) throw new Error(`missing data file ${name}`);
  return b;
}

/** build the rule tables from already read files (index-aligned with ruleFiles(addon)) */
function assemble(addon: boolean, f: {
  odb: (Uint8Array | null)[]; od: (Uint8Array | null)[] | null; wdb: (Uint8Array | null)[];
  tdb: (Uint8Array | null)[]; idb: (Uint8Array | null)[];
}): Rules {
  const names = ruleFiles(addon);
  const width = addon ? ADDON_TABLE_WIDTH : BASE_TABLE_WIDTH;
  let rules = mergeOdb(parseOdb(need(names.odb[0], f.odb[0])), new Map(), width);
  if (addon) rules = mergeOdb(rules, parseOdb(need(names.odb[1], f.odb[1])), width);
  let objects: Map<number, ObjectDesc> | null = null;
  if (f.od) {
    objects = parseOd(need(names.od[0], f.od[0]));
    if (addon) objects = mergeOd(objects, parseOd(need(names.od[1], f.od[1])));
  }
  let weapons = parseWdb(need(names.wdb[0], f.wdb[0]));
  if (addon) weapons = mergeWdb(weapons, parseWdb(need(names.wdb[1], f.wdb[1])));
  let strings = parseTdb(need(names.tdb[0], f.tdb[0]));
  if (f.tdb[1]) strings = mergeTdb(strings, parseTdb(f.tdb[1]));
  const inventions = f.idb.map((b, i) => parseIdb(need(names.idb[i], b)));
  return { addon, tableWidth: width, rules, objects, weapons, strings, inventions };
}

/** load the rule tables of a base (addon = false) or add-on mission */
export function loadRules(read: ReadFile, addon: boolean, opt: LoadRulesOptions = {}): Rules {
  const n = ruleFiles(addon);
  return assemble(addon, {
    odb: n.odb.map(read), od: opt.objects === false ? null : n.od.map(read),
    wdb: n.wdb.map(read), tdb: n.tdb.map(read), idb: n.idb.map(read),
  });
}

/** async variant for the browser client (fetch-based readers) */
export async function loadRulesAsync(read: ReadFileAsync, addon: boolean, opt: LoadRulesOptions = {}): Promise<Rules> {
  const n = ruleFiles(addon);
  const all = (l: string[]) => Promise.all(l.map(read));
  const [odb, od, wdb, tdb, idb] = await Promise.all([
    all(n.odb), opt.objects === false ? Promise.resolve(null) : all(n.od), all(n.wdb), all(n.tdb), all(n.idb),
  ]);
  return assemble(addon, { odb, od, wdb, tdb, idb });
}

// ---------------------------------------------------------------- map creation order (addon.md 8.4)

export type CreatedRole = 'map' | 'founder' | 'builder' | 'porter' | 'operator' | 'housePorter' | 'archer' | 'cargo';

export interface CreatedObject {
  /** object id = creation index (goals 17/18 refer to it) */
  id: number;
  role: CreatedRole;
  /** 0 unit, 1 building, 2 nature */
  cls: number;
  group: number;
  type: number;
  x: number;
  y: number;
  /** index of the map record that created it (the record itself, or its building / ship) */
  record: number;
}

const T_PORTER = 9, T_FOUNDER = 10, T_BUILDER = 11, T_ARCHER = 29, T_TOWN_HALL = 40;
const HOUSES = [37, 38];
const OUTPOST_CLASS = 6;

/**
 * The ids the Gold loader hands out for a map's objects, in creation order (addon.md 8.4): nature;
 * town halls with founder, builder and two porters; other buildings of an existing settlement with
 * operator, one house porter (houses 37/38) or the outpost archers; units; transport cargo.
 * A reference for the engine's loader and for resolving goal 17/18 object numbers.
 */
export function mapCreationOrder(objects: MapObject[], rules: Map<number, ObjectRule>): CreatedObject[] {
  const out: CreatedObject[] = [];
  const add = (role: CreatedRole, cls: number, group: number, type: number, o: MapObject, record: number) =>
    out.push({ id: out.length, role, cls, group, type, x: o.x, y: o.y, record });
  const rule = (g: number, t: number) => rules.get(((g << 16) | t) >>> 0);
  const isNature = (o: MapObject) => o.group === 6 || o.cls === 2;
  objects.forEach((o, i) => { if (isNature(o)) add('map', 2, 6, o.type, o, i); });
  const towns = new Set<string>();
  objects.forEach((o, i) => {
    if (isNature(o) || o.cls !== 1 || o.type !== T_TOWN_HALL) return;
    towns.add(`${o.group}:${o.owner}`);
    add('map', 1, o.group, o.type, o, i);
    const op = rule(o.group, o.type)?.operator ?? T_FOUNDER;
    if (op >= 0) add('founder', 0, o.group, op, o, i);
    add('builder', 0, o.group, T_BUILDER, o, i);
    add('porter', 0, o.group, T_PORTER, o, i);
    add('porter', 0, o.group, T_PORTER, o, i);
  });
  objects.forEach((o, i) => {
    if (isNature(o) || o.cls !== 1 || o.type === T_TOWN_HALL || !towns.has(`${o.group}:${o.owner}`)) return;
    add('map', 1, o.group, o.type, o, i);
    const r = rule(o.group, o.type);
    if (r && r.operator >= 0) add('operator', 0, o.group, r.operator, o, i);
    if (HOUSES.includes(o.type)) add('housePorter', 0, o.group, T_PORTER, o, i);
    if (r && r.cls === OUTPOST_CLASS) for (let k = 0; k < r.garrison; k++) add('archer', 0, o.group, T_ARCHER, o, i);
  });
  objects.forEach((o, i) => { if (!isNature(o) && o.cls === 0) add('map', 0, o.group, o.type, o, i); });
  objects.forEach((o, i) => {
    if (!isNature(o) && o.cls === 0 && o.cargo) for (const t of o.cargo) add('cargo', 0, o.group, t, o, i);
  });
  return out;
}
