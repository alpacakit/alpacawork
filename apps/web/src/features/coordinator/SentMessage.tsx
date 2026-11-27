import { splitMessage, type MessagePart } from './editor/wire';
import { useEveryTaskIndex, useReferenceRow } from '@/data/queries';
import { Fragment, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { readAnswer } from '@/domain/questions';
import { followTask } from './follow-task';
import { useTaskCardOn } from './TaskCard';
import { AutomationLabelText, SkillMark } from './LabelFace';
import { badgeClass, labelPlaceClass, taskTitleClass } from './label-style';
import { cn } from '@/lib/utils';
import { piecesClip, writeClip } from '@/lib/clipboard';
import { useLongPress } from '@/lib/long-press';
import { useSurfaceDocument } from '@/lib/surface';
import { messagePieces } from './editor/clip';
import type { TaskIndex } from '@/domain/tasks';
import type { SentTurn } from './shown';
const names = new WeakMap<TaskIndex, Map<string, string>>();
/** Parts shared by a sent message's display and copy; history stays plain text except explicit labels. */
export function useMessageParts(text: string, skills: readonly { name: string }[],
  badge: Pick<SentTurn, 'automation' | 'automationName'> = {}): readonly MessagePart[] {
  const index = useEveryTaskIndex();
  let titles = names.get(index);
  if (!titles) {
    titles = new Map();
    for (const task of index.byId.values()) titles.set(task.id, task.title);
    names.set(index, titles);
  }
  const { automation, automationName } = badge;
  return useMemo(() => splitMessage(text, new Set(skills.map(skill => skill.name)), titles,
    new Map(automation && automationName !== undefined ? [[automation, automationName]] : [])), [text, skills, titles, automation, automationName]);
}

/**
 * A sent message held long is copied whole, its tasks and skills as references (lib/clipboard.ts): pasted into the
 * input they are its labels again, elsewhere a link to the task and the skill's mark. It says that it copied, or
 * that it could not. `held`: it is being held long enough, to be shown so before it is let go.
 */
export function useMessageCopy(parts: readonly MessagePart[]) {
  const view = useSurfaceDocument().defaultView ?? window;
  const press = useLongPress(() => void writeClip(piecesClip(messagePieces(parts)), { view }));
  return { held: press.held, props: { ...press.props, "data-held": press.held || undefined } };
}

/** A task label in a sent message acts as a task named in a text does. */
function SentTaskLabel({ id, title, token }: { id: string; title?: string; token: string }) {
  const { anchor, trigger, card } = useTaskCardOn<HTMLButtonElement>(id, () => followTask(id));
  // The title stays subscribed to the Reader's qualified row while closed.
  // A prose reference has no row title and needs only the on-demand card.
  const { task } = useReferenceRow(id);
  return <><button ref={anchor} data-label="task" type="button" {...trigger} title={token}
    className={`${badgeClass} max-w-44 bg-hover`}><span className="shrink-0 text-ink tabular-nums">{id}</span><span className={`${taskTitleClass} text-muted`}>{task?.title ?? title}</span></button>{card}</>;
}

/** An answer in a sent message reads as its chip did in the input: the question's number, then its word. */
function SentAnswer({ token }: { token: string }) {
  const { t } = useTranslation("reader");
  const answer = readAnswer(token, { stop: t("answer.stop"), other: t("answer.other") });
  return <span data-label="answer" className={cn(badgeClass, 'rounded-full border border-turn px-2 text-ink')}>
    {answer ? <><span className="text-xs text-turn">{answer.n}</span>{" "}{answer.word}</> : token}</span>;
}

/** An automation's badge in a sent message reads as it did in the input. */
const SentAutomation = ({ id, name }: { id: string; name: string }) => <span className={labelPlaceClass}>
  <span data-label="automation" data-automation={id} title={id === 'new' ? undefined : `${id} ${name}`.trim()}
    className={`${badgeClass} max-w-44 bg-hover text-muted`}><AutomationLabelText id={id} name={name} /></span></span>;

/** `automation`: the message's badge. A new automation's has no words of its own, so it is drawn first. */
export function SentMessage({ parts, automation }: { parts: readonly MessagePart[]; automation?: string }) {
  return <span className="whitespace-pre-wrap">{automation === 'new' && <SentAutomation id="new" name="" />}{parts.map((part, at) => {
    const token = part.text;
    if (part.kind === 'automation') return <SentAutomation key={at} id={part.id!} name={part.title ?? ''} />;
    if (part.kind === 'task') return <span key={at} className={labelPlaceClass}><SentTaskLabel id={part.id!} title={part.title} token={token} /></span>;
    if (part.kind === 'skill') return <span key={at} className={labelPlaceClass}><span data-label="skill" className={cn(badgeClass, 'border border-lit-line bg-lit pl-0.5 text-ink')}><SkillMark />{token.slice(1)}</span></span>;
    if (part.kind === 'answer') return <span key={at} className={labelPlaceClass}><SentAnswer token={token} /></span>;
    return <Fragment key={at}>{token}</Fragment>;
  })}</span>;
}
