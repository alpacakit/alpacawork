import { readerTurn } from '../src/features/reader/submission';
/** Integration: real report, receipt and deck callers; no replacement qualification evaluator. */
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { i18n, startI18n } from '@alpacawork/i18n';
import { queryClient as client } from '../src/data/query-client';
import { canSendWrites, detailWriteBasis, workspaceWriteBasis, useConnection } from '../src/data/connection';
import { getReadProof, readIndex, readQuery, recordReadProof, refuseRead, restoreReadScope, taskReadState, serverReadFacts } from '../src/data/read-model';
import { receiveFullIndex, resources } from '../src/data/resources';
import { useTaskReport, captureReportOpening, useTaskReportTarget } from '../src/features/reader/use-task-report';
import { useReaderTurnHeld, useShowCard, useWaiting, useSitting } from '../src/features/reader/next-question';
import { useWriteIntentStore, readWriteIntents, checkWriteIntent, intentKey } from '../src/data/write-intent';
import { sendDirectIntent } from '../src/data/direct-write';
import { reportRequest, taskReportTarget } from '../src/data/task-report';
import { StateControl } from '../src/features/forms/ReportInputs';
import { closeInput, openInput } from '../src/state/open-input';
import { useViewStore } from '../src/state/view-store';
import { useDraftStore } from '../src/features/forms/draft-store';
import { hasSubmission, type Fixed } from '../src/features/coordinator/editor/outbox';
import type { CoordinatorConversation } from '../src/data/coordinator';
import { headOf, TestWorkspace, screenData, tree, dto, taskFixture, homeFixture, userBall, logEntry, at } from './fixtures';
import { jsonAnswer } from './receipt-fixture';

beforeAll(() => startI18n());
beforeEach(() => { client.clear(); useConnection.setState({ state:'connecting', fresh:false, offline:false }); });
afterEach(() => { cleanup(); closeInput(); vi.restoreAllMocks(); client.clear(); });
const value = () => tree({ tasks:[taskFixture({ state:'waiting', ball:userBall('review','L1',at),
  log:[logEntry({ id:'L1', kind:'reported', fromState:'doing', toState:'waiting' })] })],
  home:homeFixture([{ taskId:'T1', section:'review' }]) });
const setup = () => { const data=screenData(value()); data.seed(); return data; };
const ok = () => jsonAnswer({task:headOf(dto({state:'done'})),outcome:{kind:'recorded'}});
const query = () => readQuery(client,resources.taskView('/fixture','T1').queryKey)!;
const mount = () => { const data=setup(); return {data, ...renderHook(() => useTaskReport(data.tasks[0]!,data.people,null),
  {wrapper:({children})=><TestWorkspace data={data}>{children}</TestWorkspace>})}; };

for(const kind of ['absent','refused','uncertain','older-source','restored'] as const)
 test(`W1 ${kind}: live workspace cannot admit or POST a report without qualified detail`, async () => {
  const {result}=mount(), submit=result.current.complete, q=query();
  const fetcher=vi.spyOn(globalThis,'fetch');
  act(()=>{
   if(kind==='absent') q.setState({data:undefined});
   else if(kind==='refused') { refuseRead(q,readIndex(client)); q.setState({}); }
   else if(kind==='restored') { restoreReadScope(client,false); readQuery(client,['index'])!.setState({}); }
   else if(kind==='uncertain') recordReadProof(q,{...getReadProof(q)!,uncertain:true});
   // The list says the view changed after the version it was read from.
   else { const index=readIndex(client)!; client.setQueryData(['index'],{...index,requiredPv:{...index.requiredPv,view:{T1:index.sourcePv+1}}}); }
  });
  expect(canSendWrites(workspaceWriteBasis())).toBe(true);
  expect(taskReadState(client,'/fixture','T1').assessment.project).toBe(false);
  await waitFor(()=>expect(result.current.ready).toBe(false));
  act(()=>expect(submit().admission).toBe('rejected'));
  expect(useWriteIntentStore.getState().entries).toEqual({}); expect(fetcher).not.toHaveBeenCalled();
 });

test('W2 same server Task but another target hash cannot be admitted',()=>{
 const data=setup(), target=taskReportTarget({...data.tasks[0]!,hash:'b'.repeat(64)},data.people);
 const opening=captureReportOpening(client,target), fetcher=vi.spyOn(globalThis,'fetch');
 const {result}=renderHook(()=>useTaskReportTarget(opening,null),{wrapper:({children})=><TestWorkspace data={data}>{children}</TestWorkspace>});
 expect(result.current.ready).toBe(false);act(()=>expect(result.current.complete().admission).toBe('rejected'));
 expect(useWriteIntentStore.getState().entries).toEqual({});expect(fetcher).not.toHaveBeenCalled();
});

