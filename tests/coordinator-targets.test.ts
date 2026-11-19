import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskTokens, firstTaskToken, formatTask, taskStatement } from '@alpacawork/contract/coordinator';
const tasks = new Map([['T1', { id: 'T1', title: 'Title including T2' }], ['T2', { id: 'T2', title: 'Other' }]]);
const targets = (text: string) => taskTokens(text, id => tasks.get(id)).map(token => token.id);

test('the first reference skips unknowns and leaves later lookups to the all-reference API', () => {
  const text = '「T2」 T999（T2） Ｔ１（Title including T2） T2';
  const calls: string[] = [];
  const lookup = (id: string) => { calls.push(id); return tasks.get(id); };
  const first = firstTaskToken(text, lookup);
  assert.deepEqual(calls, ['T999', 'T1']);
  calls.length = 0;
  const all = taskTokens(text, lookup);
  assert.deepEqual(first, all[0]);
  assert.deepEqual(calls, ['T999', 'T1', 'T2']);
});

test('explicit target tokens preserve the editor contract and ignore quoted or referenced material', () => {
  for (const text of ['T1について教えて', 'Explain T1 please', 'ｔ１ を確認', formatTask('T1', tasks.get('T1')!.title)])
    assert.deepEqual(targets(text), ['T1'], text);
  assert.deepEqual(targets("I'll fix T1"), ['T1']);
  assert.deepEqual(targets('T1 と T2'), ['T1', 'T2']);
  for (const text of ['https://example.test/?task=T1', 'https://example.test/T1', 'key=T1', 'path/T1', 'XT1',
    '`T1`', '```ts\nT1\n```', '~~~\nT1\n~~~', '> T1 の引用', '    T1 code', '「T1」', '「引用\nT1\n」', '「T1', '"quoted\nT1\n"', '"T1', '`T1 ', '`code\nT1\n`', '『T1』', '“T1”', '"T1"', "'T1'", '[T1](https://example.test)', 'T999'])
    assert.deepEqual(targets(text), [], text);
  assert.deepEqual(targets('> T2 引用\nT1 を直して\n```\nT2\n```'), ['T1']);
  assert.deepEqual(targets('https://example.test/?task=T2\nT1 を直して'), ['T1']);
});

test('a fence marker inside a quote does not hide the explicit target after the quote', () => {
  assert.deepEqual(targets('「\n```\n」\n\nT1 を確認'), ['T1']);
});


test('opaque spans are consumed before their inner delimiters, with following targets preserved', () => {
  for (const quote of [['「', '」'], ['『', '』'], ['“', '”'], ['"', '"'], ["'", "'"]]) {
    assert.deepEqual(targets(`${quote[0]}\n~~~\nT2\n${quote[1]}\nT1`), ['T1']);
    assert.deepEqual(targets(`${quote[0]}\n\`\`\`\n${quote[1]}\nT1`), ['T1']);
  }
  assert.deepEqual(targets('```\n「T2\n```\nT1'), ['T1']);
  assert.deepEqual(targets('````\nT2\n```\nT2\n````\nT1'), ['T1']);
  assert.deepEqual(targets('> 「T2\nT1'), ['T1']);
});


test('known task titles are opaque before interpreting their quote or code delimiters', () => {
  for (const title of ['題名に「開始だけ', 'title with " only', 'title with ` only', 'title） T2（` unmatched']) {
    const known = new Map([...tasks, ['T3', { id: 'T3', title }]]);
    const text = `${formatTask('T3', title)} T1 を確認`;
    assert.deepEqual(taskTokens(text, id => known.get(id)).map(token => token.id), ['T3', 'T1'], title);
  }
  assert.deepEqual(targets('T999（「T2） T1'), ['T1']);
});


test('statement headings read the sender’s shared task-label grammar without language-specific repairs', () => {
  for (const title of ['公開の方法', 'Release approach', 'Plan（nested） "quote"']) {
    const wire = formatTask('T1', title) + ' Choose A';
    assert.equal(taskStatement(wire, 'T1'), 'Choose A');
    assert.equal(taskStatement(wire, 'T2'), 'T1 Choose A');
  }
  for (const prose of ['T1 please choose A', 'コーディネーターとの問答: choose A', 'T1（unclosed Choose A', 'T1（title）suffix is prose'])
    assert.equal(taskStatement(prose, 'T1'), prose);
});
