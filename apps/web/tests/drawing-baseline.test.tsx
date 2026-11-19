import { StrictMode, useRef } from 'react';
import { act, cleanup, render, renderHook } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useTint } from '../src/lib/motion';
import type { DrawingSource } from '../src/lib/drawing';
import { useDisplayReadFacts } from '../src/data/use-read-facts';
import { useReadPersistence } from '../src/data/read-persistence';
import { readScope, restoreReadScope, recordReadProof, captureReadProof } from '../src/data/read-model';
import { receiveFullIndex } from '../src/data/resources';
import { dto, indexOf, tree } from './fixtures';

const source = (root: string, restoredAt: number | null = null): DrawingSource => ({ root, restoredAt });
function Row({ value, source, name = 'row' }: { value: string; source: DrawingSource; name?: string }) {
  const element = useRef<HTMLDivElement>(null);
  useTint(element, 'row:T1', value, source);
  return <div ref={element} data-name={name} />;
}
afterEach(() => { cleanup(); useReadPersistence.setState({ restoredAt: null }); });

test('saved baseline, including an equal first live, advances to ordinary live changes under effect replay', () => {
  const animate = vi.spyOn(Element.prototype, 'animate');
  const draw = (value: string, restoredAt: number | null) => <StrictMode><Row value={value} source={source('equal-first', restoredAt)} /></StrictMode>;
  const row = render(draw('saved', 123));
  row.rerender(draw('saved', null));
  expect(animate).not.toHaveBeenCalled();
  row.rerender(draw('new', null));
  expect(animate).toHaveBeenCalledTimes(1);
  row.rerender(draw('new', null));
  expect(animate).toHaveBeenCalledTimes(1);
});

test('different saved-to-live values rebase, each mounted copy tints later, movement remembers and roots do not mix', () => {
  const animate = vi.spyOn(Element.prototype, 'animate');
  const pair = (value: string, restoredAt: number | null) => <><Row value={value} source={source('copies', restoredAt)} name="a" /><Row value={value} source={source('copies', restoredAt)} name="b" /></>;
  const rows = render(pair('saved', 123));
  rows.rerender(pair('latest', null));
  expect(animate).not.toHaveBeenCalled();
  rows.rerender(pair('ordinary', null));
  expect(animate).toHaveBeenCalledTimes(2);
  rows.unmount();
  const moved = render(<Row value="moved" source={source('copies')} />);
  expect(animate).toHaveBeenCalledTimes(3);
  moved.rerender(<Row value="another" source={source('other-root')} />);
  expect(animate).toHaveBeenCalledTimes(3);
  moved.rerender(<Row value="ordinary" source={source('other-root')} />);
  expect(animate).toHaveBeenCalledTimes(4);
});

test('the external-store snapshot pairs facts with restoredAt, preserves earlier observations, and rebases equal live data', () => {
  const client = new QueryClient(), other = new QueryClient();
  try {
    const index = indexOf(tree({ root: 'saved-root', tasks: [dto()] }));
    client.setQueryData(['index'], index);
    const query = client.getQueryCache().find({ queryKey: ['index'] })!;
    recordReadProof(query, captureReadProof(index, ['index']));
    restoreReadScope(client, false);
    useReadPersistence.setState({ restoredAt: 123 });
    const wrapper = ({ children }: any) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const h = renderHook(useDisplayReadFacts, { wrapper });
    const saved = h.result.current;
    expect(saved.index?.root).toBe('saved-root'); expect(saved.restoredAt).toBe(123);
    act(() => { receiveFullIndex(client, index); useReadPersistence.setState({ restoredAt: null }); });
    expect(readScope(client)?.restored).toBe(false);
    expect(h.result.current.restoredAt).toBeNull();
    expect(h.result.current).not.toBe(saved); expect(saved.restoredAt).toBe(123);
    receiveFullIndex(other, { ...index, root: 'other' });
    useReadPersistence.setState({ restoredAt: 999 });
    const live = renderHook(useDisplayReadFacts, { wrapper: ({ children }: any) => <QueryClientProvider client={other}>{children}</QueryClientProvider> });
    expect(live.result.current.index?.root).toBe('other'); expect(live.result.current.restoredAt).toBeNull();
  } finally { client.clear(); other.clear(); }
});

test('ordinary persistence writes do not bypass coalesced read notifications', async () => {
  const client = new QueryClient();
  try {
    const index = indexOf(tree({ root: 'coalesced-root', tasks: [dto()] }));
    receiveFullIndex(client, index); useReadPersistence.setState({ restoredAt: null });
    let renders = 0;
    const h = renderHook(() => { renders++; return useDisplayReadFacts(); }, { wrapper: ({ children }: any) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });
    const before = renders;
    act(() => { for (let n = 1; n <= 5; n++) { receiveFullIndex(client, { ...index, rev: index.rev + n }); useReadPersistence.setState({ restoredAt: null }); } });
    expect(renders).toBe(before);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
    expect(h.result.current.index?.rev).toBe(index.rev + 5);
    expect(renders).toBe(before + 1);
  } finally { client.clear(); }
});
