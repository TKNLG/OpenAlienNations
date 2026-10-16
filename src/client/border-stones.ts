// Border stones of the town territories in the world view. Spec: docs/rendering/territory.md
// (1 sprites, 2 positions, 3 drawing), docs/game/economy.md 11.6 (which blocks carry a stone).
//
// One stone per border block of every territory, on the block's even/even cell, in the race
// colour of the owning town (GRENZEAZ / GRENZEPI / GRENZESA MS0, dv.OD group 7 types 14..16).
// Stones are ground decals: drawn after the terrain and before every object, not depth-sorted,
// in grid scan order; only on cells currently in sight when fog is on; scaled with the zoom like
// every sprite. The picture's top-left corner sits on the cell's top vertex (with its height).
//
// The engine keeps the stone marks per block (territory.ts `marks`); this module turns them into
// per-chunk lists whenever the territory changes and draws the chunks around the camera.

import type { Territory } from '../engine/territory.ts';
import type { ObjectDesc } from '../formats/od.ts';
import type { AtlasRect, SpriteDraw } from './sprites.ts';
import { Camera } from './camera.ts';
import type { World } from '../engine/world.ts';

/** cells per chunk side */
export const CHUNK = 16;
const GROUP7 = 7 << 16;
/** stone sprites: group 7, type 14 + race (territory.md 1) */
export const STONE_TYPE = 14;

export interface Stone { x: number; y: number; race: number; }

/**
 * Stones per chunk (key = chunk y * chunks per row + chunk x), each list in grid scan order
 * (rows of cells, then columns), from the engine's per-block marks.
 */
export function stoneChunks(t: Territory): Map<number, Stone[]> {
  const out = new Map<number, Stone[]>();
  const half = t.half, size = half * 2, per = Math.max(1, Math.floor(size / CHUNK));
  for (let by = 0; by < half; by++) for (let bx = 0; bx < half; bx++) {
    const m = t.marks[by * half + bx];
    if (!m) continue;
    const x = bx * 2, y = by * 2;
    const key = Math.floor(y / CHUNK) * per + Math.floor(x / CHUNK);
    let l = out.get(key);
    if (!l) { l = []; out.set(key, l); }
    l.push({ x, y, race: m - 1 });
  }
  return out;
}

/** what the stone pass needs from the client */
export interface StoneHost {
  /** terrain height of a cell (wrapped) */
  height(x: number, y: number): number;
  /** the cell is in sight (true when fog is off) */
  visible(x: number, y: number): boolean;
}

export class BorderStones {
  private chunks = new Map<number, Stone[]>();
  private source: Territory | null = null;
  private version = -1;
  private rects: ({ page: number; r: AtlasRect } | null)[] = [null, null, null];

  /** object ids whose sprites the stones need (loaded with the other group-7 pictures) */
  static oids(): number[] { return [0, 1, 2].map(r => (GROUP7 | (STONE_TYPE + r)) >>> 0); }

  /** forget the lists (new map, new world) */
  clear(): void { this.chunks.clear(); this.source = null; this.version = -1; }

  /** rebuild the chunk lists when the territory changed (or is a different world's); true if rebuilt */
  refresh(t: Territory): boolean {
    if (t === this.source && t.version === this.version) return false;
    this.source = t;
    this.version = t.version;
    this.chunks = stoneChunks(t);
    return true;
  }

  /** atlas rectangle of a race's stone picture, once its sprite is loaded */
  private rect(race: number, objects: Map<number, ObjectDesc>, rects: Map<string, { page: number; r: AtlasRect }>): { page: number; r: AtlasRect } | null {
    let a = this.rects[race];
    if (a) return a;
    const name = objects.get((GROUP7 | (STONE_TYPE + race)) >>> 0)?.slots[0];
    a = (name && rects.get(`${name}#0`)) || null;
    this.rects[race] = a;
    return a;
  }

  /**
   * The stone decals of the chunks around the camera, in zoom-1 screen coordinates relative to
   * the view centre (SpriteBatch). Depths run below every object so the batch keeps them first
   * and in collection order.
   */
  sprites(cam: Camera, host: StoneHost, objects: Map<number, ObjectDesc>, rects: Map<string, { page: number; r: AtlasRect }>): SpriteDraw[] {
    const out: SpriteDraw[] = [];
    if (!this.source || !this.chunks.size) return out;
    if (this.rects.some(r => !r)) this.rects = this.rects.map(() => null);   // retry lookups until loaded
    const n = cam.mapSize, per = Math.max(1, Math.floor(n / CHUNK));
    // the view in cells: |dx|, |dy| <= (halfW / 32 + halfH / 22) / 2, plus room for heights
    const halfW = cam.viewW / 2 / cam.zoom + 32, halfH = cam.viewH / 2 / cam.zoom + 64;
    const reach = Math.ceil((halfW / 32 + (halfH + 400) / 22) / 2) + 2;
    const c0x = Math.floor((cam.x - reach) / CHUNK), c1x = Math.floor((cam.x + reach) / CHUNK);
    const c0y = Math.floor((cam.y - reach) / CHUNK), c1y = Math.floor((cam.y + reach) / CHUNK);
    const spanX = Math.min(per, c1x - c0x + 1), spanY = Math.min(per, c1y - c0y + 1);
    let k = 0;
    // chunk rows first, so stones come in grid scan order within the view
    for (let j = 0; j < spanY; j++) for (let i = 0; i < spanX; i++) {
      const cx = (((c0x + i) % per) + per) % per, cy = (((c0y + j) % per) + per) % per;
      const list = this.chunks.get(cy * per + cx);
      if (!list) continue;
      for (const s of list) {
        if (!host.visible(s.x, s.y)) continue;
        const a = this.rect(s.race, objects, rects);
        if (!a) continue;
        const [px, py] = Camera.project(cam.nearest(s.x, cam.x) - cam.x, cam.nearest(s.y, cam.y) - cam.y, host.height(s.x, s.y));
        if (px < -halfW - 32 || px > halfW || py < -halfH - 32 || py > halfH) continue;
        out.push({ page: a.page, r: a.r, x: px, y: py, depth: -1e9 + k++ });
      }
    }
    return out;
  }
}

/**
 * Current-town switch in placement mode (economy.md 11.7, `00441e80`): while a building or a
 * town hall is being placed and the cursor cell lies in the territory of another living town of
 * the local player's race, that town becomes the current town. Returns the town to use.
 */
export function hoverTown(w: World, x: number, y: number, player: number, current: number): number {
  const id = w.territory.ownerAt(x, y);
  if (id < 0 || id === current) return current;
  const t = w.economy.town(id);
  return t && t.alive && t.race === player ? id : current;
}
