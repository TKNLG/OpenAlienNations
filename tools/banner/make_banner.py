#!/usr/bin/env python3
"""README banners (docs/images/banner-en.png, banner-de.png), 1280x360.

1. Background: a screenshot of the running remake (dev mode `?c=..&m=..`), Pimmon campaign
   mission 5 "Bargeld lacht" after ~2.5 minutes of game time, side panel and overlays cropped
   out. It shows the original game's artwork as drawn by the remake, so like `hd/` it belongs to
   the original rights holders and is not GPL.
2. Lettering: tools/banner/banner.html (Inter Display, installed locally) over the background,
   rendered in headless Chromium.
3. Quantized to a palette PNG when the full-colour file is over the size budget.

Needs Python Playwright with Chromium and Pillow; nothing is added to the project.
Usage (server running, e.g. `node dist/server.mjs --game <folder> --host 127.0.0.1 --port 8080 --no-browser`):
  python3 tools/banner/make_banner.py --url http://127.0.0.1:8080
  python3 tools/banner/make_banner.py --bg out/banner-bg.png     # re-letter an existing background
"""
import argparse, io, json, os, pathlib, sys
from playwright.sync_api import sync_playwright
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parents[2]
HERE = pathlib.Path(__file__).resolve().parent
W, H = 1280, 360
GL = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']

# the scene: campaign, mission index, simulation ticks (100 ms each), camera offset from the
# player's first town (cells), and where the 1280x360 crop sits in a 2400x1000 viewport
SCENE = dict(campaign='pimmons', mission=4, ticks=1500, dx=0, dy=0, zoom=0.85, clip=(268, 290))


def capture(browser, url: str, out: pathlib.Path) -> None:
    s = SCENE
    pg = browser.new_page(viewport={'width': 2400, 'height': 1000})
    pg.goto(f"{url}/?c={s['campaign']}&m={s['mission']}&nobrief")
    pg.wait_for_function('window.anReady === true', timeout=180000)
    # status line, help line, advisor messages: not part of the picture
    pg.add_style_tag(content='#help,#overlay,#fps,#status,#bar{display:none!important}')
    info = pg.evaluate(f'''() => {{
      const g = window.anGame, w = g.world;
      for (let i = 0; i < {s['ticks']}; i++) w.step();
      const t = w.economy.towns.find(t => t.race === g.player);
      g.cam.x = t.x + {s['dx']}; g.cam.y = t.y + {s['dy']}; g.cam.zoom = {s['zoom']};
      const v = document.getElementById('view').getBoundingClientRect();
      return {{ tick: w.tick, town: [t.x, t.y], viewWidth: v.width }};
    }}''')
    print('scene', json.dumps(info))
    x, y = s['clip']
    assert x + W <= info['viewWidth'], 'crop reaches into the side panel'
    pg.wait_for_timeout(3000)   # let the frame, fog and animations settle
    pg.screenshot(path=str(out), clip={'x': x, 'y': y, 'width': W, 'height': H})
    pg.close()


def letter(browser, bg: pathlib.Path, lang: str) -> bytes:
    pg = browser.new_page(viewport={'width': W, 'height': H})
    pg.goto(f"{(HERE / 'banner.html').as_uri()}?lang={lang}&bg={bg.resolve().as_uri()}")
    pg.wait_for_function('document.fonts.status === "loaded"')
    pg.wait_for_timeout(300)
    fonts = pg.evaluate('''() => ['900 68px "Banner Display"', '500 23px "Banner Text"'].map(f => document.fonts.check(f))''')
    if not all(fonts): sys.exit('Inter Display is not installed (needs Inter Display Black and Medium)')
    png = pg.locator('#banner').screenshot()
    pg.close()
    return png


def save(png: bytes, out: pathlib.Path, budget: int) -> None:
    im = Image.open(io.BytesIO(png)).convert('RGB')
    buf = io.BytesIO(); im.save(buf, 'PNG', optimize=True)
    if buf.tell() > budget:
        buf = io.BytesIO()
        im.quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.FLOYDSTEINBERG).save(buf, 'PNG', optimize=True)
    out.write_bytes(buf.getvalue())
    print(out.relative_to(ROOT), f'{im.width}x{im.height}', f'{buf.tell() // 1024} KB')


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--url', help='running OpenAlienNations server, e.g. http://127.0.0.1:8080')
    ap.add_argument('--bg', default=str(ROOT / 'out' / 'banner-bg.png'), help='background screenshot (written with --url, read otherwise)')
    ap.add_argument('--out', default=str(ROOT / 'docs' / 'images'))
    ap.add_argument('--budget', type=int, default=600 * 1024, help='bytes per PNG before it is quantized')
    a = ap.parse_args()
    bg, outdir = pathlib.Path(a.bg), pathlib.Path(a.out)
    with sync_playwright() as p:
        b = p.chromium.launch(args=GL)
        if a.url:
            bg.parent.mkdir(parents=True, exist_ok=True)
            capture(b, a.url.rstrip('/'), bg)
        elif not bg.exists():
            sys.exit(f'no background at {bg}: pass --url to capture one')
        outdir.mkdir(parents=True, exist_ok=True)
        for lang in ('en', 'de'):
            save(letter(b, bg, lang), outdir / f'banner-{lang}.png', a.budget)
        b.close()


if __name__ == '__main__':
    main()
