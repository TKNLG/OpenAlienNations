# Gold Edition and mission pack ("AO"): files, loading, maps, menus

Everything the Gold Edition executable `dvge.exe` does differently from the GOG `AN.exe` in the
areas of **file formats, loading, terrain, free-play world creation and the front end**. The
rules of the new objects (ships, harbour, shipyard, fishing, transport, sea combat) belong to the
gameplay spec [`docs/game/addon.md`](../game/addon.md); this page only gives their data.

The executable and data are the Gold Edition at patch level 3.03 or newer (see
[editions.md](../game/editions.md)). "AO" is the developers' own tag for the mission pack (file
names `*AO.mdb`, `<Race><n>AO.dvm`, `AO.idb`, sprite names `...AO`).

Legend: **C** = read in `dvge.exe` code (addresses are `dvge.exe` unless marked AN), **D** =
confirmed by the shipped data only, **I** = inferred. Items marked *(uncertain)* are not settled.

Helper scripts used for the tables live outside the repository; the tables below are their output.

---

## 1. The AO switch

### 1.1 One flag in the mission record (C)

`dvge.exe` has **no global add-on mode**. Every mission record (`.mdb`, 3864 bytes, see
[mdb.md](mdb.md)) carries the switch at **+0xA50**:

- `+0xA50 >= 1`: **AO mission**. All shipped `*AO.mdb` records hold 1.
- `+0xA50 < 1`: base mission. GOG data holds -1 (campaigns) or 0 (free play); the Gold
  `Amazons.mdb` holds 0 (D, the only difference of that file, section 12.1).

The old reading "alternative briefing layout" (mdb.md) was one of its effects. Every AO check in
the code tests this field of the current mission record, so one executable runs base and AO
missions side by side.

### 1.2 What the flag changes in loading (C)

| item | base mission | AO mission | where |
|---|---|---|---|
| object rules | `dv.odb` | `dv.odb`, then `Addon.odb` into the same table | `0048f650` |
| object table width (types per group) | 62 (0..61) | 68 (0..67) | `0048f650` (global set to 0x3E / 0x44) |
| world sprites | `dv.gd` | `dv.gd` and `Addon.gd` (second archive) | `00492960` |
| object -> sprite descriptions | `dv.od` | `dv.od`, then `Addon.od` into the same table | `00492960` |
| HUD sprites | `<race>\interface.gd`, `interface.od` | same files (the Gold copies contain the AO icons in both modes) | `00492960` |
| weapons | `dv.wdb` (records 0..20) | `dv.wdb`, then `addon.wdb` (records 21..27) into the same table | `00492960`, loader `0048edd0` |
| strings | `DV.tdb` + `Addon.tdb` | same (always loaded at start-up) | `00493810` |
| inventions | `data\<race>\dv.idb` (30) | `data\<race>\ao.idb` (33) | `00462e10`, `004324f0` |
| terrain class table | 11 land classes + water (section 8.2) | 10 land classes + water | `00492960`, `0048f040` |
| height thresholds | 250 / 200 / 130 | 290 / 250 / 130, sea level 120 | map constructor `0044ef50` |
| terrain generator (seed -1) | hills + lakes | island generator (section 9) | `0044d250`, `0044e440` |
| free-play populator | base populator | island populator (section 10) | `00491080`, `0048ffc0` |
| island-id grid | none | one byte per cell (section 8.5) | `0044ef50`, `004922c0` |
| loading screen | `LOADING` | `LOADING_B` | `0048f650` |
| briefing art | `BRIEFINGSCREEN`, `AMABRIEF` ... | `BRIEFINGSCREENAO`, `AMABRIEFAO` ... | `0042b790` |
| goals | types 1..16 | types 1..20 (17..20 are new but not AO-gated) | `00478530` |
| savegame version word | 0x6A | 0x0800006A | `0040f3a0` |

Files are opened case-insensitively through the data search path (`Addon.odb` on disk is opened
as `addon.odb`). Missing add-on files are not checked for: a Gold install always has them.

### 1.3 Mission files and game modes (C, table at `0x4BC8CC`)

| mode index | file | used for |
|---|---|---|
| 0, 1, 2 | `amazons.mdb`, `pimmons.mdb`, `sajikis.mdb` | base campaigns |
| 3 | `tutorials.mdb` | tutorials |
| 4 | `infinite.mdb` | base free play and multiplayer |
| 5, 6, 7 | `amazonsao.mdb`, `pimmonsao.mdb`, `sajikisao.mdb` | add-on campaigns |
| 8 | (none, null entry) | no add-on tutorials |
| 9 | `infiniteao.mdb` | add-on free play and add-on multiplayer |

The game keeps the **mode 0..4** as its current mode and two separate flags (C, `0042a8c0`):

- **AO campaign flag** (`0x4BC8C8`): set by the "Addon Kampagnen" button; file index = mode + 5.
- **AO free-play flag** (`0x4BC8C4`): the "Addon:" toggle of the world-parameter screen; in mode
  4 the file index becomes 9.

Mode 3 (tutorials) is never redirected. Savegames store `mode + 5` for AO missions; on load a
stored mode above 4 sets **both** flags and subtracts 5 (C, `0040f720`, `0040f3a0`).

---

## 2. Object rules: `Addon.odb` (D for values, C for loading)

`Addon.odb` is a `dv.odb`-format file ([odb.md](odb.md)): 31 records of 396 bytes. The loader
(`00411850`) is the same one; it is simply run a second time on the same table, which keeps the
dv.odb records and adds the new ones by **(group, type)**. A record whose type is not below the
table width is dropped, which is why the width rises to 68 in AO missions. The new records also
join the per-group unit / building / animal lists (kind 0 / 1 / kind 2 with class 7), so the new
animals Gecko and Krabbe become free-play animals (section 10.3).

### 2.1 New type numbers

| group | new types |
|---|---|
| 0, 1, 2 (each race) | 62 Hafen (harbour, building), 63 Werft (shipyard, building), 64..67 ships (units) |
| 6 (nature) | 39 Gecko, 40 Krabbe (animals), 41..45 Fisch (fish), 46..49 Palme (palm), 50 Aloe, 51 Venus |

Group 6 type 38 (Schutt, rubble) keeps its number; the new nature types start after it.

### 2.2 Buildings (kind 1)

| race | type | name | size x*y | door | HP | upkeep +0xD4 | build cost | flags +0xB8 | class +0xC0 | radius +0xB0 | invention +0xE4 | build menu +0xE8 | list slot +0x124 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| all | 62 | Hafen | 3x3 | 0,0 | 1000 | 15 | Am 12 wood 4 stone; Pi 4 wood 12 stone; Sa 6 wood 6 stone | 0x21 (store + 0x20) | 4 (goods building) | 6 | 31 | 40 (town hall menu) | 26 |
| Am, Sa | 63 | Werft | 3x3 | 0,0 | 1200 | 10 | Am 15 wood 6 stone; Sa 11 wood 10 stone | 0 | 5 (training building) | 0 | 30 | 40 | 25 |
| Pi | 63 | Werft | **3x2** (+0x0C = 2) | 0,0 | 1200 | 10 | 6 wood 15 stone | 0 | 5 | 0 | 30 | 40 | 25 |

No operator (+0xD8 = -1), no residents, no storage (+0x120 = 0), no product, no need entry.
Door 0,0 means the entrance is the building's own position cell (odb.md 2.2).

### 2.3 Ships (kind 0), all trained at the shipyard (+0xE8 = 63)

| race | type | name | HP | sight +0xB0 | price +0xD4 | goods | invention | weapon +0x144 | step times +0xC4..0xD0 | flags +0xB8 | +0xDC | list slot |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Am | 64 | Fischerboot | 100 | 8 | 150 | 3 wood | 31 | 27 Angel | 5/5/5/5 | 0 | 0 | 28 |
| Am | 65 | Patrolienboot | 250 | 8 | 500 | 4 wood, 2 weapons | 15 | 25 | 3/3/3/3 | 0 | 0 | 30 |
| Am | 66 | Kreuzer | 500 | 12 | 700 | 7 wood, 3 weapons | 32 | 26 | 6/6/6/6 | 0 | 0 | 31 |
| Am | 67 | Transportschiff | 350 | 12 | 300 | 5 wood | 30 | -1 | 5/5/5/5 | 0x40 | 5 | 29 |
| Pi | 64 | Fischerboot | 100 | 8 | 150 | 3 wood | 31 | 27 | 5/5/5/5 | 0 | 0 | 28 |
| Pi | 65 | Zerstörer | 300 | 10 | 500 | 3 wood, 3 weapons | 15 | 21 | 4/4/4/4 | 0 | 0 | 30 |
| Pi | 66 | Schlachtschiff | 600 | 12 | 800 | 5 wood, 4 weapons | 32 | 22 | 8/8/8/8 | 0 | 0 | 31 |
| Pi | 67 | Transportschiff | 350 | 12 | 300 | 5 wood | 30 | -1 | 5/5/5/5 | 0x40 | 5 | 29 |
| Sa | 64 | Fischer | 100 | 8 | 250 | - | 31 | 27 | 5/5/5/5 | 0 | 0 | 28 |
| Sa | 65 | Panzerlanguste | 450 | 8 | 650 | 3 weapons | 15 | 23 Zangen | 3/3/3/3 | 0 | 0 | 30 |
| Sa | 66 | Seepyro | 450 | 10 | 1000 | 5 weapons | 32 | 24 Feuerball | 7/7/7/7 | 0 | 0 | 31 |
| Sa | 67 | Transporter | 350 | 12 | 300 | 5 wood | 30 | -1 | 5/5/5/5 | 0x40 | 5 | 29 |

All ships: footprint 1x1, behaviour class **14** (new; ships), operator -1, product -1.
Warships (65, 66) carry eight launch points at +0x54..+0x90 (projectile origins per facing,
odb.md section 2). The transports' +0xDC = 5 is read as their passenger capacity *(I; the
gameplay spec decides)*. The goods are delivered to the shipyard like other training goods.

### 2.4 Nature (group 6, kind 2)

