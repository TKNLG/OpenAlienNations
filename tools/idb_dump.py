#!/usr/bin/env python3
"""Reader for Alien Nations invention (research) tables: AMAZONS|PIMONS|SAJIKI/DV.idb.

Written from the format description in docs/formats/idb-wdb.md, not from the game's code.

Usage:
  idb_dump.py <DV.idb> [--odb dv.odb --race N]   list the 30 inventions
                                                 (--odb/--race add the objects each one unlocks)
"""
import struct, sys

RECORD = 212


def cstr(b):
    return b.split(b'\0', 1)[0].decode('cp1252')


def read_idb(path):
    d = open(path, 'rb').read()
    out = []
    for i in range(len(d) // RECORD):
        b = d[i * RECORD:(i + 1) * RECORD]
        idx, r1, r2, r3, cost = struct.unpack_from('<5i', b, 0)
        out.append(dict(index=idx, requires=[r for r in (r1, r2, r3) if r != -1], cost=cost,
                        name=cstr(b[0x14:0x34]), text=cstr(b[0x34:0xD4]),
                        text_offset=i * RECORD + 0x34))
    return out


def unlocks(odb_path, race):
    """object types of a race whose odb invention field (+0xE4) names each invention"""
    res = {}
    d = open(odb_path, 'rb').read()
    for r in range(len(d) // 0x18C):
        b = d[r * 0x18C:(r + 1) * 0x18C]
        group, _, typ = struct.unpack_from('<3I', b, 0xA0)
        inv = struct.unpack_from('<i', b, 0xE4)[0]
        if group == race and inv >= 0:
            res.setdefault(inv, []).append(f'{typ} {cstr(b[0x14C:])}')
    return res


if __name__ == '__main__':
    a = sys.argv[1:]
    if not a:
        sys.exit(__doc__)
    inv = read_idb(a[0])
    unl = unlocks(a[a.index('--odb') + 1], int(a[a.index('--race') + 1])) if '--odb' in a else {}
    for e in inv:
        req = ','.join(map(str, e['requires'])) or '-'
        print(f"{e['index']:2d}  cost {e['cost']:3d}  needs {req:9s} {e['name']}")
        if e['index'] in unl:
            print(f"      unlocks: {'; '.join(unl[e['index']])}")
        print(f"      {e['text'][:128]!r}" + (' [text >= 128 bytes: original reads only 128, no NUL]'
                                                if len(e['text'].encode('cp1252')) >= 128 else ''))
