# Alien Nations / Die Völker: game rules spec (from the handbook)

Status: derived from the English GOG handbook, cross-checked against the shipped data files.
Written as an implementation spec in our own words; nothing here is quoted from the handbook
except short UI labels.

## 0. Sources and conventions

| source | what it gave |
|---|---|
| `ref/manual-gog.txt` (English handbook, 48 pages) | all rules below unless marked otherwise |
| `Data/dv.odb` | German object names per race, plus fields that confirm handbook numbers (section 19) |
| `Data/DV.tdb` | German UI labels (cited as `tdb#id`) |
| `Data/Mentor.tdb` | advisor messages (cited as `mentor#id`) |
| `Data/{AMAZONS,PIMONS,SAJIKI}/DV.idb` | per-race invention list: names, prerequisites, a cost value (section 9.3) |
| `Data/dv.wdb` | weapon/projectile names (KampfBogen, Schwert, Feuerkugel, Heilen, ...) |
| `ReadMe.txt` (GOG, "V5.0") | no rule changes; only adds a "scroll optimization" graphics option (tdb#318 `Hardwarescrolling`) |

- **Page numbers** `(p. N)` are the PDF page index, which equals the number printed at the foot of
  each page in the GOG edition. The handbook's own table of contents is offset by +2 (it lists the
  original print layout: "Finances 29" is on p. 27 here).
- **Object ids** are written `group:type` (see `docs/formats/od-odb.md`). Races: group 0 Amazons,
  1 Pimmons, 2 Sajiki; group 6 nature and goods. `R:t` means "type t in each race group 0..2";
  the same type number has the same role in all three races.
- "Round" is the handbook's unit of economic time (tax, upkeep, food, research are "per round").
  Its real-time length is not stated (see open questions).
- The handbook's tutorial uses the Pimmons, so examples name Pimmon things (mushrooms, distillery).

---

## 1. Game structure

