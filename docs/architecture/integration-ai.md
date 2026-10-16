# Integrating the computer players (AI)

The computer players (spec: `docs/game/ai-diplomacy-trade.md` sections 1, 2, 3.5 and 4.6) live in
their own modules so they could be written while `world.ts`, `logistics.ts`, `main.ts` and the
client were being changed. This file lists every change the world, the test helper and the client
must make. The snippets below were applied to a copy of the tree and the whole suite passed
(27/27) with them, so they can be pasted as they are.

| file | what |
|---|---|
| `src/engine/ai-defs.ts` | constants shared by the AI modules: job kinds, group ids, unit/building type numbers, the ring walk |
| `src/engine/ai.ts` | `Ai`: setup, job dispatch, the per-player think job **0x30** (scouts, troop wants, army candidates, founding, attack decision, diplomacy 3.5), the army **0x35**, founding missions **0x36** (using `logistics.canFound` / `logistics.found`), the scouts' explore job **0x28**, strength (2.1), snapshot / restore / digest |
| `src/engine/ai-town.ts` | per computer town: planner **0x32** (building targets, build queue and placement, training needs and execution), economy **0x33** (gathering orders, free goods, sliders, research choice, gangs, market settings and merchants), military **0x34** (defence targets and group, response to intruders) |
| `test/ai.test.ts` | tests on Pimmons.mdb mission 4 and a 512 x 512 free-play world; they use `world.ai` when present, otherwise a job-dispatch shim |

The AI acts directly inside its scheduler jobs (no commands), so it runs identically on every
machine. It draws random numbers only from `world.rand`, iterates entities in id order and keeps
integer state only (the diplomacy weights are compared as exact integer ratios).

## 1. World (`src/engine/world.ts`)

```ts
import { Ai, isAiJob, aiConfig, type AiSnapshot } from './ai.ts';

export interface WorldSetup {
  ...
  /** per race and invention: prerequisite invention indices (DV.idb), for the computer players' research */
  prerequisites?: number[][][];
  /** false: no computer players run (tests that need a quiet world; network games, ai-diplomacy-trade.md 1.1) */
  ai?: boolean;
}

export interface WorldSnapshot { ...; ai?: AiSnapshot; }

  readonly ai: Ai;

  constructor(...) {
    ...
    this.diplomacy = new Diplomacy(this);
    this.ai = new Ai(this);
    ...
    if (setup) this.diplomacy.initRelations(setup.races);
    // computer players start after the map and the relations exist (ai-diplomacy-trade.md 1.1)
    if (setup && setup.ai !== false) this.ai.start(aiConfig(setup.races, setup.prerequisites));
  }
```

`aiConfig` reads `aiProfile` from the race blocks (`RaceSetup` in `mission.ts`; -1 = random,
drawn with `rand() % 3` in race order, 1.2). The point lists come from `world.lists` (forest,
stone, bush regions, start candidates), so maps and the free-play populator need nothing extra.
`start()` is idempotent: it creates a think job for every computer player that has none and the
three town jobs for every computer town with an active town hall. Towns placed by the populator
are map objects passed to the constructor, so they are covered.

Job dispatch in `step()`:

```ts
      : isDiplomacyJob(job.kind) ? this.diplomacy.runJob(job)
      : isAiJob(job.kind) ? this.ai.runJob(job)
      : this.economy.runJob(job)));
```

AI job kinds: 0x28, 0x30, 0x32..0x36. None is used by another module.

Snapshot, restore, hash:

```ts
  snapshot():  ..., trade: this.trade.snapshot(), diplomacy: this.diplomacy.snapshot(), ai: this.ai.snapshot(),
  restore():   w.trade.restore(snap.trade); w.diplomacy.restore(snap.diplomacy); w.ai.restore(snap.ai);
  hash():      this.diplomacy.digest(mix); this.ai.digest(mix);
```

`ai.digest` also mixes every unit's reservation group (`entity.group`), which `World.hash()` does
not. `restore(undefined)` (a save from before the AI existed) leaves the AI empty. Such a save
also has no AI jobs, so its computer players stay passive. To revive them, call
`w.ai.start(aiConfig(...))` after restoring. That draws one random number per random-profile
player, which is acceptable in single player. `SNAPSHOT_VERSION` can stay as it is because the
field is optional.

## 2. Test helper (`test/helpers/mission.ts`) and the existing tests

```ts
export function setupOf(m: Mission, data = DATA): WorldSetup {
  return {
    races: m.races,
    costs: RACE_DIRS.map(d => parseIdb(readFileSync(`${data}/${d}/DV.idb`)).map(i => i.cost)),
    prerequisites: RACE_DIRS.map(d => parseIdb(readFileSync(`${data}/${d}/DV.idb`)).map(i => i.prerequisites)),
    ...

/** `ai` false: the computer players stay passive (tests of single mechanics on missions with computer opponents) */
export function loadMission(mdb: string, order: number, data = DATA, ai = true): { world: World; mission: Mission } {
  ...
  return { world: new World(terrain, objects, rules, { ...setupOf(m, data), ai }), mission: m };
}
```

**Required:** once the World runs the AI, the computer opponents in Pimmons 4 and Pimmons 7 act.
They gather, build, declare war and attack, and that breaks four mechanics tests (combat
"hammer men demolish ...", trade "diplomat carries a peace offer ...", "a merchant runs a
route ...", "deterministic ..."). Those tests need a quiet world:

```ts
// test/combat.test.ts
  const { world: w, mission: m } = loadMission('Pimmons.mdb', 7, DATA, false);
// test/trade.test.ts (mission4)
  const { world: w } = loadMission('Pimmons.mdb', 4, DATA, false);
```

With these changes all 27 tests pass, including `test/ai.test.ts` running against the integrated
`world.ai`.

## 3. Client (`src/client/main.ts`, `src/client/data.ts`)

`data.ts` already loads the inventions; pass their prerequisites with the setup:

```ts
      : new World(terrain, objs, this.data.rules, { races, costs: this.data.researchCosts,
          prerequisites: this.data.inventions.map(l => l.map(i => i.prerequisites)),
          goals: m.goals, weapons: this.data.weapons, orders: extras?.orders ?? [], lists: extras?.lists,
          ai: !humans });
```

`ai: !humans` follows the original: there are no computer players in network games (1.1). In a
network game, `main.ts` currently marks every present race without a human as computer, and
those races then stay passive. If AI opponents are wanted in multiplayer, drop the flag. The AI
is deterministic and lockstep-safe. "The local human player" of the attack rules (2.4) is
replaced by the first human player in race order, which is the same on every machine (the
recommendation in 5).

Nothing else is needed in the HUD. AI towns show their normal panels, and acceptance flags and
offers go through `world.diplomacy`.

## 4. Hooks that are optional (the AI polls instead)

None of these is required. They would make the behaviour closer to the original's event-driven
code.

| original event | what the AI does now | hook if wanted |
|---|---|---|
| a unit steps into a computer town's area: recorded as an intruder (2.2) | military phase 1 scans for hostile units standing in the town's territory (`economy.md` 11), or units attacking an object of the town | none needed |
| a unit steps into a human town's area: town discovered (profile 2, 2.4) | the think job checks every 150 ticks (unit in the town's territory) | none needed |
| the laboratory becomes active: cursor reset and pick; a project completes: next topic (1.11) | the economy job checks every 50 ticks (`labSeen` flag, `t.research < 0`) | none needed |
| the town hall becomes active / inactive: town jobs start / stop (0045fa40, 0045ff30) | jobs stop by themselves when the town dies or its hall is inactive; the think job restarts them for any computer town with an active hall | none needed |
| `World.hash()` | the AI digest mixes `entity.group` | optionally add `mix(e.group)` to the entity loop in `hash()` |

