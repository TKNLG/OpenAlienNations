# Mouse cursors

Status: **read from AN.exe (GOG) and dvge.exe (Gold)**: resources, load order, every place that
sets or hides the cursor, and the rule that picks the in-world cursor. Addresses are cited as
evidence; no code is reproduced. Marks: **(C)** confirmed in the code, **(I)** inferred,
**(U)** uncertain.

Related: [side-panel.md](side-panel.md) (minimap input 6, patrol button 5.2, placement 5.3),
[front-end.md](front-end.md) (videos, loading), [../rendering/objects.md](../rendering/objects.md)
8 (what a click selects), [../game/combat.md](../game/combat.md) 2 (who may attack whom),
[../architecture/integration-addon-gameplay.md](../architecture/integration-addon-gameplay.md) 4
(our earlier guesses, replaced by this document).

## 1. Summary

- The original uses **Windows cursors**, not sprites. There are six 32 x 32 monochrome cursors
  in the executable's resources. Windows draws them (hardware or OS cursor), so the game's
  renderer does not draw them and they do not scale with the screen mode or the UI. The window
  class has no cursor of its own; the game always sets one explicitly (C, `00486cc0`,
  `0048a6a0`).
- **No `.gd` archive has a mouse cursor.** I checked every entry name in `mainmenu.gd` (GOG and
  Gold), `dv.gd`, `Addon.gd` and the three `<RACE>/interface.gd`. The only entry named like one is
  `mainmenu.gd` `CURSOR` (3 x 10, 2 frames). AN.exe never references it
  ([front-end.md](front-end.md) 1.5, 8). It looks like a text-edit caret, not a mouse cursor.
- In the world view the cursor **does not depend on what is under the mouse**. Only three things
  choose it: placement mode, patrol-target mode, and whether the selection contains a unit that
  can fight. No cursor exists for move, harvest, enter, board, invalid target or edge scrolling.
  Relation (war or peace) and the target play no part.
- GOG and Gold are identical except for one rule: Gold also counts the warships 65 and 66 as
  fighters (section 4).

## 2. The cursor resources

The six cursors are Win32 cursor resources. The language is 0x0C07 in both executables. GOG and
Gold have the same six images, byte for byte. Each cursor group (resource type 12) points to
exactly one image (type 1).

| slot | group id | image id | look | hotspot (x, y) | used for |
|---|---|---|---|---|---|
| 0 | 132 (0x84) | 6 | **archer's arrow** pointing to the upper left: tip at the top-left corner, thin shaft, fletching at the lower right. Visible art about 22 x 22 | (0, 0), the tip | **default pointer** everywhere |
| 1 | 133 (0x85) | 7 | **sword**, blade pointing to the upper left, cross-guard and pommel at the lower right. About 22 x 22 | (0, 0), the blade tip | world view while fighters are selected |
| 2 | 129 (0x81) | 3 | **hand** seen from the side, palm down, reaching to the upper left. About 28 x 26 | (15, 15) | **never used** (loaded only) |
| 3 | 131 (0x83) | 5 | **open palm** facing the viewer, fingers up. About 16 x 19 | (16, 13) | minimap drag-scroll |
| 4 | 130 (0x82) | 4 | **thin crosshair**, 1-px white lines with a black outline. About 17 x 17. The centre pixel is transparent | (15, 16), the centre | minimap hover |
| 5 | 128 (0x80) | 2 | **patrol**: a small flag on a stand in the middle, inside a ring of dots. Four arrowheads sit on the ring and point clockwise (top points right, right points down, bottom points left, left points up). About 32 x 31 | (16, 15), the flag | patrol-target mode |

"Slot" is the order in which the six are loaded at start-up (`00486cc0`; Gold `00493810`). All
code chooses a cursor by slot number.

Pixel format (standard Windows cursor resource, not game-specific):

- The image resource is the hotspot (two 16-bit values, x then y), then a 40-byte bitmap header
  (width 32, height 64 because the colour and mask bitmaps are stacked, 1 bit per pixel), a
  2-entry palette (black, white), the colour bitmap (32 rows of 4 bytes, bottom row first), then
  the AND mask (same layout).
- Mask bit 0: the pixel is the palette colour (bit 0 = black, bit 1 = white). Mask 1 with colour
  0: transparent. Mask 1 with colour 1 would invert the screen, but none of the six uses it.
- The result is white art with a 1-px black outline on a transparent background.

## 3. Mechanism (C)

