# World objects on screen: animation slots, layers, doors, random animations, placement preview, selection

Status: behaviour spec from AN.exe (GOG) with Gold (`dvge.exe`) differences noted. Addresses are
evidence only. Legend: **C** = confirmed by reading the code, **I** = inferred, **D** = checked
against the shipped data files, *(uncertain)* = not settled.

This document describes the **display side**: what the original draws for units, buildings and
nature objects, and when it changes. The simulation only sends messages (section 9). The display
decides frames, timing and the random "life" of the picture.

Related: `docs/formats/od-odb.md` (dv.OD container), `docs/formats/gd.md` (sprite pixels),
`docs/game/units-and-jobs.md` 4.4 (door queue), 9 (training), 8 (production), 10 (unit action
timing), `docs/game/fog-of-war.md` 5 and 6 (what is drawn and clickable), `docs/game/addon.md` 6.1
(fish). Border stones (town territory marks) are not objects; they are drawn as ground decals
between the terrain and the object list: see [territory.md](territory.md).
Garrison units drawn on top of outposts: section 13 (simulation side: `docs/game/combat.md` 9).

---

## 0. Summary (one mechanism behind items 1-4 and 6)

1. Every world object has a **display object**. The display object holds an **animation set**,
   one entry per slot (`action × 8 + direction`), built from `dv.OD`. Each entry is a list of
   **layers**. A layer is a sprite (`dv.gd` entry) plus a small **player**: base frame, speed in
   frames per second, mode bits, start time and a running flag (section 2).
2. Units and nature objects have one layer per slot. **Finished buildings have several layers.**
   Layer 0 is the building (`MS0`). The extra layers are patches that sit in **transparent holes
   of `MS0`**: the door (`DO0` or `DO`), "work" parts (`PE0`, clocks, wheels, cauldrons) and
   "random" parts (`RA0..RA3`, flags, laundry, smoke). Each layer carries a role flag in `dv.OD`
   (section 1).
3. **Every layer is always drawn.** A layer that is not running shows its current base frame. That
   is frame 0 until the layer has run once. A layer that ran and was stopped keeps the frame it
   had. Nothing is ever hidden: a missing layer leaves a visible hole in the building (section 3).
4. Layers start only when something tells them to (section 4):
   - **door**: when a unit goes in or comes out;
   - **work layers**: while the building is working. For training buildings this means while a
     unit is being trained. For production buildings it means while a production run is in
     progress. Service buildings run them from activation on;
   - **random layers**: one random layer plays once now and then (5 to 30 s apart, on screen
     only, active buildings only).
5. Layer timing is **real time** (milliseconds, fixed fps from `dv.OD`), not simulation ticks.
   The random choices use the C runtime `rand()`. That is the **same generator the simulation
   uses** (section 5.4).
6. The **placement preview** is a separate composite of the finished slot, with all layers at
   frame 0. It is not animated. It is recoloured to a single green (allowed) or red (forbidden)
   channel (section 6).
7. **Selection** draws no ring. The selected object's composite gets a **blue boost**. Clicking
   plays one global sample, `sfx_043.wav`. There are no per-unit voices (section 7).
8. Only drawn, living objects can be clicked, pixel-accurately. Gold excludes **fish** (group 6,
   types 41..45) from click and box selection. A fish rests as a dot and **leaps once** now and
   then (sections 8, 5.3).
9. **Draw order** is painter's order by anchor cell: rows of x + y from far to near, left to
   right within a row, no height term. Objects directly in front of a building's front face are
   drawn right after that building, so a unit at a door is always in front of it (section 12).

---

## 1. `dv.OD` animation descriptors, fully decoded (C, loader `0043c5b0`, `0043c2d0`)

An object record's slot value `s` points to a descriptor at `anim_base + s`
(`docs/formats/od-odb.md`). A descriptor has a 32-byte header followed by **layer records of 32
bytes**. The first layer record is the main sprite:

| offset | size | meaning |
|---|---|---|
| +0x00 | i32 × 4 | union rectangle of all layers (left, top, right, bottom), sprite canvas coordinates |
| +0x10 | u32 | **layer count** (1 for every unit, nature object, effect and construction sprite; 1..6 for finished buildings) |
| +0x14 | u32 × 3 | 0 |
| +0x20 + 32k | | layer record k (k = 0 .. count-1) |

Layer record:

