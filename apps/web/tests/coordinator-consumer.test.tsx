import { memo } from 'react';
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { i18n, startI18n } from '@alpacawork/i18n';
import { CoordinatorCard } from '../src/features/coordinator/CoordinatorCard';
import { ShownConversationProvider, useShownConversation } from '../src/features/coordinator/shown';
import { SentMessage as MessageParts, useMessageParts } from '../src/features/coordinator/SentMessage';
import { useReaderTask, useWriteDisabled, useTaskReadState } from '../src/data/queries';
import * as times from '../src/features/coordinator/message-time';
import * as reads from '../src/data/read-model';
import { queryClient } from '../src/data/query-client';
import { setConversationState, snapshotJson } from './conversation-fixture';
import { screenData, TestWorkspace, tree, dto } from './fixtures';

function SentMessage({ text }: { text: string }) {
  return <MessageParts parts={useMessageParts(text, [])} />;
}

beforeAll(async () => { await startI18n(); await i18n.changeLanguage('en'); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); queryClient.clear(); setConversationState({ conversation:null, open:true, expanded:false, engaged:false }); });
function setup() {
  const data=screenData(tree({tasks:[dto(),dto({id:'T13'})]}));
  const at='2026-11-03T00:15:00Z';
  const turn={id:'stable-turn',at,ask:'T13',tasks:['T13'],attachments:[],status:'succeeded' as const,waiting:false,answer:'Stable answer',seen:true,answeredAt:at,error:null,result:null};
  const conversation={id:'consumer-test',agent:null,warm:'none' as const,busy:false,cancelled:[],turns:[turn]};
  setConversationState({conversation,open:false,expanded:false,engaged:false,read:true});
  vi.spyOn(globalThis,'fetch').mockImplementation(async()=>new Response(snapshotJson(conversation)));
  return {data,turn};
}

test('an unrelated parent commit retains the shown context and formats no message again', async()=>{
  const {data,turn}=setup(); const seen=vi.fn();
  const Probe=memo(function Probe(){seen(useShownConversation());return null;});
  const formatted=vi.spyOn(times,'messageTime');
  const ui=()=> <TestWorkspace data={data}><ShownConversationProvider><Probe /></ShownConversationProvider><CoordinatorCard /></TestWorkspace>;
  const view=render(ui());await waitFor(()=>expect(formatted).toHaveBeenCalledWith(turn.at,'en'));
  const value=seen.mock.calls.at(-1)![0];seen.mockClear();formatted.mockClear();
  view.rerender(ui());
  expect(seen).not.toHaveBeenCalled(); expect(formatted).not.toHaveBeenCalled();
  expect(value.pressed.size).toBe(0);
});

test('the Card parent still propagates local day and runtime zone changes through the memo', async()=>{
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-11-03T01:00:00Z'));
  const {data}=setup(); const Native=Intl.DateTimeFormat;let zone='UTC';
  vi.spyOn(Intl,'DateTimeFormat').mockImplementation(function(locales,options){return new Native(locales,{...options,timeZone:zone});});
  const formatted=vi.spyOn(times,'messageTime');const ui=()=> <TestWorkspace data={data}><CoordinatorCard /></TestWorkspace>;
  const view=render(ui());expect(formatted).toHaveBeenCalled();formatted.mockClear();
  vi.setSystemTime(new Date('2026-11-04T01:00:00Z'));view.rerender(ui());expect(formatted).toHaveBeenCalled();formatted.mockClear();
  zone='Asia/Tokyo';view.rerender(ui());expect(formatted).toHaveBeenCalled();
});

test('reader and write snapshots keep their subscriptions on a parent commit',()=>{
  const {data}=setup();const subscribe=vi.spyOn(reads,'subscribeReads');
  function Probe(){useReaderTask('T1');useWriteDisabled();useTaskReadState('/fixture','T1',false);return null;}
  const ui=()=> <TestWorkspace data={data}><Probe /></TestWorkspace>;const view=render(ui());expect(subscribe).toHaveBeenCalled();subscribe.mockClear();view.rerender(ui());expect(subscribe).not.toHaveBeenCalled();
});

test('a closed sent reference keeps its row title without observing a task Query',()=>{
  const {data}=setup();render(<TestWorkspace data={data}><SentMessage text="T13" /></TestWorkspace>);
  expect(document.querySelector('[data-label=task]')?.textContent).toContain('T13');
  expect(reads.readQuery(queryClient,['task','/fixture','T13'])?.getObserversCount() ?? 0).toBe(0);
});