| type | name | class +0xC0 | yields +0x11C / +0x120 | HP | step times | other |
|---|---|---|---|---|---|---|
| 39 | Gecko | 7 (animal) | 12 food | 10 | 6/7/8/9 | |
| 40 | Krabbe | 7 (animal) | 12 food | 10 | 6/7/8/9 | |
| 41..43 | Fisch | **15** (new: fish) | 2 food | 10 | 6/7/8/9 | |
| 44, 45 | Fisch | 15 | 3 food | 10 | 6/7/8/9 | +0x134 = 4 *(meaning unknown)* |
| 46, 48 | Palme | 8 (tree) | 6 wood | - | (6/7/8/9) | sound 59 in the work row (+0x134 = 2) |
| 47, 49 | Palme | 8 | 4 wood | - | | same |
| 50 | Aloe | -1 (decoration) | - | - | | |
| 51 | Venus | -1 (decoration) | - | - | | |

Palms are felled like trees (class 8); fish are a new resource class for the fishing boats.

### 2.5 New and changed flag bits (+0xB8) in the Gold data (C for readers)

| bit | on | meaning | evidence |
|---|---|---|---|
| 0x10 (building) | town hall, warehouse (Gold `dv.odb`) | **adds storage capacity**: on completion +0x120 is added to the town's per-good capacity, removed on destruction. In AN.exe this was done by bit 0x1; the Gold data sets both bits, so the result is the same | `00465d00`, `004661f0` |
| 0x20 (building) | market (Gold `dv.odb`), harbour | **trading post**: the building panel offers sale/purchase entries; foreign units may use it when the races are at peace *(I for the exact rule)* | `00427000`, `0043a750` |
| 0x80 (unit) | path-wearing unit types | wears paths, see [units-and-jobs.md](../game/units-and-jobs.md) 4.5 | `0044c7d0` |
| 0x40 (unit) | transport ships; Pimmon and Sajiki traders (28) | carrier: the unit panel shows a passenger / cargo list ("An Bord") *(I for the traders)* | `00427000` |

The Amazon trader has 0xC0 (both). Behaviour classes 14 (ship) and 15 (fish) are new; their
rules are in the gameplay spec.

---

## 3. Sprites: `Addon.gd`, `Addon.od` and the menu/HUD archives

### 3.1 `Addon.gd` and `Addon.od` (D)

Same container formats as `dv.gd` / `dv.OD` ([gd.md](gd.md), [od-odb.md](od-odb.md)).
`Addon.gd`: 289 image entries; `Addon.od`: 289 names, 49 object records. Every sprite name used
by `Addon.od` exists in `Addon.gd`; none is shared with `dv.gd`.

