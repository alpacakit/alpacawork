import { expect, test } from 'vitest';
import { badged, edited, observed, offered, unbadged } from '../src/features/coordinator/editor/lifecycle';
import { aboutAutomation, automationIn, documentSchema, inlines, draftDocument, emptyDocument, serialize, taskLabel, taskReferencesIn, type Document, type Inline } from '../src/features/coordinator/editor/document';
import { splitMessage } from '../src/features/coordinator/editor/wire';
import { taskTokens } from '@alpacawork/contract/coordinator';

// An automation's badge names what a message is about, apart from its Tasks: at most one, a new one written as nothing.
const morning = { id: 'A2106', name: 'Daily） T12 reminder' } as const;
const fresh = () => ({ doc: JSON.stringify(emptyDocument()), phase: 'prepared', requestId: 'r0' });
const words = (text: string, ...prefix: Inline[]): Document => ({ type: 'doc', content: [{ type: 'paragraph', content: [...prefix, { type: 'text', text }] }] });

test("an opened automation's badge is sent as its number and as the message's automation, never as a Task", () => {
  const doc = aboutAutomation(words('make it 8:30', taskLabel({ id: 'T5', title: 'Five' })), morning);
  // Its name may hold any character, so the words carry only the number.
  expect(serialize(doc)).toBe('A2106 T5（Five） make it 8:30');
  expect(automationIn(doc)?.id).toBe('A2106');
  expect([...taskReferencesIn(doc, [])]).toEqual(['T5']);
  // A new automation has no number to write: the words stay the person's own.
  const asked = aboutAutomation(words('every morning at 9'), { id: 'new', name: '' });
  expect(serialize(asked)).toBe('every morning at 9');
  expect(automationIn(asked)?.id).toBe('new');
  // One badge at a time: another takes its place.
  const other = aboutAutomation(doc, { id: 'A7', name: 'Other' });
  expect(inlines(other).filter(node => node.type === 'automationLabel').map(node => node.type === 'automationLabel' && node.attrs.id)).toEqual(['A7']);
  expect(documentSchema.safeParse({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'automationLabel', attrs: { id: 'A35e399c8-0d1b', name: '' } }] }] }).success).toBe(false);
});

test("an opening fills only an untouched draft; a press puts its badge beside the person's words; leaving clears only a draft of the badge alone", () => {
  const opened = badged(fresh(), morning)!;
  expect(opened.phase).toBe('prepared');
  expect(automationIn(draftDocument(opened))).toEqual(morning);
  // The next opening takes its place, as a Task seed does; so does a Task opened over it.
  expect(automationIn(draftDocument(badged(opened, { id: 'new', name: '' })!))?.id).toBe('new');
  expect(automationIn(draftDocument(observed(opened, { panel: { id: 'T9', title: 'Nine' }, project: null })!))).toBeUndefined();
  const written = edited(opened, current => ({ ...current, content: [{ type: 'paragraph', content: [...current.content[0]!.content ?? [], { type: 'text', text: 'make it 8:30' }] }] }))!.values;
  // Browsing another automation leaves what they are writing addressed as it is.
  expect(badged(written, { id: 'A7', name: 'Other' })).toBeNull();
  const moved = badged(written, { id: 'A7', name: 'Other' }, true)!;
  expect(serialize(draftDocument(moved))).toBe('A7 make it 8:30');
  expect(unbadged(moved, null)).toBeNull();
  expect(unbadged(opened, morning.id)).toBeNull();
  expect(automationIn(draftDocument(unbadged(opened, 'A7')!))).toBeUndefined();
  expect(automationIn(draftDocument(unbadged(opened, null)!))).toBeUndefined();
});

test("a sent automation's number is one part with the name known for it; an annotation after a number names no Task", () => {
  const parts = (text: string) => splitMessage(text, new Set(), new Map([['T12', 'Twelve']]), new Map([[morning.id, morning.name]])).filter(part => part.kind !== 'text');
  expect(parts('A2106 make it 8:30')).toEqual([{ kind: 'automation', text: 'A2106', id: 'A2106', title: morning.name }]);
  expect(parts('A7 and A2106')).toEqual([{ kind: 'automation', text: 'A7', id: 'A7' }, { kind: 'automation', text: 'A2106', id: 'A2106', title: morning.name }]);
  // Any number the input's grammar reads is one, glued to the words or written wide; quotes and code name none.
  expect(parts('A2106を直して、Ａ７も')).toEqual([{ kind: 'automation', text: 'A2106', id: 'A2106', title: morning.name }, { kind: 'automation', text: 'Ａ７', id: 'A7' }]);
  expect(parts('「A2106」 `A7`\n> A8')).toEqual([]);
  // What the person wrote after a number stays their words.
  const said = splitMessage('A2106（昨日変更済み）も確認', new Set(), new Map(), new Map([[morning.id, morning.name]]));
  expect(said.map(part => part.text).join('')).toBe('A2106（昨日変更済み）も確認');
  expect(said.filter(part => part.kind === 'automation')).toEqual([{ kind: 'automation', text: 'A2106', id: 'A2106', title: morning.name }]);
  // Even a Task's number inside them.
  const noted = splitMessage('A2106（例は T113（注記） まで）も確認', new Set(), new Map([['T113', 'Task']]), new Map());
  expect(noted.map(part => part.text).join('')).toBe('A2106（例は T113（注記） まで）も確認');
  expect(noted.filter(part => part.kind !== 'text').map(part => part.kind)).toEqual(['automation']);
  const known = new Map([['T12', { id: 'T12', title: 'Twelve' }], ['A2106', { id: 'A2106', title: '' }]]);
  expect(taskTokens('A2106（Morning (T12) digest） make it T12', id => known.get(id)).map(token => token.id)).toEqual(['A2106', 'T12']);
  // An agent's internal number and a lower-case a are not automations.
  expect(taskTokens('A35e399c8-0d1b a2106', id => known.get(id) ?? { id, title: '' })).toEqual([]);
});

test("an example picked after asking for a new automation keeps the new automation's badge", () => {
  const asking = badged(fresh(), { id: 'new', name: '' }, true)!;
  const picked = offered(asking, { type: 'paragraph', content: [{ type: 'text', text: 'every morning at 9' }] })!;
  expect(automationIn(draftDocument(picked))?.id).toBe('new');
  expect(serialize(draftDocument(picked))).toBe('every morning at 9');
});
