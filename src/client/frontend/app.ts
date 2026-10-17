// Front-end screen flow: main menu, single player, race selection, mission list, briefing, world
// parameters, loading, settings, load/save/delete lists, in-game options menu and mission end.
// Spec: docs/ui/front-end.md sections 2, 3, 5, 6, 7 (section numbers in the comments below).

import { CAMPAIGNS, CAMPAIGNS_AO, FREEPLAY_AO, type Campaign, type GameData } from '../data.ts';
import type { Mission } from '../../formats/mission.ts';
import type { WorldSnapshot } from '../../engine/world.ts';
import type { GameSetup } from '../../net/protocol.ts';
import type { NetClient } from '../net.ts';
import type { Music } from '../audio.ts';
import { saves, requestPersistence, type SaveGame, type SaveInfo } from '../saves.ts';
import { describeGoal } from '../briefing.ts';
import type { MenuAssets } from './assets.ts';
import { FrontEnd, type Screen } from './layer.ts';
import { C, Figure, Image, Label, ListBox, R, ScrollRing, Slider, TextButton, TextEdit, type Align, type Rect, type Widget } from './widgets.ts';
import { loadSettings, saveSettings, getUiScale, setUiScale, UI_SCALES, getProgress, recordWin, type Settings } from './settings.ts';
import { applyFreePlay, randomSeed, spDefaults, FREEPLAY_CAMPAIGN, type FreePlayParams } from './freeplay.ts';
import { Multiplayer } from './multiplayer.ts';
import { setHdEnabled } from '../ui-assets.ts';

/** what the front end needs from the running game (implemented by the Game class in main.ts) */
export interface GameHost {
  loadMission(c: Campaign, index: number, player?: number, snapshot?: WorldSnapshot, humans?: number[], override?: Mission): Promise<void>;
  startMultiplayer(setup: GameSetup, players: number, you: number, net: NetClient, slotRaces?: number[]): Promise<void>;
  /** lockstep game from a free-play record every client built identically (multiplayer.ts);
   *  `slotRaces` = race of each human slot */
  startLockstep(c: Campaign, m: Mission, slotRaces: number[], you: number, net: { on: NetClient['on']; send: NetClient['send'] }): Promise<void>;
  makeSave(name: string): SaveGame | null;
  loadSave(save: SaveGame): Promise<void>;
  /** stop the running game (world dropped, lockstep detached) */
  endGame(): void;
  /** simulation stopped (single-player options menu, result box) */
  paused: boolean;
  /** not rendered (a menu covers the screen) */
  hidden: boolean;
  readonly multiplayer: boolean;
  readonly playerRace: number;
  /** the human player's mission outcome: 0 playing, 1 won, -1 lost */
  readonly outcome: number;
  /** the human player owns at least one unit or building */
  readonly ownsAnything: boolean;
}

type SessionKind = 'campaign' | 'tutorial' | 'free' | 'mp';
/** what is being played: needed for restart, mission end and saves */
interface Session { kind: SessionKind; campaign: Campaign; index: number; race: number; mission?: Mission; }

/** where a settings / load chain returns to (3.9: every "Zurück" chain ends where it started) */
type From = 'main' | 'game';

const RACE_CAMPAIGN = ['amazons', 'pimmons', 'sajiki'];
const RACE_CAMPAIGN_AO = ['amazons-ao', 'pimmons-ao', 'sajiki-ao'];
const isAo = (c: Campaign) => c.id.endsWith('-ao');

export class FrontEndApp {
  readonly fe: FrontEnd;
  readonly a: MenuAssets;
  readonly music: Music;
  readonly data: GameData;
  private ready: Promise<GameHost>;
  private host: GameHost | null = null;
  settings: Settings;
  private version: string;
  private session: Session | null = null;
  private inGame = false;
  /** mission end detection is armed only once the player owns something (free play maps are empty) */
  private armed = false;
  private free: FreePlayParams = spDefaults();
  /** the install has the mission pack (Gold Edition): add-on menus are shown */
  private addon = false;
  private missionCache = new Map<string, Promise<Mission[]>>();
  private playSeconds = 0;
  private speech: HTMLAudioElement | null = null;
  /** map files without a speech file (asked once) */
  private noSpeech = new Set<string>();
  readonly mp: Multiplayer;

  constructor(fe: FrontEnd, music: Music, data: GameData, ready: Promise<GameHost>, version: string) {
    this.fe = fe; this.a = fe.a; this.music = music; this.data = data; this.version = version;
    this.ready = ready.then(g => { this.host = g; return g; });
    this.settings = loadSettings();
    this.applySettings();
    this.mp = new Multiplayer(this);
    void data.hasAddon().then(v => { this.addon = v; });
    fe.onGameEscape = () => this.openGameMenu();
    setInterval(() => this.watch(), 300);
    setInterval(() => this.autosaveClock(), 1000);
    window.addEventListener('keydown', e => {
      if (e.key === 'F12' && this.inGame && !this.fe.visible && this.host && !this.host.multiplayer) { e.preventDefault(); void this.quicksave(); }
    });
  }

  // ---------------------------------------------------------------- building blocks

