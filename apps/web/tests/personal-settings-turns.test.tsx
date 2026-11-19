// One setting's saves run in turn in the personal settings Owner;
// a save that waited belongs to the read session it was made in, and refuses itself once that session is gone.
import {afterEach,beforeAll,beforeEach,expect,test,vi} from 'vitest';
import {startI18n} from '@alpacawork/i18n';
import {defaultSettings} from '@alpacawork/contract';
import {queryClient} from '../src/data/query-client';
import {usePersonalSettings} from '../src/data/personal-settings';
import {useWriteIntentStore,intentKey} from '../src/data/write-intent';
import {receiveFullIndex,discardReadResources} from '../src/data/resources';
import {useConnection} from '../src/data/connection';
import {seedPersonal} from './read-fixtures';
import {problemResponse} from './problem';
beforeAll(()=>startI18n());
beforeEach(()=>{queryClient.clear();useWriteIntentStore.setState({entries:{},unavailable:false});seedPersonal({root:'/fixture',values:defaultSettings(),revision:'r1'});});
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();usePersonalSettings.setState(usePersonalSettings.getInitialState(),true);});
for(const boundary of ['root','generation-and-restore','clear-recreate','root-ABA'] as const)
test(`queued old choice must not acquire replacement ${boundary} scope`,async()=>{
 const values=defaultSettings();let release!:(r:Response)=>void;
 const writes:any[]=[];
 vi.spyOn(globalThis,'fetch').mockImplementation((_url,init)=>{
  const body=JSON.parse(String(init?.body));writes.push({body,headers:Object.fromEntries(new Headers(init?.headers)),root:usePersonalSettings.getState().root});
  return writes.length===1?new Promise<Response>(r=>release=r):Promise.resolve(Response.json({values:{...values,theme:body.value},revision:'new-r2'}));
 });
 const first=usePersonalSettings.getState().save('theme','dark');
 const queued=usePersonalSettings.getState().save('theme','light');
 const old=queryClient.getQueryData<any>(['index']);
 if(boundary==='root') seedPersonal({root:'/other',values,revision:'new-r1'});
 if(boundary==='generation-and-restore'){
  receiveFullIndex(queryClient,{...old,generation:'replacement',restoreId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc'});
  seedPersonal({root:'/fixture',values,revision:'new-r1'});
 }
 if(boundary==='clear-recreate'){discardReadResources(queryClient);seedPersonal({root:'/fixture',values,revision:'new-r1'});}
 if(boundary==='root-ABA'){seedPersonal({root:'/other',values,revision:'other-r1'});seedPersonal({root:'/fixture',values,revision:'new-r1'});}
 release(Response.json({values:{...values,theme:'dark'},revision:'old-r2'}));
 const results=await Promise.all([first,queued]);
 console.info('queue scope evidence',JSON.stringify({boundary,results,writes,final:usePersonalSettings.getState().values.theme,state:{fresh:usePersonalSettings.getState().fresh,status:usePersonalSettings.getState().status},entries:useWriteIntentStore.getState().entries}));
 expect.soft(results[1]).toBe(false);
 expect.soft(writes).toHaveLength(1);
 expect.soft(usePersonalSettings.getState().values.theme).toBe(values.theme);
});
for(const [key,first,last] of [['language','ja','en'],['theme','dark','light'],['push.done',true,false],['push.quiet',true,false],['push.quietFrom','21:00','22:00']] as const)
test(`same ${key} choices serialize and final choice stays`,async()=>{
 const values=defaultSettings();let release!:(r:Response)=>void;const writes:any[]=[];
 vi.spyOn(globalThis,'fetch').mockImplementation((_url,init)=>{
  const body=JSON.parse(String(init?.body));writes.push(body);
  const answer=()=>Response.json({values:{...values,[key]:body.value},revision:`r${writes.length+1}`});
  return writes.length===1?new Promise<Response>(r=>release=r):Promise.resolve(answer());
 });
 const a=usePersonalSettings.getState().save(key,first), b=usePersonalSettings.getState().save(key,last);
 expect(writes).toHaveLength(1);release(Response.json({values:{...values,[key]:first},revision:'r2'}));
 expect(await Promise.all([a,b])).toEqual([true,true]);expect(writes.map(w=>w.value)).toEqual([first,last]);expect(usePersonalSettings.getState().values[key]).toBe(last);
});
test('queued save ends false after ten seconds offline and does not send when later reconnected',async()=>{
 vi.useFakeTimers();const values=defaultSettings();let release!:(r:Response)=>void;const writes:any[]=[];
 vi.spyOn(globalThis,'fetch').mockImplementation((_url,init)=>{writes.push(JSON.parse(String(init?.body)));return new Promise<Response>(r=>release=r);});
 const a=usePersonalSettings.getState().save('theme','dark'),b=usePersonalSettings.getState().save('theme','light');
 useConnection.setState({offline:true});release(Response.json({values:{...values,theme:'dark'},revision:'r2'}));await a;
 let ended=false;void b.then(()=>ended=true);await vi.advanceTimersByTimeAsync(9999);expect(ended).toBe(false);
 await vi.advanceTimersByTimeAsync(1);expect(await b).toBe(false);expect(writes).toHaveLength(1);
 useConnection.setState({offline:false,state:'live'});await vi.advanceTimersByTimeAsync(1);expect(writes).toHaveLength(1);
});
test('queued save after network uncertainty refuses instead of replacing an unconfirmed operation',async()=>{
 let reject!:(e:Error)=>void;const writes:any[]=[];
 vi.spyOn(globalThis,'fetch').mockImplementation((_url,init)=>{if(init?.method==='POST'){writes.push(JSON.parse(String(init.body)));return new Promise<Response>((_,r)=>reject=r);}return Promise.resolve(Response.json({values:defaultSettings(),revision:'r1'}));});
 const a=usePersonalSettings.getState().save('theme','dark'),b=usePersonalSettings.getState().save('theme','light');
 reject(new TypeError('offline'));expect(await Promise.all([a,b])).toEqual([false,false]);expect(writes).toHaveLength(1);
 expect(useWriteIntentStore.getState().entries[intentKey('/fixture','personal-setting:theme',null)]?.status).toBe('unconfirmed');
});
