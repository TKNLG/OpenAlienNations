#!/usr/bin/env python3
"""Reader for Alien Nations scenario maps (*.dvm): object list plus the trailing block.

Written from the format description in docs/formats/dvm.md, not from the game's code.

Usage:
  dvm_dump.py <file.dvm> [--objects]   summary, region/start lists, camera and orders
  dvm_dump.py --check <Data dir>       parse every .dvm and verify it is consumed exactly
"""
import collections, glob, os, struct, sys

CLASS = {0: 'unit', 1: 'building', 2: 'nature'}
LISTS = ['forest regions (trees, animals)', 'stone regions', 'bush regions',
         'start-position candidates', 'start positions']


def read_dvm(path):
    d = open(path, 'rb').read()
    magic, version, count = d[:4], *struct.unpack_from('<II', d, 4)
    o = 12
    objs = []
    for _ in range(count):
        c, g, t, s, x, y, z = struct.unpack_from('<7i', d, o)
        o += 28
        if g == 6:          # the loader forces every group-6 record to the nature class
            c = 2
        objs.append(dict(cls=c, group=g, type=t, settlement=s, x=x, y=y, z=z))
    lists = []
    for _ in range(5):
        n = struct.unpack_from('<I', d, o)[0]
        o += 4
        lists.append([struct.unpack_from('<3i', d, o + 12 * k) for k in range(n)])
        o += 12 * n
    camera = struct.unpack_from('<ii', d, o)
    o += 8
    n = struct.unpack_from('<I', d, o)[0]
    o += 4
    orders = [struct.unpack_from('<6i', d, o + 24 * k) for k in range(n)]
    o += 24 * n
    return dict(magic=magic, version=version, objects=objs, lists=lists, camera=camera,
                orders=orders, trailing_bytes=len(d) - o)


def dump(path, show_objects):
    m = read_dvm(path)
    print(f"{os.path.basename(path)}: {m['magic']!r} v{m['version']}, {len(m['objects'])} objects")
    cnt = collections.Counter((CLASS.get(o['cls'], o['cls']), o['group']) for o in m['objects'])
    for (c, g), n in sorted(cnt.items()):
        print(f'  {c:8s} group {g}: {n}')
    for name, l in zip(LISTS, m['lists']):
        print(f'  {name}: {len(l)} {l}')
    print(f"  camera start cell {m['camera']}")
    at = {(o['x'], o['y']): o for o in m['objects']}
    for x1, y1, z1, x2, y2, z2 in m['orders']:
        s, t = at.get((x1, y1)), at.get((x2, y2))
        sd = f"{s['group']}:{s['type']}" if s else '?'
        td = f"{t['group']}:{t['type']}" if t else 'cell'
        print(f'  order: object {sd} at ({x1},{y1},{z1}) -> {td} at ({x2},{y2},{z2})')
    if show_objects:
        for o in m['objects']:
            print('   ', o)
    if m['trailing_bytes']:
        print(f"  WARNING {m['trailing_bytes']} unparsed bytes")


if __name__ == '__main__':
    a = sys.argv[1:]
    if not a:
        sys.exit(__doc__)
    if a[0] == '--check':
        bad = 0
        for f in sorted(glob.glob(os.path.join(a[1], '*.dvm'))):
            m = read_dvm(f)
            ok = m['trailing_bytes'] == 0 and m['magic'] == b'SMVD' and m['version'] == 100
            bad += not ok
            print(f"{os.path.basename(f):14s} {'ok' if ok else 'FAIL'}  objects {len(m['objects'])}"
                  f"  lists {[len(l) for l in m['lists']]}  orders {len(m['orders'])}")
        sys.exit(1 if bad else 0)
    dump(a[0], '--objects' in a)
