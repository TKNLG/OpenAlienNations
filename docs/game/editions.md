# Editions, add-on and patches of Die Völker / Alien Nations (1999)

Notes for deciding which data and which executable the rebuild follows. Not about the sequel
"Die Völker 2" / "The Nations" (2000/2001), whose own "Gold Edition" and "Bonus Pack" are a
different game.

## Releases (web research, sources at the end)

| release | date | content |
|---|---|---|
| Die Völker / Alien Nations | May 1999 | base game: 3 campaigns x 10 missions, 5 tutorials, free play |
| Mission pack ("Missionspack", the add-on) | Sept 1999 | 3 new **add-on campaigns** set in a tropical island world, a new difficulty level, saving in multiplayer, new buildings **harbour** and **shipyard**, ships (transport ships, fishing boats, sea combat units) |
| Gold Edition | Oct 2000 | base game + mission pack on one disc |
| GOG.com | 2009, Galaxy builds "2.05" (2017) and "2.05 Hotfix" (2018) | base game only, `Bin/AN.exe`; no add-on files |

Patches listed on patches-scrolls.com (cumulative): German 1.6 (digital download), German 2.05
(`voelk205.zip`), **mission pack 3.03** (`dvmp3_03.zip`) and **Gold Edition 3.03**
(`dvgld303.zip`), plus a map editor (English, needs 2.02; that one may belong to the sequel and
must be checked). A fan launcher states "v2.05 / Gold Edition v3.03" as the latest versions.

## What the two editions contain (checked file by file)

GOG (default install `C:\GOG Games\Alien Nations`): `Bin/AN.exe` (745,472 bytes; version resource 1.0.0.1;
ReadMe says "V5.0"), base data only.

Gold Edition (an installed copy): `bin/dvge.exe` (798,720 bytes, file date March 2001, same
version resource 1.0.0.1, contains the strings `GOLD`, `VölkerGold.ini`, `addon.odb/.wdb/.od/.gd/.tdb`)
and, in addition to the base data:

- `AmazonsAO.mdb`, `PimmonsAO.mdb`, `SajikisAO.mdb` (10 missions each) with `<Race><n>AO.dvm`
  maps, plus `Amazon9AAO.dvm` and `AmazonAO1.dvm`; `InfiniteAO.mdb` (add-on free play)
- `Addon.gd` (31 MB of sprites), `Addon.od`, `Addon.odb`, `addon.wdb`, `Addon.tdb` (strings such as
  "Addon Kampagnen", fishing and boarding/unloading job texts)
- per race `AO.idb` (more inventions than `DV.idb`)
- `Intro2.avi`, `mainmenu.ic`

Base files that differ between the two installs: `dv.odb`, `mainmenu.gd` (add-on menu art), the
race `interface.gd` files, `Amazons.mdb`, `Infinite.mdb`, `Tutorial1.dvm`. Identical: `dv.gd`,
`dv.OD`, `DV.tdb`, `Mentor.tdb`, `dv.wdb`, `Pimmons.mdb`, `Sajikis.mdb`, `Tutorials.mdb`, the
`DV.idb` files and the terrain sets.

**Patch level.** The Gold Edition service pack 3.03 (`DieVölkerGold_ServicePack_3_03.exe`, a
"PatchIt" self-installer from Jan 2000 that carries whole replacement files: `bin\dvge.exe`
794,624 bytes, `data\pimmonsao.mdb`, `data\sajikisao.mdb`) was compared with the install: both
mission files are byte-identical to the installed ones, and the installed `dvge.exe` (798,720
bytes, March 2001) is a later build than the one in the patch. The install is therefore at 3.03
or newer and is the reference for the add-on. The patch readme lists the fixes: crash when
loading saves of the original campaigns, Sajiki missions "Gefährlicher Botengang" and
"Insel-Beschlagnahmung", Pimmons "Rettungsversuch" ending early, finished missions not unlocking.

## Consequences for the rebuild

The Gold executable's file handling, add-on maps, island generator, add-on menus and the full
GOG/Gold difference list are specified in [../formats/addon.md](../formats/addon.md); the add-on
gameplay in [addon.md](addon.md).

- The specs in `docs/` were read from the GOG `AN.exe`. The Gold executable must be analysed
  as well (behaviour of ships, harbour, shipyard, fishing, transport, the add-on research tree,
  the add-on menus), ideally at patch level 3.03.
- The server should accept either install. File names differ in case between them (`Data` /
  `data`, `AMAZONS` / `Amazons`, `PIMONS` / `Pimons`), so lookups must be case-insensitive.
- Base-game rules where `dv.odb` differs: decide per field which version to follow (the patched
  Gold data is the latest).

## Sources

- https://de.wikipedia.org/wiki/Die_Völker (mission pack and Gold Edition contents and dates)
- https://www.pcgamingwiki.com/wiki/Alien_Nations
- https://www.gog.com/en/game/alien_nations , https://www.gogdb.org/product/1207658717
- https://www.patches-scrolls.com/alien_nations.php (patch list)
- https://www.gamepressure.com/download/alien-nations-ready2play-launcher-v5112023-mod/z514e6e
