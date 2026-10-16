#!/usr/bin/env python3
"""Headless combat check: two small armies fight next to the player's town; screenshots mid-battle.
Usage: battle_shot.py <base-url> <out-prefix>"""
import sys
from playwright.sync_api import sync_playwright

base, out = sys.argv[1:3]
with sync_playwright() as p:
    b = p.chromium.launch(args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
    pg = b.new_page(viewport={'width': 1280, 'height': 800})
    logs = []
    pg.on('pageerror', lambda e: logs.append(f'pageerror: {e}'))
    pg.goto(f'{base}/?c=pimmons&m=7&nobrief')
    pg.wait_for_function('window.anReady === true', timeout=120000)
    print(pg.evaluate('''() => {
        const g = window.anGame, w = g.world, me = g.player;
        const enemy = [0, 1, 2].find(r => r !== me && w.economy.players[r]);
        const t = w.economy.towns.find(x => x.race === me);
        const x = t.x + 10, y = t.y + 8;
        const mine = [], theirs = [];
        for (let k = 0; k < 4; k++) mine.push(w.spawnUnit(me, k < 2 ? 29 : 30, x, y + k, t.id));
        for (let k = 0; k < 4; k++) theirs.push(w.spawnUnit(enemy, k < 2 ? 31 : 29, x + 7, y + k, -1));
        for (const u of mine) g.command({ type: 'order', player: me, ids: [u.id], target: theirs[mine.indexOf(u)].id });
        g.cam.x = x + 4; g.cam.y = y + 2; g.cam.zoom = 1.4;
        window.__armies = { mine: mine.map(u => u.id), theirs: theirs.map(u => u.id) };
        return { me, enemy };
    }'''))
    for k in range(3):
        pg.wait_for_timeout(2500)
        pg.screenshot(path=f'{out}-{k}.png')
        print(pg.evaluate('''() => { const w = window.anGame.world; const a = window.__armies;
            const st = ids => ids.map(id => { const e = w.get(id); return e ? e.hp : 'X'; });
            return { tick: w.tick, mine: st(a.mine), theirs: st(a.theirs) }; }'''))
    for l in logs: print(l)
    b.close()
