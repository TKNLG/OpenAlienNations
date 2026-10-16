// Display of combat events: projectiles in flight, impact explosions and death animations.
// The simulation only reports them (World.effects); nothing here affects the game state.
// Projectiles and effects are group-7 objects (odb.md A.5): projectiles have one sprite per
// direction (slots 0..7) or a single slot, the "Die" animations (11 + race) and explosions
// (17..19) one slot. Spec: docs/rendering/projectiles.md, docs/game/combat.md 6.
//
// A projectile is released when the shooter's strike animation reaches its release frame (the
// shot event's `wait`), only if its aim cell is on screen, and flies in a straight line from the
// launch point of the shooter's sprite (odb points per direction) to the aim cell's ground point,
// with the height interpolated linearly, for f ms of wall-clock time (f = the shot's flight in
// 1/100 ticks). Its ground offset runs down like a walking unit's (StepDisplay: 1/64 cell, 10 ms
// gate, one frame per jump of more than 3/64 cell). At arrival the projectile record's sound (the
// hit sound) plays and its impact effect starts. Effects play their slot once at the layer speed
// (game time) and vanish when the last frame is reached. A death effect's record sound plays
// when it is created (combat.md 6); no effect sounds at its end.

import type { World, Entity } from '../engine/world.ts';
import { SUB, TICK_MS, Kind } from '../engine/world.ts';
import { dirToward } from '../engine/path.ts';
import type { CombatEffect } from '../engine/combat.ts';
import type { GameData } from './data.ts';
import type { GdEntry } from '../formats/gd.ts';
import { StepDisplay, actionFrame, layerFps, quantClock, OFFSET_UNITS } from './display.ts';
import { garrisonSlot, garrisonLaunch } from './garrison.ts';

const GROUP7 = 7 << 16;
const EXPLOSION_BOMB = 19;
/** launch lift when the shooter is unknown (no shooter in the event, or it is gone) */
const DEFAULT_LIFT = 40;

interface Shot {
  /** release time in simulation ticks (the shooter's display reaches its release frame), flight duration f ms (wall clock) */
  release: number; f: number;
  /** start and aim cells (cell units) */
  sx: number; sy: number; ax: number; ay: number;
  type: number;
  /** launch pixel offset L (zoom-1 px, subtracted from the drawn point), set at release */
  lx: number; ly: number;
  dir: number;
  step: StepDisplay | null;
}

interface Anim { start: number; type: number; x: number; y: number; }

export interface FxDraw {
  entry: GdEntry; frame: number; anchorX: number; anchorY: number;
  /** ground point in cells; h = terrain height to draw at (undefined: the height of the cell) */
  x: number; y: number; h?: number;
  /** extra screen offset in zoom-1 px (launch point) */
  ox: number; oy: number;
}

export class Effects {
  private shots: Shot[] = [];
  private anims: Anim[] = [];
  private data: GameData;
  onSound: (sound: number, x: number, y: number) => void = () => {};
  /** terrain height of a cell, any integer coordinates (wrapped by the client) */
  height: (x: number, y: number) => number = () => 128;
  /** the cell point is on screen and visible under fog (set by the client) */
  visible: (x: number, y: number) => boolean = () => true;
  constructor(data: GameData) { this.data = data; }

  /** object ids whose sprites effects need */
  static oids(): number[] { return Array.from({ length: 20 }, (_, i) => (GROUP7 | i) >>> 0); }

  private rule(type: number) { return this.data.rules.get((GROUP7 | type) >>> 0); }
  private desc(type: number) { return this.data.objects.get((GROUP7 | type) >>> 0); }
  private entry(name: string | null | undefined) { return name ? this.data.sprites.entry(name) : undefined; }

  /**
   * take the world's new events; t = simulation time in ticks (tick + phase), wall = clock in ms.
   * Shots get their launch offset now, while the shooter still exists.
   */
  drain(w: World, t: number, wall: number): void {
    for (const e of w.effects.splice(0)) this.add(w, e, t, wall);
  }

