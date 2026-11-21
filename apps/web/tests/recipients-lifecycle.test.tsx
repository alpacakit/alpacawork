import { expect, test, vi } from 'vitest';
import { afterSend, closed, composing, edited, observed, restored } from '../src/features/coordinator/editor/lifecycle';
import { documentSchema, draftDocument, emptyDocument, taskLabel, taskReferencesIn, textDocument, toggleAnswer, type Document, type Inline } from '../src/features/coordinator/editor/document';
import { screenData, taskFixture, tree } from './fixtures';

// Every label is a recipient; what the screen opens changes a draft only while nothing of the person's is in it.
const T253 = { id: 'T253', title: 'Viewed task' }, T285 = { id: 'T285', title: 'Instructed task' }, T300 = { id: 'T300', title: 'Next task' };
const fresh = () => ({ doc: JSON.stringify(emptyDocument()), phase: 'prepared', requestId: 'r0' });
const labels = (values: Record<string, string>) => draftDocument(values).content.flatMap(block => block.content ?? [])
  .flatMap(node => node.type === 'taskLabel' ? [node.attrs.id] : []);
const words = (text: string, ...prefix: Inline[]): Document => ({ type: 'doc', content: [{ type: 'paragraph', content: [...prefix, { type: 'text', text }] }] });
const choice = { question: 'Q1', task: 'T285', n: '1', name: 'Option1', answer: '1-Option1' };
const FILE = JSON.stringify([{ name: 'a.png', path: 'a.png', absolutePath: '/f/a.png', size: 1 }]);
/** The screen with `task` in the panel and no project narrowing the list, or the list narrowed to `project` alone. */
const at = (task: { id: string; title: string }) => ({ panel: task, project: null }), inList = (project: { id: string; title: string }) => ({ panel: null, project });
const labelsOf = (...tasks: { id: string; title: string }[]): Document => ({ type: 'doc', content: [{ type: 'paragraph', content: tasks.map(task => taskLabel(task)) }] });

test('an untouched draft follows each newly opened Task; the Task already seen seeds nothing again', () => {
  let values = observed(fresh(), at(T285))!;
  expect(labels(values)).toEqual(['T285']); expect(values.phase).toBe('prepared');
  expect(observed(values, at(T285))).toBeNull();
  values = observed(values, at(T253))!;
  expect(labels(values)).toEqual(['T253']); expect(values.seen).toBe('T253');
});

test('once the person writes, chooses or takes one label of two off, opening Tasks only notes what is seen', () => {
  const seeded = observed(fresh(), at(T285))!;
  const cases: Record<string, string>[] = [
    edited(seeded, () => words('Do this', taskLabel(T285)))!.values,
    edited(seeded, current => toggleAnswer(current, T285, choice))!.values,
    edited(edited(seeded, () => labelsOf(T285, T300))!.values, () => labelsOf(T300))!.values,
  ];
  for (const values of cases) {
    const before = values.doc;
    const after = observed(values, at(T253))!;
    expect(after.doc).toBe(before); expect(after.seen).toBe('T253'); expect(after.phase).toBe('composing');
  }
  // Writing then erasing it all leaves the draft the person's: the label they kept is not handed back to the panel.
  const erased = edited(edited(seeded, () => words('x', taskLabel(T285)))!.values, () => draftDocument(seeded))!.values;
  expect(composing(erased)).toBe(true); expect(labels(observed(erased, at(T253))!)).toEqual(['T285']);
});

test.each<[string, (seeded: Record<string, string>) => Record<string, string>]>([
  ['its label taken off', seeded => edited(seeded, () => emptyDocument())!.values],
  ['every word and label erased', seeded => edited(edited(seeded, () => words('Do this', taskLabel(T285)))!.values, () => emptyDocument())!.values],
  ['only the space a typed label leaves', seeded => edited(seeded, () => textDocument(' '))!.values],
  ['only empty lines left', seeded => edited(seeded, () => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'hardBreak' }] }, { type: 'paragraph' }] }))!.values],
  ['nothing in a retained draft', () => ({ doc: JSON.stringify(emptyDocument()), requestId: 'retained', seen: 'T285' })],
])('with %s, another opened Task puts its label in; the Task it was seen on stays off', (_name, emptied) => {
  const values = emptied(observed(fresh(), at(T285))!);
  expect(observed(values, at(T285))).toBeNull();
  const next = observed(values, at(T253))!;
  expect(labels(next)).toEqual(['T253']); expect(next.phase).toBe('prepared'); expect(next.seen).toBe('T253');
});

test.each<[string, Document]>([
  ['words', textDocument('Keep')],
  ['a label', labelsOf(T300)],
  ['an answer alone', { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'answerLabel', attrs: choice }] }] }],
  ['a skill', { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'skillLabel', attrs: { name: 'review', invocation: '/' } }] }] }],
  ['a reply', { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'replyLabel', attrs: { id: 'r1', answeredAt: '2026-11-01T00:00:00Z' } }] }] }],
])('with %s left, an opened Task changes nothing', (_name, left) => {
  const values = edited(observed(fresh(), at(T285))!, () => left)!.values;
  const after = observed(values, at(T253))!;
  expect(after.doc).toBe(values.doc); expect(after.phase).toBe('composing'); expect(after.seen).toBe('T253');
});

