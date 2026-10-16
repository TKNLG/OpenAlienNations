// Multiplayer setup screens (docs/ui/front-end.md 3.13) on top of our own lobby protocol
// (docs/architecture/multiplayer.md): player name -> session list (-> password) -> new session
// (-> password) -> race selection -> chat lobby -> start. The connection screen (3.13.2) is
// skipped: there is only one way to connect.
//
// The server keeps the race each member has claimed and the host's choice for the races nobody
// claims (computer player or nobody); the start message carries one seat per race, from which
// every client builds the identical free-play record (freeplay.ts mpMission). Our extensions
// beyond the original: computer players, starting before the session is full, passwords.

import type { GameSetup, RoomInfo, Seat, ServerMsg } from '../../net/protocol.ts';
import { RACES } from '../../net/protocol.ts';
import { NetClient } from '../net.ts';
import { format } from '../../formats/tdb.ts';
import type { Mission } from '../../formats/mission.ts';
import { FREEPLAY_AO, type Campaign } from '../data.ts';
import { C, Label, ListBox, R, SpriteButton, TextEdit, type ListLine, type Widget } from './widgets.ts';
import { mpDefaults, mpMission, randomSeed, slotRaces, SIZE_BITS, FREEPLAY_CAMPAIGN, type FreePlayParams } from './freeplay.ts';
import { errText, type FrontEndApp, type GameHost } from './app.ts';

type View = 'name' | 'sessions' | 'join-password' | 'new' | 'new-password' | 'race' | 'chat' | null;

/** texts without a DV.tdb string (our additions) */
const T = {
  password: 'Passwort',
  passwordOptional: 'Passwort (optional)',
  passwordHint: 'Leer lassen für ein offenes Spiel',
  passwordWrong: 'Falsches Passwort!',
  locked: 'Passwort',
  computer: 'Computer',
  empty: 'Leer',
};

export class Multiplayer {
  private app: FrontEndApp;
  private net: NetClient | null = null;
  private name = '';
  private params: FreePlayParams = mpDefaults();
  private sessionName = '';
  private password = '';
  private rooms: RoomInfo[] = [];
  private room: RoomInfo | null = null;
  private you = -1;
  private announced = new Set<string>();
  private chat: ListLine[] = [];
  private draft = '';
  private view: View = null;
  private refresh = 0;
  private lastWaiting = -1;
  /** the free-play records (Infinite.mdb / InfiniteAO.mdb), loaded while the lobby is open so
   *  the start message can be answered at once */
  private bases = new Map<string, Mission[]>();

  constructor(app: FrontEndApp) {
    this.app = app;
    try { this.name = localStorage.getItem('an.name') ?? ''; } catch { /* storage unavailable */ }
  }

  private get s() { return (id: number) => this.app.s(id); }

  /** "Mehrspielermodus": multiplayer defaults (6.1), then the name screen */
  start(): void {
    this.params = mpDefaults();
    this.sessionName = this.s(107);
    this.password = '';
    this.nameScreen();
  }

  /** leave the session (main menu, Zurück in the lobby, end of game) */
  leave(): void {
    if (this.room) this.net?.send({ t: 'leave' });
    this.resetRoom();
    this.setView(null);
  }

  private resetRoom(): void {
    this.room = null; this.you = -1;
    this.announced.clear(); this.chat = []; this.lastWaiting = -1;
  }

  private setView(v: View): void {
    this.view = v;
    clearInterval(this.refresh);
    if (v === 'sessions') this.refresh = window.setInterval(() => this.net?.send({ t: 'list' }), 7000); // 3.13.3
  }

  /** my claimed race in the room, -1 = none */
  private get myRace(): number { return this.room?.players.find(p => p.slot === this.you)?.race ?? -1; }
  private get isHost(): boolean { return this.you === 0; }

  // ---------------------------------------------------------------- 3.13.1 player name

  private nameScreen(): void {
    this.setView('name');
    const app = this.app;
    const go = () => void this.connect(edit.value.trim() || this.s(72));
    const edit: TextEdit = new TextEdit(227, 350, app.fe, this.name, 20, C.black, go);
    app.show([
      app.title(this.s(91)),
      edit,
      app.back(R(260, 420, 370, 470), () => app.mainMenu()),
      app.button(R(410, 420, 550, 470), this.s(92), go),
    ], () => app.mainMenu());
  }

