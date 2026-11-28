import { useTranslation } from 'react-i18next';
import { userTurn } from '@alpacawork/contract';
import { isRunMoving } from '@alpacawork/contract/run';
import { Icon } from '@/components/ui/icon';
import { useReaderPeople, useWriteDisabled } from '@/data/queries';
import type { Task } from '@/data/types';
import { answeringTurn, intentAbout, useIntentReady } from '@/features/coordinator/reader-send';
import { markTool, useRowTool, useTaskActionSlot, type ActionLook } from '@/features/coordinator/task-action-slot';
import { useInputDraft, focusCoordinator } from '@/features/coordinator/editor/draft';
import { hasReaderOperation } from '@/features/coordinator/editor/document';
import { crewOf } from '@/domain/people';
import { stateChoices } from '@/domain/tasks';
import { cn } from '@/lib/utils';
import { readerActionsHeld } from './departure';
import { useReaderCard } from './next-question';
import { useShownTaskVersion, useTaskReport } from './use-task-report';
import { useSteadyControl } from '@/lib/steady-control';

/** Whether the server offers this Task's completion: where Done stands, a review or an answer alike. */
export const canComplete = (task: Task) => stateChoices(task).includes('approve');

/** A Task the person is asked to review, and can still approve. */
export const awaitsReview = (task: Task) => canComplete(task) && userTurn(task.ball)?.reason === 'review';

/** Completion consumes the server's candidates; review identity remains awaitsReview's. */
function useDoneAction(task: Task) {
  const people = useReaderPeople(task.id);
  const disabled = useWriteDisabled(task.id);
  const head = crewOf(task.id, people).responsible?.headRunId;
  const run = head ? people.runs.get(head) : undefined;
  return { people, ready: !disabled && canComplete(task)
    && !(run && isRunMoving(run.state)) };
}

/**
 * Done reports the task done directly, with the original Task's versions and the default title and body
 * (useTaskReport); another Task's reader stays put. It is drawn where it stands: the round tool of the conversation's row
 * (TaskActions), or inline in an ancestor's report of the submission.
 * On its way it turns its mark; accepted, it turns green until the finished task takes it away. Neither takes a second
 * press, nor does a press while the answered reader is leaving (it would land on the next task). A refusal is told where
 * every report's failure is (the recovery notices), and Done can be pressed again. So can a Done whose result is not
 * known (no answer came): it is not on its way, so it does not turn, and a press asks again with the same operation,
 * as the notice's Check does, rather than leaving the notice (which may be gone) the only way on.
 * A short wait (the task read again, serve reached again) does not dim it (useSteadyControl); a press in one goes once
 * the wait ends, unless the task shown has changed under it.
 */
export function ReviewApprove({ task, look }: { task: Task; look: ActionLook | 'inline' }) {
  const { t } = useTranslation('ui');
  const { people, ready: doneReady } = useDoneAction(task);
  const card = useReaderCard();
  const report = useTaskReport(task, people, card);
  const ready = report.ready && doneReady;
  const steady = useSteadyControl(!ready, useShownTaskVersion(task.id));
  const tool = useRowTool();
  const inThread = useTaskActionSlot(state => state.inThread);
  const sending = report.completion === 'pending';
  const unknown = report.completion === 'unconfirmed';
  const accepted = report.completion === 'confirmed';
  const className = look === 'inline'
    ? cn("relative inline-flex h-9 flex-none items-center gap-1.5 rounded-full border border-lit-line bg-raised px-3 text-sm text-muted shadow-float hover:bg-hover hover:text-ink disabled:opacity-38 pointer-coarse:min-h-11",
      accepted && "border-done text-done disabled:opacity-100")
    : look === 'mark'
      // A phone's Done is its mark alone, filled, so it is told apart from the marks beside it.
      ? cn(tool, markTool, "border-ink bg-ink text-lit hover:bg-ink/85 hover:text-lit", accepted && "border-done bg-done disabled:opacity-100")
      // In the conversation's foot, with its words, still filled as its mark is: the one step the row is there for.
      : inThread ? cn(tool, "border-ink bg-ink text-lit hover:bg-ink/85 hover:text-lit", accepted && "border-done bg-done disabled:opacity-100")
      : cn(tool, accepted && "border-done text-done disabled:opacity-100");
  return <button type="button" data-task-done data-sending={sending || undefined} data-accepted={accepted || undefined}
    aria-label={t('coordinatorCard.complete')} title={t('coordinatorCard.completeHint', { id: task.id })} aria-busy={sending || undefined}
    disabled={unknown ? report.unproven : steady.disabled || sending || accepted} className={className}
    onClick={unknown ? () => { void report.check().catch(() => {}); }
      : steady.press(() => { if (!readerActionsHeld()) void report.complete(); })}>
    <Icon name={sending ? 'pending' : 'check'} className={cn("size-4", sending && "animate-spin")} />{look !== 'mark' && t('coordinatorCard.done')}
  </button>;
}

/** Send-back is the user's editable instruction, bound to the source review, then sent by the existing input. */
export function ReviewActions({ task }: { task: Task }) {
  const { t } = useTranslation('reader');
  const { people, ready: doneReady } = useDoneAction(task);
  const ready = doneReady && awaitsReview(task);
  const draft = useInputDraft();
  const canSendBack = useIntentReady(task);
  // What the press itself makes unusable (its intent in the input) shows at once; the waits around it do not blink it.
  const steady = useSteadyControl(!ready || !answeringTurn(task) || !canSendBack, useShownTaskVersion(task.id));
  return <div data-review-report-actions={task.id} className="mt-4 flex flex-wrap items-center gap-1.5">
    <ReviewApprove task={task} look="inline" />
    <button type="button" disabled={steady.disabled || draft.locked || hasReaderOperation(draft.doc)}
      className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-lit-line bg-raised px-3 text-sm text-muted hover:bg-hover hover:text-ink disabled:opacity-38 pointer-coarse:min-h-11"
      onClick={steady.press(() => { if (draft.intend(task, intentAbout(task, 'sendback', people), t('intent.sendback', { id: task.id }))) focusCoordinator(); })}>
      <Icon name="edit" className="size-4" />{t('reportFeed.sendBack')}
    </button>
  </div>;
}
