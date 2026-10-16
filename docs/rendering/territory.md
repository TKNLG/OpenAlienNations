# Territory display: border stones and the town-area tint

Status: behaviour spec from AN.exe (GOG); Gold (`dvge.exe`) is identical. Addresses are evidence
only. Legend: **C** = confirmed by reading the code, **I** = inferred, *(uncertain)* = not
settled.

The rules that decide **which** blocks belong to which town and where the border runs are in
[../game/economy.md](../game/economy.md) section 11. This document covers only how the original
shows them: the border stones in the world view (sections 1-4) and the minimap tint (section 5).

Related: `docs/game/fog-of-war.md` 1.1 (cell flags) and 5.2 (what is drawn in the fog),
`docs/rendering/objects.md` 8 (draw order and picking of objects), `docs/rendering/world-projection.md`
(screen position of a cell), `docs/ui/side-panel.md` 6.2 (minimap).

---

## 1. The sprites (C)

| race | dv.gd entry | dv.OD object | colour | frames | canvas bounds (left, top, right, bottom) | OD anchor |
|---|---|---|---|---|---|---|
| Amazons (0) | `BULLET\VE\GRENZEAZ\MS0` | group 7, type 14 | red crystal | 1 | (1, 1, 20, 19), i.e. 19 × 18 px | (8, 34) |
| Pimmons (1) | `BULLET\VE\GRENZEPI\MS0` | group 7, type 15 | blue crystal | 1 | (1, 1, 20, 19) | (7, 34) |
| Sajiki (2) | `BULLET\VE\GRENZESA\MS0` | group 7, type 16 | yellow crystal | 1 | (1, 1, 20, 19) | (8, 35) |

- Each picture is a small faceted crystal with a dark shadow to its right, drawn in the nation
  colour (handbook p. 19: "town areas are drawn in nation colour with border stones").
- Pixel encoding 4 (the normal sprite encoding of `docs/formats/gd.md`). The entries are the
  same in GOG and Gold `dv.gd`, and the OD descriptors are identical.
- The objects live in group 7 (projectiles and effects), but they are never thrown and never
  created as simulation objects (`docs/game/combat.md` 6.1, last notes).
- **One sprite per race. There are no variants, no animation, no random frame and no
  orientation.** The race is the race of the town that owns the territory, so all stones of
  one nation look the same, whichever town they belong to.

## 2. Where the stones are (C)

From `economy.md` 11.6:

- One stone per **border block** of every town territory. A border block is a 2 × 2 block owned
  by a town with at least one of its four neighbour blocks not owned by that same town.
- The stone belongs to the cell **(2bx, 2by)** of block (bx, by): the even/even cell, which is the
  top corner of the block on screen. Along a straight edge the stones are therefore **2 cells
  apart**; along a diagonal edge they form a staircase, also one per block.
- The mark is a 2-bit race field in the cell's flags byte (bits 0x0C: 1 Amazons, 2 Pimmons,
  3 Sajiki). It is not a world object: no id, no occupancy, not clickable, not on the minimap,
  no effect on paths or placement.