| group (OD id >> 16) | objects | sprite names |
|---|---|---|
| 0 / 1 / 2 | 62, 63 (kind 1: `BU0` 10-frame construction, `MS0`), 64..67 (kind 0) | `AZ\` / `PI\` / `SA\` + `BU\HAFEN`, `BU\WERFT`, `VE\FISCHER`, `VE\KRIEGSSCHIFF1` (65), `VE\KRIEGSSCHIFF2` (66), `VE\TRANSPORTSCHIFF` (67) |
| 3 / 4 / 5 | small icons of 62..67 (kind 2) | `BIAZ\MI\...`, `BIPI\MI\...`, `BISA\MI\...` |
| 6 | 39..51 (kind 0) | `RS\VE\TIER6` (Gecko), `TIER7` (Krabbe), `FISH1..5`, `PALME1..4`, `ALOE`, `VENUS` |

Animation slots used (slot = action * 8 + direction, od-odb.md): fishing boats `MG` (move, slots
0..7) and `WO` (work, 16..23); warships `MG` and `ST` (8..15); transports `MG` and `CA` (32..39);
fish `MS0` and `ID0`; palms `MS0`, `ST0`, `WO0`, `CA0` like trees; gecko/crab `MS0..7`, `WO0..7`,
`ID3`, `CA0`. Ship sprites have 8 frames (transport 10). The Amazon and Sajiki harbours have a
third `HAFEN` entry that `Addon.od` does not reference.

**Name resolution (C, `00440330`, `00440610`):** the OD loader reads each object's descriptor
and stores the sprite **name strings**; the drawing code then looks the names up among the loaded
sprite archives. A rebuild can simply load `Addon.gd` next to `dv.gd` and resolve names across
both.

### 3.2 `mainmenu.gd` (D)

The Gold `mainmenu.gd` holds the 27 GOG entries unchanged (pixel-identical) plus eight new ones;
the unused `EINFUEHRUNG` is gone.

| entry | size | used for (C) |
|---|---|---|
| `RASSENWAHLAO` | 800 x 600 | race selection background for add-on campaigns and add-on free play |
| `MISSIONSAUSWAHL` | 800 x 600 | mission list background for add-on campaigns |
| `BRIEFINGSCREENAO` | 800 x 600 | briefing background, AO missions |
| `AMABRIEFAO`, `PIMBRIEFAO`, `SABRIEFAO` | 100 x 100 | briefing portraits, AO missions |
| `SCHIEBERINGAO` | 60 x 70 | briefing scroll ring, AO missions |
| `LOADING_B` | 800 x 600 | loading screen, AO missions |

### 3.3 Race `interface.gd` / `interface.OD` (D)

Gold adds four HUD sprites: `RS\MI\TIER6\MS0`, `RS\MI\TIER7\MS0`, `RS\MI\PALME1\MS0` (45 x 45
selection icons of gecko, crab and palm) and `AUSSTEIGEN` (30 x 30, the "unload" button; its name
is in `dvge.exe`). `interface.OD` gains the three icon objects (group 6 types 39, 40, 46).
About 20 further entries per race differ in pixels from the GOG copies (sliders, check boxes,
message boxes, `INTERFACE800`, several icons); sizes are unchanged *(art revision; which copy is
newer is not known)*. The GOG copies contain four entries Gold lacks (`SCHAU`, `LACH`, `HEUL`,
`KEINFORSCH`); neither executable references them.

---

## 4. Weapons: `addon.wdb` (D)

Seven records in the `dv.wdb` format ([idb-wdb.md](idb-wdb.md)), indices 21..27, loaded into the
same table after `dv.wdb` (the loader stores each record at its index field, C `0048edd0`).

| # | name | kind | damage | range | speed | cooldown | hit % | projectile | users |
|---|---|---|---|---|---|---|---|---|---|
| 21 | Zerstörer Kanone | missile | 40-80 | 8 | 900 | 40 | 90 | 3 Katapult | Pimmon 65 |
| 22 | Schlachtsschiff Kanone | missile | 120-220 | 12 | 700 | 80 | 80 | 3 Katapult | Pimmon 66 |
| 23 | Zangen | melee | 9-18 | 0 | | 10 | 100 | | Sajiki 65 |
| 24 | Feuerball | missile | 80-250 | 10 | 600 | 80 | 70 | 9 Feuer | Sajiki 66 |
| 25 | Patrollienboot Kanone | missile | 25-50 | 9 | 1000 | 30 | 95 | 3 Katapult | Amazon 65 |
| 26 | Kreuzer Kanone | missile | 80-170 | 12 | 1000 | 55 | 85 | 3 Katapult | Amazon 66 |
| 27 | Angel | melee | 20-20 | 0 | | 40 | 100 | | fishing boats 64 (all races) |

No new projectile types: ships reuse group-7 types 3 and 9 of `dv.odb`.

---

## 5. Strings: `Addon.tdb` (D, C for loading)

Same format as `DV.tdb` ([os-dvf-tdb.md](os-dvf-tdb.md)). The string table has 331 slots in
`dvge.exe` (326 in AN.exe); `DV.tdb` fills 0..324 and `Addon.tdb` is loaded into the same table
right after it, at start-up, in base and AO games alike (C, `00493810`).

| id | text | used by |
|---|---|---|
| 325 | `Addon:` | world-parameter screen, label of the add-on toggle (section 11.4) |
| 326 | `Addon Kampagnen` | single-player menu button (section 11.2) |
| 327 | `Unterwegs zu Fischgründen` | unit status text (fishing boat on its way) |
| 328 | `Fischt` | unit status text (fishing) |
| 329 | `An Bord` | unit panel heading of a ship's passenger list (C, `00427000`) |
| 330 | `Ausladen` | unload command text *(I: tooltip of `AUSSTEIGEN`)* |

---

## 6. Inventions: `AO.idb` (D)

`Amazons\AO.idb`, `Pimons\AO.idb`, `Sajiki\AO.idb`: 6996 bytes = **33 records** of the `DV.idb`
format ([idb-wdb.md](idb-wdb.md)). Records 0..29 are byte-identical to the race's `DV.idb`. The
loader (C, `00413270`) is unchanged; it counts records from the file size.

| # | cost | needs (A / P / S) | name (A / P / S) | unlocks (from `+0xE4` of dv.odb + Addon.odb) |
|---|---|---|---|---|
| 30 | 25 | 1 / 1 / - | Werft | 63 shipyard, 67 transport |
| 31 | 60 | 30 | Hafen | 62 harbour, 64 fishing boat |
| 32 | 150 | 30,15 / 15,30 / 30,15 | Kreuzer / Schlachtschiff / Seepyro | 66 large warship |

The small warship 65 needs **15 Metallurgie** (and the shipyard to be trained at), not an add-on
invention. The shipyard topic needs invention 1 (Amazons "Bergfrau", Pimmons "Holzfäller");
the Sajiki one has no prerequisite. Descriptions:
"In der Werft werden alle Schiffstypen produziert. Anfangs kann das Patrolienboot und das
Transportschiff gebaut werden." (Pimmon and Sajiki texts name the "Zerstörer"), "Mit dem Hafen
ist es möglich Seehandel zu treiben, weiters steht das Fischerboot zu Verfügung.",
"Der Kreuzer / Das Schlachtschiff / Der Seepyro stellt die mächtigste Seeeinheit der ... dar."

**Mission presets (C, `00413270`).** The pre-researched flags of the race block now cover 33
inventions: the loop runs over indices 0..32 (AN.exe: 0..29) and reads the flags at race block
+0x80 + 4i, so **+0xF8, +0xFC, +0x100 are the flags of inventions 30, 31, 32** (formerly part of
the "unused" tail). In a base mission these words are 0 in all shipped files. The research level
(+0x64) works as before (`index <= n`), with one addition (C, Gold `00413730`, confirmed at
instruction level `004137b0..00413810`): when the record is an add-on record (+0xA50 > 0) and the
level routine runs (n > 0, also for the free-play development level 12 / 20), it marks invention
**30** always, **31** if n > 5 and **32** if n > 15. Disabled objects mark their invention
researched as in the base game (Gold `00413406..0041350c`, unchanged). Full list of start sources
and the free-play table: [economy.md](../game/economy.md) 4.4.2.

---

## 7. Mission records (`*AO.mdb`) and new goals

### 7.1 Record changes (C, D)

The record layout is unchanged ([mdb.md](mdb.md)). In the AO files:

| field | AO value | meaning |
|---|---|---|
| +0xA48 seed | **-2** in all 30 campaign records; -1 in `InfiniteAO.mdb` | -2 = terrain is stored in the map file (section 8) |
| +0xA4C size bits | 7, 8 or 9 | used for the map grid (C: the loader needs it to read the terrain block) |
| +0xA50 AO flag | 1 | section 1.1 |
| race block +0xF8..+0x100 | flags 0/1 | inventions 30..32 pre-researched |
| race block +0x10 relations | set in most missions | unlike the base campaigns |

`InfiniteAO.mdb` is `Infinite.mdb` with size bits 9 and +0xA50 = 1 (start gold 250 per race; the
free-play menu overwrites gold and goods as in base free play).

The files hold indices 0..9 in order (no shuffled storage as in `Pimmons.mdb`). There is no
`TutorialsAO.mdb`. The patch 3.03 replaced `PimmonsAO.mdb` and `SajikisAO.mdb`; the installed
copies are that version ([editions.md](../game/editions.md)).

### 7.2 New goal types 17..20 (C, table `0x4BD194`, evaluator `00478530`)

The goal table now has 20 entries; evaluation, the 50-tick period and the win/loss rule are
unchanged (mdb.md "Goals"). Goals are tested only in single player. The new types are available
in every mission, not only AO ones.

| type | condition (true when ...) | p1 | p2 | p3 | code |
|---|---|---|---|---|---|
| 17 | object `p1` exists and lies within distance `p3` of cell `(x, y)` | object id | `(x << 16) \| y` | radius | `00478b60` |
| 18 | object `p1` does **not** exist, or is dead, or its type (record +0xA8) is not `p2` | object id | type | - | `00478d50` |
| 19 | the evaluating player's settlements whose position lies on island `p1` together own at least `p3` objects of type `p2` | island id | type | count | `00478db0` |
| 20 | stock of good `p1` in the player's city `p3` (1-based) is **<= p2**; false if that city does not exist | good | amount | city | `00478e90` |

Details:

- **Distance** (type 17) is the torus distance of world-populate.md 2.2:
  `max(|dx|, |dy|) + min(|dx|, |dy|) / 2` with both axes wrapped, using the object's current cell
  (object +0x10/+0x14).
- **"Dead"** (type 18) is the object's alive byte (+0x34) being 0. Type 18 is used as a loss
  condition: "lose when the scout / founder / transport / shipyard #p1 is gone".
- **Island** (type 19): the settlement's position cell (settlement +0x28/+0x2C) is looked up in
  the island-id grid (section 8.5); objects counted are the settlement's per-type object list
  (any construction state, like goal 4). Settlements whose alive byte is 0 are skipped.
- An **object id** is the index the object got in the global object table when it was created
  (C, `00467d70`): ids are handed out from a free list starting at 0, so on a fresh map they are
  the **creation order**. Map objects are created in the order of section 8.4. Goals 17/18 are
  therefore only meaningful together with that exact creation order.

### 7.3 Object ids referenced by the shipped goals (C rule, D check)

With the creation order of section 8.4 the referenced ids resolve to the objects the briefings
talk about:

| mission | goal | object | matches the briefing |
|---|---|---|---|
| Amazons 4 "Kontaktaufnahme" | win: #318 within 7 of (59,101); lose: #318 (type 24) gone | Amazon scout (Späherin), cargo of the transport at (63,52); (59,101) is the Amazon embassy | yes ("Die Späherin muss die Botschaft erreichen") |
| Pimmons 1 "Die Meerenge" | win: #563 within 15 of (223,81); lose: #563 (67) gone | Pimmon transport at (185,165) | yes |
| Pimmons 2 "Der Versorgungsstützpunkt" | lose: #393 (10) gone | Pimmon city founder, cargo of the transport at (102,235) | yes |
| Pimmons 5 "Rettungsversuch" | lose: #584 (63) gone | Pimmon shipyard at (204,0) | yes |
| Pimmons 6 "Ein neuer Anlauf" | lose: #1115 (39) gone | Amazon barracks at (222,168) (allied town) | yes |
| Sajiki 0 "Ende an der Meerenge" | lose: #445..448, #451 within 15 of (14,51) | Pimmon destroyers (65) and a battleship (66) | yes |
| Sajiki 4 "Die Handelsflotte" | **win**: #990, #991 within 10 of (74,62) | two Pimmon destroyers | the briefing says they must **not** reach the Amazon harbour; as stored these are win conditions *(probable data bug: the mission is then only won if both arrive and the Pimmons are eliminated)* |
| Sajiki 5 "Riskanter Botengang" | lose: #559 (24) gone; win: #559 within 4 of (87,110) | Sajiki scout | yes |
| Sajiki 8 "Trennungslinie" | lose: #3563..3571 within 15 of (25,136) | resolve to an Amazon large outpost, its archers, houses, porters and a maggot farm (immobile or unrelated) | **no** *(uncertain)*: the Amazon patrol ships the briefing means are #3580..3588, 17 higher (exactly the 17 house porters of section 8.4). Either this map's ids were authored without house porters (then the conditions can never fire) or the original creates no porters for these houses |

### 7.4 Add-on mission table (D)

Generated from the files; objects named in the human's race group. "R[...]" = pre-researched
inventions (+0x80 flags), "L" = research level, "X[...]" = disabled objects, gold = start gold.
All campaign records: seed -2, map stored. Relations are set in almost every mission (the race
blocks' +0x10 table).

| mission | title | map | size | human | computer (AI profile field) | goals | setup |
|---|---|---|---|---|---|---|---|
| AmazonsAO 0 | Zeit der Veränderung | Amazon0AO.dvm | 128 | Amazons | - | LOSE if city 1 food <= 5; win: finished 63 Werft, 42 Botschaft, 39 Kaserne (1 each) | Am 100g R[0-2,6] X[62] |
| AmazonsAO 1 | Verzweifelter Angriff | Amazon1AO.dvm | 256 | Amazons | Sajiki (p4) | win: city 1 food >= 20; Sajiki eliminated | Am 100g R[0-3] X[10]; Sa 300g R[0-3] |
| AmazonsAO 2 | Den Göttern sei Dank | Amazon2AO.dvm | 256 | Amazons | Sajiki (p0) | LOSE if own city 1 has no 59 Tempel; win: city 1 food >= 30 | Am 1000g R[0-8,30]; Sa 1000g R[0-8,15,30] |
| AmazonsAO 3 | Die Erkenntnis | Amazon3AO.dvm | 256 | Amazons | Pimmons (p4), Sajiki (p4) | win: finished 42, 59, 2 x 38 | Am 300g R[0-11,30-31]; Pi 1000g R[0-11,15,30-31]; Sa 1000g L21 R[0-11,30-31] |
| AmazonsAO 4 | Kontaktaufnahme | Amazon4AO.dvm | 128 | Amazons | Sajiki (p0) | goals 17/18 on #318 (7.3) | Am 100g; Sa 5000g |
| AmazonsAO 5 | Inselsäuberung | Amazon5AO.dvm | 256 | Amazons | Sajiki (p0) | Sajiki eliminated | both 500g R[0-14,17,29-31] |
| AmazonsAO 6 | Die Pimmon-Inseln | Amazon6AO.dvm | 256 | Amazons | Pimmons (p0) | Pimmons eliminated | Am 500g, Pi 10000g, both R[0-19,29-31] |
| AmazonsAO 7 | Letzte Vorbereitungen | Amazon7AO.dvm | 256 | Amazons | Pimmons (p0) | win: finished 2 x 53, 56, 43 | both 500g R[0-22,29-32] |
| AmazonsAO 8 | Schwesternhilfe | Amazon8AO.dvm | 512 | Amazons | Sajiki (p0) | Sajiki eliminated | both 1000g R[0-24,29-32] |
| AmazonsAO 9 | Eine gegen alle | Amazon9AO.dvm | 256 | Amazons | Pimmons (p0), Sajiki (p6) | Pimmons and Sajiki eliminated | Am 2000g; Pi 500g X[42]; Sa 800g X[42]; all R[0-32] |
| PimmonsAO 0 | Drohende Gefahr | Pimmon0AO.dvm | 128 | Pimmons | Sajiki (p0) | win: finished 63; LOSE if own city 1 has no 46 Labor | both 300g |
| PimmonsAO 1 | Die Meerenge | Pimmon1AO.dvm | 256 | Pimmons | Sajiki (p4) | goals 17/18 on #563 | Pi 200g L7 R[0-3]; Sa 300g L10 R[0-3] |
| PimmonsAO 2 | Der Versorgungsstützpunkt | Pimmon2AO.dvm | 256 | Pimmons | Sajiki (p0) | win: wood >= 25, stone >= 25, finished 63; LOSE if #393 gone | Pi 300g L11; Sa 300g |
| PimmonsAO 3 | Erste Kolonie | Pimmon3AO.dvm | 256 | Pimmons | Amazons (p0) | win: finished 63, 56, 39, 2 x 38 | Am 300g X[66]; Pi 5000g L11; both R[0-8,30] |
| PimmonsAO 4 | Überraschender Angriff | Pimmon4AO.dvm | 256 | Pimmons | Amazons (p3) | Amazons eliminated | Am 300g, Pi 1000g, both R[0-12,30-31] |
| PimmonsAO 5 | Rettungsversuch | Pimmon5AO.dvm | 256 | Pimmons | Sajiki (p3) | LOSE if #584 gone; Sajiki eliminated | Pi 500g R[0-14,17,29-31]; Sa 3000g L1 R[0-13,16,29-31] |
| PimmonsAO 6 | Ein neuer Anlauf | Pimmon6AO.dvm | 256 | Pimmons | Amazons (p4), Sajiki (p1) | LOSE if #1115 gone; Sajiki eliminated | Am 300g R[0-10]; Pi 500g, Sa 700g, both R[0-19,29-31] |
| PimmonsAO 7 | Der Außenposten | Pimmon7AO.dvm | 256 | Pimmons | Amazons (p4), Sajiki (p0) | win: 6 finished 52 | Am 500g, Pi 2500g R[0-22,29-32]; Sa 400g R[0-23,29-31] X[66] |
| PimmonsAO 8 | Sajikis aus dem Paradies | Pimmon8AO.dvm | 256 | Pimmons | Sajiki (p0) | Sajiki eliminated | Pi 1000g, Sa 600g, both R[0-25,29-32] |
| PimmonsAO 9 | Die Nordamazonen kommen | Pimmon9AO.dvm | 512 | Pimmons | Amazons (p1) | Amazons eliminated | Am 700g, Pi 1000g, both R[0-32] |
| SajikisAO 0 | Ende an der Meerenge | Sajiki0AO.dvm | 256 | Sajiki | Pimmons (p4) | win: Pimmon city 1 has no 63; LOSE if #445..448/#451 near (14,51) | Pi 300g, Sa 1000g, both X[62,66] |
| SajikisAO 1 | Angriff auf die Pimmonbucht | Sajiki1AO.dvm | 128 | Sajiki | Pimmons (p0) | win: Pimmon city 1 has no 37, no 58, no 55 | Pi 0g, Sa 3000g, both R[0-3] X[62,66] |
| SajikisAO 2 | Insel-Beschlagnahmung | Sajiki2AO.dvm | 256 | Sajiki | Pimmons (p4) | win (goal 19): island 1 >= 1 x 52; island 2 >= 2 x 52; island 2 >= 1 x 63 | Pi 0g R[0-8,30] X[66]; Sa 3000g R[0-8,30-31] X[66] |
| SajikisAO 3 | Das Doppelspiel | Sajiki3AO.dvm | 256 | Sajiki | Pimmons (p4) | Pimmons eliminated | Pi 500g, Sa 1500g, both R[0-11,30] X[66] |
| SajikisAO 4 | Die Handelsflotte | Sajiki4AO.dvm | 256 | Sajiki | Amazons (p4), Pimmons (p0) | Pimmons eliminated; #990, #991 near (74,62) (7.3) | Am 2500g L8; Pi 500g L8; Sa 500g L16; Pi/Sa R[0-14,17,29-31] |
| SajikisAO 5 | Riskanter Botengang | Sajiki5AO.dvm | 128 | Sajiki | Amazons (p4), Pimmons (p4) | goals 17/18 on #559 | Am, Pi 500g L15 X[50]; Sa 111g L15 |
| SajikisAO 6 | Der gemeinsame Offensive | Sajiki6AO.dvm | 256 | Sajiki | Amazons (p4), Pimmons (p0) | Pimmons eliminated | all 500g; Pi/Sa R[0-19,29-31] |
| SajikisAO 7 | Angriff auf die Festung | Sajiki7AO.dvm | 256 | Sajiki | Pimmons (p4) | Pimmons eliminated | Pi 500g R[0-32]; Sa 500g R[0-22,30-32] |
| SajikisAO 8 | Trennungslinie | Sajiki8AO.dvm | 512 | Sajiki | Amazons (p0) | Amazons eliminated; LOSE if #3563..3571 near (25,136) (7.3) | Am 600g, Sa 2000g, both R[0-24,29-32] |
| SajikisAO 9 | Der Pakt wird gebrochen | Sajiki9AO.dvm | 256 | Sajiki | Amazons (p0) | Amazons eliminated | Am 600g, Sa 1200g, both R[0-32] |
| InfiniteAO 0..2 | Erschaffe eine Welt | - | 512 | race = record | other two (p0) | other two eliminated | 250g each (menu overrides) |
| InfiniteAO 3 | Multiplayer | - | 512 | - | - | - | unused by the menu code, like `Infinite.mdb` record 3 |

Notable: the add-on campaigns use the **research level** field (values 1..21) and the new
disabled-object pairs `62`/`66` (no harbour, no large warship) to stage the tech tree.

---

## 8. Add-on maps (`<Race><n>AO.dvm`)

### 8.1 Why they are large

The AO maps **store the terrain**: one 3-byte cell per map cell, i.e. 49,152 bytes for 128 x 128,
196,608 for 256 x 256 and 786,432 for 512 x 512. That accounts for the 50 / 200 / 850 KB file
sizes; the object lists are of the usual size. The mission record says so by seed **-2**
(terrain-gen.md: "no generated terrain"). The terrain is hand-edited island terrain (made with
the island generator and then edited, section 8.3), which the seed generator could not reproduce.

### 8.2 Format (C, `00414440` header, `004144e0` objects, `0044ffb0` terrain)

```
char[4] "SMVD"
u32     version   100 (unchanged; not checked)
u32     object_count
if mission seed == -2:                       <- the mission record decides, not the file
    n*n x { u16 height; u8 tile }            n = 1 << size_bits of the mission record;
                                             cells in index order i = y*n + x (rows y outer)
