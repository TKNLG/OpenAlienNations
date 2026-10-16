// HD side-panel pictures from the world sprites: pure pixel logic (no DOM).
//
// The 45x45 building pictures of the side panel (dv.OD groups 3..5, docs/formats/od-odb.md) are
// shrunk renders of the finished building sprite (slot 1: MS0 + its layers at frame 0) for the
// Amazons and Pimmons, three Sajiki buildings and every add-on harbour and shipyard: an area
// downscale by 0.20..0.35 at a sub-pixel offset reproduces them to a mean error of 1.4..8.8 (of
// 255). The add-on ships are their direction-5 sprite shrunk by 0.32..0.54, the tree and palm
// pictures of interface.gd a standing tree / palm shrunk by 0.27 / 0.31. The other Sajiki pictures
// and the unit pictures are separate renders (other camera or pose) or about 1:1 (nothing to
// gain). fitIcon finds scale and offset (results: FITS below); resampleArea renders the big sprite
// at the panel's device resolution.

/** premultiplied RGBA, 4 floats (0..255) per pixel */
export interface Img { w: number; h: number; px: Float32Array; }

/** where a picture sits on its big sprite: icon px = s * sprite px + (ox, oy) */
export interface IconFit { s: number; ox: number; oy: number; /** mean |difference| per channel, 0..255 */ err: number; }

export function premultiply(rgba: ArrayLike<number>, w: number, h: number): Img {
  const px = new Float32Array(w * h * 4);
  for (let i = 0; i < w * h * 4; i += 4) {
    const a = rgba[i + 3], k = a / 255;
    px[i] = rgba[i] * k; px[i + 1] = rgba[i + 1] * k; px[i + 2] = rgba[i + 2] * k; px[i + 3] = a;
  }
  return { w, h, px };
}

/** back to straight-alpha bytes (for ImageData) */
export function unpremultiply(img: Img): Uint8ClampedArray {
  const out = new Uint8ClampedArray(img.w * img.h * 4), p = img.px;
  for (let i = 0; i < out.length; i += 4) {
    const a = p[i + 3];
    if (a <= 0.5) continue;
    const k = 255 / a;
    out[i] = p[i] * k + 0.5; out[i + 1] = p[i + 1] * k + 0.5; out[i + 2] = p[i + 2] * k + 0.5; out[i + 3] = a + 0.5;
  }
  return out;
}

/** per output index: first source index, count, and coverage weights (exact area overlap) */
function axisWeights(n: number, s: number, o: number, len: number): { start: Int32Array; count: Int32Array; w: Float32Array; stride: number } {
  const span = 1 / s;
  const stride = Math.ceil(span) + 2;
  const start = new Int32Array(n), count = new Int32Array(n), w = new Float32Array(n * stride);
  for (let i = 0; i < n; i++) {
    const a = (i - o) / s, b = (i + 1 - o) / s;
    const j0 = Math.max(0, Math.floor(a)), j1 = Math.min(len, Math.ceil(b));
    start[i] = j0;
    let c = 0;
    for (let j = j0; j < j1 && c < stride; j++, c++) w[i * stride + c] = (Math.min(b, j + 1) - Math.max(a, j)) * s;
    count[i] = c;
  }
  return { start, count, w, stride };
}

/**
 * W x H picture of `src` shrunk by s (output pixel x covers source [(x - ox)/s, (x + 1 - ox)/s)),
 * each output pixel the exact area average of what it covers (transparent outside the source).
 * Meant for s <= 1; above that it degrades to pixel repetition.
 */
