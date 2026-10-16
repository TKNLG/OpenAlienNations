# Project status (2026-10-16)

State of the project, open items and the reverse-engineering workflow. Read `CLAUDE.md` first for
the rules and toolchain.

## 1. Where everything is

| What | Where | In git? |
|---|---|---|
| Source, tests, docs, HD UI pack | this repo (GitHub `TKNLG/OpenAlienNations`, branch `main`; GPL-3.0-or-later, see `LICENSE` / `NOTICE`) | yes |
| Original game, base (GOG) | any install, e.g. `C:\GOG Games\Alien Nations` (`Bin\music` = soundtrack; `Data` = `AN_DATA`) | no |
| Original game, Gold Edition (add-on) | any install; its `data` folder = `AN_GOLD`, the install itself works as `--game` | no |
| Reverse-engineering output | `re/` in the repo folder (see §2) | **never** (git-ignored) |
| Ghidra scripts used to produce `re/` | `tools/ghidra/` | yes |
| Older ddraw-proxy patch project `an-patch` (predecessor; measurements on `.gd`, sidebar, the proxy the runtime recorder loads through) | separate project | no |

## 2. Reverse-engineering material (private, never publish)

`re/` is the private analysis folder. It is git-ignored and never published or released; only the
plain-language specs in `docs/` come out of it. It can be regenerated from your own copies of the
game executables:

- `re/bin/AN.exe` (GOG base exe) and `re/bin2/dvge.exe` (Gold Edition exe): copies of your own
  installed files, for Ghidra.
- `re/ghidra-proj/`, `re/ghidra-proj-gold/`: Ghidra 12.1.4 projects (auto-analysed). Ghidra
  12.1.4+ needs JDK 21+.
- `re/dump/decomp.c` (every function decompiled, `// ===== <addr> <name>` separators),
  `strings.txt` (defined strings with referencing functions), `imports.txt`; `re/dump-gold/` the
  same for dvge.exe. Produced headless with the scripts in `tools/ghidra/`:
  `analyzeHeadless <projdir> <name> -import <exe> -scriptPath tools/ghidra -postScript DumpAll.java <outdir>`
  (use `-process <exe>` instead of `-import` on an existing project). `RecFields.java <outfile>`
  lists accesses to `dv.odb` record fields.
- `re/asm/an.asm`: `objdump -d -M intel re/bin/AN.exe` (Intel syntax). **Confirm important
  branches here**: the decompiler has misread conditions several times.
- Optional working material, kept in `re/` too: per-function extracts and notes, text-table
  dumps (`DV.tdb`, `Mentor.tdb`), and simulation harnesses for AI/economy diagnosis (TypeScript
  runners that import `src/` and print metrics; tools, not tests).

Addresses in the docs refer to the GOG `AN.exe` unless marked Gold. All specs (docs/) cite the
addresses they were derived from, so any claim can be re-checked.

## 3. Documentation map (`docs/`)

- `formats/`: every file format (gd sprites, odb/od objects, mdb missions, dvm maps, idb/wdb,
  tdb texts, add-on formats, terrain generation, world populate).
- `game/`: rules. `units-and-jobs.md` (jobs, walking §4, transports §5, construction §6,
  harvesting §7, operators §8, training §9), `combat.md` (attack, flee, police/criminals §12,
  garrisons), `economy.md` (needs, happiness, births, research, finances), `ai-diplomacy-trade.md`
  (computer players, raids, diplomacy), `fog-of-war.md`, `addon.md`, `editions.md`.
- `rendering/`: projection, terrain drawing, objects/picking, unit motion, projectiles, territory.
- `ui/`: front-end menus, side panel (incl. advisor §1.1), cursors.
- `architecture/`: simulation/lockstep, multiplayer, AI integration with the list of remaining
  deviations (`integration-ai.md` §7, §7a–c), add-on integration, runtime recorder.
- `roadmap.md` (vanilla now / enhanced later), `release.md`.

## 4. Current state

Test suite green (336 tests with the game data set; data-driven tests skip without it); release
workflow verified by dry runs (Windows .exe, Linux binary, Docker image build); the .exe and the
Linux binary were tested on Windows and Linux. Not yet released (no tag).

Recently fixed and confirmed in play-testing: minimap, saves (http origins, add-on island
terrain), side panel looks/hover, hunting, projectiles, territory/border stones, doors, advisor
behaviour, training/retraining, residences/leisure, operators on duty (police, embassy, farm,
news round), construction site panel + pause, AI deviations A–T, transport/walking engine.

### Feature overview (moved here from the README)

Architecture: a zero-dependency Node **server** (serves the client and the operator's game files
from a read-only folder, hosts lobbies, relays lockstep commands over WebSocket), a browser
**client** (WebGL2 renderer, UI, input, audio) and the deterministic **engine** shared by both
(runs headless in Node for tests and replays). Details: `docs/architecture/`.

