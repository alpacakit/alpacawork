import { snapshotJson, SERVED } from './conversation-fixture';
import { setConversationState } from './conversation-fixture';
/** Use the store refresh caller which isolates, reconciles receipts and reconciles the outbox. */
import { coordinatorResultSchema } from '@alpacawork/contract/coordinator';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { queryClient } from '../src/data/query-client';
import { receiveFullIndex } from '../src/data/resources';
import { useConversation } from '../src/features/coordinator/coordinator';
import { availableInput, begin, freeze, hasSubmission, isolateConflicts, nextDelivery, outgoingKey, useOutbox, type Fixed } from '../src/features/coordinator/editor/outbox';
import { draftKey, useDraftStore } from '../src/features/forms/draft-store';
import { textDocument } from '../src/features/coordinator/editor/document';
import { screenData, tree, dto, indexOf } from './fixtures';
import { captureReaderSubmission, useReaderSend } from '../src/features/coordinator/reader-send';
import type { CoordinatorConversation, CoordinatorTurn } from '../src/data/coordinator';

const root = '/fixed-meaning', cid = 'same-conversation', id = 'same-request';
const key = draftKey(root, 'coordinator', cid);
const words = (requestId = id) => ({ doc: JSON.stringify(textDocument('same words')), requestId });
const base: Fixed = { conversationId: cid, text: 'same words', tasks: ['T1'], attachments: [] };
const answer = (question: string) => ({ answers: [{ task: 'T1', question }] });
const intent = (action: 'continue' | 'retry') => ({ intent: { task: 'T1', action } });
const snapshot = (meaning: Partial<CoordinatorTurn>): CoordinatorConversation => ({ id: cid, nextLaunch: { agent: 'claude', values: {} }, ...SERVED, busy: false, admitted: {}, cancelled: [],
  turns: [{ id, at: '2026-10-23T08:00:00Z', ask: base.text, tasks: base.tasks, attachments: [], status: 'queued', waiting: true,
    answer: null, seen: false, answeredAt: null, error: null, result: null, ...meaning }] });
beforeEach(() => {
  queryClient.clear(); receiveFullIndex(queryClient, indexOf(tree({ root })));
  setConversationState(useConversation.getInitialState());
  setConversationState({ root, conversation: { ...snapshot({}), turns: [] } });
  useReaderSend.setState({ receipts: new Map() });
  useOutbox.setState({ live: new Set(), resend: null });
  useDraftStore.setState({ unavailable: false, entries: { [key]: { status: 'editing', values: words() } } });
});
afterEach(() => { vi.unstubAllGlobals(); queryClient.clear(); setConversationState(useConversation.getInitialState()); useOutbox.setState({ live: new Set(), resend: null }); });
for (const [name, fixedMeaning, receivedMeaning] of [
  ['Q1 versus Q2', answer('Q1'), answer('Q2')],
  ['continue versus retry', intent('continue'), intent('retry')],
  ['answer omitted', answer('Q1'), {}],
  ['intent omitted', intent('continue'), {}],
] as const) test(`same ID/text/recipient, ${name}: no admission; real refresh isolates and keeps the frozen payload`, async () => {
  const fixed = { ...base, ...fixedMeaning };
  expect(freeze(root, fixed, words(), { from: key })).toBe(id);
  const attempt = begin(root, id)!; expect(attempt.check()).toBe('posted'); attempt.finish();
  const received = snapshot(receivedMeaning);
  const fetcher = vi.fn().mockResolvedValue(new Response(snapshotJson(received)));
  vi.stubGlobal('fetch', fetcher);
  // Observe each production entrance without building a second meaning comparator.
  expect.soft(hasSubmission(received, id, fixed)).toBe(false);
  await useConversation.getState().refresh();
  const kept = useDraftStore.getState().entries[outgoingKey(root, id)];
  expect.soft(kept?.values.stage).toBe('refused'); expect.soft(kept?.values.conflict).toBe('1');
  expect.soft(kept?.values.submitted).toBe(JSON.stringify(fixed));
  // Only after observing refresh's own effects, inspect the direct isolation entrance.
  expect.soft([...isolateConflicts(received, root, 'meaning differs')]).toEqual([id]);
  expect(nextDelivery(useDraftStore.getState().entries, root, cid)).toBeNull();
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
});
for (const [name, meaning] of [['Q1', answer('Q1')], ['continue', intent('continue')]] as const)
  test(`${name} exact meaning: refresh confirms once, settles and schedules zero resends`, async () => {
    const fixed = { ...base, ...meaning };
    expect(freeze(root, fixed, words(), { from: key })).toBe(id);
    const attempt = begin(root, id)!; expect(attempt.check()).toBe('posted'); attempt.finish();
    const received = snapshot(meaning);
    expect(hasSubmission(received, id, fixed)).toBe(true);
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(new Response(snapshotJson(received))));
    vi.stubGlobal('fetch', fetcher);
    await useConversation.getState().refresh(); await useConversation.getState().refresh();
    // The admitted payload may remain as a receipt while its input ownership has ended.
    expect(useDraftStore.getState().entries[outgoingKey(root, id)]?.values).toMatchObject({
      stage: 'accepted', submitted: JSON.stringify(fixed),
    });
    expect(begin(root, id)).toBeNull();
    const next = availableInput(useDraftStore.getState().entries, root, key)!;
    expect(JSON.parse(next.doc!)).toEqual(textDocument(''));
    expect(next.requestId).not.toBe(id);
    expect(nextDelivery(useDraftStore.getState().entries, root, cid)).toBeNull();
    expect(useConversation.getState().conversation?.turns.filter(turn => turn.id === id)).toHaveLength(1);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  });