export function resampleArea(src: Img, s: number, ox: number, oy: number, W: number, H: number): Img {
  const hx = axisWeights(W, s, ox, src.w), hy = axisWeights(H, s, oy, src.h);
  // source rows needed
  let r0 = src.h, r1 = 0;
  for (let y = 0; y < H; y++) if (hy.count[y]) { r0 = Math.min(r0, hy.start[y]); r1 = Math.max(r1, hy.start[y] + hy.count[y]); }
  const out = new Float32Array(W * H * 4);
  if (r1 <= r0) return { w: W, h: H, px: out };
  const tmp = new Float32Array((r1 - r0) * W * 4), sp = src.px, sw = src.w;
  for (let r = r0; r < r1; r++) {
    const row = r * sw * 4, t0 = (r - r0) * W * 4;
    for (let x = 0; x < W; x++) {
      let a = 0, b = 0, c = 0, d = 0;
      const j0 = hx.start[x], n = hx.count[x], wo = x * hx.stride;
      for (let k = 0; k < n; k++) {
        const q = hx.w[wo + k], i = row + (j0 + k) * 4;
        a += sp[i] * q; b += sp[i + 1] * q; c += sp[i + 2] * q; d += sp[i + 3] * q;
      }
      const t = t0 + x * 4;
      tmp[t] = a; tmp[t + 1] = b; tmp[t + 2] = c; tmp[t + 3] = d;
    }
  }
  for (let y = 0; y < H; y++) {
    const j0 = hy.start[y], n = hy.count[y], wo = y * hy.stride;
    for (let k = 0; k < n; k++) {
      const q = hy.w[wo + k], t0 = (j0 + k - r0) * W * 4, o0 = y * W * 4;
      for (let i = 0; i < W * 4; i++) out[o0 + i] += tmp[t0 + i] * q;
    }
  }
  return { w: W, h: H, px: out };
}

/** mean absolute difference per channel (premultiplied colour and alpha), 0..255 */
export function imageError(a: Img, b: Img): number {
  let e = 0;
  for (let i = 0; i < a.px.length; i++) e += Math.abs(a.px[i] - b.px[i]);
  return e / a.px.length;
}

/** bounding box [left, top, right, bottom) of the clearly opaque pixels */
function alphaBox(img: Img): [number, number, number, number] | null {
  let l = img.w, t = img.h, r = -1, b = -1;
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
    if (img.px[(y * img.w + x) * 4 + 3] > 100) { if (x < l) l = x; if (x > r) r = x; if (y < t) t = y; if (y > b) b = y; }
  }
  return r < 0 ? null : [l, t, r + 1, b + 1];
}

/**
 * Scale and offset at which `src` (the big sprite) best reproduces `icon`: starts from the
 * opaque bounding boxes, scans scale and offset on a coarse grid, then refines by pattern search
 * down to 1/50 px.
 */
export function fitIcon(icon: Img, src: Img): IconFit {
  const ib = alphaBox(icon), sb = alphaBox(src);
  if (!ib || !sb) return { s: 1, ox: 0, oy: 0, err: Infinity };
  const W = icon.w, H = icon.h;
  const cache = new Map<string, number>();
  const f = (s: number, ox: number, oy: number): number => {
    if (!(s > 0.02 && s < 4)) return Infinity;
    const key = `${s.toFixed(5)},${ox.toFixed(3)},${oy.toFixed(3)}`;
    let e = cache.get(key);
    if (e === undefined) { e = imageError(resampleArea(src, s, ox, oy, W, H), icon); cache.set(key, e); }
    return e;
  };
  let best = { s: 1, ox: 0, oy: 0, err: Infinity };
  const consider = (s: number, ox: number, oy: number) => { const e = f(s, ox, oy); if (e < best.err) best = { s, ox, oy, err: e }; };
  const sh = (ib[3] - ib[1]) / (sb[3] - sb[1]), sw = (ib[2] - ib[0]) / (sb[2] - sb[0]);
  for (const s of [sh, sw, (sh + sw) / 2]) {
    const cx = (ib[0] + ib[2]) / 2 - s * (sb[0] + sb[2]) / 2;
    consider(s, cx, (ib[1] + ib[3]) / 2 - s * (sb[1] + sb[3]) / 2);
    consider(s, cx, ib[3] - s * sb[3]);
    consider(s, cx, ib[1] - s * sb[1]);
  }
  // coarse grid around the best start (the picture may be cropped, so the boxes only roughly agree)
  const p0 = best;
  for (let i = -6; i <= 6; i++) {
    const s = p0.s * (1 + 0.025 * i);
    // keep the bounding-box centre fixed while scaling
    const cx = p0.ox + (p0.s - s) * (sb[0] + sb[2]) / 2, cy = p0.oy + (p0.s - s) * (sb[1] + sb[3]) / 2;
    for (let dy = -4; dy <= 4; dy += 2) for (let dx = -4; dx <= 4; dx += 2) consider(s, cx + dx, cy + dy);
  }
  // pattern search; the scale steps keep the sprite's centre in place (scale and offset decouple)
  const mx = (sb[0] + sb[2]) / 2, my = (sb[1] + sb[3]) / 2;
  let ds = best.s * 0.02, dd = 1;
  while (dd > 0.01) {
    let moved = false;
    for (const [a, b, c] of [[ds, 0, 0], [-ds, 0, 0], [0, dd, 0], [0, -dd, 0], [0, 0, dd], [0, 0, -dd]]) {
      const e0 = best.err;
      consider(best.s + a, best.ox + b - a * mx, best.oy + c - a * my);
      if (best.err < e0) moved = true;
    }
    if (!moved) { ds /= 2; dd /= 2; }
  }
  return best;
}

