# Integrating trade and diplomacy

Trade and diplomacy (spec: `docs/game/ai-diplomacy-trade.md` sections 3 and 4) live in their own
modules so they could be written while `world.ts`, `logistics.ts`, `economy.ts` and the HUD were
being changed for combat. This file lists every call the world, logistics and the HUD must add.
All snippets call only the new modules' API.

| file | what |
|---|---|
| `src/engine/trade.ts` | `Trade`: market settings per town (town +0x4EC table), partners, route job **0x20**, the trade exchange, computer market settings (4.6, for the AI) |
| `src/engine/diplomacy.ts` | `Diplomacy`: relation table access (kept symmetric in `Player.relations`), acceptance flags, embassy contact/closure, diplomat errand job **0x38** ("operator errand") |
| `src/engine/visit.ts` | shared helpers: walk to an object, door queue (`units-and-jobs.md` 4.4), stop walking |
| `src/client/hud-pages-trade.ts` | pages 9/10 (market selling/buying, classes 11/12), 11 (trade route, class 13), 12 (diplomacy, class 14), and `marketPagesAllowed` |
| `test/trade.test.ts` | tests on Pimmons.mdb mission 4; they use `world.trade` / `world.diplomacy` when present, otherwise a job-dispatch shim |

Neither module draws random numbers; all state is integer.

## 1. World (`src/engine/world.ts`)

### Imports, fields, constructor

```ts
import { Trade, isTradeJob, type TradeCommand, type TradeSnapshot } from './trade.ts';
import { Diplomacy, isDiplomacyJob, type DiplomacyCommand, type DiplomacySnapshot } from './diplomacy.ts';

  readonly trade: Trade;
  readonly diplomacy: Diplomacy;

  constructor(...) {
    ...
    this.economy = new Economy(this);
    this.logistics = new Logistics(this);
    this.trade = new Trade(this);
    this.diplomacy = new Diplomacy(this);
    if (setup) this.economy.setupPlayers(setup.races, setup.costs, setup.goals);
    if (objects.length) this.loadMap(objects, setup);
    // 3.2 / mdb.md "Relations": the table is rebuilt from the race blocks AFTER the map objects
    // exist (later write wins); this also undoes the "first contact = war" of embassies
    // activated during loading.
    if (setup) this.diplomacy.initRelations(setup.races);
  }
```

`World.restore` needs nothing extra here (relations are restored with the economy's players).

### Commands

```ts
export type Command =
  | ...existing...
  | TradeCommand          // { type: 'market' | 'route', player, ... }
  | DiplomacyCommand;     // { type: 'diplomacy', player, action: 'offer' | 'accept' | 'recall', ... }
```

In `apply()` (all three carry `player`, so the existing (player, seq) ordering applies):

```ts
    if (cmd.type === 'market' || cmd.type === 'route') { this.trade.apply(cmd); return; }
    if (cmd.type === 'diplomacy') { this.diplomacy.apply(cmd); return; }
```

The modules validate ownership themselves (own town / own merchant / own embassy).

### Job dispatch in `step()`

```ts
    this.sched.tick(job =>
      isLogisticsJob(job.kind) ? this.logistics.runJob(job)
      : isTradeJob(job.kind) ? this.trade.runJob(job)            // 0x20 trade route
      : isDiplomacyJob(job.kind) ? this.diplomacy.runJob(job)    // 0x38 operator errand (diplomat)
      : this.economy.runJob(job));
```

Both jobs are unit jobs created through `logistics.assign()`, so `unit.job` points at them and
`logistics.cancelJob()` (move orders, death) ends them; they need no extra cleanup (the door
queue removal at the end of `Logistics.cleanup` covers them).

### Snapshot, restore, hash

```ts
export const SNAPSHOT_VERSION = 3;              // or keep 2: restore(undefined) gives the initial state
export interface WorldSnapshot { ...; trade: TradeSnapshot; diplomacy: DiplomacySnapshot; }

  snapshot():  ..., trade: this.trade.snapshot(), diplomacy: this.diplomacy.snapshot(),
  restore():   w.trade.restore(snap.trade); w.diplomacy.restore(snap.diplomacy);
  hash():      this.trade.digest(mix); this.diplomacy.digest(mix);   // after economy.digest
```

`diplomacy.digest` also mixes the relation table, which `Economy.digest` does not include.

## 2. Hooks

### Embassy became active (3.3 contact)

In `Logistics.activate(b)` (it runs for map buildings and when the operator moves in):

```ts
  activate(b: Entity): void {
    const was = b.active;
    this.w.economy.activate(b);
    if (!was && b.active) this.w.diplomacy.embassyActivated(b);   // ignores non-embassies
    ...
```

`embassyActivated` sends mentor#(68 + race) to the other human players (not at tick 0, i.e. not
during map loading) and sets every pair still at 0 whose other side has an active embassy to war.

### Embassy stopped operating (3.3 closure)

Everywhere `economy.deactivate(b)` is called for a building that may be an embassy:

```ts
  // World.destroyBuilding (also used by combat destruction and demolish)
    const was = e.active;
    this.economy.deactivate(e);
    if (was) this.diplomacy.embassyDeactivated(e);

  // Logistics.buildingAction('deactivate') (T312 "Diplomatische Beziehungen abbrechen")
      if (op && op.inside === b.id) { this.leave(op); b.operatorId = -1; this.w.economy.deactivate(b); this.w.diplomacy.embassyDeactivated(b); }
```

The diplomat leaving on an errand goes through `logistics.leave()` only, which does not
deactivate the embassy (as specified: an errand keeps the building active).

### Combat (combat.md 11)

On every impact of an attacker on a target of another race (both races 0..2), in the impact job:

