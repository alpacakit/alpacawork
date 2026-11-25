import { answerTask } from './fixtures';
import { expect, test } from 'vitest';
import { answeredQuestions, answersIn, choiceAnswer, documentSchema, emptyDocument, filterDocument, hasContent, serialize, taskLabel, givenIn, wordsAfter, textDocument, toggleAnswer, type Document, type Inline } from '../src/features/coordinator/editor/document';
import { decideOf, offeredChoices } from '../src/domain/questions';
const task = { id: 'T3', title: 'Choose task labels and how suggestions open' };
/** A choice answering the question asked by Q1. */
const choice = (n: string, name: string) => ({ question: 'Q1', task: task.id, n, name, answer: `${n}-${name}` });
/** `doc` with `task`'s label first (the label an opened Task seeds). */
const labelled = (doc: Document, task: { id: string; title: string }): Document => ({ ...doc, content: [{ ...doc.content[0]!, content: [taskLabel(task), ...(doc.content[0]!.content ?? [])] }, ...doc.content.slice(1)] });
const doc = (...content: Inline[]): Document => ({ type: 'doc', content: [{ type: 'paragraph', content }] });

test('the exact specified example is sent in document order', () => {
  let value = labelled(textDocument('Short labels are easier to read.'), task);
  value = toggleAnswer(value, task, choice('2', 'Option2'));
  value = toggleAnswer(value, task, choice('1', 'Option1'));
  expect(serialize(value)).toBe('T3（Choose task labels and how suggestions open） 1-Option1 2-Option2 Short labels are easier to read.');
});
test('text spaces, URLs, paths, paragraphs and Japanese are preserved', () => {
  const text = 'keep  two  spaces /home/me\nhttps://example.com/a\n\n日本語';
  expect(serialize(textDocument(text))).toBe(text);
});
test('an answer separated by prose or another task retains its task ID', () => {
  const value = doc(taskLabel(task), { type: 'text', text: 'Regarding,' }, { type: 'answerLabel', attrs: choice('1', 'Option1') });
  expect(serialize(value)).toContain('Regarding, T3 1-Option1');
});
test('one question has at most one answer; pressing the same choice removes it', () => {
  const before = toggleAnswer(labelled(emptyDocument(), task), task, choice('1', 'Option1'));
  const next = toggleAnswer(before, task, choice('1', 'Option2'));
  expect(answersIn(next).map(a => a.answer)).toEqual(['1-Option2']);
  expect(answersIn(toggleAnswer(next, task, choice('1', 'Option2')))).toEqual([]);
});
test('Other is one question’s answer like its choices: it replaces that question’s choice only, and a choice replaces it', () => {
  let value = toggleAnswer(emptyDocument(), { id: 'T4', title: 'Other' }, { ...choice('1', 'Option1'), task: 'T4' });
  value = toggleAnswer(value, task, choice('1', 'Option1'));
  value = toggleAnswer(value, task, choice('2', 'Option2'));
  value = toggleAnswer(value, task, choice('2', 'other'));
  expect(answersIn(value, 'T4').map(a => a.answer)).toEqual(['1-Option1']);
  expect(answersIn(value, task.id).map(a => a.answer)).toEqual(['1-Option1', '2-other']);
  // Other stands at the draft's end, named with its task after another task's answers.
  expect(serialize(value)).toBe(`T3（${task.title}） 1-Option1 T4（Other） 1-Option1 T3 2-other`);
  expect(answersIn(toggleAnswer(value, task, choice('2', 'Option1')), task.id).map(a => a.answer)).toEqual(['1-Option1', '2-Option1']);
  expect(answersIn(toggleAnswer(value, task, choice('2', 'other')), task.id).map(a => a.answer)).toEqual(['1-Option1']);
});
test('Other goes at the draft’s end with the words written after it; a choice put in later goes before it', () => {
  // The person chose Other for question 1 and wrote what instead, then chose question 2.
  let value = toggleAnswer(labelled(emptyDocument(), task), task, choice('1', 'other'));
  value = { ...value, content: [{ ...value.content[0]!, content: [...value.content[0]!.content!, { type: 'text', text: 'NAS に置いて' }] }] };
  value = toggleAnswer(value, task, choice('2', 'Option1'));
  expect(serialize(value)).toBe(`T3（${task.title}） 2-Option1 1-other NAS に置いて`);
  // Words already written stay before an Other chosen afterwards: what follows it is written for it.
  let later = toggleAnswer(labelled(emptyDocument(), task), task, choice('1', 'Option1'));
  later = { ...later, content: [{ ...later.content[0]!, content: [...later.content[0]!.content!, { type: 'text', text: '補足' }] }] };
  later = toggleAnswer(later, task, choice('2', 'other'));
  expect(serialize(later)).toBe(`T3（${task.title}） 1-Option1 補足 T3 2-other`);
});
test('Other answers only with words after it, before the next chip', () => {
  const bare = toggleAnswer(labelled(emptyDocument(), task), task, choice('1', 'other'));
  expect(wordsAfter(bare, { task: task.id, question: 'Q1', n: '1' })).toBe(false);
  expect(givenIn(bare, task.id)).toEqual([]);
  const spaces = { ...bare, content: [{ ...bare.content[0]!, content: [...bare.content[0]!.content!, { type: 'text' as const, text: '   ' }] }] };
  expect(givenIn(spaces, task.id)).toEqual([]);
  const said = { ...bare, content: [...bare.content, { type: 'paragraph' as const, content: [{ type: 'text' as const, text: '次の行に書いた' }] }] };
  expect(givenIn(said, task.id).map(answer => answer.answer)).toEqual(['1-other']);
  const chosen = toggleAnswer(bare, task, choice('2', 'Option1'));
  expect(givenIn(chosen, task.id).map(answer => answer.answer)).toEqual(['2-Option1']);
});
test('deleting a task label cannot detach the identity of its remaining answer', () => {
  const value = toggleAnswer(emptyDocument(), task, choice('1', 'Option1'));
  expect(serialize(filterDocument(value, n => n.type !== 'taskLabel'))).toBe('T3 1-Option1');
});
test('a badge inserted in a later paragraph receives answers in that same paragraph', () => {
  const value: Document = { type: 'doc', content: [...textDocument('Previous text').content, { type: 'paragraph', content: [taskLabel(task), { type: 'text', text: 'Following text' }] }] };
  expect(serialize(toggleAnswer(value, task, choice('1', 'Option1')))).toBe(`Previous text\nT3（${task.title}） 1-Option1 Following text`);
});
test('only selected skill nodes are marked, by the mark their catalog gave them, whatever the agent is named', () => {
  const skill = (invocation: '/' | '$') => doc({ type: 'text', text: '/path/$file' }, { type: 'skillLabel', attrs: { name: 'alpacawork', invocation } });
  expect(serialize(skill('$'))).toBe('/path/$file $alpacawork');
  expect(serialize(skill('/'))).toBe('/path/$file /alpacawork');
});
test('labels alone do not enable send; answers do', () => {
  const value = labelled(emptyDocument(), task);
  expect(hasContent(value)).toBe(false);
  expect(hasContent(toggleAnswer(value, task, choice('1', 'Option1')))).toBe(true);
});
test('attachments share the send-content rule while whitespace and recipient labels remain empty', () => {
  const value = labelled(textDocument(' \n\t'), task);
  expect(hasContent(value, [])).toBe(false);
  expect(hasContent(value, [{ name: 'note.txt' }])).toBe(true);
  expect(hasContent(emptyDocument(), [{ name: 'note.txt' }])).toBe(true);
});
test('persisted and copied documents validate semantic identity', () => {
  expect(documentSchema.safeParse(doc({ type: 'taskLabel', attrs: { id: '../secret', title: '' } })).success).toBe(false);
  expect(documentSchema.safeParse({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'skillLabel', attrs: { name: 'fake' } }] }] }).success).toBe(false);
});

