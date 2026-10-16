# CLAUDE.md: working on the Alien Nations rebuild

Read this first, then `docs/status.md` (project state, open items, reverse-engineering workflow,
things already tried). If `local/NOTES.md` exists (git-ignored, machine-specific notes such as
where the game installs are), read it too.

## What this is

A from-scratch, clean-room rebuild of *Alien Nations / Die Völker* (1999) plus the Gold Edition
add-on, running in the browser, served by a small zero-dependency Node server that reads the
player's own game files. Deterministic lockstep simulation (singleplayer, multiplayer, computer
players), IndexedDB saves, HD UI pack, packaged as a Windows .exe / Linux binary / Docker image.

**Goal:** the default ("vanilla") mode reproduces the original exactly, quirks included. Comfort
features exist only as opt-in "enhanced" options (Einstellungen → Erweitert; roadmap in
`docs/roadmap.md`), off by default. Never "improve" vanilla behaviour; if the original is odd,
copy it and note it.

## Ground rules (project decisions, non-negotiable)

1. **Clean-room split.**
   - Reverse engineering (`re/`, Ghidra projects, decompiler dumps, disassembly) produces
     **plain-language specs in `docs/` only**: prose and tables, constants, addresses for
     reference. No pasted, translated or transliterated code, no pseudo-code copies.
   - Implementation (`src/`) is written **only from `docs/`**, never while looking at `re/` or a
     decompile. When delegating, give RE and implementation as two strictly separated phases.
2. **Never publish or redistribute** game data, extracted art, `re/`, `ref/`, `out/`,
   `gamedata/`, `rec/`, decompiles. The repo excludes them (`.gitignore`; the release workflow
   also checks). The manual/handbook may only be paraphrased.
   **Exception (project decision):** the upscaled HD UI pack `hd/` ships with the server and
   releases, with an on/off switch.
3. **The game folder may be modified freely.** Anything destructive outside it: investigate
   read-only, present a plan with exact commands, wait for a go-ahead.
4. **Commit and push regularly** to `origin main`; leave the working tree clean at the end of a
   session. Plain commit messages: no Co-Authored-By or session-link trailers (project decision).
5. The game UI is German; docs, code and comments are English.
6. Keep the tree neutral: no personal data, machine-specific paths or environment details in
   tracked files. Those go into the git-ignored `local/` folder.

## Toolchain

- TypeScript run directly by Node's type stripping: **no enums, no parameter properties, no
  namespaces; imports use the `.ts` extension.** Zero runtime dependencies.
- Type check: `npx tsc -p .` (CI uses typescript@5.6.3; any local copy of that version works).
  Node's own types are a minimal shim in `types/node-min.d.ts`: extend it when a test or the
  server uses a new Node API (e.g. `assert.notEqual`, `Buffer`).
- Build: `node build.mjs` → `dist/` (`dist/server.mjs`, `dist/public/` client, `dist/package.json`).
- Tests: `node --test --experimental-strip-types --no-warnings "test/**/*.test.ts"` with
  `AN_DATA=<game>/Data` and `AN_GOLD=<gold game>/data` set (data-driven tests skip without them;
  all green). The local `test()` typing is `test(name, {opts}, fn)`.
- Run: `node dist/server.mjs --game "<game folder>" --host 0.0.0.0 --port 8080 --music "<GOG>\Bin\music"`
  (`--help` lists all; `--hd`, `--lang`, `--setup`, `--no-browser`). Restart the server when
  `dist/server*` changed; client changes need only Ctrl+F5.
- Release: see `docs/release.md` (bump `package.json`, tag `vX.Y.Z`, push; GitHub Actions builds
  the SEA .exe/Linux binary + Docker image; "Run workflow" on a branch = dry run with artifacts).

## Engine conventions

- **Determinism:** simulation randomness only through the world RNG, in the original's `rand()`
  call order (the specs say where draws happen). Display-only randomness may use `Math.random`.
  Display state must never feed back into the simulation. Idle fidgets etc. are lockstep commands.
- **Snapshots:** `SNAPSHOT_VERSION` in `src/engine/world.ts`. Any change to
  persistent state: bump it, add a restore migration from the previous version, include the field
  in `hash()`. Old saves must keep loading. Generated maps (free play, island free play) are not
  stored in saves; they are rebuilt from the seed via `src/world/free-play.ts`.
- **Commands** go through `World` command handling (also used by multiplayer peers): validate
  there, not only in the client (e.g. criminals are not commandable).
- Advisor lines: sim side `notify(race, mentor, queue, interval)` with per-line cooldowns
  (`docs/ui/side-panel.md` §1.1); client playback in `src/client/advisor-voice.ts`.

## How to work (works well, keep it)

- **Fidelity first:** vanilla = the original exactly. Quirks stay. Comfort only behind enhanced
  options, off by default.
- Issues usually arrive in batches from play-testing. Group them, and run **parallel background
  agents**, each with a two-phase brief (RE spec → implement from docs), the exact toolchain
  lines above, the files other agents are touching ("re-read shared files before each edit",
  "take the next free SNAPSHOT_VERSION"), and "do not commit". The coordinator commits, runs the
  full suite + build, pushes, and reports briefly what changed. Work autonomously; ask only when
  a decision really needs the maintainer.
- When a remembered behaviour and the code disagree, re-derive from the exe at instruction level
  (decompiler output has misled us several times; confirm branches in the `objdump` listing),
  report honestly what the original does, and offer an enhanced option if the remembered
  behaviour is wanted. Memory is usually right about *what it felt like*, the code about *the
  rules*; differences often had a third cause (e.g. the crop-conversion bug causing early
  criminals).
- Verify visuals yourself before claiming a fix: UI changes in headless Chromium (Playwright)
  with screenshots (`tools/shot.py` and the other `tools/*_test.py` scripts).
- Settings UI style: the "Erweitert" menu uses the game's own widgets and German labels; keep new
  options consistent with it.
