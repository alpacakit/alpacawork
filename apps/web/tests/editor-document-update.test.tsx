import { expect, test } from 'vitest';
import { Schema, type Node } from '@tiptap/pm/model';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { history, undo, redo } from '@tiptap/pm/history';
import { documentUpdate } from '../src/features/coordinator/editor/document-update';

const schema = new Schema({
  nodes: { doc: { content: 'paragraph+' }, paragraph: { content: 'inline*' }, text: { group: 'inline' },
    label: { group: 'inline', inline: true, atom: true, attrs: { id: { default: '' } } },
    hardBreak: { group: 'inline', inline: true } },
  marks: { operation: {}, emphasis: {} },
});
const text = (value: string, marked = false) => schema.text(value, marked ? [schema.mark('operation')] : []);
const paragraph = (...nodes: Node[]) => schema.node('paragraph', null, nodes);
const doc = (...nodes: Node[]) => schema.node('doc', null, nodes);
const words = (value: string, marked = false) => doc(paragraph(text(value, marked)));
const at = (doc: Node, anchor: number, head = anchor) => EditorState.create({ doc,
  selection: TextSelection.create(doc, anchor, head), plugins: [history()] });

test('equal documents do not produce a transaction', () => {
  const original = words('Same words');
  expect(documentUpdate(at(original, 4), schema.nodeFromJSON(original.toJSON()))).toBeNull();
});
test('removing formatting preserves the direction and both ends of a selection', () => {
  const state = at(words('abcDEFghi', true), 7, 4), target = words('abcDEFghi');
  const update = documentUpdate(state, target)!;
  expect(update.doc.eq(target)).toBe(true);
  expect([update.selection.anchor, update.selection.head]).toEqual([7, 4]);
});
test('a long mark-only update does not fall back to replacing the whole draft', () => {
  const value = '日本語の長い下書き'.repeat(2000), target = words(value);
  const update = documentUpdate(at(words(value, true), 5000), target)!;
  expect(update.doc.eq(target)).toBe(true);
  expect(update.selection.from).toBe(5000);
  expect(update.steps.map(step => step.toJSON().stepType)).toEqual(['removeMark']);
});
test('two separated outside edits preserve a selection between them', () => {
  const original = words('prefix KEEP THIS SELECTED TEXT suffix');
  const target = words('NEWprefix KEEP THIS SELECTED TEXT suffixDONE');
  const update = documentUpdate(at(original, 27, 10), target)!;
  expect(update.doc.eq(target)).toBe(true);
  expect([update.selection.anchor, update.selection.head]).toEqual([30, 13]);
});
test('separated edits around a long draft also keep its unchanged middle', () => {
  const value = '長い文章です。'.repeat(2000);
  const target = words(`追加${value}末尾への追記`);
  const update = documentUpdate(at(words(value), 6000, 5000), target)!;
  expect(update.doc.eq(target)).toBe(true);
  expect([update.selection.anchor, update.selection.head]).toEqual([6002, 5002]);
});
test('same-type atoms with different attributes really change, without moving following text', () => {
  const make = (id: string) => doc(paragraph(text('before'), schema.node('label', { id }), text('after')));
  const target = make('T2'), update = documentUpdate(at(make('T1'), 10), target)!;
  expect(update.doc.eq(target)).toBe(true);
  expect(update.selection.from).toBe(10);
});
test('repeated characters have a valid insertion even when common ends overlap', () => {
  const target = words('aaaa'), update = documentUpdate(at(words('aaa'), 2), target)!;
  expect(update.doc.eq(target)).toBe(true);
  expect(update.selection.from).toBe(2);
});
test('paragraph insertion maps a selection along with its paragraph', () => {
  const original = doc(paragraph(text('one')), paragraph(text('two')));
  const target = doc(paragraph(text('before')), ...[0, 1].map(i => original.child(i)), paragraph(text('after')));
  const update = documentUpdate(at(original, 3), target)!;
  expect(update.doc.eq(target)).toBe(true);
  expect(update.selection.from).toBe(11);
});
test('content and formatting changes reach the exact target across block boundaries', () => {
  const examples = [doc(paragraph()), words('first'), words('first', true),
    doc(paragraph(text('A'), schema.node('hardBreak'), text('B', true))),
    doc(paragraph(schema.node('label', { id: 'T1' }), text('one', true)), paragraph(text('two'))),
    doc(paragraph(text('start', true)), paragraph(schema.node('label', { id: 'T2' }), text('end'))),
  ];
  for (const original of examples) for (const target of examples) {
    const update = documentUpdate(at(original, 1), target);
    expect((update?.doc ?? original).eq(target)).toBe(true);
  }
});
test('undo removes the typed words without an extra formatting event; redo keeps the edit', () => {
  const original = words('beforeAfter', true);
  let state = at(original, 7);
  state = state.apply(state.tr.insertText('追加'));
  const target = words('before追加After');
  state = state.apply(documentUpdate(state, target)!);
  expect(undo(state, tr => { state = state.apply(tr); })).toBe(true);
  expect(state.doc.eq(words('beforeAfter'))).toBe(true);
  expect(redo(state, tr => { state = state.apply(tr); })).toBe(true);
  expect(state.doc.eq(target)).toBe(true);
  expect(state.selection.from).toBe(9);
});
test('an outside answer addition keeps its existing undo behavior', () => {
  const original = words('Words');
  let state = at(original, 3);
  const target = doc(paragraph(schema.node('label', { id: 'answer' }), text('Words')));
  state = state.apply(documentUpdate(state, target)!);
  expect(undo(state, tr => { state = state.apply(tr); })).toBe(true);
  expect(state.doc.eq(original)).toBe(true);
});
