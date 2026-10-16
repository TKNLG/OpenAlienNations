# `.mdb` mission files

Status: **fully mapped.** Every byte of the 3864-byte record is accounted for, and every place
where the game reads the current mission record has been traced. Reader:
`tools/mdb_dump.py` (`--table <Data dir>` prints the mission table at the end of this page).

Legend used in the tables: **C** = confirmed (the use was seen in the game's code),
**D** = confirmed only by the shipped data (consistent across all files, no code use found),
**I** = inferred (meaning is a best reading, check in game).

All integers are little-endian 32-bit signed. Strings are cp1252 (German), NUL-terminated; the
bytes after the NUL are filler (spaces) and carry no meaning.

## Files and game modes

| mode | file | records | what |
|---|---|---|---|
| 0 | `Amazons.mdb` | 10 | Amazon campaign (human plays race 0) |
| 1 | `Pimmons.mdb` | 10 | Pimmon campaign (race 1) |
| 2 | `Sajikis.mdb` | 10 | Sajiki campaign (race 2) |
| 3 | `Tutorials.mdb` | 5 | tutorials (human plays Pimmons) |
| 4 | `Infinite.mdb` | 4 | free play: records 0..2 = "Erschaffe eine Welt" as Amazons / Pimmons / Sajiki; record 3 = "Multiplayer" |

The mode number is the game's index into its file-name table (C). `Sajiki.mdb` (no "s", 5
placeholder records "Mission0..4" pointing at non-existent `Amazons0..4.dvm`, seed -1) is **not
referenced** by the executable; ignore it (C: only the five names above are in the table).

## Loading and mission order

- Record count = file size / 3864 (C). The loader allocates that many slots and puts each record
  in the slot named by its **index field** (+0x00), not in file order (C). The shipped files are
  stored out of order (e.g. `Pimmons.mdb` holds indices 1,2,3,4,9,6,7,5,8,0), so the index is what
  defines the campaign order. A rebuild should key records by index.
- Starting a campaign mission selects slot `index`; when the mission is won, the game records
  `index + 1` as campaign progress and opens the briefing of slot `index + 1` (C). When that slot
  number reaches the record count the campaign is finished: campaigns 0..2 then play the outro video
  of the player's race (`outro_am.avi` etc.); the tutorials return to the menu (C).
- In free-play mode (4) winning plays the outro of the player's race directly (C).
- Saved games store the mission index (C) and rebuild everything else from the record.

## Record layout (3864 = 0xF18 bytes)

| offset | size | field | | notes |
|---|---|---|---|---|
| 0x000 | 4 | index | C | slot / campaign position, 0-based |
| 0x004 | 64 | title | C | shown as the briefing-screen heading and printed with the briefing |
| 0x044 | 2500 | briefing text | C | shown in the scrolling briefing box; `\r\n` line breaks; ends with "Das Ziel dieser Mission ist es, ..." |
| 0xA08 | 64 | map file | C | `.dvm` name relative to the data folder (e.g. `Pimmon0.dvm`); empty = no map file (free play) |
| 0xA48 | 4 | terrain seed | C | see [terrain-gen.md](terrain-gen.md); -1 = random |
| 0xA4C | 4 | size bits | C | 7, 8, 9 -> 128, 256, 512 cells square |
| 0xA50 | 4 | add-on flag | C | **Gold Edition:** >= 1 = mission-pack ("AO") mission: add-on rules, sprites, inventions, terrain classes and the `...AO` briefing art; < 1 = base mission. All `*AO.mdb` records hold 1; GOG data -1/0, Gold `Amazons.mdb` 0. AN.exe only uses it for the briefing art. See [addon.md](addon.md) 1 |
| 0xA54 | 10 x 20 | goals | C | see "Goals" |
| 0xB1C | 3 x 340 | race blocks | C | block `r` at `0xB1C + r * 0x154` for race r = 0 Amazons, 1 Pimmons, 2 Sajiki |