/**
 * A placement is used only if it reproduces the picture this well (mean error; measured: shrunk
 * renders 1.4..8.8, separate renders 13.6 and more). Guards against other data files.
 */
export const ICON_FIT_MAX_ERR = 10;

/** Pixel factor of an HD picture: the panel's device scale, at most 4 and never above the sprite's own resolution (1/s). */
export function hdFactor(deviceScale: number, s: number): number {
  return Math.max(1, Math.min(4, deviceScale, 1 / s));
}

/** the HD picture: `src` rendered at k times the picture's size with the fitted placement */
export function renderHd(src: Img, fit: IconFit, W: number, H: number, k: number): Img {
  const w = Math.round(W * k), h = Math.round(H * k);
  const kx = w / W, ky = h / H;
  // one scale for both axes (k may round differently per axis by a fraction of a pixel)
  const kk = (kx + ky) / 2;
  return resampleArea(src, fit.s * kk, fit.ox * kx, fit.oy * ky, w, h);
}

/**
 * Finished-building composite (docs/rendering/objects.md 2.1): every layer at frame 0, each layer's
 * rectangle copied over what is below. Layers are straight RGBA with their rect in sprite canvas
 * coordinates; returns the picture and its top-left corner.
 */
export function composeLayers(layers: { left: number; top: number; w: number; h: number; rgba: ArrayLike<number> }[]): { img: Img; left: number; top: number } {
  let L = Infinity, T = Infinity, R = -Infinity, B = -Infinity;
  for (const l of layers) { L = Math.min(L, l.left); T = Math.min(T, l.top); R = Math.max(R, l.left + l.w); B = Math.max(B, l.top + l.h); }
  if (!layers.length) return { img: { w: 0, h: 0, px: new Float32Array(0) }, left: 0, top: 0 };
  const W = R - L, H = B - T, rgba = new Uint8Array(W * H * 4);
  for (const l of layers) {
    for (let y = 0; y < l.h; y++) for (let i = 0; i < l.w * 4; i++) rgba[((l.top - T + y) * W + (l.left - L)) * 4 + i] = l.rgba[y * l.w * 4 + i];
  }
  return { img: premultiply(rgba, W, H), left: L, top: T };
}

/**
 * Measured placements of the side-panel pictures that are shrunk world sprites (fitIcon over
 * dv.gd / Addon.gd; trailing comment: name and mean error). Row: race, type, OD slot of the world
 * object (race << 16 | type) whose layers at frame 0 are the source (1 = finished building,
 * 5 = ships facing direction 5), s, ox, oy with icon px = s * sprite-canvas px + (ox, oy), and
 * the frame per layer where it is not 0.
 * Missing: units (separate renders or about 1:1) and 22 Sajiki buildings (separate renders,
 * other camera; mean error 14..35).
 */
