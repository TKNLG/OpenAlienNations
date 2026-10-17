# Drawing the terrain

Builds on world-projection.md and terrain-gen.md.

## Tiles belong to vertices

The tile chosen for map cell (x, y) in terrain generation belongs to **grid vertex (x, y)**. The
quad of cell (x, y) spans the four vertices (x, y), (x+1, y), (x, y+1), (x+1, y+1). On screen
(world-projection.md: +x runs down-left, +y down-right) they are the quad's top, left, right and
bottom corner.

**Texture corners (C+I, both renderers of AN.exe and dvge.exe, see "Sources" below).** Name the
corners by texture coordinate (u = texture column, v = texture row, 0..1). The original maps the
64 × 64 tile onto the quad like this:

| corner | texture position | vertex | screen corner |
|---|---|---|---|
| c0 | (0, 0) | (x+1, y+1) | bottom |
| c1 | (1, 0) | (x, y+1) | right |
| c2 | (0, 1) | (x+1, y) | left |
| c3 | (1, 1) | (x, y) | top |

So the texture's (0,0) corner sits at the **bottom** of the diamond, u grows towards the right
corner and v towards the left corner. This is a mirror image (not a rotation) of the tile, which
matters for the look of the art: the shoreline and water tiles have direction-dependent detail
(ripples, foam texture), and a rotated mapping shows every coast mirrored.

**Two triangles, split left–right (C+I).** The Direct3D path of dvge.exe draws each quad as a
triangle fan of the four corners in the order left, top, right, bottom (`004412a0`, primitive type
6, vertex format 0x1C4), i.e. the triangles (left, top, right) and (left, right, bottom): the
diagonal joins the **left and right** corner. The software path (AN.exe `0043e4c0`, dvge.exe
`00442540`; rasteriser AN.exe `0043dfb0`, dvge.exe `00442030`) fills the four-corner polygon with scanlines and
interpolates texture position and light linearly along the polygon edges and then along each
scanline. Above both the left and the right corner and below both, that is exactly the same as the
two triangles split left–right; only in the thin band between the heights of the left and right
corner it differs slightly. A rebuild draws two triangles split left–right. (Splitting top–bottom
instead bends every non-flat quad the other way: shorelines, slopes and the light gradient then
fold along the wrong diagonal.)

## Tile sets as the original numbers them

Each loaded tile set carries a **set id**, and every tile knows its set (C, `00492960`):

