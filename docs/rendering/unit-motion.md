# Unit motion on screen: facing, walking, actions, idle fidgets (display spec)

Status: **first full pass**, written to fix four visible differences (wrong facing, too smooth
walking, missing idle behaviour, missing police sound and status text). Sources: decompiled
AN.exe (GOG). The idle timer and the movement threshold were checked in the Gold `dvge.exe`
too: they are the same. Addresses are evidence only; no code is reproduced.

Legend: **C** = confirmed in code, **I** = inferred, *(uncertain)* = not settled.

Related documents:

- `docs/game/units-and-jobs.md` 4.1 (step timing), 4.6 (facing and turning in the simulation),
  4.7 (cell occupancy, blocking, step aside), 4.8 (work positions), 4.9 (idle command), 4.10
  (entering, leaving, births), 7.7 (animals), 10 (animation timing).
- `docs/game/combat.md` 4.1 (strike facing and strike animation), 12.3 (arrest: status text and
  sound).
- `docs/formats/od-odb.md` (sprite slots = action × 8 + direction), `docs/formats/odb.md`
  (+0x04 sound frame, +0x08 sound, +0x134 sound action, +0xC4 step times).
- `docs/rendering/world-projection.md` (screen = ((y − x)·32, (x + y)·22 − (h − 128))).
- `docs/rendering/objects.md` (written in parallel): OD layers and the layer player, the
  display's idle timer (5), selection and sample-file mapping (7.2), and the message list (9).
  This document adds what that one leaves out: facing, step interpolation, the walk-frame rule,
  action events and status texts.

---

## 0. Which parts are simulation state

| topic | where it lives | lockstep relevance |
|---|---|---|
| facing value (unit +0x1C), turn delays before steps and strikes | simulation | **yes**: turning costs ticks (units-and-jobs 4.6) |
| which sprite row shows a facing (slot = action × 8 + facing) | display | no |
| step timing, the cell a unit occupies, blocking and stepping aside | simulation | **yes** (units-and-jobs 4.1, 4.7) |
| drawn position during a step, walk-frame advance, the pause at every cell, the standing pose | display | no |
| idle fidget: *when* it happens | display (wall clock, C `rand()`) | no, but its *effect* is a command |
| idle fidget: the turn and the idle animation | simulation command 0x2A → job 0x1F | **yes**: facing changes and the unit has a job for a few ticks (units-and-jobs 4.9) |
| animal idling | simulation (animal job 0x24) | **yes** (units-and-jobs 7.7) |
| status text in the unit panel | display (reads the job type) | no |
| unit sounds | display | no |
| entering / leaving a building: the tick a unit vanishes or appears, its cell and facing, who is pushed | simulation | **yes** (units-and-jobs 4.10, section 7) |
| door picture, draw order | display | no (objects.md 4.1, 12) |

---

## 1. Directions

### 1.1 Numbering (C)

A facing is 0..7. It is also the sprite direction: slot = action × 8 + facing, and the sprite
names end in the same digit (`MG0`..`MG7`). The simulation derives it from the grid delta of a
step (direction function `004741d0`):

| facing | grid step (dx, dy) | screen direction (world-projection.md) | sprite (checked on `PI\VE\SAMMLER\MG0..7`) |
|---|---|---|---|
| 0 | (−1, −1) | up, away from the camera | back view |
| 1 | (−1, 0) | up-right | back view, walking up-right |
| 2 | (−1, +1) | right | right profile |
| 3 | (0, +1) | down-right | front view turned right |
| 4 | (+1, +1) | down, toward the camera | front view |
| 5 | (+1, 0) | down-left | front view turned left |
| 6 | (+1, −1) | left | left profile |
| 7 | (0, −1) | up-left | back view, walking up-left |

On screen the numbers run **clockwise, starting at "up"**. Three independent checks agree:

- the direction function itself (below);
- the walk sprites: `MG1` carries the basket on the lower left and walks up-right; `MG2` faces
  right; `MG6` faces left;
- the builder's work spots (`00478350`, `00477ce0` phase 0). A builder on the −x side of the site
  faces 5, on the +x side 1, on the +y side 7 and on the −y side 3. Each of these faces the
  footprint.

### 1.2 Direction toward an arbitrary target (C, `004741d0`)

