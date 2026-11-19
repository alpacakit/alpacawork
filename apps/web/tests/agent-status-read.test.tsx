import { expect, test, vi } from 'vitest';
import { QueryObserver } from '@tanstack/react-query';
import { AGENT_CHECK_MS } from '@alpacawork/contract';
import { queryClient } from '../src/data/query-client';
import { resources } from '../src/data/resources';

// The agents' status read waits past the server's own bound on those checks, and a read that still fails is not sent
// again: each send runs every check once more, and a hung CLI would be started again each time.
test('the agent status read outwaits the server bound and is not repeated when it fails', async () => {
  const waits: number[] = [];
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => { waits.push(ms); return AbortSignal.abort(new DOMException('timed out', 'TimeoutError')); });
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => { throw init?.signal?.reason; });
  vi.stubGlobal('fetch', fetch);
  queryClient.setDefaultOptions({ queries: { ...queryClient.getDefaultOptions().queries, retryDelay: 0 } });
  const observer = new QueryObserver(queryClient, resources.agentStatus('/fixture'));
  const settled = new Promise(resolve => observer.subscribe(result => { if (result.status === 'error') resolve(result.error); }));
  expect(await settled).toBeTruthy();
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(fetch).toHaveBeenCalledOnce();
  expect(waits).toHaveLength(1);
  expect(waits[0]).toBeGreaterThan(AGENT_CHECK_MS);
  queryClient.clear();
});