| offset | size | meaning |
|---|---|---|
| +0x00 | i32 × 4 | layer rectangle (= the `dv.gd` entry rectangle) |
| +0x10 | i32 | **speed in frames per second**; -1 = default (7). Extra building layers: 7. Gold fish `ID0`: 5 |
| +0x14 | u32 | **flags** (below); 0 on the main layer |
| +0x18 | u32 | frame count |
| +0x1C | u32 | name number (the sprite's name in `dv.gd`) |

So the "name at descriptor +0x3C" of the old notes is the main layer's name. The speed at
descriptor +0x30 is the main layer's speed, which is -1 in almost every descriptor. This settles
`units-and-jobs.md` open point 2. The loader copies speed and flags into the runtime sprite entry
(sprite +0x18 and +0x1C), so they belong to the sprite, not to the object.

Layer flags (+0x14). The low bits double as playback mode (section 2):

| bit | meaning |
|---|---|
| 0x01 | ping-pong (forward, then back) |
| 0x02 | play once and hold the end frame |
| 0x04 | reverse |
| 0x08 | (runtime only: call back at the end; not set in the data) |
| 0x10 | **door** layer |
| 0x20 | **work** layer |
| 0x40 | **random** layer |

Values in the shipped data (GOG `dv.OD`, all races):

| value | bits | role | names | count |
|---|---|---|---|---|
| 18 | door + once | door | `DO0`, and **`DO` on the Amazon small and large house** | 67 |
| 32 | work | work layer, loops | `PE0` | 33 |
| 98 | work + random + once | work layer, plays once and holds (the work bit wins, see 4.2) | Amazon armoury `RA0` | 1 |
| 66 | random + once | random layer, plays once and holds the last frame | `RA0..RA2` | 11 |
| 67 | random + ping-pong + once | random layer, plays forward and back once and ends on frame 0 | `RA0..RA3` | 7 |

Layers appear in the record in this order: main, door, then the others (as stored). Layer order
is drawing order.

Object records of groups 3, 4 and 5 in `dv.OD` are the HUD mini icons (`BIAZ\MI\...`,
`BIPI\MI\...`, `BISA\MI\...`, one 45×45 sprite each), not colour variants.

### 1.1 Slots per kind (C, `00434450`)

The display object keeps a 40-entry table, index = `action × 8 + direction`:

- **OD kind 0** (units, nature, effects): the 40 slots as stored (5 actions × 8 directions).
- **OD kind 1** (buildings): slot 0 (`BU0`, construction) goes to index 0 (action 0). Slot 1
  (`MS0`, finished) goes to index 8 (action 1). Finished therefore means **action 1**. While the
  table is built, every layer of the building is sorted by its flags into three groups:
  - the door: one layer, the last one with 0x10;
  - the work list: all layers with 0x20;
  - the random list: all layers with 0x40 but not 0x20.
- **OD kind 2**: one slot.

The shown entry is `table[direction + action × 8]` (`00435030`). If that entry is empty, direction
0 of the same action is used. The action field is display object +0xE0 and the direction or stage
field is +0xDC.

Initial action of a new display object (`00433e10`), from the record's product (+0x11C):

| product | initial action | examples |
|---|---|---|
| 0 (raw material) | 1 (`ST`) | crops: growth stages |
| 1 (wood) | 4 (`CA`) | trees: standing tree |
| anything else, -1 | 0 (`MS`) | buildings (construction), stones, bushes, rubble, fish |

The messages in section 9 change the action and frame later.

---

## 2. The layer player (C, `004394f0`, `004395a0`, `004395c0`, `004395e0`)

Each layer of each slot has its own player:

| field | meaning |
|---|---|
| base frame | frame shown while not running; frame the run starts from |
| speed | frames per second |
| mode | bits 0x01 / 0x02 / 0x04 / 0x08 of section 1 |
| start time | wall clock in ms (`GetTickCount`) |
| running | flag |

A new player is **not running, base frame 0, speed 0, mode 0**.

**Start** (from frame b): base = b, running, start time = now. The caller sets speed and mode
first.

**Stop**: base = the frame currently shown, not running. The picture freezes where it is. It does
**not** reset to frame 0.

**Current frame** while running, with n = the sprite's frame count:

1. t = now - start time in ms; f = floor(t × speed / 1000) + base.
2. Ping-pong: the cycle length is L = 2n, otherwise L = n.
3. Not "once", or f < L: f = f mod L.
4. "Once" and f >= L: f = L - 1. If the callback bit is set, the callback runs once.
5. Reverse: f = L - 1 - f.
6. Ping-pong: if f >= n, then f = 2n - 1 - f.

Consequences:

- A "once" layer (random 66, door) **holds its last frame** after playing. The next start begins
  at its base frame again.
- A "ping-pong once" layer (random 67) plays 0 → n-1 → 0 and rests on frame 0.
- Speed 0 with "running" set shows the base frame forever. The main layer of every slot works
  this way, so the stage or frame is just the base frame.
- **Timing is wall clock.** It does not follow game speed. Whether it continues while the game is
  paused is *(uncertain)*, but nothing in the player looks at the pause state.

### 2.1 Composition and redraw (C, `004391a0`, `00438f40`, `00435850`, `004421b0`)

- A display object owns a private picture of its current slot. It is rebuilt (`00435850`) when
  any layer's current frame differs from the frame drawn last time, or when the selection flag
  changed (`004421b0`). This check runs every frame for every **drawn** object.
- Multi-layer composition: the main layer first, then each further layer in record order. **Each
  layer's whole rectangle is copied over what is below it**, including its transparent pixels.
  It is a copy, not a blend.
  - The artwork is built for this. `MS0` has transparent **holes** exactly under its layers'
    rectangles. The layer patches contain the building's own pixels around the moving part.
  - Example: `AZ\BU\WOHN\MS0` lacks the door area and the roof area that `DO` and `RA0` cover.
    `PI\BU\SCHULE\MS0` lacks the clock area of `PE0`. `SA\BU\VERPUPPUNGSSTAETTE\MS0` (Sajiki
    school) is an almost empty 9-pixel stub, and the whole building is its work layer `PE0`.
  - Drawing the layers with normal alpha blending gives the same picture **as long as every
    layer is drawn**.
- The picture is then scaled to the zoom, brightened by the cell light (`fog-of-war.md` 5.3) and,
  if selected, tinted (section 7.1). It is blitted with the normal sprite blend (section 6.2).

---

## 3. Which picture a building shows (C)

| building state | slot shown | door layer | work layers | random layers |
|---|---|---|---|---|
| construction site | `BU0` (action 0), frame = stage | - (`BU0` has no layers) | - | - |
| site completed by its builder (normal play) | **`MS0` at once**, no replay (message 7 sets action 1) | | | |
| town hall completed by its founder (job 0x0E) | on screen: `BU0` plays frames 0 → 9 once at 5 fps (2 s), then `MS0`; off screen: `MS0` at once (message 0x30) | | | |
| finished, not active (no operator yet, deactivated) | `MS0` | frame 0 (closed) unless a unit passes | frozen (frame 0 if never run) | none |
| active service building (class ≠ 5 and no product) | `MS0` | as 4.1 | **loop from activation** | 4.3 |
| active training building (class 5: school, barracks, mage tower, beast building) | `MS0` | as 4.1 | run **only while a unit is being trained** | 4.3 |
| active production building (product ≠ -1: farms, mine, armoury, luxury works) | `MS0` | as 4.1 | run **only during a production run** | 4.3 |
| destroyed | removed (death effect, `combat.md`) | | | |

There is **no damaged picture**: hit points do not change the sprite.

**Construction stage**: the site starts at `BU0` frame 0. Each display message 6 advances the
stage by one frame, wrapping modulo the frame count (`00455bb0`; sent by the builder,
`units-and-jobs.md` 6). The stage is a base frame with speed 0.

**Normal completion** (C, `004602d0`):
- When the builder finishes the last work tick, the simulation sets the building's base action
  to 1 and sends **message 7 "set action" with value 1** (`004125c0`).
- The display handler (`00455c90`) only sets the action and reselects the slot. The player sees
  the last construction stage replaced by the finished `MS0` in the same frame, with all layers
  at frame 0. There is no replay of the stages.
- Message 0x30 is **not** sent on this path. In GOG its only sender is the founding job
  (`00479380`), and `004602d0` skips the message-7 step for town halls.
- Advisor mentor#1 "Ein Gebäude ist fertig." is queued from the builder's step (`00475480`),
  see `docs/ui/side-panel.md` 1.1.

**Town hall founded by a founder** (message 0x30, `00456a40`, C):
- The town hall site is created instantly and never receives stage messages, so it stands at
  `BU0` frame 0 until the founder arrives (`units-and-jobs.md` 11). Then:
  - **if drawn**: an end callback is armed on `BU0`'s main layer, and the layer is started from
    frame 0 at 5 fps, mode "once + callback". The town hall "builds itself up" through its 10
    stages in 2 s of real time. At the end the callback switches to action 1 (`MS0`). If it
    leaves the screen first, the callback fires at once (`00445550`);
  - **not drawn**: action 1 at once.
- This is the only stage replay in the game.

---

## 4. Layer triggers

### 4.1 Doors (C)

Simulation side (building +0xAC = door counter):

- **Entering** (`units-and-jobs.md` 4.4): when the head of the door queue is admitted, the counter
  goes up by 1. When it goes **0 → 1**, message **0x2B "door open"** is sent (`00460e10`). This
  does not happen at construction sites or for builders, which do not enter.
  - When the unit has entered (`00460ed0`), the counter goes down by 1, and message **5
    "unit entered"** is sent with the unit.
  - If the enter job is destroyed while it held the door open, the counter goes down. At 0,
    message **0x2C "door close"** is sent (`00479f40`).
- **Leaving** (job 0x0D, first run 10 ticks after the eject): the counter goes up by 1 and on
  0 → 1 message 0x2B "door open" is sent (`0047a530`/`0047a980`; correction: an earlier version
  of this text said the counter was not touched). The unit is put outside 10, 15, 20 or 25 ticks
  later (message 0x64; `units-and-jobs.md` 4.10), and then the counter goes down by 1
  (`004613f0`).
- **Timing on entry**: the door-open message goes out when the unit is admitted; the unit
  disappears (message 5) **5 ticks later** if it already stands on the entrance, later if it
  still has to step onto it (`units-and-jobs.md` 4.10). So the door is about 5/7 open when the
  unit vanishes, and then closes from the fully open frame.

Display side. The door layer runs at its descriptor speed (7 fps):

| event | door layer |
|---|---|
| 0x2B open (`00436890`) | start from frame 0, mode "once": frames 0 → n-1, then **stays open** |
| 5 unit entered (`004351d0`) | **close**: start from frame 0 with mode "once + reverse": frames n-1 → 0, then stays closed |
| 0x64 unit placed outside (`00435410`) | close, same as above, on the building the unit left |
| 0x2C close (`004368c0`) | close, same as above |

- A close always starts from the **fully open** frame, even if the door had not finished
  opening.
- With 5-frame doors (most; Sajiki 3..4, a few 6 or 8), opening takes about 0.7 s of real time.
  The door then stays open until the unit is inside or outside. For a unit leaving, that is
  10 ticks, or more while the entrance is taken.
- Several units leaving one after another (births, collapse): the door opens once (counter
  0 → n), and **every** placement sends 0x64, so the door closes at the first placement and then
  jumps back to fully open and closes again at each further one, about every 5 ticks (quirk).
- Units inside a building are not drawn, so they cannot be clicked (section 8).

### 4.2 Work layers (C)

| message | handler | effect |
|---|---|---|
| 0x2D "work on" | `004368f0` | start every work layer from frame 0 with speed = layer speed (7) and mode = layer flags (32: loop; 98: once and hold) |
| 0x40 "work off" | `00436940` | stop every work layer (freeze) |
| 0x2E "activated" | `004366b0` | set the display's **active** flag (+0x1FD, also used for building vision, `fog-of-war.md`); **if** the building is not a training building (class ≠ 5) **and** has no product (+0x11C = -1), start every work layer as for 0x2D |
| 0x2F "deactivated" | `004367c0` | clear the active flag; stop every work layer |

Who sends 0x2D and 0x40:

- **Training** (`units-and-jobs.md` 9): 0x2D when a training run starts, which needs a unit
  inside and all goods present. 0x40 when the trained unit is finished, or when the training
  order job ends (`00475bb0`). So the school clock, the barracks flag and so on move **only
  while somebody is being trained**. Between runs they stay frozen.
- **Production** (`units-and-jobs.md` 8): 0x2D when the inputs are complete and consumed. 0x40
  when the unit is delivered (`00476380`), or when the order ends. Re-activation of a building
  whose production job still exists sends 0x2D at once (`0045fa40`).
- Service buildings (tavern, police, embassy, ...): their `PE0` loops for as long as the building
  is active.

### 4.3 Random layers (C, `00436260`)

See 5.1 for the timer. When it fires for a building:

1. Nothing happens unless the building is **active** (display +0x1FD).
2. If the building has random layers, one is chosen uniformly: `rand() mod count`.
3. The chosen layer starts from frame 0 with speed = layer speed (7) and mode = layer flags (66
   or 67).
4. If the building record has a sound (+0x08 ≠ 0), that sample (`sfx_<sound>.wav`) plays once,
   positioned in 3-D from the object's screen position (x and y relative to the view centre
   × 0.5, depth from zoom). Only if the object is drawn.

