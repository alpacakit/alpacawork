import { test, expect, vi, afterEach } from 'vitest';
import { queryClient } from '../src/data/query-client';
import { createNoticeStore } from '../src/data/notice-store';
import { NOTICE_VERSION } from '../src/data/notice-model';
import { resources, receiveFullIndex, assessRead } from '../src/data/resources';
import { readQuery, readRefused } from '../src/data/read-model';
import { useConnection } from '../src/data/connection';
import { tree, indexOf } from './fixtures';
afterEach(()=>{vi.restoreAllMocks();queryClient.clear()});
test('late first notice-save receipt must not undo a later HTTP403 on that same read',async()=>{
 queryClient.clear();const index=indexOf(tree());receiveFullIndex(queryClient,{...index,person:{...index.person,notices:null}});useConnection.setState({state:'live',offline:false});
 const store=createNoticeStore();store.getState().bind(index.root);
 let release!:(r:Response)=>void, started=false, deny=false;
 const post=new Promise<Response>(r=>release=r);
 vi.spyOn(globalThis,'fetch').mockImplementation(async(url,init)=>{
  if(init?.method==='POST'){started=true;return post;}
  return new Response(JSON.stringify(deny?{error:{code:'forbidden',retry:'fix',message:'permission revoked'}}:{state:null,revision:null,initialBaselines:{}}),{status:deny?403:200});
 });
 const saving=store.getState().reload();await vi.waitFor(()=>expect(started).toBe(true));
 deny=true;await queryClient.fetchQuery({...resources.notices(index.root),staleTime:0}).catch(()=>{});
 const query=readQuery(queryClient,resources.notices(index.root).queryKey)!;
 expect(readRefused(query)).toBe(true);expect(store.getState().fresh).toBe(false);
 release(new Response(JSON.stringify({state:{version:NOTICE_VERSION,checkpoint:{at:new Date().toISOString(),tasks:{}},reads:{}},revision:'late-n1'})));
 await saving;
 console.log('INDEPENDENT late-first-notice',JSON.stringify({refused:readRefused(query),assessment:assessRead(queryClient,query),fresh:store.getState().fresh,revision:store.getState().revision}));
 expect.soft(readRefused(query)).toBe(true);expect.soft(query.state.data).toBeUndefined();expect.soft(store.getState().fresh).toBe(false);
});
