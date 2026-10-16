# Combat, death, crime and healing (behaviour spec)

Status: **first full pass.** Every combat job named in `units-and-jobs.md` 3.1 has been traced
in AN.exe, along with the impact job, death of units, nature and buildings, town destruction,
diplomacy side effects, police, priests and outposts. Section 17 lists what is still open.

Sources: the decompiled AN.exe, including the virtual job methods recovered as described in
`units-and-jobs.md` section 13. Addresses are cited as evidence. No code is reproduced: behaviour
is described in our own words, tables and formulas. The handbook (`ref/manual-gog.txt`) is used
only for cross-checks, in paraphrase.

Legend: **C** = confirmed in code, **I** = inferred (data pattern, partial trace, naming),
**U** = unknown. All divisions are C integer divisions (truncate toward zero) unless a line says
otherwise. "Tick" is one scheduler tick (95 ms at normal speed, `units-and-jobs.md` 1.1; the
scheduler runs a tick only when **more than** 95 ms have passed (`00482ca0`), so the real period
is about 96 ms on a 1 ms clock and about 109 ms on the 15.6 ms `GetTickCount` clock of the GOG
release: 30,000 ticks are 48 to 55 minutes of play at normal speed).

Related documents:
- `docs/formats/idb-wdb.md`: the weapon table `dv.wdb` (fields named *min, max, range, speed,
  cooldown, hit%* and *projectile* below).
- `docs/formats/odb.md`: record fields (`rec+0x..`).
- `docs/game/units-and-jobs.md`: scheduler, job base, movement, harvest.
- `docs/game/economy.md`: crime rate, births of criminals, homeless, decay.
- `docs/formats/mdb.md`: diplomatic states.

---

## 0. Summary of the combat model

- There is **no armour and no defence value.** A hit subtracts a random amount between the
  weapon's min and max from the target's HP. The attacker's rank can multiply the amount (C).
- Every attack goes through one job pipeline (C):
  1. **attack** (0x08) chases the target until it is in range;
  2. **strike** (0x09) turns to the target, respects the cooldown and fires;
  3. a short-lived **impact job** (0x15) is scheduled for the moment the blow or projectile
     lands. That job rolls hit and damage, applies them and grants experience.
- **Projectiles are display only.** The simulation never moves a projectile object. The impact
  is a timed event that always reaches its target if the target is still alive: there is no
  dodging, homing logic or ballistic miss (C).
- **There is no area damage.** Bombs, catapults and explosions hit exactly one target (C, by
  absence: the impact path has no area scan).
- **Healing uses the same pipeline.** A priest "attacks" a wounded friend with the heal weapon
  (C).
- **Idle soldiers do not scan for enemies.** Automatic fighting comes only from:
  - guard/patrol jobs;
  - outpost garrisons;
  - the "help" rule: when anything of a race is attacked by another race, every armed unit of
    the victim's race within 12 cells joins in (section 7);
  - the retarget after a kill (3.6), which keeps a running fight going;
  - the computer player's defence response and army (`ai-diplomacy-trade.md` 2.2, 2.5).

  (C, instruction level: the attack job's vtable 0x4A572C is written at exactly 12 places in
  AN.exe, and its Gold counterpart 0x4B2780 at the same 12 in dvge.exe; section 8.4 lists them.)
  The full rule table of automatic engagement is in 8.4.

---

## 1. Data and object fields used

### 1.1 Weapon record (`dv.wdb`, see idb-wdb.md) (C)

| field | use in combat |
|---|---|
| kind (+0x04) | selects the impact behaviour: 1 melee and 2 missile share one routine, 3 heal, 4 bomb (`00463d00`) |
| projectile (+0x08) | -1: the blow lands after the animation delay. Otherwise a projectile of that group-7 type is shown and its flight time is added to the delay (`00481450`) |
| min, max (+0x0C, +0x10) | damage (or healing) range |
| range (+0x14) | 0 means melee (adjacent). Otherwise it is the ranged reach, see 3.4 for how it is applied |
| speed (+0x1C) | projectile speed: flight = distance64 × 1000 / speed, in 1/100 tick (4.3) |
| cooldown (+0x20) | **ticks** between strikes, before jitter (4.2) |
| hit% (+0x24) | percent chance that a melee, missile or bomb impact connects. Heal ignores it |

