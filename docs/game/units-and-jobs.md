# Units, jobs, construction and goods logistics (behaviour spec)

Status: **first full pass.** Porters, construction, production, training and gathering are
traced end to end in AN.exe. Combat, diplomacy, trade and crime jobs are only named here.

Sources: decompiled AN.exe. Addresses are cited as evidence; no code is reproduced. Many job
methods are virtual functions that the stock Ghidra dump (`re/dump/decomp.c`) does not contain.
They were decompiled separately by creating functions at every vtable entry (helper script
described in section 13). Field names refer to `docs/formats/odb.md` (record fields `+0x..`)
unless the text says "object", "town" or "job".

Related documents:
- `docs/formats/odb.md`: record fields.
- `docs/formats/od-odb.md`: sprite slots.
- `docs/game/rules-from-manual.md`: handbook facts.
- `docs/game/economy.md` (being written in parallel): clock, money, needs, happiness, houses and
  population growth, crop-to-food conversion. Those topics are not repeated here.

Legend: **C** = confirmed in code, **I** = inferred (data pattern, partial trace or naming guess).

---

## 1. Engine model: the scheduler and jobs

### 1.1 Tick and scheduler (C)

- The simulation runs on a global **timing wheel** with 600 slots. The scheduler object is
  created in `00485a30` (`00482a50`, speed 100), its insert function is `00482c30` and its tick
  function is `00482ca0`. Every entry in the wheel is a **job** (see 1.2), never a game object.
- Insert(job, delay) puts the job into slot (current + delay) mod 600. The largest usable delay
  is therefore 599, which is why many periods are 599, 299 or 199.
- On each tick the scheduler takes every job out of the current slot, in insertion order:
  1. A job that is cancelled (job+0x18) and not blocked (job+4 = 0) is deleted.
  2. Otherwise, if the job is not blocked (job+4 = 0), its `run` method (vtable slot 1) is
     called. `run` returns the delay until its next call.
  3. A return of 0 means the job is finished, and it is deleted.
  4. A blocked job (job+4 > 0) is not run. It is put back after job+4 ticks.
  5. Otherwise the job is put back after max(returned delay, job+4) ticks.

  After the slot is processed, the slot index advances and a global tick counter (`004b3780`)
  is incremented.
- Real time per tick is speed × 95 / 100 ms: speed 100 gives 95 ms, 50 gives 47 ms and 25 gives
  23 ms. These are the three settings set in `0043fb80` through `004403d0`. The value is also
  copied to the display (`004afaa4`) for animation timing. Our `TICK_MS` constant in
  `docs/architecture/simulation.md` should therefore become 95.

### 1.2 Job objects (C)

Common base (`004821c0` / `004823b0`):

| job field | meaning |
|---|---|
| +0x04 | **blocked / wait** ticks; non-zero means "do not run, re-poll every N ticks" |
| +0x08 | byte: 1 = created by an explicit player order (`00450bb0`) |
| +0x0C | unique serial number (global counter `004b514c`, saved with the game) |
| +0x10 | **job type id** (table in 3.1) |
| +0x14 | current **child job**. A parent job drives its child by calling the child's `run` itself; the child is not in the scheduler |
| +0x18 | cancel flag |
| +0x19 | success flag, read by the parent when the child returns 0 |
| +0x1C | owner object (unit, building, nature object or town) |
| +0x20 | next job queued after this one |

Vtable: [0] destructor, [1] run, [2] save, [3] load, [4] status text (tooltip). Order-queue
jobs add [5] "order finished" and [6] "progress percent".

Every game object holds its current top-level job at **object+0x30**. When a job is destroyed
while it is still the object's current job, the object's current job becomes job+0x20 and that
job is unblocked (+4 = 0). If the job was not current, its +0x20 job is cancelled instead.

Giving a unit a new job (`00465650`, used by the town dispatcher with first delay 5):

- If the unit has no job, the new job becomes current.
- If the current job is "leave building" (type 0x0D), the new job is queued behind it and
  blocked for 5 ticks. A job that was already queued there is cancelled.
- Otherwise the current job is cancelled and replaced.
- If the unit is inside a building, the new job is blocked for 5 ticks and the building ejects
  the unit (building vtable +0x20 = `00460be0`, which creates a "leave" job in front).
- In every case unit+0x78 is set to 0 and the job is scheduled.

A player order (`00450bb0`) cancels the current job, sets the new one with delay 1 and marks it
job+8 = 1.

---

## 2. Object fields used by these systems

Object category at object+0x08: 0 unit, 1 building, 2 nature/goods (set by the constructors
`00463d00`, `0045f0d0`, `004638d0`). Position x/y/height at +0x10/+0x14/+0x18, record at
+0x0C, refcount at +0x2C, current job at +0x30, alive flag at +0x34 (byte), HP at +0x44,
nation at +0x4C, town at +0x50 (C).

Lists are MSVC `std::list` objects: list object at X, head node at X+4, element count at X+8.

### Unit (C unless marked)

| off | meaning |
|---|---|
| +0x1C | facing 0..7: 0 = grid step (−1,−1), 1 = (−1,0), 2 = (−1,+1), 3 = (0,+1), 4 = (+1,+1), 5 = (+1,0), 6 = (+1,−1), 7 = (0,−1); clockwise on screen from "up" (4.6, `docs/rendering/unit-motion.md` 1) |
| +0x24 | movement blocking mask (0x3E) |
| +0x28 | path search mask (0x3C) |
| +0x38 | carried goods index |
| +0x3C | carried amount |
| +0x40 | base movement animation: 0 = walk (`MG`), 4 = carry (`CA`) |
| +0x48 | group (army/formation) id; 0 = none |
| +0x6C | building the unit is inside (0 = outside) |
| +0x74 | weapon object |
| +0x78 | idle counter for the leisure dispatcher; -1 = on a leisure visit (5.7) |
| +0x7C | home house |
| +0x80 / +0x84 | rank / experience (soldiers, police, hunters) |

### Building (C)

| off | meaning |
|---|---|
| +0x30 | building job (construction, training, production, operator...) |
| +0x40 | display state (1 = completed sprite) |
| +0x54 | occupants list (count +0x5C) |
| +0x60 | door queue list (count +0x68); see 4.4 |
| +0x70..+0x78 | entrance cell |
| +0x7C + 4·g | **local stock** of goods g (cleared at creation) |
| +0xA8 | current operator unit |
| +0xAC | door-open counter |
| +0xB0 | **state**: 1 = construction site, 0 = completed but not active (waiting for operator), 2 = active |
| +0xC4 | **needed-goods list**: one entry per unit of goods still to be delivered (count +0xCC) |
| +0xD0 | **output list**: one entry per produced unit waiting to be collected (count +0xD8) |

"Stock of a building" below means: the **town** stock (town+0x88 + 4·g) if the record has flag
0x1 (store) and the building is not a site; otherwise the building's local stock. This rule is
applied everywhere goods are read or written (`00476380`, `0047c400`, `00475480`, ...).

### Nature object (C)

| off | meaning |
|---|---|
| +0x38 | yield goods index (record +0x11C) |
| +0x3C | remaining amount |
| +0x40 | growth / display stage (trees: 4 = grown; planted: 1) |
| +0x4C | 1 = living animal |
| +0x4D | 1 = removed when empty; 0 = regrows (bushes) |
| +0x4E | 1 = "standing", must be felled first (grown trees) |
| +0x50 | full amount (record +0x120) |
| +0x54 | **reserved amount**: units promised to harvesters already at work |
| +0x58 | growth frame counter |

### Town (C)

| off | meaning |
|---|---|
| +0x04 | town dispatcher job (type 0) |
| +0x44 | population |
| +0x4C / +0x50 | completed buildings / construction sites |
| +0x54 | per-good storage capacity |
| +0x88 + 4·g | town stock |
| +0xB4 + 12·type | per-type object list (one for every unit and building type). Examples: porters at +0x120 (count +0x128), builders count +0x140, town halls at +0x294 (head +0x298), warehouses at +0x2A0 (head +0x2A4) |
| +0x39C + 4·type | number of units of that type queued for training |
| +0x4D4 | free-porter list, rebuilt on every dispatch (count +0x4DC) |
| +0x4E0 | homeless list |
| +0x5C4..+0x5CC | round-robin counters of the dispatcher (5.3) |

Distance (`00459a80`, `0045aea0`) on the torus: with dx, dy the shortest wrapped deltas,
**d = max(|dx|,|dy|) + floor(min(|dx|,|dy|) / 2)** (C).

---

## 3. Unit state machine

A unit has no state enum. Its behaviour is the job at unit+0x30, plus that job's chain of
children (job+0x14). A unit without a job is idle and stands still.

### 3.1 Job types

The type id is job+0x10. The run function is vtable slot 1. Animation actions are those of
`od-odb.md`: 0 walk `MG`, 1 strike `ST`, 2 work `WO`, 3 idle `ID`, 4 carry `CA`.

| id | name | owner | run | what it does | status |
|---|---|---|---|---|---|
| 0x00 | town dispatcher | town | `0046fa10` | assigns porters and workers to requests (5.2, 5.3) | C |
| 0x03 | town leisure | town | `00470340` | sends idle porters to houses, tavern or circus (5.7); period 199 | C |
| 0x05 | transport | unit | `0047c2b0` | carry goods from a source to a destination (5.5) | C |
| 0x06 | follow path | unit | `00480410` | walk a planned path cell by cell (4.1) | C |
| 0x07 | go to object | unit | `0047ac90` | path to an object or entrance, turn to face it, enter if it is a building | C |
| 0x08 | attack | unit | `00472b20` | chase a target and strike when in range; gives up beyond 29 cells | C (outline) |
| 0x09 | strike / shoot | unit | `00481450` | one attack, child of 0x08 | I |
| 0x0A | house | building | `004749e0` | resident job, period 599 (see economy.md) | C |
| 0x0B | enter building | unit | `0047a0f0` | door queue and entering (4.4) | C |
| 0x0C | builder | unit | `00477ce0` | build or repair a building (6.4) | C |
| 0x0D | leave building | unit | `0047a530` | first run 10 ticks after the eject: door opens; 10 ticks later the unit is put on the entrance cell, or it pushes / waits in 5-tick polls and finally takes the nearest free cell (4.10) | C |
| 0x0E | found town | unit | `00479410` | founder walks to his new town's town-hall site, completes it on arrival and enters it as its operator (section 11; constructor `00479280`, destructor `00479380`) | C |
| 0x0F | step aside | unit | `0047df70` | a walker squeezes past, or an idle blocker moves one cell out of the way (4.7) | C |
| 0x11 | construction | building | `00475470` | passive order queue, run only returns 10; the builder drives it (6.3) | C |
| 0x12 | training | building | `00475d50` | 9 | C |
| 0x13 | production | building | `00476380` | 8.2 | C |
| 0x16 | harvest | unit | `00476a70` | gather from a nature object (7.1) | C |
| 0x17 | criminal | unit | `004784d0` | criminal behaviour, started 50 ticks after creation | I |
| 0x18 | arrest | unit | `0047b860` | police officer chases a criminal | I |
| 0x19 | escort | unit | `0047cca0` | created by 0x18 | I |
| 0x1A | news round | unit | `0047b490` | the news seller visits every house of his town, then walks back into his stand (8.6) | C |
| 0x1B / 0x1C | garrison fire / outpost | unit / building | `004736c0` / `00473850` | 0x1C: every 20 ticks, gives idle class-2 occupants of an outpost a 0x1B job on the first enemy in garrison range; 0x1B: one target, strike child while in range (`combat.md` 9) | C |
| 0x1D | growth | nature | `00481e90` | crop ripening and sapling growth, period 599 (7.5) | C |
| 0x1E | bush regrowth | nature | `00482110` | period 299 (7.5) | C |
| 0x1F | turn / idle | unit | `0047f030` | turn to a direction, then optionally play action 3 (idle) (4.9) | C |
| 0x20 | trade | unit | `0047ce00` | merchant (`0047cd10`) | I |
| 0x21 | plant | unit | `0047ead0` | farmer plants one crop (7.6) | C |
| 0x22 | operator / visit | building | `00478cb0` | 8.3 | C |
| 0x24 | animal | nature | `004743b0` | wander, idle, eat crops (7.7) | C |
| 0x25 | ? | unit | `0047bd60` | created when a building is destroyed (`0045f5a0`) | I |
| 0x26 | flee | unit | `0047da50` | unarmed unit runs from an attacker (`00462e30`) | I |
| 0x27 | guard / patrol | unit | `00480a10` | created at map load and by a command (`00452790`) | I |
| 0x28 | group move | unit | `0047c970` | formation movement (`00468e10`) | I |
| 0x29 | heal | unit | `00481180` | priest heals a damaged unit of its own race | I |
| 0x2A | eat crop | animal | `00473d50` | the animal eats 1 unit of a bush or crop | C |
| 0x2B | hunting ground | unit | `00479800` | hunters only: wait at a spot, scan for animals every 20 ticks, hunt, deliver, return (7.3) | C |
| 0x37 | nature respawn | global | `004826a0` | period 299 (7.5) | C |
| 0x38 | operator errand | unit | `00478910` | operator sent out by its building (`004618b0`) | I |
| 0x3C | answer request | unit | `0047d940` | walk to a building and enter it; re-files the request on failure (5.2) | C |

### 3.2 Orders to jobs (C, `00450bb0` and related commands)

A right-click on a **target object** is processed for each selected unit, under these rules.
Which object is the target (anywhere on a building's visible sprite, not only its door or
footprint; unit/nature/building priority) is decided by the client's hit test,
`docs/rendering/objects.md` 8.1.

- The selection is walked in its order. The target itself is skipped. Processing **stops** (the
  rest of the selection gets nothing; units already handled keep their new jobs) at the first
  entry that is not an own unit, is a criminal (type 12), or is inside a building. In practice
  the client sends the order only while the "own units" category is selected, which never
  holds criminals (`docs/rendering/objects.md` 8, `combat.md` 12.6), so with a normal client
  the order is either applied to all or, for a unit inside, to none after it. A unit inside a
  building can only be got out by the player with the send-out command 0x3A of the inhabitants
  page, or `DEAKTIVIEREN` for an operator (4.11).
- The **move** command 0x14 (`00451170`) tests each selected entry on its own instead: own,
  a unit, not a criminal, not inside a building; any other entry is skipped and the rest still
  move.
- *Our build:* the order command is refused as a whole when it names a criminal; the move and
  the unit-page commands (go home, drop goods) skip criminals one by one. This also guards
  against a peer that sends commands for criminals in a network game.
- An order that is already running against the same target is not restarted (attack, harvest,
  heal, go to object). The arrest job has no target and is always restarted.
- **Which branch a unit target or building takes** (re-checked in the machine code, October 2026):
  the order command carries a byte "target is own" (+0x0F), which the client sets to 1 for an
  own unit or own building and to 0 for everything else (`00441440`, `4416da`/`44174f`;
  `docs/rendering/objects.md` 8.1). For a unit or building target the simulation first tests
  (`450d9c`..`450dd9`): byte 0, unit armed, unit not a priest → the attack branch (0x08 if 2.1
  allows it, else 0x07 go to). Only with byte 1 (or an unarmed unit, or a priest) do the
  own-target rows below apply (builder, transport, founder, go to, arrest `45101b`, heal). So a
  police officer clicking a **foreign** criminal gets a plain attack on that criminal (other
  race: 2.1 always allows it), while one clicking an **own** criminal gets the arrest job, which
  does not know the clicked unit.

| target | unit | resulting job |
|---|---|---|
| nature object that this unit type may harvest (`004635f0`: porter takes bush, own crop or rubble; hunter animal; woodcutter tree; stonemason stone or rubble) | hunter (17) | 0x2B hunting ground, spot = the target's cell, first child a harvest on the target (7.3) |
| same | anyone else | 0x16 harvest with **auto-continue** on |
| other nature object | any | 0x07 go to object |
| unit or building of a hostile side | armed unit (not priest) | 0x08 attack |
| own building under construction or damaged | builder (11) | 0x0C builder. An open "builder wanted" request for that building is withdrawn |
| own building that accepts the unit's load (`004617c0`) | unit carrying goods | 0x05 transport: deliver the load there |
| own town-hall site (state 1), any town of the nation | founder (10) | 0x0E found town (see the quirk in 11.6) |
| other own building | any | 0x07 go to object, which enters the building (training, operator, resettling, visit, outpost garrison `combat.md` 9.1...) if the door admits the unit (4.4); a refused unit stays idle at the door |
| own criminal | police officer (21) | 0x18 arrest **without station and without target** (`45104a`: `0047b770(officer, 0)`; the base job constructor copies nothing else from the unit): the job picks the first free criminal of the officer's town itself and rotates it to the end of the list, so the clicked one is ignored, every order restarts the job and repeated orders cycle through the criminals; the officer never arrests, he beats them to death (`combat.md` 12.3 "Manual orders") |
| own unit with HP below maximum | priest (22) | 0x29 heal |
| any other unit | any | 0x07 go to object |

A building "accepts the unit's load" (`004617c0`) if the unit carries something and either:

- the building is a completed store, or
- the building's needed-goods list contains the carried good (one entry is then removed).

**The delivery transport of an order** (C, confirmed at instruction level, `00450f83`..`00450f8f`
calling the transport constructor `0047bee0`): it is built with **no source**, destination =
**requester = the clicked building**, good to fetch (+0x30) = **the good the unit carries**
(+0x38), no output (−1). It is therefore an ordinary transport for its destructor (5.5): it ends
cleanly when the load is dropped at the building (+0x30 = −1), and when it ends early (another
order, a move, go home, the unit's death, a refusal) the carried good goes back to the **front of
the building's needed list with one list-1 request**, unless the building is a completed store.
So the needed entry removed by the acceptance test above is restored whenever the delivery does
not happen. The transport request that belonged to the removed entry is not withdrawn: the
dispatcher serves it for another entry of the list, or drops it when the list is empty (5.3).
Ordering a carrier to a site again while he is already delivering there removes one more entry
and re-files the old one (net: the same needed list, one spare request).

A plain **move order** (group move `00465ad0`) gives every unit a follow-path job (0x06) to a
free cell near the target point, scheduled after 2 ticks. Units already within half the group's
spread of the target are not moved. Group membership (+0x48) is cleared when the group object
dies (`004657c0`). After arriving, the unit has no job and counts as free again (5.4).

**Go home** (`MOVEHOME` on the unit page, command class **0x20**, `00451c40`; C) is a walk, not an
entry:

1. It acts on the **first object of the sender's selection** (no payload) and does nothing if
   nothing is selected, if that unit is inside a building (+0x6C ≠ 0, so also while it is on its
   way out) or if the player has no **current town** (player +0x258, the town chosen in the town
   list; not the unit's own town and not its home house).
2. The unit's current job is cancelled.
3. The goal is the first cell of the square spiral of 4.8 around the current town's position
   (town +0x28/+0x2C: its town hall's anchor), starting at that cell, then ring 1 from (x+1, y−1)
   through +y, −x, −y, +x, ring 2 from (x+2, y−2), and so on, whose flags miss the unit's
   path-search mask (+0x28, normally 0x3C: no building, nature or special object, no water; units
   do not count). There is no ring limit. With the anchor inside the hall's footprint this is in
   practice the first footprint-free cell of the ring around the hall.
4. A follow-path job (0x06) to that cell becomes the unit's job, first run after **1 tick**. On
   arrival the unit has no job (idle, free as after a move order).

It does not enter the town hall or the house, does not change the unit's home or town, and is
the same for every unit type (a porter, a soldier, a founder). A criminal shows no unit buttons
(`docs/ui/side-panel.md`), so it cannot be sent.

**Explicit versus automatic work.** A porter with any job (for example an ordered harvest) is
not free, so the dispatcher ignores it. A harvest started by an order keeps auto-continue
(7.1), so the porter keeps picking until nothing of that class remains within reach. This is the
handbook rule that "an explicitly ordered porter ignores automatic work" (C).

### 3.3 Animation per job

The simulation tells the display which animation to play through messages. The simulation
itself never waits for an animation to end; every duration is a fixed tick delay (C).

| situation | action played | how |
|---|---|---|
| walking | 0 `MG`, or 4 `CA` while carrying | unit+0x40 is the base movement action. It is set to 4 when goods are picked up (`00476a70`) and recomputed from the carried amount when the unit leaves a building (`004613f0`). Message (7,7) carries it |
| turning on the spot | current base action | facing message (3,6) |
| builder working | 2 `WO` | message (0x19,11) with loop parameter 0x4000 ("until stopped"), stopped by message (0x27,11) when the builder relocates or ends (`00477ce0`, `00477b90`) |
| felling a standing tree | 2 `WO` for 100 ticks | `00476a70` |
| harvesting one unit | 2 `WO` (or 1 `ST` if the unit type has no work sprites), 100 ticks | `00476a70`. The choice depends on a per-race, per-type sprite table at `004b3914` (I) |
| farmer planting | 2 `WO`, 50 ticks | `0047ead0` |
| attack | 1 `ST` | combat jobs |
| idle fidget | 3 `ID` | job 0x1F. Created for a unit without a job by command 0x2A (`00452000`), which the viewing client sends from a wall-clock timer (4.9, unit-motion.md 4), and by animals (7.7) |
| animal eating | 3 `ID` (facing 3), repeat count 99 | eat job 0x2A (7.7.1): 100 ticks, then the bite; cut by the next walk |
| inside a building | not drawn | except garrison units of an outpost, drawn on top of it with their facing and strike action (`docs/rendering/objects.md` 13) |

The record's sound (+0x08) plays at frame +0x04 of action +0x134 (see odb.md).

---

## 4. Movement

### 4.1 Path following (job 0x06, `00480410`) (C)

- The goal cell comes from `0047b030` (4.8) or from the caller; the path comes from the planner
  `0047fe70`, using the job's planning mask (normally the unit's +0x28). When a step is blocked,
  the path is re-planned (`0047f520`, `0047fc00`). After 15 plans the job fails.
- Before each step the unit turns toward the next cell (`00474260`). It turns one direction
  (45°) per call. A turn costs max(1, step_time[0] / 4) ticks, which is 1 tick for all units.
  If the remaining angle is 45° or less, the facing is set without delay.
- **Step delay**: s = step_time[class], where the class comes from the height difference (see
  odb.md 2.3). Then:
  - **s + 1** normally;
  - **s − 1** when the target cell carries the **path flag** (cell flag 0x01 = bit 0x01 of the
    cell's flags byte +2; set only on paved cells: a building's foundation ring, 6.6, or a worn
    path, 4.5), or when the unit's current job is 0x08 (attack, i.e. charging).

  A diagonal step uses the table at 0x4AF3D8 (floor of 1.5 × value). On flat ground a porter
  therefore needs 6 ticks per straight cell and 9 per diagonal cell, about 0.57 s and 0.86 s.
- odb.md quotes step = step_time[class]. That is the value used by "step aside" (`0047df70`).
  Normal path following adds +1 as above.
- The step itself (`004621c0`) moves the unit at once in the simulation. It sends a step message
  whose display interpolation lasts delay × tick_ms (`00455720`). The unit therefore occupies the
  destination cell for the whole step, and the cell it left is free at once (4.7). How the display
  draws the step, including the visible pause at every cell, is in
  `docs/rendering/unit-motion.md` 2.
- Order of one run of the job (`00480410`, checked in the disassembly):
  1. owner dead: the walk ends without success;
  2. a step-aside child (4.7) is run first, if there is one (see 4.7 for its outcome);
  3. the unit stands on the goal: success;
  4. the planner is still working: return 2 (poll);
  5. no usable path (a fresh job, or the last search failed): plan (below), or fail after 15
     plans;
  6. otherwise leading path cells equal to the unit's own cell are dropped (an emptied path is a
     success). The next path cell must be a **neighbour** of the unit's cell. If it is not, the
     stored path is dropped and **the walk ends at once without success** (it does not re-plan;
     corrected October 2026). A walker is never pushed by others (only idle units are, 4.7), so
     this happens only when the unit was moved while its walk was paused: a flee or a fight in
     front of a suspended job (`combat.md` 7.4). Then the unit turns (4.6). If it turns by more
     than one step it waits and does not step in this run. Then it tests the next cell's flags
     against its movement mask +0x24 (4.7). A free cell is stepped onto; a blocked cell goes to
     the blocking rules of 4.7.
- **Planning** (`0047fc00`): a new plan is started when the job has no path, after a search that
  failed, and after every blocked step that cannot be waited out. Each plan raises the job's
  retry counter (+0x3C) by 1 and returns a delay of 3 + the old counter (3, 4, 5, ... ticks).
  While the planner works, the job polls every 2 ticks. The planner (`0047fe70`, run `004706e0`)
  is a separate object that searches from both ends at 100 node expansions per run and gives up
  after 2000 *(I: the per-run budget and its scheduling were not traced further)*. Animals
  (class 7) use another planner queue and mode.
- **A walk made from a ready path** (`0047f320`, used only by the attack job, `combat.md` 3.3.1):
  the goal is the path's last cell, the plan counter starts at 1 and the path is taken over from
  the cell after the first stored cell that shares the unit's x **or** y. No match: an empty walk
  that succeeds at its first run. Its first run happens in the run that creates it, so the first
  turn or step comes at once, without the 3-tick planning delay of an ordinary walk.
- **Two planning modes** (the mode argument of `0047fc00`, kept by the planner and read by its
  cell test `004717a0`) (C):
  - **mode 1, "ignore units"**: the first plan of a walk, and the plan that follows a failed
    search. Cells are tested against the job's planning mask (+0x40 = the unit's +0x28 = 0x3C:
    buildings, nature objects, specials, water). Units do not count anywhere;
  - **mode 0, "avoid nearby units"**: every re-plan after a blocked step (4.7, all four cases)
    and after a failed step-aside child. The unit bit 0x02 is added to the mask for every cell
    whose distance from the walker's **current cell** satisfies 2·max(|dx|,|dy|) +
    min(|dx|,|dy|) < 32 (wrapped deltas; about "max + min/2 < 16"). Units farther away are
    ignored.
  - In both modes the **start cell and the goal cell are never blocked**, whatever stands on
    them.
  - A mode-0 search that finds nothing (all ways nearby are filled with units) is not a failure
    of the walk: the job's next run plans again in mode 1 (which costs another plan).
- **Planner costs** (`004717a0`, `004714e0`) (C for the terms, I for the exact search order):
  entering a cell costs the walker's step time for the slope class (record +0xC4, 4.1), doubled
  on a cell without the path flag 0x01 and single on a paved cell, so paths and foundations
  (4.5, 6.6) are preferred. For animals (class 7) a paved cell costs four times the step time
  instead, so animals avoid paths. A slope class with step time 0 is impassable. Each node also
  carries a move count (+2 straight, +3 diagonal) and the priority is move count + 4 × (cost of
  the last step + doubled distance to the other end of the search). Our A* only has to be
  deterministic and keep these preferences; it need not reproduce the order of expansion.
- **Arrival tolerance**: before re-planning, the job measures the distance (max + min/2) from the
  unit to its goal. If it is **not greater than the retry counter**, the job ends with success
  instead. After the first plan the counter is 1, so a unit whose last cell is taken by a busy
  unit stops one cell short, and that counts as arrived. After 15 plans the job fails.
- **What a failed walk means.** The follow-path job reports failure (+0x19 = 0) after 15 plans,
  when its next cell is not a neighbour, when the owner died, or when the cell of a blocking unit
  holds no object (a degenerate case of 4.7). Most callers do **not** treat this as a failure of
  their own task (C):

  | caller | after a failed walk |
  |---|---|
  | go-to 0x07 (transports, worker answers, leisure visits, harvest approach) | ignored: it turns to the target and, for a building, asks to enter (4.2) |
  | enter job 0x0B, last walk onto the entrance | ignored: the unit enters wherever it stands (4.10) |
  | builder 0x0C, walk to the next spot (6.4) | phase 4: the builder walks to the door and ends |
  | attack 0x08 | the search and stored path are dropped; the next run re-evaluates (`combat.md` 3.3) |
  | flee 0x26 | the outward or home walk simply counts as done (`combat.md` 7.3) |
  | a plain move order (top-level 0x06) | the unit stops where it is |
  | animal walk (7.7) | phase-specific; no tolerance |

