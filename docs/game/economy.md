# Clock and town economy (behaviour spec)

Status: **the clock, the scheduler, the round settlement, food and luxury consumption, the
happiness formula, births, criminal births, storage and the town territory (section 11) are
decoded from AN.exe.** Births, criminal births, needs and happiness were re-verified against
AN.exe and dvge.exe (sections 3.2, 3.6, 5.3 to 5.6, 6); section 12 lists where our engine
differs. Crime/police behaviour and the market are only sketched.

Sources: the decompiled and disassembled AN.exe (function addresses are cited as evidence; no code
is reproduced), `dv.odb` (see [../formats/odb.md](../formats/odb.md)), `Mentor.tdb` / `DV.tdb`
strings (cited `mentor#N` / `tdb#N`), the mission record (see [../formats/mdb.md](../formats/mdb.md))
and the handbook digest [rules-from-manual.md](rules-from-manual.md) (cited "handbook p. N").

Legend:

- **C** confirmed: the code that does it was read and understood.
- **I** inferred: follows from data flow, naming or consistency, but no single piece of code proves it.
- **U** unknown.

Notation: "town T+0x44" means the 32-bit field at offset 0x44 of the town object. "player" is the
nation object (one per race in play). "Tick" is one step of the game scheduler (section 1).
All divisions in formulas are C integer divisions (truncate toward zero) unless marked as float.
Where the original uses 32-bit floats this is stated, because it changes results (section 8.2).

---

## 1. The clock

### 1.1 How real time drives the game (C)

- The program's main loop (`0048b120`) handles window messages. When the message queue is empty,
  it calls the update method of a "tickable" manager (`00487c40`). That manager keeps a ring of
  tickable objects. Each call takes **one** object from the front, calls its update, and puts it at
  the back. So every tickable (renderer, network, scheduler, ...) is polled in turn as fast as the
  machine runs.
- The game scheduler is one of these tickables (global `DAT_004b3940`, created in map setup
  `00485a30` by `00482a50`). Its update method is `00482ca0` (vtable `004a6994`, slot 1).
- On each poll the scheduler reads `GetTickCount()`. A static "last tick time" is set to the
  current time on the very first poll. A game tick happens only when
  `now - last > interval` (strictly greater). Then `last = now`, and **one** tick is processed.
  There is no catch-up: if a frame took 300 ms, only one tick happens and the lost time is gone.
- If the scheduler's pause byte (scheduler +6) is set, the poll updates `last` but processes no
  tick.
- After processing a tick, the global tick counter `DAT_004b3780` is incremented. It is written
  to and read from save games (`0040ca00` / `0040ce90`) and reset to 0 on a new map (`0040e970`).
  The simulation itself mostly does not read it (only AI and some unit code do).

### 1.2 Tick interval and game speed (C)

- The interval in milliseconds is `setting * 95 / 100`, stored at scheduler +0x18. The scheduler is
  created with setting 100, so the default interval is **95 ms** (`00482a50`, `00485a30`).
- The speed setter `004403d0(setting)` recomputes the interval and also stores it in
  `DAT_004afaa4`, which animation/movement interpolation multiplies by (`00434bc2`, `00455947`,
  `0045657b`). It works only when `DAT_004af3d4` is set (the machine that owns the simulation; I).
  In a network game it also sends the new interval to the other players (message 0x65), who only
  update their animation copy (`00458a30`).
- Keys (virtual-key switch in `004404a0`, table at `00440370`):

| key | setting | interval | name (I) |
|---|---|---|---|
| F5 | 100 | 95 ms | normal |
| F6 | 50 | 47 ms | fast (about x2) |
| F7 | 25 | 23 ms | fastest (about x4) |

  (Same switch: PageUp/PageDown zoom, arrows scroll, F1..F4 chat, F12 quicksave.)
- Pause (C): opening a modal menu (`004295e0`) sets the scheduler's pause byte when this machine
  owns the simulation and either it is single player or the caller asks for it; closing the menu
  (`00429800`) clears it.

**Real-time tick length (I).** Because a tick needs `now - last > interval` and `GetTickCount`
advances in steps of its timer granularity G, the real tick period is the smallest multiple of G
that is greater than the interval (plus any frame time that delays the next poll):

| G (OS timer step) | normal (95) | F6 (47) | F7 (23) |
|---|---|---|---|
| 1 ms | 96 ms = 10.4 tick/s | 48 ms = 20.8/s | 24 ms = 41.7/s |
| 10 ms | 100 ms = 10.0/s | 50 ms = 20.0/s | 30 ms = 33.3/s |
| 15.625 ms (common NT default) | 109.4 ms = 9.1/s | 62.5 ms = 16.0/s | 31.25 ms = 32.0/s |

The designers' intent is clearly "about 10 ticks per second" at normal speed, with x2 and x4.
**Recommendation for the rebuild:** 100 ms per tick at normal speed, 50 ms and 25 ms for the two
faster speeds. `docs/architecture/simulation.md` currently assumes 50 ms; its owner should change
`TICK_MS` to 100 (all periods below are in ticks, so nothing else changes).

### 1.3 The scheduler: a 600-slot timing wheel (C)

Object layout (`00482a50`): +0x18 interval ms, +0x20/+0x24 begin/end of an array of **600 slots**
(each slot is a doubly linked list of job pointers plus a count), +0x2C current slot index,
+0x30 = 600.

- **Schedule** `00482c30(sched, job, delay)`: the job is appended to the **back** of slot
  `(current + delay) mod 600` (one subtraction of 600 only, so valid delays are 0..599).
- **Process one tick** (`00482ca0`): while the current slot is not empty, take the job at the
  **back** of the slot (so jobs in one slot run in **reverse order of scheduling: last scheduled,
  first run**), unlink it, and then:
  1. If the job's "cancelled" byte (+0x18) is set and its "hold" value (+0x04) is 0: delete the
     job. Done.
  2. If the hold value is not 0: do not run it; re-schedule it `hold` ticks later.
  3. Otherwise call the job's run method (vtable slot 1). Its return value R is the delay until the
     next run.
     - R > 0: re-schedule after `max(R, hold)` ticks.
     - R = 0 and hold > 0 (the run method set a hold): mark it cancelled and re-schedule after
       `hold` ticks.
     - R = 0 and hold = 0: delete the job.
  4. Repeat until the slot is empty. A job scheduled with delay 0 while the slot is being
     processed is appended to that same slot and therefore runs in the same tick, immediately
     (it is now the back element).
- Then the tick counter is incremented and the current slot index advances by one (wrapping
  600 -> 0).
- Clearing (`00482e20`) deletes every job in every slot. Saving (`00482ff0`) writes the current
  slot index, the global job serial counter `DAT_004b514c`, and every slot's jobs in slot order.
- Consequence: a job that returns R runs exactly R ticks later. A periodic job with period P
  runs at ticks t0, t0+P, t0+2P, ... Jobs that fall on the same tick run in LIFO order of their
  insertion into that slot. **To be bit-exact with the original, a rebuild must reproduce this
  order** (it matters where jobs share the global random generator, section 3.2).

### 1.4 Job objects (C)

Every timed behaviour is a job object (base constructors `004823b0`, `004821c0`, `004822e0`):

| off | meaning |
|---|---|
| +0x00 | vtable: slot 0 destructor, slot 1 run (returns next delay in ticks, 0 = finished) |
| +0x04 | hold: when non-zero the job is not run, only re-polled every `hold` ticks. Used to suspend a building's production job while the building is inactive (set to 10 in `0045ff30`, cleared in `0045fa40`) |
| +0x08 | byte flag (job specific) |
| +0x0C | unique serial number from the global counter `DAT_004b514c` |
| +0x10 | job kind (small integer; values used below) |
| +0x14 | optional sub-job (e.g. the current walk/attack action) |
| +0x18 | cancelled flag: other code cancels a job by setting it; the scheduler deletes it when it next comes up |
| +0x1C | owner (town, player, unit or building); the owner's reference count is raised while the job exists |
| +0x20.. | job specific |

### 1.5 Economy-relevant periodic jobs

| job (kind) | owner | first run | period | what it does | evidence |
|---|---|---|---|---|---|
| finance round (0x2C) | player | 299 | **299** | settles money for all the player's towns (4.1) | created `0045d780`, run `0046edd0` |
| goal check (0x2D) | human player | 50 | 50 | mission goals / win-lose | `0045d780`, run `0046ee40` |
| player status (0x2F) | human player | 10 | 10 | UI status refresh (not analysed) | `0045d780`, run `0046ed90` |
| consumption (1) | town | 299 | **299** | food and luxury consumption (5.1, 5.2) | `00458cd0`, run `0046f650` |
| town status (2) | town | 1 | **50** | happiness (5.5), free-porter list; every 12th run (600 ticks) building decay and condition (5.8) | `00458cd0`, run `0046f820` |
| idle stroll (3) | town of a human player | 199 | 199 | idle porters walk to a house, tavern or circus (no economic effect found) | `00458cd0`, run `00470340` |
| research (0x2E) | town | 30 | **30** | research progress and research spending (4.4) | `0045a570`, run `0046f490` |
| house (10) | house / town hall | 599 | **599** | rehouse homeless, then try one birth (3.2) | `0045fa40`, `00461690`, run `004749e0` |
| production | producing building | 1 | 30 | see odb.md section 8 | `0045fa40`, `00476380` |
| operator | staffed building | - | 50..299 | diplomat 100, farmer 99, news 299, police 50 | `00478cb0` |
| criminal (0x17) | criminal unit | 50 | 50 | picks a victim (6) | `00464840`, run `004784d0` |
| jail (0x19) | arrested criminal | - | 599 once | releases him as a porter (6) | run `0047cca0` |

### 1.6 The "round" (C)

The handbook's "round" (tax, upkeep, food, research per round) is **299 ticks**: the finance job
and the consumption job both run every 299 ticks. At ~10 ticks per second a round lasts about
30 seconds of real time at normal speed (28.7 to 32.7 s depending on the timer granularity,
table 1.2). The two jobs are independent, so their phase can differ (the finance job is per
player and starts 299 ticks after the player is set up; the consumption job is per town and starts
299 ticks after the town is founded).

Building decay runs on a 600-tick period (12 x 50) and houses on 599 ticks; these are close to
"two rounds" but are separate clocks.

---

## 2. Nations and towns

### 2.1 Player (nation) object (C unless marked)

| off | meaning | evidence |
|---|---|---|
| +0x10 | race 0 Amazons, 1 Pimmons, 2 Sajiki (also the index in the global player table `DAT_004b38bc`) | `0045cdf0` |
| +0x1C | **money** (national treasury). Never negative: every change clamps the result at 0 | `0045dab0`, `0045db60` |
| +0x21C/+0x220/+0x224 | the three player jobs (1.5) | `0045d780` |
| +0x230..+0x238 | list of the player's towns (+0x238 = count) | `0046edd0`, `0045fa40` |
| +0x25C | the player's UI/network connection; status messages go there | many |
| +0x260 | **computer player flag** (1 = AI). Set for the computer races of the mission record, 0 for humans (`00485a30`, `0045cdf0`). Several rules differ for AI towns (marked "AI" below) | |

Starting money: when a player is set up (`0045d780`), money starts at 0 and the mission race
block's start gold (+0x0C of the block, absolute record offset 0xB28 + race x 0x154) is added
(clamped at >= 0). See mdb.md for the free-play overrides.

**Money belongs to the player, not to the town.** Towns have no money field; they only report
their part of the round settlement (4.1). All towns of a nation pay into and out of one treasury.

