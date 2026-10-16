// DV.idb research tree of one race. Spec: docs/formats/idb-wdb.md

import { Bin } from './bin.ts';

export const IDB_RECORD = 212;

export interface Invention {
  index: number;
  prerequisites: number[];   // invention indices, unused slots dropped
  cost: number;
  name: string;
  description: string;
}

export function parseIdb(buf: Uint8Array): Invention[] {
  const b = new Bin(buf);
  const out: Invention[] = [];
  for (let o = 0; o + IDB_RECORD <= b.length; o += IDB_RECORD) {
    out.push({
      index: b.i32(o),
      prerequisites: [b.i32(o + 4), b.i32(o + 8), b.i32(o + 12)].filter(p => p >= 0),
      cost: b.i32(o + 0x10),
      name: b.cstr(o + 0x14, 32).trimEnd(),
      description: b.cstr(o + 0x34, 160).trimEnd(),
    });
  }
  out.sort((a, c) => a.index - c.index);
  return out;
}