### 4.2 Go to object (job 0x07, `0047ac90`) (C)

1. Target cell: the building entrance (+0x70) for buildings, otherwise the object's position.
   The job plans a path (0x06) to it.
2. When the walk child ends, **whatever its result**, the unit turns to face the target. The
   walk's success flag is not read (checked in the disassembly at `0047acea`): a walk that failed
   after 15 plans, or ended because its next cell was no longer a neighbour (4.1), leads to the
   same turn from wherever the unit stands.
3. For a building it then runs "enter building" (0x0B). The success of 0x0B is the success of
   0x07.
4. For a nature object it succeeds at once. (For a unit as target it ends without success.)

So a go-to to a building fails only if the building dies or refuses the unit at its first door
request (4.4). Walking problems never make it fail; they only cost time (up to 15 plans here and
up to 15 more in the enter job's last walk, 4.10).

### 4.3 Store selection (C, `0045b3f0`)

"Nearest store" means the best of the town hall and all completed warehouses. Markets are never
chosen even though they carry the store flag. Score = distance + 2 × (number of units waiting in
that building's door queue).

### 4.4 Door queue: the "queues at the town hall" (C)

Entering is handled by building vtable +0x10 (`00460d10`, request entry), +0x14 (`00460a10`,
may this unit enter?) and +0x18 (`00460ed0`, unit entered).

1. On its first request the unit is checked and appended to the building's door queue
   (+0x60). (The door sprite's open/close messages, 0x2B/0x2C/5/0x64, and the door counter
   +0xAC: `docs/rendering/objects.md` 4.1.)
2. A news seller (unit type 20) entering any building other than a news stand (type 51) ends at
   once ("done", request result 3, a **success** without entry). The test comes first, before the
   may-enter test and the queue, so it holds at houses (which would refuse him) and at a school:
   a news seller can never enter a training building (8.6).
3. **Only the head of the queue may enter.** Every other unit gets "wait" and asks again after
   **10 ticks**. Dead units at the head are dropped.
4. The head:
   - A builder (job 0x0C) is "done" without entering.
   - At a construction site the head "enters" without the door animation.
   - Otherwise the door opens (`00460e10`) and the unit enters.
5. When the unit has entered, the head is removed from the queue.

Who may enter (`00460a10`), same race:

| building | allowed |
|---|---|
| construction site (state 1) | **only** builders (unit type 11) and units whose **current** job (+0x30) is a transport (type 5); everyone else is refused. This is the first test for a site, so a site of a house or a town hall uses it, not the residence rules below (C, instruction level `00460a41`..`00460a5f`) |
| training building (class 5) | everybody |
| any building | units on a builder job; units on a transport job (if they carry goods and there is no room, advisor mentor#17 "stores full" fires, but entry is still allowed); the building's operator type, while the building is not active or when this unit is the current operator |
| visit building (flag 0x8) | porters |
| police station (54) | criminals |
| outpost (class 6) | ranged units (class 2: types 29, 32, 33, 36 of every race) while occupants < +0xDC. The capacity is tested only at the unit's first request, so units already queued all get in (`combat.md` 9.1) |

Other race: only units on a trade job (0x20) or an operator errand (0x38).

What the "unit entered" step (`00460ed0`) does with an admitted unit, in this order (C):

1. A unit whose job chain holds a transport job (0x05): its goods are handled, then it is
   ejected at once (4.10). Nothing below applies.
2. At a construction site (state 1): nothing else (no occupant list, no message).
3. The building's **operator type** (own race): activation and operator job (8.1). The unit is
   added to the occupant list.
4. Any other unit is added to the occupant list (and stays inside, with no job) **only** in:
   a **training building (class 5)**, a building with **resident places** (+0xB4 > 0), a visit
   building (flag 0x8) for a porter, the police station (54) for a criminal, an outpost (class 6)
   for a ranged unit (class 2, with the garrison job). In a training building this holds for
   **every unit type** (builder, operator, soldier, founder, diplomat...), whether or not an order
   is queued: the check is on the building class only, not on the unit type, the race of the
   unit or the queue. Training buildings have no operator type (record +0xD8 = −1), so step 3
   never applies to them.
5. A unit entering a building of another town of its race through a go-to (0x07) is resettled
   (3.4) before it is listed.

Nothing in the step ejects a non-transport unit: a unit kept inside leaves only through the
send-out command (4.11), its retype in a training building (9), the building's loss (collapse
`combat.md` 10.3), deactivation of an operator (4.11) or a building job that lets it out (visit
job 8.3, AI job assignments). There is **no capacity** for training buildings: the may-enter test
has no count for class 5, so any number of pupils can be inside (only the outpost has a capacity).

#### Residences: houses and the town hall (C, `00460a10`, `00460ed0`, `0045fa40`, `004606e0`, `00461690`, `00478cb0`)

The buildings with resident places (+0xB4: small house 37 and large house 38 with 3 / 9, town
hall 40 with 3) keep every unit they admit (step 4), but their **door admits few units**. The
may-enter test above, read for them (completed, same race):

| unit | small / large house (flag 0x8, no operator) | town hall (flag 0x1, operator = founder 10) |
|---|---|---|
| on a transport job (carrying or collecting goods; the town hall is a store) | admitted, goods handled, ejected at once | same |
| on a builder job (repair) | admitted to the queue, "done" at its head without entering (step 4 of the queue) | same |
| porter (9), any job (leisure visit, a player's order) | **admitted, stays** | **refused** (no flag 0x8) |
| founder (10) | refused | admitted while the hall is **not active**, or if he is its stored operator; he becomes its operator (8.1, 11.4) |
| anyone else (builder, gatherer, soldier, diplomat, criminal, a second founder at an active hall...) | **refused** | **refused** |
| other race | only on a trade (0x20) or errand (0x38) job | same |

A refused unit is not queued: its go-to job fails at the door and it stands **idle in front of
the door** (3.2). Nothing enters, nothing is drawn going in. In particular a builder, a soldier or
a gatherer cannot be sent into a house or the town hall at all; "go home" (`MOVEHOME`) does not
try to (3.2: it walks to the town hall's surroundings).

There is **no capacity test** at the door for residences: the resident count (+0xB4, the homes of
3.3) is unrelated to who is inside. Any number of porters can be inside a house; they are not
residents, do not take a home, and do not change the population, births, needs or the house's
"Belegt" count. Residents themselves are normally outside: a home is a link, not a place (born
units are created inside and ejected at once, 4.10 "Births").

**What a porter inside a house does: the shared job slot.** A building has one job slot
(+0x30). An active residence uses it for its **house job** (0x0A, 599 ticks, `004606e0`: houses
homeless units, rolls births) from activation until the building is full; the job then returns 0
and the slot is cleared (base job destructor `00482210`). The visit job (0x22, 8.3) is created when
a porter enters a flag-0x8 building **only if the slot is empty**. So:

- a porter entering a house that is **not full** (house job running) gets no visit job and stays
  inside, idle. The leisure job never sends a porter to such a house (5.7: its candidates are
  active buildings whose slot is empty or holds a 0x22 job), so this happens only to a porter
  ordered in by the player, or to a leisure visitor whose house lost a resident while he was on
  his way;
- a porter entering a **full** house starts the visit job (if none runs): 299 ticks later it
  ejects the **last** porter of the occupant list, then one more every 299 ticks while units are
  inside; with no porter inside it ends;
- porters already inside when a house becomes full are not released until another porter enters
  (starting the visit job), one of them is called away, or they are sent out;
- when a **resident leaves** its home (death, resettling, a founder leaving, `00461690`) and the
  slot holds a visit job, **every occupant is ejected** (in list order) and the visit job ends;
  then, if the slot is empty, the house job is started again (599 ticks).

A leisure visitor inside (+0x78 = −1, no job) is free for the dispatcher (5.4): a transport or
worker request calls it out through the leave job (1.2). A porter ordered in by the player
(+0x78 ≠ −1) is not free: he stays until a visit job, an eject-all, the send-out command (4.11)
or the building's loss gets him out. The town hall keeps only its founder (operator); a town hall
has no visit job.

The extra cost of 2 × queue length in store selection spreads porters over warehouses. A
reimplementation must keep the one-at-a-time door and the 10-tick retry; otherwise the
handbook's "units can jam at the town hall" behaviour will not appear.

Leaving (job 0x0D), in short (full rules, timings and births in 4.10):

1. The leave job runs 10 ticks after the eject. The door opens and the job waits 10 ticks.
2. The unit is put on the entrance cell if that cell is empty. An idle unit standing there is
   pushed aside; anything else is waited for in 5-tick polls. After three polls the unit takes
   the nearest free cell instead. A unit is never put on a taken cell.
3. The exiting unit faces **3 if door_dx < 0, otherwise 5**.

### 4.5 Worn paths (C, `00448690`; Gold `0044c7d0`)

Busy routes turn into paths over time, and paths make every unit faster (4.1). The roll is part
of the map-placement function that puts a unit's display object on a cell. That function runs
whenever a unit is put on a cell:

- when the unit is created on the map ("object created" handler `004552c0`);
- on **every step**, for the destination cell (step handler `00455720`);
- when the unit leaves a building (`00435410`).

For every such placement of a unit (record kind +0xA4 = 0), in this order:

1. Draw `rand() mod 10`. GOG draws this for **every** unit placement, whatever the unit type,
   because the roll is tested before the type.
2. The cell becomes a path only if all of these hold:
   - the roll is 0;
   - the unit type (+0xA8) is one of 9 porter, 17 hunter, 19 woodcutter, 27 stonemason,
     28 trader, or 29..36 (all soldier types). Any race and any owner counts, including computer
     players and foreign units. Builders, founders, criminals, diplomats, farmers, tamers,
     scouts, scholars and the other civilians never wear paths. Animals are nature objects (kind
     2) and never do either;
   - the cell's height is **below 250** (so mountain tops and cells at exactly 250 stay as they
     are);
   - the cell's tile is not already a weg tile (any of the 9 tiles of class 10, terrain-gen.md).
3. If so: tile := weg tile `rand() mod 8` (weg tiles 0..7, uniform; the 9th weg tile and the
   `.os` weights are not used), and the cell gets the **path flag** (0x01) and the **dirty bit**
   (0x40) in its flags byte (`fog-of-war.md` 1.1).

A worn path changes the tile only. Height and light stay the same. Nothing ever turns a path
back into grass.

Consequences:

- A qualifying unit paves an unpaved lowland cell with probability 1/10 per step onto it. A route
  that porters and gatherers walk ten or twenty times is mostly path. From then on every unit
  steps onto it with s − 1 instead of s + 1 ticks (4.1): a porter's straight step drops from 6
  to 4 ticks on flat ground.
- Lake shores are weg tiles from terrain generation but carry **no** path flag (the generator
  never sets it). A unit stepping onto a shore cell does not pave it, because its tile is
  already weg, so shores never become fast (C; quirk).
- The original runs this inside the display handler, on each machine for its own copy of the map
  (6.6, "Network"). Each machine therefore paves its own random cells *(I)*. Only the
  simulating machine's flags affect movement.

**Gold Edition (paths)** (`0044c7d0`): the hard-coded type list is replaced by a record flag: unit
record +0xB8 bit 0x80 ("wears paths"). The roll is drawn only for records with that bit, and the
kind is not tested. The Gold `dv.odb` sets the bit on types 9, 17, 19, 27 and 29..36 of all three
races, and on 28 (trader) **only for the Amazons** (Händlerin). In Gold, Pimmon and Sajiki traders
do not wear paths. The GOG `dv.odb` has no 0x80 bits, and GOG uses the fixed list above.

### 4.6 Facing and turning (C, `004741d0`, `00474260`, `00477760`)

The facing (unit +0x1C) is simulation state: turning costs ticks before steps and strikes.

- **Numbering** (table at unit +0x1C in section 2): 0 (−1,−1), 1 (−1,0), 2 (−1,+1), 3 (0,+1),
  4 (+1,+1), 5 (+1,0), 6 (+1,−1), 7 (0,−1). On screen that runs clockwise from "up"
  (`docs/rendering/unit-motion.md` 1.1 has the screen directions and the sprite check).
- **Direction to a target** at wrapped delta (dx, dy): 3 or 7 (by the sign of dy) when
  |dy| ≥ 2·|dx|; 1 or 5 (dx < 0 or > 0) when 2·|dy| ≤ |dx|; otherwise the diagonal 0, 2, 4 or 6
  of the signs. A zero delta gives no direction and the facing stays.
- **Turning**: the short way round. For exactly 180° it counts down when target > current and up
  when target < current. A difference of 45° is set at once. Larger differences move one step per
  call, at max(1, step_time[0] div 4) ticks per step: 1 tick for every base-game unit. 90° costs
  1 tick, 135° 2, 180° 3. Every change sends the facing message (3,6).
- **Users**: path steps (4.1); step aside (4.7); the final turn toward the target of go-to (4.2)
  and harvest (7.1, phase 6); the builder's turn toward the site; the turn/idle job 0x1F (4.9);
  the strike job (`combat.md` 4.1, its own delay floor(step_time[0]/2)). Leaving a building sets
  3 (door_dx < 0) or 5 directly (4.10). Entering turns toward the building's anchor cell first
  (4.10).

### 4.7 Cell occupancy, blocking and stepping aside (C)

#### One object per cell

A map cell stores **one object index** (16 bits; 0xFFFF = empty). Units, buildings (every
footprint cell) and **every nature object** write their index when they are put on a cell
(`00448690`). Removing an object writes 0xFFFF (`004488e0`). A unit's index moves at the start of
every step (`00455720`): the old cell is cleared and the destination is written. The occupancy
flags are derived from the index (`00447f20`, `00451510`):

| flag | object on the cell |
|---|---|
| 0x02 | a unit (record kind 0) |
| 0x04 | a building |
| 0x08 | a special object 0xF000..0xF00F |
| 0x10 | a nature object: tree, bush, crop, stone, rubble, goods pile, **animal (alive or carcass)** |
| 0x20 | water tile (from the tile byte, 6.1) |

Every object gets the same two masks at creation (`00461a40`): a **movement mask** (+0x24) of
**0x3E** and a **planning mask** (+0x28) of **0x3C**. So:

- **First plans ignore units.** They avoid buildings, nature objects (animals included) and
  water. Re-plans after a blocked step also avoid the units near the walker (4.1 "Two planning
  modes", and below).
- **A step never enters a cell that holds another unit**, nor a building, a nature object or
  water.
- Two units never share a cell by walking, and **not by leaving a building either**: the leave
  job puts a unit down only on an empty cell (4.10). Births appear through the same leave job.
  Because the world view draws only the object whose index is on a cell (`objects.md` 12), a
  second unit on a cell would not even be drawn in the original.

Our build follows this since the motion rework (`src/engine/motion.ts`, `world.ts blockCells`;
`docs/architecture/simulation.md` "Movement").

#### A blocked step (`0047f520`)

The walker's next cell fails the movement mask:

1. **Blocked by something the planner also avoids** (a building, nature object or water, i.e.
   the map changed since planning): re-plan in mode 0 (4.1), or fail after 15 plans.
2. **Blocked by a unit that has no job at all** (idle: object +0x30 = 0): the walker gets a
   step-aside child job (0x0F), the blocked cell is **taken off the front of its path** (the rest
   of the path is kept), and the run returns 1. That job is given a **forbidden list**:
   - the walker's 8 neighbours except the blocked cell;
   - the walker's next two path cells after the blocked one;
   - the walker's own cell.

   The child's only remaining candidate is the blocked cell, which holds the idle unit. So the
   child hands the idle unit a step-aside job of its own (below). It then waits in **5-tick
   polls** until that unit has moved, and finally steps into the freed cell. That step takes
   step_time[class], or the diagonal table value, **without** the +1 of normal walking. When the
   child succeeds, the walker **goes on along the rest of its old path** from the freed cell: no
   re-plan, no plan counted (corrected October 2026; earlier text said it re-plans). When the
   child fails (more than 4 pushes, nothing free, owner or requester dead), the walker re-plans
   in mode 0, or fails if 15 plans are used up.
3. **Blocked by a unit whose current innermost job is a follow-path job** (a moving unit,
   `0047faa0`):
   - the other unit's planner is still running: wait **3** ticks and try again;
   - the other unit has a path, and its next cell is free for it (its movement mask 0x3E, so no
     unit there either) and passable: wait that unit's **raw step time + 1** ticks
     (step_time[class] for a straight step, the diagonal table value for a diagonal one; the
     ±1 of 4.1 is not included) and try the same step again. No plan is counted;
   - otherwise (it has no path, its last search failed, or its own next cell is blocked, for
     example by this walker): re-plan in mode 0.

   A unit whose innermost job is a step-aside child (it is itself squeezing past someone) is not
   "walking" in this sense: case 4.
4. **Blocked by a busy unit that is not walking** (working, fighting, turning, inside an
   action, squeezing): re-plan in mode 0. That plan treats the busy unit as an obstacle unless
   its cell is the goal. If the busy unit stands on the goal, the new path still leads to it and
   the arrival tolerance of 4.1 ends the walk next to it.

Busy and walking units are **never pushed**: only a unit with no job at all gets a step-aside
job (cases 2 and the step-aside chain below).

#### Head-on meetings and jams (C by code reading; frequency in the original not measured)

Nothing makes one of two walkers yield, and no rule steps a walking unit aside. What prevents
lasting deadlocks is the combination of:

1. **mode-0 re-plans**: a blocked walker plans around every unit within about 16 cells (4.1),
   so in open ground it takes a detour around the walker coming the other way;
2. **failed searches are not failures**: if no detour exists, the next plan ignores units again;
3. **the growing arrival tolerance**: every plan raises the counter, and a walk whose goal is
   no farther than the counter ends as arrived;
4. **walk failure is harmless to its callers** (4.1 table): a transport, a worker answering a
   request or a leisure visitor goes on to the door request regardless.

Example, two porters meeting head-on in a corridor one cell wide (water on both sides), A going
to a site 10 cells beyond B:

- A's next cell holds B, and B's next cell holds A. Each finds the other "walking but unable to
  step" (case 3, last bullet) and re-plans in mode 0. Inside the corridor that search finds no
  way (the other porter fills the only cell) and fails.
- Next run: plan in mode 1 (units ignored): the same corridor path. The first step is blocked
  again, and the cycle repeats. Each cycle costs two plans and 3 + counter ticks per plan.
- As soon as the counter reaches the remaining distance, the walk ends as arrived; otherwise it
  fails at 15 plans, after roughly 150 to 200 ticks.
- A's go-to ignores the result, turns toward the site and asks to enter. A site has no door, so
  the head of its queue is admitted at once; the enter job plans a last walk onto the entrance
  (counter starting at 0 again), which may meet the same jam and end the same way. Then A
  **enters from wherever it stands**: the goods are delivered (5.5).

So in the original a jam costs time (up to about 40 s for the two walks) but never loses a
transport or a good. If B leaves the corridor meanwhile, A simply walks on.

#### Step-aside job (0x0F, `0047df70`)

Fields: requester (+0x24, the unit to make way for), pushed unit (+0x28), forbidden cells
(+0x2C list), mask (+0x4C = the requester's planning mask), attempts (+0x50), start cell
(+0x54..+0x5C).

Each run:

1. Fail if the owner or the requester is dead.
2. **Success** as soon as the owner is no longer on its start cell.
3. If the owner has pushed another unit, and that unit still runs a step-aside job for this
   owner and has not moved yet: wait **5 ticks**. Otherwise forget it.
4. Fail after more than **4** pushes.
5. **Candidates** are the owner's 8 neighbours in this fixed order: (x−1,y), (x−1,y−1),
   (x,y−1), (x+1,y−1), (x+1,y), (x+1,y+1), (x,y+1), (x−1,y+1). A candidate is dropped if its
   flags meet the mask, i.e. it holds a building, nature object, special or water, or if it is
   in the forbidden list.
6. Take the candidates in order:
   - an **empty** cell whose step time for the slope is not 0: turn toward it (4.6). Once the
     turn is done, step there with step_time[class] (or the diagonal value). Return that
     delay;
   - a cell holding an **idle** unit: remember it;
   - a cell holding a busy unit: skip it.
7. If no cell was empty but an idle unit was found, the **first** such unit is pushed: it gets a
   step-aside job (scheduled after 1 tick, set as its current job) with this job's owner as
   requester. Its forbidden list is this job's list plus its own cell. The attempts counter goes
   up and the run returns 5.
8. Otherwise the job fails.

So an idle unit in the way moves to the first free neighbour, in the order above, that is
neither next to the walker nor on the walker's next two cells. If none is free, it pushes the
next idle unit, and the chain can continue. The pushed unit ends with no job, on its new cell.

#### Moves of a group (`00465ad0`)

A move order computes **one** target cell: the first cell of the square spiral (4.8) around the
clicked point whose flags miss 0x3E. Every unit of the group gets a follow-path job to **that
same cell**, unless it is already within half the group's spread of it. The units then spread
out through the rules above: the first to arrive takes the cell, later arrivals push it aside
while it is idle, and the arrival tolerance stops the rest around it (C by reading; the shape
that results was not observed).

### 4.8 Where workers stand (C)

**Go-to target cell** (`0047b030`, used by go-to 0x07 and thus by harvest, hunters on carcasses,
transport and entering). Target point P = the object's cell, or the entrance cell for a building.
The candidates are P, (x, y−1), (x−1, y), (x, y+1), (x+1, y), in this order. The first whose
flags miss the walker's **planning** mask 0x3C is the goal. Units do not count here. If none
qualifies, a ring search (`0047a9b0`) finds the nearest cell that qualifies.

- A tree, bush, stone, crop, pile or carcass has the nature flag on its own cell. A worker
  therefore walks to the first free **orthogonal** neighbour in the order N(y−1), W(x−1),
  S(y+1), E(x+1), never onto the object.
- Two workers sent to the same object pick the **same** neighbour, because units are not in the
  planning mask. The second is blocked at the last step by the first, who is busy working.
  Under 4.7 case 4 it then stops one cell short.

**Harvest, phase 1 check** (`00476a70`): after the walk the worker must be within **one cell on
both axes** of the target (diagonal neighbours count). If not, it searches for the first cell
around the target whose flags miss **0x3E** (no unit, building, nature, special or water) and
walks there. The search is a square spiral:

1. the target cell;
2. then ring 1: (x+1, y−1), (x+1, y), (x+1, y+1), (x, y+1), (x−1, y+1), (x−1, y), (x−1, y−1),
   (x, y−1);
3. then ring 2 from (x+2, y−2) in the same turning order (+y side, then −x, then −y, then +x),
   and so on outward, with no limit.

This is how several woodcutters spread around one tree. The first takes the north neighbour.
The next either stops next to it (diagonal or orthogonal to the tree) and works from there, or
moves on to the first free ring-1 cell in the spiral order. Phase 6 then turns each worker to
face the target (4.6).

**Hunters** (`combat.md` 3, 14): the attack job finds a firing position: in range, outside the
animal's cell, which is nature-flagged and cannot be entered. After the kill the carcass stays a
nature object on its cell, and the hunter walks to it with go-to (rules above), then picks up
the meat from the neighbour cell.

**Builders** (`00478350`): around a footprint with max corner (X, Y) and sizes size_x
(+0x10) and size_y (+0x0C), the builder cycles through four spots, the middle cell of each side
of the ring. The job's side counter (+0x40) starts at 0 (constructor `00477a80`) and doubles as
the facing of the phase-0 turn; `00478350` advances it before each walk (5 → 0, 7 → 2, then + 1,
4 → 0), so the **first spot is the +x side** and the order below repeats (C):

| order | spot | faces |
|---|---|---|
| 1 | (X + 1, Y − size_x div 2): +x side | 1 |
| 2 | (X − size_x div 2, Y + 1): +y side | 7 |
| 3 | (X − size_x div 2, Y − size_y): −y side | 3 |
| 4 | (X − size_x, Y − size_y div 2): −x side | 5 |

Spot 1 takes its y offset from size_x. That matters only for non-square buildings (quirk). The builder walks to the spot with a plain follow-path (no go-to adjustment), then turns
to the listed facing. Several builders use the same spot sequence and are kept apart by 4.7.

**Animals** (7.7) choose their wander goal with the same 0x3E spiral around a random point.

### 4.9 Idle fidget command (C, command 0x2A `00452000`, job 0x1F `0047f030`)

The command carries an object id, a direction and a "play animation" flag. When it comes from the
viewing client's idle timer (`docs/rendering/unit-motion.md` 4.1), the direction is 3 or 5 with
the flag set, or random 0..7 without it.

- The command is ignored unless the unit **has no job at all** (+0x30 = 0).
- If the unit carries goods (+0x3C > 0), the play flag is cleared.
- Otherwise a turn/idle job (0x1F) is created with that direction, the flag, and repeat count 0.
  It becomes the unit's current job and is scheduled after 1 tick.

Job 0x1F, each run (only while the owner is alive):

1. One turn call toward the direction (4.6). Each change sends the facing message.
2. If the turn returned a delay, return it.
3. Otherwise: if the flag is set, send the action message for action 3, with event frame =
   record +0x04 and the job's repeat count (0 = one cycle). The job ends.

While the job exists the unit counts as busy (for example, it is not a free porter, 5.4). The job
lasts 1 to 4 ticks. Its status text is T278 "Ohne Aufgabe".

The idle animation itself runs only on the display and does not hold the unit. Animals create
the same job type from their own job (7.7), with direction 3, the flag set and repeat count 10.

**Determinism.** In the original the decision is made by the display: a wall-clock timer and C
`rand()`. The effect enters the simulation as a command, like a player order. In our lockstep
engine it must also be a command scheduled for a future tick. A simulation-side imitation would
need its own deterministic timer instead of the wall clock.

### 4.10 Entering, leaving and births: exact sequence and placement (C)

Sources: enter job `0047a0f0`, building methods +0x10 `00460d10` (request), +0x18 `00460ed0`
(entered), +0x1C `004613f0` (put outside), +0x20 `00460be0` (eject), leave job constructor
`0047a490` and run `0047a530`, nearest-free-cell search `0047a9b0`, births `00460830` with the
unit constructor `00463d00`, training end `00475ff0`, step aside `0047df70`. Display side:
`docs/rendering/unit-motion.md` 7. Door layer: `docs/rendering/objects.md` 4.1. Draw order:
`docs/rendering/objects.md` 12.

**Everything in this section is simulation (lockstep) state**: which cell a unit ends up on, on
which tick, its facing, who is pushed. Only the door picture and the moment the sprite disappears
or appears are display, and those follow the simulation's messages.

#### Where "the door" is

The **entrance cell** is the building's anchor (the footprint's max corner) plus the record's
door offset (+0x94, +0x98), wrapped (odb.md 2.2). It always lies in the ring of cells just outside
the footprint (6.6), in front of the door picture. Units never stand on, walk onto or are placed
inside the footprint. Pimmon examples:

| door offset | where the entrance is | buildings (Pimmon) |
|---|---|---|
| (−1, +1) | in front of the +y face (screen bottom-right side), on the front corner's screen row, 64 px (one cell) to its right | house, town hall, warehouse, embassy, animal farm, newsstand, mage tower, temple |
| (+1, −1) | in front of the +x face (screen bottom-left side), on the front corner's screen row, one cell to its left | laboratory, library, bank, small outpost, school, tavern |
| (−2, +1) | in front of the +y face, one cell further up that face | barracks, mushroom farm, market, circus, armoury |
| (+1, −2) | in front of the +x face, one cell further up that face | large house, distillery, mine, large outpost, police |
| (0, −1) | behind a 1×1 tower (its −y side, screen up-left) | watchtower |

A unit "inside" keeps the simulation position it had when it entered (normally the entrance
cell), but its object index is taken off the map, so the cell is free (4.7) and the unit is not
drawn.

#### Entering (go-to 0x07, then enter job 0x0B)

1. **Walk**: the go-to job walks to the goal cell chosen from the entrance (4.8: the entrance
   itself unless a building, nature object or water is on it). Units are not in that choice, so
   a unit queueing behind another is usually stopped one cell short by the arrival tolerance
   (4.1).
2. **Turn**: the go-to job turns the unit toward the building's **anchor cell** (its front corner),
   with the 1 : 2 sector rule and the turn costs of 4.6. The resulting facing is not "into the
   door": for door (−1, +1) it is 6, for (+1, −1) 2, for (−2, +1) 5, for (+1, −2) 3, for (0, −1) 3.
   When the turn is done the enter job is created; it runs 1 tick later.
3. **Request** (each run of the enter job): the unit joins the door queue (4.4). Not the head:
   "wait", re-ask after 10 ticks. Refused: the job fails. Builder, or news seller at a foreign
   building type: "done" without entering.
4. **Admission** (head of the queue): at a completed building the door counter (+0xAC) goes up by
   1 and, on 0 → 1, the door-open message is sent. The enter job then gives the unit a
   follow-path child to the entrance cell (the first cell of the 4.8 spiral around the entrance
   that the planning mask allows; in practice the entrance itself) and returns **5**.
5. **Last step**: 5 ticks later the child runs. A unit already on the entrance succeeds at once.
   A unit one cell off (queue, tolerance) now walks onto the entrance, with the normal blocking
   rules (4.7). The child's result is not checked: when it ends, the unit enters wherever it
   stands (checked in the disassembly, `0047a139`). There is **no distance test anywhere** in
   entering: neither the go-to (4.2), the request (`00460d10`), this step nor the "entered"
   handler measures how far the unit is from the door. A unit whose walks failed (a jam, an
   unreachable building) therefore joins the queue from where it stands, waits there, and enters
   from there when admitted. Normally the walks succeed and the unit is on or next to the
   entrance.
6. **Entered** (`00460ed0`): the building's per-type effects (operator, activation, resettling,
   visit, outpost garrison with display flag 4 and the outpost job, `combat.md` 9.2...) run
   first, then the "unit entered" message is sent, the door counter goes down by 1 and the unit
   leaves the queue. A unit on a transport job skips the per-type effects; its goods
   are handled after the message, and it is ejected at once. The message handler removes the
   unit's index from its cell (unless that cell is the building's own anchor), so the cell is
   free from this tick on (the handler runs synchronously on the simulating machine), the unit
   **vanishes from the drawn list at once**, and the door starts closing.

So a unit that walks straight up to a free door stands on the entrance cell for the turn
(0..3 ticks), +1 tick, then **5 ticks with the door opening**, and disappears. It never takes a
step toward or into the footprint.

**Construction sites** have no door: admission sends nothing, the "entered" step sends no
message, the unit is never taken off the map and stays drawn on the entrance cell. When it is
ejected (a porter after delivering), it is put back at its own position at once, without a leave
job, and its job is simply unblocked.

**Transport units**: when a unit whose job chain contains a transport job enters, that top-level
job is blocked for 10 ticks. After the goods are handled, a transport unit is ejected at once
(next subsection), so a delivering porter spends at least 20 ticks "inside".

#### Ejecting a unit (building method +0x20, `00460be0`)

Used for: transport units after delivery or pickup, births, trained units, the send-out command
(4.11), deactivation, collapse (`combat.md` 10.3), new jobs given to a unit inside (1.2).

- Construction site: see above (no leave job).
- Otherwise the unit is removed from the occupant list and gets a **leave job (0x0D)**, scheduled
  **10 ticks** later. If the unit already had a job, that job is queued behind the leave job
  (job +0x20) and blocked for 5 ticks if it was not blocked already. The leave job becomes the
  unit's current job. While it is current, any job the dispatcher hands out is queued behind it
  (1.2).

#### The leave job (0x0D, `0047a530`)

The job counts its runs (job +0x24). Each run:

| run | tick after the eject | what happens |
|---|---|---|
| 1 | +10 | (building only) door counter + 1; on 0 → 1 the door-open message is sent. Returns 10 |
| 2 | +20 | **test the entrance cell** (below) |
| 3 | +25 | test again |
| 4 | +30 | test again |
| 5 | +35 | test again; if still taken: **nearest free cell** instead |

**Test of the entrance cell.** The cell is "taken" if it holds **any** object index (a unit, or a
nature object such as rubble or a goods pile). Then:

- if it is a **unit with no job at all** (+0x30 = 0), that unit is pushed: it gets a step-aside
  job (0x0F) as its current job, scheduled after 1 tick, with **no requester**, the leaving
  unit's movement mask **0x3E**, and a forbidden list of {the leaving unit's stored position,
  i.e. the entrance; the pushed unit's own cell, also the entrance};
- a unit with any job (walking, waiting in its own leave job's successor, fidgeting...) and any
  non-unit object is **not** pushed;
- either way the run returns **5** (5-tick poll), up to run 4.

At run 5 a still-taken entrance is replaced by the first cell, in the square spiral of 4.8
(entrance, then ring 1 from (x+1, y−1) through +y, −x, −y, +x, then ring 2 from (x+2, y−2), and so
on; `0047a9b0`), whose flags miss **0x3E**: no unit, building, special object, nature object or
water. Slope is not tested.

**Putting the unit outside** (`004613f0`), on the first free test or at run 5:

1. the unit's "inside" link is cleared; its position becomes the chosen cell;
2. the "unit placed" message (0x64) carries the cell and the facing: **3 if the door offset x
   (+0x94) is negative, otherwise 5** (the unit faces away from the wall it came out of: door
   (−1, +1) → 3, (+1, −1) → 5; the 1×1 tower (0, −1) → 5). The facing is written into the unit;
3. the door counter goes down by 1 (balancing run 1);
4. if the unit is of the building's operator type **and of the building's race**, and either is
   not the stored operator (+0xA8) or the eject's "sent out" flag is set, the building is
   deactivated (`0045ff30`). The flag is set only by the send-out command and `DEAKTIVIEREN`
   (4.11); every other eject found (training, visits, transport, operator jobs) passes
   it cleared. Outposts: when the unit placed is class 2 and the occupant list is now empty, the
   outpost job (0x1C) is cancelled (`combat.md` 9.8);
5. the base movement action is recomputed: carry (4) with goods, else walk (0) (message (7,7)
   on change).

The message handler puts the unit's index on the cell, adds its vision, rolls the worn path
(4.5) and closes the door picture. In the original it runs synchronously on the simulating
machine, so the cell counts as occupied for every later job in the same tick.

The leave job then returns 0 and is deleted. The job queued behind it (if any) becomes current
and is unblocked (1.2). It runs at its next scheduler poll, which is up to its blocking period
(5 or 10 ticks) later *(I: the exact phase of that poll was not traced)*, so a unit that comes out
with work to do often stands on the entrance for a few ticks before walking off. Until then it is
busy and cannot be pushed, so the next unit waits in 5-tick polls.

**Consequences.**

- A unit is put on the map 20, 25, 30 or at the latest 35 ticks after it was ejected.
- **Two units never share a cell after leaving.** The leave job never places a unit on a taken
  cell, and the fallback cell is free by definition.
- A pushed idle unit moves to the **first empty neighbour** of the entrance in the step-aside
  order (x−1, y), (x−1, y−1), (x, y−1), (x+1, y−1), (x+1, y), (x+1, y+1), (x, y+1), (x−1, y+1) that
  holds no building, nature object, special object, water **or unit** (the mask 0x3E includes
  units, so this push never chains) and whose slope step time is not 0. It turns first (4.6). If
  there is no such cell the step-aside job fails at once, the unit stays, and the next poll
  pushes it again.
- Several units ejected in the same tick (births, collapse, a building emptied by deactivation)
  run their leave jobs in **ejection order**, because the scheduler runs one slot's jobs in
  insertion order. The first takes the entrance; each later one pushes or waits, so they come out
  about 5 ticks apart. The door opens once (counter 0 → 1) and every placement sends a close.
- Ejection order: births in birth order; a collapse ejects the occupants in occupant-list order
  (the order they entered); training ejects the one trained unit.

#### Births (`00460830`, unit constructor `00463d00`)

A born unit is created **inside** its home building: position = the building's entrance cell,
inside link = the building, added to the occupant list, home = the building (when it has resident
places). Its "object created" message has the "put on map" flag cleared, so the display creates
the sprite but puts no index on any cell: it is not drawn and blocks nothing. Then, unless the new
unit is of the building's operator type or the building is an outpost (class 6), the building
**ejects it at once**, through the leave job above. So every birth (houses, town halls, the
founding births of 11.4) appears 20..35 ticks after the birth, on the entrance or the spiral
fallback, facing 3 or 5, after the door opened 10 ticks before.

**Training output** (`00475ff0`, section 9): the first occupant is retyped in place and ejected
the same way. Its training order's goods are already consumed; the new unit has no job, so the
next unit to come out may push it aside.

#### Worked example: founding a Pimmon town (door (−1, +1))

Let A be the tick the founder arrives on the site entrance (11.3); T = 0..3 turn ticks.

| tick | event |
|---|---|
| A | site completed, founder plays his work animation, mentor#19; job returns 20 |
| A+20 | go-to child created |
| A+21 | go-to plans a path to the entrance (he is on it) |
| A+22 | the path ends at once (he is on the goal) |
| A+23 .. A+23+T | turn toward the hall's anchor, ending on facing 6; when the turn is done the enter child is created |
| A+24+T | admitted: door counter 0 → 1, door opens; follow-path child; returns 5 |
| E = A+29+T | **entered**: mentor#10, activation, births of builder, porter, porter (inside, ejected, three leave jobs at E+10); the founder vanishes, the door closes |
| E+10 | leave jobs run 1: counter 0 → 3, door opens once |
| E+20 | builder put on the entrance, facing 3; door close. Porter 1 finds him idle and pushes him; porter 2 finds him busy (step aside) and waits |
| E+21, E+22 | builder turns from 3 toward 1 (1 tick) and steps to (x−1, y) of the entrance |
| E+25 | porter 1 put on the entrance; porter 2 pushes him |
| E+26, E+27 | porter 1 turns (3 → 5, 1 tick) and steps to (x+1, y): (x−1, y) holds the builder, the next three candidates are footprint cells |
| E+30 | porter 2 put on the entrance |

If the dispatcher has already given the builder or a porter a job, that unit is busy when it
appears and is waited for instead of pushed; a unit that still finds the entrance taken at E+35
is put on the nearest free spiral cell.

#### Our build (implemented October 2026)

`src/engine/logistics.ts` (`enter`, `leave`, `runLeave`, `putOutside`), `world.ts spawnInside`,
`motion.ts pushFromDoor`; tests in `test/doors.test.ts`. Entering, the leave job with its door
messages, the 5-tick polls, the push without requester (mask 0x3E, never chaining), the spiral
fallback, the facing 3/5, births inside with the leave job, trained units, transport units
(>= 20 ticks inside), outpost garrisons (admission at the first request, staying inside, the
outpost job 20 ticks later; `combat.md` 9.10, `test/garrison.test.ts`) and the founding sequence
follow this section; the founding worked example is reproduced tick by tick. Remaining differences:

| point | original | ours |
|---|---|---|
| same-slot order | insertion order assumed above | the wheel is LIFO (`combat.md` 16.2): jobs ejected in one tick run their first runs in reverse order, their second runs (the first placement test) in ejection order again; later polls alternate, so at a founding the two porters may come out in swapped order (same timing, same cells) |
| eject outside a tick | n/a | a unit ejected between ticks (map loading, tests) has its first run 11 ticks later |
| operator leaving (`004613f0` step 4) | the building is deactivated when the unit is placed outside if it is of the operator type and race and either not the stored operator or "sent out" | only the "sent out" half is tested (leave job data word 2, set by `sendOut` and `DEAKTIVIEREN`, 4.11): a second operator-type unit is refused at the door of an active building (as the original); one admitted anyway (on a transport job) is bounced through a plain eject, which must not deactivate. The police dispatch keeps the station active (8.5; fixed October 2026, it used to deactivate at the eject) |
| add-on harbour / shipyard (door 0,0) | not traced | put on the nearest free land cell of its island at run 2, no polls |
| building gone while a unit is on its way out | not traced | put on the first free spiral cell around its stored position |
| nowhere free at run 5 | not traced | the job keeps polling every 5 ticks |
| admission (may-enter test, 4.4) | refused units fail at the door and stay outside | outposts refuse (`logistics.mayEnter`, `combat.md` 9.1, 9.10), (Gold) training buildings refuse ships, and a completed active building refuses a unit of its operator type and race that is not its stored operator unless it is on a transport, builder or gathering job (October 2026, 8.6); every other building admits everyone, who then comes out again unless a per-type effect keeps it |
| who stays inside (4.4 "unit entered") | operator, training building (everyone), residences (everyone admitted), visit building (porters), police (criminals), outpost (ranged units) | operator, training building (everyone of its race, `logistics.entered`; fixed October 2026, `test/retrain.test.ts`), porters in visit buildings and houses, outpost garrison. Not yet: a unit of another race kept in a training building |
| residences (4.4 "Residences") | the door refuses all but porters (houses), the founder (town hall), carriers and builders on the job | as the original (`logistics.mayEnter`, fixed October 2026, `test/residence.test.ts`). Our harvest and hunting jobs deliver without a transport child, so they are admitted like a transport job; the found-town job enters as the operator |
| go home (3.2) | command 0x20 on the first selected unit, toward the player's current town; follow-path job after 1 tick | `unit` command `home` with the current town carried in the command (`logistics.unitAction`); the walk is planned at once; the shared visit/house job slot and the eject-all on a resident leaving are as 4.4 "Residences" (`test/residence.test.ts`) |

### 4.11 Sending a unit out of a building (command 0x3A) (C)

Sources: inhabitants page item `0041be90` (`docs/ui/side-panel.md` class 9), command execution
`004520e0` (Gold `00457b70`, identical), per-type eject `00462f90`, eject everyone `00462fd0`,
eject `00460be0`, entered `00460ed0`, put outside `004613f0`, deactivation `0045ff30`,
`DEAKTIVIEREN` command `00450860`, training `00475d50`, visit job `00478cb0`.

#### The command

- Lockstep command class **0x3A** "send out" (a command id, unrelated to the Gold *job* 0x3A).
  Payload: **one signed 32-bit unit type**. −1 means "everyone"; the base game's UI never sends
  −1 (only the Gold ship button `AUSSTEIGEN`, `addon.md` 5.3).
- It carries **no building id**. It acts on the **first object of the sending player's
  selection** at the moment it is executed (same convention as the found-town command, 11.2).
- Sent by a left click on an item of the inhabitants page in building mode, with that item's
  unit type. One click sends one command and gets one unit out.

#### Execution

1. If the sender has nothing selected, nothing happens.
2. Type −1: the building ejects the **head** of its occupant list, again and again, until the
   list is empty, each with the "sent out" flag. No type is refused.
3. Type 12 (criminal): ignored, in every building. Type 10 (founder) when the selected
   building is a town hall (type 40): ignored. There is no message or sound for a refusal.
4. Otherwise the occupant list is walked from its head, and the **first** occupant whose unit
   type equals the parameter (any race) is ejected with the "sent out" flag. If there is none
   (it left between click and execution), nothing happens.
5. The sender's panel page is rebuilt. The unit left the occupant list in step 4, so its count
   drops at once, long before it appears outside.

Nothing else is checked: not the owner, not that the selection is a building, not the building
state. The UI offers the page only for one selected own building. **A rebuild should validate**
those points itself and carry the building id in the command.

#### Which unit is chosen

The occupant list is in **order of entering**, new occupants appended at the end. Send-out takes
the **first** match, the unit of that type that has been inside longest. (The visit job of 8.3
works the other way: it releases the **last** porter in the list.)

#### Who can be sent out

The occupant list (building +0x58, count +0x5C) is filled at the "entered" step (4.10 step 6).
Only units in that list can be sent out:

| unit entering | in the list? | sent out? |
|---|---|---|
| a unit whose job chain holds a transport job (porter delivering or collecting goods) | no: its goods are handled and it is ejected at once (4.10) | no |
| anyone at a construction site | no (a site keeps no occupants) | no |
| builder | never enters (4.10 step 3) | no |
| the building's **operator type**, own race | yes: it activates the building and becomes the stored operator (8.1) | yes; deactivates the building (below). The founder in a town hall is refused |
| the operator type, **other race** (a foreign diplomat visiting your embassy) | yes, until the embassy's operator job ejects it (8.3) | yes; no deactivation |
| anyone in a **training** building (class 5) | yes: pupils of any unit type, waiting or being trained (9.1), also with no order queued | yes |
| a **porter** in a house; the **founder** in his town hall | yes: leisure visitors and porters ordered in (a house admits no other unit type, the town hall only its founder; 4.4 "Residences"). `MOVEHOME` enters nothing (3.2) | yes (a founder in a town hall is refused) |
| a **porter** in a visit building (flag 0x8: houses, tavern, circus, temple) | yes: leisure visitor (5.7) | yes |
| a **criminal** in a police station (54) | yes (arrested) | **no**, type 12 is always refused |
| a ranged soldier (unit class 2) in an **outpost** (class 6) | yes: garrison | yes |
| anyone else | no *(I: such a unit is presumably refused at the door before)* | no |

Units away from their building (a diplomat on an offer errand, a news seller on his round, an
officer chasing a criminal) are not inside and are not listed. `DEAKTIVIEREN` handles them
(below).

#### The eject and what happens next

- The unit gets the normal eject of 4.10 at the tick the command is executed: removed from the
  list, leave job after 10 ticks (door opens), placed on the entrance after 20..35 ticks or on
  the nearest free spiral cell, facing 3 or 5. A unit inside normally has **no job**; if it had
  one, that job is resumed after the leave job (4.10).
- **At placement** (`004613f0` step 4): if the unit is of the building's operator type and of
  the building's race, the building is **deactivated** (`0045ff30`), always, because the "sent
  out" flag is set: upkeep and store capacity removed, a production job kept but idle (it does
  nothing while the building is inactive, 8.2), any other building job (operator / visit job)
  cancelled, the stored operator released; for an embassy the relations
  reset when it was the player's last active embassy (`ai-diplomacy-trade.md` 3.3). This is why
  the diplomat's item shows T312.
- **No worker request is filed** on deactivation (requests for an operator are only filed at
  completion, 5.1). The building stays inactive until a unit of its operator type enters again,
  in practice by a player order (right click on the building: go-to 0x07, enter, activation 8.1).
- *Quirk (C by reading)*: if two units of the operator type are inside (a second one ordered in),
  sending out **either** one deactivates the building, and the one still inside does not
  reactivate it. Only a new entry of the operator type does.
- A soldier leaving an outpost: if it was the last occupant, the outpost's garrison job (0x1C) is
  cancelled when it is put outside. Outposts have no operator and are never deactivated. Until it
  is put outside, the unit stays drawn on the tower in its garrison slot (`docs/rendering/objects.md`
  13.1). A garrison never leaves by itself: the send-out, a collapse and (computer towns) the AI's
  job assignments are the only ways out (`combat.md` 9.8).
- **Training buildings**: the head of the occupant list is the pupil who will be retyped (9).
  Sending out a porter from a school takes that pupil out. The training progress is kept: the
  job keeps counting with the next occupant, who is retyped in its place, and pauses while the
  building is empty. No new porter request is filed.

**Afterwards** the unit stands idle outside (idle fidgets 4.9; an idle unit at the door can be
pushed aside by the next one coming out). Nothing sends it back in:

- a **porter** is free (5.4) and is taken by the dispatcher for transport or worker requests. A
  leisure visitor keeps unit +0x78 = −1 until it gets a job, so the leisure job (5.7) does not
  pick it again before that *(I: the send-out path does not touch +0x78)*;
- an **operator** (or any other non-porter) does nothing by itself. It is free in the sense of
  5.2, so another building of its town with an open worker request for its type can take it
  (job 0x3C). It never returns to the building it was sent out of unless ordered;
- a **resident** keeps its home; a **soldier** is not re-garrisoned (the human player's outposts
  file no archer requests).

#### `DEAKTIVIEREN` (command 8, `00450860`), for comparison

No parameter; it acts on the first selected object too.

1. The occupant list is walked from the head; the first occupant of the building's **operator
   type** (any race) is ejected with the "sent out" flag, exactly like send-out with that type,
   and the command ends. Deactivation follows at placement.
2. If no such occupant exists but the building has a stored operator (he is outside, on an
   errand), that unit's current job is cancelled (if it is a leave job, the job queued behind
   it is cancelled instead), he is released as operator, and the building is deactivated at
   once.

The UI disables `DEAKTIVIEREN` for the town hall. Send-out cannot reach an operator who is
outside; `DEAKTIVIEREN` can.

#### Our build (implemented October 2026)

`src/engine/world.ts` command `{ type: 'sendOut', player, building, unit }` (unit = unit type),
`src/engine/logistics.ts` `occupants`, `sendOut`, `deaktivieren`, `deactivateBuilding`, the
"sent out" flag in `leave` / `runLeave` / `putOutside`; the inhabitants page item in
`src/client/hud-pages.ts`; tests in `test/sendout.test.ts`. The command is executed as above
(first occupant of the type in entering order, criminals and a town hall's founder refused,
deactivation at placement, embassy closure with the relation reset, the last soldier out of an
outpost ends its garrison job, a school's head pupil taken out with the progress kept, no worker
request). `DEAKTIVIEREN` (`building` action `deactivate`) ejects the first operator-type occupant
through the same path, or handles an operator outside as in its step 2.

| point | original | ours |
|---|---|---|
| building | the first object of the sender's selection, nothing validated | carried in the command; ignored unless it is a building of the sending player that is not collapsing |
| type −1 "everyone" | ejects the whole list (Gold ship button only) | not accepted (the ship form is our `unload`) |
| occupant list | building +0x58, appended at "entered" | the units with `inside` = the building and no leave job, ordered by `Entity.enterSeq` (a world-wide entry counter, saved and hashed); saves without it order by id |
| "not the stored operator" half of `004613f0` step 4 | deactivates | not tested (4.10 "Our build") |
| `DEAKTIVIEREN` step 2, operator inside another building (a diplomat on an errand in a foreign embassy) | job cancelled, he stays there until that embassy lets him out | also ejected from there |
| a unit on its way out | not in the list | also skipped by the visit job's release and the outpost's garrison scan (their lists exclude units with a leave job) |

---

## 5. Porters and goods logistics

### 5.1 Requests

Every town has one **dispatcher job** (type 0, at town+0x04). It is created on the first request
and scheduled after 1 tick (`00459c40`, `00459d70`). It holds two kinds of request.

**Worker requests**: pairs (unit type, building), added by `00459d70`.

| requested by | unit type |
|---|---|
| construction order | builder (11) |
| repair command `00452a70` | builder (11) |
| completed building with an operator (+0xD8) and nobody inside | operator type |
| training order | porter (9) |
| AI outposts | archers (0x1D) |
| a failed 0x3C job | the same request again |

**Transport requests**: a building or nature object appended to one of **four priority lists**,
**one entry per unit of goods** (`00459c40`).

| list | used for | added by |
|---|---|---|
| 0 | training materials | `00474b70` |
| 1 | construction materials; goods dropped at a non-store; resumed construction; every need or output re-filed by a transport that ended early (5.5) | `00474b70`, `0047c400`, `00475990`, `0047c160` |
| 2 | production inputs and outputs | `00474b70`, `00476380`, `00476630` |
| 3 | nature objects to pick up: piles, freshly planted crops, rubble | `0047ead0`, `0045f5a0` |

What a building entry stands for is held in the building itself:

- the needed-goods list (+0xC4): one entry per unit still to be brought;
- the output list (+0xD0): one entry per produced unit to be collected.

### 5.2 Dispatcher, part A: worker requests (C, `0046fa10`)

For each worker request:

1. If the building is gone, drop the request.
2. Search the town's list of that unit type for the **nearest free unit** (`0045b2f0`). "Free"
   is the same rule as for porters (5.4).
3. If one is found:

   | type | job given |
   |---|---|
   | porter | answer-request job 0x3C (walk there and enter). Only if the building's training job has more orders queued than people inside (+0x5C) |
   | builder | builder job 0x0C, if the building is a site whose construction job is not blocked, or if it is complete and HP < max |
   | anything else (operators) | 0x3C, scheduled after 1 tick |

   The request is then removed. This includes a builder request for a **paused** site (its
   construction job blocked, 6.8) or a site already at full HP: the free builder found gets
   **no** job and the request is dropped anyway (C, `0046fa10`: the job is only created inside
   the test, the removal follows it unconditionally). While no free builder exists the request
   stays, and it is dropped the same way at the first run that finds one.
4. If none is found the request stays. Advisor lines:
   - porter: mentor#14 "no free porter", when the town has no porters at all or every busy
     porter is only harvesting (job 0x16);
   - builder: mentor#9 "no builder", when the town has no builder at all.

If a 0x3C job is destroyed without success (for example the unit died or could not enter), its
destructor files the worker request again (`0047d8d0`) (C).

### 5.3 Dispatcher, part B: transport requests (C, `0046fa10`)

Runs only when at least one list is non-empty:

1. Rebuild the free-porter list (5.4).
2. Pick the **starting list** with weighted round-robin. Three counters c0, c1, c2 are kept at
   town+0x5C4..:
   - start with list 0 while c0 < 8;
   - otherwise list 1 while c1 < 4;
   - otherwise list 2 while c2 < 2;
   - otherwise list 3, and all counters are reset.

   The chosen counter is incremented. Over a full round, the starting list is 0, 1, 2 and 3 in
   the ratio 8 : 4 : 2 : 1.
3. Walk **all four lists** cyclically from the starting list (s, s+1, ..., wrapping at 4). In
   each list, take entries in order while free porters remain. With no free porter left the
   list is abandoned, and mentor#14 may fire under the same condition as in 5.2.

Building entry (the building must be a site, state 1, or active, state 2; otherwise the entry is
skipped and kept):

- If it has nothing needed and no output, the entry is dropped.
- If it has needed goods: find the first needed good with **town stock > 0** and move it to the
  front of the needed list.
  - Source = nearest store to the building; destination = the building.
  - If an output is also waiting, the same porter will take it back (combined trip, 5.5).
- If nothing needed is in stock but an output is waiting: source = the building, destination =
  the nearest store to the building.
- If nothing needed is in stock and no output is waiting: advisor "you lack X" (good record
  +0x130, the race index is added for raw material). The entry stays.
- The porter is the **nearest free porter to the source** (`0045afc0`). The search stops early
  at the first porter closer than 3.
- It is given a transport job (0x05, `0047bfd0`) with first delay 5, and the entry is removed.

Nature entry (list 3):

- It is skipped (and kept) while it has nothing unreserved, i.e. remaining = reserved. This
  happens with an unripe crop.
- It is also skipped while the town has no room for that good (capacity − stock < 1).
- Otherwise the nearest free porter to the object gets a harvest job (0x16) **without**
  auto-continue, and the entry is removed.

The dispatcher returns 20 while any request (of either kind) remains. Otherwise it returns 0 and
ends. **Requests are matched every 20 ticks.**

### 5.4 Free porter (C, `0045aed0`, `0045afc0`)

A porter is free if all of the following hold:

- it is alive;
- its group id (+0x48) is 0. For AI nations the value is 50 instead (I: an AI worker group);
- either it has no job and is not inside a building, or it is on a leisure visit (+0x78 = −1)
  and not (inside a building with an unblocked job).

Leisure visitors are therefore taken back for work at once. A porter released from a visit keeps
+0x78 = −1 while he stands outside with no job (5.7 "After leaving"); he is free by the first
clause anyway.

### 5.5 Transport job (type 0x05) (C)

Fields: destination +0x24, source +0x28 (0 = none), requester +0x2C, good to fetch +0x30
(−1 = none), output to collect +0x34 (−1 = none), phase +0x38 (0 going to source, 1 going to
destination).

At creation (`0047bfd0`):

- The requester's first needed-goods entry is popped into +0x30. If the source is not a store,
  +0x30 = −1 instead.
- The requester's first output entry, if any, is popped into +0x34.

This is the dispatcher's constructor. A second constructor (`0047bee0`) takes all five fields as
arguments and pops nothing; the player's delivery order uses it with no source, the building as
destination and requester, and the carried good as +0x30 (3.2 "The delivery transport of an
order").

Then the porter goes to the source with job 0x07 (no source: straight to the destination). The
goods move inside the building's "unit entered" handler (`00460ed0` calls `0047c400`).

**At the source** (building = source):

1. Anything carried is put down: 1 unit, if there is room. Room means town capacity for a store,
   or local free space (+0x120 − local stock) otherwise.
   - At a non-store, the good is also appended to the building's output list and a priority-1
     request is filed.
   - With no room, the advisor says mentor#17 "stores full".
2. Then pick up **1 unit**: the requested good +0x30 if the source stock has it, otherwise the
   output good +0x34. The stock is decremented, unit+0x38 = good and unit+0x3C += 1.

**At any other building** (normally the destination):

1. **Everything carried is dropped** into the building's stock. The town stock is clamped to its
   capacity (`0046e820`). A local stock is not clamped.
2. If +0x34 (an output to collect) is set, the porter takes 1 unit of it. The job is then turned
   round: the new destination is the source or, if there was none, the nearest store to this
   building; the new source is this building.
3. Otherwise, if this building has outputs waiting and the unit is a porter, the porter takes 1
   output and heads for the nearest store.

The run function (`0047c2b0`):

- Every run first checks that the source (if the job has one, **in both phases**) and the
  destination are alive. If not, the job ends without success.
- The go-to child is run. While it runs, its delay is returned.
- When the child ends **without success** (the building refused the unit at its first request,
  or died): the job ends without success. A failed *walk* is not such an end, because the go-to
  ignores it (4.2).
- When the trip to the source ends and the porter carries nothing, the job ends (failure),
  except for merchants (type 28).
- Otherwise it continues to the destination. When a go-to to the destination succeeds, the job
  ends if the good to fetch (+0x30) is −1 (delivered); if it is still set, the porter is sent to
  the destination **again** with a new go-to (a retry loop; it only matters if the entry did not
  run the delivery).

Note that the good to fetch (+0x30) is **not** cleared at pickup. It stays set while the porter
carries it and is set to −1 only when the goods are dropped at the destination (or replaced by
the collected output when the job turns round). The same holds for the output to collect
(+0x34): it is cleared when taken. The destructor relies on this.

#### Early end of a transport: the destructor (`0047c160`, vtable 0x4A577C slot 0) (C)

A transport ends early when its unit dies (death cancels the current job, and through the job
chain of 1.2 every job suspended behind it), when another job replaces it (a player order,
`00465650`), when its source or destination dies, when the source has none of the good, or when a
building refuses entry. In every case the destructor runs:

1. If the job has a requester (+0x2C), the requester is **alive**, the requester is **not a
   completed store** (record flag 0x1 clear, or it is still a site, state 1), and the job did not
   end cleanly (it failed, or +0x30 or +0x34 is still set):
   - if a good to fetch is still set (+0x30 ≠ −1): that good is put back at the **front** of the
     requester's needed-goods list, and **one transport request is filed in list 1** for the
     requester (`00459c40`);
   - if an output to collect is still set (+0x34 ≠ −1): it is put back at the front of the
     requester's output list, and one list-1 request is filed.

   This happens **whether or not the porter had already picked the good up**: the requester gets
   its need back in both cases. The re-filed request always goes to list 1, even for production
   inputs (list 2) and training materials (list 0) (quirk).
2. The references to destination, source and requester are released.

The destructor never touches what the unit carries (+0x38/+0x3C):

- **Porter killed**: the carried good disappears with him. Death (`004641d0`, `00462430`) creates
  no goods pile. The town stock was already decremented at pickup, so the unit of goods is lost;
  the site's need is re-filed and will be served from the remaining stock.
- **Porter alive** (a new order, the source store destroyed while he carries, a refusal): he
  stays where he is, **still carrying** the good, with no job. A carrying unit with no job is a
  free porter (5.4), so the dispatcher can hand him the next request. The good returns to the
  economy through his next job: a transport from a store first puts down what he carries (1 unit,
  if the store has room, "At the source" step 1 above), and a harvest job starts in phase 2 and
  delivers the load to a store first (7.1). Until then the town stock lacks that unit, so the
  re-filed need may wait ("you lack X") if it was the last one in stock.
- **Walk failed**: does not end the transport (go-to and enter ignore walk results, 4.2, 4.10).
  The porter enters the source or destination from wherever his walks ended, and the goods are
  handled as usual. A jam or even an unreachable site therefore delays deliveries but does not
  lose them.

The **answer-request job** 0x3C re-files its worker request in the same way (5.2), and the
**builder job** files a new builder request when the last builder leaves an unfinished site
(6.4). There is no other re-filing of materials: see 6.7.

**Carrying capacity: 1 unit per porter trip (C).** This matches handbook p. 26. Gatherers also
carry 1. Hunters carry up to 4 (7.4).

Goods are **taken from the town stock unit by unit when a porter picks them up**, never when a
building is placed (handbook p. 26 agrees).

### 5.6 Free gatherer deliveries

Woodcutters, stonemasons, hunters and harvesting porters bring their load in a transport job
with no source:

- destination = nearest store **to the gatherer's current position**;
- the job just drops the load (into the town stock, clamped to capacity).

If a store refuses or none exists, the harvest job retries (7.1).

### 5.7 Leisure for idle porters (job 0x03, `00470340`, period 199) (C)

One leisure job per town, every **199 ticks** (Gold `00479db0`, identical).

**Candidate lists, built once per run** (`0045b1d0`, Gold `00461240`): three lists of the town's
buildings, in the town's per-type building lists' order:

| category | types | |
|---|---|---|
| 0 | small house 37, then large house 38 (all 37s first, then all 38s) | houses |
| 1 | 58 | tavern (Kriegertafel / Wirtshaus / Orgiengrube) |
| 2 | 57 | circus (Theater / Zirkus / Kampfarena) |

A building is listed only if it is **active** (state +0xB0 = 2) **and** its job slot (+0x30) is
**empty or holds a job of type 0x22** (the operator / visit job). Consequences:

- a house whose **house job (0x0A) is running**, i.e. a house that is **not full** (4.4
  "Residences"), is **never** a leisure target; only full houses (house job ended) are;
- a tavern or circus is a target only while active, i.e. with its operator inside (8.1);
  an unstaffed one is never visited;
- the temple (59, flag 0x8 too) and the town hall are never leisure targets. No add-on (Gold)
  building is a leisure target (the Gold job reads the same four types).

**Each run**, for each porter (type 9) in the town's free list (5.4; other entries are dropped from
the list) that has **no job** and +0x78 ≠ −1:

1. Increase +0x78. Act only once it exceeds 1, i.e. on the second run that finds him idle
   (about 200 to 400 ticks).
2. rand() mod 3 picks a category. An **empty** category: nothing more (the counter stays
   increased; next run tries again). Otherwise rand() mod (list length) picks the building
   (walking the list from its head).
3. A go-to job (0x07, enter) to that building becomes the porter's current job, scheduled after
   rand() mod 70 + 1 ticks. +0x78 = −1.
4. A building with resident places (record +0xB4 ≠ 0: the houses) is **removed from its
   candidate list** after being picked, so **one house receives at most one leisure visitor per
   run**. Taverns and circuses stay in their list (any number of porters per run). *(The job also
   has a test before step 3 that would drop a house without sending the porter; its condition can
   never hold, so it never acts.)*

rand() order per porter that acts: category, then (if the category is not empty) building, then
delay.

**The visit.** At the door, flag 0x8 admits porters (4.4). On entering, the building starts its
visit job (0x22, first run **299 ticks** later) if its job slot is empty (4.4 step "unit entered").
Because only buildings with a free slot or a running 0x22 job are picked, the visitor normally
finds either no job (and starts one) or a running visit job (which will release him). The visit
job releases the **last porter** of the occupant list on each run, every **299 ticks** (8.3).

**Who lets a leisure visitor out** (complete list of the automatic paths, C):

| where | released by | when |
|---|---|---|
| full house (37, 38) | its visit job | 299 ticks after the visit job started, then one porter per 299 ticks, last entered first |
| any house with a running visit job | a resident leaving (death, resettling, `00461690`) | at once: every occupant is ejected, the visit job ends, the house job restarts (4.4) |
| tavern 58, circus 57 | their visit job (operator inside, not staffed: no operator job of their own) | as for houses; the operator counts as an occupant, so after its last porter the job runs once more 299 ticks later and then ends (8.3) |
| anywhere | the dispatcher (5.4): a leisure visitor inside is free | when a transport or worker request takes him (1.2: eject + leave job) |
| anywhere | the building's loss, its deactivation (taverns: slot cleared, visitors stay until another porter enters), the send-out command | 4.11, `combat.md` 10.3 |

There is **no timer in the porter's own job** (he has none inside), and **need satisfaction does
not release anyone**: a need building closes its need when it becomes active (economy.md 5.3),
regardless of visitors. Nothing else ejects a visitor.

Rare case (C, by reading): a house picked while full whose resident leaves before the porter
arrives runs its house job again, so the porter entering finds the slot taken and starts no
visit job. He stays inside, idle and free (+0x78 = −1), until he is called for work, or until the
house is full again and is picked for another visitor, whose visit job then releases both, one
per 299 ticks.

**After leaving.** The eject (`00460be0`), the leave job (0x0D) and the placement (`004613f0`) do
**not** touch +0x78; only giving a job through `00465650` (the dispatcher, AI) resets it to 0
(1.2), besides the unit constructor. So a porter released from a visit **stays at +0x78 = −1**:
he is put on the entrance cell (or the spiral fallback, 4.10), stands there idle, is free for the
dispatcher (5.4), and the leisure job **skips him** until he has been given a job and finished
it. He does not start a new visit by himself and does not wander. What a visit gives to the town
is in economy.md (nothing found).

Timeline of one visit with no work available (tick 0 = the leisure run that sends him): go-to
starts at 1..70; walk; door queue (10-tick retries, 4.4); enters at E; first visit job run at
E + 299 (if he started the job) ejects the last porter; he is outside 20..35 ticks after his
eject (4.10). With n porters inside the k-th one out (counting from the last entered) leaves
at about E₀ + 299·k, E₀ = the entry that started the job.

*Our build (fixed October 2026):* the leisure job used to pick any completed house, tavern or
circus, so porters walked into non-full houses (house job in the slot, no visit job) and never
came out without work; the visit job also reset the released porter's counter to 0. Code:
`logistics.ts` `runLeisure`, `runOperator` (visit branch), `slotJob`; tests `test/leisure.test.ts`.

### 5.8 Our build: lost transports and starving sites (deviations found and fixed October 2026)

A diagnosis run found sites that never finish because transports ended early and the need was not
re-filed (144 of 180 lost transports were failed walks). The following points now follow 4.1, 4.2,
4.7, 4.10, 5.5 and `combat.md` 7.3, 7.4 (tests: `test/transport-refile.test.ts`,
`test/walk-jam.test.ts`, `test/flee-resume.test.ts`):

1. **Re-filing** (`src/engine/logistics.ts` `cleanup`): the good to fetch stays set until it is
   dropped at the destination (`atDestination`), an output is cleared when taken; an early end
   re-files both to the front of their lists with one list-1 request each, for a live requester
   that is not a completed store. A killed porter's load is lost (no pile); a live one keeps
   carrying it and puts it down at his next transport from a store or his next harvest. At the
   source the requested good is picked up even when a carried load could not be put down (the
   good becomes the picked one, amount + 1), as in 5.5; our earlier guard delivered the old load
   instead and lost the need.
2. **Walk results** (`runTransport`, `runAnswer`, harvest `deliverStep`, builder's first go-to):
   only a dead source/destination, a refusal or an empty source end a transport; the unit asks
   to enter from wherever its walks ended (`atDoor`; the add-on harbour/shipyard and ships keep
   the docking range test).
3. **Follow-path walks** (`World.follow`, `Motion.start`/`replan`): a search that finds nothing
   costs one plan and is retried in mode 1 at the next run, until the arrival tolerance or the
   15-plan limit. The start and goal cells are never blocked in these searches. Our A* returns a
   partial way when it cannot reach the goal; for these walks that counts as a failed search. A
   goal in a small closed pocket without the start fails at once (`Motion.closedAround`, a
   goal-side flood standing in for the original's search from both ends; same result as the full
   search, only cheaper). `World.walk` (one search, false when nothing is found, partial ways
   accepted) is kept for the attack's firing-position search, animals, patrols and the computer
   players' legs.
4. **Re-plans** after a blocked step or a failed step-aside child are mode 0 (all units with
   2 max + min < 32 kept out, start and goal never blocked); the flee's outward walk keeps out
   every unit (walk mask 1 = 0x3E).
5. **After squeezing past** an idle unit the walker goes on along its old path (no plan counted).
6. **Waiting for a walking blocker**: its raw step time + 1, or 3 ticks while it has a mode-0
   plan due; a blocker without a path, after a failed search, squeezing or unable to step means
   re-plan.
7. **Next path cell not a neighbour**: the walk ends without success.
8. **Walks belong to jobs** (`World.stashWalk`/`resumeWalk`, called by `combat.ts` `suspend`
   and `endUnitJob`; entity field `walks`, snapshot version 8): a suspended job keeps its walk
   (goal, path, plan counter, step-aside state, last result) and continues it when it is current
   again; from another cell the walk ends at once and the job goes on as in `combat.md` 7.4.
   A plain move walk (no job) is kept as job 0 and resumed when nothing else is.
9. **Flee** (`combat.ts` `flee`, `runFlee`): first run 3 ticks after the strike; outward walk
   with mask 0x3E, home walk with 0x3C; the attacker's death ends the flee at any run, the unit
   stops where it is.
10. **The player's delivery order** (`order`, `startTransport`; found October 2026 from a save
   with a house site stuck at `0/1 0/2`): our build created the order's transport with no
   requester and no good to fetch, while the acceptance test had already removed one needed
   entry. A delivery that did not happen (the carrier re-ordered, moved, sent home, killed) lost
   that entry for good; once the site's needed list was empty its builder waited for ever, the
   dispatcher dropped the leftover requests, and further delivery orders were refused because
   nothing was "needed" any more (the carriers then stood idle at the site). Now the transport is
   built as in 3.2: requester = the building, good to fetch = the carried good, so its early end
   re-files the good like any transport. **Old saves** (snapshot version < 13) are repaired once
   on load (`Logistics.refileLostSiteNeeds`): manual deliveries under way get the building as
   requester and their load as good to fetch, and every unpaused site whose still-to-consume
   amounts exceed local stock + goods to fetch under way + needed entries gets the difference
   appended as needed entries with one list-1 request each, exactly what a resume (6.8) would file.
   The site's door now uses the site rule of 4.4 (builders and units whose current job is a
   transport); ours admitted everyone at a site, so a carrier refused by the acceptance test
   "entered" the site instead of being turned away at its door (no goods moved either way).
   This only restores the pairing of 6.7 that the original never breaks; it is not a periodic
   check (the original has none). In the original an interrupted delivery order cannot lose a
   need; a pause and resume (6.8) refills a site anyway. A fuzz run (about 1,700 random
   player orders, moves, go-home and pause commands on the reporting save) found no other way to
   lose a need. Not checked against the original: `WEGWERFEN` (drop goods) on a unit that is
   delivering; ours lets the transport go on empty-handed, which clears its good to fetch at the
   destination without delivering it.