object_count x object record (28 bytes, dvm.md), but:
    a unit record (class 0 after the group-6 rule) whose type is 67 (transport ship)
    is followed by:  u32 cargo_count, cargo_count x u32 unit type
trailing block (unchanged, dvm.md): 5 point lists, camera, orders
```

- The reader takes the terrain block **only when the current mission's seed is -2**; it has no
  marker in the file. A rebuild must pass the mission's size bits to the map reader.
- `height` is the cell's ground height (same scale as generated terrain). Shipped AO maps: land
  121..337, sea exactly **120** (D: every cell with a water tile has height 120 and no land tile
  has height <= 120, in all 30 campaign maps).
- `tile` is the **global tile number** (section 8.3), not a class. After reading, the game
  recomputes every cell's light value from the heights (C, rendering only).
- The object records' z still equals the stored height of their cell (D, all but 28 of 25,482
  records in the 30 campaign maps), and is still ignored by the loader.
- **Cargo** (C): the cargo list holds unit types of the ship's race. After all other units are
  created, each ship found on its cell gets one new unit per cargo entry, in list order, created
  inside the ship and belonging to the ship's player and settlement. An empty list (count 0) is
  allowed (D: Pimmon1AO). Only type 67 has this extra field, in any race group.
- The trailing block: lists, camera and orders exactly as in [dvm.md](dvm.md).

### 8.3 Tiles and terrain classes (C, `00492960`, `0048f040`)

The game loads one tile set per terrain class and numbers all tiles consecutively in class order;
the map stores that number. Per-mode class tables (index into the file list `weg`, `schnee`,
`rock`, `wiese`, `waldboden`, `gruenwald`, `gelbgras`, `wasser1`; tables at `0x4BCB44` and
`0x4BCB74`):

| class | base mission (AN and Gold) | AO mission |
|---|---|---|
| 0 | wiese | weg (beach) |
| 1 | gelbgras | weg |
| 2 | schnee | schnee |
| 3 | rock | rock |
| 4 | waldboden | wiese |
| 5 | waldboden | waldboden |
| 6 | gruenwald | gruenwald |
| 7 | waldboden | gelbgras |
| 8 | gelbgras | weg |
| 9 | gruenwald | **wasser1 (open sea, not animated)** |
| 10 | weg (lake shore) | **water** (animated `wasser1..4`, shoreline `transition1..4`) |
| 11 | water | - |
| land class count | 11 | 10 |

The water class is always the class whose number equals the land class count; its four animation
frames `wasser1..4` are loaded after it. The **first tile number of class c** is the sum of the
tile counts of classes 0..c-1 (tile counts: weg 9, schnee 18, rock 16, wiese 20, waldboden 16,
gruenwald 16, gelbgras 17, wasser1..4 4 each). For AO maps:

| class | 0 weg | 1 weg | 2 schnee | 3 rock | 4 wiese | 5 waldboden | 6 gruenwald | 7 gelbgras | 8 weg | 9 sea | 10 water |
|---|---|---|---|---|---|---|---|---|---|---|---|
| tiles | 0-8 | 9-17 | 18-35 | 36-51 | 52-71 | 72-87 | 88-103 | 104-120 | 121-129 | 130-133 | 134-137 |

To load an AO map: class = the class whose range contains the tile, set = the class's tile set,
variant = tile - first tile of the class. Used in the shipped maps: classes 0, 2..7, 9, 10;
classes 1 and 8 never occur (they duplicate `weg`).

**Sea rule (D, all 30 campaign maps, 0 exceptions):** a sea cell (height 120) is class 10
(animated coastal water) when at least one of its 8 neighbours is land (height > 120), else
class 9 (open sea). It is the rule of the island generator (section 9.4).

**Rendering note.** Class 9 is an ordinary, static tile set that happens to show water, so the
open sea is cheap to draw; only the one-cell ring of class 10 next to the coast animates and
gets shoreline pieces. How the original draws a quad whose corners mix class 9 and class 10 was
not traced *(uncertain; a rebuild can treat both as water for the shoreline choice and animate
only class 10)*.

**Cell flags in the Gold engine** (C, `0044c020`, also `004565a0`): `0x2000` land when
tile < first tile of the "first water class" (class 9 in AO missions, 11 in base missions),
otherwise `0x20` water; new `0x8000` when tile >= first tile of the water class (animated water;
in base missions identical to 0x20); new `0x10000` when the tile belongs to class 0 (in AO: beach).
The mountain bit 0x100 uses the mode's threshold (290 in AO).

### 8.4 Object creation order and ids (C, `004144e0`, `00465d00`, `00466590`)

This order decides the object ids that goals 17/18 refer to (section 7.2). Base maps follow it
too (C in `dvge.exe`; I for AN.exe, whose loader has the same structure minus the cargo step):

1. **Nature**: every group-6 record, created while reading, in file order.
2. **Town halls** (class 1, type 40), in file order. Per town hall: the town hall, its resident
   city founder (type 10), then on completion **one builder (11) and two porters (9)**.
3. **Other buildings**, in file order. Per building: the building; its operator (+0xD8) if any;
   for houses (types 37 and 38) **one porter (9)** spawned by the house's "new resident" rule
   (odb.md section 5: when there is room, probability 1 / (10 - h/10), always when h >= 80; all
   shipped houses get one, I: a fresh settlement starts with h >= 80); for outposts (class 6) the
   +0xDC archers (type 29).
4. **Units**, in file order (ships included).
5. **Cargo** of every type-67 unit, ships in file order, cargo in list order.

Ids are 0, 1, 2, ... in this order. With it, every referenced id but those of Sajiki 8 resolves
to the object its mission describes (section 7.3).

### 8.5 Island ids (C, `0044ef50`, `004922c0`, `0044cea0`)

In an AO mission the map object holds an extra byte grid (n x n). After the map is loaded or
generated, the game labels the **land** (height > 120) with the run labelling of section 9.3 and
writes each land cell's label (truncated to a byte) into the grid; sea cells stay 0. The labels
are the island ids used by goal 19 and by add-on placement rules (gameplay spec). A rebuild must
reproduce the label numbers exactly, i.e. implement section 9.3 as written, not just any
connected-component labelling.

### 8.6 The 32 AO map files (D)

Dump of every file (a scratch reader written from 8.2; all parse with no bytes left over, except
as noted). Objects = nature / buildings / units. New types: `62..67` race objects, `nNN` nature
types. Cargo = cargo list lengths of the type-67 units. Lists = sizes of the five point lists.
Sea = share of cells with height 120. Islands = number of 4-connected land components and the
largest sizes in cells.

| file | used by | size | records | nat / bld / units | new types | cargo | lists | camera | orders | sea | islands |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Amazon0AO | AmazonsAO 0 | 128 | 97 | 67/16/14 | n39:1 | - | 0,0,0,0,23 | 3,73 | 0 | 52% | 1 (7790) |
| Amazon1AO | AmazonsAO 1 | 256 | 358 | 340/8/10 | 67:2, fish 296, palms 23 | 1, 5 | 3,2,0,0,38 | 8,11 | 8 | 91% | 1 (5644) |
| Amazon2AO | AmazonsAO 2 | 256 | 534 | 485/21/28 | 63:1 67:1 n39:4 n40:2, fish 255, n51:1 | 0 | 4,6,3,1,39 | 209,224 | 4 | 80% | 2 (8068, 5362) |
| Amazon3AO | AmazonsAO 3 | 256 | 758 | 710/33/15 | 62:3 63:2, animals 16, fish 254, palms 196, n50/51: 23/23 | - | 5,4,10,0,74 | 228,234 | 8 | 80% | 4 (5377, 3252, 3054, 1372) |
| Amazon4AO | AmazonsAO 4 | 128 | 299 | 225/9/65 | 63:1 65:7 66:4 67:2, fish 27, palms 141 | 3, 0 | 0,0,0,0,9 | 62,50 | 58 | 45% | 5 (6945, 785, 687, 374, ...) |
| Amazon5AO | AmazonsAO 5 | 256 | 844 | 799/29/16 | 63:3 65:7 66:2 67:2, fish 228, palms 349 | 5, 5 | 6,6,1,1,93 | 221,241 | 7 | 72% | 3 (9200, 4757, 4471) |
| Amazon6AO | AmazonsAO 6 | 256 | 609 | 562/18/29 | 65:1 66:1 67:2, fish 259, palms 161 | 5, 2 | 3,5,3,0,48 | 221,61 | 0 | 81% | 5 (4556, 4176, 3469, 96, ...) |
| Amazon7AO | AmazonsAO 7 | 256 | 735 | 668/32/35 | fish 253, palms 226 | - | 9,8,5,1,85 | 197,0 | 18 | 79% | 1 (13780) |
| Amazon8AO | AmazonsAO 8 | 512 | 2086 | 1991/51/44 | 63:3 65:5 66:7, fish 1193, palms 435 | - | 10,10,9,1,3 | 487,319 | 30 | 92% | 3 (13522, 5456, 2298) |
| Amazon9AO | AmazonsAO 9 | 256 | 1093 | 994/49/50 | 63:4 65:8 66:10, fish 203, palms 428 | - | 11,10,13,1,24 | 156,13 | 23 | 65% | 3 (11404, 7422, 3990) |
| Amazon9AAO | (none) | 256 | 307 | 303/4/0 | n39:5 n40:4 | - | 15,13,9,0,24 | 0,0 | 0 | 65% | 3 (11295, 7410, 3990) |
| AmazonAO1 | (none) | 256 | 41 | - | 64..67 | see below | | | | | |
| Pimmon0AO | PimmonsAO 0 | 128 | 225 | 205/12/8 | none | - | 3,3,1,0,3 | 25,83 | 4 | 32% | 1 (11085) |
| Pimmon1AO | PimmonsAO 1 | 256 | 520 | 475/21/24 | 67:1 n39:7 n40:3 | 0 | 6,9,4,0,3 | 170,201 | 3 | 53% | 4 (17342, 7719, 5813, 11) |
| Pimmon2AO | PimmonsAO 2 | 256 | 389 | 365/1/23 | 65:8 67:2, fish 287, palms 24 | 1, 5 | 0,0,0,0,4 | 106,235 | 16 | 89% | 1 (7294) |
| Pimmon3AO | PimmonsAO 3 | 256 | 697 | 647/30/20 | 62:2 63:1, fish 263, palms 222 | - | 7,3,1,0,4 | 7,13 | 3 | 82% | 4 (4811, 4430, 2405, 79) |
| Pimmon4AO | PimmonsAO 4 | 256 | 797 | 753/24/20 | 63:2, fish 256, palms 243 | - | 7,6,4,2,4 | 14,253 | 12 | 80% | 7 (6995, 4927, 419, ...) |
| Pimmon5AO | PimmonsAO 5 | 256 | 604 | 552/27/25 | 63:2 65:7 66:3 67:1, fish 253, palms 168 | 0 | 5,6,3,1,5 | 201,250 | 16 | 79% | 2 (7151, 6557) |
| Pimmon6AO | PimmonsAO 6 | 256 | 1143 | 1079/43/21 | 62:1 63:1, fish 150, palms 518 | - | 18,19,8,2,4 | 32,186 | 13 | 49% | 1 (33484) |
| Pimmon7AO | PimmonsAO 7 | 256 | 900 | 858/25/17 | 62:1 63:1, fish 243, palms 266 | - | 6,15,9,0,3 | 246,241 | 7 | 77% | 6 (7424, 4954, 2858, ...) |
| Pimmon8AO | PimmonsAO 8 | 256 | 1177 | 1113/31/33 | 62:2 63:2 65:13 66:3 67:2, fish 131, palms 518 | 5, 5 | 20,17,13,4,5 | 207,30 | 9 | 43% | 1 (37281) |
| Pimmon9AO | PimmonsAO 9 | 512 | 2029 | 1931/38/60 | 62:2 63:2 67:1, fish 1184, palms 370 | 0 | 14,18,10,3,4 | 50,470 | 31 | 91% | 7 (12541, 7450, 2746, 520, ...) |
| Sajiki0AO | SajikisAO 0 | 256 | 427 | 405/12/10 | 63:1 65:9 66:1 n39:3 n40:6 n50:4 n51:2 | - | 4,8,3,1,3 | 8,90 | 10 | 73% | 2 (12646, 5027) |
| Sajiki1AO | SajikisAO 1 | 128 | 199 | 162/24/13 | 63:1 65:3 | - | 4,3,1,0,3 | 57,59 | 0 | 57% | 1 (7099) |
| Sajiki2AO | SajikisAO 2 | 256 | 658 | 613/20/25 | 62:1 63:2 65:4 67:2, fish 238, palms 160 | 4, 5 | 4,5,4,0,5 | 23,16 | 10 | 74% | 3 (14058, 2601, 115) |
| Sajiki3AO | SajikisAO 3 | 256 | 558 | 523/21/14 | 62:2 63:1, fish 274, palms 113 | - | 2,9,1,0,80 | 208,242 | 3 | 85% | 2 (5403, 4331) |
| Sajiki4AO | SajikisAO 4 | 256 | 947 | 892/36/19 | 63:3 65:10 66:1, fish 256, palms 348 | - | 3,4,5,2,94 | 54,20 | 9 | 81% | 6 (4777, 4311, 2973, 372, ...) |
| Sajiki5AO | SajikisAO 5 | 128 | 529 | 461/16/52 | 67:2, fish 10, palms 256 | 0, 0 | 4,0,8,0,12 | 63,19 | 38 | 21% | 6 (12650, 239, 83, ...) |
| Sajiki6AO | SajikisAO 6 | 256 | 1181 | 1085/47/49 | 63:4 65:17 66:3 67:2, fish 466, palms 342 | 5, 5 | 10,7,6,1,60 | 69,77 | 33 | 73% | 3 (10082, 6510, 882) |
| Sajiki7AO | SajikisAO 7 | 256 | 785 | 719/22/44 | 66:12, fish 267, palms 267 | - | 6,5,1,0,73 | 160,90 | 38 | 81% | 2 (8754, 3939) |
| Sajiki8AO | SajikisAO 8 | 512 | 3604 | 3475/48/81 | 62:1 63:2 64:3 65:15 66:9 67:3, fish 2328, palms 635 | 0, 0, 0 | 15,5,5,1,3 | 83,198 | 18 | 90% | 4 (18070, 4568, 2823, 1698) |
| Sajiki9AO | SajikisAO 9 | 256 | 700 | 632/21/47 | 63:1 65:3 66:10 67:3, fish 271, palms 204 | 5, 5, 5 | 7,9,4,1,97 | 24,78 | 34 | 84% | 2 (10110, 110) |

(Fish = types 41..45, palms = 46..49; where fish/palms are summed, the counts of Gecko, Krabbe,
Aloe and Venus are left out of this column.) The populated maps place fish densely in open water and
palms instead of the base trees; base tree, bush, stone and animal types still occur.

**Unreferenced files (D):**

- `Amazon9AAO.dvm`: an earlier version of `Amazon9AO.dvm` (same islands, nature only). It parses
  with size 256, but its sea is entirely class 10 (no class-9 open sea) and 16 land tiles sit at
  height <= 120, so it predates the final generator rules. Not used by any record.
- `AmazonAO1.dvm`: 41 records, size 256 (terrain block present); its type-67 record is **not**
  followed by a cargo list (older layout), and the first point list claims 16,461 entries
  (an editor fault). It parses exactly with those two assumptions. Not used by any record.

### 8.7 Base maps in Gold (D)

`Tutorial1.dvm` differs from the GOG copy only in the z field of 9 nature records (ignored by the
loader). All other base maps are identical. Base maps never contain a terrain block (their seeds
are >= 0).

---

## 9. Add-on terrain generator (free play, seed -1)

Used for `InfiniteAO.mdb` (single player and multiplayer) whenever the seed is -1. Same entry
point as the base generator (C, `0044e6b0`): `srand(seed)`, heights and classes (`0044d250`,
AO branch), **no lakes step** (`0044e440` returns at once in AO), tile choice and light
(`0044e4c0`, unchanged: rows y outer, x inner, one `rand() & 0xFF` per cell into the class's
weighted tile lookup, see terrain-gen.md step 4). All random numbers are the MS C `rand()` of
terrain-gen.md. Cell index = y * n + x, all coordinates wrap.

### 9.1 Initial state

Every cell: height 0, class 0.

### 9.2 Heights: diamond-square (C, `0044d8f0`)

1. **Coarse lattice.** For `x = 0, 32, 64, ... < n` (outer loop) and `y = 0, 32, ... < n` (inner
   loop): `h = rand() & 0x1FFF`; if `h < 0x1000` then `h = 0x1000`. Store at (x, y). Track the
   minimum `lo` (start 0x2000) and maximum `hi` (start 0).
2. **Normalise.** `scale = 384.0 / (hi - lo)` computed in floating point and stored as a
   **32-bit float**. For every lattice point (same loop order): `h = trunc((h - lo) * scale)`
   (0..384).
3. **Refinement.** `A = 128.0` (double), step `s = 32`. Repeat while `s != 0`:
   - `r = trunc(A + 0.5)`; if `r == 0` or `s < 2` then `r = 1`. (Values: s=32 -> 128, 16 -> 60,
     8 -> 28, 4 -> 13, 2 -> 6, 1 -> 1.)
   - `half = s >> 1`. Define `noise(sum) = rand() % r + (sum >> 2) - (r >> 1)`, clamped to
     0..32767 (one `rand()` per call, drawn after the four inputs are read).
   - **Square centres:** for `y = 0, s, 2s, ... < n` (outer) and `x = 0, s, ... < n` (inner):
     `h(x+half, y+half) = noise(h(x,y) + h(x+s,y) + h(x,y+s) + h(x+s,y+s))`.
   - **Edge midpoints:** for `y = 0, s, ... < n` (outer) and `x = 0, s, ... < n` (inner), two
     points in this order:
     1. `h(x+half, y) = noise(h(x,y) + h(x+s,y) + h(x+half,y-half) + h(x+half,y+half))`
     2. `h(x, y+half) = noise(h(x,y) + h(x,y+s) + h(x-half,y+half) + h(x+half,y+half))`
   - `A = A * 2^-1.1` (computed as `A * pow(2.0, -1.1)` in double), `s = s >> 1`.

   Writes are in place, so later reads see earlier results of the same pass. In the last pass
   (s = 1, half = 0) the formulas degenerate into averaging a cell with its neighbours; they must
   still be executed (and still draw one `rand()` each) for exact results.

### 9.3 Run labelling (C, `0044cea0`; also used in 8.5 and 10)

Input: a cell predicate. Output: a list of runs `{row y, x0, x1 (exclusive), label}` in creation
order, and the label count.

1. For each row `y = 0 .. n-1`, find the maximal runs of cells that satisfy the predicate
   (`x0 .. x1-1`, no horizontal wrap at this stage). Append each run to the list in scan order.
2. Each new run R in row y looks at the runs of row y-1 (none for y = 0) that **overlap** it
   (`P.x0 < R.x1` and `P.x1 > R.x0`), left to right. If there is none, R gets a new label
   (`count + 1`, labels start at 1). Otherwise R gets the label L of the first overlapping run, and
   for every further overlapping run P whose label M differs from L, **every run in the list**
   labelled M is relabelled L.
3. After the scan, for every run in list order:
   - if it starts at `x0 = 0` and the **last run of its row** ends at `x1 = n`, every run carrying
     this run's label is relabelled with the last run's label (horizontal wrap);
   - if it lies in the last row (`y = n-1`), then for each row-0 run that overlaps it (left to
     right), every run carrying this run's current label is relabelled with that row-0 run's label
     (vertical wrap).
4. Labels are not renumbered; some numbers may end up unused (size 0).

The result is 4-connectivity on the torus; the label numbers come from this exact procedure.

### 9.4 Lakes removed, classes assigned (C, `0044d250` AO branch, `0044d1a0`)

1. Label the **water** cells (predicate: height <= 120) with 9.3. Compute each label's size (sum
   of run lengths) and sort the pairs (size, label) in **descending** order (size first, then
   label). The first entry is the ocean.
2. For every run not labelled with the ocean's label, in list order, and for every cell of the run
   from x0 upwards: `height = 121 + (rand() & 3)`; `class = 4 + (label & 3)`. Inland lakes thus
   become low land of class 4..7 (wiese, waldboden, gruenwald, gelbgras).
3. For every cell in index order (`i = y*n + x`) whose class is still 0:
   - height > 120 and **all 8 neighbours** > 120: class 2 if height > 290, else 5 if height > 250,
     else 4;
   - height > 120 with any neighbour <= 120: class 0 (beach);
   - height <= 120: class 10 if any of the 8 neighbours has height > 120, else 9; then height =
     120.

   (Neighbours are read live; sea cells already set to 120 still count as <= 120, so the order
   does not change the result.)

Heights above 120 are never changed, so islands keep their diamond-square relief; the sea is
flat. The tile choice then follows (all class-9/10 sets have equal weights).

### 9.5 Re-roll (C, `004922c0`)

If the add-on populator (section 10) reports failure, the game draws `seed = rand()` (continuing
the current stream), regenerates the terrain from it and runs the populator again, until it
succeeds. In multiplayer the host then sends the final seed. (In base free play the loop never
repeats, world-populate.md section 8.)

There is no limit (C). Because a failure with k < 4 (section 10.4) happens before the populator
draws anything, the next seed is simply the first `rand()` after the terrain of the failed seed,
a fixed function of that seed. Following this function over all 32768 seeds of a 256 map (with
the rebuild's generator, which implements 9.1..9.4 as specified): only **2,319 seeds (7 %)** give
four islands of >= 2000 cells and succeed at once; the others re-roll **14 times on average**
(median 9, 99th percentile 62, maximum 76); and **40 start seeds (0.12 %) never succeed**, because
their chain runs into one of two 3-seed cycles of failing seeds (10253 -> 2016 -> 13201 and
3345 -> 29624 -> 21134, each with fewer than four big islands). If the generator is exact, the
original hangs at world creation for those 40 starting seeds *(I: follows from the code; not
observed)*. Island-count histogram over all 32768 256-map seeds: k = 0..7 islands of >= 2000
cells for 10 / 9809 / 12862 / 7723 / 2093 / 256 / 14 / 1 seeds. 512 maps practically never
re-roll.

### 9.6 Map size

The free-play world size comes from the menu (section 11.4); with the add-on toggle on, "Klein"
(128) cannot be chosen, so AO free-play maps are 256 or 512 (the populator has a fallback for 128,
section 10.4).

---

## 10. Add-on free-play populator (C, `00491080` AO branch)

Replaces world-populate.md sections 4..8 for AO missions without a map file. Differences in
principle:

- **No clock reseed.** The base populator starts with `srand(time())`; the add-on branch does
  not, so the whole world (terrain and nature) follows from the terrain seed.
- Resources are placed **per island**, start positions are one per large island.
- The base scatter passes (world-populate.md 6) do not run.
- The builder can **fail**, which triggers the re-roll of 9.5.

`r` = the "Anzahl Rohstoffe" setting 0/1/2. "Random island cell" (C, `00490db0`):
`k = rand() & 0x3FF`; walk the run list cyclically from its first entry, counting only runs of
the island, until k such runs have been passed; then `x = x0 + rand() % (x1 - x0)` of that run,
`y` = its row.

Exactly (C): the walk starts **on** the list's first entry, and each step first moves to the next
entry (wrapping from the last entry back to the first) and then counts it if it belongs to the
island; after k counted steps (none for k = 0) it moves on until it stands on a run of the island.
With the island's runs `R0..R(m-1)` in list order, the chosen run is therefore:

- `R(k mod m)` if the list's first entry is `R0` (the island owns the very first run) or k = 0;
- otherwise `R((k - 1) mod m)` (the first entry is not counted when the walk starts on it, but it
  is the place the walk wraps through).

The same function picks the fish cells (step 5), with the open-sea run list.

**Site test T(w)** (C, inline): for a candidate (x, y), the footprint is the w x w square with
maximum corner (x, y); OR the cell flags (8.3) of the footprint; height range over the one-cell
ring around it; the site fits when the OR has none of `0x17E` (object, water, mountain > 290) and
the ring range is <= 64. (The code also counts land cells and drops flag bits above 0xFFFF when
that count is outside 1..w+1; this has no effect on the 0x17E test.)

### 10.1 Islands

Label the land (height > 120) with 9.3, compute sizes, sort descending (as 9.4). Let **k** = the
number of islands with at least **2000** cells.

### 10.2 k >= 4: one start per big island

1. For each of the three largest islands: random island cell, test T(9); on failure pick a new
   random cell, up to **100** re-picks. If the last one fails too, the builder **fails**
   (debug text "Sowas. Riesen-Insel und kein Startpunkt."). Otherwise append the cell to list 3
   (start candidates).
   Exact count (C): the cells c0 (first pick) .. c100 (100th re-pick) are tested in turn; the
   first of **c0..c99** that fits is taken. c100 is still picked (two `rand()`) and tested, but
   the builder fails after it **even if it fits** (the loop exits on "fits or 100 re-picks done"
   and then checks only the re-pick counter).
2. For every island with >= 2000 cells, in size order: repeat up to 24 times (a counter running
   200, 195, ... while > 80; the value itself is not used), but stop before a repetition once more
   than 8 candidates were found on this island (counting only this step's candidates): **50
   attempts**, each testing random cells with T(4); a successful attempt appends its cell to list 3.
   Exact count per attempt (C), same pattern as step 1: cells c0..c50 (**51 picks** when all
   fail), the first fitting one of **c0..c49** is taken; c50 is picked and tested but never taken.
3. The first three entries of list 3 (the cells of step 1) are **moved** to list 4 (start
   positions): players get the three largest islands in slot order.
4. Resources, per island with >= 2000 cells (in size order):
   - `F = max(1, size / {850, 700, 550}[r])` forest patches, `S = max(1, size / {700, 600, 350}[r])`
     stone patches.
   - Loop until F **or** S reaches 0 (C, also checked in the disassembly at `0x4919a7`: the loop
     head tests both counters and leaves the island as soon as either is 0). F and S are budgets,
     not guarantees: the island ends with whichever patch kind runs out first, so it can end
     with **no stone patch at all** (e.g. F = S = 2 at r = 0: two forest events before any stone
     event, probability about 1/4), and a forest-poor island likewise. Per iteration: random
     island cell; `k = rand() % (20 - 3r)`:
     - k = 0: if `rand() % 25 == 0`, a bush clump: cluster with bushes `rand() % 3 + 1`, spread 3;
     - k = 1: if `rand() % 25 == 0`, a stone clump: stones `rand() % 3 + 1`, spread 5;
     - k = 2: if `rand() % 25 == 0`, a tree clump: trees `rand() % 3 + 1`, spread 5;
     - k = 3: **forest patch** (no cell test): append the cell to lists 0 and 2; `a = rand() & 3`,
       `b = rand() & 3`, `c = rand()`; cluster with trees `c % 10 + 15 + 8r`, animals `b + 3`,
       bushes `a + 2 + 2r`, spread 2; `F -= 1`;
     - k = 4: if the cell has none of 0x17E, **stone patch**: `a = rand() & 3`, `b = rand() & 1`;
       cluster with trees `b`, stones `a + 2 + 2r`, spread 3; append the cell to list 1; `S -= 1`;
     - otherwise nothing.
5. **Fish** (C, `00490e20`): label the open sea (predicate: tile in class 9, i.e. not the coastal
   ring) with 9.3; for every water body of >= 500 cells, in label order: `N = max(1, size /
   {50, 100, 200}[r])` fish (more fish with *fewer* resources, as coded); repeat until N fish
   exist: random cell of the body; if no object stands there, create fish type `41 + rand() % 5`
   and `N -= 1` (occupied cells are retried without counting). The fish constructor draws no
   further number (behaviour class 15, C `00469d50`).
6. Success.

**What a start island is guaranteed (C, summary).** Nothing beyond: it is one of the three
largest islands, it has at least 2000 land cells, at least four such islands exist, and its start
cell had a free, flat (border range <= 64) 9 x 9 square before any nature was placed. There is no
minimum of stone, wood or food, no per-start resource cluster (the base game's resource sites,
world-populate.md 4, do not run in this branch), and no distance rule between starts. The start
cell is not reserved: forest and stone patches may cover it, and the player placement (10.5) then
takes the first free 6 x 6 square in ring order around it, which can lie on a **neighbouring
island**, even one below 2000 cells that received no resources (islands below 2000 cells only get
objects that spill over from clusters of a nearby big island). Small islands (< 2000) get no
patches at all.

**What this means in numbers** (I, measured with the rebuild's generator and the rules of this
section, 100 seeds per row on 256 maps, 30 on 512; slot 0 = Amazons gets the largest island,
slot 2 = Sajiki the third largest; "stone" = units of stone in stone objects on the island;
"no / at most one stone patch" = share of start islands):

| map, r | slot | median land cells | median stone | no stone patch | at most one | stone < 100 |
|---|---|---|---|---|---|---|
| 256, Wenig | 0 / 1 / 2 | 7757 / 4880 / 3385 | 320 / 192 / 108 | 4 / 7 / 9 % | 4 / 14 / 15 % | 6 / 22 / 46 % |
| 256, Mittel | 0 / 1 / 2 | same | 600 / 390 / 202 | 0 / 3 / 6 % | 0 / 7 / 15 % | 1 / 8 / 17 % |
| 256, Viel | 0 / 1 / 2 | same | 1192 / 760 / 440 | 0 / 1 / 1 % | 0 / 2 / 14 % | 0 / 1 / 10 % |
| 512, Wenig | 0 / 1 / 2 | 35260 / 14882 / 8325 | 1788 / 560 / 416 | 0 | 0 | 0 |
| 512, Viel | 0 / 1 / 2 | same | 5306 / 2064 / 1270 | 0 | 0 | 0 |

The smallest start island seen on 256 maps had 2127 land cells (5th percentile 2617). So on a
256 map (the default "Mittel" size) the third start regularly is an island of 2100..3500 cells
with a handful of stone patches, and about one third start in seven has at most one, even on
"Viel"; this is the original's rule, not a fault of the rebuild. Absent races do not keep their
island: the present players take the starts in slot order, so with two players the second one
gets the second-largest island (C, `004922c0`).

### 10.3 Cluster placer changes (C, `0048ffc0`)

The cluster placer of world-populate.md section 5 is shared, with these differences in `dvge.exe`:

- **No terrain bias, in any mode.** AN.exe doubles the tree/animal/bush weights on lowland and the
  stone weight on hills (AN `00484ba0`, test of flag 0x200); `dvge.exe` compares the raw weights.
  This is a base-game difference (section 12.2).
- AO only: **beach** (flag 0x10000, class-0 tile) is tested late (C): the acceptance draw, the
  0x17E test, all weight draws and the choice of the kind happen as usual, and the chosen count is
  **decremented**; only then, if the cell is beach, nothing is created (no type draw, no object,
  no constructor draws). So a beach hit costs the cluster one object of the chosen kind. (It is
  not a rejection before the weights.) Clusters near the coast therefore end up smaller than
  their counts.
- AO only, object types:
  - animal: `33 + rand() % animalTypes` with **all** class-7 records counted (7 in AO: 33..37,
    39, 40); a result of 38 (rubble) is replaced by 40 (Krabbe). So Hase (37) and Gecko (39) can
    appear; base keeps `33 + rand() % (animalTypes - 1)`. After the type draw the animal's
    constructor draws **two** numbers (world-populate.md 5.1): `rand() % 3` (its wander job,
    `0047de20`) and then `rand() % 40 + 1` (delay of that job).
  - bush: `k = rand() % 6`; k < 4: bush 13 + k; k = 4: Aloe (50); k = 5: Venus (51). Aloe and
    Venus have behaviour class -1 and amount 0 in `Addon.odb` (D): decoration, no food, no
    constructor draw.
  - tree: **palm** `46 + (rand() & 3)` (wood 6, 4, 6, 4; no constructor draw).
  - stone: unchanged (29..32; 14 stone each, type 32: 12).

### 10.4 k < 4 (fallback)

- If the menu size is not "Klein" (128): the builder **fails** (re-roll).
- On 128 maps: if the largest island has <= 2000 cells, fail. Otherwise: one start on the
  largest island with T(7) (retried until it fits, no limit); then two more starts on the same
  island with T(4), each attempt up to 100 tries (else fail), accepted only if its torus distance
  to the first start (and, for the third, to the second) exceeds D. D starts at 300, drops by 5
  after every 50 rejected attempts and resets to 300 after each success; when D falls to 70 or
  less the builder fails ("Zu wenige Punkte gefunden"). Then steps 10.2.3..6 run.
- Exact details (C), only reachable on 128 maps (not offered by the menu, 9.6):
  - Each attempt tests c0, c1, ... and stops at the first fitting cell or after c100. The
    builder fails when the counter shows exactly 100, i.e. when **c100 fits**; when all 101 cells
    fail, the (unfitting) c100 is used as the candidate and goes to the distance test.
  - An accepted second or third start is inserted at the **front** of list 3, so list 3 ends as
    (third, second, first) and step 10.2.3 gives slot 0 the third start and slot 2 the T(7) start.
  - Distances use the torus distance of world-populate.md 2.2 (`0045fa10`).
  - Then 10.2.2 does **not** run (no further candidates); resources (10.2.4) cover every island
    >= 2000 cells, normally only the largest.

### 10.5 After the populator

Player placement is world-populate.md section 9 unchanged (list 4 in slot order, 6 x 6 area
search, computer town halls, human founders).

---

## 11. Front end in `dvge.exe`

Coordinates and widget conventions as in [front-end.md](../ui/front-end.md); only differences are
listed. All screens stay 800 x 600.

### 11.1 Start-up and intro (C, `00493810`, `004935b0`, `00493700`)

- Configuration file `savegames\dv.cfg` (AN: `an.cfg`), same 46-byte layout and defaults
  (front-end.md 4.1). The ini file is `<Windows dir>\DieVölkerGold.ini`; without it the game shows
  "Sie müssen das Hauptprodukt "Die Völker" installiert haben, um das Mission Pack spielen zu
  können." (title "Die Völker Mission Pack").
- Intro: `intro.avi`, then **`intro2.avi`** (the mission-pack intro), both at (0,60), 640 x 420 in
  640 x 480 mode, cursor hidden; then the main menu. If `intro.avi` is missing, `intro2.avi` alone.
  The original keeps searching for `intro2.avi` until it is found (it hangs without it); a rebuild
  should skip a missing video.

### 11.2 Single-player menu (C, `0042ae80`)

| element | rect | action |
|---|---|---|
| title `#185 "Wähle den Spielmodus"` | (230,270)-(565,299) | |
| `#251 "Einführung"` | (230,320)-(565,350) | tutorials |
| `#186 "Kampagnen"` | (230,350)-(565,380) | race selection, base campaigns (parameter 0) |
| `#326 "Addon Kampagnen"` | (230,380)-(565,410) | race selection, add-on campaigns (parameter 0x80) |
| `#187 "Endlosspiel"` | (230,410)-(565,440) | world parameters |
| `#75 "Zurück"` | (340,460)-(460,500) | main menu |

