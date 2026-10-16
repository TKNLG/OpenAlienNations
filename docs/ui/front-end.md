# Front end: menus, briefing, loading, settings, mission end

Everything the player sees outside the running game, in the original 800 x 600 layout. The in-game
side panel is a separate spec ([side-panel.md](side-panel.md)); this page covers the in-game
**options menu**, which replaces the whole screen.

Legend: **C** = seen in the game's code, **D** = confirmed by the shipped data only,
**I** = inferred / best reading, check against the original.

Strings are quoted as `#id "text"` with the id from `DV.tdb` (format in
[os-dvf-tdb.md](../formats/os-dvf-tdb.md)). The GOG build ships German text only.

> **Gold Edition:** `dvge.exe` adds the add-on campaign button, the "Addon:" world-parameter
> toggle, add-on backgrounds (`RASSENWAHLAO`, `MISSIONSAUSWAHL`, `BRIEFINGSCREENAO`, `LOADING_B`),
> `intro2.avi`, saving and loading in multiplayer and `dv.cfg`. Those differences are specified in
> [addon.md](../formats/addon.md) 11; this page describes AN.exe.

## 1. Conventions shared by all screens

### 1.1 Coordinates and screen objects

- All front-end screens are **800 x 600** with the origin at the top left. When the game runs at
  1024 x 768, the game switches the display back to 800 x 600 whenever a menu screen is created (C),
  and back to the game resolution when play resumes. A browser rebuild should simply draw the
  menus into an 800 x 600 canvas and scale/letterbox it.
- Rectangles below are written `(x1,y1)-(x2,y2)` and are **inclusive** (width = x2 - x1 + 1) (C).
- A screen is one full-screen panel with a background image from `mainmenu.gd` plus children.
  Only one screen exists at a time; opening a screen destroys the previous one (C).
- Sprite placement: an image is drawn with its **top-left corner** at the given point; the
  rectangle stored in the `.gd` entry (e.g. `INPUT1` = 11,6..348,71) only gives the size, its
  offset is ignored (C). Composites built with this rule match the art exactly (checked for the race
  selection, briefing, sound, save and message box screens).
- Backgrounds (`MAINMENU`, `RASSENWAHL`, `BRIEFINGSCREEN`, `LOADING`) must be drawn fully opaque even
  where the file stores alpha 0.

### 1.2 Widget kinds

| kind | look | behaviour |
|---|---|---|
| **label** | text only | not clickable. Text placed in the rectangle with the given alignment |
| **text button** | text only, no frame or background | normal colour, switches to the hover colour while the mouse is over it. Click = press and release inside the same button (C). A click sound plays on press (C: effect `sfx_042.wav`, I for the file name mapping: effect *n* is `data\sound\sfx_<n+1 as 3 digits>.wav` loaded in order) |
| **image** | one sprite | not clickable unless stated |
| **animated figure** | multi-frame sprite | see 3.4 |
| **list box** | lines of text | see 1.4 |
| **text edit** | text on an `INPUT1` plate | see 1.5 |
| **slider** | `SCHIEBERING-SOUND0` ring on a track | see 1.6 |

Text alignment codes used in the tables: horizontal **L**eft / **C**entre / **R**ight, vertical always
centred in the rectangle (C: the game supports top/middle/bottom; the front end only uses middle).
Centring uses the measured string width and the font height.

### 1.3 Fonts and colours

| font file | glyph height | baseline | used for |
|---|---|---|---|
| `dv18pt.dvf` | 23 | 19 | screen titles, main-menu buttons, message-box text of the "are you sure" boxes |
| `dv14pt.dvf` | 19 | 15 | most buttons, labels, values, briefing title |
| `dv10pt.dvf` | 13 | 11 | buttons inside message boxes |
| `dv7pts2.dvf` | 13 | 11 | list boxes, briefing text, text edits, message-box text, version label |

The three large fonts have upper-case glyphs only. Glyph fallback when a character is missing (C):
`'` and `` ` `` use `´`; `ä ö ü` use `Ä Ö Ü`; any other letter is converted to upper case. So "Zurück"
renders as "ZURÜCK" in `dv14pt`. Space width = width of the `E` glyph unless the font overrides it
(C; `dv7pts2` uses a fixed space of 4 px, I for the other fonts).

Colours are given by the game as Windows `COLORREF` values (byte 0 = red). This is confirmed by the
list-box "selected line" colour `0x00FFFF`, which is the yellow the manual describes for the selected
town (C + manual). In RGB:

| name used below | RGB | where |
|---|---|---|
| **brown** | `#605034` | normal text of buttons and labels on the parchment |
| **blue** | `#6050FC` | screen titles and the briefing title |
| **red** | `#FF0000` | hover colour of every clickable text |
| **black** | `#000000` | value / toggle buttons (world parameters, graphics, sound, controls), MP lists |
| **white** | `#FFFFFF` | version label |
| **yellow** | `#FFFF00` | the currently selected line of a selectable list |
| **dark red** | `#501814` | list lines that carry a "marked" flag (used for highlighted chat lines, I) |

### 1.4 List boxes (C)

- Line height = font height x 1.2, truncated (`dv7pts2`: 15 px, `dv14pt`: 22 px). Visible lines =
  box height / line height. The briefing text and the chat log use spacing 1.0 (13 px).
- Each line is a text button covering the box width minus 18 px on the right (room for arrows).
  Lines use the list's normal / hover colours; the selected line is yellow, marked lines dark red.
- When there are more lines than fit, scroll arrows appear at the right edge: `SIDE_PFEILOBEN`
  (18 x 12) at the top while the list is scrolled down, `SIDE_PFEILUNTEN` (18 x 12) at the bottom
  while more lines follow. Each click scrolls one line. The mouse wheel also scrolls (I).