Remaining differences: our planner is synchronous, so "the blocker's planner is still running"
(4.7 case 3) has no exact counterpart; plain move orders still use one search with partial ways;
the found-town and plant jobs keep their distance test on arrival.

---

## 6. Construction

### 6.1 Placement (C, `00451780`)

The player command carries the building type and the max-corner cell. Placement is allowed when:

- the build-menu state (`00459b60`, see odb.md 5) is 1 (OK) **or 3 (not enough goods)**.
  Missing goods do not block placement; they are delivered later;
- no cell of the footprint **grown by one cell on every side** has a forbidden flag.

Cell flags (`00447f20`):

| bit | meaning |
|---|---|
| 0x01 | path flag (bit 0x01 of the cell's flags byte): paved by a foundation (6.6) or a worn path (4.5) |
| 0x04 | building present |
| 0x08 | special object id 0xF000..0xF00F |
| 0x10 | nature object present |
| 0x80 | the cell's viewer counter is 0, i.e. not currently visible (`fog-of-war.md` 1.1) |
| 0x100 | height > 250 |
| 0x200 | height 130..250 |
| 0x400 | height < 130 |
| 0x20 / 0x2000 | from the cell's tile byte: 0x20 = a water tile (tile index at or above the first tile of class 11), 0x2000 = any land tile. Foundations and worn paths never change this, because they only write weg tiles and never touch water |

Slope rule: the ring of cells at distance 2 around the footprint is checked; if the highest and
lowest heights differ by more than 64, flag 0x40 (too steep) is added.

Forbidden masks (`0045f0a0`):

| buildings | mask | effect |
|---|---|---|
| default | 0x87E | |
| mine (50) | 0x67E | forbids 0x200 and 0x400, so the mine must stand on height > 250: mountains |
| farm (45) | 0x97E | also forbids 0x100, so no farm on mountains |
| town hall (40) | 0x107E | |

The AI adds 0x100 for everything except the mine and outposts (`0046c1a0`).

After placement:

1. A building object is created (`0045f0d0`):
   - state 1 (site);
   - **HP = record HP / 10, rounded down**;
   - entrance cell computed;
   - local stock zeroed;
   - town site count +1;
   - its "object created" message levels and paves the ground under and around it in the
     same tick (the **foundation**, 6.6). This happens before the construction job exists and
     whether or not the building is ever finished.
2. It is added to the town's per-type list.
3. A **construction job** (0x11) is created and scheduled after 10 ticks (`0045f410`). Its
   constructor queues one order for the building (`00474b70`), which:
   - files a **worker request for a builder** (type 11);
   - appends one needed-goods entry **per unit of the build cost** (goods 0..8 of +0xF0) and one
     **priority-1 transport request** per unit.

**No goods and no money are deducted at placement** (C). Buildings cost no money; odb.md 5.

### 6.2 Order record (C)

Construction, training and production jobs share the order queue of `00474b70` / `00474fd0`
(cancel). An order holds:

- the type;
- T = total goods units;
- R = goods units not yet consumed;
- a list of (good, amount) still to consume.

For a construction order (`00474b70`, building record) the list gets **one entry per good with a
non-zero cost, in good-index order 0..8** (crop, wood, stone, good 3, food, ...), each with the
full cost as its amount. T is the sum. Nothing is subtracted for goods already lying at the site
(C). Example, Pimmon school (cost wood 2, stone 4): list [(wood, 2), (stone, 4)], T = R = 6.

The entries are reduced only by the construction step's consume (6.3) and removed when they reach
0. They are **the "still to consume" numbers of the site panel** (6.9).

### 6.3 Construction progress (C, `00475480`, called by the builder)

On the first call:

- N = max(T, 10), the number of work ticks;
- step = N / T (integer division; 1 if T = 0);
- counter = N + step − (N mod step);
- end value E = step − (N mod step);
- HP increment d = (record HP − current HP) / 9, integer division.

Each call (the builder calls every 15 ticks):

1. **Consume** (builder phase 0 or 2, goods left in the list, and counter divisible by step):
   - if the site's local stock of the first listed good is 0, the builder phase becomes 2
     (waiting for material);
   - otherwise the phase becomes 1, one unit is removed from the local stock, R −= 1, and the
     list entry is reduced (removed at 0).
2. **Work** (builder phase 1, or no goods left in the list):
   - counter −= 1;
   - if the counter is now divisible by step and goods are still listed, the builder phase
     becomes 3 (move to another spot around the site);
   - progress: if T ≤ 10, every work tick counts. If T > 10, a work tick counts only when the
     stage s = min(9, floor((T − R) · 10 / T)) has changed;
   - a counted tick adds d to HP (clamped to max; HP < 1 destroys the building) and sends
     display message (6,5). The message **advances the construction sprite `BU0` by one
     frame**: 10 frames, `00455bb0`.
3. **Done** when the counter reaches E: exactly N work ticks in total.
   - The order is popped and vtable[5] runs (`004757f0`).
   - Any building job is cancelled, d is added once more (clamped) and completion
     (`004602d0`) runs.
   - Advisor mentor#1 "building complete".
   - The call returns 0; otherwise every call returns 15.

The `BU0` frame therefore advances 9 or 10 times. The site starts at frame 0 and HP/10, and
finishes at full HP.

Worked example, Pimmon school (2 wood + 4 stone, HP 500): T = 6, N = 10, step = 1. The site
starts at 50 HP and d = 50. The builder alternates "consume a good" (15 ticks), "one work tick"
(15 ticks) and a walk to the next spot, six times; then 4 more work ticks. That is 10 work ticks
and 10 frame advances, about 240 ticks plus walking (about 23 s at normal speed).

Progress shown in the panel (vtable[6], `00475880`) = (N − work ticks remaining) × 100 / N (C).
Before the first construction call it is 0.

**Consumption rules, confirmed at instruction level** (`00475548`..`00475619`, C):

- A consume call takes **exactly one unit**, of the **first** list entry's good, from the site's
  local stock (building +0x7C + 4·good; a completed store would use the town stock, which never
  happens for a site). Goods are therefore used strictly in list order: all wood, then all stone,
  then the rest. A builder whose first listed good is missing **waits (phase 2) even when the
  other goods are all lying at the site**; he does not skip to another good.
- The test is made only when the builder is in phase 0 or 2, goods are still listed **and**
  counter mod step = 0. In phase 0 or 2 with goods listed and counter mod step ≠ 0 the call does
  **nothing** (no work tick either) and returns 15. With step = 1 this cannot happen. In the
  shipped data every building costs at least 6 units (T ≥ 6), so step is always 1 and every work
  tick is preceded by one consume.
- The goods are consumed **during** the build: one unit per work step, before that step's work
  tick. Delivered goods lie in the local stock until then. With T ≤ 10 the consumes are spread
  over the first T work ticks and the last N − T work ticks need no goods; with T > 10 (N = T)
  every work tick consumes one unit.
- **Waiting.** In phase 2 the builder calls the step every 15 ticks (the call returns 15) and
  stays on his spot, facing the site, in his standing pose (no work animation: it was stopped
  before the relocation walk, phase 3, and phase 2 does not start it). He never leaves the site
  for missing goods and never requests goods (6.7). At the first call that finds the first listed
  good in the local stock he consumes it (phase 1); his next run 15 ticks later starts the work
  animation and makes the work tick. So a delivery ends the wait within 15 ticks.
- **Several builders** share the order: the counter, the list, the local stock and the stage. Each
  calls the step from his own job with his own phase. Each consume takes one unit and each work
  tick lowers the counter by one, whoever makes it, so the totals stay T consumes and N work
  ticks; the site is simply finished sooner. With step = 1 two builders can each consume a unit
  before either works; the list then empties earlier and the remaining work ticks need no goods.
- The step **does not look at the pause** (the construction job's block, 6.8). Only the builders'
  removal and the missing deliveries stop a paused site.

**Worked example: what the panel shows over the build** (Pimmon school, wood 2 + stone 4, one
builder, all goods delivered before he starts; panel entries "local/still to consume", 6.9):

| after | list (still to consume) | local stock | panel | work ticks done | progress |
|---|---|---|---|---|---|
| placement, goods delivered | wood 2, stone 4 | wood 2, stone 4 | `2/2` `4/4` | 0 | 0% |
| consume 1 (wood) | wood 1, stone 4 | wood 1, stone 4 | `1/1` `4/4` | 0 | 0% |
| work tick 1 | | | | 1 | 10% |
| consume 2 (wood) | stone 4 | stone 4 | `4/4` (wood entry gone) | 1 | 10% |
| work tick 2, consume 3 | stone 3 | stone 3 | `3/3` | 2 | 20% |
| ... consumes 4..6 | stone 2, 1, gone | 2, 1, 0 | `2/2`, `1/1`, no entry | 3..5 | |
| work ticks 7..10 | (empty) | 0 | no entries | 6..10 | 60%..100% |

With goods still on the way the first number is lower than the second, e.g. `0/2` `4/4` while the
two wood are being carried, and the builder waits although stone is there.

### 6.4 Builder job (0x0C, `00477a80` / `00477ce0`) (C)

- Created by the dispatcher (worker request) or by an order. Its first child walks to the
  building (0x07). Requesting entry ends as "done" for builders, so the builder **walks to the
  site entrance first**. When that go-to ends with success the phase becomes **3** (C,
  `00477ce0`: a successful child moves phase 3 to 0 and every other phase to 3), so at his next
  run he walks on to the first spot (+x side, 4.8) and makes his first construction call only
  there, after the turn of phase 0. This holds for repairs too.
- The builder registers in the construction job's builder list (+0x4C). **Several builders may
  work one site.** Each calls the step every 15 ticks, so the same counter runs down faster.

Phases:

| phase | meaning |
|---|---|
| 2 (initial) | waiting for material, or the first call |
| 3 | stop the work animation; walk to the next spot around the building (`00478350`), cycling through the 4 sides of the footprint |
| 0 | turn to face the building, then call the construction step. With no construction job on the building (repair), the phase becomes 1 after 10 ticks |
| 1 | work animation on (action 2, loop until stopped), then call the step. On a repair it does the repair tick instead |
| 4 | walk to the entrance (plain path) and end there, idle (6.4.1) |

Repair tick, on a completed building:

- If the nation has no money, stop.
- Otherwise pay **1 coin** (`0045db60`) and add **20 HP** (clamped). If HP < max, go to
  phase 3; the call returns 20.
- Repair therefore costs 1 coin per 20 HP. Each tick also includes a relocation walk, a turn and
  10 ticks.

When a builder job dies (`00477b90`), and the site's construction job is **not blocked**, the
builder leaves the builder list and, if no builder remains on the unfinished site, a new builder
request is filed (C). The dispatcher (5.2) gives it to the nearest free builder: this is the
**"last builder" rule**, and the only way a site gets a builder again besides placement, resume
(6.8) and a player order. While the construction job **is blocked** (paused, 6.8) the destructor
does neither: the builder stays in the list as a stale entry and nothing is filed (quirk, C; it
only matters for a builder sent onto a paused site by a player order, because the pause itself
takes its builders off the list first). A stale entry keeps the list non-empty, so the rule does
not fire for that site again until the entry is removed by a later pause. A builder interrupted
by a flee resumes as described in `combat.md` 7.4.

Who calls a builder to a site:

| event | how |
|---|---|
| placement (6.1) | one builder request |
| the last builder's job ends on an unfinished, unpaused site | one builder request (above) |
| resume (6.8) | one builder request, whether or not builders are listed |
| player order (3.2) | a builder job at once, also on a paused site; an open builder request for that site is withdrawn |

A builder never leaves a site because goods are missing (6.3 "Waiting"); he leaves only when the
site is finished or destroyed, his walk to the next spot fails (6.4.1), he is given another job
(player order, pause), or he dies.

#### 6.4.1 End of the job: the builder walks to the door (C, `00477ce0` phase 4, destructor `00477b90`)

All of this is **simulation** (which cell, which tick, who is pushed), except the work animation,
which is display driven by the job's messages.

**When phase 4 starts.** The builder job switches to phase 4 in the same run in which:

- the construction step reports the site finished (6.3 "Done"; this is the builder who made the
  last work tick);
- a repair tick brings the HP to the maximum, or the nation has no money for the next repair tick;
- the job runs with no child while the building is no longer a site and the builder is in phase 2
  (waiting for material). This is how a second builder on the same site ends (table below);
- a walk child (the first go-to, or a walk to the next spot) ends without success.

**What phase 4 does.** It gives the builder a **plain follow-path child (job 0x06) to the
building's entrance cell** (building +0x70..+0x78, the cell in front of the door picture, 4.10
"Where the door is") and returns 1. There is no go-to target chooser (4.8), so the goal is the
entrance itself, and units on it are ignored by the planner (4.7). No stop message is sent: the
work animation, started with "until stopped", keeps looping until the first step message of this
walk cuts it (`docs/rendering/unit-motion.md` 2.2 step 1).

When the walk child ends, the builder job ends too (returns 0). Its destructor removes the builder
from the builder list (no new request: the site is complete) and, because the work animation flag
is still set, sends the stop message (0x27,11).

**Timeline of the completing builder** (C = the tick of his last construction call):

| tick | simulation | on screen |
|---|---|---|
| C | site complete (6.5), mentor#1, walk child created; returns 1 | still the work animation |
| C+1 | the walk child's first run: already on the entrance → done at once (go to C+1 in the next row); otherwise the first path plan, returns 3 (4.1) | work animation |
| C+4 | turn toward the first path cell (45° free, 1 tick per further 45°), then the first step | the step message stops the work animation; he walks |
| ... | normal steps along the footprint ring; from a side-midpoint spot the entrance is usually 1..4 cells away | |
| last step + D | the walk ends, the builder job ends, stop message | standing pose |

A builder who already stands on the entrance (possible when a work spot coincides with it, for
example a building 2 cells wide with door offset (−1, +1): its +y spot (X − 1, Y + 1) is the
entrance) ends at C+1 and stops working at once.

**Where he stands and which way he faces.** On the entrance cell, facing the direction of his
last step: there is no final turn (a plain follow-path, not a go-to). If he did not have to move he
keeps the facing of his work spot (7 on the +y spot). If the entrance holds a busy unit he stops one
cell short by the arrival tolerance (4.1); an idle unit there is pushed aside (4.7).

**Afterwards.** He has no job: idle, with idle fidgets (4.9). He does not go home or into the
building. The dispatcher (5.2, every 20 ticks) gives the nearest free builder the next builder
request of his town (a new site or a repair); until then he stands on the entrance indefinitely.

**Consequence: the builder in front of the door.** Right after completion the idle builder stands
where units come out and go in:

- a unit **leaving** the building (a birth in a completed house, a trained unit, a resident sent
  out...) finds the entrance taken at its placement test (4.10). The idle builder is pushed: a
  step-aside job 1 tick later, he turns and steps to the first empty neighbour in the step-aside
  order. The leaving unit is put on the entrance at its next 5-tick poll, so it appears about 5 ticks
  later than it would have. If the builder has meanwhile been given a job, he is not pushed; the
  leaving unit waits in 5-tick polls and at run 5 takes the nearest free spiral cell;
- a unit **walking in** (the operator answering the worker request filed at completion, a porter
  delivering) is blocked on its last step and pushes him (4.7 case 2), then steps onto the
  entrance.

**Other builders on the same site** are not told about the completion. Each notices at its own
next run, by its phase:

| phase at completion | what happens |
|---|---|
| 2 (waiting for material) | at its next run (with no child): phase 4, walk to the entrance, end |
| 3 (walking to the next spot) | finishes that walk, then continues as phase 0 |
| 0 (turning toward the building) | turns, then takes the **repair branch** because the building is no longer a site: work animation on, phase 1, returns 10 |
| 1 | a repair tick: **pays 1 coin** if the nation has money, adds 20 HP (already full), then phase 4: walk to the entrance, end |

So a second builder usually works about 10 more ticks and costs 1 coin before he walks to the door
(quirk, C by code reading).

**Our build** (`src/engine/logistics.ts` `runBuilder`, `builderToDoor`, `builderDone`; implemented
October 2026, `test/builder-door.test.ts`): as above. `complete()` no longer touches the builders;
the completing builder gets phase 4 (our phase 4: the walk is created, planned in the next run, so
the first step comes at C+4 at the earliest) and keeps the work action until that step; every other
builder ends through its own next run as in the table (waiting → door; walking → turn, repair branch
with the work action and 10 ticks, 1 coin, door). A finished repair, no money and a failed walk end
the same way. The job ends when the walk ends (stop message: action idle), the builder list entry is
removed in the same place as on a cancel. Remaining differences: the walk is our plain walk to the
entrance cell (arrival tolerance and pushing as in 4.1/4.7); our builder phases are numbered
differently (the original's builder phase is our `BJ.Step`).

### 6.5 Completion (C, `004602d0`)

1. The building's state is set to 0. The display state is set to "complete".
2. Outposts broadcast their territory (odb.md; rules in `economy.md` 11).
3. The town hall gets full HP and nothing more: no display-state message, no operator request,
   no activation. It is completed only by its founder (section 11).
4. Houses take in homeless residents. They may spawn a porter: see odb.md 5 and economy.md.
5. If the record has an operator (+0xD8 ≠ −1) and nobody is inside, a **worker request for the
   operator type** is filed and the building stays in state 0 until the operator enters.
   Otherwise it is activated at once (`0045fa40`, 8.1).
6. Town site count −1, building count +1.

Completion does not touch the terrain. The ground was already levelled and paved when the
site was created (6.6).

*(Section 6.7, how a site's missing goods are requested again, follows after 6.6.)*

### 6.6 Foundation: levelled and paved ground (C, `00448690`, `00448210`, `00448120`)

Every building flattens and paves the ground under it and one cell around it as soon as its
object is created. The change is permanent: destroying the building leaves the flat path-covered
patch behind.

#### When it happens

The terrain edit is part of putting a building's object index on the map. The building
constructor (`0045f0d0` → `004628d0` → `00461a40`) sends the "object created" message (id 0x15)
with its "place on map" byte set to 1 for every building. That message's handler (`004552c0`)
calls the map-placement function `00448690`. For a building record (kind +0xA4 = 1), that
function runs the foundation (`00448210`) first and then writes the anchor bit and the object
index into the footprint cells. A message to the local player's connection is handled
immediately (`004551c0`). On the simulating machine the ground therefore changes **in the same
tick in which the building object is created**, before the construction job is created.

| event | foundation? |
|---|---|
| player placement command (6.1, `00451780`) | **yes**, when the command is executed. The site stands on ground that is already levelled |
| computer player placement (`0046c1a0`, `ai-diplomacy-trade.md` 1.5) | **yes**, same constructor |
| town-hall site of the found-town command (11.2) | **yes**, at command time, before the founder walks there |
| computer start town halls in free play (`world-populate.md` 9) | **yes** |
| buildings in a `.dvm` map (`dvm.md`, creation order) | **yes**, one by one in creation order: town halls first, then the other buildings in file order. Each building's average (below) already sees the foundations of the buildings created before it |
| construction start, every construction step, completion (6.3, 6.5), activation | no terrain change |
| destruction, demolition, a site destroyed before completion (`combat.md` 10.3) | **nothing is restored**. Removal (`004488e0`) clears only the object index and the anchor bit of the footprint cells. Heights, tiles, light and the path flag stay. The rubble piles (nature type 38) then lie on the paved footprint |
| save and load | the save game holds the **complete** map cell array (`0044acd0` writes size, mask and all cells right after the save header, called from `0040c6a0`; `0044ad70` reads it back). Foundations and worn paths survive. Loading does not run them again *(I: loaded objects are not created through `00461a40`, the only sender of the "object created" message)* |

Check against the shipped data: 23 of the 40,961 `.dvm` object records store a height that
differs from the generated terrain (`dvm.md`). Replaying this section's rule for each map's
buildings (town halls first, then file order) reproduces **18 of them exactly**. They are units,
trees and bushes that the map editor had left standing on a building's ring. The other 5 differ
by 1..14, which fits an editor that placed the buildings in a different order or deleted one
after placing it *(I)*.

#### Which cells

With the building at its max corner (x, y), size_x = record +0x10 and size_y = +0x0C
(`odb.md` 2.2):

- **footprint**: x − size_x + 1 .. x by y − size_y + 1 .. y;
- **pad**: the footprint grown by one cell on every side, x − size_x .. x + 1 by
  y − size_y .. y + 1, (size_x + 2) × (size_y + 2) cells. This is the area placement keeps
  free of objects and water (6.1);
- **ring**: the pad minus the footprint, 2·size_x + 2·size_y + 4 cells;
- **light area**: the footprint grown by two cells on every side,
  x − size_x − 1 .. x + 2 by y − size_y − 1 .. y + 2.

All coordinates wrap around the map edges. The **entrance cell** of every base-game building
lies in the ring (checked for all 75 building records of `dv.odb`), so the door is always
levelled and paved.

#### Order of operations (`00448210`)

1. **Level** h = the average of the current heights of the **ring** cells: their sum divided by
   their count, rounded down (`00448120`). The footprint's own heights are not used.
2. For every pad cell (x outer from x + 1 down to x − size_x; y inner from y + 1 down to
   y − size_y):
   1. its height becomes h. No other field of the cell changes in this step;
   2. if its tile is **not** a weg tile (not one of the 9 tiles of class 10): tile := weg tile
      `rand() mod 8` (weg tiles 0..7, uniform; the 9th weg tile and the `.os` weights are not
      used), and the cell's flags byte gets the **path flag** 0x01 and the **dirty bit** 0x40.
      A cell that already has a weg tile keeps it and gets **no** flags: a lake shore, an
      earlier foundation or a worn path. A lake-shore cell inside a pad therefore stays without
      the path flag (C; quirk).
3. For every cell of the **light area** (x outer from x + 2 down to x − size_x − 1; y inner from
   y + 2 down to y − size_y − 1): the light byte is recomputed with the generator's lighting
   function (`00447b90`, `terrain-gen.md` step 5: a normal built from four neighbouring heights,
   clamped to 128..239). The light area is exactly the set of cells that have a neighbour in the
   pad *(I: which neighbour pairs feed the two slopes was not decoded; the generator's rule
   applies)*.
4. **Display refresh**: if the building's position is less than 10 cells from the current view
   centre on both axes (plain coordinate difference, not wrapped; view centre = the view
   object's +0x24/+0x28), the terrain view's full-redraw counter (view object `0x4B44D0` +0x5C)
   is set to 1, so the whole view is redrawn on the next frame. Otherwise only the per-cell dirty
   bits remain. The frame builder (`00445e40`) copies each visible cell's height, light, tile and
   flags into its vertex list and clears the dirty bit. Levelled cells that kept their weg tile
   get no dirty bit (quirk).
5. Not part of the foundation: the footprint cells get the object index, and the anchor cell gets
   the anchor bit 0x80.

#### Shape and slopes

- Nothing is smoothed. Cells outside the pad keep their heights. The quads between the pad's
  outer vertices and the next row of cells take the whole height difference. Placement (6.1) only
  limits the height **range** of the ring at distance 2 to 64. It does not limit how far that
  ring lies from h, so a steep step can appear at the pad's edge.
- Tiles belong to vertices (`terrain-drawing.md`). The quads x − size_x .. x by y − size_y .. y
  (one quad more than the footprint toward −x and −y) have four weg corners and are drawn as
  plain path. The quads around them have mixed corners and get the normal four-corner blend. That
  blend makes the soft gravel border. There are no special edge or transition tiles.
- The tile set is the same for **every race, every building type and site or finished
  building**: weg, class 10. No record field selects it.

#### The building's own height

The building object's height (+0x18) is read from its anchor cell by `00461a40` **before** the
message that levels the ground. It therefore holds the anchor's height from before the
levelling, and the "object created" message carries that value to the display (C). Whether the
sprite is drawn at that height or at the levelled cell height was not checked *(uncertain)*. A
rebuild should draw the building on the levelled height h. Objects that already stand on the
pad keep their stored heights. Placement forbids that in play, but the shipped maps contain such
trees.

#### What the simulation reads from it (C)

- **Movement**: step classes come from height differences (`odb.md` 2.3), so the pad is flat
  ground (class 0) while its edge may be steep. The path flag on every pad cell, entrance
  included, gives the faster step (4.1).
- **Later placements**: the slope ring test and the height bands 0x100 / 0x200 / 0x400 (6.1)
  read the levelled heights. A pad can move cells across 130 or 250.
- **Object heights**: units read their height from the cell they step onto.
- The tile matters to the simulation only through the water flag 0x20, which a foundation never
  changes (placement forbids water anywhere in the pad).

#### Network (original)

The edit runs in the display handler on each machine: on the host when it creates the building,
on each remote player's machine when its copy of the "object created" message is processed
(`004551c0` queues messages for non-local connections, *I: and sends them to that machine*).
Every machine applies the same messages in the same order to the same generated terrain, so the
heights come out identical. The weg tile variants come from each machine's own C `rand()` and
may differ between machines, which is only cosmetic. On the host the draw comes from the same
global `rand()` stream that the simulation uses (`004936b9`).

#### Gold Edition

Gold's foundation (`0044c7d0` → `0044c320` → `0044c230`) is identical, except that the
**harbour (62) and the shipyard (63)** of the add-on get **no foundation**. Both stand at the
waterline.

#### Implementation notes (our engine)

- **State.** Heights, class/tile and the path flag of edited cells are **simulation state**.
  Our engine regenerates terrain from the seed on load, so the snapshot must carry the edits.
  Keep an edit table keyed by cell index (height, class, tile, path flag), serialise it sorted by
  index, apply it after `generateTerrain`, then recompute light for the edited cells and their
  neighbours. Include the edited heights, tiles and path flags in `World.hash()`. Light is
  rendering-only.
- **Where.** Run the foundation inside building creation, before anything else reads the cells:
  placement command, AI placement, found-town command, map load (town halls first, then file
  order) and free-play populate. Do nothing on completion, demolition or destruction.
- **Tiles.** Our `tile` is the index within the class's tile set. The foundation writes
  `cls = 10` (CLASS_PATH) and `tile = r` with r in 0..7. "Already weg" means `cls === 10`. Keep
  the path flag in its own per-cell bit array, because generated lake shores are class 10
  without it.
- **Randomness.** The original's draws come from display code and cannot be reproduced. Use a
  deterministic stream in simulation order, preferably a dedicated terrain stream stored in the
  snapshot, so that cosmetic tile picks do not shift other gameplay draws. The worn-path roll
  (4.5) must run in the simulation step, not in the renderer, because the path flag changes step
  delays. Lockstep then gives every client identical edits, and nothing needs to be sent.
- **Renderer.** After an edit, rebuild every 32 × 32 chunk that contains a quad touching a
  changed vertex. Heights and tiles change on the pad and light changes one cell further out. A
  vertex (vx, vy) is used by quads vx − 1 .. vx and vy − 1 .. vy, so rebuild the chunks covering
  x − size_x − 2 .. x + 2 by y − size_y − 2 .. y + 2 (wrapped). A worn path changes one vertex.
  Rebuild the chunks of its quads.
- **Gold option.** Skip the foundation for building types 62 and 63, and take the worn-path type
  set from unit record +0xB8 bit 0x80 when that data is loaded.

### 6.7 Outstanding goods of a site: how they are requested again (C)

There is **no periodic re-check** of a site's missing goods: no job compares the order's
remaining goods with the local stock while construction runs. The bookkeeping is kept consistent
by pairing instead. For every unit of goods still to come, the site holds one needed-goods entry
(+0xC4) and the town holds one transport request in list 1, both made at placement (6.1). They
change only in these places:

| event | needed-goods list | transport requests |
|---|---|---|
| placement (`00474b70`) | one entry per unit of cost | one list-1 request per unit |
| dispatcher matches a request (5.3) | the transport pops the first entry (the dispatcher first moves a good that is in stock to the front) | the request is removed |
| dispatcher finds nothing in stock | unchanged | **kept**; it is tried again at every dispatcher run (every 20 ticks) with the advisor "you lack X" |
| transport delivers | – (the good is now in the site's local stock, which the builder consumes, 6.3) | – |
| transport ends early (5.5 destructor) | the good goes back to the front | one list-1 request filed |
| player orders a carrier to the site (3.2, `004617c0`) | one entry of the carried good removed; the delivery transport holds it as its good to fetch | unchanged (one spare request, served for another entry or dropped when the list is empty) |
| that delivery ends early (5.5 destructor; requester = the site) | the carried good goes back to the front | one list-1 request filed |
| pause construction (`004758c0`, 6.8) | cleared | every request for the site is removed from all four lists |
| resume construction (`00475990`, 6.8) | for each good still in the order: (amount still to consume − local stock) entries appended at the end | one list-1 request per appended entry |

Pause and resume (6.8) are one toggling command. Resume does not look at entries or transports
still under way, so a paused and resumed site can get a few units more than it needs; the builder
simply leaves them in the local stock *(I: consequence by reading)*.

The builder never requests goods. In phase 2 (waiting for material, 6.3) he only waits for the
local stock to fill; when no builder remains, a builder request is filed (6.4).

### 6.8 Pausing and resuming construction (C, `00452d20`, `0045f490`, `004758c0`, `00475ab0`, `00475990`)

**The command.** The panel's `BAUSTOP` / `BAUWEITER` button (side-panel.md 5.2 class 15) sends one
command that carries only the building. Its executor (`00452d20`) jumps to the building method
`0045f490`, which acts only when the building's current job is a construction job (type 0x11,
i.e. a site): if that job is **not blocked** (+0x04 ≤ 0) it pauses, otherwise it resumes. It is a
**toggle**: there is no separate pause and resume command, and a second click before the panel
redraws undoes the first. Nothing else in the program calls these functions: the **computer
players never pause** a site (C, the only references are this command path).

**Pause** (`004758c0`), all in the tick in which the command is executed:

1. The construction job is **blocked**: +0x04 = 50. A blocked job is not run (1.1). The
   construction job's own run does nothing anyway (it returns 10, `00475470`); the block is only
   the "paused" mark that the panel, the dispatcher and the builder destructor read.
2. **The builders are sent away** (`00475ab0`): for every entry of the site's builder list whose
   unit's **current** job is a builder job (0x0C) on this site: the job's cancel flag is set, the
   unit's current job is cleared at once (it now has no job and is a free builder for the
   dispatcher), and the entry is removed from the list. The cancelled job is deleted at its next
   due slot (1.1) without running again; its destructor (`00477b90`) sees the blocked
   construction job and therefore files **no** builder request, and sends the stop message if
   the work animation was on. Its walk child goes with it, so a builder walking between spots
   stops at the cell he is on. He stands there idle; he does not walk to the door (that is only
   the end of a completed job, 6.4.1). A builder whose builder job is **not** current (for example
   suspended behind a flee, `combat.md` 7.4) keeps it and stays listed; when it becomes current
   again he goes on building (next point).
3. **Every transport request** for the site is removed from all four lists (one per entry,
   whichever list).
4. The site's **needed-goods list is cleared**.

Not touched by a pause: the order (still-to-consume list, counter, R, stage), the HP and the
building sprite, the local stock (goods already delivered stay at the site), **transports already
under way** (a porter carrying for the site delivers into the local stock as usual; one that ends
early re-files its good to the needed list with a list-1 request, 5.5), open builder requests
(the dispatcher drops them, 5.2).

**While paused:**

- No new goods are fetched, except an entry re-filed by a transport that ended early: the
  dispatcher's building test (5.3) does not look at the block, so that entry **is served** (one
  extra delivery, quirk).
- **A player's delivery order is refused** (C, `004617c0` at instruction level, 3.2): the needed
  list is empty, so the site does not "accept the load"; the unit gets a plain go-to (0x07)
  instead, the site's door admits only builders and transports (4.4), and the unit stands idle in
  front of the site, still carrying its load. A delivery that was **already under way** when the
  pause came is not touched by the pause and lands in the local stock as usual; the resume then
  re-files only (still to consume − local stock). The only goods a paused site accepts by order
  are re-filed ones (an early-ended transport puts an entry back, see above).
- No builder is sent: an open builder request for the site is dropped (5.2), the last-builder
  rule does not fire (6.4).
- **The construction step does not check the block** (6.3). A builder that still works the site
  (a suspended one resuming, or one sent by a **player order**, which creates a builder job on a
  paused site like on any other, 3.2) goes on: he consumes from the local stock and makes work
  ticks, and may even finish the site; when the first listed good is not there he waits in phase 2
  for good, because nothing is being delivered. If such a builder's job ends while the site is
  paused he stays in the builder list as a stale entry (6.4).
- The panel shows T248 "Bau ist pausiert" as title and the `BAUWEITER` button (side-panel.md 5.2).

**Resume** (`00475990`):

1. The block is lifted: +0x04 = 0.
2. **One builder request** is filed, whether or not builders are listed.
3. If no order is current yet (the site was paused before its first construction call), the first
   order of the queue becomes current.
4. For each entry (good, amount still to consume) of the order's list, in list order:
   k = amount − local stock of that good; if k > 0, k needed-goods entries for that good are
   appended **at the end** of the needed list, each with one **list-1** transport request.
   Goods already lying at the site are thus not fetched again; entries re-filed during the pause
   and transports still under way are **not** subtracted (possible over-supply, 6.7).

So after a resume the site is in the same state as a freshly placed one with a partial stock: a
builder is called, the missing goods are requested, and building goes on from the old counter
and stage.

### 6.9 What the site panel shows (C, message `00456af0`, page `0041ffb0`)

The site's info message is built from the construction job's current order: for each entry of the
order's **still-to-consume list** (6.2), in list order, it carries the good, the amount still to
consume and the site's **local stock** of that good; then the progress percent (vtable[6], 6.3),
the paused flag (construction job +0x04 > 0) and the HP. The panel draws (positions in
side-panel.md 5.2 class 15) one entry per listed good, up to three, as the good's icon and the text
`local stock / still to consume` (format `%d/%d`, confirmed at `0042030a`: the first argument is the
local stock, the second the list amount).

Consequences:

- A good **disappears** from the panel once its last unit is consumed; a site whose goods are all
  consumed shows no material entry at all while the builder makes the remaining work ticks.
- The second number goes **down by one at each consume**; the first number goes down at each
  consume and **up at each delivery**. So delivered goods are shown, and the panel's numbers fall
  as the building rises (worked example in 6.3).
- **Goods on the way are not counted**: a site whose wood is being carried shows `0/2` for wood.
  `first = second` means everything still to be used is lying at the site; `first < second` means
  the rest is missing (requested, on the way, or lacking in the town stock). The first number can
  exceed the second after an over-supply (6.7).
- Nothing on the panel shows the needed-goods list or the transport requests.

### 6.10 Our build: builder waits and the site panel (diagnosis and fixes, October 2026)

The report "the builder stops as if goods were missing while the panel shows all goods present"
was reproduced with simulations of many sites and several builders (own sites and computer
towns, up to 60,000 ticks; every builder wait logged with the site's local stock, needed list and
the transports under way). Every wait of a builder with the panel "full" was a wait for the
**first listed good while it was still being carried** (transports of up to about 1,100 ticks in
busy computer towns), usually with the other goods already at the site. The builder resumed
within 15 ticks of each delivery; no good was lost and no builder stood with his first good in
stock. The builder's wait is the original's (6.3); the deviation was the panel:

1. **Panel** (`src/client/hud-pages.ts` `siteInfo`): it showed `(cost − needed entries) / cost`
   per good of the building cost, so a good counted as present as soon as a porter had been
   dispatched for it, and the numbers never went down while building. Now 6.9: the order's
   still-to-consume list, `local / still to consume`, at most three entries, entries vanishing
   when consumed.
2. **Pause** (`src/engine/logistics.ts` `buildingAction`, `constructionStep`, `dispatchBuilding`,
   dispatcher part A, `builderLeft`): pausing only set a flag; the builders stayed on the job
   (standing, or walking to the site), the requests stayed queued, builder requests were still
   answered, and resume filed one more request per remaining needed entry (duplicates). Now 6.8:
   one toggling action, builders sent away, requests and needed list cleared, builder requests
   for a paused site dropped, the step ignores the pause, resume re-requests (still to consume −
   local) and files one builder request.
3. **First spot** (`runBuilder`): our builder made his first construction call at the entrance
   and started the spot cycle at the +y side; now he walks from the entrance to the +x spot first
   (6.4, 4.8).

Tests: `test/construction-site.test.ts`.

---

## 7. Gathering and nature

### 7.1 Harvest job (0x16, `00476a70`) (C)

Fields: target +0x24, phase +0x28, good +0x2C, amount being worked +0x30, trip counter +0x34,
auto-continue +0x38. It starts in phase 0, or in phase 2 when the unit already carries
something (deposit first).

On every run, **first**, if the target object has been removed (its alive byte is clear; the
job still holds a reference to it, so its last cell is known):

- with auto-continue: run the **next-object search** (7.1.1) around the removed object's cell.
  If it finds one, that becomes the target (the old reference is released). If the unit is
  **not carrying** anything, the running child (walk, attack) is dropped and the phase becomes 0;
  a unit that is carrying keeps its delivery running and comes to the new target afterwards;
- without auto-continue, or when the search finds nothing: the target is cleared. If a delivery
  is running (phase 3) it is finished first, then the job ends; in every other case the job
  ends at once.

| phase | action |
|---|---|
| 0 | approach (`00476930`): the trip counter (+0x34) is reset to 0. Living animal: attack job 0x08 (phase 7). Otherwise go to the object (0x07, phase 1). A unit that is carrying something in phase 0 ends the job |
| 1 | the go-to has ended (whether or not the walk succeeded; the go-to does not report failure). **Usable test** first: the target must still have unreserved amount (7.1.1). If it has none: with auto-continue run the next-object search from the target's cell; if one is found, switch to it and go to phase 0 (1 tick); otherwise (or without auto-continue) the job ends. If usable and the unit is within 1 cell of the target on both axes: phase 6 (1 tick). Otherwise walk to the first free cell of the spiral around the target (4.8) and stay in phase 1, so this test repeats after **every** walk, **without any limit** |
| 6 | turn to face the target. A standing tree (+0x4E) gets the work animation and 100 ticks (felling), then phase 5 |
| 5 | standing tree: clear +0x4E, play the tree's fall animation, 25 ticks, phase 5 again. **Hunter (17)**: take min(4, unreserved) at once, then carry. **Others**: work animation, amount = 1, reserved +1, **100 ticks**, phase 2 |
| 2 | the work ends: unreserve; remaining −= amount; the unit carries the good. Its base action becomes carry (4). The object's display is updated (it may disappear, 7.5). Then a transport to the nearest store (5.6), phase 3 |
| 3 | delivery done. If still loaded (store full or missing): trips + 1, try again after min(5 × trips, 25) + 2 ticks, or wait 100 ticks if no store exists. If empty and the target still exists: back to phase 0, **even when the target has no unreserved amount left** (the usable test only comes on arrival, phase 1). If the target is gone: end |
| 7 | the attack is over: run the phase-0 approach again. Killed (+0x4C cleared): approach the carcass with 0x07 (phase 1). Still alive (chase given up): a new attack (7.3.4) |

**Yield per trip: 1 unit** (hunters up to 4). One unit takes 100 ticks of work, plus the walk
to the store and back (C).

#### 7.1.1 Moving on to the next object (`00462630`, `004635c0`) (C)

Gatherers have no workplace building; everything is anchored on the **last target object**.

**Usable object** (`004635c0`): a nature object (object kind 2) whose record class (+0xC0) equals
the class of the old target's record, and whose remaining amount differs from its reserved
amount (that is, some amount is not yet promised to a worker). Nothing else is tested: not the
distance to the unit, not reachability, not territory, not the owner. The test is by class,
not by harvest permission, so for rubble (class 0) any other class-0 nature object with amount
qualifies, goods piles included.

**Reservation.** An object's reserved amount (+0x54) only covers the work in progress: a
worker adds 1 when its 100 ticks of work start (phase 5) and removes it when the work ends
(phase 2), together with lowering the remaining amount. Walking to an object does not reserve
anything. Several gatherers may therefore head for the same object; on arrival (phase 1) the
usable test decides. The reservation itself in phase 5 is not guarded: a worker that passed the
usable test and then spent a few ticks turning can reserve a unit that another worker reserved
meanwhile, and still receives one unit of goods at the end (the remaining amount is only clamped
at 0).

**Search** (`00462630`): a square spiral of cells around the old target's cell, on the wrapping
map, **rings 0 to 9** (cells with max(|dx|, |dy|) ≤ 9, a 19 × 19 square, 361 cells):

1. ring 0: the old target's own cell;
2. ring r (1..9) starts at (x + r, y − r) and runs along the +x side towards +y to (x + r, y + r),
   then along the +y side towards −x to (x − r, y + r), then along the −x side towards −y to
   (x − r, y − r), then along the −y side towards +x back to (x + r, y − r) (that corner is looked at
   twice).

For each cell the object registered on the cell (one per cell) is tested; the **first usable
object in this order** is the result. Distance to the unit plays no part.

**When the search runs** (all with auto-continue only):

- at the start of any run in which the target has been removed (7.1, first paragraph): centred on
  the removed object's cell. This covers the usual case, the last unit taken (the object is
  removed in phase 2, 7.4), and is normally seen at the run after the delivery has ended;
- in phase 1, when the target still exists but is not usable (all its remaining amount is
  reserved by others, or it is an emptied bush that stays): centred on the target's cell.

**Nothing found.** The harvest job ends. There is **no retry and no timer**: the unit stands
where it was (at the store after a delivery, or next to the exhausted object), without a job,
and gatherers never look for work on their own (7.2). It starts again only by a new player
order. A stonemason whose last stone lies more than 9 rings from every other stone therefore
stops, which is the intended behaviour of the original, not a failure.

**Who has auto-continue.** Player orders on nature objects for woodcutters, stonemasons and
porters (on bushes and rubble) set it (3.2); hunters' harvests (inside the
hunting-ground job) and list-3 pickups by porters do not.