  private add(w: World, e: CombatEffect, t: number, wall: number): void {
    if (e.kind === 'shot' && e.type !== undefined && e.type >= 0) {
      const tx = e.tx ?? e.x, ty = e.ty ?? e.y;
      const size = w.terrain.size;
      const wrap = (d: number) => (d > size / 2 ? d - size : d < -size / 2 ? d + size : d);
      // direction d of the sprite: target minus shooter (projectiles.md 2.3); a garrison shooter's
      // own (stored) position, its outpost's cell (the shot's start) when that delta is zero; zero -> 0
      const sh = e.garrison !== undefined && e.garrison >= 0 && e.shooter !== undefined ? w.get(e.shooter) : undefined;
      const [ox, oy] = sh ? [Math.floor(sh.x / SUB), Math.floor(sh.y / SUB)] : [e.x, e.y];
      let dir = dirToward(wrap(tx - ox), wrap(ty - oy));
      if (dir < 0) dir = dirToward(wrap(tx - e.x), wrap(ty - e.y));
      dir = Math.max(0, dir);
      const [lx, ly] = this.launchOffset(w, e, dir);
      // released when the shooter's strike row shows its release frame (2), the flight lasts f ms of wall clock
      const release = e.tick + this.releaseTicks(w, e);
      this.shots.push({ release, f: Math.max(0, Math.round((e.flight ?? 0) * 100)), sx: e.x, sy: e.y, ax: tx, ay: ty, type: e.type, lx, ly, dir, step: null });
    } else if (e.kind === 'sound') {
      if (e.type !== undefined && e.type > 0) this.onSound(e.type, e.x, e.y);
    } else if (e.kind === 'collapse') {
      // a collapse starts (message 0x49): Sfx_053 once, only if the building is drawn now
      // (combat.md 10.3.1); x, y = the building's anchor cell (front corner)
      if (this.visible(e.x + 0.5, e.y + 0.5)) this.onSound(e.type ?? 53, e.x, e.y);
    } else if (e.kind === 'die') {
      const type = e.type === 4 || e.type === 16 ? EXPLOSION_BOMB : 11 + (e.race ?? 0);
      if (!this.visible(e.x + 0.5, e.y + 0.5)) return;
      this.anims.push({ start: e.tick, type, x: e.x, y: e.y });
      // the death sound plays as the effect is created, with its frame 0 (combat.md 6
      // "When the death sound plays"; projectiles.md 5)
      const s = this.rule(type)?.sound ?? 0;
      if (s > 0) this.onSound(s, e.x, e.y);
    }
  }

  /**
   * ticks from the strike to the frame where the shooter's display releases the projectile:
   * frame rel = record sound frame (-1 = last) of the strike row (ST, else WO) in the shooter's
   * facing, shown at rel x T / (frames - 1) with T = frames x 10 / speed (unit-motion.md 3).
   * Falls back to the simulation's release time (`wait`).
   */
  private releaseTicks(w: World, e: CombatEffect): number {
    const u = e.shooter !== undefined ? w.get(e.shooter) : undefined;
    const r = u ? this.data.rules.get(u.oid) : undefined, d = u ? this.data.objects.get(u.oid) : undefined;
    if (!u || !r || !d) return e.wait ?? 0;
    for (const slot of [8 + u.dir, 8, 16 + u.dir, 16]) {
      const en = this.entry(d.slots[slot]);
      if (!en || en.frames < 2) continue;
      const l = d.layers[slot]?.[0];
      const T = (en.frames * 10) / (l ? layerFps(l) : 7);
      const rel = r.soundFrame < 0 ? en.frames - 1 : Math.min(en.frames - 1, r.soundFrame);
      return (rel * T) / (en.frames - 1);
    }
    return e.wait ?? 0;
  }

  /**
   * launch pixel offset L = shooter anchor - shooter point[d], plus outpost anchor - outpost
   * point[slot] for a garrison (projectiles.md 2.6). Shooter from the event, else the unit on the
   * start cell.
   */
  private launchOffset(w: World, e: CombatEffect, dir: number): [number, number] {
    let u: Entity | undefined = e.shooter !== undefined ? w.get(e.shooter) : undefined;
    if (!u) {
      const cx = e.x, cy = e.y;
      u = w.entities.find(v => v.kind === Kind.Unit && v.alive && v.inside < 0 && Math.floor(v.x / SUB) === cx && Math.floor(v.y / SUB) === cy);
    }
    const r = u ? this.data.rules.get(u.oid) : undefined, d = u ? this.data.objects.get(u.oid) : undefined;
    if (!r || !d || !r.points?.[dir]) return [0, DEFAULT_LIFT];
    let lx = d.anchorX - r.points[dir][0], ly = d.anchorY - r.points[dir][1];
    // a garrison shooter: plus outpost anchor - point[slot], the slot of the display's garrison
    // list (objects.md 13.1, 13.4: 22 px above the drawn unit, as in the original)
    const b = e.garrison !== undefined && e.garrison >= 0 ? w.get(e.garrison) : undefined;
    if (b && b.kind === Kind.Building && u && u.inside === b.id) {
      const br = this.data.rules.get(b.oid), bd = this.data.objects.get(b.oid);
      if (bd) {
        const [gx, gy] = garrisonLaunch(br?.points, garrisonSlot(w, u), bd.anchorX, bd.anchorY);
        lx += gx; ly += gy;
      }
    }
    return [lx, ly];
  }