  s(id: number): string { return this.a.s(id); }
  game(): Promise<GameHost> { return this.ready; }
  /** the game, if it is already created */
  hostNow(): GameHost | null { return this.host; }

  title(text: string, r: Rect = R(230, 270, 565, 299), font: 'dv18pt' | 'dv14pt' = 'dv18pt'): Label { return new Label(r, text, font, C.blue); }
  label(r: Rect, text: string, align: Align = 'L', font: 'dv14pt' | 'dv18pt' | 'dv7pts2' = 'dv14pt', color: string = C.brown): Label { return new Label(r, text, font, color, align); }
  button(r: Rect, text: string, action: () => void, font: 'dv14pt' | 'dv18pt' | 'dv10pt' = 'dv14pt', color: string = C.brown, align: Align = 'C'): TextButton {
    return new TextButton(r, text, action, font, color, align);
  }
  /** value / toggle button: black, red on hover (1.3) */
  value(r: Rect, text: string, action: () => void, align: Align = 'R'): TextButton { return new TextButton(r, text, action, 'dv14pt', C.black, align); }
  back(r: Rect, action: () => void): TextButton { return this.button(r, this.s(75), action); }
  screen(widgets: Widget[], onEscape?: () => void, bg = 'MAINMENU', onClose?: () => void): Screen { return { bg, widgets, onEscape, onClose }; }
  show(widgets: Widget[], onEscape?: () => void, bg = 'MAINMENU', onClose?: () => void): void { this.fe.show(this.screen(widgets, onEscape, bg, onClose)); }

  missions(c: Campaign): Promise<Mission[]> {
    let p = this.missionCache.get(c.id);
    if (!p) { p = this.data.missions(c); this.missionCache.set(c.id, p); p.catch(() => this.missionCache.delete(c.id)); }
    return p;
  }

  applySettings(): void {
    const st = this.settings;
    setHdEnabled(st.hd);
    this.music.setEnabled(st.soundOn);
    this.music.setVolume(st.music / 100);
    this.a.soundOn = st.soundOn;
    this.a.effectVolume = st.effects / 100;
    if (this.speech) this.speech.volume = st.speech / 100;
  }
  private changed(): void { saveSettings(this.settings); this.applySettings(); }

  // ---------------------------------------------------------------- 3.2 main menu

  mainMenu(): void {
    this.mp.leave();
    this.session = null;
    this.inGame = false;
    this.devMode = false;
    this.music.playMenu();
    const big = (r: Rect, id: number, f: () => void) => this.button(r, this.s(id), f, 'dv18pt');
    this.show([
      big(R(230, 255, 565, 294), 65, () => this.singlePlayer()),
      big(R(230, 295, 565, 334), 66, () => this.mp.start()),
      big(R(230, 350, 565, 389), 67, () => void this.loadList('main')),
      big(R(230, 390, 565, 429), 68, () => this.settingsMenu('main')),
      big(R(230, 450, 565, 490), 247, () => this.quit()),
      new Label(R(600, 580, 790, 595), `OpenAlienNations ${this.version}`, 'dv7pts2', C.white, 'R', false, 'B'),
    ]);
  }

  /** "Spiel verlassen": a browser tab cannot quit; try to close it, else say so */
  private quit(): void {
    window.close();
    setTimeout(() => this.fe.message('Du kannst das Browserfenster jetzt schließen.'), 200);
  }

  // ---------------------------------------------------------------- 3.3 single-player mode

  singlePlayer(): void {
    const addon = this.free.addon; // the "Addon:" toggle keeps its value (addon.md 11.2)
    this.free = { ...spDefaults(), addon }; // reset every time this menu opens (6.1)
    const tut = CAMPAIGNS.find(c => c.id === 'tutorials')!;
    const rows = this.addon
      // Gold Edition layout (addon.md 11.2): four 30 px rows
      ? [this.button(R(230, 320, 565, 350), this.s(251), () => void this.missionList(tut)),
         this.button(R(230, 350, 565, 380), this.s(186), () => this.raceSelect('campaign')),
         this.button(R(230, 380, 565, 410), this.s(326), () => this.raceSelect('campaign-ao')),
         this.button(R(230, 410, 565, 440), this.s(187), () => this.worldParams('sp'))]
      : [this.button(R(230, 320, 565, 359), this.s(251), () => void this.missionList(tut)),
         this.button(R(230, 360, 565, 399), this.s(186), () => this.raceSelect('campaign')),
         this.button(R(230, 400, 565, 440), this.s(187), () => this.worldParams('sp'))];
    this.show([this.title(this.s(185)), ...rows, this.back(R(340, 460, 460, 500), () => this.mainMenu())], () => this.mainMenu());
  }

  // ---------------------------------------------------------------- 3.4 race selection