This is the **only** way a building plays its record sound: Amazon/Pimmon temple 28, Pimmon
mage tower 30. The record's sound frame (+0x04) is not used for buildings.
- *(I)*: the Amazon armoury's sound 19 never plays, because its only `RA0` is a work layer
  (flags 98), so its random list is empty.
- Buildings with random layers: Amazon alchemist hut (`RA0`, `RA1`), cocoa plantation, temple,
  confectionery, laboratory, watchtower, small house (laundry); Pimmon temple, mage tower,
  watchtower, distillery (`RA0..RA3`); Sajiki bank, laboratory, police station.

So an Amazon small house waves its laundry once on average every 17.5 s, only while on screen
and active. A temple rings at the same rate.

---

## 5. The display's own idle driver (C, `00436260`, called from `00445550`)

### 5.1 Timer

Every display object has an interval and a timer start:

- **Interval** = 5000 + `rand()` mod 25000 ms (5.0 .. 29.999 s, uniform). It is drawn when the
  display object is created (`00433e10`), after every firing, whenever the object leaves the
  screen, and whenever the timer is reset.
- **Timer start** = "not started" (-1) initially.

Once per redraw, for **every object in the drawn list** (on screen and visible under fog):

1. If the object is moving (screen offset not zero) or playing an action animation (+0x1F1):
   reset the timer (new interval, "not started").
