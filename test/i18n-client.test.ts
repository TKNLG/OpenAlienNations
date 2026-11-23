// The client's own texts (src/client/i18n.ts): the language from the game data (DV.tdb string 81),
// t() with placeholders, and that every key has English and French: the table itself, every
// t('...') in the client sources, the lobby's error texts (translated on arrival) and the
// campaign labels. The data-driven part needs AN_DATA (German install), AN_DATA_EN (English) and
// optionally AN_DATA_FR (French).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { detectLang, setLang, lang, t, DICT } from '../src/client/i18n.ts';
import { parseTdb } from '../src/formats/tdb.ts';
import { CAMPAIGNS, CAMPAIGNS_AO, FREEPLAY_AO } from '../src/client/data.ts';
import { FREEPLAY_CAMPAIGN } from '../src/client/frontend/freeplay.ts';

const ROOT = new URL('../', import.meta.url).pathname;

test('detectLang: DV.tdb string 81 ("off") names the language', {}, () => {
  assert.equal(detectLang('Aus'), 'de');
  assert.equal(detectLang('Off'), 'en');
  assert.equal(detectLang('Désactiver'), 'fr');
  assert.equal(detectLang(' Aus '), 'de');
  for (const v of ['Spento', 'Uit', '', undefined, 'aus']) assert.equal(detectLang(v), 'en', String(v));
});

test('t(): German key, English / French text, {n} placeholders', {}, () => {
  const before = lang();
  try {
    setLang('de');
    assert.equal(t('Fehler: {0}', 'kaputt'), 'Fehler: kaputt');
    assert.equal(t('Erweitert'), 'Erweitert');
    setLang('en');
    assert.equal(t('Fehler: {0}', 'broken'), 'Error: broken');
    assert.equal(t('{0} — du spielst die {1} · {2}×{2} · {3} eigene Einheiten', 'M', 'Amazons', 256, 12), 'M — you play the Amazons · 256×256 · 12 own units');
    assert.equal(t('Mehrspieler: {0} Spieler, du bist Spieler {1} ({2})', 2, 1, 'Pimmons'), 'Multiplayer: 2 players, you are player 1 (Pimmons)');
    assert.equal(t('not a key {0}', 'x'), 'not a key x'); // unknown keys fall back to the key
    setLang('fr');
    assert.equal(t('Fehler: {0}', 'x'), 'Erreur : x');
    assert.equal(t('HD-Grafik:'), 'Graphismes HD :');
    assert.equal(t('{0} {1} auf Lager {2}', 5, 'Bois', t('in deiner Stadt {0}', 2)), '5 Bois en réserve dans ta ville 2');
    assert.equal(t('Ziel {0}'), 'objectif {0}'); // a missing argument leaves its placeholder
  } finally { setLang(before); }
});

const placeholders = (s: string) => [...new Set(s.match(/\{\d+\}/g) ?? [])].sort();

test('every key has an English and a French text with the same placeholders', {}, () => {
  assert.deepEqual(Object.keys(DICT.fr).sort(), Object.keys(DICT.en).sort());
  for (const k of Object.keys(DICT.en)) {
    for (const l of ['en', 'fr'] as const) {
      const v = DICT[l][k];
      assert.ok(v !== undefined && v.trim().length > 0, `${l}: ${k}`);
      assert.deepEqual(placeholders(v), placeholders(k), `${l}: ${k}`);
    }
    // French puts a (narrow or normal) space before ':' as the game's own French texts do
    assert.ok(!/[^\s{]:(\s|$)/.test(DICT.fr[k].replace(/https?:/g, '')), `fr spacing: ${DICT.fr[k]}`);
  }
});

/** all .ts files below a folder */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir)) {
    const p = `${dir}/${n}`;
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (n.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** the string literal arguments of every t('...') call and every i18n: ['...'] error marker */
function usedKeys(): { key: string; file: string }[] {
  const found: { key: string; file: string }[] = [];
  const files = [...sources(`${ROOT}src/client`), ...sources(`${ROOT}src/engine`), ...sources(`${ROOT}src/world`), ...sources(`${ROOT}src/net`)];
  for (const file of files) {
    if (file.endsWith('/i18n.ts')) continue;
    const src = readFileSync(file, 'utf8');
    for (const re of [/(?<![\w.$])t\(\s*'((?:[^'\\]|\\.)*)'/g, /(?<![\w.$])t\(\s*"((?:[^"\\]|\\.)*)"/g, /i18n:\s*\[\s*'((?:[^'\\]|\\.)*)'/g])
      for (const m of src.matchAll(re)) found.push({ key: m[1].replace(/\\'/g, "'").replace(/\\"/g, '"'), file: file.slice(ROOT.length) });
    assert.ok(!/(?<![\w.$])t\(\s*`/.test(src), `${file}: t() with a template literal cannot be checked`);
  }
  return found;
}

test('every t() key in the client sources has English and French', {}, () => {
  const used = usedKeys();
  assert.ok(used.length > 100, `found ${used.length} keys`);
  for (const { key, file } of used) {
    assert.ok(key in DICT.en, `${file}: no English text for "${key}"`);
    assert.ok(key in DICT.fr, `${file}: no French text for "${key}"`);
  }
  // keys nobody uses any more (the lobby's texts and campaign labels are used indirectly)
  const indirect = new Set([...lobbyTexts(), ...campaignLabels()]);
  const unused = Object.keys(DICT.en).filter(k => !indirect.has(k) && !used.some(u => u.key === k));
  assert.deepEqual(unused, []);
});

/** the lobby's error texts: German in src/server/lobby.ts, translated by the client */
function lobbyTexts(): string[] {
  const src = readFileSync(`${ROOT}src/server/lobby.ts`, 'utf8');
  return [...src.matchAll(/new LobbyError\('\w+',\s*'((?:[^'\\]|\\.)*)'\)/g)].map(m => m[1]);
}
function campaignLabels(): string[] { return [...CAMPAIGNS, ...CAMPAIGNS_AO, FREEPLAY_AO, FREEPLAY_CAMPAIGN].map(c => c.label); }

test('the lobby error texts and campaign labels have English and French', {}, () => {
  const lobby = lobbyTexts();
  assert.ok(lobby.length >= 5, `found ${lobby.length} lobby texts`);
  for (const k of [...lobby, ...campaignLabels()]) {
    assert.ok(k in DICT.en, `no English text for "${k}"`);
    assert.ok(k in DICT.fr, `no French text for "${k}"`);
  }
});

/** DV.tdb of an install's Data folder (file name case differs between releases) */
function off(data: string): string | undefined {
  const name = readdirSync(data).find(n => n.toLowerCase() === 'dv.tdb');
  return name ? parseTdb(readFileSync(`${data}/${name}`)).get(81) : undefined;
}
const installs: [string, 'de' | 'en' | 'fr'][] = [['AN_DATA', 'de'], ['AN_GOLD', 'de'], ['AN_DATA_EN', 'en'], ['AN_DATA_FR', 'fr']];
for (const [env, want] of installs) {
  const dir = process.env[env];
  test(`the ${env} install is recognised as '${want}'`, { skip: !(dir && existsSync(dir)) && `${env} not set` }, () => {
    assert.equal(detectLang(off(dir!)), want);
  });
}
