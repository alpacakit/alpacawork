import { userTurn } from '@alpacawork/contract';
import { i18n } from '@alpacawork/i18n';
import { ApiError } from './client';
import type { Task } from './types';
import { crewOf, type PeopleIndex } from '@/domain/people';
import { REPORT_STATE, stateChoices, type StateChoice } from '@/domain/tasks';

/** UI defaults belong to this one boundary; the server keeps its optional report fields. */
export function reportDefaults(choice: StateChoice) {
  const words = {
    approve: { title: i18n.t('forms:reportForm.approveTitle'), description: i18n.t('forms:reportForm.approveDescription') },
    hold: { title: i18n.t('forms:reportForm.holdTitle'), description: i18n.t('forms:reportForm.holdDescription') },
    unhold: { title: i18n.t('forms:reportForm.restoreTitle'), description: i18n.t('forms:reportForm.restoreDescription') },
    stop: { title: i18n.t('forms:reportForm.stopTitle'), description: i18n.t('forms:reportForm.stopDescription') },
  };
  return words[choice];
}

/** The Task and people shown together, with the facts that define the report's target. */
export function taskReportTarget(task: Task, people: PeopleIndex) {
  const responsible = crewOf(task.id, people).responsible;
  return { task, people, facts: {
    task: task.id, hash: task.hash, state: task.state,
    turn: userTurn(task.ball)?.key ?? null,
    aboutRun: userTurn(task.ball)?.aboutRunId ?? null,
    placement: responsible?.id ?? null, revision: responsible?.revision ?? null,
    restoreState: task.hold ? task.baseState : null, choices: stateChoices(task),
  } };
}
export type TaskReportTarget = ReturnType<typeof taskReportTarget>;

/** Compare report meaning, rather than object identity or unrelated people/Run updates. */
export const sameTaskReportTarget = (opening: TaskReportTarget, current: TaskReportTarget) =>
  JSON.stringify(opening.facts) === JSON.stringify(current.facts);

/** Translate only this captured target. Never supplement it with a later Task, placement, or Run. */
export function reportRequest(target: TaskReportTarget, choice: StateChoice,
  words: { title?: string; description?: string }, opId: string) {
  const facts = target.facts;
  if (!facts.choices.includes(choice)) throw new ApiError(() => i18n.t('forms:reportForm.chooseAgain'), 'conflict', 'reread');
  const state = choice === 'unhold' ? facts.restoreState : REPORT_STATE[choice];
  if (state === null) throw new ApiError(() => i18n.t('forms:reportForm.chooseAgain'), 'conflict', 'reread');
  const aboutRun = choice === 'approve' ? facts.aboutRun : null;
  if (aboutRun && facts.revision === null) throw new ApiError(() => i18n.t('forms:reportForm.chooseAgain'), 'conflict', 'reread');
  const defaults = reportDefaults(choice);
  return { task: facts.task, state, opId, expectedTaskHash: facts.hash,
    ...(facts.revision === null ? {} : { expectedPlacementRevision: facts.revision }), ...(aboutRun ? { aboutRun } : {}),
    title: words.title?.trim() || defaults.title, description: words.description?.trim() || defaults.description };
}
