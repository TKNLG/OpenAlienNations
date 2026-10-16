#!/usr/bin/env python3
"""Render every .dvf font's glyphs to a PNG sheet to validate the format reading.

Layout (measured): "tnof" magic, u32 glyph_count, u32 height, u32 baseline,
glyph_count x {u32 char_code, u32 width, u32 data_offset, u32 flags(0x20000)},
glyph data = width*height bytes, one byte per pixel, row-major.
"""
import struct, sys, os
from PIL import Image, ImageDraw

def read_dvf(path):
    d = open(path, 'rb').read()
    magic, n, h, base = struct.unpack_from('<4sIII', d, 0)
    assert magic == b'tnof'
    glyphs = []
    for i in range(n):
        code, w, off, flags = struct.unpack_from('<4I', d, 16 + i*16)
        glyphs.append(dict(code=code, w=w, h=h, flags=flags, px=d[off:off + w*h]))
    return dict(height=h, baseline=base, glyphs=glyphs)

if __name__ == '__main__':
    datadir, out = sys.argv[1], sys.argv[2]
    fonts = [(f, read_dvf(os.path.join(datadir, f))) for f in sorted(os.listdir(datadir)) if f.endswith('.dvf')]
    rows = []
    for name, font in fonts:
        vals = sorted({b for g in font['glyphs'] for b in g['px']})
        print(name, 'glyphs', len(font['glyphs']), 'h', font['height'], 'pixel values', vals[:12], '...' if len(vals) > 12 else '')
        width = sum(g['w'] + 2 for g in sorted(font['glyphs'], key=lambda g: g['code'])) + 110
        row = Image.new('L', (width, font['height'] + 6), 30)
        ImageDraw.Draw(row).text((2, 0), name, fill=200)
        x = 110
        for g in sorted(font['glyphs'], key=lambda g: g['code']):
            if g['w']:
                img = Image.frombytes('L', (g['w'], g['h']), g['px'])
                m = max(img.getdata()) or 1
                row.paste(img.point(lambda v: 255 if v else 30) if m < 8 else img, (x, 3))
            x += g['w'] + 2
        rows.append(row)
    sheet = Image.new('L', (max(r.width for r in rows), sum(r.height for r in rows)), 30)
    y = 0
    for r in rows:
        sheet.paste(r, (0, y)); y += r.height
    sheet.resize((sheet.width * 2, sheet.height * 2), Image.NEAREST).save(out)
