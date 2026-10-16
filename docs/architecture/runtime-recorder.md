# Runtime recorder and replay comparison (plan)

Status: plan, 2026-10-16. Open item 3 in `docs/status.md`. Goal: settle behaviour disputes (police/criminals,
AI raids, economy timing) by recording the **running original** and replaying the same inputs in
the rebuild, tick by tick, until the first divergence.

Addresses: GOG `AN.exe` v2.05 unless marked. Gold (`dvge.exe`) needs its own address map (M5).

## 1. Facts the design rests on (from the existing specs)

| fact | where | consequence |
|---|---|---|
| `rand()` is the statically linked MS CRT generator at `004936b9`, seed global `004b0700`; `srand` at `004936af`. 154 call sites | `economy.md` 3.2, `terrain-gen.md` | one inline hook sees every draw; the caller's return address identifies the site |
| One seed is shared by **all** code, display included | `economy.md` 3.2 | the raw value stream depends on how many frames were drawn. Comparing raw values against our simulation-only stream fails at once. Hence the "feed" mode in 4 |
| `srand` is called from 4 places (`0042d356`, `004494c8`, `00483f5a`, `00485780`), 3 of them with the clock (`004938d4`, likely `time()`) | asm | the recorder logs the seed, and can force a fixed one |
| The game advances one tick per scheduler poll when `GetTickCount` passed the interval, no catch-up | `economy.md` 1.1-1.2 | virtualising `GetTickCount` makes runs repeatable and lets us run fast |
| Scheduler: `DAT_004b3940`, tick processing in `00482ca0`, tick counter `DAT_004b3780`, 600-slot wheel, LIFO within a slot | `economy.md` 1.3 | tick boundaries and job order can be logged exactly |
| The earlier `an-patch` ddraw proxy (separate project) already loads into the GOG `AN.exe`; w64devkit has the x86 gcc/gdb | an-patch project | the recorder is an in-process DLL. No debugger is needed, because a breakpoint on rand() (thousands of calls per second) would be too slow |

## 2. Recorder (in the original)

A hook module built with the proxy (or loaded by it), configured in `an-patch.ini` `[record]`.
It patches 5-byte jumps at fixed addresses after checking the exe's bytes (refuses an unknown
build). Output: one binary `.anrec` file per run, in a private, git-ignored `rec/` folder.

Hooks:

1. **srand**: log the seed and the caller. Option `force_seed=N`.
2. **rand**: log `(tick, caller, seed before)`. The caller is classified as **sim** or
   **display** from a table of the 154 sites. The table is built once from the specs, which cite
   the addresses they were derived from; unknown sites are logged as such.
3. **Tick boundary**: around the tick processing in `00482ca0`, log the tick number and
   optionally every job run (job pointer, run-method address, returned delay). This gives the
   exact scheduler order.
4. **Commands**: the point where a player's command is executed (the command dispatcher, to be
   located; e.g. place-building 0x17 lands in `00451780`). Log tick, player, type and payload, and
   whether it ran before or after that tick's jobs.
5. **Clock**: optional virtual `GetTickCount`/`timeGetTime` (`004302d0`). Modes: real,
   fixed step per poll, or "N ticks as fast as possible".
6. **State dump** every tick (or every N): units (id, type, nation, cell, job/state, HP, load),
   buildings (type, HP, state, operator), towns (stock, money, happiness, population, criminals),
   scheduler slot occupancy. Use the record offsets already in `docs/formats/` and `docs/game/`.

## 3. Log format (neutral, ours)

`.anrec` = header (exe id, edition, mission/savegame, seeds) followed by tagged records
`TICK`, `RAND{site, kind, seed}`, `JOB{fn, delay}`, `CMD{player, type, bytes}`, `STATE{…}`. The
reader is a small TS module under `tools/`, so the harness never needs the exe.

## 4. Replay harness (in the rebuild)

- Every simulation draw in `src/` gets a call-site tag naming the original site it mirrors
  (82 draws today, `MsRand.next(tag)`; untagged = test failure in record mode). This is spec
  information (the docs already cite the sites), not code taken from the exe.