Inputs: dx, dy = the shortest wrapped delta from the unit's cell to the target cell, in cells.
Both 0 means "no direction": the caller keeps the current facing.

| condition | facing |
|---|---|
| \|dy\| ≥ 2·\|dx\| | 3 if dy > 0, 7 if dy < 0 |
| 2·\|dy\| ≤ \|dx\| | 1 if dx < 0, 5 if dx > 0 |
| otherwise (a diagonal sector) | dx < 0: 2 if dy > 0, 0 if dy < 0. dx > 0: 4 if dy > 0, 6 if dy < 0 |

The sector borders lie at a slope of 1 : 2 **in grid space** (26.6° off an axis), not in screen
space. For single steps this reduces to the table in 1.1. The same function is used for path
steps, step-aside steps, the final turn of a go-to job, harvesting (`00477820`), the strike
facing (combat.md 4.1) and the attack position.

### 1.3 Turning (C, `00474260`, `0047f030`)

- The difference target − current is reduced to −4..+4 the short way round. For exactly 180°
  the code picks the other sign: the facing counts **down** when target > current, and **up**
  when target < current.
- One turn call:
  - no difference: nothing, delay 0;
  - a difference of one step (45°): the facing becomes the target, delay 0;
  - otherwise: the facing moves one step toward the target, with delay
    **max(1, step_time[0] div 4)** ticks (record +0xC4). That is 1 tick for every unit of the
    base game.
- Cost: 45° is free, 90° costs 1 tick, 135° costs 2 and 180° costs 3. A facing message (3,6) is
  sent for every change, so each intermediate direction is visible for one tick.
- The strike job has its own turn with delay floor(step_time[0] / 2) (combat.md 4.1).

### 1.4 When the facing changes while walking (C, `00480410`)

The facing is updated at the **start of each step**, in the same job run as the step and before
it:

1. The direction to the next path cell is computed (1.2).
2. One turn call is made (1.3).
3. If it returns a delay, the unit does not step in this run. It turns again on the next run.
4. Otherwise it steps at once.

So the facing message and the step message go out in the same tick, facing first. A unit that
walks a bend of 45° turns without stopping. A sharper bend costs 1 to 3 ticks of standing.

### 1.5 Display side (C, `00435030`, facing handler `00455960`)

- The sprite is slot (action × 8 + display facing) of the object's `.od` record. **If that
  slot is empty, the display facing is set to 0** and slot action × 8 + 0 is used. This is why
  idle animations, which mostly exist only as `ID3` or `ID5`, always begin with a turn to 3 or 5
  (section 4).
- A facing message stops a running action first (its pending event fires, section 3), resets
  the frame to 0 and returns to the base movement action. Then the new facing is taken.
- If no action runs, the current frame index is kept. A walking unit therefore turns without a
  break in its walk cycle.

### 1.6 Our build (deviation, fixed in the engine)

*Fixed:* `path.ts` now numbers facings as in 1.1 (`DIR_STEP`, `dirToward` with the 1 : 2
sectors, `turnOnce` / `turnStep` with the 180° rule); the A* neighbour order is unchanged. The
client's projectile direction (`effects.ts`) uses `dirToward` too. The text below describes the
state before the fix.

`src/engine/path.ts` (`DIR_STEP`, `dirOf`), `src/engine/combat.ts` (`dirTo`) and
`docs/architecture/simulation.md` number the directions as (−1,−1)=0, (0,−1)=1, (1,−1)=2,
(1,0)=3, (1,1)=4, (0,1)=5, (−1,1)=6, (−1,0)=7. That table has **x and y swapped**. On screen
it mirrors every facing across the vertical axis: only 0 and 4 are right, and a unit walking
up-right shows its up-left sprite. Converted, original = (8 − ours) mod 8. Two smaller
differences:

- `dirTo` uses only the signs of the delta, not the 1 : 2 sectors of 1.2;
- the strike turn in `combat.ts` always counts up for 180° (1.3 says which way to count).

The leave-building facing (3 or 5) and the A* neighbour order do not depend on this table.
They need no change, apart from the facing value the step sets.

---

## 2. Walking: how the drawn position advances

### 2.1 What the simulation sends (C, `004621c0`, units-and-jobs 4.1)

