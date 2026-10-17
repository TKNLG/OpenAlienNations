# Add-on (mission pack, Gold Edition): gameplay spec

Status: **first full pass.** Everything the mission pack adds to the simulation was traced in the
Gold executable `dvge.exe` (`re/dump-gold/decomp.c`, plus the virtual methods recovered the same
way as `units-and-jobs.md` 13). The add-on data (`Addon.odb`, `addon.wdb`, `*/AO.idb`,
`Addon.tdb`) was decoded with the existing readers in `tools/`. Functions were matched between
`AN.exe` and `dvge.exe` by normalised pseudocode similarity, then by strings, constants and call
structure. Every address below is a **Gold** address unless it is marked `AN`. Appendix B maps
the Gold functions to their `AN.exe` equivalents.

Legend: **C** = confirmed in code, **I** = inferred, *(uncertain)* = open. All divisions are
integer divisions that truncate toward zero. "Tick" is one scheduler tick (`units-and-jobs.md`
1.1). Nothing here is copied code: behaviour is described in our own words.

Related documents:
- `docs/formats/addon.md` (written in parallel by another agent): the add-on files, how they
  are loaded, the add-on menus and the switch that turns **add-on mode** on. This document only
  uses that switch (global settings object +0xA50 > 0, read in `00492960`, `0044ef50`,
  `00462e10`, `00474680`, `00478180`).
- `docs/game/units-and-jobs.md`, `economy.md`, `combat.md`, `ai-diplomacy-trade.md`,
  `fog-of-war.md`, `docs/formats/odb.md`, `idb-wdb.md`, `terrain-gen.md`, `mdb.md`: base rules.
  Only what is **new or different** is written here.
- `units-and-jobs.md` 4.5 (worn paths) and the foundation section already carry the Gold notes
  for those two topics (written by another agent). They are not repeated.

---

## 0. Summary

- Add-on mode changes the **map**: the ground comes from an island generator (Appendix A). Every
  cell is land, **open sea** or **coastal water**. Each land cell gets an **island id**.
- Two buildings: the **harbour** (type 62, "Hafen") and the **shipyard** (63, "Werft"). Both must
  be placed at the waterline (section 3).
- Four ship types per race (64 fishing, 65 light warship, 66 heavy warship, 67 transport). They
  are **units** with behaviour class 14. They are trained in the shipyard like any unit: a porter
  goes in, and a ship comes out on the nearest navigable water cell (section 4).
- Ships move on water with the normal path search, using a different cell mask. They may not
  enter coastal water, so a ship never comes next to land.
- **Transport ships** are containers for up to 5 units. Units board from the shore within reach
  of the ship. Unloading puts them on the nearest free land cell within 5 rings, or the ship
  first sails to a coast (section 5). Transport ships are also **sea traders**: they run trade
  routes between harbours, just as merchants run them between markets.
- **Fishing**: a move order sends a fishing boat to fishing grounds. There it catches **fish**,
  which are stationary nature objects in the water, and brings the food to the nearest harbour of
  its town (section 6). Fish never regrow.
- **Sea combat** uses the base combat pipeline unchanged. Ships carry cannons, a fireball, pincers
  or a fishing rod (section 7).
- The **AI** builds harbours and shipyards, keeps one fishing boat and one patrol ship, trades
  over sea, and has a new **naval planner** (job 0x3D) that ferries founders and armies to other
  islands (section 8).
- Three new inventions per race (30 Werft, 31 Hafen, 32 heavy warship). There are four new
  mission goal types (section 9).
- The Gold executable also changes some base behaviour. Most changes are inert outside add-on
  mode, but a few are not (section 10).

### 0.1 What add-on mode switches

| effect | where | status |
|---|---|---|
| load `Addon.odb/od/gd/wdb/tdb`, use `AO.idb` instead of `DV.idb` | `00492960`, `00462e10` | C (details: `docs/formats/addon.md`) |
| terrain class table, thresholds, island generator, island-id map | `00492960`, `0044ef50`, `0044d250`, `004922c0` | C, section 2 / Appendix A |
| computer nations get the naval planner (job 0x3D) | `00462e10` | C, 8.4 |
| AI building targets for harbour and shipyard, fishing and warship gangs | `00474680`, `00478180` | C, 8.1, 8.2 |

Everything else (ship rules, harbour, fishing, the island tests) is always present in the
executable. The island tests read the island-id map, which exists only on add-on maps. On a base
map the map pointer is null and every island lookup returns 0, so these tests never fire there
(C, `00485cc0`, `0044ef50`).

---

## 1. New data

### 1.1 Records (`Addon.odb`, 31 records of `odb.md` layout)

Type numbers are the same in every race. Behaviour classes (+0xC0) are new: **14 = ship**,
**15 = fish**.

**Buildings** (kind 1):

| race | type | name | size x×y | door | HP | upkeep | build cost | flags +0xB8 | class | radius | invention |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Amazons | 62 | Hafen | 3×3 | 0,0 | 1000 | 15 | 12 wood, 4 stone | 0x21 | 4 | 6 | 31 |
| Amazons | 63 | Werft | 3×3 | 0,0 | 1200 | 10 | 15 wood, 6 stone | 0 | 5 | 0 | 30 |
| Pimmons | 62 | Hafen | 3×3 | 0,0 | 1000 | 15 | 4 wood, 12 stone | 0x21 | 4 | 6 | 31 |
| Pimmons | 63 | Werft | 3×2 | 0,0 | 1200 | 10 | 6 wood, 15 stone | 0 | 5 | 0 | 30 |
| Sajiki | 62 | Hafen | 3×3 | 0,0 | 1000 | 15 | 6 wood, 6 stone | 0x21 | 4 | 6 | 31 |
| Sajiki | 63 | Werft | 3×3 | 0,0 | 1200 | 10 | 11 wood, 10 stone | 0 | 5 | 0 | 30 |

Neither building has an operator (+0xD8 = −1), residents or storage (+0x120 = 0). Both appear
in the town-hall build menu (+0xE8 = 40). List slots (+0x124) are 26 (harbour) and 25
(shipyard).

**Ships** (kind 0, class 14, footprint 1×1, made at 63). Every ship has record +0x04
(sound frame) = 0:

| race | type | name | HP | sight | price | goods | invention | weapon | step time | +0xB8 | capacity +0xDC |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Amazons | 64 | Fischerboot | 100 | 8 | 150 | 3 wood | 31 | 27 | 5 | 0 | 0 |
| Amazons | 65 | Patrolienboot | 250 | 8 | 500 | 4 wood, 2 weapons | 15 | 25 | 3 | 0 | 0 |
| Amazons | 66 | Kreuzer | 500 | 12 | 700 | 7 wood, 3 weapons | 32 | 26 | 6 | 0 | 0 |
| Amazons | 67 | Transportschiff | 350 | 12 | 300 | 5 wood | 30 | − | 5 | 0x40 | 5 |
| Pimmons | 64 | Fischerboot | 100 | 8 | 150 | 3 wood | 31 | 27 | 5 | 0 | 0 |
| Pimmons | 65 | Zerstörer | 300 | 10 | 500 | 3 wood, 3 weapons | 15 | 21 | 4 | 0 | 0 |
| Pimmons | 66 | Schlachtschiff | 600 | 12 | 800 | 5 wood, 4 weapons | 32 | 22 | 8 | 0 | 0 |
| Pimmons | 67 | Transportschiff | 350 | 12 | 300 | 5 wood | 30 | − | 5 | 0x40 | 5 |
| Sajiki | 64 | Fischer | 100 | 8 | 250 | − | 31 | 27 | 5 | 0 | 0 |
| Sajiki | 65 | Panzerlanguste | 450 | 8 | 650 | 3 weapons | 15 | 23 | 3 | 0 | 0 |
| Sajiki | 66 | Seepyro | 450 | 10 | 1000 | 5 weapons | 32 | 24 | 7 | 0 | 0 |
| Sajiki | 67 | Transporter | 350 | 12 | 300 | 5 wood | 30 | − | 5 | 0x40 | 5 |

The step time is the same in all four height classes. Warships 65/66 carry launch points
(+0x54..) for their projectiles. Invention 15 is "Metallurgie" in all three races.

**Nature** (group 6, kind 2):

| types | name | class | yield | HP | notes |
|---|---|---|---|---|---|
| 39 | Gecko | 7 (animal) | 12 food | 10 | land animal, base rules (`units-and-jobs.md` 7.7) |
| 40 | Krabbe | 7 | 12 food | 10 | land animal |
| 41, 42, 43 | Fisch | **15** | 2 food | 10 | stationary, in water (section 6) |
| 44, 45 | Fisch | 15 | 3 food | 10 | |
| 46, 48 | Palme | 8 (tree) | 6 wood | − | felling sound 59 |
| 47, 49 | Palme | 8 | 4 wood | − | |
| 50 | Aloe | −1 | − | − | decoration only |
| 51 | Venus | −1 | − | − | decoration only |

Fish +0xE8 (63 or 8) and +0x134 (4 on types 44/45) have no reader.

### 1.2 Flags (+0xB8) used by Gold

`dvge.exe` reads four flag bits that `AN.exe` does not have. The Gold `dv.odb` sets them on the
base records (checked against the GOG `dv.odb`: +0xB8 is the only field that differs).

| bit | on | meaning in Gold | replaces in AN.exe | evidence |
|---|---|---|---|---|
| 0x10 | town hall, warehouse | **adds storage capacity** (+0x120) on activation, removes it on deactivation | "store flag 0x1 and +0x120 ≠ 0" | `00465d00`, `004661f0` |
| 0x20 | market, harbour | **market-like**: settings page `VERKAUF`; foreign building gives vision at peace (fog) | type == 48 tests | `00427000`, `0043a750`, `0043a860` |
| 0x40 | traders (type 28, all races), transport ships (67) | **trader**: may run trade routes; keeps its transport job when it arrives empty | type == 28 tests | `00487040`, `00487190`, `00457d60`, `00427000` |
| 0x80 | path-wearing units (9, 17, 19, 27, 29..36; type 28 only for the Amazons) | wears paths | the fixed type list | `0044c7d0`; see `units-and-jobs.md` 4.5 |

Building flags in Gold `dv.odb`: town hall and warehouse 0x11, market 0x21. Harbour 0x21: it is
a **store** (0x1) that adds no capacity, and it is market-like (0x20).

### 1.3 Weapons (`addon.wdb`, 7 records, indices 21..27)

Fields as in `idb-wdb.md`. The derived values use `combat.md` 3.4 and 4.2. "Range st/dg" is
the in-range distance in cells on flat open ground, straight and diagonal.

| idx | name | used by | kind | damage | hit % | range | range st/dg | speed | cooldown | interval (ticks) | projectile |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 21 | Zerstörer Kanone | Pimmon 65 | missile | 40..80 | 90 | 8 | 8 / 6 | 900 | 40 | 41..61 | 3 (Katapult) |
| 22 | Schlachtsschiff Kanone | Pimmon 66 | missile | 120..220 | 80 | 12 | 12 / 8 | 700 | 80 | 81..121 | 3 |
| 23 | Zangen | Sajiki 65 | melee | 9..18 | 100 | 0 | adjacent | − | 10 | 11..16 | − |
| 24 | Feuerball | Sajiki 66 | missile | 80..250 | 70 | 10 | 10 / 7 | 600 | 80 | 81..121 | 9 (Feuer) |
| 25 | Patrollienboot Kanone | Amazon 65 | missile | 25..50 | 95 | 9 | 9 / 6 | 1000 | 30 | 31..46 | 3 |
| 26 | Kreuzer Kanone | Amazon 66 | missile | 80..170 | 85 | 12 | 12 / 8 | 1000 | 55 | 56..83 | 3 |
| 27 | Angel | every 64 | melee | 20..20 | 100 | 0 | adjacent | − | 40 | 41..61 | − |

Projectile types 3 and 9 are the base group-7 records (impact effect 17).

