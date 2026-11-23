# FAQ and troubleshooting

Back to the [README](../README.md). Something not listed here, or something that plays
differently from the original game? Please
[open an issue](https://github.com/TKNLG/OpenAlienNations/issues).

## Troubleshooting

- **SmartScreen warning ("unrecognized app") on Windows:** the download is not signed. Click
  **More info**, then **Run anyway**.
- **Firewall question on Windows:** allow access on private networks if you want to play with
  others (multiplayer); singleplayer works without.
- **The game stopped when I closed the console window:** the console window is the game server.
  Keep it open while you play.
- **"Port 8080 is already in use":** another program (or a second OpenAlienNations) uses it.
  Without `--port` the next free port is taken automatically; with `--port`, choose another
  one, e.g. `--port 9000`.
- **No music:** see [Music](install.md#music); start with `--music <folder>`.
- **Add-on menus missing:** the chosen game folder must be the Gold Edition install, with the
  `Addon.*` files in its `Data` folder (see [install.md](install.md#the-gold-edition-add-on)).
  Start with `--setup` to choose another folder.
- **"Not an Alien Nations folder":** pick the folder that contains `Data` (with `dv.gd`) and
  `Bin`, not a folder inside it.
- **Wrong game folder remembered:** start once with `--setup` to choose again
  (see [install.md](install.md#changing-the-game-folder)).
- **Only works as administrator:** OpenAlienNations only reads the game folder; the one file it
  writes is its settings file in your user folder (`%APPDATA%\OpenAlienNations\config.json`).
  Administrator rights are never needed. Since 0.5.2 the console names every file or folder in the
  game folder that Windows does not let your user read (`! ... cannot be read and are skipped`);
  give your user read access to those (folder Properties → Security), or copy the game folder to
  a place of your own. Older versions stopped at the first such entry.
- **Sounds or texts from another install (for example English speech with German texts):** start
  with `--verbose`; the console shows the folder in use and the full path of every file the game
  loads. Versions before 0.5.2 let the browser keep game files for a day, so after switching
  installs it could still play the old ones: reload with Ctrl+F5 or clear the browser cache once.
- **Saves are gone:** check that you opened the same address and port as before (see
  [Saves](#saves)).
- **The browser did not open:** open the address shown in the console yourself. It does not
  open automatically with `--no-browser` or `--host`, or without a desktop (for example over
  SSH); see [options.md](options.md#when-the-browser-opens).
- **Friends cannot connect:** see [server.md](server.md#how-friends-reach-the-host).

## Saves

Saved games are stored **in your browser** (IndexedDB), separately for each browser and each
address. `http://localhost:8080/` and `http://192.168.1.20:8080/` (or another port) count as
different addresses with their own saves, and clearing the browser's site data deletes them.

To keep a backup or move saves to another browser or computer: in the **Spiel laden** (load
game) menu, use **Exportieren** to download a save as an `.ansave` file and **Importieren** to
load one back.

## Why are some menus in German?

The menus use the game's own texts from your copy. The few menus added by OpenAlienNations
(for example **Erweitert**) are labelled in German, like the original German release.

## In-game settings worth knowing

- **HD interface:** Settings (Einstellungen) → Graphics (Grafik) → **HD-Grafik** cycles through
  **Alle** (upscaled menus and side panels, every building picture rendered sharp from the game's
  own building sprites), **Teilweise** (only the building pictures that match the originals
  exactly; the others stay original) and **Aus** (the original art).
- **Enhanced options:** Settings → **Erweitert** has optional comfort features that differ from
  the original (selection rings, smoother movement, cursor hints, advisor queue). All are off by
  default; off means exactly the original behaviour.

## Do my friends need their own copy?

To play, friends need nothing but a browser: they load everything, including the game files,
from the host. As with the original game, every player is expected to own a copy of
Alien Nations.
