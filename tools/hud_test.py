#!/usr/bin/env python3
"""Headless HUD check: load a mission, close the briefing, click the player's town hall and
screenshot. Usage: hud_test.py <base-url> <campaign> <mission> <out.png> [width height]"""
import sys
from playwright.sync_api import sync_playwright

base, camp, miss, out = sys.argv[1:5]
W, H = (int(sys.argv[5]), int(sys.argv[6])) if len(sys.argv) > 6 else (1280, 800)
with sync_playwright() as p:
    b = p.chromium.launch(args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
    pg = b.new_page(viewport={'width': W, 'height': H})
    logs = []
    pg.on('console', lambda m: logs.append(f'{m.type}: {m.text}') if m.type in ('error', 'warning') else None)
    pg.on('pageerror', lambda e: logs.append(f'pageerror: {e}'))
    pg.on('response', lambda r: logs.append(f'HTTP {r.status} {r.url}') if r.status >= 400 else None)
    pg.goto(f'{base}/?c={camp}&m={miss}&nobrief')
    pg.wait_for_function('window.anReady === true', timeout=120000)
    pg.wait_for_timeout(800)
    # click the centre of the view: the camera starts on the player's first building
    vw = pg.evaluate("document.getElementById('view').clientWidth")
    pg.mouse.click(vw / 2, H / 2 - 30)
    pg.wait_for_timeout(500)
    print(pg.evaluate("(() => { const g = window.anGame; return [...g.selected].map(id => { const e = g.world.get(id); return [e.kind, e.oid, g.data.rules.get(e.oid)?.name]; }); })()"))
    pg.screenshot(path=out)
    for l in logs: print(l)
    b.close()