### 2.2 Town object

A town is created when a town hall is founded (`00458cd0`, constructor). It is the economic unit:
population, stock, needs, happiness and the per-round budget are all per town. Its centre and
"face" is the town hall building, which the constructor creates at the town position.

| off | type | meaning | status / evidence |
|---|---|---|---|
| +0x08 | ptr | idle-stroll job (human towns only) | C `00458cd0` |
| +0x0C | ptr | town-status job (50 ticks) | C |
| +0x10 | ptr | consumption job (299 ticks) | C |
| +0x14 | ptr | research job (when a project is selected) | C `0045a570` |
| +0x18/+0x1C/+0x20 | ptr | AI planning jobs (AI towns; started at town-hall completion with delays 16/1/33) | C `0045fa40` |
| +0x24 | i32 | town id (global serial) | C |
| +0x28..+0x30 | i32 x3 | town position | C |
| +0x34 | byte | alive | C |
| +0x38 | i32 | reference count | C |
| +0x3C | i32 | **motivation spending, percent of income** (slider) | C `0045a130` |
| +0x40 | i32 | **research spending, percent of income** (slider); AI towns start at 40 | C `0045a130`, `00458cd0` |
| +0x44 | i32 | **population**: number of units of any type whose home town is this town (porters, specialists, soldiers, criminals, founder, homeless) | C `00460830`, `00464350`, `00464840`, `00464ba0`, `00464c30` |
| +0x48 | i32 | second unit counter; moves together with +0x44 in every path found | I |
| +0x4C | i32 | number of completed buildings | C `004602d0` |
| +0x50 | i32 | number of building sites | C `004602d0` |
| +0x54 | i32 | **storage capacity per good** (same for all nine goods) | C (7) |
| +0x58 | i32 | invention being researched, -1 = none | C `0045a570`, `0045a730` |
| +0x60 | i32 | food produced in the current round (gathered food + food from crop conversion) | C `0046e820` |
| +0x64 | i32 | food produced in the previous round | C `0046f650` |
| +0x68 | f32 | crop-conversion accumulator | C `0046e820` |
| +0x6C | f32 | crop-conversion divisor (0 = no conversion; set by the raw-materials ring, I) | C `0046e820` |
| +0x70 | f32 | displayed "food production per round" = (this round + last round) / 2 | C `0046f650` |
| +0x74 | f32 | research spending accumulator for the current round | C `0045a650`, `0046edd0` |
| +0x78 | i32 | 1 if the last happiness update added a motivation bonus | C `0045a7c0` |
| +0x7C/+0x80 | | name index / name string (from the race's pool of 10) | C |
| +0x84 | ptr | owning player | C |
| +0x88..+0xA8 | i32 x9 | **stock** of goods 0..8 (goods index as in odb.md) | C |
| +0xAC/+0xB0 | i32 | zeroed, purpose unknown | U |
| +0xB4..+0x39B | 62 x 12 | per-object-type lists of the town's objects (type t at +0xB4 + 12t: list head at +4, count at +8). E.g. criminals = count at +0x14C, town halls at +0x29C, warehouses at +0x2A8, banks at +0x308, labs at +0x2E4, libraries at +0x2F0, porters at +0x128 | C |
| +0x39C..+0x493 | i32 x 62 | per-unit-type number of training orders pending | C `0045f560` |
| +0x494 | i32 | **income** of the last settlement (tax) | C `0045a130` |
| +0x498 | i32 | motivation spending of the last settlement | C |
| +0x49C | i32 | research spending of the last settlement | C |
| +0x4A0 | i32 | **overheads** = sum of upkeep of active buildings | C `0045fa40`, `0045ff30` |
| +0x4A4 | i32 | crime percent | C `0045a7c0` |
| +0x4A8 | i32 | food supply percent | C |
| +0x4AC | i32 | needs percent | C |
| +0x4B0 | i32 | average building condition percent | C `0045ab60` |
| +0x4B4 | i32 | **happiness** (motivation), 0..100 | C `0045a7c0` |
| +0x4B8..+0x4C0 | list | need list {type, threshold, copy}, sorted by threshold (+0x4C0 = count) | C `00458cd0` |
| +0x4C4..+0x4D0 | set | set of **open needs** (object types; +0x4D0 = size) | C `0045a2c0`, `0045a7c0` |
| +0x4D4..+0x4DC | list | free (idle) porters, rebuilt every 50 ticks | C `0045aed0` |
| +0x4E0..+0x4E8 | list | **homeless** units (+0x4E8 = count) | C |
| +0x4EC.. | 9 x 24 | market settings per good (initialised with 25, base price, 0, 0, base price, 0) | I (trade, not analysed) |

Initial values (`00458cd0`): happiness, food%, needs% and condition% = 100; everything else 0;
the first town hall is created and registered; the need list is built (5.3).

### 2.3 Founding a town (C, `0045fa40` for a town hall that becomes active)

The town hall becomes active when its operator, the founder (type 10), enters it (the generic
"operator enters" path, `00460ed0` area), or at once for map and computer start towns (map
loader `00411200`, free-play start). Completing the town-hall site (`004602d0`) only sets its
hit points and the building counters; it does **not** run the residence birth of 3.2.

- The town hall adds its storage (25) to the town capacity (7).
- It creates three units through the birth routine (3.2), in this order: one builder (type 11) and
  two porters (type 9). The town hall has 3 resident places, so these fill it.
- Starting stock: if the player now has at most 1 town, the nine goods are set from the mission
  race block (column 1, block +0x1C + 8 x good). Otherwise the town gets **10 food, 10 wood and
  10 stone** (assembly `0045fc78..0045fc93`). Note: mdb.md says "10 food" only; the code sets all
  three. (The stock is assigned directly, not capped by capacity.)
- The town hall also gets a house job (599) because it has resident places.
- AI: the town's three AI jobs are started.

---

## 3. Population

### 3.1 Who counts (C)

Population (town +0x44) counts every unit whose home town is the town, of any type. It changes
when a unit is born (`00460830`), changes home town (`00464350`), changes type (`00464840`,
removed and re-added), or is added/removed otherwise (`00464ba0`, `00464c30`). Every change
re-evaluates the town's needs (5.3). Homeless units and criminals count in the population (they
eat), but not in tax (4.2).

### 3.2 Births (C)

Re-verified in GOG `AN.exe` (`00460830`, `004606e0`, `004602d0`, `0045fa40`, `00461690`,
`004749e0`) and in Gold `dvge.exe` (birth `00466af0`, house routine `004669a0`, completion `00466590`, same constants,
happiness at town +0x514 and the computer flag at player +0x294 instead of +0x4B4 / +0x260).

Only buildings with resident places (odb +0xB4: small house 3, large house 9, town hall 3) give
births. Each such building counts its residents in building +0xB4 (occupancy).

**What does not matter (C, by absence).** The birth code reads only: the building's occupancy
and capacity, the town's happiness, the town's population, the owner's computer flag, and
rand(). It does **not** look at food stock, money, needs, crime, police, the number of houses,
the game speed setting or any population limit. There is no population cap other than free
resident places. Food, needs and crime act on births only through happiness.

**Birth routine** `00460830(building, unitType)`:

1. If occupancy = capacity, nothing happens.
2. Occupancy + 1.
3. Unit type: if the town population P (town +0x44, counted **before** this birth) is not 0 and
   P is divisible by D, the newborn is a **criminal** (type 12) instead of the requested type,
   where D is read from the town's **stored** happiness h (the value of the last 50-tick update,
   5.5) at this moment:
   - human town: D = 9 if h < 90, D = 18 if h >= 90;
   - computer town: D = 36 (its happiness is always 100, 5.5).
4. The unit is created at the building's entrance, belongs to the town, and its home is the
   building. Population + 1 (and the second counter +0x48 + 1), then the town's needs are
   re-evaluated (5.4).

The routine draws no random number. The criminal rule is a pure population count, so in plain
words (human town):

- the newborn that makes the town **19 strong** (P = 18) is **always** a criminal, whatever the
  happiness (18 is a multiple of both 9 and 18);
- the newborn that makes the town **10 strong** (P = 9) is a criminal only if h < 90 at that
  moment, likewise the ones that make it 28, 46, 64 ... strong (P = 27, 45, 63: odd multiples
  of 9);
- the ones that make it 37, 55, 73 ... strong (P = 36, 54, 72: multiples of 18) are always
  criminals;
- P counts everybody whose home town this is: founder, builder, porters, specialists, soldiers,
  homeless and the criminals themselves. A unit that dies or moves away lowers P, so the
  multiples can be hit again (e.g. 18 -> 17 by a death, the next birth at 17 is a porter, the one
  after it at 18 is a criminal again).

So a town of 9 that is fully content (food in stock, no open need, no criminal: h = 100) gets a
porter as its 10th resident, but its 19th resident is a criminal regardless. A town whose food ran
out (h = 66) or that has any open need (h <= 83) gets a criminal already as its 10th resident.

**Re-checked at instruction level (October 2026)**, after a report of 2 criminals among 11
residents in our build: `460856` P = town +0x44 before the birth; `46085c` P = 0 → requested type;
`460864` computer flag (player +0x260) → D = 36; `460875`..`46088a` D = 9 if the stored happiness
(+0x4B4) < 90 else 18 (`setl`/`dec`/`and 9`/`add 9`); `460893`..`460898` P mod D = 0 → type 12.
The chance roll is `4604cb`..`460505` (completion) and `4607d7`..`460811` (house job). The only
callers of the birth routine are those two and the town-hall activation (`45fc55`..`45fc67`); the
only other way to a criminal is the retype `00464840`, called by the training end and the jail
release, neither of which makes a criminal. A death lowers P (`464325`..`464332`). So there is no
delay after the start, no research or difficulty term, no cap, no random draw in the type
choice, and needs count only once open (5.4). Early-game consequences:

- at P = 9 the food term is `stock x 100 / max(1, 9 / 5)` = stock x 100: **one** unit of food
  in stock gives food% 100. Below 15 residents no need can be open (5.3). So the 10th resident is
  a criminal only when the food store is **empty** at that moment (h <= 66; with a criminal
  already in town, h <= 63);
- a second criminal before the 19th resident needs P to fall back to 9 (a death, in practice a
  porter killed by the first criminal, `combat.md` 12.7) and the food store empty again.

Measured in our build (free-play start, race 1, houses ordered two at a time, building material
kept in stock): with food kept in stock the births at P = 4..17 are porters at h = 100 (83 from
P = 15, tavern need), the 19th resident (P = 18) is the first criminal and the 28th the second;
with the food store emptied at the start the 10th resident is the criminal (h = 66) on three
seeds, the 19th the next, and the first porter death follows ≈ 7 800 ticks later (test
`test/crime.test.ts`, "sim: early criminals").

**When a birth is attempted (C):**

- **Completion of a residence** (`004602d0`, small or large house; not the town hall, whose
  completion only sets its hit points): first homeless are moved in (3.3); then, **if the house
  is not full**, the chance roll below; on success one birth (porter requested).
- **The house job** (kind 10, run `004749e0` -> `004606e0`), created when the building becomes
  active (`0045fa40`, which for a house is right after the completion step above) with a first
  run **599 ticks** later. Each run: move homeless in; if the building is now full, the job
  **ends** (returns 0); otherwise the chance roll and, on success, one birth; then it returns
  **599**, also when this birth has just filled the building (the job then ends at its next run,
  599 ticks later, unless a resident has left meanwhile).
