import { snapshotJson, SERVED } from './conversation-fixture';
import { setConversationState } from './conversation-fixture';
import { answerTask } from './fixtures';
/**
 * A send whose receipt comes after the reader went on to another task (a reference followed, Back, a ×, a URL whose task or
 * task is still being looked up) moves nothing. The receipt says the turn is under way (delivered),
 * admission has already moved the reader. Returning to the source before navigating exercises the same
 * history boundaries, and the later delivery must never retire that new opening.
 */
import { beforeAll, beforeEach, afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { startI18n } from '@alpacawork/i18n';
import { Workbench } from '../src/features/shell/Workbench';
import { useViewStore } from '../src/state/view-store';
import { useConversation } from '../src/features/coordinator/coordinator';
import { setAutoSwipe, useSitting } from '../src/features/reader/next-question';
import { queryClient } from '../src/data/query-client';
import { TestWorkspace, dto, homeFixture, screenData, taskFixture, tree, narrowScreen, logEntry, at, userBall, decideItem, questionFixture, viewsOf, openReference } from './fixtures';
import { api } from '../src/data/resources';
import { choiceAnswer, toggleAnswer } from '../src/features/coordinator/editor/document';
import { decideOf } from '../src/domain/questions';
const asked = [decideItem('Proceed?', [['Yes', 'Proceed']])];
const question = decideOf(asked)[0]!;
const flush = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
const conversation = {id:'review7',nextLaunch: { agent: 'claude', values: {} },...SERVED, busy: false,cancelled:[],turns:[{id:'old',at,ask:'before',attachments:[],status:'succeeded', waiting: false,answer:'before',seen:false,answeredAt:at,error:null,result:{writes:[],refused:[]}}]};
import { fakeNavigation, sessionHistory } from './navigation-fake';
import { closeReaderStep, closeImage } from '../src/state/history-step';
let nav: ReturnType<typeof fakeNavigation>;
let release:()=>void;
beforeAll(() => startI18n());
beforeEach(() => {
  // Its sends from the input are read leaving their cards: auto-swipe on.
  setAutoSwipe(true);
  queryClient.clear(); useSitting.setState(useSitting.getInitialState()); history.replaceState(null, '', '/?task=T1'); useViewStore.setState(useViewStore.getInitialState());
  sessionHistory(); nav=fakeNavigation({held:true}); setConversationState({...useConversation.getInitialState(),conversation:conversation as any,open:false,read:true,error:null});
});
afterEach(async () => { release?.(); await flush(); cleanup(); queryClient.clear(); setConversationState({conversation:null,open:false,read:true,error:null}); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
for (const delivery of ['running','queued then running'] as const) for (const meanwhile of ['none','reader','reference','reference and back','close before receipt','close then receipt then person Back','image close before receipt','person Back before receipt','closed before receipt','person Back unresolved task before receipt','x unresolved task before receipt'] as const) test(`real sender, admitted POST, navigation=${meanwhile}, delivery=${delivery}: an old receipt does not move the reader`, async () => {
  const narrow = narrowScreen(true);
  try {
    // Explicit question choices retain the admission/navigation contract; ordinary words no longer retire a card.
    const waits = (id:string,minute:string) => taskFixture({ id,values: { notes: 'T2' },files:[{name:'shot.png',size:10,at,revision:'r1'}],state:'waiting',userRequested:true,
      log:[logEntry({id:'L1',kind:'reported',at:`2026-09-24T09:${minute}:00Z`,toState:'waiting'})],
      ball:userBall('question','Q'+id,`2026-09-24T09:${minute}:00Z`,{questionId:'Q'+id}) });
    const served=tree({ tasks:[waits('T1','01'),dto({id:'T2'}),waits('T3','03')],
      home:homeFixture([{taskId:'T1',section:'review'},{taskId:'T3',section:'review'}]),
      questions: ['T1','T3'].map(taskId => questionFixture({ id:'Q'+taskId,taskId,decide:asked })) });
    const data=screenData(served);
    vi.spyOn(api,'request').mockResolvedValue(viewsOf(served).find(view => view.task.id === 'T1')!);
    const gate=new Promise<void>(resolve=>{release=resolve;});
    let requested:any=null; let receiptSnapshot:any=null;
    vi.spyOn(globalThis,'fetch').mockImplementation(async (input,init)=>{
      const url=String(input); if(url.includes('address=T999'))return new Promise<Response>(()=>{});
      if(url.startsWith('/api/coordinator/skills'))return new Response(snapshotJson({status:'unavailable',profile:'claude',skills:[],reason:'test'}));
      if(url==='/api/coordinator/messages'){
        requested=JSON.parse(String(init?.body));await gate;
        receiptSnapshot={...conversation,turns:[...conversation.turns,{id:requested.id,at,ask:requested.text,tasks:requested.tasks,answers:requested.answers,attachments:[],status:delivery==='running'?'running':'queued', waiting: delivery !== 'running',answer:null,seen:false,answeredAt:null,error:null,result:null}]}; return new Response(snapshotJson(receiptSnapshot));
      }
      return new Response(snapshotJson(receiptSnapshot??conversation));
    });
    if(meanwhile.includes('unresolved')){history.replaceState(null,'','/?agent=1&'+'task'+'=T999');sessionHistory();}
    render(<TestWorkspace data={data}><Workbench /></TestWorkspace>); await flush();
    if(meanwhile.includes('unresolved')){act(()=>useViewStore.getState().openTask('T1',{reader:true}));await flush();}
    else if(meanwhile.includes('person Back')) {act(()=>useViewStore.getState().openTask('T2',{reader:true}));await flush();act(()=>useViewStore.getState().openTask('T1',{reader:true}));await flush();}
    fireEvent.click(document.querySelector('[data-coordinator-write]')!);
    await waitFor(()=>expect(document.querySelector('[data-one-input]')).toBeTruthy());
    const input=document.querySelector('[data-one-input]') as HTMLElement & {editor:any};
    await waitFor(()=>expect(input.getAttribute('contenteditable')).toBe('true'));
    act(()=>{const doc=input.editor.getJSON();doc.content.push({type:'paragraph',content:[{type:'text',text:'Please proceed with this task'}]});input.editor.commands.setContent(toggleAnswer(doc,data.tasks.find(task=>task.id==='T1')!,choiceAnswer(answerTask('T1'),'QT1',question,question.choices[0]!)));});
    fireEvent.click(document.querySelector('[data-ask-send]')!);
    await waitFor(()=>expect(requested?.text).toContain('T1'));
    await waitFor(()=>expect(useViewStore.getState().selected).toBe('T3'));
    // Admission adds a history step. Back returns to the source as a new opening before the navigation under test.
    if(meanwhile!=='none') {
      await act(async()=>{const done=new Promise<void>(resolve=>addEventListener('popstate',()=>resolve(),{once:true}));history.back();await done;});await flush();
      expect(useViewStore.getState().selected).toBe('T1');
    }
    act(()=>useConversation.getState().setOpen(false));await flush();
    if(meanwhile==='reader')act(()=>useViewStore.getState().openTask('T2',{reader:true}));
    if(meanwhile.startsWith('reference')){
      act(()=>useViewStore.getState().setReaderPane('about'));await flush();
      openReference(document.querySelector('[data-reader-mode] [data-task-reference="T2"]')!);await flush();
      expect(useViewStore.getState().selected).toBe('T2');
      expect(new URL(location.href).searchParams.get('task')).toBe('T2');
    }
    if(meanwhile==='reference and back'){
      await act(async()=>{const done=new Promise<void>(resolve=>addEventListener('popstate',()=>resolve(),{once:true}));history.back();await done;});await flush();
      expect(useViewStore.getState().selected).toBe('T1');
    }

    if(meanwhile==='image close before receipt') {act(()=>useViewStore.getState().openTaskFile('T1','shot.png'));await flush();act(()=>closeImage());}
    else if(meanwhile.startsWith('close')||meanwhile==='closed before receipt') {act(()=>closeReaderStep());}
    if(meanwhile==='person Back before receipt'||meanwhile.startsWith('person Back unresolved')) {
      await act(async()=>{const done=new Promise<void>(resolve=>addEventListener('popstate',()=>resolve(),{once:true}));history.back();await done;});await flush();
    }
    if(meanwhile.startsWith('x unresolved')){act(()=>closeReaderStep());await act(()=>nav.arrive(nav.moves[0]!));await flush();}
    if(meanwhile==='closed before receipt') {await act(()=>nav.arrive(nav.moves[0]!));await flush();}
if(meanwhile.includes('unresolved')) {expect(new URL(location.href).searchParams.get('task')).toBe(meanwhile==='x unresolved task before receipt'?null:'T999');expect(useViewStore.getState().selected).toBeNull();expect(useSitting.getState().card).toBeNull();expect(useViewStore.getState().reader.address ?? null).toBe(meanwhile.includes('unresolved task')&&meanwhile!=='x unresolved task before receipt'?'T999':null);}
const beforeReceipt = useViewStore.getState();
release();await flush();await flush();
    if(delivery==='queued then running'){expect(useViewStore.getState().selected).toBe(beforeReceipt.selected);receiptSnapshot={...receiptSnapshot,turns:receiptSnapshot.turns.map((turn:any)=>turn.id===requested.id?{...turn,status:'running', waiting: false}:turn)};await act(()=>useConversation.getState().refresh());await flush();}
    await waitFor(()=>expect(useConversation.getState().conversation?.turns.some(turn=>turn.id===requested.id)).toBe(true));await flush();

    if(meanwhile==='close then receipt then person Back') {await act(async()=>{const done=new Promise<void>(resolve=>addEventListener('popstate',()=>resolve(),{once:true}));history.back();await done;});await flush();act(()=>nav.abortPending());await flush();expect(useViewStore.getState().selected).toBe('T2');expect(useViewStore.getState().reader.turnSequence).not.toBe(true);}
    else if(meanwhile==='close before receipt'||meanwhile==='image close before receipt'){
      expect(useViewStore.getState().selected).toBe('T1'); await act(()=>nav.arrive(nav.moves[0]!));await flush();
      if(meanwhile==='image close before receipt'){expect(useViewStore.getState().selected).toBe('T1');expect(useViewStore.getState().reader.turnSequence).not.toBe(true);}else{expect(useViewStore.getState().reader.open).toBe(false);expect(new URL(location.href).searchParams.get('task')).toBeNull();}
    }
    else if(meanwhile==='person Back before receipt') {expect(useViewStore.getState().selected).toBe('T2');expect(useViewStore.getState().reader.turnSequence).not.toBe(true);}
    else if(meanwhile.includes('unresolved')) {expect(new URL(location.href).searchParams.get('task')).toBe(meanwhile==='x unresolved task before receipt'?null:'T999');expect(useViewStore.getState().selected).toBeNull();expect(useSitting.getState().card).toBeNull();expect(useViewStore.getState().reader.turnSequence).not.toBe(true);}
    else if(meanwhile==='closed before receipt') {expect(useViewStore.getState().reader.open).toBe(false);expect(new URL(location.href).searchParams.get('task')).toBeNull();}
    else if(meanwhile==='none')expect(useViewStore.getState().selected).toBe('T3');
    else if(meanwhile==='reference and back')expect(useViewStore.getState().selected).toBe('T1');
    else expect(useViewStore.getState().selected).toBe('T2');
  } finally { narrow.restore(); }
});
