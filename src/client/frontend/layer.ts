// The front-end layer: one 800 x 600 menu canvas scaled to fit the window (aspect kept,
// letterboxed), one screen at a time plus an optional message box on top. Spec:
// docs/ui/front-end.md 1.1 (coordinates, one screen at a time), 1.7 (message boxes).
//
// Drawing: the screen is painted into an 800 x 600 canvas only when something changed (hover,
// click, animation step), then blitted with nearest-neighbour to an integer multiple of 800 x 600;
// the browser scales that down to the window smoothly, so the art stays crisp at any size.

import type { MenuAssets } from './assets.ts';
import { hdListeners } from '../ui-assets.ts';
import { C, Image, Label, R, TextButton, TextEdit, type Ui, type Widget } from './widgets.ts';

export interface Screen {
  /** background sprite; null = transparent (message box over the running game) */
  bg: string | null;
  widgets: Widget[];
  /** Escape key */
  onEscape?: () => void;
  /** called when the screen is replaced or hidden (stop timers, sounds) */
  onClose?: () => void;
  /** no mouse cursor while it is shown (loading the game screen, docs/ui/cursors.md 5.1);
   *  every other screen has the arrow (inherited from the page) */
  hideCursor?: boolean;
}

export const W = 800, H = 600;

export class FrontEnd implements Ui {
  readonly a: MenuAssets;
  readonly root: HTMLDivElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly mouse = { x: -1, y: -1 };
  now = 0;
  private canvas: HTMLCanvasElement;
  private dctx: CanvasRenderingContext2D;
  private off: HTMLCanvasElement;
  private input: HTMLInputElement;
  private screen: Screen | null = null;
  private box: Screen | null = null;
  private hover: Widget | null = null;
  private hoverKey = 0;
  private active: Widget | null = null;
  private edit: TextEdit | null = null;
  private scale = 1;
  private k = 1;
  private dirty = false;
  private loop = false;
  /** Escape while the layer is hidden (in game) */
  onGameEscape: (() => void) | null = null;

  constructor(assets: MenuAssets) {
    this.a = assets;
    hdListeners.add(() => this.redraw());
    this.root = document.createElement('div');
    this.root.id = 'frontend';
    Object.assign(this.root.style, { position: 'fixed', inset: '0', zIndex: '50', background: '#000', display: 'none', touchAction: 'none' });
    this.canvas = document.createElement('canvas');
    Object.assign(this.canvas.style, { position: 'absolute', display: 'block' });
    this.off = document.createElement('canvas');
    this.off.width = W; this.off.height = H;
    this.ctx = this.off.getContext('2d')!;
    this.dctx = this.canvas.getContext('2d')!;
    // hidden text input for save names, player names and chat (keyboard, IME, mobile keyboards)
    this.input = document.createElement('input');
    this.input.type = 'text';
    this.input.autocomplete = 'off';
    this.input.spellcheck = false;
    this.input.setAttribute('aria-label', 'Texteingabe');
    Object.assign(this.input.style, { position: 'absolute', opacity: '0', border: '0', padding: '0', fontSize: '16px', background: 'transparent', color: 'transparent', caretColor: 'transparent', pointerEvents: 'none' });
    this.root.append(this.canvas, this.input);
    document.body.append(this.root);
    this.bind();
    this.layout();
  }

  get visible(): boolean { return this.root.style.display !== 'none'; }
  get current(): Screen | null { return this.screen; }

  /** open a screen (destroys the previous one); `sync` paints at once (loading screen) */
  show(screen: Screen, sync = false): void {
    this.closeScreen();
    this.box?.onClose?.();
    this.box = null;
    this.screen = screen;
    this.root.style.display = 'block';
    this.root.style.background = screen.bg ? '#000' : 'transparent';
    this.root.style.cursor = screen.hideCursor ? 'none' : '';
    this.edit = (screen.widgets.find(w => w instanceof TextEdit) as TextEdit | undefined) ?? null;
    if (this.edit) this.focusEdit(this.edit);
    else this.input.blur();
    this.hover = null; this.active = null;
    this.layout();
    this.updateHover();
    if (sync) this.paint(); else this.redraw();
    this.ensureLoop();
  }

  /** hide the whole layer (game visible) */
  hide(): void {
    this.closeScreen();
    this.box?.onClose?.();
    this.box = null;
    this.screen = null;
    this.edit = null;
    this.input.blur();
    this.root.style.display = 'none';
    this.root.style.cursor = '';
  }

  private closeScreen(): void {
    const s = this.screen;
    this.screen = null;
    s?.onClose?.();
  }