At the start of a step the simulation **moves the unit to the destination cell at once**: the
position, the height and the cell occupancy (units-and-jobs 4.7). It then sends a step message
(2,0x13) with the destination x, y, height and the step's duration **D in ticks**. D is the delay
the job returns, so the next step message comes exactly D ticks later.

### 2.2 Step message on the display (C, `00455720`)

1. Any running action is stopped. Its event fires if pending (section 3). The frame resets to 0
   and the base movement action (walk `MG` or carry `CA`) returns.
2. The object's map index is moved from the old cell to the new one. The worn-path roll happens
   here (units-and-jobs 4.5).
3. Positions are kept in **1/64 cell**. The *remaining offset* R = new position − old position
   (wrapped) is stored per axis: ±64 on one axis for a straight step, on both axes for a
   diagonal one. The object is drawn at "new position − R", so it starts at the old cell.
4. The start time is set to the wall clock (`GetTickCount`). The duration is
   **T = D × tick_ms**, where tick_ms is the display copy of the scheduler interval: **95 ms** at
   normal speed, 47 and 23 at the faster settings (`004afaa4`).

### 2.3 Per-frame movement update (C, `00442390`)

This runs once per rendered frame for every object on screen that is **not** playing an action
(`004421b0`). An object that plays an action gets the action update instead (section 3).

1. It acts only if more than **10 ms** of wall clock have passed since its last update.
2. e = time since the step started, capped at T. Each axis has a target remaining offset
   R0 − R0·e/T (integer arithmetic, truncated).
3. The **height** is interpolated linearly from the old to the new cell height, on every update.
4. The target is compared with the remaining offset that is currently drawn. The change is
   measured as max(|Δx|, |Δy|) + min(|Δx|, |Δy|) / 2, in 1/64 cell.
   - **More than 3**: the drawn offset jumps to the target, the walk (or carry) animation
     advances by **exactly one frame** (wrapping), and the sprite is redrawn.
   - **3 or less**: nothing moves on screen.

   The threshold is in 1/64 cell, not in pixels. The "3 px" in `objects.md` 9 should be read
   as 3/64 cell.
5. When the target offset reaches (0, 0), the drawn offset is set to 0. The step is then over on
   the display. This last snap advances the frame only if it also was a jump of more than 3.
6. A step with T = 0 jumps at once.

The pixel position is the destination cell's screen point minus the projected drawn offset,
truncated to whole pixels (`00445c80`). At zoom 1, 1/64 cell is 0.5 px horizontally and 0.34 px
vertically on each axis.

### 2.4 Consequences (C)

- **Walk frames are driven by distance, not by time.** One frame is shown per jump of at least
  4/64 cell on a straight step (at least 3/64 per axis on a diagonal), because the offsets are
  whole numbers. That is at most 16 frames per straight cell and 21 per diagonal cell, and fewer
  when updates come less often. A 12-frame `MG` cycle therefore covers at least ¾ of a straight
  cell. The OD speed value plays no part in walking.
- **The drawn position moves in small jumps**, never continuously. At zoom 1 a straight jump is
  at least 2 px horizontally and 1.4 px vertically.
- **A unit that stops keeps the walk frame it last showed.** Nothing resets it to frame 0 when a
  path ends, and a turn without an action keeps it too. Only the end of an action (section 3)
  resets the frame to 0.
- **Example** with the 15.625 ms Windows clock (2.5). A porter takes D = 6 on a flat straight
  step, so T = 570 ms. Each clock step adds 1.75/64 cell, and after truncation the target moves
  by 1, 2 or 3 units between readings. The drawn position therefore jumps by 4 or 5/64 cell
  (2 to 2.5 px across) on every third clock step, about every 47 ms. That gives roughly 14 jumps,
  and 14 frame advances, per cell. A diagonal step (D = 9, T = 855 ms) jumps 3/64 per axis (2 px
  straight down) on every third clock step, about 21 times per cell.

### 2.5 The pause at every cell (C mechanism; size I)

This is the "hiccup" that a player sees.

- The scheduler runs a tick only when **more than** 95 ms have passed since the previous tick.
  It then restarts the interval from the current time (`00482ca0`). It never catches up and runs
  at most one tick per pass of the main loop. The main loop does not sleep (`0048b040`). The real
  tick period **P is therefore always longer than 95 ms**.