- **A resident leaves** (`00461690`: death, resettling, demolition handling): occupancy − 1;
  if the building is still alive and has no house job, a new one is created with its first run
  599 ticks later. (If the building's current job is of kind 0x22, the operator-inside job, the
  building first sends out all its occupants and cancels that job, then creates the house job;
  I: only buildings with both resident places and that job are affected.) If a house job already exists, it simply keeps its phase.
- **Town-hall activation** (`0045fa40`, when the founder enters, or at once for computer start
  towns, 2.3): three births in a row without a chance roll: builder (11), porter (9), porter (9).
  The criminal rule applies to them too, but P is at most 3 there, so they are never criminals.
  The town hall then also gets a house job like any residence (it is full, so the job ends at its
  first run; it is re-armed when one of its residents dies).

**Chance roll** (completion and house job): with h = town happiness (stored value),

- h >= 80: the birth always happens and **no random number is drawn**;
- h < 80: one `rand()` is drawn and the birth happens when `rand() mod (10 - h/10) == 0`
  (signed remainder), i.e. with probability 1/(10 - h/10). A failed roll is simply lost: the next
  attempt of that house is 599 ticks later.

| h | 80..100 | 70..79 | 60..69 | 50..59 | 40..49 | 30..39 | 20..29 | 10..19 | 0..9 |
|---|---|---|---|---|---|---|---|---|---|
| chance per attempt | 1 | 1/3 | 1/4 | 1/5 | 1/6 | 1/7 | 1/8 | 1/9 | 1/10 |
| mean ticks between births of one non-full house | 599 | 1797 | 2396 | 2995 | 3594 | 4193 | 4792 | 5391 | 5990 |

`rand()` is the C runtime generator (`004936b9`: seed = seed x 214013 + 2531011, result =
(seed >> 16) & 0x7FFF), one global seed shared by all game code.

Births are always porters (type 9) apart from the criminal rule and the town-hall builder.
Growth is therefore limited by housing: the population of a town can only grow through free
resident places, at most **one birth per non-full residence per 599 ticks** plus one at each
residence's completion. Computer towns have happiness 100 and so always win the roll.

**Growth rate in practice.** At h >= 80 a small house gives 1 resident at completion and 1 more
599 and 1198 ticks later (full after about 2 minutes at normal speed); a large house 1 + 8 (full
after 4792 ticks, about 8 minutes). With n non-full residences the town gains about n residents
per minute. Happiness below 80 divides this by 3 to 10 (table above).

### 3.3 Homeless and rehousing (C)

- When a house is demolished or destroyed (building job kind 0x25, `0045f5a0`), each living
  resident loses its home and is appended to the town's homeless list.
- Rehousing (`004605d0` at completion, `004606e0` every 599 ticks): while the town has homeless
  and the building has a free place, the **first** homeless unit in the list is taken (dead
  entries are dropped), moves in, and occupancy + 1.
- Homeless units keep working, eat, count in the population, and pay no tax (4.2).

### 3.4 Resettling (C, `00460ed0`)

When a unit enters a building of **another town of the same race** while its current job is of
kind 7 (I: the job a direct right-click order creates), it changes its home town to that town (population moves, needs of both towns are
re-evaluated), leaves its old house (which re-arms that house's job), and is put on the new
town's homeless list. It is then rehoused by the new town's houses as above.

### 3.5 Death, starvation, emigration (C by absence)

No code was found that kills, removes or expels units because of hunger, low happiness or lack of
money. The only readers of food% (+0x4A8) and happiness (+0x4B4) are the ones listed in this
document. Hunger and unhappiness act only through happiness, births, criminal births and building
decay. "Your people are rebelling" (tdb#34) is a display label only.

### 3.6 Timeline of a town and order of events (C)

All periodic town jobs are scheduled relative to the moment they are created (1.3); there is no
global "round start". For a town whose town-hall object is created at tick T (map load, free-play
start, or the found-town command, 2.2) and whose town hall becomes active at tick A (A = T for
map and computer start towns):

| job | runs at | reads / writes |
|---|---|---|
| town status (happiness) | T+1, T+51, T+101, ... | writes happiness from population, criminals, food stock and open needs (5.5); every 12th run decay (5.8) |
| consumption | T+299, T+598, ... | eats food and luxuries (5.1, 5.2) |
| finance (per player) | 299, 598, ... after the player was set up | income, motivation money (4.1); the motivation bonus in the next happiness update uses these values |
| house job of each residence | its activation tick + 599, + 1198, ... while not full | births (3.2) |

- Happiness is a **stored** value: births and the criminal test use the value of the last
  status run, up to 49 ticks old. A birth that opens a need (5.4) therefore lowers the happiness
  that later births see only from the next status run on.
- Needs are re-evaluated **inside** each birth (3.2 step 4), so the open-needs count is always
  current when the next status run computes happiness.
- Jobs due in the same tick run in reverse order of scheduling (1.3). For births this only
  decides which of several same-tick rolls gets which random number.
- Random numbers drawn by this part of the economy: one per failed-or-successful chance roll at
  h < 80 (none at h >= 80), and one per open need in every needs re-evaluation (5.4). Criminals
  draw one per victim choice (6, `combat.md` 12.1).

---

## 4. Money

### 4.1 Round settlement (C, `0046edd0` every 299 ticks per player)

For each of the player's towns, compute the town's net (4.2 to 4.5, `0045a130`) and reset the
town's research accumulator (+0x74) to 0. Add up the nets of all towns and add the sum to the
player's money, clamping at 0 (`0045dab0`). If the money is now below 6, the human player's
advisor says mentor#18 "You are running out of money!". The line is queued with an interval of
2 D = 120 s. Every money change below 6 says it, not just the settlement (side-panel.md 1.1.3).

### 4.2 Income (tax) (C, `0045a130`)

```
taxpayers = population - homeless - criminals
income    = 7 x taxpayers
if the town has a completed (active) bank: income = trunc(income x 1.5)
```

Founder, specialists and soldiers all pay (handbook p. 27: 4 residents incl. founder -> 28).
The bank needs its operator (a scholar) to be active.

### 4.3 Motivation spending (C)

`M = motivation% x income / 100` (town +0x3C). It is paid only if the income is positive, the
town is not fully happy (happiness < 100, or the last happiness update needed the bonus,
town +0x78), and M is **less than** the money available. "Available" starts as the player's
money at the moment of the settlement (other towns settled in the same round do not reduce it,
because the money is only changed once, after all towns) and, if M is paid, is reduced by M for
the research test that follows (4.4).

### 4.4 Research spending and progress (C, `0045a650` every 30 ticks, `0045a130`)

- `R = research% x income / 100` (town +0x40, computed at the last settlement). A research
  project must be selected (town +0x58 != -1).
- Every 30 ticks, if R < player money and the town has an active laboratory: the step is
  `s = R x 0.025` (float), x 1.5 if the town also has an active library. The invention's
  progress (float) grows by s, capped at its cost; the town's research accumulator (+0x74) grows by
  the full s. The invention is finished when progress equals its cost.
- At settlement the money charged for research is `4 x accumulator` (float), then the
  accumulator is reset.
- With a 299-tick round there are about 10 research steps per round (9 or 10), so the research
  money charged per round is about R (or 1.5 R with a library), and progress per round is about
  R/4 (or 3R/8 with a library). **The library makes research 1.5x faster and also 1.5x more
  expensive per round** (C, both factors come from the same value).

#### 4.4.1 When research costs money (C, `0045a570`, `0045a730`, `0046f490`, `0045a650`, `0046edd0`)

Research is paid **per step, after the fact**: nothing is paid when a project is started, and
nothing is refunded when it is stopped. The only charge is `4 x accumulator` at the round
settlement, and the accumulator only grows in a research step that actually happened. So:

| situation | research step (every 30 ticks) | money charged at the next settlement |
|---|---|---|
| no project selected (+0x58 = -1), whatever the slider says | there is no research job | only what was accumulated earlier in the round, then 0 in every later round |
| project selected, slider 0 or income 0 (R = 0) | runs, adds 0 | 0 |
| project selected, R >= money (cannot afford) | skipped, the job keeps running every 30 ticks | nothing for skipped steps |
| project selected, no active laboratory | skipped | nothing |
| project running normally | progress and accumulator + s | 4 x (sum of s) ~ R per round (1.5 R with a library) |

- **Starting** (`0045a570`): sets +0x58, marks the invention "in progress" and creates the
  research job (first run after 30 ticks). Selecting the invention that is already running
  instead stops its job (toggle). The command handler (`00450910`) then refreshes the panel and,
  if the research slider is 0 or the stored R is below 1, tells the human player (status 0x10:
  research has no money).
- **Stopping** (`0045a730`, the stop button): clears the "in progress" mark, ends the research
  job and sets +0x58 = -1. The progress made so far stays with the invention.
- **Finishing** (`0046f490`): when a step makes progress equal the cost, a human town gets
  mentor#15, the panel is refreshed, and +0x58 becomes -1 and the job ends. Computer towns pick
  the next invention themselves.
- **After stopping or finishing**, the steps already done in the current round are still in the
  accumulator and are charged at the next settlement (the accumulator is not cleared on stop).
  From the round after that, research costs nothing until a new project starts. The stored
  research spending (+0x49C, the slider value) is **not** cleared: it is recomputed from the
  slider at every settlement whether or not anything is researched (4.6), so it is **not** a cost
  and must not be shown or subtracted as one while no project runs (see the finance page,
  `docs/ui/side-panel.md` 5.4).
- **Pause** (game paused): no ticks pass, so there are no steps and no settlements; nothing
  changes.
- The money counter (side-panel 3.6) shows the treasury only; research appears there only
  through the settlement's net.

#### 4.4.2 Inventions researched at the start (C, Gold `00413270`, `00413730`, `00463830`)

A nation starts with every invention that one of these sources marks; marked inventions get
progress = cost (finished) and are announced to the human's panel. The sources are a union, the
order does not matter.

1. **Mission research level** n (race block +0x64, [mdb.md](../formats/mdb.md)), applied when the
   race's invention table is loaded, only if n > 0: every invention whose index is <= n (the
   table in file order, stopping at the first index > n).
2. **Pre-researched flags** (race block +0x80 + 4i, i = 0..29 base, 0..32 Gold).
3. **Disabled objects** (race block +0x68 / +0x74): the invention the disabled object needs
   (odb +0xE4, if any) is marked researched, the object itself stays unavailable.
4. **Free-play development** (mode 4 = free play and multiplayer, base and add-on): when each
   player object is set up (human and computer alike, `00463830`), "Entwicklungsstufe" Mittel
   applies research level **12**, Hoch level **20**, by the same routine as source 1; Niedrig
   applies nothing.
5. **Add-on inventions (Gold only, `00413730`):** whenever the research-level routine runs (n > 0;
   sources 1 and 4) in an **add-on mission** (mission record +0xA50 > 0: every `*AO.mdb` record,
   including `InfiniteAO.mdb`), it also marks invention **30 (Werft)** always, **31 (Hafen)** if
   n > 5 and **32 (heavy warship)** if n > 15. These three sit after index 29 in `AO.idb`, so the
   "index <= n" rule alone never reaches them for the levels in use. (Instruction level:
   `cmp [record+0xA50], 0 / jle`, `cmp n, 5 / jle`, `cmp n, 15 / jle`, Gold `004137b0..00413810`.)
   A base mission (+0xA50 = 0) gets no add-on extras.

Free-play starting inventions per development setting (all players of the game):

| development | level | base free play (`Infinite.mdb`) | add-on free play (`InfiniteAO.mdb`) |
|---|---|---|---|
| Niedrig | - | none | none |
| Mittel | 12 | 0..12 | 0..12, **30 Werft, 31 Hafen** |
| Hoch | 20 | 0..20 | 0..20, **30 Werft, 31 Hafen, 32 heavy warship** |

What that makes available in add-on free play (Addon.odb +0xE4, [addon.md](addon.md) 1.4): with
Mittel and Hoch the **shipyard (63), harbour (62), fishing boat (64) and transport ship (67)**
need no research; the light warship (65) needs 15 Metallurgie, so it is free only with Hoch; the
heavy warship (66, invention 32) only with Hoch. Ships are trained in the shipyard, so a fishing
boat still needs a finished shipyard; with Niedrig, Werft and Hafen must be researched (30 needs
invention 1, except for the Sajiki).

Add-on campaigns go through the same routine: a record with research level n > 0 also gets 30,
31 (n > 5) and 32 (n > 15) in addition to its own flags (e.g. PimmonsAO 1: Pimmons L7 and Sajiki
L10 both start with Werft and Hafen; AmazonsAO 3: Sajiki L21 also gets 32). Disabled harbours or
heavy warships (X[62], X[66]) mark 31 or 32 researched by source 3.

### 4.5 Overheads (upkeep) (C)

Town +0x4A0 is the sum of odb +0xD4 of every **active** building of the town: added when a
building becomes active (`0045fa40`: completed, and for staffed buildings when the operator
enters) and removed when it stops (`0045ff30`: destroyed or deactivated). This implements the
handbook's "upkeep only while operating" (p. 32-33). Overheads are always charged; they are not
limited by the available money (money just clamps at 0).

### 4.6 Town net (C)

```
paidMotivation = M if paid else 0
net = trunc( (income - paidMotivation) - 4 x researchAccumulator - overheads )   (float)
```

After computing the net, the function overwrites the stored motivation and research spending
with the full slider values (`motivation% x income / 100`, `research% x income / 100`), whether
they were affordable or not, and **whether or not a project is selected** (only when the income
is positive; with income 0 both stay 0). These stored values are what the happiness bonus (5.6)
and the research affordability test (4.4) use. The finance panel computes the same values afresh
and then decides per row whether they are actually being spent (side-panel 5.4).

The same function (`0045a130`) also runs, without the settlement around it, whenever the
finance page of the human player's town is refreshed (every 10 ticks by the player status job,
and after research start/stop). It then only recomputes income and the two stored spendings from
the current population; the accumulator and the money are untouched. *(A side effect in the
original: while the finance page is open, the R used by the research step follows the current
population instead of the last settlement. Ours does not reproduce this UI-dependent effect; the
lockstep simulation must not depend on which page a player looks at.)*