Every weapon object also carries a **blocking cell mask = 4** (cell flag 0x04, "building
present"). It is used by the line-of-fire test (3.4) (`004640a0`..`00464170`).

### 1.2 Object fields (C unless marked)

| object | off | meaning |
|---|---|---|
| any | +0x08 | category: 0 unit, 1 building, 2 nature |
| any | +0x20 | **target tier**, 0..2, set at creation and on retyping (`00461d70`); table 1.3 |
| any | +0x34 | alive (byte) |
| any | +0x44 | HP |
| unit | +0x6C | building the unit is inside. Units inside buildings cannot be targeted (3.2) |
| unit | +0x70 | **tick before which the unit may not strike again**. Initialised to -1000 (`00463d00`) |
| unit | +0x74 | weapon object (null = unarmed). Its +0x04 is the `dv.wdb` record |
| unit | +0x80 | **rank** 0..3 (byte) |
| unit | +0x84 | **experience** points |
| nature | +0x4C | 1 = living animal |
| building | +0xB0 | state: 1 site, 0 complete and inactive, 2 active |

### 1.3 Target tier (+0x20) (C, `00461d70`)

The tier is decided by the record's **type number only**, whatever the group. Lower means more
important.

| tier | types |
|---|---|
| 0 | 17 hunter, 21 police, 26 saboteur, 29..36 soldiers, 52/53 outposts |
| 1 | 39 barracks, 43 beast/ordnance yard, 56 magic building; every other **unit** except the criminal |
| 2 | 12 criminal; every other building; nature objects whose type is not listed above |

Because only the type number is tested, nature objects of types 17, 21 and 29..36 (some crops,
stones, and the animals 33..36) also get tier 0. This matters only in the retaliation rule
(7.2) (C).

### 1.4 Random numbers

Every random number is C runtime `rand()` (`004936b9`), one global stream. Section 16 lists each
call and its order. The rebuild uses its own seeded PRNG, but it must make the same calls in the
same order to get the same distribution.

---

## 2. Who may attack whom

### 2.1 The "may act on" rule (C, `00465460`)

A unit U may act on a target T only if T exists and is alive, and U is armed (+0x74 not null).
Then:

| T's group | U | allowed when |
|---|---|---|
| nature / animals (group 6 or 7) | hunter (17) | T is a wandering animal (class 7) |
| nature / animals | anyone else | never |
| a race other than U's | priest (22) | only when called with the "ally" flag, T is a damaged **unit**, and the diplomatic state between the two races is 3 (peace) |
| a race other than U's | saboteur (26) | T is a building |
| a race other than U's | criminal (12) | never |
| a race other than U's | any other armed unit | **always: no diplomacy check** |
| U's own race | criminal (12) | T is a porter (9) |
| U's own race | police (21) | T is a criminal (12) |
| U's own race | priest (22) | T is a unit with HP below its maximum |
| U's own race | anyone else | never |

Race = record group 0..2. Each nation is exactly one race, so "other race" means "other nation".

### 2.2 Where diplomacy is checked (C)

The state of a race pair is held in the relation table (mdb.md): 0 no contact, 1 war,
2 ceasefire, 3 peace. A pair of the same race has no entry (lookup -1, `00473bc0`).

| decision | rule |
|---|---|
| explicit attack order by the player (3.1) | 2.1 only. Ordering an attack on a ceasefire or peace race is allowed |
| retaliation and help (7.2) | 2.1 only (the attacker has already caused war, 6) |
| guard/patrol automatic targets (8.2) | 2.1 **and** state 0 or 1 |
| outpost garrison targets (9) | state 0 or 1 (2.1 is not consulted) |
| retarget after a kill (3.6) | 2.1 and same race as the previous target |

So patrols and towers ignore ceasefire and peace nations (handbook p. 39 agrees), but a direct
order does not.

---

## 3. Attack job (0x08) (C, run `00472b20`, vtable 0x4A572C)

### 3.1 Creation

Fields:

| job off | meaning |
|---|---|
| +0x24 | target (holds a reference) |
| +0x28 | path list filled by the path search (count +0x30) |
| +0x34 | search result: 0xFF none yet, 0xFE running, 0 found, 1..3 failed |
| +0x38 | search running (byte) |
| +0x3C | path-search object |
| +0x40 | child state: 0 none, 1 striking, 2 walking |
| +0x44 | **auto-retarget** flag (byte) |
| +0x48 | number of path searches started for this target |
| +0x4C/+0x50 | **anchor**: the target's cell when the job was created |

Every creator sets the anchor to the target's position at that moment.

| created by | owner | retarget +0x44 | first delay / notes |
|---|---|---|---|
| player right-click on an object that 2.1 allows (`00450bb0`; target must not be of the player's own race, see 12.6) | unit | 1 | 1 tick. Marked as a player order (job+8 = 1) |
| retaliation / help (`00464ce0`, section 7) | unit | 1 | 1 tick. The previous job is suspended behind it |
| guard/patrol scan (`00480a10`) | child of 0x27 | 1 | runs in the same call |
| hunter approaching a living animal (`00476930`) | child of 0x16 | 1 | runs in the same call |
| criminal (`004784d0`) | child of 0x17 | **0** | |
| police arrest (`0047b860`) | child of 0x18 | **0** | |
| priest heal (`00481180`) | child of 0x29 | **0** | |
| AI strategy routines (`00466020`, `00466e20`, `0046d3a0`) | unit | 1 | 5 (via `00465650`) |

A right-click of a **police officer** on one of the player's own criminals creates **no** attack
job at this level: it creates an arrest job (0x18) without a station and **without a target**,
marked as a player order, and that job starts its own attack child (no retarget) on a criminal
it picks itself (12.3 "Manual orders"). No other own unit attacks an own criminal (2.1; the
other unit types just walk to it, 12.6).

"Suspended behind it" means: the unit's current job gets a 5-tick block and is chained as the
new job's successor (job+0x20). When the attack ends, the old job becomes current again and is
unblocked (`units-and-jobs.md` 1.2). The old job keeps its children, including its walk and that
walk's goal; what it does when resumed is in 7.4.

### 3.2 Target validity (C, `00472ae0`)

The target counts as valid while all of these hold:

- it is alive;
- it is a building, or a unit that is not inside a building (garrisoned and sheltered units are
  untouchable);
- it is not nature, or it is a living animal.

### 3.3 One run of the attack job

1. **Attacker dead**: end, failure.
2. **Target invalid**: go to retarget (3.6).
3. **Leash**: d = torus distance (max + min/2) between the target's *current* cell and the
   **anchor**. If d > 29, end with failure. No retarget is attempted. The anchor is never moved,
   not even by a retarget.
4. **In range?** (3.4).
   - In range, and not yet striking: drop any walking child and any running search, and create
     a strike child (0x09).
   - Not in range: if a strike child exists, drop it (state 0). Then the job asks whether its
     **stored plan is usable**: a path is stored and its **last cell** is a firing position for
     the target where it stands *now* (3.4 evaluated from that cell).
     - Usable, and the unit is not walking: create a follow-path child (job 0x06) from the
       stored path (join rule in 3.3.1), then clear the stored list. The child runs in this same
       run (turn, or the first step at once). While walking, the unit gets the "charging" step
       bonus (`units-and-jobs.md` 4.1: step time - 1), but only when the attack job is the
       unit's *top-level* job. Attacks run as children of guard, harvest, arrest or heal jobs
       do not charge;
     - usable, and the unit is walking: nothing; the walk goes on;
     - not usable (no path stored, or the target has moved so that its last cell no longer
       reaches it), and no search is running: start a path search (3.5). If 5 searches have
       already been started for this target, retarget (3.6) instead. **This happens while
       walking too, and the walk is not dropped**: the new search only prepares the next walk.
       Without a walk the job returns 2;
     - not usable, search running: return 2 (or the walk's delay, step 5).
5. **Run the child**, if any:
   - it returns non-zero and the target is still valid: return its value as this job's delay;
   - it returns non-zero but the target is invalid: drop the child and retarget (3.6);
   - it returns 0 (finished): drop it. If it failed, also cancel the search and clear the
     stored path. Set state 0 and return 1.

The job re-evaluates range on every run, and while walking it runs once per step. A walking
attacker therefore stops at the first cell from which the target is in range.

**Timing of that test (C).** While walking, the job's delay is the follow-path child's delay D
(`units-and-jobs.md` 4.1). So the range is tested D ticks after a step started, when that step
has been fully drawn on screen (D × 95 ms < D ticks), never in the tick the step starts. The strike
child is created and run in that same run: turn first (4.1), then fire. *Our build (fixed October 2026): `combat.ts attackStep` tests the range only when the last step's
D ticks are over; while a step is under way it returns the remaining ticks (`units-and-jobs.md`
7.3.9 item 7).*

#### 3.3.1 Following a moving target (C, `00472b20`, `00472520`, `004706e0`, `0047f320`, `00480410`)

How a chaser keeps up with a target that walks away (soldier after a fleeing unit, police after a
criminal, hunter after a wandering animal, criminal after a fleeing porter). There is no separate
"follow" logic: it all comes out of the run order of 3.3.

**How often the target is looked at.** At every run of the attack job. While the unit walks, the
job runs when the follow-path child's delay is over: once per step, D ticks after the step began
(3.3 "Timing of that test"), and after each turn or wait of the walk. Each run reads the target's
*current* cell: leash (step 3), range from the unit's cell (step 4), and whether the stored plan
still ends on a firing position.

**What the walk aims at.** The search goal is not the target's cell but the first cell, in the
search's best-first order from the attacker, from which 3.4 holds for the target's footprint *at
the time the search started*: for a melee weapon a cell of the target's 8-neighbourhood (the
search ignores units, so the cell may be occupied), for a ranged weapon the nearest cell with
range and line of fire. That cell is the end of the path and the goal of the walk made from it.

**The walk is never redirected because the target moved.** A running walk ends only when
- the target is in range after a step (step 4: the walk child is dropped, the strike begins);
- the walk reaches its own goal, or fails (4.1 of `units-and-jobs.md`);
- the attack retargets or ends (3.6, leash, dead target).

Meanwhile the job keeps one plan for the *next* walk ready:
1. The first run after the walk was made finds no stored path (it was moved into the walk), so it
   starts a search from the unit's current cell. Under the lockstep rule of 3.5 its result is
   there at the next run.
2. At every later run the stored plan is tested against the target's current footprint. As long
   as its last cell still reaches the target, nothing happens. As soon as the target has moved
   so far that it does not, another search starts from the unit's current cell.
3. When the walk reaches its goal (child returns 0, success), the job returns 1. One tick later,
   if the target is still out of range and the stored plan still usable, the next walk is made
   from it and takes its first step at once; if not, a search starts and the walk follows 2
   ticks later.

Every search in 1 and 2 uses one of the **5 searches per target** (counter +0x48), and nothing
gives them back: the counter is reset only by a retarget (3.6) or a new attack job. Against a
target that keeps moving away, the plan goes stale about every step (a melee goal is next to the
old position, so one step of the target makes it useless), so the counter runs out after a few
steps of walking. The 6th attempt calls the retarget, which **drops the walk where the unit
stands** (between two steps) and clears plan, search and counter:

| attack created by | retarget flag | what follows the 6th search |
|---|---|---|
| player order, help/retaliation, guard scan, AI | 1 | scan around the old target (3.6). It normally finds the same unit again; the next run searches from the unit's own cell (counter 1), the walk starts 2 ticks later toward where the target is now |
| hunter's harvest (on a living animal) | 1, but the scan never returns animals | the attack ends; the harvest job starts a new attack on the same animal at once with a **new anchor** (`units-and-jobs.md` 7.3.4) |
| police arrest | 0 | the attack ends; the arrest job picks the first free criminal of the town (usually the same) and attacks again, new anchor (12.3) |
| criminal | 0 | the assault ends; the criminal waits 50 ticks and picks a random porter (12.1) |
| priest | 0 | the heal child ends; the priest scans for the nearest wounded unit within sight 5 (13) |

So a chaser of a fleeing unit re-plans from its own position roughly every four to five steps,
and in between follows the walk it has; a target that turns round is noticed by the range test
after every step, but the walk is only re-aimed by such a retarget or when it is finished.

**Join rule of a walk made from the stored path (`0047f320`).** The path written by the search
begins with the cell the search started from (`004706e0` inserts it in front of the found cells,
which themselves exclude the start). The walk's goal is the path's last cell. Its own cell list
is the part of the stored path **after the first stored cell that has the unit's x or the
unit's y** (one equal coordinate is enough). If no stored cell matches, the walk gets no cells
and ends at its first run with success. The follow-path job then drops leading cells equal to the
unit's cell and fails at once if the next cell is not a neighbour (`units-and-jobs.md` 4.1).
Consequences:
- a plan made where the unit stands (the usual case: before the first walk, after a strike, after
  a failed walk, after a retarget) joins at its first cell and is walked in full;
- a plan made during the previous walk was searched from a cell a few steps back. It joins
  properly only if the unit is still on its line; otherwise the walk fails in its first run, the
  failure drops the stored path (step 5), the job returns 1, and a fresh search from the unit's
  cell follows (one more search used).

**Range while walking (ranged units).** The full 3.4 test (distance and line of fire, buildings
block) from the unit's cell after every step; the first cell that passes ends the walk. There is
no test between steps and no test of the target's visibility (fog of war plays no part).

**Give-up conditions, all of them.**

| condition | effect |
|---|---|
| target more than 29 (max + min/2) from the anchor (its cell when the attack began) | end, failure, no retarget (step 3) |
| target dead, inside a building (garrison, shelter, a criminal led into the station), or a carcass | retarget (3.6) |
| 6th search for this target (5 used up by re-plans) | retarget (3.6) |
| no path found | not a condition of its own: each failed search is one of the 5 |

There is no time limit and no distance limit from the attacker himself. A target that enters a
building is dropped at the next run; one that keeps walking is followed until the leash or the
search limit ends it, and with the retarget flag the chase usually goes straight on.

**Hunters and police compared.** Both use this attack job unchanged; the differences are the
retarget flag and what the parent job does when the attack ends (table above). Neither charges
(their attacks are children), so both chase at their normal step times. A hunter's animal moves
by its own wander job (`units-and-jobs.md` 7.7), a criminal flees (7.3) after each blow: both make
the stored plan stale in the same way.

*Our build (implemented October 2026, `combat.ts attackStep`, `plan`, `walkPlan`; test
`test/chase.test.ts`). Before, a moving target was looked at again only when the walk had ended:
one search per walk, no searches during a walk, so the counter never ran out mid-walk and a walk
was never dropped by the retarget; the first step came 3 ticks after the search. Now the attack
state holds a walk flag and the stored plan (snapshot version 9; older saves get the two slots,
the walk flag set when the unit was walking). Deviations: the plan keeps only its start cell and
its end (the firing position); when the walk is made, the way between them is planned again with
the same unit-free search (deterministic, normally the same way) and the join rule is applied to
it. The search is our A\* toward the target's cell, cut at the first cell from which the target is
in range; a melee attacker aims at the nearest free cell next to the target (several attackers
spread out) and keeps that cell as the plan's end. Ships keep their one-search-per-walk chase on
the sea grid (`addon.md` 7). Our walk ends at the motion run after the jobs, so the end is seen
at the next run, which is the original's next run (1 tick later), and goes on at once.*

### 3.4 Range and line of fire (C, `00472b20`, `004709b0`, `004712d0`)

The target footprint is the rectangle [x - size_x + 1 .. x] × [y - size_y + 1 .. y] (odb.md 2.2).

**Melee (range = 0):** in range when the attacker's cell lies inside the footprint grown by one
cell on every side, i.e. in the 8-neighbourhood of the target, diagonals included. All tests
wrap around the torus. The same test applies to heal and bomb weapons, whose range is also 0.

**Ranged (range R > 0):**

1. Quick reject: the distance (max + min/2) from the footprint centre ((minx+maxx)/2,
   (miny+maxy)/2) to the attacker must be **≤ 2R**.
2. Line of fire: walk a Bresenham line from the attacker's cell toward the footprint centre and
   add a cost for every cell entered:

   | cell | cost |
   |---|---|
   | the attacker's own cell | 0 |
   | any cell occupied by the target itself | 0, and the walk ends there |
   | a cell carrying flag 0x04 (any other building) | blocked: infinite |
   | a straight step (x or y unchanged) | 2 |
   | a diagonal step | 3 |
   | terrain rises by ≥ 32 height units against the previous cell | +1 |
   | terrain falls by ≥ 32 height units | -1 |

3. In range when the total is **< 2R + floor(e/2)**, where e = max(size_x, size_y) - 1 (0 for a
   unit).

Consequences on flat open ground:

- straight line: in range up to **R cells**;
- pure diagonal: in range up to **floor((2R + 2)/3) cells**.

| weapon | straight | diagonal |
|---|---|---|
| hunter bow, R 5 | 5 | 4 |
| archer, R 6 | 6 | 4 |
| catapult, cannon, crossbow, R 8 | 8 | 6 |

Other things that follow:

- Buildings block arrows; units, trees and stones do not.
- There is no minimum range: a ranged unit can shoot an adjacent enemy.
- A height test of the ray against the terrain exists, but it compares the ray (height + 64)
  with height / 64, so in practice it never blocks (I).

### 3.5 Path search for a firing position (C, `004725e0`, `004706e0`)

- The search is a best-first expansion over the 8 neighbours. It uses the attacker's step costs
  (rec+0xC4) and its path mask (+0x28), and starts at the attacker's cell.
- **Goal**: any cell from which 3.4 holds, the same predicate as above.
- 100 nodes are expanded per step. The search fails after **2000** nodes (result 3) or when the
  open list is empty (results 1/2).
- On success the path is written into the attack job's list.
- In the original, searches are stepped by a cooperative background task queue
  (`00487bf0`/`00470670`), not by the tick scheduler. Their completion time in ticks therefore
  depends on frame timing. **Lockstep rule for the rebuild:** finish the search synchronously, so
  that the result is available at the attack job's next run (2 ticks later) (I).
- At most **5 searches per target** (counter +0x48). Each re-plan caused by a moving target uses
  one up, also the ones made during a walk, so a target that keeps running away is chased
  through about 5 re-plans, then abandoned or retargeted (C; the whole sequence is in 3.3.1).
- The stored path starts with the search's start cell, followed by the cells found (the search
  itself excludes the start; `004706e0` puts it in front). A walk is made from it by the join
  rule of 3.3.1.

### 3.6 Retarget / give up (C, `00472190`)

1. Clear the state, the child, the search and the path. The search counter goes back to 0.
2. If auto-retarget (+0x44) is set:
   - scan a circle of radius **attacker sight (rec+0xB0) + 3** around the **old target's
     position** (units and buildings, 8.3);
   - choose with the target chooser (8.3), restricted to the **old target's race**, all tiers
     allowed;
   - if a target is found: switch to it, clear the player-order flag (job+8 = 0) and return 1.
3. Otherwise end (return 0).

Animals are never found by this scan, which collects only units and buildings. A hunter's attack
therefore always ends after the kill (section 14).

**A dead target still has a position and a race** (C, instruction level `0x472219..0x47227f`;
Gold `0x47bc89..0x47bcef` identical). The attack job holds a counted reference to its target
(+0x2C of the object, taken at creation, released when the job lets go of it), so a unit or
building that has died is not freed while an attack job still names it. The retarget reads the
old target's stored cell (+0x10/+0x14) and its record's race (+0xA0) unconditionally. Death does
not change the stored cell (`004641d0`, `00462430` never write it), so the scan is centred on the
cell where the target died, and the race filter is the dead target's race. This is the normal
case: almost every retarget happens because the target was just killed.

Consequence for group fights: when a soldier kills its target, at its next run (at most 5 ticks
after the impact, the strike child's poll) it switches to the best target of the dead one's race
within sight + 3 of the body (13 cells for soldiers and hunters, 8.3: lowest tier present first,
then the highest score), without waiting to be hit. The player-order flag is cleared, so the new
attack is an automatic one. Only when nothing of that race is within that radius does the attack
end and the unit stand idle (and the suspended job, if any, resumes).

The same holds for an attack job that was suspended behind another one (7.4) and resumes after
its target has died meanwhile: its first run retargets around the body, wherever that is.

---

## 4. Strike job (0x09) (C, ctor `004734f0`, run `00481450`)

One strike job lives as long as the attacker stays in range. It fires repeatedly.

### 4.1 Each run

1. **Target dead**: success, return 0.
2. **Drop load**: if the attacker carries goods, its carried amount is set to 0 (the goods are
   lost) and its base action becomes walk (C).
3. **Origin**: the attacker's cell, or the anchor cell of the building it sits in (garrison).
   This origin is used only for the facing (step 4). The aim corner and the flight time (step 6)
   always use the attacker's own stored cell, also in a garrison (9.7).
4. **Facing**:
   - the wanted direction comes from the wrapped delta to the target's cell, using the same
     8-way direction function as movement (`004741d0`);
   - if the facing differs: turn **one 45° step** toward the shorter side, send the facing
     message, and return floor(step_time[0] / 2) ticks (2 for every unit; 1 if step_time[0]
     < 4). Nothing else happens on this run.
5. **Cooldown check**: if tick - unit+0x70 < cooldown, nothing fires (go to step 7).
6. **Fire** (the attacker faces the target and the cooldown has elapsed):
   - a = attacker rec+0x04 (`sound_frame`) × 1000 / 7. This is the animation time until the
     impact frame, in 1/100 tick (one frame = 10/7 ticks, `units-and-jobs.md` 10).
   - Animation action: 1 (`ST`) if the attacker's sprite set has a strike row, otherwise 2 (`WO`).
     The choice comes from the per-race, per-type sprite table at 0x4B3914 (I). Priests use 2.
   - **Notify the victim** (section 7) when all of these hold:
     - the target is not nature;
     - the attacker is armed;
     - the attacker is not a priest;
     - the target is a building, or a unit that is outside buildings.
   - Without a projectile: send the action message (0x19,11) with the action, sound frame
     rec+0x04 and loop parameter 0 (play once, I). Flight f = 0.
   - With a projectile:
     - aim point = the first of four candidate cells with the smallest distance from the
       attacker's own cell (`00461e30`): (X, Y), (X, Y + 1 − size_x),
       (X + 1 − size_y, Y + 1 − size_x), (X + 1 − size_y, Y + size_y − size_x), distance
       max + floor(min/2) of the wrapped cell deltas, strictly-smaller replaces. The sizes are
       used transposed (a quirk; exact corners only for square footprints). Full rule and
       examples: `rendering/projectiles.md` 1.1. For a unit this is its own cell;
     - with dx, dy = (attacker cell - aim cell) × 64, not wrapped (see 16);
     - d64 = max(|dx|,|dy|) + min(|dx|,|dy|)/2;
     - **f = d64 × 1000 / speed**;
     - send the projectile message (0x1B,26): projectile type, flight f, action, sound frame,
       target and aim cell. The shooter's display plays the strike animation and launches the
       projectile sprite at the sound frame.
   - **Schedule an impact job** (0x15) after **(f + a) / 100 + 1** ticks (4.3).
   - **Cooldown with jitter**: r = rand() % (cooldown / 2 + 1); set unit+0x70 = tick + r + 1.
7. **Return value**: remaining = cooldown - (tick - unit+0x70). Return min(remaining, 5), but at
   least 1.

Effective **strike interval = cooldown + 1 + r ticks**, with r uniform in 0..cooldown/2. The
return value polls in steps of at most 5 and lands exactly on the first allowed tick (C).

The +0x70 timestamp belongs to the **unit**, not the job. Switching targets does not reset the
cooldown, and a fresh unit (-1000) may strike immediately.

### 4.2 Strike interval by weapon (C, from the table)

| weapon | cooldown | interval (min..max ticks) | mean |
|---|---|---|---|
| knife (criminal) | 25 | 26..38 | 32 |
| truncheon (police) | 15 | 16..23 | 19.5 |
| short sword | 10 | 11..16 | 13.5 |
| sword / hammer | 30 | 31..46 | 38.5 |
| archer bow, fireball | 35 | 36..53 | 44.5 |
| hunter bow, hunting spear, crossbow | 40 | 41..61 | 51 |
| drake, spit pack | 50 | 51..76 | 63.5 |
| cannon, Necktarus | 60 | 61..91 | 76 |
| alchemist 2 / mage 2 | 65 | 66..98 | 82 |
| alchemist 1 / mage 1 | 80 | 81..121 | 101 |
| catapult | 100 | 101..151 | 126 |
| heal | 20 | 21..31 | 26 |

### 4.3 Impact delay examples (C)

delay = (f + sound_frame × 1000 / 7) / 100 + 1

| attacker | sound_frame | target distance | f | delay |
|---|---|---|---|---|
| Pimmon swordfighter | 6 | adjacent | 0 | 857/100 + 1 = **9** |
| Pimmon archer | 8 | 6 cells straight | 384 | (384 + 1142)/100 + 1 = **16** |
| Amazon archer | 7 | 6 cells straight | 384 | (384 + 1000)/100 + 1 = **14** |
| Amazon cannon | 7 | 8 cells | 512×1000/900 = 568 | (568 + 1000)/100 + 1 = **16** |
| Pimmon priest (heal) | 4 | adjacent | 0 | 571/100 + 1 = **6** |

---

## 5. Impact job (0x15) and the damage model (C, run `00481c40`, vtable 0x4A563C)

The job holds the target and the attacker (both referenced) and runs once, at its scheduled
tick. It is saved with the game.

### 5.1 Steps

1. If the target is dead or its HP is 0: nothing happens and the job ends.
2. Remember h0 = the target's HP. Call the attacker's weapon routine with the attacker's
   **rank** (+0x80) as the strength argument (5.2).
3. **Dealt** = h0 - the target's new HP. When the target died this is h0, so overkill does not
   count. A heal gives a negative value.
4. **Experience** (5.3) for the attacker.
5. **Building under attack**: if the target is a building, its owner's advisor gets mentor#20
   ("a town is being attacked"), or mentor#22 ("a town hall is being attacked") for type 40.
   The message carries the building's cell. It is said on every such impact, if the building
   was alive with HP > 0, whatever the damage. The advisor repeats a given message at most once
   per 120 s of real time (2 D, `00410df0`, GetTickCount). Lines #20 and #22 have separate
   timers. That is UI-only state and not part of the simulation (C, `docs/ui/side-panel.md`
   1.1).
6. **Diplomacy**: look up the state between the target's race and the attacker's race. If an
   entry exists and the state is 2 (ceasefire) or 3 (peace), broadcast "set state = 1 (war)"
   (`004583f0`, applied by `004584e0`). Section 11 has the side effects.

The attacker does not have to be alive at impact: arrows already in flight still land after
the archer dies (C). Only bombs check that their carrier is alive.

### 5.2 Weapon routines (C, `00483930`, `00483a10`, `00483a80`)

**Melee and missile** (kind 1, 2):

1. If rand() % 100 ≥ hit%, it is a miss: no damage.
2. Otherwise dmg = min + rand() % (max - min + 1). Then apply the rank:

   | rank | damage |
   |---|---|
   | 0 | dmg |
   | 1 | dmg × 125 / 100 |
   | 2 | dmg × 150 / 100 |
   | 3 | dmg × 200 / 100 |

3. HP -= dmg. If HP > max HP (rec+0xAC), set HP = max. Otherwise, if HP < 1, set HP = 0 and the
   target **dies** (its object die method, section 10).

**Heal** (kind 3): HP += min + rand() % (max - min). This is 7..12 for the only heal weapon:
there is no "+1", and no hit roll. HP is clamped to the maximum. Rank is ignored.

**Bomb** (kind 4):

1. If the carrier is dead: nothing at all.
2. If the target is alive and rand() % 100 < hit%: HP -= min + rand() % (max - min + 1), with no
   rank multiplier. HP at or below 0 means death, as above.
3. In every case the **carrier dies** afterwards. There is no splash damage.

There is no armour, no resistance and no building or unit modifier. HP is the only defence.

### 5.3 Experience and rank (C, `00461de0`, `004655d0`)

Experience earned from one impact, with d = the dealt amount:

| target | experience |
|---|---|
| a soldier (type 29..36) of any race | 2·d |
| a building | d/2 |
| any other unit | d |
| nature or animals, or a negative d | 0 |

Only these attackers keep experience: soldiers (29..36), police (21) and hunters (17). For
them, exp += earned, and the rank is recomputed from the attacker's own maximum HP (H = rec+0xAC):

| rank | condition | handbook star | damage factor |
|---|---|---|---|
| 0 | exp ≤ 2H | none | ×1 |
| 1 | exp > 2H | bronze (`ERFAHRUNG1`) | ×1.25 |
| 2 | exp > 6H | silver (`ERFAHRUNG2`) | ×1.5 |
| 3 | exp > 18H | gold (`ERFAHRUNG3`) | ×2 |

The UI icon names are those of the string table (I for the icon link). Experience never
decreases. **Rank affects only outgoing damage** (C for the multiplier; I that nothing else
reads it: no other simulation reader of +0x80 was found).

Example: an archer (H = 100) needs more than 200 experience for bronze, which is one dead
150-HP swordfighter (150 × 2 = 300). Silver needs > 600 and gold > 1800 (six such kills).

---

## 6. Projectiles and effects (C for the simulation side, I for the display side)

- Group-7 records (odb.md A.5) are only ever created as **display objects**: the projectile
  message, the impact effect and the death effect. They have no simulation state, no position
  in the simulation and no collision.
- The flight time is fixed when the shot fires (4.1). The impact lands on the target wherever
  the target is by then (**perfect homing**). If the target has died, entered a building or been
  removed, nothing happens.
- At the end of the flight the display spawns the projectile record's **impact effect** (+0x148)
  at the aim cell: 17 `expl1` (alchemy 1, catapult, magic 1, fire) or 18 `expl2` (alchemy 2,
  magic 2). Arrows, bolts and acid have none (`00434840`).
- **Sounds** (C, `00435ad0`, `00434840`; correction of the earlier "launch sound" reading):
  - the **shooter's** own record sound (+0x08) plays when its strike animation reaches the
    record's sound frame (+0x04). This is the moment the projectile is released (bow twang,
    cannon shot, spell);
  - the **projectile** record's sound plays when the flight **ends**, at the aim cell, if that
    record has +0x134 = 1 (all projectile records 0..10 do). That is the hit sound: 65 for
    arrows, bolts and acid, 52 for Alchemie1/Magie1/Feuer, 53 for Magie2, 18 for the catapult
    stone;
  - the impact effects 17 and 18 have no sound.
- Display details (launch point, straight flight, frame rules, timing):
  `docs/rendering/projectiles.md`.

### 6.1 Who shoots what (C for the data links, D = read from the data files)

Every attacker uses the weapon record named by its `dv.odb` +0x144. The strike copies that
record's projectile type (+0x08) into the projectile message unchanged, and the display draws
exactly that group-7 type: **there is no per-race remapping** (C, `00481450`, `004565a0`,
`00435ad0`). The strike animation is row 1 `ST` for every attacker below (all have `ST0..7`; D);
the projectile leaves at the record's sound frame (+0x04).

"Reach" is the in-range distance on flat open ground, straight / diagonal (3.4). "Flight" is per
straight cell: simulation ticks = 640 / speed, screen milliseconds = 64000 / speed
(`docs/rendering/projectiles.md` 3). "ST" = strike-row frames (OD sprite folder in brackets when
its name differs from the unit's). "rel" = release frame = sound frame; the simulation counts
rel × 10/7 ticks from the strike to the release.

| race | unit (type) | weapon | reach | projectile → sprite (dirs × frames) | speed (flight/cell) | impact effect | hit sound | ST frames, rel | shooter sound |
|---|---|---|---|---|---|---|---|---|---|
| Amazons | Jägerin (17), **hunter** | 1 JägerBogen, 70 % | 5 / 4 | 10 Bogen → `BULLET\VE\BOGEN\MS0..7` (8 × 1) | 900 (0.71 t, 71 ms) | none | 65 | 12, 7 | 6 |
| Amazons | Bogenschützin (29) | 3 KampfBogen | 6 / 4 | 10 Bogen (same arrow) | 1000 (0.64 t, 64 ms) | none | 65 | 12 (`LANGBOGENSCHUETZIN`), 7 | 45 |
| Amazons | Alchemistin (33) | 7 Alchemistin1 | 5 / 4 | 0 Alchemie1 → `ALCHEMIE1\MS0..7` (8 × 8) | 700 (0.91 t, 91 ms) | 17 expl1 | 52 | 10 (`ALCHEMISTIN2`), 7 | 7 |
| Amazons | Mächtige Alchemistin (32) | 8 Alchemistin2 | 5 / 4 | **0 Alchemie1** (not 1) | 800 (0.80 t, 80 ms) | 17 expl1 | 52 | 11 (`ALCHEMISTIN`), 7 | 7 |
| Amazons | Katapult (34) | 9 Katapult | 8 / 6 | 3 Katapult → `KATAPULT\MS0..7` (8 × 6) | 900 | 17 expl1 | 18 | 7 (`REITTIER1`), 6 | 16 |
| Amazons | Kanone (35) | 10 Kanone | 8 / 6 | 3 Katapult (same stone) | 900 | 17 expl1 | 18 | 10 (`REITTIER2`), 7 | 17 |
| Amazons | Armbrustschützin (36) | 11 Armbrust | 8 / 6 | 2 Armbrust → `ARMBRUST\MS0..7` (8 × 1), the **bolt** | 1100 (0.58 t, 58 ms) | none | 65 | 8 (`BOGENSCHUETZIN`), 4 | 46 |
| Pimmons | Bogenschütze (29) | 3 KampfBogen | 6 / 4 | 10 Bogen | 1000 | none | 65 | 14, 8 | 45 |
| Pimmons | Magier (33) | 12 MagierPimmon | 5 / 4 | 4 Magie1 → `MAGIE1\MS0` (1 × 10) | 700 | 17 expl1 | 52 | 12 (`MAGIER2`), 6 | 20 |
| Pimmons | Mächtiger Magier (32) | 13 MächtigerMagierPimmon | 5 / 4 | 5 Magie2 → `MAGIE2\MS0` (1 × 10) | 800 | 18 expl2 | 53 | 17 (`MAGIER`), 7 | 21 |
| Pimmons | Drachofiterus (34) | 14 Drachofiterus | 8 / 6 | **10 Bogen** (an ordinary arrow) | 900 | none | 65 | 12 (`REITTIER1`), 7 | 46 |
| Sajiki | Pyro (29) | 18 Feuerkugel | 6 / 4 | 9 Feuer → `FEUER\MS0` (1 × 10) | 1200 (0.53 t, 53 ms) | 17 expl1 | 52 | 6, 3 | 24 |
| Sajiki | Beschwörer (32) | 12 MagierPimmon | 5 / 4 | **4 Magie1** (the Pimmon spell) | 700 | 17 expl1 | 52 | 12 (`MAGIER1`), 8 | 25 |
| Sajiki | Gottesanbeter (33) | 13 MächtigerMagierPimmon | 5 / 4 | **5 Magie2** | 800 | 18 expl2 | 53 | 10 (`MAGIER2`), 8 | 26 |
| Sajiki | Spitpack (34) | 19 SpitPack | 8 / 6 | 8 Säure → `SAEURE\MS0` (1 × 10) | 1000 | none | 65 | 10 (`REITTIER1`), 6 | 27 |
| add-on | warships 65/66 (Amazons, Pimmons) | 25, 26 / 21, 22 | see `addon.md` 1.3 | 3 Katapult | 1000 / 1000, 900 / 700 | 17 expl1 | 18 | | |
| add-on | Seepyro (Sajiki 66) | 24 Feuerball | 10 / 7 | 9 Feuer | 600 | 17 expl1 | 52 | | |

Not in the table, because they have no projectile (weapon +0x08 = −1, the blow lands
rel × 10/7 ticks + 1 after the strike starts): the Pimmon and Sajiki **hunters** (17,
weapon 17 Jagdspeer: a stab from an adjacent cell, `ST` 11 frames rel 4 resp. 12 frames rel 5),
police, criminals, swords, hammers, Necktarus/Brutwache, priests (heal) and the bomb carriers
(saboteurs, Explodus, Harak).

- **No building shoots by itself.** No building record has a weapon (+0x144 = −1). Outposts
  (52, 53) fire through their garrison soldiers (9.3, 9.6, 9.7), each with its own weapon and
  projectile; the projectile starts at the outpost (`docs/rendering/projectiles.md` 2).
- **Unused projectile records:** 1 `Alchemie2`, 6 `MagieSa1` and 7 `MagieSa2` are named by no
  weapon, so the Mächtige Alchemistin throws the Alchemie1 flask and the Sajiki casters throw the
  Pimmon spells (C: no remap in code; D: weapon table). Group-7 types 14..16 (`GRENZEAZ/PI/SA`,
  border markers) are not projectiles.
- The data is identical in GOG and Gold (`dv.wdb` byte-identical; group-7 `dv.OD` descriptors
  identical).
- A dying **unit** that is visible spawns a death effect (`00434840`):
  - group-7 type 19 `expl3` (sound 54) if its weapon is 4 (sabotage bomb) or 16
    (Explodus/Harak), i.e. the bomb carriers blowing up;
  - otherwise group-7 type 11 + race, the race's `Die` animation (sounds 51/50/49).

  **No corpse remains in the simulation.**

- **When the death sound plays** (C, `00456770` → `00434840`, `00434ed0`, `00435ad0`):

  | step | when | what |
  |---|---|---|
  | 1 | the display handles "object died" (0x1E,9), in the same display update as the death (no delay, no queue) | the unit's picture is taken off the screen at once |
  | 2 | same moment, only if the unit was in this frame's drawn list | the death effect object is created at the unit's cell, frame 0 |
  | 3 | **same moment, right after creating it** | the effect record's sound (+0x08) plays **once**, positioned at the dead unit's screen point like every world sound |
  | 4 | the effect reaches its last frame | the effect is removed. **No second sound**: the end-of-life sound needs record +0x134 = 1, and the death records have 0 |

  So the sound starts together with frame 0 of the "poof"; it is not tied to the animation's
  last frame or to the record's sound frame (+0x04 = 1 is ignored for effect objects: the
  per-frame sound rule of `unit-motion.md` 5 only runs for non-effect display objects).

  | race | effect type | sprite frames | record sound | sample |
  |---|---|---|---|---|
  | Amazons | 11 `Die` | (data) | 51 | `Sfx_051.wav` |
  | Pimmons | 12 `Die` | (data) | 50 | `Sfx_050.wav` |
  | Sajiki | 13 `Die` | (data) | 49 | `Sfx_049.wav` |
  | bomb carrier (weapon 4 or 16), any race | 19 `expl3` | 14 | 54 | `Sfx_054.wav` |

  The race is the dead unit's record group (its race), not the killer's. Nothing is played
  for a unit that dies off screen (not in the drawn list), and nothing at all for buildings
  (their sound is the collapse sound, 10.3.1) or nature (death cry, 10.2).

---

## 7. Reactions to being attacked (C, `00462e30`, `00462ab0`, `00464ce0`)

The strike notification (4.1) calls "victim V attacked by A". If A sits in a building, the
building stands in for A in the help rule below. Steps:

1. **Different race only:**
   - **AI alert**: if V's nation is computer-controlled and V stands inside territory of V's
     race (the territory block of V's cell, `0044e3b0`), A itself (not the outpost it may sit in)
     is appended to the intruder list of the military job of the town owning that territory
     (`0046cab0`; one entry per strike, duplicates allowed, dead A not recorded). The town's
     defence response (`ai-diplomacy-trade.md` 2.2 phase 1) then attacks A wherever A stands, as
     long as A's attack job targets an object of V's race (C). *Our build (October 2026):
     `Ai.alert` from `Combat.attacked`, before the help rule; an attacker is recorded once.*
   - **Help** (7.1).
2. **Flee**: if V is a **unit** that is unarmed, a priest or a criminal, and V's current job is
   not a player order (or V has no job): give V a flee job (7.3). V's current job is suspended
   behind it (5-tick block, chained; 7.4). The flee job becomes V's current job and runs for the
   first time **3 ticks** later. This also applies within the same race: porters flee from
   criminals, and criminals flee from police.

### 7.1 Help radius (C, `00462ab0`)

Scan a circle of radius **12** around V (units and buildings, `0044a7c0`; the circle test is
dx² + dy² < 144). For each unit X found:

- **Armed X of V's race, not a priest**: apply the retaliation rule (7.2) with X against A.
  V itself is in the circle, so an armed victim fights back through this rule.
- **Priest X**, when V is a unit with HP below its maximum and X ≠ V, and X is of V's race or
  its race is at peace (state 3) with V's: if X's current job is neither a heal job nor a player
  order, cancel that job and give X a **heal job** (0x29) for V, with auto-continue on, after
  1 tick. This is the handbook's "injured soldiers call the priest" (p. 40). The radius is 12
  cells around the victim (C).

### 7.2 Retaliation rule (C, `00464ce0`)

X attacks A (a new 0x08 job, retarget on, anchor = A's cell, 1-tick delay, previous job
suspended behind it) unless one of these holds:

- X is unarmed, or 2.1 forbids X acting on A;
- X's current job is an attack and:
  - it is already against A; or
  - its current target's tier ≤ A's tier (X keeps attacking a more important or equally
    important target); or
  - it is a player-ordered attack and A is not currently attacking X;
- X's current job is not an attack but is a player order.

Hunters on an automatic harvest and police on an arrest are not "attacking" at top level, so
they do switch (I, from the rule).

Instruction-level reading (`0x464d22..0x464e0b`): the tier test is `jle` on (current target's
tier, A's tier), so equal tiers keep the old target. The current target's tier is read from the
object even when that target has died and the attack job has not run since (the reference of
3.6 keeps it): such a unit keeps its dead target's tier for the comparison until its next run
retargets.

**What is a player order** (job +8 = 1), C:

| set by | jobs marked |
|---|---|
| the right-click order (`00450bb0`, `0x45112e`) | every job it creates: attack, go-to, transport, harvest, builder, hunt, heal for a priest, arrest for a police officer, boarding |
| the move order (`00451170`, `0x451462`) | the follow-path job 0x06 that walks each selected unit to its cell (`004644a0` cancels the old job and makes this one current) |
| everything else (patrol button `00452790`, map orders, the dispatcher, AI routines, retaliation, retarget) | nothing; a retarget even clears the flag of a player-ordered attack (3.6) |

So a unit **walking under a move order neither retaliates nor flees** when it or a friend is hit;
the flag ends with the walk, and an idle unit standing at its goal reacts again. A guard or
patrol job is not a player order: a patrolling soldier answers the help rule with a top-level
attack (its guard job waits behind it, 7.4) and resumes the patrol afterwards.

### 7.3 Flee job (0x26) (C, ctor `0047d9a0`, run `0047da50`)

Fields: home cell (V's cell at creation), attacker A, "returning" flag.

1. If V or A is dead: success. This is tested on every run, also during the walks: if A dies
   while V runs away or walks home, V stops on the spot and the suspended job resumes from there.
2. With no child, compute d = distance (max + min/2) from V to A, using wrapped deltas.
   - If d ≥ **A's sight + 2**: success, the flee is over.
   - Otherwise walk to the point **A + (V - A) × (sight + 3) / d**. The direction is computed in
     float32 and truncated toward zero per axis. **Float in the simulation:** the rebuild should
     use (V - A) × (sight + 3) / d in integers and accept rare off-by-one cells (I).
     This walk is the flee job's **own** follow-path child. Its planning mask is V's
     **movement** mask 0x3E instead of 0x3C, so the escape route is planned around every unit
     (not only nearby ones, `units-and-jobs.md` 4.1).
3. When that walk ends (with any result): set "returning", start a walk back to the home cell
   (its own follow-path child, planning mask 0x3C), and return **50** (the unit waits 50 ticks
   first).
4. When the walk home ends (with any result): success. The suspended job resumes (7.4).

Every new strike on V creates another flee job in front of the previous one, so the chain can
grow (C). With a criminal attacker (sight 0), the porter runs to 3 cells away. Against soldiers
(sight 10) it runs to 13 cells.

### 7.4 Suspending and resuming the interrupted job (C, `00462e30`, `00464ce0`, base job destructor `00482210`)

**Suspending.** The flee (7.3) and the automatic attack of the retaliation rule (7.2) are put in
front of V's current job J the same way:

- J gets a 5-tick block (job +4 = 5) and becomes the new job's successor (+0x20). J stays in the
  scheduler: it is re-polled every 5 ticks but **not run**, so nothing in it changes.
- **J keeps all its children.** In the original a walk is not a property of the unit: it is a
  follow-path child job (0x06) of the job that wants it, holding its own **goal cell** (+0x45,
  +0x49, +0x4D), its remaining path, its plan counter and its search state. A transport holds its
  go-to child, which holds its walk; a builder holds its spot walk; a harvest holds its go-to or
  its delivery transport. The flee and the attack walk with **their own** children and never
  touch J's.

**Resuming.** When the flee or attack ends, its destructor makes J current again and clears J's
block. J runs at its next poll (at most 5 ticks later) and simply carries on with the child it
had:

- J's walk continues toward the goal it always had. If V is back on the cell where it was
  interrupted (the normal case after a flee, which ends with a walk home), the stored path still
  starts next to V and the walk goes on step by step.
- If V stands elsewhere (an attack, which does not walk back; a flee whose home walk ended short
  or was cut by the attacker's death), the stored path's next cell is not a neighbour, and the
  walk **ends at once without success** (`units-and-jobs.md` 4.1). What follows depends on J:

| interrupted job | what it does when resumed |
|---|---|
| transport 0x05, porter on the way to the source or the destination | its go-to ignores the walk result: it turns toward the building, asks to enter, and once admitted the enter job plans a fresh walk to the entrance (with its own 15 plans) and enters (`units-and-jobs.md` 4.2, 4.10). The delivery still happens |
| transport 0x05 while queueing at a door (enter job waiting in 10-tick polls) | asks again; the queue place was kept. A fleeing unit at the **head** of a queue keeps it blocked meanwhile, since only dead heads are dropped (`units-and-jobs.md` 4.4) |
| answer request 0x3C, leisure visit, any go-to into a building | the same as the transport |
| builder 0x0C working (phases 0, 1, 2, no child) | continues at once where it stands; there is no position check |
| builder 0x0C walking to the next spot (phase 3) | a walk that ends without success sends him to phase 4: walk to the door and end; a new builder request is filed if he was the last builder (`units-and-jobs.md` 6.4) |
| harvest 0x16 approaching (go-to) | the go-to succeeds for a nature target anyway; phase 1 then finds him not adjacent and walks him to a free cell next to the target (`units-and-jobs.md` 7.1, 4.8) |
| harvest 0x16 working (100-tick wait, no child) | the work run simply completes; the good is taken even if he now stands elsewhere *(I: no position check found)* |
| harvest 0x16 delivering (transport child) | as the transport |

So no interrupted job "believes it has arrived": a job knows it has arrived only through its own
child's end, and each resumed child either goes on walking or reports its end.

**Death while suspended.** Death cancels the unit's current job and clears object +0x30. When
that job (the flee or attack) is destroyed it is no longer current, so its successor J is
cancelled and unblocked, and destroyed at its next slot. J's destructor then runs as for any
early end: a transport re-files its requester's need (`units-and-jobs.md` 5.5), a builder leaves
the builder list and may re-file a builder request, an answer job re-files its worker request.

**Display note** *(I)*: a builder interrupted while his work animation runs keeps his "animation
on" flag; the flee's first step message stops the animation on screen, and on resuming phase 1
the start message is not sent again, so he works without the work animation until his next
relocation.

---

## 8. Guard and patrol (0x27), target choice, commands

### 8.1 Guard/patrol job (C, ctor `004809a0`, run `00480a10`)

- Up to **8 waypoints** (x, y, z) at +0x24..; index +0x84; count +0x88.
- At creation the count is 1 and waypoint 0 is the unit's own cell, so a fresh job is a
  **stationary guard**.

Each run:

1. Run the child, if any. If it finished and was a walk (0x06), advance the waypoint index
   **cyclically** (i + 1 mod count). The patrol loops A → B → C → A; it does not ping-pong.
2. If the child is not an attack: scan a circle of radius **sight + 1** around the unit. Choose a
   target (8.3) with "state 0/1 only" and **maximum tier 1**. Ordinary buildings (tier 2) and
   criminals are never picked by patrols.
   - If one is found: drop the current child and create an attack child (retarget on). Return 1.
3. If there is no child (nothing running): start a walk to the current waypoint and return
   **3**.

While walking, the scan repeats every step. A stationary guard, whose walks to its own cell end
at once, scans about every 3 ticks. After a fight the unit walks back to the current waypoint.

Run order in detail (C, `00480a10`): the child runs first and its return value is kept. If the
child is not an attack (a walk, or none), the scan follows. A find drops the child, creates the
attack child **without running it** and returns 1, so the attack's first run is one tick later.
Without a find, a running walk's return value (its step delay D, `units-and-jobs.md` 4.1) is the
guard's delay, so the scan comes once per step, D ticks apart, never in between. Only when there
is no child left (the walk or attack has just finished, or none existed) does the guard create the
walk to the current waypoint and return 3. While an attack child runs, its own delay is returned
and there is no scan.

### 8.2 How guard jobs come into being (C)

| source | effect |
|---|---|
| "Patrol" button (`00452790`) | only when **exactly one** unit is selected, it is a soldier (29..36) and it is not inside a building. Its job is cancelled and a guard job is created at its cell (delay 2) |
| waypoint clicks (`00452840`) | same selection condition; appends the clicked cell to the unit's current job while count < 8. The code assumes that job is the guard job |
| map load (`00411200`) | each soldier listed in the map's order records gets a guard job with waypoint 1 = the record's target cell, so it patrols between its start and that cell. First run after rand() % 5 + 1 ticks |

There is **no "hold position" command**. The unit command strings are "Nach Hause",
"Restaurieren", "Patrouillieren", "Stadt gründen" and "Abreißen" (`DV.tdb` 3..8). The only
similar string, `FESTABHALTEN`, is a town-panel graphic: "Fest abhalten", i.e. hold a festival
(`0041ae60`) (C).

A soldier fresh from the barracks has **no job**. It acts only through the help rule (7.1), or
after a patrol/guard order or an explicit attack order (C).

### 8.3 Area scan and target chooser (C, `0044a7c0`, `00464580`)

**Area scan:**

- covers cells with dx² + dy² < r² around the centre;
- returns the distinct units and buildings found (or only nature objects, in the second mode);
- in the original the result is a set ordered by **memory address**, so its iteration order is
  arbitrary. **The rebuild must define an order: ascending object id** (I).

**Chooser** (inputs: chooser unit C, candidate set, race filter, maximum tier T):

1. Skip candidates that are dead, fail 2.1 for C, or are type 28 (merchant) or 13 (diplomat).
2. Race filter -1: keep only races whose state with C's race is 0 or 1. Otherwise keep only
   candidates of the given race.
3. Tier gate: keep the candidate only if its tier ≤ T. **T then becomes this candidate's tier.**
4. Score the candidate. With R = C's raw weapon range and dist = torus distance from the
   candidate to C:

   | condition | score |
   |---|---|
   | base | 1 |
   | dist ≤ R + 2 | 2 instead of 1 |
   | dist ≤ R | + 2 |
   | candidate HP > C's weapon min damage | + 1 |
   | armed unit candidate, its max damage ≥ 151 and C's max ≥ 81 | + 3 |
   | otherwise, candidate max ≥ 71 and C's max ≥ 31 | + 2 |
   | otherwise, candidate max > 20 | + 1 |

5. Keep, per tier, the best score so far (strictly greater replaces). Each replacement becomes
   "the choice".

**Net effect:** the result is the **highest-scoring candidate of the lowest tier present**, and
the first one in iteration order wins ties. Once a tier-0 candidate has been seen, later tier-1
candidates are ignored. A tier-0 candidate that comes later still overrides an earlier tier-1
choice.

Confirmed at instruction level (`00464580`): the race filter -1 accepts a candidate only when the
pair has a relation entry with state 0 or 1 (no entry, i.e. the own race, falls through to the
"given race" test, which -1 never passes); the tier gate is `cmp tier, max; jg skip`; the score
uses the torus distance `00459a80` (max + min/2) between the candidate's stored cell and the
chooser's, the chooser's raw range (+0x14 of its weapon record), the candidate's HP (+0x44)
against the chooser's min (+0x0C), and the weapon bonus only for a candidate of category 0 that
is armed; the per-tier best is replaced only by a strictly greater score.

### 8.4 Automatic engagement: the complete rule table (C)

Every way an attack, a garrison shot or a fight reaction starts without a click. The attack job
(vtable 0x4A572C AN / 0x4B2780 Gold) is constructed at exactly these 12 places in each exe:
job factory for saved games (`00402dc0` / `004031c0`), right-click order (`00450bb0` /
`004567a0`), retaliation (`00464ce0` / `0046b210`), AI assault (`00466020` / `0046cbd0`), AI
skirmish (`00466e20` / `0046d9e0`), AI defence response (`0046d3a0` / `004766a0`), the attack
job's own destructor (`004720d0`), hunter (`00476930` / `00480360`), criminal (`004784d0`),
arrest (`0047b860`), guard (`00480a10` / `0048bce0`), heal (`00481180`). Gold adds no new one: the
naval planner and the ship jobs never create attacks.

| situation | who reacts, how | scan / radius | interval | eligible targets | diplomacy | chooser |
|---|---|---|---|---|---|---|
| idle unit (no job), enemy near | **nobody**: there is no idle scan in either exe | - | - | - | - | - |
| unit on a work job (porter, builder, harvester, hunter on its round, operator) | nobody, unless the help rule reaches it | - | - | - | - | - |
| unit walking a **move order**, or on any job of a right-click order | does not retaliate, does not flee (7.2 "player order") | - | - | - | - | - |
| unit that has just finished a move or an attack | idle: as "idle unit" | - | - | - | - | - |
| "hold position" / stand ground | does not exist (8.2) | - | - | - | - | - |
| friend of the same race struck (any unit or building of race V hit by another race) | every armed non-priest unit of V's race on the map within the circle, the victim itself included, through 7.2 | dx² + dy² < 144 around the victim | at every strike (the strike's fire step) | the attacker A (or the outpost it shoots from) | none (2.1 only: any other race) | - (fixed target A, subject to the tier and player-order tests of 7.2) |
| priest near a wounded victim | heal job (7.1) | same circle | at every strike | the victim | own race or peace | - |
| unarmed unit, priest or criminal struck | flee (7.3), unless on a player order | - | at every strike | - | - | - |
| target killed or lost (dead, inside a building) | the same attacker, if its attack has the retarget flag (player order, help, guard, AI) | circle of sight + 3 around the old target's last cell (the body) | at the attack's next run (≤ 5 ticks after the impact) | units and buildings of the **old target's race**, 2.1, no merchants or diplomats, all tiers | none | 8.3, all tiers |
| 6th path search for one target (target out of reach) | the same, as above | as above | - | as above | none | 8.3 |
| guard / patrol job (patrol button for one soldier 29..36 or warship 65/66; map orders) | the guard's attack child | circle of sight + 1 around the unit | every step while walking, about every 3 ticks when stationary, none while fighting | units and buildings with tier ≤ 1 (no ordinary buildings, no criminals), 2.1, no merchants or diplomats | state 0 or 1 only | 8.3 |
| outpost garrison | garrison-fire jobs (9.3) | disc of radius 15 / 25 around the outpost | every 20 ticks | **anything** of a race at state 0/1 except diplomats: civilians, merchants, buildings, sites | state 0 or 1 only | none: first in scan order in garrison range |
| computer town: intruder in its territory, or a unit attacking the town's race | defence group and free soldiers/hunters (`ai-diplomacy-trade.md` 2.2) | the town's territory, or the attacker wherever it stands | military job (every 50 ticks, alternating its two phases): a response every 100 ticks; the strike notification only records | hostile units by tier bucket, 3 defenders per intruder | state 0 or 1 | bucket by tier, list order |
| computer army near its target town | army members (`ai-diplomacy-trade.md` 2.5) | circle of radius 40 around the target town | every 50 ticks | the target town's race only (tier-0 bucket incl. one important building, or units) | army ends if not 0/1 | buckets, 6 or 3 per target |
| computer warship (gang of 1) | none: it wanders with job 0x28 and fights only through the help rule or retarget | - | - | - | - | - |

Notes:

- **Visibility plays no part** anywhere: the area scan (`0044a7c0`) takes no player and no fog
  test, so units in the black or grey fog are found and targeted by every row above.
- **Diplomacy**: only the guard, the outposts and the computer player's routines test the
  relation. The help rule and the retarget never do: a unit of a nation at peace that strikes
  (which itself causes war at the impact, 5.1) is answered at once, and a retarget picks any unit
  of the dead target's race.
- **Ships** follow the same rules: they are armed units of their race (help rule, retarget, patrol
  for 65/66). Their weapons and reach are in `addon.md` 7; a melee land unit never reaches a ship
  and gives up after its 5 searches (3.5, then 3.6).
- **Computer players' units** use exactly the same reactions (help, retarget, flee); their
  military and army jobs only add attack orders. A computer unit standing idle outside its
  territory next to enemies does nothing, the same as the player's.
- So two idle groups of hostile nations can stand next to each other indefinitely outside the
  computer player's territory and away from outposts, until one unit strikes. After the first
  strike the help rule pulls in every armed unit within 12 cells of each victim, and the retarget
  keeps each fighter on the enemy race after every kill.

---

## 9. Outposts and garrisons (0x1C, 0x1B)

Sources (GOG): may-enter `00460a10`, door request `00460d10`, "entered" `00460ed0`, put outside
`004613f0`, eject `00460be0`, outpost job constructor `00473820` / run `00473850`, garrison-fire
run `004736c0` (vtable 0x4A55C4), strike `00481450`, range test `004709b0`, map load `00411200`.
Gold `dvge.exe`: building vtable 0x4B232C (may-enter `00466cd0`, "entered" `004671b0`, put
outside `004676d0`) and outpost job `0047d310` behave identically for outposts. Display side:
`docs/rendering/objects.md` 13. Side panel: `docs/ui/side-panel.md` class 9.

### 9.1 Garrison buildings, capacity, who may enter (C; data D)

Only the two outposts (record class +0xC0 = 6) take a garrison, in every race and edition:

| race | building | size x × y | door | HP | capacity +0xDC | radius +0xB0 | garrison points (odb +0x54..) |
|---|---|---|---|---|---|---|---|
| Amazons | 52 Kl. Außenposten | 2 × 2 | (−1, +1) | 1000 | 2 | 15 | 2 |
| Amazons | 53 Gr. Außenposten | 2 × 2 | (−1, +1) | 1500 | 3 | 25 | 3 |
| Pimmons | 52 Kl. Außenposten | 2 × 2 | (+1, −1) | 600 | 2 | 15 | 5 |
| Pimmons | 53 Gr. Außenposten | 3 × 3 | (+1, −2) | 800 | 3 | 25 | 3 |
| Sajiki | 52 Kl. Außenposten | 2 × 3 | (+1, −1) | 600 | 2 | 15 | 3 |
| Sajiki | 53 Gr. Außenposten | 3 × 3 | (+1, −1) | 800 | 3 | 25 | 3 |

- The **watchtower** (60, "Spähturm") is not a garrison building: class −1, operator scout (24),
  capacity 0. It never shoots; it only gives vision radius 30 while its scout is inside
  (`fog-of-war.md`).
- The Gold edition and the add-on add no garrison building and no new garrison unit
  (`Addon.odb` holds no class-6 building and no class-2 unit; coastal defence is done by the base
  outposts, `addon.md`). The add-on reuses +0xDC as a ship's passenger capacity, in separate code.

**Who may enter** (may-enter test at the door, `units-and-jobs.md` 4.4). An outpost admits a unit
only when all of these hold:

- the unit's race (record group) is the building's race;
- the outpost is complete (a construction site admits only builders and units on a transport
  job);
- the unit's record class is **2** ("ranged unit");
- the outpost's occupant count (+0x5C) is below its capacity (+0xDC).

The class-2 units (the same four type numbers in every race):

| type | Amazons | Pimmons | Sajiki |
|---|---|---|---|
| 29 | Bogenschützin (bow, R 6) | Bogenschütze (bow, R 6) | Pyro (fire ball, R 6) |
| 32 | Mächtige Alchemistin (R 5) | Mächtiger Magier (R 5) | Beschwörer (R 5) |
| 33 | Alchemistin (R 5) | Magier (R 5) | Gottesanbeter (R 5) |
| 36 | Armbrustschützin (crossbow, R 8) | **Explodus** (bomb, range 0) | **Harak** (bomb, range 0) |

Everyone else is refused: the melee soldiers and riders (30, 31, 34, 35: swords, hammers,
catapult, cannon, Drachofiterus, Spitpack...), hunters, police, civilians, ships, and every unit
of another race (4.4 lets a foreign unit in only on a trade job or an operator errand, which never
lead to an outpost). The other admission rules of 4.4 (builder job, transport job, operator type,
visit flag, police) never apply to a finished outpost: it has no operator (+0xD8 = −1), no
resident places, no visit flag and needs no goods.

**Capacity is tested only once per unit, at its first request.** The door request runs the
may-enter test only on the enter job's first run (`00460d10`; the job clears its "first" flag
when it is told to wait). A unit already in the door queue is never tested again. So when
several archers reach the door before the first of them is inside, all of them get in and the
outpost holds **more than +0xDC** (C by reading; how often this happens in play is not known).
The display has a point for only some extra slots (objects.md 13.2).

**The order.** There is no special command. A right-click on an own completed outpost with units
selected gives every selected unit a go-to job (0x07) to the building (`units-and-jobs.md` 3.2,
row "other own building"). Each unit walks to the entrance, turns toward the anchor cell and asks
at the door (4.10). The selection is ignored entirely if it holds a criminal or a unit inside a
building.

**A unit that does not qualify** (wrong type, other race, outpost full at its first request,
outpost still a site) walks to the door, turns, asks once and is refused: the enter job fails,
the go-to job fails with it, and the unit stands idle in front of the door. There is no
message, no sound and no advisor line (C).

### 9.2 Entering

At the "entered" step (`units-and-jobs.md` 4.10 step 6) of an admitted class-2 unit (`00460ed0`):

1. The go-to job that brought the unit ends with the enter job's success (the "entered" step
   also sets a 10-tick block on the unit's current job, which does not matter here because that
   job is ending). **The unit inside has no job.**
2. The unit is appended to the occupant list (+0x58), in order of entering.
3. If the outpost has no building job, the **outpost job (0x1C) is created and first runs 20 ticks
   later.** A job that already runs is not restarted. (A finished outpost has no other building
   job, so this is always the outpost job.)
4. The "unit entered" message carries the **garrison flag 4**: the display attaches the unit to
   the building's garrison list instead of only hiding it (objects.md 13.1).
5. As for any entering unit: its index leaves its cell, its vision disc is removed
   (`fog-of-war.md`), and it cannot be targeted (3.2). It **keeps its stored position** (the cell
   it stood on when it entered, normally the entrance cell) and its **facing** (the go-to job's
   turn toward the anchor: 6 for door (−1, +1), 2 for (+1, −1), 3 for (+1, −2), `units-and-jobs.md`
   4.10).

**Map load** (`00411200`): for every outpost placed by the map, +0xDC units of **type 29** are
created **at the outpost's own cell** (its anchor), inside it, and run through the same "entered"
step (so the outpost job starts). Each gets a random facing rand() mod 8 (one rand() call per
unit, with a facing message) and joins the town (per-type list, population + 1).

**Computer towns** file one worker request for a type-29 unit per garrison place when an outpost
is completed (`004602d0`); their military job also sends archers of the defence group into
outposts with room (`ai-diplomacy-trade.md` 1.7, 2.2). Both go through the same door and
may-enter test.

### 9.3 Outpost job (0x1C) (C, `00473850`, every 20 ticks)

The job belongs to the outpost. It **never ends by itself**: every run returns 20, also when no
target was found or no soldier is idle. It is cancelled only when the last class-2 unit is put
outside (9.8) or when the outpost collapses (10.3).

Each run:

1. **Collect idle soldiers**: walk the occupant list in order and take every occupant of type
   29..36 (this is every class-2 unit) whose current job is **not** a garrison-fire job. If such
   an occupant has any other job (for example an idle-turn job from the fidget command), that job
   is cancelled first. This never ejects the unit.
2. If none were collected: return 20.
3. **Scan** once: all units and buildings on the map within the disc dx² + dy² < r², r = outpost
   +0xB0 (15 small, 25 large), around the outpost's anchor cell (8.3; rebuild order: ascending
   object id). Units inside buildings are not on the map and are never found.
4. For each collected soldier, in occupant order, walk the candidate list from its start:
   - a candidate whose race has a relation state with the soldier's race other than 0 (no
     contact) or 1 (war) is **removed from the list for good**. This removes the own race (no
     relation entry), ceasefire and peace races. A **diplomat** (13) is removed too;
   - nothing else is filtered: no "may act on" test (2.1), no tier, no score. **Merchants (28),
     porters, criminals, every enemy building and construction site** are valid targets;
   - the first remaining candidate that is in **garrison range from the outpost's anchor cell**
     (9.5) gets a **garrison-fire job** (0x1B) for this soldier: owner the soldier, holding the
     outpost's id, the range bonus E and the target. It becomes the soldier's current job and
     first runs **1 tick** later. Go to the next soldier, again from the start of the list;
   - a soldier for whom no candidate is in range stays idle until the next run.
