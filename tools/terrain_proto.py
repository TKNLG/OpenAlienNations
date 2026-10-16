#!/usr/bin/env python3
"""Prototype of the map terrain generator, written from docs/formats/terrain-gen.md.

Verification aid: generates the class grid for a mission (seed + size from the .mdb), and
can overlay the mission's .dvm objects to check that they land on plausible ground.
"""
import struct, sys

WATER, PATH = 11, 10
CLASS_SET = ['wiese', 'gelbgras', 'schnee', 'rock', 'waldboden', 'waldboden',
             'gruenwald', 'waldboden', 'gelbgras', 'gruenwald', 'weg', 'wasser1']


class Rand:
    """The classic MSVC rand(): 15-bit output of a 32-bit LCG."""
    def __init__(self, seed): self.s = seed & 0xFFFFFFFF
    def __call__(self):
        self.s = (self.s * 0x343FD + 0x269EC3) & 0xFFFFFFFF
        return (self.s >> 16) & 0x7FFF


def generate(seed, bits):
    n = 1 << bits
    m = n - 1
    rnd = Rand(seed)
    height = [0] * (n * n)
    cls = [(((i >> bits) & i) & 1) | 8 for i in range(n * n)]
    idx = lambda x, y: ((y & m) << bits) | (x & m)

    # --- hills -------------------------------------------------------------
    for _ in range((n >> 4) ** 2):
        x = rnd() & m; y = rnd() & m
        steps = rnd() & 7
        r = rnd() & 31
        variant = cls[idx(x, y)] & 1
        for _ in range(steps):
            for dy in range(-6 * r, 6 * r + 1):
                for dx in range(-6 * r, 6 * r + 1):
                    d2 = dx * dx + dy * dy
                    v = (2 * r - ((d2 * r) >> 6)) if d2 < 64 else (r << 6) // d2
                    if v:
                        i = idx(x + dx, y + dy)
                        height[i] = (height[i] + (v * 4) // 5) & 0xFFFF
                        h = height[i]
                        band = 2 if h > 250 else 4 if h > 200 else 6 if h > 130 else 0
                        if band != (cls[i] & 0xFE):
                            cls[i] = variant + band
            rr = r | 1
            x = (x + rnd() % rr - (r >> 1)) & 0xFFFFFFFF
            y = (y + rnd() % rr - (r >> 1)) & 0xFFFFFFFF
            r = r - 15 + rnd() % 31
            r = max(0, min(31, r))

    # --- lakes -------------------------------------------------------------
    def wrap(v):
        while v >= n: v -= n
        while v < 0: v += n
        return v

    for _ in range((n >> 6) ** 2):
        rad = rnd() % 3 + 2
        while True:
            x = rnd() & m; y = rnd() & m
            R = rad + 1
            lo, hi, ok = 0x7FFF, 0, True
            for dy in range(-R, R + 1):
                for dx in range(-R, R + 1):
                    i = idx(wrap(x + dx), wrap(y + dy))
                    h = height[i]
                    lo = min(lo, h); hi = max(hi, h)
                    if h > 250 or cls[i] == WATER:
                        ok = False; break
                if not ok: break
            level = lo if ok and hi - lo <= 20 else 0
            if level: break
        R = rad + 1
        for dy in range(-R, R + 1):
            for dx in range(-R, R + 1):
                d2 = dx * dx + dy * dy
                if d2 <= R * R:
                    i = idx(wrap(x + dx), wrap(y + dy))
                    height[i] = level
                    if d2 <= rad * rad and ((dx != rad and dy != rad) or (rnd() & 1)):
                        cls[i] = WATER
        E = rad + 5
        for dy in range(-E, E + 1):
            for dx in range(-E, E + 1):
                cx, cy = x + dx, y + dy
                if cls[idx(cx, cy)] == WATER:
                    continue
                if any(cls[idx(cx + ax, cy + ay)] == WATER
                       for ay in (-1, 0, 1) for ax in (-1, 0, 1) if ax or ay):
                    cls[idx(cx, cy)] = PATH
    return n, height, cls, rnd


def mission(mdb, no):
    d = open(mdb, 'rb').read()[no * 3864:(no + 1) * 3864]
    seed, bits = struct.unpack_from('<iI', d, 0xA48)
    return seed, bits, d[4:d.index(b'\0', 4)].decode('cp1252')


if __name__ == '__main__':
    import collections
    from PIL import Image
    data = sys.argv[1]; mdb = sys.argv[2]; no = int(sys.argv[3]); dvm = sys.argv[4]; out = sys.argv[5]
    seed, bits, title = mission(f'{data}/{mdb}', no)
    n, height, cls, _ = generate(seed, bits)
    print(title, 'seed', seed, 'size', n)
    print('class histogram', sorted(collections.Counter(cls).items()))
    colors = {0: (90, 170, 60), 1: (200, 190, 60), 2: (240, 240, 250), 3: (130, 130, 130),
              4: (150, 100, 60), 5: (150, 100, 60), 6: (60, 120, 50), 7: (150, 100, 60),
              8: (200, 190, 60), 9: (60, 120, 50), 10: (190, 170, 120), 11: (30, 60, 200)}
    img = Image.new('RGB', (n, n))
    img.putdata([colors[c] for c in cls])
    d = open(f'{data}/{dvm}', 'rb').read()
    cnt = struct.unpack_from('<I', d, 8)[0]
    onwater = collections.Counter(); bytype = collections.defaultdict(collections.Counter)
    px = img.load()
    for k in range(cnt):
        c, a, t, own, x, y, z = struct.unpack_from('<7i', d, 12 + k * 28)
        cc = cls[(y << bits) | x]
        bytype[(c, t)][CLASS_SET[cc]] += 1
        if cc == WATER: onwater[(c, t)] += 1
        px[x, y] = (255, 0, 0) if c != 2 else (0, 0, 0)
    print('objects on water:', sum(onwater.values()), 'of', cnt, dict(onwater))
    for k in sorted(bytype):
        print(k, dict(bytype[k].most_common(4)))
    img.resize((n * 4, n * 4), Image.NEAREST).save(out)