- The display interpolates every step over exactly D × 95 ms.
- The next step message comes D × P later. So **at every cell the unit stands still**, frozen on
  its current walk frame, for **D × (P − 95) ms**.
- How long that is depends on the wall clock *(I)*. Windows of the NT family, which is what
  the GOG release runs on, advance `GetTickCount` in steps of 15.625 ms. The first reading above
  95 is 109.4 ms (7 steps), so P ≈ 109.4 ms (9.1 ticks/s):

  | speed | interval | P on a 15.625 ms clock | standing share of each step | porter, flat straight step |
  |---|---|---|---|---|
  | normal | 95 | 109.4 | 13% | 570 ms walking + 86 ms standing |
  | fast | 47 | 62.5 | 25% | |
  | fastest | 23 | 31.25 | 26% | |

  On a 1 ms clock P is 96 ms plus about half a frame time, so the pause is shorter but still
  there.
- **Other stops** a player sees while units walk (all simulation, `units-and-jobs.md`):
  - turns of more than 45° before a step (1.3);
  - 3 ticks plus the planner's own time before the first step of every walk, and again after
    every re-plan (4.7);
  - waiting for a moving blocker, or 5-tick polls while a blocker steps aside (4.7).

### 2.6 How to reproduce it in our client (recommendation)

`src/client/main.ts` interpolates the simulation position with a per-frame alpha. Walk frames
come from time (`looks.ts`, 0.7 frames per tick), and a standing unit shows frame 0. To match the
original:

1. Keep a per-unit display record: from cell, to cell, start time, duration, remaining offset,
   drawn offset, frame index, height.
2. On a step start (seen as a new step in the simulation state, or as an event), set the start
   time to the wall clock and the duration to D × TICK_MS × 95 / P_orig. P_orig = 109.375 ms
   reproduces the GOG look; the unit then arrives about 13% early and waits. Use D × 95 ms
   instead if TICK_MS is changed to the measured P.
3. Every rendered frame, follow 2.3 exactly: the 10 ms gate, truncated linear targets, the
   "more than 3/64" jump rule, one walk frame per jump, and the final snap. For the full vanilla
   look, quantise the wall clock to 15.625 ms first. Interpolate the height continuously.
4. Never advance walk or carry frames by time, and keep the last frame when the unit stops.
   Reset to frame 0 only after an action (section 3).
5. Draw at the destination minus the drawn offset, in whole pixels.

None of this touches simulation state.

*Done* (`src/client/display.ts` `StepDisplay`, `UnitDisplay`; `looks.ts`, `main.ts toScreen`):
points 1-5 as written, with the wall clock quantised to 15.625 ms, the step start set back by the
time since its tick, and the per-cell stand from D × 100 × 95 / 109.375 ms. The same object keeps
the display facing (1.5: the fallback to 0 for an empty slot, a facing change cutting an action
that began earlier) and the action animations of section 3. The former constant-speed glide with
time-based walk frames remains as the enhanced-mode setting `smoothMovement` (default off).

---

## 3. Actions: work, strike, idle (C, `00456490`, `004425c0`)