2. Else, if not started: start = now.
3. Else, if now - start <= interval: nothing.
4. Else **fire**: draw a new interval, reset the timer (it restarts on the next redraw), and act
   by record kind:
   - kind 1 (building) and other kind-2 objects: 4.3;
   - kind 0 (unit): 5.2;
   - Gold, kind 2 types 41..45 (fish): 5.3.

Objects off screen never fire. Their timer is reset when they leave the drawn list. There is no
per-object phase beyond this random interval and the moment the object came into view.

### 5.2 Unit idle fidgets (C; answers `units-and-jobs.md` open point 7)

When a unit's timer fires:

1. Draw `rand()` mod 2. On 0: if the unit has an idle sprite `ID3`, use "idle facing 3". Else, if
   it has `ID5`, use "idle facing 5".
2. Otherwise (1, or no such sprite): "turn to direction `rand()` mod 8", no idle animation.
3. The choice is sent as **command 0x2A** through the client's outgoing command queue, the same
   queue as player orders.
4. The simulation runs it (`00452000`) only if the unit has no job. If the unit carries goods
   (+0x3C > 0), the idle animation part is dropped. The command creates job 0x1F (turn, then
   optionally action 3) with first run after 1 tick.

Gold excludes ship types 64..67 from fidgets.

### 5.3 Gold: fish leap (C, `dvge.exe` `0043a210`)

- A fish (group 6, types 41..45, `Addon.od` `RS\VE\FISHn`) rests on slot 0 `MS0`, a 3×3 sprite
  of 9 pixels: practically invisible.
- When its timer fires (5.1, on screen only), it plays its `ID0` row (action 3) **once** as an
  action animation:
  - start frame 0, no repeat;
  - duration = frames × tick_ms × 10 / speed, with speed = the `ID0` descriptor speed **5**. That
    is 2 ticks per frame: 12 ticks for the 6-frame fish 1..3, 18 for the 9-frame fish 4;
  - sound frame = record +0x04 (0). The fish records have no sound.
- At the end it returns to its base action 0 (`MS0`). The timer is held while the leap plays, so
  the next interval starts after the leap.
- A caught fish (`addon.md` 6.2) looks the same until it is removed.

### 5.4 Which random generator (C)

Every draw above, including the interval, the layer choice, the fidget choice and the direction,
uses the C runtime `rand()` (`004936b9`). That is the **one global generator the simulation also
uses** (`economy.md` 3.2). In the original, display randomness therefore perturbs the simulation
stream. It depends on what is on screen and on wall-clock time.

**Rebuild rule:** use a separate, non-deterministic **display RNG** for all of section 5 and for
4.3. The fidget (5.2) is a simulation effect. If we keep it, it must travel as a normal lockstep
command carrying its already-chosen parameters, so that every peer applies the same thing.

---

## 6. Placement preview ("ghost") (C, `00441c40`, class `00433020`, `00433160`, `00433330`)

### 6.1 Content

- When placement starts, a separate picture object is built from the **finished slot** (OD slot
  1, `MS0` with all its layers) of the chosen building type, using a **new set of layer
  players**.
- Those players are never started, so **every layer shows frame 0**: door closed, clock, wheel,
  flags, Sajiki pupation body and so on, all at their first frame. The parts that fill `MS0`'s
  holes are therefore **present**, but **not animated**.
- The picture is rebuilt only when the allowed/forbidden state flips or the zoom changes. There
  is no per-frame update for the ghost.
- *Note on the observation "the original animates the moving parts in the preview": not supported
  by the code (GOG and Gold are identical here). The visible difference to our build is that ours
  draws only `MS0`, so the preview has holes where the parts belong.*

### 6.2 Colour and blending

After composition, every pixel keeps only the **top 5 bits of its green channel**
(16-bit 5-6-5 framebuffer):

- **allowed**: those bits stay in green; red = blue = 0. The result is a green monochrome image
  of the building with its shading.
- **forbidden**: the same 5 bits move into **red**; green = blue = 0. The result is a red
  monochrome image.

8-bit equivalent: allowed (0, G, 0), forbidden (G, 0, 0), where G = the sprite's green value
rounded down to 5 bits. Alpha is unchanged.

The ghost uses the **normal sprite blit** (`00433330`):

- premultiplied colour;
- alpha quantised to 16 steps: alpha >= 240 is drawn opaque, alpha <= 15 is skipped;
- otherwise dest = dest × (256 - alpha)/256 (in 1/16 steps) + colour.

There is **no extra transparency**. Opaque parts of the building are opaque green or red; only
soft edges and the drop shadow are see-through. *(The impression of transparency comes from the
monochrome dark-green rendering. I)*