  private async connect(name: string): Promise<void> {
    this.name = name;
    try { localStorage.setItem('an.name', name); } catch { /* storage unavailable */ }
    try {
      if (!this.net) { this.net = new NetClient(); this.net.on(m => this.onMessage(m)); }
      await this.net.connect(name);
      this.net.send({ t: 'hello', name }); // also when the socket was already open (new name)
    } catch {
      this.app.fe.message(this.s(99));
      return;
    }
    this.sessions();
  }

  // ---------------------------------------------------------------- 3.13.3 session list

  private sessions(): void {
    this.setView('sessions');
    this.net?.send({ t: 'list' });
    this.drawSessions();
  }

  private drawSessions(): void {
    const app = this.app;
    const list = new ListBox(R(250, 320, 550, 400), { color: C.black, onPick: i => this.join(i) }).layout(app.a);
    // protected sessions are marked (our addition)
    list.setLines(this.rooms.map((r, i) => ({ text: `${r.name} (${r.players.length}/${r.maxPlayers})${r.locked ? ` - ${T.locked}` : ''}`, value: i })));
    const back = () => this.nameScreen();
    app.show([
      app.title(this.s(100)),
      list,
      app.button(R(250, 420, 340, 470), this.s(74), () => this.newSession()),
      app.button(R(410, 420, 600, 470), this.s(101), () => this.net?.send({ t: 'list' })),
      app.back(R(340, 450, 460, 500), back),
    ], back);
  }

  private join(i: number): void {
    const r = this.rooms[i];
    if (!r) return;
    if (r.locked) this.joinPassword(r);
    else this.net?.send({ t: 'join', room: r.id });
  }

  /** password of a protected session: the name-screen layout (3.13.1) with a masked edit */
  private joinPassword(r: RoomInfo): void {
    this.setView('join-password');
    const app = this.app;
    const go = () => this.net?.send({ t: 'join', room: r.id, password: edit.value });
    const edit: TextEdit = new TextEdit(227, 350, app.fe, '', 20, C.black, go);
    edit.mask = true;
    const back = () => this.sessions();
    app.show([
      app.title(T.password),
      app.label(R(220, 305, 580, 335), r.name, 'C'),
      edit,
      app.back(R(260, 420, 370, 470), back),
      app.button(R(410, 420, 550, 470), this.s(92), go),
    ], back);
  }

  // ---------------------------------------------------------------- 3.13.4 new session

  private newSession(): void {
    this.setView('new');
    const app = this.app, p = this.params;
    const edit: TextEdit = new TextEdit(227, 315, app.fe, this.sessionName, 15, C.black, () => { this.sessionName = edit.value; }, true);
    const keep = () => { this.sessionName = edit.value || this.s(107); };
    const players = (d: number) => { keep(); p.players = Math.max(2, Math.min(3, p.players + d)); this.newSession(); };
    const back = () => this.sessions();
    app.show([
      app.title(this.s(108), R(230, 240, 565, 270)),
      app.label(R(220, 285, 565, 315), this.s(109), 'C'),
      edit,
      app.label(R(220, 382, 565, 412), this.s(110), 'C'),
      new SpriteButton('PFEIL-LINKS', 310, 410, app.fe, () => players(-1)),
      new Label(R(380, 425, 400, 445), String(p.players), 'dv18pt', C.brown),
      new SpriteButton('PFEIL-RECHTS', 430, 410, app.fe, () => players(1)),
      app.button(R(220, 475, 565, 490), this.s(293), () => { keep(); app.worldParams('mp', p, () => this.newSession()); }),
      app.back(R(260, 500, 370, 530), back),
      app.button(R(410, 500, 550, 530), this.s(92), () => { keep(); this.newPassword(); }),
    ], back);
  }

  /** optional session password (our addition): the name-screen layout; empty = open session */
  private newPassword(): void {
    this.setView('new-password');
    const app = this.app;
    const go = () => { this.password = edit.value; this.create(); };
    const edit: TextEdit = new TextEdit(227, 350, app.fe, this.password, 20, C.black, go);
    edit.mask = true;
    const back = () => { this.password = edit.value; this.newSession(); };
    app.show([
      app.title(T.passwordOptional),
      app.label(R(220, 305, 580, 335), T.passwordHint, 'C'),
      edit,
      app.back(R(260, 420, 370, 470), back),
      app.button(R(410, 420, 550, 470), this.s(92), go),
    ], back);
  }

