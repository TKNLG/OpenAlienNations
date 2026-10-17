# Simulation architecture (our design)

This file describes how *our* engine is built. Original-game behaviour is specified in
`docs/formats/` and `docs/game/`; this is the structure that implements it.

## Determinism rules

Every client runs the same simulation from the same inputs (lockstep), so the simulation must
produce bit-identical state everywhere:

- Integers only in simulation state. Positions are fixed-point: 1 cell = 256 sub-units.
- Randomness only from the world's own seeded generator, never `Math.random`.
- Iterate entities in id order; never depend on `Map`/`Set` insertion order of something that
  differs between clients, object identity, or time.
- No floating point in the simulation (`Math.sqrt`, trig, etc.), with one exception: the
  economy's accumulators are float32 like the original's (`Math.fround`, plain + - * /), because
  the original's rounding decides when food is eaten (docs/game/economy.md 8.2). IEEE float32
  arithmetic is exact and identical in every JS engine, so this stays deterministic. Rendering
  may use floats freely.
- The simulation never reads the clock. It advances in fixed **ticks**; the client decides when
  to run a tick.

## Ticks and commands

- `TICK_MS = 100` (10 ticks per second), the original's normal speed (its scheduler interval is
  95 ms, rounded up by the Windows timer; docs/game/economy.md 1.2). All durations are in ticks,
  so faster game speeds just shorten the tick (x2 = 50 ms, x4 = 25 ms).
- Periodic behaviour runs as **jobs** on a 600-slot timing wheel like the original's
  (`src/engine/scheduler.ts`): a job runs after a delay of 0..599 ticks and returns its next
  delay; jobs due in the same tick run last-scheduled-first. Jobs are plain data and part of the
  save game.
- Player input becomes **commands** (`{ tick, player, type, ... }`). A command scheduled for
  tick T is applied at the start of T, in (player, sequence) order.
- Single player: commands are scheduled for the next tick. Multiplayer: each client sends its
  commands for `T + delay` to the server, which relays them. Every client only runs tick T once
  it has every player's commands (possibly an empty list) for T.
- `World.hash()` returns a 32-bit FNV-1a hash of the full state. Clients exchange it every N ticks
  to detect desyncs early.

## World model

- Terrain: generated from the mission seed (terrain-gen.md), static apart from later changes.
- Passability grid (one byte per cell): water is blocked. Building footprints and every nature
  object block their cells. **Checked against the original**
  (`docs/game/units-and-jobs.md` 4.7): there, every nature object blocks its cell (bushes, crops,
  rubble, piles and animals included). Planned paths ignore units, but a step never enters a cell
  that holds another unit: an idle blocker is pushed aside, a moving one is waited for. Our
  engine does this (`src/engine/motion.ts`): every nature object, animals and carcasses included,
  is in the passability grid; units are in a separate unit-per-cell grid (see Movement).
- Entities: `id`, `kind` (unit, building, nature), object id (group << 16 | type), owner,
  position (fixed-point), facing (0..7, see below), current action, action timer.

## Movement

- 8-neighbour A* on the wrapping grid. Straight step cost 10, diagonal 14. Diagonal steps may
  cut corners: only the destination cell is tested, as in the original's planner and step
  (`units-and-jobs.md` 4.1 "Diagonal steps cut corners"; until October 2026 ours forbade a
  diagonal past a blocked orthogonal cell, which left cells next to stones and trees in dense
  nature unreachable and gatherers walking on the spot for ever). Ties are broken by insertion
  counter, so results are deterministic.
