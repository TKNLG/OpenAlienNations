# Map terrain generation

The ground of every map, campaign maps included, is **generated from a seed**. Neither the map
files nor the mission files store terrain. Mission records (`*.mdb`) store the seed and the
size, and the generator below rebuilds the same terrain every time.

Status: **implemented in `tools/terrain_proto.py` and validated.** Across all 35 shipped
maps, 4 of ~40,000 hand-placed nature objects land on generated water, against ~285 expected if
the terrain were unrelated. (The 4 are still to be explained: possibly objects that may stand
in water, or an off-by-one in the shore randomisation.)

## Inputs

From the mission record (3864-byte records in `*.mdb`, see mdb.md):

- `seed` at record offset 0xA48 (int32). Campaign values are 0..32767. `-1` means a random map,
  where the game picks a seed itself and re-rolls until the start positions are valid (multiplayer
  sends the chosen seed to all clients). `-2` means "no generated terrain".
  **Gold Edition:** with `-2` the
  terrain is read from the `.dvm` file instead (add-on maps); add-on free play (`InfiniteAO.mdb`,
  seed `-1`) uses a different **island generator** with its own class table and thresholds.
  Both: [addon.md](addon.md) 8 and 9.
- `size_bits` at 0xA4C: 7, 8 or 9 -> map is 128, 256 or 512 cells square.

## Random numbers

The classic Microsoft C runtime `rand()`: state `s` (uint32), seeded with the seed,
`s = s * 214013 + 2531011 (mod 2^32)`, output `(s >> 16) & 0x7FFF`. **Every call listed below
must happen in exactly this order**, or all later terrain differs.

## Grid

`n = 1 << size_bits`, `mask = n - 1`. Cells are addressed `(x, y)` and **wrap around** at the
edges (coordinates are taken modulo n, i.e. `& mask`). Each cell has:

- `height`: uint16
- `cls`: terrain class (below)
- `light`: 0..239 shading byte (rendering only)

How the original stores a cell (C, 8 bytes, see also `fog-of-war.md` 1.1): object index (u16),
flags byte, viewer counter, height (u16), light, tile. The class has **no field of its own**.
During steps 1..3 the tile byte holds the class. Step 4 replaces it with a **global tile index**:
the tile sets of classes 0..10 are numbered one after the other in class order (a set used by
several classes gets a range for each of them), followed by the water animation sets. So a
cell's class is the range its tile index falls in. The water test of the cell flags compares the
tile index with the first index of class 11. The weg range (class 10, 9 tiles) is found at
start-up by looking for the first class whose set is `weg.os` (`0x4B3F00` first index,
`0x4B3F04` count).

These fields are **not fixed after generation**. Building foundations rewrite height, tile and
light, and worn paths rewrite the tile; both also set the cell's **path flag** (see "Changes
during play" below). The generator itself never sets the path flag, not even on lake shores.

## Terrain classes

| class | tile set | | class | tile set |
|---|---|---|---|---|
| 0 | wiese (meadow) | | 6 | gruenwald |
| 1 | gelbgras | | 7 | waldboden |
| 2 | schnee | | 8 | gelbgras |
| 3 | rock | | 9 | gruenwald |
| 4 | waldboden | | 10 | weg (path, used as lake shore) |
| 5 | waldboden | | 11 | water (wasser1..4 animation) |

Classes come in pairs (`band + variant`, variant = low bit), giving two looks per height band.

## Step 1: initial state

For every cell: `height = 0`, `cls = 8 + (x & y & 1)`.

## Step 2: hills

Repeat `(n >> 4)^2` times:

1. `x = rand() & mask`, `y = rand() & mask`, `steps = rand() & 7`, `r = rand() & 31`.
   Calls happen in this order.
