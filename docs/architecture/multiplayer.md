# Multiplayer (our design)

Deterministic lockstep over WebSocket. The server relays; it never simulates. The menus follow
the original's screens ([front-end.md](../ui/front-end.md) 3.13); computer players, starting
before the session is full and passwords are our extensions (roadmap "Decided").

Code: `src/net/protocol.ts` (messages), `src/server/lobby.ts` (rooms, relay),
`src/client/net.ts` (socket), `src/client/frontend/multiplayer.ts` (screens),
`src/client/frontend/freeplay.ts` `mpMission` (the record every client builds),
`src/net/lockstep.ts` (lockstep driver), `Game.startLockstep` in `src/client/main.ts`.

## Flow

1. The browser opens `ws://<server>/ws` and sends `hello` with a display name.
2. **Lobby:** `list` returns open rooms. `create` opens a room (name, max players, setup,
   optional password), and `join` enters one. Every member gets a `room` update whenever the
   room changes (members, races, computer choices).
3. **Races:** each member claims a race with `race` (0 Amazonen, 1 Pimmons, 2 Sajikis). The server
   refuses a race another member holds (`error`, code `race`), so two players never share one.
   The race screen opens the chat lobby once the server's `room` update confirms the claim
   (3.13.5: "on confirmation the chat lobby opens").
4. **Computer seats:** the host decides for every race nobody claims whether a computer player
   takes it or it stays empty (`seats`, one flag per race; default: empty, like the original).
   The chat lobby shows one row per race under a shortened chat log: race name, then the
   player's name, or "Computer" / "Leer" (a toggle for the host, value-button style of 3.7).
5. **Start:** the host sends `start`. The server accepts it when every present member has claimed
   a race and at least two races play (humans plus computers); the room need not be full, so
   1 human + 1..2 computers, 2 humans (+ 0..1 computer) and 3 humans all work. The server
   assigns slots 0..n-1 in join order and sends everyone `start` with the setup, the number of
   human slots, their own slot and the **seats**: one entry per race,
   `{ race, kind: 'human', slot, name }`, `{ race, kind: 'computer' }` or `{ race, kind: 'empty' }`.
6. **World:** every client builds the same record from the start message alone (`mpMission`):
   record 0 of `Infinite.mdb` (or `InfiniteAO.mdb` when `setup.addon`), the host's world
   parameters (front-end.md 6.2), no goals (the last survivor wins), each race block present
   unless its seat is empty, the computer flag set exactly for computer seats. `Game.startLockstep`
   loads it with the human races as `humans`; the populator gives every human a lone founder
   (network game, world-populate.md 9.4) and every computer player the single-player start (a
   finished town hall with builder and porters). Town-hall footprints are taken per race, never
   from the local player's race, so the populated map does not depend on which race a client
   plays (main.ts `hallOf(race)` for multiplayer; single player keeps its old behaviour).
7. **Computer players** run inside every client's World (`WorldSetup.ai`, engine/ai.ts) from the
   world's own random stream; they need no slot and send no commands, so they are part of the
   deterministic state like everything else.
8. **Lockstep** (`src/net/lockstep.ts`):
   - Commands the player issues during tick T are sent as one batch for tick
     `T + INPUT_DELAY_TICKS` (3 ticks = 150 ms). Every tick produces a batch, empty or not.
   - The server forwards each batch to all room members, sender included, in arrival order.
   - A client simulates tick T only once it holds a batch from every human slot for T. It then
     applies them in slot order and steps the world. If a batch is missing, it waits: the game
     briefly pauses for everyone rather than diverging.
   - Every `HASH_INTERVAL` ticks (40 = 2 s) each client sends its state hash. If hashes for a
     tick differ, the server broadcasts `desync`.
   - Messages that arrive while a client is still loading the map are kept and handed to the
     lockstep driver first.
9. **Leaving:** if a player disconnects, the others get `gone` and treat that slot's missing
   batches as empty from then on.

## Passwords

`create` may carry a password (empty = open session). `RoomInfo.locked` marks protected rooms;
the session list appends " - Passwort". Clicking a protected room opens a password screen (the
name-screen layout, masked edit); `join` sends the password and the server compares it
(`error`, code `password`, on a mismatch: "Falsches Passwort!"). The password is kept only in the
server's room record: it is never part of a message to any client and never logged. The host
enters it on an extra screen after "Neue Session" (title "Passwort (optional)", empty = open).

## Add-on (Gold Edition)

The "Addon:" row of the world parameters (addon.md 11.4) exists in the multiplayer variant too.
`setup.addon` is the original start message's AO flag (addon.md 11.5); with it every client
loads `InfiniteAO.mdb`, the merged rules and the island generator, which re-rolls deterministically
from the host's seed (addon.md 9.5; a cycle of failing seeds continues from a deterministic escape
seed, integration-addon.md 7), so all clients agree without the host sending a final seed.
The race screen uses `RASSENWAHLAO` and the loading screen `LOADING_B`.

## Why this model

- Traffic is tiny: a few bytes per player per tick, so it works over any home network or the
  internet.
- Same code path for single player (local commands applied with no delay).
- The NAS server stays trivial and cheap: no game logic, no game state.

## Tested

`test/multiplayer.test.ts` runs the real server with real WebSocket clients:

- two clients issue different commands at different ticks and are identical after 900 ticks;
- lobby: password refused when missing or wrong, accepted when right, never sent to a client;
  races claimed once; only the host sets computer seats; start refused until every member has a
  race and two races play; start with 2 members in a 3-player room carries the right seats;
- 2 humans + 1 computer player on a generated 256 map for 3000 ticks: identical hashes, no desync,
  the computer player builds, both founders moved by lockstep orders (needs `AN_DATA`);
- island free play (needs `AN_GOLD`): the start world is identical whichever race the client
  plays, and two clients stay in sync with a computer player.

`tools/mp_lobby_browser_test.py <url> <out-prefix> [seconds] [addon]` plays the whole menu flow in
two headless browsers (password create, wrong and right password, races, a computer seat, start,
play) and compares state hashes at common ticks. `tools/mp_browser_test.py` drives the developer
lobby (`?dev`, campaign-mission rooms through `Game.startMultiplayer`).

## Later

- Reconnect/resume: snapshot plus command log from the host.
- Pause, game speed votes.
- Saving a multiplayer game (host snapshot, see the saves plan in README; addon.md 11.5).
- Kicking a member, changing the world parameters after the session exists.
