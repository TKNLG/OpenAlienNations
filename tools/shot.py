#!/usr/bin/env python3
"""Headless check of the client: load a URL, wait until the app reports ready, collect console
errors, save a screenshot. Usage: shot.py <url> <out.png> [width height]"""
import sys, time
from playwright.sync_api import sync_playwright

url, out = sys.argv[1], sys.argv[2]
w = int(sys.argv[3]) if len(sys.argv) > 3 else 1280
h = int(sys.argv[4]) if len(sys.argv) > 4 else 800
with sync_playwright() as p:
    b = p.chromium.launch(args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
    pg = b.new_page(viewport={'width': w, 'height': h})
    logs = []
    pg.on('console', lambda m: logs.append(f'{m.type}: {m.text}'))
    pg.on('pageerror', lambda e: logs.append(f'pageerror: {e}'))
    t = time.time()
    pg.goto(url)
    try:
        pg.wait_for_function('window.anReady === true', timeout=120000)
    except Exception as e:
        logs.append(f'timeout: {e}')
    ready = time.time() - t
    pg.wait_for_timeout(2500)
    pg.screenshot(path=out)
    print(f'ready after {ready:.1f}s')
    print('status:', pg.inner_text('#status'), '|', pg.inner_text('#fps'))
    for l in logs:
        print(l)
    b.close()
