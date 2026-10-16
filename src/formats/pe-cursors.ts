// Mouse cursors in a Windows executable's resources (the game's own cursors live only there).
// Spec: docs/ui/cursors.md 2 (the six cursor groups, pixel rule) and 7 (art source). The PE and
// resource layouts are the standard Windows formats (PE/COFF headers, resource directory tree,
// RT_GROUP_CURSOR = 12 pointing at RT_CURSOR = 1 images: hotspot + BITMAPINFOHEADER + palette +
// colour (XOR) bitmap + AND mask, rows bottom-up).
//
// Pure functions on bytes: no DOM, so they are tested in node on the real executables.

export const RT_CURSOR = 1;
export const RT_GROUP_CURSOR = 12;

export interface PeSection { name: string; vaddr: number; vsize: number; rawOff: number; rawSize: number; }
export interface PeLayout { sections: PeSection[]; resRva: number; resSize: number; }

/** a decoded cursor image: RGBA, top row first */
export interface CursorImage {
  width: number;
  height: number;
  hotX: number;
  hotY: number;
  rgba: Uint8Array;
  /** pixels the original would invert (AND 1 with a non-black colour); drawn opaque black here */
  inverted: number;
}

/** a cursor group (RT_GROUP_CURSOR) with the image of its first (only) entry */
export interface CursorGroup extends CursorImage { group: number; image: number; }

const dv = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

/**
 * Headers and section table from the start of the file. `head` must reach past the section
 * table (the first 4 KB are enough for ordinary executables); throws otherwise.
 */
export function peLayout(head: Uint8Array): PeLayout {
  const v = dv(head);
  if (head.length < 0x40 || v.getUint16(0, true) !== 0x5a4d) throw new Error('not an MZ executable');
  const pe = v.getUint32(0x3c, true);
  if (pe + 24 > head.length || v.getUint32(pe, true) !== 0x4550) throw new Error('no PE header');
  const nsec = v.getUint16(pe + 6, true), optSize = v.getUint16(pe + 20, true);
  const opt = pe + 24;
  const magic = v.getUint16(opt, true);
  const dirs = opt + (magic === 0x20b ? 112 : 96);   // PE32+ or PE32
  const ndirs = v.getUint32(dirs - 4, true);
  const secTab = opt + optSize;
  if (secTab + nsec * 40 > head.length || dirs + 24 > head.length) throw new Error('PE headers truncated');
  const resRva = ndirs > 2 ? v.getUint32(dirs + 16, true) : 0;
  const resSize = ndirs > 2 ? v.getUint32(dirs + 20, true) : 0;
  const sections: PeSection[] = [];
  for (let i = 0; i < nsec; i++) {
    const s = secTab + i * 40;
    let name = '';
    for (let k = 0; k < 8 && head[s + k]; k++) name += String.fromCharCode(head[s + k]);
    sections.push({ name, vsize: v.getUint32(s + 8, true), vaddr: v.getUint32(s + 12, true), rawSize: v.getUint32(s + 16, true), rawOff: v.getUint32(s + 20, true) });
  }
  return { sections, resRva, resSize };
}

/** the section holding the resource directory: its file range and base RVA (null = no resources) */
export function resourceSection(l: PeLayout): { offset: number; size: number; rva: number } | null {
  if (!l.resRva) return null;
  const s = l.sections.find(x => l.resRva >= x.vaddr && l.resRva < x.vaddr + Math.max(x.vsize, x.rawSize));
  return s ? { offset: s.rawOff, size: s.rawSize, rva: s.vaddr } : null;
}

/**
 * Every resource of one type: id -> data (first language). `sec` holds the raw bytes of the
 * resource section, `secRva` its RVA; the directory starts at `dirRva`.
 */
export function resourcesOfType(sec: Uint8Array, secRva: number, dirRva: number, type: number): Map<number, Uint8Array> {
  const v = dv(sec);
  const root = dirRva - secRva;
  const out = new Map<number, Uint8Array>();
  const entries = (off: number): [number, number][] => {
    if (off < 0 || off + 16 > sec.length) return [];
    const n = v.getUint16(off + 12, true) + v.getUint16(off + 14, true);
    const list: [number, number][] = [];
    for (let i = 0; i < n && off + 16 + i * 8 + 8 <= sec.length; i++) {
      const e = off + 16 + i * 8;
      list.push([v.getUint32(e, true), v.getUint32(e + 4, true)]);
    }
    return list;
  };
  const sub = (to: number) => (to & 0x80000000 ? root + (to & 0x7fffffff) : -1);
  const typeDir = entries(root).find(([name, to]) => name === type && to & 0x80000000);
  if (!typeDir) return out;
  for (const [id, to] of entries(sub(typeDir[1]))) {
    if (id & 0x80000000) continue;   // named resources are not used here
    let leaf = to;
    if (leaf & 0x80000000) {          // language level: take the first
      const langs = entries(sub(leaf));
      if (!langs.length) continue;
      leaf = langs[0][1];
      if (leaf & 0x80000000) continue;
    }
    const d = root + leaf;
    if (d + 16 > sec.length) continue;
    const start = v.getUint32(d, true) - secRva, size = v.getUint32(d + 4, true);
    if (start < 0 || start + size > sec.length) continue;
    out.set(id, sec.subarray(start, start + size));
  }
  return out;
}

