// The client's advisor voice player (docs/ui/side-panel.md 1.1.2). Pure logic: the sound and the
// message list are reached through `AdvisorIo`, so tests can drive it without a browser.
//
// - speech unavailable: the pending list is emptied and only the text is shown;
// - a voice exists: a queued line is appended to the pending list, an unqueued one is dropped;
// - otherwise the line's voice starts (a voice that fails to load is released at once) and its
//   text is shown.
// Once per frame: a voice that stopped playing is released, then the oldest pending line is
// removed and spoken again unqueued, so it is dropped if a voice still plays. A queued line thus
// waits one frame at most, and a burst of lines in one frame is heard as its first line only.
//
// `AdvisorQueue` is the enhanced-mode alternative (setting "Advisor: queue lines", advisorQueue):
// the voice player this rebuild had before it followed the original, with a real pending queue.
// Only the playback differs; the simulation's per-line filter is the same in both modes.

export interface AdvisorIo<V> {
  /** speech on and a sound device present */
  speechOn(): boolean;
  /** start line `id`'s voice; null when it cannot be loaded */
  start(id: number): V | null;
  /** the voice still reports "playing" */
  playing(v: V): boolean;
  /** add the line's text to the message list (5 s) */
  text(id: number): void;
}

/** what the overlay drives: the vanilla player or the enhanced queue */
export interface AdvisorPlayer {
  /** message 0x4D arrived: line `id` with its queue flag */
  speak(id: number, queue: boolean): void;
  /** the per-frame step, after drawing */
  frame(): void;
  readonly busy: boolean;
  readonly queued: number;
}

export class AdvisorVoice<V> implements AdvisorPlayer {
  private io: AdvisorIo<V>;
  private voice: V | null = null;
  private pending: number[] = [];

  constructor(io: AdvisorIo<V>) { this.io = io; }

  /** message 0x4D arrived: line `id` with its queue flag */
  speak(id: number, queue: boolean): void {
    if (!this.io.speechOn()) { this.pending.length = 0; this.io.text(id); return; }
    if (this.voice !== null) {
      if (queue) this.pending.push(id);
      return;
    }
    this.voice = this.io.start(id);
    this.io.text(id);
  }

  /** the per-frame step, after drawing */
  frame(): void {
    if (this.voice !== null && !this.io.playing(this.voice)) this.voice = null;
    const next = this.pending.shift();
    if (next !== undefined) this.speak(next, false);
  }

  get busy(): boolean { return this.voice !== null; }
  get queued(): number { return this.pending.length; }
}

// ---------------------------------------------------------------- enhanced: a real queue

/** the queue's client-side guard: a line is not repeated within this time (ms) ... */
export const QUEUE_REPEAT_MS = 60000;
/** ... except these lines, which the original says without a minimum interval */
export const QUEUE_NO_INTERVAL: ReadonlySet<number> = new Set([1, 10, 13, 79, 80]);

export interface AdvisorQueueIo<V> extends AdvisorIo<V> {
  /** wall clock, ms */
  now(): number;
  /** call `done` once when voice `v` ends or fails (onended / onerror); optional, the frame step
   *  notices a stopped voice too */
  onEnd?(v: V, done: () => void): void;
}

/**
 * Enhanced mode ("Advisor: queue lines"):
 *
 * - guard: a line other than 1, 10, 13, 79, 80 that was let through less than 60 s ago is dropped
 *   (checked first, so a line dropped later still counts as said);
 * - speech unavailable: only the text is shown (the pending list is kept);
 * - a voice plays: a queued line is appended to the pending list, an unqueued one is dropped;
 * - otherwise the line's text is shown and its voice starts.
 * When the voice ends (onEnd, or the frame step noticing it stopped), the oldest pending line is
 * removed and played, so queued lines are heard one after another, however long they wait.
 */
export class AdvisorQueue<V> implements AdvisorPlayer {
  private io: AdvisorQueueIo<V>;
  private voice: V | null = null;
  private pending: number[] = [];
  private lastSaid = new Map<number, number>();

  constructor(io: AdvisorQueueIo<V>) { this.io = io; }

  speak(id: number, queue: boolean): void {
    if (!QUEUE_NO_INTERVAL.has(id)) {
      const now = this.io.now();
      if (now - (this.lastSaid.get(id) ?? -Infinity) < QUEUE_REPEAT_MS) return;
      this.lastSaid.set(id, now);
    }
    if (!this.io.speechOn()) { this.io.text(id); return; }   // speech off: text only
    if (this.voice !== null && this.io.playing(this.voice)) {
      if (queue) this.pending.push(id);   // waits its turn
      return;                             // unqueued lines are dropped, text and voice
    }
    this.play(id);
  }

  private play(id: number): void {
    this.io.text(id);
    const v = this.io.start(id);
    this.voice = v;
    if (v !== null) this.io.onEnd?.(v, () => { if (this.voice === v) this.next(); });
  }

  /** the current voice is over: release it and play the oldest pending line */
  private next(): void {
    this.voice = null;
    const id = this.pending.shift();
    if (id !== undefined) this.play(id);
  }

  frame(): void {
    // a voice that stopped without an end event, or failed to load, does not hold up the queue
    if (this.voice === null ? this.pending.length > 0 : !this.io.playing(this.voice)) this.next();
  }

  get busy(): boolean { return this.voice !== null; }
  get queued(): number { return this.pending.length; }
}
