// Player-facing texts of the server / launcher (console, dialogs, --help) in German and English.
// The language: --lang de|en, else AN_LANG, else the system language (German for any German
// locale: de, de-DE, de-AT, de-CH, ...; English otherwise).
//
// System language without dependencies:
//   - Linux / macOS: the POSIX locale variables as gettext reads them (LANGUAGE, unless the locale
//     is C; then LC_ALL, LC_MESSAGES, LANG), else Intl (ICU reads the same variables).
//   - Windows: Intl, which ICU takes from the user's regional format. When that says en-US (also
//     ICU's fallback), the display language decides: PowerShell Get-UICulture, asked at most once.
//
// Text encoding: on a Windows console Node writes through WriteConsoleW (UTF-16), so umlauts show
// whatever the console code page is; the PowerShell dialogs get their texts through environment
// variables (UTF-16 as well, see launcher.ts), never inside the script.

import { spawnSync } from 'node:child_process';

export type Lang = 'de' | 'en';

const WIN = process.platform === 'win32';

/** 'de' / 'en' for a locale or language name ("de_AT.UTF-8", "de-CH", "German_Germany.1252",
 *  "en_US"), null when it names none ("", "C", "POSIX") */
export function langOfLocale(tag: string | undefined): Lang | null {
  const lang = (tag ?? '').trim().split(/[-_.@:]/)[0].toLowerCase();
  if (!lang || lang === 'c' || lang === 'posix') return null;
  return lang === 'de' || lang === 'gsw' || lang === 'deu' || lang === 'ger' || lang === 'german' || lang === 'deutsch' ? 'de' : 'en';
}

/** the value of --lang on a command line ('' when it is the last argument), undefined if absent */
export function langArg(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--lang') return argv[i + 1] ?? '';
    if (argv[i].startsWith('--lang=')) return argv[i].slice(7);
  }
  return undefined;
}

/** an explicit choice (--lang / AN_LANG): de or en, also "de-DE", "deutsch", "english";
 *  null for anything else (then the system language decides) */
export function explicitLang(v: string | undefined): Lang | null {
  const m = /^(de|en|deutsch|german|english)(?:[-_].*)?$/i.exec((v ?? '').trim());
  return m ? (/^(de|deutsch|german)$/i.test(m[1]) ? 'de' : 'en') : null;
}

/** the POSIX locale for messages as gettext determines it */
export function posixLocale(env: Record<string, string | undefined>): string | undefined {
  const locale = env.LC_ALL || env.LC_MESSAGES || env.LANG;
  if (!langOfLocale(locale)) return locale; // unset or C: LANGUAGE is ignored
  const first = (env.LANGUAGE ?? '').split(':').find(x => langOfLocale(x));
  return first || locale;
}

export interface LangInput {
  /** --lang value */
  arg?: string;
  env: Record<string, string | undefined>;
  platform: string;
  /** Intl.DateTimeFormat().resolvedOptions().locale */
  intlLocale?: string;
  /** Windows display language (Get-UICulture), asked only when needed */
  uiCulture?: () => string | undefined;
}

export function detectLang(input: LangInput): Lang {
  const chosen = explicitLang(input.arg) ?? explicitLang(input.env.AN_LANG);
  if (chosen) return chosen;
  if (input.platform !== 'win32') {
    const posix = langOfLocale(posixLocale(input.env));
    if (posix) return posix;
  }
  const intl = langOfLocale(input.intlLocale);
  if (intl === 'de') return 'de';
  if (input.platform === 'win32' && /^(en-US|und|)$/i.test(input.intlLocale ?? '') && input.uiCulture) {
    return langOfLocale(input.uiCulture()) ?? 'en';
  }
  return intl ?? 'en';
}

let uiCultureCache: string | undefined | null = null;

/** Windows display language via PowerShell (once per run; '' if PowerShell fails) */
export function windowsUiCulture(): string | undefined {
  if (uiCultureCache !== null) return uiCultureCache;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-UICulture).Name'],
                      { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  uiCultureCache = r.status === 0 && r.stdout ? r.stdout.trim() : undefined;
  return uiCultureCache;
}

export function intlLocale(): string | undefined {
  try { return Intl.DateTimeFormat().resolvedOptions().locale; } catch { return undefined; }
}

// ---- the texts ---------------------------------------------------------------------------------

