<p align="center">🇬🇧 <b>English</b> &nbsp;|&nbsp; 🇩🇪 <a href="README.de.md">Deutsch</a></p>

<p align="center"><img src="docs/images/banner-en.png" alt="OpenAlienNations"></p>

# OpenAlienNations

OpenAlienNations is an open-source remake of the 1999 strategy game **Alien Nations** (German:
**Die Völker**) that runs in your web browser. It plays the campaigns, tutorials and free play of
the original, the island campaigns and ships of the **Gold Edition add-on**, and **multiplayer**
with friends in the browser, optionally with a sharper **HD interface**.

It is **not** the game itself and contains **no game files**: it uses the files of your own
installed copy of Alien Nations.

**Status:** very close to the original, including its quirks. If something plays differently
from the original game, please [open an issue](../../issues).

## What you need

- **Alien Nations installed** on your computer: the GOG version, or the original CD /
  Gold Edition.
- **Windows** or **Linux** (64-bit x86). Or anything that runs **Docker** (server / NAS).
- A **modern web browser** (Chrome, Edge, Firefox, Safari).

## Base game and Gold Edition add-on

OpenAlienNations works with the **base game alone** and with the **Gold Edition** (base game +
add-on). You always point it at **one game folder**: the folder that contains the `Data` folder
(with the file `dv.gd` in it) and the `Bin` folder. Upper/lower case of folder and file names
does not matter (`Data` or `data`, `Bin` or `bin`).

| What you have | What to choose as the game folder | What you get |
|---|---|---|
| GOG version (e.g. `C:\GOG Games\Alien Nations`) | that folder | base game with music. The GOG version does not include the add-on. |
| CD version (base game) | the install folder | base game; music see below |
| Gold Edition (base game + add-on on one CD) | the Gold Edition install folder | base game **and** add-on; music see below |

**When do the add-on menus appear?** When the game folder's `Data` folder contains the add-on
files (`Addon.odb`, `Addon.gd`, `Addon.od`, `Addon.tdb`, `addon.wdb`, the `...AO.mdb` /
`...AO.dvm` mission and map files). A Gold Edition install has all of them. Then the
single-player menu shows the add-on campaigns ("Addon Kampagnen") and the free-play and
multiplayer settings get an "Addon:" switch for the island world. Without these files the menus
look like the base game and everything else works normally.

Base game and add-on must be in the **same** folder: use the Gold Edition install folder
itself. Copying only the add-on files into a GOG folder is not supported, because the Gold
Edition also has its own versions of some base files (for example the menu art).

**Music.** The game looks for the soundtrack in this order:

1. `Bin/music/Track02.ogg` … `Track11.ogg` in the game folder. The GOG version has these.
2. The folder given with `--music <folder>` (or the environment variable `AN_MUSIC`). Files in it
   are recognised by their track number, for example `Track02.ogg`, `track2.flac` or
   `02 - Title.mp3`; formats `.ogg`, `.mp3`, `.flac` or `.wav`. Tracks 2 to 11 are used.
3. The Windows `.exe` and the Linux download also find the `Bin/music` folder of another
   Alien Nations install on the same computer by themselves (for example a GOG install next
   to a Gold Edition), and remember it.

The CD and Gold Edition played their music straight from the CD (audio tracks), so their
install folder has no music files. Either have the GOG version installed as well, or rip the
CD's audio tracks 2–11 into a folder and pass it with `--music`. Without music the game runs
normally, just without background music.

## Download and play

Get the newest version from the [Releases](../../releases) page.

### Windows

1. Download `OpenAlienNations-<version>-windows-x64.exe` and double-click it.
2. The file is not signed, so Windows SmartScreen may warn about an "unrecognized app". Click
   **More info**, then **Run anyway**.
3. The first time, it asks for your game folder. If it found an install, that one is already
   selected; otherwise pick the folder that contains `Data` and `Bin`.
