# Small formats: `.os` terrain, `.dvf` fonts, `.tdb` text

All little-endian. All three are **fully decoded and verified** by rendering every file.

## `.os` terrain tile sets

15 files: `wiese` (meadow), `gelbgras` (yellow grass), `gruenwald` (green forest floor),
`waldboden` (forest floor), `rock`, `schnee` (snow), `weg` (path), `wasser1..4` (open water,
4 animation frames), `transition1..4` (shoreline pieces, 4 animation frames).

```
u32 0
u32 tile_count
tile_count x {
    16 bytes   GUID (same GUID in every tile of every file -- a format/type id)
    u32 width  (64)
    u32 height (64)
    u32 0
    u32 255
    u32 weight      255 for plain tiles, 32..192 for decorated variants
    width*height x u32 pixel, bytes B,G,R,x (no alpha)
}
```

The `weight` is very likely a random-selection weight for scattering tile variants. Still to
be confirmed against the map generator.

The 14 transition tiles are edge and corner pieces between water and land.

## `.dvf` bitmap fonts

10 files.

```
char[4] "tnof"
u32 glyph_count
u32 height        (all glyphs share it)
u32 baseline
glyph_count x { u32 char_code (cp1252), u32 width, u32 data_off (absolute), u32 0x20000 }
glyph data: width*height bytes, row-major, 1 byte per pixel = coverage 0..255
```

Some fonts are 1-bit (0/255), others anti-aliased. Most decorative fonts have upper case only.

## `.tdb` string tables

`DV.tdb` (325 UI strings), `Mentor.tdb` (82 advisor lines, matching the WAVs in
`SOUND/mentor/NNN.wav`).

```
repeat to EOF: u32 id, u32 byte_len (including the NUL), byte_len bytes cp1252 text
```

The GOG build is the German text set.

**Gold Edition:** `dvge.exe` sizes the table for 331 strings and loads `Addon.tdb` (ids 325..330:
"Addon:", "Addon Kampagnen", fishing and boarding texts) into the same table right after
`DV.tdb`, in every game. See [addon.md](addon.md) 5.