const en = {
  // --help
  usage: (config: string) => `usage: AlienNations [options]          (or: node dist/server.mjs [options])

  --game <folder>    your Alien Nations install, the folder containing Data and Bin (env AN_GAME)
  --music <folder>   soundtrack folder if the game folder has none, e.g. <GOG install>/Bin/music (env AN_MUSIC)
  --hd <folder>      HD UI pack folder instead of the built-in one (env AN_HD)
  --port <n>         port, default 8080; without --port the next free one is taken if 8080 is busy (env AN_PORT)
  --host <address>   address to listen on, default 0.0.0.0 = this computer and the network (env AN_HOST);
                     127.0.0.1 = only this computer
  --setup, --reset   choose the game folder again (packaged builds remember it in ${config})
  --no-browser       do not open the browser
  --open             open the browser (plain node runs do not by default)
  --lang de|en       language of these texts, default: the system language (env AN_LANG)
  --version          print the version
`,
  unknownOption: (a: string) => `! unknown option ${a} (--help lists them)`,
  badPort: '! bad port, using 8080',
  badLang: (v: string) => `! unknown language "${v}", use de or en`,

  // choosing the game folder
  intro: 'Welcome to Alien Nations!\n\n'
    + 'This rebuild plays the game in your web browser. It needs the data files of your own copy of '
    + 'Alien Nations (GOG, or the CD / Gold Edition installed on this computer).\n\n'
    + 'Please choose the folder the game is installed in: the one that contains the folders "Data" and "Bin"'
    + (WIN ? ' (for example C:\\GOG Games\\Alien Nations).' : '.'),
  introFound: (dir: string) => `Found an installation here, it is pre-selected:\n${dir}`,
  notInstall: (dir: string) => `This folder is not an Alien Nations installation:\n${dir}\n\n`
    + 'It has no "Data" folder with the file dv.gd in it. Please choose the folder that contains "Data" and "Bin".',
  pickTitle: 'Choose your Alien Nations folder (the one that contains "Data" and "Bin")',
  chooseButton: 'Choose folder',
  quitButton: 'Quit',
  prompt: 'Game folder',
  notGameFolder: (dir: string) => `! not an Alien Nations folder: ${dir}`,
  savedGone: (dir: string) => `! The saved game folder is gone or changed: ${dir}`,
  foundAt: (dirs: string) => `found Alien Nations at ${dirs}`,
  saved: (file: string) => `Saved your choice in ${file} (start with --setup to choose again).`,
  saveFailed: (file: string, err: string) => `! could not save ${file}: ${err}`,
  noFolder: 'No game folder chosen, so the game cannot start. Run it again to choose the folder.',

  // starting the server
  soundtrack: (dir: string, n: number) => `soundtrack: ${dir} (${n} tracks)`,
  hdPack: (where: string) => `HD pack: ${where}`,
  builtIn: 'built in',
  noData: (dir: string) => `! No game data found in ${dir}\n`
    + '  Copy your Alien Nations install there (the folder containing Data/ and Bin/),\n'
    + '  or start with --game <folder>. The server keeps running and re-checks on request.',
  gameData: (dir: string, n: number) => `game data: ${dir} (${n} files)`,
  portNext: (port: number) => `port ${port} is in use, trying ${port + 1}`,
  portBusy: (port: number) => `! Port ${port} is already in use (is Alien Nations already running?). `
    + 'Close the other program or start with --port <another port>.',
  listenFailed: (where: string, err: string) => `! Cannot listen on ${where}: ${err}`,
  listening: (version: string, where: string) => `an-rebuild ${version} listening on ${where}`,
  playHere: 'Play on this computer:',
  listeningOn: 'Listening on:',
  friends: 'Friends on your network or VPN (Tailscale, ZeroTier, Hamachi) join at:',
  internet: (port: number) => `Over the internet: forward TCP port ${port} on your router to this computer.`,
  onlyHere: '(only this computer can connect; start with --host 0.0.0.0 to let friends join)',
  keepOpen: 'Keep this window open while you play. Close it (or press Ctrl+C) to stop the server.',
  ctrlC: 'Press Ctrl+C to stop the server.',
  noBrowser: (url: string) => `(could not open a browser, please open ${url} yourself)`,
  pressEnter: 'Press Enter to close this window.',
};

export type Strings = typeof en;

