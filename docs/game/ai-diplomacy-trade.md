# Computer player, diplomacy and trade (behaviour spec)

Status: **second pass (audit of the decision layer, 2026-10).** The computer player's jobs, its
build, training, gathering, research, slider, trade, founding, defence and attack rules, the
diplomacy state machine (embassy, diplomat, offers, acceptance) and the market/merchant trade model
are traced in AN.exe. The second pass re-read the planner, training, gang, defence, strategy and
army routines against the code and corrected or completed: the meaning of town +0x48, the "free
unit" test, the house rule, the placement geometry, the order check, the outpost refill (dead
code), the defence and army target assignment (all fighters are used, not 3 or 5 per target), the
scout list, the order of the sub-steps (0.1), the rand() order, and added the economy safeguards
and the dead end that follows from them (1.15) and who attacks whom in free play (2.6). A third
pass (2026-10, "do raided AI towns brick themselves?") searched every place that creates or
retypes a unit, every reader of the computer flag and every goods gift for a recovery path (none
exists, 1.15), re-read both army tactics instruction by instruction (2.5 corrected: target
buckets, caps, keep rule), the attack gate and target loop (2.4, 2.6), and the anchor snapping
(1.5 corrected: always to the nearest border block). Combat
mechanics (how an attack job hits, damage, patrols, hostility of units) belong to
`docs/game/combat.md` and are only referenced here.

Sources: decompiled and disassembled AN.exe (addresses cited as evidence; no code is reproduced),
the virtual methods recovered as described in `units-and-jobs.md` section 13, `dv.odb`, `dv.wdb`,
`Mentor.tdb` (cited `mentor#N`), `DV.tdb` (cited `T#N`), the mission records (`mdb.md`), the map
point lists (`dvm.md`) and the handbook (`rules-from-manual.md`, cited "handbook p. N").

Legend: **C** confirmed in code; **I** inferred (naming, data flow, partial trace); **U** unknown.

Notation as in `economy.md`: "town +0x44" is the 32-bit field at offset 0x44 of the town object,
"player" is the nation object, a "tick" is one scheduler step (about 10 per second at normal
speed, `economy.md` 1.2). Unit and building numbers are object types inside the race's group
(`odb.md`). "rand()" is the shared C runtime generator (`economy.md` 3.2); the AI draws from it
heavily, so a bit-exact rebuild must call it in the same order (the order is given where it was
read).

Related documents: `economy.md` (money, happiness, births; AI towns skip happiness and use a
criminal divisor of 36), `units-and-jobs.md` (scheduler, jobs, dispatcher, construction,
training), `combat.md` (fighting, crime, police), `mdb.md` (relations and AI profile per race
block), `dvm.md` (map point lists), `idb-wdb.md` (research tree, weapons), `ui/side-panel.md`
(market, trade route and diplomacy panels).

---

## 0. Overview

| layer | object | where | period | first run | evidence |
|---|---|---|---|---|---|
| player "think" job (kind 0x30) | one per computer player | player +0x228 | 150 | 1 tick after the player is created | C `0045cdf0`, `00468280`, run `004685d0` |
| town planner (kind 0x32) | one per computer town | town +0x1C | 50 | 1 tick after the town hall becomes active | C `0045d370`, `0046a8a0`, run `0046c890`, started in `0045fa40` |
| town economy (kind 0x33) | one per computer town | town +0x18 | 50 | 16 ticks after activation | C `0046da60`, run `0046ecd0` |
| town military (kind 0x34) | one per computer town | town +0x20 | 50 | 33 ticks after activation | C `0046c920`, run `0046d9a0` |
| attack army (kind 0x35) | at most one per computer player | player AI job +0x38 | 50 | rand() mod 50 ticks after creation | C `00465710`, run `004673d0` |
| founding mission (kind 0x36) | created on demand | (not stored) | 50 | 1 + rand() mod 50 | C `00467ea0`, run `00467f80` |
| explore (kind 0x28) | per scout sent exploring | scout +0x30 | - | 1..5 ticks | C `00468e10`, run `0047c970` |

- The three town jobs are created together with the town when the owner is a computer player
  (`0045d370`, also `0045e4b0` on load) but only scheduled when the town hall becomes active
  (`0045fa40`). When a computer town's town hall is deactivated or destroyed, the three jobs are
  cancelled (`0045ff30`). (C)
