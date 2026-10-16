// Interface art (per race interface.gd) and bitmap fonts (*.dvf) for the HUD.
// Each race's interface archive is ~2 MB and fetched once; sprites are decoded on first use.

import { parseGdIndex, decodeGdFrames, type GdEntry } from '../formats/gd.ts';
import { parseDvf, type Font } from '../formats/dvf.ts';
import { fetchBytes } from './data.ts';

export const RACE_UI_DIR = ['AMAZONS', 'PIMONS', 'SAJIKI'];

// ------------------------------------------------------------------ HD UI pack
//
// Optional upscaled versions of the menu and side-panel art (tools/hdpack, served under /hd/).
// The 1x canvases stay the layout truth (sizes, hit tests); an HD image is linked to a canvas and
// used whenever that canvas is drawn. drawImage is wrapped once so that every existing call site
// picks the HD image up without knowing about it. Toggle: settings "HD-Grafik".

type HdImage = ImageBitmap | HTMLCanvasElement;
const hdMap = new WeakMap<object, HdImage>();
/** derivations (tints) to rebuild whenever a canvas gets its HD image */
const hdDerived = new WeakMap<object, (() => void)[]>();
/** canvases whose HD image is rendered from the world sprites (the pack must not replace it) */
const hdRendered = new WeakSet<object>();
let hdOn = true;
let hdManifest: Promise<{ scale: number; items: Record<string, string> } | null> | null = null;

/** switch the HD art on or off (takes effect on the next frame) */
export function setHdEnabled(on: boolean): void {
  const was = hdOn;
  hdOn = on;
  for (const f of hdListeners) f();
  if (on && !was) for (const ui of allUi) ui.loadMissingHd();   // frames decoded while it was off
}
const allUi = new Set<UiImages>();
export function hdEnabled(): boolean { return hdOn; }

/** the HD image linked to a canvas, if any */
export function hdOf(c: object): HdImage | undefined { return hdOn ? hdMap.get(c) : undefined; }

/** called whenever HD art arrives (screens that paint on demand repaint) */
export const hdListeners = new Set<() => void>();
let hdNotify = 0;

function linkHd(c: object, hd: HdImage): void {
  hdMap.set(c, hd);
  if (!hdNotify) hdNotify = requestAnimationFrame(() => { hdNotify = 0; for (const f of hdListeners) f(); });
  for (const f of hdDerived.get(c) ?? []) f();
}

/**
 * Link an HD image rendered here (hd-icons.ts: panel pictures from the world sprites). It takes
 * precedence over the pack's image for the same canvas, whichever arrives first.
 */
export function linkRenderedHd(c: object, hd: HdImage): void {
  hdRendered.add(c);
  linkHd(c, hd);
}

/**
 * A canvas derived from another (tinted copy, ...): build the same derivation from the source's
 * HD image too, now and whenever the source's HD image arrives or is replaced. `make` gets the
 * source and its pixel size.
 */
export function deriveHd(src: object, dst: object, make: (s: CanvasImageSource, w: number, h: number) => HTMLCanvasElement): void {
  const go = () => { const h = hdMap.get(src); if (h) linkHd(dst, make(h, h.width, h.height)); };
  const l = hdDerived.get(src) ?? [];
  l.push(go);
  hdDerived.set(src, l);
  if (hdMap.has(src)) go();
}

function manifest() {
  hdManifest ??= fetch('/hd/manifest.json').then(r => (r.ok ? r.json() : null)).catch(() => null);
  return hdManifest;
}

