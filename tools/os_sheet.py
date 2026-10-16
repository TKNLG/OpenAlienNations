#!/usr/bin/env python3
"""Decode Alien Nations .os terrain tile sets into a PNG contact sheet.

Layout (measured, see docs/formats/os.md):
  u32 0, u32 tile_count
  tile_count x { 16-byte GUID, u32 w, u32 h, u32 0, u32 255, u32 param, w*h*4 bytes BGRx }
"""
import struct, sys, os
from PIL import Image

def read_os(path):
    d = open(path, 'rb').read()
    _, count = struct.unpack_from('<II', d, 0)
    off, tiles = 8, []
    for _ in range(count):
        guid = d[off:off+16]
        w, h, z, a, p = struct.unpack_from('<5I', d, off + 16)
        off += 36
        px = d[off:off + w*h*4]
        off += w*h*4
        img = Image.frombuffer('RGBX', (w, h), px, 'raw', 'BGRX', 0, 1).convert('RGB')
        tiles.append(dict(guid=guid.hex(), w=w, h=h, z=z, a=a, param=p, img=img))
    assert off == len(d), (path, off, len(d))
    return tiles

if __name__ == '__main__':
    datadir, out = sys.argv[1], sys.argv[2]
    names = sorted(f for f in os.listdir(datadir) if f.lower().endswith('.os'))
    sets = [(n, read_os(os.path.join(datadir, n))) for n in names]
    cols = max(len(t) for _, t in sets)
    sheet = Image.new('RGB', (cols * 66 + 120, len(sets) * 66), (40, 40, 40))
    from PIL import ImageDraw
    dr = ImageDraw.Draw(sheet)
    for r, (n, tiles) in enumerate(sets):
        dr.text((4, r*66 + 26), n, fill=(230, 230, 230))
        for c, t in enumerate(tiles):
            sheet.paste(t['img'], (120 + c*66, r*66 + 1))
        print(n, len(tiles), 'params', sorted({t['param'] for t in tiles}), 'guids', len({t['guid'] for t in tiles}))
    sheet.save(out)
