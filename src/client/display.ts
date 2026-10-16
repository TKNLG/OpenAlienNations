// Display-side life of world objects: layer players, building doors / work / random layers,
// the construction completion replay, the idle timer and the add-on fish leap.
// Spec: docs/rendering/objects.md 2-5. Everything here is display only: it reads the simulation
// state, never writes it, and uses its own random generator (5.4 "Rebuild rule"), never the
// simulation's. Times are wall-clock milliseconds (layer timing is real time, 2).

import { LayerFlag, type OdLayer } from '../formats/od.ts';

/** frames per second of a layer whose descriptor speed is -1 (objects.md 1) */
export const DEFAULT_FPS = 7;
/** construction completion replay: BU0 at 5 fps, once (3) */
export const COMPLETION_FPS = 5;
/** how long a door stays open after a unit went through (4.1: about 10 ticks for a leaving unit) */
export const DOOR_HOLD_MS = 1000;
const MODE_BITS = LayerFlag.PingPong | LayerFlag.Once | LayerFlag.Reverse;

/** display random generator: 0..32767 like the C runtime rand(), but separate from the simulation */
export type DisplayRng = () => number;
export const displayRng: DisplayRng = () => Math.floor(Math.random() * 32768);

export const layerFps = (l: { speed: number }) => (l.speed > 0 ? l.speed : DEFAULT_FPS);

/** The player of one layer (objects.md 2). */
export class LayerPlayer {
  base = 0;
  speed = 0;
  mode = 0;
  t0 = 0;
  running = false;

  /** start from frame `from`; speed in fps, mode = LayerFlag playback bits */
  start(now: number, from: number, speed: number, mode: number): void {
    this.base = from; this.speed = speed; this.mode = mode & MODE_BITS; this.t0 = now; this.running = true;
  }

  /** freeze on the frame currently shown (not reset to 0) */
  stop(now: number, n: number): void {
    this.base = this.frame(now, n);
    this.running = false;
  }

  private raw(now: number): number { return Math.floor((Math.max(0, now - this.t0) * this.speed) / 1000) + this.base; }
  private cycle(n: number): number { return this.mode & LayerFlag.PingPong ? 2 * n : n; }

  /** frame shown now for a sprite of n frames */
  frame(now: number, n: number): number {
    if (n <= 0) return 0;
    if (!this.running) return Math.min(n - 1, Math.max(0, this.base));
    let f = this.raw(now);
    const L = this.cycle(n);
    if (!(this.mode & LayerFlag.Once) || f < L) f %= L;
    else f = L - 1;
    if (this.mode & LayerFlag.Reverse) f = L - 1 - f;
    if (this.mode & LayerFlag.PingPong && f >= n) f = 2 * n - 1 - f;
    return f;
  }

  /** a "once" run has reached its end */
  ended(now: number, n: number): boolean {
    return this.running && !!(this.mode & LayerFlag.Once) && this.raw(now) >= this.cycle(n);
  }
}

/** interval of the idle timer: 5000 + rand() mod 25000 ms (5.1) */
export const idleInterval = (rng: DisplayRng) => 5000 + (rng() % 25000);

/**
 * The display's idle timer (5.1). Call update() once per redraw for an object in the drawn
 * list; reset() when it leaves the screen. Used by buildings (random layers) and fish (leap),
 * reusable for unit fidgets (5.2).
 */
export class IdleTimer {
  interval: number;
  start = -1;
  constructor(rng: DisplayRng) { this.interval = idleInterval(rng); }

  reset(rng: DisplayRng): void { this.interval = idleInterval(rng); this.start = -1; }

  /** busy = moving or playing an action animation; true when the timer fires */
  update(now: number, busy: boolean, rng: DisplayRng): boolean {
    if (busy) { this.reset(rng); return false; }
    if (this.start < 0) { this.start = now; return false; }
    if (now - this.start <= this.interval) return false;
    this.reset(rng);
    return true;
  }
}

/** a building's layers sorted by role (1.1): door = the last layer with 0x10 */
export interface LayerRoles { door: number; work: number[]; random: number[]; }

export function layerRoles(layers: readonly OdLayer[]): LayerRoles {
  const r: LayerRoles = { door: -1, work: [], random: [] };
  layers.forEach((l, i) => {
    if (i === 0) return;
    if (l.flags & LayerFlag.Door) r.door = i;
    if (l.flags & LayerFlag.Work) r.work.push(i);
    else if (l.flags & LayerFlag.Random) r.random.push(i);
  });
  return r;
}

