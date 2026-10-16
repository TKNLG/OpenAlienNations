# Free-play world populator

What the game does after terrain generation ([terrain-gen.md](terrain-gen.md)) when a mission has
**no map file**: `Infinite.mdb` free play ("Erschaffe eine Welt") and multiplayer, terrain seed `-1`.
It places all nature (trees, bushes, stones, animals), builds the five point lists that a `.dvm`
map would otherwise supply ([dvm.md](dvm.md) "The five point lists"), picks start positions, and
gives every player its starting units.

Status: **specified from the code, not yet implemented.** Legend: **C** = read in the code,
**I** = inferred, *(uncertain)* = not settled.

Main functions (AN.exe): seed choice `00483da0`; world setup `00485a30`; list builder
`00485770`; resource-site wrappers `00484710` (forest), `00484aa0` (bushes), `004849b0` (stone);
cluster placer `00484ba0`; scatter passes `00485420`; site searches `00449c00` (with test
callback `00484810`) and `00449840` (with area test `00447cd0`); cell flags `00447f20`; distance
`0045aea0` / `00485310`; nature object constructor `004638d0`.

Notation: `n` = map size (128/256/512), `r` = the "Anzahl Rohstoffe" (resources) setting 0/1/2
(global `004af8a4`, see [front-end.md](../ui/front-end.md) 6.1). All coordinates wrap modulo `n`.
`rand()` is the MS C runtime generator of terrain-gen.md; `a % b` is C remainder (rand() is never
negative, so it is the ordinary remainder).

---

## 1. Order of events (C)

1. **Seed** (`00483da0`). If the record seed is -1 and there is no network session: seed the
   generator from the clock (`srand(time())`), then `seed = rand()`. In a network session the seed
   chosen by the host is used. Then the terrain is generated from `seed` (terrain-gen.md).
