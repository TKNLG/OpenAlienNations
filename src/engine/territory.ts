// Town territory ("town area") and border stones. Spec: docs/game/economy.md 11,
// docs/rendering/territory.md (display).
//
// The territory is per town: the union of round discs around the town hall (from the moment its
// site exists) and the town's completed outposts, kept at half resolution (one owner per 2 x 2
// block of cells). A block belongs to the first territory that claimed it. Every owned block with
// a neighbour block not owned by the same town is a border block and carries one border stone.
//
// Everything here is simulation state (placement tests in the UI and the AI read it): the owner
// map, the records with their ordered circle and border lists and the block counts are part of
// snapshots and of the sync digest. The stone marks (`marks`) are display state derived from the
// border lists in the order they were written (11.6).

/** owner value of a block nobody owns (the original's 0xFF; ours is 16-bit, see 11.1) */
export const NO_OWNER = 0xffff;

export interface TerritoryRecord {
  /** town id (economy town index); the value written into the owner map */
  id: number;
  /** the town's race: stone sprite and minimap tint colour */
  race: number;
  /** contributing discs in the order added: [block x, block y, block radius] */
  circles: [number, number, number][];
  /** border blocks (block index = by * half + bx) in scan order; may hold a block twice (11.4 quirk) */
  border: number[];
  /** blocks owned; the AI reads 4 x count (11.7). Inflated by every removal with the count quirk (11.5) */
  count: number;
  /** "marks shown": set after the first add (11.4) */
  shown: boolean;
}

export interface TerritorySnapshot {
  /** owner map, run-length encoded: [value, run, value, run, ...] */
  owner: number[];
  records: TerritoryRecord[];
  countQuirk: boolean;
}

/** blocks of a disc of block radius r around (0, 0): dx^2 + dy^2 < r^2, rows top to bottom (11.3) */
export function discOffsets(r: number): [number, number][] {
  const out: [number, number][] = [];
  for (let dy = -r; dy < r; dy++) for (let dx = -r; dx < r; dx++) if (dx * dx + dy * dy < r * r) out.push([dx, dy]);
  return out;
}

/** block radius of a building radius R (odb +0xB0): (R - 2) div 2 (11.2) */
export const blockRadius = (R: number): number => Math.max(0, Math.trunc((R - 2) / 2));

/**
 * Does placing this building type need the territory test (forbidden mask flag 0x800,
 * units-and-jobs.md 6.1, economy.md 11.7)? Not the mine (0x67E), the town hall (0x107E) and, in
 * add-on mode, the harbour and the shipyard (0x405E).
 */
export function needsTerritory(type: number, addon: boolean): boolean {
  return type !== 50 && type !== 40 && !(addon && (type === 62 || type === 63));
}

export class Territory {
  /** blocks per side (map size / 2) */
  readonly half: number;
  private readonly hbits: number;
  /** owning town per block, NO_OWNER = none */
  readonly owner: Uint16Array;
  /** stone mark per block: 0 none, 1 + race (the cell flag bits 0x0C of the block's even/even cell, 11.6) */
  readonly marks: Uint8Array;
  /** records in creation order */
  records: TerritoryRecord[] = [];
  private byId = new Map<number, TerritoryRecord>();
  /** fidelity switch (11.5): true = the original's block count, never reset on a clearing recompute */
  countQuirk = true;
  /** bumped on every change (display refresh; not simulation state) */
  version = 0;
  /** order-independent digest of the owner map, kept up to date on every write */
  private ownerSum = 0;
  private discs = new Map<number, [number, number][]>();

  constructor(mapSize: number) {
    this.half = Math.max(1, mapSize >> 1);
    this.hbits = Math.round(Math.log2(this.half));
    this.owner = new Uint16Array(this.half * this.half).fill(NO_OWNER);
    this.marks = new Uint8Array(this.half * this.half);
  }

  // ---------------------------------------------------------------- lookups

  /** block index of a cell (wrapped) */
  blockOf(x: number, y: number): number {
    const m = this.half - 1;
    return (((y >> 1) & m) << this.hbits) | ((x >> 1) & m);
  }

  /** block index of block coordinates (wrapped) */
  block(bx: number, by: number): number {
    const m = this.half - 1;
    return ((by & m) << this.hbits) | (bx & m);
  }

  /** town owning the cell (x, y), -1 = none */
  ownerAt(x: number, y: number): number {
    const o = this.owner[this.blockOf(x, y)];
    return o === NO_OWNER ? -1 : o;
  }

  /** race of the territory the cell lies in, -1 = none */
  raceAt(x: number, y: number): number {
    const o = this.owner[this.blockOf(x, y)];
    return o === NO_OWNER ? -1 : (this.byId.get(o)?.race ?? -1);
  }

