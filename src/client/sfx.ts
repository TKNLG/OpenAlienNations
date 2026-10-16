// Sound effects in the world: units play their record's sound (odb +0x08) when their animation
// for action +0x134 reaches frame +0x04 (docs/formats/odb.md 3, "Sound"). Sound n is
// Data/SOUND/Sfx_nnn.wav. Volume falls off with the distance from the view centre and the
// stereo position follows the screen x. Uses the effects volume from the settings screen.

import { loadSettings } from './frontend/settings.ts';

const MAX_VOICES = 8;

export class Sfx {
  private ctx: AudioContext | null = null;
  private buffers = new Map<number, AudioBuffer | null>();
  private voices = 0;
  private lastPlay = new Map<number, number>();
  /** a play requested while the sample was still loading: played on arrival if still fresh */
  private waiting = new Map<number, { dx: number; dy: number; at: number }>();
  private settings = { at: -1e9, effects: 1, on: true };

  private context(): AudioContext | null {
    if (!this.ctx) {
      try { this.ctx = new AudioContext(); } catch { return null; }
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  private volume(): number {
    const now = performance.now();
    if (now - this.settings.at > 1000) {
      const s = loadSettings();
      this.settings = { at: now, effects: s.effects / 100, on: s.soundOn };
    }
    return this.settings.on ? this.settings.effects : 0;
  }

  private load(id: number): AudioBuffer | null | undefined {
    if (this.buffers.has(id)) return this.buffers.get(id);
    this.buffers.set(id, null);
    const ctx = this.context();
    if (!ctx) return null;
    void fetch(`/game/Data/SOUND/Sfx_${String(id).padStart(3, '0')}.wav`)
      .then(r => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
      .then(b => ctx.decodeAudioData(b))
      .then(buf => {
        this.buffers.set(id, buf);
        const w = this.waiting.get(id);
        this.waiting.delete(id);
        if (w && performance.now() - w.at < 500) this.play(id, w.dx, w.dy);   // first use of a sample still sounds
      })
      .catch(() => { /* missing or undecodable */ });
    return undefined;
  }

  /**
   * play effect `id`; dx, dy = position relative to the view centre in view half-sizes
   * (0 = centre, 1 = edge)
   */
  play(id: number, dx: number, dy: number): void {
    if (id <= 0) return;
    const vol = this.volume();
    if (vol <= 0) return;
    const d = Math.hypot(dx, dy);
    if (d > 1.6) return;
    const now = performance.now();
    if (now - (this.lastPlay.get(id) ?? -1e9) < 120 || this.voices >= MAX_VOICES) return;
    const buf = this.load(id);
    const ctx = this.ctx;
    if (buf === undefined || (buf === null && this.waiting.has(id))) { this.waiting.set(id, { dx, dy, at: now }); return; }
    if (!buf || !ctx || ctx.state !== 'running') return;
    this.lastPlay.set(id, now);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const gain = ctx.createGain();
    gain.gain.value = vol * Math.max(0, 1 - d / 1.6) * 0.7;
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.max(-1, Math.min(1, dx));
    src.connect(gain).connect(pan).connect(ctx.destination);
    this.voices++;
    src.onended = () => { this.voices--; };
    src.start();
  }

  /** fetch and decode samples ahead of their first use */
  preload(ids: Iterable<number>): void { for (const id of ids) if (id > 0) this.load(id); }

  /** prepare (browsers allow audio only after a user gesture) */
  unlock(): void { this.context(); }
}