| set id | set |
|---|---|
| 0 | weg |
| 1 | schnee |
| 2 | rock |
| 3 | wiese |
| 4 | waldboden |
| 5 | gruenwald |
| 6 | gelbgras |
| 7 | wasser1 when used as an ordinary land class (only the add-on's open sea, class 9) |
| W, W+1, W+2, W+3 | the animated water class: `wasser1..4`, W = the water class number (11 base, 10 add-on) |

The land classes of terrain-gen.md / addon.md 8.3 are just indices into this list (base:
3, 6, 1, 2, 4, 4, 5, 4, 6, 5, 0; add-on: 0, 0, 1, 2, 3, 4, 5, 6, 0, 7), so several classes share a
set id (all `weg` classes are set 0, all `waldboden` classes set 4, and so on).

## Choosing what to draw for a quad (C, dvge.exe `004412a0` / `00442540`, `00449a40`)

Take the set id of the tile of each corner c0..c3 (after the water animation of the next section
has been applied to the vertex's tile). Then:

1. **All four set ids equal:** draw the tile of corner **c0** (the bottom vertex, (x+1, y+1))
   unblended. That covers plain land, plain animated water (all four corners animated water of the
   same frame) and the add-on's open sea (all four class 9).
2. **Otherwise** look the four set ids up in a texture cache keyed by
   `c0 | c1 << 8 | c2 << 16 | c3 << 24`:
   - The **shoreline tiles** are put into that cache at load time (next table), so a quad whose
     land corners are all **weg (set 0)** and whose water corners are all **animated water of the
     current frame f (set W+f)** draws shoreline tile `transition{f+1}`, entry i.
   - Any other key is a **bilinear blend** of the four corner tiles, built once and cached under
     the key. Texel (s, t) with s, t = 0..63 is
     `( c0·(63-s)(63-t) + c1·s(63-t) + c2·(63-s)t + c3·s·t ) / sum of the four weights`, per
     colour channel (stored as 4 bits per channel in the cache). This makes the soft transitions
     between meadow, forest floor, snow and so on.

**Shoreline table (C, `00492fa0..004931a0`, table at `0x4BD208` in dvge.exe, `0x4B0048` in
AN.exe, identical).** Fourteen 4-byte entries, one per tile of `transition1..4` (the same 14 tiles
in each of the four animation sets). Each byte is 1 for water, 0 for land; the loader replaces a 1
by W + f and reorders the bytes (b0 b1 b2 b3) into the key order (c0 c1 c2 c3) = (b2 b0 b3 b1).
Resulting water corners per tile:

| tile | raw bytes | water corners (uv) | water side of the texture |
|---|---|---|---|
| 0 | 0 1 0 1 | c2, c3 | bottom half (v = 1) |
| 1 | 1 1 0 0 | c1, c3 | right half (u = 1) |
| 2 | 1 0 1 0 | c0, c1 | top half (v = 0) |
| 3 | 0 0 1 1 | c0, c2 | left half (u = 0) |
| 4 | 0 1 0 0 | c3 | corner (1, 1) |
| 5 | 1 0 0 0 | c1 | corner (1, 0) |
| 6 | 0 0 1 0 | c0 | corner (0, 0) |
| 7 | 0 0 0 1 | c2 | corner (0, 1) |
| 8 | 1 1 0 1 | c1, c2, c3 | all but corner (0, 0) |
| 9 | 1 1 1 0 | c0, c1, c3 | all but corner (0, 1) |
| 10 | 1 0 1 1 | c0, c1, c2 | all but corner (1, 1) |
| 11 | 0 1 1 1 | c0, c2, c3 | all but corner (1, 0) |
| 12 | 1 0 0 1 | c1, c2 | two opposite corners (1,0) and (0,1) |
| 13 | 0 1 1 0 | c0, c3 | two opposite corners (0,0) and (1,1) |

(D: sampling each tile's pixels near its four texture corners for water blue gives exactly this
table in all four sets.) There are no separate foam or beach sprites: the bright foam line and the
light shallow-water band are painted into these tiles. In every tile the foam crosses a texture
edge about 16 px from the land corner, so neighbouring shoreline tiles join up. The 14 tiles are
four rotations each of four masters (straight, one water corner, three water corners) plus the two
diagonal tiles (D).

Consequences:

- **Base game:** lakes are ringed by path (`weg`) cells (terrain-gen.md), so every mixed
  land/water quad shows a shoreline tile. A water quad whose land corner is not `weg` would get
  the blurry bilinear blend instead (does not happen with generated terrain; foundations and worn
  paths only ever write `weg`).
- **Add-on maps:** the land ring around the sea is the beach class 0 (`weg`, set 0) and the
  coastal water ring is class 10 (animated, set W+f), so every coast quad shows a shoreline tile.
  The open sea (class 9) is set 7, which is not "water" for the key: a quad mixing class-9 and
  class-10 corners (the outer edge of the coastal ring, about 37,000 quads in the 30 campaign maps)
  is a **bilinear blend** of the static `wasser1` tile and the animated water tile; it never shows
  shoreline art. Quads mixing land and class 9 do not occur (sea rule, addon.md 8.3).

**Cache quirk (C).** The cache key holds only set ids, not the tile variants. The first quad drawn
with a given key decides the blended texture, and every later quad with the same key (anywhere on
the map, until the game session ends, `00411aa0`) reuses it, whatever its corners' variants. Which
quad comes first depends on where the camera has been, so the exact pixels are not reproducible.
*(Not reproduced in this rebuild: it blends each quad's own corner tiles. Same look at a glance.)*

## Animated water (C, timer AN.exe `00443a10`, dvge.exe `00447af0`; frame builder `00445e40` / `00449f60`)

A global frame offset starts at 0. At the start of drawing a game-view frame, if more than 1000 ms
(GetTickCount) have passed since the last change, it advances by 4 (one `wasser` set of 4 tiles)
and wraps from 16 to 0: **four frames, about one second each.** When the frame builder copies a
vertex whose tile belongs to the animated water class (set id W), it adds the offset to the tile
number, so the vertex shows the same variant of `wasser{f+1}` (set W+f). Shoreline lookups then
find the `transition{f+1}` tile of the same frame. Add-on open sea (class 9) is never animated.

## Draw order

The ground is drawn first, as one pass over the visible quads, row by row from the top of the
screen, each quad with the rule above; shorelines are ordinary terrain quads, not overlays. Objects
(nature, buildings, units, ships) are drawn afterwards over the ground (objects.md).

## Base game and Gold Edition

Identical drawing code (same instructions at shifted addresses: AN.exe `0043e4c0` = dvge.exe
`00442540`, `00445920` = `00449a40`, `00445e40` = `00449f60`, `00486050` = `00492960`; shoreline
table and loader the same).
Gold differs only in what it feeds in: the add-on class tables, water class 10 instead of 11, the
open-sea class 9 drawn as an ordinary land set, and the extra Direct3D path, which maps textures
and splits quads exactly like the software path.

## Sources

| what | AN.exe | dvge.exe |
|---|---|---|
| quad loop, software | `0043e4c0` | `00442540` (texture position per corner, in texels: left (0, 63.75), top (63, 63.75), right (63, 0), bottom (0, 0)) |
| quad loop, Direct3D | - | `004412a0` (fan left, top, right, bottom with uv (0,1), (1,1), (1,0), (0,0)) |
| polygon rasteriser | `0043dfb0` | `00442030` |
| blend + cache lookup | `00445920` | `00449a40` |
| tile sets, shoreline table | `00486050` | `00492960` (table loop `00492ff4`) |
| frame builder (vertex list, water offset) | `00445e40` | `00449f60` |
| water frame timer | `00443a10` | `00447af0` |

Which polygon corner is which screen corner follows from the frame builder's vertex rows (row r
holds (X - j, Y + j), row r+1 holds (X + 1 - j, Y + j) half a cell further left and down) and from
the quad loop's own clipping tests (the corner tested against the right clip edge is the left
corner, the one tested against the bottom edge is the top corner, and so on).

## Ground that changes during play

The terrain is not static after generation (`units-and-jobs.md` 4.5 and 6.6):

- A **building foundation** sets the heights of the building's pad (footprint plus one cell on
  every side) to one level and gives every pad vertex a **weg** tile (class 10, tiles 0..7). Light
  is recomputed for the pad plus one more cell around it. The drawing rules above need nothing
  special. Quads whose four corners are all weg draw plain path. The quads at the pad's border
  have mixed corners and get the normal bilinear blend into the surrounding land. That blend is
  the soft gravel edge the player sees. There are no foundation edge or transition tiles, and the
  look is the same for every race and building type.
