// In-game side panel. Spec: docs/ui/side-panel.md (section numbers below).
//
// The panel is drawn from the race's own interface art (INTERFACE1024, 192x768) at a UI scale
// that fits the window height; extra height stretches a plain band of the dark lower area.
// Everything is immediate mode: each redraw rebuilds the list of buttons, so hit-testing always
// matches what is on screen. Clicks fire on mouse-up inside the same button (3.1).

import { deriveHd, type UiImages, type BitmapFont, type FontName } from './ui-assets.ts';
import type { World, Entity, Command } from '../engine/world.ts';
import type { GameData } from './data.ts';
import type { ObjectDesc } from '../formats/od.ts';
import { format } from '../formats/tdb.ts';
import { drawPage, pageFor, infoBuilding, MissingOperatorLine, MENTOR_NO_OPERATOR, type PageCtx } from './hud-pages.ts';
import { marketPagesAllowed } from './hud-pages-trade.ts';
import { isTransport, isTrader, isMarketLike } from './addon-ui.ts';
import { requestHdPortrait, requestHdUiIcon } from './hd-icons.ts';
import { tintRgba, lookOf, type Tint } from './ui-tint.ts';

export const PANEL_W = 192;
export const PANEL_H = 768;
/** rows [STRETCH_A, STRETCH_B) of the panel art are stretched to fill extra height */
const STRETCH_A = 420, STRETCH_B = 700;
export const MINIMAP_SLOT = { x: 6, y: 6, w: 152, h: 152 };
export const PAGE_ORIGIN = { x: 4, y: 335 };

/** what the panel needs from the game */
export interface HudHost {
  readonly world: World | null;
  readonly data: GameData;
  readonly player: number;
  readonly selection: Entity[];
  currentTown: number;
  placing: number;
  /** zoom slider value 16 (normal) .. 64 (farthest out) (section 7) */
  zoomValue: number;
  command(c: Command): void;
  startPlacing(type: number): void;
  /** choose patrol waypoints for a soldier */
  startPatrol(id: number): void;
  /** town-hall placement for a founder (units-and-jobs.md 11.1) */
  startFounding(id: number): void;
  select(ids: number[]): void;
  /** centre the camera on a cell */
  centerOn(x: number, y: number): void;
  openMenu(): void;
  /** minimap layer toggles: buildings, units, resources, town areas */
  layers: boolean[];
}

export type { Tint } from './ui-tint.ts';

export interface Button {
  x: number; y: number; w: number; h: number;
  id: string;
  tip: string;
  disabled?: boolean;
  /** the 0x20 look bit alone (3.1): drawn dim but clickable (queued training slots) */
  dark?: boolean;
  /** a picture widget (3.1): tooltip only; no hover look, no click, no click sound */
  picture?: boolean;
  onClick?: () => void;
  onRight?: () => void;
  /** slider: called with the pointer x inside the panel while dragging */
  onDrag?: (px: number) => void;
}

const UI_SCALE_KEY = 'an.uiScale';

export class Hud {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private minimap: HTMLCanvasElement;
  ui: UiImages | null = null;
  uiOd: Map<number, ObjectDesc> = new Map();
  fonts: Map<FontName, BitmapFont> | null = null;
  strings: Map<number, string> = new Map();
  host: HudHost | null = null;
  /** css px per panel px */
  scale = 1;
  logicalH = PANEL_H;
  private buttons: Button[] = [];
  private hover = '';
  private pressed = '';
  private dragging: Button | null = null;
  mouse = { x: -1, y: -1 };
  /** grid page scroll (rows) */
  scroll = 0;
  townScroll = 0;
  /** logical page when nothing / something is selected, and per object type (5.1) */
  pageNone = 8;
  pageSel = 0;
  private pageByType = new Map<number, number>();
  /** shown money (rolls towards the real value, 3.6) */
  private shownMoney = -1;
  private chestFrame = 0;
  /** research list selection, market good selection ... page-local UI state */
  pageState: Record<string, number> = {};
  private portraits = new Map<number, HTMLCanvasElement | null>();
  private tinted = new WeakMap<HTMLCanvasElement, Map<Tint, HTMLCanvasElement>>();
  /** the current tooltip text (drawn by the overlay at the bottom-right of the world view) */
  tooltip = '';
  onLayout: () => void = () => {};
  onClickSound: () => void = () => {};
  /** a client-side advisor line (unqueued, never through the simulation): line 12 (1.1.5) */
  onAdvisor: (line: number) => void = () => {};
  private operatorLine = new MissingOperatorLine();