- Clicking a line calls the list's action with the value stored in that line (mission index,
  savegame slot, ...).

### 1.5 Text edits (C)

An `INPUT1` plate (337 x 65) is placed as an image; the edit field sits inside it at plate-relative
`(33,21)-(299,40)`, i.e. absolute `(x+33, y+21)-(x+299, y+40)` for a plate at (x, y). Text is
`dv7pts2`, centred. The field has a maximum length (given per screen). Enter calls the screen's
"confirm" action; some fields clear themselves when clicked. The caret look is not known (I: a
simple bar; the unused `CURSOR` sprite in `mainmenu.gd`, 3 x 10, 2 frames, may have been meant for
it; it is not a mouse cursor, see [cursors.md](cursors.md)).

### 1.6 Sliders (C)

A slider is a track rectangle plus a ring sprite (`SCHIEBERING-SOUND0`, 36 x 36) that the player
drags with the left button held. Travel = track width - ring width. The value is
`min + round(offset * (max - min) / travel)`; while dragging, every change of the value is applied
immediately (live volume change). Setting a value from outside moves the ring to
`track_left + travel * (value - min) / (max - min)`. The ring is centred across the track.
`SCHIEBERING-SOUND1` (37 x 37) is never referenced by the executable.

### 1.7 Message boxes (C)

Two overlay boxes, drawn on top of whatever screen is open (that screen is disabled until the box
closes). The box image is `MESSAGEBOX` (400 x 249) at **(200,190)**. Children are relative to the box:

| element | box-relative rect | absolute | font, colour | action |
|---|---|---|---|---|
| message text | (0,0)-(400,160) | (200,190)-(600,350) | `dv7pts2`, brown, C | - |
| **OK box:** `#181 "OK"` | (150,170)-(250,200) | (350,360)-(450,390) | `dv10pt`, brown / red | close, then run the follow-up action |
| **Yes/No box:** `#204 "Ja"` | (50,170)-(150,200) | (250,360)-(350,390) | `dv10pt` | close, run the "yes" action |
| `#205 "Nein"` | (250,170)-(350,200) | (450,360)-(550,390) | `dv10pt` | close, run the "no" action |

`MESSAGEBOX2` (400 x 420) is never referenced by the executable.

### 1.8 "Are you sure" screens (C)

The end-game and restart questions are full screens, not overlays: background `MAINMENU`, the
question as a word-wrapped text block at (250,270)-(575,399) in `dv18pt` brown, and two buttons in
`dv14pt` brown / red: `#204 "Ja"` at (260,420)-(370,470) and `#205 "Nein"` at (410,420)-(550,470).

## 2. Screen flow

```
start ─► intro video (640x480) ─► MAIN MENU
MAIN MENU
 ├─ Einspielermodus ─► SINGLE-PLAYER MODE
 │    ├─ Einführung ───────► MISSION LIST (tutorials) ─► BRIEFING ─OK─► LOADING ─► game
 │    ├─ Kampagnen ────────► RACE SELECTION ─race─► MISSION LIST (race) ─► BRIEFING ─OK─► LOADING ─► game
 │    ├─ Endlosspiel ──────► WORLD PARAMETERS ─Weiter─► RACE SELECTION (free play) ─race─► LOADING ─► game
 │    └─ Zurück ─► MAIN MENU
 ├─ Mehrspielermodus ─► NAME ─► CONNECTION ─► SESSION LIST ─┬─ join ──────────► MP RACE SELECTION ─► CHAT LOBBY ─start─► LOADING ─► game
 │                                                         └─ Neu ─► NEW SESSION ─Weiter─► MP RACE SELECTION ─► CHAT LOBBY
 │                                                                      └─ Weltparameter ─► WORLD PARAMETERS (MP)
 ├─ Spiel laden ─► LOAD LIST ─slot─► LOADING ─► game
 ├─ Einstellungen ─► SETTINGS ─► GRAPHICS / SOUND / CONTROLS / DELETE SAVEGAME
 └─ Spiel verlassen ─► quit program

game ─ESC or disk icon─► OPTIONS MENU (game paused)
 ├─ Auftrag lesen ─► BRIEFING (read-only: OK and Zurück return to OPTIONS MENU)
 ├─ Spiel speichern ─► SAVE LIST ─slot─► SAVE NAME ─Speichern─► saving ─► OPTIONS MENU
 ├─ Spiel laden ─► LOAD LIST ─slot─► LOADING ─► game        (Zurück ─► OPTIONS MENU)
 ├─ Einstellungen ─► SETTINGS ... (Zurück ─► OPTIONS MENU)
 ├─ Mission neu beginnen ─► "sure?" ─Ja─► LOADING (same mission) ─► game
 ├─ Zurück zum Spiel ─► game
 └─ Spiel beenden ─► "sure?" ─Ja─► (autosave) ─► MAIN MENU

game ─mission lost─► "verloren" box ─OK─► BRIEFING of the same mission (campaign/tutorial) or MAIN MENU (free play, MP)
game ─mission won──► "erfolgreich" box ─OK─► campaign/tutorial: record progress ─► BRIEFING of the next mission
                                           ├─ last campaign mission done ─► outro video of the race ─► MAIN MENU
                                           ├─ last tutorial done ─► MAIN MENU
                                           └─ free play: outro video of the race ─► MAIN MENU; MP: MAIN MENU
```

There is **no credits screen** in AN.exe (no strings, art or code); the credits exist only in the
manual. A rebuild may add one as an extra.

## 3. Screens

Unless stated otherwise: background `MAINMENU`; title label = `dv18pt`, blue, centred at
**(230,270)-(565,299)**; "Zurück" = `#75 "Zurück"`, `dv14pt`, brown / red, centred.

