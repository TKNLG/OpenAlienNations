#!/usr/bin/env python3
"""Build the HD UI pack: upscaled versions of the menu art (mainmenu.gd) and the race side
panels (<race>/interface.gd) from an installed game (GOG and/or Gold Edition).

Methods (chosen from side-by-side comparisons):
  - menu screens, menu sprites and the large side-panel art: Real-ESRGAN realesr-animevideov3,
    x4, colour bled under transparent pixels, alpha through the model;
  - icons (side-panel sprites up to 64 px): xBR level 2 twice (x4), then a mild unsharp mask,
    which keeps their old-school look.
Everything is stored at 4x. The client draws it at the logical size of the original sprite.

Output (default ./hd):
  hd/manifest.json                     {"version":1,"scale":4,"items":{key: file}}
  hd/ui/<archive>/<entry>.f<frame>.<n>.webp   (n = the entry's data length, identifies the variant)
key = "<archive>|<entry>|<frame>|<data length>", archive = "mainmenu.gd", "<race dir lower>/interface.gd",
"dv.gd" or "addon.gd" (lower case, as the client keys them).
The data length tells the GOG and Gold variants of a sprite apart, so one pack serves both installs.

Usage: build_hdpack.py --game <Data folder> [--game <another Data folder>] [--out hd]
       [--onnx <dir with realesr-animevideov3.onnx>] [--only mainmenu|interface|portraits] [--limit N]
The model is converted from the official Real-ESRGAN release weights with esrgan_onnx.py; pass
--onnx to a folder that has realesr-animevideov3.onnx (downloaded on first use otherwise).
"""
import argparse, json, os, re, sys, time, urllib.request
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, '..'))
import upscale as U          # noqa: E402
from gd import GdArchive     # noqa: E402

MODEL = 'realesr-animevideov3'
MODEL_URL = 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesr-animevideov3.pth'
ICON_MAX = 64
SCALE = 4
# menu backgrounds the game draws fully opaque whatever their stored alpha (front-end.md 1.1)
OPAQUE = {'MAINMENU', 'RASSENWAHL', 'BRIEFINGSCREEN', 'LOADING'}
RACE_DIRS = ['amazons', 'pimons', 'sajiki']
# side-panel portraits in the world archives (dv.OD groups 3..5)
PORTRAIT = re.compile(r'^BI(AZ|PI|SA)\\MI\\')


def find(folder, rel):
    """case-insensitive path lookup inside the game's Data folder"""
    cur = folder
    for part in rel.split('/'):
        names = {n.lower(): n for n in os.listdir(cur)}
        if part.lower() not in names:
            return None
        cur = os.path.join(cur, names[part.lower()])
    return cur


def ensure_model(onnx_dir):
    path = os.path.join(onnx_dir, MODEL + '.onnx')
    if os.path.exists(path):
        return
    os.makedirs(onnx_dir, exist_ok=True)
    pth = os.path.join(onnx_dir, MODEL + '.pth')
    if not os.path.exists(pth):
        print('downloading', MODEL_URL)
        urllib.request.urlretrieve(MODEL_URL, pth)
    import esrgan_onnx as E
    sd = E.load_pth(pth)
    m, _ = E.build_srvgg(sd)
    open(path, 'wb').write(m)


def frames_of(arc, e):
    """all frames of an entry as RGBA arrays (incremental: gd frames build on each other)"""
    out = []
    for f in range(e['frames']):
        out.append(np.asarray(arc.decode(e, f).convert('RGBA')).copy())
    return out


def safe(name):
    return re.sub(r'[^A-Za-z0-9_.-]', '_', name.replace('\\', '/')).replace('/', '_')