/** what the simulation says about a building, read once per frame */
export interface BuildingState {
  complete: boolean;
  active: boolean;
  /** work layers should run (4.2): service building active, training or production run going */
  working: boolean;
  /** last tick a unit went through a door without the door messages (ships at harbours; legacy) */
  doorTick: number;
  /** ticks of the simulation's last door-open (0x2B) and door-close (unit entered, unit placed
   *  outside, 0x2C) messages (objects.md 4.1); absent = never */
  doorOpen?: number;
  doorShut?: number;
  /** completion replays BU0 (message 0x30): only a town hall raised by its founder; a builder's
   *  normal completion switches to MS0 at once (objects.md 3) */
  replayOnComplete?: boolean;
}

/** whether a building's work layers run (objects.md 3 and 4.2) */
export function workRequested(
  b: { active: boolean; trainStarted: number; order: { kind: string; started: number } | null },
  rule: { cls: number; product: number } | undefined,
): boolean {
  if (!b.active) return false;
  if (rule?.cls === 5) return b.trainStarted !== 0;                            // training building
  if ((rule?.product ?? -1) >= 0) return !!b.order && b.order.kind === 'produce' && b.order.started !== 0;
  return true;                                                                 // service building
}

/** per object display state */
export class ObjDisplay {
  timer: IdleTimer;
  /** players of the finished slot's layers (index = layer index) */
  players: LayerPlayer[] = [];
  /** drawn in the previous redraw */
  drawn = false;
  /** buildings */
  complete: boolean | null = null;
  replay: LayerPlayer | null = null;
  doorSeen = Number.NaN;
  doorCloseAt = -1;
  openSeen = Number.NaN;
  shutSeen = Number.NaN;
  working = false;
  /** fish: the running leap (ID0 once) */
  leap: LayerPlayer | null = null;
  /** units and animals: drawn step offset, walk frame, facing and action animation (unit-motion.md 1-3) */
  unit: UnitDisplay | null = null;

  constructor(rng: DisplayRng) { this.timer = new IdleTimer(rng); }

  player(i: number): LayerPlayer {
    while (this.players.length <= i) this.players.push(new LayerPlayer());
    return this.players[i];
  }
}

export interface BuildingUpdate {
  /** a random layer fired: play the building's record sound (4.3) */
  sound: boolean;
}

/**
 * Advance a building's display for this redraw. `layers` = finished slot (MS0 + layers),
 * `bu0Frames` = frame count of the construction sprite, `onScreen` = in this frame's drawn list.
 */
export function updateBuilding(d: ObjDisplay, st: BuildingState, layers: readonly OdLayer[], roles: LayerRoles,
  bu0Frames: number, onScreen: boolean, now: number, rng: DisplayRng): BuildingUpdate {
  const out = { sound: false };
  // completion (3): a founded town hall replays BU0 once when on screen; otherwise MS0 at once
  if (d.complete === null) d.complete = st.complete;
  else if (!d.complete && st.complete) {
    d.complete = true;
    if (st.replayOnComplete && onScreen && d.drawn && bu0Frames > 1) { d.replay = new LayerPlayer(); d.replay.start(now, 0, COMPLETION_FPS, LayerFlag.Once); }
  } else if (!st.complete) d.complete = false;
  if (d.replay && (!onScreen || d.replay.ended(now, bu0Frames))) d.replay = null;

  if (st.complete) {
    // door (4.1): open once, stay open, close (reverse) from the fully open frame
    if (roles.door >= 0) {
      const l = layers[roles.door], p = d.player(roles.door), fps = layerFps(l);
      // the door messages: 0x2B opens (frames 0 -> n-1, then held open); "unit entered", "unit
      // placed outside" and 0x2C close, always from the fully open frame (reverse)
      const open = st.doorOpen ?? -1000, shut = st.doorShut ?? -1000;
      if (Number.isNaN(d.openSeen)) { d.openSeen = open; d.shutSeen = shut; }
      const opened = open !== d.openSeen, shutNow = shut !== d.shutSeen;
      d.openSeen = open; d.shutSeen = shut;
      if (opened && !(shutNow && shut >= open)) { p.start(now, 0, fps, LayerFlag.Once); d.doorCloseAt = -1; }
      else if (shutNow) { p.start(now, 0, fps, LayerFlag.Once | LayerFlag.Reverse); d.doorCloseAt = -1; }
      // legacy: a unit went through without door messages (ships): open, hold, close
      if (Number.isNaN(d.doorSeen)) d.doorSeen = st.doorTick;
      else if (st.doorTick !== d.doorSeen) {
        d.doorSeen = st.doorTick;
        if (!(p.running && d.doorCloseAt >= 0)) p.start(now, 0, fps, LayerFlag.Once);
        d.doorCloseAt = now + Math.max((l.frames * 1000) / fps, DOOR_HOLD_MS);
      }
      if (d.doorCloseAt >= 0 && now >= d.doorCloseAt) {
        p.start(now, 0, fps, LayerFlag.Once | LayerFlag.Reverse);
        d.doorCloseAt = -1;
      }
    }
    // work layers (4.2): start from frame 0 on, freeze off
    if (st.working !== d.working) {
      d.working = st.working;
      for (const i of roles.work) {
        const l = layers[i], p = d.player(i);
        if (st.working) p.start(now, 0, layerFps(l), l.flags);
        else p.stop(now, l.frames);
      }
    }
  }
  // idle timer (5.1) only while drawn; reset when the object leaves the screen
  if (!onScreen) {
    if (d.drawn) d.timer.reset(rng);
    d.drawn = false;
    return out;
  }
  d.drawn = true;
  if (d.timer.update(now, false, rng) && st.complete && !d.replay && st.active && roles.random.length) {
    // random layer (4.3)
    const i = roles.random[rng() % roles.random.length], l = layers[i];
    d.player(i).start(now, 0, layerFps(l), l.flags);
    out.sound = true;
  }
  return out;
}