  constructor(canvas: HTMLCanvasElement, minimap: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.minimap = minimap;
    window.addEventListener('resize', () => this.layout());
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    canvas.addEventListener('pointermove', e => {
      this.setMouse(e);
      if (this.dragging?.onDrag) { this.dragging.onDrag(this.mouse.x); return; }
      const id = this.hit()?.id ?? '';
      if (id !== this.hover) { this.hover = id; this.draw(); }
    });
    canvas.addEventListener('pointerleave', () => { this.mouse = { x: -1, y: -1 }; this.hover = ''; this.tooltip = ''; this.draw(); });
    canvas.addEventListener('pointerdown', e => {
      this.setMouse(e);
      const b = this.hit();
      // disabled buttons and pictures only show their tooltip: no click sound, no click (3.1)
      if (!b || b.disabled || b.picture) return;
      canvas.setPointerCapture(e.pointerId);
      if (e.button === 0) {
        this.onClickSound();
        if (b.onDrag && !b.disabled) { this.dragging = b; b.onDrag(this.mouse.x); this.draw(); return; }
        this.pressed = b.id;
      } else if (e.button === 2) this.pressed = 'r:' + b.id;
    });
    canvas.addEventListener('pointerup', e => {
      this.setMouse(e);
      if (this.dragging) { this.dragging = null; this.draw(); return; }
      const b = this.hit();
      const pressed = this.pressed;
      this.pressed = '';
      if (!b || b.disabled || b.picture) return;
      if (e.button === 0 && pressed === b.id) b.onClick?.();
      else if (e.button === 2 && pressed === 'r:' + b.id) b.onRight?.();
      this.draw();
    });
    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      if (this.mouse.y < PAGE_ORIGIN.y) return;
      this.scroll = Math.max(0, this.scroll + (e.deltaY > 0 ? 1 : -1));
      this.draw();
    }, { passive: false });
    this.layout();
  }

  private setMouse(e: PointerEvent): void {
    const r = this.canvas.getBoundingClientRect();
    this.mouse = { x: (e.clientX - r.left) / this.scale, y: (e.clientY - r.top) / this.scale };
  }

  private hit(): Button | undefined {
    const { x, y } = this.mouse;
    for (let i = this.buttons.length - 1; i >= 0; i--) {
      const b = this.buttons[i];
      if (x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h) return b;
    }
    return undefined;
  }

  /** user setting: 0 = automatic (fit height), otherwise a fixed scale factor */
  static get userScale(): number {
    try {
      const q = new URLSearchParams(location.search).get('ui');
      if (q) return Number(q) || 0;
      return Number(localStorage.getItem(UI_SCALE_KEY) ?? 0) || 0;
    } catch { return 0; }
  }
  static set userScale(v: number) { try { localStorage.setItem(UI_SCALE_KEY, String(v)); } catch { /* storage unavailable */ } }

  /** crisp mode: whole-number UI scale, no smoothing (pixel-exact original art) */
  static get crisp(): boolean {
    try { return new URLSearchParams(location.search).has('crisp') || localStorage.getItem('an.uiCrisp') === '1'; } catch { return false; }
  }
  static set crisp(v: boolean) { try { localStorage.setItem('an.uiCrisp', v ? '1' : '0'); } catch { /* storage unavailable */ } }

  /** css width taken by the panel */
  get width(): number { return Math.round(PANEL_W * this.scale); }

  setAssets(ui: UiImages, uiOd: Map<number, ObjectDesc>, fonts: Map<FontName, BitmapFont>, strings: Map<number, string>): void {
    this.ui = ui; this.uiOd = uiOd; this.fonts = fonts; this.strings = strings;
    this.layout();
  }

  layout(): void {
    const vh = window.innerHeight, vw = window.innerWidth;
    const user = Hud.userScale;
    let s = user > 0 ? user : vh / PANEL_H;
    s = Math.max(0.5, Math.min(s, (vw / 3) / PANEL_W));
    if (Hud.crisp) s = Math.max(1, Math.floor(s * (window.devicePixelRatio || 1) + 0.05)) / (window.devicePixelRatio || 1);
    this.scale = s;
    this.logicalH = Math.max(PANEL_H, vh / s);
    const dpr = window.devicePixelRatio || 1;
    const cssW = this.width;
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${vh}px`;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(vh * dpr);
    const m = MINIMAP_SLOT;
    Object.assign(this.minimap.style, { left: `${vw - cssW + m.x * s}px`, top: `${m.y * s}px`, width: `${m.w * s}px`, height: `${m.h * s}px` });
    const mw = Math.round(m.w * s * dpr), mh = Math.round(m.h * s * dpr);
    if (this.minimap.width !== mw || this.minimap.height !== mh) { this.minimap.width = mw; this.minimap.height = mh; }
    document.documentElement.style.setProperty('--hud-w', `${cssW}px`);
    this.onLayout();
    this.draw();
  }

  // ---------------------------------------------------------------- helpers for pages

  str(id: number, ...args: (string | number)[]): string { return format(this.strings.get(id) ?? `#${id}`, ...args); }
  font(n: FontName): BitmapFont { return this.fonts!.get(n)!; }

  /**
   * A look of a sprite (3.1): every pixel mixed 50:50 with the look's tint colour, alpha kept, so
   * the copy alpha-blends onto the panel like the original. The HD image (pack or rendered) gets
   * the same per-pixel mix through deriveHd.
   */
  tint(img: HTMLCanvasElement, t: Tint): HTMLCanvasElement {
    if (t === 'normal') return img;
    let m = this.tinted.get(img);
    if (!m) { m = new Map(); this.tinted.set(img, m); }
    let c = m.get(t);
    if (!c) {
      const make = (src: CanvasImageSource, w: number, h: number) => {
        const out = document.createElement('canvas');
        out.width = w; out.height = h;
        const cx = out.getContext('2d', { willReadFrequently: true })!;
        cx.drawImage(src, 0, 0, w, h);
        const d = cx.getImageData(0, 0, w, h);
        tintRgba(d.data, t);
        cx.putImageData(d, 0, 0);
        return out;
      };
      c = make(img, img.width, img.height);
      deriveHd(img, c, make);
      m.set(t, c);
    }
    return c;
  }

  /** icon of an object type from the race's interface.OD (goods, nature: group 6) */
  uiIcon(oid: number): HTMLCanvasElement | undefined {
    const d = this.uiOd.get(oid);
    const name = d?.slots.find(s => s);
    return name ? this.uiSprite(name) : undefined;
  }

  /** a sprite of the race's interface.gd; pictures that are shrunk world sprites get HD from those */
  uiSprite(name: string): HTMLCanvasElement | undefined {
    const c = this.ui?.get(name);
    if (c && this.host) requestHdUiIcon(this.host.data, name, c, this.deviceScale);
    return c;
  }

  /** device pixels per panel pixel */
  private deviceScale = (): number => this.scale * (window.devicePixelRatio || 1);

  /** 45x45 portrait from dv.gd (descriptor group race + 3), loaded on first use */
  portrait(race: number, type: number): HTMLCanvasElement | undefined {
    const host = this.host;
    if (!host) return undefined;
    const key = ((race + 3) << 16) | type;
    if (this.portraits.has(key)) return this.portraits.get(key) ?? undefined;
    this.portraits.set(key, null);
    const desc = host.data.objects.get(key);
    const name = desc?.slots.find(s => s);
    const e = name ? host.data.sprites.entry(name) : undefined;
    if (e) {
      void host.data.sprites.frames(e, 0).then(fr => {
        const c = document.createElement('canvas');
        c.width = e.width; c.height = e.height;
        c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(fr[0].buffer, fr[0].byteOffset, fr[0].length), e.width, e.height), 0, 0);
        this.portraits.set(key, c);
        requestHdPortrait(host.data, race, type, c, this.deviceScale);
        this.draw();
      }).catch(() => { /* missing portrait */ });
    }
    return undefined;
  }

  private worldSprites = new Map<string, HTMLCanvasElement | null>();
  /** frame 0 of a world sprite (dv.gd, Gold: Addon.gd), drawn 1:1 by the nature info page */
  worldSprite(name: string): HTMLCanvasElement | undefined {
    const host = this.host;
    if (!host) return undefined;
    if (this.worldSprites.has(name)) return this.worldSprites.get(name) ?? undefined;
    this.worldSprites.set(name, null);
    const e = host.data.sprites.entry(name);
    if (e) {
      void host.data.sprites.frames(e, 0).then(fr => {
        const c = document.createElement('canvas');
        c.width = e.width; c.height = e.height;
        c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(fr[0].buffer, fr[0].byteOffset, fr[0].length), e.width, e.height), 0, 0);
        this.worldSprites.set(name, c);
        this.draw();
      }).catch(() => { /* missing sprite */ });
    }
    return undefined;
  }

  addButton(b: Button): Button { this.buttons.push(b); return b; }
  isHover(id: string): boolean { return this.hover === id; }

  /** draw a sprite button; returns its rect */
  imageButton(img: HTMLCanvasElement | undefined, x: number, y: number, b: Omit<Button, 'x' | 'y' | 'w' | 'h'> & { off?: boolean; w?: number; h?: number }): void {
    const w = b.w ?? img?.width ?? 30, h = b.h ?? img?.height ?? 30;
    this.addButton({ ...b, x, y, w, h });
    if (!img) return;
    this.ctx.drawImage(this.tint(img, lookOf(b, this.hover === b.id)), x, y, w, h);
  }

  get g(): CanvasRenderingContext2D { return this.ctx; }

  // ---------------------------------------------------------------- pages (5.1)

  /** the logical page to show now */
  currentPage(sel: Entity[]): number {
    if (!sel.length) return this.pageNone;
    if (sel.length > 1) return this.pageSel === 8 ? 8 : 0;
    const remembered = this.pageByType.get(sel[0].oid);
    // a transport ship opens on its passengers page (addon.md 5.6) until another page is chosen
    if (remembered === undefined && this.pageSel !== 8 && this.host?.world && isTransport(this.host.world, sel[0])) return 6;
    return remembered ?? this.pageSel;
  }

  showPage(n: number, sel: Entity[]): void {
    this.scroll = 0;
    if (!sel.length) { this.pageNone = n; return; }
    this.pageSel = n;
    const e = sel[0];
    // transport ships remember every page: their default is the passengers page, not 0
    const ship = !!this.host?.world && isTransport(this.host.world, e);
    const remember = ship ? n !== 8 : e.kind === 1 ? ![0, 6, 8].includes(n) : ![0, 8].includes(n);
    if (sel.length === 1) { if (remember) this.pageByType.set(e.oid, n); else this.pageByType.delete(e.oid); }
  }

  // ---------------------------------------------------------------- drawing

  draw(): void {
    const host = this.host;
    if (!this.ui || !this.fonts || !host) return;
    const ctx = this.ctx, dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(this.scale * dpr, 0, 0, this.scale * dpr, 0, 0);
    ctx.imageSmoothingEnabled = !Hud.crisp;
    ctx.imageSmoothingQuality = 'high';
    this.buttons = [];
    this.drawBackground();
    const w = host.world;
    if (w) {
      this.drawFixed(w, host);
      const sel = host.selection;
      const page = pageFor(this, host, sel);
      const pc: PageCtx = { hud: this, host, world: w, sel, x0: PAGE_ORIGIN.x, y0: PAGE_ORIGIN.y, h: this.logicalH - PAGE_ORIGIN.y };
      ctx.save();
      ctx.beginPath(); ctx.rect(0, PAGE_ORIGIN.y, PANEL_W, this.logicalH - PAGE_ORIGIN.y); ctx.clip();
      drawPage(pc, page);
      ctx.restore();
      // advisor line 12 when the info page of an own inactive building opens (side-panel.md 1.1.5)
      const b = infoBuilding(page, sel), r = b ? w.rules.get(b.oid) : undefined;
      if (this.operatorLine.build(!!b, b ? { id: b.id, own: b.owner === host.player, upkeep: r?.money ?? 0, active: b.active } : null))
        this.onAdvisor(MENTOR_NO_OPERATOR);
    }
    const over = this.hit();
    this.tooltip = over?.tip ?? '';
  }

  private drawBackground(): void {
    const img = this.ui!.get('INTERFACE1024');
    if (!img) return;
    const ctx = this.ctx, extra = this.logicalH - PANEL_H;
    ctx.drawImage(img, 0, 0, PANEL_W, STRETCH_A, 0, 0, PANEL_W, STRETCH_A);
    ctx.drawImage(img, 0, STRETCH_A, PANEL_W, STRETCH_B - STRETCH_A, 0, STRETCH_A, PANEL_W, STRETCH_B - STRETCH_A + extra);
    ctx.drawImage(img, 0, STRETCH_B, PANEL_W, PANEL_H - STRETCH_B, 0, STRETCH_B + extra, PANEL_W, PANEL_H - STRETCH_B);
  }

  /** section 3: toggles, options, zoom, town list, money, function bar */
  private drawFixed(w: World, host: HudHost): void {
    const ui = this.ui!, ctx = this.ctx;
    // map layer toggles (3)
    const toggles: [string, number, number, number][] = [['GEBAEUDE', 54, 41, 0], ['EINHEITEN', 82, 60, 1], ['HAENDLER', 109, 61, 2], ['STADTGEBIETE', 137, 62, 3]];
    for (const [name, y, tip, k] of toggles) {
      this.imageButton(ui.get(name), 166, y, { id: `layer:${k}`, tip: this.str(tip), off: !host.layers[k], onClick: () => { host.layers[k] = !host.layers[k]; } });
    }
    this.imageButton(ui.get('OPTIONEN'), 11, 162, { id: 'options', tip: this.str(63), onClick: () => host.openMenu() });
    // zoom slider (7)
    const v = Math.max(16, Math.min(64, host.zoomValue));
    const hx = 54 + (87 * (v - 16)) / 48;
    const ring = ui.get('RING');
    this.addButton({ x: 54, y: 165, w: 108, h: 31, id: 'zoom', tip: '', onDrag: px => { host.zoomValue = Math.max(16, Math.min(64, 16 + Math.round((48 * (px - 54 - 10)) / 87))); } });
    if (ring) ctx.drawImage(this.tint(ring, this.hover === 'zoom' ? 'hover' : 'normal'), hx, 170);
    this.drawTownList(w, host);
    this.drawMoney(w, host);
    this.drawFunctionBar(w, host);
  }

  /** 3.5 */
  private drawTownList(w: World, host: HudHost): void {
    const f = this.font('dv7pts2'), ui = this.ui!;
    const towns = w.economy.towns.filter(t => t.race === host.player && t.alive);
    const rows = 4;
    this.townScroll = Math.max(0, Math.min(this.townScroll, towns.length - rows));
    for (let i = 0; i < rows && this.townScroll + i < towns.length; i++) {
      const t = towns[this.townScroll + i];
      const y = 200 + i * 15, id = `town:${t.id}`;
      const name = this.str(142 + t.race * 10 + (t.nameIndex % 10));
      const color = t.id === host.currentTown ? '#ffff00' : this.hover === id ? '#ff0000' : '#ffffff';
      f.draw(this.ctx, name, 20, y + 1, color);
      this.addButton({ x: 20, y, w: 121, h: 15, id, tip: name,
        onClick: () => { host.currentTown = t.id; },
        onRight: () => { host.currentTown = t.id; host.centerOn(t.x, t.y); } });
      // status icons, right to left from x = 123: ordinary buttons with the hover look, the
      // tooltip and the click sound (3.5)
      let ix = 123;
      const icon = (name2: string, tip: string, onClick: () => void) => {
        const img = ui.get(name2);
        if (!img) return;
        ix -= img.width;
        this.imageButton(img, ix, y + 2, { id: `${id}:${name2}`, tip, onClick });
        ix -= 2;
      };
      // food, criminals, wishes: no selection, this town current, the needs page (7)
      const needs = () => { host.select([]); host.currentTown = t.id; this.showPage(7, []); };
      if (t.open.length) icon('WISH', this.str(261), needs);
      if (w.economy.count(t, 12, false) > 0) icon('CRIMINAL', this.str(260), needs);
      if (t.foodPct < 100) icon('NAHRUNG', this.str(t.foodPct < 50 ? 259 : 258), needs);
      if (t.research < 0) {
        // research: select the town's laboratory and open its research page (2)
        const lab = w.entities.find(e => e.kind === 1 && e.town === t.id && e.owner === host.player && (e.oid & 0xffff) === 46 && e.complete);
        icon('FORSCHBUBBLE', this.str(190), () => {
          if (!lab || !w.get(lab.id)) return;
          host.select([lab.id]); this.showPage(2, [lab]);
        });
      }
    }
    const up = ui.get('SIDE_PFEILOBEN'), down = ui.get('SIDE_PFEILUNTEN');
    if (up && this.townScroll > 0) this.imageButton(up, 140, 200, { id: 'towns:up', tip: '', onClick: () => { this.townScroll--; } });
    if (down && this.townScroll + rows < towns.length) this.imageButton(down, 140, 247, { id: 'towns:down', tip: '', onClick: () => { this.townScroll++; } });
  }

  private moneyWorld: World | null = null;
  /** chest: 'rest' (closed) or 'count' (opening / held open); animation start on the wall clock */
  private chestState: 'rest' | 'count' = 'rest';
  private chestStart = -1;
  private counterMoved = false;

  /** 3.6: one counter step per displayed world frame (never per panel repaint) */
  tickMoney(w: World, player: number): void {
    if (this.moneyWorld !== w) { this.moneyWorld = w; this.shownMoney = -1; this.chestState = 'rest'; this.chestStart = -1; this.counterMoved = false; }
    const real = w.economy.players[player]?.money ?? 0;
    const d = real - this.shownMoney, a = Math.abs(d), sg = Math.sign(d);
    if (a >= 10000) this.shownMoney = real - sg * 5000;
    else if (a > 0) this.shownMoney += sg * (a > 5000 ? 1000 : a > 1000 ? 100 : a > 100 ? 50 : a > 50 ? 10 : a > 10 ? 5 : 1);
    if (a > 0) this.counterMoved = true;
    // the chest switches state when the counter starts or stops moving: open once (0 -> last) and
    // hold, close once in reverse (last -> 0); 5 frames per second, wall clock
    const now = performance.now();
    if (this.shownMoney !== real && this.chestState !== 'count') { this.chestState = 'count'; this.chestStart = now; }
    else if (this.shownMoney === real && this.chestState !== 'rest' && this.counterMoved) { this.chestState = 'rest'; this.chestStart = now; }
  }

  /** 3.6: counter text and the money chest */
  private drawMoney(_w: World, _host: HudHost): void {
    const shown = Math.max(0, this.shownMoney);
    const f = this.font('dv10pta'), txt = String(shown);
    f.draw(this.ctx, txt, 119 - f.measure(txt), 280 + (17 - f.height) / 2, '#ffffff');
    const frames = Math.max(1, this.ui!.frameCount('SCHATZKISTE'));
    const k = this.chestStart < 0 ? frames - 1 : Math.min(frames - 1, Math.floor((performance.now() - this.chestStart) / 200));
    this.chestFrame = this.chestStart < 0 ? 0 : this.chestState === 'count' ? k : frames - 1 - k;
    const img = this.ui!.get('SCHATZKISTE', this.chestFrame) ?? this.ui!.get('SCHATZKISTE', 0);
    const at = this.ui!.offset('SCHATZKISTE');
    if (img) this.ctx.drawImage(img, at[0], at[1]);
  }

  /** 3.4 */
  private drawFunctionBar(w: World, host: HudHost): void {
    const ui = this.ui!, sel = host.selection;
    const items: { sprite: string; tip: number; page: number; disabled?: boolean }[] = [];
    const hasTown = w.economy.towns.some(t => t.race === host.player && t.alive);
    if (hasTown) items.push({ sprite: 'GEBAEUDEBAUEN', tip: 1, page: 8 });
    if (!sel.length) {
      items.push({ sprite: 'GEBAEUDEINFO', tip: 41, page: 14 }, { sprite: 'BEWOHNER', tip: 39, page: 6 },
        { sprite: 'STADTSTATISTIK', tip: 10, page: 1 }, { sprite: 'MOTIVATION', tip: 27, page: 7 }, { sprite: 'ROHSTOFFE', tip: 61, page: 5 });
    } else {
      items.push({ sprite: 'INFO', tip: 2, page: 0 });
      const e = sel[0];
      if (sel.length === 1 && e.owner === host.player) {
        const r = w.rules.get(e.oid), type = e.oid & 0xffff, built = e.active;   // side-panel.md 3.4: the "built" test is the active flag
        if (e.kind === 1 && r) {
          items.push({ sprite: 'BEWOHNER', tip: 38, page: 6 });
          if (type === 42) items.push({ sprite: 'DIPLOMATIE', tip: 64, page: 12, disabled: !built });
          else if (type === 46) items.push({ sprite: 'FORSCHUNG', tip: 17, page: 2, disabled: !built }, { sprite: 'HISTORY', tip: 24, page: 3, disabled: !built });
          else if (r.product >= 0) items.push({ sprite: 'PRODUKTION', tip: 58, page: 13, disabled: !built });
          if (r.cls === 5) items.push({ sprite: type === 55 ? 'EINHEITENBAUEN' : 'KAEMPFERBAUEN', tip: 0, page: 4, disabled: !built });
          if (type === 40) items.push({ sprite: 'STADTSTATISTIK', tip: 10, page: 1 }, { sprite: 'MOTIVATION', tip: 27, page: 7 });
          if (r.flags & 1 && !isMarketLike(w, e)) items.push({ sprite: 'ROHSTOFFE', tip: 61, page: 5, disabled: !built });
        }
        // transport ship: passengers page "An Bord" (addon.md 5.6)
        if (e.kind === 0 && isTransport(w, e)) items.push({ sprite: 'BEWOHNER', tip: 329, page: 6 });
        // every trader: merchants and units with flag 0x40 (transport ships)
        if (e.kind === 0 && isTrader(w, e)) items.push({ sprite: 'HANDEL', tip: 50, page: 11 });
      }
      // market and harbour (flag 0x20), own or foreign
      if (sel.length === 1 && isMarketLike(w, e)) {
        const ok = marketPagesAllowed(w, host.player, e);
        items.push({ sprite: 'VERKAUF', tip: 46, page: 9, disabled: !ok }, { sprite: 'EINKAUF', tip: 49, page: 10, disabled: !ok });
      }
    }
    const cur = this.currentPage(sel);
    items.slice(0, 6).forEach((it, i) => {
      const x = 12 + 28 * i;
      this.imageButton(ui.get(it.sprite), x, 300, {
        id: `page:${it.page}:${i}`, tip: this.str(it.tip), disabled: it.disabled, off: false,
        onClick: () => { this.showPage(it.page, sel); },
      });
      if (cur === it.page && !it.disabled) {
        this.ctx.strokeStyle = 'rgba(255,233,160,0.8)'; this.ctx.lineWidth = 1;
        this.ctx.strokeRect(x + 0.5, 300.5, 29, 29);
      }
    });
  }

  /** where an entity's info belongs: used by the overlay for status lines */
  describeTown(id: number): string {
    const t = this.host?.world?.economy.town(id);
    return t ? this.str(142 + t.race * 10 + (t.nameIndex % 10)) : '';
  }
}
