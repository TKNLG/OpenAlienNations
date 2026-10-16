# Alien Nations rebuild (an-rebuild)

A from-scratch reimplementation of *Alien Nations / Die Völker* (Neo / JoWooD, 1999-2000)
that runs in the browser, self-hosted on your own server, with multiplayer. It plays with the
data files from your own copy of the game (GOG). **This project never contains or distributes
game files.**

## Download and play

You need Alien Nations installed on your computer: the GOG version, or the CD / Gold Edition.
Get the newest download from the [Releases](../../releases) page.

**Windows**

1. Download `AlienNations-<version>-windows-x64.exe` and double-click it. The file is not
   signed, so Windows SmartScreen warns about an "unrecognized app": click **More info**, then
   **Run anyway**.
2. The first time, it asks for your game folder: the folder that contains `Data` and `Bin`
   (for example `C:\GOG Games\Alien Nations`). An install it finds is already pre-selected. The
   choice is remembered in `%APPDATA%\AlienNations\config.json`.
3. Your browser opens the game. A console window shows the addresses; keep it open while you
   play, close it to stop. If Windows Firewall asks, allow access on private networks for
   multiplayer (singleplayer works either way).

**Linux (x64)**

```
tar xzf AlienNations-<version>-linux-x64.tar.gz
./AlienNations
```

It asks for your game folder once (a dialog with zenity or kdialog, otherwise in the terminal;
a Wine/Lutris install works, e.g. `~/.wine/drive_c/GOG Games/Alien Nations`), remembers it in
`~/.config/aliennations/config.json` and opens the browser.

**Multiplayer:** whoever hosts runs the game as above. The console lists the addresses friends
can open, e.g. `http://192.168.1.20:8080/`: on the same network directly, over the internet via
a VPN such as Tailscale, ZeroTier or Hamachi (use the VPN address), or by forwarding the TCP port
on your router.

**Good to know:** `--setup` chooses the game folder again; `--port 9000` picks a port (without
it, a busy 8080 moves on to 8081 ...); `--no-browser` does not open the browser; `--help` lists
everything. The console and the dialogs speak German on a German system and English otherwise;
`--lang de` or `--lang en` (or the environment variable `AN_LANG`) chooses. The soundtrack is taken from the game's `Bin/music` (GOG) or from another GOG install
found on the computer; for a CD install give a folder with the tracks via `--music <folder>`.