| area | state |
|---|---|
| sprites `.gd` | decoded (all frames, alpha); TS reader with lazy range loading |
| terrain `.os`, fonts `.dvf`, text `.tdb` | decoded |
| maps `.dvm`, missions `.mdb` | decoded; terrain is **generated from a seed**, generator rebuilt bit-exact and validated against all 35 maps |
| objects `dv.OD` | decoded: object id -> anchor, bounds, sprite per animation slot |
| rules `dv.odb`, research `DV.idb`, weapons `dv.wdb` | fully decoded |
| projection | isometric heightfield, 64x44 px cells; documented |
| ground blending, shoreline tiles | **done** (bilinear corner blending, 14 shoreline tiles, animated water) |
| simulation core | deterministic ticks, commands, A* on the wrapping map, step timing from dv.odb, footprints, group moves, snapshots |
| multiplayer | lobby + lockstep relay over WebSocket (zero-dependency server), desync detection; tested with 2 real clients |
| savegames | IndexedDB + export/import (.ansave, gzip) |
| economy | nations, towns, rounds (tax, upkeep, research), food and luxury consumption, needs, happiness, births, criminals, decay, storage, mission goals (docs/game/economy.md) |
| units and jobs | job scheduler like the original; porters and dispatcher, door queues, construction sites and builders, production, gathering, farms, operators (docs/game/units-and-jobs.md) |
| combat | attack/strike/impact pipeline, damage, hit chance, ranks and experience, line of fire, help radius and retaliation, flee, patrols, outposts, two-phase building collapse with rubble, town destruction, criminals, police arrests, priests (docs/game/combat.md) |
| UI | menus in the original 800x600 art (campaign progress, briefing, free play, settings, load/save, multiplayer lobby); race-specific side panel with all pages from the original layout (scales to any window), minimap, advisor messages with voice, sound effects, combat effects |
| diplomacy, trade | relations, embassies and diplomats with offers, markets and merchant trade routes (docs/game/ai-diplomacy-trade.md 3, 4) |
| computer opponents (AI) | profiles, town planner, gathering, training, research, defence, armies, scouts, founding, diplomacy and trade decisions (docs/game/ai-diplomacy-trade.md) |
| fog of war | explored / in sight per player, terrain, sprites, minimap, placement; MAGICEYE (docs/game/fog-of-war.md) |
| free play / random maps | world populator: nature clusters, point lists, start positions (docs/formats/world-populate.md); founding towns with the city founder |
| Gold Edition add-on (islands, ships) | add-on data, island maps and generator, AO campaigns and menus; harbours, shipyards, fishing, transport and war ships in the engine (docs/game/addon.md); ship UI in the side panel still to do |
| HD UI pack | menus and side panels upscaled 4x (Real-ESRGAN animevideov3, icons xBR x4 + unsharp), shipped in `hd/`, toggle "HD-Grafik" in the graphics settings (tools/hdpack) |
| enhanced options | optional comfort options that differ from the original, all off by default (= vanilla): selection rings, smooth movement, cursor hints, advisor queue; Einstellungen -> "Erweitert" (docs/roadmap.md) |
| building foundations, worn paths | buildings level and pave their ground permanently; busy routes become paths that speed units up (docs/game/units-and-jobs.md 6.6, 4.5) |

## 5. Open items

1. Recently done: border stones on water are original (verified, `territory.md` §2); advisor
   line 12 "fehlt ein Betreiber" implemented (`side-panel.md` §1.1.5); function-bar buttons test
   the active flag (§3.4).
2. (free)
3. **Runtime verification against the original**: a recorder for the running original (an
   in-process hook DLL logging RNG calls and per-tick state) and a replay harness in ours to
   compare tick by tick. Static reading cannot settle disputes like the police/criminal
   behaviour; this can. Plan and M0 results: `docs/architecture/runtime-recorder.md`
   (milestones M0..M5); tool: `tools/recorder/`.
4. Disputed with play-testers' memory of the original, currently kept as the code says (could be
   verified with 3): police manual orders cycle through the town's criminal list (remembered:
   sticking to the clicked one); criminal pauses only 50 ticks; AI-vs-AI raids can wipe out
   computer towns when the human has no town hall.
5. Add-on data quirks: SajikisAO 2 island ids, SajikisAO 8 goal ids, SajikisAO 4 reversed;
   an original Gold savegame of a free-play island game would verify the island generator.
6. AI: hunters still use the old auto-continue harvest (not the original hunting job); town-mode
   inhabitants command 0x43; mentor #16 condition; remaining deviations in
   `integration-ai.md` §7.
7. Enhanced-mode ideas in `roadmap.md` (smarter advisor queue, 8 players, HD game sprites,
   stronger AI, sticky police target if wanted).
8. Releases: optional exact Node 24 pin in the workflow; unsigned .exe (SmartScreen, Node icon).

## 6. Things tried and disproved (don't redo)

- REA (github.com/morluto/rea): an MCP layer over Ghidra/IDA/Hopper; no deeper analysis than
  what we have; its dynamic features target Linux/macOS processes, not a Win32 game.
  Re-checked 2026-10-16 (v6.5.0): Windows support is still "experimental" and read-only
  (26 Ghidra queries over a PE; 32-bit x86 only on main / 6.x). Process capture and the
  original-vs-rebuild capture comparison remain Linux/macOS only ("Native Windows capture is
  unavailable"). It would need a JDK + Ghidra install and adds nothing over our dumps + asm; the
  runtime side is covered by our own recorder (`docs/architecture/runtime-recorder.md`).
  Revisit only if it gains native Windows process capture.
- "Minimum island resources": the original guarantees none; poor islands are original.
- Completion animation replay: only for a founded town hall.
- Criminal birth/aggression and police manual orders: re-derived twice at instruction level;
  see `combat.md` §12 and open item 4.
- AI raids: all combat/AI numbers audited against the exe (`integration-ai.md` §7c); towns falling
  in sims come from the test setup (passive human), not wrong values.
