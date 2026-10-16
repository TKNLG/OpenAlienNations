// Fog of war for the local player. Spec: docs/game/fog-of-war.md.
//
// Fog is display-only (section 9): nothing in the simulation reads it, so it lives in the client
// and stays out of the lockstep state and the hash. Instead of the original's event-driven
// reference counts we rebuild the "visible" layer from the world after every simulation tick
// (same discs, same sources, same result); "explored" and the per-object "seen" flags accumulate.

import type { World, Entity } from '../engine/world.ts';
import type { ObjectRule } from '../formats/odb.ts';

const SUB = 256;
const KIND_UNIT = 0, KIND_BUILDING = 1, KIND_NATURE = 2;
const EMBASSY = 42, MARKET = 48;
/** record flag 0x20: market-like (market, harbour) */
const FLAG_MARKET_LIKE = 0x20;
/** nature behaviour class 7 = animals (mobile, never "seen") */
const CLS_ANIMAL = 7;

export class Vision {
  readonly size: number;
  private readonly bits: number;
  /** cells currently in sight (1) */
  readonly visible: Uint8Array;
  /** cells ever seen (1), never cleared */
  readonly explored: Uint8Array;
  /** per map vertex: 0 unexplored, 128 explored, 255 visible (terrain texture) */
  readonly shade: Uint8Array;
  /** static objects (buildings, trees, stones, ...) covered by a vision disc at least once */
  readonly seen = new Set<number>();
  /** completed buildings whose radius was explored once (5.2 / 3: completion explores) */
  private completedExplored = new Set<number>();
  private discs = new Map<number, Int32Array>();
  private lastTick = -1;
  /** MAGICEYE cheat: fog switched off for this display (8) */
  off = false;
  /** bumps whenever `shade` changed (renderers re-upload) */
  version = 0;

  constructor(size: number, bits: number) {
    this.size = size; this.bits = bits;
    this.visible = new Uint8Array(size * size);
    this.explored = new Uint8Array(size * size);
    this.shade = new Uint8Array(size * size);
  }

  /** offsets (dx, dy) with dx^2 + dy^2 < r^2, packed as pairs (2) */
  private disc(r: number): Int32Array {
    let d = this.discs.get(r);
    if (!d) {
      const list: number[] = [];
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy < r * r) list.push(dx, dy);
      d = Int32Array.from(list);
      this.discs.set(r, d);
    }
    return d;
  }

  private stamp(cx: number, cy: number, r: number, see: boolean): void {
    if (r <= 0) return;
    const d = this.disc(r), mask = this.size - 1, bits = this.bits;
    for (let k = 0; k < d.length; k += 2) {
      const i = (((cy + d[k + 1]) & mask) << bits) | ((cx + d[k]) & mask);
      if (see) this.visible[i] = 1;
      this.explored[i] = 1;
    }
  }

  /** rebuild after the world advanced; cheap enough to run once per simulation tick */
  update(w: World, player: number, force = false): void {
    if (!force && w.tick === this.lastTick) return;
    this.lastTick = w.tick;
    this.visible.fill(0);
    const rel = (o: number) => w.diplomacy.relation(player, o);
    for (const e of w.entities) {
      if (!e.alive && e.kind === KIND_UNIT) continue;
      const race = e.oid >>> 16;
      const r = w.rules.get(e.oid);
      if (!r || r.radius <= 0) continue;
      const cx = Math.floor(e.x / SUB), cy = Math.floor(e.y / SUB);
      if (e.kind === KIND_UNIT) {
        // units inside a building or a ship (passengers, addon.md 5.1) see nothing; ships see their record radius
        if (race === player && e.inside < 0) this.stamp(cx, cy, r.radius, true);
      } else if (e.kind === KIND_BUILDING) {
        if (race === player) {
          if (e.complete && !this.completedExplored.has(e.id)) { this.completedExplored.add(e.id); this.stamp(cx, cy, r.radius, false); }
          if (e.active) this.stamp(cx, cy, r.radius, true);
        } else if (e.active && race <= 2) {
          // a foreign market-like building (market, add-on harbour: flag 0x20, addon.md 3.3) at peace
          const type = e.oid & 0xffff, s = rel(race);
          const marketLike = type === MARKET || (r.flags & FLAG_MARKET_LIKE) !== 0;
          if ((type === EMBASSY && s !== 0) || (marketLike && s === 3)) this.stamp(cx, cy, r.radius, true);
        }
      }
    }
    // static objects under a vision disc become "seen" (they stay drawn, dimmed, in explored fog)
    const mask = this.size - 1;
    for (const e of w.entities) {
      if (!this.isStatic(e, w.rules.get(e.oid))) continue;
      const i = ((Math.floor(e.y / SUB) & mask) << this.bits) | (Math.floor(e.x / SUB) & mask);
      if (this.visible[i]) this.seen.add(e.id);
    }
    const sh = this.shade, vis = this.visible, ex = this.explored;
    for (let i = 0; i < sh.length; i++) sh[i] = vis[i] ? 255 : ex[i] ? 128 : 0;
    this.version++;
  }

  isStatic(e: Entity, r: ObjectRule | undefined): boolean {
    return e.kind === KIND_BUILDING || (e.kind === KIND_NATURE && r?.cls !== CLS_ANIMAL);
  }

  cellVisible(x: number, y: number): boolean {
    if (this.off) return true;
    const mask = this.size - 1;
    return this.visible[((y & mask) << this.bits) | (x & mask)] === 1;
  }

  /**
   * how to draw an object (5.2, 5.3): 0 hidden, 1 dimmed (explored but not in sight), 2 normal.
   * Units and animals only in sight; static objects also in explored fog once seen.
   */
  drawState(e: Entity, r: ObjectRule | undefined): 0 | 1 | 2 {
    if (this.off) return 2;
    const mask = this.size - 1;
    const i = ((Math.floor(e.y / SUB) & mask) << this.bits) | (Math.floor(e.x / SUB) & mask);
    if (this.visible[i]) return 2;
    if (this.isStatic(e, r) && this.seen.has(e.id) && this.explored[i]) return 1;
    return 0;
  }

  /** explored layer for save games: run-length encoded as text */
  saveExplored(): string {
    const out: number[] = [];
    let cur = 0, run = 0;
    for (const v of this.explored) {
      if (v === cur) { run++; continue; }
      out.push(run); cur = v; run = 1;
    }
    out.push(run);
    return out.join(',');
  }

  loadExplored(s: string | undefined, seen?: number[]): void {
    if (!s) return;
    let i = 0, cur = 0;
    for (const part of s.split(',')) {
      const n = Number(part) || 0;
      this.explored.fill(cur, i, Math.min(this.explored.length, i + n));
      i += n; cur ^= 1;
    }
    if (seen) for (const id of seen) this.seen.add(id);
    this.lastTick = -1;
  }
}
