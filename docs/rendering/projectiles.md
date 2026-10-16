# Projectiles and impact effects on screen (display spec)

Status: **first full pass.** Written to answer "how do arrows, bolts, spells and catapult stones
look and move", and to list where our client differs. Sources: decompiled AN.exe (GOG); the
group-7 data was compared with Gold (identical `dv.OD` descriptors and `dv.wdb`). Addresses are
evidence only; no code is reproduced.

Legend: **C** = confirmed in code, **I** = inferred, **D** = read from the data files,
*(uncertain)* = not settled.

Related documents:

- `docs/game/combat.md` 4.1 (strike job, projectile message, impact delay), 6 and 6.1 (which
  unit shoots which projectile, sounds), 14 (hunters), 20 (our deviations, short list).
- `docs/rendering/unit-motion.md` 1.2 (direction sectors), 3 (action animation, event frame),
  2.3 (the per-frame movement update shared with walking units).
- `docs/rendering/objects.md` 1 (OD descriptors, slots), 7.2 (sample numbering).
- `docs/formats/odb.md` A.5 (group-7 records), +0x54..+0x90 launch points.

---

## 0. What is simulation and what is display

| part | where | lockstep relevance |
|---|---|---|
| when the strike happens, the impact tick, hit and damage | simulation (`combat.md` 4, 5) | yes |
| flight time f in the simulation (1/100 tick) | simulation | yes: part of the impact delay |
| the projectile picture, its path, its flight duration in ms, hit sound, explosion | display only | no |

The simulation never has a projectile object. The display creates one when the shooter's strike
animation reaches its release frame and removes it when it arrives. A miss looks exactly like a
hit: the projectile always arrives at the aim cell (C).

---

## 1. The projectile message (C, sent by `00481450`, applied by `004565a0`)

When a unit with a projectile weapon fires, the simulation sends message **(0x1B, 26)** instead
of the plain action message (0x19, 11). It carries:

| field | content |
|---|---|
| shooter | the attacking unit |
| target | the target object |
| projectile type | weapon record +0x08 (a group-7 type, `combat.md` 6.1) |
| flight f | d64 × 1000 / speed, with d64 = max + min/2 of the cell delta × 64 between the shooter's cell (or its outpost's cell) and the aim cell. Not wrapped in the simulation |
| action | 1 `ST` if the shooter's sprite set has a strike row, else 2 `WO` (all shooters have `ST`) |
| release frame | the shooter record's sound frame +0x04 (−1 = the last frame) |
| aim cell | x, y, z of the target footprint corner nearest the shooter (`00461e30`); a unit's own cell |

On the shooter's display object the message:

1. stores type, flight, target and aim cell;
2. starts the action like (0x19, 11): row `action × 8 + facing`, frame 0, **played once**
   (repeat count 0), cycle length T = frames × tick_ms × 10 / speed (speed −1 = 7, so one frame
   per 10/7 tick), clock = wall time now;
3. arms the action's **event** at the release frame, in "projectile mode".

