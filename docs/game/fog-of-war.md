# Fog of war, exploration and visibility (behaviour spec)

Status: **first full pass.** The vision bookkeeping, every place that adds or removes vision, the
terrain, sprite and minimap rendering rules, selection, building placement and the cheat toggle
have been traced in AN.exe. Section 11 lists what is still open.

Sources: the decompiled AN.exe (`re/dump/decomp.c`). Several message handlers and the minimap
object pass are missing from the dump, so they were read in the raw disassembly of
`re/bin/AN.exe`. Addresses are cited as evidence. The Gold Edition (`dvge.exe`) was checked at
instruction level for every vision source (section 3.1); its rules are the same, with one change
(market-like flag 0x20 instead of type 48). No code is reproduced: behaviour is described
in our own words, tables and formulas.

Legend: **C** = confirmed in code, **I** = inferred (data pattern, partial trace, naming),
**U** = unknown. All divisions are C integer divisions (truncate toward zero). "Tick" is one
scheduler tick (95 ms at normal speed).

Related documents:
- `docs/formats/odb.md`: record field +0xB0 (radius), kinds, types.
- `docs/game/units-and-jobs.md`: movement, construction, cell flags (6.1).
- `docs/game/ai-diplomacy-trade.md`: relations, message 0x5C.
- `docs/rendering/terrain-drawing.md`, `docs/ui/side-panel.md` section 6 (minimap).

---

## 0. Summary

- Fog of war exists **only for the local player's race** (global `0x4AF3CC`). There is one
  explored/visible state per machine, stored in the shared map cells. It is never computed for
  other races or computer players (C).
- Each map cell has a permanent **explored** bit and a **viewer counter**: the number of the local
  race's vision discs currently covering the cell. A cell is **visible** while its counter is
  greater than 0. The game never clears and recomputes visibility. Every vision source adds +1 to
  the cells of its disc when it appears or arrives, and −1 when it leaves (C, `0044a250`,
  `0044a6e0`).
- The vision shape is a **filled disc on the cell grid**: offsets (dx, dy) with
  **dx² + dy² < r²** (strict) around the source cell, wrapped on the torus. Terrain height and
  line of sight play no part (C).
- **Sources** (all of the local race): every unit standing on the map, with radius odb +0xB0
  (scouts 15; founders, hunters and soldiers 10; other civilians 5; criminals 0; add-on ships 8,
  10 or 12); every **active** building with a radius (town hall 25, large outpost 25, small
  outpost 15, watchtower 30, mine 8, embassy 6, market 6, add-on harbour 6). Buildings with radius
  0 (houses, workshops, schools, the add-on **shipyard** ...) never see. Foreign **embassies** add
  their radius once diplomatic contact exists, and foreign **markets** (Gold: market and harbour)
  add theirs while at peace (C). Per-type table with the activation condition: section 3.1.
- A building's **completion** also permanently explores its radius, without making it visible
  (C, `004602d0` -> message 0x3B -> `0044a4b0`).
- **Rendering:** unexplored = black, explored but not visible = half light, visible = full light.
  Units and animals are drawn only on visible cells. Buildings and static nature (trees, stones,
  bushes, crops, rubble) are drawn on explored cells too, at half brightness, once a vision disc
  has covered them at least once. They show their **current** state, never a stale snapshot (C).
- Hidden objects cannot be clicked or box-selected. **Building placement** in the UI requires the
  footprint plus a 1-cell margin to be currently visible. The simulation itself never checks fog
  (C).
- Fog is **display-only and per machine**. No simulation or AI rule reads it, so the computer
  players are omniscient (C for the absence of readers in the paths checked, section 9).
- The typed cheat **MAGICEYE** toggles fog off and on for the local display (C, `0043fd70`).

---

## 1. Data

### 1.1 Map cell (8 bytes, map array at map +0x09) (C)

Map object = global `0x4B3944`. The cell index is `(y & mask) << shift | (x & mask)`, with
mask = size − 1 (map +0x0D, +0x11). The map size is a power of two (128, 256 or 512) and is
stored at map +0x15. Fields that matter here:

| offset | size | meaning |
|---|---|---|
| +0 | u16 | object index at this cell (0xFFFF = none). For buildings every footprint cell holds the index |
| +2 | u8 | flags (below) |
| +3 | u8 | **viewer counter** (local race vision discs covering this cell) |
| +4 | u16 | ground height |
| +6 | u8 | light value (terrain-drawing.md) |
| +7 | u8 | terrain tile |