Opening it resets: players 1, resources Viel, development Niedrig, size Mittel, stock Niedrig and
the **AO campaign flag**; the "Addon:" free-play toggle keeps its last value. The main menu itself
is unchanged.

### 11.3 Race selection, mission list, briefing, loading (C)

- **Race selection** (`00432230`): background `RASSENWAHLAO` for add-on campaigns and for free
  play with the add-on toggle on, else `RASSENWAHL`. Clicking a race in the add-on campaign variant
  sets the AO campaign flag and opens the mission list of `<race>AO.mdb`.
- **Mission list** (`0042b180`): background `MISSIONSAUSWAHL` in add-on campaigns (else
  `MAINMENU`); layout unchanged. The visible missions come from a separate progress counter per
  add-on campaign (11.6).
- **Briefing** (`0042b790`), AO records:

  | element | base | AO |
  |---|---|---|
  | background | `BRIEFINGSCREEN` | `BRIEFINGSCREENAO` |
  | title | (230,220)-(565,240) | (230,230)-(565,250) |
  | text box | (220,260)-(580,450) | (220,270)-(570,450) |
  | scroll ring and track | `SCHIEBERING-SOUND0`, (672,258)-(702,454) | `SCHIEBERINGAO`, (661,231)-(722,454) |
  | Amazon / Sajiki / Pimmon portrait | `AMABRIEF` (344,20), `SABRIEF` (511,55), `PIMBRIEF` (138,70) | `AMABRIEFAO` (335,82), `SABRIEFAO` (520,99), `PIMBRIEFAO` (175,86) |

  Buttons (Zurück, Drucken, OK) and the speech file rule are unchanged.