/** fetch an HD frame, scaled once (high quality) to the size it will be shown at */
function loadHd(c: HTMLCanvasElement, key: string, target: number): void {
  void manifest().then(async m => {
    const file = m?.items[key];
    if (!file) return;
    const blob = await (await fetch(`/hd/${file}`)).blob();
    const s = Math.max(1, Math.min(m!.scale, target));
    const w = Math.round(c.width * s), h = Math.round(c.height * s);
    let bmp: ImageBitmap;
    try { bmp = await createImageBitmap(blob, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' }); }
    catch { bmp = await createImageBitmap(blob); }
    if (!hdRendered.has(c)) linkHd(c, bmp);
  }).catch(() => { /* no pack: the original art stays */ });
}

/**
 * Link the pack's image of a sprite of a world archive ("dv.gd", "addon.gd": the side-panel
 * portraits) to its canvas, scaled once to `target` pixels per pixel. A rendered image
 * (linkRenderedHd) wins over it.
 */
export function requestPackHd(c: HTMLCanvasElement, archive: string, name: string, frame: number, dataLength: number, target: number): void {
  if (!hdMap.has(c)) loadHd(c, `${archive}|${name}|${frame}|${dataLength}`, target);
}

// every drawImage of a canvas with a linked HD image draws the HD image into the same rectangle
{
  const proto = CanvasRenderingContext2D.prototype as unknown as { drawImage: (...a: unknown[]) => void; __hd?: boolean };
  if (!proto.__hd) {
    proto.__hd = true;
    const orig = proto.drawImage;
    proto.drawImage = function (this: CanvasRenderingContext2D, img: unknown, ...rest: unknown[]) {
      const a = rest as number[];
      const hd = hdOn && img && typeof img === 'object' ? hdMap.get(img) : undefined;
      if (!hd) return orig.call(this, img, ...rest);
      const src = img as { width: number; height: number };
      const k = hd.width / src.width, kh = hd.height / src.height;
      // HD art is resampled smoothly even where the original pixels are drawn crisp
      const sm = this.imageSmoothingEnabled, q = this.imageSmoothingQuality;
      this.imageSmoothingEnabled = true; this.imageSmoothingQuality = 'high';
      try {
        if (a.length === 2) return orig.call(this, hd, a[0], a[1], src.width, src.height);
        if (a.length === 4) return orig.call(this, hd, a[0], a[1], a[2], a[3]);
        return orig.call(this, hd, a[0] * k, a[1] * kh, a[2] * k, a[3] * kh, a[4], a[5], a[6], a[7]);
      } finally { this.imageSmoothingEnabled = sm; this.imageSmoothingQuality = q; }
    };
  }
}

export class UiImages {
  private buf: Uint8Array;
  private byName: Map<string, GdEntry>;
  private cache = new Map<string, HTMLCanvasElement[]>();
  /** sprites decoded fully opaque whatever their stored alpha (menu backgrounds, front-end.md 1.1) */
  private opaque = new Set<string>();

  /** archive key of the HD pack ("mainmenu.gd", "pimons/interface.gd") */
  private hdKey = '';
  /** pixels per logical pixel the art is shown at (HD frames are scaled to this once) */
  hdTarget = 2;

  private constructor(buf: Uint8Array, byName: Map<string, GdEntry>) { this.buf = buf; this.byName = byName; }

  static async load(race: number): Promise<UiImages> {
    return UiImages.loadPath(`Data/${RACE_UI_DIR[race] ?? 'PIMONS'}/interface.gd`);
  }

  /** any .gd archive read whole (interface.gd, mainmenu.gd) */
  static async loadPath(path: string): Promise<UiImages> {
    const buf = await fetchBytes(path);
    const ui = new UiImages(buf, parseGdIndex(buf, buf.length).byName);
    allUi.add(ui);
    ui.hdKey = path.toLowerCase().replace(/^data\//, '');
    // shown size: menus scale 800 x 600 to the window, the side panel 768 px of height
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const h = typeof window !== 'undefined' ? window.innerHeight : 768;
    ui.hdTarget = Math.max(1, (h * dpr) / (ui.hdKey.startsWith('mainmenu') ? 600 : 768));
    return ui;
  }

  has(name: string): boolean { return this.byName.has(name); }
  size(name: string): [number, number] | undefined {
    const e = this.byName.get(name);
    return e && [e.width, e.height];
  }
  /** decode these sprites fully opaque (call before the first get) */
  setOpaque(names: string[]): void { for (const n of names) this.opaque.add(n); }
  frameCount(name: string): number { return this.byName.get(name)?.frames ?? 0; }
  /** the sprite's stored top-left (some panel sprites carry their panel position, side-panel.md 2) */
  offset(name: string): [number, number] { const e = this.byName.get(name); return e ? [e.left, e.top] : [0, 0]; }

  private requestHd(name: string, frames: HTMLCanvasElement[]): void {
    const e = this.byName.get(name);
    if (!e) return;
    frames.forEach((c, f) => { if (!hdMap.has(c)) loadHd(c, `${this.hdKey}|${name}|${f}|${e.dataLength}`, this.hdTarget); });
  }

  loadMissingHd(): void { for (const [name, frames] of this.cache) this.requestHd(name, frames); }

  /** decoded frame as a canvas (straight alpha), cached */
  get(name: string, frame = 0): HTMLCanvasElement | undefined {
    let frames = this.cache.get(name);
    if (!frames) {
      const e = this.byName.get(name);
      if (!e) return undefined;
      const rgba = decodeGdFrames(e, this.buf.subarray(e.dataOffset, e.dataOffset + e.dataLength), e.frames - 1, this.opaque.has(name), true);
      frames = rgba.map(px => toCanvas(px, e.width, e.height));
      this.cache.set(name, frames);
      if (hdOn) this.requestHd(name, frames);
    }
    return frames[Math.min(frame, frames.length - 1)];
  }
}

function toCanvas(px: Uint8Array, w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(px.buffer, px.byteOffset, px.length), w, h), 0, 0);
  return c;
}

// ------------------------------------------------------------------ fonts

const CP1252_HIGH: Record<number, number> = { 0x20ac: 0x80, 0x201e: 0x84, 0x2026: 0x85, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2013: 0x96, 0x2014: 0x97 };
const cp1252 = (ch: number) => (ch < 256 ? ch : CP1252_HIGH[ch] ?? 0x3f);

/** A .dvf font rendered from a white coverage atlas, tinted per colour on demand */
export class BitmapFont {
  readonly font: Font;
  readonly height: number;
  private atlas: HTMLCanvasElement;
  private pos = new Map<number, number>(); // code -> x in atlas
  private tinted = new Map<string, HTMLCanvasElement>();
  private upperOnly: boolean;
  private spaceW: number;

  constructor(font: Font) {
    this.font = font;
    this.height = font.height;
    let w = 0;
    for (const [code, g] of font.glyphs) { this.pos.set(code, w); w += g.width + 1; }
    const c = document.createElement('canvas');
    c.width = Math.max(1, w); c.height = Math.max(1, font.height);
    const img = new ImageData(c.width, c.height);
    for (const [code, g] of font.glyphs) {
      const x0 = this.pos.get(code)!;
      for (let y = 0; y < font.height; y++) for (let x = 0; x < g.width; x++) {
        const i = ((y * c.width) + x0 + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
        img.data[i + 3] = g.data[y * g.width + x];
      }
    }
    c.getContext('2d')!.putImageData(img, 0, 0);
    this.atlas = c;
    this.upperOnly = !font.glyphs.has(0x61);
    this.spaceW = font.glyphs.get(0x20)?.width ?? Math.max(2, Math.round((font.glyphs.get(0x6e)?.width ?? font.glyphs.get(0x4e)?.width ?? font.height / 2) * 0.6));
  }

  private code(ch: string): number {
    let c = cp1252(ch.codePointAt(0)!);
    if (this.upperOnly && !this.font.glyphs.has(c)) {
      const up = cp1252(ch.toUpperCase().codePointAt(0)!);
      if (this.font.glyphs.has(up)) c = up;
    }
    return c;
  }

  private advance(code: number): number {
    if (code === 0x20) return this.spaceW;
    const g = this.font.glyphs.get(code);
    return g ? g.width + 1 : this.spaceW;
  }

  measure(text: string): number {
    let w = 0;
    for (const ch of text) w += this.advance(this.code(ch));
    return Math.max(0, w - 1);
  }

  private tint(color: string): HTMLCanvasElement {
    let t = this.tinted.get(color);
    if (!t) {
      t = document.createElement('canvas');
      t.width = this.atlas.width; t.height = this.atlas.height;
      const c = t.getContext('2d')!;
      c.drawImage(this.atlas, 0, 0);
      c.globalCompositeOperation = 'source-in';
      c.fillStyle = color;
      c.fillRect(0, 0, t.width, t.height);
      this.tinted.set(color, t);
    }
    return t;
  }

  /** draw text with its top-left at (x, y); returns the advance width */
  draw(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color = '#ffffff', shadow?: string): number {
    if (shadow) this.draw(ctx, text, x + 1, y + 1, shadow);
    const src = this.tint(color);
    let cx = x;
    for (const ch of text) {
      const code = this.code(ch);
      const g = this.font.glyphs.get(code);
      if (g && code !== 0x20) ctx.drawImage(src, this.pos.get(code)!, 0, g.width, this.height, Math.round(cx), Math.round(y), g.width, this.height);
      cx += this.advance(code);
    }
    return cx - x;
  }

  /** greedy word wrap into lines no wider than maxW */
  wrap(text: string, maxW: number): string[] {
    const out: string[] = [];
    for (const para of text.split('\n')) {
      let line = '';
      for (const word of para.split(/\s+/).filter(Boolean)) {
        const t = line ? line + ' ' + word : word;
        if (line && this.measure(t) > maxW) { out.push(line); line = word; } else line = t;
      }
      out.push(line);
    }
    return out;
  }
}

export const FONT_FILES = ['8x8', 'dv7pts', 'dv7pts2', 'dv8pt', 'dv8pta', 'dv8ptc', 'dv10pt', 'dv10pta', 'dv14pt', 'dv18pt'] as const;
export type FontName = typeof FONT_FILES[number];

export async function loadFonts(): Promise<Map<FontName, BitmapFont>> {
  const out = new Map<FontName, BitmapFont>();
  await Promise.all(FONT_FILES.map(async n => { out.set(n, new BitmapFont(parseDvf(await fetchBytes(`Data/${n}.dvf`)))); }));
  return out;
}
