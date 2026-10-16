// Minimap in the side panel. Spec: docs/ui/side-panel.md 6 (6.1 ground image, 6.2 composition,
// 6.3 viewport marker), docs/game/fog-of-war.md 5.4 (markers, fog) and docs/rendering/territory.md 5
// (town-area tint from the territory's ownership map).
//
// Everything is composed at the original resolution, 152x152 pixels, and then scaled to the
// canvas (nearest neighbour). Orientation as in the original: a minimap column is a map y, a
// row is a map x (the world view turned 45 degrees). The image wraps and is centred on the camera.

import type { Terrain } from '../world/terrain.ts';
import { CLASS_TILESET } from '../world/terrain.ts';
import type { TerrainSet } from '../formats/os.ts';
import type { World } from '../engine/world.ts';
import { Kind, SUB } from '../engine/world.ts';
import { CELL_W } from './camera.ts';
import type { Camera } from './camera.ts';
import type { Vision } from './vision.ts';
import { Slot, cursorCss } from './cursors.ts';

export const MM = 152;
const C = MM / 2;
const RACE_RGB: [number, number, number][] = [[255, 0, 0], [0, 180, 255], [255, 255, 0]];
const TREE: [number, number, number] = [90, 255, 60], STONE: [number, number, number] = [239, 247, 255], FOOD: [number, number, number] = [255, 220, 120];

export interface MinimapHost { layers: boolean[]; }

/** the 152x152 ground image of a terrain (6.1), RGB, row = map x, column = map y */
export function groundImage(t: Terrain, sets: Map<string, TerrainSet>): Uint8Array {
  // 1. tile colour: plain average of the tile's pixels, truncated
  const avg = new Map<string, Int32Array>();
  for (const name of new Set(CLASS_TILESET)) {
    const set = sets.get(name);
    if (!set) continue;
    const a = new Int32Array(set.tiles.length * 3);
    set.tiles.forEach((tile, k) => {
      let r = 0, g = 0, b = 0;
      for (let i = 0; i < tile.rgba.length; i += 4) { r += tile.rgba[i]; g += tile.rgba[i + 1]; b += tile.rgba[i + 2]; }
      const n = tile.rgba.length / 4;
      a[k * 3] = Math.floor(r / n); a[k * 3 + 1] = Math.floor(g / n); a[k * 3 + 2] = Math.floor(b / n);
    });
    avg.set(name, a);
  }
  const n = t.size, mask = n - 1, bits = t.sizeBits;
  const cellRgb = new Int32Array(n * n * 3);
  for (let i = 0; i < n * n; i++) {
    const a = avg.get(CLASS_TILESET[t.cls[i]]);
    const k = a ? Math.min(t.tile[i], a.length / 3 - 1) * 3 : -1;
    for (let c = 0; c < 3; c++) cellRgb[i * 3 + c] = k >= 0 ? a![k + c] : 0;
  }
  const at = (x: number, y: number) => ((y & mask) << bits) | (x & mask);
  // 2. block average and slope shade
  const step = Math.floor(n / MM), cnt = (step + 1) * (step + 1);
  const shaded = new Int32Array(MM * MM * 3);
  for (let row = 0; row < MM; row++) for (let col = 0; col < MM; col++) {
    const x0 = Math.floor(n * row / MM), y0 = Math.floor(n * col / MM);
    let r = 0, g = 0, b = 0;
    for (let dy = 0; dy <= step; dy++) for (let dx = 0; dx <= step; dx++) {
      const i = at(x0 + dx, y0 + dy) * 3;
      r += cellRgb[i]; g += cellRgb[i + 1]; b += cellRgb[i + 2];
    }
    let s = 192 + 8 * (t.height[at(x0, y0)] - t.height[at(x0 + 1, y0 - 1)]);
    s = s < 128 ? 128 : s > 239 ? 239 : s;
    const o = (row * MM + col) * 3;
    shaded[o] = Math.floor(Math.floor(r / cnt) * s / 255);
    shaded[o + 1] = Math.floor(Math.floor(g / cnt) * s / 255);
    shaded[o + 2] = Math.floor(Math.floor(b / cnt) * s / 255);
  }
  // 3. 1-2-1 blur, wrapping; 4. 16-bit display format (5-6-5: low bits dropped)
  const out = new Uint8Array(MM * MM * 3);
  const W = [1, 2, 1];
  for (let row = 0; row < MM; row++) for (let col = 0; col < MM; col++) {
    let r = 0, g = 0, b = 0;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const w = W[dr + 1] * W[dc + 1];
      const o = ((((row + dr + MM) % MM) * MM) + ((col + dc + MM) % MM)) * 3;
      r += shaded[o] * w; g += shaded[o + 1] * w; b += shaded[o + 2] * w;
    }
    const o = (row * MM + col) * 3;
    out[o] = (r >> 4) & 0xf8; out[o + 1] = (g >> 4) & 0xfc; out[o + 2] = (b >> 4) & 0xf8;
  }
  return out;
}