- No terrain test: stones appear on water, on mountains, on roads and under buildings. Checked at
  instruction level in both executables. The mark writers (`0044e7c0`, `0044f0b0`; Gold
  `004540e0`, `004549d0`) only mask the cell's flags byte with 0xF3 and OR in the race value and
  0x40. The collection test (AN.exe 0x4467D9..0x44684F, Gold the same code in `00445e40`'s twin)
  reads only bits 0x0C, the "in sight" bit 0x100 and the fog option (Gold `00449f60`, the same
  code). The draw loops (`00443a10`, Gold `00447af0`) test nothing. `Addon.od` defines no group-7 types, so the add-on uses the same three
  crystals. On the add-on's island maps a town's disc (radius 11 blocks, 20..21 cells) mostly
  reaches into the sea. Its border is therefore mostly a ring of crystals **on the open water**,
  2 cells apart along each block-axis edge (on screen: diagonal rows, 64 × 44 px apart at zoom
  1). Sea cells are flat at height 120, so the stones sit on the water surface, 8 px below base
  level.
  Full evidence table: section 2.1.
- Two touching territories show **two parallel rows** of stones, one per town, on neighbouring
  blocks (2 cells apart), each in its town's colour. Two towns of the same nation also show two
  rows, both in that nation's colour; the towns are not merged.
- Stones change at once when a territory changes (the cells are marked for redraw).

Counts for a lone, unobstructed disc: town hall or large outpost 60 stones, small outpost
32 stones.

### 2.1 Stones on water: the evidence (C, AN.exe and `dvge.exe`)

Question settled: does the original ever leave out water (or any other terrain) when it builds a
territory, writes the stone marks, or collects and draws the stones? **No, in neither edition.**
A town whose disc reaches the sea shows its border stones on the sea cells, in lines along the
disc's edge, exactly like on land. Every condition on the three paths was read in the
disassembly (not only the decompiler output):

| step | AN.exe | Gold `dvge.exe` | what is read and tested |
|---|---|---|---|
| claim and border scan (economy.md 11.3, 11.4) | `0044e9a0` | `004542c0` | Only the **block ownership map** (global `0x4B4FAC`, Gold `0x4C22D4`) and the record. The only test on a disc block is "owner = none" (compare with 0xFF); the thinning and border tests compare neighbour owners with the town id. The helpers it calls only wrap coordinates (`00401ad0`, `004485f0`, `00448620`; Gold `00401ce0`, `0044c700`, `0044c730`) or manage lists. **No map cell is read**: not the terrain tile, height, water or land flags, nor (Gold) the island-id grid |
| add / remove / handler (11.4, 11.5) | `0044e920`, `0044e830`, `004572c0` | `00454240`, `00454150`, `0045cfc0` | Message fields only. The radius is the building's odb +0xB0 (senders `0045f0d0`, `0045f5a0`, `004602d0`, message built at `0x45F2EF`, `0x45F747`, `0x4603E9`; Gold `00465370`, `00465800`, `00466590`, built at `0x46558F`, `0x4659E7`, `0x4666A9`, same code). Add-on mode loads `Addon.odb` on top of `dv.odb`, but that file adds only new types (62..67, nature): town hall and outpost radii are unchanged |
| writing the marks (11.6) | `0044e7c0`, `0044f0b0`, `0044f0f0` | `004540e0`, `004549d0`, `00454a10` | Writes the cell's flags byte unconditionally: clear bits 0x0C, then set (race table 4 / 8 / 0x0C at `0x4AFC54`, Gold `0x4BCD28`, same values) and the dirty bit 0x40. No read of any other cell field |
| collecting (frame builder) | `00445e40` (test at `0x4467DB`) | `00449f60` (test at `0x44A8FB`) | Per cell: the flags byte and the viewer counter. Collected if (flags & 0x0C) ≠ 0 and (counter > 0 or fog off). The terrain tile is read in the same walk, but only to pick the animated water frame and to mark animated cells for redraw; that does not touch the stone test |
| drawing (world frame) | `00443a10` | `00447af0` | Terrain first, then every collected stone, then objects. No later water pass exists: nothing is drawn over the stones except objects |

Gold differs from AN.exe in these functions **only by the map object's field offsets** (cells
+0x0E instead of +0x09, mask +0x12, shift +0x16; 5 bytes for the add-on flag and island grid,
`docs/formats/addon.md` 12.2) and by relocated addresses: the territory code (791 instructions),
the frame builder (927) and the world frame (401) are otherwise instruction-for-instruction the
same. So Gold adds no water test, does not clip the disc to the island, and does not flag sea
cells against territory.

Nothing else hides them on water:

- No code clears the stone bits of sea cells. The only instructions that clear bits 0x0C are
  the territory's own (`0044e4b0`, `0044e7c0`, `0044f0b0`, `0044f0f0`; Gold `00453dd0`,
  `004540e0`, `004549d0`, `00454a10`). The island generator builds the cells before any
  territory exists.
- Visibility does not exclude water: the vision disc (`0044a250`) counts every cell in the
  disc, land or water. A finished town hall sees 25 cells, more than its territory reaches
  (20..21 cells), and outposts likewise (small 15 against 10..11, large 25 against 20..21),
  so all stones of an own, completed territory are in sight, those on the sea included. Only
  while the town hall is a construction site (territory already there, no building vision) are
  the outer stones hidden in the fog, until the founder's or other units' vision reaches them.
- Sea cells have height 120 (flat), so the stones sit on the water surface like on a flat
  meadow.

**On "red cubes in lines across the water".** The Amazon stone picture (`GRENZEAZ`) is a red,
faceted, roughly cube-shaped crystal with a grey shadow to its right, so "red cubes" is the
original sprite. "In lines" is the original's layout: one stone per border block, 2 cells apart
along straight stretches, a staircase on diagonals, and two parallel rows where two territories
meet (section 2). The rebuild matches the original here; if hiding them
on water is wanted, it can only be an enhanced option (4.1).

## 3. How they are drawn (C unless marked; `00445e40`, `00443a10`, `00432b60`, `00422fe0`)

**Collection.** While the frame builder walks the visible cell grid (`00445e40`), it looks at
each cell's race field. A cell with a stone is collected when either:

- fog of war is **off**, or
- the cell is **currently visible**: its viewer counter is above 0 (`fog-of-war.md` 1.1).