  /** the race-selection layout, shared with the multiplayer variant (3.13.5) */
  raceWidgets(signX: number, pick: (race: number) => void, back: () => void, taken: Set<number> = new Set()): Widget[] {
    const fig = (name: string, x: number, y: number, plate: Image, race: number) => {
      const f = new Figure(name, x, y, plate, this.fe, () => pick(race));
      f.disabled = taken.has(race);
      return f;
    };
    return [
      new Image('WAEHLEVOLK', signX, 56, this.fe),
      fig('PI', 58, 153, new Image('PIMONS', 95, 499, this.fe), 1),
      fig('AZ', 350, 110, new Image('AMAZONEN', 270, 460, this.fe), 0),
      fig('SA_B', 486, 100, new Image('SAJIKI', 535, 495, this.fe), 2),
      this.back(R(340, 522, 460, 540), back),
    ];
  }

  raceSelect(mode: 'campaign' | 'campaign-ao' | 'free'): void {
    const back = mode === 'free' ? () => this.worldParams('sp') : () => this.singlePlayer();
    const pick = (race: number) => {
      if (mode === 'campaign') void this.missionList(CAMPAIGNS.find(c => c.id === RACE_CAMPAIGN[race])!);
      else if (mode === 'campaign-ao') void this.missionList(CAMPAIGNS_AO.find(c => c.id === RACE_CAMPAIGN_AO[race])!);
      else void this.startFreePlay(race);
    };
    const ao = mode === 'campaign-ao' || (mode === 'free' && !!this.free.addon);
    this.show(this.raceWidgets(mode === 'free' ? 232 : 227, pick, back), back, ao ? 'RASSENWAHLAO' : 'RASSENWAHL');
  }

  // ---------------------------------------------------------------- 3.5 mission list (5: unlock rule)

  async missionList(c: Campaign): Promise<void> {
    let ms: Mission[];
    try { ms = await this.missions(c); } catch (err) { this.fe.message(`Fehler: ${errText(err)}`); return; }
    const last = Math.min(getProgress(c.id), ms.length - 1);
    const list = new ListBox(R(220, 330, 580, 450), { onPick: i => void this.briefing(c, i) }).layout(this.a);
    list.setLines(ms.slice(0, last + 1).map((m, i) => ({ text: m.title, value: i })));
    const back = c.id === 'tutorials' ? () => this.singlePlayer() : () => this.raceSelect(isAo(c) ? 'campaign-ao' : 'campaign');
    this.show([this.title(this.s(196), R(230, 270, 565, 299), 'dv14pt'), list, this.back(R(345, 470, 455, 490), back)], back, isAo(c) ? 'MISSIONSAUSWAHL' : 'MAINMENU');
  }

  // ---------------------------------------------------------------- 3.6 briefing

  /** readOnly: opened from the options menu, OK and Zurück return there */
  async briefing(c: Campaign, index: number, readOnly = false, override?: Mission): Promise<void> {
    let m: Mission | undefined, rules: GameData['rules'];
    try {
      m = override ?? (await this.missions(c))[index];
      await this.ready;
      rules = this.data.rules;
    } catch (err) { this.fe.message(`Fehler: ${errText(err)}`); return; }
    if (!m) { this.mainMenu(); return; }
    const race = c.id === 'tutorials' ? 1 : m.humanRace >= 0 ? m.humanRace : 0;
    // briefing text, then the decoded goals (our addition: the original only has the text)
    const goals = m.goals.map(g => `- ${g.defeat ? 'Niederlage, wenn: ' : ''}${describeGoal(g, race, rules)}`);
    const text = `${m.briefing.trimEnd()}\n\nMissionsziele:\n${goals.join('\n')}`;
    // add-on records use their own briefing art and layout (addon.md 11.3)
    const ao = !!m.addon;
    const list = new ListBox(ao ? R(220, 270, 570, 450) : R(220, 260, 597, 450), { onPick: null, align: 'L', spacing: 1.0 }).layout(this.a);
    list.setLines(this.a.font('dv7pts2').wrap(text, (ao ? 570 : 597) - 18 - 220 + 1).map((t, i) => ({ text: t, value: i })));
    const ring = ao ? new ScrollRing(R(661, 231, 722, 454), list, 'SCHIEBERINGAO') : new ScrollRing(R(672, 258, 702, 454), list);
    const portraits: Widget[] = [];
    if (m.races[0]?.present) portraits.push(ao ? new Image('AMABRIEFAO', 335, 82, this.fe) : new Image('AMABRIEF', 344, 20, this.fe));
    if (m.races[1]?.present) portraits.push(ao ? new Image('PIMBRIEFAO', 175, 86, this.fe) : new Image('PIMBRIEF', 138, 70, this.fe));
    if (m.races[2]?.present) portraits.push(ao ? new Image('SABRIEFAO', 520, 99, this.fe) : new Image('SABRIEF', 511, 55, this.fe));
    const back = readOnly ? () => this.optionsMenu() : () => void this.missionList(c);
    const ok = readOnly ? () => this.optionsMenu() : () => void this.startSession({ kind: c.id === 'tutorials' ? 'tutorial' : 'campaign', campaign: c, index, race });
    const mission = m;
    this.show([
      ...portraits,
      this.title(m.title, ao ? R(230, 230, 565, 250) : R(230, 220, 565, 240), 'dv14pt'),
      list, ring,
      this.back(R(220, 470, 340, 490), back),
      this.button(R(340, 470, 460, 490), this.s(282), () => printBriefing(mission.title, mission.briefing)),
      this.button(R(460, 470, 580, 490), this.s(181), ok),
    ], back, ao ? 'BRIEFINGSCREENAO' : 'BRIEFINGSCREEN', () => this.stopSpeech());
    if (!readOnly) this.playSpeech(m);
  }