### 4.7 Other money flows (C)

- Training a unit: its price (odb +0xD4) is subtracted when the order is placed (`00474b70` via
  `0045db60`, clamped at 0, mentor#18 below 6) and refunded on cancel (`00474fd0`). Ordering is
  refused while money < price (`0045f360`). Buildings cost no money.
- Market trade income: `0047d4d0` adds money (not analysed here).
- A typed cheat adds 5000 (`0043f610`).

### 4.8 Zero money (C)

Money never goes below 0. While it is exactly 0, buildings decay (5.8) and the advisor says
mentor#72 "Your towns can no longer be maintained because money is lacking!". It is tried every
600 ticks and is silenced for 120 s after each time it is said (side-panel.md 1.1).
Research stops (R < money fails) and motivation is not paid. Nothing else stops.

---

## 5. Needs and happiness

### 5.1 Food consumption (C, `0046f650` every 299 ticks per town)

The consumption job keeps a float accumulator A (job +0x20):

```
A = A + population x 0.2                (float32)
eaten = trunc(A)
(luxury step 5.2 uses A here, before the subtraction)
if eaten > 0: A = A - eaten; food stock = max(0, food stock - eaten)
```

So each resident eats **0.2 food per round** (1 food per 5 residents), with the fraction carried
over. Food that is not in stock is simply not eaten; there is no debt. The job also rolls the
food-production statistics (town +0x60/+0x64/+0x70). If population is 0 the job does nothing else.

### 5.2 Luxury consumption (C, same job)

For each race i = 0, 1, 2 that takes part in the game (a player object exists), with luxury good
6 + i (Schokotörtchen, Pilzschnaps, Zigarillos):

1. Threshold: the good's odb +0x128 (30 for all three). For the town's **own** race it is used as
   is. For each **foreign** race, in race order 0, 1, 2, it is `trunc(30 x f)`, where f starts at
   1.5 and grows by 1.0 after each foreign race.
2. If population >= threshold: the luxury accumulator L_i (float, job +0x24 + 4i) grows by
   `A x 0.0625` (A as in 5.1, before subtraction). If `n = trunc(L_i)` > 0: L_i = max(0, L_i - n)
   and the stock of that luxury drops by n (not below 0).

Thresholds by game composition (C):

| town race | races in game | Amazon cake | Pimmon brandy | Sajiki cigarillos |
|---|---|---|---|---|
| Pimmon | Pimmons only | - | 30 | - |
| Pimmon | all three | 45 | 30 | 75 |
| Amazon | all three | 30 | 45 | 75 |
| Sajiki | all three | 45 | 75 | 30 |
| Amazon | Amazons + Sajiki | 30 | - | 45 |

Rate: about population / 80 units of each required luxury per round (A ~ 0.2 x population).

### 5.3 Building needs (C, `00458cd0`, `0045a2c0`, `00459e80`, `00459fd0`)

As in odb.md section 6: every building type of the race with odb +0x128 > 0 is a need entry
{type, threshold, second value}, both values starting at odb +0x128 / +0x12C. Per race the types
are tavern-like 58 (15), news 51 (25), police 54 (31), temple 59 (35), culture 57 (45). All five
have an operator (innkeeper 18, news seller 20, policeman 21, priest 22, type 15) and no
production, so they are **active only while their operator is inside** (`units-and-jobs.md` 8.1).

- **Activation** (`0045fa40` -> `00459e80`, for a non-producing building with odb +0x128 > 0):
  the entry's two values are multiplied by **2.2** (double constant at `004a6940`) and
  truncated, the entry is re-sorted into the list by threshold, and the building's type is
  **removed from the open-needs set at once** (5.4). An entry whose building has the "one per
  town" flag (odb +0xB8 bit 2) is removed from the list instead (none of the five has it).
- **Deactivation** (`0045ff30` -> `00459fd0`: the operator leaves, or the building is destroyed):
  the entry is reset to the odb values and multiplied by 2.2 (count − 1) times, count = the number
  of objects of that type in the town's type list at that moment (the leaving building is still
  counted, I); then the needs are re-evaluated (5.4), which re-opens the need if the population
  is at or above the new threshold.
- Completing the building (construction finished) does nothing for the need while no operator
  is inside.
- An operator sent out on the building's own duty keeps it active (`units-and-jobs.md` 8.5), so
  the need stays closed while he is away. For the news stand this holds for the whole news round
  (`units-and-jobs.md` 8.6) and even after the seller's death on it: the round never breaks the
  link, so a stand whose seller was killed stays active and keeps the news need closed until it
  is deactivated (`DEAKTIVIEREN`) or destroyed.
- The news round itself has **no** effect on needs or happiness (no area, no duration, no
  per-house state): only the active stand counts (C, `units-and-jobs.md` 8.6 "Effect").

So the threshold is base x 2.2^N with truncation at each step, N = number of **active** (staffed)
need buildings of that type. Tavern thresholds for N = 0..4: 15, 33, 72, 158, 347.

### 5.4 The open-needs set (C, `0045a2c0`)

The town keeps a set of open needs (town +0x4C4, size +0x4D0). Re-evaluation:

