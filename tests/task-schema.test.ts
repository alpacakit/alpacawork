import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyValues, canonicalValues, catalogProblems, DEFAULT_SCHEMA, fieldCatalog, hardLimit, OTHER_WORD, questionText, renderContext, renderItems, schemaOf,
  readAnswerParts, schemaProblems, sizeNote, STOP_WORD, SYSTEM_FIELDS, PROJECT_SCHEMA, valuesJsonSchema, type FieldDef, type TaskValues,
} from '@alpacawork/contract';
import { toIssues } from '@alpacawork/core';

const catalog = fieldCatalog([]);
const check = (patch: unknown, ids = DEFAULT_SCHEMA) => schemaOf(ids, catalog).safeParse(patch);

test('the defaults are a sound catalog and the default schema holds every system field', () => {
  assert.deepEqual(catalogProblems(catalog), []);
  assert.deepEqual(schemaProblems(DEFAULT_SCHEMA, catalog), []);
  assert.deepEqual(schemaProblems(DEFAULT_SCHEMA.filter(id => id !== 'decide'), catalog).map(problem => problem.path), ['fields']);
  for (const id of PROJECT_SCHEMA) {
    assert.equal(DEFAULT_SCHEMA.includes(id), false);
    assert.deepEqual(schemaProblems([...DEFAULT_SCHEMA, id], catalog).map(problem => problem.path), [`fields.${DEFAULT_SCHEMA.length}`]);
  }
  assert.equal(schemaOf(PROJECT_SCHEMA, catalog).safeParse({ project_policy: 'x'.repeat(100_000) }).success, true);
  for (const id of SYSTEM_FIELDS) assert.ok(DEFAULT_SCHEMA.includes(id));
});

test('a write names only the fields it changes, null clears one, a list is replaced whole and empty parts drop', () => {
  const parsed = check({ goal: ' 終わる ', conditions: ['a — 充足', ' '], notes: null });
  assert.equal(parsed.success, true);
  const before: TaskValues = { conditions: ['old'], notes: '前の本文', conclusion: '結論' };
  assert.deepEqual(applyValues(before, parsed.data!, catalog), { goal: '終わる', conditions: ['a — 充足'], conclusion: '結論' });
  assert.deepEqual(applyValues(before, { conditions: [] }, catalog), { notes: '前の本文', conclusion: '結論' });
});

test('the issues of a refused write (the public error shape) name the value they are about: unknown field, too long, too many, a question without its text', () => {
  const paths = (patch: unknown) => toIssues(check(patch).error!.issues).map(issue => issue.path || '$');
  assert.deepEqual(paths({ nope: 'x' }), ['$']);
  assert.deepEqual(paths({ goal: 'x'.repeat(79) }), ['goal']);
  assert.deepEqual(paths({ pr: Array(21).fill('u') }), ['pr']);
  assert.deepEqual(paths({ decide: [{ decide_choices: [] }] }), ['decide.0.decide_question']);
  assert.deepEqual(paths({ decide: [{ decide_kind: 'choose', decide_question: 'q', other: 1 }] }), ['decide.0']);
});

test('a question\'s choices hold together: first words of their own, none the app keeps, at most one recommended; only the name is needed', () => {
  const choice = (name: string, more: Record<string, string> = {}) => ({ decide_choice: name, ...more });
  const issues = (...choices: unknown[]) => {
    const parsed = check({ decide: [{ decide_kind: 'choose', decide_question: 'q', decide_choices: choices }] });
    return parsed.success ? [] : toIssues(parsed.error.issues).map(issue => [issue.path, issue.message]);
  };
  // A choice is its name alone, or with its description and why it is recommended.
  assert.deepEqual(issues(choice('出す'), choice('直す', { decide_choice_detail: 'd' }), choice('待つ', { decide_choice_detail: 'd', decide_choice_recommended: 'why' })), []);
  assert.deepEqual(issues({ decide_choice_detail: 'd' }).map(([path]) => path), ['decide.0.decide_choices.0.decide_choice']);
  // An answer names a choice by its first word, so a question's choices start with words of their own.
  assert.deepEqual(issues(choice('出す PCも入れ替える'), choice('出す PCはあとで'), choice('直す')),
    [['decide.0.decide_choices.1.decide_choice', '"出す" also starts "出す PCも入れ替える": an answer names a choice by the word before the first space, so start each choice of a question with a word of its own']]);
  // `<n>-stop` and `<n>-other` are the app's own answers, whatever the case; a longer word is a word of its own.
  assert.deepEqual([STOP_WORD, OTHER_WORD], ['stop', 'other']);
  assert.deepEqual(issues(choice('stop'), choice('Stop here'), choice(' STOP\tnow')).map(([path]) => path),
    ['decide.0.decide_choices.0.decide_choice', 'decide.0.decide_choices.1.decide_choice', 'decide.0.decide_choices.2.decide_choice']);
  assert.match(issues(choice('Stop here'))[0]![1]!, /^"Stop" is an answer word the app keeps: .*decide_stop/);
  assert.deepEqual(issues(choice('Other'), choice('other way')).map(([path]) => path),
    ['decide.0.decide_choices.0.decide_choice', 'decide.0.decide_choices.1.decide_choice']);
  assert.match(issues(choice('Other'))[0]![1]!, /^"Other" is an answer word the app keeps: .*always offered/);
  assert.deepEqual(issues(choice('Stopwatch'), choice('Others first'), choice('中止'), choice('それ以外')), []);
  // One recommendation a question: the second is refused where it is written, naming the first.
  assert.deepEqual(issues(choice('A 案', { decide_choice_recommended: '早い' }), choice('B'), choice('C', { decide_choice_recommended: '安い' })),
    [['decide.0.decide_choices.2.decide_choice_recommended', 'Only one choice of a question is recommended; "A 案" already is']]);
  // Each question is checked on its own: the same first word or a recommendation in another question is no clash.
  assert.equal(check({ decide: [{ decide_kind: 'choose', decide_question: 'q1', decide_choices: [choice('A', { decide_choice_recommended: 'x' })] },
    { decide_kind: 'choose', decide_question: 'q2', decide_choices: [choice('A', { decide_choice_recommended: 'y' })], decide_stop: 'Nothing ships' }] }).success, true);
});

