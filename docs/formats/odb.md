# `dv.odb`: object rules database (field-by-field specification)

Status: **every field with a non-zero value has a meaning; most are confirmed in AN.exe.**
This file supersedes the hypotheses table at the end of `od-odb.md`.

Sources: decompiled AN.exe (addresses cited as evidence, no code reproduced), the data itself
(all 215 records), the handbook cross-check in `docs/game/rules-from-manual.md` section 19
(cited as "handbook p. N"), and `Mentor.tdb` (advisor lines, cited as `mentor#N`).
Reader: `tools/odb_dump.py [amazon|pimmon|sajiki|nature|effects|all] [--raw]`.

Legend for the status column:

- **C** confirmed: the reading code was found and understood.
- **C/h** confirmed in code and matches a handbook number.
- **I** inferred: data pattern only, no reading code found.
- **U** unused: zero (or constant) in every record and no reader found.

## 1. File framing

- Flat array of fixed-size records, 0x18C (396) bytes each, little-endian. 215 records, no header.
- The loader (`0040e770`) reads records until a short read. It stores each one in a two-level table
  indexed by **group** (+0xA0) and **type** (+0xA8). A record whose type is not below the table
  width (a global count) is dropped.
- It also appends each record to one of three per-group lists by **kind** (+0xA4): units (kind 0),
  buildings (kind 1), and animals (kind 2 with behaviour class 7). These lists drive the build menu
  (`004562d0`), the training menu (`00456130`), the town's need list (`00458cd0`) and
  population lists (`00457900`).
- Records are shared and never copied. Every game object keeps a pointer to its record at object
  +0xC (base object constructor `00461a40`). The game treats records as read-only, with one
  exception: the building constructor (`0045f0d0`) writes 2 into +0xDC of the small-outpost record
  (type 52), which already holds 2.

### Groups and types

| group | content | types |
|---|---|---|
| 0 | Amazons | units 9..36, buildings 37..61 |
| 1 | Pimmons | same type numbers, same roles |
| 2 | Sajiki | same type numbers, same roles |
| 6 | goods and nature | 0..8 goods, 9..38 nature objects |
| 7 | projectiles and effects | 0..13, 17..19 |

**Gold Edition:** add-on missions append `Addon.odb` (31 records): types 62..67 in each race
(harbour, shipyard, four ships) and group-6 types 39..51 (gecko, crab, fish, palms, aloe, venus);
the table width rises from 62 to 68. Behaviour classes **14** (ship) and **15** (fish) are new.
Tables: [addon.md](addon.md) 2.

A type number means the same role in every race, and code tests roles by type number:
9 porter, 10 founder, 11 builder, 12 criminal, 13 diplomat, 14 farmer, 17 hunter, 19 woodcutter,
20 news seller, 21 police officer, 27 stonemason, 29 archer, 37/38 houses, 40 town hall,
41 warehouse, 42 embassy, 46 laboratory, 52/53 small/large outpost, 54 police station.

Goods index (group 6 type 0..8). The same index is used in every cost array and stock array:

| idx | German | meaning |
|---|---|---|
| 0 | Rohstoff | race raw material (cocoa / mushrooms / maggots) |
| 1 | Holz | wood |
| 2 | Stein | stone |
| 3 | Eisen | iron |
| 4 | Nahrung | food |
| 5 | Waffen | weapons |
| 6 | Schokotörtchen | Amazon luxury |
| 7 | Plizschnaps | Pimmon luxury |
| 8 | Zigarillos | Sajiki luxury |

## 2. Record layout

All fields are signed 32-bit integers except the name. "obj" below means a game object that
points at the record; "town" and "player" are the owning town and nation objects.

