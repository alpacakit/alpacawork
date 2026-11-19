import { detailWriteBasis, workspaceWriteBasis } from '../src/data/connection';
import { beforeEach as beforeSendCase } from 'vitest';
import { allowFixtureWrites } from './read-fixtures';
beforeSendCase(allowFixtureWrites);
import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { ApiError } from '../src/data/client';
import { sendDirectIntent, checkDirectIntent } from '../src/data/direct-write';
import { intentKey, readWriteIntents, sendWriteIntent, submitWriteIntent, useWriteIntentStore } from '../src/data/write-intent';
import { headOf, dto } from './fixtures';

const root = '/fixture', key = intentKey(root, 'project/new', 'foo');
const recovery = { path: 'task/new', response: 'task' as const, label: 'Foo' };
const client = new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
const problem = (status: number, retry: string) => new Response(JSON.stringify({ error: { code: status === 409 ? 'conflict' : 'invalid_input', message: 'Refused', retry } }), {status, headers:{'Content-Type':'application/json'}});
beforeEach(()=>{sessionStorage.clear();useWriteIntentStore.setState({entries:{},unavailable:false});});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();client.clear();});

test('new project input cannot silently replay a different fixed payload; explicit checking retains the same ID and body', async()=>{
 const fetcher=vi.fn().mockRejectedValue(new TypeError('lost'));
 vi.stubGlobal('fetch',fetcher);
 await expect(sendDirectIntent(client,key,recovery,()=>({kind:'project',title:'Foo'}),workspaceWriteBasis())).rejects.toBeInstanceOf(ApiError);
 const held=structuredClone(useWriteIntentStore.getState().entries[key]);
 await expect(sendDirectIntent(client,key,{...recovery,label:'Bar'},()=>({kind:'project',title:'Bar'}),workspaceWriteBasis())).rejects.toBeInstanceOf(ApiError);
 expect(fetcher).toHaveBeenCalledTimes(1);
 expect(useWriteIntentStore.getState().entries[key]).toEqual(held);
 // The same saved request can be checked after a reload; a rejection is a definite end, not evidence of success.
 useWriteIntentStore.setState(readWriteIntents());
 fetcher.mockResolvedValue(problem(409,'reread'));
 await expect(checkDirectIntent(client,key)).rejects.toMatchObject({retry:'reread'});
 expect(fetcher.mock.calls[1]![1].body).toBe(fetcher.mock.calls[0]![1].body);
 expect(fetcher.mock.calls[1]![1].headers).toEqual(fetcher.mock.calls[0]![1].headers);
 expect(useWriteIntentStore.getState().entries[key]).toMatchObject({status:'conflict',payload:{title:'Foo'},operationId:held!.operationId});
});

test('transport and caller mutations cannot change the persisted fixed snapshot',async()=>{
 const input={nested:{text:'original'}};
 const send=vi.fn(async(payload:typeof input)=>{payload.nested.text='transport mutation';throw new ApiError('lost');});
 await expect(sendWriteIntent(key,()=>input,send,recovery)).rejects.toThrow();
 input.nested.text='new input';
 const held=useWriteIntentStore.getState().entries[key]!;
 expect(held.payload).toEqual({nested:{text:'original'}});
 expect(Object.isFrozen((held.payload as typeof input).nested)).toBe(true);
 expect(Object.isFrozen((readWriteIntents().entries[key]!.payload as typeof input).nested)).toBe(true);
});

test('new direct unknowns serialize Task writes until explicit reconciliation, and failure releases that lock',async()=>{
 const restore=intentKey(root,'task/restore','T1');
 await expect(sendWriteIntent(restore,()=>({task:'T1',expectedTaskHash:'h1'}),async()=>{throw new ApiError('lost');},{path:'task/restore',response:'task',label:'T1'})).rejects.toThrow();
 const other=intentKey(root,'title','T1');
 expect(submitWriteIntent(other,()=>({title:'new'}),async()=>42)).toBeUndefined();
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(problem(400,'fix')));
 await expect(checkDirectIntent(client,restore)).rejects.toMatchObject({retry:'fix'});
 await expect(submitWriteIntent(other,()=>({title:'new'}),async()=>42)).resolves.toBe(42);
});

test('storage admission fault sends nothing and leaves the old fixed operation intact',async()=>{
 await expect(sendWriteIntent(key,()=>({title:'Foo'}),async()=>{throw new ApiError('lost');},recovery)).rejects.toThrow();
 const before=sessionStorage.getItem('alpacawork-write-intents-v5');
 const fetcher=vi.fn().mockRejectedValue(new TypeError('lost'));vi.stubGlobal('fetch',fetcher);
 vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw Error('quota');});
 await expect(checkDirectIntent(client,key)).rejects.toBeInstanceOf(ApiError);
 expect(fetcher).not.toHaveBeenCalled();
 expect(sessionStorage.getItem('alpacawork-write-intents-v5')).toBe(before);
 expect(useWriteIntentStore.getState()).toMatchObject({unavailable:true,entries:{[key]:{status:'unconfirmed',payload:{title:'Foo'}}}});
});