**Crowding at one object.** Workers that do not reach a cell within one cell of the target
(the cell they aimed for is taken by a worker already there, 4.8) walk to the first free cell of
the spiral around the target (mask 0x3E: units count, the walker's own cell included, so it
never chooses the cell it stands on). When all neighbours are taken this is a cell of ring 2 or
farther, which does not pass the "within one cell" test, so the worker keeps walking between
free cells near the object, re-testing after each walk, until a neighbour cell becomes free
(a worker leaves to deliver) or the object stops being usable, which sends it to the search.
It does not go idle while the object is usable.

**Our build (October 2026).** Before this section was written, ours ended the harvest (the
gatherer went idle) when the walk to the spiral cell in phase 1 also ended out of reach (only
one such walk was allowed), and when the first walk to a new target could not be planned. With
several gatherers on one object this happened within a few hundred ticks. Rules for ours:

1. Phase 1 has no walk limit, as above. The spiral cell is the first free cell (units count,
   the walker's own cell included) within 24 rings of the target.
2. A walk that cannot be planned at all (`World.walk` false) counts as a walk that ended
   without success after the original's 15 plans: the harvest waits **150 ticks**
   (3 + 4 + ... + 17, the plan delays of 4.1) and then runs the phase-1 test again, in phase 0 as
   well as phase 1. A target that can never be reached therefore keeps the worker trying, as in
   the original; it is never a reason to end.
3. The next-object search is the spiral above (rings 0..9, same order, first hit). Deviation:
   candidates must also be objects the unit may harvest (odb.md "Harvest rule"), and rubble
   only continues to rubble, so a stonemason on rubble does not wander off to goods piles.
4. Phase 5 re-checks the unreserved amount before reserving (no unit of goods out of nothing);
   when it is gone the worker goes back to the phase-1 test (which then searches).
5. A removed target found while the unit is delivering is replaced at that run (the delivery
   goes on); with no replacement, the job ends when the delivery is over. The trip counter
   counts failed deliveries and is reset by the approach, as in the original.

### 7.2 Who gathers what, and how it starts

| resource | worker | started by | per unit |
|---|---|---|---|
| tree (class 8; 4 or 6 wood) | woodcutter (19) | player order, harvest with auto-continue | first fell: 100 + 25 ticks, then 100 per wood |
| stone (13; 12 or 14 stone) | stonemason (27) | player order | 100 per stone |
| rubble (type 38; 8 stone) | stonemason or porter | order; also automatically on building destruction (list 3) | 100 per stone |
| bush (9; 5 food) | porter | player order only (never automatic) | 100 per food |
| own race crop (10..12; 1 raw) | porter | **automatic**: list-3 request filed at planting, picked when ripe | 100 |
| animal (7; 4/8/12 food) | hunter (17) | player order or map order, both of which become a hunting ground (7.3) | kill, then up to 4 per trip with no work time |

Woodcutters, stonemasons and hunters never start on their own (handbook 6.3) (C). The hunter
is the exception after his first order: his hunting-ground job (7.3) keeps looking for animals
for ever.

### 7.3 Hunting ground: the hunter's job cycle (job 0x2B, run `00479800`, ctor `00479710`) (C)

Job 0x2B exists **only for hunters** (type 17). Its scan is hard-wired to animal class 7. The
handbook calls it the hunter's area; the unit panel shows it as "Hält nach Tieren Ausschau"
(see 7.3.6). Gold: the same job at `dvge.exe` `00483d00`, same constants (C).

#### 7.3.1 Creation

| source | spot (job +0x24/+0x28/+0x2C) | first child | first run |
|---|---|---|---|
| player right-clicks an animal (living or carcass) with a hunter (`00450bb0`, `004635f0`: hunter + class 7) | the clicked animal's cell **at the moment of the order** | a harvest job (0x16) on that animal, **auto-continue off**, phase 0 (phase 2 if the hunter carries something) | after the usual order delay |
| map load, hunter listed in the map's order records (`00411200`) | the record's target cell | none | rand() % 5 + 1 ticks |

No other code creates job 0x2B. Computer players use their own gang jobs (see
`ai-diplomacy-trade.md`). The job never ends by itself; only a new order (or death) removes it.

#### 7.3.2 One run of the hunting-ground job

**A. A child is running** (harvest or walk): run it. While it returns a delay, return that delay.
When it finishes:

- **the child was the harvest (0x16)**: the animal is used up, or the chase failed, or there was
  no store. Find the first cell of the square spiral around the **spot** (4.8: the spot itself,
  then ring 1, ring 2, ...) whose flags miss 0x3E (no unit, building, nature object, special,
  water). That cell becomes the new spot. Start a plain follow-path walk (0x06) to it. Return
  **5**;
- **the child was the walk**: set the spot to the hunter's **current cell** (wherever the walk
  really ended, even if it was cut short) and return **20**.