Briefing speech (C): the game plays `data\sound\mission\<map file name with its extension
replaced by .wav>`, e.g. `Pimmon0.dvm` -> `data\sound\mission\Pimmon0.wav`. If the file is missing
the briefing is silent. (The uploaded GOG data has no `sound\mission` folder; the game only plays the
sound when the file opens.)

Not in the record (C, by exhaustion of all uses): music, player colours, timers and scripted
events. Colours follow the race. Tutorial guidance comes from the mentor (`Mentor.tdb` +
`SOUND/mentor`), not from the mission record.

## Race blocks (340 = 0x154 bytes each)

Offsets are relative to the start of the block. "Good i" is object type i of nature group 6:
0 race raw material (Rohstoff: cocoa / mushrooms / maggots), 1 wood, 2 stone, 3 iron, 4 food,
5 weapons, 6 Schokotörtchen, 7 Pilzschnaps, 8 Zigarillos (names from `dv.odb`).

| offset | size | field | | notes |
|---|---|---|---|---|
| +0x00 | 4 | present | C | race takes part. Controls the race portrait on the briefing; a computer player is only created when this is set |
| +0x04 | 4 | computer | C | 1 = computer-controlled. The human is the present race with 0 here. In free play the menu picks which `Infinite.mdb` record is used, i.e. which race is human |
| +0x08 | 4 | AI profile + 1 | C | computer player's personality = value - 1; value 0 = pick one of profiles 0..2 at random. See "AI profiles" |
| +0x0C | 4 | start gold | C | added to the player's treasury when the player is set up; result clamped at >= 0 |
| +0x10 | 3 x 4 | relation to race 0, 1, 2 | C | diplomatic state, see "Relations". The own-race entry is ignored |
| +0x1C | 9 x 8 | start goods | C | for good i: `+0x1C + 8i` = stock given to the race's **first** town hall, `+0x20 + 8i` = stock for its **second** town hall. Third and later town halls get nothing from here |
| +0x64 | 4 | research level | C | 0 = nothing; n > 0 = every invention whose index is <= n starts researched |
| +0x68 | 3 x 4 | disabled buildings | C | object types (in the race's own group); 0 = empty slot |
| +0x74 | 3 x 4 | disabled units | C | as above; the game treats both lists the same, the split is a convention of the data (D) |
| +0x80 | 30 x 4 | invention pre-researched | C | flag per invention index 0..29 (1 = starts researched) |
| +0xF8 | 92 | unused | D | always zero in base files. **Gold Edition:** +0xF8, +0xFC, +0x100 are the pre-researched flags of inventions 30..32 (`AO.idb`), the loop covers 33 inventions; the rest stays unused ([addon.md](addon.md) 6) |

### How the start goods are applied (C)

- Map town halls: when the `.dvm` loader creates a town hall (building type 40) it founds a new
  settlement for the owning race; if that race now has 1 or 2 settlements, the settlement's nine
  goods counters are set from column 1 or 2 of the table above.
- A town hall built during play: when construction completes and the race had fewer than 2
  settlements, the nine goods are set from column 1; otherwise the new settlement just gets 10 food.
  The founding also spawns one builder (type 11) and two carriers (type 9).
- Free-play menu override (C): before the map is generated the game overwrites, in all three race
  blocks, the start gold and goods 0..5 of column 1 with the chosen "resources" setting: low = 15
  each and 300 gold, medium = 20 and 3000 gold, high = 25 and 10000 gold. A second menu setting
  grants research level 12 or 20 to every player (applied in addition to +0x64).

### Disabled objects and pre-researched inventions (C)

Applied when a race's invention table (`DV.idb`, see [idb-wdb.md](idb-wdb.md)) is loaded for the
mission:

1. If research level n > 0: every invention with index <= n becomes researched.
2. For each non-zero type in the two disabled lists: look up the object's required invention
   (field +0xE4 of its `dv.odb` record). If it has one, that invention is set to "researched" (the
   flag at +0x80 for that index is set). Then the object's required invention is changed to an
   index that does not exist, so the object can never become available in this mission. Net effect:
   the research tree is not blocked, but the object stays unbuildable / untrainable. (The game
   patches its in-memory object table; a rebuild should keep a per-mission "disabled" set instead.)
3. Every invention whose flag at +0x80 is set (from the data or from step 2) is completed
   (progress = cost) and announced to the player's UI.

Typical use: computer opponents get `10` (city founder) disabled so they cannot found new cities;
"destroy building X" missions disable X for the defender so it cannot be rebuilt.

### Relations (C, value names I)

The `.dvm` loader rebuilds the diplomacy table from the race blocks: for every ordered pair
(i, j), i != j, in the order i = 0..2 outer, j = 0..2 inner, the state of the unordered pair
{i, j} is set to `block[i].relation[j]`. The later write wins, so for i < j the effective value is
`block[j].relation[i]`. The shipped data always fills both sides identically. Free-play games
(no map file) do not run this step and start with every pair at 0.

| value | meaning | evidence |
|---|---|---|
| 0 | no relation yet (hostile; no diplomatic contact) | C: units treat 0 and 1 alike as enemies; leaving state 0 enables the embassy (type 42) between the pair |
| 1 | war (Krieg) | C: hostile. Name I from the UI string order |
| 2 | ceasefire (Waffenstillstand) | I: string order; not hostile in combat checks |
| 3 | peace (Frieden) | C: entering 3 enables trade at marketplaces (type 48) between the pair; several checks treat a peaceful race like the own race |

The UI strings (`DV.tdb` 240..242 Krieg / Waffenstillstand / Frieden, 230..232 offers) are
indexed as `229 + state` for states 1..3.

### AI profiles (C for the numbers, I for the labels)

The profile selects one of six strategy routines (0..5). It also sets two threat weights used when
the computer compares its strength with each other player, and its "think" interval:

| profile | weights | think interval | reading |
|---|---|---|---|
| 0 | 1.5, 1.0 | 10 | aggressive (I) |
| 1 | 0.75, 0.3 | 15 | cautious (I) |
| 4 | 0, 0 | 15 | ignores other players (I: peaceful builder) |
| 2, 3, 5 | 1.0, 0.5 | 15 | standard (I) |

The weights are then multiplied by 0.769 for Amazons and 0.667 for Pimmons (Sajiki unchanged), and
the think interval by 1.5 for Amazons and 2 for Pimmons. Field values seen: 0 (random 0..2), 5
(profile 4) and 6 (profile 5). The strategy routines themselves belong to the AI spec.

## Goals (10 slots x 20 bytes at 0xA54)

```
+0  type        0 = empty slot, 1..16 below
+4  defeat      0 = win condition, 1 = loss condition
+8  p1
+12 p2
+16 p3
```

### Evaluation (C)

Single-player only. Every 50 game ticks, for the human player:

1. If the player is dead (has nothing left), the mission is lost.
2. Each non-empty slot is tested. If a **loss** condition is true, the mission is lost at once.
   The mission is won when **every win condition** is true at the same check. (A record with no
   win conditions would be won at the first check; none of the shipped ones does that.)

In multiplayer (no mission goals are checked) the last surviving player wins.

"City n" below is the n-th settlement in the player's settlement list (1-based, founding order).
If that settlement does not exist the condition is false. "Objects of type t" counts everything of
that type in the settlement (units and buildings share the type space of the race's group).
"Finished" means construction state 2 (complete). All types refer to the evaluating player unless
a race is named.

| type | condition | parameters |
|---|---|---|
| 1 | stock of good p1 in city p3 >= p2 | |
| 2 | number of finished objects of type p1 in city p3 >= p2 | |
| 3 | number of finished buildings in city p2 >= p1 | |
| 4 | number of objects of type p1 in city p3 >= p2 | |
| 5 | inhabitants of city p2 >= p1 | |
| 6 | crime rate of city p2 <= p1 (percent) | crime rate = criminals * 100 / inhabitants |
| 7 | satisfaction of city p2 >= p1 | 0..100, see below |
| 8 | open wishes of city p2 <= p1 | |
| 9 | open wishes of city p2 >= p1 | |
| 10 | satisfaction of city p2 <= p1 | |
| 11 | relation between the player and race p1 == p2 | p2 = -1 matches "no entry" |
| 12 | race p1, its city p3 has **no** object of type p2 | the race's group is used for p2; false if that city does not exist |
| 13 | race p1 is eliminated (no player, or player dead) | |
| 14 | stock of good p1 in **the Pimmons'** city p3 >= p2 | hard-wired to race 1 |
| 15 | number of objects of type p1 in city p3 <= p2 | used as a loss condition ("all newspaper girls lost") |
| 16 | player's treasury >= p1 gold | |

**Gold Edition goals 17..20** (`dvge.exe`; evaluated in every mission): 17 = object #p1 within
distance p3 of cell (p2 >> 16, p2 & 0xFFFF); 18 = object #p1 gone, dead or not of type p2; 19 =
own settlements on island p1 own >= p3 objects of type p2; 20 = stock of good p1 in city p3 <= p2.
Object numbers are creation indices. Full spec: [addon.md](addon.md) 7.2.

City statistics used above (C; they belong to the settlement simulation spec, summarised here):

- crime rate = criminals * 100 / inhabitants (integer), criminals = number of type-12 objects
  (Krimineller) in the settlement (C).
- satisfaction = (wish factor + 100 - crime rate + supply) / 3 (integer division), where
  supply = min(100, food stock * 100 / d) with d = inhabitants / 5, but d = 1 when that is below 2,
  and wish factor = 100 / (open wishes + 1). When the result is below 100 a spending bonus is added
  (capped at 100; belongs to the economy spec). Recomputed periodically; a settlement without
  inhabitants or without a finished town hall has crime 0 and satisfaction 100.
- open wishes = size of the settlement's wish set (C): building types the population demands once
  it passes a type-specific size and that the settlement does not have yet (I for the exact rule).

## Mission table (all 35 campaign and tutorial missions)

Generated by `tools/mdb_dump.py --table`. Sorted by file, then by index (= play order). "human"
is the present non-computer race; "computer" lists the computer races with their AI profile field
(p0 = random). Object types are named from the human's race group, except in type-12 goals.
Size is the map edge in cells.

| file | idx | title | map | seed | size | human | computer | goals |
|---|---|---|---|---|---|---|---|---|
| Tutorials.mdb | 0 | Einführung in die Steuerung | Tutorial0.dvm | 3813 | 128 | Pimmons | - | win: city 1: stock of stone >= 15; win: city 1: stock of food >= 15; win: city 1: >= 2 finished 37 (Wohngebäude) |
| Tutorials.mdb | 1 | Einführung in die Forschung | Tutorial1.dvm | 9450 | 128 | Pimmons | - | win: city 1: >= 2 finished 60 (Spähturm); win: city 1: >= 2 x 19 (Holzfäller); win: city 1: >= 2 x 17 (Jäger); win: city 1: stock of stone >= 15; win: city 1: stock of wood >= 15; win: city 1: stock of food >= 20 |
| Tutorials.mdb | 2 | Motivation und Kriminaliät | Tutorial2.dvm | 6745 | 128 | Pimmons | - | win: city 1: >= 25 inhabitants; win: city 1: crime rate <= 0%; win: city 1: satisfaction >= 100; win: city 1: open wishes <= 0 |
| Tutorials.mdb | 3 | Diplomatie und Handel | Tutorial3.dvm | 20228 | 256 | Pimmons | Amazons (p5) | win: relation to Amazons == peace; win: city 2: stock of food >= 10 |
| Tutorials.mdb | 4 | Rüstung und Kriegswesen | Tutorial4.dvm | 1 | 256 | Pimmons | Sajiki (p0) | win: Sajiki city 1: no 46 (Labor) left |
| Amazons.mdb | 0 | Ein neues Land | Amazon0.dvm | 16092 | 256 | Amazons | - | win: city 2: >= 2 finished 60 (Spähturm) |
| Amazons.mdb | 1 | Der heilige Baum | Amazon6.dvm | 26738 | 128 | Amazons | - | win: city 1: stock of wood >= 3 |
| Amazons.mdb | 2 | Der Geburtstag | Amazon9.dvm | 32043 | 128 | Amazons | - | win: city 1: stock of chocolate cakes >= 10 |
| Amazons.mdb | 3 | Der erste Kontakt | Amazon1.dvm | 4606 | 256 | Amazons | Pimmons (p5) | win: city 1: stock of mushroom schnapps >= 5; win: Pimmons city 1: stock of chocolate cakes >= 5 |
| Amazons.mdb | 4 | Das Manöver | Amazon5.dvm | 26738 | 128 | Amazons | Pimmons (p6) | win: Pimmons city 1: no 40 (Rathaus) left |
| Amazons.mdb | 5 | Die Karawane | Amazon2.dvm | 16075 | 256 | Amazons | Sajiki (p4) | win: city 2: >= 1 finished 48 (Marktplatz); win: city 2: stock of food >= 5; DEFEAT if Amazons city 1: no 40 (Rathaus) left; DEFEAT if Amazons city 2: no 40 (Rathaus) left |
| Amazons.mdb | 6 | Schlacht im Morgengrauen | Amazon8.dvm | 6640 | 128 | Amazons | Sajiki (p6) | win: Sajiki eliminated |
| Amazons.mdb | 7 | Das magische Kreuz | Amazon7.dvm | 7773 | 256 | Amazons | Pimmons (p0) | win: city 1: stock of raw (cocoa/mushroom/maggot) >= 1 |
| Amazons.mdb | 8 | Eine gute Nachricht | Amazon3.dvm | 21553 | 512 | Amazons | Sajiki (p0) | win: city 1: >= 1 finished 51 (Zeitungsstand); DEFEAT if city 1: <= 0 x 20 (Zeitungsmädchen) |
| Amazons.mdb | 9 | Die Ankunft der Schatten | Amazon4.dvm | 3450 | 256 | Amazons | Sajiki (p6) | win: Sajiki eliminated |
| Pimmons.mdb | 0 | Die Taverne | Pimmon9.dvm | 1855 | 128 | Pimmons | - | win: city 1: >= 1 finished 58 (Wirtshaus) |
| Pimmons.mdb | 1 | Ohne Moos nichts los | Pimmon0.dvm | 11584 | 128 | Pimmons | - | win: treasury >= 3000 gold; win: city 1: >= 25 inhabitants |
| Pimmons.mdb | 2 | Die Hasenplage | Pimmon1.dvm | 11803 | 128 | Pimmons | - | win: city 1: stock of food >= 100 |
| Pimmons.mdb | 3 | Neuland Gewinnung | Pimmon2.dvm | 19226 | 256 | Pimmons | Amazons (p0), Sajiki (p6) | win: city 1: >= 3 finished 52 (Kl. Außenposten) |
| Pimmons.mdb | 4 | Bargeld lacht | Pimmon3.dvm | 12586 | 256 | Pimmons | Amazons (p0), Sajiki (p4) | win: treasury >= 5000 gold; win: city 1: >= 1 finished 49 (Bank) |
| Pimmons.mdb | 5 | Die zwei Türme | Pimmon7.dvm | 14410 | 128 | Pimmons | Sajiki (p0) | win: Sajiki city 1: no 52 (Kl. Außenposten) left |
| Pimmons.mdb | 6 | Das Wachstum | Pimmon5.dvm | 21831 | 128 | Pimmons | Amazons (p5), Sajiki (p5) | win: city 1: >= 50 inhabitants; win: city 1: satisfaction >= 100 |
| Pimmons.mdb | 7 | Das Trainingslager | Pimmon6.dvm | 2038 | 128 | Pimmons | Amazons (p5) | win: Amazons city 1: no 39 (Kaserne) left |
| Pimmons.mdb | 8 | Gute Nachbarschaft | Pimmon8.dvm | 12706 | 256 | Pimmons | Amazons (p5), Sajiki (p0) | win: Sajiki city 1: no 53 (Gr. Außenposten) left; DEFEAT if Amazons eliminated |
| Pimmons.mdb | 9 | Das böse Ende? | Pimmon4.dvm | 13951 | 256 | Pimmons | Sajiki (p6) | win: Sajiki eliminated |
| Sajikis.mdb | 0 | Die Trockenperiode | Sajiki0.dvm | 20936 | 128 | Sajiki | - | win: city 1: stock of food >= 100 |
| Sajikis.mdb | 1 | Der erste Krieger | Sajiki9.dvm | 24343 | 128 | Sajiki | - | win: city 1: >= 1 x 29 (Pyro) |
| Sajikis.mdb | 2 | Verhaßter Friede | Sajiki2.dvm | 32552 | 256 | Sajiki | Amazons (p5), Pimmons (p5) | win: Amazons city 1: no 42 (Botschaft) left; win: Pimmons city 1: no 42 (Botschaft) left |
| Sajikis.mdb | 3 | Viel Rauch um nichts | Sajiki6.dvm | 6082 | 128 | Sajiki | - | win: city 1: stock of cigarillos >= 20; win: city 1: >= 1 finished 58 (Orgiengrube) |
| Sajikis.mdb | 4 | Geheimnisvoller Wald | Sajiki8.dvm | 18864 | 256 | Sajiki | Amazons (p5) | win: Amazons city 1: no 59 (Tempel) left |
| Sajikis.mdb | 5 | Sabotage | Sajiki3.dvm | 9234 | 256 | Sajiki | Amazons (p0) | win: Amazons city 1: no 50 (Mine) left |
| Sajikis.mdb | 6 | Die Bergfestung | Sajiki1.dvm | 21821 | 128 | Sajiki | Pimmons (p0) | win: Pimmons eliminated |
| Sajikis.mdb | 7 | Das Erbe | Sajiki7.dvm | 18845 | 256 | Sajiki | Amazons (p0), Pimmons (p0) | win: city 1: open wishes <= 0; win: city 1: satisfaction >= 100 |
| Sajikis.mdb | 8 | Das Monopol | Sajiki5.dvm | 27647 | 256 | Sajiki | Amazons (p0), Pimmons (p0) | win: city 1: >= 5 finished 50 (Mine) |
| Sajikis.mdb | 9 | Der perfekte Bau | Sajiki4.dvm | 13819 | 256 | Sajiki | Amazons (p6), Pimmons (p6) | win: Amazons eliminated; win: Pimmons eliminated |

### Per-race setup highlights

From `tools/mdb_dump.py <file> --brief --odb dv.odb` (only non-default entries):

- Start gold is 300 in most early missions, up to 5000/10000 in late or military ones; start goods
  are 12 wood / 12 stone / 12 food (20 or 25 in later missions).
- Relations are only set in Pimmons 4 "Bargeld lacht" (Amazons-Pimmons ceasefire) and Pimmons 8
  "Gute Nachbarschaft" (Amazons-Pimmons peace, both at war with the Sajiki).
- Disabled objects, for example: Tutorial 0 disables the laboratory (46), city founder (10) and
  scholar (23); Amazons 7 disables the human's own cocoa plantation (45) and planter (14); Sajiki 2
  disables both opponents' embassies (42), which are also the targets.
- Pre-researched inventions via the +0x80 flags appear only in Tutorial 3 (Pimmons: 5, 7, 8, 10);
  everything else uses the research level.

## Open questions

- ~~0xA50 alternative briefing layout ("AO" art): no shipped record uses it.~~ Resolved: it is the
  Gold Edition's add-on flag ([addon.md](addon.md) 1.1).
- Labels of the AI profiles and of relation state 2 are inferred.
- Goal 12 assumes the named race exists; with an absent race the original reads a null player
  (would crash). A rebuild should treat it as true.
