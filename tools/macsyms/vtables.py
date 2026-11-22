"""Find C++ vtables in the Mac (PEF, CodeWarrior) and PC (PE, MSVC) builds.

  python3 vtables.py mac <idbdir> <features.jsonl> out.json
  python3 vtables.py pe  <exe>    <features.jsonl> out.json

A vtable is a run of pointers to function entries (Mac: through transition vectors {code, TOC}),
split at every address that something else refers to (constructors store the vtable start).
Output: list of {"addr", "slots": [function entry or null], "refs": number of references}.
Analysis aid only: output feeds the specs in docs/, never the new code base.
"""
import sys, json, struct, re


def runs(words, is_fn):
    """words: list of (addr, value). Yield maximal runs of consecutive function pointers."""
    cur = []
    for a, v in words:
        if is_fn(v):
            if cur and a != cur[-1][0] + 4: yield cur; cur = []
            cur.append((a, v))
        else:
            if len(cur) >= 2: yield cur
            cur = []
    if len(cur) >= 2: yield cur


def split(run, starts):
    out, cur = [], []
    for a, v in run:
        if cur and a in starts: out.append(cur); cur = []
        cur.append((a, v))
    if cur: out.append(cur)
    return out


def mac(idbdir, feats, outp):
    fns = {json.loads(l)['ea'] for l in open(feats)}
    meta = json.load(open(f'{idbdir}/idb.json'))
    code = open(f'{idbdir}/seg_00000000.bin', 'rb').read()
    base = 0x1809f0; data = open(f'{idbdir}/seg_{base:08x}.bin', 'rb').read()
    toc = 0x1889f0
    def w(a):
        o = a - base
        return struct.unpack_from('>I', data, o)[0] if 0 <= o <= len(data) - 4 else None
    # transition vectors: {code entry, TOC}
    tv = {}
    for o in range(0, len(data) - 8, 4):
        c, t = struct.unpack_from('>II', data, o)
        if t == toc and '%08x' % c in fns: tv[base + o] = '%08x' % c
    words = [(base + o, struct.unpack_from('>I', data, o)[0]) for o in range(0, len(data) - 4, 4)]
    # references to data addresses: from TOC slots/data words and from code (lis/addi pairs are rare in CW)
    refcount = {}
    for a, v in words:
        refcount[v] = refcount.get(v, 0) + 1
    res = []
    for r in runs(words, lambda v: v in tv):
        # CodeWarrior: the object points at the 8-byte header {RTTI, offset} before the slots
        starts = {a for a, _ in r if refcount.get(a - 8, 0) > 0 or refcount.get(a, 0) > 0}
        for part in split(r, starts):
            a0 = part[0][0]
            res.append({'addr': '%08x' % a0, 'slots': [tv[v] for _, v in part],
                        'refs': refcount.get(a0 - 8, 0) + refcount.get(a0, 0)})
    json.dump(res, open(outp, 'w'))
    print('transition vectors', len(tv), 'vtables', len(res), file=sys.stderr)


def pe(exe, feats, outp):
    fns = {json.loads(l)['ea'] for l in open(feats)}
    d = open(exe, 'rb').read()
    pe_ = struct.unpack_from('<I', d, 0x3c)[0]; n = struct.unpack_from('<H', d, pe_ + 6)[0]
    opt = struct.unpack_from('<H', d, pe_ + 20)[0]; ib = struct.unpack_from('<I', d, pe_ + 52)[0]
    secs = []
    for i in range(n):
        o = pe_ + 24 + opt + 40 * i
        name = d[o:o + 8].rstrip(b'\0').decode()
        vs, va, rs, ro = struct.unpack_from('<IIII', d, o + 8)
        secs.append((name, ib + va, vs, ro, rs))
    def sec(nm): return next(s for s in secs if s[0] == nm)
    res = []
    text = sec('.text'); tb = d[text[3]:text[3] + text[4]]
    # every 4-byte value anywhere in .text/.rdata/.data that could be a reference
    refcount = {}
    for s in secs:
        b = d[s[3]:s[3] + s[4]]
        step = 1 if s[0] == '.text' else 4
        for o in range(0, len(b) - 3, step):
            v = struct.unpack_from('<I', b, o)[0]
            if 0x400000 <= v < 0x600000: refcount[v] = refcount.get(v, 0) + 1
    for nm in ('.rdata', '.data'):
        s = sec(nm); b = d[s[3]:s[3] + s[4]]
        words = [(s[1] + o, struct.unpack_from('<I', b, o)[0]) for o in range(0, len(b) - 3, 4)]
        tlo, thi = text[1], text[1] + text[2]
        for r in runs(words, lambda v: tlo <= v < thi and (v & 3) == 0 or '%08x' % v in fns):
            # a vtable start is referenced from code (constructor / destructor store)
            starts = {a for a, _ in r if refcount.get(a, 0) > 0}
            for part in split(r, starts):
                res.append({'addr': '%08x' % part[0][0], 'slots': ['%08x' % v for _, v in part],
                            'refs': refcount.get(part[0][0], 0), 'sec': nm})
    json.dump(res, open(outp, 'w'))
    print('vtables', len(res), file=sys.stderr)


if __name__ == '__main__':
    {'mac': mac, 'pe': pe}[sys.argv[1]](*sys.argv[2:5])