  /** create the session; the host draws the terrain seed here (3.13.4) and sends all four
   *  world parameters and the add-on flag (the original sent size, seed and the AO flag, 8,
   *  addon.md 11.5) */
  private create(): void {
    const p = this.params;
    this.net?.send({
      t: 'create', name: this.sessionName || this.s(107), maxPlayers: p.players, password: this.password,
      setup: { mode: 'random', seed: randomSeed(), sizeBits: SIZE_BITS[p.size], resources: p.resources, development: p.development, stock: p.stock, addon: !!p.addon },
    });
  }

  // ---------------------------------------------------------------- 3.13.5 race selection

  /** clicking a free race sends the claim; the chat lobby opens when the server confirms it */
  private raceScreen(): void {
    this.setView('race');
    const taken = new Set<number>();
    for (const p of this.room?.players ?? []) if (p.slot !== this.you && p.race >= 0) taken.add(p.race);
    const back = () => { this.leave(); this.sessions(); };
    const pick = (race: number) => this.net?.send({ t: 'race', race });
    this.app.show(this.app.raceWidgets(227, pick, back, taken), back, this.room?.setup.addon ? 'RASSENWAHLAO' : 'RASSENWAHL');
  }

  // ---------------------------------------------------------------- 3.13.6 chat lobby

  private chatScreen(): void {
    this.setView('chat');
    const app = this.app;
    // the log is 6 lines shorter than the original's (250,260)-(550,420): the seat rows below it
    const log = new ListBox(R(250, 260, 550, 356), { onPick: null, color: C.black, align: 'L', spacing: 1.0 }).layout(app.a);
    const f = app.a.font('dv7pts2');
    const lines: ListLine[] = [];
    for (const l of this.chat) for (const t of f.wrap(l.text, 300 - 18)) lines.push({ text: t, value: 0, marked: l.marked });
    log.setLines(lines);
    log.scrollTo(log.maxTop);
    const send = () => {
      const t = edit.value.trim();
      if (t) this.net?.send({ t: 'chat', text: t });
      this.draft = edit.value = '';
      app.fe.redraw();
    };
    const edit: TextEdit = new TextEdit(227, 430, app.fe, this.draft, 30, C.black, send);
    const back = () => { this.leave(); this.sessions(); };
    const start = app.button(R(400, 500, 580, 520), this.s(115), () => this.net?.send({ t: 'start' }));
    start.visible = this.isHost && this.startable(); // host only (3.13.6), once everybody present has a race
    app.show([
      app.title(this.s(121), R(230, 240, 565, 259)),
      log, ...this.seatRows(), edit,
      app.back(R(260, 500, 370, 520), back),
      start,
    ], back, 'MAINMENU', () => { this.draft = edit.value; });
  }

  /** one row per race (our addition): race name, then the player who claimed it, or what plays it
   *  otherwise: "Computer" / "Leer", a toggle for the host (value-button style of 3.7) */
  private seatRows(): Widget[] {
    const app = this.app, room = this.room;
    if (!room) return [];
    const rows: Widget[] = [];
    for (let race = 0; race < RACES; race++) {
      const y = 360 + race * 20, p = room.players.find(q => q.race === race);
      rows.push(app.label(R(250, y, 400, y + 20), this.s(116 + race), 'L', 'dv14pt'));
      const text = p ? p.name : room.computer[race] ? T.computer : T.empty;
      if (!p && this.isHost) {
        rows.push(app.value(R(400, y, 550, y + 20), text, () => {
          const computer = [...room.computer];
          computer[race] = !computer[race];
          this.net?.send({ t: 'seats', computer });
        }));
      } else {
        rows.push(new Label(R(400, y, 550, y + 20), text, 'dv14pt', p ? C.brown : C.black, 'R'));
      }
    }
    return rows;
  }

  /** every member has a race and at least two races play */
  private startable(): boolean {
    const r = this.room;
    if (!r || r.players.some(p => p.race < 0)) return false;
    let n = 0;
    for (let race = 0; race < RACES; race++) if (r.players.some(p => p.race === race) || r.computer[race]) n++;
    return n >= 2;
  }

  private say(text: string, marked = false): void { this.chat.push({ text, value: 0, marked }); if (this.chat.length > 200) this.chat.shift(); }

  private playerName(slot: number): string { return this.room?.players.find(p => p.slot === slot)?.name ?? '?'; }

