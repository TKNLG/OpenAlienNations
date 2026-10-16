// Front-end assets: mainmenu.gd sprites, the four menu fonts, DV.tdb strings and the button
// click sound. Spec: docs/ui/front-end.md 1.1-1.3, 7.

import { parseDvf, type Font } from '../../formats/dvf.ts';
import { parseTdb } from '../../formats/tdb.ts';
import { fetchBytes } from '../data.ts';
import { UiImages, deriveHd } from '../ui-assets.ts';

/** backgrounds drawn fully opaque even where the file stores alpha 0 (1.1) */
const OPAQUE_BACKGROUNDS = ['MAINMENU', 'RASSENWAHL', 'BRIEFINGSCREEN', 'LOADING'];

export type MenuFontName = 'dv7pts2' | 'dv10pt' | 'dv14pt' | 'dv18pt';
const FONT_NAMES: MenuFontName[] = ['dv7pts2', 'dv10pt', 'dv14pt', 'dv18pt'];

// unicode -> cp1252 for the characters above 0xFF that cp1252 has
const CP1252_HIGH: Record<number, number> = { 0x20ac: 0x80, 0x201e: 0x84, 0x2026: 0x85, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2013: 0x96, 0x2014: 0x97 };
/** characters the fonts lack, replaced by a look-alike before the upper-case fallback */
const SUBSTITUTE: Record<string, string> = { '×': 'x', '–': '-', '—': '-', '„': '"', '“': '"', '”': '"', '…': '.', '•': '-' };

/**
 * A .dvf font with the game's glyph fallback (1.3): ' and ` use ´, missing lower-case letters use
 * upper case (so ä -> Ä). Space width = width of "E" unless the font has a space glyph; dv7pts2
 * uses 4 px. Glyphs are separated by 1 px.
 */
export class MenuFont {
  readonly height: number;
  readonly baseline: number;
  private font: Font;
  private atlas: HTMLCanvasElement;
  private pos = new Map<number, number>();
  private tints = new Map<string, HTMLCanvasElement>();
  private spaceW: number;

  constructor(font: Font, spaceW?: number) {
    this.font = font;
    this.height = font.height;
    this.baseline = font.baseline;
    this.spaceW = font.glyphs.get(0x20)?.width ?? spaceW ?? font.glyphs.get(0x45)?.width ?? 6;
    let w = 0;
    for (const [code, g] of font.glyphs) { this.pos.set(code, w); w += g.width + 1; }
    const c = document.createElement('canvas');
    c.width = Math.max(1, w); c.height = Math.max(1, font.height);
    const img = new ImageData(c.width, c.height);
    for (const [code, g] of font.glyphs) {
      const x0 = this.pos.get(code)!;
      for (let y = 0; y < font.height; y++) for (let x = 0; x < g.width; x++) {
        const i = (y * c.width + x0 + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
        img.data[i + 3] = g.data[y * g.width + x];
      }
    }
    c.getContext('2d')!.putImageData(img, 0, 0);
    this.atlas = c;
  }

  private cp(ch: string): number { const u = ch.codePointAt(0)!; return u < 256 ? u : CP1252_HIGH[u] ?? -1; }

  /** glyph code for a character, or -1 (drawn as a space) */
  private code(ch: string): number {
    const has = (c: number) => c >= 0 && this.font.glyphs.has(c);
    let c = this.cp(ch);
    if (has(c) || c === 0x20) return c;
    if ((ch === "'" || ch === '`' || ch === '’' || ch === '‘') && has(0xb4)) return 0xb4;
    const sub = SUBSTITUTE[ch];
    if (sub) { c = this.cp(sub); if (has(c)) return c; ch = sub; }
    const up = ch.toUpperCase();
    if (up.length === 1) { c = this.cp(up); if (has(c)) return c; }
    return -1;
  }

  private advance(code: number): number {
    const g = code > 0x20 ? this.font.glyphs.get(code) : undefined;
    return (g ? g.width : this.spaceW) + 1;
  }

  measure(text: string): number {
    let w = 0;
    for (const ch of text) w += this.advance(this.code(ch));
    return Math.max(0, w - 1);
  }

  private tint(color: string): HTMLCanvasElement {
    let t = this.tints.get(color);
    if (!t) {
      t = document.createElement('canvas');
      t.width = this.atlas.width; t.height = this.atlas.height;
      const c = t.getContext('2d')!;
      c.drawImage(this.atlas, 0, 0);
      c.globalCompositeOperation = 'source-in';
      c.fillStyle = color;
      c.fillRect(0, 0, t.width, t.height);
      this.tints.set(color, t);
    }
    return t;
  }

  /** draw with the top-left of the glyph box at (x, y) */
  draw(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string): void {
    const src = this.tint(color);
    let cx = Math.round(x);
    const cy = Math.round(y);
    for (const ch of text) {
      const code = this.code(ch);
      const g = code > 0x20 ? this.font.glyphs.get(code) : undefined;
      if (g) ctx.drawImage(src, this.pos.get(code)!, 0, g.width, this.height, cx, cy, g.width, this.height);
      cx += this.advance(code);
    }
  }

  /** greedy word wrap; '\n' (and '\r\n') start a new line, empty lines are kept */
  wrap(text: string, maxW: number): string[] {
    const out: string[] = [];
    for (const para of text.replace(/\r\n?/g, '\n').split('\n')) {
      let line = '';
      for (const word of para.split(/[ \t]+/).filter(Boolean)) {
        const t = line ? `${line} ${word}` : word;
        if (line && this.measure(t) > maxW) { out.push(line); line = word; } else line = t;
      }
      out.push(line);
    }
    return out;
  }
}

/** everything the menus draw with */
export class MenuAssets {
  readonly images: UiImages;
  private fonts: Map<MenuFontName, MenuFont>;
  private strings: Map<number, string>;
  private tinted = new Map<string, HTMLCanvasElement>();
  private clickEl: HTMLAudioElement | null = null;
  /** effect volume 0..1 and master switch, set from the settings */
  effectVolume = 1;
  soundOn = true;