  /** briefing speech: data\sound\mission\<map>.wav once, if it exists (3.6) */
  private playSpeech(m: Mission): void {
    this.stopSpeech();
    if (!m.mapFile || !this.settings.soundOn || this.noSpeech.has(m.mapFile)) return;
    const a = new Audio(`/game/Data/SOUND/mission/${m.mapFile.replace(/\.[^.]*$/, '.wav')}`);
    a.volume = this.settings.speech / 100;
    a.addEventListener('error', () => this.noSpeech.add(m.mapFile)); // not shipped with the GOG data
    a.play().catch(() => { /* missing or blocked: silent */ });
    this.speech = a;
  }
  private stopSpeech(): void { this.speech?.pause(); this.speech = null; }

  // ---------------------------------------------------------------- 3.7 world parameters

  worldParams(mode: 'sp' | 'mp', p: FreePlayParams = this.free, mpBack?: () => void): void {
    const vals = [[294, 295, 296], [297, 295, 298], [299, 295, 300], [299, 295, 300]];
    const keys = ['size', 'resources', 'development', 'stock'] as const;
    const again = () => this.worldParams(mode, p, mpBack);
    const rows: Widget[] = [];
    if (this.addon) {
      // "Addon:" row (addon.md 11.4): island free play; size Klein is not offered with it
      rows.push(this.label(R(230, 290, 470, 320), this.s(325)));
      rows.push(this.value(R(490, 290, 570, 320), this.s(p.addon ? 204 : 205), () => { p.addon = !p.addon; if (p.addon && p.size === 0) p.size = 1; again(); }));
    }
    keys.forEach((k, i) => {
      const y = 320 + i * 30;
      rows.push(this.label(R(230, y, i < 2 ? 539 : 470, y + 30), this.s(301 + i)));
      rows.push(this.value(R(490, y, 570, y + 30), this.s(vals[i][p[k]]), () => {
        p[k] = (p[k] + 1) % 3;
        if (k === 'size' && p.addon && p.size === 0) p.size = 1;
        again();
      }));
    });
    const back = mode === 'sp' ? () => this.singlePlayer() : () => mpBack?.();
    const buttons = mode === 'sp'
      ? [this.back(R(260, 470, 370, 490), back), this.button(R(410, 470, 550, 490), this.s(92), () => this.raceSelect('free'))]
      : [this.back(R(340, 470, 460, 490), back)];
    this.show([this.title(this.s(293), R(230, 255, 565, 285)), ...rows, ...buttons], back);
  }

  // ---------------------------------------------------------------- starting a game (3.8)

  private async startFreePlay(race: number): Promise<void> {
    try {
      const camp = this.free.addon ? FREEPLAY_AO : FREEPLAY_CAMPAIGN;
      const base = (await this.missions(camp))[race];
      const mission = applyFreePlay(base, this.free, randomSeed());
      await this.startSession({ kind: 'free', campaign: camp, index: race, race, mission });
    } catch (err) { this.fe.message(`Fehler: ${errText(err)}`, () => this.mainMenu()); }
  }

  /** the loading screen, painted at once (no progress bar, no text) */
  loadingScreen(addon = false): void {
    this.stopSpeech();
    this.music.stop();
    // the cursor is hidden while the game screen is set up (docs/ui/cursors.md 5.1)
    this.fe.show({ ...this.screen([], undefined, addon ? 'LOADING_B' : 'LOADING'), hideCursor: true }, true);
  }

  async startSession(s: Session): Promise<void> {
    this.loadingScreen(isAo(s.campaign));
    await nextPaint();
    try {
      const g = await this.ready;
      this.leaveGame();
      const player = s.kind === 'free' ? s.race : undefined;
      await g.loadMission(s.campaign, s.index, player, undefined, undefined, s.mission);
      s.race = g.playerRace;
      this.session = s;
      this.music.resetPlaylist();
      this.enterGame();
    } catch (err) {
      console.error(err);
      this.fe.message(`Fehler: ${errText(err)}`, () => this.mainMenu());
    }
  }

  /** stop the running game; it is neither simulated nor drawn until the next one starts */
  private leaveGame(): void {
    const g = this.host;
    if (g) { g.endGame(); g.hidden = true; g.paused = false; }
    this.inGame = false;
  }

  /** the game takes the screen: hide the layer, run and show the game, game music */
  enterGame(): void {
    const g = this.host!;
    this.fe.hide();
    g.hidden = false;
    g.paused = false;
    this.inGame = true;
    this.armed = g.ownsAnything;
    this.playSeconds = 0;
    this.music.playGame();
  }

  /** dev / tool mode: a mission was loaded directly (?c=); only the options menu is offered,
   *  mission end is not watched so tools are never interrupted by a result box */
  attachRunning(c: Campaign, index: number): void {
    void this.ready.then(g => {
      this.session = { kind: c.id === 'tutorials' ? 'tutorial' : 'campaign', campaign: c, index, race: g.playerRace };
      this.inGame = true;
      this.devMode = true;
    });
  }
  private devMode = false;

