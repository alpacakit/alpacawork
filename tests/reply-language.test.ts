/**
 * The language the AI replies to the user in (`ai.language`), apart from the screen's language: the values a save
 * accepts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { personSettingsSetInput } from '@alpacawork/contract/inputs';

const save = (key: string, value: unknown) => personSettingsSetInput.safeParse({ key, value, expectedRevision: 'r1' });

test('a reply language is saved as one canonical BCP 47 tag or none; the command line\'s text reads by the setting\'s kind', () => {
  assert.equal(save('ai.language', 'ja-jp').data?.value, 'ja-JP');
  assert.equal(save('ai.language', 'zh-hant-tw').data?.value, 'zh-Hant-TW');
  assert.equal(save('ai.language', 'null').data?.value, null);
  assert.equal(save('ai.language', null).data?.value, null);
  for (const refused of ['', 'english!', 'ja_JP', 'ja,en', 'und', 'qaa', `x-${'a'.repeat(40)}`, true])
    assert.equal(save('ai.language', refused).success, false, String(refused));
  assert.equal(save('push.done', 'true').data?.value, true);
  assert.equal(save('push.done', false).data?.value, false);
  // The screen's language stays a choice of the screen's own translations.
  for (const language of ['en', 'ja', 'zh-CN', 'es', 'pt-BR'])
    assert.equal(save('language', language).data?.value, language);
  for (const language of ['fr', 'es-MX', 'zh-Hant', 'pt-br'])
    assert.equal(save('language', language).success, false, language);
  assert.equal(save('push.mutedUntil', 'null').success, false, 'the server keeps its own values');
});