test.each(['attachments', 'uploadOps'])('files (%s) do not hold the recipients: an opened Task still puts its label in, and the files stay', field => {
  const file = { [field]: field === 'attachments' ? FILE : '[{"opId":"u1"}]' };
  for (const values of [{ ...observed(fresh(), at(T285))!, ...file }, { ...edited(observed(fresh(), at(T285))!, () => emptyDocument())!.values, ...file }]) {
    const after = observed(values, at(T253))!;
    expect(labels(after)).toEqual(['T253']); expect(after[field]).toBe(values[field]);
  }
});

test('the list come back behind a closed panel seeds nothing; a project newly in view seeds, and seen again does not', () => {
  const P = { id: 'P100', title: 'Project' }, Q = { id: 'P200', title: 'Other project' };
  // A Task opened over the list of P, then its label taken off: neither layer opens anything again.
  const emptied = edited(observed(fresh(), { panel: T285, project: P })!, () => emptyDocument())!.values;
  expect(observed(emptied, inList(P))).toBeNull();
  expect(observed(emptied, { panel: T285, project: P })).toBeNull();
  // Another project chosen seeds it; the same project seen again (a reload) does not.
  const chosen = observed(emptied, inList(Q))!;
  expect(labels(chosen)).toEqual(['P200']);
  expect(observed(edited(chosen, () => emptyDocument())!.values, inList(Q))).toBeNull();
  // A written draft only notes the project.
  const written = edited(emptied, () => textDocument('Keep'))!.values;
  expect(observed(written, inList(Q))!.seenProject).toBe('P200');
  expect(observed(written, inList(Q))!.doc).toBe(written.doc);
  // A Task opened over the project chosen is new, the one taken off before included.
  expect(labels(observed(chosen, { panel: T285, project: Q })!)).toEqual(['T285']);
  // A project not known yet leaves the project seen as it was; the Task in the panel is observed alone.
  const waiting = observed(fresh(), { panel: T285 })!;
  expect(labels(waiting)).toEqual(['T285']); expect(waiting.seenProject ?? '').toBe('');
  expect(observed({ ...emptied, seenProject: 'P100' }, { panel: T285 })).toBeNull();
  // The panel left with its label all the draft held: the project behind seeds the fresh draft.
  expect(labels(observed(closed(observed(fresh(), { panel: T285, project: P })!, 'T285')!, inList(P))!)).toEqual(['P100']);
});

test('closing the panel takes off its Task\'s label when that is all the draft holds, put in by the screen or by hand', () => {
  for (const only of [observed(fresh(), at(T285))!, edited(fresh(), () => words(' ', taskLabel(T285)))!.values]) {
    const after = closed(only, 'T285')!;
    expect(labels(after)).toEqual([]); expect(after.phase).toBe('prepared');
    expect(labels(observed(after, at(T285))!)).toEqual(['T285']);
  }
  const seeded = observed(fresh(), at(T285))!;
  for (const values of [edited(seeded, () => words('Do', taskLabel(T285)))!.values, edited(seeded, () => labelsOf(T285, T300))!.values,
    edited(seeded, current => toggleAnswer(current, T285, choice))!.values]) expect(closed(values, 'T285')).toBeNull();
  expect(closed(seeded, 'T300')).toBeNull();
});

test('a reader draft emptied and seeded by another Task no longer belongs to its card', () => {
  const emptied: Record<string, string> = { ...edited(observed(fresh(), at(T285))!, () => emptyDocument())!.values, readerDraftTask: 'T285', readerDraftTurn: '{}' };
  const next = observed(emptied, at(T253))!;
  expect(next.readerDraftTask).toBeUndefined(); expect(next.readerDraftTurn).toBeUndefined();
  expect(next.requestId).toBe(emptied.requestId);
});

test('a change that changes nothing makes no phase', () => {
  const seeded = observed(fresh(), at(T285))!;
  expect(edited(seeded, current => current)).toBeNull();
});

test('a send keeps only the labels, prepared, with what was seen: the same panel adds nothing, a new Task replaces them', () => {
  // T285's label is being written to while T253 is open on the right.
  let values = observed(fresh(), at(T285))!;
  values = edited(values, () => toggleAnswer(words(' Go on', taskLabel(T285)), T285, choice))!.values;
  values = observed(values, at(T253))!;
  const next = afterSend(values, draftDocument(values));
  expect(labels(next)).toEqual(['T285']); expect(next.phase).toBe('prepared'); expect(next.seen).toBe('T253');
  expect(draftDocument(next).content[0]!.content!.every(node => node.type === 'taskLabel')).toBe(true);
  expect(next.requestId).not.toBe(values.requestId);
  expect(observed(next, at(T253))).toBeNull();
  expect(labels(observed(next, at(T300))!)).toEqual(['T300']);
});