/** decode one RT_CURSOR image (hotspot + DIB with stacked colour and AND bitmaps) */
export function decodeCursor(data: Uint8Array): CursorImage {
  const v = dv(data);
  const hotX = v.getUint16(0, true), hotY = v.getUint16(2, true);
  const h0 = 4, hdr = v.getUint32(h0, true);
  if (hdr < 40) throw new Error('unsupported cursor bitmap header');
  const width = v.getInt32(h0 + 4, true), height = Math.abs(v.getInt32(h0 + 8, true)) / 2;
  const bpp = v.getUint16(h0 + 14, true), clrUsed = v.getUint32(h0 + 32, true);
  if (v.getUint32(h0 + 16, true) !== 0) throw new Error('compressed cursor bitmaps are not supported');
  const nPal = bpp <= 8 ? (clrUsed || 1 << bpp) : 0;
  const pal = h0 + hdr;
  const xor = pal + nPal * 4, xorStride = ((width * bpp + 31) >>> 5) * 4;
  const and = xor + xorStride * height, andStride = ((width + 31) >>> 5) * 4;
  if (and + andStride * height > data.length) throw new Error('cursor bitmap truncated');
  const rgba = new Uint8Array(width * height * 4);
  let inverted = 0;
  for (let y = 0; y < height; y++) {
    const xr = xor + (height - 1 - y) * xorStride, ar = and + (height - 1 - y) * andStride;
    for (let x = 0; x < width; x++) {
      let r: number, g: number, b: number;
      if (bpp <= 8) {
        const bit = x * bpp;
        const idx = (data[xr + (bit >>> 3)] >>> (8 - bpp - (bit & 7))) & ((1 << bpp) - 1);
        const p = pal + Math.min(idx, nPal - 1) * 4;
        b = data[p]; g = data[p + 1]; r = data[p + 2];
      } else {
        const p = xr + x * (bpp >>> 3);
        b = data[p]; g = data[p + 1]; r = data[p + 2];
      }
      const mask = (data[ar + (x >>> 3)] >>> (7 - (x & 7))) & 1;
      const o = (y * width + x) * 4;
      if (!mask) { rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = 255; }
      else if (r | g | b) {
        // screen inversion has no CSS equivalent: an opaque black pixel stays visible on the
        // mostly bright-to-mid game backgrounds (none of the game's six cursors uses it)
        inverted++;
        rgba[o + 3] = 255;
      }
      // mask 1 with black: transparent (rgba stays 0)
    }
  }
  return { width, height, hotX, hotY, rgba, inverted };
}

/**
 * Cursor groups of an executable's resource section: group id -> the group's first image.
 * `sec`/`secRva`: the raw section bytes and its RVA; `dirRva`: the resource directory's RVA.
 */
export function cursorGroups(sec: Uint8Array, secRva: number, dirRva: number): Map<number, CursorGroup> {
  const images = resourcesOfType(sec, secRva, dirRva, RT_CURSOR);
  const out = new Map<number, CursorGroup>();
  for (const [group, g] of resourcesOfType(sec, secRva, dirRva, RT_GROUP_CURSOR)) {
    if (g.length < 6 + 14) continue;
    const v = dv(g);
    if (v.getUint16(2, true) !== 2 || v.getUint16(4, true) < 1) continue;   // resType 2 = cursor
    const image = v.getUint16(6 + 12, true);
    const data = images.get(image);
    if (!data) continue;
    try { out.set(group, { group, image, ...decodeCursor(data) }); } catch { /* unsupported image */ }
  }
  return out;
}

/** convenience for a whole executable file in memory */
export function exeCursors(exe: Uint8Array): Map<number, CursorGroup> {
  const l = peLayout(exe);
  const s = resourceSection(l);
  if (!s) return new Map();
  return cursorGroups(exe.subarray(s.offset, Math.min(exe.length, s.offset + s.size)), s.rva, l.resRva);
}