## 5. Founding new towns (1.12)

The founding mission (0x36) uses the engine's founding (`units-and-jobs.md` 11). Sites are
tested with `logistics.canFound(race, x, y, true)` plus the AI's extra rule that the new town's
radius-25 disc (the territory disc it would claim, `economy.md` 11.3) stays clear of every territory. The run follows the order a..f of 1.12 (2026-10):
a founder inside a building or aboard a ship ends the mission and keeps group 54; a moved site
cancels the founder's job (and a ship request); once the founder is 8..15 cells from the site,
`logistics.found(founder, x, y)` creates the town and its town-hall site, and the founder's job
0x0E completes and enters it (births, goods); an idle founder elsewhere walks (in legs) to the
first cell of the 30-ring site search that is free land 8..15 cells from the site, or, in the
add-on, asks the naval planner for a ship when that cell is on another island. If `found`
refuses (the site was taken meanwhile), the mission looks for a new site on its next run. The new town's AI jobs are started by the think
job's fallback (`ensureTownJobs`) as soon as its town hall is active, at most 150 ticks later.
No hook in logistics is needed. If an immediate start is wanted, the engine's completion can call
`world.ai.startTown(t)` for computer towns.

## 6. What is implemented (spec map)

| spec | where |
|---|---|
| 0 group ids 50..54, the free-unit test | `Grp`; `Ai.free` = `Logistics.free` (idle outside or on a leisure visit) |
| 1.1 / 1.2 computer players, profiles, race multipliers, strategy table | `Ai.start`, `PROFILES`, `WEIGHT_FACTOR`, `COOLDOWN_FACTOR` |
| 1.3 planner phases, arrays A/B/C | `runPlanner`, `AiTown.A/B/C` |
| 1.4 building targets (N = 1..4, porter shortage, normal table, house rule, outposts, urgent need 1/30) | `buildTargets`, `houseWanted`, `urgentNeed` |
| 1.5 build queue (priorities, one per type, menu state 1, large-house substitution 2/3), anchors (outposts, watchtowers, warehouses from the forest/stone lists, outposts or centre + jitter, the outpost used rotated to the back of its own list), padding (mirrored: 1 cell on the maximum side), mountain and unit mask, padded corner blocks in the territory, ring search | `queueBuild`, `placeOne`, `Ai.list` / `Ai.moveToBack` |
| 1.6 essential workers per race (scholar substitute), want formula, unit priorities | `trainingNeeds` |
| 1.7 training execution (gate: a free group-0 porter and a non-empty porter gang; first non-site building of the list passing the order check, the request consumed even at 5 orders, the building moved to the back of its list; school flush) | `trainOne`, `flushSchools` |
| 1.10 porter gang (group 50; the only haulers of a computer town) | `porterGang`, `Logistics.haulGroup` |
| 1.8 gang sizes (released members go into the first school), gathering orders with the 20-cell search and region-point fallback, free goods incl. wood to iron | `gangs`, `resize`, `gather` |
| 1.9 sliders | `sliders` |
| 1.11 research cursor per race, overrides after a completion | `research` |
| 1.12 founding threshold / limit, founder want, mission, site rule, founding | `considerFounding`, `runFounding`, `siteValid` (via `logistics.canFound` / `found`) |
| 2.1 strength, army power | `strength`, `power` |
| 2.2 defence targets, budget, defence group with reserve (profile 0: 25 %, members and refill: units outside with any job), no outpost refill (dead branch), intruder records, response with every defender (3 per intruder, wrapping, most urgent bucket only), idle defenders walking back | `defenceTargets`, `record`, `respond`, `assignAttackers` |
| 0.1 / 2.3 think order (diplomacy, per town scouts / troops / candidates, attack or join, founding), scouts and explore job, offensive troop wants, army candidates (free group-0 hunters, then soldiers by type) | `runThink`, `scouts`, `runExplore`, `troopWants` |
| 2.4 attack decision per profile, joining (2.5 "Joining and moving": walk in beyond 20 cells; add-on: warships sail in, land units grouped by island, one ship request per group on another island, wait job 0x3E) | `considerAttack`, `joinArmy`, `sailToTown` |
| 2.5 army: relation check, tactic 0 (assault: bucket 0 only = the first building of the important list, the target town's outposts and the target race's class-0 units in the circle; candidate town halls set aside under 10 members, the important one never; retreat at 2x power; 6 per target, wrapping; re-assign when the running target's class exceeds the bucket's, or equals it and rand() mod 10 = 0), tactic 1 (skirmish: fighters, else other units; 3 per target, wrapping; re-assign only in bucket 0 from class > 0, no draw), refused attacks counted, random tactic per run, end and walk home | `runArmy`, `assignArmy`, `endArmy` |
| 3.5 acceptance flags every think, offers (6001 ticks, 1/15, state differs, not 0, first town's embassy with the diplomat at home) | `Ai.diplomacy` via `diplomacy.setAccept` / `diplomacy.offer` |
| 4.6 market settings, partners with the flag test, merchant want, merchant routes | `markets` via `trade.computerSettings`, `trade.partners(t, true)`, `trade.startRoute`, `trade.routeOf` |

## 7. Deviations / gaps

Choices made where the spec is uncertain or our engine differs, so that the AI runs its economy
sensibly:

1. **Porter gang (group 50, 1.10)**: formed as in the original since the 2026-10 audit (7a B).
   The dispatcher's transport part (lists 0..3) and the leisure job use the town's
   `logistics.haulGroup(t)`: 50 in a town of a running computer player, else 0; worker requests
   (operators, builders, trainees) always take free group-0 units. The training gate, bush
   porters and the school flush follow 1.7 / 1.8. A small town whose porters are all in the gang
   and the bush gang (e.g. 3 porters: gang 2, bush 1) cannot train until births add porters, as
   in the original.
2. **Porter-shortage targets (1.4)** are applied to every race. The original's copy loop only
   works for the Amazons (indexing bug), which would leave Pimmon and Sajiki towns building
   nothing but a house.
3. **Placement (1.5, 7 item 2):** candidate cells are our building anchors (footprint at
   x - sizeX + 1 .. x). The padded rectangle has a 1-cell margin left and top and 1..3 cells
   right and bottom. Every padded cell must be free and not a mountain (except mine and outposts);
   for buildings with mask flag 0x800 (not the mine, harbour, shipyard) the anchor and the four
   corners of the padded rectangle must lie in the town's own territory, and then
   `logistics.canPlace` (which adds the four-corner-block test of `economy.md` 11.7) must accept
   the position. Rings have half-size 0 .. radius / 2. Explicit anchors (outposts, watchtowers,
   warehouses) are computed when the request is queued (`anchor`), the outpost / tower sign drawn
   before the menu-state and "already queued" tests. Snapping (spec 1.5, `snap`) moves every
   anchor, inside or outside the territory, to the nearest of its border blocks (the stone cell;
   the first in border order on ties; no territory: (-1, -1) wrapped). A warehouse anchor from
   an empty region list is cell (0, 0) before snapping (7b item S, fixed).
4. **Town area** is the territory of `economy.md` 11 (`src/engine/territory.ts`): town hall and
   completed outposts, first come first served. The outpost rule compares 4 x the record's block
   count (1,492 for a lone town hall), including the original's count inflation on every
   destruction of a building of the town (11.5; `WorldSetup.fidelity.territoryCountQuirk = false`
   recounts instead).
5. **Outpost garrisons** (1.7 third bullet, 2.2, `combat.md` 9.2): a completed
   outpost of a computer town files one worker request for an archer (29) per garrison place
   (`logistics.complete`), as in the original. The military job's refill is dead code in the
   original and is not implemented (fixed in the audit, 7a E).
6. **Scouts:** only the wanted number (C[24]) explores. Further scouts stay free, so the
   dispatcher can send them to watchtowers, whose operator is the scout. The explore job walks in
   legs of at most 24 cells towards its random target, and a new target is picked after 40 legs.
   The original sends up to C[24] more idle scouts every think, so in the long run every idle
   scout explores (spec 2.3).
7. **Long walks** (army members, founders, released units, returning defenders) go in legs of at
   most 32 cells per axis with small path searches, re-issued by the running job. Long A*
   searches for armies were the AI's main cost.
8. **Founding** (1.12): the site test is the engine's `canFound(..., territory = true)` (the four
   points outside every territory) and the disc of the town hall's radius (25: 373 blocks)
   around the site free of every territory. Sites are searched in rings of step 2 up to 20 cells around each start candidate in
   file order. A `noSite` flag stops further missions once no site is left.
