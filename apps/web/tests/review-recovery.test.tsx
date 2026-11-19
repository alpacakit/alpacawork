import { snapshotJson } from './conversation-fixture';
import { setConversationState } from './conversation-fixture';
import { canSendWrites, detailWriteBasis } from '../src/data/connection';
import { getReadProof, readQuery, recordReadProof } from '../src/data/read-model';
import { requestRead } from '../src/data/read-demand';
import { resources } from '../src/data/resources';
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { startI18n, i18n } from '@alpacawork/i18n';
import { CoordinatorInput } from '../src/features/coordinator/CoordinatorInput';
import { useConversation } from '../src/features/coordinator/coordinator';
import { freeze, returnReaderSubmission, restoreReaderDraft, useOutbox, outgoingKey } from '../src/features/coordinator/editor/outbox';
import { draftKey, useDraftStore } from '../src/features/forms/draft-store';
import { labelled, at, dto, logEntry, screenData, taskFixture, TestWorkspace, tree, userBall } from './fixtures';
import { markReaderOperation, textDocument, emptyDocument, hasReaderOperation, draftDocument } from '../src/features/coordinator/editor/document';
import { editableIntentValues } from '../src/features/coordinator/editor/editable-intent';
import { readerTurn } from '../src/features/reader/submission';
import { intentAbout, useReaderSend, type SentIntent } from '../src/features/coordinator/reader-send';
import { useSitting } from '../src/features/reader/next-question';
import { queryClient } from '../src/data/query-client';
import { notify, useToasts } from '../src/lib/notify';
const root='/fixture', cid='review-recovery', key=draftKey(root,'coordinator',cid);
const originalHash='c'.repeat(64), currentHash='d'.repeat(64);
const conv=()=>({id:cid,agent:null,warm: 'none' as const,busy:false,cancelled:[],turns:[]});
beforeAll(async()=>{await startI18n();await i18n.changeLanguage('en');});
afterEach(()=>{cleanup();for(const toast of useToasts.getState().toasts)notify.dismiss(toast.id);queryClient.clear();vi.unstubAllGlobals();useDraftStore.setState({entries:{}});useReaderSend.setState({receipts:new Map(),post:null});useOutbox.setState({live:new Set(),resend:null});setConversationState(useConversation.getInitialState());});
function setup({restored=true, changed=false, changedTurn=false, changedPlacement=false, action='sendback', ordinary=false, snapshot=false, failFirst=false, unknownFirst=false}:
 {restored?:boolean;changed?:boolean;changedTurn?:boolean;changedPlacement?:boolean;action?:SentIntent['action'];ordinary?:boolean;snapshot?:boolean;failFirst?:boolean;unknownFirst?:boolean}={}) {
 const review=logEntry({id:'submitted',kind:'reported',fromState:'doing',toState:'waiting',title:'Review',...snapshot?{}:{runId:'R3'}});
 const placement={id:'P3',taskId:'T3',agentId:'A1',profileKey:'codex',responsible:true,active:true,revision:changedPlacement?8:7,
  startedAt:at,endedAt:null,headRunId:null,runtime:{displayState:'idle' as const,reason:null,sourceRunIds:[],runningCount:0,queuedCount:0,since:null,lastOutputAt:null,activityKind:null,toolName:null}};
 const data=screenData(tree({placements:[placement],tasks:[dto({id:'T1'}),taskFixture({id:'T3',parentId:'T1',state:ordinary?'doing':'waiting',hash:changed?currentHash:originalHash,
  log:ordinary?[logEntry()]:[review],ball:ordinary?null:userBall('review',changedTurn?'revised':'submitted',at,snapshot?{}:{aboutRunId:'R3'})})]}));
 const current=data.tasks.find(task=>task.id==='T3')!, original={...current,hash:originalHash,ball:ordinary?null:userBall('review','submitted',at,snapshot?{}:{aboutRunId:'R3'})};
 const intent:SentIntent={task:'T3',action,...snapshot||ordinary?{}:{aboutRun:'R3'},expectedTaskHash:originalHash,expectedPlacementRevision:7};
 const doc=labelled(markReaderOperation(textDocument('Send T3 back with changes')),original);
 const binding={...readerTurn(original),kind:'intent' as const,title:original.title,answer:'send' as const,expectedWrites:[{kind:'request_accepted' as const}]};
 const next={doc:JSON.stringify(emptyDocument()),requestId:crypto.randomUUID()};
 setConversationState({root,conversation:conv(),open:true,expanded:true,engaged:false,read:true,error:null});
 useSitting.setState({card:{taskId:'T1'},departures:{},sent:null,emptied:null} as never);
 useDraftStore.setState({entries:{[key]:{status:'editing',values:restored?next:{doc:JSON.stringify(doc),requestId:crypto.randomUUID(),...editableIntentValues(intent,readerTurn(original))}}},unavailable:false});
 if(restored){
  const requestId=crypto.randomUUID();
  expect(freeze(root,{conversationId:cid,text:'Send T3 back with changes',selected:{},attachments:[],intent},{requestId,doc:JSON.stringify(doc)},{from:key},[binding])).toBe(requestId);
  returnReaderSubmission(root,requestId,'conflict'); expect(restoreReaderDraft(root,cid,'T3')).toBe(true);
  const values=useDraftStore.getState().entries[key]!.values;
  expect(hasReaderOperation(draftDocument(values))).toBe(true);
 }
 const posts:Record<string,any>[]=[];
 vi.stubGlobal('fetch',vi.fn().mockImplementation(async(url,init)=>{
  if(String(url)==='/api/coordinator') return new Response(snapshotJson(conv()));
  if(String(url)==='/api/coordinator/messages'){
   posts.push(JSON.parse(String(init?.body)));
   if(failFirst&&posts.length===1)return new Response(snapshotJson({error:{code:'conflict',message:'Rejected for this attempt',retry:'reread'}}),{status:409});
   if(unknownFirst&&posts.length===1)throw new Error('Response lost');
   return new Promise<Response>(()=>{});
  }
  return new Response(snapshotJson({status:'unavailable',profile:'claude',skills:[]}));
 }));
 const rendered=render(<TestWorkspace data={data}><CoordinatorInput launch={{selected:{},picker:null}} profile='claude'/></TestWorkspace>);
 return {posts,intent,data,current,original,rendered};
}
const send=()=>fireEvent.click(document.querySelector('[data-ask-send]')!);

