import { snapshotJson } from './conversation-fixture';
import { setConversationState } from './conversation-fixture';
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { startI18n, i18n } from '@alpacawork/i18n';
import { CoordinatorCard } from '../src/features/coordinator/CoordinatorCard';
import { useConversation } from '../src/features/coordinator/coordinator';
import { editableIntentValues } from '../src/features/coordinator/editor/editable-intent';
import { draftKey, useDraftStore } from '../src/features/forms/draft-store';
import { labelled, at, dto, logEntry, narrowScreen, screenData, taskFixture, TestWorkspace, tree, userBall } from './fixtures';
import { markReaderOperation, textDocument } from '../src/features/coordinator/editor/document';
import { readerTurn } from '../src/features/reader/submission';
import { useReaderSend } from '../src/features/coordinator/reader-send';
import { useOutbox } from '../src/features/coordinator/editor/outbox';
import { useSitting } from '../src/features/reader/next-question';
import { queryClient } from '../src/data/query-client';
import { notify, useToasts } from '../src/lib/notify';
const root='/fixture',cid='folded-refusal',key=draftKey(root,'coordinator',cid),originalHash='c'.repeat(64);
beforeAll(async()=>{await startI18n();await i18n.changeLanguage('en');});
afterEach(()=>{cleanup();for(const toast of useToasts.getState().toasts)notify.dismiss(toast.id);queryClient.clear();vi.unstubAllGlobals();useDraftStore.setState({entries:{}});useReaderSend.setState({receipts:new Map(),post:null,sendDraft:null});useOutbox.setState({live:new Set(),resend:null});setConversationState(useConversation.getInitialState());});
function mount(changed:boolean){
 const placement={id:'P3',taskId:'T3',agentId:'A1',profileKey:'codex',responsible:true,active:true,revision:7,startedAt:at,endedAt:null,headRunId:null,
  runtime:{displayState:'idle' as const,reason:null,sourceRunIds:[],runningCount:0,queuedCount:0,since:null,lastOutputAt:null,activityKind:null,toolName:null}};
 const review=logEntry({id:'submitted',kind:'reported',fromState:'doing',toState:'waiting',title:'Review',runId:'R3'});
 const data=screenData(tree({placements:[placement],tasks:[dto({id:'T1'}),taskFixture({id:'T3',parentId:'T1',state:'waiting',hash:changed?'d'.repeat(64):originalHash,log:[review],ball:userBall('review','submitted',at,{aboutRunId:'R3'})})]}));
 const source=data.tasks.find(task=>task.id==='T3')!,original={...source,hash:originalHash};
 const intent={task:'T3',action:'sendback' as const,aboutRun:'R3',expectedTaskHash:originalHash,expectedPlacementRevision:7};
 const doc=labelled(markReaderOperation(textDocument('Send the original result back')),source);
 setConversationState({root,conversation:{id:cid,agent:null,warm: 'none' as const,busy:false,cancelled:[],turns:[]},open:false,expanded:false,engaged:false,read:true,error:null});
 useSitting.setState({card:{taskId:'T1'},departures:{},sent:null,emptied:null} as never);
 useDraftStore.setState({entries:{[key]:{status:'editing',values:{doc:JSON.stringify(doc),requestId:crypto.randomUUID(),phase:'composing',...editableIntentValues(intent,readerTurn(original))}}},unavailable:false});
 const before=structuredClone(useDraftStore.getState().entries[key]!.values),posts:any[]=[];
 vi.stubGlobal('fetch',vi.fn().mockImplementation(async(url,init)=>{if(String(url)==='/api/coordinator/messages'){posts.push(JSON.parse(String(init?.body)));return new Promise<Response>(()=>{});}return new Response(snapshotJson({status:'unavailable',profile:'claude',skills:[]}));}));
 render(<TestWorkspace data={data}><CoordinatorCard /></TestWorkspace>);
 return {posts,before,intent};
}

test('a stale source sent from the folded real card opens the existing sender error, preserves the intent and posts nothing',async()=>{
 const narrow=narrowScreen(true);try{
  const {posts,before}=mount(true);
  await waitFor(()=>expect(document.querySelector<HTMLButtonElement>('[data-coordinator-capsule] [data-ask-send]')?.disabled).toBe(false));
  expect(useToasts.getState().toasts.map(toast=>String(toast.text))).not.toContain('The task has changed. Choose its state again');
  fireEvent.click(document.querySelector('[data-coordinator-capsule] [data-ask-send]')!);
  await waitFor(()=>expect(useConversation.getState().open).toBe(true));
  expect(useToasts.getState().toasts.map(toast=>String(toast.text))).toContain('The task has changed. Choose its state again');
  expect(document.querySelector('[data-coordinator-capsule]')).toBeNull();expect(posts).toEqual([]);
  expect(useDraftStore.getState().entries[key]!.values).toEqual(before);
 }finally{narrow.restore();}
});

test('an admitted send from the folded real card keeps the successful fold and the source payload',async()=>{
 const narrow=narrowScreen(true);try{
  const {posts,intent}=mount(false);
  await waitFor(()=>expect(document.querySelector<HTMLButtonElement>('[data-coordinator-capsule] [data-ask-send]')?.disabled).toBe(false));
  fireEvent.click(document.querySelector('[data-coordinator-capsule] [data-ask-send]')!);
  await waitFor(()=>expect(posts).toHaveLength(1));
  expect(useConversation.getState().open).toBe(false);expect(document.querySelector('[data-coordinator-capsule]')).not.toBeNull();
  expect(posts[0].intent).toEqual(intent);expect(posts[0].tasks).toEqual(['T3']);expect(posts[0].answers).toBeUndefined();
 }finally{narrow.restore();}
});