| off | type | name | meaning | values | status | evidence |
|---|---|---|---|---|---|---|
| 0x00 | i32 | id | `group << 16 \| type` | | C | consistency only |
| 0x04 | i32 | sound_frame | animation frame from which the record's sound (+0x08) may play; also sent as a parameter of the "unit animation event" message | units 0..8, temple 12/5, effects 0/1 | C | `00435ad0`, `00477ce0`, `00473d50`, `0047ead0`, `0047f030`, `0047b490` |
| 0x08 | i32 | sound | sound effect index (index into the loaded sample table; 0 = silent) | 0..65 | C | `00435ad0`, `00434840`, `00436260` |
| 0x0C | i32 | size_y | footprint height in cells (y extent) | units/nature 1, buildings 1..4 | C | `00462870`, `00461e30`, `00441c40` |
| 0x10 | i32 | size_x | footprint width in cells (x extent) | units/nature 1, buildings 1..4 | C | same |
| 0x14..0x50 | i32 x 16 | - | always 0 | 0 | U | |
| 0x54..0x90 | (i32 x, i32 y) x 8 | points[8] | per-direction launch point (units, indexed by facing 0..7) or per-slot garrison point (outposts), as sprite-canvas pixels (the code uses anchor − point). A garrison unit's feet are drawn 22 px below its slot's point (`docs/rendering/objects.md` 13.2) | 0..216 | C | `00436020`, caller `00435ad0`; garrison drawing `00445160` |
| 0x94 | i32 | door_dx | entrance cell offset from the building's position (x) | -2..1 | C | `0045f0d0`, `00465230` |
| 0x98 | i32 | door_dy | entrance cell offset (y) | -3..1 | C | `0045f0d0` |
| 0x9C | i32 | - | always 0 | 0 | U | |
| 0xA0 | i32 | group | race / table group | 0,1,2,6,7 | C | loader |
| 0xA4 | i32 | kind | 0 unit, 1 building, 2 nature/goods/effect | | C | loader |
| 0xA8 | i32 | type | type within the group | | C | loader, everywhere |
| 0xAC | i32 | hp | maximum hit points | units 50..250, buildings 350..10000, animals 10 | C/h | `00461a40`, `0045f0d0`, `0045ab60`, `00475480`, `00483a10` |
| 0xB0 | i32 | radius | circular radius in cells: unit sight / scan range; town-hall and outpost territory; watchtower view | units 0..15, buildings 0..30 | C | `0044a7c0` callers `00473850`, `00480e70`, `00480a10`, `00479800`, `00472190`; `004602d0`, `0045f0d0`, `0045dc10`, `0046c1a0` |
| 0xB4 | i32 | residents | resident capacity (houses, town hall) | 0, 3, 9 | C/h | `004602d0`, `004605d0`, `0045fa40`, `00411200` |
| 0xB8 | u32 | flags | building flags (bits below); unit values have no reader | buildings 0,1,2,4,6,8 | C | `00459b60`, `00474b70`, `00460ed0`, `0045fa40` |
| 0xBC | i32 | - | always 0 | 0 | U | |
| 0xC0 | i32 | class | behaviour class (section 4) | -1..13 | C | `004638d0`, `00460ed0`, `00411200`, `004602d0`, `004635f0` |
| 0xC4..0xD0 | i32 x 4 | step_time[4] | ticks needed for one straight step into a cell whose height differs by class 0..3; 0 = impassable | units 5/6/7/8, animals 6/7/8/9 | C | `0047df70`, `0047e8c0`, `00474260`, `00473d50` |
| 0xD4 | i32 | money | units: training price, paid by the player; buildings: upkeep per round; goods: base market price | units 0..600, bldg 5..50, goods 5..60 | C/h | `00474b70`, `00474fd0`, `0045f360`, `0045fa40`, `0045ff30`, `0046dd50`, `00458cd0` |
| 0xD8 | i32 | operator | buildings: unit type that runs the building (-1 none) | -1 or 10..27 | C/h | `004602d0`, `00460ed0`, `00411200`, `00478cb0`, `00457900` |
| 0xDC | i32 | garrison | outposts: garrison capacity (class-2 units are admitted while occupants < it, tested at the first request), number of archers (type 29) placed inside on map load and requested by the AI | 0, 2, 3 (labor 1, unread) | C | `00460a10`, `00411200`, `004602d0`, `0046cb20` |
| 0xE0 | i32 | - | always 0 | 0 | U | |
| 0xE4 | i32 | invention | index of the invention (race's `DV.idb` list) that must be finished first; -1 = always available | -1..29 | C/h | `0045a770`, `00459b60`, `0045f360` |
| 0xE8 | i32 | made_at | type of the building where this is ordered: 40 = town hall build menu, 39/43/55/56 = training buildings; below 37 = cannot be ordered | 35..56 | C | `0045f360`, `00459b60`, `0046cb20` |
| 0xEC | i32 | - | always 0 | 0 | U | |
| 0xF0..0x110 | i32 x 9 | cost[9] | goods needed, indexed by goods index 0..8 | 0..25 | C/h | `00459b60` (5 entries), `00474b70`/`00474fd0` (6), `0045f360` (9), `00417d60` (5, tooltip) |
| 0x114 | i32 | - | 1 in every unit, 0 elsewhere; no reader found | | I/U | |
| 0x118 | i32 | - | always 0 | 0 | U | |
| 0x11C | i32 | product | buildings: goods index produced automatically; nature: goods index yielded; farmer units: first nature type they plant; -1 none | -1..25 | C | `0045fa40`, `0045ff30`, `004638d0`, `00478cb0`, `00433e10` |
| 0x120 | i32 | amount | warehouses: storage added per good to the town; other buildings: local storage per good; nature: units of goods contained | 0..25 | C/h | `0045fa40`, `0045ff30`, `0047c850`, `004638d0` |
| 0x124 | i32 | slot | list slot: position in the per-race unit/building/goods lists used by UI panels and status messages; same for a type in every race | 0..27 | C | `00457900`, `004251b0` |
| 0x128 | i32 | need_pop | buildings: population at which the town asks for this building; luxury goods: base population for the luxury need | 0, 15..45, 30 | C | `00458cd0`, `00459e80`, `00459fd0`, `0045a2c0` |
| 0x12C | i32 | need_pop2 | copy of +0x128; kept and scaled together with it, never compared | same as +0x128 | C (no effect) | `00458cd0`, `00459e80`, `00459fd0` |
| 0x130 | i32 | message | advisor line (`Mentor.tdb` id) for "people want this" (buildings, luxuries) or "you lack this" (goods) | 0..41 | C | `0045a2c0`, `0046fa10` |
| 0x134 | i32 | sound_action | animation action during which +0x08 plays (1 = attack/strike row, 2 = work row, 3 = building); projectiles: 1 = play the sound on launch | 0..3 | C | `00435ad0`, `00434840` |
| 0x138..0x140 | i32 x 3 | - | always 0 | 0 | U | |
| 0x144 | i32 | weapon | index into the weapon table (`dv.wdb`); -1 = unarmed | -1..20 | C | `00463d00` |
| 0x148 | i32 | impact | projectiles: group-7 effect type spawned when the projectile ends (-1 none) | -1, 17, 18 | C | `00434840` |
| 0x14C | char[64] | name | German display name, cp1252, NUL-terminated, rest padded with spaces | | C | `00417d60`, `00420900`, `0041ae60` |

Notes on the layout:

- The old notes placed the name at +0x144. It actually starts at +0x14C. +0x144 and +0x148 are the
  two integers above. Most records show `FF FF FF FF FF FF FF FF` before the name, because both
  integers are -1.
- No field holds attack, damage, attack range or armour. Combat values come from the weapon record
  that +0x144 selects in `dv.wdb` (not yet decoded). The weapon kind (record +4 there, values 1..4)
  selects one of four weapon behaviour classes (`00463d00`).
- No field holds build time, training time or production time. See section 7.

### 2.1 Flags (+0xB8, buildings)

| bit | name | effect | evidence |
|---|---|---|---|
| 0x1 | store | once built (object state is not 1 = under construction), the building's goods count as the **town** stock, not as a local stock. On completion +0x120 is added to the town's per-good capacity, and is removed again on destruction. Set on town hall, warehouse, market. | `00474b70`, `00476380`, `0047c400`, `0045fa40`, `0045ff30` |
| 0x2 | unique | at most one per town: the build menu answers "already exists" while the town has one of this type. The building's need entry is not re-added after completion. Set on embassy, laboratory, library, bank. | `00459b60`, `00459e80` |
| 0x4 | staffed | when its operator (+0xD8) enters, the operator stays and the building runs a periodic operator job (period 100). Set on embassy, farms, news stand, police station, Pimmon mage tower. | `00460ed0`, `00478cb0` |
| 0x8 | visit | a porter (type 9) entering starts a periodic job (period 299). Set on houses, tavern, circus/theatre/arena, temple. | `00460ed0` |

Unit records also carry values (police officer 2, some soldiers 1 or 2). No unit-side reader was found,
so treat them as unused. Exception in the **Gold Edition**: unit bit 0x80 = "wears paths"
(`units-and-jobs.md` 4.5). The Gold `dv.odb` sets it on the path-wearing unit types, and GOG
hard-codes the same list instead.

**Gold Edition flags** (`dvge.exe`, [addon.md](addon.md) 2.5): building bit **0x10** now does the
capacity part of "store" (completion adds +0x120 to the town capacity, `00465d00`); the Gold
`dv.odb` therefore sets 0x11 on town hall and warehouse. Bit **0x20** marks trading posts (Gold
market 0x21, harbour 0x21). Unit bit **0x40** marks carriers with a passenger/cargo panel
(transport ships; Gold Pimmon/Sajiki traders). The GOG `dv.odb` has none of these bits.

### 2.2 Footprint, position and entrance

An object's position (x, y) is the **max** corner of its footprint. The footprint covers
x - size_x + 1 .. x and y - size_y + 1 .. y (`00462870`). The entrance cell is
(x + door_dx, y + door_dy), wrapped to the map size on both axes because the map is a torus
(`0045f0d0`, stored in the building at object +0x70/+0x74).

### 2.3 Movement (step_time)

Height class = |height(from) - height(to)| / 16, rounded down and capped at 3 (`0047e8c0`;
heights are the per-cell u16 in the map).

- A straight step takes step_time[class] ticks.
- A diagonal step (both x and y change) takes floor(1.5 x step_time[class]) ticks. This is a
  lookup table at 0x4AF3D8: 0,1,3,4,6,7,9,10,12,13,15.
- 0 means the step is not possible.

All units of all races share 5/6/7/8. Animals use 6/7/8/9. Turning toward the next cell rotates
one direction per call (`00474260`).

## 3. Units (kind 0)

- **Hit points** (+0xAC): a new object starts with full HP (`00461a40`). Healing clamps to it
  (`0045ab60`, `00475480`, `00477ce0`, `00483a10`). Porter 50 HP: handbook p. 23.
- **Sight** (+0xB0): radius of the circular scans that units run for enemies and targets
  (`0044a7c0`, a circle dx^2 + dy^2 < r^2). Some callers add a margin (+1 in `00480a10`, +3 in
  `00472190`). Scouts have 15, founders/hunters/soldiers 10, other civilians 5, criminals 0.
- **Training price** (+0xD4): money paid by the **player** when the order is queued
  (`00474b70`, money at player +0x1c). The money is refunded on cancel (`00474fd0`). The order is
  refused while money < price (`0045f360`, answer 6). When money drops below 6 the advisor says
  mentor#18 "out of money" (`0045db60`). Stonemason 40: handbook p. 30.
- **Goods** (+0xF0..): delivered by porters to the training building, like construction material.
  Archers need 2 wood; melee, mage and beast units need 1..5 weapons; saboteurs 4 weapons.
- **Where trained** (+0xE8): 55 school (civilians), 39 barracks (archer, melee, saboteur),
  56 mage tower / alchemist hut / cult site, 43 beast building. The criminal has 36 = never trainable.
- **Invention** (+0xE4): must be researched first (`0045a770`: the invention is done when its
  progress (float) has reached its cost).
- Training order check (`0045f360`), in this order:
  1. -1: wrong building for this unit.
  2. 2: invention missing.
  3. 6: not enough money.
  4. 3: town stock below any of the 9 goods costs.
  5. 1: OK.
- When a unit is queued (not a porter), the training building requests a porter to come in and be
  trained (`00474b70` asks for type 9 unless enough people are already inside). Training therefore
  consumes a porter.
- **Class** (+0xC0) for units: 2 = ranged unit that may garrison an outpost (class 6)
  (`00460a10`, `00460ed0`): types 29, 32, 33 and 36 of every race (archers / Pyro, the two
  alchemists / mages / Beschwörer and Gottesanbeter, the Armbrustschützin, Explodus and Harak;
  `docs/game/combat.md` 9.1). 0 = everyone else.
- **Weapon** (+0x144): see section 2.
- **Farmer** (type 14) +0x11C = first nature type of its crop: 17 cocoa, 21 mushrooms, 25 maggots.
  It plants type `+0x11C + random(0..3)` and stops at 10 crops within radius 6 (`00478cb0`).
- **Sound** (+0x08, +0x04, +0x134): workers play their tool sound in the work animation (action 2),
  fighters in the attack animation (action 1).

## 4. Behaviour class (+0xC0)

| value | used on | meaning | evidence |
|---|---|---|---|
| -1 | goods; buildings news stand, police station, theatre/circus/arena, tavern, watchtower | no special class (service building) | I |
| 0 | most units; houses, embassy, lab, library, bank, temple; some goods; rubble; effects | none | |
| 2 | ranged units | can garrison an outpost | `00460ed0` |
| 4 | town hall, warehouse, distillery/bakery/maggot works, farms, market, mine, armoury | goods-handling building (no reader seen for the value itself) | I |
| 5 | barracks, beast building, school, mage tower | training building: units entering are trained, not housed | `00460ed0` |
| 6 | small/large outpost | garrison building, territory message with radius +0xB0 | `004602d0`, `00411200` |
| 7 | animals | wandering animal, hunted by type 17; animals list | `004638d0`, `004635f0`, loader |
| 8 | trees | felled by type 19 | `004638d0`, `004635f0` |
| 9 | bushes | food, picked by porters | `004638d0`, `004635f0` |
| 10/11/12 | cocoa / mushrooms / maggots | race crop of race (class - 10), picked by that race's porters, regrow job | `004638d0`, `004635f0`, `004743b0`, `00401fd0` |
| 13 | stones | quarried by type 27 | `004635f0` |

Harvest rule (`004635f0`): a porter (9) may take bushes (class 9), its own race's crop
(class = race + 10) and rubble (type 38). A hunter (17) takes animals (7), a woodcutter (19) trees
(8), and a stonemason (27) stones (13) and rubble.

## 5. Buildings (kind 1)

- **Footprint, entrance**: see section 2.2.
- **Hit points** (+0xAC): a construction site starts at HP / 10, rounded down (`0045f0d0`).
  Map-placed buildings get HP + the map's HP delta, clamped to [0, HP] (`00411200`, `004602d0`).
  The town hall has 10000.
- **Build cost** (+0xF0..+0x104, wood/stone/iron in practice): when a building is placed, an order
  for it goes into the construction job. Missing goods are requested from porters, and a builder
  (type 11) is requested (`00474b70`). Pimmon school costs 2 wood + 4 stone: handbook p. 26.
  The build menu (`00459b60`) checks only goods 0..4 against the town stock.
- **Build menu state** (`00459b60`):
  1. -1: +0xE8 < 37, so not in the menu (town hall).
  2. 2: invention missing.
  3. 4: unique (flag 0x2) and the town already has one.
  4. 3: town stock below a cost in goods 0..4.
  5. 1: OK.
- **Upkeep** (+0xD4): when a building completes, its value is added to the town's overheads total
  (town +0x4A0) (`0045fa40`). It is subtracted on destruction (`0045ff30`). The total is shown in
  the town finance panel and used by the AI tax logic (`0046e180`). Town hall 7 + school 5 = 12:
  handbook p. 27. Buildings cost no money to build.
- **Operator** (+0xD8): when construction ends, the building calls for a unit of this type
  (`004602d0`). It becomes active (state 2, mentor#10) only when that unit, of the same race,
  enters (`00460ed0`). Buildings without an operator activate at once. Map-placed buildings get
  their operator created inside (`00411200`). Operator job periods by operator type (`00478cb0`):
  13 (diplomat) 100, 14 (farmer) 99, 20 (news) 299, 21 (police) 50. Lab needs a scientist:
  handbook p. 32.
- **Residents** (+0xB4): on completion, homeless people move in up to this many (`004605d0`).
  While there is room, a new porter appears with probability 1 / (10 - h/10), where h is a town
  value at town +0x4B4 (happiness or growth, 0..100) and h >= 80 means always (`004602d0`).
  Houses also get a periodic job every 599 ticks (`0045fa40`). Small house 3: handbook p. 30.
  The town hall holds 3.
- **Storage** (+0x120): with flag 0x1 (town hall 25, warehouse 25), completion adds the value to
  the town's per-good capacity (town +0x54). Destruction subtracts it and scales every town stock
  by W / (W + 1), where W is the number of warehouses (`0045ff30`). Without the flag (distillery,
  mine, armoury: 10) it is the building's own capacity per good: free space = +0x120 - local
  stock (`0047c850`).
- **Automatic production** (+0x11C): a completed building with a product starts a production job
  and queues one unit of that good (`0045fa40`). The good's own record gives the inputs
  (+0xF0.. of the goods record). Mine: iron from 2 wood. Armoury: weapons from 2 wood + 1 iron.
  Luxury works: luxury from 2 raw + 1 wood. Each finished run adds exactly 1 unit and calls a
  porter to collect it (`00476630`).
- **Garrison** (+0xDC) and points (+0x54..): outposts hold class-2 units, at most +0xDC of them
  (2 small, 3 large; `docs/game/combat.md` 9). Map load creates +0xDC archers inside
  (`00411200`). AI towns queue +0xDC archers on completion (`004602d0`) and count the number of
  outposts x +0xDC as their soldier target (`0046cb20`). The points are the garrison positions:
  where slot k is drawn (feet at point k + 22 px down, `docs/rendering/objects.md` 13) and where
  its projectiles start (`00435ad0` with `00436020`). The Pimmon small outpost stores 5 points and
  the Sajiki small one 3, more than their capacity.
- **Radius** (+0xB0): town hall 25 = town area (`0045dc10`; the AI spaces towns 2 x radius apart,
  `0046c1a0`). Outposts 15/25 broadcast a territory message with it (`004602d0`). The territory
  disc has radius (R - 2) div 2 in 2 x 2 blocks: `docs/game/economy.md` 11. Watchtower 30,
  embassy and market 6, mine 8: their use is through the same radius scans (I).
- **Needs** (+0x128, +0x12C, +0x130): see section 6.
- **Special types handled in code**:
  - 40 town hall: completion creates a builder and 2 porters and sets the start stock from a
    settings table (or 10 wood, 10 stone, 10 food) (`0045fa40`).
  - 42 embassy: diplomacy messages.
  - 46 laboratory: research.
  - 52/53 outposts.

## 6. Town needs (+0x128 / +0x12C / +0x130)

- When a town is created, every building type of its race with +0x128 > 0 becomes a need entry
  {type, threshold = +0x128, second = +0x12C}, kept sorted by threshold (`00458cd0`). The types are
  tavern 15, news 25, police 31, temple 35, circus 45 (same in every race).
- A need is active while town population (town +0x44) >= threshold. Each time the needs are
  re-evaluated, an active need is (re)announced through the advisor queue as mentor#(+0x130), for example 29 "your people want a tavern" (`0045a2c0`). The most urgent
  active need is the one with the lowest threshold below the population (`0045a290`).
- When a building of that type becomes **active** (for these operator buildings: when its
  operator is inside, not at completion), both values are multiplied by 2.2 and truncated, the
  entry is re-sorted, and the type is removed from the town's open needs at once (`00459e80`,
  called from `0045fa40`; 2.2 is the double at 0x4A6940). With N active buildings the threshold is
  therefore base x 2.2^N, truncated at each step. See `docs/game/economy.md` 5.3.
- On deactivation (destruction, or the operator leaving) the threshold is recomputed from the
  record with the multiplication applied once per remaining building, and the needs are
  re-evaluated (`00459fd0`, from `0045ff30`). Unique buildings (flag 0x2) drop out of the list
  while one is active.
- **Luxury needs** use goods 6..8, one per race that takes part in the game (`0045a2c0`):
  - The base is the luxury's +0x128 (30).
  - For a luxury of a foreign race the threshold is multiplied by a factor that starts at 1.5 and
    grows by 1.0 for each further foreign luxury.
  - The need is active while population >= threshold and the town stock of that luxury is 0.
  - The advisor uses mentor#39..41.
- Goods +0x130 is the "you are missing X" line: 0 food (no line), 2 wood, 3 stone, 4 iron,
  5 weapons. For raw material (+0x130 = 6) the code adds the race index: 6 cocoa, 7 mushrooms,
  8 maggots (`0046fa10`).

## 7. Goods, nature, effects (kind 2)

- **Goods** (group 6, types 0..8): +0xD4 is the base price. It seeds the town's market price table
  (`00458cd0`) and the AI's price reasoning (`0046dd50`). +0xF0.. is the input per produced unit.
  +0x124 is a list slot, +0x130 the advisor line. +0xE4/+0xE8 have no effect for goods: they are
  never ordered through `0045f360`, because production uses +0x11C directly. Goods +0x120 (weapons
  2) and +0xD8 (schnapps 21) have no reader (I/U).
- **Nature objects** (`004638d0`): the object copies +0x11C (yield good) and +0x120 (amount, both
  initial and remaining) into its own fields, and HP from +0xAC (animals 10).
  - Trees: 4 or 6 wood.
  - Bushes: 5 food.
  - Crops: 1 raw.
  - Stones: 14 or 12 stone.
  - Rubble: 8 stone.
  - Animals: 4/8/12 food.

  The sprite stage shown is proportional to the harvested fraction (`004636b0`). Crops (classes 10..12) and
  freshly planted trees get a growth job (period 599); bushes get none; animals get a
  movement job. Nature +0xD8 (21 or 27 on some
  mushroom, maggot and stone records) and +0xE8 (35/36/40) have no reader found.
- **Projectiles/effects** (group 7): +0x08 sound, +0x134 = 1 means play it when the flight
  **ends** (the hit sound; the launch sound is the shooter's own record sound), +0x148 is
  the effect type spawned on impact (17 = expl1, 18 = expl2) (`00434840`, `00435ad0`; display
  details in `docs/rendering/projectiles.md`). Katapult +0xB8 = 1 has
  no reader found.

## 8. Timing facts found on the way (not record fields)

- The production job re-runs every 30 ticks. When all inputs are present it consumes them and
  counts 10 runs before delivering (about 300 ticks per unit) (`00476380`).
- A completed house's job runs every 599 ticks. Operator jobs run every 50..299 ticks (section 5).
- A building under construction has object state 1, a completed one 2, and a destroyed one 0
  (object +0xB0).

## 9. Open points

- `dv.wdb` (weapon records selected by +0x144): damage, range, rate, armour piercing. Needed for
  combat.
- +0x114 (1 on every unit): no reader found. Likely a population or headcount weight that the
  final game no longer reads.
- Class values -1 and 4 on buildings: no reader that distinguishes them was found.
- +0xB0 on watchtower, mine, embassy and market: the exact consumer of each is not identified.
- +0xDC = 1 on the laboratory: no reader for non-outposts.
- Unit +0xB8 values, goods +0x120/+0xD8, nature +0xD8/+0xE8: no reader.
- Real-time length of a tick: see the scheduler, not part of this file.

## Appendix A: decoded tables

Generated with `tools/odb_dump.py`; values are raw record values.

### A.1 Pimmon units (group 1, kind 0)

| type | name | HP +0xAC | sight +0xB0 | training price +0xD4 | goods +0xF0.. | trained at +0xE8 | invention +0xE4 | weapon +0x144 | class +0xC0 | step times +0xC4.. | list slot +0x124 | sound +0x08 / frame +0x04 / action +0x134 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 9 | Träger | 50 | 5 | 10 | - | 55 Schule | -1 | -1 | 0 | 5/6/7/8 | 0 | 0 / 0 / 0 |
| 10 | Stadtgründer | 50 | 10 | 100 | - | 55 Schule | -1 | -1 | 0 | 5/6/7/8 | 5 | 1 / 0 / 2 |
| 11 | Baumeister | 50 | 5 | 30 | - | 55 Schule | -1 | -1 | 0 | 5/6/7/8 | 1 | 3 / 4 / 2 |
| 12 | Krimineller | 50 | 0 | 0 | - | 36 (not trainable) | -1 | 0 | 0 | 5/6/7/8 | 27 | 4 / 4 / 1 |
| 13 | Diplomat | 50 | 5 | 70 | - | 55 Schule | 4 | -1 | 0 | 5/6/7/8 | 8 | 0 / 0 / 0 |
| 14 | Pilzbauer | 50 | 5 | 50 | - | 55 Schule | 7 | -1 | 0 | 5/6/7/8 | 9 | 5 / 5 / 2 |
| 15 | Dompteur | 50 | 5 | 70 | - | 55 Schule | 19 | -1 | 0 | 5/6/7/8 | 16 | 0 / 0 / 0 |
| 16 | Schnapsbrenner | 50 | 5 | 60 | - | 55 Schule | 14 | -1 | 0 | 5/6/7/8 | 14 | 0 / 0 / 0 |
| 17 | Jäger | 50 | 10 | 40 | - | 55 Schule | 2 | 17 | 0 | 5/6/7/8 | 7 | 7 / 4 / 1 |
| 18 | Wirt | 50 | 5 | 50 | - | 55 Schule | 8 | -1 | 0 | 5/6/7/8 | 10 | 0 / 0 / 0 |
| 19 | Holzfäller | 50 | 5 | 40 | - | 55 Schule | 1 | -1 | 0 | 5/6/7/8 | 3 | 9 / 6 / 2 |
| 20 | Zeitungsmann | 50 | 5 | 70 | - | 55 Schule | 11 | -1 | 0 | 5/6/7/8 | 13 | 0 / 0 / 0 |
| 21 | Polizist | 50 | 5 | 70 | - | 55 Schule | 10 | 2 | 0 | 5/6/7/8 | 12 | 11 / 7 / 1 |
| 22 | Priester | 50 | 5 | 100 | - | 55 Schule | 13 | 20 | 0 | 5/6/7/8 | 18 | 64 / 4 / 2 |
| 23 | Gelehrter | 50 | 5 | 70 | - | 55 Schule | -1 | -1 | 0 | 5/6/7/8 | 2 | 0 / 0 / 0 |
| 24 | Späher | 50 | 15 | 50 | - | 55 Schule | 0 | -1 | 0 | 5/6/7/8 | 6 | 0 / 0 / 0 |
| 25 | Waffenschmied | 50 | 5 | 70 | - | 55 Schule | 15 | -1 | 0 | 5/6/7/8 | 15 | 0 / 0 / 0 |
| 26 | Saboteur | 50 | 5 | 300 | 4 weapons | 39 Kaserne | 20 | 4 | 0 | 5/6/7/8 | 26 | 0 / 0 / 1 |
| 27 | Steinmetz | 50 | 5 | 40 | - | 55 Schule | -1 | -1 | 0 | 5/6/7/8 | 4 | 14 / 5 / 2 |
| 28 | Händler | 50 | 5 | 50 | - | 55 Schule | 9 | -1 | 0 | 5/6/7/8 | 11 | 0 / 0 / 0 |
| 29 | Bogenschütze | 100 | 10 | 100 | 2 wood | 39 Kaserne | 12 | 3 | 2 | 5/6/7/8 | 17 | 45 / 8 / 1 |
| 30 | Hammermann | 175 | 10 | 460 | 1 weapons | 39 Kaserne | 24 | 6 | 0 | 5/6/7/8 | 21 | 19 / 8 / 1 |
| 31 | Schwertkämpfer | 150 | 10 | 380 | 1 weapons | 39 Kaserne | 21 | 5 | 0 | 5/6/7/8 | 19 | 15 / 6 / 1 |
| 32 | Mächtiger Magier | 200 | 10 | 600 | 4 weapons | 56 Magierturm | 27 | 13 | 2 | 5/6/7/8 | 23 | 21 / 7 / 1 |
| 33 | Magier | 175 | 10 | 500 | 2 weapons | 56 Magierturm | 23 | 12 | 2 | 5/6/7/8 | 22 | 20 / 6 / 1 |
| 34 | Drachofiterus | 225 | 10 | 500 | 2 weapons | 43 Dressurfarm | 22 | 14 | 0 | 5/6/7/8 | 24 | 46 / 7 / 1 |
| 35 | Necktarus | 250 | 10 | 600 | 5 weapons | 43 Dressurfarm | 28 | 15 | 0 | 5/6/7/8 | 25 | 22 / 6 / 1 |
| 36 | Explodus | 250 | 10 | 500 | 1 weapons | 43 Dressurfarm | 25 | 16 | 2 | 5/6/7/8 | 20 | 0 / 0 / 1 |

### A.2 Pimmon buildings (group 1, kind 1)

| type | name | size x*y +0x10/+0x0C | door +0x94,+0x98 | HP +0xAC | upkeep +0xD4 | build cost +0xF0.. | residents +0xB4 | storage +0x120 | operator +0xD8 | garrison +0xDC | produces +0x11C | radius +0xB0 | class +0xC0 | flags +0xB8 | invention +0xE4 | build menu (+0xE8) | need at pop +0x128 / msg +0x130 | slot +0x124 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 37 | Wohngebäude | 2x2 | -1,1 | 350 | 5 | 2 wood, 5 stone | 3 | - | - | - | - | - | 0 | 8 (visit) | -1 | yes (40) | - | 1 |
| 38 | Großes Wohngebäude | 2x3 | 1,-2 | 450 | 7 | 4 wood, 10 stone, 3 iron | 9 | - | - | - | - | - | 0 | 8 (visit) | 18 | yes (40) | - | 19 |
| 39 | Kaserne | 3x2 | -2,1 | 500 | 5 | 5 wood, 10 stone | - | - | - | - | - | - | 5 | 0 (-) | 12 | yes (40) | - | 12 |
| 40 | Rathaus | 3x2 | -1,1 | 10000 | 7 | - | 3 | 25 | 10 Stadtgründer | - | - | 25 | 4 | 1 (store) | -1 | no (36) | - | 0 |
| 41 | Lagerhaus | 2x2 | -1,1 | 400 | 5 | 4 wood, 8 stone | - | 25 | - | - | - | - | 4 | 1 (store) | 6 | yes (40) | - | 6 |
| 42 | Botschaft | 2x2 | -1,1 | 750 | 15 | 6 wood, 8 stone | - | - | 13 Diplomat | - | - | 6 | 0 | 6 (unique,staffed) | 4 | yes (40) | - | 5 |
| 43 | Dressurfarm | 2x3 | -1,1 | 500 | 10 | 15 wood, 20 stone, 8 iron | - | - | - | - | - | - | 5 | 0 (-) | 22 | yes (40) | - | 21 |
| 44 | Schnapsbrennerei | 2x3 | 1,-2 | 400 | 25 | 8 wood, 14 stone | - | 10 | 16 Schnapsbrenner | - | 7 lux7 | - | 4 | 0 (-) | 14 | yes (40) | - | 13 |
| 45 | Pilzfarm | 3x2 | -2,1 | 400 | 15 | 4 wood, 10 stone | - | - | 14 Pilzbauer | - | - | - | 4 | 4 (staffed) | 7 | yes (40) | - | 7 |
| 46 | Labor | 2x2 | 1,-1 | 450 | 15 | 2 wood, 6 stone | - | - | 23 Gelehrter | 1 | - | - | 0 | 2 (unique) | -1 | yes (40) | - | 2 |
| 47 | Bibliothek | 2x3 | 1,-1 | 500 | 50 | 20 wood, 22 stone | - | - | 23 Gelehrter | - | - | - | 0 | 2 (unique) | 29 | yes (40) | - | 23 |
| 48 | Marktplatz | 3x2 | -2,1 | 500 | 15 | 3 wood, 10 stone | - | - | - | - | - | 6 | 4 | 1 (store) | 9 | yes (40) | - | 9 |
| 49 | Bank | 2x3 | 1,-1 | 500 | 50 | 12 wood, 16 stone, 5 iron | - | - | 23 Gelehrter | - | - | - | 0 | 2 (unique) | 17 | yes (40) | - | 18 |
| 50 | Mine | 2x3 | 1,-2 | 500 | 20 | 10 wood, 25 stone | - | 10 | 27 Steinmetz | - | 3 iron | 8 | 4 | 0 (-) | 15 | yes (40) | - | 16 |
| 51 | Zeitungsstand | 2x2 | -1,1 | 450 | 30 | 4 wood, 10 stone | - | - | 20 Zeitungsmann | - | - | - | -1 | 4 (staffed) | 11 | yes (40) | 25 / 32 | 11 |
| 52 | Kl. Außenposten | 2x2 | 1,-1 | 600 | 20 | 8 wood, 10 stone | - | - | - | 2 | - | 15 | 6 | 0 (-) | 16 | yes (40) | - | 17 |
| 53 | Gr. Außenposten | 3x3 | 1,-2 | 800 | 30 | 15 wood, 20 stone, 3 iron | - | - | - | 3 | - | 25 | 6 | 0 (-) | 26 | yes (40) | - | 24 |
| 54 | Polizei | 2x3 | 1,-2 | 500 | 30 | 5 wood, 10 stone | - | - | 21 Polizist | - | - | - | -1 | 4 (staffed) | 10 | yes (40) | 31 / 34 | 10 |
| 55 | Schule | 2x2 | 1,-1 | 500 | 5 | 2 wood, 4 stone | - | - | - | - | - | - | 5 | 0 (-) | -1 | yes (40) | - | 3 |
| 56 | Magierturm | 2x2 | -1,1 | 600 | 10 | 10 wood, 15 stone, 25 iron | - | - | - | - | - | - | 5 | 4 (staffed) | 23 | yes (40) | - | 22 |
| 57 | Zirkus | 4x4 | -2,1 | 500 | 50 | 20 wood, 25 stone | - | - | 15 Dompteur | - | - | - | -1 | 8 (visit) | 19 | yes (40) | 45 / 36 | 20 |
| 58 | Wirtshaus | 2x2 | 1,-1 | 500 | 20 | 5 wood, 8 stone | - | - | 18 Wirt | - | - | - | -1 | 8 (visit) | 8 | yes (40) | 15 / 29 | 8 |
| 59 | Tempel | 2x3 | -1,1 | 500 | 40 | 10 wood, 15 stone, 1 iron | - | - | 22 Priester | - | - | - | 0 | 8 (visit) | 13 | yes (40) | 35 / 38 | 14 |
| 60 | Spähturm | 1x1 | 0,-1 | 500 | 10 | 2 wood, 5 stone | - | - | 24 Späher | - | - | 30 | -1 | 0 (-) | 0 | yes (40) | - | 4 |
| 61 | Waffenschmiede | 3x2 | -2,1 | 500 | 15 | 10 wood, 18 stone | - | 10 | 25 Waffenschmied | - | 5 weapons | - | 4 | 0 (-) | 15 | yes (40) | - | 15 |

### A.3 Goods (group 6, types 0..8)

| type | name | base price +0xD4 | inputs per unit +0xF0.. | luxury need at pop +0x128 | advisor msg +0x130 | list slot +0x124 |
|---|---|---|---|---|---|---|
| 0 | Rohstoff | 0 | - | - | 6 | 7 |
| 1 | Holz | 5 | - | - | 2 | 0 |
| 2 | Stein | 5 | - | - | 3 | 3 |
| 3 | Eisen | 25 | 2 wood | - | 4 | 6 |
| 4 | Nahrung | 5 | - | - | 0 | 4 |
| 5 | Waffen | 60 | 2 wood, 1 iron | - | 5 | 1 |
| 6 | Schokotörtchen | 20 | 2 raw, 1 wood | 30 | 39 | 2 |
| 7 | Plizschnaps | 20 | 2 raw, 1 wood | 30 | 40 | 5 |
| 8 | Zigarillos | 20 | 2 raw, 1 wood | 30 | 41 | 8 |

### A.4 Nature objects (group 6, types 9..38)

| types | name | class +0xC0 | yields +0x11C/+0x120 | HP +0xAC | step times | footprint |
|---|---|---|---|---|---|---|
| 9 | Baum | 8 | 6 wood | - | - | 1x1 |
| 10 | Baum | 8 | 4 wood | - | - | 1x1 |
| 11 | Baum | 8 | 6 wood | - | - | 1x1 |
| 12 | Baum | 8 | 4 wood | - | - | 1x1 |
| 13 | Busch | 9 | 5 food | - | - | 1x1 |
| 14 | Busch | 9 | 5 food | - | - | 1x1 |
| 15 | Busch | 9 | 5 food | - | - | 1x1 |
| 16 | Busch | 9 | 5 food | - | - | 1x1 |
| 17 | Kakao | 10 | 1 raw | - | - | 1x1 |
| 18 | Kakao | 10 | 1 raw | - | - | 1x1 |
| 19 | Kakao | 10 | 1 raw | - | - | 1x1 |
| 20 | Kakao | 10 | 1 raw | - | - | 1x1 |
| 21 | Pilze | 11 | 1 raw | - | - | 1x1 |
| 22 | Pilze | 11 | 1 raw | - | - | 1x1 |
| 23 | Pilze | 11 | 1 raw | - | - | 1x1 |
| 24 | Pilze | 11 | 1 raw | - | - | 1x1 |
| 25 | Maden | 12 | 1 raw | - | - | 1x1 |
| 26 | Maden | 12 | 1 raw | - | - | 1x1 |
| 27 | Maden | 12 | 1 raw | - | - | 1x1 |
| 28 | Maden | 12 | 1 raw | - | - | 1x1 |
| 29 | Stein | 13 | 14 stone | - | - | 1x1 |
| 30 | Stein | 13 | 14 stone | - | - | 1x1 |
| 31 | Stein | 13 | 14 stone | - | - | 1x1 |
| 32 | Stein | 13 | 12 stone | - | - | 1x1 |
| 33 | Fasterator | 7 | 8 food | 10 | 6/7/8/9 | 1x1 |
| 34 | Necktor | 7 | 12 food | 10 | 6/7/8/9 | 1x1 |
| 35 | Echse | 7 | 8 food | 10 | 6/7/8/9 | 1x1 |
| 36 | Sumpfling | 7 | 12 food | 10 | 6/7/8/9 | 1x1 |
| 37 | Hase | 7 | 4 food | 10 | 6/7/8/9 | 1x1 |
| 38 | Schutt | 0 | 8 stone | - | - | 1x1 |

### A.5 Projectiles and effects (group 7)

| type | name | sound +0x08 | sound frame +0x04 | +0x134 (projectiles: 1 = sound at arrival; effects: sound action) | impact effect +0x148 | +0xB8 |
|---|---|---|---|---|---|---|
| 0 | Alchemie1 | 52 | 0 | 1 | 17 | 0 |
| 1 | Alchemie2 | 53 | 0 | 1 | 18 | 0 |
| 2 | Armbrust | 65 | 0 | 1 | -1 | 0 |
| 3 | Katapult | 18 | 0 | 1 | 17 | 1 |
| 4 | Magie1 | 52 | 0 | 1 | 17 | 0 |
| 5 | Magie2 | 53 | 0 | 1 | 18 | 0 |
| 6 | MagieSa1 | 52 | 0 | 1 | 17 | 0 |
| 7 | MagieSa2 | 53 | 0 | 1 | 18 | 0 |
| 8 | Säure | 65 | 0 | 1 | -1 | 0 |
| 9 | Feuer | 52 | 0 | 1 | 17 | 0 |
| 10 | Bogen | 65 | 0 | 1 | -1 | 0 |
| 11 | Die | 51 | 1 | 0 | -1 | 0 |
| 12 | Die | 50 | 1 | 0 | -1 | 0 |
| 13 | Die | 49 | 1 | 0 | -1 | 0 |
| 17 | expl1 | 0 | 0 | 0 | -1 | 0 |
| 18 | expl2 | 0 | 0 | 0 | -1 | 0 |
| 19 | expl3 | 54 | 1 | 0 | -1 | 0 |