- Kind 0x31 is the common base of 0x32..0x36 (constructor `0046a790` registers each with the
  player's AI job, `00468530`); it is never scheduled itself. (C)
- Unit **group ids** (unit +0x48) are how the AI reserves units for a purpose. A unit counts as
  "free" for a purpose only if its group id is the one asked for (`0045b110`, `0045b260`). (C)

| group id | meaning | set by |
|---|---|---|
| 0 | not reserved | default; released units |
| 50 (= kind 0x32) | town porter gang: the only porters the dispatcher uses in a computer town | `0046aed0`; dispatcher asks for 50 in AI towns (`0046fa10`, `0046f820`) |
| 51 (= kind 0x33) | economy gangs: woodcutters, stonemasons, hunters, bush porters; merchants | `0046ea30`, `0046dd50` |
| 52 (= kind 0x34) | town defence group (soldiers, hunters) | `0046cb20` |
| 53 (= kind 0x35) | member of the attack army | `00465ad0` |
| 54 (= kind 0x36) | founder on a founding mission | `00467f80` |

**Two unit selections** are used throughout (C):

| name below | test | code |
|---|---|---|
| **free** unit of group g | alive, group id = g, and either (outside every building and no job) or (on a leisure visit, unit +0x78 = -1, unless it is inside a building with a running unblocked job). This is the dispatcher's own "free" test (`units-and-jobs.md` 5.4): a porter visiting a house **is** free | `0045b110` |
| unit of group g **outside** | group id = g and outside every building; **any job** | `0045b260` |

"Free porters", "free builders", army candidates, gang recruits, the training gate and the
founder search use the first; the defence group, its refill and the scout list use the second.

### 0.1 Order of work in each run (C)

| job | each run, in this order |
|---|---|
| think (0x30, 150 ticks) | (1) threat weights of the profile and race (1.2); (2) **diplomacy evaluation** for every other player: acceptance flags and possibly an offer (3.5), drawing rand() only where 3.5 says; (3) the profile's strategy routine: for every town of the player (town list order): profile 0 only: reserve flag (2.2); scouts (2.3, profiles 0, 1, 2, 4); offensive troop wants and army candidates (2.3, profiles 0, 1, 2, 3, 5); then (not profile 4) **either** the attack decision (no army) **or** the candidates join the running army; then the founding check (1.12) |
| planner (0x32, 50 ticks) | only while the town is alive: phase counter advanced; phase 0 building targets (1.4) or phase 1 training needs (1.6, which first resizes the porter gang 1.10); then **every run** the placement step (1.5) and the training step (1.7) |
| economy (0x33, 50 ticks) | only while the town is alive: phase 0 gathering orders and free goods (1.8) then sliders (1.9); phase 1 gang sizes; phase 2 market and merchants (4.6); then the phase counter advances. Research topics are chosen by events, not by this job (1.11) |
| military (0x34, 50 ticks) | only if the town has a barracks (any state), a soldier (29..36) or a hunter: phase 0 targets and defence group (2.2) then the outpost refill (dead code, 2.2); phase 1 response to intruders. **The phase counter only advances in runs that pass this test** |
| army (0x35, 50 ticks) | if it has a target town: relation check (ends the army when not hostile); the current tactic; the tactic draws the next tactic itself |

---

## 1. The computer player

### 1.1 Who is a computer player (C)

- A race is a computer player when its mission race block has *present* and *computer* set
  (`mdb.md`). The player object gets the AI flag (player +0x260 = 1) and an AI think job
  (`00485a30` calls `0045cdf0` with the profile).
- Computer players are created **only in single-player games**: map setup skips the creation
  loop when a network session exists (`00485a30`: the branch for an active session jumps past
  it). A network game therefore has only human players (C).
- Free play ("Erschaffe eine Welt", `Infinite.mdb` records 0..2) has two computer opponents with
  profile field 0 (random); campaign missions set the field per race (`mdb.md` mission table) (D).

### 1.2 The AI profile (C for numbers, labels I)

The mission race block field +0x08 holds profile + 1. Value 0 means "random": the profile is
`rand() mod 3` (0..2), drawn once in the think job constructor (`00468280`). Shipped data uses 0,
5 (profile 4) and 6 (profile 5).

The profile selects (a) one of six strategy routines run every 150 ticks (table at `004afed0`),
(b) two threat weights used by the diplomacy evaluation (1.4 / section 3.5) and (c) an attack
cooldown. The weights are multiplied by a race factor and the cooldown by a race multiplier
(`004686f0`, `00468280`):

| race | weight factor | cooldown factor |
|---|---|---|
| Amazons | x 0.7692 (10/13) | x 1.5 (integer: x15/10) |
| Pimmons | x 0.6667 (2/3) | x 2 |
| Sajiki | x 1 | x 1 |

| profile | label (I) | peace weight w1 | ceasefire weight w2 | cooldown | strategy routine |
|---|---|---|---|---|---|
| 0 | aggressive | 1.5 | 1.0 | 10 | `00468f10` |
| 1 | opportunist | 0.75 | 0.3 | 15 | `004693b0` |
| 2 | cautious | 1.0 | 0.5 | 15 | `00469840` |
| 3 | raider | 1.0 | 0.5 | 15 | `00469cd0` |
| 4 | peaceful builder | 0 | 0 | 15 | `0046a0e0` |
| 5 | escalating waves | 1.0 | 0.5 | 15 | `0046a320` |

What the strategy routine changes (details in 1.9 and section 2):

| profile | scouts per town (extra want for type 24) | extra troops per town | founding: smallest-town population >, max towns < | attacks |
|---|---|---|---|---|
| 0 | pop < 13: pop/6, else 2 | (pop - 6) / 5, / 4 while an army is out | 20, 4 | yes, any other player (2.4) |
| 1 | pop < 13: pop/6, else 2 | (pop - 8) / 6, / 4 while an army is out | 10, 8 | yes, any other player, only if weaker |
| 2 | 1 if pop > 15 | (pop - 8) / 8, / 5 while an army is out | 30, 5 | yes, the human only, only a discovered town, only if much weaker |
| 3 | none | (pop - 6) / 6, / 4 while an army is out | 30, 5 | yes, the human only, raids of 1..3 units |
| 4 | 1 if pop > 15 | none | 30, 5 | never |
| 5 | none | (pop - 6) / 6, / 4 while an army is out | 30, 5 | yes, the human only, waves growing with game time |

There is no difficulty setting for computer players (C by exhaustion: every reader of the
computer flag, player +0x260, was checked in the third pass; none scales money, goods, training
time or prices). The opponent's strength comes from the profile, the race multipliers, the
mission's start gold/goods/research and the AI's built-in advantages (1.14). In free play the
menu (`ui/front-end.md` 6) sets, for **all** players alike: start gold and goods (Lagerstand,
default Niedrig = 300 gold, 15 of goods 0..5), a research level (Entwicklungsstufe: Niedrig
nothing, Mittel every invention <= 12, Hoch <= 20, applied in `0045d780` when mode 4) and the
nature density. A research level of 12 or 20 makes the hunting invention (index 2) and the
barracks (12) available at once, so raids come **earlier**, not rarer; with the default
Niedrig the hunters wait for the AI's own research (2.6). The profile is drawn as rand() mod
(6 - 3) (constants `004a6968` = 6, `004a696c` = 3, C).

### 1.3 The town planner job (kind 0x32, every 50 ticks) (C, `0046c890`)

Runs only while the town is alive. It alternates two phases (counter at job +0x3C, modulo 2):
phase 0 recomputes **building targets** (1.4), phase 1 recomputes **unit training needs** (1.6).
After the phase, every run places at most one building (1.5) and queues at most one training
order (1.7). So targets are refreshed every 100 ticks, and one building and one unit can be
started every 50 ticks.

The job keeps three per-type "extra want" arrays (62 entries each, indexed by object type) that
other jobs write into:

| array | written by | meaning |
|---|---|---|
| A (job +0x44) | economy job (1.8) | gatherer gang sizes: woodcutters (19), stonemasons (27), hunters (17); merchants (28) |
| B (job +0x118 + 4 x type) | military job (2.2) | soldier and hunter targets |
| C (job +0x234) | strategy routine, planner itself | scouts (24), offensive troops (29..36), hunters (17), founder (10), laboratory (46) |

### 1.4 Building targets (phase 0, `0046b490`) (C)

Nothing is planned while the town has more construction sites than twice its builders
(sites > 2 x (builders + builders queued for training)).

Inputs: P = max(1, population); the most urgent open need (`0045a290`: the **first entry** of
the town's open-need list, if its threshold is **strictly below** the population, or none); the
number of **free** porters of group 0 and of free builders of group 0 (section 0); the porter
count (town list, all porters of the town whatever their group); housing capacity H = number of
houses x resident places of the first house + number of large houses x resident places of the
first large house (the counts are the town's type lists, so **construction sites count**; 3 and 9
places in shipped data); occupancy O = P x 100 / H (H < 2 counts as 1). Porter share
= porters x 100 / P and free share = free porters x 100 / P (integer).

All targets start at 0, then, by number of completed buildings N (town +0x4C):

| N | targets |
|---|---|
| 1 | school 1 |
| 2 | school 1, house 1 |
| 3 | school 1, house 1, and the planner's extra want for the laboratory (C[46]) is set to 1 permanently |
| 4 | school 1, house 2 |
| 5 or more, and porters x 10 < town +0x48 | "porter shortage": each building type's target is set to its current count (sites included), then the house target is raised by 1. Town +0x48 is a second population counter that is changed together with +0x44 on every birth, death, type change and move found (C, `00460830`, `00464350`, `00464840`, `00464ba0`, `00464c30`), so the test is **porters < P / 10**. The copy is indexed by the record's **id** (group << 16 \| type) and skipped when the id is 62 or more, so it only works for Amazons (group 0). For Pimmons and Sajiki all targets stay 0 and the house target becomes 1: nothing is built except a first house if the town has none (C, `0x46b6fa..0x46b748`; an original bug). For Amazons the shortage builds one house after another and **no school** (school target = its current count) until births bring the porters back above P / 10 |
| 5 or more otherwise | the table below |

Normal targets (N >= 5):

| type | target | notes |
|---|---|---|
| 55 school | 1 | |
| 37 house | current + 1 if the rule below says so, else current | |
| 38 large house | current | new large houses only come from the house substitution (1.5) |
| 41 warehouse | mines + (P > 25: 2, P 16..25: 1, else 0) | |
| 50 mine | P > 60: 2, P 26..60: 1, else 0 | |
| 61 armoury | number of mines | |
| 45 farm | P > 40: 2, P 26..40: 1, else 0 | |
| 44 luxury works | number of farms | |
| 39 barracks | 1 if P > 15 | |
| 42 embassy | 1 if P > 15 and this is the player's first town | |
| 54 police station | 1 if P >= 18 | |
| 48 market | 1 if P > 20 | |
| 49 bank | 1 if income (town +0x494) > 110 | |
| 47 library | 1 if research spending (town +0x49C) > 100 | |
| 60 watchtower | P / 20 | |
| 43 creature yard | 1 if P > 40 and the town id is odd | |
| 56 mage tower / alchemist / cult site | 1 if P > 40 and the town id is even | |
| 52 / 53 outposts | current + 1 of the large outpost if it can be built, else of the small one, when the town area (cells) < (buildings + sites) x 20 + 40 | town area = 4 x the number of half-resolution area points (`0044e270`) |
| most urgent need (tavern, news stand, police, temple, culture) | current + 1, with chance 1/30 per evaluation, only if every existing building of that type is active (state 2; a site or an unstaffed building fails) | rand() is drawn whenever there is an urgent need, **before** the "all active" test |

House rule: a new house is wanted only if H < 150 and O > 50 % (O >= 51), and then if any of:
the porter share is under 50 %; the free share is under 5 %; there is no free porter; or (there
is a free builder, P < 70, and both the stone and the wood stock are at most 19 below the storage
capacity, i.e. free space <= 19). In other words the house is **not** wanted when porters are at
least half of the population, at least 5 % (and at least one) of the population are free porters,
and either no builder is free, P >= 70, or the wood or the stone store has 20 or more free places.
(C, `0046b490` from `0x46b87d`)

Order of rand() in phase 0: the urgent-need draw (only when there is an urgent need and N >= 5
without porter shortage), then, in the race's building-list order, one draw for each outpost or
watchtower request (the sign, 1.5) and one for a house request when the large house is buildable
and P > 20 (the 2/3 substitution).

Then for every building type of the race (in the race's building-list order), the target is
raised by the extra-want array C. If the current count is below the target and **no building of
that type is still a construction site**, a build request is queued (one site per type at a
time). (C)

### 1.5 Build queue and placement (C)

**Queue.** Requests are kept sorted by a priority number (lower first); a new request is inserted
before the first request with an equal or higher number, so among equals the newest goes first.
A type that is already queued is not queued again (`0046ab30`, `0046aac0`, `0046ae70`). A request
is only queued if the build menu would allow the type (menu state 1, `00459b60`: researched, not
unique-and-present, enough goods 0..4 in stock).

Priorities (table `004afee8`, also used for units in 1.6):

| type | 55 school | 46 lab | 37/38 houses | 41 warehouse | 54 police | 61 armoury | 39 barracks | 45 farm | 50 mine | 48 market | 52/53 outposts | 43, 49, 56 | 42, 44, 57, 60 | 47 library | 51, 58, 59 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| priority | 2 | 4 | 5 | 7 | 7 | 7 | 8 | 9 | 11 | 12 | 12 | 13 | 14 | 15 | 16 |

**House substitution.** When a house (37) is queued, the large house (38) is buildable, P > 20 and
rand() mod 3 != 0, the request is changed to a large house (chance 2/3) (`0046ab30`).

**Where.** Requests carry either a fixed anchor ("explicit") or "anywhere in town":

| type | anchor | search radius passed |
|---|---|---|
| 52 / 53 outpost | town centre +-50 cells in x (when the town's count of that type is even) or in y (odd); sign by rand() even = +; then snapped (below) | 10 |
| 60 watchtower | town centre (+50,+50) or (-50,-50) when its count is even, (+50,-50) or (-50,+50) when odd; snapped (below) | 10 |
| 41 warehouse | count (sites included) 0 or 1: the point of a `.dvm` region list nearest to the town position. Amazons: count 0 the forest list (nature class 8 = list 0), count 1 the stone list (class 13 = list 1); Pimmons and Sajiki the other way round (stone first). Nearest = smallest wrapped max + min/2 distance, the first point wins ties; **no distance limit**; an empty list leaves the anchor at cell (0, 0). Count 2 or more: the first mine of the town's list, or the town centre if there is none. Then snapped (below) | 10 |
| everything else | if the town has small outposts and rand() is odd: its first small outpost; otherwise its first large outpost if it has one, else the town centre. "Has outposts" is the town's type list, so **outpost sites count too**. The outpost used is rotated to the back of **its own** list (each list rotates separately). Then a jitter of 4 - rand() mod 9 (-4..+4) in x, then in y, wrapped to the map | 2 x the town hall's radius (2 x 25 = 50) |

**Snapping** (C, `0046ac30`, third pass; replaces "snapped to the area outline", which was
marked as a guess for points inside the territory): the anchor is **always** replaced by the
nearest block of the town's territory **border list** (the record list at +0x14, the same list
the border stones are drawn from, `0044e7c0`; `economy.md` 11.4), converted to its cell
(2 x block x, 2 x block y). Inside or outside makes no difference: a point deep inside the
territory also moves out to the border. Distance: wrapped max + min/2 between the anchor and
that cell; strict "<", so the first border block in list order wins ties. A town with no
territory record gives the anchor (-1, -1). Consequence: outposts, watchtowers and warehouses
are searched around a point **on the town's border** (radius 10: rings up to half-size 5), and
since the padded footprint's corner blocks must lie in the territory (step 5), they end up
just inside the border, on the side facing the forest / stone region (warehouses) or the
+-50 direction (outposts, towers). The rand() draws for the sign are made before the menu-state
and "already queued" tests (`0046b490` cases 0x34, 0x35, 0x3C).

Placement step (`0046c1a0`, once per run):

1. Only if the queue is not empty and sites <= builders (+ queued builders).
2. The first request is taken out of the queue (it is discarded even if no site is found; the
   next target evaluation queues it again).
3. Footprint padding: each side length is the record's size + 2 + rand() mod 3 (first the
   dimension at record +0x0C, then +0x10). rand() order per placement: these two, then (for
   "anywhere" requests) the outpost coin when small outposts exist, then the two jitters.
4. Forbidden cell mask: the type's normal mask (`units-and-jobs.md` 6.1) **plus 0x100 (height
   above 250, mountains) for everything except the mine and the two outposts**. The normal mask
   0x87E contains 0x02: **a unit standing in the rectangle blocks it**, as for the player.
5. Site search (`00449840`): test the anchor; then walk square rings outward around it. The ring
   step is 2 cells because the padded footprint is at least 2 x 2, which means ring k has half-size
   k and the walk covers half-sizes up to radius / 2 (5 cells for radius 10, 25 cells for radius
   50). Each ring starts at its (+k, -k) corner and goes +y, then -x, then -y, then +x.
   The test at a position Q (C, `00447cd0`, the same click test as the player's, called with the
   padded sizes instead of the record sizes): the rectangle of padded size whose **maximum corner
   is Q** must have no cell with a flag of the mask; the slope flag 0x40 is added when the heights
   on the ring of cells just outside that rectangle differ by more than 64; with flag 0x800 in the
   mask (all but the mine and, in the add-on, harbour and shipyard), the four corner blocks of that
   rectangle, computed as in `economy.md` 11.7 with the padded sizes, must lie in the AI town's
   own territory.
6. The building is created with its maximum corner at Q minus one cell in x and y as a
   construction site (`0045f0d0`) and its construction job is started (`0045f410`), exactly like a
   player placement (no money, goods delivered later). So the footprint sits in the padded
   rectangle with **one free cell on its maximum side** (+x, +y) and **1..3 free cells on its
   minimum side** (the random padding).

### 1.6 Unit training needs (phase 1, `0046b0f0`) (C)

First the porter gang is resized (1.10). Then:

1. **Essential workers.** If the town has none (counted together with queued orders) of these,
   one is requested, in race order:

   | race | order |
   |---|---|
   | Amazons | woodcutter (19), stonemason (27), builder (11) |
   | Pimmons | stonemason, woodcutter, builder |
   | Sajiki | builder, stonemason, woodcutter |

   If the chosen type's invention is not researched and the town has no scholar (23, also counting
   queued ones), a scholar is requested instead. The request goes into the training queue with
   priority 0 (unless that type is already queued) and nothing else is planned this phase.
   "None" means count + queued orders = 0: one unit of each of the three is enough. A request for
   a type whose invention is missing (while a scholar exists) is queued anyway; the training step
   drops it every run because the order check fails, and phase 1 queues it again.
2. If the training queue's first entry still has priority 0, nothing else is planned. So while
   an essential worker is missing **and cannot be trained** (no school, the invention not
   researched, no money), the town trains nothing else at all.
3. Otherwise, for every unit type t of the race:

   want(t) = (number of the town's buildings whose operator type is t)
           + C[t] + B[t] + A[t] - queued(t) - existing(t)

   plus, for builders (11), a base of 1 + (1 if P > 20). The building count includes
   construction sites (an embassy site already asks for its diplomat); existing(t) is every unit
   of type t of the town, whatever its group, inside or outside; queued(t) is the town's count of
   training orders already placed in buildings (town +0x39C). If want(t) > 0 and t is not in the
   planner's training queue, t is queued with its priority from the table (the race's unit list
   is walked in record order; priorities sort the queue, newest first among equals):

   | unit | 9 porter | 11 builder | 19 woodcutter, 27 stonemason | 14 farmer | 23 scholar | 13 diplomat, 25 weaponsmith | 17 hunter, 21 police | 29 archer | 15, 16, 18, 20, 22, 24, 28, 30..36 | 10 founder, 26 saboteur |
   |---|---|---|---|---|---|---|---|---|---|---|
   | priority | 1 | 2 | 3 | 5 | 6 | 10 | 12 | 13 | 14 | 15 |

### 1.7 Training execution (every run, `0046c670`) (C)

- If the town has at least one free porter of group 0 (section 0: idle outside **or on a
  leisure visit**) **and** a non-empty porter gang: repeatedly take the first training request;
  find the town's buildings of the type where that unit is trained (unit record +0xE8); pick the
  first one that is not a construction site and whose order check passes (`0045f360`: made
  there, invention researched, the player's money at least the price, goods 0..8 in the town
  stock at least the unit's goods); queue the order there (`0045f4c0`, paying the price like a
  player) and move that building to the end of the town's list (round robin). Stop after one
  successful order; requests that cannot be placed are dropped. The order check does **not**
  test the 5-order limit: a building with 5 orders passes, `0045f4c0` silently refuses the order,
  and the request is nevertheless consumed (C).
- The trainee: the order files a porter worker request; the dispatcher serves it with the
  nearest **free group-0** porter (`0045b2f0` is called with group 0 for worker requests, also in
  computer towns), not with a gang porter. That is why the training step needs a free porter.
