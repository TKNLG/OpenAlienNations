// Stored options and campaign progress (docs/ui/front-end.md 3.9 "All options", 4.1, 5).
// Kept in localStorage (wrapped in try/catch: storage may be unavailable). The side-panel UI
// scale lives under its own key 'an.uiScale' (read by the side panel).

const KEY = 'an.settings';
export const UI_SCALE_KEY = 'an.uiScale';
export const UI_SCALES = [0, 1, 1.25, 1.5, 2, 3];

export interface Settings {
  alphaShadows: boolean;
  soundOn: boolean;
  /** 0..100 */
  effects: number;
  music: number;
  speech: number;
  eax: boolean;
  menuScroll: boolean;
  /** 0 off, 1 = 10 min, 2 = 20 min, 3 = 30 min */
  autosave: number;
  /** upscaled menu and side-panel art from the HD pack, when the server has one */
  hd: boolean;
  /** enhanced mode: draw a ring under selected objects (the original only tints them blue,
   * docs/rendering/objects.md 7.1) */
  selectionRings: boolean;
  /** enhanced mode: units glide at constant speed with time-based walk frames, instead of the
   * original's step drawing (jumps of more than 3/64 cell, walk frames by distance, a short stand
   * at every cell; docs/rendering/unit-motion.md 2) */
  smoothMovement: boolean;
  /** enhanced mode: the world-view cursor hints at the right-click order under the mouse (attack,
   * board, harvest, order). The original's cursor only follows the selection (docs/ui/cursors.md 4) */
  cursorHints: boolean;
  /** enhanced mode, "Advisor: queue lines": the advisor's voice player keeps a real pending queue
   * (each queued line plays when the previous voice ends) with a client-side 60 s repeat guard,
   * instead of the original's player that gives a queued line one frame and hears a burst as its
   * first line only (docs/ui/side-panel.md 1.1.2; client/advisor-voice.ts AdvisorQueue). Only the
   * playback differs: which lines the simulation says (120 s per-line cooldowns, arming, line 28
   * never, line 80 only at the end of a collapse) is the same in both modes */
  advisorQueue: boolean;
  /** enhanced mode, "Glattes Gelände": terrain tiles at full 8-bit colour with bilinear/mipmap
   * filtering, instead of the original's software renderer look (4-bit texels, nearest texel,
   * 5-6-5 truncation; docs/rendering/terrain-drawing.md "Brightness"). The brightness rule
   * (tile x g / 256, fog folded into the corners) is the same in both modes */
  smoothTerrain: boolean;
}

/** defaults of a new configuration (3.9; music = the GOG sample value) */
const DEFAULTS: Settings = { alphaShadows: true, soundOn: true, effects: 100, music: 67, speech: 100, eax: false, menuScroll: false, autosave: 1, hd: true, selectionRings: false, smoothMovement: false, cursorHints: false, advisorQueue: false, smoothTerrain: false };

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) as Partial<Settings> };
  } catch { /* storage unavailable or broken */ }
  return { ...DEFAULTS };
}

export function saveSettings(s: Settings): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage unavailable */ }
}

export function getUiScale(): number {
  try { const v = Number(localStorage.getItem(UI_SCALE_KEY) ?? 0); return UI_SCALES.includes(v) ? v : 0; } catch { return 0; }
}

export function setUiScale(v: number): void {
  try { localStorage.setItem(UI_SCALE_KEY, String(v)); } catch { /* storage unavailable */ }
  // the side panel re-reads the scale on resize
  window.dispatchEvent(new Event('resize'));
}

// ---------------------------------------------------------------- campaign progress (5)

/** default progress: campaigns 0 (first mission only), tutorials 4 (all five open) */
const progressDefault = (campaign: string) => (campaign === 'tutorials' ? 4 : 0);

/** highest mission index the player may choose in this campaign */
export function getProgress(campaign: string): number {
  try {
    const v = localStorage.getItem(`an.progress.${campaign}`);
    if (v !== null && Number.isFinite(Number(v))) return Math.max(progressDefault(campaign), Number(v));
  } catch { /* storage unavailable */ }
  return progressDefault(campaign);
}

/** winning mission i: progress = max(progress, i + 1) */
export function recordWin(campaign: string, index: number): void {
  const p = Math.max(getProgress(campaign), index + 1);
  try { localStorage.setItem(`an.progress.${campaign}`, String(p)); } catch { /* storage unavailable */ }
}
