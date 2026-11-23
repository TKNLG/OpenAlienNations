// Launcher / server texts in German, English and French (src/server/i18n.ts): language detection
// from --lang, AN_LANG, the POSIX locale variables, Intl and (Windows) the display language; and
// that the three string tables are complete.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { langOfLocale, langArg, detectLang, explicitLang, badLangValue, posixLocale, STRINGS, type LangInput } from '../src/server/i18n.ts';

test('locale names map to de / fr / en', {}, () => {
  for (const t of ['de', 'de-DE', 'de-AT', 'de-CH', 'de_DE.UTF-8', 'de_AT.utf8@euro', 'de_CH', 'German_Germany.1252', 'gsw-CH', 'DE-de'])
    assert.equal(langOfLocale(t), 'de', t);
  for (const t of ['fr', 'fr-FR', 'fr-CA', 'fr_BE.UTF-8', 'fr_CH', 'French_France.1252', 'FR-fr'])
    assert.equal(langOfLocale(t), 'fr', t);
  for (const t of ['en', 'en-US', 'en_GB.UTF-8', 'nl_NL', 'dek', 'frk', 'en-US-u-va-posix'])
    assert.equal(langOfLocale(t), 'en', t);
  for (const t of [undefined, '', 'C', 'C.UTF-8', 'POSIX'])
    assert.equal(langOfLocale(t), null, String(t));
});

test('--lang and AN_LANG override the system language', {}, () => {
  const base: LangInput = { env: { LANG: 'de_DE.UTF-8' }, platform: 'linux', intlLocale: 'de-DE' };
  assert.equal(detectLang(base), 'de');
  assert.equal(detectLang({ ...base, arg: 'en' }), 'en');
  assert.equal(detectLang({ ...base, env: { ...base.env, AN_LANG: 'en' } }), 'en');
  assert.equal(detectLang({ env: { LANG: 'en_US.UTF-8', AN_LANG: 'de' }, platform: 'linux' }), 'de');
  assert.equal(detectLang({ env: { AN_LANG: 'en' }, arg: 'de', platform: 'win32', intlLocale: 'en-US' }), 'de');
  assert.equal(detectLang({ env: {}, arg: 'Deutsch', platform: 'linux' }), 'de');
  assert.equal(detectLang({ env: {}, arg: 'de-AT', platform: 'linux' }), 'de');
  assert.equal(detectLang({ ...base, arg: 'fr' }), 'fr');
  assert.equal(detectLang({ ...base, env: { ...base.env, AN_LANG: 'fr' } }), 'fr');
  assert.equal(detectLang({ env: {}, arg: 'Français', platform: 'linux' }), 'fr');
  assert.equal(detectLang({ env: {}, arg: 'fr-CA', platform: 'linux' }), 'fr');
  assert.equal(explicitLang('french'), 'fr');
  assert.equal(badLangValue('fr', {}), null);
  // an unknown value is ignored (and warned about), the system language decides
  assert.equal(detectLang({ ...base, arg: 'it' }), 'de');
  assert.equal(explicitLang('it'), null);
  assert.equal(badLangValue('it', {}), 'it');
  assert.equal(badLangValue('', {}), '');
  assert.equal(badLangValue(undefined, { AN_LANG: 'xx' }), 'xx');
  assert.equal(badLangValue('de', { AN_LANG: 'xx' }), null); // --lang wins, AN_LANG unused
  assert.equal(badLangValue(undefined, { AN_LANG: 'en' }), null);
  assert.equal(badLangValue(undefined, {}), null);
  assert.equal(langArg(['--port', '9000', '--lang', 'de']), 'de');
  assert.equal(langArg(['--lang=en']), 'en');
  assert.equal(langArg(['--lang']), '');
  assert.equal(langArg(['--open']), undefined);
});

test('Linux: LC_ALL, LC_MESSAGES, LANG, LANGUAGE as gettext reads them, then Intl', {}, () => {
  const linux = (env: Record<string, string>, intlLocale = 'en-US') => detectLang({ env, platform: 'linux', intlLocale });
  assert.equal(linux({ LANG: 'de_DE.UTF-8' }), 'de');
  assert.equal(linux({ LANG: 'de_AT.UTF-8' }), 'de');
  assert.equal(linux({ LANG: 'de_CH.UTF-8' }), 'de');
  assert.equal(linux({ LANG: 'en_US.UTF-8' }, 'de-DE'), 'en');
  assert.equal(linux({ LANG: 'de_DE.UTF-8', LC_ALL: 'en_US.UTF-8' }), 'en');
  assert.equal(linux({ LANG: 'en_US.UTF-8', LC_MESSAGES: 'de_DE.UTF-8' }), 'de');
  assert.equal(linux({ LANG: 'en_US.UTF-8', LANGUAGE: 'de:en' }), 'de');
  assert.equal(linux({ LANG: 'de_DE.UTF-8', LANGUAGE: 'en_GB:de' }), 'en');
  assert.equal(linux({ LANG: 'C', LANGUAGE: 'de' }), 'en'); // C locale: LANGUAGE ignored
  assert.equal(posixLocale({ LANG: 'C', LANGUAGE: 'de' }), 'C');
  assert.equal(linux({}, 'de-DE'), 'de'); // nothing set: Intl
  assert.equal(linux({}, 'en-US'), 'en');
  assert.equal(linux({ LANG: 'fr_FR.UTF-8' }), 'fr');
  assert.equal(linux({ LANG: 'fr_CA.UTF-8', LC_MESSAGES: 'de_DE.UTF-8' }), 'de');
  assert.equal(linux({}, 'fr-FR'), 'fr');
  assert.equal(linux({}, ''), 'en');
  assert.equal(detectLang({ env: { LANG: 'de_DE.UTF-8' }, platform: 'darwin', intlLocale: 'en-US' }), 'de');
});