5. Return 20.

So all soldiers of a garrison usually shoot at the **same** target, the first one in scan order,
not the nearest or the weakest.

### 9.4 Territory

Outposts broadcast their territory (radius +0xB0) on completion and withdraw it on destruction
(message (0x55,24) with the radius, `0045f5a0`; rules in `economy.md` 11). In combat, territory is read only by the AI
alert (7) (C).

### 9.5 Garrison range (C, `004709b0` called with a building id)

The garrison uses a variant of 3.4. With R = the soldier's weapon range:

- **Bonus** E = trunc(1.5 × R) (a float product in the original, exactly R × 3 / 2 in integers):
  R 5 → 7, R 6 → 9, R 8 → 12.
- **Ranged weapons** (R > 0):
  1. quick reject: the distance (max + min/2) from the target footprint's centre to the origin
     must be ≤ **3E** (the code takes max(2R, 2E) + E, which is 3E for every R ≥ 1);
  2. line of fire: the same Bresenham walk as 3.4 from the origin toward the footprint centre,
     ending when it reaches the target, but:
     - **buildings never block**, the outpost's own cells included;
     - the **origin cell is charged** like every other cell (2), it is not free as in 3.4;
     - straight step 2, diagonal step 3, ±1 for height steps of 32 or more, as in 3.4;
  3. in range when the total is **< 3E + floor(e/2)** (e = max(size_x, size_y) − 1 of the
     target, 0 for a unit).