### 3.1 Start-up and intro (C)

1. Read the configuration (`an.cfg`, section 4.1) and string table, start the CD-music driver.
2. Switch the display to **640 x 480**, hide the mouse cursor and play `intro.avi` with its picture
   at **(0,60), 640 x 420** (black bars above and below). Clicking the left mouse button or pressing
   ESC skips it (manual). If the file is missing, skip straight on.
3. When the video ends: switch to 800 x 600, load `mainmenu.gd`, start the menu music (CD track
   `MENU`, section 7) and open the main menu.

The executable also searches all drive letters C..Z for `data\intro.avi` at start to find the game
CD, and asks for the CD (`#322`) if it is not found. The rebuild drops this.

### 3.2 Main menu (C)

Background `MAINMENU`, no title (the logo is part of the art).

| element | rect | font, colour, align | action |
|---|---|---|---|
| `#65 "Einspielermodus"` | (230,255)-(565,294) | `dv18pt`, brown / red, C | single-player mode menu (3.3) |
| `#66 "Mehrspielermodus"` | (230,295)-(565,334) | same | multiplayer name screen (3.13.1) |
| `#67 "Spiel laden"` | (230,350)-(565,389) | same | load list (3.10), "Zurück" there returns here |
| `#68 "Einstellungen"` | (230,390)-(565,429) | same | settings menu (3.9) |
| `#247 "Spiel verlassen"` | (230,450)-(565,490) | same | quit the program |
| version label | (600,580)-(790,595) | `dv7pts2`, white, right / bottom | text = `Version` from section `[Info]` of the game's ini, default `"v2.??"`. The rebuild shows its own version |

Opening the main menu also leaves any multiplayer session.

### 3.3 Single-player mode (C)

Opening this screen resets the free-play parameters to their single-player defaults (see 6.1).

| element | rect | font / colour | action |
|---|---|---|---|
| title `#185 "Wähle den Spielmodus"` | (230,270)-(565,299) | `dv18pt` blue, C | - |
| `#251 "Einführung"` | (230,320)-(565,359) | `dv14pt` brown / red, C | mission list for the tutorials (mode 3, human race = Pimmons) |
| `#186 "Kampagnen"` | (230,360)-(565,399) | same | race selection, campaign variant |
| `#187 "Endlosspiel"` | (230,400)-(565,440) | same | world parameters, single-player variant (3.7) |
| `#75 "Zurück"` | (340,460)-(460,500) | same | main menu |

### 3.4 Race selection (C)

Background `RASSENWAHL`. Used for the campaign and for free play; the multiplayer lobby reuses the
same layout (3.13.5).