// The fixed question differs, so the same number is not the same answer.
test('the same number of another question of the Task is another answer: choosing it keeps the first, and each comes off alone', () => {
  const first = { ...choice('1', 'Option1'), question: 'Q1' }, second = { ...choice('1', 'Option1'), question: 'Q2' };
  let value = toggleAnswer(toggleAnswer(labelled(emptyDocument(), task), task, first), task, second);
  expect(answersIn(value).map(answer => answer.question)).toEqual(['Q1', 'Q2']);
  // Another choice of Q1's first replaces only Q1's, and Q1's next number goes beside Q1's answers.
  value = toggleAnswer(value, task, { ...choice('1', 'Option2'), question: 'Q1' });
  value = toggleAnswer(value, task, { ...choice('2', 'Option3'), question: 'Q1' });
  expect(answersIn(value).map(answer => [answer.question, answer.answer])).toEqual([['Q2', '1-Option1'], ['Q1', '1-Option2'], ['Q1', '2-Option3']]);
  expect(answersIn(toggleAnswer(value, task, second)).map(answer => answer.question)).toEqual(['Q1', 'Q1']);
});
// The wire text of Q1's and Q2's same choice is the same; what goes with it says which questions it answers.
test("a draft's choices go with every question they answer, each by its Task and ID; words alone name none", () => {
  const draft = (question: string) => toggleAnswer(labelled(emptyDocument(), task), task, { ...choice('1', 'Option1'), question });
  expect(serialize(draft('Q1'))).toBe(serialize(draft('Q2')));
  expect(answeredQuestions(draft('Q1'))).toEqual({ answers: [{ task: task.id, question: 'Q1' }] });
  expect(answeredQuestions(draft('Q2'))).toEqual({ answers: [{ task: task.id, question: 'Q2' }] });
  expect(answeredQuestions(toggleAnswer(draft('Q2'), task, { ...choice('2', 'Option2'), question: 'Q2' }))).toEqual({ answers: [{ task: task.id, question: 'Q2' }] });
  // Two questions of the same number on one Task, and a question of another Task: each is its own answer.
  const other = { id: 'T9', title: 'Other' };
  const both = toggleAnswer(toggleAnswer(draft('Q1'), task, { ...choice('1', 'Option2'), question: 'Q2' }), other, { ...choice('1', 'Option1'), task: other.id, question: 'Q7' });
  // In the words' order: T9's label goes before T3's.
  expect(serialize(both)).toMatch(/^T9（Other） 1-Option1 T3（.*） 1-Option1 1-Option2/);
  expect(answeredQuestions(both)).toEqual({ answers: [{ task: 'T9', question: 'Q7' }, { task: task.id, question: 'Q1' }, { task: task.id, question: 'Q2' }] });
  expect(answeredQuestions(labelled(textDocument('words'), task))).toEqual({});
});

