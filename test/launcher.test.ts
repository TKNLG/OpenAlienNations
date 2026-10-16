// Launcher of the packaged builds (src/server/launcher.ts): recognising an install from the
// folder a player picks, finding the soundtrack, the per-user config file, the Windows dialog encoding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findGameRoot, findMusic, configPath, legacyConfigPath, migrateConfig, loadConfig, saveConfig, WINDOWS_DIALOG_SCRIPT, windowsDialogEnv, encodePowerShell, parseWindowsDialogOutput } from '../src/server/launcher.ts';
import { STRINGS } from '../src/server/i18n.ts';

function fakeInstall(root: string, opt: { data?: string; music?: boolean } = {}): string {
  mkdirSync(join(root, opt.data ?? 'Data'), { recursive: true });
  writeFileSync(join(root, opt.data ?? 'Data', 'dv.gd'), '');
  mkdirSync(join(root, 'Bin'), { recursive: true });
  if (opt.music) { mkdirSync(join(root, 'Bin', 'music')); writeFileSync(join(root, 'Bin', 'music', 'Track02.ogg'), ''); }
  return root;
}

test('findGameRoot accepts the install, its Data/Bin folder or the parent of "Alien Nations"', {}, () => {
  const tmp = mkdtempSync(join(tmpdir(), 'an-launcher-'));
  try {
    const gog = fakeInstall(join(tmp, 'GOG Games', 'Alien Nations'));
    assert.equal(findGameRoot(gog), gog);
    assert.equal(findGameRoot(join(gog, 'Data')), gog);
    assert.equal(findGameRoot(join(gog, 'Bin')), gog);
    assert.equal(findGameRoot(join(tmp, 'GOG Games')), gog);
    assert.equal(findGameRoot(tmp), null);
    assert.equal(findGameRoot(join(tmp, 'missing')), null);
    assert.equal(findGameRoot(''), null);
    // Gold Edition CD installs use lower-case folder names
    const gold = fakeInstall(join(tmp, 'Gold Edition'), { data: 'data' });
    assert.equal(findGameRoot(gold), gold);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('findMusic prefers the game\'s own Bin/music, else another install\'s', {}, () => {
  const tmp = mkdtempSync(join(tmpdir(), 'an-launcher-'));
  try {
    const gold = fakeInstall(join(tmp, 'gold'));
    const gog = fakeInstall(join(tmp, 'gog'), { music: true });
    assert.equal(findMusic(gold, []), '');
    assert.equal(findMusic(gold, [gold, gog]), join(gog, 'Bin', 'music'));
    assert.equal(findMusic(gog, [gold]), join(gog, 'Bin', 'music'));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('config file location per platform, save and load', {}, () => {
  assert.equal(configPath({ APPDATA: 'C:\\Users\\x\\AppData\\Roaming' }, 'win32'), join('C:\\Users\\x\\AppData\\Roaming', 'OpenAlienNations', 'config.json'));
  assert.equal(configPath({ HOME: '/home/x', XDG_CONFIG_HOME: '/cfg' }, 'linux'), join('/cfg', 'openaliennations', 'config.json'));
  assert.equal(configPath({ HOME: '/home/x' }, 'linux'), join('/home/x', '.config', 'openaliennations', 'config.json'));
  assert.equal(configPath({ HOME: '/home/x' }, 'darwin'), join('/home/x', 'Library', 'Application Support', 'OpenAlienNations', 'config.json'));
  // builds from before the rename
  assert.equal(legacyConfigPath({ APPDATA: 'C:\\Users\\x\\AppData\\Roaming' }, 'win32'), join('C:\\Users\\x\\AppData\\Roaming', 'AlienNations', 'config.json'));
  assert.equal(legacyConfigPath({ HOME: '/home/x' }, 'linux'), join('/home/x', '.config', 'aliennations', 'config.json'));
  assert.equal(legacyConfigPath({ HOME: '/home/x' }, 'darwin'), join('/home/x', 'Library', 'Application Support', 'AlienNations', 'config.json'));
  const tmp = mkdtempSync(join(tmpdir(), 'an-launcher-'));
  try {
    const file = join(tmp, 'sub', 'config.json');
    assert.deepEqual(loadConfig(file), {});
    saveConfig({ game: '/games/an', music: '/games/an/Bin/music' }, file);
    assert.deepEqual(loadConfig(file), { game: '/games/an', music: '/games/an/Bin/music' });
    writeFileSync(file, 'not json');
    assert.deepEqual(loadConfig(file), {});
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('the config of builds from before the rename is copied over once', {}, () => {
  const tmp = mkdtempSync(join(tmpdir(), 'an-launcher-'));
  try {
    const env = { HOME: tmp, XDG_CONFIG_HOME: join(tmp, 'cfg'), APPDATA: join(tmp, 'appdata') };
    for (const platform of ['linux', 'win32', 'darwin']) {
      const file = configPath(env, platform), legacy = legacyConfigPath(env, platform);
      assert.ok(file !== legacy);
      // nothing saved anywhere: nothing to do
      assert.equal(migrateConfig(file, legacy), false);
      assert.deepEqual(loadConfig(file), {});
      // only the old config: copied, the old file stays
      saveConfig({ game: '/games/an', music: '/games/an/Bin/music' }, legacy);
      assert.equal(migrateConfig(file, legacy), true);
      assert.deepEqual(loadConfig(file), { game: '/games/an', music: '/games/an/Bin/music' });
      assert.deepEqual(loadConfig(legacy), { game: '/games/an', music: '/games/an/Bin/music' });
      // the new config exists: never overwritten by the old one
      saveConfig({ game: '/games/gold' }, file);
      assert.equal(migrateConfig(file, legacy), false);
      assert.equal(loadConfig(file).game, '/games/gold');
    }
    // an unreadable old config is not copied
    const file = join(tmp, 'new', 'config.json'), legacy = join(tmp, 'old', 'config.json');
    mkdirSync(join(tmp, 'old'));
    writeFileSync(legacy, 'not json');
    assert.equal(migrateConfig(file, legacy), false);
    assert.deepEqual(loadConfig(file), {});
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

const bytes = (b64: string) => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
const base64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));

test('Windows dialogs: ASCII script, texts through the environment, path back as UTF-8 base64', {}, () => {
  // the script itself never carries texts: typographic quotes („“ ’) are string delimiters in PowerShell
  assert.ok(/^[\x20-\x7e\n]*$/.test(WINDOWS_DIALOG_SCRIPT));
  const text = STRINGS.de.notInstall('C:\\Spiele\\Die Völker „alt“ – Peter’s');
  const env = windowsDialogEnv({ text, terminal: text, initial: 'C:\\Spiele\\Die Völker', error: true }, STRINGS.de.pickTitle);
  assert.equal(env.AN_DLG_TEXT, text);
  assert.equal(env.AN_DLG_TITLE, 'Wähle deinen Alien-Nations-Ordner (den mit „Data“ und „Bin“)');
  assert.equal(env.AN_DLG_PATH, 'C:\\Spiele\\Die Völker');
  assert.equal(env.AN_DLG_ERROR, '1');
  for (const v of ['$env:AN_DLG_TEXT', '$env:AN_DLG_TITLE', '$env:AN_DLG_PATH', '$env:AN_DLG_ERROR']) assert.ok(WINDOWS_DIALOG_SCRIPT.includes(v), v);
  // -EncodedCommand is UTF-16LE base64, also for non-ASCII and surrogate pairs
  for (const s of [WINDOWS_DIALOG_SCRIPT, 'Write-Output "Größe ä ö ü ß €"', 'x 🎮 y']) {
    assert.equal(new TextDecoder('utf-16le').decode(bytes(encodePowerShell(s))), s);
  }
  // [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($path)) on the PowerShell side
  const picked = 'D:\\Spiele\\Die Völker\\Größe';
  assert.equal(parseWindowsDialogOutput(`PATH:${base64(new TextEncoder().encode(picked))}\r\n`), picked);
  assert.equal(parseWindowsDialogOutput('CANCEL\r\n'), null);
  assert.equal(parseWindowsDialogOutput(''), 'unavailable');
  assert.equal(parseWindowsDialogOutput('PATH:%%%'), 'unavailable');
  assert.equal(parseWindowsDialogOutput(`PATH:${base64(new Uint8Array([0xff, 0xfe]))}`), 'unavailable');
});
