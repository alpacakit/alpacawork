/** A document followed from another, in the viewer, is a step Back returns from. */
import { beforeAll, beforeEach, afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, render, fireEvent, waitFor } from '@testing-library/react';
import { startI18n } from '@alpacawork/i18n';
import { useUrlBootstrap } from '../src/state/bootstrap';
import { useEveryTaskIndex } from '../src/data/queries';
import { useViewStore } from '../src/state/view-store';
import { queryClient } from '../src/data/query-client';
import { Workbench } from '../src/features/shell/Workbench';
import { TestWorkspace, dto, screenData, tree, at, narrowScreen } from './fixtures';
function Bootstrap(){useUrlBootstrap(useEveryTaskIndex());return null;}
// The file text is asynchronous; the navigation check starts when its real link can be pressed.
const documentLink=async(name:string)=>waitFor(()=>{const link=document.querySelector<HTMLElement>(`[data-viewer] a[title="${name}"]`);expect(link).toBeTruthy();return link!;});
const viewed=()=>new URL(location.href).searchParams.get('view');
const flush=async()=>act(async()=>{await new Promise(r=>setTimeout(r,30));});
const go=async(count:number)=>act(async()=>{const done=new Promise<void>(r=>addEventListener('popstate',()=>r(),{once:true}));history.go(count);await done;});
const open=async(id:string)=>{act(()=>useViewStore.getState().openTask(id,{reader:true}));await flush();};
const nav=()=>({url:location.search, selected:useViewStore.getState().selected, path:useViewStore.getState().filePath});
beforeAll(()=>startI18n());
beforeEach(()=>{queryClient.clear();history.replaceState(null,'','/');const s=(window as any)._sessionHistory;s._entries=[s.currentEntry];s._currentIndex=0;useViewStore.setState(useViewStore.getInitialState());Element.prototype.getAnimations=()=>[];});
afterEach(()=>{cleanup();queryClient.clear();vi.restoreAllMocks();vi.unstubAllGlobals();});
for(const phone of [false,true])test(`a document link A -> B in the viewer: Back returns to A, Forward to B; phone=${phone}`,async()=>{
 const mobile=narrowScreen(phone);
 try{
 const f=(name:string)=>({name,size:10,revision:'r1',at});const data=screenData(tree({tasks:[dto({id:'T1',files:[f('a.md'),f('work/b.md')]})]}));
 vi.spyOn(globalThis,'fetch').mockImplementation(async(input)=>{await new Promise(resolve=>setTimeout(resolve,200));return new Response(String(input).includes('a.md')?'[B](work/b.md)':'Second file');});
 render(<TestWorkspace data={data}><Workbench/></TestWorkspace>);await flush();await open('T1');
 act(()=>useViewStore.getState().openTaskFile('T1','a.md'));await flush();
 fireEvent.click(await documentLink('work/b.md'));await flush();
 expect(viewed()).toBe('T1/work/b.md');
 await go(-1);await flush();
 expect(viewed()).toBe('T1/a.md');
 await go(1);await flush();
 expect(viewed()).toBe('T1/work/b.md');
 }finally{mobile.restore();}
});

test('control: cross-branch task link keeps the list scope over reload',async()=>{
 const data=screenData(tree({tasks:[dto({id:'T1'}),dto({id:'T2',parentId:'T1'}),dto({id:'T3'}),dto({id:'T4',parentId:'T3'})]}));
 const mount=()=>render(<TestWorkspace data={data}><Bootstrap/></TestWorkspace>);
 history.replaceState(null,'','/?project=P100');mount();await flush();await open('T2');await open('T4');const before=nav();cleanup();useViewStore.setState(useViewStore.getInitialState());mount();await flush();expect(nav()).toEqual(before);
});
