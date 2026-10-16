#!/usr/bin/env python3
"""Reader for Alien Nations .gd sprite archives (and the .OD archives that share the container).

Written from the format description in docs/formats/gd.md, not from the game's code.

Usage:
  gd.py list  <file.gd>                    list entries
  gd.py sheet <file.gd> <out.png> [filter] contact sheet of frame 0 of each entry
  gd.py png   <file.gd> <name> <out.png> [frame]
"""
import struct, sys
from PIL import Image


class GdArchive:
    def __init__(self, path):
        self.d = d = open(path, 'rb').read()
        # interface archives only: colour without alpha means opaque (docs/formats/gd.md)
        low = path.replace('\\', '/').lower()
        self.auto_opaque = 'interface' in low or 'mainmenu' in low
        hdr = struct.unpack_from('<6I', d, 0)
        self.names_off, _, self.name_index_off, self.records_off, self.pixels_off, self.count = hdr
        self.entries = []
        off = self.records_off
        for _ in range(self.count):
            size, kind, name_idx = struct.unpack_from('<3I', d, off)
            nxt = off + size
            if kind == 0:
                desc = struct.unpack_from('<13I', d, nxt)
                name_off = struct.unpack_from('<I', d, self.name_index_off + name_idx * 4)[0]
                name = d[self.names_off + name_off:d.index(b'\0', self.names_off + name_off)].decode('cp1252')
                self.entries.append(dict(
                    name=name,
                    rect=desc[1:5],            # left, top, right, bottom
                    frames=desc[9],
                    encoding=desc[10] & 0xFFFF,
                    data=self.pixels_off + desc[11],
                ))
                nxt += 52
            off = nxt
        self.by_name = {e['name']: e for e in self.entries}

    def frame_starts(self, e):
        """Offsets of each frame's opcode stream, following the frame chain."""
        base = e['data']
        f = base + struct.unpack_from('<I', self.d, base + 12)[0]
        frames = {}
        for _ in range(e['frames']):
            idx, nxt = struct.unpack_from('<iI', self.d, f)
            frames[idx] = f + 8
            if nxt == 0:
                break
            f += nxt
        return frames

    def decode(self, e, frame=0):
        """Return an RGBA PIL image (straight alpha) for the given frame."""
        l, t, r, b = e['rect']
        w, h = r - l, b - t
        assert e['encoding'] == 4, e['encoding']
        starts = self.frame_starts(e)
        px = bytearray(w * h * 4)          # premultiplied BGRA, transparent black
        self._seen = [0, 0]                # OR of alpha, OR of colour written
        self._opaque = False
        for fi in range(frame + 1):        # each frame paints on top of the previous one
            self._apply(starts[fi], px, w, h)
        if self.auto_opaque and self._seen[0] == 0 and self._seen[1] != 0:
            # colour but no alpha anywhere: drawn opaque by the game (docs/formats/gd.md)
            px = bytearray(w * h * 4)
            self._opaque = True
            for fi in range(frame + 1):
                self._apply(starts[fi], px, w, h)
        img = Image.frombuffer('RGBA', (w, h), bytes(px), 'raw', 'BGRA', 0, 1)
        return img

    def _apply(self, p, px, w, h):
        d = self.d
        row = 0
        cur = 0
        while True:
            op = struct.unpack_from('<H', d, p)[0]
            cmd, n = op & 0xF, op >> 4
            if cmd == 4:
                return
            if cmd == 0:                       # n+1 literal pixels
                for i in range(n + 1):
                    c = struct.unpack_from('<I', d, p + 2 + i * 4)[0]
                    self._put2(px, cur, c); cur += 1
                p += 2 + (n + 1) * 4
            elif cmd == 1:                     # n+2 copies of one pixel
                c = struct.unpack_from('<I', d, p + 2)[0]
                for _ in range(n + 2):
                    self._put2(px, cur, c); cur += 1
                p += 6
            elif cmd == 2:                     # jump to start of row + n + 1
                row += n + 1
                cur = row * w
                p += 2
            elif cmd == 3:                     # skip n+1 pixels (leave unchanged)
                cur += n + 1
                p += 2
            else:
                raise ValueError(f'unknown opcode {cmd} at {p}')

    def _put2(self, px, i, c):
        self._seen[0] |= c >> 24
        self._seen[1] |= c & 0xFFFFFF
        if self._opaque:
            c |= 0xFF000000
        self._put(px, i, c)

    @staticmethod
    def _put(px, i, c):
        a = c >> 24
        # channels are premultiplied: clamp each to alpha
        bl, g, r = min(c & 0xFF, a), min((c >> 8) & 0xFF, a), min((c >> 16) & 0xFF, a)
        # store straight alpha for PNG output
        if a:
            bl, g, r = bl * 255 // a, g * 255 // a, r * 255 // a
        px[i*4:i*4+4] = bytes((bl, g, r, a))


def main():
    cmd, path = sys.argv[1], sys.argv[2]
    g = GdArchive(path)
    if cmd == 'list':
        for e in g.entries:
            l, t, r, b = e['rect']
            print(f"{e['name']:50} {r-l:4}x{b-t:<4} frames={e['frames']:3} enc={e['encoding']}")
        print(len(g.entries), 'image entries of', g.count)
    elif cmd == 'png':
        name, out = sys.argv[3], sys.argv[4]
        frame = int(sys.argv[5]) if len(sys.argv) > 5 else 0
        g.decode(g.by_name[name], frame).save(out)
    elif cmd == 'sheet':
        out = sys.argv[3]
        flt = sys.argv[4] if len(sys.argv) > 4 else ''
        ents = [e for e in g.entries if flt in e['name']]
        imgs = []
        for e in ents:
            try:
                imgs.append((e['name'], g.decode(e)))
            except Exception as ex:
                print('FAIL', e['name'], ex)
        W = 1600
        x = y = rowh = 0
        place = []
        for n, im in imgs:
            if x + im.width > W:
                x, y, rowh = 0, y + rowh + 4, 0
            place.append((x, y, im)); x += im.width + 4; rowh = max(rowh, im.height)
        sheet = Image.new('RGBA', (W, y + rowh + 4), (255, 0, 255, 255))
        for x, y, im in place:
            sheet.alpha_composite(im, (x, y))
        sheet.save(out)
        print('decoded', len(imgs), 'of', len(ents))


if __name__ == '__main__':
    main()
