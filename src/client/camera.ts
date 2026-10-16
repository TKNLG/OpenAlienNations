// Isometric world <-> screen mapping. Spec: docs/rendering/world-projection.md

export const CELL_W = 64;   // screen px per cell (diamond width) at zoom 1
export const CELL_H = 44;   // diamond height
export const BASE_HEIGHT = 128;

export class Camera {
  /** world position (cell units, fractional) at the centre of the screen */
  x = 0;
  y = 0;
  zoom = 1;
  viewW = 800;
  viewH = 600;

  readonly mapSize: number;

  constructor(mapSize: number) { this.mapSize = mapSize; }

  /** screen-space offset of a world point at height h, relative to the camera, in zoom-1 px */
  static project(x: number, y: number, h: number): [number, number] {
    return [(y - x) * (CELL_W / 2), (x + y) * (CELL_H / 2) - (h - BASE_HEIGHT)];
  }

  /** world point under a screen pixel, ignoring height */
  unproject(sx: number, sy: number): [number, number] {
    const [cx, cy] = Camera.project(this.x, this.y, BASE_HEIGHT);
    const px = (sx - this.viewW / 2) / this.zoom + cx;
    const py = (sy - this.viewH / 2) / this.zoom + cy;
    const a = px / (CELL_W / 2), b = py / (CELL_H / 2); // a = y - x, b = x + y
    return [(b - a) / 2, (a + b) / 2];
  }

  /** move by a screen-space delta in pixels */
  pan(dxPx: number, dyPx: number): void {
    const a = dxPx / this.zoom / (CELL_W / 2), b = dyPx / this.zoom / (CELL_H / 2);
    this.x = wrap(this.x + (b - a) / 2, this.mapSize);
    this.y = wrap(this.y + (a + b) / 2, this.mapSize);
  }

  /** the copy of a world coordinate (the map wraps) closest to the camera */
  nearest(v: number, cam: number): number {
    const n = this.mapSize;
    return v - Math.round((v - cam) / n) * n;
  }
}

export const wrap = (v: number, n: number) => ((v % n) + n) % n;