test('a late failure from an earlier attempt cannot replace the checked terminal result',async()=>{
 let fail!:(error:unknown)=>void;
 const old=sendWriteIntent(key,()=>({title:'Foo'}),()=>new Promise((_,reject)=>{fail=reject;}),recovery);
 useWriteIntentStore.setState(readWriteIntents());
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(problem(409,'reread')));
 await expect(checkDirectIntent(client,key)).rejects.toMatchObject({retry:'reread'});
 fail(new ApiError('late lost'));await expect(old).rejects.toThrow('late lost');
 expect(useWriteIntentStore.getState().entries[key]!.status).toBe('conflict');
});



test('independent project admission leaves an unknown fixed project unchanged', async () => {
 const foo = intentKey(root, 'project/new', 'foo'), bar = intentKey(root, 'project/new', 'bar');
 const fetcher = vi.fn().mockRejectedValueOnce(new TypeError('not arrived')).mockResolvedValueOnce(new Response(JSON.stringify({task:headOf(dto({id:'T2',kind:'project',title:'Bar'}))})));
 vi.stubGlobal('fetch', fetcher);
 await expect(sendDirectIntent(client,foo,recovery,()=>({kind:'project',title:'Foo'}),workspaceWriteBasis())).rejects.toBeInstanceOf(ApiError);
 const held=structuredClone(useWriteIntentStore.getState().entries[foo]);
 await expect(sendDirectIntent(client,bar,{...recovery,label:'Bar'},()=>({kind:'project',title:'Bar'}),workspaceWriteBasis())).resolves.toMatchObject({task:{id:'T2',kind:'project'}});
 expect(fetcher).toHaveBeenCalledTimes(2);
 expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toEqual({kind:'project',title:'Bar'});
 expect(new Headers(fetcher.mock.calls[1]![1].headers).get('X-Alpacawork-Op-Id')).not.toBe(held!.operationId);
 expect(useWriteIntentStore.getState().entries[foo]).toEqual(held);
});

test('a frozen pre-migration report response remains unknown after reload and preserves the same operation and original input', async()=>{
  const report=intentKey(root,'task/report','T1');
  const recovery={path:'task/report',response:'task' as const,label:'T1'};
  const original={task:'T1',state:'done',expectedTaskHash:'0'.repeat(64),title:'Original decision',description:'Original words'};
  const oldDto=structuredClone(dto());
  // The response was frozen before explicit Request purpose/review targets existed. It must not be rewritten or guessed.
  oldDto.log=[{id:'old-admission',kind:'request_accepted',at:'2026-10-22T00:00:00Z',title:null,description:null,
    actor:{kind:'main',provider:'codex',conversationId:'historical',quote:{source:'policy',taskId:'T1',taskHash:'0'.repeat(64),text:'Original quote'}},
    fromState:'todo',toState:null}] as any;
  const frozen=JSON.stringify({task:oldDto,outcome:{kind:'recorded'}});
  const fetcher=vi.fn().mockRejectedValueOnce(new TypeError('response lost'))
    .mockImplementation(async()=>new Response(frozen,{headers:{'Content-Type':'application/json'}}));
  vi.stubGlobal('fetch',fetcher);
  await expect(sendDirectIntent(client,report,recovery,()=>structuredClone(original),detailWriteBasis('T1',dto().hash))).rejects.toMatchObject({retry:'check'});
  const held=structuredClone(useWriteIntentStore.getState().entries[report]);
  useWriteIntentStore.setState(readWriteIntents());
  await expect(checkDirectIntent(client,report)).rejects.toMatchObject({code:'invalid_response',retry:'check'});
  const after=useWriteIntentStore.getState().entries[report]!;
  expect(after).toMatchObject({status:'unconfirmed',operationId:held!.operationId,payload:original});
  expect(fetcher.mock.calls[1]![1].body).toBe(fetcher.mock.calls[0]![1].body);
  expect(new Headers(fetcher.mock.calls[1]![1].headers).get('X-Alpacawork-Op-Id')).toBe(held!.operationId);
  await expect(sendDirectIntent(client,report,recovery,()=>({...original,description:'New words'}),detailWriteBasis('T1',dto().hash))).rejects.toBeInstanceOf(ApiError);
  expect(fetcher).toHaveBeenCalledTimes(2);expect(after.payload).toEqual(original);
});

test('retired v3 and v4 storage, which could hold an unconfirmed write of a removed input, is not read', () => {
  const unconfirmed = { status: 'unconfirmed', operationId: 'op-1', transport: 'receipt', attempt: 'a-1', at: '2026-10-26T00:00:00Z' };
  sessionStorage.setItem('alpacawork-write-intents-v3', JSON.stringify({ version: 1, entries: { [intentKey(root, 'title', 'T3')]: { ...unconfirmed, payload: { id: 'T3', title: 'Old', expected: 'hash' } } } }));
  sessionStorage.setItem('alpacawork-write-intents-v4', JSON.stringify({ version: 1, entries: { [intentKey(root, 'create', 'P100')]: { ...unconfirmed, payload: { parent: 'P100', title: 'Old', expected: 'hash' } } } }));
  expect(readWriteIntents()).toEqual({ entries: {}, unavailable: false });
});