| element | position | notes |
|---|---|---|
| `WAEHLEVOLK` (330 x 41, "Wähle Dein Volk" sign) | (227,56) campaign, (232,56) free play | the 5 px shift is a quirk of the original (it depends on the high bit of the screen's parameter); either is fine |
| Pimmons figure `PI` (205 x 341, 20 frames) | (58,153) | click: Pimmons |
| Amazons figure `AZ` (121 x 362, 21 frames) | (350,110) | click: Amazons |
| Sajiki figure `SA_B` (346 x 393, 33 frames) | (486,100) | click: Sajiki |
| name plate on hover: `PIMONS` (179 x 48) | (95,499) | shown only while the mouse is over the Pimmons figure |
| name plate on hover: `AMAZONEN` (255 x 50) | (270,460) | same for Amazons |
| name plate on hover: `SAJIKI` (128 x 51) | (535,495) | same for Sajiki |
| `#75 "Zurück"` | (340,522)-(460,540), `dv14pt` brown / red | campaign: single-player menu; free play: world parameters |

The clickable area of a figure is its full sprite rectangle (C; transparent pixels count).

**Animation (C):** every figure loops through all its frames forever, starting at frame 0. A
global ticker runs on every second redraw of the menu and advances a figure by one frame when more
than **50 ms** have passed since its last step, so the rate is at most ~20 frames per second (the
exact rate depended on the redraw rate; use a fixed 50-60 ms per frame). Hover does not change the
animation. A disabled figure (multiplayer: race already taken) is drawn with a white tint and does
not react (C for the tint, I for the exact look).

Click actions:
- **Campaign:** remember the human race (0 Amazons, 1 Pimmons, 2 Sajiki), load that race's `.mdb`
  (`Amazons.mdb`, `Pimmons.mdb`, `Sajikis.mdb`) and open the mission list.
- **Free play:** set mode 4, load `Infinite.mdb`, select record = race index, apply the free-play
  overrides (section 6) and start loading at once (there is no briefing for free play).

### 3.5 Mission list (C)

| element | rect | font / colour | notes |
|---|---|---|---|
| title `#196 "Wähle die Mission"` | (230,270)-(565,299) | `dv14pt` blue, C | |
| list box | (220,330)-(580,450) | `dv7pts2`, brown / red hover, lines centred; 15 px lines, 8 visible | one line per mission, text = mission title (record +0x04), in index order |
| `#75 "Zurück"` | (345,470)-(455,490) | `dv14pt` brown / red | campaign: race selection; tutorials: single-player menu |

Only missions with index `<= progress[mode]` are listed (section 5). Clicking a line opens the
briefing of that mission.

### 3.6 Briefing (C)

Background `BRIEFINGSCREEN` (the variant `BRIEFINGSCREENAO` and the `...AO` portraits are used when
the record's layout field +0xA50 is >= 1; no shipped record does that and the AO sprites are not in
`mainmenu.gd`, so the rebuild can ignore that variant). **Gold Edition:** +0xA50 is the add-on
flag, all add-on missions use the AO variant, and the Gold `mainmenu.gd` contains its art; layout
in [addon.md](../formats/addon.md) 11.3.

| element | rect / position | font / colour | notes |
|---|---|---|---|
| mission title (record +0x04) | (230,220)-(565,240) | `dv14pt` blue, C | |
| briefing text (record +0x44) | text area (220,260)-(580,450), scroll arrows just right of it (to x 597) | `dv7pts2` brown, left aligned, word-wrapped, 13 px lines (14 visible) | read-only scrolling text |
| scroll ring | ring `SCHIEBERING-SOUND0` on a vertical track (672,258)-(702,454) | | drags the text; top = first line, bottom = last page |
| `AMABRIEF` (117 x 140) | (344,20) | | only if Amazons present (record +0xB1C != 0) |
| `PIMBRIEF` (137 x 122) | (138,70) | | only if Pimmons present (+0xC70) |
| `SABRIEF` (128 x 138) | (511,55) | | only if Sajiki present (+0xDC4) |
| `#75 "Zurück"` | (220,470)-(340,490) | `dv14pt` brown / red | mission list of the current mode |
| `#282 "Drucken"` | (340,470)-(460,490) | same | print title + text (the original opens the Windows print dialog and prints in Times New Roman, 20 px, title centred). Browser: print a simple page |
| `#181 "OK"` | (460,470)-(580,490) | same | start the mission: loading screen (3.8) |

When opened from the in-game options menu ("Auftrag lesen") both "OK" and "Zurück" just return to
the options menu.

**Speech:** when the briefing opens the game plays `data\sound\mission\<map file name with .wav>`
once at speech volume, if the file exists (see [mdb.md](../formats/mdb.md)); it stops when the
mission starts.

### 3.7 World parameters ("Erschaffe eine Welt") (C)

| element | rect | font / colour | notes |
|---|---|---|---|
| title `#293 "Weltparameter"` | (230,255)-(565,285) | `dv18pt` blue, C | |
| label `#301 "Weltgröße:"` | (230,320)-(539,350) | `dv14pt` brown, L | |
| label `#302 "Anzahl Rohstoffe:"` | (230,350)-(539,380) | same | |
| label `#303 "Entwicklungsstufe:"` | (230,380)-(470,410) | same | |
| label `#304 "Lagerstand:"` | (230,410)-(470,440) | same | |
| value button, world size | (490,320)-(570,350) | `dv14pt` black / red, R | cycles Klein -> Mittel -> Groß -> Klein |
| value button, resources | (490,350)-(570,380) | same | cycles Wenig -> Mittel -> Viel -> Wenig |
| value button, development | (490,380)-(570,410) | same | cycles Niedrig -> Mittel -> Hoch -> Niedrig |
| value button, stock | (490,410)-(570,440) | same | cycles Niedrig -> Mittel -> Hoch -> Niedrig |
| single player: `#75 "Zurück"` | (260,470)-(370,490) | `dv14pt` brown / red | single-player menu |
| single player: `#92 "Weiter"` | (410,470)-(550,490) | same | race selection, free-play variant |
| multiplayer: `#75 "Zurück"` | (340,470)-(460,490) | same | back to "Neue Session" (3.13.4) |

Value texts: size `#294 "Klein"` / `#295 "Mittel"` / `#296 "Groß"`; resources `#297 "Wenig"` /
`#295 "Mittel"` / `#298 "Viel"`; development and stock `#299 "Niedrig"` / `#295 "Mittel"` /
`#300 "Hoch"`. Clicking a value replaces only that button. Meaning and mapping: section 6.

### 3.8 Loading screen (C)

1. Stop the CD music; switch the display to the game resolution (800 x 600 or 1024 x 768).
2. Show `LOADING` (800 x 600) at (0,0) as a static picture. There is no progress bar and no text.
3. Load rules, generate the terrain, place objects, build the side panel, then start play and the
   game music (tracks `FIRST`..`LAST`).

If a savegame cannot be read the game shows the OK box `#235 "Fehler: Der Spielstand konnte nicht
geladen werden!"` and returns to the main menu (or the options menu if a game was running).

### 3.9 Settings (C)

The settings screens are reachable from the main menu and from the in-game options menu; every
"Zurück" chain ends where it started.

**Settings menu**

| element | rect | font / colour | action |
|---|---|---|---|
| title `#68 "Einstellungen"` | (230,270)-(565,299) | `dv18pt` blue | |
| `#78 "Grafik"` | (230,310)-(565,340) | `dv14pt` brown / red, C | graphics |
| `#79 "Sound"` | (230,341)-(565,370) | same | sound |
| `#287 "Steuerung"` | (230,371)-(565,400) | same | controls |
| `#323 "Spielstand löschen"` | (230,401)-(565,430) | same | delete-savegame list (3.10) |
| `#75 "Zurück"` | (340,470)-(460,490) | same | main menu or options menu |

**Graphics** (title `#88 "Grafikeinstellungen"`)

| label (dv14pt brown, L) | label rect | toggle button (dv14pt black / red, R) | values |
|---|---|---|---|
| `#89 "Hardwarebeschleunigung:"` | (230,320)-(539,350) | (540,320)-(585,350) | `#80 "Ein"` / `#81 "Aus"` |
| `#90 "Alpha-Schatten:"` | (230,350)-(539,380) | (540,350)-(585,380) | Ein / Aus |
| `#292 "Auflösung:"` | (230,380)-(439,410) | (475,380)-(585,410) | `#290 "800 x 600"` / `#291 "1024 x 768"` |
| `#318 "Hardwarescrolling:"` | (230,410)-(539,440) | (540,410)-(585,440) | Ein / Aus |

`#75 "Zurück"` at (340,470)-(460,490) returns to the settings menu. Hardware acceleration and
resolution are only toggled if the graphics driver supports the requested mode; the resolution
switch takes effect immediately (menus stay 800 x 600) and the in-game layout follows it.

**Sound** (title `#82 "Soundeinstellungen"` at (230,250)-(565,279))

| row | label (dv14pt brown, L) | control |
|---|---|---|
| master | `#79 "Sound"` (230,300)-(330,320) | toggle (350,300)-(420,320), dv14pt black / red, L: Ein / Aus |
| effects | `#84 "Effekte:"` (230,340)-(350,360) | slider: `SOUNDSLIDER` bar (236 x 45) at (340,332), track = bar-relative (20,10)-(216,40), range 0..100 |
| music | `#85 "Musik:"` (230,380)-(330,400) | slider: bar at (340,372), same geometry, 0..100 |
| speech | `#86 "Sprache:"` (230,420)-(330,440) | slider: bar at (340,412), same geometry, 0..100 |
| EAX | `#87 "EAX:"` (230,460)-(330,480) | toggle (350,460)-(420,480): Ein / Aus |
| | `#75 "Zurück"` (340,500)-(460,520) | settings menu |

Ring travel on the sound sliders is 161 px (track 197 px wide - ring 36 px), ring top-left at
(360 + 161 x value / 100, bar_y + 8). The three bars are always drawn. Special states (C):
- "No sound hardware": only a non-clickable "Aus" in the master position, no sliders, no EAX. (The
  flag that selects this is a constant in the shipped executable, so this state never occurs.)
- Sound switched off: only the master toggle ("Aus", clickable), no sliders, no EAX.
- Sound on: master toggle "Ein", three sliders, EAX toggle.

`#83 "Total:"` exists in `DV.tdb` but is not used.

**Controls** (title `#287 "Steuerung"`)

| label (dv14pt brown, L) | label rect | button (dv14pt black / red, R) | values |
|---|---|---|---|
| `#288 "Scrollen im Menübereich"` | (220,320)-(539,350) | (520,320)-(570,350) | `#204 "Ja"` / `#205 "Nein"` |
| `#289 "Automat. Speichern"` | (220,351)-(539,400) | (420,351)-(570,400) | cycles `#283 "Aus"` -> `#284 "10 min"` -> `#285 "20 min"` -> `#286 "30 min"` -> Aus |

`#75 "Zurück"` at (340,470)-(460,490).

**All options**

| option | values | default (new config) | effect |
|---|---|---|---|
| hardware acceleration | on / off | off | renderer choice in the original (3D blits, faster zoom). Rebuild: ignore or map to a renderer switch |
| alpha shadows | on / off | on | draw building/unit shadows (manual) |
| resolution | 800 x 600, 1024 x 768 | 800 x 600 | game resolution; changes the playfield size and the side-panel art set (`INTERFACE800` / `INTERFACE1024`) |
| hardware scrolling | on / off | on | scrolling method of the original renderer (I). Rebuild: ignore |
| sound | on / off | on | master switch: off silences effects and speech and also stops the CD music; on restarts the menu music |
| effects volume | 0..100 | 100 | volume of effect sounds (sound category 1) |
| music volume | 0..100 | system mixer value (67 in the GOG file) | CD-audio / music volume |
| speech volume | 0..100 | 100 | mentor and briefing speech (sound category 2) |
| EAX | on / off | off | 3D sound on Creative cards. Rebuild: ignore |
| menu scrolling | yes / no | no | lets the side-panel menu scroll when the mouse touches the screen edge near it (manual). Belongs to the side-panel spec |
| autosave | off / 10 / 20 / 30 min | 10 min | periodic save to slot 000 in single player only (never in multiplayer) |

### 3.10 Load, save and delete lists (C)

All three use background `MAINMENU`, a title, one list box and "Zurück".

| screen | title | list box | lists | click | Zurück |
|---|---|---|---|---|---|
| load | `#67 "Spiel laden"` | (265,320)-(550,465), `dv7pts2` brown / red, centred, 9 lines | every existing slot 000..099 | load that slot (3.8) | main menu or options menu |
| save | `#71 "Spiel speichern"` | same | existing slots 002..099, plus `#77 "Neuer Spielstand"` for the first free slot >= 2 | save-name screen for that slot | options menu |
| delete | `#323 "Spielstand löschen"` | same | every existing slot 000..099 | Yes/No box `#324 "Soll der Spielstand wirklich gelöscht werden?"`; Ja deletes the file and rebuilds the list | settings menu |

Line text = the name stored in the savegame. Slot 000 holds the autosave (name
`#313 ".Automatische Speicherung."`), slot 001 the quicksave (`#314 ".Schnellspeicherung."`). The
dots make them sort/read differently from player names. "Zurück" sits at (340,470)-(460,490).

**Save-name screen:** title `#73 "Name des Spielstands?"`; `INPUT1` at (227,350); edit field
(260,371)-(526,390), max 20 characters, brown text, pre-filled with the slot's current name (empty
for a new slot); `#75 "Zurück"` at (260,420)-(370,470) back to the save list; `#76 "Speichern"`
at (410,420)-(550,470) or Enter: save. An empty name becomes `#72 "Unbenannt"`. While saving, the
screen shows `#188 "Spiel wird gespeichert"` (dv14pt brown, centred in (230,270)-(565,399)); on
success the game returns to the options menu, on failure it shows the OK box
`#234 "Fehler: Der Spielstand konnte nicht gespeichert werden!"` and then the options menu.

