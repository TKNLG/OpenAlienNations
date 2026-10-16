// Little-endian binary reading helpers shared by all format readers.

export class Bin {
  readonly view: DataView;
  readonly bytes: Uint8Array;

  constructor(buf: ArrayBuffer | Uint8Array) {
    this.bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
  }

  get length(): number { return this.bytes.length; }
  u8(o: number): number { return this.bytes[o]; }
  u16(o: number): number { return this.view.getUint16(o, true); }
  u32(o: number): number { return this.view.getUint32(o, true); }
  i32(o: number): number { return this.view.getInt32(o, true); }

  /** NUL-terminated cp1252 string starting at o. */
  cstr(o: number, max = 4096): string {
    let end = o;
    const lim = Math.min(this.bytes.length, o + max);
    while (end < lim && this.bytes[end] !== 0) end++;
    return decodeCp1252(this.bytes.subarray(o, end));
  }

  slice(o: number, len: number): Uint8Array { return this.bytes.subarray(o, o + len); }
}

// cp1252 differs from latin1 only in 0x80..0x9F.
const CP1252_HIGH = [
  0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178,
];

export function decodeCp1252(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    s += String.fromCharCode(c >= 0x80 && c < 0xa0 ? CP1252_HIGH[c - 0x80] : c);
  }
  return s;
}