- For each need entry, in list order (sorted by threshold): if population < threshold, remove its
  type from the set; otherwise add it (no change if already there) and queue its advisor line
  (odb +0x130, e.g. mentor#29 "Your people want a tavern!") with a delay of
  `rand() mod (2 x D) + 2 x D` (D = the advisor time unit `DAT_004a5d7c`). **One rand() is drawn
  for every need that is open after the test, every time the evaluation runs.**
- For each luxury (5.2 thresholds, race order 0, 1, 2, only races in play): if population <
  threshold **or** the town has any of that luxury in stock, remove it from the set; otherwise
  add it and queue mentor#39..41 the same way (one more rand()).

**When it runs (C, by its callers):**

- whenever the population changes: birth (`00460830`), death (`004641d0`), home-town change
  (`00464350`, twice: old and new town), the other add/remove paths (`00464ba0`, `00464c30`);
- on a unit type change (`00464840`: training, release from jail), twice (removal and re-add),
  although the population ends unchanged;
- at the deactivation of a need building (5.3);
- at map load / start (`00411200`, free-play start).

It does **not** run when goods arrive or run out. So a luxury need opened at an empty stock
stays open until the next population or type change even if the luxury is delivered.

**Closing a building need** does not wait for a re-evaluation: the activation of a staffed need
building removes its type from the set immediately (5.3). The happiness rises at the next 50-tick
update.

### 5.5 Happiness formula (C, `0045a7c0` every 50 ticks)

Computed only for **human** towns that have population > 0 and whose first town hall (first
entry of the town's town-hall list) is **active** (building state +0xB0 = 2). Computer towns,
and towns without population or active town hall, get crime% 0 and food%, needs% and happiness
100. The town-status job is the only writer of happiness; it runs every 50 ticks (3.6).

```
crime%  = criminals x 100 / population                         (unsigned division)
food%   = min(100, foodStock x 100 / max(1, population / 5))
needs%  = 100 / (openNeeds + 1)
h       = (needs% - crime% + 100 + food%) / 3
if h < 100 and income (town +0x494) != 0:
    bonusFlag = 1
    h = min(100, h + motivationSpending (town +0x498) x 100 / income)
happiness = h
```

- Re-checked at instruction level (October 2026): `45a825` criminals = the type-12 list count
  (+0x14C), `45a841` unsigned division by P; `45a845`..`45a874` divisor max(1, P / 5);
  `45a879`..`45a8a5` food stock = +0x98 (good 4), capped at 100; `45a8ab`..`45a8bc` needs% from
  the open-needs set size (+0x4D0, only needs that are open count); `45a8c2`..`45a8db` the signed
  division by 3; `45a8e3`..`45a912` the motivation bonus.
- food% is 100 when the stock covers one round of consumption (population/5).
- needs%: 0 open needs -> 100, 1 -> 50, 2 -> 33, 3 -> 25, 4 -> 20, 5 -> 16 ...
- The motivation bonus in points is about the motivation slider percent (it is the stored full
  slider value relative to income), and it applies even if the motivation money could not be
  paid at the last settlement (4.6).
- Without bonus, the maximum is 100 only when there is no open need, no criminal and enough food.
- Typical values without motivation bonus and with enough food: no open need and no criminal 100;
  one open need 83; two 77; three 75; four 73; five 72; each criminal costs about crime%/3
  points (1 of 19 -> 5% -> −1 or −2). Without food: no open need 66, one open need 50, two 44.
  So "h >= 90" (the gentler criminal divisor) needs **no open need at all** and food in stock;
  "h >= 80" (certain births) tolerates one open need, or two with a small motivation bonus.

### 5.6 What happiness does (C)

| effect | rule | section |
|---|---|---|
| births | always at h >= 80, else chance 1/(10 - h/10) per attempt (one attempt per non-full residence per 599 ticks) | 3.2 |
| criminal births | the newborn is a criminal when the population before the birth is a multiple of 9 (h < 90) or of 18 (h >= 90) | 3.2 |
| building decay | at h < 50 buildings lose 2 HP every 600 ticks, 4 HP at h < 30 | 5.8 |
| tax | none directly (criminals and homeless do not pay) | 4.2 |
| work speed | none found (no other reader of +0x4B4) | |
| emigration / revolt | none found | 3.5 |

### 5.7 Panel labels and advisor lines (C, `0041ae60`, message built at `00456c5f`)

The needs panel receives a copy of town +0x4A4..+0x4B4 (crime%, food%, needs%, condition%,
happiness) and picks its labels like this:

- Motivation: tdb#(34 - h/20): h = 100 -> #29 "Deinem Volk geht es gut", 80..99 -> #30,
  60..79 -> #31, 40..59 -> #32, 20..39 -> #33, 0..19 -> #34 "Dein Volk rebelliert". Drawn in a
  different colour when h != 100.
- Growth label from h: h >= 80 -> #209 "wächst und gedeiht"; h < 50 -> #210 "wächst langsamer";
  50..79 -> #211 "wächst sehr langsam". (The two lower labels are swapped relative to their
  meaning: an original bug. Reproduce or fix as desired; it is display only.)
- House condition label from **h** (not from condition%): h >= 50 -> #212 "well kept"; h < 30
  -> #213 "beginning to decay"; 30..49 -> #214 "decaying" (same swap).
- Food label: food% >= 100 -> #215 "well supplied", below 100 -> #216 "too little food". #217
  "starving" is unreachable because of the same threshold-order bug.
- Then the open needs are listed.

Advisor lines from the 50-tick update (human towns). All of them are queued with an interval of
2 D = 120 s (`docs/ui/side-panel.md` 1.1):

- food% < 100: mentor#26 "food is getting scarce", or mentor#27 "famine" when food% < 50. It
  also arms #42, #43 and #28;
- happiness rose with full food: mentor#42. It arms #43 and #28;
- happiness fell with full food: mentor#43. It arms #42 and #28.

mentor#28 "your population is dissatisfied" is **never said**. Its branch tests "unchanged and
below 100" inside the "changed" branch, so it cannot be reached (C, machine code 0x45A9E2).

### 5.8 Building condition and decay (C, `0045ab60` every 600 ticks)

First the advisor: money = 0 -> mentor#72; otherwise happiness <= 49 -> mentor#71 "Your towns
are decaying because of low motivation!". Both are queued with an interval of 2 D = 120 s
(side-panel.md 1.1).

Then for every building of the town (all types of the race): if (happiness < 50 or the player's
money = 0) and the building's HP > max HP / 10, it loses 4 HP if happiness < 30, otherwise 2 HP.
HP is clamped to max; if it falls below 1 the building is destroyed (only possible for tiny max
HP). Decay never takes a building below about 10% of its max HP.

Condition% (town +0x4B0) = average over all the town's buildings of `HP x 100 / maxHP`, where a
building site counts as 100. No buildings -> 100.

Repairs (builders, money) are outside this document.

---

## 6. Crime and police (high level)

- **Where criminals come from (C):** only the birth rule (3.2). A newborn is a criminal when the
  population before the birth is a multiple of 9 (human, h < 90), 18 (human, h >= 90) or 36 (AI).
  Criminals are never trained (odb +0xE8 = 36). There is no probability, no timer and no other
  threshold: police, crime%, money and the number of existing criminals do not influence whether
  the next newborn is a criminal (only through happiness, which picks 9 or 18). Consequences for
  a human town that grows only by births: the 19th resident is always a criminal; the 10th, 28th,
  46th, 64th ... are criminals when the town's happiness is below 90 at that birth; the 37th,
  55th, 73rd ... always. A town of 9 to 18 residents that keeps food in stock and has no open need (the
  tavern need opens at 15) therefore stays free of criminals until it reaches 19.
- **Map criminals:** missions can also place criminals on the map (created by the loader with
  their criminal job, `00411200`).
- **What they cost (C):** they count in the population (eat 0.2 food per round, take a resident
  place, raise needs), pay no tax, and lower happiness through crime% (5.5).
- **What they do (C, `004784d0` every 50 ticks):** a criminal picks a random porter of its own
  town and starts an attack action on it. The action ends when it finishes or when the victim has
  lost at least 10 HP since the attack began; 50 ticks later he picks a new victim.
- **Police (C, `00478cb0`, operator job every 50 ticks):** a police station with its officer
  checks the town's criminals; for a living criminal who is not inside a building it sends the
  officer out on an arrest job (`0047b770`): he beats the first free criminal of the town's list
  down to 80% HP and it walks into the jail by itself (`combat.md` 12.2 to 12.4).
- **Jail (C, `0047cca0`):** an arrested criminal is walked into the station and held for
  **599 ticks**, then turned into a porter (type 9) and sent out. As a type change this
  re-evaluates the town's needs.
- **Need:** police stations are a building need from population 31 (5.3).

---

## 7. Storage

- **Capacity (C):** one number per town, the same for every good: town +0x54 = sum of odb +0x120
  of the town's active buildings with the "store" flag. Town hall 25, warehouse 25 (market has the
  flag but 0). So capacity = 25 x (1 + warehouses) (handbook p. 29), **per good**: a town with a
  hall and five warehouses holds 150 of each of the nine goods. Added in `0045fa40` (flag 0x1 and
  +0x120 not 0; Gold `00465d00`: flag 0x10), removed in `0045ff30` (same test; Gold `004661f0`:
  flag 0x10). Warehouse construction sites add nothing. The raw-material page shows this number
  (T130 "Lagerkapazität: %d / Typ"). Every room test uses it per good: room(g) =
  max(0, capacity − stock[g]) (`00460ba0`), "full" = room(g) < 1.
- **What counts as town stock (C):** the nine counters at town +0x88..+0xA8. Goods inside
  producers (mine, armoury, luxury works: own capacity 10 per good, odb.md) are not town stock
  until a porter delivers them. All store buildings of a town share the one stock (handbook p. 41).
- **Adding goods (C, `0046e820`):** the stock becomes `min(stock + amount, capacity)`; any excess
  is lost. Food additions are also counted as "food produced this round" (+0x60). The space left
  is `max(0, capacity - stock)` (`0046e940`, `00460ba0`).
- **Crop conversion (C, `0046e820`, good 0 = race crop):** if the conversion divisor d (+0x6C)
  is not 0, each delivery of k crop units adds k to an accumulator; when the accumulator reaches
  d, `n = trunc(min(accumulator / d, food space))` units are converted: food grows by
  `min(2n, food space)` (1 crop -> 2 food, handbook p. 29), also counted as food produced this
  round (+0x60), n is removed from the delivery, the rest of the delivery goes to the crop stock,
  and the accumulator drops by n x d. So 1/d of all delivered crops is converted. n is **not**
  limited by the delivery (`46e86e`..`46e8d7`): an accumulator that grew while the food store was
  full converts its backlog as soon as there is room, and the excess comes out of the crop stock
  (the stock could even go below 0 in the original; ours stops at 0).
- **The conversion ring (C, command 0x57, client `0041b7a0`, simulation `00452b40`).** The
  raw-material page's slider is a **standing setting of the town**, not a parameter of the
  button: every move of the slider sends command 0x57 with the percentage p (0..100). The
  simulation stores p at town +0x5C (0 in a new town, `00458cd0`) and sets the divisor
  d = 100 / p (float32) and the accumulator to d x 0.5 (`452b6d`..`452b89`); p = 0 sets both to
  0 (no conversion). From then on every crop delivery is converted as above. The `UMWANDELN`
  button sends the same command with the value 0xFF (`41b7bf`): "convert now" (`452b9e`..`452c05`)
  takes the **stored** p: n = min(trunc(crop x p / 100), trunc((capacity − food) / 2)); crop −= n
  (not below 0), food produced this round += 2n, food = min(food + 2n, capacity). The ring keeps
  its value. With the ring at 0 the button converts nothing. *Our build (fixed October 2026):
  the slider was only local to the page and the button converted with its value, so deliveries
  were never converted and a town living on its farm starved unless the player pressed the button
  again and again (food% 0, h <= 66: births slowed to 1/4 and every 9th resident a criminal).
  Now `Town.cropPct` holds the ring (saved and hashed, snapshot version 12; older saves start
  with the ring off); `Economy.setCropRing`, `convertNow`; command `convert` with 0..100 or
  `CONVERT_NOW` (255); test `test/economy.test.ts`.*
- **Removing goods (C, `0046e910`):** stock = max(0, stock - amount).
- **Losing a store (C, `0045ff30`, 0x45FFC9..0x46001A):** only for a building whose capacity
  test above holds (so **not** for a market: +0x120 = 0 skips the whole block): capacity drops by
  its +0x120 and every stock is scaled by W / (W + 1), truncated, W = the count of the town's
  warehouse type list (town +0x2A8) at that moment. That list holds every warehouse of the town
  from placement (construction sites too) until phase 2 of its death (`combat.md` 10.3 step 3),
  and deactivation is phase 1, so the dying warehouse is **still counted**: losing one of two
  warehouses keeps 2/3 of everything, losing the only warehouse keeps 1/2. Unfinished warehouse
  sites raise W (they keep more). The town hall uses the same formula, but its loss destroys the
  town.
- **Full stores (C):** mentor#17 "Your stores are full!" is said when a unit carrying goods on a
  transport job first asks to enter a building that has no room for **that good** (a store: town
  stock[g] ≥ capacity; another building: local stock[g] ≥ its +0x120; entry is still allowed,
  `00460a10`), and when a porter puts a leftover load down at its source with no room (that unit
  is lost, `0047c400`). It is tested **before** goods are added and never after a delivery, so a
  clamped or crop-converted delivery says nothing. Queued, interval 2 D = 120 s. Exact rule:
  side-panel.md 1.1.6.
- **Goods refused when full:** nothing refuses a delivery; the stock is clamped and the excess is
  lost (`0046e820`). The places that look at the room first: the dispatcher skips a harvest
  request while room(g) < 1 (`units-and-jobs.md` 5.3), and the porter at a source puts down only
  with room (5.5). Production output stays in the producer until a porter takes it.

---

## 8. Worked examples

### 8.1 Handbook town (Pimmons, p. 27)

Town hall + school, population 4 (founder, builder, 2 porters), no criminals or homeless, sliders
at 0. Income 4 x 7 = 28. Overheads 7 + 5 = 12. Net +16 per round, i.e. +16 money every 299 ticks
(about every 30 s at normal speed).

### 8.2 Food for population 7 (float32 matters)

0.2 is not exact in float32. Accumulating 7 x 0.2 per round gives eaten = 1, 1, 2, 1, 1, 2, ...
whereas exact arithmetic would give 1, 1, 2, 1, 2. A rebuild that must match the original
replay exactly has to use float32 (`Math.fround`) for the consumption, luxury, research and crop
accumulators. A rebuild that only needs the same behaviour can use an integer accumulator in
fifths (A5 += population; eaten = A5 / 5; A5 -= 5 x eaten) and sixteenths for luxuries.

### 8.3 Luxury at population 40 (Pimmon town, Pimmons only)

A = 8.0 each round; brandy accumulator +0.5 per round -> 1 brandy every 2 rounds; food 8 per
round. At population 30: A = 6.0, +0.375 per round -> brandy at rounds 3, 6, 8, 11 ...

### 8.4 Happiness

Human town, population 30, 2 criminals, food stock 3, no tavern and no news stand built
(both open), motivation slider 20%.