2. `variant = cls(x, y) & 1`, read once before stamping.
3. Repeat `steps` times:
   - For `dy` from `-6r` to `6r`, and inside it `dx` from `-6r` to `6r` (inclusive):
     - `d2 = dx^2 + dy^2`
     - `v = 2r - (d2*r >> 6)` if `d2 < 64`, else `v = (64r) / d2` (integer division)
     - if `v != 0`: cell `(x+dx, y+dy)` gets `height += (4v) / 5` (16-bit wrap), then its band is
       recomputed from the new height: `>250` -> 2, `>200` -> 4, `>130` -> 6, else 0. If the band
       differs from `cls & ~1`, set `cls = band + variant`.
   - Then the stamp drifts: `x += rand() % (r|1) - (r >> 1)`, then `y += rand() % (r|1) -
     (r >> 1)`, then `r = clamp(r - 15 + rand() % 31, 0, 31)`.

## Step 3: lakes

Repeat `(n >> 6)^2` times:

1. `rad = rand() % 3 + 2` (2..4).
2. Find a site: loop `x = rand() & mask`, `y = rand() & mask`, then examine the square of
   cells within `rad+1` of `(x, y)`, rows outer and columns inner. Abort the site as soon as a cell
   has `height > 250` or is already water. Otherwise, with `lo`/`hi` = min/max height over the
   square, the site's level is `lo` if `hi - lo <= 20`, else 0. **Repeat until the level is
   non-zero.** (A completely flat zero-height area is also rejected.)
3. Fill: for `dy`, then `dx`, from `-(rad+1)` to `rad+1`: if `d2 <= (rad+1)^2`, set the cell's
   height to the level. If additionally `d2 <= rad^2`, the cell becomes water, except at the two
   points `(dx, dy) = (rad, 0)` and `(0, rad)`, which become water only if `rand() & 1`. Only
   those two points consume a random number.
4. Shore: for every cell within `rad+5` of the centre (square) that is not water but has water
   among its 8 neighbours, set `cls = 10` (path).

## Step 4: tile choice

For every cell, rows `y` outer and columns `x` inner: `t = rand() & 0xFF`, and the cell's tile is
`table[cls][t]`, where `table` is the 256-entry weighted lookup of the class's tile set. Build the
lookup from the `.os` tile weights `w_i`, total `W`. Tile `i` fills entries from
`floor(256*sum(w_0..w_{i-1})/W)` up to `floor(256*sum(w_0..w_i)/W)`.

## Step 5: lighting (rendering only)

Each cell's `light` comes from a surface normal built from the neighbouring heights, dotted with
a fixed sun direction, scaled and clamped to `[128, 239]`. The original computes it in floating
point. Because it only affects shading, a renderer may compute it any way that looks the same.
It does not need to be bit-exact.

## Changes during play

The generated terrain is only the starting state. Two game rules edit it permanently, and the
save game stores the whole cell array (heights, tiles, light and flags; `0044acd0` /
`0044ad70`), so the edits survive saving and loading:

- **Foundation** (`units-and-jobs.md` 6.6): every building, from the moment it is created (site,
  map-loaded building, founded town hall), levels its footprint plus a one-cell ring to the
  average height of that ring and gives every cell there a weg tile (class 10, tile
  `rand() mod 8`) and the path flag. Light is recomputed two cells around the footprint. Nothing
  is restored when the building is destroyed.
- **Worn paths** (`units-and-jobs.md` 4.5): a step of a porter, hunter, woodcutter, stonemason,
  trader or soldier turns the destination cell into a weg tile with the path flag, with
  probability 1/10, when the cell's height is below 250 and its tile is not weg yet.

The path flag makes units step faster (`units-and-jobs.md` 4.1). A rebuild that regenerates the
terrain from the seed on load must keep these edits in its saved world state.

## Rendering notes (to be specified)

- Water borders use the 14 `transition*.os` tiles, chosen by which of the tile's four corners are
  water (corner table in the original: 14 four-corner patterns).
- How land classes blend into each other is not yet specified.