/** frame of each layer of a finished building now */
export function buildingFrames(d: ObjDisplay, layers: readonly OdLayer[], now: number): number[] {
  return layers.map((l, i) => (i === 0 ? 0 : d.players[i] ? d.players[i].frame(now, l.frames) : 0));
}

/**
 * Gold fish (5.3): rest on MS0, leap once through ID0 when the idle timer fires on screen.
 * Returns the ID0 frame while leaping, -1 while resting.
 */
export function updateFish(d: ObjDisplay, leapFrames: number, leapFps: number, onScreen: boolean, now: number, rng: DisplayRng): number {
  if (d.leap && (!onScreen || d.leap.ended(now, leapFrames))) d.leap = null;
  if (!onScreen) {
    if (d.drawn) d.timer.reset(rng);
    d.drawn = false;
    return -1;
  }
  d.drawn = true;
  if (d.timer.update(now, !!d.leap, rng) && leapFrames > 0) {
    d.leap = new LayerPlayer();
    d.leap.start(now, 0, leapFps, LayerFlag.Once);
  }
  return d.leap ? d.leap.frame(now, leapFrames) : -1;
}

/** Gold fish: group 6, types 41..45 (objects.md 5.3, 8) */
export const isFish = (oid: number) => (oid >>> 16) === 6 && (oid & 0xffff) >= 41 && (oid & 0xffff) <= 45;

/** display objects by entity id */
export class Displays {
  readonly rng: DisplayRng;
  private map = new Map<number, ObjDisplay>();
  constructor(rng: DisplayRng = displayRng) { this.rng = rng; }
  get(id: number): ObjDisplay {
    let d = this.map.get(id);
    if (!d) { d = new ObjDisplay(this.rng); this.map.set(id, d); }
    return d;
  }
  /** the display object if there is one (does not create it) */
  peek(id: number): ObjDisplay | undefined { return this.map.get(id); }
  /** forget objects that no longer exist */
  prune(alive: (id: number) => boolean): void { for (const id of this.map.keys()) if (!alive(id)) this.map.delete(id); }
  clear(): void { this.map.clear(); }
}

// ---------------------------------------------------------------- placement preview (6.2)

/**
 * Recolour a straight-alpha RGBA picture for the placement preview: keep the top 5 bits of the
 * (premultiplied) green channel; allowed -> green only, forbidden -> red only. Alpha unchanged.
 */
export function ghostRecolour(rgba: Uint8Array, ok: boolean): Uint8Array {
  const out = new Uint8Array(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3];
    if (!a) continue;
    const g5 = Math.floor((rgba[i + 1] * a) / 255) & 0xf8;          // premultiplied, 5 bits
    const g = Math.min(255, Math.round((g5 * 255) / a));            // back to straight alpha
    out[i] = ok ? 0 : g; out[i + 1] = ok ? g : 0; out[i + 2] = 0; out[i + 3] = a;
  }
  return out;
}