- crime% = 200 / 30 = 6; food% = 3 x 100 / (30/5 = 6) = 50; needs% = 100 / 3 = 33.
- h = (33 - 6 + 100 + 50) / 3 = 59.
- Income = (30 - 2) x 7 = 196; stored motivation = 20 x 196 / 100 = 39; bonus = 39 x 100 / 196
  = 19 -> h = 78.
- Panel: tdb#(34 - 78/20 = 31) "Dein Volk fühlt sich nicht wohl".
- Births: chance 1/(10 - 7) = 1/3 per house attempt. Criminal births at population 36, 45 ...
  (h < 90). Decay: none (h >= 50, money > 0).
- Settlement: net = 196 - 39 (if money > 39) - overheads.

### 8.5 House filling

Small house (3 places) at h >= 80: one porter at completion, then one every 599 ticks: full after
1198 ticks (about 2 minutes). Large house (9): 1 + 8 x 599 = 4792 ticks after completion (about
8 minutes). At h = 55 each attempt succeeds with 1/5, so a large house takes about 8 x 5 x 599
ticks (about 40 minutes) on average.

### 8.6 Decay at zero money

A house (350 HP) at money 0 and h >= 50 loses 2 HP per 600 ticks and stops at 35 HP: 158 steps,
about 95,000 ticks (2.6 hours at normal speed). At h < 30 it is twice as fast.

### 8.7 Research

Income 200, research slider 25%: R = 50. Each 30-tick step adds 1.25 progress; about 12.5 per
round; charged about 50 per round. Ackerbau (cost 20 in DV.idb, if that value is the cost) takes
16 steps = 480 ticks. With a library: 1.875 per step (11 steps) and about 75 money per round.

### 8.8 Growth of a new town with houses built one after the other

Start: Pimmons mission 0 (town hall, population 4: founder, builder, 2 porters; 12 food), small
houses completed at ticks 561, 1081, 1634, 2136, 2813, 3458, 4094, 4700, 5272, 6068, 6734, 7432
(one at a time, as fast as one builder manages with materials at hand), no motivation money, no
need building. Rules of 3.2 and 5.5 applied by hand / by a small model (400 random seeds):

| | fed (food never below the round's consumption) | not fed (the 12 start food only) |
|---|---|---|
| happiness | 100 up to population 15; 83 when the tavern need opens (15); 76..82 with the first criminal and the news need (25); about 70 from 30 (luxury, police, temple needs) | 100 until the food is gone (about tick 2500..3000), then 66; 50 from population 15; 37..45 later |
| births | certain while h >= 80, i.e. up to population ~25; then 1/3 (h 70..79), from about 37 residents 1/4 (h 69) | certain until the food is gone, then 1/4, from 15 on 1/5..1/7 |
| population at 5 / 10 / 15 / 20 / 30 min | 16 / 27 / 34 / 38 / 40 | 14 / 19 / 25 / 30 / 36 |
| births in 30 minutes | about 36 (1.2 per minute) | about 32 (1.1 per minute) |
| first criminal | tick 3458, the 19th resident (population 18), deterministic | the 10th resident if the food is gone before the 10th birth, else the 19th; with these completion times median tick ~6000 (range 4100..9800) |
| next criminals | the 28th (h < 90) and the 37th | the 28th, 37th, 46th ... |

Births per minute are set by the house building rate while h >= 80; unhappiness only matters
once the houses wait for births.

---

## 9. Remaining unknowns

1. Exact real-time tick length on the original target OS (GetTickCount granularity, frame time
   added by rendering). Measuring a running copy would settle it.
2. Network play: whether clients run their own scheduler or are paced by the host; the speed
   message only updates the animation copy on clients (`00458a30`).
3. *(Resolved, 7 "The conversion ring".)* The raw-material page's slider sets it (d = 100 / p);
   the button converts p % of the stock now.
4. How motivation% and research% sliders are limited (handbook: their sum may not exceed income).
5. *(Resolved, `combat.md` 12.2 to 12.4.)* Police catching: the arrest job, the 80% rule, the escort
   job and the release as a porter.
6. *(Resolved, `units-and-jobs.md` 8.6.)* The news round (job 0x1A) visits every house of the
   seller's town and plays his work animation there; it has no economic effect. The news stand
   only matters as a need entry, closed while the stand is active.
7. Porter visits to houses, taverns, circus and temple (visit job, flag 0x8): no economic effect
   found; possibly animation only. A visit does not satisfy or close a need (a need building closes
   its need when it becomes active, 5.3) and no need code releases a visitor; the release paths and
   timings are in `units-and-jobs.md` 5.7.
8. *(Resolved: mentor#17 is the only storage message, side-panel.md 1.1.6.)*
9. Town +0x48 (second counter), +0xAC/+0xB0, the market table at +0x4EC, and town +0x5C.
10. The trade and diplomacy money flows (`0047d4d0`) and the market price model.
11. What the AI planning jobs (+0x18/+0x1C/+0x20) do; AI towns skip happiness entirely.
12. Unit death and its effect on house occupancy outside the paths named here (combat deaths are
    expected to go through `00461690`, I).

## 10. Notes for other documents

- `docs/formats/mdb.md`, "How the start goods are applied": a town hall completed when the race
  already has two or more towns gets 10 food, 10 wood **and 10 stone**, not only 10 food
  (assembly `0045fc78..0045fc93`).
- `docs/formats/odb.md` section 5 ("Residents") is consistent with 3.2; town +0x4B4 is confirmed
  as happiness.
- `docs/architecture/simulation.md`: the original runs at about 10 ticks per second (1.2), not 20.
- `docs/game/rules-from-manual.md` open question 28 (outpost territory radius, town area size)
  is answered by section 11; `units-and-jobs.md` 12 item 3 (placement flags 0x800/0x1000) by
  11.7.
- `docs/game/rules-from-manual.md` open questions answered here: 1 (round = 299 ticks), 3 (tax),
  4 (capacity), 5 (overflow lost), 11 (decay), 12 (growth), 13 (food 0.2 per resident per round;
  no starvation deaths), 14 (happiness formula), 15 (need thresholds and luxury rate), 16 (crime),
  17 (homeless).

---

## 11. Town territory ("town area") and border stones

Sources: `0044e280` (territory record), `0044e920` (add a circle), `0044e830` (remove a
circle), `0044e9a0` (recompute), `0044e7c0` / `0044f0b0` / `0044f0f0` (border marks in the map
cells), `0044e3b0` (lookup), `0044e610` / `0044e3e0` (rectangle tests), `004572c0` (handler of
message (0x55,24)), senders `0045f0d0`, `004602d0`, `0045f5a0`; save/load `0044f120` /
`0044f2b0`; map reset `0040e970`, allocation `00449dc0`. The Gold edition (`dvge.exe`
`00453ba0`, `00454240`, `00454150`, `004542c0`, `004540e0`, `0045cfc0`) is identical apart from
the map object's field offsets. How the stones are drawn is in
[../rendering/territory.md](../rendering/territory.md).

Summary: the territory is **per town**, not per player. It is the union of discs around the town
hall and the town's outposts, stored at **half resolution** (one owner per 2 × 2 block of cells),
and a block belongs to the **first** territory that claimed it. Every block of a territory that
touches a block not owned by the same town carries one **border stone**. A small outpost adds a
disc of radius 6 blocks (reaching 10..11 cells from the building), a large outpost or the town
hall a disc of radius 11 blocks (20..21 cells).

### 11.1 Data (C)

- **Block grid.** The map of N × N cells is divided into (N/2) × (N/2) blocks. Block (bx, by)
  covers the cells 2bx..2bx+1 by 2by..2by+1. Block coordinates wrap like cell coordinates. A
  cell (x, y) lies in block (x div 2, y div 2).
- **Ownership map.** One byte per block: the **town id** of the owning town, or "none" (0xFF).
  Filled with "none" when a map is set up. The allocation is N × N bytes although only
  (N/2)² are used (harmless).
- **Territory record**, one per town that has ever sent a territory message, kept in a global
  list in **creation order** and in a table indexed by town id:

  | field | meaning |
  |---|---|
  | id | the town id (town +0x24); the value written into the ownership map |
  | race | the town's race (record +0xA0 of the building that sent the message); selects the stone sprite and the minimap tint colour |
  | circles | list of (block x, block y, block radius), one per contributing building, in the order added |
  | border | list of the record's border blocks (11.4) |
  | count | number of blocks owned (only the AI reads it, 11.7; see the quirk in 11.5) |
  | marks shown | a flag; always set after the first add (11.4) |

- Town ids are stored in one byte, with 0xFF meaning "none". A game that creates more than 255
  towns in total would alias ids (C, not guarded). A rebuild should use a wider owner type.
- The territory records and the ownership map are **saved** and **loaded** with the game
  (`0044f120`, `0044f2b0`). They are not recomputed from the buildings on load.

### 11.2 Which buildings contribute (C)

Only two kinds of building send the territory message (0x55,24) "add a circle":

| building | test in the code | sent when | radius R (odb +0xB0) | block radius r = (R − 2) div 2 | blocks in one disc | reach in cells |
|---|---|---|---|---|---|---|
| town hall (type 40, every race) | type = 40 | the building object is **created**, i.e. already as a **construction site** (founding command, map load, free-play start) (`0045f0d0`) | 25 | 11 | 373 | 20..21 |
| small outpost (type 52) | class +0xC0 = 6 | the building is **completed** (`004602d0`; also for outposts placed complete by the map loader `00411200`) | 15 | 6 | 109 | 10..11 |
| large outpost (type 53) | class +0xC0 = 6 | completed, as above | 25 | 11 | 373 | 20..21 |

- The radii are the same for all three races and identical in GOG and Gold `dv.odb`.
- No other building contributes. The watchtower (radius 30, class −1), the mine (8), the market
  and embassy (6) and the add-on harbour (6, class 4) have radii, but they do not send the
  message. An outpost **construction site** does not count; a town-hall site does.
- The message carries: town id, race, the building's position (its anchor cell = maximum
  corner of the footprint), the radius R, and an add/remove flag.
- **Removal** (C, `0045f5a0`): in phase 2 of the destruction of **any** building
  (`combat.md` 10.3, after the collapse animation), the message is sent with the remove flag and
  that building's position. Only a circle whose block centre equals the building's block
  (x div 2, y div 2) is removed (the first match). For buildings without a circle nothing is
  removed, but the full recompute of 11.5 still runs.
- The message is executed at once on the machine that runs the simulation (`004551c0` calls
  the handler directly for the local connection) and is queued for the other connections. So
  the territory changes in the same tick as the event. The simulation itself reads the map
  (placement, AI), so for a rebuild it is **simulation state**, not display state.

### 11.3 The disc (C, `0044e920`, `0044e9a0`)

A building at anchor cell (x, y) with radius R adds the circle with block centre
(cx, cy) = (x div 2, y div 2) and block radius r = (R − 2) div 2.

Its blocks are all (cx + dx, cy + dy), wrapped, with **dx² + dy² < r²** (strictly less; dx and
dy run from −r to r − 1, which loses nothing because dx = −r only meets the test with dy = 0,
and then r² < r² is false). It is a true round disc, not a diamond or square. For r = 6 the rows
have 7, 9, 11, 11, 11, 11, 11, 11, 11, 9, 7 blocks (109 in all); the disc reaches 5 blocks from
the centre block along each axis.

Because the centre is rounded down to a block and the radius is rounded down, the territory is
about 2 cells smaller than R in every direction and is offset by up to one cell from the
building. A rebuild must use these exact block rules, not a cell-resolution circle of radius R.

### 11.4 Adding a circle and the border (C, `004572c0`, `0044e9a0`)

When an "add" message arrives:

1. The town's record is looked up by town id, or created (empty, appended at the end of the
   global list). Its race is set from the message.
