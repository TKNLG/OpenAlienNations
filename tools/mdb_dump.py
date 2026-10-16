#!/usr/bin/env python3
"""Reader for Alien Nations mission files (*.mdb).

Written from the format description in docs/formats/mdb.md, not from the game's code.

Usage:
  mdb_dump.py <file.mdb> [--odb dv.odb] [--brief]   decode every mission record
  mdb_dump.py --table <Data dir>                     one markdown row per shipped mission

--odb only adds object names to type numbers (name read from dv.odb at record +0x14C).
"""
import os, struct, sys

RECORD = 0xF18
RACES = ['Amazons', 'Pimmons', 'Sajiki']
# good index = nature/item type in object group 6 (names from dv.odb)
GOODS = ['raw (cocoa/mushroom/maggot)', 'wood', 'stone', 'iron', 'food', 'weapons',
         'chocolate cakes', 'mushroom schnapps', 'cigarillos']
RELATION = {0: 'none', 1: 'war', 2: 'ceasefire', 3: 'peace'}

# goal type -> (short name, which parameters mean what)
GOAL_TYPES = {
    1: 'goods',          # settlement p3 holds >= p2 of good p1
    2: 'finished',       # settlement p3 has >= p2 finished objects of type p1
    3: 'buildings',      # settlement p2 has >= p1 finished buildings
    4: 'count',          # settlement p3 has >= p2 objects of type p1
    5: 'population',     # settlement p2 has >= p1 inhabitants
    6: 'crime<=',        # settlement p2 crime rate <= p1 %
    7: 'satisfaction>=', # settlement p2 satisfaction >= p1
    8: 'wishes<=',       # settlement p2 open wishes <= p1
    9: 'wishes>=',       # settlement p2 open wishes >= p1
    10: 'satisfaction<=',
    11: 'relation',      # relation to race p1 == p2
    12: 'destroy',       # race p1, settlement p3: no objects of type p2 left
    13: 'eliminate',     # race p1 gone
    14: 'pimmon goods',  # the Pimmons' settlement p3 holds >= p2 of good p1
    15: 'count<=',       # settlement p3 has <= p2 objects of type p1
    16: 'gold',          # treasury >= p1
}


def cstr(b):
    return b.split(b'\0', 1)[0].decode('cp1252')


