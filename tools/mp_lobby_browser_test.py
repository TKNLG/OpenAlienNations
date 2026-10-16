#!/usr/bin/env python3
"""Two headless browsers go through the original-style multiplayer menus (docs/ui/front-end.md
3.13): Anna creates a password-protected session (add-on toggle optional), Bert fails with a wrong
password and joins with the right one, both pick a race, the host sets the third race to
"Computer" and starts; both play for a while; state hashes must agree.
Usage: mp_lobby_browser_test.py <base-url> <out-prefix> [seconds] [addon]"""
import sys
from playwright.sync_api import sync_playwright

base, out = sys.argv[1:3]
SECONDS = int(sys.argv[3]) if len(sys.argv) > 3 else 60
ADDON = len(sys.argv) > 4 and sys.argv[4] == 'addon'
ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']

# client coordinates of a front-end widget (topmost interactive widget at that point)
FIND = '''([kind, key]) => {
  const fe = window.anMenu.fe, ws = (fe.box ?? fe.current).widgets;
  const match = w => kind === 'text' ? w.text === key : kind === 'name' ? w.name === key : kind === 'list' ? w.lines !== undefined && w.onPick : kind === 'edit' ? w.maxLen !== undefined : false;
  const w = ws.find(match);
  if (!w) return null;
  const top = (x, y) => { for (let i = ws.length - 1; i >= 0; i--) if (ws[i].interactive && ws[i].hit(x, y)) return ws[i]; return null; };
  const c = document.querySelector('#frontend canvas').getBoundingClientRect(), s = c.width / 800;
  const at = (x, y) => ({ x: c.left + (x + 0.5) * s, y: c.top + (y + 0.5) * s });
  const r = w.rect;
  if (kind === 'list') return at(r.x1 + 30, r.y1 + (key - w.top) * w.lineH + Math.floor(w.lineH / 2));
  const cx = (r.x1 + r.x2) >> 1, cy = (r.y1 + r.y2) >> 1;
  if (top(cx, cy) === w) return at(cx, cy);
  for (let y = r.y1; y <= r.y2; y += 3) for (let x = r.x1; x <= r.x2; x += 3) if (top(x, y) === w) return at(x, y);
  return null;
}'''


def click(pg, kind, key, wait=400):
    pt = None
    for _ in range(50):
        pt = pg.evaluate(FIND, [kind, key])
        if pt: break
        pg.wait_for_timeout(100)
    if not pt:
        raise RuntimeError(f'widget {kind} {key!r} not found; screen: ' + str(texts(pg)))
    pg.mouse.move(pt['x'], pt['y']); pg.wait_for_timeout(60)
    pg.mouse.click(pt['x'], pt['y']); pg.wait_for_timeout(wait)


def texts(pg):
    return pg.evaluate('''() => { const fe = window.anMenu.fe, s = fe.box ?? fe.current;
        return s ? s.widgets.map(w => w.text ?? w.name ?? (w.lines ? '[list:' + w.lines.map(l => l.text).join(' | ') + ']' : w.constructor.name)) : null; }''')


def menu_shot(pg, path):
    # the menu canvas only (letterboxed 800 x 600 art)
    pg.screenshot(path=path)