test('the JSON Schema a writer reads carries each field title and how to write it on the field', () => {
  const schema = valuesJsonSchema(DEFAULT_SCHEMA, catalog) as { properties: Record<string, { title?: string; description?: string; anyOf?: unknown[] }>; additionalProperties: boolean };
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(Object.keys(schema.properties), [...DEFAULT_SCHEMA]);
  // The title and how to write it sit on the field itself, not inside its value-or-null choice.
  const goal = schema.properties.goal!;
  assert.equal(goal.title, 'Goal'); assert.match(goal.description!, /deciding sign/);
  assert.doesNotMatch(JSON.stringify(goal.anyOf), /deciding sign/);
});

test('one size per field: the words a writer reads and the most a write holds (about 1.3 times, at least one more) both come from it', () => {
  assert.deepEqual([1, 3, 5, 60, 600].map(hardLimit), [2, 4, 7, 78, 780]);
  const def = (over: Partial<FieldDef>): FieldDef => ({ id: 'risk', title: 'Risk', type: 'text', many: false, maxChars: 60, maxItems: null,
    hint: '要点を書く。', members: [], required: false, ...over });
  assert.equal(sizeNote(def({})), 'About 60 characters.');
  assert.equal(sizeNote(def({ many: true, maxItems: 5 })), 'About 60 characters each, up to 5 items.');
  assert.equal(sizeNote(def({ maxChars: null })), '');
  // A size the workspace sets is said and checked the same way as a shipped one.
  const risk = def({ many: true, maxItems: 5 }), own = fieldCatalog([risk]);
  const field = (valuesJsonSchema(['risk'], own) as { properties: { risk: { description: string; anyOf: unknown[] } } }).properties.risk;
  assert.equal(field.description, 'About 60 characters each, up to 5 items. 要点を書く。');
  assert.match(JSON.stringify(field.anyOf), /"maxItems":7/);
  assert.match(JSON.stringify(field.anyOf), /"maxLength":78/);
  const refused = schemaOf(['risk'], own).safeParse({ risk: Array(8).fill('r') });
  assert.equal(refused.error?.issues[0]?.message, 'At most 7 items (aim for about 5)');
  // The shipped hints leave the size to these words, so no field says a size twice.
  for (const shipped of catalog.values()) assert.doesNotMatch(shipped.hint, /About \d+ characters?|[Uu]p to \d+ items?/, shipped.id);
});

test('values read in schema order, every field under its own heading, lists one item a line, and questions in the fixed question form', () => {
  const values: TaskValues = { notes: '一段目\n\n二段目', goal: 'g', conditions: ['c1', 'c2'],
    decide: [{ decide_kind: 'choose', decide_question: 'どれにするか', decide_choices: [
      { decide_choice: 'A 案', decide_choice_detail: '一行\n\n二行', decide_choice_recommended: '早い' },
      { decide_choice: 'B 案' }, { decide_choice: 'C 案', decide_choice_recommended: '安い' }],
    decide_note: '共通の前提\n二行目', decide_stop: 'ここで止める\n何も残らない' }, { decide_kind: 'choose', decide_question: '次' }, { decide_kind: 'choose', decide_question: '止めるか', decide_stop: '止める' }] };
  // A question's and a choice's first text (the note, the description) read as written; a later one is led by its title.
  const questions = ['### 1 どれにするか', '#### A 案', '一行', '', '二行', 'Recommended: 早い', '#### B 案', '#### C 案', 'Recommended: 安い', '',
    '共通の前提\n二行目', '', 'Stop: ここで止める\n何も残らない', '', 'Kind: choose', '', '### 2 次', 'Kind: choose', '', '### 3 止めるか', 'Stop: 止める', 'Kind: choose'];
  assert.equal(renderContext(DEFAULT_SCHEMA, values, catalog), [
    '## Goal', 'g', '', '## Done conditions', '- c1', '- c2', '',
    '## Questions', ...questions, '',
    '## Notes', '一段目', '', '二段目'].join('\n'));
  assert.equal(renderItems(catalog.get('decide')!, values.decide!, catalog), questions.join('\n'));
  // A question's full text is its items by the shipped definitions, whatever a workspace's catalog adds.
  assert.equal(questionText(values.decide as Parameters<typeof questionText>[0]), questions.join('\n'));
  assert.equal(questionText([{ decide_question: 'Colour', decide_note: '### 1 Which colour?\n#### Red\nStands out' }]),
    '### 1 Colour\n### 1 Which colour?\n#### Red\nStands out');
  // A field outside the schema stays stored but is not shown.
  assert.equal(renderContext(['goal', 'decide', 'notes', 'conclusion', 'user_instructions'], { pr: ['u'], goal: 'g' }, catalog), '## Goal\ng');
});

