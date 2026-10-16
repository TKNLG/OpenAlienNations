// Which sprites and frames show an object right now.
//
// Descriptor slots are action x 8 + direction (od-odb.md). Units use them as animations per
// facing. Buildings and nature use them as states:
//   buildings: slot 0 = construction stages (BU0, 10 frames), slot 1 = finished (MS0 + layers)
//   trees:     CA0 (slot 32) standing, WO0 (16) falling, MS0 (0) felled trunk by remaining wood,
//              ST0 (8) growth stages of a planted tree
//   crops:     ST0 growth stages, MS0 ripe
//   bushes, stones, rubble: MS0 frames by how much has been taken
// A finished building is its MS0 plus the further layers of its descriptor (door, work and
// random layers, docs/rendering/objects.md 1); every layer is always drawn, MS0 has holes under
// them. Which frame each layer shows is decided by the display state (display.ts).
// Units and walking animals: facing, step drawing, walk frames by distance and action animations
// are kept by display.ts UnitDisplay (docs/rendering/unit-motion.md 1-3); this file picks the row.
// Animation speed: the row's layer speed, -1 = 7 frames per 10 ticks (units-and-jobs.md 10).

import type { ObjectDesc, OdLayer } from '../formats/od.ts';
import type { GdEntry } from '../formats/gd.ts';
import type { ObjectRule } from '../formats/odb.ts';
import { Kind, Action, type Entity } from '../engine/world.ts';
import type { GameData } from './data.ts';
import type { SpriteAtlas } from './sprites.ts';
import { alphaMask } from './picking.ts';
import {
  layerRoles, updateBuilding, buildingFrames, updateFish, workRequested, isFish, layerFps, ghostRecolour, UnitDisplay,
  type LayerRoles, type ObjDisplay, type DisplayRng, type MotionOptions, type MotionRow,
} from './display.ts';

export const FRAMES_PER_TICK = 0.7;

/**
 * Depletion frame of a nature object (units-and-jobs.md 7.4, `004636b0`): (full - remaining) x F /
 * full, integer division, with F = the sprite's frame count, minus 1 for objects that stay when
 * empty (bushes), so an empty bush shows exactly its last frame. Clamped to the sprite.
 */
export function lossFrame(full: number, amount: number, frames: number, staysEmpty: boolean): number {
  const f = Math.max(1, full), F = staysEmpty ? frames - 1 : frames;
  return Math.max(0, Math.min(frames - 1, Math.floor(((f - amount) * F) / f)));
}
const S = { MS: 0, ST: 8, WO: 16, ID: 24, CA: 32 } as const;

export interface Pick { entry: GdEntry; frame: number; anchorX: number; anchorY: number; }

/** what to draw for one object this frame, and whether it starts its record sound */
export interface View { picks: Pick[]; sound: boolean; }

const NONE: View = { picks: [], sound: false };

export class Looks {
  private data: GameData;
  private atlas: SpriteAtlas;
  private descs = new Map<number, ObjectDesc>();
  /** roles of the finished building layers per object type */
  private roles = new Map<number, LayerRoles>();
  private loading = new Set<number>();
  /** hit masks (alpha > 192) per `${name}#${frame}` for pixel-accurate picking */
  private masks = new Map<string, Uint8Array>();
  private ghosts = new Set<number>();
  private ghostLoading = new Set<number>();

  constructor(data: GameData, atlas: SpriteAtlas) { this.data = data; this.atlas = atlas; }

  clear(): void { this.descs.clear(); this.roles.clear(); }

  /** load every sprite frame of these object types (missing ones are skipped) */
  async ensure(oids: Iterable<number>): Promise<void> {
    const todo = [...new Set(oids)].filter(o => !this.descs.has(o) && !this.loading.has(o));
    if (!todo.length) return;
    const requests: { e: GdEntry; lastFrame: number }[] = [];
    const descs: [number, ObjectDesc][] = [];
    for (const oid of todo) {
      const desc = this.data.objects.get(oid);
      if (!desc) continue;
      this.loading.add(oid);
      descs.push([oid, desc]);
      const names = new Set<string>();
      for (const ls of desc.layers) for (const l of ls ?? []) names.add(l.name);
      for (const name of names) {
        if (this.atlas.rects.has(`${name}#0`)) continue;
        const e = this.data.sprites.entry(name);
        if (e) requests.push({ e, lastFrame: e.frames - 1 });
      }
    }
    try {
      const decoded = await this.data.sprites.framesMany(requests);
      for (const [e, fr] of decoded) fr.forEach((px, i) => {
        this.atlas.add(`${e.name}#${i}`, e.width, e.height, px);
        this.masks.set(`${e.name}#${i}`, alphaMask(px, e.width, e.height));
      });
      for (const [oid, d] of descs) {
        this.descs.set(oid, d);
        if (d.kind === 1 && d.layers[1]) this.roles.set(oid, layerRoles(d.layers[1]));
      }
    } finally {
      for (const [oid] of descs) this.loading.delete(oid);
    }
  }