- A **worn path** changes one vertex's tile to weg. The four quads around that vertex blend
  accordingly.
- Neither is undone when a building is destroyed.

**Refresh in the original** (C): every changed cell gets a dirty bit (flags byte bit 0x40). The
frame builder (`00445e40`) clears it when it copies the cell into its vertex list. When a
building is placed less than 10 cells from the view centre, the terrain view is also redrawn
completely on the next frame. **Our renderer**: rebuild every 32 × 32 chunk that contains a quad
touching a changed vertex: the pad grown by one cell for a foundation (because of light), the
four quads around the vertex for a worn path.

## Brightness

Each vertex's light value (128..239; formula and worked values in terrain-gen.md step 5)
modulates the tile colour like a grey vertex colour, interpolated across the quad. The light is
computed once at generation and recomputed locally after a foundation changes heights (same
function, `00447b90`); the frame builder just copies the stored byte, nothing is cached or
recomputed per frame.

Scale of the modulation (C+I):

- Direct3D path (dvge.exe `004412a0`): the vertex diffuse colour is the grey (L, L, L) with L the
  light byte (halved per channel for fogged vertices, see below), so with the default
  texture-modulate stage the pixel is **tile colour × L / 255**: flat ground (162) at about 0.635
  of the tile colour, the brightest slope (239) at 0.937, the darkest (128) at 0.502. The
  stage-0 blend mode itself was not traced; this assumes Direct3D's default (modulate).
- Software path (AN.exe `0043dfb0`): light is interpolated in 16.16 fixed point, and per pixel
  its top six bits (L >> 2) multiply each 4-bit channel of the 12-bit (4:4:4) texel; the
  product is shifted into the screen's pixel format. Net effect ≈ tile colour × L / 256, the
  same as the Direct3D path within rounding.

So the light byte is an absolute brightness (255 would be the unshaded tile), not a factor
relative to flat ground. In the original, areas a player hasn't explored are drawn black,
and explored areas outside current sight at half brightness (fog of war).