- Load the same mission (later: the same savegame), apply the recorded commands at the same
  tick and position, and run the RNG in one of two modes:
  - **feed**: each draw takes the next recorded **sim** value and checks that the site tag
    matches. The first mismatch is reported as tick, expected original site (and its spec
    section), our site, and the last N events of both sides. This removes the display-draw
    problem completely.
  - **free**: our own LCG, used once display draws are proven not to reach the simulation.
- **State diff** per dumped tick through a mapping layer (original fields to `World` fields).
  Report the first differing entity and field.
- Runs as a CLI (`node tools/replay.ts rec/foo.anrec`) and as an opt-in test when `rec/` exists.

## 5. Milestones

| | what | done when |
|---|---|---|
| M0 | Recorder smoke test: srand/rand counts and tick numbers from a mission start, overhead measured | log of 2 000 ticks of mission 0, game still smooth |
| M1 | Full RNG trace and command log; sim/display site table | every rand site in a 10-minute game classified |
| M2 | Tagged RNG in `src/`, feed-mode replay, first-divergence report | mission 0 with no input replays N ticks, or the first divergence is explained |
| M3 | State dumps and diff | per-tick unit/building/town diff on the M2 run |
| M4 | Dispute scenarios: police order on a criminal, criminal pause, AI raid with no human town hall (`status.md` open item 4); start from savegames | each dispute answered with a recording |
| M5 | Gold `dvge.exe` address map; island free play (`status.md` open item 5) | Gold recording replays |

## 6. Rules

- Recordings come from a locally installed copy of the game and stay private (`rec/` is git-ignored, never
  released). The recorder contains only our hook code and addresses, no game code.
- Findings go into `docs/` as prose. Fixes are implemented from `docs/` as usual. The harness
  compares behaviour only; it is not a source to copy from.
- Driving the original: a person plays the scenarios, or scripted ones are driven through the
  game window (screenshots and synthetic clicks).

## 7. M0 results (2026-10-16, GOG AN.exe, Amazon mission 1, no input)

Recording `anrec-20261016-033308.bin` (private). The hooks work, and the recorder spent 2.6 ms
in total inside them. The game was paused for most of the session, so only 32 ticks ran; a longer
unpaused run is still needed for the "2 000 ticks" goal.

- **Seed:** one `srand` at map setup, from `004494cd` (map setup `004494c0`), value 16092 in this
  run. The other three `srand` sites were not reached.
- **Tick rate:** 32 ticks in 3.48 s = 112 ms per tick (8.9 per second). That matches the
  `economy.md` 1.2 prediction for a 15.625 ms OS timer (109.4 ms plus frame time).
- **Draws outside ticks (map setup and display), 72 542:** terrain/map setup `004492d0`
  (65 536 = one per cell of a 256 × 256 grid), `00448a10` (842 × 3 and 256 × 4), `004494c0`
  (617 × 2 and 16), object constructor `00433e10` (1 831), populate `004638d0` (94), wander-job
  constructor `00474360` (94), `00448210` (110), `00448d90` (32), `00411200` (8 + 6), needs
  re-evaluation `0045a2c0` (3), and **display code**: unit idle timer `00436260` (17), world view
  `00443ee0` (1), `00445550` (1).
- **Draws inside ticks, 139 in 32 ticks (up to 9 per tick):** the animal wander job `004743b0`
  (113, sites `0047443c`, `0047445e`, `0047456a`, `0047459d`, `00474714`, `00474750`), the
  foundation/worn-path code `00448690` (23), `004813e0` (1) and `00483850` (2).

Consequences:

1. **Display code draws from the simulation's seed** (the unit idle timer at `00436260` alone drew
   17 times while the game was paused). The original's simulation stream therefore depends on how
   many frames were drawn and which units were on screen, so it cannot be reproduced bit for bit
   from the seed. This confirms the plan: the replay uses **feed mode** (4), and the site table must
   classify `00436260`, `00443ee0` and `00445550` as display.
2. The call-site list above is the first input for the site table (M1). `004813e0`, `00483850`,
   `004492d0`, `00448a10`, `004494c0` and `00448d90` are not yet described in the specs.

Start-up may need the recorder's `no_sound` and `skip_intro` switches, plus the proxy's GDI
present with `vsync = 0`, e.g. over Remote Desktop (`tools/recorder/README.md`).
