# Data format overview

Status of every file type in the GOG `Data/` folder. Specs live next to this file.

| ext | files | what it is | status |
|---|---|---|---|
| `.gd` | dv.gd, mainmenu.gd, */interface.gd | sprite archives, animated, RGBA | **solved**: [gd.md](gd.md) |
| `.OD` | dv.OD, */interface.OD | object -> anchor, bounds, sprite per animation slot | **solved**: [od-odb.md](od-odb.md) |
| `.os` | 15 terrain sets | 64x64 BGR terrain tiles | **solved**: [os-dvf-tdb.md](os-dvf-tdb.md) |
| `.dvf` | 10 fonts | bitmap fonts with coverage | **solved** |
| `.tdb` | DV.tdb, Mentor.tdb | id -> string tables | **solved** |
| `.dvm` | 35 maps (campaigns + tutorials) | `SMVD` v100 object placements, AI region hints, camera, initial jobs | **solved**: [dvm.md](dvm.md) |
| `.odb` | dv.odb (85 KB) | object rules: buildings, units, goods, nature | **solved**: [odb.md](odb.md) |
| `.idb` | */DV.idb | per-race research tree (30 inventions: prerequisites, cost, name, text) | **solved**: [idb-wdb.md](idb-wdb.md) |
| `.mdb` | per-campaign | missions: texts, map, seed, goals, per-race setup | **solved**: [mdb.md](mdb.md) |
| `.wdb` | dv.wdb | weapon / attack table (21 entries) | **solved**: [idb-wdb.md](idb-wdb.md) |
| `.gdb` | 2 bytes each | `\r\n` only, never opened by AN.exe | ignore |
| `.wav` | SOUND/ | effects + mentor speech | standard, browser-native |
| `.ogg` | Bin/music | GOG music tracks 02-11 | standard, browser-native |
| `.avi` | intro, 3 outros | videos | standard container. Browsers can't play AVI; transcode once at setup |
| `.ini` | CDAudio.ini | track numbers for menu/game music | trivial |

**Gold Edition / mission pack** (`dvge.exe`): `Addon.odb`, `Addon.od`, `Addon.gd`, `addon.wdb`,
`Addon.tdb`, per-race `AO.idb`, `*AO.mdb` and the add-on `.dvm` maps (which store their terrain)
are specified in [addon.md](addon.md), together with how the game switches between base and
add-on data and the GOG/Gold differences.