An action message (0x19,11) carries: the action (1 strike `ST`, 2 work `WO`, 3 idle `ID`),
the **event frame** (normally the record's sound frame +0x04; −1 = the last frame) and a
**repeat count** n.

- **The action message clears the remaining step offset** (both axes set to 0, `00456490`). A
  unit that starts an action in the middle of a drawn step is therefore drawn on its destination
  cell from that moment, without a walk frame. The drawn height is not touched and keeps the value
  interpolated so far until the next step message *(C by reading; visually negligible)*. In the
  original this snap is almost never visible: jobs start actions only after a step's duration D
  has passed (for attacks, `combat.md` 3.3), and the display finishes a step in D × 95 ms, before
  the next tick.
- One cycle lasts T = frames × tick_ms × 10 / speed ms. Speed comes from the sprite: −1 means 7,
  so a frame lasts 10/7 tick.
- The frame shown is floor((frames − 1) × elapsed / T). The last frame therefore appears only at
  the very end of a cycle. Updates happen at most once per millisecond.
- At the end of a cycle:
  - if n > 0: n − 1, restart at frame 0 and re-arm the event;
  - otherwise: fire the event if it is still pending, and return to the base movement action at
    **frame 0**.

  So n = 0 plays one cycle and n = 10 plays 11 (the animal idle). 0x4000 means "until stopped"
  (builders). The 99/100/50 used by gathering and planting are ended early by the stop message
  (0x27,11) when the job's work time is up.
- The **event** fires once per cycle, as soon as the frame index reaches the event frame. A step
  message, a facing message or the stop message also fires a pending event before it cancels
  the action. A new action message replaces the old action **without** firing.
- The event (`00435ad0`) plays the record's **sound** (+0x08) when all of these hold:
  - the sound is not 0;
  - the current action equals the record's sound action (+0x134);
  - the current frame ≥ the record's sound frame (+0x04);
  - the object is in this frame's visible list.

  Stereo position and volume come from the screen position and the zoom. An action interrupted
  before the sound frame therefore stays silent. For projectile weapons the same event also
  launches the projectile sprite (launch point, straight flight, hit sound and impact effect:
  `docs/rendering/projectiles.md`).
- While an action plays, the movement update (2.3) does not run for that object.
- A strike is sent with repeat count 0: the `ST` row plays **once** per strike, then the unit
  shows its standing pose (base action, frame 0) until the next strike (`combat.md` 4.1). Our
  `looks.ts` loops it instead (`combat.md` 20.6).

Our build (`main.ts unitSound`) plays the sound only when the animation shows exactly
`soundFrame`, and the action is time-based. If the action is replaced before that frame, the
sound is lost. One such case was `world.move` setting the action back to idle when the path's
last step ended, right after a strike that started during that step. *Fixed in the engine:* the
end of a walk only resets a movement action (walk, carry), and the end of an attack no longer
resets a strike (`docs/architecture/simulation.md` "Display contract for movement").

*Fixed in the client* (`display.ts UnitDisplay`): the frame and cycle rule above, one strike
cycle then the standing pose at frame 0, work looping, the idle row for `idleLoops + 1` cycles,
the event once per cycle as soon as the frame reaches the event frame (and at a cycle end if it
was skipped), no event for a cut action. The simulation's work action carries no repeat count;
the client plays it **once** under the found-town job (0x0E, units-and-jobs.md 11.3: loop
parameter 0), the news round (0x1A, repeat count 0 at each house, units-and-jobs.md 8.6), the heal
job (0x29) and for priests (heal strikes play `WO` once), and loops it
otherwise (gathering, building, planting). A repeat count in the display contract would remove
this guess.

**Fixed (October 2026; the hunter "jump" after a kill, `units-and-jobs.md` 7.3.9 items 7..10):**

- *Display*: `UnitDisplay.update` sets the step's drawn and remaining offsets to 0 when it sees a
  new strike, work or idle animation (`action`/`actionTick`/`idleTick`), without a frame advance.
- *Simulation*: planning a walk (`logistics.ts goCell`) no longer changes the action; the walk or
  carry action belongs to the first step (`World.stepTo`). Attacks test their range only after a
  step's duration (`combat.md` 3.3). Animals eating play `ID3` with repeat count 99 (4.3,
  `units-and-jobs.md` 7.7.1).

---

## 4. Idle fidgets of units (C, `00436260`, `00445550`; command handler `00452000`)

### 4.1 Display trigger (display only, not deterministic)

The timer itself is specified in `docs/rendering/objects.md` 5.1, and the unit branch in 5.2.
In short:

- every object in the drawn list has a wall-clock interval of **rand() mod 25000 + 5000 ms**
  (5 to 30 s), drawn with the C runtime `rand()`;
- the timer is reset while the object moves (2.3) or plays an action, and when it leaves the
  screen;
- when a **unit's** timer fires (record kind 0; animals are nature objects and never come here):
  - with probability ½: command 0x2A with **direction 3 and "play animation"** if the unit's
    `.od` has `ID3` (slot 27), otherwise **direction 5** if it has `ID5` (slot 29);
  - otherwise, and also when the unit has neither sprite: command 0x2A with **direction
    rand() mod 8 and no animation**.