### 1.4 Inventions (`AO.idb`, 33 records)

Entries 0..29 are identical to `DV.idb`. Three entries are new:

| idx | name | cost | needs | unlocks |
|---|---|---|---|---|
| 30 | Werft | 25 | 1 (Amazons: Bergfrau; Pimmons, Sajiki: Holzfäller). **Sajiki: nothing** | shipyard 63, transport ship 67 |
| 31 | Hafen | 60 | 30 | harbour 62, fishing boat 64 |
| 32 | Kreuzer / Schlachtschiff / Seepyro | 150 | 30 and 15 | heavy warship 66 |

The light warship 65 needs only invention 15 (Metallurgie), but it is trained in the shipyard,
so in practice it also needs 30. Research mechanics are unchanged (`idb-wdb.md`). Starting
inventions: in an add-on record a research level n > 0 (mission +0x64 or the free-play
development 12 / 20) also grants 30, 31 (n > 5) and 32 (n > 15), so add-on free play with
"Entwicklungsstufe" Mittel or Hoch starts with Werft and Hafen (shipyard, harbour, fishing boat,
transport ship available) ([economy.md](economy.md) 4.4.2). The AI's
research cursor walks the table in file order, so it reaches 30..32 last (8.6).

### 1.5 Strings (`Addon.tdb`, ids 325..330)

325 "Addon:", 326 "Addon Kampagnen" (menus), 327 **"Unterwegs zu Fischgründen"** and 328
**"Fischt"** (fishing job status, 6.2), 329 **"An Bord"** (tooltip of the passengers page, 5.6),
330 **"Ausladen"** (tooltip of the `AUSSTEIGEN` button, 5.6).

### 1.6 New job types

The save-game factory (`004031c0`, AN `00402dc0`) knows types 0..0x3E. `AN.exe` stops at 0x3C
and has no 0x3A or 0x3B.

| id | name | owner | ctor / run | vtable | section |
|---|---|---|---|---|---|
| 0x3A | fishing | unit (type 64) | `00482f70` (grounds), `00482fe0` (fish) / `004830b0` | 0x4B2384 | 6.2 |
| 0x3B | sail to coast | ship | `0048b830` / `0048b8c0` | 0x4B2814 | 5.4 |
| 0x3D | AI naval planner | computer nation | `00472270` / `00472b30` | 0x4B2828 | 8.4 |
| 0x3E | wait for a ship | unit (AI) | `00488760` / `00488790` | 0x4B2838 | 8.4 |

---

## 2. Terrain and cells in add-on mode

### 2.1 Terrain classes (C, `00492960`, tables at 0x4BCB44 / 0x4BCB74)

The class-to-tile-set table depends on the mode:

| class | base mode | add-on mode |
|---|---|---|
| 0 | wiese | **weg** (beach, and worn paths) |
| 1 | gelbgras | weg |
| 2 | schnee | schnee |
| 3 | rock | rock |
| 4 | waldboden | wiese |
| 5 | waldboden | waldboden |
| 6 | gruenwald | gruenwald |
| 7 | waldboden | gelbgras |
| 8 | gelbgras | weg |
| 9 | gruenwald | **wasser1 (static, open sea)** |
| 10 | weg | **wasser1..4 (animated, coastal water)** |
| 11 | wasser1..4 | − |

There are 11 static classes in base mode and 10 in add-on mode (N = 11 or 10). The animated
water set is loaded as class N. The worn-path and foundation tiles are the **first weg class**:
class 10 in base mode and class 0 in add-on mode (`00492960` stores the first match).

### 2.2 Cell flags (C, `0044c020` = AN `00447f20`; `004565a0` = AN `00451510`)

Gold changes the terrain part of the flag word. Let t be the cell's tile index, b[k] the first
tile index of class k, and N as above.

| flag | Gold rule | AN.exe rule |
|---|---|---|
| 0x2000 (land) | t < b[N − 1] in add-on mode, t < b[N] in base mode | t < b[N] |
| 0x20 (water) | otherwise | otherwise |
| 0x8000 (**coastal / animated water**) | t ≥ b[N] | − |
| 0x10000 (**class-0 tile**) | t < b[1] | − (never set) |
| 0x100 / 0x200 / 0x400 | height > H_mount / 130..H_mount / < 130 | same, with 250 |

The height thresholds are set by the map constructor (`0044ef50`):

| threshold | base mode | add-on mode |
|---|---|---|
| H_mount (flag 0x100, "mountain") | 250 | **290** |
| H_high (terrain band) | 200 | 250 |
| H_low (flag 0x400) | 130 | 130 |
| sea level | (unused) | **120** |

In add-on mode:
- open sea (class 9) = 0x20;
- coastal water (class 10) = 0x20 | 0x8000;
- beach (class 0) and worn paths = 0x2000 | 0x10000;
- other land = 0x2000.

In base mode every water cell gets 0x20 | 0x8000. Class 0 (meadow) gets 0x10000 there too, which
changes two base rules (10.2).

Not every rule reads these flags. The town territory and its border stones (`economy.md` 11,
`rendering/territory.md` 2.1) test neither the flags, the tile, the height nor the island-id
grid: in add-on island games a town's disc covers the sea like land, and its border stones lie
on open sea and coastal water (C, `004542c0`, `004549d0`, frame builder `00449f60`; same code as
AN.exe).

### 2.3 Unit masks (C, `00467d70` = AN `00461a40`; `0046ad30` retype)

| unit | blocking mask (+0x24) | path mask (+0x28) |
|---|---|---|
| class ≠ 14 (everything but ships) | 0x3E | 0x3C |
| class 14 (ships) | **0xA01E** | **0xA01C** |

A ship may not stand on, or path through, land (0x2000), coastal water (0x8000), buildings,
special objects or nature objects (fish included). Units block it like any unit. Land units keep
0x20 (water) in their masks. **Ships therefore keep at least one cell of water between
themselves and any land cell, diagonals included.** No land unit can stand next to a ship.

### 2.4 Island id map (C)

- The map object holds one byte per cell at map +0x0A (Gold map layout: +0x09 add-on flag, +0x0A
  island map, +0x0E cells, +0x12 mask, +0x16 shift, +0x1A size; AN.exe: +0x09 cells, +0x0D,
  +0x11, +0x15). The constructor allocates it, zeroed, only in add-on mode.
- It is filled once, after the map file has been loaded and before play (`004922c0` = AN
  `00485a30`, at its end): land = **height > 120** (`004922a0`). Every 4-connected component of
  land on the torus gets a label, written to all its cells. Water cells stay **0**. The
  labelling routine is `0044cea0` (Appendix A.4). Labels start at 1 and are stored in a byte, so
  label 256 would wrap to 0 *(quirk, C)*.
- The map is never updated afterwards.
- Lookup `00485cc0`: island of (x, y), or 0 without a map.
- "Near-island" search `00485cf0`: tests the 20 cells of the offset table at 0x4BCD30, in this
  order: (−1,0), (−1,−1), (0,−1), (1,−1), (1,0), (1,1), (0,1), (−1,1), (−1,2), (0,2), (1,2),
  (−1,−2), (0,−2), (1,−2), (2,−1), (2,0), (2,1), (−2,0), (−2,1), (−2,−1). These are the 8
  neighbours and then the distance-2 ring without its corners. It returns the first cell whose
  island id equals the requested one.

### 2.5 Where island ids are tested (C)

| rule | function |
|---|---|
| **Follow path (0x06)**: on every run, if the island of the destination cell differs from the island of the unit's current cell, the job **fails at once** | `0048b230` |
| **Go to object (0x07)**: if the target's island differs from the unit's and the target's cell is land (id ≠ 0), fail at once. The transport-ship target is special (5.2) | `00485750` |
| trade partners for **merchants** must be on the merchant's island; ships trade with any harbour | `00463ef0`, 5.7 |
| a diplomat only walks to embassies on his embassy's island; across water the offer is decided at once and he goes back in | `004821c0`, 9.3 |
| AI: founding and army use ships across water; fishing picks water cells | 8.4, 8.3 |
| mission goal 19 counts per island | 9.2 |

Consequences:
- A land unit can never walk to another island. It needs a transport ship.
- The porter dispatcher, store selection and free-porter search are **not** island-aware
  (`00479480`, `00461460`, `00461030` are unchanged). A town whose buildings stand on two islands
  hands out transport jobs that fail *(behaviour by reading; the AI never places buildings
  outside its town area, and towns normally lie on one island)*.

---

## 3. Harbour and shipyard

### 3.1 Placement (C, player `004571e0`, UI test `0044bdb0`, mask `00465300`)

Masks per building type (Gold `00465300`, AN `0045f0a0`):

| types | mask |
|---|---|
| 40 town hall | 0x107E |
| 45 farm | 0x97E |
| 50 mine | 0x67E |
| **62 harbour, 63 shipyard** | **0x405E** = 0x4000 \| 0x40 \| 0x10 \| 0x08 \| 0x04 \| 0x02 |
| everything else | 0x87E |

0x405E has **no 0x20 (water) and no 0x400 (low land)**. Every other building still forbids
water in its padded footprint.

The placement scan is the base one (`units-and-jobs.md` 6.1): the footprint grown by one cell on
every side is OR-ed for flags, and the slope ring (distance 2) must not differ by more than 64.
Gold adds one count to the same scan:

- **L** = the number of cells in the grown footprint that are land (0x2000 set, 0x20 clear).
- If **L < 1** or **L > size_y + 3** (size_y = record +0x0C), flag **0x4000** is added.

Only the harbour and shipyard masks contain 0x4000, so for them:

- at least one land cell, and at most size_y + 3 land cells, in the (size_x + 2) × (size_y + 2)
  area. For a 3 × 3 harbour that is 1..6 of 25 cells, so the building stands **mostly in the
  water** and touches the shore;
- no unit, building, special or nature object (fish included) in the area;
- the slope rule still applies. Sea cells all have height 120, so the shore beside the site must
  be low.

The same rule is in the UI click test (`0044bdb0`, which also adds the base territory and
own-area bits) and in the AI site test. The AI passes a padded rectangle, so its limit is
"padded height + 1" (8.1).

**Fog.** The UI preview and click use the mask 0x405E **+ 0x80** like every building
(`0x445ED7`), so the whole grown footprint must be **currently in sight** for the local player;
explored-but-fogged shore is refused like unexplored shore. The harbour and shipyard are exempt
from the **territory** test only (no 0x800). The simulation (`004571e0`) tests no fog and no
territory. A ship's vision disc counts (ships are units, 4.1). Details and the Gold mine preview
quirk: `units-and-jobs.md` 6.1.1.

Missing goods do not block placement (base rule). The shipyard also has a goods top-up (3.5).

### 3.2 Construction (C)

- The site is created as usual: HP / 10, a construction job, a builder request and goods
  requests (`units-and-jobs.md` 6.1).
- **No foundation** is built for types 62 and 63: no levelling, no paving
  (`units-and-jobs.md`, foundation section, Gold note; `0044c7d0`).
- **Builder** (`00481710` = AN `00477ce0`):
  - in phase 0 the builder faces the building **centre**, worked out from the footprint;
  - phase 3 ("walk to the next spot around the building") is **skipped** for 62 and 63. The
    builder stays on its spot and the next call comes after **30** ticks.
  - So the builders of these two buildings work from wherever they arrived. They reach the
    building by the normal go-to target choice (`00485dc0`): the entrance (the footprint's max
    corner, because door = 0,0), or the nearest cell their mask allows.
- Progress, HP and goods consumption follow the base rules.

### 3.3 Activation and the harbour as a store (C)

- Neither building has an operator, so both are **active at completion** (base 6.5).
- The harbour carries the store flag (0x1). Any goods dropped into it go **straight into the
  town stock**, clamped to the town capacity. It adds **no capacity**, because bit 0x10 is not
  set (`00465d00`).