  private constructor(images: UiImages, fonts: Map<MenuFontName, MenuFont>, strings: Map<number, string>) {
    this.images = images; this.fonts = fonts; this.strings = strings;
  }

  static async load(): Promise<MenuAssets> {
    const [images, fonts, strings] = await Promise.all([
      UiImages.loadPath('Data/mainmenu.gd'),
      Promise.all(FONT_NAMES.map(async n => [n, new MenuFont(parseDvf(await fetchBytes(`Data/${n}.dvf`)), n === 'dv7pts2' ? 4 : undefined)] as const)),
      fetchBytes('Data/DV.tdb').then(parseTdb).then(async st => {
        // Gold Edition: Addon.tdb adds ids 325..330 ("Addon:", "Addon Kampagnen", ...)
        try { for (const [k, v] of parseTdb(await fetchBytes('Data/Addon.tdb'))) if (!st.has(k)) st.set(k, v); } catch { /* base install */ }
        return st;
      }),
    ]);
    images.setOpaque(OPAQUE_BACKGROUNDS);
    return new MenuAssets(images, new Map(fonts), strings);
  }

  font(n: MenuFontName): MenuFont { return this.fonts.get(n)!; }

  /** DV.tdb string by id */
  s(id: number): string { return this.strings.get(id) ?? `#${id}`; }

  img(name: string, frame = 0): HTMLCanvasElement | undefined { return this.images.get(name, frame); }

  /** a sprite frame with a colour laid over its opaque pixels (hover / disabled look, 8) */
  tintedImg(name: string, frame: number, color: string, strength: number): HTMLCanvasElement | undefined {
    const key = `${name}#${frame}#${color}#${strength}`;
    let t = this.tinted.get(key);
    if (!t) {
      const src = this.img(name, frame);
      if (!src) return undefined;
      const make = (s: CanvasImageSource, w: number, h: number) => {
        const out = document.createElement('canvas');
        out.width = w; out.height = h;
        const c = out.getContext('2d')!;
        c.drawImage(s, 0, 0, w, h);
        c.globalCompositeOperation = 'source-atop';
        c.globalAlpha = strength;
        c.fillStyle = color;
        c.fillRect(0, 0, w, h);
        return out;
      };
      t = make(src, src.width, src.height);
      deriveHd(src, t, make);
      this.tinted.set(key, t);
    }
    return t;
  }

  /** button press sound: effect 42 = Data/SOUND/Sfx_042.wav (1.2, 7) */
  click(): void {
    if (!this.soundOn || this.effectVolume <= 0) return;
    this.clickEl ??= new Audio('/game/Data/SOUND/Sfx_042.wav');
    const a = this.clickEl.cloneNode() as HTMLAudioElement;
    a.volume = this.effectVolume;
    a.play().catch(() => { /* blocked or missing: silent */ });
  }
}