test('a stored row for a shipped field gives only its required, a workspace field stands as stored, and bad member sets are named', () => {
  const custom = (def: Partial<FieldDef> & { id: string }): FieldDef => ({ title: 't', type: 'text', many: false, maxChars: 10,
    maxItems: null, hint: '', members: [], required: false, ...def });
  const edited = fieldCatalog([custom({ id: 'goal', hint: '新しい書き方', required: true }), custom({ id: 'risk', hint: 'x' })]);
  assert.deepEqual(edited.get('goal'), { ...catalog.get('goal')!, required: true });
  assert.equal(edited.get('risk')!.hint, 'x');
  const bad = fieldCatalog([
    custom({ id: 'loop_a', type: 'schema', maxChars: null, members: ['loop_b'] }),
    custom({ id: 'loop_b', type: 'schema', maxChars: null, members: ['loop_a'] }),
    custom({ id: 'listed', type: 'schema', maxChars: null, members: ['policy'] }),
    custom({ id: 'lost', type: 'schema', maxChars: null, members: ['missing'] }),
  ]);
  const problems = catalogProblems(bad);
  assert.ok(problems.some(problem => problem.message === 'Members form a cycle'));
  assert.ok(problems.some(problem => problem.path === 'listed.members' && /single text/.test(problem.message)));
  assert.ok(problems.some(problem => problem.path === 'lost.members' && problem.message === 'Unknown field missing'));
});

test('the same values hash alike whatever order their keys were written in', () => {
  assert.equal(canonicalValues({ b: '1', a: [{ y: '1', x: '2' }] }), canonicalValues({ a: [{ x: '2', y: '1' }], b: '1' }));
});

test('a later text member is led by its title, a list of texts under it; an empty recommendation is none', () => {
  const def = (id: string, more: Partial<FieldDef> = {}): FieldDef =>
    ({ id, title: id.toUpperCase(), type: 'text', many: false, maxChars: 100, maxItems: null, hint: '', members: [], required: false, ...more });
  const catalog = fieldCatalog([def('risk', { type: 'schema', maxChars: null, members: ['name', 'body', 'steps'] }), def('name'), def('body'),
    def('steps', { many: true, maxItems: 5 })]);
  assert.equal(renderItems(catalog.get('risk')!, { name: 'N', body: 'B\n\nB2', steps: ['x', 'y'] }, catalog), '### N\nB\n\nB2\nSTEPS:\n- x\n- y');
  assert.equal(check({ decide: [{ decide_kind: 'choose', decide_question: 'q', decide_choices: [{ decide_choice: 'A', decide_choice_recommended: ' ' },
    { decide_choice: 'B', decide_choice_recommended: 'why' }] }] }).success, true);
});

test('an answer is read item by item against the question as asked: labels lead a line or follow a label, never sit inside words', () => {
  const decide = [{ decide_question: 'Ship', decide_choices: [{ decide_choice: 'Now' }, { decide_choice: 'Later sometime', decide_choice_recommended: 'safer' }] },
    { decide_question: 'Name' }, { decide_question: 'Go on', decide_stop: 'Nothing ships' }];
  assert.deepEqual(readAnswerParts(decide, 'T3（Ship it） 1-Later。 2-other Call it Atlas\n3-stop'), { words: true, items: [
    { n: 1, kind: 'choice', choice: 2, recommended: true, words: false }, { n: 2, kind: 'other', words: true }, { n: 3, kind: 'stop', words: false }] });
  // A label quoted inside the words is words, and a word that names no choice is unread.
  assert.deepEqual(readAnswerParts(decide, 'The 1-Later in the log was a quote; hold it').items[0], { n: 1, kind: 'unread', words: false });
  assert.deepEqual(readAnswerParts(decide, '1-Soon').items[0], { n: 1, kind: 'unread', words: false });
});