- Otherwise, if the gang has fewer than 2 porters: for every completed school, queue one "porter"
  order per occupant not covered by its current orders. The pupils inside (porters left over, or
  gatherers released there by 1.8) are retyped into porters and come out as free porters
  (`units-and-jobs.md` 9.1).
- Outposts completed by a computer town file one worker request for an archer (29) per garrison
  place (record +0xDC, `004602d0`); the dispatcher sends free group-0 archers in (an archer
  already in the defence group 52 is not free for it). This is the **only** way AI outposts get
  their garrison: the military job's refill branch never fires (2.2), and a garrison archer that
  dies or leaves is not replaced unless a new request is filed.

### 1.8 Economy job (kind 0x33, every 50 ticks, `0046ecd0`) (C)

Three phases (counter job +0x34, modulo 3), so each part runs every 150 ticks:

| phase | does |
|---|---|
| 0 | gathering orders and free goods (below), then sliders (1.9) |
| 1 | gang sizes for gatherers |
| 2 | market settings and merchants (4.6) |

**Gang sizes (phase 1, `0046ebc0`, `0046e960`).** The wanted number of gatherers is written to
the planner's array A (so the planner trains them) and the gangs (group 51) are filled from free
units of that type or trimmed (released units walk to the first school, I: to be retrained):

| gang | size |
|---|---|
| woodcutters | max(1, f_wood x g / 2) |
| stonemasons | max(1, f_stone x g / 2) |
| hunters | min(3, P / 10) |
| bush porters | min(2, P / 5) when the hunter gang is empty (after its resize), else 0 |

Gangs are filled from **free** units (section 0) of that type in town-list order; a released
member gets group 0 and, if the town has a school, a go-into job to the town's first school (job
`0047ac60`, the same job the garrison refill would use), so released gatherers walk into the
school and stay there as occupants: a training building keeps every unit that enters, and the
next order finishing there retypes the head of its occupant list whatever its type (C,
`00460ed0`, `00475ff0`; `units-and-jobs.md` 9.1). The four gathering flags of the
economy job (+0x24 wood, +0x28 stone, +0x2C iron, +0x30 food) are always 1 (`0045d370`,
`0045e4b0` pass 1, 1, 1, 1), so every phase always runs.

with g = 2 if P >= 16, else 1, and race factors f_wood / f_stone: Amazons 4 / 2, Pimmons 2 / 4,
Sajiki 3 / 3. Result: Amazons 2 woodcutters and 1 stonemason below population 16, 4 and 2 from
16 on; Pimmons the reverse; Sajiki 1 and 1, then 3 and 3. (`0046e960` also has a "stock below 10 %
of capacity" minimum of 1, which the max(1, ...) in `0046ebc0` makes redundant.)

**Gathering orders (phase 0, `0046e6b0`, `0046e260`).** For wood (trees, class 8), stone (class
13) and food (animals class 7 for hunters, bushes class 9 for porters), when the stock is more than
5 below capacity: look for an object of that class within 20 cells of the town centre (`00449a30`);
if none, take the region points of that class (forest list for classes 7/8, stone list for 13,
bush list for 9; see 1.13) nearest to the town while the nearest one is at most 59 cells away and
search 10 cells around it, discarding points that yield nothing. Every gang member without a job
gets a harvest job with auto-continue on the found object (`units-and-jobs.md` 7.1).

**Free goods (AI only).** In the same phase:

| condition | gift |
|---|---|
| wood space > 5, no tree found for the woodcutter gang (or no gang), wood stock 0 | wood stock set to min(2, capacity) |
| stone space > 5, nothing found for the stonemasons, stone stock 0 | stone stock set to min(2, capacity) |
| food space > 5, neither hunters nor bush porters found anything | +2 food (also counted as produced this round) |
| iron space > 5, wood >= 2, woodcutter gang not empty, the wood gift did not fire in this run | with chance 9/10: +1 iron and -2 wood |

Re-checked in the third pass (C, `0046e6b0`): the search routine `0046e260` returns "nothing
found" at once when the gang is empty, so with no woodcutter (stonemason) the gift depends only
on the stock. Wood and stone are each **set** to 2 (not raised by 2) and only when that stock is
exactly 0; the two goods are independent; food gets +2 whatever its stock (capped). There is no
other goods gift anywhere for computer players (C by exhaustion of the computer-flag readers):
no top-up for a building the planner wants, no school exception. The gift is smaller than every
race's school (`dv.odb`: Amazons 4 wood + 2 stone, Pimmons 2 wood + 4 stone, Sajiki 3 wood +
3 stone), see 1.15.

### 1.9 Sliders: motivation and research (phase 0, `0046e180`) (C)

- Motivation spending (town +0x3C) is always set to 0. (AI towns have no happiness anyway,
  `economy.md` 5.5.)
- Research spending (town +0x40, initialised to 40 when the town is created) is set to 0 unless
  the town has income, an active laboratory and a selected research project. Then, with I =
  income, U = overheads and M = the player's money:

  | money | reserve kept |
  |---|---|
  | M < 150 | I / 3 |
  | 150 <= M < 250 | I / 5 |
  | 250 <= M < 600 | I / 10 |
  | M >= 600 | 0 |

  research % = max(0, (I - U - reserve) x 100 / I) (integer division; each division truncates
  toward zero).

### 1.10 Porter gang (`0046aed0`, every 100 ticks) (C)

Wanted gang size n from the town's porter count p: n = 2 if p < 6 (precisely if p rounded down
to even is below 5); otherwise min(10, p / 2). Dead members are dropped. If the gang is too small,
free porters (group 0) join it, but n/4 + 1 of them (when n > 2) are always left outside; if it is
too large, the surplus is released. The dispatcher of a computer town only uses gang porters
(group 50) for transport and requests, so the AI's hauling capacity is the gang. (C)

### 1.11 Research choice (C, `00410490`, `0046f490`, `0045fa40`)

- Each race has one invention table and one **cursor** (idb object +0x14), shared by all computer
  towns of that race.
- When a computer town's laboratory becomes active, the cursor is reset to 0 and a topic is picked.
- Pick: advance the cursor entry by entry; return the first invention that is neither started
  nor complete and whose (up to three) prerequisites are all complete. **Every entry examined is
  passed, including skipped ones**, so an invention skipped for a missing prerequisite is only
  reconsidered after the next reset.
- When a project completes in a computer town, the next topic is: the stonemason's required
  invention if not researched, else the woodcutter's, else the cursor pick (which has already
  advanced the cursor even if an override was used, so that pick is lost until the next reset).
  No topic left: research stops.

### 1.12 Founding new towns (C, `00468cc0`, `00467f80`, `00467e10`)

Each think run, the strategy routine finds the player's town with the smallest population. If that
population exceeds the profile's threshold and the player has fewer towns than its limit (table in
1.2), the town's extra want for a founder (C[10]) is set to 1 (so it trains one), and if the town
already has a free founder a founding mission (kind 0x36) is started.

The check runs after the attack decision (0.1) and draws rand() mod 50 for the mission's first
run. It does not test for a running mission: a new one is started whenever a free founder exists
(the founder of a running mission is in group 54, so it is not free).

The founding mission (every 50 ticks):

1. Takes one free founder of the town (group 54).
2. A site is valid when a 7 x 7 area around it is free of flags 0x7E, the cell is in nobody's town
   area, and no point of a circle with the town hall's radius (25) around it lies in any town area
   (`0045dc10` builds the circle). Effect: new towns keep their whole radius-25 area clear of every
   existing area, so town centres end up at least about 2 x 25 cells from other towns.
3. The mission's target starts at the old town (never valid). While the target is not valid, the
   start-candidate list of the map (`.dvm` point list 3, see 1.13) is scanned **in order**; around
   each candidate a site within 20 cells is searched; the first hit becomes the target. If no
   candidate gives a site, the mission ends.
4. When the founder (outside any building) is 8..15 cells from the target, the town is founded
   there: a new town object with a town-hall site is created and the founder gets the normal
   "found town" job (`00464aa0`, `units-and-jobs.md` 3.1 kind 0x0E). The founder want is cleared.
   Farther away, the founder walks to a passable cell within 30 cells of the target.

Exact run order (C, re-read 2026-10 in AN `00467f80` and Gold `0046f340`, branches confirmed in
the Gold disassembly `0046f3f6..0046f404`, `0046f7aa`, `0046f1a7..0046f1af`):