2. **World setup** (`00485a30`), only for seed -1:
   1. Clear the five point lists.
   2. Run the list builder (`00485770`, sections 4..7). It starts with **`srand(time())`** — the
      populator does not continue the terrain stream; it reseeds from the clock.
   3. The builder reports success or failure; on failure the game would draw `seed = rand()`,
      regenerate the terrain and repeat from 2.1. **The builder always reports success** (its only
      exit returns true, C), so this re-roll never happens (section 8).
   4. In a network session the host sends the terrain seed to all clients ("Sending
      GENERATETERRAINMESSAGE", a 5-byte message `0xFD` + seed).
3. **Computer players** are created (single player only, race order 0..2; mdb.md race blocks with
   *present* and *computer* set). A random AI profile draws `rand()` here
   ([ai-diplomacy-trade.md](../game/ai-diplomacy-trade.md) 1.2).
4. **Player placement** (section 9), race slots 0, 1, 2 in order.
5. If the mission names a map file it is loaded now ([dvm.md](dvm.md)); not the case in free play.

## 2. Shared machinery

### 2.1 Cell flags (C, `00447f20`)

The tests below use these bits of a cell's flag word:

| bit | meaning |
|---|---|
| 0x02 | a unit stands on the cell |
| 0x04 | a building covers the cell |
| 0x08 | special object (id 0xF000..0xF00F) |
| 0x10 | nature object (tree, bush, stone, animal, crop) on the cell |
| 0x20 | water: the cell's tile belongs to terrain class 11 |
| 0x40 | too steep (only from the area test, 2.4) |
| 0x100 | height > 250 (mountain) |
| 0x200 | 130 <= height <= 250 (hill band) |
| 0x400 | height < 130 (lowland) |
| 0x1000 | territory: belongs to an existing settlement (only from the area test, 2.4) |

Masks used: **0x17E** = 0x02|0x04|0x08|0x10|0x20|0x40|0x100 ("free land below 251"; 0x40 never
appears on a single cell, so for one cell it means: no object, not water, not mountain).
**0x13E** = 0x17E without 0x40. **0x117E** = 0x17E + territory.

### 2.2 Torus distance (C, `0045aea0`, `00485310`)

Per axis: `d = a - b`; the alternative is `d - n` if `d >= 0`, else `d + n`; take whichever has
the smaller absolute value. Then **`D = max(|dx|, |dy|) + floor(min(|dx|, |dy|) / 2)`** (an
octagonal approximation of Euclidean distance).

### 2.3 Ring walk (C, `00449c00`, `00449840`, `00484ba0`)

All three searches walk square rings outward around a start cell `(cx, cy)`:

- Ring `h` (h = 1, 2, 3, ...) starts at its corner `(cx+h, cy-h)`, then moves one cell at a time:
  `2h` steps in +y (to `(cx+h, cy+h)`), `2h` steps in -x, `2h` steps in -y, `2h` steps in +x, which
  ends on the starting corner again. So each ring tests `8h + 1` cells, the corner twice.
- After the last step of ring `h` the walk steps diagonally to `(cx+h+1, cy-h-1)`, the corner of
  ring `h+1`.
- Coordinates are wrapped after every step.

Differences between the users:

| user | tests the centre first? | stop rule |
|---|---|---|
| site search `00449c00` (radius `R`) | yes | ring scale `s = 2` if `R > 15`, else 1. After each failed test: give up if `h*s >= R`. So rings with `h*s < R` are walked completely and only the corner of the next ring is tested. R = 15 (s=1): rings 1..14 plus the corner of ring 15. R = 25 (s=2): rings 1..12 plus the corner of 13 |
| area search `00449840` (size `W x H`, radius `R`) | yes | `s = 2` if `W > 1` and `H > 1`, else 1; same rule. R = 35, 9x9: rings 1..17 plus the corner of 18. R = n/2, 6x6: rings 1..(n/4 - 1) plus one corner |
| cluster placer `00484ba0` | **no** (the first tested cell is `(cx+1, cy-1)`; the centre never gets an object) | at most 10,000 tested cells (about ring 49), or earlier when everything is placed |

On success a search returns the cell it stopped on (wrapped).

### 2.4 Site tests (C)

Both tests use a **square/rectangle whose maximum corner is the tested cell `(x, y)`**: the
footprint is `x-W+1 .. x` by `y-H+1 .. y`. The "ring" is the one-cell border around it
(`x-W .. x+1` by `y-H .. y+1`, minus the footprint).

- **Cluster site test** (callback `00484810`, size `S x S`, mask 0x13E): OR the flags of all
  footprint cells. The height range over the ring is computed and would add 0x40 if above 64, but
  0x40 is not in the mask, so **slope is ignored**. The site fits when `(flags & 0x13E) == 0`:
  no object of any kind, no water, no mountain in the square.
- **Area test** (`00447cd0`, size `W x H`, mask 0x117E): OR of the footprint cells' flags; plus 0x40
  if (max - min) of the ring heights is **greater than 64**; plus, because the mask has 0x1000, the
  territory test at the four points `(x, y)`, `(x-W, y)`, `(x, y-H)`, `(x-W, y-H)`: if any of them
  lies in a settlement's territory (half-resolution ownership map, `0044e3b0`) the site fails. The
  site fits when the masked result is 0.

## 3. The point lists (C)

Five lists of entries `{i32 x, i32 y, i32 z}` (the `.dvm` file stores them in this order). Entries
are appended at the end; `z` is always 0 here.

| list | content (free play) | filled in |
|---|---|---|
| 0 forest regions | forest-site centres (4) and forest-patch centres (6) | sections 4, 6 |
| 1 stone regions | stone-site centres (4) and stone-patch centres (6) | sections 4, 6 |
| 2 bush regions | bush-site centres (4) and **also every forest-patch centre** (6) | sections 4, 6 |
| 3 start candidates | the raw grid points of sites where all three clusters succeeded | section 4 |
| 4 start positions | chosen start points | section 7 |

The lists stay in the world after setup: the AI uses 0..3 (ai-diplomacy-trade.md), and list 4
loses one entry per placed player (section 9).

## 4. Resource sites and start candidates (C, `00485770`)

After `srand(time())`:

`count = r + 4` if `n == 128`, else `2r + 6` (128: 4..6 sites; 256/512: 6..10). For each site:

1. `x = (rand() % (n/8)) * 8`, then `y = (rand() % (n/8)) * 8` (grid points on multiples of 8).
2. **Forest site** (`00484710`): site search from `(x, y)`, radius 15, cluster site test with
   `S = 13`. If it fails, nothing else happens for the forest (no further random numbers). If it
   finds `(fx, fy)`: draw `a = rand()`, `t = rand()`, `b = rand()` in that order, then run the
   cluster placer (section 5) at `(fx, fy)` with
   trees `t % 5 + 5 + 10r`, animals `a % 3 + 1 + 3r`, bushes `b % 3`, stones 0, spread 2;
   append `(fx, fy, 0)` to list 0.
3. **Bush site** (`00484aa0`): first one `rand()` that is **discarded** (drawn even if the search
   then fails). Site search from the same `(x, y)`, radius 15, `S = 7`. If found: `b = rand()`,
   `t = rand()`, `s = rand()`; cluster with trees `t % 3`, animals 0, bushes `b % 3 + 4 + 3r`,
   stones `s & 1`, spread 1; append to list 2.
4. **Stone site** (`004849b0`): site search from the same `(x, y)`, radius 25 (ring scale 2),
   `S = 9`. If found: `s = rand()`, `t = rand()`; cluster with trees `t % 3`, animals 0, bushes 0,
   stones `s % 3 + 3 + 3r`, spread 3; append to list 1.
5. If **all three** searches succeeded, append the grid point `(x, y, 0)` (not the found sites) to
   list 3.

Each search starts from the original grid point, but sees the objects placed by the earlier
clusters of the same site, so the bush and stone sites usually end up beside the forest.

Quirk worth keeping: the site test checks the square *up-left* of the found cell (it is the
square's maximum corner), but the cluster then spreads in rings *around* that cell, so roughly
three quarters of a cluster lands outside the tested square.

## 5. Cluster placer (C, `00484ba0`)

Inputs: centre `(x, y)`, remaining counts `T` trees, `A` animals, `B` bushes, `S` stones, and a
`spread` value. Walk the rings around the centre (2.3, centre excluded). For every tested cell:

1. If all four counts are 0, stop.
2. Move to the next ring cell `(cx, cy)`. `d` = torus distance (2.2) from the centre.
   Read the cell's flags.
3. `rand()`. Continue only if `rand() % (d + spread) == 0` **and** the cell has none of 0x17E
   (empty, not water, height <= 250). Otherwise go to step 7. (So a cell at distance `d` is used
   with probability `1/(d + spread)`; a larger spread gives a looser cluster.)
4. Draw weights, in this order, one `rand()` each **only for counts that are not 0**:
   `wT = rand() % (T+1)`, `wA = rand() % (A+1)`, `wB = rand() % (B+1)`, `wS = rand() % (S+1)`.
   A weight whose count is 0 is -2 and consumes nothing.
5. Terrain bias: if the cell is in the hill band (flag 0x200), double `wS`; otherwise (lowland)
   double `wT`, `wA` and `wB`.
6. Choose (first match wins), decrement that count and create the object at `(cx, cy)`:

   | condition | object | type | further `rand()` |
   |---|---|---|---|
   | `wA > wT` and `wA > wB` and `wA > wS` and `A > 0` | animal | `33 + rand() % (animalTypes - 1)` = **33..36** | type; then the animal's constructor draws two more (5.1) |
   | `wB > wT` and `wB > wS` and `B > 0` | bush | `13 + (rand() & 3)` = 13..16 | type |
   | `wS > wB` and `S > 0` (`wT` is not compared) | stone | `29 + (rand() & 3)` = 29..32 | type |
   | `T > 0` | tree | `9 + (rand() & 3)` = 9..12 | type |
   | otherwise | nothing | | |

   `animalTypes` is the number of `dv.odb` nature records with behaviour class 7 (5 in the shipped
   data: 33..37), so **37 (Hase) is never placed** by the populator (C; the `- 1` looks like an
   off-by-one in the original).
7. Stop after the 10,000th tested cell.

Notes: the created object occupies its cell, so later tests (and the second visit of a ring corner)
skip it. Counts are maxima: on crowded ground, water or mountains the 10,000-cell limit can end a
cluster early. Tree, bush and stone types are chosen uniformly; **the terrain class does not
choose the tree type**.

### 5.1 Nature object initial state (C, `004638d0`)

Created as finished map objects ("not planted"):

| class | state |
|---|---|
| tree (8) | growth stage 4 (fully grown), no growth job; contains `dv.odb +0x120` wood (6 or 4) |
| bush (9) | 5 food, no job |
| stone (13) | 14 or 12 stone (type 32: 12), no job |
| animal (7) | HP from `+0xAC` (10), food `+0x120`; its wander job is created (the job's constructor draws `rand() % 3`, stored at job +0x2C; AN `00474360`, Gold `0047de20`) and scheduled after `rand() % 40 + 1` ticks — **two `rand()` inside the cluster placer** right after the type draw, in this order (C; earlier versions of this table said one) |

The amount is copied into both the "initial" and "remaining" fields (odb.md 7). Height (z) is read
from the terrain cell. Cocoa, mushrooms and maggots (17..28) and rubble (38) are never created by
the populator; crops come from farmers.

## 6. Scatter passes (C, `00485420`)

Run once, after the resource sites. Note the flag test uses the **row start `y`**, while the patch
is placed at the jittered row `ly`.

### 6.1 Pass 1: large patches

Rows `y = 0, 48+36r, 2(48+36r), ...` while `y < n`. In each row, `x` starts at 0; each step:

1. `j = rand() % 48`. If `y + j < n - 1`: `ly = y + rand() % 48` (a **second, fresh** draw);
   else `ly = n - 1` (no draw).
2. If cell `(x, y)` is not a mountain (no 0x100):
   - `rand() & 1 == 0` → **stone patch**: if cell `(x, ly)` has none of 0x17E: `a = rand() & 3`,
     `b = rand() & 1`; cluster at `(x, ly)` with trees `b`, animals 0, bushes 0,
     stones `a + 2 + 2r`, spread 3; then append `(x, ly, 0)` to list 1. (If the cell is not free:
     nothing, no draws.)
   - otherwise → **forest patch**: append `(x, ly, 0)` to list 0 **and** list 2 (no cell test);
     `a = rand() & 3`, `b = rand() & 3`, `c = rand()`; cluster at `(x, ly)` with
     trees `c % 10 + 15 + 8r`, animals `b + 3`, bushes `a + 2 + 2r`, stones 0, spread 2.
3. `x += rand() % 48 + 48 + 36r` (always drawn); continue while `x < n`.

### 6.2 Pass 2: small clumps

Rows `y = 0, 12, 24, ...` while `y < n`; `x` starts at 0; each step:

1. `j = rand() % 12`; `ly = y + rand() % 12` if `y + j < n - 1`, else `n - 1`.
2. If cell `(x, y)` is not a mountain: `k = rand() % (10 - 3r)`:
   - `k = 0`: cluster at `(x, ly)` with bushes `rand() % 3 + 1`, spread 3;
   - `k = 1`: stones `rand() % 3 + 1`, spread 5;
   - `k = 2`: trees `rand() % 3 + 1`, spread 5;
   - otherwise nothing. (Each kind has probability 1/10, 1/7, 1/4 for r = 0, 1, 2.)
3. `x += 12 + rand() % 12`; continue while `x < n`.

Pass 2 adds nothing to the lists.

### 6.3 Resulting amounts (maximum objects per cluster)

| cluster | trees | animals | bushes | stones | spread |
|---|---|---|---|---|---|
| forest site | 5..9 + 10r | 1..3 + 3r | 0..2 | - | 2 |
| bush site | 0..2 | - | 4..6 + 3r | 0..1 | 1 |
| stone site | 0..2 | - | - | 3..5 + 3r | 3 |
| forest patch (pass 1) | 15..24 + 8r | 3..6 | 2..5 + 2r | - | 2 |
| stone patch (pass 1) | 0..1 | - | - | 2..5 + 2r | 3 |
| clump (pass 2), one kind only | 1..3 (spread 5) | - | 1..3 (spread 3) | 1..3 (spread 5) | see left |

Pass-1 patch spacing: 48..95 cells (r=0) up to 120..167 cells (r=2) along x, 48/84/120 rows apart.
(So "Viel" makes patches **bigger but sparser**, while pass 2 gets denser.)

## 7. Start positions (C, `00485770`)

After the scatter passes, for each start candidate in list order:

1. `d` = the smallest torus distance (2.2) from the candidate to any entry already in list 4
   (each entry wrapped first); 32767 if list 4 is empty.
2. If `d > n / 3` (integer division: 42, 85, 170): area search (2.3, 2.4) from the candidate with
   a **9 x 9** footprint, radius 35, mask 0x117E. If a cell `(fx, fy)` fits, append
   **`(fx - 3, fy - 3, 0)`** to list 4 (not wrapped, so values like -3 occur, as seen in shipped
   `.dvm` files).

No random numbers are used. **Nothing is levelled**: the 9 x 9 area is only tested (empty of all
objects, no water, no mountain, border height range <= 64). The `-3` moves the point from the
area's maximum corner towards its middle (the 9 x 9 area spans `fx-8..fx`), so the 6 x 6 town-hall
test of section 9 (`fx-8..fx-3`) normally fits at once.

Start positions are chosen after all nature exists, so nature is never excluded around them;
instead they avoid it. Candidates whose 9 x 9 search fails are skipped silently.

## 8. The re-roll loop (C)

`00485a30` loops "clear lists, run builder, if it failed then `seed = rand()` and regenerate the
terrain". The builder returns true unconditionally (single exit, constant 1 in AL), so the loop body
runs exactly once and the terrain seed is never changed here. **There is no check that list 4 has
as many entries as there are players.** With too few, the placement step reads the empty list's
sentinel *(uncertain: undefined behaviour in the original; probably rare because 4..10 sites are
tried)*.

## 9. Players and their start (C, `00485a30`)

For race slots 0 (Amazons), 1 (Pimmons), 2 (Sajiki) in that order, for every slot that has a
player:

1. **Player setup** (`0045d780`): in game mode 4 (free play) the development setting grants
   research level 12 (Mittel) or 20 (Hoch) to the race's invention table; then start gold
   `+= race block +0x0C` (mdb.md; overwritten by the stock setting, front-end.md 6.2), clamped at
   >= 0.
2. Only when the mission has no map file:
   1. `p` = the **first** entry of list 4, removed from the list. So slot order decides: Amazons
      take start 0, Pimmons start 1, Sajiki start 2, whichever race is human.
   2. Area search from `p`: **6 x 6**, radius `n/2`, mask 0x117E (the territory bit now matters: a
      computer town founded for an earlier slot blocks its area). On success `p` becomes the found
      cell; **on failure `p` is kept unchanged** (the result is not checked).
   3. **Computer player (single player only):**
      - found a settlement at `p` (`0045d370` / `00458cd0`): creates the **town hall (type 40)**
        there, first as a construction site;
      - finish it at once (`004602d0`, `0045fa40`): full hit points, state complete; because the
        owner is a computer player its AI jobs start; it spawns **one builder (11) and two porters
        (9)**; because the race has fewer than 2 settlements, the town's nine goods are set from
        the race block's first column (with the stock override: 15/20/25 each of goods 0..5);
      - create a **city founder (type 10)** at `p` as the town hall's resident, home town = the new
        settlement; population and unit counters +1; needs re-evaluated (draws no random numbers
        at this population, I).
      Result: town hall + founder + builder + 2 porters (population 4).
   4. **Human player (and every player in a network game):** one **city founder (type 10)** at
      `p`, belonging to the player but to no town, facing `rand() % 8`. Nothing else: no town
      hall, no goods. Start goods arrive when the player's first town hall is completed
      (`0045fa40`: builder + 2 porters + column-1 goods, mdb.md).

**Camera:** no free-play code sets the view; the view object starts at cell (0, 0) *(uncertain;
no other writer of the start position was found)*.

## 10. Random numbers, complete order (C)

1. Terrain: `srand(time())`, `seed = rand()` (single player), then `srand(seed)` and the terrain
   generator.
2. Populator: `srand(time())`.
3. Per resource site: `x`, `y`; forest (if found: 3 + cluster); bush (1 discarded; if found: 3 +
   cluster); stone (if found: 2 + cluster).
4. Pass 1, then pass 2, in row/column order as in section 6.
5. Inside every cluster: per tested cell one acceptance draw; for accepted cells the weight
   draws, the type draw, and for an animal its two constructor draws (wander-job `% 3`, then
   delay `% 40 + 1`).
6. Start positions: none.
7. Computer player creation: one per AI with random profile.
8. Placement: one facing draw per human founder.

Everything after step 2 is clock-seeded in the original, so nature differs every start even for
the same terrain seed (single player restarts draw a new seed anyway). In multiplayer only the
terrain seed is sent; how clients obtain the host's nature objects was not traced *(uncertain)*.

## 11. Object types used (C, group 6 of `dv.odb`, see odb.md A.4)

| types | object | by |
|---|---|---|
| 9..12 | Baum (tree) | all clusters |
| 13..16 | Busch (bush) | all clusters |
| 29..32 | Stein (stone) | all clusters |
| 33..36 | Fasterator, Necktor, Echse, Sumpfling | forest sites and forest patches only (the only clusters with animals) |
| race group, 40 | Rathaus (town hall) | computer players |
| race group, 10 / 11 / 9 | Stadtgründer / Baumeister / Träger | section 9 |

## 12. Corrections to other documents

- [dvm.md](dvm.md) list 4 "after levelling a 9 x 9 area": no terrain is changed; the 9 x 9 area is
  tested for free, flat-enough ground (section 7).
- [terrain-gen.md](terrain-gen.md) "re-rolls until the start positions are valid": the loop exists
  but never re-rolls (section 8).
- [mdb.md](mdb.md) "otherwise the new settlement just gets 10 food": a third or later town hall
  sets **10 wood, 10 stone and 10 food** (goods 1, 2, 4; `0045fa40`).
- [front-end.md](../ui/front-end.md) 6.2: the resource-site counts and cluster growth match; the
  populator is now specified here.

## 12a. Gold Edition (`dvge.exe`)

- The cluster placer (`0048ffc0`) has **no terrain bias** (step 5 above is missing), in base free
  play too. Everything else of the base populator matches AN.exe.
- Add-on free play (`InfiniteAO.mdb`) uses a separate branch: no clock reseed, resources and one
  start per large island, palms/aloe/venus/crab/gecko instead of trees/bushes/rubble, fish in
  open sea, and a builder that can fail and **does** trigger the re-roll of section 8. See
  [addon.md](addon.md) 10.

## 13. Open points

- Client-side handling of a network game's nature (section 10).
- Free-play start camera (section 9).
- Behaviour when list 4 has fewer entries than players (section 8).

---

## Implementation notes (TypeScript engine)

- **RNG.** Do not reseed from the clock. Continue the deterministic `MsRand` from the terrain
  generator's final state (or seed a second `MsRand` from the terrain seed) so that every client
  builds the same world from the setup. Since the original output is clock-dependent anyway, any
  deterministic stream is faithful; keep the **call order** of section 10 so the populator is
  testable against itself and reproducible. If `spawn()` for animals draws from the world RNG,
  make sure both constructor draws (job `% 3`, then delay `% 40 + 1`) happen in the same place
  (right after the animal's type draw), or draw them in the populator and pass them in.
- **Cell flags.** Keep an occupancy grid filled by `spawn` (unit / building / nature per cell). A
  cell is "free" (mask 0x17E) when unoccupied, `cls != 11` and `height <= 250`. Hill band =
  `130 <= height <= 250`. The site test (2.4) ignores slope; the area test uses a border height
  range `> 64` and the territory map (ignore territory if it is not modelled yet: at population time
  it only matters between computer towns).
- **Wrapping.** Wrap every coordinate with `((v % n) + n) % n` before indexing; store list-4 entries
  unwrapped (`fx - 3`), as the original does.
- **Ring walk.** Implement once as a generator yielding `(x, y)` in the order of 2.3 with a flag for
  "include centre"; the two searches add the `h * s >= R` stop rule, the cluster placer the
  10,000-cell limit.
- **Spawning.** Nature: `spawn(type, 6, x, y)` with trees fully grown (stage 4) and amounts from
  `dv.odb`. Players: computer slot → settlement + completed town hall at `p`, then builder, two
  porters and founder inside it, goods from the race block column 1; human slot → one founder
  (race group, type 10) at `p` with facing `rand() % 8`.
- **Robustness (deviation).** The original never re-rolls. The rebuild should make the loop real:
  if list 4 ends with fewer entries than players, draw `seed = rand()`, regenerate terrain, clear
  everything and repeat; this is deterministic and keeps all clients in step.
- **Camera.** Recommended: centre the view on the human player's founder (the original appears to
  start at (0, 0)).
- **Lists.** Keep the five lists on the world for the AI (lists 0..3) and for saving.
- **Cost.** Worst case is a few thousand clusters x 10,000 tested cells on a 512 map with much water
  or mountain; cheap enough for a one-off load, but avoid allocating per tested cell.