def load_odb_names(path):
    names = {}
    if not path:
        return names
    d = open(path, 'rb').read()
    for r in range(len(d) // 0x18C):
        b = d[r * 0x18C:(r + 1) * 0x18C]
        group, _, typ = struct.unpack_from('<3I', b, 0xA0)
        names[(group, typ)] = cstr(b[0x14C:])
    return names


def parse_record(b):
    i32 = lambda o: struct.unpack_from('<i', b, o)[0]
    m = dict(index=i32(0), title=cstr(b[0x04:0x44]), briefing=cstr(b[0x44:0xA08]),
             map=cstr(b[0xA08:0xA48]), seed=i32(0xA48), size_bits=i32(0xA4C),
             briefing_variant=i32(0xA50), goals=[], races=[])
    for g in range(10):
        o = 0xA54 + g * 20
        typ, defeat, p1, p2, p3 = struct.unpack_from('<5i', b, o)
        if typ:
            m['goals'].append(dict(slot=g, type=typ, defeat=defeat, p1=p1, p2=p2, p3=p3))
    for r in range(3):
        o = 0xB1C + r * 0x154
        v = lambda k: i32(o + k)
        m['races'].append(dict(
            present=v(0x00), computer=v(0x04), ai_profile=v(0x08), gold=v(0x0C),
            relation=[v(0x10 + 4 * j) for j in range(3)],
            goods=[[v(0x1C + 8 * i), v(0x20 + 8 * i)] for i in range(9)],
            research_level=v(0x64),
            forbidden_buildings=[v(0x68 + 4 * j) for j in range(3)],
            forbidden_units=[v(0x74 + 4 * j) for j in range(3)],
            invented=[i for i in range(30) if v(0x80 + 4 * i)],
            unused_nonzero=[k for k in range(0xF8, 0x154, 4) if v(k)]))
    return m


def read_mdb(path):
    d = open(path, 'rb').read()
    return [parse_record(d[i * RECORD:(i + 1) * RECORD]) for i in range(len(d) // RECORD)]


def tname(names, race, typ):
    n = names.get((race, typ))
    return f'{typ} ({n})' if n else str(typ)


def describe_goal(g, me, names):
    t, p1, p2, p3 = g['type'], g['p1'], g['p2'], g['p3']
    good = lambda i: GOODS[i] if 0 <= i < len(GOODS) else str(i)
    race = lambda i: RACES[i] if 0 <= i < 3 else str(i)
    s = {
        1: lambda: f'city {p3}: stock of {good(p1)} >= {p2}',
        2: lambda: f'city {p3}: >= {p2} finished {tname(names, me, p1)}',
        3: lambda: f'city {p2}: >= {p1} finished buildings',
        4: lambda: f'city {p3}: >= {p2} x {tname(names, me, p1)}',
        5: lambda: f'city {p2}: >= {p1} inhabitants',
        6: lambda: f'city {p2}: crime rate <= {p1}%',
        7: lambda: f'city {p2}: satisfaction >= {p1}',
        8: lambda: f'city {p2}: open wishes <= {p1}',
        9: lambda: f'city {p2}: open wishes >= {p1}',
        10: lambda: f'city {p2}: satisfaction <= {p1}',
        11: lambda: f'relation to {race(p1)} == {RELATION.get(p2, p2)}',
        12: lambda: f'{race(p1)} city {p3}: no {tname(names, p1, p2)} left',
        13: lambda: f'{race(p1)} eliminated',
        14: lambda: f'Pimmons city {p3}: stock of {good(p1)} >= {p2}',
        15: lambda: f'city {p3}: <= {p2} x {tname(names, me, p1)}',
        16: lambda: f'treasury >= {p1} gold',
    }.get(t, lambda: f'unknown type {t} ({p1}, {p2}, {p3})')()
    return ('DEFEAT if ' if g['defeat'] else 'win: ') + s


def human_race(m):
    for i, r in enumerate(m['races']):
        if r['present'] and not r['computer']:
            return i
    return -1


def dump(path, names, brief):
    for m in sorted(read_mdb(path), key=lambda m: m['index']):
        me = human_race(m)
        print(f"=== mission {m['index']}: {m['title']}")
        print(f"  map {m['map'] or '(none: generated)'}  seed {m['seed']}  size {1 << m['size_bits']}"
              f"  briefing_variant {m['briefing_variant']}")
        if not brief:
            for line in m['briefing'].splitlines():
                print('  | ' + line)
        for g in m['goals']:
            print(f"  goal {g['slot']}: {describe_goal(g, me, names)}"
                  f"   [type {g['type']} p {g['p1']},{g['p2']},{g['p3']}]")
        for i, r in enumerate(m['races']):
            if not r['present']:
                continue
            who = f"computer (profile field {r['ai_profile']})" if r['computer'] else 'human'
            print(f"  {RACES[i]}: {who}, gold {r['gold']}, research level {r['research_level']}")
            rel = {RACES[j]: RELATION.get(x, x) for j, x in enumerate(r['relation']) if j != i and x}
            if rel:
                print(f"    relations {rel}")
            goods = {GOODS[k]: v for k, v in enumerate(r['goods']) if any(v)}
            if goods:
                print(f"    start goods [1st town hall, 2nd town hall] {goods}")
            fb = [tname(names, i, t) for t in r['forbidden_buildings'] if t]
            fu = [tname(names, i, t) for t in r['forbidden_units'] if t]
            if fb or fu:
                print(f"    disabled buildings {fb}  units {fu}")
            if r['invented']:
                print(f"    pre-researched inventions {r['invented']}")
            if r['unused_nonzero']:
                print(f"    NOTE non-zero bytes in unused area at {r['unused_nonzero']}")


def table(data):
    names = load_odb_names(os.path.join(data, 'dv.odb'))
    print('| file | idx | title | map | seed | size | human | computer | goals |')
    print('|---|---|---|---|---|---|---|---|---|')
    for f in ('Tutorials.mdb', 'Amazons.mdb', 'Pimmons.mdb', 'Sajikis.mdb'):
        for m in sorted(read_mdb(os.path.join(data, f)), key=lambda m: m['index']):
            me = human_race(m)
            ai = ', '.join(f"{RACES[i]} (p{r['ai_profile']})" for i, r in enumerate(m['races'])
                           if r['present'] and r['computer']) or '-'
            goals = '; '.join(describe_goal(g, me, names) for g in m['goals'])
            print(f"| {f} | {m['index']} | {m['title']} | {m['map']} | {m['seed']} | "
                  f"{1 << m['size_bits']} | {RACES[me] if me >= 0 else '-'} | {ai} | {goals} |")


if __name__ == '__main__':
    a = sys.argv[1:]
    if not a:
        sys.exit(__doc__)
    if a[0] == '--table':
        table(a[1])
    else:
        odb = a[a.index('--odb') + 1] if '--odb' in a else None
        dump(a[0], load_odb_names(odb), '--brief' in a)