4. Your browser opens with the game. A console window shows the addresses. **Keep that window
   open while you play**; closing it stops the game server.
5. If Windows Firewall asks: allow access on private networks if you want to play with others
   (singleplayer works either way).

### Linux (x64)

```
tar xzf OpenAlienNations-<version>-linux-x64.tar.gz
./OpenAlienNations
```

The first time it asks for your game folder, with a dialog (zenity or kdialog) or in the
terminal. A Wine or Lutris install works too, e.g. `~/.wine/drive_c/GOG Games/Alien Nations`.
Then your browser opens with the game.

### Changing the game folder

Your choice is saved, so the next start goes straight to the game:

- Windows: `%APPDATA%\OpenAlienNations\config.json`
- Linux: `~/.config/openaliennations/config.json`
- macOS: `~/Library/Application Support/OpenAlienNations/config.json`

To choose again, start it once with `--setup`, for example `OpenAlienNations.exe --setup` from
a command prompt, or `./OpenAlienNations --setup`. (Older builds saved the choice in an
`AlienNations` folder; it is taken over automatically.)

## Playing with friends (multiplayer)

1. One player is the **host** and starts OpenAlienNations as above.
2. The console window lists the addresses for friends, for example `http://192.168.1.20:8080/`.
3. Friends open that address in their browser. They load everything, including the game files,
   from the host, so they **need nothing but a browser**.
4. In the game, the host opens a room in the multiplayer menu and the others join it.

How friends reach the host:

- **Same network (LAN / Wi-Fi):** use the address shown.
- **Over the internet with a VPN** such as Tailscale, ZeroTier or Hamachi: everyone joins the same
  VPN, then use the host's VPN address (the console lists it as well).
- **Port forwarding:** forward the TCP port (default 8080) on the host's router to the host's
  computer, then friends use the host's public IP address.

As with the original game, every player is expected to own a copy of Alien Nations.

## Options

All options work with the Windows `.exe`, the Linux binary and `node dist/server.mjs`. Most can
also be set with an environment variable.

| Option | Environment variable | What it does |
|---|---|---|
| `--game <folder>` | `AN_GAME` | your Alien Nations folder (the one containing `Data` and `Bin`); skips the folder question |
| `--music <folder>` | `AN_MUSIC` | soundtrack folder, used when the game folder has no `Bin/music` (see above) |
| `--hd <folder>` | `AN_HD` | use the HD interface pack from this folder instead of the built-in one |
| `--port <n>` | `AN_PORT` | network port (default 8080). Without it, the next free port is used if 8080 is busy; with it, that exact port must be free |
| `--host <address>` | `AN_HOST` | address to listen on. Default `0.0.0.0` = this computer and your network; `127.0.0.1` = only this computer |
| `--setup` or `--reset` | | choose the game folder again |
| `--no-browser` | | do not open the browser automatically |
| `--open` | | open the browser (a plain `node dist/server.mjs` run does not by default) |
| `--lang de` / `--lang en` | `AN_LANG` | language of the console and dialogs (default: the system language) |
| `--version` | | print the version |
| `--help` | | list all options |

The browser opens automatically for the `.exe` and the Linux binary, unless you give
`--no-browser` or `--host`, or there is no desktop (for example over SSH).

## In-game settings worth knowing

- **HD interface:** Settings (Einstellungen) → Graphics (Grafik) → **HD-Grafik** switches the
  upscaled menus and side panels on or off.
- **Enhanced options:** Settings → **Erweitert** has optional comfort features that differ from
  the original (selection rings, smoother movement, cursor hints, advisor queue). All are off by
  default; off means exactly the original behaviour.

(The menus use the game's own texts from your copy; the few menus added by OpenAlienNations are
labelled in German, like the original German release.)

## Server / NAS (Docker)

A ready-made image is published for amd64 and arm64. Mount your game folder read-only at `/game`:

```
docker run -d --name openaliennations -p 8080:8080 \
  -v "/path/to/Alien Nations:/game:ro" \
  ghcr.io/tknlg/openaliennations
```

Then open `http://<server address>:8080/`. With a soundtrack in another folder, add
`-v "/path/to/music:/music:ro" -e AN_MUSIC=/music`. For German console texts add
`-e AN_LANG=de`.

Docker Compose:

```yaml
services:
  openaliennations:
    image: ghcr.io/tknlg/openaliennations
    ports:
      - "8080:8080"
    volumes:
      - "/path/to/Alien Nations:/game:ro"
      # - "/path/to/music:/music:ro"
    # environment:
    #   AN_MUSIC: /music
    restart: unless-stopped
```

Unraid: add a container with this image, map port 8080 and a read-only path from your
Alien Nations folder to `/game`. To build the image yourself: `docker build -t openaliennations .`

## Saves

Saved games are stored **in your browser** (IndexedDB), separately for each browser and each
address. `http://localhost:8080/` and `http://192.168.1.20:8080/` (or another port) count as
different addresses with their own saves, and clearing the browser's site data deletes them.

To keep a backup or move saves to another browser or computer: in the **Spiel laden** (load
game) menu, use **Exportieren** to download a save as an `.ansave` file and **Importieren** to
load one back.

## Troubleshooting

- **"Port 8080 is already in use":** another program (or a second OpenAlienNations) uses it.
  Without `--port` the next free port is taken automatically; with `--port`, choose another
  one, e.g. `--port 9000`.
- **Firewall question on Windows:** allow private networks for multiplayer; singleplayer works
  without.
- **No music:** see [Music](#base-game-and-gold-edition-add-on) above; start with
  `--music <folder>`.
- **Add-on menus missing:** the chosen game folder must be the Gold Edition install, with the
  `Addon.*` files in its `Data` folder. Start with `--setup` to choose another folder.
- **"Not an Alien Nations folder":** pick the folder that contains `Data` (with `dv.gd`) and
  `Bin`, not a folder inside it.
- **Saves are gone:** check that you opened the same address and port as before (see
  [Saves](#saves)).
- **SmartScreen warning:** the download is not signed; click **More info** → **Run anyway**.

## For developers

Requirements: Node.js 22 or newer; no other dependencies.

```
node build.mjs                                           # build into dist/
node dist/server.mjs --game "/path/to/Alien Nations"     # run, then open http://localhost:8080/
npx -p typescript@5.6.3 tsc -p .                         # type check
npm test                                                 # tests
```

The data-driven tests need `AN_DATA=<game>/Data` and `AN_GOLD=<Gold Edition>/data`; they are
skipped without them. Release builds: [docs/release.md](docs/release.md).

**Clean-room rule:** the original program is analysed only to write plain-language
specifications in [`docs/`](docs/); the code is written only from those docs, never from
decompiled code. Analysis material (`re/`) and game files are never published.

Start with [CLAUDE.md](CLAUDE.md) (rules and toolchain) and [docs/status.md](docs/status.md)
(project state, open items, feature overview). Contributions are welcome: report bugs and
differences from the original as [issues](../../issues), send fixes as pull requests.

## License and legal

- The code and documentation of OpenAlienNations are licensed under the
  **GNU General Public License v3.0 or later** ([LICENSE](LICENSE)).
- The project contains **no game files**. You need your own original copy of the game.
- "Alien Nations" and "Die Völker" are trademarks of their respective owners. OpenAlienNations
  is an independent fan project and is not affiliated with or endorsed by them.
- The **HD interface pack** in `hd/` is upscaled from the original game's interface artwork, so
  it is **not** covered by the GPL; the original rights holders' copyright applies. It is
  included only so that owners of the game can use it, and it can be switched off or removed.
- The banner images in `docs/images/` show the remake running with the original game's artwork,
  so like `hd/` they are **not** covered by the GPL.

Details: [NOTICE](NOTICE).
