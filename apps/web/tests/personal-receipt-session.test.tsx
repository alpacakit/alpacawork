import { afterEach, beforeAll, test, expect, vi } from 'vitest';
import { startI18n } from '@alpacawork/i18n';
import { defaultSettings } from '@alpacawork/contract';
import { queryClient } from '../src/data/query-client';
import { usePersonalSettings } from '../src/data/personal-settings';
import { useWriteIntentStore } from '../src/data/write-intent';
import { receiveFullIndex, resources, discardReadResources } from '../src/data/resources';
import { captureReadBoundary, sameReadSession } from '../src/data/read-model';
import { seedPersonal } from './read-fixtures';
beforeAll(()=>startI18n());
afterEach(()=>{vi.restoreAllMocks();queryClient.clear();usePersonalSettings.setState(usePersonalSettings.getInitialState(),true);useWriteIntentStore.setState({entries:{},unavailable:false})});
for(const boundary of ['root-ABA','clear-recreate','query-recreate'] as const)
test(`old personal POST must not qualify replacement session after ${boundary}`,async()=>{
 queryClient.clear();const values=defaultSettings();seedPersonal({root:'/fixture',values,revision:'r1',status:'ready'});
 const oldIndex=queryClient.getQueryData<any>(['index'])!;
 const old=captureReadBoundary(queryClient);
 let resolve!:(r:Response)=>void;const pending=new Promise<Response>(r=>resolve=r);
 vi.spyOn(globalThis,'fetch').mockReturnValue(pending);
 const save=usePersonalSettings.getState().save('theme','dark');
 if(boundary==='root-ABA') receiveFullIndex(queryClient,{...oldIndex,root:'/other'});
 else if(boundary==='clear-recreate') discardReadResources(queryClient);
 else queryClient.removeQueries({queryKey:resources.personalSettings('/fixture').queryKey,exact:true});
 seedPersonal({root:'/fixture',values,revision:'r1',status:'ready'});
 expect(sameReadSession(queryClient,old)).toBe(boundary==='query-recreate');
 resolve(new Response(JSON.stringify({values:{...values,theme:'dark'},revision:'r2'})));
 const saved=await save;
 console.log('INDEPENDENT boundary',boundary,JSON.stringify({saved,person:usePersonalSettings.getState().values,revision:usePersonalSettings.getState().revision,cache:queryClient.getQueryData(resources.personalSettings('/fixture').queryKey)}));
 expect(usePersonalSettings.getState().revision).toBe('r1');
 expect(usePersonalSettings.getState().values).toEqual(values);
});

test('a later successful GET with the same revision cannot erase the refusal crossed by an older POST', async () => {
 const values=defaultSettings(); seedPersonal({root:'/fixture',values,revision:'r1',status:'ready'});
 let release!:(r:Response)=>void; const pending=new Promise<Response>(resolve=>release=resolve);
 let deny=true;
 vi.spyOn(globalThis,'fetch').mockImplementation(async (_url,init)=>init?.method==='POST' ? pending
  : deny ? Response.json({error:{code:'forbidden',retry:'fix',message:'revoked'}},{status:403}) : Response.json({values,revision:'r1'}));
 const saving=usePersonalSettings.getState().save('theme','dark');
 const options=resources.personalSettings('/fixture');
 await queryClient.fetchQuery({...options,staleTime:0}).catch(()=>{});
 deny=false;await queryClient.fetchQuery({...options,staleTime:0});
 release(Response.json({values:{...values,theme:'dark'},revision:'r2'}));
 expect(await saving).toBe(false);
 expect(usePersonalSettings.getState().revision).toBe('r1');
 expect(usePersonalSettings.getState().values).toEqual(values);
});
