# In-game side panel (HUD) and screen layout

Status: **layout constants, widget behaviour and page contents read from AN.exe** (addresses are
cited as evidence, no code is reproduced). Items marked *(uncertain)* are inferred, not confirmed.
The 1024x768 layout is the reference. 800x600 differences are listed in section 9.

Conventions in this document:

- All rectangles are `(left, top)-(right, bottom)` in pixels, right/bottom **exclusive** unless
  written as `w x h`.
- "Panel coords" are relative to the panel's top-left corner. "Page coords" are relative to the
  page origin (section 5), which is panel (4, 335).
- `T<n>` is a `DV.tdb` string id (decode per `docs/formats/os-dvf-tdb.md`), quoted in German.
- Sprite names without a path are entries of `<RACE>/interface.gd` (each race has its own
  archive with the same names; the panel loads the player's race). Names like `BIPI\MI\...` are
  `dv.gd` entries.
- Colours are given as RGB triplets. In the executable they are stored as Windows-style
  `0x00BBGGRR` values (low byte = red). This was confirmed from the HP colouring (green/yellow/red)
  and the race colours on the minimap.

## 1. Screen layout

| region | rect (1024x768) | content |
|---|---|---|
| world view | (0,0)-(832,768) | the map. Width = screen width - 192, full height. No top bar. |
| side panel | (832,0)-(1024,768) | `INTERFACE1024` background + widgets, full height, flush right |

Layout constants are derived from the screen size W x H at mode switch (`00483da0`, tail of the
mode-setup function around `00486a30`): panel x = W - 192, panel width 192, panel height H,
page area top = 335, page area height = H - 335.

Overlays drawn by the world view (`00443ee0`), in this order:

1. **Message list** (top-left of the world view): timed text lines, font `dv7pts2.dvf`, white,
   first line at (20, 12), one line every 20 px downwards. Each entry expires 5000 ms after it
   was added. Mentor (advisor) lines use this list: when the advisor speaks, the line from
   `Mentor.tdb` is added here and `data\sound\mentor\NNN.wav` is played (`00410a20`). Chat and
   network notices (player joined/left, pause) are added to the same list.
2. **Input line** (bottom-left of the world view): only while chat/command input is active. Text
   drawn at (0, H - 20), font `dv7pts2.dvf`, prefix by target: T201 "Nachricht an Amazonen:",
   T244 "Nachricht an Pimmons:", T245 "Nachricht an Sajikis:", T246 "Nachricht an alle Spieler:",
   or the literal `Command: ` (cheat console). The strip (0, H-20)-(W-192, H) is redrawn each frame.
3. **Modal message box** (when open): fixed rect (200,190)-(600,440) (the `MESSAGEBOX` sprite is
   400x249). It is not centred for 1024x768 *(as coded; uncertain whether intentional)*.
4. **Tooltip** (section 4.3), drawn last.

There is no separate status/ticker bar; the money display lives in the panel (section 3.6).

### 1.1 Advisor (mentor) lines: who says what, cooldowns, voice and dropping (C)

The advisor has two halves. A **per-nation filter** sits in the simulation and decides whether a
line is sent at all. A **voice player** on each client decides whether a line that arrives is
heard and shown. Neither has priorities, and neither holds a line for longer than one frame.
So the advisor is mostly silent, and lines that come together are lost.

#### 1.1.1 The nation's filter (C, `0045e0e0` / `0045e120` → `00410df0`; arm `0045e170` → `00410e90`)

- Only nations with an advisor object (nation +0x22c) have one. Human players have it.
  **Computer players have none**, so every line addressed to a computer nation is ignored.
- The object holds **82 slots, one per line id 0..81**. Each slot has an interval and a last
  time. All are zero when it is created (`00410dd0`).
- Time is the machine's millisecond clock (GetTickCount), not game ticks.
- **Say(line, queue flag, interval, cell)**: the caller passes the interval in ms, 0 = none.
  1. The slot's interval is set to the given value. Every call overwrites it.
  2. If the interval is not 0 and |now − slot.last| < interval, the line is **dropped**. Nothing
     is sent and the last time stays as it was.
  3. If the interval is not 0, slot.last = now. **With interval 0, the last time is not
     touched.** A later call with an interval is then measured from the last time a call that had
     an interval was let through.
  4. Message 0x4D (line id, queue flag, cell; the cell is -1/-1 for lines without one) goes to
     that nation's own client.
- **Arm(line, interval)**: slot.last = now and slot.interval = interval. Nothing is said. It
  silences a related line for the interval, because that line's own say is then measured from
  now.
- The slots start at time 0 and the clock counts from machine start, so a line's first say is
  never dropped *(I)*.
- **Advisor time unit D** = `DAT_004a5d7c` = **60000 ms**. This is read from `.rdata` at
  0x4A5D7C, so **2 D = 120 s**. Every interval used is 2 D, or the random need interval
  rand() mod 2 D + 2 D (120..152.8 s, as rand() < 32768; economy.md 5.4).

#### 1.1.2 The client's voice player (C, `00410a20`; per-frame step `00410d10`)

The player has one **current voice** (a sound buffer, or none). It also has a **pending list**:
a first-in-first-out linked list of (line, cell). The list has no length limit.

**Speak(line, queue flag, cell)** runs when message 0x4D is handled (`00457d90`):

1. **Speech unavailable** (no sound device, or speech switched off): the pending list is
   **emptied**, and the text line is added to the message list (section 1, 5 s). No voice.
2. **A voice exists** (not yet released):
   - queue flag set: (line, cell) is appended to the pending list. No text yet;
   - queue flag clear: the line is **dropped**, with no text and no voice.
3. **Otherwise** `data\sound\mentor\NNN.wav` (3 digits) is loaded and played as the current
   voice, and the text line is added.
   - If loading fails (a missing file), the voice is released at once. The text is still shown,
     and the next line is not blocked.

**Per frame**: the world-view frame function calls this step once, after drawing (`004444c0`
tail → `00410d10`):

1. If a voice exists and its buffer no longer reports "playing", it is released.
2. If the pending list is not empty, its **oldest entry is removed and passed to Speak with the
   queue flag clear**. So if the voice is still playing, that entry is dropped (no text).

What follows from this:

- **A queued line does not really wait.** The step at the end of the frame in which it arrived
  (or, behind other pending entries, one frame later per entry) is its only chance. Only one
  pending entry is used up per frame. It plays only if the current voice stopped before that
  step.
- An advisor voice lasts one to three seconds, which is dozens of frames. So every line that
  arrives while a voice plays is lost, queued or not. A queued line survives only when the voice
  ends during the few frames before its turn.
- **A burst of lines in the same frame** (for example "training finished" and a happiness line
  from the same tick) is heard as **its first line only**. Which one comes first is simply the
  order in which the simulation said them. The others are dropped, one per frame, and leave no
  text.
- There are no priorities and no replacement of the playing line. There is no "next" slot that
  survives.
- With speech off, every line that passes the nation's filter is shown as text.

#### 1.1.3 Every line and its trigger (C)

"Q" = queue flag set. Interval 0 = none. "2 D" = 120 s. Lines go to the nation named, which
hears them only if it is human.

| id | text (Mentor.tdb) | said when | Q | interval | arms (2 D) | evidence |
|---|---|---|---|---|---|---|
| 1 | Ein Gebäude ist fertig. | a builder finishes a construction site. Not for a founded town hall (units-and-jobs.md 6.5, 11) | Q | 0 | | `004757f0` |
| 2..8 | Dir fehlt Holz/Stein/…/Maden! | the worker and goods dispatcher (`0046fa10`) finds none of a needed good in stock for a request. The id is the good record's +0x130, plus the race for the crop good. Human nation only | Q | 2 D | | `0046fa10` |
| 9 | Du hast keinen Baumeister! | the dispatcher has a builder request and the town has no builder at all (town +0x140 = 0) | Q | 2 D | | `0046fa10` |
| 10 | … hat seinen Betrieb aufgenommen. | an operator enters and the building activates (unless it was already in state 2) | Q | 0 | | `00460ed0` |
| 11 | … hat seinen Betrieb eingestellt. | an **active** building is deactivated (operator lost or sent out, `DEAKTIVIEREN`) while the building is **alive**. Not during destruction: phase 1 clears "alive" before it deactivates | Q | 0 | | `0045ff30` |
| 12 | Dem Gebäude fehlt ein Betreiber! | **client only**, from the finished-building info page (class 1): the page is built for an own building with upkeep that is **not active**, and the page has not said it yet. Exact rule in 1.1.5. Played directly, not through the filter | no | 0 | | `004187e0` → `004109f0` |
| 13 | Ausbildung abgeschlossen. | a training finishes | Q | 0 | | `00475ff0` |
| 14 | Du hast keine freien Träger! | the dispatcher finds no free porter (the town has none, or all are busy) | Q | 2 D | | `0046fa10` (2 places) |
| 15 | Forschung abgeschlossen. | a human town's research project completes | Q | 0 | | `0046f490` |
| 16 | Du investierst nichts in Forschung! | the research command is executed while the town's research share is 0 or its stored research spending is below 1 | no | 0 | | `00450910` |
| 17 | Deine Lager sind voll! | a unit with a load asks to enter and there is no room (`00460a10`), or a porter delivering finds no room (`0047c400`) | Q | 2 D | | |
| 18 | Dir geht das Geld aus! | after any change of the nation's money (settlement, income, spending) the money is below 6 | Q | 2 D | | `0045d780`, `0045dab0`, `0045db60` |
| 19 | … freut sich über eine neue Stadt! | a founder reaches his site and the town exists | Q | 0 | | `00479410` |
| 20 / 22 | Eine Stadt / Ein Rathaus wird angegriffen! | an impact hits a **building** that is alive with HP > 0. Line 22 for the town hall (type 40), otherwise 20. These are two separate slots | Q | 2 D | | `00481c40` |
| 21 | Eine Stadt wurde zerstört! | the town is destroyed (town hall died) | Q | 0 | | `00459400` |
| 23..25 | Die X wurden besiegt! | a nation is defeated. Sent to **every other** nation | Q | 0 | | `0045d2a0` |
| 26 / 27 | Nahrung knapp / Hungersnot | 50-tick happiness update of a human town (population > 0, first town hall active): food% < 100. Line 27 if food% < 50, otherwise 26 | Q | 2 D | 42, 43, 28 | `0045a7c0` |
| 42 | Zufriedenheit … angestiegen! | same update: happiness rose and food% = 100 | Q | 2 D | 43, 28 | `0045a7c0` |
| 43 | Zufriedenheit … gesunken! | same update: happiness fell and food% = 100 | Q | 2 D | 42, 28 | `0045a7c0` |
| 28 | Deine Bevölkerung ist unzufrieden! | **never said**. Its branch requires the happiness to be both changed and unchanged, so it cannot be reached (machine code at 0x45A9E2..0x45AAC2). It is only armed | | | | `0045a7c0` |
| 29..38 | … wünscht sich ein(e) X! | needs re-evaluation: each open need building (good record +0x130) | Q | rand() mod 2 D + 2 D | | `0045a2c0` (economy.md 5.4) |
| 39..41 | … verlangt mehr X! | needs re-evaluation: each open luxury | Q | same | | `0045a2c0` |
| 44..67 | diplomacy answers and declarations | the diplomacy exchange completes, to sender and target (ai-diplomacy-trade.md 3) | Q | 0 | | `00478910` |
| 68..70 | Die X haben eine Botschaft errichtet. | an embassy activates. Sent to every nation except its owner | Q | 0 | | `0045fa40` |
| 71 / 72 | Städte verfallen … Motivation / … Geld fehlt | the 600-tick condition run of a human town (economy.md 5.8): money = 0 → 72, otherwise happiness ≤ 49 → 71 | Q | 2 D | | `0045ab60` |
| 79 | Gebäude wird errichtet. | the simulation executes the player's place-building command (0x17, after the lockstep round trip, not on the click). Placement is re-checked OK (build-menu state 1 or 3, footprint and height range), then the line is said, then the site is created. Only the placing nation hears it | no | 0 | | `00451780` |
| 80 | Gebäude wurde abgerissen. | **phase 2 of any building's death** (combat.md 10.3, at the end of the collapse, not on the demolish click), if the building's town is still alive. **Every cause counts**: the demolish button, enemy fire, bombs, decay, a cancelled founding. Not for the buildings of a destroyed town (that town is no longer alive). A town hall says 80 and then 21 in the same tick, so 21 is lost (1.1.2) | Q | 0 | | `0045f5a0` |
| 81 | Tiere fressen Deine Plantagen auf! | an animal bites a crop. Sent to the crop's nation | Q | 2 D | | `00473d50` |

Lines 0 and 73..78 are empty and never said.

**Not said:** there is no line when a unit dies, when a criminal appears, or for an
enemy unit seen. Events of computer players never reach a human, except these:

- the defeat lines 23..25;
- the embassy lines 68..70;
- the diplomacy lines 44..67, which each concern the hearer's own relation.

Lines are per nation, not per town. A human's other towns all feed the same advisor.

The mentor WAV files are not in the uploaded data, so whether each `NNN.wav` exists is
unchecked *(uncertain)*.

#### 1.1.4 Rebuild notes (I)

- The filter state is the 82 slots per nation. Keep it **out of the simulation hash**, because
  nothing in the simulation reads it. Measuring it in game ticks × the tick length instead of the
  wall clock is a defensible choice. It keeps the line choice deterministic and lets it survive a
  save.
- The voice player is client state. It must not feed back into the simulation.
- Enhanced mode (setting "Advisor: queue lines", `advisorQueue`, off by default;
  `client/advisor-voice.ts` `AdvisorQueue`): a real pending queue instead of 1.1.2. Each queued
  line plays when the previous voice ends, unqueued lines are still dropped while a voice plays,
  and a client-side guard drops a line said less than 60 s before (not lines 1, 10, 13, 79, 80).
  The nation's filter (1.1.1) and the triggers (1.1.3) are the same in both modes. In this mode
  the 60 s guard also applies to line 12.
- Line 12 (1.1.5) is a client trigger. It never goes through the nation's filter or the
  simulation, so it is not part of lockstep, the hash or saves. Its state is two client values:
  the page's "not yet said" flag and the "last building" id.

#### 1.1.5 Line 12 "Dem Gebäude fehlt ein Betreiber!" (C, `004187e0`; Gold `0041beb0`, identical)

This is the only place that says line 12. No simulation code passes 12 to the filter (1.1.1),
and the info page is the only caller of the direct entry `004109f0`. Checked at instruction
level: AN.exe 0x418A97..0x418AB7, Gold 0x41C167..0x41C187.

**Where.** It is said while the side panel builds the **finished-building info page** (display
class 1, section 5.2). The page is built when its page message arrives. That happens when the
selection changes and on the player's refresh job, every 10 ticks (`0046ed90`), so about twice
a second while the page is open.

**State.**

- The page object has a one-byte **"not yet said" flag** (page +0x30). It is set to 1 when the
  object is created (`004186b0`). A new class-1 page object is created whenever the panel switches
  to class 1 from another class or from no page (`00455d00`: a page message whose class differs
  from the current page's class destroys the old page and creates a new one, `00413640`). It is
  **not** created again while class 1 stays open and only its building changes.
- A process-wide **"last building"** (`DAT_004af4b0`, initially −1) holds the object id of the
  building the class-1 page was last built for.

**Each build of the class-1 page:**

1. If the shown building's id differs from "last building", that id becomes "last building" and
   the flag is set to 1.
2. The building's own name, town, HP and buttons are drawn as in 5.2.
3. Only if the building's record race (+0xA0) is the local player's race, **and** its upkeep
   (record +0xD4) is not 0: the upkeep block is drawn. Then, if the building's display object is
   **not active** (display +0x1FD = 0):
   - if the flag is 1: line 12 goes to the voice player (1.1.2) with the **queue flag clear** and
     no cell, and the flag is cleared;
   - the `KOSTEN` icon is drawn disabled (dim).

**The byte tested.** Display +0x1FD is the building's **active** flag (`objects.md` 4.2). The
constructor clears it (`00433e10`). It is set by display message 0x2E, which activation
(`0045fa40`, state 2) sends. It is cleared by 0x2F, which deactivation (`0045ff30`) sends. It is
saved with the display. It is **not** a "construction finished" flag. So "not active" means that
the building is complete but its operator has not entered yet (`units-and-jobs.md` 6.5 step 5,
8.1), or that it was deactivated (operator sent out, `DEAKTIVIEREN`, 4.11).

**Which buildings.** Every building record of every race has upkeep > 0 (Gold `dv.odb` +
`Addon.odb`: houses 5/7 up to library, bank, theatre 50). Buildings without an operator
(+0xD8 = −1: houses, warehouse, schools, barracks, outposts, market, harbour, shipyard, ...) are
activated at completion, so they are never inactive on this page. In practice the line concerns
the buildings with an operator: town hall (founder), embassy, the race's food/luxury producers
(44, 45), laboratory, library, bank, mine, newsstand, police, theatre (57), warrior table (58),
temple, watchtower and weapon factory (61).

**What follows.**

- The line is said **when the player opens the info page of an own inactive building**: on
  selecting it while another page or nothing is shown, on switching from another building's info
  page, or on returning to the info page from another page of it (inhabitants, production).
  Selecting the same building again right away (the page stays) says nothing.
- If the shown building was active when the page opened, the flag stays 1. When the building
  then becomes inactive while its page stays open (the operator is sent out, or `DEAKTIVIEREN`),
  the next refresh says line 12. Line 11 (queued, said by the simulation at the deactivation) has
  usually started its voice by then, so line 12 is then dropped (1.1.2).
- It is **per page opening**, not per building or town. There is no interval and no cooldown.
  Opening the page repeatedly says it each time, as long as no voice is playing.
- A building completed while its construction-site page is open switches to class 1 at the next
  refresh, which says line 12. But line 1 "Ein Gebäude ist fertig." (queued, said at the
  completion) is usually still playing, so line 12 is then lost.
- Unqueued: if any advisor voice is playing, the line is dropped with no text (1.1.2). With speech
  off it appears as text only.
- Computer players have no client, so they never hear it. In multiplayer each client says it for
  its own selection only. It never reaches the simulation.

## 2. Panel background and sprites

- Background: `INTERFACE1024` (192x768), blitted opaque (its alpha is 0 everywhere; ignore
  alpha). It contains all frames, the minimap's white placeholder square, the zoom track art,
  the brown town-list box, the red money bar, the wooden plank behind the function bar and the
  dark stone lower area.
- The background is identical for the three races except for colour details; the top 335 rows
  of `INTERFACE800` match `INTERFACE1024` pixel for pixel in the minimap area and visually in
  the rest.
- Sprite offsets: most interface sprites have rect (0,0,w,h). Exceptions that matter:
  `SCHATZKISTE` carries its panel position in its rect (Pimmons (106,256)-(171,318), Amazons
  (110,256)-(175,315), Sajiki (110,260)-(172,318)); it is drawn with that offset relative to the
  panel origin. `SIDE_PFEILOBEN/UNTEN` and `GOLD` have non-zero rects too, but the code only
  uses their width/height and positions them explicitly.

## 3. Fixed panel elements (always present)

Constructor `004230c0`; per-frame update `00423740`; draw `00424930`.

| element | rect (panel coords) | sprite | behaviour | tooltip |
|---|---|---|---|---|
| minimap | (6,6)-(158,158), 152x152 | drawn into the white square | section 6 | - |
| layer toggle: buildings | (166,54) 20x20 | `GEBAEUDE` | toggles minimap building layer; default **on** | T41 "Gebäude" |
| layer toggle: units | (166,82) 19x20 | `EINHEITEN` | units layer; default **on** | T60 "Einheiten" |
| layer toggle: resources | (166,109) 20x20 | `HAENDLER` (money bag icon) | nature/resource layer; default **off** | T61 "Rohstoffe" |
| layer toggle: town areas | (166,137) 20x20 | `STADTGEBIETE` | tints terrain by owning town's race; default **off** | T62 "Stadtgebiete" |
| options | (11,162) 30x30 | `OPTIONEN` | opens the in-game options menu (`004295e0`) | T63 "Optionen" |
| zoom slider | track (54,165)-(162,196) | handle `RING` 21x21 | section 7 | - |
| town list | (20,200)-(141,271) | none (text rows on the background box) | section 3.5 | - |
| town list scrollbar | track (172,207)-(203,291) | handle `RING` | vertical; only scrolls the town list | - |
| money counter | text rect (18,280)-(119,297) | - | section 3.6 | - |
| money chest | sprite rect (see section 2) | `SCHATZKISTE` 6-7 frames (0 closed .. last open) | opens once at 5 fps when the counter starts, holds open, closes once in reverse when it stops (3.6) | - |
| function bar | y = 300, x = 12 + 28*i | 30x30 icons | section 3.4 | per button |
| page area | (4,335)-(196,768) | dark background | pages, section 5 | - |

Nothing interactive exists in the top-right corner (x 160..190, y 0..50); the red crosshair there
is background art *(uncertain whether the original reacts to clicks there; no widget was found)*.

### 3.1 Generic button behaviour (all icon buttons)

Widget classes `004145d0` (plain), `004150b0` (command button), `00415af0` (image toggle).

- Size = the sprite's size; position = top-left as given.
- State bits (widget +0x30), C: 0x04 hover, **0x08 ignores clicks**, 0x10 "off" look, **0x20
  dim look**. "Disable" (`004149a0` false) sets 0x28 and clears 0x04; "off" (`004149d0` false)
  sets 0x10. A widget with only 0x20 looks disabled but is still clickable (the queued slots of
  the training page, class 7).
- **Which look** (`00414b90`, C). The first rule that matches wins:
  1. **hover**: the widget has the hover look enabled (+0x58, see "widget kinds" below) and bit
     0x04 is set;
  2. **dim**: bit 0x08 or bit 0x20;
  3. **off**: bit 0x10 (a toggle that is not active, such as a hidden minimap layer; a build-menu
     entry or a cost icon you cannot afford);
  4. otherwise **normal**.
- **How a look is drawn** (C, `00414b90` → colourize setup `0048de00`, alpha blit `0048ee90` with
  its inner loops `0048f2a0` / `0048f5c0`). Every panel button and picture is drawn with the
  **alpha blit**: the sprite's own 8-bit alpha plane decides how much of each pixel covers the
  background. (Only the list-box backgrounds, `LISTBOX`, switch to the plain colour-key blit, and
  they are never tinted.) A tinted look **mixes every sprite pixel 50:50 with one fixed tint
  colour**, then alpha-blends the result onto the background like a normal pixel:

  - mixed channel = (sprite channel + tint channel) / 2. In the original 16-bit (5-6-5) frame
    buffer the lowest bit of each colour field of both values is dropped before the add, so in
    8-bit terms it is close to floor(s / 2) + floor(t / 2).
  - output = background + (mixed - background) × alpha / 256, for every pixel of the sprite
    (alpha 0 changes nothing).

  | look | tint colour | per channel (s = sprite value 0..255) | what you see |
  |---|---|---|---|
  | hover | (150,150,255) | R = s/2 + 75, G = s/2 + 75, B = s/2 + 127 | the sprite lightened and washed with a pale lavender blue; all detail stays visible |
  | dim (disabled, or 0x20 alone) | (0,0,0) | each channel s/2 | **the sprite at half brightness**, colours and detail kept; clearly readable against the dark page |
  | off | (128,0,0) | R = s/2 + 64, G = s/2, B = s/2 | half brightness with a dull red cast |

  The colourize call also builds a 64-entry ramp table (black to the tint colour, indexed by the
  pixel's green field). That ramp is used only by the colour-key blit (`0048e830`), which panel
  buttons do not use; the alpha blit takes just the table's last entry, the full tint colour.
  *(An earlier version of this document read the ramp as the button look, which made dim
  buttons a solid black silhouette; that was wrong.)*
  The tint exists only in the 16-bit display mode the game runs in (in any other depth the
  colourize call switches itself off).
- **Normal look, alpha rule** (C, `0048f5c0` untinted): alpha below 64 is skipped, alpha 192 and
  more is copied opaque, values in between are blended by alpha / 256. A rebuild may simply use
  the sprite's alpha as is.
- There is **no pressed frame**; multi-frame button sprites (`PFEILLINKS/PFEILRECHTS` frame 1 is
  a green variant) are always drawn with frame 0 *(frame 1 use not found)*.
- **Widget kinds** (C, constructors):

  | kind | constructor | hover look | used for |
  |---|---|---|---|
  | button | `004145d0` | yes | function bar, toggles, page buttons, build-menu items, town-list status icons, scroll arrows |
  | command button | `004150b0` (same draw) | yes | training queue slots and trainable units, inhabitants, buildings list, unit portraits |
  | picture | `00424fe0` (hover look off, +0x58 = 0) | **no** | cost/goods bubbles, `GOLD`, `RAHMEN`, `LEISTE`, slider bars, list boxes, experience icons, message box art. Shows its tooltip; can still take the dim or off look |
  | text button | `004148b0` | text colour only: normal colour +0x70, hover colour +0x6c | town-list rows (white, hover red (255,0,0)), research and other list rows (white, hover red) |
- **Hover state** (C, `0048bdb0`, `00414e40`): mouse enter (window message 0x400) sets bit 0x04,
  mouse leave (0x401) clears it, and the widget (or the area it names in +0x74) is redrawn at once.
  A widget with bit 0x08 does **not** run this part, so a disabled button **never shows the hover
  look**, but it still shows and hides its tooltip. Widgets with only 0x20 (dim) or 0x10 (off)
  are clickable and **do** get the hover look, which wins over their own look while the mouse is
  over them.
- Hover has **no sound, no delay and no status-line text** (there is no status line). The cursor
  stays the arrow over the panel ([cursors.md](cursors.md) 5.2). The only hover feedback is the
  look above and the tooltip (4.3).
- *Our build* (`src/client/ui-tint.ts` `tintRgba`, `lookOf`; `hud.ts` `tint`, `imageButton`;
  `test/ui-tint.test.ts`): every panel sprite look is the 50:50 mix above with alpha kept, cached
  per sprite and look; the same per-pixel mix is applied to the HD image of a sprite (pack or
  rendered portrait) through `deriveHd`, so the HD mode looks the same. Buttons carry `disabled`
  (0x28), `dark` (0x20), `off` (0x10) and `picture` (hover look off, no click, no click sound);
  disabled buttons and pictures keep their tooltip.
- Input: left button down plays the UI click sound; the click fires on **left button up inside
  the same rect**. Command buttons send their stored game command on left-up, an optional
  second command on right-up, a third on double click (`00415220`). Commands go into the
  outgoing lockstep command queue; they are not applied locally.
- Mouse enter shows the tooltip immediately, mouse leave hides it (no delay, `004143c0` /
  `004143d0`).

### 3.2 Text widgets

- Label (`00416be0`): text placed at (x, y) in page coords; its box is the text's measured
  extent at creation. Horizontal align 0 = left, 1 = centre, 2 = right; vertical 3 = top,
  4 = centre, 5 = bottom, relative to that box.
- Text in rect (`00416ae0`): same, but with an explicit rect.
- Wrapped text (`00425fc0`): word-wrapped to its rect width, white.

### 3.3 Fonts

Loaded at startup (`00486cc0`). Advance per glyph = glyph width + letter spacing (or a fixed
advance). Missing lower-case glyphs fall back to upper case; `ä ö ü` fall back to `Ä Ö Ü`; `'`
and `` ` `` fall back to `´` (`00488f90`).

| file | height | letter spacing | space width | use in the panel |
|---|---|---|---|---|
| `dv7pts2.dvf` | 13 | 0 | 4 | almost all page text, town list, numbers, message list |
| `dv10pt.dvf` | 13 (caps only) | 1 | width of `E` | page titles, tooltips, section headings |
| `dv10pta.dvf` | 11 | 1, fixed advance 7 (8 px per char) | - | money counter |
| `dv18pt.dvf` | 23 | 1 | width of `E` | big percentages (training, construction, production) |
| `dv14pt.dvf` | 19 | 1 | width of `E` | message boxes only (not the panel) |

Text colour is white unless stated. Other colours used: pale yellow (255,255,150) for the
needs page captions, red (255,0,0) for the research "Aktuell" heading and negative values,
green (0,255,0) for a positive balance.

### 3.4 Function bar

Built by `00423940` every time the selection changes and when the page message arrives. Buttons
are 30x30 sprites at y = 300, x = 12, 40, 68, 96, 124, 152 (step 28; consecutive buttons overlap
by 2 px). The first button is always `GEBAEUDEBAUEN` if the player owns at least one town; the others
shift right by one slot if it is absent. Clicking a button sends a "show page N" command
(logical page numbers, section 5.1). When the page data that arrives is empty (page -1), all bar
buttons are shown disabled.

| condition | buttons (left to right) | tooltip | logical page |
|---|---|---|---|
| player owns a town | `GEBAEUDEBAUEN` | T1 "Gebäudebau" | 8 |
| **nothing selected** | `GEBAEUDEINFO` | T41 "Gebäude" | 14 |
| | `BEWOHNER` | T39 "Stadtbewohner" | 6 |
| | `STADTSTATISTIK` | T10 "Finanzen" | 1 |
| | `MOTIVATION` | T27 "Bedürfnisse" | 7 |
| | `ROHSTOFFE` | T61 "Rohstoffe" | 5 |
| **something selected** | `INFO` | T2 "Information" | 0 |
| one own **building** | `BEWOHNER` | T38 "Im Gebäude" | 6 |
| ... embassy (type 42) | `DIPLOMATIE` (disabled until built) | T64 "Diplomatie" | 12 |
| ... laboratory (type 46) | `FORSCHUNG`, `HISTORY` (disabled until built) | T17 "Forschung", T24 "Geschichte" | 2, 3 |
| ... other building with a product (+0x11C != -1) | `PRODUKTION` (disabled until built) | T58 "Produktion" | 13 |
| one own **trader unit** (type 28) | `HANDEL` | T50 "Handelsroute" | 11 |
| one own training building (class 5) | `EINHEITENBAUEN` if school (type 55) else `KAEMPFERBAUEN` (disabled until built) | T0 "Ausbildung" | 4 |
| one own store building (flag 0x1) | town hall (40) only: `STADTSTATISTIK`, `MOTIVATION`; then `ROHSTOFFE` (disabled until built) | T10, T27, T61 | 1, 7, 5 |
| one **market** (type 48), own or foreign | `VERKAUF`, `EINKAUF` | T46 "Verkauf", T49 "Einkauf" | 9, 10 |

Market buttons are disabled until the market is built, and for a foreign market unless the two
races are at peace (relation state 3).

"Built" is the test of display +0x1FD. That byte is the building's **active** flag (set by
activation 0x2E, cleared by deactivation 0x2F, `objects.md` 4.2, 1.1.5), not the
construction-finished flag. So these buttons are really disabled while the building is inactive,
for example a laboratory without its operator. "Own" means record group (+0xA0) equals the
player's race. *Our build* (`hud.ts`) tests the active flag too.

### 3.5 Town list

Widget `00421b10` with rows built by `00422410`.

- Rect (20,200)-(141,271); font `dv7pts2.dvf`; row height = int(13 * 1.2) = 15 px, so **4 rows**
  are visible (rows at y = 200, 215, 230, 245).
- One row per town of the player's race, text = town name. Names come from the town-name
  strings T142.. ("Joyshire", "Wood Creek", ...). The current town is the selected row.
- Row text colour white; hover colour red (255,0,0) (C: the rows are text buttons, 3.1). Rows
  carrying a per-row flag use RGB (80,24,20) for both *(meaning of the flag uncertain)*.
- Status icons at the right end of a row, placed right-to-left starting with their right edge at
  x = 123 (list right - 18), 2 px gap, top at row y + 2 (`00424df0`):

  | icon | shown when | tooltip |
  |---|---|---|
  | `FORSCHBUBBLE` | research flag of the town set *(inferred: nothing is being researched)* | T190 "Es wird nicht geforscht" |
  | `NAHRUNG` | food shortage | T258 "Die Nahrung ist knapp" or T259 "Dein Volk hungert" (severity) |
  | `CRIMINAL` | criminals present | T260 "Es gibt Kriminelle" |
  | `WISH` | unfulfilled wishes | T261 "Nicht alle Wünsche werden erfüllt" |

  The icons are ordinary **buttons** (`004145d0`, C), so they behave like every other panel
  button (3.1): the **hover look** (50:50 mix with (150,150,255)) while the mouse is over them,
  the tooltip at once on enter (4.3), the UI click sound on left button down, the action on left
  button up. Their action (`00424ad0`, C by reading):

  - `FORSCHBUBBLE`: carries the town's laboratory. If that object still exists, the selection is
    replaced by it and page 2 (research) is requested. *(I: then the research page of that
    laboratory opens.)*
  - `NAHRUNG`, `CRIMINAL`, `WISH`: the selection is cleared, the row's town becomes the current
    town (the same command as a left click on the row), and page 7 (needs) is requested.

  *Our build* (`hud.ts drawTownList`): the icons are `imageButton`s with the hover look, tooltip and
  click sound; `FORSCHBUBBLE` selects the town's finished laboratory (type 46) and shows page 2,
  the others clear the selection, set the current town and show page 7.
- Left click on a row: command "set current town" (the build menu and town pages then refer to
  it). Right click: command "jump to town" (centres the camera on the town hall and selects the
  town).
- Scrolling: an up arrow `SIDE_PFEILOBEN` (18x12) at (140,200) appears when the list is
  scrolled down; a down arrow `SIDE_PFEILUNTEN` at (140, bottom of last visible row - 12) =
  (140,247) appears when more rows follow. Each click scrolls one row. The `RING` scrollbar to
  the right (track (172,207)-(203,291)) has range 0..(rows - 4) and scrolls in whole rows.

### 3.6 Money counter and chest

- Text: player's money, format `%d`, font `dv10pta.dvf`, right-aligned and vertically centred in
  (18,280)-(119,297), white. It sits on the red bar of the background, left of the chest.

Code: per-redraw update `00423740` (Gold: same logic, fields shifted); the layer player of
`docs/rendering/objects.md` section 2 (`004394f0`, `004395a0`); treasury messages
`0045dab0` / `0045db60` / `0045d780` / `0045e4b0` → handler `00457a50`. All (C) unless marked.

**Real value.** Every change of the player's treasury (income, payment, upkeep, start of the
game) clamps it at 0 and sends the panel the new total. The panel keeps two numbers: *real*
(last total received) and *shown* (what the counter displays). Both start at -1 when the panel
is created at the start of a map.

**Counter.** Once per redraw of the world view (`00443ee0` calls `00423740` every frame it
draws; there is no timer, see "rate" below), with d = |real - shown|:

- d = 0: nothing changes (the text is not redrawn). See "chest" for the state change.
- d >= 10000: shown jumps to real - 5000 (counting up) or real + 5000 (counting down), so a
  large change never takes longer than the 5000 tail.
- otherwise shown moves one step towards real: **1000** if d >= 5001, **100** if d >= 1001,
  **50** if d >= 101, **10** if d >= 51, **5** if d >= 11, else **1**. The step never overshoots.
- After each step the text `%d` of the new shown value is rebuilt (right-aligned, rect above).
  Before the first step there is no text at all, so the very first total of a map is counted
  up from -1 (e.g. start money 1000: 99, 149, 199, ... in 32 redraws; "-1" itself is never
  displayed).

Redraws needed for a change of d: 5 → 5; 40 → 16; 200 → 25; 1000 → 41; 4000 → 71;
9999 → 85; any d >= 10000 → 82 (one jump plus the 5000 run). Income and payments count the
same way, only the direction differs.

**Rate (I).** The world view is redrawn as fast as the main loop runs (no frame limiter was
found; the main loop does not sleep), so the counting speed depended on the machine. A rebuild
should step **once per displayed world frame** at its normal frame rate (about 60 per second
with `requestAnimationFrame`; a 1999 machine was nearer 20-30), and must **not** step on extra
panel repaints caused by mouse movement or clicks.

**Chest.** `SCHATZKISTE` frame 0 is the **closed** chest, the last frame is **wide open with
the gold showing**; the frames between open the lid step by step. Frame count per race (data):
Pimmons 6 (wooden chest), Amazons 7 (red chest), Sajiki 7 (shell). The code is the same for all
three; only the frame count and art differ. The chest is driven by a two-state switch that is
evaluated in the same per-redraw call, using the wall clock (`GetTickCount`), not game ticks or
the redraw count:

| state | entered when | animation | duration |
|---|---|---|---|
| initial | panel created | frame 0 (closed), not running | - |
| counting (1) | shown != real and the state is not already "counting" | start at frame 0, **5 frames per second** (200 ms per frame), **once, forward**, then **hold the last (open) frame** | 1.2 s (6 frames) / 1.4 s (7 frames) |
| rest (2) | shown == real, the state is not already "rest", and the counter text exists (i.e. at least one step has happened) | **5 fps, once, reversed**: starts on the last (open) frame and runs back to frame 0, then **holds frame 0** (closed) | 1.2 / 1.4 s |

Consequences that a rebuild must reproduce:

- The animation is (re)started **only on a state change**. While the counter keeps moving the
  chest opens once and then stays open; it never loops.
- The close always starts from the fully open frame, even if the opening had not finished
  (small changes count for only a few redraws): the chest then **snaps open and closes slowly**.
- A new change while the chest is closing switches back to "counting", which restarts at
  frame 0: the chest **snaps shut and opens again**.
- Direction (income or payment) and size of the change do not select different frames; the
  size only decides how long the counter, and so the open hold, lasts.
- Mode bits used: 0x02 (once) while counting, 0x02 + 0x04 (once + reverse) at rest; speed 5
  in both; start frame 0 in both (`docs/rendering/objects.md` section 2 gives the frame formula).

## 4. Panel-wide behaviour

### 4.1 Mouse wheel

- Over the page area rect (W-188, 335)-(W, H): wheel up = click the page's "scroll up" arrow,
  wheel down = click its "scroll down" arrow (only grid pages have them, section 5.3).
- Over the world view: each 30 units of wheel delta (a standard notch is 120 = 4 steps) changes
  the zoom value by one; wheel up zooms in. The zoom slider follows.

### 4.2 Keyboard zoom

Page Up sets maximum zoom-out (value 64), Page Down sets normal zoom (value 16). Other keys are
outside the panel's scope.

### 4.3 Tooltips

`004149f0` (attach), `004143f0` (draw).

- Font `dv10pt.dvf`, white text with a black copy offset by 2 px down (drop shadow). No box or
  background.
- A tooltip is one line of items (text, optionally preceded by a small icon); width = sum of
  item widths + 5, plus 15 between items; height = the tallest item.
- Position: its **bottom-right corner touches the bottom-right corner of the world view**, i.e.
  top-left = (W - 192 - width, H - height). It is therefore always left of the panel's bottom-left
  corner, never next to the cursor.
- Only one tooltip is active at a time (the last widget entered). It appears on mouse enter with
  no delay and disappears on mouse leave. Every widget kind with a tooltip shows it, including
  disabled buttons and pictures (3.1).

## 5. Page area (the dark lower part)

- Origin (4,335) in panel coords; nominal size 192 x (H - 335) = 192x433 at 1024x768. Every page
  widget position below is relative to this origin.
- Common page header: the page's icon sprite at (2,0), title label at (35,10) in `dv10pt.dvf`
  white, and a `LEISTE` separator (192x8) at (-3,30). Further `LEISTE` separators at the y given
  per page always use x = -3.
- Most pages end with a refresh that re-sends a synthetic mouse move so hover states update.

### 5.1 Logical pages and how one is chosen

The panel content is produced on the simulation side as a "page data" message and then shown by
the UI (`0044fc20` builds it, `00455d00` displays it). The player state remembers:

- the page used when nothing is selected;
- the page used while something is selected;
- **per building/unit type**, the last page used for that type (except pages 0, 6 and 8 for
  buildings, 0 and 8 for units). Selecting an object therefore reopens the page last used for
  its type.

Rules:

| situation | page shown |
|---|---|
| nothing selected, page 8 requested | build menu if the player has a current town whose town hall is finished, else empty |
| nothing selected | requested page (1, 5, 6, 7, 14) for the current town; empty if no town |
| several objects selected | page 0 (group info), or 8 if the build menu was open |
| one object selected, page 9/10 | only for a finished market of the own race or a race at peace, else page 0 |
| one object selected, other page | page applies only to own objects (and page 6 or a finished building); else page 0 |
| selection of a building while page 8 is open | page switches to 0 (`00450700`) |

Logical page -> display class (the class decides the layout):

| logical | meaning | display class |
|---|---|---|
| 0 | info: unit / building / construction site / nature / group | 0 / 1 / 15 / 17 / 2 |
| 1 | finances (town) | 3 |
| 2 | research (laboratory) | 4 |
| 3 | research history | 5 |
| 4 | training | 7 |
| 5 | raw material stock | 10 |
| 6 | inhabitants (town or building) | 9 |
| 7 | needs / motivation | 8 |
| 8 | build menu | 6 |
| 9 | market: selling | 11 |
| 10 | market: buying | 12 |
| 11 | trade route | 13 |
| 12 | diplomacy | 14 |
| 13 | production | 16 |
| 14 | buildings list (town) | 18 |
| -1 / -2 | nothing to show | page area left empty |

### 5.2 Info pages (logical page 0)

#### Class 0: unit (`00417fe0`, data `00455d50`)

| element | position (page) | details |
|---|---|---|
| header | | `INFO`, T2 "Information" |
| portrait | (73,50) | 45x45 `dv.gd` icon of object (race + 3, type), e.g. `BIPI\MI\BAUMEISTER\MS0` |
| type name | rect (0,93)-(192,120), centred | record name (+0x14C), `dv7pts2` |
| home town name | rect (0,108)-(192,135), centred | only if the unit has a home town |
| hit points | rect (118,50)-(183,95), left, bottom | `cur/max` (max = record +0xAC). Colour: green (0,220,0) if cur > 90% of max, red (255,0,0) if cur <= 30%, else yellow (220,220,0) |
| experience | (118,75) | level 1 `ERFAHRUNG3`, 2 `ERFAHRUNG2`, 3 `ERFAHRUNG1`; none at 0 |

Own units except criminals (type 12) also get the elements below. A selected criminal (own
or foreign) and every foreign unit show only the block above: portrait, name, home town, HP
and experience, with no buttons and **no status text** (C, `00455d50`; `combat.md` 12.6).

The extra elements:

| element | position | action / tooltip |
|---|---|---|
| separator | (-3,130) | |
| `MOVEHOME` | (10,135) | command 0x20 "go home": a walk to the first free cell around the town hall of the player's current town; it enters no building (`units-and-jobs.md` 3.2); T3 "Nach Hause". Disabled when the player has no town, or while the unit is inside a building |
| `PATROL` | (40,135) | soldiers only (types 29..36): enters patrol-target mode (Ctrl adds waypoints); T5 "Patrouillieren (+STRG f. Wegpunkte)". Same disabling as above |
| `GRUENDEN` | (40,135) | founders only (type 10): enters town-hall placement mode (see "Town-hall placement" in 5.3); T6 "Stadt gründen". Disabled with T172 "Maximale Städteanzahl erreicht!" when the nation has exactly 10 towns; disabled with T6 while the founder is inside a building. Enabled for a founder whose player has no town yet (`00455d50`) |
| separator | (-3,163) | |
| status text | wrapped in (10,172)-(185,202) | "Ist in Gebäude: %s" (T280) when inside a building, else the current job description (T262..T281, T305, T310, e.g. "Trägt %s zu %s"; a news seller on his round T270 "Verkündet Neuigkeiten", `units-and-jobs.md` 8.6), else T278 "Ohne Aufgabe". Table: `docs/rendering/unit-motion.md` 6 |
| `WEGWERFEN` | (40,135), or (70,135) for founders | only when carrying goods: command "drop goods"; T140 "Rohstoff wegwerfen" |
| "Trägt" | rect (35,200)-(120,230), left, centre | T7, only when carrying |
| carried good icon | (100,200) | 30x30 `RS\MI\<GOOD>\MS0` (interface.OD group 6), tooltip = good name |
| carried amount | rect (130,200)-(160,230), left, bottom | `%d` |

#### Class 1: finished building (`004187e0`, data `00455e90`)

| element | position | details |
|---|---|---|
| header, portrait | portrait at (68,50) | `INFO`, T2; 45x45 icon of (race + 3, type) |
| name, town, HP | as for units | same rects and HP colouring |
| upkeep | T133 "Laufende Kosten" in (5,172)-(150,185); `KOSTEN` icon at (5,197); value `%d` (record +0xD4) in (45,190)-(150,235) | own buildings with upkeep only; icon disabled-tinted while the building is inactive |
| separator | (-3,130) | |
| `ABREISSEN` | (10,135) | command "demolish"; T8 "Abreißen" |
| `REPAIR` | (40,135) | command "repair"; T4 "Restaurieren"; disabled at full HP or when no repair is possible |
| operator | caption in (130,172)-(180,185) centred: T9 "Benötigt" (missing) or T174 "Anwesend" (present); operator portrait at (130,190), tooltip = operator unit name. "Present" (`00455e90`, message byte +0x15): 1 while the building has a **stored operator** (+0xA8), inside or away on the building's own duty (`units-and-jobs.md` 8.5: an officer hunting, a farmer planting, a diplomat on an errand, a news seller on his round), and also a news seller **killed** on his round, who stays the stand's stored operator (8.6 "Death"); without one, the number of residents (+0xB4, houses) or of occupants (+0x5C), so any occupant counts (C) | buildings with an operator (+0xD8 != -1) |
| `DEAKTIVIEREN` | (70,135) | stop operation (sends the operator out); T311 "Betrieb einstellen", for the embassy T312 "Diplomatische Beziehungen abbrechen". Disabled if no operator is present, and always for the town hall |
| `RENAME` | (100,135) | town hall only: opens the rename dialog; T180 "Wähle einen neuen Stadtnamen!" |
| occupancy | T129 "Belegt" in (130,172)-(180,185); portrait of a porter (houses 37/38) or archer (outposts 52/53) at (130,190); `occupied/capacity` in (115,190)-(130,235) | houses and outposts (capacity = +0xB4 or +0xDC) |
| separator | (-3,163) | |

Advisor line 12 "Dem Gebäude fehlt ein Betreiber!": when this page is opened (or switched to
another building) for an own building with upkeep that is not active (display +0x1FD = 0), the
client says line 12 directly, unqueued, once per page opening (section 1.1.5).

#### Class 15: construction site (`0041ffb0`)

| element | position | details |
|---|---|---|
| header | | `INFO`, T2 |
| portrait | (48,50) | building icon |
| progress | rect (100,50)-(150,95), centred, `dv18pt` | `%d%%` |
| title | (0,93)-(192,120) centred | T56 "%s in Bau", or T248 "Bau ist pausiert" when paused |
| HP | (0,108)-(192,135) centred, `dv10pt` | `cur/max`, coloured as above |
| separator | (-3,130) | |
| `ABREISSEN` | (10,135) | demolish; T8 |
| `BAUSTOP` / `BAUWEITER` | (40,135) | pause / resume construction (one toggling command, `units-and-jobs.md` 6.8); `BAUSTOP` with T191 "Bauarbeiten pausieren" while running, `BAUWEITER` with T192 "Bauarbeiten fortsetzen" while paused |
| separator | (-3,164) | |
| T57 "Baumaterialien" | (0,175)-(192,190) centred, `dv10pt` | |
| materials | entry i = 0, 1, 2 | see below |

The buttons, the second separator, T57 and the materials are drawn only for a site of the
player's own race; others show the upper block only.

**Materials** ("Baumaterialien", C, message `00456af0`, page loop at `004202e6`): one entry per
good still listed in the construction order (`units-and-jobs.md` 6.2, 6.9), in list order (good
index order: wood before stone before ...), at most three:

| part | position (entry i) | details |
|---|---|---|
| good icon | (2 + 60i, 195) | `interface.OD` group 6 picture of the good (30x30); tooltip = the good's name |
| numbers | rect (32 + 60i, 195)-(62 + 60i, 225), left, bottom, default font (same as the title), white | `%d/%d` = **local stock at the site / units still to consume** |

The first number counts the goods lying at the site (delivered, not yet used); goods on the way
are not counted. The second is what the builder still has to use; it falls by one at each consume
(`units-and-jobs.md` 6.3) and the entry disappears when it reaches 0. A site with all goods used
shows no entry. Before any delivery a school shows `0/2` (wood) `0/4` (stone); with everything
delivered `2/2` `4/4`; then `1/1` `4/4`, `4/4`, `3/3`, ... and finally nothing.

#### Class 17: nature object (`00420900`)

Header `INFO` + T2, `LEISTE` separator at (-3,30), then:

| element | position | details |
|---|---|---|
| picture | top-left at (73,50) | sprite chosen by the rule below, drawn 1:1 (never scaled or centred) |
| name | (0,93)-(192,120), centred | the type's name from the object database (record +0x14C, e.g. "Busch", "Palme") |
| yield line | only if the type's amount (+0x120) is not 0 | see below |

**Picture rule** (GOG `00420900`, Gold `00423fd0`). Let t = the object's type (+0xA8) and c its
behaviour class (+0xC0). The sprite *name* is taken from one of two object-description tables,
each holding, per object, the name of the main layer of its slot 0 (the `MS0` sprite):
the race's `interface.OD` (panel icons) or the world `dv.OD` (Gold: `dv.OD` with `Addon.od`
loaded on top into the same table).

1. t = 9..12 (the four trees): `interface.OD` group 6 type **9** (`RS\MI\BAUM\MS0`).
2. Gold only: t = 46..49 (the four palms): `interface.OD` group 6 type **46** (`RS\MI\PALME1\MS0`).
3. Otherwise, c = 7 (animal), or in Gold c = 15 (fish): `interface.OD` group 6 type t.
4. Otherwise: `dv.OD` group 6 type t, i.e. the object's **own world sprite** `MS0`.
5. Finally, whatever was chosen, c = 13 (stone) replaces it with the fixed name
   `RS\VE\STEIN1\MS0` (the world sprite of stone type 29, used for all four stone types).

The name is then resolved like every panel picture: the race's `interface.gd` first, then `dv.gd`,
then (Gold) `Addon.gd`, then the shared menu library. `RS\MI\..` names are 45x45 icons from
`interface.gd`; `RS\VE\..` names are not in `interface.gd`, so the world sprite comes from
`dv.gd`/`Addon.gd` at its full size and overhangs the name band for the larger ones. If the table
has no entry for the type (no name), no picture is drawn. The race's `interface.OD` group 6 holds
only goods 0..8, 9 (`BAUM`), 33..37 (`TIER1..5`), Gold also 39, 40 (`TIER6`, `TIER7`) and
46 (`PALME1`); the three races' tables are identical.

| types | name | class | picture | from | size |
|---|---|---|---|---|---|
| 9..12 | Baum | 8 | `RS\MI\BAUM\MS0` | interface.gd | 45x45 |
| 13..16 | Busch | 9 | `RS\VE\BUSCH1..4\MS0` (own sprite, 13→1 ... 16→4) | dv.gd | 52x40, 40x40, 42x44, 50x42 |
| 17..20 | Kakao | 10 | `RS\VE\KAKO1..4\MS0` | dv.gd | 41x40, 37x40, 42x40, 41x37 |
| 21..24 | Pilze | 11 | `RS\VE\PILZ1..4\MS0` | dv.gd | 49x48, 51x37, 41x44, 46x42 |
| 25..28 | Maden | 12 | `RS\VE\FLEISCH1..4\MS0` | dv.gd | 64x44, 46x44, 47x35, 49x44 |
| 29..32 | Stein | 13 | `RS\VE\STEIN1\MS0` (all four) | dv.gd | 68x51 |
| 33..37 | Fasterator, Necktor, Echse, Sumpfling, Hase | 7 | `RS\MI\TIER1..5\MS0` | interface.gd | 45x45 |
| 38 | Schutt (rubble) | 0 | `RS\VE\BAUSCHUTT\MS0` | dv.gd | 52x39 |
| 39, 40 (Gold) | Gecko, Krabbe | 7 | `RS\MI\TIER6\MS0`, `RS\MI\TIER7\MS0` | interface.gd | 45x45 |
| 41..45 (Gold) | Fisch | 15 | none (`interface.OD` has no fish entry; fish cannot be clicked anyway, `docs/rendering/objects.md`) | | |
| 46..49 (Gold) | Palme | 8 | `RS\MI\PALME1\MS0` (all four) | interface.gd | 45x45 |
| 50 (Gold) | Aloe | -1 | `RS\VE\ALOE\MS0` (own sprite) | Addon.gd | 47x42 |
| 51 (Gold) | Venus | -1 | `RS\VE\VENUS\MS0` (own sprite) | Addon.gd | 77x50 |

Goods 0..8 never reach this page as nature objects; by rule 4 they would have no picture.

**Yield line** (only when the type's amount +0x120 is not 0, so not for Aloe/Venus):

- If the yield good (+0x11C) is 0 (raw material: the crops), a caption in (50,130)-(120,160)
  from T210 + class: T220 "Kakao", T221 "Pilze", T222 "Maden".
- Otherwise the good's icon (`interface.OD` group 6 type = good, 45x45, e.g. `RS\MI\HOLZ\MS0`
  for trees and palms, `NAHRUNG` for bushes, animals and fish, `STEIN` for stones and rubble) at
  (65,130), tooltip = the good's name.
- Then `remaining/initial` (`%d/%d`) in (95,130)-(180,160), `dv10pt`. Both start at the type's
  amount (+0x120) when the object is created.

#### Class 2: group (several units)

Header `INFO` + T2. Up to 12 units in a grid of 3 columns: x = 0, 60, 120; y = 50 + 45 * row.
Each: portrait button (click selects that unit alone, tooltip = unit name), HP `%d` in
(x+35, y)-(x+65, y+45) centred at the bottom with the HP colouring, experience icon at
(x+43, y+25).

### 5.3 Grid pages (build menu, training, inhabitants, buildings list)

Base class `00425090`, layout `00425310`, parameters (x0, y0, columns, row height):

- Visible rows = (page height - y0) / row height; visible items = rows * columns.
- Item i of the visible window goes to x = x0 + (i mod columns) * (172 / columns),
  y = y0 + (i div columns) * row height.
- Scrolling is by whole rows. Scroll arrows at the bottom of the page area:
  - "up" = `PFEILRECHTS` (64x13) at (101, page bottom - 14), shown when scrolled down;
  - "down" = `PFEILLINKS` (64x13) at (20, page bottom - 13), shown when more rows follow.
  (The sprite names say right/left; the shapes point up/down.) The mouse wheel triggers them.

#### Class 6: build menu (logical 8; `00417b60`, items `00417d60`)

- Header `GEBAEUDEBAUEN`, T1 "Gebäudebau".
- Town stock strip: wood, stone and iron icons (15x15 `BUBBLE\MI\HOLZ|STEIN|EISEN\MS0`) at
  (25,35), (75,35), (125,35), tooltips = good names, amounts in (40,35)-(65,50),
  (90,35)-(115,50) and the equivalent third slot.
- Grid (10, 55, 2 columns, 50): one item per building type the race can build, in list order
  (record +0x124). 7 rows = 14 items visible at 1024x768.
- Item at (x, y): building button 45x45 (portrait of the type). Click enters **building
  placement mode** for that type. State from the build check (see `docs/formats/odb.md`):

  | state | look | tooltip |
  |---|---|---|
  | 1 OK | normal | building name; the mine uses T315 "Mine (Nur auf Bergen - auch außerhalb der Stadt)" |
  | 2 invention missing | disabled (half brightness, no hover look, not clickable), no cost shown | T131 "Noch nicht erforscht!" |
  | 3 not enough goods | "off" (half brightness, red cast); clickable, so it gets the hover look | building name |
  | 4 unique and present | disabled | T132 "Nur einmal pro Stadt!" |

  Hover (3.1): an enabled or "off" item shows the hover look and its tooltip; a disabled item
  shows only its tooltip.

- Costs (goods 0..4 with a non-zero cost): 15x15 bubble icon at (x+50, y + 15*k), tooltip = good
  name, amount label at (x+70, y + 15*k); the icon gets the "off" tint if the town stock is
  below that cost. The cost icons are pictures (3.1): tooltip, but no hover look.

**Town-hall placement** (from a founder's `GRUENDEN`, not from this menu). Rules are in
`docs/game/units-and-jobs.md` 11.1:

- The placement mode is the same as for buildings (`00441c40`), with the race's town-hall
  record (type 40) and the preview mask 0x107E | 0x80.
- On a click, the footprint grown by one cell must be visible and free of units, buildings,
  nature and special objects, and the slope ring must be flat enough.
- None of the four test points around the footprint may lie in **any** town's territory
  (flag 0x1000, `00447cd0`). Unlike other buildings, there is no "inside the current town"
  test (0x800).
- A valid click sends the "found town" command (19) with the cursor cell and leaves the mode.
  An invalid click sends nothing *(I: the mode stays active)*.
- While the founder walks to the new site, his status text is T266 "Errichtet Stadt".
- On arrival the advisor says mentor#19 "Dein Volk freut sich über eine neue Stadt!". When he
  enters, it says mentor#10.
- The new town is the player's current town from the moment the command is executed.

#### Class 7: training (logical 4; `004176c0`, items `00417460`)

- Header: `EINHEITENBAUEN` (school) or `KAEMPFERBAUEN`, title T0 "Ausbildung".
- Queue of 5 slots, each a `RAHMEN` frame (45x45), always all five drawn: slot 0 at (2,45);
  slots 1..4 at (2,90), (47,90), (92,90), (137,90). A queued order shows the unit's portrait as a
  command button on its frame (tooltip = unit name). Left click sends command 0x29 (cancel
  training) with the unit type and the slot index, whatever the slot's look.
- **Page data** (`00456130`, the simulation's page message for this page; identical in Gold
  `0041ac60`, only the offsets differ): the queued unit types in order (0xFF = empty), the
  **number of units inside the building** (occupant count +0x5C, every occupant: the pupils,
  of any unit type, `units-and-jobs.md` 9.1), the **progress percent** of the running order (training job vtable[6] `00476130`: 0 while
  no order has started, otherwise progress × 100 / target, at least 1), and the building's stock of
  every good (local, or the town's for a store).
- **Slot look = is a pupil inside for this slot** (C). Slot i (0..4) is drawn **normally** when
  i < units inside. Otherwise it gets **only the 0x20 look bit**, the dim look of 3.1 (the
  portrait at **half brightness**, colours kept, on its normal frame; the frame itself is a
  separate picture and is not dimmed), but **not** bit 0x08, so it **stays clickable** and shows
  the hover look while the mouse is over it. Each queued order files a porter request (units-and-jobs.md 9)
  unless a pupil already inside covers it (a builder ordered into the school, 9.1: the slot is
  normal at once and no porter comes). Its slot
  therefore stays dark while no porter has come for it, also while the porter is still walking
  there (he is not inside yet). It turns normal at the "entered" step (4.10 step 6), the moment
  the porter vanishes into the door. The slots are compared by position only, not matched to
  persons: with 2 pupils inside, slots 0 and 1 are normal and slots 2..4 dark. A porter sent out
  again (4.11) darkens the last normal slot.
- **Status text for slot 0**, top-left at (50,45), white, by state:

  | state | look of slot 0 | text and extras |
  |---|---|---|
  | queue empty | empty frame | T139 "Niemand in Ausbildung..." |
  | order queued, **nobody inside** (no porter yet, porter walking, or the pupil was sent out, even after the training had started) | dark | T138 "Warte auf Schüler..." |
  | someone inside, order **not started** (progress 0), the unit needs goods | normal | T252 "Warte auf Material...". Below it, on y = 60 from x = 50, **one bubble icon per unit of every required good** (record +0xF0.., in goods order), 12 px apart, tooltip = good name. The icons of units the building's stock does not cover (icon index ≥ stock of that good) get the dark look; the covered ones are normal. This also shows for up to 30 ticks when all goods are present, until the training job's next run starts the order |
  | someone inside, progress > 0, or not started and the unit needs no goods | normal | T137 "In Ausbildung:" at (50,45), the unit name at (50,65), and `%d%%` (the progress percent; 0 % for a unit without goods that has not started yet) in the large font centred in (130,45)-(192,90) |

  The percent only moves in steps: the training job adds 5 to the progress every 30 ticks, so a
  50-HP unit shows 10 %, 20 %, ... (and 1 % when 5 × 100 / target < 2, for example a 500-HP
  unit's first step).
- No progress bar exists. Slots 1..4 never show a status, only their look.

*Our build* (`src/client/hud-pages.ts trainingPage`, `trainingView`; fixed October 2026,
`test/training-page.test.ts`): as above. The slot look, status texts, material icons (one per unit,
12 px apart from (50, 60), dark when not in stock) and the percent (at least 1 once started, no cap)
come from the pure function `trainingView`; "units inside" is the occupant count. The dark look is
the `dark` button flag (`hud.ts`, `lookOf` in `src/client/ui-tint.ts`): the dim look of 3.1 (half
brightness), hover first, still clickable. The material icons are pictures (no hover look).
- Separator at (-3,145). Grid (10, 155, 2 columns, 50): trainable units. Item: portrait button
  (click = command "train unit of this type"); states 2 disabled + T131, 3/6 "off" tint (cannot
  afford), 5 disabled + T202 "Max. Städteanzahl erreicht!" (founder). Tooltip = unit name.
  Cost column at x+40: `GOLD` icon with tooltip T141 "Kosten" and the price (record +0xD4) as a
  label to its right, then one bubble icon + amount per required good, 15 px apart, "off"
  tinted when the town lacks it.

#### Class 9: inhabitants (logical 6; `0041c080`, items `0041be90`)

- Header `BEWOHNER`; title T39 "Stadtbewohner" (town) or T38 "Im Gebäude" (building).
- Town mode: T40 "Bewohner:" at (8,40) with the count right-aligned at (65,40); T307 "Freie
  Träger:" at (95,40) with the count at (155,40).
- Grid (10, y0, 3 columns, 50); items: unit-type portrait button with the count `%d` at
  (x+40, y+35). One item per unit type whose count is not 0 (`0041be70`), in the order of the
  race's unit list slots (record +0x124).
  - Town mode: tooltip T250 "Gehe zu %s"; left click = centre camera on the next unit of that
    type and select it, right click = cycle the other way without selecting *(direction
    uncertain)*. Both are command 0x43 (unit type, flag 1 = left / 0 = right; `00452160`).
  - Building mode (C, `0041be90`, page data `00457900`, command `004520e0`):
    - **Counts**: every unit in the building's **occupant list** (building +0x58), counted by
      its type. Who is in that list (and who is "inside" without being in it, such as a
      delivering porter) is in `docs/game/units-and-jobs.md` 4.11. A unit of another race is
      counted under the same unit type of the viewer's race.
    - **Tooltip**: T249 "%s aus Gebäude schicken" with the unit name; for unit type 13
      (diplomat) T312 "Diplomatische Beziehungen abbrechen" instead. The test is on the type
      only, not on the building, but a diplomat is only ever listed in an embassy in practice.
      Items are never disabled.
    - **Left click** (on left-up, generic rule 3.1) sends **command 0x3A "send out"** with one
      parameter, the unit type (32-bit). The building is not in the command: it is the first
      object of the sending player's selection when the command is executed. The command
      ejects the **first** occupant of that type in occupant-list order, which is the order
      of entering (the one that has been inside longest). One click = one unit. Refused, with
      no feedback: type 12 (criminal) in any building, and type 10 (founder) in a town hall.
      Full rule and what the unit does afterwards: `units-and-jobs.md` 4.11.
    - **Right click, double click**: nothing (no second or third command is set on the item).
    - **Training buildings**: the items are the pupils by unit type: porters called by orders and
      any other unit ordered in (a builder waiting to be re-trained shows as a builder item with
      its count). Sending one out is the only way to get an untrained pupil back
      (`units-and-jobs.md` 9.1); the training page's slot looks follow the count at once.
    - **Outposts**: the items are the garrison by unit type (at most the four class-2 types,
      `docs/game/combat.md` 9.1). Sending one out is the player's only way to take a garrison
      unit off a tower: garrison units cannot be clicked (`docs/rendering/objects.md` 13.3).
      The unit stays drawn on the tower until it appears at the door. The info page's
      "Belegt" count can exceed the capacity when several units were queued at the door
      (`combat.md` 9.1). *Quirk (C by reading):* when a garrison unit enters a selected
      outpost, the outpost is deselected (objects.md 13.1), so its panel page closes.
    - **Sound**: only the generic UI click `sfx_042` on left button down (3.1). The command
      itself plays nothing; the door opens 10 ticks later and the unit appears 20..35 ticks
      later (`units-and-jobs.md` 4.10).
    - The page is refreshed for the sender as soon as the command has run: the unit leaves the
      occupant list at once (before it is put on the map), so the count drops by 1 and the
      item disappears at 0.
    - Sending out a unit of the building's **operator type** (same race) deactivates the
      building when it is put outside, as `DEAKTIVIEREN` does. For an embassy this is the
      T312 effect (relations reset when it was the player's last active embassy,
      `docs/game/ai-diplomacy-trade.md` 3.3).
    - *Our build* (`src/client/hud-pages.ts` `inhabitantsPage`): items from the engine's
      occupant list (`logistics.occupants`), one per unit type in race slot order, portrait of
      the viewer's race; left click sends `{ type: 'sendOut', player, building, unit }` (the
      building is carried in the command, `units-and-jobs.md` 4.11 "Our build"); the UI click
      `Sfx_042` plays on left button down for every panel button.

#### Class 18: buildings list (logical 14; `0041c390`, items `0041c260`)

- Header `GEBAEUDEINFO`, title T41 "Gebäude". T42 "Gebäude:" at (8,40), count right-aligned at
  (55,40); T43 "Baustellen:" at (100,40), count at (155,40).
- Grid (10, 55, 3 columns, 50): one item per building type present in the town: portrait button
  (tooltip = type name) and count `%d` at (x+45, y+35). Left click: centre camera on the next
  building of that type and select it; right click: centre without selecting.

### 5.4 Town pages

#### Class 3: finances (logical 1; `00419a90`, ctor `00419440`)

Header `STADTSTATISTIK`, T10 "Finanzen". Rows in `dv7pts2`, captions at x = 5, values
right-aligned ending at x = 150 (format `%5d`):

| y | caption | value |
|---|---|---|
| 50 | T12 "Einnahmen:" | income |
| 65 | T13 "- Motivationsgelder:" | motivation spending M; if it is **not being spent** (below), `(%5d)` of M at x 110 and 0 as value |
| 80 | T14 "- Forschungsgelder:" | research spending R, same rule |
| 95 | T15 "- Laufende Kosten:" | upkeep of all buildings |
| 110 | T16 "= Bilanz:" | income - the spending values shown in the value column - upkeep; red if negative, green otherwise. If a row is not being spent, the would-be balance with the full M and R, `(%+5d)`, at x 110 |

**Where the numbers come from** (C, message built by `00455fd0`, drawn by `00419a90`). Each
refresh (every 10 ticks while the page is open, `0046ed90` → `0044fc20`, and right after a
research start or stop) recomputes the town's figures with the settlement formula
(`docs/game/economy.md` 4.2 to 4.6) from the **current** population: income, M = motivation% x
income / 100 and R = research% x income / 100 (both 0 when the income is 0), and the current
upkeep. These are the slider amounts, not money already charged.

**"Not being spent"** is decided per row by two flags, not by the money available:

- motivation is spent when the motivation slider is 0, or the town's last happiness update used
  the motivation bonus (town +0x78 = 1, i.e. the town is not fully happy). Otherwise the row
  shows `(M)` and 0;
- research is spent when the research slider is 0, or **a research project is running**
  (town +0x58 != -1). With no project (never started, stopped, or just finished) and a non-zero
  slider the row shows `(R)` in parentheses and **0** as the value, and R is left out of the
  balance.

So before research starts and after it ends, the research line reads 0 and the balance does not
include research; while a project runs it shows R and the balance includes it. The
parentheses only remind the player of the slider amount. (Money actually charged per round is
`4 x` the research accumulator, about R; see economy.md 4.4.1.)

Then separator (-3,130), `KOSTEN` icon at (2,135), T128 "Investitionen" in (35,135)-(192,165)
`dv10pt`. Two sliders, each a `SLIDERHANDEL` bar (113x28) with a `RING` handle whose track is
(10,5)-(101,36) inside the bar, range 0..100 %:

| slider | caption (centred) | bar at | value label |
|---|---|---|---|
| motivation | T11 "Motivation" in (5,170)-(192,185) | (20,185) | `%d%%` in (150,185)-(192,195) |
| research | T17 "Forschung" in (5,210)-(192,225) | (20,225) | `%d%%` in (150,225)-(192,235) |

Moving a slider sends the new percentage as a command.

#### Class 8: needs / motivation (logical 7; `0041ae60`)

Header `MOTIVATION`, T27 "Bedürfnisse".

- Summary sentence in (5,40)-(190,80): T29..T34 chosen by motivation (100 -> T29 "Deinem Volk
  geht es gut" ... 0 -> T34 "Dein Volk rebelliert", index 34 - motivation/20), green when all is
  fine, red otherwise.
- Three indicator blocks, caption and `: %d%%` / `: %5.1f` value in pale yellow, icon at x 5,
  caption at x 40, value at x 140, followed by a wrapped explanation (x 40..190):

  | y | icon | caption | explanation strings (by threshold) |
  |---|---|---|---|
  | 55 | `BEWOHNER` | T206 "Kriminalität" | growth/crime texts T209..T211 (*mapping approximate*) |
  | 97 | `GEBAEUDEINFO` | T207 "Zustand der Häuser" | T212..T214 |
  | 139 / 154 | food icon `RS\MI\NAHRUNG\MS0` | T28 "Nahrungsverbrauch", T193 "Nahrungsproduktion:" | T215..T217 |

- T35 "Sonstige Bedürfnisse:" at (5,196); wish icons (wanted buildings / luxury goods, tooltip =
  name) in a row below, or `FESTABHALTEN` at (5,206) with T136 "Keine Wünsche offen" in
  (45,206)-(190,236).

#### Class 10: raw material stock (logical 5; `0041b920`, ctor `0041b5a0`)

- Header `ROHSTOFFE`, T37 "Rohstofflager"; T130 "Lagerkapazität: %d / Typ" at (5,45).
- 3x3 goods grid by list slot s (record +0x124): icon (30x30) at (5 + 60*(s div 3),
  65 + 30*(s mod 3)), amount `%d` in (icon x + 35, y)-(icon x + 50, y + 30) bottom-left. Tooltip =
  good name; good 0 uses the race's raw material name T220+race ("Kakao", "Pilze", "Maden").
- Separator (-3,160). Conversion row: "1x" in (5,200)-(35,230), raw material icon at (35,200),
  "=2x" in (65,200)-(95,230), food icon at (95,200); question text T223+race (e.g. "Wieviel
  Kakao soll in Nahrung umgewandelt werden?") wrapped in (5,170)-(185,200); `SLIDERHANDEL` at
  (5,225) with a 0..100 `RING` slider; percentage `%3d%%` right-aligned near (110..140, 227);
  `UMWANDELN` button at (145,215), tooltip T182+race ("Kakaobestand jetzt umwandeln").
  Moving the slider sends command 0x57 with the percentage at once (`0041b7a0`): it is the
  town's standing conversion share, applied to every later crop delivery; the button sends 0x57
  with 0xFF, "convert that share of the stock now" (`docs/game/economy.md` 7 "The conversion
  ring").

#### Class 4: research (logical 2; `0041a420`)

- Header `FORSCHUNG`, T17. T18 "Aktuell" centred in (0,39)-(192,51), `dv10pt`, red.
- Current invention name at (10,57) and progress `%d%%` at (154,57); or T22 "Keine aktuelle
  Erfindung"; or T21 "Forschung beendet".
- `FORSCHUNGEIN` (10,79): start researching the invention selected in the list, T19 "Forschung
  starten" (enabled only with a selection and nothing running). `FORSCHUNGSTOP` (40,79): abort,
  T20 "Forschung abbrechen".
- Separator (-3,74). A `LISTBOX` sprite (191x72) at **panel** (1,441); inside it a list at
  (8,14)-(154,64) of available inventions, rows "%s (%d)" (T23, name and cost), row height = font
  height (13); `RING` scrollbar track (158,12)-(189,70) relative to the list box.
- Selecting a row shows the invention's description (from `DV.idb`) wrapped in (5,182)-(182,262).

#### Class 5: research history (logical 3; `0041ab90`)

Header `HISTORY`, T24 "Geschichte"; T25 "Bisher erfunden:" at (10,44) and T26 "%d Erfindung(en)"
at (100,44). `LISTBOX` at panel (1,401) with the list of finished inventions at (8,11)-(154,59),
scrollbar as above; selecting one shows its description.

### 5.5 Building-specific pages

#### Class 16: production (logical 13; `00420450`)

Header `PRODUKTION`, T58 "Produktion" at (32,10). Separators at y 30, 85, 170. Input goods row
at y 50 (`%dx` amount + icon per input good). `RAHMEN` at (10,110) with the product icon at
(17,117); progress `%d%%` in `dv18pt` centred in (100,110)-(170,155). T59 "Lagerstand" centred in
(0,180)-(192,195), `dv10pt`; local stock of inputs and product on y 210 (icon + `%d`).

#### Classes 11 / 12: market selling / buying (logical 9 / 10; `0041ce80`, `0041de80`)

| element | position | selling | buying |
|---|---|---|---|
| header | | `VERKAUF`, T46 "Verkauf" | `EINKAUF`, T49 "Einkauf" |
| selected good icon | (5,40) | | |
| enable / disable | `HANDELSTART` (123,40), `HANDELSTOP` (153,40) | T226 "Verkauf freigeben" / T227 "Verkauf sperren" | T228 / T229 |
| slider 1 caption at (10,72), bar `SLIDERHANDEL` at (10,85) | | T44 "Mindestlagermenge" (0..storage capacity) | T47 "Maximale Lagermenge" |
| slider 2 caption at (10,112), bar at (10,125) | | T48 "Min. Verkaufspreis" (0..2 x base price) | T45 "Max. Einkaufspreis" |
| separator | (-3,152) | | |
| goods buttons | grid from (5,160), step 45 in x (4 per row: 5, 50, 95, 140), 45 in y | click selects the good | |
| stock per good | (x+30, y)-(x+60, y+30), bottom-left | | |

For a foreign market the sliders are read-only and the start/stop buttons are absent. Only one
of the two start/stop buttons is enabled at a time (the one that changes the current state).

#### Class 13: trade route (logical 11, trader selected; `0041eba0`)

Header `HANDEL`, T50 "Handelsroute". `HANDELSTART` (10,35) T51 "Handelsroute starten",
`HANDELSTOP` (40,35) T52 "Handelsroute stoppen". T255 "Von Stadt" at (110,55) and a town list
in a `LISTBOX` at panel (1,401); T256 "Zu Stadt" at (110,155) and a second list in a `LISTBOX`
at panel (1,501) (lists at (8,11)-(154,59) inside each box, with `RING` scrollbars). A row of
good toggle buttons on y = 140 picks the good to carry (tooltip = good name).

#### Class 14: diplomacy (logical 12, embassy selected; `0041f2d0`, `0041f8f0`)

- Header `DIPLOMATIE`, T208 "Diplomatie".
- Tabs: one image toggle per other race that has an embassy, icons `AMAZONEN`/`PIMONS`/`SAJIKI`,
  at y = 40, tooltips "Beziehung zu ..." (T236..T238). If none: wrapped T309 "Kein anderes Volk
  hat eine Botschaft!".
- Separator (-3,72); T239 "Aktuell:" in (5,80)-(50,110); current relation icon at x 150:
  `KRIEG` (state 1), `WAFFENSTILLSTAND` (2), `FRIEDE` (3), tooltips T240 "Krieg", T241
  "Waffenstillstand", T242 "Frieden".
- Separator (-3,110); wrapped T173 "Welche Beziehungsangebote sollen akzeptiert werden?";
  checkboxes (`CHECKED` / `UNCHECKED`, 22x22) at (5,145) and (5,165) with captions T241
  "Waffenstillstand" in (40,145)-(192,165) and T242 "Frieden" in (40,165)-(192,195).
- Separator (-3,190); wrapped T175 "Botschafter aussenden, um eine neue diplomatische Beziehung
  anzubieten"; offer buttons at x 150 (`KRIEG`, `WAFFENSTILLSTAND`, `FRIEDE` with T176 "Krieg
  erklären", T177 "Waffenstillstand anbieten", T178 "Frieden anbieten"); a diplomat-portrait
  button at (135,195), T254 "Diplomat zurückbeordern". A status line "Den %s wird ..."
  (T230..T232 with the race name T116..T118) shows a pending offer.

## 6. Minimap

Widget `0044c8f0`, input `0044db30`, redraw `0044d230`, object plotting `0044c060`, ground
image `0044cac0`. GOG `dv.exe` and Gold `dvge.exe` (`004523e0` / `00452b50`) behave the same;
only the map object's field offsets differ.

- Rect (6,6)-(158,158) in panel coords; 152x152 px. The 152 px always show the **whole map
  exactly once**, for every map size, at 1024x768 and at 800x600 (section 9). Only the viewport
  marker depends on the resolution (6.3).
- **Orientation (transposed compared with a plain x-right / y-down plot).** A minimap
  **column** is a map **y** coordinate and a minimap **row** is a map **x** coordinate (x = the
  low bits of the cell index, see `docs/formats/terrain-gen.md`). Minimap pixel (col, row)
  therefore covers the cells around (x = row * mapsize / 152, y = col * mapsize / 152). The
  click handler uses the same mapping: the horizontal mouse offset becomes y, the vertical one
  becomes x. In the world view, screen-right is the direction (x - 1, y + 1) and screen-down is
  (x + 1, y + 1) (`docs/rendering/world-projection.md`). On the minimap those become up-right and
  down-right, so the minimap is the world view turned 45 degrees, **not mirrored**. A plot with x
  to the right and y downwards is the mirror image of the original.
- **Centred on the camera.** The camera's integer cell (cx, cy) gets a height correction
  k = (height(cx, cy) - 128) / 44, computed as signed integer division that truncates towards
  zero. Then cx + k and cy + k are each scaled to minimap pixels as trunc(152 * value /
  mapsize) and wrapped into 0..151. That pixel is drawn at the minimap centre (76,76). The image
  wraps (torus) in both directions, so the minimap scrolls with the camera in whole pixels.
- The ground image (6.1) and the per-pixel composition (6.2) are described below. The viewport
  marker is described in 6.3.

### 6.1 Ground image (built once per map)

The terrain part of the minimap is a separate 152x152 image (16-bit, display pixel format). The
original builds it in four passes:

1. **Tile colour.** Every terrain tile has a fixed colour: the plain average of its 64x64
   pixels, one per channel, truncated to an integer. It is computed when the `.os` sets are
   loaded (`0043b2c0`), so it comes from the game data and not from a table in the exe. The game
   reads each cell's **global tile index** (the cell byte that `terrain-gen.md` calls tile)
   and looks up that tile's colour. Class and path flag are never looked at. Reference values
   for the shipped sets (GOG and Gold files are identical):

   | set (classes) | first tile | range over the set's tiles |
   |---|---|---|
   | wiese (0) | (95,137,23) | (88..102, 133..139, 19..26) |
   | gelbgras (1, 8) | (203,191,29) | (197..209, 183..195, 25..36) |
   | schnee (2) | (216,214,210) | (213..248, 211..248, 206..247) |
   | rock (3) | (148,148,148) | (147..158, same, same) |
   | waldboden (4, 5, 7) | (181,144,76) | (175..195, 140..146, 71..84) |
   | gruenwald (6, 9) | (165,164,64) | (159..178, 159..167, 59..72) |
   | weg (10: lake shore, foundations, worn paths) | (142,127,69) | (139..142, 125..127, 67..69) |
   | wasser1 (11 water; add-on: 9 open sea and 10 coastal water) | (16,41,151) | (14..16, 41..42, 150..151) |

   Water cells carry a tile index from the wasser1 range, so the animation frames
   `wasser2..4` and the shoreline `transition*` pieces play no part in the minimap. In add-on
   maps the open sea (class 9, static wasser1 tiles) and the coastal ring (class 10, animated
   water) therefore get the same blue. Both are flat at height 120, so both get the flat shade.
2. **Block average and slope shade, per minimap pixel.** Let step = mapsize / 152 (integer
   division: 0 for maps of 128 or smaller, 1 for 256, 3 for 512). For pixel (col, row), let
   x0 = trunc(mapsize * row / 152) and y0 = trunc(mapsize * col / 152).
   - Colour: average the tile colours of the (step + 1) x (step + 1) cells x0..x0+step,
     y0..y0+step (wrapped), per channel, truncated. On a 256 map that is 2x2 cells, on a 512 map
     4x4 cells. Neighbouring blocks overlap slightly. On maps of 128 cells or smaller it is
     simply the nearest cell (some cells are repeated).
   - Shade: s = 192 + 8 * (height(x0, y0) - height(x0 + 1, y0 - 1)), clamped to 128..239. Only
     this one pair of cells is used, not the whole block. Cell (x0 + 1, y0 - 1) is the cell to
     the left on screen, so ground that rises towards the screen-right is brighter and ground
     that falls is darker. Flat ground gives 192. The absolute height has **no** effect. The
     cell's stored light byte (`terrain-gen.md` step 5) is **not** used.
   - Pixel = each channel of the block colour times s / 255, truncated. Flat ground is about
     0.753 of the tile colour. The brightest shade is 0.937, so no channel can overflow.
3. **Blur.** A 3x3 blur with weights 1 2 1 / 2 4 2 / 1 2 1 (sum 16), per channel, truncated.
   It wraps around the image edges. The smooth, relief-like look of the original minimap comes
   from this blur together with the slope shade.
4. Conversion to the 16-bit display format (the low bits of each channel are dropped).

**When it is built.** The ground image is built **once**: at the first minimap redraw of a game,
when no ground image exists yet. That redraw happens in the game loop, after the map, its
objects and their foundations have been set up *(uncertain: order inferred from the call
sites)*. It is also rebuilt right after a random map's terrain is generated or regenerated
(single player `00485a30`, and the network message 0xFD "generate terrain" on clients). It is
**never updated during play**. Foundations levelled while playing, and worn paths, do not
change the minimap ground. The minimap shows only the building's own marker. Weg ground that
already exists when the image is built does show, as a blurred brown-grey: lake shores, and
the foundations of buildings that already stood on a loaded mission map. A loaded save game
creates a new minimap, so its ground image is built from the saved cells. It then includes
every foundation and path made before saving *(uncertain: inferred from the save-load path
`0044e150` creating a new widget)*.

### 6.2 Per-pixel composition (every redraw)

- Per-pixel content (fog of war on): never explored = black; explored but not in sight = the
  colour at half brightness (each channel of the 16-bit value halved); in sight = full colour.
  Colour = the ground image pixel (6.1), overridden by objects:

  | object | colour |
  |---|---|
  | Amazon object (race 0) | red (255,0,0) |
  | Pimmon object (race 1) | blue (0,180,255) |
  | Sajiki object (race 2) | yellow (255,255,0) |
  | tree | 50% blend of terrain and green (90,255,60) |
  | stone | 50% blend with (239,247,255) |
  | bush, animal | 50% blend with (255,220,120) |

  Layers: buildings are plotted only when the buildings toggle is on, units only with the units
  toggle, nature objects only with the resources toggle. With "town areas" on, each terrain
  pixel inside a town's area is blended 50% with that town's race colour. "Town area" is the
  territory map of `docs/game/economy.md` 11 (town hall and outposts, first come first served);
  the exact tint rule is in `docs/rendering/territory.md` 5. The marker buffer
  bits, the plus-shaped object markers and the fog rules are in `docs/game/fog-of-war.md` 1.4
  and 5.4. The redraw recomposes all 152x152 pixels from the ground image every time. Only the
  ground image itself is never recomputed (6.1).
- Input:

  | action | effect |
  |---|---|
  | hover | minimap cursor (crosshair, [cursors.md](cursors.md) 5.2) |
  | left click (release within 500 ms and less than 5 px from the press) | camera centre jumps to the clicked cell |
  | left drag (held 500 ms or moved more than 3 px) | grab-scroll: camera = start camera - drag distance * mapsize / 152 (map follows the mouse); drag cursor (open palm, [cursors.md](cursors.md) 5.2) |
  | leaving the minimap while dragging | drag cancelled, camera restored |
  | right click while own units are selected | move command for the selection to the clicked cell; plays the **move sample `sfx_057`**, unpositioned, the same as a right-click move in the world view ([objects.md](../rendering/objects.md) 7.2, 8.1). Nothing is played when no own units are selected |
  | right button during a drag | cancels the drag |

  Click to cell (`0044db30`): let p be the image pixel under the mouse. That is the centre
  pixel from the centring rule plus the mouse offset from (76,76), with the horizontal offset
  added to the y pixel and the vertical offset added to the x pixel. Then
  cell = trunc((p * mapsize + 76) / 152), wrapped into the map, separately for x and y.

### 6.3 Viewport marker

A white (255,255,255) 1-pixel outline of a diamond. It is drawn after the pixel composition,
around the fixed centre c = 76 and not wrapped. Its four corners are (c, c - R) top,
(c + R, c) right, (c, c + R) bottom and (c - R, c) left. Each edge is a 45-degree pixel staircase
of R pixels: (c - R + i, c - i), (c + R - i, c + i), (c + R - 1 - i, c - 1 - i) and
(c - R + 1 + i, c + 1 + i), for i = 0..R-1. The diamond is always square. Only the view
**width** sets its size; the view height plays no part.

R is recomputed whenever the zoom changes (`00422fe0`; the minimap is redrawn when R changes) and
is set at creation (`0044c8f0`). All divisions truncate:

- w = width of the world view in pixels = screen width - 192 (832 at 1024x768, 608 at 800x600).
- cellW = 80 - v (zoom slider value v, section 7); a = trunc(cellW * 100 / 64);
  t = trunc(a * 0.45254834) (the factor is 0.32 * sqrt 2).
- n = trunc(w * 1.41421356 / t), roughly the number of cells across the view.
- R = 2 + trunc(trunc(n * 152 / mapsize) / 2).

At creation the game uses t = 45, which is the same value the formula gives for the default
zoom (v = 16). Resulting R:

| view | zoom v | map 128 | map 256 | map 512 |
|---|---|---|---|---|
| 1024x768 (w 832) | 16 (default) | 17 | 9 | 5 |
| 1024x768 | 40 | 26 | 14 | 8 |
| 1024x768 | 64 (farthest) | 64 | 33 | 17 |
| 800x600 (w 608) | 16 | 13 | 7 | 4 |
| 800x600 | 40 | 19 | 10 | 6 |
| 800x600 | 64 | 48 | 25 | 13 |

## 7. Zoom slider

- Horizontal slider `00425ca0`: track (54,165)-(162,196); `RING` handle (21x21) centred vertically
  (top y = 170); handle travel 87 px; value range 16..64; handle x = 54 + 87 * (v - 16) / 48.
  Dragging converts the handle offset back with rounding: v = 16 + round(48 * offset / 87).
- Value v sets the **cell width to (80 - v) px** and the cell height to (80 - v) * 44 / 64 px
  (`00422fe0`). Left end (v = 16) = 64x44, the normal 1:1 zoom and the default; right end
  (v = 64) = 16x11, the farthest zoom-out. Changing it also resizes the minimap viewport marker.
- Mouse wheel over the world view: one step per 30 wheel units, clamped to 16..64; Page Up = 64,
  Page Down = 16.

## 8. Commands and sounds triggered from the panel (summary)

| button | game command |
|---|---|
| function bar icons | "show page N" (player UI state; also remembered per object type) |
| town list row (left / right) | set current town / jump camera to town |
| `MOVEHOME` | unit: go home |
| `PATROL` | unit: patrol (target picked on the map) |
| `GRUENDEN` | start placement of a town hall; the click sends "found town" (command 19, `004509d0`) |
| `WEGWERFEN` | unit: drop carried goods |
| `ABREISSEN` | building or site: demolish |
| `REPAIR` | building: repair |
| `BAUSTOP` / `BAUWEITER` | site: pause / resume construction |
| `DEAKTIVIEREN` | building: stop operation (operator leaves); command 8, no parameter (`00450860`, see `units-and-jobs.md` 4.11) |
| `RENAME` | town hall: rename town (opens an input dialog) |
| build menu item | start placement of that building type |
| training item / queue slot | queue unit / cancel queued unit |
| inhabitants / buildings list item (town mode) | select + centre on the next object of that type (inhabitants: command 0x43) |
| inhabitants item (building mode) | command 0x3A "send out" (unit type): eject the first occupant of that type (`units-and-jobs.md` 4.11) |
| finance sliders | set motivation % / research % |
| `UMWANDELN` | convert raw material to food |
| research start / stop | start invention / abort research |
| market buttons, sliders | enable/disable trade per good, set limits |
| trade route start / stop, lists | set route towns and good, start/stop |
| diplomacy buttons, checkboxes | offer war / ceasefire / peace, accepted offers, recall diplomat |

Every button press plays the UI click sample on mouse down. Sounds of clicks in the world view
(selection `sfx_043`, move `sfx_057`, order on target `sfx_058`, groups `sfx_068`/`sfx_069`):
`docs/rendering/objects.md` 7.2.

## 9. 800x600 mode

- Panel sprite `INTERFACE800` (192x600) at (608,0); world view (0,0)-(608,600).
- All fixed elements (minimap, toggles, zoom, town list, money, function bar) use the **same
  panel coordinates**; the top 335 px of both backgrounds are the same art.
- Page area origin is still (4,335) but only 265 px high: grid pages show fewer rows (build
  menu: 4 rows = 8 items), and the grid scroll arrows sit at the bottom of the 600 px panel.
- The modal message box keeps its fixed (200,190) position.

## 10. Open points

- The original redraw rate (and so the money counter's real speed); see 3.6 "rate".
- The research status icon: whether page 2 really opens for the selected laboratory in every
  case (3.5, inferred from the command order).
- Which explanation strings belong to which threshold on the needs page (approximate above).
- Right-click direction in the inhabitants and buildings lists (next vs previous object).