  record(town: number): TerritoryRecord | undefined { return this.byId.get(town); }

  /** 4 x the block count: the AI's town area in cells (11.7, with the count quirk of 11.5) */
  area(town: number): number { return 4 * (this.byId.get(town)?.count ?? 0); }

  /**
   * Placement test of buildings with mask flag 0x800 (11.7, `0044e610`): the four corner points
   * (X', Y'), (X' - b', Y'), (X', Y' - a'), (X' - b', Y' - a') in blocks, X' = (X + 1) div 2,
   * Y' = (Y + 1) div 2, a' = (size_y + 2) div 2, b' = (size_x + 2) div 2, all owned by `town`.
   * (X, Y) is the anchor cell (maximum corner of the footprint).
   */
  inTown(town: number, X: number, Y: number, sizeX: number, sizeY: number): boolean {
    const x = (X + 1) >> 1, y = (Y + 1) >> 1;
    const a = (sizeY + 2) >> 1, b = (sizeX + 2) >> 1;
    const o = this.owner;
    return o[this.block(x, y)] === town && o[this.block(x - b, y)] === town &&
      o[this.block(x, y - a)] === town && o[this.block(x - b, y - a)] === town;
  }

  /**
   * Town-hall placement test (flag 0x1000, 11.7, `0044e3b0`): none of the cells (X + 1, Y + 1),
   * (X + 1 - a, Y + 1), (X + 1, Y + 1 - b), (X + 1 - a, Y + 1 - b), a = size_y + 2, b = size_x + 2,
   * lies in any territory. Wrapped (the original reads a wrong block near the map edge).
   */
  outsideAll(X: number, Y: number, sizeX: number, sizeY: number): boolean {
    const a = sizeY + 2, b = sizeX + 2;
    for (const [px, py] of [[X + 1, Y + 1], [X + 1 - a, Y + 1], [X + 1, Y + 1 - b], [X + 1 - a, Y + 1 - b]]) {
      if (this.owner[this.blockOf(px, py)] !== NO_OWNER) return false;
    }
    return true;
  }

  /** no block of the disc a building of radius R at cell (x, y) would add is owned (AI founding, `0045dc10`) */
  discFree(x: number, y: number, R: number): boolean {
    const cx = x >> 1, cy = y >> 1;
    for (const [dx, dy] of this.disc(blockRadius(R))) if (this.owner[this.block(cx + dx, cy + dy)] !== NO_OWNER) return false;
    return true;
  }

  // ---------------------------------------------------------------- messages (11.2, 11.4, 11.5)

  /** "add a circle" (message (0x55,24), handler `004572c0`): town hall site created, outpost completed */
  add(town: number, race: number, x: number, y: number, R: number): void {
    let rec = this.byId.get(town);
    if (!rec) {
      rec = { id: town, race, circles: [], border: [], count: 0, shown: false };
      this.records.push(rec);
      this.byId.set(town, rec);
    }
    rec.race = race;
    const m = this.half - 1;
    rec.circles.push([(x >> 1) & m, (y >> 1) & m, blockRadius(R)]);
    this.recompute(rec, false);
    rec.shown = true;
    this.version++;
  }

  /**
   * "remove a circle" (`0044e830`), sent in phase 2 of the destruction of any building: the
   * town's circle centred on the building's block goes (first match, if any), the town is
   * recomputed with clearing, then every territory in creation order without clearing; a town
   * without circles loses its record. A town without a record: nothing happens (I).
   */
  remove(town: number, x: number, y: number): void {
    const rec = this.byId.get(town);
    if (!rec) return;
    const m = this.half - 1, bx = (x >> 1) & m, by = (y >> 1) & m;
    const k = rec.circles.findIndex(c => c[0] === bx && c[1] === by);
    if (k >= 0) rec.circles.splice(k, 1);
    this.recompute(rec, true);
    for (const r of [...this.records]) this.recompute(r, false);
    if (!rec.circles.length) {
      this.clearMarks(rec);
      rec.border = [];
      this.records.splice(this.records.indexOf(rec), 1);
      this.byId.delete(town);
    }
    this.version++;
  }

  // ---------------------------------------------------------------- recompute (`0044e9a0`)

  private disc(r: number): [number, number][] {
    let d = this.discs.get(r);
    if (!d) { d = discOffsets(r); this.discs.set(r, d); }
    return d;
  }

  private setOwner(i: number, v: number): void {
    const old = this.owner[i];
    if (old === v) return;
    this.ownerSum = (this.ownerSum - cellHash(i, old) + cellHash(i, v)) | 0;
    this.owner[i] = v;
  }