  /** units and live animals: drawn with UnitDisplay (steps, facing, actions) */
  static moves(e: Entity, rule: ObjectRule | undefined): boolean {
    return e.kind === Kind.Unit || (e.kind === Kind.Nature && rule?.cls === 7 && e.alive);
  }

  /** the sprite row of slot action x 8 + dir, null when the slot is empty */
  private row(desc: ObjectDesc, action: number, dir: number): MotionRow | null {
    const i = action * 8 + dir;
    const en = this.entry(desc.slots[i]);
    if (!en) return null;
    const l = desc.layers[i]?.[0];
    return { frames: en.frames, fps: l ? layerFps(l) : 7 };
  }

  /** the object type has slot i (e.g. 27 = ID3, 29 = ID5) */
  hasSlot(oid: number, i: number): boolean { const d = this.descs.get(oid); return !!d && !!this.entry(d.slots[i]); }

  /**
   * Advance a unit's (or walking animal's) motion display for this redraw (unit-motion.md 1-3):
   * call before its screen position is needed. Opts without the record sound fields.
   */
  motion(e: Entity, rule: ObjectRule | undefined, d: ObjDisplay, o: Omit<MotionOptions, 'soundFrame' | 'soundAction'>): UnitDisplay | null {
    const desc = this.descs.get(e.oid);
    if (!desc) return null;
    const u = d.unit ??= new UnitDisplay();
    u.update(e, (a, dir) => this.row(desc, a, dir),
      { ...o, soundFrame: rule?.soundFrame ?? -1, soundAction: rule?.soundAction ?? -1 });
    return u;
  }

  missing(e: Entity): boolean { return !this.descs.has(e.oid) && !this.loading.has(e.oid); }

  mask(p: Pick): Uint8Array | undefined { return this.masks.get(`${p.entry.name}#${p.frame}`); }

  private entry(name: string | null | undefined): GdEntry | undefined { return name ? this.data.sprites.entry(name) : undefined; }

  /**
   * Advance the display state of an object and return what to draw. Call once per redraw for
   * every object that may be drawn (passes the fog test); `onScreen` = it is in the drawn list.
   * t = simulation time in ticks (units, nature), now = wall clock in ms (layers, objects.md 2).
   */
  view(e: Entity, rule: ObjectRule | undefined, t: number, now: number, d: ObjDisplay, onScreen: boolean, rng: DisplayRng): View {
    const desc = this.descs.get(e.oid);
    if (!desc) return NONE;
    if (e.kind === Kind.Building) return this.building(e, rule, desc, now, d, onScreen, rng);
    if (isFish(e.oid)) {
      const id0 = desc.layers[S.ID]?.[0], ms = this.entry(desc.slots[S.MS]);
      const leapEntry = this.entry(id0?.name);
      const f = updateFish(d, leapEntry?.frames ?? 0, id0 ? layerFps(id0) : 5, onScreen, now, rng);
      if (!onScreen) return NONE;
      const entry = f >= 0 && leapEntry ? leapEntry : ms;
      return entry ? { picks: [{ entry, frame: f >= 0 ? f : 0, anchorX: desc.anchorX, anchorY: desc.anchorY }], sound: false } : NONE;
    }
    if (!onScreen) return NONE;
    const p = this.pick(e, rule, t, d.unit);
    return p ? { picks: [p], sound: !!d.unit?.sound && (rule?.sound ?? 0) > 0 } : NONE;
  }

  private building(e: Entity, rule: ObjectRule | undefined, desc: ObjectDesc, now: number, d: ObjDisplay, onScreen: boolean, rng: DisplayRng): View {
    const bu0 = this.entry(desc.slots[0]);
    const layers: readonly OdLayer[] = desc.layers[1] ?? [];
    const roles = this.roles.get(e.oid) ?? { door: -1, work: [], random: [] };
    const st = { complete: e.complete, active: e.active, working: workRequested(e, rule), doorTick: e.doorTick, doorOpen: e.doorOpen, doorShut: e.doorShut, replayOnComplete: (e.oid & 0xffff) === 40 };
    const up = updateBuilding(d, st, layers, roles, bu0?.frames ?? 0, onScreen, now, rng);
    if (!onScreen) return NONE;
    const at = (entry: GdEntry, frame: number): Pick => ({ entry, frame, anchorX: desc.anchorX, anchorY: desc.anchorY });
    if (!e.complete || d.replay || !layers.length) {
      if (!bu0) return NONE;
      const f = !e.complete ? Math.min(bu0.frames - 1, e.buildFrame) : d.replay ? d.replay.frame(now, bu0.frames) : bu0.frames - 1;
      return { picks: [at(bu0, f)], sound: false };
    }
    const frames = buildingFrames(d, layers, now);
    const picks: Pick[] = [];
    layers.forEach((l, i) => { const en = this.entry(l.name); if (en) picks.push(at(en, Math.min(en.frames - 1, frames[i]))); });
    return { picks, sound: up.sound && (rule?.sound ?? 0) > 0 };
  }