- Position: anchored like the real building at the hovered cell. Scale = current zoom.
- Validity: `fog-of-war.md` 6 (footprint grown by one cell, all cells currently visible, plus
  the type's placement mask).

---

## 7. Selection feedback

### 7.1 Highlight (C, `00435850`; Gold identical)

- **No ring, no box, no flashing.** A selected object has its flag +0x118 set. Its composite
  picture is recomputed (2.1) with a **blue boost** applied to every pixel whose alpha > 31:
  - blue₅' = ((alpha × 31 / 256, lowest bit cleared) + (blue₅, lowest bit cleared)) / 2
  - red and green are unchanged.

  In 8-bit terms this is B' ≈ (B + alpha) / 2 on premultiplied colour. An opaque pixel moves
  halfway to full blue in its blue channel only. Light and fog brightness are applied first.
- The tint is applied to **every selected object of every kind**: own units, a foreign unit,
  a building, a nature object. It is steady for as long as the object stays selected.
  Deselecting rebuilds the plain picture.

### 7.2 Sounds (C; samples indexed from the `sfx_%03d.wav` table, entry i = file i+1, `00486cc0`)

| action | sample | code |
|---|---|---|
| click, box or double-click that leaves a **non-empty** selection | `sfx_043.wav` | `004404a0`, `00440e40` |
| right-click on the ground with own units selected (move) | `sfx_057.wav` | `00441440` |
| right-click on the **minimap** with own units selected (move) | `sfx_057.wav`, the same sample, unpositioned | `0044db30` |
| right-click on an object with own units selected (order on target) | `sfx_058.wav` | `00441440` |
| recall a stored group (number key) | `sfx_068.wav` | `004418c0` |
| store a group (number key with modifier) | `sfx_069.wav` | `004418c0` |
| UI buttons (panel, menus) | `sfx_042.wav` on mouse down | `side-panel.md` 3.1 |

- The selection sound is the same for every object type and race. There are **no
  acknowledgement voices** per unit or per race.
- The Gold table is laid out the same way (Gold selection sample = entry 42 → `sfx_043`).
- `sfx_065..069` ship with the Gold data. Whether the GOG install has them was not checked
  *(uncertain)*. A missing file just stays silent.

---

## 8. What can be clicked (C, `004404a0` single click and box, `00440e40` double click)

Candidates:

- only objects in this frame's **drawn list** (on screen; fog rules of `fog-of-war.md` 5.2);
- only objects whose "alive/selectable" flag (+0x1FC) is set. It is set at creation and cleared
  when the object dies or is removed (`00434840`).

Units inside buildings are not drawn, so they cannot be clicked. Garrison units on an outpost
are drawn, but only as part of their building's entry (section 13); they are not entries of the
drawn list themselves, so they cannot be clicked or boxed either (C).

**Hit test**: a mouse-up whose drag rectangle is at most 3 px in both directions is a **click**.
A larger one is a **box**.

- Click: the rectangle is grown by 2 px on every side. An object is hit if any pixel of its
  current composite picture inside that rectangle has **alpha > 192**.
- Box: every object with such a pixel inside the box is hit.
- Pixel accuracy means the transparent holes and shadows of sprites do not count.

**Categories**, by record kind (+0xA4):

| category | members | max |
|---|---|---|
| own units | kind 0, owner = local player, not a criminal (type 12) | 12 |
| other units | kind 0, foreign, or own criminals (inspect only) | 1 |
| nature, not trees | kind 2 except class 8 (bushes, stones, crops, rubble, animals) | 1 |
| own building | kind 1, own | 1 |
| foreign building | kind 1, foreign | 1 |
| trees | kind 2, class 8 | 1 |

- **Order on overlap (C, `004404a0`, `00440e40`; Gold the same):**
  - The world frame draws the drawn list from head to tail, painter's style (`00443a10`). Each
    object is followed directly by its garrison units, and the placement ghost comes last. The
    list is built back to front by the depth sort in `00445e40` (rules in section 12). The **tail is the frontmost
    object**.
  - The click and box test walk the same list in **reverse**, from the tail to the head, so
    **front to back**.
  - **Within a category the frontmost hit wins.** On a click only the first hit per category
    counts. A porter standing in front of another unit is the one selected. In a box with more
    than 12 own units, the 12 frontmost are kept.
  - The double click also takes the frontmost unit under the cursor.
- **Across categories depth does not matter.** The priority below decides. An own unit standing
  behind a foreign unit or a building still wins.
- The new selection is the **first non-empty category in this priority**: own units, other
  units, nature (not trees), own building, foreign building, trees. A box over units and a
  building therefore selects the units.
- Shift or Ctrl keep the current selection of the same category and add to it. Ctrl on an object
  that is already selected removes it.
- **Double click** (within the system double-click time of the previous mouse-up): selects every
  own unit of the clicked unit's type (not criminals) within **radius 5 cells** of it that is
  drawn, up to 12. In detail (C, `00440e40`):
  - The second mouse-up runs this routine **instead of** the click routine. Without Shift/Ctrl
    it first empties every category (the first click's selection is dropped).
  - It walks the drawn list front to back and stops at the **first unit** (kind 0, any owner)
    whose picture is hit; buildings and nature in front of it are passed over. That unit U is
    added to "own units" only if it is own and not a criminal.
  - Then every drawn unit within 5 cells of U whose record **type number** equals U's, that is
    own and is not a criminal, is added (up to 12). The race is not compared, so a double click
    on a foreign porter selects the own porters standing around it (quirk).
  - A double click whose frontmost unit is a **criminal** therefore adds nothing: without
    Shift/Ctrl the selection ends **empty** (no click sound, empty side panel); with Shift/Ctrl
    the previous selection stays.
  - (I) When no unit is hit at all, the routine still compares types with the last object it
    looked at, which almost never matches, so a double click on a building or a tree normally
    also ends with an empty selection. *Our build keeps the single-click result in that case.*
- **Criminals** (type 12) of the local player are never commandable: inspect only, see
  `docs/game/combat.md` 12.6 for the full list (box, panel, right click, cursor, fog).
- **Gold:** kind 2 types **41..45 (fish)** are skipped in click and box selection
  (`dvge.exe` `004449e6` area). Fish can never be selected or inspected. Everything else is as in
  GOG.
- Right-click target search (`00441440`): section 8.1.

### 8.1 Right-click target (C, `00441440`; Gold the same)

A right-button release in the world view, while the current selection is a non-empty set of
own units (the "own units" category of section 8), picks a target as follows.

- **Only a click counts.** The press-to-release rectangle must be under 10 px in both
  directions; a larger right-drag issues nothing.
- **Same hit test as a left click**: candidates are the objects of this frame's drawn list
  whose alive flag (+0x1FC) is set. The press point's rectangle is grown by 2 px on every side,
  and an object is hit if any pixel of its **current composite picture** (all layers: body,
  roof, door, work and random layers alike, section 2.1) inside the rectangle has alpha > 192.
  There is **no footprint or ground-cell test** and no distance tolerance. A building is
  therefore hit anywhere on its visible sprite (walls, roof, chimney, door), and not on
  transparent gaps or on ground cells of its footprint that the sprite does not cover.
- **The door is not special.** The door is just a layer of the building's own picture, so a
  click on it hits the building exactly like a click on the wall.
- **Depth inside a category**: the drawn list is walked from head (back) to tail (front), and a
  later hit replaces an earlier one, so the **frontmost** hit of each category is kept.
- **Categories and priority** (record kind +0xA4; "own" = record race +0xA0 equal to the
  local player's race, i.e. own objects in practice):

  | priority | category |
  |---|---|
  | 1 | foreign unit (kind 0, other race) |
  | 2 | own unit (kind 0) |
  | 3 | nature, not a tree (kind 2, class ≠ 8: bushes, stones, crops, rubble, animals) |
  | 4 | foreign building (kind 1) |
  | 5 | own building (kind 1) |
  | 6 | tree (kind 2, class 8) |

  The first non-empty category gives the target. As with selection, depth across categories
  does not matter: a unit standing in front of or behind a building wins over it.
- **Result**:
  - a target was found → "order on target" command (0x15) with the target and a flag "target
    is own" (1 for own units and own buildings, else 0), sample `sfx_058` (7.2);
  - nothing was hit → "move" command (0x14) to the ground cell under the press point,
    sample `sfx_057`.
  Both samples play unpositioned (centre, full volume), once per command, not per unit.
- Whether the order is valid (enter which building, harvest, attack, …) is decided by the
  simulation, not here (`docs/game/units-and-jobs.md`, `combat.md` 2).

**Ours (deviation, kept on purpose):** a selected unit itself is not a candidate, so a
right-click on a building with a selected unit standing in front of its door still targets
the building. In the original that click would target the own unit.

**Minimap right-click** (`0044db30`): with own units selected, a right click on the minimap
issues the same "move" command (0x14) to the clicked cell and plays the same `sfx_057`
unpositioned, exactly like a move by right-click in the world view. It never targets an
object (`docs/ui/side-panel.md` 6.2).

---

## 9. Simulation → display messages used here (C, id table at `0x4AFCDC`)

| id | meaning on the display | handler |
|---|---|---|
| 5 | unit entered building: the unit is no longer drawn; the building's door closes; a garrison unit (flag 4) is attached to the building's garrison list instead (13.1) | `00455ad0` → `004351d0` |
| 6 | construction stage + 1 | `00455bb0` |
| 7 | set action (value): reselect the slot. Values 0 and 4 also become the base action. Building completion sends 1 | `00455c90` |
| 0x19 | start action animation (action, sound frame, repeat); also sets the remaining step offset to 0, so the object is drawn on its cell at once (`unit-motion.md` 3) | `00456490` |
| 0x26 | set the frame of the current slot (growth or depletion stage); ignored while an action plays | `004567d0` |
| 0x27 | stop action animation | `00456390` |
| 0x2A | (client → simulation) idle fidget command, 5.2 | `00452000` |
| 0x2B / 0x2C | door open / close | `004568a0` / `004568e0` |
| 0x2D / 0x40 | work layers on / off | `00456920` / `00456960` |
| 0x2E / 0x2F | building activated / deactivated | `004569a0` / `004569e0` |
| 0x30 | founded town hall finished: stage replay, section 3 (only the founding job sends it) | `00456a40` |
| 0x64 | unit placed on a cell (left a building); the door of the building it left closes; with flag 4 the unit is first removed from that building's garrison list (13.1) | `00455b30` → `00435410` |
| 0x1E | object died: removed from its cells and the drawn list; a unit spawns its death effect, a building nothing (`combat.md` 10.3) | `00456770` → `00434840` |
| 0x49 | building collapse starts: show `BU0` at stage k, and play `Sfx_053.wav` if drawn (`combat.md` 10.3) | `00457aa0` |
| 0x4A | collapse step: `BU0` stage − 1 | `00457c90` |

**Unit and nature pictures**, briefly (details in `units-and-jobs.md` 3.3, 7.4, 10):

- Walking units advance one frame of their walk row each time their on-screen offset changes by
  more than 3 px (`00442390`), so the walk cycle follows the distance moved.
- Action animations (0x19) are time-based: frames × tick_ms × 10 / speed.
- Nature stages are set by 0x26.

---

## 10. Differences to our current client (for the implementer, not code)

1. `looks.ts` loops `PE0`/`RA*` layers permanently and in phase for all buildings. It should:
   - keep them at frame 0, or frozen;
   - run work layers only per 4.2;
   - fire random layers per 4.3/5.1, with a display RNG, on screen only.
2. Layers must come from the OD layer list (section 1), not from name guessing.
   - The Amazon houses' door is named `AZ\BU\WOHN\DO` / `WOHNGROSS\DO`. Our name guess finds no
     door there, so a transparent hole is left where the door belongs.
   - Doors should follow 4.1 (open on 0x2B-equivalent events, close when the unit is in or out),
     at 7 fps real time.
3. Every layer must always be drawn. A layer that is missing or skipped shows as a hole. Example:
   the Sajiki school is entirely its `PE0`.
4. The preview should compose `MS0` with all layers at frame 0 and recolour as in 6.2. The
   original does not animate the preview.
5. Selection:
   - drop the ring and use the blue boost of 7.1;
   - play `sfx_043` on a non-empty selection, and `sfx_057`/`sfx_058` on orders;
   - use pixel-accurate picking with the category priority of section 8;
   - fish are not clickable.
6. Fish rest on `MS0` and leap once per random interval (5.3); they do not loop `ID0`.
7. Building sounds: play the record sound when a random layer fires (4.3), not on a frame of a
   loop.
8. *(Done October 2026.)* Doors (4.1, `units-and-jobs.md` 4.10): driven by the simulation's
   door-open / door-close ticks (`unit-motion.md` 7.4).
9. *(Done October 2026.)* Draw order: section 12.6.
10. *(Done October 2026.)* Collapse: `Sfx_053.wav` once when the collapse starts (`combat.md` 10.3.1).

---

## 11. Open points

- Whether layer animations and the idle timer run while the game is paused (real-time timers;
  the redraw loop was not traced against the pause flag).
- *(Resolved: section 13.)* Garrison units on outposts: the k-th unit's ground point is drawn at
  building-canvas pixel (points[k].x, points[k].y + 22), i.e. 22 px **below** the stored point;
  the sign is confirmed against the outpost sprites (13.2).
- The initial construction stage of sites created by map load with partial progress.
- Whether projectiles and effects can ever be clicked. They are kind 2 group 7 objects. They do
  enter the drawn list through the per-cell effect table (section 12.1, 12.4; *I* that this is
  the same list the click test walks); whether their selectable flag is set was not checked.

---

## 12. Draw order of world objects (C, frame builder `00445e40`, helpers `00445d60`, `00446c20`; frame `00443a10`)

Display only. Nothing here touches the simulation. Rules for units, buildings, construction
sites, nature objects (trees, bushes, stones, crops, rubble, animals) and effects.

### 12.1 Which objects take part, and at which cell

- The frame builder walks a screen-aligned grid of map cells that covers the view plus a margin.
  For every cell it reads the cell's **object index** (`fog-of-war.md` 1.1). An object is taken
  only at the cell that is its **anchor**, which is the cell whose flag 0x80 is set:
  - a unit: its cell. For a **walking** unit that is the **destination cell** of the current
    step, because the index moves at the start of the step (`unit-motion.md` 2.2). The unit is
    still drawn at its interpolated position;
  - a nature object: its cell;
  - a building or construction site: the footprint's **max corner**, its front corner on screen.
    Its other footprint cells hold its index too, but are never a draw position.
- A cell holds one index, so **only the object whose index is on a cell is drawn**. Units inside
  buildings (index removed on entry) and units born inside (never put on a cell) are not drawn
  (`units-and-jobs.md` 4.10).
- Fog decides per anchor whether the object is drawn (`fog-of-war.md` 5.2).
- **Effects** (projectiles, impacts, death animations) have no index. They are kept in a per-cell
  side table (cell flag 0x20, `00449550`/`00449710`) and are put into the list at their cell
  (12.4).

### 12.2 Base order

1. **Rows**: all cells with the same x + y form one row; on flat ground that is one screen line.
   Rows go from the smallest x + y (far, top of the screen) to the largest (near, bottom).
2. **Within a row**: left to right on screen, i.e. increasing y − x.
3. Earlier is drawn first (behind). Height, sprite size and object kind are **not** part of the
   key. No two objects share an anchor cell, so there are no ties.

### 12.3 Exception: objects in front of a building's face

For an object anchored at (x, y), the builder looks at the two cells directly behind it:
(x − 1, y) (screen up-right) and (x, y − 1) (screen up-left). A neighbour **counts** if it holds the
index of another object and is **not** that object's anchor. Only a building's (or site's)
footprint cells other than the front corner can count.

- Neither counts: base order.
- One counts: the object is **deferred and drawn right after that building** (after its
  garrison), whatever its row. Several objects deferred to one building keep their base order.
- Both count, for two different buildings: it goes with the building whose anchor has the larger
  x + y (the one drawn later); on equal sums, with the building at (x, y − 1).
- Exception: the (x, y − 1) neighbour is ignored when its building is the object drawn last in
  base order. That is the case for the cell right after the front corner in the same row. Such
  an object is drawn right after the building anyway.

For a building with anchor (X, Y) and footprint X − sx + 1 .. X by Y − sy + 1 .. Y this gives:

| cells | screen | drawn |
|---|---|---|
| (X + 1, y) for Y − sy + 1 ≤ y ≤ Y − 1 | in front of the +x face (bottom-left side) | **after** the building (deferred) |
| (x, Y + 1) for X − sx + 1 ≤ x ≤ X − 1 | in front of the +y face (bottom-right side) | **after** the building (deferred, or base order for x = X − 1) |
| (X + 1, Y), (X, Y + 1), (X + 1, Y + 1) and every later row | in front of the corner | after (base order) |
| cells beside the back faces, earlier rows | up-left / up-right of the building | **before** the building; its sprite may cover them |

So any unit on the ring cells along the two front faces is always drawn over the building. Every
**entrance cell** of the base game lies there (door offsets (−1, +1), (+1, −1), (−2, +1),
(+1, −2); `units-and-jobs.md` 4.10), so a unit at a door is always in front of the door
picture. The only exception is the watchtower (door (0, −1)): its entrance is behind the 1×1
tower, and a unit there is drawn before it.

Buildings never depend on anything (the cells behind their anchor are their own), so buildings
are ordered among themselves only by anchor row and column.

*(I by reading)* A deferred object is drawn only when its building is appended. If the
building's anchor is outside the scanned grid or not drawn, the deferred object is not drawn in
that frame either.

### 12.4 What a frame draws, in order (`00443a10`)

1. terrain;
2. town-border markers;
3. the object list of 12.2/12.3. Each building is followed at once by its garrison units
   (section 13). Effects are inserted in base order at their cell, after the object anchored on
   that cell, and are **never** deferred (an impact on a cell behind a building's front face is
   drawn before the building). An effect's cell is fixed when it is created: for a projectile
   and its impact explosion it is the **aim cell** (`projectiles.md` 1.1, 5.1), also while the
   projectile is still in the air. Aimed at a building's front corner (the usual case), both are
   drawn over the building;
4. the placement ghost (section 6).

The click and box tests walk the same list from the end (section 8).

### 12.5 Example: founding

The founder stands on the entrance (X − 1, Y + 1) of a Pimmon town hall (3×2, door (−1, +1)):
the same row as the hall's front corner, right after it. He is drawn after the site, and after
the finished hall. No part of the building is ever drawn over him. A porter waiting at
(X + 1, Y − 1), in front of the +x face, is scanned before the corner, deferred, and also drawn
after the hall.

### 12.6 Our build (implemented October 2026)

`src/client/draw-order.ts drawOrder` (pure, tested in `test/doors.test.ts`), used by
`src/client/main.ts sprites()`: anchor cells relative to the camera (no torus reordering), rows by
x + y, columns by y - x, the face exception, effects after the object on their cell. Selection
rings are drawn just before their object. Remaining difference: an object deferred to a building
that is not in this frame's list (off the scanned area or fogged) is drawn in base order instead
of not at all.

Former deviation, for reference: the client sorted by the drawn screen y plus a tiny id term; the
fix computes (row, column) from the simulation cell (destination for walkers), relative
to the camera so that the torus wrap does not reorder rows. Order by row, then column, then move
every object that meets 12.3 to directly after its building. No height term.

---

## 13. Garrison units on outposts (C, `004351d0`, `00435410`, `00435380`, `00445160`, `00443a10`; Gold identical)

Display only. The simulation side (who enters, targets, firing, leaving) is `docs/game/combat.md`
9; the per-slot points are odb +0x54.. (`docs/formats/odb.md`).

### 13.1 The garrison list

- Every building display object keeps a **garrison list** (display +0xAC, count +0xB4). A unit
  display object in it records its building (+0x200) and its **slot** (+0x204).
- Message 5 ("unit entered") with **flag 4**, which the simulation sends only for a class-2 unit
  entering an outpost (combat.md 9.2), appends the unit to the end of the list; its slot is the
  new list length − 1. The unit's index is taken off its cell as for any entering unit, so it
  leaves the drawn list (12.1). A unit already in another building's list is removed from that one
  first.
- **Quirk** (C by reading): if the outpost is **selected** when a garrison unit enters, it is
  removed from the current selection (its selected flag +0x118 is cleared). An open panel page of
  that outpost therefore loses its object. Not checked in game.
- Message 0x64 ("unit placed") with flag 4 removes the unit from its building's list and
  **renumbers** the remaining units 0, 1, 2... in list order.
- The eject itself sends nothing to the display. A unit that is sent out, or ejected by a collapse,
  stays drawn on the tower in its slot for the 20..35 ticks of its leave job and vanishes from the
  tower in the frame it appears at the door. Slots close up only then.
- So the slot order is the order of entering, as the simulation's occupant list, except that a
  unit on its way out still holds its slot here.

### 13.2 Where and how a garrison unit is drawn

Every frame, for each building in the drawn list, right after the building's own sprite (and its
layers) and before anything deferred to that building (12.3), each unit of its garrison list is
drawn in list order (slot 0 first):

- **Position**: the unit's sprite anchor (its feet) is put on the building's **sprite-canvas
  pixel (points[k].x, points[k].y + 22)**, k = slot. The building canvas is placed as always: its
  OD anchor on the screen point of the building's anchor cell. Both offsets are scaled by the
  zoom. Put differently, the feet are at screen point + (points[k].x − anchor.x,
  points[k].y + 22 − anchor.y) × zoom. The unit's own step offset and its stored cell play no
  part.
- **Sign, resolved** (D): composing each outpost's `MS0` with an archer whose feet sit 22 px
  below the point puts every archer on the platform or parapet floor of the tower; with 22 px
  above it they would float about 44 px over it. The +22 is therefore "lower on screen".
- **Picture**: the unit's normal display state. Its **direction** is its simulation facing: on
  entry the go-to facing (6, 2 or 3 by door, combat.md 9.2) or, for a map-load garrison, random;
  before each shot the strike turns it toward the target in 45° steps (combat.md 9.7), each step
  sending the facing message. Its **action**: the standing pose (base action walk, frame 0) while
  idle; the strike row `ST` once per shot (from the projectile message), then the standing pose
  again (`unit-motion.md` 3). The record sound plays at the sound frame as for any shooter.
- **Visibility**: the garrison's on-screen test uses the building's rectangle, and the units are
  drawn whenever their building is drawn. They have no fog test of their own (I: by the drawing
  path; the building is drawn under the fog rules of `fog-of-war.md` 5.2).
- **No idle fidgets**: the display's idle timer walks the drawn list (`00445550`), which holds the
  building, not its garrison (I by reading). Garrison units therefore only turn when they shoot.

Points (odb +0x54.., sprite-canvas pixels), the OD anchor, and the resulting feet position
relative to the anchor cell's ground point (x right, y up):

| outpost | OD anchor | slot 0 | slot 1 | slot 2 | further points |
|---|---|---|---|---|---|
| Amazon small (52) | 172, 207 | 155, 87: −17, 98 up | 201, 88: +29, 97 up | none | |
| Amazon large (53) | 173, 207 | 153, 35: −20, 150 up | 159, 60: −14, 125 up | 179, 67: +6, 118 up | |
| Pimmon small (52) | 177, 204 | 151, 97: −26, 85 up | 178, 114: +1, 68 up | 164, 118: −13, 64 up | 147, 98 and 199, 90 |
| Pimmon large (53) | 176, 205 | 216, 57: +40, 126 up | 137, 73: −39, 110 up | 151, 50: −25, 133 up | |
| Sajiki small (52) | 177, 206 | 176, 103: −1, 81 up | 152, 95: −25, 89 up | 174, 106: −3, 78 up | |
| Sajiki large (53) | 148, 214 | 176, 86: +28, 106 up | 147, 113: −1, 79 up | 208, 72: +60, 120 up | |

A slot without a stored point reads (0, 0): a unit there (an outpost filled beyond its capacity,
combat.md 9.1) is drawn with its feet at canvas pixel (0, 22), far up and left of the tower
(C by reading; not seen in game). The small Pimmon and Sajiki outposts have spare points for that
case, the Amazon small outpost has none.

### 13.3 Clicking

Garrison units cannot be clicked, boxed or double-clicked: the click and box tests walk only the
drawn list (section 8), and a garrison unit is not an entry of it (C). A click on the tower picks
the building. The player reaches the garrison only through the outpost's inhabitants page
(`docs/ui/side-panel.md` class 9).

### 13.4 Projectiles from the tower

The projectile starts at the outpost's cell with the launch offset outpost anchor − point[slot] +
shooter anchor − shooter point[d] (`docs/rendering/projectiles.md` 2.6). That offset lacks the
+22 of 13.2, so the shot leaves **22 px (× zoom) above** the drawn bow, hand or crossbow
(C by reading; a quirk of the original, barely visible).

### 13.5 Our client (implemented October 2026)

`src/client/garrison.ts` (`garrisonList`, `garrisonSlot`, `garrisonFeet`, `garrisonLaunch`),
`main.ts` (`sprites` → `garrison`), `effects.ts` (`launchOffset`); tests in
`test/garrison.test.ts`.

1. The garrison list is derived from the simulation: the class-2 units still inside the outpost
   (a unit on its way out stays inside until it is placed), in entry order. That is the list of
   13.1, slots closing up at placement. Each unit is drawn right after the building's own
   sprites in slot order (same draw-order group, before objects deferred to it), feet at canvas
   pixel (points[k].x, points[k].y + 22), with its own facing and action (`UnitDisplay`: standing
   pose, the strike row once per shot), dimmed with the building in explored fog. Garrison units
   are not in the drawn list: never clicked, boxed or double-clicked, and they get no idle
   fidgets.
2. The launch offset uses that slot; the 22 px launch quirk of 13.4 is kept.
3. The deselect quirk of 13.1 is not reproduced (not needed for play).

