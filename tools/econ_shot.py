#!/usr/bin/env python3
"""Headless check of the town economy: load a mission, place a school next to the town hall,
fast-forward the simulation and take screenshots of the site under construction and finished.
Usage: econ_shot.py <base-url> <campaign> <mission> <out-prefix>"""
import sys
from playwright.sync_api import sync_playwright

base, camp, miss, out = sys.argv[1:5]
with sync_playwright() as p:
    b = p.chromium.launch(args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
    pg = b.new_page(viewport={'width': 1280, 'height': 800})
    logs = []
    pg.on('console', lambda m: logs.append(f'{m.type}: {m.text}') if m.type in ('error', 'warning') else None)
    pg.on('pageerror', lambda e: logs.append(f'pageerror: {e}'))
    pg.goto(f'{base}/?c={camp}&m={miss}&nobrief')
    pg.wait_for_function('window.anReady === true', timeout=120000)
    info = pg.evaluate('''() => {
        const g = window.anGame, w = g.world, me = g.player;
        const t = w.economy.towns.find(x => x.race === me);
        const r = w.rules.get((me << 16) | 55);
        let spot = null;
        for (let rad = 3; rad < 12 && !spot; rad++) for (let dy = -rad; dy <= rad && !spot; dy++) for (let dx = -rad; dx <= rad && !spot; dx++)
          if (Math.max(Math.abs(dx), Math.abs(dy)) === rad && w.logistics.canPlace(t, r, t.x + dx, t.y + dy)) spot = [t.x + dx, t.y + dy];
        g.command({ type: 'build', player: me, town: t.id, building: 55, x: spot[0], y: spot[1] });
        g.cam.x = (t.x + spot[0]) / 2; g.cam.y = (t.y + spot[1]) / 2;
        return { spot, town: [t.x, t.y] };
    }''')
    print(info)
    def advance(n):
        return pg.evaluate(f'''() => {{ const w = window.anGame.world; for (let i = 0; i < {n}; i++) w.step();
            const s = w.entities.find(e => (e.oid & 0xffff) === 55);
            return {{ tick: w.tick, site: s && [s.hp, s.complete, s.buildFrame, s.needed.length], busy: w.entities.filter(e => e.job).length }}; }}''')
    print(advance(180)); pg.wait_for_timeout(1500); pg.screenshot(path=f'{out}-0.png')
    print(advance(150)); pg.wait_for_timeout(1500); pg.screenshot(path=f'{out}-1.png')
    print(advance(600)); pg.wait_for_timeout(1500); pg.screenshot(path=f'{out}-2.png')
    for l in logs: print(l)
    b.close()
