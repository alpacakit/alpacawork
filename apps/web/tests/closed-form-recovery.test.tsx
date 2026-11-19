import { expect, test, vi, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MoveSection } from '../src/features/forms/MoveInputs';
import { ResponsibleSection } from '../src/features/forms/ResponsibleInputs';
import { DialogHost } from '../src/features/shell/DialogHost';
import { useDirectWriteRecovery } from '../src/features/reader/recovery';
import { Toaster } from '../src/components/ui/toaster';
import { useDialogStore } from '../src/state/dialog-store';
import { intentKey, readWriteIntents, useWriteIntentStore } from '../src/data/write-intent';
import { resumeDirectIntents } from '../src/data/direct-write';
import { queryClient } from '../src/data/query-client';
import { useViewStore } from '../src/state/view-store';
import { endSendGrace, flushSendGrace } from '../src/data/send-grace';
import { useUndoOffers } from '../src/data/undo-offers';
import { useDraftStore, draftKey, readDrafts, updateDraft } from '../src/features/forms/draft-store';
import { TestWorkspace, dto, screenData, tree } from './fixtures';
import { errorToasts, refusal, setupForms, written } from './forms-fixture';
import { i18n } from '@alpacawork/i18n';

setupForms();
const kinds = ['move','responsible','project'] as const;
type Kind = typeof kinds[number];
/** The Task each form but the project's writes. */
const subject = 'T1';
afterEach(() => { for (const offer of useUndoOffers.getState().offers) endSendGrace(offer.id); });
function Surface({kind,data}:{kind:Kind;data:ReturnType<typeof screenData>}) {
  useDirectWriteRecovery();
  const dialog = useDialogStore(state=>state.dialog), task=data.tasks[0]!;
  return <><DialogHost />
    {kind==='move' && <MoveSection task={task}/>}
    {kind==='responsible' && <ResponsibleSection task={task}/>}
    <Toaster /></>;
}
async function admitForm(kind:Kind) {
  window.__ALPACAWORK_WRITE_GRACE_MS__=5000;
  const fetcher=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>refusal(503));
  const data=screenData(tree({tasks:[dto(),dto({id:'T2',title:'Destination'})]}));
  if(kind==='project') useDialogStore.getState().openProject();
  else useDialogStore.getState().openInput({form:kind,taskId:subject});
  const surface = render(<TestWorkspace data={data}><Surface kind={kind} data={data}/></TestWorkspace>);
  if(kind==='move') fireEvent.change(await screen.findByLabelText('New parent'),{target:{value:'T2'}});
  if(kind==='project') fireEvent.change(await screen.findByLabelText('Name'),{target:{value:'New project'}});
  const submit=await screen.findByRole('button',{name:({move:'Move',responsible:'Assign',project:'Create'})[kind]});
  await waitFor(()=>expect((submit as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(submit);
  await waitFor(()=>expect(useDialogStore.getState().dialog).toBeNull());
  const key=intentKey('/fixture',kind==='project'?'project/new':kind,kind==='project'?null:subject);
  const entry=useWriteIntentStore.getState().entries[key]!;
  expect(entry.status).toBe('waiting');
  expect(useUndoOffers.getState().offers).toHaveLength(1);
  expect(fetcher.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(0);
  return {key,entry,fetcher,surface,data};
}
async function due() { await act(async()=>{flushSendGrace(document);}); }

test.each(kinds)('%s closes at admission and exposes one global check for an unknown result',async kind=>{
  const {key,entry,fetcher}=await admitForm(kind);
  await due();
  await waitFor(()=>expect(useWriteIntentStore.getState().entries[key]?.status).toBe('unconfirmed'));
  expect(useDialogStore.getState().dialog).toBeNull();
  expect(errorToasts()).toHaveLength(1);
  const notice=document.querySelector<HTMLElement>('[data-toast][data-kind="error"]')!;
  fireEvent.click(within(notice).getByRole('button',{name:'Check'}));
  await waitFor(()=>expect(fetcher.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(2));
  await waitFor(()=>expect(useWriteIntentStore.getState().entries[key]?.status).toBe('unconfirmed'));
  const posts=fetcher.mock.calls.filter(([,init])=>init?.method==='POST');
  expect(posts[0]![1]?.body).toBe(posts[1]![1]?.body);
  expect(new Headers(posts[1]![1]?.headers).get('X-Alpacawork-Op-Id')).toBe(entry.operationId);
  expect(errorToasts()).toHaveLength(1);
  expect(useUndoOffers.getState().offers).toHaveLength(0);
});

test.each(kinds)('%s undo after admission sends nothing and retains original form choices without a failure notice',async kind=>{
  const {key,entry,fetcher}=await admitForm(kind);
  await act(async()=>{expect(await useUndoOffers.getState().offers[0]!.undo()).toBe('cancelled');});
  await due();
  expect(useWriteIntentStore.getState().entries[key]?.status).toBe('cancelled');
  expect(useWriteIntentStore.getState().entries[key]?.draft).toBeTruthy();
  expect(fetcher.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(0);
  expect(errorToasts()).toHaveLength(0);
  if (kind === 'project') {
    expect(useDraftStore.getState().entries[formKey(kind)]).toMatchObject({ status: 'editing', values: entry.draft });
  }
});

test.each(kinds)('%s definite refusal after closing has one notice and a recovery entrance',async kind=>{
  const {key,entry,fetcher}=await admitForm(kind);
  fetcher.mockImplementation(async()=>refusal(409));
  await due();
  expect(useWriteIntentStore.getState().entries[key]?.status).toBe('conflict');
  expect(useDialogStore.getState().dialog).toBeNull();
  expect(errorToasts()).toHaveLength(1);
  const notice=document.querySelector<HTMLElement>('[data-toast][data-kind="error"]')!;
  fireEvent.click(within(notice).getByRole('button',{name:i18n.t('reader:recovery.latest')}));
  expect(useDialogStore.getState().dialog).not.toBeNull();
  expect(useWriteIntentStore.getState().entries[key]?.operationId).toBe(entry.operationId);
});

const draftedKinds = ['project'] as const;
function formKey(kind: typeof draftedKinds[number]) {
  return draftKey('/fixture', kind, null);
}
async function recoverForm(kind: typeof draftedKinds[number], path: 'initial' | 'check' | 'reload', newer = false, refused = false) {
  const admitted = await admitForm(kind), { key, entry, fetcher, surface } = admitted;
  const original = useDraftStore.getState().entries[formKey(kind)]!;
  if (path !== 'initial') {
    await due();
    expect(useWriteIntentStore.getState().entries[key]?.status).toBe('unconfirmed');
    expect(useDraftStore.getState().entries[formKey(kind)]).toEqual(original);
  }
  if (newer) act(() => {
    const field = 'name';
    updateDraft(formKey(kind), { values: { ...original.values, [field]: 'Newer input' } });
    // Even returning to the same words is a different edition, which the older result must not settle.
    updateDraft(formKey(kind), { values: { ...original.values } });
    useDialogStore.getState().openInput({ form: 'move', taskId: 'T2' });
  });
  const kept = useDraftStore.getState().entries[formKey(kind)]!;
  const viewBefore = useViewStore.getState().selected;
  fetcher.mockImplementation(async () => refused ? refusal(409) : written(dto({ id: 'T9', title: 'New task' })));
  if (path === 'initial') await due();
  else if (path === 'check') {
    fireEvent.click(within(document.querySelector<HTMLElement>('[data-toast][data-kind="error"]')!).getByRole('button', { name: 'Check' }));
  } else {
    surface.unmount();
    // Reconstruct both stores from the same interrupted tab's saved state; no closure survives the reload.
    const saved = JSON.parse(sessionStorage.getItem('alpacawork-write-intents-v5')!);
    saved.entries[key].status = 'pending';
    sessionStorage.setItem('alpacawork-write-intents-v5', JSON.stringify(saved));
    act(() => { useDraftStore.setState(readDrafts()); useWriteIntentStore.setState(readWriteIntents()); });
    await act(async () => { resumeDirectIntents(queryClient, '/fixture'); });
  }
  await waitFor(() => expect(useWriteIntentStore.getState().entries[key]?.status).toBe(refused ? 'conflict' : 'confirmed'));
  expect(useWriteIntentStore.getState().entries[key]?.operationId).toBe(entry.operationId);
  const result = useDraftStore.getState().entries[formKey(kind)]!;
  if (newer || refused) expect(result).toEqual(kept);
  else expect(result.status).toBe('saved');
  if (path !== 'initial') expect(useViewStore.getState().selected).toBe(viewBefore);
  if (newer && path !== 'reload') expect(useDialogStore.getState().dialog).toMatchObject({ form: 'move', taskId: 'T2' });
  expect(useUndoOffers.getState().offers).toHaveLength(0);
  return admitted;
}
for (const path of ['initial', 'check', 'reload'] as const) {
  test.each(draftedKinds)(`%s final confirmation settles its captured draft via ${path}`, async kind => {
    await recoverForm(kind, path);
  });
}
for (const path of ['check', 'reload'] as const) {
  test.each(draftedKinds)(`%s ${path} confirmation preserves a newer draft edition even with identical words`, async kind => {
    await recoverForm(kind, path, true);
  });
  test.each(draftedKinds)(`%s ${path} final refusal keeps its captured draft editable`, async kind => {
    await recoverForm(kind, path, false, true);
  });
}


test.each(draftedKinds)('%s reopened while pending permits new input and saving after the older admission confirms', async kind => {
  const { key, fetcher, data } = await admitForm(kind);
  act(() => {
    useDialogStore.getState().openProject();
  });
  const name = await screen.findByRole('textbox', { name: { project: 'Name' }[kind] }) as HTMLInputElement;
  const original = name.value;
  expect(name.matches(':disabled') || name.readOnly).toBe(true);
  const opened = useDialogStore.getState().dialog;
  fetcher.mockImplementation(async () => written(dto({ id: 'T9', title: 'New task' })));
  await due();
  expect(useWriteIntentStore.getState().entries[key]?.status).toBe('confirmed');
  expect(useDialogStore.getState().dialog).toBe(opened);
  expect(name.matches(':disabled')).toBe(false);
  expect(name.readOnly).toBe(false);
  expect(name.value).toBe(original);
  expect(useDraftStore.getState().entries[formKey(kind)]?.status).toBe('editing');
  const field = { project: 'name' }[kind];
  const typed = (text: string | undefined) => text;
  fireEvent.change(name, { target: { value: 'New words after confirmation' } });
  await waitFor(() => expect(typed(useDraftStore.getState().entries[formKey(kind)]?.values[field])).toBe('New words after confirmation'));
  expect(typed(readDrafts().entries[formKey(kind)]?.values[field])).toBe('New words after confirmation');
  const submit = screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement;
  expect(submit.disabled).toBe(false);
  fireEvent.click(submit);
  await waitFor(() => expect(useDialogStore.getState().dialog).toBeNull());
  expect(useWriteIntentStore.getState().entries[key]?.status).toBe('waiting');
  expect(typed(useWriteIntentStore.getState().entries[key]?.draft?.[field])).toBe('New words after confirmation');
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  await due();
  await waitFor(() => expect(useWriteIntentStore.getState().entries[key]?.status).toBe('confirmed'));
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(2);
});


test('a reopened project keeps app failures in one global notice instead of the fields', async () => {
  const { fetcher } = await admitForm('project');
  fetcher.mockImplementation(async () => new Response(JSON.stringify({ error: {
    code: 'busy', message: 'The database is busy. Wait a moment and try again', retry: 'later',
  } }), { status: 409, headers: { 'content-type': 'application/json' } }));
  await due();
  expect(errorToasts()).toHaveLength(1);
  fireEvent.click(within(document.querySelector<HTMLElement>('[data-toast][data-kind="error"]')!).getByRole('button', { name: 'Open' }));
  const dialog = await screen.findByRole('dialog', { name: 'New project' });
  expect(within(dialog).queryAllByRole('alert')).toHaveLength(0);
  expect(errorToasts()).toHaveLength(1);
});