| step | condition | effect | returns |
|---|---|---|---|
| a | no founder yet | take the first **free** founder (type 10, group 0) of the town; group := 54 | (go on) |
| b | no founder, or the founder is **inside** something (unit +0x6C ≠ 0: a building, or in the add-on a ship) | nothing | **0: the mission ends.** The founder keeps group 54 |
| c | the target is not valid (step 2 test) | scan the candidates (step 3). On a hit: new target; if the founder has a job, cancel it (in the add-on, a wait-for-ship job 0x3E first cancels its ship request, `addon.md` 8.4). No hit: the mission ends (0) | 50 |
| d | target valid, founder distance 8..15 (`0045fa10`: max + min/2) | if his job is already the found-town job (0x0E): wait. Else found the town (`0046afd0`), drop the founder, clear C[10] | 50 |
| e | target valid, distance outside 8..15, the founder has a job | wait | 50 |
| f | as e, no job | search a cell around the target with the 30-ring site search (`00449c00` / Gold `0044ed90`, test `00467ba0` / `0046ef70`): passable for the founder **and** at distance 8..15 from the target. None: wait. Found: base game, a walk job (follow path, kind 6) to it, first run after 5 ticks; add-on, see `addon.md` 8.4 (walk if that cell is on the founder's island, else a ship request and job 0x3E) | 50 |

Consequences (C):
- A founder on a **leisure visit** counts as free (section 0), so the mission can take a founder
  who is inside a house; its first run then ends at step b. Such a founder stays in group 54
  for good: it is never free again, still counts as an existing founder for want(10), so the
  town trains no other founder and starts no new mission while it lives (quirk).
- The same happens to a founder **carried by ship** in the add-on: once he is aboard, the mission
  ends; after landing he stands idle in group 54 on the other island and never founds (quirk,
  `addon.md` 8.4).
- A founder closer than 8 cells to the target does not found; he first walks out to the 8..15
  ring (step f).

### 1.13 Map data the AI uses (C)

| `.dvm` point list (file order) | used by |
|---|---|
| 0 forest regions | gathering wood and animals (1.8); warehouse anchor (Amazons' first, Pimmons'/Sajiki' second warehouse) |
| 1 stone regions | gathering stone; warehouse anchor (the other one of the first two) |
| 2 bush regions | gathering food from bushes |
| 3 start candidates | founding new towns (1.12) |
| 4 start positions | free play start towns (`dvm.md`) |

Maps without point lists (old maps, `dvm.md`) give the AI no fall-back resource regions and no
founding sites (the founding mission ends at once). The camera and the initial orders of the map
apply to computer units like any other units.

### 1.14 Rules that differ for computer players elsewhere (summary)

| rule | effect | where |
|---|---|---|
| happiness | not computed; AI towns always at 100 | `economy.md` 5.5 |
| criminal births | every 36th resident instead of 9th/18th | `economy.md` 3.2 |
| free goods | wood/stone/food gifts and wood-to-iron conversion | 1.8 |
| imports | a computer player never pays for goods its towns receive from merchants | 4.4 |
| logistics | only gang porters haul | 1.10 |
| motivation slider | always 0 | 1.9 |
| mentor | computer players have no advisor and no human-only player jobs (kinds 0x2D, 0x2F) | `0045d780` (C) |
| free-play start | a computer player starts with an **active town hall** (its founder inside; the activation adds the builder, two porters and the start goods), the human with a lone founder | `00485a30` (C) |
| intruders | units entering a computer town's area are recorded for its defence | 2.2 |

Nothing else differs (C, third pass, every reader of player +0x260): no extra money or goods,
no cheaper or faster training, no difficulty scaling, no free units.

### 1.15 What keeps a computer town's economy alive, and the dead end (C, consequences of 1.4..1.10)

Safeguards that exist:

| safeguard | rule |
|---|---|
| school first | with 1..4 completed buildings the school is wanted before anything else (priority 2, ahead of houses 5); with 5 or more the normal table always wants one school |
| essential workers | one woodcutter, one stonemason and one builder (race order 1.6), or a scholar when the invention is missing; they block all other training until satisfied |
| research bias | after every completed project the stonemason's, then the woodcutter's invention are chosen first (1.11) |
| gangs | 1..4 woodcutters and stonemasons, 0..3 hunters, 0..2 bush porters (1.8) |
| free goods | wood or stone set to 2 when the store is empty and nothing can be gathered; +2 food when nothing edible is found (1.8) |
| rebuilding | any building type whose target exceeds its count is queued again on the next evaluation (school 1, warehouses, etc.); a lost school is re-queued at once (N >= 5, no porter shortage) |
| builders | target 1 builder, 2 above P 20 (counting queued orders), at priority 2 |

What does **not** exist. The third pass searched for every recovery path a raided town could
have; none exists (C):

| possible recovery | finding | evidence |
|---|---|---|
| free unit / builder spawn | Units are created in exactly five places: the map loader (`00411200`), the free-play start (`00485a30`: an activated town hall plus its founder), births in a building (`00460830`), the training job's retype (`00475ff0` -> `00464840`) and the jail job's retype of a criminal (`0047cca0`). Births make porters (type 9) or criminals; the only birth of a builder is the **town hall's activation** (`0045fa40`: one builder, two porters, start goods), which happens once per founded town (and again only if a town hall is deactivated and reactivated, which no AI code does) | callers of the unit constructors `004628d0` / `00463d00` |
| builders without a school | none: every civilian, builders included, is trained only at the school (odb +0xE8 = 55); the town hall trains nothing; a porter cannot build (the dispatcher serves a builder request only with a free unit of type 11, `0046fa10` / `0045b2f0`) | `units-and-jobs.md` 5.2 |
| conversion into builders | only through training at a school (the school retypes its first occupant, whatever it is; 1.7 flush). No other retype | callers of `00464840` |
| schools queued without goods | none: the build queue (`0046ab30`) and the explicit branches of `0046b490` both require menu state 1 (`00459b60`: goods 0..4 of the town stock at least the cost) | 1.5 |
| goods gift | only the 1.8 gifts (wood/stone **set** to 2 at stock 0; +2 food); no top-up for the school | `0046e6b0` |
| founding a new town | needs a free founder (trained at the school) and the town's population above the profile threshold (10..30); the founder inside the town hall is its operator, not a free unit (I) | 1.12 |
| cancelling / demolishing unbuildable sites | none: no AI routine destroys or cancels a building (the planner, placement, training, economy, military and strategy routines contain no call to a destruction or cancel path; their only virtual calls are reference releases) | `0046b490`, `0046c1a0`, `0046c670`, `0046aed0`, `0046e6b0`, `0046ea30`, `0046cb20`, `0046d3a0`, `00468f10`.. `0046a320` |
| AI cheats | none beyond 1.14: computer players pay the same training prices (`0045f4c0`), train at the same speed, get no extra money, and the readers of the computer flag only skip human-only jobs and messages, fix happiness at 100, change the criminal divisor, record intruders, file the outpost garrison requests and run the AI jobs | readers of player +0x260 (`0040ce90`, `0045a7c0`, `0045d780`, `0045dab0`, `0045db60`, `0045fa40`, `0045ff30`, `004602d0`, `00460830`, `004621c0`, `00462e30`, `00463d00`, `00464ea0`, `0046f490`, `0046f820`, `0046fa10`, `0047d4d0`) |

Other absences (C by absence in `0046b490`, `0046b0f0`, `0046c1a0`, `0046c670`):

- No exception to the two site gates: targets are only evaluated while sites <= 2 x (builders +
  queued builders), a site is only placed while sites <= builders + queued builders (town +0x50
  against the builder list +0x140 and the queued count +0x3C8).
- No exception for the school in the porter-shortage branch (Amazons: school target = current
  count) and none in the N <= 4 table for the case that the school cannot be placed (the house
  of N = 2 / 4 can then come first).
- No reserve of defenders: below P = 10 a town has no hunter want at all (gang min(3, P/10),
  defence min(6, P/10), offensive troops only above the profile base), and no barracks below
  P = 16.

The resulting **dead ends** (C, consequences; they are original behaviour, not a rebuild
artefact):

1. **No builder and no completed school**: the builder cannot be trained, all other training is
   blocked behind the priority-0 essential worker, and with any site open (a school site, for
   example) no new targets are evaluated.
2. **No completed school, no school site, and the school's goods cannot be reached**: the school
   is never queued (menu state 3) even with a builder alive. Without a woodcutter (also lost, or
   never trained) the wood stock never exceeds 2 (the gift sets 2 at 0), so an **Amazon** town
   (school 4 wood) or a **Sajiki** town (3 wood) without wood in stock is stuck; a **Pimmon**
   (4 stone) or Sajiki town (3 stone) without stone in stock and without a stonemason likewise,
   except that destroyed buildings leave rubble (8 stone) that porters bring in. The woodcutter
   and stonemason need the school, which closes the loop. Only a market (P > 20, imports free
   for computers, 4.4) could bring wood, and it needs a builder and the goods for itself.
3. **Open sites and no builder** (any site, not only the school): no evaluation while sites >
   2 x builders, no placement while sites > builders, until a builder is trained, which needs
   the school.

Its houses keep producing porters, so the town ends as "houses, porters, no school, no
woodcutter, no builder". The usual way to get there is a raid by another computer player (2.6):
the skirmish tactic kills the workers outside within 40 cells of the town position, and the
assault tactic attacks the **school** whenever the town has no barracks (2.5). A town that loses
only its builders recovers (the essential-worker rule orders a builder at the school), provided
the school survives, a free porter exists and the money suffices (builder 30). A town that loses
only its school recovers if a builder lives and the school's goods are in stock or a gatherer of
the missing good lives.

Why the original may show this less often (I, not testable from the code alone): the dead end
needs a raid by a computer player on another computer player, which with a human who owns a town
happens only in some race combinations (2.6); a victim with a barracks or a barracks site (P > 15)
has that as its most important building, which shields the school (2.5); and the assault tactic
of the original never picks civilians (2.5 corrected); builders die in skirmish runs and when an
attacker retargets after its building fell (2.5 "When the important building falls").

Pending counts and lost buildings: when a training building is destroyed, its training job is
deleted (I) and the job's destructor lowers the town's queued count (+0x39C) once for every order
still in it (C, `004761e0`; no refund). The planner therefore stops counting units that can no
longer come out.

---

## 2. AI military (decision layer)

### 2.1 Strength measure (C, `00468630`)

strength(player) = 500 + sum over the player's towns of
  sum over unit types t = 29..36 of count(t) x maxDamage(t)
  + count(hunters) x maxDamage(hunter) + count(saboteurs) x maxDamage(saboteur)

where count is the length of the town's list of that type and maxDamage is the "max" field
(`dv.wdb` +0x10) of the weapon of the **first** unit in that list. Example: a Pimmon archer
(KampfBogen, max 20) adds 20; a saboteur (bomb, max 600) adds 600. Used by diplomacy (3.5) and
attack decisions (2.4).

Army power for a fight (tactic 0, 2.5): for each unit with a weapon (priests excluded),
HP x 100 + maxDamage x 500 / cooldown (weapon +0x20), integer division. (C, `00466020`)

### 2.2 Defence (town military job, kind 0x34) (C)

The job only works while the town has barracks (any state, sites included), soldiers (29..36) or
hunters; otherwise it idles without advancing its phase. Two phases (modulo 2), each every 100
ticks while it works. A young town (no barracks below P 16, no hunter want below P 10) therefore
has no defence at all.

**Phase 0: targets and defence group** (`0046cb20`, `0046cfd0`)

- Archer target = garrison places of all outposts (large count x large garrison + small count x
  small garrison, record +0xDC).
- Budget b = P / 10, plus (porters - 15) / 4 when there are more than 15 porters.
- For unit types 36 down to 29: if the town has a training building for that type, its first
  such building is active and an order would pass the order check, that type's target grows by
  b / 2 (rounded down) and b keeps the rest. (The strongest available type gets half, the next a
  quarter, and so on.)
- Hunter target = min(6, remaining b).
- The targets go to the planner's array B (training, 1.6). "Training building active" means
  the **first** building of that type in the town's list (a site there fails).
- Defence group: for each unit type of the race (record order), keep = (100 - r) x target / 100
  units in group 52, where r is the job's reserve percent (0, or 25 under profile 0 once the town
  was not under attack at a think; it is never set back, C). Members are the type's group-52
  units **outside** buildings (any job); missing ones are taken from group-0 units **outside**
  (any job, section 0), extras get group 0 (nothing else happens to them). Units of group 52
  inside a building (e.g. an outpost garrison) are not counted, so the group refills behind
  them.
- Outpost refill (`0046cfd0`): the code walks the active large outposts, then the small ones,
  and would send a free group-52 archer into each one whose occupant count is below the record's
  **resident places** (+0xB4), with a go-into job first run after 3 + rand() mod 10 ticks. All
  outpost records have 0 resident places (their capacity is the garrison field +0xDC), so the
  test never passes and **no archer is ever sent and no rand() drawn** (C, quirk). Garrisons come
  only from the completion requests (1.7).

**Intruders.** Whenever any unit steps into the area of a computer town, it is recorded on that
town's military job (`004621c0` -> `0046cab0`). (C)

**Phase 1: response** (`0046d3a0`)

- Defenders = hunters, then soldiers 29..36 (type order): for each type first its group-52 units
  outside buildings (any job), then its **free** group-0 units (section 0).
- Intruders are dropped when dead, or when they fail this test: a unit without an attack job
  (kind 8) must stand in the town's area and not be a diplomat or merchant; a unit with an attack
  job must be attacking an object of this town's **race** (any town of it). The rest are kept
  only if their race is hostile to this town's race (relation 0 or 1, section 3), and are sorted
  into three buckets by their target class (object +0x20, the same field as in 2.5).
- No hostile intruder: the "under attack" flag (job +0x3C) is cleared; one rand() mod 10; on 0,
  every defender that is alive, outside buildings, without a job and **not** inside the town's
  area gets a walk job (kind 6) to the town centre + (rand() mod 41 - 20, rand() mod 41 - 20),
  first run after 5 + rand() mod 10 ticks (three draws per such defender).
- Hostile intruders: the flag is set; only the **first non-empty bucket** (most urgent class) is
  attacked. Its intruders are taken in turn; every defender in list order is handled once: a
  defender with an attack job on a target of a class at most the bucket's class keeps it (and is
  not counted); every other defender has its current job cancelled and gets an attack job on the
  current intruder (if the attack check `00465460` allows it), and is counted; after 3 counted
  defenders the next intruder of the bucket becomes current, **wrapping to the first** after the
  last. So every defender ends up attacking, three per intruder in turn, however few the
  intruders.

### 2.3 Army candidates and troop production (C)

Every think (150 ticks) the strategy routine, for each town with a planner:

1. sets the scout want C[24] = w and sends scouts exploring (`00468e10`, `0047c970`): the list
   starts with the town's scouts outside buildings whose group id equals the think job's kind
   (0x30 = 48), which no code ever sets, so it starts empty; if it holds fewer than w, all
   **free** group-0 scouts are added and the list is cut back to w (from its end); every scout
   left in the list without a job gets an explore job (kind 0x28: walk to a random map cell,
   again and again) with first run 1 + rand() mod 5 (a scout with another job would have it
   cancelled first). Exploring scouts are not free, so each think sends up to w **more** idle
   scouts: in the long run every idle scout explores; scouts that the dispatcher has sent to a
   watchtower have a job and are left alone;
2. sets offensive troop wants (`00468a60`), only when P > base: K = (P - base) / div (table in
   1.2); for unit types 36
   down to 29 whose **first** training building in the town's list is active (state 2) and whose
   order check passes, C[t] = K / 2 and K keeps the rest; then C[17] (hunters) = min(5, K). Types
   not eligible keep their old value;
