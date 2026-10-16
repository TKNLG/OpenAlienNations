// Music: the GOG release ships the soundtrack as Bin/music/TrackNN.ogg. Data/CDAudio.ini names
// the menu track and the range of in-game tracks. Browsers only allow audio after a user
// gesture, so playback starts on the first click/key press.
//
// Modes (docs/ui/front-end.md section 7): 'menu' loops the MENU track through all menu screens;
// 'game' plays the FIRST..LAST playlist and resumes where it was after a visit to the menu;
// 'off' (loading screen, videos) is silent.

type Mode = 'menu' | 'game' | 'off';

export class Music {
  private el = new Audio();
  private tracks: number[] = [];
  private menuTrack = 2;
  private enabled = true;
  private started = false;
  private mode: Mode = 'game';
  /** game track and position to resume after the menu */
  private gamePos: { track: number; time: number } | null = null;
  private current = -1;
  volume = 0.5;

  constructor() {
    this.el.addEventListener('ended', () => { if (this.mode === 'game') this.next(); });
    try { this.enabled = localStorage.getItem('an.music') !== 'off'; } catch { /* storage unavailable */ }
    const kick = () => { window.removeEventListener('pointerdown', kick); window.removeEventListener('keydown', kick); this.started = true; this.apply(); };
    window.addEventListener('pointerdown', kick);
    window.addEventListener('keydown', kick);
  }

  /** parse CDAudio.ini: [TRACKS] MENU=2 FIRST=3 LAST=11 */
  configure(ini: string): void {
    const get = (k: string) => Number(new RegExp(`^${k}\\s*=\\s*(\\d+)`, 'mi').exec(ini)?.[1]);
    const first = get('FIRST') || 3, last = get('LAST') || 11;
    this.menuTrack = get('MENU') || 2;
    this.tracks = [];
    for (let t = first; t <= last; t++) this.tracks.push(t);
    if (this.mode === 'menu' && this.current !== this.menuTrack) this.apply();
  }

  get on(): boolean { return this.enabled; }

  /** switch music on or off (remembered across sessions) */
  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    try { localStorage.setItem('an.music', on ? 'on' : 'off'); } catch { /* storage unavailable */ }
    if (on) this.apply(); else this.el.pause();
  }

  toggle(): boolean { this.setEnabled(!this.enabled); return this.enabled; }

  /** volume 0..1, applied immediately */
  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    this.el.volume = this.volume;
  }

  /** menu screens: loop the MENU track (remembers the running game track) */
  playMenu(): void {
    if (this.mode === 'game' && this.current >= 0 && this.current !== this.menuTrack) {
      this.gamePos = { track: this.current, time: this.el.currentTime };
    }
    if (this.mode === 'menu') return;
    this.mode = 'menu';
    this.apply();
  }

  /** in game: continue the playlist where it was, or start a random track */
  playGame(): void {
    if (this.mode === 'game') return;
    this.mode = 'game';
    this.apply();
  }

  /** loading screen and videos stop the music */
  stop(): void {
    if (this.mode === 'game' && this.current >= 0) this.gamePos = { track: this.current, time: this.el.currentTime };
    this.mode = 'off';
    this.el.pause();
  }

  /** a new game: forget the remembered playlist position */
  resetPlaylist(): void { this.gamePos = null; }

  private apply(): void {
    if (!this.enabled || !this.started) return;
    if (this.mode === 'off') { this.el.pause(); return; }
    if (this.mode === 'menu') { this.play(this.menuTrack, 0, true); return; }
    const p = this.gamePos;
    this.gamePos = null;
    if (p) this.play(p.track, p.time, false); else this.next();
  }

  private next(): void {
    if (!this.enabled || !this.started || this.tracks.length === 0) return;
    const t = this.tracks[Math.floor(Math.random() * this.tracks.length)]; // UI only, not simulation
    this.play(t, 0, false);
  }

  private play(track: number, time: number, loop: boolean): void {
    this.current = track;
    this.el.loop = loop;
    this.el.src = `/game/Bin/music/Track${String(track).padStart(2, '0')}.ogg`;
    this.el.volume = this.volume;
    if (time > 0) this.el.addEventListener('loadedmetadata', () => { this.el.currentTime = time; }, { once: true });
    this.el.play().catch(() => { /* missing file or blocked: stay silent */ });
  }

  get menu(): number { return this.menuTrack; }
}
