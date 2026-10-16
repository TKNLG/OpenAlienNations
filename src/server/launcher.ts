// Launcher for the packaged builds (the single .exe / Linux binary): finds the player's Alien
// Nations install, asks for it once (native folder picker on Windows, zenity / kdialog or the
// terminal on Linux), remembers it in a per-user config file, prints the URLs and opens the
// browser. No dependencies: the dialogs are PowerShell / zenity / kdialog child processes.
// Texts in German or English (i18n.ts).
//
// Config file: %APPDATA%\OpenAlienNations\config.json (Windows),
// $XDG_CONFIG_HOME/openaliennations/config.json or ~/.config/openaliennations/config.json (Linux),
// ~/Library/Application Support/OpenAlienNations/config.json (macOS). Builds from before the
// rename used the folder AlienNations / aliennations; its config is copied over once
// (migrateConfig) when the new one does not exist yet.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { homedir, networkInterfaces } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { tr } from './i18n.ts';

export interface LauncherConfig { game?: string; music?: string; }

const WIN = process.platform === 'win32';

// ---- config file ---------------------------------------------------------------------------

/** the per-user config file; `folder` is the app folder name (lower-cased on Linux) */
function configFile(env: Record<string, string | undefined>, platform: string, folder: string): string {
  const home = env.HOME || env.USERPROFILE || homedir();
  if (platform === 'win32') return join(env.APPDATA || join(home, 'AppData', 'Roaming'), folder, 'config.json');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', folder, 'config.json');
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), folder.toLowerCase(), 'config.json');
}

export function configPath(env: Record<string, string | undefined> = process.env, platform = process.platform): string {
  return configFile(env, platform, 'OpenAlienNations');
}

/** where builds from before the rename to OpenAlienNations kept the config */
export function legacyConfigPath(env: Record<string, string | undefined> = process.env, platform = process.platform): string {
  return configFile(env, platform, 'AlienNations');
}

/** Copy the old config (legacyConfigPath) to the new place once, when only the old one exists.
 *  The old file is left as it is. Returns true when it copied. */
export function migrateConfig(file = configPath(), legacy = legacyConfigPath()): boolean {
  if (existsSync(file) || !existsSync(legacy)) return false;
  const cfg = loadConfig(legacy);
  if (!cfg.game) return false;
  try { saveConfig(cfg, file); return true; } catch { return false; }
}

export function loadConfig(file = configPath()): LauncherConfig {
  try {
    const c = JSON.parse(readFileSync(file, 'utf8')) as LauncherConfig;
    return {
      game: typeof c.game === 'string' ? c.game : undefined,
      music: typeof c.music === 'string' ? c.music : undefined,
    };
  } catch { return {}; }
}

export function saveConfig(cfg: LauncherConfig, file = configPath()): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
}

// ---- recognising an install ----------------------------------------------------------------

/** case-insensitive child of a folder, or null */
function child(dir: string, name: string, kind: 'dir' | 'file'): string | null {
  let names: string[];
  try { names = readdirSync(dir); } catch { return null; }
  for (const n of names) {
    if (n.toLowerCase() !== name.toLowerCase()) continue;
    const p = join(dir, n);
    try {
      const st = statSync(p);
      if (kind === 'dir' ? st.isDirectory() : st.isFile()) return p;
    } catch { /* unreadable */ }
  }
  return null;
}

function isGameRoot(dir: string): boolean {
  const data = child(dir, 'Data', 'dir');
  return data !== null && child(data, 'dv.gd', 'file') !== null;
}

/** The install folder (the one containing Data/dv.gd and Bin) for a folder the player picked.
 *  Forgiving: the Data or Bin folder itself, or a parent with an "Alien Nations" folder, work too. */
export function findGameRoot(picked: string): string | null {
  if (!picked) return null;
  const p = resolve(picked);
  const tries = [p];
  if (/^(data|bin)$/i.test(basename(p))) tries.push(dirname(p));
  for (const n of ['Alien Nations', 'Die Voelker', 'Die Völker']) { const c = child(p, n, 'dir'); if (c) tries.push(c); }
  return tries.find(isGameRoot) ?? null;
}

/** <game>/Bin/music when it holds soundtrack files, else '' */
function musicOf(game: string): string {
  const bin = child(game, 'Bin', 'dir');
  const music = bin && child(bin, 'music', 'dir');
  if (!music) return '';
  try { return readdirSync(music).some(n => /\.(ogg|mp3|flac|wav)$/i.test(n)) ? music : ''; } catch { return ''; }
}

