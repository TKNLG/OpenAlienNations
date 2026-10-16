# Installing: game folder, add-on and music

OpenAlienNations contains no game files. It reads them from your own installed copy of
Alien Nations / Die Völker. This page explains which folder to choose, when the Gold Edition
add-on is used, where the music comes from, and where your choice is saved.

Back to the [README](../README.md).

## The game folder

You always point OpenAlienNations at **one game folder**: the folder that contains the `Data`
folder (with the file `dv.gd` in it) and the `Bin` folder. Choose that folder itself, not a
folder inside it. Upper/lower case of folder and file names does not matter (`Data` or `data`,
`Bin` or `bin`).

| What you have | What to choose as the game folder | What you get |
|---|---|---|
| GOG version (e.g. `C:\GOG Games\Alien Nations`) | that folder | base game with music. The GOG version does not include the add-on. |
| CD version (base game) | the install folder | base game; for music see [Music](#music) |
| Gold Edition (base game + add-on on one CD) | the Gold Edition install folder | base game **and** add-on; for music see [Music](#music) |

A Wine or Lutris install works too, e.g. `~/.wine/drive_c/GOG Games/Alien Nations`.

### First start

- **Windows `.exe`:** the first time, it asks for your game folder. If it found an install, that
  one is already selected; otherwise pick the folder that contains `Data` and `Bin`.
- **Linux binary:** the first time, it asks for your game folder with a dialog (zenity or
  kdialog) or in the terminal.
- Starting with `--game <folder>` (or the environment variable `AN_GAME`) skips the question.
  A plain `node dist/server.mjs` run does not ask (unless started with `--setup`); it uses
  `--game`, `AN_GAME`, or `./game`.

If you get "Not an Alien Nations folder", pick the folder that contains `Data` (with `dv.gd`)
and `Bin`, not a folder inside it.

## The Gold Edition add-on

OpenAlienNations works with the **base game alone** and with the **Gold Edition** (base game +
add-on).

**When do the add-on menus appear?** When the game folder's `Data` folder contains the add-on
files:

- `Addon.odb`, `Addon.gd`, `Addon.od`, `Addon.tdb`, `addon.wdb`
- the `...AO.mdb` / `...AO.dvm` mission and map files

A Gold Edition install has all of them. Then the single-player menu shows the add-on campaigns
("Addon Kampagnen") and the free-play and multiplayer settings get an "Addon:" switch for the
island world. Without these files the menus look like the base game and everything else works
normally.

**Same folder.** Base game and add-on must be in the **same** folder: use the Gold Edition
install folder itself. Copying only the add-on files into a GOG folder is not supported, because
the Gold Edition also has its own versions of some base files (for example the menu art).

**GOG has no add-on.** The GOG version contains only the base game. For the add-on you need the
Gold Edition.

## Music

The game looks for the soundtrack in this order:

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

In Docker, mount the music folder and set `AN_MUSIC`, see [server.md](server.md#music-in-a-container).

## Where your choice is saved

The Windows `.exe` and the Linux binary save the chosen game folder (and the music folder they
found), so the next start goes straight to the game:

- Windows: `%APPDATA%\OpenAlienNations\config.json`
- Linux: `~/.config/openaliennations/config.json` (or `$XDG_CONFIG_HOME/openaliennations/` if set)
- macOS: `~/Library/Application Support/OpenAlienNations/config.json`

`--help` also prints the path used on your computer.

Older builds saved the choice in an `AlienNations` folder (`aliennations` on Linux); it is taken
over automatically.

## Changing the game folder

To choose again, start it once with `--setup` (or `--reset`), for example
`OpenAlienNations.exe --setup` from a command prompt, or `./OpenAlienNations --setup`.
Starting with `--game <folder>` uses that folder for this run without asking.
