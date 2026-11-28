import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { i18n } from '@alpacawork/i18n';
import { captureReadBoundary, sameReadSession, subscribeReads, taskReadState } from '@/data/read-model';
import { readerTaskRow } from '@/data/resources';
import { rowTask } from '@/data/map';
import { detailWriteBasis, canSendWrites } from '@/data/connection';
import { useQueryClient } from '@tanstack/react-query';
import type { taskWriteResultSchema } from '@alpacawork/contract/control';
import { useWorkspaceInfo, useWorkspaceWritable, useWriteDisabled, readerPeopleFor } from '@/data/queries';
import type { Task } from '@/data/types';
import { ApiError } from '@/data/client';
import { sendDirectIntent, checkDirectIntent } from '@/data/direct-write';
import { writeCheckFailure, busyOnTask, intentStatus, intentKey, useWriteIntentStore } from '@/data/write-intent';
import { reportRequest, taskReportTarget, sameTaskReportTarget, type TaskReportTarget } from '@/data/task-report';
import type { StateChoice } from '@/domain/tasks';
import type { PeopleIndex } from '@/domain/people';
import { acceptedInReader, onScreen, useReaderTurnHeld, type ReaderCard, type ReaderAdmission } from './next-question';
import { readerTurn } from './submission';
import { departureRelease, readerActionsHeld } from './departure';
import { notify } from '@/lib/notify';
import { rememberSent } from '@/features/coordinator/sent-here';

type TaskWriteResult = ReturnType<typeof taskWriteResultSchema.parse>;
type ReportSubmission = { admission: 'rejected'; reason: ApiError }
  | { admission: Exclude<ReaderAdmission, 'rejected'>; operationId: string; result: Promise<TaskWriteResult> };

/** A report opening fixes its meaning, detail authority and read session together. */
export function captureReportOpening(client: ReturnType<typeof useQueryClient>, target: TaskReportTarget) {
  return { target, basis: detailWriteBasis(target.facts.task, target.facts.hash), boundary: captureReadBoundary(client) };
}
type ReportOpening = ReturnType<typeof captureReportOpening>;

/** Opening prepares a local report. Only sending needs a reachable server and qualified detail. */
export function useReportOpeningDisabled(taskId: string) {
  const client = useQueryClient(), root = useWorkspaceInfo(info => info.root);
  const writable = useWorkspaceWritable();
  const present = useSyncExternalStore(useCallback(changed => subscribeReads(client, changed), [client]),
    () => !!readerTaskRow(client, root, taskId));
  return !writable || !present;
}

/** The version of the Task whose contents are drawn now (null before its first read): what a press on them was made on. */
export function useShownTaskVersion(taskId: string) {
  const client = useQueryClient(), root = useWorkspaceInfo(info => info.root);
  return useSyncExternalStore(useCallback(changed => subscribeReads(client, changed), [client]),
    () => taskReadState(client, root, taskId).view?.task.hash ?? null);
}

/** State reports share fixed transport, display identity and recovery, wherever their control is drawn. */
export function useTaskReport(task: Task, people: PeopleIndex, card: ReaderCard | null) {
  const client = useQueryClient(), target = taskReportTarget(task, people);
  const meaning = JSON.stringify(target.facts);
  const opening = useMemo(() => captureReportOpening(client, target), [client, meaning]);
  return useTaskReportTarget(opening, card);
}