- **Range-0 weapons** (Explodus, Harak): the plain melee test of 3.4: the origin cell must lie
  in the target's footprint grown by one cell. E is 0.

Reach against a unit on flat open ground. The origin cell counts, so the straight reach is
floor((3E − 1) / 2) cells and the diagonal reach is E cells:

| weapon | R | E | straight | diagonal |
|---|---|---|---|---|
| alchemists, mages, Beschwörer, Gottesanbeter | 5 | 7 | 10 | 7 |
| archers, Pyro | 6 | 9 | 13 | 9 |
| Armbrustschützin | 8 | 12 | 17 | 12 |
| Explodus, Harak | 0 | 0 | adjacent | adjacent |

The scan disc limits this further: the small outpost (r 15) finds nothing beyond 14 cells
straight or 10 diagonal, the large one (r 25) nothing beyond 24 / 17. A crossbow in a small
outpost therefore reaches 14 / 10, everything else in the table fits inside the disc. Building
targets add floor(e/2) and are measured to their footprint. For comparison, the same archer on the
ground reaches 6 / 4 (3.4): a tower roughly doubles the reach and ignores buildings in the way.
The exact endpoint rule of the walk is as uncertain as in 3.4 (18.2): one cell at the very edge
may differ.

### 9.6 Garrison-fire job (0x1B) (C, `004736c0`)