3. collects **army candidates**: every **free** group-0 hunter (first) and soldier 29..36 (type
   order) of the town (`00468b10`; section 0: idle outside or on a leisure visit). Gold, add-on
   mode only (`00470140`, the same test as the naval planner's existence, map +0xA50 > 0): then
   the town's free group-0 **light and heavy warships** (65, 66), in this order. The warship gang
   member (group 51, `addon.md` 8.2) is not free; a warship becomes a candidate only when it has
   no group, e.g. after a gang resize released it.

The list runs over all towns of the player (one list per think), so the candidate count of 2.4
is the player's total. So soldiers above the defence group's share, and idle hunters, are
available for attacks. A unit walking (a follow-path job, for example on its way home after an
army ended) is not free and not a candidate until it stands.

### 2.4 Attack decision (per profile) (C)

An attack is only considered while the player has no army. "Hostile to the human" below means
the relation between this computer race and the **local human player's race** (`004af3cc`) is 0
or 1.

| profile | needs | target |
|---|---|---|
| 0 | candidates > min(10, tick / 30000); more than the cooldown ticks since the last army activity; hostile to the human | the first other living player in race order whose strength x 0.5 < own strength, or any such player while tick < 54000 (about 1.5 h); its first town |
| 1 | candidates > min(20, tick / 20000); cooldown; hostile to the human | the first other living player whose strength < own; its first town |
| 2 | candidates > min(20, tick / 30000); cooldown; hostile to the human; own strength > 1.5 x the human's | the first human town (in town-id order) that the AI has **discovered**: a town is discovered when any unit of this AI steps into its area (`004621c0`); forgotten when the town is destroyed (`00459400`) |
| 3 | more than 2 candidates; hostile to the human | the army is cut to 1..3 units (rand() mod 3 + 1); a random town of the human |
| 4 | never attacks | - |
| 5 | candidates > n + 1, where n = 1 until tick 60000, then min(15, tick / 20000 + 4); hostile to the human | the army is cut to n + rand() mod 3 units; a random town of the human |

Notes:

- Profiles 0 and 1 test hostility against the **human**, but may then pick another computer
  player as the target (the first player in race order that passes the strength test). In a
  two-computer mission an AI at war with the human can therefore attack the other AI (C; likely an
  original quirk).
- The target loop, read instruction by instruction (C, profile 0 `0x46912f..0x4692db`, profile 1
  the same at `0x4695xx`): for the race slots 0, 1, 2 of the player table, skipping the own
  player and empty slots: look up the relation of the pair (local human race `004af3cc`, own
  race); this is the **same pair for every candidate**, the candidate's own race is not used;
  continue only if it is 0 or 1 and the candidate's alive flag (player +0x0C, cleared when a
  player is eliminated, `0045d2a0`) is set; profile 0: own strength > 0.5 x candidate's
  (`004a6628` = 0.5, float compare) or tick < 54000 (0xD2F0); profile 1: candidate's strength <
  own; then the candidate's town list is walked and the **first non-empty entry** becomes the
  target. A candidate **without a town** (for example the free-play human, who starts with only
  a founder, until he founds his town) is passed over and the loop goes on to the next race.
  The tick divisors are 2000 x 15 = 30000 (profiles 0, 2) and 2000 x 10 = 20000 (profile 1)
  (`004afecc` = 2000).
- No other condition exists: no minimum army size beyond the candidate count, no test of the
  own town's buildings, population or stock, and no further cooldown (C). What makes the first
  raid wait for the economy is where the candidates come from: **free** group-0 hunters and
  soldiers (2.3), i.e. hunters trained beyond the economy gang and the kept defence group, which
  in turn needs the hunting invention (index 2 in all three tables, researched third after the
  lab exists: tower 15, then the stonemason's/woodcutter's invention 10, then hunting 12 points,
  1.11), a school, 40 gold and a free porter.
- While an army exists, new candidates join it every think (`00465ad0`). Joining units get group
  53; those farther than 20 cells (half the army radius) from the target walk to it (details and
  the Gold island rule in 2.5 "Joining and moving").
- **The threshold gates only the creation of an army, and every candidate is sent** (C,
  instruction level `0x4690e1..0x46911f`: tick / (2000 x 15) by signed division, capped at 10 by
  `cmp eax,0xa; jl`, then `cmp count,eax; jbe` skips the attack, i.e. an army needs count >
  threshold). Profiles 0..2 hand the **whole** candidate list to the new army (no cut, no
  minimum beyond the count); only profiles 3 and 5 cut it. Once the army exists, the threshold
  plays no part: every later think adds whatever new free candidates there are, **one is
  enough**, and the army lasts until it ends (2.5). With 10 ticks per second the profile-0
  threshold is 1 (2 candidates) from tick 30,000 (50 min), 2 from 60,000, ... and 10 (**11
  candidates**) from tick 300,000 (8 h 20 min); profile 1 reaches its cap of 20 (21 candidates) at
  tick 400,000, profile 2 at 600,000. So late in a game a **new** army of profile 0 always starts
  with at least 11 hunters / soldiers / (add-on) free warships of the whole nation. What the
  victim sees first can still be a single unit, because the members do not move as a group
  (2.5 "Joining and moving"), and across water because of how ships are filled (2.5, `addon.md`
  8.4).
- The cooldown (`player AI job +0x30`, 10..30 ticks) counts from the last time the army ran
  (+0x2C is set on every army run), so a new attack can follow almost immediately after an army
  ends. Profiles 3 and 5 have no cooldown test at all.
- Thresholds in practice: before tick 30,000 (about 50 minutes at normal speed) profile 0 needs
  only **one** free hunter or soldier, profile 1 likewise before tick 20,000 (and a strictly
  weaker target); profile 5 needs 2 before tick 60,000. Free hunters appear once P exceeds the
  profile base (C[17] = min(5, K)), and only the ones beyond the economy gang and the defence
  group are free. Profile 0 gets one earlier: its defence reserve of 25 % (2.2) makes the kept
  share of a defence target of 1 hunter (P 10..19 without soldiers) trunc(0.75) = 0, so the
  defence hunter stays free. First raids by population (C by consequence, hunting researched):
  profile 0 from P 10 (one hunter; two from P 11), profile 1 from P 14 (K = (P - 8) / 6 >= 1),
  profile 2 from P 16 and only against the human.
- rand() order when an army is created: profile 3 first draws rand() mod 1 (DAT `004afec8` = 1,
  always passes), then the cut (rand() mod 3); profile 5 the cut; both draw the cut **before**
  the hostility test, so a non-hostile think still consumes it; profiles 3 and 5 then the town
  index (rand() mod number of towns); then for every profile the tactic (rand() & 1, inside the
  army constructor), the join (no draw), and the first run rand() mod 50.

### 2.5 The army (kind 0x35, every 50 ticks) (C)

- Created with the target town's position (its town hall anchor, town +0x28..+0x30: the
  **target point**), radius 40 cells, the target town and a random tactic (0 or 1). First run
  after rand() mod 50 ticks.
- **"Within 40 cells"** always means around the **target point**, never around a member: the
  circle scan of both tactics is the disc dx² + dy² < 40² around the target point (`0044a7c0`),
  and the per-member test of step 6 below measures the member's wrapped distance (max + min / 2,
  `00459a80`) **to the target point** (< 40, strict, `0x466a29`). So enemy units standing farther
  than 40 cells from the target town's hall (at a shore, at an outpost far out) are neither
  attacked nor counted in the retreat test, however close they stand to a member.

**Joining and moving** (`00465ad0`, called at creation and by every later think; C):

- Each joining unit gets group 53 and a reference. Nothing else is done to a member within 20
  cells of the target point (max + min / 2 not above 20).
- A member farther away has its current job cancelled and gets its own follow-path walk (job
  0x06, not a player order) to the first free cell of a spiral around the target point (the
  same cell for every member of this join), first run after 2 ticks. This is the same routine as
  the player's group move order (`units-and-jobs.md` 3.2).
- There is **no formation and no waiting**: every member walks at its own speed from wherever it
  stood, members from a second town or joining at a later think walk on their own, and the first
  to arrive is attacked alone. An arrived member has no job; the next army run (step 6) gives it
  an attack job.
- **No member looks for enemies on the way.** Neither the walk nor the attack job scans its
  surroundings (`combat.md` 0, 8); enemy units a member passes are ignored unless the member or a
  unit of its race within 12 cells is struck: then the help rule (`combat.md` 7.1, 7.2) sends it
  after the striker (its walk and its army attack job are not player orders). An attack job whose
  target is of class 2 (the school) gives way to a striker of a lower class, for example a tower
  shooting at it: the outpost building stands in for its garrison (`combat.md` 9.7), so the member
  turns on the tower.
- **Gold, add-on mode** (`0046c050`, read at instruction level `0x46c8c3..0x46ca28`): the join
  first adds every unit (group 53, reference). A joining light or heavy warship (65, 66) has its
  job cancelled and, when the army has a target town, sails (job 0x06, first run after 2 ticks)
  to the first cell of a spiral around the target town's position that the ship mask 0xA01E
  allows (no distance test). The land units are then sorted **by the island of their cell**
  (island grid, map +10; groups in island-id order, members in join order). Only while the nation
  has a naval planner (always in add-on mode, `addon.md` 8.4):
  - a group on the **target point's island** is moved as in the base game (cancel and walk when
    farther than 20 cells);
  - every other group makes **one transport request**: units = the group's size, goods 0,
    pickup = the cell of the group's **first** member, destination = the target point, the
    request record's default flags 1 (`00472630`; the record's first field is 8, which earlier
    versions of this spec took for the flags); the members are added to its waiting list
    (`00471f40`) when the request was accepted, and **every member of the group**, whatever the
    request's result, has its job cancelled and gets the wait job 0x3E (first run after 5
    ticks; it only idles, `addon.md` 8.4).

  So the island rule is applied once per join, to the units joining in that think: an army
  formed with ten hunters on its home island makes one request for ten, and each later think
  that adds one new hunter makes another request for that one. Nothing tests whether a unit can
  reach the target at all: without any transport ship the members wait (job 0x3E) until the army
  ends. **Flag 1 makes the request refusable**: the planner refuses it when it already holds more
  than 50 requests, and it never forgets a served one (`addon.md` 8.4 "New request"), so from
  about the 51st transport request a nation has made, no army request is accepted any more and
  every army member on another island waits (job 0x3E) until its army ends; after the end it
  walks home, and the next army that takes it makes it wait again *(quirk)*. Before that, the
  ships follow the planner's rules (`addon.md` 8.4): each ship works for one request per trip;
  a ship the request service assigns sends every waiting unit (five get in, the rest are
  dropped), a ship that was idle when the request was made sends at most its counter (the units
  sent to it since its last service assignment: 1 after a founder or a lone hunter, then 2, 4,
  ...; 0 keeps it sailing empty), the rest wait for a later ship. Units are taken from the
  waiting list whatever they do by then (also after the army ended or retreated, when they have
  since joined the town's defence group, or when they have died: a dead entry uses up a place),
  carried over and put ashore near the target island's coast with no job (`addon.md` 8.4
  "Unloading"); a member is still in its army there, the others are free group-0 units on the
  victim's island (candidates of the next think).
- Every run: if the relation between the army's race and the target town's race is no longer 0 or
  1, the army ends. Otherwise the current tactic runs; afterwards a new random tactic is chosen.
- Both tactics first write the tick into the think job's +0x2C (the cooldown stamp) and end the
  army at once when it has no members left. Dead members are dropped from the army (group 0) as
  the member list is walked.
- **Tactic 0 (assault, `00466020`)**, corrected in the third pass (C, instruction level):
  1. Own power: every member that is alive, a unit and armed (2.1 formula), wherever it stands
     (members still walking, at home, waiting for a ship or aboard count as well).
  2. Candidates: the objects found by the circle scan (`0044a7c0`) of radius 40 around the
     target point, plus, when the army has a target town, **all** of that town's small and
     large outposts, barracks, mage towers / alchemist huts / cult sites and creature yards
     (any state). Separately the **important list**: all buildings of the first non-empty type
     among barracks (39), school (55), laboratory (46), large outposts (53), small outposts (52),
     town hall (40), sites included.
  3. Four target buckets by target class (object +0x20, `combat.md` 1.3: 0 fighters and
     outposts, 1 barracks / beast / magic buildings and civilian units, 2 other buildings and
     criminals). Bucket 0 first receives **one** building: the first element of the important
     list (a set ordered by object address, so in practice an arbitrary one of that type; the
     rebuild takes the first in list order). Then every candidate that is alive and of a race
     0..2 is filed: with a target town only objects of **the target town's race** (no relation
     test; without a target town, objects of a race hostile to the army). A town hall (type 40)
     among the candidates is put aside, never attacked, while the army has fewer than 10
     members; everything else goes into the bucket of its class. The enemy power is summed
     over the filed objects (armed units except priests).
  4. **Retreat** when enemy power > 2 x own power (`004afec0` = 1, `004afec4` = 2): every member
     outside a building has its job cancelled and walks (job 0x06) to its home town's position,
     group 0; the army ends (failure). A town without armed units in the circle never causes a
     retreat.
  5. Otherwise the first non-empty bucket among 0, 1, 2 is taken (all empty: the army ends as a
     success). Because bucket 0 always holds the important building, and every town has at
     least its town hall, **only bucket 0 is ever attacked**: the one important building, the
     target town's outposts and the target race's tier-0 units (hunters, police, saboteurs,
     soldiers) inside the circle. Civilians, houses, barracks (when they are not the important
     type) and other buildings are **not** attacked by the assault. The important town hall is
     attacked even by a small army (the "fewer than 10" rule only applies to candidates).
  6. Assignment, members in army order, current target = first of the bucket, counter 0:
     - a member without a job: gets an attack job (0x08) on the current target if the attack
       check `00465460` allows it; counted **whether or not** it was allowed;
     - a member with an attack job: re-assigned (counted) when its target's class is greater
       than the bucket's, or equal and rand() mod 10 = 0 (the draw is made only in the equal
       case); otherwise it keeps its target and is not counted. In bucket 0 a member attacking
       the school (class 2) is therefore re-assigned in every run;
     - a member with another job: if it is within 40 cells of the target point or stands in the
       target town's area, the job is cancelled and it is assigned (counted); otherwise it is
       left walking;
     - when the counter exceeds 5 - bucket (that is after **6** members for bucket 0), the next
       target of the bucket becomes current, wrapping to the first after the last; so all
       members end on the bucket, six per target in turn.
     - Gold (`0046cbd0`, `0x46d67b`): a member without a job (or whose job was just cancelled
       by one of the rules above) that sits **aboard a transport ship** (unit +0x6C is a type-67
       unit) gets no attack job and is **not counted**. Members waiting for a ship (job 0x3E) or
       walking to one are members "with another job": left alone unless within 40 cells of the
       target point or in the target town's area.
  7. The next tactic is rand() & 1.