test('a label taken off for a general question stays off on the same panel after the send', () => {
  let values = observed(fresh(), at(T253))!;
  values = edited(values, () => textDocument('What is a PWA?'))!.values;
  const next = afterSend(values, draftDocument(values));
  expect(labels(next)).toEqual([]); expect(observed(next, at(T253))).toBeNull();
  expect(labels(observed(next, at(T300))!)).toEqual(['T300']);
});

test('a refused send comes back as it was sent, the person\'s, with what is seen now', () => {
  const sent = { ...observed(fresh(), at(T285))!, phase: 'composing', doc: JSON.stringify(words(' Do', taskLabel(T285))) };
  const input = { ...afterSend(sent, draftDocument(sent)), seen: 'T253' };
  const back = restored(sent, input);
  expect(back.doc).toBe(sent.doc); expect(back.phase).toBe('composing'); expect(back.seen).toBe('T253');
});

test('recipients are labels, answers and Task IDs in prose; quotes, fences, code, URLs and titles promote none', () => {
  const { tasks } = screenData(tree({ tasks: ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9', 'T285'].map(id => taskFixture({ id, title: `Title ${id} (T9)` })) }));
  const doc: Document = { type: 'doc', content: [
    { type: 'paragraph', content: [taskLabel({ id: 'T285', title: 'Mentions T9' }), { type: 'text', text: ' see T1 and https://x.test/?task=T2' }] },
    { type: 'paragraph', content: [{ type: 'text', text: '> quoted T3' }] },
    { type: 'paragraph', content: [{ type: 'text', text: '```' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'T4 in a fence' }] },
    { type: 'paragraph', content: [{ type: 'text', text: '```' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'inline `T5` and 「T6」' }] },
    // A label at a line's start does not make the rest of the line a quote: "> T7" here is prose after the label.
    { type: 'paragraph', content: [taskLabel({ id: 'T8', title: 'x' }), { type: 'text', text: ' > T7' }] },
  ] };
  expect([...taskReferencesIn(doc, tasks)].sort()).toEqual(['T1', 'T285', 'T7', 'T8']);
  const answered = toggleAnswer(emptyDocument(), { id: 'T3', title: 'x' }, { ...choice, task: 'T3' });
  expect([...taskReferencesIn(answered, tasks)]).toEqual(['T3']);
});

// A retained draft has no evidence that the owner just prepared it. Its words are never a fresh screen seed.
test('only an explicitly prepared draft may have its recipients replaced by an opened Task', () => {
  const retained = { doc: JSON.stringify(words('Keep my draft', taskLabel(T285))), requestId: 'retained' };
  const next = observed(retained, at(T253))!;
  expect(next.doc).toBe(retained.doc);
  expect(next.phase).toBe('composing');
});

// Official labels carry IDs already chosen by the person; a live index is not their authority.
test.each(['task', 'answer'])('a retained %s label remains a target without a live Task row', kind => {
  const doc = kind === 'task' ? words('Do this', taskLabel(T285)) : toggleAnswer(emptyDocument(), T285, choice);
  expect([...taskReferencesIn(doc, [])]).toEqual(['T285']);
});


test('replacing a recovered answer releases its Task binding before general words are entered', () => {
  const original = { ...fresh(), phase: 'composing', doc: JSON.stringify(words('Recovered words', taskLabel(T285))),
    readerDraftTask: T285.id, readerDraftTurn: 'saved-turn' };
  const amended = edited(original, () => words('Amended words', taskLabel(T285)))!.values;
  expect(amended.readerDraftTask).toBe(T285.id);
  const cleared = edited(amended, emptyDocument)!.values;
  expect(cleared).not.toHaveProperty('readerDraftTask');
  expect(cleared).not.toHaveProperty('readerDraftTurn');
  const general = edited(cleared, () => textDocument('The next general draft'))!.values;
  expect(general).not.toHaveProperty('readerDraftTask');
  expect(labels(general)).toEqual([]);
});


test('editing reads once, runs an in-place transform once, and returns that same document for its saved values', () => {
  const values = { ...fresh(), seen: 'T285', readerDraftTask: 'T285' };
  const parse = vi.spyOn(documentSchema, 'parse');
  let transformed: Document | undefined;
  const transform = vi.fn((current: Document) => {
    transformed = current;
    current.content[0]!.content = [{ type: 'text', text: 'Changed', marks: [{ type: 'readerOperation' }] }];
    return current;
  });
  try {
    const result = edited(values, transform)!;
    expect(parse).toHaveBeenCalledTimes(1);
    expect(transform).toHaveBeenCalledTimes(1);
    expect(result.document).toBe(transformed);
    const { readerDraftTask: _oldBinding, ...unbound } = values;
    expect(result.values).toEqual({ ...unbound, phase: 'composing', doc: JSON.stringify(transformed) });
    expect(values).toEqual({ ...fresh(), seen: 'T285', readerDraftTask: 'T285' });
  } finally { parse.mockRestore(); }
});

test('editing compares normalized documents, retaining a prepared draft when only stored JSON formatting differs', () => {
  const values = { ...fresh(), doc: ' { "content": [{"type":"paragraph"}], "type": "doc" } ' };
  expect(edited(values, current => current)).toBeNull();
  expect(values.phase).toBe('prepared');
});
