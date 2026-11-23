import { snapshotJson } from './conversation-fixture';
import { setConversationState } from './conversation-fixture';
/** On a phone, what is open for a moment over the reader (the model picker, a task label's card) closes on Back with the page's step. */
import { beforeAll, beforeEach, afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { i18n, startI18n } from '@alpacawork/i18n';
import { Workbench } from '../src/features/shell/Workbench';
import { useViewStore } from '../src/state/view-store';
import { useConversation } from '../src/features/coordinator/coordinator';
import { queryClient } from '../src/data/query-client';
import { useSitting } from '../src/features/reader/next-question';
import { textDocument, taskLabel } from '../src/features/coordinator/editor/document';
import { TestWorkspace, dto, screenData, tree, narrowScreen, at } from './fixtures';
import * as reads from '../src/state/read-store';
const flush = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); });
const conversation = {id:'audit',nextLaunch: { agent: 'claude', values: {} },warm: 'none' as const, busy: false,cancelled: [],turns:[]};
const f = (name:string) => ({name,size:10,at,revision:'r1'});
let mobile:ReturnType<typeof narrowScreen>;
beforeAll(async () => { startI18n(); await i18n.changeLanguage('en'); });
beforeEach(() => {
  queryClient.clear(); history.replaceState(null,'','/'); useViewStore.setState(useViewStore.getInitialState());
  const session=(window as any)._sessionHistory;session._entries=[session.currentEntry];session._currentIndex=0;
  useSitting.setState(useSitting.getInitialState());
  setConversationState({conversation,open:false,read:true,error:null});
  vi.spyOn(globalThis,'fetch').mockImplementation(async()=>new Response(snapshotJson(conversation),{status:200}));
  mobile=narrowScreen(true);
  Element.prototype.getAnimations=()=>[];
});
afterEach(()=>{cleanup();queryClient.clear();mobile.restore();vi.restoreAllMocks();});
const mount=(tasks=[dto({id:'T1',files:[f('notes.txt'),f('files/note.txt')]}),dto({id:'T2',files:[f('notes.txt'),f('files/note.txt')]})])=>{
 const data=screenData(tree({tasks}));render(<TestWorkspace data={data}><Workbench/></TestWorkspace>);return data;
};
/** The conversation opened over the page (its ∧), as a phone shows it unfolded: Back folds it. */
async function unfold(){fireEvent.click(document.querySelector('[data-coordinator-pill]')!);await flush();expect(document.querySelector('[data-coordinator-card]:not([data-coordinator-folded])')).toBeTruthy();}
async function reader(){act(()=>useViewStore.getState().openTask('T1',{reader:true}));await flush();}

test('task badge card closes on browser Back, with the conversation folded',async()=>{
 mount();await reader();act(()=>useViewStore.getState().openTask('T2',{reader:true}));await flush();
 fireEvent.click(document.querySelector('[data-coordinator-write]')!);await flush();
 await unfold();
 fireEvent.click(document.querySelector('[data-label-layer] [data-label="task"] button')!);await flush();
 expect(document.querySelector('[data-badge-card]')).toBeTruthy();
 await act(async()=>{history.back();await new Promise(resolve=>setTimeout(resolve,35));});await flush();
 expect(document.querySelector('[data-coordinator-card]:not([data-coordinator-folded])')).toBeNull();
 expect(document.querySelector('[data-badge-card]')).toBeNull();
});