- **Hardware cursor.** The game changes the shape with the Windows cursor call and shows or hides
  it with the Windows show-cursor counter. Nothing is drawn into the frame buffer. The cursor is
  32 x 32 screen pixels at 800 x 600 and at 1024 x 768 alike, so it looks a little smaller at
  1024 x 768. It is not animated. Every cursor has one image and there is no timer.
- **Two variables.** *Wanted* is the slot the world view would like. It is -1 during placement,
  which means "leave the shape alone". *Shown* is the slot last given to Windows.
- **Applying.** Wherever the code says "apply", it means: if *wanted* is not -1 and differs from
  *shown*, set *shown* = *wanted* and give Windows that cursor (`00435000` and inline copies).
- **Re-asserting.** On every mouse-move message and on window activation, the window procedure
  gives Windows the *shown* cursor again if it changed. This keeps Windows from switching back to
  something else (`0048a6a0`; Gold `00497450`).
- **Reset to the pointer.** At start-up, and when a game ends (`0040e970`; Gold `00411aa0`),
  *shown* becomes slot 0.

## 4. Choosing the world-view cursor (C)

The world view computes *wanted* with one rule (`004420f0`; Gold `004461c0`). The first rule
that matches wins:

1. **Patrol-target mode** is active (section 5.3) → **slot 5, patrol**.
2. **Something is selected, the first object of the selection belongs to the local player's
   race, and at least one selected object has one of these types** → **slot 1, sword**:
   - GOG: 17 hunter, 26 saboteur, 29..36 soldiers.
   - Gold: the same plus **65 and 66** (light and heavy warship of each race).
3. Otherwise → **slot 0, arrow**.

Placement mode is handled outside this rule (section 5.4): the cursor is hidden.

Notes on the rule:

- The type is the record type (+0xA8), whatever the object's kind. Only one category is ever
  selected at a time ([objects.md](../rendering/objects.md) 8), so in practice the rule means:
  **own units are selected and at least one of them is a hunter, saboteur, soldier (or, in Gold,
  a warship)**. A mixed group of porters and one soldier shows the sword.
- These do **not** give the sword: police (21), priests (22), criminals (12, even own ones, which
  sit in the "other units" category), foreign units of any type, buildings, nature, transport
  ships (67) and fishing boats (64).
- "First object" means the first in the selection set's internal order. A selection only ever
  holds one category, and own units are all own, so the order does not matter in practice.
- **Not considered**: the object or ground under the mouse, war or peace, melee or ranged
  weapons, whether the target is reachable or valid, water or land, own or foreign buildings.

### 4.1 When the rule runs (C)

*Wanted* is recomputed (and, unless noted, applied at once) on these events:

| event | where |
|---|---|
| the mouse enters the world view | world-view handler `0043f3e0` (Gold `00443460`) |
| the left button is released in the world view and the selection was replaced (click, box) | `004404a0` |
| a patrol waypoint ends patrol mode (5.3) | `004404a0` |
| a building or town hall is placed (5.4) | `004404a0` |
| a double click selects a group | `00440e40` |
| a right click ends patrol mode, or cancels placement | `00441440` |
| a group is recalled with the number keys 0..9 | `004418c0` |
| placement starts while patrol mode is on (patrol ends; computed, not applied) | `00441c40` |
| any object is removed from the display (death and so on) | `00434840` → `00435000` |
| the `PATROL` button is pressed: *wanted* = 5 directly, applied at the next world-view mouse move or entry | `00417fb0` (Gold `0041b5a0`) |

On a mouse move inside the world view, *wanted* is only applied, not recomputed. Box dragging
with the left button does not change the cursor.

## 5. Every situation

### 5.1 Screens other than the world view (C unless marked)

| situation | cursor |
|---|---|
| intro video, outro videos (end of a campaign, free-play win) | **hidden** while the video plays (`00486cc0`, `00427b60`, `004575b0`; shown again when the player object ends, `0043bfb0`). Gold hides it for both `intro.avi` and `intro2.avi` |
| main menu and all front-end screens (race choice, briefing, mission list, settings, load and save, multiplayer) | **arrow (slot 0)**. No hover or button cursor exists |
| setting up the game screen when a game starts (between the loading picture and play) | **hidden** (`00483da0`, hidden at the start and shown at the end) |
| in-game options menu | arrow *(I: the world view gets a leave message when the menu replaces it (5.2). If not, the shown slot stays as it was until the next change. Not traced)* |
| modal message box over the game (mission end and so on) | *(U)* whatever was shown. No code sets a cursor for it. Use the arrow |
| busy or wait | **none**. No hourglass is ever set; long work just freezes the current cursor |
| text input (chat, cheat line, edit fields) | unchanged. The arrow, or the world-view cursor if the mouse is over the world |