- **Tactic 1 (skirmish, `00466e20`)**, re-read in the third pass (C): no power check. Same
  circle scan and race filter. Buckets: 0 = units whose type is 17 (hunter), 21 (police) or
  29..36 (soldiers); 1 = all other units; buildings go to buckets 2 / 3, which are never used.
  Bucket 0 is taken when non-empty, else bucket 1 (loop bound 1, `0x467022`); with both empty
  the army ends as a success. Assignment as in tactic 0 with these differences: **3** members
  per target (counter > 2); a member already attacking is re-assigned only when bucket 0 is
  taken and its target's class is above 0, otherwise it keeps its target; **no rand() draw**.
  Then the next tactic is rand() & 1. Gold (`0046d9e0`): the same aboard rule as tactic 0 step 6.
- So an army never ends by itself while its target town stands, except through a skirmish run
  that finds no unit of the target race outside buildings in the circle (success), a retreat,
  the loss of all members, or a relation change. After a success the members walk home, become
  free again when idle, and the next think can send them again (2.4).
- **Attack jobs of the AI** (both tactics and the defence response, 2.2) are handed over through
  `00465650` with a first-run delay of **5 ticks**; a member inside a building is blocked for 5 ticks
  and sent out first (C, fourth audit).
- **When the important building falls**, each member's attack job retargets by itself
  (`combat.md` 3.6: auto-retarget on, a scan of radius sight + 3 = 13 for hunters and soldiers around
  the fallen building, the target race only, all classes): it takes the best object of the lowest
  class present there, i.e. a fighter, else a **civilian unit** (class 1: the builder of the school
  site, porters delivering to it), else a building. Those attacks run until the next army run (at
  most 50 ticks), which re-assigns members on class 1 or 2 targets to the next important building.
  So the assault does kill civilians standing next to its target, although it never picks them
  itself (C, consequence of `00472190` and 2.5 step 6).
- **No repair, no cooldown** (C, fourth audit): computer players never repair a damaged building
  (repairs come only from the player's command, `combat.md` 13 "Other HP sources"), and a lost
  school or school site is wanted again at the next planner evaluation (1.4, every 50 ticks; the
  site gates of 1.5 permitting), normally on the same spot. A school site starts with HP 50 (one
  tenth of 500) and gains HP only with construction, so while an army stands at the town, every new
  site falls within a few hits (2 to 5 hunter strikes), and the wood already delivered to it is
  lost (the stone comes back as rubble).
- When an army ends for any reason, every surviving member gets group 0 and walks back to its home
  town (`004657c0`), and the player's army slot is cleared. In detail (C, the army's destructor,
  `rand()` call at `0x4659e6`; the same in Gold `0046bd40`): the member list is walked in order;
  each member gets group 0 and loses the army's reference; a member that is alive (inside a
  building or a ship too) has its current job cancelled and gets a follow-path walk (0x06) to the
  first free cell of a spiral around its home town's position, first run after **rand() mod 10 +
  2** ticks: **one rand() per living member**, in member order. The destructor runs right after
  the run that ended the army, so after a retreat (step 4, which first gave every member outside
  a building a direct walk home with delay 1, no draw) these walks replace the retreat's. A
  member that was waiting for a ship keeps its place in the request's waiting list (`addon.md`
  8.4): the ship still fetches it later.

How the attack jobs themselves move and hit is in `combat.md`.

### 2.6 Who attacks whom, and when (consequences of 2.3..2.5, C)

Free play (`Infinite.mdb`): one human, two computer players with random profiles 0..2, all
relations 0 (hostile) until embassies exist. So every computer player is "hostile to the human"
from the start and the attack rules apply at once.

| profile | first raid | target |
|---|---|---|
| 0 | the first think with one free hunter: from P 10 with hunting researched (2.4 notes; below P 10 no hunter is wanted) | before tick 54,000 simply the **first other living player in race order that owns a town**: Amazons attack Pimmons, Pimmons attack Amazons, Sajiki attack **Amazons**, whether human or computer |
| 1 | from P 14 (offensive hunters), before tick 20,000 one free hunter suffices | the first other living player in race order, owning a town, that is strictly weaker (strength 500 + weapons, 2.1); the first player to train a hunter is stronger than an army-less one |
| 2 | from P 16; needs a discovered town of the human and 1.5 x the human's strength | the human only |

Who raids whom with profile 0 before tick 54,000 (C by consequence of the target loop, 2.4):

| human plays | human owns a town | Amazon AI raids | Pimmon AI raids | Sajiki AI raids |
|---|---|---|---|---|
| Amazons | yes | - | the human | the human |
| Pimmons | yes | the human | - | the **Amazon AI** |
| Sajiki | yes | the **Pimmon AI** | the **Amazon AI** | - |
| any | no (only the start founder) | the other AI | the other AI | the other AI |

So computer players do raid each other in the original while a human is present: as Pimmons
one AI, as Sajiki both, and with any race while the human has not founded his town (the human
is skipped, not targeted). Profile 1 can pick the other AI whenever the first candidate is not
weaker; profile 2 never does. All of this stops for a pair only through diplomacy: an embassy
contact gives war (still hostile), and the gate is the relation between **the human** and the
attacker, so a computer player at ceasefire or peace with the human attacks nobody.

Raids start with a single hunter and grow, because every think adds the new free hunters to the
running army and a new army can follow an ended one almost at once. A young victim town has no
defenders (no hunter want below P 10, no barracks below P 16; the hunters of its economy gang
are not defenders, only the help rule of `combat.md` 7.1 makes those within 12 cells of a victim
fight back). The skirmish tactic kills its units outside within 40 cells of the town position;
the assault tactic attacks its school (when it has no barracks, not even a barracks site) and
its fighters, and picks civilians only through the retarget after a kill (2.5). A victim above P 15 wants a barracks (queued once the
barracks invention is researched, 1.5 menu state), and the barracks (or its site, HP 50) is then
the assault's target instead of the school, until it falls. See 1.15
for when a raided town can never recover.

**Late in a game, and across water** (consequences of 2.3..2.5 and `addon.md` 8.4, C; checked
against our build in long island free-play runs, `integration-ai.md` 7d):

- A **new** army needs more than min(10, tick / 30000) free candidates (profile 0), counted over
  the whole nation and all sent. A computer player whose towns stagnate (1.15) or whose fighters
  are kept in the defence group may therefore not attack for hours, then attack once enough free
  units have piled up. A weak attacker does not hold back: the strength tests of 2.4 only pick
  the target, and the retreat test (2.5 step 4) is made only in the army's assault runs.
- **Against a defended town the army retreats at its first assault run** (enemy power within 40 cells of
  the town hall > 2 x the army's), its members walk home and become free, and the next think
  (150 ticks) forms the next army from the same units: as long as the victim is twice as strong
  near his town hall, raids are formed and dissolved every few hundred ticks without anything
  reaching him, except what the ships carry (below).
- **The first unit the victim sees is often alone**, also in the original: members walk
  individually (2.5), and across water each join makes its own transport request (a think
  that adds one new hunter makes a request for one), a ship that was idle when a request came
  sends no more units than its counter allows (1 after carrying a founder or a lone hunter,
  growing with every trip; 0 after an empty service trip), and requests made for armies that
  have since retreated are still served: their units (by then free, or even in their town's
  defence group) are put ashore one shipload at a time at the victim island's coast nearest the
  ship's approach. After about 50 requests a nation's armies stop crossing the water altogether
  (above). A landed unit has no job: **nothing scans for enemies when it lands** (`addon.md` 8.4
  "Unloading"). If its army still runs, the next army run (at most 50 ticks) gives it an attack
  job on the current target wherever it stands; otherwise it waits for the next army of its
  nation, which (being on the target's island and more than 20 cells away) makes it walk to the
  town hall. Meanwhile it reacts like any jobless unit: struck, or a unit of its race within 12
  cells struck, it attacks the striker (help rule, `combat.md` 7).
- **Which of the victim's units the landed raider goes for** (C): only through the army run or
  the help rule. The army run looks at the disc of radius 40 around the victim's **town hall**,
  never around the raider: tactic 0 files the victim's hunters (17), police (21), saboteurs (26)
  and soldiers (29..36) standing outside buildings in that disc into bucket 0 behind the one
  important building and the town's outposts (with up to six members everything goes to the
  important building); tactic 1 attacks the hunters, police and soldiers in that disc first
  (three members per target), other units (civilians, priests, ships) only when none is there.
  Units in towers or aboard ships are not found by the scan; ships (64..67) are class 1. So
  units of the victim near a landing point more than 40 cells from his town hall are attacked
  only when they or the raider's friends strike first. After a kill, the attack's retarget picks
  the next unit of the victim's race within 13 cells of the body (lowest class first, `combat.md`
  3.6), which keeps a raider on the victim's fighters once a fight has started.
- **What the lone raider attacks:** tactic 0 sends it at the first building of the important
  list (barracks, else the school, the laboratory, large outposts, small outposts, the town
  hall) or, for the 7th and later member, the town's outposts and fighters near the town hall in
  turn; tactic 1 at a hunter, police officer or soldier of the victim within 40 cells of the town
  hall. It ignores everything on the way (no scan) unless struck; a tower that shoots at it
  draws it to the tower (help rule, 2.5).

---

## 3. Diplomacy

### 3.1 Relation table (C)

One global table (`004b3950`) holds one entry per unordered pair of the three races, created for
all three pairs and initialised to 0 when a map is loaded (C, `00411200`); free-play and network
games build the same table in `00484330` (I, not read in detail). Lookups compare both
orders. A pair with no entry would read as -1 ("no entry"); in practice all pairs exist.

| value | name (T#240..242) | hostile in AI code | notes |
|---|---|---|---|
| 0 | no contact | yes | default; no embassy relationship yet |
| 1 | war (Krieg) | yes | |
| 2 | ceasefire (Waffenstillstand) | no | |
| 3 | peace (Frieden) | no | enables trade and market inspection |

Combat code treats 0 and 1 the same way (`mdb.md`; details in `combat.md`). (C for the AI code.)

### 3.2 Initial relations (C)

- Campaign maps: set from the mission race blocks after the map objects are created (`mdb.md`
  "Relations"). Only Pimmons 4 (Amazons-Pimmons ceasefire) and Pimmons 8 (Amazons-Pimmons peace)
  set anything; everything else starts at 0.
- Free play and network games (no map file): every pair starts at 0.

### 3.3 Embassy contact and closure (C, `0045fa40`, `0045ff30`)

- **Contact.** When an embassy becomes active (its diplomat moves in), every other present player
  gets mentor#(68 + race) "Die X haben eine Botschaft errichtet." Then, for every other player
  whose relation with this race is 0 and who owns an active embassy in any town, the relation
  becomes **1 (war)**. First contact therefore always starts in war.
- **Closure.** When an embassy is deactivated (the diplomat is sent out with "Betrieb einstellen",
  T312 "Diplomatische Beziehungen abbrechen", or the building is lost) and the player has **no
  other active embassy**, every relation of that player that is not 0 is set back to 0. A diplomat
  walking out on an errand does **not** deactivate the embassy (the operator leaving normally keeps
  the building active, `004613f0`).
- An active embassy runs an operator job every 100 ticks that ejects all occupants of other races
  (e.g. a foreign diplomat after his visit) (`00478cb0`, operator 13).

### 3.4 Offers and the diplomat (C, `004618b0`, `00478650`, `00478910`)

An offer is "war", "ceasefire" or "peace" (state 1, 2 or 3) sent to one race:

1. Only from an active embassy with a stored diplomat (`004618b0`: state 2 and +0xA8 set; he may
   be inside or out on an errand). A diplomat already on an errand is recalled first
   (`00478bd0`) and his current job is cancelled (see 7 for what that does to the embassy). The
   diplomat leaves with a new errand job (kind 0x38).
2. He walks to the **nearest active embassy** of the target race (wrapped distance from his
   position). If the target race has none, the errand ends at once (I: the diplomat, already sent
   out of his embassy, is then left standing outside it).
3. When he has entered it, the offer is decided **immediately and automatically**, by the target
   player's acceptance flags (3.5), not by a dialog:

   | offer | accepted when | messages (sender / receiver) |
   |---|---|---|
   | war | always | mentor#(56 + target) "Du hast den X Krieg erklärt." / mentor#(65 + sender) "Die X haben Dir den Krieg erklärt!" |
   | ceasefire | the target accepts ceasefires from the sender, **or** the two are currently at peace | accepted: #(53 + target) / #(62 + sender); refused: #(50 + target) / index 82 + sender (no text in `Mentor.tdb`, U) |
   | peace | the target accepts peace from the sender | accepted: #(47 + target) / #(59 + sender); refused: #(44 + target) / index 85 + sender (no text, U) |

4. An accepted offer becomes the new relation state (message 0x5B broadcast to all connections and
   applied on each machine, `004583f0` / `004584e0`). Then he walks back to his embassy and the
   errand ends.
5. If he dies or cannot enter, nothing changes (handbook: a third nation may capture him; there is
   no separate capture rule, I).
6. "Diplomat zurückbeordern" (T254) recalls him (`00478bd0`): the errand's current child is
   replaced by a walk home (go-to his embassy); the errand job itself goes on and ends when he is
   inside.
7. **Link to the embassy** (C, `units-and-jobs.md` 8.5): during the errand he stays the embassy's
   stored operator and the embassy stays active. Back inside, the entry restarts the embassy's
   operator job (first run after 100 ticks). If the errand is destroyed under way (it has a walk
   as its child) or he dies, the embassy loses him and is **deactivated** (3.3 closure: relations
   reset when it was the player's last active embassy); no worker request. This happens on a
   player order or move given to the diplomat while he is out, on go home, and on a **second
   offer** sent while he is still out: step 1's recall gives the old errand a walk home as its
   child and then cancels it, so the embassy closes before the new errand starts. The new errand
   still carries the embassy; when he walks back into it, it is activated anew (8.1, with the
   contact rule of 3.3).

Any state can be offered from any state (the panel shows the three buttons; there is no
transition table in the simulation, C by absence in `00478910`). A ceasefire offered to a peace
partner is always accepted (a downgrade). No relation ever changes by time (no expiry found, C by
absence).

Side effects of a state change, sent to both players' user interfaces (`004583f0` -> `00458200`,
message 0x5C per building): leaving 0 makes the other's active embassies selectable, returning to 0
hides them; entering 3 makes the other's active markets inspectable, leaving 3 hides them. (C for
the messages, I for "selectable".)

