# Object descriptions (`dv.OD`) and the object database (`dv.odb`)

## Object ids

Every game object type has an id `group << 16 | type`.

| group | content |
|---|---|
| 0 | Amazons: types 9..36 units (28), 56.. buildings (25) |
| 1 | Pimmons: same layout |
| 2 | Sajiki: same layout |
| 3, 4, 5 | present in `.OD` only (53 each): the HUD mini icons `BIAZ\MI\..`, `BIPI\MI\..`, `BISA\MI\..` (one 45x45 sprite per type; see `docs/rendering/objects.md` 1) |
| 6 | nature and resources: 0..8 goods (wood, stone, iron, food, weapons, ...), 9..12 trees, 13..16 bushes, 17..20 cocoa, 21..24 mushrooms, 25..28 maggots, 29..32 stones, 33..37 animals, 38 rubble |
| 7 | projectiles and effects |

Map files (`.dvm`) refer to objects by `(group, type)`: in a map record, `a` is the group and
`type` is the type.

## `dv.OD`: object -> sprites

Status: **fully parsed** (368 objects, the record region is consumed exactly).

Header, 7 x u32:

```
+0   28 (header size)
+4   names_off        name pool (same names as dv.gd)
+8   name_index_off   u32 per name -> offset into the pool
+12  records_off      first object record
+16  anim_base        base of the animation descriptor region
+20  1940             number of names
+24  object_count     368
```

Object records follow each other directly. Their size depends on `kind`:

```
+0   u32 20
+4   u32 kind          0 = creature/nature (0xC4 bytes), 1 = building (0x2C), 2 = other (0x28)
+8   u32 object id     group << 16 | type
+12  i32 anchor_x      object's ground point in sprite-canvas coordinates
+16  i32 anchor_y
+20  i32 x 4           union bounding box of all its sprites (left, top, right, bottom)
+36  i32 slots[]       kind 0: 40 slots (5 actions x 8 directions, slot = action*8 + dir)
                       kind 1: 2 slots (BU0 construction stages, MS0 finished building
                               with its extra layers)
                       kind 2: 1 slot
                       -1 = no sprite for that slot
```

A slot value `s` points to an animation descriptor at `anim_base + s`. The u32 at descriptor
offset +0x3C is a **name number**, i.e. the sprite's name in `dv.gd`. The descriptor is now
fully decoded: a 32-byte header (union rect, **layer count** at +0x10) followed by 32-byte layer
records (rect, speed in fps at +0x10, role/mode flags at +0x14, frame count, name). Finished
buildings carry extra layers (door `DO0`/`DO`, work `PE0`, random `RA0..RA3`) that are **not**
separate slots. Layout, flag values and how the game uses them: `docs/rendering/objects.md` 1-4.
Take layer names from these records. Guessing them from `MS0` misses the Amazon house doors,
which are named `...\DO`.

### Drawing an object

A sprite's rect in `dv.gd` (left, top, right, bottom) is in the same canvas coordinates as the
anchor. To draw an object standing at screen point P, put the sprite's top-left corner at
`P - anchor + (left, top)`.

### Action slots (units/nature), first reading

| action | code examples | meaning (guess) |
|---|---|---|
| 0 | MG, MS | move / static |
| 1 | ST | |
| 2 | WO | work |
| 3 | ID | idle |
| 4 | CA | carry |

Trees use slot 0 `MS0`, 8 `ST0`, 16 `WO0`, 32 `CA0`. Which slot is shown in which state:
`docs/rendering/objects.md` 1.1 (initial action from the record's product: raw material → 1,
wood → 4 `CA0`, else 0) and 9 (messages that change it). Buildings: slot 0 = action 0
(construction), slot 1 = action 1 (finished).

## `dv.odb`: object rules

Status: **superseded by [`odb.md`](odb.md)** (full field-by-field spec, mostly confirmed in code).
The notes below are the original first reading; where they disagree, `odb.md` wins (e.g. the
name starts at +0x14C, +0xD4 is money not time).

215 records of 396 (0x18C) bytes. Known fields:

```
+0x00  u32 object id (group << 16 | type)
+0xA0  u32 group
+0xA4  u32 kind     0 = unit, 1 = building, 2 = nature/item
+0xA8  u32 type
+0xAC  u32 (copied into every new object: capacity / hit points?)
+0xC0  i32 behaviour class (nature: 7 animal, 8 tree, 9 bush, 10 cocoa, 11 mushroom,
           12 maggots, 13 stone; buildings use other values)
+0x11C, +0x120  used by nature objects (resource amounts?)
+0x144 display name, cp1252, German ("Baum", "Trägerin", "Magierturm")
```

Mapping the remaining fields (costs, production, speeds, ranges, needs) is a dedicated work
item: read each field's use in AN.exe and cross-check against in-game values.

### Observed value patterns (hypotheses, not yet confirmed in code)

From comparing the 28 Pimmon units and 25 Pimmon buildings field by field:

| offset | units | buildings | likely meaning |
|---|---|---|---|
| +0x0C, +0x10 | - | 1..4 | building footprint in cells (w, h) |
| +0x54..+0x90 | 7 (x, y) pairs on soldier types | pairs on two buildings | sprite-relative attachment points (weapon, workers) |
| +0x94, +0x98 | - | -2..1 | entrance offset from the building origin |
| +0xAC | 50 workers, 100..250 soldiers | 350..800, town hall 10000 | hit points |
| +0xB0 | 5..15 | 0..30 | armour or capacity |
| +0xB4 | - | Wohnung 3, Große Wohnung 9, town hall 3 | housing capacity |
| +0xB8 | 0..2 | 0..8 | staff / worker slots |
| +0xD4 | 10..600 | 5..50 | training cost/time (units), build time (buildings) |
| +0xD8 | - | -1 or index | unit type trained / research unlocked here |
| +0xE4 | -1 or 0..28 | -1 or 0..29 | tech-tree position / research requirement |
| +0xE8 | 36..56 | 36, 40 | sound effect index |
| +0xF4, +0xF8, +0xFC | - | 2..20, 4..25, 0..25 | build cost: wood, stone, iron (?) |
| +0x11C, +0x120 | | | resource produced and amount (?) |
| +0x124 | 0..27 | 0..24 | menu / display order |
