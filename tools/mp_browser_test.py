#!/usr/bin/env python3
"""Two headless browsers play one multiplayer game through the real lobby UI.
Usage: mp_browser_test.py <base-url> <campaign> <mission> <out-prefix>"""
import sys
from playwright.sync_api import sync_playwright

base, camp, miss, out = sys.argv[1:5]
ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
with sync_playwright() as p:
    br = p.chromium.launch(args=ARGS)
    logs = []
    pages = []
    for name in ('Anna', 'Bert'):
        pg = br.new_context(viewport={'width': 1100, 'height': 700}).new_page()
        pg.on('console', lambda m, n=name: logs.append(f'{n} {m.type}: {m.text}') if m.type in ('error', 'warning') else None)
        pg.on('pageerror', lambda e, n=name: logs.append(f'{n} pageerror: {e}'))
        pg.goto(f'{base}/?c={camp}&m={miss}&dev&nobrief')
        pg.wait_for_function('window.anReady === true', timeout=120000)
        pg.click('#mp'); pg.fill('#pname', name)
        pages.append(pg)
    a, b = pages
    a.click('#create')
    a.wait_for_timeout(500)
    b.click('#refresh'); b.wait_for_timeout(500)
    b.click('#rooms button')
    b.wait_for_timeout(500)
    a.click('#room button:has-text("Spiel starten")')
    for pg in pages:
        pg.wait_for_function("document.getElementById('status').textContent.startsWith('Mehrspieler')", timeout=120000)
    # each player orders its own units somewhere
    for i, pg in enumerate(pages):
        print(pg.evaluate('''(i) => { const g = window.anGame, w = g.world;
            const own = w.entities.filter(e => e.kind === 0 && e.owner === g.player);
            if (!own.length) return 'player ' + g.player + ' has no units';
            const u = own[0]; g.cam.x = u.x/256; g.cam.y = u.y/256;
            const n = g.debugOrderAll(Math.floor(u.x/256) + 6 - i*12, Math.floor(u.y/256) + 3);
            return 'player ' + g.player + ' ordered ' + n + ' units'; }''', i))
    a.wait_for_timeout(5000)
    states = [pg.evaluate('''() => { const w = window.anGame.world, ls = window.anGame.lockstep;
        return { tick: w.tick, desync: ls.desync, status: document.getElementById('status').textContent }; }''') for pg in pages]
    print(states)
    # compare hashes at a common tick: step the leader is not possible, so read the hash log
    t = min(s['tick'] for s in states)
    print('ticks', [s['tick'] for s in states], 'desync', [s['desync'] for s in states])
    a.screenshot(path=f'{out}-a.png'); b.screenshot(path=f'{out}-b.png')
    for l in logs: print(l)
    br.close()
