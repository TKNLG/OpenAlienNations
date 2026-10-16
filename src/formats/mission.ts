// Mission records (*.mdb) and maps (*.dvm). Specs: docs/formats/dvm.md, terrain-gen.md

import { Bin } from './bin.ts';

export const MISSION_RECORD_SIZE = 3864;

export interface RaceSetup {
  race: number;              // 0 Amazons, 1 Pimmons, 2 Sajiki
  present: boolean;
  computer: boolean;
  aiProfile: number;         // -1 = random
  gold: number;
  relations: number[];       // to race 0..2: 0 none, 1 war, 2 ceasefire, 3 peace
  startGoods: [number, number][]; // per good 0..8: [first town hall, second town hall]
  researchLevel: number;
  disabled: number[];        // object types (own group) that cannot be built/trained
  /** per invention 0..32: flags at race block +0x80 + 4i. Base files only use 0..29; +0xF8..+0x100
   *  are the Gold add-on inventions 30..32 (docs/formats/addon.md 6), 0 in every base file */
  preResearched: boolean[];
}

export interface Goal {
  /** 1..16 base (docs/formats/mdb.md "Goals"), 17..20 Gold Edition (docs/formats/addon.md 7.2) */
  type: number;
  defeat: boolean;  // true = loss condition
  p1: number; p2: number; p3: number;
}

export interface Mission {
  index: number;
  goals: Goal[];
  /** campaign position (record field +0x00); missions are played in this order */
  order: number;
  title: string;
  briefing: string;
  mapFile: string;
  races: RaceSetup[];
  /** the race the human plays (present and not computer), -1 if none */
  humanRace: number;
  /** terrain seed; -1 = random map, -2 = no generated terrain */
  seed: number;
  /** free play / multiplayer random map: "Anzahl Rohstoffe" 0..2 for the world populator
   *  (docs/formats/world-populate.md); not part of the record */
  resources?: number;
  /** map is (1 << sizeBits) cells square */
  sizeBits: number;
  /** Gold Edition add-on ("AO") mission: record field +0xA50 >= 1 (docs/formats/addon.md 1.1).
   *  Set by parseMdb; absent on hand-built records = base mission */
  addon?: boolean;
}

/** goal types added by the Gold Edition (docs/formats/addon.md 7.2); evaluated in every mission */
export const GoalType = {
  /** object #p1 exists and lies within torus distance p3 of cell p2 = (x << 16) | y */
  ObjectNear: 17,
  /** object #p1 does not exist, is dead, or its type is not p2 */
  ObjectGone: 18,
  /** the player's settlements on island p1 own at least p3 objects of type p2 */
  IslandObjects: 19,
  /** stock of good p1 in the player's city p3 (1-based) is <= p2; false without that city */
  StockAtMost: 20,
} as const;

/** the cell packed into p2 of goal type 17: (x << 16) | y */
export const goalCell = (p2: number): [number, number] => [(p2 >>> 16) & 0xffff, p2 & 0xffff];

export function parseMdb(buf: Uint8Array): Mission[] {
  const b = new Bin(buf);
  const out: Mission[] = [];
  for (let i = 0; (i + 1) * MISSION_RECORD_SIZE <= b.length; i++) {
    const o = i * MISSION_RECORD_SIZE;
    const races: RaceSetup[] = [0, 1, 2].map(r => {
      const rb = o + 0xb1c + r * 0x154;
      return {
        race: r,
        present: b.i32(rb) !== 0,
        computer: b.i32(rb + 4) !== 0,
        aiProfile: b.i32(rb + 8) - 1,
        gold: b.i32(rb + 0x0c),
        relations: [0, 1, 2].map(k => b.i32(rb + 0x10 + k * 4)),
        startGoods: Array.from({ length: 9 }, (_, g) => [b.i32(rb + 0x1c + g * 8), b.i32(rb + 0x20 + g * 8)] as [number, number]),
        researchLevel: b.i32(rb + 0x64),
        disabled: [...[0, 1, 2].map(k => b.i32(rb + 0x68 + k * 4)), ...[0, 1, 2].map(k => b.i32(rb + 0x74 + k * 4))].filter(t => t !== 0),
        preResearched: Array.from({ length: 33 }, (_, k) => b.i32(rb + 0x80 + k * 4) !== 0),
      };
    });
    out.push({
      index: i, order: b.i32(o), title: b.cstr(o + 4, 64), briefing: b.cstr(o + 0x44, 2500),
      mapFile: b.cstr(o + 0xa08, 64), races,
      goals: Array.from({ length: 10 }, (_, k) => o + 0xa54 + k * 20)
        .map(g => ({ type: b.i32(g), defeat: b.i32(g + 4) !== 0, p1: b.i32(g + 8), p2: b.i32(g + 12), p3: b.i32(g + 16) }))
        .filter(g => g.type !== 0),
      humanRace: races.findIndex(r => r.present && !r.computer),
      seed: b.i32(o + 0xa48), sizeBits: b.u32(o + 0xa4c),
      addon: b.i32(o + 0xa50) >= 1,
    });
  }
  return out;
}

export interface MapObject {
  /** 0 unit, 1 building, 2 nature */
  cls: number;
  group: number;
  type: number;
  /** settlement id the object belongs to (defined by the map's town hall), -1 for nature */
  owner: number;
  x: number;
  y: number;
  z: number;
  /** Gold Edition: unit types carried by a transport ship (type 67), created inside it after all
   *  other units (docs/formats/addon.md 8.2, 8.4). Only present on type-67 unit records read with
   *  `DvmLayout.cargo` */
  cargo?: number[];
}

