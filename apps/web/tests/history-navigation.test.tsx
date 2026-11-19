import { beforeAll, afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { startI18n } from '@alpacawork/i18n';
import { queryClient as client } from '../src/data/query-client';
import { resources } from '../src/data/resources';
import { readAcquisition, readQuery } from '../src/data/read-model';
import { useTimeView } from '../src/state/time-view';
import { useViewStore } from '../src/state/view-store';
import { ReportFeed } from '../src/features/reader/ReportFeed';
import { historyCursor } from '@alpacawork/contract';
import { dto, tree, screenData, historyFixture, TestWorkspace } from './fixtures';
/** A History window as the server answers it. */
const win=(events:ReturnType<typeof historyFixture>,hasOlder:boolean)=>({generation:'a',sourcePv:0,events,hasOlder,oldestKey:events.length?historyCursor(events.at(-1)!):null});
vi.mock('../src/features/reader/MermaidImage', () => ({ MermaidImage: () => <span data-test-diagram /> }));
beforeAll(()=>startI18n());
afterEach(()=>{cleanup();client.clear();useTimeView.getState().pick('',null);useViewStore.setState(useViewStore.getInitialState());vi.restoreAllMocks();});
for(const kind of ['pick','image'] as const) for (const ending of ['found', 'missing', 'retry'] as const) test(`${kind} target survives head GET and settles ${ending}`,async()=>{
  const data=screenData(tree({tasks:[dto()]}));data.seed=()=>{};
  const options=resources.history(data.info.root,'T1');client.removeQueries({queryKey:options.queryKey,exact:true});
  const page=win(historyFixture([{id:'Lnew',kind:'comment',title:'Latest'}]),true);
  const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json(page));
  await client.fetchQuery(options);expect(readAcquisition(readQuery(client,options.queryKey)!)?.source).toBe('get');
  render(<TestWorkspace data={data}><ReportFeed task={data.tasks[0]!} people={data.people} onFollow={()=>{}} /></TestWorkspace>);
  let release!:(response:Response)=>void;fetcher.mockImplementation(()=>new Promise(resolve=>{release=resolve;}));
  let reading!:Promise<unknown>;
  await act(async()=>{reading=client.fetchQuery({...options,staleTime:0});await Promise.resolve();});
  expect(readQuery(client,options.queryKey)?.state.fetchStatus).toBe('fetching');
  act(()=>{if(kind==='pick')useTimeView.getState().pick('T1','log:T1:Ldeep');else useViewStore.getState().setImage(JSON.stringify(['log:T1:Ldeep','diagram',0]));});
  const target=kind==='pick'?useTimeView.getState().picked?.key:useViewStore.getState().image;
  // The ordinary head GET is still held; no terminal missing-target conclusion is justified.
  try { expect(target).toBe(kind==='pick'?'log:T1:Ldeep':JSON.stringify(['log:T1:Ldeep','diagram',0])); }
  finally {
    fetcher.mockImplementation(async () => ending === 'retry' ? Response.json({ error: { code: 'unavailable', message: 'Older unavailable', retry: 'later' } }, { status: 503 })
      : Response.json(win(ending === 'missing' ? [] : historyFixture([{ id: 'Ldeep', kind: 'comment', title: 'Old diagram', summary: '```mermaid\ngraph TD\nA-->B\n```' }]), false)));
    await act(async()=>{release(Response.json(page));await reading;});
  }
  if (ending === 'retry') {
    await waitFor(() => expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy());
    expect(kind === 'pick' ? useTimeView.getState().picked?.key : useViewStore.getState().image).toBe(kind === 'pick' ? 'log:T1:Ldeep' : JSON.stringify(['log:T1:Ldeep','diagram',0]));
    fetcher.mockResolvedValue(Response.json(win(historyFixture([{ id: 'Ldeep', kind: 'comment', title: 'Old diagram', summary: '```mermaid\ngraph TD\nA-->B\n```' }]), false)));
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
  }
  if (ending === 'missing') await waitFor(() => expect(kind === 'pick' ? useTimeView.getState().picked?.key ?? null : useViewStore.getState().image).toBeNull());
  else await waitFor(() => {
    expect(readQuery(client, options.queryKey)?.state.data).toMatchObject({ pages: [{ events: [expect.objectContaining({ id: 'Lnew' }), expect.objectContaining({ id: 'Ldeep' })] }] });
    expect(kind === 'pick' ? useViewStore.getState().event : useViewStore.getState().image).toBe(kind === 'pick' ? 'log:T1:Ldeep' : JSON.stringify(['log:T1:Ldeep','diagram',0]));
  });
  expect(fetcher.mock.calls.length).toBe(ending === 'retry' ? 4 : 3);
});