```ts
    this.w.diplomacy.onHit(attackerRace, targetRace);   // ceasefire/peace -> war on the first hit
```

Nothing else is needed for "leaving peace switches off market trade": the route job, the
partner lists and the market pages read the relation live.

Combat/AI code that needs "hostile" (relation 0 or 1) can use `this.w.diplomacy.hostile(a, b)`
and `relation(a, b)` (-1 for the same race).

### Recommended: an operator walking back into his active building stays inside

`Logistics.entered()` currently ejects anybody who is not the missing operator. A diplomat that
the player orders back into his own active embassy (e.g. after an errand that found no foreign
embassy, 3.4 step 2) would come straight out again. Suggested first rule in `entered()`:

```ts
    if (b.operatorId === u.id && b.active) { u.job = 0; this.setAction(u, Action.Idle); return; }
```

(The errand job itself re-enters the embassy on its own; the panel's recall button also works
for a diplomat standing outside.)

### Not needed

- Dispatcher: merchants and diplomats are never free units while on these jobs, and the trade
  code never uses porters (markets are not stores for porters, 4.1).
- Economy: no change. Goal type 11 reads `Player.relations`, which `setRelation` keeps symmetric.
- The embassy's operator job (ejects foreign occupants, 8.3): the errand leaves the foreign
  embassy by itself 10 ticks after the decision, so the existing 0x22 job may stay as it is.

### For the AI task later

`diplomacy.offer(embassy, targetRace, state)`, `diplomacy.setAccept(race, from, 'peace' |
'ceasefire', on)`, `diplomacy.accepts(target, sender, state)`, `diplomacy.errand(race)`,
`trade.computerSettings(town)` (4.6 settings table), `trade.partners(town, true)` (with the AI
flag test), `trade.startRoute(merchant, from, to, false)`, `trade.routeOf(merchant)`.

## 3. HUD

### `src/client/hud-pages.ts`

```ts
import { marketPage, tradeRoutePage, diplomacyPage, marketPagesAllowed } from './hud-pages-trade.ts';

// drawPage(): replace the comingSoon() line
    case 9: return marketPage(pc, true);
    case 10: return marketPage(pc, false);
    case 11: return tradeRoutePage(pc);
    case 12: return diplomacyPage(pc);

// pageFor(): pages 9/10 only for a finished market of the own race or a race at peace (5.1)
  if (p === 9 || p === 10) return marketPagesAllowed(w, host.player, e) ? p : 0;
// and keep 11/12 to their object types (a remembered "selected" page must not leak)
  if (p === 11 && !(e.kind === KIND_UNIT && (e.oid & 0xffff) === 28)) p = 0;
  if (p === 12 && !(e.kind === KIND_BUILDING && (e.oid & 0xffff) === 42)) p = 0;
```

`comingSoon()` can then be deleted.

### `src/client/hud.ts` `drawFunctionBar()` (3.4)

The market buttons are shown for own and foreign markets, and are disabled until the market is
built and, for a foreign market, unless the races are at peace:

```ts
      if (sel.length === 1 && e.kind === 1 && (e.oid & 0xffff) === 48) {
        const ok = marketPagesAllowed(w, host.player, e);
        items.push({ sprite: 'VERKAUF', tip: 46, page: 9, disabled: !ok }, { sprite: 'EINKAUF', tip: 49, page: 10, disabled: !ok });
      }
```

The `DIPLOMATIE` (embassy) and `HANDEL` (own merchant) buttons are already there.

### Optional: foreign embassies selectable only with contact (3.4 side effects)

"Leaving 0 makes the other's active embassies selectable, returning to 0 hides them": a client
selection filter can use `world.diplomacy.relation(player, e.owner) > 0` for foreign embassies.

## 4. Commands sent by the pages

| page | command |
|---|---|
| market | `{ type: 'market', player, town, good, field: 'sell'\|'buy'\|'minStock'\|'maxStock'\|'minPrice'\|'maxPrice', value }` |
| trade route | `{ type: 'route', player, unit, action: 'set', from, to }` (-1 keeps the stored end; both ends start at once), `{ ..., action: 'start' \| 'stop' }` |
| diplomacy | `{ type: 'diplomacy', player, action: 'offer', embassy, race, state }`, `{ ..., action: 'accept', race, kind: 'peace' \| 'ceasefire', value }`, `{ ..., action: 'recall', embassy }` |

## 5. Deviations and open points (ours)

- Market commands set one field at a time (the original sends all six fields of a good); this
  avoids lost updates when several slider moves are in flight in lockstep.
- "Stop route" pauses with a data flag (the job polls every 599 ticks) instead of the scheduler's
  `hold`, because a cancelled job with `hold > 0` would never leave the timing wheel. "Start"
  replaces the paused job with a new one that begins at the origin, like the original's route
  command with both towns. A paused merchant finishes his current step and stands.
- A route `set` with one end merges with the other end stored in the merchant's current route
  (the original creates a paused job with only the given end; its panel keeps the other selection).
- The receiving side of refused offers gets no advisor line (Mentor.tdb 82..87 have no text).
- Advisor lines go to human players only (computer players have no advisor, 1.14).
- A diplomat left standing outside (no foreign embassy to go to) can still be sent again or
  recalled from the panel.
- The trade route page's good buttons only show the carried good (no simulation counterpart,
  4.5 / 7 item 6). The diplomacy page's offer buttons and recall portrait positions are ours
  (side-panel.md gives x = 150 for the offers and (135,195) for the portrait, which overlap).
- Not implemented here (AI task): computer acceptance flags and offers (3.5), the AI merchant
  assignment (4.6 second half). `trade.computerSettings` (4.6 first half) is implemented but not
  called by anything yet.
