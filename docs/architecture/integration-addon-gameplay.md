# Integrating the add-on ("AO") gameplay

What the engine now does for the Gold Edition mission pack (harbours, shipyards, ships, islands,
transport, fishing, sea combat, sea trade, goals 17..20, the computer players' navy), and what the
client (`src/client/*`) has to add to make it playable. Gameplay spec:
[../game/addon.md](../game/addon.md) (section numbers below); data and world generation:
[integration-addon.md](integration-addon.md), [../formats/addon.md](../formats/addon.md).

## 1. Switching it on

- **Add-on mode is per `World`.** `World.addon` is `setup.addon ?? (terrain is an AddonTerrain)`.
  Passing the `AddonTerrain` of an AO mission (stored map or InfiniteAO generator) is enough;
  `World.restore` detects it the same way, and the snapshot records `addon` and the options.
  A base terrain keeps every base rule: no ship grid, no island tests, mountain 250, 62 types per
  group, and the hash sequences of base missions are unchanged (checked against a recorded
  oracle of five base missions, GOG and Gold data).
- **Gold options** (`WorldSetup.gold`, type `GoldOptions` in `src/engine/naval.ts`). Defaults are
  the GOG behaviour in base games and the Gold behaviour in add-on games:

  | option | base default | add-on default | rule |
  |---|---|---|---|
  | `pathFlag` | false | true | worn paths by record flag 0x80, roll only for flagged units (10.1) |
  | `class0Respawn` | false | true | respawn avoids class-0 cells: meadow in base, beach and paths in add-on (10.2) |
  | `aiCapacitySkip` | false | true | AI economy job skipped while capacity is 0 (10.4) |
  | `shipyardTopUp` | false | true | the shipyard's goods top-up, in the simulation only (3.5) |
  | `fishTwice` | true | true | each fish is caught twice (6.2 quirk) |
  | `fishHarvestBug` | false | false | right-click boat on fish: original endless harvest loop (6.3) instead of the fishing job |
  | `foreignBoarding` | true | true | units of any race may board any transport (5.2 quirk) |

  To play a base campaign "as the Gold executable", pass `{ pathFlag: true, class0Respawn: true,
  aiCapacitySkip: true }`.
- `main.ts` only needs the AO branch of integration-addon.md section 3; the cargo, goal and ship
  gaps listed there in section 4 are closed by this pass (4.1 cargo, 4.2 ids, 4.3 goals, 4.4
  ships on water, 4.5 mountain limit).

## 2. Commands (all `World.Command` variants)

| command | add-on use |
|---|---|
| `{ type: 'unload', player, ship, unit? }` | **new.** `AUSSTEIGEN` (unit omitted / -1: everyone) and the passengers page's per-type send-out (`unit` = a unit type). Passengers leave the list at once and land after 10 ticks on the nearest free land cell within 5 rings; out at sea the idle ship first sails to the coast (job 0x3B). |
| `{ type: 'order', ids, target }` | own land units on a **transport ship** (type 67, room left): they walk to a shore cell next to the ship and board (5.2). Armed units on a foreign ship still attack it. A fishing boat on a **fish**: fishing job on that fish. Any other ship order: the ship sails next to the target; warships attack hostile targets as usual. |
| `{ type: 'move', ids, x, y }` | ships get distinct free open-sea cells near the point (spiral, ship mask); a **fishing boat** gets a fishing job with that cell as its grounds (6.1). Land and ships may be mixed in one order. |
| `{ type: 'patrol', id, points }` | now also warships 65 and 66 (4.1). |
| `{ type: 'route', unit, ... }` | any trader: merchants (type 28) and **transport ships** (record flag 0x40). Ships trade between harbours of any island; merchants only with towns on their own island. |
| `{ type: 'train', building, unit }` | at a shipyard: types 64..67 (porter goes in, the ship comes out on the nearest open-sea cell). |
| `{ type: 'build', building: 62 / 63, x, y }` | harbour / shipyard; `logistics.canPlace` implements the shore rule (below). |
| `{ type: 'market', town, ... }` | the harbour uses the town's market settings (shared with a market). |

## 3. Side panel (docs/ui/side-panel.md 3.4 / 5.x with addon.md 5.6)

Function-bar additions:

| selection | buttons / pages |
|---|---|
| one own transport ship (67) | `BEWOHNER` (tooltip T329 "An Bord", logical 6, **default page**): grid of passengers by type (`ship.passengers`, in boarding order), click = `unload` with that type; `HANDEL` (T50) trade-route page (flag 0x40) with `trade.partnerLists(town, ship)` (harbour towns, any island) |
| any trader unit (type 28 or flag 0x40) | `HANDEL` (not only type 28) |
| one own shipyard (63, class 5) | `KAEMPFERBAUEN` training page; the unit grid is the shipyard's made-at list (64..67) with `logistics.trainState` |
| a harbour (62, flag 0x20), own or foreign | `VERKAUF` / `EINKAUF` exactly like a market (flag 0x20 instead of type 48; foreign only at peace) |

Unit info page (class 0):

- Transport ship: `AUSSTEIGEN` button (tooltip T330 "Ausladen"), disabled while
  `ship.passengers.length === 0`; it sends `{ type: 'unload', ship }`.
- `PATROL` for types 65 and 66 as well as 29..36. No `MOVEHOME` for ships (the engine ignores it).
- No experience badge for ships (they never gain rank); hit points never go up (no healing or
  repair of ships).
- Status text: a unit inside a ship shows T280 with the **ship type name** ("in Transportschiff");
  fishing boats: `naval.fishingPhase(boat)` 0 = T327 "Unterwegs zu Fischgründen", 1 = T328
  "Fischt", 2 = the transport status (carrying food to the harbour).
- Carried goods: a fishing boat or trading ship shows its load like a porter (`carryGood`,
  `carryAmount`); this is separate from the passengers.

Build menu: harbour and shipyard come from `menuState` like every building. With the top-up on,
`menuState(t, 63)` answers 1 even when goods are short (the goods are added when it is placed).

## 4. Cursor and selection rules

> The original's cursors are now specified in [../ui/cursors.md](../ui/cursors.md): there is no
> target-dependent cursor at all (no boarding, harvest or attack cursor); the cursor bullets below
> describe our stand-in only.

- **Boarding cursor**: own land units selected and the mouse on an own (or, with
  `foreignBoarding`, any non-hostile) transport ship with `ship.passengers.length < 5` → "enter"
  cursor; the click sends `order`. Ships cannot board ships.
- **Ships selected**: a click on water or land sends `move` (the engine picks sea cells within
  24 rings, so clicking a coast works). A fishing boat over a fish shows the harvest cursor and
  sends `order` on the fish; over plain water a move (= fishing grounds).
- Hostile ship under the cursor with armed units (ships or ranged land units) → attack cursor as
  for land targets. Melee land units may get the order; they give up (no reachable cell).
- Passengers (`inside` = a ship's id) are hidden and not selectable, like units inside buildings;
  the info page of a ship lists them. A selected unit that boards should be dropped from the
  selection like one entering a building.
- Harbour / shipyard placement preview: `logistics.canPlace(t, rule, x, y)` (shore rule: the
  footprint grown by one holds 1..size_y + 3 land cells and no building, nature object or unit;
  water allowed; slope ring and town area as usual). The building stands mostly in the water.

## 5. Rendering

- **Ships** are units (`kind` 0, rule class 14) on open-sea cells; water cells are flat at height
  120, so draw them at the cell's terrain height like any unit (no bob needed for correctness).
  Actions: `Walk` (0) while sailing, `Idle` (3), `Fight` (1) when firing, `Work` (2) while a
  fishing boat fishes. Sprites come from `Addon.gd` / `Addon.od` (second archive, see
  integration-addon.md 2). Facing 0..7 as for units.
- **Shots** from ships are ordinary `shot` effects (projectiles 3 and 9). A sinking ship emits the
  normal `die` effect at its cell (race death effect, no wreck, no rubble). Passengers die with it
  and emit their own `die` effects at the ship's cell (suppress them if that looks wrong).
- **Fish** (nature, class 15, types 41..45) stay where they are; `alive === false` after the
  first catch (they still exist until the second catch). Fish dying play no carcass sprite and no
  death cry (types >= 41).
- **Harbour / shipyard** footprints cover water cells; draw them over the water tiles. They get
  no foundation, so no ground edit / chunk rebuild happens when they are placed.
- **Docking**: a ship trading or delivering at a harbour never leaves its cell (`inside` stays
  -1); the harbour's `doorTick` changes as for any door.
- **Fog** (client `vision.ts`): passengers have no vision; a ship sees its record radius; a
  **foreign harbour at peace** gives vision of radius 6 like a foreign market (flag 0x20 instead
  of type 48, addon.md 3.3).
- Minimap: ships are units of their race.

## 6. Engine overview (for reference)

| file | content |
|---|---|
| `naval.ts` (new) | `Naval`: sea bodies, ship walking and target chooser, ship placement/launch, boarding (job 0x07), leave ship (0x0D), sail to coast (0x3B), fishing (0x3A), docking, wait (0x3E), naval planner (0x3D) with snapshot/digest; `GoldOptions` |
| `world.ts` | `addon`, `gold`, `island`, `shipBlocked`, `mountain`, `typeWidth`, `islandAt`, `isShip`, `findPathOn`; cargo creation; island test and target chooser for land walks; ship move orders; `unload` command; passengers die with their ship; snapshot / restore / hash |
| `path.ts` | `PathSearcher`: the same A* as `findPath` (identical results, checked on 300 queries) with reusable typed arrays; used for add-on walks |
| `logistics.ts` | shore placement, top-up, builder stays put at 62/63, lenient arrival at buildings whose door is inside the footprint, ship launch, fishing/boarding orders, class-0 respawn, mountain limit, `walkToCell`, `deliver`, `doorInside` |
| `combat.ts` | ships' firing-position search on the sea, fishing boat may act on fish, no healing of ships, no rubble of 62/63 |
| `economy.ts` | goals 17..20; storage capacity by flag 0x10 in add-on games |
| `trade.ts`, `visit.ts` | traders by flag 0x40, harbour as terminal, island filter for merchants, docking |
| `diplomacy.ts` | diplomats only walk to embassies on their island (9.3) |
| `ai.ts`, `ai-town.ts` | targets 62/63, priorities, fishing / warship gangs, AI fishing, wandering warship (0x28), harbour/transport market pass, training hook, planner users (founding, army), capacity skip, 68-type tables |

Speed (Node 22, this container): AmazonsAO 4 with computer players **0.01..0.05 ms/tick** (was
~8 ms/tick before ships had their own grid); SajikisAO 8 0.5 ms/tick; AmazonsAO 5 with all three
nations computer-controlled 0.12 ms/tick; InfiniteAO 256 map, three computer nations, 0.18 ms/tick.

## 7. Deviations, interpretations and gaps

- **Target chooser.** Ships: a water target they may not use (coastal water, fish, a harbour) is
  replaced by the nearest usable cell within 6 rings of the same sea body; a land target fails at
  once (the ship's island is 0, 2.5). Land units in add-on mode: a goal on water or on a building
  is replaced by the nearest free land cell of their island within 6 rings, and the walk fails at
  once when there is none (otherwise melee units retaliating against ships ran 2000-node searches
  every tick). Trees and other goals keep the base search.
- **Sea bodies.** Open-sea cells are labelled once (4-connected, static terrain); a walk to
  another body fails at once. Buildings and fish are dynamic and only enter the path grid.
- **Search budget.** Ship walks may expand 30000 nodes (land walks keep 6000 / 2000); the
  original re-plans a follow path up to 15 times instead.
- **Entering without a distance test.** The original lets buildings be entered from wherever a
  unit stopped. Here a ship docks, and a land unit enters a harbour or shipyard (door 0,0 inside
  the footprint), from up to 6 cells around the footprint; other buildings keep the base rule.
- **Boarding**: when the ship moved away from the shore cell a waiting unit chose, it chooses again
  (the original waits). Step aside (0x0F) is an immediate one-cell walk, not a job.
- **Leaving a ship by another job** (e.g. a diplomat recalled while aboard) uses the unloading
  cell search, else the nearest land; the original's container place method is not modelled.
- **Sail to coast**: a landing cell the ship may not use (coastal water) fails at once instead of
  after 15 re-plans; at most 15 rounds of step 2 (guard against the original's possible loop).
- **Fishing**: references (refcounts) are not modelled; "fish set and alive" reads "the fish
  object still exists" (otherwise the double catch could not happen); a fish gone before the
  catch starts a new search; the new path starts at once rather than after the 50-tick return.
- **Harvest-bug mode** (`fishHarvestBug`): the boat kills the fish, works it (1 food per 100
  ticks) and retries the delivery to the land store forever; animal-specific details beyond that
  are not modelled.
- **Units in the placement footprint** block a harbour/shipyard (mask 0x405E has the unit bit);
  the steep flag 0x40 is not tested, as for every building in this engine. The AI site test
  requires both its padded-rectangle rule (limit padded height + 1, no mountain) and the player's
  rule.
- **Top-up**: the raw-material branch (crop conversion) is simplified to +15 (never runs on
  shipped data).
- **Computer players** (re-audited 2026-10, `ai-diplomacy-trade.md` 9): the fishing gang is
  always wanted (the "food gangs enabled" condition is always on in the original too); a released
  fishing boat is not sent to the shipyard (the original's walk fails anyway); served planner
  requests no ship works for are dropped from the list (the original keeps them; nothing reads
  them); the army groups only members that are idle-on-the-wrong-island at each army run; the
  warship's explore job uses the nearest-cell spiral (`004853c0` order) for the random cell's
  usable neighbour, the original walks its own square spiral; dead or already embarked units in a
  request's waiting list are skipped by the boarding step without using a place.
  **Fixed in the 2026-10 audit** (they kept every computer navy small or idle): the planner's
  claim counts were missing from the training wants (no transport was ever trained for the
  planner, so founders waited for ever); the naval part ran in the training step and ordered
  directly at a shipyard instead of queueing priority-0 entries in the training needs; the
  founding mission went on while the founder was aboard (the original ends it: the founder lands
  and stays idle), kept a waiting founder's job when its site moved (stuck in job 0x3E with a
  cancelled request), founded closer than 8 cells, and sent the ship to the site itself instead of
  the 8..15 cell of the 30-ring search; registration cancelled the ship's job; the boarding
  counter, the idle list of the request service and request cancelling (all ships of the
  request become idle) follow 8.4 now.
- **Goal 17** uses the object's own position; a unit aboard keeps the cell where it boarded (or
  was created). **SajikisAO 8**'s goal ids still point at the outpost/house objects
  (formats addon.md 7.3); **SajikisAO 2**'s goal `19(1, ...)` can never hold (no island 1).
- **Map ships** are housed by the base housing rule when their town has room (ships are units);
  cargo is not housed.
- **Client (done)**: sections 3..5 are implemented in `src/client/` and checked in Chromium on
  SajikisAO 2 / PimmonsAO 6 (board, sail, AUSSTEIGEN and per-type send-out, shipyard training of
  a fishing boat, fishing on a fish, harbour market pages, ship trade-route page, harbour
  placement preview and construction over water). Shared rules live in `addon-ui.ts` (transport,
  trader by flag 0x40, market-like by flag 0x20, PATROL for 65/66, passengers by type, the
  right-click intent), tested in `test/addon-client.test.ts` together with the fog rules.
  - Side panel (`hud.ts`, `hud-pages.ts`, `hud-pages-trade.ts`): `BEWOHNER` (T329, page 6) is
    the transport's default page while no other page was chosen for the type (a ship remembers
    every page, including 0, so INFO sticks); the info page puts `AUSSTEIGEN` / `PATROL` /
    `WEGWERFEN` from the first slot because ships have no `MOVEHOME`, and adds an "An Bord: n/5"
    line under the status (our addition). Trade page: origin towns with an active terminal
    (market or harbour), partners from `partnerLists(town, trader)`. Market-like buildings get
    no `ROHSTOFFE` button (as the market). Status: board job T269 with the ship name, trade
    route T305 with the two towns, fishing T327 / T328 / T272 (good, nearest own harbour).
  - Strings: `main.ts` merges `Addon.tdb` into the HUD's DV.tdb strings in every mode.
  - Cursor (stand-in; the original is in [../ui/cursors.md](../ui/cursors.md)): the canvas gets a CSS
    cursor from `orderIntent` (mirror of `Logistics.order` / `Combat.order` /
    `Naval.boardOrder`, strongest intent of the selection wins): attack `crosshair`, board
    `alias`, harvest / fish `cell`, own building `pointer`, else the default arrow. This is a
    stand-in, not the original look.
  - Selection: units inside a building or a ship are skipped by click and box selection and
    dropped from the selection each frame (boarding, entering, death). Ships get a wider pick
    radius and a wider selection ring (own generated graphic).
  - Rendering: ships use the unit branch of `looks.ts` (MG walk/idle, ST fight, WO work, CA
    while a loaded ship sails); fish loop their `ID0` sprite in place with a per-fish phase (the
    spec names `MS0` and `ID0` but not which one the original shows); harbour / shipyard need
    nothing special (no ground events are emitted for them).
  - Fog (`vision.ts`): a foreign completed market-like building (flag 0x20 or type 48) at peace
    gives vision of its record radius (6 for the harbour); passengers (inside >= 0) see nothing.
- **Still missing (client)**: ship sounds (ships have sound frame 0; nothing is played); the
  per-type send-out of the *building* inhabitants page (base game) has no command yet; no
  original cursor art; the minimap was not touched (ships are drawn as units there); the
  original's exact button positions for `AUSSTEIGEN` and the ship info page are not specified
  (ours: first slot at (10,135)); the passengers' `die` effects at a sinking ship's cell are
  shown unchanged.
- **Not verified in the original**: everything marked *(I)* / *(uncertain)* in addon.md 11.
