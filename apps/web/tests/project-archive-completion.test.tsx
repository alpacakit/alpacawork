import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { DEFAULT_SCHEMA } from '@alpacawork/contract';
import { ProjectDialog } from '../src/features/panels/ProjectDialog';
import { DialogHost } from '../src/features/shell/DialogHost';
import { Toaster } from '../src/components/ui/toaster';
import { useDirectWriteRecovery } from '../src/features/reader/recovery';
import { useDialogStore } from '../src/state/dialog-store';
import { useWriteIntentStore, readWriteIntents, submitWriteIntent, checkWriteIntent } from '../src/data/write-intent';
import { projectArchiveIntentKey } from '../src/features/archive/archive-operations';
import { queryClient } from '../src/data/query-client';
import { receiveFullIndex } from '../src/data/resources';
import { ApiError } from '../src/data/client';
import { useToasts } from '../src/lib/notify';
import { draftKey, useDraftStore, commitDrafts } from '../src/features/forms/draft-store';
import { TestWorkspace, tree, project, dto, screenData, viewsOf, indexOf, PROJECT_TASK , fieldList } from './fixtures';
import { setupForms, answer, deferred, refusal, written } from './forms-fixture';

setupForms();
const first = project({ body: 'Original first draft' });
const second = dto({ kind: 'project', id: 'P200', parentId: null, title: 'Second', body: 'Original second draft' });
const key = projectArchiveIntentKey('/fixture', first.id);
function Recovery() { useDirectWriteRecovery(); return <Toaster />; }
const field = () => document.getElementById('project-policy') as HTMLTextAreaElement;
const notificationCheck = () => document.querySelector<HTMLElement>('[data-toast] button[data-toast-pin="action"]')
  ?? [...document.querySelectorAll<HTMLElement>('[data-toast] button')].find(button => button.textContent === 'Check');

async function fixture(initial: string | null = first.id, bare = false) {
  let source = tree({ tasks: [first, second] });
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
    if (String(url).includes('/api/task/view')) return answer(viewsOf(source).find(view => String(url).includes(view.task.id)));
    if (String(url).includes('/api/commands/field/list')) return answer(fieldList());
    if (String(url).includes('/api/commands/field/get')) return answer({ task: PROJECT_TASK, from: null, fields: [...DEFAULT_SCHEMA], version: 'v'.repeat(64), schema: {} });
    return refusal(404);
  });
  useDialogStore.getState().openProject(initial);
  const part = () => <TestWorkspace data={screenData(source)}>{bare ? <ProjectDialog project={initial} /> : <DialogHost />}<Recovery /></TestWorkspace>;
  const mounted = render(part());
  await waitFor(() => expect(field()?.value).toBe(first.values?.project_policy));
  return { fetcher, ...mounted, removeFirst: async () => {
    source = tree({ tasks: [{ ...first, lifecycle: 'archived' }, second] });
    mounted.rerender(part());
    await waitFor(() => expect(field()).toBeNull());
  } };
}
function admit(send: () => Promise<unknown> = async () => undefined) {
  return submitWriteIntent(key, () => ({ task: first.id, expectedTaskHash: first.hash }), send, undefined, undefined,
    { path: 'task/archive', response: 'task', label: first.title })!;
}
async function unknown() {
  await act(async () => { await admit(async () => { throw new ApiError('Lost response', 'unavailable', 'check'); }).catch(() => {}); });
}
async function openAgain(id: string | null = first.id) {
  act(() => useDialogStore.getState().openProject(id));
  await waitFor(() => expect(field()?.value).toBe(id === second.id ? second.values?.project_policy : first.values?.project_policy));
}
const newDraft = 'Keep the later opening’s unsaved words';
function typeDraft() { fireEvent.change(field(), { target: { value: newDraft } }); }
function keptDraft() {
  expect(useDialogStore.getState().dialog?.kind).toBe('project');
  expect(field()?.value).toBe(newDraft);
}

