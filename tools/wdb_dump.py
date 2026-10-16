#!/usr/bin/env python3
"""Reader for the Alien Nations weapon table dv.wdb.

Written from the format description in docs/formats/idb-wdb.md, not from the game's code.

Usage:
  wdb_dump.py <dv.wdb> [--odb dv.odb]   list the weapons (--odb adds projectile and user names)
"""
import struct, sys

RECORD = 0x74
KIND = {1: 'melee', 2: 'missile', 3: 'heal', 4: 'bomb'}


def cstr(b):
    return b.split(b'\0', 1)[0].decode('cp1252')


def read_wdb(path):
    d = open(path, 'rb').read()
    out = []
    for i in range(len(d) // RECORD):
        b = d[i * RECORD:(i + 1) * RECORD]
        v = struct.unpack_from('<13i', b, 0)
        out.append(dict(index=v[0], kind=v[1], projectile=v[2], min=v[3], max=v[4], range=v[5],
                        unk18=v[6], speed=v[7], cooldown=v[8], hit_pct=v[9], unk28=v[10:13],
                        name=cstr(b[0x34:0x74])))
    return out


def odb_info(path):
    proj, users = {}, {}
    d = open(path, 'rb').read()
    for r in range(len(d) // 0x18C):
        b = d[r * 0x18C:(r + 1) * 0x18C]
        group, _, typ = struct.unpack_from('<3I', b, 0xA0)
        weapon = struct.unpack_from('<i', b, 0x144)[0]
        name = cstr(b[0x14C:])
        if group == 7:
            proj[typ] = name
        if weapon >= 0:
            users.setdefault(weapon, []).append(f'{group}:{typ} {name}')
    return proj, users


if __name__ == '__main__':
    a = sys.argv[1:]
    if not a:
        sys.exit(__doc__)
    proj, users = odb_info(a[a.index('--odb') + 1]) if '--odb' in a else ({}, {})
    for w in read_wdb(a[0]):
        p = w['projectile']
        ptxt = '-' if p < 0 else f"{p}" + (f" ({proj[p]})" if p in proj else '')
        print(f"{w['index']:2d} {w['name']:24s} {KIND.get(w['kind'], w['kind']):7s} "
              f"dmg {w['min']}..{w['max']}  range {w['range']}  speed {w['speed']}  "
              f"cooldown {w['cooldown']}  hit {w['hit_pct']}%  projectile {ptxt}"
              + (f"  unknown {w['unk18']} {w['unk28']}" if w['unk18'] or any(w['unk28']) else ''))
        if w['index'] in users:
            print('     used by: ' + '; '.join(users[w['index']]))