### 1.1 Main menu (p. 10)
Single player, multiplayer, load game, settings, quit (tdb#65..69).

### 1.2 Single player modes (p. 11, tdb#185..187, #251)
| mode | German | rules |
|---|---|---|
| Introduction / tutorials | `Einführung` | 5 tutorial missions, played in order (p. 11). Maps `Tutorial0..4.dvm`. First three tutorials have no other nation (p. 19). Tutorial 1 ("control"), tutorial 2 ("research") are described (p. 15-16, p. 32). |
| Campaigns | `Kampagnen` | 10 missions per nation, increasing difficulty, must be won in order; choose nation then mission (p. 11). Maps `Amazon0..9`, `Pimmon0..9`, `Sajiki0..9`. Pimmon missions are mostly peaceful, Amazon missions expansion/military, Sajiki missions warlike (p. 11). |
| Continuous game | `Endlosspiel` | free game on a generated world; difficulty comes from world parameters (p. 11). |

Mission flow: briefing screen with Back / Print / OK (p. 16, tdb#282 `Drucken`); objectives can be
re-read from the options menu ("Mission objectives", tdb#243 `Auftrag lesen`) (p. 16, p. 22).
Win/lose messages tdb#218/#219. Restart mission is available in options (p. 23, tdb#317).

Tutorial 1 objectives (useful as a first integration test, p. 16): build 2 buildings (houses),
build a school, collect 15 food from bushes, quarry 15 rock with stonemasons.

### 1.3 World parameters (single player continuous game and multiplayer) (p. 11-12, tdb#293..304)
| parameter | German label | values (tdb) | effect stated |
|---|---|---|---|
| Size of world | `Weltgröße` | Klein / Mittel / Groß | smaller = less room, earlier conflict |
| Quantity of resources | `Anzahl Rohstoffe` | Wenig / Mittel / Viel | fewer = longer trips for porters, hunters, gatherers |
| Stage of development | `Entwicklungsstufe` | Niedrig / Mittel / Hoch | lower = fewer inventions known at start |
| Level of supplies | `Lagerstand` | Niedrig / Mittel / Hoch (assumed same set) | lower = smaller starting stock |

### 1.4 Multiplayer (p. 10, 12-13, 41)
- Up to 3 players (you + 2) (p. 10). Each nation can be picked by only one player (p. 12), so a
  match is at most Amazons + Pimmons + Sajiki.
- Transports: serial (null modem), IPX, TCP/IP (p. 12; tdb#125..127).
- Flow: enter name -> choose transport -> one player hosts ("New": player count, session name,
  world parameters) -> others "Search" and join -> each picks a nation -> lobby chat -> host
  presses "Start game" (p. 12-13). Game starts when the slowest machine has loaded (p. 13).
- Host-authoritative: the server does more computation; if the host quits, the session ends for
  everyone (p. 41; tdb#195 "server ended the session").
- In-game chat: F1 Amazons, F2 Pimmons, F3 Sajiki, F4 all (p. 45). Any player can pause
  (tdb#199).

### 1.5 Saving (p. 13, 22)
- Named saves via options menu; two reserved slots the player cannot name: autosave and quicksave
  (tdb#313 `.Automatische Speicherung.`, #314 `.Schnellspeicherung.`).
- Autosave interval set in settings: Off / 10 / 20 / 30 min (tdb#283..286) (p. 15: "every couple
  of minutes").
- F12 = quicksave without opening a menu (p. 13, 44).
- "Load game" in the main menu is for single-player saves (p. 10).

### 1.6 Settings (p. 13-15, tdb#78..90, #287..292, #318)
Graphics: hardware acceleration (affects zoom speed mostly), alpha shadows on/off, resolution
800x600 or 1024x768, hardware scrolling. Sound: master, effects, music, speech (mentor voice),
EAX. Controls: edge scrolling in the menu area on/off, autosave interval.

---

## 2. Controls and UI

### 2.1 Mouse model (p. 15, 24-25)
- Left click selects (units, buildings, plants, trees, rocks, animals). Left click on empty ground
  deselects and returns the side menu to the basic panels.
- Right click on a target = move or assign a job (porter -> bush = pick fruit; hunter -> animal =
  hunt; stonemason -> rock = quarry; specialist -> school = retrain; unit -> house in another town
  = resettle).
- Right click on empty ground cancels the unit's current job (needed before it will help on other
  work) (p. 24-25).
- "Function" clicks (e.g. patrol target) use the LEFT button (p. 39).
- Drag a frame with the left button = group selection (p. 39).
- Units hidden behind buildings/trees are still clickable (p. 41).
- Right click on the minimap sends selected units there (p. 43).
- The cursor shape reflects the selected unit/mode (sword for combat units, patrol icon) (p. 42).
  Exact rules from the executable: [../ui/cursors.md](../ui/cursors.md).
- Every clickable menu symbol highlights on hover and shows a help line at the bottom right of the
  play field (p. 18, 22).

### 2.2 Camera (p. 18, 20, 44)
- Edge scrolling, including diagonals at corners; arrow keys scroll.
- Continuous ("infinite") zoom: mouse wheel, the zoom ring slider in the side menu, numpad +/-,
  PageUp = minimum zoom, PageDown = maximum zoom. Everything stays selectable at every zoom level.

### 2.3 Side menu (right edge), top to bottom (p. 18-22)
1. **Main map (minimap)**: whole world. Black = unexplored; darkened = seen before but not
   currently observed (no live enemy units shown) (p. 18). Four toggles (p. 19, tdb#41,#60..62):
   buildings, units (all nations), resources (trees, rocks, bushes, animals), town areas.
   Nation colours: Pimmons blue, Amazons red, Sajiki yellow (buildings, units, borders) (p. 19).
   Town areas are also drawn on the terrain in nation colour with border stones (p. 19).
2. **Options** (disk icon; ESC also opens it and pauses) (p. 20, 45).
3. **Zoom ring** (p. 20).
4. **List of towns**: own towns; selected town in yellow; left click selects the town, right click
   selects and centres on its town hall (p. 20). Town names come from a fixed per-race pool of 10
   (tdb#142..151 Amazons, #152..161 Pimmons, #162..171 Sajiki); new town name prompt tdb#180;
   a maximum town count exists (tdb#172/#202).
5. **Money** next to the money chest: the national treasury; all income goes in, all costs come
   out (p. 21).
6. **Function bar** (p. 21). With nothing selected it shows the basic panels:
   Construction (`Gebäudebau`), Buildings (`Gebäude`), Town dwellers (`Stadtbewohner`),
   Finances (`Finanzen`), Needs (`Bedürfnisse`), Raw materials (`Rohstofflager`).
   Construction is always available, even with something selected (p. 23, 25).
7. Below: quick stock of wood, rock, iron, then the buildable list (p. 21). Each entry shows
   required materials on the right; entries that cannot be afforded are drawn red with the
   missing material's icon red (p. 30). A red arrow scrolls the list one line per click
   (p. 22). Locked entries: tdb#131 `Noch nicht erforscht!`; one-per-town: tdb#132.

### 2.4 Basic panels (nothing selected)
| panel | content | page |
|---|---|---|
| Buildings | count of buildings and of building sites (tdb#42/#43), list of buildings; right click = centre, left click = centre + select | p. 26 |
| Town dwellers | total residents and free porters (tdb#40, #307 `Freie Träger:`), list grouped by profession with count badge; repeated right click on a profession icon cycles the camera through those units | p. 26-27, 41 |
| Finances | income, motivation bonus, research funds, overheads, balance (tdb#12..16); sliders under "Investments" (tdb#128) | p. 27 |
| Needs | crime level, population growth, average building condition, food consumption and production per round, other needs (tdb#206..217, #28, #193, #35) | p. 28-29 |
| Raw materials | storage capacity per type (tdb#130 `Lagerkapazität: %d / Typ`), stock per good, conversion ring for the race's farm crop (section 7.2) | p. 29-30 |

### 2.5 Unit panel (p. 23-24)
- Hit points `cur/max` (porter 50/50; only priests heal).
- Profession and home town.
- Command row (examples: `Nach Hause` = walk to own town hall from anywhere; `Patrouillieren`
  for combat units; `Stadt gründen` for the founder; diplomat recall).
- Activity line (status strings tdb#262..281, e.g. "collects X", "carries X to Y", "hunts
  criminal", "flees from X", "no task") and destination.
- Carried goods; trash icon (tdb#140 `Rohstoff wegwerfen`) discards the load permanently.

### 2.6 Building panel (p. 30, 32-38)
Common tabs: Construction, Information (overheads when operating, required operator
profession), occupants (`Im Gebäude`, tdb#38; the English handbook mislabels it "Under
Construction") with per-person "send out" (tdb#249). The founder cannot leave the town hall.
Type-specific tabs: Training (school, barracks...), Research + History (lab), Production
(producers), Sale / Purchase (market), Trade route (on the merchant), Diplomacy (embassy).
Further commands from tdb: stop operation (#311), demolish (#8), repair (#4), pause/resume
construction (#191/#192).

### 2.7 Groups (p. 39-40)
- Frame selection; a group holds at most **12** units (p. 39).
- In the group window: left click a member = select only it; right click = remove it (p. 39).
- Shift+Ctrl+click on a unit in the world adds it to the group (p. 39).
- Up to **10** stored groups: Ctrl+1..0 stores, 1..0 recalls, pressing the same digit again
  centres the camera on that group (p. 40, 44-45).

### 2.8 Keyboard (p. 13, 39-40, 44-45)
| key | action |
|---|---|
| F12 | quicksave |
| Numpad + | zoom out (as printed) |
| Numpad - | zoom in (as printed) |
| Arrow keys | scroll |
| PageUp | minimum zoom |
| PageDown | maximum zoom |
| Ctrl+1..Ctrl+0 | store selection as group 1..10 |
| 1..0 | select group; again = centre on it |
| F1 / F2 / F3 / F4 | MP chat to Amazons / Pimmons / Sajiki / all |
| ESC | options menu / pause; also skips the intro |
| Ctrl (held) during patrol | add patrol waypoints |
| Shift+Ctrl+click | add unit to current group |

---

## 3. Economy

### 3.1 Goods
| good | German | id | notes |
|---|---|---|---|
| wood | Holz | 6:1 | building material; distillery fuel |
| rock / stone | Stein | 6:2 | building material; recoverable from rubble |
| iron | Eisen | 6:3 | from the mine; advanced buildings, weapons |
| food | Nahrung | 6:4 | fruit, game, converted crops |
| arms / weapons | Waffen | 6:5 | needed to train combat units (p. 38) |
| chocolate cakes (Amazon luxury) | Schokotörtchen | 6:6 | |
| mushroom brandy (Pimmon luxury) | Pilzschnaps (odb spells `Plizschnaps`) | 6:7 | |
| cigarillos / smoked maggots (Sajiki luxury) | Zigarillos ("Rauchmaden" in idb text) | 6:8 | |
| cocoa / mushrooms / maggots (farm crops) | Kakao / Pilze / Maden | stock id unknown | stored crop, convertible to food (tdb#220..225) |
| rubble | Schutt | 6:38 | left by demolished buildings |

Generic raw-material placeholder: `Rohstoff` 6:0.

### 3.2 Storage (p. 29, 41)
- Each town has a per-good cap; the tutorial start is **25 per good type** (p. 29).
- Each warehouse adds **+25** to the per-type cap (p. 29).
- All warehouses (and the town hall) of a town form one pooled stock: any porter can take any good
  from any store, and every store can issue all goods at once (p. 41).
- Producers' output is hauled to the nearest warehouse (p. 38). Gatherers bring goods to the town
  hall (p. 15, 24, 31).
- Full stores raise mentor#17.

### 3.3 Porters and transport (p. 25-26, 31, 38, 42)
- Porters are the base unit: born in houses, trained into professions at school, and the whole
  transport system (p. 31).
- A porter carries **1 unit** per trip for construction deliveries (each trip took one unit from
  stock, p. 26).
- Porters work automatically: supply building sites, fetch trainees' places, deliver inputs to
  producers and collect their output (p. 31, 38).
- **Priority**: construction and training requests beat production supply (p. 38). Keep spare
  porters beyond those on building sites.
- A porter given an explicit job (e.g. picking fruit) keeps it and ignores automatic work until
  sent to empty ground (p. 24-25).
- Workaround for few porters: send gatherers (woodcutter, stonemason) with their load straight to a
  building site; they will not return to work by themselves (p. 42).

### 3.4 Money (p. 21, 27, 29)
- Treasury is national (shared by all towns); budgets are shown per town.
- **Tax: 7 coins per resident per round** (p. 27). Criminals and homeless pay nothing (p. 34, 42).
- Expenses per round: motivation bonus, research funds, overheads (p. 27).
- Overheads = sum of building upkeep; a building that needs an operator costs upkeep only while
  operating (p. 32, 33).
- Constraint: motivation + research spending may not exceed tax income; overheads may be paid from
  savings (p. 27).
- Worked example (p. 27): town hall + school, 4 residents -> income 28, overheads 12, net +16
  per round. (Matches dv.odb: town hall upkeep 7, school 5; see section 19.)
- Out of money: mentor#18; buildings can no longer be maintained and decay (mentor#72).

### 3.5 Building condition and repair (p. 28)
- Buildings have hit points like units. They lose condition from combat and from missing upkeep.
- A builder repairs damage; repair costs money. Town "Needs" shows the average condition
  (tdb#212..214: well kept / starting to decay / decaying).
- Low motivation also makes towns decay (mentor#71).

---

## 4. Inhabitants

### 4.1 Population growth (p. 28, 30)
- Residents come from housing: a new house spawns residents (small house: **3** new residents,
  p. 30), who are porters.
- More living space -> population grows; unhappiness slows growth (p. 28). Growth states
  (tdb#209..211): grows and prospers / grows slower / grows very slowly.

### 4.2 Happiness / motivation (p. 28-29, tdb#29..34)
- Six motivation states: fine / not fine / uncomfortable / not motivated / bad / rebelling.
- Causes of unhappiness: unmet needs (food, entertainment buildings, luxury goods), see 4.3.
- **Motivation bonus** (money per round) reduces unhappiness a little but does not satisfy needs
  (p. 29).
- Effects of unhappiness: slower growth (p. 28), more crime (p. 28, 34), town decay (mentor#71).
- Newspapers make residents more motivated and keep morale in war (idb text for Zeitung).

### 4.3 Needs (p. 28-29, mentor#29..41, idb texts)
Needs appear as population grows ("from a certain number of inhabitants"):
| need | Amazons | Pimmons | Sajiki |
|---|---|---|---|
| food | Nahrung | Nahrung | Nahrung |
| entertainment (first) | Kriegertafel | Wirtshaus (tavern) | Orgiengrube |
| news | Zeitungsstand | Zeitungsstand | Infohöhle |
| police | Polizei | Polizei | Polizei |
| culture (large towns) | Theater | Zirkus | Kampfarena |
| temple (large towns) | Tempel | Tempel | Tempel |
| luxury good | Schokotörtchen | Pilzschnaps | Zigarillos |
Satisfied state: tdb#36 `Keine Wünsche offen`.

### 4.4 Homeless (p. 42)
Residents of a destroyed/demolished inhabited house, or refugees from a destroyed town who flee to
another town, become homeless: they eat and work but pay no tax until new housing exists.

### 4.5 Resettling (p. 43)
Send residents manually (right click) to houses in another town.

### 4.6 Retraining rules (p. 31)
- Any specialist can be sent to school to learn another profession; the old one is lost.
- Anyone can be retrained back to porter, but only manually: higher professions never go to school
  on their own.
- Porters go to school automatically when a training slot is ordered.

---

## 5. Buildings

### 5.1 Construction process (p. 25-26, 30)
1. Pick a building in the construction list (always available). It follows the cursor.
2. Footprint is green where legal, red where not. Illegal: not enough space, a unit stands there,
   slope too steep (no building on mountainsides) (p. 25). Exception: the mine must be on
   mountains and may be outside the town area (tdb#315).
3. Left click places a building site. The master builder walks to it; **two porters** start
   carrying materials from the store (p. 25); construction starts when the first materials arrive.
4. Materials are deducted unit by unit as porters pick them up (p. 26).
5. Without a master builder nothing gets built (mentor#9). Building complete: mentor#1.
- Example cost: Pimmon school = **2 wood + 4 rock** (p. 26).
- Unaffordable entries are drawn red with the missing material marked (p. 30).

### 5.2 Operators (p. 32-33, 38)
- Many buildings work only with an operator of a specific profession (shown in Information);
  e.g. lab needs a scientist (p. 32). A freshly trained matching specialist walks there by itself.
- Without operator the building's function buttons are disabled; upkeep is charged only while
  operating (p. 32-33).
- "Stop operation" or removing the operator stops it; after a manual removal no one refills the
  slot automatically (p. 33).
- Messages: started/stopped operation (mentor#10/#11), missing operator (mentor#12).

### 5.3 Demolition and rubble (p. 42)
Demolishing leaves rubble (`Schutt`, 6:38); collecting it returns the **rock**, the **wood is
lost**. Demolishing inhabited houses creates homeless.

### 5.4 Limits
- One research lab per town (p. 33; tdb#132 generic "once per town").
- Embassy closure breaks all diplomatic ties (p. 37).

### 5.5 Building roles (same type number = same role; names per race in section 18)
| type | role (Pimmon name) | statements | operator (dv.odb +0xD8) |
|---|---|---|---|
| 37 | house (Wohngebäude) | spawns 3 residents (p. 30) | - |
| 38 | large house | more, cheaper housing (idb) | - |
| 39 | barracks (Kaserne) | trains combat units like a school; extra costs wood, weapons (p. 38) | - |
| 40 | town hall (Rathaus) | town centre; gatherers deliver here; founder lives inside as mayor (p. 26) | founder (10) |
| 41 | warehouse (Lagerhaus) | +25 per good type (p. 29) | - |
| 42 | embassy (Botschaft) | diplomacy; houses the diplomat (p. 36) | diplomat (13) |
| 43 | creature/ordnance yard (Dressurfarm; Amazon Geschützfabrik, Sajiki Zuchtstall) | trains special combat units; handbook mentions "ordnance factory", "horse farm" (p. 38) | - |
| 44 | luxury producer (Schnapsbrennerei) | 2 mushrooms + 1 wood -> 1 brandy (p. 38) | type 16 |
| 45 | farm (Pilzfarm) | grows the race crop (p. 29, 33) | type 14 |
| 46 | research lab (Labor) | research; one per town (p. 32-33) | scholar (23) |
| 47 | library (Bibliothek) | speeds up research (idb) | scholar (23) |
| 48 | market place (Marktplatz) | trade (p. 34-36) | - (merchant is mobile) |
| 49 | bank | makes trade more lucrative (idb) | scholar (23) |
| 50 | mine | produces iron (p. 9, 38); mountains only (tdb#315) | stonemason/miner (27) |
| 51 | newspaper stand | motivation (idb) | type 20 |
| 52 | small outpost | enlarges town area; an archer can defend from it (idb) | - |
| 53 | large outpost | taller, wider defence radius (idb) | - |
| 54 | police station | auto-hunts criminals; jail (p. 34) | police (21) |
| 55 | school (Schule) | trains professions (p. 30) | - |
| 56 | magic building (Magierturm; Amazon Alchemistenhütte, Sajiki Kultstätte) | trains magic units (magicians, alchemists, p. 39) | - |
| 57 | culture (Zirkus) | need in large towns (idb, mentor) | type 15 |
| 58 | entertainment (Wirtshaus) | first entertainment need (p. 29) | type 18 |
| 59 | temple | trains priests; priests heal (p. 40) | priest (22) |
| 60 | watchtower (Spähturm) | permanent vision of a large area (idb) | scout (24) |
| 61 | armoury (Waffenschmiede) | produces weapons (p. 38) | weaponsmith (25) |

---

## 6. Units

### 6.1 Professions (types 9..28)
"school" in the third column is assumed unless a page is given; the handbook only confirms school
for the stonemason and scientist (p. 30, 32), temple for the priest (p. 40). Costs are from
section 19.
| type | role | trained at | stated behaviour |
|---|---|---|---|
| 9 | porter | born in houses | transport, fruit picking (p. 15, 31) |
| 10 | town founder | school (odb cost 100) | sits in town hall as mayor; founds new towns (tdb#6) (p. 26) |
| 11 | master builder | school | builds and repairs (p. 18, 25, 28) |
| 12 | criminal | arises from population | eats, occupies housing, no tax, attacks porters (p. 34) |
| 13 | diplomat / ambassador | school | lives in embassy, carries offers (p. 36-37) |
| 14 | farmer | school | runs the farm (p. 33) |
| 15 | entertainer (actress / tamer / gladiator) | school | runs culture building |
| 16 | luxury producer (baker / distiller / maggot roller) | school | runs type 44 |
| 17 | hunter | school | hunts game (food straight to town hall); never hunts unless sent once; usable as reserve fighter (p. 33, 38, 43) |
| 18 | innkeeper | school | runs type 58 |
| 19 | woodcutter | school | fells trees -> wood |
| 20 | news vendor | school | runs type 51 |
| 21 | policeman | school (needs Writing + Law) | chases criminals; can fight (p. 34, 38) |
| 22 | priest | temple (p. 40) | heals units; runs temple |
| 23 | scholar / scientist | school | runs lab, library, bank (p. 32) |
| 24 | scout | school | exploring; runs watchtower (p. 43) |
| 25 | weaponsmith | school | runs armoury |
| 26 | saboteur | school | sneaks into enemy towns and damages buildings (idb) |
| 27 | stonemason (Amazon: Bergfrau) | school, cost **40** (p. 30) | quarries rock; runs mine (odb) |
| 28 | merchant | school | runs trade routes, carries max 5 items (p. 35) |

### 6.2 Combat units (types 29..36, see section 18 for per-race names)
- Trained at barracks (39), creature/ordnance yard (43) or magic building (56). They cost extra
  materials (wood, weapons) on top of training (p. 38).
- Ranged (archers...) vs melee (sword fighters...). Small ranged units make good outposts;
  cannons are too big for outposts (p. 38-39). Magicians/alchemists are combat units (p. 39).
- Hunters and policemen can fight but are weaker than soldiers (p. 38).
- Only combat units can patrol (p. 40).

### 6.3 Automation summary (p. 31, 33, 43)
- Porters: fully automatic. Trained specialists with a building go to it automatically.
- Gatherers keep the task they were given until it is exhausted or reassigned.
- Hunters: only after being sent once.
- Workers' pathing is "not always ideal" by design.

---

## 7. Production chains

### 7.1 Gathering
| source | worker | product | delivered to | page |
|---|---|---|---|---|
| fruit bush (Busch 6:13..16) | porter | food | town hall | p. 15, 24 |
| wild animals (6:33..37) | hunter | food | town hall/camp directly | p. 33 |
| trees (6:9..12) | woodcutter | wood | town hall | p. 42 |
| rocks (6:29..32) | stonemason | rock | town hall, then porters to sites | p. 31 |
| rubble (6:38) | porters (assumed) | rock | store | p. 42 |
Bushes show remaining food in their info panel and deplete (p. 24).

### 7.2 Farms and crops (p. 29-30, 33)
- Race crop: Amazons cocoa, Pimmons mushrooms, Sajiki maggots (farm plants 6:17..28).
  Requires research Agriculture -> farm (p. 29).
- Farmers cultivate; porters harvest and process (p. 33). Crop is stored.
- **1 crop unit -> 2 food** when converted (p. 29-30).
- Raw-materials panel has a ring setting what share of the crop is turned into food, plus a button
  converting the whole stock now (tdb#182..184, #223..225). Conversion is irreversible (p. 30).
- Animals can eat plantations (mentor#81).

### 7.3 Specialist producers (p. 37-38)
- Need only an operator; inputs are ordered and delivered by porters automatically, output is
  collected by the nearest free porter and taken to the nearest warehouse.
- Panel "Production" (tdb#58): top line recipe, middle progress plus input buffer, right side
  finished output waiting for pickup. Also "costs per product" (tdb#134).
- **Pimmon distillery: 2 mushrooms + 1 wood -> 1 mushroom brandy** (p. 38).
- Mines and armouries work the same way (p. 38); their ratios are not given.

| chain | building | input -> output |
|---|---|---|
| luxury (Pimmon) | Schnapsbrennerei | 2 Pilze + 1 Holz -> 1 Pilzschnaps (p. 38) |
| luxury (Amazon) | Konditorei | cocoa (+ ?) -> Schokotörtchen (ratio not stated) |
| luxury (Sajiki) | Madendreherei | maggots (+ ?) -> Zigarillos (ratio not stated) |
| iron | Mine | ? -> Eisen (not stated) |
| weapons | Waffenschmiede / -fabrik | ? -> Waffen (not stated; idb: iron makes weapons) |
| soldiers | Kaserne etc. | porter + wood + weapons -> combat unit (p. 38, amounts not stated) |

---

## 8. Education / training (p. 30-31, 38, 40)
- School panel "Training" (`Ausbildung`) lists currently trainable professions with their cost;
  choosing one makes a free porter walk to the school by himself (p. 30-31). Labels: tdb#137..139
  ("in training", "waiting for pupil", "nobody in training").
- After training the unit waits in front of the school for orders (p. 31), unless it has a building
  to run.
- **Stonemason: 40** (p. 30). Other costs: see section 19 (dv.odb +0xD4).
- Barracks and the special military buildings work like the school (p. 38). Temple trains priests
  (p. 40).
- Completed: mentor#13. No free porter: mentor#14.

---

## 9. Research

### 9.1 Rules (p. 32-33)
- Needs a lab (type 46) run by a scholar; then "Research" and "History" become available.
- List of researchable inventions, each with a total price in brackets (tdb#23 `%s (%d)`).
- Funding is set per round under Finances. A project completes when the total price has been
  paid; more money per round = faster, but research also needs minimum time (p. 32).
- Start / interrupt buttons; interrupting keeps accumulated progress (p. 32-33).
- Progress bar in percent; "History" lists known inventions with descriptions.
- One lab per town (p. 33). Library speeds up research (idb).
- Messages: research finished (mentor#15), no money invested (mentor#16).
- Starting knowledge depends on "stage of development" (p. 11).

### 9.2 Prerequisites stated in the handbook
- Farm crop: Agriculture, then the farm (p. 29).
- Police: Writing and Law (p. 34).

### 9.3 Tech tree from DV.idb (not in the handbook; field meaning partly assumed)
Record = 212 bytes: `id, prereq1, prereq2, prereq3, value` then name and description.
`value` is very probably the bracketed research price; unconfirmed.
| id | Amazons | Pimmons | Sajiki | requires | value |
|---|---|---|---|---|---|
| 0 | Spähturm | Spähturm | Spähturm | - | 15 |
| 1 | Bergfrau | Holzfäller | Holzfäller | - | 10 |
| 2 | Jägerin | Jäger | Jäger | - | 12 |
| 3 | Ackerbau | Ackerbau | Ackerbau | - | 20 |
| 4 | Botschaft | Botschaft | Botschaft | 0 | 40 |
| 5 | Schrift | Schrift | Schrift | 0 | 60 |
| 6 | Lagerhaus | Lagerhaus | Lagerhaus | 1, 2 | 25 |
| 7 | Kakaoplantage | Pilzfarm | Madenzüchtung | 3 | 35 |
| 8 | Kriegertafel | Wirtshaus | Orgiengrube | 3 | 20 |
| 9 | Marktplatz | Marktplatz | Marktplatz | 4, 5 | 50 |
| 10 | Gesetz | Gesetz | Gesetz | 5 | 70 |
| 11 | Zeitung | Zeitung | Neuigkeiten | 1, 5 | 30 |
| 12 | Kaserne | Kaserne | Kaserne | 9, 10, 2 | 65 |
| 13 | Tempel | Tempel | Tempel | 4, 11 (+10 for Amazons, Sajiki) | 100 |
| 14 | Konditorei | Brennerei | Madendreherei | 9, 7 | 70 |
| 15 | Metallurgie | Metallurgie | Metallurgie | 12 | 85 |
| 16 | Kl. Außenposten | Kl. Außenposten | Kl. Außenposten | 12 | 90 |
| 17 | Bank | Bank | Bank | 9, 11 | 80 |
| 18 | Gr. Wohnung | Gr. Wohngebäude | Gr. Wohngebäude | 13, 6 | 95 |
| 19 | Theater | Zirkus | Kampfarena | 8, 14 | 120 |
| 20 | Saboteurin | Saboteur | Saboteur | 12, 19 | 115 |
| 21 | Schwertkämpferin | Schwertkämpfer | Kämpfer | 15 | 100 |
| 22 | N. Waffentechnik | Tierfarm | Zuchtstall | 15, 13 | 115 |
| 23 | Alchemie | Magie | Beschwörung | 20, 13, 15 | 150 |
| 24 | Bihänderin | Hammermann | Berserker | 21 | 145 |
| 25 | Armbrustschützin | Explodus | Harak | A/S: 16, 22; P: 22, 23 | 160 |
| 26 | Gr. Außenposten | Gr. Außenposten | Gr. Außenposten | 16, 22 | 200 |
| 27 | Mächtige Alchem. | Mächtiger Magier | Gottesanbeter | 23, 22 | 180 |
| 28 | Kanone | Necktarus | Brutwache | 24, 22 | 200 |
| 29 | Bibliothek | Bibliothek | Wissenshöhle | 11 | 150 |
dv.odb +0xE4 on each unit/building holds the invention id that unlocks it (-1 = known from the
start), e.g. Pimmon Steinmetz -1 but Holzfäller 1; Amazon Holzfällerin -1 but Bergfrau 1. So
Amazons start with wood and must research stone; Pimmons the reverse; Sajiki research wood.

---

## 10. Food supply (p. 28, 33, tdb#215..217, #258..259)
- Sources: fruit (porters), hunting (hunters), farm crop conversion (1 crop -> 2 food).
- Needs panel shows consumption and production per round.
- States: well supplied / too little food / starving (mentor#26/#27).
- Criminals and homeless also eat (p. 34, 42).

## 11. Crime and police (p. 28, 34)
- Criminals appear when population passes some size and/or when people are unhappy; the Needs
  panel shows criminals relative to population.
- Criminals: consume food and housing, pay no tax, attack porters (injuring them, p. 23).
- Counter: research Writing + Law, train a policeman. A policeman sent manually at a criminal gets
  attacked by him. With a police station run by a policeman, he hunts criminals automatically,
  arrests them; after a jail term they come out as **porters** (p. 34).

## 12. Trade (p. 34-36)
- Needs market places and a merchant. Minimum: two towns with a market and one merchant;
  trading with a nation that has only a merchant while you have only a market also works (p. 36).
- Market settings per good:
  - Sale (`Verkauf`): minimum stock to keep (`Mindestlagermenge`) and minimum sale price
    (`Min. Verkaufspreis`); enable/disable (`Verkauf freigeben/sperren`).
  - Purchase (`Einkauf`): target maximum stock (`Maximale Lagermenge`) and maximum price
    (`Max. Einkaufspreis`); enable/disable.
  - Example from the handbook: sell food at min price 10 keeping 15 in stock (p. 34).
- Foreign markets can be inspected but not edited (p. 36).
- Merchant: trade route = origin town + destination town (must differ), chosen from lists per
  nation of towns with markets (p. 35). Carries **max 5 items** per trip (p. 35).
- He trades at the origin's terms for the whole route; he keeps running even when empty; he has no
  knowledge of destination stock (p. 36).
- Route ends when: new order, "stop route", a market destroyed, peace with the partner ends, or the
  merchant is attacked (p. 35).
- Internal trade (between own towns) moves goods but earns no money; profit only with other
  nations, and only those you are at peace with (p. 35-36). Seeing foreign markets without scouts
  also requires peace (p. 37).
- Bank improves trade profit (idb).

## 13. Diplomacy (p. 36-37)
- Requires an embassy (with diplomat) on both sides. Embassies are visible to and clickable by all
  nations. Mentor announces new foreign embassies (mentor#68..70); none: tdb#309.
- States: war / cease fire / peace (tdb#240..242).
- Incoming offers: you can choose which kinds to auto-accept (tick list, tdb#173); peace and cease
  fire can be declined, war cannot be refused (p. 37).
- Outgoing: send the ambassador with "offer peace", "offer cease fire" or "declare war", depending
  on current state; he walks to the nearest embassy of that nation, which accepts or refuses
  (war always takes effect) (p. 37). He can be recalled mid-way (p. 37, tdb#254).
- A third nation may capture your ambassador en route (p. 37).
- Closing your embassy breaks all ties (p. 37; tdb#312).
- Patrols and trade respect state: no attacks on peace/cease-fire nations (p. 39).

## 14. Specialist buildings (p. 37-38)
See 7.3: operator only, automatic supply and dispatch, porters prioritise construction and
training over supplying these buildings.

## 15. Military

### 15.1 Training (p. 38)
Barracks and similar buildings behave like schools; combat units additionally consume wood and
weapons.

### 15.2 Patrol (p. 39, tdb#5)
- Combat units only. Command "Patrol" in the unit's command row.
- Two-point patrol: move unit to start, press Patrol, LEFT click the second point.
- Multi-point: press Patrol, hold Ctrl, left click waypoints, release Ctrl, click the last one.
  Up to **8** waypoints.
- Patrolling units attack every unit of nations at war with you; never peace or cease-fire nations.

### 15.3 Experience (p. 40)
| rank | icon | combat factor |
|---|---|---|
| none | - | x1.00 |
| some experience | bronze star | +25% |
| more | silver star | +50% |
| veteran | gold star | +100% |
Experience comes from fighting; thresholds not stated.

### 15.4 Healing (p. 23, 40)
- Only priests heal. Priest trained at the temple, can also run it.
- Send a priest at an injured unit; he then heals other injured units nearby automatically.
- Priests attached to combat groups are called by injured soldiers automatically.

### 15.5 Other
- Scouts are typically sent via the minimap (p. 43). Watchtowers give permanent vision (idb).
- Outposts extend town territory and host defenders (idb).
- Towns and town halls can be attacked and destroyed (mentor#20..22); a nation can be defeated
  (mentor#23..25).

---

## 16. Hints and tricks: rules contained in them (p. 41-43)
| topic | rule |
|---|---|
| MP host | host quitting ends the game for all; use the fastest PC as host |
| hidden units | clickable behind buildings/trees; town dwellers list centres on lost units |
| stores | warehouses of a town share one stock (3.2) |
| cursor | changes with selected unit type/mode |
| queues | units can jam at the town hall or a site; send the group away to unstick |
| few porters | gatherers can deliver directly to building sites, then must be resent |
| homeless | eat and work, no tax (4.4) |
| rubble | demolish to recover rock; wood lost (5.3) |
| resettling | manual, to houses in another town |
| minimap orders | right click on minimap moves selected units |
| hunters | idle until sent hunting once; keep as reserve fighters |

---

## 17. Glossary (English handbook term | German in-game | id)
| English | German | id |
|---|---|---|
| porter | Träger / Trägerin (Amazon) | R:9 |
| town founder (mayor) | Stadtgründer / Gründerin | R:10 |
| master builder | Baumeister / Baumeisterin | R:11 |
| criminal | Krimineller / Kriminelle | R:12 |
| diplomat, ambassador | Diplomat / Diplomatin | R:13 |
| farmer | Pilzbauer / Kakaopflanzerin / Madenzüchter | R:14 |
| hunter | Jäger / Jägerin | R:17 |
| lumberjack, woodcutter | Holzfäller / Holzfällerin | R:19 |
| policeman | Polizist / Politesse | R:21 |
| priest | Priester / Priesterin / Tempeljünger | R:22 |
| scientist | Gelehrter / Gelehrte | R:23 |
| scout | Späher / Späherin | R:24 |
| stonemason | Steinmetz / Bergfrau | R:27 |
| merchant | Händler / Händlerin | R:28 |
| archer | Bogenschütze / Bogenschützin / Pyro | R:29 |
| sword fighter | Schwertkämpfer / Schwertkämpferin / Kämpfer | R:31 |
| magician, alchemist | Magier / Alchemistin / Gottesanbeter | R:33 |
| cannon | Kanone (Amazon) | 0:35 |
| house | Wohngebäude / Wohnung / Wohnbau | R:37 |
| barracks | Kaserne | R:39 |
| town hall | Rathaus | R:40 |
| warehouse | Lagerhaus / Lager | R:41 |
| embassy | Botschaft | R:42 |
| ordnance factory | Geschützfabrik (Amazon) | 0:43 |
| "horse farm" (animal farm) | Dressurfarm (idb: Tierfarm) / Zuchtstall | 1:43, 2:43 |
| distillery | Schnapsbrennerei | 1:44 |
| mushroom farm | Pilzfarm | 1:45 |
| research lab | Labor | R:46 |
| market place | Marktplatz | R:48 |
| mine | Mine | R:50 |
| police station | Polizei | R:54 |
| school | Schule / Verpuppungsstätte (Sajiki) | R:55 |
| tavern | Wirtshaus | 1:58 |
| temple | Tempel | R:59 |
| armoury | Waffenschmiede / Waffenfabrik | R:61 |
| wood / rock / iron | Holz / Stein / Eisen | 6:1 / 6:2 / 6:3 |
| food | Nahrung | 6:4 |
| arms | Waffen | 6:5 |
| mushroom brandy | Pilzschnaps | 6:7 |
| tree / bush / rock | Baum / Busch / Stein | 6:9..12 / 6:13..16 / 6:29..32 |
| animals | Fasterator, Necktor, Echse, Sumpfling, Hase | 6:33..37 |
| rubble | Schutt | 6:38 |
| Construction of buildings | Gebäudebau | tdb#1 |
| Training | Ausbildung | tdb#0 |
| Home | Nach Hause | tdb#3 |
| Town dwellers | Stadtbewohner | tdb#39 |
| Finances / Investments | Finanzen / Investitionen | tdb#10 / #128 |
| Motivation bonus | Motivationsgelder | tdb#13 |
| Research funds | Forschungsgelder | tdb#14 |
| Overheads | Laufende Kosten | tdb#15 |
| Needs | Bedürfnisse | tdb#27 |
| Raw materials / Resources | Rohstofflager | tdb#37 |
| "Under construction" (occupants) | Im Gebäude | tdb#38 |
| Production | Produktion | tdb#58 |
| Sale / Purchase | Verkauf / Einkauf | tdb#46 / #49 |
| Trade route | Handelsroute | tdb#50 |
| Research / History | Forschung / Geschichte | tdb#17 / #24 |
| Patrol | Patrouillieren | tdb#5 |
| Stop operation | Betrieb einstellen | tdb#311 |
| Demolish / Repair | Abreißen / Restaurieren | tdb#8 / #4 |
| continuous game | Endlosspiel | tdb#187 |

---

## 18. Per-race equivalence (from dv.odb, same type = same role)

### 18.1 Units
| type | role | Amazons (0) | Pimmons (1) | Sajiki (2) |
|---|---|---|---|---|
| 9 | porter | Trägerin | Träger | Träger |
| 10 | founder | Gründerin | Stadtgründer | Stadtgründer |
| 11 | builder | Baumeisterin | Baumeister | Baumeister |
| 12 | criminal | Kriminelle | Krimineller | Krimineller |
| 13 | diplomat | Diplomatin | Diplomat | Diplomat |
| 14 | farmer | Kakaopflanzerin | Pilzbauer | Madenzüchter |
| 15 | entertainer | Schauspielerin | Dompteur | Gladiator |
| 16 | luxury maker | Bäckerin | Schnapsbrenner | Madendreher |
| 17 | hunter | Jägerin | Jäger | Jäger |
| 18 | innkeeper | Wirtin | Wirt | Orgienmeister |
| 19 | woodcutter | Holzfällerin | Holzfäller | Holzfäller |
| 20 | news vendor | Zeitungsmädchen | Zeitungsmann | Verkünder |
| 21 | police | Politesse | Polizist | Polizist |
| 22 | priest | Priesterin | Priester | Tempeljünger |
| 23 | scholar | Gelehrte | Gelehrter | Gelehrter |
| 24 | scout | Späherin | Späher | Späher |
| 25 | weaponsmith | Waffenschmiedin | Waffenschmied | Eisenbeisser |
| 26 | saboteur | Saboteurin | Saboteur | Saboteur |
| 27 | stonemason | Bergfrau | Steinmetz | Steinmetz |
| 28 | merchant | Händlerin | Händler | Händler |
| 29 | basic ranged | Bogenschützin | Bogenschütze | Pyro |
| 30 | heavy melee | Bihänderin | Hammermann | Berserker |
| 31 | melee | Schwertkämpferin | Schwertkämpfer | Kämpfer |
| 32 | advanced magic | Mächtige Alchem. | Mächtiger Magier | Beschwörer |
| 33 | magic | Alchemistin | Magier | Gottesanbeter |
| 34 | special 1 (yard) | Katapult | Drachofiterus | Spitpack |
| 35 | special 2 (yard) | Kanone | Necktarus | Brutwache |
| 36 | special 3 | Armbrustschützin | Explodus (self-destructing beast) | Harak (self-destructing) |
Note: type 32 ("Beschwörer") is not in the Sajiki idb list; idb id 27 for Sajiki names
Gottesanbeter (type 33 in odb). Which invention unlocks 32 vs 33 per race needs checking via
odb +0xE4 (values: 32 -> 27, 33 -> 23 in all races).

### 18.2 Buildings
| type | role | Amazons (0) | Pimmons (1) | Sajiki (2) |
|---|---|---|---|---|
| 37 | house | Wohnung | Wohngebäude | Wohnbau |
| 38 | large house | Große Wohnung | Großes Wohngebäude | Großer Wohnbau |
| 39 | barracks | Kaserne | Kaserne | Kaserne |
| 40 | town hall | Rathaus | Rathaus | Rathaus |
| 41 | warehouse | Lager | Lagerhaus | Lagerhaus |
| 42 | embassy | Botschaft | Botschaft | Botschaft |
| 43 | special yard | Geschützfabrik | Dressurfarm | Zuchtstall |
| 44 | luxury producer | Konditorei | Schnapsbrennerei | Madendreherei |
| 45 | farm | Kakaoplantage | Pilzfarm | Madenzüchtung |
| 46 | lab | Labor | Labor | Labor |
| 47 | library | Bibilothek (sic) | Bibliothek | Wissenshöhle |
| 48 | market | Marktplatz | Marktplatz | Marktplatz |
| 49 | bank | Bank | Bank | Bank |
| 50 | mine | Mine | Mine | Mine |
| 51 | news | Zeitungsstand | Zeitungsstand | Infohöhle |
| 52 | small outpost | Kl. Außenposten | Kl. Außenposten | Kl. Außenposten |
| 53 | large outpost | Gr. Außenposten | Gr. Außenposten | Gr. Außenposten |
| 54 | police | Polizei | Polizei | Polizei |
| 55 | school | Schule | Schule | Verpuppungsstätte |
| 56 | magic building | Alchemistenhütte | Magierturm | Kultstätte |
| 57 | culture | Theater | Zirkus | Kampfarena |
| 58 | entertainment | Kriegertafel | Wirtshaus | Orgiengrube |
| 59 | temple | Tempel | Tempel | Tempel |
| 60 | watchtower | Spähturm | Spähturm | Spähturm |
| 61 | armoury | Waffenfabrik | Waffenschmiede | Waffenfabrik |

### 18.3 Race flavour (p. 9, 11)
- Pimmons: peaceful, blue; mushrooms and mushroom brandy.
- Amazons: warriors who like nature and order, red; cocoa and chocolate cakes; female unit names.
- Sajiki: insects bent on wiping out rivals, yellow; maggots and smoked maggots.
- Starting knowledge differs (see 9.3): Amazons know woodcutting, Pimmons stonework.

---

## 19. Handbook numbers confirmed in dv.odb (fields for the decoder)
| handbook fact | dv.odb field | value |
|---|---|---|
| Pimmon school costs 2 wood + 4 rock (p. 26) | Schule 1:55 +0xF4 / +0xF8 | 2 / 4 -> **+0xF4 = wood, +0xF8 = stone** (+0xFC likely iron) |
| stonemason training 40 (p. 30) | Steinmetz 1:27 +0xD4 | 40 -> **units: +0xD4 = training cost** |
| overheads 12 for town hall + school (p. 27) | Rathaus +0xD4 = 7, Schule +0xD4 = 5 | **buildings: +0xD4 = upkeep per round** |
| small house gives 3 residents (p. 30) | Wohngebäude +0xB4 | 3 (large house 9) |
| lab needs a scientist (p. 32) | Labor +0xD8 | 23 = scholar -> **buildings: +0xD8 = operator unit type** |
| porter 50 HP (p. 23) | Träger +0xAC | 50 |
| distillery uses 1 wood per brandy (p. 38) | Pilzschnaps 6:7 +0xF4 | 1 (goods: +0xF4.. likely extra inputs) |

Derived from these fields (not stated in the handbook, but now well grounded):
- Build costs (wood/stone/iron) per race differ: Amazon buildings lean on wood, Pimmon buildings on
  stone (school: Amazon 4/2, Pimmon 2/4, Sajiki 3/3).
- Upkeep per round (Pimmons): house 5, large house 7, barracks 5, town hall 7, warehouse 5,
  embassy 15, yard 10, distillery 25, farm 15, lab 15, library 50, market 15, bank 50, mine 20,
  newspaper 30, small outpost 20, large outpost 30, police 30, school 5, magic 10, circus 50,
  tavern 20, temple 40, watchtower 10, armoury 15.
- Training cost: porter 10, founder 100, builder 30, diplomat 70, farmer 50, entertainer 70,
  luxury maker 60, hunter 40, innkeeper 50, woodcutter 40, news 70, police 70, priest 100,
  scholar 70, scout 50, weaponsmith 70, saboteur 300, stonemason 40, merchant 50; combat:
  29 -> 100, 30 -> 460, 31 -> 380, 32 -> 600, 33 -> 500, 34 -> 500, 35 -> 600, 36 -> 400..600.
- Goods +0xD4 (wood 5, stone 5, iron 25, food 5, weapons 60, luxuries 20) looks like a base
  price; unconfirmed.

---

## 20. Open questions for the simulation

Mechanics the handbook names without numbers; measure from AN.exe or the original game.

**Time base**
1. Real-time length of a "round" (tax, upkeep, food, research ticks). Does game speed vary?
2. Construction time per building (odb has no obvious build-time field yet), training time per
   profession, work cycle times (chop, quarry, pick, hunt, production cycle).

**Economy**
3. Exact tax rule: 7 per resident per round. Do all residents count (founder, specialists,
   soldiers)? The example counts 4 residents incl. the founder (p. 27).
4. Initial stock cap: 25 per type from the town hall, or a base value? Does the town hall count as
   a store? Cap with N warehouses = 25*(N+1)?
5. What happens with deliveries above the cap.
6. Start resources per "level of supplies" setting; start units per mission/setting.
7. Porter carry capacity outside construction (fruit, crops, rubble): always 1?
8. How porters pick jobs (nearest, queue order) beyond "construction and training first".
9. Bush, tree, rock, animal yields (odb +0x11C/+0x120?) and whether bushes/trees regrow.
10. Rubble yield: how much rock per demolished building (full stone cost?).
11. Building decay rate without upkeep money / at low motivation; repair cost formula.

**Population**
12. Growth rate: how fast houses fill up (3 / 9 residents) and how unhappiness slows it.
13. Food consumption per resident per round; starvation effects (death? emigration?).
14. Happiness formula: weights of food, each need, luxury supply, motivation bonus; thresholds
    for the six states (tdb#29..34) and what "rebelling" does.
15. Population thresholds at which each need (entertainment, news, police, culture, temple,
    luxury goods) appears, and luxury consumption rate.
16. Crime: population threshold and unhappiness factor for criminal spawning; how criminals pick
    victims; jail duration; does a criminal come from an existing resident?
17. Homeless: where they wait, how they are rehoused; refugee rules when a town falls.

**Production**
18. Ratios for mine (iron), armoury (weapons), Amazon bakery, Sajiki maggot works, and farm
    yields per farmer per cycle. Hypothesis from odb: iron = 2 wood + ore?, weapon = 2 wood +
    1 iron.
19. Crop-to-food conversion ring semantics (percentage of each harvest vs of the stock).
20. Combat unit material costs (wood, weapons per unit type).

**Research**
21. Is DV.idb `value` the bracket price, and is it scaled? Minimum research duration per invention
    and how funding maps to speed (cap per round?). How much the library speeds things up.
22. Which inventions are pre-known for each "stage of development" setting.

**Trade and diplomacy**
23. Price model: how a sale price is agreed between seller min and buyer max; who gets the money;
    does the bank change prices? Base prices of goods.
24. Merchant behaviour per trip (which goods first, 5-item limit across types).
25. AI acceptance rules for peace/cease-fire offers; initial diplomatic state between nations;
    whether cease fire expires; ambassador capture rules.

**Military**
26. Damage, HP, armour, range, attack speed per unit (odb +0xAC/+0xB0 are HP/armour candidates;
    weapon data in dv.wdb). Experience thresholds for bronze/silver/gold.
27. Healing rate, priest auto-heal radius, how injured soldiers "call" priests.
28. Outpost territory radius, watchtower vision radius, town area size from the town hall.
29. Saboteur damage and detection; self-destructing units (Explodus, Harak) damage area.
30. What happens when a town hall is destroyed (town lost, residents flee); nation defeat rule.

**UI / misc**
31. Maximum number of towns per nation (tdb#172); conditions for founding a town (founder +
    distance from other towns?).
32. Numpad + = zoom out / - = zoom in as printed: verify (may be swapped in the handbook).
33. Group size 12 and 10 groups: confirm limits in code; patrol 8 waypoints.