// ---------------------------------------------------------------- unit motion (unit-motion.md 1-3)
//
// The simulation moves a unit to its destination cell at the start of a step and says when the
// step started and how long it lasts (D ticks, docs/architecture/simulation.md "Display contract
// for movement"). The display draws it at "destination - remaining offset" and lets the offset
// run down in jumps; the walk cycle advances one frame per jump (2.3, 2.4). Actions (strike,
// work, idle) are time-based animations (3). All of this is display only.

/** drawn offsets are kept in 1/64 cell (2.2) */
export const OFFSET_UNITS = 64;
/** a jump needs a change of more than 3/64 cell (2.3) */
export const JUMP_MIN = 3;
/** the movement update acts at most every 10 ms (2.3) */
export const MOVE_GATE_MS = 10;
/** GetTickCount resolution on NT-family Windows (2.4, 2.5) */
export const WIN_CLOCK_MS = 15.625;
/** the original interpolates each step over D x 95 ms, its real tick period P is about 109.375 ms (2.5) */
export const ORIG_TICK_MS = 95;
export const ORIG_PERIOD_MS = 109.375;

/** the wall clock as the original reads it: in steps of 15.625 ms */
export const quantClock = (now: number) => Math.floor(now / WIN_CLOCK_MS) * WIN_CLOCK_MS;

/** display duration of a step of D ticks (2.6.2): D x TICK_MS x 95 / 109.375 ms; with TICK_MS = 100 the unit arrives ~13% early and waits */
export const stepDuration = (D: number, tickMs: number) => (D * tickMs * ORIG_TICK_MS) / ORIG_PERIOD_MS;

/** size of a change of the drawn offset: max(|dx|, |dy|) + min(|dx|, |dy|) / 2, in 1/64 cell (2.3.4) */
export function jumpSize(dx: number, dy: number): number {
  const ax = Math.abs(dx), ay = Math.abs(dy);
  return Math.max(ax, ay) + Math.trunc(Math.min(ax, ay) / 2);
}

/**
 * The drawn position of one step and the walk-frame counter (2.2, 2.3). `frame` counts jumps; the
 * walk (or carry) frame shown is frame mod the row's frame count. It is kept when the unit stops
 * and reset to 0 only when an action ends (2.4).
 */
export class StepDisplay {
  /** remaining offset at the start of the step (destination - origin), 1/64 cell */
  r0x = 0; r0y = 0;
  /** remaining offset currently drawn */
  dx = 0; dy = 0;
  /** wall-clock start and duration of the step, ms */
  start = 0; dur = 0;
  /** last movement update (10 ms gate) */
  last = -Infinity;
  /** walk frame counter: +1 per jump */
  frame = 0;

  /** a step message (2.2.3): draw at the old cell, run the offset down to 0 over `dur` ms */
  begin(r0x: number, r0y: number, start: number, dur: number): void {
    this.r0x = r0x; this.r0y = r0y; this.dx = r0x; this.dy = r0y;
    this.start = start; this.dur = Math.max(0, dur);
  }

  /** the step is still being drawn (screen offset not zero) */
  get moving(): boolean { return this.dx !== 0 || this.dy !== 0; }

  /** target remaining offset at time `now` (2.3.2, truncated integer arithmetic) */
  target(now: number): [number, number] {
    if (this.dur <= 0) return [0, 0];
    const e = Math.min(Math.max(0, now - this.start), this.dur);
    return [this.r0x - Math.trunc((this.r0x * e) / this.dur), this.r0y - Math.trunc((this.r0y * e) / this.dur)];
  }

  /** one per-frame movement update (2.3); true when the drawn offset jumped and the walk frame advanced */
  update(now: number): boolean {
    if (!this.moving) return false;
    if (now - this.last <= MOVE_GATE_MS) return false;
    this.last = now;
    const [tx, ty] = this.target(now);
    if (jumpSize(tx - this.dx, ty - this.dy) > JUMP_MIN) {
      this.dx = tx; this.dy = ty; this.frame++;
      return true;
    }
    if (tx === 0 && ty === 0) { this.dx = 0; this.dy = 0; }   // final snap without a frame
    return false;
  }

  /** share of the step's time that has passed (height interpolation, 2.3.3) */
  progress(now: number): number {
    if (this.dur <= 0 || !this.moving) return 1;
    return Math.min(1, Math.max(0, (now - this.start) / this.dur));
  }
}

