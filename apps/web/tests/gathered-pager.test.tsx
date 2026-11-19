/** The gathered pager's next page comes later: it opens its first task only on the reader it was asked from. */
import { beforeAll, beforeEach, afterEach, test, expect, vi } from 'vitest';
import { act, render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { startI18n } from '@alpacawork/i18n';
import { Workbench } from '../src/features/shell/Workbench';
import { useViewStore } from '../src/state/view-store';
import { queryClient } from '../src/data/query-client';
import { resources } from '../src/data/resources';
import { openScreenLink } from '../src/state/bootstrap';
import { useSitting } from '../src/features/reader/next-question';
import { TestWorkspace, dto, tree, screenData, searchAnswer } from './fixtures';
const flush=()=>act(async()=>{await new Promise(r=>setTimeout(r,20));});
beforeAll(()=>startI18n());
beforeEach(()=>{queryClient.clear();useViewStore.setState(useViewStore.getInitialState());useSitting.setState(useSitting.getInitialState());history.replaceState(null,'','/?agent=1&q=tasks&task=T1');});
afterEach(()=>{cleanup();queryClient.clear();vi.restoreAllMocks();});
for(const leave of ["stays", "task", "filter", "project"] as const) test(`the search pager's late page after ${leave}`,async()=>{
  const data=screenData(tree({tasks:[dto({id:'T1'}),dto({id:'T2'}),dto({id:'T3'})]}));
  queryClient.setQueryData(resources.taskSearch('/fixture','tasks',null).queryKey,{pages:[searchAnswer(['T1'],{},'cursor',2)],pageParams:[null]});
  let release!:()=>void;let received=false;
  const gate=new Promise<void>(r=>{release=r;});
  vi.spyOn(globalThis,'fetch').mockImplementation(async (input)=>{
    const url=String(input);
    if(url.startsWith('/api/task/search?')&&url.includes('after=cursor')){received=true;await gate;return new Response(JSON.stringify(searchAnswer(['T2'],{},null,2)));}
    return new Response(JSON.stringify({id:'fixture',agent:'claude',warm: 'none' as const, busy: false,cancelled:[],turns:[]}));
  });
  render(<TestWorkspace data={data}><Workbench/></TestWorkspace>);await flush();
  const next=document.querySelector('[data-reader-mode] [data-gathered-pager] button:last-child')!;
  expect(next).toBeTruthy();fireEvent.click(next);
  await waitFor(()=>expect(received).toBe(true));
  if(leave === 'task'){act(()=>openScreenLink('/?agent=1&q=tasks&task=T3'));await flush();expect(useViewStore.getState().selected).toBe('T3');}
  if(leave === 'filter') { act(()=>useViewStore.getState().setQuery('another')); await flush(); }
  if(leave === 'project') { act(()=>useViewStore.setState({ project: 'P99' })); await flush(); }
  release();await flush();await flush();
  await waitFor(()=>expect(new URL(location.href).searchParams.get('task')).toBe(leave === 'task' ? 'T3' : leave === 'stays' ? 'T2' : 'T1'));
});
