// The classic Microsoft C runtime rand(), needed to reproduce the original terrain exactly.
// Spec: docs/formats/terrain-gen.md "Random numbers". The original game shares one generator
// between terrain generation and all game code (docs/game/economy.md 3.2).

export class MsRand {
  private s: number;
  constructor(seed: number) { this.s = seed >>> 0; }
  next(): number {
    this.s = (Math.imul(this.s, 0x343fd) + 0x269ec3) >>> 0;
    return (this.s >>> 16) & 0x7fff;
  }
  /** raw 32-bit generator state (for save games and continuing the stream) */
  get state(): number { return this.s; }
  set state(v: number) { this.s = v >>> 0; }
}