/** The soundtrack folder: the game's own Bin/music, else that of another detected install (a Gold
 *  Edition played its music from the CD; a GOG install next to it has the tracks). '' if none. */
export function findMusic(game: string, installs: string[]): string {
  for (const g of [game, ...installs]) { const m = musicOf(g); if (m) return m; }
  return '';
}

/** registry values under a key (recursively), grouped by key: [{ name: value }] */
function regQuery(key: string): Record<string, string>[] {
  const r = spawnSync('reg', ['query', key, '/s'], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 << 20 });
  if (r.status !== 0 || !r.stdout) return [];
  const out: Record<string, string>[] = [];
  let cur: Record<string, string> | null = null;
  for (const line of r.stdout.split(/\r?\n/)) {
    if (/^HKEY_/.test(line)) { cur = {}; out.push(cur); continue; }
    const m = /^\s{2,}(.+?)\s{2,}REG_(?:SZ|EXPAND_SZ)\s{2,}(.*)$/.exec(line);
    if (m && cur) cur[m[1].toLowerCase()] = m[2].trim();
  }
  return out;
}

const NAME = /alien\s*nations|v(?:ö|oe|o)lker/i;

/** installs found on this computer, most likely first (only folders that pass findGameRoot) */
export function detectInstalls(): string[] {
  const found: string[] = [];
  const add = (p: string | undefined) => {
    const root = p ? findGameRoot(p) : null;
    if (root && !found.some(f => f.toLowerCase() === root.toLowerCase())) found.push(root);
  };
  const home = homedir();
  if (WIN) {
    for (const k of ['HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\Games', 'HKLM\\SOFTWARE\\GOG.com\\Games']) {
      for (const v of regQuery(k)) if (NAME.test(v.gamename ?? '')) add(v.path);
    }
    for (const k of ['HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
                     'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
                     'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall']) {
      for (const v of regQuery(k)) if (NAME.test(v.displayname ?? '')) add(v.installlocation);
    }
    const rel = ['GOG Games\\Alien Nations', 'GOG Galaxy\\Games\\Alien Nations', 'Games\\Alien Nations',
                 'Program Files (x86)\\GOG Galaxy\\Games\\Alien Nations', 'Program Files (x86)\\GOG.com\\Alien Nations',
                 'Program Files (x86)\\Steam\\steamapps\\common\\Alien Nations', 'Program Files\\Alien Nations',
                 'Program Files (x86)\\Alien Nations', 'Program Files (x86)\\JoWooD\\Alien Nations',
                 'Program Files (x86)\\JoWooD\\Die Völker', 'Spiele\\Die Völker'];
    for (const d of 'CDEFGH') for (const r of rel) add(`${d}:\\${r}`);
  } else {
    const rel = ['GOG Games/Alien Nations', 'Games/Alien Nations', 'Games/alien-nations/drive_c/GOG Games/Alien Nations',
                 '.wine/drive_c/GOG Games/Alien Nations', '.wine/drive_c/Program Files (x86)/GOG Galaxy/Games/Alien Nations',
                 '.local/share/Steam/steamapps/common/Alien Nations', '.steam/steam/steamapps/common/Alien Nations'];
    for (const r of rel) add(join(home, r));
  }
  return found;
}

// ---- asking the player ---------------------------------------------------------------------

/** what to ask: the dialog text, the shorter terminal text (the prompt shows the pre-selection),
 *  the pre-selected folder, and whether it follows a wrong pick */
interface Prompt { text: string; terminal: string; initial: string; error: boolean; }

function introPrompt(detected: string): Prompt {
  const s = tr();
  return { text: detected ? `${s.intro}\n\n${s.introFound(detected)}` : s.intro, terminal: s.intro, initial: detected, error: false };
}

function retryPrompt(picked: string): Prompt {
  const text = tr().notInstall(picked);
  return { text, terminal: text, initial: picked, error: true };
}

type Ask = (p: Prompt) => Promise<string | null | 'unavailable'>;

/** PowerShell command line argument: the script as UTF-16LE base64 (-EncodedCommand) */
export function encodePowerShell(script: string): string {
  let bin = '';
  for (let i = 0; i < script.length; i++) { const c = script.charCodeAt(i); bin += String.fromCharCode(c & 0xff, c >> 8); }
  return btoa(bin);
}

