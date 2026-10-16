// dv.wdb weapons (attacks). Spec: docs/formats/idb-wdb.md, behaviour: docs/game/combat.md

import { Bin } from './bin.ts';

export const WDB_RECORD = 116;
export const WeaponKind = { Melee: 1, Missile: 2, Heal: 3, Bomb: 4 } as const;

export interface Weapon {
  index: number;
  kind: number;
  /** group-7 projectile type, -1 = none */
  projectile: number;
  min: number; max: number;
  /** 0 = adjacent */
  range: number;
  speed: number;
  /** ticks between strikes before jitter */
  cooldown: number;
  hit: number;
  name: string;
}

export function parseWdb(buf: Uint8Array): Weapon[] {
  const b = new Bin(buf);
  const out: Weapon[] = [];
  for (let o = 0; o + WDB_RECORD <= b.length; o += WDB_RECORD) {
    out[b.i32(o)] = {
      index: b.i32(o), kind: b.i32(o + 4), projectile: b.i32(o + 8), min: b.i32(o + 0x0c), max: b.i32(o + 0x10),
      range: b.i32(o + 0x14), speed: b.i32(o + 0x1c), cooldown: b.i32(o + 0x20), hit: b.i32(o + 0x24),
      name: b.cstr(o + 0x34, 64).trimEnd(),
    };
  }
  return out;
}