Each run:

1. **Target dead** (its alive flag is the only test): the job ends with success. A target that
   has gone into a building is still "alive" and keeps being shot while in range (I: rare, the
   scan never picks units inside, only a running job keeps one).
2. **Range**: the same garrison test (9.5), but from the **soldier's own stored cell**, not the
   outpost's anchor. For a unit that walked in that is the cell it entered from (normally the
   entrance); for a map-load garrison it is the anchor.
   - **Out of range**: the job ends (no shot). The soldier is idle again and the next outpost run,
     up to 20 ticks later, re-targets.
   - **In range, no strike child yet**: create a strike child (0x09) on the target and return 1.
   - **In range with a strike child**: run it. A non-zero result is returned as this job's
     delay. A zero result (the target died) drops the child and returns 1; the next run then ends
     the job at step 1.

**Quirk** (C by reading): the outpost job tests from the anchor, this job from the stored cell.
A target that is in range of the anchor but not of the entrance gets a new fire job every
20 ticks that ends on its first run without a shot. At the outer edge, a walked-in garrison
therefore never fires at some targets that a map-load garrison would hit. The entrance is next to
the footprint, so this concerns roughly the last cell of reach on the far side.

### 9.7 The shot from the tower (strike job 4.1 with a garrisoned shooter)

The strike child is the normal strike job (4.1). Its differences for a shooter inside a building:

- **Facing origin = the outpost's anchor cell.** The soldier turns toward the target from there,
  **one 45° step per run, 2 ticks each** (floor(step_time[0] / 2)), and each step sends the facing
  message, so the unit on the tower visibly turns (objects.md 13.2). Only then does it fire.
- **Aim corner and flight time f** are measured from the soldier's **stored cell** (the entrance
  cell, or the anchor for a map-load garrison), not from the anchor.
- Cooldown, jitter, strike action (`ST` once), sound frame, impact delay, hit roll (weapon hit%:
  95 % for archers, crossbows, alchemists, mages and fire balls), damage, rank multiplier and
  experience (5.3) are exactly as on the ground. **There is no tower bonus to damage or hit
  chance** and no armour.
- The victim notification (7) names the soldier; the help rule substitutes the building as the
  attacker (7), so the victim's friends attack the outpost.
- On screen the projectile starts at the outpost's cell, lifted to the shooter's launch point on
  the tower (`docs/rendering/projectiles.md` 2.6, objects.md 13.4).
- **Bomb carriers** (Explodus, Harak) in a tower blow up when an enemy is adjacent both to the
  anchor (the scan) and to the carrier's stored cell (the fire job): the target takes 400..800 at
  100 % and the carrier dies inside the outpost (5.2, 10.1) (C by reading of the path; I: never
  seen in game).

Timing example: an archer that has been idle in a tower gets its fire job up to 20 ticks after an
enemy comes into reach (+1 tick), turns (0..4 steps of 2 ticks), fires at once if its cooldown
has elapsed, and then every 36..53 ticks (4.2). After a kill the next target is taken up to
about 25 ticks later: the strike child notices the death at its next poll (at most 5 ticks), the
fire job ends one tick after that, and the next outpost run comes within 20 ticks.

### 9.8 How long the garrison stays, and what makes it leave

A garrison stays **indefinitely**. Nothing in the outpost job, the fire job or the strike job
ejects a unit, and a unit inside has no job of its own that could end. The only ways out:

| cause | what happens |
|---|---|
| the player's send-out (inhabitants page, command 0x3A) | the first occupant of the clicked type is ejected (`units-and-jobs.md` 4.11) |
| the outpost collapses (destroyed, demolished, town destroyed) | phase 1 cancels the outpost job and ejects every occupant with a leave job (10.3); they come out alive and idle |
| a new job given through the general job assignment (`00465650`, `units-and-jobs.md` 1.2) | the unit is ejected first and the job waits behind the leave job. The dispatcher never does this to a garrison (units inside are never free, 5.4); the AI strategy routines (`00466020`, `00466e20`, `0046d3a0`) may, for computer towns (I: AI spec) |
| the unit dies | only through its own bomb (9.7): garrison units cannot be targeted |

Not causes: the outpost job's cancelling of other jobs (it only clears the job), the idle fidget
command (`units-and-jobs.md` 4.9: a turn job at most, no eject; garrison units are not in the
display's drawn list anyway, objects.md 13.2), player orders (units inside cannot be selected,
and a selection that holds one is ignored), damage to the outpost, hunger or housing (no such
rule exists).

When the last class-2 unit is **put outside** (`004613f0`, at placement, not at the eject) and
the occupant list is empty, the outpost job is cancelled. A unit that leaves is idle at the door
(facing 3 or 5) and is never sent back in automatically, except by a computer town's military
job.

### 9.9 Damage and collapse

- Hits on the outpost do nothing to the garrison; it keeps shooting until the outpost dies.
  Outposts are tier-0 targets (1.3), so enemy patrols and retaliation pick them before ordinary
  buildings. A builder can repair an outpost like any building (builders never enter, 4.4).
- **Collapse** (10.3): the outpost job is cancelled with the building job, every occupant is
  ejected in occupant order (they appear 20..35 ticks later, about 5 ticks apart), and the
  collapse animation waits until all of them are outside. They stay drawn on the tower until they
  are placed (objects.md 13.1). They are not hurt.

### 9.10 Our build (implemented October 2026)

`src/engine/logistics.ts` (`mayEnter`, `enter`, `entered`, `putOutside`, `goInto`, `complete`),
`src/engine/combat.ts` (`startOutpost`, `runOutpost`, `runGarrisonFire`, `inRange`,
`garrisonBonus`, `strike`, `attacked`, `collapse`), `src/engine/world.ts` (map load),
`src/engine/ai-town.ts` (`defenceTargets`), `src/client/garrison.ts`, `main.ts`, `effects.ts`;
tests in `test/garrison.test.ts`. The thirteen deviations listed here before are fixed:

- the may-enter test at the first request only (class 2, same race, finished outpost, occupants
  below +0xDC; a site admits only units on a transport job); a refused unit's go-to fails and it
  stands idle at the door, not queued, the door never opens; units queued before the outpost is
  full all get in (quirk of 9.1);
- "entered" keeps a class-2 unit in its outpost with no job and starts the outpost job 20 ticks
  later if it is not running; nothing ejects a garrison except send-out and collapse;
- the outpost job returns 20 forever, cancels any other job of an idle soldier in every run, and
  is cancelled only by a collapse or when the unit put outside is class 2 and the occupant list is
  empty;
- garrison range: E = R × 3 / 2, budget 3E, the origin cell charged, buildings never block,
  range-0 weapons adjacent only; the fire job tests from the soldier's stored cell (quirk of
  9.6), ends only on a dead target or out of range, creates its strike child on the first
  in-range run (returns 1) and runs it from the next;
- the strike turns 45° per 2 ticks measured from the anchor, aims and times the flight from the
  stored cell; the help rule names the outpost, the victim notification the soldier;
- map load: the archers are created on the outpost's anchor cell, facing rand() mod 8;
- a collapse ejects the occupants in occupant (entering) order;
- computer towns: archer requests on completion and the military job's refill
  (`docs/architecture/integration-ai.md` item 5);
- display: `objects.md` 13.5, `projectiles.md` 7.

Remaining differences:

1. A soldier sent out while its fire job runs: the original queues that job behind the leave job
   and resumes it outside (4.10); what it does there was not traced. Ours resumes it too, but the
   job ends at once because the unit is no longer inside its outpost.
2. No snapshot change was needed: the garrison is the occupant list (units inside, entry
   sequence), the fire job's child flag is its fourth data word (absent in older saves = no child
   yet).

---

## 10. Death and destruction

Every object has a die method (vtable slot 1). It is called when HP drops below 1 (5.2), by bomb
carriers, by town destruction and by demolition.

### 10.1 Unit death (C, `004641d0` then `00462430`)

1. Leave the home house (`00461690`): the house slot is freed.
2. Leave the building it is inside, if any.
3. Kill every still-alive object in the unit's attached list (+0x54/+0x58). U: which units own
   such objects.
4. Town bookkeeping:
   - removed from the town's per-type list;
   - town +0x48 - 1;
   - **population (+0x44) - 1**;
   - needs re-evaluated (`0045a2c0`).
5. Base death:
   - alive = 0;
   - removed from every player's selection;
   - the display gets "object died" (0x1E,9), which starts the death effect (6);
   - its current job is cancelled.

   The object is freed when its last reference goes. Pending impacts keep references.

Nothing else happens: no loot and no mentor line.

### 10.2 Nature and animal death (C, `00463b10`)

- **A living animal** is not removed:
  - its wander job is cancelled and the living flag (+0x4C) is cleared;
  - its display stage becomes 4 (carcass) and a death cry plays (sound 61 for the hare, type 37;
    62 otherwise);
  - the carcass stays as a food object that the hunter then harvests (14).
- Any other nature object gets the base death (removed).

### 10.3 Building destruction: two phases (C, `0045f5a0`, job 0x25 `0047bbc0`/`0047bd60`)

**Phase 1** (the first call):

1. Alive = 0. The building can no longer be targeted.
2. **Rubble amount** S:
   - completed building: S = its stone cost (rec cost[2]). Deactivate it (`0045ff30`: upkeep,
     storage capacity and stock scaling, need thresholds, see economy.md). Collapse stage k = 9;
   - construction site: S = stone cost - stone still owed + stone lying in the site's local
     stock, i.e. the stone already used or delivered. k = the construction stage
     (T - R) × 10 / T;
   - town-hall site: k = 0.
3. Cancel the building's job and give the building a **collapse job (0x25)**:
   - it sends (0x49,7) with k (the display shows the construction picture `BU0` at that stage
     and plays the collapse sound, 10.3.1);
   - it **ejects every occupant** (each gets a leave job). Garrisons, operators and visitors
     come out alive.
4. Schedule the collapse job after 0 ticks. A branch exists that would use a random stagger of
   rand() % (5 × (buildings + sites)) when the town is "collapsing", but its condition can never
   be true, so the delay is always 0 and no rand() is consumed (C, from the machine code).

**Collapse job runs:**

- while ejected occupants are still on their leave job: return 10;
- then, k times: send (0x4A,5), the collapse animation step, and return 1;
- then call the building's die method again, which is phase 2, and end.

A completed building (k = 9) therefore disappears about 10 ticks after its last occupant has
left, plus 10-tick waits while occupants are still walking out.

**Phase 2:**

1. If the town is alive: mentor#80 ("building was demolished") at the building's cell. It is
   queued, with no interval. The same line is used for every cause: demolition, combat losses,
   bombs, decay and a cancelled founding. Demolition says it **only here**, at the end of the
   collapse, and not when the button is pressed (`docs/ui/side-panel.md` 1.1.3).
2. **Residents become homeless**: each living resident loses its home and is added to the town's
   homeless list (+0x4E0). Rehousing follows economy.md 3.3.
3. Removed from the town's per-type list. Building count - 1, or site count - 1.
4. **Town hall (type 40): the whole town is destroyed** (10.4).
5. Base death (display "died" message), then the territory-withdraw message (9.4).
6. **Rubble** (nature type 38), for S > 0:
   - per-cell share a = S / (size_x × size_y); if a < 3, a = min(S, 3);
   - walk the footprint cells (x from the max corner downward, inner loop y) while stone
     remains;
   - each cell gets a rubble object with remaining = min(a, rest), shown full-size max(that, 3)
     (4 or more: itself);
   - if the town is alive, a **priority-3 pickup request** is filed for each pile, so porters
     carry the stone home automatically (`units-and-jobs.md` 5.1);
   - stone left over after all cells only enlarges the last pile's display maximum (a quirk,
     C).

   Example: a Pimmon small house (2×2, 5 stone) leaves 2 piles of 3 and 2 stone. A warehouse
   (2×2, 8 stone) leaves piles of 3, 3 and 2. The town hall costs nothing, so it leaves no
   rubble.

#### 10.3.1 Picture and sound of a collapse (C, display handlers `00457aa0`, `00457c90`, `00456770` → `00434840`)

The same sequence runs for every way a building or site dies: destroyed in combat, demolished
with `ABREISSEN` (`00451ec0` calls the same die method, for sites too), cancelled founding (11.6
of units-and-jobs), town destruction (10.4), decay.

| moment | simulation | display |
|---|---|---|
| phase 1 (tick D) | collapse job created; message (0x49) with stage k | the building switches to its **construction picture `BU0`** (action 0) at frame k mod frame count (the finished `MS0` with its door and layers is no longer shown). **Sound: `Sfx_053.wav`, once** (fixed sample, table entry 52), only if the building is in this frame's drawn list, positioned in 3-D from its screen point like every world sound (x, y relative to the view centre × 0.5, depth from the zoom) |
| each collapse step | message (0x4A), one per tick | `BU0` frame − 1 (wrapping) |
| phase 2 | base death (0x1E), rubble objects created | the building is taken off its cells and the drawn list. **No sound, no effect**: the death effect of `00434840` exists only for units (6). The rubble piles (nature type 38) appear as ordinary new objects on the footprint cells |

- k = 9 for a completed building, the construction stage (T − R) × 10 / T for a site, 0 for a
  town-hall site. So a completed building plays its construction frames backwards, 9 → 0, one
  frame per tick (about 1 s at normal speed), then vanishes; a site starts from the stage it had
  reached; a town-hall site shows frame 0 and vanishes on the job's first run.
- With occupants inside, the frames wait: the job polls every 10 ticks until none of the ejected
  units is still on its leave job (they come out 20..35 ticks after the eject,
  `units-and-jobs.md` 4.10). Example, completed building with occupants: frame 9 and the sound
  at D; frames 8 .. 0 at about D + 20 .. D + 28; gone at D + 29.
- There is **no dust or debris effect** and no second sound. The sound is the only audible part,
  and it plays only if the building is on screen at the moment of phase 1 (a building in the fog
  or off screen collapses silently).
- The sample is addressed directly, not through a record field, so it is the same for every
  race and building type, and for sites. In record-sound numbering (record sound n = file n,
  `docs/rendering/unit-motion.md` 5) it is **sound 53**.

**Our build** (`src/engine/combat.ts collapse`/`runCollapse`, `src/client/effects.ts`): phase 1
emits a `'collapse'` effect (sound 53) at the building's anchor; the client plays `Sfx_053.wav`
once if that cell is on screen and not fogged (an approximation of "in the drawn list"). The
collapse job polls every 10 ticks while an ejected occupant is still on its leave job; occupants
already on their way out keep their leave job.

### 10.4 Town destruction (C, town vtable slot 0 = `00459400`)

1. The town is removed from its nation. mentor#21 ("a town was destroyed") goes to the owner.
   Message (0x4C,7). Town alive = 0.
2. Find the **nearest other town** of the same nation that still has a town hall.
3. Every unit of the town has its job cancelled, then:
   - if another town exists: it moves to that town and is put on its **homeless list**. The
     receiving town's small and large houses then take in homeless up to their capacity;
   - if not: **it dies**.
4. Every remaining building of the town dies (phase 1 → collapse → phase 2, with no mentor line
   and no rubble pickup, because the town is dead).
5. If the nation has no towns left, it is **defeated** (`0045d2a0`):
   - every other nation's advisor gets mentor#(23 + race) ("the X were defeated");
   - its jobs are cancelled and the nation is marked dead;
   - a human nation gets its game-over handling (`0044fc20`, U).
6. If the destroyed town was the nation's current town, the first remaining town takes over
   (message 0x41).

---

## 11. Diplomacy effects (C)

- Being hit by another race at ceasefire (2) or peace (3) sets the pair to **war (1)** on the
  first impact (5.1).
  - Side effect of leaving peace: market trade between the pair is switched off (flag call
    (0x30,0), `004583f0`; meaning I, consistent with mdb.md).
  - Leaving ceasefire changes no flag.
- **Quirk:** a priest healing a unit of a race at peace goes through the same impact job, so it
  also declares war (C). This is probably an original bug. The rebuild should reproduce it only
  if exact fidelity is wanted, and say so in its own docs.
- The 120-s advisor lines (#20, #22) are UI-only.
- No combat code reads ceasefire specially. It behaves like peace, except that leaving it does
  not touch the trade flag.

---

## 12. Crime and police

### 12.1 Criminal job (0x17) (C, `004784d0`; created with the criminal, first run after 50 ticks, `00463d00`)

Each run:

1. With no child: if the criminal's town has at least one porter, pick **porter number
   rand() % count** in the town's porter list order. Start an attack child on it: no retarget,
   anchor = the porter's cell. Remember the porter's HP at that moment.
2. Run the child (in the same run in which it was created, too). **Stop** when, tested
   **after** that child run:
   - the child ends (porter dead or inside a building, out of the 29-cell leash, or the 6th
     search: the criminal's attack has no retarget, 3.6); or
   - the porter has lost **10 or more HP** since this assault began (HP at the start minus HP
     now > 9).

   Stopping drops the child (and with it the walk). The job returns **50**: the criminal stands
   still for 50 ticks and then picks again. Otherwise the job returns the child's own delay.
   Because the HP test comes after the child run, a child run that starts a new strike in the
   same poll in which the loss reaches 10 still lets that strike land (its impact job is
   independent of the attack).
3. With no porter in the town: wait 50 ticks.

**Re-checked in the machine code (October 2026)**, after a report that criminals in the original
pause much longer and kill far fewer porters. Every branch of this rule was confirmed at
instruction level, and none of it depends on the difficulty, the research level, the game time,
the number of criminals or the police:

- the job (`004784d0`): `4784e8` the default return 50; `478503`/`478518` the pick
  `rand() % porter count` (town +0x128), walked from the list head (+0x124) at `47851a`..`478529`;
  `47852b`..`4785c4` the child is a plain attack job (vtable 0x4A572C, whose slot 1 is the run
  `00472b20`) with retarget byte +0x44 = 0, search count 0, anchor = the porter's cell;
  `4785db` the start HP; `4785e7` the child's run; `4785ea` a child result of 0 stops;
  `4785f1`..`4785fd` stop when start HP − HP ≥ 10; `47860c`/`478613` stop: child destroyed,
  return 50. The job object is 0x28 bytes: nothing else is stored (no timer, no victim memory);
- the job is created with the criminal (`463e5b`: record type 12; first run 50 ticks), also for
  a criminal born inside a house: the eject (`00460be0`, `460c83`..`460ca3`) chains the criminal
  job behind the leave job, it is not lost;
- the child's strike cadence (`00481450`): the cooldown test against the scheduler tick
  (`48174b`..`48176d`; the global at 0x4B3780 is advanced once per scheduler tick at `482dfa`),
  the jitter `rand() % (cooldown / 2 + 1) + 1` (`481b75`..`481b94`), the poll of at most 5 ticks
  (`481b98`..`481bc7`);
- the victim's reaction (`00462e30`, `462edb`..`462f6b`): an unarmed unit, a priest or a criminal
  whose current job is not a player order gets the flee job (first run 3 ticks later); porters on
  a transport flee too;
- the flee distance comes from the **attacker's** sight (`47dcd3`..`47dce8`, record +0xB0), 0 for
  every criminal, so a porter runs to 3 cells from the criminal and then stands 50 ticks
  (`47db37`) before walking home: the criminal usually catches it standing;
- no regeneration: no code raises a unit's HP except the heal impact (all writes to +0x44 in the
  simulation were checked: object constructors, construction and repair of buildings, the heal
  routines, the retype in `00464840`).

The rhythm in 12.7 therefore is the original's. What differs from game to game is only how many
porters a town has and where they are (a pick on a porter inside a building costs the criminal
just the 50 ticks), and whether a police officer stands outside within 12 cells of the victim
(7.1: the help rule sends him after the criminal unless he is on a player order; soldiers may not
act on an own criminal, 2.1).

The porter list is the town's per-type list (town +0x124, count +0x128). It holds **every**
porter whose home town this is, also those inside buildings, so the random pick often lands on
a porter in a house, the warehouse or a workshop. Such an assault ends at the child's first run
(target inside) and costs the criminal just the 50-tick wait. There is **no** distance limit
on the pick (any porter of the town, however far), no "nearest", no search radius, no
preference for porters that carry goods.

What the criminal job does **not** do (C, by the absence of any other branch in `004784d0`):

- no robbing: no goods or money change hands. The victim keeps its load (only an *attacker*
  that carries goods drops it when it strikes, 4.1 step 2, and a criminal never carries any);
- no wandering: between assaults the criminal stands where the last assault ended;
- no attacks on anything but its own town's porters (2.1), and no reaction to foreigners (a
  criminal never helps, 7.1, and is never helped by its own race);
- no special reaction to police: like a porter, it only **flees** (7.3) after each blow it
  receives, as long as it is not on a player order (a criminal never is, 12.6).

**Effects:**

- Knife 1..5 (mean 3), 100%, cooldown 25, so one strike every 26..38 ticks (4.2). Reaching the
  10-HP stop takes 2..10 hits, about 3.8 on average, i.e. roughly 100..130 ticks of striking
  once adjacent. A fleeing porter (7.3) is rarely kept adjacent that long: the chase re-plans
  after every flight, and the 6th search ends the assault. In practice most assaults end that
  way after one or two hits (12.7).
- Each hit makes the porter **flee** (7.3) unless it is on a player order.
- A porter is never killed in one assault. It can die over repeated assaults: there is no
  natural regeneration, and only priests heal (C, by absence).
