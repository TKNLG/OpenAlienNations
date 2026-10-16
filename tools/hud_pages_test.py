#!/usr/bin/env python3
"""Screenshots of side-panel pages: town hall info, unit info, finances, needs, stock.
Usage: hud_pages_test.py <base-url> <out-prefix>"""
import sys
from playwright.sync_api import sync_playwright

base, out = sys.argv[1:3]
with sync_playwright() as p:
    b = p.chromium.launch(args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
    pg = b.new_page(viewport={'width': 1280, 'height': 800})
    logs = []
    pg.on('pageerror', lambda e: logs.append(f'pageerror: {e}'))
    pg.goto(f'{base}/?c=pimmons&m=0&nobrief')
    pg.wait_for_function('window.anReady === true', timeout=120000)
    pg.evaluate('() => { const w = window.anGame.world; for (let i = 0; i < 400; i++) w.step(); }')
    def shot(name, js):
        pg.evaluate(js); pg.wait_for_timeout(900)
        crop = pg.evaluate("(() => { const r = document.getElementById('hud').getBoundingClientRect(); return {x: r.left, y: 0, width: r.width, height: r.height}; })()")
        pg.screenshot(path=f'{out}-{name}.png', clip=crop)
    hall = "window.anGame.world.entities.find(e => (e.oid & 0xffff) === 40 && e.owner === window.anGame.player)"
    porter = "window.anGame.world.entities.find(e => (e.oid & 0xffff) === 9 && e.owner === window.anGame.player && e.inside < 0)"
    shot('hall', f"() => {{ const g = window.anGame; g.select([{hall}.id]); g.hud.showPage(0, g.selection); }}")
    shot('unit', f"() => {{ const g = window.anGame; g.select([{porter}.id]); g.hud.showPage(0, g.selection); }}")
    shot('finance', "() => { const g = window.anGame; g.select([]); g.hud.showPage(1, []); }")
    shot('needs', "() => { const g = window.anGame; g.hud.showPage(7, []); }")
    shot('stock', "() => { const g = window.anGame; g.hud.showPage(5, []); }")
    shot('people', "() => { const g = window.anGame; g.hud.showPage(6, []); }")
    for l in logs: print(l)
    b.close()