with sync_playwright() as p:
    br = p.chromium.launch(args=ARGS)
    logs = []
    pages = []
    for name in ('Anna', 'Bert'):
        pg = br.new_context(viewport={'width': 1000, 'height': 750}).new_page()
        pg.on('console', lambda m, n=name: logs.append(f'{n} {m.type}: {m.text}') if m.type in ('error', 'warning') and 'Failed to load resource' not in m.text else None)
        pg.on('pageerror', lambda e, n=name: logs.append(f'{n} pageerror: {e}'))
        pg.on('response', lambda r, n=name: logs.append(f'{n} {r.status}: {r.url}') if r.status >= 400 else None)
        pg.goto(f'{base}/')
        pg.wait_for_function('window.anMenu && window.anMenu.fe.current', timeout=120000)
        pg.wait_for_timeout(500)
        click(pg, 'text', 'Mehrspielermodus')
        pg.keyboard.type(name); pg.keyboard.press('Enter'); pg.wait_for_timeout(800)
        pages.append(pg)
    a, b = pages

    # Anna: new session, world parameters (add-on), password
    click(a, 'text', 'Neu')
    if ADDON:
        click(a, 'text', 'Weltparameter')
        click(a, 'text', 'Nein')  # the "Addon:" toggle
        menu_shot(a, f'{out}-worldparams.png')
        click(a, 'text', 'Zurück')
    menu_shot(a, f'{out}-newsession.png')
    click(a, 'text', 'Weiter')
    a.keyboard.type('geheim'); a.wait_for_timeout(300)
    menu_shot(a, f'{out}-password-create.png')
    a.keyboard.press('Enter'); a.wait_for_timeout(800)
    print('Anna after create:', texts(a))
    # Anna picks the Sajiki; the chat lobby opens on the server's confirmation
    click(a, 'name', 'SA_B', 1000)
    print('Anna lobby:', texts(a))

    # Bert: session list, wrong password, then the right one
    click(b, 'text', 'Suchen', 800)
    print('Bert sessions:', texts(b))
    menu_shot(b, f'{out}-sessions.png')
    click(b, 'list', 0)
    b.keyboard.type('falsch'); b.keyboard.press('Enter'); b.wait_for_timeout(800)
    print('Bert wrong password:', texts(b))
    menu_shot(b, f'{out}-password-wrong.png')
    click(b, 'text', 'OK')
    b.keyboard.press('Control+A'); b.keyboard.press('Backspace')
    b.evaluate('() => { const fe = window.anMenu.fe; const e = fe.current.widgets.find(w => w.maxLen !== undefined); e.value = ""; }')
    b.keyboard.type('geheim'); b.keyboard.press('Enter'); b.wait_for_timeout(1000)
    print('Bert after join:', texts(b))
    menu_shot(b, f'{out}-race.png')
    click(b, 'name', 'AZ', 1000)

    # host: the free race (Pimmons) plays as a computer
    print('Anna lobby before computer:', texts(a))
    menu_shot(a, f'{out}-lobby-before.png')
    click(a, 'text', 'Leer', 800)
    a.keyboard.type('Hallo Bert!'); a.keyboard.press('Enter'); a.wait_for_timeout(600)
    menu_shot(a, f'{out}-lobby-host.png')
    menu_shot(b, f'{out}-lobby-guest.png')
    print('Anna lobby:', texts(a))
    print('Bert lobby:', texts(b))
    click(a, 'text', 'Spiel starten', 500)

    for pg in pages:
        pg.wait_for_function("window.anGame && window.anGame.world && window.anGame.multiplayer", timeout=180000)
    print('started')
    for i, pg in enumerate(pages):
        print(pg.evaluate('''(i) => { const g = window.anGame, w = g.world;
            const own = w.entities.filter(e => e.kind === 0 && (e.oid >>> 16) === g.player);
            const races = [0, 1, 2].map(r => w.entities.filter(e => e.alive && e.kind !== 2 && (e.oid >>> 16) === r).length);
            if (!own.length) return 'player ' + g.player + ' has no units';
            const u = own[0];
            const n = g.debugOrderAll(Math.floor(u.x/256) + 6 - i*12, Math.floor(u.y/256) + 3);
            return 'player ' + g.player + ' (slot ' + g.lockstep.slot + ') ordered ' + n + ' units; objects per race ' + races + '; addon ' + w.addon + '; size ' + w.size; }''', i))
    # hashes at common ticks: each page records its hash every 40 ticks
    for pg in pages:
        pg.evaluate('''() => { const g = window.anGame; window.__hashes = {}; const step = g.lockstep.step.bind(g.lockstep);
            g.lockstep.step = () => { const r = step(); const w = g.world; if (r && w.tick % 40 === 0) window.__hashes[w.tick] = w.hash(); return r; }; }''')
    a.wait_for_timeout(SECONDS * 1000)
    states = [pg.evaluate('''() => { const g = window.anGame, w = g.world, ls = g.lockstep;
        const races = [0, 1, 2].map(r => w.entities.filter(e => e.alive && e.kind !== 2 && (e.oid >>> 16) === r).length);
        return { tick: w.tick, desync: ls.desync, races, hashes: window.__hashes, status: document.getElementById('status').textContent }; }''') for pg in pages]
    common = sorted(set(states[0]['hashes']) & set(states[1]['hashes']), key=int)
    same = [t for t in common if states[0]['hashes'][t] == states[1]['hashes'][t]]
    print('ticks', [s['tick'] for s in states], 'desync', [s['desync'] for s in states])
    print('objects per race', [s['races'] for s in states])
    print(f'hash checkpoints in common: {len(common)}, identical: {len(same)}, last common tick {common[-1] if common else None}')
    print('status', [s['status'] for s in states])
    a.screenshot(path=f'{out}-game-a.png'); b.screenshot(path=f'{out}-game-b.png')
    for l in logs: print(l)
    br.close()