/** Forms retain their opening's target; all controls use this same admission, transport and recovery. */
export function useTaskReportTarget(opening: ReportOpening, card: ReaderCard | null) {
  const { target, basis, boundary } = opening, { task } = target;
  const client = useQueryClient(), root = useWorkspaceInfo(info => info.root);
  const key = intentKey(root, 'task/report', task.id);
  const entry = useWriteIntentStore(state => state.entries[key]), unavailable = useWriteIntentStore(state => state.unavailable);
  const busy = useWriteIntentStore(state => busyOnTask(state.entries, key));
  const status = intentStatus(entry);
  const disabled = useWriteDisabled(task.id), submitted = useReaderTurnHeld(task);
  const selectable = !disabled && !unavailable && !submitted && !busy && status !== 'pending' && status !== 'unconfirmed';
  const ready = selectable && sameReadSession(client, boundary) && canSendWrites(basis);
  // Done's own attempt: an approval sent for this very version, apart from other reports on the task and earlier versions.
  const completion = entry?.draft?.choice === 'approve' && (entry.payload as { expectedTaskHash?: unknown }).expectedTaskHash === target.facts.hash
    ? intentStatus(entry) : null;
  const submit = (choice: StateChoice, words: { title?: string; description?: string } = {}): ReportSubmission => {
    const reject = (reason: ApiError): ReportSubmission => { notify.failure(reason, { about: 'task report' }); return { admission: 'rejected', reason }; };
    if (!selectable || card && onScreen(card, task.id) && readerActionsHeld())
      return reject(new ApiError('Check the saved operation or browser storage before sending', 'unavailable', 'check'));
    const answer = choice === 'approve' ? 'done' : choice === 'hold' ? 'hold' : choice === 'stop' ? 'stop' : null;
    let admission: Exclude<ReaderAdmission, 'rejected'> = 'retained';
    let operationId: string | undefined;
    // Build synchronously before admission; bad local inputs cannot leave a pending record or retire a card.
    let input: ReturnType<typeof reportRequest>;
    try {
      const row = readerTaskRow(client, basis.root, task.id);
      if (!sameReadSession(client, boundary) || !canSendWrites(basis) || !row
        || !sameTaskReportTarget(target, taskReportTarget(rowTask(row), readerPeopleFor(client, basis.root, task.id))))
        throw new ApiError(() => i18n.t('forms:reportForm.chooseAgain'), 'conflict', 'reread');
      input = reportRequest(target, choice, words);
    } catch (error) {
      return reject(error instanceof ApiError ? error : new ApiError(String(error), 'invalid_input', 'fix'));
    }
    let result: Promise<TaskWriteResult>;
    try { result = sendDirectIntent(client, key, { path: 'task/report', response: 'task', label: task.title },
      () => input, basis, {
        reader: { ...readerTurn(task), title: task.title, answer, recovery: choice === 'unhold' ? 'restore' : answer! },
        // The person's own words only: a form restored from it knows which fields they wrote.
        draft: { choice, ...words.title !== undefined && { title: words.title }, ...words.description !== undefined && { description: words.description } },
        admitted: record => {
          operationId = record.operationId;
          // The row's icon turns the same arc as for a sent instruction until the new state shows (sent-mark.ts).
          rememberSent(record.operationId, [task.id], key);
          if (!answer) return;
          const current = () => {
            const held = useWriteIntentStore.getState().entries[key];
            return held?.operationId === record.operationId ? held.status === 'waiting' ? 'pending' : held.status === 'cancelled' ? 'refused' : held.status : 'refused' as const;
          };
          if (acceptedInReader(card, task.id, task.ball, { id: record.operationId, turn: record.reader!.turn,
            answer, release: departureRelease(), admitted: () => current() === 'confirmed', status: current })) admission = 'retired';
        },
      }); } catch (error) {
      return reject(error instanceof ApiError ? error : new ApiError(String(error), 'invalid_input', 'fix'));
    }
    // The global recovery observer owns notices, including after this control unmounts. Consumers may also await result.
    void result.catch(() => {});
    if (!operationId) return { admission: 'rejected', reason: new ApiError('The operation could not be saved', 'unavailable', 'check') };
    return { admission, operationId, result };
  };
  const unproven = status === 'unconfirmed' && !!entry && !!writeCheckFailure(root, entry.operationId);
  // Done whose result is unknown is not on its way: pressed again, it asks with the same operation (the notice's Check),
  // so the press needs no notice that may have been closed. Any other unknown write on the task still holds Done.
  const recheck = completion === 'unconfirmed' && !unproven && !disabled && !unavailable && !busy;
  const completeReady = (selectable || recheck) && sameReadSession(client, boundary) && canSendWrites(basis);
  const complete = (): ReportSubmission => {
    if (!recheck) return submit('approve');
    const result = checkDirectIntent(client, key) as Promise<TaskWriteResult>;
    void result.catch(() => {});
    return { admission: 'retained', operationId: entry!.operationId, result };
  };
  return { ready, completeReady, selectable, status, unproven, completion, key, complete, submit, check: () => checkDirectIntent(client, key) };
}