test('history reads only task-adjacent answer runs and currently known skill names', async () => {
  const { splitMessage, taskTokens } = await import('../src/features/coordinator/editor/wire');
  const parts = splitMessage('T3（Title） 1-Option1 2-Option2 The body says 中止 rather than 2-3。2026-10-15 /tmp /known T4 中止', new Set(['known']), new Map([['T3', 'Title'], ['T4', 'Other']]));
  // 中止 after a task is words now: no press makes it an answer.
  expect(parts.filter(part => part.kind === 'answer').map(part => part.text)).toEqual(['1-Option1', '2-Option2']);
  expect(parts.filter(part => part.kind === 'skill').map(part => part.text)).toEqual(['/known']);
  expect(parts.map(part => part.text).join('')).toBe('T3（Title） 1-Option1 2-Option2 The body says 中止 rather than 2-3。2026-10-15 /tmp /known T4 中止');
  const typed = (text: string) => taskTokens(text, id => id === 'T4' ? { id: 'T4', title: '' } : undefined).length > 0;
  expect(typed('files/T4/')).toBe(false); expect(typed('C:\\T4の')).toBe(false);
  expect(typed('T4/')).toBe(false); expect(typed('T4\\\\')).toBe(false);
  expect(typed('T4の')).toBe(true);
  expect(splitMessage('T3 1-Option1 T13 中止', new Set(), new Map([['T3', 'One'], ['T13', 'Other']])).filter(part => part.kind === 'task').map(part => part.id)).toEqual(['T3', 'T13']);
});


