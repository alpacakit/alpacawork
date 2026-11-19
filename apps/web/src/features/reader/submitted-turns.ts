import { useShallow } from 'zustand/react/shallow';
import { hasReaderSubmission, readerTurnEntries } from '@/features/coordinator/editor/outbox';
import { useDraftStore, type DraftEntry } from '@/features/forms/draft-store';
import { intentKeyParts, useWriteIntentStore, type WriteIntent } from '@/data/write-intent';
import { useWorkspaceInfo } from '@/data/queries';
import type { Task } from '@/data/types';
import { readerOutcome, readerTurn, sameTurn } from './submission';

/** Whether the automatic deck has submitted this turn, from each transport's fixed records. This does not block follow-up. */
export function submittedReaderTurn(drafts: Record<string, DraftEntry>, writes: Record<string, WriteIntent>, root: string,
  current: ReturnType<typeof readerTurn>) {
  return hasReaderSubmission(drafts, root, current) || directSubmittedTurn(writes, root, current);
}
export function directSubmittedTurn(writes: Record<string, WriteIntent>, root: string, current: ReturnType<typeof readerTurn>) {
  return Object.entries(writes).some(([key, entry]) => {
    const binding = entry.reader;
    return intentKeyParts(key).root === root && binding && readerOutcome(entry.status === 'waiting' ? 'pending' : entry.status) === 'kept'
      && sameTurn(binding, current);
  });
}
/** Stable subscription identity: unrelated direct settings writes do not repaint the reader. */
const directSubmissionVersion = (writes: Record<string, WriteIntent>, root: string) => JSON.stringify(
  Object.entries(writes).filter(([key, entry]) => intentKeyParts(key).root === root && entry.reader)
    .map(([key, entry]) => [key, entry.operationId, entry.status, entry.reader]));

/** The one subscription to what submittedReaderTurn reads: both transports' records, redrawn only when they change. */
export function useSubmittedTurns() {
  const root = useWorkspaceInfo(info => info.root), entries = useDraftStore(useShallow(state => readerTurnEntries(state.entries, root)));
  useWriteIntentStore(state => directSubmissionVersion(state.entries, root));
  const writes = useWriteIntentStore.getState().entries;
  return { root, entries, submitted: (task: Task) => submittedReaderTurn(entries, writes, root, readerTurn(task)) };
}
