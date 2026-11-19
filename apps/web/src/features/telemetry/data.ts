/** Screen adapters share one status query; the server owns eligibility and consent. */
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { create } from 'zustand';
import { z } from 'zod';
import { telemetryPreviewSchema, telemetryStatusSchema, type TelemetryOp, type TelemetryScreenAttributes, type TelemetryStatus } from '@alpacawork/contract/telemetry';
import { api, useWorkspaceInfo } from '@/data/queries';
import { workspaceWriteBasis } from '@/data/connection';
import { queryClient } from '@/data/query-client';
import { recordFailure } from '@/lib/notify';
import { saveTelemetryChoice } from './choice';
import { useDialogStore } from '@/state/dialog-store';
import { countUse, dialogUse, sendUsesWith, type UseFact } from './count';
import { screenAttributes } from './attributes';

const telemetryStatusKey = (root: string) => ['telemetry', root] as const;

// User consent has its own lifetime, independent of workspace write mutations.
const useChoicePending = create(() => ({ pending: false }));
export function useTelemetry() {
  const root = useWorkspaceInfo(info => info.root);
  const key = telemetryStatusKey(root);
  const status = useQuery({ queryKey: key, queryFn: ({ signal }) => api.request('telemetry/status', telemetryStatusSchema, signal),
    refetchOnWindowFocus: true, refetchInterval: 60_000 });
  const known = status.data !== undefined;
  useEffect(() => { if (known) settleWaitingUses(); }, [known]);
  const busy = useChoicePending(state => state.pending);
  const choose = async (value: 'on' | 'off', onFailure: (error: unknown) => void): Promise<boolean> => {
    if (useChoicePending.getState().pending) return false;
    useChoicePending.setState({ pending: true });
    try {
      const saved = await saveTelemetryChoice(root, value, status.data?.digest ?? null);
      queryClient.setQueryData(key, saved);
      return true;
    } catch (error) {
      onFailure(error);
      void status.refetch();
      return false;
    } finally { useChoicePending.setState({ pending: false }); }
  };
  return { status, choose, busy };
}
export function useTelemetryPreview() {
  const root = useWorkspaceInfo(info => info.root);
  return useQuery({ queryKey: ['telemetry-preview', root], queryFn: ({ signal }) => api.request('telemetry/preview', telemetryPreviewSchema, signal),
    staleTime: 0, gcTime: 0 });
}

/**
 * The one sender of counted uses: only while this workspace's status says sending is on. Before the status is first
 * read (the page's opening time is measured then), facts wait in this tab and go only if it says on. Each use carries
 * the screen's attributes as they are when it happens; an agent checking the screen (`?agent=1`) counts as `agent`.
 */
type Sent = { op: TelemetryOp; attributes: TelemetryScreenAttributes } | Extract<UseFact, { time: unknown }>;
let waiting: Sent[] | null = [];
export function sendUse(fact: UseFact): void { send('op' in fact ? { op: fact.op, attributes: screenAttributes() } : fact); }
function send(fact: Sent): void {
  const basis = workspaceWriteBasis();
  const state = queryClient.getQueryData<TelemetryStatus>(telemetryStatusKey(basis.root))?.state;
  if (state === undefined && waiting) { if (waiting.length < 50) waiting.push(fact); return; }
  if (state !== 'on') return;
  void api.request('telemetry/use', z.object({ ok: z.literal(true) }), undefined, fact, undefined, basis)
    .catch(error => recordFailure(error, 'record usage'));
}
/** The first status read settles what waited: sent if on, dropped otherwise. */
export function settleWaitingUses(): void {
  const held = waiting;
  waiting = null;
  for (const fact of held ?? []) send(fact);
}
sendUsesWith(sendUse);
// Every dialog and input opens through the one open dialog: counted where it changes, once for this page.
useDialogStore.subscribe((state, previous) => { countUse(dialogUse(state.dialog, previous.dialog)); });