- **Loading screen**: `LOADING_B` for AO missions.
- **Campaign end**: finishing the last add-on mission plays the race's outro video, as in the base
  campaigns.

### 11.4 World parameters (C, `00431a00`, `004316a0`, handler `00431590`)

One new row above the four base rows:

| element | rect | content |
|---|---|---|
| label `#325 "Addon:"` | (230,290)-(470,320), dv14pt brown, L | |
| value button | (490,290)-(570,320), dv14pt black / red, R | `#205 "Nein"` / `#204 "Ja"`; click toggles the AO free-play flag |

Size cycles Klein -> Mittel -> Groß; with the toggle on it wraps to Mittel, and switching the
toggle on while Klein is shown sets Mittel. Switching the toggle rebuilds the whole screen. The
row exists in the single-player and the multiplayer variant. Free play with the toggle on loads
`InfiniteAO.mdb` (record = race) and applies the same stock/development overrides as base free
play.

### 11.5 Multiplayer (C)

- **Start message** (`00432740`, receiver `0045aa51`): 6 bytes `0xFF, 0x01, size bits (u8),
  seed (u16), AO flag (u8)`; clients take size, seed and the add-on toggle from it. (The seed is
  sent as 16 bits; `rand()` seeds fit.)
- **Saving in multiplayer**: the in-game options menu of the **host** shows
  `#71 "Spiel speichern"` at (230,275)-(565,305) (save list as in single player); the other
  entries move: `#68 "Einstellungen"` (230,320)-(565,350), `#70 "Zurück zum Spiel"`
  (230,365)-(565,395), `#69 "Spiel beenden"` (230,410)-(565,430). Clients see no save entry.
