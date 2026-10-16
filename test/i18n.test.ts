// Launcher / server texts in German and English (src/server/i18n.ts): language detection from
// --lang, AN_LANG, the POSIX locale variables, Intl and (Windows) the display language; and that
// both string tables are complete.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { langOfLocale, langArg, detectLang, explicitLang, badLangValue, posixLocale, STRINGS, type LangInput } from '../src/server/i18n.ts';

test('locale names map to de / en', {}, () => {
  for (const t of ['de', 'de-DE', 'de-AT', 'de-CH', 'de_DE.UTF-8', 'de_AT.utf8@euro', 'de_CH', 'German_Germany.1252', 'gsw-CH', 'DE-de'])
    assert.equal(langOfLocale(t), 'de', t);
  for (const t of ['en', 'en-US', 'en_GB.UTF-8', 'fr-FR', 'nl_NL', 'dek', 'en-US-u-va-posix'])
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
  // an unknown value is ignored (and warned about), the system language decides
  assert.equal(detectLang({ ...base, arg: 'fr' }), 'de');
  assert.equal(explicitLang('fr'), null);
  assert.equal(badLangValue('fr', {}), 'fr');
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
  assert.equal(win('fr-FR', 'de-DE'), 'en'); // a non-default format locale is trusted
  assert.equal(asked, 0);
  assert.equal(win('en-US', 'de-DE'), 'de');
  assert.equal(win('en-US', 'en-US'), 'en');
  assert.equal(win('en-US', undefined), 'en'); // PowerShell failed
  assert.equal(win('und', 'de-CH'), 'de');
  assert.equal(asked, 4);
  assert.equal(win('en-US', 'en-US', { LANG: 'de_DE.UTF-8' }), 'en'); // POSIX variables do not count on Windows
});

test('every text exists in German and English, with the same parameters', {}, () => {
  const en = STRINGS.en as Record<string, unknown>, de = STRINGS.de as Record<string, unknown>;
  assert.deepEqual(Object.keys(de).sort(), Object.keys(en).sort());
  for (const k of Object.keys(en)) {
    assert.equal(typeof de[k], typeof en[k], k);
    if (typeof en[k] === 'function') {
      const f = en[k] as (...a: unknown[]) => string, g = de[k] as (...a: unknown[]) => string;
      assert.equal(g.length, f.length, k);
      const args = ['ARG-A', 'ARG-B'].slice(0, f.length).map((a, i) => (k === 'soundtrack' || k === 'gameData') && i === 1 ? 7 : /port|internet/i.test(k) ? 8080 : a);
      for (const [lang, fn] of [['en', f], ['de', g]] as const) {
        const out = fn(...args);
        assert.ok(out.trim().length > 0, `${lang}.${k}`);
        for (const a of args) assert.ok(out.includes(String(a)), `${lang}.${k} shows ${a}`);
      }
    } else {
      assert.ok(String(de[k]).trim().length > 0 && String(en[k]).trim().length > 0, k);
    }
  }
  // the two help texts list the same options
  const opts = (s: string) => [...new Set(s.match(/--[a-z-]+/g))].sort();
  assert.deepEqual(opts(STRINGS.de.usage('x')), opts(STRINGS.en.usage('x')));
  assert.ok(STRINGS.en.usage('x').includes('--lang de|en'));
  // German with real umlauts (no "ae"/"oe"/"ue" stand-ins), and UTF-8 safe
  assert.ok(/Drücke.*schließen/.test(STRINGS.de.pressEnter));
  assert.ok(/wähle/.test(STRINGS.de.intro));
  assert.equal(new TextDecoder().decode(new TextEncoder().encode(STRINGS.de.intro)), STRINGS.de.intro);
});
