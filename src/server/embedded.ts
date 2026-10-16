// Files embedded in the single-executable build (Node SEA, tools/sea/build-sea.mjs): the client
// under "public/<path>", the HD UI pack under "hd/<path>" and "package.json". Plain `node
// dist/server.mjs` runs return null here and serve everything from disk instead.

interface SeaModule { isSea(): boolean; getRawAsset(key: string): ArrayBuffer; }

export interface Embedded {
  /** asset bytes, or null when the executable has no such asset */
  get(key: string): Uint8Array | null;
}

export function embeddedAssets(): Embedded | null {
  let sea: SeaModule | undefined;
  try { sea = process.getBuiltinModule?.('node:sea') as SeaModule | undefined; } catch { return null; }
  if (!sea || !sea.isSea()) return null;
  const s = sea;
  const cache = new Map<string, Uint8Array | null>();
  return {
    get(key: string): Uint8Array | null {
      let v = cache.get(key);
      if (v === undefined) {
        // getRawAsset maps the executable's bytes without copying them; they are only read
        try { v = new Uint8Array(s.getRawAsset(key)); } catch { v = null; }
        cache.set(key, v);
      }
      return v;
    },
  };
}