- Multiplayer saves use the magic **`GSPM`** instead of `GSVD` and carry a 16-byte player block
  after the header (11.7). A save message also makes every machine write a local copy (save name
  `LOCALSAVEGAME`, file `tmp`, C `0045e770`) *(uncertain: exact purpose and file location)*.
- **Loading in multiplayer**: the session list gains `#67 "Spiel laden"` at (220,400)-(350,440); it
  opens the load list showing only `GSPM` saves. With a save chosen, "Spiel starten" sends the save
  instead of size/seed *(I; the transfer itself belongs to multiplayer.md)*.

### 11.6 Campaign progress (C, `00410f60`, `00410bf0`, `00410db0`)

The config object has seven progress counters: modes 0..3 (stored in `dv.cfg` at offset 17, as
in `an.cfg`) and **three add-on counters** (Amazons, Pimmons, Sajiki). Winning an AO mission
raises the add-on counter; the mission list reads it. The `dv.cfg` reader and writer only handle
the four base counters, so **add-on campaign progress is never saved** and starts at mission 0
in every session (C, by the file layout). A rebuild should store it.

### 11.7 Savegames (C, `0040f3a0`, `0040f5e0`, `0040f720`)

```
char[4] "GSVD" (single player) or "GSPM" (multiplayer)
u32     version  0x6A (106), or 0x0800006A for an AO mission
u32     0
if GSPM: 4 x i32 { players present, -1, last slot without a player, -1 }
u16 name length, name, u32 human race, u32 race group, u32 mode (+5 for AO), u32 mission index,
8 bytes view, world ...
```

