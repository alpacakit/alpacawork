import { issueText } from '@/features/forms/problem-text';
import { canSendWrites, useConnection, workspaceWriteBasis } from '@/data/connection';
import { openInput } from '@/state/open-input';
import { useDialogStore } from '@/state/dialog-store';
import { useEffect, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { checkDirectIntent, resumeDirectIntents } from '@/data/direct-write';
import { useWorkspaceInfo } from '@/data/queries';
import { notify, recordFailure } from '@/lib/notify';
import { Trans } from 'react-i18next';
import { i18n } from '@alpacawork/i18n';
import { personalSettings } from '@alpacawork/contract';
import { ApiError, errorText, retryOf } from '@/data/client';
import { useViewStore } from '@/state/view-store';
import type { Departure } from './next-question';
import { writeCheckFailure, intentKeyParts, useCheckedHere, useWriteIntentStore, reloadedWrites, writeIntentFailure, type WriteIntent } from '@/data/write-intent';
import type { Task } from '@/data/types';

type Notice = { id: string; visible: boolean; confirmation?: ReactNode };
const latestOperation = new Map<string, Notice>();
const noticeId = (operationId: string) => `reader-operation:${operationId}`;
/** What the notice says was done: a card's answer, or Restore (a hold taken back). */
export type RecoveryAnswer = Departure['answer'] | 'restore';
/** The task's notice now speaks for `operationId`; owned again (an intent's card leaving at its receipt), it keeps what it says. */
export function ownRecovery(taskId: string, operationId: string) {
  const notice = latestOperation.get(taskId);
  if (notice?.id === operationId) return;
  if (notice) notify.dismiss(noticeId(notice.id));
  latestOperation.set(taskId, { id: operationId, visible: false });
}
/** The notice stops asking for attention; what it was to say next, if anything, is said once. */
function takeConfirmation(notice: Notice) {
  notice.visible = false;
  const confirmation = notice.confirmation;
  notice.confirmation = undefined;
  return confirmation;
}
export function clearRecovery(taskId: string, operationId: string) {
  const notice = latestOperation.get(taskId);
  if (notice?.id !== operationId) return;
  if (!notice.visible) { notify.end(noticeId(operationId)); return; }
  const confirmation = takeConfirmation(notice);
  if (confirmation) notify.success(confirmation, { id: noticeId(operationId) });
  else notify.dismiss(noticeId(operationId));
  return !!confirmation;
}
/** Delivery is known, but its outcome is not: keep the same event hidden until the coordinator's result. */
export function acknowledgeRecovery(taskId: string, operationId: string) {
  const notice = latestOperation.get(taskId);
  if (notice?.id !== operationId || !notice.visible) return;
  const confirmation = takeConfirmation(notice);
  if (confirmation) notify.success(confirmation, { id: noticeId(operationId), ongoing: true });
  else notify.suspend(noticeId(operationId));
  return !!confirmation;
}
/** A cancelled/closed scope is terminal without claiming successful delivery. */
export function dismissRecovery(taskId: string, operationId: string) {
  if (latestOperation.get(taskId)?.id !== operationId) return;
  notify.dismiss(noticeId(operationId)); latestOperation.delete(taskId);
}
function recoveryMessage(task: Pick<Task, 'id' | 'title'>, answer: RecoveryAnswer, kind: 'refused' | 'unknown' | 'confirmed') {
  const messages = {
    hold: [i18n.t('reader:recovery.refusedHold'), i18n.t('reader:recovery.unknownHold'), i18n.t('reader:recovery.confirmedHold')],
    restore: [i18n.t('reader:recovery.refusedRestore'), i18n.t('reader:recovery.unknownRestore'), i18n.t('reader:recovery.confirmedRestore')],
    send: [i18n.t('reader:recovery.refusedSend'), i18n.t('reader:recovery.unknownSend'), i18n.t('reader:recovery.confirmedSend')],
    done: [i18n.t('reader:recovery.refusedDone'), i18n.t('reader:recovery.unknownDone'), i18n.t('reader:recovery.confirmedDone')],
    stop: [i18n.t('reader:recovery.refusedStop'), i18n.t('reader:recovery.unknownStop'), i18n.t('reader:recovery.confirmedStop')],
  };
  return <Trans i18n={i18n} defaults={messages[answer][{ refused: 0, unknown: 1, confirmed: 2 }[kind]]} values={{ title: recoveryTitle(task) }}
    components={{ subject: <span />, title: <RecoveryTitle /> }} />;
}

/** A Task is named by its ID and the start of its title on one line, so what happened to it stays in sight. */
const recoveryTitle = (task: Pick<Task, 'id' | 'title'>) => `${task.id} ${task.title}`;
const RecoveryTitle = ({ children }: { children?: ReactNode }) =>
  <span data-recovery-title className="inline-block max-w-[16em] truncate align-bottom">{children}</span>;

/** Every explicit result check, from a toast or the terminal card, answers through the same notice. */
function checkRecovery(task: Pick<Task, 'id' | 'title'>, answer: RecoveryAnswer, operationId: string, check: () => void) {
  const notice = latestOperation.get(task.id);
  if (notice?.id === operationId && notice.visible) notice.confirmation = recoveryMessage(task, answer, 'confirmed');
  check();
}

/** A reason, ended as a sentence, then the next step: serve's reasons often have no closing stop of their own. */
export const withNextStep = (reason: string, next: string) => i18n.t('problem.withNext', {
  reason: /[.!?\u3002\uff01\uff1f]$/.test(reason) ? reason : `${reason}${i18n.t('problem.sentenceEnd')}`, next });

export function readerFailure(task: Pick<Task, 'id' | 'title'>, answer: RecoveryAnswer, error: unknown, check: () => void, operationId: string, reopen?: () => boolean, displayReason?: string) {
  recordFailure(error, `reader ${answer}`);
  const retry = retryOf(error), reason = displayReason ?? errorText(error), next = i18n.t(`problem.retry.${retry}`);
  // The notice's own button opens the latest state (reread) or checks the result (check): it is not said again in words.
  const own = error instanceof ApiError && error.code === 'restore_changed' || retry === 'reread' || retry === 'check';
  const detail = reason === next || own ? reason || next : withNextStep(reason, next);
  return showReaderFailure(task, answer, retryOf(error) === 'check' ? 'unknown' : 'refused', check, operationId, detail, undefined, reopen);
}

export function readerSubmissionEnded(task: Pick<Task, 'id' | 'title'>, answer: RecoveryAnswer, end: 'cancelled' | 'closed', operationId: string, reopen?: () => boolean) {
  const message = <Trans i18n={i18n} i18nKey={`reader:recovery.${end}`} values={{ title: recoveryTitle(task) }} components={{ title: <RecoveryTitle /> }} />;
  return showReaderFailure(task, answer, 'refused', () => {}, operationId, '', message, reopen);
}

/** Its result cannot be checked from this tab: said as unknown, with nothing to press that would refuse. */
export function readerUnproven(task: Pick<Task, 'id' | 'title'>, answer: RecoveryAnswer, operationId: string, failure: ApiError) {
  const notice = latestOperation.get(task.id);
  if (notice?.id !== operationId) return false;
  notice.visible = true;
  notice.confirmation = undefined;
  notify.error(recoveryMessage(task, answer, 'unknown'), { id: noticeId(operationId), ongoing: true, detail: failure.displayMessage });
  return true;
}

function showReaderFailure(task: Pick<Task, 'id' | 'title'>, answer: RecoveryAnswer, kind: 'unknown' | 'refused', check: () => void, operationId: string, detail: string, message?: ReactNode, reopen?: () => boolean) {
  const notice = latestOperation.get(task.id);
  if (notice?.id !== operationId) return false;
  notice.visible = true;
  notice.confirmation = undefined;
  const unknown = kind === 'unknown';
  notify.error(message ?? recoveryMessage(task, answer, kind), {
    id: noticeId(operationId), ongoing: unknown, detail,
    // A definite refusal is the terminal result; only an unknown result can be republished while it is pending.
    action: {
      label: i18n.t(unknown ? 'reader:recovery.check' : 'reader:recovery.latest'),
      run: () => {
        if (unknown) check();
        else {
          const restored = reopen?.() ?? true;
          useViewStore.getState().openTask(task.id, { reader: true });
          if (!restored) {
            // Keep the same recovery entrance and original payload until the person makes room in the input.
            showReaderFailure(task, answer, kind, check, operationId, i18n.t('ui:coordinatorCard.takeBackHint'), message, reopen);
            return;
          }
          clearRecovery(task.id, operationId);
          // Opening consumes this entrance; a new admission registers its own recovery.
          if (latestOperation.get(task.id)?.id === operationId) latestOperation.delete(task.id);
        }
      },
    },
  });
  return true;
}

/** Fixed direct requests outlive their originating row/dialog. The existing notice is their check entrance. */
/**
 * What a write whose result is unknown is called where a person reads it: a Task by its ID; a personal setting by the
 * name its row shows (its registered label, in the language now); a write about no Task (the server's settings) as
 * the settings. One rule for every setting: the stored label is the setting's key, never shown as it is.
 */
export function recoverySubject(recovery: NonNullable<WriteIntent['recovery']>) {
  if (recovery.response === 'personal') {
    const definition = personalSettings.find((item) => item.key === recovery.label);
    if (definition) return i18n.t(definition.labelKey, { ns: 'panels' });
  }
  return recovery.label || i18n.t('chrome:appBar.settings');
}

export function useDirectWriteRecovery() {
  const client = useQueryClient();
  const root = useWorkspaceInfo(info => info.root);
  useEffect(() => {
    let active = true;
    // The check callback publishes its terminal result before notify releases its event.
    const checking = new Set<string>();
    type State = ReturnType<typeof useWriteIntentStore.getState>;
    /** The one place an unknown result is said. The notice it replaces while checking is this press's to end, whatever comes back. */
    const publishUnknown = (key: string, entry: WriteIntent, recovery: NonNullable<WriteIntent['recovery']>) => {
      const id = `write-intent:${entry.operationId}`;
      const subject = recoverySubject(recovery);
      const failure = writeCheckFailure(root, entry.operationId);
      // Only the write owner settles the operation; hiding its notification does not unlock submission.
      notify.error(i18n.t('forms:writeFailure.checkWhich', { subject }), {
        id, ongoing: true,
        detail: failure?.displayMessage ?? i18n.t('forms:writeFailure.operationUnconfirmed'),
        action: !failure ? { label: i18n.t('reader:recovery.check'), run: () => {
          checking.add(id);
          notify.pending(i18n.t('forms:draft.checking'), { id, ongoing: true });
          void checkDirectIntent(client, key).then(() => {
            if (!active) return;
            notify.success(i18n.t('forms:writeResult.confirmed', { subject }), { id });
          }, error => {
            if (!active) return;
            const now = useWriteIntentStore.getState().entries[key];
            // Still unknown, by a new attempt or because the check could not begin: the same question stands.
            if (now?.status === 'unconfirmed') { publishUnknown(key, now, recovery); return; }
            // A definite refusal permits a new operation, and is said by the observer when it reports every outcome.
            if (recovery.outcomes !== 'all') notify.failure(error, { id, about: `check ${recovery.label}` });
          }).finally(() => { checking.delete(id); });
        } } : undefined,
      });
    };
    const observe = (state: State, before?: State) => {
      if (!before || state.unavailable !== before.unavailable) {
        if (state.unavailable) notify.error(i18n.t('forms:draft.storageUnavailable'), { id: 'write-intent-storage', ongoing: true });
        else notify.dismiss('write-intent-storage');
      }
      // Notifications consume store transitions, not React renders of the page frame.
      for (const [key, entry] of Object.entries(before?.entries ?? {})) {
        if (intentKeyParts(key).root === root && state.entries[key]?.operationId !== entry.operationId) {
          notify.dismiss(`write-intent:${entry.operationId}`);
          if (entry.reader) dismissRecovery(entry.reader.taskId, entry.operationId);
        }
      }
      for (const [key, entry] of Object.entries(state.entries)) {
        // Storage availability changes the check offered by an unknown record, not any settled result.
        if (entry === before?.entries[key] && (entry.status !== 'unconfirmed' || state.unavailable === before?.unavailable)) continue;
        if (intentKeyParts(key).root !== root) continue;
        if (entry.status === 'unconfirmed' && reloadedWrites.has(key)) { notify.suspend(`write-intent:${entry.operationId}`); if (entry.reader) notify.suspend(noticeId(entry.operationId)); continue; }
        if (entry.status === 'cancelled') {
          notify.dismiss(`write-intent:${entry.operationId}`);
          if (entry.reader) dismissRecovery(entry.reader.taskId, entry.operationId);
          continue;
        }
        if (entry.reader) {
          const reader = entry.reader, operationId = entry.operationId;
          const task = { id: reader.taskId, title: reader.title };
          ownRecovery(task.id, operationId);
          if (entry.status === 'unconfirmed' && useCheckedHere.getState()[key]) { notify.suspend(noticeId(operationId)); continue; }
          const failure = writeCheckFailure(root, operationId);
          if (entry.status === 'confirmed') clearRecovery(task.id, operationId);
          else if (entry.status === 'unconfirmed' && failure) readerUnproven(task, reader.recovery, operationId, failure);
          else if (entry.status !== 'pending' && entry.status !== 'waiting') {
            const error = writeIntentFailure(entry)
              ?? new ApiError(i18n.t('forms:writeFailure.operationUnconfirmed'), 'network_error', 'check');
            readerFailure(task, reader.recovery, error, () => {
              checkRecovery(task, reader.recovery, operationId, () => { void checkDirectIntent(client, key).catch(() => {}); });
            }, operationId, () => {
              // Keep the fixed draft if another editor is in use; opening must not overwrite newer words.
              const dialog = useDialogStore.getState().dialog;
              if (dialog?.kind === 'input') return false;
              useViewStore.getState().openTask(task.id, { reader: true });
              openInput({ form: 'report', taskId: task.id, answerCard: null });
              return true;
            });
          }
          continue;
        }
        const id = `write-intent:${entry.operationId}`;
        const recovery = entry.recovery;
        if (recovery?.outcomes === 'all' && (entry.status === 'refused' || entry.status === 'conflict')) {
          if (useCheckedHere.getState()[key]) { notify.suspend(id); continue; }
          const failure = entry.failure;
          if (!failure || failure.retry === 'check') { notify.dismiss(id); continue; }
          if (before?.entries[key] === entry || !before) continue;
          notify.failure(writeIntentFailure(entry)!, {
            id, about: `saved ${recovery.label}`,
            ...(failure.issues?.length ? { detail: [recoverySubject(recovery), ...failure.issues.map(issueText)].join(' ') } : {}),
            action: { label: i18n.t('reader:recovery.latest'), run: () => {
              if (useDialogStore.getState().dialog) return;
              const { operation, about: task } = intentKeyParts(key);
              if (operation === 'project/new') useDialogStore.getState().openProject();
              else if (operation === 'task/archive' && task) useDialogStore.getState().openProject(task);
              else if (task && (operation === 'move' || operation === 'responsible')) openInput({ form: operation, taskId: task });
            } },
          });
          continue;
        }
        if (entry.status !== 'unconfirmed') {
          if (entry.status !== 'pending' && entry.status !== 'waiting' && !checking.has(id)) notify.dismiss(id);
          continue;
        }
        // A dialog showing this same check (its own Check) says it there; the toast comes when it closes.
        if (recovery && useCheckedHere.getState()[key]) { notify.suspend(id); continue; }
        if (recovery) publishUnknown(key, entry, recovery);
      }
    };
    const unsubscribe = useWriteIntentStore.subscribe(observe);
    const unsubscribeHere = useCheckedHere.subscribe(() => observe(useWriteIntentStore.getState()));
    const resume = () => {
      if (!canSendWrites({ ...workspaceWriteBasis(), root })) return;
      // Consuming deferred checks also ends their notification hold. A check refused before it
      // starts (missing identity or unavailable storage) leaves no write transition to observe.
      if (resumeDirectIntents(client, root)) observe(useWriteIntentStore.getState());
    };
    const unsubscribeConnection = useConnection.subscribe(resume);
    resume();
    observe(useWriteIntentStore.getState());
    return () => {
      active = false;
      unsubscribe(); unsubscribeHere(); unsubscribeConnection();
      for (const [key, entry] of Object.entries(useWriteIntentStore.getState().entries)) {
        if (intentKeyParts(key).root === root) notify.dismiss(`write-intent:${entry.operationId}`);
      }
      notify.dismiss('write-intent-storage');
    };
  }, [root, client]);
}
