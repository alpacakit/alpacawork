import { expect, test, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { TestWorkspace, screenData } from './fixtures';
import { readConversationThroughOwner, served, setConversationState, snapshotJson, SERVED } from './conversation-fixture';
import { useInputDraft } from '../src/features/coordinator/editor/draft';
import { commitDrafts, draftKey, readDrafts, updateDraft, useDraftStore } from '../src/features/forms/draft-store';
import { begin, freeze, holds, outgoingKey, reconcileOutbox, refuse, settleInterrupted, takeBack, useOutbox } from '../src/features/coordinator/editor/outbox';
import { draftDocument, serialize, textDocument } from '../src/features/coordinator/editor/document';
const key = draftKey('/fixture', 'coordinator', 'conversation');
const entry = (text: string, requestId = crypto.randomUUID()) => ({ status: 'editing' as const, values: { doc: JSON.stringify(textDocument(text)), requestId } });
function seed() {
  screenData();
  const entries = { [key]: entry('Coordinator body') };
  sessionStorage.setItem('alpacawork-input-drafts-v10', JSON.stringify({ version: 6, entries }));
  useDraftStore.setState(readDrafts());
  return entries;
}

const fixed = (text: string) => ({ conversationId: 'conversation', text, attachments: ['a.txt'] });
const next = (requestId = crypto.randomUUID()) => ({ doc: JSON.stringify(textDocument('')), phase: 'prepared', requestId });
const draftText = (entry: { values: Record<string, string> } | undefined) => entry && serialize(draftDocument(entry.values));

test('the press fixes the request and retains the input in one write; nothing new is sent while it is unresolved, and its answer cannot overwrite the next draft', () => {
  seed();
  const sent = useDraftStore.getState().entries[key]!.values.requestId!;
  expect(freeze('/fixture', fixed('Fixed text'), useDraftStore.getState().entries[key]?.values ?? {}, { from: key })).toBe(sent);
  const stored = readDrafts().entries;
  expect(JSON.parse(stored[outgoingKey('/fixture', sent)]!.values.submitted!).text).toBe('Fixed text');
  expect(stored[outgoingKey('/fixture', sent)]!.values.stage).toBe('queued');
  const fresh = stored[key]!.values;
  expect(fresh.doc).toContain('Coordinator body'); expect(fresh.requestId).not.toBe(sent);
  expect(holds(stored, '/fixture', 'conversation')).toBe(true);
  // The unchanged input cannot send twice. An edited next request joins behind it.
  expect(freeze('/fixture', fixed('Fixed text'), fresh, { from: key })).toBeNull();
  useDraftStore.setState({ entries: { ...stored, [key]: { status: 'editing', values: { ...fresh, doc: JSON.stringify(textDocument('Second time')) } } } });
  const second = freeze('/fixture', fixed('Second time'), useDraftStore.getState().entries[key]?.values ?? {}, { from: key });
  expect(second).toBe(fresh.requestId); expect(begin('/fixture', second!)).toBeNull();
  refuse('/fixture', second!, 'Cancel isolated second request');
  const attempt = begin('/fixture', sent)!;
  expect(begin('/fixture', sent)).toBeNull();
  expect(useOutbox.getState().live.has(`ask:${outgoingKey('/fixture', sent)}`)).toBe(true);
  // Written meanwhile (the person's draft, lifecycle.ts): a refusal keeps the request in the thread and leaves the new words alone.
  useDraftStore.setState({ entries: { ...useDraftStore.getState().entries, [key]: { status: 'editing', values: { ...fresh, phase: 'composing', doc: JSON.stringify(textDocument('New text')) } } } });
  expect(refuse('/fixture', sent, 'Reason')).toBe('kept'); attempt.finish();
  expect(draftText(readDrafts().entries[key])).toBe('New text');
  expect(readDrafts().entries[outgoingKey('/fixture', sent)]!.values.stage).toBe('refused');
  // Refused, it no longer holds the next one; it goes back only into an empty input.
  expect(holds(readDrafts().entries, '/fixture', 'conversation')).toBe(false);
  expect(takeBack('/fixture', sent)).toBe(false);
  useDraftStore.setState({ entries: { ...useDraftStore.getState().entries, [key]: { status: 'editing', values: next() } } });
  expect(takeBack('/fixture', sent)).toBe(true);
  expect(readDrafts().entries[key]!.values.requestId).not.toBe(sent);
  expect(draftText(readDrafts().entries[key])).toBe('Coordinator body');
  expect(readDrafts().entries[outgoingKey('/fixture', sent)]).toBeUndefined();
});

test('refused before anything else is written, the words and files go back at once under a fresh request ID; a snapshot holding the turn settles it', () => {
  seed();
  useDraftStore.setState({ entries: { ...useDraftStore.getState().entries, [key]: { status: 'editing', values: { ...useDraftStore.getState().entries[key]!.values, seen: 'T9', attachments: JSON.stringify([{ name: 'a.txt', size: 1, path: 'attachments/x/a.txt', absolutePath: '/x' }]) } } } });
  const original = useDraftStore.getState().entries[key]!.values;
  freeze('/fixture', fixed('Fixed text'), useDraftStore.getState().entries[key]?.values ?? {}, { from: key });
  expect(refuse('/fixture', original.requestId!, 'Reason')).toBe('restored');
  // As it was sent, the person's again; what the screen has seen since is kept.
  expect(readDrafts().entries[key]!.values).toEqual({ ...original, requestId: expect.any(String), phase: 'composing', seen: 'T9', seenProject: '' });
  const again = useDraftStore.getState().entries[key]!.values.requestId!; expect(again).not.toBe(original.requestId);
  freeze('/fixture', fixed('Fixed text'), useDraftStore.getState().entries[key]?.values ?? {}, { from: key });
  reconcileOutbox({ id: 'conversation', nextLaunch: { agent: 'claude', values: {} }, ...SERVED, busy: false, admitted: {}, cancelled: [], turns: [] }, '/fixture', null);
  expect(holds(readDrafts().entries, '/fixture', 'conversation')).toBe(true);
  // Its turn as sent: the same words, context and files.
  const turn = { id: again, at: '', ask: 'Fixed text', attachments: ['a.txt'], status: 'queued' as const, waiting: true, answer: null, seen: false, answeredAt: null, error: null, result: null };
  // Another conversation's snapshot, read but not drawn, settles nothing of it, though it holds a turn under its ID (a
  // drawn one would be of the open conversation, so the request went with a cleared one).
  reconcileOutbox(served({ id: 'other', nextLaunch: { agent: 'claude', values: {} }, ...SERVED, busy: false, admitted: {}, cancelled: [], turns: [turn] }), '/fixture', null, false);
  expect(holds(readDrafts().entries, '/fixture', 'conversation')).toBe(true);
  reconcileOutbox(served({ id: 'conversation', nextLaunch: { agent: 'claude', values: {} }, ...SERVED, busy: false, admitted: {}, cancelled: [], turns: [turn] }), '/fixture', null);
  expect(readDrafts().entries[outgoingKey('/fixture', again)]?.values.stage).toBe('accepted');
  expect(holds(readDrafts().entries, '/fixture', 'conversation')).toBe(false);
  reconcileOutbox(served({ id: 'conversation', nextLaunch: { agent: 'claude', values: {} }, ...SERVED, busy: true, admitted: {}, cancelled: [], turns: [{ ...turn, status: 'running', waiting: false }] }), '/fixture', null);
  expect(readDrafts().entries[outgoingKey('/fixture', again)]).toBeUndefined();
});

test('reload during checks: nothing went, so it goes back to the input; a posted send after reload is resent unchanged, not checked again', () => {
  seed(); const first = useDraftStore.getState().entries[key]!.values.requestId!;
  freeze('/fixture', fixed('Checking'), useDraftStore.getState().entries[key]?.values ?? {}, { from: key });
  begin('/fixture', first);
  useDraftStore.setState(readDrafts()); useOutbox.setState({ live: new Set() });
  settleInterrupted('/fixture', 'Interrupted');
  expect(readDrafts().entries[key]!.values.requestId).not.toBe(first);
  expect(draftText(readDrafts().entries[key])).toBe('Coordinator body');
  useDraftStore.setState(readDrafts());
  const second = useDraftStore.getState().entries[key]!.values.requestId!;
  freeze('/fixture', fixed('Sent text'), useDraftStore.getState().entries[key]?.values ?? {}, { from: key });
  const a = begin('/fixture', second)!; expect(a.checked).toBe(false); expect(a.check()).toBe('posted'); a.finish();
  useDraftStore.setState(readDrafts());
  settleInterrupted('/fixture', 'Interrupted');
  const b = begin('/fixture', second)!; expect(b.checked).toBe(true); expect(b.fixed.text).toBe('Sent text'); b.finish();
  expect(holds(readDrafts().entries, '/fixture', 'conversation')).toBe(true);
});

for (const stage of ['checking', 'posted', 'accepted', 'refused'] as const) test(`closure retains refused recovery and discards other nonlive outgoing (${stage}); input facts and other workspaces survive`, () => {
  seed(); useOutbox.setState({ live: new Set() });
  const original = { ...useDraftStore.getState().entries[key]!.values, attachments: JSON.stringify([{ name: 'a.txt', path: 'attachments/original/a.txt', size: 1 }]) };
  const fresh = { ...next(), doc: JSON.stringify(textDocument('Next unsent words')), attachments: JSON.stringify([{ name: 'next.txt', path: 'attachments/next/next.txt', size: 2 }]) };
  const id = freeze('/fixture', fixed('Original fixed words'), original, { from: key })!;
  commitDrafts({ ...readDrafts().entries, [key]: { status: 'editing', values: fresh } });
  const sentKey = outgoingKey('/fixture', id);
  const sent = { ...readDrafts().entries[sentKey]!, values: { ...readDrafts().entries[sentKey]!.values, stage } };
  const elsewhere = outgoingKey('/other-workspace', id);
  expect(commitDrafts({ ...readDrafts().entries, [sentKey]: sent, [elsewhere]: sent })).toBe(true);
  const snapshot = (id: string) => ({ id, nextLaunch: { agent: 'claude', values: {} }, ...SERVED, busy: false, admitted: {}, cancelled: [], turns: [] });
  // Absence in the open conversation settles nothing; a snapshot not drawn cannot establish closure.
  reconcileOutbox(snapshot('conversation'), '/fixture', null);
  expect(readDrafts().entries[sentKey]).toEqual(sent);
  reconcileOutbox(snapshot('replacement'), '/fixture', null, false);
  expect(readDrafts().entries[sentKey]).toEqual(sent);
  // A live attempt survives even a drawn replacement, with its exact fixed words/files/ID.
  useOutbox.setState({ live: new Set([`ask:${sentKey}`]) });
  reconcileOutbox(snapshot('replacement'), '/fixture', null);
  expect(readDrafts().entries[sentKey]).toEqual(sent);
  useOutbox.setState({ live: new Set() });
  reconcileOutbox(snapshot('replacement'), '/fixture', null);
  if (stage === 'refused') expect(readDrafts().entries[sentKey]).toEqual(sent);
  else expect(readDrafts().entries[sentKey]).toBeUndefined();
  expect(readDrafts().entries[key]).toEqual({ status: 'editing', values: fresh });
  expect(readDrafts().entries[elsewhere]).toEqual(sent);
});

test('v7 project-qualified storage is not read or rewritten by the v10 editor', () => {
  const raw = JSON.stringify({ version: 6, entries: { [draftKey('/fixture', 'request', 'alp/T3')]: entry('old words') } });
  sessionStorage.setItem('alpacawork-input-drafts-v7', raw);
  expect(readDrafts()).toEqual({ entries: {}, unavailable: false });
  expect(sessionStorage.getItem('alpacawork-input-drafts-v7')).toBe(raw);
});

test('v8 storage, which could hold a draft of the removed title input, is not read or rewritten by the v10 editor', () => {
  const raw = JSON.stringify({ version: 6, entries: { [draftKey('/fixture', 'title', 'T3')]: { status: 'editing', values: { title: 'old words' }, expected: 'hash', original: 'old' },
    [key]: entry('Coordinator body') } });
  sessionStorage.setItem('alpacawork-input-drafts-v8', raw);
  sessionStorage.removeItem('alpacawork-input-drafts-v10');
  expect(readDrafts()).toEqual({ entries: {}, unavailable: false });
  expect(sessionStorage.getItem('alpacawork-input-drafts-v8')).toBe(raw);
});

test('v9 storage, which could hold a draft of the removed create input, is not read or rewritten by the v10 editor', () => {
  const raw = JSON.stringify({ version: 6, entries: { [draftKey('/fixture', 'create', 'P100')]: { status: 'editing', values: { title: 'old words' }, expected: 'hash' },
    [key]: entry('Coordinator body') } });
  sessionStorage.setItem('alpacawork-input-drafts-v9', raw);
  sessionStorage.removeItem('alpacawork-input-drafts-v10');
  expect(readDrafts()).toEqual({ entries: {}, unavailable: false });
  expect(sessionStorage.getItem('alpacawork-input-drafts-v9')).toBe(raw);
});

/** A retained store holding `entry` under `key`, read as the input reads it at the start. */
const stored = (key: string, entry: object) => {
  sessionStorage.setItem('alpacawork-input-drafts-v10', JSON.stringify({ version: 6, entries: { [key]: entry } }));
  return readDrafts();
};

test('a retained draft of an input that no longer exists is let go alone; the drafts of the inputs that remain are still read', () => {
  // Inputs that no longer exist, each with what it kept: the request, the one without a responsible, the title and the
  // body editor (a Task's values are its agents' to write). The removed input's name is built here, so that only this
  // check of an old draft key names it.
  const removed = { [draftKey('/fixture', 'request', 'T3')]: entry('old words'),
    [draftKey('/fixture', ['owner', 'less'].join(''), 'T3')]: entry('old words'),
    [draftKey('/fixture', 'title', 'T3')]: { status: 'editing', values: { title: 'old words' }, expected: 'hash' },
    [draftKey('/fixture', 'edit', 'T3')]: { status: 'editing', values: { values: '{}' }, expected: 'hash' } };
  const kept = entry('Coordinator body');
  sessionStorage.setItem('alpacawork-input-drafts-v10', JSON.stringify({ version: 6, entries: { ...removed, [key]: kept } }));
  expect(readDrafts()).toEqual({ entries: { [key]: kept }, unavailable: false });
  expect(stored(draftKey('/fixture', 'edit', 'T3'), removed[draftKey('/fixture', 'edit', 'T3')]!)).toEqual({ entries: {}, unavailable: false });
});

test('a retained coordinator draft holds its words in its document alone; one without it makes the store unavailable', () => {
  const key = draftKey('/fixture', 'coordinator', 'conversation'), kept = entry('Retained text');
  expect(stored(key, kept)).toEqual({ entries: { [key]: kept }, unavailable: false });
  expect(stored(key, { status: 'editing', values: { body: 'Retained text', requestId: kept.values.requestId } })).toEqual({ entries: {}, unavailable: true });
  expect(stored(key, { status: 'editing', values: { doc: '{}', requestId: kept.values.requestId } })).toEqual({ entries: {}, unavailable: true });
});

test('a retained project draft holds its name, folder and parent; without any one of them the store is unavailable', () => {
  const key = draftKey('/fixture', 'project', null);
  const values = { name: 'alpacawork', cwd: '/fixture/alpacawork', parent: 'P100' };
  expect(stored(key, { status: 'editing', values })).toEqual({ entries: { [key]: { status: 'editing', values } }, unavailable: false });
  for (const field of ['name', 'cwd', 'parent'] as const) {
    const { [field]: _left, ...rest } = values;
    expect(stored(key, { status: 'editing', values: rest }), field).toEqual({ entries: {}, unavailable: true });
  }
});

// A page reloaded with a send's checks cut off, words written under 'loading' meanwhile: its conversation arrives once.
test('the conversation arriving settles what a reload left, before the input moves its loading words over', async () => {
  seed(); const sent = useDraftStore.getState().entries[key]!.values.requestId!;
  freeze('/fixture', fixed('Checking'), useDraftStore.getState().entries[key]?.values ?? {}, { from: key });
  begin('/fixture', sent);
  const loading = draftKey('/fixture', 'coordinator', 'loading');
  commitDrafts({ ...useDraftStore.getState().entries, [loading]: { status: 'editing', values: { doc: JSON.stringify(textDocument('Typed while loading')), phase: 'composing', requestId: crypto.randomUUID() } } });
  useDraftStore.setState(readDrafts()); useOutbox.setState({ live: new Set() });
  setConversationState({ conversation: null });
  const { result } = renderHook(() => useInputDraft(), { wrapper: ({ children }) => <TestWorkspace data={screenData()}>{children}</TestWorkspace> });
  // Nothing is settled before there is a conversation.
  expect(readDrafts().entries[outgoingKey('/fixture', sent)]?.values.stage).toBe('checking');
  act(() => setConversationState({ root: '/fixture', conversation: { id: 'conversation', nextLaunch: { agent: 'claude', values: {} }, ...SERVED, busy: false, admitted: {}, cancelled: [], turns: [] } }));
  await waitFor(() => expect(result.current.key).toBe(key));
  expect(readDrafts().entries[outgoingKey('/fixture', sent)]).toBeUndefined();
  expect(readDrafts().entries[loading]).toBeUndefined();
  expect(draftText(readDrafts().entries[key])).toBe('Coordinator body\nTyped while loading');
});

test('what a reload left is settled by the conversation arriving, whichever surfaces are drawn', async () => {
  cleanup(); seed(); const sent = useDraftStore.getState().entries[key]!.values.requestId!;
  freeze('/fixture', fixed('Checking'), useDraftStore.getState().entries[key]?.values ?? {}, { from: key });
  begin('/fixture', sent);
  setConversationState({ root: '/fixture', conversation: null });
  useDraftStore.setState(readDrafts()); useOutbox.setState({ live: new Set() });
  expect(readDrafts().entries[outgoingKey('/fixture', sent)]?.values.stage).toBe('checking');
  // Through the read's own path, as the page reads it.
  vi.stubGlobal('fetch', vi.fn(async () => new Response(snapshotJson({ id: 'conversation', nextLaunch: { agent: 'claude', values: {} }, ...SERVED, busy: false, admitted: {}, cancelled: [], turns: [] }))));
  await readConversationThroughOwner({ id: 'conversation', nextLaunch: { agent: 'claude', values: {} }, ...SERVED, busy: false, admitted: {}, cancelled: [], turns: [] });
  vi.unstubAllGlobals();
  await waitFor(() => expect(readDrafts().entries[outgoingKey('/fixture', sent)]).toBeUndefined());
  expect(draftText(readDrafts().entries[key])).toBe('Coordinator body');
});

for (const change of ['append', 'words', 'label', 'file', 'fresh', 'quote'] as const) test(`accepted structured input preserves later edits: ${change}`, () => {
  seed();
  const source = { type: 'doc' as const, content: [{ type: 'paragraph' as const, content: [
    { type: 'skillLabel' as const, attrs: { name: 'alpacawork', invocation: '/' as const } },
    { type: 'text' as const, text: ' First' }, { type: 'hardBreak' as const }, { type: 'text' as const, text: 'line' },
  ] }] };
  const file = { name: 'a.txt', size: 1, path: 'attachments/original/a.txt', absolutePath: '/original/a.txt' };
  const later = { name: 'b.txt', size: 2, path: 'attachments/later/b.txt', absolutePath: '/later/b.txt' };
  const id = crypto.randomUUID(), submitted = { conversationId: 'conversation', text: '/alpacawork First\nline', attachments: ['a.txt'], skills: ['alpacawork'] };
  useDraftStore.setState({ entries: { [key]: { status: 'editing', values: { requestId: id, doc: JSON.stringify(source), attachments: JSON.stringify([file]) } } } });
  freeze('/fixture', submitted, useDraftStore.getState().entries[key]!.values, { from: key });
  const doc = structuredClone(source);
  if (change === 'words') doc.content[0]!.content[1] = { type: 'text', text: ' Changed' };
  if (change === 'label') doc.content[0]!.content[0] = { type: 'skillLabel', attrs: { name: 'other', invocation: '/' } };
  const appended = { type: 'paragraph' as const, content: [{ type: 'skillLabel' as const, attrs: { name: 'next', invocation: '/' as const } }, { type: 'text' as const, text: ' Next', marks: [{ type: 'readerOperation' as const }] }] };
  if (change === 'quote') doc.content.push(structuredClone(source.content[0]!));
  doc.content.push(appended);
  const current = { ...useDraftStore.getState().entries[key]!.values, doc: JSON.stringify(doc),
    attachments: JSON.stringify([change === 'file' ? { ...file, path: 'attachments/replaced/a.txt' } : file, later]),
    ...change === 'fresh' ? { requestId: crypto.randomUUID() } : {} };
  updateDraft(key, { values: current });
  const server = served({ id: 'conversation', nextLaunch: { agent: 'claude', values: {} }, ...SERVED, busy: false, admitted: {}, cancelled: [], turns: [{ id, ask: submitted.text, skills: submitted.skills, attachments: ['a.txt'], at: '', status: 'queued' as const, waiting: true, seen: false, answer: null, answeredAt: null, error: null, result: null }] });
  // Undrawn and then drawn acceptance must consume exactly once.
  reconcileOutbox(server, '/fixture', key, false); reconcileOutbox(server, '/fixture', key);
  const result = useDraftStore.getState().entries[key]!.values;
  if (change === 'words' || change === 'label' || change === 'fresh') expect(result).toEqual(current);
  else {
    if (change === 'quote') expect(draftText({ values: result })).toBe('/alpacawork  First\nline\n/next  Next');
    else expect(draftText({ values: result })).toBe('/next  Next');
    expect(JSON.parse(result.doc!).content.at(-1)).toEqual(appended);
    expect(JSON.parse(result.attachments!)).toEqual(change === 'file' ? [{ ...file, path: 'attachments/replaced/a.txt' }, later] : [later]);
    expect(result.requestId).toBe(current.requestId);
  }
});

test('refusal of a repeated structural portion keeps the whole input without a second refused copy', () => {
  seed(); const source = entry('Repeat.');
  useDraftStore.setState({ entries: { [key]: source } });
  const id = freeze('/fixture', { conversationId: 'conversation', text: 'Repeat.', attachments: [] }, source.values, { from: key })!;
  const draft = useDraftStore.getState().entries[key]!;
  const current = { ...draft.values, doc: JSON.stringify(textDocument('Repeat.Repeat.')) };
  updateDraft(key, { values: current });
  expect(refuse('/fixture', id, 'Refused')).toBe('restored');
  expect(draftText(useDraftStore.getState().entries[key])).toBe('Repeat.Repeat.');
  expect(useDraftStore.getState().entries[outgoingKey('/fixture', id)]).toBeUndefined();
});