  /** sprites for the current time (t in ticks, wall in ms); arriving shots play their hit sound and spawn their impact effect */
  update(t: number, wall: number, size: number): FxDraw[] {
    const out: FxDraw[] = [];
    const now = quantClock(wall);
    const keep: Shot[] = [];
    for (const s of this.shots) {
      if (t < s.release) { keep.push(s); continue; }
      const d = this.desc(s.type);
      if (!s.step) {
        // release: only when the aim cell is on screen (2.2)
        if (!d || !this.visible(s.ax + 0.5, s.ay + 0.5)) continue;
        s.step = new StepDisplay();
        // remaining ground offset A - S (wrapped the short way), drawn at A minus it, like a unit's step
        let dx = s.ax - s.sx, dy = s.ay - s.sy;
        if (dx > size / 2) dx -= size; else if (dx < -size / 2) dx += size;
        if (dy > size / 2) dy -= size; else if (dy < -size / 2) dy += size;
        s.step.begin(dx * OFFSET_UNITS, dy * OFFSET_UNITS, quantClock(wall - Math.min(1, t - s.release) * TICK_MS), s.f);
        // the start point in cells, wrapped next to the aim cell, for the height
        s.sx = s.ax - dx; s.sy = s.ay - dy;
      }
      const st = s.step;
      st.update(now);
      const gx = s.ax + 0.5 - st.dx / OFFSET_UNITS, gy = s.ay + 0.5 - st.dy / OFFSET_UNITS;
      if (!st.moving) {
        // arrival (5): hit sound and impact effect at the aim cell
        const r = this.rule(s.type);
        if (r && r.soundAction === 1 && r.sound > 0) this.onSound(r.sound, s.ax, s.ay);
        if (r && r.impact >= 0) this.anims.push({ start: t, type: r.impact, x: s.ax, y: s.ay });
        continue;
      }
      // a projectile that leaves the screen is removed without sound or effect (5)
      if (!this.visible(gx, gy)) continue;
      keep.push(s);
      if (!d) continue;
      const entry = this.entry(d.slots[s.dir]) ?? this.entry(d.slots[0]) ?? this.entry(d.slots.find(x => x));
      if (!entry) continue;
      // pixel offset L - L t/f and height h_S + (h_A - h_S) t/f (3)
      const rem = 1 - st.progress(now);
      const h0 = this.height(s.sx, s.sy), h1 = this.height(s.ax, s.ay);
      out.push({ entry, frame: st.frame % entry.frames, anchorX: d.anchorX, anchorY: d.anchorY,
        x: gx, y: gy, h: h1 + (h0 - h1) * rem, ox: -Math.trunc(s.lx * rem), oy: -Math.trunc(s.ly * rem) });
    }
    this.shots = keep;
    const anims: Anim[] = [];
    for (const a of this.anims) {
      const d = this.desc(a.type);
      const name = d?.slots.find(s => s);
      const entry = this.entry(name);
      if (!d || !entry) continue;
      const layer = d.layers.find(l => l?.length)?.[0];
      const af = actionFrame(t - a.start, entry.frames, layer ? layerFps(layer) : 7, 1);
      // the event is the last frame: the effect is removed (5.2); its record sound plays then only
      // if the record's +0x134 is 1, which no effect record has (death sounds play at creation)
      if (af.done || af.frame >= entry.frames - 1) {
        const r = this.rule(a.type);
        if (r && r.soundAction === 1 && r.sound > 0) this.onSound(r.sound, a.x, a.y);
        continue;
      }
      anims.push(a);
      out.push({ entry, frame: af.frame, anchorX: d.anchorX, anchorY: d.anchorY, x: a.x + 0.5, y: a.y + 0.5, ox: 0, oy: 0 });
    }
    this.anims = anims;
    return out;
  }

  clear(): void { this.shots = []; this.anims = []; }
}
