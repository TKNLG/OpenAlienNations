// Front-end widgets, all in 800 x 600 menu coordinates. Spec: docs/ui/front-end.md 1.2-1.7.
// Rectangles are inclusive: width = x2 - x1 + 1 (1.1).

import type { MenuAssets, MenuFontName } from './assets.ts';

export interface Rect { x1: number; y1: number; x2: number; y2: number; }
export const R = (x1: number, y1: number, x2: number, y2: number): Rect => ({ x1, y1, x2, y2 });
export const inside = (r: Rect, x: number, y: number) => x >= r.x1 && x <= r.x2 && y >= r.y1 && y <= r.y2;

/** colours (1.3; COLORREF converted to RGB) */
export const C = {
  brown: '#605034', blue: '#6050FC', red: '#FF0000', black: '#000000',
  white: '#FFFFFF', yellow: '#FFFF00', darkRed: '#501814',
} as const;
/** sprite button tints (8): light blue on hover, white for disabled */
const HOVER_TINT = '#9696FF', DISABLED_TINT = '#FFFFFF';

export type Align = 'L' | 'C' | 'R';

/** what a widget sees of the layer while drawing or handling input */
export interface Ui {
  readonly a: MenuAssets;
  readonly ctx: CanvasRenderingContext2D;
  readonly mouse: { x: number; y: number };
  readonly now: number;
  redraw(): void;
}

/** text in a rectangle, vertically centred (1.2); `valign` 'B' puts it on the bottom edge */
export function drawText(ui: Ui, font: MenuFontName, text: string, r: Rect, align: Align, color: string, valign: 'M' | 'B' = 'M'): void {
  const f = ui.a.font(font);
  const w = f.measure(text), rw = r.x2 - r.x1 + 1, rh = r.y2 - r.y1 + 1;
  const x = align === 'L' ? r.x1 : align === 'R' ? r.x2 + 1 - w : r.x1 + Math.floor((rw - w) / 2);
  const y = valign === 'B' ? r.y2 + 1 - f.height : r.y1 + Math.floor((rh - f.height) / 2);
  f.draw(ui.ctx, text, x, y, color);
}

export abstract class Widget {
  rect: Rect;
  visible = true;
  constructor(rect: Rect) { this.rect = rect; }
  abstract draw(ui: Ui, hover: boolean): void;
  /** drawn after every other widget (hover name plates) */
  drawOver(_ui: Ui, _hover: boolean): void { /* nothing */ }
  /** takes pointer input */
  get interactive(): boolean { return false; }
  hit(x: number, y: number): boolean { return this.visible && inside(this.rect, x, y); }
  /** changes when what the widget shows for the mouse position changes (hovered line etc.) */
  hoverKey(_x: number, _y: number): number { return 0; }
  press(_ui: Ui, _x: number, _y: number): void { /* nothing */ }
  drag(_ui: Ui, _x: number, _y: number): void { /* nothing */ }
  release(_ui: Ui, _x: number, _y: number, _over: boolean): void { /* nothing */ }
  wheel(_ui: Ui, _dy: number): void { /* nothing */ }
  /** called every animation frame; true = needs a redraw. Widgets without animation return false */
  tick(_ui: Ui, _now: number): boolean { return false; }
  get animated(): boolean { return false; }
}

/** label: text only, not clickable; `wrap` word-wraps a block centred in the rectangle */
export class Label extends Widget {
  text: string; font: MenuFontName; color: string; align: Align; wrap: boolean; valign: 'M' | 'B';
  constructor(rect: Rect, text: string, font: MenuFontName, color: string, align: Align = 'C', wrap = false, valign: 'M' | 'B' = 'M') {
    super(rect);
    this.text = text; this.font = font; this.color = color; this.align = align; this.wrap = wrap; this.valign = valign;
  }
  override draw(ui: Ui): void {
    if (!this.wrap) { drawText(ui, this.font, this.text, this.rect, this.align, this.color, this.valign); return; }
    const f = ui.a.font(this.font), r = this.rect;
    const lines = f.wrap(this.text, r.x2 - r.x1 + 1);
    const total = lines.length * f.height;
    let y = r.y1 + Math.floor((r.y2 - r.y1 + 1 - total) / 2);
    for (const l of lines) { drawText(ui, this.font, l, R(r.x1, y, r.x2, y + f.height - 1), this.align, this.color); y += f.height; }
  }
}

/** text button: normal colour, hover colour while the mouse is over it; click = press and
 *  release inside; click sound on press (1.2) */