2. The circle is appended to the record's circle list.
3. **Recompute this record** (without clearing it first):
   1. The old border stones of this record are removed from the map cells (the marks are
      cleared and the cells marked for redraw).
   2. **Claim**: for every circle of the record, in list order, every disc block whose owner
      is "none" becomes this town's (count + 1). Blocks owned by any other town, including a
      town of the same player, are **not** taken. First come, first served.
   3. The bounding box of all disc blocks of all circles of the record is computed (in wrapped
      block coordinates, including blocks that belong to others).
   4. **Thinning and border scan**: the box grown by one block on each side is scanned row by
      row (y from top to bottom, x from left to right, wrapping). For each block owned by this
      town:
      - if neither its left nor its right neighbour is owned by this town, **or** neither its
        upper nor its lower neighbour is, the block is released (owner "none", count − 1).
        This removes one-block-wide spurs and strips, for example where two territories leave
        a thin gap. The test runs in place, so a release changes the tests of the blocks
        scanned after it;
      - otherwise, if at least one of its four neighbours (left, right, up, down; wrapped) is
        not owned by this town, the block is appended to the record's **border** list.
   5. The border stones are written again for the new border list (11.6).
4. The stones are shown (flag "marks shown" set). From then on every recompute removes and
   re-writes them, so all territories always show their stones. There is no option to hide them.

(C, `004572c0`, Gold `0045cfc0`: the handler runs step 3 a second time before step 4. The second
run ends in the same state, because its claim gives back exactly the blocks the first run's
thinning released and the thinning then repeats; the count also nets out. Running it once is
equivalent.)

Quirk (C): a block scanned before a later neighbour is thinned away is not added to the border,
so a stone can be missing next to a thinned block. A block visited twice (a box that wraps
around the whole map) can be listed twice (two stones on one cell, invisible).

Adding never recomputes the other territories: they keep their blocks and their borders.

### 11.5 Removing a circle (C, `0044e830`)

When a "remove" message arrives for town T:

1. The circle with T's block centre is removed from T's list, if one matches.
2. **T is recomputed with clearing**: every block owned by T is set to "none" first, then T
   claims, thins and scans as in 11.4 step 3.
3. **Every territory record**, in creation order (T included again), is recomputed without
   clearing. So blocks freed by T can now be claimed by any other town whose discs cover them,
   the earliest-created town first.
4. If T has no circle left, its record is deleted: its stones are cleared, its table entry is
   removed. (Its blocks were already released in step 2.)

Consequences:

- The territory of a town hall or outpost lasts until the end of the destroyed building's
  collapse (phase 2), not until the moment it is destroyed.
- When an outpost of town A is destroyed, a neighbouring town B whose discs overlap A's freed
  blocks takes them over immediately, and keeps them even if A rebuilds the outpost later.
- When the town is destroyed (`combat.md` 10.4) all its buildings die; the last one removes the
  record.
- **Quirk (C): the block count is not reset when T is cleared.** Step 2 releases T's blocks
  without decreasing the count, then re-claims them and increases it again. Every destruction
  of any building of T therefore adds T's current block total to the count (a town with only a
  town hall goes from 373 to 746 when its first house is demolished). Only the AI reads this
  value (11.7). A faithful rebuild reproduces it; a corrected one recounts. Offer both behind a
  fidelity switch.

### 11.6 Border stones in the map cells (C, `0044e7c0`, `0044f0b0`, `0044f0f0`)

- For each border block (bx, by) the **cell (2bx, 2by)** (the even/even cell of the block, which
  is the top corner of the block on screen) gets a 2-bit race field in its flags byte (cell
  flag bits 0x0C, `fog-of-war.md` 1.1): 1 = Amazons, 2 = Pimmons, 3 = Sajiki (race + 1), and
  the redraw bit. Removing writes 0.
- So there is **at most one stone per 2 × 2 block, on every border block**, i.e. every second
  cell along a straight edge. Nothing else is tested: stones are placed on water, on mountains,
  under buildings, on roads, everywhere the border runs.
- **Water, both editions (C, re-checked at instruction level):** neither the claim and border
  scan (11.3, 11.4) nor the mark writers read any map cell field. The claim tests only "owner =
  none" in the block map; the writers clear and set bits 0x0C of the flags byte without a
  condition. So territory covers lakes and, in add-on (Gold) island games, the open sea and the
  coastal water, and border blocks there carry stones. Gold (`004542c0`, `004540e0`,
  `004549d0`, `00454a10`) is the same code with the map object's offsets moved by 5 bytes; it
  does not test the island-id grid, the land/water cell flags (`docs/game/addon.md` 2.2) or the
  height, and does not clip discs to the island. Evidence table and the drawing side:
  [../rendering/territory.md](../rendering/territory.md) 2.1.
- Stones are not simulation objects: they have no object id, take no cell, do not block
  walking or building and cannot be clicked. They are a display mark only.
- **Where two territories meet** each keeps its own border: there are two rows of stones, one in
  each colour (or both in the same colour for two towns of one player), on adjacent blocks,
  that is 2 cells apart. Towns of the same player are **not** merged; their common edge shows
  two rows of stones of the player's colour.
- How the marks are drawn (sprite, layer, fog): [../rendering/territory.md](../rendering/territory.md).

Counts for a lone disc: town hall or large outpost 60 stones (373 blocks); small outpost 32
stones (109 blocks).

### 11.7 Who reads the territory (C)

| reader | rule | evidence |
|---|---|---|
| building placement, UI click test and preview (flag 0x800) | for every building whose mask contains 0x800 (the default mask 0x87E and the farm 0x97E, `units-and-jobs.md` 6.1; **not** the mine 0x67E, the town hall 0x107E, nor the add-on harbour and shipyard 0x405E), four corner points must **all** lie in blocks owned by the **current town** (the town selected in the side panel). The points, in blocks, are (X', Y'), (X' − b', Y'), (X', Y' − a'), (X' − b', Y' − a') with X' = (X + 1) div 2, Y' = (Y + 1) div 2, a' = (size_y + 2) div 2, b' = (size_x + 2) div 2, wrapped, where (X, Y) is the cursor cell (maximum corner of the footprint). The town's other territories, even of the same player, do not count | `00447cd0`, `0044e610` |
| town-hall placement (flag 0x1000) | none of the four points (X + 1, Y + 1), (X + 1 − a, Y + 1), (X + 1, Y + 1 − b), (X + 1 − a, Y + 1 − b), with a = size_y + 2, b = size_x + 2 (cells; note x is offset by the y extent), may lie in **any** territory. The lookup does not wrap: near the map edge it reads a wrong block (C, quirk; a rebuild should wrap) | `00447cd0`, `0044e3b0`, `units-and-jobs.md` 11.1 |
| simulation re-check of a placement command | **none**: the simulation does not test territory (`00451780`, `004509d0`). Only the UI and the AI enforce it | |
| current-town switch in placement mode | while a building (or a town hall) is being placed, if the cursor cell lies in a territory of the **local player's race** that is not the current town, the UI sends "set current town" (command (0x0D,5)) for that town and selects it in the town list. So placing a building inside another own town's area switches the build target to that town | `00441e80` |
| minimap "town areas" layer | each minimap pixel in sight is tinted with the race colour of the territory its cell lies in (`ui/side-panel.md` 6.2) | `0044d230` |
| AI | site and building searches use the 0x800/0x1000 tests with the AI town as current town; outposts are wanted while 4 × count < (buildings + sites) × 20 + 40; founding sites must stay clear of all territories; a unit that steps into, or is created in, a computer town's territory of another race is recorded as an intruder; army tactics test target positions against a town's territory *(I: details in the AI spec)* | `0046b490`, `00467e10`, `004621c0`, `00463d00`, `00466020`, `00466e20`; `ai-diplomacy-trade.md` |

Nothing else reads it: territory does not affect movement, combat (apart from the AI alert),
tax, happiness or storage.

The mine, town hall, harbour and shipyard exemption above is from the **territory** test only.
The UI's visibility test (mask bit 0x80: the grown footprint must be in sight) applies to them
like to every other building (`units-and-jobs.md` 6.1.1, `fog-of-war.md` 6).

### 11.8 Rebuild notes

- Keep the ownership map (block grid of town ids), the records with their ordered circle lists
  and border lists, and the per-record count in the **engine state**, include them in snapshots,
  saves and the sync digest. A recomputation from the building list on load is not enough,
  because first-come ownership depends on the order of past adds and removals.
- Apply adds and removals in the same tick as the events of 11.2, in the same order.
- The town's area for placement is "all four corner blocks owned by this town", not a distance
  from the town hall.

### 11.9 Differences to our current implementation (for the implementer)

Implemented in `src/engine/territory.ts` (state, add, remove, lookups; part of `World`, its
snapshot from version 5 and its hash), `src/engine/logistics.ts` (`canPlace` = the UI/AI test
with the 0x800 corner rule, `canPlaceSite` = the simulation's test without territory, `canFound`
with the 0x1000 rule), the AI (`ai.ts`, `ai-town.ts`), `src/client/border-stones.ts` and
`src/client/minimap.ts`. What still differs from the original:

- **Owner type:** 16-bit town ids (0xFFFF = none) instead of a byte (11.1 recommends it).
- **Town-hall test near the map edge:** the lookup wraps (the original reads a wrong block).
- **Saves before version 5** have no territory. It is rebuilt on load from the buildings in
  creation (id) order: every town hall (sites too) and every completed outpost. The original's
  first-come shapes depend on the order of past adds and removals, which such a save cannot
  give back, so overlapping territories (and the block count of 11.5) may differ from the game
  that was saved; a collapsing outpost (phase 1) is not counted.
