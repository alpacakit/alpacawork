import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchUiLocale, uiLocaleFromAcceptLanguage, uiLocaleFromEnvironment } from '@alpacawork/core/ui-language';

test('a regional language preference matches a catalog with the same language and script', () => {
  for (const [tag, expected] of [
    ['en-GB', 'en'], ['ja-JP', 'ja'], ['es-MX', 'es'], ['pt-PT', 'pt-BR'],
    ['zh', 'zh-CN'], ['zh-CN', 'zh-CN'], ['zh-SG', 'zh-CN'], ['zh-Hans', 'zh-CN'],
  ] as const) assert.equal(matchUiLocale([tag]), expected, tag);

  for (const tag of ['zh-TW', 'zh-HK', 'zh-Hant', 'zh-Hant-CN', 'ja-Latn', 'und', 'invalid!']) {
    assert.equal(matchUiLocale([tag]), undefined, tag);
    assert.equal(matchUiLocale([tag, 'es-MX']), 'es', tag);
  }
  assert.equal(matchUiLocale(['ES-mx', 'ja']), 'es');
  assert.equal(matchUiLocale(['zh-TW', 'zh', 'zh-SG']), 'zh-CN');
});

test('a first HTTP read respects ranked preferences without saving for a wildcard or no preferences', () => {
  assert.equal(uiLocaleFromAcceptLanguage('zh-TW, pt-PT;q=0.9, es-MX;q=0.8'), 'pt-BR');
  assert.equal(uiLocaleFromAcceptLanguage('es-MX;q=0.7, pt-PT;q=0.9, zh-SG;q=0'), 'pt-BR');
  assert.equal(uiLocaleFromAcceptLanguage('es-MX;q=0.9, ja-JP;q=0.9'), 'es');
  assert.equal(uiLocaleFromAcceptLanguage('zh-HK'), 'en');
  assert.equal(uiLocaleFromAcceptLanguage('zh-TW,zh;q=0.9'), 'en');
  assert.equal(uiLocaleFromAcceptLanguage('zh-TW,zh;q=0.9,es-MX;q=0.8,es;q=0.7'), 'es');
  assert.equal(uiLocaleFromAcceptLanguage('*, ja-JP;q=0'), undefined);
  assert.equal(uiLocaleFromAcceptLanguage(undefined), undefined);
});

test('the terminal matches POSIX locale names in environment precedence order', () => {
  assert.equal(uiLocaleFromEnvironment({ LC_ALL: 'zh_SG.UTF-8', LC_MESSAGES: 'pt_BR.UTF-8', LANG: 'ja_JP.UTF-8' }), 'zh-CN');
  assert.equal(uiLocaleFromEnvironment({ LC_ALL: '', LC_MESSAGES: 'pt_PT.UTF-8', LANG: 'ja_JP.UTF-8' }), 'pt-BR');
  assert.equal(uiLocaleFromEnvironment({ LANG: 'es_MX.UTF-8@traditional' }), 'es');
  assert.equal(uiLocaleFromEnvironment({ LC_ALL: 'zh_HK.UTF-8', LANG: 'es_MX.UTF-8' }), 'en');
  assert.equal(uiLocaleFromEnvironment({ LANG: 'C.UTF-8' }), 'en');
});