  private clearMarks(rec: TerritoryRecord): void {
    for (const b of rec.border) this.marks[b] = 0;
  }

  private recompute(rec: TerritoryRecord, clear: boolean): void {
    const id = rec.id, own = this.owner, half = this.half, m = half - 1;
    // 1. the record's old stones are removed
    this.clearMarks(rec);
    if (clear) {
      for (let i = 0; i < own.length; i++) if (own[i] === id) this.setOwner(i, NO_OWNER);
      if (!this.countQuirk) rec.count = 0;
    }
    // 2. claim: free blocks of every disc, in circle order
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [cx, cy, r] of rec.circles) {
      for (const [dx, dy] of this.disc(r)) {
        const bx = (cx + dx) & m, by = (cy + dy) & m;
        const i = (by << this.hbits) | bx;
        if (own[i] === NO_OWNER) { this.setOwner(i, id); rec.count++; }
        // 3. bounding box in wrapped block coordinates
        if (bx < x0) x0 = bx; if (bx > x1) x1 = bx;
        if (by < y0) y0 = by; if (by > y1) y1 = by;
      }
    }
    // 4. thinning and border scan over the box grown by one, row by row, in place
    rec.border = [];
    if (x0 <= x1) {
      const at = (bx: number, by: number) => own[((by & m) << this.hbits) | (bx & m)] === id;
      for (let by = y0 - 1; by <= y1 + 1; by++) for (let bx = x0 - 1; bx <= x1 + 1; bx++) {
        const i = ((by & m) << this.hbits) | (bx & m);
        if (own[i] !== id) continue;
        const l = at(bx - 1, by), r = at(bx + 1, by), u = at(bx, by - 1), d = at(bx, by + 1);
        if ((!l && !r) || (!u && !d)) { this.setOwner(i, NO_OWNER); rec.count--; }
        else if (!l || !r || !u || !d) rec.border.push(i);
      }
    }
    // 5. the stones of the new border (11.6): race + 1 in the even/even cell of each border block
    for (const b of rec.border) this.marks[b] = rec.race + 1;
  }

  // ---------------------------------------------------------------- state

  snapshot(): TerritorySnapshot {
    const runs: number[] = [];
    const o = this.owner;
    for (let i = 0; i < o.length;) {
      let j = i + 1;
      while (j < o.length && o[j] === o[i]) j++;
      runs.push(o[i], j - i);
      i = j;
    }
    return { owner: runs, records: this.records.map(copyRecord), countQuirk: this.countQuirk };
  }

  restore(s: TerritorySnapshot): void {
    this.owner.fill(NO_OWNER);
    this.marks.fill(0);
    this.ownerSum = 0;
    let i = 0;
    for (let k = 0; k + 1 < s.owner.length; k += 2) {
      const v = s.owner[k], n = s.owner[k + 1];
      for (let j = 0; j < n && i < this.owner.length; j++, i++) this.setOwner(i, v);
    }
    this.records = s.records.map(copyRecord);
    this.byId = new Map(this.records.map(r => [r.id, r]));
    this.countQuirk = s.countQuirk;
    // the stone marks follow from the border lists, written in creation order
    for (const r of this.records) for (const b of r.border) this.marks[b] = r.race + 1;
    this.version++;
  }

  /** forget everything (a new map; the v5 migration rebuilds from the buildings) */
  reset(): void {
    this.owner.fill(NO_OWNER);
    this.marks.fill(0);
    this.ownerSum = 0;
    this.records = [];
    this.byId.clear();
    this.version++;
  }

  digest(mix: (v: number) => void): void {
    mix(this.records.length); mix(this.countQuirk ? 1 : 0);
    for (const r of this.records) {
      mix(r.id); mix(r.race); mix(r.count); mix(r.circles.length); mix(r.border.length);
      for (const [x, y, rad] of r.circles) { mix(x); mix(y); mix(rad); }
      let b = 0;
      for (const v of r.border) b = (Math.imul(b, 31) + v + 1) | 0;
      mix(b);
    }
    mix(this.ownerSum);
  }
}

/** contribution of one block to the owner digest; 0 for a free block (the empty map sums to 0) */
const cellHash = (i: number, v: number): number => (v === NO_OWNER ? 0 : (Math.imul(i + 1, 0x9e3779b1) ^ Math.imul(v + 7, 0x85ebca6b)) | 0);

const copyRecord = (r: TerritoryRecord): TerritoryRecord => ({
  id: r.id, race: r.race, circles: r.circles.map(c => [c[0], c[1], c[2]] as [number, number, number]),
  border: [...r.border], count: r.count, shown: r.shown,
});
