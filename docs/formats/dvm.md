# `.dvm` maps

Status: **object list understood, terrain not yet located.** The game also writes this format
(the same header is produced by its save routine), so it doubles as a map/scenario
serialisation.

```
char[4] "SMVD"
u32 version     100
u32 object_count
object_count x 28-byte record:
    i32 class        2 = nature object, 0/1 = player-related (buildings/units?)
    i32 a            6 for nature objects, else a small number 0..2
    i32 type         object type id (9..37 seen for nature in Pimmon0)
    i32 owner        -1 for nature, else player 0..2
    i32 x            tile x, 0..map_size-1
    i32 y            tile y
    i32 z            0..~570; meaning unknown (variant / growth / random seed?)
trailing block       32..1304 bytes, structure unknown (players, goals, scripted events?)
```

Map size is implied by the coordinate range: 128, 256 or 512 square.

**Open question: there is no terrain grid in the file.** Nature objects (trees, rocks) are
placed individually, but the ground (meadow/forest/water/snow) is not stored. Either it is
generated from a seed or rules, or it comes from the trailing block or the object list. This
is the next target for the analysis track: the loader is reached from the `SMVD` writer at
`AN.exe 0x00411160`.

> **Update (analysis pass 2):** the terrain question above is resolved: terrain is generated from
> the mission's seed, see [terrain-gen.md](terrain-gen.md). The record fields and the trailing
> block are now fully decoded below; where this conflicts with the first reading above, the
> sections below win. Reader: `tools/dvm_dump.py` (`--check <Data dir>` parses all 35 maps and
> verifies that every byte is consumed: all pass).

Legend: **C** = seen in the game's loader code, **D** = confirmed by the shipped data only,
**I** = inferred.

## Header (C)

`"SMVD"`, version `100`, object count. The loader does not check magic or version. The
mission record names the file (`.mdb` offset 0xA08); a mission with an empty name loads no map.