### 3.5 Acceptance flags (C)

Each player holds, per other race, "accept peace" (player +0x261 + race) and "accept ceasefire"
(player +0x264 + race). Both start at 1 for everybody (`0045cdf0`).

- **Human player**: the two check boxes of the diplomacy panel (T173) toggle them (command
  `00452c90`). With the defaults a human accepts every peace and ceasefire offer.
- **Computer player**: rewritten every think (150 ticks) by `004687a0`, for each other living
  player i, with S = own strength, S_i = i's strength and the profile's weights (1.2):

  | condition | desired state | accept peace | accept ceasefire |
  |---|---|---|---|
  | S_i > w1 x S | 3 peace | 1 | 1 |
  | w2 x S <= S_i <= w1 x S | 2 ceasefire | 0 | 1 |
  | S_i < w2 x S | 1 war | 0 | 0 |

  (Float comparisons.) Profile 4 (weights 0) always wants peace and accepts everything.

- **Computer offers.** In the same evaluation the AI sends its diplomat with the desired state to
  player i when all hold: at least 6001 ticks (about 10 minutes) since its last mission to i (the
  timestamps start at 0, so not before tick 6001), then a 1/15 chance (rand() is only drawn when the
  time condition holds), the desired state differs from the current one, the current state is not
  0, the AI owns a town, and the **first** town's embassy is active with its diplomat at home.

### 3.6 Diplomacy panel and commands (C for commands; layout in `ui/side-panel.md`)

| panel element | effect |
|---|---|
| race tabs (`AMAZONEN`/`PIMONS`/`SAJIKI`), only races that have an embassy | select the race; T309 when none |
| `KRIEG` / `WAFFENSTILLSTAND` / `FRIEDE` under "Aktuell:" | current state 1 / 2 / 3 |
| two check boxes (T241, T242) | toggle accept ceasefire / accept peace for that race |
| offer buttons (T176..T178) | send the diplomat (3.4) |
| diplomat button (T254) | recall |
| status line T230..T232 "Den %s wird ..." | the diplomat's pending errand (target race and offer, from the errand job) |

The panel data message (`004580e0`) carries, per race: state, both flags, and the pending errand.

### 3.7 Missions and goals

Missions set relations only at load (3.2). Goal type 11 tests a relation (`mdb.md`), e.g.
Tutorial 3 "Diplomatie und Handel": the Amazons run profile 4, so they accept the human's peace
offer as soon as both embassies exist (contact gives war first). No scripted relation events
exist (C, `mdb.md`).

---

## 4. Trade

### 4.1 The market (C)

- Market (type 48): no operator, store flag set but storage 0, radius 6 (`odb.md`). A completed
  market reads and writes the **town stock** directly (store flag), so goods sold leave the
  town's shared stock and goods bought go into it, clamped to capacity (`0046e820`, excess lost).
  Porters never use markets as stores (`units-and-jobs.md` 4.3).
- Only merchants trade; there is no automatic exchange between markets.

### 4.2 Market settings per good: town +0x4EC (C)

Nine 24-byte records, one per good 0..8, at town +0x4EC + 24 x good:

| offset | field | handbook / panel | initial | used by |
|---|---|---|---|---|
| +0x00 | maximum stock to buy up to | "Maximale Lagermenge" (Einkauf) | 25 | unloading and good choice (4.4) |
| +0x04 | maximum purchase price | "Max. Einkaufspreis" | base price (goods record +0xD4) | good choice at the route's origin (4.4) |
| +0x08 | purchase enabled | "Einkauf freigeben / sperren" (T228/T229) | 0 | unloading; partner test |
| +0x0C | minimum stock to keep | "Mindestlagermenge" (Verkauf) | 0 | loading |
| +0x10 | minimum sale price | "Min. Verkaufspreis" | base price | **the price actually paid** |
| +0x14 | sale enabled | "Verkauf freigeben / sperren" (T226/T227) | 0 | loading; partner test |

Base prices (`odb.md` A.3): raw material 0, wood 5, stone 5, iron 25, food 5, weapons 60, each
luxury 20. Initialised in the town constructor (`00458cd0`). So a new market buys and sells
nothing until the owner enables goods.

Prices are **static settings**; there is no supply/demand price model (C by absence). The panel
sliders cover 0..capacity for the stock fields and 0..2 x base for the price fields
(`ui/side-panel.md`). Commands: set all six fields of one good (`00452290`), set the purchase flag
(`00452c50`). Foreign markets can be viewed (data message `00456e60` / `00456f10`) but not changed.

The bank has **no effect on trade** in the simulation (C by absence in the trade code; its only
effect is the tax bonus, `economy.md` 4.2).

### 4.3 Trade partners (C, `0045de40`)

A town T2 is a possible partner of town T1 when T2 has an active market and T2 belongs to T1's own
race or to a race at **peace (3)** with it. For the AI an extra test applies: some good must be
"T1 buys and T2 sells" or "T1 sells and T2 buys" (purchase/sale flags). The merchant panel lists,
per race, up to 10 such towns (`00456fc0`).

### 4.4 Merchant and trade route (C, `0047cd10`, `0047ce00`, `0047d4d0`)

- **Merchant**: unit type 28, trained at the school; carries up to **5 units of one good**.
- **Route job** (kind 0x20): origin town A, destination town B. Merchants may enter buildings of
  other races (`units-and-jobs.md` 4.4).
- **Start**: the route command with both towns (own town A, any listed partner town B) replaces
  the merchant's job and starts at once (`004522d0`); with only one end set, a paused route job is
  created and the given end stored. **Stop** ("Handelsroute stoppen") pauses the job (hold 599)
  (`00452620`).
- **Trips**: first to A's market, then to B's, then back and forth. "A's market" means the market
  of that town nearest to the merchant (any state, `0045ad40`).
- **Each run** (whenever a trip leg finishes, re-run after 1 tick):
  - if A or B no longer exists: the route ends (failure);
  - if B's race differs from the merchant's and their relation is not peace: the current trip is
    cancelled and the merchant goes home (to A's market; the job ends there);
  - if the town he heads to has no market: the route ends and he walks to his home town.
- **At a market of town M** (on entering it; the other end of the route is D):
  1. **Unload**: if M has purchase enabled for the carried good, he puts down
     min(carried, M.max stock - M.stock). No money changes hands here. The rest stays on him.
  2. **Choose a good** to load, among goods where M has sale enabled, D has purchase enabled and M
     has stock: n = min(M.stock - M.min stock, D.max stock - D.stock) (negatives count as 0), capped
     at 5; goods with n = 0 are skipped.
     - At the origin (M = A) when A and D are of different races: pick the good with the largest
       (D.max purchase price - M.min sale price) x n; a good is only taken if that value is >= 0
       (later goods win ties).
     - Otherwise (at the destination, or own-race routes): pick the good with the largest wanted
       amount (D.max stock - D.stock); later goods win ties. **No price test.**
  3. **Load**: if he still carries a different good, that load is **thrown away**. n is cut to
     5 - carried. For different races: if D's owner is human and M's sale price is not 0, n is also
     cut to D's owner's money / price. The payment is price x n with price = **M's minimum sale
     price**: M's owner receives it; D's owner pays it only if human (clamped at 0). M's stock
     drops by n; the merchant now carries the good.
- Own-race routes move goods without money (handbook p. 35).
- The handbook's "he trades at the terms of his departure market" is only partly true: each load
  is paid at the sale price of the market where it is loaded; the destination's maximum price is
  only consulted when choosing goods at the origin.

Money flow summary (`0047d4d0`, `0045dab0` add, `0045db60` subtract):

| situation | seller (owner of M) | buyer (owner of D) |
|---|---|---|
| same race | nothing | nothing |
| different races, buyer human | + price x n | - price x n (n limited by the buyer's money) |
| different races, buyer computer | + price x n | nothing (computer imports are free) |

### 4.5 Route endings (handbook p. 35 versus code)

| ending | code |
|---|---|
| new order to the merchant | replaces the job (C) |
| "stop route" | pauses (hold 599), job kept (C) |
| a market destroyed | the route ends when the merchant next needs that market (C) |
| peace with the partner ends | the merchant returns to A and the route ends (C) |
| the merchant is attacked | I: the flee job of an unarmed unit replaces the route (`units-and-jobs.md` kind 0x26); not traced |

The trade route panel's row of good buttons (`ui/side-panel.md`) has no counterpart in the
simulation; the merchant chooses goods himself (U what the buttons do).

### 4.6 Computer markets and merchants (C, `0046dd50`, every 150 ticks)

Only when the town has an active market. For goods 1..8 (raw material excluded), with C =
capacity, S = min(stock, C), e = (C - S) x 100 / C (the empty share in percent) and base = the
good's base price:

| case | settings written |
|---|---|
| the own race's luxury, S >= 9 | sell on, buy off, min stock 5, min sale price = base x (e + 50) / 100 |
| the own race's luxury, S < 5 | sell off, buy off |
| the own race's luxury, 5..8 | unchanged |
| other good, S < 20 | buy on, sell off, max stock = C x 75 / 100, max purchase price = base x (e + 12) / 100 |
| other good, S > 20, or S = 20 with e < 25 | sell on, buy off, min stock = C x 25 / 100, min sale price = base x (e + 88) / 100 |
| other good, S = 20 and e >= 25 | sell off if e > 40; buy off if e < 60 |

(All integer divisions.) Then the partner list (4.3, with the flag test) is built; the number of
partners is written to the planner's array A for merchants (so the AI trains one merchant per
partner). Every merchant of the town (free or group 51): with no partner it is released; otherwise
it joins group 51, keeps its route if its current destination is still a partner, else gets a new
route from this town to the **first** partner in the list.

---

## 5. Multiplayer

- No computer players exist in network games (1.1), so all AI rules above are single-player only.
  (C)
- Relations start at 0; contact (embassies on both sides) sets war; offers between humans are
  decided automatically by the receiver's check boxes at the moment the diplomat arrives (both
  default to "accept"). A player who wants to refuse peace must untick the box beforehand. (C)
- Relation changes are broadcast as message 0x5B to all connections and applied on every machine;
  the decision itself is made where the diplomat's job runs (I: the hosting machine, consistent
  with the handbook's remark that the server does more computing).
- Trade between humans uses the same rules; the buyer pays from his treasury and the amount is
  limited by it. (C)
- The AI attack rules refer to "the local human player" (`004af3cc`); in a network game this
  variable is per machine, which is harmless only because there is no AI. A rebuild that adds AI
  opponents to multiplayer must replace it with an explicit target choice (recommendation).

---

## 6. Worked examples

### 6.1 Building targets for a Sajiki computer town

