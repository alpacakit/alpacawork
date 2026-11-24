import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { QueryObserver } from '@tanstack/react-query';
import { startI18n } from '@alpacawork/i18n';
import { DEFAULT_LIMITS } from '@alpacawork/contract';
import { headOf, TestWorkspace, dto, run } from './fixtures';
import { useSaveServerSettings, useStopRun } from '../src/data/queries';
import { useLifecycle } from '../src/features/forms/lifecycle';
import { queryClient } from '../src/data/query-client';
import { resources } from '../src/data/resources';
import { useWriteIntentStore } from '../src/data/write-intent';

beforeAll(() => startI18n());
beforeEach(() => { queryClient.clear(); sessionStorage.clear(); useWriteIntentStore.setState({ entries: {}, unavailable: false }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const wrapper = ({ children }: { children: React.ReactNode }) => <TestWorkspace>{children}</TestWorkspace>;

for (const operation of ['config', 'lifecycle', 'stop'] as const)
  test(`${operation}: real hook passes the intent ID in transport and preserves the command input shape`, async () => {
    const fixed = `fixed-${operation}`;
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('/api/commands/config/set')) return new Response(JSON.stringify({ hash: 'c'.repeat(64),
        agentsText: 'agents: {}\n', agents: {}, catalog: [], limits: { ...DEFAULT_LIMITS } }));
      if (String(url).includes('/api/commands/run/stop')) return new Response(JSON.stringify({ cancelled: [], stop_requested: [], already_finished: [] }));
      return new Response(JSON.stringify({ task: headOf(dto({ id: 'T1', version: 2 })), outcome: { kind: 'recorded', opId: fixed } }));
    });
    const hook = renderHook(() => ({ config: useSaveServerSettings(), lifecycle: useLifecycle(), stop: useStopRun() }), { wrapper });
    await act(async () => {
      switch (operation) {
        case 'config': await hook.result.current.config.mutateAsync({ yaml: 'limits: {}', agents: 'agents: {}', expected: 'a'.repeat(64), opId: fixed }); break;
        case 'lifecycle': await hook.result.current.lifecycle.mutateAsync({ action: 'archive', id: 'T1', expectedTaskHash: 'a'.repeat(64) }); break;
        case 'stop': await hook.result.current.stop.mutateAsync(run('R1')); break;
      }
    });
    const writes = fetcher.mock.calls.filter(([, options]) => options?.method === 'POST' && !String(options?.body).includes('"checkpoint"'));
    const request = writes.find(([url]) => !String(url).includes('/person/'))!;
    expect(request).toBeDefined();
    const header = new Headers(request[1]?.headers).get('X-Alpacawork-Op-Id');
    if (operation === 'lifecycle' || operation === 'stop') {
      expect(header).toBe(Object.values(useWriteIntentStore.getState().entries)[0]?.operationId);
      expect(header).toBeTruthy();
    } else expect(header).toBe(fixed);
    expect(JSON.parse(String(request[1]?.body))).not.toHaveProperty('opId');
  });

test('a saved config reads the plan limits again, so an agent turned off leaves the bar at once', async () => {
  let saved = false;
  const agent = (adapter: 'claude' | 'codex') => ({ adapter, state: 'ok', windows: [], account: null, observedAt: '2026-11-24T00:00:00.000Z' });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    if (String(url).includes('/api/limits')) return new Response(JSON.stringify({ agents: saved ? [agent('claude')] : [agent('claude'), agent('codex')] }));
    saved = true;
    return new Response(JSON.stringify({ hash: 'c'.repeat(64), agentsText: 'agents: {}\n', agents: {}, catalog: [], limits: { ...DEFAULT_LIMITS } }));
  });
  // The bar shows the limits of the agents enabled before the save.
  const bar = new QueryObserver(queryClient, resources.agentLimits('/fixture'));
  const shown = () => bar.getCurrentResult().data?.agents.map(entry => entry.adapter);
  const stop = bar.subscribe(() => {});
  try {
    await vi.waitFor(() => expect(shown()).toEqual(['claude', 'codex']));
    const hook = renderHook(() => useSaveServerSettings(), { wrapper });
    await act(async () => { await hook.result.current.mutateAsync({ yaml: 'limits: {}', agents: 'agents: {}', expected: 'a'.repeat(64), opId: 'save' }); });
    await vi.waitFor(() => expect(shown()).toEqual(['claude']));
  } finally { stop(); }
});
