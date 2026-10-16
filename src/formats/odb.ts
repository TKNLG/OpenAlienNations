// dv.odb object rules. Spec: docs/formats/odb.md (field-by-field, section 2).

import { Bin } from './bin.ts';

export const ODB_RECORD = 0x18c;

export interface ObjectRule {
  id: number;            // group << 16 | type
  group: number;
  kind: number;          // 0 unit, 1 building, 2 nature/goods/effect
  type: number;
  name: string;
  sound: number;
  soundFrame: number;
  soundAction: number;
  sizeX: number;         // footprint width (x extent)
  sizeY: number;         // footprint height (y extent)
  doorDx: number;
  doorDy: number;
  hp: number;
  radius: number;        // sight / territory radius in cells
  residents: number;
  flags: number;
  cls: number;           // behaviour class
  stepTime: [number, number, number, number]; // ticks per straight step by height class; 0 = impassable
  money: number;         // unit training price / building upkeep / goods base price
  operator: number;      // unit type that runs the building, -1 none
  garrison: number;
  invention: number;     // -1 = always available
  madeAt: number;        // building type where it is ordered
  cost: number[];        // goods 0..8
  product: number;       // goods/nature type produced or yielded, -1 none
  amount: number;
  slot: number;
  needPop: number;
  message: number;
  weapon: number;        // dv.wdb index, -1 unarmed
  impact: number;
  /** +0x54..+0x90: per-facing launch point of a shooter, or per-slot garrison point of an outpost,
   *  in sprite-canvas pixels (odb.md, docs/rendering/projectiles.md 2.6) */
  points: [number, number][];
}

export const BuildingFlag = { TownStorage: 1, OnePerTown: 2, OperatorInside: 4, PortersVisit: 8 } as const;

export function parseOdb(buf: Uint8Array): Map<number, ObjectRule> {
  const b = new Bin(buf);
  const out = new Map<number, ObjectRule>();
  for (let o = 0; o + ODB_RECORD <= b.length; o += ODB_RECORD) {
    const i = (off: number) => b.i32(o + off);
    const r: ObjectRule = {
      id: i(0x00), group: i(0xa0), kind: i(0xa4), type: i(0xa8),
      name: b.cstr(o + 0x14c, 64).trimEnd(),
      sound: i(0x08), soundFrame: i(0x04), soundAction: i(0x134),
      sizeY: i(0x0c), sizeX: i(0x10), doorDx: i(0x94), doorDy: i(0x98),
      hp: i(0xac), radius: i(0xb0), residents: i(0xb4), flags: i(0xb8) >>> 0, cls: i(0xc0),
      stepTime: [i(0xc4), i(0xc8), i(0xcc), i(0xd0)],
      money: i(0xd4), operator: i(0xd8), garrison: i(0xdc), invention: i(0xe4), madeAt: i(0xe8),
      cost: Array.from({ length: 9 }, (_, k) => i(0xf0 + k * 4)),
      product: i(0x11c), amount: i(0x120), slot: i(0x124), needPop: i(0x128), message: i(0x130),
      weapon: i(0x144), impact: i(0x148),
      points: Array.from({ length: 8 }, (_, k): [number, number] => [i(0x54 + 8 * k), i(0x58 + 8 * k)]),
    };
    out.set(((r.group << 16) | r.type) >>> 0, r);
  }
  return out;
}

/** diagonal step time: floor(1.5 x straight) (odb.md 2.3) */
export const diagonalTicks = (straight: number) => Math.floor((straight * 3) / 2);