So stones are **not** shown on cells that are only explored, and never on unexplored cells
(`fog-of-war.md` 5.2). Stones of every nation are shown, not only the player's own.

For each collected cell the builder records the race and the **screen point of the cell's
vertex**, with the cell's height applied, exactly as the terrain uses it
(`world-projection.md`: the vertex is the top corner of the cell's quad). The list is in grid
scan order.

**Drawing.** In the world frame (`00443a10`) the order is:

1. terrain;
2. **all collected border stones**, in collection order;
3. the depth-sorted object list (buildings, units, nature, each followed by its garrison), back
   to front (`objects.md` 8);
4. the placement ghost;
5. interface windows.

So stones are **ground decals under every object**: a building, tree or unit standing on or in
front of a stone covers it. Stones are not depth-sorted with objects and not with each other.

**Position and size.**

- The game keeps one shared display object per race (created on first use with group 7,
  type 14 + race, and freed at map reset). For each stone it moves that object so that the
  **top-left corner of its picture rectangle** is the collected screen point, then draws it. The
  OD anchor is not applied *(I: the rectangle is set directly from the point, unlike other
  objects whose rectangle is the point minus the anchor; the blit is the generic one)*. The
  stone therefore hangs just below and to the right of the block's top vertex, inside the
  block's top cell.
- The picture is scaled with the current zoom like every sprite: the three shared objects are
  rescaled when the zoom changes (`00422fe0`).
- Brightness: the stone is drawn with its own picture, not with the cell light *(uncertain:
  no light value is passed for it; since stones appear only on visible cells, fog dimming
  never applies)*.

## 4. Rebuild notes

- Take the border list per town from the engine (economy.md 11.4) or the per-cell race field; do
  not compute borders in the client from a distance rule.
- Draw each stone at the vertex of cell (2bx, 2by) with that vertex's height, picture top-left
  at that point, scaled by zoom, after the terrain and **before** all sprites (lowest sprite
  layer, or a separate decal pass).
- Show a stone only if fog is off or the cell is currently in sight.
- No selection, no tooltip, no sound.

### 4.1 Differences to our current client

Implemented in `src/client/border-stones.ts`: per-chunk (16 x 16 cells) stone lists built from
the engine's per-block stone marks whenever the territory changes, drawn by `main.ts` as a
separate sprite pass after the terrain and before the object pass, only on cells in sight with
fog on, scaled with the zoom. Remaining differences:

1. The picture's pixel block (19 x 18) is placed with its top-left corner on the vertex; the
   canvas offset (1, 1) of the `.gd` entry is not added *(I: one pixel at most)*.
2. Stones are collected chunk by chunk around the camera (grid scan order within a chunk, chunks
   row by row), not in the original's visible-cell walk order. Stones never overlap each other
   except on the duplicate-border quirk (`economy.md` 11.4), so the order is not visible.
3. **Stones on water: no difference, nothing to change in vanilla.** Our engine (no terrain test
   in `territory.ts`) and client (no terrain test in `border-stones.ts`; visibility from the
   viewer counters) put stones on lakes and on the add-on sea exactly where the original does
   (2.1). Do **not** add a water test to the vanilla rules: it would also be wrong to remove
   water blocks from the ownership map, because the block count (AI outpost rule, 11.7) and the
   first-come shapes include them.
   *Optional, only if wanted:* an enhanced display option "no border stones on
   water" (Einstellungen → Erweitert, default off). Rule: when building the stone list, skip a
   stone whose cell (2bx, 2by) is water, meaning its terrain tile belongs to the water classes
   (base: the animated water class; add-on: open sea class 9 and coastal water class 10,
   `docs/game/addon.md` 2.1). Display only: the ownership map, the border lists, the counts and
   the minimap tint stay unchanged, nothing feeds back into the simulation.

## 5. Minimap town-area tint (C, `0044d230`)

The "town areas" toggle (`STADTGEBIETE`, default off, `side-panel.md` 3) uses the same
ownership map:

- For each minimap pixel in sight, the cell under the pixel is looked up in the block map. If it
  lies in a territory, and the pixel carries **no race marker** (own or foreign object of a
  nation), its colour becomes the 50 % blend of the territory's nation colour and the pixel
  colour. The pixel colour is the ground colour, or the ground already blended with a nature
  marker colour (tree, stone, bush/animal) when the resources layer is on, so nature pixels get
  the tint on top of their own blend.
- Pixels that are only explored (half brightness) get no tint; unexplored pixels stay black.
- Because it reads the ownership map, the tint includes outpost areas, shows the exclusive
  first-come shapes and follows every change at once.

Our `minimap.ts` follows this rule: the tint comes from the engine's ownership map (rebuilt when
the territory changes), race-marker pixels are not tinted, nature-marker blends get the tint on top.
