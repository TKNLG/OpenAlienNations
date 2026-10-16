// .dvf bitmap fonts. Spec: docs/formats/os-dvf-tdb.md

import { Bin } from './bin.ts';

export interface Glyph { width: number; /** width*height coverage bytes */ data: Uint8Array; }

export interface Font {
  height: number;
  baseline: number;
  /** keyed by cp1252 code */
  glyphs: Map<number, Glyph>;
}

export function parseDvf(buf: Uint8Array): Font {
  const b = new Bin(buf);
  if (b.u32(0) !== 0x666f6e74) throw new Error('not a .dvf font (missing "tnof" magic)');
  const count = b.u32(4), height = b.u32(8), baseline = b.u32(12);
  const glyphs = new Map<number, Glyph>();
  for (let i = 0; i < count; i++) {
    const o = 16 + i * 16;
    const code = b.u32(o), width = b.u32(o + 4), off = b.u32(o + 8);
    glyphs.set(code, { width, data: buf.subarray(off, off + width * height) });
  }
  return { height, baseline, glyphs };
}