**Server / NAS:** the Docker image `ghcr.io/tknlg/aliennations` runs the server without any
launcher behaviour, see [Docker / Unraid](#docker--unraid) below.

Started 2026-10-14. It succeeds an earlier ddraw-proxy patch project (`an-patch`), whose
measurements carry over.

## Ground rules

1. **No game data in the repo or in releases.** Each deployer copies the `Data/` folder (plus
   `Bin/music`) from their own install onto their server.
2. **Clean-room split.** `re/` (Ghidra project, decompiler dumps) is the *analysis* side. Its
   only product is the specs in `docs/`, written in plain language. The engine and client
   (`engine/`, `client/`, `server/`, once they exist) are written **from `docs/` only**, never
   by translating decompiler output. `re/` is never published.
3. **Determinism from day one.** The simulation runs in lockstep on every client: integer and
   fixed-point maths only, a seeded PRNG, no `Math.random`, no float in sim state, and no
   iteration over unordered maps.

## Target architecture

- **server** (Docker container on a NAS): serves the client, serves the deployer's game
  files from a mounted folder, hosts lobbies, and relays lockstep commands over WebSocket.
- **client** (browser): WebGL/Canvas renderer, UI, input, audio (WAV/OGG are native).
- **engine** (shared, runs in the browser): deterministic simulation. The same code can run
  headless in Node for replays and desync checks.
- Language: TypeScript end to end, **zero runtime and build dependencies** (Node's built-in
  type stripping; the browser loads native ES modules).

No GPU is needed anywhere: it is 2D sprite rendering.

## Layout

```
docs/formats/   file format specs (the clean-room boundary)
tools/          python format readers / exporters used for verification
re/             Ghidra project, AN.exe copy, decompiler dumps  (analysis only, never published)
out/            generated previews (contains game art -- never published)
```

## Status

| area | state |
|---|---|
| sprites `.gd` | decoded (all frames, alpha); TS reader with lazy range loading |
| terrain `.os`, fonts `.dvf`, text `.tdb` | decoded |
| maps `.dvm`, missions `.mdb` | decoded; terrain is **generated from a seed**, generator rebuilt bit-exact and validated against all 35 maps |
| objects `dv.OD` | decoded: object id -> anchor, bounds, sprite per animation slot |
| rules `dv.odb`, research `DV.idb`, weapons `dv.wdb` | fully decoded |
| projection | isometric heightfield, 64x44 px cells; documented |
| **browser map viewer** | **working**: any campaign mission, terrain + objects, scroll/zoom, wrap-around |
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

## Running it

Requirements: Node.js 22 or newer. Nothing else, no internet.

```
node build.mjs                                   # builds dist/ (no dependencies)
node dist/server.mjs --game "C:\GOG Games\Alien Nations"
# open http://localhost:8080/
```

`--game` points at your installed game (the folder that contains `Data` and `Bin`). The server
only reads it. Options: `--port 8080`, `--host 0.0.0.0` (env: `AN_GAME`, `AN_PORT`, `AN_HOST`);
`--help` lists all. An explicit `--port` / `AN_PORT` must be free; without one, the next free port
after 8080 is used. The console prints the local URL and the LAN / VPN URLs for other players,
in German or English after the system language (`LANG` etc.; `--lang de|en` or `AN_LANG`
chooses; a Docker container without `LANG` speaks English unless given `-e AN_LANG=de`).

The release executables (`node tools/sea/build-sea.mjs`, Node single executable application)
are this same server with the client and `hd/` embedded, plus launcher behaviour: without
`--game` / `AN_GAME` they use the saved game folder or ask for it (`--setup` / `--reset` asks
again; `node dist/server.mjs --setup` does the same), and they open the browser unless
`--no-browser` is given, `--host` was set (a server setup) or there is no desktop (Linux without
`DISPLAY` / `WAYLAND_DISPLAY`). `--open` opens the browser from a plain node run too.
Maintainers: [docs/release.md](docs/release.md).

Music: the GOG version has the soundtrack in `Bin/music`. A Gold Edition install played its music
from the CD, so give the server a soundtrack folder: `--music "C:\GOG Games\Alien Nations\Bin\music"`
(env `AN_MUSIC`), or any folder with the tracks 2..11 as `.ogg`, `.mp3`, `.flac` or `.wav`
(e.g. ripped from the CD; names like `Track02.ogg` or `02 - ....mp3`).

HD UI: the server serves the upscaled menu and panel art from the repository's `hd/` folder
(override with `--hd <dir>`, env `AN_HD`). Players can switch it off in the graphics settings.
Rebuild it from an install with `python3 tools/hdpack/build_hdpack.py --game <Data> [--game <Gold data>]`.

### Docker / Unraid

Released images: `docker run -d -p 8080:8080 -v "/path/to/Alien Nations:/game:ro" ghcr.io/tknlg/aliennations`
(amd64 and arm64). Or build it yourself: `docker build -t an-rebuild .` (self-contained, no
`node build.mjs` needed first), then run it with your game folder mounted read-only at `/game`
and port 8080 published (details in the `Dockerfile`). The image contains only the built server,
the client and the HD UI pack, never game data.

Development: `npm test` (set `AN_DATA` to the game's Data folder and `AN_GOLD` to the Gold
Edition's data folder for the data-driven tests; they skip otherwise), type-check with
TypeScript 5.6 (`tsc -p .`).

## Tools

- Ghidra 12.1.4 headless, project `re/ghidra-proj/AN.gpr` (AN.exe from GOG,
  md5 `c2d2562e6b678bf241fe6cd0e3ec2e3b`); `re/` is private and git-ignored, see
  [docs/status.md](docs/status.md) §2 for how to regenerate it.
- `tools/ghidra/DumpAll.java` exports `re/dump/decomp.c`, `strings.txt`, `imports.txt`;
  `tools/ghidra/RecFields.java` lists `dv.odb` record field accesses.
- `tools/gd.py list|sheet|png`, `tools/os_sheet.py`, `tools/dvf_sheet.py`.
