// Button and picture looks of the side panel (docs/ui/side-panel.md 3.1).
//
// A tinted look mixes every sprite pixel 50:50 with one fixed tint colour and keeps the sprite's
// alpha, so drawing the tinted copy with normal alpha blending gives the original's result
// (background + (mixed - background) x alpha). Pure functions: no DOM, usable in tests.

/** normal, hover (mouse over a clickable button), dim (disabled or the 0x20 look), off (0x10) */
export type Tint = 'normal' | 'hover' | 'dim' | 'off';

/** the tint colour of each look (3.1 table) */
export const TINT_COLOUR: Readonly<Record<Exclude<Tint, 'normal'>, readonly [number, number, number]>> = {
  hover: [150, 150, 255],
  dim: [0, 0, 0],
  off: [128, 0, 0],
};

/** one channel of a tinted pixel: floor(s / 2) + floor(t / 2) */
export function mixChannel(s: number, t: number): number {
  return (s >> 1) + (t >> 1);
}

/** tint RGBA pixels in place (alpha untouched) */
export function tintRgba(px: Uint8ClampedArray | Uint8Array, t: Tint): void {
  if (t === 'normal') return;
  const [r, g, b] = TINT_COLOUR[t];
  const hr = r >> 1, hg = g >> 1, hb = b >> 1;
  for (let i = 0; i < px.length; i += 4) {
    px[i] = (px[i] >> 1) + hr;
    px[i + 1] = (px[i + 1] >> 1) + hg;
    px[i + 2] = (px[i + 2] >> 1) + hb;
  }
}

/** the flags that choose a look (3.1): disabled = 0x08 + 0x20, dark = 0x20 alone, off = 0x10;
 *  picture = a picture widget, whose hover look is switched off */
export interface LookFlags { disabled?: boolean; dark?: boolean; off?: boolean; picture?: boolean }

/**
 * The look of a widget (3.1): hover first (only for widgets with the hover look that take clicks:
 * a disabled button never gets the hover bit, a picture never shows it), then dim (0x08 or 0x20),
 * then off (0x10).
 */
export function lookOf(b: LookFlags, hover: boolean): Tint {
  if (hover && !b.disabled && !b.picture) return 'hover';
  if (b.disabled || b.dark) return 'dim';
  return b.off ? 'off' : 'normal';
}
