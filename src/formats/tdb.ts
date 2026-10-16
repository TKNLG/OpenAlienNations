// .tdb string tables (DV.tdb UI strings, Mentor.tdb advisor lines). Spec: docs/formats/os-dvf-tdb.md
//   repeat to EOF: u32 id, u32 byte_len (including the NUL), byte_len bytes cp1252 text

import { Bin } from './bin.ts';

/** id -> text (cp1252 decoded) */
export function parseTdb(buf: Uint8Array): Map<number, string> {
  const b = new Bin(buf);
  const out = new Map<number, string>();
  let p = 0;
  while (p + 8 <= b.length) {
    const id = b.u32(p), len = b.u32(p + 4);
    out.set(id, b.cstr(p + 8, len));
    p += 8 + len;
  }
  return out;
}

/** printf-style %s / %d / %5d / %+5d / %.1f / %% substitution as used by the game's strings */
export function format(fmt: string, ...args: (string | number)[]): string {
  let i = 0;
  return fmt.replace(/%([+]?)(\d*)(\.\d+)?([sdf%])/g, (_m, plus: string, width: string, prec: string, kind: string) => {
    if (kind === '%') return '%';
    const v = args[i++];
    let s: string;
    if (kind === 'd') { const n = Math.trunc(Number(v)); s = (plus && n >= 0 ? '+' : '') + n; }
    else if (kind === 'f') { const n = Number(v); s = (plus && n >= 0 ? '+' : '') + n.toFixed(prec ? Number(prec.slice(1)) : 6); }
    else s = String(v ?? '');
    return width ? s.padStart(Number(width)) : s;
  });
}