9. **Army target classes** (object +0x20, 7 item 1) use `combat.tier()` (0 fighters / outposts,
   1 military buildings and civilians, 2 the rest). The assault attacks bucket 0 only, six per
   target, the keep rule compares with the bucket (7b O..R). Members without an attack job
   follow spec 2.5 step 6: one with another job (walking, waiting for or walking to a ship) is
   taken only within 40 cells of the target point or inside the target town's territory; an
   idle one far from both walks on in legs of 32 cells first (7b T, cost); warships are taken
   wherever they are; members inside a building other than a transport are skipped (the
   original hands them the attack through `00465650`, which sends them out first; rare).
10. **Ending armies:** as specified, tactic 1 finds only units outside buildings, and an army with
    no target "ends as a success". Against a town whose people are indoors, armies therefore end
    and are re-created often (each think). Kept as in the spec.
11. **Profiles 0 and 1 attack other computer players** (the spec's confirmed quirk in 2.4).
    In free play an aggressive AI therefore often wipes out the other AI early. Kept.
12. **Released units**: gang members released by a resize get a go-into job (delay 1, no rand())
    to the first school of the town's list, as specified (1.8, I). Our engine's "unit entered"
    handler (`units-and-jobs.md` 4.4) lets a non-porter come out again at once, so a released
    woodcutter ends up standing at the school door. Army members, founders and merchants
    released elsewhere walk home as before.
13. **Research "started"** means progress > 0 or currently selected by a town of the race.
14. **The human for 2.4** is the first human player in race order (deterministic in
    multiplayer). No human: no attacks.
15. **Housing H (1.4)** counts the type lists, sites included, as in the original (fixed in the
    audit, 7a I). "Current count" targets count sites too.
16. **Gangs of hunters:** hunters appear in three wants (economy A, defence B, offence C).
    Each gang fills from free units only, so they never steal from each other.
17. **Economy balance (observation, not a deviation):** AI growth is limited by wood. Gang sizes
    are small (Amazons 2 to 4 woodcutters), our harvest job carries one unit per trip, and the
    AI's wood-to-iron conversion (1.8, 9/10 every 150 ticks while iron has room) spends 2 wood
    each time. Large AI towns plateau with full stone and iron stocks and no wood for new
    buildings. If that is too weak in play, the cheapest lever is the conversion threshold,
    which is spec behaviour, so it is left unchanged here.
18. Not implemented: the job +0x34 flag (7 item 10, never read). Mentor lines are not used,
    because computer players have no advisor.
19. **Intruder records (2.2)**: the original records a unit on the town's military job when it
    steps into the area. Ours polls in every military run (every 50 ticks, also in idle runs):
    units of other races standing in the territory are added to `AiTown.intruders` (saved). The
    response then applies the spec's keep test to the records. Strikes also record the striker (`Ai.alert`, the alert of `combat.md` 7 step 1), also when it
    stands outside the territory (7c).
20. **Defenders walking back (2.2)**: the three rand() draws per defender are made (x, y, delay),
    but the walk starts at once (our engine has no walk job 0x06 with a delay).
21. **List order** (`Ai.list`): the original's per-type town lists change order when the AI moves
    a building to the back (training round robin, outpost anchors). `AiTown.moved` keeps an order
    key per moved building; every "first building of a type" read by the AI (trainable, training
    step, school, first mine, embassy, the army's important buildings) uses that order. The
    engine's own code keeps creation order.
22. **Founding search details (1.12)**: the candidate search around each start candidate walks
    rings 0, 2, 4 .. 20 (the original's site search with radius 20 walks rings 1..9 and the corner
    of ring 10, `world-populate.md` 2.3); a mission that finds no site at all releases its
    founder (group 0) and marks the player as having no site, where the original ends with the
    founder left in group 54. The approach cell (step f) uses the exact ring walk.
23. **Add-on navy (section 9)**: see `integration-addon-gameplay.md` 7 "Computer players" for
    what was fixed in the 2026-10 audit and what still differs.

## 7a. Audit against the original (2026-10): our build versus spec, ordered by impact

The spec's second pass (`ai-diplomacy-trade.md` status line, 0.1, 1.15, 2.6) was compared with
`ai.ts`, `ai-town.ts` and the engine paths they call. Items 1..18 of section 7 still apply; the
list below adds what the audit found, most important first.

**What the free-play reports are.** A free-play run of our build (seeds 1..6, each race as the
human, 30,000 ticks, the human passive) reproduces the reported "Amazon town with houses, no
school, no woodcutter, no builder". In every such case the town had been raided by the **other
computer player**: profile 0 / 1 send single free hunters from about tick 6,000 (P 11..13) to the
first other living player in race order (spec 2.6; e.g. Sajiki raid Amazons when the human is a
Pimmon), the raid kills builders and gatherers outside, the assault tactic attacks the school
first, and the town then sits in the dead end of spec 1.15 forever. When the human owns a town,
the raids go to the human instead (Amazons and Pimmons are first in race order for each other),
and in those runs no computer town ended in the dead end. The raid timing and targets are
original behaviour; what makes our victims worse off than the original's are items A..D below.

| # | deviation | where | impact | status |
|---|---|---|---|---|
| A | **Pending training counts are not cleared when a training building is lost.** `combat.collapse` cancels the training job but leaves `b.queue` and `t.pending`. The original's job destructor lowers the pending count for every queued order (spec 1.15, `units-and-jobs.md` 9). With stale counts the AI believes builders / woodcutters are on their way: the essential-worker rule (1.6) never re-requests them, want(t) is too low, and the site gate "sites <= builders + queued builders" admits sites nobody will build. Seen in the runs as `pending[11] = 1..2` with no school and no builder. | engine (`combat.ts` collapse / `logistics.ts`), read by `ai-town.ts` | high: blocks recovery after a raid; also hides lost barracks orders | **fixed**: `logistics.dropTraining` (called from `combat.collapse` and `World.destroyBuilding`, i.e. every removal path) lowers the pending count per queued order, no refund |
| B | **Training gate starves because every porter hauls.** In the original only the porter gang (2..10, group 50) hauls in a computer town; the other porters stay idle (or visit) and are the trainees, so the gate "at least one free porter" of 1.7 is normally open. Ours has no gang (section 7 item 1): all group-0 porters haul, and an idle porter exists only when there is no hauling work. In the runs a growing town showed 0 idle of 11 porters at consecutive samples 1,000 ticks apart (the rest hauling or standing in the school as trainees), and no order can be placed while that lasts; the house rule (free share < 5 %) meanwhile keeps asking for houses. Related: `Ai.free` ("group 0, no job, outside") also misses leisure visitors, which the original counts as free (spec section 0); none were seen in AI towns in the runs | `ai-town.ts` census / `trainOne`, `ai.ts` `free` | high: slows every AI economy and tilts it towards houses | **fixed**: the porter gang (1.10) is formed every 100 ticks (`porterGang`) and is the only hauling group of a computer town (`haulGroup`); the gate is "a free group-0 porter and a non-empty gang"; `Ai.free` = `Logistics.free` (idle outside, or on a leisure visit unless inside with a job; the dispatcher uses the same test); the hauling-reserve workaround is gone |
| C | **Defence response uses at most 3 defenders per intruder** and stops when every intruder has 3; the original assigns **every** defender, 3 per intruder in turn with wrap-around, and only against the most urgent class bucket (spec 2.2). Ours leaves defenders idle while a single raider kills workers | `ai-town.ts` `respond` | medium-high: victims defend with 3 instead of all hunters / soldiers | **fixed**: `respond` + `assignAttackers` (defenders by type: group 52 outside, then free group 0; only the most urgent bucket) |
| D | **Army assignment caps** (5 - tier, or 3) without wrap-around; the original wraps, so every member attacks; equal-class targets are kept always (original: re-targeted with chance 1/10) | `ai.ts` `runArmy` | medium: our raids use only part of the army | **fixed**: `runArmy` + `assignAttackers` (cap per target, wrap; equal class kept unless rand() mod 10 = 0; tactic 1 the same with cap 3, I) |
| E | Outpost refill from the defence group (section 7 item 5): the original's branch is dead | `ai-town.ts` `defenceTargets` | medium: ours pulls defence archers into outposts | **fixed**: refill removed |
| F | Army candidates include group-0 hunters / soldiers **with a job** (outside); the original takes only free ones (idle or visiting). Defence group refill takes only idle units; the original takes group-0 units outside with any job | `ai.ts` `runThink`, `ai-town.ts` `defenceTargets` | low-medium | **fixed**: candidates = free group-0 hunters, then soldiers 29..36 by type; defence group members and refill = units outside with any job |
| G | Think order: ours runs the strategy (troops, candidates, founding, attack) **then** diplomacy, and founding **before** the attack decision; the original runs diplomacy first and founding last (spec 0.1). Changes rand() order and which offer goes out first | `ai.ts` `runThink` | low (bit-exactness) | **fixed**: diplomacy, then per town (reserve, scouts for 0/1/2/4, troops and candidates for 0/1/2/3/5), then attack or join (not 4), then founding |
| H | rand() order at army creation: ours draws the first-run delay before the tactic; profile 3 lacks the mod-1 gate draw; profiles 3 and 5 test hostility before the cut (original after) | `ai.ts` `considerAttack` | low (bit-exactness) | **fixed**: profile 3 draws mod 1, then the cut; profile 5 the cut; both before the hostility test; then the town index, the tactic (rand() & 1), the first run (rand() mod 50) |
| I | House rule: stock test `stock >= capacity - 20` (original: free space <= 19); H from completed houses only (original: lists incl. sites); urgent need = first open need with threshold <= P (original: first list entry, threshold < P); its rand() is drawn after the all-active test (original before) | `ai-town.ts` `buildTargets` | low | **fixed**: `houseWanted` (free space <= 19, H from the type lists, integer shares), `urgentNeed` (first entry of the open-need set, threshold < P; rand() drawn before the all-active test) |
| J | Placement: our padded rectangle has its 1-cell margin on the minimum side and 1..3 on the maximum side (original mirrored, spec 1.5 step 6); units do not block (original mask has 0x02); outpost anchors use completed outposts only and one shared rotation counter (original: lists incl. sites, rotated separately) | `ai-town.ts` `placeOne` | low (look of AI towns, rand order) | **fixed**: Q = the padded rectangle's maximum corner, building anchor Q - 1 (also the add-on shore test); the padded rectangle's corner blocks in the territory (`territory.inTown` with the padded sizes) plus `canPlace`; units block (`motion.free`); outpost anchors from the lists incl. sites, each list rotated separately (`Ai.list` / `moveToBack`) |
| K | Training step skips buildings with 5 orders; the original consumes the request there (spec 1.7) | `ai-town.ts` `trainOne` | low | **fixed**: the first non-site building passing the order check takes the order (refused silently at 5 orders, request consumed) and goes to the back of its list |
| L | `trainable()` takes the first **complete** training building; the original the first in the list, which must be active (a site there fails) | `ai.ts` `trainable` | low | **fixed**: `trainable` reads the first building of the list (sites included), which must be active |
| M | Military job advances its phase even in runs where the town has no barracks / soldiers / hunters (original only in active runs) | `ai-town.ts` `runMilitary` | low | **fixed**: `runMilitary` advances the phase only after the activity test |
| N | Released gatherers walk to the town centre; the original sends them into the first school (spec 1.8, section 7 item 12) | `ai-town.ts` `resize` | low | **fixed** as specified (I): go-into job to the first school; see section 7 item 12 for what our engine does at the door |

**Status after the fixes (2026-10).** Every item A..N is implemented as the spec says (table).
The same 27 free-play runs (seeds 1..6 with no human town hall, seeds 1..3 with the human's
town hall, each race as the passive human, 30,000 ticks), 54 computer start towns:

| | before | after (AI fixes only) | after + the engine's walk / transport changes of the same week |
|---|---|---|---|
| towns stuck at tick 30,000 | 13 (12 in the dead end of 1.15, 1 flat) | 9 (8 dead end, 1 flat) | 14 (13 dead end, 1 flat) |
| stale pending builder orders in dead-end towns | 8 of 12 (`pend11` = 1..2) | none | none |
| school complete (average tick) Ama / Pim / Saj | 597 / 708 / 667 | 722 / 722 / 722 | 694 / 722 / 750 |
| first woodcutter (average tick) Ama / Pim / Saj | 1,681 / 5,569 / 5,625 | 1,917 / 5,528 / 5,236 | 1,806 / 5,597 / 5,986 |
| completed buildings at 10 / 20 / 40 min, Ama | 4 / 9 / 16 | 4 / 9 / 18 | 4 / 9 / 16 |
| same, Pim | 6 / 11 / 24 | 6 / 12 / 26 | 6 / 11 / 21 |
| same, Saj | 5 / 8 / 16 | 6 / 10 / 20 | 6 / 9 / 20 |
| first army (median tick; runs with an army) | 8,252 (26 of 27) | 7,052 (27 of 27) | 6,902 (27 of 27) |
| runs where a computer player raids the other computer player | 19 | 19 | 19 |

The stuck count varies a lot from run to run (the raids decide it), so 9 versus 14 is within
the noise of 27 runs; the stale pending counts are gone in both.

Every remaining stuck town is a victim of an AI-versus-AI raid (2.6) and sits in the dead end of
1.15: no builder and either open sites (so no target evaluation and no placement) or no school
that can be queued, because the school needs more wood than the free-goods gift of 2 provides
and the woodcutter cannot be trained without a school. Both are original rules (the build queue
only takes types at menu state 1, 1.5; the gift only fires at stock 0, 1.8), kept for fidelity.
The third audit (7b) confirmed that the original has no recovery path either, and found that
our raids are more destructive than the original's (assault target set and caps, 7b O..R).

Engine changes checked for side effects on the AI:

| engine change | effect on the AI |
|---|---|
| territory placement (`economy.md` 11) | `placeOne` tests anchor + padded corners + `canPlace` (four corner blocks of the real footprint). The original tests the four corner blocks of the **padded** rectangle (spec 1.5 step 5). Roughly equivalent; no dead end found from it (schools were placed in every run before raids) |
| one unit per cell / step-aside (`units-and-jobs.md` 4.7) | AI placement now refuses rectangles with a unit (item J). The mirrored margin puts doors (+y) on the 1-cell side, so a builder or porter standing in that corridor can block deliveries until the engine's jam handling resolves it |
| doors / leave jobs (4.10) | units leaving a building carry a leave job and are not free for 20..35 ticks; harmless. Trainees still come from free group-0 porters as in the original (spec 1.7) |
| hunting-ground job (7.3) | not used by the AI (gangs use harvest jobs with auto-continue, as the original); no change needed |
| need buildings count only when staffed (`economy.md` 5) | the urgent-need rule requires every building of the type to be active (state 2), so an unstaffed tavern blocks a second one, as in the original |
| outpost garrisons (`combat.md` 9) | completion requests as in the original; the extra refill (item E) is removed |

Original behaviour that looks like a bug but is not ours to fix (keep unless a fidelity flag is
added): AI-versus-AI raids in free play (spec 2.6), the dead end of spec 1.15, the porter-shortage
copy that only works for Amazons (section 7 item 2 already deviates), the dead outpost refill.

## 7b. Third audit (2026-10): do raided AI towns brick themselves in the original?

Question from play-testing: about a quarter of the computer towns raided by another computer
player end without builder, with open sites and wood at 2..3, and stay so; the original
supposedly never does this. Result of the code search (spec 1.15 table, 2.4, 2.5, 2.6, all C):

- The original has **no** recovery path: no unit spawn except births (porters, criminals) and
  the one-time town-hall start set, no builder without a school, no conversion except school
  training, no school request without its goods in stock, no gift beyond "set wood / stone to 2
  at stock 0", no site cancellation, no AI cheat, no difficulty level. The dead ends of spec 1.15
  (now three of them, including "no school and the school's wood cannot be reached") are
  original behaviour, and AI-versus-AI raids also happen in the original while a human plays
  (as Pimmons or Sajiki, or with any race until the human founds his town; spec 2.6 table).
- What does differ is how the **raids** of our build pick their targets. The original assault
  attacks only bucket 0 (one important building, the town's outposts, the tier-0 units of the
  target race in the circle), six attackers per target; it never attacks civilians, houses or
  other buildings while the town stands. Ours spreads the members over civilians and other
  buildings as soon as an army has more than three members (school cap 5 - 2 = 3), and keeps
  members on civilians. Our raids therefore kill builders and gatherers in the assault as well
  as in the skirmish, and kill more of them. These items, most important first:

| # | deviation | where | impact | status |
|---|---|---|---|---|
| O | **Assault target set.** Ours: all buildings of the important type, then every hostile object in the circle (any race hostile to the army: civilians, houses, barracks, third parties) plus the town's military buildings, sorted by class, all attackable. Original: bucket 0 only = the **first** building of the important list, all outposts of the target town, and the units of class 0 (hunters, police, saboteurs, soldiers) of the **target town's race** in the circle; candidates of other races are ignored when the army has a target town | `ai.ts` `runArmy` (d[3] = 0) | **high**: our assault kills civilians (builders, woodcutters) that the original leaves alone; the main lever for the dead-end rate | fixed: bucket 0 only (`runArmy`), candidates of the target race only, deduplicated (the important building and a candidate seen twice are filed once, I) |
| P | **Assault caps and keep rule.** Ours: cap 5 - class of the target (3 on a school); keep a running attack when its class < the current target's class, or equal unless rand() mod 10 = 0. Original: 6 per target in bucket 0 (counter > 5 - bucket); re-assign when the running target's class > the **bucket index** (0), or equal and rand() mod 10 = 0 (draw only when equal); members attacking the school are re-assigned every run; a member counts even when the attack check refuses it, and its old job is then kept | `ai.ts` `runArmy`, `ai-town.ts` `assignAttackers` | high (with O) | fixed: `assignArmy` (6 - bucket per target, refused attacks counted, draw only on equal class); attacking members are handled wherever they stand |
| Q | **Town halls in the assault.** Ours drops every town hall, the important one included, while the army has fewer than 10 members (so an army facing only a town hall "succeeds" and ends). Original: only town halls among the circle candidates are set aside; the important town hall (the last fallback type) is attacked by any army, so the army never ends in an assault run while the town stands | `ai.ts` `runArmy` | medium: changes how long raids last and how often new armies form | fixed |
| R | **Skirmish keep rule.** Ours uses the army keep rule with its rand() mod 10 draw. Original (re-read, C): a member already attacking is re-assigned only when bucket 0 (fighters) is taken and its target's class is above 0; otherwise it keeps its target; no rand() draw; refused attacks count as in P | `ai-town.ts` `assignAttackers` call from `runArmy` (d[3] = 1) | medium (behaviour) and rand() order | fixed |
| S | **Anchor snapping** (spec 1.5): every explicit anchor is replaced by the nearest border block of the town's territory (cell = 2 x block), also when it lies inside; ties: first in the border list; no territory: (-1, -1). Ours leaves inside points where they are. Warehouse with an empty region list: the original's anchor is cell (0, 0) before snapping; ours uses the town centre | `ai-town.ts` `snap`, `queueBuild` | low-medium: outposts, towers and warehouses of the original sit at the territory edge | fixed: `snap` always, `anchor`; the sign draw of outposts / towers now comes before the menu-state and "already queued" tests |
| T | Idle army members far from the target: the original gives an idle member (no job) an attack job directly, wherever it stands; ours walks it in legs first (section 7 item 7). Members with another job are assigned when within 40 cells or inside the target town's area, as ours | `ai.ts` `runArmy` `far` | low | keep (cost) |

Not deviations (checked): the attack gate (relation human / attacker), the target loop (first
other living player with a town, race order, profile 0 strength x 0.5 or tick < 54,000), the
candidate thresholds, the profile 0 defence reserve that leaves one defence hunter free from
P 10, the free-goods gift, the essential-worker rule, the two site gates, the warehouse region
lists (Amazons forest first, Pimmons and Sajiki stone first), the retreat test.

**Expected effect of O..R** (I): fewer builders and gatherers lost per raid, so more victims
keep a builder and a woodcutter and re-queue the school. The dead end itself stays possible, as
in the original. If play-testing still finds it too frequent after O..R, that is original
behaviour; a recovery rule (for example a builder birth at the town hall when a computer town has
neither builder nor school) would be a non-original option behind a fidelity flag, off by
default.

## 7c. Fourth audit (2026-10): are the raid numbers original?

Question from play-testing: after 7b, free-play runs still show computer players destroying other
computer start towns (12 of 54 in 27 runs of 30,000 ticks), about 150 schools / school sites lost
and armies that only end with the victim's town hall. Every quantity involved was re-read in
AN.exe (not from our docs); result: **all of them match the spec and our build** (C unless noted).

| quantity | AN.exe | ours |
|---|---|---|
| damage model | weapon routine `00483930`: hit roll, min + rand() mod (max - min + 1), rank x1.25 / 1.5 / 2; same routine for units, buildings and sites; no armour, no building or race factor | same |
| strike interval | `00481450`: cooldown + 1 + rand() mod (cooldown / 2 + 1) | same |
| hunters | 50 HP; Amazon bow 10..20 r5 70 %, Pimmon / Sajiki spear 10..20 melee 100 %, cooldown 40 (`dv.wdb`, `dv.odb`) | same data |
| experience | `00461de0` / `004655d0`: buildings give d / 2, hunters keep experience, rank thresholds 2H / 6H / 18H | same |
| building HP | `dv.odb` (school 500, barracks 500, town hall 10,000); sites start at HP / 10 and gain HP only by construction | same |
| repair | only the player's command (`00452a70` -> `0045f4b0`); no AI code files a repair request | none for computers (was already so) |
| help rule | `00462ab0`: radius 12 around the victim, every armed non-priest unit of its race | same |
| AI alert | `00462e30` -> `0046cab0`: the striker is recorded on the victim town's military job when the victim stands in own-race territory | **was missing** (we only polled the territory): fixed, `Ai.alert` |
| defence | `0046cb20` / `0046d3a0` as spec 2.2 (hunter target min(6, P / 10 rest), profile 0 reserve 25 %) | same |
| attack gate, target loop | `00468f10`: candidates > min(10, tick / 30000), cooldown +0x30 = 10..30 ticks, relation (human, own) 0 / 1, first other living player with a town | same |
| army power, retreat | `00466020`: HP x 100 (`004afebc`) + max x 500 (`004afeb8`) / cooldown; retreat when enemy > 2 x own (`004afec0` = 1, `004afec4` = 2) | same |
| important list | barracks, school, laboratory, large and small outposts, town hall (town lists +0x288, +0x348, +0x2DC, +0x330, +0x324, +0x294), sites included; never ends while the town stands | same |
| joining, losses | every think adds the new free candidates (`00465ad0`); dead members are dropped; the army ends only with no members, a retreat, a skirmish success or a relation change | same |
| AI attack jobs | `00465650` with a first-run delay of **5** ticks (army tactics and defence response) | **was 1**: fixed (`AI_ATTACK_DELAY`) |
| school re-queue | at the next planner evaluation, no cooldown, normally the same spot (site HP 50) | same |
| tick | `00482ca0`: a tick when more than 95 ms passed: about 96..109 ms; 30,000 ticks = 48..55 min | - |

Spec corrections made: `combat.md` header (real tick period), 7 step 1 (AI alert), 13 "Other HP
sources" (repair only by command; computers never repair); `ai-diplomacy-trade.md` 2.5 (attack
jobs after 5 ticks; the retarget after the important building falls picks civilians next to it,
so "never attacks civilians" was too strong; no repair, no re-queue cooldown), 1.15 and 2.6
wording, new 6.4a (siege arithmetic).

**Why towns still fall.** The destruction comes from the scenario, not from a number:

- 12 of the 12 towns destroyed in the 27-run batch were in runs where the human never founds a
  town (`nohall`). The original's target loop then skips the human (no town) and every computer
  player raids the other one from its first free hunter (spec 2.6), about tick 6,600 (11 to 12
  minutes).
- With the human's town hall in all 18 combinations (`allhall`, human passive), 6 / 8 of 36
  computer start towns fell (before / after the fixes). Inspected runs: the computer players first
  raid the human; the passive human's town, which has no defence at all, falls at tick 11,000 to
  16,000, and then the target loop picks the other computer player. With a human Pimmon, a Sajiki
  profile-0 AI raids the Amazon AI from the start, as in the original (2.6 table).
- The victims are towns without hunting (no armed unit): one or two hunters destroy the school
  (1,500 / 750 ticks), every re-queued school site (HP 50), the laboratory and, with six hunters
  of rank 2..3, the town hall (10,000 HP, about 3,500 ticks). Nothing in AN.exe stops that.

What would make the experience reported from play-testing ("computer towns never brick themselves") differ is outside
the raid rules: a human who founds his town at once and defends it absorbs the raids of
computers whose first candidate in race order is the human, and the victims' economies may grow
faster in the original (hunting before the first raid). Not changed here.

Free-play batch (seeds 1..6 no human town hall, 1..3 with it, each race as the human, 30,000
ticks; before = this week's build without the two fixes, after = with them):

| | before | after |
|---|---|---|
| computer start towns destroyed (of 54) | 12 | 11 |
| stuck (dead end) | 1 | 1 |
| schools / school sites lost in combat | 155 | 134 |
| builders / woodcutters killed | 21 / 30 | 13 / 19 |
| armies formed (against computer towns) | 553 (513) | 708 (693) |
| first army, median tick | 6,752 (11..12 min) | 6,752 |
| first army against a computer town, median | 6,602 | 6,602 |
| same batch with the human town hall in all 18 runs: destroyed of 36 / schools lost | 6 / 52 | 8 / 65 |

The differences are within the run-to-run noise (the raids decide everything).

## 7d. Fifth audit (2026-10): a single hunter, late in an island free-play game

Report from play-testing: in a long add-on free-play game the Pimmon computer player attacked for
the first time after a long while, with **one hunter**, which ignored the human's units at the
shore and walked to a tower in his territory; the original would "have sent more". The army code
was re-read in AN.exe and dvge.exe (spec 2.3..2.6 corrected, `addon.md` 8.4).

**What the original does** (C, details in the spec):

- The candidate threshold (profile 0: more than min(10, tick / 30000)) gates only the **creation**
  of an army, counts the free hunters / soldiers (add-on: also free warships) of the whole nation
  and sends **all** of them; later thinks add any number of new candidates, one is enough
  (`0x4690e1..0x46911f`). After tick 300,000 a new profile-0 army therefore has at least 11
  members.
- Members do not move as a group: each walks on its own from where it stood; nobody scans for
  enemies on the way (only the help rule makes a struck member fight); "within 40 cells" is
  always measured from the **target point** (the target town hall), not from a member.
- Across water (Gold `0046c050`): at each join the new land members are grouped by island, one
  transport request per group not on the target's island, members wait (job 0x3E). Nothing tests
  reachability. The naval planner's rules then decide what arrives: one ship per request, a ship
  assigned when the request is made sends at most its counter's worth of units (corrected in
  7e: the counter is cumulative, not "as on its last trip"), and requests of armies that have
  since retreated are still served. Against a human whose defence near his town hall is more than
  twice the army's power, every army retreats at its first assault run and is formed again at
  the next think, so in the long run what reaches him is a trickle of single units put ashore
  near his town. That is the reported picture, and it is the original's.
- A lone arrival attacks the first building of the important list (tactic 0) or a fighter near
  the town hall (tactic 1), ignores units elsewhere, and is drawn to a tower that shoots at it
  (help rule, the outpost stands in for its garrison).

**Reproduction** (harness: island and base free play, all three races computer players, the
"human" race redirected for `Ai.human()` and given profile 4 or 2, logging every army, join,
transport request and unload): in island free play the Pimmon and Sajiki armies of 1..4 hunters
(before tick 60,000) and of 13..23 hunters and soldiers (tick 100,000+) were formed and retreated
at once against a "human" with about 40 soldiers; ships brought single hunters (army members,
freed members of retreated armies and even defence-group hunters from stale requests) and made
many empty trips. Seed 1, Mittel, to tick 140,000:

| | before | after (U..X) |
|---|---|---|
| armies formed | 269 | 253 |
| transport requests with units (armies and founders) | 310 | 267 |
| ship trips by passengers (0 / 1 / 2 / 3+) | 83 / 54 / 5 / 18 | 46 / 24 / 1 / 0 |

Deviations of our army code found and fixed (rand() order changes):

| | ours before | original (fixed now) |
|---|---|---|
| U | every army run grouped the members standing on another island and requested a ship for them, after the join had first sent them walking toward the target in legs (into the coast) | the grouping and the request happen **at the join**, once per joining batch; members on the target's island walk in, the others wait at once; the wait job is given even if the request fails; flags 8 |
| V | warships were never army members | free group-0 warships 65 / 66 are candidates in add-on mode (after the soldiers) and sail to the nearest ship cell of the target town at the join; the tactics give them attack jobs wherever they are |
| W | a member with another job outside the circle and the target's territory had that job cancelled and was walked in (only ship waiters were exempt); members waiting for or walking to a ship were skipped and not counted | members with another job are left alone unless within 40 cells or inside the target's territory (then cancelled and assigned); only members aboard a transport are skipped and not counted |
| X | "far" meant more than 40 cells | assigned when the distance is **below** 40 (`0x466a29`) |
| Y | no draw when an army ends | the destructor draws rand() mod 10 + 2 for every living member (walk-home delay) |

Not changed (original behaviour): the threshold, single-unit and empty ship trips, stale
requests, retreats at the first assault run, no scanning on the way. Kept deviation: idle
members far from the target walk in legs before they get an attack job (7b T).

## 7e. Sixth audit (2026-10): one hunter per ship trip, and landed units ignoring the player

Two reports from an add-on save: (1) the computer ferried **one** hunter per trip, trip after
trip, although a transport takes 5; (2) in the original, landed units first went for the
player's units nearby before the attack order sent them to the nearest tower, in ours they
ignored his units. Both re-derived in dvge.exe at instruction level (`addon.md` 5.2, 5.3, 8.4;
spec 2.5, 2.6, 9).

**(1) What the original does.** The planner's per-ship counter is written only at registration
and at the request service (100 = no limit), and by the boarding step (100 becomes 0, then + 1
per unit sent). It is **cumulative**, not a copy of the last trip: a ship that last carried one
unit and is assigned directly at a new request sends 1, then up to 2, 4, 8 units on later
direct assignments; a ship assigned by the request service sends every waiting unit and the
first five to arrive get in. A request asks for its island group's size (the units of that join
on that island); requests never merge. So "one per trip" in the original comes from requests of
one (each later think that adds one new hunter makes a request for one), from the counter after
a founder trip, and from dead or stale list entries using up places. In addition, three rules
were missing in ours:

| | ours before | original (fixed now) |
|---|---|---|
| Z1 | the boarding step skipped list entries that were dead, aboard or inside, without counting them | every entry is sent and counted, no test of the unit (`0x472a42..0x472b03`); a dead entry uses a place and raises the counter. Ours skipped them, so the counter often fell to 0 after a service assignment (all entries of a stale request dead) and the ship then sailed empty on every later direct assignment |
| Z2 | the 50-request refusal tested flag 2, the army passed 8, and served requests were dropped | the request record's flags default to 1 (field 0 is 8), the army keeps the default, the planner refuses flag-1 requests while it holds more than 50 requests, and it never drops a served request (only a founding cancel removes one). So after about 50 requests a nation's armies stop crossing the water: their members wait (job 0x3E) until the army ends. Founding requests have flags 0 |
| Z3 | a unit sent to a transport walked to the ship where it lay | the go-to job's constructor re-aims a type-67 target: the ship's job is cancelled and it sails (0x3B, first run after 1 tick) toward the unit's island; the player's boarding order does the same, on any ship |
| Z4 | the head of a human ship's door queue, farther than 4 from the ship, walked to a new shore cell and gave up after 20 tries | it waits at the door and asks again every 10 ticks, for as long as it takes (5.1); with Z3 the ship comes to it |
| Z5 | the sail-to-coast job's fallback spiral stopped at radius 32 | no radius limit (`0x48baab..0x48bb8b`); needed by Z3 when the unit stands inland |