  /** multiplayer game started by the lobby */
  enterMultiplayerGame(campaign: Campaign = FREEPLAY_CAMPAIGN): void {
    this.session = { kind: 'mp', campaign, index: 0, race: this.host!.playerRace };
    this.music.resetPlaylist();
    this.enterGame();
  }

  // ---------------------------------------------------------------- 3.12 mission end

  private watch(): void {
    const g = this.host;
    if (!g || !this.inGame || this.fe.visible || this.devMode) return;
    if (!this.armed) { this.armed = g.ownsAnything; return; }
    const o = g.outcome;
    if (o === 0) return;
    this.armed = false;
    if (!g.multiplayer) g.paused = true;
    this.fe.message(this.s(o > 0 ? 218 : 219), () => void this.afterMission(o > 0));
  }

  private async afterMission(won: boolean): Promise<void> {
    const s = this.session;
    this.leaveGame();
    if (!s || (s.kind !== 'campaign' && s.kind !== 'tutorial')) { this.mainMenu(); return; }
    this.music.playMenu();
    if (!won) { await this.briefing(s.campaign, s.index); return; }
    recordWin(s.campaign.id, s.index);
    const count = (await this.missions(s.campaign)).length;
    if (s.index + 1 < count) { await this.briefing(s.campaign, s.index + 1); return; }
    // campaign complete: the original plays the race's outro video (AVI, not playable here)
    if (s.kind === 'campaign') { this.mainMenu(); this.fe.message('Kampagne abgeschlossen!'); } else this.mainMenu();
  }

  // ---------------------------------------------------------------- 3.11 in-game options menu

  /** open the options menu over the running game (Escape or the side panel's disk icon) */
  openGameMenu(): void {
    const g = this.host;
    if (!g || !this.inGame || this.fe.boxOpen) return;
    if (!g.multiplayer) g.paused = true;
    g.hidden = true;
    this.music.playMenu();
    this.optionsMenu();
  }

  resumeGame(): void {
    const g = this.host!;
    this.fe.hide();
    g.hidden = false;
    g.paused = false;
    this.music.playGame();
  }

  optionsMenu(): void {
    const g = this.host!;
    const b = (r: Rect, id: number, f: () => void) => this.button(r, this.s(id), f, 'dv18pt');
    const resume = () => this.resumeGame();
    const end = () => this.sure(this.s(203), () => void this.endGameToMenu(), () => this.optionsMenu());
    if (g.multiplayer) {
      this.show([
        b(R(230, 305, 565, 335), 68, () => this.settingsMenu('game')),
        b(R(230, 350, 565, 380), 70, resume),
        b(R(230, 395, 565, 425), 69, end),
      ], resume);
      return;
    }
    const s = this.session!;
    this.show([
      b(R(230, 245, 565, 274), 243, () => void this.briefing(s.campaign, s.index, true, s.mission)),
      b(R(230, 290, 565, 320), 71, () => void this.saveList()),
      b(R(230, 320, 565, 350), 67, () => void this.loadList('game')),
      b(R(230, 350, 565, 380), 68, () => this.settingsMenu('game')),
      b(R(230, 395, 565, 425), 317, () => this.sure(this.s(316), () => void this.restart(), () => this.optionsMenu())),
      b(R(230, 425, 565, 455), 70, resume),
      b(R(230, 470, 565, 500), 69, end),
    ], resume);
  }

  /** 1.8 "are you sure" screen */
  sure(question: string, yes: () => void, no: () => void): void {
    this.show([
      new Label(R(250, 270, 575, 399), question, 'dv18pt', C.brown, 'C', true),
      this.button(R(260, 420, 370, 470), this.s(204), yes),
      this.button(R(410, 420, 550, 470), this.s(205), no),
    ], no);
  }

  /** restart the same record; free play keeps the overrides but draws a new seed (3.11) */
  private async restart(): Promise<void> {
    const s = this.session!;
    const mission = s.kind === 'free' && s.mission ? { ...s.mission, seed: randomSeed() } : s.mission;
    await this.startSession({ ...s, mission });
  }

  /** "Spiel beenden" -> Ja: autosave (single player, unless off), end the game, main menu */
  private async endGameToMenu(): Promise<void> {
    const g = this.host!;
    if (!g.multiplayer && this.settings.autosave > 0) await this.writeSpecial('autosave').catch(err => { console.error('Autosave fehlgeschlagen', err); return false; });
    this.leaveGame();
    this.mainMenu();
  }

  // ---------------------------------------------------------------- autosave / quicksave (3.9, 3.10)

  private autosaveClock(): void {
    const g = this.host;
    if (!g || !this.inGame || g.multiplayer || g.paused || this.fe.visible || this.settings.autosave <= 0) return;
    if (++this.playSeconds >= this.settings.autosave * 600) { this.playSeconds = 0; this.writeSpecial('autosave').catch(err => console.error('Autosave fehlgeschlagen', err)); }
  }

