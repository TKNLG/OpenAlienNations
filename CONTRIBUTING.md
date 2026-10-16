# Contributing to OpenAlienNations

Contributions are welcome: report bugs and differences from the original game as
[issues](https://github.com/TKNLG/OpenAlienNations/issues), send fixes as pull requests.

## Where to start

- [CLAUDE.md](CLAUDE.md): the project rules, toolchain and engine conventions. Read it first.
- [docs/status.md](docs/status.md): project state, open items, feature overview, documentation map.
- [docs/release.md](docs/release.md): how release builds (Windows `.exe`, Linux binary, Docker
  image) are made.
- The specifications of the original game are in [`docs/`](docs/) (formats, rules, rendering, UI,
  architecture).

## Build, run and test

Requirements: Node.js 22 or newer; no other dependencies.

```
node build.mjs                                           # build into dist/
node dist/server.mjs --game "/path/to/Alien Nations"     # run, then open http://localhost:8080/
npx -p typescript@5.6.3 tsc -p .                         # type check
npm test                                                 # tests
```

The data-driven tests need your own game files:

- `AN_DATA=<game>/Data`: the `Data` folder of a base game install (e.g. GOG).
- `AN_GOLD=<Gold Edition>/data`: the `data` folder of a Gold Edition install.

Without them those tests are skipped. All options of the server: [docs/options.md](docs/options.md).

## Clean-room rule

The original program is analysed only to write plain-language specifications in
[`docs/`](docs/); the code is written only from those docs, never from decompiled code.
Analysis material (`re/`) and game files are never published. Details in [CLAUDE.md](CLAUDE.md).

## Fidelity

The default mode reproduces the original exactly, quirks included. Comfort features go behind
the optional **Erweitert** settings, off by default.

## Commits

Plain commit messages that say what changed. No Co-Authored-By or session-link trailers
(project decision). Keep the tree neutral: no personal data or machine-specific paths in tracked
files.