/**
 * An action animation at `elapsed` ticks (3): one cycle lasts frames x 10 / fps ticks, the frame
 * shown is floor((frames - 1) x elapsed-in-cycle / T), `cycles` = repeat count + 1 (Infinity =
 * until the action changes). done = all cycles are over (back to the base movement action).
 */
export function actionFrame(elapsed: number, frames: number, fps: number, cycles: number): { frame: number; cycle: number; done: boolean } {
  const T = (frames * 10) / Math.max(1, fps);
  const el = Math.max(0, elapsed);
  const c = Math.floor(el / T);
  if (c >= cycles || frames <= 0) return { frame: Math.max(0, frames - 1), cycle: Math.max(0, Math.min(c, cycles - 1)), done: true };
  return { frame: Math.min(frames - 1, Math.floor(((frames - 1) * (el - c * T)) / T)), cycle: c, done: false };
}

/** what the display reads from a unit (or a walking animal); the Entity fields of the display contract */
export interface MotionInput {
  x: number; y: number; stepFromX: number; stepFromY: number; stepStart: number; stepTicks: number;
  dir: number; action: number; actionTick: number; idleTick: number; idleLoops: number;
  /** > 0: the base movement action is carry (where the sprite has it) */
  carryAmount: number;
}

/** one sprite row: slot action x 8 + dir; null when the slot is empty */
export interface MotionRow { frames: number; fps: number }
export type RowLookup = (action: number, dir: number) => MotionRow | null;

export interface MotionOptions {
  /** current simulation time in ticks (fractional: tick + phase) */
  t: number;
  /** wall clock, ms */
  wall: number;
  /** simulation tick length, ms */
  tickMs: number;
  /** enhanced mode: constant-speed interpolation over D ticks and time-based walk frames */
  smooth: boolean;
  /** record +0x04 / +0x134 (odb.md): the event frame and the action whose event plays the sound */
  soundFrame: number;
  soundAction: number;
  /** cycles of the work action: Infinity = loops until the action changes (gathering, building);
   *  1 = a single cycle (the founder's arrival, units-and-jobs.md 11.3; a heal strike, unit-motion.md 3) */
  workCycles?: number;
}

const ACT_WALK = 0, ACT_STRIKE = 1, ACT_WORK = 2, ACT_IDLE = 3, ACT_CARRY = 4;

/**
 * Display state of one unit: facing as the display knows it (1.5), the action animation (3) and the
 * step drawing (2). update() once per redraw, then read `action`, `dir`, `frame`, the remaining
 * offset (ox, oy in 1/64 cell) and the height progress `hk`.
 */
export class UnitDisplay {
  readonly step = new StepDisplay();
  /** last simulation step seen (step message detection) */
  private seenStart = Number.NaN; private seenX = Number.NaN; private seenY = Number.NaN;
  /** display facing (1.5: set by a facing change, falls back to 0 when a slot is empty) */
  dir = -1;
  private lastDir = -1;
  /** an action animation was running at the previous update */
  private acting = false;
  private animKey = '';
  /** the last action start seen (strike, work or idle), whose message cleared the step offset */
  private startKey = '';
  /** the action key cut by a facing change (1.5) */
  private cutKey = '';
  private evCycle = -1;
  private evFired = false;
  /** outputs */
  action = ACT_WALK;
  frame = 0;
  ox = 0; oy = 0;
  hk = 1;
  /** the record sound fires this update (3: action event) */
  sound = false;

  /** moving or playing an action: the idle timer is held (objects.md 5.1) */
  get busy(): boolean { return this.acting || this.ox !== 0 || this.oy !== 0; }