for (const kind of ['answer', 'intent'] as const) for (const matches of [false, true])
  test(`reader receipt through refresh: ${kind}, matching=${matches}, confirmed only with frozen meaning`, async () => {
    const fixed = { ...base, ...(kind === 'answer' ? answer('Q1') : intent('continue')) };
    const doc = kind === 'answer' ? { type: 'doc' as const, content: [{ type: 'paragraph' as const, content: [
      { type: 'answerLabel' as const, attrs: { task: 'T1', question: 'Q1', n: '1', name: 'Yes', answer: '1-Yes' } },
    ] }] } : textDocument('continue');
    const capture = captureReaderSubmission(fixed, doc, screenData(tree({ root, tasks: [dto({ id: 'T1' })] })).tasks, id, { root, conversationId: cid }, undefined, null);
    expect(capture.reader).toHaveLength(1);
    expect(freeze(root, fixed, { ...words(), doc: JSON.stringify(doc) }, { from: key }, capture.reader)).toBe(id);
    capture(); const attempt = begin(root, id)!; expect(attempt.check()).toBe('posted'); attempt.finish();
    const result = coordinatorResultSchema.parse({ writes: [{ task: 'T1', record: 'result-log', toState: null, kind: kind === 'answer' ? 'answered' : 'request_accepted',
      ...(kind === 'answer' ? { question: 'Q1' } : {}) }], refused: [] });
    const incoming = snapshot({ ...(kind === 'answer' ? answer(matches ? 'Q1' : 'Q2') : intent(matches ? 'continue' : 'retry')),
      status: 'succeeded', waiting: false, answer: 'done', answeredAt: '2026-10-23T08:01:00Z', result });
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(new Response(snapshotJson(incoming)))); vi.stubGlobal('fetch', fetcher);
    await useConversation.getState().refresh();
    const receipt = [...useReaderSend.getState().receipts.values()][0]!;
    expect.soft(receipt.admitted).toBe(matches); expect.soft(receipt.status).toBe(matches ? 'confirmed' : 'pending');
    expect(useDraftStore.getState().entries[outgoingKey(root, id)]?.values.stage).toBe(matches ? 'settled' : 'refused');
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  });

for(const recorded of [{task:'T1',action:'approve'},{unknownHistorical:'preserve'}] as Record<string,string>[])
 test(`historical server intent through real refresh never proves admission: ${JSON.stringify(recorded)}`,async()=>{
  expect(freeze(root,base,words(),{from:key})).toBe(id);
  const attempt=begin(root,id)!;attempt.check();attempt.finish();
  const original=useDraftStore.getState().entries[outgoingKey(root,id)]!.values.submitted;
  const incoming=snapshot({intent:recorded});
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(snapshotJson(incoming))));
  await expect(useConversation.getState().refresh()).resolves.toBeUndefined();
  expect(useDraftStore.getState().entries[outgoingKey(root,id)]?.values).toMatchObject({stage:'refused',conflict:'1',submitted:original});
  expect(useConversation.getState().conversation?.turns[0]?.intent).toEqual(recorded);
  expect(useConversation.getState().conversation?.turns[0]?.ask).toBe(base.text);
 });
