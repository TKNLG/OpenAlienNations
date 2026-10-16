# Inventions (`DV.idb`), weapons (`dv.wdb`) and `.gdb`

Status: **all three fully decoded.** Readers: `tools/idb_dump.py`, `tools/wdb_dump.py`.

Legend: **C** = seen in the game's code, **D** = confirmed by the shipped data only,
**I** = inferred. All integers little-endian 32-bit signed, strings cp1252 NUL-terminated (the
bytes after the NUL are space filler).

> **Gold Edition:** add-on missions load `data\<race>\ao.idb` instead: the same 30 records plus
> inventions 30 Werft, 31 Hafen, 32 large warship (33 records). Add-on missions also append
> `addon.wdb` (weapons 21..27, ship guns, pincers, fireball, fishing rod) to the weapon table.
> Tables: [addon.md](addon.md) 4 and 6.

## `DV.idb`: the research tree of one race

Files: `AMAZONS/DV.idb`, `PIMONS/DV.idb`, `SAJIKI/DV.idb` (the game builds the path as
`data\amazons\`, `data\pimons\`, `data\sajiki\` + `dv.idb`; C). 6360 bytes = 30 records of 212
bytes. "idb" = invention database: every record is one research topic ("Erfindung"), several of
which unlock buildings or units.

### Record (212 = 0xD4 bytes)

| offset | size | field | | notes |
|---|---|---|---|---|
| 0x00 | 4 | index | C | slot in the table (0..29); the loader stores each record at this slot |
| 0x04 | 3 x 4 | prerequisites | C | invention indices that must be complete first; -1 = unused |
| 0x10 | 4 | cost | C | research points needed |
| 0x14 | 32 | name | C | shown in the research menu |
| 0x34 | 160 | description | C | read lazily from the file when shown; **only the first 128 bytes are read**. The longest shipped text (Sajiki 9) is exactly 128 bytes, so its terminating NUL is not read; a rebuild should simply show the whole NUL-terminated string |

Record count = file size / 212 (C). The loader reads the first 0x34 bytes of each record and
skips the description, remembering its file offset (C).

Per-invention game state (not in the file; C): `progress` (float, starts 0), a `started` flag and
the description offset. An invention is **complete** when progress >= cost.

### What an invention unlocks (C)

Each object type in `dv.odb` has a required-invention field (record +0xE4, see
[od-odb.md](od-odb.md)): -1 = always available, otherwise the object can be built / trained only
when that invention is complete. Several objects can share one invention (e.g. Pimmons 0
"Spähturm" unlocks the scout unit 24 and the tower building 60; 4 "Botschaft" unlocks the diplomat
13 and the embassy 42). "Grundlagenforschung" topics (3 Ackerbau, 5 Schrift, 10 Gesetz, ...)
unlock nothing directly and only serve as prerequisites. `idb_dump.py --odb dv.odb --race N`
lists the unlocks.

### Research (C for the mechanics, I where noted)

- A settlement researches one invention at a time; starting it sets the `started` flag, cancelling
  clears it.
- Each research tick adds `research spending x 0.025` to the invention's progress, x 1.5 when the
  settlement has a finished library (type 47). Research only advances when the settlement has a
  finished laboratory (type 46) and the treasury exceeds the spending. (C: the settlement's
  per-type object lists for types 46 and 47 are checked.)
  Progress is capped at cost; the invention completes when progress reaches cost.
- Research spending is a share of the settlement's tax base set by the player (belongs to the
  economy spec).
- Computer players pick the next topic in table order: the first invention, at or after a
  per-race cursor, that is neither started nor complete and whose prerequisites are all complete.
- Mission setup can complete inventions in advance and disable objects (research level,
  pre-researched flags and disabled lists in the mission record, see [mdb.md](mdb.md)). Free play
  can grant research level 12 or 20.

### The three trees

Costs and prerequisites are the same for all races except where three values are given
(Amazons / Pimmons / Sajiki).

| # | cost | needs (A / P / S) | Amazons | Pimmons | Sajiki |
|---|---|---|---|---|---|
| 0 | 15 | - | Spähturm | Spähturm | Spähturm |
| 1 | 10 | - | Bergfrau | Holzfäller | Holzfäller |
| 2 | 12 | - | Jägerin | Jäger | Jäger |
| 3 | 20 | - | Ackerbau | Ackerbau | Ackerbau |
| 4 | 40 | 0 | Botschaft | Botschaft | Botschaft |
| 5 | 60 | 0 | Schrift | Schrift | Schrift |
| 6 | 25 | 1,2 | Lagerhaus | Lagerhaus | Lagerhaus |
| 7 | 35 | 3 | Kakaoplantage | Pilzfarm | Madenzüchtung |
| 8 | 20 | 3 | Kriegertafel | Wirtshaus | Orgiengrube |
| 9 | 50 | 4,5 | Marktplatz | Marktplatz | Marktplatz |
| 10 | 70 | 5 | Gesetz | Gesetz | Gesetz |
| 11 | 30 | 1,5 | Zeitung | Zeitung | Neuigkeiten |
| 12 | 65 | 9,10,2 | Kaserne | Kaserne | Kaserne |
| 13 | 100 | 4,11,10 / 4,11 / 4,11,10 | Tempel | Tempel | Tempel |
| 14 | 70 | 9,7 | Konditorei | Brennerei | Madendreherei |
| 15 | 85 | 12 | Metallurgie | Metallurgie | Metallurgie |
| 16 | 90 | 12 | Kl. Außenposten | Kl. Außenposten | Kl. Außenposten |
| 17 | 80 | 9,11 | Bank | Bank | Bank |
| 18 | 95 | 13,6 | Gr. Wohnung | Gr. Wohngebäude | Gr. Wohngebäude |
| 19 | 120 | 8,14 | Theater | Zirkus | Kampfarena |
| 20 | 115 | 12,19 | Saboteurin | Saboteur | Saboteur |
| 21 | 100 | 15 | Schwertkämpferin | Schwertkämpfer | Kämpfer |
| 22 | 115 | 15,13 | N. Waffentechnik | Tierfarm | Zuchtstall |
| 23 | 150 | 20,13,15 | Alchemie | Magie | Beschwörung |
| 24 | 145 | 21 | Bihänderin | Hammermann | Berserker |
| 25 | 160 | 16,22 / 22,23 / 16,22 | Armbrustschützin | Explodus | Harak |
| 26 | 200 | 16,22 | Gr. Außenposten | Gr. Außenposten | Gr. Außenposten |
| 27 | 180 | 23,22 | Mächtige Alchem. | Mächtiger Magier | Gottesanbeter |
| 28 | 200 | 24,22 / 24,22 / 22,24 | Kanone | Necktarus | Brutwache |
| 29 | 150 | 11 | Bibliothek | Bibliothek | Wissenshöhle |

## `dv.wdb`: weapons

`data\dv.wdb`, loaded once at startup (C). 2436 bytes = 21 records of 116 bytes. Despite the
"wdb" name and the first entry's name ("KriminellesMesser", the criminals' knife) it is the table
of **attacks**: melee weapons, missile weapons, healing and bombs. Every unit type that can attack
or heal names one record through its `dv.odb` field +0x144 (-1 = none; C).

### Record (116 = 0x74 bytes)

| offset | field | | notes |
|---|---|---|---|
| 0x00 | index | C | slot in the table; the loader stores each record at this slot |
| 0x04 | kind | C | 1 melee, 2 missile, 3 heal, 4 bomb (selects the attack behaviour) |
| 0x08 | projectile | C | object type in group 7 (dv.odb) flown to the target, -1 = none (hits directly). D: the names match (bow -> 10 "Bogen", crossbow -> 2 "Armbrust", catapult and cannon -> 3 "Katapult", fireball -> 9 "Feuer", acid -> 8 "Säure", magic -> 4/5, alchemy -> 0) |
| 0x0C | min | C | damage (or healing) lower bound |
| 0x10 | max | C | damage (or healing) upper bound |
| 0x14 | range | C | attack range in cells (0 = adjacent); compared with the cell distance when the unit picks targets |
| 0x18 | - | D | always 0, no use found |
| 0x1C | projectile speed | C | flight time = distance * 1000 / speed (distance below) |
| 0x20 | cooldown | C | returned by every attack: delay until the unit may attack again (scheduler ticks, I) |
| 0x24 | hit chance | C | percent |
| 0x28 | 3 x 4 | D | always 0, no use found |
| 0x34 | name | D | 64 bytes, internal name; not shown to the player (I) |

Record count = file size / 116 (C).

### Attack behaviour (C)

All random numbers below come from the C runtime `rand()`.

- **Melee and missile** (same routine): if `rand() % 100 >= hit chance` the attack misses (the
  cooldown is still returned). Otherwise damage = `min + rand() % (max - min + 1)`, then scaled
  by an attack-strength argument supplied by the attacker: 1 -> x125/100, 2 -> x150/100,
  3 -> x200/100, anything else unchanged (integer arithmetic). (I: which situations give 1..3 is
  part of the combat spec.) The target loses that many hit points; hit points are clamped to the
  target's maximum (dv.odb +0xAC), and at 0 the target dies.
- **Missile flight**: for kind 2 with a projectile, a projectile object is created at the shooter
  and flies to the target. With both positions in 1/64-cell units, `d = max(|dx|, |dy|) +
  min(|dx|, |dy|) / 2` and the flight takes `d * 1000 / speed` time units (C). The simulation
  counts them as 1/100 tick (impact delay, `combat.md` 4.1); the display flies the sprite for that
  many **milliseconds** (`docs/rendering/projectiles.md` 3). Which unit throws which projectile:
  `combat.md` 6.1.
- **Heal** (kind 3): the target gains `min + rand() % (max - min)` hit points (note: no + 1 here),
  clamped to its maximum. Returns the cooldown.
- **Bomb** (kind 4): only if the carrier still exists. If the target still exists and
  `rand() % 100 < hit chance`, the target loses `min + rand() % (max - min + 1)` hit points (no
  scaling). In every case the carrier is then removed (it blows itself up) and no cooldown is
  returned. Used by saboteurs, Explodus and Harak.

### The 21 weapons

| # | name | kind | damage | range | speed | cooldown | hit % | projectile | users (race:type) |
|---|---|---|---|---|---|---|---|---|---|
| 0 | KriminellesMesser | melee | 1-5 | 0 | | 25 | 100 | | criminals 0:12 1:12 2:12 |
| 1 | JägerBogen | missile | 10-20 | 5 | 900 | 40 | 70 | 10 Bogen | Jägerin 0:17 |
| 2 | Gummiknüppel | melee | 2-5 | 0 | | 15 | 100 | | police 0:21 1:21 2:21 |
| 3 | KampfBogen | missile | 10-20 | 6 | 1000 | 35 | 95 | 10 Bogen | archers 0:29 1:29 |
| 4 | SabotageBombe | bomb | 500-600 | 0 | | 100 | 100 | | saboteurs 0:26 1:26 2:26 |
| 5 | KurzSchwert | melee | 5-10 | 0 | | 10 | 100 | | swordfighters 0:31 1:31 2:31 |
| 6 | Schwert | melee | 20-50 | 0 | | 30 | 100 | | Bihänderin 0:30, Hammermann 1:30, Berserker 2:30 |
| 7 | Alchemistin1 | missile | 30-50 | 5 | 700 | 80 | 95 | 0 Alchemie1 | Alchemistin 0:33 |
| 8 | Alchemistin2 | missile | 60-90 | 5 | 800 | 65 | 95 | 0 Alchemie1 | Mächtige Alchem. 0:32 |
| 9 | Katapult | missile | 100-200 | 8 | 900 | 100 | 90 | 3 Katapult | Katapult 0:34 |
| 10 | Kanone | missile | 100-200 | 8 | 900 | 60 | 90 | 3 Katapult | Kanone 0:35 |
| 11 | Armbrust | missile | 20-50 | 8 | 1100 | 40 | 95 | 2 Armbrust | Armbrustschützin 0:36 |
| 12 | MagierPimmon | missile | 30-50 | 5 | 700 | 80 | 95 | 4 Magie1 | Magier 1:33, Beschwörer 2:32 |
| 13 | MächtigerMagierPimmon | missile | 60-90 | 5 | 800 | 65 | 95 | 5 Magie2 | Mächtiger Magier 1:32, Gottesanbeter 2:33 |
| 14 | Drachofiterus | missile | 50-100 | 8 | 900 | 50 | 95 | 10 Bogen | Drachofiterus 1:34 |
| 15 | Necktarus | melee | 100-200 | 0 | | 60 | 95 | | Necktarus 1:35, Brutwache 2:35 |
| 16 | Explodus | bomb | 400-800 | 0 | | 10 | 100 | | Explodus 1:36, Harak 2:36 |
| 17 | Jagdspeer | melee | 10-20 | 0 | | 40 | 100 | | Jäger 1:17 2:17 |
| 18 | Feuerkugel | missile | 10-20 | 6 | 1200 | 35 | 95 | 9 Feuer | Pyro 2:29 |
| 19 | SpitPack | missile | 50-100 | 8 | 1000 | 50 | 95 | 8 Säure | Spitpack 2:34 |
| 20 | Heilen | heal | 7-13 | 0 | | 20 | 100 | | priests 0:22 1:22 2:22 |

Note the Pimmon magician weapons are shared by the Sajiki casters, and the Sajiki "Pyro" archer
(29) uses the fireball instead of a bow.

## `.gdb`

`amazon.gdb`, `db.gdb`, `dv.gdb`, `mentor.gdb`, `pimmons.gdb`, `sajiki.gdb`, `tutorials.gdb`:
2 bytes each, `\r\n`. No file name ending in `.gdb` occurs in AN.exe (C: not in the string table,
no loader). They are leftovers of the developers' tools and can be ignored.

## Open questions

- `dv.wdb` +0x18 and +0x28..+0x33 are zero everywhere and unused by the code paths found.
- Which attacker situations select damage multipliers 1..3.
- *(Resolved: `combat.md` 4.1, `docs/rendering/projectiles.md` 3.)* Time unit of projectile
  flight (1/100 tick in the simulation, ms on screen) and of the cooldown (ticks).
