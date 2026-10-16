# Roadmap and later ideas

## Now (faithful rebuild)

- Gold Edition add-on: island campaigns, harbour, shipyard, ships, fishing, sea combat,
  add-on research, add-on menus (analysis of `dvge.exe` in progress, see `game/editions.md`)
- HD UI pack: menus and side panels upscaled (Real-ESRGAN animevideov3 x4), icons with xBR x4 +
  unsharp; built with `tools/hdpack`, switch "HD-Grafik" in the graphics settings
- Docker image for NAS / Unraid hosting (mount the game folder, and the GOG `Bin/music` folder as
  `--music` for a Gold Edition install, whose music was on the CD)

## Later: optional "enhanced" mode (player's choice, the original "vanilla" rules stay the default)

Enhanced options that exist so far are stored settings, all off by default (`src/client/frontend/
settings.ts`: `selectionRings`, `smoothMovement`, `cursorHints`, `advisorQueue`); they change only
the client's presentation, never the simulation. Players switch them in Einstellungen ->
"Erweitert" (main menu and in-game options; our addition, `FrontEndApp.enhanced` in
`src/client/frontend/app.ts`): Auswahlringe, Flüssige Bewegung, Cursor-Hinweise,
Berater-Warteschlange, each Ein/Aus, with a note that they differ from the original and Aus = the
original. They are stored in localStorage `an.settings`; the running game re-reads them within a
second (`main.ts`, `overlay.ts`), so a change applies on resuming the game (the advisor player
switches at the next line it gets while idle).

- Stronger computer opponents: AI tuning (wood shortage of big AI towns, porter gangs, outpost
  garrisons, smarter armies), maybe difficulty levels
- Bigger multiplayer: up to 8 players and computer opponents in total (needs more races or
  several towns per race in one game, larger start-position lists, lobby and HUD changes)
- Quality-of-life options that the original lacks (only behind the mode switch)
- Smooth unit movement: constant-speed interpolation between cells instead of the original's
  stepwise "hiccup" walk (the vanilla mode reproduces the original cadence). *Exists:* setting
  `smoothMovement`
- Selection circles under selected objects as an alternative to the original's blue tint.
  *Exists:* setting `selectionRings`
- HD game sprites: the ~18,000 frames of dv.gd (units, buildings, nature, effects) upscaled too;
  needs a per-category look test (which method suits units vs. buildings vs. effects), ~40 min per
  pass with animevideov3 at 2x, ~60-80 MB as WebP
- Smarter advisor. *Exists:* the setting "Advisor: queue lines" (`advisorQueue`) swaps the
  original's voice player (a queued line gets one frame, a burst is heard as its first line only,
  docs/ui/side-panel.md 1.1.2) for a real pending queue: each queued line plays when the previous
  voice ends, unqueued lines are still dropped while a voice plays, and a client-side guard keeps
  a line from repeating within 60 s (except lines 1, 10, 13, 79, 80); `AdvisorQueue` in
  `src/client/advisor-voice.ts`. Only playback differs: the simulation's filter (120 s per-line
  cooldowns, arming, line 28 unreachable, line 80 only at the end of a collapse) is the same in
  both modes. Vanilla keeps the original's behaviour exactly. *Still ideas:* a length limit
  (2-3 lines), stale lines expiring after a few seconds, the most important line winning a burst,
  and optionally enabling the lines the original made unreachable (e.g. #28 "unzufrieden")

## Decided

- Computer opponents also run in multiplayer games (the original had none there); deterministic,
  lockstep-safe.
