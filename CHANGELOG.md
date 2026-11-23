# Changelog

What changed for players in each release. Older releases: see the GitHub release pages.

## 0.5.2

Game speed, cheats, edge scrolling and units that react to a lost target like in the original, plus fixes for the launcher on Windows. Saves from earlier versions keep loading.

### Closer to the original

**Units stop when their target is gone**
- When the building or unit a unit is heading for is destroyed, the unit now stops where it is (it finishes the step it is taking) instead of walking on to an empty spot. This covers builders, porters and deliveries, workers and trainees, town founders, farmers, police and escorts, units boarding a ship, diplomats, merchants, and units you sent somewhere with a right-click.
- A destroyed or demolished construction site sends its builders away within a few ticks (at the site's next 10-tick check, as in the original), and no new builder is called to it.

**Game speed**
- The original's three game speeds are back: **1** = normal, **2** = double, **3** = four times as fast. The original used F5 to F7, but browsers reserve those keys (F5 reloads the page). As in the original, nothing on screen shows the speed.
- In a multiplayer game only the host can change the speed, for everyone. A loaded game starts at normal speed.

**Zoom keys**
- **+** and **−** zoom in or out one step, and **Page Up** / **Page Down** jump to the closest or farthest zoom, as in the original. The mouse wheel still zooms too.

**Cheats**
- All twelve cheat words of the original work. Type them during the game: CASHCOW (+5000 money), RAIN, LUMBERJACK, STONEMASON, IRONMAN, IAMHUNGRY, WARTIME, CHOCO, JUICE, LOLLY (50 of the matching good each into your current town), MAGICEYE (fog of war off and back on) and WINNER (win the mission; not in free play).
- As in the original, cheats only work in single player.

**Edge scrolling**
- Moving the mouse to the edge of the screen scrolls the map, as in the original. This only happens while the game is full screen (the setting or the browser's F11), so the map does not run away while you move the mouse to another monitor in a window. As in the original, the bottom edge does not scroll over the side panel.

### Launcher and server
- **No administrator rights needed.** A game folder with entries your Windows user is not allowed to read (for example folders created by an installer running as administrator, broken shortcuts or junctions, or files locked by antivirus) used to stop the server, so it only worked when run as administrator. Such entries are now skipped and listed in the console with the reason, and a file that cannot be opened fails only that one request. The program writes only its own settings file in your user profile (`%APPDATA%\OpenAlienNations` on Windows).
- **Switching between installs:** after pointing the program at another install (for example from an English to a German one), the browser could keep playing cached files of the old one, such as English advisor speech with German texts. Game files are now always checked against the current install.
- **New start option `--verbose`** (or `AN_VERBOSE=1`): prints the settings file, the game and music folders and every game file the browser loads, with its full path. Useful when the wrong files seem to be used.

## 0.5.1

A small follow-up to 0.5.0.

- Trees now play their falling sound when they are cut down (the original's felling sound, as the tree starts to fall).
- The build menu no longer draws a frame around the building you are placing (the original has none).

## 0.5.0

A large fidelity release. The original's function names from the Mac version of the game were matched onto the PC executables, and every part of the game was audited against the original code: about 130 differences were found and fixed, so the default ("vanilla") mode plays much closer to the original. Saves from 0.4.0 keep loading.

### Closer to the original

**Walking and transport**
- Units now use the original path finder: they search from both ends at once, prefer worn paths and avoid slopes as in the original, re-plan up to 15 times and never walk towards an unreachable spot. The long-distance walking shortcuts of earlier versions are gone.
- Uphill steps take as long as in the original (uphill and downhill are not treated alike).
- Move orders: each unit gets its own cell around the click, as in the original; a unit already standing on the clicked cell stays, and repeating the same order does nothing.
- Porters: a porter who already carries the needed good goes straight to the destination; a store that has run out makes the transport fail and the need is re-filed; the leisure job uses the dispatcher's list of free porters; store, porter and worker distances are measured from the building's position; trainee requests follow the original order and timing.

**Economy and nature**
- Saplings grow as many steps as their tree sprite has growth frames (3 to 6), not always 5.
- Farmers: the crop type is decided when the farm sends the farmer out, the planting spot is searched around the chosen cell, and a farmer who finds no spot still walks out and back.
- Construction sites gain hit points and frames in the original steps (about 10 % slower than before for most buildings); training starts 1 tick after the order; workshops over-order materials like the original.
- Map buildings start with the original's occupancy count, so many shipped maps start with houses holding one resident more than their capacity.
- Smaller fixes: research selection and toggling, bank / laboratory / library checks use the town's first building of that type, tax income, finances, the town's happiness bonus.

**Combat, crime and social jobs**
- Ranged units use the original line of fire: their reach is lopsided (longer diagonally, shorter along one axis and uphill), and nobody shoots across the map edge.
- Buildings are found through any cell of their footprint (help, guards, outposts, priests and the computer players).
- Clicking the same attack, heal, harvest or go-to target again no longer restarts the order.
- A wounded priest on auto-heal heals himself first; the patrol button works like the original's.
- Diplomats: an offer is decided after the host embassy sends the diplomat out (about 100 ticks later than before), and recalling a diplomat from your last embassy can turn peace into war, exactly as in the original.
- Merchants: a war turns a merchant round mid-walk, a failed leg flips the route, and clicking a town redirects a running route.
- Scouts walk to random map cells with the original pauses; the attack job's firing-position search is the original's.

**Computer players**
- Raid armies keep their last candidates (soldiers before hunters) and keep fighting around a fallen target town; each think sends up to that many extra scouts exploring; new towns are founded with the original site search; intruders draw defenders in proportion to how often they move and strike; a computer town starts research as soon as its laboratory is active.
- (Kept deliberately: Pimmon and Sajiki computer towns react to a porter shortage like the Amazons. The original has a bug there that makes them stall.)

**Towns, goals and multiplayer**
- A multiplayer game is won once every other nation is dead (mission goals do not count in network games, as in the original).
- A nation is defeated when its last town is destroyed, not when it has no units left.
- Goals naming a city that does not exist are false; a mission without win goals is won at once.
- Units of a destroyed town move into the nearest town's houses right away.
- Towns can be renamed (the RENAME button works).

**Add-on (Gold Edition)**
- A transport takes 6 passengers when six or more queue at once, as in the original.
- Unloading goes through the normal leave routine with retries; a landing cell on coastal water works as in the original; docking and shipyard launches hold the ship for 35 ticks.
- Ships cut diagonal corners like units, so straits joined only at a corner are passable.
- Fishing: the catch and its random draws follow the original; right-clicking a fishing boat on a fish gives the original's useless endless harvest again (use a move order to fish, as in the original).

### HD graphics
- Settings → Graphics → **HD graphics** now has three levels:
  - **All** (default): HD menus and side panels, and every building icon rendered sharp from the game's own building sprites;
  - **Partly**: the same, but only the building icons that can be reproduced exactly; the others (22 Sajiki buildings drawn from another camera angle) stay original;
  - **Off**: the original art.
- Unit portraits show the game's own picture, smoothed.
- English and French players no longer get German pictures from the HD pack (the Amazons are dressed in those editions, and the English luxury good is a lollipop).
- A building portrait that cannot be loaded is generated from the building sprite and reported in the browser console.

### Languages
- Everything OpenAlienNations adds (settings, saves, multiplayer, free play, mission goals, hints and messages) is now in German, English or French, following the language of your game files. The launcher console also speaks French (`--lang fr`).
- French GOG installs start correctly (two font files they lack are no longer required).

### Saves
- Saves from 0.4.0 and earlier load and continue; they keep the fishing-boat behaviour they were saved with.