**B. No child:**

1. d = distance (max + min/2, wrapped) from the spot to the hunter. If **d > 4**: walk back
   exactly as in A (spiral free cell around the spot, which also becomes the spot). Return 5.
   In practice this happens only on the first run of a map-load hunter, because every finished
   walk re-anchors the spot on the hunter.
2. Otherwise **scan for animals** (`00449a30`, 7.3.3). If one is found, start a harvest job on it
   (0x16, auto-continue **off**; phase 2 first if the hunter still carries something) and
   return 5.
3. Nothing found: return **20**. The hunter stands where he is and looks again 20 ticks
   (about 1.9 s at normal speed) later. There is no random element and no give-up.

#### 7.3.3 The animal scan (`00449a30`, called with class 7 and radius = hunter sight)

- **Area:** the **square** of cells |dx| ≤ R, |dy| ≤ R around the **hunter's own cell**, with
  R = the hunter's sight (+0xB0) = **10** for all three races (a 21 × 21 square). The map
  wraps.
- **Candidates:** only cells that carry the nature flag 0x10 are looked at. The object on that
  cell must have class (+0xC0) **7**: any animal, **living or a carcass**. Nothing else is
  checked: not the remaining food, not a reservation, not whether another hunter is already
  chasing it.
- **Choice:** the candidate nearest to the **spot** (distance max + min/2, wrapped), not to the
  hunter. Ties go to the first one in scan order: rows from dy = −R to +R, within a row
  dx = −R to +R; a later candidate replaces the choice only if it is strictly nearer.