export class TextButton extends Widget {
  text: string; font: MenuFontName; color: string; hoverColor: string; align: Align;
  action: () => void;
  constructor(rect: Rect, text: string, action: () => void, font: MenuFontName = 'dv14pt', color: string = C.brown, align: Align = 'C', hoverColor: string = C.red) {
    super(rect);
    this.text = text; this.action = action; this.font = font; this.color = color; this.align = align; this.hoverColor = hoverColor;
  }
  override get interactive(): boolean { return true; }
  override draw(ui: Ui, hover: boolean): void { drawText(ui, this.font, this.text, this.rect, this.align, hover ? this.hoverColor : this.color); }
  override press(ui: Ui): void { ui.a.click(); }
  override release(_ui: Ui, _x: number, _y: number, over: boolean): void { if (over) this.action(); }
}

/** a sprite drawn with its top-left at (x, y); the .gd offset is ignored (1.1) */
export class Image extends Widget {
  name: string; frame: number;
  constructor(name: string, x: number, y: number, ui: { a: MenuAssets }, frame = 0) {
    const [w, h] = ui.a.images.size(name) ?? [0, 0];
    super(R(x, y, x + w - 1, y + h - 1));
    this.name = name; this.frame = frame;
  }
  override draw(ui: Ui, _hover = false): void { const c = ui.a.img(this.name, this.frame); if (c) ui.ctx.drawImage(c, this.rect.x1, this.rect.y1); }
}

/** a clickable sprite (arrows): light-blue tint on hover (8) */
export class SpriteButton extends Image {
  action: () => void;
  constructor(name: string, x: number, y: number, ui: { a: MenuAssets }, action: () => void) { super(name, x, y, ui); this.action = action; }
  override get interactive(): boolean { return true; }
  override draw(ui: Ui, hover: boolean): void {
    const c = hover ? ui.a.tintedImg(this.name, 0, HOVER_TINT, 0.35) : ui.a.img(this.name);
    if (c) ui.ctx.drawImage(c, this.rect.x1, this.rect.y1);
  }
  override press(ui: Ui): void { ui.a.click(); }
  override release(_ui: Ui, _x: number, _y: number, over: boolean): void { if (over) this.action(); }
}

/** step of the race figure animation (3.4: at most one frame per 50 ms; we use a fixed 55 ms) */
export const FIGURE_STEP_MS = 55;

/** animated race figure with a name plate shown while hovered (3.4) */
export class Figure extends Widget {
  name: string; frame = 0; frames: number; last = 0;
  plate: Image; action: () => void; disabled = false;
  constructor(name: string, x: number, y: number, plate: Image, ui: { a: MenuAssets }, action: () => void) {
    const [w, h] = ui.a.images.size(name) ?? [0, 0];
    super(R(x, y, x + w - 1, y + h - 1));
    this.name = name; this.plate = plate; this.action = action;
    this.frames = Math.max(1, ui.a.images.frameCount(name));
  }
  override get interactive(): boolean { return !this.disabled; }
  override get animated(): boolean { return true; }
  override tick(_ui: Ui, now: number): boolean {
    if (now - this.last < FIGURE_STEP_MS) return false;
    this.last = now;
    this.frame = (this.frame + 1) % this.frames;
    return true;
  }
  override draw(ui: Ui, hover: boolean): void {
    const c = this.disabled ? ui.a.tintedImg(this.name, this.frame, DISABLED_TINT, 0.55)
      : hover ? ui.a.tintedImg(this.name, this.frame, HOVER_TINT, 0.18) : ui.a.img(this.name, this.frame);
    if (c) ui.ctx.drawImage(c, this.rect.x1, this.rect.y1);
  }
  override drawOver(ui: Ui, hover: boolean): void { if (hover && !this.disabled) this.plate.draw(ui); }
  override press(ui: Ui): void { ui.a.click(); }
  override release(_ui: Ui, _x: number, _y: number, over: boolean): void { if (over && !this.disabled) this.action(); }
}

export interface ListLine { text: string; value: number; marked?: boolean; }

export interface ListOptions {
  font?: MenuFontName; color?: string; hoverColor?: string; align?: Align;
  /** line spacing factor: 1.2 for lists, 1.0 for the briefing text and chat log (1.4) */
  spacing?: number;
  /** null = lines are not clickable */
  onPick?: ((value: number, index: number) => void) | null;
}

