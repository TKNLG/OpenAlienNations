// HD pack manifest lookup (pure; tools/hdpack, served under /hd/). See ui-assets.ts.

/** hd/manifest.json: items key -> file; hash key -> pixelHash of the picture the image was made from */
export interface HdManifest { scale: number; items: Record<string, string>; hash?: Record<string, string>; byPicture?: Map<string, string[]>; }

/**
 * The pack entry for a picture. With checksums in the manifest
 * (tools/hdpack/hashes.ts) an image is used only for a picture with identical pixels, under any of
 * the entry's stored variants (GOG / Gold / language editions); a picture an edition changed keeps
 * its own art. A pack without checksums (an older `--hd` folder) matches by key as before.
 */
export function pickPackKey(m: HdManifest, archive: string, name: string, frame: number, dataLength: number, hash?: string): string | undefined {
  const exact = `${archive}|${name}|${frame}|${dataLength}`;
  if (!m.hash || hash === undefined) return m.items[exact] ? exact : undefined;
  if (m.hash[exact] === hash) return exact;
  if (!m.byPicture) {
    m.byPicture = new Map();
    for (const k of Object.keys(m.items)) {
      const p = k.slice(0, k.lastIndexOf('|'));
      const l = m.byPicture.get(p);
      if (l) l.push(k); else m.byPicture.set(p, [k]);
    }
  }
  return m.byPicture.get(`${archive}|${name}|${frame}`)?.find(k => m.hash![k] === hash);
}