- The same routine with class 8 serves the respawn manager (7.5). So the mask argument
  (open point 12.8) is simply the class to match.

Because the hunter has walked back to (or is standing on) the spot, "view" in practice means the
21 × 21 square around the spot. An animal that wanders into that square is noticed at the next
20-tick scan.

#### 7.3.4 The harvest sub-cycle for a hunter (job 0x16 phases of 7.1, hunter specifics)

1. **Phase 0, approach** (`00476930`): a **living** animal (+0x4C set) gets an **attack child**
   (0x08) with auto-retarget on and anchor = the animal's cell now (`combat.md` 3, 14); phase 7.
   A carcass is approached with go-to (0x07); phase 1.
2. **Attack** (`combat.md` 14): the hunter walks until the animal is in weapon reach, turns, and
   strikes. Amazons shoot (bow, reach 5 straight / 4 diagonal), Pimmons and Sajiki stab with a
   spear from an adjacent cell. The animal keeps wandering, so the chase re-plans; the chase is
   given up when the animal is more than **29** cells from where it stood when the attack began,
   or after 5 failed path plans (`combat.md` 3.3, 3.5). One connecting hit kills (animals have
   10 HP). The animal becomes a carcass on its cell (`combat.md` 10.2).
3. **Phase 7**: the attack child has ended. The approach of phase 0 runs again at once:
   - carcass: go to it with go-to (0x07). The hunter walks to the first free orthogonal
     neighbour N, W, S, E of the carcass cell (4.8); phase 1;
   - **still living** (the chase was given up: leash or 5 failed plans): a **new attack** starts
     immediately, with a new anchor at the animal's current cell. The hunter therefore never
     drops a living animal he has chosen; with an unreachable animal he keeps re-planning
     (C by code reading; no guard found).
4. **Phase 1**: within one cell on both axes? Then phase 6. Otherwise walk to the first free
   cell of the 0x3E spiral around the carcass (4.8).
5. **Phase 6**: turn to face the carcass (4.6), one turn call per run.
6. **Phase 5, hunter branch**: no work animation and no work time. Take
   **min(4, remaining − reserved)** food at once. The hunter carries it (base action becomes
   carry, `CA`), the carcass loses that amount and its display stage is updated (7.4); a carcass
   at 0 is removed and filed for respawn (7.5).
7. **Delivery**: a free transport (5.6) to the nearest store **to the hunter's current
   position** (4.3). The harvest job returns **2** (5 × trips + 2 with trips still 0) and waits
   in phase 3.
   - **No store at all**: phase 5 returns 0, so the harvest job **ends with the hunter still
     carrying the meat**. The hunting-ground job then walks him back to the spot; the next scan
     starts a harvest that begins in phase 2 (deliver first), which retries every 100 ticks while
     no store exists.
8. **Phase 3** (the transport finished):
   - still loaded (store full or refused): trips + 1, find a store again, return
     min(5 × trips, 25) + 2 (or 100 and phase 2 when none);
   - empty and the carcass still exists: back to phase 0, which now goes to the carcass (it is
     no longer living);
   - empty and the carcass is gone: the harvest job ends.

**From the killing strike to the first step toward the carcass (C, `00481450`, `00472b20`,
`00476a70`, `00476930`, `0047ac90`, `00480410`, `0047fc00`).** All ticks below are simulation;
the animation lengths are display.