Kept: the planner's request ids start at 1 (the original's at 0; 0 means "none" in ours). A dead
list entry in ours has no position, so it does not re-aim the ship (the original's ship turns
toward where the dead unit stood); a list entry inside a building is counted but not sent (how
the original's go-to job takes it out of the building is not traced).

**(2) What the original does.** Nothing at the landing: the ship ejects every passenger, the
leave job puts each on the nearest free land within 5 cells and ends; the unit has no job (it had
none aboard), and no landing, unloading or army code scans for enemies (`addon.md` 8.4
"Unloading", `combat.md` 8.4 row "unit just put ashore"). A jobless unit reacts only to strikes
(help rule within 12 cells, retaliation). The army's next run (at most 50 ticks) gives a member
without a job an attack job wherever it stands: tactic 1 at the victim's hunters, police and
soldiers within 40 cells of his **town hall** (three members per target), tactic 0 at the one
important building (barracks, school, laboratory, large then small outposts, town hall) and then
the outposts and those fighters (six per target). After a kill the retarget takes the next unit
of the victim's race within 13 cells of the body. So "first the units nearby, then the tower" is
the skirmish tactic (or a struck raider) followed by an assault run, when the landing point lies
within 40 cells of the town hall; units of the player farther than 40 cells from his town hall
are never chosen by the army. Ours does the same (verified in the harness below: landed members
attack the victim's barracks, hunters and soldiers near his town hall, and retaliate when
struck); the only difference left is the kept deviation T (a jobless member farther than 40 cells
from the target point and outside its territory walks in 32-cell legs before it gets its attack
job; the original gives the attack job at once). No change for (2).

**Reproduction** (harness: island free play, all three races computer players, one race
standing in for the human with profile 4, logging requests, boarding steps, trips and the next
400 ticks of every landed unit). Seed 3, Mittel, to tick 140,000, the Pimmons' and Sajiki's
planners:

| | before | after (Z1..Z5) |
|---|---|---|
| transport requests with units (1 / 2 / 3 / 4 / 5+ units) | 41 / 17 / 7 / 19 / 243 | 50 / 20 / 20 / 10 / 21, plus 54 army requests refused (cap) |
| boarding steps by units sent (0 / 1 / 2 / 3 / 4 / 5+) | 31 / 29 / 13 / 5 / 13 / 45 | 0 / 30 / 19 / 10 / 2 / 0 |
| ship trips by passengers (0 / 1 / 2 / 3 / 4) | 79 / 30 / 6 / 3 / 3 | 27 / 25 / 5 / 0 / 1 |

Seeds 1 and 2 look the same: every computer nation that owns transports reaches the cap
(51..53 requests kept) and is refused afterwards. Most trips still carry 0 or 1 units, as the
original's rules give: most requests are made for one new member, and the old requests' lists
hold units that have died, were shipped by another request or have since been taken elsewhere
(each of them uses up a place). The landed units (all seeds) stand jobless for up to 50 ticks;
army members then attack the victim's barracks or his hunters and soldiers near his town hall,
answer strikes, and after a kill take the next of his units nearby; free ones wait for the next
army. Tests: `test/addon-gameplay.test.ts` (counter, dead entries, served requests kept, the
ship coming to a boarding order), `test/ai-army.test.ts` (the 50-request cap).

## 8. Tests and cost

`test/ai.test.ts` (with or without integration):

- ring order, profile table;
- setup on Pimmons 4: profiles (Sajiki = 3, Amazons random 0..2), the three town jobs, the think
  job's acceptance flags, motivation 0;
- growth over 25,000 ticks on Pimmons 4: both computer players build, grow, train and research
  (Amazons 10 → 42 buildings, population 7 → 95, 11 → 28 inventions; Sajiki 1 → 12 buildings,
  4 → 28 population, 0 → 14 inventions). The Amazons found a second town (through the engine's founding).
  Founded towns must work like any computer town;
- determinism: two runs give the same hash; snapshot/restore at 6,000 then 3,000 more ticks give
  the same hash (world hash + AI digest);
- free play 512 x 512 (populator, two computer opponents set to profile 4): both build and
  research, and a town grows.

`test/ai-army.test.ts` (7d): the late-game threshold (10 candidates no army, 11 an army with all
of them, a single later candidate joins), the end-of-army draws, and in island free play the
join by island (one request per group, pickup and destination, the wait job, no request from
the army runs) and a free warship as candidate that sails toward the target town.

Cost: Pimmons 4 (256²) 0.23 to 0.32 ms/tick (machine load varies) for the whole simulation with two active computer
players. Of that, AI code including its units' path searches is about 0.026 ms/tick, and the
decision logic without path searches is about 0.018 ms/tick. Free play 512²: about
0.12 to 0.16 ms/tick in total, 0.013 to 0.026 ms/tick of AI. The remaining extra over an idle
world is the simulation of the AI's units (walking, harvesting, fighting), the same as a busy
human player causes.
