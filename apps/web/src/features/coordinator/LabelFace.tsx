import type { ComponentProps, CSSProperties, ReactNode } from 'react';
import { ProjectTile } from '@/components/ui/project-tile';
import type { ProjectMark } from '@/data/project-marks';
import { cn } from '@/lib/utils';
import { choiceWord } from '@alpacawork/contract';
import { badgeClass, labelPlaceClass, taskTitleClass } from './label-style';
import { useTranslation } from 'react-i18next';

const faceClass = {
  task: 'bg-hover text-muted',
  reply: 'bg-hover text-muted',
  answer: 'gap-0.5 rounded-full border border-turn bg-lit pr-0.5 pl-2 text-ink',
  skill: 'border border-lit-line bg-lit pl-0.5 font-medium text-ink',
  // A project is no task: its square and name on a pale ground of its colour, edged in it (--mark, projectFace).
  project: 'pl-0.5 text-ink [background:color-mix(in_srgb,var(--mark)_20%,transparent)] ring-1 ring-inset ring-[color-mix(in_srgb,var(--mark)_70%,transparent)]',
};
/** The editor and its folded preview draw the same label; each place supplies its own interactions. `className` is the
 * face's; the other props, such as `contentEditable` and `ref`, are the place's, the box a caret beside it meets. */
export function LabelFace({ kind, className, children, ...props }: ComponentProps<'span'> & { kind: keyof typeof faceClass }) {
  return <span {...props} className={cn(labelPlaceClass, 'select-none')}><span className={cn(badgeClass, 'max-w-44', faceClass[kind], className)}>{children}</span></span>;
}
/** A skill's mark: the square with its slash, wherever a skill is named. */
export const SkillMark = () => <span className="grid size-4 place-items-center rounded-xs bg-ink text-xs text-bg">/</span>;
export function TaskLabelText({ id, title, mark }: { id: string; title: string; mark?: ReactNode }) {
  return <>{mark}<span data-label-id className="shrink-0 text-ink tabular-nums">{id}</span><span data-label-title className={cn(taskTitleClass, 'min-w-0')}>{title}</span></>;
}
/** A project label's colour, for its face (kind `project`). */
export const projectFace = (mark: ProjectMark) => ({ '--mark': mark.color }) as CSSProperties;
/** A project label says the project, never a task's number or state: its square, then its name. */
export function ProjectLabelText({ mark }: { mark: ProjectMark }) {
  // The name is what tells it apart (two projects can share letters), so it keeps more room than a task's title does.
  return <><ProjectTile name={mark.name} color={mark.color} size={16} /><span data-label-title dir="auto" className="min-w-0 max-w-[7em] truncate">{mark.name}</span></>;
}
/**
 * An automation's badge, wherever it is drawn (the input, its folded line, a sent message): its number and name as a
 * task's label has them, or, for one to ask for, the words "new automation".
 */
export function AutomationLabelText({ id, name }: { id: string; name: string }) {
  const { t } = useTranslation('ui');
  if (id === 'new') return <span data-label-title className="min-w-0 truncate text-ink">{t('input.newAutomation')}</span>;
  // The name takes what its face leaves (AUTOMATION_FACE), not a task title's few characters.
  return <><span data-label-id className="shrink-0 text-ink tabular-nums">{id}</span><span data-label-title className="min-w-0 truncate">{name}</span></>;
}
/**
 * An automation's badge in the input stands alone at its start, the words written after it: its face takes up to most
 * of the input's width, so the name says which one it is (a phone still shows its number and the name's start).
 */
export const AUTOMATION_FACE = 'max-w-[min(28rem,70vw)] narrow:max-w-[60vw]';
/** An answer's chip: the question's number, then the first word of the choice's name (what a choice answers by). */
export function AnswerLabelText({ n, name }: { n: string; name: string }) {
  return <><span className="text-xs text-turn">{n}</span><span className="max-w-[6em] truncate">{choiceWord(name)}</span></>;
}