/** half-diagonal of the viewport diamond (6.3) */
export function markerRadius(viewW: number, cellW: number, mapSize: number): number {
  const a = Math.trunc(cellW * 100 / 64), t = Math.trunc(a * 0.45254834);
  const nCells = t > 0 ? Math.trunc(viewW * 1.41421356 / t) : 0;
  return 2 + Math.trunc(Math.trunc(nCells * MM / mapSize) / 2);
}

export class Minimap {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private img = document.createElement('canvas');
  private data: ImageData;
  private ground: Uint8Array | null = null;
  private marks = new Uint8Array(MM * MM);   // object marker per pixel, 0 = none (fog-of-war.md 1.4 codes)
  private markRgb = new Uint8Array(MM * MM * 3);
  private tint = new Uint8Array(MM * MM);    // 1 + race in a town area, 0 outside
  private areaKey: unknown = null;
  private areaVersion = -1;
  private size = 0;
  private terrain: Terrain | null = null;
  private cam: Camera | null = null;
  host: MinimapHost | null = null;
  onJump: (x: number, y: number) => void = () => {};
  onMove: (x: number, y: number) => void = () => {};

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.img.width = this.img.height = MM;
    this.data = this.img.getContext('2d')!.createImageData(MM, MM);
    let press: { x: number; y: number; t: number; camX: number; camY: number; drag: boolean } | null = null;
    // minimap pixels per css pixel
    const unit = () => { const r = canvas.getBoundingClientRect(); return MM / Math.max(1, r.width); };
    const cellAt = (e: PointerEvent): [number, number] => {
      const r = canvas.getBoundingClientRect(), k = MM / r.width, n = this.size;
      const ox = Math.floor((e.clientX - r.left) * k) - C, oy = Math.floor((e.clientY - r.top) * k) - C;
      const [px, py] = this.centrePixel();
      // the horizontal offset moves along y, the vertical one along x (6.2)
      const p = (v: number) => ((Math.trunc((v * n + C) / MM) % n) + n) % n;
      return [p(px + oy), p(py + ox)];
    };
    // cursor (docs/ui/cursors.md 5.2): crosshair while hovering, open palm while drag-scrolling,
    // the panel's arrow outside; an inactive minimap (no map yet) leaves it alone
    const cursor = (slot: Slot) => { const c = cursorCss(slot); if (canvas.style.cursor !== c) canvas.style.cursor = c; };
    canvas.style.cursor = cursorCss(Slot.Cross);
    canvas.addEventListener('pointerenter', () => { if (this.size) cursor(Slot.Cross); });
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    canvas.addEventListener('pointerdown', e => {
      if (!this.size || !this.cam) return;
      if (e.button === 2) {
        if (press?.drag) { this.cam.x = press.camX; this.cam.y = press.camY; press = null; cursor(Slot.Cross); return; }
        const [x, y] = cellAt(e);
        this.onMove(x, y);
        return;
      }
      if (e.button !== 0) return;
      canvas.setPointerCapture(e.pointerId);
      press = { x: e.clientX, y: e.clientY, t: performance.now(), camX: this.cam.x, camY: this.cam.y, drag: false };
      const p = press;
      // held 500 ms without moving: the grab-scroll starts too (side-panel.md 6), palm cursor
      setTimeout(() => { if (press === p && !p.drag) { p.drag = true; cursor(Slot.Palm); } }, 500);
    });
    canvas.addEventListener('pointermove', e => {
      if (!press || !this.cam) return;
      const dx = e.clientX - press.x, dy = e.clientY - press.y;
      if (!press.drag && (Math.hypot(dx, dy) > 3 || performance.now() - press.t > 500)) { press.drag = true; cursor(Slot.Palm); }
      if (press.drag) {
        const f = unit() * this.size / MM;
        this.cam.x = wrap(press.camX - dy * f, this.size);
        this.cam.y = wrap(press.camY - dx * f, this.size);
      }
    });
    canvas.addEventListener('pointerup', e => {
      if (!press) return;
      const wasDrag = press.drag;
      press = null;
      cursor(Slot.Cross);
      if (!wasDrag && e.button === 0) { const [x, y] = cellAt(e); this.onJump(x, y); }
    });
  }

  /** new map (or a loaded game): build the ground image once (6.1) */
  setTerrain(t: Terrain, sets: Map<string, TerrainSet>): void {
    this.terrain = t;
    this.size = t.size;
    this.ground = groundImage(t, sets);
    this.areaKey = null;
  }

  /** ground edits during play: the original never updates the minimap ground (6.1) */
  refresh(_x0: number, _y0: number, _x1: number, _y1: number): void {}

  /** image pixel (row = x, column = y) shown at the minimap centre (6, centring rule) */
  private centrePixel(): [number, number] {
    const cam = this.cam!, t = this.terrain!, n = this.size;
    const cx = Math.floor(cam.x), cy = Math.floor(cam.y);
    const k = Math.trunc((t.height[((cy & (n - 1)) << t.sizeBits) | (cx & (n - 1))] - 128) / 44);
    const px = (v: number) => (((Math.trunc(MM * (v + k) / n)) % MM) + MM) % MM;
    return [px(cx), px(cy)];
  }

  /**
   * Town areas (territory.md 5): pixel -> 1 + race of the territory its cell lies in, looked up in
   * the engine's ownership map (outposts included, first-come shapes); rebuilt when it changes.
   */
  private townAreas(w: World): void {
    const ter = w.territory;
    if (ter === this.areaKey && ter.version === this.areaVersion) return;
    this.areaKey = ter; this.areaVersion = ter.version;
    const n = this.size;
    for (let row = 0; row < MM; row++) {
      const x = Math.trunc(n * row / MM);
      for (let col = 0; col < MM; col++) this.tint[row * MM + col] = 1 + ter.raceAt(x, Math.trunc(n * col / MM));
    }
  }

  draw(world: World, cam: Camera, vision?: Vision | null): void {
    this.cam = cam;
    const g = this.ground, t = this.terrain, n = this.size;
    if (!g || !t || !n) return;
    const layers = this.host?.layers ?? [true, true, false, false];
    const fog = vision && !vision.off ? vision : null;
    const mask = n - 1;

    // object markers: radius-1 plus shapes (fog-of-war.md 5.4)
    const marks = this.marks, mrgb = this.markRgb;
    marks.fill(0);
    for (const e of world.entities) {
      const cx = Math.floor(e.x / SUB) & mask, cy = Math.floor(e.y / SUB) & mask;
      let code = 0, rgb: [number, number, number] | null = null;
      const rule = world.rules.get(e.oid);
      const mobile = fog ? !fog.isStatic(e, rule) : e.kind !== Kind.Building && e.kind !== Kind.Nature;
      if (fog && (mobile ? !fog.cellVisible(cx, cy) : !fog.seen.has(e.id) && !fog.cellVisible(cx, cy))) continue;
      const row = Math.trunc(cx * MM / n), col = Math.trunc(cy * MM / n);
      if (e.kind === Kind.Nature) {
        if (!layers[2]) continue;
        const cls = rule?.cls ?? -1;
        const base = cls === 8 ? TREE : cls === 13 || (e.oid & 0xffff) === 38 ? STONE : cls === 9 || cls === 7 ? FOOD : null;
        if (!base) continue;
        const o = (row * MM + col) * 3;
        rgb = [(g[o] + base[0]) >> 1, (g[o + 1] + base[1]) >> 1, (g[o + 2] + base[2]) >> 1];
        code = base === TREE ? 0x20 : base === STONE ? 0x40 : 0x60;
      } else {
        if (e.kind === Kind.Building ? !layers[0] : (!layers[1] || e.inside >= 0)) continue;
        rgb = RACE_RGB[e.owner] ?? [255, 255, 255];
        code = 0x04 << Math.max(0, Math.min(2, e.owner));
      }
      if (mobile) code |= 0x80;
      for (const [dr, dc] of PLUS) {
        const p = (((row + dr) % MM + MM) % MM) * MM + (((col + dc) % MM + MM) % MM);
        marks[p] = code;
        mrgb[p * 3] = rgb[0]; mrgb[p * 3 + 1] = rgb[1]; mrgb[p * 3 + 2] = rgb[2];
      }
    }
    if (layers[3]) this.townAreas(world);

    // compose (6.2): image pixel (row, col) -> screen (C + col - pcol, C + row - prow), wrapped
    const [prow, pcol] = this.centrePixel();
    const d = this.data.data;
    for (let sy = 0; sy < MM; sy++) {
      const row = (prow + sy - C + MM) % MM;
      const cellX = Math.trunc(n * row / MM);
      for (let sx = 0; sx < MM; sx++) {
        const col = (pcol + sx - C + MM) % MM;
        const p = row * MM + col;
        let state = 2;   // 2 in sight, 1 explored, 0 never seen
        if (fog) {
          const sh = fog.shade[(Math.trunc(n * col / MM) << t.sizeBits) | cellX];
          state = sh === 255 ? 2 : sh === 0 ? 0 : 1;
        }
        const o = (sy * MM + sx) * 4;
        d[o + 3] = 255;
        if (state === 0) { d[o] = d[o + 1] = d[o + 2] = 0; continue; }
        let r = g[p * 3], gg = g[p * 3 + 1], b = g[p * 3 + 2];
        const m = marks[p];
        const shown = m && (state === 2 || !(m & 0x80));
        if (shown) { r = mrgb[p * 3]; gg = mrgb[p * 3 + 1]; b = mrgb[p * 3 + 2]; }
        // town-area tint (territory.md 5): in sight, not on a race marker; a nature marker's blend
        // gets the tint on top
        const tr = state === 2 && layers[3] && !(shown && (m & 0x1c)) ? this.tint[p] : 0;
        if (tr) { const c = RACE_RGB[tr - 1]; r = (r + c[0]) >> 1; gg = (gg + c[1]) >> 1; b = (b + c[2]) >> 1; }
        if (state === 1) { r >>= 1; gg >>= 1; b >>= 1; }
        d[o] = r; d[o + 1] = gg; d[o + 2] = b;
      }
    }
    // viewport marker (6.3), from the real view width and cell width on screen
    const rad = Math.min(C - 1, markerRadius(cam.viewW, CELL_W * cam.zoom, n));
    const put = (x: number, y: number) => { if (x < 0 || y < 0 || x >= MM || y >= MM) return; const o = (y * MM + x) * 4; d[o] = d[o + 1] = d[o + 2] = 255; };
    for (let i = 0; i < rad; i++) {
      put(C - rad + i, C - i); put(C + rad - i, C + i);
      put(C + rad - 1 - i, C - 1 - i); put(C - rad + 1 + i, C + 1 + i);
    }
    this.img.getContext('2d')!.putImageData(this.data, 0, 0);
    const ctx = this.ctx;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.img, 0, 0, this.canvas.width, this.canvas.height);
  }
}

const PLUS: [number, number][] = [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]];
const wrap = (v: number, n: number) => ((v % n) + n) % n;