**Quicksave (F12, single player only):** shows `#188` as an on-screen message for 5 s and saves
to slot 001 without any dialog.

### 3.11 In-game options menu (C)

Opened with ESC or the disk icon of the side panel. The game is paused, the display switches to
800 x 600 if needed, and the menu fills the screen (background `MAINMENU`; there is no title).
All buttons `dv18pt`, brown / red, centred.

Single player:

| button | rect | action |
|---|---|---|
| `#243 "Auftrag lesen"` | (230,245)-(565,274) | briefing of the current mission, read-only |
| `#71 "Spiel speichern"` | (230,290)-(565,320) | save list |
| `#67 "Spiel laden"` | (230,320)-(565,350) | load list |
| `#68 "Einstellungen"` | (230,350)-(565,380) | settings |
| `#317 "Mission neu beginnen"` | (230,395)-(565,425) | sure-screen `#316 "Bist Du sicher, daß Du die Mission neu beginnen willst?"`; Ja restarts the same mission record (loading screen), Nein returns here |
| `#70 "Zurück zum Spiel"` | (230,425)-(565,455) | resume (restores the game resolution) |
| `#69 "Spiel beenden"` | (230,470)-(565,500) | sure-screen `#203 "Bist Du sicher, daß Du das Spiel beenden willst?"`; Ja: write the autosave (slot 000, only if autosave is not "Aus"), end the game, main menu; Nein returns here |

