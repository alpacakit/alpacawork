import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { startI18n } from '@alpacawork/i18n';
import { MarkdownBody } from '../src/features/reader/MarkdownBody';
import { SentMessage as MessageParts, useMessageParts } from '../src/features/coordinator/SentMessage';
import { taskReferencesIn, textDocument } from '../src/features/coordinator/editor/document';
import { queryClient } from '../src/data/query-client';
import { useConnection } from '../src/data/connection';
import { resources, observeReadRefusals } from '../src/data/resources';
import { readerTaskRow } from '../src/data/resources';
import { dto, pointerCanHover, screenData, TestWorkspace, tree, viewsOf } from './fixtures';

function SentMessage({ text }: { text: string }) {
  return <MessageParts parts={useMessageParts(text, [])} />;
}

beforeAll(() => startI18n());
afterEach(() => { cleanup(); queryClient.clear(); vi.restoreAllMocks(); });
function fixture(text = 'T9001（完了）・T9002、T9003の報告。P999（project） T9999') {
  queryClient.clear();
  useConnection.setState({ state: 'live', offline: false });
  const data = screenData(tree({ tasks: [dto({ id: 'T1' })] }));
  const closed = viewsOf(tree({ tasks: [dto({ id: 'T9001', title: 'Finished task', baseState: 'done' })] })).find(view => view.task.id === 'T9001')!;
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(closed)));
  const follow = vi.fn();
  const rendered = render(<TestWorkspace data={data}><MarkdownBody text={text} task={null} onFollow={follow} /></TestWorkspace>);
  return { ...rendered, fetcher, follow, data, closed };
}
test('Reader links every canonical ID outside the live index and preserves its existing word boundaries', () => {
  const f = fixture('T9001（完了）・T9002、T9003の報告。P999（project） T9999 T12abc abcT12 T1.5 Ｔ９００１');
  expect([...f.container.querySelectorAll('[data-task-reference]')].map(node => node.getAttribute('data-task-reference')))
    .toEqual(['T9001', 'T9002', 'T9003', 'P999', 'T9999']);
  expect(f.fetcher).not.toHaveBeenCalled();
});
test('pressing a closed reference fetches its actual card without admitting it to the live list', async () => {
  const f = fixture();
  fireEvent.click(screen.getByRole('button', { name: 'T9001' }));
  await screen.findByText('Finished task');
  expect(f.data.tasks.some(task => task.id === 'T9001')).toBe(false);
  fireEvent.click(document.querySelector('[data-task-card-open]')!);
  expect(f.follow).toHaveBeenCalledWith('T9001');
  expect(f.fetcher).toHaveBeenCalledTimes(1);
});
test('hovering a closed reference reads its actionable card through the same task view', async () => {
  pointerCanHover();
  const f = fixture();
  fireEvent.pointerEnter(screen.getByRole('button', { name: 'T9001' }), { pointerType: 'mouse' });
  await waitFor(() => expect(document.querySelector('[data-badge-card]')?.textContent).toContain('Finished task'));
  expect(document.querySelector('[data-task-card-open]')).not.toBeNull();
  expect(document.querySelector('[data-task-peek]')).toBeNull();
  expect(f.fetcher).toHaveBeenCalledTimes(1);
});
test.each(['press', 'hover'])('a missing reference shows the server refusal without retry in its %s', async surface => {
  if (surface === 'hover') pointerCanHover();
  const f = fixture();
  f.fetcher.mockImplementation(async () => new Response(JSON.stringify({ error: { code: 'not_found', message: 'Not found.', retry: 'fix' } }), { status: 404 }));
  const reference = screen.getByRole('button', { name: 'T9999' });
  if (surface === 'press') fireEvent.click(reference);
  else fireEvent.pointerEnter(reference, { pointerType: 'mouse' });
  await waitFor(() => expect(document.querySelector('[data-read-failure]')?.textContent).toMatch(/not found/i));
  expect(document.querySelector('[data-read-failure] button')).toBeNull();
  expect(document.querySelector('[data-task-card-open]')).toBeNull();
  expect(screen.getByRole('button', { name: 'T9001' })).toBeTruthy();
});
test.each(['press', 'hover'])('a deleted Task returned by the API is unavailable in its %s card', async surface => {
  if (surface === 'hover') pointerCanHover();
  const f = fixture();
  const deleted = viewsOf(tree({ tasks: [dto({ id: 'T9001', title: 'Deleted task', lifecycle: 'deleted' })] })).find(view => view.task.id === 'T9001')!;
  f.fetcher.mockImplementation(async () => new Response(JSON.stringify(deleted)));
  const reference = screen.getByRole('button', { name: 'T9001' });
  if (surface === 'press') fireEvent.click(reference);
  else fireEvent.pointerEnter(reference, { pointerType: 'mouse' });
  await waitFor(() => expect(document.querySelector('[data-badge-card] [data-read-failure]')?.textContent).toMatch(/not found/i));
  expect(document.querySelector('[data-read-failure] button')).toBeNull();
  expect(document.querySelector('[data-task-card-open]')).toBeNull();
  expect(screen.queryByText('Deleted task')).toBeNull();
});
test.each(['press', 'hover'])('a network failure keeps retry in its %s and retry recovers the task', async surface => {
  if (surface === 'hover') pointerCanHover();
  const f = fixture();
  f.fetcher.mockRejectedValue(new TypeError('Connection failed'));
  const reference = screen.getByRole('button', { name: 'T9001' });
  if (surface === 'press') fireEvent.click(reference);
  else fireEvent.pointerEnter(reference, { pointerType: 'mouse' });
  const retry = await screen.findByRole('button', { name: 'Retry' });
  f.fetcher.mockResolvedValue(new Response(JSON.stringify(f.closed)));
  fireEvent.click(retry);
  await screen.findByText('Finished task');
  expect(document.querySelector('[data-read-failure]')).toBeNull();
});
test('sent words render a closed ID as a label before a title is known and update when the card reads it', async () => {
  const f = fixture(); f.unmount();
  const sent = render(<TestWorkspace data={f.data}><SentMessage text="T9001 参照" /></TestWorkspace>);
  const badge = sent.container.querySelector<HTMLButtonElement>('[data-label=task]')!;
  expect(badge.textContent).toBe('T9001');
  expect(f.fetcher).not.toHaveBeenCalled();
  fireEvent.click(badge);
  await waitFor(() => expect(badge.textContent).toContain('Finished task'));
});
test('draft prose keeps a closed target even when no live row supplies its title', () => {
  expect([...taskReferencesIn(textDocument('T9001の報告'), [])]).toEqual(['T9001']);
});