Population 30, 9 completed buildings, porters are a quarter of the units, income 203, research
spending 40, first town of the player, one mine, one farm, town id 4.

- school 1; warehouses = 1 mine + 2 = 3; mine 1; armoury 1; farm 1; luxury works 1; barracks 1;
  embassy 1; police 1; market 1; bank 1 (203 > 110); library 0 (40 <= 100); watchtower 1
  (30 / 20); mage tower 0, creature yard 0 (P <= 40); laboratory 1 (permanent extra want).
- With 2 small houses and 1 large house, H = 15 and O = 200 %, and H < 150, so a house is wanted
  if porters are under 50 % of P (they are), i.e. target = houses + 1; with chance 2/3 it is queued
  as a large house.
- Queue order by priority: school 2, lab 4, house 5, warehouse/police/armoury 7, barracks 8,
  farm 9, mine 11, market/outposts 12, bank 13, embassy/luxury/watchtower 14 (only types below
  target and without a site are queued).

### 6.2 Diplomacy evaluation

Pimmon computer player, profile 1: w1 = 0.75 x 0.667 = 0.5, w2 = 0.3 x 0.667 = 0.2. Own strength
S = 500 + 6 archers x 20 + 2 hunters x 20 = 660. Human Amazons: S_h = 500 + 10 archers x 20 = 700.

- 700 > 0.5 x 660 = 330: desired peace; the AI accepts peace and ceasefire from the Amazons.
- If the Amazons offer peace, their diplomat's arrival makes it peace (#47+1 for the human).
- The AI would want war only if S_h < 0.2 x S. Because every player has the base 500, that
  needs own strength above 5 x the other's, e.g. S = 3600 against an army-less 500 (about 155
  archers' worth of weapons). With S_h between 0.2 x S and 0.5 x S it wants a ceasefire.

### 6.3 A trade trip

Human Pimmon town A: food stock 40, sale on, min stock 15, min price 10. Amazon computer town D:
capacity 50, food 8 (computer rule: S < 20, e = 84): buy on, max stock 37, max price 5 x 96 / 100
= 4.

- At A (origin, races differ): profit for food = (4 - 10) x 5 < 0, so food is **not** chosen;
  with no other good the merchant leaves empty. The computer's price ceiling protects it here.
- If A lowers its food price to 3: n = min(40 - 15, 37 - 8) = 25, cut to 5; profit (4 - 3) x 5 = 5
  >= 0; food is loaded. D's owner is a computer, so the human receives 3 x 5 = 15 and the AI pays
  nothing. At D the merchant unloads min(5, 37 - 8) = 5 food.
- Then at D (destination) he loads whatever A wants most that D sells, at D's sale price, paid by
  the human (limited by his money), without checking A's maximum price.

### 6.4 Wave timing (profile 5)

At tick 100,000 (about 2 h 50 min) n = min(15, 100000 / 20000 + 4) = 9. An attack starts when the
player has at least 11 free soldiers/hunters (all towns together) and is hostile to the human; the
army is cut to 9..11 units and sent to a random human town. Before tick 60,000 the wave size is 1
(2 candidates needed).

### 6.4a Siege arithmetic (C for the rules: `combat.md` 4.1, 5.2, 5.3; numbers from `dv.wdb` / `dv.odb`)

Hunters (50 HP): Amazon bow 10..20, range 5, hit 70 %; Pimmon and Sajiki spear 10..20, melee, hit
100 %; cooldown 40 for both, so one strike every 41..61 ticks (mean 51). Mean damage per tick:
Amazon 0.21, Pimmon / Sajiki 0.29 at rank 0. Damage to a building earns half of it as experience,
so a hunter (H 50) reaches rank 1 (x1.25) after 200 HP of building damage, rank 2 (x1.5) after 600
and rank 3 (x2) after 1,800. No armour, no building modifier, no race factor.

| target | HP | time for the army (Sajiki spear hunters, rank 0 at the start) |
|---|---|---|
| school site at creation | 50 | 4 strikes: about 200 ticks for one hunter |
| school | 500 | about 1,500 ticks for one hunter, 750 for two |
| barracks site at creation | 50 | as the school site |
| town hall | 10,000 | about 3,500 to 4,000 ticks for six hunters (ranks 2..3 reached on the way) |

A town without armed units (no hunting yet, below P 10) has nothing that fights back (2.2, and
the help rule needs an armed unit of the victim within 12 cells): an army of one or two hunters
destroys its school, every school site placed afterwards, then (school list empty) its laboratory,
then the town hall. At about 100 ms per tick (`combat.md` header), a lone hunter needs about
2.5 minutes for a school; six need 6 to 7 minutes for a town hall.

### 6.5 Research slider

Computer town with income 200, overheads 60, an active laboratory, a project, player money 180:
reserve = 200 / 5 = 40, research = (200 - 60 - 40) x 100 / 200 = 50 %.

### 6.6 Founding

Profile 0 player with towns of population 45 and 22: the smallest (22) exceeds 20 and the player
has 2 < 4 towns, so the smaller town trains a founder (priority 15). Once he is free, the founding
mission scans the map's start candidates in file order for a site whose radius-25 circle touches no
town area, walks the founder to within 8..15 cells of it and founds the town there.

---

## 7. Remaining unknowns

1. Object field +0x20 used to sort attack targets into four classes in tactic 0 (2.5).
2. (Answered in the second pass, 1.5 steps 5..6: the padded rectangle is tested with the
   click test, the building's maximum corner is the found position minus one.)
3. Mentor indices 82..87 for the receiving side of refused offers: no text exists; whether the
   original shows anything.
4. Diplomat recall (`00478bd0`) details and whether a recalled diplomat can be re-sent at once.
5. Whether "the merchant is attacked" ends the route through the flee job (4.5).
6. The trade route panel's good buttons (4.5).
7. The economy job's unused list at +0x6C; its iron flag +0x2C is always 1 and was not seen read
   (town +0x48 is answered in 1.4).
8. Whether computer towns ever set the crop conversion divisor (town +0x6C); none of the AI jobs
   writes it (I: AI farms only feed luxury works).
9. Network play: on which machine diplomacy decisions and trade payments are computed (5).
10. The meaning of the flag set at player AI job +0x34 when an attack is attempted (written, never
    read in the code examined).
11. Tactic 1's assignment loop (2.5) was not re-read in the second pass (wrap-around assumed as
    in tactic 0 and in the defence response).
12. What a released gatherer does inside the school (1.8): whether the go-into job makes it an
    occupant usable as a trainee, or it leaves again.

## 8. Notes for other documents

- `dvm.md` says the AI uses lists 0 and 1 "when choosing where to found a new settlement". In the
  code, founding uses list 3 (start candidates); lists 0 and 1 anchor the first two warehouses and
  the gathering search (1.12, 1.13).
- `odb.md` 5 ("the AI spaces towns 2 x radius apart, `0046c1a0`"): `0046c1a0` uses 2 x the town
  hall radius as the **building** search radius; town spacing comes from the founding test
  (1.12).
- `units-and-jobs.md` 3.1 lists kind 0x28 as "group move (formation)"; it is the scouts' explore
  job (walk to random cells), created by `00468e10`. Its 8.1 sentence "when the operator leaves the
  building, the building is deactivated" applies only when the operator is sent out (or another
  unit of the operator type leaves), not when the operator leaves on an errand (`004613f0`).
- `economy.md` 2.2: the market table at +0x4EC is decoded in 4.2; its unknown 10 (`0047d4d0`) and
  11 (AI jobs) are answered here.
- `rules-from-manual.md` open questions 23, 24, 25 are answered in 4.4, 4.4 and 3.4/3.5.
- `units-and-jobs.md` 9 (training): when a training building is destroyed, its training job is
  deleted and the job's destructor (`004761e0`) lowers the town's pending count (+0x39C) for every
  order still queued, without refund (1.15). The AI's "queued" counts depend on this.
- `combat.md` 9 / `integration-ai.md`: the AI military job does not refill outposts (2.2, dead
  branch); garrisons come only from the completion worker requests.

---

## 9. Gold Edition add-on: the computer navy (C, summary; details in `addon.md` 8)

Re-derived 2026-10 from `dvge.exe` after a play-test report ("an hour of island free play, never a
ship of another nation"). The Gold AI routines were compared with the AN ones: the think job, the
profiles and strategies, the founding check, the research pick (`00413610` = AN `00410490`) and
the next-topic rule (`00478f00`), the training step (`00475970` = AN `0046c670`) and the planner
run (`00475b90`) are unchanged apart from the 68-entry arrays. The additions are all in the
building targets, the training needs, the gangs, the gathering, the markets job, the army, the
founding mission and the new naval planner. **Nothing in them depends on the AI profile**; the
profile only decides how often founding and attacks happen, and those reach the ships.

| what | rule | where |
|---|---|---|
| shipyard 63 | target 1 when P > 14 (normal-target branch, 5+ completed buildings); queued like any building (priority 4), so only once invention 30 (Werft) is researched and the goods are in stock; site at the town's own shore (`addon.md` 3.1, 8.1); a town without shore in its area never gets one | `00474680` |
| harbour 62 | target 1 when P > 19; priority 8; needs invention 31 (Hafen) | `00474680` |
| research | unchanged: the cursor walks the race's list in order, so 30 Werft, 31 Hafen and 32 heavy warship come **after every base invention 0..29** (1.11). Free play: Niedrig grants none of them; Mittel grants 30 and 31; Hoch grants 30, 31, 32 (`economy.md` 4.4.2). Campaign missions preset them per race block | `00478f00`, `00413610` |
| fishing boat 64 | gang of 1 in every add-on town (A[64] = 1, max(1, food factor / 4) with food factor 0), trained at the shipyard (priority 12). Every 150 ticks while food space > 5 each gang boat gets a new fishing job on a random water cell of the whole map (up to 41 tries), replacing its current job | `00478180`, `00477610` |
| light warship 65 | gang of 1 when P > 20 (needs invention 15 and the shipyard). Each idle gang member gets the explore job 0x28: a random map cell, the nearest cell the ship may use by a square spiral around it, a follow-path walk there, then again after rand() % 5 + 1 ticks | `00478180`, `00487700` |
| heavy warship 66 | never wanted by the gangs; only trained when the planner's build[66] or claim[66] asks (after a planner-owned 66 died, which never happens: no planner 66 exists) | `004740c0` |
| transport 67 | (1) want(67) includes the planner's **claim[67]**, initially 1 for every computer nation, so the first town with a shipyard trains one transport (priority 4) and the planner takes it over (group 61); (2) build[67] = u/2 when more than 3 ship requests are unserved; (3) A[67] = number of harbour trade partners (markets job, second pass), whose ships stay ungrouped and run trade routes | `004740c0`, `00472b30`, `00477060` |
| settling other islands | the founding mission (1.12) takes the first valid site of the start-candidate list. Island maps list the candidates island by island, **largest island first** (`formats/addon.md` 10.2 step 2), so a nation that does not live on the largest island usually targets a site there: its founder asks the planner for a ship (job 0x3E), is carried over, and the mission **ends when he is aboard** (1.12 step b). He lands and stands idle in group 54; that town founds nothing more while he lives | `0046f340`, `00472630` |
| sea trade | harbour trade routes to partner harbours on any island (markets job pass 2); partners need the base trade conditions (peace, 4.3), so nothing happens without diplomacy | `00477060` |
| attacks across water | when units **join** the army (2.5 "Joining and moving": at creation and at every later think) they are grouped by island; one ship request per group not on the target's island (pickup = first member, destination = the target point); those members wait with job 0x3E; on board they are skipped (and not counted) when the army hands out attack jobs. Free warships 65/66 are candidates too and sail to the target. Same profiles and gates as on land (2.4) | `00470140`, `0046c050`, `0046cbd0`, `0046d9e0` |
| defence against ships | nothing new: the military job and the intruder records are the base ones; outposts and armed units shoot ships in range, the warship gang member defends only through the help rule and patrol contacts | (no add-on code) |

**Free play versus campaign.** The routines are the same. Differences come from data: campaign
records preset inventions 30..32 and the AI profile per race, and campaign maps carry their own
point lists (the founding candidates); free play uses profile `rand() % 3` (0..2) and the island
generator's lists. In island free play every race starts on one of the three largest islands
(`formats/addon.md` 10.2 step 3), so every crossing needs a ship.

**What a human sees in island free play** (consequences, C): at Niedrig no computer ship
exists before the AI has researched its whole base tree (in our runs 35,000..50,000 ticks, about
an hour). At Mittel / Hoch the shipyard follows at P > 14 (our runs: 8,000..13,000 ticks), then a
fishing boat that wanders the whole sea, a transport, and from P > 20 a patrolling warship. A
transport carrying one founder towards the largest island follows as soon as a profile's founding
threshold is reached (profiles 0..2: smallest town above 20, 10 or 30 people).
