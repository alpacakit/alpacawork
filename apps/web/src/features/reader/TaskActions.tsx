import { useRef, type RefObject } from 'react';
import { countUse } from '@/features/telemetry/count';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { isFinished } from '@alpacawork/contract/branch';
import { Icon } from '@/components/ui/icon';
import { useReportOpeningDisabled } from './use-task-report';
import type { Task } from '@/data/types';
import { StateControl } from '@/features/forms/ReportInputs';
import { useTaskActionSlot, useRowTool, markTool, type ActionLook } from '@/features/coordinator/task-action-slot';
import { closeReaderStep } from '@/state/history-step';
import { openInput, useOpenInput } from '@/state/open-input';
import { cn } from '@/lib/utils';
import { SurfaceDocument } from '@/lib/surface';
import { notify } from '@/lib/notify';
import { answeringTurn } from '@/features/coordinator/reader-send';
import { setAutoSwipe, useAutoSwipe, useReaderCard } from './next-question';
import { canComplete, ReviewApprove } from './TaskDone';

/**
 * The reader's own task actions: Change state, which opens the reader's one state form, and Done, which reports
 * the task done at once with the default title and body. They stand in one place on every screen: the
 * conversation's row over its input, Change state to the left of Done, in Done's shape; with their words where the row
 * has room for them, else (and on a phone) as marks alone. They
 * stand while the task is not finished, Done only while it waits for the person's review or answer. While the task waits
 * on the person, auto-swipe stands first, so Change state and Done keep their place. On hover each says what it
 * does; Change state and Done name the task they act on.
 * The state form itself always stands in the same place, unseen at the reader's foot (R opens it), so what is typed in it
 * stays whichever opener is shown; it grows out of the opener that is shown, in that opener's window (the conversation's
 * own window when it has gone into one).
 */
export function TaskActions({ task, phone }: { task: Task; phone: boolean }) {
  const slot = useTaskActionSlot(state => state.element);
  const page = useTaskActionSlot(state => state.page);
  const opener = useRef<HTMLButtonElement>(null);
  const shown = !isFinished(task.state);
  const complete = shown && canComplete(task);
  const asks = shown && !!answeringTurn(task);
  // In the conversation's row, folded or open, on a computer they say their words where the row has room for them, else
  // (and on a phone) they are marks alone (useRowWords).
  const labels = useTaskActionSlot(state => state.labels);
  const look = phone || !labels ? 'mark' : 'tool';
  return <>
    <SurfaceDocument value={page !== document ? page : null}>
      <span data-state-host aria-hidden inert className="pointer-events-none absolute right-4 bottom-4 opacity-0"><StateControl task={task} anchorRef={opener} /></span>
    </SurfaceDocument>
    {slot && shown && createPortal(<>{asks && <AutoSwipe look={look} />}<OpenState task={task} look={look} ref={opener} />{complete && <ReviewApprove task={task} look={look} />}</>, slot)}
  </>;
}

/**
 * A phone's way to close the task sheet under the thumb: the round tool of the row (its mark alone, the conversation
 * sheet's ∨ that closes it) standing over the row's right end, over Done, apart from it by more than a finger's reach
 * (the tool's own touch room runs a step below it). It closes as the sheet's × does (closeReaderStep), and lets go of
 * the input as the conversation's ∨ does, so the keyboard goes down with it. The reader keeps that room clear at its
 * end (surfaces.css, data-reader-sheet-close).
 */
export function ReaderSheetClose() {
  const { t } = useTranslation('reader');
  const tool = useRowTool();
  const slot = useTaskActionSlot(state => state.element);
  const folded = !useTaskActionSlot(state => state.inThread);
  return slot && folded && createPortal(<button type="button" data-reader-sheet-close aria-label={t('readerHeader.close')} title={t('readerHeader.close')}
    className={cn(tool, markTool, 'absolute right-0 bottom-full mb-4')}
    onClick={() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      closeReaderStep();
    }}>
    <Icon name="down" className="size-4" />
  </button>, slot);
}

/**
 * Auto-swipe: while on, a send from the input stamps its card and goes on to the next (swipesOnSend); off (the
 * default), the send stays on its card and the input stays open. Its outline, raised as its neighbours, says off;
 * on, it sits down in the row, an opaque step darker with no shadow, and its card is filled. It is one switch
 * (aria-pressed) with one word; what on and off do is in its title, and said as a toast as it is pressed. It leaves the
 * input as it is (INPUT_OWN), up with what is written in it.
 */
const AUTO_SWIPE_TOAST = 'reader-auto-swipe';
function AutoSwipe({ look }: { look: ActionLook }) {
  const { t } = useTranslation('reader');
  const card = useReaderCard();
  const on = useAutoSwipe();
  const tool = useRowTool();
  return <button type="button" data-auto-swipe data-input-own aria-pressed={on} aria-label={t('nextQuestion.autoSwipe.label')}
    title={t('nextQuestion.autoSwipe.hint')} disabled={!card}
    className={cn(tool, look === 'mark' && markTool, "transition-colors aria-pressed:border-press-line aria-pressed:bg-press aria-pressed:text-ink aria-pressed:shadow-none")}
    onClick={(event) => {
      event.stopPropagation(); setAutoSwipe(!on); countUse(on ? 'pin.off' : 'pin.on');
      // What it does now, said once per press for whoever meets it first; a press again replaces it in its one slot.
      notify.info(t(on ? 'nextQuestion.autoSwipe.toastOff' : 'nextQuestion.autoSwipe.toastOn'),
        { id: AUTO_SWIPE_TOAST, detail: t(on ? 'nextQuestion.autoSwipe.toastOffDetail' : 'nextQuestion.autoSwipe.toastOnDetail'), from: event.currentTarget });
    }}>
    <Icon name="autoSwipe" fill={on ? 'currentColor' : 'none'} className="size-4 flex-none" />
    {look !== 'mark' && <span>{t('nextQuestion.autoSwipe.label')}</span>}
  </button>;
}

/** Change state: opens the reader's state form, which grows out of it. It is Done's round shape, on a phone its mark alone. */
function OpenState({ task, look, ref }: { task: Task; look: ActionLook; ref?: RefObject<HTMLButtonElement | null> }) {
  const { t } = useTranslation('forms');
  const card = useReaderCard();
  const disabled = useReportOpeningDisabled(task.id);
  const open = useOpenInput('report', task.id) !== null;
  const tool = useRowTool();
  return <button ref={ref} type="button" data-task-state data-input-opener aria-expanded={open} aria-label={t('reportForm.statePick')}
    title={t('reportForm.statePickHint', { id: task.id })} disabled={disabled} className={cn(tool, look === 'mark' && markTool)}
    onClick={(event) => { event.stopPropagation(); openInput({ form: 'report', taskId: task.id, answerCard: card }); }}>
    <Icon name={look === 'mark' ? 'swap' : 'state'} className="size-4 flex-none" />
    {look !== 'mark' && <span>{t('reportForm.statePick')}</span>}
  </button>;
}