  /** OK box (1.7): text, then `then` after the box closed */
  message(text: string, then?: () => void): void {
    this.openBox(text, [new TextButton(R(350, 360, 450, 390), this.a.s(181), () => { this.closeBox(); then?.(); }, 'dv10pt')]);
  }

  /** Yes/No box (1.7) */
  ask(text: string, yes: () => void, no?: () => void): void {
    this.openBox(text, [
      new TextButton(R(250, 360, 350, 390), this.a.s(204), () => { this.closeBox(); yes(); }, 'dv10pt'),
      new TextButton(R(450, 360, 550, 390), this.a.s(205), () => { this.closeBox(); no?.(); }, 'dv10pt'),
    ]);
  }

  get boxOpen(): boolean { return this.box !== null; }

  private openBox(text: string, buttons: Widget[]): void {
    if (!this.screen) {
      // a box over the game screen: transparent layer
      this.screen = { bg: null, widgets: [] };
      this.root.style.background = 'transparent';
    }
    this.root.style.display = 'block';
    this.root.style.cursor = '';   // message boxes: the arrow (cursors.md 5.1)
    this.box = { bg: null, widgets: [new Image('MESSAGEBOX', 200, 190, this), new Label(R(220, 200, 580, 350), text, 'dv7pts2', C.brown, 'C', true), ...buttons] };
    this.input.blur();
    this.hover = null; this.active = null;
    this.layout();
    this.updateHover();
    this.redraw();
  }

  private closeBox(): void {
    this.box = null;
    this.hover = null; this.active = null;
    if (this.screen && this.screen.bg === null && this.screen.widgets.length === 0) { this.screen = null; this.root.style.display = 'none'; return; }
    if (this.edit) this.focusEdit(this.edit);
    this.updateHover();
    this.redraw();
  }

  // ---------------------------------------------------------------- drawing

  redraw(): void {
    if (this.dirty) return;
    this.dirty = true;
    requestAnimationFrame(() => { if (this.dirty) this.paint(); });
  }