- No help rule fires (same race), and criminals gain no experience.

### 12.2 Police station dispatch (C, operator job `00478cb0` case 21, every 50 ticks)

For each criminal of the town that is alive and outside buildings (re-checked at instruction level,
`478eab`..`478f54`: the town's type-12 list, alive byte, +0x6C = 0):

- find the police officer among the station's occupants (type 21);
- if there is one: cancel its job and give it an **arrest job** (0x18) bound to this station.
  Like the manual order, the job gets no criminal (`478f2e`: `0047b770(officer, station)`); it
  picks from the list itself (12.3).

After the loop, a created job is scheduled (1 tick) and the officer is **ejected** with the plain
eject, and the operator job ends. He stays the station's **stored operator**: the station stays
**active** while he hunts (no deactivation at placement, `units-and-jobs.md` 4.10 step 4 and 8.5;
the panel still reads T174 "Anwesend"). When he walks back in, the entry starts a new operator job
(first run after 100 ticks). If the arrest job is destroyed under way (a player order, a move, go
home, `DEAKTIVIEREN`, or his death), the station loses him and is deactivated; only his death
files a worker request for a new officer (`units-and-jobs.md` 8.5).

### 12.3 Arrest job (0x18) (C, ctor `0047b770`, run `0047b860`)

Fields: current criminal, station (may be 0), "returning" flag.

1. With no child:
   - take the **first** criminal in the criminal list (town +0x144) of the **officer's home
     town** that is alive and not already being escorted (job 0x19);
   - if the list holds more than one, move that criminal to the end of the list, so that several
     officers spread out;
   - attack it (attack child, no retarget, anchor = its cell);
   - if there is none left: walk back into the station (go-to job, "returning"), or end if there
     is no station.
2. Each run with a child runs the child first (`47ba28`). If it did not end and the job has a
   station and the child is not the walk home: when the criminal's HP is **≤ 80% of its
   maximum** (`47ba8e`..`47bab6`: HP ≤ trunc(max × 80 / 100), ≤ 40 of 50), **arrest**:
   - the criminal's current job is cancelled; the flee job and the chained criminal job are
     both discarded;
   - it gets an **escort job** (0x19) towards this station (1 tick);
   - the job forgets its criminal, the attack child is dropped, and the job returns the
     child's delay; its next run picks the next criminal (`47bb19`..`47bb42`). A strike the child
     started in this run still lands (its impact job is independent).
   Otherwise the job returns the child's delay.
3. When the attack child ends (criminal dead, or the chase failed: leash, 6th search, target
   inside a building): the child is dropped; the job **forgets its criminal only if it is dead**
   (`47ba40`..`47ba62`); it runs again **1 tick** later and picks anew (step 1). When the walk
   home ends: end.
4. The pick of step 1 overwrites the criminal only when it finds one (`47b8cf`). When the list
   holds no free criminal, a criminal kept from step 3 (alive, e.g. now led to a jail by another
   officer, or released as a porter) is attacked again (`47b910`); only with none kept does the
   job walk home or end. *Our build (October 2026): `runArrest` keeps the criminal after a failed
   chase and runs the arrest test after the child, as above; test `test/crime.test.ts`.*

**The criminal list** (C, town per-type list for type 12, `economy.md` 2.2: +0xB4 + 12 x 12 = +0x144):
every criminal whose home town this is, in the order in which they joined the town (a new
criminal, born or placed by the mission, is appended at the end), including criminals inside a
building and criminals being jailed (the scan above skips those with an escort job, not those
inside). A dead criminal is removed (10.1); a criminal retyped to a porter (12.4) moves to the
porter list. The only other change of order is the move to the end in step 1, which happens at
every pick while the list holds two or more criminals (counting the escorted ones). Inside
criminals are picked too; their attack child then ends at its first run (3.2) and the next pick
comes one tick later (rare: in practice only a criminal born inside a house that is still on its
way out, `units-and-jobs.md` 4.10).

**Manual orders** (C, `00450bb0` → `0047b770` with station 0, then `0047b860`). Right-clicking one
of your own criminals with a police officer cancels the officer's current job and creates an
arrest job **without a station**, scheduled after 1 tick and marked as a player order
(job+8 = 1). The clicked criminal is **not** passed to the job (its target field starts at 0).

Re-checked at instruction level (October 2026), because players remember the officer sticking to
the clicked criminal: the client marks the order "target is own" (command byte +0x0F = 1 for own
units and buildings, `00441440` `4416da`/`44174f`); with that byte set the simulation skips the
armed-unit branch that would make a plain attack (0x08) on the clicked unit (`450d9c` →
`450eb0`), reaches the police test (`45101b`: officer type 21, target type 12) and calls
`0047b770(officer, 0)` (`45104a`). The constructor stores station 0, criminal 0, "returning" 0
(`47b783`..`47b793`), and the base job constructor (`004821c0`) copies nothing from the unit.
The Gold Edition's handler (`004567a0`) has the same branches. There is no visibility or fog test
anywhere in the arrest or attack job. (A police officer clicking a **foreign** criminal gets byte
0 and so a plain attack job on exactly that criminal, with retarget, `units-and-jobs.md` 3.2.)

That job:

- **ignores which criminal was clicked**: at its first run it takes the first free criminal of
  the officer's home town's list (step 1) and, when the list holds two or more, moves it to the
  end of the list;
- is **re-created by every order**: the "same target already running" test of
  `units-and-jobs.md` 3.2 does not apply (an arrest job has no target), so each right-click
  starts a new job, which picks the then-first criminal. Because the previous pick was moved to
  the end, repeated orders **cycle through the criminals**: with criminals A and B (A older), the
  first order chases A (the list is now B, A); a second order, on whichever criminal, chases B
  (list A, B); a third chases A again. To the player this looks as if a second click on B
  switches the officer to B; a first click on B with a fresh list still chases A;
- after the chased criminal dies, or the chase fails (29-cell leash or 6th path search, 3.3 and
  3.6: the child has no retarget), takes the next first free criminal of the list one tick later,
  again rotating it. **This is why the officer seems to switch at random.** Each blow makes the
  criminal flee to the officer's sight + 3 = **8 cells** (7.3); a target that keeps walking
  makes the stored plan stale at every step, so the 6th search comes after about five steps
  (3.3.1) and the chase fails, typically 40..80 ticks after a blow. With one criminal the next
  pick is the same one and the chase simply goes on; with two or more the pick after each failure
  is the *other* one (it was rotated to the front), so the officer alternates between them and
  rarely finishes either. Measured in our build (no station, mission 0, the officer 4 cells
  away): one criminal is dead after 756 ticks with no switch; with two, the target changes 36
  times before the first of them dies at tick 2 347; with three, 41 changes in 3 000 ticks;
- **never arrests**, because the 80% rule needs a station, also when the town has a police
  station: the officer beats criminals **to death**, one after another. When no free criminal is
  left the job ends and the officer stands idle where he is (no walk back, there is no station).
  This is how a player gets rid of criminals before having a police station: officers are
  trained in the school (Writing and Law, `rules-from-manual.md` 6 and 9) without one, and only the
  station's dispatch (12.2) produces arrests and porters (12.4);
- is a player order for the officer (job+8 = 1): no flight (7.3) when hit. The criminal flees
  after each blow (it is never on a player order);
- given to an officer who is out on the station's own arrest job destroys that job under way, so
  the station loses its operator and is deactivated (`units-and-jobs.md` 8.5); he then hunts as a
  station-less officer. Ordered back into the station, he activates it again.

*Our build* (re-checked October 2026: the manual order, the pick and the rotation are the
original's; a change to make the officer keep the clicked criminal would be a deviation): the town keeps its criminal list as `Town.criminals` (ids in list
order, saved and hashed, snapshot version 10). A criminal not yet in it is appended in creation
order when the list is read, which is the order of joining; the dead and the retyped drop out
there. Older saves start with an empty list, i.e. creation order, the order the build used
before. Before this fix the arrest job always took the oldest criminal and never rotated, so
repeated orders never switched to another criminal. Code: `combat.ts` `criminalList`,
`pickCriminal`, `runArrest`; tests `test/crime.test.ts`.

The handbook says a manually sent officer "is attacked by" the criminal. In the code the
criminal **flees** (7.3) and never fights back: same race, so no help rule (C, discrepancy
noted).

**Status text and sound** (C, `0047bb60`, `00455d50`; details in
`docs/rendering/unit-motion.md` 5 and 6):

- While the arrest job is the officer's current job, the unit panel reads **T271 "Jagt
  Kriminellen"**. That covers all of it: choosing a criminal, chasing, striking and walking back
  to the station. The panel shows the top-level job's text, not the attack child's T262. Inside
  the station without a job it reads T280 "Ist in Gebäude: %s".
- Each strike (4.1) sends the strike animation (action 1, `ST`) with the record's sound frame. The
  record sound 11 plays when the animation reaches that frame (Amazon Politesse 5 of 10 frames,
  Pimmon 7 of 12, Sajiki 6 of 13). It plays only if the officer is on screen and the animation
  was not cut off before that frame. The impact and the criminal's flight come about 8 ticks after
  the strike starts, i.e. after the sound frame.

Truncheon 2..5 (mean 3.5), cooldown 15: about 3 hits bring a criminal from 50 to ≤ 40 HP,
roughly 40..60 ticks once adjacent. Neither the officer nor the fleeing criminal charges (both
attack jobs are children), so the chase is at porter speed.

### 12.4 Escort / jail job (0x19) (C, ctor `0047cc20`, run `0047cca0`)

1. The **criminal walks by itself** into the station (go-to + enter). The station admits
   criminals (`units-and-jobs.md` 4.4).
2. When the walk ends: wait **599** ticks.
3. Then, if the criminal is inside a building: **retype it to a porter** (type 9) in place
   (`00464840`: new record, HP 50, weapon removed, needs re-evaluated) and eject it. The job
   ends.
4. If it never got inside, the job just ends and the ex-arrestee stays a criminal **without**
   its criminal job (it is idle from then on) (C; probably rare).

### 12.5 Police otherwise (C)

Officers are armed (truncheon) and tier 0. They earn experience, rank up, take part in the help
rule (7.1) against foreign attackers within 12 cells, and can be ordered to attack foreigners.
When no criminals are about they sit in the station as its operator.

### 12.6 Criminals and the player (C)

A criminal belongs to the player's own race and town but is **never under the player's
control**. The only player action that involves a criminal is ordering a **police officer** onto
it (12.3 "Manual orders"); everything else is automatic (station dispatch 12.2, jail 12.4).

| aspect | rule | evidence |
|---|---|---|
| single click | selectable for **inspection only**: own criminals fall into the "other units" category (max 1), like foreign units | `004404a0`; `docs/rendering/objects.md` 8 |
| box | a box over own units and criminals selects the own units; a box over criminals only selects the frontmost one, alone | same |
| double click | never selects a criminal; a double click whose frontmost unit is a criminal ends with an **empty** selection (no Shift/Ctrl) | `00440e40`; objects.md 8 |
| side panel | the unit page with portrait, name, home town, HP and experience only: no `MOVEHOME`, no `PATROL`, no `WEGWERFEN`, no status text | `00455d50`; `docs/ui/side-panel.md` 5 |
| right click in the world view or on the minimap | issues nothing (no move, no order, no sound): commands are sent only while the "own units" category is selected | `00441440`, `0044db30`; objects.md 8.1 |
| move command (0x14) in the simulation | every selected unit is checked on its own: own, a unit, **not type 12**, not inside a building; a criminal is skipped | `00451170` |
| order command (0x15) in the simulation | processing stops at the first criminal (or unit inside a building) in the selection; units before it keep their new jobs | `00450bb0`; `units-and-jobs.md` 3.2 |
| cursor | arrow: criminals are not fighter types, and the object under the mouse is never examined | `docs/ui/cursors.md` 4, 5.5 |
| as a target | an own criminal is an "own unit" target (objects.md 8.1): the client's hit test returns the criminal under the cursor like any other own unit. Only an officer turns that into an arrest job, and that job ignores which criminal was clicked (12.3 "Manual orders"); a priest heals a wounded criminal (same race, 3.2 table); every other unit, soldiers included, just walks to it (0x07): no other unit type may act on an own criminal (2.1) | `00450bb0` |
| fog of war | a criminal reveals nothing: its sight radius (odb +0xB0) is **0** in all three races, the vision disc of radius 0 is empty, and the minimap's visible pass skips type 12 explicitly | `fog-of-war.md` 2, 3, 5.4 |
| send out | type 12 is refused by the inhabitants page's send-out (a jailed criminal cannot be released early) | `units-and-jobs.md` 4.11 |

### 12.7 How often criminals strike: worked numbers

Per criminal (12.1): an assault, then 50 ticks standing, then the next random porter of the
town. With P porters of which Q are inside buildings, a pick lands on a porter inside with
probability Q / P, and that "assault" costs only the 50 ticks. Upper bound, every porter
outside and never escaping: about 3.8 hits (≈ 11 HP) per ≈ 120 + 50 ticks, i.e. at most
≈ 6.5 HP per 100 ticks per criminal (≈ 41 HP per minute at 95 ms ticks).

Our build measured (re-measured October 2026 after the chase fixes of 3.3.1, one criminal,
6000 ticks, `Pimmons.mdb`): mission 0 (2 porters) 5.7 assaults and 10.2 hits per 1000 ticks,
both porters dead at ticks 1 845 and 2 169; mission 7 (5 porters) 8.0 assaults and 12.7 hits per
1000 ticks, all five dead between ticks 4 838 and 5 627 (≈ 4.5 HP per 100 ticks, below the upper
bound). An assault typically lands 2 or 3 blows: the porter flees 2 cells, stands its 50 ticks
and is struck again about every 30 ticks, and the assault ends by the give-up (6th search) when
it walks home, or by the 10-HP stop. Free-play towns growing from 4 to 40 residents (1..4
criminals, 10..40 porters): 21..24 porter hits per 1000 ticks with a criminal present; the
first porter dies ≈ 7 800 ticks after a criminal is born in a town of ≈ 15 porters. All of this
follows from the rule above; nothing in the original slows it (re-checked, 12.1). A porter left
without police or priest dies after ≈ 10..15 assaults on it.

How many criminals there are depends only on births (`economy.md` 3.2): in a human town every
9th resident (P before the birth a multiple of 9) while happiness < 90, otherwise every 18th.
Arrests do not change the population (12.4 retypes in place), so they do not move the count
towards the next multiple. Deaths do: a porter killed at P = 10 brings P back to 9, and the next
birth is a criminal again if h < 90. Two criminals among 11 residents therefore need an empty
food store (or an open need, none below 15 residents) at both births at P = 9 and a death in
between (`economy.md` 3.2, 6).

---

## 13. Healing (0x29) (C, ctor `00480db0`, run `00481180`)

**Sources:**

- player right-click by a priest on a damaged unit of the same race (`00450bb0`);
- the help rule (7.1).

Both set **auto-continue on**.

**Each run:**

1. No patient:
   - with auto-continue: scan a circle of the priest's **sight** (5) around the priest. Pick the
     **nearest** unit that 2.1 allows (same race, HP < max; distance max + min/2, the first one
     in scan order wins ties). If found, return 3; otherwise end;
   - without auto-continue: end.
2. Patient dead or at full HP: drop the child, release the patient and return 3 (look for the
   next one).
3. No child: create an attack child on the patient (no retarget). The priest walks next to it
   (range 0) and strikes with the **heal weapon**.
4. When the child ends: release the patient and return 3.

**Rate and cost:**

- **7..12 HP per strike** (mean 9.5);
- strikes every 21..31 ticks (mean 26);
- impact 6 ticks after the strike;
- about **0.37 HP per tick**, roughly 3.8 HP per second at normal speed;
- **no money or goods cost**.

A soldier at 50/175 HP needs about 13 strikes, roughly 340 ticks (32 s).

**Range:** adjacent only. Searching for the next patient covers 5 cells around the priest. Being
called covers 12 cells around the wounded unit.

**Other HP sources:**

- there is **no natural regeneration** and no healing in the temple: the temple operator only
  keeps the building active (C by absence; the handbook's "heal residents" is not backed by
  code);
- retraining resets HP to the new type's maximum;
- builders repair buildings (units-and-jobs 6.4): 20 HP for 1 coin per repair tick, one tick
  about every 20 to 40 ticks with the relocation walk. A repair happens **only** through the
  player's `Restaurieren` command (`00452a70` -> `0045f4b0`, the only filer of a builder request
  for a completed building; the other filers are construction orders and the builder
  destructor). **Computer players never repair** (C, fourth AI audit): an AI building keeps its
  damage until it falls. Sites gain HP only through construction (units-and-jobs 6.3: start at
  HP / 10, + (HP - current) / 9 per counted work tick).