A new action message for the same unit replaces this action **without** firing the event, so a
projectile can be lost on screen if something restarts the shooter's animation before the
release frame (display only; the simulation's impact still happens).

---

## 2. Release (C, event handler `00435ad0`, driven by `004425c0`)

The event fires once, as soon as the shown frame index reaches the release frame (frame index =
floor((frames − 1) × elapsed / T), `unit-motion.md` 3). A pending event also fires early when a
step, facing or stop message interrupts the action, and at the end of the cycle if it was still
pending.

When it fires:

1. **Shooter sound**: the shooter record's sound (+0x08) plays if it is non-zero, the current
   action equals the record's sound action (+0x134 = 1 for every shooter) and the shooter is on
   screen. Stereo pan and volume come from the screen position and zoom.
2. **Visibility gate**: the projectile is created **only if the target is on screen** (in this
   frame's visible list); for a target inside a building, that building must be on screen.
   Otherwise no projectile is shown at all.
3. **Direction d (0..7)** of the projectile sprite: the wrapped delta *target minus shooter* of
   their display positions (in 1/64 cell) is put through the same sector rule as the simulation's
   direction function (`unit-motion.md` 1.2: |dy| ≥ 2|dx| → 3 or 7; 2|dy| ≤ |dx| → 1 or 5;
   otherwise the diagonals 0, 2, 4, 6). If the delta is zero, the shooter's outpost is used
   instead of the shooter; if that is zero too, d = 0.
4. **Start cell** S: the shooter's cell, or its outpost's cell when it fires from a garrison.
5. **Create the projectile display object** (`00436970`): group 7, the message's type,
   **placed at the aim cell A**, facing d, action 0 (row `MS`). The sprite is slot d of the OD
   record; records with only slot 0 (spells, fire, acid) always use slot 0. Its flight duration
   is **f milliseconds** (the message's f, taken as ms).
6. **Launch pixel offset** L (`00436020`):
   - L = shooter sprite anchor − shooter record point[d], where point[k] = (+0x54 + 8k, +0x58 + 8k)
     in sprite-canvas pixels (odb.md);
   - for a garrisoned shooter, add the outpost's anchor − outpost point[slot] (the unit's slot in
     the building's display garrison list, objects.md 13.1). The drawn garrison unit stands
     22 px lower than this (objects.md 13.2, 13.4), so a shot from a tower leaves 22 px (× zoom)
     above the drawn bow (C by reading);
   - the anchor is taken from the per-race, per-type sprite table (`0x4B3914` entry +0x10/+0x14);
     it is the object's OD anchor (I, same values as the OD record).

   Since a sprite is drawn with its canvas origin at ground − (offset + anchor) (scaled by the
   zoom), this puts the **projectile's anchor exactly on pixel point[d] of the shooter's canvas**
   at the moment of release: the bow, the crossbow, the catapult arm, the caster's hand.

Examples (sprite-canvas pixels, anchor → point; "up" = pixels above the feet):

| shooter | anchor | facing 0 | facing 2 | facing 4 | facing 6 |
|---|---|---|---|---|---|
| Jägerin (Amazon hunter) | 60, 83 | 60, 27: 56 up | 86, 35: 26 right, 48 up | 58, 47: 2 left, 36 up | 37, 27: 23 left, 56 up |
| Bogenschütze (Pimmon archer) | 65, 83 | 65, 31: 52 up | 83, 42: 18 right, 41 up | 64, 49: 1 left, 34 up | 48, 41: 17 left, 42 up |
| Kanone (Amazon) | 155, 128 | 156, 65: 1 right, 63 up | 187, 95: 32 right, 33 up | 156, 115: 1 right, 13 up | 125, 93: 30 left, 35 up |

Units without projectiles have all points zero (melee units, hunters of Pimmons and Sajiki).

---

## 3. Flight (C, per-frame movement update `00442390`, shared with walking units)

The projectile has three things that change with t = min(now − release, f) in wall-clock ms:

| quantity | at release | at arrival | rule |
|---|---|---|---|
| ground offset from A, in 1/64 cell | S − A (wrapped the short way) | 0 | (S − A) − (S − A)·t/f, integer division |
| pixel offset | L | 0 | L − L·t/f |
| height | terrain height of S | terrain height of A | linear: h_S + (h_A − h_S)·t/f |

The position is updated at most once per 10 ms. The drawn point is the aim cell's projected
point minus the remaining ground offset, then lifted by the remaining pixel offset.

**Consequences (C):**

- The path is a **straight line on screen** from the launch pixel (bow) to the **ground point of
  the aim cell**. There is no arc and no gravity, for any projectile, catapult stones and cannon
  balls included. Shots therefore descend from hand height to the target's feet.
- The projectile flies to the cell the target stood on when the shot was fired. A target that
  walks on is still hit in the simulation (perfect homing, `combat.md` 6), but on screen the
  projectile lands behind it.
- Flight speed on screen: speed = 1/64 cells per second. Per straight cell: 64000 / speed ms.
  The duration is **wall-clock**, not scaled by the game speed (the action animations and impact
  effects are scaled by tick_ms; the flight is not).
- In the simulation the same f counts 1/100 ticks: 640 / speed ticks per straight cell. At normal
  speed (95 ms per tick) the two agree within 5 %.

| speed | users | screen ms per cell | sim ticks per cell | 5 straight cells | 8 straight cells |
|---|---|---|---|---|---|
| 600 | Seepyro (add-on) | 107 | 1.07 | 533 ms | 853 ms |
| 700 | Alchemistin, Magier, Beschwörer, Schlachtschiff | 91 | 0.91 | 457 ms | 731 ms |
| 800 | Mächtige Alchemistin, Mächtiger Magier, Gottesanbeter | 80 | 0.80 | 400 ms | 640 ms |
| 900 | Jägerin, Katapult, Kanone, Drachofiterus, Zerstörer | 71 | 0.71 | 355 ms | 568 ms |
| 1000 | archers, Spitpack, Amazon warships | 64 | 0.64 | 320 ms | 512 ms |
| 1100 | Armbrustschützin | 58 | 0.58 | 290 ms | 465 ms |
| 1200 | Pyro | 53 | 0.53 | 266 ms | 426 ms |

Diagonal distances use the same max + min/2 metric (a pure diagonal of n cells counts 1.5 n).

---

## 4. Frames and sprites of the projectiles (C rule, D data)

**Frame rule:** like a walking unit (`unit-motion.md` 2.3), the projectile advances **one frame
(cyclic) each time its drawn ground offset has changed by more than 3/64 cell** since the last
frame change. At these speeds that is every position update, so a multi-frame projectile changes
frame on every screen update (at most 100 per second), i.e. it spins with the distance flown, not
with a timer *(the visible rate depends on the frame rate of the machine; uncertain how it looked
on 1999 hardware)*.

| type | name | sprite (`dv.gd`) | slots × frames | anchor | notes |
|---|---|---|---|---|---|
| 0 | Alchemie1 | `BULLET\VE\ALCHEMIE1\MS0..7` | 8 × 8 | 54, 37 | flask, both alchemists |
| 1 | Alchemie2 | `BULLET\VE\ALCHEMIE2\MS0..7` | 8 × 8 | 59, 29 | **unused** (no weapon names it) |
| 2 | Armbrust | `BULLET\VE\ARMBRUST\MS0..7` | 8 × 1 | 59, 39 | Amazon crossbow bolt |
| 3 | Katapult | `BULLET\VE\KATAPULT\MS0..7` | 8 × 6 | 133, 64 | catapult, cannon, add-on ship cannons |
| 4 | Magie1 | `BULLET\VE\MAGIE1\MS0` | 1 × 10 | 74, 55 | Magier, Beschwörer |
| 5 | Magie2 | `BULLET\VE\MAGIE2\MS0` | 1 × 10 | 74, 57 | Mächtiger Magier, Gottesanbeter |
| 6 | MagieSa1 | `BULLET\VE\MAGIESA1\MS0` | 1 × 10 | 74, 54 | **unused** |
| 7 | MagieSa2 | `BULLET\VE\MAGIESA2\MS0` | 1 × 10 | 76, 54 | **unused** |
| 8 | Säure | `BULLET\VE\SAEURE\MS0` | 1 × 10 | 75, 54 | Spitpack acid |
| 9 | Feuer | `BULLET\VE\FEUER\MS0` | 1 × 10 | 75, 57 | Pyro fireball, Seepyro |
| 10 | Bogen | `BULLET\VE\BOGEN\MS0..7` | 8 × 1 | 49, 28 | the arrow: Amazon hunter, archers of Amazons and Pimmons, Drachofiterus |

Directional projectiles use slot = d (section 2, step 3), with the direction numbering of
`unit-motion.md` 1.1 (0 = up, clockwise). All main layers have speed −1; the speed does not
matter for projectiles because their frames follow the distance.

---

## 5. Arrival and impact effects (C, `00434840`)

When both remaining offsets reach 0 (or immediately, if S = A):

1. **Hit sound**: if the projectile record's +0x134 = 1 (all types 0..10) and the projectile is
   on screen, its sound (+0x08) plays at its screen position: 65 arrow/bolt/acid, 52
   Alchemie1/Magie1/Feuer, 53 Magie2, 18 Katapult.
2. **Impact effect**: if the record's +0x148 ≠ −1 and the projectile is on screen, an effect
   object of that type is created at the aim cell (x, y and the terrain height there), facing 0,
   action 0, frame 0. It plays its single slot **once**:
   - duration = frames × tick_ms × 10 / layer speed, i.e. it follows the game speed;
   - its event frame is the **last** frame; when the last frame is reached the event fires and
     the effect is removed in the same update (the last frame is barely visible);
   - at that removal the effect record's sound would play only if its +0x134 = 1; no effect
     record (11..19) has that, so **no effect makes a sound when it ends**. expl1/expl2 have no
     sound at all.

   | effect | sprite | frames | layer speed | duration at normal speed | used by |
   |---|---|---|---|---|---|
   | 17 expl1 | `BULLET\VE\EXPLOSION1\MS0` | 10 | 10 | 10 ticks ≈ 950 ms | Alchemie1, Katapult, Magie1, Feuer |
   | 18 expl2 | `BULLET\VE\EXPLOSION2\MS0` | 14 | 10 | 14 ticks ≈ 1330 ms | Magie2 |
   | 19 expl3 | `BULLET\VE\EXPLOSION3\MS0` | 14 | 10 | 14 ticks; sound 54 at its **start** (death effect, below) | bomb carriers dying (`combat.md` 6) |

   Arrows, bolts and acid (+0x148 = −1) leave nothing.
3. The projectile is removed.

A projectile that **leaves the screen** (drops out of the visible list) is removed at once,
without hit sound or effect. Death animations "Die" (types 11..13) are effect objects of the same
kind (default speed 7, so frames × 10/7 ticks).

**Death effects differ in one point: their sound plays when they are created**, not when they
end. When a drawn unit dies, the display creates the death effect (11 + race, or 19 for bomb
carriers) and immediately plays that effect record's sound (49/50/51, or 54) at the dead unit's
screen point; the effect then runs its frames silently and is removed at its last frame
(`combat.md` 6, "When the death sound plays"). Impact effects (17, 18) are not given this
start sound (and have no sound anyway).

---

## 6. Timeline of one shot (Amazon hunter, 5 cells straight, normal speed)

| time from the strike | simulation | display |
|---|---|---|
| tick 0 | strike: cooldown starts, impact scheduled at tick 14 | `ST` row starts: 12 frames, T = 12 × 10/7 ≈ 17.1 ticks |
| ≈ 10.9 ticks (frame 7) | | release: shooter sound 6, arrow sprite created at the bow (56 px up for facing 0) |
| + 355 ms ≈ 14.6 ticks | | arrow arrives at the hare's cell: hit sound 65, no explosion |
| tick 14 | impact: 70 % the hare dies (carcass, death cry 61) | |
| ≈ 17.1 ticks | | `ST` row ends; the hunter shows the standing pose (base action, frame 0) |
| 41..61 ticks | next strike allowed | |

The simulation's release time is rel × 10/7 ticks (frame start); the display reaches frame rel
slightly later, at rel × T/(frames − 1). Both are close enough that the arrow appears to leave
the bow at the twang.

---

## 7. Our client (deviations, `src/client/effects.ts`, `looks.ts`, `main.ts`)

1. **Arc instead of a straight line**: the drawn lift is 30 + sin(πk)·len·6 pixels, a parabola
   from a fixed 30 px. The original flies straight from the launch pixel (section 2.6) to the aim
   cell's ground point, height interpolated linearly (section 3).
2. **Launch point ignored**: the start is the shooter's cell plus 30 px. Needs the odb points
   per facing (and the outpost point for garrisons). The shot event has no facing or garrison
   information yet (`combat.md` 20.4).
3. **Direction table swapped** (x and y): `dirOf` maps (0, −1) to 1 and (−1, 0) to 7; the
   original's 1 is dx < 0, dy = 0. Arrow, bolt, flask and stone sprites are mirrored for every
   non-vertical flight. Use the sectors of `unit-motion.md` 1.2.
4. **Sound at launch**: `effects.ts` plays the projectile record sound when the flight starts. It
   is the hit sound and belongs at arrival (section 5.1).
5. **Frame by time** (0.7 frames per tick) instead of by distance flown (section 4).
6. **Impact effects too slow**: they use 0.7 frames per tick; their layer speed is 10, i.e.
   1 frame per tick. Also, the original removes the effect when its last frame is reached.
7. **Flight in ticks**: ours lasts f/100 ticks and so scales with the game speed; the original
   lasts f ms of wall time. At normal speed the difference is 5 %; at fast speeds the original's
   projectiles visibly lag the simulation. Either is acceptable for lockstep (display only);
   follow the original if fidelity at high speed matters.
8. **Strike animation loops** (`looks.ts`): every strike must play the `ST` row once and then
   show the standing pose; ours loops it for the whole fight (`combat.md` 20.6). As a result the
   projectile release no longer coincides with a visible draw of the bow.
9. **Visibility**: ours checks fog per cell; the original creates projectiles only when the
   target is on screen and removes them when they leave it. Not important for play; keep fog.
11. **Death sound timing** (fixed October 2026): ours played the `Die`/`expl3` record sound when
    the effect reached its last frame, about one animation length (≈ 1–1.5 s) after the poof
    started. It must play when the effect is created (section 5, last paragraph).
10. Correct already: projectile type per weapon (no remap), launch time = strike + rel × 10/7
    ticks, flight f = d64 × 1000 / speed, aim at the nearest footprint corner, impact effect type
    from the record, bomb and "Die" death effects.

---

*Status (client, October 2026):* items 1-8 are done in `src/client/effects.ts` and
`display.ts`: straight flight from the launch point (odb points, outpost point of the shooter's
garrison slot, objects.md 13.5, 22 px above the drawn unit as in the original) to the aim cell's ground point with linear height and
pixel offset, f ms of wall clock, `StepDisplay` for the ground offset (10 ms gate, frames by
distance), `dirToward` for the sprite, the hit sound and impact effect at arrival, effects at
their layer speed and removed at the last frame (their record sound plays then; the "Die"
animations too), projectiles removed when they leave the screen, released only when the aim cell
is on screen. The release comes when the shooter's strike row reaches its release frame,
computed from the shot's tick, the shooter's row and sound frame (rel × T / (frames − 1)) in
simulation time, not from the shooter's display event; an interrupted strike therefore still
releases its projectile at that time. Item 9 keeps the fog test as well.

## 8. Open points

1. The source of the anchor at sprite table +0x10/+0x14 (`0x4B3914`): taken to be the OD anchor
   (I). The examples in section 2 assume it.
2. Whether projectiles and the action clock pause while the game is paused (wall-clock timers;
   the pause path was not traced).
3. Gold `dvge.exe`: the display functions were not traced separately; the data is identical and
   the simulation side (job 0x2B, strike) matches *(uncertain for the display)*.
4. *(Resolved.)* Record sound n plays `Sfx_n.wav` (`unit-motion.md` 5).
