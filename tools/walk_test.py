#!/usr/bin/env python3
"""Headless check of unit movement: load a mission, order all own units to walk, screenshot
before and during the walk. Usage: walk_test.py <base-url> <campaign> <mission> <out-prefix>"""
import sys
from playwright.sync_api import sync_playwright

base, camp, miss, out = sys.argv[1:5]
with sync_playwright() as p:
    b = p.chromium.launch(args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
    pg = b.new_page(viewport={'width': 1280, 'height': 800})
    logs = []
    pg.on('console', lambda m: logs.append(f'{m.type}: {m.text}') if m.type in ('error', 'warning') else None)
    pg.on('pageerror', lambda e: logs.append(f'pageerror: {e}'))
    pg.goto(f'{base}/?c={camp}&m={miss}')
    pg.wait_for_function('window.anReady === true', timeout=120000)
    info = pg.evaluate('''() => {
        const g = window.anGame, w = g.world;
        const us = w.entities.filter(e => e.kind === 0 && e.owner === g.player);
        const u = us[0];
        // centre the camera on the first unit, target a few cells away
        g.cam.x = u.x / 256; g.cam.y = u.y / 256;
        const tx = Math.floor(u.x / 256) + 8, ty = Math.floor(u.y / 256) + 2;
        const n = g.debugOrderAll(tx, ty);
        return { n, from: [Math.floor(u.x/256), Math.floor(u.y/256)], to: [tx, ty], status: document.getElementById('status').textContent };
    }''')
    print(info)
    pg.wait_for_timeout(400)
    pg.screenshot(path=f'{out}-0.png')
    pg.wait_for_timeout(2500)
    pg.screenshot(path=f'{out}-1.png')
    state = pg.evaluate('''() => { const w = window.anGame.world;
        return { tick: w.tick, hash: w.hash(), walking: w.entities.filter(e => e.path).length,
                 u0: (() => { const u = w.entities.find(e => e.kind === 0 && e.owner === window.anGame.player); return [u.x/256, u.y/256, u.dir, u.action]; })() }; }''')
    print(state)
    for l in logs: print(l)
    b.close()
