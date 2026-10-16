#!/usr/bin/env python3
"""Headless check of the build menu: pick the school in the side panel, hover the map (ghost),
click to place it, fast-forward and screenshot. Usage: build_ui_test.py <base-url> <out-prefix>"""
import sys
from playwright.sync_api import sync_playwright

base, out = sys.argv[1:3]
with sync_playwright() as p:
    b = p.chromium.launch(args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
    pg = b.new_page(viewport={'width': 1280, 'height': 800})
    logs = []
    pg.on('console', lambda m: logs.append(f'{m.type}: {m.text}') if m.type in ('error', 'warning') else None)
    pg.on('pageerror', lambda e: logs.append(f'pageerror: {e}'))
    pg.goto(f'{base}/?c=pimmons&m=0&nobrief')
    pg.wait_for_function('window.anReady === true', timeout=120000)
    pg.wait_for_timeout(1000)
    # find the school row in the panel: ask the HUD for its buttons
    btn = pg.evaluate('''() => { const h = window.anGame.hud; const b = h.buttons.find(b => b.id === 'build:55');
        const r = document.getElementById('hud').getBoundingClientRect();
        return b && { x: r.left + (b.x + b.w / 2) * h.scale, y: r.top + (b.y + b.h / 2) * h.scale, all: h.buttons.map(b => b.id) }; }''')
    print('button', btn)
    pg.mouse.move(btn['x'], btn['y']); pg.wait_for_timeout(300)
    pg.mouse.click(btn['x'], btn['y']); pg.wait_for_timeout(1500)
    # a valid spot near the town hall, converted to css pixels
    spot = pg.evaluate('''() => {
        const g = window.anGame, w = g.world, me = g.player, dpr = window.devicePixelRatio || 1;
        const t = w.economy.towns.find(t => t.race === me), r = w.rules.get((me << 16) | 55);
        for (let rad = 3; rad < 10; rad++) for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== rad) continue;
          const x = t.x + dx, y = t.y + dy;
          if (!w.logistics.canPlace(t, r, x, y)) continue;
          const [sx, sy] = g.toScreen({ id: -1, x: x * 256 + 128, y: y * 256 + 128 }, 1);
          const c = g.cellAt(sx, sy);
          if (c[0] === x && c[1] === y) return { x: sx / dpr, y: sy / dpr, cell: [x, y] };
        }
        return null; }''')
    print('spot', spot)
    pg.mouse.move(spot['x'] - 40, spot['y'] - 40); pg.wait_for_timeout(200)
    pg.mouse.move(spot['x'], spot['y']); pg.wait_for_timeout(800)
    pg.screenshot(path=f'{out}-ghost.png')
    pg.mouse.click(spot['x'], spot['y']); pg.wait_for_timeout(500)
    print(pg.evaluate('''() => { const w = window.anGame.world; for (let i = 0; i < 250; i++) w.step();
        const s = w.entities.find(e => (e.oid & 0xffff) === 55); return s && [s.hp, s.complete, s.buildFrame]; }'''))
    pg.wait_for_timeout(1200)
    pg.screenshot(path=f'{out}-site.png')
    for l in logs: print(l)
    b.close()
