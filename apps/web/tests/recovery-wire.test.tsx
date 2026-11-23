import {afterEach,expect,test,vi} from 'vitest';
import {z} from 'zod';
import {createApi,ApiError,mutationHeaders} from '../src/data/client';
import {receiveFullIndex} from '../src/data/resources';
import {queryClient} from '../src/data/query-client';
import {useConnection,workspaceWriteBasis} from '../src/data/connection';
import {submitWriteIntent,checkWriteIntent,intentKey,readWriteIntents,useWriteIntentStore} from '../src/data/write-intent';
import {getAttachmentOperation} from '../src/data/attachments';
import {RESTORE_HEADER} from '@alpacawork/contract/recovery';
import {indexOf,tree} from './fixtures';
const restored='ad6da10d-121c-4dbb-b352-6d6abae0f14d';
function live(restoreId:string) {
 const index={...indexOf(tree()),restoreId,generation:restoreId};
 receiveFullIndex(queryClient,index);useConnection.setState({state:'live',offline:false});return index;
}
afterEach(()=>{queryClient.clear();vi.restoreAllMocks();});

test('a lost Web intent and reloaded same operation keep their original restore ID; a new operation gets the new ID',async()=>{
 const initial=live('initial'),key=intentKey(initial.root,'comment',null),op=crypto.randomUUID();
 const send=(payload:unknown,id:string,basis=workspaceWriteBasis())=>createApi().request('commands/task/comment',z.unknown(),undefined,payload,id,basis);
 const calls:{id:string|null;epoch:string|null;body:unknown}[]=[];
 let lose=true;
 vi.spyOn(globalThis,'fetch').mockImplementation(async(_url,init)=>{
  const headers=new Headers(init?.headers);calls.push({id:headers.get('X-Alpacawork-Op-Id'),epoch:headers.get(RESTORE_HEADER),body:init?.body});
  if(lose){lose=false;throw Error('reply lost');}
  if(headers.get(RESTORE_HEADER)!==restored)return new Response(JSON.stringify({error:{code:'restore_changed',message:'restore changed',retry:'fix'}}),{status:409});
  return new Response('{}');
 });
 await expect(submitWriteIntent(key,()=>({text:'fixed'}),send,op)).rejects.toMatchObject({code:'network_error'});
 live(restored);
 await expect(checkWriteIntent(key,send)).rejects.toMatchObject({code:'restore_changed'});
 expect(calls[1]).toEqual(calls[0]);
 const next=crypto.randomUUID();await send({text:'new'},next);
 expect(calls[2]).toMatchObject({id:next,epoch:restored});
});

test('the common mutation headers keep an attachment operation pinned across reconnect by reading the tab storage',()=>{
 const initial=live('initial'),op=crypto.randomUUID();
 expect(mutationHeaders(workspaceWriteBasis(),op).get(RESTORE_HEADER)).toBe('initial');
 live(restored);
 // The pin is read from per-tab storage on each send, rather than a module-local cache.
 expect(mutationHeaders(workspaceWriteBasis(),op).get(RESTORE_HEADER)).toBe('initial');
 expect(mutationHeaders(workspaceWriteBasis(),crypto.randomUUID()).get(RESTORE_HEADER)).toBe(restored);
 expect(initial.root).toBe(workspaceWriteBasis().root);
});

test.each([undefined,'{"restoreId":null}','{bad','{"restoreId":"unsupported"}','{"restoreId":"initial","extra":true}'])('rehydrated intent with unusable pin %s stays unknown and allows only receipt lookup',async pin=>{
 const index=live(restored),op=crypto.randomUUID(),key=intentKey(index.root,'task/comment','T3');
 const record={status:'unconfirmed',operationId:op,transport:'receipt',payload:{task:'T3',title:'original'},attempt:crypto.randomUUID(),at:'2026-10-31T00:00:00.000Z'};
 const raw=JSON.stringify({version:1,entries:{[key]:record}}),pinKey='alpacawork-write-identity:'+JSON.stringify([index.root,op]);
 sessionStorage.setItem('alpacawork-write-intents-v5',raw);
 if(pin!==undefined)sessionStorage.setItem(pinKey,pin);
 useWriteIntentStore.setState(readWriteIntents());
 const fetch=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({state:'unknown_after_restore',restoreId:restored,notFoundProvesUnexecuted:false})));
 const send=vi.fn((payload:unknown,id:string,basis=workspaceWriteBasis())=>createApi().request('commands/task/comment',z.unknown(),undefined,payload,id,basis));
 for(let attempt=0;attempt<2;attempt++)await expect(checkWriteIntent(key,send)).rejects.toMatchObject({code:'write_unavailable',retry:'check'});
 expect(send).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
 expect(useWriteIntentStore.getState().entries[key]).toEqual(record);
 expect(sessionStorage.getItem('alpacawork-write-intents-v5')).toBe(raw);
 expect(sessionStorage.getItem(pinKey)).toBe(pin??null);
 expect(await getAttachmentOperation(op)).toMatchObject({state:'unknown_after_restore',notFoundProvesUnexecuted:false});
 expect(fetch).toHaveBeenCalledTimes(1);expect(fetch.mock.calls[0]?.[1]?.method).not.toBe('POST');
});