/** list box (1.4): lines of text, scroll arrows at the right edge, wheel scrolls */
export class ListBox extends Widget {
  lines: ListLine[] = [];
  top = 0;
  selected = -1;
  font: MenuFontName; color: string; hoverColor: string; align: Align; lineH = 13;
  onPick: ((value: number, index: number) => void) | null;
  /** notified when the scroll position changes (briefing scroll ring) */
  onScroll: (() => void) | null = null;
  private spacing: number;
  private pressed: 'up' | 'down' | number | null = null;
  constructor(rect: Rect, opt: ListOptions = {}) {
    super(rect);
    this.font = opt.font ?? 'dv7pts2'; this.color = opt.color ?? C.brown; this.hoverColor = opt.hoverColor ?? C.red;
    this.align = opt.align ?? 'C'; this.spacing = opt.spacing ?? 1.2; this.onPick = opt.onPick ?? null;
  }
  /** set the font-dependent line height (needs the assets) */
  layout(a: MenuAssets): this { this.lineH = Math.trunc(a.font(this.font).height * this.spacing); return this; }
  get visibleLines(): number { return Math.max(1, Math.floor((this.rect.y2 - this.rect.y1 + 1) / this.lineH)); }
  get maxTop(): number { return Math.max(0, this.lines.length - this.visibleLines); }
  setLines(lines: ListLine[]): void { this.lines = lines; this.top = Math.min(this.top, this.maxTop); this.onScroll?.(); }
  scrollTo(top: number): void {
    const t = Math.max(0, Math.min(this.maxTop, top));
    if (t !== this.top) { this.top = t; this.onScroll?.(); }
  }
  private get textRight(): number { return this.rect.x2 - 18; }
  private upRect(): Rect { return R(this.rect.x2 - 17, this.rect.y1, this.rect.x2, this.rect.y1 + 11); }
  private downRect(): Rect { return R(this.rect.x2 - 17, this.rect.y2 - 11, this.rect.x2, this.rect.y2); }
  private lineAt(x: number, y: number): number {
    if (x > this.textRight) return -1;
    const k = Math.floor((y - this.rect.y1) / this.lineH);
    const i = this.top + k;
    return k >= 0 && k < this.visibleLines && i < this.lines.length ? i : -1;
  }
  private part(x: number, y: number): 'up' | 'down' | number | null {
    if (this.top > 0 && inside(this.upRect(), x, y)) return 'up';
    if (this.top < this.maxTop && inside(this.downRect(), x, y)) return 'down';
    const i = this.onPick ? this.lineAt(x, y) : -1;
    return i >= 0 ? i : null;
  }
  override get interactive(): boolean { return true; }
  override hoverKey(x: number, y: number): number { const p = this.part(x, y); return p === null ? -1 : p === 'up' ? -2 : p === 'down' ? -3 : p; }
  override draw(ui: Ui, hover: boolean): void {
    const hp = hover ? this.part(ui.mouse.x, ui.mouse.y) : null;
    for (let k = 0; k < this.visibleLines; k++) {
      const i = this.top + k, l = this.lines[i];
      if (!l) break;
      const y = this.rect.y1 + k * this.lineH;
      const color = i === this.selected ? C.yellow : l.marked ? C.darkRed : hp === i ? this.hoverColor : this.color;
      drawText(ui, this.font, l.text, R(this.rect.x1, y, this.textRight, y + this.lineH - 1), this.align, color);
    }
    const up = ui.a.img('SIDE_PFEILOBEN'), down = ui.a.img('SIDE_PFEILUNTEN');
    if (this.top > 0 && up) ui.ctx.drawImage(hp === 'up' ? ui.a.tintedImg('SIDE_PFEILOBEN', 0, HOVER_TINT, 0.35)! : up, this.upRect().x1, this.upRect().y1);
    if (this.top < this.maxTop && down) ui.ctx.drawImage(hp === 'down' ? ui.a.tintedImg('SIDE_PFEILUNTEN', 0, HOVER_TINT, 0.35)! : down, this.downRect().x1, this.downRect().y1);
  }
  override press(ui: Ui, x: number, y: number): void {
    this.pressed = this.part(x, y);
    if (this.pressed === null) return;
    ui.a.click();
    if (this.pressed === 'up') this.scrollTo(this.top - 1);
    else if (this.pressed === 'down') this.scrollTo(this.top + 1);
    ui.redraw();
  }
  override release(_ui: Ui, x: number, y: number): void {
    const p = this.pressed;
    this.pressed = null;
    if (typeof p === 'number' && this.part(x, y) === p && this.onPick) this.onPick(this.lines[p].value, p);
  }
  override wheel(ui: Ui, dy: number): void { this.scrollTo(this.top + Math.sign(dy)); ui.redraw(); }
}

