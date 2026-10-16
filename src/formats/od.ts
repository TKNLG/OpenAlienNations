// dv.OD object descriptions: object id -> anchor, bounds, animation descriptor per slot.
// Spec: docs/formats/od-odb.md, descriptor and layer records: docs/rendering/objects.md 1.

import { Bin } from './bin.ts';

/** layer role / playback flags (objects.md 1) */
export const LayerFlag = {
  PingPong: 0x01,
  Once: 0x02,
  Reverse: 0x04,
  Callback: 0x08,
  Door: 0x10,
  Work: 0x20,
  Random: 0x40,
} as const;

/** one layer record of an animation descriptor (32 bytes) */
export interface OdLayer {
  /** sprite name in dv.gd */
  name: string;
  /** layer rectangle in sprite canvas coordinates (= the dv.gd entry rectangle) */
  rect: [number, number, number, number];
  /** frames per second; -1 = default (7) */
  speed: number;
  /** LayerFlag bits; 0 on the main layer */
  flags: number;
  frames: number;
}

export interface ObjectDesc {
  id: number;          // group << 16 | type
  kind: number;        // 0 creature/nature, 1 building, 2 other
  anchorX: number;
  anchorY: number;
  bounds: [number, number, number, number];
  /** main sprite name per slot, null where the slot is empty */
  slots: (string | null)[];
  /** all layers per slot in drawing order (layer 0 = the main sprite), null where empty */
  layers: (OdLayer[] | null)[];
}

const RECORD_SIZE: Record<number, number> = { 0: 0xc4, 1: 0x2c, 2: 0x28 };

/** read the layer list of the descriptor at `off` (objects.md 1) */
export function parseDescriptor(b: Bin, off: number, name: (no: number) => string): OdLayer[] {
  const count = b.u32(off + 0x10);
  const out: OdLayer[] = [];
  for (let k = 0; k < count; k++) {
    const l = off + 0x20 + 32 * k;
    out.push({
      rect: [b.i32(l), b.i32(l + 4), b.i32(l + 8), b.i32(l + 12)],
      speed: b.i32(l + 0x10), flags: b.u32(l + 0x14), frames: b.u32(l + 0x18), name: name(b.u32(l + 0x1c)),
    });
  }
  return out;
}

export function parseOd(buf: Uint8Array): Map<number, ObjectDesc> {
  const b = new Bin(buf);
  const namesOff = b.u32(4), nameIndexOff = b.u32(8), recordsOff = b.u32(12), animBase = b.u32(16);
  const count = b.u32(24);
  const name = (no: number) => b.cstr(namesOff + b.u32(nameIndexOff + no * 4));
  const out = new Map<number, ObjectDesc>();
  let off = recordsOff;
  for (let i = 0; i < count; i++) {
    const kind = b.u32(off + 4);
    const size = RECORD_SIZE[kind];
    if (size === undefined) throw new Error(`unknown .OD record kind ${kind}`);
    const nSlots = (size - 0x24) / 4;
    const slots: (string | null)[] = [];
    const layers: (OdLayer[] | null)[] = [];
    for (let s = 0; s < nSlots; s++) {
      const ref = b.i32(off + 0x24 + s * 4);
      if (ref === -1) { slots.push(null); layers.push(null); continue; }
      const ls = parseDescriptor(b, animBase + ref, name);
      // the main layer name sits at descriptor +0x3C even if a count were 0
      slots.push(ls.length ? ls[0].name : name(b.u32(animBase + ref + 0x3c)));
      layers.push(ls.length ? ls : null);
    }
    const id = b.u32(off + 8);
    out.set(id, {
      id, kind,
      anchorX: b.i32(off + 12), anchorY: b.i32(off + 16),
      bounds: [b.i32(off + 20), b.i32(off + 24), b.i32(off + 28), b.i32(off + 32)],
      slots, layers,
    });
    off += size;
  }
  return out;
}