/** The WinForms dialogs: a message box, then FolderBrowserDialog. The script is ASCII only; all
 *  texts and paths come in through environment variables (UTF-16 on Windows, no quoting: German
 *  typographic quotes would end a PowerShell string), the chosen path goes out as UTF-8 base64 so
 *  the console code page cannot garble it. Output: "PATH:<base64>" or "CANCEL". */
export const WINDOWS_DIALOG_SCRIPT = [
  'Add-Type -AssemblyName System.Windows.Forms',
  '[System.Windows.Forms.Application]::EnableVisualStyles()',
  '$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }',
  "$icon = if ($env:AN_DLG_ERROR -eq '1') { 'Warning' } else { 'Information' }",
  "$r = [System.Windows.Forms.MessageBox]::Show($owner, $env:AN_DLG_TEXT, 'OpenAlienNations', 'OKCancel', $icon)",
  "if ($r -ne 'OK') { 'CANCEL'; exit }",
  '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
  '$d.Description = $env:AN_DLG_TITLE',
  '$d.ShowNewFolderButton = $false',
  'if ($env:AN_DLG_PATH) { $d.SelectedPath = $env:AN_DLG_PATH }',
  "if ($d.ShowDialog($owner) -eq 'OK') { 'PATH:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($d.SelectedPath)) } else { 'CANCEL' }",
].join('\n');

export function windowsDialogEnv(p: Prompt, title: string): Record<string, string> {
  return { AN_DLG_TEXT: p.text, AN_DLG_TITLE: title, AN_DLG_PATH: p.initial, AN_DLG_ERROR: p.error ? '1' : '0' };
}

/** the dialog script's output -> chosen folder, null = cancelled, 'unavailable' = something else */
export function parseWindowsDialogOutput(stdout: string): string | null | 'unavailable' {
  const out = stdout.trim();
  if (out.startsWith('PATH:')) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(out.slice(5).trim()), c => c.charCodeAt(0))); }
    catch { return 'unavailable'; }
  }
  return out === 'CANCEL' ? null : 'unavailable';
}

const askWindows: Ask = async p => {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA',
                                         '-EncodedCommand', encodePowerShell(WINDOWS_DIALOG_SCRIPT)],
                      { encoding: 'utf8', env: { ...process.env, ...windowsDialogEnv(p, tr().pickTitle) } }); // no windowsHide: it can hide the dialogs too
  if (r.error || r.status !== 0) return 'unavailable';
  return parseWindowsDialogOutput(r.stdout);
};

function has(cmd: string): boolean {
  const r = spawnSync(cmd, ['--version'], { encoding: 'utf8', stdio: 'ignore' });
  return !r.error;
}

/** zenity --text is Pango markup */
const markup = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const askZenity: Ask = async p => {
  const s = tr();
  const r1 = spawnSync('zenity', ['--question', '--title=OpenAlienNations', `--text=${markup(p.text)}`, '--width=460',
                                  `--ok-label=${s.chooseButton}`, `--cancel-label=${s.quitButton}`],
                       { encoding: 'utf8' });
  if (r1.error || (r1.status !== 0 && r1.status !== 1)) return 'unavailable';
  if (r1.status === 1) return null;
  const r2 = spawnSync('zenity', ['--file-selection', '--directory', `--title=${s.pickTitle}`,
                                  ...(p.initial ? [`--filename=${p.initial}/`] : [])], { encoding: 'utf8' });
  if (r2.error || (r2.status !== 0 && r2.status !== 1)) return 'unavailable';
  return r2.status === 0 ? r2.stdout.replace(/\r?\n$/, '') : null;
};

const askKdialog: Ask = async p => {
  const s = tr();
  const r1 = spawnSync('kdialog', ['--title', 'OpenAlienNations', '--yes-label', s.chooseButton, '--no-label', s.quitButton, '--yesno', p.text],
                       { encoding: 'utf8' });
  if (r1.error || (r1.status !== 0 && r1.status !== 1)) return 'unavailable';
  if (r1.status === 1) return null;
  const r2 = spawnSync('kdialog', ['--title', s.pickTitle, '--getexistingdirectory', p.initial || homedir()], { encoding: 'utf8' });
  if (r2.error || (r2.status !== 0 && r2.status !== 1)) return 'unavailable';
  return r2.status === 0 ? r2.stdout.replace(/\r?\n$/, '') : null;
};

