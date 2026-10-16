# Cutting a release

Releases are built by `.github/workflows/release.yml` when a tag `v<version>` is pushed.

1. Bump `"version"` in `package.json` (the server reports it in `/api/info`, `--version` and
   the console; the workflow refuses a tag that does not match it).
2. Commit, then tag and push:
   ```
   git commit -am "Release 0.2.0"
   git tag v0.2.0
   git push origin main v0.2.0
   ```
3. The workflow type-checks and tests, then builds in parallel:
   - `AlienNations-<version>-windows-x64.exe` and `AlienNations-<version>-linux-x64.tar.gz`:
     Node single executable applications (`tools/sea/build-sea.mjs`: esbuild bundles the
     server into one CommonJS file, the client and `hd/` are embedded as SEA assets, postject
     injects the blob into the runner's `node` binary). esbuild and postject are fetched with
     `npx` in CI only; the project itself stays dependency-free.
   - `ghcr.io/<owner>/aliennations:<version>` (+ `latest`), amd64 and arm64, from the `Dockerfile`.
4. The `release` job creates the GitHub Release with both downloads and `SHA256SUMS.txt`, with
   short download instructions followed by the generated changelog. Edit the text on GitHub if
   needed.

A dry run: Actions -> release -> "Run workflow" on a branch builds everything and keeps the
executables as workflow artifacts, without a release or an image push. Running it on a tag
publishes that tag.

## What goes into a release

Our code, the built client and the HD UI pack `hd/` (project decision). **Never game data**:
nothing from `re/`, `ref/`, `out/`, `gamedata/`, and no file with a game extension (the `check`
job fails if any such file is tracked). Players point the program at their own install.

## Notes

- The Node version is pinned by `NODE_VERSION` in the workflow (an LTS line; pin an exact
  version for reproducible builds). The executables are that Node binary plus our blob.
- The launcher texts (console, dialogs, `--help`) are German or English, chosen by the system
  language, `--lang de|en` or `AN_LANG` (`src/server/i18n.ts`; a new text needs both languages,
  `test/i18n.test.ts` checks it). The release notes the workflow writes are English.
- The actions in the workflow are pinned to major versions that run on Node 24 (checkout v7,
  setup-node v7, upload-artifact v7, download-artifact v8, docker/setup-buildx v4, login v4,
  metadata v6, build-push v7).
- The executables are unsigned, so Windows SmartScreen shows "More info -> Run anyway"
  (documented in the README). Signing needs a code-signing certificate; the build removes
  node.exe's own (then invalid) signature with `signtool` when the Windows SDK is present.
- Local build: `node tools/sea/build-sea.mjs` -> `build/sea/AlienNations[.exe]`. Set `ESBUILD`
  or `POSTJECT` to a command line to use local copies instead of `npx`.
- Releases and packages of a private repository are only visible to people with access to
  it. For public downloads make the repository public, and set the ghcr.io package to public
  (Packages -> aliennations -> Package settings -> Change visibility).
- The workflow needs Actions enabled and, for the image, "Read and write permissions" or the
  `packages: write` permission it requests (Settings -> Actions -> General -> Workflow permissions).