  private paint(): void {
    this.dirty = false;
    if (!this.visible) return;
    this.now = performance.now();
    const ctx = this.ctx, s = this.screen;
    // paint at the output resolution (k x 800 x 600): the original art is scaled with
    // nearest-neighbour as before, HD pack images keep their detail
    if (this.off.width !== W * this.k) { this.off.width = W * this.k; this.off.height = H * this.k; }
    ctx.setTransform(this.k, 0, 0, this.k, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, W, H);
    if (s?.bg) {
      const bg = this.a.img(s.bg);
      if (bg) ctx.drawImage(bg, 0, 0); else { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); }
    }
    for (const layer of [s, this.box]) {
      if (!layer) continue;
      const live = layer === (this.box ?? s);
      for (const w of layer.widgets) if (w.visible) w.draw(this, live && w === this.hover);
      for (const w of layer.widgets) if (w.visible) w.drawOver(this, live && w === this.hover);
    }
    const d = this.dctx;
    d.imageSmoothingEnabled = false;
    d.clearRect(0, 0, this.canvas.width, this.canvas.height);
    d.drawImage(this.off, 0, 0);
  }

  /** animation: runs only while a widget of the open screen animates (figures, caret) */
  private ensureLoop(): void {
    if (this.loop) return;
    const animated = () => this.visible && !!this.screen?.widgets.some(w => w.visible && w.animated);
    if (!animated()) return;
    this.loop = true;
    const step = (t: number) => {
      if (!animated()) { this.loop = false; return; }
      let changed = false;
      for (const w of this.screen!.widgets) if (w.visible && w.animated && w.tick(this, t)) changed = true;
      if (changed) this.redraw();
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // ---------------------------------------------------------------- layout and input

  private layout(): void {
    const vw = window.innerWidth, vh = window.innerHeight, dpr = window.devicePixelRatio || 1;
    const s = Math.min(vw / W, vh / H);
    this.scale = s;
    const k = Math.max(1, Math.min(4, Math.ceil(s * dpr - 0.01)));
    if (k !== this.k || this.canvas.width !== W * k) { this.k = k; this.canvas.width = W * k; this.canvas.height = H * k; }
    const cw = W * s, ch = H * s, left = (vw - cw) / 2, top = (vh - ch) / 2;
    Object.assign(this.canvas.style, { left: `${left}px`, top: `${top}px`, width: `${cw}px`, height: `${ch}px` });
    if (this.edit) {
      const r = this.edit.rect;
      Object.assign(this.input.style, { left: `${left + r.x1 * s}px`, top: `${top + r.y1 * s}px`, width: `${(r.x2 - r.x1 + 1) * s}px`, height: `${(r.y2 - r.y1 + 1) * s}px` });
    }
  }

  private toMenu(e: { clientX: number; clientY: number }): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [Math.floor((e.clientX - r.left) / this.scale), Math.floor((e.clientY - r.top) / this.scale)];
  }

  private widgetsForInput(): Widget[] { return (this.box ?? this.screen)?.widgets ?? []; }

  private pick(x: number, y: number): Widget | null {
    const ws = this.widgetsForInput();
    for (let i = ws.length - 1; i >= 0; i--) if (ws[i].interactive && ws[i].hit(x, y)) return ws[i];
    return null;
  }

  private updateHover(): void {
    const w = this.pick(this.mouse.x, this.mouse.y);
    const key = w ? w.hoverKey(this.mouse.x, this.mouse.y) : 0;
    if (w !== this.hover || key !== this.hoverKey) { this.hover = w; this.hoverKey = key; this.redraw(); }
  }

  private focusEdit(edit: TextEdit): void {
    for (const w of this.screen?.widgets ?? []) if (w instanceof TextEdit) w.focused = false;
    this.edit = edit;
    edit.focused = true;
    this.input.maxLength = edit.maxLen;
    this.input.value = edit.value;
    this.layout();
    // focus after the current event so a click does not immediately blur it again
    setTimeout(() => { if (this.edit === edit && !this.box) { this.input.focus({ preventScroll: true }); this.input.setSelectionRange(edit.value.length, edit.value.length); } }, 0);
    this.ensureLoop();
  }

  private bind(): void {
    window.addEventListener('resize', () => { this.layout(); this.redraw(); });
    const cv = this.root;
    cv.addEventListener('contextmenu', e => e.preventDefault());
    cv.addEventListener('pointerdown', e => {
      if (e.target === this.input) return;
      e.preventDefault();
      [this.mouse.x, this.mouse.y] = this.toMenu(e);
      if (e.button !== 0) return;
      const w = this.pick(this.mouse.x, this.mouse.y);
      this.active = w;
      if (!w) { if (this.edit && !this.box) this.focusEdit(this.edit); return; }
      cv.setPointerCapture(e.pointerId);
      if (w instanceof TextEdit) {
        if (w.clearOnClick) { w.value = ''; }
        this.focusEdit(w);
      }
      w.press(this, this.mouse.x, this.mouse.y);
      this.redraw();
    });
    cv.addEventListener('pointermove', e => {
      [this.mouse.x, this.mouse.y] = this.toMenu(e);
      if (this.active) this.active.drag(this, this.mouse.x, this.mouse.y);
      this.updateHover();
    });
    cv.addEventListener('pointerup', e => {
      [this.mouse.x, this.mouse.y] = this.toMenu(e);
      const w = this.active;
      this.active = null;
      if (w) w.release(this, this.mouse.x, this.mouse.y, w.hit(this.mouse.x, this.mouse.y));
      if (this.edit && !this.box && this.visible && document.activeElement !== this.input) this.focusEdit(this.edit);
      this.updateHover();
      this.redraw();
    });
    cv.addEventListener('pointerleave', () => { this.mouse.x = this.mouse.y = -1; this.updateHover(); });
    cv.addEventListener('wheel', e => {
      e.preventDefault();
      [this.mouse.x, this.mouse.y] = this.toMenu(e);
      const w = this.pick(this.mouse.x, this.mouse.y) ?? this.widgetsForInput().find(x => x.visible && x.interactive && 'lines' in x) ?? null;
      w?.wheel(this, e.deltaY);
      this.updateHover();
    }, { passive: false });
    this.input.addEventListener('input', () => {
      if (!this.edit) return;
      this.edit.value = this.input.value.slice(0, this.edit.maxLen);
      this.redraw();
    });
    this.input.addEventListener('blur', () => { if (this.edit) { this.edit.focused = false; this.redraw(); } });
    this.input.addEventListener('focus', () => { if (this.edit) { this.edit.focused = true; this.ensureLoop(); this.redraw(); } });
    // keys: while the layer is visible it owns the keyboard (capture phase, the game never sees them)
    window.addEventListener('keydown', e => {
      if (!this.visible) return;
      e.stopPropagation();
      if (e.key === 'Enter' && this.edit && !this.box && !e.isComposing) { e.preventDefault(); this.edit.onEnter(); }
      else if (e.key === 'Escape' && !this.box) { e.preventDefault(); this.screen?.onEscape?.(); }
    }, true);
    window.addEventListener('keyup', e => { if (this.visible) e.stopPropagation(); }, true);
    // Escape in game (bubble phase: the game may have used it to cancel a placement)
    window.addEventListener('keydown', e => {
      if (this.visible || e.defaultPrevented || e.key !== 'Escape') return;
      this.onGameEscape?.();
    });
  }
}