/** terminal prompt (also reads piped input). Returns null at end of input. */
function terminalAsker(): { ask: Ask; close(): void } {
  let it: AsyncIterator<string> | null = null;
  let rl: ReturnType<typeof createInterface> | null = null;
  let shownIntro = false;
  return {
    ask: async ({ terminal, initial, error }) => {
      if (!rl) { rl = createInterface({ input: (process as unknown as { stdin: unknown }).stdin, terminal: false }); it = rl[Symbol.asyncIterator](); }
      if (!shownIntro || error) console.log('\n' + terminal + '\n');
      shownIntro = true;
      for (;;) {
        process.stdout.write(`${tr().prompt}${initial ? ` [${initial}]` : ''}: `);
        const r = await it!.next();
        if (r.done) { process.stdout.write('\n'); return null; }
        if (!process.stdin.isTTY) process.stdout.write(r.value + '\n'); // piped input: show what was read
        let a = r.value.trim().replace(/^(["'])(.*)\1$/, '$2');
        if (a.startsWith('~')) a = join(homedir(), a.slice(1));
        if (a) return a;
        if (initial) return initial;
      }
    },
    close: () => { rl?.close(); rl = null; },
  };
}

export function hasGui(): boolean {
  return WIN || process.platform === 'darwin' || !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

/** Ask until the player picks a valid install (returns its root) or cancels (null). */
export async function chooseGameFolder(detected: string): Promise<string | null> {
  const term = terminalAsker();
  const asks: Ask[] = [];
  if (WIN) asks.push(askWindows);
  else if (hasGui()) { if (has('zenity')) asks.push(askZenity); else if (has('kdialog')) asks.push(askKdialog); }
  asks.push(term.ask);
  try {
    let prompt = introPrompt(detected);
    for (;;) {
      let picked: string | null | 'unavailable' = 'unavailable';
      // a dialog that cannot run (no display, broken PowerShell) falls through to the next way
      for (;;) {
        picked = await asks[0](prompt);
        if (picked !== 'unavailable') break;
        asks.shift();
      }
      if (picked === null) return null;
      const root = findGameRoot(picked);
      if (root) return root;
      console.log(tr().notGameFolder(picked));
      prompt = retryPrompt(picked);
    }
  } finally { term.close(); }
}

/** The game (and soundtrack) folder for a packaged run: the saved one, else ask and save. */
export async function resolveGameFolder(reset: boolean): Promise<LauncherConfig & { game: string } | null> {
  const file = configPath();
  if (!reset) migrateConfig(file);
  const cfg = reset ? {} : loadConfig(file);
  if (cfg.game) {
    const root = findGameRoot(cfg.game);
    if (root) return { game: root, music: cfg.music && existsSync(cfg.music) ? cfg.music : findMusic(root, []) };
    console.log(tr().savedGone(cfg.game));
  }
  const installs = detectInstalls();
  if (installs.length) console.log(tr().foundAt(installs.join(', ')));
  const game = await chooseGameFolder(installs[0] ?? '');
  if (!game) return null;
  const music = findMusic(game, installs);
  const saved: LauncherConfig & { game: string } = music ? { game, music } : { game };
  try {
    saveConfig(saved, file);
    console.log(tr().saved(file));
  } catch (err) {
    console.log(tr().saveFailed(file, (err as Error).message));
  }
  return saved;
}

// ---- network and browser -------------------------------------------------------------------

/** non-internal IPv4 addresses of this computer (LAN, VPNs like Tailscale / Hamachi / ZeroTier) */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal && !a.address.startsWith('169.254.')) out.push(a.address);
    }
  }
  return [...new Set(out)];
}

export function openBrowser(url: string): void {
  try {
    const p = WIN
      ? spawn('cmd.exe', ['/d', '/s', '/c', `start "" "${url}"`], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true })
      : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' });
    p.on('error', () => console.log(tr().noBrowser(url)));
    p.unref();
  } catch { /* no browser: the URL is printed anyway */ }
}

/** keep a double-clicked console window open long enough to read an error */
export async function waitForEnter(): Promise<void> {
  if (!process.stdin.isTTY) return;
  process.stdout.write(`\n${tr().pressEnter}`);
  const rl = createInterface({ input: (process as unknown as { stdin: unknown }).stdin, terminal: false });
  await rl[Symbol.asyncIterator]().next();
  rl.close();
}