Multiplayer (no save/load/restart/briefing):

| button | rect | action |
|---|---|---|
| `#68 "Einstellungen"` | (230,305)-(565,335) | settings |
| `#70 "Zurück zum Spiel"` | (230,350)-(565,380) | resume |
| `#69 "Spiel beenden"` | (230,395)-(565,425) | sure-screen, Ja leaves the session (if the host leaves, the session ends for everyone) |

Restarting a free-play game reuses the record already modified by the free-play overrides, but the
seed is drawn again, so the restarted world is a new one (C).

In multiplayer the other players see the OK box `#199 "Ein Spieler hat den Pausemodus aktiviert!"`
when someone opens the menu (C; the multiplayer pause rules belong to
[multiplayer.md](../architecture/multiplayer.md)).

### 3.12 Mission end (C)

Mission goals are evaluated as described in [mdb.md](../formats/mdb.md) ("Goals"). The result is
shown as an **OK box over the game screen** (1.7); nothing else is drawn (no statistics screen, no
video for single missions). The box text:

| result | text | after OK |
|---|---|---|
| lost | `#219 "Du hast die Mission verloren!"` | game ends. Campaign/tutorial: briefing of the **same** mission (retry or Zurück to the list). Free play and multiplayer: main menu |
| won | `#218 "Du hast die Mission erfolgreich beendet!"` | game ends. Campaign/tutorial: record progress (section 5) and open the briefing of the **next** mission. Free play (single player): outro video of the player's race, then main menu. Multiplayer: main menu (no video) |
| object limit | `#319 "Die Objektobergrenze wurde erreicht! Programm wird beendet!"` | then the "won" box and its flow (the original treats hitting its object cap as a win) |

**End of a campaign:** when the "next mission" index equals the number of records, campaigns 0..2
play the outro of the player's race instead of a briefing: `outro-am.avi` (Amazons),
`outro-pi.avi` (Pimmons), `outro-sa.avi` (Sajiki). Videos play at 640 x 480 with the picture at
(0,60), 640 x 420, cursor hidden, like the intro; afterwards (or if the file is missing) the game
switches to 800 x 600 and opens the main menu. The tutorials just return to the main menu.

In multiplayer the last surviving player wins; the manual warns that the host clicking OK ends the
session for the others.

### 3.13 Multiplayer setup (C)

The original uses DirectPlay. The rebuild has its own lobby ([multiplayer.md](../architecture/multiplayer.md));
this section records the original screens so the look and the parameters can be reproduced.

Entering multiplayer sets the world parameters to the **multiplayer defaults**: 2 players,
size Mittel, resources Viel, development Hoch, stock Hoch.

#### 3.13.1 Player name

Title `#91 "Wie ist Dein Name?"`; `INPUT1` at (227,350), edit (260,371)-(526,390), max 20 characters,
black text, starts empty; `#75 "Zurück"` (260,420)-(370,470) to the main menu; `#92 "Weiter"`
(410,420)-(550,470) or Enter: accept (empty name = `#72 "Unbenannt"`) and open the connection list.

#### 3.13.2 Connection

Title `#94 "Wähle die Verbindung"`; list box (250,320)-(550,409), `dv14pt` black / red, centred,
lines `#125 "TCP/IP Verbindung"`, `#126 "IPX Verbindung"`, `#127 "Serielle Verbindung"` (other
providers are hidden); `#75 "Zurück"` (340,420)-(460,470) back to the name screen. Errors use OK
boxes `#95`..`#99`, `#93` (DirectX missing). Rebuild: one entry ("Internet/LAN") or skip the screen.

#### 3.13.3 Session list

Title `#100 "Wähle die Session"`; list box (250,320)-(550,400), `dv7pts2` black / red, centred, one
line per open session (session name); click = join. Buttons: `#74 "Neu"` (250,420)-(340,470) new
session; `#101 "Suchen"` (410,420)-(600,470) refresh (the list is also refreshed automatically every
7 s while this screen is open); `#75 "Zurück"` (340,450)-(460,500) back to the connection list.
A non-empty result plays effect `sfx_067.wav` (I for the mapping). Errors: `#102`, `#103`..`#106`.

#### 3.13.4 New session (host)