def upscale_frame(rgba, icon):
    if icon:
        x4 = U.xbr2x(U.xbr2x(rgba))
        return U.unsharp(x4, 2.0, 0.5, 2)
    return U.neural(MODEL, rgba, 'bleed')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--game', action='append', required=True, help='a Data folder (repeat for GOG and Gold)')
    ap.add_argument('--out', default='hd')
    ap.add_argument('--onnx', default=os.path.join(os.path.expanduser('~'), '.cache', 'an-rebuild'))
    ap.add_argument('--only', choices=['mainmenu', 'interface', 'portraits'])
    ap.add_argument('--limit', type=int, default=0, help='at most N entries per archive (testing)')
    a = ap.parse_args()
    U.ONNX_DIR = a.onnx
    if a.only != 'portraits':   # the portraits use the icon method only
        ensure_model(a.onnx)
    man_path = os.path.join(a.out, 'manifest.json')
    manifest = {'version': 1, 'scale': SCALE, 'items': {}}
    if os.path.exists(man_path):
        manifest = json.load(open(man_path))
    items = manifest['items']
    t0 = time.time()
    done = 0
    for game in a.game:
        archives = []
        if a.only in (None, 'mainmenu'):
            archives.append(('mainmenu.gd', find(game, 'mainmenu.gd'), False))
        if a.only in (None, 'interface'):
            for d in RACE_DIRS:
                archives.append((f'{d}/interface.gd', find(game, f'{d}/interface.gd'), True))
        if a.only in (None, 'portraits'):
            archives.append(('dv.gd', find(game, 'dv.gd'), True))
            if find(game, 'addon.gd'):   # Gold Edition only
                archives.append(('addon.gd', find(game, 'addon.gd'), True))
        for key_arc, path, panel in archives:
            if not path:
                print('missing', key_arc, 'in', game)
                continue
            arc = GdArchive(path)
            # each entry's data length, as the client computes it (gd.ts: up to the next entry's data)
            srt = sorted(arc.entries, key=lambda x: x['data'])
            for i, x in enumerate(srt):
                x['dataLength'] = (srt[i + 1]['data'] if i + 1 < len(srt) else len(arc.d)) - x['data']
            entries = arc.entries
            if key_arc in ('dv.gd', 'addon.gd'):
                entries = [e for e in entries if PORTRAIT.match(e['name'])]
            entries = entries[:a.limit] if a.limit else entries
            for e in entries:
                l, t, r, b = e['rect']
                w, h = r - l, b - t
                if w <= 0 or h <= 0:
                    continue
                n = e['dataLength']
                icon = panel and max(w, h) <= ICON_MAX
                keys = [f"{key_arc}|{e['name']}|{f}|{n}" for f in range(e['frames'])]
                if all(k in items for k in keys):
                    continue
                try:
                    frames = frames_of(arc, e)
                except Exception as ex:   # undecodable entry: skip, the game uses the original
                    print('skip', key_arc, e['name'], ex)
                    continue
                for f, rgba in enumerate(frames):
                    if e['name'] in OPAQUE or rgba[..., 3].max() == 0:
                        rgba = rgba.copy(); rgba[..., 3] = 255
                    big = upscale_frame(rgba, icon)
                    assert big.shape[0] == h * SCALE and big.shape[1] == w * SCALE, (e['name'], big.shape)
                    rel = f"ui/{key_arc.replace('/interface.gd', '')}/{safe(e['name'])}.f{f}.{n}.webp"
                    dst = os.path.join(a.out, rel)
                    os.makedirs(os.path.dirname(dst), exist_ok=True)
                    im = Image.fromarray(big, 'RGBA')
                    if big[..., 3].min() == 255:
                        im.convert('RGB').save(dst, 'WEBP', quality=92, method=4)
                    else:
                        im.save(dst, 'WEBP', quality=92, alpha_quality=100, method=4)
                    items[keys[f]] = rel
                    done += 1
                json.dump(manifest, open(man_path, 'w'), indent=0, sort_keys=True)
                print(f"{time.time() - t0:7.1f}s {key_arc} {e['name']} x{e['frames']} {'icon' if icon else 'esrgan'}", flush=True)
    json.dump(manifest, open(man_path, 'w'), indent=0, sort_keys=True)
    print('frames written:', done, 'total items:', len(items))


if __name__ == '__main__':
    main()