/** horizontal slider (1.6): ring dragged along a track, value min..max, live changes */
export class Slider extends Widget {
  value: number; min: number; max: number; ring = 'SCHIEBERING-SOUND0'; ringW = 36; ringY: number;
  onChange: (v: number) => void;
  private grab = 0;
  /** track = rectangle the ring travels in; ringY = top of the ring */
  constructor(track: Rect, ringY: number, min: number, max: number, value: number, onChange: (v: number) => void) {
    super(track);
    this.ringY = ringY; this.min = min; this.max = max; this.value = value; this.onChange = onChange;
  }
  private get travel(): number { return this.rect.x2 - this.rect.x1 + 1 - this.ringW; }
  private ringX(): number { return this.rect.x1 + Math.round(this.travel * (this.value - this.min) / (this.max - this.min)); }
  override get interactive(): boolean { return true; }
  override hit(x: number, y: number): boolean {
    return this.visible && (inside(this.rect, x, y) || inside(R(this.ringX(), this.ringY, this.ringX() + this.ringW - 1, this.ringY + this.ringW - 1), x, y));
  }
  override draw(ui: Ui): void { const c = ui.a.img(this.ring); if (c) ui.ctx.drawImage(c, this.ringX(), this.ringY); }
  override press(ui: Ui, x: number): void {
    const rx = this.ringX();
    // grabbing the ring keeps the grab point; a click on the track centres the ring there
    this.grab = x >= rx && x < rx + this.ringW ? x - rx : this.ringW >> 1;
    this.drag(ui, x);
  }
  override drag(ui: Ui, x: number): void {
    const off = Math.max(0, Math.min(this.travel, x - this.grab - this.rect.x1));
    const v = this.min + Math.round(off * (this.max - this.min) / this.travel);
    if (v !== this.value) { this.value = v; this.onChange(v); ui.redraw(); }
  }
}

/** vertical scroll ring for the briefing text (3.6): top = first line, bottom = last page */
export class ScrollRing extends Widget {
  list: ListBox; ring = 'SCHIEBERING-SOUND0'; ringS = 36;
  private grab = 0;
  constructor(track: Rect, list: ListBox, ring?: string) {
    super(track); this.list = list;
    if (ring === 'SCHIEBERINGAO') { this.ring = ring; this.ringS = 70; }   // add-on ring, 60 x 70
  }
  private get travel(): number { return this.rect.y2 - this.rect.y1 + 1 - this.ringS; }
  private ringY(): number { const m = this.list.maxTop; return this.rect.y1 + (m ? Math.round(this.travel * this.list.top / m) : 0); }
  private ringX(): number { return this.rect.x1 + Math.floor((this.rect.x2 - this.rect.x1 + 1 - this.ringS) / 2); }
  override get interactive(): boolean { return this.list.maxTop > 0; }
  override draw(ui: Ui): void { const c = ui.a.img(this.ring); if (c) ui.ctx.drawImage(c, this.ringX(), this.ringY()); }
  override press(ui: Ui, _x: number, y: number): void {
    const ry = this.ringY();
    this.grab = y >= ry && y < ry + this.ringS ? y - ry : this.ringS >> 1;
    this.drag(ui, 0, y);
  }
  override drag(ui: Ui, _x: number, y: number): void {
    const off = Math.max(0, Math.min(this.travel, y - this.grab - this.rect.y1));
    const top = Math.round(off * this.list.maxTop / Math.max(1, this.travel));
    if (top !== this.list.top) { this.list.scrollTo(top); ui.redraw(); }
  }
  override wheel(ui: Ui, dy: number): void { this.list.wheel(ui, dy); }
}

/** text edit on an INPUT1 plate (1.5). Typing goes through a hidden <input> owned by the layer */
export class TextEdit extends Widget {
  plate: Image; value: string; maxLen: number; color: string; clearOnClick: boolean;
  onEnter: () => void;
  focused = false;
  /** password field (our addition: lobby passwords): one '+' per character (dv7pts2 has no '*') */
  mask = false;
  constructor(plateX: number, plateY: number, ui: { a: MenuAssets }, value: string, maxLen: number, color: string, onEnter: () => void, clearOnClick = false) {
    super(R(plateX + 33, plateY + 21, plateX + 299, plateY + 40));
    this.plate = new Image('INPUT1', plateX, plateY, ui);
    this.value = value; this.maxLen = maxLen; this.color = color; this.onEnter = onEnter; this.clearOnClick = clearOnClick;
  }
  override get interactive(): boolean { return true; }
  override get animated(): boolean { return this.focused; }
  private blink = true;
  override tick(_ui: Ui, now: number): boolean {
    const b = Math.floor(now / 530) % 2 === 0;
    if (b === this.blink) return false;
    this.blink = b;
    return true;
  }
  override draw(ui: Ui): void {
    this.plate.draw(ui);
    const f = ui.a.font('dv7pts2'), r = this.rect;
    const shown = this.mask ? '+'.repeat(this.value.length) : this.value;
    drawText(ui, 'dv7pts2', shown, r, 'C', this.color);
    if (this.focused && this.blink) {
      // caret: a simple bar after the text (look unknown, 1.5)
      const w = f.measure(shown);
      const x = r.x1 + Math.floor((r.x2 - r.x1 + 1 - w) / 2) + w + 1;
      const y = r.y1 + Math.floor((r.y2 - r.y1 + 1 - f.height) / 2);
      ui.ctx.fillStyle = this.color;
      ui.ctx.fillRect(x, y, 1, f.height);
    }
  }
}