| element | rect / position | font / colour | action |
|---|---|---|---|
| title `#108 "Neue Session"` | (230,240)-(565,270) | `dv18pt` blue | |
| label `#109 "Name der Session"` | (220,285)-(565,315) | `dv14pt` brown, C | |
| `INPUT1` + edit | plate (227,315), field (260,336)-(526,355) | `dv7pts2` black, max 15 chars | default `#107 "Die Völker"`; clicking clears it; Enter stores it |
| label `#110 "Anzahl der Spieler"` | (220,382)-(565,412) | `dv14pt` brown, C | |
| `PFEIL-LINKS` (43 x 48) | (310,410) | | players - 1 (minimum 2) |
| player count | (380,425)-(400,445) | `dv18pt` brown, C | "2" or "3" |
| `PFEIL-RECHTS` (42 x 48) | (430,410) | | players + 1 (maximum 3; stays 2 on a serial link) |
| `#293 "Weltparameter"` | (220,475)-(565,490) | `dv14pt` brown / red, C | world parameters, multiplayer variant (3.7) |
| `#75 "Zurück"` | (260,500)-(370,530) | same | session list |
| `#92 "Weiter"` | (410,500)-(550,530) | same | create the session; on success: MP race selection. Errors `#111`, `#112`, `#104`..`#106` |

When the host creates the session it draws the **terrain seed** (random 0..32767) that all players
will use.

#### 3.13.5 Multiplayer race selection

Same layout as 3.4 (`RASSENWAHL`, `WAEHLEVOLK` at (227,56), three figures, hover name plates).
Races already chosen by other players are disabled. "Zurück" (340,522)-(460,540) leaves the
session. Clicking a free race: mode 4, `Infinite.mdb` record = race index, apply the stock override
(section 6), send the choice; on confirmation the chat lobby opens. Error `#114 "Fehler beim Senden!"`.

#### 3.13.6 Chat lobby

| element | rect / position | font / colour | notes |
|---|---|---|---|
| title `#121 "Chat"` | (230,240)-(565,259) | `dv18pt` blue | |
| chat log | (250,260)-(550,420) | `dv7pts2` black, 13 px lines, not selectable | first line `#122 "Server initialisiert."`; system lines `#119 "Spieler %s wählt %s und tritt in das Spiel ein."`, `#120`, `#123 "Warte auf %d Spieler"`, `#124 "Alle Spieler komplett!"`, `#194`/`#195` |
| `INPUT1` + edit | plate (227,430), field (260,451)-(526,470) | `dv7pts2` black, max 30 chars | Enter sends the line |
| `#75 "Zurück"` | (260,500)-(370,520) | `dv14pt` brown / red | leave the session |
| `#115 "Spiel starten"` | (400,500)-(580,520) | same | host only, appears when all players have joined. Sends "start" with world size bits and seed; everybody goes to the loading screen |

In-game chat prompts `#201`, `#244`..`#246` (F1..F4) belong to the in-game UI.

## 4. Stored settings and progress

### 4.1 `savegames\an.cfg` (C)

A 46-byte binary file in the game folder's `savegames` directory, little-endian, no header. Read
once at start; written when it is first created, when campaign progress changes, and when the
program exits. If it does not exist it is created with the defaults below.

| offset | size | field | default | GOG sample |
|---|---|---|---|---|
| 0 | u8 | hardware acceleration (0/1) | 0 | 0 |
| 1 | u8 | alpha shadows | 1 | 1 |
| 2 | u8 | EAX | 0 | 0 |
| 3 | u8 | sound on | 1 | 1 |
| 4 | u8 | menu scrolling | 0 | 0 |
| 5 | u32 | effects volume 0..100 | 100 | 100 |
| 9 | u32 | speech volume 0..100 | 100 | 100 |
| 13 | u32 | music (CD mixer) volume 0..100 | current mixer value | 67 |
| 17 | 4 x u32 | **campaign progress** for mode 0 Amazons, 1 Pimmons, 2 Sajiki, 3 tutorials | 0, 0, 0, 4 | 0, 0, 0, 4 |
| 33 | u32 | autosave: 0 off, 1 = 10 min, 2 = 20 min, 3 = 30 min | 1 | 1 |
| 37 | u32 | screen width (800 / 1024) | 800 | 800 |
| 41 | u32 | screen height (600 / 768) | 600 | 600 |
| 45 | u8 | hardware scrolling | 1 | 1 |