  /** slot 000 (autosave) / 001 (quicksave) as fixed ids */
  private async writeSpecial(kind: 'autosave' | 'quicksave'): Promise<boolean> {
    const save = this.host?.makeSave(this.s(kind === 'autosave' ? 313 : 314));
    if (!save) return false;
    save.id = kind;
    // the game's own record (free play: the final, re-rolled seed) wins over the session's start record
    if (this.session?.mission) save.missionData ??= this.session.mission;
    await saves.put(save);
    return true;
  }

  private async quicksave(): Promise<void> {
    toast(this.a, this.s(188));
    try { await requestPersistence(); await this.writeSpecial('quicksave'); } catch (err) { console.error('Schnellspeichern fehlgeschlagen', err); toast(this.a, `${this.s(234)} (${errText(err)})`); }
  }

  // ---------------------------------------------------------------- 3.9 settings

  settingsMenu(from: From): void {
    const back = () => (from === 'main' ? this.mainMenu() : this.optionsMenu());
    this.show([
      this.title(this.s(68)),
      this.button(R(230, 310, 565, 340), this.s(78), () => this.graphics(from)),
      this.button(R(230, 341, 565, 370), this.s(79), () => this.sound(from)),
      this.button(R(230, 371, 565, 400), this.s(287), () => this.controls(from)),
      this.button(R(230, 401, 565, 430), this.s(323), () => void this.deleteList(from)),
      // our addition: the optional "enhanced" comfort options (docs/roadmap.md)
      this.button(R(230, 431, 565, 460), 'Erweitert', () => this.enhanced(from)),
      this.back(R(340, 470, 460, 490), back),
    ], back);
  }

  /** graphics: the original's renderer switches do not apply in a browser; we offer full screen,
   *  alpha shadows (stored) and the side-panel scale instead */
  private graphics(from: From): void {
    const st = this.settings, again = () => this.graphics(from), back = () => this.settingsMenu(from);
    const onOff = (v: boolean) => this.s(v ? 80 : 81);
    const scale = getUiScale();
    const scaleText = scale === 0 ? 'Auto' : `${Math.round(scale * 100)} %`;
    this.show([
      this.title(this.s(88)),
      this.label(R(230, 320, 539, 350), 'Vollbild:'),
      this.value(R(540, 320, 585, 350), onOff(!!document.fullscreenElement), () => {
        const p = document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
        p.catch(() => {}).finally(() => setTimeout(again, 100));
      }),
      this.label(R(230, 350, 539, 380), this.s(90)),
      this.value(R(540, 350, 585, 380), onOff(st.alphaShadows), () => { st.alphaShadows = !st.alphaShadows; this.changed(); again(); }),
      this.label(R(230, 380, 439, 410), 'Bedienleiste:'),
      this.value(R(475, 380, 585, 410), scaleText, () => { setUiScale(UI_SCALES[(UI_SCALES.indexOf(scale) + 1) % UI_SCALES.length]); again(); }),
      // HD pack (our addition): upscaled menu and side-panel art
      this.label(R(230, 410, 539, 440), 'HD-Grafik:'),
      this.value(R(540, 410, 585, 440), onOff(st.hd), () => { st.hd = !st.hd; setHdEnabled(st.hd); this.changed(); again(); }),
      this.back(R(340, 470, 460, 490), back),
    ], back);
  }

  private sound(from: From): void {
    const st = this.settings, again = () => this.sound(from), back = () => this.settingsMenu(from);
    const w: Widget[] = [
      this.title(this.s(82), R(230, 250, 565, 279)),
      this.label(R(230, 300, 330, 320), this.s(79)),
      this.value(R(350, 300, 420, 320), this.s(st.soundOn ? 80 : 81), () => { st.soundOn = !st.soundOn; this.changed(); again(); }, 'L'),
    ];
    // three bars always drawn; sliders and EAX only while sound is on (3.9)
    const rows: [number, number, 'effects' | 'music' | 'speech'][] = [[84, 332, 'effects'], [85, 372, 'music'], [86, 412, 'speech']];
    for (const [id, by, key] of rows) {
      w.push(this.label(R(230, by + 8, key === 'effects' ? 350 : 330, by + 28), this.s(id)));
      w.push(new Image('SOUNDSLIDER', 340, by, this.fe));
      if (st.soundOn) w.push(new Slider(R(360, by + 10, 556, by + 40), by + 8, 0, 100, st[key], v => { st[key] = v; this.changed(); }));
    }
    if (st.soundOn) {
      w.push(this.label(R(230, 460, 330, 480), this.s(87)));
      w.push(this.value(R(350, 460, 420, 480), this.s(st.eax ? 80 : 81), () => { st.eax = !st.eax; this.changed(); again(); }, 'L'));
    }
    w.push(this.back(R(340, 500, 460, 520), back));
    this.show(w, back);
  }

