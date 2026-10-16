#!/usr/bin/env python3
"""Decode dv.odb (object rules database) and print per-race tables.

Field meanings follow docs/formats/odb.md (clean-room spec). Usage:

    python3 tools/odb_dump.py [race] [--odb PATH] [--raw]

--odb defaults to $AN_DATA/dv.odb (AN_DATA = the game's Data folder).

race: amazon | pimmon | sajiki | nature | effects | all (default: pimmon)
--raw: also print every non-zero dword of each record.
"""
import argparse
import os
import struct
import sys

DEFAULT_ODB = os.path.join(os.environ['AN_DATA'], 'dv.odb') if os.environ.get('AN_DATA') else None
REC = 0x18C
GOODS = ['raw', 'wood', 'stone', 'iron', 'food', 'weapons', 'lux6', 'lux7', 'lux8']
RACES = {'amazon': 0, 'pimmon': 1, 'sajiki': 2, 'nature': 6, 'effects': 7}
KIND = {0: 'unit', 1: 'building', 2: 'nature/item'}


def i32(r, o):
    return struct.unpack_from('<i', r, o)[0]


class Rec:
    def __init__(self, raw):
        self.raw = raw
        g = lambda o: i32(raw, o)
        self.id = g(0x00)
        self.sound_frame = g(0x04)
        self.sound = g(0x08)
        self.size_y = g(0x0C)
        self.size_x = g(0x10)
        self.points = [(g(0x54 + 8 * k), g(0x58 + 8 * k)) for k in range(8)]
        self.entrance = (g(0x94), g(0x98))
        self.group = g(0xA0)
        self.kind = g(0xA4)
        self.type = g(0xA8)
        self.hp = g(0xAC)
        self.radius = g(0xB0)
        self.housing = g(0xB4)
        self.flags = g(0xB8)
        self.cls = g(0xC0)
        self.step = [g(0xC4 + 4 * k) for k in range(4)]
        self.money = g(0xD4)
        self.operator = g(0xD8)
        self.garrison = g(0xDC)
        self.invention = g(0xE4)
        self.made_at = g(0xE8)
        self.cost = [g(0xF0 + 4 * k) for k in range(9)]
        self.f114 = g(0x114)
        self.product = g(0x11C)
        self.amount = g(0x120)
        self.slot = g(0x124)
        self.need = g(0x128)
        self.need2 = g(0x12C)
        self.message = g(0x130)
        self.sound_action = g(0x134)
        self.weapon = g(0x144)
        self.effect = g(0x148)
        self.name = raw[0x14C:0x18C].split(b'\0')[0].decode('cp1252')


def load(path):
    d = open(path, 'rb').read()
    if len(d) % REC:
        sys.exit(f'{path}: size {len(d)} is not a multiple of {REC}')
    return [Rec(d[i:i + REC]) for i in range(0, len(d), REC)]


def costs(r):
    return ' '.join(f'{v}{GOODS[k]}' for k, v in enumerate(r.cost) if v) or '-'


def flagstr(f):
    names = {1: 'store', 2: 'unique', 4: 'staffed', 8: 'visit'}
    s = [n for b, n in names.items() if f & b]
    rest = f & ~15
    if rest:
        s.append(hex(rest))
    return ','.join(s) or '-'


def table(rows, cols):
    widths = [max(len(c[0]), *(len(str(c[1](r))) for r in rows)) for c in cols]
    print('  '.join(c[0].ljust(w) for c, w in zip(cols, widths)))
    for r in rows:
        print('  '.join(str(c[1](r)).ljust(w) for c, w in zip(cols, widths)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('race', nargs='?', default='pimmon')
    ap.add_argument('--odb', default=DEFAULT_ODB)
    ap.add_argument('--raw', action='store_true')
    a = ap.parse_args()
    if not a.odb:
        ap.error('pass --odb PATH or set AN_DATA to the game\'s Data folder')
    recs = load(a.odb)
    groups = list(RACES.values()) if a.race == 'all' else [RACES[a.race]]
    for grp in groups:
        sel = [r for r in recs if r.group == grp]
        bytype = {r.type: r for r in sel}
        tname = lambda t: (bytype[t].name if t in bytype else '?') if t >= 0 else '-'
        gname = lambda t: GOODS[t] if 0 <= t < 9 else ('-' if t < 0 else f'#{t}')
        name = [k for k, v in RACES.items() if v == grp][0]
        print(f'===== group {grp} ({name}): {len(sel)} records =====')
        units = [r for r in sel if r.kind == 0]
        blds = [r for r in sel if r.kind == 1]
        other = [r for r in sel if r.kind == 2]
        if units:
            print('\n-- units --')
            table(units, [
                ('type', lambda r: r.type), ('name', lambda r: r.name),
                ('HP', lambda r: r.hp), ('sight', lambda r: r.radius),
                ('price', lambda r: r.money), ('goods', costs),
                ('trained at', lambda r: tname(r.made_at) if r.made_at >= 37 else '(not trainable)'),
                ('invention', lambda r: r.invention), ('weapon', lambda r: r.weapon),
                ('class', lambda r: r.cls), ('steps', lambda r: '/'.join(map(str, r.step))),
                ('plants', lambda r: r.product if r.product >= 0 else '-'),
                ('slot', lambda r: r.slot),
            ])
        if blds:
            print('\n-- buildings --')
            table(blds, [
                ('type', lambda r: r.type), ('name', lambda r: r.name),
                ('size', lambda r: f'{r.size_x}x{r.size_y}'), ('door', lambda r: '%d,%d' % r.entrance),
                ('HP', lambda r: r.hp), ('upkeep', lambda r: r.money), ('build cost', costs),
                ('beds', lambda r: r.housing or '-'), ('store', lambda r: r.amount or '-'),
                ('operator', lambda r: tname(r.operator)), ('garr', lambda r: r.garrison or '-'),
                ('produces', lambda r: gname(r.product)), ('radius', lambda r: r.radius or '-'),
                ('class', lambda r: r.cls), ('flags', lambda r: flagstr(r.flags)),
                ('invention', lambda r: r.invention),
                ('menu', lambda r: 'yes' if r.made_at >= 37 else 'no'),
                ('need@pop', lambda r: r.need or '-'), ('msg', lambda r: r.message or '-'),
            ])
        if other:
            print('\n-- nature / goods / effects --')
            table(other, [
                ('type', lambda r: r.type), ('name', lambda r: r.name),
                ('class', lambda r: r.cls), ('HP', lambda r: r.hp or '-'),
                ('price', lambda r: r.money or '-'), ('input', costs),
                ('yields', lambda r: f'{r.amount} {gname(r.product)}' if r.product >= 0 else '-'),
                ('steps', lambda r: '/'.join(map(str, r.step)) if any(r.step) else '-'),
                ('lux need@pop', lambda r: r.need or '-'), ('msg', lambda r: r.message),
                ('sound', lambda r: r.sound or '-'), ('impact fx', lambda r: r.effect),
                ('slot', lambda r: r.slot),
            ])
        if a.raw:
            print('\n-- raw non-zero dwords --')
            for r in sel:
                nz = ' '.join(f'{o:03x}={i32(r.raw, o)}' for o in range(0, 0x14C, 4)
                              if i32(r.raw, o) and o not in (0xA0, 0xA4, 0xA8))
                print(f'{r.type:3d} {r.name}: {nz}')
        print()


if __name__ == '__main__':
    main()