> **Gold Edition (`dvge.exe`):** when the mission's seed is **-2**, an `n x n` terrain block
> (`u16 height, u8 tile` per cell, index `y*n + x`, `n` from the mission's size bits) follows the
> 12-byte header, and a unit record of type 67 (transport ship) is followed by a cargo list
> (`u32 count`, `count x u32 unit type`). All add-on maps use both. Format, tile numbering and the
> 32 add-on maps: [addon.md](addon.md) 8.

## Object record, decoded (C)

```
+0   i32 class       0 = unit, 1 = building, 2 = nature
+4   i32 group       owning race 0 Amazons / 1 Pimmons / 2 Sajiki, or 6 = nature
                     (the "a" of the first reading). Every record with group 6 is treated as
                     class 2 whatever its class field says.
+8   i32 type        object type within the group (dv.odb id = group << 16 | type)
+12  i32 settlement  id of the settlement the object belongs to (the "owner" of the first
                     reading); -1 for nature. Ids are chosen by the map: the town hall record
                     defines the id, other objects refer to it.
+16  i32 x, y        cell coordinates
+24  i32 z           ground height of that cell (D: equals the generated terrain height in
                     40,938 of 40,961 records; the other 23 (11 nature, 10 units, 2 buildings)
                     differ by -20..+17. They are cells levelled by building foundations,
                     units-and-jobs.md 6.6: replaying the foundations reproduces 18 of the 23
                     exactly, and the rest are I: editor placement order)
```

The game ignores the stored z: every object's height is re-read from the generated terrain
cell when the object is created (C). A rebuild can skip the field; a map writer should store the
cell's terrain height to stay compatible.

### Creation order (C)

The loader first reads all records and sorts them into three queues, then creates objects in this
order. Nature objects are created immediately while reading.

1. **Nature** (class 2): one nature object of the given type at the position. `settlement` is
   ignored.
2. **Town halls** (class 1 with type 40): for the race `group`, found a new settlement with id
   `settlement` at the position, create the town hall in it and complete it. If the building has a
   resident worker type (dv.odb +0xD8, for the town hall the city founder, type 10) that unit is
   created inside it. The new settlement's nine goods counters are set from the mission's race
   block (column 1 for the race's first settlement, column 2 for its second; see mdb.md).
3. **Other buildings** (class 1): attached to the race's settlement whose id equals
   `settlement`; skipped if none exists. The building starts complete and at full hit points (C:
   every object starts at its dv.odb +0xAC maximum). If the type has a resident worker
   (dv.odb +0xD8) that unit is created inside. Houses (types 37 and 38) are remembered for step 5.
   Outposts (dv.odb behaviour +0xC0 = 6) are garrisoned with dv.odb +0xDC soldiers of type 29.
4. **Units** (class 0): created for the race, attached to the settlement with the matching id if
   there is one (otherwise free). Facing is random 0..7.
5. **Housing**: every unit created in steps 3 and 4 is moved into a house of its own race and
   settlement that still has room (house occupancy < dv.odb +0xB4 capacity), in creation order.

Random numbers: unit facings use the same C runtime `rand()` stream as the terrain generator, so
the order above matters for exact replays (I: only cosmetic).

After the objects, the loader sets the diplomatic relations from the mission (see mdb.md
"Relations").

> **Correction / addition (from `dvge.exe` `004144e0`, `00465d00`, `00466590`; same structure in
> AN.exe):** completing a map town hall also spawns **one builder (11) and two porters (9)**
> right after its founder, and completing a map house (37/38) spawns **one porter (9)** when it
> has room (all shipped houses do). Every created object gets the next free object id (0, 1,
> 2, ... in creation order: nature, town halls with their 4 units, other buildings with operator /
> house porter / outpost archers, units, then Gold ship cargo). The Gold mission goals 17 and 18
> refer to objects by these ids; see [addon.md](addon.md) 8.4.

## Trailing block (C)

Directly after the last object record:

```
5 x point list:
    u32 count
    count x { i32 x, i32 y, i32 z }      z is always 0 in the shipped maps
i32 camera_x, camera_y                   initial view centre, in cells
u32 order_count
order_count x { i32 x1, y1, z1, i32 x2, y2, z2 }   24 bytes
```

### The five point lists

They are the same lists the random-map generator builds for free play; a scenario stores them so
the computer players know where resources are. In file order:

| # | list | used for |
|---|---|---|
| 0 | forest regions | centres of tree clusters; the AI asks for this list when it looks for trees (behaviour 8) or animals (behaviour 7) |
| 1 | stone regions | centres of rock clusters; AI search for stone (behaviour 13) |
| 2 | bush regions | centres of bush clusters; AI search for bushes (behaviour 9) |
| 3 | start candidates | candidate start positions (generator: random cells with suitable terrain) |
| 4 | start positions | chosen player start points (generator: candidate minus 3 in x and y, after levelling a 9 x 9 area) |

The AI uses lists 0 and 1 when choosing where to found a new settlement (Amazons look at forest
regions first, Pimmons and Sajiki at stone regions first; C, details belong to the AI spec). List 4 is consumed in free play: each player takes the
next start position (C). Old maps (Pimmon0/1, Tutorial0..2, Amazon0) have all five lists empty.
Coordinates may lie slightly outside the map (e.g. -3); they wrap like all map coordinates.

### Camera

The 8 bytes set the initial scroll position. The game then shifts both coordinates by
`(ground height at that cell - base height) / 44` (C; isometric height compensation, base height is
a renderer constant).

### Orders (initial jobs)

Each 24-byte order gives one object a starting job. The source object is the object standing on
cell (x1, y1); orders whose source cell is empty are ignored. By the source's type (C):

| source type | effect |
|---|---|
| 29..36 (soldiers) | adds (x2, y2, z2) as a patrol/guard waypoint; up to 8 per soldier, in file order. A waypoint equal to the soldier's own cell means "guard here". z2 is 0 in the data |
| 17 (hunter) | hunting job aimed at the position (x2, y2, z2) (the target animal moves, so a position is stored, not an object) |
| any other | work job on the object standing on (x2, y2): carriers on bushes, cocoa and mushrooms, woodcutters on trees, stonemasons on stones (D). Ignored if that cell has no object |

Each job is started with a random delay of 1..5 scheduler ticks (C).

Seen in the data: 142 orders in 20 maps (83 soldier waypoints, 48 gatherer jobs, 11 hunter jobs).