  update(u: MotionInput, row: RowLookup, o: MotionOptions): void {
    this.sound = false;
    const tick = Math.floor(o.t);
    // facing message (1.5): take the new facing; it cuts a running action that began earlier
    if (this.lastDir < 0) { this.lastDir = u.dir; this.dir = u.dir; }
    else if (u.dir !== this.lastDir) {
      this.lastDir = u.dir; this.dir = u.dir;
      if (this.acting && tick > u.actionTick) this.cutKey = this.animKey;
    }
    // step message (2.2): a new step starts at the old cell
    if (u.stepStart !== this.seenStart || u.x !== this.seenX || u.y !== this.seenY) {
      this.seenStart = u.stepStart; this.seenX = u.x; this.seenY = u.y;
      if (u.stepTicks > 0) {
        const r0x = Math.round(((u.x - u.stepFromX) * OFFSET_UNITS) / 256), r0y = Math.round(((u.y - u.stepFromY) * OFFSET_UNITS) / 256);
        const startRaw = o.wall - Math.max(0, o.t - u.stepStart) * o.tickMs;
        const start = o.smooth ? startRaw : quantClock(startRaw);
        this.step.begin(r0x, r0y, start, stepDuration(u.stepTicks, o.tickMs));
      } else this.step.begin(0, 0, o.wall, 0);
    }
    // action animation (3)
    const anim = u.action === ACT_STRIKE ? { a: ACT_STRIKE, cycles: 1 }
      : u.action === ACT_WORK ? { a: ACT_WORK, cycles: o.workCycles ?? Infinity }
      : u.action === ACT_IDLE && u.idleTick >= 0 && u.idleTick === u.actionTick ? { a: ACT_IDLE, cycles: u.idleLoops + 1 }
      : null;
    const key = anim ? `${u.action}:${u.actionTick}:${u.idleTick}` : '';
    // the action message clears the remaining step offset (3, `00456490`): from the start of an
    // action the unit is drawn on its cell; no frozen half step that is released in a jump later
    if (anim && key !== this.startKey) {
      this.startKey = key;
      this.step.r0x = 0; this.step.r0y = 0; this.step.dx = 0; this.step.dy = 0;
    }
    let running = false;
    if (anim && key !== this.cutKey) {
      let r = row(anim.a, this.dir);
      if (!r && this.dir !== 0) { r = row(anim.a, 0); if (r) this.dir = 0; }
      if (r) {
        if (key !== this.animKey) { this.animKey = key; this.evCycle = -1; this.evFired = false; }   // a new action replaces the old one without its event
        const af = actionFrame(o.t - u.actionTick, r.frames, r.fps, anim.cycles);
        const ev = o.soundFrame < 0 ? r.frames - 1 : o.soundFrame;
        const fires = anim.a === o.soundAction;
        if (af.cycle !== this.evCycle) {
          // a cycle ended: its event fires if it is still pending (the last frame was reached)
          if (this.evCycle >= 0 && !this.evFired && ev <= r.frames - 1) this.sound = fires;
          this.evCycle = af.cycle; this.evFired = false;
        }
        if (af.done) {
          if (!this.evFired && ev <= r.frames - 1 && this.acting) this.sound = fires;
          this.evFired = true;
        } else {
          running = true;
          if (!this.evFired && af.frame >= ev) { this.evFired = true; this.sound = fires; }
          this.action = anim.a; this.frame = af.frame;
        }
      }
    }
    if (!running && this.acting) this.step.frame = 0;   // the end of an action returns to frame 0 (3)
    this.acting = running;
    if (!running) {
      // base movement action: carry with goods where the sprite has it, else walk
      let a = u.carryAmount > 0 && (row(ACT_CARRY, this.dir) || row(ACT_CARRY, 0)) ? ACT_CARRY : ACT_WALK;
      let r = row(a, this.dir);
      if (!r && this.dir !== 0) { r = row(a, 0); if (r) this.dir = 0; }
      if (!r && a === ACT_CARRY) { a = ACT_WALK; r = row(a, this.dir); }
      this.action = a;
      const n = r?.frames ?? 1;
      if (o.smooth) {
        const k = u.stepTicks > 0 ? Math.min(1, Math.max(0, (o.t - u.stepStart) / u.stepTicks)) : 1;
        const mid = k < 1;
        this.step.dx = mid ? this.step.r0x * (1 - k) : 0; this.step.dy = mid ? this.step.r0y * (1 - k) : 0;
        this.hk = k;
        this.frame = mid ? Math.floor(Math.max(0, o.t - u.actionTick) * ((r?.fps ?? 7) / 10)) % n : 0;
      } else {
        const now = quantClock(o.wall);
        this.step.update(now);
        this.hk = this.step.progress(now);
        this.frame = this.step.frame % n;
      }
    }
    this.ox = this.step.dx; this.oy = this.step.dy;
  }
}

/** projected screen offset (zoom-1 px) of a remaining offset in 1/64 cell; whole pixels in vanilla mode (2.3) */
export function offsetPixels(ox: number, oy: number, whole: boolean): [number, number] {
  const px = ((oy - ox) * 32) / OFFSET_UNITS, py = ((ox + oy) * 22) / OFFSET_UNITS;
  return whole ? [Math.trunc(px), Math.trunc(py)] : [px, py];
}