  /** the single picture of a unit or nature object */
  pick(e: Entity, rule: ObjectRule | undefined, t: number, u: UnitDisplay | null = null): Pick | null {
    const d = this.descs.get(e.oid);
    if (!d) return null;
    const slot = (i: number) => this.entry(d.slots[i]);
    const anim = (entry: GdEntry, since: number, loop = true) => {
      const f = Math.floor(Math.max(0, t - since) * FRAMES_PER_TICK);
      return loop ? f % entry.frames : Math.min(entry.frames - 1, f);
    };
    const byLoss = (entry: GdEntry) => lossFrame(e.full, e.amount, entry.frames, rule?.cls === 9);
    let entry: GdEntry | undefined, frame = 0;
    if (e.kind === Kind.Nature) {
      const cls = rule?.cls ?? -1;
      if (cls === 8) { // tree
        if (e.standing) { entry = slot(S.CA) ?? slot(S.WO); }
        else if (e.amount === 0 && e.growJob) { entry = slot(S.ST); if (entry) frame = Math.min(entry.frames - 1, Math.floor((e.stage / 100) * entry.frames)); }
        else if (e.action === Action.Work && (entry = slot(S.WO)) && anim(entry, e.actionTick, false) < entry.frames - 1) {
          frame = anim(entry, e.actionTick, false);
        } else { entry = slot(S.MS); if (entry) frame = byLoss(entry); }
      } else if (cls >= 10 && cls <= 12) { // crop
        if (e.amount === 0 && e.growJob) {
          entry = slot(S.ST);
          if (entry) frame = Math.min(entry.frames - 1, Math.floor(((t - e.actionTick) / 599) * entry.frames));
        } else entry = slot(S.MS);
      } else if (cls === 7) { // animal: walking, idle; a hunted animal lies as its carcass (CA0)
        if (!e.alive) { entry = slot(S.CA); return entry ? { entry, frame: 0, anchorX: d.anchorX, anchorY: d.anchorY } : null; }
        if (u) { entry = slot(u.action * 8 + u.dir) ?? slot(0); frame = u.frame; }
        else entry = slot(e.dir) ?? slot(0);
      } else {
        entry = slot(S.MS) ?? d.slots.map((_, i) => slot(i)).find(x => x);
        if (entry) frame = byLoss(entry);
      }
    } else if (u) {
      // units: the row and frame chosen by UnitDisplay (walk / carry frames by distance, strike
      // once, work looping, idle animation; a loaded ship sails with its carry sprites)
      entry = slot(u.action * 8 + u.dir) ?? slot(u.action * 8) ?? slot(Action.Walk * 8 + u.dir) ?? slot(0);
      if (entry) frame = Math.min(entry.frames - 1, u.frame);
    } else {
      entry = slot(Action.Walk * 8 + e.dir) ?? slot(0);
    }
    if (!entry) return null;
    return { entry, frame, anchorX: d.anchorX, anchorY: d.anchorY };
  }

  /**
   * Placement preview (objects.md 6): the finished slot with all layers at frame 0, recoloured
   * green (allowed) or red (forbidden). Null until ensureGhost() has prepared the pictures.
   */
  ghost(oid: number, ok: boolean): { picks: Pick[]; keys: string[] } | null {
    const desc = this.data.objects.get(oid);
    if (!desc || !this.ghosts.has(oid)) return null;
    const layers = desc.layers[1] ?? desc.layers[0] ?? [];
    const picks: Pick[] = [], keys: string[] = [];
    for (const l of layers) {
      const en = this.entry(l.name);
      if (!en) continue;
      picks.push({ entry: en, frame: 0, anchorX: desc.anchorX, anchorY: desc.anchorY });
      keys.push(`${en.name}#0#${ok ? 'ok' : 'no'}`);
    }
    return { picks, keys };
  }

  /** decode frame 0 of every finished layer of a building type and add its two recoloured versions */
  async ensureGhost(oid: number): Promise<void> {
    if (this.ghosts.has(oid) || this.ghostLoading.has(oid)) return;
    const desc = this.data.objects.get(oid);
    if (!desc) return;
    this.ghostLoading.add(oid);
    const layers = desc.layers[1] ?? desc.layers[0] ?? [];
    const entries = layers.map(l => this.entry(l.name)).filter((x): x is GdEntry => !!x);
    try {
      const decoded = await this.data.sprites.framesMany(entries.map(e => ({ e, lastFrame: 0 })));
      for (const [e, fr] of decoded) {
        if (!fr[0]) continue;
        this.atlas.add(`${e.name}#0#ok`, e.width, e.height, ghostRecolour(fr[0], true));
        this.atlas.add(`${e.name}#0#no`, e.width, e.height, ghostRecolour(fr[0], false));
      }
      this.ghosts.add(oid);
    } finally { this.ghostLoading.delete(oid); }
  }
}