const FITS: [number, number, number, number, number, number, number[]?][] = [
  // Amazons
  [0, 37, 1, 0.27522, -25.46, -8.56],   // WOHN 1.8
  [0, 38, 1, 0.23445, -23.35, -0.64],   // WOHNGROSS 2.0
  [0, 39, 1, 0.22599, -17.69, -2.20],   // KASERNE 2.4
  [0, 40, 1, 0.22613, -14.50, -0.62],   // RATHAUS 1.7
  [0, 41, 1, 0.28783, -28.67, -15.11],   // LAGER 1.5
  [0, 42, 1, 0.22602, -17.70, -0.60],   // BOTSCHAFT 1.6
  [0, 43, 1, 0.22607, -16.08, -0.60],   // TIERFARM 2.2
  [0, 44, 1, 0.27523, -21.54, -10.52],   // SCHNAPSBRENNEREI 2.2
  [0, 45, 1, 0.30133, -25.72, -13.66],   // MUEHLE 2.2
  [0, 46, 1, 0.27531, -25.47, -8.58],   // LABOR 1.7
  [0, 47, 1, 0.22605, -1.63, -7.04],   // BIBLIOTHEK 1.8
  [0, 48, 1, 0.27522, -21.54, -12.49],   // MARKTPLATZ 2.1
  [0, 49, 1, 0.25314, -27.02, -6.08],   // BANK 1.7
  [0, 50, 1, 0.24340, -24.24, -6.71],   // MINE 2.5
  [0, 51, 1, 0.26370, -26.27, -10.07],   // ZEITUNGSSTAND 1.4
  [0, 52, 1, 0.25316, -23.41, -4.28],   // TURM-KLEIN 1.6
  [0, 53, 1, 0.21826, -15.54, -0.57],   // TURM-GROSS 1.7
  [0, 54, 1, 0.25320, -28.82, -0.68],   // POLIZEI 2.0
  [0, 55, 1, 0.26378, -24.39, -9.15],   // SCHULE 1.8
  [0, 56, 1, 0.22265, -17.25, -0.31],   // MAGIERTURM 1.8
  [0, 57, 1, 0.19794, -2.85, -1.97],   // ZIRKUS 1.9
  [0, 58, 1, 0.27517, -11.75, -14.44],   // WIRTSHAUS 1.9
  [0, 59, 1, 0.22501, -22.40, -0.35],   // KIRCHE 2.1
  [0, 60, 1, 0.29409, -29.86, -16.03],   // SPAEHTURM 2.2
  [0, 61, 1, 0.28772, -22.53, -14.07],   // WAFFENFABRIK 4.4
  [0, 62, 1, 0.21333, -14.85, -0.12],   // HAFEN 2.5
  [0, 63, 1, 0.20193, -13.24, -0.11],   // WERFT 2.9
  [0, 64, 5, 0.47570, -25.88, -11.42],   // FISCHER 4.8
  [0, 65, 5, 0.54290, -26.64, -17.41],   // KRIEGSSCHIFF1 2.8
  [0, 66, 5, 0.39250, -12.85, -5.80],   // KRIEGSSCHIFF2 3.6
  [0, 67, 5, 0.37850, -11.96, -4.77],   // TRANSPORTSCHIFF 3.7
  // Pimmons
  [1, 37, 1, 0.31949, -34.77, -19.94],   // WOHN 4.6
  [1, 38, 1, 0.25117, -17.74, -0.37],   // WOHNGROSS 6.7
  [1, 39, 1, 0.27028, -29.39, -8.21],   // KASERNE 6.2
  [1, 40, 1, 0.22687, -21.83, -0.38],   // RATHAUS 8.8
  [1, 41, 1, 0.35126, -40.47, -27.52],   // LAGER 3.4
  [1, 42, 1, 0.23430, -19.52, -2.63],   // BOTSCHAFT 8.2
  [1, 43, 1, 0.23432, -16.52, -1.14],   // TIERFARM 6.7
  [1, 44, 1, 0.29278, -26.23, -11.70],   // SCHNAPSBRENNEREI 5.2
  [1, 45, 1, 0.26036, -28.35, -6.22],   // MUEHLE 8.6
  [1, 46, 1, 0.29294, -30.01, -14.56],   // LABOR 5.9
  [1, 47, 1, 0.23419, -16.50, -2.59],   // BIBLIOTHEK 7.0
  [1, 48, 1, 0.28090, -32.32, -13.03],   // MARKTPLATZ 7.0
  [1, 49, 1, 0.22645, -14.48, -1.03],   // BANK 4.4
  [1, 50, 1, 0.27013, -20.74, -4.74],   // MINE 5.4
  [1, 51, 1, 0.29226, -31.74, -13.50],   // ZEITUNGSSTAND 4.2
  [1, 52, 1, 0.28097, -26.98, -11.20],   // TURM-KLEIN 5.5
  [1, 53, 1, 0.24256, -20.20, -0.39],   // TURM-GROSS 5.7
  [1, 54, 1, 0.25060, -16.01, -1.17],   // POLIZEI 5.0
  [1, 55, 1, 0.28110, -26.99, -12.14],   // SCHULE 4.7
  [1, 56, 1, 0.22646, -17.36, -1.04],   // MAGIERTURM 4.7
  [1, 57, 1, 0.23431, -17.99, -4.11],   // ZIRKUS 5.4
  [1, 58, 1, 0.28103, -26.99, -12.13],   // WIRTSHAUS 5.3
  [1, 59, 1, 0.22623, -19.83, -1.26],   // KIRCHE 2.5
  [1, 60, 1, 0.35113, -38.18, -26.37, [0, 7]],   // SPAEHTURM 6.1 (random layer RA0 at frame 7)
  [1, 61, 1, 0.29301, -33.77, -14.55],   // WAFFENFABRIK 4.6
  [1, 62, 1, 0.19483, -9.64, -0.10],   // HAFEN 2.1
  [1, 63, 1, 0.25374, -17.08, -2.12],   // WERFT 3.9
  [1, 64, 5, 0.52950, -29.65, -9.01],   // FISCHER 1.4
  [1, 65, 5, 0.40670, -23.51, -9.91],   // KRIEGSSCHIFF1 2.4
  [1, 66, 5, 0.32330, -23.06, -4.93],   // KRIEGSSCHIFF2 2.8
  [1, 67, 5, 0.45530, -41.63, -18.93],   // TRANSPORTSCHIFF 2.7
  // Sajiki
  [2, 41, 1, 0.26745, -17.06, -7.15],   // LAGER 4.2
  [2, 45, 1, 0.30660, -29.02, -18.03],   // MUEHLE 5.0
  [2, 57, 1, 0.22993, -19.47, -10.55],   // ZIRKUS 3.8
  [2, 62, 1, 0.24634, -14.21, -6.58],   // HAFEN 2.6
  [2, 63, 1, 0.23091, -14.22, -4.54],   // WERFT 2.5
  [2, 64, 5, 0.50650, -29.42, -21.31],   // FISCHER 5.4
  [2, 65, 5, 0.42110, -14.57, -19.22],   // KRIEGSSCHIFF1 2.4
  [2, 66, 5, 0.43540, -12.39, -24.14],   // KRIEGSSCHIFF2 2.8
  [2, 67, 5, 0.48470, -21.61, -28.41],   // TRANSPORTSCHIFF 2.2
];

export interface IconSource { slot: number; s: number; ox: number; oy: number; /** frame per layer (default 0) */ frames?: number[]; }

/** placement of the panel picture of object type (race, type) on its world sprite, if it is one */
export function iconSource(race: number, type: number): IconSource | undefined {
  const r = FITS.find(f => f[0] === race && f[1] === type);
  return r && { slot: r[2], s: r[3], ox: r[4], oy: r[5], frames: r[6] };
}

/**
 * interface.gd pictures that are shrunk world sprites: the tree picture (tree type 10, slot 32 =
 * standing tree, error 1.9) and the add-on palm picture (palm type 46, slot 32, error 3.5).
 */
export const UI_ICON_SOURCES: (IconSource & { name: string; oid: number })[] = [
  { name: 'RS\\MI\\BAUM\\MS0', oid: (6 << 16) | 10, slot: 32, s: 0.27007, ox: -15.97, oy: 0.22 },
  { name: 'RS\\MI\\PALME1\\MS0', oid: (6 << 16) | 46, slot: 32, s: 0.30950, ox: -19.59, oy: -3.83 },
];