The command goes out through the normal command queue (`0040c300`), like a player order. Gold
skips ship types 64..67 (objects.md 5.2). No owner test was found: the viewing client seems to
fidget every visible unit, foreign units included *(uncertain)*.

### 4.2 Simulation effect (C; full rules in units-and-jobs 4.9)

The unit gets a turn/idle job (0x1F) **only if it has no job at all**. If it carries goods, the
"play animation" part is dropped. The job turns the unit as in 1.3, then sends the action
message for action 3 with repeat count 0 (one cycle) and ends.

### 4.3 What the player sees

- An idle unit that has an idle sprite: every 5 to 30 s, at random, either it turns to 3 or 5
  and plays its idle animation once (about 12 frames, roughly 17 ticks), or it turns to a random
  direction without animating. A random turn hits the current direction 1 time in 8.
- An idle unit without idle sprites only ever turns at random. Idle sprites per race:

  | race | `ID3` | `ID5` | none |
  |---|---|---|---|
  | Amazons (group 0) | 9, 11, 18, 24 | 10, 13, 15, 16, 20, 21, 22, 23, 24, 25, 28 | 12, 14, 17, 19, 26, 27, 29..36 |
  | Pimmons (group 1) | all others | 24 (also `ID3`) | 17, 19, 27 |
  | Sajiki (group 2) | all 28 types | | |

- A carrying unit only turns, to 3 or 5 or at random.
- The idle animation is cut short by any step, turn or new action.
- The status text stays T278 "Ohne Aufgabe" (section 6).

Animals idle differently, through their own job (units-and-jobs 7.7): they turn to 3 and play
`ID3` with repeat count 10, and every animal has `ID3` and `ID5`. They **eat** with the same row:
from the cell behind a bush or crop (its y − 1 neighbour) they turn to 3 and play `ID3` with
repeat count 99. The bite (amount − 1, new bush picture) comes 100 ticks later, and the row runs on
until the next wander walk cuts it, about 5 ticks after the bite (units-and-jobs 7.7.1).

### 4.4 Our build (deviation; simulation side done)

*Done in the engine:* the lockstep command `{ type: 'fidget', player, unit, dir, play }` and job
0x1F (`motion.ts`), and the animal modes of units-and-jobs 7.7. The client's idle timer is still
to come. The text below describes the state before the change.

Units have no idle behaviour at all: a standing unit shows walk frame 0 in its last facing.
Animals in `logistics.ts runAnimal` set `Action.Idle` without turning to 3, so `looks.ts` shows
`ID` only if the animal happens to face 3 or 5, and then only frame 0. Otherwise the animal shows
walk frame 0 in its current facing. This is the "turns randomly without playing its idle
animation" effect. To match the original:

- **Units.** The client keeps the wall-clock timer of 4.1 (any random source is fine there) and
  sends a lockstep command `idle {id, dir, play}`. The simulation applies 4.2 / units-and-jobs
  4.9. Sending one command per visible idle unit every 5 to 30 s is what the original does.
  A cheaper variant that changes only the display would make the facing differ between clients,
  so it must not write the simulation facing.
- **Animals.** Use the job modes of units-and-jobs 7.7: turn to 3, then `ID3` for 11 cycles, cut
  by the next walk.

*Done in the client* (`main.ts fidget`, the `display.ts IdleTimer` of every drawn unit, held
while the unit moves or plays an action, reset when it leaves the screen; display RNG
`Math.random`). **Deviation: who sends.** The original's viewing client fidgets every unit it
shows (4.1, no owner test found). With several players that would send one command per client
for the same foreign unit, so a unit on everybody's screen would fidget once per player. Ours
sends the command only for

- the local player's own units, and
- if this client is the host (lockstep slot 0) or there is no network game: units of computer
  players and units without an owner.

Each unit then fidgets about once per timer period, as in a single-player original, when its owner
(or, for computer units, the host) has it on screen. A unit that only another player sees does
not fidget. The client also skips units with a job or a walk (the simulation would ignore the
command; this only saves traffic) and Gold ship types 64..67.

---

## 5. Sounds of walking, working and fighting units (C, `00435ad0`)

There are no footstep sounds. A unit sound is the record's +0x08, played by the action event of
section 3: work tools in action 2, weapons in action 1. Values for the units of point 5:

| race | police (21) | sound | sound frame | sound action | `ST` frames |
|---|---|---|---|---|---|
| Amazons | Politesse | 11 | 5 | 1 | 10 |
| Pimmons | Polizist | 11 | 7 | 1 | 12 |
| Sajiki | Polizist | 11 | 6 | 1 | 13 |

Sound 11 is the file **`Sfx_011.wav`**. Correction of an earlier guess: the loader fills a
table of 69 samples, entry i = file i + 1 (`00486cc0`, table at 0x4B558C). Fixed samples (selection
`Sfx_043`, buttons `Sfx_042`, collapse `Sfx_053`) are addressed by entry. **Record sounds** (unit
action events `00435ad0`, building random layers `00436260`, death effects `00434840`, the animal
death cry `004588a0`) index the same table from 0x4B5588, one entry lower, so record sound n plays
**file n**. Our `sfx.ts` loading `Sfx_<id>` for a record sound id is therefore right.

The Amazon officer's truncheon strike plays sound 11 when its `ST` animation reaches frame 5,
about 7.9 ticks after the strike starts. The impact comes at (5 × 1000 / 7) / 100 + 1 = 8 ticks
(combat.md 4.3), and only then does the criminal flee. So the officer is still standing when the
sound frame comes.

---

## 6. Status text in the unit panel (C, unit info message `00455d50`)

The panel line is chosen in this order:

1. The unit is inside a building and has no job, or its job is blocked: T280
   "Ist in Gebäude: %s" with the building's name.
2. The unit has a top-level job (unit +0x30): **that job's** status text (job vtable slot 4).
   The text of a child job is not used, except where the parent forwards it (0x3C, 0x2B).
3. No job: T278 "Ohne Aufgabe".

Status text per job type (DV.tdb, the same in GOG and Gold):