- **Porters never use the harbour**: the nearest-store choice still takes only the town hall
  and warehouses (`00461460` unchanged). Ships use it: fishing boats deliver there (6.2), trade
  ships load and unload there (5.7).
- Food delivered to the harbour counts as food produced this round (town add function `00477d80`
  = AN `0046e820`, `economy.md`).
- Like a market (bit 0x20), the harbour shows the market settings page (`VERKAUF`) and uses the
  town's market settings (town +0x54C in Gold = AN +0x4EC).
- A foreign harbour at **peace** gives vision of radius 6, like a foreign market (`0043a750`,
  `0043a860`, relation side effect `0045e100`; `fog-of-war.md` 3).
- **Vision** (`fog-of-war.md` 3.1): the own harbour sees radius 6 around its anchor (max corner)
  from completion on, like the market; the **shipyard has radius 0 and never lifts fog** (its
  completion explores nothing either). Building them outside the territory changes nothing about
  vision. Checked at instruction level in `dvge.exe` (`0043a750`, completion `00466590`).

### 3.4 Shipyard: training ships (C)

The shipyard is a **training building** (class 5). Every ship is a unit with made-at = 63, so
the base training rules apply unchanged (`units-and-jobs.md` 9; job 0x12 `0047f810` = AN
`00475d50`, finish `0047fab0` = AN `00475ff0`):

- Queueing charges the price, requests the goods (priority 0) and files a porter request.
- The order needs the invention (base check `00465600`).
- A **porter** enters (class-5 buildings admit everyone **except ships**, `00466cd0`) and is
  retyped in place into the ship. Retyping sets the ship masks (2.3). The porter is consumed.
  As in every training building, any unit already inside is used instead (a builder ordered into
  the shipyard becomes the ship, and no porter is called; `units-and-jobs.md` 9.1).
- Duration: ceil(HP / 5) × 30 ticks.

  | HP | ticks |
  |---|---|
  | 100 (fishing boats) | 600 |
  | 250 | 1500 |
  | 300 | 1800 |
  | 350 (transports) | 2100 |
  | 450 | 2700 |
  | 500 | 3000 |
  | 600 | 3600 |

- **Launch**: the new ship is ejected with a leave job (0x0D, `00484e00`). The entrance cell is
  the shipyard's max-corner cell, which the building itself occupies. The leave job therefore
  polls (runs 2..4) and at run 5, 35 ticks after the eject, falls back to the
  nearest-passable-cell spiral (`004853c0`) with the ship's mask 0xA01E: the ship appears on the
  **nearest open-sea cell** that holds no unit (C; the polls checked at instruction level, 3.7;
  `units-and-jobs.md` 4.10 for the leave job).
- The side panel shows the shipyard's training page as `KAEMPFERBAUEN` (every class-5 building
  except the school, `00427000`).

### 3.5 Quirk: the shipyard tops up its own goods (C, `0045faf0` = AN `00459b60`)

The build-menu check normally answers 3 ("not enough goods") when the town stock of good g
(0..4) is below the cost. Gold makes one exception, for **type 63 only**:

1. For each good g in 0..4 with stock[g] < cost[g]:
   - an amount a = 15 is computed. For **good 0 (raw material)** it goes through the crop
     conversion: the accumulator (town +0x68) += 15.0; if it now reaches the divisor (+0x6C ≠ 0),
     k = trunc(acc / div) units become food: food += min(capacity − food, 2k), the round's food
     counter (+0x60) grows by the same amount, a = 15 − k, and acc −= k × div *(the exact float
     formula of k is uncertain; the shipyard costs no raw material, so this branch never runs on
     shipped data)*;
   - for good 4 (food) the round's food counter (+0x60) also grows by 15;
   - stock[g] := min(capacity, stock[g] + a).
2. Return 1 (OK).

Every caller that checks type 63 therefore tops up a short town:

- the player's placement command (`004571e0`);
- the build-menu page (`0045bf20`, every time the page is built);
- the AI build queue (`00473b00`, when it queues the shipyard target of 8.1).

The AI training hook (`004740c0`) also contains a call with 63, but that branch is unreachable
(8.5). Shipyard costs are at most 15 per good, so one check is enough, and **the shipyard is
effectively free**. The goods are still carried to the site and used up.

In the original, the menu-page call runs on the client. It changes simulation state outside the
command stream, so it can desync in multiplayer *(I)*. A rebuild should apply the top-up only in
the simulation, at the placement command and in the AI. Keep a fidelity switch.

### 3.6 Destruction (C, `00465840` = AN `0045f5a0`)

Harbours and shipyards leave **no rubble**: the rubble step is skipped for types 62 and 63.
Everything else is base: collapse, occupants ejected, upkeep removed. The harbour adds no
capacity, so it removes none either. Ships in a destroyed shipyard's queue are refunded as usual.

### 3.7 The door cell: land units entering and leaving (C, leave job `00484e00`, place `004676d0`)

Every race's harbour and shipyard has the door offset **(0, 0)** in `Addon.odb` (3 × 3, the
Pimmon shipyard 3 × 2). The entrance cell (+0x70 = anchor + door offset, `units-and-jobs.md`
4.10) is therefore the building's **own max-corner cell**, a footprint cell that holds the
building's object index. Nothing in Gold special-cases types 62 or 63 for entering or leaving;
the base rules simply meet an entrance that is never free.

**Who leaves them on foot.** Porters that delivered goods to a shipyard (the goods of its
training orders, 3.4) and any unit sent out of a shipyard (a unit inside a training building,
`units-and-jobs.md` 4.11). Porters never take goods to or from a harbour (3.3), and nobody stays
inside a harbour, so on foot the harbour is reached only by builders and by porters supplying
its construction site (no leave job at a site, `units-and-jobs.md` 4.10).

**Entering** (base rules, not re-traced for Gold): the go-to target choice (`units-and-jobs.md`
4.8) finds the building on the entrance and its four orthogonal neighbours mostly footprint or
water, so its ring search picks the nearest cell the planning mask 0x3C allows: a shore cell next
to the building. Units are ignored there, so every carrier walks to the **same** shore cell.
There is no distance test, so the unit enters from where its walk ended.

**Leaving** (leave job 0x0D, `00484e00`; checked at instruction level). The Gold leave job
branches on the **container's** class (record +0xC0 = 14, a ship: 5.3); for a building it is the
base job of `units-and-jobs.md` 4.10 unchanged:

| run | tick after the eject | harbour / shipyard |
|---|---|---|
| 1 | +10 | door counter + 1 (door message on 0 → 1); returns 10 |
| 2, 3, 4 | +20, +25, +30 | the entrance cell's index is not 0xFFFF (it is the building itself). The object found there is not a unit (record kind +0xA4 ≠ 0), so **nothing is pushed**; returns 5 |
| 5 | +35 | still taken: the square spiral `004853c0` (the base `0047a9b0`) from the entrance, with the **leaving unit's movement mask** (+0x24: 0x3E for land units): the first cell with no unit, building, special object, nature object or water. Slope and island id are not tested. The unit is put there (place method +0x1C) |

So a land unit always comes out **35 ticks** after its eject (never earlier), on the **nearest
free land cell** around the max corner in spiral order (ring 1 from (x+1, y−1) through +y, −x,
−y, +x; then ring 2, and so on). Because a unit's index is on its cell from the moment it is
placed (`units-and-jobs.md` 4.7), the next unit to come out skips that cell and takes the next
free one: **two units never share a cell after leaving a harbour or shipyard**. Several porters
that delivered in a row stand on neighbouring shore cells, one per cell, in spiral order.

- No push and no step aside: the entrance holds the building, so the unit-in-the-way branch of
  the leave job never runs here; units already standing on the shore are not moved.
- The spiral has no ring limit and no island test *(quirk by reading: if land of another island
  were closer to the max corner, in spiral order, than any free cell of the building's own
  island, the unit would be put there)*.
- Facing: the place method writes **5** (door offset x = 0 is not negative).
- What the unit does next is the base rule: a job queued behind the leave job resumes; a porter
  whose transport ended has no job and **stands idle where it was put** (free porter, leisure
  job `units-and-jobs.md` 5.7). Nothing walks it away from the shore.
- Ships take the same job. A ship launched from the shipyard therefore also polls runs 2..4 and
  is put at run 5 on the first spiral cell its mask 0xA01E allows (3.4). A docking ship (5.8)
  runs it too, but the place method sees that the ship still owns its own map cell and only
  clears "inside": it stays where it docked.

---

## 4. Ships as units

### 4.1 Common rules (C)

- Ships are ordinary unit objects (category 0) with class 14. They have a town, a nation and a
  target tier. Types 64..67 are not in the tier-0 list, so they are **tier 1** (`004680d0`
  unchanged). Harbour and shipyard are tier 2.
- **Movement**: the normal planner and follow-path job (`00485dc0`, `0048b230`) with the ship
  path mask. Step delays follow `units-and-jobs.md` 4.1 with the record's step times. On water
  the height class is always 0 and there is no worn-path bonus:

  | step time | straight (s + 1) | diagonal (floor(1.5 × (s + 1))) | ships |
  |---|---|---|---|
  | 3 | 4 | 6 | Amazon patrol boat, Panzerlanguste |
  | 4 | 5 | 7 | Zerstörer |
  | 5 | 6 | 9 | fishing boats, transports |
  | 6 | 7 | 10 | Kreuzer |
  | 7 | 8 | 12 | Seepyro |
  | 8 | 9 | 13 | Schlachtschiff |

  A ship on an attack job (0x08) as its top-level job charges at s − 1, as in the base game.
- A **move order** uses the base move command (`00456d90` = AN `00451170`). Each selected unit
  gets a free cell near the target point, found by a spiral with its own blocking mask, so a
  ship gets a water cell. The one exception: a **fishing boat** gets a fishing job instead
  (6.1).
- **PATROL** is offered for types 65 and 66 as well as the land soldiers 29..36 (`0041b5d0`).
  The patrol and guard jobs are unchanged.
- Ships **never enter buildings** except to dock (5.8). Class-5 buildings refuse them. The
  builder entry rule refuses them too (`00466cd0`).
- **No healing, no repair, no rank**: a damaged ship stays damaged until it sinks. 4.3 lists
  every path checked. Experience is kept only by types 17, 21 and 29..36 (`combat.md` 5.3).
- **Vision** is the record's sight radius, like any unit (`fog-of-war.md` 3).
- **Unit info page** (`0045b9a0`): the passenger count (+0x5C) is sent with the unit data (it
  drives `AUSSTEIGEN`, 5.6). A unit inside a ship shows T280 "in <name of the ship type>", like a
  unit inside a building.

### 4.2 Who may act on what (C, `0046b9a0` = AN `00465460`)

| actor | target | allowed |
|---|---|---|
| fishing boat (64) | nature object | only fish (class 15), like the hunter with animals |
| any armed unit, ships included | other race | always (base rule) |
| priest | damaged unit | not if the target is a ship |
| everything else | | base rules |

Fishing boats are armed (weapon 27). They may attack foreign units and buildings, and they join
fights through the help rule (`combat.md` 7.1) *(by reading)*.

### 4.3 Ship HP is never restored (C, checked at instruction level, October 2026)

Gold has **no way to raise a ship's HP**: no builder repair, no priest healing, no repair while
docked at a harbour or in the shipyard, no upgrade, no regeneration. Every path:

| path | what the code does | result for a ship |
|---|---|---|
| builder repair command `Restaurieren` (command class 0x54, run `004585d0` = AN `00452a70`) | files a builder request (`00465750` = AN `0045f4b0`) for the first selected object. The command is built only by the **building** info page (page 1, `0041beb0`, button at (40,135), `0041c285`) and by the message factory (`00459b75`). A selected ship shows the **unit** page (page 0: the unit info message `0045b9a0` writes page 0 for every unit, ships included), which has no repair button | not offered |
| builder right-click on a ship (`004567a0` = AN `00450bb0`, `456b??` branch) | the builder branch (job 0x0C) is taken only when the target's object category (+0x08) is 1, a building. A ship is a unit (category 0), so a builder gets the plain go-to (0x07) | the builder walks toward the ship (it cannot reach it, 2.3) |
| builder requests from elsewhere | the only other filers of a builder (type 11) request are the construction order (`0047f465`) and the builder destructor (`00481651`), both for building sites, as in AN | none |
| repair tick (builder job, `00481d12`..`00481d55` = AN `004782b3`) | +20 HP on the builder job's building | buildings only |
| priest heal, automatic scan (heal job run `0048c450`, scan `0048c140` -> may-act `0046b9a0` with the ally flag) | may-act refuses a class-14 target for a priest, own race (`46babc`) and foreign at peace (`46ba7f`) | a ship is never picked |
| priest right-click on an own damaged ship (`456c7f`..`456ca8`) | **no class test**: priest (type 22), target a unit (record +0xA4 = 0), HP < max, same race → heal job 0x29 with auto-continue, as in AN. This test comes before the go-to branch | a heal job is created, see below |
| help rule, priest branch (`00468f94`..`004690fb` = AN `00462ab0`) | **no class test**: victim a unit, X a priest, victim HP < max, X ≠ victim, same race or peace (state 3), X not on a heal job or player order → X's job is cancelled, heal job 0x29 for the victim | a heal job is created when a ship is hit within 12 cells of a priest |
| heal impact (kind 3, `0048ed64`) | HP += 7..12, clamped | never reached for a ship: see below |
| docking at a harbour (5.8, entered handler `004671b0`) | sets "inside", runs the goods handler, ejects. No HP write | none |
| shipyard | class-5 buildings refuse ships (`00466cd0`), so no retraining (which would reset HP, `combat.md` 13); the shipyard only builds new ships | none |
| HP-delta message (handler `004574e0` = AN `00451a70`: HP += a signed amount from the message, clamped, death at 0) | built only by the message factory (`00459345`); no page, hotkey, AI or job constructs it | unreachable |
| regeneration | none: every HP write next to a max-HP read (record +0xAC) in `dvge.exe` matches one in AN.exe one to one (29 sites: unit / nature / retype constructors, building decay, construction and completion, repair tick, the impacts, the HP-delta message), and no Gold-only code that tests class 14 writes HP (the class-14 tests are the masks, may enter, may act, entered, eject, leave job and the passengers page) | none |

**Why the heal job can never heal a ship.** The heal job strikes through an attack child with
the heal weapon (range 0, `combat.md` 13), which needs a firing position in the 8-neighbourhood
of the target (`combat.md` 3.4). A ship never stands on coastal water, so every cell around it is
water (2.3), and the priest's path mask forbids water. The firing-position search (`combat.md`
3.5) therefore always fails. The heal child has no auto-retarget, so after the fifth failed
search it ends (3.6); the heal job releases the patient and, with auto-continue, scans its sight
for the next patient through may-act, which skips ships. The priest heals a wounded land unit in
sight if there is one, otherwise the job ends and he stands idle. He does not move toward the
ship (a failed search writes no path).

Visible quirks of this (C):

- **A priest cannot board a damaged own transport ship by right-click.** The heal branch comes
  before the go-to (boarding, 5.2) branch, so the order becomes the futile heal job; the priest
  stays on shore. An undamaged transport is boarded normally.
- **The help rule takes priests off their work for a damaged ship.** A ship of the priest's race
  (or of a race at peace) hit within 12 cells of a priest cancels the priest's current job
  (unless it is a heal job or a player order) and gives him the futile heal job; with
  auto-continue he then heals wounded land units in sight, or stands idle.
- The cursor gives no hint: a priest is not a fighter, so its cursor is the arrow everywhere
  (`ui/cursors.md`).

---

## 5. Transport ships

### 5.1 Ships as containers (C; unit vtable 0x4B22F8 slots +0x10..+0x20)

`AN.exe` already had container methods for units: a door queue (+0x60), an occupant list (+0x54,
count +0x5C), and capacity in record +0xDC. Nothing used them. Gold uses them for type 67
(capacity 5):

| method | Gold | rule |
|---|---|---|
| may enter (+0x14) | `0046b5c0` | occupants < capacity **and the entrant is not a ship**. **No race test** |
| request entry (+0x10) | `0046b3d0` | on the first request, refuse (2) if "may enter" fails, else append to the door queue. Then, if the unit is the head of the queue: enter (0) when the ship's owner is a **computer** nation (nation +0x294), or when the wrapped distance unit–ship (max + min/2) is **< 4**. Otherwise wait (1, re-asked after 10 ticks). A dead head is dropped |
| entered (+0x18) | `0046b5f0` | if occupants ≤ capacity: the unit's "inside" pointer = ship, add it to the occupant list, pop the door queue, send display message (5,9) |
| place (+0x1C) | `0046b770` | clear "inside", set the position, display message (0x16,100) |
| eject (+0x20) | `0046b8c0` | remove from the list (occupants − 1), give the unit a leave job (0x0D) after 10 ticks, chaining its current job behind (blocked 5) |

Passengers are inside a container, so:
- they cannot be targeted (`combat.md` 3.2);
- they have no vision;
- a porter on board is never "free";
- **when the ship dies, every passenger dies with it**: the unit death kills its attached list
  (`combat.md` 10.1, unchanged code).

### 5.2 Boarding (C, go-to job `00485750` = AN `0047ac90`)

A right-click with own units on a ship that is not hostile gives each unit the base "go to
object" job (`units-and-jobs.md` 3.2: "any other unit"). For a target of **type 67**, Gold
changes how the walk target is chosen:

1. Search the ship's 20 near cells (2.4) for a cell whose island id equals **the unit's
   island**.
2. If none is found: if the ship's current job is a **sail-to-coast job (0x3B) that already has
   its landing cell** (+0x40 set), walk to that landing cell. Otherwise **wait**: the job returns
   5 and checks again.
3. Path to the cell with the normal target chooser, then turn and **enter** (job 0x0B against
   the ship, 5.1). On a human player's ship the unit must be within distance < 4 of it.

**The ship comes to the unit** (C, instruction level, go-to constructor `00485670`,
`0x4856c3..0x485729`): whenever a go-to-object job is **created** with a type-67 target, the
constructor cancels the ship's current job (whatever it is: a trade route, a sail job of the
naval planner, ...) and gives the ship a new sail-to-coast job (0x3B, 5.4) toward the **unit's
current position**, first run after **1** tick. This happens for every unit sent at a transport:
the player's right-click (5.6), the naval planner's boarding step (8.4, one per unit sent, so the
ship ends up with the job toward the last unit sent). There is no race or owner test, so a
player who orders a unit onto a foreign ship also re-routes that ship *(quirk)*. When the ship
is already within 2 cells of the unit's island, the new job finds a near cell of that island at
its first run and ends at once (5.4 step 1); otherwise the ship sails to the nearest coast of
the unit's island, and the boarding walk (steps 1 and 2) goes to that landing.

Other targets: the island test of 2.5 applies.

Consequences:
- A ship sitting off a coast is boarded from the shore cell at most 2 cells from it.
- Ships keep 2 cells from land (2.3), so the "< 4" rule normally holds once the unit is on that
  cell.
- Units of any race, foreign included, can board any transport ship, because neither the order
  nor the container checks the race *(quirk by reading)*.

### 5.3 Unloading (C, leave job `00484e00` = AN `0047a530`)

`AUSSTEIGEN` sends the base "send out" command (`00457b70` = AN `004520e0`) with type −1: every
occupant of the selected ship is ejected (5.1). The passengers page can send out one unit type
(5.6). Each passenger then runs the leave job. When the container is a ship (class 14):