test('Windows: Intl, and the display language (Get-UICulture) only when Intl says en-US', {}, () => {
  let asked = 0;
  const win = (intlLocale: string, ui: string | undefined, env: Record<string, string> = {}) =>
    detectLang({ env, platform: 'win32', intlLocale, uiCulture: () => { asked++; return ui; } });
  assert.equal(win('de-DE', 'en-US'), 'de');
  assert.equal(win('de-AT', undefined), 'de');
  assert.equal(win('de-CH', undefined), 'de');
  assert.equal(asked, 0);
  assert.equal(win('fr-FR', 'de-DE'), 'fr'); // a non-default format locale is trusted
  assert.equal(win('nl-NL', 'de-DE'), 'en');
  assert.equal(asked, 0);
  assert.equal(win('en-US', 'de-DE'), 'de');
  assert.equal(win('en-US', 'en-US'), 'en');
  assert.equal(win('en-US', undefined), 'en'); // PowerShell failed
  assert.equal(win('und', 'de-CH'), 'de');
  assert.equal(win('en-US', 'fr-FR'), 'fr');
  assert.equal(asked, 5);
  assert.equal(win('en-US', 'en-US', { LANG: 'de_DE.UTF-8' }), 'en'); // POSIX variables do not count on Windows
});

test('every text exists in German, English and French, with the same parameters', {}, () => {
  const en = STRINGS.en as Record<string, unknown>;
  const others = { de: STRINGS.de, fr: STRINGS.fr } as Record<string, Record<string, unknown>>;
  for (const [lang, tab] of Object.entries(others)) assert.deepEqual(Object.keys(tab).sort(), Object.keys(en).sort(), lang);
  for (const k of Object.keys(en)) {
    const all = [['en', en[k]], ...Object.entries(others).map(([lang, tab]) => [lang, tab[k]] as const)] as const;
    for (const [lang, v] of all) assert.equal(typeof v, typeof en[k], `${lang}.${k}`);
    if (typeof en[k] === 'function') {
      const f = en[k] as (...a: unknown[]) => string;
      const args = ['ARG-A', 'ARG-B'].slice(0, f.length).map((a, i) => (k === 'soundtrack' || k === 'gameData') && i === 1 ? 7 : /port|internet/i.test(k) ? 8080 : a);
      for (const [lang, v] of all) {
        const fn = v as (...a: unknown[]) => string;
        assert.equal(fn.length, f.length, `${lang}.${k}`);
        const out = fn(...args);
        assert.ok(out.trim().length > 0, `${lang}.${k}`);
        for (const a of args) assert.ok(out.includes(String(a)), `${lang}.${k} shows ${a}`);
      }
    } else {
      for (const [lang, v] of all) assert.ok(String(v).trim().length > 0, `${lang}.${k}`);
    }
  }
  // the three help texts list the same options
  const opts = (s: string) => [...new Set(s.match(/--[a-z-]+/g))].sort();
  assert.deepEqual(opts(STRINGS.de.usage('x')), opts(STRINGS.en.usage('x')));
  assert.deepEqual(opts(STRINGS.fr.usage('x')), opts(STRINGS.en.usage('x')));
  for (const l of ['de', 'en', 'fr'] as const) assert.ok(STRINGS[l].usage('x').includes('--lang de|en|fr'), l);
  // German with real umlauts (no "ae"/"oe"/"ue" stand-ins), French with its accents, and UTF-8 safe
  assert.ok(/Drücke.*schließen/.test(STRINGS.de.pressEnter));
  assert.ok(/wähle/.test(STRINGS.de.intro));
  assert.ok(/Entrée/.test(STRINGS.fr.pressEnter));
  for (const text of [STRINGS.de.intro, STRINGS.fr.intro]) assert.equal(new TextDecoder().decode(new TextEncoder().encode(text)), text);
});