The rebuild can keep the same fields in browser storage (or an importable copy of this file, so a
player's original progress can be carried over).

### 4.2 Other configuration files (C)

| file | content | rebuild |
|---|---|---|
| `<Windows dir>\AlienNations_usa.ini` (German build: the error text names "DieVölker.ini") | `[SearchPaths] HDDSearchPath`, `CDSearchPath` (where `Data` lives), `[Info] Version` (main-menu label) | not needed |
| `Data\CDAudio.ini` | `[TRACKS] MENU=2 FIRST=3 LAST=11` | menu music track and the game playlist range (section 7) |

No registry keys are used for settings or progress (only the ini functions and `an.cfg`).

### 4.3 Savegame slots (C)

`savegames\SAVEGAME.000` .. `SAVEGAME.099`. Slot 000 = autosave, 001 = quicksave, 002..099 = player
saves (at most 98). Each file starts with: 4 bytes `GSVD`, u32 version 106 (versions 104..106 are
accepted), u32 0, u16 name length (including the NUL), the name, then u32 human race, u32
race group (race + 3), u32 mode (0..4), u32 mission index, 8 bytes of view state, then the world.
Only the name is read when the lists are built. On load the game reopens the `.mdb` of the stored
mode and takes the stored mission record, so mission texts and goals come from the data files, not
from the save. (The rebuild has its own save format; this is for reference and possible import.)

## 5. Campaign unlock logic (C)

- `progress[mode]` (an.cfg offset 17) is the highest mission index the player may choose.
- The mission list shows records with index `0 .. min(progress[mode], count - 1)`.
- Defaults: campaigns 0 (only the first mission), tutorials 4 (all five tutorials open from the
  start).
- Winning mission `i` of mode 0..3 sets `progress[mode] = max(progress[mode], i + 1)` and saves
  `an.cfg` immediately, then opens the briefing of mission `i + 1`. When `i + 1` equals the record
  count (10 for campaigns, 5 for tutorials) the campaign is complete (outro or main menu, 3.12).
  `progress` may then be 10, which simply lists everything.
- Losing changes nothing. Free play (mode 4) and multiplayer never touch progress.
- Campaigns are independent per race; there is no global unlock (all three races are always
  selectable).

## 6. Free-play world setup

### 6.1 Parameters and defaults (C)

| parameter | values | single-player default | multiplayer default |
|---|---|---|---|
| world size (Weltgröße) | Klein / Mittel / Groß | Mittel | Mittel |
| resources (Anzahl Rohstoffe) | Wenig / Mittel / Viel (0/1/2) | Viel | Viel |
| development (Entwicklungsstufe) | Niedrig / Mittel / Hoch (0/1/2) | Niedrig | Hoch |
| stock (Lagerstand) | Niedrig / Mittel / Hoch (0/1/2) | Niedrig | Hoch |
| players | 2..3 (multiplayer only) | - | 2 |
| human race | chosen on the race selection | - | each player's choice |

The single-player defaults are reset every time the single-player mode menu opens; the
multiplayer defaults every time "Mehrspielermodus" is chosen.

The handbook's four items map 1:1: "Size of World" = Weltgröße, "Quantity of Resources" = Anzahl
Rohstoffe, "Stage of Development" = Entwicklungsstufe, "Level of Supplies" = Lagerstand.

### 6.2 Mapping onto the mission inputs (C)

Free play uses `Infinite.mdb`: record 0, 1 or 2 = "Erschaffe eine Welt" with Amazons, Pimmons or
Sajiki as the human (the other two are computer players with random AI profile; win = both other
races eliminated). Record 3 "Multiplayer" is not used by the menu code (multiplayer also picks
record = the player's race). The records have no map file, so the world is generated.

| input | source |
|---|---|
| terrain size bits | world size: Klein = 7 (128 cells), Mittel = 8 (256), Groß = 9 (512). The record's own size field (9) is ignored when the seed field is -1 or in multiplayer |
| terrain seed | record seed is -1, so: single player draws a fresh random seed (0..32767) at every start, including restart; multiplayer uses the seed drawn by the host when the session was created and sent with the start message. See [terrain-gen.md](../formats/terrain-gen.md) |
| start gold and start goods | **stock** overwrites, in all three race blocks, start gold (+0x0C) and goods 0..5 of the first town hall column (+0x1C + 8i, i = raw material, wood, stone, iron, food, weapons): Niedrig = 300 gold / 15 each, Mittel = 3000 / 20, Hoch = 10000 / 25. Goods 6..8 and the second column keep the record values (0) |
| research | **development**: every player in mode 4 (human and computer, single player and multiplayer) gets research level 12 (Mittel) or 20 (Hoch) when set up (all inventions with index <= n start researched, as for field +0x64); Niedrig adds nothing. **Gold, add-on free play** (`InfiniteAO.mdb`): the same routine also marks 30 Werft and 31 Hafen (both levels) and 32 heavy warship (Hoch), see [economy.md](../game/economy.md) 4.4.2 |
| object population | **resources** only affects the random placement of trees, stones, bushes and similar nature objects by the free-play populator (more and larger clusters with higher values; e.g. tree clusters grow by 10 trees and stone clusters by 3 stones per level, and the number of resource sites is r + 4 on 128-cell maps, 2r + 6 otherwise). The populator itself is not specified yet (I for the summary; it also uses its own clock-seeded random numbers in the original, which a deterministic rebuild must replace with the game seed) |
| start positions | taken from the generator's start-position list (see [dvm.md](../formats/dvm.md), list 4) |
| relations | all pairs start at 0 (no map file, see mdb.md) |

Note for [mdb.md](../formats/mdb.md): its "free-play menu override" paragraph calls the gold/goods
setting "resources"; in the menu it is **Lagerstand** (stock). "Anzahl Rohstoffe" is the separate
object-density setting above.

## 7. Music and sounds in the front end (C)

- Menu music: CD track `MENU` (2) starts when the main menu is first created and keeps playing
  through all menu screens, the briefing included. Opening the in-game options menu also switches
  to the menu track; when play resumes the game playlist continues from where it was.
- Game music: tracks `FIRST`..`LAST` (3..11) start after loading. The GOG version ships them as
  `Bin/music` files.
- Videos and the loading screen stop the music.
- Button press sound: effect 42 (I for the file mapping, see 1.2). Briefing speech: section 3.6.

## 8. Unused or uncertain

- Not referenced by AN.exe: `EINFUEHRUNG`, `MESSAGEBOX2`, `INPUT2`, `INPUT3`, `CURSOR`,
  `SCHIEBERING-SOUND1`, and the `...AO` briefing art (not even present in the GOG `mainmenu.gd`;
  the Gold Edition has and uses it, [addon.md](../formats/addon.md) 3.2).
- Exact pixel look of hovered sprite buttons (the arrows, race figures): the original applies a
  colour tint (light blue `#9696FF` on hover, white for disabled); text buttons only change colour.
- Edit-field caret appearance; whether the mouse wheel scrolls menu lists.
- The 50 ms animation step is a minimum interval tied to the redraw rate; real speed on the original
  was likely 15-20 frames per second.
- Effect file numbers for the click sounds assume the loader numbers effects from 001 in order.
- Whether the host's resources/development/stock settings reach the clients in multiplayer: the
  start message carries only size and seed, and every client applies its own stock and development
  values (which are the multiplayer defaults unless changed). The rebuild should send all four
  parameters.