1. Search the ship's surroundings with the site-search ring walk (`0044ed90`, radius **5**: the
   centre first, then rings outward, `world-populate.md` 2.3). The cell test is `00484a30`:
   - the cell is not water (0x20 clear);
   - if a unit with no job stands there, it is told to step aside (job 0x0F) as a side effect;
   - the test passes when (passenger's blocking mask & cell flags) = 0. The flags are read
     **before** the step-aside, so a cell with a standing unit fails this time.
2. If a cell is found, the passenger is placed there (container +0x1C) and the job ends.
3. If not, and the **ship has no current job**:
   - take the nearest cell around the ship that the passenger could stand on (spiral `004853c0`
     with the passenger's mask);
   - give the ship a **sail-to-coast job (0x3B)** toward that cell's island, scheduled after 1
     tick.

   Either way the leave job returns **50** and tries again.

There is no door animation for a ship. Several passengers retry independently. Each one
re-scans, so they land on different cells as the first ones take theirs.

### 5.4 Sail-to-coast job (0x3B) (C, `0048b830` / `0048b8c0`)

Fields: target island +0x24 (the island id of the given cell at creation), given cell +0x28..
+0x30, landing cell +0x34..+0x3C, "landing cell set" flag +0x40.

Each run without a child:

1. If any of the ship's 20 near cells (2.4) belongs to the target island, record that cell as the
   landing cell. Done (success, return 0).
2. Otherwise choose a sea cell to sail to:
   - ring search (`0044ed90`) of radius **32** around the ship for a cell that passes
     `0044cb40`: not land, no unit/building/special/nature, and one of its 20 near cells on the
     target island. The search does not test 0x8000, so the cell may be coastal water;
   - if none is found: spiral outward from the given cell (+0x28) to the first cell that the
     ship mask 0xA01E allows. The spiral has **no radius limit** (`0x48baab..0x48bb8b` loops
     until a cell passes), so a given cell deep inland still yields the nearest usable sea cell.
3. Store it as the landing cell, set +0x40, create a follow-path child (0x06) to it, and return 2.

With a child, the child runs. When it ends: on failure the job fails. On success it returns 1, so
the next run repeats step 1. Typical use: a ship that cannot unload sails until it is within
2 cells of the island, and the waiting passengers' 50-tick retries then find land.

If the chosen cell is coastal water, the ship cannot reach it. The follow-path job re-plans and
fails after 15 attempts (`units-and-jobs.md` 4.1), and the 0x3B job fails with it *(by reading)*.

### 5.5 Goods transport

- **No automatic goods transfer between islands.** Porters and the dispatcher never use ships.
  A town's stock is shared by all its buildings, wherever they stand, but deliveries need
  walkable paths (2.5).
- The only goods carried by ships are:
  - fishing catches (6);
  - **sea trade** (5.7), in which a transport ship carries up to 5 units of one good on a trade
    route.

  A transport ship's goods load (unit +0x38/+0x3C) is separate from its passengers.

### 5.6 Player commands and side-panel pages (C, `0041b5d0`, `00427000`, `004636e0`)

| element | unit | effect |
|---|---|---|
| `AUSSTEIGEN` button (tooltip T330 "Ausladen") | type 67 | command (class 0x3A in the message table) = send out all occupants. Disabled while the passenger count is 0 |
| page `BEWOHNER` (tooltip T329 "An Bord") | type 67 | lists the passengers; send-out per type as for buildings |
| page `HANDEL` | every 0x40 unit (traders, transports) | trade-route page (5.7) |
| `PATROL` | 65, 66 (and 29..36) | patrol |
| `VERKAUF` | buildings with 0x20 (market, harbour) | market settings |
| default page | type 67 | the passengers page (6) |
| unit status | | T327 / T328 for fishing (6.2); "in Transportschiff" for passengers |

### 5.7 Sea trade (C, trade job `00487b90` = AN `0047ce00`)

The base merchant rules (`ai-diplomacy-trade.md` 4.4) apply to every unit with flag 0x40, with
these differences:

- **Terminal building**: market (48) for type 28, **harbour (62)** for everyone else, i.e. the
  transport ship. "The harbour of town T" means T's harbour nearest to the ship, in any state
  (`00460db0`).
- **Partner towns** (`00463ef0`):
  - for a merchant: towns with an active **market** whose town position lies on **the merchant's
    island**;
  - for a ship: towns with an active **harbour**, on any island.

  Race and peace rules and the AI flag test are unchanged. The route panel's partner list uses
  the same rule (`0045cc30`).
- The route command (`00457d60`) accepts any unit with flag 0x40.
- The loading cap of **5 units of one good**, the prices, the money flow and the market settings
  are unchanged (`00488290` = AN `0047d4d0`). The settings are per town, so a harbour and a market
  of one town share them.
- When the destination town has no harbour, a ship's route ends at once, without the merchant's
  "walk home".
- Trading happens when the ship **docks** (5.8) at the harbour while its current job is the
  trade job (`00487190`).

### 5.8 Docking (C, `004671b0`, `004676d0`)

A ship that "enters" a building (a harbour, as transport or trade destination) does not leave the
map:

1. The go-to target is the harbour's entrance, its max-corner cell. The chooser (`00485dc0`)
   falls back to the nearest cell the ship may use, so the ship stops at the nearest open sea to
   that corner.
2. The enter job asks the building. **Buildings have no distance check**, only the door queue
   (`units-and-jobs.md` 4.4), so the ship docks from where it stopped.
3. The "unit entered" handler sees a class-14 unit. It sets "inside", skips the occupant list,
   operators and activation, pops the door queue, runs the goods handler (transport drop/pickup,
   or trade), and ejects the ship at once.
4. The building's place method sees that the ship still owns its map cell and only clears
   "inside". The ship stays where it was.

---

## 6. Fishing

### 6.1 Fish and fishing grounds (C)

- **Fish** are nature objects of class 15 (types 41..45) placed in the water by the map. Their
  placement is a format matter, see `docs/formats/addon.md`.
- The nature constructor (`00469d50`) makes them "living animals" (+0x4C = 1), removed when empty
  (+0x4D = 1), with no wander job: **fish do not move**. They block ships like any nature
  object.
- Display: a fish rests on `MS0`, a 9-pixel dot. It leaps once (`ID0`, 5 fps) when its random
  5..30 s idle timer fires while on screen. Fish (types 41..45) are **excluded from click and box
  selection** in `dvge.exe`. See `docs/rendering/objects.md` 5.3 and 8.
- A fish has 10 HP and holds 2 or 3 food. Record +0x120 is both the catch size and the remaining
  amount.
- **"Fischgründe"** (fishing grounds) is not an object. It is the cell a fishing job works
  around, set by the player's move order or by the AI.
- **No regrowth, no respawn** (C by reading):
  - the fishing job never runs the depletion routine, so it files no respawn entry;
  - fish emptied by a harvest job (6.4) are filed like animals (radius 10, countdown 20,
    `00469b20`). The respawn manager (`0048d920`, `units-and-jobs.md` 7.5.1) needs a **tree**
    (class 8, palms included) within 10 cells of the fish and then spirals to the first cell
    without the flags 0x1003F, which include water (0x20): such a "fish" would be created on
    land. Fish in open sea have no tree nearby, so in practice they never come back. Fishing
    grounds are finite. *(Our build files no fish at all.)*

### 6.2 The fishing job (0x3A) (C, run `004830b0`, search `004834e0`)

Created by:
- the **move order** for a fishing boat (`00456d90`). The boat's current job is cancelled, the
  job is given the chosen free water cell as its grounds, scheduled after 1 tick and marked as a
  player order;
- the AI (8.3).

Fields: fish +0x24 (referenced), grounds +0x28..+0x30, phase +0x34 (0 going, 1 fishing,
2 delivering). Status text: phase 0 T327 "Unterwegs zu Fischgründen", phase 1 T328 "Fischt",
phase 2 that of the transport child (`004836e0`).

**Search** (`004834e0`, also run by the constructors):

1. If there is no fish, or it is gone:
   - spiral search (`004689c0` = AN `00462630`, up to 10 rings) around the grounds for a fish
     that passes `00482f30`: type 41..45, object alive (+0x34), remaining ≠ reserved.
2. If no fish is found:
   - up to 10 tries: x = gx + 4 − rand() % 9, then y = gy + 4 − rand() % 9 (wrapped; two rand()
     per try, x first);
   - the first cell with the **water flag 0x20** becomes the new grounds. Coastal water counts.
   - If all 10 tries fail, the grounds stay as they were.
3. If a fish is found: take a reference (refcount + 1). **The grounds move to the fish's
   cell.**
4. Create a follow-path child (0x06) to the grounds cell, with the child's flag +0x44 = 1
   *(I: "arriving next to a blocked target counts")*. Phase = 0.

**Run:**

| state | action |
|---|---|
| child running | run it; return its delay |
| child ended **with failure**, any phase | the job fails (return 0) |
| phase 0, child succeeded, fish set and alive | start fishing (below). Phase 1. Return **50 + rand() % 50** (50..99 ticks) |
| phase 0, child succeeded, no fish or fish gone | search again; return 50 |
| phase 1, no child (the wait is over) | **catch** (below) |
| phase 2, child succeeded | stop fishing (below); search again; return 1 |

**Start fishing**:
- Sajiki: action message (0x19,11) with action 2 (work), sound frame record +0x04 and parameter
  100;
- other races: the boat's base movement action (+0x40) becomes 2, message (7,7).

**Stop fishing**:
- Sajiki: stop message (0x27,11);
- others: base action back to 0, message (7,7).

**Catch**:

1. The boat's carried good := the fish record's yield good (+0x11C = 4, food).
2. **Carried amount += the fish record's amount** (+0x120 = 2 or 3). It is added, not set: a
   load kept from a failed delivery grows.
3. The fish is released (refcount − 1) and its die method is called. A living fish only loses
   its living flag and **stays with its full amount**. It still passes the search predicate, so
   the next catch takes it again, and that second die call removes it. **Each fish yields its
   amount twice** (4 or 6 food) *(quirk, C by reading)*.
4. Phase = 2. Find the town's **harbour nearest to the boat** (type 62, any state; `00460db0`).
   - Found: give the job a transport child (0x05) with no source, destination = that harbour, and
     the carried good. Return 1.
   - **No harbour**: the job fails and the boat keeps its load.

The transport child docks at the harbour (5.8) and drops everything into the town stock, clamped
to capacity (3.3).

Rough timing (Pimmon fishing boat, harbour 10 cells away, fish 2 cells from the grounds):
2 × 6 ticks to the fish + 50..99 fishing + about 60 ticks to the harbour + docking (door queue,
10 + 1 ticks) + about 60 ticks back. That is about 3 food per **200..250 ticks** per boat.

### 6.3 Ordering a boat onto a fish (quirk, C, `004567a0`)

A right-click of a fishing boat on a fish (harvestable for type 64 by `00469a20`) **constructs a
fishing job and throws it away** (leaked, never scheduled). Its constructor has already taken a
reference on the fish and created a path child. The order then gives the boat a normal **harvest
job (0x16)** with auto-continue on the fish:

- phase 0: the fish is a living animal, so the boat attacks it (weapon 27, 20 damage, 100 %; one
  hit kills);
- it then works the carcass for 100 ticks per unit (1 food per trip; only hunters take 4);
- it carries the food to the **nearest store**, i.e. the town hall or a warehouse. That store is
  on land, so the go-to fails at once (2.5);
- the harvest job retries delivery every min(5 × trips, 25) + 2 ticks, forever.

The working way to fish is the move order. A rebuild should copy this for fidelity but may offer
a fix that gives the fishing job instead.

### 6.4 Yield compared with land food

Bushes give 1 food per 100 ticks of work plus walks. A hunter brings up to 4 per trip. A fishing
boat brings 2..3 per trip with no work time except the 50..99-tick wait. It needs a harbour,
which in turn needs a shipyard first (inventions 30 → 31).

---

## 7. Sea combat

The whole pipeline of `combat.md` is unchanged (attack 0x08 `0047c590`, strike 0x09 `0048c720`,
impact 0x15 `0048ced0`, range and line of fire `0047a420` / `0047ad40`, firing-position search
`0047c050`). What follows is what it means at sea.

- **Weapons and delays**: table 1.3. Ships have sound frame 0, so the impact delay is only the
  flight: (d64 × 1000 / speed) / 100 + 1.

  | attacker | target distance | impact delay |
  |---|---|---|
  | Kreuzer | 8 straight (d64 = 512) | 6 ticks |
  | Schlachtschiff | 12 straight | 768 × 1000 / 700 = 1097, so 11 + 1 = 12 ticks |
  | melee (Zangen, Angel) | adjacent | 1 tick |

- **Range and line of fire**: the base Bresenham cost. Water is flat, so ranges are the plain
  "R straight, floor((2R + 2)/3) diagonal". Only buildings block shots, and a harbour or shipyard
  is a building. Trees, units and fish do not block.
- **Firing position search**: the attacker's own path mask. Ships look for firing cells on open
  sea, land units on land.
- **Who can hit a ship**:
  - ranged units on land or sea within range;
  - outposts' garrisons, which use the same range and line-of-fire test (`combat.md` 9);
  - melee ships (Panzerlanguste, fishing boats) when adjacent at sea.

  No melee land unit can ever reach a ship (2.3). Its attack job finds no firing cell and gives
  up after the base 5 searches (`combat.md` 3.5).
- **What ships can hit**: anything in range, buildings on the coast included. Cannons with range
  12 reach 10 cells inland from the closest sea cell. Melee ships can only hit other ships, and
  fish.
- **Automatic fighting**: ships join fights through the help rule and patrol jobs (`combat.md`
  7, 8) and keep fighting through the retarget after a kill (`combat.md` 3.6: the next object of
  the dead target's race within sight + 3 of it, land units and buildings included). An idle
  ship, like an idle land unit, never scans (`combat.md` 8.4; confirmed: no attack job is created
  by any Gold-only code). The AI's warship wanders with job 0x28 (8.2).
- **Sinking**: a ship at 0 HP dies like any unit. Its passengers die with it (5.1). The display
  plays the race's death effect (`combat.md` 6). There is no wreck and no rubble.
- **Coastal defence**: no new building. The base outposts (52/53) do the job.

---

## 8. Computer players

### 8.1 Building targets (C, `00474680` = AN `0046b490`)

These apply in add-on mode, in the "normal targets" branch (N ≥ 5 completed buildings; P =
population):

| type | target |
|---|---|
| 62 harbour | 1 if P > 19 |
| 63 shipyard | 1 if P > 14 |
| 48 market | additionally 1 if P > 25 and the nation's town list holds a town of **another race** on this town's island. The list holds only the nation's own towns, so this never fires *(dead code by reading)* |

Queue priorities (table 0x4BD078, extended from AN 0x4AFEE8; lower is earlier):

| type | 62 harbour | 63 shipyard | 64 fishing boat | 65 | 66 | 67 transport |
|---|---|---|---|---|---|---|
| priority | 8 | 4 | 12 | 14 | 14 | 4 |

The AI site test uses the harbour/shipyard mask plus 0x100 (no mountains), the land-count rule
(3.1) and the town's own area. A town without a suitable shore inside its area never gets these
buildings.

### 8.2 Gangs (C, `00478180` = AN `0046ebc0`; fill `00477f90`)

Add-on mode only:

| gang | size | wanted in planner array A |
|---|---|---|
| fishing boats (64) | 1, only when the food gangs are enabled (same condition as hunters) | A[64] = 1 |
| warships (65) | 1 if P > 20, else 0 | A[65] = (P > 20) |

- Every member of the warship gang without a job gets job **0x28** (random map cells,
  `combat.md` 15), first run after rand() % 5 + 1 ticks. The AI patrol ship therefore wanders
  the sea at random. Each round of the job (Gold `00487700`): x = rand() % size, then y; walk a
  square spiral from that cell to the first cell the unit's own blocking mask (unit +0x28; the
  ship mask for ships) allows; a follow-path child job (kind 6) to it; the job returns
  rand() % 5 + 1. While the child runs, the job returns the child's result; when the child ends
  (arrived, or no path to another sea body), the next round draws a new cell.
- A released fishing boat (gang trimmed) is sent to the town's first **shipyard**, when the town
  has a harbour and a shipyard, instead of to the school. Ships cannot enter class-5 buildings,
  so that walk fails *(quirk by reading)*.
- The AI economy job runs only while the town's capacity is not 0 (`004783c0`; 10.4).

### 8.3 AI fishing (C, `00477610` = AN `0046e260`, class 15)

In the gathering phase (every 150 ticks, when food space > 5), for every living member of the
fishing gang:

1. Up to 41 tries: a random cell, x = rand() % n, then y = rand() % n. Stop at the first cell
   with **island id 0** (water).
2. If the cell is water, give the boat a new fishing job (0x3A) with that cell as its grounds,
   through the "give job" routine (first delay 5). **The current job is replaced** even if the
   boat is busy.

AI fishing boats are therefore sent to a new random spot of the whole sea every 150 ticks while
food is short. They only catch fish near that spot. The routine never counts as "found
something" for the AI's free-food gift (`ai-diplomacy-trade.md` 1.8).

### 8.4 Naval planner (job 0x3D) (C, `00472270`, run `00472b30`, every 10 ticks)

**Created** for every computer nation in add-on mode, next to its think job (nation +0x25C),
first run after 10 ticks (`00462e10`).

**State:**
- a map of the nation's **transport ships**: ship id → {state, request id, counter, timer};
- a map of **transport requests**: id → {state, pickup cell, destination cell, units waiting
  (list), units still to collect, goods amount};
- the next request id;
- two per-type counters, 68 entries each:
  - **claim[t]** (+0x54): how many existing ungrouped ships of type t to take over;
  - **build[t]** (+0x164): how many to have trained (8.5).

  Initially claim[67] = 1, so the first free transport ship of the nation joins the planner.

**Ship states** (one pass over the ship map per run; dead ships are skipped):

| state | meaning | transition |
|---|---|---|
| 1 | idle | listed as available |
| 2 | sailing to a pickup | when its job ends: state 3, and the boarding step (below) runs |
| 3 | boarding | timer + 1 per run. When it exceeds 50 (about 500 ticks): state 4. The ship gets a sail-to-coast job (0x3B) toward the request's destination cell, first run after 5 ticks |
| 4 | sailing to the destination | when its job ends: state 5 and **eject every passenger** (5.3) |
| 5 | unloading | timer + 1 per run; above 50: state 1 |

**Boarding step** (`00472940`, instruction level `0x4729a7..0x472b10`, re-read 2026-10-17),
with the ship's counter c and its passenger count p (occupants, +0x5C). It runs **once per
trip**, when a ship in state 2 has no job any more (ship pass above):
1. n = c − p. If n < 1, the ship skips boarding: state 4 at once, its current job is cancelled
   and it gets the 0x3B job toward the request's destination (first run after 5 ticks).
2. Otherwise, if c = 100, c := 0. Then for the entries of the waiting list in list order, while
   n > 0: cancel the unit's job, give it a go-to job to the ship (boarding, 5.2; its constructor
   also re-aims the ship at that unit), first delay 5, drop the planner's reference, remove the
   entry, n − 1, c + 1. **There is no test of the unit**: a unit that has died meanwhile (the
   list's reference keeps the object), one already aboard another ship or one inside a building
   is sent and counted like any other. A dead unit's job never does anything.
3. When the request's list is empty, request state = 3 (served).

Nothing else happens at the pickup: the ship waits 50 runs (state 3) whatever happens, then
sails. Who actually gets aboard is decided by the units' boarding walks and the ship's door
(5.1): the first **5** (capacity) to reach their shore cell enter, a later one is refused at its
first entry request (ship full) and stands idle on the shore, out of the request for good; one
that has not arrived when the ship leaves follows the ship's new job (5.2 step 2) or waits.

**The ship counter c** (record +0x0C; all writes, instruction level):

| where | value |
|---|---|
| registration `00471fd0` (`0x47206d`) | 100 |
| request service in `00472b30` (`0x472e69`), when it assigns an idle ship | 100 |
| boarding step `0x472a2c` | 100 → 0 before the list walk |
| boarding step `0x472af5..0x472afb` | + 1 for every list entry sent |
| save / load (`0040c900` / `0040cc20`) | stored and restored as is |

Nothing else writes it: not the assignment inside **New request** (`0x4727e1..0x4727ee` writes
only the state and the request), not the unloading, the return to idle, a cancelled request
(`00472f90`) or docking. So 100 means "no limit", and any other value is **the number of list
entries sent to this ship since it last received 100**. Consequences *(quirk)*:

- A ship assigned by the request service (c = 100) sends **every** waiting unit of the request,
  up to 100, and the 5 first to arrive board; the rest are dropped from the request.
- A ship assigned by New request (it was idle when the request was made) sends at most c − p
  units, and c then grows by the number sent. A ship whose last service trip carried one unit (a
  founder, a lone hunter) sends 1, then at most 2, then 4, 8, ... at its later direct
  assignments, as long as the requests hold that many; it is never locked to one unit.
- c = 0 (the ship got 100 and then found the list empty, typically because another ship of the
  same request had already sent everybody) stays 0 while the ship is only assigned directly: it
  sails to every destination empty, until the request service assigns it again.
- A request's units are never merged with another request's: each ship works for one request
  per trip. A request of n units asks for ships until their free places cover the units still in
  its list (request service); the assignment at New request takes idle ships for n units at once.

**Request service** (each run, for each request with state < 3, in id order):

1. Sum the free places (capacity − passengers) of the ships already assigned to it (state 2,
   this request).
2. If that is less than the number of units still waiting in its list, take the next ship of
   the **idle list**: the ships that were in state 1 during this run's ship pass, in ship-id
   order (a ship that turned idle in this pass is not in it); each idle ship is used once:
   - state 2, request = this one, counter = 100;
   - its current job is cancelled; it gets a 0x3B job toward the pickup cell, first delay 5.
3. If the idle list is empty, count the request as unserved.

Then: with u unserved requests, if u > 3, set build[67] = u/2 and claim[67] = u − u/2.
Otherwise, if the number of ships known is less than u, set claim[67] = 1.

**New request** (`00472630`), with a 13-field record {+0x00 kind (8 by default), +0x04 units
n, +0x08 goods g, +0x0C/+0x10 pickup, +0x14/+0x18 destination, +0x20 flags, ...}; the record's
default constructor (`0040d050`) sets kind 8 and flags = 1 (the constant at 0x4B35E0):

- A request with no units and no goods is not stored (checked first, `0x472664..0x472670`).
- If **flags & 1** is set and the planner holds **more than 50 requests**, refuse (return false,
  `0x472676..0x472684`). The count is the size of the request map (+0x3C), and requests are
  **never removed** from it except by a cancel (`00472f90`, founding only; the save
  `0040c900` writes all of them): served requests (state 3) stay forever. So from the 51st
  request a nation has ever made (minus cancelled ones), **every army request is refused**
  *(quirk)*; the army join still gives the group the wait job 0x3E (below), so those members
  wait until their army ends. Founding requests are not affected: the founding code clears the
  whole record, flags included (`0x46f61d..0x46f645`), before filling it.
- Otherwise store it (state 2, i.e. open) with the next id. Assign the ships that are idle
  (state 1) at once, in id order, each reducing n by its capacity and g by 5 (not below 0),
  until both reach 0. Each assigned ship gets state 2, this request, its current job cancelled
  and a 0x3B job to the pickup cell (first delay 5); its counter is left as it is (see the
  boarding step).

**Other entry points:**

| function | called by | effect |
|---|---|---|
| `00471f40` | founding, army | add waiting units to a request; each unit is referenced |
| `00471fd0` | AI training hook (8.5) | register a ship: consume one count of its type (build[t] first, else claim[t]), set the unit's **group to 61** (0x3D), add it as idle |
| `00472160` | unit death (`00468790`), when a unit of group 61 dies | drop the ship; claim[type] = 1, so the next free ship of that type is taken over |
| `00472f90` | founding | cancel a request (state 3, removed from the request map); **every** ship whose request is this one becomes state 1 whatever its state (a ship already sailing keeps its job and passengers) |

**Users:**

- **Founding** (`0046f340` = AN `00467f80`; full run order in `ai-diplomacy-trade.md` 1.12):
  - when the AI founder (no job) must reach a site, a cell 8..15 cells from the site is found
    with a 30-ring search (`0046ef70`: free land for the founder, distance 8..15);
  - if that cell is on the founder's island, the founder walks there (base);
  - otherwise a request is made: 1 unit, pickup = the founder's position, destination = that
    cell. The founder is added to it and gets job **0x3E (wait for a ship)**, first run after 5
    ticks: the run only returns 500, so the unit idles until the planner replaces the job with a
    boarding walk;
  - when the site becomes invalid and a new one is found, a founder waiting with job 0x3E has
    his request cancelled (`00472f90`, the request id is in the job), and the founder's job is
    cancelled whatever it is, so the next run asks again;
  - **once the founder is aboard** (unit +0x6C = the ship), the mission's next run ends it
    (`ai-diplomacy-trade.md` 1.12 step b, confirmed at `0046f401..0046f404` / `0046f7aa`). The
    ship still carries him over and ejects him, but he lands with no job and group 54 and never
    founds *(quirk)*.
- **Army** (`0046c050` = AN `00465ad0`, the join; runs when the army is created and at every
  think that adds new candidates; full rules in `ai-diplomacy-trade.md` 2.5 "Joining and
  moving"):
  - joining warships (65, 66; candidates in add-on mode, `00470140`) sail to the nearest
    ship cell of the target town's position;
  - the joining land units whose island differs from the target point's are grouped by island;
  - for each group, one request is made: n = the group's size (the members of this join on
    that island, not the army's earlier members), goods 0, pickup = the first member's
    position, destination = the army target point, the default record (kind 8, **flags 1**,
    `0x46c8c3..0x46c994`): refused once the planner holds more than 50 requests (New request);
  - every member of such a group gets job 0x3E (with the request id), whatever the request's
    result (`0x46c999..0x46ca28`). Members on the target's island move as in the base game.
- **Unloading at the destination** (state 4 → 5 above): every passenger is ejected (5.1) and
  placed by its leave job (5.3; `00484e00` ship branch `0x485288..0x485380`, place `0046b770`).
  That is all: the passenger had no job aboard (its boarding walk ended when it entered), so
  nothing is chained behind the leave job, and it stands on the coast **with no job**: no
  attack, no walk, no scan for enemies, no message to its army. The landing point is where the
  ship's sail job toward the destination stopped: the first spot within 2 cells of the target
  point's island (5.4), i.e. the coast of that island nearest the ship's approach, which can be
  far from the target point. What the unit does next comes from the rules for jobless units: the
  help rule and the flight rule (`combat.md` 7, 8.4), the army's next run if it is still a
  member (`ai-diplomacy-trade.md` 2.5 step 6: a member without a job gets an attack job on the
  current target wherever it stands), and otherwise the rules for free units (the next think's
  army, the gangs).
- **Strategy** (`0046cbd0` = AN `00466020`, `0046d9e0` = AN `00466e20`): when the army's idle
  members get attack jobs, members on board a transport ship are skipped (not counted for the
  six / three per target), and they keep sailing.

### 8.5 Training ships (C, `004740c0` = AN `0046b0f0`)

This is part of the planner's **training needs** (phase 1, `ai-diplomacy-trade.md` 1.6), not of
the training step: after the essential workers (1.6 step 1) and the "first queue entry has
priority 0" stop (step 2), and before the want loop (step 3). When the nation has a naval
planner, for t = 65, 66, 67 in this order (confirmed in the disassembly `00474338..00474527`):

1. Walk the town's units of type t in list order and register each one that has no group
   (`00471fd0`):
   - first while build[t] > 0;
   - then while claim[t] > 0.

   Every registration lowers one of the two counts.
   Registration does not test where the ship is or what it does; the town's unit list of that
   type is walked once, continuing where the first loop stopped.
2. If build[t] is still > 0: the code first asks the build-menu check `0045faf0` with the ship
   type. A result of 0 would queue a **shipyard** instead (when the town has no shipyard and
   none queued). That check never returns 0 (−1, 1, 2, 3 or 4), so this branch is **dead**, and
   its call with type 63 never runs *(C by reading)*. Otherwise a flag "naval" is set and type t
   is put into the planner's training queue with **priority 0** (front of the queue), unless it
   is already there.
3. If the flag is set (some build[t] > 0), the training needs end here: no want loop this phase.

Then, in the want loop (1.6 step 3), Gold adds the planner's **claim[t]** to every type's want
(confirmed at `0047457d..004745bf`: want = operators + C + B + A + claim − queued − existing).
Since claim[67] starts at 1, **every computer town wants one transport ship** (priority 4) until
the planner has taken one over; the first one trained anywhere in the nation is registered (claim
falls to 0), later ones stay ungrouped. The training step (1.7) is unchanged: a ship order needs
a free porter and goes to the first shipyard whose order check passes; without a shipyard the
request is dropped and asked again in the next phase 1.

So: one transport per nation comes from the initial claim, more from build[67] = u/2 when more
than 3 requests are unserved, and trade transports from A[67] (8.6). Warships come from the gang
target A[65] (8.2) through the normal training. Every free transport ship beyond the planner's
claims stays ungrouped and available for trade.

### 8.6 Trade and research (C)

- **Markets job** (`00477060` = AN `0046dd50`, every 150 ticks): it runs twice, once for
  (market 48, merchant 28) and once for **(harbour 62, transport 67)**, for each one the town has
  active:
  - settings written as in the base game;
  - partner list (5.7; markets: same island; harbours: any);
  - A[unit] = number of partners;
  - free or gang-51 units of that type get routes to the first partner.

  The naval planner takes over ungrouped type-67 ships only up to its claim and build counts
  (8.5). The rest stay free and are given trade routes here. Which job reaches a newly trained
  ship first depends on the order of the two jobs in the scheduler *(uncertain in detail)*.
- **Research**: unchanged (`00478f00` = AN `0046f490`). The cursor reaches entries 30..32 last.

---

## 9. Other add-on rules

### 9.1 Status and messages

- No new advisor lines. `Mentor.tdb` is identical to the base file.
- New status strings: 1.5.

### 9.2 Mission goals 17..20 (C, function table 0x4BD198, AN 0x4AFFE8 with 16 entries)

Parameters p1, p2 and p3 are as in `mdb.md`. The file side belongs to `docs/formats/addon.md`.

| type | condition | function |
|---|---|---|
| 17 | object with map id p1 exists and its wrapped distance (max + min/2) to the point (x = p2 & 0xFFFF, y = p2 >> 16) is ≤ p3 | `00478b60` |
| 18 | object id p1 is gone, dead, or not of type p2 (true = "destroyed") | `00478d50` |
| 19 | sum over the player's living towns **whose town position is on island p1** of the count of objects of type p2 ≥ p3 | `00478db0` |
| 20 | stock of good p1 in city p3 ≤ p2 (inverse of type 1) | `00478e90` |

### 9.3 Diplomacy (C)

- **Diplomat errand** (constructor `004821c0` = AN `00478650`, run `004825c0` = AN `00478910`;
  re-derived at instruction level 2026-10-17, correcting an earlier reading): the target is chosen
  when the errand is created, among the target player's towns' first embassies that are active
  (`ai-diplomacy-trade.md` 3.4 step 2), and only those on the island of the **sending embassy**
  (island byte at the home embassy's position, `00482239`..`0048229f`; candidates compared at
  `00482363`). Distance is still measured from the diplomat.
  - A candidate on that island: he walks there and the offer is decided after he has entered,
    as in the base game.
  - Candidates exist, but none on that island (`004824c9`..`00482507`): the errand's child is a
    go-to back into his own embassy and its state is set to 1. The run (`004825db`: state 1 is
    tested before the child runs) then decides the offer on the errand's **first run**, i.e. as
    soon as he is out of his door, with the normal acceptance rule, messages and relation
    broadcast (`0048260c`..`004827b9`), and he walks straight back in. **Cross-sea diplomacy
    therefore works**: the diplomat steps out for a moment, goes back in, and the offer has been
    delivered and answered. No ship carries him; neither the errand nor the naval planner (8)
    moves diplomats.
  - No candidate at all: the errand has no child and ends on its first run (base).
  - Contact (`00465d00` = AN `0045fa40`, `ai-diplomacy-trade.md` 3.3) has no island test: an
    embassy becoming active anywhere gives first contact (war) with every player that has an
    active embassy anywhere. Both players need an active embassy: the sender to send, the target
    to be a candidate.
  - Computer offers (`0046fd60` = AN `004687a0`, 3.5) are unchanged, with no island test: the AI's
    diplomat crosses water the same way (out of his door and back in). Acceptance flags sit at
    player +0x295 + race (peace) and +0x298 + race (ceasefire) in the Gold exe (AN +0x261/+0x264).
- **Peace side effects** (`0045e100`): entering or leaving peace sends the building-visibility
  message for markets **and harbours** (fog 3.3).

### 9.4 Difficulty and multiplayer saving

No simulation code for a new difficulty level was found. The AI profiles (`0046f840`,
`0046fcb0`), the strategies and the economy constants are the same as in `AN.exe`. The difficulty
is presumably a property of the add-on missions (data), see `docs/formats/addon.md`. Saving in
multiplayer is a network and menu feature (string `LOCALSAVEGAME`, new case in the network
message handler `0045a8d0`). It changes no rule.

---

## 10. Base behaviour changed in dvge.exe

Rows marked **all modes** also change a base-game map played with the Gold executable.

### 10.1 Data-driven tests (equivalent on shipped data)

| change | evidence | effect |
|---|---|---|
| store capacity added by flag 0x10 instead of "store flag and +0x120 ≠ 0" | `00465d00`, `004661f0` | none (same buildings) |
| trader test by flag 0x40 instead of type 28 | `00487040`, `00487190`, `00457d60`, `00427000` | transport ships become traders |
| worn paths by flag 0x80 instead of a type list | `0044c7d0` | **all modes**: Pimmon and Sajiki traders no longer wear paths; the roll is drawn only for flagged units (`units-and-jobs.md` 4.5) |
| market-like page and peace vision by flag 0x20 | `00427000`, `0043a750` | harbour added |
| per-type arrays sized 68 instead of 62 (town lists, training counts, AI arrays, player lists) | `0045ec60`, `00462e10`, `004740c0` | town fields after +0xB4 move by 0x60 (town stock settings +0x4EC → +0x54C, free porters +0x4D4 → +0x534, dispatcher counters +0x5C4 → +0x624); nation fields move by 0x30..0x34 (AI think job +0x228 → +0x258, new naval planner +0x25C, AI flag +0x260 → +0x294, towns +0x230 → +0x264) |

### 10.2 Cell flag 0x10000 (all modes, C by reading)

Gold sets flag 0x10000 on every cell whose tile is in **class 0** (2.2). Two base routines test
it in their masks:

- the **respawn manager** (`0048d920`, mask 0x1003F);
- the free-play **cluster placer** (`0048ffc0` = AN `00484ba0`).

In add-on mode class 0 is beach and worn path, so nothing respawns or is scattered on beaches:
the respawn spiral skips such cells and goes on to the next one (`units-and-jobs.md` 7.5.1).
In **base mode class 0 is meadow (wiese)**, so under `dvge.exe` respawned trees and animals and
free-play clusters avoid meadow cells. `AN.exe` never sets the bit. *(The visible effect was not
checked in game.)*

### 10.3 Add-on-only changes

| change | evidence |
|---|---|
| mountain threshold 290 instead of 250; high band 250 instead of 200. The mine needs height > 290; flag 0x100 and the worn-path limit move with it | `0044ef50`, `0044c020`, `0044c7d0` |
| island tests in follow-path and go-to | 2.5 |
| merchants trade only with towns on their island | 5.7 |
| diplomats walk only on their embassy's island; offers across water are decided at once | 9.3 |

### 10.4 Fixes and other changes (all modes)

| change | evidence |
|---|---|
| **AI economy job** (phases 0..2) skipped while the town capacity is 0, which avoids the divisions by capacity in `ai-diplomacy-trade.md` 1.8 / 4.6 | `004783c0` (AN `0046ecd0`) |
| class-5 (training) buildings refuse ships; builders and other entrants unchanged | `00466cd0` |
| shipyard goods top-up | 3.5 |
| harbour and shipyard: no foundation, no rubble, builders stay put | 3.2, 3.6 |
| priests cannot heal ships | 4.1 |
| fish die without the carcass sprite and death cry (types ≥ 41) | `00469fb0` |
| unit death of a group-61 unit informs the naval planner | `00468790` |

No other function cited in `docs/game/*.md` differs between the two executables except for the
shifted offsets of 10.1. Every cited function was compared after normalising names, map offsets
and message-header offsets (the message header lost 5 bytes, so message fields +0x0E/+0x12/+0x16
became +0x09/+0x0D/+0x11). Combat, economy (tax, happiness, consumption, decay), fog,
construction, training, production, harvest and the town dispatcher are the same.

---

## 11. Open points

1. The add-on mode switch and which missions set it; whether a base campaign played from the Gold
   menus runs in add-on mode (`docs/formats/addon.md`).
2. The free-play world populate for add-on maps (`00491080`; it replaces AN `00485770` and
   contains the messages "Zu wenige Punkte gefunden" and "Sowas. Riesen-Insel und kein
   Startpunkt."): start points on islands, fish and palm placement. Not traced here.
3. The follow-path flag +0x44 used for fishing paths: does arrival next to a blocked fish count
   as success? *(I: yes)*.
4. The exact float handling in the raw-material branch of the shipyard top-up (3.5), which never
   runs on shipped data.
5. In-game confirmation of the quirks: a fish caught twice (6.2), the harbour-less harvest loop
   (6.3), boarding foreign ships (5.2), meadow without respawn in base mode (10.2).
6. The exact order in which the naval planner and the markets job first see a newly trained
   AI transport ship (8.6).
7. Ties for the largest ocean in the island generator (Appendix A.4), which depend on the label
   numbering.

---

## 12. Implementation notes (our TypeScript engine)

Terms as in `src/engine` (World, Entity, Logistics, Combat, Trade, Scheduler, path).

**Map (World / terrain):**
- Add a mode flag `addon` to the world setup.
- Generate add-on terrain with Appendix A (a separate generator; the base `terrain-gen.md` path
  stays as it is).
- Keep per-cell `cls`; derive the flags (2.2) from `cls`, not from tile indices: land = `cls <
  N − 1` (add-on) or `cls < N` (base), coastal = `cls ≥ N`, beach = `cls === 0`.
- Store the thresholds per world.
- Add `island: Uint8Array` (0 = water). Compute it after map objects and foundations exist,
  exactly as in A.4, including the byte wrap. It is static: rebuild it on load rather than
  saving it, but include it in `hash()`.

**Passability:**
- Today `blocked` is one byte per cell. Make passability a function of a **mask**: keep the
  per-cell flag word (water, coastal, building, nature, unit, special) and test
  `(flags & unit.mask) === 0`.
- Give every Entity `blockMask` and `pathMask`, set at spawn and on retype from the class
  (2.3).
- `findPath` must take the mask, or a precomputed grid per mask class: land 0x3C or ship
  0xA01C.
- Add the island checks of 2.5 to the follow-path and go-to jobs. They are cheap and decide
  outcomes.

**Entities:**
- Ships are `Kind.Unit` with class 14.
- Add `passengers: number[]` (ordered, as the occupant list) and `capacity` from record +0xDC.
- `inside` may now hold a **unit** id (a ship) as well as a building id. Every rule that says
  "inside a building" must accept both: untargetable, not free, no vision.
- When a ship dies, kill its passengers in list order before the ship's own death bookkeeping.
- Fish are `Kind.Nature` with class 15, `alive = true` (living), no growth job.

**Jobs (Scheduler):**
- New kinds 0x3A (fishing), 0x3B (sail to coast), 0x3D (naval planner, owner = race), 0x3E
  (wait: always returns 500).
- Keep their fields as plain numbers in `data[]`, in the order listed in 5.4 / 6.2 / 8.4, so
  that saves and hashes stay stable.
- The leave job gets the ship branch (5.3).
- The go-to job gets the transport-ship branch (5.2), and the enter job gets the unit-container
  door queue with the distance < 4 rule and the computer-owner exception.

**Logistics:**
- Harbours are stores for drops (town stock, clamped) but never "nearest store" candidates.
- Docking (5.8) must not move the ship or remove it from its cell.
- The fishing job's delivery is a normal transport with no source and the harbour as
  destination.
- Food drops go through the same town-add path, so the round's food counter grows.

**Trade:**
- Generalise `MERCHANT` / `MARKET` to "trader flag 0x40" and "terminal type = merchant ? 48 :
  62".
- Add the island filter for merchants' partners.
- `CARRY_MAX` stays 5 for ships.

**Combat:** no change beyond masks. The firing-position search and the melee adjacency test must
use the attacker's path mask, so that land melee units give up on ships after 5 searches, as in
the original.

**Placement:** extend the placement mask table (3.1) and add the land count L and flag 0x4000 to
the area test. Skip the foundation for 62 and 63, and skip rubble at their destruction.

**AI (ai.ts / ai-town.ts):** add the targets (8.1), the priority entries, the gangs (8.2), the
fishing order (8.3), the naval planner (8.4), the training hook (8.5) and the harbour/transport
pass of the markets job (8.6).

**Randomness:** the add-on adds rand() draws at:
- fishing wait (50 + r % 50);
- fishing fallback cells (2 per try);
- AI fishing cells (2 per try);
- warship wander delay;
- the island generator (Appendix A).

Draw them from the world stream in the order given. Within one job run the order is as listed in
each section.

**Fidelity switches** (default = original behaviour, documented in our own docs):
- shipyard top-up only in the simulation (3.5);
- fish caught twice (6.2);
- ordering a fishing boat onto a fish (6.3: original harvest loop, or fixed to the fishing job);
- boarding foreign ships (5.2);
- class-0 respawn avoidance in base mode (10.2).

---

## Appendix A: add-on island terrain (C, `0044e6b0` → `0044d250`, `0044e440`, `0044e4c0`)

Inputs: seed and size_bits, as in `terrain-gen.md`. The same C `rand()` is seeded with the seed
first (`0044e6b0`). n = 1 << size_bits. Constants: SEA = 120, H_mount = 290, H_high = 250.
Steps A.1..A.5 replace the base steps 1..3. Step 4 (tile choice) and step 5 (light) of
`terrain-gen.md` follow with the add-on class table (2.1).

### A.1 Clear

Every cell: height 0, class 0.

### A.2 Fractal heights (`0044d8f0`)

1. **Coarse points**: for x = 0, 32, ..., n − 32 (**outer**) and y = 0, 32, ..., n − 32
   (**inner**):
   - h = rand() & 0x1FFF; if h < 0x1000 then h = 0x1000;
   - track min (starting at 0x2000) and max (starting at 0).
2. **Normalise** the coarse points:
   - scale = float32(384.0 / (max − min));
   - h := trunc((h − min) × scale).

   The product of an int and a float32 is exact in a double, so `Math.trunc((h - min) *
   Math.fround(384 / (max - min)))` reproduces it. If max = min the original divides by zero
   *(never seen)*.
3. **Levels** s = 32, 16, 8, 4, 2, 1, with a double amplitude A starting at 128.0:
   - r = trunc(A + 0.5). If r = 0 or s < 2, r = 1. This gives r = 128, 60, 28, 13, 6, 1.
   - noise(avg) = clamp(avg + rand() % r − (r >> 1), 0, 0x7FFF), where avg = (sum of four
     heights) >> 2. rand() is drawn even when r = 1.
   - **Diamond pass**: for y = 0, s, ... < n (outer), x = 0, s, ... < n (inner):
     h(x + s/2, y + s/2) = noise of h(x, y), h(x + s, y), h(x, y + s), h(x + s, y + s).
   - **Square pass**: for y = 0, s, ... (outer), x = 0, s, ... (inner), two points in this
     order:
     1. h(x + s/2, y) = noise of h(x, y), h(x + s, y), h(x + s/2, y − s/2), h(x + s/2, y + s/2);
     2. h(x, y + s/2) = noise of h(x, y), h(x, y + s), h(x − s/2, y + s/2), h(x + s/2, y + s/2).
   - A := A × 2^−1.1 (double).

   All coordinates wrap. At s = 1, s/2 = 0: the passes overwrite h(x, y) in place with local
   averages, three draws per cell (one diamond, two square). That is a smoothing pass, and it
   must be kept literally.

### A.3 Remove inland water (`0044cea0`, `00490d80`, `004513e0`, `0044d1a0`)

1. Label the 4-connected components of **water** (height ≤ SEA) on the torus with the run
   labelling of A.4.
2. Size of a label = the sum of its run lengths. Sort the pairs (size, label) in **descending**
   order (size first, then label). The first one is the ocean.
3. Walk the run list in order; it is in scan order, rows from y = 0 and runs left to right. For
   every run whose label is not the ocean's, for each cell left to right:
   - height = SEA + 1 + rand() % 4;
   - class = 4 + (label & 3).

### A.4 Run labelling (`0044cea0`)

The predicate P is "water" in A.3 and "land, height > SEA" for the island ids (2.4).

1. Scan rows y = 0 .. n − 1. In each row, find the maximal runs [start, end) of cells with P.
2. For a new run, look at the runs of the previous row (y − 1), in list order:
   - skip those with end ≤ start;
   - if the next one has start < this run's end, the run **joins** that run's label L. Every
     further previous-row run with start < this run's end has its label replaced, everywhere in
     the list, by L;
   - otherwise the run gets a **new label**: counter + 1, starting at 1.

   Append the run to the list.
3. **Wrap passes**, in list order:
   - a run with start = 0 whose row's last run ends at n: replace the label of the start-0 run,
     everywhere, by the last run's label;
   - every run of row n − 1: for each run of row 0 that overlaps it, in list order, replace the
     row-(n − 1) run's current label, everywhere, by that row-0 run's label.
4. The result is the run list with final labels; the count is the counter + 1.

### A.5 Classify (`0044d250`, last loop)

For every cell in index order (y outer, x inner) whose class is still 0:

- **Land** (height > SEA):
  - all 8 neighbours > SEA: class 2 if height > H_mount, 5 if height > H_high, else 4;
  - otherwise class 0 (beach).
- **Water** (height ≤ SEA):
  - any of the 8 neighbours > SEA: class 10 (coastal water);
  - otherwise class 9 (open sea).

  The original encodes this as a temporary height of SEA − 32 or SEA − 33. The height becomes
  SEA in both cases.

Filled lakes (class 4..7) are not reclassified. They have no beach.

### A.6 Rest of the generator

- **No hills and no lakes**: the base hill stamps and `0044e440` are skipped when the map's
  add-on flag is set.
- **Tiles** (`0044e4c0`): as `terrain-gen.md` step 4 (y outer, x inner, rand() & 0xFF, weighted
  table of the class's tile set), with the add-on class table.
- **Light**: as in the base game.
- After the map file and the objects are loaded, the island ids are labelled (2.4).

---

## Appendix B: function map (Gold → AN.exe)

**New in Gold:**

| area | functions |
|---|---|
| jobs | 0x3A `00482f70`, `00482fe0`, `004830b0`, `004834e0`, `00482f30`, `004836e0`; 0x3B `0048b830`, `0048b8c0`, `0044cb40`; 0x3D `00472270`, `00472b30`, `00472630`, `00471f40`, `00472940`, `00471fd0`, `00472160`, `00472f90`; 0x3E `00488760`, `00488790` |
| ship container | `0046b5c0` (may enter); `00484a30` (unloading cell test) |
| islands | `00485cc0`, `00485cf0`, `004922a0`, table 0x4BCD30 |
| terrain | `0044d8f0`, `0044cea0`, `0044d1a0`, `0044d8d0`, `00490d80`, `004513e0` |
| goals | `00478b60`, `00478d50`, `00478db0`, `00478e90` |

**Changed (Gold = AN):**

| area | functions |
|---|---|
| job factory | `004031c0` = `00402dc0` |
| cell flags | `0044c020` = `00447f20`; `004565a0` = `00451510` |
| map constructor | `0044ef50` |
| tile loader | `00492960` = `00486050` |
| world setup | `004922c0` = `00485a30` |
| placement | `004571e0` = `00451780`; `00465300` = `0045f0a0`; `0044bdb0` = `00447cd0` |
| build menu | `0045faf0` = `00459b60` |
| buildings | activation `00465d00` = `0045fa40`; deactivation `004661f0` = `0045ff30`; die `00465840` = `0045f5a0`; builder `00481710` = `00477ce0` |
| entering and leaving | may enter `00466cd0` = `00460a10`; entered `004671b0` = `00460ed0`; building eject `004676d0` = `004613f0`; leave job `00484e00` = `0047a530` |
| movement | go-to `00485750` = `0047ac90`; follow path `0048b230` = `00480410` |
| unit setup | unit object `00467d70` = `00461a40`; retype `0046ad30` = `00464840` |
| combat rules | may act on `0046b9a0` = `00465460`; harvest predicate `00469a20` = `004635f0` |
| nature | constructor `00469d50` = `004638d0`; die `00469fb0` = `00463b10`; depletion `00469b20` = `004636b0` |
| commands | orders `004567a0` = `00450bb0`; move `00456d90` = `00451170`; route `00457d60` = `004522d0` |
| trade | job `00487b90` = `0047ce00`; partners `00463ef0` = `0045de40`; partner list `0045cc30` = `00456fc0` |
| goods | transport run `00487040` = `0047c2b0`; goods handler `00487190` = `0047c400` |
| diplomacy | diplomat `004821c0` = `00478650`; relation effects `0045e100` = `004583f0` |
| AI | targets `00474680` = `0046b490`; training `004740c0` = `0046b0f0`; gangs `00478180` = `0046ebc0`; gang fill `00477f90` = `0046ea30`; gathering `00477bf0` / `00477610` = `0046e6b0` / `0046e260`; markets `00477060` = `0046dd50`; economy job `004783c0` = `0046ecd0`; army `0046c050` = `00465ad0`; founding `0046f340` = `00467f80`; strategy `0046cbd0` = `00466020` |
| other | unit death `00468790` = `00462430`; player constructor `00462e10` = `0045cdf0`; side panel `0041b5d0` = `00417fe0`, `00427000`; default page `004636e0` = `0045d640`; unit info `0045b9a0` = `00455d50` |

**Unchanged** (only offsets moved), among others: scheduler, dispatcher `00479480`, store choice
`00461460`, free porter `00461030`, planner `00485dc0`, step `00468520`, attack, strike, impact
`0047c590` / `0048c720` / `0048ced0`, range `0047a420` / `0047ad40`, training `0047f810` /
`0047fab0`, production `0047fe40`, harvest `004804a0`, respawn `0048d920`, AI profiles and
strategies.

Method used: every function of both executables (plus all virtual methods and callback labels,
created the same way as in `units-and-jobs.md` 13) was decompiled. Each Gold function was matched
to the AN function with the highest Jaccard similarity of its normalised token 5-grams. Low
scorers were read by hand, and matched pairs were compared line by line after normalisation.