  private controls(from: From): void {
    const st = this.settings, again = () => this.controls(from), back = () => this.settingsMenu(from);
    this.show([
      this.title(this.s(287)),
      this.label(R(220, 320, 539, 350), this.s(288)),
      this.value(R(520, 320, 570, 350), this.s(st.menuScroll ? 204 : 205), () => { st.menuScroll = !st.menuScroll; this.changed(); again(); }),
      this.label(R(220, 351, 539, 400), this.s(289)),
      this.value(R(420, 351, 570, 400), this.s(283 + st.autosave), () => { st.autosave = (st.autosave + 1) % 4; this.changed(); again(); }),
      this.back(R(340, 470, 460, 490), back),
    ], back);
  }

  /** "Erweitert" (our addition, not in the original): the enhanced-mode comfort options, all off
   *  by default (= the original). They change only the presentation, never the simulation; the
   *  running game re-reads them within a second (main.ts, overlay.ts), so they apply at once */
  private enhanced(from: From): void {
    const st = this.settings, again = () => this.enhanced(from), back = () => this.settingsMenu(from);
    const onOff = (v: boolean) => this.s(v ? 80 : 81);
    const rows: [string, 'selectionRings' | 'smoothMovement' | 'cursorHints' | 'advisorQueue' | 'smoothTerrain'][] = [
      ['Auswahlringe:', 'selectionRings'],
      ['Flüssige Bewegung:', 'smoothMovement'],
      ['Cursor-Hinweise:', 'cursorHints'],
      ['Berater-Warteschlange:', 'advisorQueue'],
      ['Glattes Gelände:', 'smoothTerrain'],
    ];
    const w: Widget[] = [
      this.title('Erweitert'),
      this.label(R(230, 300, 585, 329), 'Abweichend vom Original, wirken sofort. Aus = Original.', 'C', 'dv7pts2'),
    ];
    rows.forEach(([text, key], i) => {
      const y = 330 + i * 28;
      w.push(this.label(R(230, y, 539, y + 27), text));
      w.push(this.value(R(540, y, 585, y + 27), onOff(st[key]), () => { st[key] = !st[key]; this.changed(); again(); }));
    });
    w.push(this.back(R(340, 470, 460, 490), back));
    this.show(w, back);
  }

  // ---------------------------------------------------------------- 3.10 load, save and delete lists

  /** all saves: autosave, quicksave, then the player's saves (newest first) */
  private async saveInfos(): Promise<SaveInfo[]> {
    const all = await saves.list();
    const rank = (i: SaveInfo) => (i.id === 'autosave' ? 0 : i.id === 'quicksave' ? 1 : 2);
    return all.sort((a, b) => rank(a) - rank(b) || b.savedAt - a.savedAt);
  }

  private saveLine(i: SaveInfo): string {
    if (i.id === 'autosave' || i.id === 'quicksave') return i.name;
    const d = new Date(i.savedAt);
    const two = (n: number) => String(n).padStart(2, '0');
    return `${i.name}  ${two(d.getDate())}.${two(d.getMonth() + 1)}. ${two(d.getHours())}:${two(d.getMinutes())}`;
  }

  private listBox(onPick: (v: number) => void): ListBox { return new ListBox(R(265, 320, 550, 465), { onPick }).layout(this.a); }

  async loadList(from: From, exportMode = false): Promise<void> {
    let infos: SaveInfo[];
    try { infos = await this.saveInfos(); } catch (err) { this.fe.message(`Fehler: ${errText(err)}`); return; }
    const back = () => (from === 'main' ? this.mainMenu() : this.optionsMenu());
    const list = this.listBox(v => {
      const info = infos[v];
      if (exportMode) void saves.get(info.id).then(s => s && saves.exportFile(s));
      else void this.loadSave(info.id, from);
    });
    list.setLines(infos.map((i, k) => ({ text: this.saveLine(i), value: k })));
    // browser storage is not permanent: export / import .ansave files (our addition)
    this.show([
      this.title(exportMode ? 'Spielstand exportieren' : this.s(67)),
      list,
      this.back(R(340, 470, 460, 490), exportMode ? () => void this.loadList(from) : back),
      this.button(R(230, 505, 390, 525), 'Importieren', () => this.importSave(from)),
      this.button(R(410, 505, 570, 525), exportMode ? this.s(67) : 'Exportieren', () => void this.loadList(from, !exportMode)),
    ], back);
  }

  private importSave(from: From): void {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.ansave';
    inp.onchange = async () => {
      const f = inp.files?.[0];
      if (!f) return;
      try { await saves.importFile(f); await this.loadList(from); } catch (err) { this.fe.message(`Fehler: ${errText(err)}`); }
    };
    inp.click();
  }

  private async loadSave(id: string, from: From): Promise<void> {
    const fail = () => this.fe.message(this.s(235), () => (from === 'main' || !this.inGame ? this.mainMenu() : this.optionsMenu()));
    let save: SaveGame | undefined;
    try { save = await saves.get(id); } catch (err) { console.error('Spielstand lesen fehlgeschlagen', err); save = undefined; }
    if (!save) { fail(); return; }
    // add-on campaigns and island free play included (their ids end in -ao)
    const c = [...CAMPAIGNS, ...CAMPAIGNS_AO, FREEPLAY_AO].find(x => x.id === save.mission.campaign) ?? FREEPLAY_CAMPAIGN;
    this.loadingScreen(isAo(c));
    await nextPaint();
    try {
      const g = await this.ready;
      this.leaveGame();
      await g.loadSave(save);
      const kind: SessionKind = c.id === 'tutorials' ? 'tutorial' : c === FREEPLAY_CAMPAIGN || c === FREEPLAY_AO ? 'free' : 'campaign';
      this.session = { kind, campaign: c, index: save.mission.index, race: save.player, mission: save.missionData };
      this.music.resetPlaylist();
      this.enterGame();
    } catch (err) {
      console.error(err);
      this.inGame = false;
      this.fe.message(this.s(235), () => this.mainMenu());
    }
  }