Flags byte (+2):

| bit | meaning | evidence |
|---|---|---|
| 0x01 | path flag: paved by a building foundation or a worn path (units-and-jobs.md 6.6, 4.5); gives the faster step (4.1) | `00448690`, `00448210` |
| 0x02 | **explored** by the local race; never cleared during a game | `0044a250`, `0044a4b0` |
| 0x04, 0x08 | town-border marker colour (race + 1) | `0044e7c0`, `0044e4b0` |
| 0x10 | placement-preview cursor cell | `00441e80` |
| 0x40 | **dirty**: the cell must be redrawn (cleared by the frame builder) | `0044a250`, `0044a6e0`, `00445e40` |
| 0x80 | the object index here is the object's **anchor** (origin) cell | `00448690`, `004488e0` |

The counter is a plain byte with no clamp: 256 overlapping discs on one cell would wrap it to 0
(C for the missing clamp; whether it ever happens in play is U).

Initial state: every cell starts unexplored with counter 0. No mission flag, `.dvm`/`.mdb`
field, free-play option or menu setting changes this (C for the formats and menus documented
in `docs/formats/` and `docs/ui/front-end.md`; I that map creation zeroes these bytes).

### 1.2 Global display flags (`0x4AFC40`) (C)

Set to 0x3A by the per-map reset `0040e970`, so on every new map and every loaded game.

| bit | meaning |
|---|---|
| 0x08 | **fog of war on**. When clear, everything is drawn as if visible |
| 0x20 | draw objects in the world view |
| 0x02, 0x10 | other display options, not fog related |

Only the MAGICEYE cheat changes bit 0x08 (section 8).

### 1.3 Per display object (C)

Every game object has a **display object** (the client-side mirror that the simulation drives
with messages). The object table at `0x4B3954` holds pairs {simulation object, display object},
indexed by the cell's object index. Fog uses these display-object fields:

| field | meaning | set by |
|---|---|---|
| +0x58 | **static** flag: 1 for buildings and non-animal nature, 0 for units, animals and effects | constructors `004555d0` (building), `00455610` (nature), `00455650` (unit), `00455690` (animal), `00436970` (projectile); the factory `00455240` picks one by record kind and class |
| +0xA8 | "never dim": 1 for projectiles and effects | `00436970` |
| +0xD4 | **seen** flag: set the first time a vision disc covers one of the object's cells, never cleared; saved with the object | `0044a250`, constructor `00433e10`, save `00437510` |
| +0x1FD | building vision is on | `004366b0` / `004367c0` |
| +0x78, +0x7C | current cell (for buildings: the anchor cell, which is the footprint's maximum corner) | |

### 1.4 Minimap buffers (C)

The minimap (global `0x4B38DC`, created by `00424880` with 152 pixels and the map size) keeps
two byte buffers of 152 × 152 (minimap +0x40 front, +0x44 back, `0044c8f0`):

| bit | meaning |
|---|---|
| 0x01 | explored (kept from pass to pass) |
| 0x02 | visible (rebuilt every pass) |
| 0x04 / 0x08 / 0x10 | object of race 0 / 1 / 2 |
| 0x20 / 0x40 / 0x60 | tree / stone / bush or animal |
| 0x80 | the object plotted here is mobile (not static) |

The minimap resolution is its own: one pixel = mapsize / 152 cells. Its explored and visible
bits are computed independently of the cell bits, from scaled discs (section 5.4).

### 1.5 Save games (C)

The whole cell array is written (`0044acd0`), so explored bits and counters are saved. The
minimap buffers and its layer toggles are saved (`0044e0b0` / `0044e150`), as are each display
object's seen flag and on-map flag (`00437510`). The fog-on bit is **not** saved: it is reset to
on by `0040e970`.

---

## 2. Vision operations (C)

All three operations take a centre cell (x, y) and a radius r. They walk the square
−r..+r in both axes, keep the offsets with **dx² + dy² < r²**, and wrap each coordinate into
0..size−1 (torus).

| operation | function | effect on each cell in the disc |
|---|---|---|
| **add** | `0044a250` | if the counter was 0 **or** the cell was unexplored, set dirty; set explored; counter += 1. If the cell holds an object whose display object is static (+0x58), set that object's **seen** flag (on every add, not only on transitions). Then mark the minimap explored disc (5.4) |
| **remove** | `0044a6e0` | counter −= 1; if it reaches 0, set dirty. The explored bit stays |
| **explore only** | `0044a4b0` | if the cell was unexplored, set dirty; set explored. Counter and seen flags are not touched. Then mark the minimap explored disc |

Consequences:

- Radius 0 covers nothing, because no offset satisfies dx² + dy² < 0. Criminals and buildings
  without a radius therefore reveal nothing.
- The disc for radius r reaches r − 1 cells along the axes. Cell counts: r 5 → 69, 6 → 109,
  8 → 193, 10 → 305, 15 → 697, 25 → 1941, 30 → 2809.
- Visibility is reference-counted, so overlapping sources are independent and the add and
  remove for one source must use the same centre and radius.

---

## 3. Vision sources

Every source below belongs to the local race (record group +0xA0 = `0x4AF3CC`), except the two
foreign building cases. The radius is always the type's odb +0xB0. The values are identical in
all three races (checked in `dv.odb`).

| source | radius | added when | removed when | evidence |
|---|---|---|---|---|
| unit placed on the map (all unit kinds) | +0xB0 | the display object is put on a cell: creation on the map, leaving a building, **each step** (on the destination cell) | taken off its cell: each step (old cell), entering a building, death or removal | `00448690` / `004488e0`, called from the create-object handler (`0x4552C0`), `00435410` (leave building / re-place), the step handler `00455720`, `004351d0` (enter building) and `00434840` (removal from the world, e.g. death) |
| active building (state 2) | +0xB0 | activation, message (0x2E,5) from `0045fa40` -> handler `0x4569A0` -> `004366b0` | deactivation or destruction, message (0x2F,5) from `0045ff30` -> handler `0x4569E0` -> `004367c0` | as listed |
| building completed | +0xB0, **explore only** | completion (construction done, town founded, map load), message (0x3B,9) from `004602d0` -> handler `0x457250` -> `0044a4b0` | never | as listed |
| **foreign** embassy (type 42), active | its +0xB0 (6) | on activation if the relation between the local race and its race is not 0; or when the relation leaves 0 | on deactivation if the relation is not 0; or when the relation returns to 0 | `004366b0`, `004367c0`; relation change `004583f0` -> `00458200` -> message (0x5C,6) -> handler `0x458530` |
| **foreign** market (type 48), active | its +0xB0 (6) | as above, but the relation must be 3 (peace) | as above, when peace ends | same |

Radii by type (units are the same for all races):

| type | radius |
|---|---|
| 24 scout | 15 |
| 10 founder, 17 hunter, 29..36 soldiers | 10 |
| other civilians (9, 11, 13..16, 18..23, 25..28) | 5 |
| 12 criminal | 0 (no vision) |
| 40 town hall, 53 large outpost | 25 |
| 52 small outpost | 15 |
| 60 watchtower | 30 |
| 50 mine | 8 |
| 42 embassy, 48 market | 6 |
| every other building, construction sites, nature, animals, effects | 0 / none |

Notes:

- **Criminals see nothing** (C): their record radius is 0 in all three races (`dv.odb`, GOG and
  Gold), so the add and remove of section 2 touch no cell, and the minimap's visible pass skips
  type 12 by an explicit test (5.4). A criminal walking into unexplored land neither explores
  nor lights it, and it is itself drawn only where other sources see (5.2). Only after its
  release from jail, as a porter, does the unit see its 5 cells (`combat.md` 12.4).
  *Our build:* `Vision.update` stamps only sources with a radius above 0, so criminals add
  nothing (checked October 2026, test `test/crime.test.ts`).
- **Construction sites give no vision.** The building factory path never adds vision for
  buildings (`00448690` treats kind 1 differently), and a site has state 1, never 2.
- **Buildings see only while active.** Staffed buildings become active only when their operator
  is inside (`004602d0` -> `0045fa40` on completion, otherwise on the operator's arrival). A
  **watchtower** therefore sees 30 cells only while its scout is inside. Without a scout it still
  got the one-off explore of radius 30 on completion. Deactivating a building (the panel's
  deactivate button, losing its operator, destruction) removes its vision (C for `0045ff30`).
- **Units inside buildings see nothing.** Entering takes them off the map, which removes their
  disc. Garrisoned archers add nothing beyond the outpost's own radius (C). An outpost has no
  operator, so it is active, and sees its radius (15 small, 25 large), from completion on,
  with or without a garrison. The garrison finds its targets by a scan with the same radius
  around the same cell (`combat.md` 9.3), so everything it shoots at lies inside the outpost's
  own vision. Garrison units are drawn on the tower whenever the outpost is drawn
  (`docs/rendering/objects.md` 13.2).
- **Centre cell:** units use the cell they occupy in the display. A step moves them to the
  destination cell at the **start** of the step (the simulation moves at once; the display only
  interpolates), so their vision jumps one cell ahead of the drawn sprite. Buildings use their
  anchor cell, the **maximum corner** of the footprint, not its centre.
- **No allied vision.** Peace or ceasefire partners share nothing except the embassy and market
  discs above. A relation of 0 means no contact. A missing relation record counts as "not 0"
  for the activation test (C, `004366b0`), but relations exist for every pair in practice (I).
- Animals, nature and goods (group 6) never match the local race, so they have no vision.

### 3.1 Which buildings see, and when (C; base and Gold)

The building rule is generic: **no type list**. The activation handler adds a disc of the record's
+0xB0 for any own building (base `004366b0`, Gold `0043a750`: the own-race branch loads +0xB0 and
calls the disc add with no other test, `0x43A76D`..`0x43A7F0`); deactivation removes the same
disc (base `004367c0`, Gold `0043a860`). Completion explores the same radius once (base handler
`0x457250`, Gold `0x45CF72`..`0x45CFB1`: own race, +0xB0, explore only). Radius 0 covers no cell
(section 2), so whether a building sees is decided by its +0xB0 value alone, and when it sees by
its **activation**. The add-on's `Addon.odb` and the Gold `dv.odb` carry the same radii as the
base for types 37..61 (checked in the data files).

Activation (`units-and-jobs.md` 6.5, 8.1; Gold completion `00466590`, test at `0x4667CD`): a
completed building with operator +0xD8 = −1 is activated **at completion**. A building with an
operator stays inactive until a unit of the operator type and of the building's race enters.
Deactivation (operator sent out, `DEAKTIVIEREN`, a duty job broken under way, destruction) removes
the disc. An operator out on his building's own duty job keeps the building active (8.5 there),
so the disc stays.

| type | building | radius (+0xB0) | operator (+0xD8) | own building sees | completion explores |
|---|---|---|---|---|---|
| 40 | town hall | 25 | founder (10) | while active: from the founding (founder inside) | 25 |
| 52 / 53 | small / large outpost | 15 / 25 | none | from completion, with or without garrison | 15 / 25 |
| 60 | watchtower | 30 | scout (24) | only while its scout is inside | 30 |
| 50 | mine | 8 | miner / stonemason (27) | only while its miner is inside (active); not while waiting for the miner | 8 |
| 42 | embassy | 6 | diplomat (13) | while active (diplomat inside or on an errand) | 6 |
| 48 | market | 6 | none | from completion | 6 |
| 62 | harbour (add-on) | 6 | none | from completion | 6 |
| 63 | shipyard (add-on) | **0** | none | **never** (active from completion, but radius 0) | nothing |
| all others (37..39, 41, 43..47, 49, 51, 54..59, 61) | | 0 | | never | nothing |

Values are the same for all three races (Gold `dv.odb` and `Addon.odb` checked). Notes:

- **Territory gives no vision.** The town area and the outposts' territory discs are separate
  bookkeeping (`economy.md` 11); nothing in the territory messages touches the cell counter.
  Building outside the territory (mine, harbour, shipyard, town hall) changes nothing about vision.
- **Construction sites never see**, whatever the type: the object placement path adds unit vision
  only for kind ≠ 1 (base `00448690`, Gold `0x44C7DE`..`0x44C811`), and a site is never active.
  Its builders, while standing on the map, see with their own 5 cells.
- **The shipyard lifts no fog** in the original. Once its builders leave, the area around it is
  only explored (half light) unless a unit or ship is nearby. Ships leave the yard as units and
  see from their own record radius. Porters waiting inside to be retyped see nothing.
- **The harbour** sees 6 from completion on (no operator, so it is active at once).
- **The mine** (also allowed outside the territory) sees 8 only while active. After completion it
  explores its 8-disc once (half light), then stays dark until its miner enters.
- **Measured from the anchor cell**, the footprint's maximum corner, with the strict disc
  dx² + dy² < r² (section 2). The disc reaches r − 1 cells along the axes from that corner, so it is
  lopsided around the footprint: for a 3 × 3 harbour (r 6) it reaches 5 cells past the footprint
  on the +x / +y sides but only 3 past it on the −x / −y sides. A mine's r 8 covers 193 cells,
  7 along the axes from its corner.
- **Units inside** buildings (garrisons, operators, trainees, residents) and **passengers** inside
  a transport ship see nothing (taken off the map, section 3).
- **Ships** are units (kind 0): the same add and remove per step as any unit (Gold `0x44C811`,
  remove `0x44CA47`), radius from `Addon.odb` (Amazons 8/8/12/12, Pimmons 8/10/12/12, Sajiki
  8/8/10/12 for types 64..67).
- **Foreign buildings:** only embassies (relation ≠ 0) and, in Gold, every building with record
  flag 0x20 (market and harbour) at peace (relation 3): `0x43A7C0`..`0x43A7D9`. A foreign shipyard
  or mine never gives vision.
- **Fog switch and explored state are the same in Gold**: display flags at `0x4BCD10`, reset to
  0x3A per map (`0x411AFD`), MAGICEYE toggles bit 0x08 (`0x443DF0`). Add-on maps (stored terrain,
  island free play) store no fog state and start unexplored.

*Our build (October 2026):* `Vision.update` (`src/client/vision.ts`) already followed this table
(the shipyard's missing vision is the original's rule, not a bug). Changed to match 13: seen
flags come only from new discs and from any footprint cell. Tests: `test/fog-buildings.test.ts`.

---

## 4. Update cadence (C)

- **Event-driven, never periodic.** There is no sweep that clears visibility and recomputes it.
  Each add/remove happens inside the display handler of the message that caused it (step, create,
  enter/leave, death, activate/deactivate, relation change).
- **Units:** one remove at the old cell plus one add at the new cell, at the start of every step.
  On flat ground a porter steps every 6 ticks straight and 9 diagonally (units-and-jobs.md 4.1),
  so vision moves cell by cell at that pace.
- **Decay to explored:** a cell turns from visible to explored-only the moment its last disc is
  removed (counter 0). The dirty bit makes it redraw in the next frame.
- **Minimap:** the visible layer is rebuilt by an incremental pass over all display objects. The
  pass is a tickable polled from the main loop. It handles **50 objects per poll**, and after the
  last object it swaps the buffers and redraws the minimap (`0044c060`, constructor `0x40C49D`
  sets 50; swap `0044c7a0`). Toggling a minimap layer forces a full pass at once (`0044e090`).
  The minimap visible state therefore lags the world by up to one pass (frame-rate dependent,
  not tick based).

---

## 5. Effects on rendering

### 5.1 Terrain (C, `0043d220`, `0043d700`, `0043dc70`, `0043e4c0`; vertex flags from `00445e40`)

The frame builder copies each cell's flags and a visible bit (counter ≠ 0) into the vertex
record. Each terrain vertex then gets a grey level from its light value L:

| fog bit | vertex state | grey level |
|---|---|---|
| off | any | L |
| on | visible | L |
| on | explored, not visible | L / 2 (integer halving) |
| on | unexplored | 0 (black) |

Levels are interpolated across each quad (Gouraud), so fog edges are soft ramps one cell wide.
All four terrain renderer variants apply the same rule.

### 5.2 Objects in the world view (C, `00445e40`)

Objects are drawn from their anchor cell. With fog on, an object is drawn when:

- its **seen** flag is set and its anchor cell is **explored**, or
- its seen flag is clear and its anchor cell is **visible**.

Since only static objects ever get the seen flag:

| object | drawn on visible cells | drawn on explored, not visible cells |
|---|---|---|
| units (any race), animals | yes | **no** |
| buildings and sites (any race), trees, stones, bushes, crops, rubble | yes | only if seen at least once |
| projectiles and effects | (handled by their own draw path; I) | |

- **No "last seen" memory.** A remembered building or tree is the live display object. If it is
  destroyed, felled or harvested away, it disappears from the fogged area as soon as the
  simulation removes it, and new buildings in fog stay invisible (C: the seen flag lives on the
  object and there is no separate ghost list).
- A static object created inside an already visible area is not marked seen until some later
  vision add covers it. If all viewers leave first, it vanishes in the fog (C, quirk).
- The completion-only explore (`0044a4b0`) never sets seen. Trees around a watchtower without
  a scout are therefore not drawn until something actually sees them (C, quirk).
- **Town-border markers** (the border stones) are drawn only on visible cells (C, `00445e40`).
  Placement and drawing: `docs/rendering/territory.md`; territory rules: `economy.md` 11.

### 5.3 Sprite brightness (C, `00435850`)

A drawn object's brightness value is 64 + its cell's light value (capped at 255). With fog on, it
is halved when the object's cell counter is 0, unless the object has the never-dim flag (+0xA8).
Only bit 7 of the value is used, so in effect the terrain light never shades sprites: an object is
drawn at full colour, or at exactly half colour when halved. Remembered buildings and nature in
the fog thus appear at half brightness. Details: `docs/rendering/objects.md` 2.2.

### 5.4 Minimap (C, `0044c060`, `0044a400`, `0044d230`)

Scale: s = 152 / mapsize (pixel = cell × 152 / mapsize, integer).

- **Explored layer:** every add and explore-only operation (section 2) also ORs bit 0x01 into the
  back buffer in a disc of radius (r + 1) × 152 / mapsize. This disc uses ≤ (not <) and wraps
  at 152. Bit 0x01 survives every pass.
- **Visible layer (per pass):** for each display object that owns its anchor cell (the cell's
  object index is this object):
  - Local race, not a criminal, and (not a building, or building vision on): OR 0x02 in a disc
    of radius r × 152 / mapsize (≤) around its pixel.
  - Foreign embassy with relation ≠ 0, or foreign market with relation 3, with building vision on:
    the same.
- **Marker:** code = race bit (0x04/0x08/0x10) or nature class (tree 0x20, stone 0x40, bush or
  animal 0x60), plus 0x80 when the object is not static. It is plotted only if the matching layer
  toggle is on (buildings: kind 1; units: kind 0; resources: kind 2), and only if the object is
  mobile **or** already seen. The marker is a radius-1 plus shape (5 pixels).
- **Pixel colour** (fog on): visible pixel → full colour (terrain, marker overlay and town-area
  tint); explored pixel → half brightness, without markers of mobile objects (0x80) and
  without the town-area tint; otherwise black. With fog off, every pixel uses the visible
  rule.

So the minimap shows enemy units only where the local race currently sees, and remembers
buildings and resources at half brightness. This matches the handbook's description of the
minimap.

Map sizes and the scaled radii (r × s, (r + 1) × s):

| map | scout 15 | soldier 10 | civilian 5 | town hall 25 | watchtower 30 |
|---|---|---|---|---|---|
| 128 | 17, 19 | 11, 13 | 5, 7 | 29, 30 | 35, 36 |
| 256 | 8, 9 | 5, 6 | 2, 3 | 14, 15 | 17, 18 |
| 512 | 4, 4 | 2, 3 | 1, 1 | 7, 7 | 8, 9 |

---

## 6. Effects on interaction

- **Selection:** clicks and drag boxes test only the objects drawn this frame (the drawn list
  `0x4B3D94`, rebuilt by `00445550`; click test `00440e40` with pixel-accurate sprite alpha,
  box `00441440`). Hidden units and unseen buildings cannot be selected, inspected or targeted
  with the mouse (C). Hit rules, category priority, the blue selection tint and the click
  sounds: `docs/rendering/objects.md` 7-8.
- **Commands into the fog:** move orders on the ground (world view or minimap right-click) need
  no visibility. Any cell can be targeted, explored or not (C: no fog check in the command
  paths).
- **Building placement:** the client-side placement preview uses the type's forbidden mask
  **plus 0x80** (`00441e80` setup at `0x441E4B`). In the cell-flag functions (`00447f20`,
  `00451510`) bit 0x80 means "cell counter is 0, not currently visible". So every cell of the
  footprint grown by one cell must be **currently visible** for the preview to be valid. The
  simulation's own check (`00451780`) uses the mask without 0x80 and accepts any cell (C). The
  click runs the same test with the same stored mask again and sends no build command when it
  fails (C, `0x440C73`; Gold `0x444CF7`). This holds for **every** building type, the mine, the
  town hall and the add-on harbour and shipyard included: explored-but-fogged cells are refused
  like unexplored ones. **Founding a town** is no exception: the founder's `GRUENDEN` button is a
  build button for type 40 and uses the same placement start, the same stored mask with 0x80
  and the same click test; only the command sent differs (0x13 instead of 0x17). Nothing is
  re-tested when the founder later walks to the site (`units-and-jobs.md` 6.1.1, 11.1). The special status of those four types is the territory exemption
  (`economy.md` 11.7), not a fog exemption (`units-and-jobs.md` 6.1.1, with the Gold mine
  preview quirk).
- **Death effects** play only for drawn objects (combat.md 6), so deaths in the fog are silent
  and invisible (I: same drawn-list test).
- **AI:** no vision. All AI scans and choices read the simulation directly (C for the area scan
  `0044a7c0` and the AI code paths in `ai-diplomacy-trade.md`, none of which reads the cell
  counter or the explored bit). The AI's exploring scouts (job 0x28) are cosmetic: they keep no
  exploration memory.

---

## 7. Map wrap (torus) (C)

Every disc loop wraps each coordinate by adding or subtracting the map size until it is in range.
The minimap discs wrap at 152 pixels. A source near an edge therefore reveals on the opposite
edge too, and the explored state has no seams. Minimap pixel and cell positions both use the
same modular arithmetic.

---

## 8. MAGICEYE cheat and other toggles (C)

- The world view keeps a 10-character ring of typed letters. After each key it compares the
  ring's tail with 12 cheat words (table `0x4AFB58`, compare loop at `0x43FBF3`): CASHCOW, RAIN, LUMBERJACK,
  STONEMASON, IRONMAN, IAMHUNGRY, WARTIME, CHOCO, JUICE, LOLLY, **MAGICEYE**, WINNER.
- MAGICEYE flips fog bit 0x08 and forces a full world redraw (`0x43FD70`). Typing it again turns
  fog back on. The vision counters and explored bits keep being maintained either way, so turning
  fog back on immediately shows the correct state.
- Cheats are ignored while the global at `0x4B3B1C` is set (I: the network session object, so
  no cheats in multiplayer).
- The fog bit is reset to on at every new map and every load (`0040e970`).
- There is no other fog setting: no menu option, no mission flag, no free-play parameter.

---

## 9. Simulation or display?

**Display only, per machine (C, with one I).**

- All vision updates run in display-message handlers on each machine, filtered by that machine's
  local race. In a network game every machine receives the same messages and keeps its own fog
  (C: messages are sent to every connection, `004551c0` loop; 0x5C goes only to the two players
  concerned).
- The only simulation-side reader of the counter is the cell-flag bit 0x80 (`00447f20`,
  `00451510`). None of the simulation masks found use that bit: movement 0x3E, path search 0x3C,
  placement 0x87E / 0x67E / 0x97E / 0x107E (+0x100 for the AI), 0x17E, 0x10, 0x1003F. Only the
  client preview adds 0x80 (C for these masks; I that no other caller passes a mask containing
  0x80, because several callers take the mask from a parameter).
- Gameplay results (combat scans, AI targets, harvesting, pathing) do not depend on fog. A
  lockstep rebuild can keep fog out of the deterministic state and the state hash.

---

## 10. Quirks worth knowing (C unless marked)

1. **Shared-cell leak:** a cell holds a single object index. When a unit dies, its vision is
   removed only if the cell's index is still its own (`00434840`). If another unit stepped onto
   the same cell later, the dead unit's disc is never removed, and those cells stay "visible"
   for the rest of the game. A rebuild should not copy this (recommendation).
2. The minimap visible pass also only counts objects that own their cell index, so a unit that
   shares a cell is missing from the minimap visible layer until it moves (C).
3. Vision runs one cell ahead of the sprite during a step (section 3).
4. Byte counter overflow beyond 255 viewers (section 1.1, U whether it ever happens).
5. Explore-only on completion does not mark objects as seen (5.2).

---

## 11. Open points

- Whether map creation explicitly zeroes cell bytes +2/+3, or they are zero by allocation (I).
- ~~The exact gating of the placement click by the preview result.~~ Resolved: the click re-runs
  the test with the preview mask (section 6).
- The global `0x4B3B1C` = network session (I).
- How projectiles and effects are culled in fog: they are not in the anchor-cell object path (U).
- Exhaustive proof that no simulation caller passes a mask with bit 0x80 (I, section 9).

## 12. Corrections to other documents

- `units-and-jobs.md` 6.1 lists cell flag 0x80 as "(I) not owned". It means **"not currently
  visible to the local race"** (cell counter 0). The flag 0x02 there is "unit present" (kind 0).
- `ai-diplomacy-trade.md` 3.4 says message 0x5C makes foreign embassies "selectable" and markets
  "inspectable". It actually **adds or removes those buildings' vision discs** for the other
  player. They become visible, and so selectable, as a consequence.
- `side-panel.md` 6: the half-brightness rule for explored pixels also drops markers of mobile
  objects and the town-area tint (5.4 here).

---

## 13. Implementation notes (our engine)

Assumptions: `World` with entities at (x, y) in 1/256-cell sub-units, deterministic 100 ms
ticks, torus map of size N (power of two), players 0..P−1.

**Keep fog out of the deterministic state.** Nothing in the simulation reads it (section 9). Put
it in a `Vision` module that the world notifies through events (entity entered cell, left cell,
building activated or deactivated, relation changed, entity removed). Do not include it in
`World.hash()`. Computing it for **every** player on every client is cheap and stays
deterministic. It gives spectator and replay views for free. The renderer reads only the local
player's layer.

**Storage per player:**

- `count: Uint16Array(N*N)`: viewer counter. Use 16 bits to avoid the byte wrap.
- `explored: Uint8Array(N*N)` (or a bitset): 0/1, never cleared.
- `seen: Uint8Array(maxEntityId)` or a `Set<number>`: per static entity (building, tree, stone,
  bush, crop, rubble).
- `dirty`: a list of changed cells, or a dirty-rect/chunk mask, for the renderer.

**Disc stamps:** precompute, per radius used (5, 6, 8, 10, 15, 25, 30), the offset list
{(dx, dy) : dx² + dy² < r²}. A stamp is `idx = ((y+dy) & (N-1)) * N + ((x+dx) & (N-1))` for each
offset. Add: `if (count[i]++ === 0 || !explored[i]) markDirty(i); explored[i] = 1;` then for static
entities occupying cell i, set `seen`. Remove: `if (--count[i] === 0) markDirty(i)`.

**Seen is set by adds, not by being visible** (C, base `0044a250`, Gold `0x44F514`..`0x44F558`):
every cell of an added disc that holds a static object's index marks that object seen. A
building holds its index on **every footprint cell**, so a disc that touches any footprint cell
marks the building. A source that stays put (a building, a unit standing still) adds only once:
a static object created later inside its disc is not seen until some new add covers it. A rebuild
that recomputes visibility per tick should therefore mark seen only from discs that are new this
tick (a source that appeared, or whose centre or radius changed), not from the whole visible layer.
After loading a save, the stored seen flags stand; the sources present at load are not new adds
(I: the counters are saved with the cells, 1.5, so a re-add at load would double them).

**When to stamp:**

- Units: compute the cell as `x >> 8, y >> 8`. When it changes, remove the old disc and add the new
  one. To match the original, switch at the start of each path step, when the simulation commits
  to the destination cell. Units entering a building remove their disc; leaving adds it. Death
  removes it (always remove, unlike quirk 10.1).
- Buildings: add at activation (state 2), remove at deactivation or destruction, centred on the
  anchor (maximum-corner) cell. At completion, also run explore-only with the same radius.
- Diplomacy: on a relation change between A and B, add or remove the discs of the other side's
  active embassies (leaving or entering relation 0) and markets (entering or leaving 3), as in
  section 3. Apply the same tests at activation and deactivation.
- Remember each stamp's (centre, radius) on the source, so removal always mirrors the add.

**Renderer (client):**

- Terrain: per-vertex multiplier m = 1 (visible), 0.5 (explored), 0 (unexplored), multiplied
  into the vertex light before interpolation. Fog off (MAGICEYE): m = 1 everywhere. Upload `m`
  as a per-vertex attribute or as a small N × N texture sampled at vertices, and update only
  dirty cells.
- Sprites: units and animals are drawn only if `count[anchor] > 0`. Static objects are drawn if
  `count[anchor] > 0` or (`seen` and `explored[anchor]`), and darkened ×0.5 when
  `count[anchor] === 0`. Hide border stones outside visible cells.
- Picking: hit-test only what was drawn.
- Placement preview and click: invalid unless every cell of the footprint grown by one has
  `count > 0`, for every building type (mine, town hall, harbour, shipyard included; the founder's
  town hall uses this same test), and also
  while MAGICEYE has fog switched off (the test reads the counters, not the fog bit). Keep the
  simulation's placement check fog-free. In add-on island games, reproduce the Gold mine ghost
  quirk of `units-and-jobs.md` 6.1.1 in the ghost colour only, never in the click.
- Minimap: either reproduce 5.4 (separate 152 × 152 buffers with scaled discs, rebuilt by a
  periodic pass) or simply sample the cell layers per pixel. The second is simpler and more
  exact. It differs only by the original's slightly larger, coarser discs and its pass lag.
