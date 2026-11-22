# Fidelity audit 2026-11 (work list)

After the original function names were matched onto the PC executables (`game/original-names.md`),
six areas were audited against the exes: our specs (`docs/`) and our code (`src/`) were compared
with the original, function by function. This page is the consolidated work list. The detailed
findings (exact rules, constants, addresses) are in the private audit reports (`re/audit/*.md`,
ids below); each batch first turns its findings into specs here in `docs/`, then implements from
the specs (clean-room split as always). Severity: HIGH = visible in normal play or changes
outcomes, MED = noticeable in some situations, LOW = rare or cosmetic.

| area | checked | HIGH | MED | LOW | report |
|---|---|---|---|---|---|
| walking, pathfinding, logistics | 62 rules, 44 match | 2 | 6 | 7 (+2 unsettled) | movement |
| production, economy, nature | births, food, needs, research, finances, nature: match | 0 | 6 | 13 | economy |
| combat, crime, social jobs | police/criminal disputes settled (code right) | 1 | 12 | 26 | combat |
| computer players | 52 functions, 28 match | 0 | 6 | 10 | ai |
| towns, players, goals, commands | goals mostly exact, 77 of 79 advisor triggers | 2 | 7 | 12 | town |
| add-on (Gold) | about 45 behaviours, 27 match | 2 | 6 | 14 | addon |

Some findings appear in two reports (diplomat recall, repeated orders, scouts, store distance);
they are listed once below.

## Settled questions (no change needed)

- Police manual orders cycle through the town's criminals; a criminal pauses exactly 50 ticks
  (`status.md` §5 item 4, both disputes: the code is right, our build matches).
- AI-vs-AI raids wiping out computer towns when the human has no town hall: original.
- AI hunters use the harvest job with auto-continue, never the hunting-ground job: original.
- Jobs 0x01 (`TownFoodJob`) and 0x02 (`TownMotivateJob`) are implemented under other names and
  exact; births, food, needs and happiness, finances, research, nature respawn: exact.
- Add-on island labelling and island generator: match (SajikisAO 2 and 4 quirks are original).

## Policy decisions (vanilla copies the original, the fix becomes an enhanced option)

- AI porter-shortage bug (AI A5): the original's copy loop only works for the Amazons, so Pimmon
  and Sajiki computer towns stall after their first house. We apply the Amazon behaviour to all.
- Fishing-boat harvest bug (addon A2): vanilla gives the fixed fishing job; the original loops.

## Batches

**1. Pathfinding and movement core.**
- movement M1 (HIGH): the original planner (`AStarIdle`) is a two-way search with path and slope
  costs, a 100-iteration step per run, a 2000-iteration cap and up to 15 re-plans, and never a
  partial path. Ours is a one-way shortest path without terrain costs, so units ignore worn paths.
  Fully reproducible; spec in the report.
- movement M3 (HIGH): group move orders send the whole group to one shared cell as a normal walk.
- movement M2: slope class is asymmetric (any rise of 1..16 is class 1, a drop needs 16).
- movement M5, addon A7, AI walk items: legs of 24/32 cells and node budgets go once the original
  planner is in; ships cut diagonal corners like units (sea bodies must be 8-connected for that).
- movement M13, M16: re-plan limit order; planner latency (runs between ticks; model it as ending
  with the tick that started it).

**2. Game flow, towns and diplomacy.**
- town T1 (HIGH): multiplayer is won when every other nation is dead; mission goals are ignored in
  network games. Ours never declares a multiplayer win.
- town T7 = combat D1 (HIGH): recalling a diplomat cancels his errand, deactivating the embassy;
  with the last embassy all relations drop to 0 and his return triggers first contact (war).
- town T2: a nation is dead when its last living town is destroyed (not "no units and buildings").
- town T3: goals naming a missing city (or city 0) are false.
- town T4: units of a destroyed town move to the nearest town and are housed at once.
- town T8: town rename command (0x4B) is missing.
- town T9 = combat repeated-order finding: an ordered attack, heal, harvest or go-to already running
  on the same target is not restarted by another click.
- town T17 = movement M9: store choice measures from the building position, counts a town-hall
  site; no store without a town hall.

**3. Add-on.**
- addon A1 (HIGH): a transport admits a 6th passenger when six or more queue at once (capacity
  test is "occupants <= capacity" at entry); a 7th stays on shore without a job.
- addon A2 (HIGH, policy above): fishing-boat harvest bug in vanilla.
- addon A3: sail-to-coast with a coastal-water landing cell succeeds next to it and searches again.
- addon A4: unloading goes through the normal eject and leave job (retries every 50 ticks, idle
  ship sails to the coast); never onto the ship's water cell.
- addon A5 (fishing search inside the job constructors, RNG order), A6 (docking and launch hold
  the ship 35 ticks), A8 (the catch does not re-check the fish).

**4. Economy.**
- economy E1 (sapling growth = frame count of the tree's growth sprite x 599), E2 and E3 (farmer:
  crop type drawn by the farm operator, cell search ring 1 + a ring-2 corner, walks out and back
  when nothing fits), E6 (first training run 1 tick after the order), E7 (production orders ignore
  goods on the way, so over-order), E8 (construction stage starts at 0: about 10 % less HP per step).

**5. Combat and social jobs.**
- combat C1: line of fire uses a lagging stepper (lopsided reach, height loss along y, no shots
  across the map seam).
- combat: area scans find buildings through any footprint cell (help, retarget, guards, outposts,
  priests, AI); wounded auto-healing priest heals himself first; patrol button creates the guard at
  once and adds a point per click; map-load order records in file order (RNG from tick 0).
- combat D2: a diplomat's offer is decided when the host embassy ejects him (up to ~100 ticks).
- combat F1..F4 (traders): town and peace checks every run (war turns the merchant round), a failed
  leg flips the route, clicking a town redirects a running route.
- combat C4, C10: scout job exact (random map cells, square spiral, 1..5 tick pause).

**6. Computer players.**
- AI A1 (army cut keeps the last candidates), A2 (up to w more scouts every think), A3 (founding
  site search rings 1..9 + a ring-10 corner, as `naval.siteSearch`), A4 (intruder records per step
  and strike, 3 defenders per record), A5 (policy above), A6 (army keeps fighting within 40 cells of
  a fallen target town).

**7. Logistics details.**
- movement M4 (trade-route and errand trips ignore walk failure, enter from where they stand),
  M6 (a porter already carrying the needed good goes straight there), M7 (source pick-up rule),
  M8 (leisure uses the dispatcher's free-porter list), M10, M11 (advisor "no free porter" cases,
  trainee requests).

**8. LOW sweep and doc corrections.** All LOW findings of the reports, plus: `units-and-jobs.md`
3.1 table rewritten with the original classes (0x28 scout, 0x15 impact, 0x19, 0x25, 0x38 ...) and
§1.1 (the job wheel is LIFO); `combat.md` 10.4 (`0044fc20` only refreshes the panel); `economy.md`
§9 item 4 closed (the panel lowers the other slider); `addon.md` 5.4, 8.4, 9.2; stale lines in
`integration-addon-gameplay.md` §7.
