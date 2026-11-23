import { setConversationState } from './conversation-fixture';
import { labelled } from './fixtures';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { cleanup } from '@testing-library/react';
import { answeredQuestions, documentSchema, emptyDocument, hasContent, inlines, replyTo, replyIn, serialize, textDocument } from '../src/features/coordinator/editor/document';
import { contentPieces, piecesContent } from '../src/features/coordinator/editor/clip';
import { previewContent } from '../src/features/coordinator/DraftPreview';
import { begin, freeze, refuse, isolateConflicts, outgoingKey, useOutbox } from '../src/features/coordinator/editor/outbox';
import { draftKey, useDraftStore } from '../src/features/forms/draft-store';
import { useConversation } from '../src/features/coordinator/coordinator';

const reply = { id: '11111111-1111-4111-8111-111111111111', answeredAt: '2026-10-22T11:00:00Z' };
const other = { ...reply, id: '22222222-2222-4222-8222-222222222222' };
const root = '/fixture', cid = 'conversation', key = draftKey(root, 'coordinator', cid);
beforeEach(() => { sessionStorage.clear(); useDraftStore.setState({ entries: {}, unavailable: false }); useOutbox.setState({ live: new Set() }); setConversationState({ root, conversation: { id: cid, nextLaunch: { agent: 'claude', values: {} }, warm: 'none' as const, busy: false, turns: [], cancelled: [] } }); });
afterEach(cleanup);

test('the document owns one replaceable reply; putting it in takes Task labels off and keeps everything else', () => {
  const original = labelled(textDocument('Read [this](/tmp/file).'), { id: 'T315', title: 'Other context' });
  const doc = replyTo(original, reply);
  expect(replyIn(doc)).toEqual(reply); expect(inlines(doc).filter(node => node.type === 'taskLabel')).toEqual([]);
  expect(serialize(doc, 'codex')).toBe('Read [this](/tmp/file).');
  expect(answeredQuestions(doc)).toEqual({});
  expect(replyTo(doc, reply)).toBe(doc);
  const next = replyTo(doc, other); expect(replyIn(next)).toEqual(other);
  expect(inlines(next).filter(node => node.type === 'replyLabel')).toHaveLength(1);
  expect(() => documentSchema.parse({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'replyLabel', attrs: reply }, { type: 'replyLabel', attrs: other }] }] })).toThrow();
  expect(hasContent(replyTo(emptyDocument(), reply))).toBe(false);
  expect(previewContent(doc).labels[0]?.type).toBe('replyLabel');
});

test('every Task label comes off at each press; project labels, answers, skills and IDs in words stay', () => {
  const answer = { question: 'L1', task: 'T9', n: '1', name: 'A', answer: '1A' };
  const skill = inlines(documentSchema.parse({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'skillLabel', attrs: { name: 'letmesketch', invocation: '/' } }] }] }))[0]!;
  const doc = documentSchema.parse({ type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'taskLabel', attrs: { id: 'T315', title: 'One' } }, { type: 'taskLabel', attrs: { id: 'P273', title: 'Project' } }, { type: 'text', text: ' see T42 first' }] },
    { type: 'paragraph', content: [{ type: 'taskLabel', attrs: { id: 'T400', title: 'Two' } }, { type: 'answerLabel', attrs: answer }, skill] },
  ] });
  const replied = replyTo(doc, reply);
  expect(inlines(replied).map(node => node.type === 'taskLabel' ? node.attrs.id : node.type)).toEqual(['replyLabel', 'P273', 'text', 'answerLabel', 'skillLabel']);
  expect(inlines(replied).find(node => node.type === 'text')).toEqual({ type: 'text', text: ' see T42 first' });
  // The same reply pressed again after a Task label was put back takes that label off too.
  const again = replyTo(documentSchema.parse({ ...replied, content: [...replied.content, { type: 'paragraph', content: [{ type: 'taskLabel', attrs: { id: 'T7', title: 'Later' } }] }] }), reply);
  expect(inlines(again).filter(node => node.type === 'taskLabel').map(node => node.type === 'taskLabel' && node.attrs.id)).toEqual(['P273']);
  expect(replyIn(again)).toEqual(reply);
});

test('reply uniqueness spans paragraphs, including empty paragraphs', () => {
  const paragraphs = [
    { type: 'paragraph' },
    { type: 'paragraph', content: [{ type: 'text', text: 'words' }] },
    { type: 'paragraph', content: [] },
  ];
  expect(documentSchema.safeParse({ type: 'doc', content: paragraphs }).success).toBe(true);
  const oneReply = [...paragraphs, { type: 'paragraph', content: [{ type: 'replyLabel', attrs: reply }] }];
  expect(documentSchema.safeParse({ type: 'doc', content: oneReply }).success).toBe(true);
  const result = documentSchema.safeParse({ type: 'doc', content: [...oneReply, { type: 'paragraph', content: [{ type: 'replyLabel', attrs: other }] }] });
  expect(result.success).toBe(false);
  if (!result.success) expect(result.error.issues).toEqual([{ code: 'custom', path: [], message: 'Only one reply label is allowed' }]);
});

test('clipboard projection cannot recreate a reply reference', () => {
  const copied = contentPieces(replyTo(textDocument('words'), reply).content);
  expect(copied.pieces).toEqual([{ kind: 'text', text: 'words' }]);
  const pasted = piecesContent(copied.pieces, () => undefined, () => undefined, () => undefined);
  expect(replyIn(documentSchema.parse({ type: 'doc', content: pasted }))).toBeUndefined();
});

test('refusal never replaces a newly selected reply-only draft; resend keeps the fixed reference', () => {
  const doc = replyTo(textDocument('reply words'), reply), values = { doc: JSON.stringify(doc), requestId: 'request-1' };
  useDraftStore.setState({ entries: { [key]: { status: 'editing', values } } });
  const fixed = { conversationId: cid, text: 'reply words', attachments: [], replyTo: reply.id };
  expect(freeze(root, fixed, values, { from: key })).toBe('request-1');
  useDraftStore.setState({ entries: { ...useDraftStore.getState().entries, [key]: { status: 'editing', values: { requestId: 'request-2', doc: JSON.stringify(replyTo(emptyDocument(), other)) } } } });
  const attempt = begin(root, 'request-1')!; expect(attempt.fixed.replyTo).toBe(reply.id); attempt.finish();
  expect(refuse(root, 'request-1', 'rejected')).toBe('kept');
  expect(replyIn(documentSchema.parse(JSON.parse(useDraftStore.getState().entries[key]!.values.doc!)))).toEqual(other);
  expect(useDraftStore.getState().entries[outgoingKey(root, 'request-1')]!.values.stage).toBe('refused');
});

test('a snapshot with a different reply under the same ID cannot settle the outbox', () => {
  const doc = replyTo(textDocument('reply words'), reply), values = { doc: JSON.stringify(doc), requestId: 'request-1' };
  useDraftStore.setState({ entries: { [key]: { status: 'editing', values } } });
  freeze(root, { conversationId: cid, text: 'reply words', attachments: [], replyTo: reply.id }, values);
  const conflicts = isolateConflicts({ id: cid, nextLaunch: { agent: 'claude', values: {} }, busy: false, warm: 'none' as const, cancelled: [], turns: [{ id: 'request-1', ask: 'reply words', attachments: [], replyTo: { ...other, head: '' } } as any] }, root, 'conflict');
  expect(conflicts.has('request-1')).toBe(true);
});
