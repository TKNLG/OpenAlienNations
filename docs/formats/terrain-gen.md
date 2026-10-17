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
- `light`: 128..239 shading byte (rendering only, step 5)

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

## Step 5: lighting (rendering only) (C, `00447b90`; Gold `0044bc70`, identical)

After the tile choice (same routine, `004492d0`) every cell gets its `light` byte from its four
direct neighbours. The light depends on heights only, so the visiting order does not matter (the
original happens to visit every column twice). Neighbours wrap like every other grid access.

**Inputs** (heights are the raw uint16 values, differences are signed integers):

- `D1 = height(x-1, y) - height(x+1, y)` (left minus right along the x axis)
- `D2 = height(x, y+1) - height(x, y-1)` (along the y axis)

The horizontal distance between the two neighbours (two cells) counts as **32 height units**.
The original builds two tangents, (2 cells, 0, -D1) and (0, 2 cells, D2) scaled to length 1,
takes their cross product as the surface normal and dots it with a sun direction of
(0, 1/sqrt 2, 1/sqrt 2) in its normal space. Written out:

    light = trunc( (1024 + 32 * D1) / ( sqrt(D1^2 + 1024) * sqrt(D2^2 + 1024) ) * sqrt(1/2) * 320 - 64 )

then clamped: below **128** becomes 128, **240 and above** becomes 239. (The lower bound is the
global `0x4AFAA0`, value 128, never written; Gold `0x4BCB3C`, also 128.)

Consequences: only the x slope decides bright or dark. Ground that falls towards +x (left
neighbour higher) is lit, ground that rises towards +x is dark. Any y slope only divides by
`sqrt(D2^2 + 1024)` and so always darkens, symmetric in its sign. Flat ground is **162**.

**Exact evaluation** (x87, 53-bit precision: the game uses only DirectDraw, so the C runtime's
default precision stays in force). Steps in the original's order, "f32" meaning a value stored
to a 32-bit float and read back, everything else in double precision:

1. `s1 = sqrt(D1^2 + 1024)`; `p = f32(-32 / s1)`; `u = D1 / s1`.
2. `s2 = sqrt(D2^2 + 1024)`; `q = f32(-32 / s2)`.
3. Normal components used: `Y = f32(-(q * u))` (= 32 D1 / (s1 s2)) and `Z = q * p`
   (= 1024 / (s1 s2); a product of two f32 values, exact in double). The third component
   (built from `D2 / s2`) is multiplied by a sun component of 0 and drops out.
4. `r = f32(sqrt 2)` (1.41421353816986…); `kd = 1 / r` in double, `kf = f32(kd)`.
5. `v = (Z * kd + 0) + kf * Y`, then `v = v * 320 - 64`.
6. Convert with truncation towards zero (the runtime's float-to-int sets round-to-zero, 64-bit
   result, low 32 bits used), then clamp as above.

The f32 roundings matter only exactly at integer boundaries. Over all `D1` in -300..300 and
`D2` in 0..300 the plain double formula differs once: `D1 = 224, D2 = 0` gives 191.99999… here
(light 191) but 192.0 in plain double arithmetic.

Worked values (`D2 = 0` unless given):

| D1 | D2 | raw value before truncation | light |
|---|---|---|---|
| 0 | 0 | 162.27 | 162 |
| 1 | 0 | 169.23 | 169 |
| -1 | 0 | 155.10 | 155 |
| 2 | 0 | 175.95 | 175 |
| -2 | 0 | 147.72 | 147 |
| 4 | 0 | 188.59 | 188 |
| -4 | 0 | 132.46 | 132 |
| 8 | 0 | 210.40 | 210 |
| -8 | 0 | 100.64 | 128 (clamp) |
| 16 | 0 | 239.58 | 239 |
| 32 | 0 | 255.99999 | 239 (clamp) |
| 100 | 0 | 220.47 | 220 |
| -100 | 0 | -210.55 | 128 (clamp) |
| 224 | 0 | 191.99999 | 191 |
| 0 | ±4 | 160.53 | 160 |
| 0 | 8 | 155.52 | 155 |
| 0 | ±16 | 138.39 | 138 |
| 0 | 32 | 96.0 | 128 (clamp) |
| 8 | 8 | 202.20 | 202 |
| -4 | 4 | 130.94 | 130 |
| 20 | 20 | 200.41 | 200 |

**Where it is stored, when it changes.** The result is the cell's light byte (cell offset +6).
Nothing else is cached: no table and no per-frame recomputation (the generator's routine also
fills two temporary per-column arrays it never reads). The light is computed with this same
function by the full pass above, by the lake fill (`00448d90`, overwritten by the full pass
afterwards) and by a building foundation (`00448210`, see below). The frame builder copies it
into each vertex (terrain-drawing.md, "Brightness"); sprites use it too (fog-of-war.md 5.3).
It never feeds a game rule. The minimap's slope shading is a separate integer rule
(around `0044ccf0`: 192 + 8 times one height difference, clamped to the same 128..239
bounds; side-panel.md 6.1), not this function.

## Changes during play

The generated terrain is only the starting state. Two game rules edit it permanently, and the
save game stores the whole cell array (heights, tiles, light and flags; `0044acd0` /
`0044ad70`), so the edits survive saving and loading:

- **Foundation** (`units-and-jobs.md` 6.6): every building, from the moment it is created (site,
  map-loaded building, founded town hall), levels its footprint plus a one-cell ring to the
  average height of that ring and gives every cell there a weg tile (class 10, tile
  `rand() mod 8`) and the path flag. Light (step 5 formula) is recomputed for the levelled pad
  grown by one cell on every side, i.e. two cells around the footprint. Nothing
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