  /** "Warte auf %d Spieler" / "Alle Spieler komplett!" when the count changes */
  private waitLine(): void {
    const r = this.room;
    if (!r) return;
    const missing = r.maxPlayers - r.players.length;
    if (missing === this.lastWaiting) return;
    this.lastWaiting = missing;
    this.say(missing > 0 ? format(this.s(123), missing) : this.s(124));
  }

  // ---------------------------------------------------------------- messages

  private onMessage(m: ServerMsg): void {
    switch (m.t) {
      case 'rooms':
        this.rooms = m.rooms;
        if (this.view === 'sessions') this.drawSessions();
        break;
      case 'room': {
        const before = this.room?.players ?? [];
        const first = !this.room;
        this.room = m.room; this.you = m.you;
        if (first) {
          this.chat = []; this.announced.clear(); this.lastWaiting = -1; this.say(this.s(122));
          this.preload(m.room.setup);
        }
        for (const p of before) if (!m.room.players.some(q => q.name === p.name)) this.say(format(this.s(120), p.name));
        for (const p of m.room.players) {
          const key = `${p.name}|${p.race}`;
          if (p.race >= 0 && !this.announced.has(key)) { this.announced.add(key); this.say(format(this.s(119), p.name, this.s(116 + p.race))); }
        }
        this.waitLine();
        if (this.myRace < 0) { if (first || this.view === 'race' || this.view === 'chat' || this.view === 'join-password' || this.view === 'new-password') this.raceScreen(); }
        else if (this.view === 'race' || this.view === 'chat') this.chatScreen();
        break;
      }
      case 'left':
        this.resetRoom();
        break;
      case 'chat':
        this.say(`${m.name}: ${m.text}`);
        if (this.view === 'chat') this.chatScreen();
        break;
      case 'error':
        if (!this.view) break;
        if (m.code === 'password') this.app.fe.message(T.passwordWrong);
        else if (m.code === 'room' || m.code === 'full') this.app.fe.message(this.s(103), () => this.sessions());
        else if (m.code === 'race') { if (this.view === 'race') this.raceScreen(); this.app.fe.message(this.s(114)); }
        else this.app.fe.message(m.message || this.s(103));
        break;
      case 'start':
        this.startGame(m.setup, m.players, m.you, m.seats ?? []);
        break;
      case 'gone':
        if (this.room) this.say(format(this.s(194), this.playerName(m.slot)));
        break;
    }
  }

  private campaignOf(setup: GameSetup): Campaign { return setup.addon ? FREEPLAY_AO : FREEPLAY_CAMPAIGN; }

  /** load the free-play records while the players are still in the lobby */
  private preload(setup: GameSetup): void {
    if (setup.mode !== 'random') return;
    const c = this.campaignOf(setup);
    if (!this.bases.has(c.id)) void this.app.missions(c).then(ms => { this.bases.set(c.id, ms); }).catch(() => { /* reported at the start */ });
  }

  /**
   * Everybody goes to the loading screen; the game listens to the net from the first moment
   * (messages arriving while the records load are kept and handed over first). Every client
   * builds the same record from the start message alone: setup + seats (freeplay.ts mpMission).
   */
  private startGame(setup: GameSetup, players: number, you: number, seats: Seat[]): void {
    const app = this.app, net = this.net!;
    const early: ServerMsg[] = [];
    const stopEarly = net.on(m => early.push(m));
    const relay = {
      send: net.send.bind(net),
      on: (l: (m: ServerMsg) => void) => { stopEarly(); for (const m of early.splice(0)) l(m); return net.on(l); },
    };
    const random = setup.mode === 'random' && seats.length > 0;
    const c = this.campaignOf(setup);
    this.setView(null);
    app.loadingScreen(random && !!setup.addon);
    const run = async (g: GameHost) => {
      if (random) {
        const base = (this.bases.get(c.id) ?? await app.missions(c))[0];
        await g.startLockstep(c, mpMission(base, setup, seats), slotRaces(seats), you, relay);
      } else {
        // a campaign-mission room (developer lobby in main.ts): the old path
        stopEarly();
        await g.startMultiplayer(setup, players, you, net);
      }
    };
    const go = (g: GameHost) => run(g)
      .then(() => app.enterMultiplayerGame(random ? c : undefined))
      .catch(err => { stopEarly(); console.error(err); app.fe.message(`Fehler: ${errText(err)}`, () => app.mainMenu()); });
    const now = app.hostNow();
    if (now) { now.endGame(); now.hidden = true; void go(now); } else void app.game().then(g => go(g));
  }
}