test('two tasks keep separate answers and labels after a schema round trip', () => {
  const other = { id: 'T13', title: 'Another task' };
  let value = toggleAnswer(labelled(emptyDocument(), task), task, { ...choice('1', 'Option1'), question: 'Qfirst' });
  value = toggleAnswer(labelled(value, other), other, { ...choice('1', 'Option2'), task: other.id, question: 'Qother' });
  value = documentSchema.parse(value);
  expect(answersIn(value, task.id).map(answer => answer.question)).toEqual(['Qfirst']);
  expect(answersIn(value, other.id).map(answer => answer.question)).toEqual(['Qother']);
  value = toggleAnswer(value, other, { ...choice('1', 'other'), task: other.id, question: 'Qother' });
  expect(answersIn(value, task.id).map(answer => answer.answer)).toEqual(['1-Option1']);
  expect(answersIn(value, other.id).map(answer => answer.answer)).toEqual(['1-other']);
  const sent = serialize(filterDocument(value, node => node.type !== 'taskLabel'));
  expect(sent).toContain('T3 1-Option1'); expect(sent).toContain('T13 1-other');
});

test('known titles consume nested parentheses and tokens inside the complete title, without changing wire text', async () => {
  const { splitMessage } = await import('../src/features/coordinator/editor/wire');
  for (const title of ['Check API (draft)', 'Check） T4 中止 T3（note']) {
    const text = `T3（${title}） 1-Option1`;
    const parts = splitMessage(text, new Set(), new Map([['T3', title], ['T4', 'Other']]));
    expect(parts.filter(part => part.kind === 'task')).toEqual([{ kind: 'task', text: `T3（${title}）`, id: 'T3', title }]);
    expect(parts.filter(part => part.kind === 'answer').map(part => part.text)).toEqual(['1-Option1']);
    expect(parts.map(part => part.text).join('')).toBe(text);
  }
  const parts = splitMessage('T3（Old title） T4 中止 T3（note） 1-Option1', new Set(), new Map([['T3', 'New title']]));
  expect(parts.filter(part => part.kind === 'task').map(part => part.id)).toEqual(['T3', 'T4', 'T3']);
});



test('sent references use ID format without borrowing a title from another task', async () => {
  const { splitMessage } = await import('../src/features/coordinator/editor/wire');
  const tasks = new Map([['T4', 'Same title'], ['T5', 'Same title']]);
  const text = 'T3（Same title） 1-Option1';
  const parts = splitMessage(text, new Set(), tasks);
  expect(parts.find(part => part.kind === 'task')).toEqual({ kind: 'task', text: 'T3（Same title）', id: 'T3' });
  expect(parts.map(part => part.text).join('')).toBe(text);
  expect(splitMessage('unknown/T3（Same title） 1-Option1', new Set(), tasks).every(part => part.kind === 'text')).toBe(true);
  expect(splitMessage('T5（Same title） 1-Option1', new Set(), tasks).find(part => part.kind === 'task')?.id).toBe('T5');
});

/** What Q1 asks as the server fixed it when it was asked: the screen draws its choices from it alone. */
const asked = [
  { decide_kind: 'choose', decide_question: 'Storage location', decide_choices: [{ decide_choice: 'Option1 Local', decide_choice_detail: 'text' }], decide_stop: 'Nothing is stored' },
  { decide_kind: 'choose', decide_question: 'Color', decide_choices: [{ decide_choice: 'Blue', decide_choice_detail: 'text' }] }];

test('a choice of what the question fixed goes into the draft naming that question, as `<n>-<first word of its name>`', () => {
  const [first, second] = decideOf(asked);
  const local = choiceAnswer(answerTask(task), 'Q1', first!, first!.choices[0]!);
  expect(local).toEqual({ question: 'Q1', task: task.id, n: '1', name: 'Option1 Local', answer: '1-Option1' });
  // The question's Stop goes in the same way under the app's own word, named as the screen reads it.
  const [, stop] = offeredChoices(first!, { stop: 'Stop', other: 'Other' });
  expect(choiceAnswer(answerTask(task), 'Q1', first!, stop!)).toEqual({ question: 'Q1', task: task.id, n: '1', name: 'Stop', answer: '1-stop' });
  let value = toggleAnswer(labelled(emptyDocument(), task), task, local);
  value = toggleAnswer(value, task, choiceAnswer(answerTask(task), 'Q1', second!, second!.choices[0]!));
  expect(answersIn(value, task.id).map(answer => [answer.question, answer.n])).toEqual([['Q1', '1'], ['Q1', '2']]);
  expect(serialize(value)).toBe(`T3（${task.title}） 1-Option1 2-Blue`);
  // Only the draft holds it: pressing the same choice again takes it out.
  expect(answersIn(toggleAnswer(value, task, local), task.id).map(answer => answer.n)).toEqual(['2']);
});