- **When the range is tested.** While the hunter approaches, the attack job runs once per step,
  D ticks after the step started (the follow-path child's delay, 4.1). So the strike job is created
  only when the step onto the firing cell has been fully played on screen. Its first run turns
  him (one 45° step per 2 ticks, combat.md 4.1) and then fires at tick **S**: the action message
  plays `ST` once, and the impact job is scheduled.
- **The kill** is the impact job at **I = S + impact delay** (combat.md 4.3): Amazon 11 (1 cell)
  to 14 (5 cells straight) or 15 (4 cells diagonal); Pimmon spear 6; Sajiki spear 8. At I the
  animal becomes a carcass (picture, death cry).
- **The hunter does not react at I.** After firing, the strike job returns 5, and while the
  cooldown is far from over every later run returns 5 again. So the whole chain (0x2B → harvest →
  attack → strike) runs only at S+5, S+10, S+15, ... Its first run at or after I is **K**. When
  both fall in the same tick, the impact runs first (it was inserted earlier). At K the attack job
  finds no living animal, its retarget scan finds nothing (it collects only units and buildings)
  and it ends. Harvest phase 7 creates the go-to child on the carcass and returns 1. Nothing is
  sent to the display in this run: no stop message and no change of the base action.
  K = **S+15** for the Amazon (every delay 11..15 rounds up to 15), **S+10** for the Pimmon and
  Sajiki hunters.
- **K+1**: the go-to job picks its target cell (4.8: the carcass cell, then N, W, S, E; units do
  not count, so the hunter's own cell can be the goal), creates a follow-path child, returns 1.
- **K+2**: the follow-path child's first run. If he is already on the goal it succeeds at once:
  go-to turns him toward the carcass at K+3, harvest phase 1 at K+4, phase 6 (turn), phase 5
  takes the meat (base action carry) about K+5. Otherwise it starts the first plan and returns 3.
- **K+5**: turn toward the first path cell (45° free, 1 tick per further 45°) and the **first
  step**. The planner is a background task; if it has not finished, the job polls every 2 ticks
  *(I: in practice the path is ready)*.

| hunter | `ST` row | strike seen (95 ms per tick) | first step S+… | first step on the GOG clock (≈109 ms per tick) | standing between |
|---|---|---|---|---|---|
| Amazon (bow) | 12 frames | 17.1 ticks = 1.63 s | 20 | ≈ 2.19 s | ≈ 0.55 s |
| Pimmon (spear) | 11 frames | 15.7 ticks = 1.49 s | 15 | ≈ 1.64 s | ≈ 0.15 s |
| Sajiki (spear) | 12 frames | 17.1 ticks = 1.63 s | 15 | ≈ 1.64 s | ≈ 0 |

So the strike always plays out, then the hunter stands (standing pose, facing the animal) for a
moment, then walks. A miss (Amazon, 30 %) kills nothing; the next strike follows 41..61 ticks
after the last one.

**How the first step begins (no jump).** The hunter has stood on the firing cell since the step
onto it ended, and the strike's action message has cleared any remaining drawn step offset anyway
(`docs/rendering/unit-motion.md` 3). The first step message carries the delta firing cell → next
cell, so the drawn position starts exactly where he stands. If the `ST` row were still playing, the
step message would cut it and return to the walk row.

Trips per animal: hare (4 food) 1, Fasterator and Echse (8) 2, Necktor and Sumpfling (12) 3.
After the last piece the harvest ends **at the store**, and the hunting-ground job immediately
(5 ticks) sends the hunter back to the spot.

If the carcass is removed while the hunter is still on his way to it (another hunter took the
last piece), the harvest job notices the dead target at its next run, releases it and ends once
the hunter carries nothing. Then the hunter walks back to the spot as above.

#### 7.3.5 Where he waits

The waiting place is the **spot**, not the place where the last piece was taken:

- first, the cell where the ordered animal stood **when the player clicked it** (or the map
  order's cell);
- moved to the nearest free cell (0x3E spiral) if that cell is occupied when he returns;
- re-anchored to the cell where his walk back actually ended.

So the spot drifts only by a cell or two (occupied cells, blocked walks). The carcass usually
lies near the spot, because the chase starts from the spot and is leashed at 29 cells, which is
why the return can look like "back to where the last piece was".

While waiting the hunter has a job, so the display's idle fidget command (4.9) is ignored: he
just stands in his standing pose (walk row frame 0) facing the way he arrived.

#### 7.3.6 Status text (`docs/rendering/unit-motion.md` 6)

| state | panel text |
|---|---|
| waiting at the spot (no child) | T267 "Hält nach Tieren Ausschau" |
| walking back to the spot (direct child is a walk) | T279 "Unterwegs ins Jagdgebiet" |
| chasing and striking (an attack anywhere in the child chain) | T268 "Jagt %s" (the animal) |
| going to the carcass, carrying, delivering | the harvest's T263 "Sammelt %s" |

#### 7.3.7 Timeline example (Amazon hunter, flat ground, hare 8 cells from the spot)

| tick (approx.) | event |
|---|---|
| 0 | scan finds the hare (nearest to the spot); harvest → attack child |
| 1..3 | path to a firing position; walks ≈ 3 cells (5 ticks per straight cell) |
| ≈ 18 | in reach (5 cells straight), stops, turns (2 ticks per 45°), strikes |
| +10 | arrow released (sound frame 7 of the 12-frame `ST` row, `combat.md` 6.1) |
| +14 | impact (strike + (355 + 1000)/100 + 1): 70 % chance the hare dies |
| (miss) | next strike 41..61 ticks after the last one |
| after the kill | strike tick + 15: the attack ends; + 20: first step toward the carcass (7.3.4, "From the killing strike"); take 4 food, carry to the nearest store |
| after delivery | carcass empty (hare) → harvest ends → 5 ticks → walk back to the spot |
| arrival | spot := current cell; 20 ticks later the next scan |

#### 7.3.8 When no animal exists

The scan simply finds nothing and the job returns 20, for ever. Animals come back only through
the respawn manager (7.5): each animal a hunter used up is replaced, one for one and of the same
type, on the 21st run of the 299-tick manager after it was used up (5981..6279 ticks), near the
**tree** (class 8, not an animal) nearest to where it died, if one stands within 10 cells. Since
animals are placed in forests, a hunted-out forest refills to its starting animal count; only an
animal that died more than 10 cells from any tree is lost for good.

#### 7.3.9 Our build (`src/engine/logistics.ts` `startHunt`/`runHunt`, `src/engine/world.ts`)

Implemented as above (October 2026): a player order on an animal with a hunter, and a hunter's
map order record, create job 0x2B (`LJ.Hunt`) with its spot; the harvest child runs without
auto-continue; the walk back, the re-anchoring, the 20-tick waits, the ±R square scan (R = the
hunter's +0xB0, 10) choosing the animal nearest the spot, the rescans for ever, min(4, remaining)
per trip without work time, the new attack on a still-living animal after a given-up chase, and
the no-store case (the harvest ends with the meat carried) follow 7.3.1..7.3.5. The no-weapon
kill-on-arrival shortcut of harvest phase 1 is gone: a living animal is only ever killed by the
attack. Status texts T267 / T279 / T268 / T263 (7.3.6) are in `hud-pages.ts jobText`. Tests:
`test/hunting.test.ts`. Remaining differences:

1. The children are not separate scheduler jobs: the harvest state (`HV`, with its attack state)
   and the walk are kept inside the 0x2B job's data (`HG`: child, spot, harvest slots). The walk
   child polls every tick until the walk has ended instead of returning the follow-path delays.
2. The scan walks the list of class-7 objects and ranks them by the scan order (row dy, then dx)
   instead of reading the cells' nature flag; the result is the same.
3. Our spiral search for the walk-back cell stops after 16 rings; with no free cell there the
   hunter keeps his spot and the walk ends at once.
4. The new attack after a given-up chase is started on the next tick (delay 1). For an animal that
   cannot be reached at all this re-plans about every other tick, as in the original's code
   reading (no guard).
5. In the no-store case the meat is taken in our phase 2 (where the carcass is lowered) and the
   harvest ends there; the observable result is that of 7.3.4 step 7.
6. Computer players' hunters still use their own harvest with auto-continue
   (`ai-town.ts`); only the player order and map orders create 0x2B.

Differences after the kill (checked October 2026 against "From the killing strike" in 7.3.4):
*fixed October 2026* (`test/hunting.test.ts` "hunter after the kill", `test/unit-motion-display.test.ts`):

7. The range is tested only when the last step's D ticks are over (`combat.ts attackStep`: while a
   step is under way the attack returns the remaining ticks), for every attacker.
8. Harvest phase 7 only marks the go-to at K (our phase 8); the target cell is chosen at K+1
   (phase 9), the path planned at K+2, so the first step comes at K+5 (plus turn ticks).
9. Planning a walk (`goCell`) no longer changes the action; the walk/carry action comes with the
   first step (`World.stepTo`), so the strike plays out.
10. The client clears the remaining step offset when an action starts (`display.ts UnitDisplay`),
    so no frozen half step is released in a jump.

### 7.4 Depletion and display (C, `004636b0`)

Each harvest lowers remaining (+0x3C). The display frame is
(full − remaining) × F / full (integer division) of the object's stage sprite, sent as message
(0x26,9). F is that sprite's frame count, **minus 1 for objects that stay when empty** (bushes,
+0x4D = 0), so an empty bush shows exactly its last frame. The same update follows every change of
the amount: harvest, a hunter's pickup, an animal eating (7.7.1) and regrowth.
*(Our `looks.ts` `lossFrame` uses F − 1 for bushes (class 9) and F otherwise, clamped to the
sprite; fixed October 2026.)*

When remaining reaches 0:

- **bushes** (+0x4D = 0, yield food) stay and get a **regrowth job** (0x1E): every 299 ticks a
  counter falls; at 0 one food is added back and the counter restarts at the same random value
  20..24. **One food per (20..24) × 299 ticks**, about 9.5 to 11.4 minutes at normal speed,
  until full;
- **animals and trees** are scheduled for respawn (7.5) and removed;
- **everything else** (stones, rubble, crops, piles) is removed.

### 7.5 Growth and respawn (C)

- **Crops** (classes 10..12) are created with amount 0, stage 1 and a growth job (0x1D, first
  run after 599 ticks). On that run the crop becomes ripe (`004020a0`): amount 1, stage 0,
  "removed when empty". It is then picked by the waiting list-3 porter.
- **Planted trees** (respawned trees, `004638d0` with the planted flag): amount 0, stage 1,
  growth job. Every 599 ticks the growth frame +0x58 advances. When it equals the frame count of
  the tree's growth sprite, the tree is full: amount = full, stage 4, standing (`00481ee0`).
- **Respawn manager**: see 7.5.1.
- Stones and rubble never come back. Bushes regrow (7.4).

#### 7.5.1 The respawn manager (job 0x37) (C; AN `004824a0` / `004825f0` / `004826a0`, Gold `0048d870` / `0048d920`)

This is the **only** way animals are replenished. Nothing else in the program creates an animal
after the map exists: the nature constructor (`004638d0`) is called only by the map loader, the
free-play cluster placer, the farm planter (crops), the building collapse (rubble) and this
manager. There is no timer that tops up a population, no per-island or per-map cap, no breeding,
no spawning at the map edge or out of view. The rule is the same in missions, free play and
add-on free play, in AN.exe and in Gold.

**The manager.** One global job, created at game start right after the scheduler (world set-up `00485a30`,
before the map objects; a save game restores it instead), first run 299 ticks later and then **every 299 ticks for
the whole game**, whether or not it has entries. It holds a list of entries, each
{type (+0xA8 of the dead object), class (+0xC0), cell x, cell y, search radius, countdown}, kept
**sorted by countdown ascending**. A new entry is inserted in front of the first entry whose
countdown is greater than or equal to its own (so among equal countdowns the newest comes first).

**Filing.** The depletion routine (7.4) files an entry when the remaining amount of an object
reaches 0 and the object is not a bush:

| class | radius | countdown |
|---|---|---|
| 7 animal | 10 | 20 |
| 8 tree (base trees and add-on palms) | 15 | 40 |

The position is the object's own cell. Other classes file nothing. For an animal this happens
when the hunter has carried away its last food (7.3.4), not when it is killed: a carcass that is
never emptied (killed by soldiers, or a hunter that gives up) never respawns.

**A run** (`004826a0`):

1. While the list is not empty and the **first** entry's countdown is **0**, take that entry:
   1. Scan for a **survivor**: the routine of 7.3.3 (`00449a30`) with class **8 (tree)**, a
      literal in both executables, **for animal entries too**, and radius = the entry's radius.
      The square |dx| ≤ R, |dy| ≤ R around the entry's cell is searched (wrapped); only cells
      with the nature flag 0x10 count, and the object on the cell must have class 8 (any tree:
      full, being felled, or a small planted one). The tree nearest the entry's cell wins
      (distance max + min/2, wrapped); ties go to the first in scan order (rows dy = −R..R, in a
      row dx = −R..R).
   2. No tree: nothing is created (no `rand()` drawn).
   3. A tree at (tx, ty): `x = tx + rand() % 7 − 3`, then `y = ty + rand() % 7 − 3` (two draws, x
      first; wrapped). From (x, y) walk the **square spiral of 4.8** (the cell itself, then ring 1
      from (x+1, y−1), and so on, **no limit**) to the first cell whose flags miss **0x1003F**:
      path flag 0x01, unit 0x02, building 0x04, special 0x08, nature 0x10, water 0x20, and in
      Gold the class-0 flag 0x10000 (addon.md 10.2; AN.exe never sets it). A flagged cell is
      skipped, never a reason to give up.
   4. Create a new nature object of the **entry's type** on that cell with the "planted" argument
      set. A tree starts small and grows (7.5). An animal is constructed exactly like one placed
      at map load: its animal job (7.7) draws `rand() % 3` for its first mode, then the job is
      scheduled `rand() % 40 + 1` ticks later; home = the new cell.
   5. Remove the entry (found or not) and repeat with the new first entry.
2. Then **decrement every remaining entry's countdown** by 1, and return 299.

So an entry filed with countdown c is decremented on the next c runs and handled on run c + 1:
an animal **21 runs** after it was used up (5981..6279 ticks, about 9.5 minutes at normal
speed), a tree 41 runs later. Entries due in the same run are handled in list order.

**Consequences.**

- Each animal used up is replaced by one animal of the **same type**, so the species mix and
  the head count of a forest stay those of the map's start (populated: types 33..36 in base free
  play, plus 37, 39 and 40 in add-on free play, world-populate.md 5, addon.md 8; missions: the
  map's own animals). Respawned animals breed nothing further; the population never exceeds
  the number ever used up plus the living ones.
- The new animal stands within about 3 cells (more if that area is full) of the tree nearest to
  where it died, so it usually comes back in the same forest, often a few cells off the hunter's
  21 × 21 view square around his spot. Animals that died more than 10 cells from any tree (and
  trees felled more than 15 cells from any other tree) are lost.
- Nothing checks towns, territory, units nearby, the fog or the screen: an animal can come
  back inside a town or next to a hunter. It cannot jump to another island only because the tree
  must be within 10 cells of where it died (the spiral can still cross a narrow strait).
- Wandering and eating (7.7) are unaffected; a respawned animal is an ordinary wild animal.

**Our build** (`src/engine/logistics.ts` `startRespawnManager`, `fileRespawn`, `runRespawn`,
`scanTree`, `respawnFree`; test `test/animal-respawn.test.ts`). As above since October 2026.
Before, the survivor had to be a *living animal* of the same class within the radius, an
occupied target cell cancelled the respawn instead of spiralling on, entries were handled on the
20th run in filing order, and the manager only ran while it had entries; a hunted-out forest
therefore never got its animals back. Differences that remain:

1. The manager is created in the `World` constructor before the map objects, with delay 299, so
   it runs in world ticks 299k + 1. A restored save without a manager (older saves) gets one on
   the same grid. Its position among other jobs due in the same tick follows our scheduler.
2. Special objects (flag 0x08) are not modelled, so the spiral does not test them.
3. The initial animal mode is drawn at map load too (7.7), from the world stream; the
   populators still draw (and discard) the constructor's two draws in their own streams.
4. Fish (add-on) are never filed (addon.md 6.1).

### 7.6 Farms and farmers (C, `00478cb0` case 14, `0047ead0`)

- The farm (45) is "staffed" (flag 0x4). When its farmer enters, the operator job (0x22) is
  created with first delay 100, then runs every **99 ticks**.
- Each run:
  1. Count objects of nature type crop_base .. crop_base+3 within **radius 6** of the farm.
     crop_base is the farmer record's +0x11C: 17 cocoa, 21 mushrooms, 25 maggots.
  2. If there are fewer than **10**, the farmer is sent out with a planting job (0x21) for type
     crop_base + random(0..3).
- Planting job:
  1. Choose a cell: x = farm x + random(0..2), or farm x − random(0..2) − 2, each with
     probability ½. y is chosen the same way.
  2. If that cell cannot take an object, give up. Otherwise walk there.
  3. Play the work animation for **50 ticks**.
  4. Walk back to the farm.
  5. As soon as the farmer steps off the planting cell, the crop is created (if the cell is
     still free) and a **list-3 pickup request** is filed for it.
  6. Re-entering the farm restarts the operator job.
- A crop gives 1 raw material, ripe after 599 ticks. Porters bring it to a store. Conversion of
  raw material to food (2 per unit) happens in the town stock (`0046e820`), see economy.md.

### 7.7 Wild animals (job 0x24, `004743b0`) (C)

The home cell is the spawn position. The job keeps a mode (+0x2C) and runs one child job per
mode. The **first mode is random**: the job's constructor (`00474360`) sets it to `rand() % 3`
(0 wander, 1 idle, 2 eat), for animals placed at map load and respawned ones (7.5.1) alike:

| mode | action |
|---|---|
| 0 wander | random point home + (rand() mod 15 − 7) on each axis. The goal is the first cell of the square spiral around it (4.8) whose flags miss 0x3E. Follow-path child |
| 1 idle | turn/idle child (job 0x1F, 4.9): turn to **direction 3**, then play action 3 (`ID3`) with **repeat count 10**, i.e. 11 cycles on the display. Every animal type (33..37) has `ID3` and `ID5` |
| 2 eat | scan the cells with dx² + dy² < 100 around **home** for nature objects (`0044a7c0`, combat.md 8.3; rebuild order: ascending object id). A candidate is a bush (class 9) or crop (10..12) with unreserved amount whose cell **(x, y − 1)** misses 0x3E (no unit, building, nature, special or water). Only then is rand() drawn, and the candidate is taken when rand() mod 3 = 0. Eat **1 unit** of it (job 0x2A, 7.7.1). This is handbook mentor#81 "animals eat plantations" |

When a child ends:

| finished mode | next mode | delay |
|---|---|---|
| wander | idle or eat, ½ each (rand() mod 2) | 1 tick |
| idle | wander or eat, ½ each | **50 ticks** |
| eat | wander | 1 tick |

When a mode starts nothing, the job waits rand() mod 25 + 25 ticks (25..49). This happens when
wandering or eating is skipped because a global counter (`004b5148`, I: the number of running path
planners) is 20 or more, or when no food is found. In the last case the next mode is set to wander
or idle (½ each) and the job returns 5.

All draws use the simulation's `rand()`. Animals are nature objects: the display idle timer
(`docs/rendering/unit-motion.md` 4) never fires for them. Their idle animation shows after the
turn to 3, for up to 50 ticks, until the next walk cuts it off. An animal blocks its cell for
units (flag 0x10, 4.7). Animals start after a random delay of 1..40 ticks (`004638d0`). The
nature constructor draws, in this order: the job's first mode `rand() % 3`, then the delay
`rand() % 40 + 1`.

#### 7.7.1 Eating (job 0x2A, run `00473d50`, destructor `00473ce0`) (C)

The eat job is a child of the animal job. Fields: the food object (+0x24, referenced) and a phase
(+0x28). The **eating place** is always the one cell **(x, y − 1)** of the food (wrapped), the grid
neighbour toward facing 7. On screen that is the cell up-left of the bush, behind it. From there the
animal faces **3** (down-right), toward the bush.

| run | phase | what happens | returns |
|---|---|---|---|
| creation tick (animal job, mode 2) | – | the food was chosen (7.7 table); the eat child is created | 1 |
| +1 | 0 | if (x, y − 1) still misses 0x3E: a plain follow-path child to exactly that cell, phase 1. Otherwise the job ends without success | 1 |
| walk | 1 | normal walk (4.1; animal planner). When the path child ends: **only if the animal stands exactly on (x, y − 1)**, phase 3; otherwise the job ends without success (no tolerance) | the walk's delays, then 1 |
| next | 3 | **turn toward the food** (direction 3), one turn call per run (45° free, max(1, step_time[0] div 4) ticks per further 45°). When the facing is 3: if the food still has unreserved amount, **reserve 1** (+0x54), send the action message **action 3 (`ID` row), event frame = record +0x04, repeat count 99**, phase 2. For a crop (class 10..12, not a bush) the advisor of the nation whose race is class − 10 says **mentor#81** with the crop's cell, queued, at most once per 120 s (2 × 60000 ms). If nothing is left, or the facing is not 3, the job ends without success | the turn delay, then **100** |
| +100 | 2 | **unreserve 1, remaining − 1** (not below 0), and the depletion update of 7.4 (frame message; a crop at 0 is removed; a bush at 0 starts its regrowth job). The job ends with success | 0 |

Then the animal job switches to mode 0 (wander) and returns 1. One tick later the wander child is
created, one tick after that it plans (3 ticks), and the first wander step follows about 5 ticks
after the bite.

**On screen.** The animal walks to the cell behind the bush, turns to face it (visible 45° steps),
and plays its `ID3` row in a loop. Animals 33..37 have `ID3` rows of 11, 11, 10, 10 and 10 frames
at the default 7 fps, so one cycle lasts 14.3..15.7 ticks and the 100 ticks show about 6.5 to 7
cycles (about 11 s on the GOG clock). The repeat count of 99 never runs out in that time. Nothing
stops the row when the bite happens: the bush's picture changes **at the end of the 100 ticks**
while the animal is still playing `ID3`, and the row is cut about 5 ticks later by the first
facing change or step of the wander walk. The event frame (record +0x04) fires once per cycle; it
plays the record's sound only if the record's sound action (+0x134) is 3.

**Interruptions.** If the eat job is destroyed during the 100 ticks (the animal is killed by a
hunter, a new mode), its destructor releases the reservation and **nothing is eaten**. A porter or
another animal can only take the unreserved rest in the meantime.

**Our build** (`src/engine/logistics.ts` `runAnimal`, `eatStep`; implemented October 2026,
`test/animal-eat.test.ts`): as above. The eat child lives in the animal job's data (`AM.Phase`,
`AM.Reserved`); its phases Check/Plan are the original's phase 0 and the path child's first run
(plan at +2, first step at +5). Candidates are bushes and crops in ascending id with
dx² + dy² < 100 around home, unreserved amount and a free (x, y − 1); only those draw rand(). The
animal must end exactly on (x, y − 1), turns to 3 with the normal turn delays, reserves 1, plays
`ID3` with `idleLoops` 99, and the bite comes 100 ticks later (unreserve, amount − 1, depletion
update), then wander 1 tick later (our wander plans in the run that creates it, so its first step
comes about 1 tick earlier than the original's). A kill releases the reservation (`killAnimal`). Mentor#81 for a
crop goes to race class − 10. It is limited by the advisor's own 2 D = 120 s interval for line
81 (side-panel.md 1.1), at most once per 1200 ticks per race at our 100 ms tick. Our advisor
event carries no cell. Respawned animals now get their animal job too (7.5, `004638d0`).

---

## 8. Production buildings and operators

### 8.1 Activation (C, `0045fa40`)

A completed building becomes **active** (state 2):

- without an operator: at completion;
- with an operator: when a unit of the operator type **and of the same race** enters
  (`00460ed0`, mentor#10).

On activation:

- upkeep is added (odb.md);
- store capacity is added for store buildings;
- a house job starts for buildings with residents;
- for buildings with a product (+0x11C ≠ −1) a **production job** (0x13) starts after 1 tick,
  with **one order for one unit of the product**. If such a job already exists, it is unblocked.

The town hall's start set (builder, 2 porters, start stock) is in 11.4.

The operator stays inside, as an occupant. When he is **sent out** (send-out command or
`DEAKTIVIEREN`, 4.11), or when another unit of the operator type leaves, the building is
deactivated (`004613f0` step 4 calls `0045ff30`). So **production needs the operator inside** (C).
When the building itself sends him out on one of its own jobs (a police hunt, a diplomat's
errand, a farmer's planting), the eject carries no "sent out" flag: he stays the building's stored
operator and the building **stays active** while he is away (8.5). After a manual removal nobody
refills the slot (handbook 5.2; no request is filed, 4.11).

### 8.2 Production job (0x13, `00476380`) (C)

Runs every **30 ticks** while an order exists and the building is alive. It does nothing unless
the building is active.

1. **Inputs** are the product's goods record +0xF0.. (odb.md A.3). When the order is queued
   (`00474b70` with good < 9), the amount missing from the building's stock is requested:
   **priority-2 transport requests**, one per unit.
2. When every input amount is present in stock:
   - send message (0x2D,5) "start";
   - **consume all inputs at once**;
   - for every input, request again (priority 2) the amount needed to refill the stock to one
     run's need. This pre-orders the next run;
   - set the run counter to **10**.
3. Each following run lowers the counter. At 0, vtable[5] (`00476630`) delivers:
   - **+1 unit** of the product into the stock;
   - one entry on the output list and a **priority-2 pickup request**;
   - message (0x40,5);
   - **a new order for the same product** is queued. Production is continuous.
4. Timing: **300 ticks per unit** after the inputs are complete, plus at least one 30-tick
   check. Progress shown = (10 − counter) × 10 % (`004767d0`).

| building | operator | inputs per unit | output |
|---|---|---|---|
| mine (50) | stonemason (27) | 2 wood | 1 iron |
| armoury (61) | weaponsmith (25) | 2 wood + 1 iron | 1 weapons |
| luxury works (44) | type 16 | 2 raw + 1 wood | 1 luxury of the race |

Storage: these buildings have a local capacity of +0x120 = 10 per good. It is checked only:

- when a unit with a load asks to enter (advisor "stores full", entry still allowed);
- when a porter drops goods at a **source** building.

Deliveries to a destination and the production output are **not clamped**. A local stock can
exceed 10 (I: no clamp found). Production does not stop while its output waits for collection
(no check found, I).

The second request round (step 2) and the new order (step 3) both ask for inputs, so inputs may
be over-ordered by up to one run. This is bounded only by porter availability (I, read from the
order of operations).

### 8.3 Operator / visit job (0x22, `00478cb0`) (C)

This job is created when the operator enters a staffed building (flag 0x4) or when a porter
enters a visit building (flag 0x8). Its period depends on the record's operator type. It ends
when the building is empty.

| building | behaviour |
|---|---|
| embassy (diplomat 13) | ejects every occupant of a foreign race, then ends |
| farm (farmer 14), period 99 | 7.6 |
| news stand (news seller 20), period 299 | while the town of its first occupant has at least one house (type 37 or 38, sites included), that occupant (in practice the seller) is sent on a news round (job 0x1A) and the job ends; otherwise it runs again after 299 ticks (8.6) |
| police station (police 21), period 50 | for each criminal of the town that is outside a building, an officer inside is sent to arrest it (job 0x18); he stays the stored operator and the station stays active (8.5) |
| visit buildings (houses, tavern, circus/theatre/arena, temple) | a run with no occupant at all ends the job. Otherwise each run cancels the job of the **last porter** of the occupant list (any porter, a leisure visitor or one ordered in; a porter on his way out is no longer listed) and ejects him with the plain eject; unit +0x78 is not touched (5.7 "After leaving"). It runs again after **299 ticks** while **any occupant** remains (the tavern's, circus's or temple's operator counts), otherwise it ends. A run that finds no porter ends the job (the operator branch's period, 0 for these operator types: 15, 18, 22, none). Created only when the building's job slot is free (4.4 "Residences"). These operators sit inside with no job of their own (none of these buildings has flag 0x4) |

### 8.4 Other operators (C/I)

The lab, library and bank (scholar 23), the watchtower (scout 24) and the tavern, circus and
temple operators only need to be inside for the building to be active. Their effects are in
economy.md and the research/diplomacy specs.


### 8.5 Operators out on duty (C, `004613f0`, `00460ed0`, `00455e90`; destructors of jobs 0x18 `0047b7b0`, 0x38 `00478880`, 0x21 `0047e990`, 0x1A `0047b3f0`)

A building can send its operator out on a job of its own. The link between the two is the
building's **stored operator** (+0xA8); the building's state (+0xB0) stays 2 (active) as long as
that link holds.

**Duty jobs** (C):

| building | operator | sent out by | duty job | job holds the building at |
|---|---|---|---|---|
| police station (54) | police officer (21) | operator job, every 50 ticks (`combat.md` 12.2) | arrest 0x18 with a station | +0x28 |
| farm (45) | farmer (14) | operator job, every 99 ticks (7.6) | plant 0x21 | +0x30 |
| news stand (51) | news seller (20) | operator job, every 299 ticks (8.3) | news round 0x1A | +0x28 |
| embassy (42) | diplomat (13) | an offer (`004618b0`, `ai-diplomacy-trade.md` 3.4) | errand 0x38 | +0x30 |

No other building sends its operator out: the visit, tavern, temple, circus, lab, library, bank
and watchtower operators only sit inside (8.3, 8.4); the trader (trade job 0x20) and the priest's
healing (`combat.md` 13) hold no building. *(Gold Edition buildings, harbour and ferry: not read,
U.)*

**Leaving.** The operator job ejects him with the plain eject (flag cleared). At placement
(`004613f0` step 4) he is the stored operator and the flag is clear, so **nothing is
deactivated**: upkeep, store capacity, need satisfaction (`economy.md` 5.3) and the stored operator
all stay. The operator job itself ends after sending him out (it returns 0).

**Coming back.** The duty job ends by walking him back in (a go-to child that enters). Entering
(`00460ed0`): a unit of the operator type and race entering an active staffed building (flag 0x4)
cancels its own current job, replaces the building's job with a **new operator job** (first run
after **100** ticks), and becomes (stays) the stored operator. The duty job, which ran that go-to
as its child, deletes the child in the same run and ends normally.

**Breaking the link.** Each duty job's destructor tests whether the job dies **under way**:

| job | the link is broken when it is destroyed while | worker request for the operator's type, filed at the building (`00459d70`) |
|---|---|---|
| arrest 0x18 (only with a station) | the officer is dead, or the job has a child (an attack on a criminal, or the walk back) | when the officer is dead and his town alive |
| errand 0x38 | the diplomat is dead, or the job has a child (the walk to the foreign embassy, or back home) | never |
| plant 0x21 | the farmer is dead, or the job has a child, or its phase is not the last one (4) | when the farmer is dead and his town alive |
| news round 0x1A | never: its destructor does not touch the link | when the seller is dead and his town alive |

Breaking the link = `00461840(building, 0)` (the stored operator is cleared) and then
`0045ff30` (deactivation, 4.11 "At placement" for what it does: upkeep and capacity removed,
operator / visit job cancelled, a production job kept but idle, need threshold reset
(`economy.md` 5.3), for an embassy the relation reset when it was the player's last active one).
The unit keeps its home house and town; only the building loses him.

A job is destroyed early by anything that replaces or cancels the unit's current job:

- a **player order** on the unit (right-click 0x15 on any target, `00450bb0`, also another
  arrest order for an officer, `combat.md` 12.3), a **move** (0x14, `00451170`), **go home**
  (0x20), and `DEAKTIVIEREN` step 2 (4.11, which deactivates by itself too);
- the unit's **death** (all its jobs are deleted, `combat.md` 10.1);
- for the embassy, a **second offer** while the diplomat is still out: the old errand is
  recalled (its child replaced by a walk home) and then cancelled, with that child, so the
  embassy is deactivated (and the relations reset when it was the last active embassy) before
  the new errand starts (`ai-diplomacy-trade.md` 3.4).

A job that is merely **suspended** (the help and retaliation rules, `combat.md` 7.4) keeps the
link; it breaks only if the suspended job is later destroyed (with its child). A duty job
cancelled before it has a child (an arrest job that is still waiting behind the leave job, or in
the one tick between two criminals) keeps the link: the officer then stands outside as the stored
operator of an active station that no longer sends him anywhere (its operator job has ended)
until he is ordered back in (C, quirk).

After a break the building stays inactive (and the panel shows T9 "Benötigt", `docs/ui/side-panel.md`
class 1) until a unit of its operator type and race enters it (8.1); the old operator can be
ordered back in like any other. Only a death files a worker request, so the station and the farm
are re-staffed automatically after a death, but not after a manual order.
The news stand is the exception: its round never breaks the link, so after the seller's death
the stand stays active with a dead stored operator and the requested replacement is refused at
the door (8.6 "Death").

**Panel while away.** The building panel's operator caption shows T174 "Anwesend" whenever a
stored operator exists, inside or away on duty (`00455e90`), so a station whose officer is
hunting reads "Anwesend" and `DEAKTIVIEREN` stays usable (4.11 step 2 then handles him outside).

*Our build:* the arrest job's walk back is a separate go-to job marked as duty (it stands for the
original's go-to child); the news round is implemented as 8.6 (its walks are inside the job). Ours breaks the link of an errand
also in the rare case that the target race had no active embassy at its creation (the original's
errand then has no child). Code: `logistics.ts` `dutyDropped`, `operatorBack`, `unitEntered`;
tests `test/operator-duty.test.ts`.

### 8.6 The news round (job 0x1A) (C; operator job `00478cb0` case 20, run `0047b490`, destructor `0047b3f0`, request result 3 in `00460d10`; Gold `00482960`, `00486220`, `00486180`)

**Who.** Every race has the same pair, read from `dv.odb` (identical in the GOG and Gold data):

| | Amazons | Pimmons | Sajiki |
|---|---|---|---|
| building 51 | Zeitungsstand | Zeitungsstand | Infohöhle |
| operator 20 | Zeitungsmädchen | Zeitungsmann | Verkünder (sprite folder `SCHREIHALS`) |
| seller's sound (+0x08 / frame +0x04 / action +0x134) | none | none | 23 / 2 / 2: plays in the work row |

The stand: 2×2, door (−1, +1), 450 HP, 4 wood and 10 stone, invention 11 (the newspaper), flag
0x4 (staffed), operator type 20, **upkeep 30** per round settlement while it is active
(`economy.md` 4.5), need entry 25 with advisor line mentor#32 "Deine Bevölkerung wünscht sich einen
Zeitungsstand!" (Amazons, Pimmons) or #33 "... eine Infohöhle!" (Sajiki) (`economy.md` 5.3). The
seller is trained at the school for 70 (invention 11). His sprites have a walk row (`MG`), a work
row (`WO`, 8 facings) and one idle row (Amazons `ID5`, Pimmons `ID3`).

**Assignment.** The stand is staffed like any staffed building (8.1): completion files a worker
request for type 20, the dispatcher sends the nearest free seller (answer job 0x3C, 5.2), his entry
activates the stand, makes him its stored operator and starts the operator job (0x22) with its
first run **100** ticks later. A seller already inside at map load (`operatorInside`) gets the same
job.

**Operator job, case 20 (period 299).** Each run (the job ends at once if the stand has no
occupant):

1. Take the **first occupant** of the stand (any unit; in practice the seller, the only one the
   door admits) and the town he belongs to (unit +0x50, not the stand's town).
2. If that town's per-type lists of the small house (37, town +0x270, count +0x278) and the large
   house (38, town +0x27C, count +0x284) are both empty, return **299** (try again later).
3. Otherwise: his current job, if any, is cancelled; a news round job is created for him (index 0,
   stand = this building, the stand's reference count + 1) and scheduled **1 tick** later; he is
   ejected with the plain eject (no "sent out" flag, 4.10), so the round waits behind his leave
   job and he steps out 20..35 ticks later; the operator job ends (returns 0). The stand stays
   active (8.5).

So nothing counts "news": the only condition is that a house exists. A town without houses keeps
its seller inside and re-tests every 299 ticks.

**The round** (one run per scheduling; the job keeps an index i, the stand, and at most one child,
a go-to job 0x07 (4.2)). Each run first takes N = count(37) + count(38) of the **seller's town at
this moment**, then:

- **With a child:** the child runs. While it is busy its delay is returned. When it ends it is
  deleted, and:
  - *failed* (the target died, the door refused him): return **20**; no animation, no retry of
    that house;
  - *succeeded*: an action message (0x19,11) is broadcast to every player: action **2** (work),
    event frame = his record's sound frame (+0x04), repeat count **0**, i.e. the `WO` row plays
    **once**, facing the house (the go-to's turn toward the anchor, 4.10 step 2). Then, if
    i ≥ N and the stand is still alive, a go-to child to the stand is created at once (it runs at
    the next run). Return **20**.
- **Without a child, i < N:** the target is entry i of the concatenation "list 37, then list 38"
  (each list in its own order: the order in which the buildings joined the town, a site joining
  at placement, I), and i is raised by 1. If the target is a **construction site** (state 1),
  return **1** (skip it). Otherwise create a go-to child on it and return **1**.
- **Without a child, i ≥ N:** if the stand is alive, create a go-to child on it and return 1;
  otherwise the round ends (returns 0) and the seller stands where he is with no job.

**At a house.** The go-to walks to the house's door cell (4.8 goal), turns toward its anchor and
asks to enter (4.10 steps 1..3). The request answers "done" at once for a news seller at any
building other than type 51 (4.4 item 2), before the door queue and the may-enter test, so he
never queues, the door never opens and he never enters; the go-to **succeeds**. A house of any
size, completed, active or not, full or not, gets the same visit. Walks that fail (jams, 15 plans)
do not fail the go-to (4.2): he "visits" from where he stands.

**Back at the stand.** The go-to to the stand ends by entering it (4.10). He is its stored
operator and it is active, so he is admitted; the entry (`00460ed0`) cancels his current job (this
round: its destructor runs with him alive, nothing happens) and starts a **new operator job, first
run after 100 ticks**, which sends him out again if a house exists. If the entry fails (the stand
died, or refuses him), the round returns 20 and, the stand still alive, sends him to its door
again; with the stand gone the round ends with him outside.

**Timing.** Per completed house: the walk (step times 5/6/7/8 by slope, 4.1), the turn (0..3
ticks), 1 tick to the request, then 20 ticks standing (the `WO` cycle plays at the start of it),
then 1 tick for the next go-to to start its walk. A site costs 1 tick. The cycle is: 100 ticks
inside, 20..35 ticks leaving, the round, the walk home, and again. With h houses about 5 cells
apart on flat ground one round takes roughly h × (25 + 22) ticks plus the walk home.

**Index, lists and changes during the round.** N is re-read on every run and i is only a
position, so a house built or lost during the round shifts the entries after it: one house may be
visited twice or skipped. A house lost while he walks to it fails the go-to (20 ticks, next one). A
collapsing house stays in its list until phase 2 of its destruction (`combat.md` 10.3) and fails
the go-to. Houses of other towns, of other races, and the town hall are never visited.

**Effect.** **None** besides the animation (and the Sajiki sound). The round job writes no
economy field: no need, no happiness, no counter, no area, no duration (C: the run, the operator
job and the destructor were read completely; no other code reads job type 0x1A or its index). The
news need is closed only by the stand being **active** (`economy.md` 5.3), and the round keeps it
active (8.5: its destructor never breaks the link). So for happiness a stand counts from the
moment its seller first enters until it is deactivated or destroyed, whether he is inside, on his
round, idle outside after an order, or dead.

**Manual orders on the seller.**

| order | effect |
|---|---|
| any order (right-click, move, go home) during the round, before he is out (the round still waits behind the leave job) or on the way | the round is cancelled; the link is kept: the stand stays active with him as its stored operator, its operator job has already ended, so no further round starts until he is ordered back into it (his entry restarts the operator job, 100 ticks) |
| right-click on an own house | go-to: "done" at the door, he stands there idle |
| right-click on a school or any other own building except a news stand | the same: he never enters (no re-training of news sellers) |
| right-click on his stand | enters as its stored operator (operator job restarts); an inactive stand of his race with no operator: he becomes its operator (8.1) |
| right-click on another active stand | refused at the door (only its stored operator is admitted, 4.4) |
| send-out (4.11) on the stand while he is inside | ejected with "sent out": the stand is deactivated |
| `DEAKTIVIEREN` | inside: as send-out; on his round: step 2 cancels the round, releases him and deactivates the stand |

**Death.** The destructor files a **worker request for type 20 at the stand** (`00459d70`) when
the seller is dead and his town alive, and does **nothing else**: the stand keeps its dead seller
as stored operator and stays **active** (upkeep paid, need closed, panel "Anwesend"). Quirk (C, from
the may-enter test `00460a10`): a replacement seller sent by that request is **refused** at the
door (operator type, building active, not the stored operator); his answer job fails and its
destructor files the request again (5.2), so a free seller keeps walking to the door and back into
the request loop. The stand gets a seller again only after `DEAKTIVIEREN` (step 2 releases the
dead operator and deactivates; the next seller then enters and activates it). Nothing in the unit's
death (`004641d0`) clears a building's stored operator.

**Side panel.** Seller's status line: T270 "Verkündet Neuigkeiten" while the round is his job
(walking to houses, standing at them, walking home); inside the stand T280 "Ist in Gebäude:
<stand>" (also while the round waits behind his leave job). The stand's page: operator caption T174
"Anwesend" while a stored operator exists (inside, on the round, idle outside, or dead),
`docs/ui/side-panel.md` class 1.

**Computer players.** They build a stand when news is their most urgent need
(`ai-diplomacy-trade.md` 1.4) and staff it through the same worker request; their sellers do the
same rounds. Computer towns have no happiness (`economy.md` 5.5), so for them the stand only closes
the need for the planner. No AI code reads the round.

**Gold Edition.** The operator job case, the round and its destructor are the same code
(addresses above); the house lists are at the same town offsets. The request-result-3 test of
`00460d10` was not located in the Gold decompile (I: assumed unchanged).

#### Our build (implemented October 2026)

`src/engine/logistics.ts`: `runOperator` (news stand branch), `runNews` (job `LJ.News` 0x1A, data
`NR`: child phase, index, stand, target), `newsHouses`, the request-result-3 test in `enter`
(`ENTER_DONE`), `dutyDropped` (news round: request on death, never a link break), `mayEnter` (the
operator-type refusal), `deaktivieren` (a dead stored operator); `src/client/main.ts workCycles`
(the work row once), `src/client/hud-pages.ts jobText` (T270); `src/engine/world.ts` save
version 11. Tests: `test/news-round.test.ts`.

| point | original | ours |
|---|---|---|
| go-to child | a separate job 0x07 with its own walk child 0x06; created in one run, plans in the next ones | phases inside the round's data: created (1), walking (2), at the door (3); the walk is planned when the child first runs, 1 tick after its creation |
| the work row once | action message with repeat count 0 | the simulation sets action 2 with a new `actionTick`; the client plays it once while the unit's job is the news round (`workCycles`) |
| save games before version 11 | — | an active, staffed news stand whose operator job had ended (our old build ended it after its first run) gets a new operator job, first run after 100 ticks |

---

## 9. Training (C, `0045f4c0`, `00474b70`, `00475d50`, `00475ff0`)

**Queueing** (training panel, or the AI):

- The order check is `0045f360` (odb.md 3).
- A training building keeps at most **5 queued orders**.
- Queueing an order:
  1. **charges the price (+0xD4) to the nation at once**. It is refunded if the order is
     cancelled (`00474fd0`);
  2. increments the town's pending count for that type;
  3. requests the unit's goods (+0xF0..) as **priority-0 transport requests**. The amount is net
     of the building's stock and of goods already reserved by earlier orders;
  4. files a **porter worker request** (type 9) when (orders queued before this one) ≥ (units
     inside), unless the ordered type is itself a porter.

  The training page shows queued slot i dark until i < units inside, i.e. until a porter (or
  any other pupil, 9.1) has entered for it (`docs/ui/side-panel.md` class 7).

**Running**: the training job runs every 30 ticks. It needs:

- the building active;
- at least one unit inside (any unit: the head of the occupant list);
- every goods amount of the current order present.

Then:

1. Start: message (0x2D,5); **consume the goods**; progress = 0; target = the new type's HP
   (record +0xAC).
2. Each 30 ticks: progress += 5.
3. When progress ≥ target: vtable[5] (`00475ff0`):
   - decrement the pending count;
   - **retype the first occupant** in place (`00464840`): same object; record, HP and weapon
     replaced; load cleared; moved to the new type's list. **The porter (or whatever pupil, 9.1)
     is consumed**;
   - eject it: it comes out through the leave job, 20..35 ticks later (4.10);
   - advisor mentor#13;
   - message (0x40,5).

**Lost building**: when a training building is destroyed, its training job is deleted (I: the
building's current job is cancelled and the scheduler deletes it); the job's destructor
(`004761e0`) lowers the town's pending count for every order still queued (clamped at 0), and
the price is **not** refunded (C for the destructor). The computer players' planner relies on these
counts (`ai-diplomacy-trade.md` 1.6, 1.15).

**Duration**: ceil(HP / 5) × 30 ticks after the start tick. Every civilian has 50 HP, so 300
ticks (about 28.5 s at normal speed). Archer 100 HP: 600 ticks. 250-HP units: 1500 ticks.
Progress = progress × 100 / target (`00476130`).

A freshly trained operator walks to a building that needs one because that building's worker
request is still open. The dispatcher finds the new unit (5.2). This matches handbook 5.2 "walks
there by itself" (C).

### 9.1 Pupils and re-training (C, `00460a10`, `00460ed0`, `00474b70`, `00475d50`, `00475ff0`, `00464840`)

**Training buildings** are the class-5 buildings: school (55), barracks (39), the race's
siege/beast building (43: Geschützfabrik / Dressurfarm / Zuchtstall) and the magic building
(56: Alchemistenhütte / Magierturm / Kultstätte); in Gold also the shipyard (63, `addon.md`
3.4). None has an operator type. What a building trains is the unit record's made-at (+0xE8):

| building | trains (same type numbers for every race) |
|---|---|
| school 55 | **porter 9**, founder 10, builder 11, diplomat 13, every civilian 14..25, 27, 28 |
| barracks 39 | saboteur 26, ranged 29, melee 30, 31; Amazons also 36 |
| 43 | 34, 35; Pimmons and Sajiki also 36 |
| 56 | 32, 33 |
| shipyard 63 (Gold) | ships 64..67 |

The criminal (12, made-at 36) is never trained.

**Who can be a pupil.** The door of a training building admits every unit of its race (4.4; Gold:
except ships), and every unit that enters stays inside, idle and without a job, in the occupant
list (4.4 "unit entered"). There is no capacity and no type test. A pupil can be there before any
order: ordered in by the player (right click on the building, 3.2), released there by the AI
(below), or a porter whose order was cancelled while he walked there. He waits until:

- the training job retypes him (he is the head of the occupant list when an order finishes);
- the player sends him out from the inhabitants page (4.11);
- the building collapses (all occupants come out, `combat.md` 10.3).

Nothing else lets him out: the training job never ejects an untrained pupil, a pupil is not free
for the dispatcher (5.4), and leftover pupils (more inside than orders) simply stay.

**The trainee of an order is whoever is inside, whatever his type.** The training job takes the
**head of the occupant list** (the unit inside longest) when an order finishes, with no test of its
type. So:

- a builder (or a woodcutter, an archer, a founder...) inside a school becomes whatever the order
  is: builder → woodcutter, builder → porter, archer → stonemason; in a barracks a builder
  becomes an archer; in the shipyard a builder becomes a ship;
- "porter" is an ordinary school order (type 9, price 10, 50 HP, no goods), so re-training into a
  porter exists. A porter order never files a porter request (rule 4 of the queueing), so in an
  **empty** school it waits for a pupil indefinitely (T138 "Warte auf Schüler...");
- a porter can be "trained" into a porter: the price is paid and nothing changes but the HP;
- the order queue and the pupils are matched only by position: the next order to finish takes the
  next head, so with a builder and a porter inside and two orders queued, the builder (who entered
  first) gets the first order.

**No porter is called when a pupil is already there.** The porter request of the queueing step
(rule 4) is filed only when (orders queued before this one) ≥ (units inside), and the dispatcher
sends a porter only while the building has more orders than units inside (5.2). With one builder
inside and an empty queue, the first order files no request and starts on the training job's next
run. The training page shows the slot normal at once (`docs/ui/side-panel.md` class 7).

**Costs and time** are those of the ordered type, the same as for a porter: the price (+0xD4) at
queueing, the goods, ceil(HP / 5) × 30 ticks. Nothing depends on the old type; there is no
refund or discount for re-training.

**What the retype (`00464840`) changes**: the unit leaves the old type's town list and joins the
new one (population and needs re-evaluated twice, `economy.md` 5.4); record, HP (the new type's
maximum), weapon object (by the new type's weapon record) and the carried load are replaced; the
combat stance class (+0x20) is recomputed (a retype into a criminal, which training never does,
also starts the criminal job). **Kept**: the object itself (same id), the town, the home house, the group (+0x48), the
rank and experience (+0x80/+0x84: a hunter re-trained as an archer keeps his rank and points;
only types 17, 21 and 29..36 earn experience, `combat.md` 5.3). Alien Nations has no tools: no
goods are returned or needed for the old profession. If the old unit was the stored operator of
some building, that link is not touched *(I: an operator inside his own building cannot be in a
school at the same time; one outside on an errand can be ordered into a school only by the
player, and the case was not traced)*.

**The AI** (ai-diplomacy-trade.md 1.7, 1.8): gatherers released from a trimmed gang get a go-into
job to the town's first school and, by the rules above, stay inside as pupils; the training step's
"school flush" then queues one porter order per pupil not covered by an order, turning them into
porters. A released ship is sent to the shipyard and refused at the door (Gold).

*Our build* (`src/engine/logistics.ts` `entered`, `mayEnter`, `trainees`, `train`, `runTraining`;
`test/retrain.test.ts`, fixed October 2026): as above. Before the fix only a porter entering a
training building with an order queued stayed; every other unit (a builder ordered in, an AI-
released gatherer) was sent straight back out and stood at the door. Remaining difference: a unit
of another race (admitted only on a trade or errand job) is not kept.

---

## 10. Animation timing (display side)

Message (0x19,11) starts an action on a unit's display object (`00456490`):

- the action to play;
- the frame at which the sound plays (−1 = last frame);
- a loop or duration parameter: 0x4000 means "until stopped", 99, 100 or 50 for gathering and
  planting, 10 for animal idling, 99 for animal eating (7.7.1).

The message also clears the unit's remaining drawn step offset, so a unit that starts an action
is drawn on its cell at once (`docs/rendering/unit-motion.md` 3).

Message (0x27,11) stops the action and returns to the base movement action.

Cycle length, in ms: **frames × tick_ms × 10 / speed** (`00456490`, `00434840`).

- frames = the sprite's frame count, which equals OD descriptor +0x38 and dv.gd frame_count.
  Builder `MG` 12, `WO` 10; woodcutter `WO` 11 (C).
- speed = a per-sprite value. **−1 means 7**. It is the layer speed of the OD descriptor
  (descriptor +0x30 for the main layer). The loader `0043c5b0` copies it into the sprite (C,
  `docs/rendering/objects.md` 1). It is −1 on almost all unit and nature sprites. Building
  extra layers use 7 fps of real time, and the Gold fish `ID0` uses 5.

So, by default, **one frame of an action lasts 10/7 ticks, about 1.43 ticks or 136 ms at normal
speed**. This applies to actions (work, strike, idle) only. **Walk and carry frames are not
timed**: they advance by one frame per drawn movement jump of at least 4/64 cell, about 14 to
16 frames per straight cell (`docs/rendering/unit-motion.md` 2.3). The display picks slot
action × 8 + facing. When that slot is empty it uses direction 0 of the action and sets the
display facing to 0 (`00435030`). Action cycles, repeat counts and sound events are in
unit-motion.md 3.

---

## 11. Founding a town (job 0x0E)

A new town is founded by a **city founder (type 10)**. A town hall is never built by builders:
the town object and its town-hall site appear at once when the command is executed, and the
site is completed **instantly, with no goods and no builder, when the founder reaches its
entrance**. When the founder then walks in, the town hall becomes active and the town gets its
start set (builder, 2 porters, start goods). This is how a free-play human player, who starts
with nothing but one founder (`docs/formats/world-populate.md` §9), gets the first town.

Order of operations (each step is detailed below):

1. UI: `GRUENDEN` → town-hall placement mode → a valid click sends "found town" (11.1).
2. Simulation: re-check of the area; the new town and its town-hall site are created; the
   founder leaves his old house and town, joins the new town and gets job 0x0E (11.2).
3. Job 0x0E: walk to the site's entrance; on arrival the site is completed, the founder plays
   his work animation, advisor mentor#19; 20 ticks later he enters (11.3).
4. Entry: mentor#10, activation, births of a builder and 2 porters, start goods (11.4).

Status: C unless marked. The failure cases in 11.6 are read from the code; their in-game
result was not observed.

### 11.1 Player command and placement preview (client side)

**Button** (`00417fe0`, data `00455d50`). `GRUENDEN` is shown on the info page of an own
founder. The data byte that drives it is:

| condition | value | effect on `GRUENDEN` |
|---|---|---|
| the nation's town list (+0x238) is empty | bit 1 | none (this bit only disables `MOVEHOME`/`PATROL`) |
| the nation has **exactly 10** towns | 2 | disabled, tooltip T172 "Maximale Städteanzahl erreicht!" |
| the founder is inside a building (and its job is missing or blocked) | bits 1+2 | disabled, tooltip stays T6 "Stadt gründen" |

So the starting founder of a town-less human player can found at once. The limit of 10 exists
only here and in the training page (T202). The simulation itself never checks it (11.2).

**Placement mode** (`00441c40`). Clicking the button enters the normal building-placement mode
(see `docs/ui/side-panel.md` 5.3) for the race's town-hall record (type 40). The preview mask is
the town-hall mask 0x107E plus 0x80, i.e. 0x10FE.

**Click test** (`00447cd0`, called from the world-view click handler `004404a0`). (X, Y) is the
cursor cell, which is the max corner of the footprint, as in 6.1. The click is valid when none of
these flags is found:

- On every cell of the footprint grown by one cell on each side:
  - 0x02, a unit stands there;
  - 0x04, a building;
  - 0x08, a special object;
  - 0x10, a nature object;
  - 0x20, the terrain-byte class (6.1);
  - 0x80, the cell is not currently visible (`docs/game/fog-of-war.md` 6).
- 0x40 (too steep): on the ring of cells at distance 2, the highest and lowest heights differ by
  more than 64.
- 0x1000 (**territory**): the town-border map is looked up at four points, (X+1, Y+1),
  (X+1−a, Y+1), (X+1, Y+1−b) and (X+1−a, Y+1−b), with a = record size_y (+0x0C) + 2 and
  b = record size_x (+0x10) + 2. If any of the four lies in the territory of **any** town, of any
  player and including the player's own, the click is invalid. The border map is the
  half-resolution grid (2×2 cells per entry) built from the territory messages of town halls and
  outposts (`0044e3b0`). Quirk: x is offset by the y extent and y by the x extent. This makes no
  difference for a square footprint.

There is **no** other distance rule, no height-class rule (the town-hall mask has none of
0x100/0x200/0x400) and no cost check.

- **Valid click**: command **19 (0x13) "found town"** is sent with X, Y and a third position
  word of 1 *(I: the height/level slot of a position triple)*. Placement mode ends.
- **Invalid click**: nothing is sent and the mode stays *(I: no message found)*.

### 11.2 Simulation: the found-town command (C, `004509d0`, `00464aa0`)

**Re-check** (`004509d0`). The same footprint-plus-one and slope-ring scan is repeated, this
time with mask **0x7E** only. Visibility, territory and height classes are not checked here.
Then:

- the acting unit is the **first unit of the sending player's selection**;
- it must not be inside a building;
- its type is not checked: only the UI makes it a founder.

If either test fails, the command is dropped silently.

**Founding** (`00464aa0`, a method of the unit), in this order:

1. The unit's current job is cancelled (cancel flag; the scheduler drops it later; see 11.6).
2. The nation creates the town (`0045d370`, which calls the town constructor `00458cd0`) at
   (X, Y):
   - **Id**: the next global town serial.
   - **Name**: the lowest index i in 0..9 that is not yet in the nation's set of used name
     indices (nation +0x248; its size, +0x254, is the number of living towns). The name is
     `DV.tdb` string 142 + 10 × race + i (Amazons "Joyshire", "Wood Creek", ...; Pimmons from
     T152; Sajiki from T162). If all ten are used, the index becomes −1 and the string before
     the race's block is used. Only reachable if the 10-town limit is bypassed (quirk, C).
   - **Initial values** as in `economy.md` 2.2: stock 0, population 0, happiness/food/needs/
     condition 100, need list. The reference count is 1 and the nation's town counter
     (+0x14) increases by 1.
   - The **town-hall site** is created at (X, Y) (`0045f0d0`, type 40):
     - state 1 (site), HP = 10000 / 10 = **1000**, entrance computed, local stock 0;
     - town site count + 1, and the site is added to the town's town-hall list (town +0x294);
     - because it is a town hall, the **territory message** (0x55,24) is sent at once, with
       the town id, race, position and the record radius (25). The new town's area and border
       stones exist from this moment.
   - **No construction job, no builder request and no goods request are created.** Those come
     only from normal placement (`00451780`, 6.1).
   - **Town jobs**:
     - consumption job, first run after 299 ticks;
     - status job, after 1 tick;
     - human towns only: leisure job (5.7) after 199 ticks;
     - computer towns: no leisure job, and the research slider (+0x40) starts at 40.
   - **Nation bookkeeping**:
     - the town is appended to the nation's town list (+0x234; count +0x238);
     - it becomes the nation's **current town** (+0x258);
     - every human player's connection gets message (0x1C,0x25) with town id, race and name
       *(I: town list and name label)*;
     - a computer nation also gets the town's three AI planner objects (town +0x18/+0x1C/+0x20,
       `ai-diplomacy-trade.md`). They are created here but scheduled only at activation (11.4);
     - on the nation's very first town, a list of circle offsets with the town-hall radius is
       precomputed (`0045dc10`). The AI's site test uses it.
3. If the founder has a **home house** (+0x7C), he leaves it (`00461690`). The house slot is
   freed and that house's birth job is re-armed, so a porter may later be born into the slot.
4. If the founder has an **old town**:
   - he is removed from its per-type list;
   - its population (+0x44) and +0x48 drop by 1 and its needs are re-evaluated (`00464c30`);
   - its reference count drops by 1, and the old town object is freed only if that was the last
     reference.

   A free-play human founder has no town and skips this step.
5. The founder's town becomes the new town (reference + 1). He is added to its founder list;
   population and +0x48 become 1; needs are re-evaluated (`00464ba0`).
6. A **found-town job (0x0E)** is created for the founder. Its target is the first entry of the
   new town's town-hall list, i.e. the new site. It is scheduled after 1 tick.

**Nothing is paid**: no money and no goods are taken, from the founder or from any town. The
founder keeps his type; he becomes the new town's mayor.

### 11.3 The found-town job (0x0E) (C, constructor `00479280`, run `00479410`)

Fields:

- child job +0x14;
- **arrived flag** +0x30, initially 0;
- +0x24..+0x2C, initialised to −1 and not used by the run.

The constructor gives the job a **follow-path child (0x06)** to the target building's
**entrance cell** (+0x70..+0x78).

Each run, while a child exists, the child is run. When the child returns 0:

- **Child failed** (success flag 0): the job returns 0 and ends. See 11.6.
- **Child succeeded, arrived flag 0** (the founder stands at the site entrance). The child is
  deleted and, if the founder's town has a town hall:
  1. The **first town hall of the founder's current town** is completed (`004602d0`). This is
     not necessarily the job's target: see the quirk in 11.6. For a town hall, completion means:
     - display message (0x3B,9): explore-only vision around it (`fog-of-war.md`);
     - state = 0 (completed, not active);
     - HP += record HP (10000), clamped to the maximum: the hall goes from 1000 to **10000**
       at once;
     - town site count − 1, building count + 1.

     Nothing else happens: no mentor#1, no operator request and no activation (6.5 step 3).
  2. The founder plays his **work animation** (action 2) once: message (0x19,11) with the sound
     frame from his record +0x04 and loop parameter 0 *(I: 0 = a single cycle)*.
  3. The building gets display message (0x30,5). If the hall is on screen, its 10 `BU0` stages
     play once at 5 fps, and then the finished sprite appears. This is the only stage replay;
     normal completions switch directly (C, `docs/rendering/objects.md` 3).
  4. Advisor **mentor#19** "Dein Volk freut sich über eine neue Stadt!" to the founder's
     nation, located at the founder's cell (`0045e120`).
  5. The arrived flag is set to 1 and the job returns **20**.
- **Next run, no child**: if the founder's town has a town hall, a **go-to-object child (0x07)**
  to its first town hall is created. The job returns 1, so the child starts 1 tick later. The
  founder is already at the entrance, so it only turns and asks to enter. The door queue rules
  of 4.4 apply: the operator type may enter a building that is not active.
- **Child succeeded, arrived flag 1** (the founder is inside): the job returns 0 and ends.

Status text while the job runs (vtable[4], `004796b0`): T266 "Errichtet Stadt".

Timing: walk time + 20 ticks, then 9..12 ticks for the go-to, the turn toward the hall's anchor,
the admission (door opens) and the 5-tick last step, after which the founder vanishes (tick by
tick in the worked example of 4.10). The site is complete during the 20-tick pause; the town is
active as soon as the founder is inside. He never walks onto the footprint.

### 11.4 Entry, activation and the start set (C, `00460ed0`, `0045fa40`)

**Entry** (`00460ed0`). The town-hall record's operator (+0xD8) is 10. The founder has the same
race, and the hall is not active, so:

1. Advisor **mentor#10** "Ein Gebäude hat seinen Betrieb aufgenommen." at the hall's cell.
2. **Activation**, below.
3. The founder joins the occupant list (+0x54, count +0x5C).

The town hall has no "staffed" flag (0x4), so the founder is **not** stored as the hall's
current operator (+0xA8) and no operator job (0x22) is created.

**Activation** (`0045fa40`), in this order:

1. State = 2. Upkeep (+0xD4) is added to the town's overheads, and the hall's storage (25) to
   the town capacity (+0x54).
2. Computer nation: the three AI planner jobs are scheduled after **1, 16 and 33** ticks (town
   +0x1C, +0x18, +0x20).
3. **Births** (`00460830`, no chance roll):
   - one **builder (11)**, then two **porters (9)**;
   - each is born **inside** the hall as a resident (the hall is then full, 3/3) and is ejected
     at once; they come out one after another through the leave job, the first 20 ticks after
     the founder's entry, the others about 5 ticks apart (worked example in 4.10);
   - the criminal rule (`economy.md` 3.2) tests the population before each birth, P = 1, 2, 3.
     None of these is divisible by 9, 18 or 36, so no criminal is ever born here.

   Population becomes 4.
4. **Start goods** are **assigned, not added**, and not capped by capacity:
   - **the nation's town list (+0x238) has at most 1 entry**: all nine goods come from column 1
     of the mission race block (mdb +0x1C + 8 × good). In free play, goods 0..5 of that column
     were overwritten by the resources setting: 15 / 20 / 25 each (`mdb.md`);
   - **otherwise** (second and later towns): **10 wood, 10 stone and 10 food** (goods 1, 2 and
     4). All other goods stay at 0.

   Column 2 of the race block ("second town hall") is used only by town halls loaded from a map
   (`mdb.md`), never by a town founded in play. The count includes every town still in the
   list, including towns whose hall is still a site *(I: a destroyed town leaves the list only
   when its object is freed, `0045d570`)*.
5. A **house job** (type 0x0A) starts with first run after 599 ticks, because the hall has
   resident places. It finds the hall full and ends.
6. The hall's need entry (record +0x128) is registered (`00459e80`).
7. Display message (0x2E,5) is sent to the building.

**The founder stays inside for good.** The "send out" command 0x3A (`004520e0`, 4.11) refuses
type 10 in a town hall (and criminals everywhere). `DEAKTIVIEREN` is disabled for town halls (side-panel). If
he ever left, the hall would be deactivated (`004613f0`: any unit of the operator type leaving
deactivates a building whose stored operator is not that unit).

### 11.5 Who builds and supplies a new town

- Nobody builds the town hall. No builder, porter or goods are needed, and none are requested
  from the founder's old town or from any other town. Dispatchers (5.2, 5.3) are per town and
  never serve another town's requests.
- Until activation the new town has no units except the founder, no goods and no capacity. The
  first builder and porters are the births in 11.4. All further buildings of the town are placed
  normally (6.1) and supplied from the new town's own stock.
- Units move between towns only by resettling: an explicit order into another town's building,
  `economy.md` 3.4.

### 11.6 Cancellation and failure (C by code reading)

**Rule** (destructor `00479380`): when a found-town job is destroyed for any reason, the
following is checked at that moment:

- the founder is **not inside a building**;
- his **current** home town has a town hall;
- the first town hall of that town is alive.

If all three hold, that town hall's die method (`0045f5a0`) is called. A normal end (founder
inside) therefore destroys nothing. Every other end destroys the hall:

| event | how the job ends |
|---|---|
| path or entry fails (unreachable site: 15 re-plans, 4.1) | job fails, returns 0 |
| player gives the founder any other order (right-click, move, patrol, another `GRUENDEN`) | the order cancels the job; the scheduler deletes it at its next slot |
| founder is killed | death cancels his job (combat.md 10.1) *(I: his home town pointer is kept on death)* |
| any of these during the 20-tick pause after completion | the same, but the destroyed hall is the completed, inactive one |

**What the destruction does** (`combat.md` 10.3 and 10.4):

1. The hall collapses at once: stage 0 for a site, or 9 for a completed hall. It leaves **no
   rubble** (no stone cost).
2. mentor#80 "Gebäude wurde abgerissen."
3. The **whole town is destroyed**:
   - mentor#21 "Eine Stadt wurde zerstört!";
   - its name index is freed;
   - every unit of the town has its job cancelled and moves, as **homeless**, to the **nearest
     other town of the nation that has any town hall** (a site counts). With no such town,
     **every unit of the town dies**;
   - if the nation then has no town (name-set size 0), it is **defeated** (`0045d2a0`).

Consequences:

- A free-play human whose first founder is interrupted, killed or sent to an unreachable spot
  loses the founder and the game.
- **Site demolished or destroyed.** The site can be demolished with `ABREISSEN` (`00451ec0`
  allows it because the town has a living town hall; I that `00451ec0` is the `ABREISSEN`
  command), or killed by enemies (it has only 1000
  HP). The same town destruction follows. The founder, still walking, is relocated (or dies) and
  his job is cancelled.
- **Quirk, cascade (C by reading).** Jobs are deleted lazily (1.1), and the destructor uses the
  founder's town at **deletion** time. So:
  - **Site destroyed while the founder walks**: the founder is first moved to the nearest town;
    then his deleted job destroys **that town's** hall, and that town is destroyed too. The chain
    stops there, because his job pointer is already cleared.
  - **Second `GRUENDEN` while the first walk is on**: `00464aa0` switches him to the second new
    town before the first job is deleted. The deletion then destroys the **second** site (and
    town). The first site stays, with nobody coming. The founder ends up homeless in the nearest
    town that has any town hall, possibly the orphaned first site's town.

  A rebuild should keep the job's target hall and destroy only that hall, and only while it is
  still a site or inactive. If exact fidelity is wanted, reproduce the original behaviour behind
  a flag.
- **Quirk, retarget.** A right-click of a founder on any own town-hall site (3.2) creates a 0x0E
  job whose path goes to the clicked site. Completion and entry, however, always use the first
  town hall of the **founder's own** town. If that hall is already active, completion resets it
  to state 0 and HP + 10000, and the founder's entry re-activates it: births are skipped because
  the hall is full, but the **start goods are overwritten** again *(C by reading; only reachable
  with an orphaned site, rare)*.
- **An empty town** (its site gone) is destroyed as above. Its object is freed when the last
  reference goes. Nothing re-founds it.

### 11.7 Computer players

- The AI founding mission (kind 0x36, `ai-diplomacy-trade.md` 1.12, `00467f80`) chooses its own
  site. It calls the founding routine `00464aa0` **directly**, without command 19 and its
  checks, as soon as its founder (outside any building) is 8..15 cells from the target, so the
  founder walks the last 8..15 cells under job 0x0E. Its site test (`00467e10`) has no
  visibility rule.
- At founding: no leisure job, research slider 40, AI planner objects created (11.2).
- At activation: planner jobs scheduled after 1/16/33 ticks; births and start goods follow the
  same rules. An AI founding in play normally already has a town, so the new town gets 10 wood,
  10 stone and 10 food.
- Towns created at map start skip the founder walk: completion (`004602d0`) and activation
  (`0045fa40`) are called directly (`world-populate.md` §9; `.dvm` loader for map town halls).

---

## 12. Remaining unknowns

1. *(Resolved.)* Cell flag 0x1 is the path flag. Building foundations set it (6.6), and so do
   worn paths (4.5).
2. ~~The OD descriptor field for animation speed.~~ Resolved: layer speed, descriptor +0x30
   for the main layer (`docs/rendering/objects.md` 1).
3. *(Resolved in `economy.md` 11.7: 0x800 = the four corner blocks must lie in the current town's
   territory; 0x1000 = none of the four points may lie in any territory.)* Cell flags 0x800 and
   0x1000: exact meaning (placement masks). Already known: 0x2 is a unit on
   the cell, 0x20/0x2000 water/land tile and 0x80 not visible (6.1). 0x1000 is the territory
   test of the click check (11.1).
4. Job types marked I in 3.1: their full behaviour. Not needed for economy, but needed for
   combat (0x08/0x09/0x1B/0x1C/0x27/0x28), crime (0x17/0x18/0x19), trade (0x20),
   healing (0x29), errands (0x38) and 0x25. Founding (0x0E) is now section 11, the news round
   (0x1A) section 8.6.
5. The path planner (`0047fe70` / run `004706e0`; `0047b030` is only the goal-cell chooser,
   4.8): it searches from both ends, 100 expansions per run, and gives up after 2000. The mode
   argument and the cell costs are now decoded (4.1 "Two planning modes", "Planner costs"). The
   exact expansion order and tie-breaks were not; our A* only has to be deterministic, not
   identical.
6. The over-ordering of production inputs (8.2) and unclamped local stocks: confirm in game.
7. ~~What the client sends to trigger idle fidgets.~~ Resolved: command 0x2A from the display's
   idle timer (`00436260`). It fires every 5..30 s (`rand()`), for on-screen units that are
   standing still. See `docs/rendering/objects.md` 5.2.
8. *(Resolved, 7.3.3.)* `00449a30` scans a square of nature-flagged cells around a centre and
   returns the object of the given **class** (7 animals, 8 trees) nearest to a second point.
9. Whether the dispatcher job is re-created cleanly after it ends (town+0x04 is tested for 0;
   the destructor that clears it was not read).
10. The AI porter group id 50 (5.4).
11. *(Resolved, 6.7.)* `00475990` is the resume half of the pause/resume construction command
    `00452d20`; `004758c0` is the pause half.

---

## 13. Analysis aid used

`re/dump/decomp.c` lacks most virtual methods (job `run` functions, message handlers). To get
them:

1. Collect every vtable assigned in the dump.
2. Walk each vtable while its entries point into .text.
3. Create a function at every missing target and decompile it with a small Ghidra post-script
   ("decompile at address list").

The script was run read-only on the existing project, and the 360 extra functions went to a
scratch file. To reproduce: list the vtables from `= &PTR_..._XXXXXXXX;` assignments, read
their dwords from the PE, and decompile the targets.

The job type → vtable map comes from the job constructors (`004821c0` callers) and the
save-game factory switch (`00402dc0`, jump table at 0x4039BC, types 0..0x3C).