for(const [restored,snapshot] of [[false,false],[true,false],[true,true]] as const) test(`${restored?'restored':'fresh'} ${snapshot?'snapshot':'Run'} send-back keeps its complete source intent`,async()=>{
 const {posts,intent}=setup({restored,snapshot});send();await waitFor(()=>expect(posts).toHaveLength(1));
 expect(posts[0]!.intent).toEqual(intent);expect(posts[0]!.tasks).toEqual(['T3']);expect(posts[0]!.answers).toBeUndefined();
 const frozen=useDraftStore.getState().entries[outgoingKey(root,posts[0]!.id)]!;
 expect(JSON.parse(frozen.values.submitted!).intent).toEqual(intent);expect(frozen.values.readerIntent).toBeUndefined();expect(frozen.values.readerIntentTurn).toBeUndefined();
 send();expect(posts).toHaveLength(1);
});
for(const restored of [false,true]) for(const changedTurn of [false,true]) test(`${restored?'restored':'fresh'} send-back refuses a changed ${changedTurn?'turn':'source hash'} without posting`,async()=>{
 const {posts,intent}=setup({restored,changed:!changedTurn,changedTurn});send();
 await waitFor(()=>expect(useToasts.getState().toasts.map(toast=>String(toast.text))).toContain('The task has changed. Choose its state again'));expect(posts).toEqual([]);
 expect(JSON.parse(useDraftStore.getState().entries[key]!.values.readerIntent!)).toEqual(intent);
});
for(const action of ['sendback','continue','retry'] as const) test(`restored ordinary ${action} retains the explicit operation instead of becoming free text`,async()=>{
 const {posts,intent}=setup({action,ordinary:true});send();await waitFor(()=>expect(posts).toHaveLength(1));expect(posts[0]!.intent).toEqual(intent);
});
for(const broken of ['invalid','missing-turn'] as const) test(`an unchanged operation range with ${broken} meaning cannot become plain text`,async()=>{
 const {posts}=setup();const entry=useDraftStore.getState().entries[key]!;
 act(()=>useDraftStore.setState({entries:{[key]:{...entry,values:{...entry.values,...broken==='missing-turn'?{readerIntentTurn:''}:{readerIntent:'{invalid'}}}}}));
 send();await waitFor(()=>expect(useToasts.getState().toasts.map(toast=>String(toast.text))).toContain('The task has changed. Choose its state again'));expect(posts).toEqual([]);
});
test('only the existing explicit retry entrance refreshes version guards while retaining the original target',async()=>{
 const {posts,data,current,intent}=setup({action:'continue',ordinary:true,changed:true,changedPlacement:true});
 await waitFor(()=>expect(useReaderSend.getState().post).not.toBeNull());
 act(()=>useReaderSend.getState().post!(intentAbout(current,'continue',data.people),null,'Retry this instruction'));
 await waitFor(()=>expect(posts).toHaveLength(1));expect(posts[0]!.intent).toEqual({...intent,expectedTaskHash:currentHash,expectedPlacementRevision:8});
});
test('real send, refusal, recovery and resend preserve the original full payload',async()=>{
 const {posts,intent}=setup({restored:false,failFirst:true});send();await waitFor(()=>expect(posts).toHaveLength(1));
 const first=posts[0]!;
 await waitFor(()=>expect(useDraftStore.getState().entries[outgoingKey(root,first.id)]?.values.stage).toBe('refused'));
 await waitFor(()=>expect(useOutbox.getState().live.size).toBe(0));
 act(()=>{expect(restoreReaderDraft(root,cid,'T3')).toBe(true);});send();
 await waitFor(()=>expect(posts).toHaveLength(2));expect(posts[1]!.intent).toEqual(intent);expect(posts[1]!.text).toBe(first.text);expect(posts[1]!.tasks).toEqual(['T3']);expect(posts[1]!.id).not.toBe(first.id);
 send();expect(posts).toHaveLength(2);
});
test('unknown delivery retains the fixed original operation and checks the same ID and payload',async()=>{
 const {posts,intent}=setup({restored:false,unknownFirst:true});send();await waitFor(()=>expect(posts).toHaveLength(1));
 const first=posts[0]!;await waitFor(()=>expect(useOutbox.getState().live.size).toBe(0));
 expect(restoreReaderDraft(root,cid,'T3')).toBe(false);expect(useDraftStore.getState().entries[outgoingKey(root,first.id)]?.values.stage).toBe('posted');
 void act(()=>{void useOutbox.getState().resend!(first.id);});await waitFor(()=>expect(posts).toHaveLength(2));expect(posts[1]).toEqual(first);expect(posts[1]!.intent).toEqual(intent);
});

