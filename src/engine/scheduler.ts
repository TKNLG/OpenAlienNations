// Job scheduler: a 600-slot timing wheel. Spec: docs/game/economy.md 1.3
//
// A job runs `delay` ticks after it was scheduled (0..599). Jobs due in the same tick run in
// reverse order of scheduling (last in, first out), and a job scheduled with delay 0 while a tick
// is being processed runs in that same tick. Jobs are plain data so they can be saved.

export const WHEEL = 600;

export interface Job {
  id: number;
  kind: number;
  /** entity id, town id or race, depending on the kind */
  owner: number;
  /** when non-zero the job is not run, only re-polled every `hold` ticks */
  hold: number;
  cancelled: boolean;
  /** job-specific numbers (counters, float32 accumulators) */
  data: number[];
}

export interface SchedulerSnapshot { cur: number; nextId: number; slots: Job[][]; }

export class Scheduler {
  private slots: Job[][] = Array.from({ length: WHEEL }, () => []);
  private cur = 0;
  private nextId = 1;
  private live = new Map<number, Job>();

  create(kind: number, owner: number, delay: number, data: number[] = []): Job {
    const job: Job = { id: this.nextId++, kind, owner, hold: 0, cancelled: false, data };
    this.schedule(job, delay);
    return job;
  }

  schedule(job: Job, delay: number): void {
    if (delay < 0 || delay >= WHEEL) throw new Error(`job delay ${delay} out of range`);
    let slot = this.cur + delay;
    if (slot >= WHEEL) slot -= WHEEL;
    this.slots[slot].push(job);
    this.live.set(job.id, job);
  }

  get(id: number): Job | undefined { return this.live.get(id); }
  cancel(id: number): void { const j = this.live.get(id); if (j) j.cancelled = true; }
  get size(): number { return this.live.size; }
  /** every job still known to the scheduler (save-game migrations) */
  jobs(): IterableIterator<Job> { return this.live.values(); }

  /** process the current slot; `run` returns the next delay (0 = finished) */
  tick(run: (job: Job) => number): void {
    const slot = this.slots[this.cur];
    while (slot.length) {
      const job = slot.pop()!;
      if (job.cancelled && job.hold === 0) { this.live.delete(job.id); continue; }
      if (job.hold !== 0) { this.schedule(job, job.hold); continue; }
      const r = run(job);
      if (r > 0) this.schedule(job, Math.min(WHEEL - 1, Math.max(r, job.hold)));
      else if (job.hold > 0) { job.cancelled = true; this.schedule(job, job.hold); }
      else this.live.delete(job.id);
    }
    this.cur = this.cur + 1 === WHEEL ? 0 : this.cur + 1;
  }

  snapshot(): SchedulerSnapshot {
    return { cur: this.cur, nextId: this.nextId, slots: this.slots.map(s => s.map(j => ({ ...j, data: [...j.data] }))) };
  }

  static restore(s: SchedulerSnapshot): Scheduler {
    const sch = new Scheduler();
    sch.cur = s.cur; sch.nextId = s.nextId;
    sch.slots = s.slots.map(slot => slot.map(j => ({ ...j, data: [...j.data] })));
    for (const slot of sch.slots) for (const j of slot) sch.live.set(j.id, j);
    return sch;
  }

  /** order-sensitive digest input */
  digest(mix: (v: number) => void): void {
    mix(this.cur); mix(this.nextId);
    for (const slot of this.slots) {
      if (!slot.length) continue;
      for (const j of slot) {
        mix(j.id); mix(j.kind); mix(j.owner); mix(j.hold); mix(j.cancelled ? 1 : 0);
        for (const d of j.data) mix(Math.round(d * 4096));
      }
    }
  }
}