- **Remove message for a town without a record** (all its circles already gone): nothing
  happens *(I: the original's behaviour for a missing record is not documented)*.
- **Count quirk** (11.5): reproduced by default; `WorldSetup.fidelity.territoryCountQuirk =
  false` recounts on the clearing recompute.
- **Current-town switch** (11.7): the client sets its current town directly; there is no
  "set current town" network command, because our current town is client state.
- **Stones and territory on water** (11.6): no difference. Our territory and stones cover lakes
  and the add-on sea like the original (re-checked for Gold island games; the reported "red cubes
  in lines across the water" are the original's Amazon stones on a disc edge over the sea).
  Vanilla must stay as it is: no water test in the claim, the border scan or the stone list. An
  optional enhanced display filter is described in `rendering/territory.md` 4.1 item 3.

The list below is the state before the territory was implemented, kept for reference:

1. **No territory map exists.** `logistics.ts` (`canPlace`, `canPlaceShore`, `canFound`),
   `ai-town.ts` (`townArea`, `snap`) and `ai.ts` (`radius`, `siteValid`) use a distance
   max(dx, dy) + min(dx, dy) div 2 ≤ 25 from the town position. The original uses the block
   discs of 11.3 (true circles, radius 11 or 6 blocks around the building's block), owned
   first come first served.
2. **Outposts do not extend the area.** In the original a completed small outpost adds a disc of
   radius 6 blocks and a large outpost one of radius 11 blocks; both are withdrawn after the
   outpost collapses (`integration-ai.md` item 4 already notes the gap).
3. **No border stones** are written or drawn (11.6, `rendering/territory.md`).
4. **Placement:** our simulation check applies the area test to every building including the
   mine (and harbour/shipyard), using only the anchor cell. The original tests four corner
   blocks in the current town's own territory, exempts the mine, the town hall, the harbour and
   the shipyard, and performs the test only in the UI and the AI.
5. **Founding:** `canFound(…, true)` compares the four points with distances to town centres.
   The original looks the four points up in the ownership map, so outpost areas and the
   first-come shapes count too.
6. **Minimap:** `minimap.ts` tints a disc of radius 25 around each town centre (at minimap
   scale). The original tints by the ownership map (outposts included, exclusive ownership);
   race-marker pixels are not tinted, and nature-blended pixels are tinted on top of their
   blend (our marker colour replaces the tint instead).
7. **Current-town switch** while hovering another own town's area in placement mode is missing.
8. **AI area count:** ours counts cells of the distance disc (about 1,900); the original uses
   4 × the block count (1,492 for a lone town hall), with the count inflation quirk of 11.5.

---

## 12. Births, criminals and happiness: differences to our implementation

Checked against `src/engine/economy.ts` (`birth`, `birthRoll`, `completed`, `activate`,
`runHouse`, `leaveHome`, `evaluateNeeds`, `updateHappiness`, `runConsumption`), its callers in
`src/engine/world.ts` (map load, `spawnInside`, scheduler dispatch, `TICK_MS = 100`) and
`src/engine/logistics.ts` (completion, activation, training). The core rules are implemented as
specified: the criminal divisor 9 / 18 / 36 on the population before the birth, the chance roll
at h < 80 with `rand() mod (10 − h/10)` and no draw at h >= 80, one attempt per non-full
residence every 599 ticks plus one at completion, three unrolled births at town-hall activation,
the happiness formula and its 50-tick period, the 299-tick consumption and settlement, and the
MS C runtime generator.

**Status: items 1 to 7 below are fixed** (`economy.ts` `activate` / `needActivated`, `deactivate` /
`needDeactivated`, `changeType`, `evaluateNeeds` / `announceNeed`, `completed`, `runHouse`,
`leaveHome`, `updateHappiness`; `logistics.ts` training and `combat.ts` jail release call
`changeType`; `world.ts` `notify` with the minimum interval, a final needs evaluation at map load,
snapshot version 7 with a migration that recomputes the thresholds of older saves from the active
buildings; tests in `test/needs.test.ts`). The text of each item describes the state before the
fix. Choices made where the spec leaves room (I):

- the deactivation count (5.3) counts every object of that type of the town at that moment:
  construction sites and collapsing buildings included, the leaving building included;
- the needs evaluation draws its rand() for computer towns too (the advisor, absent for computer
  players, only says the line);
- the advisor time unit D (`DAT_004a5d7c`) is taken as 60000 ms, so a need line's interval is
  rand() mod 120000 + 120000 ms = 120..152.8 s (the only interval documented with a number,
  mentor#81 "2 x 60000 ms" in `units-and-jobs.md` 7.7.1, suggests it). The interval is tested in
  ticks of `TICK_MS` and kept per nation and line (display only, saved, not hashed); a line said
  within its interval is dropped. The lines are queued (queue flag set);
- the map loader evaluates every town's needs once more after all objects exist (5.4 "at map
  load"), in town order;
- the operator-inside quirk of `00461690` (a resident leaving a building whose current job is the
  kind 0x22 job sends all occupants out first, 3.2) is not reproduced.

What differed:

1. **Fixed.** **Need buildings close their need without staff, and too late with staff** (5.3, 5.4). Ours
   raises the threshold (x 2.2) when the building is **completed** and leaves the need in the
   open set until the next population change. The original does both at **activation**, i.e.
   only when the operator (innkeeper, news seller, policeman, priest, ...) is inside, and removes
   the need from the open set at that moment. So in our build an unstaffed tavern, news stand,
   police station, temple or circus satisfies its need (after the next birth or death), which the
   original never does; the town is happier than in the original (h 100 instead of 83 with an
   unstaffed tavern at population 15..32), births stay certain longer, and the newborn at
   population 9 and 27 is less often a criminal. With an operator inside, ours closes the need up
   to one birth interval later than the original.
2. **Fixed.** **No reset on deactivation** (5.3). When a need building is destroyed or its operator leaves,
   the original resets the threshold to base x 2.2^(count − 1) and re-evaluates the needs; ours
   keeps the raised threshold for ever (`deactivate` does not touch the needs).
3. **Fixed** (training and jail release both go through `changeType`: two evaluations, the first
   with the population one lower). **Needs are not re-evaluated on a type change.** Training (`logistics.ts`, the student's type
   change) does not call `evaluateNeeds`; the original re-evaluates twice (5.4). Effect: a luxury
   need that was opened while the stock was empty can close later in the original (at a training)
   than in ours. The release from jail does re-evaluate in ours (once).
4. **Fixed.** **Random-number stream.** `evaluateNeeds` draws no `rand()`; the original draws one per open
   need (building or luxury) on every evaluation (5.4), i.e. on every birth, death and type change
   in a town with open needs. `completed` rolls (draws at h < 80) before checking whether the
   house is already full after rehousing; the original rolls only for a non-full house. Both
   change which later rolls succeed and which porter a criminal picks, not the rates. Needed for
   bit-exact replays only.
5. **Fixed** (the job now also runs for an inactive building and is re-armed for any building
   that is still alive). **House job ends early.** `runHouse` ends the job right after the birth that fills the house
   (and `leaveHome` then creates a new job with a fresh 599-tick delay when a resident leaves).
   The original returns 599 after that birth and ends the job only at its next run, so a place
   freed within those 599 ticks is refilled on the old phase. `runHouse` also ends the job of an
   inactive building, and `leaveHome` re-arms only active buildings; the original tests neither
   (only "building alive"). Houses have no operator, so in practice only the first point can
   matter: a vacancy is refilled up to 599 ticks later in ours.
6. **Fixed.** **Happiness gate.** `updateHappiness` computes happiness when the town hall is *complete*; the
   original requires the town's first town hall to be *active*. Different only for a town founded
   in play between site completion and the founder entering (a few ticks).
7. **Fixed** (mentor = odb +0x130 of the need building, 39..41 for the luxuries). Advisor lines of the need re-evaluation (mentor#29 ff. with their random delay) are not queued
   in ours (display only; see item 4 for the random numbers).

Not a difference: growth speed. Our births per minute match the original's rules for the same
house completion times (measurement below). Because a birth needs nothing but a free resident
place and h >= 80, the growth rate of a content town equals the rate at which houses are
completed: one resident at completion and one per 599 ticks (about one per minute) per non-full
house. If our town grows faster than remembered, the cause is upstream (how fast houses get
built: construction, porters, materials, `units-and-jobs.md` 6), not the birth rule. Likewise the
first criminal as the 19th resident (10th when unhappy) is the original rule.

**Measurement** (our engine, `World.step()` at 100 ms per tick, 18,000 ticks = 30 minutes,
computer players passive; scripted: small houses ordered one at a time near the town hall, wood and stone
topped up to 20 every 50 ticks; "fed" = food topped up to 20 every 50 ticks; the original's
expectation from the model of 3.2/5.5 driven by the same completion ticks, mean of 400 seeds,
without unit deaths):

| scenario | births in 30 min: ours / original rules | population at 5 / 10 / 15 / 20 / 30 min: ours / original rules | happiness at 5 / 10 / 15 / 20 / 30 min: ours / original rules | first criminal: ours / original rules |
|---|---|---|---|---|
| Pimmons mission 0, no input | 0 / 0 | 4 throughout / same | 100 until the 12 food are eaten (~7.5 min), then 66 / same | none / none |
| mission 0, 12 houses, fed | 39 (1.30/min; 7 of them refill places of porters killed by criminals) / 35.8 (1.19/min) | 16 / 28 / 36 / 37 / 36 vs 16 / 26.9 / 33.6 / 37.7 / 39.8 | 83 / 75 / 70 / 69 / 69 vs 83 / 76 / 71 / 69 / 69 | tick 3458, the 19th resident / tick 3458 in every seed |
| mission 0, 12 houses, not fed | 35 (1.17/min) / 32.2 (1.07/min) | 13 / 18 / 26 / 33 / 37 vs 13.7 / 18.6 / 25.1 / 30.4 / 36.2 | 66 / 50 / 43 / 38 / 36 vs 63 / 49 / 45 / 40 / 37 | tick 6207 (19th) / median 5980, range 4126..9801 (always the 19th: at the 10th birth the food was not yet gone) |
| free-play start (seed 777, town hall given, computer towns passive), 12 houses, fed | 37 (1.23/min) / 35.7 (1.19/min) | 16 / 25 / 34 / 38 / 38 vs 16 / 26.5 / 32.7 / 37.3 / 39.7 | 83 / 76 / 71 / 69 / 69 vs 83 / 76 / 71 / 69 / 69 | tick 3518 (19th) / 3518 |
| same, not fed | 33 (1.10/min) / 32.2 (1.07/min) | 16 / 21 / 26 / 30 / 36 vs 16 / 19.6 / 25.3 / 30.5 / 36.2 | 61 / 48 / 43 / 39 / 37 vs 61 / 48 / 45 / 40 / 37 | tick 4116 (19th) / median 5314, range 3518..8909 |

The remaining differences are noise (one rand() stream against 400) and the porters killed by
criminals in our run (the model has no deaths; each death frees a place that is refilled).

With an unstaffed tavern completed at tick 2500 (before population 15) in the fed scenario, the
model gives the original 27 residents at 10 minutes (h 76) against 30 with our rule (h 100 until
the news need at 25, item 1); in the not-fed scenario 18.6 against 19.5 at 10 minutes.

**Measurement after the fixes** (same script and scenarios; 30 minutes; the house completion ticks
differ from the table above from the second house on because of concurrent changes to the
builder's end of job in `logistics.ts`, 6.4.1, not because of the needs: no need is open before
population 15, so the fixes cannot change anything earlier):

| scenario | births in 30 min | population at 5 / 10 / 15 / 20 / 30 min | happiness at 5 / 10 / 15 / 20 / 30 min | first criminal |
|---|---|---|---|---|
| mission 0, no input | 0 | 4 throughout | 100, then 66 from ~7.5 min | none |
| mission 0, 12 houses, fed | 40 (1.33/min; 5 residents lost meanwhile, their places refilled) | 15 / 26 / 35 / 40 / 39 | 83 / 76 / 70 / 69 / 69 | tick 3750, the 19th resident |
| mission 0, 12 houses, not fed | 31 (1.03/min) | 13 / 16 / 23 / 27 / 34 | 66 / 50 / 48 / 43 / 38 | tick 6348, the 19th |
| free play (seed 777), 12 houses, fed | 38 (1.27/min) | 14 / 25 / 32 / 37 / 36 | 100 / 76 / 71 / 69 / 67 | tick 3768, the 19th |
| same, not fed | 28 (0.93/min) | 14 / 17 / 23 / 28 / 31 | 83 / 50 / 48 / 42 / 38 | tick 6852, the 19th |
| mission 0, fed, unstaffed tavern completed at tick 2500 | 36 (1.20/min) | 15 / 26 / 35 / 37 / 39 | 83 / 76 / 70 / 69 / 69 | tick 3698, the 19th |
| same, not fed | 34 (1.13/min) | 14 / 20 / 27 / 34 / 38 | 66 / 48 / 43 / 38 / 36 | tick 5601, the 19th |

The unstaffed tavern now leaves the tavern need open (26 residents at 10 minutes, h 76, against
the model's 27 / 76 for the original; the old rule gave 30 and h 100).