test('a closed sent label follows qualified reads from another surface, refusal, and recovery', async () => {
  const f=fixture();f.unmount();
  const sent=render(<TestWorkspace data={f.data}><SentMessage text="T9001" /></TestWorkspace>);
  const badge=sent.container.querySelector<HTMLButtonElement>('[data-label=task]')!;
  observeReadRefusals(queryClient);
  const options=resources.taskView('/fixture','T9001');
  await act(async()=>{await queryClient.fetchQuery(options);});
  await waitFor(()=>expect(badge.textContent).toContain('Finished task'));
  expect(queryClient.getQueryCache().find({queryKey:options.queryKey,exact:true})!.getObserversCount()).toBe(0);
  f.fetcher.mockImplementation(async()=>new Response(JSON.stringify({error:{code:'not_found',message:'Gone',retry:'fix'}}),{status:404}));
  await act(async()=>{await queryClient.fetchQuery({...options,staleTime:0}).catch(()=>{});});
  await waitFor(()=>expect(badge.textContent).toBe('T9001'));
  f.fetcher.mockResolvedValue(new Response(JSON.stringify(f.closed)));
  await act(async()=>{await queryClient.fetchQuery({...options,staleTime:0});});
  await waitFor(()=>expect(badge.textContent).toContain('Finished task'));
  const deleted=viewsOf(tree({tasks:[dto({id:'T9001',title:'Deleted task',lifecycle:'deleted'})]})).find(view=>view.task.id==='T9001')!;
  f.fetcher.mockResolvedValue(new Response(JSON.stringify(deleted)));
  await act(async()=>{await queryClient.fetchQuery({...options,staleTime:0});});
  await waitFor(()=>expect(badge.textContent).toBe('T9001'));
});