test('W3 an old opening cannot admit across scope A B A even with current detail and identical meaning',async()=>{
 const {result}=mount(), submit=result.current.complete, index=readIndex(client)!, view=query().state.data;
 vi.spyOn(globalThis,'fetch').mockImplementation(async()=>jsonAnswer(view));
 act(()=>{receiveFullIndex(client,{...index,generation:'B'});receiveFullIndex(client,index);});
 await act(async()=>{await client.fetchQuery({...resources.taskView(index.root,'T1'),staleTime:0});});
 expect(canSendWrites(detailWriteBasis('T1',value().tasks[0]!.hash))).toBe(true);
 act(()=>expect(submit().admission).toBe('rejected'));
 expect(useWriteIntentStore.getState().entries).toEqual({});
});

test('W3 POST200 confirms the fixed receipt across ABA without applying to the replacement scope',async()=>{
 const {result}=mount(); let release!:(r:Response)=>void;
 const fetcher=vi.spyOn(globalThis,'fetch').mockImplementation(()=>new Promise(resolve=>{release=resolve;}));
 let sent!:ReturnType<typeof result.current.complete>;
 act(()=>{sent=result.current.complete();});if(sent.admission==='rejected')throw sent.reason;
 const pending=sent.result, index=readIndex(client)!;
 act(()=>{receiveFullIndex(client,{...index,generation:'B'});receiveFullIndex(client,index);});
 await act(async()=>{release(ok());expect(await pending).toMatchObject({local:'scope-changed'});});
 expect(useWriteIntentStore.getState().entries[result.current.key]?.status).toBe('confirmed');
 expect(fetcher).toHaveBeenCalledOnce(); expect(client.getQueryData(resources.taskView(index.root,'T1').queryKey)).toBeUndefined();
});

test('W4 confirmation uses the immutable old payload and operation while detail is refused',async()=>{
 const {result}=mount(), fetcher=vi.spyOn(globalThis,'fetch').mockRejectedValueOnce(new TypeError('lost')).mockImplementation(async()=>ok());
 let sent!:ReturnType<typeof result.current.submit>;
 act(()=>{sent=result.current.submit('approve',{title:'Fixed title',description:'Fixed input'});});if(sent.admission==='rejected')throw sent.reason;
 const pending=sent.result;
 await act(async()=>{await expect(pending).rejects.toMatchObject({code:'network_error'});});
 const held=structuredClone(useWriteIntentStore.getState().entries[result.current.key]);
 act(()=>{useWriteIntentStore.setState(readWriteIntents());refuseRead(query(),readIndex(client));});
 expect(canSendWrites(detailWriteBasis('T1',value().tasks[0]!.hash))).toBe(false);
 await act(async()=>{await result.current.check();});
 expect(fetcher).toHaveBeenCalledTimes(2);expect(fetcher.mock.calls[1]![1]!.body).toBe(fetcher.mock.calls[0]![1]!.body);
 expect(useWriteIntentStore.getState().entries[result.current.key]).toMatchObject({status:'confirmed',operationId:held!.operationId,payload:held!.payload,draft:held!.draft,reader:held!.reader,recovery:held!.recovery});
});

test('W4 a confirmation token cannot carry a substituted payload',async()=>{
 const {result}=mount();vi.spyOn(globalThis,'fetch').mockRejectedValue(new TypeError('lost'));
 let sent!:ReturnType<typeof result.current.complete>;act(()=>{sent=result.current.complete();});if(sent.admission==='rejected')throw sent.reason;
 const pending=sent.result;
 await act(async()=>{await expect(pending).rejects.toBeDefined();});
 const {createApi}=await import('../src/data/client');const {taskWriteResultSchema}=await import('@alpacawork/contract/control');
 const fetcher=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>ok());fetcher.mockClear();
 await act(async()=>{await expect(checkWriteIntent<Record<string,unknown>,unknown>(result.current.key,(payload,op,basis)=>
  createApi().request('task/report',taskWriteResultSchema,undefined,{...payload,title:'changed'},op,basis))).rejects.toMatchObject({code:'write_unavailable'});});
 expect(fetcher).not.toHaveBeenCalled();
});

test('save admission checks authority before writing any durable receipt or calling admitted',()=>{
 const data=setup(), basis=detailWriteBasis('T1',data.tasks[0]!.hash);refuseRead(query(),readIndex(client));
 const admitted=vi.fn(), fetcher=vi.spyOn(globalThis,'fetch'), storage=vi.spyOn(Storage.prototype,'setItem');
 expect(()=>sendDirectIntent(client,intentKey('/fixture','task/report','T1'),{path:'task/report',response:'task',label:'Title'},
  op=>reportRequest(taskReportTarget(data.tasks[0]!,data.people),'approve',{},op),basis,{admitted})).toThrow();
 expect(storage).not.toHaveBeenCalled();expect(admitted).not.toHaveBeenCalled();expect(fetcher).not.toHaveBeenCalled();
 expect(useWriteIntentStore.getState().entries).toEqual({});
});