### 5.2 Side panel (C)

| situation | cursor |
|---|---|
| anywhere on the panel except the minimap: buttons, pages, town list, sliders, money | **arrow**. When the mouse leaves the world view, the world-view handler sets slot 0 (`0043f3e0`, message "leave"). Buttons change only their tint ([side-panel.md](side-panel.md) 3.1), never the cursor |
| **minimap**, mouse enters | **crosshair (slot 4)** (`0044db30`; Gold `00453450`) |
| minimap, hovering or holding the button before a drag starts | crosshair |
| minimap, left button held and a **drag** starts (held ≥ 500 ms or moved more than 3 px, [side-panel.md](side-panel.md) 6) | **open palm (slot 3)** for as long as the grab-scroll lasts |
| minimap, left button released | crosshair again (a short click also jumps the camera) |
| minimap, right button pressed during a drag (cancels it) | crosshair |
| minimap, right click with own units selected (move order) | crosshair. The order does not change it |
| minimap, mouse leaves | **arrow**. A running drag is cancelled and the camera restored |
| minimap inactive (a widget state flag, +0x2D) | the minimap ignores all input and does not touch the cursor *(I: the widget's disabled state)* |

Quirk (C): when an object is removed while the mouse is over the panel, the world-view rule is
applied (section 4.1), so the sword or patrol cursor can appear over the panel or minimap. It
lasts until the next minimap event or world-view entry or exit. A rebuild may skip this.

### 5.3 Patrol-target mode (C)

- **Entered by** the `PATROL` button on the unit page (soldiers 29..36; in Gold also 65 and 66,
  [side-panel.md](side-panel.md) 5.2). It also ends a running placement.
- **Cursor**: patrol (slot 5) while over the world view. Over the panel and minimap it follows
  section 5.2 (arrow, crosshair). When the mouse comes back into the world view, the patrol
  cursor returns because the rule's first test still holds.
- Each left click in the world view sends a waypoint. The mode, and with it the patrol cursor,
  ends after a click **without Ctrl**, or after the **8th** waypoint. Then the rule runs again,
  which normally gives the sword because the soldier is still selected.
- A **right click** in the world view ends patrol mode and recomputes the cursor.

### 5.4 Placement mode (building ghost, town-hall founding) (C)

- Started by a build-menu entry or the `GRUENDEN` button (`00441c40`). *Wanted* becomes -1,
  which means "leave the shape alone".
- **The cursor is hidden while the mouse is over the world view.** On entering the world view
  in placement mode, the handler hides it. The ghost building under the mouse (the footprint
  marker, [objects.md](../rendering/objects.md) 6) is the only pointer.
- Leaving the world view (to the panel) shows it again as the arrow, so the build menu can be
  used normally. Coming back hides it again.
- Placing (a valid left click) or cancelling (right click) ends placement. The rule runs again,
  its result is applied, and the cursor becomes visible again.
- The cursor does **not** change between a valid and an invalid spot. Only the ghost's
  colouring tells them apart.

### 5.5 World view, normal play (C)

Everything below follows from section 4. The object under the mouse is never examined for the
cursor.

| selection | mouse over … | cursor |
|---|---|---|
| nothing, nature, a building, a foreign unit, an own criminal | anything | arrow |
| own units, none of them a fighter type (porters, builders, woodcutters, stonemasons, police, priests, founders, traders, …) | ground, water, own or foreign units and buildings, trees, stones, bushes, animals, construction sites | **arrow** |
| own units including a hunter, saboteur or soldier (Gold: or warship 65/66) | anything, including empty ground, own buildings, an own unit, a peaceful neighbour's unit, an animal, a tree | **sword** |
| Gold: own transport ship (67) or fishing boat (64) only | fish, water, coast, harbour | arrow |
| Gold: own land units, transport ship under the mouse (boarding) | ship | arrow, or sword if a fighter is in the group |
| any | screen edge (edge scrolling) | unchanged. There are no scroll-arrow cursors; the camera just moves |
| any | an invalid target (out of reach, own unit, unreachable island) | unchanged. There is no "forbidden" cursor |

So the right-click order itself (move, attack, hunt, harvest, enter, build, board, fish,
[objects.md](../rendering/objects.md) 8, [../game/units-and-jobs.md](../game/units-and-jobs.md),
[../game/addon.md](../game/addon.md)) is never shown by the cursor. The manual's remark that the
cursor shape "reflects the selected unit" ([../game/rules-from-manual.md](../game/rules-from-manual.md)
2.1) means exactly this sword and patrol rule.

## 6. GOG and Gold side by side (C)

| item | GOG `AN.exe` | Gold `dvge.exe` |
|---|---|---|
| load the six cursors | `00486cc0` | `00493810` |
| rule (section 4) | `004420f0`: types 17, 26, 29..36 | `004461c0`: types 17, 26, 29..36, **65, 66** |
| apply | `00435000` | `00439010` |
| world-view enter, leave, move, placement hide and show | `0043f3e0` | `00443460` (same behaviour) |
| minimap cursors | `0044db30` | `00453450` (same behaviour) |
| `PATROL` button sets slot 5 | `00417fb0` | `0041b5a0` |
| reset to arrow at the end of a game | `0040e970` | `00411aa0` |
| window procedure re-assert | `0048a6a0` | `00497450` |
| resources | ids 128..133, images 2..7 | identical bytes |

## 7. Rebuild guidance

- **Art source.** The cursors live only in the executable, which the game folder has
  (`Bin/AN.exe` in GOG, `bin/dvge.exe` in Gold; the server already serves the folder under
  `/game/`). Read the resource section, take cursor groups 128..133 and their images, and turn
  each 1-bpp image into a 32 x 32 transparent PNG (section 2 pixel rule). Then use it as a CSS
  cursor with its hotspot: `url(…) hx hy, <fallback>`. Without the executable, use the fallbacks
  in the table below.
- **Size.** Use 32 x 32 CSS pixels with the hotspot unchanged. If the client scales the
  1024 x 768 layout up a lot, a 2x nearest-neighbour copy (64 x 64, hotspot doubled) is allowed
  as an `image-set` choice. Browsers may hide cursors larger than 32 x 32 near the window edge.
  A software-drawn cursor is not needed: the original was not drawn by the game either.
- **State machine.** Follow sections 4 and 5:

  | client state | CSS cursor | fallback without the exe |
  |---|---|---|
  | menus, panel, world view default | slot 0 arrow | `default` |
  | world view, own fighters selected (4) | slot 1 sword | `crosshair` |
  | world view, patrol mode | slot 5 patrol | `cell` |
  | world view, placement or founding | `none` | `none` |
  | minimap hover | slot 4 crosshair | `crosshair` |
  | minimap drag | slot 3 palm | `grabbing` |
  | videos, loading | `none` | `none` |

### 7.1 What our build does differently (as of this writing)

| topic | original | our build (`src/client/main.ts` `updateCursor`, `src/client/addon-ui.ts` `orderIntent`, `INTENT_CURSOR`) |
|---|---|---|
| art | six custom monochrome Windows cursors; the default is an archer's arrow | browser default cursors |
| world-view rule | **selection-based only**: sword if a hunter, saboteur or soldier (Gold also 65/66) is among the own selected units, else the arrow | **target-based**: examines the object under the mouse and the right-click intent: `crosshair` attack, `alias` board, `cell` harvest or fish, `pointer` own building, else `default` |
| fighters selected over ground | sword | default arrow |
| non-fighters over a tree, bush or own building | arrow | `cell` or `pointer` |
| boarding a transport, fishing with a fishing boat (Gold) | arrow (sword with fighters) | `alias`, `cell` |
| patrol mode | patrol cursor (slot 5) | `crosshair` |
| placement and founding | cursor **hidden** over the world view, arrow over the panel | `default`, visible |
| minimap | crosshair; open palm while drag-scrolling; arrow on leave | default arrow (no minimap cursor) |
| while box-dragging | unchanged (arrow or sword) | `default` (cursor logic skipped) |
| videos, loading | hidden | not handled |
| [integration-addon-gameplay.md](../architecture/integration-addon-gameplay.md) 4 boarding, harvest and attack cursors | do not exist | implemented as the stand-ins above |

The target-based intents could stay as an optional "modern hints" setting, but the default must
follow sections 4 and 5. If kept, the hint must examine **the same object a right-click would
target** at that mouse point, i.e. the pixel hit test and priority of
[objects.md](../rendering/objects.md) 8.1 (whole composite sprite, not the footprint), so that
the hint over any part of a building agrees with what the click then does.

## 8. Open points

- In-game options menu and the modal message box: whether the world view receives a leave
  message first (then the arrow) was not traced (5.1).
- Whether a selected unit that goes into a building leaves the selection, and so whether the
  sword stays while only a garrisoned soldier is "selected". This depends on the selection rules,
  not on the cursor code ([objects.md](../rendering/objects.md) 8).
- What the minimap's +0x2D flag means exactly (5.2).
