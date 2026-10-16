# Command-line options

All options work with the Windows `.exe`, the Linux binary and `node dist/server.mjs`. Most can
also be set with an environment variable (a command-line option wins over the variable).
`--help` prints the same list.

Back to the [README](../README.md).

| Option | Environment variable | What it does |
|---|---|---|
| `--game <folder>` | `AN_GAME` | your Alien Nations folder (the one containing `Data` and `Bin`); skips the folder question. See [install.md](install.md#the-game-folder) |
| `--music <folder>` | `AN_MUSIC` | soundtrack folder, used when the game folder has no `Bin/music`. See [install.md](install.md#music) |
| `--hd <folder>` | `AN_HD` | use the HD interface pack from this folder instead of the built-in one (an empty folder = no HD pack) |
| `--port <n>` | `AN_PORT` | network port (default 8080). Without it, the next free port is used if 8080 is busy; with it, that exact port must be free |
| `--host <address>` | `AN_HOST` | address to listen on. Default `0.0.0.0` = this computer and your network; `127.0.0.1` = only this computer |
| `--setup` or `--reset` | | choose the game folder again |
| `--no-browser` | | do not open the browser automatically |
| `--open` | | open the browser (a plain `node dist/server.mjs` run does not by default) |
| `--lang de` / `--lang en` (or `--lang=de`) | `AN_LANG` | language of the console and dialogs (default: the system language) |
| `--version` (or `-v`) | | print the version |
| `--help` (or `-h`) | | list all options |

## When the browser opens

The browser opens automatically for the `.exe` and the Linux binary, unless you give
`--no-browser` or `--host` (or `AN_HOST`), or there is no desktop (for example over SSH).
A plain `node dist/server.mjs` run opens it only with `--open`.

## Examples

```
OpenAlienNations.exe --setup
./OpenAlienNations --music "/path/to/music" --port 9000
node dist/server.mjs --game "/path/to/Alien Nations" --lang en --open
```

Docker containers take the same settings as environment variables, see [server.md](server.md).