test('reselect after scope ABA recovers explicitly while keeping title and description',async()=>{
 const data=setup(), view=query().state.data, fetcher=vi.spyOn(globalThis,'fetch').mockImplementation(async(url)=>String(url).includes('/task/view')?jsonAnswer(view):ok());
 openInput({form:'report',taskId:'T1',answerCard:null});
 render(<TestWorkspace data={data}><StateControl task={data.tasks[0]!}/></TestWorkspace>);
 fireEvent.change(screen.getByRole('textbox',{name:'Title in History'}),{target:{value:'Keep title'}});
 fireEvent.change(screen.getByRole('textbox',{name:'Description in History'}),{target:{value:'Keep description'}});
 const index=readIndex(client)!;
 act(()=>{receiveFullIndex(client,{...index,generation:'B'});receiveFullIndex(client,index);});
 await act(async()=>{await client.fetchQuery({...resources.taskView(index.root,'T1'),staleTime:0});});
 fetcher.mockClear();
 await waitFor(()=>expect(screen.getByRole('button',{name:'Update'})).not.toHaveProperty('disabled',true));
 fireEvent.click(screen.getByRole('button',{name:'Update'}));expect(fetcher).not.toHaveBeenCalled();
 await screen.findByText(i18n.t('forms:reportForm.chooseAgain'));
 await waitFor(()=>expect(screen.getByRole('radio',{name:'Done'})).not.toHaveProperty('disabled',true));
 fireEvent.click(screen.getByRole('radio',{name:'Done'}));
 fireEvent.click(screen.getByRole('button',{name:'Update'}));
 await waitFor(()=>expect(fetcher).toHaveBeenCalledOnce());
 expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body))).toMatchObject({title:'Keep title',description:'Keep description'});
});

for(const state of ['pending','unconfirmed','confirmed'] as const) test(`W5 ${state}: deck and submitted controls use only qualified server turns and retain fixed input`,async()=>{
 const data=setup(), index=readIndex(client)!, task=data.tasks[0]!;
 const key=intentKey(index.root,'task/report',task.id), binding={...readerTurn(task),title:task.title,answer:'done' as const,recovery:'done' as const};
 const held={status:state,operationId:'fixed',attempt:'attempt',transport:'receipt' as const,payload:{words:'original'},draft:{title:'original'},reader:binding,at};
 useWriteIntentStore.setState({entries:{[key]:held}});
 useViewStore.getState().openTask(task.id,{reader:true});const card={taskId:task.id};
 const {result}=renderHook(()=>{useShowCard(card,'review',false);return {submitted:useReaderTurnHeld(task),waiting:useWaiting()};},
  {wrapper:({children})=><TestWorkspace data={data}>{children}</TestWorkspace>});
 expect(result.current.submitted).toBe(true);expect(result.current.waiting).toEqual([]);
 const before=structuredClone(useWriteIntentStore.getState().entries), sitting=useSitting.getState();
 act(()=>{restoreReadScope(client,false);readQuery(client,['index'])!.setState({});});
 expect(serverReadFacts(client)).toBeUndefined();await waitFor(()=>expect(result.current.submitted).toBe(false));expect(result.current.waiting).toEqual([]);
 expect(useWriteIntentStore.getState().entries).toEqual(before);expect(useSitting.getState().departures).toEqual(sitting.departures);
});

test('W5 display turn cannot retire a different server turn',()=>{
 const data=setup(), task=data.tasks[0]!;useWriteIntentStore.setState({entries:{[intentKey('/fixture','task/report','T1')]:{
  status:'confirmed',operationId:'old',attempt:'a',transport:'receipt',at,payload:{},reader:{...readerTurn(task),title:task.title,turn:'display-only',answer:'done',recovery:'done'}}}});
 const {result}=renderHook(()=>useReaderTurnHeld({...task,ball:userBall('review','display-only',at)}),{wrapper:({children})=><TestWorkspace data={data}>{children}</TestWorkspace>});
 expect(result.current).toBe(false);
});

for(const historical of [{task:'T1',action:'approve'}, {nonsense:'recorded'}] as Record<string,string>[]) test(`W6 historical ${JSON.stringify(historical)} is nonthrowing and cannot match absent intent`,()=>{
 const fixed:Fixed={conversationId:'c',text:'original words',attachments:[],selected:{}};
 const turn={id:'fixed',at,ask:fixed.text,attachments:[],intent:historical,status:'queued' as const,waiting:true,answer:null,seen:false,answeredAt:null,error:null,result:null};
 const conversation:CoordinatorConversation={id:'c',agent:null,warm: 'none' as const,busy:false,cancelled:[],turns:[turn]};
 expect(()=>hasSubmission(conversation,'fixed',fixed)).not.toThrow();expect(hasSubmission(conversation,'fixed',fixed)).toBe(false);
 expect(turn.ask).toBe('original words');
});
