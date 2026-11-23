# Changelog

What changed for players in each release. Older releases: see the GitHub release pages.

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
