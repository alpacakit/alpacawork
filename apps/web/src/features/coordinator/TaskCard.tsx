import { useRef, useState, type RefObject } from 'react';
import { useCanHover } from '@/lib/input-capabilities';
import { useHoverCardInteraction, useHoverCardTarget } from '@/components/ui/hover-card';
import { useTranslation } from 'react-i18next';
import { Icon } from '@/components/ui/icon';
import { TaskIcon } from '@/components/ui/state-label';
import { useTaskLook, type LookTask } from '@/components/ui/tone';
import { useReferenceTask } from '@/data/queries';
import { ReadFailure, PendingRegion } from '@/components/ui/loadable';
import { cn } from '@/lib/utils';
import { LabelCard } from './LabelPopover';

/** A task's word, as every screen says it (useTaskLook). */
function TaskWord({ task }: { task: LookTask }) { return <>{useTaskLook(task).word}</>; }

/**
 * What a task's card says, wherever it opens: from a task label in the input or from a task named in a text.
 * Opening the task is the person's choice in it (`openButton`), done the way the place opens tasks.
 */
export function useTaskCard(id: string, open: () => void, written?: string) {
  const { t } = useTranslation('ui');
  const read = useReferenceTask(id);
  const { task } = read;
  return {
    task, mark: (className: string) => task && <TaskIcon task={task} className={className} />,
    header: <>{task && <TaskIcon task={task} className="size-3.5" />}{id} {task && <TaskWord task={task} />}</>,
    body: read.error ? <ReadFailure error={read.error} retry={read.retry} />
      : <><strong className="mt-1 block">{task?.title ?? written}</strong><PendingRegion pending={read.pending} shape="title" /></>,
    openButton: (close: () => void) => task && <button type="button" data-task-card-open className="rounded-sm border border-line px-2 py-1"
      onClick={() => { close(); open(); }}>{t('input.openTask')}</button>,
  };
}

/**
 * One task card for read references, the same wherever a task's ID stands. Where the pointer can hover, resting
 * on the ID shows the card and pressing it opens the task; where it cannot (a finger), pressing it shows the card, whose
 * Open opens the task. `trigger` goes on the ID's button: its handlers and what a reader hears it does. Where a press is
 * the way to the task itself (`opens`: a run's task, read there to be opened), a press opens it on any screen, and only
 * a resting pointer shows the card.
 */
export function useTaskCardOn<T extends HTMLElement>(id: string, open: (anchor: T | null) => void, { opens = false }: { opens?: boolean } = {}) {
  const anchor = useRef<T>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const canHover = useCanHover();
  const [mode, setMode] = useState<'hover' | 'press' | null>(null);
  const close = () => setMode(null);
  const hover = useHoverCardInteraction<T>({ enabled: canHover && mode !== 'press',
    shown: mode === 'hover', card: cardRef, open: () => setMode('hover'), close });
  const { cancel } = hover;
  const press = canHover || opens ? () => { cancel(); close(); open(anchor.current); }
    : () => { cancel(); setMode(mode === 'press' ? null : 'press'); };
  return {
    anchor,
    trigger: { onPointerEnter: hover.handlers.onPointerEnter, onPointerLeave: hover.handlers.onPointerLeave,
      onClick: press, 'aria-haspopup': canHover || opens ? undefined : 'dialog' as const },
    card: mode && <TaskCard id={id} anchor={anchor} cardRef={cardRef} hovering={mode === 'hover'}
      onEnter={cancel} onLeave={hover.leave} open={() => open(anchor.current)} close={close} />,
  };
}

function TaskCard({ id, anchor, cardRef, hovering, onEnter, onLeave, open, close }: {
  id: string; anchor: RefObject<HTMLElement | null>; cardRef: RefObject<HTMLDivElement | null>; hovering: boolean;
  onEnter: () => void; onLeave: () => void; open: () => void; close: () => void;
}) {
  const card = useTaskCard(id, open);
  useHoverCardTarget(cardRef, hovering);
  return <LabelCard anchor={anchor} cardRef={cardRef} autoFocus={!hovering} onPointerEnter={onEnter} onPointerLeave={onLeave}
    name={id} header={card.header} close={close} actions={card.openButton(close)}>{card.body}</LabelCard>;
}