/**
 * How to read a .dvm file. The file has no marker for either extension: the mission record decides
 * (docs/formats/addon.md 8.2). The default ({}) is the base layout.
 */
export interface DvmLayout {
  /** the mission's seed is -2: an n x n terrain block (n = 1 << terrainBits) follows the header */
  terrainBits?: number;
  /** Gold loader: a type-67 unit record is followed by its cargo list */
  cargo?: boolean;
}

/** the layout the Gold Edition loader uses for a mission's map */
export function dvmLayout(m: Pick<Mission, 'seed' | 'sizeBits'>): DvmLayout {
  return { terrainBits: m.seed === -2 ? m.sizeBits : undefined, cargo: true };
}

/** the stored terrain of an add-on map: per cell (index y*n + x) ground height and global tile number */
export interface StoredTerrain { sizeBits: number; height: Uint16Array; tile: Uint8Array; }

export interface DvmFile {
  objects: MapObject[];
  terrain: StoredTerrain | null;
  extras: MapExtras;
  /** bytes after the trailing block (0 for every shipped map) */
  rest: number;
}

const TRANSPORT_SHIP = 67, NATURE_GROUP = 6;

/** read a whole .dvm file (objects, stored terrain, trailing block) */
export function parseDvmFile(buf: Uint8Array, layout: DvmLayout = {}): DvmFile {
  const b = new Bin(buf);
  if (b.u32(0) !== 0x44564d53) throw new Error('not a .dvm map (missing SMVD magic)');
  const count = b.u32(8);
  let o = 12;
  let terrain: StoredTerrain | null = null;
  if (layout.terrainBits !== undefined) {
    const bits = layout.terrainBits, cells = 1 << (2 * bits);
    if (o + cells * 3 > b.length) throw new Error('.dvm map too short for its terrain block');
    const height = new Uint16Array(cells), tile = new Uint8Array(cells);
    for (let i = 0; i < cells; i++, o += 3) { height[i] = b.u16(o); tile[i] = b.u8(o + 2); }
    terrain = { sizeBits: bits, height, tile };
  }
  const objects: MapObject[] = [];
  for (let i = 0; i < count; i++) {
    if (o + 28 > b.length) throw new Error('.dvm map truncated in its object records');
    const obj: MapObject = {
      cls: b.i32(o), group: b.i32(o + 4), type: b.i32(o + 8), owner: b.i32(o + 12),
      x: b.i32(o + 16), y: b.i32(o + 20), z: b.i32(o + 24),
    };
    o += 28;
    // a unit record (class 0, group-6 records count as nature) of the transport ship type
    if (layout.cargo && obj.cls === 0 && obj.group !== NATURE_GROUP && obj.type === TRANSPORT_SHIP) {
      const n = b.u32(o); o += 4;
      obj.cargo = [];
      for (let k = 0; k < n; k++, o += 4) obj.cargo.push(b.i32(o));
    }
    objects.push(obj);
  }
  const [extras, end] = readExtras(b, o);
  return { objects, terrain, extras, rest: Math.max(0, b.length - end) };
}

export function parseDvm(buf: Uint8Array, layout?: DvmLayout): MapObject[] {
  if (layout) return parseDvmFile(buf, layout).objects;
  const b = new Bin(buf);
  if (b.u32(0) !== 0x44564d53) throw new Error('not a .dvm map (missing SMVD magic)');
  const count = b.u32(8);
  const out: MapObject[] = [];
  for (let i = 0; i < count; i++) {
    const o = 12 + i * 28;
    out.push({
      cls: b.i32(o), group: b.i32(o + 4), type: b.i32(o + 8), owner: b.i32(o + 12),
      x: b.i32(o + 16), y: b.i32(o + 20), z: b.i32(o + 24),
    });
  }
  return out;
}

export const objectId = (group: number, type: number) => ((group << 16) | type) >>> 0;

/** an initial job from the map: the object on (x1, y1) gets a job aimed at (x2, y2) (dvm.md "Orders") */
export interface MapOrder { x1: number; y1: number; x2: number; y2: number; }

export interface MapExtras {
  /** forest, stone, bush regions, start candidates, start positions */
  lists: [number, number][][];
  camera: [number, number];
  orders: MapOrder[];
}

/** the trailing block after the object records (dvm.md "Trailing block"); pass the mission's
 *  layout (dvmLayout) for add-on maps, whose terrain block and cargo lists come before it */
export function parseDvmExtras(buf: Uint8Array, layout?: DvmLayout): MapExtras {
  if (layout) return parseDvmFile(buf, layout).extras;
  const b = new Bin(buf);
  return readExtras(b, 12 + b.u32(8) * 28)[0];
}

function readExtras(b: Bin, start: number): [MapExtras, number] {
  let o = start;
  const lists: [number, number][][] = [];
  for (let k = 0; k < 5 && o + 4 <= b.length; k++) {
    const n = b.u32(o); o += 4;
    const l: [number, number][] = [];
    for (let i = 0; i < n; i++, o += 12) l.push([b.i32(o), b.i32(o + 4)]);
    lists.push(l);
  }
  while (lists.length < 5) lists.push([]);
  const camera: [number, number] = o + 8 <= b.length ? [b.i32(o), b.i32(o + 4)] : [0, 0];
  o += 8;
  const orders: MapOrder[] = [];
  const n = o + 4 <= b.length ? b.u32(o) : 0; o += 4;
  for (let i = 0; i < n && o + 24 <= b.length; i++, o += 24) orders.push({ x1: b.i32(o), y1: b.i32(o + 4), x2: b.i32(o + 12), y2: b.i32(o + 16) });
  return [{ lists, camera, orders }, o];
}