test('SSE removes the archive section before notification Check; only confirmation ends the original dialog', async () => {
  const f = await fixture();
  await unknown();
  const saved = structuredClone(useWriteIntentStore.getState().entries[key]);
  await f.removeFirst();
  expect(document.querySelector('[data-project-archive]')).toBeNull();
  expect(useDialogStore.getState().dialog?.kind).toBe('project');
  f.fetcher.mockResolvedValue(written({ ...first, lifecycle: 'archived' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Check' }));
  await waitFor(() => expect(useDialogStore.getState().dialog).toBeNull());
  expect(useWriteIntentStore.getState().entries[key]).toMatchObject({ status: 'confirmed', operationId: saved!.operationId, payload: saved!.payload });
});

test('batched synchronous success ends the original opening without a pending render', async () => {
  await fixture();
  await act(async () => { await admit(); });
  expect(useDialogStore.getState().dialog).toBeNull();
});

test('archived from Settings\' Projects, the dialog goes back to that list', async () => {
  act(() => useDialogStore.getState().open('settings', { tab: 'projects' }));
  await fixture();
  await act(async () => { await admit(); });
  expect(useDialogStore.getState().dialog).toMatchObject({ kind: 'settings', tab: 'projects' });
});

test('archive ends only the editing draft and preserves the stored create-project draft', async () => {
  await fixture();
  const createKey = draftKey('/fixture', 'project', null);
  const draft = { values: { name: 'Unsent new project', cwd: '/later', parent: 'none', color: '#39659b' }, status: 'editing' as const };
  act(() => { expect(commitDrafts({ [createKey]: draft })).toBe(true); });
  const storage = sessionStorage.getItem('alpacawork-input-drafts-v10');
  await act(async () => { await admit(); });
  expect(useDialogStore.getState().dialog).toBeNull();
  expect(useDraftStore.getState().entries[createKey]).toEqual(draft);
  expect(sessionStorage.getItem('alpacawork-input-drafts-v10')).toBe(storage);
});

test('two archive presses before rerender send once and the confirmed operation still ends the opening', async () => {
  const f = await fixture();
  const slow = deferred();
  f.fetcher.mockImplementation(async url => String(url).includes('/api/commands/task/archive') ? slow.promise : refusal(404));
  fireEvent.click(document.querySelector('[data-project-archive] button')!);
  const submit = document.querySelector('[data-archive-submit]')!;
  act(() => { fireEvent.click(submit); fireEvent.click(submit); });
  await waitFor(() => expect(f.fetcher.mock.calls.filter(([url]) => String(url).includes('/api/commands/task/archive'))).toHaveLength(1));
  await act(async () => { slow.answer(written({ ...first, lifecycle: 'archived' })); });
  await waitFor(() => expect(useDialogStore.getState().dialog).toBeNull());
});

test.each(['unknown', 'refused', 'conflict'] as const)('a %s answer never ends the dialog', async failure => {
  await fixture();
  const retry = { unknown: 'check', refused: 'fix', conflict: 'reread' } as const;
  await act(async () => { await admit(async () => { throw new ApiError(failure, 'fixture', retry[failure]); }).catch(() => {}); });
  if (failure === 'unknown') await act(async () => {
    await checkWriteIntent(key, async () => { throw new ApiError('Still unknown', 'fixture', 'check'); })?.catch(() => {});
  });
  expect(useDialogStore.getState().dialog?.kind).toBe('project');
  expect(field()?.value).toBe(first.values?.project_policy);
});

test.each(['normal', 'Check'] as const)('Escape then a different modal survives a late %s success', async kind => {
  const f = await fixture();
  const slow = deferred();
  if (kind === 'Check') await unknown();
  f.fetcher.mockImplementation(async url => String(url).includes('/api/commands/task/archive') ? slow.promise : refusal(404));
  fireEvent.click(document.querySelector('[data-project-archive] button')!);
  fireEvent.click(document.querySelector('[data-archive-submit]')!);
  await waitFor(() => expect(useWriteIntentStore.getState().entries[key]?.status).toBe('pending'));
  fireEvent.keyDown(document, { key: 'Escape' });
  act(() => { useDialogStore.getState().close(); useDialogStore.getState().open('diagnostics'); });
  await act(async () => { slow.answer(written({ ...first, lifecycle: 'archived' })); });
  await waitFor(() => expect(useWriteIntentStore.getState().entries[key]?.status).toBe('confirmed'));
  expect(useDialogStore.getState().dialog?.kind).toBe('diagnostics');
});

test.each(['late normal', 'late Check', 'Check started after B opens'] as const)('same-project opening B retains its draft: %s', async kind => {
  await fixture();
  let settle!: () => void;
  if (kind !== 'late normal') await unknown();
  const checkNotice = useToasts.getState().toasts.find(toast => toast.id.startsWith('write-intent:'))?.action;
  let pending: Promise<unknown> | undefined;
  if (kind !== 'Check started after B opens') act(() => {
    const send = () => new Promise<void>(resolve => { settle = resolve; });
    pending = kind === 'late normal' ? admit(send) : checkWriteIntent(key, send);
  });
  act(() => useDialogStore.getState().close());
  await openAgain();
  typeDraft();
  if (kind === 'Check started after B opens') {
    // The real notice entrance creates a new attempt of A's old operation while B is already open.
    vi.mocked(globalThis.fetch).mockResolvedValue(written({ ...first, lifecycle: 'archived' }));
    // An older notice is covered by B, but its existing action may still be invoked by a retained caller.
    expect(checkNotice).toBeDefined();
    act(() => checkNotice!.run());
    await waitFor(() => expect(useWriteIntentStore.getState().entries[key]?.status).toBe('confirmed'));
  } else await act(async () => { settle(); await pending; });
  keptDraft();
});

test('same mount openProject replacement ends A’s draft and does not adopt its pending operation', async () => {
  await fixture(first.id, true);
  let settle!: () => void;
  let pending!: Promise<unknown>;
  act(() => { pending = admit(() => new Promise<void>(resolve => { settle = resolve; })); });
  typeDraft();
  await openAgain();
  typeDraft();
  await act(async () => { settle(); await pending; });
  keptDraft();
});

test('manual target change cuts A’s operation association and preserves the other project’s new draft', async () => {
  await fixture(null);
  let settle!: () => void;
  let pending!: Promise<unknown>;
  act(() => { pending = admit(() => new Promise<void>(resolve => { settle = resolve; })); });
  fireEvent.change(document.getElementById('project-settings-target')!, { target: { value: second.id } });
  await waitFor(() => expect(field()?.value).toBe(second.values?.project_policy));
  typeDraft();
  await act(async () => { settle(); await pending; });
  keptDraft();
});

test('a removed implicit initial target never becomes projects[0] of another form', async () => {
  const f = await fixture(null);
  await f.removeFirst();
  expect(field()).toBeNull();
  expect(document.querySelector('[data-project-settings]')).toBeNull();
  expect(useDialogStore.getState().dialog?.kind).toBe('project');
});

test('reload retains recovery identity but gives no closing authority over a newly opened draft', async () => {
  const f = await fixture();
  await unknown();
  const stored = readWriteIntents();
  f.unmount();
  act(() => useWriteIntentStore.setState(stored));
  // After the reload the page checks the old fixed archive by itself; its answer arrives after a new draft is typed.
  const reads = f.fetcher.getMockImplementation()!, check = deferred();
  f.fetcher.mockImplementation(async (url, init) => String(url).includes('/api/commands/task/archive') ? check.promise : reads(url, init));
  useDialogStore.getState().openProject(first.id);
  render(<TestWorkspace data={screenData(tree({ tasks: [first, second] }))}><DialogHost /><Recovery /></TestWorkspace>);
  await waitFor(() => expect(field()?.value).toBe(first.values?.project_policy));
  typeDraft();
  await waitFor(() => expect(f.fetcher.mock.calls.some(([url]) => String(url).includes('/api/commands/task/archive'))).toBe(true));
  await act(async () => { check.answer(written({ ...first, lifecycle: 'archived' })); });
  await waitFor(() => expect(useWriteIntentStore.getState().entries[key]?.status).toBe('confirmed'));
  keptDraft();
});

test('read session replacement rejects the earlier success without clearing the new draft', async () => {
  await fixture();
  let settle!: () => void;
  let pending!: Promise<unknown>;
  act(() => { pending = admit(() => new Promise<void>(resolve => { settle = resolve; })); });
  act(() => receiveFullIndex(queryClient, { ...indexOf(tree({ tasks: [first, second] })), generation: 'other-session' }));
  typeDraft();
  await act(async () => { settle(); await pending; });
  keptDraft();
});