- Walking follows the original's follow-path job (`units-and-jobs.md` 4.1), run by
  `src/engine/motion.ts` from `World.step` for every entity whose `moveAt` tick has come:
  - a walk (`World.walk` / `setPath`) plans at once; its first step comes 3 ticks later (the
    planning delay), and never before the previous step's duration is over;
  - before each step one turn call (4.6): 45° is free, every further 45° costs
    max(1, step_time[0] div 4) ticks (1 for every base-game unit);
  - a **step moves the position to the destination cell at once** (positions are always cell
    centres) and the next run comes D ticks later: D = step_time of the height class (1.5x on a
    diagonal) + 1, or - 1 onto a path cell or when charging;
  - occupancy (4.7): a step never enters a cell with a building, nature object, water or another
    unit. An idle blocker gets a step-aside job (0x0F, a real scheduler job; chains of pushes), the
    walker polls every 5 ticks and then squeezes into the freed cell; a moving blocker is waited
    for (its step delay + 1); a busy or stuck one makes the walker re-plan (that one search treats
    the blocker's cell as blocked, our addition). Each plan raises a counter: the walk ends as
    arrived when the goal is no farther than the counter (arrival tolerance), and fails after 15;
  - the unit-per-cell grid is derived state: rebuilt from the entities at the start of every
    tick (the lowest id wins a shared cell) and kept current by the steps of that tick, so it is
    neither saved nor hashed;
  - jobs still poll `entity.path` (null = the walk is over) and read `entity.walkResult`
    (1 arrived, 2 stopped near by the tolerance, 3 failed). A tolerance stop near a door counts as
    arrived (entering has no distance test in the original).
- Work positions (4.8): go-to targets use the N, W, S, E chooser; harvesters work from any cell
  within one cell of the target (else the 0x3E spiral); hunters attack first (combat.md 14) and
  then go to the carcass; builders cycle the side midpoints with fixed facings; melee attackers
  walk to the nearest free cell next to their target (the firing-position search, combat.md 3.5).
- Entering and leaving buildings, births and trained units (`units-and-jobs.md` 4.10) are
  simulation: admission opens the door and the unit is taken inside 5 ticks later; an ejected
  unit's leave job opens the door after 10 ticks and puts it outside 10 ticks after that, only
  on an empty entrance (an idle unit there is pushed, anything else waited for in 5-tick polls,
  nearest free cell after three polls), facing 3 if door_dx < 0 else 5. Born units start inside
  and come out the same way. *Not yet implemented*: `logistics.leave()` places at once and may
  stack units on one cell.
- Idle fidgets are a lockstep command (`{ type: 'fidget', player, unit, dir, play }`,
  units-and-jobs.md 4.9) chosen by the client with a display RNG; animals idle through their own
  job with the simulation RNG (7.7).
- Facing comes from the step direction. **Corrected** (`docs/rendering/unit-motion.md` 1, checked
  against the code and the sprites): sprite directions count **clockwise** from "away from the
  camera" on screen: 0 up, 1 up-right, 2 right, 3 down-right, 4 down, 5 down-left, 6 left,
  7 up-left. In grid steps (dx, dy):
  (-1,-1)=0, (-1,0)=1, (-1,1)=2, (0,1)=3, (1,1)=4, (1,0)=5, (1,-1)=6, (0,-1)=7.
  The table formerly given here had x and y swapped, which mirrors every facing except 0 and 4.
  For longer deltas and for turning, see `units-and-jobs.md` 4.6.

## Display contract for movement

What the client reads from an `Entity` to draw units as the original does
(`docs/rendering/unit-motion.md` 2-4). None of it may feed back into the simulation.

| field | meaning |
|---|---|
| `x`, `y` | simulation position, always a cell centre (cell × 256 + 128). It changes at the **start** of a step |
| `stepFromX`, `stepFromY` | the previous cell centre of the last step, unwrapped so that `x - stepFromX` is the step's true delta (it may lie outside the map) |
| `stepStart` | tick the last step started (the step message) |
| `stepTicks` | that step's duration **D** in ticks; 0 = the unit was put down (leaving a building, launched, placed): no interpolation |
| `dir` | facing 0..7 (`path.ts DIR_STEP`): 0 up, clockwise on screen. It changes one 45° step per tick while turning, so every intermediate facing is visible; sprite slot = action × 8 + facing |
| `action`, `actionTick` | 0 walk, 4 carry: the base movement action (walk frames by distance). 1 strike: **one cycle** from `actionTick`, then the standing pose; the simulation does not reset it when the walk or the attack ends, so the strike plays to its sound frame. 2 work: loops until the action changes. 3 idle: standing |
| `idleTick`, `idleLoops` | idle animation (`ID` row, 3 or 5 or the facing 0 fallback): it plays when `action === 3 && idleTick === actionTick`, for `idleLoops + 1` cycles (0 for a fidget, 10 for animals). Any step clears `idleTick` |
| `path` | null when standing; a walk may hold an empty array while its last step is still under way |

Client rules (unit-motion.md 2.6):

- A new step is seen as `stepStart` changing (or `stepStart === tick` after a simulation tick).
  Interpolate from `stepFrom` to `x, y` over D × `TICK_MS` × 95 / 109.375 ms of wall clock (the
  original's per-cell pause), with the 10 ms gate, truncated 1/64-cell targets and the "more than
  3/64 cell" jump rule; advance the walk/carry frame by one per jump; keep the last walk frame when
  the unit stops. `TICK_MS` stays 100.
- Height: interpolate continuously between the two cells' heights.
- Action start (`unit-motion.md` 3): when a strike, work or idle animation starts (new `action` /
  `actionTick`), set the remaining step offset to 0. The unit is drawn on its cell from then on, as
  the original's action message does. Do not freeze a partly drawn step and release it in a jump
  after the action.
- The simulation changes `action` only where the original sends a message: a step (walk or carry),
  an action start, an explicit stop, the end of an action's cycles on the display. **Planning a
  walk must not change it** (`logistics.ts goCell` only plans; the first step sets walk or carry,
  `units-and-jobs.md` 7.3.9 item 9).
- Fidgets: per visible standing unit (not ships 64..67), a wall-clock timer of 5000 +
  rand() mod 25000 ms from a display RNG, reset while it moves or plays an action; on firing send
  `{ type: 'fidget', player, unit, dir, play }`: with probability ½ `dir` 3 and `play` if the
  sprite has `ID3`, else 5 if it has `ID5`; otherwise a random `dir` 0..7 without `play`. The
  simulation ignores it for a unit with a job or a walk, and drops `play` for a carrying unit.
- Status text: `hud-pages.ts jobText` reads the top-level job (arrest = T271 throughout).
- Draw order (`docs/rendering/objects.md` 12): by the simulation cell (`x`, `y`, i.e. the step's
  destination), rows of x + y, then y − x, no height term; a unit or nature object directly in
  front of a building's front face is drawn right after that building.
