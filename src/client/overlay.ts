// Overlay on the world view: advisor/message lines top-left and the panel's tooltip at the
// bottom-right corner of the world view. Spec: docs/ui/side-panel.md 1 and 4.3.
//
// Advisor lines come from World.events (mentor ids, already filtered by the nation's per-line
// intervals in the simulation). The voice player (advisor-voice.ts, side-panel.md 1.1.2) decides
// what is heard: each line that plays is shown for 5 s with its voice (Data/SOUND/mentor/NNN.wav);
// lines arriving while a voice plays are lost after one frame at most. The enhanced setting
// "Advisor: queue lines" (advisorQueue) swaps in AdvisorQueue: queued lines play one after another.

import type { World } from '../engine/world.ts';
import type { BitmapFont, FontName } from './ui-assets.ts';
import { Hud } from './hud.ts';
import { loadSettings } from './frontend/settings.ts';
import { AdvisorVoice, AdvisorQueue, type AdvisorPlayer, type AdvisorQueueIo } from './advisor-voice.ts';

const LINE_MS = 5000;

export class Overlay {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private hud: Hud;
  private fonts: Map<FontName, BitmapFont> | null = null;
  private mentor = new Map<number, string>();
  private lines: { text: string; until: number }[] = [];
  private advisorIo: AdvisorQueueIo<HTMLAudioElement>;
  private advisor: AdvisorPlayer;
  /** the advisor player in use is the enhanced queue (settings advisorQueue) */
  private queueMode = false;
  private lastKey = '';
  /** client-side advisor lines of this frame (the info page's line 12), spoken after the sim's */
  private client: number[] = [];
  volume = 1;

  constructor(canvas: HTMLCanvasElement, hud: Hud) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.hud = hud;
    this.advisorIo = {
      speechOn: () => this.volume > 0,
      start: id => this.startVoice(id),
      playing: v => !v.ended && !v.paused && !v.error,
      text: id => { const text = this.mentor.get(id); if (text) this.say(text); },
      now: () => performance.now(),
      onEnd: (v, done) => { v.onended = v.onerror = () => done(); },
    };
    this.advisor = new AdvisorVoice<HTMLAudioElement>(this.advisorIo);
  }

  setAssets(fonts: Map<FontName, BitmapFont>, mentor: Map<number, string>): void { this.fonts = fonts; this.mentor = mentor; }

  /**
   * A client-side advisor line, unqueued (side-panel.md 1.1.5: the info page's line 12). Spoken in
   * the next draw after the simulation's lines of that frame, as the original's page refresh comes
   * after the tick's advisor messages; dropped like any unqueued line while a voice plays.
   */
  advise(line: number): void { this.client.push(line); }

  /** a plain message line (chat, notices) */
  say(text: string): void { this.lines.push({ text, until: performance.now() + LINE_MS }); }

  private startVoice(id: number): HTMLAudioElement | null {
    try {
      const v = new Audio(`/game/Data/SOUND/mentor/${String(id).padStart(3, '0')}.wav`);
      v.volume = this.volume;
      void v.play().catch(() => { /* paused stays true: released at the next frame */ });
      return v;
    } catch { return null; }
  }

  draw(w: World, player: number, placing: boolean, hint = ''): void {
    const evs = w.events.splice(0).filter(ev => ev.race === player);
    const client = this.client.splice(0);
    if (evs.length || client.length || this.advisor.queued) {
      const st = loadSettings();
      this.volume = st.soundOn ? st.speech / 100 : 0;   // speech slider (front-end.md: sound category 2)
      // switch the player only while it is idle, so two voices never overlap
      if (st.advisorQueue !== this.queueMode && !this.advisor.busy && !this.advisor.queued) {
        this.queueMode = st.advisorQueue;
        this.advisor = this.queueMode ? new AdvisorQueue(this.advisorIo) : new AdvisorVoice(this.advisorIo);
      }
    }
    for (const ev of evs) this.advisor.speak(ev.mentor, ev.queue !== false);
    for (const id of client) this.advisor.speak(id, false);
    this.advisor.frame();   // the per-frame step (side-panel.md 1.1.2; the queue's fallback)
    const now = performance.now();
    this.lines = this.lines.filter(l => l.until > now);
    const tip = this.hud.tooltip || hint || (placing ? 'Linksklick: Bauplatz wählen · Rechtsklick/Esc: abbrechen' : '');
    const key = this.lines.map(l => l.text).join('|') + '#' + tip + '#' + this.canvas.clientWidth + 'x' + this.canvas.clientHeight + '@' + this.hud.scale;
    if (key === this.lastKey || !this.fonts) return;
    this.lastKey = key;
    const dpr = window.devicePixelRatio || 1;
    const cw = Math.round(this.canvas.clientWidth * dpr), ch = Math.round(this.canvas.clientHeight * dpr);
    if (this.canvas.width !== cw || this.canvas.height !== ch) { this.canvas.width = cw; this.canvas.height = ch; }
    const ctx = this.ctx, s = this.hud.scale * dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    ctx.setTransform(s, 0, 0, s, 0, 0);
    ctx.imageSmoothingEnabled = !(this.hud.constructor as typeof Hud).crisp;
    const W = cw / s, H = ch / s;
    const small = this.fonts.get('dv7pts2')!;
    this.lines.slice(-12).forEach((l, i) => small.draw(ctx, l.text, 20, 12 + 20 * i, '#ffffff', '#000000'));
    if (tip) {
      const f = this.fonts.get('dv10pt')!;
      const tw = f.measure(tip) + 5;
      f.draw(ctx, tip, W - tw, H - f.height - 4, '#000000');
      f.draw(ctx, tip, W - tw, H - f.height - 6, '#ffffff');
    }
  }
}
