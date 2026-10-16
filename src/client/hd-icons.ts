// HD side-panel pictures rendered from the world sprites (pure logic and measurements:
// icon-fit.ts); the other portraits take the HD pack's upscaled image. When HD art is on, a panel picture that is a shrunk world sprite gets an HD image
// rendered from that sprite at the panel's device resolution (at most 4x, never beyond the
// sprite's own resolution). It is linked like a pack image (ui-assets.ts), so every drawImage of
// the 45x45 canvas, and the tinted copies of side-panel.md 3.1, use it. Everything is derived
// from the player's own dv.gd at run time; nothing new is shipped. HD off: the originals.

import { hdEnabled, hdListeners, linkRenderedHd, requestPackHd } from './ui-assets.ts';
import type { GameData } from './data.ts';
import { composeLayers, hdFactor, iconSource, imageError, premultiply, renderHd, resampleArea, unpremultiply, ICON_FIT_MAX_ERR, UI_ICON_SOURCES, type IconSource } from './icon-fit.ts';

interface Job { data: GameData; oid: number; src: IconSource; icon: HTMLCanvasElement; scale: () => number; }

const queued = new WeakSet<HTMLCanvasElement>();
const pending: Job[] = [];
let running = false;

hdListeners.add(() => {
  if (!hdEnabled()) return;
  for (const go of packPending.splice(0)) go();
  if (pending.length) void run();
});

/** pack images still to request (asked for while HD was off) */
const packPending: (() => void)[] = [];

/**
 * Give the panel portrait of object type (race, type) (dv.OD group race + 3) an HD image: rendered
 * from the world sprite if it is a shrunk one, else (and until then) the pack's upscaled portrait
 * (tools/hdpack, archives "dv.gd" / "addon.gd"). `deviceScale`: device pixels per panel pixel.
 */
export function requestHdPortrait(data: GameData, race: number, type: number, icon: HTMLCanvasElement, deviceScale: () => number): void {
  const name = data.objects.get((((race + 3) << 16) | type) >>> 0)?.slots.find(s => s);
  const arc = data.sprites;
  const e = name ? arc.entry(name) : undefined;
  if (name && e) {
    // the archive that holds the entry: dv.gd, or Addon.gd for the add-on's portraits
    const archive = arc.index.byName.get(name) === e ? arc.path : arc.fallback?.path ?? arc.path;
    const key = archive.toLowerCase().replace(/^.*\//, '');
    const go = () => requestPackHd(icon, key, name, 0, e.dataLength, Math.max(1, Math.min(4, deviceScale())));
    if (hdEnabled()) go(); else packPending.push(go);
  }
  const src = iconSource(race, type);
  if (src) enqueue({ data, oid: ((race << 16) | type) >>> 0, src, icon, scale: deviceScale });
}

/** the same for an interface.gd picture by sprite name (tree and palm pictures) */
export function requestHdUiIcon(data: GameData, name: string, icon: HTMLCanvasElement, deviceScale: () => number): void {
  const src = UI_ICON_SOURCES.find(u => u.name === name);
  if (src) enqueue({ data, oid: src.oid, src, icon, scale: deviceScale });
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
  const layers = j.data.objects.get(j.oid)?.layers[j.src.slot];
  if (!layers?.length) return;
  const arc = j.data.sprites;
  const entries = layers.map(l => arc.entry(l.name));
  if (entries.some(e => !e)) return;
  const want = entries.map((e, i) => Math.min(j.src.frames?.[i] ?? 0, e!.frames - 1));
  const frames = await arc.framesMany(entries.map((e, i) => ({ e: e!, lastFrame: want[i] })));
  const pic = composeLayers(entries.map((e, i) => ({ left: e!.left, top: e!.top, w: e!.width, h: e!.height, rgba: frames.get(e!)![want[i]] })));
  const { s } = j.src;
  // placement relative to the composed picture's corner
  const fit = { s, ox: j.src.ox + s * pic.left, oy: j.src.oy + s * pic.top, err: 0 };
  // check against the original picture: other data files must not get a wrong picture
  const W = j.icon.width, H = j.icon.height;
  const orig = premultiply(j.icon.getContext('2d')!.getImageData(0, 0, W, H).data, W, H);
  if (imageError(resampleArea(pic.img, s, fit.ox, fit.oy, W, H), orig) > ICON_FIT_MAX_ERR) return;
  const hd = renderHd(pic.img, fit, W, H, hdFactor(j.scale(), s));
  const c = document.createElement('canvas');
  c.width = hd.w; c.height = hd.h;
  c.getContext('2d')!.putImageData(new ImageData(unpremultiply(hd), hd.w, hd.h), 0, 0);
  linkRenderedHd(j.icon, c);
  // let the event loop breathe between pictures
  await new Promise(r => setTimeout(r, 0));
}
