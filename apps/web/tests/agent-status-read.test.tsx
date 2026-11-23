import { expect, test, vi } from 'vitest';
import { QueryObserver } from '@tanstack/react-query';
import { RECOVERY_PROTOCOL } from '@alpacawork/contract/recovery';
import { AGENT_CHECK_MS } from '@alpacawork/contract';
import { queryClient } from '../src/data/query-client';
import { resources } from '../src/data/resources';

// The agents' status read waits past the server's own bound on those checks, and a read that still fails is not sent
// again: each send runs every check once more, and a hung CLI would be started again each time.
test('the agent inspection outwaits the server bound and sends its restore ID without retrying', async () => {
  const waits: number[] = [];
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => { waits.push(ms); return new AbortController().signal; });
  const fetch = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url === '/api/runtime/recovery') return Response.json({ restoreId: 'initial', protocol: RECOVERY_PROTOCOL });
    throw new TypeError('lost response');
  });
  vi.stubGlobal('fetch', fetch);
  queryClient.setDefaultOptions({ queries: { ...queryClient.getDefaultOptions().queries, retryDelay: 0 } });
  const observer = new QueryObserver(queryClient, resources.agentStatus('/fixture'));
  const settled = new Promise(resolve => observer.subscribe(result => { if (result.status === 'error') resolve(result.error); }));
  expect(await settled).toBeTruthy();
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[1]?.[0]).toBe('/api/commands/config/inspect');
  expect(fetch.mock.calls[1]?.[1]?.method).toBe('POST');
  const headers = new Headers(fetch.mock.calls[1]?.[1]?.headers);
  expect(headers.get('X-Alpacawork-Restore-Id')).toBe('initial');
  expect(headers.has('X-Alpacawork-Op-Id')).toBe(false);
  expect(waits[1]).toBeGreaterThan(AGENT_CHECK_MS);
  queryClient.clear();
});
