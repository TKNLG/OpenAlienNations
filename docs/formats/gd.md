# `.gd` sprite archives

Used by `dv.gd` (all world sprites, 1940 entries), `mainmenu.gd` (menus) and
`<RACE>/interface.gd` (HUD, 103 entries each). `.OD` files (`dv.OD`, `interface.OD`) use the
same container. Status: **fully decoded and verified** against all 103 `PIMONS/interface.gd`
entries and a sample of `dv.gd` (buildings, units, nature).

**Gold Edition:** `Addon.gd` / `Addon.od` (ships, harbour, shipyard, palms, fish, gecko, crab;
289 entries) use the same container, and the Gold `mainmenu.gd` adds eight `...AO`/add-on
screens; see [addon.md](addon.md) 3.

All integers are little-endian. Offsets are absolute file offsets unless stated otherwise.

## Container

```
u32 names_off        start of the name pool (NUL-terminated cp1252 strings)
u32 (same value)
u32 name_index_off   table of u32 offsets into the name pool, indexed by name number
u32 records_off      first entry record
u32 pixels_off       base of the pixel data region
u32 count            number of entry records
```

### Entry records

Records are walked sequentially starting at `records_off`, `count` of them:

```
u32 size      bytes from the start of this record to its payload (12 for image entries)
u32 kind      0 = named image; other values carry no image (skip)
u32 name_no   index into the name index table
```

For `kind == 0` the payload is a 52-byte **image descriptor**, after which the next record
starts:

```
+0   u32 52                      descriptor size
+4   i32 left, top, right, bottom   bounding box; width = right-left, height = bottom-top
+20  u32 width, height           repeated
+28  u32 x2                      runtime pointers left in the file -- ignore
+36  u32 frame_count
+40  u16 encoding                4 for every known entry
+42  u16 (4)
+44  u32 data_off                pixel data, relative to pixels_off
+48  u32 0
```

Entry names are logical paths. Pixel data is laid out in the opposite order to the records.

## Pixel data block

At `pixels_off + data_off`:

```
+0   u32 0
+4   u32 1
+8   u32 total block size
+12  u32 offset of the first frame, relative to the block start (52)
```

### Frame chain

Each frame starts with:

```
i32 frame_index
u32 delta to the next frame header (0 on the last frame)
```

followed directly by the frame's opcode stream. The 4 bytes immediately before a frame header
hold the delta back to the previous frame.

### Frames are deltas

Frame 0 is painted onto a fully transparent canvas of width x height. **Frame N is painted on
top of the finished frame N-1**. To show frame N, all frames 0..N have to be applied in order
(cache the results).

### Opcode stream

A sequence of `u16` opcodes, each optionally followed by pixel data. Low 4 bits = command,
upper 12 bits = `n`. A cursor starts at pixel (0,0).

| cmd | meaning | data after the opcode |
|---|---|---|
| 0 | write `n+1` literal pixels at the cursor, advancing it | `(n+1)` x u32 pixel |
| 1 | write one pixel value `n+2` times | 1 x u32 pixel |
| 2 | move the cursor to column 0 of the row `n+1` rows below the current row | none |
| 3 | advance the cursor by `n+1` pixels, leaving them unchanged | none |
| 4 | end of frame | none |

### Pixel values

`u32` = bytes B, G, R, A (i.e. `0xAARRGGBB`). Colour is **premultiplied**: each colour
channel is clamped to at most A before use. A = 0 is fully transparent, A = 255 opaque.
Values in between are soft edges and the semi-transparent drop shadows.

The original engine converted these to RGB565 plus a separate 8-bit alpha plane at draw
time. A new renderer can use them as RGBA directly.

## `.ic` files

`mainmenu.ic` and `interface.ic` are caches the original game writes on first run: a bitmap
of "already decoded" flags followed by each entry's frames in the engine's RGB565 + alpha
form. They are derived data. A rebuild doesn't need them and should never ship them.

## Name conventions (dv.gd)

`<owner>\<category>\<object>\<sequence><direction-or-index>`

- owner: `PI` Pimmons, `AZ` Amazons, `SA` Sajiki, `RS` neutral resources/nature, `BULLET`
  projectiles, `BIPI`/`BIAZ`/`BISA` small icons (`MI`)
- category: `VE` units/creatures/nature objects, `BU` buildings
- building sequences: `BU0` = 10 construction stages, `MS0` = the finished building, with
  transparent holes where its layers go. The layers are `DO0` (Amazon houses: `DO`) for the door,
  `PE0` for the work animation and `RA0..RA3` for random animations. Roles and timing:
  `docs/rendering/objects.md`.
- unit sequences: two-letter action code (`WO`, `MG`, `CA`, `ID`, ...) + direction 0-7

Action-code meanings are still to be mapped.

## Images without alpha

A few large interface images store colour in every pixel but alpha 0 throughout, for example
`INTERFACE1024` (the 192x768 side panel) in each race's `interface.gd`. Their descriptors don't
differ from other entries. Read literally they would be fully transparent; the game shows them as
solid panels. Rule used by the rebuild for the interface archives (`*/interface.gd`,
`mainmenu.gd`): if a sprite writes non-zero colour but never a non-zero alpha, decode it as fully
opaque (alpha 255 for every written pixel). Do **not** apply this to `dv.gd`: some building door
frames there (`...\DO0`) store their invisible pixels as ground colour with alpha 0, and they
must stay transparent.