test('new admission persists its current pin before sending; a rehydrated valid intent retains that same pin and bytes',async()=>{
 const index=live('initial'),op=crypto.randomUUID(),key=intentKey(index.root,'task/comment',null),payload={text:'original'};
 const sent:{id:string;epoch:string|null;body:string}[]=[];
 const send=vi.fn(async(body:unknown,id:string,basis=workspaceWriteBasis())=>{
  const pin=sessionStorage.getItem('alpacawork-write-identity:'+JSON.stringify([index.root,id]));
  expect(pin).toBe('{"restoreId":"initial"}');
  sent.push({id,epoch:mutationHeaders(basis,id).get(RESTORE_HEADER),body:JSON.stringify(body)});
  throw new ApiError('Reply lost','network_error','check');
 });
 await expect(submitWriteIntent(key,()=>payload,send,op)).rejects.toMatchObject({code:'network_error'});
 live(restored);useWriteIntentStore.setState(readWriteIntents());
 await expect(checkWriteIntent(key,send)).rejects.toMatchObject({code:'network_error'});
 expect(sent).toHaveLength(2);expect(sent[1]).toEqual(sent[0]);
 expect(useWriteIntentStore.getState().entries[key]?.status).toBe('unconfirmed');
});

test('unreadable or unwritable storage refuses continuation without losing the retained intent',async()=>{
 const index=live(restored),op=crypto.randomUUID(),key=intentKey(index.root,'task/comment',null);
 const record={status:'unconfirmed' as const,operationId:op,transport:'receipt' as const,payload:{text:'original'},attempt:crypto.randomUUID(),at:'2026-10-31T00:00:00.000Z'};
 sessionStorage.setItem('alpacawork-write-intents-v5',JSON.stringify({version:1,entries:{[key]:record}}));
 sessionStorage.setItem('alpacawork-write-identity:'+JSON.stringify([index.root,op]),'{"restoreId":"initial"}');
 useWriteIntentStore.setState(readWriteIntents());const send=vi.fn();
 const read=vi.spyOn(Storage.prototype,'getItem').mockImplementation(()=>{throw new Error('storage unavailable');});
 await expect(checkWriteIntent(key,send)).rejects.toMatchObject({code:'write_unavailable',retry:'check'});read.mockRestore();
 vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new Error('storage full');});
 await expect(checkWriteIntent(key,send)).rejects.toMatchObject({code:'unavailable',retry:'check'});expect(send).not.toHaveBeenCalled();
 expect(useWriteIntentStore.getState().entries[key]).toEqual(record);expect(useWriteIntentStore.getState().unavailable).toBe(true);
});

test.each([
 {state:'unknown_after_restore',restoreId:restored,notFoundProvesUnexecuted:false},
 {state:'before_restore',restoreId:restored,notFoundProvesUnexecuted:false,previous:{opId:'old',state:'committed',status:200,body:{path:'old'},tasks:['T2']}},
 {state:'committed',status:200,body:{path:'attachments/request/a.txt',absolutePath:'/api/tasks/T2/file?path=a',size:1}},
 {state:'pending'},
])('attachment result preserves $state without turning it into a current success or absence',async body=>{
 vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify(body)));
 expect(await getAttachmentOperation('operation')).toEqual(body);
});

test('attachment result authorization refusals keep their existing meaning',async()=>{
 vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({error:{code:'forbidden',message:'not allowed',retry:'fix'}}),{status:403}));
 await expect(getAttachmentOperation('restricted')).rejects.toMatchObject({code:'forbidden',retry:'fix'});
});