| job | text |
|---|---|
| 0x05 transport | T272 "Trägt %s zu %s" while loaded, T281 "Holt %s aus %s." on the way to fetch |
| 0x06 follow path (plain move) | T308 "Unterwegs" |
| 0x07 go to object | T269 "Unterwegs zu %s" |
| 0x08 attack | T262 "Attackiert %s" (target name *(I: the argument was not decoded)*) |
| 0x0C builder | T264 "Errichtet %s" on a site, T310 "Restauriert %s" on a repair |
| 0x0E found town | T266 "Errichtet Stadt" |
| 0x16 harvest | T263 "Sammelt %s" |
| **0x18 arrest (police)** | **T271 "Jagt Kriminellen"** for the whole job: chasing, beating, and walking back to the station |
| 0x1A news round | T270 "Verkündet Neuigkeiten" |
| 0x1F turn / idle | T278 "Ohne Aufgabe" |
| 0x20 trade | T273 "Bringt %s von %s nach %s" / T305 "Unterwegs von %s nach %s" |
| 0x21 plant | T275 "Pflanzt %s an" |
| 0x26 flee | T274 "Flüchtet vor %s" |
| 0x27 guard / patrol | T276 "Patrouilliert" |
| 0x29 heal | T277 "Heilt %s" |
| 0x2B work area (hunters and others) | with a child: T268 "Jagt %s" (the animal's name) while an attack is anywhere in the child chain; otherwise the harvest child's T263; T279 "Unterwegs ins Jagdgebiet" while the direct child is a plain walk; otherwise empty. Without a child: T267 "Hält nach Tieren Ausschau" |
| 0x38 operator errand | T265 "Bietet %s %s an" |
| 0x3C answer request | the child's text |
| 0x09, 0x0B, 0x0D, 0x0F, 0x17 criminal, 0x19 escort, 0x1B, 0x24, 0x25, 0x28, 0x2A | empty line |

An officer sent from the station, or ordered onto a criminal by the player, therefore reads
"Jagt Kriminellen" until the arrest job ends. Back inside the station (as its operator, without
a job) he reads "Ist in Gebäude: <police station>".

Our build had no case for the arrest job in `hud-pages.ts jobText` (it fell through to T308
"Unterwegs"), nor for the other combat jobs. *Fixed:* arrest T271, attack T262, flee T274, guard
T276, heal T277, found town T266, turn/idle T278, empty lines for 0x0F, 0x17, 0x19 and 0x1B, and
T268 for a harvest job while it hunts, and the hunter's work area 0x2B as in the table above
(T267 waiting, T279 walking back, T268 hunting, otherwise the harvest child's T263).

---

## 7. Entering and leaving a building on screen (C; simulation rules in `units-and-jobs.md` 4.10)

What the player sees, driven by the messages of the enter and leave jobs. The timing (which tick
a unit vanishes or appears, where and facing which way) is **simulation**; the door picture and
the vanishing are display (`objects.md` 4.1, 9).

### 7.1 Entering

1. The unit walks to the **entrance cell** with its normal walk (section 2). That cell is the
   ring cell in front of the door, outside the footprint. The unit never steps onto the
   footprint and there is no special "walk in" animation or path.
2. It turns toward the building's **front corner** (anchor), one 45° step per tick beyond the
   first (section 1.3). With the base-game door offsets it ends facing 6, 2, 5 or 3 (sideways
   along the wall rather than into the door; table in `units-and-jobs.md` 4.10). It keeps its
   last walk frame (2.4).
3. One tick later it is admitted (if it heads the door queue): the **door starts opening**
   (message 0x2B: door layer frames 0 → n − 1 at 7 fps, then held open).
4. It stands there for **5 ticks** (about 0.5 s at normal speed; 5 × 109 ms ≈ 0.55 s on the GOG
   clock, 2.5). A unit that was one cell short walks onto the entrance first (one step).
5. Message 5 "unit entered": the unit's index leaves its cell, so it is **gone from the next
   frame on**: no fade, no frame of it inside the door. The door closes at once from the fully
   open frame (frames n − 1 → 0). Its vision disc is removed.

During steps 2..4 the unit is drawn **in front of** the building, because every entrance cell
except the watchtower's lies on a front face (`objects.md` 12.3). Seen in game, the unit walks up
to the door, the door opens in front of it, and it vanishes while the door is about 5/7 open.
That reads as "it went in".

At a **construction site** (porters delivering, the founder before completion) there is no door
and no vanishing: the unit stays visible on the site's entrance throughout.

### 7.2 Leaving

1. 10 ticks after the eject the **door opens** (0x2B). The unit is not drawn yet.
2. 10 ticks later (or 15, 20, 25 while the entrance is taken) message 0x64 puts the unit on its
   cell **at once**: no interpolation (`stepTicks` 0), standing, facing **3** (door x offset < 0)
   or **5** (otherwise). The door closes from the fully open frame. Its vision disc is added and
   the worn-path roll is made for that cell.
3. Whatever job comes next makes it walk off with a normal step, often a few ticks later
   (`units-and-jobs.md` 4.10). An idle unit standing on the entrance has meanwhile stepped aside
   with a normal step.

There is no "walk out of the door" animation either: the unit pops up on the entrance cell, in
front of the door, and walks on from there.

### 7.3 Births and trained units

They appear exactly like a leaving unit (7.2). A born unit is never drawn before that: it is
created inside, off the map. At a town's founding the door opens 10 ticks after the founder
vanished, then the builder pops up, and the two porters follow about 5 ticks apart, each one
pushing the previous (idle) one aside first (`units-and-jobs.md` 4.10, worked example).

### 7.4 Our build (implemented October 2026)

The engine follows `units-and-jobs.md` 4.10 (remaining differences listed there). The client's
door (`display.ts updateBuilding`) is driven by the building's door-open and door-close ticks
(`Entity.doorOpen` / `doorShut`, set by the simulation at the 0x2B / 5 / 0x64 / 0x2C moments): it
opens on admission and 10 ticks before a leaving unit appears, and closes from the fully open
frame when the unit vanishes or appears. A unit at a door is drawn in front of the building
(`objects.md` 12.6).

---

## 8. Open points

1. The real tick period on the hardware of 1999 (Windows 9x clock resolution, frame times). The
   15.625 ms figure in 2.5 holds for NT-family Windows.
2. Whether the idle command is really sent for foreign units (4.1).
3. *(Resolved, section 5.)* Record sound n plays file `Sfx_n.wav`; fixed samples use entry i =
   file i + 1.