  private async saveList(): Promise<void> {
    let infos: SaveInfo[];
    try { infos = (await this.saveInfos()).filter(i => i.id !== 'autosave' && i.id !== 'quicksave'); } catch (err) { this.fe.message(`Fehler: ${errText(err)}`); return; }
    const list = this.listBox(v => this.saveName(v < 0 ? null : infos[v]));
    list.setLines([{ text: this.s(77), value: -1 }, ...infos.map((i, k) => ({ text: this.saveLine(i), value: k }))]);
    const back = () => this.optionsMenu();
    this.show([this.title(this.s(71)), list, this.back(R(340, 470, 460, 490), back)], back);
  }

  /** save-name screen; `target` = existing save to overwrite, null = new */
  private saveName(target: SaveInfo | null): void {
    const edit: TextEdit = new TextEdit(227, 350, this.fe, target?.name ?? '', 20, C.brown, () => void this.doSave(edit.value, target));
    this.show([
      this.title(this.s(73)),
      edit,
      this.back(R(260, 420, 370, 470), () => void this.saveList()),
      this.button(R(410, 420, 550, 470), this.s(76), () => void this.doSave(edit.value, target)),
    ], () => void this.saveList());
  }

  private async doSave(name: string, target: SaveInfo | null): Promise<void> {
    this.show([this.label(R(230, 270, 565, 399), this.s(188), 'C')]);
    let failure = '';
    try {
      const save = this.host?.makeSave(name.trim() || this.s(72));
      if (!save) failure = 'kein laufendes Spiel';
      else {
        if (target) save.id = target.id;
        if (this.session?.mission) save.missionData ??= this.session.mission;
        await requestPersistence();
        await saves.put(save);
      }
    } catch (err) { console.error('Speichern fehlgeschlagen', err); failure = errText(err); }
    if (!failure) this.optionsMenu(); else this.fe.message(`${this.s(234)} (${failure})`, () => this.optionsMenu());
  }

  private async deleteList(from: From): Promise<void> {
    let infos: SaveInfo[];
    try { infos = await this.saveInfos(); } catch (err) { this.fe.message(`Fehler: ${errText(err)}`); return; }
    const back = () => this.settingsMenu(from);
    const list = this.listBox(v => this.fe.ask(this.s(324), () => void saves.remove(infos[v].id).then(() => this.deleteList(from))));
    list.setLines(infos.map((i, k) => ({ text: this.saveLine(i), value: k })));
    this.show([this.title(this.s(323)), list, this.back(R(340, 470, 460, 490), back)], back);
  }
}

// ---------------------------------------------------------------- helpers

export const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** resolves after the browser painted the current frame (so the loading screen is visible) */
export const nextPaint = () => new Promise<void>(r => requestAnimationFrame(() => setTimeout(r, 0)));

/** "Drucken" (3.6): print title and text on a simple page */
function printBriefing(title: string, text: string): void {
  const f = document.createElement('iframe');
  Object.assign(f.style, { position: 'fixed', width: '0', height: '0', border: '0', right: '0', bottom: '0' });
  document.body.append(f);
  const d = f.contentDocument!;
  const h = d.createElement('h1'), p = d.createElement('div');
  h.textContent = title;
  Object.assign(h.style, { font: '20px "Times New Roman", serif', textAlign: 'center' });
  p.textContent = text;
  Object.assign(p.style, { font: '16px "Times New Roman", serif', whiteSpace: 'pre-wrap' });
  d.body.append(h, p);
  f.contentWindow!.focus();
  f.contentWindow!.print();
  setTimeout(() => f.remove(), 1000);
}

/** short in-game message (quicksave), dv14pt with a dark shadow, 5 s */
let toastEl: HTMLCanvasElement | null = null, toastTimer = 0;
function toast(a: MenuAssets, text: string): void {
  const f = a.font('dv14pt');
  const w = f.measure(text) + 4, h = f.height + 2;
  toastEl ??= document.createElement('canvas');
  const c = toastEl;
  c.width = w; c.height = h;
  Object.assign(c.style, { position: 'fixed', left: `calc((100% - var(--hud-w, 0px)) / 2 - ${w}px)`, top: '48px', width: `${w * 2}px`, height: `${h * 2}px`, zIndex: '40', pointerEvents: 'none', imageRendering: 'pixelated' });
  const ctx = c.getContext('2d')!;
  f.draw(ctx, text, 2, 2, '#000');
  f.draw(ctx, text, 1, 1, '#ffe98a');
  document.body.append(c);
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => c.remove(), 5000);
}
