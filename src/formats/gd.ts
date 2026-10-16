// .gd sprite archives. Spec: docs/formats/gd.md
//
// The index (names + descriptors) is small and read up front. Pixel blocks are fetched lazily,
// so a browser only downloads the sprites it actually draws.

import { Bin } from './bin.ts';

export interface GdEntry {
  name: string;
  left: number; top: number; right: number; bottom: number;
  width: number; height: number;
  frames: number;
  encoding: number;
  /** absolute file offset of the pixel block */
  dataOffset: number;
  /** byte length of the pixel block (from the block header; filled once known) */
  dataLength: number;
}

export interface GdIndex {
  entries: GdEntry[];
  byName: Map<string, GdEntry>;
  /** bytes of the file that must be read to parse the index */
  indexSize: number;
}

/** Number of leading bytes needed before parseGdIndex can run: read the header first. */
export function gdIndexSize(header: Uint8Array): number {
  const b = new Bin(header);
  return b.u32(16); // pixels_off: everything before it is index
}

export function parseGdIndex(buf: Uint8Array, fileSize: number): GdIndex {
  const b = new Bin(buf);
  const namesOff = b.u32(0), nameIndexOff = b.u32(8), recordsOff = b.u32(12);
  const pixelsOff = b.u32(16), count = b.u32(20);
  const entries: GdEntry[] = [];
  let off = recordsOff;
  for (let i = 0; i < count; i++) {
    const size = b.u32(off), kind = b.u32(off + 4), nameNo = b.u32(off + 8);
    let next = off + size;
    if (kind === 0) {
      const d = next;
      const left = b.i32(d + 4), top = b.i32(d + 8), right = b.i32(d + 12), bottom = b.i32(d + 16);
      entries.push({
        name: b.cstr(namesOff + b.u32(nameIndexOff + nameNo * 4)),
        left, top, right, bottom,
        width: right - left, height: bottom - top,
        frames: b.u32(d + 36),
        encoding: b.u16(d + 40),
        dataOffset: pixelsOff + b.u32(d + 44),
        dataLength: 0,
      });
      next += 52;
    }
    off = next;
  }
  // Pixel blocks are stored contiguously (in reverse entry order), so each block ends where the
  // next-higher block starts; the last one ends at end of file.
  const sorted = [...entries].sort((a, c) => a.dataOffset - c.dataOffset);
  for (let i = 0; i < sorted.length; i++) {
    const end = i + 1 < sorted.length ? sorted[i + 1].dataOffset : fileSize;
    sorted[i].dataLength = end - sorted[i].dataOffset;
  }
  const byName = new Map(entries.map(e => [e.name, e]));
  return { entries, byName, indexSize: pixelsOff };
}

/**
 * Decode frames 0..lastFrame of a sprite. Returns one RGBA (straight alpha) buffer per frame,
 * width*height*4 bytes each. `block` is the entry's pixel block (starting at dataOffset).
 * `forceOpaque`: every written pixel gets alpha 255 (menu backgrounds, docs/ui/front-end.md 1.1).
 * `autoOpaque`: decode opaque when the sprite writes colour but never alpha (interface panels;
 * see docs/formats/gd.md "Images without alpha"). Off for world sprites: some of their door
 * frames store invisible pixels as colour with alpha 0.
 */
export function decodeGdFrames(e: GdEntry, block: Uint8Array, lastFrame = e.frames - 1, forceOpaque = false, autoOpaque = false): Uint8Array[] {
  if (e.encoding !== 4) throw new Error(`unsupported .gd encoding ${e.encoding} in ${e.name}`);
  const b = new Bin(block);
  const w = e.width, h = e.height;
  // locate frame streams by following the chain
  const starts = new Map<number, number>();
  let f = b.u32(12);
  for (let i = 0; i < e.frames; i++) {
    const idx = b.i32(f), next = b.u32(f + 4);
    starts.set(idx, f + 8);
    if (next === 0) break;
    f += next;
  }
  const decode = (opaque: boolean) => {
    const canvas = new Uint32Array(w * h); // premultiplied 0xAARRGGBB, transparent black
    const out: Uint8Array[] = [];
    let seen = { alpha: 0, colour: 0 };
    for (let fi = 0; fi <= lastFrame; fi++) {
      const p0 = starts.get(fi);
      if (p0 === undefined) throw new Error(`frame ${fi} missing in ${e.name}`);
      const s = applyFrame(b, p0, canvas, w, opaque);
      seen = { alpha: seen.alpha | s.alpha, colour: seen.colour | s.colour };
      out.push(toStraightRgba(canvas));
    }
    return { out, seen };
  };
  if (forceOpaque) return decode(true).out;
  const first = decode(false);
  // A few full-screen images (e.g. INTERFACE1024) carry colour but alpha 0 everywhere; the game
  // draws those opaque (see docs/formats/gd.md "Images without alpha").
  if (autoOpaque && first.seen.alpha === 0 && first.seen.colour !== 0) return decode(true).out;
  return first.out;
}

/** returns the OR of all alpha values and of all colour values written */
function applyFrame(b: Bin, p: number, canvas: Uint32Array, w: number, opaque: boolean): { alpha: number; colour: number } {
  let row = 0, cur = 0, alpha = 0, colour = 0;
  const px = (raw: number) => {
    alpha |= raw >>> 24; colour |= raw & 0xffffff;
    return opaque ? (raw | 0xff000000) >>> 0 : clampPremul(raw);
  };
  for (;;) {
    const op = b.u16(p);
    const cmd = op & 0xf, n = op >>> 4;
    switch (cmd) {
      case 0: // n+1 literal pixels
        for (let i = 0; i <= n; i++) canvas[cur++] = px(b.u32(p + 2 + i * 4));
        p += 2 + (n + 1) * 4;
        break;
      case 1: { // one pixel n+2 times
        const c = px(b.u32(p + 2));
        for (let i = 0; i < n + 2; i++) canvas[cur++] = c;
        p += 6;
        break;
      }
      case 2: // next row(s)
        row += n + 1;
        cur = row * w;
        p += 2;
        break;
      case 3: // skip pixels
        cur += n + 1;
        p += 2;
        break;
      case 4:
        return { alpha, colour };
      default:
        throw new Error(`bad .gd opcode ${cmd}`);
    }
  }
}

function clampPremul(c: number): number {
  const a = c >>> 24;
  const r = Math.min((c >>> 16) & 0xff, a), g = Math.min((c >>> 8) & 0xff, a), bl = Math.min(c & 0xff, a);
  return ((a << 24) | (r << 16) | (g << 8) | bl) >>> 0;
}

function toStraightRgba(canvas: Uint32Array): Uint8Array {
  const out = new Uint8Array(canvas.length * 4);
  for (let i = 0; i < canvas.length; i++) {
    const c = canvas[i], a = c >>> 24;
    if (a === 0) continue;
    const k = 255 / a;
    out[i * 4] = Math.min(255, Math.round(((c >>> 16) & 0xff) * k));
    out[i * 4 + 1] = Math.min(255, Math.round(((c >>> 8) & 0xff) * k));
    out[i * 4 + 2] = Math.min(255, Math.round((c & 0xff) * k));
    out[i * 4 + 3] = a;
  }
  return out;
}
