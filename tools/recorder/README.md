# anrec: runtime recorder for the original (M0)

Plan and record format: `docs/architecture/runtime-recorder.md`. Private tool: the recordings
(`Bin\rec\*.bin`) stay on the machine that made them and are never published.

- `hooks.S`, `anrec.c`: `anrec.dll`, patches srand `004936af`, rand `004936b9`, tick start
  `00482ced` and tick end `00482df3` of GOG `AN.exe` v2.05 (md5 c2d2562e6b678bf241fe6cd0e3ec2e3b).
  It checks the original bytes first and patches nothing on any other build.
- Build: `tools/recorder/build.sh [w64devkit dir]` (x86 w64devkit; or set `W64DEVKIT`, else gcc
  from PATH) → `tools/recorder/out/anrec.dll`.
- Install: copy `anrec.dll` to `<GOG>\Bin\` next to the an-patch `ddraw.dll`, which loads it when
  `an-patch.ini` has `[record] enabled = 1` (proxy change in an-patch `src/proxy.c` DllMain,
  2026-10-16; keep a copy of the previous `ddraw.dll` to switch back).
  Options: `force_seed = N`, `flush_ticks = 50`.
- Records (16 bytes, little endian: kind, tick counter, a, b): 0 header, 1 srand (caller, seed
  stored), 2 rand (caller, seed before; kind | 0x100 = inside a tick), 3 tick start (slot, ms),
  4 tick end (rand calls in the tick, hook time in us), 5 srand requested seed when forced.

Diagnostics (no debugger rights needed; useful when the game runs with admin rights and cannot
be debugged or killed from an unprivileged shell):
- `[record] hooks = 0`: load without patching (baseline). `watchdog = N`: sample the main
  thread (eip + return-address candidates on the stack) at 5, 10, 15, 20, 40, 80 … s up to N s,
  into `Bin\anrec.log`.
- Creating `Bin\rec\anrec.quit` ends the game within a second (records are flushed first).

Remote Desktop: with RDP audio redirection, start-up can take minutes and look hung. Every
DirectSound call of the sound set-up goes through the redirection (rdpendp.dll via MMDevAPI;
frames from AN.exe 0x42fed3 / 0x42ff59 / 0x43071f / 0x430244). The game's sound switch in an.cfg
does not avoid it. Turn RDP audio off, run on the console, or use `no_sound` below.

Start-up options (all in `[record]`, display/sound only, no effect on the simulation):
- `no_sound = 1`: AN.exe's DirectSoundCreate import returns "no driver"; the sound set-up then
  reports "no sound" and the game runs silently (avoids the RDP audio stall).
- `skip_intro = 1`: the intro player's lookup of `intro.avi` (0x48766a) returns "not found", so
  the intro is skipped as if the file were missing; the CD check is a separate lookup.
With both, the main menu is up about one second after start.

The an-patch proxy (separate project, 2026-10-16) gained `[display] gdi_fallback = 1` (default):
when the scaled Blt to the primary fails (over a remote display every one can return
E_NOTIMPL), it draws the game surface with StretchDIBits. Its log now also records every
mouse-button message. Over a remote display `vsync = 0` may be needed.

Scripted input: if the game runs elevated (admin rights, e.g. through a compatibility setting),
injected mouse/keyboard input from an unelevated helper never reaches it (UIPI). Run the helper
elevated too, or drive the menus by hand.