test('restored operation rejects a changed responsible revision without changing its original guards',async()=>{
 const {posts,intent}=setup({changedPlacement:true});send();await waitFor(()=>expect(useToasts.getState().toasts.map(toast=>String(toast.text))).toContain('The task has changed. Choose its state again'));
 expect(posts).toEqual([]);expect(JSON.parse(useDraftStore.getState().entries[key]!.values.readerIntent!)).toEqual(intent);
});

for (const failure of [403, 404, 503, 'unverified'] as const) test(`prepared projected send-back ${failure}: no admission before source recovery, then original intent and input once`, async () => {
  const { posts, intent, data } = setup();
  const options = resources.taskView(root, 'T3'), q = readQuery(queryClient, options.queryKey)!;
  const original = q.state.data, before = structuredClone(useDraftStore.getState().entries[key]!.values);
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    if (String(url).includes('/task/view')) return new Response(snapshotJson(original));
    if (String(url) === '/api/coordinator/messages') { posts.push(JSON.parse(String(init?.body))); return new Promise<Response>(() => {}); }
    return new Response(snapshotJson({ status: 'unavailable', profile: 'claude', skills: [] }));
  }));
  if (failure === 'unverified') act(() => recordReadProof(q, { ...getReadProof(q)!, uncertain: true }));
  else {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: failure })));
    await act(async () => { requestRead(q); await queryClient.fetchQuery({ ...options, staleTime: 0 }).catch(() => {}); });
  }
  expect(canSendWrites(detailWriteBasis('T1', data.tasks.find(task => task.id === 'T1')!.hash))).toBe(true);
  expect(canSendWrites(detailWriteBasis('T3', intent.expectedTaskHash))).toBe(false);
  send(); expect(posts).toEqual([]);
  expect(Object.keys(useDraftStore.getState().entries).filter(name => name.includes('send:'))).toEqual([]);
  expect(useDraftStore.getState().entries[key]!.values).toEqual(before);
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    if (String(url).includes('/task/view')) return new Response(snapshotJson(original));
    if (String(url) === '/api/coordinator/messages') { posts.push(JSON.parse(String(init?.body))); return new Promise<Response>(() => {}); }
    return new Response(snapshotJson({ status: 'unavailable', profile: 'claude', skills: [] }));
  }));
  await act(async () => { await queryClient.fetchQuery({ ...options, staleTime: 0 }); });
  expect(posts).toEqual([]); send(); await waitFor(() => expect(posts).toHaveLength(1));
  expect(posts[0]!.intent).toEqual(intent); expect(posts[0]!.tasks).toEqual(['T3']);
  expect(useSitting.getState().departures.T1).toBeUndefined();
});