---

## 14. Hunting (C, `00476930`, harvest phase 0/7 in units-and-jobs 7.1)

The whole hunter cycle (hunting ground, scan, return and waiting) is in `units-and-jobs.md` 7.3.
This section covers the fight with the animal.

Hunting uses the same attack job:

- the hunter's harvest job creates an attack child (retarget flag on) on the living animal;
- it chases with the full range, leash and search rules (sections 3.4 to 3.5);
- it strikes with its weapon:

  | race | weapon (`dv.wdb`) | kind | damage | hit% | cooldown (interval) | reach straight / diagonal | strike row, release frame | projectile |
  |---|---|---|---|---|---|---|---|---|
  | Amazons (Jägerin) | 1 JägerBogen | missile | 10..20 | 70% | 40 (41..61) | 5 / 4 cells | `ST` 12 frames, frame 7 (10 ticks) | 10 Bogen, the archers' arrow, speed 900 |
  | Pimmons (Jäger) | 17 Jagdspeer | **melee** | 10..20 | 100% | 40 (41..61) | adjacent, diagonals included | `ST` 11 frames, frame 4 (5.7 ticks) | none |
  | Sajiki (Jäger) | 17 Jagdspeer | **melee** | 10..20 | 100% | 40 (41..61) | adjacent, diagonals included | `ST` 12 frames, frame 5 (7.1 ticks) | none |

  The **Amazon hunter has no melee attack at all**: her only weapon is the bow. She stops at
  the first cell from which the line-of-fire test (3.4) succeeds (5 cells straight, 4 diagonal
  on open flat ground; buildings block) and shoots from there; she never walks up to the animal
  to kill it. Only after the kill does she walk to the carcass to pick up the meat. Pimmon and
  Sajiki hunters walk into the animal's 8-neighbourhood and stab; their spear is not thrown.
- Impact delays: Amazon at 5 cells straight: f = 320 × 1000 / 900 = 355, delay
  (355 + 1000) / 100 + 1 = **14 ticks** after the strike begins; at 1 cell: 11 ticks. Spear:
  (571 or 714) / 100 + 1 = **6** (Pimmon) or **8** (Sajiki) ticks.
- The strike turns the hunter one 45° step per 2 ticks first (4.1). A hunter carrying meat would
  drop it on striking (4.1 step 2); the harvest job always delivers first, so this does not
  happen in the normal cycle.

- animals have 10 HP, so **one connecting hit always kills**;
- no flee, help or diplomacy steps run for nature targets, and animals never fight back;
- the animal keeps wandering during the chase, and the leash is 29 cells from where the chase
  began;
- the kill turns the animal into a carcass (10.2). The attack then becomes invalid and the
  retarget scan finds nothing (it returns only units and buildings), so the child ends and the
  harvest job moves to phase 7 (walk to the carcass and take up to 4 food). That happens at the
  hunter's first 5-tick poll after the impact, not at the impact: strike + 15 for the Amazon,
  strike + 10 for the spear hunters. The first step toward the carcass comes 5 ticks later, after
  the `ST` row has played out (`units-and-jobs.md` 7.3.4, "From the killing strike");
- experience from animals is 0.

---

## 15. Job 0x28 is not a formation move (correction)

`0047c970` (job 0x28) picks a **random map cell** (x = rand() % map size, y = rand() % map size,
stepping on if that cell is impassable for the unit). It walks there and repeats after
rand() % 5 + 1 ticks. It is created only by the AI strategy routines (`00468e10`, called with
unit type 24) for **AI scouts exploring**.

Player group moves are plain follow-path jobs to free cells around the clicked point (`00465ad0`,
`units-and-jobs.md` 3.2). **There are no formations** (C).

---

## 16. Determinism notes for the rebuild

1. **rand() calls in combat, in order** (C):

   | when | calls |
   |---|---|
   | strike fires | 1: cooldown jitter |
   | melee/missile impact | 1 hit roll, then 1 damage roll if it hit |
   | heal impact | 1 |
   | bomb impact | 0 if the carrier is dead; else 1 hit roll if the target is alive, plus 1 damage roll on a hit |
   | criminal choosing a victim | 1 (only if the town has porters) |
   | map-load patrol start | 1 |
   | map-load garrison unit (9.2) | 1 per unit: its facing |
   | AI scout exploring | 3 per leg |
   | collapse delay | 0 (the dead branch never calls) |

2. **Scheduler order:** the original pops each timing-wheel slot **last-in first-out**
   (`00482ca0` takes the list tail, `00482c30` appends at the tail). A job scheduled with delay 0
   while the slot is being processed runs in the same tick, right away. `units-and-jobs.md` 1.1
   says "in insertion order". That statement does not match the code and should be corrected.
   Impacts landing in the same tick are therefore resolved newest first. Any fixed order works
   for lockstep, but LIFO reproduces the original (C).
3. **Scan order** (8.3): the original iterates by memory address. Use ascending object id.
4. **Path searches for firing positions** run outside the tick in the original. Complete them
   synchronously (3.5).
5. **Floats:** the flee point (7.3) and the outpost bonus E = trunc(1.5 R) (exact in integers:
   R × 3 / 2). Replace both with integer formulas.
6. **Projectile distance** is not torus-wrapped (4.1). Across the map seam the flight time, and
   so the impact delay, becomes huge. Wrapping it is a defensible fix; flag it in the rebuild.
7. The advisor's 120-s repeat suppression uses wall-clock time. Keep it out of the simulation
   state.

---

## 17. Worked examples

All numbers are expected values with rank 0, flat ground and no other units. Times are ticks;
divide by about 10.5 for seconds at normal speed. The Monte-Carlo means were computed from the
rules above (scratch script, not part of the repo).

### 17.1 Archer vs archer, standing at 6 cells (Pimmon bow: 10..20, 95%, cd 35, sf 8)

- Per shot: 0.95 × 15 = 14.25 HP. Interval 36..53 (mean 44.5).
- 100 HP falls after about 7 connecting arrows. Mean time to kill is **≈ 300 ticks (29 s)**
  after the first shot, plus the 16-tick impact delay.
- Whoever fires first has the edge. The first shot of a fresh unit is immediate.

### 17.2 Sajiki fighter (Kämpfer: 150 HP, short sword 5..10, cd 10, sf 5) ordered onto an idle Pimmon archer 6 cells away

1. t = 0: the order is given. t ≈ 1..3: the path search succeeds and the fighter charges at
   4 ticks per straight cell (step 5 - 1).
2. It is adjacent at t ≈ 22 and strikes at once if it faces the archer (it arrives facing it).
3. The archer stood idle and **did not shoot during the approach**: it had no guard job. The
   first sword strike notifies it, the help rule makes it retaliate, and it strikes point-blank
   from t ≈ 23. Its arrows land 13 ticks after each strike.
4. The fighter deals 7.5 per 13.5 ticks and kills 100 HP in **≈ 180 ticks**. Meanwhile the
   archer gets about 4 arrows away, ≈ 57 HP.
5. **The fighter wins with ≈ 90 HP left.**
6. If the archer had been on guard, it would have acquired the fighter at 11 cells (sight + 1)
   and shot once during the approach: it still loses.
7. The fighter's experience: 100 (archer HP) × 2 = 200. Its own H is 150, so bronze needs more
   than 300: no star yet.

### 17.3 Same archer with rank 3

The damage factor is ×2, so 150 HP falls in ≈ 225 ticks instead of ≈ 460.

### 17.4 Four Pimmon hammer men vs an Amazon barracks (500 HP)

- Each: 35 mean per 38.5-tick interval, 100% hit.
- Four together deal ≈ 3.6 HP per tick, so the barracks falls in **≈ 140 ticks**. It collapses
  about 10 ticks later (empty barracks), leaving rubble equal to its stone cost.
- Experience: 500 / 2 = 250, split by who dealt what.

### 17.5 Saboteur vs a small house (350 HP)

- The bomb deals 500..600 at 100%, so the house is destroyed by one bomb and the saboteur dies
  with it.
- A town hall (10000 HP) needs at least 17 bombs (17 × 600 = 10200), usually 18..20.

### 17.6 Criminal vs porter

- An assault ends after 10 or more HP, typically 3 or 4 knife hits over ≈ 100 ticks, if the
  porter stays in reach; a fleeing porter usually ends it earlier through the search limit (12.7).
- After it, a 50-tick pause, then a new random porter.
- A porter at 10 HP dies in the next assault. Only a priest prevents this.

### 17.7 Priest

From 50/175 to full is ≈ 13 strikes × 26 ≈ **340 ticks**.

---

## 18. Remaining unknowns

1. *(Resolved: `ai-diplomacy-trade.md` 2.2 and 2.5.)* The AI side of combat: the intruder list
   (`0046cab0`) and the AI attack routines (`00466020`, `00466e20`, `0046d3a0`).
2. The exact Bresenham stepping at the line's endpoints (3.4). Whether the cell just before the
   target is always counted is inferred from the loop order; one-cell edge cases at maximum
   range are possible.
3. The per-race/type sprite table at 0x4B3914 that chooses `ST` or `WO` for the strike animation
   (I).
4. The unit attached-object list (+0x54/+0x58) killed with a unit (10.1): who uses it.
5. Diplomat capture "en route" (handbook p. 37): not found in combat code. Diplomats are only
   excluded from automatic targeting.
6. Human game-over handling (`0044fc20`) and the mission-goal checks for "destroy X" (mdb.md).
7. The display's "play once" meaning of loop parameter 0 in the strike animation message.
8. *(Resolved for projectiles and impact effects: `docs/rendering/projectiles.md`.)* The death
   "Die" sprites follow the same effect rules (projectiles.md 5).
9. Whether any code path ever sets a town's collapsing state that the dead stagger branch in
   10.3 expects. None was found.

---

## 19. Notes for other documents

- `units-and-jobs.md`:
  - 3.1 should read:
    - 0x09 C: strike, fires repeatedly;
    - **0x15 impact** (new row, `00481c40`);
    - 0x25 **building collapse**, owned by the building, not a unit;
    - 0x28 **AI scout random exploration**, not a group move.
  - Section 1.1's "insertion order" is LIFO in the code (16.2).
- `idb-wdb.md`:
  - the cooldown is in ticks;
  - the flight time is in 1/100 tick;
  - the "attack strength argument" is the attacker's rank (+0x80);
  - the ranged reach is the line-of-fire budget of 3.4, not the plain distance;
  - bombs have no area effect.
- `rules-from-manual.md` 20, questions 26 to 30, are answered by sections 3 to 13 of this
  document.

---

## 20. Our build: hunting and missiles (deviations, checked October 2026)

Read from `src/engine/combat.ts`, `logistics.ts`, `world.ts`, `src/client/effects.ts`,
`looks.ts`, `main.ts`, plus a scratch simulation of an Amazon hunter on `Amazons.mdb` (not part
of the repo). Display items are detailed in `docs/rendering/projectiles.md` 7.

**Simulation**

1. Weapon choice is right: hunters attack through `combat.attackStep` with their record's
   weapon, so the Amazon hunter shoots (weapon 1, reach 5) and the Pimmon/Sajiki hunters stab
   (weapon 17). In the scratch run the Amazon hunter fired from 5..6 cells (max + min/2) and the
   impact killed the animal 15 ticks later. If players still see Amazon hunters "walk up and the
   animal dies", the cause is on the display side (items 6..9 below), not the weapon. *Fixed:*
   the no-weapon shortcut in harvest phase 1 (`killAnimal` on arrival) is removed; a living
   animal dies only by the attack (`test/hunting.test.ts`: the huntress fires every strike as a
   shot from range, the Pimmon hunter strikes only from an adjacent cell).
2. *Fixed:* the hunter cycle is the hunting-ground job 0x2B (`units-and-jobs.md` 7.3.9).
3. Strike, impact delay, cooldown jitter, line of fire, leash and retarget follow sections 3..5.
   The impact uses the attacker's sound frame from the record, as required.
4. The shot event carries the shooter's **cell** and the aim cell, `wait` = a/100 and
   `flight` = f/100 ticks, and (since October 2026) `shooter` = the shooting unit's id and
   `garrison` = the outpost building's id when a garrison fired (else -1), from which the display
   can read the facing and the launch point (projectiles.md 2). It carries no garrison slot.
5. `dirToward`/`dirOf` number directions with x and y swapped (`unit-motion.md` 1.6). The
   simulation's strike facing is therefore mirrored on screen; the same swapped table is copied
   into `effects.ts`.

**Display**

6. **The strike animation loops.** `combat.strike` sets the action to `Fight` and nothing resets
   it while the attack lasts; `looks.ts` animates every non-idle action with `% frames`. The
   original plays the `ST` row **once** per strike (repeat count 0) and then shows the standing
   pose (base action, frame 0) until the next strike (unit-motion.md 3). With cooldowns of
   36..151 ticks and strike rows of 6..17 frames (≈ 9..24 ticks), our units "keep swinging"
   2..10 times per real shot, so the arrow no longer lines up with a visible release.
7. **Projectile path.** `effects.ts` draws a parabola (`lift = 30 + sin(πk)·len·6` pixels) from the
   shooter's ground point. The original flies in a **straight line** from the launch point of the
   shooter's sprite (odb +0x54 + 8·facing, e.g. 56 px above the Jägerin's feet) to the aim cell's
   ground point, with the terrain height interpolated linearly; there is no arc for any
   projectile, catapult stones included.
8. **Projectile sound** plays at launch in ours; in the original it is the **hit** sound at the end
   of the flight (6). The launch sound is the shooter's record sound (handled by `main.ts
   unitSound`).
9. Arrow and bolt sprites are picked with the swapped direction table (item 5): every
   non-vertical flight shows the mirrored sprite (an arrow flying up-right points up-left).
10. Multi-frame projectiles (Alchemie1 8 frames, Katapult 6, Magie/Säure/Feuer 10) advance by
    time at 0.7 frames per tick in ours; the original advances one frame per screen update in
    which the projectile moved at least 4/64 cell, i.e. with the distance flown
    (projectiles.md 4).
11. Impact effects 17..19 have layer speed 10 (one frame per tick); ours plays them at the
    default 0.7 frames per tick, 43 % too slow.
12. Projectile records are used unchanged (correct): sprites are not all the same; the arrow is
    shared by hunters, archers and the Drachofiterus, the Amazon crossbow has its own bolt
    (type 2), and casters use their weapon's spell sprite.

*Display items 6..11 are fixed in the client* (strike once then the standing pose, straight
flight from the launch point, hit sound at arrival, `dirToward`, frames by distance, effects at
their layer speed): see `docs/rendering/projectiles.md` 7 "Status" and `unit-motion.md` 3.
Item 4 is fixed in the engine (the shot event carries `shooter` and `garrison`).
