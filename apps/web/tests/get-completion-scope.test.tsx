import { afterEach, expect, test, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { readDemandPending, requestRead } from '../src/data/read-demand';
import { readQuery, readScope, cutReadScope, getReadProof, readAcquisition, acceptedGet, readGetTicket, beginReadReceipt } from '../src/data/read-model';
import { resources, receiveFullIndex, fetchAcceptedResource, applyReadEvidence } from '../src/data/resources';
import { dto, tree, indexOf, viewsOf } from './fixtures';
const clients: QueryClient[]=[];
afterEach(()=>{for(const c of clients.splice(0))c.clear();vi.restoreAllMocks();});
function fixture(){const c=new QueryClient({defaultOptions:{queries:{retry:false,networkMode:'always'}}});clients.push(c);const value=tree({tasks:[dto()]});const index=indexOf(value);receiveFullIndex(c,index);const options=resources.taskView(index.root,'T1');return {c,index,options,value:viewsOf(value)[0]};}

test('a scope cut queued by the success listener must not pay pending demand or certify the exact direct GET',async()=>{
  const {c,options,value}=fixture();
  const query=c.getQueryCache().build(c,{queryKey:options.queryKey});requestRead(query);
  const order:string[]=[];
  const stop=c.getQueryCache().subscribe(e=>{if(e.query===query&&e.type==='updated'&&e.action.type==='success'&&!e.action.manual){order.push('success');queueMicrotask(()=>{cutReadScope(c);order.push('cut');});}});
  vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json(value));
  const reading=fetchAcceptedResource(c,options),ticket=readGetTicket(query);
  let result:unknown;try{await reading;result='accepted';}catch{result='rejected';}
  stop();
  expect(readScope(c)?.anchored).toBe(false);expect(order).toEqual(['success','cut']);
  console.log('SCOPE_WINDOW',JSON.stringify({result,pending:readDemandPending(query),accepted:acceptedGet(ticket,value),scope:readScope(c),proof:getReadProof(query),source:readAcquisition(query)?.source}));
  expect(result).toBe('rejected');expect(readDemandPending(query)).toBe(true);
});

test('synchronous success listeners cannot see completed demand before the acceptance microtask',async()=>{
 const {c,options,value}=fixture();const query=c.getQueryCache().build(c,{queryKey:options.queryKey});requestRead(query);
 const observations:boolean[]=[];const stop=c.getQueryCache().subscribe(e=>{if(e.query===query&&e.type==='updated'&&e.action.type==='success'&&!e.action.manual)observations.push(readDemandPending(query));});
 vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json(value));await fetchAcceptedResource(c,options);stop();expect(observations).toEqual([true]);expect(readDemandPending(query)).toBe(false);
});

for (const change of ['scope', 'identity', 'retirement', 'receipt', 'refusal'] as const) test(`settled caller and completion share the ${change} boundary`, async () => {
  const { c, index, options, value } = fixture();
  const query = c.getQueryCache().build(c, { queryKey: options.queryKey }); requestRead(query);
  const stop = c.getQueryCache().subscribe(event => {
    if (event.query !== query || event.type !== 'updated' || event.action.type !== 'success' || event.action.manual) return;
    queueMicrotask(() => {
      if (change === 'scope') cutReadScope(c);
      if (change === 'identity') receiveFullIndex(c, { ...index, generation: 'replacement' });
      if (change === 'retirement') { c.removeQueries({ queryKey: options.queryKey, exact: true }); c.getQueryCache().build(c, { queryKey: options.queryKey }); }
      if (change === 'receipt') beginReadReceipt(query);
      if (change === 'refusal') applyReadEvidence(c, { kind: 'refused', query });
    });
  });
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(value));
  await expect(fetchAcceptedResource(c, options)).rejects.toBeTruthy(); stop();
  if (change !== 'retirement' && change !== 'identity') expect(readDemandPending(query)).toBe(true);
  expect(vi.mocked(fetch).mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
});

test('a legal settled GET remains accepted until its exact target or captured scope changes', async () => {
  const { c, options, value } = fixture(); const query = c.getQueryCache().build(c, { queryKey: options.queryKey }); requestRead(query);
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(value));
  const reading = c.fetchQuery(options), ticket = readGetTicket(query)!; const raw = await reading;
  expect(ticket.settled).toBe(true); expect(acceptedGet(ticket, raw)).toBe(true); expect(readDemandPending(query)).toBe(false);
  expect(acceptedGet(ticket, { ...raw })).toBe(false);
  cutReadScope(c); expect(acceptedGet(ticket, raw)).toBe(false);
});