Accepted on load: version 0x68 .. 0x0800006A (so base saves of versions 104..106 load). The
lists show only saves of the matching magic. The world part is not specified here.

### 11.8 The "new difficulty level"

The mission pack was advertised with "einen neuen Schwierigkeitsgrad" (Wikipedia). `dvge.exe`
has **no difficulty setting**: no new menu row besides "Addon:", no new strings for it, and the AI
profile weights and think intervals are identical to AN.exe (`0046fcb0` vs AN). The likely
reading is that the add-on campaigns themselves are the harder level *(uncertain)*.

---

## 12. Base game: GOG vs Gold

### 12.1 Data (D)

| file | difference |
|---|---|
| `dv.odb` | only +0xB8 flags: bit 0x80 on the path-wearing units (9, 17, 19, 27, 29..36 of each race, and the Amazon trader 28); 0x40 on the Pimmon and Sajiki traders (Amazon trader 0xC0); town hall and warehouse 0x1 -> 0x11; market 0x1 -> 0x21 (2.5) |
| `Amazons.mdb` | +0xA50 = 0 instead of -1 in all ten records (no effect: both mean "base") |
| `Infinite.mdb` | size bits 7 instead of 9 (ignored: free play takes the size from the menu) |
| `Tutorial1.dvm` | z of 9 nature records (ignored) |
| `mainmenu.gd` | 8 add-on entries added, `EINFUEHRUNG` removed (3.2) |
| race `interface.gd`, `interface.OD` | add-on icons added, ~20 sprites redrawn (3.3) |
| everything else | identical (dv.gd, dv.OD, DV.tdb, Mentor.tdb, dv.wdb, DV.idb, Pimmons/Sajikis/Tutorials.mdb, terrain sets, fonts) |

### 12.2 Code (C)

Method: every AN.exe function cited in `docs/` (about 320 with enough constants) was matched to
its `dvge.exe` counterpart by their constants, and the differing ones were read. Most differences
are **structure offsets** (map object fields moved by 5 bytes for the AO flag and the island grid,
settlement fields by 0x60, player fields by 0x34, savegame state by 0x10, string table and object
table sizes); they change no behaviour. The behavioural differences found:

| area | AN.exe | dvge.exe |
|---|---|---|
| object table width, string table | 62 types, 326 strings | 62 / 68 types, 331 strings |
| invention presets | 30 flags | 33 flags (6) |
| goals | 16 types | 20 types (7.2) |
| map object | base thresholds only | thresholds per mode, AO grid (1.2) |
| cell flags | no 0x8000 / 0x10000 | 0x8000, 0x10000 (8.3) |
| area test (`0044bdb0`) | | can also report 0x4000 (footprint without enough land), used by add-on placement only |
| dvm loader | | terrain block for seed -2, cargo lists (8.2) |
| free-play cluster placer | terrain bias on weights | **no terrain bias** (10.3), also in base free play |
| worn paths | fixed unit-type list, roll for every unit | odb flag 0x80, roll only for flagged units ([units-and-jobs.md](../game/units-and-jobs.md) 4.5) |
| building completion capacity | flag 0x1 | flag 0x10 (same result with the shipped data) |
| foundations | | none for harbour and shipyard (units-and-jobs.md) |
| config / ini | `an.cfg`, `AlienNations_usa.ini` (German: DieVölker.ini) | `dv.cfg`, `DieVölkerGold.ini` |
| intro | `intro.avi` | `intro.avi` + `intro2.avi` |
| menus | | 11.2..11.5 |
| savegame | `GSVD` 104..106 | `GSVD`/`GSPM`, AO version flag (11.7) |
| MP start message | size, seed | size, seed, AO flag |

Unchanged where checked: terrain generator (hills, lakes, tile choice), research rate (0.025, x1.5
library; the same constants and uses), need multiplier 2.2, AI profile weights, free-play stock and
development overrides, mission-end flow, briefing speech rule, CD check.

The GOG `AN.exe` is not simply "Gold without the add-on": Gold also lacks small GOG art (12.1,
3.3). For base-game rules the docs follow AN.exe; where the two differ (cluster bias, worn paths)
a rebuild has to pick one per edition.

---

## 13. Open points

- Drawing of quads that mix class-9 and class-10 corners (8.3).
- Sajiki 8 goal ids and Sajiki 4 win/lose sense (7.3).
- House-porter rule at map load relies on a fresh settlement's satisfaction being >= 80 (8.4).
- Purpose of the multiplayer `LOCALSAVEGAME` copy and the save transfer on "Spiel starten" (11.5).
- Fish record +0x134 = 4 (types 44, 45), and the exact role of transport +0xDC (gameplay spec).
