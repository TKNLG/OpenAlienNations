// HD side-panel pictures rendered from the world sprites (pure logic and measurements:
// icon-fit.ts); unit portraits stay the player's own pictures. When HD art is on, a panel
// picture that is a shrunk world sprite gets an HD image rendered from that sprite at the panel's
// device resolution (at most 4x, never beyond the sprite's own resolution). It is linked like a
// pack image (ui-assets.ts), so every drawImage of the 45x45 canvas, and the tinted copies of
// side-panel.md 3.1, use it. Everything is derived from the player's own dv.gd at run time;
// nothing new is shipped.
//
// Levels (setting "HD-Grafik", docs/ui/side-panel.md "HD art"):
// - "partly": only pictures the measured placement reproduces (FITS, error check) are rendered;
//   the others (22 Sajiki buildings drawn from another camera, pictures of other data) stay
//   original;
// - "all": those too, at the placement that matches the original picture best (fitIcon: same
//   size and framing; a few look slightly different, being drawn from another camera);
// - in both, a picture whose original could not be loaded is generated from the world sprite;
// - "off": the originals.
// Unit portraits are separate small drawings: every level shows the player's own picture, smoothed.

import { hdEnabled, hdListeners, linkLooseHd, linkRenderedHd } from './ui-assets.ts';
import type { GameData } from './data.ts';
import {
  alphaBox, boxFit, composeLayers, fitIcon, hdFactor, iconSource, imageError, premultiply, renderHd, resampleArea, unpremultiply, worldSlot,
  DEFAULT_ICON_BOX, ICON_FIT_MAX_ERR, UI_ICON_SOURCES, type IconFit, type IconSource,
} from './icon-fit.ts';

interface Job {
  data: GameData; oid: number; icon: HTMLCanvasElement; scale: () => number;
  /** measured placement, if the picture is a shrunk world sprite */
  src?: IconSource;
  /** OD slot of the world object to render */
  slot: number;
  /** false: no placement check and no fallback (interface.gd tree / palm pictures) */
  building: boolean;
  /** the original could not be loaded: the canvas is empty */
  generated?: boolean;
}

const queued = new WeakSet<HTMLCanvasElement>();
const pending: Job[] = [];
let running = false;

hdListeners.add(() => {
  if (hdEnabled() && pending.length) void run();
});

/**
 * Give the panel portrait of a building or ship (race, type) (dv.OD group race + 3) an HD image
 * rendered from its world sprite. `deviceScale`: device pixels per panel pixel.
 */
export function requestHdPortrait(data: GameData, race: number, type: number, icon: HTMLCanvasElement, deviceScale: () => number): void {
  const src = iconSource(race, type);
  const slot = src?.slot ?? worldSlot(type);
  // unit portraits keep the player's own picture, drawn smoothed (the pack's xBR versions of these
  // small separate drawings looked worse); building and ship pictures are rendered from their world
  // sprites, never upscaled from the small picture (maintainer decisions 2026-11-23, side-panel.md 10)
  if (slot === undefined) return;
  enqueue({ data, oid: ((race << 16) | type) >>> 0, src, slot, icon, scale: deviceScale, building: true });
}

/**
 * A panel portrait whose original picture could not be loaded: an empty canvas of the panel size
 * that gets a picture generated from the world sprite while HD art is on (buildings and ships
 * only; undefined otherwise). With HD off the slot stays empty, as before.
 */
export function generatedPortrait(data: GameData, race: number, type: number, deviceScale: () => number): HTMLCanvasElement | undefined {
  const src = iconSource(race, type);
  const slot = src?.slot ?? worldSlot(type);
  if (slot === undefined) return undefined;
  const icon = document.createElement('canvas');
  icon.width = 45; icon.height = 45;
  enqueue({ data, oid: ((race << 16) | type) >>> 0, src, slot, icon, scale: deviceScale, building: true, generated: true });
  return icon;
}

/** the same for an interface.gd picture by sprite name (tree and palm pictures) */
export function requestHdUiIcon(data: GameData, name: string, icon: HTMLCanvasElement, deviceScale: () => number): void {
  const src = UI_ICON_SOURCES.find(u => u.name === name);
  if (src) enqueue({ data, oid: src.oid, src, slot: src.slot, icon, scale: deviceScale, building: false });
}

function enqueue(j: Job): void {
  if (queued.has(j.icon)) return;
  queued.add(j.icon);
  pending.push(j);
  if (hdEnabled()) void run();
}

async function run(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (pending.length && hdEnabled()) {
      const j = pending.shift()!;
      try { await build(j); } catch { /* sprite missing: the original stays */ }
    }
  } finally { running = false; }
}

async function build(j: Job): Promise<void> {
  const layers = j.data.objects.get(j.oid)?.layers[j.slot];
  if (!layers?.length) return;
  const arc = j.data.sprites;
  const entries = layers.map(l => arc.entry(l.name));
  if (entries.some(e => !e)) return;
  const want = entries.map((e, i) => Math.min(j.src?.frames?.[i] ?? 0, e!.frames - 1));
  const frames = await arc.framesMany(entries.map((e, i) => ({ e: e!, lastFrame: want[i] })));
  const pic = composeLayers(entries.map((e, i) => ({ left: e!.left, top: e!.top, w: e!.width, h: e!.height, rgba: frames.get(e!)![want[i]] })));
  const W = j.icon.width, H = j.icon.height;
  const orig = premultiply(j.icon.getContext('2d')!.getImageData(0, 0, W, H).data, W, H);
  const origBox = j.generated ? null : alphaBox(orig);
  // placement relative to the composed picture's corner
  const measured: IconFit | null = j.src ? { s: j.src.s, ox: j.src.ox + j.src.s * pic.left, oy: j.src.oy + j.src.s * pic.top, err: 0 } : null;
  const draw = (fit: IconFit) => {
    const hd = renderHd(pic.img, fit, W, H, hdFactor(j.scale(), fit.s));
    const c = document.createElement('canvas');
    c.width = hd.w; c.height = hd.h;
    c.getContext('2d')!.putImageData(new ImageData(unpremultiply(hd), hd.w, hd.h), 0, 0);
    return c;
  };
  if (measured && origBox && imageError(resampleArea(pic.img, measured.s, measured.ox, measured.oy, W, H), orig) <= ICON_FIT_MAX_ERR) {
    // an exact shrunk world sprite: both HD levels
    linkRenderedHd(j.icon, draw(measured));
  } else if (j.building) {
    const sb = alphaBox(pic.img);
    if (!sb) return;
    if (j.generated) {
      // no original: the measured placement, else the default box; both HD levels
      linkRenderedHd(j.icon, draw(measured ?? boxFit(DEFAULT_ICON_BOX, sb)));
    } else if (origBox) {
      // a separate render (other camera) or a picture of another edition: the placement that
      // matches the original picture best (size and framing), "all" only
      const best = fitIcon(orig, pic.img);
      linkLooseHd(j.icon, draw(Number.isFinite(best.err) ? best : boxFit(origBox, sb)));
    }
  }
  // let the event loop breathe between pictures
  await new Promise(r => setTimeout(r, 0));
}