const de: Strings = {
  usage: (config: string) => `Aufruf: AlienNations [Optionen]          (oder: node dist/server.mjs [Optionen])

  --game <Ordner>    deine Alien-Nations-Installation, der Ordner mit Data und Bin (env AN_GAME)
  --music <Ordner>   Soundtrack-Ordner, falls der Spielordner keinen hat, z. B. <GOG-Installation>/Bin/music (env AN_MUSIC)
  --hd <Ordner>      HD-Oberflächenpaket aus diesem Ordner statt des eingebauten (env AN_HD)
  --port <n>         Port, Standard 8080; ohne --port wird der nächste freie genommen, wenn 8080 belegt ist (env AN_PORT)
  --host <Adresse>   Adresse, auf der der Server lauscht, Standard 0.0.0.0 = dieser Computer und das Netzwerk (env AN_HOST);
                     127.0.0.1 = nur dieser Computer
  --setup, --reset   den Spielordner neu wählen (die gepackte Version merkt ihn sich in ${config})
  --no-browser       den Browser nicht öffnen
  --open             den Browser öffnen (ein einfacher node-Start tut das sonst nicht)
  --lang de|en       Sprache dieser Texte, Standard: die Systemsprache (env AN_LANG)
  --version          die Version anzeigen
`,
  unknownOption: (a: string) => `! Unbekannte Option ${a} (--help zeigt alle)`,
  badPort: '! Ungültiger Port, verwende 8080',
  badLang: (v: string) => `! Unbekannte Sprache „${v}“, möglich sind de und en`,

  intro: 'Willkommen bei Alien Nations!\n\n'
    + 'Dieser Nachbau spielt das Spiel in deinem Webbrowser. Dafür braucht er die Spieldateien deiner '
    + 'eigenen Alien-Nations-Version (GOG oder die auf diesem Computer installierte CD- / Gold-Edition).\n\n'
    + 'Bitte wähle den Ordner, in dem das Spiel installiert ist: den mit den Ordnern „Data“ und „Bin“'
    + (WIN ? ' (zum Beispiel C:\\GOG Games\\Alien Nations).' : '.'),
  introFound: (dir: string) => `Hier wurde eine Installation gefunden, sie ist schon ausgewählt:\n${dir}`,
  notInstall: (dir: string) => `Dieser Ordner ist keine Alien-Nations-Installation:\n${dir}\n\n`
    + 'Er enthält keinen Ordner „Data“ mit der Datei dv.gd. Bitte wähle den Ordner, der „Data“ und „Bin“ enthält.',
  pickTitle: 'Wähle deinen Alien-Nations-Ordner (den mit „Data“ und „Bin“)',
  chooseButton: 'Ordner wählen',
  quitButton: 'Beenden',
  prompt: 'Spielordner',
  notGameFolder: (dir: string) => `! Kein Alien-Nations-Ordner: ${dir}`,
  savedGone: (dir: string) => `! Der gespeicherte Spielordner fehlt oder hat sich geändert: ${dir}`,
  foundAt: (dirs: string) => `Alien Nations gefunden: ${dirs}`,
  saved: (file: string) => `Deine Auswahl ist in ${file} gespeichert (mit --setup neu wählen).`,
  saveFailed: (file: string, err: string) => `! Konnte ${file} nicht speichern: ${err}`,
  noFolder: 'Kein Spielordner gewählt, daher kann das Spiel nicht starten. Starte es erneut, um den Ordner zu wählen.',

  soundtrack: (dir: string, n: number) => `Soundtrack: ${dir} (${n} Titel)`,
  hdPack: (where: string) => `HD-Paket: ${where}`,
  builtIn: 'eingebaut',
  noData: (dir: string) => `! Keine Spieldaten in ${dir} gefunden\n`
    + '  Kopiere deine Alien-Nations-Installation dorthin (den Ordner mit Data/ und Bin/)\n'
    + '  oder starte mit --game <Ordner>. Der Server läuft weiter und prüft bei jeder Anfrage erneut.',
  gameData: (dir: string, n: number) => `Spieldaten: ${dir} (${n} Dateien)`,
  portNext: (port: number) => `Port ${port} ist belegt, versuche ${port + 1}`,
  portBusy: (port: number) => `! Port ${port} ist schon belegt (läuft Alien Nations bereits?). `
    + 'Schließe das andere Programm oder starte mit --port <anderer Port>.',
  listenFailed: (where: string, err: string) => `! ${where} lässt sich nicht öffnen: ${err}`,
  listening: (version: string, where: string) => `an-rebuild ${version} läuft auf ${where}`,
  playHere: 'Auf diesem Computer spielen:',
  listeningOn: 'Erreichbar unter:',
  friends: 'Freunde im selben Netzwerk oder VPN (Tailscale, ZeroTier, Hamachi) spielen mit über:',
  internet: (port: number) => `Übers Internet: leite am Router den TCP-Port ${port} an diesen Computer weiter.`,
  onlyHere: '(nur dieser Computer kann sich verbinden; mit --host 0.0.0.0 können Freunde mitspielen)',
  keepOpen: 'Lass dieses Fenster offen, solange du spielst. Schließe es (oder drücke Strg+C), um den Server zu beenden.',
  ctrlC: 'Strg+C beendet den Server.',
  noBrowser: (url: string) => `(Konnte keinen Browser öffnen, bitte öffne ${url} selbst)`,
  pressEnter: 'Drücke die Eingabetaste, um dieses Fenster zu schließen.',
};

export const STRINGS: Record<Lang, Strings> = { en, de };

let input: LangInput | null = null;
let current: Lang | null = null;

/** where the language comes from (main.ts, before the first text); detection waits until a
 *  text is needed, so --version never starts PowerShell */
export function configureLang(i: LangInput): void { input = i; current = null; }

export function setLang(lang: Lang): void { current = lang; }

export function getLang(): Lang {
  current ??= detectLang(input ?? { env: process.env, platform: process.platform, intlLocale: intlLocale() });
  return current;
}

/** the texts in the current language */
export function tr(): Strings { return STRINGS[getLang()]; }

/** a --lang / AN_LANG value that is neither de nor en (for a warning), else null */
export function badLangValue(arg: string | undefined, env: Record<string, string | undefined>): string | null {
  if (arg !== undefined && !explicitLang(arg)) return arg;
  if (arg === undefined && env.AN_LANG && !explicitLang(env.AN_LANG)) return env.AN_LANG;
  return null;
}
